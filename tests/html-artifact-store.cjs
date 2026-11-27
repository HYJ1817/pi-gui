/* Offline, real TEMP files. No user data, native Pi, network or model calls. */
const strict = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
let assertions = 0, checks = 0, skipped = 0;
const assert = new Proxy(strict, { get(target, key) {
  const value = target[key];
  return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value;
} });
const code = expected => error => error?.code === expected && error.message === expected
  && Object.keys(error).every(key => key === 'code');
const input = extra => ({ sessionId: 'session-a', messageId: 'message-a', toolCallId: 'call-a',
  title: '可视化快照', html: '<!doctype html><html><body>你好🙂</body></html>', ...extra });
const digest = value => createHash('sha256').update(value).digest('hex');
const idFor = value => digest(JSON.stringify(['pi-gui:html-artifact:v1', value.sessionId, value.messageId, value.toolCallId]));
const encoded = value => JSON.stringify(value) + '\n';
const tempPattern = /^\.tmp-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const filter = process.argv.find(arg => arg.startsWith('--filter='))?.slice('--filter='.length);
async function check(name, action) {
  if (filter && !name.includes(filter)) return;
  await action(); checks++; console.log('  ok ' + name);
}
async function nextScan() { await delay(20); return Date.now(); }
// Test-only native evidence fixture; real callers must scan inside the callback
// and exclude external native mutations until collect settles.
const collectScan = (store, proof) => store.collect({ scan: () => proof });
const barrier = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

(async () => {
  const { createHtmlArtifactStore, HTML_ARTIFACT_STORE_LIMITS } = await import('../server/html-artifact-store.js');
  const { projectHtmlArtifactReference, HTML_ARTIFACT_MAX_BYTES } = await import('../public/html-artifact-model.js');
  if (process.argv[2] === '--child') {
    const [dataDir, action] = process.argv.slice(3);
    const store = createHtmlArtifactStore({ dataDir, checkpoint(stage) {
      if (action === 'crash' && stage === 'before-rename') process.exit(73);
    } });
    try {
      if (action === 'collect' || action === 'scan-crash') {
        const result = await store.collect({ scan: () => {
          if (action === 'scan-crash') process.exit(74);
          return { complete: true, referencedIds: [idFor(input())], beforeMs: Date.now() };
        } });
        process.stdout.write(JSON.stringify({ ok: true, result }));
      } else {
        const ref = await store.publish(input());
        process.stdout.write(JSON.stringify({ ok: true, ref }));
      }
    } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code })); }
    return;
  }
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-html-store-'));
  let serial = 0;
  function fixture(extra = {}) {
    const dataDir = path.join(world, 'data-' + ++serial); fs.mkdirSync(dataDir);
    const options = { dataDir, ...extra }, root = path.join(dataDir, 'html-artifacts');
    return { dataDir, options, root, store: createHtmlArtifactStore(options),
      dir: ref => path.join(root, typeof ref === 'string' ? ref : ref.id) };
  }
  const child = (f, action) => spawnSync(process.execPath, [__filename, '--child', f.dataDir, action],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  async function savedFixture(extra) {
    const f = fixture(extra); f.ref = await f.store.publish(input()); return f;
  }
  async function confirm(f, refs = [f.ref.id]) {
    return collectScan(f.store, { referencedIds: refs, complete: true, beforeMs: await nextScan() });
  }
  try {
    await check('async API is exact and absent read does not create storage', async () => {
      const f = fixture();
      assert.deepEqual(Object.keys(f.store).sort(), ['cleanupTemporary', 'collect', 'publish', 'read']);
      const result = f.store.read('a'.repeat(64)); assert.ok(result instanceof Promise);
      await assert.rejects(result, code('html_artifact_not_found'));
      assert.equal(fs.existsSync(f.root), false);
      assert.deepEqual(await f.store.cleanupTemporary(), { removed: 0, retained: 0 });
    });
    await check('public ref is closed, HTML is exact UTF-8 and persisted independently', async () => {
      const f = fixture(), draft = input(), original = draft.html;
      const pending = f.store.publish(draft); draft.html = '<html>changed</html>';
      const ref = await pending, read = await f.store.read(ref.id);
      assert.deepEqual(projectHtmlArtifactReference(ref), ref);
      assert.equal(ref.id, idFor(input())); assert.equal(ref.contentRef, ref.id);
      assert.equal(ref.digest, digest(Buffer.from(original))); assert.equal(ref.bytes, Buffer.byteLength(original));
      assert.ok(ref.bytes > original.length); assert.equal(ref.height, 320);
      assert.deepEqual(read, { artifact: ref, html: original });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir(ref), 'reference.json'))), ref);
      assert.equal(fs.readFileSync(path.join(f.dir(ref), '.pending'), 'utf8'), '1\n');
      assert.deepEqual(fs.readdirSync(f.dir(ref)).sort(), ['.pending', 'document.html', 'reference.json']);
      assert.equal(JSON.stringify(ref).includes(f.dataDir), false); assert.equal('html' in ref, false);
      const newStore = createHtmlArtifactStore(f.options);
      assert.deepEqual(await newStore.read(ref.id), read);
      ref.title = 'mutated return'; read.artifact.digest = '0'.repeat(64);
      assert.equal((await newStore.read(ref.id)).artifact.title, input().title);
      console.log(`    UTF8 bytes=${Buffer.byteLength(original)}, digest=${digest(original)}`);
    });
    await check('different artifacts never overwrite; native tuple isolates session/message/call', async () => {
      const f = fixture(), values = [input(), input({ sessionId: 'session-b' }),
        input({ messageId: 'message-b' }), input({ toolCallId: 'call-b' }),
        input({ sessionId: 'a:b', messageId: 'c' }), input({ sessionId: 'a', messageId: 'b:c' })];
      const refs = await Promise.all(values.map(value => f.store.publish(value)));
      assert.equal(new Set(refs.map(ref => ref.id)).size, values.length);
      for (let index = 0; index < refs.length; index++) {
        assert.equal(refs[index].id, idFor(values[index]));
        assert.deepEqual(await f.store.read(refs[index].id), { artifact: refs[index], html: values[index].html });
      }
      assert.equal(fs.readdirSync(f.root).length, values.length);
    });
    await check('concurrent duplicate publishes and restarts return exactly the original ref', async () => {
      const f = fixture(), refs = await Promise.all(Array.from({ length: 16 }, () => f.store.publish(input())));
      for (const ref of refs) assert.deepEqual(ref, refs[0]);
      await delay(5);
      assert.deepEqual(await createHtmlArtifactStore(f.options).publish(input({ height: 320 })), refs[0]);
      assert.equal(fs.readdirSync(f.root).length, 1);
    });
    for (const change of [{ html: '<html>different</html>' }, { title: 'different' }, { height: 321 }]) {
      await check('immutable tuple conflict ' + Object.keys(change)[0], async () => {
        const f = await savedFixture(), before = fs.readFileSync(path.join(f.dir(f.ref), 'reference.json'));
        await assert.rejects(f.store.publish(input(change)), code('html_artifact_conflict'));
        assert.deepEqual((await f.store.read(f.ref.id)).artifact, f.ref);
        assert.deepEqual(fs.readFileSync(path.join(f.dir(f.ref), 'reference.json')), before);
      });
    }
    const invalid = [null, [], {}, input({ title: '' }), input({ title: '  ' }), input({ title: 'x'.repeat(161) }),
      input({ title: 'bad\nsecret' }), input({ title: 'bad\x80' }), input({ html: '' }), input({ html: 7 }),
      input({ html: '\ud800' }), input({ height: 79 }), input({ height: 2049 }), input({ height: 100.5 }),
      input({ height: '320' }), input({ sessionId: '' }), input({ sessionId: 's'.repeat(129) }),
      input({ messageId: 'm'.repeat(257) }), input({ toolCallId: 'bad\0call' }),
      input({ sessionId: { toJSON() { throw Error('must not serialize an invalid identifier'); } } }),
      input({ messageId: [] }), input({ toolCallId: 1 }),
      input({ path: 'C:\\secret.html' }), input({ url: 'https://example.invalid' }),
      input({ contentRef: '../outside' }), input({ id: 'a'.repeat(64) })];
    for (const [index, value] of invalid.entries()) await check('invalid publish ' + index + ' writes nothing', async () => {
      const f = fixture(); await assert.rejects(f.store.publish(value), code('html_artifact_invalid'));
      assert.equal(fs.existsSync(f.root), false);
    });
    await check('boundary metadata and one-byte HTML use the public schema', async () => {
      const f = fixture();
      for (const height of [80, 2048, undefined, null]) {
        const value = input({ toolCallId: String(height), height, title: 'x'.repeat(160), html: 'x',
          sessionId: 's'.repeat(128), messageId: 'm'.repeat(256) });
        const ref = await f.store.publish(value);
        assert.equal(ref.height, height ?? 320); assert.equal(ref.bytes, 1);
        assert.deepEqual(projectHtmlArtifactReference(ref), ref);
      }
    });
    await check('HTML remains an opaque complete string, without normalization or execution', async () => {
      const f = fixture(), html = '﻿<!DOCTYPE html>\r\n<html><script>throw Error("do not execute")</script>\n<body>é\u0000</body></html>';
      const ref = await f.store.publish(input({ html }));
      assert.deepEqual(fs.readFileSync(path.join(f.dir(ref), 'document.html')), Buffer.from(html));
      assert.equal((await f.store.read(ref.id)).html, html); assert.equal(ref.digest, digest(html));
    });
    await check('concurrent different-key publications cannot overrun a shared quota', async () => {
      const f = fixture({ limits: { totalCount: 7 } });
      const results = await Promise.allSettled(Array.from({ length: 20 }, (_, n) => f.store.publish(input({ messageId: 'parallel-' + n }))));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 7);
      assert.equal(results.filter(result => result.status === 'rejected').length, 13);
      assert.ok(results.filter(result => result.status === 'rejected').every(result => code('html_artifact_quota')(result.reason)));
      assert.equal(fs.readdirSync(f.root).length, 7);
    });
    await check('2 MiB limit counts bytes, not UTF-16 code units', async () => {
      const f = fixture(), html = '中'.repeat(Math.floor(HTML_ARTIFACT_MAX_BYTES / 3)) + 'ab';
      assert.equal(Buffer.byteLength(html), HTML_ARTIFACT_MAX_BYTES);
      const ref = await f.store.publish(input({ html })); assert.equal(ref.bytes, HTML_ARTIFACT_MAX_BYTES);
      assert.equal((await f.store.read(ref.id)).html, html);
      for (const tooLarge of [html + 'x', '🙂'.repeat(HTML_ARTIFACT_MAX_BYTES / 4 + 1)]) {
        await assert.rejects(f.store.publish(input({ toolCallId: 'large', html: tooLarge })), code('html_artifact_invalid'));
      }
    });
    for (const key of ['totalCount', 'sessionCount', 'totalBytes', 'sessionBytes']) {
      await check('quota ' + key + ' refuses rather than evicting history', async () => {
        const f = fixture({ limits: { [key]: key.endsWith('Count') ? 1 : 1024 } });
        f.ref = await f.store.publish(input({ html: 'x' }));
        await assert.rejects(f.store.publish(input({ messageId: 'next', html: key.endsWith('Count') ? 'y' : 'x'.repeat(1024) })), code('html_artifact_quota'));
        assert.equal((await f.store.read(f.ref.id)).html, 'x');
        assert.deepEqual(await f.store.publish(input({ html: 'x' })), f.ref);
        assert.equal(fs.readdirSync(f.root).length, 1);
      });
    }
    await check('byte quota includes metadata/markers and allows an exact physical boundary', async () => {
      const source = await savedFixture();
      const physical = fs.readdirSync(source.dir(source.ref)).reduce((sum, name) => sum + fs.statSync(path.join(source.dir(source.ref), name)).size, 0);
      const exact = fixture({ limits: { totalBytes: physical, sessionBytes: physical } });
      assert.deepEqual((await exact.store.publish(input())).bytes, source.ref.bytes);
      const short = fixture({ limits: { totalBytes: physical - 1 } });
      await assert.rejects(short.store.publish(input()), code('html_artifact_quota'));
      console.log(`    physical snapshot bytes=${physical}; html bytes=${source.ref.bytes}`);
    });
    await check('per-session quotas do not cap the number of independent sessions', async () => {
      const f = fixture({ limits: { sessionCount: 1, sessionBytes: 1024 } });
      const refs = await Promise.all(Array.from({ length: 40 }, (_, n) => f.store.publish(input({ sessionId: 'session-' + n, html: 'x' }))));
      assert.equal(refs.length, 40); assert.equal(fs.readdirSync(f.root).length, 40);
      assert.equal('sessions' in HTML_ARTIFACT_STORE_LIMITS, false);
    });
    const corruptions = [
      ['truncated JSON', dir => fs.writeFileSync(path.join(dir, 'reference.json'), '{"schemaVersion":1')],
      ['unknown schema', (dir, ref) => fs.writeFileSync(path.join(dir, 'reference.json'), encoded({ ...ref, schemaVersion: 2 }))],
      ['unknown field', (dir, ref) => fs.writeFileSync(path.join(dir, 'reference.json'), encoded({ ...ref, secret: 'private' }))],
      ['ID mismatch', (dir, ref) => fs.writeFileSync(path.join(dir, 'reference.json'), encoded({ ...ref, id: 'e'.repeat(64) }))],
      ['tuple mismatch', (dir, ref) => fs.writeFileSync(path.join(dir, 'reference.json'), encoded({ ...ref, sessionId: 'foreign' }))],
      ['invalid contentRef', (dir, ref) => fs.writeFileSync(path.join(dir, 'reference.json'), encoded({ ...ref, contentRef: '../outside' }))],
      ['invalid date', (dir, ref) => fs.writeFileSync(path.join(dir, 'reference.json'), encoded({ ...ref, createdAt: 'unknown' }))],
      ['invalid height', (dir, ref) => fs.writeFileSync(path.join(dir, 'reference.json'), encoded({ ...ref, height: null }))],
      ['invalid title', (dir, ref) => fs.writeFileSync(path.join(dir, 'reference.json'), encoded({ ...ref, title: '\x9fsecret' }))],
      ['invalid kind', (dir, ref) => fs.writeFileSync(path.join(dir, 'reference.json'), encoded({ ...ref, kind: 'url' }))],
      ['digest mismatch', dir => fs.writeFileSync(path.join(dir, 'document.html'), input().html.replace('你好', '世界'))],
      ['truncated HTML', dir => fs.truncateSync(path.join(dir, 'document.html'), 1)],
      ['empty HTML', dir => fs.truncateSync(path.join(dir, 'document.html'), 0)],
      ['byte mismatch', (dir, ref) => fs.writeFileSync(path.join(dir, 'reference.json'), encoded({ ...ref, bytes: ref.bytes + 1 }))],
      ['bad UTF8', dir => fs.writeFileSync(path.join(dir, 'document.html'), Buffer.from([0xc3, 0x28]))],
      ['bad metadata UTF8', dir => fs.writeFileSync(path.join(dir, 'reference.json'), Buffer.from([0xff]))],
      ['oversized metadata', dir => fs.writeFileSync(path.join(dir, 'reference.json'), ' '.repeat(16385))],
      ['oversized HTML', dir => fs.writeFileSync(path.join(dir, 'document.html'), 'x'.repeat(HTML_ARTIFACT_MAX_BYTES + 1))],
      ['missing HTML', dir => fs.unlinkSync(path.join(dir, 'document.html'))],
      ['missing ref', dir => fs.unlinkSync(path.join(dir, 'reference.json'))],
      ['bad pending', dir => fs.writeFileSync(path.join(dir, '.pending'), '0\n')],
      ['unknown file', dir => fs.writeFileSync(path.join(dir, 'extra.txt'), 'private')],
    ];
    for (const [name, damage] of corruptions) await check('restart detects ' + name + ' without overwrite', async () => {
      const f = await savedFixture(); damage(f.dir(f.ref), f.ref);
      const before = fs.readdirSync(f.dir(f.ref)).map(name => [name, fs.readFileSync(path.join(f.dir(f.ref), name)).toString('hex')]);
      const store = createHtmlArtifactStore(f.options);
      await assert.rejects(store.read(f.ref.id), code('html_artifact_storage_corrupt'));
      await assert.rejects(store.publish(input()), code('html_artifact_storage_corrupt'));
      assert.deepEqual(fs.readdirSync(f.dir(f.ref)).map(name => [name, fs.readFileSync(path.join(f.dir(f.ref), name)).toString('hex')]), before);
    });
    for (const id of [null, '', '../outside', '/etc/passwd', 'C:\\secret', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(64) + '\0']) {
      await check('invalid ID never becomes a filesystem locator ' + String(id).length, async () => {
        const f = fixture(); await assert.rejects(f.store.read(id), code('html_artifact_invalid'));
        assert.equal(fs.existsSync(f.root), false);
      });
    }
    await check('hardlinked HTML/ref/marker are refused as unsafe', async () => {
      for (const name of ['document.html', 'reference.json', '.pending']) {
        const f = await savedFixture(), file = path.join(f.dir(f.ref), name), copy = path.join(world, randomUUID());
        fs.copyFileSync(file, copy); fs.unlinkSync(file); fs.linkSync(copy, file);
        await assert.rejects(f.store.read(f.ref.id), code('html_artifact_storage_unsafe'));
        assert.equal(fs.statSync(copy).nlink, 2);
      }
    });
    const linkDir = (target, link) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    await check('root, artifact directory, DATA_DIR and ancestor junctions are refused even for missing IDs', async () => {
      for (const location of ['root', 'artifact', 'data', 'ancestor']) {
        const f = fixture(), outside = path.join(world, 'outside-' + randomUUID()); fs.mkdirSync(outside);
        let store = f.store;
        if (location === 'root') linkDir(outside, f.root);
        if (location === 'artifact') { fs.mkdirSync(f.root, { mode: 0o700 }); linkDir(outside, f.dir('a'.repeat(64))); }
        if (location === 'data') { fs.rmdirSync(f.dataDir); linkDir(outside, f.dataDir); }
        if (location === 'ancestor') {
          const link = path.join(world, randomUUID()); linkDir(f.dataDir, link);
          store = createHtmlArtifactStore({ dataDir: path.join(link, 'missing-child') });
        }
        await assert.rejects(store.read('a'.repeat(64)), code('html_artifact_storage_unsafe'));
        await assert.rejects(store.publish(input()), code('html_artifact_storage_unsafe'));
        assert.deepEqual(fs.readdirSync(outside), []);
      }
    });
    for (const name of ['document.html', 'reference.json', '.pending']) {
      await check('symlinked artifact file rejected ' + name, async () => {
        const f = await savedFixture(), file = path.join(f.dir(f.ref), name), outside = path.join(world, randomUUID());
        fs.copyFileSync(file, outside); fs.unlinkSync(file);
        try { fs.symlinkSync(outside, file, 'file'); }
        catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
          skipped++; console.log('    SKIP Windows file-symlink privilege unavailable'); return;
        }
        await assert.rejects(f.store.read(f.ref.id), code('html_artifact_storage_unsafe'));
        assert.ok(fs.existsSync(outside));
      });
    }
    await check('non-file HTML and linked ancestors are not treated as absent data', async () => {
      const f = await savedFixture(), file = path.join(f.dir(f.ref), 'document.html');
      fs.unlinkSync(file); fs.mkdirSync(file);
      await assert.rejects(f.store.read(f.ref.id), code('html_artifact_storage_unsafe'));
    });
    for (const replacement of ['root', 'data', 'artifact', 'missing-root', 'missing-artifact']) {
      await check('remembered directory replacement is refused ' + replacement, async () => {
        const f = await savedFixture(), original = replacement.includes('artifact') ? f.dir(f.ref)
          : replacement === 'data' ? f.dataDir : f.root;
        fs.renameSync(original, original + '-moved');
        if (!replacement.startsWith('missing')) fs.mkdirSync(original, { mode: 0o700 });
        await assert.rejects(f.store.read(f.ref.id), error => ['html_artifact_storage_unsafe', 'html_artifact_not_found'].includes(error.code));
        await assert.rejects(f.store.publish(input()), code('html_artifact_storage_unsafe'));
        if (fs.existsSync(original)) assert.deepEqual(fs.readdirSync(original), []);
      });
    }
    const stages = ['temp-created', 'html-written', 'html-flushed', 'meta-written', 'meta-flushed',
      'pending-written', 'pending-flushed', 'before-rename'];
    for (const stage of stages) await check('fault at ' + stage + ' never returns a ref or partial committed directory', async () => {
      const f = fixture({ checkpoint(current) { if (current === stage) throw new Error('private payload /secret'); } });
      await assert.rejects(f.store.publish(input()), code('html_artifact_storage_failed'));
      assert.deepEqual(fs.readdirSync(f.root), []);
      assert.deepEqual(await f.store.cleanupTemporary(), { removed: 0, retained: 0 });
      await assert.rejects(f.store.read(idFor(input())), code('html_artifact_not_found'));
    });
    for (const [operation, errCode] of [['openSync', 'EACCES'], ['writeFileSync', 'ENOSPC'], ['fsyncSync', 'EIO'], ['renameSync', 'EPERM']]) {
      await check('real temp fault injection ' + operation + '/' + errCode + ' preserves existing artifact', async () => {
        const f = await savedFixture(), io = Object.create(fs);
        io[operation] = (...args) => {
          // openSync failure is restricted to the HTML file, not lock admission.
          if (operation !== 'openSync' || String(args[0]).endsWith('document.html')) throw Object.assign(Error('private path'), { code: errCode });
          return fs[operation](...args);
        };
        const store = createHtmlArtifactStore({ ...f.options, io });
        await assert.rejects(store.publish(input({ messageId: 'next' })), code('html_artifact_storage_failed'));
        assert.deepEqual((await f.store.read(f.ref.id)).artifact, f.ref);
        assert.deepEqual(fs.readdirSync(f.root), [f.ref.id]);
      });
    }
    await check('silent short writes are detected before rename', async () => {
      const f = fixture(), io = Object.create(fs);
      io.writeFileSync = (fd, bytes) => fs.writeFileSync(fd, bytes.subarray(0, Math.max(0, bytes.length - 1)));
      const store = createHtmlArtifactStore({ ...f.options, io });
      await assert.rejects(store.publish(input()), code('html_artifact_storage_corrupt'));
      assert.deepEqual(fs.readdirSync(f.root), []);
    });
    await check('lost post-rename acknowledgement remains readable/pending and retries idempotently', async () => {
      const f = fixture({ checkpoint(stage) { if (stage === 'renamed') throw Error('lost ack'); } });
      await assert.rejects(f.store.publish(input()), code('html_artifact_storage_failed'));
      const store = createHtmlArtifactStore({ dataDir: f.dataDir }), read = await store.read(idFor(input()));
      assert.equal(read.html, input().html);
      assert.deepEqual(await store.publish(input()), read.artifact);
      assert.equal((await collectScan(store, { complete: true, referencedIds: [], beforeMs: await nextScan() })).pending, 1);
      assert.equal((await store.read(read.artifact.id)).html, input().html);
    });
    await check('rename that commits then throws is not mistaken for a successful acknowledgement', async () => {
      const f = fixture(), io = Object.create(fs);
      io.renameSync = (...args) => { fs.renameSync(...args); throw Error('lost rename response'); };
      await assert.rejects(createHtmlArtifactStore({ ...f.options, io }).publish(input()), code('html_artifact_storage_failed'));
      assert.equal((await f.store.read(idFor(input()))).html, input().html);
    });
    await check('directory replacement at last pre-commit checkpoint never redirects HTML writes', async () => {
      let lockFd;
      const io = Object.create(fs);
      io.openSync = (file, ...args) => {
        const fd = fs.openSync(file, ...args);
        if (path.basename(file) === '.writer.lock') lockFd = fd;
        return fd;
      };
      const f = fixture({ io, checkpoint(stage) {
        if (stage === 'before-rename') {
          // Windows blocks renaming a directory with an open lock handle.
          // Release only the injected descriptor to exercise the identity guard.
          fs.closeSync(lockFd); fs.renameSync(f.root, f.root + '-moved'); fs.mkdirSync(f.root, { mode: 0o700 });
        }
      } });
      await assert.rejects(f.store.publish(input()), code('html_artifact_storage_unsafe'));
      assert.deepEqual(fs.readdirSync(f.root), []);
      assert.ok(fs.readdirSync(f.root + '-moved').some(name => tempPattern.test(name)));
      assert.ok(fs.existsSync(path.join(f.root + '-moved', '.writer.lock')));
    });
    await check('lock identity replacement prevents commit and preserves the foreign lock', async () => {
      let lockFd;
      const io = Object.create(fs);
      io.openSync = (file, ...args) => {
        const fd = fs.openSync(file, ...args);
        if (path.basename(file) === '.writer.lock') lockFd = fd;
        return fd;
      };
      const f = fixture({ io, checkpoint(stage) {
        if (stage === 'before-rename') {
          fs.closeSync(lockFd);
          const file = path.join(f.root, '.writer.lock'); fs.unlinkSync(file); fs.writeFileSync(file, 'foreign owner');
        }
      } });
      await assert.rejects(f.store.publish(input()), code('html_artifact_storage_unsafe'));
      assert.equal(fs.readFileSync(path.join(f.root, '.writer.lock'), 'utf8'), 'foreign owner');
      assert.equal(fs.existsSync(f.dir(idFor(input()))), false);
    });
    await check('mutation while reading an opened HTML file is corruption, not a false integrity success', async () => {
      const f = await savedFixture(), file = path.join(f.dir(f.ref), 'document.html');
      const io = Object.create(fs); let targetFd, changed = false;
      io.openSync = (name, ...args) => {
        const fd = fs.openSync(name, ...args); if (name === file) targetFd = fd; return fd;
      };
      io.readSync = (fd, ...args) => {
        const n = fs.readSync(fd, ...args);
        if (fd === targetFd && !changed) { changed = true; fs.appendFileSync(file, 'x'); }
        return n;
      };
      await assert.rejects(createHtmlArtifactStore({ ...f.options, io }).read(f.ref.id), code('html_artifact_storage_corrupt'));
      assert.equal(changed, true);
    });
    await check('exclusive lock rejects another process and never steals an abandoned lock', async () => {
      let observed;
      const f = fixture({ checkpoint(stage) {
        if (stage === 'html-flushed') {
          const result = child(f, 'publish'); assert.equal(result.status, 0);
          observed = JSON.parse(result.stdout);
        }
      } });
      await f.store.publish(input());
      assert.deepEqual(observed, { ok: false, code: 'html_artifact_storage_busy' });
      const lockFile = path.join(f.root, '.writer.lock'); fs.writeFileSync(lockFile, 'abandoned');
      const before = fs.readFileSync(lockFile);
      await assert.rejects(f.store.publish(input()), code('html_artifact_storage_busy'));
      await assert.rejects(f.store.read(idFor(input())), code('html_artifact_storage_busy'));
      await assert.rejects(f.store.cleanupTemporary(), code('html_artifact_storage_busy'));
      await assert.rejects(confirm(f, []), code('html_artifact_storage_busy'));
      assert.deepEqual(fs.readFileSync(lockFile), before);
    });
    await check('new process can read/publish the original tuple after normal lock release', async () => {
      const f = await savedFixture(), result = child(f, 'publish');
      assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.stdout), { ok: true, ref: f.ref });
    });
    await check('incomplete and failed scans are unconditional non-destructive no-ops', async () => {
      const f = await savedFixture(); await confirm(f);
      for (const options of [undefined, {}, { complete: false }, { complete: 'true', referencedIds: [] }]) {
        const result = await f.store.collect(options);
        assert.equal(result.removed, 0); assert.equal(result.complete, false);
        assert.deepEqual((await f.store.read(f.ref.id)).artifact, f.ref);
      }
    });
    for (const protection of ['republish', 'reference', 'republish+reference']) {
      await check('GC regression protects ' + protection + ' after an older scan started', async () => {
        const f = await savedFixture(); await confirm(f);
        assert.equal(fs.existsSync(path.join(f.dir(f.ref), '.pending')), false);
        const beforeMs = await nextScan();
        if (protection.includes('republish')) assert.deepEqual(await f.store.publish(input()), f.ref);
        if (protection.includes('reference')) await confirm(f);
        // The old A/cutoff, publish, B/positive, A/commit schedule used to
        // remove=1 here. Pre-scanned evidence must now fail closed, not be
        // relabeled as a new scan or trusted because its wall clock is old.
        await assert.rejects(f.store.collect({ complete: true, referencedIds: [], beforeMs }), code('html_artifact_invalid'));
        assert.deepEqual(await f.store.read(f.ref.id), { artifact: f.ref, html: input().html });
      });
    }
    await check('GC regression republish alone restores durable pending without changing immutable bytes', async () => {
      const f = await savedFixture(); await confirm(f);
      const files = ['document.html', 'reference.json'];
      const before = files.map(name => fs.readFileSync(path.join(f.dir(f.ref), name)));
      assert.deepEqual(await f.store.publish(input()), f.ref);
      assert.equal(fs.readFileSync(path.join(f.dir(f.ref), '.pending'), 'utf8'), '1\n');
      for (const store of [f.store, createHtmlArtifactStore(f.options)]) {
        const result = await collectScan(store, { complete: true, referencedIds: [], beforeMs: await nextScan() });
        assert.equal(result.removed, 0); assert.equal(result.pending, 1);
        assert.deepEqual(await store.read(f.ref.id), { artifact: f.ref, html: input().html });
      }
      assert.deepEqual(files.map(name => fs.readFileSync(path.join(f.dir(f.ref), name))), before);
      await confirm(f);
      assert.equal((await collectScan(f.store, { complete: true, referencedIds: [], beforeMs: await nextScan() })).removed, 1);
    });
    await check('GC regression repeated positive proof alone excludes older A until B commits', async () => {
      const f = await savedFixture(); await confirm(f);
      const release = barrier(), entered = barrier();
      const b = f.store.collect({ scan: async () => {
        entered.resolve(); await release.promise;
        return { complete: true, referencedIds: [f.ref.id], beforeMs: Date.now() };
      } });
      await entered.promise;
      try {
        assert.ok(fs.existsSync(path.join(f.root, '.writer.lock')));
        await assert.rejects(collectScan(createHtmlArtifactStore(f.options), { complete: true, referencedIds: [], beforeMs: Date.now() }), code('html_artifact_storage_busy'));
        assert.equal(fs.existsSync(path.join(f.dir(f.ref), '.pending')), false);
      } finally { release.resolve(); }
      const result = await b; assert.equal(result.removed, 0); assert.equal(result.retained, 1);
      assert.deepEqual((await f.store.read(f.ref.id)).artifact, f.ref);
    });
    await check('GC regression async A/B scans cannot commit out of order across instances and processes', async () => {
      const f = await savedFixture(); await confirm(f); await f.store.publish(input());
      const release = barrier(), entered = barrier();
      const a = f.store.collect({ scan: async () => {
        entered.resolve(); await release.promise;
        return { complete: true, referencedIds: [], beforeMs: Date.now() };
      } });
      await entered.promise;
      try {
        for (const store of [f.store, createHtmlArtifactStore(f.options)]) {
          await assert.rejects(store.publish(input()), code('html_artifact_storage_busy'));
          await assert.rejects(store.read(f.ref.id), code('html_artifact_storage_busy'));
          await assert.rejects(collectScan(store, { complete: true, referencedIds: [f.ref.id], beforeMs: Date.now() }), code('html_artifact_storage_busy'));
          await assert.rejects(store.cleanupTemporary(), code('html_artifact_storage_busy'));
        }
        for (const action of ['publish', 'collect']) {
          const other = child(f, action); assert.equal(other.status, 0);
          assert.deepEqual(JSON.parse(other.stdout), { ok: false, code: 'html_artifact_storage_busy' });
        }
      } finally { release.resolve(); }
      const result = await a; assert.equal(result.removed, 0); assert.equal(result.pending, 1);
      const b = await confirm(f); assert.equal(b.retained, 1);
      assert.equal(fs.existsSync(path.join(f.dir(f.ref), '.pending')), false);
      assert.deepEqual(await f.store.read(f.ref.id), { artifact: f.ref, html: input().html });
      assert.equal((await collectScan(f.store, { complete: true, referencedIds: [], beforeMs: await nextScan() })).removed, 1);
    });
    await check('GC regression scans of an empty store also exclude a concurrent initial publish', async () => {
      const f = fixture(), release = barrier(), entered = barrier();
      const result = f.store.collect({ scan: async () => {
        entered.resolve(); await release.promise; return { complete: true, referencedIds: [], beforeMs: Date.now() };
      } });
      await entered.promise;
      try {
        const other = child(f, 'publish'); assert.equal(other.status, 0);
        assert.deepEqual(JSON.parse(other.stdout), { ok: false, code: 'html_artifact_storage_busy' });
      } finally { release.resolve(); }
      assert.equal((await result).removed, 0);
      assert.equal((await f.store.publish(input())).id, idFor(input()));
    });
    await check('GC regression callback throws, rejects or cancels without using stale proof or leaking lock', async () => {
      const f = await savedFixture(); await confirm(f);
      for (const scan of [() => { throw Error('private payload'); }, async () => { throw Error('private path'); },
        async () => { throw Object.assign(Error('cancelled'), { name: 'AbortError' }); }]) {
        await assert.rejects(f.store.collect({ scan }), code('html_artifact_storage_failed'));
        assert.equal(fs.existsSync(path.join(f.root, '.writer.lock')), false);
        assert.deepEqual((await f.store.read(f.ref.id)).artifact, f.ref);
      }
      assert.equal((await collectScan(f.store, { complete: true, referencedIds: [], beforeMs: await nextScan() })).removed, 1);
    });
    await check('GC regression native branch mutation is external evidence, not covered by store lock', async () => {
      const f = await savedFixture(); await confirm(f); await f.store.publish(input());
      let epoch = 0;
      const result = await f.store.collect({ scan: async () => {
        const captured = epoch;
        await Promise.resolve().then(() => { epoch++; }); // A native branch/reference mutation, not a store operation.
        return { complete: captured === epoch, referencedIds: [], beforeMs: Date.now() };
      } });
      assert.equal(result.complete, false); assert.equal(result.removed, 0);
      assert.ok(fs.existsSync(path.join(f.dir(f.ref), '.pending')));
      assert.deepEqual((await f.store.read(f.ref.id)).artifact, f.ref);
    });
    await check('GC regression clock equality and rollback never open a locked scan or discard pending', async () => {
      const f = await savedFixture(); await confirm(f);
      const now = Date.now;
      try {
        for (const clock of [now(), now() - 86400000]) {
          Date.now = () => clock;
          await f.store.publish(input());
          const result = await f.store.collect({ scan: async () => {
            await assert.rejects(f.store.publish(input()), code('html_artifact_storage_busy'));
            await Promise.resolve();
            return { complete: true, referencedIds: [], beforeMs: Date.now() };
          } });
          assert.equal(result.removed, 0); assert.equal(result.pending, 1);
        }
      } finally { Date.now = now; }
      await confirm(f);
      assert.equal((await collectScan(f.store, { complete: true, referencedIds: [], beforeMs: await nextScan() })).removed, 1);
    });
    await check('GC regression scan process crash preserves a fail-closed lock through restart', async () => {
      const f = await savedFixture(); await confirm(f);
      const crashed = child(f, 'scan-crash'); assert.equal(crashed.status, 74);
      assert.ok(fs.existsSync(path.join(f.root, '.writer.lock')));
      const store = createHtmlArtifactStore(f.options);
      await assert.rejects(store.read(f.ref.id), code('html_artifact_storage_busy'));
      await assert.rejects(collectScan(store, { complete: true, referencedIds: [], beforeMs: Date.now() }), code('html_artifact_storage_busy'));
      // Only this test owns the fixture and has verified the child exited.
      fs.unlinkSync(path.join(f.root, '.writer.lock'));
      assert.deepEqual((await store.read(f.ref.id)).artifact, f.ref);
      assert.equal((await collectScan(store, { complete: true, referencedIds: [], beforeMs: await nextScan() })).removed, 1);
    });
    await check('GC regression republish marker is charged to byte quotas but not artifact counts', async () => {
      const f = await savedFixture({ limits: { totalCount: 1, sessionCount: 1 } });
      const physical = fs.readdirSync(f.dir(f.ref)).reduce((n, name) => n + fs.statSync(path.join(f.dir(f.ref), name)).size, 0);
      for (const bound of ['totalBytes', 'sessionBytes']) {
        await confirm(f);
        const store = createHtmlArtifactStore({ ...f.options, limits: { ...f.options.limits, [bound]: physical - 1 } });
        await assert.rejects(store.publish(input()), code('html_artifact_quota'));
        assert.equal(fs.existsSync(path.join(f.dir(f.ref), '.pending')), false);
        assert.deepEqual((await store.read(f.ref.id)).artifact, f.ref);
        const exact = createHtmlArtifactStore({ ...f.options, limits: { ...f.options.limits, [bound]: physical } });
        assert.deepEqual(await exact.publish(input()), f.ref);
        assert.equal(fs.readFileSync(path.join(f.dir(f.ref), '.pending'), 'utf8'), '1\n');
      }
    });
    for (const stage of ['republish-pending-written', 'republish-pending-flushed']) {
      await check('GC regression lost duplicate ack at ' + stage + ' remains pending after restart', async () => {
        const f = await savedFixture(); await confirm(f);
        const store = createHtmlArtifactStore({ ...f.options, checkpoint(current) { if (current === stage) throw Error('lost ack'); } });
        await assert.rejects(store.publish(input()), code('html_artifact_storage_failed'));
        const restarted = createHtmlArtifactStore(f.options);
        assert.deepEqual((await restarted.read(f.ref.id)).artifact, f.ref);
        assert.equal((await collectScan(restarted, { complete: true, referencedIds: [], beforeMs: await nextScan() })).pending, 1);
        assert.deepEqual(await restarted.publish(input()), f.ref);
      });
    }
    await check('GC regression retry must flush an existing pending marker before acknowledging', async () => {
      const f = await savedFixture(); let flushes = 0;
      const io = Object.create(fs);
      io.fsyncSync = () => { flushes++; throw Object.assign(Error('pending flush failed'), { code: 'EIO' }); };
      await assert.rejects(createHtmlArtifactStore({ ...f.options, io }).publish(input()), code('html_artifact_storage_failed'));
      assert.equal(flushes, 1);
      assert.equal(fs.readFileSync(path.join(f.dir(f.ref), '.pending'), 'utf8'), '1\n');
      assert.deepEqual(await f.store.publish(input()), f.ref);
    });
    await check('GC regression silent short duplicate marker cannot acknowledge or authorize deletion', async () => {
      const f = await savedFixture(); await confirm(f);
      const io = Object.create(fs);
      io.writeFileSync = (fd, bytes) => fs.writeFileSync(fd, bytes.subarray(0, 1));
      await assert.rejects(createHtmlArtifactStore({ ...f.options, io }).publish(input()), code('html_artifact_storage_corrupt'));
      await assert.rejects(collectScan(f.store, { complete: true, referencedIds: [], beforeMs: await nextScan() }), code('html_artifact_storage_corrupt'));
      assert.equal(fs.readFileSync(path.join(f.dir(f.ref), 'document.html'), 'utf8'), input().html);
    });
    await check('GC regression callback store reentry fails busy immediately and never invokes nested scan', async () => {
      const f = await savedFixture(); let nested = false;
      const result = await f.store.collect({ scan: async () => {
        await assert.rejects(f.store.publish(input()), code('html_artifact_storage_busy'));
        await assert.rejects(f.store.read(f.ref.id), code('html_artifact_storage_busy'));
        await assert.rejects(f.store.collect({ scan: () => { nested = true; } }), code('html_artifact_storage_busy'));
        return { complete: false, referencedIds: [f.ref.id] };
      } });
      assert.equal(nested, false); assert.equal(result.complete, false);
      assert.equal(fs.existsSync(path.join(f.root, '.writer.lock')), false);
      assert.equal(fs.readFileSync(path.join(f.dir(f.ref), '.pending'), 'utf8'), '1\n');
    });
    for (const replacement of ['lock', 'root']) {
      await check('GC regression identity replacement during awaited scan refuses commit: ' + replacement, async () => {
        const f = await savedFixture(); await confirm(f);
        let lockFd;
        const io = Object.create(fs);
        io.openSync = (file, ...args) => {
          const fd = fs.openSync(file, ...args); if (path.basename(file) === '.writer.lock') lockFd = fd; return fd;
        };
        const store = createHtmlArtifactStore({ ...f.options, io });
        await assert.rejects(store.collect({ scan: async () => {
          await Promise.resolve(); fs.closeSync(lockFd);
          if (replacement === 'lock') {
            fs.unlinkSync(path.join(f.root, '.writer.lock')); fs.writeFileSync(path.join(f.root, '.writer.lock'), 'foreign owner');
          } else { fs.renameSync(f.root, f.root + '-moved'); fs.mkdirSync(f.root, { mode: 0o700 }); }
          return { complete: true, referencedIds: [], beforeMs: Date.now() };
        } }), code('html_artifact_storage_unsafe'));
        if (replacement === 'lock') {
          assert.equal(fs.readFileSync(path.join(f.root, '.writer.lock'), 'utf8'), 'foreign owner');
          assert.equal(fs.readFileSync(path.join(f.dir(f.ref), 'document.html'), 'utf8'), input().html);
        } else {
          assert.deepEqual(fs.readdirSync(f.root), []);
          assert.equal(fs.readFileSync(path.join(f.root + '-moved', f.ref.id, 'document.html'), 'utf8'), input().html);
          assert.ok(fs.existsSync(path.join(f.root + '-moved', '.writer.lock')));
        }
      });
    }
    await check('complete collect requires explicit safe cutoff and ID sets', async () => {
      const f = await savedFixture();
      for (const options of [{}, { beforeMs: Infinity }, { beforeMs: Date.now() + 60000 }, { beforeMs: -1 },
        { beforeMs: 1, referencedIds: null }, { beforeMs: 1, referencedIds: ['../outside'] },
        { beforeMs: 1, referencedIds: [], candidateIds: ['bad'] }]) {
        await assert.rejects(collectScan(f.store, { complete: true, referencedIds: [], ...options }), code('html_artifact_invalid'));
      }
      assert.equal((await f.store.read(f.ref.id)).html, input().html);
    });
    await check('pending unconfirmed artifacts survive GC and store/process restart', async () => {
      const f = await savedFixture(), store = createHtmlArtifactStore(f.options);
      const result = await collectScan(store, { complete: true, referencedIds: [], beforeMs: await nextScan() });
      assert.equal(result.removed, 0); assert.equal(result.pending, 1); assert.equal(result.retained, 1);
      assert.equal(fs.readFileSync(path.join(f.dir(f.ref), '.pending'), 'utf8'), '1\n');
    });
    await check('all-branch reference proof retains artifact; later explicit orphan is collected', async () => {
      const f = await savedFixture(), confirmation = await confirm(f);
      assert.equal(confirmation.retained, 1); assert.equal(fs.existsSync(path.join(f.dir(f.ref), '.pending')), false);
      const branch = await collectScan(f.store, { complete: true, referencedIds: new Set([f.ref.id]), candidateIds: [f.ref.id], beforeMs: await nextScan() });
      assert.equal(branch.removed, 0); assert.equal(branch.retained, 1);
      const result = await collectScan(f.store, { complete: true, referencedIds: [], candidateIds: [f.ref.id], beforeMs: await nextScan() });
      assert.equal(result.removed, 1); assert.equal(result.retained, 0);
      await assert.rejects(f.store.read(f.ref.id), code('html_artifact_not_found'));
      assert.deepEqual(fs.readdirSync(f.root), []);
    });
    await check('candidate scope never deletes another deleted/unselected session artifact', async () => {
      const f = await savedFixture(), other = await f.store.publish(input({ sessionId: 'other-session' }));
      await confirm(f, [f.ref.id, other.id]);
      const result = await collectScan(f.store, { complete: true, referencedIds: [], candidateIds: [f.ref.id], beforeMs: await nextScan() });
      assert.equal(result.removed, 1); assert.equal(result.retained, 1);
      assert.deepEqual((await f.store.read(other.id)).artifact, other);
    });
    await check('age cutoff retains snapshots published or first confirmed after cutoff, independently of scan locking', async () => {
      const f = fixture(), beforeMs = Date.now();
      f.ref = await f.store.publish(input()); await confirm(f);
      const result = await collectScan(f.store, { complete: true, referencedIds: [], beforeMs });
      assert.equal(result.removed, 0); assert.equal(result.retained, 1);
      assert.deepEqual((await f.store.read(f.ref.id)).artifact, f.ref);
    });
    await check('corrupt inventory aborts GC before deleting an earlier valid orphan', async () => {
      const f = await savedFixture(), other = await f.store.publish(input({ messageId: 'corrupt' }));
      await confirm(f, [f.ref.id, other.id]);
      fs.writeFileSync(path.join(f.dir(other), 'reference.json'), '{');
      await assert.rejects(collectScan(f.store, { complete: true, referencedIds: [], beforeMs: await nextScan() }), code('html_artifact_storage_corrupt'));
      assert.deepEqual((await f.store.read(f.ref.id)).artifact, f.ref);
    });
    await check('interrupted collection unpublishes atomically and leaves only reclaimable temp', async () => {
      const f = await savedFixture(); await confirm(f);
      const io = Object.create(fs);
      io.unlinkSync = file => { if (path.basename(file) === 'document.html') throw Error('interrupted GC'); fs.unlinkSync(file); };
      const store = createHtmlArtifactStore({ ...f.options, io });
      await assert.rejects(collectScan(store, { complete: true, referencedIds: [], beforeMs: await nextScan() }), code('html_artifact_storage_failed'));
      await assert.rejects(f.store.read(f.ref.id), code('html_artifact_not_found'));
      assert.equal(fs.readdirSync(f.root).filter(name => tempPattern.test(name)).length, 1);
      assert.deepEqual(await f.store.cleanupTemporary(), { removed: 1, retained: 0 });
      assert.deepEqual(fs.readdirSync(f.root), []);
    });
    await check('crashed publish preserves lock and pending temp until explicit fixture lock recovery', async () => {
      const f = fixture(), result = child(f, 'crash');
      assert.equal(result.status, 73);
      assert.ok(fs.existsSync(path.join(f.root, '.writer.lock')));
      assert.equal(fs.readdirSync(f.root).filter(name => tempPattern.test(name)).length, 1);
      await assert.rejects(f.store.cleanupTemporary(), code('html_artifact_storage_busy'));
      // Test owns this TEMP fixture and has proved the child exited; production
      // must require separate operator recovery, never infer safety from a PID.
      fs.unlinkSync(path.join(f.root, '.writer.lock'));
      assert.deepEqual(await f.store.cleanupTemporary(), { removed: 1, retained: 0 });
      assert.deepEqual(await f.store.cleanupTemporary(), { removed: 0, retained: 0 });
      assert.equal((await f.store.publish(input())).id, idFor(input()));
    });
    await check('interrupted temps block quota admission and never get read as snapshots', async () => {
      const f = await savedFixture(), temp = path.join(f.root, '.tmp-' + randomUUID());
      fs.mkdirSync(temp, { mode: 0o700 }); fs.writeFileSync(path.join(temp, 'document.html'), 'uncommitted');
      await assert.rejects(f.store.publish(input({ messageId: 'next' })), code('html_artifact_storage_busy'));
      assert.deepEqual(await f.store.cleanupTemporary(), { removed: 1, retained: 0 });
      assert.equal((await f.store.read(f.ref.id)).html, input().html);
    });
    await check('temporary cleanup never traverses links, unknown files or unexpected directories', async () => {
      const f = await savedFixture(), outside = path.join(world, randomUUID()); fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'keep'), 'private');
      const link = path.join(f.root, '.tmp-' + randomUUID()); linkDir(outside, link);
      const unknown = path.join(f.root, '.tmp-' + randomUUID()); fs.mkdirSync(unknown); fs.writeFileSync(path.join(unknown, 'unknown'), 'keep');
      const nested = path.join(f.root, '.tmp-' + randomUUID()); fs.mkdirSync(nested); fs.mkdirSync(path.join(nested, 'document.html'));
      assert.deepEqual(await f.store.cleanupTemporary(), { removed: 0, retained: 3 });
      assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'private');
      assert.ok(fs.existsSync(path.join(unknown, 'unknown')));
    });
    await check('unknown root filename is not admitted by a generic extension allowlist', async () => {
      const f = await savedFixture(); fs.writeFileSync(path.join(f.root, 'unknown.html'), 'keep');
      await assert.rejects(f.store.cleanupTemporary(), code('html_artifact_storage_unsafe'));
      await assert.rejects(f.store.publish(input({ messageId: 'next' })), code('html_artifact_storage_unsafe'));
      assert.equal(fs.readFileSync(path.join(f.root, 'unknown.html'), 'utf8'), 'keep');
    });
    await check('factory rejects invalid quota configuration and missing trusted DATA_DIR', async () => {
      for (const options of [undefined, {}, { dataDir: '' }, { dataDir: world, limits: { totalCount: 0 } },
        { dataDir: world, limits: { sessions: 1 } }, { dataDir: world, limits: { sessionBytes: NaN } }]) {
        assert.throws(() => createHtmlArtifactStore(options), code('html_artifact_invalid'));
      }
    });
    console.log(`HTML artifact store: ${checks - skipped}/${checks - skipped} scenarios; assertions=${assertions}; skipped=${skipped}`);
  } finally { fs.rmSync(world, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
