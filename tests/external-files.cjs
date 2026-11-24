/* 工作区外文件授权的主进程契约。
 *
 * 这里用假的 ipcMain / dialog / 后端子进程验证：
 *   - 只接受主窗口主 frame 的请求；
 *   - 先 inspect（拿到后端规范化路径）再弹原生对话框；
 *   - 用户选择“仅此文件 / 此文件夹（本次运行）/ 记住此文件夹”分别映射到
 *     正确的 scopeKind 与 persistent；
 *   - 取消不创建授权；已有授权不重复弹窗；
 *   - list / revoke 只转发固定字段，非法授权标识被挡在主进程。
 * 不启动 Electron，也不触碰真实文件系统。 */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log('  ok  ' + name);
}

const ORIGIN = 'http://127.0.0.1:7789';
const CONVERSATION = '11111111-2222-3333-4444-555555555555';
const APPROVAL = 'a'.repeat(32);
const inspectReply = (kind, target) => ({
  ok: true,
  kind,
  target,
  folder: kind === 'file' ? path.win32.dirname(target) : target,
  existing: null,
  approval: APPROVAL,
});
const grantRecord = (id, target) => ({
  id,
  conversationKey: `conversation:${CONVERSATION}`,
  kind: 'directory',
  scope: 'persistent',
  target,
  createdAt: '2026-01-01T00:00:00.000Z',
});

async function harness({ directory } = {}) {
  const stateDir = directory || fs.mkdtempSync(path.join(os.tmpdir(), 'pi-external-files-'));
  const handlers = new Map();
  const ipcMain = {
    handle(channel, fn) { handlers.set(channel, fn); },
  };
  const mainFrame = { url: ORIGIN + '/index.html' };
  const webContents = { mainFrame };
  const window = { isDestroyed: () => false, webContents };
  const trustedEvent = { sender: webContents, senderFrame: mainFrame };

  const child = new EventEmitter();
  child.connected = true;
  child.sent = [];
  const replies = [];
  child.send = (message, callback) => {
    child.sent.push(message);
    const reply = replies.length ? replies.shift() : { ok: true };
    setImmediate(() => {
      child.emit('message', { type: 'files-grant-result', id: message.id, result: reply });
      callback?.(null);
    });
  };

  const dialogs = [];
  const dialog = {
    showMessageBox: async (_win, options) => {
      dialogs.push({ kind: 'message', options });
      const response = dialog.nextResponse;
      return { response: typeof response === 'function' ? response(options) : response };
    },
    showOpenDialog: async (_win, options) => {
      dialogs.push({ kind: 'open', options });
      return dialog.nextOpen || { canceled: true, filePaths: [] };
    },
  };

  const { installExternalFiles } = require('../electron/external-files.cjs');
  const controller = await installExternalFiles({
    ipcMain,
    dialog,
    getWindow: () => window,
    getServer: () => child,
    origin: ORIGIN,
    directory: stateDir,
  });

  const invoke = (channel, request, event = trustedEvent) => handlers.get(channel)(event, request);
  return {
    ipcMain, child, replies, dialogs, dialog, invoke, trustedEvent, window, webContents,
    directory: stateDir, restore: controller.restore,
  };
}

(async () => {
  await check('a sender that is not the main frame is rejected before any dialog', async () => {
    const h = await harness();
    const result = await h.invoke('pi-gui:external-file-authorize', { path: 'C:\\x.txt' }, {
      sender: h.webContents,
      senderFrame: { url: ORIGIN + '/' },
    });
    assert.equal(result.code, 'untrusted-sender');
    assert.equal(h.dialogs.length, 0);
    assert.equal(h.child.sent.length, 0);
  });

  await check('a foreign origin or destroyed window cannot start authorization', async () => {
    const h = await harness();
    const foreign = { sender: h.webContents, senderFrame: { url: 'https://evil.example/' } };
    assert.equal((await h.invoke('pi-gui:external-file-authorize', { path: 'C:\\x.txt' }, foreign)).code, 'untrusted-sender');
    const frame = { url: ORIGIN + '/' };
    const broken = { sender: {}, senderFrame: frame };
    assert.equal((await h.invoke('pi-gui:external-file-authorize', { path: 'C:\\x.txt' }, broken)).code, 'untrusted-sender');
  });

  await check('an inspect failure stops before the native dialog', async () => {
    const h = await harness();
    h.replies.push({ ok: false, code: 'sensitive_path', error: '这里不能授权。' });
    const result = await h.invoke('pi-gui:external-file-authorize', { path: 'C:\\Windows\\x.txt' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'sensitive_path');
    assert.equal(h.dialogs.length, 0);
    assert.equal(h.child.sent[0].action, 'inspect');
  });

  await check('an existing grant is returned without asking again', async () => {
    const h = await harness();
    h.replies.push({
      ok: true,
      kind: 'file',
      target: 'C:\\reports\\done.md',
      existing: { id: 'a'.repeat(32), kind: 'file', scope: 'session', target: 'C:\\reports\\done.md' },
    });
    const result = await h.invoke('pi-gui:external-file-authorize', {
      path: 'C:\\reports\\done.md',
      conversationId: CONVERSATION,
    });
    assert.equal(result.ok, true);
    assert.equal(result.existing, true);
    assert.equal(result.grant.id, 'a'.repeat(32));
    assert.equal(h.dialogs.length, 0);
  });

  await check('an explicit folder request can upgrade an existing session grant to persistent', async () => {
    const h = await harness();
    const folder = 'C:\\reports\\kept';
    h.replies.push({
      ok: true,
      kind: 'directory',
      target: folder,
      folder,
      existing: { id: 'e'.repeat(32), kind: 'directory', scope: 'session', target: folder },
      approval: APPROVAL,
    });
    h.dialog.nextResponse = 1;
    const saved = grantRecord('e'.repeat(32), folder);
    h.replies.push({
      ok: true,
      grant: { ...saved },
      persistent: [saved],
    });
    const result = await h.invoke('pi-gui:external-file-authorize', {
      path: folder,
      kind: 'directory',
      conversationId: CONVERSATION,
    });
    assert.equal(result.ok, true);
    assert.equal(result.grant.scope, 'persistent');
    assert.equal(h.dialogs.length, 1);
    assert.deepEqual(h.dialogs[0].options.buttons, ['此文件夹（本次运行）', '记住此文件夹', '取消']);
    const create = h.child.sent[1];
    assert.equal(create.action, 'create');
    assert.equal(create.approval, APPROVAL);
    assert.equal(create.persistent, true);
  });

  await check('“仅此文件” creates a session grant for exactly one canonical file', async () => {
    const h = await harness();
    h.replies.push(inspectReply('file', 'C:\\reports\\报告 v1.md'));
    h.dialog.nextResponse = 0;
    h.replies.push({ ok: true, grant: { id: 'b'.repeat(32), kind: 'file', scope: 'session' } });
    const result = await h.invoke('pi-gui:external-file-authorize', {
      path: 'C:\\reports\\报告 v1.md',
      conversationId: CONVERSATION,
    });
    assert.equal(result.ok, true);
    assert.equal(result.grant.id, 'b'.repeat(32));
    const ask = h.dialogs[0].options;
    assert.equal(ask.buttons.length, 4);
    assert.equal(ask.defaultId, 3);
    assert.equal(ask.cancelId, 3);
    assert.ok(ask.detail.includes('文件：C:\\reports\\报告 v1.md'));
    assert.ok(ask.detail.includes('文件夹：C:\\reports'));
    assert.ok(ask.detail.includes('不授予写入、删除或执行权限'));
    const create = h.child.sent[1];
    assert.equal(create.approval, APPROVAL);
    assert.equal(create.action, 'create');
    assert.equal(create.scopeKind, 'file');
    assert.equal(create.persistent, false);
    assert.equal(create.conversationId, CONVERSATION);
  });

  await check('“此文件夹（本次运行）” creates a session directory grant for the parent', async () => {
    const h = await harness();
    h.replies.push(inspectReply('file', 'C:\\reports\\v2\\done.md'));
    h.dialog.nextResponse = 1;
    h.replies.push({ ok: true, grant: { id: 'c'.repeat(32), kind: 'directory', scope: 'session' } });
    await h.invoke('pi-gui:external-file-authorize', { path: 'C:\\reports\\v2\\done.md', conversationId: CONVERSATION });
    const create = h.child.sent[1];
    assert.equal(create.approval, APPROVAL);
    assert.equal(create.scopeKind, 'directory');
    assert.equal(create.persistent, false);
  });

  await check('“记住此文件夹” creates a persistent directory grant', async () => {
    const h = await harness();
    h.replies.push(inspectReply('file', 'C:\\reports\\v2\\done.md'));
    h.dialog.nextResponse = 2;
    const saved = grantRecord('d'.repeat(32), 'C:\\reports\\v2');
    h.replies.push({
      ok: true,
      grant: { id: saved.id, kind: 'directory', scope: 'persistent' },
      persistent: [saved],
    });
    const result = await h.invoke('pi-gui:external-file-authorize', {
      path: 'C:\\reports\\v2\\done.md',
      conversationId: CONVERSATION,
    });
    assert.equal(result.grant.scope, 'persistent');
    const create = h.child.sent[1];
    assert.equal(create.approval, APPROVAL);
    assert.equal(create.scopeKind, 'directory');
    assert.equal(create.persistent, true);
    const document = JSON.parse(fs.readFileSync(path.join(h.directory, 'external-file-grants.json'), 'utf8'));
    assert.equal(document.schemaVersion, 1);
    assert.deepEqual(document.grants, [saved]);
  });

  await check('persistent grants are restored through the same settings file on the next start', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-external-files-restart-'));
    const first = await harness({ directory });
    const saved = grantRecord('7'.repeat(32), 'C:\\reports\\kept');
    first.replies.push(inspectReply('directory', 'C:\\reports\\kept'));
    first.dialog.nextResponse = 1;
    first.replies.push({
      ok: true,
      grant: { id: saved.id, kind: 'directory', scope: 'persistent' },
      persistent: [saved],
    });
    const created = await first.invoke('pi-gui:external-file-authorize', {
      path: 'C:\\reports\\kept',
      kind: 'directory',
      conversationId: CONVERSATION,
    });
    assert.equal(created.ok, true);

    const second = await harness({ directory });
    second.replies.push({ ok: true, restored: 1, persistent: [saved] });
    const restored = await second.restore();
    assert.equal(restored.ok, true);
    const call = second.child.sent.find((message) => message.action === 'restore');
    assert.deepEqual(call.grants, [saved]);

    second.replies.push({ ok: true, id: saved.id, persistent: [] });
    const revoked = await second.invoke('pi-gui:external-file-revoke', {
      conversationId: CONVERSATION, grantId: saved.id,
    });
    assert.equal(revoked.ok, true);
    const document = JSON.parse(fs.readFileSync(path.join(directory, 'external-file-grants.json'), 'utf8'));
    assert.deepEqual(document.grants, []);
  });

  await check('an unavailable settings store hides “记住” instead of faking persistence', async () => {
    const missing = path.join(os.tmpdir(), `pi-external-files-missing-${process.pid}-${checks}`);
    const h = await harness({ directory: missing });
    h.replies.push(inspectReply('file', 'C:\\reports\\done.md'));
    h.dialog.nextResponse = 0;
    h.replies.push({ ok: true, grant: { id: '9'.repeat(32), kind: 'file', scope: 'session' } });
    const result = await h.invoke('pi-gui:external-file-authorize', {
      path: 'C:\\reports\\done.md',
      conversationId: CONVERSATION,
    });
    assert.equal(result.ok, true);
    assert.equal(h.dialogs[0].options.buttons.length, 3);
    assert.deepEqual(h.dialogs[0].options.buttons, ['仅此文件', '此文件夹（本次运行）', '取消']);
    assert.ok(!h.dialogs[0].options.detail.includes('记住此文件夹'));

    h.replies.push({ ok: true, grants: [] });
    const listed = await h.invoke('pi-gui:external-file-list', { conversationId: CONVERSATION });
    assert.equal(listed.storeError, 'external_grants_unavailable');
  });

  await check('a failed persistent write withdraws the new grant instead of claiming it was saved', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-external-files-savefail-'));
    const h = await harness({ directory });
    fs.writeFileSync(path.join(directory, 'external-file-grants.json'), 'x'.repeat(17000));
    h.replies.push(inspectReply('file', 'C:\\reports\\v3\\done.md'));
    h.dialog.nextResponse = 2;
    h.replies.push({
      ok: true,
      grant: { id: '8'.repeat(32), kind: 'directory', scope: 'persistent' },
      persistent: [grantRecord('8'.repeat(32), 'C:\\reports\\v3')],
    });
    const result = await h.invoke('pi-gui:external-file-authorize', {
      path: 'C:\\reports\\v3\\done.md',
      conversationId: CONVERSATION,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'settings_save_failed');
    const revoke = h.child.sent.find((message) => message.action === 'revoke');
    assert.ok(revoke);
    assert.equal(revoke.grantId, '8'.repeat(32));
  });

  await check('a revoke that cannot be saved is rolled back and reported as still effective', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-external-files-revfail-'));
    const saved = grantRecord('6'.repeat(32), 'C:\\reports\\kept');
    fs.writeFileSync(
      path.join(directory, 'external-file-grants.json'),
      JSON.stringify({ schemaVersion: 1, grants: [saved] }, null, 2)
    );
    const h = await harness({ directory });
    fs.writeFileSync(path.join(directory, 'external-file-grants.json'), 'x'.repeat(17000));
    h.replies.push({ ok: true, id: saved.id, removed: saved, persistent: [] });
    const result = await h.invoke('pi-gui:external-file-revoke', {
      conversationId: CONVERSATION,
      grantId: saved.id,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'revoke_not_saved');
    const restored = h.child.sent.find((message) => message.action === 'restore');
    assert.ok(restored);
    assert.deepEqual(restored.grants, [saved]);
  });

  await check('a directory request has only session / persistent / cancel choices', async () => {
    const h = await harness();
    h.replies.push(inspectReply('directory', 'C:\\reports'));
    h.dialog.nextResponse = 0;
    h.replies.push({ ok: true, grant: { id: 'e'.repeat(32), kind: 'directory', scope: 'session' } });
    await h.invoke('pi-gui:external-file-authorize', {
      path: 'C:\\reports',
      kind: 'directory',
      conversationId: CONVERSATION,
    });
    const ask = h.dialogs[0].options;
    assert.equal(ask.buttons.length, 3);
    assert.equal(ask.buttons[2], '取消');
    assert.equal(ask.defaultId, 2);
    assert.ok(ask.detail.includes('文件夹：C:\\reports'));
    assert.ok(!ask.detail.includes('文件：C:\\reports'));
    assert.equal(h.child.sent[1].scopeKind, 'directory');
  });

  await check('cancel creates nothing and reports cancellation without an error toast', async () => {
    const h = await harness();
    h.replies.push(inspectReply('file', 'C:\\reports\\done.md'));
    h.dialog.nextResponse = 3;
    const result = await h.invoke('pi-gui:external-file-authorize', {
      path: 'C:\\reports\\done.md',
      conversationId: CONVERSATION,
    });
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.equal(h.child.sent.filter((message) => message.action === 'create').length, 0);
  });

  await check('the choose-directory flow authorizes the picked folder, not a file', async () => {
    const h = await harness();
    h.dialog.nextOpen = { canceled: false, filePaths: ['C:\\reports\\附件 目录'] };
    h.replies.push(inspectReply('directory', 'C:\\reports\\附件 目录'));
    h.dialog.nextResponse = 1;
    h.replies.push({
      ok: true,
      grant: { id: 'f'.repeat(32), kind: 'directory', scope: 'persistent' },
      persistent: [grantRecord('f'.repeat(32), 'C:\\reports\\附件 目录')],
    });
    const result = await h.invoke('pi-gui:external-file-choose-directory', { conversationId: CONVERSATION });
    assert.equal(result.ok, true);
    assert.equal(h.dialogs[0].kind, 'open');
    assert.deepEqual(h.dialogs[0].options.properties, ['openDirectory']);
    const ask = h.dialogs[1].options;
    assert.equal(ask.buttons.length, 3);
    assert.ok(ask.detail.includes('C:\\reports\\附件 目录'));
    assert.equal(h.child.sent[0].scopeKind, 'directory');
    assert.equal(h.child.sent[1].persistent, true);
  });

  await check('list and revoke forward only the conversation and grant id', async () => {
    const h = await harness();
    h.replies.push({ ok: true, grants: [] });
    h.replies.push({ ok: true, id: 'a'.repeat(32) });
    await h.invoke('pi-gui:external-file-list', { conversationId: CONVERSATION, extra: 'ignored' });
    await h.invoke('pi-gui:external-file-revoke', { conversationId: CONVERSATION, grantId: 'a'.repeat(32) });
    assert.deepEqual(h.child.sent[0], { type: 'files-grant', id: h.child.sent[0].id, action: 'list', conversationId: CONVERSATION });
    assert.deepEqual(h.child.sent[1], {
      type: 'files-grant',
      id: h.child.sent[1].id,
      action: 'revoke',
      grantId: 'a'.repeat(32),
      conversationId: CONVERSATION,
    });
    assert.equal(await h.invoke('pi-gui:external-file-revoke', { conversationId: CONVERSATION, grantId: 'nope' })
      .then((result) => result.code), 'invalid_request');
    assert.equal(h.child.sent.length, 2);
  });

  await check('invalid paths and conversation identities never reach the backend', async () => {
    const h = await harness();
    for (const request of [
      { path: '', conversationId: CONVERSATION },
      { path: '   ', conversationId: CONVERSATION },
      { path: 'C:\\x.txt', conversationId: 'not-a-conversation' },
      { path: 'C:\\x\u0000.txt', conversationId: CONVERSATION },
    ]) {
      const result = await h.invoke('pi-gui:external-file-authorize', request);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'invalid_request');
    }
    assert.equal(h.child.sent.length, 0);
  });

  await check('without a connected backend the bridge degrades instead of faking a grant', async () => {
    const h = await harness();
    h.child.connected = false;
    const result = await h.invoke('pi-gui:external-file-authorize', { path: 'C:\\x.txt', conversationId: CONVERSATION });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'native-unavailable');
  });

  await check('a folder picker cannot overlap a second authorization or picker', async () => {
    const h = await harness();
    let release;
    h.dialog.showOpenDialog = () => {
      h.dialogs.push({ kind: 'open' });
      return new Promise((resolve) => { release = () => resolve({ canceled: true, filePaths: [] }); });
    };
    const first = h.invoke('pi-gui:external-file-choose-directory', { conversationId: CONVERSATION });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await h.invoke('pi-gui:external-file-authorize', {
      path: 'C:\\x.txt', conversationId: CONVERSATION,
    })).code, 'busy');
    assert.equal((await h.invoke('pi-gui:external-file-choose-directory', {
      conversationId: CONVERSATION,
    })).code, 'busy');
    release();
    assert.equal((await first).cancelled, true);
    assert.equal(h.child.sent.length, 0);
  });

  await check('a second authorization cannot race the first dialog', async () => {
    const h = await harness();
    h.replies.push(inspectReply('file', 'C:\\reports\\one.md'));
    let release;
    h.dialog.showMessageBox = (_win, options) => {
      h.dialogs.push({ kind: 'message', options });
      return new Promise((resolve) => { release = () => resolve({ response: 3 }); });
    };
    const first = h.invoke('pi-gui:external-file-authorize', {
      path: 'C:\\reports\\one.md',
      conversationId: CONVERSATION,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const second = await h.invoke('pi-gui:external-file-authorize', {
      path: 'C:\\reports\\two.md',
      conversationId: CONVERSATION,
    });
    assert.equal(second.code, 'busy');
    release();
    assert.equal((await first).cancelled, true);
  });

  console.log(`external-files: ${checks} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
