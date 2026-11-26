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
    // Round-6 continuity model: an epoch belongs to (resource, owner identity)
    // for as long as that identity CONTINUOUSLY owns the resource. Retries of
    // a continuous owner must hit the recorded outcome, but ANY ownership
    // transition — including returning to an identity seen before (ABA:
    // dormant -> generation -> dormant) — must mint a fresh epoch, or the
    // resurrected owner reaches the stale outcome of its earlier incarnation
    // (R6-CORRECTNESS-2 / contract I06+I17).
    this.ownerEpochs = new Map();   // resourceId -> { identity, epoch }
    try {
      const s = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      const legacyMax = [];
      for (const v of Object.values(s.epochs ?? {})) if (Number.isSafeInteger(v)) legacyMax.push(v);
      for (const [k, v] of Object.entries(s.ownerEpochs ?? {})) {
        if (typeof k === 'string' && isRecord(v) && typeof v.identity === 'string' && Number.isSafeInteger(v.epoch) && v.epoch >= 1) this.ownerEpochs.set(k, v);
      }
      this.epochCounter = Math.max(
        Number.isSafeInteger(s.epochCounter) ? s.epochCounter : 0,
        ...legacyMax,   // one-time monotonic floor over the superseded table
        ...[...this.ownerEpochs.values()].map(v => v.epoch), 0,
      );
    } catch { /* fresh install */ }
  }
  _persist() {
    const tmp = this.path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ revision: this.revision, fingerprint: this.fingerprint, ownerEpochs: Object.fromEntries(this.ownerEpochs), epochCounter: this.epochCounter ?? 0 }), 'utf8');
    fs.renameSync(tmp, this.path);
  }
  /** Registry revision: bumps whenever the conversation/project set changes. */
  registryRevision(items) {
    const fp = sha256hex(canonicalJson((items ?? []).map(i => [i.conversationId ?? null, i.sessionId ?? null, i.title ?? null]).sort()) ?? '[]');
    if (fp !== this.fingerprint) {
      const prevRevision = this.revision, prevFingerprint = this.fingerprint;
      this.revision += 1; this.fingerprint = fp;
      try {
        this._persist();
      } catch (e) {
        // Same memory-disk agreement discipline as epochFor: the revision is
        // served inside mutation outcomes, so an undurable bump must not
        // become observable.
        this.revision = prevRevision; this.fingerprint = prevFingerprint;
        throw e;
      }
    }
    return this.revision;
  }
  /** Continuity-aware epoch resolution: SAME resource + SAME identity ->
   * stable epoch (retries hit their recorded outcome); ANY identity change
   * for the resource — including returning to a previously seen identity —
   * allocates a fresh monotonic epoch. Allocation persists so a restart
   * cannot regress below any epoch ever handed out. */
  epochFor(resourceId, identity) {
    const key = String(resourceId);
    const cur = this.ownerEpochs.get(key);
    if (cur && cur.identity === identity) return cur.epoch;
    const epoch = (this.epochCounter ?? 0) + 1;
    const previousCounter = this.epochCounter ?? 0;
    const hadKey = this.ownerEpochs.has(key);
    const previousEntry = this.ownerEpochs.get(key);
    this.epochCounter = epoch;
    this.ownerEpochs.set(key, { identity, epoch });
    // Resource count is product-bounded (projects+conversations); no cap needed.
    try {
      this._persist();
    } catch (e) {
      // FS-002: an epoch that never reached disk must NEVER be handed out —
      // after restart the same key re-allocates a DIFFERENT epoch for the
      // unchanged owner, and the same client id executes twice under the two
      // epochs. Roll memory back so every later caller retries the allocation
      // against what the disk actually confirms.
      this.epochCounter = previousCounter;
      if (hadKey) this.ownerEpochs.set(key, previousEntry); else this.ownerEpochs.delete(key);
      throw e;
    }
    return epoch;
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
    // Crash-recovery rule (round-6 R6-CORRECTNESS-1 / contract I08): a record
    // left in 'pending' state means the process died somewhere inside the
    // dispatch -> outcome-record critical section, so whether the effect ever
    // executed is UNKNOWN. Exactly-once forbids re-execution; the only sound
    // resolution is a permanent terminal outcome for that client id.
    let upgraded = false;
    for (const [k, v] of this.records) {
      if (isRecord(v) && v.pending === true) {
        this.records.set(k, { payloadSha256: v.payloadSha256, unknown: true, at: v.at ?? Date.now() });
        upgraded = true;
      }
    }
    if (upgraded) this._persist();
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
    if (rec.payloadSha256 !== payloadSha256) return { conflict: true };
    // A pending record inside the live process means a previous mutation hit
    // an unknown execution state and deliberately kept its reservation (the
    // in-flight join path can never observe this: the serializer only admits
    // the retry after the first critical section fully completes). It is
    // committed-unknown either way — never re-execute (round-7 re-review).
    if (rec.pending === true || rec.unknown === true) return { unknown: true };
    return rec.outcome;
  }
  /** Reserve the key BEFORE dispatch with a durable pending record. This is
   * the atomicity anchor of contract mutationRecord: the persistence of the
   * reservation precedes any side effect, so a crash inside the critical
   * section leaves evidence that resolves to committed-unknown rather than
   * re-executing. Capacity is consumed by the reservation itself (I14:
   * overlapping admissions into the final slot cannot both pass). */
  reserve(deviceId, resourceId, ownerEpoch, clientId, payloadSha256) {
    if (this.records.size >= 4096) return false;     // fail closed
    const key = this._key(deviceId, resourceId, ownerEpoch, clientId);
    const prior = this.records.get(key);
    this.records.set(key, { payloadSha256, pending: true, at: Date.now() });
    try {
      this._persist();
    } catch (e) {
      // Round-8 R8-IDEMP-03: memory must never diverge from the durable view.
      // Roll back so the store keeps describing what is actually on disk.
      if (prior) this.records.set(key, prior); else this.records.delete(key);
      throw e;
    }
    return true;
  }
  /** Complete a reservation with its outcome — the post-dispatch half of the
   * same critical section. */
  record(deviceId, resourceId, ownerEpoch, clientId, payloadSha256, outcome) {
    const key = this._key(deviceId, resourceId, ownerEpoch, clientId);
    if (this.records.size >= 4096 && !this.records.has(key)) return false;
    const prior = this.records.get(key);
    this.records.set(key, { payloadSha256, outcome, at: Date.now() });
    try {
      this._persist();
    } catch (e) {
      // Round-8 R8-IDEMP-03: a success outcome that never reached disk must
      // never be replayable. Restore the pending reservation — the mutation
      // stays committed-unknown and retries are refused rather than served a
      // forged success.
      if (prior) this.records.set(key, prior); else this.records.delete(key);
      throw e;
    }
    return true;
  }
  /** A reservation for a mutation that verifiably never executed (domain
   * business denial) is released so the client id may be retried. */
  release(deviceId, resourceId, ownerEpoch, clientId) {
    const key = this._key(deviceId, resourceId, ownerEpoch, clientId);
    const rec = this.records.get(key);
    if (!rec || rec.pending !== true) return false;
    this.records.delete(key);
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

  /* Per-key mutation serializer (round-6 R6-CORRECTNESS-1 / contract I10):
   * operations sharing an idempotency key chain onto one promise, so the
   * resolve-check -> reserve -> dispatch -> record critical section cannot
   * interleave. A retry of an in-flight mutation JOINS it (the reservation is
   * visible in the store by the time the second caller enters the chain), and
   * a conflicting payload is rejected before any second dispatch. Memory is
   * bounded: chain tails are dropped once quiescent. */
  const mutationChains = new Map();
  function serializedMutation(key, fn) {
    const prev = mutationChains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    mutationChains.set(key, next);
    next.finally(() => { if (mutationChains.get(key) === next) mutationChains.delete(key); }).catch(() => {});
    return next;
  }
  const mutationKey = (deviceId, resourceId, epoch, clientId) => `${deviceId}|${resourceId}|${epoch}|${clientId}`;

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
        return { current: true, namespace: 'runtime', identity, epoch: clock.epochFor(projectId, identity), revision: clock.registryRevision(domain.conversations()), projectId, conversationId: undefined };
      }
      const conv = convs.get(resourceId);
      if (!conv) return null;
      const proj = projectOfConversation(conv);
      if (!proj || projectIdFor(proj.path) !== projectId) return null;
      const ws = conv.workspace ?? {};
      const identity = `runtime:${ws.backendInstance ?? ''}:${ws.workspaceId ?? ''}:${ws.workspaceEpoch ?? 0}:${conv.conversationId}:${conv.runtimeGeneration ?? 'dormant'}`;
      return { current: true, namespace: 'runtime', identity, epoch: clock.epochFor(conv.conversationId, identity), revision: conv.revision ?? clock.registryRevision(domain.conversations()), projectId, conversationId: conv.conversationId };
    }
    const params = pathParameters ?? {};
    if (params.projectId !== undefined && params.conversationId === undefined && params.requestId === undefined) {
      const proj = projects.get(params.projectId);
      if (!proj) return null;
      const identity = `project:${params.projectId}`;
      return { current: true, namespace: 'runtime', identity, epoch: clock.epochFor(params.projectId, identity), revision: clock.registryRevision(domain.conversations()), projectId: params.projectId };
    }
    if (params.conversationId !== undefined) {
      const conv = convs.get(params.conversationId);
      if (!conv) return null;
      const proj = projectOfConversation(conv);
      if (!proj) return null;
      const ws = conv.workspace ?? {};
      const identity = `runtime:${ws.backendInstance ?? ''}:${ws.workspaceId ?? ''}:${ws.workspaceEpoch ?? 0}:${conv.conversationId}:${conv.runtimeGeneration ?? 'dormant'}`;
      const base = { current: true, namespace: 'runtime', identity, epoch: clock.epochFor(conv.conversationId, identity), revision: conv.revision ?? clock.registryRevision(domain.conversations()), projectId: projectIdFor(proj.path), conversationId: conv.conversationId };
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

  /**
   * Round-7 R7-AUTH-01: admission + commit checks happen BEFORE a mutation
   * queues inside serializedMutation. A revocation, grant removal, re-pair or
   * owner roll that lands while the request waits must fail closed at the
   * moment the queued work actually begins — otherwise the queued request
   * executes its effect with authority that no longer exists.
   * Returns true only when the live device record still matches admission
   * (active, same replay epoch), the grant for the operation's project still
   * holds, and the re-resolved owner is IDENTICAL in identity and epoch.
   */
  function authorityStillValid(device, owner, pathParameters) {
    if (deviceStore) {
      const live = deviceStore.active(device.deviceId);
      if (!live) return false;
      if (live.replayEpoch !== device.replayEpoch) return false;   // re-pair / replay-state loss
      // Round-8 R8-AUTH-05: scopes are part of admission authority. They are
      // immutable within a record (rotations produce a new record object),
      // but compare anyway — the cost is negligible and the invariant is
      // then independent of how the store evolves.
      if (JSON.stringify([...(live.grantedScopes ?? [])].sort()) !== JSON.stringify([...(device.grantedScopes ?? [])].sort())) return false;
    }
    const fresh = resolveOwner({ pathParameters });
    if (!fresh || fresh.identity !== owner.identity || fresh.epoch !== owner.epoch) return false;
    // Round-8 R8-AUTH-05: the runtime owner identity intentionally omits the
    // project path (workspace identity is the authority), so a conversation
    // that MOVED projects while keeping its workspace ids still resolved to
    // the same identity+epoch. Admission bound a specific project — compare
    // it, or a grant removal on the admitted project goes unnoticed when the
    // conversation reappears under a granted one.
    if (fresh.projectId !== owner.projectId) return false;
    if (!deviceStore) return true;
    const live = deviceStore.get(device.deviceId);
    if (!live?.grants) return false;
    return live.grants[fresh.projectId] === true;
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
    return serializedMutation(mutationKey(device.deviceId, projectId, owner.epoch, clientId), async () => {
      // Round-7 R7-AUTH-01: revalidate authority NOW — admission passed before
      // this request queued; the world may have changed while it waited.
      if (!authorityStillValid(device, owner, pathParameters)) return deny('operation_rejected');
      const prior = idem.resolve(device.deviceId, projectId, owner.epoch, clientId, payloadHash);
      if (prior?.conflict) return deny('payload_invalid');
      if (prior?.unknown) return deny('operation_rejected');   // committed-unknown: exactly-once forbids re-execution
      if (prior) return okResult(prior);                        // recorded retry OR joined in-flight outcome
      if (!idem.hasCapacity()) return deny('operation_rejected');
      if (!idem.reserve(device.deviceId, projectId, owner.epoch, clientId, payloadHash)) return deny('operation_rejected');
      // Round-7 R7-IDEMP-02: NO outcome path below may release the
      // reservation. Releasing requires proof the effect never executed, and
      // neither an exception (even one carrying a business-denial code — it
      // can be thrown AFTER the effect) nor a malformed result establishes
      // that. Every non-success hardens into committed-unknown; the client
      // retries with a fresh client id.
      try {
        const out = await domain.openConversation(proj.path, { clientConversationId: clientId });
        // Round-9 R9-CREATE-01: 'stream-reset' is a reserved journal identifier
        // that can never address a real conversation — accepting it as a create
        // result minted an unusable success the retry would happily replay.
        // A malformed result is unknown execution state, not a release.
        // Round-10 R10-CREATE-01: the result must be a PRIMITIVE string —
        // a boxed String('stream-reset') coerces through RegExp.test but fails
        // strict equality, so it was recorded raw (500s) yet normalized to the
        // reserved literal by JSON on restart, minting a replayable success.
        // Round-11 R11-CREATE-01: capture the identifier EXACTLY ONCE. The
        // domain object is untrusted — an accessor can answer the validation
        // reads with a valid value and the recording read with a poisoned
        // one (primitive, boxed, or toJSON-shaped reserved ids all observed).
        // Every check and the recorded outcome must use the same captured
        // primitive: what is validated is what is persisted, byte for byte.
        const convId = out?.conversationId;
        if (typeof convId !== 'string' || !OPAQUE_ID.test(convId) || convId === 'stream-reset') return deny('unavailable');
        const ownerRevision = clock.registryRevision(domain.conversations());
        const result = { conversationId: convId, ownerRevision };
        if (!idem.record(device.deviceId, projectId, owner.epoch, clientId, payloadHash, result)) return deny('operation_rejected');
        return okResult(result);
      } catch {
        return deny('unavailable');
      }
    });
  }

  async function runtimeSnapshot({ device, pathParameters, owner }) {
    const conv = conversationIndex().get(pathParameters.conversationId);
    if (!conv) return deny('unknown_resource');
    // Contract snapshotWindow (round-6 R6-CORRECTNESS-4): the newest messages
    // within BOTH the count limit AND a serialized-byte budget. Older history
    // that fits neither is omitted from the head; the watermark still always
    // permits forward recovery, and any omission sets snapshotTruncated=true.
    // Messages individually exceeding transcriptBounds can never fit a frame
    // and are excluded from the window (counting as truncation when dropped).
    const budget = REMOTE_V1.limits.maxSerializedResponseBytes - 65536;
    const all = (conv.messages ?? [])
      .filter(m => OPAQUE_ID.test(m.messageId ?? '') && ['user', 'assistant'].includes(m.role));
    const messages = [];
    let bytes = 0, omitted = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i];
      const entry = { messageId: m.messageId, role: m.role, text: String(m.text ?? '') };
      const size = Buffer.byteLength(JSON.stringify(entry), 'utf8');
      if (messages.length >= 500 || bytes + size > budget || Buffer.byteLength(JSON.stringify(entry.text), 'utf8') > L.maxTranscriptSerializedBytes) { omitted = i + 1; break; }
      messages.unshift(entry);
      bytes += size;
    }
    if (omitted === 0 && messages.length < all.length) omitted = all.length - messages.length;
    const truncated = omitted > 0 || conv.truncated === true;
    const wm = typeof streamWatermark === 'function' ? streamWatermark(device.deviceId) : null;
    return okResult({
      ownerRevision: conv.revision ?? 0,
      status: ['idle', 'running', 'stopping', 'error'].includes(conv.lifecycle) ? conv.lifecycle : 'unknown',
      messages,
      cursor: wm?.cursor ?? 'g1_s0_0000000000000000000000',
      streamGeneration: wm?.generation ?? 1,
      sequence: wm?.sequence ?? 1,
      ...(truncated ? { snapshotTruncated: true } : {}),
    });
  }

  async function chatSend({ device, pathParameters, body, owner }) {
    const conv = conversationIndex().get(pathParameters.conversationId);
    if (!conv) return deny('unknown_resource');
    const clientId = body.payload.clientMessageId;
    const payloadHash = sha256hex(canonicalJson(body.payload) ?? '');
    // Contract transcriptBounds: text is bounded by maxTranscriptSerializedBytes
    // measured on the JSON-serialized UTF-8 representation; oversized submissions
    // are rejected, never silently truncated.
    if (Buffer.byteLength(JSON.stringify(String(body.payload.text ?? '')), 'utf8') > L.maxTranscriptSerializedBytes) return deny('payload_invalid');
    return serializedMutation(mutationKey(device.deviceId, conv.conversationId, owner.epoch, clientId), async () => {
      if (!authorityStillValid(device, owner, pathParameters)) return deny('operation_rejected');
      const prior = idem.resolve(device.deviceId, conv.conversationId, owner.epoch, clientId, payloadHash);
      if (prior?.conflict) return deny('payload_invalid');
      if (prior?.unknown) return deny('operation_rejected');
      if (prior) return okResult(prior);
      if (!idem.hasCapacity()) return deny('operation_rejected');
      if (!idem.reserve(device.deviceId, conv.conversationId, owner.epoch, clientId, payloadHash)) return deny('operation_rejected');
      // Round-7 R7-IDEMP-02: no release on any failure path — see runtimeCreate.
      try {
        const out = await domain.sendMessage({ owner, text: body.payload.text, clientMessageId: clientId });
        const result = { clientMessageId: clientId, accepted: out?.accepted === true, ownerRevision: conv.revision ?? 0 };
        if (!idem.record(device.deviceId, conv.conversationId, owner.epoch, clientId, payloadHash, result)) return deny('operation_rejected');
        return okResult(result);
      } catch {
        return deny('unavailable');
      }
    });
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
