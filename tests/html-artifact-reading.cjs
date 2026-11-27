'use strict';
// Geometry is controlled; this proves bookmark/scroll ownership, not pixels or
// native cross-iframe wheel chaining. No fixtures are written to real data.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const reading = () => import('../public/reading-position.js');

function timeline(t) {
  const dom = new JSDOM('<main><div id="stream"><div class="thread"></div></div></main>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const d = dom.window.document, scroller = d.querySelector('#stream'), content = d.querySelector('.thread');
  const rows = [], outer = d.querySelector('main');
  let total = 2000;
  scroller.scrollTop = 500; outer.scrollTop = 37;
  Object.defineProperty(scroller, 'clientHeight', { value: 400 });
  Object.defineProperty(scroller, 'scrollHeight', { get: () => total });
  scroller.getBoundingClientRect = () => ({ top: 100, bottom: 500, height: 400, width: 700 });
  function add(id, top, height, artifact = false) {
    const node = d.createElement('div');
    if (artifact) { node.dataset.artifactId = id; node.className = 'html-artifact'; }
    else node.dataset.anchorId = id;
    const row = { node, top, height };
    node.getBoundingClientRect = () => ({ top: 100 + row.top - scroller.scrollTop,
      bottom: 100 + row.top - scroller.scrollTop + row.height, height: row.height, width: 700 });
    content.append(node); rows.push(row); return row;
  }
  return { d, scroller, content, outer, rows, add, total: value => { total = value; } };
}

test('scroller-as-content descends the Classic thread wrapper to the stable artifact/message being read', async t => {
  const RP = await reading(), s = timeline(t);
  s.add('one', 0, 400, true); s.add('after', 400, 500);
  const bookmark = RP.captureReadingPosition(s.scroller, s.scroller, { isPinned: false });
  assert.equal(bookmark.anchorId, 'after'); assert.equal(bookmark.offset, -100);
});

test('height growth of an artifact above the viewport anchors the visible message, not raw scrollTop', async t => {
  const RP = await reading(), s = timeline(t), artifact = s.add('one', 0, 400, true), message = s.add('after', 400, 500);
  const bookmark = RP.captureReadingPosition(s.scroller, s.scroller, { isPinned: false });
  artifact.height += 300; message.top += 300; s.total(2300);
  assert.equal(RP.restoreReadingPosition(s.scroller, s.scroller, bookmark), true);
  assert.equal(s.scroller.scrollTop, 800); assert.equal(s.outer.scrollTop, 37);
  assert.equal(message.node.getBoundingClientRect().top, 0);
});

test('multiple artifacts have distinct stable anchors and do not enter iframe DOM', async t => {
  const RP = await reading(), s = timeline(t);
  s.add('one', 0, 400, true); const second = s.add('two', 400, 500, true);
  const frame = s.d.createElement('iframe'); second.node.append(frame);
  frame.contentDocument.body.innerHTML = '<div data-anchor-id="never-host-anchor">inside</div>';
  const bookmark = RP.captureReadingPosition(s.scroller, s.content, { isPinned: false });
  assert.equal(bookmark.anchorId, 'artifact-two');
  second.height = 800; s.total(2400); RP.restoreReadingPosition(s.scroller, s.content, bookmark);
  assert.equal(s.scroller.scrollTop, 500); assert.equal(s.outer.scrollTop, 37);
});

test('generation near the end follows when the owning conversation explicitly allows it', async t => {
  const RP = await reading(), s = timeline(t);
  s.scroller.scrollTop = 1550; s.add('tail', 1500, 500);
  const bookmark = RP.captureReadingPosition(s.scroller, s.content, { isPinned: true });
  s.total(2400); RP.restoreReadingPosition(s.scroller, s.content, bookmark);
  assert.equal(s.scroller.scrollTop, 2000);
});

test('explicit user reading mode wins even within the near-bottom follow threshold', async t => {
  const RP = await reading(), s = timeline(t), tail = s.add('tail', 1500, 500);
  s.scroller.scrollTop = 1550;
  const bookmark = RP.captureReadingPosition(s.scroller, s.content, { isPinned: false });
  tail.height += 300; s.total(2300); RP.restoreReadingPosition(s.scroller, s.content, bookmark);
  assert.equal(bookmark.isPinned, false); assert.equal(s.scroller.scrollTop, 1550);
});

test('history pagination restores the same ID/offset after prepending content', async t => {
  const RP = await reading(), s = timeline(t), message = s.add('existing', 400, 500);
  const bookmark = RP.captureReadingPosition(s.scroller, s.content, { isPinned: false });
  const prepended = s.add('older', 0, 250); s.content.prepend(prepended.node); message.top += 250; s.total(2250);
  RP.restoreReadingPosition(s.scroller, s.content, bookmark);
  assert.equal(s.scroller.scrollTop, 750); assert.equal(message.node.getBoundingClientRect().top, 0);
});

test('hidden anchors are skipped and missing/removed anchors fall back safely', async t => {
  const RP = await reading(), s = timeline(t);
  const hidden = s.add('hidden', 400, 500, true); hidden.node.hidden = true;
  const row = s.add('visible', 450, 600);
  const bookmark = RP.captureReadingPosition(s.scroller, s.content, { isPinned: false });
  assert.equal(bookmark.anchorId, 'visible'); row.node.remove(); s.total(450);
  RP.restoreReadingPosition(s.scroller, s.content, bookmark); assert.equal(s.scroller.scrollTop, 50);
});

test('fullscreen placeholder and theme-like synchronous reflow preserve offset instead of forcing the end', async t => {
  const RP = await reading(), s = timeline(t), artifact = s.add('one', 400, 700, true);
  const bookmark = RP.captureReadingPosition(s.scroller, s.content, { isPinned: false });
  const frame = s.d.createElement('iframe'); artifact.node.append(frame);
  artifact.node.dataset.fullscreen = 'true'; artifact.node.dataset.fullscreen = 'false';
  RP.restoreReadingPosition(s.scroller, s.content, bookmark);
  assert.equal(s.scroller.scrollTop, 500); assert.equal(artifact.node.querySelector('iframe'), frame);
  artifact.height += 20; s.total(2020); RP.restoreReadingPosition(s.scroller, s.content, bookmark);
  assert.equal(s.scroller.scrollTop, 500);
});

test('session bookmarks remain memory-only and separate without a global follow state', async t => {
  const RP = await reading(), a = timeline(t), b = timeline(t);
  RP.clearAllBookmarks(); t.after(() => RP.clearAllBookmarks());
  a.add('a', 400, 600, true); b.add('b', 600, 600, true); b.scroller.scrollTop = 700;
  RP.saveSessionBookmark('session-a', a.scroller, a.content, { isPinned: false });
  RP.saveSessionBookmark('session-b', b.scroller, b.content, { isPinned: false });
  a.scroller.scrollTop = 0; b.scroller.scrollTop = 0;
  RP.restoreSessionBookmark('session-a', a.scroller, a.content); assert.equal(a.scroller.scrollTop, 500);
  assert.equal(b.scroller.scrollTop, 0);
  RP.restoreSessionBookmark('session-b', b.scroller, b.content); assert.equal(b.scroller.scrollTop, 700);
  assert.equal(RP.bookmarkCount(), 2);
  assert.throws(() => a.d.defaultView.localStorage, /opaque origins/, 'fixture has no persistent storage');
});

async function contained(t) {
  const { installHtmlArtifactScroll } = await import('../public/html-artifact-scroll.js');
  const dom = new JSDOM('<main><div id="pane"><input id="target"></div></main>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, root = d.documentElement, pane = d.querySelector('#pane'), target = d.querySelector('#target');
  const rectangles = new Map([[target, { top: 900, bottom: 940, left: 0, right: 100, height: 40, width: 100 }],
    [pane, { top: 300, bottom: 400, left: 0, right: 600, height: 100, width: 600 }]]);
  w.Element.prototype.getBoundingClientRect = function () { return rectangles.get(this) || { top: 0, bottom: 200, left: 0, right: 600, height: 200, width: 600 }; };
  for (const [node, height, total] of [[root, 200, 2000], [pane, 100, 500]]) {
    for (const [key, value] of Object.entries({ clientHeight: height, scrollHeight: total, clientWidth: 600, scrollWidth: 600, clientTop: 0, clientLeft: 0 })) {
      Object.defineProperty(node, key, { value, configurable: true });
    }
    node.scrollTop = 0; node.scrollLeft = 0;
  }
  Object.defineProperty(d, 'scrollingElement', { value: root });
  const focusOptions = [];
  w.HTMLElement.prototype.focus = function (options) { focusOptions.push(options); };
  assert.equal(installHtmlArtifactScroll(w), true);
  return { w, d, root, pane, target, rectangles, focusOptions };
}

test('programmatic scrollIntoView changes only this frame viewport and honors nearest/start alignment', async t => {
  const s = await contained(t), outer = s.d.querySelector('main'); outer.scrollTop = 41;
  s.target.scrollIntoView({ block: 'nearest' }); assert.equal(s.root.scrollTop, 740); assert.equal(outer.scrollTop, 41);
  s.root.scrollTop = 0; s.target.scrollIntoView(false); assert.equal(s.root.scrollTop, 740);
  s.root.scrollTop = 0; s.target.style.scrollMarginTop = '10px'; s.root.style.scrollPaddingTop = '20px';
  s.target.scrollIntoView({ block: 'start' }); assert.equal(s.root.scrollTop, 870);
});

test('nested internal scrolling consumes displacement before the local viewport and fixed panels stay contained', async t => {
  const s = await contained(t); s.pane.style.overflowY = 'auto';
  s.rectangles.set(s.target, { top: 650, bottom: 690, left: 0, right: 100, height: 40, width: 100 });
  s.target.scrollIntoView({ block: 'nearest' }); assert.equal(s.pane.scrollTop, 290); assert.equal(s.root.scrollTop, 200);
  s.pane.scrollTop = 0; s.root.scrollTop = 0; s.pane.style.position = 'fixed';
  s.target.scrollIntoView({ block: 'nearest' }); assert.equal(s.pane.scrollTop, 290); assert.equal(s.root.scrollTop, 0);
});

test('programmatic focus prevents native ancestor scrolling and optionally reveals only inside the frame', async t => {
  const s = await contained(t);
  s.target.focus({ preventScroll: true }); assert.equal(s.focusOptions[0].preventScroll, true); assert.equal(s.root.scrollTop, 0);
  s.target.focus(); assert.equal(s.focusOptions[1].preventScroll, true); assert.equal(s.root.scrollTop, 740);
});
