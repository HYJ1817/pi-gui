'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const tlsFixture = require('./fixtures/system-network-tls.cjs');
const policy = require('../lib/system-network-policy.cjs');

const PRIVATE_PROXY_KEY = policy.PRIVATE_PROXY_KEY;
const MARKER_PREFIX = 'PI_GUI_NETWORK_FIXTURE_';
const load = name => import(pathToFileURL(path.resolve(__dirname, '../server', name)).href);
const waitFor = async predicate => {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error('fixture_timeout');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
};

async function world(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `pi-pi-network-${name}-`));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch { /* cleanup is best-effort after assertions */ }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, cleanups };
}

async function listen(worldState, server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  worldState.cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

function authorityOf(value) {
  const parsed = new URL(`http://${value}`);
  return { hostname: parsed.hostname, port: Number(parsed.port) };
}

async function modelServer(worldState, marker, certFile, hold = false) {
  let hits = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const server = https.createServer({ key: tlsFixture.key, cert: tlsFixture.cert }, async (request, response) => {
    hits++;
    request.resume();
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.statusCode = 404;
      response.end();
      return;
    }
    if (hold) await pending;
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      connection: 'close',
      'cache-control': 'no-cache'
    });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: marker } }] })}\n\ndata: [DONE]\n\n`);
  });
  const port = await listen(worldState, server);
  await fs.writeFile(certFile, tlsFixture.cert, 'utf8');
  return { port, get hits() { return hits; }, host: '127.0.0.1', release };
}

async function httpProxy(worldState, targetPort, statusCode = 200) {
  const seen = [];
  const server = http.createServer();
  server.on('connect', (request, socket, head) => {
    const authority = authorityOf(request.url);
    seen.push(authority);
    if (statusCode !== 200) {
      socket.end(`HTTP/1.1 ${statusCode} Rejected\r\nConnection: close\r\n\r\n`);
      return;
    }
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
    const close = () => { socket.destroy(); upstream.destroy(); };
    socket.once('close', () => upstream.destroy());
    upstream.once('close', () => socket.destroy());
    socket.once('error', close);
    upstream.once('error', close);
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  });
  const port = await listen(worldState, server);
  return { port, seen };
}

async function socksProxy(worldState, targetPort) {
  const seen = [];
  const server = net.createServer(socket => {
    let pending = Buffer.alloc(0);
    let stage = 0;
    const reject = () => socket.destroy();
    const onData = chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (stage === 0) {
        if (pending.length < 3) return;
        if (pending[0] !== 5 || pending[1] !== 1 || pending[2] !== 0) return reject();
        pending = pending.subarray(3);
        stage = 1;
        socket.write(Buffer.from([5, 0]));
      }
      if (stage !== 1 || pending.length < 5) return;
      if (pending[0] !== 5 || pending[1] !== 1 || pending[3] !== 3) return reject();
      const length = pending[4];
      if (pending.length < 7 + length) return;
      const hostname = pending.subarray(5, 5 + length).toString('ascii');
      const port = pending.readUInt16BE(5 + length);
      seen.push({ hostname, port });
      pending = pending.subarray(7 + length);
      socket.removeListener('data', onData);
      const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
      const close = () => { socket.destroy(); upstream.destroy(); };
      socket.once('close', () => upstream.destroy());
      upstream.once('close', () => socket.destroy());
      socket.once('error', close);
      upstream.once('error', close);
      upstream.once('connect', () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        if (pending.length) upstream.write(pending);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
    };
    socket.on('data', onData);
    socket.once('error', () => {});
  });
  const port = await listen(worldState, server);
  return { port, seen };
}

async function launchFixture(t, w, kind, config, origin, marker, inherited = {}) {
  const packageDir = path.join(w.root, 'node_modules/@earendil-works/pi-coding-agent');
  const agent = path.join(w.root, 'agent'), cwd = path.join(w.root, 'workspace'), dataDir = path.join(w.root, 'data');
  for (const directory of [packageDir, agent, cwd, dataDir]) await fs.mkdir(directory, { recursive: true });
  const cli = path.join(packageDir, 'cli.cjs'), shim = path.join(w.root, 'pi.cmd');
  await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.5.2', bin: { pi: 'cli.cjs' } }));
  await fs.copyFile(path.join(__dirname, 'fixtures/system-pi-network-final.cjs'), cli);
  await fs.writeFile(shim, '@echo off\r\n"%FIXTURE_NODE%" "%~dp0node_modules\\@earendil-works\\pi-coding-agent\\cli.cjs" %*\r\n');
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({ httpProxy: inherited.storedProxy || '' }));
  await fs.writeFile(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: `https://public.example:${origin.port}/v1/chat/completions`, api: 'openai-completions', apiKey: 'fixture-only-not-a-secret',
    models: [{ id: 'fixture-model', name: 'Deterministic offline model' }],
  } } }));
  const base = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) base[key] = process.env[key];
  Object.assign(base, { HOME: w.root, USERPROFILE: w.root, APPDATA: w.root, LOCALAPPDATA: w.root, TEMP: w.root, TMP: w.root,
    PI_CODING_AGENT_DIR: agent, PI_NO_CONTINUE: '1', PI_GUI_OFFLINE: '1', PI_OFFLINE: '1', FIXTURE_NODE: process.execPath,
    FIXTURE_CA_FILE: path.join(w.root, 'ca.pem'), FIXTURE_EXPECTED_MARKER: marker, ...inherited });
  delete base.storedProxy;
  const env = policy.externalEnvironment(config, base);
  // Deliberately contaminate the input to the final production scrub boundary.
  env[PRIVATE_PROXY_KEY] = 'http://pi-gui:pi-proxy-token-' + 'a'.repeat(64) + '@127.0.0.1:12345/';
  env.PI_GUI_TOKEN = 'fixture-gui-token-not-for-pi';
  const events = [];
  let send, dispose, state;
  if (kind === 'classic') {
    const { createRpcBridge } = await load('rpc-bridge.js');
    const { createRuntime } = await load('runtime.js');
    const { killTree } = await load('agents/cli.js');
    const bridge = createRpcBridge({ runtime: createRuntime({ initialCwd: cwd }), publish: event => events.push(event),
      piBin: process.platform === 'win32' ? shim : process.execPath, isWin: process.platform === 'win32', env,
      projectLaunch: process.platform === 'win32' ? null : { launchArgs: () => ({ args: [] }) },
      autoRestart: false, killProcessTree: killTree });
    // Classic Windows must use the real npm-shaped .cmd launch. On other
    // platforms use the proven Node CLI through the same bridge launcher.
    if (process.platform !== 'win32') throw Error('fixture_classic_windows_required');
    bridge.start(); state = bridge.getState; send = command => bridge.send(command);
    dispose = async () => { bridge.stop(); await waitFor(() => !bridge.getState().piRunning); };
  } else {
    const { createRuntimeRegistry } = await load('runtime-registry.js');
    const { createSessionRuntime } = await load('session-runtime.js');
    const workspace = { projectId: 'fixture-project', repoId: 'fixture-repo', workspaceId: 'network-fixture', workspaceEpoch: 'fixture-epoch', cwd, root: cwd, branch: 'fixture' };
    let adapter;
    const registry = createRuntimeRegistry({ dataDir, publish: frame => events.push(frame.type === 'runtime_event' ? frame.event : frame), resolveWorkspace: async () => ({ ...workspace }),
      factory: async (context, emit) => (adapter = await createSessionRuntime({ context, emit, piBin: cli, env, dataDir })) });
    const started = await registry.start({});
    await waitFor(() => registry.snapshot().items.find(item => item.conversationId === started.conversationId)?.owner?.sessionId);
    send = command => registry.command(registry.snapshot().items.find(item => item.conversationId === started.conversationId).owner, command);
    state = () => adapter.getState();
    dispose = () => registry.dispose();
  }
  w.cleanups.push(dispose);
  await waitFor(() => state().state === 'ready');
  const request = async () => {
    await send({ type: 'prompt', id: randomUUID(), message: 'Read only the deterministic local fixture.' });
    await waitFor(() => events.some(event => event.type === 'fixture_network_evidence') && events.some(event => event.type === 'agent_settled'));
    return events.find(event => event.type === 'fixture_network_evidence');
  };
  return { events, request, state };
}

// These are GUI production spawn/transport-contract tests, not execution or
// certification of the installed official Pi client, Windows PAC or Clash TUN.
for (const kind of ['classic', 'runtime']) {
  for (const mode of ['http', 'socks5', 'socks5h', 'direct', 'system-inherited', 'system-no-proxy', 'proxy-407', 'untrusted-tls']) {
    test(`${kind}: actual fixture model SSE round trip via ${mode}`, { timeout: 45000, skip: kind === 'classic' && process.platform !== 'win32' }, async t => {
      const w = await world(t, `${kind}-${mode}`), marker = MARKER_PREFIX + randomUUID();
      const origin = await modelServer(w, marker, path.join(w.root, 'ca.pem'));
      const socks = mode.startsWith('socks');
      const proxy = socks ? await socksProxy(w, origin.port) : await httpProxy(w, origin.port, mode === 'proxy-407' ? 407 : 200);
      const proxyUrl = `${socks ? mode : 'http'}://127.0.0.1:${proxy.port}`;
      const direct = mode === 'direct', system = mode.startsWith('system');
      const config = { ...policy.DEFAULTS, mode: direct ? 'direct' : system ? 'system' : 'custom', proxy: direct || system ? '' : proxyUrl };
      const inherited = direct ? { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, storedProxy: proxyUrl }
        : mode === 'system-inherited' ? { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl } : {};
      if (mode === 'untrusted-tls') inherited.FIXTURE_UNTRUSTED_CA = '1';
      const child = await launchFixture(t, w, kind, config, origin, marker, inherited);
      const evidence = await child.request(), success = !['proxy-407', 'untrusted-tls'].includes(mode);
      assert.equal(evidence.markerObserved, success);
      assert.equal(origin.hits, success ? 1 : 0);
      assert.equal(proxy.seen.length, direct || mode === 'system-no-proxy' ? 0 : 1);
      if (proxy.seen.length) assert.deepEqual(proxy.seen[0], { hostname: 'public.example', port: origin.port });
      for (const field of ['piPrivateCapabilityPresent', 'piPrivateProxyValuePresent', 'childPrivateCapabilityPresent', 'childPrivateProxyValuePresent']) assert.equal(evidence[field], false, field);
      assert.equal(child.events.some(event => event.type === 'message_end' && event.message?.content?.some(part => part.text === marker)), success);
      if (direct) { assert.equal(evidence.directProxyEnvironmentEmpty, true); assert.equal(evidence.fallbackBlocked, true); }
      if (mode === 'proxy-407') assert.equal(evidence.proxyAttempted, true, 'proxy refusal never falls back to origin');
      t.diagnostic(`${kind}/${mode}: origin hits ${origin.hits}, proxy tunnels ${proxy.seen.length}; fixture transport, not official Pi certification`);
    });
  }
  test(`${kind}: saving a new proxy policy does not interrupt or retarget an active external agent`, { timeout: 45000, skip: kind === 'classic' && process.platform !== 'win32' }, async t => {
    const w = await world(t, `${kind}-active-save`), marker = MARKER_PREFIX + randomUUID();
    const origin = await modelServer(w, marker, path.join(w.root, 'ca.pem'), true);
    const proxy = await httpProxy(w, origin.port);
    const config = { ...policy.DEFAULTS, mode: 'custom', proxy: `http://127.0.0.1:${proxy.port}` };
    const child = await launchFixture(t, w, kind, config, origin, marker);
    const flight = child.request(); flight.catch(() => {});
    try {
      await waitFor(() => origin.hits === 1 && child.events.some(event => event.type === 'agent_start'));
      const run = child.state().bridgeRun;
      const { createSystemNetwork } = require('../electron/system-network.cjs');
      let saved = config;
      const network = await createSystemNetwork({ store: { snapshot: () => ({ settings: saved, status: 'saved', error: '' }),
        save: async value => { saved = value; return { ok: true }; } } });
      assert.equal((await network.save({ ...policy.DEFAULTS, mode: 'direct' })).ok, true);
      assert.equal(network.snapshot().restartRequired, true);
      assert.equal(child.state().piRunning, true); assert.equal(child.state().bridgeRun, run);
      assert.equal(child.events.filter(event => event.type === 'agent_start').length, 1);
      origin.release();
      const evidence = await flight;
      assert.equal(evidence.markerObserved, true); assert.equal(evidence.route, 'http-connect');
      assert.equal(origin.hits, 1); assert.equal(proxy.seen.length, 1);
      network.dispose();
    } finally { origin.release(); }
  });
}
