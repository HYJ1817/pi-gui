/* Evidence scoped to workspace generation + bridge run. Not a registered tool list. */
export const WEB_INSTALL_COMMAND = 'pi install npm:pi-web-access';
export function createWebObservation() {
  let key = '';
  let observed = {};
  function snapshot(generation, run) {
    const next = `${generation}/${run}`;
    if (next !== key) { key = next; observed = {}; }
    return Object.fromEntries(['web_search', 'fetch_content', 'get_search_content'].map(name => [name, observed[name] === true]));
  }
  function observe(event, generation, run) {
    snapshot(generation, run);
    if (event?.type === 'bridge_status' && ['restarting', 'starting', 'exited', 'error', 'no-project'].includes(event.state)) observed = {};
    if (!/^tool_execution_(start|update|end)$/.test(event?.type || '') || event.bridgeRun !== run) return;
    if (['web_search', 'fetch_content', 'get_search_content'].includes(event.toolName)) observed[event.toolName] = true;
  }
  return { snapshot, observe };
}
export function webSetup(registry) {
  const items = (registry?.extensions || []).filter(e => e.name === 'pi-web-access');
  const known = registry && registry.ok !== false && Array.isArray(registry.extensions);
  return {
    installed: items.some(e => e.state?.installed === true) ? true : known && !registry.diagnostics?.length ? false : null,
    // Registry's enabled evidence is distinct from presence and runtime tool evidence.
    configured: items.some(e => e.state?.enabled === true) ? true : items.length && items.every(e => e.state?.enabled === false) ? false : null,
    discovered: items.some(e => e.state?.installed === true),
    loaded: items.some(e => e.state?.loaded === true) ? true : null,
    automaticInstall: false,
  };
}
