'use strict';
// Explicit opt-in. Real Electron + local fixtures, no model calls or internet.
if (process.env.PI_GUI_AGENT_BROWSER_LIVE !== '1') {
  console.log('Opt in: PI_GUI_AGENT_BROWSER_LIVE=1 npm run test:agent-browser-live');
  process.exit(0);
}
const { spawn } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(__dirname, 'agent-browser-live-main.cjs')],
  { env, stdio: 'inherit', windowsHide: true });
child.on('error', () => { console.error('Electron could not start'); process.exitCode = 1; });
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 120000);
child.on('exit', (code) => { clearTimeout(timer); process.exitCode = code ?? 1; });
