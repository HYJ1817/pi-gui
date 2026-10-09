import fs from 'node:fs';
import path from 'node:path';

const fail = code => { throw Object.assign(Error(code), { code }); };
/** A filesystem-root gate, deliberately independent of session identities. */
export function createSessionRevertAdmission({ timeoutMs = 60000 } = {}) {
  const roots = new Map();
  const keyOf = root => {
    if (!root || !path.isAbsolute(root)) fail('stale_workspace');
    const value = fs.realpathSync.native(root);
    return process.platform === 'win32' ? value.toLowerCase() : value;
  };
  const stateOf = key => { let state = roots.get(key); if (!state) roots.set(key, state = { lease: null, writers: new Set(), waiters: new Set() }); return state; };
  const cleanup = (key, state) => { if (!state.lease && !state.writers.size && !state.waiters.size) roots.delete(key); };
  return {
    keyOf,
    assertAllowed(root) { if (roots.get(keyOf(root))?.lease) fail('workspace_revert_busy'); },
    enterWriter(root) {
      const key = keyOf(root), state = stateOf(key);
      if (state.lease) fail('workspace_revert_busy');
      const writer = {}; state.writers.add(writer); let released = false;
      return () => { if (released) return; released = true; state.writers.delete(writer); for (const wake of state.waiters) wake(); cleanup(key, state); };
    },
    acquire(root) {
      const key = keyOf(root), state = stateOf(key);
      if (state.lease) fail('workspace_revert_busy');
      let released = false;
      const lease = {
        assertCurrent(candidate = root) { if (released || state.lease !== lease || keyOf(candidate) !== key) fail('stale_revert_token'); },
        // Confirmation expires independently in the plan service. Once a valid
        // apply starts, keep GUI writers excluded until its OS operation settles.
        pinForApply() { lease.assertCurrent(); clearTimeout(expiry); },
        release() { if (released) return; released = true; clearTimeout(expiry); if (state.lease === lease) state.lease = null; for (const wake of state.waiters) wake(); cleanup(key, state); },
        async drain({ timeout = 10000 } = {}) {
          lease.assertCurrent();
          if (!state.writers.size) return;
          await new Promise((resolve, reject) => {
            const finish = () => { try { lease.assertCurrent(); if (state.writers.size) return; done(); resolve(); } catch (e) { done(); reject(e); } };
            const done = () => { clearTimeout(timer); state.waiters.delete(finish); cleanup(key, state); };
            const timer = setTimeout(() => { done(); reject(Object.assign(Error('active_writer'), { code: 'active_writer' })); }, timeout);
            state.waiters.add(finish); finish();
          });
        },
      };
      state.lease = lease;
      const expiry = setTimeout(() => lease.release(), Math.min(timeoutMs, 60000)); expiry.unref?.();
      return lease;
    },
  };
}
