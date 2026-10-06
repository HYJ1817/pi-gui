const same = (a, b) => a && b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]);
export function createRuntimeStore({ limit = 1024 * 1024 } = {}) {
  let backend = null; const records = new Map();
  const bound = text => {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length <= limit) return text;
    return new TextDecoder().decode(bytes.slice(-limit)).replace(/^\uFFFD+/, '');
  };
  function fresh(item) { return { item, owner: item.owner, cursor: 0, text: '', tools: [], draft: '', approvals: [], truncated: false }; }
  function seed(snapshot) {
    if (snapshot.backendInstance !== backend) { records.clear(); backend = snapshot.backendInstance; }
    for (const item of snapshot.items || []) {
      const prior = records.get(item.conversationId);
      if (prior && Number.isInteger(item.revision) && item.revision < (prior.item.revision || 0)) continue;
      if (!prior || !same(prior.owner, item.owner)) {
        if (prior?.owner && item.owner && prior.owner.runtimeId === item.owner.runtimeId && prior.owner.runtimeGeneration === item.owner.runtimeGeneration) {
          if (prior.owner.sessionId && !item.owner.sessionId) continue;
          prior.owner = item.owner; prior.item = item;
        } else { const next = fresh(item); if (prior) next.draft = prior.draft; records.set(item.conversationId, next); }
      } else prior.item = item;
    }
  }
  function apply(frame) {
    if (frame._replay) return false;
    if (frame.type === 'runtime_state' && frame.owner?.backendInstance === backend) {
      const record = records.get(frame.owner.conversationId);
      if (!record) return false;
      if (record.owner && (record.owner.runtimeId !== frame.owner.runtimeId || record.owner.runtimeGeneration !== frame.owner.runtimeGeneration)
        && !(Number.isInteger(frame.item?.revision) && frame.item.revision > (record.item.revision || 0))) return false;
      seed({ backendInstance: backend, items: [frame.item] }); return true;
    }
    if (frame.type === 'runtime_closed' && frame.backendInstance === backend) {
      const r = records.get(frame.conversationId);
      if (!r || !r.owner || r.owner.runtimeId !== frame.owner?.runtimeId || r.owner.runtimeGeneration !== frame.owner?.runtimeGeneration) return false;
      r.item = frame.item; r.owner = null; r.approvals = []; return true;
    }
    if (frame.type !== 'runtime_event' || frame.owner?.backendInstance !== backend) return false;
    const r = records.get(frame.owner.conversationId);
    if (!r || !same(r.owner, frame.owner) || frame.eventSequence <= r.cursor) return false;
    if (frame.eventSequence > r.cursor + 1) r.truncated = true;
    r.cursor = frame.eventSequence; const e = frame.event;
    if (e.type === 'message_start' && e.message?.role === 'assistant') r.text += '\n';
    if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') r.text += e.assistantMessageEvent.delta || '';
    if (e.type === 'tool_execution_start') { r.tools.push({ id: e.toolCallId, name: e.toolName, state: 'running' }); if (r.tools.length > 100) r.tools.shift(); }
    if (e.type === 'tool_execution_end') { const t = r.tools.find(t => t.id === e.toolCallId); if (t) t.state = e.isError ? 'error' : 'done'; }
    if (e.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(e.method)) {
      r.approvals.push({ id: e.id, method: e.method, title: String(e.title || '').slice(0, 1024), options: Array.isArray(e.options) ? e.options.slice(0, 100).map(String) : [] });
      if (r.approvals.length > 32) r.approvals.shift();
    }
    if (e.type === 'agent_settled' || e.type === 'bridge_status' && e.state !== 'ready') r.approvals = [];
    const bounded = bound(r.text); if (bounded !== r.text) { r.text = bounded; r.truncated = true; }
    return true;
  }
  return { seed, apply, get: id => records.get(id), values: () => [...records.values()],
    history(id, messages, expectedOwner, expectedCursor) { const r = records.get(id); if (!r || !same(r.owner, expectedOwner) || r.cursor !== expectedCursor) return false;
      const text = (messages || []).filter(m => ['user', 'assistant'].includes(m.role)).map(m => (m.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('')).join('\n\n');
      r.text = bound(text); if (r.text !== text) r.truncated = true; return true; },
  };
}
