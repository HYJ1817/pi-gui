'use strict';
const path = require('node:path'), fs = require('node:fs'), tls = require('node:tls');
const dns = require('node:dns/promises');
const { openTunnel } = require('./system-proxy-transport.cjs');
const shared = name => require([path.join(__dirname, name), path.join(__dirname, '../lib', name)].find(file => fs.existsSync(file)));
const { electronProxy } = shared('system-network-policy.cjs');
const { classifyAddress, classifyProxyRoute, blockedHostname } = shared('market-network-policy.cjs');
const FIXED_TARGET = 'https://registry.npmjs.org/-/ping';

// Only main supplies target/lookup/CA for offline tests. The IPC contract accepts
// four policy fields, never a destination, header, credential or TLS option.
function createSystemConnectionTest({ createSession, lookup = dns.lookup,
  target = FIXED_TARGET, timeoutMs = 12000, tlsOptions = {} } = {}) {
  const url = new URL(target);
  if (url.protocol !== 'https:' || url.username || url.password || blockedHostname(url.hostname)) throw Error('invalid_fixed_target');
  let ses, routing = null;
  return async value => {
    // Named Electron Sessions live for the life of the app. Reuse one and
    // refuse to reuse its policy slot while timed-out native work is pending.
    if (routing) return { ok: false, code: 'timeout' };
    let socket, secure, finished = false, timer;
    const route = routing = Promise.resolve().then(async () => {
      ses ??= createSession('pi-gui-network-test');
      await ses.setProxy(electronProxy(value));
      if (!finished) return ses.resolveProxy(url.href);
    });
    const release = () => { if (routing === route) routing = null; };
    route.then(release, release);
    const work = (async () => {
      try {
        const proxyRoute = await route;
        if (finished) return { ok: false, code: 'timeout' };
        const routeKind = classifyProxyRoute(proxyRoute);
        let answers;
        try { answers = await lookup(url.hostname, { all: true, verbatim: true }); }
        catch { return { ok: false, code: 'dns_failed' }; }
        if (!Array.isArray(answers) || !answers.length || answers.length > 32) return { ok: false, code: 'dns_failed' };
        const publicOnly = answers.every(item => classifyAddress(item.address) === 'public');
        const fakeOnly = answers.every(item => ['public', 'benchmark'].includes(classifyAddress(item.address)));
        if (!publicOnly && !(value.relaxed === true && fakeOnly && routeKind === 'proxied')) return { ok: false, code: 'target_blocked' };
        if (finished) return { ok: false, code: 'timeout' };
        // Strict requests use the checked IP even through a proxy. Only the
        // explicit Fake-IP/proven-proxy case delegates original-host DNS.
        const host = publicOnly ? answers[0].address : url.hostname;
        socket = await openTunnel({ host, port: +(url.port || 443), proxyRoute, timeoutMs: Math.min(timeoutMs, 5000) });
        if (finished) { socket.destroy(); return { ok: false, code: 'timeout' }; }
        return await new Promise(resolve => {
          let headers = '', settled = false;
          const done = code => { if (settled) return; settled = true; secure.destroy(); resolve({ ok: code === 'connected', code }); };
          secure = tls.connect({ ...tlsOptions, socket, servername: url.hostname, rejectUnauthorized: true }, () => {
            secure.write(`HEAD ${url.pathname + url.search} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\nUser-Agent: pi-gui-connection-test\r\n\r\n`);
          });
          secure.on('error', () => done('tls_failed'));
          secure.on('close', () => done(finished ? 'timeout' : 'network_failed'));
          secure.on('data', chunk => {
            headers += chunk.toString('latin1');
            const end = headers.indexOf('\r\n\r\n');
            if (end < 0 && headers.length > 16384) return done('network_failed');
            if (end < 0) return;
            const status = /^HTTP\/1\.[01] ([0-9]{3})(?: |\r)/.exec(headers);
            done(status && +status[1] >= 200 && +status[1] < 300 ? 'connected' : 'network_failed');
          });
        });
      } catch (error) {
        return { ok: false, code: ['proxy_auth_required', 'proxy_unreachable', 'tls_failed', 'timeout'].includes(error?.code) ? error.code : 'network_failed' };
      }
    })();
    try {
      return await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => {
        finished = true; secure?.destroy(); socket?.destroy(); resolve({ ok: false, code: 'timeout' });
      }, timeoutMs); })]);
    } finally {
      finished = true; clearTimeout(timer); secure?.destroy(); socket?.destroy();
      // This in-memory Session only applies and resolves proxy policy; it never
      // opens the request sockets, which are already destroyed above.
    }
  };
}
module.exports = { createSystemConnectionTest, FIXED_TARGET };
