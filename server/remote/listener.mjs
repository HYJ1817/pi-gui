/**
 * Remote v1 listener — the second authenticated HTTP surface for mobile.
 *
 * It is a SELF-CONTAINED request handler (own http server, own port, own
 * access control) — the mobile contract's isolation requirement forbids
 * widening the existing 127.0.0.1 router to a remote path. The listener can be
 * bound loopback-only for development or on the LAN for Tailscale/LAN reach.
 *
 * Every request (except /remote/v1/pair/exchange) carries an Ed25519 signature
 * over the signed tuple; this handler verifies signature, replay/epoch, scope
 * grants and resource ownership before dispatching to the domain adapters.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import {
  REMOTE_V1, UUID, ZERO_UUID, OPAQUE_ID, CURSOR_PATTERN,
  canonicalServiceId, sha256, b64url, decodeB64url, timingSafe, isRecord,
  ed25519Verify, buildSignatureMessage, canonicalizeQuery, wireErrorBodyFor,
} from './contract.mjs';
import { EventStream } from './event-stream.mjs';

const L = REMOTE_V1.limits;

function json(res, code, body, extra) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(body));
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => { size += c.length; if (size > maxBytes) { reject(new Error('request_too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export class RemoteGateway {
  constructor({ port = 0, host = '127.0.0.1', serviceKey, serviceFingerprint,
                deviceStore, pairManager, adapters, log = console.log }) {
    this.port = port; this.host = host;
    this.serviceKey = serviceKey;
    this.serviceFingerprint = serviceFingerprint;
    this.serviceId = canonicalServiceId(serviceFingerprint);
    this.deviceStore = deviceStore;
    this.pair = pairManager;
    this.adapters = adapters;         // { projects, sessions, conversations, approvals }
    this.log = log;
    this.stream = new EventStream({ serviceKey, serviceFingerprint, deviceStore });
    this.rate = new Map();            // deviceId -> [timestamps]
    this.server = http.createServer((req, res) => this._handle(req, res));
  }
  listen() {
    return new Promise(resolve => this.server.listen(this.port, this.host, () => resolve(this.server.address())));
  }
  close() { this.server.close(); this.stream.close(); }

  _rateLimit(deviceId, nowMs) {
    let bucket = this.rate.get(deviceId);
    if (!bucket) { bucket = []; this.rate.set(deviceId, bucket); }
    while (bucket.length && bucket[0] < nowMs - 60000) bucket.shift();
    if (bucket.length >= L.maxOperationsPerMinutePerDevice) return false;
    bucket.push(nowMs);
    return true;
  }

  _wire(res, status, requestId, code, retryable = false) {
    return json(res, status, wireErrorBodyFor(code, requestId, retryable));
  }

  // Verify the signed request headers + replay/epoch + device completeness.
  // Returns { device } on success, or { deny: {status,code} }.
  _verifySigned(req, bodyBytes, nowMs) {
    const h = req.headers;
    const deviceId = h['x-pi-device-id'];
    const signature = h['x-pi-signature'];
    const timestamp = Number(h['x-pi-timestamp']);
    const nonce = h['x-pi-nonce'];
    const requestId = h['x-pi-request-id'];
    const protocolVersion = Number(h['x-pi-protocol-version']);
    const epoch = Number(h['x-pi-remote-epoch']);
    const bodySha256Header = h['x-pi-body-sha256'];

    if (protocolVersion !== REMOTE_V1.protocolMajor) return { deny: { status: 401, code: 'unauthorized' } };
    if (typeof deviceId !== 'string' || !OPAQUE_ID.test(deviceId)) return { deny: { status: 401, code: 'unauthorized' } };
    if (!UUID.test(requestId)) return { deny: { status: 400, code: 'invalid_request' } };
    if (!decodeB64url(signature, 64)) return { deny: { status: 401, code: 'unauthorized' } };
    if (!decodeB64url(nonce, 16)) return { deny: { status: 401, code: 'unauthorized' } };
    if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(epoch)) return { deny: { status: 400, code: 'invalid_request' } };
    if (Math.abs(nowMs / 1000 - timestamp) > L.signatureClockSkewSeconds) return { deny: { status: 401, code: 'unauthorized' } };
    const bodySha256 = sha256(bodyBytes);
    if (bodySha256Header !== bodySha256) return { deny: { status: 400, code: 'payload_invalid' } };

    const device = this.deviceStore.active(deviceId, nowMs);
    if (!device) return { deny: { status: 401, code: 'unauthorized' } };
    if (epoch !== device.replayEpoch) return { deny: { status: 409, code: 'replay_rejected' } };

    // signature over the signed tuple
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;
    const query = {};
    for (const [k, v] of u.searchParams) query[k] = v;
    const msg = buildSignatureMessage({
      protocolVersion, deviceId, serviceId: this.serviceId,
      replayEpoch: epoch, requestId, method: req.method, path, query,
      timestamp, nonce, bodySha256,
    });
    if (msg === null || !ed25519Verify(device.devicePublicKey, signature, Buffer.from(msg, 'utf8'))) {
      return { deny: { status: 401, code: 'unauthorized' } };
    }
    // replay protection (per device): nonce reuse or non-monotonic timestamp
    if (this.deviceStore.seenNonce(device, nonce, nowMs)) return { deny: { status: 409, code: 'replay_rejected' } };
    this.deviceStore.bumpTimestampFloor(device, timestamp);
    if (timestamp <= device.timestampFloor && this.deviceStore.seenNonce(device, nonce, nowMs)) {
      return { deny: { status: 409, code: 'replay_rejected' } };
    }
    if (!this._rateLimit(deviceId, nowMs)) return { deny: { status: 429, code: 'rate_limited', retryable: true } };
    return { device, requestId };
  }

  async _handle(req, res) {
    const u = new URL(req.url, 'http://x');
    const nowMs = Date.now();
    const requestId = UUID.test(req.headers['x-pi-request-id']) ? req.headers['x-pi-request-id'] : ZERO_UUID;
    const path = u.pathname;

    // Local operator endpoint: mints a pairing code for the UI to display.
    // Loopback + the desktop's local token only — a remote caller never sees it.
    if (path === '/remote/v1/pair/code' && req.method === 'POST') {
      const host = req.headers.host || '';
      const loopback = host.startsWith('127.0.0.1') || host.startsWith('localhost') || host === '::1' || host.startsWith('[::1]');
      const token = process.env.PI_GUI_TOKEN;
      const okToken = !token || req.headers['x-pi-gui-token'] === token;
      if (!loopback || !okToken) return this._wire(res, 401, requestId, 'unauthorized');
      const out = this.pair.issuePairingCode();
      if (!out) return this._wire(res, 429, requestId, 'rate_limited', true);
      return json(res, 200, { ok: true, code: out.code, challenge: out.challenge, expiresAt: out.expiresAt, serviceFingerprint: this.serviceFingerprint });
    }

    // Pair exchange is the only unsigned remote surface.
    if (path === REMOTE_V1.pairExchange.path && req.method === 'POST') {
      let bodyBytes;
      try { bodyBytes = await readBody(req, L.maxRequestBytes); } catch { return this._wire(res, 413, requestId, 'request_too_large'); }
      let body; try { body = JSON.parse(bodyBytes.toString('utf8')); } catch { return this._wire(res, 400, requestId, 'payload_invalid'); }
      const out = this.pair.exchange(body, nowMs);
      if (out.error) return this._wire(res, out.status, requestId, out.error);
      return json(res, 200, out.response);
    }
    if (path !== '/remote/v1/events' && !(path.startsWith('/remote/v1/'))) {
      return this._wire(res, 404, requestId, 'unknown_resource');
    }

    let bodyBytes = Buffer.alloc(0);
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      try { bodyBytes = await readBody(req, L.maxRequestBytes); } catch { return this._wire(res, 413, requestId, 'request_too_large'); }
    }
    const v = this._verifySigned(req, bodyBytes, nowMs);
    if (v.deny) return this._wire(res, v.deny.status, requestId, v.deny.code, v.deny.retryable);
    const device = v.device;

    // event stream
    if (path === REMOTE_V1.eventStream.path && req.method === 'GET') {
      return this.stream.handleSubscribe(req, res, device, u, this.adapters);
    }

    // dispatch to a registered operation
    const op = this._match(path, req.method);
    if (!op) return this._wire(res, 404, requestId, 'unknown_resource');
    if (!device.grantedScopes.includes(op.scope)) return this._wire(res, 403, requestId, 'scope_denied');

    let body = {};
    if (bodyBytes.length) {
      try { body = JSON.parse(bodyBytes.toString('utf8')); } catch { return this._wire(res, 400, requestId, 'payload_invalid'); }
      if (!isRecord(body)) return this._wire(res, 400, requestId, 'payload_invalid');
    }
    // idempotency key: headers request-id is the wire id; body must not carry it
    if (own(body, 'requestId') || own(body, 'request_id')) return this._wire(res, 400, requestId, 'invalid_request');

    try {
      const result = await op.invoke({ device, body, params: op.params, requestId, adapters: this.adapters, nowMs });
      if (result.denied) return this._wire(res, result.denied.status, requestId, result.denied.code, result.denied.retryable);
      return json(res, result.status ?? 200, result.body ?? {});
    } catch (e) {
      this.log(`remote op ${op.id} failed: ${e?.message ?? e}`);
      return this._wire(res, 500, requestId, 'internal_error', true);
    }
  }

  _match(path, method) {
    for (const op of REMOTE_V1.operations) {
      if (op.method !== method) continue;
      const params = matchPath(op.path, path);
      if (params) return { ...op, params, invoke: this._op(op.id) };
    }
    return null;
  }

  _op(id) {
    switch (id) {
      case 'projects.list': return this.adapters.projects.list;
      case 'sessions.list': return this.adapters.sessions.list;
      case 'runtime.create': return this.adapters.conversations.create;
      case 'runtime.snapshot': return this.adapters.conversations.snapshot;
      case 'chat.send': return this.adapters.conversations.send;
      case 'chat.stop': return this.adapters.conversations.stop;
      case 'approvals.list': return this.adapters.approvals.list;
      case 'approvals.respond': return this.adapters.approvals.respond;
    }
    return async () => ({ denied: { status: 404, code: 'unknown_resource' } });
  }
}

function matchPath(template, path) {
  const t = template.split('/').filter(Boolean);
  const p = path.split('/').filter(Boolean);
  if (t.length !== p.length) return null;
  const params = {};
  for (let i = 0; i < t.length; i++) {
    const seg = t[i];
    if (seg.startsWith('{')) {
      const name = seg.slice(1, -1);
      const val = decodeURIComponent(p[i]);
      if (!OPAQUE_ID.test(val) && name !== 'projectId' && name !== 'conversationId' && name !== 'requestId') return null;
      params[name] = val;
    } else if (seg !== p[i]) return null;
  }
  return params;
}
function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
