/* Unified attachment entries and their ownership/lifecycle. The real Files
 * panel receives original Files through a controller spy; format decoding is
 * tested by the plugin suites, never faked here. No writes/network/Pi/models. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { tinyPng, tinyBmp, minimalPdf, TINY_PNG_BASE64 } = require('./fixtures/attachment-files.cjs');
const text = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const dom = new JSDOM(text, { url: 'http://fixture.invalid/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'localStorage', 'sessionStorage', 'CustomEvent', 'MutationObserver']) {
  global[key] = key === 'window' ? dom.window : dom.window[key];
}
global.requestAnimationFrame = fn => setTimeout(fn, 0);
global.cancelAnimationFrame = clearTimeout;
const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL, originalAtob = global.atob, originalFetch = global.fetch;
const created = [], revoked = [], opens = [], views = [];
let decodeCalls = 0, transportReads = 0, passed = 0, failed = 0;
URL.createObjectURL = file => { const url = `blob:fixture-${created.length}`; created.push({ url, file }); return url; };
URL.revokeObjectURL = url => revoked.push(url);
global.atob = value => { decodeCalls++; return originalAtob(value); };
global.fetch = async () => { throw new Error('Unexpected network request'); };
async function check(name, run) {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack); }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const imagePart = (data = TINY_PNG_BASE64, name = 'same.png', mimeType = 'image/png') => ({ type: 'image', data, name, mimeType });

(async () => {
  const { S, el } = await import('../public/state.js');
  const { setGitConversationScope } = await import('../public/api.js');
  const { runtimeStore, seedRuntimeSnapshot } = await import('../public/runtime-state.js');
  const { mountFilesPanel } = await import('../public/files-panel.js');
  const { renderAttachments, removeAttachment } = await import('../public/attachments.js');
  const { userBody } = await import('../public/ui/user-message-body.js');
  const preview = await import('../public/attachment-preview.js');
  Object.assign(S, { cwd: 'C:/fixture/project', workspaceGeneration: 1, attachments: [], state: { sessionId: 'entry-session', model: { input: ['text', 'image'] } } });
  const tray = el.attachTray;
  const panelHost = document.createElement('section'); document.body.append(panelHost);
  let alive = true; const hooks = [];
  const view = { isCurrent: () => alive, onDispose(fn) { hooks.push(fn); }, dispose() { if (!alive) return; alive = false; hooks.reverse().forEach(fn => fn()); } };
  const forbiddenRead = async () => { transportReads++; throw new Error('An attachment must never read a local path'); };
  mountFilesPanel(panelHost, view, {
    transport: {
      list: async () => ({ ok: true, workspace: { id: 'fixture', generation: '1' }, entries: [] }),
      metadata: forbiddenRead, document: forbiddenRead, asset: forbiddenRead, content: forbiddenRead,
      externalMetadata: forbiddenRead, externalDocument: forbiddenRead, externalContent: forbiddenRead,
    },
    previewMount(host, request) {
      const entry = { request, disposed: false }; opens.push(entry); views.push(entry);
      host.textContent = request.name;
      return { ready: Promise.resolve(), getState: () => ({}), dispose() { entry.disposed = true; host.replaceChildren(); } };
    },
  });
  await tick();
  const show = attachments => { S.attachments = attachments; renderAttachments(); };
  const historical = parts => { const body = userBody({ role: 'user', content: parts }); document.body.append(body); return body; };
  const fileAttachment = (id, file, extra = {}) => ({ id, file, name: file.name, size: file.size, kind: 'binary', path: 'C:/must-not-read/' + file.name, ...extra });
  try {
    await check('historical MIME is an exact allowlist, not a PNG default or executable data URL', () => {
      const before = decodeCalls;
      for (const mime of ['', undefined, 'image/svg+xml', 'text/html', 'image/PNG', 'image/png;foo=bar', 'image/png\n', '__proto__']) {
        assert.equal(preview.imagePreviewData(TINY_PNG_BASE64, mime), null, String(mime));
      }
      assert.equal(decodeCalls, before);
    });
    await check('encoded/raw/decoded size and malformed base64 are rejected before atob', () => {
      const before = decodeCalls, max = Math.ceil(8 * 1024 * 1024 / 3) * 4;
      for (const encoded of ['', 'A', 'AA=A', 'AAAA====', 'AAAA<script>', TINY_PNG_BASE64 + ' ', 'A'.repeat(max), 'A'.repeat(max + 4), '\n'.repeat(max + 1)]) {
        assert.equal(preview.imagePreviewData(encoded, 'image/png'), null);
        assert.equal(preview.imagePreviewFile({ encoded, mimeType: 'image/png' }), null);
      }
      assert.equal(decodeCalls, before);
    });
    await check('real PNG bytes become a bounded immutable File with a MIME-compatible name', async () => {
      const data = preview.imagePreviewData(TINY_PNG_BASE64, 'image/png');
      const file = preview.imagePreviewFile(data, 'misleading.txt');
      assert.equal(file.type, 'image/png'); assert.equal(file.name, 'misleading.txt.png');
      assert.equal(file.size, tinyPng().length);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), tinyPng());
    });
    await check('draft data URLs use the same strict gate and never accept previewUrl/path', () => {
      assert.equal(preview.localPreviewSource({ dataUrl: `data:image/png;base64,${TINY_PNG_BASE64}` }), `data:image/png;base64,${TINY_PNG_BASE64}`);
      for (const value of ['https://fixture.invalid/image.png', 'file:///private/image.png', 'data:image/svg+xml;base64,' + TINY_PNG_BASE64, 'data:image/png;charset=utf-8;base64,' + TINY_PNG_BASE64]) {
        assert.equal(preview.localPreviewSource({ dataUrl: value, previewUrl: value, path: value }), '');
      }
    });
    await check('ordinary files delegate only the exact original File, never their server path', () => {
      const file = new File(['plain original'], 'notes.txt', { type: 'text/plain' });
      const attachment = fileAttachment('plain', file);
      show([attachment]); const button = tray.querySelector('.att-info'); button.click();
      assert.equal(button.tagName, 'BUTTON'); assert.equal(button.getAttribute('aria-controls'), 'rightPane');
      assert.equal(opens.at(-1).request.file, file);
      assert.equal(opens.at(-1).request.source, 'attachment');
      assert.equal(opens.at(-1).request.path, undefined);
      assert.equal(transportReads, 0);
      assert.equal(document.getElementById('modal').hidden, true);
    });
    await check('parse-error PDFs retain the original readable File and their visible error', () => {
      const file = new File([minimalPdf()], 'report.pdf', { type: 'application/pdf' });
      show([fileAttachment('pdf', file, { error: '无法提取文字，保留原文件' })]);
      tray.querySelector('.att-info').click();
      assert.equal(opens.at(-1).request.file, file);
      assert.ok(tray.textContent.includes('无法提取文字'));
      assert.equal(transportReads, 0);
    });
    await check('loading and failed file uploads cannot acquire a preview button or dispatch', () => {
      const before = opens.length, file = new File(['pending'], 'pending.txt');
      for (const extra of [{ loading: true }, { uploadFailed: true, error: '上传失败' }]) {
        show([fileAttachment('pending', file, extra)]);
        const info = tray.querySelector('.att-info'); info.click();
        assert.equal(info.tagName, 'DIV'); assert.equal(info.tabIndex, -1);
      }
      assert.equal(opens.length, before);
    });
    await check('image thumbnail uses an owned URL but unified preview receives its original File', () => {
      const file = new File([tinyPng()], 'pixel.png', { type: 'image/png' });
      const attachment = fileAttachment('image', file, { kind: 'image', mimeType: 'image/png' });
      preview.prepareAttachmentPreview(attachment, file, 'image', () => {});
      show([attachment]); const button = tray.querySelector('.att-preview'); button.click();
      assert.equal(button.disabled, false);
      assert.equal(opens.at(-1).request.file, file);
      assert.equal(opens.at(-1).request.path, undefined);
      assert.equal(created.at(-1).file, file);
      assert.equal(transportReads, 0);
    });
    await check('preview remains available from File when optional thumbnail creation is unavailable', () => {
      const file = new File([tinyBmp()], 'pixel.bmp', { type: 'image/bmp' });
      const attachment = fileAttachment('no-thumb', file, { mimeType: 'image/bmp' });
      const create = URL.createObjectURL;
      try { URL.createObjectURL = () => { throw new Error('unsupported'); }; preview.prepareAttachmentPreview(attachment, file, 'image', () => {}); }
      finally { URL.createObjectURL = create; }
      show([attachment]); const button = tray.querySelector('.att-preview'); button.click();
      assert.equal(button.disabled, false); assert.equal(opens.at(-1).request.file, file);
    });
    await check('removing an open ordinary attachment revokes its tab even without a thumbnail resource', () => {
      const file = new File(['remove'], 'remove.txt');
      show([fileAttachment('remove', file)]); tray.querySelector('.att-info').click();
      const opened = opens.at(-1); removeAttachment('remove');
      assert.equal(opened.disposed, true);
      assert.equal(panelHost.querySelectorAll('.files-tab[data-file-tab="remove.txt"]').length, 0);
      assert.equal(tray.hidden, true);
    });
    await check('detached or removed tray controls cannot resurrect a removed File', () => {
      const file = new File(['removed'], 'removed.txt');
      show([fileAttachment('removed', file)]); const button = tray.querySelector('.att-info');
      removeAttachment('removed'); const before = opens.length; button.click();
      assert.equal(opens.length, before);
    });
    for (const event of ['pi-gui:workspace-generation', 'pi-gui:session-switch', 'pi-gui:git-scope']) {
      await check(event + ' invalidates retained tray callbacks even if the old object is reinserted', () => {
        const file = new File(['old'], 'old.txt'), attachment = fileAttachment('old', file);
        show([attachment]); const button = tray.querySelector('.att-info');
        document.dispatchEvent(new CustomEvent(event));
        S.attachments = [attachment]; // Isolate the owner guard from membership.
        const before = opens.length; button.click(); assert.equal(opens.length, before);
        renderAttachments(); tray.querySelector('.att-info').click();
        assert.equal(opens.at(-1).request.file, file);
      });
    }
    await check('two historical images named alike get distinct File/tab identities and exact bytes', async () => {
      const bmp = tinyBmp();
      const body = historical([imagePart(), imagePart(bmp.toString('base64'), 'same.png', 'image/bmp')]);
      const [first, second] = body.querySelectorAll('.msg-att-chip');
      first.click(); const left = opens.at(-1).request;
      second.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const right = opens.at(-1).request;
      assert.notEqual(left.attachmentId, right.attachmentId);
      assert.notEqual(left.file, right.file);
      assert.deepEqual(Buffer.from(await left.file.arrayBuffer()), tinyPng());
      assert.deepEqual(Buffer.from(await right.file.arrayBuffer()), bmp);
      assert.equal(left.path, undefined); assert.equal(right.path, undefined);
      first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
      assert.equal(opens.at(-1).request.file, left.file);
      assert.equal(opens.at(-1).request.attachmentId, left.attachmentId);
      body.remove();
    });
    await check('historical image snapshots cannot change to later mutated ImageContent', async () => {
      const part = imagePart(), body = historical([part]);
      part.data = tinyBmp().toString('base64'); part.mimeType = 'image/bmp';
      body.querySelector('.msg-att-chip').click();
      assert.deepEqual(Buffer.from(await opens.at(-1).request.file.arrayBuffer()), tinyPng());
      body.remove();
    });
    await check('malformed/oversized/unknown-MIME history stays inert before browser source or atob', () => {
      const before = decodeCalls;
      const body = historical([imagePart(TINY_PNG_BASE64, 'x.svg', 'image/svg+xml'), imagePart('A'.repeat(11_184_816)), imagePart('not base64')]);
      for (const chip of body.querySelectorAll('.msg-att-chip')) {
        assert.equal(chip.tabIndex, -1); assert.equal(chip.getAttribute('role'), null);
        assert.equal(chip.querySelector('img').hasAttribute('src'), false); chip.click();
      }
      assert.equal(decodeCalls, before); body.remove();
    });
    await check('a retained history node cannot be reused in a new conversation', () => {
      const body = historical([imagePart()]), old = body.querySelector('.msg-att-chip');
      setGitConversationScope('different-conversation');
      const before = opens.length; old.click(); assert.equal(opens.length, before);
      const fresh = historical([imagePart()]); fresh.querySelector('.msg-att-chip').click();
      assert.equal(opens.at(-1).request.conversationId, 'different-conversation');
      assert.notEqual(opens.at(-1).request.attachmentId, old.id);
      body.remove(); fresh.remove(); setGitConversationScope(null);
    });
    await check('Runtime container ownership is checked, not inferred from current global focus', () => {
      const wrapper = document.createElement('section'); wrapper.dataset.conversationId = 'not-focused';
      const body = userBody({ content: [imagePart()] }); wrapper.append(body); document.body.append(wrapper);
      const before = opens.length; body.querySelector('.msg-att-chip').click();
      assert.equal(opens.length, before); wrapper.remove();
    });
    const runtimeId = 'entry-runtime';
    const seedRuntime = (sessionId, revision) => seedRuntimeSnapshot({ backendInstance: 'entry-backend', items: [{
      conversationId: runtimeId, createdAt: '2026-11-25T00:00:00.000Z', revision, nativeSessionId: sessionId,
      workspace: { projectId: 'entry-project', cwd: 'C:/fixture/runtime' }, lifecycle: 'ready', activity: 'idle', attention: false, error: null, stop: null,
      owner: { backendInstance: 'entry-backend', projectId: 'entry-project', repoId: 'entry-repo', workspaceId: 'entry-workspace', workspaceEpoch: '1',
        conversationId: runtimeId, runtimeId: 'entry-process', runtimeGeneration: '1', sessionId },
    }] });
    await check('returning to the same Runtime owner reuses retained history despite a different Classic session', async () => {
      seedRuntime('native-entry-one', 1); setGitConversationScope(runtimeId);
      assert.equal(runtimeStore.get(runtimeId).owner.sessionId, 'native-entry-one');
      const wrapper = document.createElement('section'); wrapper.dataset.conversationId = runtimeId;
      const body = userBody({ content: [imagePart()] }); wrapper.append(body); document.body.append(wrapper);
      const chip = body.querySelector('.msg-att-chip'); chip.click(); const first = opens.at(-1).request;
      setGitConversationScope(null); const before = opens.length; chip.click(); assert.equal(opens.length, before);
      const classic = S.state.sessionId;
      try {
        S.state.sessionId = 'unrelated-classic-session'; setGitConversationScope(runtimeId); chip.click();
        assert.equal(opens.at(-1).request.attachmentId, first.attachmentId);
        assert.equal(opens.at(-1).request.file, first.file);
        assert.equal(opens.at(-1).request.conversationId, runtimeId);
        assert.deepEqual(Buffer.from(await opens.at(-1).request.file.arrayBuffer()), tinyPng());
      } finally { wrapper.remove(); S.state.sessionId = classic; setGitConversationScope(null); }
    });
    await check('changing a Runtime native session invalidates both old history and old draft callbacks', () => {
      setGitConversationScope(runtimeId);
      const body = historical([imagePart()]), old = body.querySelector('.msg-att-chip');
      const file = new File(['runtime draft'], 'runtime.txt'), attachment = fileAttachment('runtime-owner', file);
      show([attachment]); const button = tray.querySelector('.att-info');
      seedRuntime('native-entry-two', 2);
      const before = opens.length; old.click(); button.click(); assert.equal(opens.length, before);
      const fresh = historical([imagePart()]); fresh.querySelector('.msg-att-chip').click();
      assert.equal(opens.at(-1).request.conversationId, runtimeId);
      renderAttachments(); tray.querySelector('.att-info').click(); assert.equal(opens.at(-1).request.file, file);
      body.remove(); fresh.remove(); setGitConversationScope(null);
    });
    await check('Classic session identity changes refuse retained history even without an event', () => {
      const body = historical([imagePart()]), before = opens.length, session = S.state.sessionId;
      try { S.state.sessionId = 'different-classic'; body.querySelector('.msg-att-chip').click(); assert.equal(opens.length, before); }
      finally { S.state.sessionId = session; body.remove(); }
    });
    await check('Runtime focus binds the preview scope before synchronous message rendering', () => {
      const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
      const start = source.indexOf('const focusRuntimeConversation = conversationId => {');
      assert.ok(start >= 0);
      const focus = source.slice(start, source.indexOf('\n};', start));
      const scope = focus.indexOf('setGitConversationScope(conversationId)'), render = focus.indexOf('runtimeConversation.show(conversationId)');
      assert.ok(scope >= 0 && render > scope, 'image callbacks must capture the conversation being drawn, not the previously focused owner');
    });
    await check('workspace generation changes also invalidate history without a lifecycle event', () => {
      const body = historical([imagePart()]), before = opens.length;
      S.workspaceGeneration++; body.querySelector('.msg-att-chip').click();
      assert.equal(opens.length, before); body.remove();
    });
    await check('legacy local ImageContent is bounded and converted without reading its local path', async () => {
      const attachment = { id: 'legacy', name: 'legacy.png', kind: 'image', size: tinyPng().length,
        dataUrl: `data:image/png;base64,${TINY_PNG_BASE64}`, path: 'C:/must-not-read/legacy.png' };
      show([attachment]); tray.querySelector('.att-preview').click();
      assert.equal(opens.at(-1).request.source, 'attachment');
      assert.deepEqual(Buffer.from(await opens.at(-1).request.file.arrayBuffer()), tinyPng());
      assert.equal(transportReads, 0);
    });
    for (const name of ['send.txt', 'send.pdf', 'send.docx', 'send.zip']) {
      await check('send/reset reconciliation revokes an ordinary File preview without a thumbnail: ' + name, () => {
        const file = new File(['owner lifetime only; no format parsing in this spy'], name);
        const attachment = fileAttachment('send-' + name, file);
        const urlCount = created.length;
        show([attachment]); tray.querySelector('.att-info').click(); const opened = opens.at(-1);
        assert.equal(opened.request.file, file);
        show([]);
        assert.equal(opened.disposed, true);
        assert.equal(panelHost.querySelectorAll(`[data-file-tab="${name}"]`).length, 0);
        assert.equal(created.length, urlCount, 'ordinary owners need no thumbnail URL');
        assert.equal(transportReads, 0);
      });
    }
    await check('send/reset reconciliation revokes preview URLs and the corresponding live controller', () => {
      const file = new File([tinyPng()], 'reconcile.png', { type: 'image/png' });
      const attachment = fileAttachment('reconcile', file, { mimeType: 'image/png' });
      preview.prepareAttachmentPreview(attachment, file, 'image', () => {}); const url = preview.localPreviewSource(attachment);
      show([attachment]); tray.querySelector('.att-preview').click(); const opened = opens.at(-1);
      show([]);
      assert.ok(revoked.includes(url)); assert.equal(opened.disposed, true);
      assert.equal(preview.localPreviewSource(attachment), ''); assert.equal(transportReads, 0);
    });
    await check('disposing Files releases every entry controller, without changing upload ownership', () => {
      const file = new File(['keep draft'], 'keep.txt'), attachment = fileAttachment('keep', file);
      show([attachment]); tray.querySelector('.att-info').click(); view.dispose();
      assert.ok(views.every(item => item.disposed));
      assert.equal(S.attachments[0], attachment); assert.equal(S.attachments[0].file, file);
    });
    for (const [name, result] of [
      ['root read failure', { ok: false, error: 'unavailable' }],
      ['no workspace', { ok: true, noProject: true, workspace: null, entries: [] }],
    ]) {
      await check('an owned File preview survives a late ' + name + ' independently of the workspace tree', async () => {
        const host = document.createElement('section'); document.body.append(host);
        let resolveRoot, current = true, disposed = false, received;
        const callbacks = [];
        const localView = { isCurrent: () => current, onDispose(fn) { callbacks.push(fn); },
          dispose() { if (!current) return; current = false; callbacks.reverse().forEach(fn => fn()); } };
        mountFilesPanel(host, localView, {
          transport: { list: () => new Promise(resolve => { resolveRoot = resolve; }), metadata: forbiddenRead, document: forbiddenRead, content: forbiddenRead },
          previewMount(content, request) {
            received = request; content.textContent = request.name;
            return { ready: Promise.resolve(), getState: () => ({}), dispose() { disposed = true; content.replaceChildren(); } };
          },
        });
        try {
          const file = new File([tinyPng()], 'local-only.png', { type: 'image/png' });
          show([fileAttachment('tree-independent', file, { kind: 'image', mimeType: 'image/png' })]);
          tray.querySelector('.att-preview').click();
          assert.equal(received.file, file); assert.equal(disposed, false);
          resolveRoot(result); await tick(); await tick();
          assert.equal(disposed, false, 'a workspace listing does not own the attachment decoder');
          assert.equal(host.querySelector('.files-preview-content')?.textContent, 'local-only.png');
          assert.equal(S.attachments[0].file, file); assert.equal(transportReads, 0);
          document.dispatchEvent(new CustomEvent('pi-gui:attachment-revoked', { detail: { attachmentId: 'tree-independent' } }));
          assert.equal(disposed, true, 'owner revocation still disposes the independent File reader');
          assert.equal(host.querySelectorAll('.files-tab[data-file-tab="local-only.png"]').length, 0);
        } finally { localView.dispose(); host.remove(); }
        assert.equal(disposed, true);
      });
    }
  } finally {
    show([]); view.dispose(); dom.window.close();
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
    global.atob = originalAtob; global.fetch = originalFetch;
  }
  console.log(`File preview entries: ${passed}/${passed + failed}; failed=${failed}; skipped=0`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; dom.window.close(); });
