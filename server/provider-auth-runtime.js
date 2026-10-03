/* Reload native credential-dependent model discovery, preserving Pi's session.
 * A successful spawn is insufficient: require real RPC responses afterwards. */
export function createAuthRuntimeSync({ rpc, getCwd, busyReason, subscribe, timeoutMs = 15_000 }) {
  return async function synchronize() {
    const cwd = getCwd();
    if (!cwd) return { ok: true };
    const before = rpc.getState();
    const state = await rpc.request({ type: 'get_state' }, { timeoutMs });
    if (!state || state.__error || getCwd() !== cwd || busyReason() || rpc.getState().bridgeRun !== before.bridgeRun) return { ok: false };
    // In-memory/no-session runtimes cannot safely survive an automatic reload.
    if (typeof state.sessionFile !== 'string' || !state.sessionFile.trim() || /[\u0000-\u001f]/.test(state.sessionFile)) return { ok: false };
    const ready = new Promise(resolve => {
      let unsubscribe;
      const finish = value => { clearTimeout(timer); unsubscribe?.(); resolve(value); };
      const timer = setTimeout(() => finish(false), timeoutMs);
      unsubscribe = subscribe(event => {
        if (getCwd() !== cwd) return finish(false);
        if (event.type !== 'bridge_status' || event.bridgeRun <= before.bridgeRun) return;
        if (event.state === 'ready') finish(true);
        else if (['error', 'no-project', 'exited'].includes(event.state)) finish(false);
      });
      rpc.restart({ sessionPath: state.sessionFile || null });
    });
    if (!await ready || getCwd() !== cwd) return { ok: false };
    const run = rpc.getState().bridgeRun;
    const results = await Promise.all(['get_state', 'get_available_models', 'get_available_thinking_levels'].map(type => rpc.request({ type }, { timeoutMs })));
    return { ok: getCwd() === cwd && rpc.getState().bridgeRun === run && results.every(r => r && !r.__error) };
  };
}
