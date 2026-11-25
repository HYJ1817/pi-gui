/**
 * Remote v1 domain adapters — map the desktop domain to contract-shaped
 * results. All desktop state enters through the injected `domain` facade so
 * tests can drive synthetic fixtures and production can bind the real
 * registry/projects/stores without this layer knowing which is which.
 *
 * Contract rules implemented here:
 *  - resolveOwner returns a FULLY TYPED owner {namespace, identity, epoch,
 *    revision, projectId, conversationId?, dialogId?, current} proven from
 *    live domain state — never a bare flag, never caller input
 *  - list operations filter each item through the device grant map; an
 *    ungranted item is absent, not redacted
 *  - every projected result is schema-validated and forbidden-value-scanned
 *    (validateRemoteResponse does both at the listener boundary; adapters
 *    additionally guarantee structural shape)
 *  - mutations are idempotent under (deviceId, resourceId, ownerEpoch):
 *    retry returns the recorded outcome; same client id + different payload
 *    is payload_invalid; outcomes are never evicted while the epoch is live
 *  - approvals.settle relays exactly one response to the LIVE Pi dialog via
 *    settleApproval + domain.consumeApproval (atomic claim-and-enqueue)
 *
 * domain facade (injected):
 *   projects()                 -> [{path, name?}]
 *   conversations()            -> [{conversationId, workspace:{cwd?,workspaceId?,workspaceEpoch?},
 *                                  sessionId?, title?, createdAt?, lifecycle?, activity?,
 *                                  pendingApprovals:[PendingDialog]}]
 *   sessionRecords(projectKey) -> [{sessionId, displayName, updatedAt, conversationIds?}]
 *   openConversation(projectPath, {clientConversationId}) -> {conversationId}
 *   sendMessage(owner, text, {clientMessageId}) -> {accepted}
 *   stop(owner)                -> {stopped}
 *   pendingDialogs()           -> [PendingDialog]  (all live dialogs)
 *   consumeApproval({requestId, owner, namespace, method, decision, value, dialogRevision}) -> bool
 *   PendingDialog = {requestId, conversationId, owner(identity), namespace, projectId,
 *                    method, pending, expiresAtMs, revision, options:[{optionId,label}],
 *                    title, message}
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REMOTE_V1, settleApproval, authorizeRemoteOperation, commitAdmission } from './protocol.mjs';
import { isRecord, canonicalJson, sha256hex } from './keys.mjs';

const L = REMOTE_V1.limits;
const OPAQUE_ID = /^[A-Za-z0-9_-]{8,128}$/;

const deny = code => ({ ok: false, code, wire: code });
const denyWire = (code, wire) => ({ ok: false, code, wire });
const okResult = result => ({ ok: true, result });

/** Deterministic projectId from the project path (stable across restarts). */
export function projectIdFor(projectPath) {
  return 'p-' + crypto.createHash('sha256').update(String(projectPath)).digest('base64url').slice(0, 22);
}

/**
 * Registry revision+epoch store — the ownerRevision an operation must echo.
 * Persisted in dataDir so a restart cannot silently roll revisions back.
 */
export class RegistryClock {
  constructor(dataDir) {
    this.path = path.join(dataDir, 'remote-registry.json');
    try {
      const s = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      this.revision = Number.isSafeInteger(s.revision) ? s.revision : 0;
      this.fingerprint = typeof s.fingerprint === 'string' ? s.fingerprint : null;
    } catch { this.revision = 0; this.fingerprint = null; }
    this.epochCounter = 0;
    // Owner epochs persist too: a restart must never let the epoch for a
    // re-appearing identity regress to 1 — signed-request replay protection
    // is only as strong as the lowest epoch the verifier ever accepts again.
    this.epochs = new Map();
    try {
      const s = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      for (const [k, v] of Object.entries(s.epochs ?? {})) {
        if (typeof k === 'string' && Number.isSafeInteger(v) && v >= 1) this.epochs.set(k, v);
      }
      this.epochCounter = Math.max(
        Number.isSafeInteger(s.epochCounter) ? s.epochCounter : 0,
        ...[...this.epochs.values()], 0,
      );
    } catch { /* no persisted epochs — fresh install; counter stays at the pre-set 0 or the max of any epochs loaded above */ }
  }
  _persist() {
    const tmp = this.path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ revision: this.revision, fingerprint: this.fingerprint, epochs: Object.fromEntries(this.epochs), epochCounter: this.epochCounter ?? 0 }), 'utf8');
    fs.renameSync(tmp, this.path);
  }
  /** Registry revision: bumps whenever the conversation/project set changes. */
  registryRevision(items) {
    const fp = sha256hex(canonicalJson((items ?? []).map(i => [i.conversationId ?? null, i.sessionId ?? null, i.title ?? null]).sort()) ?? '[]');
    if (fp !== this.fingerprint) { this.revision += 1; this.fingerprint = fp; this._persist(); }
    return this.revision;
  }
  /** Per-owner epoch: monotonically allocated, never reused. Contract
   * idempotency namespace + ownerEpoch roll semantics: EVERY new owner
   * identity (including generation rolls) receives a fresh, distinct epoch,
   * so a mutation outcome recorded under a rolled owner is unreachable by
   * construction — never merely keyed differently. The counter persists;
   * losing the newest assignments on crash is safe (re-roll is higher, and
   * continuity loss surfaces as a reset, never as cross-owner replay). */
  epochFor(identity) {
    let e = this.epochs.get(identity);
    if (!e) {
      e = (this.epochCounter ?? 0) + 1;
      this.epochCounter = e;
      this.epochs.set(identity, e);
      // Owner churn is bounded: cap the persisted map, evicting the oldest
      // registrations first. Eviction cannot collide: the counter never
      // regresses, so a re-appearing identity gets a NEW higher epoch.
      while (this.epochs.size > 4096) this.epochs.delete(this.epochs.keys().next().value);
      this._persist();
    }
    return e;
  }
  /** Monotonicity floor: the counter must never restart below an epoch that a
   * surviving idempotency record still references, or a rolled owner could
   * collide with the prior owner's namespace and replay its outcome. Evicted
   * records need no protection — their outcomes are unreachable anyway. */
  floorEpochs(minimum) {
    if (Number.isSafeInteger(minimum) && minimum > (this.epochCounter ?? 0)) {
      this.epochCounter = minimum;
    }
  }
}

/** Idempotency records keyed (deviceId, resourceId, ownerEpoch) -> outcome. */
export class IdempotencyStore {
  constructor(dataDir) {
    this.path = path.join(dataDir, 'remote-idempotency.json');
    this.records = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      if (isRecord(data)) for (const [k, v] of Object.entries(data)) this.records.set(k, v);
    } catch {}
  }
  _persist() {
    const tmp = this.path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.records)), 'utf8');
    fs.renameSync(tmp, this.path);
  }
  _key(deviceId, resourceId, ownerEpoch, clientId) {
    return `${deviceId}|${resourceId}|${ownerEpoch}|${clientId}`;
  }
  /** Capacity must be consulted BEFORE dispatch: a mutation whose outcome can
   * never be recorded must never execute — otherwise retries repeat the
   * unrecorded effect (round-5 finding 1). Records never evict, so the gate
   * is stable across the dispatch/record pair within this process. */
  hasCapacity() {
    return this.records.size < 4096;
  }
  /** Highest owner epoch referenced by any live record. Keys are
   * deviceId|resourceId|epoch|clientId; the epoch is the third field. */
  maxLiveEpoch() {
    let max = 0;
    for (const key of this.records.keys()) {
      const epoch = Number(key.split('|')[2]);
      if (Number.isSafeInteger(epoch) && epoch > max) max = epoch;
    }
    return max;
  }
  /**
   * resolve() -> the recorded outcome or null. record() -> persists.
   * Capacity overflow refuses NEW mutations (never evicts a live record).
   */
  resolve(deviceId, resourceId, ownerEpoch, clientId, payloadSha256) {
    const rec = this.records.get(this._key(deviceId, resourceId, ownerEpoch, clientId));
    if (!rec) return null;
    return rec.payloadSha256 === payloadSha256 ? rec.outcome : { conflict: true };
  }
  record(deviceId, resourceId, ownerEpoch, clientId, payloadSha256, outcome) {
    if (this.records.size >= 4096) return false;     // fail closed
    this.records.set(this._key(deviceId, resourceId, ownerEpoch, clientId), { payloadSha256, outcome, at: Date.now() });
    this._persist();
    return true;
  }
}

export function buildAdapters({ domain, dataDir, clock = new RegistryClock(dataDir), idem = new IdempotencyStore(dataDir), deviceStore = null, streamWatermark = null }) {
  // If registry state is lost while idempotency records survive, fresh epochs
  // must still allocate above every live record — otherwise a rolled owner
  // could inherit a prior owner's outcomes (round-4 R4-CORRECTNESS-1).
  clock.floorEpochs(idem.maxLiveEpoch());
  const nowMs = () => Date.now();

  const projectIndex = () => {
    const map = new Map();
    for (const p of domain.projects() ?? []) if (p && typeof p.path === 'string') map.set(projectIdFor(p.path), p);
    return map;
  };
  const conversationIndex = () => {
    const map = new Map();
    for (const c of domain.conversations() ?? []) if (c && typeof c.conversationId === 'string') map.set(c.conversationId, c);
    return map;
  };
  const projectOfConversation = conv => {
    const ws = conv?.workspace ?? {};
    for (const p of domain.projects() ?? []) {
      if (!p || typeof p.path !== 'string') continue;
      if (ws.cwd === p.path || (ws.workspaceId && ws.workspaceId === p.workspaceId)) return p;
    }
    return null;
  };

  /**
   * resolveOwner — the contract's ownerProof entry point.
   * Handles BOTH call shapes (admission: pathParameters+ownerRevision;
   * commitAdmission: projectId+resourceId) and returns the full typed owner:
   *   {current:true, namespace:'runtime'|'classic', identity, epoch, revision,
   *    projectId, conversationId?, dialogId?}
   */
  function resolveOwner({ pathParameters, projectId, resourceId } = {}) {
    const convs = conversationIndex();
    const projects = projectIndex();
    if (projectId !== undefined && resourceId !== undefined) {
      // commitAdmission re-resolution path.
      if (projectId === resourceId) {
        const proj = projects.get(projectId);
        if (!proj) return null;
        const identity = `project:${projectId}`;
        return { current: true, namespace: 'runtime', identity, epoch: clock.epochFor(identity), revision: clock.registryRevision(domain.conversations()), projectId, conversationId: undefined };
      }
      const conv = convs.get(resourceId);
      if (!conv) return null;
      const proj = projectOfConversation(conv);
      if (!proj || projectIdFor(proj.path) !== projectId) return null;
      const ws = conv.workspace ?? {};
      const identity = `runtime:${ws.backendInstance ?? ''}:${ws.workspaceId ?? ''}:${ws.workspaceEpoch ?? 0}:${conv.conversationId}:${conv.runtimeGeneration ?? 'dormant'}`;
      return { current: true, namespace: 'runtime', identity, epoch: clock.epochFor(identity), revision: conv.revision ?? clock.registryRevision(domain.conversations()), projectId, conversationId: conv.conversationId };
    }
    const params = pathParameters ?? {};
    if (params.projectId !== undefined && params.conversationId === undefined && params.requestId === undefined) {
      const proj = projects.get(params.projectId);
      if (!proj) return null;
      const identity = `project:${params.projectId}`;
      return { current: true, namespace: 'runtime', identity, epoch: clock.epochFor(identity), revision: clock.registryRevision(domain.conversations()), projectId: params.projectId };
    }
    if (params.conversationId !== undefined) {
      const conv = convs.get(params.conversationId);
      if (!conv) return null;
      const proj = projectOfConversation(conv);
      if (!proj) return null;
      const ws = conv.workspace ?? {};
      const identity = `runtime:${ws.backendInstance ?? ''}:${ws.workspaceId ?? ''}:${ws.workspaceEpoch ?? 0}:${conv.conversationId}:${conv.runtimeGeneration ?? 'dormant'}`;
      const base = { current: true, namespace: 'runtime', identity, epoch: clock.epochFor(identity), revision: conv.revision ?? clock.registryRevision(domain.conversations()), projectId: projectIdFor(proj.path), conversationId: conv.conversationId };
      if (params.requestId !== undefined) {
        const dialog = (conv.pendingApprovals ?? []).find(d => d.requestId === params.requestId && d.pending === true);
        if (!dialog) return null;
        return { ...base, dialogId: dialog.requestId };
      }
      return base;
    }
    return null;
  }

  /** authorizeResource for the event stream: grant+owner must still hold.
   * Revision equality is NOT re-checked here: mutations legitimately advance
   * the revision after a frame was journaled, and every authorization-bearing
   * transition (grant/owner/device/epoch) already invalidates the whole cursor
   * space categorically, so a stale-owner frame can never be delivered as
   * continuous. Requiring exact revisions killed the contract replay fast-path
   * on any reconnect after two mutations. */
  function authorizeResource({ deviceId, conversationId }) {
    if (!OPAQUE_ID.test(conversationId ?? '')) return false;
    const conv = conversationIndex().get(conversationId);
    if (!conv) return false;
    const proj = projectOfConversation(conv);
    if (!proj) return false;
    const device = deviceStore?.get(deviceId);
    if (device && device.grants && device.grants[projectIdFor(proj.path)] !== true) return false;
    return true;
  }

  /* ---------- operations ---------- */

  async function projectsList({ device }) {
    const idx = projectIndex();
    const projects = [];
    for (const [id, p] of idx) {
      if (device.grants?.[id] !== true) continue;
      projects.push({ projectId: id, displayName: p.name || p.path.split(/[\\/]/).pop() || p.path });
    }
    return okResult({ projects, registryRevision: clock.registryRevision(domain.conversations()) });
  }

  async function sessionsList({ device, pathParameters }) {
    const projectId = pathParameters.projectId;
    const proj = projectIndex().get(projectId);
    if (!proj || device.grants?.[projectId] !== true) return deny('unknown_resource');
    const sessions = (domain.sessionRecords?.(proj.path) ?? [])
      .filter(s => OPAQUE_ID.test(s.sessionId ?? ''))
      .map(s => ({
        sessionId: s.sessionId,
        displayName: String(s.displayName ?? '').slice(0, 120),
        updatedAt: String(s.updatedAt ?? new Date().toISOString()).slice(0, 40),
        projectId,
        ...(Array.isArray(s.conversationIds)
          ? { activeConversations: s.conversationIds.filter(c => OPAQUE_ID.test(c ?? '')).map(c => ({ conversationId: c })).slice(0, 64) }
          : {}),
      }));
    return okResult({ sessions });
  }

  async function runtimeCreate({ device, pathParameters, body, owner, requestId }) {
    const projectId = pathParameters.projectId;
    const proj = projectIndex().get(projectId);
    if (!proj || device.grants?.[projectId] !== true) return deny('unknown_resource');
    const clientId = body.payload.clientConversationId;
    const payloadHash = sha256hex(canonicalJson(body.payload) ?? '');
    const prior = idem.resolve(device.deviceId, projectId, owner.epoch, clientId, payloadHash);
    if (prior?.conflict) return deny('payload_invalid');
    if (prior) return okResult(prior);
    if (!idem.hasCapacity()) return deny('operation_rejected');
    try {
      const out = await domain.openConversation(proj.path, { clientConversationId: clientId });
      if (!OPAQUE_ID.test(out?.conversationId ?? '')) return deny('unavailable');
      const ownerRevision = clock.registryRevision(domain.conversations());
      const result = { conversationId: out.conversationId, ownerRevision };
      if (!idem.record(device.deviceId, projectId, owner.epoch, clientId, payloadHash, result)) return deny('operation_rejected');
      return okResult(result);
    } catch (e) {
      const code = e?.code;
      if (code === 'workspace_in_use' || code === 'stale_workspace') return deny('stale_owner');
      return deny('unavailable');
    }
  }

  async function runtimeSnapshot({ device, pathParameters, owner }) {
    const conv = conversationIndex().get(pathParameters.conversationId);
    if (!conv) return deny('unknown_resource');
    const messages = (conv.messages ?? [])
      .filter(m => OPAQUE_ID.test(m.messageId ?? '') && ['user', 'assistant'].includes(m.role))
      .map(m => ({ messageId: m.messageId, role: m.role, text: String(m.text ?? '') }))
      .slice(-500);
    const wm = typeof streamWatermark === 'function' ? streamWatermark(device.deviceId) : null;
    return okResult({
      ownerRevision: conv.revision ?? 0,
      status: ['idle', 'running', 'stopping', 'error'].includes(conv.lifecycle) ? conv.lifecycle : 'unknown',
      messages,
      cursor: wm?.cursor ?? 'g1_s0_0000000000000000000000',
      streamGeneration: wm?.generation ?? 1,
      sequence: wm?.sequence ?? 1,
      ...(conv.truncated === true ? { snapshotTruncated: true } : {}),
    });
  }

  async function chatSend({ device, pathParameters, body, owner }) {
    const conv = conversationIndex().get(pathParameters.conversationId);
    if (!conv) return deny('unknown_resource');
    const clientId = body.payload.clientMessageId;
    const payloadHash = sha256hex(canonicalJson(body.payload) ?? '');
    const prior = idem.resolve(device.deviceId, conv.conversationId, owner.epoch, clientId, payloadHash);
    if (prior?.conflict) return deny('payload_invalid');
    if (prior) return okResult(prior);
    if (!idem.hasCapacity()) return deny('operation_rejected');
    try {
      const out = await domain.sendMessage({ owner, text: body.payload.text, clientMessageId: clientId });
      const result = { clientMessageId: clientId, accepted: out?.accepted === true, ownerRevision: conv.revision ?? 0 };
      if (!idem.record(device.deviceId, conv.conversationId, owner.epoch, clientId, payloadHash, result)) return deny('operation_rejected');
      return okResult(result);
    } catch (e) {
      const code = e?.code;
      if (code === 'stale_owner' || code === 'owner_stale') return deny('stale_owner');
      if (code === 'busy' || code === 'in_progress') return deny('operation_rejected');
      return deny('unavailable');
    }
  }

  async function chatStop({ device, pathParameters, owner }) {
    const conv = conversationIndex().get(pathParameters.conversationId);
    if (!conv) return deny('unknown_resource');
    try {
      // Reuse the owner resolved+committed at admission — re-resolving here
      // could drift between commitAdmission and dispatch (TOCTOU).
      const out = await domain.stop({ owner, conversationId: pathParameters.conversationId });
      return okResult({ stopped: out?.stopped === true, ownerRevision: conv.revision ?? 0 });
    } catch (e) {
      const code = e?.code;
      if (code === 'stale_owner' || code === 'owner_stale') return deny('stale_owner');
      return deny('unavailable');
    }
  }

  async function approvalsList({ pathParameters }) {
    const conv = conversationIndex().get(pathParameters.conversationId);
    if (!conv) return deny('unknown_resource');
    const approvals = (conv.pendingApprovals ?? [])
      .filter(d => d.pending === true)
      .map(d => ({
        requestId: d.requestId,
        method: d.method,
        title: String(d.title ?? '').slice(0, 200),
        message: String(d.message ?? '').slice(0, 600),
        ...(Array.isArray(d.options) ? {
          options: d.options.slice(0, 20).map(o => ({ optionId: String(o.optionId ?? ''), label: String(o.label ?? '').slice(0, 200) })),
        } : {}),
      }));
    return okResult({ approvals });
  }

  /**
   * approvals.respond — delegates the entire admission + settlement to the
   * vendored settleApproval (atomic claim-and-enqueue to the live Pi dialog).
   */
  async function approvalsRespond({ request, device, serviceId, serviceFingerprint, consumeNonce }) {
    const params = {};
    // pendingDialog resolution: live dialog for this conversation+requestId.
    const convId = /\/conversations\/([^/]+)\//.exec(request.path)?.[1];
    const rid = /\/approvals\/([^/]+)\/respond$/.exec(request.path)?.[1];
    const conv = conversationIndex().get(convId);
    const pendingDialog = (conv?.pendingApprovals ?? []).find(d => d.requestId === rid);
    const result = settleApproval({
      request, device, serviceId, serviceFingerprint,
      deviceResolveOwner: resolveOwner,
      pendingDialog,
      consumeDialog: ({ requestId, owner, namespace, method, decision, value, dialogRevision }) => {
        try {
          return domain.consumeApproval({ requestId, conversationId: convId, owner, namespace, method, decision, value, dialogRevision }) === true;
        } catch { return false; }
      },
      consumeNonce,
    });
    if (!result.ok) return result;
    return { ok: true, operation: result.operation, result: { accepted: true, ownerRevision: pendingDialog?.revision ?? 0 }, requestId: result.requestId };
  }

  // Internal-only owner epoch projection. Message/status revision changes do
  // not reset cursors; resource ownership identity/epoch changes do. Nothing
  // here is exposed as a remote endpoint or diagnostic payload.
  const authorizationState = deviceId => {
    const device = deviceStore?.active(deviceId);
    if (!device) return null;
    const owners = [];
    for (const conv of conversationIndex().values()) {
      const owner = resolveOwner({ pathParameters: { conversationId: conv.conversationId } });
      if (owner && device.grants?.[owner.projectId] === true) owners.push([conv.conversationId, owner.namespace, owner.identity, owner.epoch, owner.projectId]);
    }
    owners.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return sha256hex(canonicalJson(owners));
  };

  return {
    resolveOwner, authorizeResource, authorizationState, clock, idem,
    dispatch: {
      'projects.list': projectsList,
      'sessions.list': sessionsList,
      'runtime.create': runtimeCreate,
      'runtime.snapshot': runtimeSnapshot,
      'chat.send': chatSend,
      'chat.stop': chatStop,
      'approvals.list': approvalsList,
      'approvals.respond': approvalsRespond,
    },
  };
}
