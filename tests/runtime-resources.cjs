const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
(async () => {
  const dom = new JSDOM('<div id="list"></div><div id="central"></div><div id="toasts"></div><div id="modal" hidden><div id="modalCard"></div></div><div id="confirmLayer" hidden><div id="confirmCard"></div></div>', { url: 'http://127.0.0.1' });
  global.window = dom.window; global.document = dom.window.document;
  const { createResourceLauncher, resourceText, runtimeActionNotice } = await import('../public/runtime-resources.js');
  const { createRuntimeStore } = await import('../public/runtime-store.js');
  let checks = 0;
  const ok = (label, value) => { assert.ok(value, label); checks++; console.log('  ok  ' + label); };
  const snapshot = (totalCount, liveCount = totalCount) => ({ ok: true, backendInstance: 'b', items: [], totalCount, liveCount });
  for (const count of [0, 1, 2, 3, 4, 5, 100]) ok(`${count} authority projection without denominator`, resourceText(snapshot(count)) === `${count} 个会话正在运行`);
  ok('legacy limits are ignored in count text', resourceText({ ...snapshot(100), limit: 2, hardLimit: 3 }) === '100 个会话正在运行');
  ok('unknown count does not claim zero', resourceText({}) === '运行数量暂不可用');
  ok('invalid count does not claim a running total', resourceText({ totalCount: -1 }) === '运行数量暂不可用');
  ok('external classic count uses totalCount', resourceText(snapshot(2, 1)) === '2 个会话正在运行');
  const store = createRuntimeStore(); store.seed(snapshot(2, 1));
  store.seed({ backendInstance: 'b', items: [] });
  ok('partial state seed preserves resource metadata', store.resources().totalCount === 2);
  store.seed({ backendInstance: 'new', items: [] });
  ok('backend replacement clears stale resource metadata', store.resources() === null);
  let count = 2, confirms = 0, requests = [], reads = 0, failure = null, failRead = false;
  const order = [];
  const launch = createResourceLauncher({
    read: async () => { reads++; order.push('read'); if (failRead) throw Error('fixture_read_failed'); return snapshot(count); },
    seed: s => store.seed(s),
    confirm: async () => { confirms++; return false; },
    send: async p => { requests.push(p); order.push('send'); if (failure) return failure; count++; return { ok: true, conversationId: 'fixture' }; },
  });
  const start = { action: 'start', args: { id: 'ws', epoch: 'e' } };
  let result = await launch(start);
  ok('third start is sent once without confirmation or a preflight read', result.ok && count === 3 && requests.length === 1 && confirms === 0 && order.join(',') === 'send,read');
  ok('captured start payload is sent without mutation or admission fields', requests[0] === start && JSON.stringify(start) === '{"action":"start","args":{"id":"ws","epoch":"e"}}');
  result = await launch({ action: 'resume', conversationId: 'fourth' });
  ok('fourth resume succeeds once without confirmation', result.ok && count === 4 && requests.length === 2 && confirms === 0);
  result = await launch({ action: 'open-session', args: { project: '/fixture', requestId: 'fifth' } });
  ok('fifth ordinary session succeeds without extra admission fields', result.ok && count === 5 && requests.length === 3 && !('allowThird' in requests[2].args));
  count = 100; result = await launch({ action: 'resume', conversationId: 'later' });
  ok('subsequent sessions are not capped by count', result.ok && count === 101 && requests.length === 4 && confirms === 0);
  ok('no implicit kill stop close archive or restart', requests.every(p => ['start', 'resume', 'open-session'].includes(p.action)));
  const guardNotice = runtimeActionNotice({ code: 'tool_guard_unavailable' });
  ok('guard recovery notice preserves input and targets only the affected session', /输入已保留/.test(guardNotice) && /手动重启受影响会话/.test(guardNotice) && !/重启应用/.test(guardNotice));
  ok('busy notice still preserves the current draft', /草稿已保留/.test(runtimeActionNotice({ code: 'runtime_busy' })));
  ok('cleanup notice reports the actual pending cleanup without quota wording', runtimeActionNotice({ code: 'cleanup_pending' }) === '清理未完成。请等待清理完成后再试。');
  failure = { ok: false, code: 'spawn_failed', error: 'fixture launch failed' };
  const beforeFailure = requests.length; result = await launch(start);
  ok('actual backend error is returned unchanged exactly once', result === failure && requests.length === beforeFailure + 1 && confirms === 0);
  failure = { ok: false, code: 'runtime_limit', error: 'legacy backend rejection' };
  const beforeLegacy = requests.length; result = await launch(start);
  ok('legacy error is not confirmed retried or replaced with a quota message', result === failure && requests.length === beforeLegacy + 1 && runtimeActionNotice(result) === null);
  failRead = true; failure = null; result = await launch(start);
  ok('failed readback cannot hide an accepted launch or trigger a retry', result.ok && requests.length === beforeLegacy + 2);
  failure = { ok: false, code: 'workspace_in_use', error: 'fixture workspace conflict' }; result = await launch(start);
  ok('failed readback cannot hide the actual rejected launch', result === failure && requests.length === beforeLegacy + 3);
  ok('every completed launch has one outcome readback and no confirmation', reads === requests.length && confirms === 0);
  store.seed(snapshot(2)); store.seed({ backendInstance: 'b', items: [{ conversationId: 'pending', owner: null, lifecycle: 'error', error: 'cleanup_pending' }] });
  ok('cleanup pending cannot infer a lower count from an item', store.resources().totalCount === 2);
  store.seed(snapshot(1)); ok('only authoritative snapshot updates running count', store.resources().totalCount === 1);

  // Exercise the real view handlers; no count may open the confirmation layer.
  const state = await import('../public/runtime-state.js');
  const nav = await import('../public/runtime-nav.js');
  const { createRuntimeConversation } = await import('../public/runtime-conversation.js');
  const sessions = await import('../public/runtime-sessions.js');
  const owner = id => ({ backendInstance: 'ui', projectId: 'project', repoId: 'repo', workspaceId: 'ws-' + id, workspaceEpoch: 'e', conversationId: id, runtimeId: 'rt-' + id, runtimeGeneration: 'g', sessionId: 's-' + id });
  let revision = 1;
  const item = (id, live = false) => ({ conversationId: id, createdAt: '2026-01-01', revision, workspace: { branch: 'branch-' + id, projectId: 'project' }, owner: live ? owner(id) : null, lifecycle: live ? 'ready' : 'dormant', activity: 'idle', error: null });
  let items = [item('history')], total = 2, posts = [], gets = 0, historyReads = 0, launchError = null;
  const uiSnapshot = () => ({ ...snapshot(total, total - 1), backendInstance: 'ui', items: structuredClone(items) });
  global.fetch = async (url, options = {}) => ({ json: async () => {
    if (String(url).startsWith('/api/worktrees') && !options.body) return { ok: true, projectId: 'project', contextGeneration: 1 };
    if (String(url).includes('/api/runtime-sessions?')) { historyReads++; return { ok: true, messages: [{ role: 'user', text: 'safe historical fixture' }] }; }
    if (!options.body) { gets++; return uiSnapshot(); }
    const p = JSON.parse(options.body); posts.push(p);
    if (p.action === 'prepare') return { ok: true, nonce: 'fixture-nonce' };
    if (p.action === 'create') return { ok: true, workspace: { id: 'created', epoch: 'e', projectId: 'project' } };
    if (p.action === 'close') { total--; revision++; items = items.map(i => i.conversationId === p.owner.conversationId ? { ...i, owner: null, lifecycle: 'dormant', revision } : i); return { ok: true }; }
    if (['start', 'resume'].includes(p.action)) {
      if (launchError) return launchError;
      total++; revision++; const id = p.action === 'start' ? p.args.id : p.conversationId;
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
  ok('history works at any count without launch or quota wording', historyReads === 1 && !posts.some(p => ['start', 'resume'].includes(p.action)) && !centralHost.textContent.includes('名额'));
  const thirdResume = btn(centralHost, '恢复会话'); thirdResume.click(); thirdResume.click();
  await until(() => btn(centralHost, '关闭会话') && !btn(centralHost, '关闭会话').disabled);
  ok('central third resume sends once without confirmation and suppresses duplicate clicks', posts.filter(p => p.action === 'resume').length === 1 && layer.hidden);
  ok('central resume sends only its captured conversation', JSON.stringify(posts.find(p => p.action === 'resume')) === '{"action":"resume","conversationId":"history"}');
  ok('third indicator renders authoritative count', centralHost.querySelector('.runtime-resource-count').textContent === '3 个会话正在运行');
  btn(centralHost, '关闭会话').click(); await until(() => btn(centralHost, '恢复会话') && !btn(centralHost, '恢复会话').disabled);
  ok('close preserves dormant conversation and reads back actual count', state.runtimeStore.get('history').item.lifecycle === 'dormant' && state.runtimeStore.resources().totalCount === 2);
  total = 3; state.seedRuntimeSnapshot(uiSnapshot()); btn(centralHost, '恢复会话').click();
  await until(() => centralHost.querySelector('.runtime-resource-count').textContent === '4 个会话正在运行' && !btn(centralHost, '关闭会话').disabled);
  ok('central fourth succeeds once and retains live controls', posts.filter(p => p.action === 'resume').length === 2 && !btn(centralHost, '发送').disabled && layer.hidden);
  btn(centralHost, '关闭会话').click(); await until(() => btn(centralHost, '恢复会话') && !btn(centralHost, '恢复会话').disabled);
  launchError = { ok: false, error: 'fixture launch failed', code: 'spawn_failed' };
  btn(centralHost, '恢复会话').click(); await until(() => centralHost.querySelector('.rtc-notice').textContent.includes('fixture launch failed') && !btn(centralHost, '恢复会话').disabled);
  ok('central displays actual launch failure without retry or disabling history', posts.filter(p => p.action === 'resume').length === 3 && !btn(centralHost, '打开历史').disabled && layer.hidden);
  launchError = null;
  const list = document.querySelector('#list'); await nav.loadRuntimeNav({ path: '/fixture' }, { parent: list });
  total = 4; posts = []; list.querySelector('.pj-runtime-new').click();
  btn(document.querySelector('#modalCard'), '创建并启动').click();
  await until(() => posts.some(p => p.action === 'start'));
  await until(() => list.querySelector('.runtime-resource-count').textContent === '5 个会话正在运行');
  ok('sidebar subsequent create goes prepare create start once without confirmation', posts.filter(p => p.action !== 'focus').map(p => p.action).join(',') === 'prepare,create,start' && layer.hidden);
  ok('sidebar start has only the created workspace identity', JSON.stringify(posts.find(p => p.action === 'start').args) === '{"id":"created","epoch":"e"}');
  sessions.configureRuntimeSessions({ focusView: () => {} });
  posts = []; sessions.openRuntimeSessions({ path: '/fixture' }, { id: 'legacy', epoch: 'e', projectId: 'project' });
  const modal = document.querySelector('#modalCard'); await until(() => modal.querySelector('[data-conversation-id]'));
  btn(modal, '启动此工作区').click();
  await until(() => modal.querySelector('.runtime-resource-count').textContent === '6 个会话正在运行' && !btn(modal, '关闭会话').disabled);
  ok('legacy workspace starts subsequent session once without confirmation', posts.filter(p => p.action === 'start').length === 1 && layer.hidden);
  ok('legacy workspace start sends no admission fields', JSON.stringify(posts.find(p => p.action === 'start').args) === '{"id":"legacy","epoch":"e"}');
  posts = []; btn(modal, '关闭会话').click(); await until(() => btn(modal, '恢复会话'));
  ok('legacy close keeps the captured full owner', JSON.stringify(posts.find(p => p.action === 'close')?.owner) === JSON.stringify(owner('legacy')));
  btn(modal, '恢复会话').click(); await until(() => !btn(modal, '重启').disabled);
  ok('legacy resume is allowed at count five without confirmation', posts.filter(p => p.action === 'resume').length === 1 && !('allowThird' in posts.find(p => p.action === 'resume')) && layer.hidden);
  btn(modal, '重启').click(); await until(() => posts.some(p => p.action === 'restart') && !btn(modal, '重启').disabled);
  ok('legacy restart retains its captured owner and sends once', posts.filter(p => p.action === 'restart').length === 1 && JSON.stringify(posts.find(p => p.action === 'restart').owner) === JSON.stringify(owner('legacy')));
  revision++; items = items.map(i => i.conversationId === 'history' ? { ...i, revision, error: 'cleanup_pending' } : i);
  state.seedRuntimeSnapshot(uiSnapshot()); central.show('history');
  modal.querySelector('[data-conversation-id="history"]').click();
  ok('central and legacy cleanup states retain failure semantics without quota wording', centralHost.querySelector('.rtc-state').textContent === '清理未完成' && [...modal.querySelectorAll('.modal-desc')].some(n => n.textContent === '清理未完成') && !modal.textContent.includes('名额'));
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
  for (let n = 1; n <= 20; n++) state.observeRuntimeFrame({ type: 'runtime_state', owner: owner('created'), item: { ...item('created', true), revision: revision + n, lifecycle: n % 2 ? 'starting' : 'ready' } });
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
  global.fetch = async () => ({ json: async () => ({ ...uiSnapshot(), totalCount: 100, liveCount: 99 }) });
  state.seedRuntimeSnapshot(await fetchRuntimeSessions());
  finishOld({ ...uiSnapshot(), totalCount: 2, liveCount: 1 }); state.seedRuntimeSnapshot(await oldRead);
  ok('late older snapshot cannot roll resource count back', state.runtimeStore.resources().totalCount === 100);
  state.seedRuntimeSnapshot(null); state.seedRuntimeSnapshot({ ok: true });
  ok('malformed snapshot preserves confirmed running count', state.runtimeStore.resources().totalCount === 100);
  console.log(`\n${checks}/${checks} runtime-resources assertions passed`);
})().catch(e => { console.error(e); process.exitCode = 1; });
