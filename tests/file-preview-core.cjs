'use strict';
// Real registry/engines. jsdom proves DOM, bytes, authorization projection and
// lifecycle only; it is deliberately not screenshot, decode or sandbox proof.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { tinyPng } = require('./fixtures/attachment-files.cjs');
const dom = new JSDOM('<!doctype html><body><div id="toasts"></div></body>', { url: 'http://127.0.0.1/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'localStorage', 'sessionStorage', 'CustomEvent', 'DOMParser']) global[key] = key === 'window' ? dom.window : dom.window[key];
global.requestAnimationFrame = fn => setTimeout(fn, 0); global.cancelAnimationFrame = clearTimeout;
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
let clipboard = '';
Object.defineProperty(global.navigator, 'clipboard', { configurable: true, value: { async writeText(value) { clipboard = value; } } });
const imports = Promise.all([
  import('../public/file-preview/access.js'), import('../public/file-preview/relative.js'),
  import('../public/file-preview/index.js'), import('../public/file-preview/text.js'),
  import('../public/file-preview/markdown.js'), import('../public/file-preview/html.js'),
  import('../public/file-preview/html-style.js'), import('../public/api.js'), import('../public/ui/action-menu.js'),
]);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const until = async fn => { for (let i = 0; i < 150; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('preview state timeout'); };
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const utf8 = value => new Uint8Array(Buffer.from(value));
const clicked = (toolbar, label) => { const button = [...toolbar.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label); assert.ok(button, label); button.click(); return button; };
const readingAction = (toolbar, label) => {
  clicked(toolbar, '阅读选项');
  const menu = document.querySelector('[role="menu"][aria-label="阅读选项"]');
  assert.ok(menu, 'reading actions use the shared visible menu');
  const item = [...menu.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim().replace(/ ✓$/, '') === label);
  assert.ok(item && !item.disabled, label); item.click(); return item;
};
const fixtures = [];
function context(source, name, { state = {}, request = {}, relative } = {}) {
  const host = document.createElement('div'), toolbar = document.createElement('div'); document.body.append(toolbar, host);
  const abort = new AbortController(), owned = new Set(), urls = new Set(), reads = [], opens = [], errors = [];
  let disposed = false;
  const ctx = {
    host, toolbar, state, request: { path: `docs/${name}`, cwd: 'C:/fixture/project', name, ...request }, meta: { name, bytes: Buffer.byteLength(source) },
    resources: { signal: abort.signal, isCurrent: () => !disposed, own: fn => owned.add(fn), url(blob) { const url = URL.createObjectURL(blob); urls.add(url); return url; } },
    access: { async text() { return source; }, async bytes() { return utf8(source); }, async relative(href, cap) { reads.push({ href, cap }); if (relative) return relative(href, cap); return { bytes: new Uint8Array(tinyPng()), metadata: { name: href } }; } },
    resolve: href => /^https?:|^\/|^#/.test(href) ? null : { path: `docs/${href}`, cwd: 'C:/fixture/project', conversationId: null },
    open: request => opens.push(request), error: message => errors.push(message),
  };
  const f = { ctx, reads, opens, errors, dispose() { if (disposed) return; disposed = true; abort.abort(); for (const fn of owned) fn(); for (const url of urls) URL.revokeObjectURL(url); host.remove(); toolbar.remove(); } };
  fixtures.push(f); return f;
}
after(() => { for (const f of fixtures) f.dispose(); dom.window.close(); });

for (const [href, expected] of [
  ['./image.png', 'docs/image.png'], ['../README.md', 'README.md'], ['子目录/说明.md', 'docs/子目录/说明.md'],
  ['image%20one.png?cache=0#top', 'docs/image one.png'], ['nested\\file.txt', 'docs/nested/file.txt'],
]) test(`relative workspace path: ${href}`, async () => {
  const [, { relativeRequest }] = await imports;
  const next = relativeRequest({ path: 'docs/current.md', cwd: 'C:/fixture/project', fileId: 'OLD', conversationId: 'owner', workspace: { id: 'w' }, generation: 7, line: 3 }, href);
  assert.equal(next.path, expected); assert.equal(next.conversationId, 'owner'); assert.deepEqual(next.workspace, { id: 'w' });
  assert.equal(next.generation, 7); assert.ok(!('fileId' in next)); assert.ok(!('line' in next));
});
for (const href of ['../../secret.txt', '%2e%2e/%2e%2e/secret', '/etc/passwd', '\\server\\share', '//evil/path', 'https://evil/image.png', 'data:image/png,abc', 'javascript:bad()', '%00bad', '%2fsecret', 'C%3a%2fsecret', '%bad', 'a'.repeat(4097)]) test(`relative refusal: ${href.slice(0, 50)}`, async () => {
  const [, { relativeRequest }] = await imports;
  assert.equal(relativeRequest({ path: 'docs/current.md', cwd: 'C:/fixture/project' }, href), null);
});
test('absolute workspace, UNC and external directory bounds preserve existing authority', async () => {
  const [, { relativeRequest }] = await imports;
  assert.equal(relativeRequest({ path: 'C:/p/docs/a.md', cwd: 'c:/P' }, '../b.txt').path, 'C:/p/b.txt');
  assert.equal(relativeRequest({ path: 'C:/p/docs/a.md', cwd: 'c:/P' }, '../../b.txt'), null);
  assert.equal(relativeRequest({ path: '//server/share/a.md', external: true, grantId: 'g', fileId: 'old' }, '../x'), null);
  const next = relativeRequest({ path: '//server/share/docs/a.md', external: true, grantId: 'g' }, '../b.txt');
  assert.equal(next.path, '//server/share/b.txt'); assert.equal(next.grantId, 'g'); assert.equal(next.external, true);
  assert.equal(relativeRequest({ path: 'docs/a.md', source: 'attachment' }, 'b.txt'), null);
});

test('attachment bytes use the original File and never filesystem transport', async () => {
  const [{ createAccess }] = await imports;
  const file = new File(['hello 中文'], 'note.txt'); let calls = 0;
  const access = await createAccess({ source: 'attachment', file, name: file.name }, { metadata() { calls++; } });
  assert.equal(await access.text(1024), 'hello 中文'); assert.equal(calls, 0);
  await assert.rejects(access.readAll(2), { code: 'oversized' });
});
test('attachment and archive size/type budgets reject before allocation', async () => {
  const [{ createAccess }] = await imports;
  await assert.rejects(createAccess({ source: 'attachment', name: 'large.txt', file: { size: 5 * 1024 * 1024, slice() {}, arrayBuffer() { throw new Error('must not read'); } } }), { code: 'oversized' });
  await assert.rejects(createAccess({ source: 'archive', name: 'nested.zip', bytes: utf8('PK') }), { code: 'oversized' });
  await assert.rejects(createAccess({ source: 'archive', name: 'big.txt', bytes: new Uint8Array(9 * 1024 * 1024) }), { code: 'oversized' });
});
for (const [name, source] of [['table.csv', 'name,value\n中文,"quoted,cell"'], ['table.tsv', 'name\tvalue\n中文\t42']]) test('small ZIP tabular member crosses the same bounded access interface: ' + name, async () => {
  const [{ createAccess }] = await imports;
  const bytes = utf8(source); let transportCalls = 0;
  const access = await createAccess({ source: 'archive', name, bytes }, { metadata() { transportCalls++; }, content() { transportCalls++; } });
  assert.equal(access.type, 'office');
  assert.equal(await access.text(256 * 1024), source);
  assert.equal(access.budget, 256 * 1024);
  assert.equal(transportCalls, 0);
});
test('ZIP tabular allowance never permits nested Office archives HTML or oversized text', async () => {
  const [{ createAccess }] = await imports;
  for (const name of ['nested.zip', 'slides.pptx', 'document.docx', 'workbook.xlsx', 'page.html']) {
    await assert.rejects(createAccess({ source: 'archive', name, bytes: utf8('not authorized') }), { code: 'oversized' });
  }
  for (const name of ['big.csv', 'big.tsv', 'big.txt', 'big.md']) {
    await assert.rejects(createAccess({ source: 'archive', name, bytes: new Uint8Array(256 * 1024 + 1) }), { code: 'oversized' });
  }
});
test('literal member filenames cannot select a nested parser through a fragment-like suffix', async () => {
  const [{ createAccess, previewTypeFor }] = await imports;
  for (const name of ['nested.zip#safe.txt', 'slides.pptx#safe.txt', 'page.html#safe.txt']) {
    const access = await createAccess({ source: 'archive', name, bytes: utf8('literal text') });
    assert.equal(access.type, 'text');
    assert.equal(previewTypeFor(name), 'text');
  }
  const table = await createAccess({ source: 'archive', name: 'table#中文.csv', bytes: utf8('name,value\n中文,42') });
  assert.equal(table.type, 'office');
  assert.equal(previewTypeFor('literal#name.pdf'), 'pdf');
});
test('backend metadata is concrete, finite and cannot silently replace a restored object', async () => {
  const [{ createAccess }] = await imports;
  await assert.rejects(createAccess({ path: 'a.txt', fileId: 'old' }, { metadata: async () => ({ ok: true, file: { name: 'a.txt', bytes: 5, fileId: 'new' } }) }), { code: 'file_changed' });
  await assert.rejects(createAccess({ path: 'a.txt' }, { metadata: async () => ({ ok: true, file: { name: 'a.txt', bytes: Infinity } }) }), { code: 'metadata_unavailable' });
});
test('workspace reads repeat identity and exact bounded ranges', async () => {
  const [{ createAccess }] = await imports; const bytes = new Uint8Array(9 * 1024 * 1024); bytes.fill(12);
  const calls = [];
  const access = await createAccess({ path: 'a.pdf', cwd: 'C:/p', conversationId: 'c', workspace: { id: 'w' }, generation: 5 }, {
    metadata: async () => ({ ok: true, file: { name: 'a.pdf', bytes: bytes.length, fileId: 'object' } }),
    content: async (path, owner, opts) => { calls.push({ path, owner, opts }); const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(opts.range); return { ok: true, bytes: bytes.slice(+a, +b + 1), rangeStart: +a, rangeEnd: +b, rangeTotal: bytes.length }; },
  });
  assert.equal((await access.readAll(32 * 1024 * 1024)).length, bytes.length); assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.opts.range), ['bytes=0-8388607', 'bytes=8388608-9437183']);
  for (const call of calls) { assert.equal(call.opts.fileId, 'object'); assert.equal(call.owner, 'c'); assert.equal(call.opts.root, 'C:/p'); assert.equal(call.opts.generation, 5); }
});
test('range mismatches, truncation and abort after last awaited response fail closed', async () => {
  const [{ createAccess }] = await imports;
  const metadata = async () => ({ ok: true, file: { name: 'a.txt', bytes: 4, fileId: 'object' } });
  let access = await createAccess({ path: 'a.txt' }, { metadata, content: async () => ({ ok: true, bytes: utf8('1234'), rangeStart: 1, rangeEnd: 4, rangeTotal: 4 }) });
  await assert.rejects(access.readAll(10), { code: 'file_changed' });
  access = await createAccess({ path: 'a.txt' }, { metadata, content: async () => ({ ok: true, bytes: utf8('12') }) });
  await assert.rejects(access.readAll(10), { code: 'file_changed' });
  const abort = new AbortController();
  access = await createAccess({ path: 'a.txt' }, { metadata, content: async () => { abort.abort(); return { ok: true, bytes: utf8('1234') }; } }, abort.signal);
  await assert.rejects(access.readAll(10), { code: 'cancelled' });
});
test('external reads pass the existing grant and concrete fileId without workspace escalation', async () => {
  const [{ createAccess }] = await imports; let args;
  const access = await createAccess({ path: 'C:/outside/a.txt', external: true, grantId: 'existing-grant', conversationId: 'c' }, {
    externalMetadata: async () => ({ ok: true, file: { name: 'a.txt', bytes: 3, fileId: 'concrete' } }),
    externalContent: async (...value) => { args = value; return { ok: true, bytes: utf8('abc') }; },
  });
  assert.equal(await access.text(10), 'abc'); assert.deepEqual(args.slice(0, 4), ['C:/outside/a.txt', 'existing-grant', 'concrete', 'c']); assert.ok(!('root' in args[4]));
});
test('empty file does not issue an invalid Range', async () => {
  const [{ createAccess }] = await imports; let calls = 0;
  const access = await createAccess({ path: 'empty.txt' }, { metadata: async () => ({ ok: true, file: { name: 'empty.txt', bytes: 0, fileId: 'empty' } }), content() { calls++; } });
  assert.equal((await access.readAll(10)).length, 0); assert.equal(calls, 0);
});

test('source displays exact escaped rows, real numbers and syntax-spanning inclusive column selection', async () => {
  const [, , , text] = await imports; const source = 'const value = "<img onerror=alert(1)>";\nsecond\n';
  const f = context(source, 'a.js', { request: { line: 1, column: 1, endColumn: 11 } }); const engine = await text.mount(f.ctx);
  assert.equal([...f.ctx.host.querySelectorAll('.fp-text-source')].map(n => n.textContent).join('\n'), source);
  assert.deepEqual([...f.ctx.host.querySelectorAll('.fp-text-gutter')].map(n => n.textContent), ['1', '2', '3']);
  assert.equal(f.ctx.host.querySelectorAll('img,script').length, 0); assert.ok(f.ctx.host.querySelector('.tok-kw'));
  assert.equal(document.getSelection().toString(), 'const value');
  assert.equal(f.ctx.toolbar.querySelector('select,[aria-label="复制全文"],[aria-label="复制引用区间"],[aria-label="自动换行"],[aria-label="行号"]'), null);
  assert.ok(f.ctx.toolbar.querySelector('button.icon-btn[aria-label="阅读选项"]'));
  const selectedNode = document.getSelection().anchorNode;
  f.ctx.host.querySelector('.fp-text-scroll').dispatchEvent(new dom.window.Event('scroll'));
  assert.equal(document.getSelection().toString(), 'const value'); assert.equal(document.getSelection().anchorNode, selectedNode);
  readingAction(f.ctx.toolbar, '复制引用区间'); await tick(); assert.equal(clipboard, 'const value');
  readingAction(f.ctx.toolbar, '复制全文'); await tick(); assert.equal(clipboard, source); engine.dispose(); f.dispose();
});
test('source virtualizes large wrapped and unwrapped files, restores reading and searches without regex', async () => {
  const [, , , text] = await imports; const source = Array.from({ length: 20000 }, (_, i) => `line ${i + 1} [literal] 中文`).join('\n');
  const f = context(source, 'log.txt', { state: { scrollTop: 5000, scrollLeft: 22 }, request: { line: 2 } }); const engine = await text.mount(f.ctx);
  assert.equal(engine.getState().scrollTop, 5000); assert.equal(engine.getState().scrollLeft, 22);
  assert.ok(f.ctx.host.querySelectorAll('.fp-text-line').length <= 180);
  const search = f.ctx.toolbar.querySelector('input[type=search]'); search.value = '[literal]'; search.dispatchEvent(new dom.window.Event('input'));
  assert.match(f.ctx.toolbar.querySelector('.fp-text-count').textContent, /1\/10000\+/);
  readingAction(f.ctx.toolbar, '自动换行'); assert.ok(f.ctx.host.querySelector('.is-wrapped'));
  assert.ok(f.ctx.host.querySelectorAll('.fp-text-line').length <= 180);
  readingAction(f.ctx.toolbar, '隐藏行号'); assert.equal(engine.getState().lineNumbers, false); engine.dispose(); f.dispose();
});
test('text encoding selector actually decodes GB18030 source', async () => {
  const [, , , text] = await imports; const f = context('', 'encoded.txt');
  f.ctx.access.bytes = async () => new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]); const engine = await text.mount(f.ctx);
  assert.equal(f.ctx.host.querySelector('.fp-text-source').textContent, '中文');
  readingAction(f.ctx.toolbar, 'GB18030');
  assert.equal(engine.getState().encoding, 'gb18030'); assert.equal(f.errors.length, 0); engine.dispose(); f.dispose();
});
for (const endian of ['le', 'be']) test(`text auto and explicit UTF-16${endian.toUpperCase()} decode real byte fixtures`, async () => {
  const [, , , text] = await imports;
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文 A\n第二行', 'utf16le')]);
  if (endian === 'be') bytes.swap16();
  const f = context('', 'utf16.txt'); f.ctx.access.bytes = async () => new Uint8Array(bytes);
  const engine = await text.mount(f.ctx);
  const rendered = () => [...f.ctx.host.querySelectorAll('.fp-text-source')].map(n => n.textContent).join('\n');
  assert.equal(rendered(), '中文 A\n第二行');
  readingAction(f.ctx.toolbar, `UTF-16 ${endian.toUpperCase()}`);
  assert.equal(rendered(), '中文 A\n第二行'); assert.equal(engine.getState().encoding, `utf-16${endian}`); assert.deepEqual(f.errors, []);
  engine.dispose(); f.dispose();
});
test('disposed reading menus cannot execute retained actions or close another surface menu', async () => {
  const [, , , text, , , , , menus] = await imports;
  const f = context('private former document', 'former.txt'); await text.mount(f.ctx);
  clicked(f.ctx.toolbar, '阅读选项');
  const staleCopy = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === '复制全文');
  assert.ok(staleCopy);
  const anchor = document.createElement('button'); document.body.append(anchor);
  menus.openActionMenu(anchor, [{ label: 'Other surface', onClick() {} }]);
  f.dispose(); assert.equal(menus.actionMenuOpen(), true);
  clipboard = 'current document'; staleCopy.click(); await tick();
  assert.equal(clipboard, 'current document', 'a disposed document no longer owns a clipboard action');
  assert.equal(menus.actionMenuOpen(), true, 'a stale item must not dismiss another surface menu');
  menus.closeActionMenu(); anchor.remove();
});
test('restored HTML static mode has the correct accessible action and returns to source', async () => {
  const [, , , , , html] = await imports;
  const f = context('<p>restored document</p>', 'restored.html', { state: { rendered: true, scrollTop: 41 } });
  const engine = await html.mount(f.ctx);
  assert.ok(f.ctx.host.querySelector('iframe'));
  const toggle = clicked(f.ctx.toolbar, '查看源码');
  assert.equal(toggle.textContent, '切换到静态预览');
  assert.equal(f.ctx.host.querySelector('iframe'), null);
  assert.equal(engine.getState().rendered, false);
  assert.equal(engine.getState().scrollTop, 41);
  engine.dispose(); f.dispose();
});
test('binary classification remains explicit for legacy transport and actual binary text bytes', async () => {
  const [{ createAccess }, , , text] = await imports;
  const access = await createAccess({ path: 'unknown.dat', bytes: 2 }, { document: async () => ({ ok: true, file: { binary: true } }) });
  await assert.rejects(access.readAll(10), { code: 'binary_text' });
  for (const throws of [true, false]) {
    const f = context('', 'unknown.dat'); f.ctx.access.bytes = async () => { if (throws) throw Object.assign(new Error('binary_text'), { code: 'binary_text' }); return new Uint8Array([0, 1]); };
    const engine = await text.mount(f.ctx); assert.match(f.errors[0], /二进制/); engine.dispose(); f.dispose();
  }
});
test('document headings opt in without changing compact chat hierarchy or raw HTML escaping', async () => {
  const { md } = await import('../public/markdown.js');
  assert.equal(md('# Title\n\n###### Last'), '<h4>Title</h4><h4>Last</h4>');
  assert.equal(md('# Title\n\n###### Last', { documentHeadings: true, headingIds: true }), '<h1 id="title">Title</h1><h6 id="last">Last</h6>');
  assert.ok(!md('# <img src=x onerror=bad()>', { documentHeadings: true }).includes('<img'));
});
test('Markdown keeps code literal, renders formula/table/TOC and controlled images without remote reads', async () => {
  const [, , , , markdown] = await imports;
  const source = '# Heading\n\n## Child\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nText $x^2$ end.\n\n`![inline](inline.png) $code$`\n\n```md\n![code](code.png) $code$\n```\n\n![local](picture.png)\n\n![remote](https://evil.example/image.png)\n\n<script>bad()</script>';
  const f = context(source, 'readme.md'); const engine = await markdown.mount(f.ctx);
  assert.equal(f.errors.length, 0); assert.ok(f.ctx.host.querySelector('table')); assert.equal(f.ctx.host.querySelectorAll('.fp-md-toc-link').length, 2);
  assert.ok(f.ctx.host.querySelector('.katex')); assert.equal(f.ctx.host.querySelectorAll('.fp-markdown-image').length, 1);
  assert.deepEqual(f.reads.map(r => r.href), ['picture.png']); assert.match(f.ctx.host.querySelector('pre').textContent, /!\[code\]\(code.png\) \$code\$/);
  assert.equal(f.ctx.host.querySelectorAll('script,iframe').length, 0); assert.match(f.ctx.host.textContent, /<script>bad\(\)<\/script>/);
  const search = f.ctx.toolbar.querySelector('input'); search.value = 'Heading'; search.dispatchEvent(new dom.window.Event('input'));
  assert.equal(f.ctx.host.querySelectorAll('mark.fp-md-hit').length, 1); assert.equal(f.reads.length, 1);
  engine.dispose(); f.dispose();
});
test('Markdown relative links freshly project descriptors; authored marker strings remain literal', async () => {
  const [, , , , markdown] = await imports;
  const f = context('MDIMAGE0TOKEN \ue000FP0\ue001\n\n[Next](next.md)', 'a.md'); const engine = await markdown.mount(f.ctx);
  f.ctx.host.querySelector('a').click(); assert.equal(f.opens[0].path, 'docs/next.md'); assert.equal(f.reads.length, 0);
  assert.match(f.ctx.host.textContent, /MDIMAGE0TOKEN/); assert.match(f.ctx.host.textContent, /\ue000FP0\ue001/); engine.dispose(); f.dispose();
});
test('Markdown disposed during an awaited relative image never adopts a late URL', async () => {
  const [, , , , markdown] = await imports; const waiting = defer(); let urls = 0;
  const f = context('![local](a.png)', 'a.md', { relative: () => waiting.promise }); f.ctx.resources.url = () => { urls++; return 'blob:late'; };
  const mounting = markdown.mount(f.ctx); await until(() => f.reads.length === 1); f.dispose(); waiting.resolve({ bytes: new Uint8Array(tinyPng()) });
  await mounting; assert.equal(urls, 0);
});
test('HTML renders only sanitized content in an opaque CSP frame, with cached authorized relative resources', async () => {
  const [, , , , , html] = await imports;
  const source = '<style>p{color:red;background-image:url(https://evil/x)}</style><link rel="stylesheet" href="local.css"><script>fetch("https://evil")</script><iframe src="https://evil"></iframe><form action="/api"><input></form><a href="https://evil">link</a><p onclick="bad()">Safe</p><img src="local.png" onerror="bad()"><img src="https://evil/image.png">';
  const f = context(source, 'a.html', { relative: async href => ({ bytes: href.endsWith('.css') ? utf8('p { font-weight:700; background:url(https://evil) }') : new Uint8Array(tinyPng()) }) });
  const engine = await html.mount(f.ctx); assert.equal(f.ctx.host.querySelector('iframe'), null);
  clicked(f.ctx.toolbar, '切换到静态预览'); await until(() => f.ctx.host.querySelector('iframe'));
  let frame = f.ctx.host.querySelector('iframe'), srcdoc = frame.srcdoc;
  assert.equal(frame.getAttribute('sandbox'), ''); assert.equal(frame.referrerPolicy || frame.getAttribute('referrerpolicy'), 'no-referrer');
  assert.match(srcdoc, /script-src 'none'/); assert.match(srcdoc, /connect-src 'none'/); assert.match(srcdoc, /form-action 'none'/);
  assert.doesNotMatch(srcdoc, /navigate-to/, 'unsupported CSP directives must not masquerade as navigation protection');
  const contents = new JSDOM(srcdoc).window.document;
  assert.equal(contents.querySelectorAll('script,iframe,form,input,a[href],img[src^="http"]').length, 0);
  assert.equal(contents.querySelectorAll('img[src^="data:image/png;base64,"]').length, 1);
  assert.deepEqual(Buffer.from(contents.querySelector('img[src]').src.split(',')[1], 'base64'), tinyPng()); assert.match(srcdoc, /font-weight:700/); assert.ok(!srcdoc.includes('background:url'));
  assert.deepEqual(f.reads.map(r => r.href), ['local.css', 'local.png']);
  clicked(f.ctx.toolbar, '查看源码'); clicked(f.ctx.toolbar, '切换到静态预览'); await until(() => f.ctx.host.querySelector('iframe'));
  assert.equal(f.reads.length, 2); engine.dispose(); assert.equal(f.ctx.host.querySelector('iframe'), null); f.dispose();
});
test('HTML static preview cannot cache an empty document while source reading is pending', async () => {
  const [, , , , , html] = await imports, waiting = defer();
  const f = context('<p>delayed HTML body</p>', 'delayed.html');
  f.ctx.access.text = () => waiting.promise;
  const mounting = html.mount(f.ctx);
  const toggle = [...f.ctx.toolbar.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '切换到静态预览');
  assert.equal(toggle.disabled, true);
  toggle.click(); await tick(); assert.equal(f.ctx.host.querySelector('iframe'), null);
  waiting.resolve('<p>delayed HTML body</p>'); const engine = await mounting;
  assert.equal(toggle.disabled, false);
  toggle.click(); await until(() => f.ctx.host.querySelector('iframe'));
  assert.match(f.ctx.host.querySelector('iframe').srcdoc, /delayed HTML body/);
  engine.dispose(); f.dispose();
});
test('HTML disposed during a pending source read never enables stale preview controls', async () => {
  const [, , , , , html] = await imports, waiting = defer();
  const f = context('<p>retired HTML</p>', 'retired.html');
  f.ctx.access.text = () => waiting.promise;
  const mounting = html.mount(f.ctx);
  const toggle = [...f.ctx.toolbar.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '切换到静态预览');
  f.dispose(); waiting.resolve('<p>retired HTML</p>'); await mounting;
  assert.equal(toggle.disabled, true); toggle.click(); await tick();
  assert.equal(f.ctx.host.querySelector('iframe'), null);
});
test('HTML toggle races cannot append a late frame to source mode', async () => {
  const [, , , , , html] = await imports; const waiting = defer();
  const f = context('<img src="local.png">', 'a.html', { relative: () => waiting.promise }); const engine = await html.mount(f.ctx);
  clicked(f.ctx.toolbar, '切换到静态预览'); await until(() => f.reads.length === 1); clicked(f.ctx.toolbar, '查看源码');
  waiting.resolve({ bytes: new Uint8Array(tinyPng()) }); await tick(); await tick(); assert.equal(f.ctx.host.querySelector('iframe'), null); engine.dispose(); f.dispose();
});
for (const attack of ['url(https://evil)', 'u\\72l(https://evil)', 'expression(alert(1))', 'var(--remote)', 'image-set("https://evil")', '</style><script>bad()</script>', 'attr(data-secret)', 'paint(x)']) test(`static CSS rejects active value: ${attack}`, async () => {
  const [, , , , , , { safeDocumentCss }] = await imports;
  const result = safeDocumentCss(`p{color:${attack};background-image:${attack}}`); assert.equal(result, '');
});
test('static CSS retains bounded ordinary document layout without imports or fixed overlays', async () => {
  const [, , , , , , { safeDocumentCss }] = await imports;
  assert.equal(safeDocumentCss('p {color:#123;position:fixed;display:flex;gap:8px}'), 'p{color:#123;display:flex;gap:8px}');
  assert.equal(safeDocumentCss('@import "https://evil";'), ''); assert.equal(safeDocumentCss('x'.repeat(256 * 1024 + 1)), '');
});
test('real registry mounts original File text, toggles Markdown source and disposes cleanly', async () => {
  const [, , { mountFilePreview }] = await imports;
  const host = document.createElement('div'), toolbar = document.createElement('div'); document.body.append(toolbar, host);
  const controller = mountFilePreview(host, { source: 'attachment', file: new File(['# Title\n\nText'], 'a.md'), name: 'a.md' }, { toolbar });
  assert.equal(typeof controller.dispose, 'function'); await controller.ready; assert.ok(host.querySelector('h1'), host.innerHTML);
  clicked(toolbar, '源码'); await until(() => host.querySelector('.fp-text-source')); assert.equal(controller.getState().rendered, false);
  clicked(toolbar, '渲染视图'); await until(() => host.querySelector('h1')); assert.equal(controller.getState().rendered, true);
  controller.dispose(); assert.equal(host.childElementCount, 0); assert.equal(toolbar.childElementCount, 0); host.remove(); toolbar.remove();
});
test('registry late metadata after disposal cannot mount or call metadata callbacks', async () => {
  const [, , { mountFilePreview }] = await imports; const waiting = defer(); let callbacks = 0;
  const host = document.createElement('div'); document.body.append(host);
  const controller = mountFilePreview(host, { path: 'a.txt' }, { transport: { metadata: () => waiting.promise }, onMetadata() { callbacks++; } });
  controller.dispose(); waiting.resolve({ ok: true, file: { name: 'a.txt', fileId: 'object', bytes: 2 } }); await controller.ready;
  assert.equal(callbacks, 0); assert.equal(host.childElementCount, 0); host.remove();
});
test('disposing a reader does not close another surface action menu', async () => {
  const [, , { mountFilePreview }, , , , , , menus] = await imports;
  const host = document.createElement('div'), anchor = document.createElement('button'); document.body.append(host, anchor);
  const controller = mountFilePreview(host, { source: 'attachment', file: new File(['text'], 'a.txt'), name: 'a.txt' }); await controller.ready;
  menus.openActionMenu(anchor, [{ label: 'Other surface', onClick() {} }]); controller.dispose(); assert.equal(menus.actionMenuOpen(), true);
  menus.closeActionMenu(); host.remove(); anchor.remove();
});
for (const [name, bytes] of [['legacy.doc', 1024], ['huge.txt', 5 * 1024 * 1024]]) test(`fallback keeps fresh metadata and existing safe actions without reading ${name}`, async () => {
  const [, , { mountFilePreview }, , , , , , menus] = await imports;
  const host = document.createElement('div'), toolbar = document.createElement('div'); document.body.append(host, toolbar);
  let reads = 0, metadata = null;
  const controller = mountFilePreview(host, { path: `docs/${name}`, cwd: 'C:/p' }, { toolbar, onMetadata(value) { metadata = value; }, transport: {
    metadata: async () => ({ ok: true, file: { name, bytes, fileId: 'fresh-object' } }), content() { reads++; throw new Error('must not read'); },
  } });
  await controller.ready; assert.equal(reads, 0); assert.equal(metadata.fileId, 'fresh-object'); assert.match(host.querySelector('.fp-fallback-meta').textContent, new RegExp(name.replace('.', '\\.')));
  assert.ok(host.querySelector('.files-preview-open')); clicked(toolbar, '文件操作'); assert.equal(menus.actionMenuOpen(), true);
  assert.ok(document.body.textContent.includes('在文件管理器中显示')); controller.dispose(); assert.equal(menus.actionMenuOpen(), false); host.remove(); toolbar.remove();
});
test('API streams bounded bytes, parses Content-Range and carries explicit identity', async () => {
  const [, , , , , , , api] = await imports; const original = global.fetch; let captured;
  try {
    global.fetch = async (url, options) => { captured = { url, options }; return new Response(utf8('abcd'), { status: 206, headers: { 'Content-Range': 'bytes 0-3/4', 'Content-Length': '4' } }); };
    const result = await api.fetchFilePreviewContent('docs/a.txt', 'conversation', { root: 'C:/p', fileId: 'object', range: 'bytes=0-3', workspace: { id: 'w' }, generation: 2 });
    assert.equal(result.ok, true); assert.equal(Buffer.from(result.bytes).toString(), 'abcd'); assert.equal(result.rangeStart, 0); assert.equal(result.rangeEnd, 3); assert.equal(result.rangeTotal, 4);
    assert.equal(captured.options.headers.Range, 'bytes=0-3'); assert.ok(captured.url.includes('fileId=object')); assert.ok(captured.url.includes('conversation=conversation'));
    assert.match(api.filePreviewMediaUrl({ path: 'a.wav', cwd: 'C:/p', fileId: 'object' }), /root=C%3A%2Fp/);
  } finally { global.fetch = original; }
});
test('API refuses absent ranges and cancels oversized streaming bodies before full retention', async () => {
  const [, , , , , , , api] = await imports; const original = global.fetch; let cancelled = false;
  try {
    global.fetch = async () => new Response('text', { status: 200 });
    assert.equal((await api.fetchFilePreviewContent('a.txt', null, { range: 'bytes=0-3' })).code, 'file_changed');
    global.fetch = async () => ({ ok: true, status: 206, headers: new Headers(), body: { getReader() { let n = 0; return { async read() { return n++ < 2 ? { value: new Uint8Array(5 * 1024 * 1024), done: false } : { done: true }; }, async cancel() { cancelled = true; }, releaseLock() {} }; } } });
    assert.equal((await api.fetchFilePreviewContent('a.pdf', null, { range: 'bytes=0-3' })).code, 'oversized'); assert.equal(cancelled, true);
  } finally { global.fetch = original; }
});
