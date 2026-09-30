import { SUBAGENT_TOOLS } from './subagent-activity.js';
export const SUBAGENT_INSTALL_COMMAND = 'pi install npm:pi-subagents';
/** Shared entry guard: old tool events cannot enter a newly activating workspace. */
export function acceptSubagentEvent(event, scope) {
  if (!/^tool_execution_(start|update|end)$/.test(event?.type || '')) return true;
  return !scope.switching && (!Number.isInteger(event.bridgeRun) || event.bridgeRun === scope.bridgeRun);
}
export function createSubagentObservation() {
  let key = '', observed = {};
  function snapshot(generation, run) {
    const next = `${generation}/${run}`;
    if (next !== key) { key = next; observed = {}; }
    return Object.fromEntries(SUBAGENT_TOOLS.map(name => [name, observed[name] === true]));
  }
  function observe(event, generation, run) {
    snapshot(generation, run);
    if (event?.type === 'bridge_status' && ['starting', 'restarting', 'exited', 'error', 'no-project'].includes(event.state)) observed = {};
    if (/^tool_execution_(start|update|end)$/.test(event?.type || '') && event.bridgeRun === run && SUBAGENT_TOOLS.includes(event.toolName)) observed[event.toolName] = true;
  }
  return { snapshot, observe };
}
export function subagentSetup(registry) {
  const items = (registry?.extensions || []).filter(e => e.name === 'pi-subagents');
  const known = registry && registry.ok !== false && Array.isArray(registry.extensions);
  return {
    installed: items.some(e => e.state?.installed === true) ? true : known && !registry.diagnostics?.length ? false : null,
    configured: items.some(e => e.state?.enabled === true) ? true : items.length && items.every(e => e.state?.enabled === false) ? false : null,
    loaded: items.some(e => e.state?.loaded === true) ? true : null,
    automaticInstall: false,
  };
}
