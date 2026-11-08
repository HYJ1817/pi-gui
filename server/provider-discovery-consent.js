/* 供应商管理 P2：模型发现授权（consent）绑定存储。
 *
 * 设计（§5.3）：授权由服务端持有——opaque consentId 绑定
 * (draftId, draftRevision, connectionRevision, providerId, scheme+host+port+完整
 * basePath, API 类型, 受限候选路径策略, 凭据来源, 凭据代次)；客户端指纹不是授权。
 * 15 分钟 TTL；撤销立即生效；换目标/换凭据即时失效。
 *
 * P2 边界：rememberTarget 的「记住目标」只保存在本进程内存中的**非秘密**批准
 * 描述（目标、API 类型、不含值的凭据代次），启动后必须重新验证——跨重启的
 * 重授权状态机与磁盘持久化由 P3 接线。P2 不持久化任何 consentId。
 */
import { randomUUID } from 'node:crypto';
import { classifyAddress, parseTarget, planCandidates, planScopedCandidates } from './provider-network.js';
import { isOpaqueId, isProviderId, validateConnection } from '../public/provider-management/contract.js';

const MAX_ACTIVE = 32;
const MAX_REMEMBERED = 64;
const DEFAULT_TTL_MS = 15 * 60_000;

const rememberKey = (id, target) => `${id}\n${target.protocol}\n${target.host}\n${target.port}\n${target.basePath}`;

export function createDiscoveryConsentStore({ ttlMs = DEFAULT_TTL_MS, now = Date.now, strict = false, identityKey = () => null } = {}) {
  const active = new Map();
  const remembered = new Map();

  function prune() {
    const time = now();
    for (const [id, { record }] of active) if (record.expires <= time) revoke(id);
    if (remembered.size > MAX_REMEMBERED) {
      for (const id of remembered.keys()) { remembered.delete(id); if (remembered.size <= MAX_REMEMBERED) break; }
    }
  }

  /** 签发授权。请求字段全部经过桥/合同校验，这里只做绑定与收敛。 */
  function issue(request) {
    prune();
    if (active.size >= MAX_ACTIVE) return { ok: false, code: 'config_busy', message: '发现授权数量已达上限，请稍后重试。' };
    let connection;
    try { connection = validateConnection(request.connection); } catch { return { ok: false, code: 'invalid_request', message: '请求字段无效。' }; }
    const target = parseTarget(connection.baseUrl);
    if (!target) return { ok: false, code: 'invalid_request', message: '请求字段无效。' };
    const credentialSource = ['staged', 'stored', 'environment', 'none'].includes(request.credentialSource) ? request.credentialSource : null;
    if (!credentialSource) return { ok: false, code: 'invalid_request', message: '请求字段无效。' };
    const credentialAttached = credentialSource !== 'none';
    const loopback = request.loopback === true;
    if (loopback && credentialAttached) return { ok: false, code: 'policy_rejected', message: '该目标不允许携带凭据或不在已授权的路径策略内。' };
    if (strict && (request.api !== connection.api || !isOpaqueId(request.draftId) || !isProviderId(request.providerId) ||
        (credentialAttached ? !isOpaqueId(request.credentialRevision) : request.credentialRevision != null) ||
        (['staged', 'stored'].includes(credentialSource) && !isOpaqueId(request.workerEpoch)) ||
        (loopback && !target.isLoopbackName && classifyAddress(target.host) !== 'loopback') ||
        (target.protocol !== 'https' && !loopback))) return { ok: false, code: 'policy_rejected' };
    const candidatePaths = (strict ? planScopedCandidates(connection) : planCandidates(connection, request.api)).slice(0, 8);
    if (!candidatePaths.length) return { ok: false, code: 'invalid_request', message: '请求字段无效。' };
    if (strict) revokeDraft(request.draftId);
    const consentId = randomUUID();
    const expires = now() + ttlMs;
    const record = {
      consentId, draftId: request.draftId, draftRevision: request.draftRevision,
      connectionRevision: request.connectionRevision, providerId: request.providerId,
      api: request.api, target: Object.freeze(target), candidatePaths: Object.freeze(candidatePaths), credentialSource, credentialAttached, loopback,
      credentialRevision: request.credentialRevision ?? null, expires, rememberTarget: request.rememberTarget === true,
      workerEpoch: request.workerEpoch ?? null,
      launchIdentity: identityKey(),
      scoped: strict,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => revoke(consentId), ttlMs);
    timer.unref?.();
    active.set(consentId, { record: Object.freeze(record), controller, timer });
    if (record.rememberTarget && !loopback && credentialSource !== 'staged') {
      // 只记非秘密批准描述：目标、API、凭据来源与代次。凭据代次变化后重开必须重确认。
      remembered.set(rememberKey(request.providerId, target), {
        consentId, providerId: request.providerId, api: request.api, target, credentialSource,
        credentialRevision: record.credentialRevision, createdAt: now(),
      });
    }
    return { ok: true, consentId, expiresAt: expires,
      targetSummary: { providerId: request.providerId, baseUrl: connection.baseUrl, api: request.api },
      candidatePaths: [...candidatePaths], credentialAttached, loopback };
  }

  function get(consentId, { now: at = now } = {}) {
    if (!isOpaqueId(consentId)) return null;
    const record = active.get(consentId)?.record;
    if (!record) return null;
    if (record.expires <= at() || record.launchIdentity !== identityKey()) { revoke(consentId); return null; }
    return record;
  }

  function revoke(consentId) {
    const entry = active.get(consentId);
    if (!entry) return false;
    active.delete(consentId);
    clearTimeout(entry.timer);
    entry.controller.abort();
    return true;
  }

  function signalFor(consentId) {
    return active.get(consentId)?.controller.signal;
  }

  function revokeAndForget(consentId) {
    const record = active.get(consentId)?.record;
    const key = record ? rememberKey(record.providerId, record.target) : [...remembered].find(([, item]) => item.consentId === consentId)?.[0];
    const forgotten = key && remembered.get(key)?.consentId === consentId ? remembered.delete(key) : false;
    return revoke(consentId) || forgotten;
  }

  function forDraft(draftId) {
    for (const [id, { record }] of active) if (record.draftId === draftId) return get(id);
    return null;
  }

  function revokeDraft(draftId) {
    let removed = 0;
    for (const [id, { record }] of active) if (record.draftId === draftId && revoke(id)) removed += 1;
    return removed;
  }

  /** 目标或连接代次变化：撤掉该草稿在旧绑定上的全部授权。 */
  function revokeDraftConnection(draftId, connectionRevision) {
    let removed = 0;
    for (const [id, { record }] of active) {
      if (record.draftId === draftId && record.connectionRevision !== connectionRevision && revoke(id)) removed += 1;
    }
    return removed;
  }

  /** 重开核对：只有目标、API、凭据来源与凭据代次全部一致才认可「记住的目标」。 */
  function matchRemembered({ providerId, connection, api, credentialSource, credentialRevision }) {
    prune();
    const target = parseTarget(connection?.baseUrl);
    if (!target) return null;
    const record = remembered.get(rememberKey(providerId, target));
    if (!record || record.api !== api || record.credentialSource !== credentialSource ||
        (record.credentialRevision ?? null) !== (credentialRevision ?? null)) return null;
    return { ...record, remembered: true };
  }

  function forgetDraft(providerId) {
    for (const key of [...remembered.keys()]) if (remembered.get(key).providerId === providerId) remembered.delete(key);
  }

  function dispose() {
    for (const id of active.keys()) revoke(id);
    remembered.clear();
  }

  return { issue, get, forDraft, signalFor, revoke, revokeAndForget, revokeDraft, revokeDraftConnection, matchRemembered, forgetDraft, dispose,
    get size() { prune(); return active.size; } };
}
