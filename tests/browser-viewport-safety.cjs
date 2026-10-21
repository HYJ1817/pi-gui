'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { test } = require('node:test');

// Exercise the product controller; only Electron's native boundary is mocked.
function fixture(t) {
  const children = new Set(), views = [], events = [], handlers = new Map();
  let zoom = 1, visible = true, content = { width: 1000, height: 800 };
  const sessions = new Map();
  const electron = {
    session: { fromPartition(name) {
      if (!sessions.has(name)) {
        const session = new EventEmitter();
        session.setPermissionRequestHandler = fn => { session.permissionRequest = fn; };
        session.setPermissionCheckHandler = fn => { session.permissionCheck = fn; };
        sessions.set(name, session);
      }
      return sessions.get(name);
    } },
    shell: { openExternal: async () => {} },
    WebContentsView: class {
      constructor(options) {
        this.options = options;
        this.webContents = new EventEmitter();
        const wc = this.webContents;
        wc.session = electron.session.fromPartition(options.webPreferences.partition);
        wc.loads = [];
        wc.loadURL = async url => { wc.loads.push(url); wc.url = url; };
        wc.getURL = () => wc.url;
        wc.getTitle = () => 'fixture';
        wc.isDestroyed = () => wc.closed === true;
        wc.close = () => { wc.closed = true; wc.emit('destroyed'); };
        wc.setWindowOpenHandler = fn => { wc.windowOpen = fn; };
        wc.navigationHistory = {
          canGoBack: () => false, canGoForward: () => false,
          goBack() {}, goForward() {},
        };
        wc.reload = () => { wc.reloads = (wc.reloads || 0) + 1; };
        wc.stop = () => {};
        views.push(this);
      }
      setBackgroundColor() {}
      setBounds(rect) { this.bounds = { ...rect }; events.push(['bounds', { ...rect }]); }
    },
  };
  const win = {
    isDestroyed: () => false,
    webContents: { send() {}, getZoomFactor: () => zoom },
    getContentBounds: () => ({ ...content }),
    contentView: {
      addChildView(view) { events.push(['add', view.bounds && { ...view.bounds }]); children.add(view); },
      removeChildView(view) { events.push(['remove']); children.delete(view); },
    },
  };
  const filename = require.resolve('../electron/browser-view.cjs');
  const originalLoad = Module._load;
  let createBrowserController;
  try {
    delete require.cache[filename];
    Module._load = function (name, ...args) {
      return name === 'electron' ? electron : originalLoad.call(this, name, ...args);
    };
    ({ createBrowserController } = require(filename));
  } finally {
    Module._load = originalLoad;
    delete require.cache[filename];
  }
  const controller = createBrowserController({
    origin: 'http://127.0.0.1:7788', getWindow: () => win,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    isVisible: () => visible,
  });
  controller.register();
  t.after(() => controller.destroy());
  return {
    controller, children, views, events, sessions,
    view: () => views.at(-1),
    zoom: value => { zoom = value; },
    visible: value => { visible = value; },
    content: value => { content = value; },
    ipc: (name, ...args) => handlers.get(`pi-gui:browser-${name}`)({}, ...args),
  };
}

const rect = { x: 100, y: 80, width: 400, height: 240 };
const moved = { x: 500, y: 300, width: 300, height: 200 };

test('open creates a live but detached page until valid geometry arrives', t => {
  const f = fixture(t);
  assert.deepEqual(f.controller.open(), { ok: true });
  assert.equal(f.controller.getState().open, true);
  assert.equal(f.controller.getWebContents(), f.view().webContents);
  assert.equal(f.children.size, 0);
  assert.equal(f.events.some(e => e[0] === 'add'), false);
});

for (const zoom of [1, 1.25, 0.8]) {
  test(`CSS geometry becomes DIP exactly once at zoom ${zoom}`, t => {
    const f = fixture(t);
    f.zoom(zoom);
    f.controller.open();
    f.controller.setBounds(rect);
    const expected = Object.fromEntries(Object.entries(rect).map(([k, v]) => [k, Math.round(v * zoom)]));
    assert.deepEqual(f.view().bounds, expected);
    assert.equal(f.children.has(f.view()), true);
    f.controller.syncBounds();
    f.controller.open();
    assert.deepEqual(f.view().bounds, expected);
    for (const event of f.events.filter(e => e[0] === 'add')) assert.deepEqual(event[1], expected);
    assert.equal(f.events.findIndex(e => e[0] === 'bounds') < f.events.findIndex(e => e[0] === 'add'), true);
  });
}

test('syncBounds reads current GUI zoom from retained CSS geometry', t => {
  const f = fixture(t);
  f.controller.open(); f.controller.setBounds(rect);
  f.zoom(1.25); f.controller.syncBounds();
  assert.deepEqual(f.view().bounds, { x: 125, y: 100, width: 500, height: 300 });
  f.zoom(0.8); f.controller.syncBounds();
  assert.deepEqual(f.view().bounds, { x: 80, y: 64, width: 320, height: 192 });
});

for (const [name, value] of [['NaN', NaN], ['positive infinity', Infinity], ['negative infinity', -Infinity]]) {
  for (const field of ['x', 'y', 'width', 'height']) {
    test(`${name} in ${field} detaches instead of clamping invalid input into a page`, t => {
      const f = fixture(t);
      f.controller.open(); f.controller.setBounds(rect);
      f.controller.setBounds({ ...rect, [field]: value });
      assert.equal(f.children.size, 0);
      f.controller.open(); f.controller.syncBounds(); f.controller.setOccluded(false);
      assert.equal(f.children.size, 0);
    });
  }
}

for (const [field, value] of [['width', 0], ['height', 0], ['width', -1], ['height', -1], ['width', 0.01]]) {
  test(`${field}=${value} leaves no usable native rectangle`, t => {
    const f = fixture(t);
    f.controller.open(); f.controller.setBounds(rect);
    f.controller.setBounds({ ...rect, [field]: value });
    assert.equal(f.children.size, 0);
  });
}

test('negative origins and oversize dimensions retain client-area clamping after zoom', t => {
  const f = fixture(t);
  f.zoom(1.25); f.controller.open();
  f.controller.setBounds({ x: -40, y: -20, width: 2000, height: 2000 });
  assert.deepEqual(f.view().bounds, { x: 0, y: 0, width: 1000, height: 800 });
  f.controller.setBounds({ x: 720, y: 600, width: 400, height: 200 });
  assert.deepEqual(f.view().bounds, { x: 900, y: 750, width: 100, height: 50 });
});

test('fully outside or zero-size client area detaches the native view', t => {
  const f = fixture(t);
  f.controller.open(); f.controller.setBounds(rect);
  f.controller.setBounds({ ...rect, x: 1200 });
  assert.equal(f.children.size, 0);
  f.controller.setBounds(rect);
  f.content({ width: 0, height: 0 }); f.controller.syncBounds();
  assert.equal(f.children.size, 0);
});

for (const zoom of [0, NaN, Infinity, -1]) {
  test(`invalid GUI zoom ${zoom} detaches fail-closed`, t => {
    const f = fixture(t);
    f.controller.open(); f.controller.setBounds(rect);
    f.zoom(zoom); f.controller.syncBounds();
    assert.equal(f.children.size, 0);
  });
}

test('occlusion invalidates old geometry; unocclusion and open cannot reuse it', t => {
  const f = fixture(t);
  f.controller.open(); f.controller.setBounds(rect);
  f.controller.setOccluded(true);
  f.events.length = 0;
  f.controller.setOccluded(false); f.controller.open(); f.controller.syncBounds();
  assert.equal(f.children.size, 0);
  assert.equal(f.events.some(e => e[0] === 'add'), false);
  f.controller.setBounds(moved);
  assert.deepEqual(f.events.at(-1), ['add', moved]);
});

test('occluded geometry updates stay detached and apply latest bounds before add', t => {
  const f = fixture(t);
  f.controller.open(); f.controller.setBounds(rect);
  const wc = f.controller.getWebContents(), generation = f.controller.getGeneration();
  f.controller.setOccluded(true);
  f.events.length = 0;
  f.controller.setBounds(rect); f.controller.setBounds(moved);
  assert.equal(f.children.size, 0);
  assert.equal(f.events.some(e => e[0] === 'add'), false);
  f.controller.setOccluded(false);
  assert.deepEqual(f.events.at(-2), ['bounds', moved]);
  assert.deepEqual(f.events.at(-1), ['add', moved]);
  assert.equal(f.controller.getWebContents(), wc);
  assert.equal(f.controller.getGeneration(), generation);
  assert.deepEqual(wc.loads, ['about:blank']);
});

test('invalid geometry while occluded cannot restore the previous valid bounds', t => {
  const f = fixture(t);
  f.controller.open(); f.controller.setBounds(rect); f.controller.setOccluded(true);
  f.controller.setBounds(moved); f.controller.setBounds({ ...moved, width: 0 });
  f.controller.setOccluded(false);
  assert.equal(f.children.size, 0);
});

test('background visibility never exposes a view', t => {
  const f = fixture(t);
  f.visible(false); f.controller.open(); f.controller.setBounds(rect);
  assert.equal(f.children.size, 0);
  f.visible(true); f.controller.setOccluded(false);
  assert.equal(f.children.size, 1);
  f.visible(false); f.controller.syncBounds();
  assert.equal(f.children.size, 0);
});

test('close clears the previous rectangle even when the next view is opened', t => {
  const f = fixture(t);
  f.controller.open(); f.controller.setBounds(rect);
  const old = f.view();
  f.controller.close(); f.controller.open(); f.controller.setOccluded(false);
  assert.equal(old.webContents.closed, true);
  assert.equal(f.children.size, 0);
  f.controller.setBounds(moved);
  assert.deepEqual(f.view().bounds, moved);
});

test('IPC open, bounds and occlusion use the same guarded geometry path', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.ipc('open'), { ok: true });
  assert.equal(f.children.size, 0);
  f.zoom(1.25);
  assert.deepEqual(await f.ipc('set-bounds', rect), { ok: true });
  assert.deepEqual(f.view().bounds, { x: 125, y: 100, width: 500, height: 300 });
  await f.ipc('set-occluded', true); await f.ipc('set-occluded', false);
  assert.equal(f.children.size, 0);
  await f.ipc('set-bounds', moved);
  assert.equal(f.children.size, 1);
  await f.ipc('command', 'close'); await f.ipc('open');
  assert.equal(f.children.size, 0);
});

test('20 open, relocate and close cycles leave no native views or live pages', t => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) {
    f.controller.open();
    assert.equal(f.children.size, 0, `cycle ${i}: no retained rectangle`);
    f.controller.setBounds(rect);
    assert.equal(f.children.size, 1);
    f.controller.setOccluded(true); f.controller.setBounds(moved); f.controller.setOccluded(false);
    assert.equal(f.children.size, 1);
    assert.deepEqual(f.view().bounds, moved);
    f.controller.close();
    assert.equal(f.children.size, 0);
  }
  assert.equal(f.views.length, 20);
  assert.equal(f.views.every(v => v.webContents.closed), true);
});

test('geometry does not change navigation, session isolation or lifecycle semantics', async t => {
  const f = fixture(t), lifecycle = [];
  f.controller.subscribeLifecycle(event => lifecycle.push(event.type));
  f.controller.setOccluded(true); f.controller.open();
  await f.controller.ready();
  assert.equal(f.controller.navigate('http://127.0.0.1:7802/fixture').ok, true);
  assert.equal(f.controller.navigate('file:///private').ok, false);
  f.controller.command('reload');
  assert.equal(f.view().webContents.reloads, 1);
  const prefs = f.view().options.webPreferences;
  assert.equal(prefs.partition.startsWith('persist:'), false);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal('preload' in prefs, false);
  assert.equal(f.view().webContents.session.permissionCheck(), false);
  f.controller.setBounds(rect); f.controller.setOccluded(false);
  f.controller.close();
  assert.deepEqual(lifecycle, ['created', 'manual', 'manual', 'closed']);
});
