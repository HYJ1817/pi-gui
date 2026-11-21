'use strict';

const TYPES = Object.freeze({ keepAwake: 'prevent-app-suspension', preventDisplaySleep: 'prevent-display-sleep' });

// Independent native IDs; Electron arbitrates display > app priority. Even a
// failed operation for one setting must not start or stop the other one's ID.
function createSystemPower({ powerSaveBlocker } = {}) {
  const ids = new Map();
  const supported = !!powerSaveBlocker && ['start', 'stop', 'isStarted'].every(key => typeof powerSaveBlocker[key] === 'function');
  function active(key) {
    const id = ids.get(key);
    return id !== undefined && powerSaveBlocker.isStarted(id);
  }
  function snapshot() {
    return Object.fromEntries(Object.keys(TYPES).map(key => {
      try { return [key, active(key)]; } catch { return [key, null]; }
    }));
  }
  function set(key, enabled) {
    if (!Object.hasOwn(TYPES, key)) throw Error('invalid_power_setting');
    if (!supported && enabled) throw Error('power_unavailable');
    if (active(key) === enabled) return;
    if (enabled) {
      const id = powerSaveBlocker.start(TYPES[key]);
      if (!Number.isInteger(id) || id < 0) throw Error('power_start_failed');
      // Record ownership before a potentially failing confirmation, so rollback
      // and dispose can still release the ID.
      ids.set(key, id);
      if (!active(key)) throw Error('power_start_failed');
    } else {
      powerSaveBlocker.stop(ids.get(key));
      if (active(key)) throw Error('power_stop_failed');
      ids.delete(key);
    }
  }
  function dispose() {
    for (const [key, id] of ids) {
      try { powerSaveBlocker.stop(id); } catch { /* Electron releases every ID at process exit. */ }
      ids.delete(key);
    }
  }
  return { supported, set, snapshot, dispose };
}
module.exports = { createSystemPower, TYPES };
