'use strict';
// Production bootstrap/helper execution in jsdom with controlled dimensions.
// This is NOT pixel rendering, native navigation or Electron security evidence.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { clock } = require('./fixtures/html-artifact-d-clock.cjs');
const root = '../public/';

async function measuring(t, initial = {}) {
  const { installHtmlArtifactMeasurement } = await import(root + 'html-artifact-measure.js');
  const dom = new JSDOM('<p>controlled layout</p>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, time = clock(), reports = [], observers = [];
  time.attach(w);
  const metrics = { height: 320, width: 700, ...initial };
  const nativeRect = w.Element.prototype.getBoundingClientRect;
  w.Element.prototype.getBoundingClientRect = function () {
    return this === d.body ? { height: metrics.height, width: metrics.width, top: 0, bottom: metrics.height,
      left: 0, right: metrics.width } : nativeRect.call(this);
  };
  for (const [key, dimension] of [['scrollHeight', 'height'], ['scrollWidth', 'width']]) {
    Object.defineProperty(d.body, key, { get: () => metrics[key] ?? metrics[dimension] });
  }
  w.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.target = target; this.disconnected = false; }
    disconnect() { this.disconnected = true; }
  };
  const fonts = new w.EventTarget(); let resolveFonts;
  fonts.ready = new Promise(resolve => { resolveFonts = resolve; });
  Object.defineProperty(d, 'fonts', { value: fonts });
  const value = installHtmlArtifactMeasurement(w, snapshot => reports.push({ ...snapshot, at: time.now() }));
  d.dispatchEvent(new w.Event('DOMContentLoaded'));
  t.after(() => value.dispose());
  return { w, d, time, metrics, reports, observers, value, fonts, resolveFonts,
    sizes: () => reports.filter(report => report.type === 'resize') };
}

test('initial natural body measurement ignores document viewport scrollHeight', async t => {
  const s = await measuring(t, { height: 231.1, width: 602.2 });
  Object.defineProperty(s.d.documentElement, 'scrollHeight', { value: 900000 });
  s.time.advance(16);
  assert.equal(s.reports[0].type, 'ready');
  assert.equal(s.sizes()[0].height, 232); assert.equal(s.sizes()[0].naturalWidth, 603);
  assert.equal(s.sizes()[0].naturalHeight, 232); assert.equal(s.sizes()[0].capped, false);
});

test('long content and overflow descendants remain available in an internally scrollable 4096 viewport', async t => {
  const s = await measuring(t, { height: 300, scrollHeight: 15000 }); s.time.advance(16);
  assert.equal(s.sizes()[0].height, 4096); assert.equal(s.sizes()[0].naturalHeight, 15000);
  assert.equal(s.sizes()[0].capped, true);
  s.metrics.scrollHeight = 20000; s.value.queue(); s.time.advance(132);
  assert.equal(s.sizes().at(-1).naturalHeight, 20000);
});

test('font completion, image load, input and details toggle remeasure without replacing the document', async t => {
  const s = await measuring(t); s.time.advance(16);
  s.metrics.height = 400; s.resolveFonts(); await Promise.resolve(); s.time.advance(132);
  assert.equal(s.sizes().at(-1).height, 400);
  const image = s.d.createElement('img'); s.d.body.append(image);
  s.metrics.height = 450; image.dispatchEvent(new s.w.Event('load')); s.time.advance(132);
  assert.equal(s.sizes().at(-1).height, 450);
  s.metrics.height = 600; s.d.dispatchEvent(new s.w.Event('toggle')); s.time.advance(132);
  assert.equal(s.sizes().at(-1).height, 600);
  s.metrics.height = 390; s.d.dispatchEvent(new s.w.Event('input')); s.time.advance(132);
  assert.equal(s.sizes().at(-1).height, 390); assert.equal(s.d.querySelector('img'), image);
});

test('JS text/style mutation and collapsing a table preserve the final natural size', async t => {
  const s = await measuring(t); s.time.advance(16);
  s.metrics.height = 1200; s.d.body.append(s.d.createElement('table')); await Promise.resolve(); s.time.advance(132);
  assert.equal(s.sizes().at(-1).height, 1200);
  s.metrics.height = 180; s.d.querySelector('table').hidden = true; await Promise.resolve(); s.time.advance(132);
  assert.equal(s.sizes().at(-1).height, 180);
});

test('continuous resize observations merge and retain the last update at at most ten per second', async t => {
  const s = await measuring(t);
  for (let index = 0; index < 1000; index++) {
    s.metrics.height = 300 + index; s.observers[0].callback([]); s.time.advance(1);
  }
  s.time.advance(200);
  assert.ok(s.sizes().length <= 11); assert.equal(s.sizes().at(-1).height, 1299);
  for (let index = 1; index < s.sizes().length; index++) assert.ok(s.sizes()[index].at - s.sizes()[index - 1].at >= 100);
});

test('viewport-dependent height feedback stops growing until content or width actually changes', async t => {
  const s = await measuring(t, { height: 330 });
  s.w.innerHeight = 320; s.time.advance(16);
  s.w.innerHeight = 330; s.metrics.height = 340;
  s.w.dispatchEvent(new s.w.Event('resize')); s.time.advance(132);
  assert.equal(s.sizes().at(-1).height, 330); assert.equal(s.sizes().at(-1).capped, true);
  for (let index = 0; index < 5; index++) { s.observers[0].callback([]); s.time.advance(132); }
  assert.equal(s.sizes().at(-1).height, 330, 'duplicate observations must not release the feedback hold');
  s.w.innerWidth = 500; s.metrics.width = 500; s.metrics.height = 700;
  s.w.dispatchEvent(new s.w.Event('resize')); s.time.advance(132);
  assert.equal(s.sizes().at(-1).height, 700);
  s.metrics.height = 280; s.value.queue(); s.time.advance(132);
  assert.equal(s.sizes().at(-1).height, 280, 'a content revision can release the feedback hold');
});

test('height transitions recover the final size without releasing identical viewport feedback', async t => {
  const s = await measuring(t, { height: 200 }); s.w.innerHeight = 200; s.time.advance(16);
  s.metrics.height = 207; s.value.queue(); s.time.advance(132);
  s.w.innerHeight = 207; s.metrics.height = 261; s.observers[0].callback([]); s.time.advance(132);
  assert.equal(s.sizes().at(-1).height, 207);
  s.metrics.height = 313; s.observers[0].callback([]); s.time.advance(132);
  assert.equal(s.sizes().at(-1).height, 313, 'growth while the viewport is held is not caused by the host');
  s.w.innerHeight = 313; s.metrics.height = 600;
  s.d.querySelector('p').dispatchEvent(new s.w.Event('transitionend', { bubbles: true })); s.time.advance(132);
  assert.equal(s.sizes().at(-1).height, 600); assert.equal(s.sizes().at(-1).feedback, false);
  s.w.innerHeight = 600; s.metrics.height = 420;
  s.d.querySelector('p').dispatchEvent(new s.w.Event('transitioncancel', { bubbles: true })); s.time.advance(132);
  assert.equal(s.sizes().at(-1).height, 420); assert.equal(s.sizes().at(-1).capped, false);
});

test('feedback is explicit telemetry and repeated held observations cannot increase the viewport', async t => {
  const s = await measuring(t, { height: 330 }); s.w.innerHeight = 320; s.time.advance(16);
  assert.equal(s.sizes().at(-1).feedback, false);
  s.w.innerHeight = 330; s.metrics.height = 340;
  for (let i = 0; i < 20; i++) { s.observers[0].callback([]); s.time.advance(132); }
  assert.equal(s.sizes().at(-1).height, 330); assert.equal(s.sizes().at(-1).naturalHeight, 340);
  assert.equal(s.sizes().at(-1).feedback, true); assert.equal(s.sizes().length, 2);
});

test('hidden measurement disconnects and cancels work; restored width is measured once with final content', async t => {
  const s = await measuring(t); s.time.advance(16);
  s.value.queue(); s.value.setVisible(false); assert.equal(s.observers[0].disconnected, true);
  const count = s.sizes().length;
  s.metrics.width = 450; s.metrics.height = 700;
  s.value.queue(); s.time.advance(10000); assert.equal(s.sizes().length, count); assert.equal(s.time.tasks.size, 0);
  s.value.setVisible(true); s.time.advance(16);
  assert.equal(s.sizes().length, count + 1); assert.equal(s.sizes().at(-1).naturalWidth, 450);
});

test('zero-width and nonfinite measurements never overwrite a visible size; disposal cancels all work', async t => {
  const s = await measuring(t); s.time.advance(16);
  for (const [height, width] of [[NaN, 700], [300, 0], [Infinity, 700]]) {
    s.metrics.height = height; s.metrics.width = width; s.value.queue(); s.time.advance(132);
  }
  assert.equal(s.sizes().length, 1);
  s.metrics.height = 500; s.metrics.width = 700; s.value.queue(); s.value.dispose(); s.value.dispose(); s.time.advance(1000);
  assert.equal(s.sizes().length, 1); assert.equal(s.time.tasks.size, 0);
});

test('runtime pauses timers and animation callbacks without losing local interaction state', async () => {
  const { installHtmlArtifactRuntime } = await import(root + 'html-artifact-runtime.js');
  const time = clock(), runtime = installHtmlArtifactRuntime(time.view), local = { filter: 'chosen', count: 0 };
  let frames = 0;
  const interval = time.view.setInterval(function () { assert.equal(this, time.view); local.count++; }, 32);
  time.view.requestAnimationFrame(function () { assert.equal(this, time.view); frames++; }); time.advance(32);
  assert.equal(local.count, 1); assert.equal(frames, 1);
  runtime.setVisible(false); time.view.requestAnimationFrame(() => frames++); time.advance(100000);
  assert.equal(local.count, 1); assert.equal(frames, 1); assert.equal(time.tasks.size, 0);
  runtime.setVisible(true); time.advance(32);
  assert.equal(local.count, 2); assert.equal(frames, 2); assert.equal(local.filter, 'chosen');
  time.view.clearInterval(interval); runtime.dispose(); assert.equal(time.tasks.size, 0);
});

test('runtime timeout remaining delay, arguments, clearing and bounded callback budget are retained', async () => {
  const { installHtmlArtifactRuntime } = await import(root + 'html-artifact-runtime.js');
  const time = clock(), runtime = installHtmlArtifactRuntime(time.view), calls = [];
  time.view.setTimeout(value => calls.push(value), 100, 'done'); time.advance(40);
  runtime.setVisible(false); time.advance(10000); runtime.setVisible(true); time.advance(59);
  assert.deepEqual(calls, []); time.advance(1); assert.deepEqual(calls, ['done']);
  const handles = Array.from({ length: 256 }, () => time.view.setTimeout(() => {}, 1000));
  assert.ok(handles.every(Boolean)); assert.equal(time.view.setTimeout(() => {}, 1000), 0);
  handles.forEach(time.view.clearTimeout); assert.equal(time.tasks.size, 0);
  runtime.dispose(); runtime.dispose(); assert.equal(time.view.requestAnimationFrame(() => {}), 0);
});

test('timer clearing converts native long handles and timeout/interval clearers are interchangeable', async () => {
  const { installHtmlArtifactRuntime } = await import(root + 'html-artifact-runtime.js');
  const time = clock(), runtime = installHtmlArtifactRuntime(time.view); let calls = 0;
  for (const set of ['setTimeout', 'setInterval']) for (const clear of ['clearTimeout', 'clearInterval']) {
    for (const convert of [String, id => ({ valueOf: () => id }), id => id + 0.75, id => id + 2 ** 32]) {
      const handle = time.view[set](() => calls++, 32);
      assert.equal(time.view[clear](convert(handle)), undefined);
      time.advance(96);
      assert.equal(calls, 0, `${set}/${clear} must convert its handle before lookup`);
      assert.equal(time.tasks.size, 0);
    }
  }
  for (const invalid of [NaN, Infinity, -Infinity, undefined, null, 'not-a-handle']) {
    assert.equal(time.view.clearTimeout(invalid), undefined);
  }
  assert.throws(() => time.view.clearTimeout(Symbol()), TypeError);
  assert.throws(() => time.view.clearInterval(1n), TypeError);
  const frame = time.view.requestAnimationFrame(() => calls++);
  time.view.clearTimeout(frame); time.advance(16); assert.equal(calls, 1, 'timer clearers do not cancel animation frames');
  const timeout = time.view.setTimeout(() => calls++, 32);
  time.view.cancelAnimationFrame(timeout); time.advance(32); assert.equal(calls, 2, 'rAF canceller does not cancel timers');
  const nextFrame = time.view.requestAnimationFrame(() => calls++);
  time.view.cancelAnimationFrame(String(nextFrame)); time.advance(32); assert.equal(calls, 2);
  runtime.dispose(); assert.equal(time.tasks.size, 0);
});

async function bootstrap(t, html, configuration = {}, beforeParse = () => {}) {
  const { htmlArtifactDocument } = await import(root + 'html-artifact-frame.js');
  const reports = [], time = clock();
  const dom = new JSDOM(htmlArtifactDocument(html, { id: 'fixture-id', nonce: 'fixture-nonce',
    hostOrigin: 'http://fixture.invalid', theme: { colorScheme: 'dark', values: { background: '#181818', foreground: '#ffffff' } },
    ...configuration }), { url: 'http://fixture.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      time.attach(w); w.postMessage = (data, origin) => reports.push({ data, origin });
      w.ResizeObserver = class { observe() {} disconnect() {} };
      beforeParse(w);
    } });
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); });
  await new Promise(resolve => setImmediate(resolve));
  return { w: dom.window, d: dom.window.document, reports, time,
    send(data, extra = {}) { dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window,
      origin: 'http://fixture.invalid', data: { schemaVersion: 1, id: 'fixture-id', nonce: 'fixture-nonce', ...data }, ...extra })); } };
}

test('serialized production bootstrap applies the first theme before parsing content and keeps v1 ready envelope', async t => {
  const s = await bootstrap(t, '<script>window.firstColor=document.documentElement.style.getPropertyValue("--background")</script><p>body</p>');
  assert.equal(s.w.firstColor, '#181818'); assert.equal(s.d.documentElement.style.colorScheme, 'dark');
  const ready = s.reports.find(row => row.data.type === 'ready');
  assert.equal(ready.data.schemaVersion, 1); assert.equal(ready.data.id, 'fixture-id');
  assert.equal(ready.data.nonce, 'fixture-nonce'); assert.equal(ready.origin, 'http://fixture.invalid');
  assert.match(s.d.querySelector('style').textContent, /overflow:auto;overscroll-behavior:auto/);
});

test('theme and visibility messages keep the same document, input and timer state and reject stale envelopes', async t => {
  const s = await bootstrap(t, '<input value="original"><script>window.ticks=0;setInterval(()=>window.ticks++,32)</script>');
  const input = s.d.querySelector('input'); input.value = 'chosen'; s.time.advance(32);
  s.send({ type: 'visibility', visible: false, nonce: 'old' }); s.time.advance(32); assert.equal(s.w.ticks, 2);
  s.send({ type: 'visibility', visible: false }); s.time.advance(10000); assert.equal(s.w.ticks, 2);
  s.send({ type: 'theme', theme: { colorScheme: 'light', values: { background: '#ffffff', 'not-allowed': 'x' } } });
  assert.equal(s.d.documentElement.style.colorScheme, 'light');
  assert.equal(s.d.documentElement.style.getPropertyValue('--not-allowed'), '');
  s.send({ type: 'visibility', visible: true }); s.time.advance(32); assert.equal(s.w.ticks, 3);
  assert.equal(s.d.querySelector('input'), input); assert.equal(input.value, 'chosen');
});

test('presentation saves before ACK and restores only local XY after two native RAFs even when runtime is paused', async t => {
  const moves = [];
  const s = await bootstrap(t, '<input value="kept">', {}, w => {
    w.scrollX = 80; w.scrollY = 7904;
    w.scrollTo = options => { moves.push(options); w.scrollX = options.left; w.scrollY = options.top; };
  });
  const acks = () => s.reports.filter(row => row.data.type === 'presentation-ready');
  s.send({ type: 'visibility', visible: false });
  s.send({ type: 'presentation', expanded: true, sequence: 1 });
  assert.equal(acks().length, 1, 'save ACK is immediate, not in a controlled timer');
  assert.deepEqual({ ...acks()[0].data }, { schemaVersion: 1, id: 'fixture-id', nonce: 'fixture-nonce',
    type: 'presentation-ready', expanded: true, sequence: 1 });
  s.w.scrollX = 0; s.w.scrollY = 0; // host expansion may clamp only AFTER the save ACK.
  s.send({ type: 'presentation', expanded: true, sequence: 2 }); // no overwrite of the inline save.
  s.send({ type: 'presentation', expanded: false, sequence: 3 });
  assert.equal(moves.length, 0); s.time.advance(16); assert.equal(moves.length, 0);
  s.time.advance(16); assert.equal(moves.length, 1);
  assert.equal(moves[0].left, 80); assert.equal(moves[0].top, 7904); assert.equal(moves[0].behavior, 'instant');
  assert.equal(acks().at(-1).data.sequence, 3); assert.equal(acks().at(-1).data.expanded, false);
  assert.equal(s.w.scrollY, 7904); assert.equal(s.d.querySelector('input').value, 'kept');
});

test('presentation rejects extra fields, stale sequence and wrong identities and cancels restore on disposal', async t => {
  const moves = [];
  const s = await bootstrap(t, '<p>local</p>', {}, w => { w.scrollTo = options => moves.push(options); });
  const acks = () => s.reports.filter(row => row.data.type === 'presentation-ready');
  for (const sequence of [0, -1, 1.5, '1', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    s.send({ type: 'presentation', expanded: true, sequence });
  }
  s.send({ type: 'presentation', expanded: true, sequence: 1, scrollY: 50 });
  s.send({ type: 'presentation', expanded: true, sequence: 1, nonce: 'stale' });
  s.send({ type: 'presentation', expanded: true, sequence: 1 }, { origin: 'http://other.invalid' });
  s.send({ type: 'presentation', expanded: true, sequence: 1 }, { source: null });
  assert.equal(acks().length, 0);
  s.send({ type: 'presentation', expanded: true, sequence: 1 });
  s.send({ type: 'presentation', expanded: true, sequence: 1 });
  assert.equal(acks().length, 1);
  s.send({ type: 'presentation', expanded: false, sequence: 2 });
  s.time.advance(16); s.w.dispatchEvent(new s.w.Event('pagehide')); s.time.advance(100);
  assert.equal(moves.length, 0); assert.equal(acks().length, 1); assert.equal(s.time.tasks.size, 0);
  s.send({ type: 'presentation', expanded: true, sequence: 3 }); assert.equal(acks().length, 1);
});

test('synthetic DOM clicks cannot claim an external link or image action and no wheel RPC is emitted', async t => {
  const s = await bootstrap(t, '<a href="https://example.invalid/">link</a><img alt="sample" src="data:image/png;base64,YQ==">');
  for (const node of s.d.querySelectorAll('a,img')) node.dispatchEvent(new s.w.MouseEvent('click', { bubbles: true, cancelable: true }));
  s.d.body.dispatchEvent(new s.w.WheelEvent('wheel', { bubbles: true, deltaY: 500 }));
  assert.equal(s.reports.filter(row => ['link', 'image', 'wheel'].includes(row.data.type)).length, 0);
});

test('resolved theme vocabulary covers T3 surfaces, foreground pairs, fonts and focus using shared tokens', async t => {
  const { HTML_ARTIFACT_THEME_TOKENS, readHtmlArtifactTheme } = await import(root + 'html-artifact-theme.js');
  const dom = new JSDOM('<p>theme</p>', { pretendToBeVisual: true }); t.after(() => dom.window.close());
  const d = dom.window.document;
  for (const token of Object.values(HTML_ARTIFACT_THEME_TOKENS)) d.documentElement.style.setProperty(token, token.includes('font') ? 'system-ui' : '#123456');
  d.documentElement.style.setProperty('--font-scale', '1.25'); d.documentElement.dataset.theme = 'light';
  const theme = readHtmlArtifactTheme(d);
  for (const key of ['popover', 'popover-foreground', 'secondary', 'secondary-foreground', 'input', 'ring',
    'accent-surface', 'accent-surface-foreground', 'destructive-surface', 'warning-foreground',
    'success-foreground', 'info-foreground', 'code-background', 'code-foreground', 'chart-6']) {
    assert.equal(theme.values[key], '#123456', key);
  }
  assert.equal(theme.values['font-size'], '17.5px'); assert.equal(theme.colorScheme, 'light');
  assert.equal(HTML_ARTIFACT_THEME_TOKENS['muted-foreground'], '--ds-text-secondary');
});
