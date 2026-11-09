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

function boot({
  fetchImpl,
  snapshot: snapshotOverride = null,
  legacyData: legacyOverride = null,
  managementReply: managementOverride = null,
  legacyDelete: legacyDeleteOverride = null,
  restart: restartOverride = null,
} = {}) {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:7788/' });
  const { window } = dom;
  const snapshot = clone(snapshotOverride || fixture.live.snapshot);
  const legacyData = clone(legacyOverride || {
    ok: true,
    path: 'C:\\fixture\\models.json',
    revision: 7,
    providers: { example: { models: [{ id: 'fast' }] } },
    keyStates: { 'example-ai': { ok: false, note: '环境变量 EXAMPLE_KEY 没有设置' } },
  });
  // 每个字段都可变：竞态用例要在同一个页面里让下一次探测换结果。
  // 默认管理关闭按真实后端形状返回 422，而不是把 unsupported 包在 200 里。
  const disabledShape = snapshot && snapshot.ok === false && snapshot.code === 'unsupported';
  const managementReply = managementOverride || { status: disabledShape ? 422 : 200, body: snapshot, network: false, malformed: false };
  const legacyDeleteReply = legacyDeleteOverride || { status: 200, body: { ok: true } };
  const restartReply = restartOverride || { status: 200, body: { ok: true } };
  const calls = { drafts: [], commits: [], discovery: [], authorize: [], test: [], legacy: [], legacyPosts: [], legacyDeletes: [], managementGets: [], restart: [], auth: [] };
  const api = {
    fetchProviderManagement: async () => snapshot,
    fetchProviderServiceCache: async () => ({ ok: true, sourceKind: 'none', cachedModels: [] }),
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
      calls.managementGets.push(target);
      if (managementReply.network) throw new Error('fixture management network down');
      return { status: managementReply.status ?? 200, json: async () => {
        if (managementReply.malformed) throw new SyntaxError('fixture invalid management response');
        return clone(managementReply.body);
      } };
    }
    if (target.includes('/api/providers')) {
      calls.legacy.push(target);
      const method = options?.method || 'GET';
      if (method === 'DELETE') {
        calls.legacyDeletes.push(target);
        return { status: legacyDeleteReply.status ?? 200, json: async () => clone(legacyDeleteReply.body) };
      }
      if (method === 'POST') {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.legacyPosts.push(clone(body));
        return { status: 200, json: async () => ({ ok: true, provider: body?.name || '', keyState: { kind: 'none', ok: true, note: '' } }) };
      }
      return { status: 200, json: async () => legacyData };
    }
    if (target.includes('/api/provider-auth')) {
      calls.auth.push(target);
      return { status: 200, json: async () => ({ ok: true, capability: { sdkAvailable: true }, providers: [], flow: null, sync: { state: 'idle' } }) };
    }
    if (target.includes('/api/restart')) {
      calls.restart.push(target);
      return { status: restartReply.status ?? 200, json: async () => clone(restartReply.body) };
    }
    return { status: 200, json: async () => (fetchImpl ? fetchImpl(target, options) : { ok: true }) };
  };
  window.eval(appBundle.code);
  return { dom, window, snapshot, managementReply, legacyDeleteReply, restartReply, api, calls };
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

test('credential clear support distinguishes config references from Pi native credentials', async () => {
  const s = await import('../public/provider-management/state.js');
  const { credentialSourceLabel } = await import('../public/provider-management/catalog.js');
  const base = s.draftFromService(clone(fixture.live.snapshot.services[0]), clone(fixture.live.snapshot));
  for (const source of ['env', 'literal', 'command']) {
    const draft = { ...base, credentialState: { state: 'saved', source } };
    assert.equal(s.credentialClearSupport(draft).supported, true, `${source} is a config-owned reference`);
    assert.deepEqual(s.commitCredentialAction({ ...draft, credentialAction: { type: 'none', confirmed: true } }), { type: 'none', confirmed: true });
  }
  const native = { ...base, credentialState: { state: 'saved', source: 'pi-credential' }, credentialAction: { type: 'none', confirmed: true } };
  const nativeSupport = s.credentialClearSupport(native);
  assert.equal(nativeSupport.supported, false);
  assert.ok(nativeSupport.reason.includes('安全凭据窗口'));
  const approved = s.credentialClearSupport(native, { native: true });
  assert.equal(approved.supported, true);
  assert.equal(approved.native, true);
  assert.deepEqual(s.commitCredentialAction({ ...native, nativeStage: { action: 'clear', draftId: 'draft-1', connectionRevision: 1 } }),
    { type: 'clear-native' }, 'an approved native clear uses the P3 clear-native contract');
  assert.deepEqual(s.commitCredentialAction({ ...native, nativeStage: { action: 'set', draftId: 'draft-1', connectionRevision: 1 } }),
    { type: 'apply-staged' }, 'a staged key uses the P3 apply-staged contract');
  assert.deepEqual(s.commitCredentialAction(native), { type: 'keep' }, 'none must never be sent as a native credential clear');
  assert.equal(s.credentialClearSupport({ ...base, credentialState: { state: 'none', source: 'unknown' } }).supported, false);
  assert.equal(credentialSourceLabel({ state: 'saved', source: 'literal' }), '配置内凭据');
  assert.equal(credentialSourceLabel({ state: 'saved', source: 'pi-credential' }), 'Pi 本机凭据');
});

test('inherited selection requires explicit confirmation for unrelated edits', async () => {
  const s = await import('../public/provider-management/state.js');
  const snapshot = clone(fixture.live.snapshot);
  const service = clone(snapshot.services[0]);
  service.selectedModelIds = null;
  service.modelOrder = null;
  let draft = s.draftFromService(service, snapshot);
  assert.equal(s.needsInheritedSelectionConfirmation(draft), true);
  draft = s.reduceDraft(draft, { type: 'field', field: 'displayName', value: '只改名称' });
  assert.equal(s.needsInheritedSelectionConfirmation(draft), true, 'name-only edit must not silently pin inheritance');
  assert.deepEqual(s.toDraftPayload(draft).selectedModelIds, ['fast', 'vision']);
  draft = s.reduceDraft(draft, { type: 'toggle-model', modelId: 'fast', selected: false });
  assert.equal(s.needsInheritedSelectionConfirmation(draft), false, 'an explicit selection change is the user’s own decision');
});

test('explicit selection, zero selection and model order keep their own semantics', async () => {
  const s = await import('../public/provider-management/state.js');
  const snapshot = clone(fixture.live.snapshot);
  const explicit = clone(snapshot.services[0]);
  explicit.selectedModelIds = ['vision', 'fast'];
  explicit.modelOrder = ['fast', 'vision'];
  const explicitDraft = s.draftFromService(explicit, snapshot);
  assert.equal(explicitDraft.inheritedSelection, false);
  assert.deepEqual(explicitDraft.order, ['fast', 'vision']);
  assert.equal(s.needsInheritedSelectionConfirmation(explicitDraft), false);

  const zero = clone(snapshot.services[0]);
  zero.selectedModelIds = [];
  zero.modelOrder = [];
  const zeroDraft = s.draftFromService(zero, snapshot);
  assert.equal(zeroDraft.inheritedSelection, false);
  assert.deepEqual(zeroDraft.order, []);
  assert.equal(s.needsInheritedSelectionConfirmation(zeroDraft), false);
  assert.deepEqual(s.toDraftPayload(zeroDraft).selectedModelIds, []);
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

test('credential trigger stays disabled without the private preload bridge API', () => {
  const granted = clone(fixture.live.snapshot);
  granted.capabilities.privateDesktopBridge = true;
  granted.capabilities.keyStaging = true;
  granted.capabilities.reasons = { ...granted.capabilities.reasons, privateDesktopBridge: null };
  const { window, api } = boot();
  const { card } = openCreate(window, granted, api);
  pick(window, card, 'deepseek');
  const trigger = card.querySelector('[data-credential-trigger]');
  assert.equal(trigger.disabled, true, 'snapshot capability alone must not expose a dead credential trigger');
  assert.ok(trigger.title.includes('网页版没有 Electron 安全凭据窗口'), 'the reason must name the missing bridge, not a pending phase');
  assert.equal(card.querySelectorAll('input[type=password]').length, 0);
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

test('Pi native credential clear is disabled with an accurate reason and never sends none', async () => {
  const snapshot = clone(fixture.live.snapshot);
  const service = clone(snapshot.services[0]);
  service.authMode = 'pi-credential';
  service.credentialState = { state: 'saved', source: 'pi-credential' };
  const { window, api, calls } = boot();
  const { card } = openCreate(window, snapshot, api, 'edit', service);
  const clear = card.querySelector('.pm-clear-credential');
  assert.ok(clear);
  assert.equal(clear.disabled, true);
  assert.equal(clear.textContent, '清除本机凭据');
  assert.ok(clear.title.includes('安全凭据窗口'));
  assert.ok(card.querySelector('.pm-clear-note').textContent.includes('安全凭据窗口'));
  clear.click();
  await tick(10);
  assert.equal(window.document.getElementById('confirmLayer').hidden, true, 'disabled clear must not open a confirmation');
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(30);
  assert.equal(calls.commits.length, 1);
  assert.deepEqual(calls.commits[0].credentialAction, { type: 'keep' });
  assert.ok(!JSON.stringify(calls).includes('"type":"none"'));
});

test('config-owned credential clear states exactly what will and will not be removed', async () => {
  const { window, snapshot, api, calls } = boot();
  const { card } = openCreate(window, snapshot, api, 'edit', snapshot.services[0]);
  const clear = card.querySelector('.pm-clear-credential');
  assert.ok(clear);
  assert.equal(clear.disabled, false);
  assert.equal(clear.textContent, '清除配置凭据');
  clear.click();
  await tick(10);
  const confirm = window.document.getElementById('confirmCard');
  assert.equal(window.document.getElementById('confirmLayer').hidden, false);
  assert.ok(confirm.textContent.includes('环境变量本身和 Pi 本机登录都不会被删除'));
  [...confirm.querySelectorAll('button')].find(button => button.textContent === '保存时清除配置凭据').click();
  await tick(10);
  assert.ok(card.querySelector('.pm-credential-status').textContent.includes('移除配置中的环境变量引用'));
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(30);
  assert.equal(calls.commits.length, 1);
  assert.deepEqual(calls.commits[0].credentialAction, { type: 'none', confirmed: true });
  assert.ok(!card.textContent.includes('Pi 本机凭据已清除'));
});

test('delete confirmation distinguishes config removal from native authentication', async () => {
  const { window } = boot();
  window.openProvidersPanel();
  await tick(20);
  const card = window.document.getElementById('modalCard');
  const row = card.querySelector('.prov.pm-service-row');
  row.querySelector('.pm-row-more').click();
  await tick(0);
  row.querySelector('[data-service-action="删除"]').click();
  await tick(0);
  const confirm = window.document.getElementById('confirmCard');
  assert.equal(window.document.getElementById('confirmLayer').hidden, false);
  assert.ok(confirm.textContent.includes('Pi 本机认证'));
  assert.ok(confirm.textContent.includes('内置服务只会停用'));
  assert.ok(confirm.textContent.includes('安全检查会拒绝'));
  assert.ok(!confirm.textContent.includes('模型与凭据会随配置一起移除'));
  [...confirm.querySelectorAll('button')].find(button => button.textContent === '取消').click();
});

test('more menu toggles, closes other rows, and keeps aria-expanded in sync', async () => {
  const { window } = boot();
  window.openProvidersPanel();
  await tick(20);
  const card = window.document.getElementById('modalCard');
  const rows = [...card.querySelectorAll('.prov.pm-service-row')];
  assert.equal(rows.length, 2);
  const firstMore = rows[0].querySelector('.pm-row-more');
  const secondMore = rows[1].querySelector('.pm-row-more');
  const firstMenu = rows[0].querySelector('.pm-row-menu');
  const secondMenu = rows[1].querySelector('.pm-row-menu');

  firstMore.click();
  await tick(0);
  assert.equal(firstMenu.hidden, false);
  assert.equal(firstMore.getAttribute('aria-expanded'), 'true');
  firstMore.click();
  await tick(0);
  assert.equal(firstMenu.hidden, true);
  assert.equal(firstMore.getAttribute('aria-expanded'), 'false');

  firstMore.click();
  await tick(0);
  secondMore.click();
  await tick(0);
  assert.equal(firstMenu.hidden, true);
  assert.equal(firstMore.getAttribute('aria-expanded'), 'false');
  assert.equal(secondMenu.hidden, false);
  assert.equal(secondMore.getAttribute('aria-expanded'), 'true');

  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await tick(0);
  assert.equal(secondMenu.hidden, true);
  assert.equal(secondMore.getAttribute('aria-expanded'), 'false');
  assert.equal(window.document.activeElement, secondMore);

  firstMore.click();
  await tick(0);
  window.document.body.click();
  await tick(0);
  assert.equal(firstMenu.hidden, true);
  assert.equal(firstMore.getAttribute('aria-expanded'), 'false');
});

test('inherited model selection asks before an unrelated edit pins it', async () => {
  const snapshot = clone(fixture.live.snapshot);
  const service = clone(snapshot.services[0]);
  service.selectedModelIds = null;
  service.modelOrder = null;
  const { window, api, calls } = boot();
  const { card } = openCreate(window, snapshot, api, 'edit', service);
  assert.ok(card.querySelector('.pm-status-banner').textContent.includes('当前模型集是继承的'));
  card.querySelector('.pm-advanced-entry').click();
  const name = card.querySelector('[data-advanced-field="displayName"]');
  name.value = '只改名称';
  name.dispatchEvent(new window.Event('input', { bubbles: true }));
  card.querySelector('.pm-advanced-foot button').click();
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(20);
  assert.equal(calls.drafts.length, 0, 'no write before the inheritance decision');
  const confirm = window.document.getElementById('confirmCard');
  assert.equal(window.document.getElementById('confirmLayer').hidden, false);
  assert.ok(confirm.textContent.includes('继承'));
  assert.ok(confirm.textContent.includes('固定为显式选择'));
  [...confirm.querySelectorAll('button')].find(button => button.textContent === '返回检查').click();
  await tick(10);
  assert.equal(calls.drafts.length, 0);
  assert.equal(window.document.getElementById('modal').hidden, false);

  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(20);
  [...window.document.getElementById('confirmCard').querySelectorAll('button')].find(button => button.textContent === '固定并保存').click();
  await tick(30);
  assert.equal(calls.drafts.length, 1);
  assert.deepEqual(calls.drafts[0].draft.selectedModelIds, ['fast', 'vision']);
});

test('management-off add uses the P4 UI over the legacy API without fake fields', async () => {
  const legacyData = {
    ok: true,
    path: 'C:\\fixture\\models.json',
    revision: 7,
    providers: { example: { baseUrl: 'https://example.invalid/v1', api: 'openai-completions', models: [{ id: 'm1', name: 'M1' }] } },
    keyStates: { example: { kind: 'env', ok: true, note: '' } },
  };
  const { window, calls } = boot({ snapshot: { ok: false, code: 'unsupported', message: '管理能力未开放' }, legacyData });
  window.openProvidersPanel();
  await tick(20);
  const card = window.document.getElementById('modalCard');
  assert.ok(card.querySelector('.pm-page-status').textContent.includes('兼容编辑器'));
  card.querySelector('.prov-btn-main').click();
  await tick(30);
  assert.ok(card.querySelector('.pm-chooser'), 'compatibility path must keep the P4 chooser');
  const tile = [...card.querySelectorAll('.pm-service-tile')].find(node => node.dataset.serviceId === 'custom');
  tile.click();
  await tick(10);
  assert.equal(card.querySelector('[aria-label="服务名称"]'), null, 'legacy API has no display-name field to persist');
  const id = card.querySelector('.pm-provider-id');
  id.value = 'legacy-new';
  id.dispatchEvent(new window.Event('input', { bubbles: true }));
  const base = card.querySelector('[data-connection-base-url]');
  base.value = 'https://legacy.example.test/v1';
  base.dispatchEvent(new window.Event('input', { bubbles: true }));
  const env = card.querySelector('.pm-env-input');
  env.value = '$LEGACY_KEY';
  env.dispatchEvent(new window.Event('input', { bubbles: true }));
  addCustom(card, 'legacy-model');
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(40);
  assert.equal(calls.drafts.length, 0, 'management API is off; no draft may be sent');
  assert.equal(calls.legacyPosts.length, 1);
  assert.equal(calls.legacyPosts[0].name, 'legacy-new');
  assert.equal(calls.legacyPosts[0].config.baseUrl, 'https://legacy.example.test/v1');
  assert.equal(calls.legacyPosts[0].config.apiKey, '$LEGACY_KEY');
  assert.deepEqual(calls.legacyPosts[0].config.models, [{ id: 'legacy-model' }]);
});

test('management-off edit reuses the same model panes and preserves an existing key', async () => {
  const legacyData = {
    ok: true,
    path: 'C:\\fixture\\models.json',
    revision: 7,
    providers: { example: { baseUrl: 'https://example.invalid/v1', api: 'openai-completions', models: [{ id: 'm1', name: 'M1' }] } },
    keyStates: { example: { kind: 'env', ok: true, note: '' } },
  };
  const { window, calls } = boot({ snapshot: { ok: false, code: 'unsupported', message: '管理能力未开放' }, legacyData });
  window.openProvidersPanel();
  await tick(20);
  const card = window.document.getElementById('modalCard');
  const row = card.querySelector('[data-service-name="example"]');
  assert.ok(row);
  assert.equal(row.getAttribute('role'), 'button');
  row.click();
  await tick(30);
  assert.equal(card.querySelector('.pm-dialog-title').textContent, '编辑 AI 服务');
  assert.ok(card.querySelector('.pm-model-panes'));
  assert.ok(card.querySelector('.pm-status-banner').textContent.includes('勾选与排序不会保存'));
  const check = card.querySelector('[data-model-check="m1"]');
  check.checked = false;
  check.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(0);
  assert.equal(card.querySelector('[data-model-check="m1"]').checked, true, 'legacy selection toggles must not fake a persisted change');
  const clear = card.querySelector('.pm-clear-credential');
  assert.ok(clear);
  assert.equal(clear.disabled, true, 'legacy API cannot clear a config reference either');
  assert.equal(clear.textContent, '清除凭据', 'legacy config references must not be labeled as Pi native credentials');
  card.querySelector('.pm-advanced-entry').click();
  assert.equal(card.querySelector('[data-advanced-field="displayName"]'), null);
  assert.equal(card.querySelector('[data-advanced-field="enabled"]'), null);
  assert.equal(card.querySelector('[data-advanced-field="piRegistrationReference"]').disabled, true);
  assert.ok(card.querySelector('[data-advanced-view]').textContent.includes('兼容模式直接写入 Pi 模型配置'));
  card.querySelector('.pm-advanced-foot button').click();
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(40);
  assert.equal(calls.legacyPosts.length, 1);
  assert.equal(calls.legacyPosts[0].name, 'example');
  assert.equal(calls.legacyPosts[0].config.apiKey, undefined, 'omitting apiKey preserves the existing value in the legacy merge');
  assert.deepEqual(calls.legacyPosts[0].config.models, [{ id: 'm1', name: 'M1' }]);
});

test('legacy delete asks first and cancel never sends DELETE', async () => {
  const legacyData = {
    ok: true,
    path: 'C:\\fixture\\models.json',
    revision: 7,
    providers: { example: { baseUrl: 'https://example.invalid/v1', api: 'openai-completions', models: [{ id: 'm1' }] } },
    keyStates: { example: { kind: 'env', ok: true, note: '' } },
  };
  const { window, calls } = boot({ snapshot: { ok: false, code: 'unsupported' }, legacyData });
  window.openProvidersPanel();
  await tick(20);
  const row = window.document.querySelector('.prov[data-service-name="example"]');
  assert.ok(row, 'legacy row must render');
  row.querySelector('.prov-del').click();
  await tick(0);
  const confirm = window.document.getElementById('confirmCard');
  assert.equal(window.document.getElementById('confirmLayer').hidden, false, 'delete must ask before writing');
  assert.ok(confirm.textContent.includes('Pi 模型配置'), 'confirmation must say what is removed');
  assert.ok(confirm.textContent.includes('Pi 本机认证'), 'confirmation must distinguish native auth');
  assert.ok(confirm.textContent.includes('环境变量'), 'confirmation must distinguish environment variables');
  [...confirm.querySelectorAll('button')].find(button => button.textContent === '取消').click();
  await tick(20);
  assert.equal(calls.legacyDeletes.length, 0, 'cancel must not send DELETE');
  assert.ok(window.document.querySelector('.prov[data-service-name="example"]'), 'row must remain after cancel');
});

test('legacy delete supports keyboard confirmation and sends exactly one DELETE', async () => {
  const legacyData = {
    ok: true,
    path: 'C:\\fixture\\models.json',
    revision: 7,
    providers: { example: { baseUrl: 'https://example.invalid/v1', api: 'openai-completions', models: [{ id: 'm1' }] } },
    keyStates: { example: { kind: 'env', ok: true, note: '' } },
  };
  const { window, calls } = boot({ snapshot: { ok: false, code: 'unsupported' }, legacyData });
  window.openProvidersPanel();
  await tick(20);
  const row = window.document.querySelector('.prov[data-service-name="example"]');
  const del = row.querySelector('.prov-del');
  del.focus();
  del.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await tick(0);
  assert.equal(window.document.getElementById('confirmLayer').hidden, false, 'keyboard activation must ask');
  [...window.document.getElementById('confirmCard').querySelectorAll('button')].find(button => button.textContent === '删除').click();
  await tick(30);
  assert.equal(calls.legacyDeletes.length, 1, 'confirm must send one DELETE');
  assert.ok(calls.legacyDeletes[0].endsWith('/api/providers/example'));
  assert.equal(window.document.getElementById('confirmLayer').hidden, true);
});

test('legacy delete failure keeps the row and shows the real error', async () => {
  const legacyData = {
    ok: true,
    path: 'C:\\fixture\\models.json',
    revision: 7,
    providers: { example: { baseUrl: 'https://example.invalid/v1', api: 'openai-completions', models: [{ id: 'm1' }] } },
    keyStates: { example: { kind: 'env', ok: true, note: '' } },
  };
  const { window, calls } = boot({
    snapshot: { ok: false, code: 'unsupported' },
    legacyData,
    legacyDelete: { status: 423, body: { ok: false, error: '供应商配置正在被其他进程使用' } },
  });
  window.openProvidersPanel();
  await tick(20);
  const row = window.document.querySelector('.prov[data-service-name="example"]');
  row.querySelector('.prov-del').click();
  await tick(0);
  [...window.document.getElementById('confirmCard').querySelectorAll('button')].find(button => button.textContent === '删除').click();
  await tick(30);
  assert.equal(calls.legacyDeletes.length, 1);
  assert.ok(window.document.querySelector('.prov[data-service-name="example"]'), 'failed delete must keep the list');
  assert.ok(window.document.getElementById('toasts').textContent.includes('供应商配置正在被其他进程使用'));
});

test('reload keeps the current conversation thread', async () => {
  const { window, calls } = boot();
  const thread = window.document.createElement('div');
  thread.className = 'thread';
  thread.innerHTML = '<article class="msg">fixture conversation must stay</article>';
  window.document.getElementById('stream').appendChild(thread);
  window.S.thread = thread;
  const result = await window.reloadPi();
  await tick(0);
  assert.equal(result, true);
  assert.equal(calls.restart.length, 1);
  assert.ok(thread.textContent.includes('fixture conversation must stay'), 'reload must not clear the visible thread');
});

test('failed reload keeps the thread and shows the real error', async () => {
  const { window, calls } = boot({ restart: { status: 500, body: { ok: false, error: 'fixture restart failed' } } });
  const thread = window.document.createElement('div');
  thread.className = 'thread';
  thread.innerHTML = '<article class="msg">fixture conversation survives failure</article>';
  window.document.getElementById('stream').appendChild(thread);
  window.S.thread = thread;
  const result = await window.reloadPi();
  await tick(0);
  assert.equal(result, false);
  assert.equal(calls.restart.length, 1);
  assert.ok(thread.textContent.includes('fixture conversation survives failure'));
  assert.ok(window.document.getElementById('toasts').textContent.includes('fixture restart failed'));
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

test('management 500 is not treated as disabled and never falls back to legacy writes', async () => {
  const legacyData = {
    ok: true,
    path: 'C:\\fixture\\models.json',
    revision: 7,
    providers: { example: { baseUrl: 'https://example.invalid/v1', api: 'openai-completions', models: [{ id: 'm1' }] } },
    keyStates: { example: { kind: 'env', ok: true, note: '' } },
  };
  const { window, calls } = boot({
    snapshot: { ok: false, error: 'fixture failure' },
    managementReply: { status: 500, body: { ok: false, error: 'fixture internal failure' } },
    legacyData,
  });
  window.openProvidersPanel();
  await tick(20);
  const card = window.document.getElementById('modalCard');
  assert.equal(card.querySelectorAll('.prov[data-service-name]').length, 0, '500 must not render the legacy list');
  assert.ok(card.querySelector('.pm-management-error'), '500 must render a retryable error state');
  assert.ok(card.textContent.includes('500'));
  card.querySelector('.prov-btn-main').click();
  await tick(30);
  assert.equal(calls.legacyPosts.length, 0, 'an API error must not become a legacy write');
  assert.equal(card.querySelector('.pm-dialog-title'), null, 'an API error must not open the legacy editor');
});

test('management network failure and 403 do not enable the legacy editor', async () => {
  const legacyData = {
    ok: true,
    path: 'C:\\fixture\\models.json',
    revision: 7,
    providers: { example: { models: [{ id: 'm1' }] } },
    keyStates: {},
  };
  const network = boot({
    snapshot: { ok: false, error: 'fixture failure' },
    managementReply: { status: 0, body: null, network: true },
    legacyData,
  });
  network.window.openProvidersPanel();
  await tick(20);
  const networkCard = network.window.document.getElementById('modalCard');
  assert.equal(networkCard.querySelectorAll('.prov[data-service-name]').length, 0);
  assert.ok(networkCard.textContent.includes('无法连接'));
  networkCard.querySelector('.prov-btn-main').click();
  await tick(30);
  assert.equal(network.calls.legacyPosts.length, 0);

  const forbidden = boot({
    snapshot: { ok: false, error: 'fixture failure' },
    managementReply: { status: 403, body: { ok: false, error: 'fixture forbidden' } },
    legacyData,
  });
  forbidden.window.openProvidersPanel();
  await tick(20);
  const forbiddenCard = forbidden.window.document.getElementById('modalCard');
  assert.equal(forbiddenCard.querySelectorAll('.prov[data-service-name]').length, 0);
  assert.ok(forbiddenCard.textContent.includes('403'));
  forbiddenCard.querySelector('.prov-btn-main').click();
  await tick(30);
  assert.equal(forbidden.calls.legacyPosts.length, 0);
});

test('malformed management response is a contract error, not feature-off', async () => {
  const legacyData = {
    ok: true,
    path: 'C:\\fixture\\models.json',
    revision: 7,
    providers: { example: { models: [{ id: 'm1' }] } },
    keyStates: {},
  };
  const { window, calls } = boot({
    snapshot: { ok: false, error: 'fixture failure' },
    managementReply: { status: 200, body: null, malformed: true },
    legacyData,
  });
  window.openProvidersPanel();
  await tick(20);
  const card = window.document.getElementById('modalCard');
  assert.equal(card.querySelectorAll('.prov[data-service-name]').length, 0);
  assert.ok(card.textContent.includes('无法识别'));
  card.querySelector('.prov-btn-main').click();
  await tick(30);
  assert.equal(calls.legacyPosts.length, 0);
  assert.equal(card.querySelector('.pm-dialog-title'), null);
});

test('management 200 with a foreign body is a contract error, not feature-off', async () => {
  const legacyData = {
    ok: true,
    path: 'C:\\fixture\\models.json',
    revision: 7,
    providers: { example: { models: [{ id: 'm1' }] } },
    keyStates: {},
  };
  const { window, calls } = boot({
    snapshot: { ok: false, error: 'fixture failure' },
    managementReply: { status: 200, body: { ok: true, providers: {} } },
    legacyData,
  });
  window.openProvidersPanel();
  await tick(20);
  const card = window.document.getElementById('modalCard');
  assert.equal(card.querySelectorAll('.prov[data-service-name]').length, 0);
  assert.ok(card.textContent.includes('无法识别的数据'));
  card.querySelector('.prov-btn-main').click();
  await tick(30);
  assert.equal(calls.legacyPosts.length, 0);
  assert.equal(card.querySelector('.pm-dialog-title'), null);
});

test('legacy mode rechecks management before adding after an API failure', async () => {
  const legacyData = {
    ok: true,
    path: 'C:\\fixture\\models.json',
    revision: 7,
    providers: { example: { models: [{ id: 'm1' }] } },
    keyStates: {},
  };
  const { window, calls, managementReply } = boot({ snapshot: { ok: false, code: 'unsupported' }, legacyData });
  window.openProvidersPanel();
  await tick(20);
  const card = window.document.getElementById('modalCard');
  assert.ok(card.querySelector('.prov[data-service-name="example"]'));
  managementReply.status = 500;
  managementReply.body = { ok: false, error: 'fixture internal failure' };
  card.querySelector('.prov-btn-main').click();
  await tick(30);
  assert.equal(calls.legacyPosts.length, 0, 'a stale compatibility flag must not write after management errors');
  assert.equal(card.querySelector('.pm-dialog-title'), null);
  assert.ok(card.querySelector('.pm-management-error') || window.document.getElementById('toasts').textContent.includes('500'));
});

test('legacy editor refuses to save if management stops being explicitly disabled', async () => {
  const legacyData = {
    ok: true,
    path: 'C:\\fixture\\models.json',
    revision: 7,
    providers: { example: { baseUrl: 'https://example.invalid/v1', api: 'openai-completions', models: [{ id: 'm1' }] } },
    keyStates: { example: { kind: 'env', ok: true, note: '' } },
  };
  const { window, calls, managementReply } = boot({ snapshot: { ok: false, code: 'unsupported' }, legacyData });
  window.openProvidersPanel();
  await tick(20);
  window.document.querySelector('.prov[data-service-name="example"]').click();
  await tick(30);
  const card = window.document.getElementById('modalCard');
  assert.ok(card.querySelector('.pm-dialog-title'));
  managementReply.status = 500;
  managementReply.body = { ok: false, error: 'fixture internal failure' };
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(40);
  assert.equal(calls.legacyPosts.length, 0, 'legacy commit must revalidate management eligibility');
  assert.ok(card.querySelector('.pm-status-banner').textContent.includes('管理接口'));
});

test('management error retry re-reads the management snapshot', async () => {
  const legacyData = {
    ok: true,
    path: 'C:\\fixture\\models.json',
    revision: 7,
    providers: { example: { models: [{ id: 'm1' }] } },
    keyStates: {},
  };
  const { window, calls, managementReply } = boot({
    snapshot: { ok: false, error: 'fixture failure' },
    managementReply: { status: 500, body: { ok: false, error: 'fixture internal failure' } },
    legacyData,
  });
  window.openProvidersPanel();
  await tick(20);
  const card = window.document.getElementById('modalCard');
  const retry = [...card.querySelectorAll('button')].find(button => button.textContent === '重试');
  assert.ok(retry, 'error state must provide a retry entry');
  managementReply.status = 200;
  managementReply.body = clone(fixture.live.snapshot);
  retry.click();
  await tick(40);
  assert.equal(calls.managementGets.length >= 2, true);
  assert.equal(card.querySelectorAll('.prov.pm-service-row').length, 2, 'retry must render the management list');
});

test('provider row menu disables connection test with the real discovery reason', async () => {
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
  assert.equal(testItem.title, '当前后端未提供自动发现能力');
  row.querySelector('[data-service-action="停用"]').click();
  await tick(0);
  assert.equal(window.document.getElementById('confirmLayer').hidden, false);
  [...window.document.getElementById('confirmCard').querySelectorAll('button')].find(button => button.textContent === '停用').click();
  await tick(30);
  assert.equal(calls.commits.length, 1);
  assert.equal(calls.commits[0].action, 'disable');
  assert.equal(calls.commits[0].serviceId, 'example-ai');
});

test('disabled service re-enables through the metadata-only enable action', async () => {
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
  // P6：与停用对称，不再构造草稿（部分服务的 connection 为空，draft 合同无法表达）。
  assert.equal(calls.drafts.length, 0);
  assert.equal(calls.commits.length, 1);
  assert.equal(calls.commits[0].action, 'enable');
  assert.equal(calls.commits[0].serviceId, 'example-ai');
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

test('lock icon renders a real rect body instead of an invalid path', async () => {
  /* P6 回归：icon() 曾把 'rect:...' 规格写进 path 的 d（"5,10,14,10,2"），
   * 真实 Chromium 报非法 path 且锁体不显示。 */
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1:7788/' });
  const previous = global.document;
  global.document = dom.window.document;
  try {
    const { icon } = await import('../public/provider-management/dom.js');
    const svg = icon('lock', 16);
    const rect = svg.querySelector('rect');
    assert.ok(rect, 'lock body rect exists');
    assert.equal(rect.getAttribute('x'), '5');
    assert.equal(rect.getAttribute('y'), '10');
    assert.equal(rect.getAttribute('width'), '14');
    assert.equal(rect.getAttribute('height'), '10');
    assert.equal(rect.getAttribute('rx'), '2');
    assert.equal(svg.querySelectorAll('path').length, 1);
    assert.equal(svg.querySelector('path').getAttribute('d'), 'M8 10V7a4 4 0 0 1 8 0v3');
  } finally {
    if (previous === undefined) delete global.document; else global.document = previous;
  }
});

test('re-selecting a model after refresh clears its pending remove patch', async () => {
  const s = await import('../public/provider-management/state.js');
  const store = s.createDraftStore(s.draftFromCatalog(clone(fixture.live.snapshot),
    { id: 'custom', name: '自定义端点', category: 'api-key', authMode: 'none', connection: null }));
  store.dispatch({ type: 'merge-models', models: [{ modelId: 'refresh-model', configSource: 'remote', effectiveValues: { name: 'Refresh Model' } }] });
  store.dispatch({ type: 'toggle-model', modelId: 'refresh-model', selected: true });
  store.dispatch({ type: 'remove-model', modelId: 'refresh-model' });
  assert.deepEqual(store.get().removed, ['refresh-model']);
  // 刷新把同一 ID 重新带回候选；再次勾选必须撤销待删除补丁（P6 回归）。
  store.dispatch({ type: 'merge-models', models: [{ modelId: 'refresh-model', configSource: 'remote', effectiveValues: { name: 'Refresh Model' } }] });
  store.dispatch({ type: 'toggle-model', modelId: 'refresh-model', selected: true });
  const draft = store.get();
  assert.deepEqual(draft.removed, []);
  assert.deepEqual(draft.order, ['refresh-model']);
  assert.deepEqual(s.draftPatches(draft), [{ modelId: 'refresh-model', operation: 'upsert' }]);
  assert.ok(!s.draftPatches(draft).some(patch => patch.operation === 'remove'));
});

test('discovered metadata is display-only and never enters model patches', async () => {
  const s = await import('../public/provider-management/state.js');
  const record = s.createModelRecord({ modelId: 'meta-model', providerId: 'fixture', configSource: 'remote',
    effectiveValues: { name: 'Meta Model', contextWindow: 12345, maxTokens: 4096, reasoning: true, input: ['text', 'image'] },
    editableOverrides: {} });
  assert.equal(record.name, null, 'discovered name is not an editable override');
  assert.equal(record.contextWindow, null);
  assert.deepEqual(record.displayValues, { name: 'Meta Model', contextWindow: 12345, maxTokens: 4096, reasoning: true, input: ['text', 'image'] });
  const store = s.createDraftStore(s.draftFromCatalog(clone(fixture.live.snapshot),
    { id: 'custom', name: '自定义端点', category: 'api-key', authMode: 'none', connection: null }));
  store.dispatch({ type: 'merge-models', models: [{ modelId: 'meta-model', configSource: 'remote',
    effectiveValues: { name: 'Meta Model', contextWindow: 12345 } }] });
  store.dispatch({ type: 'toggle-model', modelId: 'meta-model', selected: true });
  assert.deepEqual(s.draftPatches(store.get()), [{ modelId: 'meta-model', operation: 'upsert' }],
    'selection alone must not persist discovered metadata as an override');
});

test('a disabled OAuth service can be enabled again from the row menu', async () => {
  const snapshot = clone(fixture.live.snapshot);
  snapshot.services.push({ serviceId: 'oauth-fixture', providerId: 'fixture-oauth', catalogId: null, displayName: '订阅账户 Fixture',
    enabled: false, connection: null, credentialState: { state: 'saved', source: 'pi-credential' }, authMode: 'oauth',
    models: [], selectedModelIds: [], modelOrder: [], readOnly: false, compatibility: 'unknown' });
  const { window, calls } = boot({ snapshot });
  window.openProvidersPanel();
  await tick(20);
  const card = window.document.getElementById('modalCard');
  const row = [...card.querySelectorAll('.prov.pm-service-row')].find(node => node.textContent.includes('订阅账户 Fixture'));
  assert.ok(row, 'disabled OAuth row rendered');
  row.querySelector('.pm-row-more').click();
  await tick(0);
  const enable = row.querySelector('[data-service-action="启用"]');
  assert.ok(enable, 'enable action exists');
  assert.equal(enable.disabled, false, 'enable must not be disabled for OAuth services');
  enable.click();
  await tick(40);
  const commit = calls.commits[calls.commits.length - 1];
  assert.ok(commit, 'enable commits a metadata-only action');
  assert.equal(commit.action, 'enable');
  assert.equal(commit.serviceId, 'oauth-fixture');
  assert.equal(calls.drafts.length, 0, 'enable must not need a draft (subscription services have no connection)');
});

test('first builtin model override asks for confirmation and retries once', async () => {
  const { window, snapshot, api, calls } = boot();
  let attempts = 0;
  api.commitProviderDraft = async request => {
    calls.commits.push(clone(request));
    attempts += 1;
    if (attempts === 1) return { ok: false, code: 'invalid_request', message: '请求字段无效。', fieldErrors: { confirmBuiltinOverride: 'invalid' } };
    return { ok: true, serviceId: request.serviceId || 'example-ai', saved: true, credentialSaved: null, credentialState: 'none',
      sync: { state: 'pending', reason: 'runtime_sync_pending' }, revision: 'next' };
  };
  const { card } = openCreate(window, snapshot, api, 'edit', snapshot.services[0]);
  addCustom(card, 'override-model');
  await tick(10);
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(30);
  assert.equal(calls.commits.length, 1);
  const confirm = window.document.getElementById('confirmCard');
  assert.equal(window.document.getElementById('confirmLayer').hidden, false, 'override confirmation appears');
  assert.ok(confirm.textContent.includes('覆盖内置模型配置'));
  [...confirm.querySelectorAll('button')].find(button => button.textContent === '覆盖并保存').click();
  await tick(50);
  assert.equal(calls.commits.length, 2, 'confirm retries exactly once');
  assert.equal(calls.drafts.at(-1).draft.confirmBuiltinOverride, true);
});

/* ---------- P6 FIX-01/03：缓存首屏与显示回退 ---------- */

const uiWaitFor = async (check, timeoutMs = 3000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await tick(10);
  }
  return null;
};

function snapshotWithModel(configSource) {
  const snapshot = clone(fixture.live.snapshot);
  const service = snapshot.services[0];
  service.models = [{ modelId: 'cfg-model', providerId: service.providerId, configSource,
    effectiveValues: { name: 'Config Model', contextWindow: 32000, maxTokens: 4096, toolCalling: null, streaming: null },
    editableOverrides: { name: 'Config Model', contextWindow: 32000, maxTokens: 4096 } }];
  service.selectedModelIds = ['cfg-model'];
  service.modelOrder = ['cfg-model'];
  return { snapshot, service };
}

test('fresh remote results upgrade untouched cache candidates only', async () => {
  const s = await import('../public/provider-management/state.js');
  const makeDraft = () => s.createDraftStore(s.draftFromCatalog(clone(fixture.live.snapshot),
    { id: 'custom', name: '自定义端点', category: 'api-key', authMode: 'none', connection: null }));
  const store = makeDraft();
  store.dispatch({ type: 'merge-models', models: [{ modelId: 'c1', configSource: 'cache', cacheStale: true, effectiveValues: { name: 'Cached' } }] });
  assert.equal(store.get().models.find(model => model.modelId === 'c1').source, 'cache');
  assert.equal(store.get().models.find(model => model.modelId === 'c1').cachedStale, true);
  store.dispatch({ type: 'merge-models', models: [{ modelId: 'c1', configSource: 'remote', effectiveValues: { name: 'Remote' } }] });
  assert.equal(store.get().models.find(model => model.modelId === 'c1').source, 'remote');
  assert.equal(store.get().models.find(model => model.modelId === 'c1').cachedStale, false);

  const edited = makeDraft();
  edited.dispatch({ type: 'merge-models', models: [{ modelId: 'c2', configSource: 'cache', effectiveValues: { name: 'Cached 2' } }] });
  edited.dispatch({ type: 'toggle-model', modelId: 'c2', selected: true });
  edited.dispatch({ type: 'model-field', modelId: 'c2', field: 'contextWindow', value: 1000 });
  edited.dispatch({ type: 'merge-models', models: [{ modelId: 'c2', configSource: 'remote', effectiveValues: { name: 'Remote 2' } }] });
  const kept = edited.get().models.find(model => model.modelId === 'c2');
  assert.equal(kept.source, 'cache', 'edited cache candidate is not overwritten by refresh');
  assert.equal(kept.contextWindow, 1000);
});

test('edit dialog shows matching cache candidates without network or selection changes', async () => {
  const { window, snapshot, api, calls } = boot();
  const service = snapshot.services[0];
  const originalSelection = Array.isArray(service.selectedModelIds)
    ? clone(Array.isArray(service.modelOrder) ? service.modelOrder : service.selectedModelIds) : null;
  api.fetchProviderServiceCache = async () => ({ ok: true, serviceId: service.serviceId, sourceKind: 'cache',
    cacheStale: false, cachedAt: Date.now(),
    cachedModels: [{ modelId: 'cached-a', providerId: service.providerId, configSource: 'cache', cacheStale: false,
      effectiveValues: { name: 'Cached A', contextWindow: 32000, maxTokens: 4096, toolCalling: null, streaming: null },
      editableOverrides: {} }] });
  const { card } = openCreate(window, snapshot, api, 'edit', service);
  const row = await uiWaitFor(() => card.querySelector('[data-model-row=cached-a]'));
  assert.ok(row, 'cached candidate rendered on open');
  assert.ok(row.textContent.includes('Cached A'));
  assert.ok(row.textContent.includes('缓存候选'));
  assert.ok(row.textContent.includes('上下文'), 'cache display metadata is shown');
  assert.ok(card.textContent.includes('显示匹配缓存'));
  assert.equal(calls.discovery.length, 0, 'cache display never triggers discovery');
  if (originalSelection) {
    assert.deepEqual([...card.querySelectorAll('[data-chosen-model]')].map(node => node.dataset.chosenModel), originalSelection,
      'cache must not change the existing selection');
  }
});

test('stale cache is explicitly marked and can be re-authorized', async () => {
  const snapshot = clone(fixture.live.snapshot);
  snapshot.capabilities.discoveryModes = ['none', 'environment'];
  const { window, api, calls } = boot({ snapshot });
  const service = snapshot.services[0];
  api.fetchProviderServiceCache = async () => ({ ok: true, serviceId: service.serviceId, sourceKind: 'cache',
    cacheStale: true, cachedAt: Date.now() - 120000,
    cachedModels: [{ modelId: 'stale-a', providerId: service.providerId, configSource: 'cache', cacheStale: true,
      effectiveValues: { name: 'Stale A', contextWindow: 64000 }, editableOverrides: {} }] });
  const { card } = openCreate(window, snapshot, api, 'edit', service);
  const row = await uiWaitFor(() => card.querySelector('[data-model-row=stale-a]'));
  assert.ok(row);
  assert.ok(row.textContent.includes('缓存已过期'));
  assert.ok(card.textContent.includes('显示已过期的匹配缓存'));
  assert.ok(card.querySelector('[data-authorize-discovery]'), 're-authorize entry remains available');
});

test('a late cache response after switching services never merges into the new draft', async () => {
  const { window, snapshot, api } = boot();
  const service = snapshot.services[0];
  let resolveCache = null;
  let requests = 0;
  api.fetchProviderServiceCache = () => {
    requests += 1;
    return new Promise(resolve => { resolveCache = resolve; });
  };
  const { card } = openCreate(window, snapshot, api, 'edit', service);
  await uiWaitFor(() => requests === 1, 2000);
  assert.equal(requests, 1, 'edit setup requests the service cache once');
  // 更换服务 → 开始新草稿 → 选择另一个服务；旧请求仍挂在服务 A 上。
  card.querySelector('.pm-change-service').click();
  await tick(5);
  const confirm = window.document.getElementById('confirmCard');
  [...confirm.querySelectorAll('button')].find(button => button.textContent === '开始新草稿').click();
  await tick(10);
  pick(window, card, 'deepseek');
  await tick(10);
  assert.ok(card.querySelector('.pm-service-chip-name')?.textContent.includes('DeepSeek'), 'new setup rendered');
  resolveCache({ ok: true, serviceId: service.serviceId, sourceKind: 'cache', cacheStale: false, cachedAt: Date.now(),
    cachedModels: [{ modelId: 'leaked-cache', providerId: service.providerId, configSource: 'cache', cacheStale: false,
      effectiveValues: { name: 'Leaked Model', contextWindow: 32000 }, editableOverrides: {} }] });
  await tick(50);
  assert.equal(card.querySelector('[data-model-row=leaked-cache]'), null, 'late cache from the previous service must be dropped');
  assert.ok(!card.textContent.includes('Leaked Model'));
  assert.ok(!card.textContent.includes('显示匹配缓存'));
});

test('a late cache response after changing the credential reference never merges into the same draft', async () => {
  const { window, snapshot, api } = boot();
  const service = snapshot.services[0];
  let resolveCache = null;
  let requests = 0;
  api.fetchProviderServiceCache = () => {
    requests += 1;
    return new Promise(resolve => { resolveCache = resolve; });
  };
  const { card } = openCreate(window, snapshot, api, 'edit', service);
  await uiWaitFor(() => requests === 1, 2000);
  const env = card.querySelector('.pm-env-input');
  assert.ok(env, 'edit setup exposes the env reference field');
  env.value = '$OTHER_KEY';
  env.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(10);
  resolveCache({ ok: true, serviceId: service.serviceId, sourceKind: 'cache', cacheStale: false, cachedAt: Date.now(),
    cachedModels: [{ modelId: 'target-leak', providerId: service.providerId, configSource: 'cache', cacheStale: false,
      effectiveValues: { name: 'Target Leak', contextWindow: 16000 }, editableOverrides: {} }] });
  await tick(50);
  assert.equal(card.querySelector('[data-model-row=target-leak]'), null, 'cache bound to the old credential generation must be dropped');
  assert.ok(!card.textContent.includes('Target Leak'));
});

test('removing a cache candidate does not resurrect it on the next draft save', async () => {
  const { window, snapshot, api, calls } = boot();
  const service = snapshot.services[0];
  const repeatedCache = [{ modelId: 'gone-a', providerId: service.providerId, configSource: 'cache', cacheStale: false,
    effectiveValues: { name: 'Gone A', contextWindow: 8000 }, editableOverrides: {} }];
  api.fetchProviderServiceCache = async () => ({ ok: true, serviceId: service.serviceId, sourceKind: 'cache',
    cacheStale: false, cachedAt: Date.now(), cachedModels: clone(repeatedCache) });
  api.saveProviderDraft = async request => {
    calls.drafts.push(clone(request));
    return { ok: true, draftId: 'resurrect-draft', draftRevision: 2, connectionRevision: 1, targetFingerprint: 'fp-resurrect',
      sourceKind: 'cache', cacheStale: false, cachedAt: Date.now(), cachedModels: clone(repeatedCache) };
  };
  const { card } = openCreate(window, snapshot, api, 'edit', service);
  await uiWaitFor(() => card.querySelector('[data-model-row=gone-a]'));
  card.querySelector('[data-model-check=gone-a]').click();
  await tick(5);
  card.querySelector('[data-model-remove=gone-a]').click();
  await tick(5);
  const confirm = window.document.getElementById('confirmCard');
  [...confirm.querySelectorAll('button')].find(button => button.textContent === '移除').click();
  await tick(10);
  assert.equal(card.querySelector('[data-model-row=gone-a]'), null);
  // 触发下一次草稿保存（保存按钮 → ensureDraftHandle），服务端再次返回同一缓存列表。
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(40);
  assert.equal(card.querySelector('[data-model-row=gone-a]'), null, 'removed candidate must not be resurrected');
});

test('changing the credential reference after removal does not resurrect the cache candidate on save', async () => {
  const { window, snapshot, api, calls } = boot();
  const service = snapshot.services[0];
  const repeatedCache = [{ modelId: 'gone-b', providerId: service.providerId, configSource: 'cache', cacheStale: false,
    effectiveValues: { name: 'Gone B', contextWindow: 8000 }, editableOverrides: {} }];
  api.fetchProviderServiceCache = async () => ({ ok: true, serviceId: service.serviceId, sourceKind: 'cache',
    cacheStale: false, cachedAt: Date.now(), cachedModels: clone(repeatedCache) });
  api.saveProviderDraft = async request => {
    calls.drafts.push(clone(request));
    return { ok: true, draftId: 'identity-draft', draftRevision: 2, connectionRevision: 1, targetFingerprint: 'fp-identity',
      sourceKind: 'cache', cacheStale: false, cachedAt: Date.now(), cachedModels: clone(repeatedCache) };
  };
  // 让 commit 失败，弹窗留在原地，检查保存响应合并后的可见状态。
  api.commitProviderDraft = async () => ({ ok: false, code: 'config_busy', message: 'fixture commit failure' });
  const { card } = openCreate(window, snapshot, api, 'edit', service);
  await uiWaitFor(() => card.querySelector('[data-model-row=gone-b]'));
  card.querySelector('[data-model-check=gone-b]').click();
  await tick(5);
  card.querySelector('[data-model-remove=gone-b]').click();
  await tick(5);
  const confirm = window.document.getElementById('confirmCard');
  [...confirm.querySelectorAll('button')].find(button => button.textContent === '移除').click();
  await tick(10);
  assert.equal(card.querySelector('[data-model-row=gone-b]'), null);
  // 改凭据引用会让缓存身份键变化；保存响应里的同一缓存列表不得复活已移除候选。
  const env = card.querySelector('.pm-env-input');
  env.value = '$OTHER_KEY';
  env.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(5);
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await tick(60);
  assert.equal(card.querySelector('[data-model-row=gone-b]'), null, 'identity change must not resurrect a removed candidate');
  assert.ok(!card.textContent.includes('Gone B'));
  const patches = calls.drafts.at(-1)?.draft?.modelPatches || [];
  assert.ok(patches.some(patch => patch.modelId === 'gone-b' && patch.operation === 'remove'),
    'the saved draft still carries the explicit removal');
});

for (const configSource of ['configured', 'builtin-override']) {
  test(`clearing an override on a ${configSource} model never shows the stale display fallback`, async () => {
    const { snapshot, service } = snapshotWithModel(configSource);
    const { window, api, calls } = boot({ snapshot });
    const { card } = openCreate(window, snapshot, api, 'edit', service);
    await tick(10);
    const row = () => card.querySelector('[data-model-row=cfg-model]');
    assert.ok(row(), 'configured model row rendered');
    assert.ok(row().textContent.includes('上下文'), 'override value is shown');
    card.querySelector('[data-model-advanced-toggle=cfg-model]').click();
    await tick(5);
    const input = card.querySelector('[data-model-field="cfg-model:contextWindow"]');
    assert.ok(input);
    input.value = '';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick(5);
    assert.equal(input.value, '');
    assert.ok(!row().textContent.includes('上下文'), 'cleared field must fall back to inherit/default, not the old display value');
    card.querySelector('.pm-dialog-actions .pm-primary').click();
    await tick(10);
    // builtin-override 来源会先弹「覆盖内置模型配置？」确认。
    const confirm = window.document.getElementById('confirmCard');
    const continueButton = [...confirm.querySelectorAll('button')].find(button => button.textContent === '继续保存');
    if (continueButton) continueButton.click();
    await tick(40);
    const payload = calls.drafts.at(-1)?.draft;
    const patch = payload?.modelPatches.find(item => item.modelId === 'cfg-model');
    assert.deepEqual(patch?.unsetFields, ['contextWindow'], 'save semantics stay an explicit unset');
  });
}

