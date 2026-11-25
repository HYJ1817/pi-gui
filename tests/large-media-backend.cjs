'use strict';
// Opt-in fault qualification against a generated real >100 MiB video. Never
// sparse/padded data. node tests/large-media-backend.cjs --fixture <TEMP>/media
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const MiB = 1024 * 1024, rows = [];
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-large-media-fault-'));
let server, eventBus, eventRequest, eventResponse, assertions = 0;
const eq = (a, b, message) => { assertions++; assert.deepEqual(a, b, message); };
const ok = (value, message) => { assertions++; assert.ok(value, message); };
const TOKEN = 'offline-large-media-fault-only';
const digest = (file, start, end) => new Promise((resolve, reject) => { const hash = createHash('sha256'); const stream = fs.createReadStream(file, { start, end, highWaterMark: 65536 }); stream.on('data', bytes => hash.update(bytes)); stream.on('error', reject); stream.on('end', () => resolve(hash.digest('hex'))); });
async function main() {
  const index = process.argv.indexOf('--fixture'), input = index < 0 ? '' : process.argv[index + 1];
  ok(input && path.resolve(input).startsWith(path.resolve(os.tmpdir()) + path.sep), 'only explicit generated TEMP fixture');
  const fixture = JSON.parse(fs.readFileSync(path.join(input, 'fixture.json'), 'utf8'));
  const source = path.join(input, 'large.webm');
  ok(fixture.encodedBytes > 100 * MiB && /^new canvas noise/.test(fixture.method), 'real encoded frame fixture');
  eq(fs.statSync(source).size, fixture.bytes);
  const repo = path.join(world, 'repo'), external = path.join(world, 'external'); fs.mkdirSync(repo); fs.mkdirSync(external);
  const movie = path.join(repo, 'large.webm'), outside = path.join(external, 'large.webm'); fs.copyFileSync(source, movie); fs.copyFileSync(source, outside);
  const { createFiles } = await import('../server/files.js');
  const { createExternalGrants } = await import('../server/external-grants.js');
  const { createRouter } = await import('../server/router.js');
  const { createAuth } = await import('../server/auth.js');
  const { createEventBus } = await import('../server/sse.js');
  eventBus = createEventBus();
  let scope = { root: repo, scopeId: 'large-video-fixture', generation: '1', conversationId: null };
  const grants = createExternalGrants(), files = createFiles({ grants, scopeForRequest: async () => scope, publish: eventBus.publish });
  const inspected = grants.inspect({ rawPath: outside, scopeKind: 'file', scope });
  const grant = grants.create({ approval: inspected.approval, scopeKind: 'file', scope }).grant;
  server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  const router = createRouter({ auth: createAuth({ port, token: TOKEN }), sse: eventBus, rpc: { send() {}, abortAndWait() {}, getState() { return {}; } }, files });
  let nextFault = null;
  server.on('request', (req, res) => {
    const fault = nextFault; nextFault = null;
    if (fault) {
      const write = res.write.bind(res); let chunks = 0;
      res.write = (chunk, ...args) => {
        const result = write(chunk, ...args); chunks++;
        if (chunks === 1) {
          fault();
          // Real response backpressure with drain withheld: watchdog must stop
          // this descriptor even without the next media read or client traffic.
          const emit = res.emit; res.emit = function (name, ...values) { if (name === 'drain') return false; return emit.call(this, name, ...values); }; return false;
        }
        return result;
      };
    }
    return router(req, res);
  });
  const request = async (route, range, payload) => {
    const response = await fetch('http://127.0.0.1:' + port + route, { method: payload ? 'POST' : 'GET', headers: { 'x-pi-gui-token': TOKEN, ...(range ? { Range: range } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const grantEvents = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { eventRequest?.destroy(); reject(Error('real SSE subscription timeout')); }, 5000);
    eventRequest = http.get({ host: '127.0.0.1', port, path: '/api/events', agent: false, headers: { 'x-pi-gui-token': TOKEN } }, res => {
      eventResponse = res;
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', text => {
        buffer += text;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (!frame.startsWith('data: ')) continue;
          const event = JSON.parse(frame.slice(6));
          if (event.type === 'external_grants') grantEvents.push({ matchingGrant: event.detail?.revoked === grant.id, sequence: event._seq, replay: event._replay === true });
        }
      });
      res.once('error', reject);
      clearTimeout(timer);
      try {
        eq(res.statusCode, 200); ok(/^text\/event-stream/.test(res.headers['content-type'] || ''), 'real SSE response');
        resolve();
      } catch (error) { reject(error); }
    });
    eventRequest.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const metadata = await request('/api/files/metadata?' + new URLSearchParams({ root: repo, path: 'large.webm' }));
  eq(metadata.status, 200); eq(metadata.body.file.bytes, fixture.bytes);
  const workspaceUrl = '/api/files/content?' + new URLSearchParams({ root: repo, path: 'large.webm', fileId: metadata.body.file.fileId });
  const extMeta = await request('/api/files/external/metadata?' + new URLSearchParams({ path: outside, grant: grant.id }));
  eq(extMeta.status, 200);
  const externalUrl = '/api/files/external/content?' + new URLSearchParams({ path: outside, grant: grant.id, fileId: extMeta.body.file.fileId });
  const stream = (route, range, fault) => new Promise((resolve, reject) => {
    nextFault = fault || null;
    let response, count = 0, maxChunk = 0;
    const hash = createHash('sha256'), started = performance.now();
    const timer = setTimeout(() => { response?.destroy(); reject(Error('bounded real HTTP stream timeout')); }, 5000);
    const req = http.get({ host: '127.0.0.1', port, path: route, agent: false, headers: { 'x-pi-gui-token': TOKEN, Range: range } }, res => {
      response = res;
      res.on('data', bytes => { count += bytes.length; maxChunk = Math.max(maxChunk, bytes.length); hash.update(bytes); });
      res.on('error', () => {});
      res.on('close', () => { clearTimeout(timer); resolve({ range, status: res.statusCode, contentRange: res.headers['content-range'], contentLength: Number(res.headers['content-length']), bytes: count, maxClientChunk: maxChunk, complete: res.complete, sha256: hash.digest('hex'), elapsedMs: Math.round(performance.now() - started) }); });
    });
    req.on('error', error => { clearTimeout(timer); if (!response && error.code === 'ECONNRESET') resolve({ range, status: null, bytes: 0, complete: false, elapsedMs: Math.round(performance.now() - started) }); else if (!response) reject(error); });
  });
  for (const start of [0, 8 * MiB, 16 * MiB, 96 * MiB, fixture.bytes - 65536]) {
    const result = await stream(workspaceUrl, `bytes=${start}-`), end = Math.min(start + 8 * MiB, fixture.bytes) - 1;
    eq(result.status, 206); eq(result.bytes, end - start + 1); eq(result.contentRange, `bytes ${start}-${end}/${fixture.bytes}`); ok(result.complete); eq(result.sha256, await digest(movie, start, end)); rows.push({ name: 'actual video bounded window', ...result });
  }
  for (const range of [`bytes=0-${8 * MiB}`, `bytes=-${8 * MiB + 1}`, 'bytes=0-1,9-10', `bytes=${fixture.bytes}-`]) {
    const response = await request(workspaceUrl, range); eq(response.status, 416); eq(response.body.code, 'range_not_satisfiable'); rows.push({ name: 'unchanged invalid/over-budget Range refused', range, status: response.status });
  }
  let revokeRequest;
  const revoked = await stream(externalUrl, 'bytes=0-', () => {
    // This production route both changes the ledger and publishes via the real
    // event bus. Private IPC / grants.revoke() alone cannot prove SSE delivery.
    revokeRequest = request('/api/files/grants/revoke', null, { id: grant.id });
  });
  eq(revoked.complete, false); ok(revoked.bytes <= 65536, 'no second application chunk disclosed after revoke'); ok(revoked.elapsedMs < 1500, 'revocation watchdog bounded independently of drain'); rows.push({ name: 'real video HTTP revoke while stream stalled', ...revoked });
  const revokeResult = await revokeRequest;
  eq(revokeResult.status, 200); eq(revokeResult.body.ok, true); eq(revokeResult.body.id, grant.id);
  const eventDeadline = performance.now() + 1500;
  while (!grantEvents.length && performance.now() < eventDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  eq(grantEvents.length, 1); eq(grantEvents[0].matchingGrant, true); ok(Number.isSafeInteger(grantEvents[0].sequence) && grantEvents[0].sequence > 0); eq(grantEvents[0].replay, false);
  rows.push({ name: 'HTTP revoke publishes matching live event over real SSE', events: grantEvents });
  const denied = await request(externalUrl, 'bytes=8388608-'); eq(denied.status, 403); eq(denied.body.code, 'grant_invalid');
  const retired = await stream(workspaceUrl, 'bytes=8388608-', () => { scope = { ...scope, generation: '2' }; });
  eq(retired.complete, false); ok(retired.bytes <= 65536); ok(retired.elapsedMs < 1500); rows.push({ name: 'real video workspace retirement while stalled', ...retired });
  const scopeDenied = await request(workspaceUrl, 'bytes=16777216-'); eq(scopeDenied.status, 409);
  fs.writeFileSync(path.join(world, 'report.json'), JSON.stringify({ passed: assertions, failed: 0, fixture, rows, memory: process.memoryUsage(), boundary: 'source production Router/auth/files/grant ledger and real HTTP revoke/SSE transport; generated TEMP video; actual streaming digests; deterministic first-write backpressure fault, not renderer teardown, real slow disk or native dialog' }, null, 2));
  console.log(`Large media backend: ${assertions}/${assertions}; revoke=${revoked.bytes}B/${revoked.elapsedMs}ms; retire=${retired.bytes}B/${retired.elapsedMs}ms; evidence=${world}`);
}
main().catch(error => { process.exitCode = 1; console.error(error); fs.writeFileSync(path.join(world, 'failure.json'), JSON.stringify({ assertions, rows, error: error.message })); }).finally(() => { eventResponse?.destroy(); eventRequest?.destroy(); eventBus?.closeAll(); server?.closeAllConnections(); server?.close(); });
