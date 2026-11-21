'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const { createSessionFetch } = require('../electron/app-update-fetch.cjs');
const { createAppUpdate } = require('../electron/app-update.cjs');

function updateOwner(t, fetchImpl) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-update-headers-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('verified fixture');
  const asset = { name: 'Pi-GUI-Setup-1.2.3.exe', size: bytes.length,
    url: 'https://github.com/HYJ1817/pi-gui/releases/download/v1.2.3/Pi-GUI-Setup-1.2.3.exe',
    digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
  const updater = createAppUpdate({ directory, version: '1.2.2', mode: 'installed', fetchImpl,
    readUpdate: async () => ({ ok: true, updateAvailable: true, latestVersion: '1.2.3',
      release: { tag: 'v1.2.3', assets: [asset] } }),
    prepare: async () => assert.fail('rejected response cannot prepare an install'),
    launch: async () => assert.fail('rejected response cannot launch an installer'),
    quit: async () => assert.fail('rejected response cannot quit the app') });
  return { updater, directory, size: bytes.length };
}

function fakeRequest(t, emit) {
  const calls = { options: null, ended: 0, aborted: 0, followed: 0 };
  const client = new EventEmitter();
  Object.assign(client, {
    end() { calls.ended++; queueMicrotask(() => emit(client)); },
    abort() { calls.aborted++; },
    followRedirect() { calls.followed++; },
  });
  t.after(() => client.removeAllListeners());
  return { calls, client, request(options) { calls.options = options; return client; } };
}

test('updater Session transport exposes redirect status and Location without following it or sending cookies', async t => {
  const location = 'https://objects.githubusercontent.com/asset';
  const fixture = fakeRequest(t, client => client.emit('redirect', 302, 'GET', location, { Location: [location] }));
  const session = { marker: 'frozen-session' };
  const fetch = createSessionFetch({ session, request: fixture.request });
  const response = await fetch('https://github.com/HYJ1817/pi-gui/releases/download/v1.2.3/file.exe', {
    redirect: 'manual', credentials: 'omit', headers: { Accept: 'application/octet-stream' },
  });
  assert.equal(response.status, 302);
  assert.equal(response.ok, false);
  assert.equal(response.headers.get('location'), location);
  assert.equal(fixture.calls.options.session, session);
  assert.equal(fixture.calls.options.credentials, 'omit');
  assert.equal(fixture.calls.options.useSessionCookies, false);
  assert.equal(fixture.calls.options.method, 'GET');
  assert.equal(fixture.calls.ended, 1);
  assert.equal(fixture.calls.aborted, 1);
  assert.equal(fixture.calls.followed, 0);
});

test('updater Session transport streams response bytes and preserves bounded headers', async t => {
  const fixture = fakeRequest(t, client => client.emit('response', Object.assign(Readable.from([Buffer.from('verified bytes')]), {
    statusCode: 200, headers: { 'content-length': '14', 'x-ignore': 'unused' },
  })));
  const fetch = createSessionFetch({ session: {}, request: fixture.request });
  const response = await fetch('https://github.com/HYJ1817/pi-gui/releases/download/v1.2.3/file.exe');
  const chunks = [];
  for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
  assert.equal(response.ok, true);
  assert.equal(response.headers.get('content-length'), '14');
  assert.equal(response.headers.get('x-ignore'), 'unused');
  assert.equal(Buffer.concat(chunks).toString(), 'verified bytes');
});

test('updater Session transport aborts an active response body after headers', async t => {
  const body = new Readable({ read() {} });
  const fixture = fakeRequest(t, client => client.emit('response', Object.assign(body, { statusCode: 200, headers: {} })));
  const fetch = createSessionFetch({ session: {}, request: fixture.request });
  const controller = new AbortController();
  const response = await fetch('https://github.com/HYJ1817/pi-gui/releases/download/v1.2.3/file.exe', { signal: controller.signal });
  const reading = (async () => { for await (const _chunk of response.body) {} })();
  controller.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(body.destroyed, true);
});

test('updater owner rejects length headers before reading and closes the native response without masking checksum', async t => {
  let reads = 0;
  const body = new Readable({ read() { reads++; } });
  const fixture = fakeRequest(t, client => client.emit('response', Object.assign(body, {
    statusCode: 200, headers: { 'content-length': '999' },
  })));
  const { updater, directory } = updateOwner(t, createSessionFetch({ session: {}, request: fixture.request }));
  const result = await updater.download({ confirm: true });
  assert.equal(result.code, 'checksum');
  assert.equal(updater.state().phase, 'failed');
  assert.equal(reads, 0, 'untrusted length is rejected before a reader is attached');
  assert.equal(body.destroyed, true);
  assert.equal(fixture.calls.aborted, 1);
  assert.doesNotThrow(() => body.emit('error', Error('late native body error')));
  assert.doesNotThrow(() => fixture.client.emit('error', Error('late native client error')));
  assert.equal(updater.state().phase, 'failed');
  assert.deepEqual(fs.readdirSync(directory), [], 'neither partial bytes nor ready metadata survive');
});

test('updater owner disposes rejected status and redirect bodies before returning an error', async t => {
  for (const [status, headers, code] of [[503, {}, 'network'],
    [302, { location: 'https://untrusted.example/installer.exe' }, 'untrusted']]) {
    const body = new Readable({ read() { assert.fail('rejected body must not be consumed'); } });
    const fixture = fakeRequest(t, client => client.emit('response', Object.assign(body, { statusCode: status, headers })));
    const { updater, directory } = updateOwner(t, createSessionFetch({ session: {}, request: fixture.request }));
    assert.equal((await updater.download({ confirm: true })).code, code);
    assert.equal(body.destroyed, true);
    assert.equal(fixture.calls.aborted, 1);
    assert.deepEqual(fs.readdirSync(directory), []);
  }
});

test('updater owner also cancels an unread WHATWG response on header rejection', async t => {
  let cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled++; } });
  const { updater } = updateOwner(t, async () => new Response(body, { headers: { 'content-length': '999' } }));
  assert.equal((await updater.download({ confirm: true })).code, 'checksum');
  assert.equal(cancelled, 1);
});

test('updater Session transport handles post-header client failure before any reader exists', async t => {
  const body = new Readable({ read() {} });
  const fixture = fakeRequest(t, client => client.emit('response', Object.assign(body, { statusCode: 200, headers: {} })));
  const fetch = createSessionFetch({ session: {}, request: fixture.request });
  const response = await fetch('https://github.com/HYJ1817/pi-gui/releases/download/v1.2.3/file.exe');
  fixture.client.emit('error', Error('private native detail'));
  assert.equal(body.destroyed, true);
  await assert.rejects(async () => { for await (const _chunk of response.body) {} }, /update_transport_failed/);
  assert.equal(fixture.calls.aborted, 1);
});

test('updater Session transport aborts pending requests and rejects unsafe URL forms', async t => {
  const fixture = fakeRequest(t, () => {});
  const fetch = createSessionFetch({ session: {}, request: fixture.request });
  const controller = new AbortController();
  const pending = fetch('https://github.com/HYJ1817/pi-gui/releases/download/v1.2.3/file.exe', { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fixture.calls.aborted, 1);
  for (const url of ['http://example.com/file', 'https://user:pass@example.com/file', 'file:///private']) {
    await assert.rejects(fetch(url), /invalid_update_url/);
  }
});
