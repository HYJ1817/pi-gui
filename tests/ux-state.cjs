const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('ok', name); }
  catch (e) { failed++; console.error('FAIL', name, e.message); }
}
async function main() {
  const pub = path.resolve(__dirname, '../public');
  const dom = new JSDOM(fs.readFileSync(path.join(pub, 'index.html'), 'utf8'), { url: 'http://fixture', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, calls = [], sources = [];
  const sessions = ['A', 'B'].map(id => ({ id, title: 'Session ' + id, sessionId: id, updatedAt: 1, messageCount: 3 }));
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'historical warning' }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'memory-call', name: 'memory_search', arguments: { query: 'fixture' } }] },
    { role: 'toolResult', toolCallId: 'memory-call', toolName: 'memory_search', isError: true, content: [{ type: 'text', text: 'memory_search requires qmd fixture warning' }] },
  ];
  const auth = { ok: true, capability: { sdkAvailable: true }, sync: {}, providers: [
    { providerId: 'bedrock', displayName: 'Amazon Bedrock', status: 'unknown', authenticated: null, authConfigured: null, models: [], methods: [] },
    { providerId: 'anthropic', displayName: 'Anthropic', status: 'unknown', authConfigured: null, models: [], methods: [] },
    { providerId: 'configured', status: 'unknown', authConfigured: true, models: [], methods: [] },
    { providerId: 'authenticated', status: 'connected', authenticated: true, models: [], methods: [{ type: 'oauth', canLogin: true }], canLogin: true, canLogout: true },
    { providerId: 'current', status: 'unknown', models: [], methods: [] },
    { providerId: 'models', status: 'unknown', models: [{ id: 'fixture' }], methods: [] },
  ] };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.EventSource = class { constructor() { sources.push(this); } emit(e) { this.onmessage({ data: JSON.stringify(e) }); } close() {} };
  let active = 'A';
  w.fetch = async (url, opts = {}) => {
    const u = String(url); calls.push([u, opts]);
    let j = { ok: true };
    if (u === '/api/status') j = { ok: true, cwd: 'C:\\fixture', hasProject: true, bridgeState: 'ready', bridgeRun: 1, bridgeInstance: 'fixture', bridgeRevision: 1 };
    else if (u === '/api/projects') j = { ok: true, active: 'C:\\fixture', items: [{ path: 'C:\\fixture', name: 'fixture' }] };
    else if (u === '/api/sessions') j = { ok: true, hasProject: true, sessions: sessions.map(s => ({ ...s, current: s.id === active })) };
    else if (u.startsWith('/api/sessions/search')) j = { ok: true, results: [{ ...sessions[0], matches: [{ userIndex: 0, role: 'user', text: 'historical warning', snippet: 'historical warning' }] }], scanned: {} };
    else if (u === '/api/sessions/switch') active = JSON.parse(opts.body).id;
    else if (u === '/api/providers') j = { ok: true, providers: {}, keyStates: {} };
    else if (u === '/api/provider-auth') j = auth;
    else if (u === '/api/command') {
      const c = JSON.parse(opts.body);
      let data = {};
      if (c.type === 'get_messages') data = { messages: history };
      if (c.type === 'get_state') data = { sessionId: active, model: { provider: 'current', id: 'fixture' } };
      if (c.type === 'get_available_models') data = { models: [] };
      if (c.type === 'get_tree') data = { entries: [] };
      setTimeout(() => sources.at(-1)?.emit({ type: 'response', command: c.type, id: c.id, success: true, data }), 0);
    }
    return { ok: true, json: async () => j };
  };
  w.eval(bundle(path.join(pub, 'app.js')).code);
  await wait(100);
  const toasts = () => [...w.document.querySelectorAll('#toasts .toast')];
  const clear = () => w.document.querySelector('#toasts').replaceChildren();
  const replayWarnings = () => {
    for (const e of [
      { type: 'extension_ui_request', method: 'notify', message: 'historical extension warning', notifyType: 'warning' },
      { type: 'extension_error', error: 'historical tool error' },
      { type: 'project_config_notice', message: 'historical config warning' },
      { type: 'response', command: 'fixture_error', success: false, error: 'historical RPC error' },
    ]) sources.at(-1).emit({ ...e, _replay: true });
  };
  await check('startup restore and SSE replay produce no historical toasts', () => { replayWarnings(); assert.equal(toasts().length, 0); });
  clear();
  await check('ten A/B switches have no success or history toasts', async () => {
    for (let i = 0; i < 20; i++) {
      const row = [...w.document.querySelectorAll('.pj-sess')].find(n => n.textContent.includes('Session ' + (i % 2 ? 'A' : 'B')));
      assert.ok(row); const button = row.querySelector('button.pj-sess-primary'); assert.ok(button); button.click(); await wait(280); replayWarnings();
    }
    assert.equal(toasts().length, 0);
    assert.equal(calls.filter(([u]) => u === '/api/sessions/switch').length, 20);
  });
  await check('session switches never register another SSE listener', () => { assert.equal(sources.length, 1); assert.equal(typeof sources[0].onmessage, 'function'); });
  await check('historical tool warning remains in chat', () => assert.ok(w.document.querySelector('#stream').textContent.includes('Memory search failed')));
  await check('replayed new/fork acknowledgements never restart session rebuild', async () => {
    const before = calls.filter(([u]) => u === '/api/command').length;
    for (const command of ['new_session', 'fork']) sources[0].emit({ type: 'response', command, success: true, _replay: true });
    await wait(300);
    assert.equal(calls.filter(([u]) => u === '/api/command').length, before);
    assert.equal(toasts().length, 0);
  });
  clear();
  await check('search result uses quiet history restore', async () => {
    const input = w.document.querySelector('.pj-search-input'); input.value = 'historical'; input.dispatchEvent(new w.Event('input'));
    await wait(300);
    const result = w.document.querySelector('.pj-sr-hit'); assert.ok(result); result.click();
    await wait(300); replayWarnings(); assert.equal(toasts().length, 0);
  });
  clear();
  await check('live warning still produces exactly one toast', () => { sources[0].emit({ type: 'extension_ui_request', method: 'notify', notifyType: 'warning', message: 'live unique warning' }); assert.equal(toasts().length, 1); });
  clear();
  await check('live extension error still produces exactly one toast', () => { sources[0].emit({ type: 'extension_error', error: 'live unique error' }); assert.equal(toasts().length, 1); });
  await check('custom provider management contains no Pi auth catalog', async () => { w.document.querySelector('#navProviders').click(); await wait(); assert.equal(w.document.querySelector('.provider-auth'), null); });
  await check('add provider opens existing creation form only', async () => {
    [...w.document.querySelectorAll('#modalCard button')].find(b => b.textContent === '添加供应商').click(); await wait();
    const card = w.document.querySelector('#modalCard');
    assert.ok(card.textContent.includes('供应商 ID') && card.textContent.includes('Base URL'));
    assert.equal(card.querySelector('.auth-provider'), null);
    assert.ok(!card.textContent.includes('Amazon Bedrock'));
    assert.ok(!card.textContent.includes('/login anthropic'));
  });
  await check('independent auth entry opens Pi authentication UI', async () => { w.document.querySelector('#navProviderAuth').click(); await wait(); assert.ok(w.document.querySelector('.provider-auth')); assert.equal(w.document.querySelector('.providers'), null); });
  await check('configured authenticated current and model providers precede others', () => {
    const rows = [...w.document.querySelectorAll('.auth-provider')].map(n => n.dataset.providerId);
    assert.equal(rows.slice(0, 4).join(','), 'configured,authenticated,current,models');
  });
  await check('other Pi providers are collapsed by default', () => { const details = w.document.querySelector('.auth-other'); assert.ok(details); assert.equal(details.open, false); assert.ok(details.querySelector('[data-provider-id="bedrock"]')); });
  await check('unknown stays unknown even with models', () => { for (const id of ['bedrock', 'current', 'models']) assert.equal(w.document.querySelector(`[data-provider-id="${id}"] .auth-status`).textContent, '未知（无法确认）'); });
  await check('auth refresh preserves expanded catalog', async () => { w.document.querySelector('.auth-other').open = true; auth.sync = { state: 'error' }; [...w.document.querySelectorAll('.provider-auth button')].find(b => b.textContent === '刷新认证状态').click(); await wait(); assert.equal(w.document.querySelector('.auth-other').open, true); });
  dom.window.close();
  console.log(`${passed}/${passed + failed} passed`); process.exitCode = failed ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
