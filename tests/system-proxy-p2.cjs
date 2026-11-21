'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), https = require('node:https'), net = require('node:net'), tls = require('node:tls');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { openTunnel, route } = require('../electron/system-proxy-transport.cjs');
const { createSystemProxy } = require('../electron/system-proxy.cjs');
const fixtureLookup = (_host, options, callback) => callback(null, options.all
  ? [{ address: '93.184.216.34', family: 4 }] : '93.184.216.34', 4);
const { createSystemConnectionTest } = require('../electron/system-network-test.cjs');
const certificate = require('./fixtures/system-network-tls.cjs');

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
async function echo(t) { return listen(t, net.createServer(socket => socket.pipe(socket))); }
async function httpProxy(t, targetPort, { secure = false, code = 200 } = {}) {
  const seen = [], server = secure ? https.createServer(certificate) : http.createServer();
  server.on('connect', (req, socket) => {
    seen.push({ authority: req.url, auth: req.headers['proxy-authorization'] });
    if (code !== 200) { socket.end(`HTTP/1.1 ${code} Rejected\r\n\r\n`); return; }
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.pipe(upstream); upstream.pipe(socket);
    });
    socket.on('close', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
  });
  return { port: await listen(t, server), seen };
}
async function socksProxy(t, targetPort) {
  const seen = [];
  const server = net.createServer(socket => {
    let stage = 0, pending = Buffer.alloc(0);
    const data = chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (stage === 0 && pending.length >= 3) {
        assert.deepEqual([...pending.subarray(0, 3)], [5, 1, 0]); pending = pending.subarray(3); stage = 1; socket.write(Buffer.from([5, 0]));
      }
      if (stage === 1 && pending.length >= 5 && pending.length >= 7 + pending[4]) {
        assert.equal(pending[3], 3); seen.push(pending.subarray(5, 5 + pending[4]).toString());
        socket.removeListener('data', data);
        const upstream = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); socket.pipe(upstream); upstream.pipe(socket);
        });
        socket.on('close', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
      }
    }; socket.on('data', data);
  });
  return { port: await listen(t, server), seen };
}
async function roundtrip(socket) {
  const text = 'opaque-network-fixture';
  const reply = new Promise((resolve, reject) => { socket.once('data', chunk => resolve(chunk.toString())); socket.once('error', reject); });
  socket.write(text); socket.resume(); assert.equal(await reply, text); socket.destroy();
}

test('route parsing never turns an unsupported or failed proxy into a direct request', () => {
  assert.equal(route('DIRECT').protocol, 'direct');
  assert.equal(route('PROXY 127.0.0.1:99; DIRECT').protocol, 'http');
  assert.equal(route('HTTPS [::1]:99').protocol, 'https');
  for (const value of ['', 'unknown host:80', 'PAC http://host', 'PROXY user:SECRET@host:80', 'SOCKS5 host:99999']) assert.throws(() => route(value));
});
test('actual direct TCP tunnel respects the provided pinned lookup', async t => {
  const port = await echo(t); let lookups = 0;
  const socket = await openTunnel({ host: 'public.example', port, directLookup: (_host, options, callback) => {
    lookups++; options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4);
  } });
  await roundtrip(socket); assert.ok(lookups > 0);
});
test('actual HTTP CONNECT does not forward local authorization or resolve target DNS locally', async t => {
  const port = await echo(t), proxy = await httpProxy(t, port);
  await roundtrip(await openTunnel({ host: 'public.example', port, proxyRoute: `PROXY 127.0.0.1:${proxy.port}` }));
  assert.deepEqual(proxy.seen, [{ authority: `public.example:${port}`, auth: undefined }]);
});
test('actual HTTPS proxy checks certificates; only per-request fixture CA is accepted', async t => {
  const port = await echo(t), proxy = await httpProxy(t, port, { secure: true });
  await assert.rejects(openTunnel({ host: 'public.example', port, proxyRoute: `HTTPS 127.0.0.1:${proxy.port}` }), { code: 'tls_failed' });
  await roundtrip(await openTunnel({ host: 'public.example', port, proxyRoute: `HTTPS 127.0.0.1:${proxy.port}`, tlsOptions: { ca: certificate.cert } }));
  assert.equal(proxy.seen.length, 1);
});
test('actual SOCKS5 transports target hostname without claiming local DNS pinning', async t => {
  const port = await echo(t), proxy = await socksProxy(t, port);
  await roundtrip(await openTunnel({ host: 'public.example', port, proxyRoute: `SOCKS5 127.0.0.1:${proxy.port}` }));
  assert.deepEqual(proxy.seen, ['public.example']);
});
test('actual proxy authentication failure and deadline are bounded, with no DIRECT fallback', async t => {
  const port = await echo(t), proxy = await httpProxy(t, port, { code: 407 });
  await assert.rejects(openTunnel({ host: 'public.example', port, proxyRoute: `PROXY 127.0.0.1:${proxy.port}; DIRECT` }), { code: 'proxy_auth_required' });
  const stalled = await listen(t, net.createServer(() => {}));
  await assert.rejects(openTunnel({ host: 'public.example', port, proxyRoute: `PROXY 127.0.0.1:${stalled}`, timeoutMs: 30 }), { code: 'timeout' });
});
test('PAC fallback tries the next supported proxy but never a DIRECT fallback', async t => {
  const port = await echo(t), denied = await httpProxy(t, port, { code: 502 }), working = await httpProxy(t, port);
  await roundtrip(await openTunnel({ host: 'public.example', port,
    proxyRoute: `PROXY 127.0.0.1:${denied.port}; PROXY 127.0.0.1:${working.port}; DIRECT` }));
  assert.equal(denied.seen.length, 1);
  assert.equal(working.seen.length, 1);
  await assert.rejects(openTunnel({ host: '127.0.0.1', port,
    proxyRoute: `PROXY 127.0.0.1:${denied.port}; DIRECT` }), { code: 'proxy_unreachable' });
  assert.throws(() => route('SOCKS 127.0.0.1:1080'), { code: 'proxy_unreachable' });
});

async function gatewayConnect(gateway, host, port) {
  const endpoint = new URL(gateway.bootstrapURL());
  return new Promise((resolve, reject) => {
    const req = http.request({ host: endpoint.hostname, port: endpoint.port, method: 'CONNECT', path: `${host}:${port}`,
      headers: { 'Proxy-Authorization': 'Basic ' + Buffer.from(endpoint.username + ':' + endpoint.password).toString('base64') } });
    req.once('connect', (res, socket) => resolve({ status: res.statusCode, socket }));
    req.once('error', reject); req.end();
  });
}

test('authenticated gateway accepts a public PAC proxy prefix without ever using its DIRECT fallback', async t => {
  let directAttempts = 0;
  const nativeConnect = net.connect;
  t.mock.method(net, 'connect', function (options, ...args) {
    if (typeof options === 'object' && !['127.0.0.1', '::1', 'localhost'].includes(options.host)) {
      directAttempts++;
      throw Error('offline fixture forbids a public socket');
    }
    return nativeConnect.call(this, options, ...args);
  });
  const port = await echo(t), denied = await httpProxy(t, port, { code: 502 }), working = await httpProxy(t, port);
  let proxyRoute = `PROXY 127.0.0.1:${denied.port}; PROXY 127.0.0.1:${working.port}; DIRECT`;
  const gateway = createSystemProxy({ resolveProxy: async () => proxyRoute, lookup: fixtureLookup });
  await gateway.start(); t.after(() => gateway.stop());
  const connected = await gatewayConnect(gateway, 'public.example', port);
  t.after(() => connected.socket.destroy());
  assert.equal(connected.status, 200);
  await roundtrip(connected.socket);
  assert.deepEqual(working.seen, [{ authority: `93.184.216.34:${port}`, auth: undefined }]);
  assert.equal(denied.seen.length, 1);

  proxyRoute = `PROXY 127.0.0.1:${denied.port}; DIRECT`;
  const failed = await gatewayConnect(gateway, 'public.example', port); failed.socket.destroy();
  assert.equal(failed.status, 502);
  proxyRoute = Array(4).fill(`PROXY 127.0.0.1:${denied.port}`).join('; ') + `; PROXY 127.0.0.1:${working.port}; DIRECT`;
  const bounded = await gatewayConnect(gateway, 'public.example', port); bounded.socket.destroy();
  assert.equal(bounded.status, 502);
  assert.equal(denied.seen.length, 6, 'at most four proxy candidates per gateway request');
  assert.equal(working.seen.length, 1);
  assert.equal(directAttempts, 0);
});

test('gateway PAC compatibility cannot authorize Fake-IP, mixed private DNS or unsupported routes', async t => {
  const port = await echo(t), working = await httpProxy(t, port);
  let proxyRoute = `PROXY 127.0.0.1:${working.port}; DIRECT`;
  let answers = [{ address: '198.18.0.1', family: 4 }];
  const gateway = createSystemProxy({ resolveProxy: async () => proxyRoute, relaxed: true,
    lookup: (_host, _options, callback) => callback(null, answers) });
  await gateway.start(); t.after(() => gateway.stop());
  for (const values of [[{ address: '198.18.0.1', family: 4 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]]) {
    answers = values;
    const result = await gatewayConnect(gateway, 'public.example', port); result.socket.destroy();
    assert.equal(result.status, 502);
  }
  answers = [{ address: '93.184.216.34', family: 4 }];
  for (const value of [`SOCKS 127.0.0.1:${working.port}; DIRECT`,
    `PROXY 127.0.0.1:${working.port}; INVALID; DIRECT`, `DIRECT; PROXY 127.0.0.1:${working.port}`]) {
    proxyRoute = value;
    const result = await gatewayConnect(gateway, 'public.example', port); result.socket.destroy();
    assert.equal(result.status, 502);
  }
  assert.equal(working.seen.length, 0, 'rejected routes and DNS answers cannot reach a proxy');
});

test('connection test: timeout retains one isolated routing slot until native work actually settles', async () => {
  let createCount = 0, release;
  const probe = createSystemConnectionTest({ timeoutMs: 20,
    createSession: () => { createCount++; return { setProxy: () => new Promise(resolve => release = resolve), resolveProxy: async () => 'DIRECT' }; },
    lookup: async () => [] });
  const config = { mode: 'system', proxy: '', bypass: '', relaxed: false };
  assert.equal((await probe(config)).code, 'timeout');
  assert.equal((await probe(config)).code, 'timeout');
  assert.equal(createCount, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  const next = probe(config); await Promise.resolve(); release();
  assert.equal((await next).code, 'dns_failed');
  assert.equal(createCount, 1);
});

test('connection test: actual TLS HEAD, checked IP CONNECT, redirect denial and no model request', async t => {
  const seen = []; let status = 200;
  const targetPort = await listen(t, https.createServer(certificate, (req, res) => { seen.push(req.method + ' ' + req.url); res.writeHead(status, { Location: 'http://127.0.0.1/private' }); res.end(); }));
  const proxy = await httpProxy(t, targetPort);
  const createSession = () => ({ setProxy: async () => {}, resolveProxy: async () => `PROXY 127.0.0.1:${proxy.port}` });
  const options = { createSession, target: `https://public.example:${targetPort}/fixed-ping`,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }], tlsOptions: { ca: certificate.cert } };
  const probe = createSystemConnectionTest(options);
  assert.equal((await probe({ mode: 'system', proxy: '', bypass: '', relaxed: false })).code, 'connected');
  assert.equal(proxy.seen[0].authority, `93.184.216.34:${targetPort}`, 'strict proxy DNS cannot replace the checked target IP');
  status = 302; assert.equal((await probe({ mode: 'direct', proxy: '', bypass: '', relaxed: false })).ok, false);
  assert.deepEqual(seen, ['HEAD /fixed-ping', 'HEAD /fixed-ping']);
  const noCa = createSystemConnectionTest({ ...options, tlsOptions: {} });
  assert.equal((await noCa({ mode: 'system', proxy: '', bypass: '', relaxed: false })).code, 'tls_failed');
});
test('connection test: Fake-IP requires independent opt-in AND proven proxy; private/mixed answers remain blocked', async t => {
  const targetPort = await listen(t, https.createServer(certificate, (_req, res) => res.end()));
  const proxy = await httpProxy(t, targetPort);
  let proxyRoute = `PROXY 127.0.0.1:${proxy.port}`, answers = [{ address: '198.18.0.2', family: 4 }];
  const probe = createSystemConnectionTest({ target: `https://public.example:${targetPort}/`, tlsOptions: { ca: certificate.cert },
    lookup: async () => answers, createSession: () => ({ setProxy: async () => {}, resolveProxy: async () => proxyRoute }) });
  const config = { mode: 'system', proxy: '', bypass: '', relaxed: false };
  assert.equal((await probe(config)).code, 'target_blocked'); assert.equal(proxy.seen.length, 0);
  assert.equal((await probe({ ...config, relaxed: true })).code, 'connected');
  assert.equal(proxy.seen.at(-1).authority, `public.example:${targetPort}`, 'Fake-IP is never misrepresented as a real pinned public IP');
  proxyRoute = 'DIRECT'; assert.equal((await probe({ ...config, relaxed: true })).code, 'target_blocked');
  answers = [{ address: '198.18.0.2', family: 4 }, { address: '127.0.0.1', family: 4 }];
  proxyRoute = `PROXY 127.0.0.1:${proxy.port}`;
  assert.equal((await probe({ ...config, relaxed: true })).code, 'target_blocked'); assert.equal(proxy.seen.length, 1);
});
test('local bridge requires its one-instance credential; a renderer Origin cannot use it', async t => {
  let resolved = 0;
  const gateway = createSystemProxy({ resolveProxy: async () => { resolved++; return 'DIRECT'; } });
  await gateway.start(); t.after(() => gateway.stop());
  const url = new URL(gateway.bootstrapURL());
  const request = headers => new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: 'http://public.example/', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(await request({}), 407);
  assert.equal(await request({ 'Proxy-Authorization': 'Basic ' + Buffer.from(url.username + ':' + url.password).toString('base64'), Origin: 'http://127.0.0.1:7788' }), 407);
  assert.equal(resolved, 0);
});
test('even an authenticated bridge cannot forward to internal control services or itself', async t => {
  let hits = 0, route;
  const port = await listen(t, http.createServer((_req, res) => { hits++; res.end('must not forward'); }));
  const gateway = createSystemProxy({ resolveProxy: async () => route, lookup: fixtureLookup });
  await gateway.start(); t.after(() => gateway.stop());
  const own = new URL(gateway.bootstrapURL());
  route = `PROXY 127.0.0.1:${own.port}`;
  const send = value => new Promise((resolve, reject) => {
    const req = http.request({ host: own.hostname, port: own.port, path: value,
      headers: { 'Proxy-Authorization': 'Basic ' + Buffer.from(own.username + ':' + own.password).toString('base64') } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }); req.on('error', reject); req.end();
  });
  for (const value of [`http://127.0.0.1:${port}/api/`, `http://[::1]:${port}/api/`,
    `http://[::ffff:127.0.0.1]:${port}/api/`, `http://localhost:${port}/api/`, 'http://public.example/']) {
    assert.equal(await send(value), 502);
  }
  assert.equal(hits, 0);
});

test('bridge checks every target DNS answer and permits Fake-IP only on an explicitly relaxed proxy route', async t => {
  const connections = [];
  const upstream = http.createServer();
  upstream.on('connect', (req, socket) => {
    connections.push(req.url);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  });
  const upstreamPort = await listen(t, upstream);
  let answers = [{ address: '93.184.216.34', family: 4 }], routeValue = `PROXY 127.0.0.1:${upstreamPort}`;
  const gateway = createSystemProxy({ resolveProxy: async () => routeValue, relaxed: false,
    lookup: (_host, _options, callback) => callback(null, answers) });
  await gateway.start(); t.after(() => gateway.stop());
  const endpoint = new URL(gateway.bootstrapURL());
  const connect = (host, port) => new Promise(resolve => {
    const socket = net.connect(+endpoint.port, endpoint.hostname, () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: Basic ${Buffer.from(endpoint.username+':'+endpoint.password).toString('base64')}\r\n\r\n`));
    let response = ''; socket.on('data', chunk => { response += chunk.toString('latin1'); socket.destroy(); });
    socket.on('error', () => resolve(response)); socket.on('close', () => resolve(response));
  });
  assert.ok((await connect('public.example', 443)).startsWith('HTTP/1.1 200'));
  assert.deepEqual(connections, ['93.184.216.34:443']);
  answers = [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.8', family: 4 }];
  assert.ok((await connect('mixed.example', 443)).startsWith('HTTP/1.1 502'));
  assert.equal(connections.length, 1);
  answers = [{ address: '198.18.0.1', family: 4 }];
  assert.ok((await connect('fake.example', 443)).startsWith('HTTP/1.1 502'));
  assert.equal(connections.length, 1);
  const relaxed = createSystemProxy({ resolveProxy: async () => routeValue, relaxed: true,
    lookup: (_host, _options, callback) => callback(null, answers) });
  await relaxed.start(); t.after(() => relaxed.stop());
  const relaxedUrl = new URL(relaxed.bootstrapURL());
  const fakeResponse = await new Promise(resolve => {
    const socket = net.connect(+relaxedUrl.port, relaxedUrl.hostname, () => socket.write(`CONNECT fake.example:443 HTTP/1.1\r\nHost: fake.example:443\r\nProxy-Authorization: Basic ${Buffer.from(relaxedUrl.username+':'+relaxedUrl.password).toString('base64')}\r\n\r\n`));
    let response = ''; socket.on('data', chunk => { response += chunk.toString('latin1'); socket.destroy(); });
    socket.on('error', () => resolve(response)); socket.on('close', () => resolve(response));
  });
  assert.ok(fakeResponse.startsWith('HTTP/1.1 200'));
  assert.deepEqual(connections, ['93.184.216.34:443', 'fake.example:443']);
  answers = [{ address: '93.184.216.34', family: 4 }, { address: '198.18.0.1', family: 4 }];
  const mixedFake = await new Promise(resolve => {
    const socket = net.connect(+relaxedUrl.port, relaxedUrl.hostname, () => socket.write(`CONNECT mixed-fake.example:443 HTTP/1.1\r\nHost: mixed-fake.example:443\r\nProxy-Authorization: Basic ${Buffer.from(relaxedUrl.username+':'+relaxedUrl.password).toString('base64')}\r\n\r\n`));
    let response = ''; socket.on('data', chunk => { response += chunk.toString('latin1'); socket.destroy(); });
    socket.on('error', () => resolve(response)); socket.on('close', () => resolve(response));
  });
  assert.ok(mixedFake.startsWith('HTTP/1.1 200'));
  assert.deepEqual(connections, ['93.184.216.34:443', 'fake.example:443', 'mixed-fake.example:443']);
  routeValue = 'DIRECT';
  assert.ok((await connect('direct-fake.example', 443)).startsWith('HTTP/1.1 502'));
});

test('real Node HTTP, fetch and an explicitly initialized worker use the private gateway without child inheritance', async t => {
  const requests = [];
  const originPort = await listen(t, http.createServer((req, res) => { requests.push({ path: req.url, auth: req.headers['proxy-authorization'] }); res.end('fixture-response'); }));
  const upstream = await httpProxy(t, originPort);
  const gateway = createSystemProxy({ resolveProxy: async () => `PROXY 127.0.0.1:${upstream.port}`, lookup: fixtureLookup });
  await gateway.start(); t.after(() => gateway.stop());
  const workerProbe = `const { workerData, parentPort } = require('node:worker_threads');
    if (process.env.PI_GUI_SYSTEM_PROXY || workerData.systemProxy) process.exit(8);
    fetch(workerData.url).then(r => r.text()).then(value => parentPort.postMessage(value)).catch(() => process.exit(9));`;
  const runtime = require('node:url').pathToFileURL(require.resolve('../server/system-network-agent.js')).href;
  const offline = require.resolve('./fixtures/system-settings-offline.cjs');
  const childCheck = `if (Object.entries(process.env).some(([key, value]) =>
    ['pi_gui_system_proxy','pi_gui_network_relaxed'].includes(key.toLowerCase()) || value.includes('pi-proxy-token-'))) process.exit(7);`;
  const code = `
    const assert = require('node:assert/strict');
    const http = require('node:http');
    const { Worker } = require('node:worker_threads');
    const { spawnSync } = require('node:child_process');
    const target = process.argv[1];
    let stage = 'startup';
    (async () => {
      const { startSystemNetwork, systemWorkerProxy, systemWorkerProxyPrelude } = await import(${JSON.stringify(runtime)});
      startSystemNetwork();
      stage = 'child_env';
      const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(childCheck)}], { stdio: 'ignore', timeout: 5000 });
      assert.equal(child.status, 0);
      stage = 'http';
      const body = await new Promise((resolve, reject) => {
        http.get(target + '/http', response => {
          let data = ''; response.on('data', chunk => data += chunk); response.on('error', reject); response.once('end', () => resolve(data));
        }).once('error', reject);
      });
      assert.equal(body, 'fixture-response');
      stage = 'fetch';
      assert.equal(await (await fetch(target + '/fetch')).text(), 'fixture-response');
      stage = 'worker';
      const proxy = systemWorkerProxy();
      await new Promise((resolve, reject) => {
        const worker = new Worker(systemWorkerProxyPrelude(proxy) + ${JSON.stringify(workerProbe)}, {
          eval: true, env: { ...process.env }, workerData: { url: target + '/worker', systemProxy: proxy },
        });
        let value; worker.once('message', result => { value = result; });
        worker.once('error', reject);
        worker.once('exit', exit => exit === 0 && value === 'fixture-response' ? resolve() : reject(Error('worker_failed')));
      });
      console.log('http/fetch/worker:3');
    })().catch(() => { console.error('probe_failed:' + stage); process.exitCode = 1; })
      .finally(() => { if (process.connected) process.disconnect(); });`;
  const { withoutProxyEnvironment } = require('../lib/system-network-policy.cjs');
  const env = { ...withoutProxyEnvironment(process.env), PI_GUI_DESKTOP: '1', PI_GUI_SYSTEM_PROXY: gateway.bootstrapURL(), PI_GUI_NETWORK_RELAXED: '1' };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'NODE_OPTIONS') delete env[key];
  const child = spawn(process.execPath, ['--require', offline, '-e', code, `http://public.example:${originPort}`], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 10000,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const childExitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const stage = /probe_failed:(startup|child_env|http|fetch|worker)/.exec(stderr)?.[1];
  assert.equal(childExitCode, 0, 'offline transport probe failed at: ' + (stage || 'unknown'));
  assert.match(stdout, /http\/fetch\/worker:3/);
  assert.deepEqual(requests.map(request => request.path), ['/http', '/fetch', '/worker']);
  assert.ok(upstream.seen.length >= 3);
  assert.ok(upstream.seen.every(request => request.authority === `93.184.216.34:${originPort}`));
  assert.ok(requests.every(request => request.auth === undefined), 'bridge credential never reaches origin');
});
