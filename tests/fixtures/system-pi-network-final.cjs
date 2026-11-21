'use strict';

// A minimal, npm-shaped Pi RPC fixture. It does no network work until a real
// prompt command arrives over the bridge's JSONL stdin.
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tls = require('node:tls');

const PRIVATE_PROXY = /^http:\/\/pi-gui:pi-proxy-token-[a-f0-9]{64}@127\.0\.0\.1:\d+\/$/i;
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const privateState = env => ({
  capabilityPresent: Object.keys(env).some(key => key.toUpperCase() === 'PI_GUI_SYSTEM_PROXY'),
  privateProxyValuePresent: Object.entries(env).some(([key, value]) =>
    PROXY_KEYS.includes(key) && typeof value === 'string' && PRIVATE_PROXY.test(value)
  )
});

function childPrivateState() {
  const source = `
    const keys = ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'];
    const privateProxy = /^http:\\/\\/pi-gui:pi-proxy-token-[a-f0-9]{64}@127\\.0\\.0\\.1:\\d+\\/$/i;
    const values = Object.entries(process.env);
    process.stdout.write(JSON.stringify({
      capabilityPresent: Object.keys(process.env).some(key => key.toUpperCase() === 'PI_GUI_SYSTEM_PROXY'),
      privateProxyValuePresent: values.some(([key, value]) => keys.includes(key) && typeof value === 'string' && privateProxy.test(value))
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', source], {
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    throw Error('fixture_child_probe_failed');
  }
  return JSON.parse(result.stdout);
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function bypassesProxy(host) {
  const raw = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  const entries = String(raw).split(/[;,\s]+/u).map(value => value.trim().toLowerCase()).filter(Boolean);
  return entries.includes('*') || entries.includes(host.toLowerCase())
    || (host === '::1' && entries.includes('[::1]'))
    || (host === '[::1]' && entries.includes('::1'));
}

function connectDirect(url) {
  if (url.hostname !== 'public.example' && !isLoopback(url.hostname)) {
    throw Error('fixture_target_rejected');
  }
  // public.example is deliberately mapped to this test's loopback listener;
  // it is never passed to DNS or used as a socket address.
  return netConnect('127.0.0.1', Number(url.port));
}

function netConnect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(10000, () => socket.destroy(Error('fixture_timeout')));
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function connectHttpProxy(proxy, target) {
  if (proxy.hostname !== '127.0.0.1' || !proxy.port) throw Error('fixture_proxy_rejected');
  const authority = `${target.hostname}:${target.port}`;
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: Number(proxy.port),
      method: 'CONNECT',
      path: authority,
      agent: false,
      headers: { host: authority }
    });
    request.setTimeout(10000, () => request.destroy(Error('fixture_timeout')));
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(Error('fixture_proxy_rejected'));
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.once('error', reject);
    request.end();
  });
}

function readExactly(socket, size) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < size) return;
      socket.pause();
      cleanup();
      const rest = buffer.subarray(size);
      if (rest.length) socket.unshift(rest);
      resolve(buffer.subarray(0, size));
    };
    const onError = error => { cleanup(); reject(error); };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.resume();
  });
}

async function connectSocks5(proxy, target) {
  if (proxy.hostname !== '127.0.0.1' || !proxy.port) throw Error('fixture_proxy_rejected');
  const socket = await netConnect('127.0.0.1', Number(proxy.port));
  socket.write(Buffer.from([5, 1, 0]));
  const greeting = await readExactly(socket, 2);
  if (greeting[0] !== 5 || greeting[1] !== 0) throw Error('fixture_proxy_rejected');

  const hostname = Buffer.from(target.hostname, 'ascii');
  if (hostname.length > 255) throw Error('fixture_target_rejected');
  const port = Number(target.port);
  socket.write(Buffer.concat([
    Buffer.from([5, 1, 0, 3, hostname.length]), hostname,
    Buffer.from([port >> 8, port & 0xff])
  ]));

  const prefix = await readExactly(socket, 4);
  if (prefix[0] !== 5 || prefix[1] !== 0) throw Error('fixture_proxy_rejected');
  let addressLength;
  if (prefix[3] === 1) addressLength = 4;
  else if (prefix[3] === 4) addressLength = 16;
  else if (prefix[3] === 3) addressLength = (await readExactly(socket, 1))[0];
  else throw Error('fixture_proxy_rejected');
  await readExactly(socket, addressLength + 2);
  return socket;
}

function tlsConnect(socket, host, caFile) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket,
      servername: net.isIP(host) ? undefined : host,
      ca: process.env.FIXTURE_UNTRUSTED_CA === '1' ? undefined : fs.readFileSync(caFile),
      rejectUnauthorized: true
    });
    secure.setTimeout(10000, () => secure.destroy(Error('fixture_timeout')));
    secure.once('secureConnect', () => resolve(secure));
    secure.once('error', reject);
  });
}

function requestSse(socket, url, apiKey, prompt) {
  const body = JSON.stringify({
    model: 'fixture-model',
    stream: true,
    messages: [{ role: 'user', content: prompt }]
  });
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('error', onError);
      socket.off('close', onClose);
      error ? reject(error) : resolve(result);
    };
    const onError = error => finish(error);
    const onClose = () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const split = raw.indexOf('\r\n\r\n');
      if (split < 0) return finish(Error('fixture_response_invalid'));
      const status = /^HTTP\/1\.[01] (\d{3})/u.exec(raw.slice(0, split));
      if (!status) return finish(Error('fixture_response_invalid'));
      finish(null, { status: Number(status[1]), body: raw.slice(split + 4) });
    };
    const timer = setTimeout(() => socket.destroy(Error('fixture_timeout')), 10000);
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.write([
      `POST ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.host}`,
      'Connection: close',
      'Content-Type: application/json',
      `Authorization: Bearer ${apiKey}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      '',
      body
    ].join('\r\n'));
  });
}

async function performModelRequest(prompt) {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const settingsFile = path.join(agentDir, 'settings.json');
  const modelsFile = path.join(agentDir, 'models.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const models = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
  const provider = models.providers.fixture;
  const model = provider.models[0];
  if (model.id !== 'fixture-model') throw Error('fixture_model_invalid');

  // Mirror Pi's documented httpProxy ??= projection. Explicit empty values in
  // direct mode must prevent this stored setting from being filled back in.
  if (typeof settings.httpProxy === 'string') {
    process.env.HTTP_PROXY ??= settings.httpProxy;
    process.env.HTTPS_PROXY ??= settings.httpProxy;
  }

  const target = new URL(models.providers.fixture.baseUrl);
  if (target.protocol !== 'https:') throw Error('fixture_target_rejected');
  const loopbackBypass = isLoopback(target.hostname) && bypassesProxy(target.hostname);
  const proxyValue = process.env.HTTPS_PROXY ?? process.env.https_proxy
    ?? process.env.ALL_PROXY ?? process.env.all_proxy ?? '';
  const route = {
    kind: loopbackBypass ? 'loopback' : 'direct',
    proxyAttempted: false,
    proxyScheme: '',
    fallbackBlocked: typeof settings.httpProxy === 'string'
      && process.env.HTTP_PROXY === '' && process.env.HTTPS_PROXY === ''
  };

  try {
    let rawSocket;
    if (!loopbackBypass && typeof proxyValue === 'string' && proxyValue) {
      const proxy = new URL(proxyValue);
      route.proxyAttempted = true;
      route.proxyScheme = proxy.protocol;
      if (proxy.protocol === 'http:') {
        route.kind = 'http-connect';
        rawSocket = await connectHttpProxy(proxy, target);
      } else if (proxy.protocol === 'socks5:') {
        route.kind = 'socks5';
        rawSocket = await connectSocks5(proxy, target);
      } else {
        throw Error('fixture_proxy_rejected');
      }
    } else {
      rawSocket = await connectDirect(target);
    }

    const secure = await tlsConnect(rawSocket, target.hostname, process.env.FIXTURE_CA_FILE);
    const response = await requestSse(secure, target, provider.apiKey, prompt);
    const output = response.body.split(/\r?\n/u).filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || '').join('');
    const markerObserved = response.status === 200 && output === process.env.FIXTURE_EXPECTED_MARKER;
    return { ...route, markerObserved, output };
  } catch {
    // Preserve only route structure. The caller must not fall back to DIRECT.
    return { ...route, markerObserved: false };
  }
}

async function handle(command) {
  if (command?.type === 'get_state') {
    send({ type: 'response', id: command.id, command: command.type, success: true,
      data: { sessionId: process.env.FIXTURE_SESSION_ID || 'fixture-session', isStreaming: false } });
    return;
  }
  if (command?.type !== 'prompt') {
    if (command && typeof command.type === 'string') {
      send({ type: 'response', id: command.id, command: command.type, success: true, data: {} });
    }
    return;
  }

  send({ type: 'response', id: command.id, command: command.type, success: true, data: { disposition: 'started' } });
  send({ type: 'agent_start' });
  let route = { kind: 'direct', proxyAttempted: false, fallbackBlocked: false, markerObserved: false };
  let success = false;
  try {
    route = { ...route, ...await performModelRequest(command.message) };
    success = route.markerObserved === true;
  } catch {
    // Deliberately do not include arbitrary error text, request data, or paths.
  }
  const childState = childPrivateState();
  const ownState = privateState(process.env);
  send({
    type: 'fixture_network_evidence',
    route: route.kind,
    proxyAttempted: route.proxyAttempted === true,
    markerObserved: route.markerObserved === true,
    fallbackBlocked: route.fallbackBlocked === true,
    directProxyEnvironmentEmpty: PROXY_KEYS.every(key => process.env[key] === ''),
    piPrivateCapabilityPresent: ownState.capabilityPresent,
    piPrivateProxyValuePresent: ownState.privateProxyValuePresent,
    childPrivateCapabilityPresent: childState.capabilityPresent,
    childPrivateProxyValuePresent: childState.privateProxyValuePresent
  });
  if (success) send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: route.output }] } });
  send({ type: 'agent_settled' });
  // Keep the RPC process available until the production owner disposes it.
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  let end;
  while ((end = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    if (!line) continue;
    let command;
    try { command = JSON.parse(line); } catch { continue; }
    void handle(command);
  }
});
