/**
 * Pi GUI Remote · protocol v1 (desktop authoritative side).
 *
 * Self-contained contract constants + the Ed25519 signed-request / signed-frame
 * helpers. The MOBILE repo carries the reference validator that exercises this
 * shape in tests; this module is the desktop's authoritative copy, kept small
 * and dependency-free. Any divergence here is a protocol bug — treat both as
 * one change.
 */
import crypto from 'node:crypto';

export const REMOTE_V1 = {
  contractVersion: 1,
  protocolName: 'pi-gui-remote',
  protocolMajor: 1,
  signedMessage: [
    'version', 'deviceId', 'serviceId', 'replayEpoch', 'requestId',
    'method', 'path?canonicalQuery', 'timestamp', 'nonce', 'bodySha256',
  ].join('\n'),
  signatureClockSkewSeconds: 60,
  scopeVocabulary: [
    'projects.read', 'sessions.read', 'sessions.create',
    'chat.send', 'chat.stop', 'approvals.read', 'approvals.respond',
  ],
  operations: [
    { id: 'projects.list',   method: 'GET',  path: '/remote/v1/projects', scope: 'projects.read', ownerRequirement: 'collection' },
    { id: 'sessions.list',   method: 'GET',  path: '/remote/v1/projects/{projectId}/sessions', scope: 'sessions.read', ownerRequirement: 'project' },
    { id: 'runtime.create',  method: 'POST', path: '/remote/v1/projects/{projectId}/runtimes', scope: 'sessions.create', ownerRequirement: 'project' },
    { id: 'runtime.snapshot',method: 'GET',  path: '/remote/v1/conversations/{conversationId}/snapshot', scope: 'sessions.read', ownerRequirement: 'conversation' },
    { id: 'chat.send',       method: 'POST', path: '/remote/v1/conversations/{conversationId}/messages', scope: 'chat.send', ownerRequirement: 'conversation' },
    { id: 'chat.stop',       method: 'POST', path: '/remote/v1/conversations/{conversationId}/stop', scope: 'chat.stop', ownerRequirement: 'conversation' },
    { id: 'approvals.list',  method: 'GET',  path: '/remote/v1/conversations/{conversationId}/approvals', scope: 'approvals.read', ownerRequirement: 'conversation' },
    { id: 'approvals.respond', method: 'POST', path: '/remote/v1/approvals/{requestId}', scope: 'approvals.respond', ownerRequirement: 'approval' },
  ],
  eventStream: {
    method: 'GET', path: '/remote/v1/events', scope: 'sessions.read',
    queryParameters: ['cursor'],
    perEventScopes: {
      'snapshot': 'sessions.read', 'message.append': 'sessions.read',
      'conversation.status': 'sessions.read', 'reset': 'sessions.read',
      'approval.pending': 'approvals.read', 'approval.settled': 'approvals.read',
    },
    cursorPattern: '^[A-Za-z0-9_-]{8,128}$',
    reservedConversationId: 'stream-reset',
  },
  pairExchange: {
    method: 'POST', path: '/remote/v1/pair/exchange',
    scopeVocabularyRequired: 7,
  },
  limits: {
    maxRequestBytes: 262144,
    maxResponseBytes: 1048576,
    maxOperationsPerMinutePerDevice: 120,
    maxConcurrentStreamsPerDevice: 2,
    maxConcurrentStreamsTotal: 8,
    signatureClockSkewSeconds: 60,
    maxNonceEntriesPerDevice: 4096,
    maxPendingPairings: 8,
    maxDevices: 32,
    maxApprovalValueBytes: 2000,
    maxChatTextSerializedBytes: 8192,
    maxEventFrameBytes: 65536,
    maxJsonDepth: 16,
    maxSerializedResponseBytes: 1048576,
  },
};

export const HEX_SHA256 = /^[0-9a-f]{64}$/;
export const OPAQUE_ID = /^[A-Za-z0-9_-]{8,128}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
export const CURSOR_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function canonicalServiceId(serviceFingerprint) {
  return HEX_SHA256.test(serviceFingerprint) ? `svc-${serviceFingerprint.slice(0, 16)}` : null;
}

export function sha256(input) { return crypto.createHash('sha256').update(input).digest('hex'); }
export function b64url(bytes) { return Buffer.from(bytes).toString('base64url'); }
export function decodeB64url(str, len) {
  if (typeof str !== 'string' || str.length === 0) return null;
  const b = Buffer.from(str, 'base64url');
  return b.length === len ? b : null;
}
export function timingSafe(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function isRecord(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
export function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
export function isRecordQuery(q) { return isRecord(q); }

export function ed25519Verify(publicKeyRaw, signatureB64, messageBytes) {
  try {
    const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), decodeB64url(publicKeyRaw, 32)]), format: 'der', type: 'spki' });
    return crypto.verify(null, messageBytes, pub, decodeB64url(signatureB64, 64));
  } catch { return false; }
}
export function ed25519Sign(privateKeyDer, messageBytes) {
  try {
    const priv = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
    return crypto.sign(null, messageBytes, priv).toString('base64url');
  } catch { return null; }
}
export function ed25519PublicFromPrivate(privateKeyDer) {
  try {
    const pub = crypto.createPublicKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' }).export({ format: 'der', type: 'spki' });
    return b64url(pub.subarray(pub.length - 32));
  } catch { return null; }
}
export function ed25519Generate() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' });
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' });
  return { publicKeyRaw: b64url(pub.subarray(pub.length - 32)), privateKeyDer: priv };
}

// Canonical JSON for the signed tuple + pair transcript (total, fail-closed on
// cycles/BigInt/depth — never throws).
const MAX_JSON_DEPTH = REMOTE_V1.limits.maxJsonDepth;
export function canonicalJson(value, depth = 0, seen = new Set()) {
  try {
    if (depth > MAX_JSON_DEPTH) return null;
    if (Array.isArray(value)) {
      if (seen.has(value)) return null;
      seen.add(value);
      const parts = value.map(item => canonicalJson(item, depth + 1, seen));
      seen.delete(value);
      return parts.some(p => p === null) ? null : `[${parts.join(',')}]`;
    }
    if (isRecord(value)) {
      if (seen.has(value)) return null;
      seen.add(value);
      const keys = Object.keys(value).sort(), out = [];
      for (const k of keys) { const inner = canonicalJson(value[k], depth + 1, seen); if (inner === null) { seen.delete(value); return null; } out.push(`${JSON.stringify(k)}:${inner}`); }
      seen.delete(value);
      return `{${out.join(',')}}`;
    }
    return JSON.stringify(value) ?? null;
  } catch { return null; }
}

// Signed request tuple the client signs with its device Ed25519 key.
export function buildSignatureMessage({ protocolVersion, deviceId, serviceId, replayEpoch, requestId, method, path, query = {}, timestamp, nonce, bodySha256 }) {
  const canonicalQuery = canonicalizeQuery(query);
  const target = canonicalQuery === null ? null : `${path}${canonicalQuery}`;
  if (target === null) return null;
  return [
    String(protocolVersion), deviceId, serviceId, String(replayEpoch), requestId,
    method, target, String(timestamp), nonce, bodySha256,
  ].join('\n');
}
export function canonicalizeQuery(query) {
  if (query === undefined || query === null) return '';
  if (!isRecord(query)) return null;
  const keys = Object.keys(query).sort();
  const pairs = [];
  for (const k of keys) {
    const v = query[k];
    if (v === undefined) continue;
    const sv = Array.isArray(v) ? v.map(String) : [String(v)];
    for (const item of sv) {
      pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`);
    }
  }
  return pairs.length ? `?${pairs.join('&')}` : '';
}

// Signed event-frame message the server signs with the service key.
export function buildEventFrameMessage({ protocolVersion, deviceId, serviceId, streamGeneration, sequence, conversationId, ownerRevision, cursor, event }, payloadDigest) {
  return [
    String(protocolVersion), deviceId, serviceId, String(streamGeneration), String(sequence),
    conversationId, String(ownerRevision), cursor, event, payloadDigest,
  ].join('\n');
}

export function requiredEventScope(eventName) { return REMOTE_V1.eventStream.perEventScopes[eventName]; }

// Closed wire error vocabulary (17 codes; cursor_expired is a reset reason, not a wire error).
export const WIRE_ERROR_CODES = [
  'unauthorized', 'pairing_expired', 'pairing_rejected', 'rate_limited',
  'scope_denied', 'stale_owner', 'stale_revision', 'unknown_resource',
  'operation_rejected', 'replay_rejected', 'sequence_gap', 'server_busy',
  'unavailable', 'invalid_request', 'payload_invalid', 'internal_error',
  'request_too_large',
];

export function wireErrorBody(code, retryable = false) {
  return { protocolVersion: 1, requestId: ZERO_UUID, error: { code, retryable } };
}
export function wireErrorBodyFor(code, requestId, retryable = false) {
  return { protocolVersion: 1, requestId, error: { code, retryable } };
}
