const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
let count = 0;
const check = (name, fn) => { fn(); count++; console.log('  ok  ' + name); };
(async () => {
  const dom = new JSDOM('<body><div id="rightPane"><div class="rp-body"></div></div><input id="keepFocus"></body>', { url: 'http://127.0.0.1/' });
  global.window = dom.window; global.document = dom.window.document;
  const { GUI_BROWSER_TOOLS, guiBrowserActivity } = await import('../public/gui-browser-activity.js');
  const { createGuiBrowserObservation, guiBrowserCapability, acceptGuiBrowserState } = await import('../public/gui-browser-capabilities.js');
  const { browserActivity, BROWSER_TOOLS } = await import('../public/browser-activity.js');
  const model = await import('../public/tool-model.js');
  const view = await import('../public/tool-view.js');
  check('closed namespace independent of external browser', () => {
    assert.equal(GUI_BROWSER_TOOLS.size, 12);
    for (const name of GUI_BROWSER_TOOLS) { assert.ok(!BROWSER_TOOLS.has(name)); assert.equal(browserActivity({ name }), null); }
    assert.equal(guiBrowserActivity({ name: 'gui_browser_eval' }), null);
    assert.equal(guiBrowserActivity({ name: 'browser_fill' }), null);
  });
  for (const name of GUI_BROWSER_TOOLS) {
    check(name + ' projects no raw content in DOM/title at any phase', () => {
      const entry = model.makeEntry({ toolCallId: name, toolName: name, args: { text: 'PRIVATE_INPUT', url: 'http://localhost/?PRIVATE_QUERY', ref: 'PRIVATE_REF' } }, 1);
      const node = view.renderEntry(entry); document.body.append(node);
      const details = { ok: true, count: 2, text: 'PRIVATE_PAGE', title: 'PRIVATE_TITLE', console: 'PRIVATE_CONSOLE', network: 'PRIVATE_NETWORK', data: 'PRIVATE_BASE64', url: 'http://localhost/?PRIVATE_QUERY' };
      model.applyEnd(entry, { result: { content: [{ type: 'text', text: 'PRIVATE_RESULT' }, { type: 'image', data: 'PRIVATE_BASE64', mimeType: 'image/png' }], details } }, 5);
      view.updateEntry(node, entry);
      assert.doesNotMatch(node.outerHTML, /PRIVATE_/);
      details.ok = false; details.code = 'PRIVATE_ERROR';
      view.updateEntry(node, entry);
      assert.doesNotMatch(node.outerHTML, /PRIVATE_/);
      node.remove();
    });
  }
  check('success needs structured proof and safe count', () => {
    assert.match(guiBrowserActivity({ name: 'gui_browser_open', status: 'success', args: { url: 'http://localhost/' } }).facts, /unavailable/);
    assert.equal(guiBrowserActivity({ name: 'gui_browser_console', status: 'success', details: { ok: true, count: 3 } }).facts, 'Messages: 3');
    assert.equal(guiBrowserActivity({ name: 'gui_browser_console', status: 'success', details: { ok: true, count: -1 } }).facts, '');
  });
  check('stable controller and bridge errors are closed; unknown error text is hidden', () => {
    for (const code of ['browser_unavailable', 'cdp_error', 'element_not_allowed', 'screenshot_too_large', 'busy', 'invalid_request', 'payload_too_large', 'unauthorized', 'unknown_action']) {
      assert.equal(guiBrowserActivity({ name: 'gui_browser_click', status: 'success', details: { ok: false, code, message: 'PRIVATE_ERROR', stack: 'PRIVATE_STACK' } }).facts, `Error: ${code}`);
    }
    const node = view.renderEntry({ name: 'gui_browser_click', status: 'error', details: { ok: false, code: 'PRIVATE_ERROR', message: 'PRIVATE_RAW', stack: 'PRIVATE_STACK' }, args: { text: 'PRIVATE_ARG' } });
    assert.doesNotMatch(node.outerHTML, /PRIVATE_/);
    assert.match(node.textContent, /Result details unavailable/);
  });
  check('runtime observation scoped to workspace and run; missing remains unknown', () => {
    const obs = createGuiBrowserObservation();
    assert.equal(obs.snapshot(1, 2), null);
    const event = { type: 'tool_execution_start', toolName: 'gui_browser_status', bridgeRun: 2 };
    obs.observe(event, 1, 2, true); assert.equal(obs.snapshot(1, 2), null);
    obs.observe({ ...event, bridgeRun: 1 }, 1, 2); assert.equal(obs.snapshot(1, 2), null);
    obs.observe(event, 1, 2); assert.equal(obs.snapshot(1, 2).any, true);
    assert.equal(obs.snapshot(2, 2), null);
    obs.observe(event, 2, 2); obs.observe({ type: 'bridge_status', state: 'restarting' }, 2, 2);
    assert.equal(obs.snapshot(2, 2), null);
  });
  check('capability is bundled evidence, not external installation or invocation proof', () => {
    const desktop = { browser: { agentStatus() {}, setAgentControl() {} } };
    const cap = guiBrowserCapability({ guiBrowser: { bundled: true, configured: true, loaded: null } }, { any: true }, desktop);
    assert.equal(cap.state.installed, true); assert.equal(cap.state.loaded, null); assert.equal(cap.state.configured, true);
    assert.equal(cap.installCommand, undefined); assert.equal(cap.installId, undefined);
    const web = guiBrowserCapability(null, null, {}); assert.equal(web.state.loaded, false); assert.equal(web.state.runtimeObserved, null);
  });
  check('main state is allowlisted and capability reports current status without secrets', () => {
    acceptGuiBrowserState({ available: true, enabled: false, open: true, attached: false, token: 'PRIVATE_TOKEN', urlOrigin: 'PRIVATE_URL' });
    const cap = guiBrowserCapability({}, null, { browser: { agentStatus() {}, setAgentControl() {} } });
    assert.equal(cap.state.available, true); assert.equal(cap.state.enabled, false); assert.equal(cap.state.browserOpen, true);
    assert.doesNotMatch(JSON.stringify(cap), /PRIVATE_/);
  });
  const calls = []; let agentListener, openListener;
  let truth = { available: true, enabled: false, busy: false };
  const bridge = { open: async () => { calls.push('open'); return { ok: true }; },
    back() {}, forward() {}, stop() {}, reload() {}, close() {}, setBounds() {}, setOccluded() {}, openExternal() {},
    onState: () => () => {}, onNotice: () => () => {}, onAgentState: (fn) => { agentListener = fn; return () => {}; },
    onAgentOpen: (fn) => { openListener = fn; }, agentStatus: async () => truth,
    setAgentControl: async (enabled) => { calls.push(enabled); truth = { ...truth, enabled }; agentListener(truth); } };
  window.piGuiDesktop = { browser: bridge };
  const pane = { root: document.getElementById('rightPane'), open() {}, close() {}, isOpen: () => true, onViewport: () => () => {}, onOccluded: () => () => {} };
  const { attachBrowserPane } = await import('../public/browser-pane.js');
  const attached = attachBrowserPane(pane);
  document.getElementById('keepFocus').focus();
  openListener(); await new Promise((r) => setImmediate(r));
  const surface = attached.surface();
  check('agent open mounts same pane without calling open or stealing focus', () => {
    assert.deepEqual(calls, []); assert.equal(document.activeElement.id, 'keepFocus'); assert.ok(surface.isLive());
    openListener(); assert.equal(attached.surface(), surface);
  });
  check('default off and explicit control uses authoritative main state', () => {
    assert.equal(surface.ui.agent.getAttribute('aria-pressed'), 'false');
    assert.match(surface.ui.agentStatus.textContent, /已关闭/);
  });
  surface.ui.agent.click(); await new Promise((r) => setImmediate(r));
  check('user enables and busy status does not echo payload', () => {
    assert.deepEqual(calls, [true]); assert.equal(surface.ui.agent.getAttribute('aria-pressed'), 'true');
    agentListener({ ...truth, busy: true, urlOrigin: 'PRIVATE_URL', title: 'PRIVATE_TITLE' });
    assert.match(surface.ui.agentStatus.textContent, /正在操作/); assert.doesNotMatch(surface.host.outerHTML, /PRIVATE_/);
  });
  surface.ui.agent.click(); await new Promise((r) => setImmediate(r));
  check('user can disable and no permission is persisted', () => {
    assert.deepEqual(calls, [true, false]); assert.equal(surface.ui.agent.getAttribute('aria-pressed'), 'false');
    assert.equal(window.localStorage.length, 0);
  });
  attached.close();
  console.log(`\n${count}/${count} passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
