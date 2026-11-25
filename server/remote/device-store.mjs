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
    this._load();
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
          const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
          const entriesIntact = isRecord(d.nonces) && Object.entries(d.nonces).every(([n, ts]) => NONCE_RE.test(n) && Number.isSafeInteger(ts) && ts >= 0);
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
          this.devices.set(d.deviceId, d);
          if (typeof d.devicePublicKey === 'string') {
            if (this.keyIndex.has(d.devicePublicKey)) { // key uniqueness — fail closed
              d.revoked = true; d.active = false; corrupt = true;
            } else this.keyIndex.set(d.devicePublicKey, d.deviceId);
          }
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') { this.log(`device store load failed (starting empty): ${e.code}`); corrupt = true; }
    }
    if (corrupt) this._persist();
  }
  _persist() {
    const tmp = this.path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ devices: [...this.devices.values()] }, null, 2), 'utf8');
    try { fs.chmodSync(tmp, 0o600); } catch { /* Windows */ }
    fs.renameSync(tmp, this.path);
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
    if (boundTo !== null && boundTo !== deviceId) {
      // Contract deviceLifecycle.rotation: re-pairing an already-bound device
      // key atomically revokes the prior binding in the same transaction —
      // the old deviceId is revoked (its streams die on the next recheck)
      // rather than leaving two records or rejecting the re-pair.
      const prior = this.devices.get(boundTo);
      if (prior) { prior.revoked = true; prior.active = false; this.keyIndex.delete(devicePublicKey); }
    }
    const replayEpoch = isRecord(existing) && Number.isSafeInteger(existing.replayEpoch) ? existing.replayEpoch + 1 : 1;
    if (existing) this.keyIndex.delete(existing.devicePublicKey);
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
    this.devices.set(deviceId, rec);
    this.keyIndex.set(devicePublicKey, deviceId);
    this._persist();
    if (boundTo !== null && boundTo !== deviceId) this.onAuthorizationChanged?.(boundTo, 'revoked');
    this.onAuthorizationChanged?.(deviceId, 'registered');
    return { replayEpoch, deviceId };
  }

  /**
   * Revocation is an authoritative transaction: mark revoked + inactive,
   * drop the key binding, persist. Live streams are closed by the caller
   * (the gateway subscribes this list).
   */
  revoke(deviceId) {
    const d = this.devices.get(deviceId);
    if (!d || d.revoked) return false;
    d.revoked = true; d.active = false;
    if (typeof d.devicePublicKey === 'string' && this.keyIndex.get(d.devicePublicKey) === deviceId) this.keyIndex.delete(d.devicePublicKey);
    this._persist();
    this.onAuthorizationChanged?.(deviceId, 'revoked');
    return true;
  }
  list() {
    return [...this.devices.values()].map(d => ({
      deviceId: d.deviceId, deviceName: d.deviceName, grantedScopes: d.grantedScopes,
      grants: Object.keys(d.grants ?? {}), expiresAt: d.expiresAt, registeredAt: d.registeredAt,
      revoked: d.revoked === true,
    }));
  }
  setGrants(deviceId, projectIds) {
    const d = this.devices.get(deviceId);
    if (!d) return false;
    d.grants = {};
    for (const pid of projectIds ?? []) if (typeof pid === 'string' && pid) d.grants[pid] = true;
    this._persist();
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
    // Prune: evictable only when < floor AND older than retention.
    for (const [n, ts] of Object.entries(d.nonces)) {
      if (ts < d.timestampFloor && ts < now - RETENTION_MS) delete d.nonces[n];
    }
    if (Object.keys(d.nonces).length >= L.maxNonceEntriesPerDevice) return false; // fail closed
    d.nonces[nonce] = timestamp;
    if (timestamp > d.timestampFloor) d.timestampFloor = timestamp;
    this._persist();
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
    this._persist();
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
