import { normalizePlan, PLAN_TOOL_NAME } from './plan-model.js';
import {
  MAX_BLOCK_TEXT,
  MAX_THINKING_TEXT,
  MAX_TIMELINE_CHARS,
  MAX_TOOLS_PER_GROUP,
  MAX_BLOCKS,
  MAX_USER_TEXT,
  blockChars,
  boundText,
  contentText,
  contentThinking,
  timelineFromMessages,
} from './runtime-timeline.js';

const same = (a, b) => a && b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]);
function stableIdentity(item, owner) {
  const conversationId = item?.conversationId || owner?.conversationId;
  const itemWs = item?.workspace;
  if (itemWs && owner) {
    if (itemWs.projectId && owner.projectId && itemWs.projectId !== owner.projectId) return null;
    if (itemWs.workspaceId && owner.workspaceId && itemWs.workspaceId !== owner.workspaceId) return null;
    if (itemWs.workspaceEpoch && owner.workspaceEpoch && itemWs.workspaceEpoch !== owner.workspaceEpoch) return null;
  }
  const projectId = itemWs?.projectId || owner?.projectId;
  const workspaceId = itemWs?.workspaceId || owner?.workspaceId;
  const workspaceEpoch = itemWs?.workspaceEpoch || owner?.workspaceEpoch;
  if (item?.nativeSessionId && owner?.sessionId && item.nativeSessionId !== owner.sessionId) {
    return null; // 身份冲突
  }
  const nativeSessionId = item?.nativeSessionId || owner?.sessionId || null;
  return { conversationId, projectId, workspaceId, workspaceEpoch, nativeSessionId };
}
function isSameIdentity(prior, nextItem) {
  if (!prior || !nextItem) return false;
  const id1 = stableIdentity(prior.item, prior.owner);
  const id2 = stableIdentity(nextItem, nextItem.owner);
  if (!id1 || !id2) return false;
  if (id1.conversationId !== id2.conversationId) return false;
  if (id1.projectId !== id2.projectId || id1.workspaceId !== id2.workspaceId || id1.workspaceEpoch !== id2.workspaceEpoch) return false;
  if (id1.nativeSessionId && id1.nativeSessionId === id2.nativeSessionId) return true;
  if (!id1.nativeSessionId && id2.nativeSessionId) return true;
  if (!id1.nativeSessionId && !id2.nativeSessionId) return true;
  return false;
}
function canInheritDraft(prior, nextItem) {
  return Boolean(prior?.draft) && isSameIdentity(prior, nextItem);
}
export function createRuntimeStore({ limit = 1024 * 1024 } = {}) {
  let backend = null, resources = null, resourceReadSequence = 0; const records = new Map();
  let rejectObserver = null;
  const reject = (reason, extra = {}) => { try { rejectObserver?.(reason, extra); } catch { /* observation only */ } };
  const bound = text => {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length <= limit) return text;
    return new TextDecoder().decode(bytes.slice(-limit)).replace(/^�+/, '');
  };

  /* ---------- 有界执行时间线 ----------
   *
   * 为什么放在 store 里：owner / eventSequence / generation 的校验只在这里做。
   * 时间线如果由视图自己从 DOM 或工具计数重建，就绕过了这些校验，也无法证明
   * 计划、思考、工具、正文的真实先后。store 只保留可展示的最小 block，
   * 工具 args / result 正文仍不进入。
   */
  function fresh(item, baseRevision = 0) {
    return {
      item, owner: item.owner, cursor: 0, text: '', tools: [], plan: null, planCalls: new Map(),
      draft: '', draftRevision: baseRevision, approvals: [], truncated: false,
      timeline: [], timelineSeq: 0, timelineChars: 0, timelineTruncated: false,
      /* Pi 的回合边界：`agent_settled` 在整个 session 级 run 结束时发出（自动
       * 重试、压缩、steering/follow-up 都在它之前跑完）。下一次 `agent_start`
       * 若发生在 settled 之后，才是真正的新用户任务；运行中追加消息不会发
       * 新的 agent_start。不要用「看到一条 user 消息」当新回合判据。 */
      settled: true,
      assistant: null, planBlock: null, thinkingBlock: null,
    };
  }

  function recomputeTimelineChars(r) {
    r.timelineChars = r.timeline.reduce((sum, block) => sum + blockChars(block), 0);
  }

  function trimTimeline(r, keep) {
    const current = r.assistant;
    const protectedBlocks = new Set([keep, r.planBlock, r.thinkingBlock, current?.text, current?.thinking, current?.tools]);
    for (const block of [...(current?.texts || []), ...(current?.thinkings || []), ...(current?.toolGroups || [])]) protectedBlocks.add(block);
    while (r.timeline.length > MAX_BLOCKS || r.timelineChars > MAX_TIMELINE_CHARS) {
      let index = -1;
      for (let i = 0; i < r.timeline.length; i++) {
        if (!protectedBlocks.has(r.timeline[i])) { index = i; break; }
      }
      if (index < 0) break;
      const [removed] = r.timeline.splice(index, 1);
      r.timelineChars -= blockChars(removed);
      r.timelineTruncated = true;
    }
    if (r.timelineChars > MAX_TIMELINE_CHARS) r.timelineTruncated = true;
  }

  function appendBlock(r, block, keep = true) {
    block.id = 'b' + (++r.timelineSeq);
    r.timeline.push(block);
    r.timelineChars += blockChars(block);
    trimTimeline(r, keep ? block : null);
    return block;
  }

  function setTimelineText(r, block, text, max) {
    const before = blockChars(block);
    const bounded = boundText(text, max);
    block.text = bounded.text;
    block.truncated = block.truncated || bounded.truncated;
    r.timelineChars += blockChars(block) - before;
    trimTimeline(r, block);
  }

  function ensureAssistant(r) {
    if (!r.assistant) {
      r.assistant = { text: null, thinking: null, tools: null, tail: null, texts: [], thinkings: [], toolGroups: [] };
    }
    return r.assistant;
  }

  function resetAssistant(r) {
    r.assistant = null;
  }

  /* 实时 delta 的顺序就是 Pi 推送的真实顺序。`tail` 记录这条 assistant 消息
   * 最近写过的 block：正文/思考/工具交错出现时，各自另起一个新 block，而不是
   * 追加到更早的同类 block 上（那会把后来的正文挪到工具前面）。 */
  function assistantTextBlock(r) {
    const assistant = ensureAssistant(r);
    if (assistant.text && assistant.tail === assistant.text) return assistant.text;
    const block = { kind: 'assistant', text: '', state: 'streaming', truncated: false };
    assistant.text = block;
    assistant.texts.push(block);
    assistant.tail = block;
    appendBlock(r, block);
    return block;
  }

  /* 一条 assistant 消息只有一个 Thinking 段、一个工具批次（与 Classic 的
   * 「一条 assistant 消息中的连续 tool calls」同一分组口径）。delta 即使晚于
   * 正文到达，也回到本消息已有的段里，不能把用户展开的 Thinking/工具组拆成
   * 两个节点；位置仍取该段第一次真实出现的时刻。 */
  function assistantThinkingBlock(r) {
    const assistant = ensureAssistant(r);
    if (!assistant.thinking) {
      const block = { kind: 'thinking', text: '', state: 'streaming', truncated: false };
      assistant.thinking = block;
      assistant.thinkings.push(block);
      r.thinkingBlock = block;
      appendBlock(r, block);
    }
    assistant.tail = assistant.thinking;
    return assistant.thinking;
  }

  function assistantToolGroup(r) {
    const assistant = ensureAssistant(r);
    if (!assistant.tools) {
      const block = { kind: 'tools', tools: [], truncated: false };
      assistant.tools = block;
      assistant.toolGroups.push(block);
      appendBlock(r, block);
    }
    assistant.tail = assistant.tools;
    return assistant.tools;
  }

  /* message_end 的 content 是这条 assistant 消息的权威全文。流式期间如果
   * 正文/思考被工具或彼此分隔成多段，结束时把它们收回该类型的第一个 block，
   * 由权威文本覆盖；不能把权威全文重复写进每一段，也不能留下旧 delta 残片。 */
  function collapseAssistantBlocks(r, assistant, blocks, pointer) {
    if (!blocks.length) return null;
    const first = blocks[0];
    for (const block of blocks.slice(1)) {
      removeBlock(r, block);
      if (r.thinkingBlock === block) r.thinkingBlock = first;
    }
    blocks.length = 1;
    assistant[pointer] = first;
    if (!r.timeline.includes(assistant.tail)) assistant.tail = first;
    return first;
  }

  function findTimelineTool(r, id) {
    for (let i = r.timeline.length - 1; i >= 0; i--) {
      const block = r.timeline[i];
      if (block.kind !== 'tools') continue;
      const tool = block.tools.find(item => item.id === id);
      if (tool) return tool;
    }
    return null;
  }

  function stopRunningTools(r) {
    for (const tool of r.tools) if (['running', 'waiting'].includes(tool.state)) tool.state = 'interrupted';
    for (const block of r.timeline) {
      if (block.kind === 'thinking' && block.state === 'streaming') block.state = 'interrupted';
      if (block.kind !== 'tools') continue;
      for (const tool of block.tools) {
        if (!['running', 'waiting'].includes(tool.state)) continue;
        tool.state = 'interrupted';
        tool.waiting = false;
      }
    }
  }

  function setPlanBlock(r, block, plan) {
    if (!block) return;
    const before = blockChars(block);
    block.plan = plan;
    r.timelineChars += blockChars(block) - before;
    trimTimeline(r, block);
  }

  function removeBlock(r, block) {
    const index = r.timeline.indexOf(block);
    if (index < 0) return;
    r.timeline.splice(index, 1);
    r.timelineChars -= blockChars(block);
  }

  function applyPlanStart(r, event) {
    const callId = event.toolCallId;
    const prior = r.plan;
    const priorBlock = r.planBlock || null;
    const call = { plan: prior, block: priorBlock, createdBlock: null };
    if (callId) {
      r.planCalls.set(callId, call);
      if (r.planCalls.size > 16) r.planCalls.delete(r.planCalls.keys().next().value);
    }
    const plan = normalizePlan(event.plan);
    if (!plan) return;
    if (!r.planBlock) {
      const block = appendBlock(r, { kind: 'plan', plan });
      r.planBlock = block;
      call.createdBlock = block;
    } else {
      setPlanBlock(r, r.planBlock, plan);
    }
    r.plan = plan;
  }

  function applyPlanEnd(r, event) {
    const callId = event.toolCallId;
    const call = callId ? r.planCalls.get(callId) : null;
    const plan = normalizePlan(event.plan);
    if (plan) {
      if (!r.planBlock) r.planBlock = appendBlock(r, { kind: 'plan', plan });
      else setPlanBlock(r, r.planBlock, plan);
      r.plan = plan;
      if (callId) r.planCalls.delete(callId);
      return;
    }
    if (!call) return;
    if (callId) r.planCalls.delete(callId);
    /* 扩展明确拒绝（或没有返回有效 details）：回到本次调用前的真实状态。
     * 本次调用新建的乐观卡片必须删掉；上一张计划必须恢复。 */
    r.plan = call.plan;
    if (call.plan) {
      if (!r.planBlock) r.planBlock = appendBlock(r, { kind: 'plan', plan: call.plan });
      else setPlanBlock(r, r.planBlock, call.plan);
    } else {
      if (call.createdBlock) removeBlock(r, call.createdBlock);
      r.planBlock = null;
    }
  }

  function clearCurrentPlan(r) {
    r.plan = null; r.planCalls.clear(); r.planBlock = null;
  }

  function seed(snapshot) {
    if (!snapshot || snapshot.ok === false || typeof snapshot.backendInstance !== 'string' || !Array.isArray(snapshot.items)) return false;
    const sequence = snapshot._runtimeReadSequence;
    if (Number.isInteger(sequence)) {
      if (sequence < resourceReadSequence) { reject('stale_snapshot'); return false; }
      resourceReadSequence = sequence;
    }
    if (snapshot.backendInstance !== backend) { records.clear(); resources = null; backend = snapshot.backendInstance; }
    // Only complete authoritative snapshots update occupancy. SSE items cannot
    // prove that cleanup finished, or account for the classic external child.
    if (['liveCount', 'totalCount', 'limit', 'hardLimit'].every(k => Number.isInteger(snapshot[k]) && snapshot[k] >= 0)) {
      resources = { liveCount: snapshot.liveCount, totalCount: snapshot.totalCount, limit: snapshot.limit, hardLimit: snapshot.hardLimit };
    }
    for (const item of snapshot.items || []) {
      const prior = records.get(item.conversationId);
      if (prior && Number.isInteger(item.revision) && item.revision < (prior.item.revision || 0)) { reject('stale_revision'); continue; }
      // 两次没有 owner 的快照仍是同一条关闭记录；只读资源预检不能换掉它。
      const ownerUnchanged = prior && (prior.owner === item.owner || same(prior.owner, item.owner));
      if (!ownerUnchanged) {
        if (prior?.owner && item.owner && prior.owner.runtimeId === item.owner.runtimeId && prior.owner.runtimeGeneration === item.owner.runtimeGeneration) {
          if (prior.owner.sessionId && !item.owner.sessionId) continue;
          if (!isSameIdentity(prior, item)) {
            prior.draft = '';
            prior.draftRevision = (prior.draftRevision || 0) + 1;
          }
          prior.owner = item.owner; prior.item = item;
        } else {
          const sameIdentity = prior && isSameIdentity(prior, item);
          const nextRevision = prior ? (sameIdentity ? prior.draftRevision : (prior.draftRevision || 0) + 1) : 0;
          const next = fresh(item, nextRevision);
          if (sameIdentity) {
            next.draft = prior.draft;
          }
          records.set(item.conversationId, next);
        }
      } else {
        if (prior && !isSameIdentity(prior, item)) {
          prior.draft = '';
          prior.draftRevision = (prior.draftRevision || 0) + 1;
        }
        prior.item = item;
      }
    }
    return true;
  }
  function applyDetailed(frame) {
    if (frame._replay) { reject('replay'); return { ok: false, reason: 'replay' }; }
    if (frame.type === 'runtime_state' && frame.owner?.backendInstance === backend) {
      const record = records.get(frame.owner.conversationId);
      if (!record) { reject('unknown_conversation'); return { ok: false, reason: 'unknown_conversation' }; }
      if (record.owner && (record.owner.runtimeId !== frame.owner.runtimeId || record.owner.runtimeGeneration !== frame.owner.runtimeGeneration)
        && !(Number.isInteger(frame.item?.revision) && frame.item.revision > (record.item.revision || 0))) {
        reject('stale_generation');
        return { ok: false, reason: 'stale_generation' };
      }
      seed({ backendInstance: backend, items: [frame.item] }); return { ok: true };
    }
    if (frame.type === 'runtime_closed' && frame.backendInstance === backend) {
      const r = records.get(frame.conversationId);
      if (!r || !r.owner || r.owner.runtimeId !== frame.owner?.runtimeId || r.owner.runtimeGeneration !== frame.owner?.runtimeGeneration) {
        reject('closed_owner_mismatch');
        return { ok: false, reason: 'closed_owner_mismatch' };
      }
      r.item = frame.item; r.owner = null; r.approvals = [];
      stopRunningTools(r);
      r.settled = true;
      return { ok: true };
    }
    if (frame.type !== 'runtime_event' || frame.owner?.backendInstance !== backend) {
      reject('backend_mismatch');
      return { ok: false, reason: 'backend_mismatch' };
    }
    const r = records.get(frame.owner.conversationId);
    if (!r || !same(r.owner, frame.owner)) {
      reject('owner_mismatch');
      return { ok: false, reason: 'owner_mismatch' };
    }
    if (frame.eventSequence <= r.cursor) {
      reject('sequence_not_advanced', { sequenceGap: 0 });
      return { ok: false, reason: 'sequence_not_advanced' };
    }
    if (frame.eventSequence > r.cursor + 1) r.truncated = true;
    r.cursor = frame.eventSequence; const e = frame.event;

    /* ---------- 回合边界：只认 Pi 的真实 agent_start / agent_settled ---------- */
    if (e.type === 'agent_start') {
      /* 上一轮已 settled → 本次是新的 session 级 run（真正的新任务），
       * 旧计划卡片留在时间线里，但「当前计划」从这里切换。
       * 上一轮未 settled → 同一任务内的重试/压缩/继续，不得清计划。 */
      if (r.settled !== false) clearCurrentPlan(r);
      r.settled = false;
    }
    if (e.type === 'agent_settled') r.settled = true;

    if (e.type === 'message_start' && e.message?.role === 'assistant') {
      /* 新的 assistant 消息 = 上一条消息的工具批次结束。 */
      r.text += '\n';
      resetAssistant(r);
      r.thinkingBlock = null;
    }
    if (e.type === 'message_start' && e.message?.role === 'user') {
      /* 运行中的 steer / follow-up 也走 message_start user，但不会发新的
       * agent_start（已核对 pi 1.5 的 runAgentLoop / runLoop），因此这里
       * 只记录用户输入，**不**切换计划。计划切换只发生在 agent_start 的真实
       * 任务边界（见上）。 */
      resetAssistant(r);
      const bounded = boundText(contentText(e.message.content), MAX_USER_TEXT);
      if (bounded.text) appendBlock(r, { kind: 'user', text: bounded.text, truncated: bounded.truncated });
    }
    if (e.type === 'message_update') {
      const update = e.assistantMessageEvent;
      if (update?.type === 'text_delta' && typeof update.delta === 'string' && update.delta) {
        r.text += update.delta;
        const block = assistantTextBlock(r);
        setTimelineText(r, block, block.text + update.delta, MAX_BLOCK_TEXT);
      } else if (update?.type === 'thinking_delta' && typeof update.delta === 'string' && update.delta) {
        const block = assistantThinkingBlock(r);
        block.state = 'streaming';
        setTimelineText(r, block, block.text + update.delta, MAX_THINKING_TEXT);
      } else if (update?.type === 'thinking_end' && typeof update.content === 'string') {
        const block = assistantThinkingBlock(r);
        block.state = 'returned';
        setTimelineText(r, block, update.content, MAX_THINKING_TEXT);
      }
    }
    if (e.type === 'message_end' && e.message?.role === 'assistant') {
      const message = e.message;
      const state = message.stopReason === 'aborted' ? 'interrupted'
        : message.stopReason === 'error' || message.errorMessage ? 'error' : 'complete';
      const assistant = r.assistant;
      const textState = state;
      const thinkingState = state === 'interrupted' ? 'interrupted' : state === 'error' ? 'error' : 'complete';
      const authoritativeText = contentText(message.content);
      if (authoritativeText) {
        const existing = assistant?.texts || [];
        const block = existing.length
          ? (existing.length > 1 ? collapseAssistantBlocks(r, assistant, existing, 'text') : existing[0])
          : assistantTextBlock(r);
        block.state = textState;
        setTimelineText(r, block, authoritativeText, MAX_BLOCK_TEXT);
      } else if (assistant?.texts.length) {
        for (const block of assistant.texts) block.state = textState;
      }
      const authoritativeThinking = contentThinking(message.content);
      if (authoritativeThinking) {
        const existing = assistant?.thinkings || [];
        const block = existing.length
          ? (existing.length > 1 ? collapseAssistantBlocks(r, assistant, existing, 'thinking') : existing[0])
          : assistantThinkingBlock(r);
        block.state = thinkingState;
        r.thinkingBlock = block;
        setTimelineText(r, block, authoritativeThinking, MAX_THINKING_TEXT);
      } else if (assistant?.thinkings.length) {
        for (const block of assistant.thinkings) block.state = thinkingState;
      }
    }
    /* ---------- 计划：同一回合只有一张卡；拒绝时回到上一张 ---------- */
    if (e.type === 'tool_execution_start' && (e.toolName === PLAN_TOOL_NAME || e.plan)) {
      applyPlanStart(r, e);
    }
    if (e.type === 'tool_execution_end' && (e.plan || r.planCalls.has(e.toolCallId))) {
      applyPlanEnd(r, e);
    }
    /* ---------- 普通工具：按真实事件顺序进入当前 assistant 消息的组 ---------- */
    if (e.type === 'tool_execution_start' && e.toolName !== PLAN_TOOL_NAME) {
      r.tools.push({ id: e.toolCallId, name: e.toolName, state: 'running' });
      if (r.tools.length > 100) r.tools.shift();
      const group = assistantToolGroup(r);
      if (group.tools.length >= MAX_TOOLS_PER_GROUP) group.truncated = true;
      else {
        group.tools.push({ id: e.toolCallId, name: e.toolName, state: 'running', waiting: false, durationMs: null });
        r.timelineChars += 24;
        trimTimeline(r, group);
      }
    }
    if (e.type === 'tool_execution_end') {
      const flat = r.tools.find(t => t.id === e.toolCallId);
      if (flat) flat.state = e.isError ? 'error' : 'done';
      const tool = findTimelineTool(r, e.toolCallId);
      if (tool) {
        tool.state = e.isError ? 'error' : 'success';
        tool.waiting = false;
        if (Number.isFinite(e.durationMs) && e.durationMs >= 0) tool.durationMs = Math.min(e.durationMs, 24 * 60 * 60 * 1000);
      }
    }
    if (e.type === 'tool_wait_state') {
      const flat = r.tools.find(t => t.id === e.toolCallId);
      if (flat && ['running', 'waiting'].includes(flat.state)) flat.state = e.waiting ? 'waiting' : 'running';
      const tool = findTimelineTool(r, e.toolCallId);
      if (tool && ['running', 'waiting'].includes(tool.state)) {
        tool.state = e.waiting ? 'waiting' : 'running';
        tool.waiting = e.waiting === true;
      }
    }
    if (e.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(e.method)) {
      r.approvals.push({ id: e.id, method: e.method, title: String(e.title || '').slice(0, 1024), options: Array.isArray(e.options) ? e.options.slice(0, 100).map(String) : [] });
      if (r.approvals.length > 32) r.approvals.shift();
    }
    if (e.type === 'agent_settled' || e.type === 'bridge_status' && e.state !== 'ready' || e.type === 'stop_state' && e.pending === false) {
      r.approvals = [];
      stopRunningTools(r);
      if (r.assistant?.thinking?.state === 'streaming') r.assistant.thinking.state = 'interrupted';
      if (e.type === 'agent_settled') r.settled = true;
    }
    const bounded = bound(r.text); if (bounded !== r.text) { r.text = bounded; r.truncated = true; }
    return { ok: true };
  }
  function apply(frame) { return applyDetailed(frame).ok; }

  function cloneBlock(block) {
    if (block.kind === 'tools') return { ...block, tools: block.tools.map(tool => ({ ...tool })) };
    if (block.kind === 'plan') return { ...block, plan: block.plan ? { ...block.plan, tasks: block.plan.tasks.map(task => ({ ...task })) } : null };
    return { ...block };
  }

  function setHistoryTimeline(r, timeline, truncated) {
    const list = Array.isArray(timeline) ? timeline.filter(block => block && typeof block.kind === 'string') : [];
    const bounded = [];
    for (const block of list) {
      if (block.kind === 'user' || block.kind === 'assistant' || block.kind === 'thinking') {
        if (typeof block.text !== 'string' || !block.text) continue;
      } else if (block.kind === 'tools') {
        if (!Array.isArray(block.tools) || !block.tools.length) continue;
      } else if (block.kind === 'plan') {
        if (!normalizePlan(block.plan)) continue;
      } else continue;
      bounded.push(cloneBlock(block));
    }
    r.timeline = bounded.map((block, index) => ({ ...block, id: 'h' + (index + 1) }));
    r.timelineSeq = bounded.length;
    recomputeTimelineChars(r);
    r.timelineTruncated = truncated === true;
    r.assistant = null;
    r.planBlock = null;
    r.thinkingBlock = null;
    trimTimeline(r, null);
    const planBlocks = r.timeline.filter(block => block.kind === 'plan');
    r.planBlock = planBlocks.length ? planBlocks[planBlocks.length - 1] : null;
    r.plan = r.planBlock?.plan || null;
    const thinkingBlocks = r.timeline.filter(block => block.kind === 'thinking');
    r.thinkingBlock = thinkingBlocks.length ? thinkingBlocks[thinkingBlocks.length - 1] : null;
    r.planCalls.clear();
    const tools = [];
    for (const block of r.timeline) {
      if (block.kind !== 'tools') continue;
      for (const tool of block.tools) {
        tools.push({ id: tool.id, name: tool.name, state: tool.state === 'success' ? 'done' : tool.state === 'incomplete' ? 'interrupted' : tool.state });
      }
    }
    r.tools = tools.slice(-100);
    r.settled = true;
    trimTimeline(r, null);
  }

  return { seed, apply, applyDetailed, resources: () => resources && { ...resources }, get: id => records.get(id), values: () => [...records.values()],
    setRejectObserver(fn) { rejectObserver = typeof fn === 'function' ? fn : null; },
    reconcileApprovals(owner, approvals, cursor) {
      const r = records.get(owner?.conversationId);
      if (!r || !same(r.owner, owner) || r.cursor > cursor || !Array.isArray(approvals)) return false;
      const live = new Set(approvals.map(a => a.id));
      r.approvals = r.approvals.filter(a => live.has(a.id));
      for (const a of approvals) if (!r.approvals.some(old => old.id === a.id)) r.approvals.push({ id: a.id, method: a.method, title: String(a.title || '').slice(0, 1024), options: Array.isArray(a.options) ? a.options.slice(0, 100).map(String) : [] });
      return true;
    },
    beginApproval(owner, approval) {
      const r = records.get(owner?.conversationId);
      if (!r || !same(r.owner, owner) || !r.approvals.includes(approval) || approval.submitting) return false;
      approval.submitting = true; return true;
    },
    finishApproval(owner, approval, success) {
      const r = records.get(owner?.conversationId);
      if (!r || !r.approvals.includes(approval)) return;
      // 同一代 runtime 补齐 sessionId 时仍可能保留此对象；只释放旧请求的 pending，
      // 不把旧 owner 的成功当成新 owner 的审批完成。
      if (success && same(r.owner, owner)) r.approvals = r.approvals.filter(a => a !== approval);
      else delete approval.submitting;
    },
    history(id, messages, expectedOwner, expectedCursor, execution = null) {
      const r = records.get(id);
      if (!r || !same(r.owner, expectedOwner) || r.cursor !== expectedCursor) return false;
      const list = Array.isArray(messages) ? messages : [];
      const text = list.filter(m => ['user', 'assistant'].includes(m.role)).map(m => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'text').map(c => c.text || '').join('')).join('\n\n');
      r.text = bound(text); if (r.text !== text) r.truncated = true;
      const projected = execution?.timeline;
      if (Array.isArray(projected)) {
        setHistoryTimeline(r, projected, execution.truncated === true);
      } else {
        /* get_messages 的原生消息同样走 timelineFromMessages，保持与只读历史
         * 同一条投影路径；没有 toolResult 时它只会退化成正文，不会编造工具。 */
        const built = timelineFromMessages(list);
        setHistoryTimeline(r, built.blocks, built.truncated);
      }
      return true;
    },
  };
}
