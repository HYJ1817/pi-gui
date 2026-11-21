'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), https = require('node:https'), net = require('node:net');
const { createSystemProxy } = require('../electron/system-proxy.cjs');
const certificate = require('./fixtures/system-network-tls.cjs');
const moduleUrl = require('node:url').pathToFileURL(require.resolve('../server/system-network-agent.js')).href;
function spawnBackendProbe(body, env) {
  const { spawn } = require('node:child_process');
  // The probe owns its IPC channel; finish it after the now-live policy
  // listener has served its purpose, without extending the process deadline.
  const bootstrap = `(async()=>{(await import(${JSON.stringify(moduleUrl)})).startSystemNetwork();${body}})().catch(()=>process.exitCode=1).finally(()=>{if(process.connected)process.disconnect()});`;
  return spawn(process.execPath, ['-e', bootstrap], { env: { ...env, PI_GUI_DESKTOP: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
}
async function server(t, instance) {
  const sockets = new Set();
  instance.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise(resolve => instance.close(resolve)); });
  return instance.address().port;
}
async function fixture(t) {
  const urls = [], requests = [], tunnels = [];
  const port = await server(t, https.createServer(certificate, (req, res) => { requests.push({ path: req.url, method: req.method, headers: req.headers }); res.setHeader('content-type', 'application/json'); res.end('{"data":[{"id":"offline-model"}]}'); }));
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    tunnels.push(req.url);
    const upstream = net.connect({ host: '127.0.0.1', port }, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.pipe(upstream); upstream.pipe(socket); });
    upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy());
  });
  const proxyPort = await server(t, proxy);
  const bridge = createSystemProxy({ resolveProxy: async url => { urls.push(url); return `PROXY 127.0.0.1:${proxyPort}`; },
    lookup: (_host, _options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }]) });
  await bridge.start(); t.after(() => bridge.stop());
  return { port, urls, requests, tunnels, env: { PI_GUI_SYSTEM_PROXY: bridge.bootstrapURL() } };
}
function request(agent, port) { return new Promise((resolve, reject) => {
  const req = https.get({ host: 'public.example', port, path: '/v1/models', agent }, response => { let body = ''; response.on('data', chunk => body += chunk); response.once('end', () => resolve({ body, status: response.statusCode })); });
  req.once('error', reject);
}); }
test('pinned system agent: real PAC hostname selection, checked-IP CONNECT, TLS hostname and no capability headers at origin', async t => {
  const { createPinnedSystemAgent } = await import('../server/system-network-agent.js');
  const f = await fixture(t);
  const agent = createPinnedSystemAgent({ host: 'public.example', port: f.port, address: '93.184.216.34', env: f.env, tlsOptions: { ca: certificate.cert } });
  t.after(() => agent.destroy());
  const result = await request(agent, f.port);
  assert.equal(result.status, 200); assert.match(result.body, /offline-model/);
  assert.deepEqual(f.urls, [`https://public.example:${f.port}/`]);
  assert.deepEqual(f.tunnels, [`93.184.216.34:${f.port}`]);
  assert.equal(f.requests[0].method, 'GET'); assert.equal(f.requests[0].headers['proxy-authorization'], undefined); assert.equal(f.requests[0].headers['x-pi-gui-route-host'], undefined);
});
test('provider discovery: actual authorized model-directory GET uses the proxy without weakening DNS or consent', async t => {
  const { createPinnedSystemAgent } = await import('../server/system-network-agent.js');
  const { createDiscoveryTransport } = await import('../server/provider-network.js');
  const { createDiscoveryConsentStore } = await import('../server/provider-discovery-consent.js');
  const f = await fixture(t), store = createDiscoveryConsentStore();
  const issued = store.issue({ draftId: 'draft-a', draftRevision: 1, connectionRevision: 1, providerId: 'fixture',
    connection: { baseUrl: `https://public.example:${f.port}/v1`, api: 'openai-completions' }, api: 'openai-completions',
    credentialSource: 'none', credentialRevision: null, rememberTarget: false, loopback: false });
  assert.equal(issued.ok, true);
  let address = '93.184.216.34', opened = 0;
  const discover = createDiscoveryTransport({ consentStore: store, io: { lookup: async () => [{ address, family: 4 }],
    createSystemAgent: options => { opened++; return createPinnedSystemAgent({ ...options, env: f.env, tlsOptions: { ca: certificate.cert } }); } } });
  const url = `https://public.example:${f.port}/v1/models`;
  const result = await discover({ consentId: issued.consentId, url });
  assert.equal(result.ok, true, result.code); assert.equal(result.models[0].id, 'offline-model'); assert.equal(opened, 1);
  assert.deepEqual(f.tunnels, [`93.184.216.34:${f.port}`]);
  address = '169.254.169.254'; assert.equal((await discover({ consentId: issued.consentId, url })).code, 'private_address');
  assert.equal(opened, 1); assert.equal(f.requests.length, 1);
  assert.equal((await discover({ consentId: 'not-authorized', url })).ok, false); assert.equal(opened, 1);
});

test('pinned system agent: HTTPS certificate verification cannot be disabled by connection options', async t => {
  const { createPinnedSystemAgent } = await import('../server/system-network-agent.js');
  const f = await fixture(t);
  const agent = createPinnedSystemAgent({ host: 'public.example', port: f.port, address: '93.184.216.34', env: f.env, tlsOptions: { rejectUnauthorized: false } });
  t.after(() => agent.destroy());
  await assert.rejects(request(agent, f.port), /network_unavailable/); assert.equal(f.requests.length, 0);
});
test('pinned system agent: trusted certificate with the wrong IP SAN is rejected before any HTTP request', async t => {
  const { createPinnedSystemAgent } = await import('../server/system-network-agent.js');
  const f = await fixture(t);
  const agent = createPinnedSystemAgent({ host: '93.184.216.34', port: f.port, address: '93.184.216.34', env: f.env,
    tlsOptions: { ca: certificate.cert, checkServerIdentity: () => undefined } });
  t.after(() => agent.destroy());
  await assert.rejects(request(agent, f.port), /network_unavailable/);
  assert.equal(f.requests.length, 0);
});

test('backend startup consumes the relaxed-policy marker before downstream child construction', async () => {
  const { startSystemNetwork } = await import('../server/system-network-agent.js');
  const env = { PI_GUI_DESKTOP: '1', PI_GUI_NETWORK_RELAXED: '1' };
  assert.deepEqual(startSystemNetwork(env), { desktop: true, relaxed: true, endpointGeneration: 0, controlPorts: [] });
  assert.equal(env.PI_GUI_NETWORK_RELAXED, undefined);
  assert.throws(() => startSystemNetwork({ PI_GUI_DESKTOP: '1', PI_GUI_SYSTEM_PROXY: 'broken' }), /network_transport_unsupported/);
});

test('private transport capability is removed from every proxy environment spelling for arbitrary children', async () => {
  const { scrubInternalEnv } = await import('../server/child-env.js');
  const gateway = 'http://pi-gui:pi-proxy-token-' + 'a'.repeat(64) + '@127.0.0.1:1234';
  const cleaned = scrubInternalEnv({ PI_GUI_SYSTEM_PROXY: gateway, pi_gui_system_proxy: gateway,
    HTTP_PROXY: gateway, https_proxy: gateway, All_Proxy: gateway, PI_GUI_TOKEN: 'private', PI_GUI_NETWORK_RELAXED: '1',
    NO_PROXY: 'localhost', PATH: 'fixture', USER_SETTING: 'keep' });
  assert.deepEqual(cleaned, { NO_PROXY: 'localhost', PATH: 'fixture', USER_SETTING: 'keep' });
});

test('MCP desktop policy: internal gateway does not turn system DIRECT into an ambient-proxy conflict; relaxed Fake-IP requires proven proxy', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-market-system-policy-')); t.after(() => fs.rm(root, { force: true, recursive: true }));
  const { createMcpMarket } = await import('../server/mcp-market.js');
  const internals = createMcpMarket({ dataDir: root, registryCache: false })._internals;
  const gateway = 'http://pi-gui:pi-proxy-token-' + 'a'.repeat(64) + '@127.0.0.1:1234';
  let calls = 0, route = 'direct';
  const network = { resolveRoute: async () => route, fetchProxied: async () => { calls++; return { ok: true, status: 200, body: '{}', headers: { 'content-type': 'application/json' } }; } };
  const env = { PI_GUI_DESKTOP: '1', PI_GUI_SYSTEM_PROXY: gateway, HTTPS_PROXY: gateway, PI_GUI_NETWORK_RELAXED: '0' };
  assert.equal((await internals.resolveMarketRoute(new URL('https://market.example'), { env, network })).route, 'direct');
  route = 'proxied';
  const options = { env, network, lookupImpl: async () => [{ address: '198.18.0.1', family: 4 }] };
  assert.equal((await internals.fetchJson('https://market.example', options)).ok, false); assert.equal(calls, 0);
  env.PI_GUI_NETWORK_RELAXED = '1';
  assert.equal((await internals.fetchJson('https://market.example', options)).ok, true); assert.equal(calls, 1);
  route = 'direct';
  assert.equal((await internals.fetchJson('https://market.example', options)).ok, false); assert.equal(calls, 1);
  route = 'proxied'; options.lookupImpl = async () => [{ address: '198.18.0.1', family: 4 }, { address: '127.0.0.1', family: 4 }];
  assert.equal((await internals.fetchJson('https://market.example', options)).ok, false); assert.equal(calls, 1);
  const external = { ...env, HTTPS_PROXY: 'http://external-proxy.invalid:8080' }; route = 'direct';
  assert.equal((await internals.resolveMarketRoute(new URL('https://market.example'), { env: external, network })).route, 'unknown');
});

test('actual backend Node startup sends fetch and node:http through the gateway, but loopback control stays direct', async t => {
  if (typeof http.setGlobalProxyFromEnv !== 'function') { t.skip('native Node proxy API unavailable; desktop Electron 44 uses Node 24'); return; }
  const paths = [], tunnels = [];
  const port = await server(t, http.createServer((req, res) => { paths.push(req.url); assert.equal(req.headers['proxy-authorization'], undefined); res.end('offline'); }));
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    tunnels.push(req.url);
    const upstream = net.connect({ host: '127.0.0.1', port }, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.pipe(upstream); upstream.pipe(socket); });
    upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy());
  });
  const proxyPort = await server(t, proxy);
  const bridge = createSystemProxy({ resolveProxy: async () => `PROXY 127.0.0.1:${proxyPort}`,
    lookup: (_host, _options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }]) });
  await bridge.start(); t.after(() => bridge.stop());
  const code = `await (async()=>{
    const http=require('node:http');
    const { spawnSync } = require('node:child_process');
    const inherited = spawnSync(process.execPath, ['-e', \"if(Object.keys(process.env).some(k=>k.toLowerCase()==='pi_gui_system_proxy'||String(process.env[k]).includes('pi-proxy-token-')))process.exit(7)\"], { stdio: 'ignore' });
    if (inherited.status !== 0) throw Error('transport capability leaked to child');
    if(await(await fetch('http://public.example:${port}/node-fetch')).text()!=='offline')throw Error('response');
    await new Promise((resolve,reject)=>{http.get('http://public.example:${port}/node-http',r=>{r.resume();r.on('end',resolve)}).on('error',reject)});
    if(await(await fetch('http://127.0.0.1:${port}/private-control')).text()!=='offline')throw Error('response');
  })().catch(()=>{process.exitCode=1});`;
  const { withoutProxyEnvironment } = require('../lib/system-network-policy.cjs');
  const child = spawnBackendProbe(code, { ...withoutProxyEnvironment(process.env), PI_GUI_SYSTEM_PROXY: bridge.bootstrapURL() });
  const timer = setTimeout(() => child.kill(), 10000); t.after(() => clearTimeout(timer));
  assert.equal(await new Promise((resolve,reject) => { child.once('error',reject); child.once('exit',resolve); }), 0);
  assert.deepEqual(paths, ['/node-fetch', '/node-http', '/private-control']);
  assert.ok(tunnels.length >= 1); assert.ok(tunnels.every(value => value === `93.184.216.34:${port}`));
});

test('actual backend HTTPS uses the proxy with original hostname and TLS validation, not global insecure flags', async t => {
  if (typeof http.setGlobalProxyFromEnv !== 'function') { t.skip('native Node proxy API unavailable; desktop Electron 44 uses Node 24'); return; }
  const { withoutProxyEnvironment } = require('../lib/system-network-policy.cjs');
  const f = await fixture(t);
  const code = `await (async()=>{
    const https=require('node:https');
    try { await fetch('https://public.example:${f.port}/must-reject-untrusted'); process.exitCode=2; return; } catch {}
    await new Promise((resolve,reject)=>{https.get('https://public.example:${f.port}/native-https',{ca:${JSON.stringify(certificate.cert)}},r=>{r.resume();r.on('end',resolve)}).on('error',reject)});
  })().catch(()=>{process.exitCode=1});`;
  const child = spawnBackendProbe(code, { ...withoutProxyEnvironment(process.env), PI_GUI_SYSTEM_PROXY: f.env.PI_GUI_SYSTEM_PROXY });
  const timer = setTimeout(() => child.kill(), 10000); t.after(() => clearTimeout(timer));
  assert.equal(await new Promise((resolve,reject) => { child.once('error',reject); child.once('exit',resolve); }), 0);
  assert.deepEqual(f.requests.map(r => r.path), ['/native-https']);
  assert.ok(f.tunnels.length >= 2); assert.ok(f.tunnels.every(value => value === `93.184.216.34:${f.port}`));
  assert.ok(f.urls.every(url => url === `https://public.example:${f.port}/`));
});

test('actual Auth and title SDK workers use the main proxy for fetch and node:http without exporting GUI tokens', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-system-sdk-proxy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requests = [], tunnels = [];
  const port = await server(t, http.createServer((req, res) => {
    requests.push({ path: req.url, proxyAuth: req.headers['proxy-authorization'] }); res.end('offline-probe');
  }));
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    tunnels.push(req.url);
    const upstream = net.connect({ host: '127.0.0.1', port }, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.pipe(upstream); upstream.pipe(socket); });
    upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy());
  });
  const proxyPort = await server(t, proxy);
  const bridge = createSystemProxy({ resolveProxy: async () => `PROXY 127.0.0.1:${proxyPort}`,
    lookup: (_host, _options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }]) });
  await bridge.start(); t.after(() => bridge.stop());
  const env = { PI_GUI_SYSTEM_PROXY: bridge.bootstrapURL(), PI_GUI_TOKEN: 'must-not-reach-worker' };
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.5.0', exports: { '.': { import: './sdk.mjs' } } }));
  await fs.writeFile(path.join(root, 'sdk.mjs'), `
    import http from 'node:http';
    async function probe() {
      if (process.env.PI_GUI_TOKEN || process.env.PI_GUI_SYSTEM_PROXY
        || Object.values(process.env).some(v=>v.includes('pi-proxy-token-'))) throw Error('token_leaked');
      const response = await fetch('http://public.example:${port}/fetch');
      if (await response.text() !== 'offline-probe') throw Error('bad_fixture');
      await new Promise((resolve,reject) => { const r=http.get('http://public.example:${port}/http', res=>{res.resume();res.on('end',resolve)});r.on('error',reject); });
    }
    export class ModelRuntime {
      static async create(options) { if (options.allowModelNetwork !== false) throw Error('catalog_network'); return new ModelRuntime(); }
      getProviders() { return [{id:'fixture',auth:{oauth:{name:'Fixture',login(){}}}}]; }
      async listCredentials() { return []; }
      async checkAuth() { await probe(); return null; }
      async login() {} async logout() {}
      getModel() { return {id:'fixture',provider:'fixture'}; }
      async completeSimple() { await probe(); return {stopReason:'stop',content:[{type:'text',text:'Offline title'}]}; }
    }
  `);
  const { createAuthSdk } = await import('../server/provider-auth-sdk.js');
  const { createSessionTitleSdk } = await import('../server/session-title-sdk.js');
  const auth = createAuthSdk({ resolvePackageDir: () => root, env }); t.after(() => auth.dispose());
  const titles = createSessionTitleSdk({ resolvePackageDir: () => root, env }); t.after(() => titles.dispose());
  assert.equal((await auth.list()).capability.sdkAvailable, true);
  const title = await titles.generate({ providerId: 'fixture', modelId: 'fixture', system: 'Offline fixture only', user: 'No model called' });
  assert.equal(title.ok, true, title.code); assert.equal(title.text, 'Offline title');
  assert.deepEqual(requests.map(r => r.path), ['/fetch', '/http', '/fetch', '/http']);
  assert.ok(tunnels.length >= 2); assert.ok(tunnels.every(value => value === `93.184.216.34:${port}`));
  assert.ok(requests.every(r => r.proxyAuth === undefined));
});

test('pinned system agent: no ambient/global proxy is treated as a main-issued private capability', async () => {
  const { createPinnedSystemAgent } = await import('../server/system-network-agent.js');
  for (const env of [{}, { HTTPS_PROXY: 'http://user:SECRET@example.com' }, { PI_GUI_SYSTEM_PROXY: 'http://pi-gui:bad@127.0.0.1:1234' }]) assert.equal(createPinnedSystemAgent({ host: 'public.example', port: 443, address: '93.184.216.34', env }), null);
});
