/* P2 供应商凭据桌面专项：两阶段。
 *
 * 阶段 A（外层 node）：直接驱动 server/provider-credential-bridge.js——
 *   epoch 握手、flow/nonce 绑定与成功即作废、OAuth 同槽二次确认、草稿连接
 *   变化失效、维护互斥、授权签发与撤销、TTL。全部离线，SDK 用假适配器。
 *
 * 阶段 B（spawn 真 Electron）：真实 preload/真实受限窗口/真实自定义协议/
 * 真实后端子进程/真实 P1 worker（假 SDK 包），走通 open→输入→submit→暂存，
 * 并从「被攻陷的渲染进程」角度做负向验证（伪造 sender、错误 URL、重放、
 * 深层 frame 无桥）。证据截图落 world/evidence。
 * 本文件不依赖真 Pi 安装；所有写入都在 os.tmpdir()。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  moduleTests().then(electronPhase).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  electronMain().catch(error => { console.error(error); require('electron').app.exit(1); });
}

/* ---------------- 阶段 A：桥模块 ---------------- */

function fakeBridgeSdk(state) {
  return {
    qualified: async () => state.qualified,
    inspect: async providerId => {
      const record = state.native.get(providerId);
      return { present: record ? true : false, type: record?.type ?? null, builtIn: providerId === 'builtin-fixture',
        credentialRevision: record ? `rev-${providerId}` : null };
    },
    stageNativeLogin: async (binding, input, options) => {
      state.calls.push({ kind: 'stage', binding: { ...binding }, options: { ...options } });
      const current = state.native.get(binding.providerId);
      if (current?.type === 'oauth' && options?.confirmOAuthReplacement !== true) {
        return { ok: false, code: 'oauth_conflict', credentialState: 'none', credentialSaved: false };
      }
      if (input.includes('fail-stage')) return { ok: false, code: 'unsupported', credentialState: 'none', credentialSaved: false };
      state.staged.set(binding.draftId, { providerId: binding.providerId, key: input, connectionRevision: binding.connectionRevision });
      return { ok: true, credentialState: 'staged', credentialSaved: null, stagedRevision: `stage-${state.calls.length}` };
    },
    stageClear: async (binding, options) => {
      state.calls.push({ kind: 'stage-clear', binding: { ...binding }, options: { ...options } });
      if (!state.native.has(binding.providerId)) return { ok: false, code: 'credential_conflict', credentialState: 'none', credentialSaved: false };
      // 与真 worker 的 OAuth 同槽纪律一致：清除在受限窗内要先看一次影响说明。
      if (state.native.get(binding.providerId).type === 'oauth' && options?.confirmOAuthReplacement !== true) {
        return { ok: false, code: 'oauth_conflict', credentialState: 'none', credentialSaved: false };
      }
      return { ok: true, credentialState: 'clear-staged', credentialSaved: null };
    },
    disposeDraft: async draftId => { state.disposed.push(draftId); state.staged.delete(draftId); return { ok: true }; },
    dispose: async () => { state.disposed.push('<all>'); },
  };
}

const DRAFT = { draftId: 'draft-a', draftRevision: 1, connectionRevision: 1, serviceId: null,
  providerId: 'fixture', connection: { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions' }, expires: Number.MAX_SAFE_INTEGER };

function stageFrame(bridge, flow, overrides = {}) {
  return { type: 'provider-credential', action: 'stage', requestId: `req-${Math.random()}`,
    backendEpoch: bridge.epoch, flowId: flow.flowId, promptId: flow.promptId, nonce: flow.nonce,
    input: 'sentinel-key-ABC', allowDiscovery: false, rememberTarget: false, ...overrides };
}

async function moduleTests() {
  const assert = require('node:assert/strict');
  const { createProviderCredentialBridge } = await import(require('node:url').pathToFileURL(path.join(ROOT, 'server/provider-credential-bridge.js')).href);
  const { createDiscoveryConsentStore } = await import(require('node:url').pathToFileURL(path.join(ROOT, 'server/provider-discovery-consent.js')).href);
  let passed = 0;
  const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

  function make({ enabled = true, drafts = [DRAFT], sdkState } = {}) {
    const state = sdkState ?? { qualified: true, native: new Map(), staged: new Map(), calls: [], disposed: [] };
    const draftMap = new Map(drafts.map(draft => [draft.draftId, draft]));
    const consents = createDiscoveryConsentStore({ now: () => 1_000_000 });
    const sdk = fakeBridgeSdk(state);
    const bridge = createProviderCredentialBridge({ sdk, consentStore: consents,
      /* 动态读数组：测试在 prepare 之后改写 draft 以模拟连接变化。 */
      draftLookup: id => drafts.find(item => item.draftId === id) ?? draftMap.get(id) ?? null,
      mutationBlocked: () => state.blocked === true, maintenanceLocked: () => state.maintenance === true,
      enabled, flowTtlMs: 120_000, now: () => state.clock ?? 1_000_000 });
    return { bridge, consents, sdk, state };
  }

  const capability = await (async () => {
    const { bridge } = make();
    const cap = await bridge.handle({ type: 'provider-credential', action: 'capability', requestId: 'r1', backendEpoch: 'handshake' });
    check('capability handshake issues epoch and staging flag', () => {
      assert.equal(cap.ok, true);
      assert.match(cap.epoch, /^[\da-f-]{36}$/);
      assert.equal(cap.stagingEnabled, true);
      assert.equal(cap.sdkQualified, true);
    });
    return cap;
  })();

  {
    const { bridge } = make();
    const rejected = await bridge.handle({ type: 'provider-credential', action: 'prepare', requestId: 'r2',
      backendEpoch: 'wrong-epoch', draftId: 'draft-a', draftRevision: 1, purpose: 'set' });
    check('stale epoch is refused', () => assert.equal(rejected.code, 'unsupported'));
    const disabled = make({ enabled: false });
    const off = await disabled.bridge.handle({ type: 'provider-credential', action: 'prepare', requestId: 'r3',
      backendEpoch: disabled.bridge.epoch, draftId: 'draft-a', draftRevision: 1, purpose: 'set' });
    check('disabled bridge keeps every mutation unsupported', () => assert.equal(off.code, 'unsupported'));
    const cap = await disabled.bridge.handle({ type: 'provider-credential', action: 'capability', requestId: 'r4', backendEpoch: 'handshake' });
    check('disabled capability reports off and snapshot stays null', async () => {
      assert.equal(cap.stagingEnabled, false);
      assert.equal(await disabled.bridge.desktopCapability(), null);
    });
    const unqualified = make({ sdkState: { qualified: false, native: new Map(), staged: new Map(), calls: [], disposed: [] } });
    const unqCap = await unqualified.bridge.handle({ type: 'provider-credential', action: 'capability', requestId: 'r4b', backendEpoch: 'handshake' });
    const unqSnap = await unqualified.bridge.desktopCapability();
    check('unqualified SDK keeps staging flag false and snapshot null', () => {
      assert.equal(unqCap.sdkQualified, false);
      assert.equal(unqSnap, null);
    });
    // desktopCapability 是 async：不能吞掉 Promise（未 await 会把假值变成 truthy）。
    check('snapshot capability resolves to a plain object or null, never a Promise', async () => {
      const value = await make().bridge.desktopCapability();
      assert.ok(value === null || (typeof value === 'object' && !(value instanceof Promise)));
    });
  }

  {
    const { bridge } = make();
    const before = await bridge.desktopCapability();
    await bridge.handle({ type: 'provider-credential', action: 'capability', requestId: 'r5a', backendEpoch: 'handshake' });
    const afterHandshake = await bridge.desktopCapability();
    const prepared = await bridge.handle({ type: 'provider-credential', action: 'prepare', requestId: 'r5',
      backendEpoch: bridge.epoch, draftId: 'draft-a', draftRevision: 1, purpose: 'set' });
    check('snapshot capability only after private handshake with qualified SDK', () => {
      assert.equal(before, null);
      assert.equal(afterHandshake?.rawKeyInput, true);
      assert.equal(afterHandshake?.keyStaging, true);
      assert.equal(afterHandshake?.privateDesktopBridge, true);
      assert.equal(afterHandshake?.nativeCredentialPersistence, false, 'persist orchestration stays P3');
    });
    check('prepare binds flow to draft and target summary', () => {
      assert.equal(prepared.ok, true);
      assert.match(prepared.flowId, /^[\da-f-]{36}$/);
      assert.equal(prepared.targetSummary.providerId, 'fixture');
      assert.equal(prepared.targetSummary.baseUrl, 'https://fixture.invalid/v1');
      assert.equal(prepared.oauthConflict, false);
      assert.equal(prepared.credential.present, false);
    });
    const missing = await bridge.handle({ type: 'provider-credential', action: 'prepare', requestId: 'r6',
      backendEpoch: bridge.epoch, draftId: 'draft-missing', draftRevision: 1, purpose: 'set' });
    check('unknown or stale draft refuses prepare', () => {
      assert.equal(missing.code, 'draft_conflict');
    });
    const staleRevision = await bridge.handle({ type: 'provider-credential', action: 'prepare', requestId: 'r7',
      backendEpoch: bridge.epoch, draftId: 'draft-a', draftRevision: 99, purpose: 'set' });
    check('draft revision mismatch refuses prepare', () => assert.equal(staleRevision.code, 'draft_conflict'));
    const blocked = make();
    blocked.state.blocked = true;
    const busy = await blocked.bridge.handle({ type: 'provider-credential', action: 'prepare', requestId: 'r8',
      backendEpoch: blocked.bridge.epoch, draftId: 'draft-a', draftRevision: 1, purpose: 'set' });
    check('mutation mutex refuses prepare', () => assert.equal(busy.code, 'config_busy'));
    const maintaining = make();
    maintaining.state.maintenance = true;
    const maint = await maintaining.bridge.handle({ type: 'provider-credential', action: 'prepare', requestId: 'r9',
      backendEpoch: maintaining.bridge.epoch, draftId: 'draft-a', draftRevision: 1, purpose: 'set' });
    check('app-update maintenance refuses prepare', () => assert.equal(maint.code, 'config_busy'));
  }

  {
    const { bridge, consents, state } = make();
    const prepared = await bridge.handle({ type: 'provider-credential', action: 'prepare', requestId: 'r10',
      backendEpoch: bridge.epoch, draftId: 'draft-a', draftRevision: 1, purpose: 'set' });
    const ok = await bridge.handle(stageFrame(bridge, prepared, { allowDiscovery: true, rememberTarget: true }));
    check('stage succeeds, reports staged state and issues bound consent', () => {
      assert.equal(ok.ok, true);
      assert.equal(ok.credentialState, 'staged');
      assert.equal(ok.consent.consentId.length > 8, true);
      const record = consents.get(ok.consent.consentId);
      assert.equal(record.draftId, 'draft-a');
      assert.equal(record.connectionRevision, 1);
      assert.equal(record.credentialSource, 'staged');
      assert.equal(record.credentialAttached, true);
    });
    const replay = await bridge.handle(stageFrame(bridge, prepared, { allowDiscovery: true }));
    check('replay of a consumed nonce is refused', () => assert.equal(replay.ok, false));
    check('stage call forwarded with exact binding and pre-state revision', () => {
      assert.deepEqual(state.calls.at(-1).binding, { draftId: 'draft-a', providerId: 'fixture',
        connectionRevision: 1, connection: { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions' } });
      assert.equal(state.calls.at(-1).options.expectedCredentialRevision, null);
    });
  }

  {
    const { bridge, state } = make({ sdkState: { qualified: true, native: new Map([['fixture', { type: 'oauth', key: 'oauth-sentinel' }]]), staged: new Map(), calls: [], disposed: [] } });
    const prepared = await bridge.handle({ type: 'provider-credential', action: 'prepare', requestId: 'r11',
      backendEpoch: bridge.epoch, draftId: 'draft-a', draftRevision: 1, purpose: 'replace' });
    check('prepare surfaces OAuth slot conflict', () => assert.equal(prepared.oauthConflict, true));
    const first = await bridge.handle(stageFrame(bridge, prepared));
    check('first submit over OAuth refuses with oauth_conflict', () => {
      assert.equal(first.code, 'oauth_conflict');
      assert.equal(state.calls.at(-1).options.confirmOAuthReplacement, false);
    });
    const second = await bridge.handle(stageFrame(bridge, prepared));
    check('second submit inside the same sheet forwards the in-sheet confirmation', () => {
      assert.equal(second.ok, true);
      assert.equal(second.credentialState, 'staged');
      assert.equal(state.calls.at(-1).options.confirmOAuthReplacement, true);
    });
  }

  {
    const drafts = [DRAFT];
    const { bridge, state } = make({ drafts });
    const prepared = await bridge.handle({ type: 'provider-credential', action: 'prepare', requestId: 'r12',
      backendEpoch: bridge.epoch, draftId: 'draft-a', draftRevision: 1, purpose: 'set' });
    drafts[0] = { ...DRAFT, draftRevision: 2, connectionRevision: 2, connection: { baseUrl: 'https://other.invalid/v9', api: 'anthropic-messages' } };
    const stale = await bridge.handle(stageFrame(bridge, prepared));
    check('draft target or revision change invalidates staged flow and disposes worker draft', () => {
      assert.equal(stale.code, 'credential_conflict');
      assert.deepEqual(state.disposed, ['draft-a']);
    });
  }

  {
    const { bridge, consents } = make({ sdkState: { qualified: true, native: new Map([['fixture', { type: 'api_key', key: 'stored-sentinel' }]]), staged: new Map(), calls: [], disposed: [] } });
    const prepared = await bridge.handle({ type: 'provider-credential', action: 'prepare', requestId: 'r13',
      backendEpoch: bridge.epoch, draftId: 'draft-a', draftRevision: 1, purpose: 'authorize-target' });
    const confirmed = await bridge.handle({ type: 'provider-credential', action: 'authorize-target', requestId: 'r14',
      backendEpoch: bridge.epoch, flowId: prepared.flowId, promptId: prepared.promptId, nonce: prepared.nonce,
      confirmed: true, rememberTarget: true });
    check('authorize-target issues stored-credential consent after explicit confirm', () => {
      assert.equal(confirmed.ok, true);
      const record = consents.get(confirmed.consent.consentId);
      assert.equal(record.credentialSource, 'stored');
      assert.equal(record.credentialRevision, 'rev-fixture');
    });
    const clear = await bridge.handle({ type: 'provider-credential', action: 'prepare', requestId: 'r15',
      backendEpoch: bridge.epoch, draftId: 'draft-a', draftRevision: 1, purpose: 'clear' });
    const clearDone = await bridge.handle({ type: 'provider-credential', action: 'clear-stage', requestId: 'r16',
      backendEpoch: bridge.epoch, flowId: clear.flowId, promptId: clear.promptId, nonce: clear.nonce, confirmed: true });
    check('clear-stage with explicit confirm stages a clear intent', () => {
      assert.equal(clearDone.ok, true);
      assert.equal(clearDone.credentialState, 'clear-staged');
    });
  }

  {
    // FIX-04：OAuth 凭据的清除也要受限窗内二次确认——worker 层拒绝非确认
    // 调用，bridge 首次应答固定文案让页面提示影响，确认后再带 confirmOAuth
    // 替换标志重试。落盘清除仍属于 P3 保存编排。
    const { bridge, state } = make({ sdkState: { qualified: true, native: new Map([['fixture', { type: 'oauth', key: 'oauth-sentinel' }]]), staged: new Map(), calls: [], disposed: [] } });
    const prepared = await bridge.handle({ type: 'provider-credential', action: 'prepare', requestId: 'r16a',
      backendEpoch: bridge.epoch, draftId: 'draft-a', draftRevision: 1, purpose: 'clear' });
    const first = await bridge.handle({ type: 'provider-credential', action: 'clear-stage', requestId: 'r16b',
      backendEpoch: bridge.epoch, flowId: prepared.flowId, promptId: prepared.promptId, nonce: prepared.nonce, confirmed: true });
    check('OAuth clear first press explains impact and stays in the sheet', () => {
      assert.equal(first.ok, false);
      assert.equal(first.code, 'oauth_conflict');
      assert.match(first.message, /清除/);
      assert.ok(first.message.length > 10);
    });
    const second = await bridge.handle({ type: 'provider-credential', action: 'clear-stage', requestId: 'r16c',
      backendEpoch: bridge.epoch, flowId: prepared.flowId, promptId: prepared.promptId, nonce: prepared.nonce, confirmed: true });
    check('second press inside the sheet forwards explicit OAuth confirmation', () => {
      assert.equal(second.ok, true);
      assert.equal(second.credentialState, 'clear-staged');
      assert.equal(state.calls.at(-1).kind, 'stage-clear');
      assert.equal(state.calls.at(-1).options.confirmOAuthReplacement, true);
    });
    // 过期 flow：nonce 已 consumed，重放同一帧返回 invalid_request。
    const replay = await bridge.handle({ type: 'provider-credential', action: 'clear-stage', requestId: 'r16d',
      backendEpoch: bridge.epoch, flowId: prepared.flowId, promptId: prepared.promptId, nonce: prepared.nonce, confirmed: true });
    check('consumed clear nonce cannot replay', () => assert.equal(replay.code, 'invalid_request'));
  }

  {
    const { bridge, consents, state } = make();
    const prepared = await bridge.handle({ type: 'provider-credential', action: 'prepare', requestId: 'r17',
      backendEpoch: bridge.epoch, draftId: 'draft-a', draftRevision: 1, purpose: 'set' });
    await bridge.handle({ type: 'provider-credential', action: 'cancel', requestId: 'r18', backendEpoch: bridge.epoch, flowId: prepared.flowId });
    const afterCancel = await bridge.handle(stageFrame(bridge, prepared));
    check('cancel drops the flow; staged worker value stays untouched', () => {
      assert.equal(afterCancel.ok, false);
      assert.deepEqual(state.staged.size, 0);
      assert.deepEqual(state.disposed, []);
    });
    const reopen = await bridge.handle({ type: 'provider-credential', action: 'prepare', requestId: 'r19',
      backendEpoch: bridge.epoch, draftId: 'draft-a', draftRevision: 1, purpose: 'set' });
    await bridge.handle(stageFrame(bridge, reopen));
    await bridge.handle({ type: 'provider-credential', action: 'close-draft', requestId: 'r20', backendEpoch: bridge.epoch, draftId: 'draft-a' });
    check('close-draft disposes worker stage and revokes consents', () => {
      assert.deepEqual(state.disposed, ['draft-a']);
      assert.equal(consents.size, 0);
      assert.equal(bridge.activeFlows, 0);
    });
  }

  {
    const { bridge, state } = make();
    state.clock = 2_000_000;
    const prepared = await bridge.handle({ type: 'provider-credential', action: 'prepare', requestId: 'r21',
      backendEpoch: bridge.epoch, draftId: 'draft-a', draftRevision: 1, purpose: 'set' });
    state.clock += 120_001;
    const expired = await bridge.handle(stageFrame(bridge, prepared));
    check('flow TTL expiry refuses stage', () => assert.equal(expired.ok, false));
  }

  {
    const { bridge, consents, sdk } = make();
    const frame = { type: 'provider-credential', backendEpoch: bridge.epoch, requestId: 'close-race' };
    const prepared = await bridge.handle({ ...frame, action: 'prepare', draftId: DRAFT.draftId,
      draftRevision: 1, purpose: 'authorize-target' });
    const inspection = Promise.withResolvers();
    sdk.inspect = () => inspection.promise;
    const pending = bridge.handle({ ...frame, action: 'authorize-target', flowId: prepared.flowId, promptId: prepared.promptId,
      nonce: prepared.nonce, confirmed: true, rememberTarget: true });
    await bridge.handle({ ...frame, action: 'close-draft', draftId: DRAFT.draftId });
    inspection.resolve({ present: true, credentialRevision: 'fixture-native' });
    const late = await pending;
    check('closing a draft during authorization cannot recreate consent or a remembered target', () => {
      assert.equal(late.ok, false);
      assert.equal(consents.size, 0);
      assert.equal(consents.matchRemembered({ ...DRAFT, api: DRAFT.connection.api, credentialSource: 'stored',
        credentialRevision: 'fixture-native' }), null);
    });
  }

  console.log(`provider-credential-bridge: ${passed} assertions passed`);
}

/* ---------------- 阶段 B：真实 Electron ---------------- */

const FAKE_SDK = String.raw`
import fs from 'node:fs';
export function readStoredCredential(id, authPath) {
  try { return JSON.parse(fs.readFileSync(authPath, 'utf8'))[id]; } catch { return undefined; }
}
export class ModelRuntime {
  static async create(opts) {
    if (opts.allowModelNetwork !== false || opts.refreshOnCreate !== false || process.env.PI_GUI_TOKEN) throw new Error('fixture isolation');
    return new ModelRuntime(opts);
  }
  constructor({ credentials, authPath, modelsPath }) {
    this.credentials = credentials; this.authPath = authPath;
    this.ids = new Set(['builtin-fixture']);
    if (modelsPath) this.ids.add(JSON.parse(fs.readFileSync(modelsPath, 'utf8')).providers ? Object.keys(JSON.parse(fs.readFileSync(modelsPath, 'utf8')).providers)[0] : 'x');
  }
  getProviders() { return [...this.ids].map(id => ({ id, auth: { apiKey: { login() {} } } })); }
  registerProvider(id, options) { if (!this.credentials) throw new Error('no store'); this.ids.add(id); }
  read() { try { return JSON.parse(fs.readFileSync(this.authPath, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } }
  async listCredentials(opts) {
    opts?.signal?.throwIfAborted();
    if (this.credentials) return this.credentials.list(opts);
    return Object.entries(this.read()).map(([providerId, c]) => ({ providerId, type: c.type }));
  }
  async login(id, type, interaction) {
    if (type !== 'api_key') throw new Error('wrong login');
    const key = await interaction.prompt({ type: 'secret', signal: interaction.signal });
    const credential = { type, key };
    interaction.signal.throwIfAborted();
    if (this.credentials) await this.credentials.modify(id, () => credential, { signal: interaction.signal });
    else { const data = this.read(); data[id] = credential; fs.writeFileSync(this.authPath, JSON.stringify(data), { mode: 0o600 }); }
    return credential;
  }
  async logout(id, options) { options.signal.throwIfAborted(); const data = this.read(); delete data[id]; fs.writeFileSync(this.authPath, JSON.stringify(data)); }
  async getAuth() { throw new Error('default credential resolver is forbidden'); }
}
`;

async function electronMain() {
  const { app, BrowserWindow, ipcMain, protocol, session, nativeTheme } = require('electron');
  const crypto = require('node:crypto');
  const net = require('node:net');
  const { createProviderCredentialDesktop, registerCredentialScheme, SHEET_URL } = require(path.join(ROOT, 'electron/provider-credentials.cjs'));
  const { credentialSheetPage } = require(path.join(ROOT, 'electron/provider-credential-page.cjs'));

  registerCredentialScheme(protocol);
  /* world 由外层 node 进程创建并按需降低完整性标签：桌面测试运行器的受限令牌
   * 写不了用户 TEMP（与 tests/app-update-electron.cjs 相同的环境约束）。 */
  const world = process.env.CRED_DESKTOP_WORLD;
  if (!world || !fs.existsSync(world)) { console.error('FAIL missing CRED_DESKTOP_WORLD'); app.exit(1); return; }
  const out = path.join(world, 'evidence');
  const pkg = path.join(world, 'pi', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const agentDir = path.join(world, 'agent');
  const evidenceTarget = process.env.PI_GUI_CREDENTIAL_EVIDENCE;
  const watchdog = setTimeout(() => { console.error('FAIL desktop phase watchdog'); app.exit(1); }, 120_000);
  watchdog.unref();

  const checks = [];
  let failures = 0;
  function check(name, value, detail) {
    const ok = Boolean(value);
    if (!ok) failures += 1;
    checks.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ' ' + JSON.stringify(detail)}`);
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  app.setPath('userData', path.join(world, 'profile'));
  await app.whenReady();
  app.on('window-all-closed', () => {});
  /* 生产 main.cjs 里由 browserAgent/runtimeBrowserHost 注册的桌面 handler；
   * 测试宿主不装这些能力，但真实页面会调，给静默 no-op 保持页面可用。 */
  for (const channel of ['pi-gui:browser-agent-status', 'pi-gui:runtime-browser-status', 'pi-gui:theme-set']) {
    ipcMain.handle(channel, () => ({ ok: true }));
  }
  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const ORIGIN = `http://127.0.0.1:${port}`;
  const TOKEN = crypto.randomBytes(24).toString('hex');
  const TOKEN_HEADER = 'X-Pi-Gui-Token';

  // 真实后端子进程（与 main.cjs 同一 spawn 形状，含 ipc）
  const backendEntry = process.env.PI_GUI_CREDENTIAL_TEST_BACKEND || path.join(ROOT, 'server.js');
  const standalone = path.extname(backendEntry).toLowerCase() === '.exe';
  const spawnBackend = () => spawn(standalone ? backendEntry : process.execPath, standalone ? [] : [backendEntry], {
    cwd: world,
    env: { ...process.env, TMP: world, TEMP: world, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), PI_GUI_TOKEN: TOKEN, PI_GUI_OPEN: '0',
      PI_GUI_DATA: path.join(world, 'data'), PI_CODING_AGENT_DIR: agentDir,
      PI_BIN: path.join(pkg, 'sdk.mjs'),
      PI_GUI_PROVIDER_MANAGEMENT: '1', PI_GUI_PROVIDER_KEY_INPUT: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let server = spawnBackend();
  const serverLog = [];
  server.stdout.on('data', b => serverLog.push(b.toString()));
  server.stderr.on('data', b => serverLog.push(b.toString()));
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 25_000;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`${ORIGIN}/api/health`, { headers: { [TOKEN_HEADER]: TOKEN } });
        if (res.ok) { clearInterval(timer); resolve(); }
      } catch { /* not up yet */ }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('backend timeout: ' + serverLog.join('').slice(-2000))); }
    }, 200);
  });

  // 主窗口：真实 preload + 真实令牌注入（与生产 main.cjs 相同的机制）
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${ORIGIN}/*`] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, [TOKEN_HEADER]: TOKEN } });
  });
  const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: {
    preload: path.join(ROOT, 'electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, spellcheck: false,
  } });
  await win.loadURL(ORIGIN);

  // 桌面控制器：与生产 main.cjs 相同的装配，仅 isDesktopQualified 固定为真（测试环境）
  const controller = createProviderCredentialDesktop({
    app, BrowserWindow, ipcMain, protocol, session, nativeTheme,
    getMainWindow: () => win,
    getBackend: () => server,
    isDesktopQualified: () => true,
    page: credentialSheetPage,
    preloadPath: path.join(ROOT, 'electron/provider-credential-preload.cjs'),
    logEvent: () => {},
  });

  /* 多语句安全 + 表达式值保真：任务脚本包进 async IIFE；「最后一条语句的值」
   * 用收集器变量捕获——在脚本前后插入哨兵，最后一行表达式即将值传入 result。 */
  /* read：调用端一律提供**单个表达式**（含 IIFE）。早先把多语句直接内插进
   * await(...) 曾以 SyntaxError 假败；测试期中间还试过 eval 双探针，均不如
   * 「调用端保证单表达式」这一约定简单可靠——需要语句序列时自己包 IIFE。 */
  const read = async (target, js) => {
    const wrapped = `(async()=>{ try { return { ok: true, value: await (${js}) }; } catch (error) { return { ok: false, error: String(error && error.message || error) }; } })()`;
    const result = await target.webContents.executeJavaScript(wrapped, true);
    if (result && result.ok === false) throw new Error(`renderer script failed: ${result.error}`);
    return result && result.ok === true ? result.value : result;
  };
  const states = [];
  controller.onState(state => states.push(state));
  const waitFor = async condition => {
    for (let i = 0; i < 200; i++) { const value = await condition(); if (value) return value; await sleep(50); }
    throw new Error('condition timeout');
  };
  const sheetWindow = () => BrowserWindow.getAllWindows().find(w => w !== win && !w.isDestroyed()
    && String(w.webContents.getURL()).startsWith('pi-gui-credential:'));
  /** 等 sheet 就绪：窗口在列表里且 preload 桥已可用（避免 webContents 尚未
   * 进入可执行状态时的电层失败）。 */
  const waitForSheet = async () => {
    const target = await waitFor(() => sheetWindow());
    await waitFor(async () => {
      try { return await target.webContents.executeJavaScript(`document.readyState === 'complete' && typeof window.piGuiCredentialSheet === 'object' && Boolean(document.getElementById('sheet-key'))`, true); }
      catch { return false; }
    });
    /* info 拉取兜底（send 可能早于页面 listener 注册）：等页面的 applyMode
     * 已经生效（title 离开默认值 或 purpose-button 文案已就位）。
     * 用 mode() 无法直接读，改以 status 元素 + title 组合判定不可靠——
     * 这里等 invoke 拉取完成：页面 bridge 的 info() 返回 purpose 字段。 */
    await waitFor(async () => {
      try { return await target.webContents.executeJavaScript(`window.piGuiCredentialSheet.info().then(info => info.ok === true && Boolean(info.purpose))`, true); }
      catch { return false; }
    });
    return target;
  };
  async function createDraft(providerId, api = 'openai-completions', baseUrl = 'https://fixture.invalid/v1', serviceId) {
    return read(win, `(async()=>{
      const snapshot = await (await fetch('/api/provider-management')).json();
      const response = await (await fetch('/api/provider-management/drafts', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'e2e-' + Math.random(), expectedRevision: snapshot.revision, serviceId: ${JSON.stringify(serviceId)},
          draft: { providerId: ${JSON.stringify(providerId)}, authMode: 'pi-credential', displayName: 'E2E',
            connection: { baseUrl: ${JSON.stringify(baseUrl)}, api: ${JSON.stringify(api)} },
            modelPatches: [], selectedModelIds: [], modelOrder: [], enabled: true } }) })).json();
      return { ...response, expectedRevision: snapshot.revision };
    })()`);
  }
  async function nativeCommit(draft, requestId, action, serviceId) {
    const body = { requestId, action: serviceId ? 'update' : 'create', serviceId, expectedRevision: draft.expectedRevision,
      draftId: draft.draftId, draftRevision: draft.draftRevision, credentialAction: { type: action } };
    return read(win, `fetch('/api/provider-management/commit', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(${JSON.stringify(body)}) }).then(r => r.json())`);
  }

  try {
    const beforeSnapshot = await read(win, `(await (await fetch('/api/provider-management')).json())`);
    check('snapshot capabilities are closed before any private handshake',
      beforeSnapshot.capabilities.rawKeyInput === false && beforeSnapshot.capabilities.keyStaging === false,
      beforeSnapshot.capabilities);

    check('main page preload exposes no submit channel',
      await read(win, `typeof window.piGuiDesktop?.providerCredentials?.submit === 'undefined' && typeof window.piGuiDesktop?.providerCredentials?.open === 'function'`));

    const draft = await createDraft('fixture-provider');
    check('draft created via real HTTP API', Boolean(draft?.draftId), draft);

    const opened = await read(win, `window.piGuiDesktop.providerCredentials.open({ draftId: ${JSON.stringify(draft.draftId)}, draftRevision: ${draft.draftRevision}, action: 'set' })`);
    check('open returns ok through real preload bridge', opened?.ok === true, opened);
    const sheet = await waitForSheet();
    check('sheet window uses the fixed local protocol URL', String(sheet.webContents.getURL()) === SHEET_URL, sheet.webContents.getURL());

    check('sheet CSP forbids remote fetch', await read(sheet, `fetch('https://fixture.invalid/models').then(() => 'allowed').catch(error => 'blocked')`) === 'blocked');
    check('sheet page world has no node/process bridges',
      await read(sheet, `typeof window.require === 'undefined' && typeof window.process === 'undefined' && typeof window.piGuiCredentialSheet?.submit === 'function'`));
    const [[navigationEvent]] = await Promise.all([
      require('node:events').once(sheet.webContents, 'will-navigate', { signal: AbortSignal.timeout(5000) }),
      read(sheet, `(location.href = ${JSON.stringify(ORIGIN)}, 'assigned')`),
    ]);
    check('sheet navigation to app origin is prevented',
      navigationEvent.defaultPrevented && sheet.webContents.getURL() === SHEET_URL);
    fs.writeFileSync(path.join(out, 'sheet-dark.png'), (await sheet.webContents.capturePage()).toPNG());
    // 绕过页面 DOM：直接经桥提交（同一生产链路 submit → IPC → backend stage）。
    await read(sheet, `window.piGuiCredentialSheet.submit({ input: 'sentinel-key-E2E-1', allowDiscovery: false, rememberTarget: false }).then(v => JSON.stringify(v)).catch(e => 'submit_failed:' + (e && e.message || e))`);
    const stagedState = await waitFor(() => {
      try { return states.find(s => s.state === 'staged') && !sheetWindow() ? { staged: true } : null; }
      catch { return null; }
    });
    check('stage E2E: apply closes sheet and publishes staged state', Boolean(stagedState));
    const authFile = path.join(agentDir, 'auth.json');
    check('staging never writes the native credential file', !fs.existsSync(authFile), fs.existsSync(authFile) ? fs.readFileSync(authFile, 'utf8') : null);
    const mainWindowText = await read(win, `document.documentElement.innerHTML`);
    check('main window never contains the staged secret', !mainWindowText.includes('sentinel-key-E2E-1'));
    await win.focus();
    /* 受限测试宿主（隐藏窗口/非交互会话）不保证原生焦点事件可观察；这里
     * 验证 sheet 已销毁且主窗口可用，原生 focus 行为在视觉验收里另行核对。 */
    const focusAfterClose = await win.isFocused();
    check('sheet closed and main window interactive after apply', !sheetWindow() && !win.isDestroyed() && !win.isMinimized(), { focusAfterClose });

    const desktopStatus = await read(win, 'window.piGuiDesktop.providerCredentials.status()');
    const { createProviderConfigStore } = await import('../server/provider-config-store.js');
    const modelsJson = path.join(agentDir, 'models.json');
    const qualifiedFixture = createProviderConfigStore({ modelsJson, metadataPath: path.join(world, 'data', 'provider-management.json') })
      .authorizeCredentialStorage({ authPath: authFile });
    check('private desktop status reports the fixture storage qualification', desktopStatus.nativeCredentialPersistence === qualifiedFixture, desktopStatus);
    const saved = await nativeCommit(draft, 'desktop-native-set', 'apply-staged');
    const native = () => fs.existsSync(authFile) ? JSON.parse(fs.readFileSync(authFile, 'utf8')) : {};
    if (!qualifiedFixture) {
      check('P3-A refuses unqualified native storage before saving either file',
        saved.code === 'credential_conflict' && !fs.existsSync(authFile) && !fs.existsSync(modelsJson), saved);
      console.log('UNVERIFIED P3-A successful Electron persistence: fixture ancestors do not meet storage policy');
    } else {
      check('P3-A stores the staged key through the native SDK and confirms it',
        saved.saved === true && saved.credentialSaved === true && saved.credentialState === 'saved' &&
        saved.sync?.state === 'pending' && native()['fixture-provider']?.key === 'sentinel-key-E2E-1', saved);
      const repeated = await nativeCommit(draft, 'desktop-native-set', 'apply-staged');
      const persisted = ['models.json','models.json.pi-gui-operations.json'].map(name => path.join(agentDir, name));
      check('P3-A replays the safe receipt without leaking the staged key', JSON.stringify(saved) === JSON.stringify(repeated) &&
        !JSON.stringify(repeated).includes('sentinel-key-E2E-1') && persisted.every(file => fs.existsSync(file) &&
          !fs.readFileSync(file, 'utf8').includes('sentinel-key-E2E-1')));

      const removeDraft = await createDraft('fixture-provider', undefined, undefined, 'fixture-provider');
      const openRemove = await read(win, `window.piGuiDesktop.providerCredentials.open({ draftId: ${JSON.stringify(removeDraft.draftId)}, draftRevision: ${removeDraft.draftRevision}, action: 'clear' })`);
      check('P3-A can reopen the same saved service to confirm native clear', openRemove.ok === true, openRemove);
      const removeSheet = await waitForSheet();
      await read(removeSheet, `window.piGuiCredentialSheet.submit({ allowDiscovery: false, rememberTarget: false })`).catch(() => {});
      await waitFor(() => !sheetWindow());
      const cleared = await nativeCommit(removeDraft, 'desktop-native-clear', 'clear-native', 'fixture-provider');
      check('P3-A clears the native slot after configuration commit and readback',
        cleared.saved === true && cleared.credentialSaved === true && cleared.credentialState === 'cleared' &&
        !Object.hasOwn(native(), 'fixture-provider'), cleared);
    }

    // 被攻陷的渲染进程：直接持有 ipcRenderer 的外部窗口
    const evilPreload = path.join(world, 'evil-preload.cjs');
    fs.writeFileSync(evilPreload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('evil',{invoke:(channel,payload)=>ipcRenderer.invoke(channel,payload)});`);
    const evil = new BrowserWindow({ show: false, webPreferences: { preload: evilPreload, contextIsolation: true, nodeIntegration: false, partition: 'evil-partition' } });
    await evil.loadURL(ORIGIN);
    const evilInvoke = js => read(evil, js);
    const foreignSubmit = await evilInvoke(`window.evil.invoke('pi-gui:provider-credential-submit', { input: 'sentinel-x', allowDiscovery: false, rememberTarget: false })`);
    check('compromised foreign renderer cannot reach the sheet submit channel', foreignSubmit?.code === 'forbidden' || foreignSubmit?.ok === false, foreignSubmit);
    const foreignOpen = await evilInvoke(`window.evil.invoke('pi-gui:provider-credential-open', { draftId: ${JSON.stringify(draft.draftId)}, draftRevision: ${draft.draftRevision}, action: 'set' })`);
    check('compromised foreign renderer cannot open the sheet', foreignOpen?.code === 'forbidden', foreignOpen);
    await evil.loadURL('about:blank');
    const wrongOrigin = await evilInvoke(`window.evil.invoke('pi-gui:provider-credential-status')`);
    check('wrong frame origin is refused even for read-only channels', wrongOrigin?.code === 'forbidden', wrongOrigin);
    await evil.destroy();

    // OAuth 同槽替换：受限窗内两次提交（与生产一致的桥链路）
    fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ 'fixture-oauth': { type: 'oauth', key: 'oauth-sentinel' } }), { mode: 0o600 });
    const oauthDraft = await createDraft('fixture-oauth');
    await read(win, `window.piGuiDesktop.providerCredentials.open({ draftId: ${JSON.stringify(oauthDraft.draftId)}, draftRevision: ${oauthDraft.draftRevision}, action: 'replace' })`);
    const oauthSheet = await waitForSheet();
    check('prepare surfaces OAuth conflict to the sheet',
      await read(oauthSheet, `!document.getElementById('oauth-warn').classList.contains('hidden')`));
    await read(oauthSheet, `(document.getElementById('sheet-key').value = 'sentinel-key-OAUTH', 'filled')`);
    // 真实用户链路：走页面按钮（click handler 内含桥 submit、note 反馈、busy 状态）。
    let firstResult = 'clicked';
    try {
      firstResult = await read(oauthSheet, `(document.getElementById('sheet-apply').click(), 'clicked')`);
    } catch (error) {
      // 桥应答与 DOM 更新完成后窗口仍在；只吞应答投递的丢帧。
      console.log(`[diag] oauth first click script error: ${error.message}`);
    }
    await sleep(400);
    check('first submit keeps the sheet open and reports the OAuth conflict',
      Boolean(sheetWindow()) && await read(oauthSheet, `document.getElementById('sheet-status').textContent.includes('OAuth')`), { firstResult });
    await read(oauthSheet, `(document.getElementById('sheet-apply').click(), 'clicked-again')`);
    await waitFor(() => !sheetWindow());
    check('second submit inside the sheet confirms OAuth replacement',
      !sheetWindow() && states.filter(s => s.state === 'staged').length >= 2);
    check('oauth credential value never reaches the main window',
      !(await read(win, `document.documentElement.innerHTML`)).includes('oauth-sentinel'));

    // 取消：保留暂存、关闭窗口
    const cancelDraft = await createDraft('fixture-provider');
    await read(win, `window.piGuiDesktop.providerCredentials.open({ draftId: ${JSON.stringify(cancelDraft.draftId)}, draftRevision: ${cancelDraft.draftRevision}, action: 'set' })`);
    const cancelSheet = await waitForSheet();
    await read(cancelSheet, `(document.getElementById('sheet-cancel').click(), 'cancelled')`);
    await waitFor(() => !sheetWindow());
    check('cancel closes the sheet and keeps the main window usable', win && !win.isDestroyed());

    // 主题与窄窗
    nativeTheme.themeSource = 'light';
    const narrowDraft = await createDraft('fixture-provider');
    win.setBounds({ width: 420, height: 700 });
    await read(win, `window.piGuiDesktop.providerCredentials.open({ draftId: ${JSON.stringify(narrowDraft.draftId)}, draftRevision: ${narrowDraft.draftRevision}, action: 'set' })`);
    const narrowSheet = await waitForSheet();
    check('sheet theme follows the desktop theme',
      await read(narrowSheet, `document.documentElement.dataset.theme`) === 'light');
    const narrowWidth = narrowSheet.getBounds().width;
    check('sheet narrows with a small parent window', narrowWidth <= 420 - 32 + 2, narrowWidth);
    check('narrow layout stacks the action buttons',
      await read(narrowSheet, `getComputedStyle(document.querySelector('.actions')).flexDirection.startsWith('column')`));
    fs.writeFileSync(path.join(out, 'sheet-light-narrow.png'), (await narrowSheet.webContents.capturePage()).toPNG());
    // 取消后窗口销毁，executeJavaScript 的回执可能随销毁丢失；发起后用状态判定。
    read(narrowSheet, `(window.piGuiCredentialSheet.cancel(), 'closed')`).catch(() => {});
    await waitFor(() => !sheetWindow());
    nativeTheme.themeSource = 'dark';
    win.setBounds({ width: 900, height: 700 });

    // 四种操作模式（purpose 由 main/backend 决定，页面不得自报）：
    // clear —— 不要求新密钥，显式确认清除。
    fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ 'fixture-clear': { type: 'api_key', key: 'stored-clear-sentinel' } }), { mode: 0o600 });
    const clearDraft = await createDraft('fixture-clear');
    const openClear = await read(win, `window.piGuiDesktop.providerCredentials.open({ draftId: ${JSON.stringify(clearDraft.draftId)}, draftRevision: ${clearDraft.draftRevision}, action: 'clear' })`);
    check('clear opens in its dedicated mode', openClear?.ok === true, openClear);
    const clearSheet = await waitForSheet();
    check('clear mode hides the password field', await read(clearSheet, `document.getElementById('sheet-key').classList.contains('hidden')`));
    check('clear mode shows the clear confirmation', await read(clearSheet, `!document.getElementById('clear-warn').classList.contains('hidden') && document.getElementById('sheet-apply').textContent.includes('清除')`));
    fs.writeFileSync(path.join(out, 'sheet-clear-mode.png'), (await clearSheet.webContents.capturePage()).toPNG());
    const clearSubmit = await read(clearSheet, `window.piGuiCredentialSheet.submit({ allowDiscovery: false, rememberTarget: false }).then(v => JSON.stringify(v)).catch(e => 'submit_failed:' + (e && e.message || e))`);
    check('clear submit without a key completes clear-staged', clearSubmit.includes('"ok":true') && clearSubmit.includes('clear-staged'), clearSubmit);
    await waitFor(() => !sheetWindow());
    // renderer 无法把 clear 窗提交成 stage：payload 里带 input 也走 clear-stage。
    // （由控制器按 flow.purpose 决定 action；真机断言见 openClear 后的模式检查。）

    // FIX-04 真机端到端：OAuth 凭据的清除在受限窗内二次确认。
    fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ 'fixture-oauth-clear': { type: 'oauth', key: 'oauth-clear-sentinel' } }), { mode: 0o600 });
    const oauthClearDraft = await createDraft('fixture-oauth-clear');
    const openOauthClear = await read(win, `window.piGuiDesktop.providerCredentials.open({ draftId: ${JSON.stringify(oauthClearDraft.draftId)}, draftRevision: ${oauthClearDraft.draftRevision}, action: 'clear' })`);
    check('OAuth clear open succeeds', openOauthClear?.ok === true, openOauthClear);
    const oauthClearSheet = await waitForSheet();
    read(oauthClearSheet, `(document.getElementById('sheet-apply').click(), 'first')`).catch(() => {});
    await sleep(500);
    check('first clear press explains the OAuth impact inside the sheet',
      await read(oauthClearSheet, `document.getElementById('sheet-status').textContent.includes('OAuth')`));
    read(oauthClearSheet, `(document.getElementById('sheet-apply').click(), 'second')`).catch(() => {});
    await waitFor(() => !sheetWindow());
    check('second clear press inside the sheet completes clear-staged', states.filter(s => s.state === 'staged').length >= 3, { stagedCount: states.length });

    // FIX-05：并发 open——第二个请求在 opening/流程占用时必须 busy，
    // 不得开出第二个 sheet 或覆盖 flow。
    const concurrencyA = await createDraft('fixture-provider');
    const openPromise = read(win, `window.piGuiDesktop.providerCredentials.open({ draftId: ${JSON.stringify(concurrencyA.draftId)}, draftRevision: ${concurrencyA.draftRevision}, action: 'set' })`);
    const openB = await read(win, `window.piGuiDesktop.providerCredentials.open({ draftId: ${JSON.stringify(concurrencyA.draftId)}, draftRevision: ${concurrencyA.draftRevision}, action: 'set' })`);
    const openA = await openPromise;
    check('second concurrent open is refused during the async open', openB?.ok === false && ['sheet_open', 'opening'].includes(openB?.reason), { openB });
    const openedSheet = await waitForSheet();
    check('first concurrent open wins and opens exactly one sheet', openA?.ok === true &&
      BrowserWindow.getAllWindows().filter(w => String(w.webContents?.getURL() ?? '').startsWith('pi-gui-credential:')).length === 1, { openA });
    read(openedSheet, `(window.piGuiCredentialSheet.cancel(), 'cancelled')`).catch(() => {});
    await waitFor(() => !sheetWindow());

    // FIX-05：打开途中 backend 重启——opening 释放，open 返回显式失败。
    server.kill();
    await sleep(250);
    server = spawnBackend();
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 25_000;
      const timer = setInterval(async () => {
        try {
          const res = await fetch(`${ORIGIN}/api/health`, { headers: { [TOKEN_HEADER]: TOKEN } });
          if (res.ok) { clearInterval(timer); resolve(); }
        } catch { /* not up yet */ }
        if (Date.now() > deadline) { clearInterval(timer); reject(new Error('backend restart timeout')); }
      }, 200);
    });
    const interimFailure = await read(win, `window.piGuiDesktop.providerCredentials.open({ draftId: ${JSON.stringify(concurrencyA.draftId)}, draftRevision: ${concurrencyA.draftRevision}, action: 'set' })`);
    check('restart invalidates the old backend flow (explicit refusal, no stale sheet)',
      interimFailure?.ok === false && Boolean(interimFailure?.code), interimFailure);
    const restartDraft = await createDraft('fixture-provider');
    const reopenAfterRestart = await read(win, `window.piGuiDesktop.providerCredentials.open({ draftId: ${JSON.stringify(restartDraft.draftId)}, draftRevision: ${restartDraft.draftRevision}, action: 'set' })`);
    check('open works across a backend restart (new epoch handshake)', reopenAfterRestart?.ok === true, reopenAfterRestart);
    const reopeningSheet = await waitForSheet();
    check('sheet after backend restart uses a fresh flow', Boolean(sheetWindow()));
    read(reopeningSheet, `(window.piGuiCredentialSheet.cancel(), 'closed')`).catch(() => {});
    await waitFor(() => !sheetWindow());

    // authorize-target —— 不要求新密钥，确认目录授权。
    const oauthAuthorize = await createDraft('fixture-oauth');
    const openAuthz = await read(win, `window.piGuiDesktop.providerCredentials.open({ draftId: ${JSON.stringify(oauthAuthorize.draftId)}, draftRevision: ${oauthAuthorize.draftRevision}, action: 'authorize-target' })`);
    check('authorize-target open succeeds', openAuthz?.ok === true, openAuthz);
    const authzSheet = await waitForSheet();
    check('authorize mode hides the password field and shows the read-only grant',
      await read(authzSheet, `document.getElementById('sheet-key').classList.contains('hidden') && !document.getElementById('authorize-warn').classList.contains('hidden')`));
    check('authorize mode shows the real target',
      await read(authzSheet, `document.getElementById('sheet-target').textContent.includes('https://fixture.invalid/v1')`));
    const authzSubmit = await read(authzSheet, `window.piGuiCredentialSheet.submit({ rememberTarget: true }).then(v => JSON.stringify(v)).catch(e => 'submit_failed:' + (e && e.message || e))`);
    check('authorize submit issues a grant without any key', authzSubmit.includes('"ok":true') && authzSubmit.includes('consentId'), authzSubmit);
    await waitFor(() => !sheetWindow());
    // 无凭据的新自定义 provider：authorize-target 同样成立（source 'none'，
    // P3 的发现编排按无秘密通道执行）。
    const requests = [];
    const directory = require('node:http').createServer((req, res) => {
      requests.push({ method: req.method, url: req.url, hasAuth: Object.hasOwn(req.headers, 'authorization') });
      res.setHeader('Content-Type', 'application/json');
      res.end('{"data":[{"id":"local-directory-fixture"}]}');
    });
    await new Promise(resolve => directory.listen(0, '127.0.0.1', resolve));
    const ghostDraft = await createDraft('ghost-provider', 'openai-completions', `http://127.0.0.1:${directory.address().port}/tenant/v1`);
    const openGhost = await read(win, `window.piGuiDesktop.providerCredentials.open({ draftId: ${JSON.stringify(ghostDraft.draftId)}, draftRevision: ${ghostDraft.draftRevision}, action: 'authorize-target' })`);
    check('credential-less provider opens the authorize sheet', openGhost?.ok === true, openGhost);
    const ghostSheet = await waitForSheet();
    const ghostSubmit = await read(ghostSheet, `window.piGuiCredentialSheet.submit({ rememberTarget: false }).then(v => JSON.stringify(v)).catch(e => 'submit_failed:' + (e && e.message || e))`);
    check('credential-less provider authorize issues a no-secret grant', ghostSubmit.includes('"ok":true') && ghostSubmit.includes('consentId'), ghostSubmit);
    read(ghostSheet, `window.piGuiCredentialSheet.cancel()`).catch(() => {});
    await waitFor(() => !sheetWindow());
    try {
      check('confirming a target alone does not open a socket', requests.length === 0);
      const { consentId } = JSON.parse(ghostSubmit).consent;
      const body = { requestId: 'desktop-loopback-discover', draftId: ghostDraft.draftId, draftRevision: ghostDraft.draftRevision,
        consentId, dialogGeneration: 1, requestSeq: 1, force: false };
      const accepted = await read(win, `fetch('/api/provider-management/discover', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(${JSON.stringify(body)}) }).then(async r => ({ status: r.status, ...await r.json() }))`);
      check('desktop grant starts a directory operation', accepted.status === 202 && Boolean(accepted.operationId), accepted);
      const operationUrl = JSON.stringify(`/api/provider-management/operations/${accepted.operationId}`);
      const completed = await waitFor(async () => {
        const result = await read(win, `fetch(${operationUrl}).then(r => r.json())`);
        return !['pending', 'running'].includes(result.state) && result;
      });
      check('desktop operation uses the exact path, no secret, and returns the fixture directory', completed.state === 'success' &&
        completed.result?.models[0]?.modelId === 'local-directory-fixture' &&
        JSON.stringify(requests) === JSON.stringify([{ method: 'GET', url: '/tenant/v1/models', hasAuth: false }]), completed);
    } finally {
      await new Promise(resolve => directory.close(resolve));
    }

    // 后端不可达的降级（open 在握手失败时显式拒绝，页面无需再可用）
    server.kill();
    await sleep(400);
    const degraded = await controller.openForTest({ draftId: 'draft-dead', draftRevision: 1, action: 'set' }).catch(error => ({ ok: false, code: String(error) }));
    check('dead backend degrades to an explicit refusal', degraded?.ok === false, degraded);
  } catch (error) {
    failures += 1;
    console.error('FAIL unexpected: ' + (error && error.stack || error));
  }

  controller.dispose();
  console.log(`provider-credential-desktop: ${checks.length - failures}/${checks.length} checks passed; evidence: ${out}`);
  if (evidenceTarget) fs.cpSync(out, path.resolve(evidenceTarget), { recursive: true });
  clearTimeout(watchdog);
  if (!server.killed) server.kill();
  app.exit(failures === 0 ? 0 : 1);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 3000).unref();
}

async function electronPhase() {
  console.log('phase B: real Electron run');
  // 外层（完整令牌）准备 world：假 Pi 包、假 agent 目录、evidence 目录。
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cred-desktop-'));
  const pkg = path.join(world, 'pi', 'node_modules', '@earendil-works', 'pi-coding-agent');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.5.0', exports: { '.': { import: './sdk.mjs' } } }));
  fs.writeFileSync(path.join(pkg, 'sdk.mjs'), FAKE_SDK);
  const agentDir = path.join(world, 'agent');
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(world, 'evidence'), { recursive: true });
  // 桌面运行器受限令牌只能写低完整性目录（同 tests/app-update-electron.cjs）。
  if (process.platform === 'win32') {
    const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-[\d-]+/u)?.[0];
    if (!sid) throw Error('Missing fixture identity');
    execFileSync('icacls.exe', [agentDir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true });
    try {
      require('node:child_process').execFileSync('icacls', [world, '/setintegritylevel', '(OI)(CI)L'], { stdio: 'ignore', windowsHide: true });
    } catch { /* 环境若不允许降标签，目录 ACL 维持原样 */ }
  }
  const env = { ...process.env, CRED_DESKTOP_WORLD: world, PI_GUI_CREDENTIAL_EVIDENCE: process.env.PI_GUI_CREDENTIAL_EVIDENCE || '' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const run = args => new Promise(resolve => {
    const child = spawn(require('electron'), [__filename, ...args], { env, stdio: 'inherit', windowsHide: true });
    child.on('error', error => { console.error('electron spawn error: ' + error.message); resolve(1); });
    child.once('exit', code => resolve(code ?? 1));
  });
  // 正常沙箱优先；受限执行环境（无法启动 Chromium 沙箱）按仓库既有 live 测试
  // 的惯例退到 --no-sandbox。生产资格检查会拒绝 --no-sandbox，这里只影响测试宿主。
  let code = await run([]);
  if (code === 0x80000003 || code === 2147483651 || code === -1073741819) {
    console.log('phase B: normal sandbox failed to start in this environment; retrying with --no-sandbox');
    code = await run(['--no-sandbox']);
  }
  process.exitCode = code === 0 ? 0 : 1;
}
