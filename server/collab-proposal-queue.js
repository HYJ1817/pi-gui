// 可信 Agent 建议队列（阶段 B）。
//
// 职责：只保存「已经通过来源验证 + 严格 schema 校验」的建议信封；注册后内容
// 不可变（深冻结 + 规范化摘要绑定 proposalId）；同 scope 同文档的新建议使旧
// 的未决建议作废（supersede）；容量与 TTL 有界。纯内存、无 IO、无网络。
//
// 边界（与 docs/Z4-3-agent-source-contract.md 一致）：
// - 本模块不做文档状态校验（引用存在/revision 冲突），那由 lib/collab-doc.js
//   在 preview/accept 时按 Z4-2 既有语义执行；这里只做信封的结构收口。
// - opId 级重放（同 opId 不同内容）由文档幂等日志在应用时拒绝；队列层的
//   身份重放指 proposalId 复用，见 register()。
// - scope 失效（owner/代次/会话变化）不靠本模块主动删除：访问时 scopeToken
//   不匹配即不可见，失效条目由容量/TTL 淘汰。

import { createHash } from 'node:crypto';

const fail = code => { throw Object.assign(Error(code), { code }); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const hex = value => typeof value === 'string' && /^[0-9a-f]{16,128}$/.test(value);

/** 规范化序列化：对象键递归排序后序列化，键顺序不影响摘要。
 *  与 lib/collab-doc.js 的操作指纹是两个用途（队列信封摘要 vs 单操作幂等指纹），
 *  独立实现，不引入第二套 revision/CAS/幂等模型。 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}

/** 队列信封摘要：绑定 proposalId 与操作内容（阶段 B 第 8 条）。 */
export function proposalDigest({ documentId, baseRevision, sessionId, rationale, ops }) {
  return createHash('sha256').update(JSON.stringify(canonical(
    { version: 1, documentId, baseRevision, sessionId, rationale, ops }))).digest('hex');
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value)) deepFreeze(value[k]);
    Object.freeze(value);
  }
  return value;
}

/** 可解析状态：pending 等待用户决定；accepted/rejected 已终局但保留证据
 *  （重复接受需按 Z4-2 语义返回 duplicate）。superseded/expired 不可再解析。 */
const RESOLVABLE = new Set(['pending', 'accepted', 'rejected']);

export function createProposalQueue({
  capacity = 32,
  pendingTtlMs = 30 * 60 * 1000,
  now = () => Date.now(),
  randomId = () => globalThis.crypto.randomUUID(),
} = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024) fail('queue_config');
  if (!Number.isSafeInteger(pendingTtlMs) || pendingTtlMs < 1000) fail('queue_config');
  const entries = new Map(); // proposalId → entry（插入序 = 注册序）

  function expireIfDue(entry) {
    if (entry.status === 'pending' && now() - entry.createdAt > pendingTtlMs) entry.status = 'expired';
  }

  function evictFinalized() {
    // 淘汰优先级：作废/过期最先；rejected 无后续用途次之；accepted 保留到最后
    // （重复接受依赖其证据返回幂等结果）。
    for (const status of ['superseded', 'expired', 'rejected', 'accepted']) {
      for (const [key, entry] of entries) {
        if (entry.status === status) { entries.delete(key); return true; }
      }
    }
    return false;
  }

  /**
   * 注册一条已验证建议。ops 必须已经过 lib/collab-doc.js 的 createProposal
   * 校验并由来源适配器重编号；这里只做结构性复核。
   * 同 scopeKey+documentId 的旧 pending 一律 supersede：重新生成不允许旧建议
   * 继续可用。返回 {ok,proposalId,digest,duplicate?} 或 {ok:false,code}。
   */
  function register({ proposalId = null, scopeKey, scopeToken, sessionId, documentId, baseRevision, rationale, ops, run = null } = {}) {
    if (!hex(scopeKey) || !hex(scopeToken)) fail('queue_scope');
    if (!id(sessionId) || !id(documentId)) fail('queue_schema');
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 1) fail('queue_schema');
    if (typeof rationale !== 'string' || rationale.length > 2000) fail('queue_schema');
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > 50
      || ops.some(op => !op || typeof op !== 'object' || op.actor !== 'agent' || op.baseRevision !== baseRevision)) {
      fail('queue_schema');
    }
    const digest = proposalDigest({ documentId, baseRevision, sessionId, rationale, ops });
    if (proposalId !== null) {
      if (!id(proposalId)) fail('queue_schema');
      const existing = entries.get(proposalId);
      if (existing) {
        // 同 ID 同内容 → 幂等；同 ID 异内容 → 拒绝复用（阶段 B 第 11 条）。
        return existing.digest === digest
          ? { ok: true, proposalId, digest, duplicate: true }
          : { ok: false, code: 'proposal_id_reuse' };
      }
    }
    const finalId = proposalId ?? `p-${randomId()}`;
    if (entries.has(finalId)) return { ok: false, code: 'proposal_id_reuse' };
    while (entries.size >= capacity) {
      if (!evictFinalized()) return { ok:false, code: 'collab_queue_full' };
    }
    for (const entry of entries.values()) {
      if (entry.status === 'pending' && entry.scopeKey === scopeKey && entry.documentId === documentId) {
        entry.status = 'superseded';
      }
    }
    const entry = {
      proposalId: finalId, scopeKey, scopeToken, sessionId, documentId, baseRevision, digest,
      createdAt: now(), status: 'pending',
      proposal: deepFreeze(Object.freeze({
        proposalId: finalId, schemaVersion: 1, documentId, baseRevision, sessionId, rationale,
        ops: deepFreeze(ops.map(op => Object.freeze({ ...op }))),
      })),
      run: run ? deepFreeze(run) : null,
    };
    entries.set(finalId, entry);
    return { ok: true, proposalId: finalId, digest, duplicate: false };
  }

  /** 取回可解析的建议证据。scopeKey/scopeToken 不匹配、已 supersede/expired
   *  一律不可见（旧代次的建议对新 owner 无效）。 */
  function get(scopeKey, scopeToken, proposalId) {
    if (!id(proposalId)) return null;
    const entry = entries.get(proposalId);
    if (!entry || entry.scopeKey !== scopeKey || entry.scopeToken !== scopeToken) return null;
    expireIfDue(entry);
    if (!RESOLVABLE.has(entry.status)) return null;
    return { proposal: entry.proposal, digest: entry.digest, status: entry.status, createdAt: entry.createdAt };
  }

  /** 当前 scope+document 最新的未决建议摘要（不含操作内容；预览走 preview 动作）。 */
  function head(scopeKey, scopeToken, documentId) {
    let found = null;
    for (const entry of entries.values()) {
      if (entry.scopeKey !== scopeKey || entry.scopeToken !== scopeToken || entry.documentId !== documentId) continue;
      expireIfDue(entry);
      if (entry.status === 'pending' && (!found || entry.createdAt >= found.createdAt)) found = entry;
    }
    return found ? { proposalId: found.proposalId, baseRevision: found.baseRevision, rationale: found.proposal.rationale,
      opCount: found.proposal.ops.length, createdAt: found.createdAt, digest: found.digest } : null;
  }

  /** 终局化：accept/reject 成功后由服务调用；仅 pending 可迁移。 */
  function settle(scopeKey, proposalId, outcome) {
    if (outcome !== 'accepted' && outcome !== 'rejected') fail('queue_schema');
    const entry = entries.get(proposalId);
    if (!entry || entry.scopeKey !== scopeKey || entry.status !== 'pending') return false;
    entry.status = outcome;
    return true;
  }

  function dropScope(scopeKey) {
    for (const [key, entry] of entries) if (entry.scopeKey === scopeKey) entries.delete(key);
  }
  function dropAll() { entries.clear(); }
  function stats() {
    let pending = 0;
    for (const entry of entries.values()) { expireIfDue(entry); if (entry.status === 'pending') pending++; }
    return { size: entries.size, pending };
  }

  return { register, get, head, settle, dropScope, dropAll, stats };
}
