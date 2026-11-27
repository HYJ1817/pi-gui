'use strict';
// Benign, renderer-only UI acceptance. Uses production main/preload/native frame
// qualification, but an injected read fixture, NOT a real tool/model/store proof.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const h = require('./fixtures/visual-replies-support.cjs');

if (process.versions.electron && process.env.ARTIFACT_VIEWER_OBSERVER === '1') {
  observe().catch(() => require('electron').app.exit(1));
} else if (require.main === module) launch().catch(error => { console.error(error.message); process.exitCode = 1; });

async function launch() {
  if (process.platform !== 'win32') throw Error('Windows desktop required; not run');
  const world = h.createWorld(); h.prepareProjects(world);
  const env = { ...h.childEnvironment(world), PI_BIN: h.prepareFakePi(world), PORT: String(await h.freePort()),
    ARTIFACT_VIEWER_OBSERVER: '1' };
  const exe = require('electron');
  console.log('Viewer UI evidence: ' + path.join(world, 'evidence'));
  const child = spawn(exe, [__filename, '--user-data-dir=' + path.join(world, 'profile'), '--disable-background-networking'],
    { env, cwd: world, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-5000); });
  const timer = setTimeout(() => child.kill(), 180000);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  clearTimeout(timer);
  const file = path.join(world, 'evidence/viewer.json');
  if (!fs.existsSync(file)) throw Error(`No viewer report; exit=${exit.code}; ${output}`);
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  report.exit = exit; report.identity.executableSha256 = h.digest(exe); h.saveJson(file, report);
  for (const item of report.checks) console.log(`${item.pass ? 'PASS' : 'FAIL'} ${item.id}`);
  console.log(`Viewer UI: ${report.checks.filter(x => x.pass).length}/${report.checks.length}; skipped=0; shots=${report.shots.length}; exit=${exit.code}`);
  if (report.failure) console.log(`Failure ${report.failure.stage}: ${report.failure.code}`);
  console.log('Evidence: ' + file);
  if (!report.completed || report.checks.some(x => !x.pass) || exit.code !== 0) process.exitCode = 1;
}

async function observe() {
  const { app, BrowserWindow } = require('electron');
  const world = h.validateWorld(process.env.VISUAL_REPLIES_WORLD, process.env.VISUAL_REPLIES_TEMP_ROOT);
  for (const [name, directory] of Object.entries({ home: 'home', appData: 'appdata', userData: 'profile', sessionData: 'profile', temp: 'tmp', logs: 'logs' })) app.setPath(name, path.join(world, directory));
  const file = path.join(world, 'evidence/viewer.json');
  const report = { completed: false, checks: [], shots: [], identity: { head: h.git(h.ROOT, 'rev-parse', 'HEAD'),
    changed: h.git(h.ROOT, 'diff', '--name-only').split('\n').filter(Boolean), electron: process.versions.electron,
    platform: process.platform, entry: 'unmodified-production-main-with-benign-renderer-read-fixture',
    securityAcceptance: false, realPiOrModel: false,
    sourceDigests: Object.fromEntries(['public/html-artifact-viewer.js', 'public/html-artifact-dialog.js', 'public/html-artifact-controls.js',
      'public/html-artifact-interactions.js', 'public/html-artifact.css', 'public/html-artifact-frame.js'].map(name => [name, h.digest(path.join(h.ROOT, name))])) } };
  let win, stage = 'production-main';
  const save = () => h.saveJson(file, report);
  const check = (id, pass, facts) => { report.checks.push({ id, pass: Boolean(pass), facts }); save(); if (!pass) throw Error(id); };
  const read = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (fn, name) => { const end = Date.now() + 30000; while (Date.now() < end) { if (await fn()) return; await h.sleep(75); } throw Error('timeout-' + name); };
  const shot = async name => {
    const png = (await win.webContents.capturePage()).toPNG();
    fs.writeFileSync(path.join(world, 'evidence', name + '.png'), png, { flag: 'wx' });
    report.shots.push({ file: name + '.png', bytes: png.length, sha256: h.hashText(png),
      ...await read(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, theme: document.documentElement.dataset.theme })) }); save();
  };
  const click = async selector => {
    const point = await read(s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, selector);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) });
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await h.sleep(180);
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    report.lastPointer = { selector, point, facts: await read((s, p) => { const b = document.querySelector(s); return { disabled: b.disabled, opacity: getComputedStyle(b).opacity,
      pointerEvents: getComputedStyle(b).pointerEvents, hit: document.elementFromPoint(p.x, p.y)?.className,
      showModal: typeof document.querySelector('.html-artifact-surface')?.showModal,
      hovered: b.closest('.html-artifact')?.matches(':hover') }; }, selector, point) }; save();
  };
  const key = async (key, modifiers = 0) => {
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 9, modifiers });
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 9, modifiers });
  };
  save(); require(path.join(h.ROOT, 'electron/main.cjs'));
  try {
    await app.whenReady();
    await until(() => { win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:' + process.env.PORT + '/')); return Boolean(win); }, 'window');
    if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.show(); win.focus();
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.bringToFront');
    await until(() => read(async () => { const { S } = await import('/state.js'); return Boolean(S.legacyOwner?.sessionId && S.thread && window.piGuiDesktop?.isDesktop); }), 'ready');
    const prefs = win.webContents.getLastWebPreferences();
    check('normal-production-preferences', prefs.sandbox === true && prefs.contextIsolation === true && prefs.nodeIntegration === false
      && !app.commandLine.hasSwitch('no-sandbox') && !app.commandLine.hasSwitch('disable-web-security'));
    stage = 'mount-benign-viewer';
    await read(async () => {
      const { S } = await import('/state.js');
      const { createHtmlArtifactViewer } = await import('/html-artifact-viewer.js');
      const html = '<style>section{padding:20px}h2{font-size:20px}input,button{font:inherit;padding:8px}table{border-collapse:collapse;width:100%}td{padding:10px;border-bottom:1px solid var(--border)}img{width:120px;image-rendering:pixelated}</style>'
        + '<section><h2>交互报告 · Interactive report</h2><p>正常离线 fixture / state, focus and responsive layout</p>'
        + '<input id="entry" aria-label="备注" value="保留输入 state"><button id="count">0</button>'
        + '<details><summary>展开更多行 / Details</summary><p>' + '更多信息 '.repeat(80) + '</p></details>'
        + '<img alt="离线 raster" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=">'
        + '<table>' + Array.from({ length: 90 }, (_, i) => '<tr><td>Row ' + (i + 1) + '</td><td>良性长表 / preserved scroll</td></tr>').join('') + '</table></section>'
        + '<script>window.fixtureIdentity=Math.random();document.querySelector("#count").onclick=function(){this.textContent=String(Number(this.textContent)+1)}</script>';
      const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
      const id = await hash('C benign viewer fixture');
      const ref = { schemaVersion: 1, kind: 'html', id, contentRef: id, title: '交互报告 / Interactive report', sessionId: S.legacyOwner.sessionId,
        messageId: 'C-fixture', toolCallId: 'C-call', height: 320, createdAt: new Date().toISOString(), bytes: new TextEncoder().encode(html).length, digest: await hash(html) };
      const viewer = createHtmlArtifactViewer(ref, { scope: { conversationId: 'classic-chat', owner: S.legacyOwner }, fetcher: async () => ({ ok: true, artifact: ref, html }) });
      S.thread.append(viewer.node); viewer.mount(); window.fixtureViewer = viewer;
    });
    await until(() => read(() => document.querySelector('.html-artifact')?.dataset.state === 'ready'), 'artifact');
    const child = win.webContents.mainFrame.frames.find(frame => frame.name === 'pi-gui-html-artifact');
    if (!child) throw Error('no-artifact-frame');
    const childRead = code => child.executeJavaScript(code);
    const state = () => childRead('({identity:window.fixtureIdentity,input:document.querySelector("#entry").value,count:document.querySelector("#count").textContent,scroll:scrollY})');
    await childRead('document.querySelector("#entry").value="用户输入 retained";document.querySelector("#count").click()');
    const before = await state();
    check('benign-script-and-form', before.count === '1' && before.input === '用户输入 retained');
    stage = 'theme-size-matrix';
    for (const theme of ['dark', 'light']) for (const [label, width, height] of [['wide', 1320, 820], ['narrow', 700, 600]]) {
      win.setContentSize(width, height); await read(async mode => (await import('/theme.js')).setThemePreference(mode), theme);
      await h.sleep(250);
      await shot('inline-' + theme + '-' + label);
      await click('.html-artifact-expand');
      await until(() => read(() => document.querySelector('.html-artifact-surface').open), 'expanded');
      await h.sleep(150); await shot('expanded-' + theme + '-' + label);
      const facts = await read(() => { const d = document.querySelector('.html-artifact-surface'), r = d.getBoundingClientRect(); return { width: r.width, height: r.height, left: r.left, top: r.top, scrollHeight: d.querySelector('.html-artifact-viewport').scrollHeight, viewportHeight: d.querySelector('.html-artifact-viewport').clientHeight }; });
      check('dialog-bounds-' + theme + '-' + label, facts.left >= 0 && facts.top >= 0 && facts.width <= width && facts.height <= height && facts.scrollHeight > facts.viewportHeight, facts);
      await click('.html-artifact-surface [aria-label="放大"]');
      const zoom = await read(() => { const d = document.querySelector('.html-artifact-surface'); return { scale: d.dataset.zoom, mode: d.dataset.zoomMode, transform: d.querySelector('iframe').style.transform }; });
      check('zoom-' + theme + '-' + label, zoom.scale === '1.25' && zoom.mode === 'transform' && zoom.transform === 'scale(1.25)', zoom);
      if (theme === 'dark' && label === 'wide') await shot('zoom-125-dark-wide');
      await key('Escape'); await until(() => read(() => !document.querySelector('.html-artifact-surface').open), 'closed');
      check('return-focus-' + theme + '-' + label, await read(() => document.activeElement === document.querySelector('.html-artifact-expand')));
      const after = await state(); check('same-realm-' + theme + '-' + label, after.identity === before.identity && after.input === before.input && after.count === before.count, { retained: true });
    }
    stage = 'iframe-escape-and-tab';
    await click('.html-artifact-expand');
    await childRead('document.querySelector("#entry").focus()');
    await key('Escape'); await until(() => read(() => !document.querySelector('.html-artifact-surface').open), 'iframe-escape');
    check('escape-from-focused-frame', true);
    await click('.html-artifact-expand');
    await key('Tab');
    const next = await read(() => document.activeElement.tagName);
    check('tab-cannot-reach-background', await read(() => document.querySelector('.html-artifact-surface').contains(document.activeElement)), { tag: next });
    await key('Tab', 8);
    check('reverse-tab-stays-modal', await read(() => document.querySelector('.html-artifact-surface').contains(document.activeElement)));
    stage = 'dispose';
    await read(() => window.fixtureViewer.dispose());
    check('dispose-closes-native-dialog', await read(() => !document.querySelector('.html-artifact-surface').open && !document.querySelector('.html-artifact iframe')));
    report.completed = true;
  } catch (error) {
    report.failure = { stage, code: String(error.message).slice(0, 100) };
  } finally {
    if (win) try { await read(async () => { const { S } = await import('/state.js'); if (S.legacyOwner) await fetch('/api/runtime-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Gui-Owner': JSON.stringify(S.legacyOwner) }, body: JSON.stringify({ action: 'close', owner: S.legacyOwner }) }); }); } catch { report.ownerCleanup = 'unconfirmed'; }
    save(); app.quit();
  }
}
