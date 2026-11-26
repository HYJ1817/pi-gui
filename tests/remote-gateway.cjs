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
  deviceStore: '../server/remote/device-store.mjs',
};

async function boot(overrides = {}) {
  const { startRemote } = await import(MODULES.index);
  const { REMOTE_V1 } = await import(MODULES.protocol);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-gw-'));
  // Synthetic domain fixture: one project, one live runtime conversation.
  const projects = [{ path: 'C:/fixture/proj', name: 'fixture' }];
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
    projects: overrides.projects ?? (() => projects),
    conversations: () => conversations,
    sessionRecords: p => [{ sessionId: 'sess_fixture_001', displayName: 'fixture session', updatedAt: '2026-01-01T00:00:00Z', conversationIds: ['conv_fixture_001'] }],
    openConversation: overrides.openConversation ?? (async () => ({ conversationId: 'conv_fixture_001' })),
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
    log: overrides.log ?? (() => {}),
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
  return { remote, addr, fingerprint, request, pinnedRequest, dataDir, REMOTE_V1, conversations, projects,
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
      {
        const rv = ctx.remote.admin.revokeDevice(deviceId);
        assert.equal(rv && rv.revoked, true, 'revokeDevice returns a revocation result object');
        assert.equal(rv.durable, true, 'unfaulted revocation is durable via tombstone+main channels');
      }
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

  await t('round-8: floor-persistence failure closes every stream even when resets cannot sign (R8-GEN-01)', async () => {
    // A REAL live subscriber: sabotage durability, then drop the device while
    // every reset's generation allocation is guaranteed to fail. The close
    // guarantee must not depend on signing the reset — the stream must end
    // even though no reset frame could ever be written.
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      // Open a live SSE subscription and keep it open.
      const streamState = { status: 0, ended: false };
      const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/events', accept: 'text/event-stream' });
      const sse = await new Promise((resolve, reject) => {
        const req = https.request({ host: '127.0.0.1', port: ctx.addr.port, method: 'GET', path: '/remote/v1/events', headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, res => {
          streamState.status = res.statusCode;
          res.on('end', () => { streamState.ended = true; });
          res.on('close', () => { streamState.ended = true; });
          res.resume();   // paused-mode responses never emit end/close — must consume
          resolve(res);
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(streamState.status, 200, 'subscription established');
      assert.equal(streamState.ended, false, 'stream is live');
      const tmpPath = path.join(ctx.dataDir, 'remote-devices.json.tmp');
      fs.mkdirSync(tmpPath);   // durability sabotage: every allocation now fails
      try {
        try { ctx.remote.stream.dropDevice(device.deviceId); } catch { /* surfacing the durability error is acceptable — closing is the invariant */ }
        // The stream must end promptly even though its reset could not sign.
        const deadline = Date.now() + 3000;
        while (!streamState.ended && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
        assert.equal(streamState.ended, true, 'live stream must close even when its reset cannot be signed');
        assert.equal(ctx.remote.stream.subscribers.get(device.deviceId)?.size ?? 0, 0, 'no subscriber may survive a drop');
        assert.ok(!ctx.remote.stream.timelines.has(device.deviceId), 'timeline must be torn down');
      } finally {
        fs.rmdirSync(tmpPath);
        try { sse.destroy(); } catch {}
      }
    } finally { await ctx.cleanup(); }
  });

  await t('round-8: non-canonical nonce aliases force re-pair after restart (R8-REPLAY-02)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      // Build a canonical nonce and its trailing-bit alias (same 32 bytes,
      // non-canonical encoding: last char's unused low bit flipped).
      const canonical = crypto.randomBytes(32).toString('base64url');
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const last = canonical[canonical.length - 1];
      const alias = canonical.slice(0, -1) + chars[chars.indexOf(last) + 1];
      assert.notEqual(alias, canonical);
      assert.ok(Buffer.from(alias, 'base64url').equals(Buffer.from(canonical, 'base64url')), 'alias decodes to the same bytes');
      const file = path.join(ctx.dataDir, 'remote-devices.json');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      data.devices[0].nonces = { [alias]: Date.now() };
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
      try {
        const rec = remote2.deviceStore.get(device.deviceId);
        assert.ok(rec.requiresRepair === true && rec.active === false,
          `aliased nonce entries must demand re-pair, got active=${rec.active} repair=${rec.requiresRepair}`);
      } finally { await remote2.close(); }
    } finally { fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
  });

  await t('round-8: outcome persistence failure never leaves a replayable success (R8-IDEMP-03)', async () => {
    // The domain effect executes while persistence is sabotaged mid-flight.
    // Memory must describe disk: the same-process retry is refused even after
    // the obstruction is removed — no forged success may become replayable.
    let effects = 0;
    let ctx2;
    const ctx = await boot({
      sendMessage: async () => {
        effects++;
        fs.mkdirSync(path.join(ctx.dataDir, 'remote-idempotency.json.tmp'));
        return { accepted: true };
      },
    });
    ctx2 = ctx;
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const clientMessageId = crypto.randomUUID();
      const body = envelope('chat.send', { clientMessageId, text: 'record-persist-fail' }, 1);
      const fire = () => {
        const x = signed(device, ctx, { method: 'POST', path: '/remote/v1/conversations/conv_fixture_001/messages', body });
        return ctx.pinnedRequest('POST', '/remote/v1/conversations/conv_fixture_001/messages', { rawBody: x.rawBody, headers: x.headers });
      };
      const r1 = await fire();
      assert.equal(effects, 1);
      assert.notEqual(r1.status, 200, `undurable outcome must not be reported as success: ${r1.body}`);
      fs.rmdirSync(path.join(ctx.dataDir, 'remote-idempotency.json.tmp'));
      const r2 = await fire();   // same-id retry after obstruction removed
      assert.equal(effects, 1, `retry must never re-execute, got ${effects}`);
      assert.notEqual(r2.status, 200, `undurable success must not be replayable: status ${r2.status}`);
    } finally { await ctx.cleanup(); }
  });

  await t('round-8: initial timeline floor must persist before the generation is usable (R8-GEN-04)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const tmpPath = path.join(ctx.dataDir, 'remote-devices.json.tmp');
      fs.mkdirSync(tmpPath);
      try {
        // Force initial timeline creation while durability is impossible.
        assert.throws(() => ctx.remote.stream.watermark(device.deviceId), undefined, 'undurable initial generation must throw');
        assert.throws(() => ctx.remote.stream.watermark(device.deviceId), undefined, 'a failed initialization must not be cached — every attempt retries honestly');
      } finally { fs.rmdirSync(tmpPath); }
      const wm = ctx.remote.stream.watermark(device.deviceId);
      const floor = ctx.remote.deviceStore.streamGenerationFloor(device.deviceId);
      assert.ok(wm.generation <= floor, `published generation ${wm.generation} must be backed by durable floor ${floor}`);
    } finally { await ctx.cleanup(); }
  });

  await t('round-8: queued mutation must not execute after project substitution (R8-AUTH-05)', async () => {
    // Admission binds project A. While the first effect is parked, the
    // conversation moves to project B (workspace cwd changes) and grants move
    // with it. Identity+epoch still match — only the project comparison
    // catches the substitution.
    let sends = 0, release;
    const gate = new Promise(r => { release = r; });
    const ctx = await boot({ sendMessage: async () => { sends++; await gate; return { accepted: true }; } });
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const projB = 'C:/fixture/projB';
      const pidB = 'p-' + crypto.createHash('sha256').update(projB).digest('base64url').slice(0, 22);
      const clientMessageId = crypto.randomUUID();
      const body = envelope('chat.send', { clientMessageId, text: 'project-substitution' }, 1);
      const fire = () => {
        const x = signed(device, ctx, { method: 'POST', path: '/remote/v1/conversations/conv_fixture_001/messages', body });
        return ctx.pinnedRequest('POST', '/remote/v1/conversations/conv_fixture_001/messages', { rawBody: x.rawBody, headers: x.headers });
      };
      const p1 = fire();
      await new Promise(r => setTimeout(r, 30));
      const p2 = fire();   // queues in the serializer
      await new Promise(r => setTimeout(r, 30));
      // Move the conversation to project B and shift the grants — the domain
      // project list must contain B for the move to resolve at all.
      ctx.projects.push({ path: projB, name: 'fixture-b' });
      ctx.conversations[0].workspace.cwd = projB;
      ctx.remote.deviceStore.setGrants(device.deviceId, [pidB]);
      release();
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.equal(sends, 1, `exactly one execution — the queued request must not run under the substituted project, got ${sends}`);
      assert.notEqual(r2.status, 200, `queued post-substitution request must be refused: ${r2.body}`);
    } finally { await ctx.cleanup(); }
  });

  await t('round-9: per-subscriber reset failure closes that stream instead of silent stale delivery (R9-GEN-01)', async () => {
    // Controlled failure injection: the SHARED reset allocation succeeds but
    // the SECOND per-subscriber reset allocation fails. Every stream must
    // either receive a valid reset in the new generation or END — silent
    // continuation in the pre-reset generation is the defect.
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const openStream = () => new Promise((resolve, reject) => {
        const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/events', accept: 'text/event-stream' });
        const state = { status: 0, ended: false, bytes: 0 };
        const req = https.request({ host: '127.0.0.1', port: ctx.addr.port, method: 'GET', path: '/remote/v1/events', headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, res => {
          state.status = res.statusCode;
          res.on('data', c => { state.bytes += c.length; });
          res.on('end', () => { state.ended = true; });
          res.on('close', () => { state.ended = true; });
          res.resume();
          resolve({ res, state });
        });
        req.on('error', reject);
        req.end();
      });
      const s1 = await openStream();
      const s2 = await openStream();
      assert.equal(s1.state.status, 200);
      assert.equal(s2.state.status, 200);
      // Count-controlled sabotage: subscriptions already consumed some floor
      // writes. Fail exactly after ONE further successful write — the shared
      // reset allocation — so subscriber reset allocations fail.
      const store = ctx.remote.deviceStore;
      const orig = store.persistStreamGenerationFloor.bind(store);
      let calls = 0;
      store.persistStreamGenerationFloor = (id, floor) => {
        calls++;
        if (calls > 1) { const e = new Error('injected EIO'); e.code = 'EIO'; throw e; }
        return orig(id, floor);
      };
      try {
        try { ctx.remote.stream.resetDevice(device.deviceId, 'owner_changed'); } catch { /* surfacing is acceptable */ }
        const deadline = Date.now() + 3000;
        while ((!s1.state.ended || !s2.state.ended) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
        // Invariant: no stream may remain open but un-reset. A stream that got
        // its valid reset stays open (legitimate); a stream whose reset failed
        // must have ended. At least one stream must show the defect-controlled
        // outcome: with calls>1 failing, later subscribers cannot reset.
        const open = [s1, s2].filter(s => !s.state.ended);
        const ended = [s1, s2].filter(s => s.state.ended);
        assert.ok(ended.length >= 1, `at least one stream must close when its reset cannot be signed (ended=${ended.length}, open=${open.length})`);
        // Any stream still open must have received reset bytes in the new generation.
        for (const s of open) assert.ok(s.state.bytes > 0, 'an open survivor must carry its signed reset bytes');
      } finally {
        store.persistStreamGenerationFloor = orig;
        try { s1.res.destroy(); } catch {}
        try { s2.res.destroy(); } catch {}
      }
    } finally { await ctx.cleanup(); }
  });

  await t('round-9: fresh-subscription allocation failure answers an error and retains nothing (R9-GEN-02)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      // Timeline exists; sabotage makes the subscription-generation write fail.
      ctx.remote.stream.watermark(device.deviceId);
      const store = ctx.remote.deviceStore;
      const orig = store.persistStreamGenerationFloor.bind(store);
      store.persistStreamGenerationFloor = () => { const e = new Error('injected EIO'); e.code = 'EIO'; throw e; };
      try {
        const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/events', accept: 'text/event-stream' });
        const outcome = await new Promise(resolve => {
          const chunks = [];
          let settled = false;
          const done = o => { if (!settled) { settled = true; resolve(o); } };
          const req = https.request({ host: '127.0.0.1', port: ctx.addr.port, method: 'GET', path: '/remote/v1/events', headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, res => {
            res.on('data', c => chunks.push(c));
            res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
            res.on('close', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), closed: true }));
            res.resume();
          });
          req.on('error', () => done({ status: 0, body: 'socket-error' }));
          req.setTimeout(4000, () => { req.destroy(); done({ status: -1, body: 'timeout-no-response' }); });
          req.end();
        });
        assert.notEqual(outcome.status, -1, `a response or termination is required, never a hang: ${JSON.stringify(outcome)}`);
        assert.notEqual(outcome.status, 200, `no half-open 200 may be constructed: ${outcome.status}`);
        // Immediate check — no grace period: the subscriber registry must be clean.
        assert.equal(ctx.remote.stream.subscribers.get(device.deviceId)?.size ?? 0, 0, 'no subscriber may survive a failed allocation');
      } finally { store.persistStreamGenerationFloor = orig; }
    } finally { await ctx.cleanup(); }
  });


  await t('round-9: reserved stream-reset is never accepted as a create result (R9-CREATE-01)', async () => {
    // Domain fault injection: openConversation returns the reserved journal
    // identifier. The create must be refused as unknown execution state; the
    // same-id retry must never replay a fabricated success.
    const ctx = await boot({ openConversation: async () => ({ conversationId: 'stream-reset' }) });
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const pid = 'p-' + crypto.createHash('sha256').update('C:/fixture/proj').digest('base64url').slice(0, 22);
      const clientConversationId = crypto.randomUUID();
      const body = envelope('runtime.create', { clientConversationId }, 1);
      const fire = () => {
        const x = signed(device, ctx, { method: 'POST', path: `/remote/v1/projects/${pid}/conversations`, body });
        return ctx.pinnedRequest('POST', `/remote/v1/projects/${pid}/conversations`, { rawBody: x.rawBody, headers: x.headers });
      };
      const r1 = await fire();
      assert.notEqual(r1.status, 200, `reserved identifier must not be accepted: ${r1.body}`);
      const r2 = await fire();
      assert.notEqual(r2.status, 200, `retry must not replay a fabricated success: ${r2.body}`);
      assert.ok(!r2.body.includes('stream-reset') || JSON.parse(r2.body).error, `no success-shaped replay: ${r2.body}`);
    } finally { await ctx.cleanup(); }
  });

  await t('round-10: reset-materialization failure closes the stream instead of silent continuation (R10-GEN-01)', async () => {
    // A reset frame that cannot materialize (oversized reason exceeds the
    // frame budget) makes _resetOne return FALSE without throwing. The stream
    // must close — continuing open delivered the next ordinary frame in a
    // stale generation with no reset at all.
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const state = { status: 0, ended: false };
      await new Promise((resolve, reject) => {
        const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/events', accept: 'text/event-stream' });
        const req = https.request({ host: '127.0.0.1', port: ctx.addr.port, method: 'GET', path: '/remote/v1/events', headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, res => {
          state.status = res.statusCode;
          state.res = res;
          res.on('end', () => { state.ended = true; });
          res.on('close', () => { state.ended = true; });
          res.resume();
          resolve();
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(state.status, 200);
      // Oversized reason: the reset frame exceeds maxEventFrameBytes so
      // materialization returns null -> _resetOne false (no throw).
      try { ctx.remote.stream.resetDevice(device.deviceId, 'x'.repeat(70000)); } catch { /* surfacing acceptable */ }
      const deadline = Date.now() + 3000;
      while (!state.ended && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
      assert.equal(state.ended, true, 'a stream whose reset cannot materialize must close, never silently continue');
      try { state.res.destroy(); } catch {}
    } finally { await ctx.cleanup(); }
  });

  await t('round-10: fresh-subscription initial-timeline failure answers correlated 503, never zero-id 500 (R10-SUBSCRIBE-01)', async () => {
    // Fresh device (no timeline yet): floor persistence sabotaged. The
    // exception must be absorbed inside handleSubscribe into a correlated
    // 503 — a 500 with the zero requestId violates the contract, which
    // reserves the zero sentinel for pre-auth unauthorized errors.
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      // No watermark call — this device's timeline has never been initialized.
      const store = ctx.remote.deviceStore;
      const orig = store.persistStreamGenerationFloor.bind(store);
      store.persistStreamGenerationFloor = () => { const e = new Error('injected EIO'); e.code = 'EIO'; throw e; };
      try {
        const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/events', accept: 'text/event-stream' });
        const outcome = await new Promise(resolve => {
          const chunks = [];
          let settled = false;
          const done = o => { if (!settled) { settled = true; resolve(o); } };
          const req = https.request({ host: '127.0.0.1', port: ctx.addr.port, method: 'GET', path: '/remote/v1/events', headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, res => {
            res.on('data', c => chunks.push(c));
            res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
            res.on('close', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), closed: true }));
            res.resume();
          });
          req.on('error', () => done({ status: 0, body: 'socket-error' }));
          req.setTimeout(4000, () => { req.destroy(); done({ status: -1, body: 'timeout-no-response' }); });
          req.end();
        });
        assert.notEqual(outcome.status, -1, `a response or termination is required: ${JSON.stringify(outcome)}`);
        assert.notEqual(outcome.status, 200, `no half-open 200: ${outcome.status}`);
        // Strict envelope requirements (round-11 nit R11-PIN-01): the answer
        // must be a 503 carrying a well-formed error envelope with the exact
        // requestId echoed and retryable=true — never a bare destroy, never
        // the zero sentinel, never a shapeless body.
        assert.equal(outcome.status, 503, `expected correlated 503, got ${outcome.status}: ${outcome.body.slice(0, 200)}`);
        const parsed = JSON.parse(outcome.body);
        const zero = '00000000-0000-0000-0000-000000000000';
        assert.notEqual(parsed.requestId, zero, 'post-auth errors must never carry the zero sentinel');
        assert.equal(parsed.requestId, x.headers['x-pi-remote-request-id'], `requestId must be echoed exactly: ${parsed.requestId} vs ${x.headers['x-pi-remote-request-id']}`);
        assert.equal(parsed.error?.code, 'unavailable', `expected unavailable, got ${JSON.stringify(parsed.error)}`);
        assert.equal(parsed.error?.retryable, true, 'initial-timeline failure must be retryable');
        assert.equal(ctx.remote.stream.subscribers.get(device.deviceId)?.size ?? 0, 0, 'no subscriber may survive');
      } finally { store.persistStreamGenerationFloor = orig; }
    } finally { await ctx.cleanup(); }
  });

  await t('round-10: boxed reserved-id create result is refused and can never replay as success (R10-CREATE-01)', async () => {
    // Domain returns a BOXED String('stream-reset'). RegExp coercion passed
    // the shape test while strict equality missed the reserved-id check —
    // the boxed object was recorded raw (500s) but JSON normalization on
    // restart turned it into the primitive literal, replaying as 200.
    // The mutable wrapper starts in normal mode so boot-invariants hold.
    let mode = 'normal';
    const ctx = await boot({
      openConversation: async () => mode === 'boxed' ? { conversationId: new String('stream-reset') } : { conversationId: 'conv_fixture_001' },
    });
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      mode = 'boxed';
      const pid = 'p-' + crypto.createHash('sha256').update('C:/fixture/proj').digest('base64url').slice(0, 22);
      const clientConversationId = crypto.randomUUID();
      const body = envelope('runtime.create', { clientConversationId }, 1);
      const firePinned = () => {
        const x = signed(device, ctx, { method: 'POST', path: `/remote/v1/projects/${pid}/conversations`, body });
        return ctx.pinnedRequest('POST', `/remote/v1/projects/${pid}/conversations`, { rawBody: x.rawBody, headers: x.headers });
      };
      // Port-aware raw variant for the restarted server (same credentials,
      // same dataDir — cert pinning still verified against ctx.fingerprint).
      const fireRaw = (port) => new Promise((resolve, reject) => {
        const x = signed(device, ctx, { method: 'POST', path: `/remote/v1/projects/${pid}/conversations`, body });
        const req = https.request({
          host: '127.0.0.1', port, method: 'POST', path: `/remote/v1/projects/${pid}/conversations`,
          headers: { 'content-length': Buffer.byteLength(x.rawBody), ...x.headers },
          rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }),
        }, res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const cert = res.socket?.getPeerCertificate?.();
            if (cert?.raw) assert.equal(crypto.createHash('sha256').update(cert.raw).digest('hex'), ctx.fingerprint, 'pinned fingerprint mismatch after restart');
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
          });
        });
        req.on('error', reject);
        req.write(x.rawBody);
        req.end();
      });
      const r1 = await firePinned();
      assert.notEqual(r1.status, 200, `boxed reserved id must not be accepted: ${r1.body}`);
      const r2 = await firePinned();
      assert.notEqual(r2.status, 200, `same-process retry must not replay: ${r2.body}`);
      // Restart: even after JSON normalization, no success may exist to replay.
      await ctx.remote.close();
      const { startRemote } = await import(MODULES.index);
      const conversations = ctx.conversations;
      const domain = {
        projects: () => [{ path: 'C:/fixture/proj', name: 'fixture' }],
        conversations: () => conversations,
        sessionRecords: () => [],
        openConversation: async () => ({ conversationId: new String('stream-reset') }),
        sendMessage: async () => ({ accepted: true }),
        stop: async () => ({ stopped: true }),
        pendingDialogs: () => [],
        consumeApproval: () => true,
      };
      const remote2 = startRemote({ dataDir: ctx.dataDir, domain, host: '127.0.0.1', port: 0 });
      const addr2 = await remote2.listen();
      try {
        const r3 = await fireRaw(addr2.port);
        assert.notEqual(r3.status, 200, `post-restart retry must not replay a normalized boxed success: ${r3.body}`);
      } finally { await remote2.close(); }
    } finally { fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
  });

  await t('round-11: accessor-poisoned create result never escapes validation into the journal (R11-CREATE-01)', async () => {
    // The getter answers the FIRST read with a valid id and every later read
    // with primitive 'stream-reset'. A correct implementation reads exactly
    // once, so validation and recording share one captured primitive: either
    // the valid id is journaled (legitimate) or the poison is validated and
    // refused. What must NEVER happen: validate the valid id yet journal the
    // poison. The disk record is the witness.
    let mode = 'normal';
    let readCount = 0;
    const validId = 'conv_valid_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const ctx = await boot({
      openConversation: async () => {
        if (mode === 'normal') return { conversationId: 'conv_fixture_001' };
        readCount = 0;
        const obj = {};
        Object.defineProperty(obj, 'conversationId', {
          enumerable: true,
          get() {
            // The pre-fix implementation read three times for validation and
            // a fourth time to build the recorded result — the defect lives
            // in reads diverging AFTER validation. Reads 1-3 answer valid;
            // the recording read (4+) is poisoned. A correct implementation
            // reads exactly once, so only read 1 ever happens.
            readCount++;
            return readCount <= 3 ? validId : 'stream-reset';
          },
        });
        return obj;
      },
    });
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      mode = 'poisoned';
      const pid = 'p-' + crypto.createHash('sha256').update('C:/fixture/proj').digest('base64url').slice(0, 22);
      const clientConversationId = crypto.randomUUID();
      const body = envelope('runtime.create', { clientConversationId }, 1);
      const fire = () => {
        const x = signed(device, ctx, { method: 'POST', path: `/remote/v1/projects/${pid}/conversations`, body });
        return ctx.pinnedRequest('POST', `/remote/v1/projects/${pid}/conversations`, { rawBody: x.rawBody, headers: x.headers });
      };
      const r1 = await fire();
      // Either legitimate acceptance of the FIRST-read valid id, or honest
      // refusal — both are spec-compliant. The forbidden outcome is replaying
      // 'stream-reset' as a success. Check the durable journal:
      const idemPath = path.join(ctx.dataDir, 'remote-idempotency.json');
      const journal = JSON.parse(fs.readFileSync(idemPath, 'utf8'));
      const serialized = JSON.stringify(journal);
      if (r1.status === 200) {
        const parsed = JSON.parse(r1.body);
        assert.equal(parsed.result?.conversationId, validId, `acceptance must carry the first-read id, not a later poisoned read: ${r1.body}`);
      }
      assert.ok(!serialized.includes('stream-reset'), `the reserved id must never be journaled by any read ordering: ${serialized.slice(0, 300)}`);
      const r2 = await fire();
      if (r1.status === 200) {
        assert.equal(r2.status, 200, 'a legitimate success must replay honestly');
        assert.equal(JSON.parse(r2.body).result?.conversationId, validId, 'replay must carry the same valid id');
      } else {
        assert.notEqual(r2.status, 200, `a refusal must never become a replayed success: ${r2.body}`);
      }
    } finally { await ctx.cleanup(); }
  });

  await t('fs-001: failed registration leaves no memory-active credentials (FS-001 register rollback)', async () => {
    const ctx = await boot();
    try {
      // Sabotage persistence BEFORE the pair exchange completes: the durable
      // registration write fails. The exchange must fail AND memory must not
      // retain an active record — pre-fix, the memory-only device then
      // authenticated with 200.
      const tmpPath = path.join(ctx.dataDir, 'remote-devices.json.tmp');
      fs.mkdirSync(tmpPath);
      let device = null;
      let pairOutcome = null;
      try {
        const session = ctx.remote.admin.issuePairing();
        device = keypair();
        const clientNonce = b64(crypto.randomBytes(32));
        const scopes = ['projects.read', 'sessions.read'];
        const body = {
          pairCode: session.code,
          deviceName: 'fs-test',
          devicePublicKey: device.publicKeyRaw,
          clientNonce,
          serviceFingerprint: ctx.fingerprint,
          proofSignature: '',
          pairingSessionId: session.pairingSessionId,
          requestedScopes: scopes,
        };
        const { buildPairProofMessage } = await import(MODULES.protocol);
        body.proofSignature = crypto.sign(null, Buffer.from(buildPairProofMessage(body), 'utf8'), device.privateKey).toString('base64url');
        ctx.remote.admin.approvePairing({
          pairingSessionId: body.pairingSessionId, pairCode: body.pairCode,
          deviceName: body.deviceName, devicePublicKey: device.devicePublicKey ?? device.publicKeyRaw,
          clientNonce: body.clientNonce, serviceFingerprint: body.serviceFingerprint,
          requestedScopes: [...scopes],
          proofTranscript: canonicalJson(body),
        });
        const rawBody = canonicalJson(body);
        pairOutcome = await ctx.pinnedRequest('POST', '/remote/v1/pair/exchange', { rawBody, headers: { 'content-type': 'application/json; charset=utf-8', 'accept': 'application/json' } }).catch(e => ({ status: 0, body: String(e?.message ?? e) }));
      } finally { fs.rmdirSync(tmpPath); }
      assert.notEqual(pairOutcome?.status ?? 0, 200, `pairing must fail when registration cannot persist: ${JSON.stringify(pairOutcome).slice(0, 200)}`);
      // Any device the exchange might have registered must not be memory-active.
      const anyActive = ctx.remote.deviceStore.list().some(d => ctx.remote.deviceStore.get(d.deviceId)?.active === true);
      assert.equal(anyActive, false, `no memory-active record may survive a failed registration: ${JSON.stringify(ctx.remote.deviceStore.list()).slice(0, 200)}`);
      // The would-be credentials must NOT authenticate under any deviceId.
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = 'dev_fs001_probe_00000001';
      const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/projects' });
      const res = await ctx.pinnedRequest('GET', '/remote/v1/projects', { headers: x.headers });
      assert.equal(res.status, 401, `failed-registration credentials must never authenticate: ${res.status}`);
    } finally { await ctx.cleanup(); }
  });

  await t('fs-001: failed revocation still closes streams and stays revoked in memory (FS-001 revoke sticky)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const state = { status: 0, ended: false };
      await new Promise((resolve, reject) => {
        const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/events', accept: 'text/event-stream' });
        const req = https.request({ host: '127.0.0.1', port: ctx.addr.port, method: 'GET', path: '/remote/v1/events', headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, res => {
          state.status = res.statusCode;
          state.res = res;
          res.on('end', () => { state.ended = true; });
          res.on('close', () => { state.ended = true; });
          res.resume();
          resolve();
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(state.status, 200);
      const tmpPath = path.join(ctx.dataDir, 'remote-devices.json.tmp');
      const tombTmp = path.join(ctx.dataDir, 'remote-revocations.json.tmp');
      fs.mkdirSync(tmpPath);
      fs.mkdirSync(tombTmp);
      let revokeResult;
      try {
        revokeResult = ctx.remote.deviceStore.revoke(device.deviceId);
      } catch { revokeResult = 'threw'; } finally { fs.rmdirSync(tmpPath); fs.rmdirSync(tombTmp); }
      assert.notEqual(revokeResult, 'threw', 'revocation never throws — it degrades to memory-only denial');
      assert.equal(revokeResult.revoked, true);
      assert.equal(revokeResult.durable, false, 'FSEC-005: double write failure is honestly reported as not durable');
      const flagged = ctx.remote.deviceStore.get(device.deviceId);
      assert.equal(flagged.revocationPersistenceFailed, true, 'operator-visible persistence failure flag');
      // Retry with the fault removed must re-attempt both durable channels.
      const retry = ctx.remote.deviceStore.revoke(device.deviceId);
      assert.equal(retry.durable, true, 'retry path re-establishes durability');
      assert.equal(retry.alreadyRevoked, true);
      assert.equal(ctx.remote.deviceStore.get(device.deviceId).revocationPersistenceFailed, false);
      const deadline = Date.now() + 3000;
      while (!state.ended && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
      assert.equal(state.ended, true, 'revocation must close streams even when persistence fails');
      const rec = ctx.remote.deviceStore.get(device.deviceId);
      assert.equal(rec?.active, false, 'authorization loss is sticky in memory — never re-enabled by a durability failure');
      assert.equal(rec?.revoked, true);
      // New requests must fail closed regardless of the durability gap.
      const x2 = signed(device, ctx, { method: 'GET', path: '/remote/v1/projects' });
      const res2 = await ctx.pinnedRequest('GET', '/remote/v1/projects', { headers: x2.headers });
      assert.equal(res2.status, 401, `revoked-in-memory device must never authorize: ${res2.status}`);
      try { state.res.destroy(); } catch {}
    } finally { await ctx.cleanup(); }
  });

  await t('fsec-005: revocation survives restart via tombstone WAL; retry path is honest; inert tombstone never kills a re-registered instance', async () => {
    // Reviewer reproduction: revoke with faulted MAIN persistence, restart —
    // pre-fix the device came back active; fixed, the tombstone WAL reconciles.
    const { DeviceStore } = await import(MODULES.deviceStore);
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(pp => pp);
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const deviceId = device.deviceId;
      const dataDir = ctx.dataDir;
      const rec = ctx.remote.deviceStore.get(deviceId);
      const instanceKey = rec.devicePublicKey;
      const instanceRegisteredAt = rec.registeredAt;
      // Fault ONLY the main channel: tombstone write succeeds, main persist fails.
      fs.mkdirSync(path.join(dataDir, 'remote-devices.json.tmp'));
      let result;
      try {
        result = ctx.remote.deviceStore.revoke(deviceId);
      } finally {
        fs.rmdirSync(path.join(dataDir, 'remote-devices.json.tmp'));
      }
      assert.equal(result.revoked, true);
      assert.equal(result.durable, true, 'tombstone channel alone is sufficient for durability');
      // The main durable bytes were never updated: on disk the device still
      // looks active. Pre-fix, a restart re-admitted it.
      const diskBytes = JSON.parse(fs.readFileSync(path.join(dataDir, 'remote-devices.json'), 'utf8'));
      const diskRec = diskBytes.devices.find(d => d.deviceId === deviceId);
      assert.equal(diskRec.revoked !== true, true, 'test premise: main durable bytes still show the device active');
      // Close the server but PRESERVE the data dir — restart durability is
      // exactly what this pin verifies.
      await ctx.remote.close();
      // Restart: tombstone reconciliation must re-apply the revocation.
      const store2 = new DeviceStore(dataDir, () => {});
      const reloaded = store2.get(deviceId);
      assert.equal(reloaded.revoked, true, 'FSEC-005: tombstoned revocation must survive restart even when main persistence failed');
      assert.equal(reloaded.active, false);
      assert.equal(store2.active(deviceId), null, 'device must never authorize after restart');
      // Reconciliation is instance-scoped: the SAME registration instance.
      assert.equal(reloaded.devicePublicKey, instanceKey);
      assert.equal(reloaded.registeredAt, instanceRegisteredAt);
      // Inert tombstone: a re-registered instance (fresh registeredAt/key)
      // must NOT be killed by the stale entry.
      const store3 = new DeviceStore(dataDir, () => {});
      const live = store3.devices.get(deviceId);
      live.revoked = false; live.active = true;
      live.registeredAt = new Date(Date.now() + 1000).toISOString(); // fresh registration instance
      live.expiresAt = new Date(Date.now() + 3600000).toISOString();
      live.replayEpoch = live.replayEpoch + 1;
      store3._persist();
      const store4 = new DeviceStore(dataDir, () => {});
      const survived = store4.get(deviceId);
      assert.equal(survived.revoked, false, 'inert tombstone must never kill a re-registered instance');
    } finally { fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
  });

  await t('fsec-005-r5: malformed entries inside a readable journal poison the whole journal to unknown — never silently dropped', async () => {
    // FSEC-005-R5-001: a valid-JSON journal containing one malformed entry
    // plus one well-formed revocation used to silently drop the malformed
    // entry and stay 'present'. If the well-formed entry's revocation was
    // later compacted away, nothing prevented treating the truncated set as
    // complete. All-or-nothing validation: any malformed entry makes the
    // journal unknown — fail-closed, append-refusing, compaction-disabled.
    const { DeviceStore } = await import(MODULES.deviceStore);
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(pp => pp);
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const deviceId = device.deviceId;
      const dataDir = ctx.dataDir;
      const rec = ctx.remote.deviceStore.get(deviceId);
      // Write a journal mixing one valid revocation with one malformed entry.
      fs.writeFileSync(path.join(dataDir, 'remote-revocations.json'), JSON.stringify({ revocations: [
        { deviceId, devicePublicKey: rec.devicePublicKey, registeredAt: rec.registeredAt, revokedAt: new Date().toISOString() },
        { deviceId: 42, note: 'malformed entry: deviceId is not a string' },
      ] }), 'utf8');
      const store2 = new DeviceStore(dataDir, () => {});
      assert.equal(store2.revocationJournalUnknown, true, 'FSEC-005-R5-001: malformed entry must poison the journal to unknown');
      assert.equal(store2.active(deviceId), null, 'unknown journal never authorizes');
      // Append over the poisoned journal must refuse, preserving bytes verbatim.
      const bytesBefore = fs.readFileSync(path.join(dataDir, 'remote-revocations.json'), 'utf8');
      assert.throws(() => store2._appendTombstone(store2.get(deviceId)), /unknown revocation state/);
      assert.equal(fs.readFileSync(path.join(dataDir, 'remote-revocations.json'), 'utf8'), bytesBefore, 'journal bytes preserved verbatim');
    } finally { await ctx.remote.close(); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
  });

  await t('fsec-005-r6b: unknown-journal degradation stays memory-only even when unrelated startup corruption persists the file', async () => {
    // FSEC-005-R6B-001 combined-state reproduction: two valid devices, one
    // with corrupted replay state (legit repair -> persist), plus an
    // unreadable journal (memory-only degradation). Pre-fix, the persist
    // triggered by the replay repair serialized the degradation — journal
    // restoration could never heal the intact device.
    const { DeviceStore } = await import(MODULES.deviceStore);
    const ctx = await boot();
    try {
      const pairA = await pair(ctx);
      pairA.device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const pairB = await pair(ctx);
      pairB.device.deviceId = ctx.remote.deviceStore.list()[1].deviceId;
      const idA = pairA.device.deviceId;
      const idB = pairB.device.deviceId;
      const dataDir = ctx.dataDir;
      await ctx.remote.close();
      // Corrupt device A's replay state (legitimately repairable corruption)
      // AND make the journal unreadable.
      const mainBytes = JSON.parse(fs.readFileSync(path.join(dataDir, 'remote-devices.json'), 'utf8'));
      const recA = mainBytes.devices.find(d => d.deviceId === idA);
      delete recA.nonces; // replay corruption -> repair path
      fs.writeFileSync(path.join(dataDir, 'remote-devices.json'), JSON.stringify(mainBytes), 'utf8');
      fs.writeFileSync(path.join(dataDir, 'remote-revocations.json'), '{{not json', 'utf8');
      const store2 = new DeviceStore(dataDir, () => {});
      assert.equal(store2.revocationJournalUnknown, true, 'journal is unknown');
      // The persist triggered by replay repair must NOT serialize the
      // journal degradation of device B — B was intact all along.
      const diskAfter = JSON.parse(fs.readFileSync(path.join(dataDir, 'remote-devices.json'), 'utf8'));
      const diskB = diskAfter.devices.find(d => d.deviceId === idB);
      assert.equal(diskB.active, true, 'FSEC-005-R6B-001: unrelated persist must not bake degradation into durable bytes');
      assert.equal(diskB.requiresRepair === true, false, 'no degradation requiresRepair on disk');
      // Device A's legit replay repair DID persist: epoch bumped, inactive.
      const diskA = diskAfter.devices.find(d => d.deviceId === idA);
      assert.equal(diskA.active, false, 'legit replay repair persists its own deactivation');
      assert.equal(diskA.replayEpoch, 2, 'replay repair epoch bump is durable');
      // Now restore the journal and restart: B must heal, A stays repaired.
      fs.writeFileSync(path.join(dataDir, 'remote-revocations.json'), JSON.stringify({ revocations: [] }), 'utf8');
      const store3 = new DeviceStore(dataDir, () => {});
      assert.equal(store3.revocationJournalUnknown, false, 'journal readable again');
      const healedB = store3.get(idB);
      assert.equal(healedB.active, true, 'FSEC-005-R6B-001: journal restoration must recover the intact device');
      assert.equal(store3.active(idB) !== null, true, 'B fully eligible again');
      const stillA = store3.get(idA);
      assert.equal(stillA.active, false, 'legit replay repair does NOT heal — it requires re-pair by design');
    } finally { await ctx.remote.close().catch(() => {}); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
  });

  await t('fsec-005-r7: re-pair during unknown journal freezes uniformly in memory yet heals with the journal — never a session/restart split', async () => {
    // FSEC-005-R7-001: before the uniform freeze, a re-pair performed while
    // the journal was unreadable was active for the rest of the session but
    // degraded after restart — two different answers to one unverifiable
    // revocation state. Worse, once serialization was considered, the naive
    // freeze bricked the fresh instance permanently. Coherent design:
    // uniform memory freeze (session === restart), durable bytes keep the
    // registration's true intent via the degradation marker, journal
    // restoration heals the fresh instance like every other device.
    const { DeviceStore } = await import(MODULES.deviceStore);
    const ctx = await boot();
    try {
      const paired = await pair(ctx);
      paired.device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const deviceId = paired.device.deviceId;
      const dataDir = ctx.dataDir;
      const key = ctx.remote.deviceStore.get(deviceId).devicePublicKey;
      await ctx.remote.close();
      // Journal becomes unreadable.
      fs.writeFileSync(path.join(dataDir, 'remote-revocations.json'), '{corrupt', 'utf8');
      const store = new DeviceStore(dataDir, () => {});
      assert.equal(store.revocationJournalUnknown, true);
      // Re-pair the same key during the outage (rotation semantics).
      const result = store.register({
        deviceId, devicePublicKey: key,
        grantedScopes: ['projects.read', 'sessions.read'], serviceFingerprint: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 3600000).toISOString(), deviceName: 't',
      });
      assert.ok(result, 're-pair itself is accepted — the freeze is about authorization, not registration');
      assert.equal(store.active(deviceId), null, 'uniform freeze: fresh instance is NOT authorized in memory');
      // Durable bytes keep the registration's true intent.
      const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'remote-devices.json'), 'utf8'));
      const diskRec = disk.devices.find(d => d.deviceId === deviceId);
      assert.equal(diskRec.active, true, 'FSEC-005-R7-001: durable bytes must carry the true registration, not the freeze');
      // Restart with journal still broken: same answer as the session — frozen.
      const store2 = new DeviceStore(dataDir, () => {});
      assert.equal(store2.active(deviceId), null, 'session and restart agree: frozen');
      // Restore the journal: the fresh instance heals like every other device.
      fs.writeFileSync(path.join(dataDir, 'remote-revocations.json'), JSON.stringify({ revocations: [] }), 'utf8');
      const store3 = new DeviceStore(dataDir, () => {});
      assert.equal(store3.active(deviceId) !== null, true, 'FSEC-005-R7-001: journal restoration must heal the fresh instance — never a permanent brick');
    } finally { await ctx.remote.close().catch(() => {}); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
  });

  await t('fsec-005-r8: cross-device rotation survives restart — revoked predecessor never poisons the replacement registration', async () => {
    // FSEC-005-R8-001: revoked predecessors were inserted into the live-key
    // index during reconstruction, so a legitimate rotation replacement
    // (different deviceId, same key — a genuine device replacement re-pair)
    // looked like a duplicate and was persistently revoked by restart
    // validation. Restoring the journal could never recover it.
    const { DeviceStore } = await import(MODULES.deviceStore);
    const ctx = await boot();
    try {
      const paired = await pair(ctx);
      paired.device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const originalId = paired.device.deviceId;
      const key = ctx.remote.deviceStore.get(originalId).devicePublicKey;
      const dataDir = ctx.dataDir;
      await ctx.remote.close();
      // Device replacement: revoke the original, register the SAME key under
      // a NEW deviceId (the physical replacement's identity).
      const store = new DeviceStore(dataDir, () => {});
      store.revoke(originalId);
      const repResult = store.register({
        deviceId: 'dev_rotation_replacement_01', devicePublicKey: key,
        grantedScopes: ['projects.read', 'sessions.read'],
        serviceFingerprint: ctx.remote.deviceStore ? ctx.remote.deviceStore.get(originalId)?.serviceFingerprint || 'a'.repeat(64) : 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 3600000).toISOString(), deviceName: 'replacement',
      });
      assert.ok(repResult, 'replacement registration accepted');
      // Restart: the replacement must survive — the revoked predecessor does
      // not compete for the live key index.
      const store2 = new DeviceStore(dataDir, () => {});
      const rep = store2.get('dev_rotation_replacement_01');
      assert.ok(rep, 'replacement record exists after restart');
      assert.equal(rep.revoked, false, 'FSEC-005-R8-001: replacement must not be revoked by the predecessor durable bytes');
      assert.equal(store2.active('dev_rotation_replacement_01') !== null, true, 'replacement is authorized after restart');
      // The predecessor remains revoked — rotation direction is not blurred.
      assert.equal(store2.get(originalId).revoked, true, 'predecessor stays revoked');
      // And duplicate validation still fires for two NON-revoked records
      // sharing a key — the relaxation must not weaken real collisions.
      const dataDir2 = dataDir + '-dup';
      fs.mkdirSync(dataDir2, { recursive: true });
      const mk = (id) => ({
        deviceId: id, deviceName: 't', devicePublicKey: key,
        serviceFingerprint: 'a'.repeat(64), serviceId: 'svc-aaaaaaaaaaaaaaaa',
        grantedScopes: ['projects.read'], grants: {}, active: true, revoked: false,
        replayEpoch: 1, expiresAt: new Date(Date.now() + 3600000).toISOString(),
        registeredAt: new Date().toISOString(), nonces: {}, timestampFloor: 0,
      });
      fs.writeFileSync(path.join(dataDir2, 'remote-devices.json'), JSON.stringify({ devices: [mk('dev_dup000001'), mk('dev_dup000002')] }));
      const store3 = new DeviceStore(dataDir2, () => {});
      assert.equal(store3.get('dev_dup000002').revoked, true, 'genuine non-revoked duplicate still fails closed');
      fs.rmSync(dataDir2, { recursive: true, force: true });
    } finally { await ctx.remote.close().catch(() => {}); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
  });

  await t('fsec-005b: double write failure is memory-only, honestly flagged, and durable bytes never gain a false annotation', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(pp => pp);
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const deviceId = device.deviceId;
      fs.mkdirSync(path.join(ctx.dataDir, 'remote-devices.json.tmp'));
      fs.mkdirSync(path.join(ctx.dataDir, 'remote-revocations.json.tmp'));
      let result;
      try {
        result = ctx.remote.deviceStore.revoke(deviceId);
      } finally {
        fs.rmdirSync(path.join(ctx.dataDir, 'remote-devices.json.tmp'));
        fs.rmdirSync(path.join(ctx.dataDir, 'remote-revocations.json.tmp'));
      }
      assert.equal(result.durable, false);
      assert.equal(result.revoked, true, 'memory denial is unconditional');
      // Durable bytes must never carry the runtime-only failure annotation.
      const diskBytes = fs.readFileSync(path.join(ctx.dataDir, 'remote-devices.json'), 'utf8');
      assert.equal(diskBytes.includes('revocationPersistenceFailed'), false, 'runtime annotation stays out of durable bytes');
    } finally { await ctx.cleanup(); }
  });

  await t('fsec-005-r4a: unreadable revocation journal at restart never re-authorizes any device (fail-closed, memory-only)', async () => {
    // Round-4 FSEC-005-R4-001 startup case: revoke durably (tombstone+main),
    // then corrupt the journal. Restart must NOT treat the unreadable journal
    // as absent — the device stays deauthorized in memory even though the
    // main durable bytes alone would show it revoked... and crucially an
    // ACTIVE device in main bytes must also be denied, because the journal
    // might carry its revocation.
    const { DeviceStore } = await import(MODULES.deviceStore);
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(pp => pp);
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const deviceId = device.deviceId;
      const dataDir = ctx.dataDir;
      // Pin premise (round-5 functional review): the scenario must first
      // create a TOMBSTONE-ONLY durable revocation — main persist faulted so
      // the durable bytes still show the device ACTIVE, and the journal is
      // the only durable record of the revocation. Corrupting the journal
      // must then never restore the authorization the tombstone carried.
      fs.mkdirSync(path.join(dataDir, 'remote-devices.json.tmp'));
      try {
        ctx.remote.deviceStore.revoke(deviceId);
      } finally {
        fs.rmdirSync(path.join(dataDir, 'remote-devices.json.tmp'));
      }
      const diskCheck = JSON.parse(fs.readFileSync(path.join(dataDir, 'remote-devices.json'), 'utf8'));
      assert.equal(diskCheck.devices.find(d => d.deviceId === deviceId).revoked !== true, true, 'test premise: durable bytes still show the device active');
      await ctx.remote.close();
      // Corrupt the revocation journal so it cannot be parsed.
      fs.writeFileSync(path.join(dataDir, 'remote-revocations.json'), '{not json', 'utf8');
      const store2 = new DeviceStore(dataDir, () => {});
      assert.equal(store2.revocationJournalUnknown, true, 'unreadable journal must surface as unknown state');
      const reloaded = store2.get(deviceId);
      assert.equal(store2.active(deviceId), null, 'FSEC-005-R4-001: unknown journal state must never authorize');
      assert.equal(reloaded.active, false, 'device deactivated in memory');
      assert.equal(reloaded.requiresRepair, true, 'operator-visible repair is required');
      // The degraded state must NOT have been persisted — durable bytes
      // keep their pre-corruption record so the failure heals when the
      // journal is fixed (here: still active, since the main channel was
      // faulted — the tombstone is the only revocation record).
      const diskBytes = JSON.parse(fs.readFileSync(path.join(dataDir, 'remote-devices.json'), 'utf8'));
      const diskRec = diskBytes.devices.find(d => d.deviceId === deviceId);
      assert.equal(diskRec.active, true, 'degradation is memory-only: durable bytes keep the pre-corruption record');
    } finally { fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
  });

  await t('fsec-005-r4b: unreadable journal blocks append — a prior acknowledged revocation is never overwritten out of existence', async () => {
    // Round-4 FSEC-005-R4-001 append case: two devices, first revoked durably
    // via the tombstone channel only (main persist faulted). Then the journal
    // becomes unreadable and a SECOND revocation is attempted — the append
    // must REFUSE rather than rewrite the journal from the empty fallback,
    // which would permanently destroy the first revocation.
    const { DeviceStore } = await import(MODULES.deviceStore);
    const ctx = await boot();
    try {
      const first = await pair(ctx);
      first.device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const second = await pair(ctx);
      second.device.deviceId = ctx.remote.deviceStore.list()[1].deviceId;
      const firstId = first.device.deviceId;
      const secondId = second.device.deviceId;
      const dataDir = ctx.dataDir;
      // Revoke first with faulted MAIN channel: durability rests on the tombstone alone.
      fs.mkdirSync(path.join(dataDir, 'remote-devices.json.tmp'));
      try {
        ctx.remote.deviceStore.revoke(firstId);
      } finally {
        fs.rmdirSync(path.join(dataDir, 'remote-devices.json.tmp'));
      }
      const journalBefore = fs.readFileSync(path.join(dataDir, 'remote-revocations.json'), 'utf8');
      assert.ok(journalBefore.includes(firstId), 'test premise: first revocation is in the journal');
      // Journal becomes unreadable (transient EIO analogue: corrupt bytes).
      fs.writeFileSync(path.join(dataDir, 'remote-revocations.json'), ' corrupt', 'utf8');
      // Second revocation must refuse the append — never overwrite unknown state.
      ctx.remote.deviceStore.revoke(secondId);
      const journalAfter = fs.readFileSync(path.join(dataDir, 'remote-revocations.json'), 'utf8');
      assert.equal(journalAfter, ' corrupt', 'FSEC-005-R4-001: unknown journal bytes must be preserved verbatim, never overwritten');
      // Restore the journal and restart: the first revocation must still be there.
      fs.writeFileSync(path.join(dataDir, 'remote-revocations.json'), journalBefore, 'utf8');
      await ctx.remote.close();
      const store2 = new DeviceStore(dataDir, () => {});
      const firstReloaded = store2.get(firstId);
      assert.equal(firstReloaded.revoked, true, 'first acknowledged revocation survives the restart');
      assert.equal(store2.active(firstId), null);
    } finally { fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
  });

  await t('fs-001: failed grant widening rolls back to the durable set (FS-001 grants rollback)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const before = { ...(ctx.remote.deviceStore.get(device.deviceId).grants ?? {}) };
      const tmpPath = path.join(ctx.dataDir, 'remote-devices.json.tmp');
      fs.mkdirSync(tmpPath);
      let threw = false;
      try {
        ctx.remote.deviceStore.setGrants(device.deviceId, [...Object.keys(before), 'p-widened0000000000000000']);
      } catch { threw = true; } finally { fs.rmdirSync(tmpPath); }
      assert.equal(threw, true, 'failed persistence must surface');
      const after = ctx.remote.deviceStore.get(device.deviceId).grants ?? {};
      assert.ok(!('p-widened0000000000000000' in after), `widening must not exist in memory when disk refused it: ${JSON.stringify(after)}`);
    } finally { await ctx.cleanup(); }
  });

  await t('fs-001: failed nonce consumption rolls back — the nonce is not silently burned (FS-001 nonce rollback)', async () => {
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const tmpPath = path.join(ctx.dataDir, 'remote-devices.json.tmp');
      const nonce = crypto.randomBytes(32).toString('base64url');
      fs.mkdirSync(tmpPath);
      let threw = false;
      try {
        ctx.remote.deviceStore.consumeNonce(device.deviceId, nonce, Date.now());
      } catch { threw = true; } finally { fs.rmdirSync(tmpPath); }
      assert.equal(threw, true);
      const rec = ctx.remote.deviceStore.get(device.deviceId);
      assert.ok(!(nonce in (rec.nonces ?? {})), 'undurable consumption must not exist in memory');
      // After the durability problem clears, the same nonce is consumable (it was never burned).
      assert.equal(ctx.remote.deviceStore.consumeNonce(device.deviceId, nonce, Date.now()), true, 'a rolled-back nonce remains consumable');
    } finally { await ctx.cleanup(); }
  });

  await t('fs-002: epoch allocation failure never hands out an undurable epoch; restart cannot double-execute (FS-002)', async () => {
    // Mirrors the independent reviewer's reproduction (journal-restart.mjs):
    // chat.send against a conversation that carries its OWN revision — the
    // registryRevision() repair path is never invoked, so only epochFor's own
    // persist discipline can protect exactly-once across a restart.
    const convId = 'conversation_fs002_journal_001';
    const projectPath = 'C:/fixture/proj';
    const pid = 'p-' + crypto.createHash('sha256').update(projectPath).digest('base64url').slice(0, 22);
    let effects = 0;
    const ctx = await boot({
      grantsFor: () => [pid],
      sendMessage: async () => { effects += 1; return { accepted: true }; },
    });
    try {
      const { device } = await pair(ctx, { scopes: ['projects.read', 'sessions.read', 'chat.send'] });
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      // Seed the conversation into the fixture with its own revision.
      ctx.conversations.push({
        conversationId: convId, revision: 1, lifecycle: 'idle', runtimeGeneration: 1,
        workspace: { cwd: projectPath, workspaceId: 'ws-fs002', workspaceEpoch: 1, backendInstance: 'fixture' },
        messages: [], pendingApprovals: [],
      });
      const clientMessageId = crypto.randomUUID();
      const body = envelope('chat.send', { clientMessageId, text: 'synthetic single effect' }, 1);
      const target = `/remote/v1/conversations/${convId}/messages`;
      const send = () => {
        const x = signed(device, ctx, { method: 'POST', path: target, body });
        return ctx.pinnedRequest('POST', target, { rawBody: x.rawBody, headers: x.headers });
      };
      // Obstruct the registry write, attempt the mutation: it must fail.
      const obstruction = path.join(ctx.dataDir, 'remote-registry.json.tmp');
      fs.mkdirSync(obstruction);
      const failed = await send();
      fs.rmdirSync(obstruction);
      assert.notEqual(failed.status, 200, `undurable epoch must never serve success: ${failed.status}`);
      assert.equal(effects, 0, 'a failed admission must never reach the domain');
      // Retry with the obstruction cleared: succeeds exactly once.
      const succeeded = await send();
      assert.equal(succeeded.status, 200, `durable allocation must succeed: ${succeeded.status} ${succeeded.body.slice(0, 120)}`);
      assert.equal(effects, 1);
      const clockFileExists = fs.existsSync(path.join(ctx.dataDir, 'remote-registry.json'));
      // Restart with unchanged owner identity, replay the same clientMessageId.
      await ctx.remote.close();
      const { startRemote } = await import(MODULES.index);
      const conversations = ctx.conversations;
      const domain = {
        projects: () => [{ path: projectPath, name: 'fixture' }],
        conversations: () => conversations,
        sessionRecords: () => [],
        openConversation: async () => ({ conversationId: convId }),
        sendMessage: async () => { effects += 1; return { accepted: true }; },
        stop: async () => ({ stopped: true }),
        pendingDialogs: () => [],
        consumeApproval: () => true,
      };
      const remote2 = startRemote({ dataDir: ctx.dataDir, domain, host: '127.0.0.1', port: 0, grantsFor: () => [pid] });
      const addr2 = await remote2.listen();
      try {
        const x3 = signed(device, ctx, { method: 'POST', path: target, body });
        const replay = await new Promise((resolve, reject) => {
          const req = https.request({ host: '127.0.0.1', port: addr2.port, method: 'POST', path: target, headers: { 'content-length': Buffer.byteLength(x3.rawBody), ...x3.headers }, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          });
          req.on('error', reject);
          req.write(x3.rawBody);
          req.end();
        });
        assert.equal(effects, 1, `replaying a recorded mutation across restart must NEVER execute the domain again (effects=${effects}, clockFile=${clockFileExists}, replay=${replay.status})`);
      } finally { await remote2.close(); }
    } finally {
      try { fs.rmdirSync(path.join(ctx.dataDir, 'remote-registry.json.tmp')); } catch {}
      await ctx.cleanup();
    }
  });

  await t('fs-003: mandatory cursor reset materialization failure closes the stream (FS-003)', async () => {
    // Stale-cursor subscription: the cursor_expired reset is mandatory. When
    // it cannot be written (write failure), the stream must close rather than
    // deliver ordinary frames in a generation the client never re-baselined.
    const ctx = await boot();
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      ctx.remote.stream.watermark(device.deviceId);
      // Force the reset WRITE to fail (not the allocation): _resetOne then
      // returns FALSE — the exact branch FS-003 is about. The failure surface
      // (write failure) is representative of any false-return cause because
      // the fix keys on the return value, not the cause.
      const stream = ctx.remote.stream;
      const origWrite = stream._write.bind(stream);
      stream._write = () => false;
      const outcome = await new Promise(resolve => {
        const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/events', query: { cursor: 'g1_s0_aaaaaaaaaaaaaaaaaaaaaa' }, accept: 'text/event-stream' });
        const chunks = [];
        let settled = false;
        const done = o => { if (!settled) { settled = true; resolve(o); } };
        const req = https.request({ host: '127.0.0.1', port: ctx.addr.port, method: 'GET', path: '/remote/v1/events?cursor=g1_s0_aaaaaaaaaaaaaaaaaaaaaa', headers: x.headers, rejectUnauthorized: false, agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }) }, res => {
          res.on('data', c => chunks.push(c));
          res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          res.on('close', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), closed: true }));
          res.resume();
        });
        req.on('error', () => done({ status: 0, body: 'socket-error' }));
        req.setTimeout(4000, () => { req.destroy(); done({ status: -1, body: 'timeout-no-response' }); });
        req.end();
      });
      stream._write = origWrite;
      // Server-side truth: no subscriber may survive the failed mandatory reset.
      assert.equal(ctx.remote.stream.subscribers.get(device.deviceId)?.size ?? 0, 0, 'subscriber registry must be empty after a failed mandatory reset');
      // And the client connection must terminate — never hang silently.
      // 'end' (graceful res.end from _close), 'close' (socket teardown) and
      // socket errors all count as termination; only a timeout-hang violates.
      assert.notEqual(outcome.status, -1, `stream must terminate, never hang: ${JSON.stringify(outcome).slice(0, 160)}`);
    } finally { await ctx.cleanup(); }
  });

  await t('fs-005: pairing error responses pass the response validator (FS-005)', async () => {
    // An expired/invalid pairing session error must validate under the
    // project's own schema — pre-fix it carried zero UUID with pairing_expired
    // and failed validation.
    const { validateRemoteResponse } = await import(MODULES.protocol);
    const zero = '00000000-0000-0000-0000-000000000000';
    for (const code of ['pairing_expired', 'pairing_rejected', 'unauthorized', 'payload_invalid', 'rate_limited', 'unavailable', 'internal_error']) {
      const err = { protocolVersion: 1, requestId: zero, error: { code, retryable: false } };
      assert.equal(validateRemoteResponse(err), true, `closed uncorrelated pairing/pre-auth error ${code} must validate`);
    }
    // But the sentinel must NEVER authenticate success or arbitrary codes.
    assert.equal(validateRemoteResponse({ protocolVersion: 1, requestId: zero, error: { code: 'scope_denied', retryable: false } }), false, 'operational codes must never carry the zero sentinel');
    assert.equal(validateRemoteResponse({ protocolVersion: 1, requestId: zero, result: {} }), false);
    // And live: an expired pairing exchange yields a validatable response.
    const ctx = await boot();
    try {
      const device = keypair();
      // Real session, correct transcript and signature — but the desktop side
      // never approves, so the exchange fails with a pairing-family error.
      const session = ctx.remote.admin.issuePairing();
      const body = {
        pairCode: session.code,
        deviceName: 'fs5',
        devicePublicKey: device.publicKeyRaw,
        clientNonce: b64(crypto.randomBytes(32)),
        serviceFingerprint: ctx.fingerprint,
        proofSignature: '',
        pairingSessionId: session.pairingSessionId,
        requestedScopes: ['projects.read', 'sessions.read'],
      };
      const { buildPairProofMessage } = await import(MODULES.protocol);
      const proofMsg = buildPairProofMessage(body);
      assert.ok(typeof proofMsg === 'string', 'proof transcript must construct for a well-formed body');
      body.proofSignature = crypto.sign(null, Buffer.from(proofMsg, 'utf8'), device.privateKey).toString('base64url');
      const res = await ctx.pinnedRequest('POST', '/remote/v1/pair/exchange', { rawBody: canonicalJson(body), headers: { 'content-type': 'application/json; charset=utf-8', 'accept': 'application/json' } });
      const parsed = JSON.parse(res.body);
      assert.equal(validateRemoteResponse(parsed), true, `live pairing error must validate: ${res.body.slice(0, 200)}`);
    } finally { await ctx.cleanup(); }
  });

  await t('fs-004: handler exception logs carry categories, never raw exception text (FS-004)', async () => {
    // A domain exception carrying credential-shaped text must never reach the
    // log verbatim — production wires this logger to console. Category-level
    // logging only; the wire answer stays a fixed shape.
    const lines = [];
    const ctx = await boot({
      log: m => lines.push(String(m)),
      projects: () => {
        // FS-R2-001: name is as mutable as message — poison BOTH. A safe
        // message with a credential-shaped name must not leak either field.
        const e = new Error('synthetic-secret sk-live-ABC123');
        e.name = 'sk-synthetic-pin4-name-credential-shaped';
        throw e;
      },
    });
    try {
      const { device } = await pair(ctx).then(p => p);
      ctx.serviceId = 'svc-' + ctx.fingerprint.slice(0, 16);
      ctx.buildSignatureMessage = buildSignatureMessage;
      device.deviceId = ctx.remote.deviceStore.list()[0].deviceId;
      const x = signed(device, ctx, { method: 'GET', path: '/remote/v1/projects' });
      const res = await ctx.pinnedRequest('GET', '/remote/v1/projects', { headers: x.headers });
      assert.notEqual(res.status, 200, 'a throwing domain cannot produce success');
      await new Promise(r => setTimeout(r, 150));
      const joined = lines.join(String.fromCharCode(10));
      assert.ok(!joined.includes('sk-live-ABC123'), `raw exception text must never reach the log: ${joined.slice(0, 300)}`);
      assert.ok(!joined.includes('synthetic-secret'), `credential-shaped exception text must never reach the log: ${joined.slice(0, 300)}`);
      assert.ok(!joined.includes('sk-synthetic-pin4'), `mutable exception NAME must never reach the log either (FS-R2-001): ${joined.slice(0, 300)}`);
    } finally { await ctx.cleanup(); }
  });

  await t('fr-001: failed re-registration restores the exact pre-transaction key-index owner (FR-001)', async () => {
    // Failed re-registration of a revoked deviceId must not resurrect or
    // hijack key-index entries: the index owner after rollback must be
    // exactly what it was before the transaction, and a later rotation of
    // the same key must revoke the current owner — never leave two active
    // records sharing one key.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr001-'));
    try {
      const { DeviceStore } = await import(MODULES.deviceStore);
      const store = new DeviceStore(dir);
      const sharedKey = crypto.randomBytes(32).toString('base64url');
      const mk = (deviceId, devicePublicKey) => store.register({ deviceId, devicePublicKey, grantedScopes: ['projects.read', 'sessions.read'], serviceFingerprint: 'a'.repeat(64), expiresAt: new Date(Date.now() + 3600_000).toISOString(), deviceName: 'synthetic fixture', grantedProjectIds: [] });
      mk('device_revoked_before', sharedKey);
      store.revoke('device_revoked_before');
      mk('device_current_owner', sharedKey);
      const before = store.deviceIdForKey(sharedKey);
      assert.equal(before, 'device_current_owner', 'fixture invariant');
      const disk = fs.readFileSync(store.path, 'utf8');
      fs.mkdirSync(store.path + '.tmp');
      try {
        assert.throws(() => mk('device_revoked_before', crypto.randomBytes(32).toString('base64url')));
      } finally { fs.rmdirSync(store.path + '.tmp'); }
      assert.equal(fs.readFileSync(store.path, 'utf8'), disk, 'fault injection must leave the durable store unchanged');
      assert.equal(store.deviceIdForKey(sharedKey), before, 'rollback must restore the exact pre-transaction key-index owner');
      mk('device_next_owner', sharedKey);
      const activeForKey = [...store.devices.values()].filter(d => d.devicePublicKey === sharedKey && store.active(d.deviceId)).map(d => d.deviceId);
      assert.equal(activeForKey.length, 1, `successful key rotation must not leave two active records sharing one key: ${JSON.stringify(activeForKey)}`);
      assert.equal(store.get('device_current_owner').revoked, true, 'the rotation must revoke the prior owner');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await t('fr-002: failed nonce persistence restores retention-pruned entries (FR-002)', async () => {
    // Retention pruning is part of the transaction's memory mutation. A
    // failed persist must restore the pruned entries too — otherwise memory
    // enforces a stricter rejection surface than the durable state justifies
    // (memory must never diverge from disk in EITHER direction).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr002-'));
    try {
      const { DeviceStore } = await import(MODULES.deviceStore);
      const { REMOTE_V1 } = await import(MODULES.protocol);
      const store = new DeviceStore(dir);
      const id = 'device_nonce_fixture';
      const nonce = () => crypto.randomBytes(32).toString('base64url');
      store.register({ deviceId: id, devicePublicKey: nonce(), grantedScopes: ['projects.read', 'sessions.read'], serviceFingerprint: 'a'.repeat(64), expiresAt: new Date(Date.now() + 3600_000).toISOString(), deviceName: 'synthetic fixture', grantedProjectIds: [] });
      const old = nonce(), current = nonce(), attempted = nonce();
      const oldTimestamp = Date.now() - (REMOTE_V1.signedRequest.replay.retentionSeconds + 60) * 1000;
      assert.equal(store.consumeNonce(id, old, oldTimestamp), true);
      const floor = Date.now();
      assert.equal(store.consumeNonce(id, current, floor), true);
      const record = store.get(id);
      const before = { ...record.nonces };
      const disk = fs.readFileSync(store.path, 'utf8');
      fs.mkdirSync(store.path + '.tmp');
      try { assert.throws(() => store.consumeNonce(id, attempted, floor + 1)); }
      finally { fs.rmdirSync(store.path + '.tmp'); }
      assert.deepEqual(record.nonces, before, 'failed persistence must restore entries pruned earlier in this operation');
      assert.equal(record.timestampFloor, floor, 'timestamp floor rolls back');
      assert.equal(fs.readFileSync(store.path, 'utf8'), disk, 'disk unchanged by the failed transaction');
      assert.equal(store.consumeNonce(id, old, oldTimestamp), false, 'expired timestamps remain rejected');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
