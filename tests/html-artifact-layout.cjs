'use strict';
// Offline helper behavior, not a browser layout/sandbox qualification.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { clock } = require('./fixtures/html-artifact-d-clock.cjs');
const load = () => import('../public/html-artifact-layout.js');

async function controller(options = {}) {
  const { createHtmlArtifactResizeController } = await load();
  const time = clock(), writes = [];
  const value = createHtmlArtifactResizeController({ view: time.view,
    apply: snapshot => writes.push({ ...snapshot, at: time.now() }), ...options });
  return { time, writes, value };
}

test('v1 height remains compatible, rounded and bounded', async () => {
  const { time, writes, value } = await controller();
  value.accept({ height: 319.2 }); time.advance(16);
  assert.equal(writes[0].height, 320);
  value.accept({ height: 999999 }); time.advance(132);
  assert.equal(writes[1].height, 4096); assert.equal(writes[1].capped, true);
  value.accept({ height: -5 }); time.advance(132);
  assert.equal(writes[2].height, 80);
  value.dispose(); assert.equal(time.tasks.size, 0);
});

test('invalid dimensions and field types never schedule a write', async () => {
  const { time, writes, value } = await controller();
  for (const input of [null, [], {}, { height: '300' }, { height: NaN }, { height: Infinity },
    { height: 300, naturalHeight: -1 }, { height: 300, naturalWidth: Infinity }, { height: 300, capped: 1 }]) {
    assert.equal(value.accept(input), false);
  }
  time.advance(1000); assert.equal(writes.length, 0); assert.equal(time.tasks.size, 0);
});

test('extended natural dimensions are bounded independently of the viewport', async () => {
  const { time, writes, value } = await controller();
  value.accept({ height: 4096, naturalHeight: 12000.3, naturalWidth: 5000000, capped: true }); time.advance(16);
  assert.equal(writes[0].naturalHeight, 12001); assert.equal(writes[0].naturalWidth, 1000000);
  assert.equal(writes[0].height, 4096);
});

test('feedback classification is preserved, rejects non-booleans and stays absent for old v1', async () => {
  const { time, writes, value } = await controller();
  assert.equal(value.accept({ height: 330, naturalHeight: 340, feedback: true }), true); time.advance(16);
  assert.equal(writes[0].feedback, true); assert.equal(writes[0].naturalHeight, 340);
  assert.equal(value.accept({ height: 600, naturalHeight: 600, feedback: false }), true); time.advance(132);
  assert.equal(writes[1].feedback, false);
  for (const feedback of [null, 1, 'false', {}]) assert.equal(value.accept({ height: 400, feedback }), false);
  value.accept({ height: 400 }); time.advance(132);
  assert.equal(Object.hasOwn(writes.at(-1), 'feedback'), false, 'absence is not an accepted natural-height claim');
  value.dispose();
});

test('a burst retains its final value and uses one pending callback', async () => {
  const { time, writes, value } = await controller();
  for (let height = 80; height < 4096; height++) value.accept({ height });
  assert.equal(time.tasks.size, 1); time.advance(16);
  assert.equal(writes.length, 1); assert.equal(writes[0].height, 4095);
});

test('sustained direct message bursts cannot bypass the host rate limit', async () => {
  const { time, writes, value } = await controller();
  for (let index = 0; index < 1000; index++) {
    value.accept({ height: 100 + index }); value.flush(); time.advance(1);
  }
  time.advance(200);
  assert.ok(writes.length <= 11, `actual writes: ${writes.length}`);
  assert.equal(writes.at(-1).height, 1099);
  for (let index = 1; index < writes.length; index++) assert.ok(writes[index].at - writes[index - 1].at >= 100);
});

test('identical snapshots do not write, but width-only reflow does', async () => {
  const { time, writes, value } = await controller();
  const first = { height: 300, naturalHeight: 300, naturalWidth: 700, capped: false };
  value.accept(first); time.advance(16);
  value.accept(first); time.advance(200); assert.equal(writes.length, 1);
  value.accept({ ...first, naturalWidth: 500 }); time.advance(16); assert.equal(writes.length, 2);
});

test('owner invalidation prevents a late write without touching another controller', async () => {
  let current = true;
  const a = await controller({ isCurrent: () => current }), b = await controller();
  a.value.accept({ height: 600 }); b.value.accept({ height: 400 });
  current = false; a.time.advance(200); b.time.advance(200);
  assert.equal(a.writes.length, 0); assert.equal(a.value.accept({ height: 800 }), false);
  assert.equal(b.writes[0].height, 400);
});

test('dispose cancels both timer and RAF, is idempotent and cannot revive', async () => {
  const a = await controller();
  a.value.accept({ height: 300 }); a.value.dispose(); a.value.dispose(); a.time.advance(500);
  assert.equal(a.writes.length, 0); assert.equal(a.time.tasks.size, 0);
  assert.equal(a.value.accept({ height: 400 }), false);
  const b = await controller();
  b.value.accept({ height: 300 }); b.time.advance(16);
  b.value.accept({ height: 400 }); assert.equal(b.time.tasks.size, 1);
  b.value.dispose(); b.time.advance(500); assert.equal(b.writes.length, 1); assert.equal(b.time.tasks.size, 0);
});

async function visibility(t, useIntersection = true, setup = () => {}) {
  const { createHtmlArtifactVisibilityController } = await load();
  const dom = new JSDOM('<main><section><div id="node"><iframe></iframe></div></section></main>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, node = d.querySelector('#node');
  const time = clock(); time.attach(w);
  let hidden = false, observer;
  Object.defineProperty(d, 'hidden', { get: () => hidden });
  if (useIntersection) w.IntersectionObserver = class {
    constructor(callback, options) { this.callback = callback; this.options = options; observer = this; }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  };
  setup({ w, d, node });
  const events = [];
  const value = createHtmlArtifactVisibilityController({ node, document: d, onVisibility: next => events.push(next) });
  t.after(() => value.dispose());
  return { w, d, node, time, observer, events, value,
    setHidden(next) { hidden = next; d.dispatchEvent(new w.Event('visibilitychange')); } };
}

test('lazy signal waits for the near-viewport intersection and uses a bounded prewarm margin', async t => {
  const s = await visibility(t);
  assert.deepEqual(s.events, [false]); assert.equal(s.observer.options.rootMargin, '600px 0px');
  s.observer.callback([{ target: s.node, isIntersecting: true }]); assert.deepEqual(s.events, [false, true]);
  s.observer.callback([{ target: s.node, isIntersecting: true }]); assert.equal(s.events.length, 2);
});

test('zero-sized jsdom rectangles never override a negative IO result, even on scroll', async t => {
  const s = await visibility(t);
  Object.defineProperties(s.w, {
    innerWidth: { value: 800, configurable: true },
    innerHeight: { value: 900, configurable: true },
  });
  s.observer.callback([{ target: s.node, isIntersecting: false }]);
  s.node.dispatchEvent(new s.w.Event('scroll'));
  s.time.advance(16);
  assert.deepEqual(s.events, [false]);
});

test('measured geometry recovers an IO miss after scrolling into the viewport prewarm band', async t => {
  const s = await visibility(t);
  Object.defineProperties(s.w, {
    innerWidth: { value: 800, configurable: true },
    innerHeight: { value: 900, configurable: true },
  });
  let rect = { left: 0, right: 320, top: 1601, bottom: 1633, width: 320, height: 32 };
  s.node.getBoundingClientRect = () => rect;
  s.observer.callback([{ target: s.node, isIntersecting: false }]);
  assert.deepEqual(s.events, [false], 'an artifact beyond the 600px margin remains lazy');

  rect = { ...rect, top: 1004, bottom: 1036 };
  s.node.dispatchEvent(new s.w.Event('scroll'));
  s.time.advance(16);
  assert.deepEqual(s.events, [false, true], 'a later measured position inside the margin recovers the missed IO transition');
});

test('a bounded geometry recheck catches a late layout shift without another IO or scroll event', async t => {
  const s = await visibility(t);
  Object.defineProperties(s.w, {
    innerWidth: { value: 800, configurable: true },
    innerHeight: { value: 900, configurable: true },
  });
  let rect = { left: 0, right: 320, top: 1601, bottom: 1633, width: 320, height: 32 };
  s.node.getBoundingClientRect = () => rect;
  s.observer.callback([{ target: s.node, isIntersecting: false }]);
  assert.deepEqual(s.events, [false], 'the distant artifact remains lazy');

  rect = { ...rect, top: 1004, bottom: 1036 };
  s.time.advance(80);
  assert.deepEqual(s.events, [false, true], 'a later measured position inside the margin recovers without IO delivery');
});

test('mount measures a near target without waiting for IO and stale false samples cannot undo it', async t => {
  let rect = { left: 10, right: 330, top: 1004, bottom: 1036, width: 320, height: 32 };
  const s = await visibility(t, true, ({ w, node }) => {
    Object.defineProperty(w, 'innerHeight', { value: 900 });
    node.getBoundingClientRect = () => rect;
  });
  assert.deepEqual(s.events, [true], 'mount itself supplies the initial near-viewport signal');
  s.observer.callback([{ target: s.node, isIntersecting: false }]);
  assert.deepEqual(s.events, [true], 'the measured current position wins over a stale false delivery');
  rect = { ...rect, top: 1601, bottom: 1633 };
  s.value.refresh(); assert.deepEqual(s.events, [true, false], 'the estimate never latches true for distant targets');
  s.observer.callback([{ target: s.node, isIntersecting: true }]);
  assert.deepEqual(s.events, [true, false, true], 'a positive IO signal remains primary');
});

test('scrollport prewarm survives an outer shell clip, but hidden and clip never expand', async t => {
  const s = await visibility(t), scroller = s.node.parentElement, shell = scroller.parentElement;
  Object.defineProperty(s.w, 'innerHeight', { value: 900 });
  s.node.getBoundingClientRect = () => ({ left: 10, right: 330, top: 1004, bottom: 1036, width: 320, height: 32 });
  scroller.getBoundingClientRect = () => ({ left: 0, right: 800, top: 46, bottom: 882 });
  // jsdom has no layout: model the actual scroll range as well as the rect.
  Object.defineProperties(scroller, { clientHeight: { value: 836 }, scrollHeight: { value: 2000 } });
  shell.getBoundingClientRect = () => ({ left: 0, right: 800, top: 0, bottom: 900 });
  shell.style.overflow = 'clip';
  for (const overflow of ['auto', 'scroll', 'overlay']) {
    scroller.style.overflowY = overflow; s.value.refresh();
    assert.equal(s.events.at(-1), true, `${overflow} permits prewarm through the outer shell clip`);
  }
  for (const overflow of ['hidden', 'clip']) {
    scroller.style.overflowY = overflow; s.value.refresh();
    assert.equal(s.events.at(-1), false, `${overflow} is a real unexpanded clip`);
  }
});

for (const overflow of ['auto', 'scroll', 'overlay']) {
  test(`non-scrollable ${overflow} clips unreachable negative-offset and below-port targets`, async t => {
    // jsdom cannot lay out or clamp native scrolling. These rects/dimensions
    // model the reviewed browser case: top:-200px is clipped, not scroll-reachable.
    let rect = { left: 10, right: 330, top: 200, bottom: 232, width: 320, height: 32 };
    const s = await visibility(t, true, ({ w, node }) => {
      Object.defineProperty(w, 'innerHeight', { value: 900 });
      const scroller = node.parentElement;
      scroller.style.overflowY = overflow;
      Object.defineProperties(scroller, { clientHeight: { value: 400 }, scrollHeight: { value: 400 } });
      scroller.getBoundingClientRect = () => ({ left: 0, right: 800, top: 400, bottom: 800 });
      node.style.position = 'relative'; node.style.top = '-200px';
      node.getBoundingClientRect = () => rect;
    });
    assert.deepEqual(s.events, [false], 'no scroll range means no prewarm above the clip at mount');
    s.observer.callback([{ target: s.node, isIntersecting: false }]);
    s.node.dispatchEvent(new s.w.Event('scroll')); s.time.advance(10000);
    assert.deepEqual(s.events, [false], 'negative IO, scroll and rechecks cannot activate the unreachable target');
    rect = { ...rect, top: 1004, bottom: 1036 };
    s.value.refresh();
    assert.deepEqual(s.events, [false], 'equal dimensions also keep the lower overflow clip unexpanded');
  });
}

test('far targets stay lazy, geometry rechecks finish, and disposal cancels scroll work', async t => {
  const s = await visibility(t);
  let reads = 0;
  s.node.getBoundingClientRect = () => { reads++; return { left: 10, right: 330, top: 5000, bottom: 5032, width: 320, height: 32 }; };
  s.time.advance(10000);
  assert.deepEqual(s.events, [false]); assert.equal(s.time.tasks.size, 0);
  assert.ok(reads <= 8, `bounded geometry reads: ${reads}`);
  s.node.dispatchEvent(new s.w.Event('scroll'));
  assert.equal(s.time.tasks.size, 1);
  s.value.dispose(); s.time.advance(10000);
  s.node.dispatchEvent(new s.w.Event('scroll'));
  s.w.dispatchEvent(new s.w.Event('resize'));
  assert.equal(s.time.tasks.size, 0); assert.deepEqual(s.events, [false]);
});

test('background and hidden ancestors pause then restore the SAME existing frame', async t => {
  const s = await visibility(t), frame = s.node.querySelector('iframe');
  s.observer.callback([{ target: s.node, isIntersecting: true }]);
  s.setHidden(true); s.setHidden(false);
  s.node.parentElement.hidden = true; await Promise.resolve(); s.time.advance(16);
  assert.equal(s.events.at(-1), false);
  s.node.parentElement.hidden = false; await Promise.resolve(); s.time.advance(16);
  assert.equal(s.events.at(-1), true); assert.equal(s.node.querySelector('iframe'), frame);
});

test('eager fallback, closed details and own visibility are observed without any unmount', async t => {
  const s = await visibility(t, false), frame = s.node.querySelector('iframe');
  assert.deepEqual(s.events, [true]);
  s.node.style.visibility = 'hidden'; await Promise.resolve(); s.time.advance(16); assert.equal(s.events.at(-1), false);
  s.node.style.visibility = ''; await Promise.resolve(); s.time.advance(16); assert.equal(s.events.at(-1), true);
  const details = s.d.createElement('details'); s.node.replaceWith(details); details.append(s.node);
  s.value.refresh(); assert.equal(s.events.at(-1), false);
  details.open = true; s.value.refresh(); assert.equal(s.events.at(-1), true);
  assert.equal(s.node.querySelector('iframe'), frame);
});

test('visibility disposal disconnects observers/callbacks but never disposes the owned frame', async t => {
  const s = await visibility(t), frame = s.node.querySelector('iframe');
  s.node.parentElement.hidden = true; await Promise.resolve();
  s.value.dispose(); s.value.dispose(); s.time.advance(1000); s.setHidden(true);
  assert.equal(s.time.tasks.size, 0); assert.equal(s.observer.disconnected, true);
  assert.deepEqual(s.events, [false]); assert.equal(s.node.querySelector('iframe'), frame);
});
