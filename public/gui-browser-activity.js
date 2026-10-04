/* Built-in Browser is independent of external browser_* tools. No page or
 * request content is projected: fixed labels and bounded numeric counts only. */
const ACTIONS = Object.freeze({
  gui_browser_open: ['Opening built-in browser…', 'Opened built-in browser'],
  gui_browser_snapshot: ['Reading page…', 'Read page'],
  gui_browser_click: ['Clicking…', 'Clicked element'],
  gui_browser_fill: ['Entering text…', 'Entered text'],
  gui_browser_press: ['Pressing key…', 'Pressed key'],
  gui_browser_reload: ['Reloading…', 'Reloaded page'],
  gui_browser_back: ['Going back…', 'Went back'],
  gui_browser_forward: ['Going forward…', 'Went forward'],
  gui_browser_screenshot: ['Capturing screenshot…', 'Captured screenshot'],
  gui_browser_console: ['Reading console…', 'Read console'],
  gui_browser_network: ['Reading network…', 'Read network'],
  gui_browser_status: ['Checking browser…', 'Checked browser status'],
});
export const GUI_BROWSER_TOOLS = new Set(Object.keys(ACTIONS));
const ERROR_CODES = new Set(['desktop_required', 'agent_control_disabled', 'browser_closed', 'browser_unavailable',
  'remote_origin_not_allowed', 'cdp_unavailable', 'cdp_attach_failed', 'navigation_failed',
  'timeout', 'stale_browser_generation', 'stale_element_ref', 'element_not_found',
  'element_not_interactable', 'unsupported_element', 'invalid_key', 'cancelled', 'internal',
  'cdp_error', 'element_not_allowed', 'screenshot_too_large', 'busy', 'invalid_request',
  'payload_too_large', 'unauthorized', 'unknown_action']);

export function guiBrowserActivity(entry) {
  if (!GUI_BROWSER_TOOLS.has(entry?.name)) return null;
  const d = entry.details && typeof entry.details === 'object' ? entry.details : {};
  let status = entry.status || 'running';
  if (status !== 'running' && d.ok === false) status = d.code === 'cancelled' ? 'cancelled' : 'error';
  const proven = status === 'success' && d.ok === true;
  let label = ACTIONS[entry.name][0];
  let facts = '';
  if (status === 'error') {
    label = 'Built-in browser action failed';
    facts = ERROR_CODES.has(d.code) ? `Error: ${d.code}` : 'Result details unavailable';
  } else if (status !== 'running') {
    label = status === 'cancelled' ? 'Built-in browser action cancelled'
      : status === 'interrupted' ? 'Built-in browser action interrupted'
      : proven ? ACTIONS[entry.name][1] : 'Built-in browser result unavailable';
    if (!proven) facts = 'Result details unavailable';
  }
  if (proven) {
    const count = Number.isInteger(d.count) && d.count >= 0 && d.count <= 100000 ? d.count
      : Number.isInteger(d.returned) && d.returned >= 0 && d.returned <= 100000 ? d.returned : null;
    if (count !== null && ['gui_browser_console', 'gui_browser_network', 'gui_browser_snapshot'].includes(entry.name)) {
      facts = `${entry.name === 'gui_browser_console' ? 'Messages' : entry.name === 'gui_browser_network' ? 'Requests' : 'Elements'}: ${count}`;
    }
  }
  return { known: true, status, label, summary: '', facts, sources: [] };
}
