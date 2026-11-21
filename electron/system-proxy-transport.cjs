'use strict';
// Opaque HTTP CONNECT / SOCKS5 tunnels: TLS to the destination remains owned by
// the original client. Never decrypt provider traffic or forward proxy auth.
const net = require('node:net');
const tls = require('node:tls');
const { performance } = require('node:perf_hooks');

const problem = code => Object.assign(Error(code), { code });
function destination(host, port) {
  const clean = typeof host === 'string' ? host.replace(/^\[|\]$/g, '') : '';
  if (!clean || clean.length > 253 || /[\s\x00-\x1f\x7f/@\\]/.test(clean)
    || !Number.isInteger(port) || port < 1 || port > 65535) throw problem('invalid_target');
  if (!net.isIP(clean) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(clean)) throw problem('invalid_target');
  return { host: clean, port };
}
function authority(host, port) { return `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`; }
function read(socket, predicate, maxBytes = 8192, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0), done = false;
    const finish = (error, length) => {
      if (done) return; done = true; clearTimeout(timer);
      socket.pause(); socket.removeListener('data', data); socket.removeListener('error', fail); socket.removeListener('end', end);
      if (error) return reject(error);
      if (bytes.length > length) socket.unshift(bytes.subarray(length));
      resolve(bytes.subarray(0, length));
    };
    const fail = () => finish(problem('proxy_unreachable'));
    const end = () => finish(problem('proxy_unreachable'));
    const data = chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > maxBytes) return finish(problem('proxy_protocol'));
      let length; try { length = predicate(bytes); } catch (error) { return finish(error); }
      if (Number.isInteger(length) && length > 0 && bytes.length >= length) finish(null, length);
    };
    const timer = setTimeout(() => finish(problem('timeout')), timeoutMs);
    socket.on('data', data); socket.once('error', fail); socket.once('end', end); socket.resume();
  });
}
function connect({ host, port, secure = false, timeoutMs = 10000, tlsOptions = {}, lookup } ) {
  return new Promise((resolve, reject) => {
    let socket;
    const timer = setTimeout(() => { socket?.destroy(); reject(problem('timeout')); }, timeoutMs);
    const error = value => {
      clearTimeout(timer);
      const code = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(value?.code || '') ? 'tls_failed' : 'proxy_unreachable';
      reject(problem(code));
    };
    const ready = () => { clearTimeout(timer); socket.removeListener('error', error); socket.on('error', () => {}); socket.pause(); resolve(socket); };
    try {
      socket = secure ? tls.connect({ ...tlsOptions, host, port, servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: true }, ready) : net.connect({ host, port, lookup }, ready);
      socket.once('error', error);
    } catch { clearTimeout(timer); reject(problem('proxy_unreachable')); }
  });
}
function route(value) {
  if (typeof value !== 'string' || value.length > 4096) throw problem('proxy_unreachable');
  // Never downgrade a failed proxy to DIRECT, even if a PAC result lists one.
  const first = value.split(';')[0].trim();
  if (first === 'DIRECT') return { protocol: 'direct' };
  const match = /^(PROXY|HTTPS|SOCKS5)\s+(\[[0-9a-f:]+\]|[a-z0-9.-]+):(\d{1,5})$/i.exec(first);
  if (!match) throw problem('proxy_unreachable');
  const target = destination(match[2], +match[3]);
  return { protocol: match[1].toUpperCase() === 'PROXY' ? 'http' : match[1].toUpperCase() === 'HTTPS' ? 'https' : 'socks5', ...target };
}
function socksAddress(host, port) {
  const end = Buffer.alloc(2); end.writeUInt16BE(port);
  // Specify IPs as IPs, not names the SOCKS server is free to resolve again.
  if (net.isIPv4(host)) return Buffer.concat([Buffer.from([5, 1, 0, 1, ...host.split('.').map(Number)]), end]);
  if (net.isIPv6(host)) {
    const name = new URL(`http://[${host}]`).hostname.slice(1, -1);
    const groups = part => part ? part.split(':').map(value => parseInt(value, 16)) : [];
    const [a, b] = name.split('::'), left = groups(a), right = groups(b);
    const words = b === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
    const bytes = Buffer.alloc(16);
    words.forEach((word, index) => bytes.writeUInt16BE(word, index * 2));
    return Buffer.concat([Buffer.from([5, 1, 0, 4]), bytes, end]);
  }
  const bytes = Buffer.from(host, 'utf8');
  return Buffer.concat([Buffer.from([5, 1, 0, 3, bytes.length]), bytes, end]);
}
async function openTunnel({ host, port, proxyRoute = 'DIRECT', timeoutMs = 10000, tlsOptions = {}, directLookup, excludeProxyPort } = {}) {
  const target = destination(host, port), first = route(proxyRoute);
  if (first.protocol === 'direct') return connect({ ...target, timeoutMs, lookup: directLookup });
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0) throw problem('timeout');
    return ms;
  };
  let failure = problem('proxy_unreachable');
  for (const entry of proxyRoute.split(';').slice(0, 4)) {
    const selected = route(entry);
    if (selected.protocol === 'direct') break; // Never downgrade a failed proxy.
    if (selected.port === excludeProxyPort && (selected.host === 'localhost'
        || selected.host === '::1' || selected.host.startsWith('127.'))) continue;
    try { return await proxyTunnel(target, selected, remaining, tlsOptions); }
    catch (error) {
      if (error.code !== 'proxy_unreachable') throw error;
      failure = error;
    }
  }
  throw failure;
}
async function proxyTunnel(target, selected, remaining, tlsOptions) {
  let socket;
  try {
    socket = await connect({ host: selected.host, port: selected.port, secure: selected.protocol === 'https', timeoutMs: remaining(), tlsOptions });
    if (selected.protocol === 'socks5') {
      socket.write(Buffer.from([5, 1, 0]));
      const greeting = await read(socket, bytes => bytes.length >= 2 ? 2 : 0, 8192, remaining());
      if (greeting[0] !== 5 || greeting[1] !== 0) throw problem(greeting[1] === 2 ? 'proxy_auth_required' : 'proxy_protocol');
      socket.write(socksAddress(target.host, target.port));
      const reply = await read(socket, bytes => {
        if (bytes.length < 5) return 0;
        if (bytes[0] !== 5 || bytes[1] !== 0 || bytes[2] !== 0) throw problem('proxy_unreachable');
        return bytes[3] === 1 ? 10 : bytes[3] === 4 ? 22 : bytes[3] === 3 ? 7 + bytes[4] : (() => { throw problem('proxy_protocol'); })();
      }, 8192, remaining());
      if (!reply.length) throw problem('proxy_protocol');
    } else {
      const targetAuthority = authority(target.host, target.port);
      socket.write(`CONNECT ${targetAuthority} HTTP/1.1\r\nHost: ${targetAuthority}\r\nConnection: keep-alive\r\n\r\n`);
      const headers = await read(socket, bytes => { const end = bytes.indexOf('\r\n\r\n'); return end < 0 ? 0 : end + 4; }, 16384, remaining());
      const match = /^HTTP\/1\.[01] ([0-9]{3})(?: |\r)/.exec(headers.toString('latin1'));
      if (!match || match[1] !== '200') throw problem(match?.[1] === '407' ? 'proxy_auth_required' : 'proxy_unreachable');
    }
    return socket;
  } catch (error) { socket?.destroy(); throw problem(['timeout', 'tls_failed', 'proxy_auth_required', 'invalid_target'].includes(error?.code) ? error.code : 'proxy_unreachable'); }
}
module.exports = { destination, authority, route, openTunnel };
