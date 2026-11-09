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

function openPage({ snapshot, management = null, legacyData = null } = {}) {
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
  window.fetch = async (url, options = {}) => {
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
