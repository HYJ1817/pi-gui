/* Theme display contract. All persistence is an os.tmpdir fixture. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
let checks = 0;
const check = (name, run) => { run(); checks++; console.log('ok ' + name); };
const moduleFile = path.join(root, 'electron/theme.cjs');
check('desktop theme controller exists', () => assert.ok(fs.existsSync(moduleFile), 'missing display theme controller'));
const { createDesktopTheme, THEME_PALETTE } = require(moduleFile);
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-theme-'));
function fixture(file = path.join(world, 'theme.json')) {
  const ipc = new EventEmitter(); ipc.handlers = new Map();
  ipc.handle = (k, f) => ipc.handlers.set(k, f); ipc.removeHandler = k => ipc.handlers.delete(k);
  const native = new EventEmitter(); native.shouldUseDarkColors = false;
  const sent = [], backgrounds = [], overlays = [];
  const frame = { url: 'http://127.0.0.1:18741/' };
  const wc = { mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url, send: (k, v) => sent.push([k, v]) };
  const win = { webContents: wc, isDestroyed: () => false, setBackgroundColor: c => backgrounds.push(c), setTitleBarOverlay: o => overlays.push(o) };
  const manager = createDesktopTheme({ ipcMain: ipc, nativeTheme: native, getWindow: () => win, origin: 'http://127.0.0.1:18741', preferenceFile: file });
  manager.register(); manager.applyWindow();
  const event = () => ({ sender: wc, senderFrame: frame });
  return { manager, ipc, native, win, frame, event, sent, backgrounds, overlays, file };
}
(async () => {
  try {
    const x = fixture();
    check('default stays dark even on light OS', () => assert.equal(x.manager.snapshot().resolved, 'dark'));
    check('native initial window and overlay share background', () => {
      assert.equal(x.manager.windowOptions().backgroundColor, THEME_PALETTE.dark.background);
      assert.equal(x.overlays.at(-1).color, x.backgrounds.at(-1));
      assert.equal(x.overlays.at(-1).height, 46);
    });
    const get = e => { x.ipc.emit('pi-gui:theme-snapshot', e); return e.returnValue; };
    check('trusted preload receives only bounded snapshot fields', () => {
      assert.deepEqual(Object.keys(get(x.event())).sort(), ['persisted', 'preference', 'resolved', 'revision']);
    });
    for (const mode of ['light', 'dark', 'system']) {
      const result = await x.ipc.handlers.get('pi-gui:theme-set')(x.event(), mode);
      check('fixed enum accepted ' + mode, () => { assert.equal(result.ok, true); assert.equal(x.manager.snapshot().preference, mode); });
    }
    for (const mode of [null, true, 1, {}, ['light'], 'Light', '#fff', 'system ', '../../x']) {
      const before = x.manager.snapshot();
      const result = await x.ipc.handlers.get('pi-gui:theme-set')(x.event(), mode);
      check('invalid input rejected ' + JSON.stringify(mode), () => { assert.equal(result.ok, false); assert.deepEqual(x.manager.snapshot(), before); });
    }
    for (const event of [{ sender: {}, senderFrame: x.frame }, { sender: x.win.webContents, senderFrame: { url: x.frame.url } }, { sender: x.win.webContents, senderFrame: null }]) {
      check('untrusted snapshot refused', () => assert.equal(get(event), null));
      const before = fs.readFileSync(x.file, 'utf8');
      const result = await x.ipc.handlers.get('pi-gui:theme-set')(event, 'light');
      check('untrusted mutation cannot persist', () => { assert.equal(result.ok, false); assert.equal(fs.readFileSync(x.file, 'utf8'), before); });
    }
    x.frame.url = 'http://127.0.0.1:18741.evil.test/';
    check('origin prefix spoof refused', () => assert.equal(get(x.event()), null));
    x.frame.url = 'http://127.0.0.1:18741/';
    x.native.shouldUseDarkColors = true; x.native.emit('updated');
    check('system OS update repaints native overlay', () => { assert.equal(x.manager.snapshot().resolved, 'dark'); assert.equal(x.overlays.at(-1).color, THEME_PALETTE.dark.background); });
    await x.ipc.handlers.get('pi-gui:theme-set')(x.event(), 'light');
    x.native.shouldUseDarkColors = true; x.native.emit('updated');
    check('explicit light ignores OS change', () => assert.equal(x.manager.snapshot().resolved, 'light'));
    const y = fixture(x.file);
    check('restart restores preference before window creation', () => { assert.equal(y.manager.snapshot().preference, 'light'); assert.equal(y.manager.windowOptions().titleBarOverlay.color, THEME_PALETTE.light.background); });
    y.manager.dispose(); x.manager.dispose();
    check('dispose removes owned IPC and native listener', () => { assert.equal(x.ipc.handlers.size, 0); assert.equal(x.native.listenerCount('updated'), 0); });
    fs.writeFileSync(x.file, '{bad json');
    const bad = fixture(x.file);
    check('corrupt preference defaults dark without overwriting file', () => { assert.equal(bad.manager.snapshot().preference, 'dark'); assert.equal(fs.readFileSync(x.file, 'utf8'), '{bad json'); }); bad.manager.dispose();
    const blocked = fixture(path.join(world, 'parent-file', 'theme.json')); fs.writeFileSync(path.join(world, 'parent-file'), 'file');
    const result = await blocked.ipc.handlers.get('pi-gui:theme-set')(blocked.event(), 'light');
    check('storage failure keeps display usable and reports persistence status', () => { assert.equal(result.ok, true); assert.equal(result.snapshot.persisted, false); assert.equal(result.snapshot.resolved, 'light'); assert.ok(!JSON.stringify(result).includes(world)); }); blocked.manager.dispose();
    const init = fs.readFileSync(path.join(root, 'public/theme-init.js'), 'utf8');
    for (const [pref, osDark, expected] of [['dark', false, 'dark'], ['light', true, 'light'], ['system', true, 'dark'], ['system', false, 'light'], ['nonsense', false, 'dark']]) {
      const dom = new JSDOM('<html><head></head><body></body></html>', { url: 'http://fixture', runScripts: 'outside-only' });
      dom.window.localStorage.setItem('pi-gui.theme.v1', pref); dom.window.matchMedia = () => ({ matches: osDark }); dom.window.eval(init);
      check('blocking web initializer resolves ' + pref + '/' + osDark, () => assert.equal(dom.window.document.documentElement.dataset.theme, expected)); dom.window.close();
    }
    const dom = new JSDOM('<html><head></head><body></body></html>', { url: 'http://fixture', runScripts: 'outside-only' });
    dom.window.localStorage.setItem('pi-gui.theme.v1', 'dark'); dom.window.piGuiDesktop = { theme: { initial: { preference: 'light', resolved: 'light', revision: 7, persisted: true } } }; dom.window.eval(init);
    check('desktop startup authority wins over renderer storage', () => assert.equal(dom.window.document.documentElement.dataset.theme, 'light')); dom.window.close();
    const { bundle } = require('./esm-bundle.cjs');
    const renderer = bundle(path.join(root, 'public/theme.js')).code;
    function web(storageFails = false) {
      const dom = new JSDOM('<html><body></body></html>', { url: 'http://fixture', runScripts: 'outside-only' });
      let change;
      const media = { matches: false, addEventListener: (_name, fn) => { change = fn; } };
      dom.window.matchMedia = () => media;
      if (storageFails) dom.window.Storage.prototype.setItem = () => { throw new Error('denied'); };
      dom.window.eval(renderer);
      return { dom, w: dom.window, media, change: () => change() };
    }
    const webTheme = web();
    await webTheme.w.setThemePreference('system'); webTheme.media.matches = true; webTheme.change();
    check('real renderer System responds to media updates', () => assert.equal(webTheme.w.document.documentElement.dataset.theme, 'dark'));
    await webTheme.w.setThemePreference('light'); webTheme.change();
    check('real renderer explicit light ignores media update and persists', () => { assert.equal(webTheme.w.document.documentElement.dataset.theme, 'light'); assert.equal(webTheme.w.localStorage.getItem('pi-gui.theme.v1'), 'light'); });
    check('real renderer refuses invalid preference', () => assert.equal(webTheme.w.themePreference(), 'light'));
    assert.equal(await webTheme.w.setThemePreference('invalid'), false); webTheme.dom.window.close();
    const blockedWeb = web(true); let observed;
    const unsubscribe = blockedWeb.w.onThemeChange(s => { observed = s; });
    await blockedWeb.w.setThemePreference('light');
    check('real renderer persistence failure reports memory-only display', () => { assert.equal(observed.persisted, false); assert.equal(blockedWeb.w.document.documentElement.dataset.theme, 'light'); });
    unsubscribe(); observed = null; await blockedWeb.w.setThemePreference('dark');
    check('renderer unsubscribe releases listener', () => assert.equal(observed, null)); blockedWeb.dom.window.close();
    const desktopDom = new JSDOM('<html><body></body></html>', { url: 'http://fixture', runScripts: 'outside-only' });
    let event, resolveSet;
    desktopDom.window.piGuiDesktop = { theme: {
      snapshot: () => ({ preference: 'dark', resolved: 'dark', revision: 2 }),
      onChange: fn => { event = fn; fn({ preference: 'light', resolved: 'light', revision: 3 }); },
      set: () => new Promise(resolve => { resolveSet = resolve; }),
    } };
    desktopDom.window.eval(renderer);
    check('renderer receives replay newer than initial snapshot', () => assert.equal(desktopDom.window.themePreference(), 'light'));
    const pending = desktopDom.window.setThemePreference('dark');
    event({ preference: 'system', resolved: 'light', revision: 5 });
    resolveSet({ ok: true, snapshot: { preference: 'dark', resolved: 'dark', revision: 4 } });
    check('late IPC response cannot overwrite newer system event', () => assert.equal(desktopDom.window.themePreference(), 'system'));
    const pendingResult = await pending;
    check('stale preference request reports not applied', () => assert.equal(pendingResult, false));
    desktopDom.window.close();
    const vm = require('node:vm'), preload = fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8');
    for (const enabled of [false, true]) {
      let calls = 0, bridge;
      const ipc = new EventEmitter(); ipc.sendSync = () => { calls++; return { preference: 'dark', resolved: 'dark', revision: 0 }; }; ipc.invoke = async () => ({});
      vm.runInNewContext(preload, { process: { argv: enabled ? ['--pi-gui-theme-bridge'] : [] }, require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } } }) });
      check('preload opt-in avoids unknown synchronous channel ' + enabled, () => { assert.equal(calls, enabled ? 1 : 0); assert.equal(!!bridge.theme, enabled); assert.equal(typeof bridge.openPath, 'function'); });
      if (enabled) {
        ipc.emit('pi-gui:theme-changed', {}, { preference: 'light', resolved: 'light', revision: 2 });
        let latest; bridge.theme.onChange(s => { latest = s; });
        check('preload caches event before module subscription and replays it', () => assert.equal(latest.revision, 2));
        ipc.emit('pi-gui:theme-changed', {}, { preference: 'dark', resolved: 'dark', revision: 1 });
        check('preload ignores delayed event revision', () => assert.equal(bridge.theme.snapshot().revision, 2));
      }
    }
    console.log(`Theme display: ${checks}/${checks}; failed=0; fixture persistence and IPC; not layout evidence`);
  } finally { assert.equal(path.dirname(world), os.tmpdir()); fs.rmSync(world, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
