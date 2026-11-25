/* Unified preview security/HTTP regression. Every write is inside os.tmpdir().
 * Uses the production Router/auth/files/grant ledger and real file descriptors;
 * fault hooks mutate real fixtures at precisely defined read/stream boundaries. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const TOKEN = 'preview-test-only-local-token';
const A = '11111111-2222-4333-8444-555555555555';
const B = '99999999-8888-4777-8666-555555555555';
const C = '22222222-3333-4444-8555-666666666666';
const MiB = 1024 * 1024;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let checks = 0;
let assertions = 0;
const eq = (a, b, message) => { assertions++; assert.deepEqual(a, b, message); };
const ok = (value, message) => { assertions++; assert.ok(value, message); };
async function check(name, fn) { await fn(); checks++; console.log('  ok  ' + name); }
const write = (root, rel, content) => {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
};
function wav(size = 1024) {
  const buffer = Buffer.alloc(Math.max(44, size), 1);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(buffer.length - 44, 40);
  return buffer;
}
function sparse(root, rel, size, header) {
  const abs = write(root, rel, header);
  fs.truncateSync(abs, size);
  return abs;
}

(async () => {
  const started = performance.now();
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-file-preview-'));
  const rootA = path.join(world, 'a');
  const rootB = path.join(world, 'b');
  const outside = path.join(world, 'outside');
  fs.mkdirSync(rootA); fs.mkdirSync(rootB); fs.mkdirSync(outside);
  const { createFiles, FILE_LIMITS } = await import('../server/files.js');
  const { createExternalGrants } = await import('../server/external-grants.js');
  const { createRouter } = await import('../server/router.js');
  const { createAuth } = await import('../server/auth.js');
  const { PREVIEW_LIMITS, previewPolicy, previewRange } = await import('../lib/file-preview-policy.js');
  const { PREVIEW_CHUNK_BYTES } = await import('../lib/file-preview-reader.js');
  const scopes = {
    [A]: { root: rootA, scopeId: 'workspace-a', generation: '1', conversationId: A },
    [B]: { root: rootB, scopeId: 'workspace-b', generation: '1', conversationId: B },
    [C]: { root: rootA, scopeId: 'workspace-a', generation: '1', conversationId: C },
    classic: { root: rootA, scopeId: 'classic', generation: '1', conversationId: null },
  };
  const grants = createExternalGrants();
  let onResolve = null;
  const files = createFiles({ grants, scopeForRequest: async req => {
    if (onResolve) await onResolve(req);
    return scopes[req.headers?.['x-pi-gui-conversation'] ?? 'classic'] || null;
  } });
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const router = createRouter({ auth: createAuth({ port, token: TOKEN }), sse: { subscribe() {} },
    rpc: { send() {}, abortAndWait() {}, getState() { return {}; } }, files });
  let nextWriteHook = null;
  server.on('request', (req, res) => {
    const hook = nextWriteHook;
    nextWriteHook = null;
    if (hook) {
      const original = res.write.bind(res);
      let written = 0;
      res.write = (chunk, ...args) => {
        const result = original(chunk, ...args);
        written++;
        const blocked = hook({ req, res, chunk, written });
        if (blocked === false) {
          // Deterministic slow-consumer fault: withhold drain on a real HTTP
          // response, so only the watchdog (not a subsequent read) can abort it.
          const emit = res.emit;
          res.emit = function (event, ...eventArgs) {
            if (event === 'drain') return false;
            return emit.call(this, event, ...eventArgs);
          };
          return false;
        }
        return result;
      };
    }
    return router(req, res);
  });
  const urlFor = (route, args) => route + '?' + new URLSearchParams(args);
  const request = async (url, { conversation = A, headers = {}, method = 'GET', auth = true } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method,
      headers: { ...(auth ? { 'x-pi-gui-token': TOKEN } : {}),
        ...(conversation === null ? {} : { 'x-pi-gui-conversation': conversation }), ...headers } });
    const bytes = Buffer.from(await response.arrayBuffer());
    const body = response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(bytes.toString()) : null;
    return { status: response.status, headers: response.headers, bytes, body };
  };
  const metadata = (rel, options = {}) => request(urlFor('/api/files/metadata', { path: rel, root: options.root || rootA }), options);
  const contentUrl = (rel, fileId, extra = {}) => urlFor('/api/files/content', { path: rel, root: rootA, fileId, ...extra });
  const externalUrl = (route, target, grantId, extra = {}) => urlFor('/api/files/external/' + route, { path: target, grant: grantId, ...extra });
  const approve = (rawPath, scopeKind = 'directory', scope = scopes[A]) => {
    const { approval } = grants.inspect({ rawPath, scopeKind, scope });
    return grants.create({ approval, scopeKind, scope }).grant;
  };
  const streamResult = (url, hook, headers = {}) => new Promise((resolve, reject) => {
    nextWriteHook = hook;
    let response;
    const timeout = setTimeout(() => { response?.destroy(); reject(new Error('stream did not terminate within 5s')); }, 5000);
    const start = performance.now();
    const req = http.get({ host: '127.0.0.1', port, path: url, agent: false,
      headers: { 'x-pi-gui-token': TOKEN, 'x-pi-gui-conversation': A, ...headers } }, res => {
      response = res;
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', () => {}); // premature close is the expected fail-closed signal
      res.on('close', () => {
        clearTimeout(timeout);
        resolve({ status: res.statusCode, complete: res.complete, bytes: Buffer.concat(chunks), elapsed: performance.now() - start });
      });
    });
    req.on('error', error => {
      clearTimeout(timeout);
      if (!response && error.code === 'ECONNRESET') {
        // A slow filesystem mutation may let the watchdog close before even
        // the first header flush; zero bytes is also a correct aborted stream.
        resolve({ status: null, complete: false, bytes: Buffer.alloc(0), elapsed: performance.now() - start });
      } else reject(error);
    });
  });

  try {
    write(rootA, 'same.txt', 'workspace A'); write(rootB, 'same.txt', 'workspace B');
    write(rootA, 'empty.txt', ''); write(rootA, 'image.png', PNG);
    write(rootA, 'movie.wav', wav(2 * MiB));
    write(rootA, 'range.txt', '0123456789');
    write(rootA, 'preview.html', '<script>globalThis.BAD=1</script>');
    write(rootA, 'image.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    const doc = await metadata('same.txt');
    const id = doc.body.file.fileId;
    const rangeMeta = await metadata('range.txt');
    const rangeUrl = contentUrl('range.txt', rangeMeta.body.file.fileId);

    await check('new endpoints retain production Origin, token and HTTP method gates', async () => {
      for (const url of [rangeUrl, '/api/files/search?q=same', '/api/files/external/content']) {
        eq((await request(url, { auth: false })).status, 401);
        eq((await request(url, { headers: { Origin: 'https://evil.example' } })).status, 403);
        eq((await request(url, { method: 'POST' })).status, 405);
      }
    });
    await check('metadata projects format budget without reading content; content requires fileId even with tree token', async () => {
      eq(doc.status, 200); eq(doc.body.file.bytes, 11); eq(doc.body.file.type, 'text');
      eq(doc.body.file.maxBytes, 4 * MiB); eq(doc.body.file.range, false);
      ok(!JSON.stringify(doc.body).includes('workspace A'));
      const tree = await request('/api/files');
      const missing = await request(urlFor('/api/files/content', { path: 'same.txt', workspace: tree.body.workspace.id, generation: tree.body.workspace.generation }));
      eq(missing.status, 428); eq(missing.body.code, 'file_identity_required');
      eq((await request(contentUrl('same.txt', id))).bytes.toString(), 'workspace A');
      eq((await request(urlFor('/api/files/content', { path: 'same.txt', fileId: id }))).body.code, 'binding_required');
    });
    await check('content returns actual bytes with sandbox/no-store/nosniff/attachment and empty-file semantics', async () => {
      const response = await request(rangeUrl);
      eq(response.status, 200); eq(response.bytes.toString(), '0123456789');
      eq(response.headers.get('content-length'), '10'); eq(response.headers.get('accept-ranges'), 'bytes');
      eq(response.headers.get('cache-control'), 'no-store'); eq(response.headers.get('x-content-type-options'), 'nosniff');
      eq(response.headers.get('content-disposition'), 'attachment');
      ok(response.headers.get('content-security-policy').includes('sandbox'));
      const emptyMeta = await metadata('empty.txt');
      const empty = await request(contentUrl('empty.txt', emptyMeta.body.file.fileId));
      eq(empty.status, 200); eq(empty.bytes.length, 0);
    });
    await check('single ranges have exact inclusive start/end, clamped EOF and suffix bytes', async () => {
      for (const [range, expected, header] of [
        ['bytes=0-0', '0', 'bytes 0-0/10'], ['bytes=2-5', '2345', 'bytes 2-5/10'],
        ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-3', '789', 'bytes 7-9/10'],
        ['bytes=-99', '0123456789', 'bytes 0-9/10'], ['bytes=8-99', '89', 'bytes 8-9/10'],
      ]) {
        const response = await request(rangeUrl, { headers: { Range: range } });
        eq(response.status, 206, range); eq(response.bytes.toString(), expected, range);
        eq(response.headers.get('content-range'), header, range); eq(Number(response.headers.get('content-length')), expected.length);
      }
    });
    await check('malformed/multi/unsatisfiable/zero-suffix/overflow ranges yield 416 and true file size', async () => {
      for (const range of ['bytes=10-', 'bytes=8-7', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'items=0-1', 'bytes=1.5-3', 'bytes=+1-2', 'bytes=9007199254740993-', 'bytes=0-9007199254740993']) {
        const response = await request(rangeUrl, { headers: { Range: range } });
        eq(response.status, 416, range); eq(response.headers.get('content-range'), 'bytes */10', range);
        eq(response.body.code, 'range_not_satisfiable');
      }
      const emptyMeta = await metadata('empty.txt');
      const empty = await request(contentUrl('empty.txt', emptyMeta.body.file.fileId), { headers: { Range: 'bytes=0-' } });
      eq(empty.status, 416); eq(empty.headers.get('content-range'), 'bytes */0');
    });
    await check('8 MiB media windows support native open-ended Range, explicit and suffix oversize is rejected', async () => {
      const full = wav(9 * MiB);
      write(rootA, 'large.wav', full);
      const meta = await metadata('large.wav');
      eq(meta.body.file.type, 'media'); eq(meta.body.file.range, true);
      eq(meta.body.file.mime, 'audio/wav'); eq(meta.body.file.maxBytes, 1024 * MiB);
      const url = contentUrl('large.wav', meta.body.file.fileId);
      eq((await request(url)).status, 413);
      const first = await request(url, { headers: { Range: 'bytes=0-' } });
      eq(first.status, 206); eq(first.bytes.length, 8 * MiB); eq(first.bytes, full.subarray(0, 8 * MiB));
      eq(first.headers.get('content-range'), `bytes 0-${8 * MiB - 1}/${full.length}`);
      const tail = await request(url, { headers: { Range: `bytes=${8 * MiB}-` } });
      eq(tail.status, 206); eq(tail.bytes, full.subarray(8 * MiB));
      for (const range of [`bytes=0-${8 * MiB}`, `bytes=-${8 * MiB + 1}`]) {
        const response = await request(url, { headers: { Range: range } });
        eq(response.status, 416); eq(response.headers.get('content-range'), `bytes */${full.length}`);
      }
      console.log(`      measured media windows: ${first.bytes.length} + ${tail.bytes.length} bytes`);
    });
    await check('query conversation resolves through the identical scope owner; conflicts and duplicates fail closed', async () => {
      const query = contentUrl('same.txt', id, { conversation: A });
      eq((await request(query, { conversation: null })).bytes.toString(), 'workspace A');
      eq((await request(query)).status, 200);
      eq((await request(query, { conversation: B })).status, 400);
      eq((await request(query + '&conversation=' + A)).status, 400);
      eq((await request(contentUrl('same.txt', id, { conversation: 'missing' }), { conversation: null })).status, 409);
      eq((await request(contentUrl('same.txt', id), { conversation: C })).status, 409);
      eq((await request(contentUrl('same.txt', id), { conversation: B })).status, 409);
      eq((await request(contentUrl('same.txt', id, { path: 'same.txt', root: rootB }), { conversation: B })).status, 409);
      eq((await request(rangeUrl + '&fileId=' + rangeMeta.body.file.fileId)).status, 400);
    });
    await check('raw bytes never permit traversal, absolute paths, ADS, reserved names or internal/external junctions', async () => {
      write(outside, 'secret.txt', 'outside secret');
      fs.symlinkSync(outside, path.join(rootA, 'escape'), 'junction');
      fs.symlinkSync(path.join(rootA), path.join(rootA, 'inside-link'), 'junction');
      for (const rel of ['../outside/secret.txt', path.join(outside, 'secret.txt'), 'same.txt:secret', 'CON.txt', 'escape/secret.txt', 'inside-link/same.txt']) {
        const response = await request(contentUrl(rel, id));
        eq(response.status, 403, rel); ok(!response.bytes.includes(Buffer.from('outside secret')));
      }
    });
    await check('metadata fileId captures full stat including ctime after same-size rewrite/mtime rollback', async () => {
      const target = write(rootA, 'rewrite.txt', 'before');
      const before = fs.statSync(target);
      const meta = await metadata('rewrite.txt');
      const changed = fs.openSync(target, 'r+');
      fs.writeSync(changed, Buffer.from('AFTER!'), 0, 6, 0); fs.fsyncSync(changed); fs.closeSync(changed);
      fs.utimesSync(target, before.atime, before.mtime);
      const after = await request(contentUrl('rewrite.txt', meta.body.file.fileId));
      eq(after.status, 409); eq(after.body.code, 'file_changed');
      ok(!after.bytes.includes(Buffer.from('AFTER!')));
    });
    await check('correct image/media/document heads pass while HTML/SVG are inert downloadable bytes', async () => {
      for (const rel of ['image.png', 'movie.wav', 'preview.html', 'image.svg']) {
        const meta = await metadata(rel);
        const response = await request(contentUrl(rel, meta.body.file.fileId));
        eq(response.status, 200, rel); eq(response.bytes, fs.readFileSync(path.join(rootA, rel)));
        if (rel.endsWith('.html') || rel.endsWith('.svg')) eq(response.headers.get('content-type'), 'application/octet-stream');
      }
      write(rootA, 'report.pdf', '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
      const meta = await metadata('report.pdf');
      eq((await request(contentUrl('report.pdf', meta.body.file.fileId))).status, 200);
    });
    await check('every known executable magic is refused before any Range can bypass its header', async () => {
      const { EXECUTABLE_MAGIC } = await import('../server/open-policy.js');
      let number = 0;
      for (const { bytes } of EXECUTABLE_MAGIC) {
        const rel = `disguise-${number++}.png`;
        write(rootA, rel, Buffer.concat([bytes, Buffer.alloc(64, 65)]));
        const meta = await metadata(rel);
        const response = await request(contentUrl(rel, meta.body.file.fileId), { headers: { Range: 'bytes=32-40' } });
        eq(response.status, 415, rel); eq(response.body.code, 'unsafe_type');
        ok(!response.bytes.includes(Buffer.alloc(9, 65)));
      }
      for (const [name, text] of [['obscured.txt', '﻿  #!/bin/sh\nnot-executed'], ['source.sh', '#!/bin/sh\nprintf "read-only"'], ['source.py', '#!/usr/bin/env python3\nprint("read-only")']]) {
        write(rootA, name, text);
        const meta = await metadata(name);
        const response = await request(contentUrl(name, meta.body.file.fileId));
        eq(response.status, 200); eq(response.bytes.toString('utf8'), text);
        eq(response.headers.get('content-disposition'), 'attachment');
      }
    });
    await check('wrong binary/image/media/document headers cannot be blessed by extension', async () => {
      for (const [rel, bytes] of [
        ['fake.png', '<html>not png</html>'], ['fake.wav', 'RIFFxxxxxxxxAVI xxxxx'],
        ['fake.mp4', 'PK\x03\x04not a media container'], ['fake.pdf', '<script>bad()</script>'],
        ['fake.docx', 'not a zip'], ['binary.txt', Buffer.from([1, 0, 2, 0])],
      ]) {
        write(rootA, rel, bytes);
        const meta = await metadata(rel);
        eq((await request(contentUrl(rel, meta.body.file.fileId))).status, 415, rel);
      }
    });
    await check('type-specific total budgets cannot be bypassed using a tiny Range', async () => {
      for (const [rel, header] of [ ['large.txt', Buffer.from('text')], ['big.png', PNG],
        ['big.pdf', Buffer.from('%PDF-1.4\n')], ['big.docx', Buffer.from('PK\x03\x04')],
        ['big.zip', Buffer.from('PK\x03\x04')], ['huge.wav', wav(44)] ]) {
        const policy = previewPolicy(rel);
        sparse(rootA, rel, policy.maxBytes + 1, header);
        const meta = await metadata(rel);
        const response = await request(contentUrl(rel, meta.body.file.fileId), { headers: { Range: 'bytes=0-3' } });
        eq(response.status, 413, rel); eq(response.body.code, 'oversized');
      }
      // Parser policy and transfer policy are independent, exported and exact.
      eq(PREVIEW_LIMITS.maxRangeBytes, 8 * MiB);
      eq(previewRange('bytes=0-', 16 * MiB).length, 8 * MiB);
    });

    const externalFile = write(outside, 'external.txt', 'external text');
    const dirGrant = approve(outside);
    const externalMeta = await request(externalUrl('metadata', externalFile, dirGrant.id));
    const externalId = externalMeta.body.file.fileId;
    await check('external metadata token is scoped to the existing grant, conversation and workspace', async () => {
      eq(externalMeta.status, 200); ok(/^[\w-]{32}$/.test(externalId));
      const url = externalUrl('content', externalFile, dirGrant.id, { fileId: externalId });
      eq((await request(url)).bytes.toString(), 'external text');
      eq((await request(externalUrl('content', externalFile, dirGrant.id))).status, 428);
      eq((await request(url, { conversation: C })).status, 403);
      const duplicate = approve(externalFile, 'file');
      eq((await request(externalUrl('content', externalFile, duplicate.id, { fileId: externalId }))).status, 409);
      const classicGrant = approve(externalFile, 'file', scopes.classic);
      const classicMeta = await request(externalUrl('metadata', externalFile, classicGrant.id), { conversation: null });
      scopes.classic = { ...scopes.classic, root: rootB };
      eq((await request(externalUrl('content', externalFile, classicGrant.id, { fileId: classicMeta.body.file.fileId }), { conversation: null })).status, 403);
      scopes.classic = { ...scopes.classic, root: rootA };
    });
    await check('directory grants do not allow stale preview ids to read replaced or in-place rewritten files', async () => {
      const target = write(outside, 'replacement.txt', 'before');
      const meta = await request(externalUrl('metadata', target, dirGrant.id));
      const old = fs.statSync(target);
      fs.writeFileSync(target, 'AFTER!'); fs.utimesSync(target, old.atime, old.mtime);
      const response = await request(externalUrl('content', target, dirGrant.id, { fileId: meta.body.file.fileId }));
      eq(response.status, 409); eq(response.body.code, 'file_changed');
      eq((await request(externalUrl('metadata', target, dirGrant.id))).status, 200);
      fs.renameSync(target, target + '.old'); fs.writeFileSync(target, 'ATTACK');
      eq((await request(externalUrl('content', target, dirGrant.id, { fileId: meta.body.file.fileId }))).status, 409);
    });
    await check('external media query owner and suffix Range reuse the same grant and format gate', async () => {
      const target = write(outside, 'external.wav', wav(1024));
      const meta = await request(externalUrl('metadata', target, dirGrant.id));
      const url = externalUrl('content', target, dirGrant.id, { fileId: meta.body.file.fileId, conversation: A });
      const response = await request(url, { conversation: null, headers: { Range: 'bytes=-10' } });
      eq(response.status, 206); eq(response.bytes.length, 10); eq(response.headers.get('content-range'), 'bytes 1014-1023/1024');
      eq((await request(url, { conversation: B })).status, 400);
      const disguise = write(outside, 'invoice.pdf', Buffer.from('MZ-secret-payload'));
      const disguiseMeta = await request(externalUrl('metadata', disguise, dirGrant.id));
      eq((await request(externalUrl('content', disguise, dirGrant.id, { fileId: disguiseMeta.body.file.fileId }))).status, 415);
    });
    await check('revocation invalidates external content immediately with no cached-byte replay', async () => {
      const grant = approve(externalFile, 'file');
      const meta = await request(externalUrl('metadata', externalFile, grant.id));
      grants.revoke({ id: grant.id, scope: scopes[A] });
      const response = await request(externalUrl('content', externalFile, grant.id, { fileId: meta.body.file.fileId }));
      eq(response.status, 403); eq(response.body.code, 'grant_invalid');
    });
    await check('mid-read real-file replacement is detected before the first content byte leaves', async () => {
      const target = write(rootA, 'read-race.txt', 'old content');
      const meta = await metadata('read-race.txt');
      const originalOpen = fs.promises.open;
      let injected = false;
      fs.promises.open = async (...args) => {
        const handle = await originalOpen.apply(fs.promises, args);
        if (path.resolve(String(args[0])) === path.resolve(target)) {
          const originalRead = handle.read.bind(handle);
          handle.read = async (...readArgs) => {
            const result = await originalRead(...readArgs);
            if (!injected) { injected = true; fs.writeFileSync(target, 'NEW SECRET!'); }
            return result;
          };
        }
        return handle;
      };
      try {
        const response = await request(contentUrl('read-race.txt', meta.body.file.fileId));
        ok(injected); eq(response.status, 409); ok(!response.bytes.includes(Buffer.from('NEW SECRET!')));
      } finally { fs.promises.open = originalOpen; }
    });
    await check('external revocation during a descriptor read discards the entire first buffer', async () => {
      const target = write(outside, 'read-revoke.txt', 'never-disclose-this');
      const grant = approve(target, 'file');
      const meta = await request(externalUrl('metadata', target, grant.id));
      const originalOpen = fs.promises.open;
      let injected = false;
      fs.promises.open = async (...args) => {
        const handle = await originalOpen.apply(fs.promises, args);
        if (path.resolve(String(args[0])) === path.resolve(target)) {
          const originalRead = handle.read.bind(handle);
          handle.read = async (...readArgs) => {
            const result = await originalRead(...readArgs);
            if (!injected) { injected = true; grants.revoke({ id: grant.id, scope: scopes[A] }); }
            return result;
          };
        }
        return handle;
      };
      try {
        const response = await request(externalUrl('content', target, grant.id, { fileId: meta.body.file.fileId }));
        ok(injected); eq(response.status, 403); ok(!response.bytes.includes(Buffer.from('never-disclose-this')));
      } finally { fs.promises.open = originalOpen; }
    });
    await check('external directory bounds and format budgets cannot be bypassed with object tokens', async () => {
      const target = sparse(outside, 'oversized.png', PREVIEW_LIMITS.maxImageBytes + 1, PNG);
      const meta = await request(externalUrl('metadata', target, dirGrant.id));
      eq((await request(externalUrl('content', target, dirGrant.id, { fileId: meta.body.file.fileId }), { headers: { Range: 'bytes=0-3' } })).status, 413);
      fs.symlinkSync(outside, path.join(outside, 'internal-junction'), 'junction');
      const alias = path.join(outside, 'internal-junction', 'external.txt');
      const aliasMeta = await request(externalUrl('metadata', alias, dirGrant.id));
      eq(aliasMeta.status, 200);
      eq((await request(externalUrl('content', alias, dirGrant.id, { fileId: aliasMeta.body.file.fileId }))).status, 403);
      const escape = await request(externalUrl('content', path.join(rootB, 'same.txt'), dirGrant.id, { fileId: externalId }));
      eq(escape.status, 403); eq(escape.body.code, 'grant_scope');
    });
    await check('scope change during an awaited read fails before payload disclosure', async () => {
      let resolved = 0;
      onResolve = async () => { if (++resolved === 3) scopes[A] = { ...scopes[A], generation: 'changed' }; };
      try {
        const response = await request(contentUrl('same.txt', id));
        eq(response.status, 409); eq(response.body.code, 'workspace_changed');
        ok(!response.bytes.includes(Buffer.from('workspace A')));
      } finally { onResolve = null; scopes[A] = { ...scopes[A], generation: '1' }; }
    });
    await check('revocation while a real HTTP stream is stalled aborts promptly, not after drain', async () => {
      const target = write(outside, 'stream.wav', wav(2 * MiB));
      const grant = approve(target, 'file');
      const meta = await request(externalUrl('metadata', target, grant.id));
      const url = externalUrl('content', target, grant.id, { fileId: meta.body.file.fileId });
      const result = await streamResult(url, ({ written }) => {
        if (written === 1) { grants.revoke({ id: grant.id, scope: scopes[A] }); return false; }
      });
      eq(result.status, 200); eq(result.complete, false); ok(result.bytes.length <= PREVIEW_CHUNK_BYTES);
      ok(result.elapsed < 2000); console.log(`      measured stalled-revoke: ${result.bytes.length} bytes, ${Math.round(result.elapsed)} ms`);
    });
    await check('workspace retirement while stalled terminates the original stream', async () => {
      const meta = await metadata('movie.wav');
      try {
        const result = await streamResult(contentUrl('movie.wav', meta.body.file.fileId), ({ written }) => {
          if (written === 1) { scopes[A] = { ...scopes[A], generation: '2' }; return false; }
        });
        eq(result.complete, false); ok(result.bytes.length <= PREVIEW_CHUNK_BYTES); ok(result.elapsed < 2000);
      } finally { scopes[A] = { ...scopes[A], generation: '1' }; }
    });
    await check('directory grant file replacement while stalled stops the existing descriptor too', async () => {
      const target = write(outside, 'stream-replace.wav', wav(2 * MiB));
      const meta = await request(externalUrl('metadata', target, dirGrant.id));
      const result = await streamResult(externalUrl('content', target, dirGrant.id, { fileId: meta.body.file.fileId }), ({ written }) => {
        if (written === 1) { fs.writeFileSync(target, Buffer.alloc(2 * MiB, 88)); return false; }
      });
      eq(result.complete, false); ok(result.bytes.length <= PREVIEW_CHUNK_BYTES);
      ok(!result.bytes.includes(Buffer.alloc(128, 88)));
    });

    await check('grant directory replacement while stalled is evicted and terminates the stream', async () => {
      const folder = path.join(world, 'stream-folder'); fs.mkdirSync(folder);
      const target = write(folder, 'inside.wav', wav(2 * MiB));
      const grant = approve(folder);
      const meta = await request(externalUrl('metadata', target, grant.id));
      let mutationError;
      const result = await streamResult(externalUrl('content', target, grant.id, { fileId: meta.body.file.fileId }), ({ written }) => {
        if (written === 1) {
          // Windows refuses renaming a directory containing a live open file;
          // unlink its name first (the reader still holds the old descriptor).
          try { fs.unlinkSync(target); fs.renameSync(folder, folder + '-old'); fs.mkdirSync(folder); write(folder, 'inside.wav', wav(1024)); }
          catch (error) { mutationError = error; throw error; }
          return false;
        }
      });
      if (mutationError) throw mutationError;
      eq(result.complete, false); ok(result.bytes.length <= PREVIEW_CHUNK_BYTES);
      eq(grants.list(scopes[A]).grants.some(g => g.id === grant.id), false);
    });

    write(rootA, 'search/deep/Needle.txt', 'one'); write(rootA, 'search/other.txt', 'two');
    write(rootA, '.hidden-needle.txt', 'hidden'); write(rootA, '.hidden/needle.txt', 'hidden');
    write(rootA, 'node_modules/needle.txt', 'dependency'); write(rootB, 'needle-b.txt', 'b');
    write(outside, 'needle-outside.txt', 'outside');
    const searchUrl = (q, extra = {}) => urlFor('/api/files/search', { q, root: rootA, ...extra });
    await check('search returns bounded workspace paths, explicit hidden control and never follows junctions', async () => {
      const response = await request(searchUrl('needle'));
      eq(response.status, 200); eq(response.body.matches.map(e => e.path), ['search/deep/Needle.txt']);
      eq(response.body.matches[0].bytes, 3); ok(!JSON.stringify(response.body.matches).includes(rootA));
      const hidden = await request(searchUrl('needle', { hidden: '1' }));
      eq(hidden.body.matches.length, 3);
      ok(hidden.body.matches.every(e => !e.path.includes('escape') && !e.path.includes('inside-link') && !e.path.includes('node_modules')));
      eq((await request(searchUrl('needle', { root: rootB }), { conversation: B })).body.matches.map(e => e.path), ['needle-b.txt']);
      eq((await request(searchUrl('needle'), { conversation: B })).status, 409);
      eq((await request('/api/files/search?q=needle')).status, 400);
      for (const query of ['', ' '.repeat(3), 'x'.repeat(201), '\u0001']) eq((await request(searchUrl(query))).status, 400);
    });
    await check('search caps results at 100 and excludes files below depth 8', async () => {
      for (let i = 0; i < 110; i++) write(rootA, `many/result-${i}.txt`, 'x');
      write(rootA, 'depth/' + 'd/'.repeat(7) + 'boundary-hit.txt', 'at depth8');
      write(rootA, 'depth/' + 'd/'.repeat(8) + 'too-deep-hit.txt', 'depth9');
      const many = await request(searchUrl('result-'));
      eq(many.body.matches.length, 100); eq(many.body.truncated, true); ok(many.body.visited <= 4000);
      const depth = await request(searchUrl('hit.txt'));
      eq(depth.body.matches.map(e => path.basename(e.path)), ['boundary-hit.txt']); eq(depth.body.truncated, true);
    });
    await check('search enumeration stops at 4000 entries even in one large directory', async () => {
      const budgetRoot = path.join(world, 'budget'); fs.mkdirSync(budgetRoot);
      for (let i = 0; i < 4005; i++) write(budgetRoot, `item-${i}.txt`, 'x');
      const budgetFiles = createFiles({ scopeForRequest: async () => ({ root: budgetRoot, scopeId: 'budget', generation: '1' }) });
      const result = await new Promise((resolve, reject) => {
        const req = { method: 'GET', url: '/api/files/search?' + new URLSearchParams({ q: 'not-present', root: budgetRoot }), headers: {} };
        const headers = {};
        const res = { destroyed: false, headersSent: false, setHeader: (key, value) => { headers[key] = value; },
          writeHead(status) { this.statusCode = status; }, end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); } };
        Promise.resolve(budgetFiles.handle(req, res, new URL(req.url, 'http://test.local'))).catch(reject);
      });
      eq(result.status, 200); eq(result.body.visited, FILE_LIMITS.maxFindEntries);
      eq(result.body.matches, []); eq(result.body.truncated, true);
    });
    await check('search refuses a directory swapped to a junction during asynchronous opendir', async () => {
      const folder = path.join(rootA, 'scan-race'); fs.mkdirSync(folder);
      write(folder, 'original-needle.txt', 'x');
      const originalOpenDir = fs.promises.opendir;
      let injected = false;
      fs.promises.opendir = async (...args) => {
        const dir = await originalOpenDir.apply(fs.promises, args);
        if (!injected && path.resolve(args[0]) === path.resolve(folder)) {
          injected = true;
          fs.renameSync(folder, folder + '-old'); fs.symlinkSync(outside, folder, 'junction');
        }
        return dir;
      };
      try {
        const result = await request(searchUrl('needle'));
        ok(injected); eq(result.status, 403); eq(result.body.code, 'unsafe_path');
        ok(!result.bytes.includes(Buffer.from('needle-outside')));
      } finally { fs.promises.opendir = originalOpenDir; fs.rmSync(folder, { recursive: true, force: true }); }
    });
    await check('search revalidates original scope before returning any async traversal results', async () => {
      let count = 0;
      onResolve = async () => { if (++count === 2) scopes[A] = { ...scopes[A], root: rootB }; };
      try {
        const result = await request(searchUrl('needle'));
        eq(result.status, 409); eq(result.body.code, 'workspace_changed');
        ok(!result.bytes.includes(Buffer.from('Needle.txt')));
      } finally { onResolve = null; scopes[A] = { ...scopes[A], root: rootA }; }
    });
    await check('old document and asset behavior remains usable without new content-only ids', async () => {
      const tree = await request('/api/files');
      const token = { workspace: tree.body.workspace.id, generation: tree.body.workspace.generation };
      const oldDoc = await request(urlFor('/api/files/document', { path: 'same.txt', ...token }));
      eq(oldDoc.status, 200); eq(oldDoc.body.file.content, 'workspace A');
      const oldImage = await request(urlFor('/api/files/asset', { path: 'image.png', ...token }));
      eq(oldImage.status, 200); eq(oldImage.bytes, PNG);
      eq((await request(externalUrl('document', externalFile, dirGrant.id))).status, 200);
    });
    console.log(`file-preview-backend: ${checks} checks, ${assertions} assertions passed (${Math.round(performance.now() - started)} ms)`);
  } finally {
    onResolve = null; nextWriteHook = null;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    grants.dispose();
    fs.rmSync(world, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
