const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom'); const { bundle } = require('./esm-bundle.cjs');
const root = path.resolve(__dirname, '..'); let passed = 0;
const dom = new JSDOM(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'), { url: 'http://fixture.invalid', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window, d = w.document;
w.matchMedia = () => ({ matches: false, addEventListener() {} });
w.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
w.ResizeObserver = class { observe() {} disconnect() {} };
w.HTMLElement.prototype.scrollIntoView = () => {};
w.eval(bundle(path.join(root, 'public/session-navigation.js')).code);
const wait = () => new Promise(r => setTimeout(r, 0));
const find = text => [...d.querySelectorAll('#workSurface button')].find(e => e.textContent === text);
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
(async () => {
  Object.assign(w.S, { cwd: 'C:/fixture/A', streaming: true, state: { sessionId: 'A' } });
  const body = d.createElement('div'); body.textContent = 'A streaming tool'; d.getElementById('stream').append(body);
  const reads = [], handoffs = [], parallel = [];
  const nav = w.createSessionNavigation({ background: () => true,
    readHistory: (id, project) => new Promise(resolve => reads.push({ id, project, resolve })),
    readSessions: async () => ({ ok: true, sessions: [] }),
    continueSession: async (...args) => handoffs.push(args), newSession: async (...args) => handoffs.push(args),
    createParallel: project => parallel.push(project) });
  const project = { path: w.S.cwd, name: 'A project' }, b = { id: 'B', sessionId: 'native-B', title: 'B' };
  await check('A running -> B view does not clear messages, stop or switch the original session', async () => {
    assert.equal(nav.open(b, project), true); assert.equal(w.S.streaming, true);
    assert.equal(w.S.state.sessionId, 'A'); assert.equal(body.isConnected, true);
    reads[0].resolve({ ok: true, messages: [{ role: 'assistant', text: 'B history', userIndex: 0 }] }); await wait();
    assert.ok(d.getElementById('workSurface').textContent.includes('B history'));
  });
  await check('ordinary B cannot submit into A while the shared workspace is executing', async () => {
    find('继续此会话').click(); await wait(); assert.equal(handoffs.length, 0);
    assert.ok(d.getElementById('workSurface').textContent.includes('同一工作目录'));
  });
  await check('B draft is isolated and persistent in the existing draft store', async () => {
    const input = d.querySelector('#workSurface textarea'); input.value = 'B draft'; input.dispatchEvent(new w.Event('input'));
    assert.equal(w.readDraftText(w.draftKey(w.hashKey(project.path), w.hashKey('native-B'))), 'B draft');
    nav.open({ current: true }, project); assert.equal(w.workspaceView(), 'chat'); assert.equal(body.isConnected, true);
    nav.open(b, project); assert.equal(d.querySelector('#workSurface textarea').value, 'B draft');
  });
  await check('rapid B/C switch rejects the late B response', async () => {
    nav.open({ id: 'C', title: 'C' }, project);
    reads[2].resolve({ ok: true, messages: [{ role: 'assistant', text: 'current C' }] });
    reads[1].resolve({ ok: true, messages: [{ role: 'assistant', text: 'stale B' }] }); await wait();
    assert.ok(d.getElementById('workSurface').textContent.includes('current C'));
    assert.ok(!d.getElementById('workSurface').textContent.includes('stale B'));
  });
  await check('browsing another project preserves A cwd and the original stream', async () => {
    assert.equal(nav.openProject({ path: 'C:/fixture/other', name: 'Other' }), true); await wait();
    assert.equal(w.S.cwd, project.path); assert.equal(w.S.streaming, true); assert.equal(body.isConnected, true);
  });
  await check('running new session opens a draft and only explicit isolated launch delegates to Runtime', async () => {
    assert.equal(nav.newDraft(project), true); assert.equal(handoffs.length, 0);
    find('在独立工作区新建并行会话').click(); assert.equal(parallel.length, 1); assert.equal(parallel[0].path, project.path);
    find('创建此会话').click(); await wait(); assert.equal(handoffs.length, 0);
  });
  await check('search results without native IDs use distinct persistent draft keys', async () => {
    nav.open({ id: 'search-B' }, project);
    const input = d.querySelector('#workSurface textarea'); input.value = 'search B draft'; input.dispatchEvent(new w.Event('input'));
    nav.open({ id: 'search-C' }, project); assert.equal(d.querySelector('#workSurface textarea').value, '');
    assert.equal(w.readDraftText(w.draftKey(w.hashKey(project.path), 'history-' + w.hashKey('search-B'))), 'search B draft');
  });
  await check('new draft transfer requires its acknowledgement and a new native session in the same workspace generation', async () => {
    w.S.streaming = false; w.S.workspaceGeneration = 2;
    const restored = [], requests = [];
    const transfer = w.createSessionNavigation({ background: () => true,
      newSession: async (p, text, id) => { requests.push(id); return true; }, restoreNewDraft: text => restored.push(text) });
    transfer.newDraft(project); const input = d.querySelector('#workSurface textarea');
    input.value = 'scoped new draft'; input.dispatchEvent(new w.Event('input')); find('创建此会话').click(); await wait();
    w.S.state.sessionId = 'new-native';
    transfer.observeResponse({ command: 'get_state', success: true }); assert.equal(restored.length, 0);
    transfer.observeResponse({ command: 'new_session', id: requests[0], success: true, _replay: true });
    transfer.observeResponse({ command: 'get_state', success: true }); assert.equal(restored.length, 0);
    transfer.observeResponse({ command: 'new_session', id: requests[0], success: true });
    w.S.workspaceGeneration = 3; transfer.observeResponse({ command: 'get_state', success: true }); assert.equal(restored.length, 0);
    w.S.workspaceGeneration = 2; transfer.observeResponse({ command: 'get_state', success: true });
    assert.deepEqual(restored, ['scoped new draft']);
    assert.equal(w.readDraftText(w.draftKey(w.hashKey(project.path), w.hashKey('new-native'))), 'scoped new draft');
  });
  console.log(`Session background UI: ${passed}/${passed}; failed=0`);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => dom.window.close());
