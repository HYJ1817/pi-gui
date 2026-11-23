/* Compact attachments: real DOM modules plus the actual HTTP upload/parser.
 * No real projects, model calls, downloaded fixtures or external converters. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');
const { documentFiles, tinyPng, tinyBmp, TINY_PNG_BASE64 } = require('./fixtures/attachment-files.cjs');
let passed = 0, failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack); }
}
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

async function main() {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), { url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  const created = [], revoked = [];
  w.URL.createObjectURL = file => { const url = 'blob:http://fixture.invalid/' + created.length; created.push({ url, file }); return url; };
  w.URL.revokeObjectURL = url => revoked.push(url);
  w.eval(bundle(path.join(__dirname, '../public/rpc.js')).code);
  Object.assign(w.S, { hasProject: true, bridgeState: 'ready', switching: false, modelSwitchPending: false, submitting: false, stopping: false, fallbackActive: false, streaming: true, attachments: [], state: { sessionId: 'fixture', model: { input: ['text', 'image'] } } });
  const tray = d.getElementById('attachTray'), input = d.getElementById('input'), send = d.getElementById('btnSend');
  let requestCount = 0;
  const success = (file, name) => ({ ok: true, id: 'server-' + ++requestCount, name, size: file.size, path: 'C:/temp/fixture/' + name, kind: /\.png$/i.test(name) ? 'image' : /\.md$/i.test(name) ? 'text' : 'binary', ...(/\.md$/i.test(name) ? { text: '# fixture', chars: 9 } : {}) });
  w.fetch = async (url, options) => ({ json: async () => success(options.body, new URL(url, w.location.href).searchParams.get('name')) });
  const file = (name, type = '', content = 'fixture bytes') => new w.File([content], name, { type });
  try {
    await check('successful files show only real filename/size with no ready/unreadable status', async () => {
      await w.handleFiles([file('说明.md', 'text/markdown'), file('归档.zip', 'application/zip')]);
      assert.equal(tray.querySelectorAll('.att').length, 2);
      assert.ok(!/已就绪|读不了|无法解析|二进制/.test(tray.textContent));
      assert.ok(tray.textContent.includes('13 B'));
      assert.equal(tray.querySelectorAll('.att-meta:not([hidden])').length, 0);
    });
    await check('video is an ordinary preserved file reference, not ImageContent', async () => {
      await w.handleFiles([file('演示.MP4')]);
      const video = w.S.attachments.at(-1);
      const item = tray.querySelector('[data-file-type="video"]');
      assert.ok(item);
      assert.ok(item.querySelector('.att-preview'));
      assert.ok(item.querySelector('[data-icon="play"]'));
      assert.ok(w.buildMessage('').includes(video.path));
      assert.equal(w.attachmentImages().length, 0);
      assert.ok(!w.buildMessage('').includes('无法解析'));
    });
    await check('file type icons distinguish PDF, Word, slides, sheets, Markdown and archives', () => {
      w.S.attachments = documentFiles().map((item, index) => ({ id: String(index), name: item.name, size: item.body.length, mimeType: item.type, kind: 'binary', path: 'C:/temp/' + item.name }));
      w.renderAttachments();
      assert.equal([...tray.children].map(item => item.dataset.fileType).join(','), 'pdf,word,slides,sheet,markdown,archive');
      assert.equal(new Set([...tray.querySelectorAll('.att-ic svg')].map(item => item.innerHTML)).size, 6);
    });
    await check('long original filenames survive server storage sanitization and are keyboard-readable', async () => {
      const name = '中文与English'.repeat(30) + '.pdf';
      w.S.attachments = [];
      w.fetch = async () => ({ json: async () => ({ ok: true, id: 'safe', name: name.slice(0, 120), kind: 'binary', path: 'C:/temp/safe.pdf', size: 13 }) });
      await w.handleFiles([file(name, 'application/pdf')]);
      const label = tray.querySelector('.att-name');
      assert.equal(label.textContent, name); assert.equal(label.title, name);
      assert.ok(tray.querySelector('.att-info').getAttribute('aria-label').includes(name));
    });
    await check('uploads register the entire selected batch before any asynchronous work', async () => {
      w.S.attachments = [];
      const pending = [];
      w.fetch = (url, options) => new Promise(resolve => pending.push(() => resolve({ json: async () => success(options.body, new URL(url, w.location.href).searchParams.get('name')) })));
      const upload = w.handleFiles([file('one.md'), file('two.md'), file('three.md')]);
      try { assert.equal(w.S.attachments.length, 3); assert.equal(send.disabled, true); }
      finally { while (pending.length) { pending.shift()(); await tick(); } await upload; }
    });
    await check('upload failure cannot send a phantom unknown path or clear the draft', async () => {
      w.S.attachments = []; input.value = 'keep my text'; let calls = 0;
      w.fetch = async url => ({ json: async () => { if (String(url).startsWith('/api/upload')) return { ok: false, error: '文件超过上限 32 MB' }; calls++; return { ok: true }; } });
      await w.handleFiles([file('failed.zip')]);
      assert.equal(send.disabled, true); await w.submit(); assert.equal(calls, 0); assert.equal(input.value, 'keep my text');
      assert.ok(tray.textContent.includes('文件超过上限 32 MB'));
      assert.ok(!w.buildMessage('').includes('本机路径：未知'));
      w.removeAttachment(w.S.attachments[0].id); assert.equal(send.disabled, false);
    });
    await check('parse failure retains a valid original-file reference and remains sendable', async () => {
      w.S.attachments = [];
      w.fetch = async () => ({ json: async () => ({ ok: true, id: 'retained', name: 'scan.pdf', kind: 'binary', path: 'C:/temp/scan.pdf', size: 13, error: 'PDF 里没有可提取的文字（可能是扫描件，需要 OCR）' }) });
      await w.handleFiles([file('scan.pdf')]);
      assert.equal(send.disabled, false); assert.ok(w.buildMessage('task').includes('C:/temp/scan.pdf'));
      assert.ok(w.buildMessage('task').includes('PDF 里没有可提取的文字'));
      assert.ok(!/已就绪|读不了/.test(tray.textContent));
    });
    await check('removing an in-flight file cannot resurrect it or change the next attachment identity', async () => {
      w.S.attachments = []; let finish;
      w.fetch = () => new Promise(resolve => { finish = payload => resolve({ json: async () => payload }); });
      const upload = w.handleFiles([file('removed.mp4')]);
      await tick(); const item = w.S.attachments[0]; w.removeAttachment(item.id);
      finish({ ok: true, id: 'late-server-id', name: item.name, path: 'C:/temp/removed.mp4', kind: 'binary' }); await upload;
      assert.equal(w.S.attachments.length, 0); assert.equal(tray.hidden, true);
      assert.ok(revoked.length > 0);
    });
    await check('upload completion keeps the focused client attachment identity', async () => {
      w.S.attachments = []; let finish;
      w.fetch = () => new Promise(resolve => { finish = payload => resolve({ json: async () => payload }); });
      const upload = w.handleFiles([file('focus.md')]); await tick();
      const id = w.S.attachments[0].id; tray.querySelector('.att-x').focus();
      finish({ ok: true, id: 'different-server-id', name: 'focus.md', kind: 'text', text: 'body', chars: 4, path: 'C:/temp/focus.md' }); await upload;
      assert.equal(w.S.attachments[0].id, id); assert.equal(d.activeElement.dataset.attachmentId, id);
    });
    await check('workspace changes invalidate pending batch without leaking files into the new workspace', async () => {
      w.S.attachments = []; let finish, calls = 0;
      w.fetch = () => ++calls === 1 ? new Promise(resolve => { finish = payload => resolve({ json: async () => payload }); })
        : Promise.resolve({ json: async () => ({ ok: true, id: 'second', kind: 'text', text: 'old', path: 'C:/temp/old-two.md' }) });
      const upload = w.handleFiles([file('old-one.md'), file('old-two.md')]); await tick();
      w.beginWorkspaceSwitch('C:/temp/next');
      finish({ ok: true, id: 'old-response', kind: 'text', text: 'old', path: 'C:/temp/old.md' }); await upload;
      assert.equal(w.S.attachments.length, 0); assert.equal(tray.hidden, true);
      Object.assign(w.S, { switching: false, modelSwitchPending: false, bridgeState: 'ready' });
    });
    await check('image with no MIME uses its real extension for ImageContent', async () => {
      w.S.attachments = [];
      w.fetch = async () => ({ json: async () => ({ ok: true, id: 'image', name: 'picture.PNG', size: 13, kind: 'image', path: 'C:/temp/image.png' }) });
      await w.handleFiles([file('picture.PNG', '', tinyPng())]);
      assert.equal(w.attachmentImages()[0].mimeType, 'image/png');
      assert.ok(tray.querySelector('.att-preview'));
    });
    await check('preview modal handles Escape and returns focus without sending', () => {
      const button = tray.querySelector('.att-preview'); button.focus(); button.click();
      assert.equal(d.getElementById('modal').hidden, false);
      assert.ok(d.querySelector('.attachment-preview-dialog img'));
      d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert.equal(d.getElementById('modal').hidden, true); assert.equal(d.activeElement, button);
    });
    await check('untrusted file names and parse messages stay inert', () => {
      w.S.attachments = [{ id: 'inert', name: '<img src=x onerror=alert(1)>.pdf', size: 4, kind: 'binary', path: 'C:/temp/safe.pdf', error: '<b>解析失败</b>' }];
      w.renderAttachments(); assert.equal(tray.querySelector('img,b'), null);
      assert.ok(tray.textContent.includes('<b>解析失败</b>'));
      const message = w.buildMessage(''); w.FILE_BLOCK_RE.lastIndex = 0;
      const match = w.FILE_BLOCK_RE.exec(message); assert.ok(match); assert.ok(!match[1].includes('<'));
    });
    await check('zero-byte selection is a visible failure rather than silently discarded', async () => {
      w.S.attachments = []; w.fetch = async () => ({ json: async () => ({ ok: false, error: '文件内容为空' }) });
      await w.handleFiles([new w.File([], 'empty.txt')]); assert.equal(w.S.attachments.length, 1);
      assert.ok(tray.textContent.includes('0 B')); assert.ok(tray.textContent.includes('文件内容为空')); assert.equal(send.disabled, true);
    });
    await check('only genuine image bytes produce an image-provided claim', () => {
      w.S.attachments = [{ id: 'ref-image', name: 'image.png', kind: 'image', path: 'C:/temp/image.png', error: '图片数据读取失败' }];
      assert.equal(w.attachmentImages().length, 0); const message = w.buildMessage('');
      assert.ok(!message.includes('已作为图像内容提供')); assert.ok(message.includes('C:/temp/image.png'));
    });
    await check('file attributes cannot break the existing pi-file message envelope', () => {
      w.S.attachments = [{ id: 'quoted', name: 'report "A&B".md', kind: 'text', text: 'original body', chars: 13 }];
      const message = w.buildMessage('task'); w.FILE_BLOCK_RE.lastIndex = 0;
      const match = w.FILE_BLOCK_RE.exec(message); assert.ok(match);
      assert.equal(match[1], 'report &quot;A&amp;B&quot;.md'); assert.equal(match[3], 'original body');
      assert.ok(/^<pi-file name="report &quot;A&amp;B&quot;.md" meta="13 字" esc="1">/.test(match[0]));
    });
    await check('legacy unmarked pi-file attributes are captured verbatim', () => {
      w.FILE_BLOCK_RE.lastIndex = 0;
      const match = w.FILE_BLOCK_RE.exec('<pi-file name="A &amp; B.txt" meta="文件引用">\nold\n</pi-file>');
      assert.ok(match); assert.equal(match[1], 'A &amp; B.txt'); assert.ok(!match[0].startsWith('<pi-file name="A &amp; B.txt" meta="文件引用" esc='));
    });
    await check('a text file renamed to .png stays a file reference, never ImageContent', async () => {
      w.S.attachments = [];
      w.fetch = async () => ({ json: async () => ({ ok: true, id: 'fake', name: 'fake.png', kind: 'image', path: 'C:/temp/fake.png', size: 13 }) });
      await w.handleFiles([file('fake.png', 'image/png', 'PNGDATA')]);
      const fake = w.S.attachments[0];
      assert.equal(fake.kind, 'binary'); assert.equal(w.attachmentImages().length, 0);
      assert.ok(w.buildMessage('').includes('C:/temp/fake.png'));
      assert.ok(!w.buildMessage('').includes('已作为图像内容提供'));
      assert.ok(tray.textContent.includes('图片格式不符')); assert.equal(send.disabled, false);
    });
    await check('failed image read falls back to a path reference for text-only models', async () => {
      w.S.attachments = []; w.S.state.model = { input: ['text', 'image'] };
      w.fetch = async () => ({ json: async () => ({ ok: true, id: 'read-fail', name: 'read-fail.png', kind: 'image', path: 'C:/temp/read-fail.png', size: 13 }) });
      const OriginalReader = w.FileReader;
      w.FileReader = class { readAsDataURL() { setTimeout(() => this.onerror?.(new w.Event('error')), 0); } };
      try { await w.handleFiles([file('read-fail.png', 'image/png', tinyPng())]); }
      finally { w.FileReader = OriginalReader; }
      assert.equal(w.S.attachments[0].kind, 'binary');
      w.S.state.model = { input: ['text'] }; w.updateSendState();
      assert.equal(w.imageInputBlocked(), true); assert.equal(send.disabled, false);
      assert.ok(w.buildMessage('').includes('C:/temp/read-fail.png'));
    });
    await check('pagehide invalidates in-flight intake and marks incomplete items as real failures', async () => {
      w.S.attachments = []; w.S.state.model = { input: ['text', 'image'] }; let finish, calls = 0;
      w.fetch = () => { calls++; return new Promise(resolve => { finish = payload => resolve({ json: async () => payload }); }); };
      const upload = w.handleFiles([file('leaving-one.md'), file('leaving-two.md')]);
      await tick();
      w.dispatchEvent(new w.Event('pagehide'));
      finish({ ok: true, id: 'late', name: 'leaving-one.md', kind: 'text', text: 'late', chars: 4, path: 'C:/temp/late.md' });
      await upload; w.renderAttachments(); w.updateSendState();
      assert.equal(calls, 1); assert.equal(w.S.attachments.length, 2);
      assert.ok(w.S.attachments.every(attachment => !attachment.loading && attachment.uploadFailed && !attachment.path));
      assert.ok(tray.textContent.includes('页面已离开')); assert.equal(send.disabled, true);
      w.S.attachments.forEach(attachment => w.removeAttachment(attachment.id));
    });
    await check('a two-byte BM prefix without a bitmap header stays a file reference', async () => {
      w.S.attachments = [];
      w.fetch = async () => ({ json: async () => ({ ok: true, id: 'bmw', name: 'fake.bmp', kind: 'image', path: 'C:/temp/fake.bmp', size: 13 }) });
      await w.handleFiles([file('fake.bmp', 'image/bmp', 'BMW is a car maker, not a bitmap image.')]);
      const fake = w.S.attachments[0];
      assert.equal(fake.kind, 'binary'); assert.equal(w.attachmentImages().length, 0);
      assert.ok(w.buildMessage('').includes('C:/temp/fake.bmp'));
      assert.ok(tray.textContent.includes('图片格式不符')); assert.equal(send.disabled, false);
    });
    await check('a structurally valid BMP is sent as image/bmp ImageContent', async () => {
      w.S.attachments = [];
      const bmp = tinyBmp();
      w.fetch = async () => ({ json: async () => ({ ok: true, id: 'bmp', name: 'pixel.bmp', kind: 'image', path: 'C:/temp/pixel.bmp', size: bmp.length }) });
      await w.handleFiles([file('pixel.bmp', 'image/bmp', bmp)]);
      const [image] = w.attachmentImages();
      assert.equal(image.mimeType, 'image/bmp'); assert.equal(image.data, bmp.toString('base64'));
      assert.equal(w.S.attachments[0].kind, 'image');
    });
    await check('pagehide aborts the in-flight upload instead of leaving a server-side orphan', async () => {
      w.S.attachments = []; let signal;
      w.fetch = (url, options) => new Promise((resolve, reject) => {
        signal = options.signal;
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
      const upload = w.handleFiles([file('abort-me.md')]);
      await tick(); assert.equal(signal.aborted, false);
      w.dispatchEvent(new w.Event('pagehide')); await upload;
      assert.equal(signal.aborted, true); assert.equal(w.S.attachments.length, 1);
      w.renderAttachments();
      assert.ok(w.S.attachments[0].uploadFailed); assert.ok(tray.textContent.includes('页面已离开'));
      w.S.attachments = []; w.renderAttachments();
    });
    await check('removing an in-flight attachment aborts its upload request', async () => {
      w.S.attachments = []; let signal;
      w.fetch = (url, options) => new Promise((resolve, reject) => {
        signal = options.signal;
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
      const upload = w.handleFiles([file('remove-abort.md')]);
      await tick();
      w.removeAttachment(w.S.attachments[0].id);
      assert.equal(signal.aborted, true); await upload;
      assert.equal(w.S.attachments.length, 0); assert.equal(tray.hidden, true);
    });
    await check('removing the last image leaves focus on a remaining file item', () => {
      w.S.attachments = [
        { id: 'focus-image', name: 'pic.png', size: 68, mimeType: 'image/png', kind: 'image', dataUrl: 'data:image/png;base64,' + TINY_PNG_BASE64 },
        { id: 'focus-file', name: 'notes.md', size: 3, kind: 'text', text: 'abc', chars: 3 },
      ];
      w.renderAttachments();
      tray.querySelector('.att-preview').focus();
      w.removeAttachment('focus-image');
      assert.ok(tray.contains(d.activeElement)); assert.ok(d.activeElement.matches('.att-info'));
    });
    await check('removing the last file leaves focus on a remaining media item', () => {
      w.S.attachments = [
        { id: 'focus-image-2', name: 'pic.png', size: 68, mimeType: 'image/png', kind: 'image', dataUrl: 'data:image/png;base64,' + TINY_PNG_BASE64 },
        { id: 'focus-file-2', name: 'notes.md', size: 3, kind: 'text', text: 'abc', chars: 3 },
      ];
      w.renderAttachments();
      tray.querySelector('.att-info').focus();
      w.removeAttachment('focus-file-2');
      assert.ok(tray.contains(d.activeElement)); assert.ok(d.activeElement.matches('.att-preview'));
    });
    await check('a disabled media item cannot swallow focus when the last file is removed', () => {
      w.S.attachments = [
        { id: 'broken-image', name: 'broken.png', size: 13, mimeType: 'image/png', kind: 'binary', path: 'C:/temp/broken.png' },
        { id: 'focus-file-3', name: 'notes.md', size: 3, kind: 'text', text: 'abc', chars: 3 },
      ];
      w.renderAttachments();
      assert.equal(tray.querySelector('.att-preview').disabled, true);
      tray.querySelector('.att-info').focus();
      w.removeAttachment('focus-file-3');
      assert.ok(tray.contains(d.activeElement)); assert.ok(d.activeElement.matches('.att-x'));
    });
    await check('non-native image formats stay local previews plus file references, not invented model inputs', async () => {
      w.S.attachments = [];
      w.fetch = async () => ({ json: async () => ({ ok: true, id: 'vector', kind: 'binary', path: 'C:/temp/vector.svg', size: 13 }) });
      await w.handleFiles([file('vector.svg', 'image/svg+xml')]);
      assert.equal(tray.firstElementChild.dataset.fileType, 'image'); assert.equal(w.attachmentImages().length, 0);
      assert.ok(w.buildMessage('').includes('C:/temp/vector.svg')); assert.ok(!w.buildMessage('').includes('已作为图像内容提供'));
    });
    await check('local preview refuses unowned remote URLs or raw local paths', () => {
      for (const previewUrl of ['https://example.invalid/leak.png', 'file:///private/video.mp4', 'javascript:alert(1)']) {
        w.S.attachments = [{ id: 'unowned', name: 'private.mp4', kind: 'binary', previewUrl, path: 'C:/temp/private.mp4' }];
        w.renderAttachments(); tray.querySelector('.att-preview')?.click();
        assert.equal(d.querySelector('.attachment-preview-dialog video'), null);
      }
    });
  } finally { dom.window.close(); }

  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-attachment-http-'));
  const { createUploads } = await import('../server/uploads.js');
  const uploads = createUploads({ dataDir: world });
  const server = http.createServer((req, res) => uploads.handle(req, res, new URL(req.url, 'http://127.0.0.1')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const fixture of documentFiles()) await check('real upload preserves original bytes and reference: ' + fixture.name, async () => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/upload?name=${encodeURIComponent(fixture.name)}`, { method: 'POST', body: fixture.body });
      const result = await response.json(); assert.equal(result.ok, true); assert.equal(result.size, fixture.body.length);
      assert.deepEqual(fs.readFileSync(result.path), fixture.body); assert.ok(result.path.startsWith(world + path.sep));
      if (/\.(pdf|docx|md)$/.test(fixture.name)) { assert.equal(result.kind, 'text'); assert.ok(result.text.length > 0); }
      else { assert.equal(result.kind, 'binary'); assert.equal(result.error, undefined); }
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(world, { recursive: true, force: true }); }
  console.log(`Attachments: ${passed}/${passed + failed}; failed=${failed}; skipped=0`); process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
