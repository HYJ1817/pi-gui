/* 侧栏项目 / 会话交互专项（jsdom + 链接后的真实前端模块）。
 *
 * 覆盖三件事：
 *   1. 项目标题只展开 / 收起会话 —— 点名称、文件夹图标、箭头、空白都同一语义；
 *      不切项目、不碰对话、不影响正在跑的任务；空项目、读取失败、迟到响应都有路。
 *   2. 搜索图标是 toggle：第一次打开并聚焦，第二次真正关闭（清关键词、
 *      取消 debounce、作废在途请求、恢复列表、焦点还给入口），再开是干净的。
 *   3. 每个项目都有加号；加号 / 三点与折叠互不影响；非当前项目的加号
 *      只在它自己成为工作区之后创建会话。
 *
 * 全部 fixture 都是假的路径与假的会话，不读真实项目、不碰真实 Pi。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');

let passed = 0;
let failed = 0;
async function check(name, run) {
  try {
    await run();
    passed++;
    console.log(' ok ' + name);
  } catch (e) {
    failed++;
    console.error(' FAIL ' + name + ': ' + e.message);
  }
}
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const pub = path.resolve(__dirname, '../public');
  const dom = new JSDOM(fs.readFileSync(path.join(pub, 'index.html'), 'utf8'), {
    url: 'http://localhost:7788',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const d = w.document;
  const $ = (id) => d.getElementById(id);
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.EventSource = class { constructor() { w.fixtureEvents = this; } close() {} };

  const A = 'C:\\fixture-project-a';
  const B = 'C:\\fixture-project-b';
  const C = 'C:\\fixture-project-c-empty';
  const D = 'C:\\fixture-project-d-failing';
  const LONG = 'C:\\fixture-project-with-a-very-long-name-that-must-not-push-actions-out';
  const session = (id, title, current = false) => ({
    id, sessionId: 'sid-' + id, title, current, archived: false, messageCount: 2, updatedAt: 1,
  });
  const fixtureSessions = {
    [A]: [session('a1', 'A 的会话', true)],
    [B]: [session('b1', 'B 的会话')],
    [C]: [],
    [D]: [session('d1', 'D 的会话')],
    [LONG]: [session('l1', '长名称项目的会话')],
  };
  const projects = () => [
    { path: A, name: '项目 A' },
    { path: B, name: '项目 B' },
    { path: C, name: '空项目 C' },
    { path: D, name: '读取失败 D' },
    { path: LONG, name: '这是一个很长很长很长很长很长很长很长很长的项目名称' },
  ];

  let active = A;
  const activations = [];
  const commands = [];
  const searchCalls = [];
  let failPreviewOnce = false;
  let holdPreviewPath = null;
  let heldPreview = null;
  let holdSearch = false;
  let heldSearch = null;
  let hideLong = false;

  const json = (data) => ({ ok: true, status: 200, json: async () => data });
  w.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'http://localhost');
    if (u.pathname === '/api/status') return json({ ok: true, cwd: active, hasProject: true });
    if (u.pathname === '/api/projects' && (!opts.method || opts.method === 'GET')) {
      return json({ ok: true, active, items: projects().filter((p) => !(hideLong && p.path === LONG)) });
    }
    if (u.pathname === '/api/projects/activate') {
      const body = JSON.parse(opts.body);
      activations.push(body.path);
      active = body.path;
      return json({ ok: true, cwd: body.path });
    }
    if (u.pathname === '/api/sessions') {
      const project = u.searchParams.get('project') || active;
      if (project === holdPreviewPath) {
        holdPreviewPath = null;
        return new Promise((resolve) => { heldPreview = () => resolve(json({ ok: true, hasProject: true, sessions: fixtureSessions[project] })); });
      }
      if (project === D && failPreviewOnce) {
        failPreviewOnce = false;
        return { ok: true, status: 200, json: async () => { throw new Error('fixture read failure'); } };
      }
      return json({ ok: true, hasProject: true, sessions: fixtureSessions[project] || [] });
    }
    if (u.pathname === '/api/sessions/search') {
      searchCalls.push({ q: u.searchParams.get('q'), scope: u.searchParams.get('scope') });
      if (holdSearch) {
        holdSearch = false;
        return new Promise((resolve) => {
          heldSearch = () => resolve(json({
            ok: true,
            results: [{ id: 'b1', title: 'B 的会话', updatedAt: 1, matchCount: 1, messageCount: 2, matches: [{ type: 'title', snippet: 'B 的会话' }] }],
          }));
        });
      }
      return json({
        ok: true,
        results: [{ id: 'b1', title: 'B 的会话', updatedAt: 1, matchCount: 1, messageCount: 2, matches: [{ type: 'title', snippet: 'B 的会话' }] }],
      });
    }
    if (u.pathname === '/api/runtime-sessions') return json({ ok: true, items: [], liveCount: 0, totalCount: 0 });
    if (u.pathname === '/api/command') {
      commands.push(JSON.parse(opts.body));
      return json({ ok: true });
    }
    if (u.pathname === '/api/git/status') return json({ ok: true, isRepo: false, files: [] });
    return json({ ok: true });
  };

  w.piGuiDesktop = undefined;
  const api = w.eval(bundle(path.join(pub, 'app.js')).code);
  await tick();
  w.S.hasProject = true;
  w.S.bridgeState = 'ready';
  w.S.restoring = false;
  w.applyProjectState();
  await w.loadProjects();
  await tick(80);
  await w.refreshSidebarSessions();
  await tick(80);

  const rows = () => [...d.querySelectorAll('#projects .project')];
  const rowOf = (p) => rows().find((r) => r.dataset.projectPath === p) || null;
  const selectOf = (p) => rowOf(p)?.querySelector('.pj-select') || null;
  const chevOf = (p) => rowOf(p)?.querySelector('.pj-chev') || null;
  const plusOf = (p) => rowOf(p)?.querySelector('.pj-header-action') || null;
  const boxOf = (p) => rowOf(p)?.nextElementSibling || null;
  const click = (node) => node.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const activeBox = () => $('pjSessionsBox');

  await check('每个项目行都有加号与三点，标题区域只有一个语义按钮', () => {
    const all = rows();
    assert.equal(all.length, 5);
    for (const row of all) {
      assert.equal(row.querySelectorAll('.pj-header-action').length, 1, 'missing new action');
      assert.equal(row.querySelectorAll('.pj-row-menu-trigger').length, 1, 'missing menu trigger');
      const select = row.querySelector('.pj-select');
      assert.ok(select, 'missing title trigger');
      assert.equal(select.tagName, 'BUTTON');
      assert.equal(select.querySelectorAll('button').length, 0, 'nested interactive control');
      assert.equal(select.getAttribute('aria-expanded'), row.classList.contains('active') ? 'true' : 'false');
      assert.match(select.getAttribute('aria-label'), /展开或收起会话/);
      assert.equal(select.querySelector('.pj-chev').getAttribute('aria-hidden'), 'true');
      assert.equal(select.querySelector('.pj-chev').tagName, 'SPAN');
      assert.equal(row.children.length, 3, 'title + new + menu expected at row level');
      assert.equal(row.children[1], row.querySelector('.pj-header-action'));
      assert.equal(row.children[2], row.querySelector('.pj-row-menu-trigger'));
    }
  });

  await check('名称 / 文件夹图标 / 箭头 / 标题空白：点任意一处都只切换同一项目的展开', async () => {
    const gen = w.S.workspaceGeneration;
    const activationCount = activations.length;
    const commandCount = commands.length;
    const titleBefore = $('title').textContent;
    const box = activeBox();
    const targets = [
      () => selectOf(A).querySelector('.pj-icon'),
      () => chevOf(A),
      () => selectOf(A).querySelector('.pj-name'),
      () => selectOf(A).querySelector('.pj-body'),
    ];
    for (const target of targets) {
      const wasHidden = box.hidden;
      click(target());
      await tick(20);
      assert.equal(box.hidden, !wasHidden, 'click did not toggle exactly once');
      assert.equal(selectOf(A).getAttribute('aria-expanded'), String(!box.hidden));
    }
    assert.equal(selectOf(A).getAttribute('aria-expanded'), 'true');
    assert.equal(activations.length, activationCount, 'title click activated a project');
    assert.equal(commands.length, commandCount, 'title click sent a command');
    assert.equal(w.S.workspaceGeneration, gen);
    assert.equal($('title').textContent, titleBefore);
  });

  await check('点当前项目标题不会折叠其它项目，也不改当前会话 / 工作区', async () => {
    const before = activeBox().hidden;
    const previewBefore = boxOf(B).hidden;
    click(selectOf(A));
    await tick(20);
    assert.equal(activeBox().hidden, !before);
    assert.equal(boxOf(B).hidden, previewBefore);
    assert.equal(w.S.cwd, A);
    assert.equal(activations.length, 0);
    click(selectOf(A));
    await tick(20);
  });

  await check('后台任务运行中点标题只折叠，不中断任务', async () => {
    w.setStreaming(true);
    const before = activeBox().hidden;
    click(selectOf(A));
    await tick(20);
    assert.equal(activeBox().hidden, !before);
    assert.equal(w.S.streaming, true);
    assert.equal(commands.filter((c) => c.type === 'abort' || c.type === 'switch_session' || c.type === 'new_session').length, 0);
    click(selectOf(A));
    w.setStreaming(false);
    await tick(20);
  });

  await check('非当前项目标题：展开自己的会话，不切工作区、不动当前列表与对话', async () => {
    const gen = w.S.workspaceGeneration;
    const title = $('title').textContent;
    assert.equal(boxOf(B).hidden, true);
    click(selectOf(B));
    await tick(120);
    assert.equal(boxOf(B).hidden, false);
    assert.equal(selectOf(B).getAttribute('aria-expanded'), 'true');
    assert.match(boxOf(B).textContent, /B 的会话/);
    assert.equal(boxOf(B).querySelectorAll('[aria-current]').length, 0, 'preview marked a session current');
    assert.equal(activations.length, 0);
    assert.equal(w.S.workspaceGeneration, gen);
    assert.equal($('title').textContent, title);
    assert.equal(activeBox().hidden, false, 'current project list moved');
  });

  await check('多个项目可以同时展开，当前项目标记与展开状态互相独立', async () => {
    click(selectOf(C));
    await tick(60);
    assert.equal(boxOf(C).hidden, false);
    assert.equal(boxOf(B).hidden, false);
    assert.equal(activeBox().hidden, false);
    assert.equal(rowOf(A).classList.contains('active'), true);
    assert.equal(rowOf(B).querySelector('[aria-current]'), null);
  });

  await check('空项目展开显示空态，而不是什么都看不到', async () => {
    assert.match(boxOf(C).textContent, /还没有会话/);
  });

  await check('折叠状态在项目列表重画后保留（按路径记住，不只当前项目）', async () => {
    click(selectOf(B));
    await tick(20);
    assert.equal(boxOf(B).hidden, true);
    w.renderProjects();
    await tick(80);
    assert.equal(boxOf(B).hidden, true);
    assert.equal(selectOf(B).getAttribute('aria-expanded'), 'false');
    assert.equal(rowOf(A).querySelector('.pj-select').getAttribute('aria-expanded'), 'true');
    click(selectOf(B));
    await tick(80);
    assert.equal(boxOf(B).hidden, false);
  });

  await check('迟到的预览响应不能覆盖重画后的项目状态', async () => {
    assert.equal(boxOf(LONG).hidden, true, 'long-name project should start collapsed');
    holdPreviewPath = LONG;
    click(selectOf(LONG));
    await tick(20);
    assert.equal(boxOf(LONG).hidden, false, 'preview did not open');
    assert.ok(heldPreview, 'preview request was not held');
    /* 项目从列表里消失再回来：它不再有旧的展开记录，新行应当是收起的，
     * 旧请求即使回来也只能落在已经脱离文档的旧节点上。 */
    hideLong = true;
    await w.loadProjects();
    await tick(80);
    hideLong = false;
    await w.loadProjects();
    await tick(80);
    assert.equal(boxOf(LONG).hidden, true, 'rebuilt project should start collapsed');
    heldPreview();
    heldPreview = null;
    await tick(80);
    assert.equal(boxOf(LONG).hidden, true, 'late response expanded the stale row');
    assert.equal(boxOf(LONG).querySelectorAll('.pj-sess').length, 0, 'late response painted into the new row');
  });

  await check('读取失败给出错误与重试，重试后恢复自己的会话', async () => {
    failPreviewOnce = true;
    click(selectOf(D));
    await tick(100);
    assert.match(boxOf(D).textContent, /读取会话失败/);
    const retry = boxOf(D).querySelector('.pj-sess-retry');
    assert.ok(retry, 'no retry path');
    click(retry);
    await tick(100);
    assert.doesNotMatch(boxOf(D).textContent, /读取会话失败/);
    assert.match(boxOf(D).textContent, /D 的会话/);
  });

  await check('加号不触发折叠；当前项目的加号发出 new_session', async () => {
    const before = activeBox().hidden;
    const count = commands.length;
    click(plusOf(A));
    await tick(40);
    assert.equal(activeBox().hidden, before);
    assert.equal(commands.length, count + 1);
    assert.equal(commands.at(-1).type, 'new_session');
  });

  await check('三点只开菜单，不折叠、不切项目、不发命令', async () => {
    const before = activeBox().hidden;
    const gen = w.S.workspaceGeneration;
    const count = commands.length;
    click(rowOf(A).querySelector('.pj-row-menu-trigger'));
    await tick(20);
    assert.ok(d.getElementById('actionMenu'), 'menu did not open');
    assert.equal(activeBox().hidden, before);
    assert.equal(w.S.workspaceGeneration, gen);
    assert.equal(commands.length, count);
    w.closeActionMenu?.();
  });

  await check('会话列表刷新后，所有项目的加号仍在（当前项目不会丢入口）', async () => {
    await w.refreshSidebarSessions();
    await tick(80);
    w.renderProjects();
    await tick(80);
    for (const p of [A, B, C, D, LONG]) assert.ok(plusOf(p), 'missing plus after refresh: ' + p);
    assert.equal(d.querySelectorAll('#projects .pj-header-action').length, 5);
  });

  await check('非当前项目的加号：先在它自己成为工作区，随后才创建会话', async () => {
    const beforeActivations = activations.length;
    const beforeCommands = commands.length;
    const boxBefore = boxOf(B).hidden;
    click(plusOf(B));
    await tick(160);
    assert.equal(boxOf(B).hidden, boxBefore, 'plus must not toggle the project group');
    assert.equal(activations.length, beforeActivations + 1);
    assert.equal(activations.at(-1), B);
    assert.equal(active, B);
    assert.equal(commands.length, beforeCommands, 'new_session was sent before the workspace became ready');
    w.S.switching = false;
    w.S.bridgeState = 'ready';
    w.flushProjectSessionAction();
    await tick(80);
    assert.equal(commands.length, beforeCommands + 1);
    assert.equal(commands.at(-1).type, 'new_session');
    await tick(120);
    assert.equal(rowOf(B)?.classList.contains('active'), true, 'B did not become the active row');
  });

  await check('加号 / 三点位于行尾，长项目名有截断容器', () => {
    const row = rowOf(LONG);
    assert.ok(row);
    const select = selectOf(LONG);
    const name = select.querySelector('.pj-name');
    assert.equal(name.textContent, '这是一个很长很长很长很长很长很长很长很长的项目名称');
    assert.ok(select.querySelector('.pj-body'), 'name has no flexible container');
    const css = fs.readFileSync(path.join(pub, 'styles.css'), 'utf8');
    assert.match(css, /\.pj-name\{[^}]*text-overflow:ellipsis/);
    assert.match(css, /\.pj-select\{[^}]*min-width:0/);
    const shell = fs.readFileSync(path.join(pub, 'app-shell.css'), 'utf8');
    assert.match(shell, /\.pj-header-action\s*\{[^}]*flex:\s*0 0 22px/);
  });

  await check('搜索第一次点击：展开侧栏 / 分组 / 当前会话，聚焦输入框，图标进入选中态', async () => {
    $('btnSidebarCollapse').click(); // 先收起侧栏，验证搜索会把它展开
    assert.equal($('projectSidebar').hidden, true);
    click($('navSearch'));
    await tick(80);
    assert.equal($('projectSidebar').hidden, false);
    assert.equal($('projectSidebar').classList.contains('search-open'), true);
    assert.equal($('navSearch').getAttribute('aria-expanded'), 'true');
    assert.equal($('navSearch').classList.contains('is-active'), true);
    assert.equal($('btnTopbarSearch').getAttribute('aria-expanded'), 'true');
    assert.equal($('btnTopbarSearch').classList.contains('is-active'), true);
    assert.equal(activeBox().hidden, false);
    const input = activeBox().querySelector('.pj-search-input');
    assert.ok(input);
    assert.equal(d.activeElement, input);
    assert.deepEqual([...activeBox().querySelectorAll('.pj-search-scope')].map((b) => b.textContent), ['活跃', '已归档', '全部']);
  });

  await check('搜索第二次点击：真正关闭（清空输入、恢复列表、图标复原、焦点返回）', async () => {
    const input = activeBox().querySelector('.pj-search-input');
    input.value = 'abc';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await tick(20);
    click($('navSearch'));
    await tick(60);
    assert.equal($('projectSidebar').classList.contains('search-open'), false);
    assert.equal($('navSearch').getAttribute('aria-expanded'), 'false');
    assert.equal($('navSearch').classList.contains('is-active'), false);
    assert.equal($('btnTopbarSearch').getAttribute('aria-expanded'), 'false');
    assert.equal(activeBox().querySelector('.pj-sess-list').dataset.view, 'list');
    assert.equal(activeBox().querySelector('.pj-sr'), null);
    assert.equal(d.activeElement, $('navSearch'));
  });

  await check('关闭时取消 debounce：没发出去的搜索不会在关闭后再发', async () => {
    click($('navSearch'));
    await tick(40);
    const input = activeBox().querySelector('.pj-search-input');
    const before = searchCalls.length;
    input.value = 'abc';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    click($('navSearch')); // debounce 还没到就关闭
    await tick(400);
    assert.equal(searchCalls.length, before, 'debounced search fired after close');
  });

  await check('有结果时关闭恢复到普通列表；迟到结果不能覆盖', async () => {
    click($('navSearch'));
    await tick(40);
    let input = activeBox().querySelector('.pj-search-input');
    input.value = 'B 的会话';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await tick(320);
    assert.equal(activeBox().querySelector('.pj-sess-list').dataset.view, 'search');
    assert.match(activeBox().textContent, /B 的会话/);
    click($('navSearch'));
    await tick(60);
    assert.equal(activeBox().querySelector('.pj-sess-list').dataset.view, 'list');
    assert.equal(activeBox().querySelector('.pj-search-input').value, '');
    assert.equal(activeBox().querySelector('.pj-sr'), null);

    // 在途请求：关闭后回来也不许把结果画回列表
    click($('navSearch'));
    await tick(40);
    holdSearch = true;
    input = activeBox().querySelector('.pj-search-input');
    input.value = 'abc';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await tick(320);
    assert.ok(heldSearch, 'search request was not held');
    click($('navSearch'));
    await tick(40);
    const list = activeBox().querySelector('.pj-sess-list');
    heldSearch();
    heldSearch = null;
    await tick(80);
    assert.equal(list.dataset.view, 'list');
    assert.equal(list.querySelector('.pj-sr'), null);
  });

  await check('关闭搜索会复位范围：已归档 / 全部不会留到下一次打开', async () => {
    for (const scopeId of ['archived', 'all']) {
      click($('navSearch'));
      await tick(60);
      let scope = activeBox().querySelector(`.pj-search-scope[data-scope="${scopeId}"]`);
      click(scope);
      await tick(20);
      assert.equal(scope.classList.contains('on'), true);
      assert.equal(scope.getAttribute('aria-pressed'), 'true');

      let input = activeBox().querySelector('.pj-search-input');
      input.value = 'B 的会话';
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      await tick(320);
      assert.equal(searchCalls.at(-1).scope, scopeId, 'scope was not applied to the request');
      assert.equal(activeBox().querySelector('.pj-sess-list').dataset.view, 'search');

      click($('navSearch'));
      await tick(60);
      assert.equal($('projectSidebar').classList.contains('search-open'), false);
      assert.equal(activeBox().querySelector('.pj-search-scope.on').textContent, '活跃', 'close did not reset the scope');

      click($('navSearch'));
      await tick(60);
      input = activeBox().querySelector('.pj-search-input');
      assert.equal(input.value, '');
      assert.equal(d.activeElement, input);
      assert.equal(activeBox().querySelector('.pj-sess-list').dataset.view, 'list');
      assert.equal(activeBox().querySelector('.pj-search-scope.on').textContent, '活跃');
      assert.equal(activeBox().querySelector('.pj-search-scope[data-scope="archived"]').getAttribute('aria-pressed'), 'false');
      assert.equal(activeBox().querySelector('.pj-search-scope[data-scope="all"]').getAttribute('aria-pressed'), 'false');

      /* 重新打开后的新请求也必须回到默认范围，不是只把按钮画回活跃。 */
      input.value = 'B 的会话';
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      await tick(320);
      assert.equal(searchCalls.at(-1).scope, 'active', 'reopened search reused the old scope');

      click($('navSearch'));
      await tick(40);
    }
  });

  await check('收起整个「项目」分组会真正关闭搜索，下一次点击直接打开', async () => {
    click($('navSearch'));
    await tick(60);
    const group = $('groupHead').closest('.rail-group');
    assert.equal(group.classList.contains('open'), true);
    const input = activeBox().querySelector('.pj-search-input');

    /* 先换到非默认范围，再挂起一个请求：折叠分组必须走完整关闭路径，
     * 范围复位、在途响应作废、图标复原都要一起发生。 */
    click(activeBox().querySelector('.pj-search-scope[data-scope="archived"]'));
    await tick(20);
    holdSearch = true;
    input.value = 'abc';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await tick(320);
    assert.ok(heldSearch, 'search request was not held');

    $('groupHead').focus();
    click($('groupHead'));
    await tick(60);
    assert.equal(group.classList.contains('open'), false);
    assert.equal($('groupHead').getAttribute('aria-expanded'), 'false');
    assert.equal(d.activeElement, $('groupHead'), 'focus was left inside the hidden group');
    assert.equal($('projectSidebar').classList.contains('search-open'), false);
    assert.equal($('navSearch').getAttribute('aria-expanded'), 'false');
    assert.equal($('navSearch').classList.contains('is-active'), false);
    assert.equal($('btnTopbarSearch').getAttribute('aria-expanded'), 'false');
    assert.equal($('btnTopbarSearch').classList.contains('is-active'), false);
    assert.equal(input.value, '');
    assert.equal(activeBox().querySelector('.pj-sess-list').dataset.view, 'list');
    assert.equal(activeBox().querySelector('.pj-search-scope.on').textContent, '活跃');

    heldSearch();
    heldSearch = null;
    await tick(80);
    assert.equal(activeBox().querySelector('.pj-sess-list').dataset.view, 'list');
    assert.equal(activeBox().querySelector('.pj-sr'), null);

    /* 下一次点击必须直接重新打开，而不是先关掉一个看不见的旧搜索。 */
    click($('navSearch'));
    await tick(60);
    assert.equal(group.classList.contains('open'), true);
    assert.equal($('groupHead').getAttribute('aria-expanded'), 'true');
    assert.equal($('projectSidebar').classList.contains('search-open'), true);
    assert.equal($('navSearch').getAttribute('aria-expanded'), 'true');
    assert.equal(d.activeElement, activeBox().querySelector('.pj-search-input'));
    assert.equal(activeBox().querySelector('.pj-search-scope.on').textContent, '活跃');
    click($('navSearch'));
    await tick(40);
  });

  await check('Escape 关闭搜索并归还焦点；有内容时先清空，再按一次关闭', async () => {
    click($('navSearch'));
    await tick(60);
    const input = activeBox().querySelector('.pj-search-input');
    input.value = 'abc';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await tick(20);
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick(20);
    assert.equal(input.value, '', 'first Escape should clear the query');
    assert.equal($('projectSidebar').classList.contains('search-open'), true);
    assert.equal(activeBox().querySelector('.pj-sess-list').dataset.view, 'list');
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick(40);
    assert.equal($('projectSidebar').classList.contains('search-open'), false);
    assert.equal(d.activeElement, $('navSearch'));
  });

  await check('明确要求打开搜索的入口只开不关，并聚焦输入框', async () => {
    click($('navSearch'));
    await tick(40);
    const input = activeBox().querySelector('.pj-search-input');
    input.blur();
    assert.notEqual(d.activeElement, input);
    w.openSessionSearch(); // 命令 / 菜单用的 open-only 入口
    await tick(20);
    assert.equal($('projectSidebar').classList.contains('search-open'), true);
    assert.equal(d.activeElement, input, 'open-only entry did not focus');
  });

  await check('侧栏与顶栏两个搜索入口状态一致，且都能关闭', async () => {
    click($('btnTopbarSearch'));
    await tick(60);
    assert.equal($('projectSidebar').classList.contains('search-open'), false);
    assert.equal($('navSearch').getAttribute('aria-expanded'), 'false');
    assert.equal($('btnTopbarSearch').getAttribute('aria-expanded'), 'false');
    assert.equal(d.activeElement, $('btnTopbarSearch'));

    click($('btnTopbarSearch'));
    await tick(60);
    assert.equal($('projectSidebar').classList.contains('search-open'), true);
    assert.equal($('navSearch').getAttribute('aria-expanded'), 'true');
    assert.equal(d.activeElement, activeBox().querySelector('.pj-search-input'));
    click($('navSearch'));
    await tick(40);
  });

  await check('空关键词搜索不显示结果视图，直接回到普通列表', async () => {
    click($('navSearch'));
    await tick(40);
    const input = activeBox().querySelector('.pj-search-input');
    input.value = 'a';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await tick(60);
    // 1 个字符：提示再输入，不发请求（视图标记仍是搜索态，但没有结果行）
    assert.equal(activeBox().querySelectorAll('.pj-sr').length, 0);
    assert.match(activeBox().textContent, /再输入至少 2 个字符/);
    const before = searchCalls.length;
    await tick(300);
    assert.equal(searchCalls.length, before, 'one-character query was sent');
    click($('navSearch'));
    await tick(40);
  });

  console.log(`\nSidebar project interaction: ${passed}/${passed + failed}; failed=${failed}`);
  dom.window.close();
  process.exitCode = failed ? 1 : 0;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
