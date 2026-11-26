/**
 * Remote v1 device registry — paired mobile devices: identity, granted scopes,
 * per-project grants, replay state (nonces + acceptedTimestampFloor) and
 * revocation. File-backed under the desktop DATA_DIR so a restart cannot
 * silently re-admit devices; access relies on the OS ACL of the data dir (same
 * trust level as every other desktop secret).
 *
 * Contract replay rules implemented here (signedRequest.replay):
 *   - nonce retained while timestamp >= acceptedTimestampFloor OR inside skew
 *   - timestamp STRICTLY below the floor is rejected even inside skew
 *   - capacity overflow rejects NEW nonces (never evict a live nonce)
 *   - corrupt/missing replay state bumps replayEpoch (device must re-pair)
 *   - effective clock = max(wallNow, persisted floor); a wall-clock rollback
 *     can never widen the admissible window
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isRecord, decodeB64url } from './keys.mjs';
import { REMOTE_V1 } from './protocol.mjs';

const FILE = 'remote-devices.json';
const L = REMOTE_V1.limits;
const SKEW_MS = REMOTE_V1.signedRequest.maximumClockSkewSeconds * 1000;
const RETENTION_MS = REMOTE_V1.signedRequest.replay.retentionSeconds * 1000;

const nowIso = () => new Date().toISOString();

export class DeviceStore {
  constructor(dataDir, log = () => {}) {
    this.dir = dataDir;
    this.path = path.join(dataDir, FILE);
    this.log = log;
    this.devices = new Map();      // deviceId -> record
    this.keyIndex = new Map();     // devicePublicKey -> deviceId
    this.onAuthorizationChanged = null; // composition-root-only synchronous invalidation
    // FSEC-005: write-ahead revocation tombstones. A revocation whose only
    // record lives in memory is reverted by a restart; the tombstone is a
    // second, independent durable channel written BEFORE the main mutation
    // so at least one of the two carries the revocation across a restart.
    this.tombstonePath = path.join(dataDir, 'remote-revocations.json');
    this._load();
  }
  /**
   * FSEC-005-R4-001: the revocation journal has THREE states, never two.
   *   absent  — ENOENT: nothing was ever revoked through this channel.
   *   present — well-formed entries (possibly an empty list after compaction).
   *   unknown — unreadable or malformed bytes. Unknown is NEVER interpreted
   *     as absent: reconciliation cannot prove the devices in the main file
   *     were not revoked through this channel, and appending/compacting over
   *     unknown state would destroy the only durable record of revocations
   *     that were already acknowledged to the operator. Callers receive
   *     {state, entries}; entries is null exactly when state is 'unknown'.
   */
  _readTombstones() {
    let raw;
    try {
      raw = fs.readFileSync(this.tombstonePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { state: 'absent', entries: [] };
      this.log('revocation tombstone unreadable: revocation state unknown, failing closed');
      return { state: 'unknown', entries: null };
    }
    try {
      const data = JSON.parse(raw);
      if (isRecord(data) && Array.isArray(data.revocations)) {
        // FSEC-005-R5-001: entry-level validation is all-or-nothing. Silently
        // filtering malformed entries out of an otherwise readable journal
        // would lose exactly the revocations those entries carried — the
        // journal would compact away records acknowledged as durable. Any
        // malformed entry poisons the whole journal into 'unknown' state.
        const wellFormed = r => isRecord(r) && typeof r.deviceId === 'string'
          && typeof r.devicePublicKey === 'string' && typeof r.registeredAt === 'string';
        if (data.revocations.every(wellFormed)) return { state: 'present', entries: data.revocations };
      }
    } catch { /* malformed bytes fall through */ }
    this.log('revocation tombstone malformed: revocation state unknown, failing closed');
    return { state: 'unknown', entries: null };
  }
  _writeTombstones(entries) {
    const tmp = this.tombstonePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ revocations: entries }, null, 2), 'utf8');
    try { fs.chmodSync(tmp, 0o600); } catch { /* Windows */ }
    fs.renameSync(tmp, this.tombstonePath);
  }
  /** Durable intent first: append this revocation to the tombstone WAL.
   *  Throws when the existing journal state is unknown — appending over
   *  unknown bytes would replace the only durable revocation records with a
   *  strictly smaller set (FSEC-005-R4-001). */
  _appendTombstone(d) {
    const journal = this._readTombstones();
    if (journal.state === 'unknown') throw new Error('revocation journal unreadable: refusing to append over unknown revocation state');
    const entries = journal.entries;
    entries.push({
      deviceId: d.deviceId,
      devicePublicKey: typeof d.devicePublicKey === 'string' ? d.devicePublicKey : '',
      registeredAt: typeof d.registeredAt === 'string' ? d.registeredAt : '',
      revokedAt: nowIso(),
    });
    this._writeTombstones(entries);
  }
  _load() {
    let corrupt = false;
    try {
      const data = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      if (isRecord(data) && Array.isArray(data.devices)) {
        for (const d of data.devices) {
          if (!isRecord(d) || typeof d.deviceId !== 'string') { corrupt = true; continue; }
          // Replay state must be intact; corruption bumps the epoch (fail closed).
          // Round-7 R7-REPLAY-05: validating only the CONTAINER let malformed
          // entries survive — a consumed request was re-admitted after restart.
          // Every entry must itself be well-formed: the nonce key is the
          // base64url encoding of 32 random bytes (43 chars, no padding) and
          // its value a safe-integer millisecond timestamp.
          // Round-8 R8-REPLAY-02: alphabet+length is not enough — base64url
          // has non-canonical trailing-bit aliases for the same 32 bytes. A
          // consumed nonce rewritten as its alias survived the round-7 regex
          // check, so the original canonical nonce no longer matched any
          // entry and a consumed request was re-admitted after restart. The
          // canonical decoder (decode/re-encode equality) is the only valid
          // shape test — the same one the signature path enforces.
          const entriesIntact = isRecord(d.nonces) && Object.entries(d.nonces).every(([n, ts]) => decodeB64url(n, 32) !== null && Number.isSafeInteger(ts) && ts >= 0);
          if (!isRecord(d.nonces) || !entriesIntact || !Number.isSafeInteger(d.timestampFloor) || d.timestampFloor < 0) {
            // signedRequest.replay.stateLoss: lost/corrupt replay state bumps the
            // epoch AND requires re-pair before ANY new request is admitted —
            // no silent accumulation. The device becomes inactive until a fresh
            // pair exchange re-registers it.
            d.nonces = {}; d.timestampFloor = 0;
            if (Number.isSafeInteger(d.replayEpoch)) d.replayEpoch += 1;
            d.active = false; d.requiresRepair = true;
            corrupt = true;
          }
          // FSEC-005-R9-001: the revocation flag itself must be a boolean.
          // Truthy non-boolean shapes ('false', 'true', 1, objects, arrays)
          // otherwise slip between two different tests — excluded from the
          // live-key index by truthiness yet still eligible because
          // revoked !== true — leaving two request-eligible registrations
          // for one key. Fail closed: malformed flags are forced ineligible
          // and the repair is persisted.
          if (d.revoked !== undefined && typeof d.revoked !== 'boolean') {
            d.revoked = true;
            d.active = false;
            corrupt = true;
          }
          this.devices.set(d.deviceId, d);
          if (typeof d.devicePublicKey === 'string') {
            // FSEC-005-R8-001: only NON-REVOKED records compete for the live
            // key index. A revoked predecessor is expected to keep the same
            // key in durable bytes — rotation revokes the predecessor while
            // the replacement carries the key forward. Inserting the revoked
            // record first made every legitimate replacement look like a
            // duplicate and revoked it persistently, so a completed pairing
            // was destroyed by the mere act of restarting.
            if (!d.revoked) {
              const existingId = this.keyIndex.get(d.devicePublicKey);
              if (existingId !== undefined) { // live-key uniqueness — fail closed
                d.revoked = true; d.active = false; corrupt = true;
              } else this.keyIndex.set(d.devicePublicKey, d.deviceId);
            }
          }
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') { this.log(`device store load failed (starting empty): ${e.code}`); corrupt = true; }
    }
    // FSEC-005 reconciliation: tombstoned revocations are re-applied over
    // whatever the main file says — revocation of the SAME registration
    // instance (deviceId + key + registeredAt all match) is authoritative.
    // Entries whose registration instance no longer matches (re-paired with
    // a fresh registeredAt/key) are inert and compacted away below.
    let reconciled = false;
    const journal = this._readTombstones();
    // FSEC-005-R4-001 fail-closed: when the journal cannot be read, no device
    // may regain authorization it does not already hold in the main durable
    // bytes — the journal might carry revocations this reconciliation cannot
    // see. Every otherwise-active device is deactivated in memory
    // (requiresRepair) so an operator-visible repair is required; crucially
    // the degraded state is NOT persisted — persisting it would overwrite
    // correct main bytes and still lose the journal. Memory-only means the
    // failure heals itself once the journal file is restored.
    this.revocationJournalUnknown = journal.state === 'unknown';
    if (this.revocationJournalUnknown) {
      for (const d of this.devices.values()) {
        if (!d.revoked) {
          // FSEC-005-R6B-001: capture the pre-degradation field state so
          // serialization can strip the degradation — it must remain
          // memory-only even when an UNRELATED startup repair (corrupt replay
          // state) legitimately persists the file. Persisting active=false
          // here would survive journal restoration and force needless
          // re-pairing of devices that were intact all along.
          if (d._preDegradation === undefined) {
            d._preDegradation = { active: d.active, requiresRepair: d.requiresRepair };
          }
          d.active = false; d.requiresRepair = true;
        }
      }
    } else {
      for (const entry of journal.entries) {
        const d = this.devices.get(entry.deviceId);
        if (d && !d.revoked && d.devicePublicKey === entry.devicePublicKey && d.registeredAt === entry.registeredAt) {
          d.revoked = true; d.active = false;
          if (this.keyIndex.get(d.devicePublicKey) === d.deviceId) this.keyIndex.delete(d.devicePublicKey);
          reconciled = true;
        }
      }
    }
    if (corrupt || (reconciled && !this.revocationJournalUnknown)) this._persist();
  }
  _persist() {
    const tmp = this.path + '.tmp';
    const serializable = [...this.devices.values()].map(d => {
      const copy = { ...d };
      delete copy.revocationPersistenceFailed;
      // FSEC-005-R6B-001: unknown-journal degradation is memory-only, no
      // matter what else triggers this persist. Explicit later operations
      // (epoch bump) clear the marker on their own record when their own
      // deactivation is intentional and durable.
      const pre = copy._preDegradation;
      delete copy._preDegradation;
      if (this.revocationJournalUnknown && pre) {
        copy.active = pre.active;
        if (pre.requiresRepair === undefined) delete copy.requiresRepair;
        else copy.requiresRepair = pre.requiresRepair;
      }
      return copy;
    });
    fs.writeFileSync(tmp, JSON.stringify({ devices: serializable }, null, 2), 'utf8');
    try { fs.chmodSync(tmp, 0o600); } catch { /* Windows */ }
    fs.renameSync(tmp, this.path);
    // Main file is now authoritative for everything it contains: compact the
    // tombstone WAL by dropping entries whose registration instance is already
    // revoked in durable bytes (or no longer exists). Compaction failure is
    // harmless — stale entries are inert or idempotently re-applied.
    try {
      const journal = this._readTombstones();
      // FSEC-005-R4-001: compaction may never run over unknown journal bytes —
      // writing an empty/filtered list across unknown state would permanently
      // destroy revocations already acknowledged as durable.
      if (journal.state === 'unknown') return;
      const remaining = journal.entries.filter(entry => {
        const d = this.devices.get(entry.deviceId);
        if (!d) return false;
        if (d.devicePublicKey !== entry.devicePublicKey || d.registeredAt !== entry.registeredAt) return false;
        return d.revoked !== true;
      });
      this._writeTombstones(remaining);
    } catch { /* compaction is best-effort; durability never depends on it */ }
  }

  count() { return this.devices.size; }
  get(deviceId) { const d = this.devices.get(deviceId); return isRecord(d) ? d : null; }
  /** devicePublicKey must be unique across live registrations (contract). */
  deviceIdForKey(devicePublicKey) {
    const id = this.keyIndex.get(devicePublicKey);
    const d = id ? this.devices.get(id) : null;
    return d && !d.revoked ? id : null;
  }

  /** Full completeness gate — same fields the validator requires before signature work. */
  recordComplete(d, nowMs = Date.now()) {
    return isRecord(d)
      && typeof d.deviceId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(d.deviceId)
      && typeof d.devicePublicKey === 'string' && decodeB64url(d.devicePublicKey, 32) !== null
      && Array.isArray(d.grantedScopes) && d.grantedScopes.length >= 2
      && d.grantedScopes.every(s => REMOTE_V1.scopeVocabulary.includes(s))
      && d.active === true && d.revoked !== true
      && Number.isSafeInteger(d.replayEpoch) && d.replayEpoch >= 1
      && typeof d.expiresAt === 'string' && Number.isFinite(Date.parse(d.expiresAt)) && Date.parse(d.expiresAt) > nowMs
      && isRecord(d.grants);
  }
  active(deviceId, nowMs = Date.now()) {
    const d = this.get(deviceId);
    return this.recordComplete(d, nowMs) ? d : null;
  }

  /**
   * Atomic registration transaction for the pair exchange. Consumes the
   * approval + session + code atomically ONLY if the store callback confirms;
   * re-checks capacity, expiry and device-key uniqueness inside the transaction.
   * Returns { replayEpoch, deviceId } or null (caller maps to pair_code_consumed_or_limited).
   */
  register({ deviceId, devicePublicKey, grantedScopes, serviceFingerprint, expiresAt, deviceName, grantedProjectIds = [] }) {
    const expiryMs = Date.parse(expiresAt ?? '');
    if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) return null;
    const existing = this.devices.get(deviceId);
    if (!existing && this.devices.size >= L.maxDevices) return null;
    const boundTo = this.deviceIdForKey(devicePublicKey);
    // Contract deviceLifecycle.rotation: re-pairing an already-bound device
    // key atomically revokes the prior binding in the same transaction —
    // the old deviceId is revoked (its streams die on the next recheck)
    // rather than leaving two records or rejecting the re-pair.
    // FS-001 rollback requires the TRUE pre-transaction state — snapshot
    // BEFORE mutating anything (the rotation block below flips the fields).
    // FR-001: capture the COMPLETE pre-transaction state of every index and
    // record this transaction may touch, BEFORE mutating anything. Rollback
    // must restore exactly this — no key-index entry may be resurrected that
    // did not point where the restoration puts it back, or a failed write
    // would overwrite another live device's binding.
    const priorRec = boundTo !== null && boundTo !== deviceId ? this.devices.get(boundTo) : null;
    const preTx = {
      hadExisting: isRecord(existing),
      existing: existing ?? null,
      existingKeyOwned: isRecord(existing) && typeof existing.devicePublicKey === 'string' && this.keyIndex.get(existing.devicePublicKey) === deviceId,
      priorRec,
      priorRevoked: priorRec?.revoked,
      priorActive: priorRec?.active,
      priorKeyOwned: priorRec ? this.keyIndex.get(priorRec.devicePublicKey) === boundTo : false,
    };
    var priorState = null;
    if (priorRec) priorState = { rec: priorRec, revoked: priorRec.revoked, active: priorRec.active, hadKeyBinding: preTx.priorKeyOwned };
    if (boundTo !== null && boundTo !== deviceId) {
      const prior = this.devices.get(boundTo);
      if (prior) { prior.revoked = true; prior.active = false; this.keyIndex.delete(devicePublicKey); }
    }
    const replayEpoch = isRecord(existing) && Number.isSafeInteger(existing.replayEpoch) ? existing.replayEpoch + 1 : 1;
    // FR-001 mutation side: the predecessor's key-index entry may only be
    // deleted when it actually points at THIS deviceId. When the old key was
    // since re-paired to a different live device, that binding belongs to the
    // other device — deleting it would silently unbind their key and break
    // the rotation invariant even on the success path.
    if (existing && typeof existing.devicePublicKey === 'string' && this.keyIndex.get(existing.devicePublicKey) === deviceId) this.keyIndex.delete(existing.devicePublicKey);
    const grants = {};
    for (const pid of grantedProjectIds) if (typeof pid === 'string' && pid) grants[pid] = true;
    const rec = {
      deviceId, deviceName: String(deviceName ?? ''), devicePublicKey,
      serviceFingerprint, serviceId: `svc-${serviceFingerprint.slice(0, 16)}`,
      grantedScopes: [...grantedScopes],
      grants,
      active: true, revoked: false,
      replayEpoch,
      expiresAt,
      registeredAt: nowIso(),
      nonces: {},
      timestampFloor: 0,
      // Round-7 R7-GEN-03: re-registering the same deviceId must carry the
      // durable stream-generation floor forward — resetting it let the server
      // re-issue generations the pinned client already consumed, breaking
      // forward recovery after an ordinary re-pair.
      ...(Number.isSafeInteger(existing?.streamGenerationFloor) ? { streamGenerationFloor: existing.streamGenerationFloor } : {}),
    };
    // FSEC-005-R7-001 coherent freeze: while the revocation journal is
    // unreadable, NO authorization may exist in memory — including freshly
    // registered instances. Without this, a re-pair performed during the
    // journal outage was active for the rest of the session yet degraded
    // after the next restart: two different answers to the same unverifiable
    // revocation state. The uniform freeze makes session and restart agree,
    // and because the durable record itself stays active=true (it is the
    // journal restart-time reconciliation that degrades), recovery is
    // automatic when the journal is restored. Intentional registrations do
    // not carry a degradation marker — their restart-time degradation is
    // inherent, not a serialization concern.
    if (this.revocationJournalUnknown && rec.revoked !== true) {
      // The marker carries the registration's TRUE durable intent
      // (active: true) — serialization strips the degradation so durable
      // bytes describe the actual registration, memory freezes uniformly,
      // and journal restoration heals the fresh instance exactly like every
      // pre-existing one. Without the marker this would be the R6B leak all
      // over again: frozen bytes permanently bricking the device.
      rec._preDegradation = { active: true };
      rec.active = false;
      rec.requiresRepair = true;
    }
    this.devices.set(deviceId, rec);
    this.keyIndex.set(devicePublicKey, deviceId);
    try {
      this._persist();
    } catch (e) {
      // FS-001: memory must never carry active credentials the disk does not
      // confirm — a failed registration that stayed memory-active authenticated
      // with 200 while the pairing had already failed. Roll back every mutation
      // this transaction made (record, key index, prior-binding revocation,
      // replaced predecessor) so memory keeps describing exactly what persists.
      this.devices.delete(deviceId);
      this.keyIndex.delete(devicePublicKey);
      if (preTx.hadExisting) {
        this.devices.set(deviceId, preTx.existing);
        // Restore the predecessor's key-index entry ONLY if the transaction
        // actually removed one — i.e. the entry pointed at this deviceId
        // before the mutation. A binding that was absent or owned by another
        // device must never be resurrected/hijacked by rollback (FR-001).
        if (preTx.existingKeyOwned) this.keyIndex.set(preTx.existing.devicePublicKey, deviceId);
      }
      if (priorState) {
        priorState.rec.revoked = priorState.revoked;
        priorState.rec.active = priorState.active;
        if (priorState.hadKeyBinding) this.keyIndex.set(priorState.rec.devicePublicKey, boundTo);
      }
      throw e;
    }
    if (boundTo !== null && boundTo !== deviceId) this.onAuthorizationChanged?.(boundTo, 'revoked');
    this.onAuthorizationChanged?.(deviceId, 'registered');
    return { replayEpoch, deviceId };
  }

  /**
   * Revocation is an authoritative transaction: mark revoked + inactive,
   * drop the key binding, persist. Live streams are closed by the caller
   * (the gateway subscribes this list).
   */
  /**
   * FSEC-005 revocation durability protocol. Revocation proceeds as a
   * write-ahead transaction:
   *   1. Tombstone WAL append (durable intent, independent file channel).
   *   2. In-memory mutation — sticky, never rolled back (FS-001).
   *   3. Main store persistence (authoritative record; also compacts the WAL).
   * The revocation is DURABLE if at least one durable channel landed: a
   * restart either reads the main file (device revoked) or reconciles the
   * tombstone over it (device revoked again). Only a double write failure
   * leaves the revocation memory-only — in that case callers are told
   * durable:false so the failure is never acknowledged as success, and the
   * same revoke call doubles as the operator retry path (tombstone append
   * and main persist are both re-attempted for an already-revoked record).
   * Returns false only for a device that does not exist at all.
   */
  revoke(deviceId) {
    const d = this.devices.get(deviceId);
    if (!d) return false;
    let tombstoned = false;
    let persisted = false;
    try {
      this._appendTombstone(d);
      tombstoned = true;
    } catch (e) {
      this.log(`device revocation tombstone failed for ${deviceId}: durable intent not recorded`);
    }
    const first = d.revoked !== true;
    if (first) {
      // FS-001: authorization LOSS is never rolled back. The fail-closed
      // direction keeps denying in memory and kills the streams regardless
      // of what durability achieves.
      d.revoked = true; d.active = false;
      if (typeof d.devicePublicKey === 'string' && this.keyIndex.get(d.devicePublicKey) === deviceId) this.keyIndex.delete(d.devicePublicKey);
    }
    try {
      this._persist();
      persisted = true;
    } catch (e) {
      this.log(`device revocation persistence failed for ${deviceId}: authorization stays revoked in memory`);
    }
    if (first) {
      // Invalidation is unconditional — it must never depend on the durability
      // of the revocation that caused it.
      this.onAuthorizationChanged?.(deviceId, 'revoked');
    }
    const durable = tombstoned || persisted;
    // Operator-visible in-memory signal; cleared by a durable retry. It is a
    // runtime annotation, never written into durable bytes — after a restart
    // the disk record is the only truth and a falsely persisted flag would
    // misrepresent it.
    d.revocationPersistenceFailed = !durable;
    return { revoked: true, durable, alreadyRevoked: !first };
  }
  list() {
    return [...this.devices.values()].map(d => ({
      deviceId: d.deviceId, deviceName: d.deviceName, grantedScopes: d.grantedScopes,
      grants: Object.keys(d.grants ?? {}), expiresAt: d.expiresAt, registeredAt: d.registeredAt,
      revoked: d.revoked === true,
      revocationPersistenceFailed: d.revocationPersistenceFailed === true || undefined,
    }));
  }
  setGrants(deviceId, projectIds) {
    const d = this.devices.get(deviceId);
    if (!d) return false;
    // FS-001: grant WIDENING is authorization gain — it must never exist only
    // in memory. Roll back on persistence failure so memory and disk agree;
    // removal safety is independently guaranteed by execution-time
    // revalidation of queued mutations.
    const previous = d.grants;
    d.grants = {};
    for (const pid of projectIds ?? []) if (typeof pid === 'string' && pid) d.grants[pid] = true;
    try {
      this._persist();
    } catch (e) {
      d.grants = previous;
      throw e;
    }
    this.onAuthorizationChanged?.(deviceId, 'grants_changed');
    return true;
  }

  /**
   * consumeNonce(deviceId, nonce, timestamp) for verifyRemoteSignature.
   * Enforces: effective clock, strict timestamp floor, nonce uniqueness,
   * retention pruning and capacity fail-closed. Persists on accept.
   */
  consumeNonce = (deviceId, nonce, timestamp) => {
    const d = this.devices.get(deviceId);
    if (!isRecord(d) || !isRecord(d.nonces) || !Number.isSafeInteger(d.timestampFloor)) return false;
    if (!Number.isSafeInteger(timestamp)) return false;
    // Effective clock never moves backward with the wall clock.
    const now = Math.max(Date.now(), d.timestampFloor);
    // STRICT floor: a signed timestamp below the floor is rejected even in-skew.
    if (timestamp < d.timestampFloor) return false;
    if (timestamp > now + SKEW_MS) return false;
    if (d.nonces[nonce] !== undefined) return false;
    // Prune: evictable only when < floor AND older than retention. The pruned
    // entries are part of this transaction's memory mutation (FR-002): a
    // failed persist must restore them or memory would enforce a stricter
    // rejection surface than the durable state justifies.
    const pruned = [];
    for (const [n, ts] of Object.entries(d.nonces)) {
      if (ts < d.timestampFloor && ts < now - RETENTION_MS) { pruned.push([n, ts]); delete d.nonces[n]; }
    }
    if (Object.keys(d.nonces).length >= L.maxNonceEntriesPerDevice) return false; // fail closed
    d.nonces[nonce] = timestamp;
    const previousFloor = d.timestampFloor;
    if (timestamp > d.timestampFloor) d.timestampFloor = timestamp;
    try {
      this._persist();
    } catch (e) {
      // FS-001: an undurable nonce acceptance is replayable after restart —
      // the consumed state must never exist only in memory.
      delete d.nonces[nonce];
      d.timestampFloor = previousFloor;
      for (const [n, ts] of pruned) d.nonces[n] = ts;
      throw e;
    }
    return true;
  };

  /** Bump replayEpoch when persisted replay state is lost/corrupt (contract). */
  bumpReplayEpoch(deviceId) {
    const d = this.devices.get(deviceId);
    if (!d) return false;
    d.replayEpoch = (Number.isSafeInteger(d.replayEpoch) ? d.replayEpoch : 0) + 1;
    d.nonces = {}; d.timestampFloor = 0;
    // Contract replay.stateLoss: the device must re-pair before any new
    // request is admitted. Epoch bump alone still let the SAME key sign under
    // the new epoch without re-pairing (round-6 R6-SECURITY-2) — fail closed.
    d.active = false; d.requiresRepair = true;
    // This deactivation is intentional and durable — not journal-unknown
    // degradation. Clearing the marker lets it serialize even while the
    // journal is unreadable.
    delete d._preDegradation;
    try {
      this._persist();
    } catch (e) {
      // FS-001: deactivation is authorization loss — sticky in memory even
      // when durability fails, same as revocation.
      this.log(`replay-epoch bump persistence failed for ${deviceId}: device stays inactive in memory`);
    }
    this.onAuthorizationChanged?.(deviceId, 'epoch_changed');
    return true;
  }

  /**
   * Stream-generation durability floor (round-6 R6-CORRECTNESS-3): server-issued
   * subscription generations are monotonic for the authenticated device ACROSS
   * restarts, or the pinned client (which rejects lower generations) can never
   * recover after a routine reboot. The floor persists inside the device
   * record — the same atomic file as the rest of the authentication state.
   */
  streamGenerationFloor(deviceId) {
    const d = this.devices.get(deviceId);
    return Number.isSafeInteger(d?.streamGenerationFloor) ? d.streamGenerationFloor : 0;
  }
  persistStreamGenerationFloor(deviceId, floor) {
    // Round-7 R7-GEN-04: the floor is meaningless unless it is durable BEFORE
    // the generation it bounds can be issued. Throws propagate to the caller
    // (event-stream) which must refuse to mint the generation rather than
    // sign frames it cannot guarantee monotonicity for.
    const d = this.devices.get(deviceId);
    if (!d || !Number.isSafeInteger(floor)) return;
    if (!(floor > (d.streamGenerationFloor ?? 0))) return;
    const previous = d.streamGenerationFloor;
    d.streamGenerationFloor = floor;
    try {
      this._persist();
    } catch (e) {
      d.streamGenerationFloor = previous;
      throw e;
    }
  }
}

export function newDeviceId() {
  return 'dev_' + crypto.randomBytes(16).toString('base64url').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 22);
}
