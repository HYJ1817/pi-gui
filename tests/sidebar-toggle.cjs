/* 侧边栏折叠/展开回归：真实加载 index.html + 前端模块图（jsdom）。
 *
 * 这里盯的是**结构**与**状态机**，不是样式排版：
 *   - 展开入口必须是 .stage-head 拖拽区内的 no-drag 子元素。它曾经是顶栏
 *     外面的覆盖层，原生标题栏命中测试把点击当成拖拽起手，按钮看着在却点不动。
 *     jsdom 不套用外部样式表、也不做原生 hit test，所以结构用 DOM + 源规则双重断言；
 *     真实几何与原生输入由 tests/app-shell-electron.cjs 覆盖。
 *   - 折叠/展开连续多轮、会话列表重绘后、窗口 resize 后都必须保持可用。
 *   - 图标、title、aria-expanded 必须与侧栏状态一致。
 * 不依赖真 pi：fetch / EventSource / ResizeObserver 全部是本地 fixture。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');

const PUB = path.resolve(__dirname, '../public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const appShellCss = fs.readFileSync(path.join(PUB, 'app-shell.css'), 'utf8');
const stylesCss = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');

let passed = 0, failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log(' ok ' + name); }
  catch (e) { failed++; console.error(' FAIL ' + name + ': ' + e.message); }
}
const tick = () => new Promise(r => setTimeout(r, 40));

function ruleBody(css, selector) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(clean);
  return match ? match[1] : '';
}

async function boot() {
  const dom = new JSDOM(html, { url: 'http://localhost:7788', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document, $ = id => d.getElementById(id);
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.EventSource = class { constructor() { w.fixtureEvents = this; } close() {} };
  w.fetch = async url => {
    const target = String(url);
    if (target === '/api/provider-management') {
      return { status: 422, ok: false, json: async () => ({ ok: false, code: 'unsupported', message: '管理能力未开放' }) };
    }
    return {
      ok: true,
      json: async () => {
        if (target === '/api/status') return { ok: true, cwd: 'C:\\fixture', hasProject: true };
        if (target === '/api/projects') return { ok: true, active: 'C:\\fixture', items: [{ name: 'Fixture', path: 'C:\\fixture' }] };
        if (target === '/api/runtime-sessions') return { ok: true, items: [] };
        if (target.startsWith('/api/worktrees')) return { ok: true, projectId: 'fixture-project', items: [] };
        if (target.startsWith('/api/plans')) return { ok: true, plans: [], relations: [] };
        if (target === '/api/sessions') return {
          ok: true,
          hasProject: true,
          sessions: [
            { id: 'fixture-session-1', title: '第一会话', current: true, mtime: '2026-11-17T10:00:00.000Z' },
            { id: 'fixture-session-2', title: '第二会话', current: false, mtime: '2026-11-17T09:00:00.000Z' },
          ],
        };
        if (target.startsWith('/api/sessions/history')) return { ok: true, messages: [] };
        if (target === '/api/git/status') return { ok: true, isRepo: false, files: [] };
        return { ok: true, providers: [], counts: {}, plans: [], agents: [] };
      },
    };
  };
  w.piGuiDesktop = {
    browser: {
      open: async () => ({ ok: true }), close() {}, back() {}, forward() {}, stop() {}, reload() {},
      openExternal() {}, setBounds() {}, setOccluded() {}, onState: () => () => {}, onNotice: () => () => {},
    },
  };
  w.eval(bundle(path.join(PUB, 'app.js')).code);
  await tick();
  w.S.hasProject = true;
  w.S.bridgeState = 'ready';
  w.S.restoring = false;
  w.applyProjectState();
  await w.loadProjects();
  await tick();
  return { dom, w, d, $ };
}

function svgOf(button) { return button.querySelector('svg[data-icon]'); }

function assertState({ w, d, $ }, collapsed, focus = false) {
  const app = d.querySelector('.app');
  assert.equal(app.classList.contains('sidebar-collapsed'), collapsed);
  assert.equal($('projectSidebar').hidden, collapsed);
  assert.equal($('globalRail').hidden, !collapsed);
  assert.equal($('btnSidebarExpand').hidden, !collapsed);
  assert.equal($('btnSidebarCollapse').getAttribute('aria-expanded'), String(!collapsed));
  assert.equal($('btnSidebarExpand').getAttribute('aria-expanded'), String(!collapsed));
  assert.equal($('workspace').hidden, false);
  if (focus) assert.equal(d.activeElement, collapsed ? $('btnSidebarExpand') : $('btnSidebarCollapse'));
}

(async () => {
  const first = await boot();
  const { dom, w, d, $ } = first;

  await check('展开入口位于 .stage-head 拖拽区内，且自身声明 no-drag', () => {
    const rail = $('globalRail');
    const head = d.querySelector('.stage-head');
    assert.ok(rail && head);
    assert.equal(rail.parentElement, head, '#globalRail 必须是 .stage-head 的直接子元素');
    assert.equal(rail.firstElementChild, $('btnSidebarExpand'));
    assert.ok(rail.compareDocumentPosition(d.querySelector('.conversation-heading')) & w.Node.DOCUMENT_POSITION_FOLLOWING,
      '展开入口应排在标题之前');
    assert.match(ruleBody(stylesCss, '.stage-head'), /-webkit-app-region\s*:\s*drag/);
    assert.match(ruleBody(stylesCss, '.stage-head button'), /-webkit-app-region\s*:\s*no-drag/);
    assert.match(ruleBody(appShellCss, '.global-rail'), /-webkit-app-region\s*:\s*no-drag/);
  });

  await check('两个切换按钮都是原生 button，具备键盘语义', () => {
    for (const id of ['btnSidebarCollapse', 'btnSidebarExpand']) {
      assert.equal($(id).tagName, 'BUTTON');
      assert.equal($(id).getAttribute('type'), 'button');
      assert.notEqual($(id).getAttribute('tabindex'), '-1');
      assert.equal($(id).getAttribute('aria-controls'), 'projectSidebar');
    }
  });

  await check('初始展开：侧栏可见、展开入口隐藏、aria 与提示文案正确', () => {
    assertState(first, false);
    assert.equal($('btnSidebarCollapse').title, '收起侧边栏');
    assert.equal($('btnSidebarCollapse').getAttribute('aria-label'), '收起侧边栏');
    assert.equal($('btnSidebarExpand').title, '展开侧边栏');
    assert.equal($('btnSidebarExpand').getAttribute('aria-label'), '展开侧边栏');
  });

  await check('图标为 Lucide panel-left-close / panel-left-open 几何', () => {
    const collapse = svgOf($('btnSidebarCollapse'));
    const expand = svgOf($('btnSidebarExpand'));
    assert.equal(collapse.getAttribute('data-icon'), 'sidebarCollapse');
    assert.equal(expand.getAttribute('data-icon'), 'sidebarExpand');
    assert.match(collapse.innerHTML, /m16 15-3-3 3-3/, '展开态应是 panel-left-close 的左向箭头');
    assert.match(collapse.innerHTML, /<rect[^>]*rx="2"/);
    assert.match(expand.innerHTML, /m14 9 3 3-3 3/, '折叠态应是 panel-left-open 的右向箭头');
    assert.match(expand.innerHTML, /<rect[^>]*rx="2"/);
    assert.equal(collapse.getAttribute('viewBox'), '0 0 24 24');
    assert.equal(expand.getAttribute('viewBox'), '0 0 24 24');
    assert.equal(collapse.getAttribute('stroke-width'), '1.7');
  });

  await check('初次收起后展开入口可见，再点立即恢复', () => {
    $('btnSidebarCollapse').click();
    assertState(first, true, true);
    $('btnSidebarExpand').click();
    assertState(first, false, true);
  });

  await check('连续 12 轮折叠/展开不丢状态', () => {
    for (let i = 0; i < 12; i++) {
      $('btnSidebarCollapse').click();
      assertState(first, true, true);
      $('btnSidebarExpand').click();
      assertState(first, false, true);
    }
  });

  await check('会话列表在折叠期间重绘后仍能展开并保留当前项目', async () => {
    $('btnSidebarCollapse').click();
    assertState(first, true);
    $('btnSidebarExpand').click();
    $('btnSidebarCollapse').click();
    const project = d.querySelector('.project.active');
    assert.ok(project, 'fixture 项目应已渲染');
    await w.renderSidebarSessions(project, { path: 'C:\\fixture', name: 'Fixture' });
    await tick();
    assert.equal($('projectSidebar').hidden, true);
    assert.equal($('globalRail').hidden, false);
    $('btnSidebarExpand').click();
    assertState(first, false, true);
    assert.ok(d.querySelector('.pj-sess'), '会话行应在展开后可见');
    assert.equal(d.querySelectorAll('#projects .project.active').length, 1, '当前项目不能被切换');
  });

  await check('窗口 resize 后折叠/展开仍然有效', () => {
    for (const width of [700, 900, 1440]) {
      w.innerWidth = width;
      w.dispatchEvent(new w.Event('resize'));
      $('btnSidebarCollapse').click();
      assertState(first, true, true);
      $('btnSidebarExpand').click();
      assertState(first, false, true);
    }
  });

  await check('搜索会话会自动展开折叠的侧栏', async () => {
    $('btnSidebarCollapse').click();
    assertState(first, true);
    $('navSearch').click();
    await tick();
    assert.equal($('projectSidebar').hidden, false);
    assert.equal($('projectSidebar').classList.contains('search-open'), true);
    assert.equal($('btnSidebarCollapse').getAttribute('aria-expanded'), 'true');
  });

  await check('重启后按现有设计回到展开态，不持久化折叠状态', async () => {
    const second = await boot();
    try {
      assertState(second, false);
      assert.equal(second.$('btnSidebarCollapse').title, '收起侧边栏');
      assert.equal(second.$('btnSidebarExpand').title, '展开侧边栏');
    } finally {
      second.dom.window.close();
    }
  });

  dom.window.close();
  console.log(`Sidebar toggle: ${passed}/${passed + failed}; failed=${failed}`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
