'use strict';
// Offline renderer/DOM regressions. These do not qualify Electron's sandbox,
// network policy or pixel layout; the desktop fixture provides that evidence.
const nativeAssert = require('node:assert/strict');
const { test, after } = require('node:test');
let assertionCount = 0;
const assert = new Proxy(nativeAssert, { get(target, key) {
  const value = target[key];
  return typeof value === 'function' ? (...args) => { assertionCount++; return value(...args); } : value;
} });
after(() => console.log(`Artifact UI assertions: ${assertionCount}; skips are not included`));
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { bundle } = require('./esm-bundle.cjs');
const PUB = path.resolve(__dirname, '../public');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const text = value => ({ type: 'text', text: value });
const html = '<section><p>离线 visual fixture</p><button>Interact</button></section>';
function reference(seed = 'one', extra = {}) {
  return { schemaVersion: 1, kind: 'html', id: createHash('sha256').update(seed).digest('hex'),
    title: '离线可视化 ' + seed, sessionId: 'native-session', messageId: 'assistant-' + seed,
    toolCallId: 'call-' + seed, height: 320, createdAt: '2026-11-27T00:00:00.000Z',
    bytes: Buffer.byteLength(html), digest: createHash('sha256').update(html).digest('hex'),
    ...extra, contentRef: createHash('sha256').update(seed).digest('hex') };
}
const details = artifact => ({ kind: 'html_artifact', schemaVersion: 1, ok: true, artifact });
const result = artifact => ({ role: 'toolResult', toolName: 'html_render', toolCallId: artifact.toolCallId,
  isError: false, content: [text('published')], details: details(artifact) });
const owner = (conversationId = 'A') => ({ backendInstance: 'fixture', projectId: 'project', repoId: 'repo',
  workspaceId: 'workspace', workspaceEpoch: 1, conversationId, runtimeId: 'runtime-' + conversationId,
  runtimeGeneration: 1, sessionId: 'native-session' });
const item = id => ({ conversationId: id, owner: owner(id), lifecycle: 'ready', activity: 'idle',
  workspace: { projectId: 'project', workspaceId: 'workspace', workspaceEpoch: 1 } });

function surface(t, module = 'html-artifact-viewer.js', options = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), {
    url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document;
  const registered = [], released = [], reads = [], cleanups = [];
  w.TextEncoder = TextEncoder;
  // State-machine shim only, NOT a native modal/focus or rendering proof.
  if (options.dialog !== false) {
    w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  }
  w.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (url === '/api/html-artifacts/read') {
      reads.push({ ...body, signal: init.signal });
      return { json: async () => options.read ? options.read(body, init) : ({ ok: true,
        artifact: (options.artifacts || [reference()]).find(ref => ref.id === body.id), html }) };
    }
    return { json: async () => ({ ok: true, items: [], files: [], isRepo: false }) };
  };
  w.piGuiDesktop = { htmlArtifacts: {
    registerFrame(request) {
      const frames = [...d.querySelectorAll('iframe[name="pi-gui-html-artifact"]')];
      registered.push({ request, frames, sandboxes: frames.map(f => f.getAttribute('sandbox')) });
      assert.ok(frames.length && frames.every(f => !f.hasAttribute('src') && !f.hasAttribute('srcdoc')
        ? f.getAttribute('sandbox') === '' : f.getAttribute('sandbox') === 'allow-scripts'));
      return options.register ? options.register(request) : Promise.resolve({ ok: true, javascriptEnabled: true });
    },
    releaseFrame(request) { released.push({ request, frames: [...d.querySelectorAll('iframe[name="pi-gui-html-artifact"]')] }); },
  } };
  w.eval(bundle(path.join(PUB, module)).code);
  t.after(() => { for (const cleanup of cleanups) cleanup(); w.disposeHtmlArtifacts?.(d.body); dom.window.close(); });
  return { w, d, registered, released, reads, dom, cleanups };
}
function mounted(s, ref = reference(), options = {}) {
  const viewer = s.w.createHtmlArtifactViewer(ref, { scope: { conversationId: 'A', owner: owner() }, ...options });
  s.d.body.append(viewer.node); viewer.mount();
  return viewer;
}
function message(s, frame, type, extra = {}, overrides = {}) {
  const nonce = frame.srcdoc.match(/"nonce":"([a-f0-9]+)"/)?.[1];
  s.w.dispatchEvent(new s.w.MessageEvent('message', { source: frame.contentWindow, origin: 'null',
    data: { schemaVersion: 1, id: frame.closest('.html-artifact')?.dataset.artifactId, nonce, type, ...extra }, ...overrides }));
}

test('closed history projections make sibling artifact boundaries without executing Markdown or retaining HTML', async () => {
  const { planHistory } = await import('../public/tool-history.js');
  const { timelineFromMessages } = await import('../public/runtime-timeline.js');
  const { entryFromHistory, makeEntry, applyUpdate, applyEnd } = await import('../public/tool-model.js');
  const a = reference(), b = reference('two');
  const call = ref => ({ type: 'toolCall', id: ref.toolCallId, name: 'html_render', arguments: { html: '<secret>' } });
  const messages = [{ role: 'user', content: [text('question')] },
    { role: 'assistant', content: [text('before'), call(a)] }, result(a),
    { role: 'assistant', content: [text('between'), call(b)] }, result(b), result(a),
    { role: 'assistant', content: [text('after <script>not executable</script>')] }];
  for (const projected of [planHistory(messages), timelineFromMessages(messages).blocks]) {
    const artifacts = projected.filter(row => row.kind === 'html_artifact');
    assert.deepEqual(artifacts.map(row => row.artifact.id), [a.id, b.id]);
    assert.ok(projected.indexOf(artifacts[0]) < projected.indexOf(artifacts[1]));
    assert.ok(!JSON.stringify(artifacts).includes('<secret>'));
  }
  const entry = entryFromHistory(call(a), { ...result(a), content: [text('<secret>')] });
  assert.equal(entry.args, null); assert.equal(entry.details, null); assert.equal(entry.output, '');
  const live = makeEntry({ toolName: 'html_render', args: { html: '<secret>' } });
  applyUpdate(live, { partialResult: { content: [text('<secret>')], details: { html: '<secret>' } } });
  applyEnd(live, { result: { content: [text('<secret>')], details: { html: '<secret>' } } });
  assert.ok(!JSON.stringify(live).includes('<secret>'));
  assert.equal(planHistory([{ ...result(a), isError: true }]).some(row => row.kind === 'html_artifact'), false);
  assert.equal(timelineFromMessages([{ ...result(a), toolCallId: 'other' }]).blocks.length, 0);
});

test('runtime store deduplicates cancellation/replay and keeps only bounded references across owners', async () => {
  const { createRuntimeStore } = await import('../public/runtime-store.js');
  const store = createRuntimeStore(); store.seed({ backendInstance: 'fixture', items: [item('A'), item('B')] });
  let sequence = 0;
  const emit = (event, target = owner()) => store.apply({ type: 'runtime_event', owner: target, eventSequence: ++sequence, event });
  const a = reference();
  emit({ type: 'tool_execution_start', toolCallId: a.toolCallId, toolName: 'html_render', args: { html: '<secret>' } });
  emit({ type: 'tool_execution_end', toolCallId: a.toolCallId, result: result(a) });
  emit({ type: 'agent_settled' });
  emit({ type: 'tool_execution_end', toolCallId: a.toolCallId, result: result(a) });
  emit({ type: 'tool_execution_end', toolCallId: 'cancelled', isError: true,
    result: result(reference('cancelled', { toolCallId: 'cancelled' })) });
  emit({ type: 'tool_execution_end', toolCallId: a.toolCallId, result: result(a) }, { ...owner(), runtimeGeneration: 0 });
  assert.deepEqual(store.get('A').timeline.filter(row => row.kind === 'html_artifact').map(row => row.artifact.id), [a.id]);
  assert.equal(store.get('B').timeline.length, 0);
  assert.ok(!JSON.stringify(store.get('A')).includes('<secret>'));
});

test('registration is qualified in the connected empty sandbox before any HTML or script permission', async t => {
  let grant; const s = surface(t, undefined, { register: () => new Promise(resolve => { grant = resolve; }) });
  const viewer = mounted(s); await tick();
  let frame = viewer.node.querySelector('iframe');
  assert.equal(frame.getAttribute('sandbox'), ''); assert.equal(frame.hasAttribute('srcdoc'), false);
  assert.equal(s.reads.length, 0); assert.equal(s.registered[0].request.name, 'pi-gui-html-artifact');
  grant({ ok: true, javascriptEnabled: true }); await tick(); await tick();
  frame = viewer.node.querySelector('iframe');
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts'); assert.ok(!frame.sandbox?.contains('allow-same-origin'));
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer'); assert.match(frame.getAttribute('allow'), /camera 'none'/);
  assert.equal(s.reads[0].id, reference().id); assert.equal(s.reads[0].scope.conversationId, 'A');
  assert.deepEqual(s.reads[0].scope.owner, owner());
  assert.ok(!s.d.body.textContent.includes('离线 visual fixture'));
  assert.match(frame.srcdoc, /Content-Security-Policy/);
  assert.ok(!frame.srcdoc.includes('<section>'), 'payload is escaped until the locks are proved');
  message(s, frame, 'ready'); assert.equal(viewer.node.dataset.state, 'ready');
  viewer.dispose(); assert.equal(s.released.length, 1); assert.equal(s.released[0].frames.length, 0);
});

test('unqualified or missing desktop support never reads, allows scripts or falls back to host HTML', async t => {
  const s = surface(t, undefined, { register: async () => ({ ok: true, javascriptEnabled: false }) });
  const viewer = mounted(s); await tick();
  assert.equal(s.reads.length, 0); assert.equal(viewer.node.dataset.state, 'error');
  assert.equal(viewer.node.querySelector('iframe'), null); assert.equal(s.released.length, 1);
  delete s.w.piGuiDesktop;
  const second = mounted(s, reference('missing')); await tick();
  assert.equal(second.node.dataset.state, 'error'); assert.equal(s.reads.length, 0);
});

test('postMessage accepts only the exact opaque frame, protocol, artifact and fresh nonce; heights are bounded', async t => {
  const s = surface(t), viewer = mounted(s); await tick(); await tick();
  const frame = viewer.node.querySelector('iframe');
  for (const overrides of [{ origin: 'http://fixture.invalid' }, { source: s.w },
    { data: { schemaVersion: 2 } }, { data: { schemaVersion: 1, id: reference().id, nonce: 'wrong', type: 'ready' } }]) {
    message(s, frame, 'ready', {}, overrides); assert.equal(viewer.node.dataset.state, 'loading');
  }
  message(s, frame, 'ready'); assert.equal(viewer.node.dataset.state, 'ready');
  message(s, frame, 'resize', { height: Infinity }); assert.equal(frame.style.height, '320px');
  message(s, frame, 'resize', { height: 999999 }); await new Promise(resolve => s.w.requestAnimationFrame(resolve));
  assert.equal(frame.style.height, '4096px');
  message(s, frame, 'resize', { height: -5 }); await new Promise(resolve => setTimeout(resolve, 135));
  assert.equal(frame.style.height, '80px');
  message(s, frame, 'open-external', { url: 'https://not-used.invalid' }); assert.equal(viewer.node.dataset.state, 'ready');
});

test('resolved light/dark/font theme changes update the same isolated frame without reloading its document', async t => {
  const s = surface(t), viewer = mounted(s); await tick(); await tick();
  const frame = viewer.node.querySelector('iframe'), original = frame.srcdoc, messages = [];
  frame.contentWindow.postMessage = (...args) => messages.push(args);
  message(s, frame, 'ready');
  s.d.documentElement.dataset.theme = 'light';
  s.d.documentElement.style.setProperty('--ds-bg-primary', 'rgb(250, 250, 250)');
  s.d.documentElement.style.setProperty('--font-scale', '1.25'); await tick();
  const theme = messages.at(-1)[0].theme;
  assert.equal(theme.colorScheme, 'light'); assert.equal(theme.values.background, 'rgb(250, 250, 250)');
  assert.equal(theme.values['font-size'], '17.5px'); assert.equal(frame.srcdoc, original);
  assert.equal(messages.at(-1)[1], '*'); assert.equal(messages.at(-1)[0].type, 'theme');
});

test('pending native reference retries are bounded, errors are retryable, and stale reads cannot revive disposed frames', async t => {
  let reads = 0, finish;
  const s = surface(t, undefined, { read: async () => ++reads <= 4 ? ({ ok: false, code: 'reference_pending' })
    : new Promise(resolve => { finish = resolve; }) });
  const viewer = mounted(s);
  await new Promise(resolve => setTimeout(resolve, 850));
  assert.equal(reads, 4); assert.equal(viewer.node.dataset.state, 'error');
  viewer.node.querySelector('.html-artifact-retry').click(); await tick();
  assert.equal(reads, 5); const signal = s.reads.at(-1).signal;
  viewer.dispose(); assert.equal(signal.aborted, true);
  finish({ ok: true, artifact: reference(), html }); await tick();
  assert.equal(viewer.node.querySelector('iframe'), null); assert.equal(s.released.length, 2);
});

test('a failed read may retry with a new frame; wrong metadata/bytes never reach srcdoc', async t => {
  let count = 0;
  const s = surface(t, undefined, { read: async () => ++count === 1
    ? ({ ok: true, artifact: reference(), html: '<wrong>' }) : ({ ok: true, artifact: reference(), html }) });
  const viewer = mounted(s); await tick(); await tick();
  assert.equal(viewer.node.dataset.state, 'error'); assert.equal(viewer.node.querySelector('iframe'), null);
  viewer.node.querySelector('.html-artifact-retry').click(); await tick(); await tick();
  const frame = viewer.node.querySelector('iframe'); assert.ok(frame.srcdoc);
  assert.equal(s.registered.length, 2); message(s, frame, 'ready'); assert.equal(viewer.node.dataset.state, 'ready');
});

test('disposal during native qualification removes first and releases only the late successful registration', async t => {
  let grant;
  const s = surface(t, undefined, { register: () => new Promise(resolve => { grant = resolve; }) });
  const viewer = mounted(s); await tick(); viewer.dispose();
  assert.equal(s.released.length, 0); grant({ ok: true, javascriptEnabled: true }); await tick();
  assert.equal(s.reads.length, 0); assert.equal(s.released.length, 1); assert.equal(s.released[0].frames.length, 0);
});

test('trusted bootstrap parses safely and a failed nonconfigurable network lock prevents all payload parsing', async t => {
  const { htmlArtifactDocument } = await import('../public/html-artifact-frame.js');
  const payload = '<p id="payload">safe</p><script>window.fixtureExecuted=true;</script>' + String.fromCharCode(0x2028, 0x2029);
  const build = () => htmlArtifactDocument(payload, { id: reference().id, nonce: 'fixture',
    hostOrigin: 'http://fixture.invalid', theme: { colorScheme: 'light', values: { foreground: '#123456' } } });
  const run = locked => new JSDOM(build(), { url: 'http://fixture.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.ResizeObserver = class { observe() {} disconnect() {} };
      if (locked) Object.defineProperty(w, 'fetch', { value() {}, configurable: false, writable: false });
    } });
  const allowed = run(false), denied = run(true);
  t.after(() => { allowed.window.close(); denied.window.close(); });
  assert.equal(allowed.window.fixtureExecuted, true); assert.ok(allowed.window.document.querySelector('#payload'));
  assert.equal(allowed.window.document.documentElement.style.colorScheme, 'light');
  assert.equal(denied.window.fixtureExecuted, undefined); assert.equal(denied.window.document.querySelector('#payload'), null);
});

test('Classic production live/history nodes survive ordinary tool folding, deduplicate, and clear safely', async t => {
  const a = reference(), b = reference('two'), s = surface(t, 'tools.js', { artifacts: [a, b] });
  s.w.S.legacyOwner = owner('classic-chat');
  s.w.onMessageStart({ message: { role: 'user', content: [text('fixture')] } });
  s.w.onMessageStart({ message: { role: 'assistant', content: [] } });
  s.w.onMessageEnd({ message: { role: 'assistant', content: [text('before')], stopReason: 'toolUse' } });
  for (const ref of [a, b, a]) {
    s.w.onToolStart({ toolCallId: ref.toolCallId, toolName: 'html_render', args: { html: '<secret>' } });
    s.w.onToolEnd({ toolCallId: ref.toolCallId, result: result(ref) });
  }
  s.w.onSettled(); s.w.refreshClassicConversationFlow(); await tick();
  let roots = [...s.d.querySelectorAll('.html-artifact')]; assert.equal(roots.length, 2);
  assert.ok(roots.every(node => !node.closest('[data-conversation-work]')));
  for (const head of s.d.querySelectorAll('.conversation-work-head')) if (head.getAttribute('aria-expanded') === 'true') head.click();
  assert.ok(roots.every(node => !node.closest('[hidden]')));
  assert.ok(!s.d.querySelector('.thread').textContent.includes('<secret>'));
  s.w.clearThread(); assert.equal(s.d.querySelectorAll('.html-artifact').length, 0);
  s.w.rebuildFromMessages([{ role: 'user', content: [text('history')] },
    { role: 'assistant', content: [text('before')] }, result(a), result(b), result(a),
    { role: 'assistant', content: [text('after <script>inert</script>')] }], 'native-session');
  await tick();
  roots = [...s.d.querySelectorAll('.html-artifact')]; assert.equal(roots.length, 2);
  assert.ok(roots[0].compareDocumentPosition(roots[1]) & s.w.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(s.reads.at(-1).scope.conversationId, 'classic-chat');
  assert.equal(s.d.querySelector('.thread script'), null);
  s.w.clearThread();
});

test('Classic large history chunk cancellation never mounts or reads its later artifacts into a new thread', async t => {
  const s = surface(t, 'messages.js'); s.w.S.legacyOwner = owner('classic-chat');
  const messages = Array.from({ length: 810 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [text('row ' + i)] }));
  messages.push(result(reference()));
  s.w.rebuildFromMessages(messages, 'native-session');
  s.w.clearThread(); s.w.S.legacyOwner = { ...owner('classic-chat'), sessionId: 'other-session' };
  s.w.rebuildFromMessages([{ role: 'user', content: [text('new thread')] }], 'other-session');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(s.d.querySelectorAll('.html-artifact').length, 0); assert.equal(s.reads.length, 0);
  assert.match(s.d.querySelector('.thread').textContent, /new thread/); s.w.clearThread();
});

test('inline dialog preserves the frame and registration through full screen and zoom modes', async t => {
  const s = surface(t), viewer = mounted(s); await tick(); await tick();
  const frame = viewer.node.querySelector('iframe'), source = frame.srcdoc;
  const expand = viewer.node.querySelector('.html-artifact-expand');
  message(s, frame, 'ready'); expand.focus(); expand.click();
  const dialog = viewer.node.querySelector('dialog');
  assert.equal(dialog.open, true); assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(expand.getAttribute('aria-expanded'), 'true');
  assert.equal(s.d.activeElement.getAttribute('aria-label'), '关闭全屏');
  dialog.querySelector('[aria-label="放大"]').click();
  assert.equal(frame.style.transform, 'scale(1.25)'); assert.equal(dialog.dataset.zoomMode, 'transform');
  dialog.querySelector('[aria-label="重置为 100%"]').click();
  assert.equal(frame.style.transform, 'none'); assert.equal(dialog.dataset.zoomMode, 'transform');
  [...dialog.querySelectorAll('button')].find(node => node.textContent === '适应宽度').click();
  assert.equal(dialog.dataset.zoomMode, 'responsive');
  message(s, frame, 'escape');
  assert.equal(dialog.open, false); assert.equal(s.d.activeElement, expand);
  assert.equal(viewer.node.querySelector('iframe'), frame); assert.equal(frame.srcdoc, source);
  assert.equal(s.registered.length, 1); assert.equal(s.released.length, 0); assert.equal(s.reads.length, 1);
  viewer.dispose(); assert.equal(s.released.length, 1);
});

test('artifact dialogs are independent, close their prior sibling, and dispose expanded resources once', async t => {
  const a = reference(), b = reference('two'), s = surface(t, undefined, { artifacts: [a, b] });
  const one = mounted(s, a), two = mounted(s, b); await tick(); await tick();
  const first = one.node.querySelector('iframe'), second = two.node.querySelector('iframe');
  message(s, first, 'ready'); message(s, second, 'ready');
  one.node.querySelector('.html-artifact-expand').click();
  two.node.querySelector('.html-artifact-expand').click();
  assert.equal(one.node.querySelector('dialog').open, false);
  assert.equal(two.node.querySelector('dialog').open, true);
  message(s, first, 'escape'); assert.equal(two.node.querySelector('dialog').open, true);
  message(s, second, 'resize', { height: 4096, naturalHeight: 9000, naturalWidth: 728, capped: true });
  await new Promise(resolve => setTimeout(resolve, 135));
  assert.equal(second.style.height, '9000px'); assert.equal(two.node.dataset.capped, 'true');
  two.dispose(); two.dispose();
  assert.equal(two.node.querySelector('dialog').open, false); assert.equal(two.node.querySelector('iframe'), null);
  assert.equal(s.released.length, 1); one.dispose(); assert.equal(s.released.length, 2);
});

test('a browser without native modal support retains the inline artifact and disables expansion', async t => {
  const s = surface(t, undefined, { dialog: false }), viewer = mounted(s); await tick(); await tick();
  const frame = viewer.node.querySelector('iframe'); message(s, frame, 'ready');
  const expand = viewer.node.querySelector('.html-artifact-expand');
  assert.equal(expand.disabled, true); expand.click();
  assert.equal(viewer.node.querySelector('dialog').open, false); assert.equal(viewer.node.dataset.state, 'ready');
});

test('a valid link uses the host confirmation, not the frame nonce, before the existing web bridge', async t => {
  const s = surface(t), viewer = mounted(s), opened = []; await tick(); await tick();
  const frame = viewer.node.querySelector('iframe'); message(s, frame, 'ready');
  s.w.piGuiDesktop.openWebUrl = async href => { opened.push(href); return { ok: true }; };
  message(s, frame, 'link', { href: 'https://example.invalid/report' });
  assert.equal(s.d.querySelector('#confirmLayer').hidden, true); assert.equal(opened.length, 0);
  Object.defineProperty(s.w.navigator, 'userActivation', { value: { isActive: true } });
  viewer.node.querySelector('.html-artifact-expand').click(); frame.focus();
  message(s, frame, 'link', { href: 'https://example.invalid/report' }); await tick();
  assert.equal(viewer.node.querySelector('dialog').open, false);
  assert.equal(s.d.querySelector('#confirmLayer').hidden, false); assert.equal(opened.length, 0);
  s.d.querySelector('#confirmCard .btn.primary').click(); await tick();
  assert.deepEqual(opened, ['https://example.invalid/report']); assert.equal(s.reads.length, 1);
});

test('disposing an artifact cancels its own pending link confirmation and never opens a late URL', async t => {
  const s = surface(t), viewer = mounted(s), opened = []; await tick(); await tick();
  const frame = viewer.node.querySelector('iframe'); message(s, frame, 'ready');
  Object.defineProperty(s.w.navigator, 'userActivation', { value: { isActive: true } });
  s.w.piGuiDesktop.openWebUrl = async href => { opened.push(href); return { ok: true }; };
  frame.focus(); message(s, frame, 'link', { href: 'https://example.invalid/report' }); await tick();
  assert.equal(s.d.querySelector('#confirmLayer').hidden, false);
  viewer.dispose(); await tick();
  assert.equal(s.d.querySelector('#confirmLayer').hidden, true); assert.equal(opened.length, 0);
});

test('bounded raster images open a separate host image element and clear on dispose', async t => {
  const s = surface(t), viewer = mounted(s); await tick(); await tick();
  const frame = viewer.node.querySelector('iframe'); message(s, frame, 'ready');
  const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=';
  const raster = s.w.artifactRaster(src, s.w);
  assert.equal(raster.width, 1); assert.equal(raster.height, 1);
  assert.equal(s.w.artifactRaster('data:image/svg+xml;base64,PHN2Zy8+', s.w), null);
  Object.defineProperty(s.w.navigator, 'userActivation', { value: { isActive: true } });
  frame.focus(); message(s, frame, 'image', { src, alt: '1px fixture' });
  const dialog = s.d.querySelector('.html-artifact-image-dialog');
  assert.equal(dialog.open, true); assert.equal(dialog.querySelector('img').alt, '1px fixture');
  assert.equal(dialog.querySelector('img').getAttribute('src'), src);
  assert.equal(viewer.node.querySelector('iframe'), frame);
  viewer.dispose(); assert.equal(s.d.querySelector('.html-artifact-image-dialog'), null);
});

test('expanded sizes stay bounded and return to the v1 capped inline viewport', async t => {
  const s = surface(t), viewer = mounted(s); await tick(); await tick();
  const frame = viewer.node.querySelector('iframe'); message(s, frame, 'ready');
  message(s, frame, 'resize', { height: 4096, naturalHeight: 1000000, naturalWidth: 728, capped: true });
  await new Promise(resolve => setTimeout(resolve, 135));
  assert.equal(frame.style.height, '4096px');
  viewer.node.querySelector('.html-artifact-expand').click(); assert.equal(frame.style.height, '65536px');
  viewer.node.querySelector('[aria-label="关闭全屏"]').click(); assert.equal(frame.style.height, '4096px');
});

test('Runtime production renderer wires multiple live artifacts, isolates sessions, destroys on leave and reopens by scoped read', async t => {
  const a = reference(), b = reference('two'), s = surface(t, 'runtime-conversation.js', { artifacts: [a, b] });
  s.w.runtimeStore.seed({ backendInstance: 'fixture', items: [item('A'), item('B')] });
  const host = s.d.createElement('div'); s.d.body.append(host);
  const view = s.w.createRuntimeConversation({ host }); s.cleanups.push(() => view.dispose()); view.show('A');
  let sequence = 0;
  const emit = event => s.w.observeRuntimeFrame({ type: 'runtime_event', owner: owner(), eventSequence: ++sequence, event });
  emit({ type: 'agent_start' });
  emit({ type: 'message_start', message: { role: 'user', content: [text('request')] } });
  emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before' } });
  for (const ref of [a, b, a]) {
    emit({ type: 'tool_execution_start', toolCallId: ref.toolCallId, toolName: 'html_render' });
    emit({ type: 'tool_execution_end', toolCallId: ref.toolCallId, result: result(ref) });
  }
  emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'after' } });
  emit({ type: 'agent_settled' }); await tick(); await tick();
  assert.equal(host.querySelectorAll('.html-artifact').length, 2);
  assert.ok([...host.querySelectorAll('.html-artifact')].every(node => !node.closest('[data-conversation-work]')));
  assert.ok(s.reads.every(read => read.scope.conversationId === 'A'));
  view.show('B'); assert.equal(host.querySelectorAll('.html-artifact').length, 0);
  assert.equal(s.released.length, 2);
  view.show('A'); await tick(); await tick(); assert.equal(host.querySelectorAll('.html-artifact').length, 2);
  assert.equal(s.reads.length, 4, 'reopening reads explicitly; no HTML state cache');
  view.leave(); assert.equal(host.querySelectorAll('.html-artifact iframe').length, 0); assert.equal(s.released.length, 4);
});
