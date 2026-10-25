'use strict';
/* Parent-runner preflight for the test-only offline network guard. Runs in a
 * plain Node process before Electron starts: the real transports are replaced
 * by spies first, then the guard is required, so a delegated call reaches the
 * spy and a blocked call throws — no socket is ever opened, external or local.
 * Writes only inside os.tmpdir(), with a trace separate from the real E2E run.
 * Probe block events must never be used as evidence for the real automatic
 * update check; that evidence stays with the Electron fixture trace. Output is
 * a single JSON line on stdout; exit 0 only when every case matches. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const guardPath = path.resolve(__dirname, 'z4-offline-network.cjs');
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'z4-guard-probe-'));
const results = { ok: false, installed: {}, cases: {}, refused: {} };

/* Spies replace the real transports before the guard loads: the guard wraps
 * these functions, so "delegated" means the guard let the call through to the
 * spy — never to a real socket. */
const delegated = [];
const http = require('node:http'), https = require('node:https');
const spy = kind => function () { delegated.push(kind); return { on() {}, end() {} }; };
globalThis.fetch = function spyFetch() { delegated.push('fetch'); return Promise.resolve({ spy: true }); };
http.request = spy('http.request'); http.get = spy('http.get');
https.request = spy('https.request'); https.get = spy('https.get');

process.env.Z4_NETWORK_TRACE = path.join(world, 'probe-trace.jsonl');
process.env.Z4_NETWORK_ROLE = 'probe';
require(guardPath);

const judge = action => {
  const before = delegated.length;
  try { action(); } catch (error) {
    if (error && error.code === 'Z4_OFFLINE_BLOCKED') return 'blocked';
    return 'error:' + ((error && error.code) || 'unknown');
  }
  return delegated.length > before ? 'delegated' : 'noop';
};
const expect = (name, expected, action) => { results.cases[name] = { expected, actual: judge(action) }; };

/* The three red-test regressions: a disguised fetch object must be refused by
 * shape (never delegated), a bracket-suffix host must not pass as ::1, and a
 * real bare '::1' must be accepted. */
expect('disguisedFetchObject', 'blocked', () => globalThis.fetch({ url: 'http://127.0.0.1:7788/', toString: () => 'https://example.invalid/' }));
expect('fetchIPv6BracketSuffixHost', 'blocked', () => globalThis.fetch('http://[::1]example.invalid/'));
expect('fetchValidIPv6', 'delegated', () => globalThis.fetch('http://[::1]:7788/'));
expect('externalString', 'blocked', () => globalThis.fetch('https://example.invalid/z4-probe'));
expect('externalURL', 'blocked', () => globalThis.fetch(new URL('https://example.invalid/')));
expect('externalRequest', 'blocked', () => globalThis.fetch(new Request('https://example.invalid/')));
expect('loopbackString', 'delegated', () => globalThis.fetch('http://127.0.0.1:7788/x'));
expect('loopbackURL', 'delegated', () => globalThis.fetch(new URL('http://localhost:7788/x')));
expect('loopbackRequest', 'delegated', () => globalThis.fetch(new Request('http://127.0.0.1:7788/x')));
expect('httpExternalString', 'blocked', () => http.request('https://example.invalid/'));
expect('httpExternalURL', 'blocked', () => http.request(new URL('https://example.invalid/')));
expect('httpUrlOptionsOverrideExternal', 'blocked', () => http.request(new URL('http://127.0.0.1:7788/'), { host: 'example.invalid' }));
expect('httpUrlOptionsOverrideLoopback', 'blocked', () => http.request(new URL('https://example.invalid/'), { host: '127.0.0.1' }));
expect('httpIPv6BracketSuffixHost', 'blocked', () => http.request({ host: '[::1]example.invalid' }));
expect('httpUnclosedBracketHost', 'blocked', () => http.request({ host: '[::1' }));
expect('httpIPv6BareHostname', 'delegated', () => http.request({ hostname: '::1', port: 7788, path: '/' }));
expect('httpIPv6BracketedHostname', 'delegated', () => http.request({ hostname: '[::1]', port: 7788, path: '/' }));
expect('httpLoopbackOptionsOnly', 'delegated', () => http.request({ port: 7788, path: '/' }));
expect('httpLoopbackHostWithPort', 'delegated', () => http.request({ host: '127.0.0.1:7788', path: '/' }));
expect('httpGetLoopbackString', 'delegated', () => http.get('http://127.0.0.1:7788/x'));
expect('httpsGetExternalString', 'blocked', () => https.get('https://example.invalid/'));

const trace = { installed: {}, blocked: 0, lines: 0 };
try {
  for (const line of fs.readFileSync(process.env.Z4_NETWORK_TRACE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    trace.lines++;
    if (entry.event === 'installed') trace.installed[entry.api] = (trace.installed[entry.api] || 0) + 1;
    if (entry.event === 'blocked') trace.blocked++;
  }
} catch { /* a missing trace surfaces as missing installs below */ }
results.installed = trace.installed;

/* Fixed-code refusal of missing, unsafe and linked trace targets. Refused
 * initialization never writes; the unsafe path is outside tmpdir on purpose. */
const refuseProbe = envOverrides => {
  const env = { ...process.env };
  delete env.Z4_NETWORK_TRACE;
  delete env.Z4_NETWORK_ROLE;
  Object.assign(env, envOverrides);
  const child = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(guardPath)})`], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return (child.stderr || '').includes('Z4_TRACE_UNSAFE') ? 'refused' : 'not-refused';
};
results.refused.missingTrace = refuseProbe({});
results.refused.unsafeTrace = refuseProbe({ Z4_NETWORK_TRACE: path.resolve('z4-guard-unsafe-trace.jsonl') });
try {
  const outside = path.join(world, 'outside.txt');
  fs.writeFileSync(outside, 'x');
  const link = path.join(world, 'linked-trace.jsonl');
  fs.symlinkSync(outside, link, 'file');
  results.refused.linkedTrace = refuseProbe({ Z4_NETWORK_TRACE: link });
} catch (error) {
  results.refused.linkedTrace = 'skipped';
}

const failedCases = Object.keys(results.cases).filter(name => results.cases[name].actual !== results.cases[name].expected);
results.ok = failedCases.length === 0
  && results.refused.missingTrace === 'refused'
  && results.refused.unsafeTrace === 'refused'
  && ['refused', 'skipped'].includes(results.refused.linkedTrace)
  && ['fetch', 'http.request', 'http.get', 'https.request', 'https.get'].every(api => (results.installed[api] || 0) >= 1);
fs.rmSync(world, { recursive: true, force: true });
console.log(JSON.stringify(results));
process.exitCode = results.ok ? 0 : 1;