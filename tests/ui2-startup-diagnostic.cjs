/* Offline packaged startup diagnostics. Observer fixture only; no product edits.
 * node tests/ui2-startup-diagnostic.cjs [--repeats=2] [--modes=no-cdp,late-runtime,early-runtime-first]
 * Requires the already built isolated desktop package recorded by UI-2 evidence.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const arg = (key, fallback) => process.argv.find(a => a.startsWith('--' + key + '='))?.slice(key.length + 3) || fallback;
const stateFile = path.join(ROOT, 'docs/claude-ui-redesign/ui2-integration-evidence/build-state.json');
const buildRoot = arg('build-root', JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '')).outputRoot);
const session = 'run-' + new Date().toISOString().replace(/[:.]/g, '-');
const OUT = arg('out', path.join(ROOT, 'docs/claude-ui-redesign/ui2-followup-evidence/startup', session));
const repeats = Number(arg('repeats', '2'));
const modes = arg('modes', 'no-cdp,late-runtime,early-runtime-first').split(',');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const allowed = new Set(['no-cdp', 'port-only', 'early-attach', 'early-page', 'early-runtime', 'early-runtime-first', 'late-runtime']);
if (modes.some(mode => !allowed.has(mode)) || !Number.isInteger(repeats) || repeats < 1 || repeats > 3) throw Error('invalid bounded diagnostic matrix');
if (fs.existsSync(OUT)) throw Error('evidence output must be fresh');
fs.mkdirSync(OUT, { recursive: true });
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ui2-startup-'));
const packaged = path.join(buildRoot, 'dist-app/Pi GUI-win32-x64');
const fixture = path.join(world, 'observer-package');
fs.cpSync(packaged, fixture, { recursive: true });
const appRoot = path.join(fixture, 'resources/app');
const packageFile = path.join(appRoot, 'package.json');
const originalPackage = fs.readFileSync(packageFile, 'utf8');
const pkg = JSON.parse(originalPackage);
pkg.main = 'startup-observer.cjs';
fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2));
const observerSource = String.raw`
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { app, BrowserWindow } = require('electron');
const config = JSON.parse(fs.readFileSync(process.env.UI2_STARTUP_CONFIG, 'utf8'));
const events = [], report = { events, ready: false, checks: {}, observerErrors: [] };
function event(kind, data = {}) { events.push({ epoch: Date.now(), kind, ...data }); flush(); }
function flush() { fs.writeFileSync(config.observer, JSON.stringify(report, null, 2)); }
app.setPath('userData', config.userData);
app.on('web-contents-created', (_event, wc) => {
  event('web-contents-created', { wcId: wc.id, type: wc.getType(), url: wc.getURL(), preferences: { sandbox: wc.getLastWebPreferences().sandbox, contextIsolation: wc.getLastWebPreferences().contextIsolation, nodeIntegration: wc.getLastWebPreferences().nodeIntegration, preload: wc.getLastWebPreferences().preload } });
  wc.on('console-message', (_event, details, oldMessage, oldLine, oldSource) => {
    const d = typeof details === 'object' ? details : { level: details, message: oldMessage, lineNumber: oldLine, sourceId: oldSource };
    event('console-message', { wcId: wc.id, url: wc.getURL(), level: d.level, message: String(d.message).slice(0, 1600), line: d.lineNumber, source: d.sourceId });
  });
  for (const name of ['did-start-loading', 'dom-ready', 'did-stop-loading', 'render-process-gone', 'preload-error', 'destroyed']) wc.on(name, (_e, detail) => event(name, { wcId: wc.id, url: wc.isDestroyed() ? null : wc.getURL(), detail: typeof detail === 'string' ? detail : detail?.reason }));
  wc.on('did-start-navigation', (_e, url, inPlace, main) => event('did-start-navigation', { wcId: wc.id, url, inPlace, main }));
  wc.on('did-frame-navigate', (_e, url, code, status, main) => event('did-frame-navigate', { wcId: wc.id, url, code, main }));
  wc.on('did-finish-load', async () => {
    event('did-finish-load', { wcId: wc.id, url: wc.getURL() });
    if (!wc.getURL().startsWith(config.origin)) return;
    try {
      event('observer-evaluate-start');
      report.checks = await wc.executeJavaScript('(async()=>{const a=await import("/update.js"),b=await import("/pi-update.js");a.cancelUpdateAuto();b.cancelPiUpdateAuto();const s=await fetch("/api/status").then(r=>r.json());const p=await fetch("/api/projects").then(r=>r.json());return {desktop:window.piGuiDesktop?.isDesktop===true,themeBridge:typeof window.piGuiDesktop?.theme?.set==="function",hasProject:s.hasProject,piRunning:s.piRunning,projects:(p.items||[]).length,timeOrigin:performance.timeOrigin}})()');
      event('observer-evaluate-end');
      report.ready = true; report.readyEpoch = Date.now(); flush();
      if (config.themeCheck) {
        // The controller attaches only after readiness. Main-process observation
        // has already covered initial empty document and production startup.
        await new Promise(resolve => setTimeout(resolve, 650));
        report.themes = [];
        for (const mode of ['dark', 'light']) {
          event('observer-theme-start', { mode });
          const observed = await wc.executeJavaScript('(async()=>{const m=await import("/theme.js");const ok=await m.setThemePreference(' + JSON.stringify(mode) + ');return {ok,theme:document.documentElement.dataset.theme,preference:document.documentElement.dataset.themePreference,snapshot:window.piGuiDesktop.theme.snapshot()}})()');
          const persisted = JSON.parse(fs.readFileSync(path.join(config.userData, 'theme-preferences.json'), 'utf8'));
          await new Promise(resolve => setTimeout(resolve, 100));
          const screenshot = path.join(config.folder, mode + '.png');
          fs.writeFileSync(screenshot, (await wc.capturePage()).toPNG());
          report.themes.push({ mode, observed, persisted, screenshot });
          event('observer-theme-end', { mode });
        }
      }
      setTimeout(() => { event('observer-close-window'); const win = BrowserWindow.fromWebContents(wc); win?.close(); }, config.holdMs);
    } catch (error) { report.observerErrors.push(error.message); event('observer-evaluate-failed'); app.quit(); }
  });
});
app.on('before-quit', () => event('before-quit'));
app.on('will-quit', () => event('will-quit'));
process.on('exit', code => { report.exitCode = code; event('process-exit', { code }); });
event('require-production-main');
require('./main.cjs');
`;
fs.writeFileSync(path.join(appRoot, 'startup-observer.cjs'), observerSource);
const identities = ['Pi GUI.exe', 'resources/app/main.cjs', 'resources/app/preload.cjs', 'resources/app/server.cjs'].map(file => ({ file, original: sha(path.join(packaged, file)), fixture: sha(path.join(fixture, file)) }));
if (identities.some(file => file.original !== file.fixture)) throw Error('fixture changed production bytes');
fs.writeFileSync(path.join(OUT, 'setup.json'), JSON.stringify({ world, buildRoot, modes, repeats, identities, originalPackage: JSON.parse(originalPackage), fixturePackage: pkg, observerMutation: 'fixture package main points to observer; observer requires unchanged production main', securityMutation: false }, null, 2));
async function reservePort() {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
}
async function run(mode, iteration) {
  const name = mode + '-' + iteration, folder = path.join(OUT, name), dataRoot = path.join(world, name);
  fs.mkdirSync(folder); fs.mkdirSync(dataRoot);
  const port = await reservePort(), cdpPort = await reservePort(), origin = 'http://127.0.0.1:' + port;
  const config = { origin, observer: path.join(folder, 'observer.json'), userData: path.join(dataRoot, 'userdata'), holdMs: 1800, folder, themeCheck: mode === 'late-runtime' };
  const configFile = path.join(dataRoot, 'config.json'); fs.writeFileSync(configFile, JSON.stringify(config));
  const env = { ...process.env, UI2_STARTUP_CONFIG: configFile, PORT: String(port), PI_GUI_DATA: path.join(dataRoot, 'data'), PI_CODING_AGENT_DIR: path.join(dataRoot, 'agent'), PI_BIN: path.join(dataRoot, 'no-pi.cmd'), PI_CWD: '', PI_GUI_OFFLINE: '1', TEMP: path.join(world, 'tmp'), TMP: path.join(world, 'tmp'), TMPDIR: path.join(world, 'tmp') };
  fs.mkdirSync(env.TEMP, { recursive: true }); delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--user-data-dir=' + config.userData, '--disable-background-networking', '--disable-component-update', '--no-first-run'];
  if (mode !== 'no-cdp') args.push('--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + cdpPort);
  const facts = { mode, iteration, origin, cdpPort: mode === 'no-cdp' ? null : cdpPort, started: Date.now(), timeline: [], args, contexts: [], consoleErrors: [], exceptions: [] };
  const child = spawn(path.join(fixture, 'Pi GUI.exe'), args, { cwd: dataRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  facts.pid = child.pid; child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, epoch: Date.now() })));
  let ws;
  function observer() { try { return JSON.parse(fs.readFileSync(config.observer, 'utf8')); } catch { return null; } }
  try {
    if (!['no-cdp', 'port-only'].includes(mode)) {
      if (mode === 'late-runtime') { for (let i = 0; i < 600 && !observer()?.ready; i++) await sleep(10); if (!observer()?.ready) throw Error('production page not ready'); await sleep(300); }
      let target;
      for (let i = 0; i < 2000; i++) { try { const targets = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json(); target = targets.find(item => item.type === 'page'); if (target) break; } catch {} await sleep(2); }
      if (!target) throw Error('no isolated page target');
      facts.target = { id: target.id, url: target.url }; facts.timeline.push({ kind: 'ws-connect', epoch: Date.now() });
      ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
      let sequence = 0; const pending = new Map();
      ws.onmessage = message => {
        const event = JSON.parse(message.data);
        if (event.id && pending.has(event.id)) { pending.get(event.id)(event); pending.delete(event.id); }
        if (!event.method) return;
        const params = event.params;
        facts.timeline.push({ kind: 'event', method: event.method, epoch: Date.now(), eventTimestamp: params?.timestamp, context: params?.executionContextId || params?.context?.id, origin: params?.context?.origin, url: params?.frame?.url });
        if (event.method === 'Runtime.executionContextCreated') facts.contexts.push(params.context);
        if (event.method === 'Runtime.consoleAPICalled' && params.type === 'error') facts.consoleErrors.push({ context: params.executionContextId, timestamp: params.timestamp, messages: params.args.map(arg => String(arg.value ?? arg.description ?? '').slice(0, 1600)) });
        if (event.method === 'Runtime.exceptionThrown') facts.exceptions.push(params.exceptionDetails);
      };
      async function command(method) {
        facts.timeline.push({ kind: 'command', method, epoch: Date.now() });
        return new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 5000); pending.set(id, result => { clearTimeout(timer); if (result.error) reject(Error(result.error.message)); else resolve(result.result); }); ws.send(JSON.stringify({ id, method })); });
      }
      if (mode === 'early-runtime-first') { await command('Runtime.enable'); facts.frameTree = await command('Page.getFrameTree'); await command('Page.enable'); }
      else {
        if (mode !== 'early-attach') facts.frameTree = await command('Page.getFrameTree');
        if (mode.endsWith('runtime')) { await command('Runtime.enable'); await command('Page.enable'); }
      }
    }
    facts.exit = await Promise.race([exit, sleep(15000).then(() => { throw Error('bounded startup timeout'); })]);
  } catch (error) { facts.harnessError = error.message; }
  finally {
    ws?.close();
    if (child.exitCode === null && child.signalCode === null) { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); facts.ownPidCleanup = true; } catch (error) { facts.cleanupStatus = error.status; } }
    facts.observer = observer();
    facts.mainConsoleErrors = (facts.observer?.events || []).filter(event => event.kind === 'console-message' && (event.level === 'error' || event.level >= 3));
    facts.productionReady = facts.observer?.ready === true && facts.observer.checks.desktop && facts.observer.checks.themeBridge && facts.observer.checks.projects === 0 && facts.observer.checks.piRunning === false;
    facts.zeroErrorObserved = !facts.consoleErrors.length && !facts.mainConsoleErrors.length && !facts.exceptions.length;
    facts.assertions = [];
    const verify = (pass, label, detail) => facts.assertions.push({ label, pass: Boolean(pass), ...(detail === undefined ? {} : { detail }) });
    const events = facts.observer?.events || [];
    verify(!facts.harnessError, 'harness completed', facts.harnessError);
    verify(facts.exit?.code === 0, 'packaged application exits normally');
    verify(facts.productionReady, 'production preload ready; no real projects or Pi');
    verify(!(facts.observer?.observerErrors || []).length, 'main observer has no execution errors');
    verify(!events.some(e => ['preload-error', 'render-process-gone'].includes(e.kind)), 'no preload failure or renderer crash');
    verify(facts.exceptions.length === 0, 'no CDP uncaught exceptions');
    const firstCreated = events.find(e => e.kind === 'web-contents-created');
    const firstNavigate = events.find(e => e.kind === 'did-start-navigation' && e.main);
    const committed = events.find(e => e.kind === 'did-frame-navigate' && e.main && e.url.startsWith(origin));
    const injection = events.find(e => e.kind === 'observer-evaluate-start');
    verify(firstCreated && firstNavigate && firstCreated.epoch <= firstNavigate.epoch && firstCreated.url === '', 'main observation starts on initial empty document before navigation');
    verify(firstCreated?.preferences.sandbox === true && firstCreated?.preferences.contextIsolation === true && firstCreated?.preferences.nodeIntegration === false, 'production sandbox and isolation remain enabled');
    if (mode === 'early-runtime-first') {
      const known = ['Electron sandboxed_renderer.bundle.js script failed to run', "TypeError: Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null."];
      const errors = facts.mainConsoleErrors;
      const runtime = facts.timeline.find(e => e.kind === 'command' && e.method === 'Runtime.enable');
      const commands = facts.timeline.filter(e => e.kind === 'command');
      const emptyContext = facts.contexts.find(c => c.name === 'Electron Isolated Context' && c.origin === '://');
      const productionContext = facts.contexts.find(c => c.name === 'Electron Isolated Context' && c.origin === origin);
      const windowHit = runtime && committed && errors.length === 2 && errors.every(e => e.epoch >= runtime.epoch && e.epoch < committed.epoch && injection && e.epoch < injection.epoch);
      facts.negativeControlVerified = Boolean(windowHit);
      verify(commands[0]?.method === 'Runtime.enable', 'negative control sends Runtime first');
      verify(errors.length === 2 && errors.every((e, i) => e.message === known[i]), 'negative control has exactly the two known console errors; no unknown errors');
      verify(errors.length === 2 && errors.every(e => e.url === '' && e.source === 'node:electron/js2c/sandbox_bundle'), 'negative errors belong to initial empty document sandbox bootstrap');
      verify(windowHit, 'negative window was hit before production commit and observer injection; otherwise UNVERIFIED');
      verify(emptyContext && productionContext && emptyContext.auxData?.frameId === productionContext.auxData?.frameId, 'empty and production isolated contexts share the same frame');
      verify(facts.consoleErrors.length === 2 && facts.consoleErrors.every((e, i) => e.context === emptyContext?.id && e.messages.length === 1 && (i === 0 ? e.messages[0] === known[i] : e.messages[0].startsWith(known[i] + '\n'))), 'CDP independently attributes exactly the known errors to empty isolated context');
      verify(facts.timeline.some(e => e.method === 'Runtime.executionContextsCleared'), 'empty document contexts cleared before production contexts');
    } else {
      verify(facts.zeroErrorObserved, 'normal control has zero errors throughout main and CDP observations');
      if (mode === 'no-cdp') verify(!args.some(a => a.startsWith('--remote-debugging')) && facts.timeline.length === 0, 'no-CDP control has no debug endpoint or external commands');
      if (mode === 'late-runtime') {
        const runtime = facts.timeline.find(e => e.kind === 'command' && e.method === 'Runtime.enable');
        const finish = events.find(e => e.kind === 'did-finish-load' && e.url.startsWith(origin));
        verify(runtime && finish && runtime.epoch >= finish.epoch + 300, 'normal Runtime attach occurs after production load plus readiness delay');
        for (const expected of ['dark', 'light']) {
          const theme = facts.observer?.themes?.find(t => t.mode === expected);
          verify(theme?.observed.ok && theme.observed.theme === expected && theme.observed.preference === expected && theme.observed.snapshot.preference === expected && theme.observed.snapshot.resolved === expected, 'real renderer/native bridge agrees for ' + expected);
          verify(theme?.observed.snapshot.persisted === true && theme.persisted.version === 1 && theme.persisted.preference === expected, 'native preference persisted on disk for ' + expected);
          verify(theme && fs.statSync(theme.screenshot).size > 1000, 'actual packaged screenshot captured for ' + expected);
        }
      }
    }
    facts.contractPass = facts.assertions.every(assertion => assertion.pass);
    fs.writeFileSync(path.join(folder, 'cdp.json'), JSON.stringify(facts, null, 2));
  }
  const assertions = { passed: facts.assertions.filter(a => a.pass).length, total: facts.assertions.length };
  console.log(JSON.stringify({ name, mainErrors: facts.mainConsoleErrors.length, cdpErrors: facts.consoleErrors.length, ready: facts.productionReady, exit: facts.exit?.code, contractPass: facts.contractPass, assertions, harnessError: facts.harnessError }));
  return { name, mode, iteration, mainErrors: facts.mainConsoleErrors.length, cdpErrors: facts.consoleErrors.length, ready: Boolean(facts.productionReady), exit: facts.exit?.code, zeroErrorObserved: facts.zeroErrorObserved, contractPass: facts.contractPass, assertions, negativeControlVerified: facts.negativeControlVerified, harnessError: facts.harnessError };
}
(async () => {
  const runs = [];
  for (let iteration = 1; iteration <= repeats; iteration++) for (const mode of modes) runs.push(await run(mode, iteration));
  const summary = { out: OUT, world, runs, aggregate: modes.map(mode => { const selected = runs.filter(run => run.mode === mode); return { mode, runs: selected.length, ready: selected.filter(run => run.ready).length, zeroErrorRuns: selected.filter(run => run.zeroErrorObserved).length, errors: selected.reduce((total, run) => total + run.mainErrors, 0), harnessFailures: selected.filter(run => run.harnessError).length }; }) };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('Evidence: ' + OUT);
  if (runs.some(run => !run.contractPass)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
