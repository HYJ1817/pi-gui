/** Remote-v1 signed, bounded device streams. ADR 0010/M5 invariants:
 * - static scope/owner filtering never consumes sequence space;
 * - every authorization transition invalidates cursors, including re-pair;
 * - reset is ephemeral per subscription, never a shared-journal entry;
 * - a resumable snapshot cursor denotes the last observed head, while its
 *   sequence result is the NEXT expected frame (minimum 1);
 * - cursor tags use a secret process key and random timeline incarnation.
 */
import crypto from 'node:crypto';
import { REMOTE_V1, requiredEventScope, buildEventFrameMessage, validateEventEnvelope } from './protocol.mjs';

const L = REMOTE_V1.limits;
const FRAME_MAX = L.maxEventFrameBytes;
const CURSOR_RE = /^g([0-9]+)_s([0-9]+)_([A-Za-z0-9_-]{22})$/;
const MAX_TIMEOUT = 2147483647;

export class EventStream {
  constructor({ serviceKey, serviceFingerprint, deviceStore, authorizeResource, authorizationState = null }) {
    if (typeof authorizeResource !== 'function') throw new Error('remote_authorizer_required');
    this.serviceKey = serviceKey;
    this.serviceId = `svc-${serviceFingerprint.slice(0, 16)}`;
    this.deviceStore = deviceStore;
    this.authorizeResource = authorizeResource;
    this.authorizationState = authorizationState;
    this.cursorKey = crypto.randomBytes(32);
    this.streams = new Set();
    this.subscribers = new Map();
    this.timelines = new Map();
  }
  close() {
    for (const s of [...this.streams]) this._close(s);
    this.subscribers.clear(); this.timelines.clear(); this.cursorKey.fill(0);
  }
  _subs(id) {
    if (!this.subscribers.has(id)) this.subscribers.set(id, new Set());
    return this.subscribers.get(id);
  }
  _authority(id) {
    const d = this.deviceStore.active(id);
    if (!d) return null;
    try {
      const extra = this.authorizationState ? this.authorizationState(id) : '';
      if (extra === null) return null;
      return JSON.stringify([d.replayEpoch, d.serviceId, [...d.grantedScopes].sort(), Object.keys(d.grants ?? {}).filter(k => d.grants[k] === true).sort(), extra]);
    } catch { return null; }
  }
  _tl(id) {
    let t = this.timelines.get(id);
    if (!t) {
      // Generation monotonicity is a contract property of the AUTHENTICATED
      // DEVICE, not the process (round-6 R6-CORRECTNESS-3 / S17): the pinned
      // client rejects frames at-or-below a generation it already accepted,
      // so a routine restart that re-issued low generations permanently broke
      // forward recovery. The durable floor lives in the device record.
      const floor = typeof this.deviceStore.streamGenerationFloor === 'function' ? this.deviceStore.streamGenerationFloor(id) : 0;
      // Round-8 R8-GEN-04: the initial generation is published the moment the
      // timeline enters the map — persist its floor FIRST or a failed write
      // leaves a cached timeline whose watermark claims durability the disk
      // does not have (generation=1 responses while floor=0). On failure no
      // timeline is cached and the next attempt retries honestly.
      const initial = Math.max(1, floor + 1);
      this._persistFloor(id, initial);
      t = { generation: initial, genCtr: initial, headSequence: 1, frames: [], bytes: 0, salt: crypto.randomBytes(16), authority: this._authority(id) };
      this.timelines.set(id, t);
    }
    return t;
  }
  _persistFloor(id, gen) {
    // Round-7 R7-GEN-04: floor persistence is part of the generation's
    // durability, not an optional optimization. A generation whose floor
    // cannot be persisted must never be issued — otherwise a restart
    // re-issues numbers the pinned client already consumed. Fail closed:
    // the error propagates to the caller, which refuses the generation.
    this.deviceStore.persistStreamGenerationFloor?.(id, gen);
  }
  _allocGeneration(id) {
    const t = this._tl(id);
    const next = t.genCtr + 1;
    this._persistFloor(id, next);   // throws before mutation when durability fails
    t.genCtr = next;
    return next;
  }
  _tag(id, generation, sequence) {
    const t = this._tl(id);
    return crypto.createHmac('sha256', this.cursorKey).update(t.salt).update(`\0${id}\0${generation}\0${sequence}`).digest('base64url').slice(0, 22);
  }
  _cursor(id, generation, sequence) { return `g${generation}_s${sequence}_${this._tag(id, generation, sequence)}`; }
  _parse(id, cursor) {
    const m = CURSOR_RE.exec(cursor ?? '');
    if (!m) return null;
    const generation = Number(m[1]), sequence = Number(m[2]);
    if (!Number.isSafeInteger(generation) || generation < 1 || !Number.isSafeInteger(sequence) || sequence < 1) return null;
    const expected = Buffer.from(this._tag(id, generation, sequence));
    const got = Buffer.from(m[3]);
    return expected.length === got.length && crypto.timingSafeEqual(expected, got) ? { generation, sequence } : null;
  }
  _close(s) {
    if (s.closed) return;
    s.closed = true; clearInterval(s.keepalive); clearTimeout(s.expiry);
    this.streams.delete(s); this.subscribers.get(s.deviceId)?.delete(s);
    // A revoked/expired stream ends cleanly: destroy() would surface as a
    // transport error instead of the close the client uses to resubscribe.
    try { s.res.end(); } catch {}
  }
  _expire(s) {
    clearTimeout(s.expiry);
    const d = this.deviceStore.active(s.deviceId);
    if (!d) { this._close(s); return; }
    const delay = Date.parse(d.expiresAt) - Date.now();
    s.expiry = setTimeout(() => this._expire(s), Math.max(1, Math.min(MAX_TIMEOUT, delay)));
    s.expiry.unref?.();
  }
  dropDevice(id) {
    // Contract deviceLifecycle.revocation / cursorDelivery.resetScope: every
    // subscription receives exactly one reset (authorization_changed) before
    // the stream closes. The reset never touches the shared sequence journal.
    // Round-8 R8-GEN-01: the close guarantee must NOT depend on the reset's
    // generation allocation succeeding — a floor-persistence failure inside
    // _resetOne used to throw before _close ran, leaving live streams that
    // kept delivering frames under dead authority. Close every subscriber
    // even when its reset cannot be signed.
    for (const s of [...(this.subscribers.get(id) ?? [])]) {
      try { this._resetOne(s, 'authorization_changed', { bypass: true }); } catch { /* reset undeliverable — close anyway */ }
      this._close(s);
    }
    this.subscribers.delete(id); this.timelines.delete(id);
  }
  /** Called synchronously by authoritative device-record transactions. */
  authorizationChanged(id, reason) {
    if (reason === 'grants_changed' && this.deviceStore.active(id)) this.resetDevice(id, 'authorization_changed');
    else this.dropDevice(id); // revoke, re-pair, or replay-epoch loss: old credentials die.
  }
  resetDevice(id, reason) {
    const t = this._tl(id);
    try {
      t.generation = this._allocGeneration(id);
    } catch (e) {
      // Round-7 R7-GEN-04: when the new generation cannot be made durable the
      // device must lose its streams entirely — continuing at the old
      // generation would deliver frames under authority (grants/scopes) that
      // has already changed. Fail closed, then surface the error.
      this.dropDevice(id);
      throw e;
    }
    t.authority = this._authority(id);
    for (const s of [...(this.subscribers.get(id) ?? [])]) {
      try {
        // Round-10 R10-GEN-01: a FALSE return is a reset failure just as much
        // as a throw — materialization or write failure after the generation
        // was advanced must close the stream. Leaving it open delivered the
        // next ordinary frame in a stale generation with no reset at all.
        if (!this._resetOne(s, reason)) this._close(s);
      } catch {
        // Round-9 R9-GEN-01: a subscriber whose reset cannot be signed (the
        // per-subscriber generation allocation failed) must CLOSE, never keep
        // delivering ordinary frames in its pre-reset generation — that would
        // silently continue the stream under authority that has already
        // changed. One failing subscriber must not abort the reset of the rest.
        this._close(s);
      }
    }
  }
  _reconcile(id) {
    if (!this.deviceStore.active(id)) { this.dropDevice(id); return false; }
    const current = this._authority(id), t = this._tl(id);
    if (current === null) { this.dropDevice(id); return false; }
    if (t.authority !== current) this.resetDevice(id, 'owner_changed');
    return true;
  }
  _resetOne(s, reason, { bypass = false } = {}) {
    if (s.closed || s.resetting) { this._close(s); return false; }
    s.resetting = true;
    try {
      const t = this._tl(s.deviceId);
      s.generation = this._allocGeneration(s.deviceId);
      // A reset establishes the current head. The next ordinary frame is
      // head+1 for EVERY subscriber; no invisible shared sequence is consumed.
      const frame = this._materialize(s, { sequence: t.headSequence, fields: { conversationId: 'stream-reset', ownerRevision: 0, event: 'reset', payload: { reason } } });
      if (!frame) return false;
      // The revocation/grant-loss notification is the one frame that must be
      // delivered precisely BECAUSE authorization died — _mayDeliver would
      // always refuse it for an inactive device.
      if (!bypass ? !this._write(s, frame.env, frame.raw) : !this._writeRaw(s, frame.env, frame.raw)) return false;
      return true;
    } finally { s.resetting = false; }
  }
  _writeRaw(s, env, raw) {
    if (s.closed) return false;
    return this._writeBytes(s, env, raw);
  }
  _writeBytes(s, env, raw) {
    try {
      if ((s.res.writableLength ?? 0) + Buffer.byteLength(raw) > L.maxEventBacklogBytesPerDevice || s.res.write(raw) === false) return false;
      return true;
    } catch { return false; }
  }
  handleSubscribe(req, res, device, query) {
    // Round-10 R10-SUBSCRIBE-01: _reconcile can THROW when the initial
    // timeline floor cannot persist. At this point the request is already
    // authenticated — letting the exception escape produced a 500 framed
    // with the zero requestId, which the contract reserves for pre-auth
    // unauthorized errors only. Nothing has reached the wire or registry
    // yet, so an honest correlated 503 is the correct answer.
    try {
      if (!this._reconcile(device.deviceId)) return { status: 401, body: { code: 'unauthorized', retryable: false } };
    } catch {
      return { status: 503, body: { code: 'unavailable', retryable: true } };
    }
    if (this._subs(device.deviceId).size >= L.maxConcurrentStreamsPerDevice || this.streams.size >= L.maxConcurrentStreamsTotal) return { status: 429, body: { code: 'server_busy', retryable: true } };
    // cursorTransitionTable.malformed is enforced upstream at admission
    // (cursorPattern/length -> cursor_invalid -> unauthorized). Everything that
    // survives that gate but fails the strict g<n>_s<n>_<tag> shape or HMAC is
    // well-formed-but-foreign/stale per the table: exactly one reset below —
    // never a cross-device leak, never an open stream without notification.
    const t = this._tl(device.deviceId), cursor = query.cursor, bound = cursor ? this._parse(device.deviceId, cursor) : null;
    const s = { deviceId: device.deviceId, res, keepalive: null, expiry: null, closed: false, generation: 0, resetting: false };
    // Round-9 R9-GEN-02: the initial generation is allocated BEFORE anything
    // reaches the wire or the subscriber registry. A floor-write failure here
    // used to leak a generation-0 subscriber behind an already-sent 200 with
    // no cleanup path — the client hung on a half-open response forever. Now
    // the listener can answer with an honest error because no bytes exist yet.
    if (!cursor) {
      try {
        s.generation = this._allocGeneration(device.deviceId);
      } catch {
        return { status: 503, body: { code: 'unavailable', retryable: true } };
      }
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
    this._subs(device.deviceId).add(s); this.streams.add(s);
    // Slot release must track the RESPONSE/socket lifecycle, not only the
    // request: a disconnected client can leave the request 'close' without the
    // response tearing down promptly, retaining the slot and blocking
    // reconnects (round-5 finding 2). All paths funnel into idempotent _close.
    req.on('close', () => this._close(s));
    res.on('close', () => this._close(s));
    res.socket?.on('close', () => this._close(s));
    res.on('error', () => this._close(s));
    if (cursor) {
      this._prune(t);
      const firstNeeded = bound ? bound.sequence + 1 : -1;
      const retained = bound && (bound.sequence === t.headSequence || (t.frames.length > 0 && t.frames[0].sequence <= firstNeeded));
      const valid = bound && bound.generation >= t.generation && bound.generation <= t.genCtr && bound.sequence <= t.headSequence && retained;
      if (valid) {
        s.generation = bound.generation;
        for (const f of [...t.frames]) if (f.sequence > bound.sequence && !this._deliverTemplate(s, f)) break;
      } else {
        // FS-003: the cursor_expired reset is MANDATORY — a false return
        // (materialization/write failure, not just allocation throws) is the
        // same failure: the stream must close rather than deliver the next
        // ordinary frame in a generation the client never re-baselined.
        let resetOk = false;
        try {
          resetOk = this._resetOne(s, 'cursor_expired') === true;
        } catch {
          resetOk = false;
        }
        if (!resetOk) {
          // The reset failed after headers were already sent — an error
          // response is impossible. Close the subscriber and terminate the
          // connection so the client reconnects honestly.
          this._close(s);
          try { res.socket?.destroy?.(); } catch {}
          try { res.destroy?.(); } catch {}
          return null;
        }
      }
    }
    if (!s.closed) {
      s.keepalive = setInterval(() => {
        if (!this._reconcile(s.deviceId) || s.closed) return;
        try {
          if (res.writableLength > L.maxEventBacklogBytesPerDevice || res.write(':keepalive\n\n') === false) this._close(s);
        } catch { this._close(s); }
      }, 15000);
      s.keepalive.unref?.(); this._expire(s);
    }
    return null;
  }
  watermark(id) {
    this._reconcile(id);
    const t = this._tl(id);
    return { cursor: this._cursor(id, t.generation, t.headSequence), generation: t.generation, sequence: t.headSequence + 1 };
  }
  _materialize(s, tpl) {
    const env = { protocolVersion: 1, sequence: tpl.sequence, conversationId: tpl.fields.conversationId, ownerRevision: tpl.fields.ownerRevision,
      event: tpl.fields.event, payload: tpl.fields.payload, streamGeneration: s.generation,
      cursor: this._cursor(s.deviceId, s.generation, tpl.sequence), frameSignature: '' };
    // Pre-sign budget gate (round-6 R6-NIT-1 / S35): an oversized event must be
    // NEVER signed, queued or delivered. The base64url Ed25519 signature is a
    // fixed 86 characters, so measuring the frame with a same-length placeholder
    // is byte-exact — the gate runs before any crypto.sign call.
    env.frameSignature = 'A'.repeat(86);
    const probeRaw = `event: ${env.event}
data: ${JSON.stringify(env)}

`;
    if (Buffer.byteLength(probeRaw, 'utf8') > FRAME_MAX) return null;
    env.frameSignature = '';
    const message = buildEventFrameMessage(env, s.deviceId, this.serviceId);
    if (!message) return null;
    try { env.frameSignature = crypto.sign(null, Buffer.from(message, 'utf8'), this.serviceKey.privateKey).toString('base64url'); } catch { return null; }
    if (!validateEventEnvelope(env)) return null;
    const raw = `event: ${env.event}\ndata: ${JSON.stringify(env)}\n\n`;
    return Buffer.byteLength(raw, 'utf8') <= FRAME_MAX ? { env, raw } : null;
  }
  _mayDeliver(id, env) {
    const d = this.deviceStore.active(id), scope = requiredEventScope(env.event);
    if (!d || !scope || !d.grantedScopes.includes(scope)) return false;
    if (env.event === 'reset') return true;
    try { return this.authorizeResource({ deviceId: id, serviceId: this.serviceId, conversationId: env.conversationId, ownerRevision: env.ownerRevision, event: env.event }) === true; }
    catch { return false; }
  }
  _write(s, env, raw) {
    if (s.closed) return false;
    if (!this._mayDeliver(s.deviceId, env)) {
      if (env.event === 'reset') this._close(s); else this._resetOne(s, 'authorization_changed');
      return false;
    }
    if (!this._writeBytes(s, env, raw)) { this._close(s); return false; }
    return true;
  }
  _deliverTemplate(s, tpl) {
    const frame = this._materialize(s, tpl);
    // An immaterializable journal entry (oversized or unsignable) can never
    // be delivered, and every later frame is blocked behind it: a bare close
    // would leave the client resubscribing into the same dead journal forever
    // without ever learning why. Contract frameBudget: emit exactly one reset
    // (sequence_gap) BEFORE the close so the client re-collects instead.
    if (!frame) { this._resetOne(s, 'sequence_gap'); this._close(s); return false; }
    return this._write(s, frame.env, frame.raw);
  }
  _prune(t) {
    while (t.frames.length > L.maxEventBacklogEventsPerDevice || t.bytes > L.maxEventBacklogBytesPerDevice
      || (t.frames.length && Date.now() - t.frames[0].at > L.maxEventBacklogAgeSeconds * 1000)) t.bytes -= t.frames.shift().size;
  }
  publish(conversationId, ownerRevision, event, payload, deviceIds = null) {
    if (!requiredEventScope(event) || event === 'reset') return;
    // stream-reset is the reserved reset identity: ordinary frames carrying it
    // are structurally invalid contract-wide (round-6 R6-NIT-3 / S07). Refuse
    // at the source so nothing is ever journaled for it.
    if (conversationId === 'stream-reset') return;
    for (const id of deviceIds ?? [...this.timelines.keys()]) {
      if (!this._reconcile(id)) continue;
      const fields = { conversationId, ownerRevision, event, payload };
      // Filtering BEFORE sequence allocation is essential for static scope and
      // project isolation. Transitions invalidate cursors independently.
      if (!this._mayDeliver(id, fields)) continue;
      const t = this._tl(id);
      const tpl = { sequence: t.headSequence + 1, fields, at: Date.now(), size: 0 };
      const probe = this._materialize({ deviceId: id, generation: t.generation }, tpl);
      if (!probe) { this.resetDevice(id, 'sequence_gap'); continue; }
      tpl.size = Buffer.byteLength(probe.raw); t.headSequence = tpl.sequence;
      t.frames.push(tpl); t.bytes += tpl.size; this._prune(t);
      for (const s of [...this._subs(id)]) this._deliverTemplate(s, tpl);
    }
  }
}
