// Minimal normal-sandbox runtime diagnostic, not viewer acceptance evidence.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const world = process.env.PREVIEW_PROBE_WORLD;
if (!world || !path.isAbsolute(world)) throw new Error('temporary diagnostic root required');
const trace = value => { fs.appendFileSync(path.join(world, 'trace.jsonl'), JSON.stringify(value) + '\n'); console.log(JSON.stringify(value)); };
trace({ phase: 'main-entered', electron: process.versions.electron, chrome: process.versions.chrome, sandboxBypass: process.argv.includes('--no-sandbox') });
app.setPath('userData', path.join(world, 'user-data'));
app.commandLine.appendSwitch('disable-background-networking');
app.on('child-process-gone', (_event, details) => trace({ phase: 'child-gone', type: details.type, reason: details.reason, exitCode: details.exitCode }));
const deadline = setTimeout(() => { trace({ phase: 'ready-timeout' }); app.exit(2); }, 30000);
app.whenReady().then(async () => {
  trace({ phase: 'app-ready' });
  const win = new BrowserWindow({ width: 700, height: 600, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('render-process-gone', (_event, details) => trace({ phase: 'renderer-gone', reason: details.reason, exitCode: details.exitCode }));
  await win.loadURL('data:text/html,<title>Offline runtime diagnostic</title><button id="probe">Run local check</button><output id="result"></output><script>document.querySelector("button").onclick=()=>document.querySelector("output").textContent="clicked"</script>');
  await win.webContents.executeJavaScript('document.querySelector("#probe").click()');
  trace({ phase: 'interaction', value: await win.webContents.executeJavaScript('document.querySelector("#result").textContent'), preferences: { sandbox: win.webContents.getLastWebPreferences().sandbox, contextIsolation: win.webContents.getLastWebPreferences().contextIsolation, nodeIntegration: win.webContents.getLastWebPreferences().nodeIntegration } });
  await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(world, 'runtime.png'), image.toPNG());
  trace({ phase: 'captured', size: image.getSize(), empty: image.isEmpty() });
  clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(error => { trace({ phase: 'error', name: error.name, reason: error.message === 'UnknownVizError' ? 'UnknownVizError' : 'runtime_probe_failed' }); clearTimeout(deadline); app.exit(1); });
