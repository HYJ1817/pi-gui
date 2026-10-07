// E projection contracts; pixels and physical keys are checked by Electron.
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
(async () => {
  const dom = new JSDOM('<h1 id="title">经典标题</h1><div id="workspace" data-workspace-view="chat"><div id="host"></div></div><div id="modal" hidden><div id="modalCard"></div></div><div id="confirmLayer" hidden><div id="confirmCard"></div></div><div id="toasts"></div>', { url: 'http://127.0.0.1/' });
  global.window = dom.window; global.document = dom.window.document; global.localStorage = dom.window.localStorage;
  const { runtimeStore, seedRuntimeSnapshot, observeRuntimeFrame } = await import('../public/runtime-state.js');
  const { createRuntimeConversation } = await import('../public/runtime-conversation.js');
  const { setTitleText, setRuntimeTitle } = await import('../public/shell.js');
  let checks = 0;
  const ok = (name, value) => { assert.ok(value, name); checks++; console.log('  ok ' + name); };
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  const owner = id => ({ backendInstance: 'backend', projectId: 'project', repoId: 'repo', workspaceId: 'ws-' + id, workspaceEpoch: 'epoch', conversationId: id, runtimeId: 'rt-' + id, runtimeGeneration: 'gen', sessionId: 'native-' + id });
  const item = id => ({ conversationId: id, nativeSessionId: 'native-' + id, sessionName: id === 'A' ? '原生标题 A' : null, workspace: { projectId: 'project', workspaceId: 'ws-' + id, workspaceEpoch: 'epoch', branch: 'branch-' + id }, owner: owner(id), lifecycle: 'ready', activity: 'idle', revision: 1 });
  seedRuntimeSnapshot({ backendInstance: 'backend', items: ['A', 'B'].map(item) });
  const catalogue = [{ providerId: 'fixture', modelId: 'reasoning', name: 'Reasoning' }, { providerId: 'fixture', modelId: 'plain', name: 'Plain' }];
  const values = new Map([
    ['A', { model: catalogue[0], models: catalogue, reasoning: true, thinkingLevel: 'low', levels: ['off', 'low', 'high'], pending: false, notice: '' }],
    ['B', { model: catalogue[1], models: catalogue, reasoning: false, thinkingLevel: 'off', levels: null, pending: false, notice: '' }],
  ]);
  const modelCalls = [], requests = [];
  const models = { get: id => values.get(id), refresh: async id => { modelCalls.push({ refresh: id }); return true; },
    setModel: async (id, selected) => { modelCalls.push({ id, selected }); values.get(id).pending = true; return true; },
    setThinking: async (id, level) => { modelCalls.push({ id, level }); values.get(id).pending = true; return true; } };
  let resolveHistory;
  global.fetch = async (url, opts = {}) => ({ json: async () => {
    if (opts.body) { requests.push(JSON.parse(opts.body)); return { ok: true }; }
    if (String(url).includes('conversationId=')) return new Promise(resolve => { resolveHistory = resolve; });
    return { ok: true, backendInstance: 'backend', items: [] };
  } });
  const host = document.querySelector('#host'), view = createRuntimeConversation({ host, models, onTitle: setRuntimeTitle });
  const select = () => host.querySelector('[aria-label="当前会话模型"]');
  const thinking = () => host.querySelector('[aria-label="当前会话推理强度"]');
  const input = () => host.querySelector('textarea');
  const button = name => [...host.querySelectorAll('button')].find(node => node.textContent === name);
  view.show('A');
  document.querySelector('#workspace').dataset.workspaceView = 'runtime';
  document.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-view', { detail: { view: 'runtime' } }));
  ok('native session title precedes branch', host.querySelector('.rtc-title').textContent === '原生标题 A');
  ok('shell heading matches focused native conversation', document.querySelector('#title').textContent === '原生标题 A');
  setTitleText('经典后台标题');
  ok('classic background title cannot overwrite runtime heading', document.querySelector('#title').textContent === '原生标题 A');
  ok('A displays its own selected model', JSON.parse(select().value).modelId === 'reasoning');
  ok('reasoning uses only provided native levels', [...thinking().options].slice(1).map(o => o.value).join(',') === 'off,low,high');
  ok('A thinking readback selected', thinking().value === 'low' && !thinking().disabled);
  select().value = JSON.stringify({ providerId: 'fixture', modelId: 'plain' }); select().dispatchEvent(new dom.window.Event('change')); view.draw();
  ok('selection dispatch captures A identity', modelCalls.some(call => call.id === 'A' && call.selected.modelId === 'plain'));
  ok('pending setter retains old confirmed selection', JSON.parse(select().value).modelId === 'reasoning' && select().disabled);
  view.show('B');
  ok('A pending never disables B model', !select().disabled && JSON.parse(select().value).modelId === 'plain');
  ok('explicit unsupported reasoning disabled', thinking().disabled && host.querySelector('.rtc-model-notice').textContent.includes('不支持'));
  values.get('B').reasoning = null; view.draw();
  ok('unknown reasoning is not guessed', thinking().disabled && thinking().options.length === 1 && host.querySelector('.rtc-model-notice').textContent.includes('未知'));
  values.get('A').pending = false; values.get('A').model = catalogue[1];
  view.draw(); ok('A confirmation cannot change visible B selector', JSON.parse(select().value).modelId === 'plain');
  view.show('A'); ok('return A shows readback model', JSON.parse(select().value).modelId === 'plain');
  const reads = modelCalls.filter(call => call.refresh).length;
  for (let n = 1; n <= 30; n++) observeRuntimeFrame({ type: 'runtime_event', owner: owner('A'), eventSequence: n, event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '.' } } });
  ok('activity does not repeatedly fetch models', modelCalls.filter(call => call.refresh).length === reads);
  input().value = 'keyboard prompt'; input().dispatchEvent(new dom.window.Event('input'));
  input().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true })); await tick();
  ok('Shift Enter does not submit', !requests.length);
  input().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, cancelable: true })); await tick();
  ok('IME Enter does not submit', !requests.length);
  input().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true })); await tick();
  ok('Enter submits captured A owner', requests.length === 1 && requests[0].command.message === 'keyboard prompt' && requests[0].owner.conversationId === 'A');
  const locator = id => ({ projectId: 'project', workspaceId: 'ws-' + id, workspaceEpoch: 'epoch', conversationId: id, nativeSessionId: 'native-' + id });
  const history = view.openHistory(locator('A'), { userIndex: 1 }); await tick();
  resolveHistory({ ok: true, locator: locator('A'), messages: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'reply' }, { role: 'user', text: 'matched second' }], truncated: false }); await history;
  ok('search opens matching explicit native history', host.querySelector('.rtc-output').textContent.includes('matched second'));
  ok('history match identifies target user turn', host.querySelector('[data-history-user-index="1"]').textContent.includes('matched second'));
  ok('live readonly history adds no launch request', requests.length === 1 && host.querySelector('.rtc-state').textContent.includes('不增加运行名额'));
  ok('readonly history disables model mutation and prompt', select().disabled && input().disabled);
  ok('live readonly offers return without resume', !button('返回实时会话').hidden && button('恢复会话').disabled);
  button('返回实时会话').click(); ok('return live preserves runtime output', !input().disabled && host.querySelector('.rtc-output').textContent.includes('...'));
  const late = view.openHistory(locator('A')); await tick(); view.show('B');
  resolveHistory({ ok: true, locator: locator('A'), messages: [{ role: 'user', text: 'late-history-A' }] });
  ok('late A search navigation does not show A in B', await late === false && !host.textContent.includes('late-history-A'));
  const invalid = await view.openHistory({ ...locator('B'), workspaceEpoch: 'wrong' });
  ok('wrong workspace identity rejected before fetch', invalid === false);
  const replaced = view.openHistory(locator('B')); await tick();
  seedRuntimeSnapshot({ backendInstance: 'backend', items: [{ ...item('B'), nativeSessionId: 'changed', revision: 2 }] });
  resolveHistory({ ok: true, locator: locator('B'), messages: [{ role: 'user', text: 'wrong-native-body' }] });
  ok('native identity changed during read rejects body', await replaced === false && !host.textContent.includes('wrong-native-body') && host.querySelector('.rtc-notice').textContent.includes('身份'));
  view.leave(); document.querySelector('#workspace').dataset.workspaceView = 'chat';
  document.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-view', { detail: { view: 'chat' } }));
  ok('return classic restores its own latest title', document.querySelector('#title').textContent === '经典后台标题');
  view.dispose(); dom.window.close();
  console.log(`Runtime finishing UI: ${checks}/${checks}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
