/**
 * Remote v1 gateway listener — the ONLY remote-facing surface.
 *
 *  - independent HTTPS server (own port, own TLS cert) — never widens the
 *    existing 127.0.0.1 router, never forwards /api/*
 *  - transport adapter runs BEFORE parsing: strict UTF-8 raw-target, single
 *    '?', no duplicate/blank query names, ASCII-printable path, no duplicate
 *    header names, closed transport header whitelist
 *  - every request except POST /remote/v1/pair/exchange is a signed request;
 *    admission order per contract: transport -> route -> signature -> scope ->
 *    grant -> owner+revision -> dispatch; earlier failures never dispatch
 *  - wire errors are the closed 17-code vocabulary; internal codes never leak;
 *    pre-auth failures echo the all-zero requestId
 *  - success responses are schema + forbidden-value validated BEFORE writing
 */
import https from 'node:https';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import {
  REMOTE_V1, validateRawTarget, authorizeRemoteOperation, commitAdmission,
  validateRemoteResponse, wireErrorCode, requiredEventScope,
} from './protocol.mjs';
import { canonicalJson, isRecord } from './keys.mjs';

const L = REMOTE_V1.limits;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Hop/transport headers the client cannot avoid; everything else outside the
// signed whitelist is rejected (strict transport).
const TRANSPORT_NOISE = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'te', 'upgrade', 'via']);
const PAIR_HEADERS = new Set(['content-type', 'accept']);
const SIGNED_HEADERS = new Set(REMOTE_V1.signedRequestHeaders);

const WIRE_STATUS = {
  unauthorized: 401,
  pairing_required: 401,
  pairing_expired: 401,
  pairing_rejected: 403,
  rate_limited: 429,
  scope_denied: 403,
  stale_owner: 409,
  stale_revision: 409,
  unknown_resource: 404,
  operation_rejected: 409,
  replay_rejected: 409,
  sequence_gap: 409,
  server_busy: 503,
  unavailable: 503,
  invalid_request: 400,
  payload_invalid: 400,
  internal_error: 500,
};
const RETRYABLE = new Set(['rate_limited', 'server_busy', 'unavailable', 'internal_error', 'sequence_gap']);

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { const e = new Error('request_too_large'); e.code = 'request_too_large'; reject(e); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export class RemoteGateway {
  /**
   * @param tlsOptions  {key, cert, minVersion} for https.createServer
   * @param serviceFingerprint  sha256 hex of the TLS cert DER
   * @param deviceStore / pairManager / eventStream / adapters (buildAdapters result)
   * @param consumeNonce  DeviceStore.consumeNonce
   */
  constructor({ port = 0, host = '127.0.0.1', tlsOptions, serviceFingerprint,
                deviceStore, pairManager, eventStream, adapters, log = () => {} }) {
    this.port = port; this.host = host;
    this.serviceFingerprint = serviceFingerprint;
    this.serviceId = `svc-${serviceFingerprint.slice(0, 16)}`;
    this.deviceStore = deviceStore;
    this.pair = pairManager;
    this.stream = eventStream;
    this.adapters = adapters;
    this.log = log;
    this.rate = new Map();                    // deviceId -> [ms]
    this.server = https.createServer(tlsOptions, (req, res) => {
      this._handle(req, res).catch(e => {
        this.log(`remote request failed: ${e?.message ?? e}`);
        try { this._wire(res, ZERO_UUID, 'internal_error'); } catch {}
      });
    });
  }
  listen() { return new Promise(resolve => this.server.listen(this.port, this.host, () => resolve(this.server.address()))); }
  close() { return new Promise(resolve => this.server.close(resolve)); }

  _wire(res, requestId, code, extraHeaders) {
    const body = { protocolVersion: 1, requestId, error: { code, retryable: RETRYABLE.has(code) } };
    try {
      res.writeHead(WIRE_STATUS[code] ?? 500, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
      res.end(JSON.stringify(body));
    } catch {}
  }
  _rateLimit(deviceId, nowMs) {
    let bucket = this.rate.get(deviceId);
    if (!bucket) { bucket = []; this.rate.set(deviceId, bucket); }
    while (bucket.length && bucket[0] < nowMs - 60000) bucket.shift();
    if (bucket.length >= L.maxOperationsPerMinutePerDevice) return false;
    bucket.push(nowMs);
    return true;
  }

  /** Raw transport gates shared by every route (before parsing). */
  _transportCheck(req) {
    // Duplicate header names are rejected before folding (contract).
    const seen = new Set();
    const headers = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = String(req.rawHeaders[i]).toLowerCase();
      if (seen.has(name)) return { ok: false, code: 'duplicate_header' };
      seen.add(name);
      headers[name] = req.rawHeaders[i + 1];
    }
    for (const name of seen) {
      if (!SIGNED_HEADERS.has(name) && !PAIR_HEADERS.has(name) && !TRANSPORT_NOISE.has(name)) {
        return { ok: false, code: 'header_not_allowed' };
      }
    }
    const target = validateRawTarget(req.url);
    if (!target.ok) return { ok: false, code: target.code };
    return { ok: true, headers, path: target.path, query: target.query };
  }

  /** Build the validator-shaped request for a signed route. */
  async _requestShape(req, transport) {
    // rawBody is handed to the validator as a Buffer so bodySha256 binds the
    // EXACT wire bytes (contract transportAdapter.body/bodyDigest). A lossy
    // utf8 decode would make the signature bind U+FFFD-re-encoded bytes instead
    // — the validator's strictUtf8 + canonical checks still reject bad input,
    // but the signature must commit to what actually crossed the wire.
    let rawBody = Buffer.alloc(0);
    if (req.method !== 'GET') {
      try { rawBody = await readRawBody(req, L.maxRequestBytes); }
      catch (e) { return { fail: e.code === 'request_too_large' ? 'request_too_large' : 'body_bytes_required' }; }
    } else {
      // GET must not carry a body; anything present is still read to check.
      // The validator treats '' as absent but a (even empty) Buffer as a
      // present body, so an empty GET must pass '' not Buffer.alloc(0).
      try { rawBody = await readRawBody(req, L.maxRequestBytes); } catch { return { fail: 'request_too_large' }; }
      if (rawBody.length === 0) rawBody = '';
    }
    let body;
    if (req.method !== 'GET' && rawBody.length) {
      try { body = JSON.parse(rawBody.toString('utf8')); } catch { body = undefined; }
      if (!isRecord(body)) body = undefined;
    }
    return { method: req.method, path: transport.path, query: transport.query, headers: transport.headers, body, rawBody };
  }

  async _handle(req, res) {
    const t = this._transportCheck(req);
    if (!t.ok) return this._wire(res, ZERO_UUID, 'unauthorized');
    const { path, query, headers } = t;

    /* ---- unsigned surface: pair exchange ---- */
    if (path === REMOTE_V1.pairExchange.path && req.method === REMOTE_V1.pairExchange.method) {
      let rawBody;
      try { rawBody = await readRawBody(req, L.maxRequestBytes); }
      catch { return this._wire(res, ZERO_UUID, 'unauthorized'); }
      let body;
      try { body = JSON.parse(rawBody.toString('utf8')); } catch { body = undefined; }
      if (!isRecord(body)) body = undefined;
      // The pair validator whitelists only content-type/accept — pass exactly
      // the transport surface it evaluates, never socket-level headers. rawBody
      // goes through as a Buffer so the signed proof binds the exact wire bytes.
      const pairHeaders = {};
      if (headers['content-type'] !== undefined) pairHeaders['content-type'] = headers['content-type'];
      if (headers['accept'] !== undefined) pairHeaders['accept'] = headers['accept'];
      const request = { method: req.method, path, query, headers: pairHeaders, body, rawBody };
      const peerId = req.socket.remoteAddress ?? 'unknown';
      const out = this.pair.exchangeToWire(request, { peerId });
      if (!out.ok) return this._wire(res, ZERO_UUID, out.wire);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(canonicalJson(out.response) ?? JSON.stringify(out.response));
    }
    if (path === REMOTE_V1.pairExchange.path || path.startsWith('/remote/v1/pair/')) {
      return this._wire(res, ZERO_UUID, 'unauthorized');
    }

    /* ---- signed surface ---- */
    const shaped = await this._requestShape(req, t);
    if (shaped.fail) return this._wire(res, ZERO_UUID, 'unauthorized');
    const request = shaped;
    const echoId = UUID.test(headers['x-pi-remote-request-id'] ?? '') ? headers['x-pi-remote-request-id'] : ZERO_UUID;

    // The validator whitelists the signed headers + content-type/accept —
    // pass exactly that surface; socket headers (host, connection, ...) never
    // reach signature evaluation.
    const signedHeaders = {};
    for (const name of REMOTE_V1.signedRequestHeaders) if (headers[name] !== undefined) signedHeaders[name] = headers[name];
    if (headers['content-type'] !== undefined) signedHeaders['content-type'] = headers['content-type'];
    if (headers['accept'] !== undefined) signedHeaders['accept'] = headers['accept'];
    request.headers = signedHeaders;
    const deviceId = headers['x-pi-remote-device'];
    const device = typeof deviceId === 'string' ? this.deviceStore.get(deviceId) : null;
    const nowMs = Date.now();

    // Admission: signature -> scope -> grant -> owner+revision (one transaction).
    const admission = authorizeRemoteOperation({
      request, device, serviceFingerprint: this.serviceFingerprint,
      resolveOwner: this.adapters.resolveOwner,
      nowMs, consumeNonce: this.deviceStore.consumeNonce,
    });
    if (!admission.ok) return this._wire(res, echoId, admission.wire ?? wireErrorCode(admission.code));
    if (!this._rateLimit(device.deviceId, nowMs)) return this._wire(res, admission.requestId, 'rate_limited');

    // Event stream: long-lived SSE; subscribe handles its own authorization
    // rechecks and cursor semantics.
    if (admission.operation === 'events.stream') {
      const rejected = this.stream.handleSubscribe(req, res, device, request.query);
      if (rejected) return this._wire(res, admission.requestId, rejected.body.code);
      return;
    }

    // Commit recheck: re-read CURRENT device + owner and compare every bound field.
    const deviceNow = this.deviceStore.get(device.deviceId);
    const commit = commitAdmission({
      admissionToken: admission.admissionToken, device: deviceNow,
      resolveOwner: this.adapters.resolveOwner, nowMs,
    });
    if (!commit.ok) return this._wire(res, admission.requestId, wireErrorCode(commit.code));

    /* Post-commit liveness: a revoke/expiry that lands between admission and
     * dispatch must fail closed (contract deviceLifecycle.revocation — "reject
     * all new requests"). Re-read the live record right before dispatch; a
     * revoked or inactive device never reaches the adapter. */
    const live = this.deviceStore.active(device.deviceId);
    if (!live) return this._wire(res, admission.requestId, 'device_inactive');

    const dispatch = this.adapters.dispatch[admission.operation];
    if (!dispatch) return this._wire(res, admission.requestId, 'operation_rejected');

    let out;
    try {
      if (admission.operation === 'approvals.respond') {
        out = await dispatch({
          request, device, serviceId: this.serviceId, serviceFingerprint: this.serviceFingerprint,
          consumeNonce: () => true,   // nonce already consumed in admission
        });
      } else {
        out = await dispatch({
          device, pathParameters: admission.pathParameters, body: request.body,
          owner: admission.owner, requestId: admission.requestId, request, nowMs,
        });
      }
    } catch (e) {
      this.log(`remote op ${admission.operation} failed: ${e?.message ?? e}`);
      return this._wire(res, admission.requestId, 'internal_error');
    }
    if (!out.ok) return this._wire(res, admission.requestId, out.wire ?? wireErrorCode(out.code));

    // Success envelope — schema + forbidden-value validated before write.
    const response = {
      protocolVersion: 1,
      requestId: admission.requestId,
      operation: admission.operation,
      serverRevision: admission.owner?.revision ?? 0,
      result: out.result,
    };
    if (!validateRemoteResponse(response, admission.operation, admission.requestId)) {
      this.log(`remote op ${admission.operation} produced an unsafe result (projection refused)`);
      return this._wire(res, admission.requestId, 'internal_error');
    }
    const bytes = canonicalJson(response);
    if (!bytes) return this._wire(res, admission.requestId, 'internal_error');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(bytes);
  }
}
