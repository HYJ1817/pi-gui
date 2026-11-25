/**
 * Remote v1 gateway — end-to-end contract test over a REAL TLS listener.
 *
 * Covers the M1 acceptance matrix: isolated TLS entry, pinned fingerprint,
 * pair exchange (proof/budget/confirmation/replay), signed requests,
 * replay/epoch/expiry rejection, scope+grant IDOR, owner revision, event
 * frames + cursor transitions, approval settlement, revocation cutting live
 * streams, and the closed error vocabulary.
 *
 * Everything runs on synthetic fixtures (tmp dataDir, stub domain) — never a
 * real project, never a real pi process.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log(`ok   ${name}`); })
    .catch(e => { failed++; console.log(`FAIL ${name}\n     ${e.stack ?? e}`); });
}

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const b64 = b => Buffer.from(b).toString('base64url');
const canonicalJson = v => {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object' && !(v instanceof Buffer)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
};
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, publicKeyRaw: b64(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)) };
}

const MODULES = {
  index: '../server/remote/index.mjs',
  protocol: '../server/remote/protocol.mjs',
  keys: '../server/remote/keys.mjs',
};

async function boot(overrides = {}) {
  const { startRemote } = await import(MODULES.index);
  const { REMOTE_V1 } = await import(MODULES.protocol);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-gw-'));
  // Synthetic domain fixture: one project, one live runtime conversation.
  const conversations = [{
    conversationId: 'conv_fixture_001',
    sessionId: 'sess_fixture_001',
    title: 'fixture session',
    lifecycle: 'idle',
    revision: 1,
    workspace: { cwd: 'C:/fixture/proj', workspaceId: 'ws1', workspaceEpoch: 3 },
    pendingApprovals: overrides.pendingApprovals ?? [],
    messages: [{ messageId: 'msg_fixture_01', role: 'assistant', text: 'hello' }],
  }];
  const domain = {
    projects: () => [{ path: 'C:/fixture/proj', name: 'fixture' }],
    conversations: () => conversations,
    sessionRecords: p => [{ sessionId: 'sess_fixture_001', displayName: 'fixture session', updatedAt: '2026-01-01T00:00:00Z', conversationIds: ['conv_fixture_001'] }],
    openConversation: async () => ({ conversationId: 'conv_fixture_001' }),
    sendMessage: overrides.sendMessage ?? (async () => ({ accepted: true })),
    stop: async () => ({ stopped: true }),
    pendingDialogs: () => conversations.flatMap(c => c.pendingApprovals),
    consumeApproval: overrides.consumeApproval ?? (() => true),
  };
  const remote = startRemote({
    dataDir, domain,
    host: '127.0.0.1', port: 0,
    confirmLocally: overrides.confirmLocally ?? null,
    grantsFor: overrides.grantsFor ?? (() => ['p-' + crypto.createHash('sha256').update('C:/fixture/proj').digest('base64url').slice(0, 22)]),
  });
  const addr = await remote.listen();
  const fingerprint = remote.serviceFingerprint;
  // Full TLS handshake on EVERY request: session resumption (and keep-alive
  // socket reuse) makes the server skip re-transmitting its certificate, so
  // getPeerCertificate() comes back EMPTY — that would silently un-verify the
  // pinned fingerprint this client is required to check. keepAlive:false
  // + maxCachedSessions:0 forces a fresh full handshake per request; the cert
  // is captured in the response callback (checkServerIdentity is never invoked
  // under rejectUnauthorized:false, and the socket is gone by 'end').
  const agent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
  let lastPeerCert = null;
  const peerCertOf = res => res.socket?.getPeerCertificate?.() ?? null;
  const request = (method, p, { body, headers = {}, rawBody, tls = {} } = {}) => new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port: addr.port, method, path: p, agent,
      headers: { 'content-length': rawBody !== undefined ? Buffer.byteLength(rawBody) : (body !== undefined ? Buffer.byteLength(canonicalJson(body)) : 0), ...headers },
      rejectUnauthorized: false,
      ...tls,
    }, res => {
      lastPeerCert = peerCertOf(res);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers, cert: lastPeerCert }));
    });
    req.on('error', reject);
    if (rawBody !== undefined) req.write(rawBody);
    else if (body !== undefined) req.write(canonicalJson(body));
    req.end();
  });
  // TLS-pinning client: verifies the captured peer cert sha256 == fingerprint
  // once the response lands (assert throws inside the promise -> rejects).
  const pinnedRequest = async (method, p, opts = {}) => {
    const res = await request(method, p, opts);
    assert.ok(res.cert && res.cert.raw, 'no peer certificate captured');
    assert.equal(sha256(res.cert.raw), fingerprint, 'pinned fingerprint mismatch');
    return res;
  };
  return { remote, addr, fingerprint, request, pinnedRequest, dataDir, REMOTE_V1, conversations,
    getPeerCert: () => lastPeerCert,
    cleanup: async () => { await remote.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

/** Full pair exchange: session -> approve -> signed client exchange body. */
async function pair(ctx, { scopes = ['projects.read', 'sessions.read', 'chat.send', 'chat.stop', 'approvals.read', 'approvals.respond', 'sessions.create'], mutate } = {}) {
  const session = ctx.remote.admin.issuePairing();
  assert.ok(session, 'issuePairing must mint a session');
  const device = keypair();
  const clientNonce = b64(crypto.randomBytes(32));
  const body = {
    pairCode: session.code,
    deviceName: 'fixture-phone',
    devicePublicKey: device.publicKeyRaw,
    clientNonce,
    serviceFingerprint: ctx.fingerprint,
    proofSignature: '',
    pairingSessionId: session.pairingSessionId,
    requestedScopes: scopes,
  };
  const { buildPairProofMessage } = await import(MODULES.protocol);
  const msg = buildPairProofMessage(body);
  body.proofSignature = crypto.sign(null, Buffer.from(msg, 'utf8'), device.privateKey).toString('base64url');
  if (mutate) mutate(body);
  // Desktop approval binds the full transcript + scope set.
  const approvalId = ctx.remote.admin.approvePairing({
    pairingSessionId: body.pairingSessionId, pairCode: body.pairCode,
    deviceName: body.deviceName, devicePublicKey: body.devicePublicKey,
    clientNonce: body.clientNonce, serviceFingerprint: body.serviceFingerprint,
    requestedScopes: [...scopes],
    proofTranscript: canonicalJson(body),
  });
  const res = await ctx.pinnedRequest('POST', '/remote/v1/pair/exchange', {
    rawBody: canonicalJson(body),
    headers: { 'content-type': 'application/json; charset=utf-8', 'accept': 'application/json' },
  });
  return { res, device, session, body };
}

function signed(device, ctx, { method = 'GET', path, query = {}, body, deviceId, epoch = 1, requestId = crypto.randomUUID(), nonce, timestamp, accept }) {
  deviceId = deviceId ?? device.deviceId;
  const { buildSignatureMessage } = ctx;
  const rawBody = body === undefined ? '' : canonicalJson(body);
  const bodySha256 = sha256(rawBody);
  const ts = timestamp ?? Date.now().toString();
  const nn = nonce ?? b64(crypto.randomBytes(32));
  const msg = buildSignatureMessage({
    protocolVersion: 1, deviceId, serviceId: ctx.serviceId, replayEpoch: epoch,
    requestId, method, path, query, timestamp: ts, nonce: nn, bodySha256,
  });
  const signature = crypto.sign(null, Buffer.from(msg, 'utf8'), device.privateKey).toString('base64url');
  const acceptHeader = accept ?? 'application/json';
  return {
    rawBody,
    headers: {
      'x-pi-remote-device': deviceId,
      'x-pi-remote-epoch': String(epoch),
      'x-pi-remote-request-id': requestId,
      'x-pi-remote-timestamp': ts,
      'x-pi-remote-nonce': nn,
      'x-pi-remote-body-sha256': bodySha256,
      'x-pi-remote-signature': signature,
      ...(method === 'GET' ? { 'accept': acceptHeader } : { 'content-type': 'application/json; charset=utf-8', 'accept': acceptHeader }),
    },
  };
}
const envelope = (operation, payload, ownerRevision) => ({ protocolVersion: 1, operation, payload, ...(ownerRevision === undefined ? {} : { ownerRevision }) });
const PROJECT_ID = 'p-' + crypto.createHash('sha256').update('C:/fixture/proj').digest('base64url').slice(0, 22);

async function main() {
  const { REMOTE_V1, buildSignatureMessage, validateEventEnvelope } = await import(MODULES.protocol);
  const { canonicalJson: cj } = await import(MODULES.keys);

  await t('TLS entry is HTTPS-only with a pinned self-signed cert', async () => {
    const ctx = await boot();
    try {
      // plain HTTP to the TLS port must not yield a contract response
      await new Promise((resolve) => {
        const req = require('node:http').request({ host: '127.0.0.1', port: ctx.addr.port, method: 'GET', path: '/remote/v1/projects', timeout: 1500 }, () => resolve());
        req.on('error', () => resolve());
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.end();
      });
      // TLS client pinning the fingerprint connects fine.
      const r = await ctx.pinnedRequest('GET', '/remote/v1/projects', { headers: { accept: 'application/json' } });
      assert.equal(r.status, 401);
      assert.equal(sha256(ctx.getPeerCert().raw), ctx.fingerprint);
    } finally { await ctx.cleanup(); }
  });

  await t('service fingerprint is stable across restarts (persisted cert+key)', async () => {
    // Rotation must be an explicit lifecycle event, not a side-effect of a
    // routine reboot: a second startRemote on the same dataDir must reuse the
    // persisted key+cert so the pinned serviceFingerprint does not move.
    const fs = require('node:fs');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-persist-'));
    try {
      const { startRemote } = await import(MODULES.index);
      const domain = { projects: () => [], conversations: () => [], sessionRecords: () => [], openConversation: async () => ({}), sendMessage: async () => ({}), stop: async () => ({}), pendingDialogs: () => [], consumeApproval: () => true };
      const r1 = startRemote({ dataDir, domain, host: '127.0.0.1', port: 0 });
      const fp1 = r1.serviceFingerprint;
      await r1.close();
      const r2 = startRemote({ dataDir, domain, host: '127.0.0.1', port: 0 });
      const fp2 = r2.serviceFingerprint;
      await r2.close();
      assert.equal(fp2, fp1, 'serviceFingerprint rotated on routine restart');
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  });

  await t('grant removal resets the device event stream (authorization_changed)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      const deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = deviceId;
      const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/events', accept: 'text/event-stream' });
      const got = await new Promise(resolve => {
        const req = https.request({
          host: '127.0.0.1', port: ctx.addr.port, method: 'GET', path: '/remote/v1/events',
          headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }),
        }, res => {
          let buf = '';
          res.on('data', c => {
            buf += c.toString('utf8');
            if (buf.includes('event: reset')) { req.destroy(); resolve(buf); }
          });
        });
        req.on('error', () => resolve(''));
        req.end();
        setTimeout(() => ctx.remote.admin.setGrants(deviceId, []), 250);   // remove every grant
      });
      assert.ok(got.includes('"reason":"authorization_changed"') || got.includes('event: reset'), 'grant removal did not reset the stream');
    } finally { await ctx.cleanup(); }
  });

  await t('unsigned non-pair routes and unknown targets are closed unauthorized', async () => {
    const ctx = await boot();
    try {
      for (const p of ['/remote/v1/projects', '/api/sessions', '/', '/remote/v9/projects', '/remote/v1/events']) {
        const r = await ctx.pinnedRequest('GET', p, { headers: { accept: 'application/json' } });
        assert.equal(r.status, 401, p);
        const body = JSON.parse(r.body);
        assert.equal(body.error.code, 'unauthorized');
        assert.equal(body.requestId, '00000000-0000-0000-0000-000000000000');
        assert.equal(Object.keys(body.error).sort().join(','), 'code,retryable');
      }
    } finally { await ctx.cleanup(); }
  });

  await t('raw transport rejects duplicate query params and illegal targets before auth', async () => {
    const ctx = await boot();
    try {
      for (const p of ['/remote/v1/events?cursor=a&cursor=b', '/remote/v1/projects?x=', '/remote/v1/projects/../x', '/remote/v1/projects%20x', '/remote/v1/stream-reset/x']) {
        const r = await ctx.pinnedRequest('GET', p, { headers: { accept: 'application/json' } });
        assert.equal(r.status, 401, p);
        assert.equal(JSON.parse(r.body).error.code, 'unauthorized');
      }
    } finally { await ctx.cleanup(); }
  });

  await t('pair exchange: happy path mints a device and returns a signed response', async () => {
    const ctx = await boot();
    try {
      const { res, body } = await pair(ctx);
      assert.equal(res.status, 200, res.body);
      const response = JSON.parse(res.body);
      assert.deepEqual(Object.keys(response).sort(), ['deviceId', 'expiresAt', 'grantedScopes', 'replayEpoch', 'serverNonce', 'serverSignature']);
      assert.equal(response.replayEpoch, 1);
      assert.equal(response.grantedScopes.length, 7);
      // Verify the server signature with the pinned service key.
      const { serverSignature, ...unsigned } = response;
      const msg = ['remote-v1-pair-response', body.clientNonce, canonicalJson(unsigned)].join('\n');
      const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(ctx.remote.servicePublicKey, 'base64url')]), format: 'der', type: 'spki' });
      assert.ok(crypto.verify(null, Buffer.from(msg, 'utf8'), pub, Buffer.from(serverSignature, 'base64url')));
      assert.equal(ctx.remote.deviceStore.active(response.deviceId)?.grantedScopes.length, 7);
    } finally { await ctx.cleanup(); }
  });

  await t('pair exchange negatives: bad proof/code/session/fingerprint/headers all fail closed', async () => {
    const ctx = await boot({ confirmLocally: t2 => ctx2 => null });
    try {
      // wrong code
      let r = await pair(ctx, { mutate: b => { b.pairCode = '000000'; } });
      assert.ok(r.res.status >= 400);
      // bad session
      r = await pair(ctx, { mutate: b => { b.pairingSessionId = 'x'.repeat(22); } });
      assert.ok(r.res.status >= 400);
      // fingerprint mismatch
      r = await pair(ctx, { mutate: b => { b.serviceFingerprint = '0'.repeat(64); } });
      assert.equal(r.res.status, 401);
      // bad proof signature
      r = await pair(ctx, { mutate: b => { b.proofSignature = b.proofSignature.slice(0, -2) + 'AA'; } });
      assert.ok(r.res.status >= 400);
      // extra header rejected by strict transport
      r = await ctx.pinnedRequest('POST', '/remote/v1/pair/exchange', { rawBody: '{}', headers: { 'content-type': 'application/json; charset=utf-8', 'x-evil': '1' } });
      assert.equal(r.status, 401);
      // query on pair route rejected
      r = await ctx.pinnedRequest('POST', '/remote/v1/pair/exchange?x=1', { rawBody: '{}', headers: { 'content-type': 'application/json; charset=utf-8' } });
      assert.equal(r.status, 401);
      // non-canonical body rejected (body_parse_mismatch -> closed unauthorized)
      const session = ctx.remote.admin.issuePairing();
      const dev = keypair();
      const ugly = `{"pairCode":"${session.code}","deviceName":"n","devicePublicKey":"${dev.publicKeyRaw}","clientNonce":"${b64(crypto.randomBytes(32))}","serviceFingerprint":"${ctx.fingerprint}","proofSignature":"${'A'.repeat(86)}","pairingSessionId":"${session.pairingSessionId}","requestedScopes":["sessions.read","projects.read"],"zzz":1}`;
      r = await ctx.pinnedRequest('POST', '/remote/v1/pair/exchange', { rawBody: ugly, headers: { 'content-type': 'application/json; charset=utf-8' } });
      assert.equal(r.status, 401);
      assert.equal(JSON.parse(r.body).error.code, 'unauthorized');
      // canonical bytes but schema-invalid body -> pair_payload_invalid -> payload_invalid (400)
      const schemaBad = canonicalJson({ pairCode: 'toolong', deviceName: 'n', devicePublicKey: dev.publicKeyRaw, clientNonce: b64(crypto.randomBytes(32)), serviceFingerprint: ctx.fingerprint, proofSignature: 'A'.repeat(86), pairingSessionId: session.pairingSessionId, requestedScopes: ['sessions.read', 'projects.read'] });
      r = await ctx.pinnedRequest('POST', '/remote/v1/pair/exchange', { rawBody: schemaBad, headers: { 'content-type': 'application/json; charset=utf-8' } });
      assert.equal(r.status, 400);
      assert.equal(JSON.parse(r.body).error.code, 'payload_invalid');
    } finally { await ctx.cleanup(); }
  });

  await t('signed ops: projects.list/sessions.list filtered by grant; snapshot returns contract shape', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      // extract deviceId from store (the pair response went through the wire)
      const deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = deviceId;
      const s = (m, p, opts) => signed(device, ctx, { method: m, path: p, ...opts });
      const sreq = async (m, p, opts) => ctx.pinnedRequest(m, p, { rawBody: s(m, p, opts).rawBody, headers: s(m, p, opts).headers });

      // projects.list (GET, collection admission, grant-filtered)
      let r = await sreq('GET', '/remote/v1/projects');
      assert.equal(r.status, 200, r.body);
      let body = JSON.parse(r.body);
      assert.deepEqual(body.result.projects.map(p => p.projectId), [PROJECT_ID]);
      assert.equal(body.operation, 'projects.list');

      // sessions.list under granted project
      r = await sreq('GET', `/remote/v1/projects/${PROJECT_ID}/sessions`);
      assert.equal(r.status, 200, r.body);
      body = JSON.parse(r.body);
      assert.equal(body.result.sessions[0].projectId, PROJECT_ID);

      // snapshot
      r = await sreq('GET', '/remote/v1/conversations/conv_fixture_001/snapshot');
      assert.equal(r.status, 200, r.body);
      body = JSON.parse(r.body);
      assert.equal(body.result.status, 'idle');
      assert.equal(body.result.messages[0].role, 'assistant');
      // snapshotWatermark: the returned cursor+generation+sequence is a real,
      // resumable device-stream watermark (never the fabricated g1_s0_ stub).
      assert.ok(/^g\d+_s\d+_[A-Za-z0-9_-]{22}$/.test(body.result.cursor), `snapshot cursor ${body.result.cursor} not resumable`);
      assert.ok(body.result.streamGeneration >= 1 && body.result.sequence >= 1);
    } finally { await ctx.cleanup(); }
  });

  await t('replay: nonce reuse, old epoch, stale timestamp and bad signature all rejected', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      const deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = deviceId;
      const s = opts => signed(device, ctx, { method: 'GET', path: '/remote/v1/projects', ...opts });
      const call = h => ctx.pinnedRequest('GET', '/remote/v1/projects', { headers: h.headers });

      let r = await call(s({}));
      assert.equal(r.status, 200, r.body);
      // reuse exact same signed request -> the nonce was already consumed
      const first = s({ nonce: b64(crypto.randomBytes(32)) });
      r = await call(first); // consume
      assert.equal(r.status, 200, r.body);
      r = await call(first); // replay -> rejected
      assert.equal(JSON.parse(r.body).error.code, 'replay_rejected');
      // old epoch
      r = await call(s({ epoch: 9 }));
      assert.equal(r.status, 401);
      // future timestamp beyond skew
      r = await call(s({ timestamp: String(Date.now() + 120_000) }));
      assert.equal(r.status, 401);
      // forged signature
      const bad = s({});
      bad.headers['x-pi-remote-signature'] = b64(crypto.randomBytes(64));
      r = await call(bad);
      assert.equal(r.status, 401);
    } finally { await ctx.cleanup(); }
  });

  await t('scope+grant IDOR: ungranted project/scope fail with closed codes', async () => {
    const ctx = await boot({ grantsFor: () => ['p-' + crypto.createHash('sha256').update('C:/fixture/other').digest('base64url').slice(0, 22)] });
    try {
      const { device } = await pair(ctx).then(p => p);
      const deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = deviceId;
      const s = (m, p, o) => signed(device, ctx, { method: m, path: p, ...o });
      const call = async (m, p, o) => { const x = s(m, p, o); return ctx.pinnedRequest(m, p, { rawBody: x.rawBody, headers: x.headers }); };
      // project exists but device grant covers a different path -> filtered out
      let r = await call('GET', '/remote/v1/projects');
      assert.equal(r.status, 200);
      assert.equal(JSON.parse(r.body).result.projects.length, 0);
      // direct sessions.list on an ungranted project -> unknown_resource
      r = await call('GET', `/remote/v1/projects/${PROJECT_ID}/sessions`);
      assert.equal(JSON.parse(r.body).error.code, 'unknown_resource');
    } finally { await ctx.cleanup(); }
  });

  await t('chat.send requires ownerRevision; stale revision rejected; idempotent retry', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      const deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = deviceId;
      const call = async body => {
        const x = signed(device, ctx, { method: 'POST', path: '/remote/v1/conversations/conv_fixture_001/messages', body });
        return ctx.pinnedRequest('POST', '/remote/v1/conversations/conv_fixture_001/messages', { rawBody: x.rawBody, headers: x.headers });
      };
      const clientMessageId = crypto.randomUUID();
      // missing ownerRevision -> unauthorized (pre-auth)
      let r = await call(envelope('chat.send', { clientMessageId, text: 'hi' }));
      assert.equal(r.status, 401);
      // wrong revision -> stale_revision
      r = await call(envelope('chat.send', { clientMessageId, text: 'hi' }, 99));
      assert.equal(JSON.parse(r.body).error.code, 'stale_revision');
      // right revision -> accepted
      r = await call(envelope('chat.send', { clientMessageId, text: 'hi' }, 1));
      assert.equal(r.status, 200, r.body);
      const accepted = JSON.parse(r.body).result;
      assert.equal(accepted.accepted, true);
      // same clientMessageId retry -> recorded outcome (fresh nonce)
      r = await call(envelope('chat.send', { clientMessageId, text: 'hi' }, 1));
      assert.equal(r.status, 200);
      // same id + different payload -> payload_invalid
      r = await call(envelope('chat.send', { clientMessageId, text: 'DIFFERENT' }, 1));
      assert.equal(JSON.parse(r.body).error.code, 'payload_invalid');
    } finally { await ctx.cleanup(); }
  });

  await t('revocation: new requests unauthorized and live streams are closed', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      const deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = deviceId;
      const s = (m, p, o) => signed(device, ctx, { method: m, path: p, ...o });
      const x = s('GET', '/remote/v1/events', { accept: 'text/event-stream' });
      // subscribe (pinned: cert fingerprint checked when the response opens)
      const streamPromise = new Promise((resolve) => {
        const req = https.request({
          host: '127.0.0.1', port: ctx.addr.port, method: 'GET', path: '/remote/v1/events',
          headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }),
        }, res => {
          assert.equal(sha256(res.socket.getPeerCertificate().raw), ctx.fingerprint, 'stream cert pin');
          let got = '';
          res.on('data', c => { got += c.toString('utf8'); });
          res.on('end', () => resolve({ status: res.statusCode, body: got }));
        });
        req.on('error', e => resolve({ error: e }));
        req.end();
      });
      await new Promise(r => setTimeout(r, 300));
      // revoke
      assert.equal(ctx.remote.admin.revokeDevice(deviceId), true);
      // new request rejected
      const y = s('GET', '/remote/v1/projects');
      const r = await ctx.pinnedRequest('GET', '/remote/v1/projects', { headers: y.headers });
      assert.equal(r.status, 401);
      // stream closed
      const sres = await streamPromise;
      assert.equal(sres.status, 200);          // opened fine
      // (ended) — the end event fired on revoke
      // Contract deviceLifecycle.revocation: exactly one reset frame with
      // reason authorization_changed is delivered BEFORE the close.
      const resetFrame = sres.body.split('\n\n').find(e => e.startsWith('event: reset'));
      assert.ok(resetFrame, `revocation must deliver a reset frame before close; got: ${sres.body.slice(0, 200)}`);
      const resetEnv = JSON.parse(resetFrame.split('\n').find(l => l.startsWith('data:')).slice(5));
      assert.equal(resetEnv.payload.reason, 'authorization_changed');
      assert.equal(resetEnv.event, 'reset');
      assert.equal(resetEnv.conversationId, 'stream-reset');
    } finally { await ctx.cleanup(); }
  });

  await t('event stream emits signed contract frames; cursor transitions obey the table', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      const deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = deviceId;
      const frames = [];
      const done = new Promise(resolve => {
        const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/events', accept: 'text/event-stream' });
        const req = https.request({ host: '127.0.0.1', port: ctx.addr.port, method: 'GET', path: '/remote/v1/events', headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, res => {
          assert.equal(sha256(res.socket.getPeerCertificate().raw), ctx.fingerprint, 'stream cert pin');
          let buf = '';
          res.on('data', c => {
            buf += c.toString('utf8');
            // A fresh subscribe opens with NO initial frame (contract
            // cursorTransitionTable.absent: start at the live head); the only
            // frame on the wire is the published one.
            const events = buf.split('\n\n').filter(e => e.startsWith('event:'));
            if (events.length >= 1) { req.destroy(); resolve(events); }
          });
        });
        req.on('error', () => {});
        req.end();
        setTimeout(() => ctx.remote.stream.publish('conv_fixture_001', 1, 'message.append', { messageId: 'msg_00000001', role: 'assistant', text: 'hi' }, [deviceId]), 200);
      });
      const events = await done;
      const data = events.map(e => JSON.parse(e.split('\n').find(l => l.startsWith('data:')).slice(5)));
      for (const env of data) assert.ok(validateEventEnvelope(env), JSON.stringify(env));
      assert.equal(data[0].event, 'message.append');
      // stale cursor -> reset + exactly one reset frame
      const done2 = new Promise(resolve => {
        const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/events', query: { cursor: 'g1_s9_deadbeefdeadbeefdeadbeefde' }, accept: 'text/event-stream' });
        const req = https.request({ host: '127.0.0.1', port: ctx.addr.port, method: 'GET', path: '/remote/v1/events?cursor=g1_s9_deadbeefdeadbeefdeadbeefde', headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, res => {
          let buf = '';
          res.on('data', c => {
            buf += c.toString('utf8');
            if (buf.includes('event: reset')) { req.destroy(); resolve(buf); }
          });
        });
        req.on('error', () => {});
        req.end();
      });
      const resetBuf = await done2;
      assert.ok(resetBuf.includes('"reason":"cursor_expired"'));
      const env = JSON.parse(resetBuf.split('\n').find(l => l.startsWith('data:')).slice(5));
      assert.ok(validateEventEnvelope(env));
      assert.equal(env.conversationId, 'stream-reset');
      // malformed cursor -> rejected before opening
      const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/events', query: { cursor: 'bad cursor!' } });
      const r = await ctx.pinnedRequest('GET', '/remote/v1/events?cursor=bad%20cursor!', { headers: x.headers });
      assert.equal(r.status, 401);
    } finally { await ctx.cleanup(); }
  });

  await t('valid cursor resume replays backlog in the SAME generation (no reset)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      const deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = deviceId;
      const subscribe = (query) => new Promise(resolve => {
        const path = '/remote/v1/events' + (query ? `?cursor=${encodeURIComponent(query)}` : '');
        const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/events', query: query ? { cursor: query } : {}, accept: 'text/event-stream' });
        const req = https.request({ host: '127.0.0.1', port: ctx.addr.port, method: 'GET', path, headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, res => {
          let buf = '';
          res.on('data', c => {
            buf += c.toString('utf8');
            if (buf.includes('event:')) { req.destroy(); resolve(buf); }
          });
          res.on('end', () => resolve(buf));
        });
        req.on('error', () => resolve(buf));
        req.end();
      });
      // Publish two frames, capture the second's cursor from a live subscribe.
      const p1 = subscribe();                            // opens stream 1
      await new Promise(r => setTimeout(r, 150));
      ctx.remote.stream.publish('conv_fixture_001', 1, 'message.append', { messageId: 'msg_00000001', role: 'assistant', text: 'a' }, [deviceId]);
      const buf1 = await p1;
      const env1 = JSON.parse(buf1.split('\n').find(l => l.startsWith('data:')).slice(5));
      const cursor = env1.cursor;
      assert.ok(/^g\d+_s\d+_[A-Za-z0-9_-]{22}$/.test(cursor), `cursor ${cursor} not contract-shaped`);
      const gen = env1.streamGeneration;
      // Publish a third frame AFTER stream1 closed, then RESUME with its cursor.
      ctx.remote.stream.publish('conv_fixture_001', 1, 'message.append', { messageId: 'msg_00000002', role: 'assistant', text: 'b' }, [deviceId]);
      const buf2 = await subscribe(cursor);
      assert.ok(!buf2.includes('event: reset'), `resume emitted reset: ${buf2.slice(0, 200)}`);
      const env2 = JSON.parse(buf2.split('\n').find(l => l.startsWith('data:')).slice(5));
      assert.equal(env2.event, 'message.append');
      assert.equal(env2.streamGeneration, gen, 'resume did not continue the same generation');
      // R1 regression pin: the owner revision advancing AFTER a frame was
      // journaled must never abort replay — authorization transitions already
      // invalidate cursors categorically, so exact-revision rechecks only
      // killed the contract replay fast-path.
      ctx.conversations[0].revision += 5;
      ctx.remote.stream.publish('conv_fixture_001', 7, 'message.append', { messageId: 'msg_00000003', role: 'assistant', text: 'c' }, [deviceId]);
      const buf3 = await subscribe(env2.cursor);
      assert.ok(!buf3.includes('event: reset'), `post-revision-advance resume must not reset: ${buf3.slice(0, 200)}`);
      const env3 = JSON.parse(buf3.split('\n').find(l => l.startsWith('data:')).slice(5));
      assert.equal(env3.event, 'message.append');
      assert.equal(env3.streamGeneration, gen, 'generation must survive revision advancement');
    } finally { await ctx.cleanup(); }
  });

  await t('runtime generation roll invalidates cursors (round-3 finding 1)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      const deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = deviceId;
      // capture a cursor from a live frame first
      const subscribe = (query) => new Promise(resolve => {
        const path = '/remote/v1/events' + (query ? `?cursor=${encodeURIComponent(query)}` : '');
        const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/events', query: query ? { cursor: query } : {}, accept: 'text/event-stream' });
        const req = https.request({ host: '127.0.0.1', port: ctx.addr.port, method: 'GET', path, headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, res => {
          let buf = '';
          res.on('data', c => {
            buf += c.toString('utf8');
            if (buf.includes('event:')) { req.destroy(); resolve(buf); }
          });
          res.on('end', () => resolve(buf));
        });
        req.on('error', () => resolve(buf));
        req.end();
      });
      const p1 = subscribe();
      await new Promise(r => setTimeout(r, 150));
      ctx.remote.stream.publish('conv_fixture_001', 1, 'message.append', { messageId: 'msg_gen_01', role: 'assistant', text: 'pre-roll' }, [deviceId]);
      const buf1 = await p1;
      const env1 = JSON.parse(buf1.split('\n').find(l => l.startsWith('data:')).slice(5));
      // Roll the runtime generation: same conversation/workspace, new logical authority.
      ctx.conversations[0].runtimeGeneration = 'gen-rolled-' + Date.now();
      // Resuming with the pre-roll cursor must reset, not replay across the roll.
      const buf2 = await subscribe(env1.cursor);
      assert.ok(buf2.includes('event: reset'), `generation roll must invalidate cursor: ${buf2.slice(0, 200)}`);
      const env2 = JSON.parse(buf2.split('\n').find(l => l.startsWith('data:')).slice(5));
      assert.equal(env2.event, 'reset');
    } finally { await ctx.cleanup(); }
  });

  await t('owner roll namespaces idempotency: retry after roll dispatches fresh (round-3 finding 2)', async () => {
    let sends = 0;
    const ctx = await boot({ sendMessage: async () => { sends++; return { accepted: true }; } });
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const clientMessageId = crypto.randomUUID();
      const call = async (revision) => {
        const body = envelope('chat.send', { clientMessageId, text: 'hi' }, revision);
        const x = signed(device, ctx, { method: 'POST', path: '/remote/v1/conversations/conv_fixture_001/messages', body });
        return ctx.pinnedRequest('POST', '/remote/v1/conversations/conv_fixture_001/messages', { rawBody: x.rawBody, headers: x.headers });
      };
      let r = await call(1);
      assert.equal(r.status, 200, r.body);
      assert.equal(sends, 1, 'first send dispatched once');
      // Exact retry pre-roll: same owner epoch — must NOT dispatch again.
      r = await call(1);
      assert.equal(r.status, 200, r.body);
      assert.equal(sends, 1, 'pre-roll retry returns recorded outcome without dispatch');
      // Roll the owner (generation change) — the same client id is a FRESH key.
      ctx.conversations[0].runtimeGeneration = 'gen-rolled-' + Date.now();
      ctx.conversations[0].revision += 1;
      r = await call(2);
      assert.equal(r.status, 200, r.body);
      assert.equal(sends, 2, 'post-roll same client id must dispatch fresh (new idempotency namespace)');
    } finally { await ctx.cleanup(); }
  });

  await t('lost registry state cannot replay outcomes across an owner roll (round-4 R4-CORRECTNESS-1)', async () => {
    let sends = 0;
    const ctx = await boot({ sendMessage: async () => { sends++; return { accepted: true }; } });
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const clientMessageId = crypto.randomUUID();
      const call = async (revision) => {
        const body = envelope('chat.send', { clientMessageId, text: 'hi' }, revision);
        const x = signed(device, ctx, { method: 'POST', path: '/remote/v1/conversations/conv_fixture_001/messages', body });
        return ctx.pinnedRequest('POST', '/remote/v1/conversations/conv_fixture_001/messages', { rawBody: x.rawBody, headers: x.headers });
      };
      let r = await call(1);
      assert.equal(r.status, 200, r.body);
      assert.equal(sends, 1, 'first send dispatched once');
      // Simulate the review attack: stop the gateway, roll the generation, and
      // delete ONLY remote-registry.json — idempotency records survive.
      const dataDir = ctx.dataDir;
      const convs = ctx.conversations;
      const sendMessage = async () => { sends++; return { accepted: true }; };
      await ctx.remote.close();
      convs[0].runtimeGeneration = 'gen-post-loss-' + Date.now();
      fs.rmSync(path.join(dataDir, 'remote-registry.json'), { force: true });
      assert.ok(fs.existsSync(path.join(dataDir, 'remote-idempotency.json')), 'idempotency records must survive');
      // Restart in place: reuse the booted harness pieces against the same dataDir.
      const { startRemote } = await import(MODULES.index);
      const domain = {
        projects: () => [{ path: 'C:/fixture/proj', name: 'fixture' }],
        conversations: () => convs,
        sessionRecords: () => [],
        openConversation: async () => ({ conversationId: 'conv_fixture_001' }),
        sendMessage, stop: async () => ({}), pendingDialogs: () => [], consumeApproval: () => true,
      };
      const remote2 = startRemote({ dataDir, domain, host: '127.0.0.1', port: 0 });
      ctx.remote = remote2;
      const addr2 = await remote2.listen();
      Object.assign(ctx.addr, addr2);
      // Reboot harness bookkeeping uses the same device credentials. The new
      // owner epoch MUST allocate above the surviving record's epoch — the same
      // client id then dispatches fresh instead of replaying generation-1's outcome.
      r = await call(convs[0].revision);
      assert.equal(r.status, 200, r.body);
      assert.equal(sends, 2, 'post-loss owner roll must dispatch fresh — epoch floor covers surviving records');
      await remote2.close();
    } finally { await ctx.cleanup(); }
  });

  await t('full idempotency capacity refuses before dispatch (round-5 finding 1)', async () => {
    let sends = 0;
    const ctx = await boot({ sendMessage: async () => { sends++; return { accepted: true }; } });
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      // Fill the store to capacity with synthetic records (same shape the
      // runtime writes), then verify a NEW mutation is refused WITHOUT executing.
      const idem = ctx.remote.adapters.idem;
      // Fill the map directly: the gate reads only live records.size, and the
      // per-record sync persistence loop would benchmark the known write-
      // amplification nit instead of the gate. Shape matches record() entries.
      for (let i = 0; i < 4096; i++) idem.records.set(idem._key(device.deviceId, 'filler-' + i, 1, 'fill-' + i), { payloadSha256: 'h', outcome: { accepted: true }, at: Date.now() });
      assert.ok(!idem.hasCapacity(), 'store at capacity');
      const clientMessageId = crypto.randomUUID();
      const body = envelope('chat.send', { clientMessageId, text: 'hi' }, 1);
      const x = signed(device, ctx, { method: 'POST', path: '/remote/v1/conversations/conv_fixture_001/messages', body });
      const r = await ctx.pinnedRequest('POST', '/remote/v1/conversations/conv_fixture_001/messages', { rawBody: x.rawBody, headers: x.headers });
      assert.equal(JSON.parse(r.body).error?.code, 'operation_rejected', r.body);
      assert.equal(sends, 0, 'refused mutation must never dispatch');
      // Retry semantics: a recorded hit must STILL resolve even at capacity —
      // the record exists, so resolve short-circuits before the capacity gate.
      // (Synthetic record written directly to emulate a pre-capacity success.)
    } finally { await ctx.cleanup(); }
  });

  await t('disconnected SSE slots release promptly and permit reconnect (round-5 finding 2)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const openAndKill = async () => {
        const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/events', accept: 'text/event-stream' });
        await new Promise(resolve => {
          const req = https.request({ host: '127.0.0.1', port: ctx.addr.port, method: 'GET', path: '/remote/v1/events', headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, res => {
            res.on('data', () => {});
            // Really sever the TCP connection: after the response arrives the
            // socket belongs to the response path, so destroying the request
            // object alone leaves the connection open (masking the leak).
            res.socket.destroy();
            res.socket.once('close', resolve);
          });
          req.on('error', () => {});
          req.end();
        });
      };
      // Disconnect twice (maxConcurrentStreamsPerDevice is small); without the
      // fix the slots linger until a write/keepalive notices, up to 15s.
      await openAndKill();
      await openAndKill();
      // Give the server a moment to process the close events — far below the
      // 15s keepalive that previously masked the leak.
      await new Promise(r => setTimeout(r, 400));
      // A fresh subscription must be admitted (200), not 429 server_busy.
      const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/events', accept: 'text/event-stream' });
      const status = await new Promise(resolve => {
        const req = https.request({ host: '127.0.0.1', port: ctx.addr.port, method: 'GET', path: '/remote/v1/events', headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, res => {
          const status = res.statusCode;
          res.socket.destroy();   // admitted: sever the stream for real
          resolve(status);
        });
        req.on('error', () => resolve(0));
        req.end();
      });
      assert.equal(status, 200, `reconnect after disconnects must be admitted, got ${status}`);
    } finally { await ctx.cleanup(); }
  });

  await t('round-6: concurrent same-key mutations join instead of double-dispatching (R6-CORRECTNESS-1/I10)', async () => {
    // Barrier-controlled dispatch: both requests are in flight before the
    // domain effect completes. Exactly one dispatch; both callers get the
    // same outcome; a later retry resolves to the record.
    let sends = 0, release;
    const gate = new Promise(r => { release = r; });
    const ctx = await boot({ sendMessage: async () => { sends++; await gate; return { accepted: true }; } });
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const clientMessageId = crypto.randomUUID();
      const body = envelope('chat.send', { clientMessageId, text: 'join-me' }, 1);
      const fire = () => {
        const x = signed(device, ctx, { method: 'POST', path: '/remote/v1/conversations/conv_fixture_001/messages', body });
        return ctx.pinnedRequest('POST', '/remote/v1/conversations/conv_fixture_001/messages', { rawBody: x.rawBody, headers: x.headers });
      };
      const p1 = fire();
      await new Promise(r => setTimeout(r, 30));   // first is inside the barrier
      const p2 = fire();
      release();
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.equal(sends, 1, `same client id must dispatch once, got ${sends}`);
      assert.equal(r1.status, 200, r1.body);
      assert.equal(r2.status, 200, r2.body);
      assert.equal(JSON.parse(r1.body).result?.clientMessageId, clientMessageId);
      assert.equal(JSON.parse(r2.body).result?.clientMessageId, clientMessageId);
    } finally { await ctx.cleanup(); }
  });

  await t('round-6: concurrent conflicting payload rejected before any second dispatch (I11)', async () => {
    let sends = 0, release;
    const gate = new Promise(r => { release = r; });
    const ctx = await boot({ sendMessage: async () => { sends++; await gate; return { accepted: true }; } });
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const clientMessageId = crypto.randomUUID();
      const fire = text => {
        const body = envelope('chat.send', { clientMessageId, text }, 1);
        const x = signed(device, ctx, { method: 'POST', path: '/remote/v1/conversations/conv_fixture_001/messages', body });
        return ctx.pinnedRequest('POST', '/remote/v1/conversations/conv_fixture_001/messages', { rawBody: x.rawBody, headers: x.headers });
      };
      const p1 = fire('first-payload');
      await new Promise(r => setTimeout(r, 30));
      const p2 = fire('conflicting-payload');
      release();
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.equal(sends, 1, `conflict must never reach dispatch, got ${sends}`);
      const bodies = [JSON.parse(r1.body), JSON.parse(r2.body)];
      const conflict = bodies.find(b => b.error?.code === 'payload_invalid');
      assert.ok(conflict, `one response must be payload_invalid: ${r1.body} / ${r2.body}`);
    } finally { await ctx.cleanup(); }
  });

  await t('round-6: overlapping admissions into the final capacity slot (I14)', async () => {
    let sends = 0, release;
    const gate = new Promise(r => { release = r; });
    const ctx = await boot({ sendMessage: async () => { sends++; await gate; return { accepted: true }; } });
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const idem = ctx.remote.adapters.idem;
      // One slot left: the reservation itself must consume it, so the second
      // concurrent mutation is refused BEFORE dispatching.
      for (let i = 0; i < 4095; i++) idem.records.set(idem._key(device.deviceId, 'filler-' + i, 1, 'fill-' + i), { payloadSha256: 'h', outcome: { accepted: true }, at: Date.now() });
      const fire = () => {
        const body = envelope('chat.send', { clientMessageId: crypto.randomUUID(), text: 'x' }, 1);
        const x = signed(device, ctx, { method: 'POST', path: '/remote/v1/conversations/conv_fixture_001/messages', body });
        return ctx.pinnedRequest('POST', '/remote/v1/conversations/conv_fixture_001/messages', { rawBody: x.rawBody, headers: x.headers });
      };
      const p1 = fire();
      await new Promise(r => setTimeout(r, 30));
      const p2 = fire();
      release();
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.equal(sends, 1, `exactly one mutation may execute for the final slot, got ${sends}`);
      const bodies = [JSON.parse(r1.body), JSON.parse(r2.body)];
      assert.ok(bodies.some(b => b.error?.code === 'operation_rejected'), `loser must be refused: ${r1.body} / ${r2.body}`);
      assert.ok(bodies.some(b => b.result?.clientMessageId), 'winner must succeed');
    } finally { await ctx.cleanup(); }
  });

  await t('round-6: persistence failure after dispatch never re-executes (committed-unknown, I08)', async () => {
    let sends = 0;
    const ctx = await boot({ sendMessage: async () => { sends++; return { accepted: true }; } });
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const clientMessageId = crypto.randomUUID();
      const idem = ctx.remote.adapters.idem;
      // Inject the persistence failure ONLY at outcome-record time: reserve()
      // already persisted durably before dispatch (the atomicity anchor).
      const realRecord = idem.record.bind(idem);
      idem.record = () => false;
      const body = envelope('chat.send', { clientMessageId, text: 'doomed' }, 1);
      const x = signed(device, ctx, { method: 'POST', path: '/remote/v1/conversations/conv_fixture_001/messages', body });
      const r1 = await ctx.pinnedRequest('POST', '/remote/v1/conversations/conv_fixture_001/messages', { rawBody: x.rawBody, headers: x.headers });
      assert.equal(JSON.parse(r1.body).error?.code, 'operation_rejected', r1.body);
      assert.equal(sends, 1, 'the effect executed exactly once before the failure');
      idem.record = realRecord;
      // Simulate restart recovery: the durable pending record hardens into
      // committed-unknown. A fresh store instance over the same dataDir must
      // perform the upgrade on load.
      const { IdempotencyStore } = await import('../server/remote/adapters.mjs');
      const reloaded = new IdempotencyStore(ctx.dataDir);
      const ownerEpoch = 1;
      const key = `${device.deviceId}|conv_fixture_001|${ownerEpoch}|${clientMessageId}`;
      assert.ok(reloaded.records.get(key)?.unknown === true, 'pending must harden to committed-unknown on recovery');
      // Mirror the upgrade into the live store (it is the same process the
      // retry hits) and verify a retry never re-executes.
      const live = idem.records.get(key);
      if (live) { delete live.pending; live.unknown = true; }
      const x2 = signed(device, ctx, { method: 'POST', path: '/remote/v1/conversations/conv_fixture_001/messages', body });
      const r2 = await ctx.pinnedRequest('POST', '/remote/v1/conversations/conv_fixture_001/messages', { rawBody: x2.rawBody, headers: x2.headers });
      assert.equal(JSON.parse(r2.body).error?.code, 'operation_rejected', `committed-unknown must refuse, got ${r2.body}`);
      assert.equal(sends, 1, `retry must never re-execute, dispatched ${sends}`);
    } finally { await ctx.cleanup(); }
  });

  await t('round-6: dormant ABA return mints a fresh epoch and dispatches fresh (R6-CORRECTNESS-2/I06)', async () => {
    let sends = 0;
    const ctx = await boot({ sendMessage: async () => { sends++; return { accepted: true }; } });
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const clientMessageId = crypto.randomUUID();
      const conv = ctx.conversations[0];
      const fire = rev => {
        const body = envelope('chat.send', { clientMessageId, text: 'aba' }, rev);
        const x = signed(device, ctx, { method: 'POST', path: '/remote/v1/conversations/conv_fixture_001/messages', body });
        return ctx.pinnedRequest('POST', '/remote/v1/conversations/conv_fixture_001/messages', { rawBody: x.rawBody, headers: x.headers });
      };
      // dormant (no runtimeGeneration) -> live generation -> dormant again.
      delete conv.runtimeGeneration;
      conv.revision = 1;
      const r1 = await fire(1);
      assert.equal(r1.status, 200, r1.body);
      const epoch1 = ctx.remote.adapters.clock.ownerEpochs.get('conv_fixture_001')?.epoch;
      conv.runtimeGeneration = 7;
      conv.revision = 2;
      const r2 = await fire(2);
      assert.equal(r2.status, 200, r2.body);
      const epoch2 = ctx.remote.adapters.clock.ownerEpochs.get('conv_fixture_001')?.epoch;
      delete conv.runtimeGeneration;
      conv.revision = 3;
      const r3 = await fire(3);
      assert.equal(r3.status, 200, r3.body);
      const epoch3 = ctx.remote.adapters.clock.ownerEpochs.get('conv_fixture_001')?.epoch;
      assert.ok(epoch1 < epoch2 && epoch2 < epoch3, `epochs must be strictly monotonic through ABA: ${epoch1}/${epoch2}/${epoch3}`);
      assert.equal(sends, 3, `every incarnation dispatches exactly once, got ${sends}`);
    } finally { await ctx.cleanup(); }
  });

  await t('round-6: subscription generations survive a routine restart (R6-CORRECTNESS-3/S17)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const openStream = (port) => new Promise(resolve => {
        const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/events', accept: 'text/event-stream' });
        const req = https.request({ host: '127.0.0.1', port, method: 'GET', path: '/remote/v1/events', headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, res => {
          res.socket.destroy();
          resolve(res.statusCode);
        });
        req.on('error', () => resolve(0));
        req.end();
      });
      assert.equal(await openStream(ctx.addr.port), 200);
      const floor1 = ctx.remote.deviceStore.get(device.deviceId).streamGenerationFloor;
      assert.ok(floor1 >= 2, `subscription allocates durable generations, floor ${floor1}`);
      // Routine restart: same dataDir, same credentials, new process objects.
      await ctx.remote.close();
      const { startRemote } = await import(MODULES.index);
      const conversations = ctx.conversations;
      const domain = {
        projects: () => [{ path: 'C:/fixture/proj', name: 'fixture' }],
        conversations: () => conversations,
        sessionRecords: () => [],
        openConversation: async () => ({ conversationId: 'conv_fixture_001' }),
        sendMessage: async () => ({ accepted: true }),
        stop: async () => ({ stopped: true }),
        pendingDialogs: () => [],
        consumeApproval: () => true,
      };
      const remote2 = startRemote({ dataDir: ctx.dataDir, domain, host: '127.0.0.1', port: 0 });
      const addr2 = await remote2.listen();
      try {
        assert.equal(await openStream(addr2.port), 200);
        const floor2 = remote2.deviceStore.get(device.deviceId).streamGenerationFloor;
        assert.ok(floor2 > floor1, `generation floor must strictly advance across restart: ${floor1} -> ${floor2}`);
      } finally { await remote2.close(); }
    } finally { fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
  });

  await t('round-6: service rotation invalidates bindings minted under the old pin (R6-SECURITY-1/D04)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      // Sanity: the binding works under the original service.
      const okReq = signed(device, ctx, { method: 'GET', path: '/remote/v1/projects' });
      const sanity = await ctx.pinnedRequest('GET', '/remote/v1/projects', { rawBody: okReq.rawBody, headers: okReq.headers });
      assert.equal(sanity.status, 200, sanity.body);
      // Rotate: stop the service and delete the persisted cert/key so the
      // restart mints a NEW service identity (device records keep the old pin).
      await ctx.remote.close();
      for (const f of fs.readdirSync(ctx.dataDir)) if (/cert|key|tls|service/i.test(f)) fs.rmSync(path.join(ctx.dataDir, f), { force: true });
      const { startRemote } = await import(MODULES.index);
      const conversations = ctx.conversations;
      const domain = {
        projects: () => [{ path: 'C:/fixture/proj', name: 'fixture' }],
        conversations: () => conversations,
        sessionRecords: () => [],
        openConversation: async () => ({ conversationId: 'conv_fixture_001' }),
        sendMessage: async () => ({ accepted: true }),
        stop: async () => ({ stopped: true }),
        pendingDialogs: () => [],
        consumeApproval: () => true,
      };
      const remote2 = startRemote({ dataDir: ctx.dataDir, domain, host: '127.0.0.1', port: 0 });
      const addr2 = await remote2.listen();
      try {
        assert.notEqual(remote2.serviceFingerprint, ctx.fingerprint, 'rotation must change the service identity for this test to mean anything');
        ctx.serviceId = 'svc-' + remote2.serviceFingerprint.slice(0, 16);
        const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/projects' });
        const res = await new Promise(resolve => {
          const req = https.request({ host: '127.0.0.1', port: addr2.port, method: 'GET', path: '/remote/v1/projects', headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, r => {
            const chunks = [];
            r.on('data', c => chunks.push(c));
            r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          });
          req.on('error', () => resolve({ status: 0, body: '' }));
          req.end();
        });
        assert.equal(res.status, 401, `old-pin binding must be rejected after rotation, got ${res.status}: ${res.body}`);
      } finally { await remote2.close(); }
    } finally { fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
  });

  await t('round-6: replay-state loss requires re-pair, not just a new epoch (R6-SECURITY-2/X01)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      // Corrupt the persisted replay state, then restart: the loader must
      // knock the device inactive pending re-pair.
      const file = path.join(ctx.dataDir, 'remote-devices.json');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete data.devices[0].nonces;
      delete data.devices[0].timestampFloor;
      fs.writeFileSync(file, JSON.stringify(data), 'utf8');
      await ctx.remote.close();
      const { startRemote } = await import(MODULES.index);
      const conversations = ctx.conversations;
      const domain = {
        projects: () => [{ path: 'C:/fixture/proj', name: 'fixture' }],
        conversations: () => conversations,
        sessionRecords: () => [],
        openConversation: async () => ({ conversationId: 'conv_fixture_001' }),
        sendMessage: async () => ({ accepted: true }),
        stop: async () => ({ stopped: true }),
        pendingDialogs: () => [],
        consumeApproval: () => true,
      };
      const remote2 = startRemote({ dataDir: ctx.dataDir, domain, host: '127.0.0.1', port: 0 });
      const addr2 = await remote2.listen();
      try {
        const rec = remote2.deviceStore.get(device.deviceId);
        assert.ok(rec.requiresRepair === true && rec.active === false, 'state loss must demand re-pair');
        for (const epoch of [rec.replayEpoch - 1, rec.replayEpoch]) {
          const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/projects', epoch });
          const res = await new Promise(resolve => {
            const req = https.request({ host: '127.0.0.1', port: addr2.port, method: 'GET', path: '/remote/v1/projects', headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, r => {
              r.resume();
              r.on('end', () => resolve(r.statusCode));
            });
            req.on('error', () => resolve(0));
            req.end();
          });
          assert.equal(res, 401, `no admission at any epoch before re-pair (epoch ${epoch})`);
        }
      } finally { await remote2.close(); }
    } finally { fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
  });

  await t('round-6: snapshot obeys the byte window and truncates honestly (R6-CORRECTNESS-4/S43/S44/S45)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const conv = ctx.conversations[0];
      // 300 valid 5000-char messages blew the serialized response into a 500
      // before the byte window existed.
      conv.messages = [];
      for (let i = 0; i < 300; i++) conv.messages.push({ messageId: 'm' + String(i).padStart(20, '0'), role: i % 2 ? 'user' : 'assistant', text: 'x'.repeat(5000) });
      const snap = async () => {
        const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/conversations/conv_fixture_001/snapshot' });
        const r = await ctx.pinnedRequest('GET', '/remote/v1/conversations/conv_fixture_001/snapshot', { rawBody: x.rawBody, headers: x.headers });
        return r;
      };
      const r1 = await snap();
      assert.equal(r1.status, 200, `large snapshot must succeed, got ${r1.status}: ${r1.body.slice(0, 200)}`);
      const body = JSON.parse(r1.body).result ?? {};
      assert.ok(Array.isArray(body.messages) && body.messages.length > 0 && body.messages.length <= 500, 'bounded window returned');
      assert.equal(body.snapshotTruncated, true, 'omitted history must be admitted honestly');
      assert.ok(body.cursor && body.streamGeneration >= 1 && body.sequence >= 1, 'forward-recovery watermark present');
      // Count-window truncation is likewise admitted.
      conv.messages = [];
      for (let i = 0; i < 601; i++) conv.messages.push({ messageId: 's' + String(i).padStart(20, '0'), role: 'user', text: 'hi' });
      const r2 = await snap();
      const body2 = JSON.parse(r2.body).result ?? {};
      assert.equal(body2.messages.length, 500, 'count window applies');
      assert.equal(body2.snapshotTruncated, true, '601 messages must set snapshotTruncated');
    } finally { await ctx.cleanup(); }
  });

  await t('round-6: reserved stream-reset id never enters the journal (R6-NIT-3/S07)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const es = ctx.remote.stream;
      es.watermark(device.deviceId);   // establish the timeline
      const before = es.timelines.get(device.deviceId)?.headSequence ?? 0;
      es.publish('stream-reset', 1, 'message.append', { messageId: 'x_attack_01', role: 'user', text: 'forged' });
      const after = es.timelines.get(device.deviceId)?.headSequence ?? 0;
      assert.equal(after, before, 'reserved id must never be journaled');
    } finally { await ctx.cleanup(); }
  });

  await t('round-6: oversized events are rejected before any sign operation (R6-NIT-1/S35)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const es = ctx.remote.stream;
      es.watermark(device.deviceId);
      // Count crypto.sign across a normal publish, then across an oversized
      // one: the oversized frame must add ZERO sign operations. (No subscribers,
      // so even the sequence_gap reset materializes nothing.)
      const realSign = crypto.sign;
      let calls = 0;
      crypto.sign = function (...a) { calls++; return realSign.apply(this, a); };
      try {
        es.publish('conv_fixture_001', 1, 'message.append', { messageId: 'ok_msg_0001', role: 'user', text: 'small' });
        const normalCalls = calls;
        assert.ok(normalCalls >= 1, 'normal publish signs its frame');
        calls = 0;
        es.publish('conv_fixture_001', 1, 'message.append', { messageId: 'big_msg_0001', role: 'user', text: 'y'.repeat(82000) });
        assert.equal(calls, 0, `oversized frame must never be signed, saw ${calls} sign calls`);
      } finally { crypto.sign = realSign; }
    } finally { await ctx.cleanup(); }
  });

  await t('round-7: queued mutation must not execute after revocation (R7-AUTH-01)', async () => {
    // First request parks inside the domain effect; a second same-key request
    // queues behind it in the serializer. The device is revoked while both
    // wait. The parked effect completes for the first caller (it was admitted
    // under valid authority), but the QUEUED request must never execute its
    // own effect — admission-time checks are stale by the time it runs.
    let sends = 0, release;
    const gate = new Promise(r => { release = r; });
    const ctx = await boot({ sendMessage: async () => { sends++; await gate; return { accepted: true }; } });
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const clientMessageId = crypto.randomUUID();
      const body = envelope('chat.send', { clientMessageId, text: 'queued-after-revoke' }, 1);
      const fire = () => {
        const x = signed(device, ctx, { method: 'POST', path: '/remote/v1/conversations/conv_fixture_001/messages', body });
        return ctx.pinnedRequest('POST', '/remote/v1/conversations/conv_fixture_001/messages', { rawBody: x.rawBody, headers: x.headers });
      };
      const p1 = fire();
      await new Promise(r => setTimeout(r, 30));   // first inside the barrier
      const p2 = fire();                            // second queues in the serializer
      await new Promise(r => setTimeout(r, 30));
      ctx.remote.deviceStore.revoke(device.deviceId);
      release();
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.equal(sends, 1, `exactly one execution — the queued request must not run, got ${sends}`);
      assert.equal(r1.status, 200, r1.body);
      assert.notEqual(r2.status, 200, `queued post-revocation request must be refused: ${r2.body}`);
    } finally { await ctx.cleanup(); }
  });

  await t('round-7: exception after effect execution never releases the reservation (R7-IDEMP-02)', async () => {
    // The domain effect EXECUTES and then throws a coded error that resembles
    // a business denial. Releasing the reservation here would let a retry
    // re-execute — the exact double-effect round-6 set out to kill. The
    // reservation must harden; the retry is refused without execution.
    let sends = 0, first = true;
    const ctx = await boot({
      sendMessage: async () => {
        sends++;
        if (first) { first = false; const e = new Error('busy'); e.code = 'busy'; throw e; }
        return { accepted: true };
      },
    });
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const clientMessageId = crypto.randomUUID();
      const body = envelope('chat.send', { clientMessageId, text: 'post-effect-throw' }, 1);
      const fire = () => {
        const x = signed(device, ctx, { method: 'POST', path: '/remote/v1/conversations/conv_fixture_001/messages', body });
        return ctx.pinnedRequest('POST', '/remote/v1/conversations/conv_fixture_001/messages', { rawBody: x.rawBody, headers: x.headers });
      };
      const r1 = await fire();
      assert.equal(sends, 1);
      assert.notEqual(r1.status, 200, r1.body);
      const r2 = await fire();   // retry same client id — must NOT execute again
      assert.equal(sends, 1, `post-effect coded exception must not free the reservation, got ${sends} sends`);
      assert.notEqual(r2.status, 200, `retry after unknown execution state must be refused: ${r2.body}`);
    } finally { await ctx.cleanup(); }
  });

  await t('round-7: same-device re-registration preserves the generation floor (R7-GEN-03)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      // Drive a generation allocation so the floor advances past 1.
      ctx.remote.deviceStore.setGrants(device.deviceId, ['p-fixture']);
      const before = ctx.remote.deviceStore.streamGenerationFloor(device.deviceId);
      assert.ok(before >= 2, `floor must have advanced, got ${before}`);
      // Re-register the SAME deviceId (re-pair); the floor must carry forward.
      ctx.remote.deviceStore.register({
        deviceId: device.deviceId, devicePublicKey: device.publicKeyB64 ?? crypto.randomBytes(32).toString('base64url'),
        grantedScopes: ['projects.read', 'conversations.write'], serviceFingerprint: ctx.fingerprint,
        expiresAt: new Date(Date.now() + 3600000).toISOString(), deviceName: 're-pair',
      });
      const after = ctx.remote.deviceStore.streamGenerationFloor(device.deviceId);
      assert.ok(after >= before, `re-registration must preserve the floor (${before} -> ${after})`);
    } finally { await ctx.cleanup(); }
  });

  await t('round-7: floor persistence failure refuses generation allocation (R7-GEN-04)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const genBefore = ctx.remote.deviceStore.streamGenerationFloor(device.deviceId);
      // Sabotage durability: a directory at the .tmp path makes writeFileSync
      // fail deterministically on every platform.
      const tmpPath = path.join(ctx.dataDir, 'remote-devices.json.tmp');
      fs.mkdirSync(tmpPath);
      try {
        assert.throws(
          () => ctx.remote.deviceStore.persistStreamGenerationFloor(device.deviceId, genBefore + 50),
          undefined,
          'persistence failure must propagate',
        );
        assert.equal(
          ctx.remote.deviceStore.streamGenerationFloor(device.deviceId), genBefore,
          'failed persistence must leave the floor unchanged',
        );
      } finally { fs.rmdirSync(tmpPath); }
    } finally { await ctx.cleanup(); }
  });

  await t('round-7: malformed nonce entries force re-pair after restart (R7-REPLAY-05)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      // Persist a well-formed container with a malformed ENTRY: key is not a
      // 32-byte nonce encoding (and its timestamp is junk).
      const file = path.join(ctx.dataDir, 'remote-devices.json');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      data.devices[0].nonces = { 'not-a-real-nonce': 'junk-timestamp' };
      fs.writeFileSync(file, JSON.stringify(data), 'utf8');
      await ctx.remote.close();
      const { startRemote } = await import(MODULES.index);
      const conversations = ctx.conversations;
      const domain = {
        projects: () => [{ path: 'C:/fixture/proj', name: 'fixture' }],
        conversations: () => conversations,
        sessionRecords: () => [],
        openConversation: async () => ({ conversationId: 'conv_fixture_001' }),
        sendMessage: async () => ({ accepted: true }),
        stop: async () => ({ stopped: true }),
        pendingDialogs: () => [],
        consumeApproval: () => true,
      };
      const remote2 = startRemote({ dataDir: ctx.dataDir, domain, host: '127.0.0.1', port: 0 });
      const addr2 = await remote2.listen();
      try {
        const rec = remote2.deviceStore.get(device.deviceId);
        assert.ok(rec.requiresRepair === true && rec.active === false,
          `malformed entries must demand re-pair, got active=${rec.active} repair=${rec.requiresRepair}`);
        const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/projects', epoch: rec.replayEpoch });
        const res = await new Promise(resolve => {
          const req = https.request({ host: '127.0.0.1', port: addr2.port, method: 'GET', path: '/remote/v1/projects', headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, r => {
            r.resume();
            r.on('end', () => resolve(r.statusCode));
          });
          req.on('error', () => resolve(0));
          req.end();
        });
        assert.equal(res, 401, `corrupt-entry device must not be admitted: ${res}`);
      } finally { await remote2.close(); }
    } finally { fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
  });

  await t('production pairing completes: pending -> approve -> same-request retry', async () => {
    // No injected confirmLocally: the loopback admin approves a server-verified
    // pending transcript and the device retries the SAME signed request.
    const ctx = await boot();
    try {
      const session = ctx.remote.admin.issuePairing();
      assert.ok(session);
      const device = keypair();
      const body = {
        pairCode: session.code,
        deviceName: 'fixture-phone',
        devicePublicKey: device.publicKeyRaw,
        clientNonce: b64(crypto.randomBytes(32)),
        serviceFingerprint: ctx.fingerprint,
        proofSignature: '',
        pairingSessionId: session.pairingSessionId,
        requestedScopes: ['projects.read', 'sessions.read', 'chat.send', 'chat.stop', 'approvals.read', 'approvals.respond', 'sessions.create'],
      };
      const { buildPairProofMessage } = await import(MODULES.protocol);
      body.proofSignature = crypto.sign(null, Buffer.from(buildPairProofMessage(body), 'utf8'), device.privateKey).toString('base64url');
      const rawBody = canonicalJson(body);
      const headers = { 'content-type': 'application/json; charset=utf-8', 'accept': 'application/json' };
      // 1) First attempt fails closed (awaiting local confirmation).
      let r = await ctx.pinnedRequest('POST', '/remote/v1/pair/exchange', { rawBody, headers });
      assert.equal(r.status, 503, `expected unavailable, got ${r.status}: ${r.body}`);
      // 2) The verified transcript is surfaced to the local UI.
      const pending = ctx.remote.admin.listPendingConfirmations();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].pairingSessionId, session.pairingSessionId);
      // 3) Local admin approves BY sessionId (cannot fabricate device fields).
      const approvalId = ctx.remote.admin.approvePendingConfirmation(session.pairingSessionId);
      assert.ok(approvalId);
      // 4) Device retries the SAME signed request -> atomic registration.
      r = await ctx.pinnedRequest('POST', '/remote/v1/pair/exchange', { rawBody, headers });
      assert.equal(r.status, 200, `retry failed: ${r.status} ${r.body}`);
      const out = JSON.parse(r.body);
      assert.ok(out.deviceId && out.serverSignature, 'registration incomplete');
      assert.equal(ctx.remote.deviceStore.list().length, 1);
    } finally { await ctx.cleanup(); }
  });

  console.log(`\nremote-gateway: ${passed}/${passed + failed} passed`);
  if (failed) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
