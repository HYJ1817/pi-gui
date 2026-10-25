'use strict';
/* Test-only offline network guard, preloaded with `node --require` before any
 * business module in the fixture backend and in the fake Pi shim. globalThis
 * .fetch accepts only native string/URL/Request inputs; every other shape is
 * refused. node:http / node:https request/get parse hostname/host with full
 * native semantics — bracketed IPv6 must end at the closing bracket, bare IPv6
 * keeps its colons, and a single trailing :port is stripped. Any request whose
 * parsed hostname is not loopback (127.0.0.1, localhost, ::1) is rejected with
 * a fixed code before the original method — and therefore before DNS. When
 * both a URL and options are given, both are checked. Only structured
 * counters and fixed events are recorded (API kind, install/block, fixed
 * reason); never URLs, hostnames, tokens, request bodies or filesystem paths.
 * The JSONL trace path must be provided as an absolute Z4_NETWORK_TRACE whose
 * parent already exists inside the real os.tmpdir(); an existing symlink or
 * non-file target is refused. A missing or unsafe path, or any failed wrapper
 * install, aborts initialization with a fixed code instead of leaving the
 * original network functions in place. This guard is a test fixture boundary,
 * not an OS sandbox: it does not intercept ESM named imports of node:http(s),
 * the Electron main process, or APIs outside fetch/http/https, and it makes
 * no claim against arbitrary native sockets of a hostile same-user process. */
(function () {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const ALLOWED = new Set(['127.0.0.1', 'localhost', '::1']);
  const TRACE_LIMIT = 256;
  const fail = code => { throw Object.assign(Error(code), { code }); };
  const role = process.env.Z4_NETWORK_ROLE === 'pi' ? 'pi' : process.env.Z4_NETWORK_ROLE === 'backend' ? 'backend' : 'unknown';

  const traceTarget = () => {
    const raw = process.env.Z4_NETWORK_TRACE;
    if (typeof raw !== 'string' || !raw || !path.isAbsolute(raw)) return null;
    const target = path.resolve(raw);
    let parentReal, tmpReal;
    try { parentReal = fs.realpathSync(path.dirname(target)); } catch { return null; }
    try { tmpReal = fs.realpathSync(os.tmpdir()); } catch { return null; }
    const relative = path.relative(tmpReal, parentReal);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) return null;
    } catch (error) { if (error.code !== 'ENOENT') return null; }
    return target;
  };
  const tracePath = traceTarget();
  if (!tracePath) fail('Z4_TRACE_UNSAFE');
  const state = { blocked: { fetch: 0, http: 0, https: 0 }, written: 0, seq: 0, refused: 0 };
  const write = entry => {
    if (state.written >= TRACE_LIMIT) return;
    try {
      state.seq += 1;
      fs.appendFileSync(tracePath, JSON.stringify({ seq: state.seq, role, ...entry }) + '\n');
      state.written += 1;
    } catch { state.refused += 1; }
  };

  /* Full precise hostname parsing: '[::1]evil.invalid' and unclosed brackets
   * are refused, bare IPv6 keeps its colons, one trailing :port is stripped. */
  const parseAuthority = value => {
    const text = String(value).trim().toLowerCase();
    if (text.startsWith('[')) {
      const end = text.indexOf(']');
      if (end === -1 || end !== text.length - 1) return null;
      const inner = text.slice(1, end);
      return /^[0-9a-f:]+$/.test(inner) ? inner : null;
    }
    if ((text.match(/:/g) || []).length > 1) return text;
    const at = text.lastIndexOf(':');
    if (at !== -1 && /^\d+$/.test(text.slice(at + 1))) return text.slice(0, at);
    return text;
  };
  const fromUrl = source => parseAuthority(new URL(source).hostname);
  /* Parsed hostname, or null for refused shapes and unparseable URLs — both
   * are blocked, never passed through to the original method. */
  const targetHost = {
    fetch: input => {
      try {
        if (typeof input === 'string') return fromUrl(input);
        if (input instanceof URL) return parseAuthority(input.hostname);
        if (typeof Request === 'function' && input instanceof Request) return fromUrl(input.url);
      } catch { return null; }
      return null;
    },
    node: input => {
      try {
        if (typeof input === 'string') return fromUrl(input);
        if (input instanceof URL) return parseAuthority(input.hostname);
        if (input && typeof input === 'object') {
          if (input.hostname !== undefined || input.host !== undefined) {
            return parseAuthority(input.hostname !== undefined ? input.hostname : input.host);
          }
          if (typeof input.href === 'string') return fromUrl(input.href);
          if (typeof input.url === 'string') return fromUrl(input.url);
          return 'localhost';
        }
      } catch { return null; }
      return null;
    },
  };
  const reject = (api, reason) => {
    state.blocked[api] += 1;
    write({ event: 'blocked', api, reason });
    throw Object.assign(Error('blocked by the test-only offline network guard'), { code: 'Z4_OFFLINE_BLOCKED', reason });
  };

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== 'function') fail('Z4_GUARD_INSTALL_FAILED');
  globalThis.fetch = (input, init) => {
    const host = targetHost.fetch(input);
    if (host === null) reject('fetch', 'shape');
    if (!ALLOWED.has(host)) reject('fetch', 'host');
    return originalFetch.call(globalThis, input, init);
  };
  write({ event: 'installed', api: 'fetch' });
  for (const [moduleName, kind] of [['node:http', 'http'], ['node:https', 'https']]) {
    const moduleRef = require(moduleName);
    for (const name of ['request', 'get']) {
      const original = moduleRef[name];
      if (typeof original !== 'function') fail('Z4_GUARD_INSTALL_FAILED');
      const guarded = function (input, options) {
        const host = targetHost.node(input);
        if (host === null) reject(kind, 'shape');
        if (!ALLOWED.has(host)) reject(kind, 'host');
        if (options && typeof options === 'object') {
          const optionsHost = targetHost.node(options);
          if (optionsHost === null) reject(kind, 'shape');
          if (!ALLOWED.has(optionsHost)) reject(kind, 'host');
        }
        return original.apply(this, arguments);
      };
      moduleRef[name] = guarded;
      write({ event: 'installed', api: kind + '.' + name });
    }
  }
})();