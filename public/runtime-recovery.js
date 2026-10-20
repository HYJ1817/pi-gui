/* Reconnect/reload only reads captured owners. Replayed approvals are reconciled
 * against backend pending state; no response, Stop, resume or prompt is sent. */
export function createRuntimeRecovery({ readSnapshot, read, seed, store, observe, changed = () => {}, failed = () => {} }) {
  let pending = null;
  const same = (a, b) => a && b && Object.keys(a).every(key => a[key] === b[key]) && Object.keys(b).every(key => a[key] === b[key]);
  async function restore(record) {
    const fresh = record.cursor === 0;
    const owner = { ...record.owner }, id = owner.conversationId;
    const result = await read({ action: 'events', owner, cursor: record.cursor });
    if (!result?.ok || !same(store.get(id)?.owner, owner) || !same(result.owner, owner)) return;
    for (const frame of result.events || []) observe(frame);
    if (!same(store.get(id)?.owner, owner)) return;
    store.reconcileApprovals(owner, result.approvals, result.cursor);
    // If the bounded event ring missed body chunks, use Pi's native messages.
    // Cursor equality refuses a history response overtaken by newer streaming.
    if (fresh || result.historyRequired || store.get(id)?.truncated) {
      const cursor = store.get(id).cursor;
      const history = await read({ action: 'read', owner, command: { type: 'get_messages' } });
      if (history?.ok) store.history(id, history.data?.messages || [], owner, cursor);
    }
    changed();
  }
  return () => {
    if (pending) return pending;
    pending = (async () => {
      const snapshot = await readSnapshot();
      if (snapshot?.ok === false || !Array.isArray(snapshot?.items)) return;
      seed(snapshot);
      const results = await Promise.allSettled(store.values().filter(record => record.owner).map(restore));
      if (results.some(result => result.status === 'rejected')) failed();
    })().catch(failed).finally(() => { pending = null; });
    return pending;
  };
}
