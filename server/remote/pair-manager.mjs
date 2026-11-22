/**
 * Remote v1 pair manager — issues short-lived pairing sessions (6-digit
 * CSPRNG code + pairingSessionId shown only through the trusted desktop
 * channel/QR) and runs the ONE-TIME pair exchange via the vendored validator's
 * authorizePairExchange.
 *
 * Contract rules implemented here:
 *  - pairingSessionId: base64url-no-padding-16-random-bytes (22 chars), expires
 *    with the code, single use, max maxPendingSessions in flight
 *  - code storage: HMAC-SHA256(installation-secret, sessionId || code),
 *    constant-time compare, plaintext code NEVER persisted or logged
 *  - budgets: per-peer + global attempt budgets charged BEFORE session/code
 *    lookup; every submitted code consumes the session attempt budget
 *  - desktop confirmation binds a one-time approvalId to the FULL verified
 *    transcript + exact approved scope set; registration consumes
 *    (approvalId + code + session) atomically
 *  - registration commits the allocated replayEpoch, signs the response only
 *    AFTER commit
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REMOTE_V1, authorizePairExchange, wireErrorCode } from './protocol.mjs';
import { b64url, timingSafeEqual, isRecord } from './keys.mjs';

const L = REMOTE_V1.limits;
const P = REMOTE_V1.transport.pairing;
const CODE_TTL_MS = P.ttlSeconds * 1000;
const ATTEMPT_WINDOW_MS = P.attemptWindowSeconds * 1000;
const SESSION_ATTEMPTS = P.perSessionAttemptLimit;
const MAX_PENDING = P.maxPendingSessions;
const PEER_ATTEMPTS = P.maxAttemptsPerWindow;         // per peer per window
const GLOBAL_ATTEMPTS = P.maxAttemptsPerWindow * 4;   // global code-attempt budget per window

const nowIso = () => new Date().toISOString();

export class PairManager {
  /**
   * @param serviceKey   { privateKeyDer, publicKeyRaw }
   * @param serviceFingerprint  pinned TLS cert SHA-256 (hex)
   * @param deviceStore  DeviceStore
   * @param confirmLocally  async (confirmation) => approvalId|null — the
   *        trusted local/desktop channel. Production: the authenticated
   *        loopback UI; when absent, every exchange fails closed
   *        (unavailable), never silently approved.
   * @param grantedScopesFor  (requestedScopes) => scope[] — the exact scope set
   *        the local confirmation approved; defaults to requested∩vocabulary.
   * @param grantsFor  (deviceRecord) => projectId[] — project grants bound at
   *        registration (default-deny deviceGrants model).
   */
  constructor({ dataDir, serviceKey, serviceFingerprint, deviceStore,
                confirmLocally = null, grantedScopesFor = null, grantsFor = null, log = () => {} }) {
    this.dataDir = dataDir;
    this.serviceKey = serviceKey;
    this.serviceFingerprint = serviceFingerprint;
    this.deviceStore = deviceStore;
    this.confirmLocally = confirmLocally;
    this.grantedScopesFor = grantedScopesFor;
    this.grantsFor = grantsFor;
    this.log = log;
    this.sessions = new Map();        // pairingSessionId -> session
    this.peerAttempts = new Map();    // peerId -> [timestamps]
    this.globalAttempts = [];         // timestamps
    this.pendingApprovals = new Map(); // approvalId -> {transcriptHash, scopeSet}
    this._installSecret = this._loadInstallSecret();
  }
  _loadInstallSecret() {
    const p = path.join(this.dataDir, 'remote-install-secret.bin');
    try { return fs.readFileSync(p); } catch {}
    const secret = crypto.randomBytes(32);
    try {
      fs.writeFileSync(p, secret, { mode: 0o600 });
      fs.chmodSync(p, 0o600);
    } catch (e) { this.log(`install secret persist failed: ${e.code}`); }
    return secret;
  }
  _codeMac(sessionId, code) {
    return crypto.createHmac('sha256', this._installSecret).update(sessionId).update(code).digest();
  }

  /**
   * Local-admin op: mint a pairing session. Returns the PLAINTEXT code exactly
   * once (for the QR/local UI); the store keeps only the HMAC.
   */
  issuePairing({ ttlMs = CODE_TTL_MS } = {}) {
    this._gc();
    if (this.sessions.size >= MAX_PENDING) return null;
    const pairingSessionId = b64url(crypto.randomBytes(16));
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAtMs = Date.now() + ttlMs;
    const rec = {
      pairingSessionId,
      codeMac: this._codeMac(pairingSessionId, code),
      expiresAtMs,
      attempts: 0,
      consumed: false,
      createdAt: nowIso(),
    };
    this.sessions.set(pairingSessionId, rec);
    return { pairingSessionId, code, expiresAt: new Date(expiresAtMs).toISOString(), serviceFingerprint: this.serviceFingerprint };
  }
  cancelPairing(pairingSessionId) {
    const s = this.sessions.get(pairingSessionId);
    if (s) { s.consumed = true; this.sessions.delete(pairingSessionId); }
    return !!s;
  }
  _gc() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (s.expiresAtMs <= now || s.consumed) this.sessions.delete(id);
    for (const [peer, list] of this.peerAttempts) {
      const kept = list.filter(t => t > now - ATTEMPT_WINDOW_MS);
      if (kept.length) this.peerAttempts.set(peer, kept); else this.peerAttempts.delete(peer);
    }
    this.globalAttempts = this.globalAttempts.filter(t => t > now - ATTEMPT_WINDOW_MS);
  }
  _charge(map, key, max) {
    const list = map.get(key) ?? [];
    if (list.length >= max) return false;
    list.push(Date.now()); map.set(key, list);
    return true;
  }

  /** Local-admin records a one-time approval for an exchange transcript. */
  issueApproval({ pairingSessionId, pairCode, deviceName, devicePublicKey, clientNonce, serviceFingerprint, requestedScopes, proofTranscript }) {
    const approvalId = 'ap_' + b64url(crypto.randomBytes(16));
    this.pendingApprovals.set(approvalId, {
      pairingSessionId, pairCode, deviceName, devicePublicKey, clientNonce,
      serviceFingerprint, requestedScopes: [...(requestedScopes ?? [])],
      proofTranscript, at: Date.now(),
    });
    return approvalId;
  }

  /**
   * POST /remote/v1/pair/exchange. request is the parsed contract request
   * ({method,path,query,headers,body,rawBody}); peerId is server-derived.
   * confirmLocallyOverride lets a local admin path inject the desktop
   * confirmation; when null, injected this.confirmLocally is used; when that is
   * also null the exchange fails closed with 'unavailable'.
   */
  exchange(request, { peerId, nowMs = Date.now() } = {}) {
    // The local confirmation channel: injected confirmLocally, else the
    // pre-minted approval store the loopback admin API fills (issueApproval).
    // A missing channel + no minted approval => fail closed (unavailable).
    const confirm = typeof this.confirmLocally === 'function'
      ? this.confirmLocally
      : (confirmation) => {
          for (const [approvalId, a] of this.pendingApprovals) {
            if (a.pairingSessionId === confirmation.pairingSessionId
              && a.pairCode === confirmation.pairCode
              && a.devicePublicKey === confirmation.devicePublicKey
              && a.clientNonce === confirmation.clientNonce
              && a.serviceFingerprint === confirmation.serviceFingerprint
              && a.proofTranscript === confirmation.proofTranscript) return approvalId;
          }
          return null;
        };
    const grantedScopesFor = this.grantedScopesFor ?? ((body) => body.requestedScopes);
    const self = this;
    const deviceId = 'dev_' + b64url(crypto.randomBytes(16)).slice(0, 22);
    const serverNonce = b64url(crypto.randomBytes(32));
    const expiresAt = new Date(nowMs + 90 * 86400000).toISOString();  // default 90d grant

    const result = authorizePairExchange({
      request,
      expectedServiceFingerprint: this.serviceFingerprint,
      peerId,
      reservePairBudget: ({ peerId: p }) => {
        self._gc();
        if (!self._charge(self.peerAttempts, p, PEER_ATTEMPTS)) return false;
        self.globalAttempts.push(Date.now());
        return self.globalAttempts.length <= GLOBAL_ATTEMPTS;
      },
      validatePairingSession: ({ pairingSessionId }) => {
        const s = self.sessions.get(pairingSessionId);
        return !!s && !s.consumed && s.expiresAtMs > nowMs;
      },
      recordPairAttempt: ({ pairingSessionId }) => {
        const s = self.sessions.get(pairingSessionId);
        if (!s || s.consumed) return false;
        s.attempts += 1;
        if (s.attempts > SESSION_ATTEMPTS) { s.consumed = true; self.sessions.delete(pairingSessionId); return false; }
        return true;
      },
      verifyPairCode: ({ pairingSessionId, pairCode }) => {
        const s = self.sessions.get(pairingSessionId);
        if (!s || s.consumed || s.expiresAtMs <= nowMs) return false;
        return timingSafeEqual(s.codeMac, self._codeMac(pairingSessionId, pairCode));
      },
      confirmLocally: (confirmation) => {
        // The injected local channel decides. A truthy string is the one-time
        // approvalId bound to this exact transcript+scope set.
        const id = confirm(confirmation);
        return typeof id === 'string' && id.length > 0 ? id : null;
      },
      consumePairingCodeAndRegisterDevice: ({ approvalId, pairingSessionId, pairCode, deviceId: did, devicePublicKey, grantedScopes, expiresAt: exp, proofTranscript }) => {
        // Atomic consume: approval + session + code + registration in one step.
        const s = self.sessions.get(pairingSessionId);
        if (!s || s.consumed || s.expiresAtMs <= nowMs) return null;
        if (!timingSafeEqual(s.codeMac, self._codeMac(pairingSessionId, pairCode))) return null;
        const approval = self.pendingApprovals.get(approvalId);
        if (!approval || approval.pairingSessionId !== pairingSessionId
          || approval.pairCode !== pairCode || approval.devicePublicKey !== devicePublicKey
          || approval.proofTranscript !== proofTranscript) return null;
        const grantedProjectIds = self.grantsFor ? self.grantsFor({ deviceId: did, devicePublicKey, grantedScopes }) : [];
        const rec = self.deviceStore.register({
          deviceId: did, devicePublicKey, grantedScopes,
          serviceFingerprint: self.serviceFingerprint, expiresAt: exp,
          deviceName: approval.deviceName, grantedProjectIds,
        });
        if (!rec) return null;
        s.consumed = true; self.sessions.delete(pairingSessionId);
        self.pendingApprovals.delete(approvalId);
        return rec;                                     // { replayEpoch, deviceId }
      },
      grantedScopes: grantedScopesFor(request.body ?? {}),
      deviceId,
      serverNonce,
      expiresAt,
      // The vendored validator signs with a KeyObject (or raw-seed b64url) —
      // never pkcs8 DER; see signEd25519/ed25519PrivateKey in protocol.mjs.
      desktopPrivateKey: this.serviceKey.privateKey,
      nowMs,
    });
    return result;
  }

  /** Wire-facing exchange result: maps the validator outcome to a response. */
  exchangeToWire(request, ctx) {
    const r = this.exchange(request, ctx);
    if (!r.ok) return { ok: false, code: r.code, wire: wireErrorCode(r.code, 'pair') };
    return { ok: true, response: r.response, requestId: r.requestId };
  }
}
