'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
let count = 0;
const check = (condition, name) => { assert.ok(condition, name); count++; };
(async () => {
  const handlers = new Map(), sent = [];
  const sender = { mainFrame: {}, send: (channel, value) => sent.push({ channel, value }) };
  const window = { isDestroyed: () => false, webContents: sender };
  const event = { sender, senderFrame: sender.mainFrame };
  let active = false, state = { available: true, enabled: false, generation: 1 }, enables = 0;
  let notify, executor;
  const original = Module._load;
  try {
    Module._load = function (name, ...args) {
      if (name === './browser-agent.cjs') return { createBrowserAgent: ({ onState }) => ({
        status: () => ({ ...state }), invalidate() {}, dispose() {},
        setEnabled(flag) { enables++; state.enabled = flag; onState({ ...state }); return { ...state }; },
        execute: async request => ({ ok: true, action: request.action }),
      }) };
      if (name === './browser-agent-bridge.cjs') return { createBrowserAgentBridge: ({ agent, onAvailability }) => {
        executor = agent; notify = onAvailability;
        return { start: async () => {}, stop: async () => {}, isSessionActive: () => active,
          connection: () => ({ url: 'http://127.0.0.1:43210', token: 'MASTER_PRIVATE' }) };
      } };
      return original.call(this, name, ...args);
    };
    const { createBrowserAgentHost } = require('../electron/browser-agent-host.cjs');
    const host = createBrowserAgentHost({ browser: {}, origin: 'http://127.0.0.1:7788',
      getWindow: () => window, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, extensionPath: 'BUNDLED_PRIVATE' });
    await host.start();
    const enable = handlers.get('pi-gui:browser-agent-enable');
    const status = handlers.get('pi-gui:browser-agent-status');
    check(status(event).available === false, 'no Pi session means unavailable');
    check((await enable(event, true)).code === 'cdp_unavailable', 'cannot enable unavailable capability');
    check(enables === 0, 'unavailable enable does not mutate state');
    check((await enable({ ...event, sender: {} }, true)).code === 'desktop_required', 'foreign sender rejected');
    check((await enable({ ...event, senderFrame: {} }, true)).code === 'desktop_required', 'child frame rejected');
    check(enables === 0, 'unauthorized enable causes no side effects');
    active = true; notify();
    check(status(event).available === true, 'available from real session evidence');
    check((await enable(event, true)).enabled === true, 'authorized explicit enable');
    check(sent.some(s => s.channel === 'pi-gui:browser-agent-state' && s.value.enabled), 'safe state forwarded');
    await executor.execute({ action: 'open' });
    check(sent.some(s => s.channel === 'pi-gui:browser-agent-open'), 'agent opening mounts pane');
    await enable(event, false); const opens = sent.filter(s => s.channel === 'pi-gui:browser-agent-open').length;
    await executor.execute({ action: 'open' });
    check(sent.filter(s => s.channel === 'pi-gui:browser-agent-open').length === opens, 'disabled action does not mount');
    check(status({ ...event, sender: {} }).available === false, 'unauthorized status denied');
    check(!JSON.stringify(sent).includes('MASTER_PRIVATE'), 'token absent renderer events');
    check(!JSON.stringify(status(event)).includes('BUNDLED_PRIVATE'), 'extension path absent state');
    check(host.environment().PI_GUI_BROWSER_BRIDGE_TOKEN === 'MASTER_PRIVATE', 'master only through private environment');
    await host.stop();
  } finally { Module._load = original; }
  const root = path.resolve(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8');
  check(/createBrowserAgentHost/.test(main) && /browserAgent\.environment\(\)/.test(main), 'main composes host and private environment');
  check(/setAgentControl/.test(preload) && /onAgentOpen/.test(preload), 'preload exposes named UI actions');
  check(!/PI_GUI_BROWSER_.*TOKEN/.test(preload), 'no credentials in preload');
  console.log(`gui-browser-host: ${count}/${count} passed`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
