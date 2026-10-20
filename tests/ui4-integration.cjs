/* Cross-component regression fixtures. No real Pi, filesystem writes or network. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');
const ROOT = path.resolve(__dirname, '..');
const reviewRoots = process.env.UI4_REVIEW_ROOTS ? JSON.parse(process.env.UI4_REVIEW_ROOTS) : {};
let passed = 0, failed = 0;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function check(name, test) {
  try { await test(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}
function fixture(area, entry) {
  const root = reviewRoots[area] || ROOT;
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'), {
    url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document, calls = [];
  let gate = null, response = { ok: true }, jsonFailure = false, runtimeSnapshot = null, runtimeReads = 0;
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.fetch = async (url, options) => {
    if (String(url) === '/api/command' || String(url) === '/api/runtime-sessions' && options?.body) {
      calls.push(JSON.parse(options.body));
      if (gate) await gate;
      return { json: async () => { if (jsonFailure) throw new Error('fixture response lost after acceptance'); return response; } };
    }
    if (String(url) === '/api/runtime-sessions' && runtimeSnapshot) { runtimeReads++; return { json: async () => JSON.parse(JSON.stringify(runtimeSnapshot)) }; }
    return { json: async () => ({ ok: false }) };
  };
  w.eval(bundle(path.join(root, 'public', entry)).code);
  if (w.S) Object.assign(w.S, { workspaceGeneration: 10, bridgeRun: 20, bridgeState: 'ready', switching: false, hasProject: true, state: { sessionId: 'fixture-A' } });
  return { w, d, calls, close: () => dom.window.close(), runtimeReads: () => runtimeReads, defer() { let release; gate = new Promise(resolve => { release = resolve; }); return release; }, respond(value) { response = value; }, reject(error = 'fixture_rejected') { response = { ok: false, error }; }, loseResponse() { jsonFailure = true; }, runtimeSnapshot(value) { runtimeSnapshot = value; } };
}
const request = (id, method = 'confirm') => ({ type: 'extension_ui_request', id, method, title: id, message: 'fixture operation', options: ['one', 'two'] });
const click = (d, text, id = 'confirmCard') => {
  const button = [...d.getElementById(id).querySelectorAll('button')].find(b => b.textContent === text);
  assert.ok(button, 'expected existing button ' + text); button.click();
};

(async () => {
  for (const decision of ['允许一次', '拒绝']) for (const lifecycle of ['expired', 'stop', 'workspace', 'session', 'bridge', 'timeout']) {
    await check('late ' + decision + ' success cannot authorize replacement after ' + lifecycle, async () => {
      const f = fixture('B', 'approval.js');
      try {
        const { w, d, calls } = f, release = f.defer();
        w.observeApprovalEvent({ ...request('old'), ...(lifecycle === 'timeout' ? { timeout: 1 } : {}) }, w.S); click(d, decision);
        assert.equal(calls.length, 1);
        if (lifecycle === 'stop') w.cancelPendingApprovals();
        else if (lifecycle === 'workspace') { w.S.workspaceGeneration++; d.dispatchEvent(new w.CustomEvent('pi-gui:workspace-generation')); }
        else if (lifecycle === 'session') d.dispatchEvent(new w.CustomEvent('pi-gui:session-switch'));
        else if (lifecycle === 'bridge') { w.observeApprovalEvent({ type: 'bridge_status', state: 'restarting' }, w.S); w.S.bridgeRun++; }
        else if (lifecycle === 'timeout') {
          for (let i = 0; i < 100 && !w.approvalSnapshot().settled.some(x => x.requestId === 'old'); i++) await new Promise(resolve => setTimeout(resolve, 5));
          assert.ok(w.approvalSnapshot().settled.some(x => x.requestId === 'old'));
        } else w.expireAll('fixture');
        d.getElementById('toasts').replaceChildren();
        w.observeApprovalEvent(request('new'), w.S);
        release(); await tick(); await tick();
        assert.equal(calls.length, 1, 'new request must receive no implicit response');
        assert.equal(d.getElementById('confirmLayer').hidden, false);
        assert.equal(w.confirmSurfaceMeta().requestId, 'new');
        assert.ok(!w.approvalSnapshot().settled.some(x => x.requestId === 'new'));
        assert.equal(d.getElementById('toasts').children.length, 0, 'stale delivery must not toast into replacement context');
      } finally { f.close(); }
    });
  }
  await check('old failure cannot unlock or alter replacement submitting confirmation', async () => {
    const f = fixture('B', 'approval.js');
    try {
      const { w, d } = f, release = f.defer();
      w.observeApprovalEvent(request('old'), w.S); click(d, '允许一次');
      w.expireAll('fixture'); f.defer(); w.observeApprovalEvent(request('new'), w.S); click(d, '拒绝');
      f.reject(); release(); await tick(); await tick();
      assert.equal(w.confirmSurfaceMeta().requestId, 'new');
      assert.equal(d.getElementById('confirmCard').getAttribute('aria-busy'), 'true');
      assert.ok([...d.getElementById('confirmCard').querySelectorAll('button')].every(b => b.disabled));
      assert.equal(d.getElementById('confirmLayer').hidden, false);
      assert.equal(f.calls.length, 2);
    } finally { f.close(); }
  });
  await check('late select success cannot close an unrelated replacement modal', async () => {
    const f = fixture('B', 'approval.js');
    try {
      const { w, d } = f, release = f.defer();
      w.observeApprovalEvent(request('select-old', 'select'), w.S); click(d, 'one', 'modalCard');
      w.openModal(card => { const h = d.createElement('h3'); h.textContent = 'replacement'; card.append(h); });
      release(); await tick(); await tick();
      assert.equal(d.getElementById('modal').hidden, false);
      assert.equal(d.getElementById('modalCard').textContent, 'replacement');
    } finally { f.close(); }
  });
  for (const method of ['confirm', 'select']) for (const unknown of [false, true]) {
    await check('replaced ' + method + ' retains visible late ' + (unknown ? 'unknown' : 'refusal') + ' without touching replacement', async () => {
      const f = fixture('B', 'approval.js');
      try {
        const release = f.defer();
        f.w.observeApprovalEvent(request('replaced-old', method), f.w.S);
        click(f.d, method === 'confirm' ? '允许一次' : 'one', method === 'confirm' ? 'confirmCard' : 'modalCard');
        if (method === 'confirm') f.w.confirmModal({ title: 'replacement' });
        else f.w.openModal(card => { card.textContent = 'replacement'; });
        if (unknown) f.loseResponse(); else f.reject();
        release(); await tick(); await tick();
        const card = f.d.getElementById(method === 'confirm' ? 'confirmCard' : 'modalCard');
        assert.match(card.textContent, /replacement/);
        const warning = f.d.querySelector('.toast.warn'); assert.ok(warning);
        assert.match(warning.textContent, unknown ? /未知/ : /未被后端接受/);
        assert.equal(warning._ui4Remaining, undefined, 'retired surface failure stays traceable until dismissed');
        assert.equal(f.calls.length, 1);
      } finally { f.close(); }
    });
  }
  await check('lost response after acceptance is unknown and cannot send a second decision', async () => {
    const f = fixture('B', 'approval.js');
    try {
      const { w, d } = f;
      f.loseResponse(); w.observeApprovalEvent(request('ambiguous'), w.S); click(d, '允许一次');
      await tick(); await tick();
      const card = d.getElementById('confirmCard');
      assert.match(card.textContent, /未知|无法确认/);
      assert.doesNotMatch(card.textContent, /应答没有送达|Pi 仍在等待/);
      assert.equal(d.querySelectorAll('.toast').length, 0, 'owned card displays delivery once');
      assert.equal(f.calls[0].__bridgeRun, 20); assert.equal('notify' in f.calls[0], false);
      click(d, '允许一次'); click(d, '拒绝'); await tick();
      w.cancelPendingApprovals(); await tick();
      assert.equal(f.calls.length, 1, 'Stop cannot retract or contradict a potentially accepted decision');
    } finally { f.close(); }
  });
  await check('identical errors in different workspace generations are not deduplicated', async () => {
    const f = fixture('C', 'ui/notice.js');
    try {
      const first = f.w.toast('same fixture failure', 'error');
      f.w.S.workspaceGeneration++;
      f.d.dispatchEvent(new f.w.CustomEvent('pi-gui:workspace-generation'));
      const next = f.w.toast('same fixture failure', 'error');
      assert.ok(next, 'a new-context failure must not be suppressed'); assert.notEqual(next, first);
      const current = [...f.d.querySelectorAll('.toast')].filter(n => n.dataset.contextStale !== 'true' && n.dataset.leaving !== 'true');
      assert.equal(current.length, 1, 'a real failure in the new context remains visible');
    } finally { f.close(); }
  });
  await check('ordinary command errors retain existing notification and wire behaviour', async () => {
    const f = fixture('B', 'approval.js');
    try {
      f.loseResponse(); const result = await f.w.sendCommand({ type: 'get_state' });
      assert.equal(result.ok, false); assert.equal(result.network, true);
      assert.equal(f.d.querySelectorAll('.toast.error').length, 1);
      assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), { type: 'get_state', __bridgeRun: 20 });
    } finally { f.close(); }
  });
  await check('malformed acknowledgement is unknown and cannot authorize a retry', async () => {
    const f = fixture('B', 'approval.js');
    try {
      f.respond({}); f.w.observeApprovalEvent(request('malformed'), f.w.S); click(f.d, '允许一次');
      await tick(); await tick();
      assert.match(f.d.getElementById('confirmCard').textContent, /未知/);
      assert.equal(f.d.querySelector('#confirmCard .primary').disabled, true);
      f.w.cancelPendingApprovals(); await tick(); assert.equal(f.calls.length, 1);
    } finally { f.close(); }
  });
  await check('Notice same text updates callbacks and cannot retain a stale workspace action', async () => {
    const f = fixture('C', 'ui/notice.js');
    try {
      let oldCalls = 0, currentCalls = 0;
      const model = run => ({ id: 'fixture', tone: 'bad', title: 'fixture failure', actions: [{ label: '重试', run }] });
      f.w.showNotice(model(() => oldCalls++));
      f.w.S.workspaceGeneration++;
      f.d.dispatchEvent(new f.w.CustomEvent('pi-gui:workspace-generation'));
      f.w.showNotice(model(() => currentCalls++));
      f.d.querySelector('.notice-actions button').click();
      assert.equal(oldCalls, 0); assert.equal(currentCalls, 1);
    } finally { f.close(); }
  });
  await check('Notice same-context handler refresh preserves DOM and focus', async () => {
    const f = fixture('C', 'ui/notice.js');
    try {
      let oldCalls = 0, nextCalls = 0;
      const model = run => ({ id: 'same', title: 'same', actions: [{ label: '重试', run }] });
      f.w.showNotice(model(() => oldCalls++));
      const button = f.d.querySelector('.notice-actions button'); button.focus();
      f.w.showNotice(model(() => nextCalls++));
      assert.equal(f.d.querySelector('.notice-actions button'), button);
      assert.equal(f.d.activeElement, button); button.click();
      assert.equal(oldCalls, 0); assert.equal(nextCalls, 1);
    } finally { f.close(); }
  });
  await check('Runtime A to B same-text feedback is not deduplicated and old action is disabled', async () => {
    const f = fixture('C', 'ui/notice.js');
    try {
      let scope = ['A', 'one'], oldCalls = 0;
      f.w.configureFeedbackContext(() => scope);
      const first = f.w.toast('runtime fixture failure', 'error', { action: { label: '重试', run: () => oldCalls++ } });
      scope = ['B', 'one']; f.d.dispatchEvent(new f.w.CustomEvent('pi-gui:workspace-view', { detail: { view: 'runtime' } }));
      const next = f.w.toast('runtime fixture failure', 'error');
      assert.ok(next); assert.notEqual(first, next);
      assert.equal(first.dataset.contextStale, 'true');
      first.querySelector('.ui4-feedback-toast-action').click(); assert.equal(oldCalls, 0);
      assert.equal(first.querySelector('.ui4-feedback-toast-action').disabled, true);
    } finally { f.close(); }
  });
  await check('Classic global Notice survives Runtime owner navigation but expires with its real Classic context', async () => {
    const f = fixture('C', 'ui/notice.js');
    try {
      let scope = ['A', 'one'], oldCalls = 0, currentCalls = 0;
      f.w.configureFeedbackContext(() => scope);
      const model = run => ({ id: 'runtime', title: 'same Runtime failure', actions: [{ label: '重试', run }] });
      f.w.showNotice(model(() => oldCalls++)); const old = f.d.querySelector('.notice-actions button');
      scope = ['A', 'two']; f.w.refreshFeedbackContext();
      assert.equal(f.d.getElementById('stageNotice').hidden, false);
      old.click(); assert.equal(oldCalls, 1, 'valid Classic bridge action is not reattributed to Runtime');
      f.w.S.workspaceGeneration++; f.d.dispatchEvent(new f.w.CustomEvent('pi-gui:workspace-generation'));
      assert.equal(f.d.getElementById('stageNotice').hidden, true);
      old.click(); assert.equal(oldCalls, 1);
      f.w.showNotice(model(() => currentCalls++)); f.d.querySelector('.notice-actions button').click();
      assert.equal(currentCalls, 1);
    } finally { f.close(); }
  });
  await check('Toast pointer leave cannot resume a timer while its button has focus', async () => {
    const f = fixture('C', 'ui/notice.js');
    try {
      const toast = f.w.toast('timed mixed focus', 'info', { important: true, duration: 30 });
      toast.dispatchEvent(new f.w.Event('pointerenter'));
      toast.querySelector('button').focus();
      toast.dispatchEvent(new f.w.Event('pointerleave'));
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.notEqual(toast.dataset.leaving, 'true');
      f.d.getElementById('input').focus();
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(toast.dataset.leaving, 'true');
    } finally { f.close(); }
  });
  function sessionFixture(context, held = false) {
    const f = fixture('A', 'session-changes-panel.js');
    let release;
    const callbacks = [], root = f.d.getElementById('rightPane');
    f.w.configureSecondaryPane({ root, open(view) { root.hidden = false; callbacks.forEach(fn => fn(view)); }, close() { callbacks.forEach(fn => fn(null)); }, onSurfaceChange(fn) { callbacks.push(fn); } });
    const summary = { ok: true, target: { conversationId: context.conversationId }, capture: { enabled: false }, fileCount: 0, operationCount: 0, files: [] };
    const transport = { query: () => held ? new Promise(resolve => { release = () => resolve(summary); }) : Promise.resolve(summary) };
    const panel = f.w.openSessionChangesPanel({ context: () => context, transport });
    return { ...f, panel, release: () => release() };
  }
  for (const context of [{ conversationId: 'runtime-A', owner: null }, { conversationId: 'classic-chat', owner: null }]) {
    await check(context.conversationId + ' unknown owner cannot match explicit foreign workspace', async () => {
      const f = sessionFixture(context);
      try {
        await tick(); await tick(); assert.ok(f.d.querySelector('.session-change-summary'));
        f.d.dispatchEvent(new f.w.CustomEvent('pi-gui:session-evidence-changed', { detail: { workspaceId: 'foreign', workspaceEpoch: 'epoch' } }));
        assert.ok(f.d.querySelector('.session-change-summary'));
      } finally { f.panel.dispose(); f.close(); }
    });
  }
  await check('Runtime missing owner and workspace never consumes missing-identity Classic evidence', async () => {
    const f = sessionFixture({ conversationId: 'runtime-A', owner: null });
    try {
      await tick(); await tick();
      f.d.dispatchEvent(new f.w.CustomEvent('pi-gui:session-evidence-changed'));
      assert.ok(f.d.querySelector('.session-change-summary'));
    } finally { f.panel.dispose(); f.close(); }
  });
  await check('only identity-free Classic evidence invalidates the identity-free Classic preview', async () => {
    const f = sessionFixture({ conversationId: 'classic-chat', owner: null });
    try {
      await tick(); await tick(); assert.ok(f.d.querySelector('.session-change-summary'));
      f.d.dispatchEvent(new f.w.CustomEvent('pi-gui:session-evidence-changed', { detail: {} }));
      assert.equal(f.d.querySelector('.session-change-summary'), null);
      assert.match(f.d.querySelector('.session-change-body').textContent, /变化|过期|失效/);
    } finally { f.panel.dispose(); f.close(); }
  });
  await check('known Runtime workspace invalidation requires both matching id and epoch', async () => {
    const f = sessionFixture({ conversationId: 'runtime-A', owner: { workspaceId: 'A', workspaceEpoch: 'one' } });
    try {
      await tick(); await tick(); assert.ok(f.d.querySelector('.session-change-summary'));
      f.d.dispatchEvent(new f.w.CustomEvent('pi-gui:session-evidence-changed', { detail: { workspaceId: 'A', workspaceEpoch: 'two' } }));
      assert.ok(f.d.querySelector('.session-change-summary'));
      f.d.dispatchEvent(new f.w.CustomEvent('pi-gui:session-evidence-changed', { detail: { workspaceId: 'A', workspaceEpoch: 'one' } }));
      assert.equal(f.d.querySelector('.session-change-summary'), null);
    } finally { f.panel.dispose(); f.close(); }
  });
  for (const event of ['pi-gui:session-evidence-changed', 'pi-gui:session-switch']) {
    await check('cancelled loading clears busy immediately and ignores late result: ' + event, async () => {
      const f = sessionFixture({ conversationId: 'classic-chat', owner: null }, true);
      try {
        assert.equal(f.d.querySelector('.session-change-body').getAttribute('aria-busy'), 'true');
        f.d.dispatchEvent(new f.w.CustomEvent(event, { detail: {} }));
        assert.notEqual(f.d.querySelector('.session-change-body').getAttribute('aria-busy'), 'true');
        f.release(); await tick(); await tick();
        assert.ok(!f.d.querySelector('.session-change-summary'));
      } finally { f.panel.dispose(); f.close(); }
    });
  }
  function processFixture(transport) {
    const f = fixture('A', 'process-panel.js'), listeners = [];
    let poll, delay, cleared = false;
    f.w.setInterval = (fn, ms) => { poll = fn; delay = ms; return 1; };
    f.w.clearInterval = () => { cleared = true; };
    f.w.configureSecondaryPane({ root: f.d.getElementById('rightPane'), open(view) { listeners.forEach(fn => fn(view)); }, close() { listeners.forEach(fn => fn(null)); }, onSurfaceChange(fn) { listeners.push(fn); } });
    f.w.openProcessPanel({ transport });
    return { ...f, poll: () => poll(), delay: () => delay, cleared: () => cleared,
      dispose: () => f.w.openSecondarySurface('changes', host => { host.textContent = 'replacement'; }) };
  }
  const processRecord = revision => ({ id: 'fixture-process', revision, command: 'node', argCount: 1, state: 'ready', uptimeMs: 100, cleanupConfirmed: true });
  await check('process polling stays serial across manual refresh and pending logs', async () => {
    let statusCalls = 0, release;
    const f = processFixture({ status: async () => { statusCalls++; return { ok: true, generation: 'g1', enabled: true, processes: [processRecord(1)] }; }, logs: () => new Promise(resolve => { release = resolve; }), control: async () => ({ ok: true }) });
    try {
      await tick(); assert.equal(f.delay(), 1000);
      f.poll(); f.poll(); [...f.d.querySelectorAll('.rp-head button')].find(b => b.textContent === '刷新').click();
      assert.equal(statusCalls, 1);
      release({ ok: true, cursor: 1, lines: [{ text: 'sanitized fixture line' }] }); await tick();
      assert.match(f.d.querySelector('.process-logs').textContent, /sanitized fixture/);
    } finally { f.dispose(); f.close(); }
  });
  await check('process revision resets cursor and Stop retains real generation/id/revision transport', async () => {
    let revision = 1; const logs = [], controls = [];
    const f = processFixture({ status: async () => ({ ok: true, generation: 'g1', enabled: true, processes: [processRecord(revision)] }), logs: async (...args) => { logs.push(args); return { ok: true, cursor: 9, lines: [{ text: 'revision-' + revision }] }; }, control: async body => { controls.push(body); return { ok: true }; } });
    try {
      await tick(); await tick(); revision = 2; await f.poll();
      assert.equal(logs.at(-1)[3], 0); assert.equal(logs.at(-1)[2], 2);
      assert.doesNotMatch(f.d.querySelector('.process-logs').textContent, /revision-1/);
      [...f.d.querySelectorAll('.process-actions button')].find(b => b.textContent === '停止').click(); await tick(); await tick();
      assert.deepEqual(JSON.parse(JSON.stringify(controls[0])), { action: 'stop', generation: 'g1', id: 'fixture-process', revision: 2 });
      assert.equal(controls.filter(x => x.action === 'start').length, 0);
    } finally { f.dispose(); f.close(); }
  });
  await check('process dispose clears polling and rejects late log writes to replacement surface', async () => {
    let release;
    const f = processFixture({ status: async () => ({ ok: true, generation: 'g1', enabled: true, processes: [processRecord(1)] }), logs: () => new Promise(resolve => { release = resolve; }), control: async () => ({ ok: true }) });
    try {
      await tick(); f.dispose(); assert.equal(f.cleared(), true);
      release({ ok: true, cursor: 3, lines: [{ text: 'OLD_LOG_MUST_NOT_APPEAR' }] }); await tick(); await tick();
      assert.doesNotMatch(f.d.getElementById('rightPane').textContent, /OLD_LOG_MUST_NOT_APPEAR/);
    } finally { f.close(); }
  });
  await check('process logs stay bounded and render untrusted text without HTML execution', async () => {
    const text = '<img src=x onerror="window.bad=1"> ' + 'x'.repeat(300);
    const f = processFixture({ status: async () => ({ ok: true, generation: 'g1', enabled: true, processes: [processRecord(1)] }), logs: async () => ({ ok: true, cursor: 300, truncated: true, lines: Array.from({ length: 300 }, () => ({ text })) }), control: async () => ({ ok: true }) });
    try {
      await tick(); await tick(); const log = f.d.querySelector('.process-logs');
      assert.ok(log.textContent.length <= 65536); assert.ok(log.textContent.split('\n').length <= 256);
      assert.equal(log.querySelector('img'), null); assert.equal(f.w.bad, undefined);
    } finally { f.dispose(); f.close(); }
  });
  for (const method of ['confirm', 'select']) for (const exit of ['Escape', 'backdrop', 'replace', 'Stop']) {
    await check('unknown ' + method + ' closes locally without contradictory response: ' + exit, async () => {
      const f = fixture('B', 'approval.js');
      try {
        const { w, d } = f; f.loseResponse();
        w.observeApprovalEvent(request('unknown-exit', method), w.S);
        click(d, method === 'confirm' ? '允许一次' : 'one', method === 'confirm' ? 'confirmCard' : 'modalCard');
        await tick(); await tick();
        const layer = d.getElementById(method === 'confirm' ? 'confirmLayer' : 'modal');
        const card = d.getElementById(method === 'confirm' ? 'confirmCard' : 'modalCard');
        assert.match(card.textContent, /未知|无法确认/);
        if (exit === 'Escape') d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        else if (exit === 'backdrop') layer.click();
        else if (exit === 'Stop') w.cancelPendingApprovals();
        else if (method === 'confirm') w.confirmModal({ title: 'replacement' });
        else w.openModal(node => { node.textContent = 'replacement'; });
        await tick(); await tick();
        assert.equal(f.calls.length, 1);
        assert.ok(layer.hidden || card.textContent.includes('replacement'));
        w.observeApprovalEvent(request('unknown-exit', method), w.S);
        assert.doesNotMatch(card.textContent, /fixture operation/);
      } finally { f.close(); }
    });
  }
  await check('ordinary modal bound close cannot close a replacement instance', async () => {
    const f = fixture('B', 'ui/modal.js');
    try {
      let oldClose; f.w.openModal((card, close) => { oldClose = close; card.textContent = 'old'; });
      f.w.openModal(card => { card.textContent = 'new'; }); oldClose();
      assert.equal(f.d.getElementById('modal').hidden, false);
      assert.equal(f.d.getElementById('modalCard').textContent, 'new');
    } finally { f.close(); }
  });
  await check('view navigation preserves real Classic pending with explicit provenance', async () => {
    const f = fixture('B', 'approval.js');
    try {
      f.w.observeApprovalEvent(request('classic-background'), f.w.S);
      f.d.getElementById('workspace').dataset.workspaceView = 'runtime';
      f.d.dispatchEvent(new f.w.CustomEvent('pi-gui:workspace-view', { detail: { view: 'runtime' } }));
      assert.equal(f.d.getElementById('confirmLayer').hidden, false);
      assert.match(f.d.getElementById('confirmCard').textContent, /经典会话/);
      assert.equal(f.w.approvalSnapshot().pending.length, 1);
      assert.equal(f.calls.length, 0);
      click(f.d, '拒绝'); await tick(); await tick();
      assert.equal(f.calls.length, 1); assert.equal(f.calls[0].confirmed, false);
    } finally { f.close(); }
  });
  const runtimeOwner = generation => ({ backendInstance: 'fixture-backend', projectId: 'project', repoId: 'repo', workspaceId: 'workspace', workspaceEpoch: 'epoch', conversationId: 'runtime-fixture', runtimeId: 'rt-' + generation, runtimeGeneration: generation, sessionId: 's-' + generation });
  const runtimeSnapshot = generation => ({ ok: true, backendInstance: 'fixture-backend', items: [{ conversationId: 'runtime-fixture', revision: generation === 'one' ? 1 : 2, createdAt: '2026-01-01T00:00:00.000Z', workspace: { branch: 'fixture', projectId: 'project', workspaceId: 'workspace', workspaceEpoch: 'epoch' }, owner: runtimeOwner(generation), lifecycle: 'ready', activity: 'running', attention: false, focused: true, error: null, stop: null }] });
  for (const dialog of [false, true]) {
    await check('late old-owner approval rejection cannot change new-owner notice: ' + (dialog ? 'Runtime dialog' : 'Runtime conversation'), async () => {
      const f = fixture('R', dialog ? 'runtime-sessions.js' : 'runtime-conversation.js'); let view;
      try {
        const { w, d } = f;
        f.runtimeSnapshot(runtimeSnapshot('one')); w.seedRuntimeSnapshot(runtimeSnapshot('one'));
        if (dialog) w.openRuntimeSessions({ path: '/fixture' });
        else { view = w.createRuntimeConversation({ host: d.getElementById('runtimeView') }); view.show('runtime-fixture'); }
        await tick(); await tick();
        w.observeRuntimeFrame({ type: 'runtime_event', owner: runtimeOwner('one'), eventSequence: 1, event: { type: 'extension_ui_request', id: 'fixture-approval', method: 'confirm', title: 'fixture question' } });
        await tick();
        const row = d.querySelector(dialog ? '.runtime-approval' : '.rtc-approval'); assert.ok(row);
        const release = f.defer(); row.querySelector('button').click(); await tick();
        const next = runtimeSnapshot('two'); f.runtimeSnapshot(next); w.seedRuntimeSnapshot(next);
        const readsBefore = f.runtimeReads();
        f.reject('OLD_OWNER_APPROVAL_FAILURE'); release(); await tick(); await tick();
        assert.doesNotMatch(d.getElementById(dialog ? 'modalCard' : 'runtimeView').textContent, /OLD_OWNER_APPROVAL_FAILURE/);
        assert.equal(f.calls.filter(c => c.command?.type === 'extension_ui_response').length, 1);
        if (dialog) assert.ok(f.runtimeReads() > readsBefore, 'stale display must not skip authoritative refresh');
      } finally { view?.dispose?.(); f.close(); }
    });
  }
  for (const dialog of [false, true]) for (const accepted of [false, true]) {
    await check('current-owner approval outcome remains visible and refreshed: ' + dialog + '/' + accepted, async () => {
      const f = fixture('R', dialog ? 'runtime-sessions.js' : 'runtime-conversation.js'); let view;
      try {
        const { w, d } = f; const snapshot = runtimeSnapshot('one');
        f.runtimeSnapshot(snapshot); w.seedRuntimeSnapshot(snapshot);
        if (dialog) w.openRuntimeSessions({ path: '/fixture' });
        else { view = w.createRuntimeConversation({ host: d.getElementById('runtimeView') }); view.show('runtime-fixture'); }
        await tick(); await tick();
        w.observeRuntimeFrame({ type: 'runtime_event', owner: runtimeOwner('one'), eventSequence: 1, event: { type: 'extension_ui_request', id: 'current', method: 'confirm', title: 'current' } });
        await tick(); if (!accepted) f.reject('CURRENT_OWNER_FAILURE');
        const readsBefore = f.runtimeReads();
        d.querySelector(dialog ? '.runtime-approval button' : '.rtc-approval button').click();
        await tick(); await tick();
        const host = d.getElementById(dialog ? 'modalCard' : 'runtimeView');
        if (!accepted) assert.match(host.textContent, /CURRENT_OWNER_FAILURE/);
        else assert.doesNotMatch(host.textContent, /CURRENT_OWNER_FAILURE/);
        if (dialog) assert.ok(f.runtimeReads() > readsBefore);
        assert.equal(f.calls.length, 1);
      } finally { view?.dispose?.(); f.close(); }
    });
  }
  await check('unrelated toast scroll cannot close an open action menu; anchor/document scroll still does', async () => {
    const f = fixture('R', 'ui/action-menu.js');
    try {
      const { w, d } = f;
      const scroller = d.createElement('div');
      const anchor = d.createElement('button');
      anchor.textContent = 'fixture menu';
      scroller.appendChild(anchor);
      d.body.appendChild(scroller);
      w.openActionMenu(anchor, [{ label: 'one' }]);
      assert.ok(d.getElementById('actionMenu'), 'menu opens');
      /* UI-4C 的 Toast 栈是新的可滚动容器；它的滚动不会移动锚点。 */
      d.getElementById('toasts').dispatchEvent(new w.Event('scroll'));
      assert.ok(d.getElementById('actionMenu'), 'unrelated toast scroll must not close the menu');
      scroller.dispatchEvent(new w.Event('scroll'));
      assert.equal(d.getElementById('actionMenu'), null, 'anchor ancestor scroll closes');
      w.openActionMenu(anchor, [{ label: 'one' }]);
      d.dispatchEvent(new w.Event('scroll'));
      assert.equal(d.getElementById('actionMenu'), null, 'document scroll closes');
    } finally { f.close(); }
  });
  console.log(`UI4 integration: ${passed}/${passed + failed}; failed=${failed}; skipped=0`);
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
