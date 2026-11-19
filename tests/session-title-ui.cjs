'use strict';
/* AI 会话标题的前端编排（public/session-titles.js）与接入点测试。
 *
 * 用 jsdom + tests/esm-bundle.cjs 跑**真实模块图**：
 *   - 模块世界：设置缓存、SSE 采纳、事件派发与顶部标题；
 *   - 侧栏世界：真实 sessions.js 渲染会话行，验证标题事件与手动生成都
 *     就地更新行 / 顶部标题，不重画列表。
 * 排版（间距、颜色）不在 jsdom 里量 —— 那由真实 Electron 截图负责。
 */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const titlesCode = bundle(path.join(ROOT, 'public/session-titles.js')).code;
const sessionsCode = bundle(path.join(ROOT, 'public/sessions.js')).code;
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  let ok = cond;
  try { ok = typeof cond === 'function' ? cond() : cond; }
  catch (err) { ok = 'threw: ' + err.message; }
  if (ok === true) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (typeof ok === 'string' ? '  → ' + ok : extra ? '  → ' + extra : '')); }
}
const section = (title) => console.log('\n--- ' + title + ' ---');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const C1 = '33333333-3333-4333-8333-333333333333';
const ID1 = 'a'.repeat(16);
const ID2 = 'b'.repeat(16);

function jsonResponse(payload, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => payload };
}

function sessionFixture() {
  return [
    {
      id: ID1, title: '旧标题', titleSource: 'auto', titleRevision: 1, sessionId: S1,
      createdAt: '2030-01-01T00:00:00.000Z', lastMessageAt: '2030-01-01T00:00:00.000Z',
      updatedAt: 1, messageCount: 2, current: true, pending: false, archived: false, truncated: false,
    },
    {
      id: ID2, title: '另一个会话', titleSource: 'auto', titleRevision: 1, sessionId: S2,
      createdAt: '2030-01-01T00:00:00.000Z', lastMessageAt: '2030-01-01T00:00:00.000Z',
      updatedAt: 1, messageCount: 2, current: false, pending: false, archived: false, truncated: false,
    },
  ];
}

const MODULE_DOM = `<!doctype html><html><head></head><body>
  <div id="workspace" data-workspace-view="classic"><div id="title">新对话</div></div>
  <div id="stream"></div><input id="input"><div id="toasts"></div>
  <div id="modal" hidden><div id="modalCard"></div></div>
  <div id="confirmLayer" hidden><div id="confirmCard"></div></div>
</body></html>`;

/** 只加载标题模块：测它自己负责的设置缓存、事件语义与顶部标题。 */
function makeModuleWorld(handler = () => jsonResponse({ ok: true })) {
  const dom = new JSDOM(MODULE_DOM, { runScripts: 'outside-only', url: 'http://fixture', pretendToBeVisual: true });
  const win = dom.window;
  global.window = win;
  global.document = win.document;
  const calls = [];
  win.fetch = async (url, opts = {}) => {
    const call = { url: String(url), opts, body: opts && opts.body ? JSON.parse(opts.body) : null };
    calls.push(call);
    return handler(call, calls);
  };
  win.eval(titlesCode);
  return {
    dom, win, calls,
    toastTexts: () => [...win.document.querySelectorAll('#toasts .ui4-feedback-toast-body')].map((n) => n.textContent),
    topTitle: () => win.document.getElementById('title').textContent,
    close: () => dom.window.close(),
  };
}

/** 加载真实 sessions.js（含标题模块），渲染出两条会话行。 */
async function makeSidebarWorld(handler = null) {
  const dom = new JSDOM(indexHtml, { runScripts: 'outside-only', url: 'http://localhost:7791', pretendToBeVisual: true });
  const win = dom.window;
  global.window = win;
  global.document = win.document;
  win.HTMLElement.prototype.scrollIntoView = () => {};
  const calls = [];
  const sessions = sessionFixture();

  win.fetch = async (url, opts = {}) => {
    const call = { url: String(url), opts, body: opts && opts.body ? JSON.parse(opts.body) : null };
    calls.push(call);
    if (handler && String(url).startsWith('/api/session-titles')) return handler(call, calls);
    if (String(url) === '/api/sessions') {
      return jsonResponse({ ok: true, hasProject: true, currentId: ID1, sessions });
    }
    if (String(url) === '/api/runtime-sessions') return jsonResponse({ ok: true, items: [] });
    if (String(url).startsWith('/api/worktrees')) return jsonResponse({ ok: false, error: 'not a repo' });
    return jsonResponse({ ok: true });
  };
  win.eval(sessionsCode);
  win.S.hasProject = true;
  win.S.workspaceGeneration = 7;
  win.S.state = { sessionId: S1, sessionName: '' };

  const projectEl = win.document.createElement('div');
  projectEl.className = 'project active';
  projectEl.dataset.projectPath = 'C:/p';
  projectEl.innerHTML = '<span class="pj-name">p</span><button class="pj-select"></button>';
  win.document.getElementById('projects').append(projectEl);

  const row = (sid) => win.document.querySelector(`.pj-sess[data-session-id="${sid}"]`);
  const titleText = (sid) => row(sid)?.querySelector('.pj-sess-title')?.textContent;
  const topTitle = () => win.document.getElementById('title').textContent;
  const addRuntimeRow = (conversationId) => {
    const el = win.document.createElement('div');
    el.className = 'pj-runtime';
    el.dataset.conversationId = conversationId;
    el.innerHTML = '<span class="pj-sess-title">并行会话</span>'
      + '<button class="pj-sess-primary" aria-label="并行会话：旧标题"><span class="pj-runtime-status">运行中</span></button>';
    win.document.body.append(el);
    return el;
  };
  const addSearchResult = (sessionId) => {
    const el = win.document.createElement('div');
    el.className = 'pj-sr';
    el.dataset.nativeSessionId = sessionId;
    el.innerHTML = '<button class="pj-sr-head" aria-label="打开会话：旧标题"><span class="pj-sr-title">旧标题</span></button>';
    win.document.body.append(el);
    return el;
  };

  await win.renderSidebarSessions(projectEl, { path: 'C:/p' });

  return {
    dom, win, calls, sessions, row, titleText, topTitle, addRuntimeRow, addSearchResult,
    toastTexts: () => [...win.document.querySelectorAll('#toasts .ui4-feedback-toast-body')].map((n) => n.textContent),
    close: () => dom.window.close(),
  };
}

(async () => {
  /* ================= A. 设置缓存 ================= */
  section('A. 设置缓存与能力');
  {
    const payload = {
      ok: true,
      settings: { autoEnabled: false, enabledAt: '2030-01-01T00:00:00.000Z', revision: 3 },
      capability: { supported: true, reason: null, piVersion: '1.5.2' },
      model: { mode: 'current-session', label: '跟随当前会话' },
    };
    let settingsEvents = 0;
    const w = makeModuleWorld(() => jsonResponse(payload));
    w.win.document.addEventListener('pi-gui:session-title-settings', () => { settingsEvents++; });
    let listenerSnapshots = 0;
    const off = w.win.onSessionTitleSettings(() => { listenerSnapshots++; });
    const snapshot = await w.win.loadSessionTitleSettings();

    check('A1. 设置请求发到应用级接口', () => w.calls.length === 1 && w.calls[0].url === '/api/session-titles/settings');
    check('A2. 返回的设置 / 能力 / 模型被采纳', () =>
      snapshot.settings.autoEnabled === false && snapshot.capability.supported === true
      && snapshot.model.label === '跟随当前会话');
    check('A3. 设置变化同时通知订阅者与 DOM 事件', () => listenerSnapshots === 1 && settingsEvents === 1);
    check('A4. 能力查询返回已采纳的值', () => w.win.titleCapability().supported === true);
    const before = w.calls.length;
    await w.win.loadSessionTitleSettings();
    check('A5. 已有缓存时不重复请求', () => w.calls.length === before);
    await w.win.loadSessionTitleSettings({ force: true });
    check('A6. force 才重新请求', () => w.calls.length === before + 1);
    off();
    w.close();
  }
  {
    const w = makeModuleWorld(() => { throw new Error('offline'); });
    const snapshot = await w.win.loadSessionTitleSettings();
    check('A7. 网络失败不抛异常、缓存保持未知', () => snapshot === null && w.win.titleCapability().supported === null);
    w.close();
  }
  {
    const w = makeModuleWorld(() => jsonResponse({ ok: false, error: '设置保存失败', code: 'settings_write_failed' }));
    const result = await w.win.setAutoSessionTitle(true);
    check('A8. 保存失败返回可展示的原因', () => result.ok === false && result.error === '设置保存失败');
    check('A9. 失败时不会假装设置已变', () => w.win.sessionTitleSettingsSnapshot() === null);
    w.close();
  }
  {
    const w = makeModuleWorld(() => jsonResponse({
      ok: true,
      settings: { autoEnabled: true, enabledAt: '2030-01-01T00:00:00.000Z', revision: 4 },
      capability: { supported: false, reason: '不支持的 Pi' },
      model: { mode: 'current-session', label: '跟随当前会话' },
    }));
    const result = await w.win.setAutoSessionTitle(true);
    check('A10. 保存走 PUT + JSON，且只传布尔值', () =>
      result.ok === true && w.calls[0].opts.method === 'PUT'
      && w.calls[0].url === '/api/session-titles/settings'
      && JSON.stringify(w.calls[0].body) === '{"autoEnabled":true}');
    check('A11. 保存成功采纳服务端能力（不支持时菜单会隐藏）', () =>
      w.win.titleCapability().supported === false);
    w.close();
  }
  {
    const w = makeModuleWorld();
    w.win.handleSessionTitleEvent({
      type: 'session_title_settings', ok: true,
      settings: { autoEnabled: false }, capability: { supported: null }, model: { label: '跟随当前会话' },
    });
    check('A12. SSE 设置帧同样被采纳', () =>
      w.win.sessionTitleSettingsSnapshot()?.settings.autoEnabled === false);
    w.close();
  }

  /* ================= B. 标题事件就地更新 ================= */
  section('B. 标题事件就地更新');
  {
    const w = await makeSidebarWorld();
    const events = [];
    w.win.document.addEventListener('pi-gui:classic-title', (e) => events.push(e.detail));
    const rowBefore = w.row(S1);
    const search = w.addSearchResult(S1);
    const topBefore = w.topTitle();
    w.win.handleSessionTitleEvent({ type: 'session_title', scope: 'classic', sessionId: S1, title: '修复登录 401', source: 'auto', revision: 2 });

    check('B1. 侧栏行标题就地更新', () => w.titleText(S1) === '修复登录 401');
    check('B2. 行的无障碍名称同步更新', () =>
      w.row(S1).querySelector('.pj-sess-primary').getAttribute('aria-label') === '切换会话：修复登录 401');
    check('B3. 当前会话的顶部标题同步', () =>
      w.topTitle() === '修复登录 401' && w.topTitle() !== topBefore);
    check('B4. 派发 pi-gui:classic-title 供其它视图（如搜索）使用', () =>
      events.length === 1 && events[0].sessionId === S1 && events[0].title === '修复登录 401');
    check('B5. 搜索结果里的同一会话同步更新', () =>
      search.querySelector('.pj-sr-title').textContent === '修复登录 401'
      && search.querySelector('.pj-sr-head').getAttribute('aria-label') === '打开会话：修复登录 401');
    check('B6. 不重画列表：行元素还是同一个', () => w.row(S1) === rowBefore);
    check('B7. 其它会话不受影响', () => w.titleText(S2) === '另一个会话');
    check('B8. 重复事件是幂等的（不新增行）', () => {
      w.win.handleSessionTitleEvent({ type: 'session_title', scope: 'classic', sessionId: S1, title: '修复登录 401', source: 'auto', revision: 2 });
      return w.win.document.querySelectorAll('.pj-sess').length === 2;
    });
    w.close();
  }
  {
    const w = await makeSidebarWorld();
    const topBefore = w.topTitle();
    w.win.handleSessionTitleEvent({ type: 'session_title', scope: 'classic', sessionId: S2, title: '后台会话标题', source: 'auto', revision: 2 });
    check('B9. 后台会话的标题只更新自己的行，不动当前顶部', () =>
      w.topTitle() === topBefore && w.titleText(S2) === '后台会话标题' && w.titleText(S1) === '旧标题');
    w.close();
  }
  {
    const w = await makeSidebarWorld();
    const events = [];
    w.win.document.addEventListener('pi-gui:runtime-title', (e) => events.push(e.detail));
    const runtimeRow = w.addRuntimeRow(C1);
    w.win.handleSessionTitleEvent({ type: 'session_title', scope: 'runtime', sessionId: S1, conversationId: C1, title: '并行会话标题', source: 'auto', revision: 2 });

    check('B10. Runtime 行标题就地更新', () =>
      runtimeRow.querySelector('.pj-sess-title').textContent === '并行会话标题');
    check('B11. Runtime 行的无障碍名称带运行状态', () =>
      runtimeRow.querySelector('.pj-sess-primary').getAttribute('aria-label') === '并行会话：并行会话标题，运行中');
    check('B12. 派发 pi-gui:runtime-title（带 conversationId，不带 projectPath 猜测）', () =>
      events.length === 1 && events[0].conversationId === C1 && events[0].title === '并行会话标题'
      && events[0].projectPath === '');
    check('B13. Runtime 标题事件不碰经典会话行', () => w.titleText(S2) === '另一个会话');
    w.close();
  }
  {
    const w = await makeSidebarWorld();
    const events = [];
    w.win.document.addEventListener('pi-gui:classic-title', (e) => events.push(e.detail));
    w.win.applyTitleEvent({ type: 'session_title', scope: 'classic', sessionId: S1, title: '', source: 'auto' });
    w.win.applyTitleEvent(null);
    w.win.applyTitleEvent({ type: 'session_title', scope: 'classic', sessionId: S1 });
    check('B14. 空标题 / 坏事件被忽略', () =>
      events.length === 0 && w.titleText(S1) === '旧标题');
    w.close();
  }

  /* ================= C. 手动生成 ================= */
  section('C. 手动生成与确认');
  {
    const w = await makeSidebarWorld((call) => {
      if (call.url === '/api/session-titles/generate') {
        return new Promise((resolve) => { w.release = () => resolve(jsonResponse({
          ok: true, applied: true, title: '手动生成标题', source: 'manual', sessionId: S1, revision: 2,
        })); });
      }
      return jsonResponse({ ok: true });
    });
    const first = w.win.generateAiTitle({ scope: 'classic', id: ID1 });
    await tick();
    const second = await w.win.generateAiTitle({ scope: 'classic', id: ID1 });
    check('C1. 同一会话在途时重复点击返回 busy', () => second.ok === false && second.code === 'busy');
    const generateCalls = w.calls.filter((c) => c.url === '/api/session-titles/generate');
    check('C2. 重复点击没有发出第二个请求', () => generateCalls.length === 1);
    check('C3. 请求体只带 scope 与 stable id', () =>
      JSON.stringify(generateCalls[0].body) === JSON.stringify({ scope: 'classic', id: ID1 }));
    w.release();
    const result = await first;
    await tick();
    check('C4. 直接应用：侧栏行就地更新', () =>
      result.applied === true && w.titleText(S1) === '手动生成标题');
    check('C5. 成功是安静的（不弹 info toast）', () => w.toastTexts().length === 0);
    check('C6. 完成后解除忙碌状态', () => w.win.isTitleGenerating('classic:' + ID1) === false);
    w.close();
  }
  {
    const w = await makeSidebarWorld(() => jsonResponse({
      ok: false, code: 'model_unavailable', error: '该会话使用的模型当前不可用，标题未生成',
    }));
    const result = await w.win.generateAiTitle({ scope: 'classic', id: ID2 });
    check('C7. 失败保留原标题并返回错误码', () =>
      result.ok === false && result.code === 'model_unavailable' && w.titleText(S2) === '另一个会话');
    check('C8. 失败会明确告诉用户原因', () =>
      w.toastTexts().some((t) => t.includes('模型当前不可用')));
    w.close();
  }
  {
    const w = await makeSidebarWorld((call) => {
      if (call.url === '/api/session-titles/generate') {
        return jsonResponse({
          ok: true, requiresConfirmation: true,
          proposal: { id: 'proposal-1', title: 'AI 新标题', currentTitle: '用户手动标题' },
        });
      }
      if (call.url === '/api/session-titles/apply') {
        return jsonResponse({ ok: true, applied: true, title: 'AI 新标题', source: 'manual', sessionId: S1, revision: 3 });
      }
      return jsonResponse({ ok: true });
    });
    const pending = w.win.generateAiTitle({ scope: 'classic', id: ID1 });
    await tick();
    const card = w.win.document.getElementById('confirmCard');
    check('C9. 当前是手动标题时先弹确认框', () =>
      w.win.document.getElementById('confirmLayer').hidden === false
      && card.textContent.includes('用户手动标题') && card.textContent.includes('AI 新标题'));
    check('C10. 确认之前不改标题、不调用 apply', () =>
      w.titleText(S1) === '旧标题' && !w.calls.some((c) => c.url === '/api/session-titles/apply'));
    card.querySelector('.btn.primary').click();
    const result = await pending;
    await tick();
    check('C11. 确认后调用 apply 并就地应用新标题', () =>
      result.ok === true && w.titleText(S1) === 'AI 新标题'
      && w.calls.some((c) => c.url === '/api/session-titles/apply' && c.body.proposalId === 'proposal-1'));
    check('C12. 确认成功后关闭确认框', () =>
      w.win.document.getElementById('confirmLayer').hidden === true);
    w.close();
  }
  {
    const w = await makeSidebarWorld(() => jsonResponse({
      ok: true, requiresConfirmation: true,
      proposal: { id: 'proposal-2', title: 'AI 新标题', currentTitle: '用户手动标题' },
    }));
    const pending = w.win.generateAiTitle({ scope: 'classic', id: ID1 });
    await tick();
    w.win.document.getElementById('confirmCard').querySelector('.btn').click();
    const result = await pending;
    check('C13. 取消确认 → 不应用、不调用 apply', () =>
      result.code === 'cancelled' && w.titleText(S1) === '旧标题'
      && !w.calls.some((c) => c.url === '/api/session-titles/apply'));
    w.close();
  }
  {
    const w = await makeSidebarWorld((call) => {
      if (call.url === '/api/session-titles/generate') {
        return jsonResponse({ ok: false, code: 'unsupported', error: '当前 Pi 版本不支持独立模型调用，标题未生成' });
      }
      if (call.url === '/api/session-titles/settings') {
        return jsonResponse({
          ok: true, settings: { autoEnabled: true }, capability: { supported: false, reason: '不支持' },
          model: { label: '跟随当前会话' },
        });
      }
      return jsonResponse({ ok: true });
    });
    await w.win.generateAiTitle({ scope: 'classic', id: ID1 });
    await tick();
    check('C14. 后端报不支持时强制刷新能力', () =>
      w.win.titleCapability().supported === false
      && w.calls.some((c) => c.url === '/api/session-titles/settings'));
    w.close();
  }
  {
    const w = await makeSidebarWorld(() => jsonResponse({ ok: true, applied: true, title: '并行标题', source: 'manual', sessionId: S1, revision: 2 }));
    const runtimeRow = w.addRuntimeRow(C1);
    const result = await w.win.generateAiTitle({ scope: 'runtime', conversationId: C1 });
    const generateCall = w.calls.find((c) => c.url === '/api/session-titles/generate');
    check('C15. Runtime 目标发送 conversationId，不发送路径', () =>
      result.ok === true && JSON.stringify(generateCall.body) === JSON.stringify({ scope: 'runtime', conversationId: C1 }));
    check('C16. Runtime 手动结果同样就地更新', () =>
      runtimeRow.querySelector('.pj-sess-title').textContent === '并行标题');
    w.close();
  }

  /* ================= E. 任意会话重命名与修订保护 ================= */
  section('E. 任意会话重命名与修订保护');
  {
    /* 修订门槛：迟到的 SSE / 旧列表不能把已经采纳的新标题改回去。 */
    const w = await makeSidebarWorld();
    w.win.handleSessionTitleEvent({ type: 'session_title', scope: 'classic', sessionId: S1, title: '新事件标题', source: 'manual', revision: 3 });
    const top = w.topTitle();
    w.win.handleSessionTitleEvent({ type: 'session_title', scope: 'classic', sessionId: S1, title: '迟到的旧标题', source: 'auto', revision: 2 });
    check('E1. 低修订的迟到 SSE 被丢弃（不改行、不改顶部）', () =>
      w.titleText(S1) === '新事件标题' && w.topTitle() === top);
    w.win.handleSessionTitleEvent({ type: 'session_title', scope: 'classic', sessionId: S1, title: '同一修订的另一标题', source: 'auto', revision: 3 });
    check('E2. 同修订不同内容的事件被丢弃（不是「同修订就幂等」）', () =>
      w.titleText(S1) === '新事件标题');
    w.win.handleSessionTitleEvent({ type: 'session_title', scope: 'classic', sessionId: S1, title: '新事件标题', source: 'manual', revision: 3 });
    check('E3. 同修订同内容是幂等的', () => w.titleText(S1) === '新事件标题');
    /* 旧列表响应（titleRevision 1）晚于事件回来：必须让位于已采纳的修订。 */
    const projectEl = w.win.document.querySelector('.project');
    await w.win.renderSidebarSessions(projectEl, { path: 'C:/p' });
    check('E4. 旧列表快照不会覆盖更新的标题（含顶部）', () =>
      w.titleText(S1) === '新事件标题' && w.topTitle() === '新事件标题');
    w.close();
  }
  {
    const w = await makeSidebarWorld((call) => {
      if (call.url === '/api/session-titles/rename') {
        const sessionId = call.body.id === ID2 ? S2 : S1;
        return jsonResponse({
          ok: true, applied: true, title: call.body.title, source: 'manual',
          sessionId, revision: (call.body.expectedRevision || 0) + 1,
        });
      }
      return jsonResponse({ ok: true });
    });
    const cur = w.row(S1);
    const openRenameIn = async (world, row) => {
      row.querySelector('.pj-sess-menu-trigger').click();
      await tick();
      const menu = world.win.document.getElementById('actionMenu');
      const item = menu && [...menu.querySelectorAll('[role="menuitem"]')]
        .find((b) => b.querySelector('.action-menu-label')?.textContent === '重命名');
      item?.click();
      await tick();
      return row.querySelector('.pj-sess-input');
    };
    const openRename = (row) => openRenameIn(w, row);
    const key = (input, name) => input.dispatchEvent(new input.ownerDocument.defaultView.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

    /* ---------- 当前会话：行内编辑的完整输入语义 ---------- */
    let input = await openRename(cur);
    check('E5. 三点菜单里的重命名直接进入行内编辑（当前标题、选中全部）', () =>
      Boolean(input) && input.value === '旧标题' && w.win.document.activeElement === input
      && input.selectionStart === 0 && input.selectionEnd === input.value.length);
    input.value = '   ';
    key(input, 'Enter');
    await tick();
    check('E6. 空白不提交：恢复原标题、不发请求', () =>
      !cur.querySelector('.pj-sess-input') && w.calls.every((c) => c.url !== '/api/session-titles/rename'));

    input = await openRename(cur);
    input.value = '未保存的名字';
    key(input, 'Escape');
    await tick();
    check('E7. Escape 取消：恢复原标题、不发请求', () =>
      !cur.querySelector('.pj-sess-input') && w.titleText(S1) === '旧标题'
      && w.calls.every((c) => c.url !== '/api/session-titles/rename'));

    input = await openRename(cur);
    input.value = '旧标题';
    input.dispatchEvent(new w.win.Event('blur'));
    await tick();
    check('E8. 失焦但内容没变：不提交', () =>
      !cur.querySelector('.pj-sess-input') && w.calls.every((c) => c.url !== '/api/session-titles/rename'));

    input = await openRename(cur);
    input.value = '  我的   新标题  ';
    key(input, 'Enter');
    await tick();
    await tick();
    const renameCall = w.calls.find((c) => c.url === '/api/session-titles/rename');
    check('E9. 保存只带稳定身份 + 项目 + 修订，不带文件路径', () =>
      JSON.stringify(renameCall?.body) === JSON.stringify({
        scope: 'classic', id: ID1, project: 'C:/p', title: '我的 新标题', expectedRevision: 1,
      }));
    check('E10. 成功后原地更新行与顶部，不重画列表', () =>
      w.row(S1) === cur && w.titleText(S1) === '我的 新标题' && w.topTitle() === '我的 新标题');
    check('E11. 重命名不切换会话、不重启 Pi', () =>
      !w.calls.some((c) => /\/api\/sessions\/(switch|new)/.test(c.url) || /restart/i.test(c.url)));

    /* ---------- 变更保存期间再点别的行，也只作用于原目标 ---------- */
    {
      let release;
      const slow = await makeSidebarWorld((call) => {
        if (call.url === '/api/session-titles/rename') {
          return new Promise((resolve) => {
            release = () => resolve(jsonResponse({
              ok: true, applied: true, title: call.body.title, source: 'manual',
              sessionId: call.body.id === ID2 ? S2 : S1, revision: 2,
            }));
          });
        }
        return jsonResponse({ ok: true });
      });
      const row1 = slow.row(S1);
      row1.querySelector('.pj-sess-menu-trigger').click();
      await tick();
      const slowMenu = slow.win.document.getElementById('actionMenu');
      [...slowMenu.querySelectorAll('[role="menuitem"]')]
        .find((b) => b.querySelector('.action-menu-label')?.textContent === '重命名')?.click();
      await tick();
      const input1 = row1.querySelector('.pj-sess-input');
      input1.value = '改名中的标题';
      key(input1, 'Enter');
      slow.row(S2).querySelector('.pj-sess-primary').click();
      await tick();
      release();
      await tick();
      await tick();
      check('E12. 保存期间切到别的行，结果仍落在原目标，不污染新行', () =>
        slow.titleText(S1) === '改名中的标题' && slow.titleText(S2) === '另一个会话');
      slow.close();
    }

    /* ---------- 修订冲突：采纳权威值，下一次重试带新修订 ---------- */
    {
      const conflict = await makeSidebarWorld((call) => {
        if (call.url !== '/api/session-titles/rename') return jsonResponse({ ok: true });
        if (call.body.expectedRevision === 1) {
          return jsonResponse({
            ok: false, code: 'revision_conflict', title: '别处改过的标题', revision: 5,
            error: '标题已经被修改，请基于最新标题重试',
          });
        }
        return jsonResponse({
          ok: true, applied: true, title: call.body.title, source: 'manual', sessionId: S1, revision: 6,
        });
      });
      const row = conflict.row(S1);
      const first = await openRenameIn(conflict, row);
      first.value = '我的标题';
      key(first, 'Enter');
      await tick();
      await tick();
      check('E13. 修订冲突时采纳后端的权威标题，并给出可重试反馈', () =>
        conflict.titleText(S1) === '别处改过的标题' && !row.querySelector('.pj-sess-input')
        && conflict.toastTexts().some((t) => t.includes('已经被修改')));
      const second = await openRenameIn(conflict, row);
      second.value = '我的标题';
      key(second, 'Enter');
      await tick();
      await tick();
      const retry = conflict.calls.filter((c) => c.url === '/api/session-titles/rename').pop();
      check('E14. 重试使用冲突后返回的新修订，而不是旧修订', () =>
        retry?.body.expectedRevision === 5 && conflict.titleText(S1) === '我的标题');
      conflict.close();
    }

    /* ---------- 未打开的历史会话：直接改名，不激活 ---------- */
    {
      const other = w.row(S2);
      const before = w.topTitle();
      const histInput = await openRename(other);
      histInput.value = '历史会话新标题';
      key(histInput, 'Enter');
      await tick();
      await tick();
      const histCall = w.calls.filter((c) => c.url === '/api/session-titles/rename').pop();
      check('E15. 未打开的历史会话可直接改名（不 switch、不影响当前会话）', () =>
        histCall?.body.id === ID2 && histCall?.body.project === 'C:/p'
        && w.titleText(S2) === '历史会话新标题' && w.titleText(S1) === '我的 新标题'
        && w.topTitle() === before
        && !w.calls.some((c) => /\/api\/sessions\/switch/.test(c.url)));
    }

    /* ---------- 其它项目的预览行：项目身份由调用方给出 ---------- */
    {
      const previewSession = {
        id: ID2, title: '预览旧标题', sessionId: S2, current: false, pending: false, archived: false,
        messageCount: 1, updatedAt: 1,
      };
      const preview = w.win.createSidebarPreviewRow(previewSession, () => {}, 'C:/other');
      w.win.document.getElementById('projects').append(preview);
      const previewInput = await openRename(preview);
      previewInput.value = '预览新标题';
      key(previewInput, 'Enter');
      await tick();
      await tick();
      const previewCall = w.calls.filter((c) => c.url === '/api/session-titles/rename').pop();
      check('E16. 非当前项目的预览行可直接改名，项目身份来自可信调用参数', () =>
        previewCall?.body.id === ID2 && previewCall?.body.project === 'C:/other'
        && preview.querySelector('.pj-sess-title').textContent === '预览新标题');
    }

    /* ---------- 已归档会话：展开后同样可改名 ---------- */
    {
      w.sessions[1].archived = true;
      w.sessions[1].title = '归档旧标题';
      w.sessions[1].titleRevision = 1;
      const projectEl = w.win.document.querySelector('.project');
      await w.win.renderSidebarSessions(projectEl, { path: 'C:/p' });
      const toggle = w.win.document.querySelector('.pj-sess-arch-toggle');
      toggle?.click();
      await tick();
      const archivedRow = [...w.win.document.querySelectorAll('.pj-sessions .pj-sess[data-session-id]')]
        .find((r) => r.dataset.sessionId === S2);
      const archivedInput = archivedRow && await openRename(archivedRow);
      check('E17. 已归档会话展开后有重命名入口', () => Boolean(archivedInput));
      if (archivedInput) {
        archivedInput.value = '归档后改名';
        key(archivedInput, 'Enter');
        await tick();
        await tick();
        const archivedCall = w.calls.filter((c) => c.url === '/api/session-titles/rename').pop();
        const archivedTitleEl = [...w.win.document.querySelectorAll('.pj-sessions .pj-sess[data-session-id]')]
          .find((r) => r.dataset.sessionId === S2)?.querySelector('.pj-sess-title');
        check('E18. 已归档会话改名成功，仍不激活会话', () =>
          archivedCall?.body.id === ID2
          && archivedTitleEl?.textContent === '归档后改名'
          && !w.calls.some((c) => /\/api\/sessions\/switch/.test(c.url)));
      } else {
        check('E18. 已归档会话改名成功，仍不激活会话', () => '上一条已失败');
      }
    }
    w.close();
  }

  /* ================= D. 接入点静态边界 ================= */
  section('D. 接入点静态边界');
  {
    const appSrc = read('public/app.js');
    const sessionsSrc = read('public/sessions.js');
    const appearanceSrc = read('public/appearance.js');
    const styles = read('public/styles.css');
    const rpcSrc = read('public/rpc.js');

    check('D1. app.js 在项目 / bridgeRun 过滤之前路由标题事件', () => {
      const start = appSrc.indexOf('function handleEvent(evt)');
      const end = appSrc.indexOf('switch (evt.type)', start);
      const body = start >= 0 && end > start ? appSrc.slice(start, end) : '';
      const route = body.indexOf("evt.type === 'session_title'");
      return route > 0 && body.indexOf('!S.hasProject') > route && body.indexOf('acceptSubagentEvent') > route;
    });
    check('D2. 启动时加载标题设置，失败不阻塞', () =>
      /void loadSessionTitleSettings\(\);/.test(appSrc)
      && /import \{ handleSessionTitleEvent, loadSessionTitleSettings \}/.test(appSrc));
    check('D3. 会话菜单复用 generateAiTitle，能力为否时整项隐藏', () =>
      /function aiTitleMenuItems\(s, project\)[\s\S]{0,200}titleCapability\(\)\.supported === false\) return \[\]/.test(sessionsSrc)
      && /generateAiTitle\(\{ scope: 'classic'/.test(sessionsSrc));
    check('D4. 生成中禁用入口（防重复点击）', () =>
      /isTitleGenerating\(key\)/.test(sessionsSrc)
      && /disabled: busy \|\| noId/.test(sessionsSrc));
    check('D5. 标题事件就地更新（没有 paintList / 重排）', () => {
      const start = sessionsSrc.indexOf("document.addEventListener('pi-gui:classic-title'");
      const end = start >= 0 ? sessionsSrc.indexOf('\n});', start) : -1;
      const listener = start >= 0 && end > start ? sessionsSrc.slice(start, end) : '';
      return listener.length > 0 && !listener.includes('paintList') && listener.includes('pj-sess-title');
    });
    check('D6. 首条消息的兜底标题只改 titleSource=default 的当前会话', () => {
      const start = sessionsSrc.indexOf("document.addEventListener('pi-gui:classic-prompt-sent'");
      const end = start >= 0 ? sessionsSrc.indexOf('\n});', start) : -1;
      const listener = start >= 0 && end > start ? sessionsSrc.slice(start, end) : '';
      return /target\.titleSource !== 'default'/.test(listener)
        && /target\.title = title/.test(listener) && !listener.includes('paintList');
    });
    check('D7. rpc.js 在首条 prompt 成功后才发兜底标题事件', () =>
      /promptSent = result\?\.ok === true/.test(rpcSrc)
      && /pi-gui:classic-prompt-sent/.test(rpcSrc)
      && /if \(promptSent && text\)/.test(rpcSrc));
    check('D8. 「常规」页新增会话标题卡，复用 Settings 原语与真实开关', () =>
      appearanceSrc.includes("title: '会话标题'")
      && appearanceSrc.includes("label: '自动生成会话标题'")
      && appearanceSrc.includes("label: '标题生成模型'")
      && appearanceSrc.includes('createSettingsToggle')
      && appearanceSrc.includes('setAutoSessionTitle(next)'));
    check('D9. 开关保存失败会拨回原值并说明原因', () =>
      /autoTitleToggle\.setChecked\(!next\)/.test(appearanceSrc)
      && /result\.error \|\| '会话标题设置未能保存/.test(appearanceSrc));
    check('D10. 没有可配置模型时不放假选择器：模型行是只读值', () => {
      const row = appearanceSrc.slice(appearanceSrc.indexOf("label: '标题生成模型'"), appearanceSrc.indexOf("label: '标题生成模型'") + 500);
      return row.includes('modelValue') && !row.includes('<select') && !row.includes('createSegmentedControl');
    });
    check('D11. 标题卡沿用设置页的间距节奏与主题 Token', () =>
      /\.appearance-title-card \.settings-row/.test(styles)
      && /\.session-title-model-value\s*\{[\s\S]{0,160}var\(--ds-text-secondary\)/.test(styles));
    check('D12. 没有为标题新建页面 / 路由，也没有第二套生成器', () =>
      !/session-title(s)?\.html/.test(appSrc)
      && !/openSessionTitlePage/.test(appSrc + sessionsSrc));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error('session-title-ui 测试失败：', err && err.stack ? err.stack : err);
  process.exit(1);
});
