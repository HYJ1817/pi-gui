// 可信 Agent 建议来源适配器（阶段 B/C）。
//
// 职责：在服务端已验证的 Pi 事件入口（Classic：rpc publish；Runtime：registry
// publish 帧）上接一个显式 allowlist 的提取器。只认本次运行窗口内、role 为
// assistant、message_end 完成且 stopReason 为终值的消息文本里的最后一处
// `pi-gui-collab` 围栏；经严格 schema 校验后经 lib/collab-doc.js 的
// createProposal 构造建议，注册进后端队列。
//
// 可信边界（docs/Z4-3-agent-source-contract.md）：
// - 来源证据是服务端事件流（bridgeRun / registry owner 闭集），不是模型自述；
// - 来源可信不代表内容可信：围栏 JSON 键闭集、类型闭集、上限校验全部执行，
//   任何一步失败 = 本次生成失败，不产出部分建议；
// - 流式 text_delta、用户消息、toolResult、custom 消息、Z3 围栏一律不采纳。

import { CollabError, OP_TYPES, createProposal } from '../lib/collab-doc.js';
import { createProposalQueue, proposalDigest } from './collab-proposal-queue.js';

const fail = code => { throw Object.assign(Error(code), { code }); };
const hex = value => typeof value === 'string' && /^[0-9a-f]{16,128}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const positiveInt = value => Number.isSafeInteger(value) && value > 0;

const FENCE_RE = /(^|\n)[ \t]*```pi-gui-collab[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/g;
const ASSISTANT_TERMINAL = new Set(['stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']);
const CHANNEL_BUSY_CODES = new Set(['runtime_busy', 'stop_in_progress', 'tool_guard_unavailable', 'auth_syncing', 'runtime_request_limit']);
const CHANNEL_STALE_CODES = new Set(['stale_runtime', 'runtime_not_ready', 'invalid_command', 'workspace_in_use']);

/** 服务端组合生成 prompt：文档受控快照 + 用户指令 + 输出格式契约。
 *  Renderer 只提供 instruction 文本；文档内容来自 store.read 的权威快照。 */
export function buildGenerationPrompt({ document, instruction }) {
  const lines = ['你正在协助修改一张流程图协同文档。只给出修改建议，不要执行任何工具或修改任何文件。', '',
    `当前文档「${document.title || '未命名'}」（documentId=${document.documentId}，版本 ${document.revision}）的受控表示：`];
  lines.push(`节点 ${document.graph.nodes.length} 个（id、文字、x、y）：`);
  for (const n of document.graph.nodes) lines.push(`- ${n.id}「${n.label}」(${n.x},${n.y})`);
  if (!document.graph.nodes.length) lines.push('- （空）');
  lines.push(`连线 ${document.graph.edges.length} 条（id、from、to、文字）：`);
  for (const e of document.graph.edges) lines.push(`- ${e.id}: ${e.from}→${e.to}${e.label === undefined ? '' : `「${e.label}」`}`);
  if (!document.graph.edges.length) lines.push('- （空）');
  lines.push('', `用户需求：${instruction}`, '',
    `请基于当前版本 ${document.revision} 输出一批原子操作。在回复的最后输出且只输出一个 \`\`\`pi-gui-collab 围栏，围栏内容为严格 JSON：`,
    '{"version":1,"rationale":"一句话修改说明","ops":[{"type":"node.add","params":{"id":"n4","label":"异常处理","x":600,"y":0}}]}',
    '要求：',
    '- ops 只能使用这些操作类型：node.add、node.update、node.remove、edge.add、edge.update、edge.remove。',
    '- params 形状：node.add {id,label,x,y}；node.update {id 以及 label/x/y 中至少一项}；node.remove {id}；edge.add {id,from,to,label?}；edge.update {id,label}（label 为 null 表示清除文字）；edge.remove {id}。',
    '- 删除节点前必须先删除引用它的连线；不要自环或同向重复连线；新增 id 不得与现有 id 冲突。',
    '- 围栏 JSON 之外不要写注释或示例；不要输出其他代码围栏；不要输出整份文档。');
  return lines.join('\n');
}

function exactKeys(value, keys, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('collab_generate_invalid_output');
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) {
    fail('collab_generate_invalid_output');
  }
}

/** 提取文本里最后一处完整 pi-gui-collab 围栏并严格解析。
 *  返回 {rationale, ops:[{type,params}]}；任何不符合契约处抛 collab_* 错误。 */
export function parseCollabFence(text, { maxFenceBytes } = {}) {
  if (typeof text !== 'string') fail('collab_generate_no_output');
  FENCE_RE.lastIndex = 0;
  let last = null;
  for (let match = FENCE_RE.exec(text); match; match = FENCE_RE.exec(text)) last = match;
  if (!last) fail('collab_generate_no_output');
  const content = last[2];
  if (Buffer.byteLength(content, 'utf8') > maxFenceBytes) fail('collab_generate_invalid_output');
  let raw;
  try { raw = JSON.parse(content); } catch { fail('collab_generate_invalid_output'); }
  exactKeys(raw, ['version', 'rationale', 'ops']);
  if (raw.version !== 1) fail('collab_generate_invalid_output');
  if (typeof raw.rationale !== 'string' || raw.rationale.length > 2000) fail('collab_generate_invalid_output');
  if (!Array.isArray(raw.ops) || raw.ops.length < 1 || raw.ops.length > 50) fail('collab_generate_invalid_output');
  for (const op of raw.ops) {
    exactKeys(op, ['type', 'params']);
    if (!OP_TYPES.includes(op.type)) fail('collab_generate_invalid_output');
    if (!op.params || typeof op.params !== 'object' || Array.isArray(op.params)) fail('collab_generate_invalid_output');
  }
  return { rationale: raw.rationale, ops: raw.ops };
}

/** Classic/Runtime 通道错误 → 安全错误码闭集。 */
function mapChannelError(error) {
  const code = error?.code;
  if (code === 'collab_agent_busy' || CHANNEL_BUSY_CODES.has(code)) return 'collab_agent_busy';
  if (code === 'collab_generate_rejected') return 'collab_generate_rejected';
  // 身份失效等自有生成安全码原样透传（fail closed 语义不得降级为通道不可用）。
  if (typeof code === 'string' && code.startsWith('collab_generate_')) return code;
  if (CHANNEL_STALE_CODES.has(code)) return 'collab_generate_unavailable';
  return 'collab_generate_unavailable';
}

/**
 * 事件入口适配器。channels 由组合根注入：
 *   classic: { captureIdentity: () => ({bridgeRun}), sendPrompt: async (_, message) => {} }
 *   runtime: { captureIdentity: conversationId => ({backendInstance,conversationId,runtimeId,runtimeGeneration}),
 *              sendPrompt: async (conversationId, message) => {} }
 * 生成通道完全复用现有 Pi RPC 与执行队列；这里不 spawn 任何进程。
 */
export function createCollabProposalSource({
  queue = createProposalQueue(),
  channels = {},
  maxFenceBytes = 64 * 1024,
  maxCandidateBytes = 512 * 1024,
  attemptTtlMs = 10 * 60 * 1000,
  maxArmedBuffer = 16,
  now = () => Date.now(),
  randomId = () => globalThis.crypto.randomUUID(),
  logEvent = null,
} = {}) {
  const safeLog = (event, details = {}) => { try { logEvent?.(event, details); } catch { /* observation only */ } };
  const attempts = new Map(); // attemptId → attempt（插入序 = 创建序）

  /* ---------- attempt 状态机 ----------
   * armed   ：sendPrompt 在途。事件只缓冲不采纳（上限 maxArmedBuffer，超限 overflow）。
   *           未确认前出现的任何运行（包括别人的完整 run）都不构成合法建议；
   *           通道拒绝/异常时连同缓冲一起丢弃。
   * prompted：prompt 已被通道接受（Classic 要求 disposition==='started'，Runtime 要求
   *           registry.command 完整 admission 通过）。回放缓冲后等待事件流。
   *           sawStart 门控采集：agent_start 之前到达的 settled 属于其他运行，忽略。
   * ready/failed：终局。失败清理同时移除 attempt 与它可能注册过的队列项。 */
  const RUNNING_STATES = new Set(['armed', 'prompted']);

  function prune() {
    for (const [key, attempt] of attempts) {
      if (RUNNING_STATES.has(attempt.state)) {
        if (now() - attempt.startedAt > attemptTtlMs) {
          failAttempt(attempt, 'collab_generate_timeout');
        }
        continue;
      }
      // 终局 attempt：已被状态轮询消费且超过保留期即释放。
      if (attempt.consumed && now() - attempt.startedAt > attemptTtlMs) attempts.delete(key);
    }
    while (attempts.size > 32) {
      const oldest = [...attempts.values()].find(a => !RUNNING_STATES.has(a.state));
      if (!oldest) break;
      attempts.delete(oldest.attemptId);
    }
  }

  function failAttempt(attempt, code) {
    if (!RUNNING_STATES.has(attempt.state)) return;
    attempt.state = 'failed'; attempt.failCode = code;
    attempt.candidates = []; attempt.buffer = [];
    // 防御：终局前若已注册过队列项（正常路径不会），一并移除，避免幽灵建议。
    if (attempt.proposalId && typeof queue.drop === 'function') queue.drop(attempt.proposalId);
    safeLog('collab.attempt_failed', { attemptId: attempt.attemptId, code });
  }

  /** message_end 采集：只收含围栏标记的 assistant 终值消息，容量有界。 */
  function recordCandidate(attempt, message) {
    if (!message || message.role !== 'assistant' || attempt.state !== 'prompted' || !attempt.sawStart) return;
    if (!ASSISTANT_TERMINAL.has(message.stopReason)) return;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
    if (!text || !text.includes('pi-gui-collab')) return;
    const tooLarge = Buffer.byteLength(text, 'utf8') > maxCandidateBytes;
    attempt.candidates.push({ text: tooLarge ? '' : text, tooLarge });
    while (attempt.candidates.length > 3) attempt.candidates.shift();
  }

  /** agent_settled 收口：aborted → 丢弃；否则从最后一条含围栏消息提取并注册。 */
  function settleAttempt(attempt, aborted) {
    if (attempt.state !== 'prompted' || !attempt.sawStart) return;
    if (aborted) { failAttempt(attempt, 'collab_generate_aborted'); return; }
    // 注册前最后一道闸：Owner 生命周期已失效的迟到结果不得进入可信队列。
    if (!scopeStillCurrent(attempt.scopeRef)) { failAttempt(attempt, 'collab_generate_failed'); return; }
    try {
      const last = attempt.candidates[attempt.candidates.length - 1];
      if (!last) fail('collab_generate_no_output');
      if (last.tooLarge) fail('collab_generate_invalid_output');
      const parsed = parseCollabFence(last.text, { maxFenceBytes });
      // 后端重编号 opId：模型不可选择身份键（避免与文档幂等日志的 opId 复用语义交互）。
      const tag = attempt.attemptId.slice(3).replace(/-/g, '').slice(0, 24);
      const ops = parsed.ops.map((op, index) => ({
        opId: `a${tag}-${index}`, type: op.type, baseRevision: attempt.baseRevision, actor: 'agent', params: op.params,
      }));
      const proposal = createProposal({
        documentId: attempt.documentId, baseRevision: attempt.baseRevision,
        sessionId: attempt.sessionId, rationale: parsed.rationale, ops,
      });
      const registered = queue.register({
        scopeKey: attempt.scopeKey, scopeToken: attempt.scopeToken, sessionId: attempt.sessionId,
        documentId: attempt.documentId, baseRevision: attempt.baseRevision,
        rationale: proposal.rationale, ops: proposal.ops,
        run: { origin: attempt.origin, conversationId: attempt.conversationId,
          ...(attempt.origin === 'classic' ? { bridgeRun: attempt.identity.bridgeRun } : attempt.identity) },
      });
      if (!registered.ok) fail(registered.code === 'collab_queue_full' ? 'collab_queue_full' : 'collab_generate_failed');
      attempt.state = 'ready'; attempt.proposalId = registered.proposalId;
      safeLog('collab.proposal_registered', { attemptId: attempt.attemptId, opCount: proposal.ops.length });
    } catch (error) {
      const code = error?.code;
      failAttempt(attempt,
        code === 'collab_queue_full' ? 'collab_queue_full'
        : code === 'collab_generate_no_output' || code === 'collab_generate_invalid_output' ? code
        : error instanceof CollabError || (typeof code === 'string' && !code.startsWith('collab_'))
          ? 'collab_generate_invalid_output'
          : 'collab_generate_failed');
    } finally {
      attempt.candidates = []; attempt.buffer = [];
    }
  }

  /** prompted 阶段的事件处理（也用于 armed 缓冲的回放）。 */
  function handleEvent(attempt, event) {
    if (!RUNNING_STATES.has(attempt.state)) return;
    if (event.type === 'agent_start') { attempt.sawStart = true; return; }
    if (event.type === 'message_end') { recordCandidate(attempt, event.message); return; }
    if (event.type === 'agent_settled') { settleAttempt(attempt, event.aborted === true); return; }
  }

  /** armed 阶段缓冲；溢出标记（确认后按失败收口，不采纳不可判定的内容）。 */
  function bufferOrHandle(attempt, event) {
    if (attempt.state === 'armed') {
      if (attempt.buffer.length >= maxArmedBuffer) { attempt.overflow = true; return; }
      attempt.buffer.push(event);
      return;
    }
    handleEvent(attempt, event);
  }

  /** sendPrompt 确认后：进入 prompted 并按序回放缓冲（快速完成场景不丢失）。 */
  function confirmPrompt(attempt) {
    if (attempt.state !== 'armed') return;
    if (attempt.overflow) { attempt.buffer = []; failAttempt(attempt, 'collab_generate_failed'); return; }
    // 归属证明检查：缓冲中出现「settled 之后又有 start」的第二段运行时，
    // 无法证明哪一段属于本次 prompt——fail closed，不采纳任何内容。
    let sawSettled = false;
    for (const event of attempt.buffer) {
      if (event.type === 'agent_settled') sawSettled = true;
      else if (event.type === 'agent_start' && sawSettled) {
        attempt.buffer = [];
        failAttempt(attempt, 'collab_generate_failed');
        safeLog('collab.buffer_ambiguous', { attemptId: attempt.attemptId });
        return;
      }
    }
    attempt.state = 'prompted';
    const replay = attempt.buffer.splice(0);
    for (const event of replay) {
      handleEvent(attempt, event);
      if (!RUNNING_STATES.has(attempt.state)) break;
    }
  }

  /* ---------- Z4-3 安全收口：身份与生命周期校验 ----------
   * pendingGenerate 的 scope 携带 authority 在验证时捕获的 expectedIdentity
   * 与 assertCurrent 闭包；发送前与每个异步边界后都必须复核。 */
  const RUNTIME_IDENTITY_KEYS = ['backendInstance', 'projectId', 'repoId', 'workspaceId', 'workspaceEpoch',
    'conversationId', 'runtimeId', 'runtimeGeneration', 'sessionId'];

  function identityMatches(expected, current) {
    if (!expected) return true; // 生产 authority 恒提供；缺失仅出现在进程内测试 stub
    if (expected.kind === 'classic') {
      return current && current.kind === 'classic'
        && String(current.bridgeRun) === String(expected.bridgeRun)
        && current.cwd === expected.cwd
        && String(current.workspaceGeneration) === String(expected.workspaceGeneration)
        && current.sessionId === expected.sessionId;
    }
    if (expected.kind === 'runtime') {
      return current && current.kind === 'runtime' && expected.owner
        && RUNTIME_IDENTITY_KEYS.every(k => current[k] === expected.owner[k]);
    }
    return false;
  }

  function scopeStillCurrent(scope) {
    if (typeof scope?.assertCurrent !== 'function') return true;
    try { scope.assertCurrent(); return true; }
    catch { return false; }
  }

  function attemptsFor(origin) {
    return [...attempts.values()].filter(a => a.origin === origin && RUNNING_STATES.has(a.state));
  }

  /* ---------- 事件入口（服务端 tap，见 docs 契约 §6） ---------- */

  /** Classic：rpc publish 顶部原始事件（rpc-bridge 已盖服务端 bridgeRun）。 */
  function observeClassic(event) {
    if (!attempts.size || !event || typeof event !== 'object') return;
    if (event.type === 'bridge_status') {
      if (event.state !== 'ready') for (const attempt of attemptsFor('classic')) failAttempt(attempt, 'collab_generate_failed');
      return;
    }
    if (!Number.isInteger(event.bridgeRun)) return;
    for (const attempt of attemptsFor('classic')) {
      if (attempt.identity.bridgeRun !== event.bridgeRun) continue;
      bufferOrHandle(attempt, event);
    }
  }

  /** Runtime：registry publish 帧（{type:'runtime_event',owner,eventSequence,event}）。 */
  function observeRuntime(frame) {
    if (!attempts.size || !frame || typeof frame !== 'object') return;
    if (frame.type === 'runtime_closed') {
      for (const attempt of attemptsFor('runtime')) {
        if (frame.conversationId === attempt.conversationId) failAttempt(attempt, 'collab_generate_failed');
      }
      return;
    }
    if (frame.type !== 'runtime_event') return;
    const owner = frame.owner, event = frame.event;
    if (!owner || !event || typeof event !== 'object') return;
    for (const attempt of attemptsFor('runtime')) {
      const identity = attempt.identity;
      if (owner.backendInstance !== identity.backendInstance || owner.conversationId !== identity.conversationId
        || owner.runtimeId !== identity.runtimeId || owner.runtimeGeneration !== identity.runtimeGeneration) continue;
      bufferOrHandle(attempt, event);
    }
  }

  /* ---------- 生成触发与服务接口 ---------- */

  async function beginGeneration({ scope, document, instruction } = {}) {
    if (!scope || !hex(scope.key) || !hex(scope.token) || !id(scope.sessionId)) return { ok: false, code: 'collab_invalid' };
    if (scope.origin !== 'classic' && scope.origin !== 'runtime') return { ok: false, code: 'collab_generate_unavailable' };
    if (scope.origin === 'runtime' && typeof scope.conversationId !== 'string') return { ok: false, code: 'collab_generate_unavailable' };
    if (typeof instruction !== 'string') return { ok: false, code: 'collab_invalid' };
    const text = instruction.trim();
    if (!text || text.length > 2000) return { ok: false, code: 'collab_invalid' };
    if (!document || !id(document.documentId) || !positiveInt(document.revision)
      || !document.graph || !Array.isArray(document.graph.nodes) || !Array.isArray(document.graph.edges)) {
      return { ok: false, code: 'collab_invalid' };
    }
    prune();
    // 运行中判重按 scopeKey + scopeToken：旧 Owner 的未完成 attempt 不阻塞
    // 同 scope 新 token 的合法生成；同 token 并发仍拒绝。
    for (const attempt of attempts.values()) {
      if (attempt.scopeKey === scope.key && attempt.scopeToken === scope.token && RUNNING_STATES.has(attempt.state)) {
        return { ok: false, code: 'collab_generation_active' };
      }
    }
    const channel = channels[scope.origin];
    if (!channel || typeof channel.sendPrompt !== 'function' || typeof channel.captureIdentity !== 'function') {
      return { ok: false, code: 'collab_generate_unavailable' };
    }
    // 锁外发送前的第一道闸：authority 验证时的 Owner 生命周期必须仍然有效。
    if (!scopeStillCurrent(scope)) return { ok: false, code: 'collab_generate_failed' };
    let identity;
    try { identity = channel.captureIdentity(scope.origin === 'runtime' ? scope.conversationId : null); }
    catch { return { ok: false, code: 'collab_generate_unavailable' }; }
    const identityValid = scope.origin === 'classic'
      ? identity && identity.kind === 'classic' && Number.isInteger(identity.bridgeRun) && identity.bridgeRun >= 0
        && typeof identity.cwd === 'string' && identity.cwd
        && typeof identity.workspaceGeneration === 'string' && identity.workspaceGeneration
        && typeof identity.sessionId === 'string' && identity.sessionId
      : identity && identity.kind === 'runtime'
        && RUNTIME_IDENTITY_KEYS.every(k => k === 'repoId'
          ? identity[k] === null || typeof identity[k] === 'string'
          : typeof identity[k] === 'string' && identity[k]);
    if (!identityValid) return { ok: false, code: 'collab_generate_unavailable' };
    // 第二道闸：当前通道身份必须与 authority 验证时的快照完全一致——
    // 项目/会话在 dispatch 前切换过的旧请求在这里 fail closed，不发送。
    if (!identityMatches(scope.expectedIdentity, identity)) {
      safeLog('collab.identity_mismatch', { origin: scope.origin });
      return { ok: false, code: 'collab_generate_failed' };
    }

    const attempt = {
      attemptId: `ga-${randomId()}`, scopeKey: scope.key, scopeToken: scope.token, sessionId: scope.sessionId,
      documentId: document.documentId, baseRevision: document.revision, origin: scope.origin,
      conversationId: scope.conversationId ?? null, identity, scopeRef: scope,
      state: 'armed', startedAt: now(),
      candidates: [], buffer: [], overflow: false, sawStart: false, failCode: null, proposalId: null, consumed: false,
    };
    attempts.set(attempt.attemptId, attempt);
    try {
      // 先武装（armed）再写 prompt：armed 期间到达的事件只缓冲不采纳——
      // 官方要求订阅先于发送，快速完成的 run 全部落在缓冲里，确认后回放。
      // verify 由通道在每个异步边界（写 stdin 前、应答后）调用：Owner 失效
      // 即抛错，sendPrompt 以失败收场，attempt 连同缓冲一起丢弃。
      const verify = () => { if (!scopeStillCurrent(attempt.scopeRef)) {
        throw Object.assign(Error('collab_generate_failed'), { code: 'collab_generate_failed' });
      } };
      await channel.sendPrompt(scope.origin === 'runtime' ? scope.conversationId : null,
        buildGenerationPrompt({ document, instruction: text }), verify);
    } catch (error) {
      attempts.delete(attempt.attemptId);
      attempt.buffer = [];
      if (attempt.proposalId && typeof queue.drop === 'function') queue.drop(attempt.proposalId);
      safeLog('collab.generate_rejected', { origin: scope.origin, code: mapChannelError(error) });
      return { ok: false, code: mapChannelError(error) };
    }
    confirmPrompt(attempt);
    return { ok: true, attemptId: attempt.attemptId };
  }

  /** 状态信箱：按 scopeKey + scopeToken 过滤（旧 Owner 读不到新 Owner 的状态，
   *  反之亦然）；running 持续可见；终局结果只投递一次，之后回到 idle。 */
  function generationStatus(scopeKey, scopeToken) {
    prune();
    let latest = null;
    for (const attempt of attempts.values()) {
      if (attempt.scopeKey !== scopeKey || attempt.scopeToken !== scopeToken) continue;
      latest = attempt;
    }
    if (!latest) return { state: 'idle' };
    if (RUNNING_STATES.has(latest.state)) return { state: 'running' };
    if (latest.consumed) return { state: 'idle' };
    latest.consumed = true;
    return { state: latest.state, ...(latest.failCode ? { code: latest.failCode } : {}), ...(latest.proposalId ? { proposalId: latest.proposalId } : {}) };
  }

  /** 服务用：按当前 scope 取回建议证据；摘要不符即不可见（内容篡改防护）。 */
  function get(scope, proposalId) {
    const found = queue.get(scope?.key, scope?.token, proposalId);
    if (!found) return null;
    const digest = proposalDigest({
      documentId: found.proposal.documentId, baseRevision: found.proposal.baseRevision,
      sessionId: found.proposal.sessionId, rationale: found.proposal.rationale, ops: found.proposal.ops,
    });
    if (digest !== found.digest) return null;
    return { proposal: found.proposal, scopeToken: scope.token, digest: found.digest, status: found.status };
  }

  function head(scope, documentId) {
    return queue.head(scope?.key, scope?.token, documentId);
  }
  function settle(scopeKey, proposalId, outcome) {
    return queue.settle(scopeKey, proposalId, outcome);
  }
  function dropScope(scopeKey) { queue.dropScope(scopeKey); for (const [key, attempt] of attempts) if (attempt.scopeKey === scopeKey) attempts.delete(key); }
  function dropAll() { queue.dropAll(); attempts.clear(); }
  function stats() { return { ...queue.stats(), attempts: attempts.size }; }

  return { beginGeneration, generationStatus, observeClassic, observeRuntime, get, head, settle, dropScope, dropAll, stats };
}
