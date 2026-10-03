/* Bounded compensation for missed lifecycle events. No polling loop/restart. */
export function createBridgeRecovery({ readStatus, reconcile, overdue,
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id), delayMs = 10000 }) {
  let key = null, generation = 0, timers = [], inFlight = null;
  function clear() { for (const id of timers) cancel(id); timers = []; }
  async function probe() {
    if (inFlight) return inFlight;
    const expected = generation;
    inFlight = Promise.resolve().then(readStatus).then(snapshot => {
      if (expected === generation && snapshot && snapshot.ok !== false) reconcile(snapshot);
      return snapshot;
    }).catch(() => null).finally(() => { inFlight = null; });
    return inFlight;
  }
  function observe(snapshot) {
    const waiting = snapshot.hasProject && ['starting', 'restarting'].includes(snapshot.state || snapshot.bridgeState);
    const next = waiting ? `${snapshot.bridgeRun}:${snapshot.state || snapshot.bridgeState}` : null;
    if (next === key) return;
    key = next; generation++; clear();
    overdue(false);
    if (!waiting) return;
    // Initial read is performed by application startup; these two probes are
    // compensation only. Duplicate snapshots do not postpone the deadline.
    timers = [schedule(() => { overdue(true); probe(); }, delayMs),
      schedule(() => probe(), delayMs * 2)];
  }
  return { observe, probe, dispose() { generation++; clear(); } };
}
