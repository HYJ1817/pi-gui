'use strict';

/* P4 前端验收：纯状态/可见性 + jsdom 中的真实模块交互。
 * 真实布局由 Electron 截图验收；这里盯住状态与数据合同。 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');

const root = path.resolve(__dirname, '..');
const pub = path.join(root, 'public');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/provider-management-scenarios.json'), 'utf8'));
const appBundle = bundle(path.join(pub, 'providers.js'));
const clone = value => JSON.parse(JSON.stringify(value));

function boot({ fetchImpl, snapshot: snapshotOverride = null } = {}) {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:7788/' });
  const { window } = dom;
  const snapshot = clone(snapshotOverride || fixture.live.snapshot);
  const calls = { drafts: [], commits: [], discovery: [], authorize: [], test: [], legacy: [], auth: [] };
  const api = {
    fetchProviderManagement: async () => snapshot,
    saveProviderDraft: async request => {
      calls.drafts.push(clone(request));
      return { ok: true, draftId: 'fixture-draft', draftRevision: 2, revision: snapshot.revision };
    },
    commitProviderDraft: async request => {
      calls.commits.push(clone(request));
      return { ok: true, serviceId: request.serviceId || 'new-service', saved: true, credentialSaved: null, credentialState: 'saved', sync: { state: 'pending', reason: 'runtime_sync_pending' }, revision: 'config-rev-next' };
    },
    authorizeProviderDiscovery: async request => { calls.authorize.push(clone(request)); return { ok: false, code: 'unsupported' }; },
    revokeProviderDiscovery: async () => ({ ok: false, code: 'unsupported' }),
    discoverProviderModels: async request => { calls.discovery.push(clone(request)); return { ok: false, code: 'unsupported' }; },
    testProviderConnection: async request => { calls.test.push(clone(request)); return { ok: false, code: 'unsupported' }; },
  };
  window.fetch = async (url, options) => {
    const target = String(url);
    if (target.includes('/api/provider-management')) {
      const body = options?.body ? JSON.parse(options.body) : null;
      if (target.endsWith('/drafts')) {
        calls.drafts.push(clone(body));
        return { status: 200, json: async () => ({ ok: true, draftId: 'fixture-draft', draftRevision: 2, revision: snapshot.revision }) };
      }
      if (target.endsWith('/commit')) {
        calls.commits.push(clone(body));
        return { status: 200, json: async () => ({ ok: true, serviceId: body?.serviceId || 'new-service', saved: true, credentialSaved: null, credentialState: 'saved', sync: { state: 'pending' }, revision: 'config-rev-next' }) };
      }
      return { status: 200, json: async () => snapshot };
    }
    if (target.includes('/api/providers')) {
      calls.legacy.push(target);
      return { status: 200, json: async () => ({ ok: true, path: 'C:\\fixture\\models.json', providers: { example: { models: [{ id: 'fast' }] } }, keyStates: { 'example-ai': { ok: false, note: '环境变量 EXAMPLE_KEY 没有设置' } } }) };
    }
    if (target.includes('/api/provider-auth')) {
      calls.auth.push(target);
      return { status: 200, json: async () => ({ ok: true, capability: { sdkAvailable: true }, providers: [], flow: null, sync: { state: 'idle' } }) };
    }
    return { status: 200, json: async () => (fetchImpl ? fetchImpl(target, options) : { ok: true }) };
  };
  window.eval(appBundle.code);
  return { dom, window, snapshot, api, calls };
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function openCreate(window, snapshot, api, mode = 'create', target = null) {
  const saved = [];
  window.openProviderDialog({
    snapshot,
    api,
    mode,
    service: mode === 'edit' || mode === 'clone' ? target : null,
    item: mode === 'create' ? target : null,
    onSaved: result => saved.push(result),
  });
  return { card: window.document.getElementById('modalCard'), saved };
}

function pick(window, card, id) {
  const tile = [...card.querySelectorAll('.pm-service-tile')].find(node => node.dataset.serviceId === id);
  assert.ok(tile, `missing service tile ${id}`);
  tile.click();
}

function addCustom(card, id) {
  const input = card.querySelector('[data-custom-model-input]');
  assert.ok(input, 'custom model input must exist');
  input.value = id;
  input.dispatchEvent(new card.ownerDocument.defaultView.Event('input', { bubbles: true }));
  card.querySelector('[data-add-custom-model]').click();
}

/* ---------- 纯模块 ---------- */

test('catalog groups subscription first and keeps custom first in API-key group', async () => {
  const { normalizeCatalog, groupCatalog, filterCatalog } = await import('../public/provider-management/catalog.js');
  const items = normalizeCatalog(fixture.live.snapshot);
  const groups = groupCatalog(items);
  assert.equal(groups.subscription[0].id, 'openai-subscription');
  assert.equal(groups.apiKey[0].id, 'custom');
  assert.equal(filterCatalog(items, 'claude').some(item => item.id === 'anthropic'), true);
  assert.equal(filterCatalog(items, 'api.deepseek.com').some(item => item.id === 'deepseek'), true);
  assert.equal(filterCatalog(items, '豆包').length, 0);
});

test('draft keeps service order and patches only explicit model edits', async () => {
  const s = await import('../public/provider-management/state.js');
  const snapshot = clone(fixture.live.snapshot);
  const draft = s.draftFromService(snapshot.services[0], snapshot);
  assert.deepEqual(draft.order, ['vision', 'fast']);
  assert.equal(draft.dirty, false);
  assert.deepEqual(s.toDraftPayload(draft).modelPatches, []);
  const edited = s.reduceDraft(draft, { type: 'model-field', modelId: 'fast', field: 'reasoning', value: true });
  assert.deepEqual(s.modelPatchFor(edited, edited.models.find(model => model.modelId === 'fast')), {
    modelId: 'fast', operation: 'upsert', set: { reasoning: true },
  });
  const cleared = s.reduceDraft(edited, { type: 'model-field', modelId: 'fast', field: 'reasoning', value: null });
  assert.deepEqual(s.modelPatchFor(cleared, cleared.models.find(model => model.modelId === 'fast')), {
    modelId: 'fast', operation: 'upsert', unsetFields: ['reasoning'],
  });
});

test('selection search is visibility only and select-all applies to visible rows', async () => {
  const mv = await import('../public/provider-management/model-visibility.js');
  const models = [
    { modelId: 'a', name: 'Alpha' },
    { modelId: 'b', name: 'Beta' },
    { modelId: 'c', name: 'Gamma' },
  ];
  const order = ['c', 'a', 'b'];
  const filtered = mv.projectModelVisibility({ models, order, candidateQuery: 'beta', chosenQuery: 'zzz' });
  assert.deepEqual(filtered.candidates.map(model => model.modelId), ['b']);
  assert.deepEqual(filtered.chosen, []);
  assert.deepEqual(order, ['c', 'a', 'b']);
  assert.deepEqual(mv.setVisibleSelection(order, ['b'], false, models.map(model => model.modelId)), ['c', 'a']);
  assert.deepEqual(mv.setVisibleSelection(['c', 'a'], ['b'], true, models.map(model => model.modelId)), ['c', 'a', 'b']);
  assert.deepEqual(mv.moveByOffset(order, 'a', -1), ['a', 'c', 'b']);
  assert.deepEqual(mv.moveByOffset(order, 'a', 1), ['c', 'b', 'a']);
});

test('mergeFetchedModels never drops selected models or overwrites edited values', async () => {
  const s = await import('../public/provider-management/state.js');
  const snapshot = clone(fixture.live.snapshot);
  const draft = s.draftFromService(snapshot.services[0], snapshot);
  const edited = s.reduceDraft(draft, { type: 'model-field', modelId: 'fast', field: 'name', value: 'My Fast' });
  const merged = s.reduceDraft(edited, { type: 'merge-models', models: [{ modelId: 'new-model', name: 'New' }] });
  assert.deepEqual(merged.order, ['vision', 'fast']);
  assert.equal(merged.models.find(model => model.modelId === 'fast').name, 'My Fast');
  assert.ok(merged.models.some(model => model.modelId === 'new-model'));
  assert.equal(merged.order.includes('new-model'), false);
});

test('inherited selection expands for display and pins only on save', async () => {
  const s = await import('../public/provider-management/state.js');
  const snapshot = clone(fixture.live.snapshot);
  const service = clone(snapshot.services[0]);
  service.selectedModelIds = null;
  service.modelOrder = null;
  const draft = s.draftFromService(service, snapshot);
  assert.deepEqual(draft.order, ['fast', 'vision']);
  assert.equal(draft.inheritedSelection, true);
  assert.equal(draft.dirty, false);
  assert.deepEqual(s.toDraftPayload(draft).selectedModelIds, ['fast', 'vision']);
});

test('clone strips credentials and always uses a new provider id', async () => {
  const s = await import('../public/provider-management/state.js');
  const snapshot = clone(fixture.live.snapshot);
  const draft = s.draftFromClone(snapshot.services[0], snapshot, 'example-copy');
  assert.equal(draft.mode, 'clone');
  assert.equal(draft.authMode, 'none');
  assert.equal(draft.credentialAction.type, 'keep');
  assert.equal(draft.envReference, '');
  assert.deepEqual(draft.credentialState, { state: 'none', source: 'none' });
  assert.equal(s.toDraftPayload(draft).providerId, 'example-copy');
  draft.piRegistrationReference = '$LOCAL_TOKEN';
  const payload = s.toDraftPayload(draft);
  assert.equal(payload.piRegistrationReference, undefined);
  assert.equal(payload.authMode, 'none');
  assert.deepEqual(s.commitCredentialAction(draft), { type: 'keep' });
  assert.ok(s.validateDraft(draft).errors.piRegistrationReference);
});

test('inherited selection uses modelOrder as ordering hint, not as the selected set', async () => {
  const s = await import('../public/provider-management/state.js');
  const snapshot = clone(fixture.live.snapshot);
  const service = clone(snapshot.services[0]);
  service.selectedModelIds = null;
  service.modelOrder = ['fast'];
  const draft = s.draftFromService(service, snapshot);
  assert.deepEqual(draft.order, ['fast', 'vision']);
});

test('removing then re-adding a model clears the remove patch', async () => {
  const s = await import('../public/provider-management/state.js');
  const snapshot = clone(fixture.live.snapshot);
  let draft = s.draftFromService(snapshot.services[0], snapshot);
  draft = s.removeModel(draft, 'fast');
  assert.ok(s.toDraftPayload(draft).modelPatches.some(patch => patch.modelId === 'fast' && patch.operation === 'remove'));
  draft = s.addModel(draft, 'fast');
  const payload = s.toDraftPayload(draft);
  assert.equal(payload.modelPatches.some(patch => patch.modelId === 'fast' && patch.operation === 'remove'), false);
  assert.ok(payload.selectedModelIds.includes('fast'));
});

/* ---------- jsdom：服务选择器 ---------- */

test('chooser filters, keeps subscription disabled, and opens setup without secret inputs', async () => {
  const { window, snapshot, api } = boot();
  const { card } = openCreate(window, snapshot, api);
  assert.equal(card.querySelector('.pm-dialog-title').textContent, '添加 AI 服务');
  const groups = [...card.querySelectorAll('.pm-chooser-group')];
  assert.equal(groups[0].querySelector('.pm-chooser-group-title').textContent, '订阅账户');
  assert.equal(groups[1].querySelector('.pm-service-tile').dataset.serviceId, 'custom');
  assert.equal(card.querySelectorAll('.pm-service-tile').length, 13);

  const search = card.querySelector('.pm-chooser-search');
  search.value = 'deepseek';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual([...card.querySelectorAll('.pm-service-tile')].map(node => node.dataset.serviceId), ['deepseek']);

  search.value = 'claude';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual([...card.querySelectorAll('.pm-service-tile')].map(node => node.dataset.serviceId), ['anthropic-subscription', 'anthropic']);
  const disabled = [...card.querySelectorAll('.pm-service-tile')].find(node => node.dataset.serviceId === 'anthropic-subscription');
  assert.ok(disabled);
  assert.equal(disabled.getAttribute('aria-disabled'), 'true');

  search.value = '';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  pick(window, card, 'deepseek');
  assert.equal(card.querySelector('.pm-dialog-title').textContent, '添加 AI 服务');
  assert.ok(card.querySelector('.pm-dialog-subtitle').textContent.includes('DeepSeek'));
  assert.ok(card.querySelector('.pm-service-chip-detail').textContent.includes('api.deepseek.com'));
  assert.equal(card.querySelector('[data-connection-base-url]'), null, 'known service endpoint lives in the catalog card, not a duplicate field');
  assert.equal(card.querySelector('.pm-env-input').value, '$DEEPSEEK_API_KEY');
  assert.equal(card.querySelectorAll('input[type=password]').length, 0);
  assert.equal(card.querySelector('[data-credential-trigger]').disabled, true);
  assert.ok(card.querySelector('[data-model-pane=candidates]'));
  assert.ok(card.querySelector('[data-model-pane=chosen]'));
  assert.equal(card.querySelector('[data-discovery-status]').dataset.discoveryStatus, 'unsupported');
  assert.equal(card.querySelector('[data-refresh-models]').disabled, true);
});

test('chooser keyboard navigation and IME composition do not fire fake picks', async () => {
  const { window, snapshot, api } = boot();
  const { card } = openCreate(window, snapshot, api);
  const search = card.querySelector('.pm-chooser-search');
  const composition = new window.Event('input', { bubbles: true });
  Object.defineProperty(composition, 'isComposing', { value: true });
  search.value = 'deep';
  search.dispatchEvent(composition);
  assert.equal(card.querySelectorAll('.pm-service-tile').length, 13, 'composition input must not filter');
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(card.querySelectorAll('.pm-service-tile').length, 1);
  search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(card.querySelector('.pm-dialog-title').textContent, '添加 AI 服务');
  assert.equal(card.querySelectorAll('input[type=password]').length, 0);
});

test('unsupported subscription card never starts login', async () => {
  const { window, snapshot, api, calls } = boot();
  const { card } = openCreate(window, snapshot, api);
  const sub = [...card.querySelectorAll('.pm-service-tile')].find(node => node.dataset.serviceId === 'anthropic-subscription');
  assert.ok(sub);
  assert.equal(sub.getAttribute('aria-disabled'), 'true');
  sub.click();
  await tick(10);
  assert.equal(calls.auth.length, 0);
  assert.equal(card.querySelector('.pm-dialog-title').textContent, '添加 AI 服务');
});

/* ---------- jsdom：双栏模型与保存 ---------- */

test('edit view preserves chosen order across independent searches and reorder lock', async () => {
  const { window, snapshot, api } = boot();
  const { card } = openCreate(window, snapshot, api, 'edit', snapshot.services[0]);
  assert.deepEqual([...card.querySelectorAll('[data-chosen-model]')].map(node => node.dataset.chosenModel), ['vision', 'fast']);
  const candidate = card.querySelector('[data-model-search=candidates]');
  candidate.value = 'fast';
  candidate.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual([...card.querySelectorAll('[data-chosen-model]')].map(node => node.dataset.chosenModel), ['vision', 'fast']);
  const chosen = card.querySelector('[data-model-search=chosen]');
  chosen.value = 'vision';
  chosen.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual([...card.querySelectorAll('[data-chosen-model]')].map(node => node.dataset.chosenModel), ['vision']);
  assert.ok(card.querySelector('.pm-reorder-lock'));
  assert.equal(card.querySelector('[data-model-handle]').getAttribute('aria-disabled'), 'true');
  chosen.value = '';
  chosen.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual([...card.querySelectorAll('[data-chosen-model]')].map(node => node.dataset.chosenModel), ['vision', 'fast']);
});

test('select-all only changes visible candidates and keyboard reorder updates modelOrder', async () => {
  const { window, snapshot, api, calls } = boot();
  const { card } = openCreate(window, snapshot, api, 'edit', snapshot.services[0]);
  const candidate = card.querySelector('[data-model-search=candidates]');
  candidate.value = 'fast';
  candidate.dispatchEvent(new window.Event('input', { bubbles: true }));
  const selectAll = card.querySelector('[data-select-all-candidates]');
  assert.equal(selectAll.checked, true);
  selectAll.checked = false;
  selectAll.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual([...card.querySelectorAll('[data-chosen-model]')].map(node => node.dataset.chosenModel), ['vision']);
  selectAll.checked = true;
  selectAll.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual([...card.querySelectorAll('[data-chosen-model]')].map(node => node.dataset.chosenModel), ['vision', 'fast']);
  candidate.value = '';
  candidate.dispatchEvent(new window.Event('input', { bubbles: true }));
  const handle = card.querySelector('[data-model-handle=vision]');
  handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert.deepEqual([...card.querySelectorAll('[data-chosen-model]')].map(node => node.dataset.chosenModel), ['fast', 'vision']);
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(20);
  assert.equal(calls.drafts.length, 1);
  assert.deepEqual(calls.drafts[0].draft.selectedModelIds, ['fast', 'vision']);
  assert.deepEqual(calls.drafts[0].draft.modelOrder, ['fast', 'vision']);
  assert.equal(calls.commits.length, 1);
  assert.equal(calls.commits[0].action, 'update');
});

test('custom model add rejects duplicates and exposes advanced parameters', async () => {
  const { window, snapshot, api } = boot();
  const { card } = openCreate(window, snapshot, api, 'edit', snapshot.services[0]);
  addCustom(card, 'fast');
  assert.equal(card.querySelectorAll('[data-chosen-model]').length, 2, 'duplicate must not be added');
  addCustom(card, 'custom-model');
  assert.deepEqual([...card.querySelectorAll('[data-chosen-model]')].map(node => node.dataset.chosenModel), ['vision', 'fast', 'custom-model']);
  const toggle = card.querySelector('[data-model-advanced-toggle=custom-model]');
  assert.ok(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'new custom model opens its parameters');
  assert.ok(card.querySelector('[data-model-advanced=custom-model]'));
  assert.ok(card.querySelector('[data-model-field="custom-model:contextWindow"]'));
  for (const [fieldName, label] of [['name', '显示名'], ['contextWindow', '上下文窗口'], ['maxTokens', '最大输出'], ['reasoning', '推理能力']]) {
    assert.equal(card.querySelector(`[data-model-field="custom-model:${fieldName}"]`).getAttribute('aria-label'), label);
  }
  toggle.click();
  assert.equal(card.querySelector('[data-model-advanced=custom-model]'), null);
  card.querySelector('[data-model-advanced-toggle=custom-model]').click();
  assert.ok(card.querySelector('[data-model-advanced=custom-model]'));
});

test('custom service chip follows the typed name and endpoint', async () => {
  const { window, snapshot, api } = boot();
  const { card } = openCreate(window, snapshot, api);
  pick(window, card, 'custom');
  const chipName = card.querySelector('.pm-service-chip-name');
  const chipDetail = card.querySelector('.pm-service-chip-detail');
  const name = card.querySelector('[aria-label="服务名称"]');
  name.value = '我的中转';
  name.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(chipName.textContent, '我的中转');
  const base = card.querySelector('[data-connection-base-url]');
  base.value = 'https://relay.example.test/v1';
  base.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(chipDetail.textContent, 'relay.example.test/v1');
});

test('clone setup shows a neutral credential state and no credential controls', async () => {
  const { window, snapshot, api } = boot();
  const { card } = openCreate(window, snapshot, api, 'clone', snapshot.services[0]);
  assert.equal(card.querySelector('.pm-dialog-title').textContent, '复制 AI 服务');
  assert.ok(card.querySelector('.pm-clone-credential').textContent.includes('复制不携带凭据'));
  assert.ok(card.querySelector('.pm-service-chip-detail').textContent.includes('不携带凭据'));
  assert.equal(card.querySelector('.pm-env-input'), null);
  assert.equal(card.querySelector('[data-credential-trigger]'), null);
  assert.equal(card.querySelector('.pm-clear-credential'), null);
  assert.equal(card.querySelector('.pm-change-service'), null);
  assert.equal(card.querySelectorAll('input[type=password]').length, 0);
  card.querySelector('.pm-advanced-entry').click();
  const localReference = card.querySelector('[data-advanced-field="piRegistrationReference"]');
  assert.equal(localReference.disabled, true);
  assert.ok(card.querySelector('[data-advanced-view]').textContent.includes('复制不会携带本机注册引用'));
});

test('raw key in the env field is blocked before any write', async () => {
  const { window, snapshot, api, calls } = boot();
  const { card } = openCreate(window, snapshot, api);
  pick(window, card, 'custom');
  card.querySelector('[data-connection-base-url]').value = 'https://example.invalid/v1';
  card.querySelector('[data-connection-base-url]').dispatchEvent(new window.Event('input', { bubbles: true }));
  const env = card.querySelector('.pm-env-input');
  env.value = 'raw-secret-key';
  env.dispatchEvent(new window.Event('input', { bubbles: true }));
  addCustom(card, 'demo-model');
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(20);
  assert.equal(calls.drafts.length, 0, 'must not send draft with invalid env reference');
  assert.equal(calls.commits.length, 0);
  assert.ok(card.querySelector('.pm-status-banner').textContent.includes('环境变量引用'));
  assert.equal(card.querySelectorAll('input[type=password]').length, 0);
});

test('save sends the frozen draft/commit payload and closes on success', async () => {
  const { window, snapshot, api, calls } = boot();
  const { card, saved } = openCreate(window, snapshot, api);
  pick(window, card, 'deepseek');
  addCustom(card, 'deepseek-chat');
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(30);
  assert.equal(calls.drafts.length, 1);
  assert.equal(calls.commits.length, 1);
  const draft = calls.drafts[0].draft;
  assert.equal(draft.providerId, 'deepseek');
  assert.equal(draft.authMode, 'environment');
  assert.equal(draft.connection.baseUrl, 'https://api.deepseek.com');
  assert.deepEqual(draft.selectedModelIds, ['deepseek-chat']);
  assert.ok(!JSON.stringify(calls).includes('raw-secret'));
  assert.deepEqual(calls.commits[0].credentialAction, { type: 'env', reference: '$DEEPSEEK_API_KEY' });
  assert.equal(calls.commits[0].action, 'create');
  assert.equal(saved.length, 1);
  assert.equal(window.document.getElementById('modal').hidden, true);
});

test('commit conflict keeps the draft and offers safe continuation', async () => {
  const { window, snapshot, api, calls } = boot();
  api.commitProviderDraft = async request => {
    calls.commits.push(clone(request));
    return { ok: false, code: 'config_conflict', message: '供应商配置已变化，请重读后保存。' };
  };
  const { card } = openCreate(window, snapshot, api);
  pick(window, card, 'deepseek');
  addCustom(card, 'deepseek-chat');
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(30);
  assert.equal(window.document.getElementById('modal').hidden, false);
  assert.ok(card.querySelector('.pm-status-banner').textContent.includes('保存时发现版本变化'));
  assert.ok([...card.querySelectorAll('.pm-status-banner button')].some(button => button.textContent === '重读并继续'),
    'string snapshot revision must still allow reading the latest config');
  assert.equal(card.querySelectorAll('[data-chosen-model]').length, 1);
  assert.equal(card.querySelector('[data-chosen-model]').dataset.chosenModel, 'deepseek-chat');
  assert.ok(card.querySelector('.pm-dialog-actions .pm-primary'));
});

test('lost commit response retries the same request ids without resending the draft', async () => {
  const { window, snapshot, api, calls } = boot();
  let first = true;
  api.commitProviderDraft = async request => {
    calls.commits.push(clone(request));
    if (first) {
      first = false;
      return { ok: false, network: true, error: 'offline' };
    }
    return { ok: true, serviceId: 'fixture', saved: true, credentialSaved: null, credentialState: 'saved', sync: { state: 'pending' }, revision: 'config-rev-next' };
  };
  const { card } = openCreate(window, snapshot, api);
  pick(window, card, 'deepseek');
  addCustom(card, 'deepseek-chat');
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(30);
  assert.equal(calls.drafts.length, 1);
  assert.equal(calls.commits.length, 1);
  const draftRequestId = calls.drafts[0].requestId;
  const commitRequestId = calls.commits[0].requestId;
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(30);
  assert.equal(calls.drafts.length, 1, 'an unchanged draft must not be sent again');
  assert.equal(calls.commits.length, 2);
  assert.equal(calls.drafts[0].requestId, draftRequestId);
  assert.equal(calls.commits[1].requestId, commitRequestId);
});

test('reload and continue rotates request ids for the new revision', async () => {
  const { window, snapshot, api, calls } = boot();
  let first = true;
  api.commitProviderDraft = async request => {
    calls.commits.push(clone(request));
    if (first) {
      first = false;
      snapshot.revision = 'config-rev-2';
      return { ok: false, code: 'config_conflict', message: '供应商配置已变化，请重读后保存。' };
    }
    return { ok: true, serviceId: 'fixture', saved: true, credentialSaved: null, credentialState: 'saved', sync: { state: 'pending' }, revision: 'config-rev-3' };
  };
  const { card } = openCreate(window, snapshot, api);
  pick(window, card, 'deepseek');
  addCustom(card, 'deepseek-chat');
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(30);
  const keep = [...card.querySelectorAll('.pm-status-banner button')].find(button => button.textContent === '重读并继续');
  assert.ok(keep);
  keep.click();
  await tick(30);
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(30);
  assert.equal(calls.drafts.length, 2);
  assert.notEqual(calls.drafts[1].requestId, calls.drafts[0].requestId);
  assert.equal(calls.drafts[1].expectedRevision, 'config-rev-2');
  assert.equal(calls.commits[1].expectedRevision, 'config-rev-2');
  assert.notEqual(calls.commits[1].requestId, calls.commits[0].requestId);
});

test('create credential conflict does not offer a clone with no source service', async () => {
  const { window, snapshot, api } = boot();
  api.commitProviderDraft = async () => ({ ok: false, code: 'credential_conflict', message: '该目标已有凭据。' });
  const { card } = openCreate(window, snapshot, api);
  pick(window, card, 'custom');
  card.querySelector('[aria-label="服务名称"]').value = 'Fixture';
  card.querySelector('[aria-label="服务名称"]').dispatchEvent(new window.Event('input', { bubbles: true }));
  card.querySelector('.pm-provider-id').value = 'fixture-create';
  card.querySelector('.pm-provider-id').dispatchEvent(new window.Event('input', { bubbles: true }));
  card.querySelector('[data-connection-base-url]').value = 'https://example.invalid/v1';
  card.querySelector('[data-connection-base-url]').dispatchEvent(new window.Event('input', { bubbles: true }));
  card.querySelector('.pm-env-input').value = '$FIXTURE_KEY';
  card.querySelector('.pm-env-input').dispatchEvent(new window.Event('input', { bubbles: true }));
  addCustom(card, 'fixture-model');
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(30);
  const actions = [...card.querySelectorAll('.pm-status-banner button')].map(button => button.textContent);
  assert.ok(!actions.includes('保留草稿并复制为新服务'));
  assert.ok(actions.includes('修改供应商标识'));
});

test('network failure keeps draft and does not close', async () => {
  const { window, snapshot, api, calls } = boot();
  api.saveProviderDraft = async request => {
    calls.drafts.push(clone(request));
    return { ok: false, network: true, error: 'offline' };
  };
  const { card } = openCreate(window, snapshot, api);
  pick(window, card, 'deepseek');
  addCustom(card, 'deepseek-chat');
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(20);
  assert.equal(window.document.getElementById('modal').hidden, false);
  assert.ok(card.querySelector('.pm-status-banner').textContent.includes('网络连接失败'));
  assert.equal(card.querySelectorAll('[data-chosen-model]').length, 1);
});

test('advanced view returns on Escape and cancel respects dirty drafts', async () => {
  const { window, snapshot, api } = boot();
  const { card } = openCreate(window, snapshot, api, 'edit', snapshot.services[0]);
  card.querySelector('.pm-advanced-entry').click();
  assert.ok(card.querySelector('[data-advanced-view]'));
  assert.ok(card.querySelector('[data-advanced-view]').textContent.includes('https://example.invalid/v1'));
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await tick(0);
  assert.equal(card.querySelector('[data-advanced-view]'), null);
  assert.ok(card.querySelector('.pm-model-panes'));

  addCustom(card, 'dirty-model');
  [...card.querySelectorAll('.pm-dialog-actions .pm-btn')].find(button => button.textContent === '取消').click();
  await tick(0);
  assert.equal(window.document.getElementById('confirmLayer').hidden, false);
  const confirmCard = window.document.getElementById('confirmCard');
  [...confirmCard.querySelectorAll('button')].find(button => button.textContent === '继续编辑').click();
  await tick(0);
  assert.equal(window.document.getElementById('modal').hidden, false);
});

test('page list renders management services, badges, and opens the new chooser', async () => {
  const { window, calls } = boot();
  window.openProvidersPanel();
  await tick(20);
  const card = window.document.getElementById('modalCard');
  assert.equal(card.querySelector('.settings-page-title').textContent, '模型配置');
  assert.equal(card.querySelectorAll('.prov').length, 2);
  assert.ok(card.querySelector('.prov-warn').textContent.includes('EXAMPLE_KEY'));
  assert.ok(card.querySelector('.pm-badge'));
  assert.ok(card.querySelector('.prov-catalog-info span').textContent.includes('2 个自定义服务'));
  card.querySelector('.prov-btn-main').click();
  assert.ok(card.querySelector('.pm-chooser'));
  assert.equal(calls.legacy.length > 0, true);
});

test('management unsupported still renders the legacy provider list', async () => {
  const { window } = boot({ snapshot: { ok: false, code: 'unsupported', message: '管理能力未开放' } });
  window.openProvidersPanel();
  await tick(20);
  const card = window.document.getElementById('modalCard');
  assert.equal(card.querySelectorAll('.prov').length, 1);
  assert.ok(card.textContent.includes('example'));
  assert.ok(!card.textContent.includes('管理能力未开放'));
});

test('provider row menu marks connection test pending and disables only after confirmation', async () => {
  const { window, calls } = boot();
  window.openProvidersPanel();
  await tick(20);
  const card = window.document.getElementById('modalCard');
  const row = card.querySelector('.prov.pm-service-row');
  const more = row.querySelector('.pm-row-more');
  more.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await tick(0);
  assert.equal(card.querySelector('.pm-dialog-title'), null, 'keyboard on the menu button must not open the edit dialog');
  more.click();
  await tick(0);
  assert.deepEqual([...row.querySelectorAll('[data-service-action]')].map(item => item.textContent), ['编辑', '复制', '测试连接', '停用', '删除']);
  const testItem = row.querySelector('[data-service-action="测试连接"]');
  assert.equal(testItem.disabled, true);
  assert.ok(testItem.title.includes('P3'));
  row.querySelector('[data-service-action="停用"]').click();
  await tick(0);
  assert.equal(window.document.getElementById('confirmLayer').hidden, false);
  [...window.document.getElementById('confirmCard').querySelectorAll('button')].find(button => button.textContent === '停用').click();
  await tick(30);
  assert.equal(calls.commits.length, 1);
  assert.equal(calls.commits[0].action, 'disable');
  assert.equal(calls.commits[0].serviceId, 'example-ai');
});

test('disabled service re-enables through an update draft', async () => {
  const snapshot = clone(fixture.live.snapshot);
  snapshot.services[0].enabled = false;
  const { window, calls } = boot({ snapshot });
  window.openProvidersPanel();
  await tick(20);
  const row = window.document.getElementById('modalCard').querySelector('.prov.pm-service-row');
  assert.equal(row.classList.contains('is-disabled'), true);
  row.querySelector('.pm-row-more').click();
  await tick(0);
  row.querySelector('[data-service-action="启用"]').click();
  await tick(30);
  assert.equal(calls.drafts.length, 1);
  assert.equal(calls.drafts[0].draft.enabled, true);
  assert.equal(calls.commits.length, 1);
  assert.equal(calls.commits[0].action, 'update');
});

test('service menu clones without copying credentials and deletes only after confirmation', async () => {
  const { window, calls } = boot();
  window.openProvidersPanel();
  await tick(20);
  let card = window.document.getElementById('modalCard');
  let row = card.querySelector('.prov.pm-service-row');
  row.querySelector('.pm-row-more').click();
  await tick(0);
  row.querySelector('[data-service-action="复制"]').click();
  await tick(10);
  assert.equal(card.querySelector('.pm-dialog-title').textContent, '复制 AI 服务');
  assert.equal(card.querySelector('.pm-provider-id').value, 'example-ai-copy');
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(30);
  assert.equal(calls.drafts.length, 1);
  assert.equal(calls.drafts[0].draft.providerId, 'example-ai-copy');
  assert.equal(calls.commits.length, 1);
  assert.equal(calls.commits[0].action, 'clone');
  assert.equal(calls.commits[0].serviceId, 'example-ai');
  assert.deepEqual(calls.commits[0].credentialAction, { type: 'keep' });
  assert.equal(window.document.getElementById('modal').hidden, true);

  window.openProvidersPanel();
  await tick(20);
  card = window.document.getElementById('modalCard');
  row = card.querySelector('.prov.pm-service-row');
  row.querySelector('.pm-row-more').click();
  await tick(0);
  row.querySelector('[data-service-action="删除"]').click();
  await tick(0);
  [...window.document.getElementById('confirmCard').querySelectorAll('button')].find(button => button.textContent === '删除').click();
  await tick(30);
  assert.equal(calls.commits.length, 2);
  assert.equal(calls.commits[1].action, 'delete');
  assert.equal(calls.commits[1].serviceId, 'example-ai');
});

test('CSS carries the 1040x720 shell, four-column chooser, dual panes, and breakpoints', () => {
  const css = fs.readFileSync(path.join(pub, 'provider-management.css'), 'utf8');
  assert.ok(css.includes('width: min(1040px, calc(100vw - 48px))'));
  assert.ok(css.includes('height: min(720px, calc(100dvh - 64px))'));
  assert.ok(css.includes('grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))'));
  assert.ok(css.includes('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)'));
  assert.ok(css.includes('@media (max-width: 940px)'));
  assert.ok(css.includes('@media (max-width: 720px)'));
  assert.ok(css.includes('@media (max-width: 480px)'));
  assert.ok(css.includes('var(--ds-bg-'));
  const dialogSource = fs.readFileSync(path.join(pub, 'provider-management/dialog.js'), 'utf8');
  assert.ok(!dialogSource.includes("type: 'password'"));
  assert.ok(!dialogSource.includes('type="password"'));
});
