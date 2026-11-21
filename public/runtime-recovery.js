/* Reconnect/reload only reads captured owners. Replayed approvals are reconciled
 * against backend pending state; no response, Stop, resume or prompt is sent. */
export function createRuntimeRecovery({ readSnapshot, read, seed, store, observe, executionCursor = () => null,
  executionReplay = () => {}, changed = () => {}, failed = () => {} }) {
  let pending = null;
  const same = (a, b) => a && b && Object.keys(a).every(key => a[key] === b[key]) && Object.keys(b).every(key => a[key] === b[key]);
  async function restore(record) {
    const fresh = record.cursor === 0;
    const owner = { ...record.owner }, id = owner.conversationId;
    const p5Cursor = executionCursor(owner);
    const result = await read({ action: 'events', owner, cursor: p5Cursor === null ? record.cursor : Math.min(record.cursor, p5Cursor) });
    if (!result?.ok || !same(store.get(id)?.owner, owner) || !same(result.owner, owner)) return;
    for (const frame of result.events || []) observe(frame);
    if (!same(store.get(id)?.owner, owner)) return;
    try { executionReplay(result); } catch { /* observation only */ }
    store.reconcileApprovals(owner, result.approvals, result.cursor);
    // If the bounded event ring missed body chunks, use Pi's native messages.
    // Cursor equality refuses a history response overtaken by newer streaming.
    const current = store.get(id);
    if (!current || !same(current.owner, owner)) return;
    if (fresh || result.historyRequired || current?.truncated) {
      const cursor = current.cursor;
      const branchEpoch = current.item.execution?.branchEpoch;
      if (Number.isSafeInteger(branchEpoch) && owner.sessionId) {
        const serverCursor = result.cursor;
        const expected = { owner, cursor, serverCursor, branchEpoch, revision: current.item.revision,
          idleItem: Array.isArray(result.approvals) && !result.approvals.length ? result.item : null };
        if (store.canRecoverExecutionHistory(current, expected)) {
          const history = await read({ action: 'execution-history', owner });
          if (!store.recoverExecutionHistory(current, expected, history) && store.canRecoverExecutionHistory(current, expected)) {
            const legacy = await read({ action: 'read', owner, command: { type: 'get_messages' } });
            if (legacy?.ok && store.canRecoverExecutionHistory(current, expected)) {
              // get_messages has no cursor of its own. Recheck the authoritative
              // cut before using the legacy body so in-flight work cannot be replaced.
              const confirmed = await read({ action: 'events', owner, cursor: serverCursor });
              if (confirmed?.ok && same(confirmed.owner, owner) && confirmed.cursor === serverCursor
                  && confirmed.item?.execution?.branchEpoch === branchEpoch
                  && confirmed.item.lifecycle === 'ready' && confirmed.item.activity === 'idle'
                  && Array.isArray(confirmed.approvals) && !confirmed.approvals.length) {
                store.recoverLegacyExecutionHistory(current, { ...expected, idleItem: confirmed.item }, legacy.data?.messages || []);
              }
            }
          }
        }
      } else {
        const history = await read({ action: 'read', owner, command: { type: 'get_messages' } });
        if (history?.ok) store.history(id, history.data?.messages || [], owner, cursor);
      }
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
