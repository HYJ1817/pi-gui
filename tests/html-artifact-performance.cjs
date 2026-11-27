// Same workload/instrumentation for before/after; every write is TEMP-only.
const strict = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { performance } = require('node:perf_hooks');
const digest = text => createHash('sha256').update(text).digest('hex');
let assertions = 0;
const assert = new Proxy(strict, { get(target, key) {
  const value = target[key];
  return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value;
} });
const benchmark = process.argv.includes('--benchmark');
const baseline = process.argv.find(arg => arg.startsWith('--baseline='))?.slice('--baseline='.length);
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-html-perf-'));
  try {
    let moduleUrl = pathToFileURL(path.resolve(__dirname, '../server/html-artifact-store.js')).href;
    let implementation = 'working-tree', sourceDigest;
    if (baseline) {
      if (!/^[a-f0-9]{8,40}$/.test(baseline)) throw Error('baseline must be a hexadecimal Git commit');
      const repo = path.resolve(__dirname, '..');
      implementation = execFileSync('git', ['-C', repo, 'rev-parse', '--verify', baseline + '^{commit}'], { encoding: 'utf8' }).trim();
      const source = execFileSync('git', ['-C', repo, 'show', implementation + ':server/html-artifact-store.js'], { encoding: 'utf8' });
      sourceDigest = digest(source);
      // Materialize only this local Git source in TEMP; dependencies remain the
      // same production modules. Never checkout/reset another agent's files.
      const rewritten = source.replace(/from '(\.\.?\/[^']+)'/g, (_all, specifier) =>
        `from '${pathToFileURL(path.resolve(repo, 'server', specifier)).href}'`);
      const file = path.join(dir, 'baseline-store.mjs'); fs.writeFileSync(file, rewritten);
      moduleUrl = pathToFileURL(file).href;
    } else sourceDigest = digest(fs.readFileSync(path.resolve(__dirname, '../server/html-artifact-store.js')));
    const { createHtmlArtifactStore } = await import(moduleUrl);
    const dataDir = path.join(dir, 'data'); fs.mkdirSync(dataDir);
    const io = Object.create(fs), htmlFds = new Set();
    let readBytes = 0, reads = 0;
    io.openSync = (file, ...args) => {
      const fd = fs.openSync(file, ...args);
      if (path.basename(String(file)) === 'document.html') htmlFds.add(fd);
      return fd;
    };
    io.closeSync = fd => { htmlFds.delete(fd); return fs.closeSync(fd); };
    io.readSync = (fd, ...args) => {
      const length = fs.readSync(fd, ...args);
      if (htmlFds.has(fd)) { readBytes += length; reads++; }
      return length;
    };
    const store = createHtmlArtifactStore({ dataDir, io });
    const corpusCount = benchmark ? 64 : 8;
    const corpusHtml = '<!doctype html><p>' + 'x'.repeat((benchmark ? 512 : 32) * 1024 - 21) + '</p>';
    const make = (index, html = corpusHtml) => ({ sessionId: 'session-' + index % 8,
      messageId: 'message-' + index, toolCallId: 'call-' + index, title: 'History', html });
    const refs = [];
    for (let index = 0; index < corpusCount; index++) refs.push(await store.publish(make(index)));
    const corpusBytes = corpusCount * Buffer.byteLength(corpusHtml), times = [], samples = [];
    const newHtml = '<p>' + 'y'.repeat(4096) + '</p>';
    // Eight API callers/eight sessions; store commits remain serialized.
    for (let round = 0; round < (benchmark ? 3 : 1); round++) {
      readBytes = 0; reads = 0;
      const start = performance.now();
      const batch = await Promise.all(Array.from({ length: 8 }, (_, offset) =>
        store.publish(make(corpusCount + round * 8 + offset, newHtml))));
      times.push(performance.now() - start); samples.push({ htmlReadBytes: readBytes, htmlReadCalls: reads });
      for (const ref of batch) assert.equal(ref.digest, digest(newHtml));
    }
    const read = await store.read(refs[0].id);
    assert.equal(read.html, corpusHtml); assert.equal(read.artifact.digest, digest(corpusHtml));
    console.log(JSON.stringify({ mode: benchmark ? 'benchmark' : 'regression', implementation, sourceDigest,
      node: process.version, platform: process.platform, corpusCount, sessions: 8, corpusBytes,
      corpusDigest: digest(corpusHtml), newHtmlBytes: Buffer.byteLength(newHtml), concurrentCallsPerRound: 8,
      milliseconds: times.map(n => +n.toFixed(3)), medianMs: +[...times].sort((a, b) => a - b)[Math.floor(times.length / 2)].toFixed(3),
      samples, integrityDigest: read.artifact.digest }));
    if (!benchmark) {
      assert.equal(samples[0].htmlReadBytes, 8 * 2 * Buffer.byteLength(newHtml),
        'quota admission must not reread any historical HTML');
      // Cold metadata-index instances still do no historical HTML reads.
      readBytes = 0; reads = 0;
      await createHtmlArtifactStore({ dataDir, io }).publish(make(corpusCount + 8, newHtml));
      assert.equal(readBytes, 2 * Buffer.byteLength(newHtml));
      // Warm cached metadata is only a projection, never the disk authority.
      const meta = path.join(dataDir, 'html-artifacts', refs[0].id, 'reference.json');
      const original = fs.readFileSync(meta);
      fs.writeFileSync(meta, JSON.stringify({ ...refs[0], schemaVersion: 99 }) + '\n');
      await assert.rejects(store.publish(make(corpusCount + 9, newHtml)), error => error.code === 'html_artifact_storage_corrupt');
      fs.writeFileSync(meta, original);
      const html = path.join(dataDir, 'html-artifacts', refs[0].id, 'document.html');
      fs.writeFileSync(html, corpusHtml.replace('x', 'z')); // Same physical length.
      await assert.rejects(store.read(refs[0].id), error => error.code === 'html_artifact_storage_corrupt');
      await assert.rejects(store.publish(make(0)), error => error.code === 'html_artifact_storage_corrupt');
      fs.writeFileSync(html, corpusHtml);
      assert.equal((await store.read(refs[0].id)).artifact.digest, digest(corpusHtml));
    }
    console.log(`HTML artifact performance: ${assertions}/${assertions} assertions; skipped=0; exit=0`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
