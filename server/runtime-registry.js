import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeWitnessCurrent } from './provider-config-sync.js';
import { createExecutionDetailIndex } from './execution-timeline.js';
import { createExecutionTimelineCapture } from './execution-timeline-capture.js';
import { projectExecutionHistory, runtimeExecutionIdentity } from './execution-timeline-history.js';

const OWNER_KEYS = ['backendInstance', 'projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'conversationId', 'runtimeId', 'runtimeGeneration', 'sessionId'];
/* status / recover 允许 bridge 换代后的旧 owner 继续查询：runtimeId /
 * runtimeGeneration / sessionId 是瞬时字段，事务的稳定归属是项目、工作区
 * 与 conversation。native session 是否仍一致由 message-edit 服务回读
 * get_state 后判定，不一致会走 recovery_required(stale_session)。 */
const RECOVERY_OWNER_KEYS = ['backendInstance', 'projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'conversationId'];
const COMMANDS = new Set(['prompt', 'steer', 'follow_up', 'abort', 'get_state', 'get_messages', 'get_entries', 'get_tree', 'get_session_stats', 'get_available_models', 'get_available_thinking_levels', 'get_commands', 'set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level', 'set_session_name', 'extension_ui_response', 'compact']);
const TURNS = new Set(['prompt', 'steer', 'follow_up']);
/* 编辑事务期间允许的只读命令与用户级控制：读状态、看历史、Stop、审批应答。
 * 其余命令都会改变历史、owner 或运行代次，一律 edit_in_progress。 */
const EDIT_READ_ONLY = new Set(['get_state', 'get_messages', 'get_entries', 'get_tree', 'get_session_stats', 'get_available_models', 'get_available_thinking_levels', 'get_commands']);
const EDIT_ALLOWED = new Set(['abort', 'extension_ui_response']);
const MAX_PENDING_TURNS = 32;
const fail = code => Object.assign(Error(code), { code });
const closed = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
const rootKey = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const projectWorkspace = w => typeof w?.workspaceId === 'string' && w.workspaceId.startsWith('project-');

// A registry owns lifetimes, not Pi's session schema. All executable adapters and
// workspace admission/health are injected by the composition root.
export function createRuntimeRegistry({ dataDir, factory, resolveWorkspace, validateWorkspace = async () => {},
  publish = () => {}, externalCount = () => 0, beforeStart = () => null, beforeCommand = () => null,
  admission = (_args, action) => action(), onFocus = async () => {}, maxEvents = 200, maxBytes = 1024 * 1024,
  logEvent = null, providerLifecycle = () => {}, sharedAdmission = async () => { throw fail('tool_guard_unavailable'); },
  sessionTitle = null, executionValidation = false, executionStore = null } = {}) {
  const diagLog = typeof logEvent === 'function' ? logEvent : () => {};
  const safeLog = (event, details = {}) => { try { diagLog(event, details); } catch { /* observation only */ } };
  const backendInstance = randomUUID(), records = new Map(), lives = new Map(), leases = new Map(), revisions = new Map();
  let revision = 0, contextRevision = 0;
  const details = executionValidation === true ? createExecutionDetailIndex({
    isCurrent: async (scope, branchEpoch) => {
      try {
        const live = resolve(scope.owner);
        await validateWorkspace(live.record.workspace);
        return live === resolve(scope.owner) && live.executionBranchEpoch === branchEpoch;
      } catch { return false; }
    },
    readBranch: scope => executionBranch(scope.owner),
  }) : null;
  fs.mkdirSync(dataDir, { recursive: true });
  const dataRoot = fs.realpathSync(dataDir), manifest = path.join(dataRoot, 'conversations.json');
  const rootIdentity = fs.statSync(dataRoot);
  let queue = Promise.resolve(), disposed = false, invalid = false, focused = null;
  try {
    if (fs.existsSync(manifest)) {
      // This is accumulated local metadata, not a single-request payload. Its
      // size/count must not turn retained conversations into an admission cap.
      if (fs.lstatSync(manifest).isSymbolicLink()) throw Error();
      const value = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.items)) throw Error();
      for (const r of value.items) {
        if (!closed(r, ['conversationId', 'workspace', 'sessionId', 'sessionLocator', 'sessionIdentity', 'sessionName', 'nameSource', 'createdAt', 'requestId']) || typeof r.conversationId !== 'string'
          || !/^[\da-f-]{36}$/.test(r.conversationId) || records.has(r.conversationId)
          || !closed(r.workspace, ['projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'cwd', 'root', 'branch'])
          || (r.sessionName !== undefined && (typeof r.sessionName !== 'string' || r.sessionName.length > 200))
          || (r.nameSource !== undefined && !['native', 'seed'].includes(r.nameSource))
          || (r.requestId !== undefined && (typeof r.requestId !== 'string' || !/^[\da-f-]{36}$/.test(r.requestId)))
          || (r.sessionIdentity != null && (!closed(r.sessionIdentity, ['dev', 'ino', 'birthtimeMs'])
            || !['dev', 'ino', 'birthtimeMs'].every(k => typeof r.sessionIdentity[k] === 'number' && Number.isFinite(r.sessionIdentity[k]))))
          || !['projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'cwd', 'root'].every(k => typeof r.workspace[k] === 'string')) throw Error();
        /* 旧记录没有 nameSource：`openProjectSession` 曾把显示标题写进
         * sessionName，无法证明它是 Pi 原生名。按 seed 保守处理，等一次
         * get_state 明确读到原生名后再升级为 native。 */
        r.nameSource = r.nameSource === 'native' ? 'native' : 'seed';
        records.set(r.conversationId, r);
      }
    }
  } catch { invalid = true; records.clear(); }
  function guardStore() {
    try {
      const now = fs.statSync(dataRoot);
      if (disposed || invalid || fs.realpathSync(dataRoot) !== dataRoot || now.dev !== rootIdentity.dev || now.ino !== rootIdentity.ino
        || (fs.existsSync(manifest) && fs.lstatSync(manifest).isSymbolicLink())) throw Error();
    } catch {
      safeLog('runtime.owner_rejected', { operation: 'guard', reason: 'registry_unavailable' });
      throw fail('registry_unavailable');
    }
  }
  function save() {
    guardStore(); const tmp = path.join(dataRoot, `.conversations-${randomUUID()}.tmp`);
    try { fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: [...records.values()] }), { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, manifest); }
    catch { throw fail('metadata_write_failed'); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  function serialize(action) { const task = queue.catch(() => {}).then(action); queue = task.catch(() => {}); return task; }
  function owner(live) { return { backendInstance, ...Object.fromEntries(['projectId', 'repoId', 'workspaceId', 'workspaceEpoch'].map(k => [k, live.record.workspace[k]])),
    conversationId: live.record.conversationId, runtimeId: live.id, runtimeGeneration: live.generation, sessionId: live.sessionId }; }
  function belongs(live) { return !disposed && lives.get(live.record.conversationId) === live && !live.retired; }
  function resolve(expected, allowRetired = false) {
    if (!closed(expected, OWNER_KEYS) || OWNER_KEYS.some(k => !Object.hasOwn(expected, k))) {
      safeLog('runtime.owner_rejected', { operation: 'resolve', reason: 'owner_shape' });
      throw fail('stale_runtime');
    }
    const live = lives.get(expected.conversationId);
    if (!live || (!allowRetired && !belongs(live)) || OWNER_KEYS.some(k => owner(live)[k] !== expected[k])) {
      safeLog('runtime.owner_rejected', { operation: 'resolve', reason: 'owner_stale' });
      throw fail('stale_runtime');
    }
    return live;
  }
  function resolveRecovery(expected) {
    if (!closed(expected, OWNER_KEYS) || OWNER_KEYS.some(k => !Object.hasOwn(expected, k))) {
      safeLog('runtime.owner_rejected', { operation: 'resolve_recovery', reason: 'owner_shape' });
      throw fail('stale_runtime');
    }
    const live = lives.get(expected.conversationId);
    if (!live || live.retired || RECOVERY_OWNER_KEYS.some(k => owner(live)[k] !== expected[k])) {
      safeLog('runtime.owner_rejected', { operation: 'resolve_recovery', reason: 'owner_stale' });
      throw fail('stale_runtime');
    }
    return live;
  }
  function disposeResource(live, resource) {
    resource.invalid = true;
    if (resource.disposal) return resource.disposal;
    resource.disposal = Promise.resolve().then(() => resource.dispose()).then(() => {
      live.resources.delete(resource);
    }).catch(() => { resource.disposal = null; throw fail('cleanup_pending'); });
    return resource.disposal;
  }
  function invalidateResources(live) {
    const resources = [...live.resources];
    for (const resource of resources) resource.invalid = true;
    return Promise.allSettled(resources.map(resource => disposeResource(live, resource))).then(results => {
      if (results.some(result => result.status === 'rejected')) throw fail('cleanup_pending');
    });
  }
  function settleResources(live) {
    // Focus may happen inside a resource's preparing operation. Waiting here
    // would make focus -> dispose -> prepare -> focus a lifecycle deadlock.
    // Revocation is synchronous; retire still awaits every retained disposal.
    void invalidateResources(live).catch(() => {
      if (belongs(live)) { live.error = 'cleanup_pending'; changed(live); }
    });
  }
  function bindResource(expected, resource) {
    const live = resolve(expected);
    if (!closed(resource, ['dispose']) || typeof resource.dispose !== 'function') throw fail('invalid_request');
    if (live.resources.size >= 32) throw fail('runtime_resource_limit');
    const binding = { expected: { ...expected }, dispose: resource.dispose, invalid: false, disposal: null };
    live.resources.add(binding);
    return Object.freeze({ isCurrent() {
      if (binding.invalid) return false;
      try { return resolve(binding.expected) === live; } catch { return false; }
    }, dispose: () => disposeResource(live, binding) });
  }
  const COMPLETED_STOPS = new Set(['stop', 'length']);
  /* P4-E：把一次真实运行结束归一成四种可展示终态。这里只消费 registry 已收到
   * 的生命周期证据，不读错误文本、不把连接状态或历史 replay 当成任务结果。
   * `generationResult` 是 model-generation.js 对同一 owner 的结构化总结；
   * 没有它时，才退回该次运行最后一条 assistant 消息的真实 stopReason。 */
  function terminalOutcome(live, event) {
    /* Pi 的 agent_settled 自带 aborted；它比 stopReason / 摘要更能说明这次
     * 运行是被中断的，必须先于 generationResult 判定。 */
    if (event?.aborted === true) return ['interrupted', 'user_cancelled'];
    const result = event?.generationResult;
    if (result && typeof result === 'object') {
      if (result.outcome === 'success') return ['completed', 'generation_completed'];
      if (result.outcome === 'failed') {
        const cancelled = result.failure?.class === 'user_cancelled'
          || live.abortRequested || live.lastAssistantStop === 'aborted';
        return cancelled ? ['interrupted', 'user_cancelled'] : ['failed', 'generation_failed'];
      }
      if (result.outcome === 'unknown') {
        return live.abortRequested || live.lastAssistantStop === 'aborted'
          ? ['interrupted', 'user_cancelled'] : ['unknown', 'unconfirmed'];
      }
    }
    if (live.abortRequested || live.lastAssistantStop === 'aborted') return ['interrupted', 'user_cancelled'];
    if (live.lastAssistantStop === 'error') return ['failed', 'generation_failed'];
    if (COMPLETED_STOPS.has(live.lastAssistantStop)) return ['completed', 'generation_completed'];
    return ['unknown', 'unconfirmed'];
  }
  function recordOutcome(live, kind, reason) {
    /* 一轮运行只收口一次。abort / preflight / bridge 崩溃可能先于同一轮的
     * settled 到达；之后即使再带 generationResult，也不能把已读掉或被用户
     * Stop 的终态重新变成一条后台提示。新一轮由 prompt / agent_start /
     * bridge 换代重新清空 claimed。 */
    if (live.outcomeClaimed) return;
    live.outcomeClaimed = true;
    /* 失败状态属于这一轮，和会话是否在后台无关；与终态一样只收口一次，
     * 否则重复/迟到的失败帧会在成功之后把 error 重新点亮。 */
    if (kind === 'failed') live.error = 'generation_failed';
    /* 正在看的会话不需要「后台完成」提示，但这一轮已经处理过。 */
    if (focused === live.record.conversationId) { live.outcome = null; return; }
    live.outcome = { kind, reason, sequence: ++live.outcomeRevision };
    live.attention = true;
  }
  function titleFor(record) {
    const live = lives.get(record.conversationId);
    try {
      /* dormant 记录的 sessionName 可能只是打开经典会话时写入的显示标题，
       * 不是 Pi 的原生名；只有 get_state 明确读到过原生名（nameSource=native）
       * 且 child 已 ready 时，才把它当作「已确认的原生名」。否则标题存储会
       * 保守地保留已有 manual 覆盖，而不是把显示种子误判成改名。 */
      const value = sessionTitle?.resolve?.(record, {
        nativeConfirmed: live?.everReady === true && record.nameSource === 'native',
      });
      if (value && typeof value.title === 'string' && value.title) return value;
    } catch { /* 标题解析失败退回原始字段，不影响 registry */ }
    return {
      title: record.sessionName || record.workspace.branch || '并行会话',
      source: record.sessionName ? 'manual' : record.workspace.branch ? 'fallback' : 'default',
      revision: 0,
    };
  }
  function executionMetadata(live) {
    return { startSequence: live.executionStartSequence, observedAt: Date.now(), branchEpoch: live.executionBranchEpoch,
      ...(live.executionBoundAt === null ? {} : { sessionBound: true, previousSessionId: null, sessionBoundAtSequence: live.executionBoundAt }) };
  }
  function summary(record) {
    const live = lives.get(record.conversationId);
    const title = titleFor(record);
    return { conversationId: record.conversationId, workspace: { ...record.workspace }, kind: projectWorkspace(record.workspace) ? 'project' : 'worktree',
      /* P32.4：侧栏要按**创建时间**排会话，且点击不得让行换位。排序键必须来自
       * 后端持久记录（record.createdAt），不能由前端按「最近活动」猜 ——
       * 那正是「点一下行就跳位置」的来源。 */
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
      nativeSessionId: record.sessionId || null, sessionName: record.sessionName || null, title: title.title,
      titleSource: title.source,
      /* titleRevision 是**标题**的修订号（持久化，跨重启），与下面的
       * `revision`（runtime 事件序号，仅进程内）不是一个东西。 */
      titleRevision: Number.isSafeInteger(title.revision) ? title.revision : 0,
      revision: revisions.get(record.conversationId) || 0,
      owner: live ? owner(live) : null, lifecycle: live?.lifecycle || 'dormant', activity: live?.activity || 'idle',
      attention: live?.attention === true, focused: focused === record.conversationId, historyRequired: live?.historyRequired === true,
      outcome: live?.outcome ? { kind: live.outcome.kind, reason: live.outcome.reason, sequence: live.outcome.sequence } : null,
      error: live?.error || null, stop: live?.adapter?.getState().stop || null,
      ...(live ? { execution: executionMetadata(live) } : {}) };
  }
  function snapshot() { return { ok: !invalid, backendInstance, focusedConversationId: focused, liveCount: lives.size,
    totalCount: lives.size + externalCount(), items: [...records.values()].map(summary) }; }
  function touch(live) { revisions.set(live.record.conversationId, ++revision); }
  function changed(live) { if (belongs(live)) { touch(live); publish({ type: 'runtime_state', owner: owner(live), item: summary(live.record) }); } }
  function emit(live, event) {
    if (!belongs(live) || !event || typeof event.type !== 'string') return;
    let executionBoundary = false;
    if (Number.isInteger(event.bridgeRun)) {
      if (event.bridgeRun < live.bridgeRun) return;
      if (event.bridgeRun > live.bridgeRun) { live.bridgeRun = event.bridgeRun; if (live.everReady) {
        details?.invalidate({ kind: 'runtime', owner: owner(live) });
        live.generation = randomUUID();
        live.executionStartSequence = live.sequence;
        live.executionBoundAt = null;
        executionBoundary = true;
        live.outcome = null; live.outcomeClaimed = false; live.runObserved = false;
        live.lastAssistantStop = null; live.abortRequested = false;
        settleResources(live);
      } }
    }
    if (event.type === 'execution_branch') {
      live.executionBranchEpoch += 1;
      live.executionStartSequence = live.sequence;
      details?.invalidate({ kind: 'runtime', owner: owner(live) });
      executionBoundary = true;
    }
    if (executionBoundary || event.type === 'bridge_status' && event.state !== 'ready') live.executionCapture?.reset();
    if (event.type === 'bridge_status') {
      /* 只有 bridge 在**一次已观察/已提交的运行**中退出，才是「中断」；
       * 空闲时连接断开沿用原有 error/attention，不伪造任务终态。 */
      const runActive = live.agentActive || live.pendingTurns.size > 0;
      live.lifecycle = event.state === 'ready' ? 'ready' : ['error', 'exited'].includes(event.state) ? 'error' : 'starting';
      if (event.state === 'ready') {
        live.everReady = true;
        const generation = live.generation;
        void refreshSession(live).catch(() => {
          if (!belongs(live) || generation !== live.generation) return;
          // A failed private read cannot establish native identity. Keep the
          // child, slot and lease owned until explicit close/restart; publish
          // only a fixed code, never upstream request error or worker payload.
          live.lifecycle = 'error'; live.error = 'session_state_unconfirmed'; live.attention = true;
          changed(live);
        });
      }
      else { live.activity = 'idle'; live.agentActive = false; live.pendingTurns.clear(); live.editTurn = false; live.editUnresolved = false; live.editing = null; if (!live.everReady) live.sessionId = null; }
      if (['error', 'exited'].includes(event.state)) {
        live.error = 'runtime_unavailable'; live.attention = true;
        if (runActive) recordOutcome(live, 'interrupted', 'runtime_unavailable');
      }
    }
    if (event.type === 'agent_start') {
      live.agentActive = true; live.runObserved = true;
      live.editTurn = false;
      live.editUnresolved = false;
      live.outcome = null; live.outcomeClaimed = false;
      /* 自动重试/续跑会产生新的 agent_start，但不经过新的 prompt command；
       * 上一轮的失败错误必须在这里清掉，否则重试成功后详情仍显示上次失败。 */
      if (live.error === 'generation_failed') live.error = null;
      /* 自动重试/继续会产生新的 agent_start：上一轮的中断/停止证据不能
       * 带进这一轮，否则一次新的空 settled 会被误判成上一轮的取消。 */
      live.lastAssistantStop = null; live.abortRequested = false;
      if (live.activity !== 'stopping') live.activity = 'running';
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      live.lastAssistantStop = typeof event.message.stopReason === 'string' ? event.message.stopReason : null;
    }
    if (event.type === 'agent_settled') {
      const runEnded = live.runObserved || live.agentActive || live.pendingTurns.size > 0
        || Boolean(event.generationResult) || event.aborted === true;
      live.editTurn = false;
      live.editUnresolved = false;
      live.agentActive = false; live.pendingTurns.clear(); live.approvals.clear(); if (live.activity !== 'stopping') live.activity = 'idle';
      /* 有终态时由 recordOutcome 决定是否点亮 attention；重复 settled 和
       * 已读掉的终态不能把通用 attention 点重新点亮。没有任何终态证据时，
       * 沿用原有的通用 attention。 */
      if (runEnded) {
        const [kind, reason] = terminalOutcome(live, event);
        recordOutcome(live, kind, reason);
      } else if (focused !== live.record.conversationId && !live.outcomeClaimed) {
        live.attention = true;
      }
      live.runObserved = false;
    }
    /* refreshSession 负责把「原生会话文件已经落盘」这件事确认下来：新建的
     * Runtime 会话在第一条消息之前 sessionLocator 还是 null。标题观察必须等
     * 这次核对完成，否则首轮成功时拿不到 locator，自动标题永远不会生成。 */
    const settledRefresh = event.type === 'agent_settled' ? refreshSession(live) : null;
    if (settledRefresh) void settledRefresh.catch(()=>{if(belongs(live)){live.error='session_state_unconfirmed';changed(live);}});
    /* 自动标题只观察**已确认成功且有可见输出**的终态。传的是后端持有的
     * locator/身份，不是 Renderer 能伪造的字段；service 会再读一次文件核对。 */
    if (event.type === 'agent_settled' && event.generationResult?.outcome === 'success'
      && event.generationResult.hasVisibleOutput === true && event.aborted !== true) {
      const generation = live.generation;
      void (settledRefresh || Promise.resolve()).then(() => {
        if (!belongs(live) || generation !== live.generation) return;
        try {
          sessionTitle?.observe?.({
            conversationId: live.record.conversationId,
            sessionId: live.sessionId || live.record.sessionId,
            sessionLocator: live.record.sessionLocator,
            sessionIdentity: live.record.sessionIdentity,
            cwd: live.record.workspace.cwd,
            sessionName: live.record.sessionName,
            createdAt: live.record.createdAt,
            aborted: false,
            generationResult: event.generationResult,
          });
        } catch { /* observation only */ }
      }, () => {
        /* 刷新失败时 locator 尚未确认，不能拿可能过期的字段触发标题；
         * 同时必须消费 rejection，否则会变成进程级 unhandledRejection。 */
      });
    }
    // A response settles only its captured request. Other requests may still be
    // awaiting acknowledgement, even before the first agent_start arrives.
    if (event.type === 'response' && typeof event.success === 'boolean' && TURNS.has(event.command) && live.pendingTurns.get(event.id) === event.command) {
      live.pendingTurns.delete(event.id);
      if (event.success === true && event.data?.disposition !== 'handled') live.agentActive = true;
      if (!live.agentActive && !live.pendingTurns.size && live.activity !== 'stopping') live.activity = 'idle';
    }
    if (event.type === 'stop_state') { live.activity = event.pending ? 'stopping' : 'idle'; if (!event.pending) { live.agentActive = false; live.pendingTurns.clear(); live.approvals.clear(); } }
    if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(event.method)) {
      if (!live.approvals.has(event.id) && live.approvals.size >= 32) live.approvals.delete(live.approvals.keys().next().value);
      live.approvals.set(event.id, event);
    }
    if (event.type === 'bridge_status' && event.state !== 'ready') live.approvals.clear();
    if (event.type === 'extension_ui_request' || event.type === 'extension_error') live.attention = true;
    /* prompt preflight 失败没有 agent_start/agent_settled，但同一条 response
     * 已带有结构化 generationResult；它是该次提交的真实终态。 */
    if (event.type === 'response' && event.generationResult) {
      const [kind, reason] = terminalOutcome(live, event);
      recordOutcome(live, kind, reason);
    }
    // Diagnostic raw lines are never retained in parallel conversation buffers.
    if (event.type === 'bridge_stderr' || event.type === 'bridge_parse_error') { changed(live); return; }
    const frame = { type: 'runtime_event', owner: owner(live), eventSequence: ++live.sequence, event, execution: executionMetadata(live) };
    try {
      live.executionCapture?.observe(event, { sequence: frame.eventSequence, observedAt: frame.execution.observedAt });
    } catch { /* history evidence can never gate event publication */ }
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    if (bytes <= maxBytes) { live.events.push({ frame, bytes }); live.bytes += bytes; }
    else live.historyRequired = true;
    while (live.events.length > maxEvents || live.bytes > maxBytes) { live.bytes -= live.events.shift().bytes; live.historyRequired = true; }
    // Seed authoritative scope before the first frame of a new generation or
    // branch, so receivers need not infer a predecessor from a sequence gap.
    if (executionBoundary) changed(live);
    publish(frame);
    if (!executionBoundary) changed(live);
  }
  async function refreshSession(live) {
    const generation = live.generation;
    const state = await live.adapter?.request({ type: 'get_state' });
    if (!belongs(live) || generation !== live.generation || typeof state?.sessionId !== 'string' || !state.sessionId || state.sessionId.length > 128) return;
    if (live.record.sessionId && live.record.sessionId !== state.sessionId) {
      // Resume must select the proven disk session. Do not silently attach --continue.
      live.error = 'session_mismatch';
      safeLog('runtime.session_switch_failed', { phase: 'binding', code: 'session_mismatch' });
      void close(owner(live)).catch(() => {}); return;
    }
    for (const other of lives.values()) if (other !== live && other.sessionId === state.sessionId) {
      live.error = 'session_in_use';
      safeLog('runtime.session_switch_failed', { phase: 'binding', code: 'session_in_use' });
      void close(owner(live)).catch(() => {}); return;
    }
    const firstBinding = live.sessionId === null;
    live.sessionId = state.sessionId;
    if (firstBinding) {
      live.executionBoundAt = live.sequence;
      changed(live);
    }
    if (live.activity === 'idle') void live.executionCapture?.checkpoint();
    // The factory must prove any path against the scanner/header before persistence.
    const locator = live.adapter.sessionLocator ? await live.adapter.sessionLocator(state) : null;
    if (!belongs(live) || generation !== live.generation) return;
    live.record.sessionId = state.sessionId; live.record.sessionLocator = locator;
    live.record.sessionIdentity = null;
    if (locator) try { const st = fs.statSync(locator); live.record.sessionIdentity = { dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs }; } catch {}
    live.providerSessionIdentity ??= live.record.sessionIdentity;
    if (typeof state.sessionName === 'string' && (state.sessionName.trim() || !projectWorkspace(live.record.workspace))) {
      /* 这条名字来自 get_state，是 Pi 的原生名；与打开会话时写入的显示种子
       * 区分开，标题裁决才知道它可以用来判定「用户是否改过名」。 */
      live.record.sessionName = state.sessionName.trim().replace(/\s+/g, ' ').slice(0, 200);
      live.record.nameSource = 'native';
    }
    try { save(); } catch { live.error = 'metadata_write_failed'; }
    changed(live);
    providerLifecycle();
  }
  async function launchRecord(record, options = {}) {
    guardStore(); const blocked = beforeStart(); if (blocked) throw fail(blocked);
    if (!options.workspaceChecked) await validateWorkspace(record.workspace, record.sessionId); guardStore();
    if (beforeStart()) throw fail(beforeStart());
    const key = rootKey(fs.realpathSync(record.workspace.root));
    const occupants = leases.get(key);
    if (!projectWorkspace(record.workspace)) { if (occupants?.size) throw fail('workspace_in_use'); }
    else {
      if (occupants && [...occupants].some(l => !projectWorkspace(l.record.workspace))) throw fail('workspace_in_use');
      const sharedCurrent = await sharedAdmission(record.workspace, [...lives.values()].map(l => ({ workspace:l.record.workspace, adapter:l.adapter })));
      // Startup/hello waits may outlive workspace, native-session or maintenance authority.
      await validateWorkspace(record.workspace, record.sessionId);
      guardStore();
      if (beforeStart()) throw fail(beforeStart());
      if (typeof sharedCurrent !== 'function' || !sharedCurrent()) throw fail('tool_guard_unavailable');
    }
    const live = { record, id: randomUUID(), generation: randomUUID(), sessionId: null, lifecycle: 'starting', activity: 'idle', agentActive: false, pendingTurns: new Map(),
      providerSessionIdentity: record.sessionIdentity,
      executionStartSequence: 0, executionBoundAt: null, executionBranchEpoch: 0,
      sequence: 0, events: [], bytes: 0, bridgeRun: 0, everReady: false, attention: false, historyRequired: false, error: null, retired: false, key, resources: new Set(), approvals: new Map(),
      /* P4-E：每轮运行至多一条后台终态；revision 单调递增，作为前端去重/排序的
       * 证据序号。runObserved 标记本轮确实观察到 agent_start 或提交成功。 */
      outcome: null, outcomeRevision: 0, outcomeClaimed: false, runObserved: false,
      lastAssistantStop: null, abortRequested: false,
      /* 历史消息编辑事务：`editing` 是当前 requestId（事务期间阻止普通 prompt），
       * `editTurn` 从 prompt 被接受保留到 agent_start/settled，堵住
       * 「response 已到、agent_start 还没到」那段窗口。`editUnresolved` 表示
       * 结果未知：锁必须保留到状态查询 / recover 给出可核对结论。 */
      editing: null, editTurn: false, editUnresolved: false };
    if (executionStore) live.executionCapture = createExecutionTimelineCapture({
      store: executionStore, identity: scope => runtimeExecutionIdentity(scope.owner),
      readBranch: () => executionBranch(owner(live)),
    });
    if (!leases.has(key)) leases.set(key, new Set());
    leases.get(key).add(live); lives.set(record.conversationId, live);
    live.adapterReady = Promise.resolve().then(async () => {
      if (!belongs(live)) throw fail('stale_runtime');
      live.adapter = await factory({ cwd: record.workspace.cwd, workspace: { ...record.workspace }, owner: owner(live),
        sessionId: record.sessionId, sessionLocator: record.sessionLocator, isCurrent: () => belongs(live), getOwner: () => owner(live) }, event => emit(live, event));
    });
    changed(live);
    try {
      await live.adapterReady;
      if (!belongs(live)) throw fail('stale_runtime');
      /* HTTP start 的启动等待不能在全局生命周期队列里进行：登记、租约和 factory
       * 预留已在队列内完成，adapter.start() 交给调用方在队列外等待。否则一个
       * 慢启动（例如工具守卫准备）会把无关工作区的 start/focus/close 全排在后。
       * launchRecord 的直接调用方（open/resume）保持原有的就绪即返回语义。 */
      if (options.deferStart) return { ok: true, deferStart: true, live, conversationId: record.conversationId, owner: owner(live), item: summary(record) };
      /* 新建会话（HTTP start）必须等到适配器确实开始启动，才能把「起不来」
       * 作为可见的失败返回；历史恢复/项目会话则在适配器就绪后立即返回，
       * 启动过程通过事件推进 —— 否则同项目 B 的共享启动准入只能排在 A
       * 完整启动之后，多个会话的启动被无谓地串行化。 */
      if (options.awaitStart) {
        await live.adapter.start();
        if (!belongs(live)) throw fail('stale_runtime');
      } else {
        /* 异步 start 的拒绝仍然必须有人观察：它只属于这个 live，退掉它自己，
         * 不能变成未处理的 rejection 把整个后端带走。 */
        void Promise.resolve().then(() => live.adapter.start()).catch(e => {
          if (!belongs(live)) return;
          live.lifecycle = 'error'; live.error = 'runtime_start_failed';
          safeLog('runtime.start_failed', { phase: 'start', code: e && e.code ? e.code : 'runtime_start_failed' });
          changed(live);
          void retire(live).catch(() => {});
        });
      }
      return { ok: true, conversationId: record.conversationId, owner: owner(live), item: summary(record) };
    } catch (e) {
      live.lifecycle = 'error'; live.error = 'runtime_start_failed';
      safeLog('runtime.start_failed', { phase: 'factory', code: e && e.code ? e.code : 'runtime_start_failed' });
      if (live.adapter || live.retirePromise) await retire(live).catch(() => {});
      else { lives.delete(record.conversationId); leases.get(key)?.delete(live); if (!leases.get(key)?.size) leases.delete(key); }
      throw fail(e.code || 'runtime_start_failed');
    }
  }
  function start(args) {
    if (!closed(args, ['id', 'epoch', 'project'])) return Promise.reject(fail('invalid_request'));
    const reserved = serialize(() => admission(args, async admitted => {
      guardStore();
      const workspace = admitted || await resolveWorkspace(args);
      const record = { conversationId: randomUUID(), workspace, sessionId: null, sessionLocator: null, nameSource: 'seed', createdAt: new Date().toISOString() };
      records.set(record.conversationId, record); save();
      try { return await launchRecord(record, { workspaceChecked: Boolean(admitted), deferStart: true }); }
      catch (e) { if (!lives.has(record.conversationId)) records.delete(record.conversationId); save(); throw e; }
    }));
    /* 只在本次 HTTP 请求自己的 Promise 上等待启动结果；全局队列在登记/租约/
     * factory 预留完成后就已释放，无关 Runtime 不必排在慢启动后面。失败只
     * 回收这一个 live，并回滚它新建的持久记录。 */
    return reserved.then(async ({ live, conversationId, owner: reservedOwner, item }) => {
      try {
        await live.adapter.start();
        if (!belongs(live)) throw fail('stale_runtime');
        return { ok: true, conversationId, owner: reservedOwner, item };
      } catch (e) {
        live.lifecycle = 'error'; live.error = 'runtime_start_failed';
        safeLog('runtime.start_failed', { phase: 'start', code: e && e.code ? e.code : 'runtime_start_failed' });
        if (live.adapter || live.retirePromise) await retire(live).catch(() => {});
        else { lives.delete(live.record.conversationId); leases.get(live.key)?.delete(live); if (!leases.get(live.key)?.size) leases.delete(live.key); }
        if (!lives.has(live.record.conversationId)) {
          records.delete(live.record.conversationId);
          try { save(); } catch { /* Later operations surface storage failure as before. */ }
        }
        throw fail(e.code || 'runtime_start_failed');
      }
    });
  }
  // Backend-only input: HTTP callers cannot provide workspace paths or native
  // locators. The ordinary-session resolver must prove them before this method.
  function openProjectSession({ workspace, sessionId = null, sessionLocator = null, sessionIdentity = null, sessionName = '', requestId }) {
    return serialize(async () => {
      guardStore();
      if (!projectWorkspace(workspace)) throw fail('invalid_request');
      await validateWorkspace(workspace);
      let record = [...records.values()].find(r => r.workspace.workspaceId === workspace.workspaceId
        && r.workspace.workspaceEpoch === workspace.workspaceEpoch && (sessionId ? r.sessionId === sessionId : requestId && r.requestId === requestId));
      if (record && lives.has(record.conversationId)) {
        const live = lives.get(record.conversationId);
        if (live.retired) throw fail('cleanup_pending');
        return {ok:true,conversationId:record.conversationId,owner:owner(live),item:summary(record)};
      }
      const fresh = !record;
      if (fresh) {
        record = {conversationId:randomUUID(),workspace,sessionId,sessionLocator,sessionIdentity,sessionName:String(sessionName).slice(0,200),nameSource:'seed',createdAt:new Date().toISOString(),...(requestId?{requestId}:{})};
        records.set(record.conversationId,record); save();
      }
      try { return await launchRecord(record); }
      catch(e) { if (fresh && !lives.has(record.conversationId)) {records.delete(record.conversationId);save();} throw e; }
    });
  }
  function resume(id) {
    return serialize(async () => { const record = records.get(id); if (!record) throw fail('unknown_conversation');
      if (lives.has(id)) throw fail('workspace_in_use');
      return admission({ id: record.workspace.workspaceId, epoch: record.workspace.workspaceEpoch }, admitted => {
        if (admitted && ['projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'cwd', 'root', 'branch'].some(k =>
          ['cwd', 'root'].includes(k) ? rootKey(admitted[k]) !== rootKey(record.workspace[k]) : admitted[k] !== record.workspace[k])) throw fail('stale_workspace');
        return launchRecord(record, { workspaceChecked: Boolean(admitted) });
      }, { workspace: { ...record.workspace }, sessionId: record.sessionId }); });
  }
  async function command(expected, cmd) {
    let live = resolve(expected);
    if (!cmd || !COMMANDS.has(cmd.type) || typeof cmd.id === 'number' || Object.hasOwn(cmd, 'sessionPath') || Object.hasOwn(cmd, '__owner')) throw fail('invalid_command');
    const admissionGuard = live.adapter.captureCommandGuard?.(cmd);
    if (cmd.type !== 'abort') { await validateWorkspace(live.record.workspace); live = resolve(expected); }
    admissionGuard?.();
    const blocked = beforeCommand(cmd, live); if (blocked && cmd.type !== 'abort') {
      safeLog('runtime.owner_rejected', { operation: 'command', reason: 'before_command' });
      throw fail(blocked);
    }
    if (live.lifecycle !== 'ready') {
      safeLog('runtime.owner_rejected', { operation: 'command', reason: 'runtime_not_ready' });
      throw fail('runtime_not_ready');
    }
    if (cmd.type === 'abort') {
      const runActive = live.agentActive || live.pendingTurns.size > 0;
      const seenOutcome = live.outcome, priorOutcomeRevision = live.outcomeRevision;
      if (runActive) live.abortRequested = true;
      live.activity = 'stopping'; changed(live);
      let result;
      try { result = await live.adapter.abortAndWait(cmd); }
      catch (error) {
        /* adapter 自身异常同样表示 Stop 未被确认，不能留下取消证据。 */
        if (belongs(live)) { live.abortRequested = false; changed(live); }
        throw error;
      }
      live = resolve(expected);
      if (result.ok) {
        live.activity = 'idle'; live.agentActive = false; live.pendingTurns.clear(); live.approvals.clear();
        /* 有些 adapter 的 abort 不保证补发 agent_settled；成功停下且此前确有
         * 运行，就由命令结果收口。若期间已收到真实终态，不覆盖它。 */
        const noTerminal = live.outcomeRevision === priorOutcomeRevision && !live.outcomeClaimed;
        if (runActive && live.outcome === seenOutcome) recordOutcome(live, 'interrupted', 'user_cancelled');
        // Focused conversations have no persisted sidebar outcome. Publish
        // confirmed Stop evidence for the shadow reducer, not another state change.
        if (runActive && noTerminal) {
          emit(live, { type: 'execution_stop', bridgeRun: live.bridgeRun });
        }
      }
      /* Stop 无论是否确认成功，都不再把这次请求留成后续终态的取消证据：
       * 失败时运行可能仍在继续，成功时终态已由上面的命令结果收口。
       * 后续正常完成不能被误报成「已中断」。 */
      live.abortRequested = false;
      changed(live); return result;
    }
    if ((live.editing || live.editTurn || live.editUnresolved) && !EDIT_READ_ONLY.has(cmd.type) && !EDIT_ALLOWED.has(cmd.type)) throw fail('edit_in_progress');
    if (TURNS.has(cmd.type) && live.activity === 'stopping') throw fail('stop_in_progress');
    if (cmd.type === 'prompt' && (live.agentActive || live.pendingTurns.size)) throw fail('runtime_busy');
    if (TURNS.has(cmd.type)) {
      cmd = { ...cmd, id: typeof cmd.id === 'string' ? cmd.id : randomUUID() };
      if (live.pendingTurns.has(cmd.id)) throw fail('invalid_command');
      if (live.pendingTurns.size >= MAX_PENDING_TURNS) throw fail('runtime_request_limit');
      live.pendingTurns.set(cmd.id, cmd.type);
      /* 新的一轮提交意味着上一轮结果已被用户处理；清掉旧终态与属于上一轮的
       * 停止证据，agent_start 还会再清一次以覆盖自动续跑/重试。 */
      live.outcome = null; live.outcomeClaimed = false; live.runObserved = false;
      live.lastAssistantStop = null; live.abortRequested = false;
      live.error = null; live.activity = 'running'; changed(live);
    }
    try { await live.adapter.send(cmd); resolve(expected); if (cmd.type === 'extension_ui_response') live.approvals.delete(cmd.id); }
    catch (error) {
      if (belongs(live) && TURNS.has(cmd.type)) {
        live.pendingTurns.delete(cmd.id);
        if (!live.agentActive && !live.pendingTurns.size && live.activity !== 'stopping') live.activity = 'idle';
        changed(live);
      }
      throw error;
    }
    changed(live); return { ok: true };
  }
  async function read(expected, cmd) {
    if (!['get_state', 'get_messages', 'get_entries', 'get_session_stats', 'get_available_models', 'get_available_thinking_levels', 'get_commands'].includes(cmd?.type)) throw fail('invalid_command');
    const live = resolve(expected); await validateWorkspace(live.record.workspace); resolve(expected);
    const result = await live.adapter.request(cmd); resolve(expected);
    if (cmd.type === 'get_state' && result?.sessionId === live.sessionId && typeof result.sessionName === 'string' && (result.sessionName.trim() || !projectWorkspace(live.record.workspace))) {
      const name = result.sessionName.trim().replace(/\s+/g, ' ').slice(0, 200);
      if (live.record.sessionName !== name) { live.record.sessionName = name; save(); changed(live); }
      /* 即便名字与显示种子相同，这条也是 get_state 读到的原生名。 */
      if (live.record.nameSource !== 'native') { live.record.nameSource = 'native'; save(); changed(live); }
    }
    return result;
  }
  /** Backend-owned verification call. No Runtime action exposes this witness
   * or the validation-only detail reader. Never use the public get_entries. */
  async function executionBranch(expected, detailTarget = null, onVerifiedPath = null) {
    try {
      const live = resolve(expected), branchEpoch = live.executionBranchEpoch;
      if (!live.sessionId || live.lifecycle !== 'ready' || typeof live.adapter.executionBranch !== 'function') return null;
      await validateWorkspace(live.record.workspace);
      resolve(expected);
      const branch = await live.adapter.executionBranch({ kind: 'runtime', owner: owner(live) }, branchEpoch,
        detailTarget, onVerifiedPath);
      await validateWorkspace(live.record.workspace);
      return resolve(expected) === live && live.executionBranchEpoch === branchEpoch ? branch : null;
    } catch { return null; }
  }
  async function executionHistory(expected) {
    const unavailable = { ok: false, code: 'history_unavailable' };
    const live = resolve(expected);
    const idle = () => live.lifecycle === 'ready' && live.activity === 'idle' && !live.agentActive
      && !live.pendingTurns.size && !live.approvals.size && !live.editing && !live.editTurn && !live.editUnresolved;
    if (!executionStore || !idle() || !live.sessionId) return unavailable;
    const records = executionStore.list(runtimeExecutionIdentity(expected));
    if (!records.length) return unavailable;
    const cursor = live.sequence, branchEpoch = live.executionBranchEpoch;
    let history = null;
    const branch = await executionBranch(expected, null, (entries, witness) => {
      history = projectExecutionHistory(entries, records, { sessionId: live.sessionId, leafId: witness.leafId, editable: true });
    });
    if (!branch || !history || live.sequence !== cursor || live.executionBranchEpoch !== branchEpoch || !idle()) return unavailable;
    return { ...history, owner: owner(live), cursor, branchEpoch, locator: historyTarget(live.record).locator };
  }
  async function captureExecutionDetail(expected, evidence) {
    if (!details) return null;
    const { responseEntryId, resultEntryId, callId } = evidence || {};
    const target = { responseEntryId, resultEntryId, callId };
    const branch = await executionBranch(expected, target);
    if (!branch) return null;
    try {
      if (resolve(expected).executionBranchEpoch !== branch.branchEpoch) return null;
      return details.capture({ ...target, branch, scope: { kind: 'runtime', owner: expected } });
    } catch { return null; }
  }
  function readExecutionDetail(expected, ref, callId) {
    return details?.read({ scope: { kind: 'runtime', owner: expected }, ref, callId })
      || Promise.resolve({ ok: false, code: 'execution_detail_unavailable' });
  }
  function events(expected, cursor = 0) {
    const live = resolve(expected);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      safeLog('runtime.owner_rejected', { operation: 'events', reason: 'invalid_cursor' });
      throw fail('invalid_cursor');
    }
    return { ok: true, owner: owner(live), cursor: live.sequence, bytes: live.bytes,
      historyRequired: live.historyRequired || (live.events.length > 0 && cursor < live.events[0].frame.eventSequence - 1),
      events: live.events.filter(e => e.frame.eventSequence > cursor).map(e => e.frame),
      approvals: [...live.approvals.values()], item: summary(live.record) };
  }
  /* ---------- 历史用户消息编辑 ----------
   *
   * 事务本体在 adapter 自己的 `messageEdit` 服务里（同一个 Pi、同一个 session）。
   * registry 只负责三件事：owner 逐字段核验、workspace 校验、以及一把按 live
   * 实例的锁 —— 事务期间普通 prompt / steer / follow_up 一律 `edit_in_progress`。
   *
   * `editTurn` 在**发 prompt 之前**置位，由 agent_start / agent_settled /
   * bridge 非 ready 清除。不能等 response 回来再置位：极快的失败 run 可能在
   * 异步回调之前就 settled，迟到的置位会留下永久的忙锁。
   */
  function editIo(live, expected, requestId, targetEntryId = null) {
    return {
      scope: 'runtime',
      sessionId: live.sessionId,
      conversationId: live.record.conversationId,
      commandName: () => live.adapter?.messageEditCommand?.() || null,
      editToken: () => live.adapter?.messageEditToken?.() || null,
      getBridgeRun: () => live.bridgeRun,
      request: cmd => live.adapter.messageEditRequest(cmd, { requestId, targetEntryId }),
      validate: () => {
        const current = resolve(expected);
        if (current !== live || live.lifecycle !== 'ready' || live.sessionId !== expected.sessionId) throw fail('stale_runtime');
      },
      busyReason: () => {
        if (live.editTurn && live.editing !== requestId) return 'edit_in_progress';
        if (live.editing && live.editing !== requestId) return 'edit_in_progress';
        if (live.activity !== 'idle' || live.agentActive || live.pendingTurns.size || live.approvals.size
          || live.adapter?.getState?.().stop?.pending) return 'runtime_busy';
        return null;
      },
    };
  }

  /* status / recover 不要求当前生命周期为 ready，也不要求 sessionId 与请求头
   * 完全一致：bridge 异常重启后仍要用原 requestId 查询；是否 stale 由服务回读
   * 到的 native sessionId 判断。 */
  function recoveryEditIo(live, expected, requestId) {
    return {
      ...editIo(live, expected, requestId),
      validate: () => {
        const current = resolveRecovery(expected);
        if (current !== live || live.retired) throw fail('stale_runtime');
      },
    };
  }

  function applyEditStatus(live, requestId, status) {
    if (!belongs(live)) return;
    /* 状态查询可能来自任意旧 requestId。只有**当前事务**的结论才能释放
     * editing / editTurn / editUnresolved；否则一次迟到的旧查询会把正在进行的
     * 事务锁清掉，在 prompt 应答与 agent_start 之间重新打开窗口。 */
    const current = live.editing === requestId;
    if (status?.state === 'accepted') {
      /* prompt 已被接受：释放 requestId 锁，但保留 editTurn 直到 agent_start /
       * settled，堵住「应答已到、run 还没开始」的窗口。 */
      if (current) {
        live.editing = null;
        live.editUnresolved = false;
      }
      return;
    }
    if (status?.state === 'failed' || status?.state === 'recovery_required' || status?.state === 'stale_session') {
      if (current) {
        live.editing = null;
        live.editUnresolved = false;
        live.editTurn = false;
      }
      return;
    }
    if (status?.state === 'acceptance_unknown' || status?.state === 'recovery_pending') {
      if (!live.editing || current) {
        live.editing = requestId;
        live.editUnresolved = true;
      }
    }
  }

  async function editPreflight(expected, input) {
    let live = resolve(expected);
    await validateWorkspace(live.record.workspace);
    live = resolve(expected);
    if (live.lifecycle !== 'ready') throw fail('runtime_not_ready');
    if (!live.sessionId) throw fail('stale_runtime');
    if (typeof live.adapter?.messageEdit?.preflight !== 'function') throw fail('edit_unavailable');
    return live.adapter.messageEdit.preflight(editIo(live, expected, null), input);
  }

  async function editResend(expected, input) {
    let live = resolve(expected);
    await validateWorkspace(live.record.workspace);
    live = resolve(expected);
    if (live.lifecycle !== 'ready') throw fail('runtime_not_ready');
    if (!live.sessionId) throw fail('stale_runtime');
    if (live.editing || live.editUnresolved) throw fail('edit_in_progress');
    if (live.editTurn || live.activity !== 'idle' || live.agentActive || live.pendingTurns.size || live.approvals.size
      || live.adapter?.getState?.().stop?.pending) throw fail('runtime_busy');
    if (typeof live.adapter?.messageEdit?.resend !== 'function') throw fail('edit_unavailable');
    const requestId = typeof input?.requestId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(input.requestId)
      ? input.requestId : randomUUID();
    live.editing = requestId;
    live.editTurn = true;
    let accepted = false;
    let result = null;
    try {
      result = await live.adapter.messageEdit.resend(editIo(live, expected, requestId, input?.expectedEntryId), { ...input, requestId });
      accepted = result?.ok === true;
      return result;
    } finally {
      if (belongs(live)) {
        if (!accepted && result?.unresolved) {
          /* 结果未知：保留 requestId 锁，禁止新的 prompt / 切换 / 重启，
           * 直到状态查询或 recover 给出可核对结论。 */
          live.editing = requestId;
          live.editUnresolved = true;
        } else {
          /* 重复提交**已完成**事务时，服务端直接返回缓存的成功结果
           * （duplicate: true），不会再发 prompt，也就不会有 agent_start /
           * settled 来释放 editTurn。这里必须当场清掉，否则一次网络重试就把
           * Runtime 永久锁在 runtime_busy（prompt / close / restart 全被拒）。 */
          if ((!accepted || result?.duplicate === true) && !live.agentActive) live.editTurn = false;
          if (live.editing === requestId) live.editing = null;
        }
      }
    }
  }

  async function editStatus(expected, requestId) {
    let live = resolveRecovery(expected);
    await validateWorkspace(live.record.workspace);
    live = resolveRecovery(expected);
    if (live.retired || live.lifecycle === 'disposing') throw fail('stale_runtime');
    if (typeof requestId !== 'string') throw fail('invalid_request');
    if (typeof live.adapter?.messageEdit?.status !== 'function') throw fail('edit_unavailable');
    const result = await live.adapter.messageEdit.status(recoveryEditIo(live, expected, requestId), requestId);
    applyEditStatus(live, requestId, result);
    return result;
  }

  async function editRecover(expected, requestId) {
    let live = resolveRecovery(expected);
    await validateWorkspace(live.record.workspace);
    live = resolveRecovery(expected);
    if (live.lifecycle !== 'ready' || live.retired) throw fail('runtime_not_ready');
    if (typeof requestId !== 'string') throw fail('invalid_request');
    if (typeof live.adapter?.messageEdit?.recover !== 'function') throw fail('edit_unavailable');
    const result = await live.adapter.messageEdit.recover(recoveryEditIo(live, expected, requestId), requestId);
    applyEditStatus(live, requestId, result);
    return result;
  }
  function focus(expected) { return serialize(async () => { const live = resolve(expected), previous = focused;
    const prior = previous && previous !== live.record.conversationId ? lives.get(previous) : null;
    if (previous !== live.record.conversationId) contextRevision++;
    if (prior) for (const resource of prior.resources) resource.invalid = true;
    /* 只清除用户在进入会话前已经看得到的那条终态。onFocus 期间新到的一条
     * 不能被这次聚焦顺手吞掉（它尚未被呈现过）。 */
    const seenOutcome = live.outcome;
    try { await onFocus(owner(live)); resolve(expected); }
    catch (error) { if (prior) settleResources(prior); throw error; }
    focused = live.record.conversationId; live.attention = false;
    if (live.outcome === seenOutcome) live.outcome = null;
    if (prior) settleResources(prior);
    /* 焦点是**单值**：换了焦点必须把旧的那条也广播出去。只广播新的，旧会话的
     * item.focused 会一直留在前端 —— P32.4 的侧栏正是按这个字段画高亮的，
     * 于是会同时出现两行「当前」。 */
    if (previous && previous !== focused) { const prior = lives.get(previous); if (prior) changed(prior); }
    changed(live); return { ok: true, item: summary(live.record) }; }); }
  function blur(expected) { return serialize(async () => {
    const live = resolve(expected); if (focused !== live.record.conversationId) return { ok: true };
    contextRevision++; for (const resource of live.resources) resource.invalid = true;
    try { await onFocus(null); resolve(expected); }
    catch (error) { settleResources(live); throw error; }
    focused = null;
    settleResources(live); changed(live); return { ok: true };
  }); }
  function retire(live) {
    if (live.retirePromise) return live.retirePromise;
    live.executionCapture?.reset();
    live.closedOwner ||= owner(live);
    if (!live.retired) {
      details?.invalidate({ kind: 'runtime', owner: owner(live) });
      live.retired = true; live.generation = randomUUID();
    }
    live.lifecycle = 'disposing';
    live.retirePromise = (async () => {
      // Invalidation can arrive while the factory is still acquiring resources.
      const disposeAdapter = async () => {
        await live.adapterReady.catch(() => {});
        await live.adapter?.dispose();
      };
      const cleanup = await Promise.allSettled([invalidateResources(live), disposeAdapter()]);
      if (cleanup.some(result => result.status === 'rejected')) throw fail('cleanup_pending');
      if (live.adapter?.cleanupConfirmed && !live.adapter.cleanupConfirmed()) throw fail('cleanup_pending');
      leases.get(live.key)?.delete(live); if (!leases.get(live.key)?.size) leases.delete(live.key);
      if (lives.get(live.record.conversationId) === live) lives.delete(live.record.conversationId);
      if (focused === live.record.conversationId && !lives.has(live.record.conversationId)) { focused = null; contextRevision++; }
      touch(live);
      publish({ type: 'runtime_closed', backendInstance, owner: live.closedOwner, conversationId: live.record.conversationId, item: summary(live.record) });
      providerLifecycle();
    })().catch(e => { live.retirePromise = null; live.error = 'cleanup_pending';
      safeLog('runtime.cleanup_failed', { phase: 'retire', reason: 'cleanup_pending' });
      touch(live);
      publish({ type: 'runtime_state', owner: owner(live), item: summary(live.record) }); throw fail('cleanup_pending'); });
    return live.retirePromise;
  }
  function close(expected) {
    const live = resolve(expected, true);
    /* 关闭/重启**仍然可用**的 Runtime 会销毁事务的 RPC 通道与恢复能力；
     * 结果未知期间必须先经 recover 收口，不能靠关闭来“释放”锁。
     * 生命周期已经不是 ready（bridge 已退出，或身份回读失败）时，通道无法
     * 继续核对事务，允许用户显式关闭/重启；事务保持未确认，不会伪造成功。 */
    if (live.lifecycle === 'ready' && (live.editing || live.editTurn || live.editUnresolved)) throw fail('edit_in_progress');
    live.retired = true;
    return serialize(() => retire(live));
  }
  async function restart(expected) { const live = resolve(expected, true), id = live.record.conversationId; await close(expected); return resume(id); }
  async function invalidateWorkspace(id) {
    const targets = [...lives.values()].filter(l => l.record.workspace.workspaceId === id);
    if (targets.some(l => l.editing || l.editTurn || l.editUnresolved)) throw fail('edit_in_progress');
    const results = await Promise.allSettled(targets.map(l => retire(l)));
    if (results.some(r => r.status === 'rejected')) throw fail('cleanup_pending');
  }
  async function healthCheck() {
    for (const live of [...lives.values()]) {
      /* 健康检查是后台路径，不能顺手退掉一个仍有编辑事务的 Runtime。 */
      if (live.editing || live.editTurn || live.editUnresolved) continue;
      try { await validateWorkspace(live.record.workspace); } catch { await retire(live).catch(() => {}); }
    }
  }
  async function dispose() { disposed = true; await queue.catch(() => {}); const results = await Promise.allSettled([...lives.values()].map(retire)); if (results.some(r => r.status === 'rejected')) throw fail('cleanup_pending'); }
  function providerSyncTargets() {
    return [...lives.values()].filter(belongs).map(live => {
      const adapter = live.adapter;
      const expected = owner(live);
      const key = JSON.stringify(expected);
      const launch = adapter?.providerLaunch?.();
      const witness = state => state.sessionId === expected.sessionId && live.providerSessionIdentity
        ? adapter.providerSession(state, live.providerSessionIdentity) : null;
      return { id: expected.conversationId, kind: 'runtime', key, launch,
        ready: Boolean(expected.sessionId && live.lifecycle === 'ready' && launch),
        current: () => belongs(live) && key === JSON.stringify(owner(live)) && live.lifecycle === 'ready' &&
          adapter.providerLaunch() === launch && adapter.providerLaunchCurrent(launch),
        busy: () => live.activity !== 'idle' || live.approvals.size > 0 || adapter.updateBusy() || Boolean(adapter.getState().stop?.pending) ||
          adapter.managed.manager.snapshot().processes.some(process => !process.cleanupConfirmed),
        request: type => adapter.providerRead(type),
        async session(state) { await validateWorkspace(live.record.workspace); return witness(state); },
        witnessCurrent: runtimeWitnessCurrent,
      };
    });
  }
  return { start, openProjectSession, resume, close, restart, command, read, focus, blur, events, executionBranch, executionHistory,
    captureExecutionDetail, readExecutionDetail, snapshot, dispose, healthCheck, invalidateWorkspace, bindResource,
    editPreflight, editResend, editStatus, editRecover,
    providerSyncTargets,
    ownsNativeSession: id => Boolean(id) && [...lives.values()].some(l => l.sessionId === id || l.record.sessionId === id),
    contextRevision: () => contextRevision,
    inUse: root => leases.has(rootKey(root)), liveCount: () => lives.size, runningCount: () => [...lives.values()].filter(l => l.activity !== 'idle').length,
    busy: () => [...lives.values()].some(l => l.activity !== 'idle' || l.lifecycle !== 'ready' || l.editing || l.editTurn || l.editUnresolved),
    updateBusy: () => [...lives.values()].some(l => l.approvals.size || l.editing || l.editTurn || l.editUnresolved || l.adapter?.updateBusy?.()),
    async closeAll() { const results = await Promise.allSettled([...lives.values()].map(retire)); if (results.some(r => r.status === 'rejected')) throw fail('cleanup_pending'); },
    getAdapter: expected => resolve(expected).adapter, getOwner: id => lives.has(id) ? owner(lives.get(id)) : null,
    /* P32.4：只给**后端**用的历史定位 —— **不进 snapshot**，也不出现在任何 SSE 帧里。
     * locator 是绑定时已证明过的绝对路径；读历史只读它，不需要、也不接受
     * Renderer 传路径。这样 dormant 会话也能看历史而不必 spawn 一个 child。 */
    historyTarget: id => { guardStore(); const record = records.get(id); return record ? historyTarget(record) : null; },
    searchTargets: projectId => { guardStore(); return [...records.values()].filter(r => r.workspace.projectId === projectId && r.sessionLocator && r.sessionId).map(historyTarget); },
    /* 持久记录只提供身份，不能授权 Git 访问。实际 cwd/root 及 lifecycle lock
     * 由 P32.2 withWorkspace 验证和持有，dormant 会话也走同一 authority。 */
    workspaceIdentityOf: id => { guardStore(); const workspace = records.get(id)?.workspace;
      return workspace ? { id: workspace.workspaceId, epoch: workspace.workspaceEpoch } : null; } };

  function historyTarget(record) {
    const w = record.workspace;
    const title = titleFor(record);
    return { sessionId: record.sessionId || null, sessionLocator: record.sessionLocator || null,
      sessionIdentity: record.sessionIdentity || null, cwd: w.cwd,
      title: title.title, titleSource: title.source,
      titleRevision: Number.isSafeInteger(title.revision) ? title.revision : 0,
      createdAt: record.createdAt,
      locator: { projectId: w.projectId, workspaceId: w.workspaceId, workspaceEpoch: w.workspaceEpoch,
        conversationId: record.conversationId, nativeSessionId: record.sessionId || null } };
  }
}
