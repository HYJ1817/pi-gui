/**
 * Remote device registry — paired mobile devices, their identity, scope grants,
 * replay/nonces and revocation. File-backed under the desktop DATA_DIR so a
 * restart does not silently re-admit devices; access is gated by the OS file
 * ACL on the data dir (same trust level as every other desktop secret).
 *
 * This is the single writer of device truth; every signed request re-reads the
 * record, never a cached copy, so revocation takes effect on the next request.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sha256, isRecord, HEX_SHA256, OPAQUE_ID, decodeB64url, timingSafe } from './contract.mjs';

const FILE = 'remote-devices.json';
const MAX_DEVICES = 32;

function nowIso() { return new Date().toISOString(); }

export class DeviceStore {
  constructor(dataDir, log = () => {}) {
    this.dir = dataDir;
    this.path = path.join(dataDir, FILE);
    this.log = log;
    this.devices = new Map();   // deviceId -> record
    this._load();
  }
  _load() {
    try {
      const raw = fs.readFileSync(this.path, 'utf8');
      const data = JSON.parse(raw);
      if (isRecord(data) && Array.isArray(data.devices)) {
        for (const d of data.devices) if (isRecord(d) && typeof d.deviceId === 'string') this.devices.set(d.deviceId, d);
      }
      this.log(`loaded ${this.devices.size} remote device record(s)`);
    } catch (e) {
      if (e.code !== 'ENOENT') this.log(`device store load failed (starting empty): ${e.code}`);
    }
  }
  _persist() {
    const tmp = this.path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ devices: [...this.devices.values()] }, null, 2), 'utf8');
    try { fs.chmodSync(tmp, 0o600); } catch { /* Windows */ }
    fs.renameSync(tmp, this.path);
  }
  count() { return this.devices.size; }
  get(deviceId) {
    const d = this.devices.get(deviceId);
    return isRecord(d) ? d : null;
  }
  // Full record completeness check (same gate as the mobile contract validator).
  recordComplete(d, nowMs = Date.now()) {
    return isRecord(d)
      && OPAQUE_ID.test(d.deviceId)
      && typeof d.devicePublicKey === 'string' && decodeB64url(d.devicePublicKey, 32) !== null
      && Array.isArray(d.grantedScopes) && d.grantedScopes.length > 0
      && d.active === true && d.revoked !== true
      && Number.isSafeInteger(d.replayEpoch) && d.replayEpoch >= 1
      && typeof d.expiresAt === 'string' && Number.isFinite(Date.parse(d.expiresAt)) && Date.parse(d.expiresAt) > nowMs
      && isRecord(d.grants);
  }
  active(deviceId, nowMs = Date.now()) {
    const d = this.get(deviceId);
    return this.recordComplete(d, nowMs) ? d : null;
  }
  serviceId(d) { return d.serviceId; }
  // Register a device atomically (called by the pair transaction). Allocates
  // replayEpoch: re-pairs bump it so stale signed requests die with the epoch.
  register({ deviceId, devicePublicKey, grantedScopes, serviceFingerprint, expiresAt, deviceName }) {
    if (this.devices.size >= MAX_DEVICES && !this.devices.has(deviceId)) return null;
    const existing = this.devices.get(deviceId);
    const replayEpoch = isRecord(existing) && Number.isSafeInteger(existing.replayEpoch) ? existing.replayEpoch + 1 : 1;
    const rec = {
      deviceId, deviceName: String(deviceName ?? ''), devicePublicKey,
      serviceFingerprint,
      serviceId: `svc-${serviceFingerprint.slice(0, 16)}`,
      grantedScopes: [...grantedScopes],
      grants: {},
      active: true, revoked: false,
      replayEpoch,
      expiresAt,
      registeredAt: nowIso(),
      nonces: {},           // nonce -> seenAtMs
      timestampFloor: 0,    // monotonic accepted timestamp floor
      subscriptions: {},
    };
    this.devices.set(deviceId, rec);
    this._persist();
    return rec;
  }
  revoke(deviceId) {
    const d = this.devices.get(deviceId);
    if (!d) return false;
    d.revoked = true; d.active = false;
    this._persist();
    return true;
  }
  setGrants(deviceId, grants) {
    const d = this.devices.get(deviceId);
    if (!d) return false;
    d.grants = { ...grants };
    this._persist();
    return true;
  }
  // Per-device replay state: nonce set (capped) + monotonic timestamp floor.
  seenNonce(d, nonce, nowMs) {
    if (d.nonces[nonce]) return true;
    d.nonces[nonce] = nowMs;
    const keys = Object.keys(d.nonces);
    if (keys.length > 4096) {
      // evict oldest beyond floor window; keep recent to bound memory
      keys.sort((a, b) => d.nonces[a] - d.nonces[b]);
      for (const k of keys.slice(0, keys.length - 4096)) delete d.nonces[k];
    }
    return false;
  }
  bumpTimestampFloor(d, ts) {
    if (Number.isSafeInteger(ts) && ts > (d.timestampFloor || 0)) d.timestampFloor = ts;
  }
}
