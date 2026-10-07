const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
(async () => {
  const dom = new JSDOM('<div id="list"></div><div id="central"></div><div id="toasts"></div><div id="modal" hidden><div id="modalCard"></div></div><div id="confirmLayer" hidden><div id="confirmCard"></div></div>', { url: 'http://127.0.0.1' });
  global.window = dom.window; global.document = dom.window.document;
  const { createResourceLauncher, resourceText, runtimeLimitNotice } = await import('../public/runtime-resources.js');
  const { createRuntimeStore } = await import('../public/runtime-store.js');
  let checks = 0;
  const ok = (label, value) => { assert.ok(value, label); checks++; console.log('  ok  ' + label); };
  const snapshot = (totalCount, liveCount = totalCount) => ({ ok: true, backendInstance: 'b', items: [], totalCount, liveCount, limit: 2, hardLimit: 3 });
  for (const count of [0, 1, 2]) ok(`${count}/2 authority projection`, resourceText(snapshot(count)) === `正在运行 ${count} / 2`);
  ok('third count does not render 3/2', resourceText(snapshot(3)) === '3 个会话正在运行');
  ok('unknown count does not claim zero', resourceText({}) === '运行名额暂不可用');
  ok('external classic count uses totalCount', resourceText(snapshot(2, 1)) === '正在运行 2 / 2');
  const store = createRuntimeStore(); store.seed(snapshot(2, 1));
  store.seed({ backendInstance: 'b', items: [] });
  ok('partial state seed preserves resource metadata', store.resources().totalCount === 2);
  store.seed({ backendInstance: 'new', items: [] });
  ok('backend replacement clears stale resource metadata', store.resources() === null);
  let count = 2, confirms = 0, accept = false, requests = [], reads = 0, race = false;
  const launch = createResourceLauncher({
    read: async () => { reads++; return snapshot(count); },
    seed: s => store.seed(s),
    confirm: async options => { confirms++; ok('confirmation names CPU memory and model requests', /CPU/.test(options.message) && /内存/.test(options.message) && /模型请求/.test(options.message)); return accept; },
    send: async p => { requests.push(p); if (race) { race = false; count = 2; return { ok: false, code: 'runtime_limit' }; } if (count === 3) return { ok: false, code: 'runtime_limit' }; count++; return { ok: true, conversationId: 'fixture' }; },
  });
  const start = { action: 'start', args: { id: 'ws', epoch: 'e' } };
  let result = await launch(start);
  ok('cancel third sends no start', result.cancelled && requests.length === 0 && confirms === 1);
  accept = true; result = await launch(start);
  ok('confirmed third succeeds', result.ok && count === 3);
  ok('start allowThird is nested', requests[0].args.allowThird === true && requests[0].allowThird === undefined);
  ok('original captured payload is not mutated', start.args.allowThird === undefined);
  const oldConfirms = confirms; result = await launch({ action: 'resume', conversationId: 'fourth' });
  ok('fourth genuinely reaches backend', result.code === 'runtime_limit' && requests.at(-1).conversationId === 'fourth');
  ok('hard cap does not show third confirmation', confirms === oldConfirms);
  ok('no implicit kill stop close or archive', requests.every(p => ['start', 'resume'].includes(p.action)));
  ok('limit notice gives all alternatives', /打开历史/.test(runtimeLimitNotice(result)) && /关闭/.test(runtimeLimitNotice(result)) && /稍后恢复/.test(runtimeLimitNotice(result)));
  count = 2; requests = []; await launch({ action: 'resume', conversationId: 'dormant' });
  ok('resume allowThird is top level', requests[0].allowThird === true && requests[0].args === undefined);
  count = 1; race = true; requests = []; const before = confirms; await launch(start);
  ok('race refresh allows one confirmed retry', requests.length === 2 && !requests[0].args.allowThird && requests[1].args.allowThird && confirms === before + 1);
  count = 1; race = true; accept = false; requests = []; await launch(start);
  ok('race cancel does not retry', requests.length === 1);
  ok('each launch reads authoritative preflight and refreshes outcome', reads === 12);
  store.seed(snapshot(2)); store.seed({ backendInstance: 'b', items: [{ conversationId: 'pending', owner: {}, lifecycle: 'error', error: 'cleanup_pending' }] });
  ok('cleanup pending cannot infer freed slot from item', store.resources().totalCount === 2);
  store.seed(snapshot(1)); ok('only confirmed snapshot releases slot', store.resources().totalCount === 1);

  // Exercise real view handlers and the real confirmModal, not an alternate UI.
  const state = await import('../public/runtime-state.js');
  const nav = await import('../public/runtime-nav.js');
  const { createRuntimeConversation } = await import('../public/runtime-conversation.js');
  const sessions = await import('../public/runtime-sessions.js');
  const owner = id => ({ backendInstance: 'ui', projectId: 'project', repoId: 'repo', workspaceId: 'ws-' + id, workspaceEpoch: 'e', conversationId: id, runtimeId: 'rt-' + id, runtimeGeneration: 'g', sessionId: 's-' + id });
  const item = (id, live = false) => ({ conversationId: id, createdAt: '2026-01-01', revision: 1, workspace: { branch: 'branch-' + id, projectId: 'project' }, owner: live ? owner(id) : null, lifecycle: live ? 'ready' : 'dormant', activity: 'idle', error: null });
  let items = [item('history')], total = 2, posts = [], gets = 0, historyReads = 0;
  const uiSnapshot = () => ({ ...snapshot(total, total - 1), backendInstance: 'ui', items: structuredClone(items) });
  global.fetch = async (url, options = {}) => ({ json: async () => {
    if (String(url).startsWith('/api/worktrees') && !options.body) return { ok: true, projectId: 'project', contextGeneration: 1 };
    if (String(url).includes('/api/runtime-sessions?')) { historyReads++; return { ok: true, messages: [{ role: 'user', text: 'safe historical fixture' }] }; }
    if (!options.body) { gets++; return uiSnapshot(); }
    const p = JSON.parse(options.body); posts.push(p);
    if (p.action === 'prepare') return { ok: true, nonce: 'fixture-nonce' };
    if (p.action === 'create') return { ok: true, workspace: { id: 'created', epoch: 'e', projectId: 'project' } };
    if (p.action === 'close') { total--; items = items.map(i => i.conversationId === p.owner.conversationId ? { ...i, owner: null, lifecycle: 'dormant', revision: i.revision + 1 } : i); return { ok: true }; }
    if (['start', 'resume'].includes(p.action)) {
      if (total >= 3) return { ok: false, code: 'runtime_limit' };
      total++; const id = p.action === 'start' ? 'created' : p.conversationId;
      items = [...items.filter(i => i.conversationId !== id), item(id, true)]; return { ok: true, conversationId: id };
    }
    return { ok: true };
  } });
  const until = async test => { for (let n = 0; n < 100; n++) { if (test()) return; await new Promise(r => setImmediate(r)); } throw Error('resource_ui_timeout'); };
  const btn = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent === text);
  const centralHost = document.querySelector('#central'), layer = document.querySelector('#confirmLayer');
  const central = createRuntimeConversation({ host: centralHost });
  state.seedRuntimeSnapshot(uiSnapshot()); central.show('history');
  ok('dormant on restart never auto-spawns', posts.length === 0);
  btn(centralHost, '打开历史').click(); await until(() => centralHost.textContent.includes('safe historical fixture'));
  ok('full capacity history works without launch', historyReads === 1 && !posts.some(p => ['start', 'resume'].includes(p.action)));
  btn(centralHost, '恢复会话').click(); await until(() => !layer.hidden);
  ok('central resume confirms before request', !posts.some(p => p.action === 'resume'));
  ok('confirmation defaults focus to Cancel', document.activeElement.textContent === '取消');
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => !btn(centralHost, '恢复会话').disabled);
  ok('Escape cancel sends no resume and preserves historical output', posts.length === 0 && centralHost.textContent.includes('safe historical fixture'));
  btn(centralHost, '恢复会话').click(); await until(() => !layer.hidden); btn(layer, '继续启动').click();
  await until(() => !btn(centralHost, '关闭会话').disabled);
  ok('central confirmed resume passes top-level allowThird', posts.find(p => p.action === 'resume')?.allowThird === true);
  ok('third indicator renders authoritative count', centralHost.querySelector('.runtime-resource-count').textContent === '3 个会话正在运行');
  btn(centralHost, '关闭会话').click(); await until(() => !btn(centralHost, '恢复会话').disabled);
  ok('close preserves dormant conversation and snapshot reclaims slot', state.runtimeStore.get('history').item.lifecycle === 'dormant' && state.runtimeStore.resources().totalCount === 2);
  total = 3; state.seedRuntimeSnapshot(uiSnapshot()); btn(centralHost, '恢复会话').click(); await until(() => centralHost.querySelector('.rtc-notice').textContent.includes('运行名额已满'));
  ok('central fourth reaches backend and leaves history enabled', posts.filter(p => p.action === 'resume').length === 2 && !btn(centralHost, '打开历史').disabled);
  const list = document.querySelector('#list'); await nav.loadRuntimeNav({ path: '/fixture' }, { parent: list });
  total = 2; posts = []; list.querySelector('.pj-runtime-new').click();
  btn(document.querySelector('#modalCard'), '创建并启动').click(); await until(() => !layer.hidden);
  ok('sidebar create performs admission before third start', posts.map(p => p.action).join(',') === 'prepare,create');
  btn(layer, '取消').click(); await until(() => layer.hidden); await new Promise(r => setImmediate(r));
  ok('sidebar third cancel never starts created workspace', !posts.some(p => p.action === 'start'));
  sessions.configureRuntimeSessions({ focusView: () => {} });
  posts = []; sessions.openRuntimeSessions({ path: '/fixture' }, { id: 'ws', epoch: 'e', projectId: 'project' });
  const modal = document.querySelector('#modalCard'); await until(() => modal.querySelector('[data-conversation-id]'));
  btn(modal, '启动此工作区').click(); await until(() => !layer.hidden);
  ok('legacy workspace launch confirms before start', posts.length === 0);
  btn(layer, '继续启动').click(); await until(() => posts.some(p => p.action === 'start'));
  ok('legacy workspace launch nests allowThird in args', posts.find(p => p.action === 'start').args.allowThird === true);
  await until(() => modal.querySelector('.runtime-resource-count').textContent === '3 个会话正在运行');
  btn(modal, '关闭').click(); central.dispose();

  // Text deltas never ask for snapshots. Lifecycle transitions use one in-flight
  // read plus a trailing read when newer lifecycle events arrive during it.
  let releaseRead, held = false; const baseFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url) === '/api/runtime-sessions' && !options.body && held) { gets++; return { json: () => new Promise(resolve => { releaseRead = () => { held = false; resolve(uiSnapshot()); }; }) }; }
    return baseFetch(url, options);
  };
  state.seedRuntimeSnapshot(uiSnapshot()); const beforeGets = gets;
  for (let n = 1; n <= 100; n++) state.observeRuntimeFrame({ type: 'runtime_event', owner: owner('created'), eventSequence: n, event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } } });
  ok('100 deltas trigger zero resource reads', gets === beforeGets);
  held = true;
  for (let n = 1; n <= 20; n++) state.observeRuntimeFrame({ type: 'runtime_state', owner: owner('created'), item: { ...item('created', true), revision: n + 5, lifecycle: n % 2 ? 'starting' : 'ready' } });
  await until(() => releaseRead);
  ok('20 lifecycle changes share one in-flight snapshot', gets === beforeGets + 1);
  releaseRead(); await until(() => gets === beforeGets + 2);
  ok('one trailing refresh reconciles latest lifecycle', gets === beforeGets + 2);
  await new Promise(r => setImmediate(r));
  // Cross-view snapshot requests have no backend revision for resource counts.
  // A delayed earlier response must never roll back the newer readback.
  const { fetchRuntimeSessions } = await import('../public/api.js');
  let finishOld;
  global.fetch = async () => ({ json: () => new Promise(resolve => { finishOld = resolve; }) });
  const oldRead = fetchRuntimeSessions(); await until(() => finishOld);
  global.fetch = async () => ({ json: async () => ({ ...uiSnapshot(), totalCount: 3, liveCount: 2 }) });
  state.seedRuntimeSnapshot(await fetchRuntimeSessions());
  finishOld({ ...uiSnapshot(), totalCount: 2, liveCount: 1 }); state.seedRuntimeSnapshot(await oldRead);
  ok('late older snapshot cannot roll resource count back', state.runtimeStore.resources().totalCount === 3);
  state.seedRuntimeSnapshot(null); state.seedRuntimeSnapshot({ ok: true });
  ok('malformed snapshot preserves confirmed occupancy', state.runtimeStore.resources().totalCount === 3);
  console.log(`\n${checks}/${checks} runtime-resources assertions passed`);
})().catch(e => { console.error(e); process.exitCode = 1; });
