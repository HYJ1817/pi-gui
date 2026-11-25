'use strict';
// Real, deterministic format bytes; malformed variants are explicit fault cases.
// jsdom only checks ownership/DOM/lifecycle, NEVER claims native decode/playback.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const { crc32 } = require('../lib/zip.cjs');
const { tinyBmp } = require('./fixtures/attachment-files.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-media-archive-'));
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://fixture.invalid/' });
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
const load = name => import(pathToFileURL(path.join(__dirname, '../public/file-preview', name)).href);
const modules = Promise.all([load('zip-policy.js'), load('image.js'), load('media.js'), load('archive.js')]);
after(() => { dom.window.close(); fs.rmSync(directory, { recursive: true, force: true }); });

function fixture(name, bytes) {
  const target = path.join(directory, name);
  fs.writeFileSync(target, bytes);
  return new Uint8Array(fs.readFileSync(target));
}
function zipFiles(files) {
  const local = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.data || '');
    const method = file.method ?? 8;
    const compressed = file.compressed || (method === 0 ? data : zlib.deflateRawSync(data));
    const flags = (file.flags ?? 0x800) | (file.descriptor ? 8 : 0);
    const header = Buffer.alloc(30);
    const record = Buffer.alloc(46);
    const crc = crc32(data);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8);
    if (!file.descriptor) {
      header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22);
    }
    header.writeUInt16LE(name.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8); record.writeUInt16LE(method, 10); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(file.external ?? (file.name.endsWith('/') ? 0x41ed0010 : 0x81a40000), 38);
    record.writeUInt32LE(offset, 42);
    const descriptor = Buffer.alloc(file.descriptor ? 16 : 0);
    if (file.descriptor) {
      descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(data.length, 12);
    }
    local.push(header, name, compressed, descriptor); central.push(record, name);
    offset += header.length + name.length + compressed.length + descriptor.length;
  }
  const records = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(records.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, records, end]);
}
const centralOffset = bytes => bytes.readUInt32LE(bytes.length - 6);
function pngChunk(type, data) {
  const name = Buffer.from(type), header = Buffer.alloc(4), tail = Buffer.alloc(4);
  header.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([header, name, data, tail]);
}
function realPng(width = 1, height = 1) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height, 180);
  for (let row = 0; row < height; row++) scanlines[row * (width * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(scanlines)), pngChunk('IEND', Buffer.alloc(0))]);
}
function realIco() {
  const png = realPng(), header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header[6] = 1; header[7] = 1;
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}
function realWav() {
  const samples = 8000, header = Buffer.alloc(44), body = Buffer.alloc(samples * 2);
  header.write('RIFF'); header.writeUInt32LE(36 + body.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(body.length, 40);
  for (let index = 0; index < samples; index++) body.writeInt16LE(Math.round(1000 * Math.sin(index * Math.PI * 2 * 440 / 8000)), index * 2);
  return Buffer.concat([header, body]);
}
const png = fixture('tiny.png', realPng());
const bmp = fixture('tiny.bmp', tinyBmp());
const gif = fixture('tiny.gif', Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'));
const webp = fixture('tiny.webp', Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'));
const ico = fixture('tiny.ico', realIco());
const svg = fixture('tiny.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12"><path d="M0 0h24v12H0z" fill="red"/></svg>'));
const wav = fixture('tone.wav', realWav());
const legalZip = fixture('legal.zip', zipFiles([{ name: 'docs/' }, { name: 'docs/说明.txt', data: '真实中文 ZIP 内容' }, { name: 'tiny.png', data: png }, { name: 'nested.zip', data: zipFiles([]) }]));

function context(bytes, name, state = {}) {
  const doc = dom.window.document;
  const host = doc.createElement('div'), toolbar = doc.createElement('div');
  doc.body.append(toolbar, host);
  const controller = new AbortController();
  let active = true;
  const owned = [], urls = [], revoked = [], errors = [], opens = [];
  const ctx = {
    host, toolbar, request: { name }, meta: { name, bytes: bytes.length }, state,
    access: { bytes: async cap => { assert.ok(bytes.length <= cap); return bytes; }, url: async () => 'http://fixture.invalid/api/files/content?fileId=fixture' },
    resources: {
      signal: controller.signal, isCurrent: () => active,
      own: fn => { owned.push(fn); return fn; },
      url: blob => {
        assert.ok(blob instanceof Blob);
        const url = `blob:http://fixture.invalid/${urls.length}`;
        urls.push(url); owned.push(() => revoked.push(url)); return url;
      },
    },
    open: request => { opens.push(request); }, error: message => { errors.push(message); },
  };
  return { ctx, urls, revoked, errors, opens, stale: () => { active = false; }, dispose: () => { active = false; controller.abort(); owned.reverse().forEach(fn => fn()); host.remove(); toolbar.remove(); } };
}

// Browser media stubs are confined to lifecycle observability, not parsing.
let pauses = 0, loads = 0;
dom.window.HTMLMediaElement.prototype.pause = function () { pauses++; };
dom.window.HTMLMediaElement.prototype.load = function () { loads++; };
const fire = (target, event) => target.dispatchEvent(new dom.window.Event(event));

// ZIP: valid ordinary/descriptor/stored/UTF-8 data, then structural fault matrix.
test('ZIP reads real temporary archive, preserves UTF-8 and verifies CRC bytes', async t => {
  const [{ inspectZip }] = await modules;
  t.diagnostic(JSON.stringify({ zipBytes: legalZip.length, zipSha256: require('node:crypto').createHash('sha256').update(legalZip).digest('hex'), pngBytes: png.length, gifBytes: gif.length, bmpBytes: bmp.length, webpBytes: webp.length, icoBytes: ico.length, svgBytes: svg.length, wavBytes: wav.length, wavSeconds: 1 }));
  const zip = inspectZip(legalZip);
  assert.equal(zip.entries.length, 4);
  assert.equal(new TextDecoder().decode(zip.read('docs/说明.txt', 256)), '真实中文 ZIP 内容');
  assert.deepEqual(zip.read('tiny.png'), png);
  assert.equal(zip.read('docs/').length, 0);
  assert.ok(Object.isFrozen(zip.entries));
});
test('ZIP policy imports and reads in a worker without DOM', async () => {
  const { Worker } = require('node:worker_threads');
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.module).then(({ inspectZip }) => {
      const zip = inspectZip(workerData.bytes);
      parentPort.postMessage({ count: zip.entries.length, size: zip.read('tiny.png').length, dom: typeof document });
    }).catch(error => { throw error; });
  `, { eval: true, workerData: { module: pathToFileURL(path.join(__dirname, '../public/file-preview/zip-policy.js')).href, bytes: legalZip } });
  try {
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ZIP worker timeout')), 5000);
      worker.once('message', value => { clearTimeout(timer); resolve(value); });
      worker.once('error', error => { clearTimeout(timer); reject(error); });
    });
    assert.deepEqual(message, { count: 4, size: png.length, dom: 'undefined' });
  } finally { await worker.terminate(); }
});
test('ZIP stored + data descriptor use the same bounded read contract', async () => {
  const [{ inspectZip }] = await modules;
  for (const method of [0, 8]) {
    const bytes = fixture(`descriptor-${method}.zip`, zipFiles([{ name: 'a.txt', data: 'descriptor payload', descriptor: true, method }]));
    assert.equal(new TextDecoder().decode(inspectZip(bytes).read('a.txt')), 'descriptor payload');
  }
});
test('ZIP retains immutable snapshot after caller changes its input', async () => {
  const [{ inspectZip }] = await modules;
  const bytes = new Uint8Array(zipFiles([{ name: 'a', data: 'unchanged' }]));
  const zip = inspectZip(bytes); bytes.fill(0);
  assert.equal(new TextDecoder().decode(zip.read('a')), 'unchanged');
});
for (const name of ['../a', 'a/../b', '/etc/passwd', 'C:/a', 'a\\b', 'NUL.txt', 'x/COM1', 'aux ', 'x.', 'a//b', 'a\u0000.txt', 'a\n.txt', '//host/a', 'file:stream', 'a/./b']) {
  test(`ZIP rejects unsafe path ${JSON.stringify(name)}`, async () => {
    const [{ inspectZip }] = await modules;
    assert.throws(() => inspectZip(new Uint8Array(zipFiles([{ name, data: 'x' }]))), /压缩包/);
  });
}
test('ZIP rejects case/NFC duplicates and regular-file ancestors', async () => {
  const [{ inspectZip }] = await modules;
  for (const names of [['a', 'A'], ['a', 'a/'], ['é.txt', 'e\u0301.txt'], ['a', 'a/b']]) {
    assert.throws(() => inspectZip(new Uint8Array(zipFiles(names.map(name => ({ name, data: name.endsWith('/') ? '' : 'x' }))))));
  }
});
test('ZIP rejects symlink, FIFO, device and mismatched DOS directory metadata', async () => {
  const [{ inspectZip }] = await modules;
  for (const external of [0xa1ff0000, 0x11ff0000, 0x21ff0000, 0x61ff0000, 0x81a40010, 0x81a40400, 0x81a40040]) {
    assert.throws(() => inspectZip(new Uint8Array(zipFiles([{ name: 'a', data: 'x', external }]))));
  }
});
test('ZIP rejects encrypted/strong encrypted/patched/multidisk and unknown methods', async () => {
  const [{ inspectZip }] = await modules;
  for (const flags of [1, 0x40, 0x20, 0x2000]) assert.throws(() => inspectZip(new Uint8Array(zipFiles([{ name: 'a', data: 'x', flags }]))));
  assert.throws(() => inspectZip(new Uint8Array(zipFiles([{ name: 'a', data: 'x', method: 99 }]))));
  const bytes = zipFiles([{ name: 'a', data: 'x' }]); bytes.writeUInt16LE(1, bytes.length - 18);
  assert.throws(() => inspectZip(new Uint8Array(bytes)));
});
test('ZIP rejects corrupted bounds, ZIP64 sentinels, mismatched local names and overlap', async () => {
  const [{ inspectZip }] = await modules;
  const original = zipFiles([{ name: 'a', data: 'x' }, { name: 'b', data: 'y' }]);
  const central = centralOffset(original);
  for (const mutate of [
    b => b.writeUInt32LE(0xffffffff, central + 24),
    b => b.writeUInt32LE(0xffffffff, central + 42),
    b => b.writeUInt32LE(0xfffffff0, central + 20),
    b => { b[30] = 98; },
    b => b.writeUInt32LE(0, central + 47 + 42),
    b => b.writeUInt32LE(0x11223344, central),
  ]) {
    const bytes = Buffer.from(original); mutate(bytes);
    assert.throws(() => inspectZip(new Uint8Array(bytes)));
  }
  assert.throws(() => inspectZip(new Uint8Array(original.subarray(0, -1))));
});
test('ZIP caps entries/declared bytes/ratio/read max, and options cannot raise hard ceilings', async () => {
  const [{ inspectZip, ZIP_LIMITS }] = await modules;
  assert.throws(() => inspectZip(legalZip, { maxEntries: 3 }));
  assert.throws(() => inspectZip(legalZip, { maxTotalBytes: 1 }));
  assert.throws(() => inspectZip(legalZip, { maxEntryBytes: 1 }));
  assert.throws(() => inspectZip(legalZip, { maxArchiveBytes: 22 }));
  assert.throws(() => inspectZip(new Uint8Array(zipFiles([{ name: 'bomb', data: Buffer.alloc(65536) }]))));
  const zip = inspectZip(legalZip, { maxEntryBytes: 2 ** 40 });
  assert.throws(() => zip.read('tiny.png', 1));
  assert.throws(() => zip.read('missing'));
  assert.throws(() => inspectZip(legalZip, { maxRatio: NaN }));
  assert.equal(ZIP_LIMITS.maxEntryBytes, 16777216);
});
test('ZIP hard entry ceiling is 4096 even when callers request more', async () => {
  const [{ inspectZip }] = await modules;
  const bytes = new Uint8Array(zipFiles(Array.from({ length: 4097 }, (_, index) => ({ name: `f${index}` }))));
  assert.throws(() => inspectZip(bytes, { maxEntries: 99999 }));
});
test('ZIP verifies actual output length and CRC, not dishonest central declarations', async () => {
  const [{ inspectZip }] = await modules;
  const bytes = zipFiles([{ name: 'a', data: Buffer.from('actual content longer than header') }]);
  const central = centralOffset(bytes);
  bytes.writeUInt32LE(1, 22); bytes.writeUInt32LE(1, central + 24);
  assert.throws(() => inspectZip(new Uint8Array(bytes)).read('a'), /压缩包/);
  const bomb = zipFiles([{ name: 'a', data: Buffer.alloc(1024 * 1024) }]);
  bomb.writeUInt32LE(1, 22); bomb.writeUInt32LE(1, centralOffset(bomb) + 24);
  assert.throws(() => inspectZip(new Uint8Array(bomb)).read('a'), /压缩包/);
  const badCrc = zipFiles([{ name: 'a', data: 'payload' }]);
  badCrc.writeUInt32LE(123, 14); badCrc.writeUInt32LE(123, centralOffset(badCrc) + 16);
  assert.throws(() => inspectZip(new Uint8Array(badCrc)).read('a'), /压缩包/);
});
test('ZIP refuses trailing garbage inside a declared deflate payload', async () => {
  const [{ inspectZip }] = await modules;
  const data = Buffer.from('CRC and output size alone are insufficient');
  const compressed = Buffer.concat([zlib.deflateRawSync(data), Buffer.from([0, 1, 2])]);
  const bytes = new Uint8Array(zipFiles([{ name: 'a', data, compressed }]));
  assert.throws(() => inspectZip(bytes).read('a'));
});
test('ZIP budget is actual per-unique entry, rereads do not consume cumulative cap', async () => {
  const [{ inspectZip }] = await modules;
  const bytes = new Uint8Array(zipFiles([{ name: 'a', data: '12345' }, { name: 'b', data: '67890' }]));
  const zip = inspectZip(bytes, { maxTotalBytes: 10 });
  for (let index = 0; index < 5; index++) assert.equal(zip.read('a').length, 5);
  assert.equal(zip.read('b').length, 5);
});

for (const [name, bytes, width, height] of [['png', png, 1, 1], ['gif', gif, 1, 1], ['bmp', bmp, 1, 1], ['webp', webp, 1, 1], ['ico', ico, 1, 1], ['svg', svg, 24, 12]]) {
  test(`image validates genuine ${name} container and dimensions`, async () => {
    const [, { inspectImage }] = await modules;
    const info = inspectImage(bytes);
    assert.equal(info.format, name); assert.equal(info.width, width); assert.equal(info.height, height); assert.equal(info.frames, 1);
  });
}
test('image rejects extension spoofing, truncated containers and executable bytes', async () => {
  const [, { inspectImage }] = await modules;
  for (const data of [Buffer.from('MZ not an image'), Buffer.from('<html>not SVG</html>'), png.subarray(0, 30), bmp.subarray(0, 54), gif.subarray(0, -1), webp.subarray(0, -1), ico.subarray(0, 22), Buffer.from('JPEG')]) {
    assert.throws(() => inspectImage(new Uint8Array(data)));
  }
});
test('image enforces side/pixel and GIF animation budgets before native decoding', async () => {
  const [, { inspectImage }] = await modules;
  const huge = Buffer.from(png); huge.writeUInt32BE(20000, 16);
  assert.throws(() => inspectImage(new Uint8Array(huge)), /安全预览范围/);
  const frameOffset = Buffer.from(gif).indexOf(0x2c);
  const frames = Buffer.concat([gif.subarray(0, frameOffset), ...Array.from({ length: 101 }, () => gif.subarray(frameOffset, gif.length - 1)), Buffer.from([0x3b])]);
  assert.throws(() => inspectImage(new Uint8Array(frames)), /安全预览范围/);
});
test('SVG rejects scripts/foreignObject/external references/DTD/animation, never inserts SVG DOM', async () => {
  const [, { inspectImage, mount }] = await modules;
  const wrap = body => new Uint8Array(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12">${body}</svg>`));
  for (const body of ['<script>alert(1)</script>', '<foreignObject/>', '<use href="https://evil.invalid/x"/>', '<image href="file:///secret"/>', '<animate attributeName="width"/>', '<path onload="x()"/>', '<style>@import "https://evil.invalid";</style>', '<filter id="x"/>']) {
    assert.throws(() => inspectImage(wrap(body)));
  }
  assert.throws(() => inspectImage(new Uint8Array(Buffer.from('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///x">]><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">&x;</svg>'))));
  const scope = context(svg, 'image.svg'); const instance = await mount(scope.ctx);
  assert.equal(scope.ctx.host.querySelectorAll('svg,script,iframe').length, 0);
  assert.equal(scope.ctx.host.querySelector('img').getAttribute('src'), scope.urls[0]);
  instance.dispose(); scope.dispose();
});
test('image fit/original/zoom and disposal remove own listeners/source, stale reads add nothing', async () => {
  const [, { mount }] = await modules;
  const scope = context(png, 'image.png'); const instance = await mount(scope.ctx);
  const control = label => scope.ctx.toolbar.querySelector(`button[aria-label="${label}"]`);
  control('阅读选项').click();
  const original = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === '原始尺寸');
  assert.ok(original); original.click();
  assert.equal(instance.getState().mode, 'original');
  control('放大').click();
  assert.equal(instance.getState().zoom, 1.25);
  control('适合窗口').click();
  assert.equal(instance.getState().mode, 'fit');
  const image = scope.ctx.host.querySelector('img'); instance.dispose();
  assert.equal(image.hasAttribute('src'), false);
  fire(image, 'error'); assert.equal(scope.errors.length, 0);
  scope.dispose(); assert.deepEqual(scope.revoked, scope.urls);
  const stale = context(png, 'stale.png'); stale.stale(); await mount(stale.ctx);
  assert.equal(stale.ctx.host.children.length, 0); assert.equal(stale.urls.length, 0); stale.dispose();
});

test('media uses controlled URL/native controls, never autoplay or canPlayType as evidence', async () => {
  const [, , { mount, mediaKind, formatTime }] = await modules;
  assert.equal(mediaKind('A.OPUS'), 'audio'); assert.equal(mediaKind('v.webm'), 'video'); assert.equal(mediaKind('a.exe'), null);
  assert.equal(formatTime(3661), '1:01:01'); assert.equal(formatTime(Infinity), '—');
  const scope = context(wav, 'tone.wav', { volume: 0.25, currentTime: 0.5 });
  const instance = await mount(scope.ctx); const media = scope.ctx.host.querySelector('audio');
  assert.ok(media.controls); assert.equal(media.autoplay, false); assert.equal(media.preload, 'metadata'); assert.equal(media.volume, 0.25);
  assert.ok(media.src.includes('/api/files/content?fileId=fixture'));
  assert.match(scope.ctx.host.textContent, /正在读取媒体信息/);
  // Only browser event observation is simulated; waveform bytes are real PCM.
  Object.defineProperty(media, 'duration', { configurable: true, value: 1 });
  fire(media, 'loadedmetadata'); assert.equal(media.currentTime, 0.5);
  assert.equal(instance.getState().currentTime, 0.5); assert.match(scope.ctx.host.textContent, /点击播放/);
  assert.equal(wav.length, 16044); assert.equal(Buffer.from(wav).readUInt32LE(40), 16000);
  scope.dispose();
});
test('media dispose is idempotent: pause, clear src, load and ignore late events', async () => {
  const [, , { mount }] = await modules;
  const scope = context(wav, 'tone.wav'); const instance = await mount(scope.ctx);
  const media = scope.ctx.host.querySelector('audio'); const before = { pauses, loads };
  instance.dispose(); instance.dispose();
  assert.equal(pauses, before.pauses + 1); assert.equal(loads, before.loads + 1); assert.equal(media.hasAttribute('src'), false);
  const text = scope.ctx.host.textContent; fire(media, 'error'); fire(media, 'loadedmetadata');
  assert.equal(scope.ctx.host.textContent, text); scope.dispose();
});
test('media decode failure is concise persistent local error and releases source', async () => {
  const [, , { mount }] = await modules;
  const scope = context(wav, 'tone.wav'); await mount(scope.ctx);
  const media = scope.ctx.host.querySelector('audio'); fire(media, 'error');
  assert.match(scope.ctx.host.textContent, /当前环境无法播放/); assert.equal(media.hasAttribute('src'), false);
  fire(media, 'loadedmetadata'); fire(media, 'canplay'); fire(media, 'pause');
  assert.match(scope.ctx.host.textContent, /当前环境无法播放/);
  assert.doesNotMatch(scope.ctx.host.textContent, /fixture.invalid|fileId|stack/); scope.dispose();
});
test('media close during URL resolution never creates a player', async () => {
  const [, , { mount }] = await modules;
  const scope = context(wav, 'tone.wav'); let finish;
  scope.ctx.access.url = () => new Promise(resolve => { finish = resolve; });
  const pending = mount(scope.ctx); scope.dispose(); finish('http://fixture.invalid/old'); await pending;
  assert.equal(scope.ctx.host.children.length, 0);
});
test('archive lazy expansion/search/metadata reuse registry for text, never auto-open nested ZIP', async () => {
  const [, , , { mount, archivePreviewLimit }] = await modules;
  assert.equal(archivePreviewLimit({ name: 'nested.zip', size: 10 }), 0);
  assert.equal(archivePreviewLimit({ name: 'big.txt', size: 256 * 1024 + 1 }), 0);
  const scope = context(legalZip, 'legal.zip'); const instance = await mount(scope.ctx);
  const folder = scope.ctx.host.querySelector('details');
  assert.ok(folder); assert.equal(folder.querySelector('ul'), null);
  folder.open = true; fire(folder, 'toggle'); assert.ok(folder.querySelector('ul'));
  assert.ok(instance.getState().expanded.includes('docs/'));
  const input = scope.ctx.toolbar.querySelector('input'); input.value = '说明'; fire(input, 'input');
  const row = scope.ctx.host.querySelector('.fp-archive-entry'); assert.ok(row); row.click();
  assert.match(scope.ctx.host.querySelector('.fp-archive-selection').textContent, /压缩后/);
  const open = [...scope.ctx.host.querySelectorAll('button')].find(item => item.textContent === '预览文件');
  open.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(scope.opens.length, 1); assert.equal(scope.opens[0].source, 'archive');
  assert.equal(new TextDecoder().decode(scope.opens[0].bytes), '真实中文 ZIP 内容');
  input.value = 'nested'; fire(input, 'input'); scope.ctx.host.querySelector('.fp-archive-entry').click();
  assert.equal(open.disabled, true); assert.equal(scope.opens.length, 1);
  scope.dispose();
});
test('archive empty, search-empty, corrupt and stale states remain distinct', async () => {
  const [, , , { mount }] = await modules;
  const empty = context(new Uint8Array(zipFiles([])), 'empty.zip'); await mount(empty.ctx);
  assert.match(empty.ctx.host.textContent, /压缩包为空/); empty.dispose();
  const valid = context(legalZip, 'legal.zip'); await mount(valid.ctx);
  const input = valid.ctx.toolbar.querySelector('input'); input.value = 'not-found'; fire(input, 'input');
  assert.match(valid.ctx.host.textContent, /没有匹配的文件/); valid.dispose();
  const bad = context(new Uint8Array([1, 2, 3]), 'bad.zip'); await mount(bad.ctx); assert.equal(bad.errors.length, 1); bad.dispose();
  const stale = context(legalZip, 'old.zip'); stale.stale(); await mount(stale.ctx);
  assert.equal(stale.ctx.host.children.length, 0); stale.dispose();
});
