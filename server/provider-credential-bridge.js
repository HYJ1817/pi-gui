/* 供应商管理 P2：backend 侧私有凭据桥（main ↔ backend 的具名 IPC）。
 *
 * 通道与合同（前端合同「Electron 私有凭据合同」已冻结）：
 *   - 请求只来自 Electron 主进程的直属 IPC 子进程（server.js 的 process.on('message')），
 *     不存在 HTTP 路由；帧先过 validateCredentialFrame，再验 backendEpoch。
 *   - epoch 在本进程启动时生成、只经 capability 握手交给 main；backend 重启即换，
 *     旧 main 持有的 epoch 全部失效（对应设计「任何安装身份/后端 epoch 变化全部撤销」）。
 *   - flow 绑定 draft（draftId+draftRevision+connectionRevision+connection+providerId）；
 *     nonce 单飞、TTL 2 分钟；secret 只出现在 stage 一帧里，绝不写日志/收据/错误。
 *   - 凭据操作全部转交 P1 的 SDK 适配器（stageNativeLogin/stageClear/disposeDraft），
 *     本层不触碰 auth.json，也不解析密钥。
 *
 * 帧里的 nonce 用法：**成功即作废**。失败路径（如 OAuth 同槽冲突需要受限窗内
 * 二次确认）沿用同一 flow 与 nonce——此时密钥本就在受限输入窗 DOM 里，防重放的
 * 目标是跨窗口/跨 flow 重放与成功后的复用，不是阻止用户在同一窗内重新提交。
 */
import { randomUUID } from 'node:crypto';
import { classifyAddress, parseTarget } from './provider-network.js';
import { isOpaqueId, validateCredentialFrame } from '../public/provider-management/contract.js';

const NONCE_TTL_MS = 2 * 60_000;
const MAX_FLOWS = 8;
const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

export function createProviderCredentialBridge({ sdk, draftLookup, consentStore, mutationBlocked = () => false,
  maintenanceLocked = () => false, draftFrozen = () => false, forgetDraft = () => {}, nativePersistence = () => false,
  enabled = false, flowTtlMs = NONCE_TTL_MS, now = Date.now, storedDiscoveryTarget = null } = {}) {
  const epoch = randomUUID();
  const flows = new Map();
  const preparing = new Map();
  const approved = new Map();
  let inFlight = false;
  // 只有 Electron main 经私有 IPC 握手后才置位；HTTP/Web 侧的快照因此永远
  // 看不到开启的桌面能力（open 时 main 还会再做一次自己的环境资格检查）。
  let handshakeSeen = false;

  function prune() {
    const time = now();
    for (const [id, flow] of flows) if (flow.expires <= time) flows.delete(id);
    for (const [id, stage] of approved) if (stage.expires <= time) approved.delete(id);
  }

  async function capability() {
    handshakeSeen = true;
    const stagingEnabled = enabled === true;
    const sdkQualified = stagingEnabled ? await sdk.qualified().catch(() => false) : false;
    return { ok: true, epoch, stagingEnabled, sdkQualified, nativePersistence: sdkQualified && nativePersistence(), flowTtlMs, nonceTtlMs: flowTtlMs };
  }

  /* 给 /api/provider-management 快照的后端侧能力：私桥握手 + 联调开关 + SDK 资格
   * 全部满足才开启输入面相关位。原生持久化还要求存储安全资格（auth.json 的
   * 所有者/权限见证）；不满足时界面必须据实禁用保存，而不是等到写盘才失败。 */
  async function desktopCapability() {
    if (enabled !== true || !handshakeSeen) return null;
    const sdkQualified = await sdk.qualified().catch(() => false);
    if (!sdkQualified) return null;
    return { rawKeyInput: true, keyStaging: true, nativeCredentialPersistence: nativePersistence() === true, privateDesktopBridge: true };
  }

  function bindingOf(flow) {
    return { draftId: flow.draftId, providerId: flow.providerId, connectionRevision: flow.connectionRevision, connection: flow.connection };
  }

  function acceptStage(flow, result, kind) {
    if (!isOpaqueId(result.stagedRevision) || !Number.isFinite(result.expires)) return;
    const prior = approved.get(flow.draftId);
    approved.set(flow.draftId, { binding: bindingOf(flow), revision: result.stagedRevision, kind, expires: result.expires,
      workerEpoch: result.workerEpoch });
    if (prior) void sdk.discardStage?.(flow.draftId, prior.revision);
  }

  function currentApproval(approval) {
    const { binding } = approval;
    const draft = draftLookup?.(binding.draftId);
    return approved.get(binding.draftId) === approval && approval.expires > now() && draft?.expires > now() &&
      draft.connectionRevision === binding.connectionRevision && draft.providerId === binding.providerId &&
      draft.connection.baseUrl === binding.connection.baseUrl && draft.connection.api === binding.connection.api;
  }

  async function invalidateStaleFlow(flow) {
    flows.delete(flow.flowId);
    const approval = approved.get(flow.draftId);
    if (approval && currentApproval(approval)) return;
    approved.delete(flow.draftId);
    consentStore?.revokeDraft(flow.draftId);
    await sdk.disposeDraft(flow.draftId);
  }

  async function authorizeNative({ draftId, providerId, connectionRevision, connection, action }, { signal } = {}) {
    if (signal?.aborted || enabled !== true || guardBusy() || inFlight) return null;
    const approval = approved.get(draftId);
    const kind = action === 'apply-staged' ? 'set' : action === 'clear-native' ? 'clear' : null;
    if (!approval || approval.kind !== kind || !currentApproval(approval) || approval.binding.providerId !== providerId ||
        approval.binding.connectionRevision !== connectionRevision || approval.binding.connection.baseUrl !== connection.baseUrl ||
        approval.binding.connection.api !== connection.api) return null;
    if (!await sdk.canPersist?.(approval.binding, kind) || signal?.aborted || !(await sdk.inspectStage(approval.binding, approval.revision, kind))?.ok) return null;
    return !signal?.aborted && !guardBusy() && !inFlight && currentApproval(approval) ? approval : null;
  }

  function persistApproved(approval, { signal, onQuiesced } = {}) {
    if (signal?.aborted || enabled !== true || guardBusy() || inFlight || !currentApproval(approval)) return fail('credential_conflict', { credentialSaved: false });
    approved.delete(approval.binding.draftId);
    consentStore?.revokeDraft(approval.binding.draftId);
    return approval.kind === 'set' ? sdk.persistNative(approval.binding, approval.revision, { signal, onQuiesced }) :
      sdk.clearNative(approval.binding, approval.revision, { signal, onQuiesced });
  }

  async function qualifyAfterNative(approval, { signal } = {}) {
    if (signal?.aborted || !await sdk.canPersist(approval.binding, approval.kind)) return false;
    const evidence = await sdk.readback(approval.binding.providerId);
    return !signal?.aborted && evidence?.ok === true && isOpaqueId(evidence.credentialRevision) &&
      await sdk.canPersist(approval.binding, approval.kind);
  }

  function currentDiscovery(grant, draft) {
    if (enabled !== true || !isOpaqueId(grant.workerEpoch) || grant.workerEpoch !== sdk.currentWorkerEpoch?.()) return false;
    if (grant.credentialSource === 'none') return true;
    if (grant.credentialSource === 'stored') return storedDiscoveryTarget?.(draft) === true;
    const stage = approved.get(grant.draftId);
    return stage?.kind === 'set' && stage.revision === grant.credentialRevision && stage.workerEpoch === grant.workerEpoch && currentApproval(stage);
  }

  async function verifyDiscovery(grant, draft) {
    if (!currentDiscovery(grant, draft)) return false;
    if (grant.credentialSource === 'staged') return (await sdk.inspectStage(bindingOf(draft), grant.credentialRevision, 'set'))?.ok === true && currentDiscovery(grant, draft);
    const evidence = await sdk.inspectDiscovery(grant.providerId);
    const matches = grant.credentialSource === 'none' ? evidence.present === false :
      evidence.literal === true && evidence.credentialRevision === grant.credentialRevision;
    return matches && evidence.workerEpoch === grant.workerEpoch &&
      currentDiscovery(grant, draft);
  }

  function runDiscovery(grant, draft, options) {
    if (!currentDiscovery(grant, draft)) return Promise.resolve(fail('invalid_target'));
    return sdk.discoverNative(bindingOf(draft), grant, options);
  }

  function draftCurrent(flow) {
    const draft = draftLookup?.(flow.draftId);
    return Boolean(draft && draft.draftRevision === flow.draftRevision && draft.connectionRevision === flow.connectionRevision && draft.expires > now());
  }

  function guardBusy() {
    if (mutationBlocked()) return fail('config_busy', { message: '供应商配置正在被其他进程使用。' });
    if (maintenanceLocked()) return fail('config_busy', { message: '应用维护进行中，请稍后重试。' });
    return null;
  }

  async function prepare(frame) {
    if (enabled !== true) return fail('unsupported');
    const busy = guardBusy();
    if (busy) return busy;
    prune();
    if (flows.size + preparing.size >= MAX_FLOWS) return fail('config_busy', { message: '凭据输入会话数量已达上限。' });
    const draft = typeof draftLookup === 'function' ? draftLookup(frame.draftId) : null;
    if (draftFrozen(frame.draftId)) return fail('config_busy');
    if (!draft || draft.draftRevision !== frame.draftRevision || draft.expires <= now()) {
      return fail('draft_conflict', { message: '草稿已变化，请重读后保存。' });
    }
    // 桌面预分配 ID，允许 cancel 在 prepare 应答前到达。旧帧仍由后端分配 ID。
    const flowId = frame.flowId ?? randomUUID();
    if (preparing.has(flowId) || flows.has(flowId)) return fail('invalid_request');
    const binding = { draftId: draft.draftId, draftRevision: draft.draftRevision, connectionRevision: draft.connectionRevision };
    preparing.set(flowId, binding);
    try {
      const purpose = frame.purpose;
      const inspection = await sdk.inspect(draft.providerId);
      if (preparing.get(flowId) !== binding) return fail('invalid_request');
      const expectsCredential = ['set', 'replace', 'clear'].includes(purpose);
      if (expectsCredential && !(await sdk.qualified().catch(() => false))) return fail('unsupported');
      if (preparing.get(flowId) !== binding) return fail('invalid_request');
      if (!draftCurrent(binding)) return fail('draft_conflict', { message: '草稿已变化，请重读后保存。' });
      const nonce = randomUUID();
      const flow = { ...binding, flowId, promptId: randomUUID(), nonce, purpose,
        connection: draft.connection, providerId: draft.providerId, serviceId: draft.serviceId ?? null,
        api: draft.connection?.api ?? 'openai-completions', expectedCredentialRevision: inspection.credentialRevision ?? null,
        oauthConflict: ['set', 'replace'].includes(purpose) && inspection.present === true && inspection.type === 'oauth',
        oauthConfirmOffered: false, clearConfirmOffered: false, expires: now() + flowTtlMs, lastCredentialState: 'none' };
      flows.set(flowId, flow);
      return { ok: true, flowId, promptId: flow.promptId, nonce, expiresAt: flow.expires,
        targetSummary: { providerId: flow.providerId, baseUrl: draft.connection?.baseUrl ?? null, api: flow.api },
        oauthConflict: flow.oauthConflict,
        credential: { present: inspection.present, type: inspection.type } };
    } finally {
      if (preparing.get(flowId) === binding) preparing.delete(flowId);
    }
  }

  function flowFor(frame) {
    prune();
    const flow = flows.get(frame.flowId);
    if (!flow || flow.promptId !== frame.promptId || flow.nonce !== frame.nonce) return null;
    return flow;
  }

  function consume(flow) {
    flow.nonce = null;
  }

  async function stage(frame) {
    if (enabled !== true) return fail('unsupported');
    const busy = guardBusy();
    if (busy) return busy;
    const flow = flowFor(frame);
    if (!flow || flow.purpose !== 'set' && flow.purpose !== 'replace') return fail('invalid_request');
    if (!draftCurrent(flow)) {
      await invalidateStaleFlow(flow);
      return fail('credential_conflict', { message: '无法证明目标没有存量凭据，请检查 Pi 认证或换用新标识。' });
    }
    if (inFlight || draftFrozen(flow.draftId)) return fail('config_busy', { message: '凭据操作进行中，请稍后重试。' });
    inFlight = true;
    try {
      const result = await sdk.stageNativeLogin(bindingOf(flow), frame.input,
        { expectedCredentialRevision: flow.expectedCredentialRevision, confirmOAuthReplacement: flow.oauthConfirmOffered,
          retain: approved.get(flow.draftId)?.revision });
      if (result?.ok !== true) {
        if (result?.code === 'oauth_conflict') flow.oauthConfirmOffered = true;
        if (result?.code === 'expired') flow.lastCredentialState = 'expired';
        return { ...fail(result?.code ?? 'credential_conflict'), credentialState: result?.credentialState ?? 'none' };
      }
      const current = flowFor(frame) === flow && draftCurrent(flow) && !draftFrozen(flow.draftId) && !guardBusy();
      if (!current) {
        void sdk.discardStage?.(flow.draftId, result.stagedRevision);
        return fail('credential_conflict');
      }
      consume(flow);
      acceptStage(flow, result, 'set');
      flow.lastCredentialState = result.credentialState ?? 'staged';
      // 暂存替换不改变原生凭据修订号。使用 worker 的新代次并使此前授权失效。
      consentStore?.revokeDraft(flow.draftId);
      let consent = null;
      if (frame.allowDiscovery === true && isOpaqueId(result.stagedRevision)) {
        const issued = consentStore?.issue({ draftId: flow.draftId, draftRevision: flow.draftRevision,
          connectionRevision: flow.connectionRevision, providerId: flow.providerId, connection: flow.connection,
          api: flow.api, credentialSource: 'staged', credentialRevision: result.stagedRevision,
          workerEpoch: result.workerEpoch,
          rememberTarget: frame.rememberTarget === true, loopback: false });
        if (issued?.ok === true) consent = { consentId: issued.consentId, expiresAt: issued.expiresAt, targetSummary: issued.targetSummary };
      }
      return { ok: true, credentialState: flow.lastCredentialState, credentialSaved: null, consent };
    } finally {
      inFlight = false;
    }
  }

  async function stageClear(frame) {
    if (enabled !== true) return fail('unsupported');
    const busy = guardBusy();
    if (busy) return busy;
    const flow = flowFor(frame);
    if (!flow || flow.purpose !== 'clear' || frame.confirmed !== true) return fail('invalid_request');
    if (!draftCurrent(flow)) {
      await invalidateStaleFlow(flow);
      return fail('credential_conflict');
    }
    if (inFlight || draftFrozen(flow.draftId)) return fail('config_busy', { message: '凭据操作进行中，请稍后重试。' });
    inFlight = true;
    try {
      /* OAuth 凭据与替换共用同一原生槽：清除同样需要在受限窗内显式
       * 二次确认（worker 层拒绝非确认调用）。首次尝试不带确认；遇到
       * oauth_conflict 时保持 flow 与 nonce 可用，让输入窗按要求展示
       * 影响说明后带确认重试（与替换同一交互纪律）。 */
      const options = { expectedCredentialRevision: flow.expectedCredentialRevision, confirmed: true, retain: approved.get(flow.draftId)?.revision };
      let result = await sdk.stageClear(bindingOf(flow), options);
      if (flowFor(frame) !== flow || !draftCurrent(flow) || draftFrozen(flow.draftId) || guardBusy()) {
        void sdk.discardStage?.(flow.draftId, result?.stagedRevision);
        return fail('credential_conflict');
      }
      if (result?.ok !== true && result?.code === 'oauth_conflict' && !flow.clearConfirmOffered) {
        flow.clearConfirmOffered = true;
        return { ok: false, code: 'oauth_conflict', message: '待清除的是 OAuth 登录凭据。确认后同槽的原生登录将被清除，且旧登录无法从 GUI 恢复。' };
      }
      if (result?.ok !== true && result?.code === 'oauth_conflict' && flow.clearConfirmOffered) {
        result = await sdk.stageClear(bindingOf(flow), { ...options, confirmOAuthReplacement: true });
      }
      if (result?.ok !== true) return { ...fail(result?.code ?? 'credential_conflict'), credentialState: result?.credentialState ?? 'none' };
      if (flowFor(frame) !== flow || !draftCurrent(flow) || draftFrozen(flow.draftId) || guardBusy()) {
        void sdk.discardStage?.(flow.draftId, result.stagedRevision);
        return fail('credential_conflict');
      }
      consume(flow);
      acceptStage(flow, result, 'clear');
      flow.lastCredentialState = result.credentialState ?? 'clear-staged';
      consentStore?.revokeDraft(flow.draftId);
      return { ok: true, credentialState: flow.lastCredentialState, credentialSaved: null };
    } finally {
      inFlight = false;
    }
  }

  async function authorizeTarget(frame) {
    if (enabled !== true) return fail('unsupported');
    const busy = guardBusy();
    if (busy) return busy;
    const flow = flowFor(frame);
    if (!flow || flow.purpose !== 'authorize-target' || frame.confirmed !== true) return fail('invalid_request');
    if (!draftCurrent(flow)) {
      flows.delete(flow.flowId);
      return fail('credential_conflict');
    }
    /* P5：刚在受限窗里暂存、尚未写盘的密钥也应能授权发现。此时 auth.json
     * 还是旧状态，inspectDiscovery 看不到它；授权必须绑定到 approved 暂存
     * 代次，否则会用一个「无凭据」授权去访问需要认证的目录。 */
    const stage = approved.get(flow.draftId);
    const staged = stage?.kind === 'set' && currentApproval(stage) ? stage : null;
    const inspection = staged ? null : await (storedDiscoveryTarget ? sdk.inspectDiscovery(flow.providerId) : sdk.inspect(flow.providerId));
    if (flowFor(frame) !== flow || !draftCurrent(flow)) return fail('credential_conflict');
    const credentialSource = staged ? 'staged' : inspection.present === true ? 'stored' : inspection.present === false ? 'none' : null;
    // present=null（文件不可读/冲突/未知类型）不能当作「没有凭据」开授权——宁可多确认一次。
    if (!credentialSource) return fail('credential_conflict');
    const draft = draftLookup(flow.draftId);
    if (storedDiscoveryTarget && !staged && credentialSource === 'stored' && (inspection.literal !== true || !storedDiscoveryTarget(draft))) return fail('policy_rejected');
    const target = parseTarget(flow.connection.baseUrl);
    const issued = consentStore?.issue({ draftId: flow.draftId, draftRevision: flow.draftRevision,
      connectionRevision: flow.connectionRevision, providerId: flow.providerId, connection: flow.connection,
      api: flow.api, credentialSource,
      credentialRevision: staged ? staged.revision : credentialSource === 'stored' ? inspection.credentialRevision : null,
      workerEpoch: staged ? staged.workerEpoch : inspection.workerEpoch,
      rememberTarget: frame.rememberTarget === true, loopback: credentialSource === 'none' &&
        (target?.isLoopbackName === true || classifyAddress(target?.host) === 'loopback') });
    if (issued?.ok !== true) return fail(issued?.code ?? 'policy_rejected');
    consume(flow);
    return { ok: true, consent: { consentId: issued.consentId, expiresAt: issued.expiresAt, targetSummary: issued.targetSummary } };
  }

  function status(frame) {
    prune();
    const flow = flows.get(frame.flowId);
    if (!flow) return { ok: true, state: 'none' };
    return { ok: true, state: flow.lastCredentialState, purpose: flow.purpose, expiresAt: flow.expires, draftId: flow.draftId };
  }

  function cancel(frame) {
    preparing.delete(frame.flowId);
    flows.delete(frame.flowId);
    return { ok: true };
  }

  function closeDraft(frame) {
    for (const [id, binding] of preparing) if (binding.draftId === frame.draftId) preparing.delete(id);
    for (const [id, flow] of flows) if (flow.draftId === frame.draftId) flows.delete(id);
    consentStore?.revokeDraft(frame.draftId);
    approved.delete(frame.draftId);
    void sdk.disposeDraft(frame.draftId);
    return { ok: true };
  }

  function closeForm(frame) {
    if (draftFrozen(frame.draftId)) return fail('config_busy');
    forgetDraft(frame.draftId);
    return closeDraft(frame);
  }

  const actions = new Map([
    ['capability', frame => capability()],
    ['prepare', frame => prepare(frame)],
    ['stage', frame => stage(frame)],
    ['clear-stage', frame => stageClear(frame)],
    ['authorize-target', frame => authorizeTarget(frame)],
    ['status', frame => status(frame)],
    ['cancel', frame => cancel(frame)],
    ['close-draft', frame => closeForm(frame)],
  ]);

  /** server.js 的 IPC 入口：先按冻结合同校验帧形，再验 epoch，再分发。 */
  async function handle(frame) {
    try {
      const safe = validateCredentialFrame(frame);
      if (safe.action !== 'capability' && safe.backendEpoch !== epoch) return fail('unsupported');
      const runner = actions.get(safe.action);
      if (!runner) return fail('invalid_request');
      return await runner(safe);
    } catch {
      return fail('invalid_request');
    }
  }

  function dispose() {
    preparing.clear();
    for (const id of new Set([...approved.keys(), ...[...flows.values()].map(flow => flow.draftId)])) void sdk.disposeDraft(id);
    approved.clear();
    flows.clear();
    consentStore?.dispose();
  }

  return { handle, dispose, epoch, desktopCapability, authorizeNative, persistApproved, qualifyAfterNative,
    currentDiscovery, verifyDiscovery, runDiscovery,
    invalidateDraft: draftId => closeDraft({ draftId }), get activeFlows() { prune(); return flows.size; } };
}
