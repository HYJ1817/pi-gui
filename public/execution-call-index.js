// Upstream can send an end frame with only the call ID. Keep a bounded exact
// window of retired IDs, separate from values held by genuinely active calls.
const RETIRED_LIMIT = 4096;

export function createExecutionCallIndex(activeLimit) {
  const active = new Map();
  const retired = new Map();

  function retire(id) {
    active.delete(id);
    if (retired.has(id)) return;
    if (retired.size >= RETIRED_LIMIT) retired.delete(retired.keys().next().value);
    retired.set(id, null);
  }

  return {
    begin(id, value) {
      if (active.has(id)) {
        retire(id);
        return 'conflict';
      }
      if (retired.has(id)) return 'retired';
      if (active.size >= activeLimit) {
        retire(id);
        return 'overflow';
      }
      active.set(id, value);
      return 'started';
    },
    get: id => active.get(id),
    isRetired: id => retired.has(id),
    claimRetired(id, turnId) {
      if (!retired.has(id) || retired.get(id) === turnId) return false;
      retired.set(id, turnId);
      return true;
    },
    retire,
    retireAll(onRetire) {
      for (const [id, value] of active) {
        retire(id);
        onRetire?.(id, value);
      }
    },
    reset() {
      active.clear();
      retired.clear();
    },
  };
}
