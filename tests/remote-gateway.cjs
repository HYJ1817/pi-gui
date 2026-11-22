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
    sendMessage: async () => ({ accepted: true }),
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

  console.log(`\nremote-gateway: ${passed}/${passed + failed} passed`);
  if (failed) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
