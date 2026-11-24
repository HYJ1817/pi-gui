/* 设置 → 常规里的“编辑器与访问”卡片（jsdom）。
 *
 * 这里只验证渲染与发起请求：真正的检测/保存/原生对话框在主进程，
 * 已在 tests/editor-settings.cjs 与 tests/external-files.cjs 覆盖。
 * 重点：紧凑的既有设置卡结构、当前编辑器标记、授权列表与撤销/添加入口。 */
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

let checks = 0;
const ok = (name, value) => {
  if (typeof value === 'function') value();
  else assert.ok(value, name);
  checks++;
  console.log('  ok  ' + name);
};
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, label = 'UI state') => {
  for (let i = 0; i < 160; i++) {
    if (await fn()) return;
    await tick(10);
  }
  throw new Error(label + ' timeout');
};

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div><div id="toasts"></div></body></html>', {
  url: 'http://127.0.0.1/',
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.sessionStorage = dom.window.sessionStorage;
global.CustomEvent = dom.window.CustomEvent;
global.MutationObserver = dom.window.MutationObserver;
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.cancelAnimationFrame = clearTimeout;
global.getComputedStyle = dom.window.getComputedStyle;

const CONVERSATION = '11111111-2222-3333-4444-555555555555';
const snapshot = (editor, customPath = '') => ({
  ok: true,
  platform: 'win32',
  preference: { editor, customPath },
  editors: [
    { id: 'system', label: '系统默认程序', available: true },
    { id: 'vscode', label: 'Visual Studio Code', available: true, path: 'C:\\Program Files\\Microsoft VS Code\\Code.exe' },
    { id: 'cursor', label: 'Cursor', available: false },
    { id: 'custom', label: '自定义编辑器', available: Boolean(customPath), ...(customPath ? { path: customPath } : {}) },
  ],
  persistence: 'saved',
});

(async () => {
  const { createEditorAndAccessCard } = await import('../public/editor-settings.js');
  const { setGitConversationScope } = await import('../public/api.js');
  setGitConversationScope(CONVERSATION);

  const calls = { save: [], custom: [], list: [], revoke: [], chooseDir: [] };
  let current = snapshot('system');
  let grants = [
    { id: 'a'.repeat(32), kind: 'file', scope: 'session', target: 'D:\\报告\\外部.md' },
    { id: 'b'.repeat(32), kind: 'directory', scope: 'persistent', target: 'D:\\日志' },
  ];
  window.piGuiDesktop = {
    editors: {
      list: async () => current,
      save: async (request) => {
        calls.save.push(request);
        current = snapshot(request.editor, request.customPath);
        return current;
      },
      chooseCustom: async () => {
        calls.custom.push(true);
        current = snapshot('custom', 'C:\\工具\\我的 编辑器.exe');
        return current;
      },
      open: async () => ({ ok: true }),
    },
    externalFiles: {
      list: async (request) => {
        calls.list.push(request);
        return { ok: true, grants };
      },
      revoke: async (request) => {
        calls.revoke.push(request);
        grants = grants.filter((grant) => grant.id !== request.grantId);
        return { ok: true, id: request.grantId };
      },
      chooseDirectory: async (request) => {
        calls.chooseDir.push(request);
        grants = [...grants, { id: 'c'.repeat(32), kind: 'directory', scope: 'persistent', target: 'D:\\新目录' }];
        return { ok: true, grant: grants[grants.length - 1] };
      },
      authorize: async () => ({ ok: false, cancelled: true }),
    },
  };

  const statuses = [];
  const editorAccess = createEditorAndAccessCard({ setStatus: (text, tone) => statuses.push({ text, tone }) });
  document.getElementById('host').append(editorAccess.card);
  await until(() => editorAccess.card.querySelector('.editor-settings-trigger')?.textContent === '系统默认程序');

  ok('the card reuses the standard settings card and shows two compact rows', () => {
    const card = editorAccess.card;
    assert.equal(card.classList.contains('ds-settings-card'), true);
    assert.equal(card.querySelector('.ds-settings-card-title')?.textContent, '编辑器与访问');
    assert.equal(card.querySelectorAll('.ds-settings-row').length, 2);
    assert.equal(card.querySelector('.editor-settings-trigger').getAttribute('aria-haspopup'), 'menu');
    assert.equal(card.querySelector('.external-access-trigger').getAttribute('aria-expanded'), 'false');
  });

  editorAccess.card.querySelector('.editor-settings-trigger')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const menu = document.querySelector('.action-menu');
  ok('the editor menu lists only available editors and marks the current one', () => {
    assert.ok(menu);
    const labels = [...menu.querySelectorAll('.action-menu-label')].map((node) => node.textContent);
    assert.deepEqual(labels.slice(0, 2), ['系统默认程序 · 当前', 'Visual Studio Code']);
    assert.equal(labels.some((label) => label.includes('Cursor')), false);
    assert.ok(labels.includes('选择自定义编辑器…'));
    assert.ok(labels.includes('重新检测'));
  });
  const vscodeItem = [...document.querySelectorAll('.action-menu-item')]
    .find((item) => item.textContent.includes('Visual Studio Code'));
  vscodeItem.click();
  await until(() => editorAccess.card.querySelector('.editor-settings-trigger')?.textContent === 'Visual Studio Code');
  ok('choosing an editor saves the preference and updates the trigger', () => {
    assert.deepEqual(calls.save, [{ editor: 'vscode', customPath: '' }]);
    assert.equal(editorAccess.card.querySelector('.editor-settings-trigger').title,
      'C:\\Program Files\\Microsoft VS Code\\Code.exe');
  });

  editorAccess.card.querySelector('.editor-settings-trigger')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const customItem = [...document.querySelectorAll('.action-menu-item')]
    .find((item) => item.textContent.includes('选择自定义编辑器…'));
  customItem.click();
  await until(() => editorAccess.card.querySelector('.editor-settings-trigger')?.textContent === '我的 编辑器.exe');
  ok('the custom editor path is chosen natively and shown by its file name', () => {
    assert.equal(calls.custom.length, 1);
    assert.equal(editorAccess.card.querySelector('.editor-settings-trigger').title, 'C:\\工具\\我的 编辑器.exe');
  });

  const accessButton = editorAccess.card.querySelector('.external-access-trigger');
  accessButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await until(() => editorAccess.card.querySelectorAll('.external-grant-item').length === 2);
  ok('opening access management lists the current conversation grants with scope', () => {
    assert.equal(accessButton.getAttribute('aria-expanded'), 'true');
    assert.equal(calls.list.length, 1);
    assert.equal(calls.list[0].conversationId, CONVERSATION);
    const items = [...editorAccess.card.querySelectorAll('.external-grant-item')];
    assert.equal(items[0].querySelector('.external-grant-path').textContent, 'D:\\报告\\外部.md');
    assert.equal(items[0].querySelector('.external-grant-meta').textContent, '文件 · 本次运行');
    assert.equal(items[1].querySelector('.external-grant-meta').textContent, '文件夹 · 长期');
    assert.equal(items[0].querySelector('.btn').textContent, '撤销');
  });

  const firstRevoke = editorAccess.card.querySelector('.external-grant-item .btn');
  firstRevoke.click();
  await until(() => editorAccess.card.querySelectorAll('.external-grant-item').length === 1);
  ok('revoking removes the row and passes the conversation identity', () => {
    assert.deepEqual(calls.revoke, [{ grantId: 'a'.repeat(32), conversationId: CONVERSATION }]);
    assert.equal(document.getElementById('toasts').textContent.includes('已撤销访问授权'), true);
  });

  const addButton = [...editorAccess.card.querySelectorAll('.external-grant-toolbar .btn')]
    .find((button) => button.textContent === '添加文件夹…');
  addButton.click();
  await until(() => editorAccess.card.querySelectorAll('.external-grant-item').length === 2);
  ok('adding a folder uses the native picker and refreshes the list', () => {
    assert.equal(calls.chooseDir.length, 1);
    assert.equal(calls.chooseDir[0].conversationId, CONVERSATION);
    const paths = [...editorAccess.card.querySelectorAll('.external-grant-path')].map((node) => node.textContent);
    assert.ok(paths.includes('D:\\新目录'));
  });

  const listCallsBeforeDispose = calls.list.length;
  editorAccess.dispose();
  document.dispatchEvent(new dom.window.CustomEvent('pi-gui:external-grants', { detail: { revoked: 'c'.repeat(32) } }));
  await tick(30);
  ok('disposing the settings page stops listening for grant changes', () => {
    assert.equal(calls.list.length, listCallsBeforeDispose);
  });

  console.log(`editor-settings-ui: ${checks} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
