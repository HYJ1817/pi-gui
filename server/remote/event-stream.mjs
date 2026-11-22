/**
 * Remote v1 SSE — per-device signed event stream.
 *
 * Contract rules implemented here:
 *  - every frame: protocolVersion/sequence/conversationId/ownerRevision/event/
 *    payload/streamGeneration/cursor/frameSignature, Ed25519-signed by the
 *    desktop service key over the contract frameMessage
 *  - one device-global (streamGeneration, sequence) timeline; cursor is an
 *    opaque token bound to (deviceId, generation, lastSequence) by an
 *    HMAC tag — foreign/unbindable cursors never cross devices
 *  - subscribe transitions (cursorTransitionTable):
 *      absent    -> join at the current head, no reset
 *      valid     -> continue same generation, replay backlog newer than cursor
 *      stale/gap/foreign/expired -> NEW generation + exactly ONE reset
 *      malformed -> rejected before a stream ever opens (upstream check)
 *  - before delivering ANY frame (live or replayed): device active, per-event
 *    scope and current grant+owner are revalidated; failure drops the frame
 *    and resets the device stream (authorization_changed), never leaking
 *  - reset frames use conversationId 'stream-reset' and occupy their own
 *    sequence in the new generation; the next frame is reset.sequence + 1
 *  - backlog budgets per device (events/bytes/age); overflow advances the
 *    generation so a resumed client hits the reset path instead of a gap
 */
import crypto from 'node:crypto';
import { REMOTE_V1, requiredEventScope, buildEventFrameMessage, validateEventEnvelope } from './protocol.mjs';
import { isRecord } from './keys.mjs';

const L = REMOTE_V1.limits;
const KEEPALIVE_MS = 15000;
const FRAME_MAX = L.maxEventFrameBytes;
const CURSOR_RE = /^g([0-9]+)_s([0-9]+)_([A-Za-z0-9_-]{22})$/;

// Opaque cursor bound to the device: g<generation>_s<sequence>_<hmac-tag>
function makeCursor(deviceId, generation, sequence) {
  const tag = crypto.createHmac('sha256', `remote-cursor:${deviceId}`).update(`${generation}.${sequence}`).digest('base64url');
  return `g${generation}_s${sequence}_${tag}`;
}
function parseCursor(deviceId, cursor) {
  const m = CURSOR_RE.exec(cursor ?? '');
  if (!m) return null;
  const [generation, sequence] = [Number(m[1]), Number(m[2])];
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(sequence)) return null;
  const tag = crypto.createHmac('sha256', `remote-cursor:${deviceId}`).update(`${generation}.${sequence}`).digest('base64url');
  return tag === m[3] ? { generation, sequence } : null;
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
    this.timeline = new Map();                  // deviceId -> {generation, headSequence, frames, bytes}
  }
  close() {
    for (const s of [...this.streams]) this._close(s);
    this.subscribers.clear(); this.timeline.clear();
  }
  _subs(deviceId) {
    let set = this.subscribers.get(deviceId);
    if (!set) { set = new Set(); this.subscribers.set(deviceId, set); }
    return set;
  }
  _tl(deviceId) {
    let t = this.timeline.get(deviceId);
    if (!t) { t = { generation: 1, headSequence: 0, frames: [], bytes: 0 }; this.timeline.set(deviceId, t); }
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
    this.timeline.delete(deviceId);
  }
  /** Emit a stream-wide reset to every subscriber of the device (new generation). */
  resetDevice(deviceId, reason) {
    const t = this._tl(deviceId);
    t.generation += 1;
    for (const s of this._subs(deviceId) ?? []) {
      this._emit(s, { conversationId: 'stream-reset', ownerRevision: 0, event: 'reset', payload: { reason } });
    }
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

    const subscriber = { deviceId: device.deviceId, res, keepalive: null, closed: false };
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    this._subs(device.deviceId).add(subscriber);
    this.streams.add(subscriber);

    if (!cursor) {
      // Fresh subscribe at the live head — no reset, no replay.
    } else {
      const floor = t.frames.length ? t.frames[0].sequence : 0;
      const validResume = bound && bound.generation === t.generation
        && bound.sequence <= t.headSequence && bound.sequence >= floor;
      if (validResume) {
        for (const f of t.frames) {
          if (f.sequence <= bound.sequence) continue;
          if (!this._deliver(subscriber, f.env, f.raw)) break;
        }
      } else {
        // stale/gap/foreign/expired — new generation, exactly one reset.
        t.generation += 1;
        this._emit(subscriber, { conversationId: 'stream-reset', ownerRevision: 0, event: 'reset', payload: { reason: 'cursor_expired' } });
      }
    }
    subscriber.keepalive = setInterval(() => {
      if (subscriber.closed) return;
      try { res.write(`:keepalive ${Date.now()}\n\n`); } catch { this._close(subscriber); }
    }, KEEPALIVE_MS);
    req.on('close', () => this._close(subscriber));
    return null;
  }

  /** Build + sign + validate one contract envelope at the device timeline head. */
  _frame(deviceId, fields) {
    const t = this._tl(deviceId);
    const sequence = t.headSequence + 1;
    const env = {
      protocolVersion: 1,
      sequence,
      conversationId: fields.conversationId,
      ownerRevision: fields.ownerRevision,
      event: fields.event,
      payload: fields.payload,
      streamGeneration: t.generation,
      cursor: makeCursor(deviceId, t.generation, sequence),
      frameSignature: '',
    };
    const msg = buildEventFrameMessage(env, deviceId, this.serviceId);
    if (!msg) return null;
    let signature;
    try { signature = crypto.sign(null, Buffer.from(msg, 'utf8'), this.serviceKey.privateKey).toString('base64url'); }
    catch { return null; }
    env.frameSignature = signature;
    if (!validateEventEnvelope(env)) return null;
    const raw = `event: ${env.event}\ndata: ${JSON.stringify(env)}\n\n`;
    if (Buffer.byteLength(raw, 'utf8') > FRAME_MAX) return null;
    return { env, raw, sequence };
  }
  /** Persist a frame on the device backlog (bounded). */
  _queue(deviceId, frame) {
    const t = this._tl(deviceId);
    t.headSequence = frame.sequence;
    t.frames.push(frame);
    t.bytes += Buffer.byteLength(frame.raw, 'utf8');
    // budgets: oldest dropped; a dropped frame means a resume below the floor
    // gets the explicit reset path (gapBehavior).
    while (t.frames.length > L.maxEventBacklogEventsPerDevice
      || t.bytes > L.maxEventBacklogBytesPerDevice
      || (t.frames.length && Date.now() - t.frames[0].at > L.maxEventBacklogAgeSeconds * 1000)) {
      t.bytes -= Buffer.byteLength(t.frames[0].raw, 'utf8');
      t.frames.shift();
    }
    t.frames[t.frames.length - 1].at = Date.now();
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
      this.resetDevice(subscriber.deviceId, 'authorization_changed');
      return false;
    }
    try { subscriber.res.write(raw); return true; }
    catch { this._close(subscriber); return false; }
  }
  /** Emit one domain event to the device: sign -> backlog -> live delivery. */
  _emit(subscriber, fields) {
    const frame = this._frame(subscriber.deviceId, fields);
    if (!frame) { this._close(subscriber); return false; }
    this._queue(subscriber.deviceId, frame);
    return this._deliver(subscriber, frame.env, frame.raw);
  }

  /**
   * publish(conversationId, ownerRevision, event, payload)
   * Fed by the domain adapters; fans out to every device that ever subscribed
   * (each device gets its own timeline copy — frames are per-device signed).
   */
  publish(conversationId, ownerRevision, event, payload, deviceIds = null) {
    if (!requiredEventScope(event)) return;
    const targets = deviceIds ?? [...this.timeline.keys()];
    for (const deviceId of targets) {
      const frame = this._frame(deviceId, { conversationId, ownerRevision, event, payload });
      if (!frame) continue;                          // oversized/invalid: never emitted
      this._queue(deviceId, frame);
      for (const s of this._subs(deviceId) ?? []) this._deliver(s, frame.env, frame.raw);
    }
  }
}
