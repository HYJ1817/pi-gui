'use strict';
// Desktop composition only. Neither renderer nor page receives bridge credentials.
const { createBrowserAgent } = require('./browser-agent.cjs');
const { createBrowserAgentBridge } = require('./browser-agent-bridge.cjs');

function createBrowserAgentHost({ browser, origin, getWindow, ipcMain, extensionPath }) {
  let bridge = null;
  const send = (channel, payload) => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    try { window.webContents.send(channel, payload); } catch { /* closing */ }
  };
  const agent = createBrowserAgent({ browser, origin,
    onState: (state) => send('pi-gui:browser-agent-state', project(state)) });
  function project(state) {
    return { ...state, available: state.available === true && bridge?.isSessionActive() === true };
  }
  const executor = {
    status: () => agent.status(),
    invalidate: (...args) => agent.invalidate(...args),
    setEnabled: (flag) => agent.setEnabled(flag),
    execute: async (request, options) => {
      if (request.action === 'open' && agent.status().enabled) send('pi-gui:browser-agent-open');
      return agent.execute(request, options);
    },
  };
  bridge = createBrowserAgentBridge({ agent: executor,
    onAvailability: () => send('pi-gui:browser-agent-state', project(agent.status())) });
  const allowed = (event) => {
    const window = getWindow();
    return Boolean(window && !window.isDestroyed() && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame);
  };
  ipcMain.handle('pi-gui:browser-agent-enable', async (event, flag) => {
    if (!allowed(event)) return { ok: false, code: 'desktop_required' };
    if (flag === true && !project(agent.status()).available) return { ok: false, code: 'cdp_unavailable' };
    return project(await agent.setEnabled(flag === true));
  });
  ipcMain.handle('pi-gui:browser-agent-status', (event) =>
    allowed(event) ? project(agent.status()) : { available: false, code: 'desktop_required' });
  return {
    start: () => bridge.start(),
    environment: () => {
      const connection = bridge.connection();
      return { PI_GUI_BROWSER_BRIDGE_URL: connection.url,
        PI_GUI_BROWSER_BRIDGE_TOKEN: connection.token, PI_GUI_BROWSER_EXTENSION: extensionPath };
    },
    stop: () => { agent.dispose(); return bridge.stop(); },
    // Main-process test harness only; never exposed in preload.
    agent, bridge,
  };
}
module.exports = { createBrowserAgentHost };
