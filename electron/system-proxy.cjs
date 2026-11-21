'use strict';
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns');
const path = require('node:path'), fs = require('node:fs');
const marketPolicy = [path.join(__dirname, 'market-network-policy.cjs'), path.join(__dirname, '../lib/market-network-policy.cjs')].find(file => fs.existsSync(file));
const { classifyAddress, blockedHostname, classifyProxyRoute } = require(marketPolicy);
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { openTunnel, destination, route } = require('./system-proxy-transport.cjs');

const blockedIp = host => ['loopback', 'unspecified', 'link-local', 'invalid'].includes(classifyAddress(host));
const blockedTarget = host => net.isIP(host) ? blockedIp(host) : blockedHostname(host);
const privateCapabilityHeader = 'x-pi-gui-route-host';
function guardedLookup(host, options, callback) {
  dns.lookup(host, { all: true, family: options.family }, (error, answers) => {
    if (error || !acceptableAnswers(answers, false)) return callback(Error('invalid_target'));
    return options.all ? callback(null, answers) : callback(null, answers[0].address, answers[0].family);
  });
}
function lookupAnswers(host, timeoutMs, lookup = dns.lookup) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => finish(null), timeoutMs);
    const finish = answers => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(answers);
    };
    if (net.isIP(host)) return finish([{ address: host }]);
    lookup(host, { all: true, verbatim: true }, (error, answers) => finish(error ? null : answers));
  });
}
function acceptableAnswers(answers, relaxed) {
  if (!Array.isArray(answers) || !answers.length || answers.length > 32
      || !answers.every(item => item && typeof item.address === 'string' && net.isIP(item.address))) return false;
  const classes = answers.map(item => classifyAddress(item.address));
  return classes.every(kind => kind === 'public')
    || relaxed && classes.some(kind => kind === 'benchmark') && classes.every(kind => kind === 'public' || kind === 'benchmark');
}
function publicProxyFallback(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const entries = value.split(';').map(entry => entry.trim()).filter(Boolean);
  if (entries.length < 2 || !/^DIRECT$/i.test(entries.at(-1))) return null;
  const proxies = entries.slice(0, -1);
  try {
    if (proxies.some(entry => route(entry).protocol === 'direct')) return null;
  } catch { return null; }
  // The gateway will only pass these proxy candidates, never the DIRECT tail.
  // This compatibility path is NOT proof of a proxied route for Fake-IP DNS.
  return proxies.slice(0, 4).join('; ');
}
const HOP = new Set(['proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'connection', 'keep-alive', 'upgrade', 'trailer', 'transfer-encoding', privateCapabilityHeader]);
function headerProjection(headers) {
  const connection = String(headers.connection || '').split(',').map(value => value.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !HOP.has(key.toLowerCase()) && !connection.includes(key.toLowerCase())));
}
function createSystemProxy({ resolveProxy, timeoutMs = 10000, maxConnections = 32, relaxed = false, lookup = dns.lookup } = {}) {
  if (typeof resolveProxy !== 'function') throw new TypeError('main-owned proxy resolver required');
  const credential = 'pi-proxy-token-' + randomBytes(32).toString('hex');
  const authorization = Buffer.from('Basic ' + Buffer.from('pi-gui:' + credential).toString('base64'));
  const sockets = new Set();
  let server = null, address = '', closing = false, active = 0;
  const authorized = req => {
    const value = Buffer.from(typeof req.headers['proxy-authorization'] === 'string' ? req.headers['proxy-authorization'] : '');
    return !closing && !req.headers.origin && value.length === authorization.length && timingSafeEqual(value, authorization);
  };
  async function tunnel(host, port, scheme, routeHost = host, relaxedTarget = relaxed) {
    destination(host, port); destination(routeHost, port);
    if (blockedTarget(host) || blockedTarget(routeHost)) throw Error('invalid_target');
    let timer, raw;
    try {
      raw = await Promise.race([
        resolveProxy(`${scheme}//${routeHost.includes(':') ? '[' + routeHost + ']' : routeHost}:${port}/`),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('proxy_timeout')), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
    if (closing) throw Error('proxy_closed');
    let routeKind;
    try { routeKind = classifyProxyRoute(raw); } catch { routeKind = 'unknown'; }
    const proxyRoute = routeKind === 'unknown' ? publicProxyFallback(raw) : raw;
    if (!proxyRoute || routeKind === 'direct' && (net.isIP(host) ? classifyAddress(host) !== 'public' : false)) throw Error('invalid_target');
    const answers = await lookupAnswers(host, timeoutMs, lookup);
    if (!acceptableAnswers(answers, relaxedTarget && routeKind === 'proxied')) throw Error('invalid_target');
    const targetHost = answers.some(({ address }) => classifyAddress(address) === 'benchmark') ? routeHost
      : net.isIP(host) ? host : answers[0].address;
    const socket = await openTunnel({ host: targetHost, port, proxyRoute, timeoutMs, directLookup: guardedLookup,
      excludeProxyPort: server?.address()?.port });
    if (closing) { socket.destroy(); throw Error('proxy_closed'); }
    sockets.add(socket); socket.setTimeout(60000, () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    return socket;
  }
  async function forward(req, res) {
    if (!authorized(req)) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="local-network"' }); res.end(); return; }
    if (active >= maxConnections) { res.writeHead(503); res.end(); return; }
    active++; let done = false, upstream = null;
    const finish = () => { if (!done) { done = true; active--; } };
    res.once('close', () => { finish(); upstream?.destroy(); }); res.once('finish', finish);
    try {
      const target = new URL(req.url);
      if (target.protocol !== 'http:' || target.username || target.password || target.hash) throw Error('invalid_target');
      const host = target.hostname.replace(/^\[|\]$/g, ''), port = +(target.port || 80);
      const socket = await tunnel(host, port, 'http:');
      if (req.destroyed || res.destroyed) { socket.destroy(); return; }
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = (_options, callback) => callback(null, socket);
      const headers = headerProjection(req.headers); headers.host = target.host;
      upstream = http.request({ method: req.method, host, port, path: target.pathname + target.search, headers, agent }, response => {
        res.writeHead(response.statusCode, headerProjection(response.headers)); response.pipe(res);
        response.on('error', () => res.destroy());
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on('error', () => upstream.destroy()); req.pipe(upstream); socket.resume();
    } catch { if (!res.headersSent) res.writeHead(502); res.end(); }
  }
  async function connect(req, client, head) {
    if (!authorized(req)) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n'); return; }
    if (active >= maxConnections) { client.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    active++; let done = false, upstream;
    const finish = () => { if (!done) { done = true; active--; } upstream?.destroy(); };
    client.once('close', finish); client.once('error', finish);
    try {
      const match = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+):(\d{1,5})$/i.exec(req.url);
      if (!match) throw Error('invalid_target');
      const { host, port } = destination(new URL('http://' + match[1]).hostname, Number(match[2]));
      const routeHost = req.headers[privateCapabilityHeader];
      if (routeHost !== undefined && (typeof routeHost !== 'string' || !req.headers['proxy-authorization'])) throw Error('invalid_target');
      // Provider requests supply the already checked route-host; ordinary
      // clients only use the gateway's public/relaxed-Fake-IP resolution gate.
      upstream = await tunnel(host, port, 'https:', routeHost || host, relaxed);
      if (client.destroyed) { upstream.destroy(); return; }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.on('error', () => client.destroy()); upstream.once('close', () => client.destroy());
      client.pipe(upstream); upstream.pipe(client);
    } catch { if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); }
  }
  return {
    async start() {
      if (server || closing) return;
      server = http.createServer({ maxHeaderSize: 16384 }, (req, res) => { void forward(req, res); });
      server.headersTimeout = 10000; server.requestTimeout = 0; server.maxConnections = maxConnections * 2;
      server.on('connect', (req, client, head) => { void connect(req, client, head); });
      server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
      server.setTimeout(60000, socket => socket.destroy());
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      address = `http://pi-gui:${credential}@127.0.0.1:${server.address().port}`;
    },
    bootstrapURL: () => address,
    redact: value => String(value).replaceAll(credential, '[proxy-credential]')
      .replaceAll(authorization.toString(), '[proxy-authorization]')
      .replaceAll(authorization.toString().slice(6), '[proxy-authorization]'),
    async stop() {
      closing = true; address = '';
      for (const socket of sockets) socket.destroy(); sockets.clear();
      if (server) { const previous = server; server = null; await new Promise(resolve => previous.close(resolve)); }
    },
  };
}
module.exports = { createSystemProxy };
