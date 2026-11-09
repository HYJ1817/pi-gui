'use strict';

/* P5 前后端集成验收：真实模块 + jsdom。
 *
 * 覆盖：
 *   - 受限窗暂存 → apply-staged 保存；关闭/换目标撤销暂存；
 *   - 配置已保存但凭据失败/未确认：不自动重发，草稿转为 update；
 *   - 存储资格不足时禁止把暂存写入 auth.json；
 *   - 发现授权 → 202 → 轮询 → 候选合并 → 只保存用户选中的候选；
 *   - 目标变化/取消后迟到结果被丢弃；
 *   - P3-C /sync 202 轮询与逐 Runtime 事实展示；
 *   - 管理接口关闭时旧版编辑路径不受影响；OAuth 页面不出现密钥入口。
 *
 * 这里不碰真 pi、不写真实 auth.json；密钥只出现在假桥的调用记录里。 */

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
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

async function waitFor(check, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await tick(10);
  }
  return null;
}

function p5Snapshot(mutator = null) {
  const snapshot = clone(fixture.live.snapshot);
  Object.assign(snapshot.capabilities, {
    privateDesktopBridge: true,
    keyStaging: true,
    nativeCredentialPersistence: true,
    discoveryModes: ['none', 'environment', 'pi-credential'],
    syncMode: 'deferred',
  });
  snapshot.capabilities.reasons = {
    ...snapshot.capabilities.reasons,
    privateDesktopBridge: null,
    keyStaging: null,
    nativeCredentialPersistence: null,
    discoveryModes: null,
    syncMode: null,
  };
  mutator?.(snapshot);
  return snapshot;
}

/** 让快照里的第一个服务变成「无凭据、无认证」的服务，便于走本机凭据入口。
 *  返回给弹窗的 service 也是这份快照里的对象副本。 */
function plainService(snapshot, overrides = {}) {
  const service = snapshot.services[0];
  Object.assign(service, {
    credentialState: { state: 'none', source: 'none' },
    authMode: 'none',
    ...overrides,
  });
  return clone(service);
}

function fakeCredentialBridge({ behavior = 'staged' } = {}) {
  const listeners = new Set();
  const calls = { open: [], closeDraft: [], status: 0, cancel: 0 };
  const emit = update => { for (const listener of [...listeners]) listener(update); };
  return {
    calls,
    async status() {
      calls.status += 1;
      return { ok: true, open: false, hasFlow: false, nativeCredentialPersistence: true };
    },
    async open(request) {
      calls.open.push(clone(request));
      setTimeout(() => emit({ state: 'open', action: request.action }), 0);
      setTimeout(() => emit({ state: behavior, action: request.action }), 5);
      return { ok: true, state: { action: request.action } };
    },
    cancel() { calls.cancel += 1; },
    async closeDraft(request) {
      calls.closeDraft.push(clone(request));
      return { ok: true };
    },
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function dialogApi({ snapshot, commit, authorize, discover, operation } = {}) {
  const calls = { drafts: [], commits: [], authorize: [], revoke: [], discover: [], test: [], operations: [], cancels: [] };
  let revisions = 1;
  let discoverOperation = 0;
  let testOperation = 0;
  const api = {
    fetchProviderManagement: async () => clone(snapshot),
    saveProviderDraft: async request => {
      calls.drafts.push(clone(request));
      revisions += 1;
      const result = {
        ok: true,
        draftId: request.draftId || 'p5-draft',
        draftRevision: revisions,
        connectionRevision: 1,
        targetFingerprint: 'p5-target',
        credentialState: 'none',
        consentState: 'unapproved',
        cachedModels: [],
        sourceKind: 'none',
      };
      if (api.consent) {
        result.consentId = api.consent;
        result.consentExpiresAt = Date.now() + 60_000;
        result.consentState = 'authorized-idle';
      }
      return result;
    },
    commitProviderDraft: async request => {
      calls.commits.push(clone(request));
      return commit
        ? commit(request, calls)
        : { ok: true, serviceId: request.serviceId || 'example-ai', saved: true, credentialSaved: null,
          credentialState: 'saved', sync: { state: 'pending', reason: 'runtime_sync_pending' }, revision: 'config-rev-next' };
    },
    authorizeProviderDiscovery: async request => {
      calls.authorize.push(clone(request));
      return authorize ? authorize(request, calls) : { ok: false, code: 'unsupported' };
    },
    revokeProviderDiscovery: async request => { calls.revoke.push(clone(request)); return { ok: true, revoked: true }; },
    discoverProviderModels: async request => {
      calls.discover.push(clone(request));
      if (discover) return discover(request, calls);
      discoverOperation += 1;
      return { ok: true, operationId: `discover-op-${discoverOperation}` };
    },
    testProviderConnection: async request => {
      calls.test.push(clone(request));
      testOperation += 1;
      return { ok: true, operationId: `test-op-${testOperation}` };
    },
    fetchProviderOperation: async id => {
      calls.operations.push(id);
      return operation ? operation(id, calls) : { ok: false, code: 'not_found' };
    },
    cancelProviderOperation: async (id, body) => {
      calls.cancels.push({ id, body: clone(body) });
      return { ok: true };
    },
  };
  api.calls = calls;
  return api;
}

function dialogDom() {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:7788/' });
  const { window } = dom;
  // 订阅账户视图会读 Pi 认证状态；它不参与本文件的凭据断言，只给一个空快照。
  window.fetch = async () => ({
    status: 200,
    json: async () => ({ ok: true, capability: { sdkAvailable: false }, providers: [], flow: null, sync: { state: 'idle' } }),
  });
  window.eval(appBundle.code);
  return { dom, window };
}

function openDialog({ snapshot, api, bridge, service = snapshot.services[0] }) {
  const { dom, window } = dialogDom();

  if (bridge) window.piGuiDesktop = { providerCredentials: bridge };
  const saved = [];
  window.openProviderDialog({
    snapshot,
    api,
    mode: 'edit',
    service,
    onSaved: result => saved.push(result),
  });
  return { dom, window, saved, card: window.document.getElementById('modalCard') };
}

function findButton(card, text) {
  return [...card.querySelectorAll('button')].find(button => button.textContent === text) || null;
}

function confirmButton(window, text) {
  return [...window.document.getElementById('confirmCard').querySelectorAll('button')]
    .find(button => button.textContent === text) || null;
}

function openPage({ snapshot, management = null, legacyData = null, fetchImpl = null } = {}) {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:7788/' });
  const { window } = dom;
  const calls = { managementGets: [], sync: [], operations: [], legacy: [] };
  const legacy = clone(legacyData || {
    ok: true,
    path: 'C:\\fixture\\models.json',
    revision: 7,
    providers: { example: { models: [{ id: 'fast' }] } },
    keyStates: {},
  });
  const defaultFetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/api/provider-management')) {
      if (target.endsWith('/sync')) {
        calls.sync.push(JSON.parse(options.body));
        if (management) {
          return { status: 202, json: async () => ({ ok: true, operationId: 'sync-op-1', sync: { state: 'pending', reason: 'runtime_sync_pending' } }) };
        }
        // 服务端只读核验后，下一次快照会带上 applied 事实。
        snapshot.sync = { state: 'applied', reason: null, runtimes: [{ id: 'runtime-a', kind: 'runtime', state: 'applied', reason: null }] };
        return { status: 202, json: async () => ({ ok: true, operationId: 'sync-op-1',
          sync: { state: 'pending', reason: 'runtime_sync_pending', runtimes: [{ id: 'runtime-a', kind: 'runtime', state: 'pending', reason: 'runtime_sync_pending' }] } }) };
      }
      if (target.includes('/operations/')) {
        calls.operations.push(target);
        return { status: 200, json: async () => ({ ok: true, state: 'success',
          result: { sync: { state: 'applied', reason: null, runtimes: [{ id: 'runtime-a', kind: 'runtime', state: 'applied', reason: null }] } } }) };
      }
      calls.managementGets.push(target);
      if (management) return { status: management.status, json: async () => clone(management.body) };
      return { status: 200, json: async () => clone(snapshot) };
    }
    if (target.includes('/api/providers')) {
      calls.legacy.push(target);
      return { status: 200, json: async () => clone(legacy) };
    }
    if (target.includes('/api/restart')) return { status: 200, json: async () => ({ ok: true }) };
    if (target.includes('/api/provider-auth')) {
      return { status: 200, json: async () => ({ ok: true, capability: { sdkAvailable: false }, providers: [], flow: null, sync: { state: 'idle' } }) };
    }
    assert.fail(`unexpected fetch ${target}`);
  };
  window.fetch = fetchImpl || defaultFetch;
  window.eval(appBundle.code);
  window.openProvidersPanel();
  return { dom, window, calls };
}

/* ---------- 控制器：发现 ---------- */

test('discovery controller authorizes, polls a 202 operation, and merges remote candidates', async () => {
  const { createDiscoveryController } = await import('../public/provider-management/discovery.js');
  const calls = { authorize: [], discover: [], operations: [], cancels: [] };
  let merged = null;
  const api = {
    authorizeProviderDiscovery: async request => {
      calls.authorize.push(request);
      return { ok: true, consentId: 'consent-1', expiresAt: Date.now() + 60_000 };
    },
    discoverProviderModels: async request => {
      calls.discover.push(request);
      return { ok: true, operationId: 'op-1' };
    },
    fetchProviderOperation: async id => {
      calls.operations.push(id);
      const request = calls.discover.at(-1);
      return { ok: true, state: 'success', kind: 'discover', result: {
        models: [
          { modelId: 'remote-a', configSource: 'remote', effectiveValues: {} },
          { modelId: 'remote-b', configSource: 'remote', effectiveValues: {} },
        ],
        sourceKind: 'remote', dialogGeneration: request.dialogGeneration,
        requestSeq: request.requestSeq, connectionRevision: 1,
      } };
    },
    cancelProviderOperation: async id => { calls.cancels.push(id); return { ok: true }; },
  };
  const controller = createDiscoveryController({
    api, supported: true, debounceMs: 1, pollIntervalMs: 1, operationTimeoutMs: 2000,
    ensureDraft: async () => ({ ok: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1, targetFingerprint: 'fp-1' }),
    onModels: (models, meta) => { merged = { models, meta }; },
  });
  controller.configure({ supported: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1,
    targetFingerprint: 'fp-1', authMode: 'environment', modes: ['none', 'environment'] });
  await controller.authorize({ rememberTarget: false });
  assert.equal(calls.authorize.length, 1);
  assert.equal(calls.authorize[0].consentId, undefined, 'authorization must be issued by the server first');
  assert.equal(calls.discover.length, 1);
  assert.equal(calls.discover[0].consentId, 'consent-1');
  assert.equal(controller.getState().status, 'ready');
  assert.deepEqual(merged.models.map(model => model.modelId), ['remote-a', 'remote-b']);
  assert.equal(merged.meta.sourceKind, 'remote');
  controller.dispose();
});

test('discovery target change cancels the in-flight operation and drops its late result', async () => {
  const { createDiscoveryController } = await import('../public/provider-management/discovery.js');
  let releaseOperation = null;
  let resolveDiscover = null;
  const discoverCalled = new Promise(resolve => { resolveDiscover = resolve; });
  const calls = { discover: [], cancels: [] };
  let merged = null;
  const api = {
    authorizeProviderDiscovery: async () => ({ ok: true, consentId: 'consent-1', expiresAt: Date.now() + 60_000 }),
    discoverProviderModels: async request => {
      calls.discover.push(request);
      resolveDiscover();
      return { ok: true, operationId: 'op-late' };
    },
    fetchProviderOperation: async () => {
      await new Promise(resolve => { releaseOperation = resolve; });
      const request = calls.discover.at(-1);
      return { ok: true, state: 'success', result: {
        models: [{ modelId: 'late-model', configSource: 'remote' }], sourceKind: 'remote',
        dialogGeneration: request.dialogGeneration, requestSeq: request.requestSeq, connectionRevision: 1,
      } };
    },
    cancelProviderOperation: async id => { calls.cancels.push(id); return { ok: true }; },
  };
  const controller = createDiscoveryController({
    api, supported: true, debounceMs: 1, pollIntervalMs: 1, operationTimeoutMs: 2000,
    ensureDraft: async () => ({ ok: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1, targetFingerprint: 'fp-1' }),
    onModels: models => { merged = models; },
  });
  controller.configure({ supported: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1,
    targetFingerprint: 'fp-1', authMode: 'environment', modes: ['none', 'environment'] });
  // 授权后会自动发现一次；让这次操作卡在轮询里，再切换目标。
  const pending = controller.authorize({ rememberTarget: false });
  await discoverCalled;
  await waitFor(() => typeof releaseOperation === 'function');
  controller.configure({ supported: true, draftId: 'draft-2', draftRevision: 1, connectionRevision: 1,
    targetFingerprint: 'fp-2', authMode: 'environment', modes: ['none', 'environment'] });
  releaseOperation();
  await pending;
  await tick(20);
  assert.equal(merged, null, 'a result bound to the old target must not be merged');
  assert.deepEqual(controller.getState().models, []);
  assert.ok(calls.cancels.includes('op-late'));
  controller.dispose();
});

test('a desktop authorization handle without revision fields does not reset discovered models', async () => {
  const { createDiscoveryController } = await import('../public/provider-management/discovery.js');
  const api = {
    authorizeProviderDiscovery: async () => ({ ok: true, requiresDesktopConfirmation: true }),
    discoverProviderModels: async () => ({ ok: false, code: 'network_failed' }),
    cancelProviderOperation: async () => ({ ok: true }),
  };
  const controller = createDiscoveryController({
    api, supported: true, debounceMs: 1, pollIntervalMs: 1, operationTimeoutMs: 500,
    ensureDraft: async () => ({ ok: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1, targetFingerprint: 'fp-1' }),
    authorizeDesktop: async () => ({ ok: true, draftId: 'draft-1', draftRevision: 1, consentId: 'consent-desktop' }),
  });
  controller.configure({ supported: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1,
    targetFingerprint: 'fp-1', authMode: 'pi-credential', modes: ['none', 'environment', 'pi-credential'] });
  controller.configure({ supported: true, draftId: 'draft-1', draftRevision: 2, connectionRevision: 1,
    targetFingerprint: 'fp-1', authMode: 'pi-credential', modes: ['none', 'environment', 'pi-credential'],
    models: [{ modelId: 'keep-me', configSource: 'remote' }], source: 'remote' });
  assert.deepEqual(controller.getState().models.map(model => model.modelId), ['keep-me']);
  await controller.authorize({ rememberTarget: false });
  assert.equal(controller.getState().consentId, 'consent-desktop');
  assert.deepEqual(controller.getState().models.map(model => model.modelId), ['keep-me'],
    'a missing revision on the desktop handle must not be treated as a target change');
  controller.dispose();
});

/* ---------- 控制器：迟到的 202 必须被取消（FIX-02） ---------- */

test('a discover 202 that arrives after cancel is cancelled with a fresh request id', async () => {
  const { createDiscoveryController } = await import('../public/provider-management/discovery.js');
  const late = deferred();
  const calls = { discover: [], cancels: [], operations: [] };
  const api = {
    authorizeProviderDiscovery: async () => ({ ok: true, consentId: 'consent-1', expiresAt: Date.now() + 60_000 }),
    discoverProviderModels: request => { calls.discover.push(request); return late.promise; },
    fetchProviderOperation: async id => { calls.operations.push(id); return { ok: false, code: 'not_found' }; },
    cancelProviderOperation: async (id, body) => { calls.cancels.push({ id, body: clone(body) }); return { ok: true, state: 'cancelled' }; },
  };
  const controller = createDiscoveryController({
    api, supported: true, debounceMs: 1, pollIntervalMs: 1, operationTimeoutMs: 1000,
    ensureDraft: async () => ({ ok: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1, targetFingerprint: 'fp-1' }),
  });
  controller.configure({ supported: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1,
    targetFingerprint: 'fp-1', authMode: 'environment', modes: ['none', 'environment'] });
  const pending = controller.authorize({ rememberTarget: false });
  await waitFor(() => calls.discover.length === 1);
  controller.cancel();
  // 取消时还没有 operationId；202 在取消之后才返回。
  late.resolve({ ok: true, operationId: 'op-late-discover' });
  await pending;
  await waitFor(() => calls.cancels.some(call => call.id === 'op-late-discover'));
  const cancel = calls.cancels.find(call => call.id === 'op-late-discover');
  assert.ok(cancel.body.requestId, 'cancel must carry its own request id');
  assert.notEqual(cancel.body.requestId, calls.discover[0].requestId,
    'cancel must not replay the discover request id');
  assert.equal(controller.getState().models.length, 0);
  assert.equal(calls.operations.length, 0, 'a cancelled late 202 must never be polled');
  controller.dispose();
});

test('a test 202 that arrives after the discovery controller is disposed is cancelled', async () => {
  const { createDiscoveryController } = await import('../public/provider-management/discovery.js');
  const late = deferred();
  const calls = { test: [], cancels: [], operations: [] };
  const api = {
    authorizeProviderDiscovery: async () => ({ ok: true, consentId: 'consent-1', expiresAt: Date.now() + 60_000 }),
    discoverProviderModels: async () => ({ ok: true, operationId: 'op-discover' }),
    testProviderConnection: request => { calls.test.push(request); return late.promise; },
    fetchProviderOperation: async id => {
      calls.operations.push(id);
      return id === 'op-discover'
        ? { ok: true, state: 'success', result: { models: [], sourceKind: 'remote' } }
        : { ok: false, code: 'not_found' };
    },
    cancelProviderOperation: async (id, body) => { calls.cancels.push({ id, body: clone(body) }); return { ok: true, state: 'cancelled' }; },
  };
  const controller = createDiscoveryController({
    api, supported: true, debounceMs: 1, pollIntervalMs: 1, operationTimeoutMs: 1000,
    ensureDraft: async () => ({ ok: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1, targetFingerprint: 'fp-1' }),
  });
  controller.configure({ supported: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1,
    targetFingerprint: 'fp-1', authMode: 'environment', modes: ['none', 'environment'] });
  await controller.authorize({ rememberTarget: false });
  const pending = controller.test();
  await waitFor(() => calls.test.length === 1);
  controller.dispose();
  late.resolve({ ok: true, operationId: 'op-late-test' });
  await pending;
  await waitFor(() => calls.cancels.some(call => call.id === 'op-late-test'));
  assert.ok(calls.cancels.find(call => call.id === 'op-late-test').body.requestId);
  controller.dispose();
});

test('closing the dialog while a connection test is pending cancels the late 202', async () => {
  const snapshot = p5Snapshot();
  const api = dialogApi({
    snapshot,
    authorize: async () => ({ ok: true, consentId: 'consent-1', expiresAt: Date.now() + 60_000 }),
    operation: async () => ({ ok: true, state: 'success', result: { models: [], sourceKind: 'remote' } }),
  });
  const late = deferred();
  api.testProviderConnection = request => {
    api.calls.test.push(clone(request));
    return late.promise;
  };
  const { window, card } = openDialog({ snapshot, api });
  await waitFor(() => card.querySelector('[data-authorize-discovery]'));
  card.querySelector('[data-authorize-discovery]').click();
  const test = await waitFor(() => {
    const node = card.querySelector('[data-test-connection]');
    return node && node.disabled === false ? node : null;
  }, 6000);
  test.click();
  await waitFor(() => api.calls.test.length === 1);
  // 测试操作已提交、202 未返回时关闭弹窗。
  [...card.querySelectorAll('.pm-dialog-actions button')]
    .find(node => node.textContent === '取消').click();
  await tick(20);
  if (!window.document.getElementById('confirmLayer').hidden) confirmButton(window, '放弃更改').click();
  await waitFor(() => window.document.getElementById('modal').hidden === true);
  late.resolve({ ok: true, operationId: 'test-op-after-close' });
  await waitFor(() => api.calls.cancels.some(call => call.id === 'test-op-after-close'));
  const cancel = api.calls.cancels.find(call => call.id === 'test-op-after-close');
  assert.ok(cancel.body.requestId, 'the late test 202 cancel must carry its own request id');
  assert.notEqual(cancel.body.requestId, api.calls.test[0].requestId);
  assert.ok(!api.calls.operations.includes('test-op-after-close'),
    'a cancelled late test 202 must never be polled after the dialog closes');
});

test('revoking discovery authorization while a test request is pending cancels the late 202', async () => {
  const { createDiscoveryController } = await import('../public/provider-management/discovery.js');
  const late = deferred();
  const calls = { test: [], cancels: [], revokes: [] };
  const api = {
    authorizeProviderDiscovery: async () => ({ ok: true, consentId: 'consent-1', expiresAt: Date.now() + 60_000 }),
    discoverProviderModels: async () => ({ ok: true, operationId: 'op-discover' }),
    testProviderConnection: request => { calls.test.push(request); return late.promise; },
    fetchProviderOperation: async id => (id === 'op-discover'
      ? { ok: true, state: 'success', result: { models: [], sourceKind: 'remote' } }
      : { ok: false, code: 'not_found' }),
    revokeProviderDiscovery: async request => { calls.revokes.push(clone(request)); return { ok: true, revoked: true }; },
    cancelProviderOperation: async (id, body) => { calls.cancels.push({ id, body: clone(body) }); return { ok: true, state: 'cancelled' }; },
  };
  const controller = createDiscoveryController({
    api, supported: true, debounceMs: 1, pollIntervalMs: 1, operationTimeoutMs: 1000,
    ensureDraft: async () => ({ ok: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1, targetFingerprint: 'fp-1' }),
  });
  controller.configure({ supported: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1,
    targetFingerprint: 'fp-1', authMode: 'environment', modes: ['none', 'environment'] });
  await controller.authorize({ rememberTarget: false });
  const pending = controller.test();
  await waitFor(() => calls.test.length === 1);
  await controller.revoke();
  assert.equal(calls.revokes.length, 1, 'the user-facing revoke must reach the backend');
  assert.equal(controller.getState().test.status, 'idle', 'revoking must not leave a stale running test state');
  late.resolve({ ok: true, operationId: 'op-late-test-after-revoke' });
  await pending;
  await waitFor(() => calls.cancels.some(call => call.id === 'op-late-test-after-revoke'));
  const cancel = calls.cancels.find(call => call.id === 'op-late-test-after-revoke');
  assert.ok(cancel.body.requestId, 'the late 202 cancel must carry a fresh request id');
  assert.notEqual(cancel.body.requestId, calls.test[0].requestId);
  controller.dispose();
});

test('changing the authentication source while a test request is pending cancels the late 202', async () => {
  const { createDiscoveryController } = await import('../public/provider-management/discovery.js');
  const late = deferred();
  const calls = { test: [], cancels: [] };
  const api = {
    authorizeProviderDiscovery: async () => ({ ok: true, consentId: 'consent-1', expiresAt: Date.now() + 60_000 }),
    discoverProviderModels: async () => ({ ok: true, operationId: 'op-discover' }),
    testProviderConnection: request => { calls.test.push(request); return late.promise; },
    fetchProviderOperation: async id => (id === 'op-discover'
      ? { ok: true, state: 'success', result: { models: [], sourceKind: 'remote' } }
      : { ok: false, code: 'not_found' }),
    cancelProviderOperation: async (id, body) => { calls.cancels.push({ id, body: clone(body) }); return { ok: true, state: 'cancelled' }; },
  };
  const controller = createDiscoveryController({
    api, supported: true, debounceMs: 1, pollIntervalMs: 1, operationTimeoutMs: 1000,
    ensureDraft: async () => ({ ok: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1, targetFingerprint: 'fp-1' }),
  });
  controller.configure({ supported: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1,
    targetFingerprint: 'fp-1', authMode: 'environment', modes: ['none', 'environment'] });
  await controller.authorize({ rememberTarget: false });
  const pending = controller.test();
  await waitFor(() => calls.test.length === 1);
  controller.configure({ supported: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1,
    targetFingerprint: 'fp-1', authMode: 'none', modes: ['none', 'environment'] });
  late.resolve({ ok: true, operationId: 'op-late-test-after-auth-change' });
  await pending;
  await waitFor(() => calls.cancels.some(call => call.id === 'op-late-test-after-auth-change'));
  assert.equal(controller.getState().test.status, 'idle');
  controller.dispose();
});

test('a new discovery during a pending connection test cancels the test and clears its running state', async () => {
  const { createDiscoveryController } = await import('../public/provider-management/discovery.js');
  const lateTest = deferred();
  let discoverCount = 0;
  let merged = null;
  const calls = { discovers: [], tests: [], operations: [], cancels: [] };
  const api = {
    authorizeProviderDiscovery: async () => ({ ok: true, consentId: 'consent-1', expiresAt: Date.now() + 60_000 }),
    discoverProviderModels: async request => {
      calls.discovers.push(request);
      discoverCount += 1;
      return { ok: true, operationId: discoverCount === 1 ? 'op-discover-initial' : 'op-discover-new' };
    },
    testProviderConnection: request => { calls.tests.push(request); return lateTest.promise; },
    fetchProviderOperation: async id => {
      calls.operations.push(id);
      const request = calls.discovers.at(-1);
      return { ok: true, state: 'success', result: {
        models: id === 'op-discover-new' ? [{ modelId: 'fresh-after-test', configSource: 'remote' }] : [],
        sourceKind: 'remote', dialogGeneration: request.dialogGeneration,
        requestSeq: request.requestSeq, connectionRevision: request.connectionRevision,
      } };
    },
    cancelProviderOperation: async (id, body) => { calls.cancels.push({ id, body: clone(body) }); return { ok: true, state: 'cancelled' }; },
  };
  const controller = createDiscoveryController({
    api, supported: true, debounceMs: 1, pollIntervalMs: 1, operationTimeoutMs: 1000,
    ensureDraft: async () => ({ ok: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1, targetFingerprint: 'fp-1' }),
    onModels: models => { merged = models; },
  });
  controller.configure({ supported: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1,
    targetFingerprint: 'fp-1', authMode: 'environment', modes: ['none', 'environment'] });
  await controller.authorize({ rememberTarget: false });
  const pendingTest = controller.test();
  await waitFor(() => calls.tests.length === 1);
  assert.equal(controller.getState().test.status, 'running');
  await controller.refresh({ force: true, immediate: true });
  assert.equal(controller.getState().test.status, 'idle', 'the superseded test must not stay running');
  lateTest.resolve({ ok: true, operationId: 'op-late-test-after-discover' });
  await pendingTest;
  await waitFor(() => calls.cancels.some(call => call.id === 'op-late-test-after-discover'));
  assert.deepEqual(calls.operations.filter(id => id === 'op-late-test-after-discover'), [],
    'the late test 202 must never be polled');
  assert.deepEqual(merged.map(model => model.modelId), ['fresh-after-test'],
    'the new discovery result must remain authoritative');
  controller.dispose();
});

test('cancel followed immediately by a new discovery isolates the old late operation', async () => {
  const { createDiscoveryController } = await import('../public/provider-management/discovery.js');
  const first = deferred();
  let discoverCount = 0;
  let merged = null;
  const calls = { cancels: [], operations: [], discovers: [] };
  const api = {
    authorizeProviderDiscovery: async () => ({ ok: true, consentId: 'consent-1', expiresAt: Date.now() + 60_000 }),
    discoverProviderModels: request => {
      calls.discovers.push(request);
      discoverCount += 1;
      return discoverCount === 1 ? first.promise : Promise.resolve({ ok: true, operationId: 'op-new' });
    },
    fetchProviderOperation: async id => {
      calls.operations.push(id);
      const request = calls.discovers.at(-1);
      return { ok: true, state: 'success', result: {
        models: [{ modelId: 'new-model', configSource: 'remote' }], sourceKind: 'remote',
        dialogGeneration: request.dialogGeneration, requestSeq: request.requestSeq,
        connectionRevision: request.connectionRevision,
      } };
    },
    cancelProviderOperation: async (id, body) => { calls.cancels.push({ id, body: clone(body) }); return { ok: true, state: 'cancelled' }; },
  };
  const controller = createDiscoveryController({
    api, supported: true, debounceMs: 1, pollIntervalMs: 1, operationTimeoutMs: 1000,
    ensureDraft: async () => ({ ok: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1, targetFingerprint: 'fp-1' }),
    onModels: models => { merged = models; },
  });
  controller.configure({ supported: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1,
    targetFingerprint: 'fp-1', authMode: 'environment', modes: ['none', 'environment'] });
  const firstRun = controller.authorize({ rememberTarget: false });
  await waitFor(() => calls.discovers.length === 1);
  controller.cancel();
  const secondRun = controller.refresh({ force: true, immediate: true });
  first.resolve({ ok: true, operationId: 'op-late-old' });
  await firstRun;
  await secondRun;
  await waitFor(() => calls.cancels.some(call => call.id === 'op-late-old'));
  assert.ok(!calls.cancels.some(call => call.id === 'op-new'), 'the new operation must not be cancelled');
  assert.deepEqual(calls.operations, ['op-new'], 'only the new operation may be polled');
  assert.deepEqual(merged.map(model => model.modelId), ['new-model'],
    'the late old operation must not overwrite the new candidate list');
  controller.dispose();
});

test('cancelling after the 202 cancels the running operation and drops its late result', async () => {
  const { createDiscoveryController } = await import('../public/provider-management/discovery.js');
  let releasePoll = null;
  let pollStarted = null;
  const started = new Promise(resolve => { pollStarted = resolve; });
  const calls = { cancels: [], operations: [] };
  let merged = null;
  const api = {
    authorizeProviderDiscovery: async () => ({ ok: true, consentId: 'consent-1', expiresAt: Date.now() + 60_000 }),
    discoverProviderModels: async () => ({ ok: true, operationId: 'op-running' }),
    fetchProviderOperation: async id => {
      calls.operations.push(id);
      pollStarted();
      await new Promise(resolve => { releasePoll = resolve; });
      return { ok: true, state: 'success', result: { models: [{ modelId: 'late-model', configSource: 'remote' }], sourceKind: 'remote' } };
    },
    cancelProviderOperation: async (id, body) => { calls.cancels.push({ id, body: clone(body) }); return { ok: true, state: 'cancelled' }; },
  };
  const controller = createDiscoveryController({
    api, supported: true, debounceMs: 1, pollIntervalMs: 1, operationTimeoutMs: 2000,
    ensureDraft: async () => ({ ok: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1, targetFingerprint: 'fp-1' }),
    onModels: models => { merged = models; },
  });
  controller.configure({ supported: true, draftId: 'draft-1', draftRevision: 1, connectionRevision: 1,
    targetFingerprint: 'fp-1', authMode: 'environment', modes: ['none', 'environment'] });
  const pending = controller.authorize({ rememberTarget: false });
  await started;
  controller.cancel();
  releasePoll();
  await pending;
  await waitFor(() => calls.cancels.some(call => call.id === 'op-running'));
  assert.equal(merged, null, 'a cancelled operation result must not be merged');
  assert.equal(controller.getState().models.length, 0);
  controller.dispose();
});

/* ---------- 控制器：同步 ---------- */

test('sync controller reports applied only from P3-C facts and never auto-retries', async () => {
  const { createSyncController } = await import('../public/provider-management/sync.js');
  let polls = 0;
  let syncCalls = 0;
  const api = {
    syncProviderConfiguration: async () => { syncCalls += 1; return { ok: true, operationId: 'sync-1',
      sync: { state: 'pending', reason: 'runtime_sync_pending', runtimes: [{ id: 'a', kind: 'runtime', state: 'pending', reason: 'runtime_sync_pending' }] } }; },
    fetchProviderOperation: async () => (++polls < 2
      ? { ok: true, state: 'pending' }
      : { ok: true, state: 'success', result: { sync: { state: 'applied', reason: null,
        runtimes: [{ id: 'a', kind: 'runtime', state: 'applied', reason: null }] } } }),
  };
  const controller = createSyncController({ api, pollIntervalMs: 1, operationTimeoutMs: 2000 });
  const state = await controller.verify({ revision: 'rev-1' });
  assert.equal(state.state, 'success');
  assert.equal(state.sync.state, 'applied');
  assert.equal(state.sync.runtimes[0].state, 'applied');
  // 只有一次 /sync 写入；轮询不会重复发起核验。
  assert.equal(syncCalls, 1);
  assert.equal(polls, 2);
  controller.dispose();
});

test('late sync results cannot overwrite a new snapshot generation', async () => {
  const { createSyncController } = await import('../public/provider-management/sync.js');
  let release = null;
  let fetched = null;
  const fetchedOnce = new Promise(resolve => { fetched = resolve; });
  const api = {
    syncProviderConfiguration: async () => ({ ok: true, operationId: 'sync-late',
      sync: { state: 'pending', reason: 'runtime_sync_pending' } }),
    fetchProviderOperation: async () => {
      fetched();
      await new Promise(resolve => { release = resolve; });
      return { ok: true, state: 'success', result: { sync: { state: 'error', reason: 'runtime_readback_failed' } } };
    },
  };
  const controller = createSyncController({ api, pollIntervalMs: 1, operationTimeoutMs: 2000 });
  const pending = controller.verify({ revision: 'rev-1' });
  await waitFor(() => typeof release === 'function');
  await fetchedOnce;
  controller.applySnapshot({ state: 'applied', reason: null, runtimes: [{ id: 'a', kind: 'runtime', state: 'applied' }] });
  release();
  await pending;
  await tick(20);
  const state = controller.getState();
  assert.equal(state.sync.state, 'applied', 'the new snapshot must win over the old operation');
  assert.equal(state.state, 'idle');
  controller.dispose();
});

/* ---------- 弹窗：凭据 ---------- */

test('a failed credential sheet load settles the open wait with an actionable reason', async () => {
  const { createCredentialController } = await import('../public/provider-management/credentials.js');
  const listeners = new Set();
  const bridge = {
    async status() { return { ok: true, hasFlow: false }; },
    async open() {
      setTimeout(() => { for (const listener of [...listeners]) listener({ state: 'load_failed' }); }, 5);
      return { ok: true, state: { action: 'set' } };
    },
    cancel() {},
    onState(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const controller = createCredentialController({ bridge, waitTimeoutMs: 1000 });
  const result = await controller.open({ draftId: 'draft-1', draftRevision: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'load_failed');
  assert.ok(result.reason.includes('加载失败'));
  assert.equal(result.cancelled, false, 'a load failure is not a user cancellation');
  controller.dispose();
});

test('a staged key is committed through apply-staged and closes only on a confirmed save', async () => {
  const snapshot = p5Snapshot();
  const service = plainService(snapshot);
  const bridge = fakeCredentialBridge();
  const api = dialogApi({ snapshot, commit: async request => ({
    ok: true, serviceId: request.serviceId || service.serviceId, saved: true,
    credentialSaved: true, credentialState: 'saved', sync: { state: 'pending', reason: 'runtime_sync_pending' }, revision: 'config-rev-2',
  }) });
  const { window, card, saved } = openDialog({ snapshot, api, bridge, service });
  const trigger = await waitFor(() => {
    const node = card.querySelector('[data-credential-trigger]');
    return node && node.disabled === false ? node : null;
  });
  assert.ok(trigger, 'the credential trigger must be enabled once the bridge is qualified');
  assert.equal(card.querySelectorAll('input[type=password]').length, 0);
  trigger.click();
  await waitFor(() => bridge.calls.open.length === 1);
  await waitFor(() => card.querySelector('.pm-credential-status')?.textContent.includes('新密钥已暂存'));
  assert.equal(bridge.calls.open[0].action, 'set');
  assert.deepEqual(Object.keys(bridge.calls.open[0]).sort(), ['action', 'draftId', 'draftRevision'],
    'the page only asks the sheet to open; it never receives or forwards a key');
  assert.equal(card.querySelector('.pm-credential-status').textContent, '新密钥已暂存；保存时写入 Pi 本机凭据槽');
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await waitFor(() => api.calls.commits.length === 1);
  assert.deepEqual(api.calls.commits[0].credentialAction, { type: 'apply-staged' });
  assert.equal(api.calls.commits[0].action, 'update');
  assert.equal(api.calls.commits[0].serviceId, 'example-ai');
  await waitFor(() => window.document.getElementById('modal').hidden === true);
  assert.equal(saved.length, 1);
  assert.ok(!('apiKey' in api.calls.commits[0]) && !('secret' in api.calls.commits[0]));
});

test('config saved with an unconfirmed credential keeps the draft, blocks auto retry, and retries as update', async () => {
  const snapshot = p5Snapshot();
  const service = plainService(snapshot);
  const bridge = fakeCredentialBridge();
  let commits = 0;
  const api = dialogApi({ snapshot, commit: async request => {
    commits += 1;
    if (commits === 1) {
      return { ok: false, saved: true, serviceId: request.serviceId || 'example-ai', credentialSaved: null,
        credentialState: 'credential-unconfirmed', code: 'credential_unconfirmed',
        message: '配置已保存，凭据结果待确认。', revision: 'config-rev-2', sync: { state: 'idle', reason: null } };
    }
    return { ok: true, saved: true, serviceId: 'example-ai', credentialSaved: true, credentialState: 'saved',
      sync: { state: 'pending', reason: 'runtime_sync_pending' }, revision: 'config-rev-3' };
  } });
  const { window, card } = openDialog({ snapshot, api, bridge, service });
  const trigger = await waitFor(() => {
    const node = card.querySelector('[data-credential-trigger]');
    return node && node.disabled === false ? node : null;
  });
  trigger.click();
  await waitFor(() => card.querySelector('.pm-credential-status')?.textContent.includes('新密钥已暂存'));
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await waitFor(() => card.querySelector('.pm-status-banner')?.textContent.includes('配置已保存，凭据结果待确认'));
  assert.equal(window.document.getElementById('modal').hidden, false, 'the dialog must stay open');
  assert.equal(api.calls.commits.length, 1);
  // 不做任何操作，确认不会自动重发。
  await tick(80);
  assert.equal(api.calls.commits.length, 1, 'an unconfirmed credential must never be written automatically');
  // 重新读取状态仍是未确认（快照没有凭据证据）。
  findButton(card, '重新读取状态').click();
  await waitFor(() => card.querySelector('.pm-status-banner')?.textContent.includes('凭据结果仍未确认'));
  assert.equal(api.calls.commits.length, 1);
  // 明确重新配置并再次保存：commit 必须变成 update，并重新走 apply-staged。
  findButton(card, '重新配置凭据').click();
  await waitFor(() => bridge.calls.open.length === 2);
  await waitFor(() => card.querySelector('.pm-credential-status')?.textContent.includes('新密钥已暂存'));
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await waitFor(() => api.calls.commits.length === 2);
  assert.equal(api.calls.commits[1].action, 'update');
  assert.equal(api.calls.commits[1].serviceId, 'example-ai');
  assert.deepEqual(api.calls.commits[1].credentialAction, { type: 'apply-staged' });
  assert.equal(api.calls.drafts.at(-1).serviceId, 'example-ai');
});

test('a failed native clear is not reported as a successful save just because old credentials remain', async () => {
  const snapshot = p5Snapshot();
  const service = plainService(snapshot);
  // 服务原本有 Pi 本机凭据；清除失败后 auth.json 仍是这份旧凭据。
  for (const target of [service, snapshot.services[0]]) {
    Object.assign(target, {
      credentialState: { state: 'saved', source: 'pi-credential' },
      authMode: 'pi-credential',
    });
  }
  const bridge = fakeCredentialBridge();
  const api = dialogApi({ snapshot, commit: async request => ({
    ok: false, saved: true, serviceId: request.serviceId || 'example-ai',
    credentialSaved: false, credentialState: 'saved-credential-error',
    code: 'native_write_failed', message: '配置已保存，凭据保存失败。',
    revision: 'config-rev-2', sync: { state: 'idle', reason: null },
  }) });
  const { window, card } = openDialog({ snapshot, api, bridge, service });
  const clear = await waitFor(() => {
    const node = card.querySelector('.pm-clear-credential');
    return node && node.disabled === false ? node : null;
  });
  assert.equal(clear.textContent, '清除本机凭据');
  clear.click();
  await waitFor(() => window.document.getElementById('confirmLayer').hidden === false);
  confirmButton(window, '打开安全窗口确认清除').click();
  await waitFor(() => bridge.calls.open.length === 1);
  assert.equal(bridge.calls.open[0].action, 'clear');
  await waitFor(() => card.querySelector('.pm-credential-status')?.textContent.includes('已暂存清除'));
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  const bannerText = () => card.querySelector('.pm-status-banner')?.textContent || '';
  await waitFor(() => bannerText().includes('配置已保存，但凭据清除失败'));
  assert.ok(bannerText().includes('本次清除没有完成'), 'the still-saved old credential must be described as an unfinished clear');
  assert.ok(!card.textContent.includes('配置与凭据均已保存'), 'a failed clear must never be presented as credential success');
  assert.ok(![...card.querySelectorAll('.pm-status-banner')].some(node => /已暂存|已放弃暂存/.test(node.textContent)),
    'the stale staged banner must not survive a failed save');
  findButton(card, '重新读取状态').click();
  await waitFor(() => bannerText().includes('没有凭据写入成功的回执'));
  assert.ok(bannerText().includes('本次清除没有完成'), 'a freshly read old credential still must not confirm the clear');
  findButton(card, '重新清除凭据').click();
  await waitFor(() => window.document.getElementById('confirmLayer').hidden === false);
  confirmButton(window, '打开安全窗口确认清除').click();
  await waitFor(() => bridge.calls.open.length === 2);
  assert.equal(bridge.calls.open[1].action, 'clear', 'the retry must reopen the native clear flow');
});

test('storage qualification blocks native persistence, and discarding revokes the staged draft', async () => {
  const snapshot = p5Snapshot(value => { value.capabilities.nativeCredentialPersistence = false; });
  const service = plainService(snapshot);
  const bridge = fakeCredentialBridge();
  const api = dialogApi({ snapshot });
  const { window, card } = openDialog({ snapshot, api, bridge, service });
  const trigger = await waitFor(() => {
    const node = card.querySelector('[data-credential-trigger]');
    return node && node.disabled === false ? node : null;
  });
  trigger.click();
  await waitFor(() => card.querySelector('.pm-credential-status')?.textContent.includes('新密钥已暂存'));
  assert.ok(card.querySelector('#pmCredentialNote').textContent.includes('不会写入 auth.json'));
  assert.ok(card.querySelector('.pm-credential-status').textContent.includes('保存时不会写入 auth.json'),
    'the staged status must not promise a write that save will refuse');
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await waitFor(() => card.querySelector('.pm-status-banner')?.textContent.includes('无法保存本机凭据'));
  assert.equal(api.calls.commits.length, 0, 'an unqualified native store must never commit config with apply-staged');
  findButton(card, '放弃暂存').click();
  await waitFor(() => window.document.getElementById('confirmLayer').hidden === false);
  confirmButton(window, '放弃暂存').click();
  await waitFor(() => bridge.calls.closeDraft.length === 1);
  assert.equal(bridge.calls.closeDraft[0].draftId, 'p5-draft');
  await waitFor(() => !card.querySelector('.pm-discard-stage'));
  assert.equal(card.querySelector('.pm-credential-status').textContent, '未配置凭据');
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await waitFor(() => api.calls.commits.length === 1);
  assert.deepEqual(api.calls.commits[0].credentialAction, { type: 'keep' });
});

test('discarding a staged key forgets the deleted draft before the next save', async () => {
  const snapshot = p5Snapshot();
  const service = plainService(snapshot);
  const bridge = fakeCredentialBridge();
  const api = dialogApi({ snapshot });
  const { window, card } = openDialog({ snapshot, api, bridge, service });
  const trigger = await waitFor(() => {
    const node = card.querySelector('[data-credential-trigger]');
    return node && node.disabled === false ? node : null;
  });
  trigger.click();
  await waitFor(() => card.querySelector('.pm-credential-status')?.textContent.includes('新密钥已暂存'));
  const before = api.calls.drafts.length;
  findButton(card, '放弃暂存').click();
  await waitFor(() => window.document.getElementById('confirmLayer').hidden === false);
  confirmButton(window, '放弃暂存').click();
  await waitFor(() => bridge.calls.closeDraft.length === 1);
  await waitFor(() => !card.querySelector('.pm-discard-stage'));
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await waitFor(() => api.calls.drafts.length === before + 1);
  const nextDraft = api.calls.drafts.at(-1);
  assert.equal(nextDraft.draftId, undefined, 'close-draft deleted the server draft; its id must not be reused');
  assert.ok(nextDraft.requestId, 'the new draft must rotate its request id');
  await waitFor(() => api.calls.commits.length === 1);
});

test('cancelling the restricted window leaves no staged state and no commit', async () => {
  const snapshot = p5Snapshot();
  const service = plainService(snapshot);
  const bridge = fakeCredentialBridge({ behavior: 'cancelled' });
  const api = dialogApi({ snapshot });
  const { window, card } = openDialog({ snapshot, api, bridge, service });
  const trigger = await waitFor(() => {
    const node = card.querySelector('[data-credential-trigger]');
    return node && node.disabled === false ? node : null;
  });
  trigger.click();
  await waitFor(() => bridge.calls.open.length === 1);
  await tick(30);
  assert.equal(card.querySelector('.pm-credential-status').textContent, '未配置凭据');
  assert.equal(card.querySelector('.pm-discard-stage'), null);
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await waitFor(() => api.calls.commits.length === 1);
  assert.deepEqual(api.calls.commits[0].credentialAction, { type: 'keep' });
  assert.equal(window.document.getElementById('modal').hidden, true);
});

test('closing the dialog revokes the staged draft', async () => {
  const snapshot = p5Snapshot();
  const service = plainService(snapshot);
  const bridge = fakeCredentialBridge();
  const api = dialogApi({ snapshot });
  const { window, card } = openDialog({ snapshot, api, bridge, service });
  const trigger = await waitFor(() => {
    const node = card.querySelector('[data-credential-trigger]');
    return node && node.disabled === false ? node : null;
  });
  trigger.click();
  await waitFor(() => card.querySelector('.pm-credential-status')?.textContent.includes('新密钥已暂存'));
  findButton(card, '取消').click();
  await waitFor(() => window.document.getElementById('confirmLayer').hidden === false);
  confirmButton(window, '放弃更改').click();
  await waitFor(() => bridge.calls.closeDraft.length === 1);
  assert.equal(bridge.calls.closeDraft[0].draftId, 'p5-draft');
  await waitFor(() => window.document.getElementById('modal').hidden === true);
  assert.equal(api.calls.commits.length, 0);
});

test('changing the authentication target discards the staged approval', async () => {
  const snapshot = p5Snapshot();
  const service = plainService(snapshot);
  const bridge = fakeCredentialBridge();
  const api = dialogApi({ snapshot });
  const { window, card } = openDialog({ snapshot, api, bridge, service });
  const trigger = await waitFor(() => {
    const node = card.querySelector('[data-credential-trigger]');
    return node && node.disabled === false ? node : null;
  });
  trigger.click();
  await waitFor(() => card.querySelector('.pm-credential-status')?.textContent.includes('新密钥已暂存'));
  const env = card.querySelector('.pm-env-input');
  env.value = '$OTHER_KEY';
  env.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => bridge.calls.closeDraft.length === 1);
  assert.equal(bridge.calls.closeDraft[0].draftId, 'p5-draft');
  await waitFor(() => card.querySelector('.pm-credential-status')?.textContent === '未配置凭据');
  assert.equal(card.querySelector('.pm-discard-stage'), null);
  assert.ok(card.querySelector('.pm-status-banner')?.textContent.includes('已放弃暂存凭据'));
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await waitFor(() => api.calls.commits.length === 1);
  assert.deepEqual(api.calls.commits[0].credentialAction, { type: 'env', reference: '$OTHER_KEY' });
  assert.equal(api.calls.commits[0].action, 'update');
});

test('a commit conflict revokes the stale staged draft before retry', async () => {
  const snapshot = p5Snapshot();
  const service = plainService(snapshot);
  const bridge = fakeCredentialBridge();
  const api = dialogApi({ snapshot, commit: async () => ({ ok: false, code: 'config_conflict',
    message: '供应商配置已变化，请重读后保存。' }) });
  const { card } = openDialog({ snapshot, api, bridge, service });
  const trigger = await waitFor(() => {
    const node = card.querySelector('[data-credential-trigger]');
    return node && node.disabled === false ? node : null;
  });
  trigger.click();
  await waitFor(() => card.querySelector('.pm-credential-status')?.textContent.includes('新密钥已暂存'));
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await waitFor(() => bridge.calls.closeDraft.length === 1);
  assert.equal(bridge.calls.closeDraft[0].draftId, 'p5-draft');
  await waitFor(() => card.querySelector('.pm-credential-status')?.textContent === '未配置凭据');
  assert.equal(card.querySelector('.pm-discard-stage'), null, 'the stale stage must disappear from the UI');
  const banner = card.querySelector('.pm-status-banner');
  assert.ok(banner && banner.textContent.includes('配置'), 'the conflict must stay visible after discarding the stale stage');
});

/* ---------- 弹窗：凭据窗口的异步生命周期（FIX-01） ---------- */

test('closing the dialog while the draft request is pending never opens the credential window', async () => {
  const snapshot = p5Snapshot();
  const service = plainService(snapshot);
  const bridge = fakeCredentialBridge();
  const api = dialogApi({ snapshot });
  const late = deferred();
  api.saveProviderDraft = request => {
    api.calls.drafts.push(clone(request));
    return late.promise;
  };
  const { window, card } = openDialog({ snapshot, api, bridge, service });
  const trigger = await waitFor(() => {
    const node = card.querySelector('[data-credential-trigger]');
    return node && node.disabled === false ? node : null;
  });
  trigger.click();
  await waitFor(() => api.calls.drafts.length === 1);
  findButton(card, '取消').click();
  await waitFor(() => window.document.getElementById('confirmLayer').hidden === false);
  confirmButton(window, '放弃更改').click();
  await waitFor(() => window.document.getElementById('modal').hidden === true);
  // 草稿保存请求在弹窗关闭之后才返回：它只能被清理，不能打开受限窗。
  late.resolve({ ok: true, draftId: 'late-after-close', draftRevision: 2, connectionRevision: 1,
    targetFingerprint: 'p5-target', credentialState: 'none', consentState: 'unapproved',
    cachedModels: [], sourceKind: 'none' });
  await waitFor(() => bridge.calls.closeDraft.some(call => call.draftId === 'late-after-close'));
  await tick(30);
  assert.equal(bridge.calls.open.length, 0, 'a closed dialog must never open the restricted window');
  assert.equal(api.calls.commits.length, 0);
});

test('changing the authentication target while the draft request is pending cannot revive the old handle', async () => {
  const snapshot = p5Snapshot();
  const service = plainService(snapshot);
  const bridge = fakeCredentialBridge();
  const api = dialogApi({ snapshot });
  const saveDraft = api.saveProviderDraft;
  const late = deferred();
  let first = true;
  api.saveProviderDraft = request => {
    if (!first) return saveDraft(request);
    first = false;
    api.calls.drafts.push(clone(request));
    return late.promise;
  };
  const { card } = openDialog({ snapshot, api, bridge, service });
  const trigger = await waitFor(() => {
    const node = card.querySelector('[data-credential-trigger]');
    return node && node.disabled === false ? node : null;
  });
  trigger.click();
  await waitFor(() => api.calls.drafts.length === 1);
  // 认证来源属于凭据目标的一部分；修改它必须让旧草稿响应过期。
  const env = await waitFor(() => card.querySelector('.pm-env-input'));
  env.value = '$OTHER_KEY';
  env.dispatchEvent(new card.ownerDocument.defaultView.Event('input', { bubbles: true }));
  late.resolve({ ok: true, draftId: 'late-old-target', draftRevision: 2, connectionRevision: 1,
    targetFingerprint: 'p5-target', credentialState: 'none', consentState: 'unapproved',
    cachedModels: [], sourceKind: 'none' });
  await waitFor(() => bridge.calls.closeDraft.some(call => call.draftId === 'late-old-target'));
  await tick(30);
  assert.equal(bridge.calls.open.length, 0, 'the old target must not open a credential window');
  // 下一次保存必须创建新草稿，不能把迟到的旧 draftId 复活。
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await waitFor(() => api.calls.drafts.length === 2);
  assert.equal(api.calls.drafts[1].draftId, undefined,
    'the stale server draft must not be reused after the target changed');
  await waitFor(() => api.calls.commits.length === 1);
});

test('a late draft cleanup never revokes the draft a newer dialog is using', async () => {
  const snapshot = p5Snapshot();
  const service = plainService(snapshot);
  const bridge = fakeCredentialBridge();
  const { window } = dialogDom();
  window.piGuiDesktop = { providerCredentials: bridge };
  const apiA = dialogApi({ snapshot });
  const late = deferred();
  apiA.saveProviderDraft = request => {
    apiA.calls.drafts.push(clone(request));
    return late.promise;
  };
  window.openProviderDialog({ snapshot, api: apiA, mode: 'edit', service });
  const cardA = window.document.getElementById('modalCard');
  const triggerA = await waitFor(() => {
    const node = cardA.querySelector('[data-credential-trigger]');
    return node && node.disabled === false ? node : null;
  });
  triggerA.click();
  await waitFor(() => apiA.calls.drafts.length === 1);
  findButton(cardA, '取消').click();
  await waitFor(() => window.document.getElementById('confirmLayer').hidden === false);
  confirmButton(window, '放弃更改').click();
  await waitFor(() => window.document.getElementById('modal').hidden === true);

  // 新弹窗先拿到同名的草稿标识并处于可用状态；旧响应不能撤销它。
  const apiB = dialogApi({ snapshot });
  window.openProviderDialog({ snapshot, api: apiB, mode: 'edit', service });
  const cardB = window.document.getElementById('modalCard');
  const triggerB = await waitFor(() => {
    const node = cardB.querySelector('[data-credential-trigger]');
    return node && node.disabled === false ? node : null;
  });
  triggerB.click();
  await waitFor(() => apiB.calls.drafts.length === 1 && bridge.calls.open.length === 1);
  await waitFor(() => cardB.querySelector('.pm-credential-status')?.textContent.includes('新密钥已暂存'));
  const before = bridge.calls.closeDraft.filter(call => call.draftId === 'p5-draft').length;
  late.resolve({ ok: true, draftId: 'p5-draft', draftRevision: 2, connectionRevision: 1,
    targetFingerprint: 'p5-target', credentialState: 'none', consentState: 'unapproved',
    cachedModels: [], sourceKind: 'none' });
  await tick(50);
  assert.equal(bridge.calls.closeDraft.filter(call => call.draftId === 'p5-draft').length, before,
    'the old dialog must not close the draft the new dialog is using');
  // 关闭新弹窗时该草稿才应被撤销，证明确实是新流程持有它。
  findButton(cardB, '取消').click();
  await waitFor(() => window.document.getElementById('confirmLayer').hidden === false);
  confirmButton(window, '放弃更改').click();
  await waitFor(() => bridge.calls.closeDraft.filter(call => call.draftId === 'p5-draft').length > before);
});

test('rapid credential trigger clicks open only one restricted window', async () => {
  const snapshot = p5Snapshot();
  const service = plainService(snapshot);
  const bridge = fakeCredentialBridge();
  const api = dialogApi({ snapshot });
  const { card } = openDialog({ snapshot, api, bridge, service });
  const trigger = await waitFor(() => {
    const node = card.querySelector('[data-credential-trigger]');
    return node && node.disabled === false ? node : null;
  });
  trigger.click();
  trigger.click();
  await waitFor(() => card.querySelector('.pm-credential-status')?.textContent.includes('新密钥已暂存'));
  await tick(30);
  assert.equal(bridge.calls.open.length, 1, 'the controller and dialog share a single-flight gate');
});

test('a save response that arrives after the target changed is not shown as the new draft success', async () => {
  const snapshot = p5Snapshot();
  const service = plainService(snapshot);
  const bridge = fakeCredentialBridge();
  const commit = deferred();
  const api = dialogApi({ snapshot, commit: () => commit.promise });
  const { window, card } = openDialog({ snapshot, api, bridge, service });
  // 等弹窗完成初始化（草稿就绪）再点保存；否则点击落在 loading 壳上会被忽略。
  await waitFor(() => {
    const node = card.querySelector('[data-credential-trigger]');
    return node && node.disabled === false ? node : null;
  });
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await waitFor(() => api.calls.commits.length === 1);
  const env = await waitFor(() => card.querySelector('.pm-env-input'));
  env.value = '$OTHER_KEY';
  env.dispatchEvent(new card.ownerDocument.defaultView.Event('input', { bubbles: true }));
  commit.resolve({ ok: true, serviceId: 'example-ai', saved: true, credentialSaved: null,
    credentialState: 'saved', sync: { state: 'pending', reason: 'runtime_sync_pending' }, revision: 'config-rev-2' });
  await waitFor(() => card.querySelector('.pm-status-banner')?.textContent.includes('保存结果未应用到当前草稿'));
  assert.equal(window.document.getElementById('modal').hidden, false,
    'the stale success must not close the dialog as if the new target was saved');
  assert.ok(!card.textContent.includes('服务已保存'), 'the old commit must not be reported as the current success');
});

test('disposing the credential controller settles a pending open and refuses a new window', async () => {
  const { createCredentialController } = await import('../public/provider-management/credentials.js');
  const listeners = new Set();
  let resolveOpen = null;
  let cancelled = 0;
  const bridge = {
    async status() { return { ok: true, hasFlow: false }; },
    open() { return new Promise(resolve => { resolveOpen = resolve; }); },
    cancel() { cancelled += 1; },
    async closeDraft() { return { ok: true }; },
    onState(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const controller = createCredentialController({ bridge, waitTimeoutMs: 5000 });
  const first = controller.open({ draftId: 'draft-1', draftRevision: 1 });
  const second = await controller.open({ draftId: 'draft-1', draftRevision: 1 });
  assert.equal(second.code, 'busy', 'a window open request must be single-flight before bridge.open resolves');
  controller.dispose();
  resolveOpen({ ok: true, state: { action: 'set' } });
  const result = await first;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'closed');
  assert.ok(cancelled >= 1, 'dispose must cancel a restricted window that was still opening');
  const after = await controller.open({ draftId: 'draft-1', draftRevision: 1 });
  assert.equal(after.code, 'closed', 'a disposed controller must never open another window');
});

test('cancelling the controller while the window open request is pending settles as cancelled', async () => {
  const { createCredentialController } = await import('../public/provider-management/credentials.js');
  const listeners = new Set();
  let resolveOpen = null;
  let cancelCalls = 0;
  let opens = 0;
  const bridge = {
    async status() { return { ok: true, hasFlow: false }; },
    open() {
      opens += 1;
      if (opens === 1) return new Promise(resolve => { resolveOpen = resolve; });
      setTimeout(() => { for (const listener of listeners) listener({ state: 'staged', action: 'set' }); }, 0);
      return Promise.resolve({ ok: true, state: { action: 'set' } });
    },
    cancel() { cancelCalls += 1; },
    async closeDraft() { return { ok: true }; },
    onState(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const controller = createCredentialController({ bridge, waitTimeoutMs: 5000 });
  const first = controller.open({ draftId: 'draft-1', draftRevision: 1 });
  assert.equal((await controller.open({ draftId: 'draft-1', draftRevision: 1 })).code, 'busy');
  controller.cancel();
  resolveOpen({ ok: true, state: { action: 'set' } });
  const result = await first;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'cancelled');
  assert.equal(result.cancelled, true);
  assert.ok(cancelCalls >= 1);
  // 取消不能让控制器永久卡在旧打开请求上；下一次打开仍须能完成。
  const next = await controller.open({ draftId: 'draft-2', draftRevision: 1 });
  assert.equal(next.ok, true);
  assert.equal(opens, 2);
});

/* ---------- 弹窗：发现 ---------- */

test('authorized discovery merges remote candidates and saves only the selected candidate', async () => {
  const snapshot = p5Snapshot();
  const api = dialogApi({
    snapshot,
    authorize: async () => ({ ok: true, consentId: 'consent-1', expiresAt: Date.now() + 60_000 }),
    operation: async () => {
      const request = api.calls.discover.at(-1);
      return { ok: true, state: 'success', result: {
        models: [{ modelId: 'remote-fresh', configSource: 'remote', effectiveValues: { name: 'Fresh Remote' } }],
        sourceKind: 'remote', dialogGeneration: request.dialogGeneration,
        requestSeq: request.requestSeq, connectionRevision: 1,
      } };
    },
    commit: async request => ({ ok: true, serviceId: request.serviceId || 'example-ai', saved: true,
      credentialSaved: null, credentialState: 'saved', sync: { state: 'idle', reason: null }, revision: 'config-rev-2' }),
  });
  const { window, card } = openDialog({ snapshot, api });
  await waitFor(() => card.querySelector('[data-authorize-discovery]'));
  card.querySelector('[data-authorize-discovery]').click();
  await waitFor(() => api.calls.discover.length === 1, 6000);
  await waitFor(() => card.querySelector('[data-model-row="remote-fresh"]'), 6000);
  assert.equal(api.calls.authorize.length, 1);
  assert.equal(api.calls.authorize[0].confirm, true);
  assert.equal(api.calls.discover[0].consentId, 'consent-1');
  const row = card.querySelector('[data-model-row="remote-fresh"]');
  assert.ok(row.querySelector('.pm-model-source').textContent.includes('远端候选'));
  assert.deepEqual([...card.querySelectorAll('[data-chosen-model]')].map(node => node.dataset.chosenModel), ['vision', 'fast'],
    'discovery must not change the user selection');
  const checkbox = card.querySelector('[data-model-check="remote-fresh"]');
  checkbox.checked = true;
  checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual([...card.querySelectorAll('[data-chosen-model]')].map(node => node.dataset.chosenModel), ['vision', 'fast', 'remote-fresh']);
  card.querySelector('.pm-dialog-actions .pm-primary').click();
  await waitFor(() => api.calls.commits.length === 1);
  const payload = api.calls.drafts.at(-1).draft;
  assert.ok(payload.selectedModelIds.includes('remote-fresh'));
  assert.ok(payload.modelPatches.some(patch => patch.modelId === 'remote-fresh' && patch.operation === 'upsert'),
    'a selected remote candidate must be written as an upsert');
  assert.equal(api.calls.commits[0].action, 'update');
  assert.equal(window.document.getElementById('modal').hidden, true);
});

test('leaving the setup view revokes discovery authorization even without the desktop bridge', async () => {
  const snapshot = p5Snapshot();
  const api = dialogApi({
    snapshot,
    authorize: async () => ({ ok: true, consentId: 'consent-web', expiresAt: Date.now() + 60_000 }),
    operation: async () => {
      const request = api.calls.discover.at(-1);
      return { ok: true, state: 'success', result: { models: [], sourceKind: 'remote',
        dialogGeneration: request.dialogGeneration, requestSeq: request.requestSeq, connectionRevision: 1 } };
    },
  });
  const { card } = openDialog({ snapshot, api });
  await waitFor(() => card.querySelector('[data-authorize-discovery]'));
  card.querySelector('[data-authorize-discovery]').click();
  await waitFor(() => api.calls.discover.length === 1, 6000);
  await waitFor(() => api.calls.discover[0].consentId === 'consent-web');
  card.querySelector('.pm-advanced-entry').click();
  await waitFor(() => api.calls.revoke.length === 1);
  assert.equal(api.calls.revoke[0].consentId, 'consent-web');
});

test('dialog polls operations through its production API wiring', async () => {
  const snapshot = p5Snapshot();
  const { dom, window } = dialogDom();
  const calls = [];
  let discoverRequest = null;
  window.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const route = String(url).split('?')[0].replace(/^.*\/api\/provider-management/, '');
    calls.push({ method, route });
    const reply = value => ({ status: 200, ok: true, json: async () => value });
    if (method === 'POST' && route === '/drafts') {
      return reply({ ok: true, draftId: 'p5-draft', draftRevision: 2, connectionRevision: 1,
        targetFingerprint: 'p5-target', credentialState: 'none', consentState: 'unapproved',
        cachedModels: [], sourceKind: 'none' });
    }
    if (method === 'POST' && route === '/discovery-authorizations') {
      return reply({ ok: true, consentId: 'consent-1', expiresAt: Date.now() + 60_000 });
    }
    if (method === 'POST' && route === '/discover') {
      discoverRequest = JSON.parse(options.body);
      return reply({ ok: true, operationId: 'op-1' });
    }
    if (method === 'GET' && route === '/operations/op-1') {
      return reply({ ok: true, state: 'success', result: {
        models: [{ modelId: 'remote-wired', configSource: 'remote', effectiveValues: { name: 'Wired Remote' } }],
        sourceKind: 'remote', dialogGeneration: discoverRequest.dialogGeneration,
        requestSeq: discoverRequest.requestSeq, connectionRevision: discoverRequest.connectionRevision,
      } });
    }
    return reply({ ok: false, code: 'not_found' });
  };
  // 不注入 api：这里要验证的是弹窗默认接线，而不是测试替身自己实现了轮询。
  window.openProviderDialog({ snapshot, mode: 'edit', service: snapshot.services[0] });
  const card = window.document.getElementById('modalCard');
  await waitFor(() => card.querySelector('[data-authorize-discovery]'));
  card.querySelector('[data-authorize-discovery]').click();
  const row = await waitFor(() => card.querySelector('[data-model-row="remote-wired"]'), 6000);
  assert.ok(row, 'the dialog must poll /operations through the production API map');
  assert.ok(calls.some(call => call.method === 'GET' && call.route === '/operations/op-1'),
    'the poll request must reach the management operation endpoint');
  dom.window.close();
});

test('draft projection exposes a consent only while its binding is current', async () => {
  const { createDiscoveryConsentStore } = await import('../server/provider-discovery-consent.js');
  const { createProviderManagementDiscovery } = await import('../server/provider-management-discovery.js');
  const now = Date.now();
  const draft = {
    draftId: 'draft-1', draftRevision: 2, connectionRevision: 1, providerId: 'example',
    authMode: 'pi-credential', connection: { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions' },
  };
  const consentStore = createDiscoveryConsentStore({ strict: true, now: () => now });
  const issued = consentStore.issue({ ...draft, api: 'openai-completions', credentialSource: 'staged',
    credentialRevision: 'credential-rev-1', workerEpoch: 'worker-1', rememberTarget: false, loopback: false });
  assert.equal(issued.ok, true);
  const discovery = createProviderManagementDiscovery({
    draftLookup: id => id === draft.draftId ? draft : null,
    consentStore,
    nativeCurrent: () => true,
    verifyNative: async () => true,
  });
  const projected = await discovery.projectDraft({ ok: true, draftId: draft.draftId, draftRevision: 2 });
  assert.equal(projected.consentId, issued.consentId);
  assert.equal(projected.consentExpiresAt, issued.expiresAt);
  assert.equal(projected.consentState, 'authorized-idle');
  const stale = await discovery.projectDraft({ ok: true, draftId: draft.draftId, draftRevision: 1 });
  assert.equal(stale.consentId, undefined, 'a stale draft revision must not receive the consent handle');
  const unverified = createProviderManagementDiscovery({
    draftLookup: id => id === draft.draftId ? draft : null,
    consentStore,
    nativeCurrent: () => true,
    verifyNative: async () => false,
  });
  const hidden = await unverified.projectDraft({ ok: true, draftId: draft.draftId, draftRevision: 2 });
  assert.equal(hidden.consentId, undefined, 'an unverified native stage must not be projected as authorized');
});

test('capabilities advertise only the discovery modes the backend actually wires', async () => {
  const { providerManagementCapabilities } = await import('../public/provider-management/contract.js');
  const wired = providerManagementCapabilities({ discoveryModes: ['environment', 'pi-credential', 'bogus'] });
  assert.deepEqual(wired.discoveryModes, ['environment', 'pi-credential']);
  assert.equal(wired.reasons.discoveryModes, null);
  const unwired = providerManagementCapabilities({});
  assert.deepEqual(unwired.discoveryModes, []);
  assert.equal(unwired.reasons.discoveryModes, 'discovery_transport_pending');
});

test('subscription services keep the Pi login path and never show a key entry', async () => {
  const snapshot = p5Snapshot();
  const service = snapshot.services.find(item => item.authMode === 'oauth');
  const bridge = fakeCredentialBridge();
  const api = dialogApi({ snapshot });
  const { card } = openDialog({ snapshot, api, bridge, service });
  await waitFor(() => card.querySelector('.pm-dialog-title')?.textContent === '订阅账户');
  assert.ok(card.querySelector('.pm-auth-view'), 'subscription services open the Pi auth view');
  assert.equal(card.querySelector('[data-credential-trigger]'), null);
  assert.equal(card.querySelectorAll('input[type=password]').length, 0);
  await tick(20);
  assert.equal(bridge.calls.open.length, 0);
  assert.equal(api.calls.commits.length, 0);
});

/* ---------- 页面：Runtime 同步 ---------- */

test('provider page shows per-runtime sync facts and re-verifies through a read-only 202 operation', async () => {
  const snapshot = p5Snapshot(value => {
    value.sync = { state: 'pending', reason: 'runtime_sync_pending', runtimes: [
      { id: 'runtime-a', kind: 'runtime', state: 'pending', reason: 'runtime_sync_pending' },
    ] };
  });
  const { window, calls } = openPage({ snapshot });
  const banner = await waitFor(() => window.document.querySelector('.pm-sync-banner'));
  assert.ok(banner);
  assert.equal(banner.dataset.syncState, 'pending');
  assert.ok(banner.textContent.includes('Runtime runtime-a'));
  assert.ok(banner.textContent.includes('待同步'));
  const retry = banner.querySelector('.pm-sync-retry');
  assert.ok(retry);
  retry.click();
  retry.click();
  const applied = await waitFor(() => window.document.querySelector('.pm-sync-banner[data-sync-state="applied"]'));
  assert.ok(applied, 'the page must render the applied facts returned by P3-C');
  assert.ok(applied.textContent.includes('已生效'));
  assert.equal(calls.sync.length, 1, 'a double click must produce exactly one /sync operation');
  assert.equal(calls.sync[0].revision, 'config-rev-1');
  assert.ok(calls.sync[0].requestId);
  assert.ok(calls.operations.length >= 1);
  assert.equal(window.document.getElementById('modal').hidden, false);
});

test('a sync verification that finishes after the page closes cannot touch the reopened page', async () => {
  const snapshot = p5Snapshot(value => {
    value.sync = { state: 'pending', reason: 'runtime_sync_pending', runtimes: [
      { id: 'runtime-a', kind: 'runtime', state: 'pending', reason: 'runtime_sync_pending' },
    ] };
  });
  const reply = value => ({ status: 200, json: async () => value });
  const firstSync = deferred();
  let syncCalls = 0;
  let mode = 'first';
  const applied = { state: 'applied', reason: null,
    runtimes: [{ id: 'runtime-a', kind: 'runtime', state: 'applied', reason: null }] };
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/api/provider-management')) {
      if (target.endsWith('/sync')) {
        syncCalls += 1;
        if (mode === 'first') return firstSync.promise;
        snapshot.sync = clone(applied);
        return { status: 202, json: async () => ({ ok: true, operationId: 'sync-new',
          sync: { state: 'pending', reason: 'runtime_sync_pending', runtimes: applied.runtimes } }) };
      }
      if (target.includes('/operations/')) {
        return reply({ ok: true, state: 'success', result: { sync: clone(applied) } });
      }
      return reply(clone(snapshot));
    }
    if (target.includes('/api/providers')) return reply({ ok: true, path: 'fixture', revision: 7, providers: {}, keyStates: {} });
    if (target.includes('/api/provider-auth')) return reply({ ok: true, capability: { sdkAvailable: false }, providers: [], flow: null, sync: { state: 'idle' } });
    assert.fail(`unexpected fetch ${target}`);
  };
  const { window } = openPage({ snapshot, fetchImpl });
  const banner = await waitFor(() => window.document.querySelector('.pm-sync-banner[data-sync-state="pending"]'));
  banner.querySelector('.pm-sync-retry').click();
  await waitFor(() => syncCalls === 1);
  // 关闭设置页，再重新打开；旧请求此时仍未返回。
  [...window.document.querySelectorAll('.modal-actions button')]
    .find(node => node.textContent === '关闭').click();
  await waitFor(() => window.document.getElementById('modal').hidden === true);
  mode = 'second';
  window.openProvidersPanel();
  await waitFor(() => window.document.querySelector('.pm-sync-banner[data-sync-state="pending"]'));
  firstSync.resolve({ status: 202, json: async () => ({ ok: true, operationId: 'sync-old',
    sync: { state: 'pending', reason: 'runtime_sync_pending' } }) });
  await tick(80);
  const reopened = window.document.querySelector('.pm-sync-banner');
  assert.equal(reopened.dataset.syncState, 'pending',
    'the old controller must not paint applied facts onto the reopened page');
  assert.ok(!reopened.textContent.includes('已生效'));
  // 新页面自己的「重新核验」必须还能发起，且只发一次。
  reopened.querySelector('.pm-sync-retry').click();
  await waitFor(() => window.document.querySelector('.pm-sync-banner[data-sync-state="applied"]'));
  assert.equal(syncCalls, 2, 'the reopened page must start a fresh verification');
});

test('a sync result for an older revision is not shown as applied on the new configuration', async () => {
  const snapshot = p5Snapshot(value => {
    value.sync = { state: 'pending', reason: 'runtime_sync_pending', runtimes: [
      { id: 'runtime-a', kind: 'runtime', state: 'pending', reason: 'runtime_sync_pending' },
    ] };
  });
  const reply = value => ({ status: 200, json: async () => value });
  const syncResult = deferred();
  let operationResult = null;
  let revision = 'config-rev-1';
  let syncCalls = 0;
  let operationCalls = 0;
  let managementGets = 0;
  const applied = { state: 'applied', reason: null,
    runtimes: [{ id: 'runtime-a', kind: 'runtime', state: 'applied', reason: null }] };
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/api/provider-management')) {
      if (target.endsWith('/sync')) {
        syncCalls += 1;
        return syncResult.promise;
      }
      if (target.includes('/operations/')) {
        operationCalls += 1;
        return new Promise(resolve => { operationResult = () => resolve(reply({ ok: true, state: 'success', result: { sync: clone(applied) } })); });
      }
      managementGets += 1;
      return reply({ ...clone(snapshot), revision });
    }
    if (target.includes('/api/providers')) return reply({ ok: true, path: 'fixture', revision: 7, providers: {}, keyStates: {} });
    if (target.includes('/api/provider-auth')) return reply({ ok: true, capability: { sdkAvailable: false }, providers: [], flow: null, sync: { state: 'idle' } });
    assert.fail(`unexpected fetch ${target}`);
  };
  const { window } = openPage({ snapshot, fetchImpl });
  const banner = await waitFor(() => window.document.querySelector('.pm-sync-banner[data-sync-state="pending"]'));
  banner.querySelector('.pm-sync-retry').click();
  await waitFor(() => syncCalls === 1);
  // 核验期间配置被另一个保存推进到新 revision；旧操作的 202 仍会返回并轮询。
  revision = 'config-rev-2';
  syncResult.resolve({ status: 202, json: async () => ({ ok: true, operationId: 'sync-old',
    sync: { state: 'pending', reason: 'runtime_sync_pending' } }) });
  assert.ok(await waitFor(() => operationCalls === 1 && operationResult, 6000),
    'the old operation must reach its poll before the revision assertion');
  const getsBefore = managementGets;
  operationResult();
  await waitFor(() => managementGets > getsBefore, 6000);
  await tick(20);
  const current = window.document.querySelector('.pm-sync-banner');
  assert.equal(current.dataset.syncState, 'pending',
    'applied facts from the old revision must not be attributed to the new configuration');
  assert.ok(!current.textContent.includes('已生效'));
});

test('a sync failure from an older revision is not reported on the new configuration', async () => {
  const snapshot = p5Snapshot(value => {
    value.sync = { state: 'pending', reason: 'runtime_sync_pending', runtimes: [
      { id: 'runtime-a', kind: 'runtime', state: 'pending', reason: 'runtime_sync_pending' },
    ] };
  });
  const reply = value => ({ status: 200, json: async () => value });
  const syncResult = deferred();
  let revision = 'config-rev-1';
  let syncCalls = 0;
  let managementGets = 0;
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/api/provider-management')) {
      if (target.endsWith('/sync')) {
        syncCalls += 1;
        return syncResult.promise;
      }
      if (target.includes('/operations/')) return reply({ ok: false, code: 'not_found' });
      managementGets += 1;
      return reply({ ...clone(snapshot), revision });
    }
    if (target.includes('/api/providers')) return reply({ ok: true, path: 'fixture', revision: 7, providers: {}, keyStates: {} });
    if (target.includes('/api/provider-auth')) return reply({ ok: true, capability: { sdkAvailable: false }, providers: [], flow: null, sync: { state: 'idle' } });
    assert.fail(`unexpected fetch ${target}`);
  };
  const { window } = openPage({ snapshot, fetchImpl });
  const banner = await waitFor(() => window.document.querySelector('.pm-sync-banner[data-sync-state="pending"]'));
  banner.querySelector('.pm-sync-retry').click();
  await waitFor(() => syncCalls === 1);
  const getsBefore = managementGets;
  // 核验期间配置推进到新 revision；旧请求随后以网络失败结束。
  revision = 'config-rev-2';
  syncResult.resolve(reply({ ok: false, network: true, code: 'network_failed', message: '网络请求失败' }));
  // verifySync 无论是否误报，都会先重读快照；等这次读取发生后，旧结果的通知
  // 已经有机会出现，再断言新页面没有被旧 revision 的错误污染。
  assert.ok(await waitFor(() => managementGets > getsBefore, 6000),
    'the old verification must finish its snapshot refresh');
  await tick(20);
  assert.ok(!window.document.getElementById('toasts').textContent.includes('网络请求失败'),
    'an old revision failure must not be toasted against the new configuration');
  assert.equal(window.document.querySelector('.pm-sync-banner').dataset.syncState, 'pending');
});

test('an old page close callback cannot stop the reopened page sync controller', async () => {
  const snapshot = p5Snapshot(value => {
    value.sync = { state: 'pending', reason: 'runtime_sync_pending', runtimes: [
      { id: 'runtime-a', kind: 'runtime', state: 'pending', reason: 'runtime_sync_pending' },
    ] };
  });
  const reply = value => ({ status: 200, json: async () => value });
  const syncResult = deferred();
  let syncCalls = 0;
  const applied = { state: 'applied', reason: null,
    runtimes: [{ id: 'runtime-a', kind: 'runtime', state: 'applied', reason: null }] };
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/api/provider-management')) {
      if (target.endsWith('/sync')) {
        syncCalls += 1;
        // 服务端只读核验后，下一次快照会带上 applied 事实。
        snapshot.sync = clone(applied);
        return syncResult.promise;
      }
      if (target.includes('/operations/')) {
        return reply({ ok: true, state: 'success', result: { sync: clone(applied) } });
      }
      return reply(clone(snapshot));
    }
    if (target.includes('/api/providers')) return reply({ ok: true, path: 'fixture', revision: 7, providers: {}, keyStates: {} });
    if (target.includes('/api/provider-auth')) return reply({ ok: true, capability: { sdkAvailable: false }, providers: [], flow: null, sync: { state: 'idle' } });
    assert.fail(`unexpected fetch ${target}`);
  };
  const { window } = openPage({ snapshot, fetchImpl });
  // 第一页用默认模态打开；等它加载完成，确保第二页打开时它仍是「旧页面」。
  await waitFor(() => window.document.querySelector('#modal .pm-service-row[data-service-id="example-ai"]'));
  const present = (render, onClose) => {
    const card = window.document.createElement('div');
    card.className = 'pm-settings-page reopened-page';
    window.document.body.appendChild(card);
    const close = () => { card.remove(); onClose(); };
    render(card, close);
  };
  window.openProvidersPanel({ present });
  const banner = await waitFor(() => window.document.querySelector('.reopened-page .pm-sync-banner[data-sync-state="pending"]'));
  banner.querySelector('.pm-sync-retry').click();
  await waitFor(() => syncCalls === 1);
  // 新页面已经发起核验后，旧页面才真正关闭：旧关闭回调不能停掉新控制器。
  const closeOld = [...window.document.querySelectorAll('#modal .modal-actions button')]
    .find(node => node.textContent === '关闭');
  assert.ok(closeOld);
  closeOld.click();
  await waitFor(() => window.document.getElementById('modal').hidden === true);
  syncResult.resolve({ status: 202, json: async () => ({ ok: true, operationId: 'sync-reopened',
    sync: { state: 'pending', reason: 'runtime_sync_pending' } }) });
  const appliedBanner = await waitFor(
    () => window.document.querySelector('.reopened-page .pm-sync-banner[data-sync-state="applied"]'), 6000);
  assert.ok(appliedBanner, 'the reopened page controller must survive the old page close callback');
  assert.equal(syncCalls, 1, 'the reopened page must keep its single verification request');
});

test('OAuth services do not offer the discovery connection test', async () => {
  const snapshot = p5Snapshot();
  const { window } = openPage({ snapshot });
  const oauthRow = await waitFor(() => window.document.querySelector('.pm-service-row[data-service-id="openai"]'));
  const oauthTest = oauthRow.querySelector('[data-service-action="测试连接"]');
  assert.ok(oauthTest);
  assert.equal(oauthTest.disabled, true, 'the test entry must not route OAuth services into the login view');
  assert.ok(oauthTest.title.includes('OAuth'));
  const envRow = window.document.querySelector('.pm-service-row[data-service-id="example-ai"]');
  const envTest = envRow.querySelector('[data-service-action="测试连接"]');
  assert.equal(envTest.disabled, false, 'non-OAuth services keep the wired discovery test');
});

test('management-disabled pages keep the legacy provider list without sync or credential affordances', async () => {
  const { window, calls } = openPage({
    management: { status: 422, body: { ok: false, code: 'unsupported' } },
  });
  await waitFor(() => window.document.querySelector('.providers')?.textContent.includes('example'));
  assert.equal(window.piGuiDesktop, undefined);
  assert.equal(window.document.querySelector('.pm-sync-banner'), null);
  assert.equal(window.document.querySelector('[data-sync-state]'), null);
  assert.equal(window.document.querySelector('[data-credential-trigger]'), null);
  assert.ok(window.document.querySelector('.pm-page-status')?.textContent.includes('管理接口未启用'));
  assert.equal(calls.sync.length, 0);
  assert.ok(calls.legacy.length >= 1);
});
