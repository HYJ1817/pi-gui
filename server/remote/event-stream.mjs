/**
 * Remote v1 SSE — per-device signed event stream.
 *
 * Contract rules implemented here:
 *  - every frame: protocolVersion/sequence/conversationId/ownerRevision/event/
 *    payload/streamGeneration/cursor/frameSignature, Ed25519-signed by the
 *    desktop service key over the contract frameMessage
 *  - each subscription owns an ISOLATED (streamGeneration, sequence, cursor)
 *    space (contract eventStream.concurrency): streamGeneration is minted
 *    per-subscription from a device-wide monotone genCtr; a stale resubscribe
 *    mints a NEW generation for that subscription only — it never perturbs
 *    other subscribers' spaces. Backlog (frames + sequence) is shared per
 *    device. A device/grant/owner revocation resets every subscription; a
 *    stale/gap cursor resets only its own.
 *  - frames are materialized per subscriber: the backlog stores an unsigned
 *    template (fields + sequence + emission-epoch), and each delivered frame
 *    is signed with the SUBSCRIBER's streamGeneration + its own cursor so the
 *    cursor it carries is always usable to resume that subscription.
 *  - cursor is an opaque token g<generation>_s<sequence>_<22-char HMAC tag>
 *    bound to (deviceId, generation, sequence); a foreign-device or tampered
 *    tag is treated exactly like a stale cursor (new generation + reset) —
 *    never a cross-device leak (contract cursorTransitionTable.foreign).
 *  - subscribe transitions (cursorTransitionTable):
 *      absent    -> join at the current head, no reset
 *      valid     -> cursor bound to THIS device with generation >= the device
 *                   epoch AND sequence inside the retained window: continue
 *                   the SAME generation, replay backlog newer than cursor
 *      stale/gap/foreign/expired -> NEW generation + exactly ONE reset
 *      malformed -> rejected before a stream ever opens (upstream check)
 *  - before delivering ANY frame (live or replayed): device active, per-event
 *    scope and current grant+owner are revalidated; failure resets that
 *    subscription (authorization_changed), never leaking
 *  - reset frames use conversationId 'stream-reset' and occupy their own
 *    sequence in the new generation; the next frame is reset.sequence + 1
 *  - backlog budgets per device (events/bytes/age); overflow advances the
 *    generation so a resumed client hits the reset path instead of a gap
 *  - runtime.snapshot watermark: stream.watermark(deviceId) returns the
 *    current device epoch + head sequence + a resumable cursor
 */
import crypto from 'node:crypto';
import { REMOTE_V1, requiredEventScope, buildEventFrameMessage, validateEventEnvelope } from './protocol.mjs';
import { isRecord } from './keys.mjs';

const L = REMOTE_V1.limits;
const KEEPALIVE_MS = 15000;
const FRAME_MAX = L.maxEventFrameBytes;
const CURSOR_RE = /^g([0-9]+)_s([0-9]+)_([A-Za-z0-9_-]{22})$/;

// Opaque cursor bound to the device: g<generation>_s<sequence>_<hmac-tag>
// The tag is the first 16 bytes (22 base64url chars) of the HMAC — enough to
// bind, short enough to satisfy the contract cursor regex.
function cursorTag(deviceId, generation, sequence) {
  return crypto.createHmac('sha256', `remote-cursor:${deviceId}`)
    .update(`${generation}.${sequence}`).digest('base64url').slice(0, 22);
}
function makeCursor(deviceId, generation, sequence) {
  return `g${generation}_s${sequence}_${cursorTag(deviceId, generation, sequence)}`;
}
function parseCursor(deviceId, cursor) {
  const m = CURSOR_RE.exec(cursor ?? '');
  if (!m) return null;
  const [generation, sequence] = [Number(m[1]), Number(m[2])];
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(sequence)) return null;
  const expected = Buffer.from(cursorTag(deviceId, generation, sequence), 'utf8');
  const got = Buffer.from(m[3], 'utf8');
  // Constant-time tag compare; a mismatched tag means foreign/tampered.
  return expected.length === got.length && crypto.timingSafeEqual(expected, got)
    ? { generation, sequence } : null;
}

export class EventStream {
  /**
   * @param serviceKey   { privateKey (KeyObject) }
   * @param serviceFingerprint  pinned TLS cert fingerprint (hex)
   * @param deviceStore  DeviceStore — device-active and scope rechecks
   * @param authorizeResource ({deviceId,serviceId,conversationId,ownerRevision,event}) => bool
   */
  constructor({ serviceKey, serviceFingerprint, deviceStore, authorizeResource = () => true }) {
    this.serviceKey = serviceKey;
    this.serviceFingerprint = serviceFingerprint;
    this.serviceId = `svc-${serviceFingerprint.slice(0, 16)}`;
    this.deviceStore = deviceStore;
    this.authorizeResource = authorizeResource;
    this.streams = new Set();                    // subscribers
    this.subscribers = new Map();               // deviceId -> Set<subscriber>
    this.timelines = new Map();                 // deviceId -> timeline
  }
  close() {
    for (const s of [...this.streams]) this._close(s);
    this.subscribers.clear(); this.timelines.clear();
  }
  _subs(deviceId) {
    let set = this.subscribers.get(deviceId);
    if (!set) { set = new Set(); this.subscribers.set(deviceId, set); }
    return set;
  }
  _tl(deviceId) {
    let t = this.timelines.get(deviceId);
    // generation = device epoch (kills every prior cursor when bumped);
    // genCtr  = device-wide monotone mint for per-subscription generations;
    // headSequence = shared backlog cursor position.
    if (!t) { t = { generation: 1, genCtr: 1, headSequence: 0, frames: [], bytes: 0 }; this.timelines.set(deviceId, t); }
    return t;
  }
  _close(s) {
    if (s.closed) return; s.closed = true;
    clearInterval(s.keepalive);
    this.streams.delete(s);
    this.subscribers.get(s.deviceId)?.delete(s);
    try { s.res.end(); } catch {}
  }
  /** Revocation/owner loss closes every live stream of the device. */
  dropDevice(deviceId) {
    for (const s of [...(this.subscribers.get(deviceId) ?? [])]) this._close(s);
    this.timelines.delete(deviceId);
  }
  /**
   * Emit a stream-wide reset to every subscriber of the device. Bumps the
   * device epoch (killing every prior cursor) and mints each subscriber a NEW
   * per-subscription generation. Re-entrancy-guarded so a reset frame that
   * itself fails its pre-delivery recheck closes that subscriber instead of
   * recursing.
   */
  resetDevice(deviceId, reason) {
    const t = this._tl(deviceId);
    t.generation = ++t.genCtr;
    for (const s of [...(this._subs(deviceId) ?? [])]) {
      if (s.resetting) { this._close(s); continue; }
      s.resetting = true;
      try {
        s.generation = ++t.genCtr;
        this._emit(s, { conversationId: 'stream-reset', ownerRevision: 0, event: 'reset', payload: { reason } });
      } finally { s.resetting = false; }
    }
  }
  /**
   * Reset one subscription only (per-subscription isolated generation): used
   * for a stale/gap/foreign cursor resubscribe and a failed pre-delivery
   * recheck — never touches the device epoch or other subscribers.
   */
  _resetOne(subscriber, reason) {
    if (subscriber.resetting) { this._close(subscriber); return false; }
    const t = this._tl(subscriber.deviceId);
    subscriber.resetting = true;
    try {
      subscriber.generation = ++t.genCtr;
      this._emit(subscriber, { conversationId: 'stream-reset', ownerRevision: 0, event: 'reset', payload: { reason } });
    } finally { subscriber.resetting = false; }
    return !subscriber.closed;
  }

  /**
   * GET /remote/v1/events?cursor=...
   * Signature + sessions.read scope already verified by the gateway.
   * Returns {status,body} for a rejected subscribe, else attaches SSE.
   */
  handleSubscribe(req, res, device, query) {
    if (this._subs(device.deviceId).size >= L.maxConcurrentStreamsPerDevice
      || this.streams.size >= L.maxConcurrentStreamsTotal) {
      return { status: 429, body: { code: 'server_busy', retryable: true } };
    }
    const t = this._tl(device.deviceId);
    const cursor = query.cursor;
    const bound = cursor ? parseCursor(device.deviceId, cursor) : null;

    const subscriber = { deviceId: device.deviceId, res, keepalive: null, closed: false, generation: 0 };
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    this._subs(device.deviceId).add(subscriber);
    this.streams.add(subscriber);

    if (!cursor) {
      // Fresh subscribe at the live head — isolated generation, no reset.
      subscriber.generation = ++t.genCtr;
    } else {
      const floor = t.frames.length ? t.frames[0].sequence : 0;
      // 'valid': bound to THIS device, generation still live (>= device epoch,
      // which only advances on device-wide resets), sequence inside the window.
      const validResume = bound && bound.generation >= t.generation
        && bound.sequence <= t.headSequence && bound.sequence >= floor;
      if (validResume) {
        subscriber.generation = bound.generation;    // continue the SAME space
        for (const f of t.frames) {
          if (f.sequence <= bound.sequence) continue;
          if (!this._deliverTemplate(subscriber, f)) break;
        }
      } else {
        // stale/gap/foreign/expired — NEW generation for this subscription,
        // exactly one reset; the device epoch is left untouched.
        this._resetOne(subscriber, 'cursor_expired');
      }
    }
    subscriber.keepalive = setInterval(() => {
      if (subscriber.closed) return;
      try { res.write(`:keepalive ${Date.now()}\n\n`); } catch { this._close(subscriber); }
    }, KEEPALIVE_MS);
    req.on('close', () => this._close(subscriber));
    return null;
  }

  /**
   * runtime.snapshot watermark: the shared backlog head at the current device
   * epoch. The returned cursor is HMAC-bound and resumable (it passes the
   * 'valid' subscribe transition), satisfying contract snapshotWindow.
   */
  watermark(deviceId) {
    const t = this._tl(deviceId);
    const generation = Math.max(1, t.generation);
    // The cursor binds the ACTUAL backlog head (0 on an empty stream) so a
    // client resuming from the snapshot watermark passes 'valid' and misses
    // nothing. The result `sequence` is the NEXT expected frame number
    // (schema minimum 1): on an empty backlog that is 1, matching the first
    // frame the resumed subscription will receive.
    const sequence = t.headSequence + 1;
    return { cursor: makeCursor(deviceId, generation, t.headSequence), generation, sequence };
  }

  /**
   * Build the per-subscriber signed envelope for a backlog template.
   * `tpl` = { sequence, fields:{conversationId,ownerRevision,event,payload},
   *           at } — shared per device; signing happens per subscriber so the
   *           emitted streamGeneration + cursor belong to that subscription's
   *           isolated space.
   */
  _materialize(subscriber, tpl) {
    const env = {
      protocolVersion: 1,
      sequence: tpl.sequence,
      conversationId: tpl.fields.conversationId,
      ownerRevision: tpl.fields.ownerRevision,
      event: tpl.fields.event,
      payload: tpl.fields.payload,
      streamGeneration: subscriber.generation,
      cursor: makeCursor(subscriber.deviceId, subscriber.generation, tpl.sequence),
      frameSignature: '',
    };
    const msg = buildEventFrameMessage(env, subscriber.deviceId, this.serviceId);
    if (!msg) return null;
    try { env.frameSignature = crypto.sign(null, Buffer.from(msg, 'utf8'), this.serviceKey.privateKey).toString('base64url'); }
    catch { return null; }
    if (!validateEventEnvelope(env)) return null;
    const raw = `event: ${env.event}\ndata: ${JSON.stringify(env)}\n\n`;
    if (Buffer.byteLength(raw, 'utf8') > FRAME_MAX) return null;
    return { env, raw };
  }
  /** Validate a frame template once at publish time (contract frameBudget). */
  _template(deviceId, fields) {
    const t = this._tl(deviceId);
    // The emission-epoch env is only a schema/size probe; per-subscriber
    // streamGeneration/cursor/signature are materialized at delivery.
    const sequence = t.headSequence + 1;
    const probe = {
      protocolVersion: 1,
      sequence,
      conversationId: fields.conversationId,
      ownerRevision: fields.ownerRevision,
      event: fields.event,
      payload: fields.payload,
      streamGeneration: Math.max(1, t.generation),
      cursor: makeCursor(deviceId, Math.max(1, t.generation), sequence),
      frameSignature: '',
    };
    const msg = buildEventFrameMessage(probe, deviceId, this.serviceId);
    if (!msg) return null;
    try { probe.frameSignature = crypto.sign(null, Buffer.from(msg, 'utf8'), this.serviceKey.privateKey).toString('base64url'); }
    catch { return null; }
    if (!validateEventEnvelope(probe)) return null;
    const raw = `event: ${probe.event}\ndata: ${JSON.stringify(probe)}\n\n`;
    if (Buffer.byteLength(raw, 'utf8') > FRAME_MAX) return null;
    // Estimate backlog bytes as the materialized wire size (unsigned template
    // under-counts by a fixed signature+cursor margin — the budget is a bound).
    const size = Buffer.byteLength(raw, 'utf8');
    return { sequence, fields, size, at: Date.now() };
  }
  /** Persist a frame template on the device backlog (bounded). */
  _queue(deviceId, tpl) {
    const t = this._tl(deviceId);
    t.headSequence = tpl.sequence;
    t.frames.push(tpl);
    t.bytes += tpl.size;
    while (t.frames.length > L.maxEventBacklogEventsPerDevice
      || t.bytes > L.maxEventBacklogBytesPerDevice
      || (t.frames.length && Date.now() - t.frames[0].at > L.maxEventBacklogAgeSeconds * 1000)) {
      t.bytes -= t.frames[0].size;
      t.frames.shift();
    }
  }
  /** Authorization recheck immediately before delivering one frame. */
  _mayDeliver(subscriber, env) {
    const device = this.deviceStore.active(subscriber.deviceId);
    if (!device) return false;
    const scope = requiredEventScope(env.event);
    if (!scope || !device.grantedScopes.includes(scope)) return false;
    if (env.event !== 'reset'
      && this.authorizeResource({
        deviceId: subscriber.deviceId,
        serviceId: this.serviceId,
        conversationId: env.conversationId,
        ownerRevision: env.ownerRevision,
        event: env.event,
      }) !== true) return false;
    return true;
  }
  _deliver(subscriber, env, raw) {
    if (subscriber.closed) return false;
    if (!this._mayDeliver(subscriber, env)) {
      // A failed pre-delivery recheck resets THIS subscription only
      // (per-subscription isolated space) — not the device epoch.
      this._resetOne(subscriber, 'authorization_changed');
      return false;
    }
    try { subscriber.res.write(raw); return true; }
    catch { this._close(subscriber); return false; }
  }
  _deliverTemplate(subscriber, tpl) {
    const frame = this._materialize(subscriber, tpl);
    if (!frame) { this._close(subscriber); return false; }
    return this._deliver(subscriber, frame.env, frame.raw);
  }
  /** Emit one reset frame (already isolated to this subscriber). */
  _emit(subscriber, fields) {
    const tpl = this._template(subscriber.deviceId, fields);
    if (!tpl) { this._close(subscriber); return false; }
    this._queue(subscriber.deviceId, tpl);
    return this._deliverTemplate(subscriber, tpl);
  }

  /**
   * publish(conversationId, ownerRevision, event, payload)
   * Fed by the domain adapters; fans out to every device that ever subscribed
   * (the backlog template is shared per device; each subscriber's frame is
   * signed with its own generation at delivery). A frame that fails
   * frameBudget validation is never queued; subscribers are notified via a
   * per-subscription reset (sequence_gap) per contract frameBudget.
   */
  publish(conversationId, ownerRevision, event, payload, deviceIds = null) {
    if (!requiredEventScope(event)) return;
    const targets = deviceIds ?? [...this.timelines.keys()];
    for (const deviceId of targets) {
      const tpl = this._template(deviceId, { conversationId, ownerRevision, event, payload });
      if (!tpl) {
        // Oversized/invalid: never signed, queued or delivered — emit reset.
        for (const s of this._subs(deviceId) ?? []) this._resetOne(s, 'sequence_gap');
        continue;
      }
      this._queue(deviceId, tpl);
      for (const s of this._subs(deviceId) ?? []) this._deliverTemplate(s, tpl);
    }
  }
}
