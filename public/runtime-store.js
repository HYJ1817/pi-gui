import { PLAN_TOOL_NAME } from './plan-model.js';

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
    return new TextDecoder().decode(bytes.slice(-limit)).replace(/^\uFFFD+/, '');
  };
  function fresh(item, baseRevision = 0) { return { item, owner: item.owner, cursor: 0, text: '', tools: [], plan: null, planCalls: new Map(), draft: '', draftRevision: baseRevision, approvals: [], truncated: false }; }
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
      for (const tool of r.tools) if (['running','waiting'].includes(tool.state)) tool.state = 'interrupted';
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
    if (e.type === 'message_start' && e.message?.role === 'assistant') r.text += '\n';
    if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') r.text += e.assistantMessageEvent.delta || '';
    /* 新的用户消息 = 上一轮任务列表到此为止。用 message_start 而不是
     * agent_start：自动重试也会再次发 agent_start，那样会把同一轮的计划清掉。 */
    if (e.type === 'message_start' && e.message?.role === 'user') { r.plan = null; r.planCalls.clear(); }
    /* 服务端已按 plan-projection.js 的白名单收窄；store 只做有界展示。
     * 计划工具本身不进工具行，否则同一件事会出现两次。
     *
     * start 时先记住上一张计划；如果 end 没有 plan（扩展明确拒绝 invalid_plan，
     * 服务端不会放行 details.error），就退回上一张，和 Classic 的 plan-live
     * 语义一致。不能把一次被拒绝的乐观列表留在界面上。 */
    if (e.type === 'tool_execution_start' && (e.toolName === PLAN_TOOL_NAME || e.plan)) {
      r.planCalls.set(e.toolCallId, r.plan);
      if (r.planCalls.size > 16) r.planCalls.delete(r.planCalls.keys().next().value);
      if (e.plan) r.plan = e.plan;
    }
    if (e.type === 'tool_execution_end') {
      if (e.plan) r.plan = e.plan;
      else if (r.planCalls.has(e.toolCallId)) r.plan = r.planCalls.get(e.toolCallId);
      r.planCalls.delete(e.toolCallId);
    }
    if (e.type === 'tool_execution_start' && e.toolName !== PLAN_TOOL_NAME) { r.tools.push({ id: e.toolCallId, name: e.toolName, state: 'running' }); if (r.tools.length > 100) r.tools.shift(); }
    if (e.type === 'tool_execution_end') { const t = r.tools.find(t => t.id === e.toolCallId); if (t) t.state = e.isError ? 'error' : 'done'; }
    if (e.type === 'tool_wait_state') { const t=r.tools.find(t=>t.id===e.toolCallId); if(t&&['running','waiting'].includes(t.state))t.state=e.waiting?'waiting':'running'; }
    if (e.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(e.method)) {
      r.approvals.push({ id: e.id, method: e.method, title: String(e.title || '').slice(0, 1024), options: Array.isArray(e.options) ? e.options.slice(0, 100).map(String) : [] });
      if (r.approvals.length > 32) r.approvals.shift();
    }
    if (e.type === 'agent_settled' || e.type === 'bridge_status' && e.state !== 'ready' || e.type === 'stop_state' && e.pending === false) {
      r.approvals = [];
      for (const tool of r.tools) if (['running','waiting'].includes(tool.state)) tool.state = 'interrupted';
    }
    const bounded = bound(r.text); if (bounded !== r.text) { r.text = bounded; r.truncated = true; }
    return { ok: true };
  }
  function apply(frame) { return applyDetailed(frame).ok; }
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
    history(id, messages, expectedOwner, expectedCursor) { const r = records.get(id); if (!r || !same(r.owner, expectedOwner) || r.cursor !== expectedCursor) return false;
      const text = (messages || []).filter(m => ['user', 'assistant'].includes(m.role)).map(m => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'text').map(c => c.text || '').join('')).join('\n\n');
      r.text = bound(text); if (r.text !== text) r.truncated = true; return true; },
  };
}
