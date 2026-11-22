/**
 * Pair manager — short-lived pairing codes, one-time pair exchange and the
 * signed-pair-transcript verification. The pair transaction is the ONLY path
 * that mints a device record; everything else consumes it.
 *
 * Security notes (mirroring the mobile contract):
 *   - pairing codes are single-use, short-lived and stored hashed (sha256)
 *   - code is verified only AFTER the pair proof (signature + fingerprint),
 *     so a wrong code is indistinguishable from a missing one to the oracle
 *   - the mobile public key is Ed25519; the fingerprint is sha256(x/pi/gui|key)
 */
import crypto from 'node:crypto';
import { sha256, b64url, decodeB64url, ed25519Verify, timingSafe, isRecord, HEX_SHA256, REMOTE_V1 } from './contract.mjs';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/I/1
const CODE_LEN = 8;
const CODE_TTL_MS = 120_000;
const MAX_PENDING = 8;
const PAIR_PROOF_DOMAIN = 'pi-gui-remote-pair-v1';

function now() { return Date.now(); }

export class PairManager {
  constructor({ serviceKey, serviceFingerprint, deviceStore, log = () => {} }) {
    this.serviceKey = serviceKey;               // { publicKeyRaw, privateKeyDer }
    this.serviceFingerprint = serviceFingerprint;
    this.deviceStore = deviceStore;
    this.log = log;
    this.pending = new Map();                  // codeHash -> { codeHash, expiresAtMs, challenge }
  }
  _issueCode() {
    const bytes = crypto.randomBytes(CODE_LEN);
    let code = '';
    for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    return code;
  }
  // Called by the local UI (trusted operator) to mint a pairing code. Returns
  // the plaintext code ONCE; only the hash is stored for verification.
  issuePairingCode() {
    if (this.pending.size >= MAX_PENDING) return null;
    const code = this._issueCode();
    const codeHash = sha256(code);
    const challenge = crypto.randomBytes(32).toString('base64url');
    this.pending.set(codeHash, { codeHash, expiresAtMs: now() + CODE_TTL_MS, challenge });
    return { code, challenge, expiresAt: new Date(now() + CODE_TTL_MS).toISOString() };
  }
  _pendingFor(code) {
    const codeHash = sha256(code);
    const p = this.pending.get(codeHash);
    if (!p) return null;
    if (p.expiresAtMs <= now()) { this.pending.delete(codeHash); return null; }
    return p;
  }
  // The pair proof the mobile signs: sha256(domain|devicePublicKey|serviceFingerprint|challenge).
  pairProofDigest(devicePublicKey, serviceFingerprint, challenge) {
    return sha256([PAIR_PROOF_DOMAIN, devicePublicKey, serviceFingerprint, challenge].join('|'));
  }
  /**
   * The atomic pair exchange. On success consumes the code and registers the
   * device in a single transaction; returns the signed pair response.
   * Order: pair-proof signature FIRST, only then the code — same oracle as the
   * reference contract (no correct-code hint from early rejects).
   */
  exchange(body, nowMs = now()) {
    if (!isRecord(body)) return { status: 400, error: 'invalid_request' };
    const {
      pairCode, deviceId, devicePublicKey, proof,
      scopes, expiresAt, challenge, deviceName,
    } = body;
    // shape gates
    if (typeof pairCode !== 'string' || pairCode.length < 6) return { status: 400, error: 'invalid_request' };
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(deviceId)) return { status: 400, error: 'invalid_request' };
    if (!decodeB64url(devicePublicKey, 32)) return { status: 400, error: 'invalid_request' };
    if (!decodeB64url(proof, 64)) return { status: 400, error: 'invalid_request' };
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 7) return { status: 400, error: 'invalid_request' };
    const allowed = new Set(REMOTE_V1.scopeVocabulary);
    if (scopes.some(s => !allowed.has(s)) || new Set(scopes).size !== scopes.length) return { status: 400, error: 'scope_denied' };
    if (typeof challenge !== 'string' || !challenge) return { status: 400, error: 'invalid_request' };
    if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) return { status: 400, error: 'invalid_request' };

    // 1. verify the pair proof signature over the transcript FIRST (no code oracle)
    const pending = this._pendingFor(pairCode);
    if (!pending) return { status: 401, error: 'unauthorized' };
    if (pending.challenge !== challenge) return { status: 401, error: 'unauthorized' };
    const digest = this.pairProofDigest(devicePublicKey, this.serviceFingerprint, challenge);
    const proofOk = ed25519Verify(devicePublicKey, proof, Buffer.from(digest, 'hex'));
    if (!proofOk) {
      this.pending.delete(pending.codeHash);        // burn the code on bad proof
      return { status: 401, error: 'unauthorized' };
    }
    // 2. only now verify the code itself (constant-time on the stored hash)
    if (!timingSafe(pending.codeHash, sha256(pairCode))) {
      this.pending.delete(pending.codeHash);
      return { status: 401, error: 'unauthorized' };
    }
    // 3. transaction: consume the code and register the device in one step.
    this.pending.delete(pending.codeHash);
    const rec = this.deviceStore.register({
      deviceId, devicePublicKey,
      grantedScopes: scopes,
      serviceFingerprint: this.serviceFingerprint,
      expiresAt: expiresAt ?? new Date(nowMs + 90 * 86400000).toISOString(),
      deviceName,
    });
    if (!rec) return { status: 429, error: 'rate_limited' };
    return {
      status: 200,
      replayEpoch: rec.replayEpoch,
      response: {
        protocolVersion: 1,
        accepted: true,
        serviceFingerprint: this.serviceFingerprint,
        replayEpoch: rec.replayEpoch,
        expiresAt: rec.expiresAt,
        scopesGranted: rec.grantedScopes,
      },
    };
  }
}
