/**
 * Remote v1 SSE — per-device signed event stream.
 *
 * One stream per device (maxConcurrentStreamsPerDevice=2, total=8). Every
 * frame is signed with the SERVICE Ed25519 key over a per-device rolling
 * hash; a client verifies it end-to-end. Device-level: a cursor + a
 * conversation subscription whitelist; frames carry their own
 * conversationId + ownerRevision + event name + a payload digest.
 *
 * The stream is fed by the desktop domain (conversations, approvals) through
 * publish(); it never reaches across into the local SSE client set.
 */
import crypto from 'node:crypto';
import {
  REMOTE_V1, CURSOR_PATTERN, requiredEventScope,
  buildEventFrameMessage, sha256, b64url, isRecord,
} from './contract.mjs';

const L = REMOTE_V1.limits;
const KEEPALIVE_MS = 15000;
const FRAME_MAX = L.maxEventFrameBytes;

export class EventStream {
  constructor({ serviceKey, serviceFingerprint, deviceStore }) {
    this.serviceKey = serviceKey;
    this.serviceFingerprint = serviceFingerprint;
    this.serviceId = `svc-${serviceFingerprint.slice(0, 16)}`;
    this.deviceStore = deviceStore;
    this.subscribers = new Map();   // deviceId -> [subscriber]
    this.streams = new Set();
  }
  close() { for (const s of this.streams) { clearInterval(s.keepalive); try { s.res.end(); } catch {} } this.streams.clear(); this.subscribers.clear(); }
  _deviceStreams(deviceId) { return this.subscribers.get(deviceId) ?? (this.subscribers.set(deviceId, []), this.subscribers.get(deviceId)); }

  // GET /remote/v1/events?cursor=...
  handleSubscribe(req, res, device, url, adapters) {
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null && !CURSOR_PATTERN.test(cursor)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ protocolVersion: 1, requestId: '00000000-0000-0000-0000-000000000000', error: { code: 'invalid_request', retryable: false } }));
    }
    if (this._deviceStreams(device.deviceId).length >= L.maxConcurrentStreamsPerDevice ||
        this.streams.size >= L.maxConcurrentStreamsTotal) {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ protocolVersion: 1, requestId: '00000000-0000-0000-0000-000000000000', error: { code: 'server_busy', retryable: true } }));
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    const subscriber = {
      device,
      res,
      cursor: cursor ?? `c-${Date.now().toString(36)}`,
      generation: 0,                     // bumped on reset
      sequence: 0,
      conversations: new Set(),          // subscription whitelist
      previousHash: sha256(`${device.deviceId}|${this.serviceId}|init`),
      keepalive: null,
      closed: false,
    };
    // reset marker occupies the first sequence of the new generation
    subscriber.generation += 1;
    subscriber.sequence = 1;
    this._writeFrame(subscriber, {
      conversationId: 'stream-reset', ownerRevision: 0, event: 'reset',
      data: { reason: cursor ? 'cursor_expired' : 'subscribed' },
    });
    this._deviceStreams(device.deviceId).push(subscriber);
    this.streams.add(subscriber);
    subscriber.keepalive = setInterval(() => {
      if (subscriber.closed) return;
      try { res.write(`:keepalive ${Date.now()}\n\n`); } catch { this._close(subscriber); }
    }, KEEPALIVE_MS);
    req.on('close', () => this._close(subscriber));
  }
  _close(s) {
    if (s.closed) return; s.closed = true;
    clearInterval(s.keepalive);
    this.streams.delete(s);
    const arr = this._deviceStreams(s.device.deviceId);
    const i = arr.indexOf(s); if (i >= 0) arr.splice(i, 1);
  }
  subscribeConversation(s, conversationId) { s.conversations.add(conversationId); }
  // Publish a domain event to every subscribed device (scope + whitelist gated).
  publish(conversationId, ownerRevision, event, data) {
    if (!requiredEventScope(event)) return;
    for (const s of this.streams) {
      if (s.closed) continue;
      if (!s.device.grantedScopes.includes(requiredEventScope(event))) continue;
      if (event !== 'reset' && !s.conversations.has(conversationId)) continue;
      this._writeFrame(s, { conversationId, ownerRevision, event, data });
    }
  }
  // Signed frame: per-device rolling hash; payload is a separate digest.
  _writeFrame(s, { conversationId, ownerRevision, event, data }) {
    const cursor = `${s.cursor}|${s.sequence}`;
    const payloadDigest = sha256(JSON.stringify(data ?? null));
    const msg = buildEventFrameMessage({
      protocolVersion: 1, deviceId: s.device.deviceId, serviceId: this.serviceId,
      streamGeneration: s.generation, sequence: s.sequence,
      conversationId, ownerRevision, cursor, event,
    }, payloadDigest);
    let signature = null;
    if (this.serviceKey.privateKeyDer) {
      try {
        const priv = crypto.createPrivateKey({ key: this.serviceKey.privateKeyDer, format: 'der', type: 'pkcs8' });
        signature = crypto.sign(null, Buffer.from(msg, 'utf8'), priv).toString('base64url');
      } catch { /* frame is dropped below */ }
    }
    const frame = [
      `event: ${event}`,
      `data: ${JSON.stringify({
        protocolVersion: 1, conversationId, ownerRevision, event, data,
        cursor, streamGeneration: s.generation, sequence: s.sequence,
        previousHash: s.previousHash, signature,
      })}`,
      '\n',
    ].join('\n');
    if (frame.length > FRAME_MAX) return;           // drop oversized, contract requires it never be written
    s.previousHash = sha256(`${s.previousHash}|${msg}|${signature ?? ''}`);
    s.sequence += 1;
    try { s.res.write(frame + '\n'); } catch { this._close(s); }
  }
}
