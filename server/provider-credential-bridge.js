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
import { isOpaqueId, validateCredentialFrame } from '../public/provider-management/contract.js';

const NONCE_TTL_MS = 2 * 60_000;
const MAX_FLOWS = 8;
const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

export function createProviderCredentialBridge({ sdk, draftLookup, consentStore, mutationBlocked = () => false,
  maintenanceLocked = () => false, enabled = false, flowTtlMs = NONCE_TTL_MS, now = Date.now } = {}) {
  const epoch = randomUUID();
  const flows = new Map();
  const preparing = new Map();
  let inFlight = false;
  // 只有 Electron main 经私有 IPC 握手后才置位；HTTP/Web 侧的快照因此永远
  // 看不到开启的桌面能力（open 时 main 还会再做一次自己的环境资格检查）。
  let handshakeSeen = false;

  function prune() {
    const time = now();
    for (const [id, flow] of flows) if (flow.expires <= time) flows.delete(id);
  }

  async function capability() {
    handshakeSeen = true;
    const stagingEnabled = enabled === true;
    const sdkQualified = stagingEnabled ? await sdk.qualified().catch(() => false) : false;
    return { ok: true, epoch, stagingEnabled, sdkQualified, flowTtlMs, nonceTtlMs: flowTtlMs };
  }

  /* 给 /api/provider-management 快照的后端侧能力：私桥握手 + 联调开关 + SDK 资格
   * 全部满足才开启输入面相关位；原生持久化编排仍属 P3，恒为 false。 */
  async function desktopCapability() {
    if (enabled !== true || !handshakeSeen) return null;
    const sdkQualified = await sdk.qualified().catch(() => false);
    if (!sdkQualified) return null;
    return { rawKeyInput: true, keyStaging: true, nativeCredentialPersistence: false, privateDesktopBridge: true };
  }

  function bindingOf(flow) {
    return { draftId: flow.draftId, providerId: flow.providerId, connectionRevision: flow.connectionRevision, connection: flow.connection };
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
      flows.delete(flow.flowId);
      await sdk.disposeDraft(flow.draftId);
      return fail('credential_conflict', { message: '无法证明目标没有存量凭据，请检查 Pi 认证或换用新标识。' });
    }
    if (inFlight) return fail('config_busy', { message: '凭据操作进行中，请稍后重试。' });
    inFlight = true;
    try {
      const result = await sdk.stageNativeLogin(bindingOf(flow), frame.input,
        { expectedCredentialRevision: flow.expectedCredentialRevision, confirmOAuthReplacement: flow.oauthConfirmOffered });
      if (result?.ok !== true) {
        if (result?.code === 'oauth_conflict') flow.oauthConfirmOffered = true;
        if (result?.code === 'expired') flow.lastCredentialState = 'expired';
        return { ...fail(result?.code ?? 'credential_conflict'), credentialState: result?.credentialState ?? 'none' };
      }
      const current = flowFor(frame) === flow && draftCurrent(flow);
      consume(flow);
      flow.lastCredentialState = result.credentialState ?? 'staged';
      // 暂存替换不改变原生凭据修订号。使用 worker 的新代次并使此前授权失效。
      consentStore?.revokeDraft(flow.draftId);
      let consent = null;
      if (current && frame.allowDiscovery === true && isOpaqueId(result.stagedRevision)) {
        const issued = consentStore?.issue({ draftId: flow.draftId, draftRevision: flow.draftRevision,
          connectionRevision: flow.connectionRevision, providerId: flow.providerId, connection: flow.connection,
          api: flow.api, credentialSource: 'staged', credentialRevision: result.stagedRevision,
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
      flows.delete(flow.flowId);
      await sdk.disposeDraft(flow.draftId);
      return fail('credential_conflict');
    }
    if (inFlight) return fail('config_busy', { message: '凭据操作进行中，请稍后重试。' });
    inFlight = true;
    try {
      /* OAuth 凭据与替换共用同一原生槽：清除同样需要在受限窗内显式
       * 二次确认（worker 层拒绝非确认调用）。首次尝试不带确认；遇到
       * oauth_conflict 时保持 flow 与 nonce 可用，让输入窗按要求展示
       * 影响说明后带确认重试（与替换同一交互纪律）。 */
      let result = await sdk.stageClear(bindingOf(flow), { expectedCredentialRevision: flow.expectedCredentialRevision, confirmed: true });
      if (result?.ok !== true && result?.code === 'oauth_conflict' && !flow.clearConfirmOffered) {
        flow.clearConfirmOffered = true;
        return { ok: false, code: 'oauth_conflict', message: '待清除的是 OAuth 登录凭据。确认后同槽的原生登录将被清除，且旧登录无法从 GUI 恢复。' };
      }
      if (result?.ok !== true && result?.code === 'oauth_conflict' && flow.clearConfirmOffered) {
        result = await sdk.stageClear(bindingOf(flow), { expectedCredentialRevision: flow.expectedCredentialRevision, confirmed: true, confirmOAuthReplacement: true });
      }
      if (result?.ok !== true) return { ...fail(result?.code ?? 'credential_conflict'), credentialState: result?.credentialState ?? 'none' };
      consume(flow);
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
    const inspection = await sdk.inspect(flow.providerId);
    if (flowFor(frame) !== flow || !draftCurrent(flow)) return fail('credential_conflict');
    const credentialSource = inspection.present === true ? 'stored' : inspection.present === false ? 'none' : null;
    // present=null（文件不可读/冲突/未知类型）不能当作「没有凭据」开授权——宁可多确认一次。
    if (!credentialSource) return fail('credential_conflict');
    const issued = consentStore?.issue({ draftId: flow.draftId, draftRevision: flow.draftRevision,
      connectionRevision: flow.connectionRevision, providerId: flow.providerId, connection: flow.connection,
      api: flow.api, credentialSource, credentialRevision: inspection.credentialRevision,
      rememberTarget: frame.rememberTarget === true, loopback: false });
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
    void sdk.disposeDraft(frame.draftId);
    return { ok: true };
  }

  const actions = new Map([
    ['capability', frame => capability()],
    ['prepare', frame => prepare(frame)],
    ['stage', frame => stage(frame)],
    ['clear-stage', frame => stageClear(frame)],
    ['authorize-target', frame => authorizeTarget(frame)],
    ['status', frame => status(frame)],
    ['cancel', frame => cancel(frame)],
    ['close-draft', frame => closeDraft(frame)],
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
    for (const flow of flows.values()) void sdk.disposeDraft(flow.draftId);
    flows.clear();
    consentStore?.dispose();
  }

  return { handle, dispose, epoch, desktopCapability, get activeFlows() { prune(); return flows.size; } };
}
