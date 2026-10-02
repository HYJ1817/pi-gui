/* 侧栏行动作菜单（P24 收口）的离线回归测试。
 *
 * ---------- 这一套管什么 ----------
 *
 * 分两层，两层都要有：
 *
 *   1. **`public/ui/action-menu.js` 的真实 DOM 行为**（jsdom）：单例、锚定与翻转、
 *      键盘导航、Escape 还焦点、点外部 / resize / 滚动关闭、role 语义。
 *      这些用 jsdom 量得准 —— 它们全是结构性的，不依赖排版。
 *   2. **两个调用点的静态边界**：项目行与会话行都只留**一个** `…` 入口，
 *      旧的行内按钮类（`.pj-del` / `.pj-sess-act`）与字符图标（✎ ⤓ ✕ ↩）不再出现，
 *      菜单项调用的仍然是既有的 `openProjectSettings` / `removeProject` /
 *      `startRename` / `doArchive` / `doDelete`。
 *
 * 真实点击链路（点 `…` → 菜单 → 项目设置 / 归档 / 删除确认）在 `npm run test:ui`
 * 里量 —— 那边有整个应用（真正的 renderProjects / renderSidebarSessions）。
 * **排版**（菜单不被 sidecar overflow 裁掉、不跑出窗口）在 cdp-shot 的真实 Chrome
 * 场景里量（UX-MENU-01…05）。
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  const ok = typeof cond === 'function' ? cond() : cond;
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok ? '  → ' + ok : extra ? '  → ' + extra : ''));
  }
}
function section(title) {
  console.log('\n--- ' + title + ' ---');
}

(async () => {
  /* ---------- jsdom 世界 ----------
   * 只放一个 trigger：菜单要挂到 body 上，所以 body 得是干净的。 */
  const dom = new JSDOM('<!doctype html><html><body><button id="anchor" aria-label="项目操作：pi-GUI"></button></body></html>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.Element = window.Element;
  global.HTMLElement = window.HTMLElement;

  /* jsdom 不做布局：给「视口」和元素尺寸一个可控的世界。
   * 这不是在测排版，而是在测**定位算法**（翻转 / 夹紧 / 对齐）。 */
  let viewport = { width: 1200, height: 900 };
  let anchorRect = { top: 100, bottom: 128, left: 40, right: 260, width: 220, height: 28 };
  const MENU_SIZE = { width: 200, height: 120 };
  Object.defineProperty(window.document.documentElement, 'clientWidth', { get: () => viewport.width });
  Object.defineProperty(window.document.documentElement, 'clientHeight', { get: () => viewport.height });
  Object.defineProperty(window, 'innerWidth', { get: () => viewport.width });
  Object.defineProperty(window, 'innerHeight', { get: () => viewport.height });
  window.Element.prototype.getBoundingClientRect = function () {
    if (this.classList && this.classList.contains('action-menu')) {
      return { ...MENU_SIZE, top: 0, bottom: MENU_SIZE.height, left: 0, right: MENU_SIZE.width };
    }
    if (this.id === 'anchor') return { ...anchorRect };
    return { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
  };

  const menu = await import('../public/ui/action-menu.js');
  const { openActionMenu, closeActionMenu, actionMenuOpen, MENU_ICONS } = menu;

  const anchor = window.document.getElementById('anchor');
  const menuEl = () => window.document.getElementById('actionMenu');
  const items = () => [...(menuEl() ? menuEl().querySelectorAll('[role="menuitem"]') : [])];
  const labels = () => items().map((b) => b.querySelector('.action-menu-label').textContent);
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const mouseDown = (el) => el.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  const key = (k, target = window.document.body) => {
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  };
  const px = (v) => Number(String(v).replace('px', ''));

  const sampleItems = (hits = {}) => [
    { label: '项目设置', icon: MENU_ICONS.pencil, onClick: () => { hits.settings = (hits.settings || 0) + 1; } },
    { separator: true },
    { label: '移除项目', icon: MENU_ICONS.trash, danger: true, onClick: () => { hits.remove = (hits.remove || 0) + 1; } },
  ];

  /* ================= A. 结构与单例 ================= */
  section('A. 结构与单例');

  check('A1. 菜单挂在 body 上（不被侧栏 overflow 裁），role=menu / menuitem', () => {
    openActionMenu(anchor, sampleItems());
    const el = menuEl();
    const ok = Boolean(el) && el.parentElement === window.document.body
      && el.getAttribute('role') === 'menu'
      && items().length === 2
      && items().every((b) => b.tagName === 'BUTTON' && b.getAttribute('role') === 'menuitem');
    closeActionMenu();
    return ok || (el && el.outerHTML.slice(0, 160));
  });
  check('A2. 每项都有图标与文案（图标是 SVG，不是字符图标）', () => {
    openActionMenu(anchor, sampleItems());
    const first = items()[0];
    const ok = Boolean(first.querySelector('.action-menu-ic svg'))
      && first.querySelector('.action-menu-label').textContent === '项目设置';
    closeActionMenu();
    return ok || '缺图标 / 文案';
  });
  check('A3. 没有可显示项 → 返回 null，且不留下空菜单', () => {
    const r1 = openActionMenu(anchor, []);
    const r2 = openActionMenu(anchor, [{ separator: true }, null, { label: '' }]);
    const ok = r1 === null && r2 === null && !menuEl() && !actionMenuOpen();
    closeActionMenu();
    return ok || JSON.stringify({ r1, r2, menu: Boolean(menuEl()) });
  });
  check('A4. 分隔线：首尾与连续的被丢掉，中间那条带 role=separator', () => {
    openActionMenu(anchor, [
      { separator: true },
      { label: 'A', onClick() {} },
      { separator: true },
      { separator: true },
      { label: 'B', onClick() {} },
      { separator: true },
    ]);
    const seps = menuEl().querySelectorAll('[role="separator"]');
    const ok = seps.length === 1 && labels().join(',') === 'A,B' && items().length === 2;
    closeActionMenu();
    return ok || `${seps.length} separators / ${labels().join(',')}`;
  });
  check('A5. 同时最多一个菜单（开第二个会关掉第一个）', () => {
    const anchor2 = window.document.createElement('button');
    window.document.body.appendChild(anchor2);
    openActionMenu(anchor, sampleItems());
    const first = menuEl();
    openActionMenu(anchor2, [{ label: 'X', onClick() {} }]);
    const second = menuEl();
    const ok = Boolean(second) && second !== first && window.document.querySelectorAll('.action-menu').length === 1;
    closeActionMenu();
    anchor2.remove();
    return ok || window.document.querySelectorAll('.action-menu').length;
  });
  check('A6. 同一个 trigger 再开一次 = 收起（toggle）', () => {
    openActionMenu(anchor, sampleItems());
    const opened = actionMenuOpen();
    openActionMenu(anchor, sampleItems());
    const ok = opened === true && actionMenuOpen() === false && !menuEl();
    closeActionMenu();
    return ok || JSON.stringify({ opened, after: actionMenuOpen() });
  });
  check('A7. trigger 上有 aria-haspopup=menu / aria-expanded，关闭后回到 false', () => {
    openActionMenu(anchor, sampleItems());
    const during = anchor.getAttribute('aria-haspopup') === 'menu' && anchor.getAttribute('aria-expanded') === 'true'
      && anchor.getAttribute('aria-controls') === 'actionMenu';
    closeActionMenu();
    const after = anchor.getAttribute('aria-expanded') === 'false';
    return (during && after) || JSON.stringify({ during, after: anchor.getAttribute('aria-expanded') });
  });
  check('A8. danger 项带 danger 类（只在 hover 时变红，由 CSS 决定）', () => {
    openActionMenu(anchor, sampleItems());
    const ok = Boolean(items()[1].classList.contains('danger'));
    closeActionMenu();
    return ok || 'danger 项没有类';
  });
  check('A9. disabled 项 disabled，且不参与键盘导航', () => {
    openActionMenu(anchor, [
      { label: 'A', onClick() {} },
      { label: 'Disabled', disabled: true, onClick() {} },
      { label: 'B', onClick() {} },
    ]);
    const list = items();
    if (!list[1].disabled) return '没有 disabled';
    list[0].focus();
    key('ArrowDown', list[0]);
    const moved = window.document.activeElement === list[2];
    closeActionMenu();
    return moved || '焦点落到了 disabled 项上';
  });

  /* ================= B. 定位 ================= */
  section('B. 定位（锚定 / 翻转 / 夹紧）');

  check('B1. 充裕空间：出现在 trigger 下方，右边缘与 trigger 对齐', () => {
    anchorRect = { top: 100, bottom: 128, left: 40, right: 260, width: 220, height: 28 };
    viewport = { width: 1200, height: 900 };
    openActionMenu(anchor, sampleItems());
    const el = menuEl();
    const left = px(el.style.left);
    const top = px(el.style.top);
    closeActionMenu();
    return (top === 128 + 6 && left + MENU_SIZE.width === 260) || JSON.stringify({ left, top });
  });
  check('B2. 下方放不下 → 向上翻转（仍然贴着 trigger）', () => {
    anchorRect = { top: 800, bottom: 828, left: 40, right: 260, width: 220, height: 28 };
    viewport = { width: 1200, height: 900 };
    openActionMenu(anchor, sampleItems());
    const top = px(menuEl().style.top);
    closeActionMenu();
    /* 800 - 6 - 120 = 674 */
    return top === 674 || top;
  });
  check('B3. 右边缘会跑出视口时向左夹紧（绝不超出屏幕）', () => {
    anchorRect = { top: 100, bottom: 128, left: 1150, right: 1198, width: 48, height: 28 };
    viewport = { width: 1200, height: 900 };
    openActionMenu(anchor, sampleItems());
    const left = px(menuEl().style.left);
    closeActionMenu();
    return left === 1200 - 200 - 8 || left;
  });
  check('B4. 上方也放不下时夹在视口内（不出现负坐标）', () => {
    anchorRect = { top: 10, bottom: 38, left: 40, right: 260, width: 220, height: 28 };
    viewport = { width: 1200, height: 130 };
    openActionMenu(anchor, sampleItems());
    const el = menuEl();
    const top = px(el.style.top);
    const left = px(el.style.left);
    closeActionMenu();
    return (top >= 8 && top + MENU_SIZE.height <= viewport.height && left >= 8) || JSON.stringify({ top, left });
  });

  /* ================= C. 键盘与关闭 ================= */
  section('C. 键盘与关闭');

  check('C1. 打开后焦点在第一项', () => {
    openActionMenu(anchor, sampleItems());
    const ok = window.document.activeElement === items()[0];
    closeActionMenu();
    return ok || '焦点不在第一项';
  });
  check('C2. ArrowDown / ArrowUp 循环，Home / End 跳首尾', () => {
    openActionMenu(anchor, sampleItems());
    const [a, b] = items();
    key('ArrowDown', a);
    const down = window.document.activeElement === b;
    key('ArrowDown', b);
    const wrap = window.document.activeElement === a;
    key('ArrowUp', a);
    const up = window.document.activeElement === b;
    key('End', b);
    const end = window.document.activeElement === b;
    key('Home', b);
    const home = window.document.activeElement === a;
    closeActionMenu();
    return (down && wrap && up && end && home) || JSON.stringify({ down, wrap, up, end, home });
  });
  check('C3. Enter / Space 执行当前项并关闭菜单', () => {
    const hits = {};
    openActionMenu(anchor, sampleItems(hits));
    key('Enter', items()[0]);
    const afterEnter = hits.settings === 1 && !menuEl();
    openActionMenu(anchor, sampleItems(hits));
    items()[1].focus();
    key(' ', items()[1]);
    const afterSpace = hits.remove === 1 && !menuEl();
    closeActionMenu();
    return (afterEnter && afterSpace) || JSON.stringify({ hits, afterEnter, afterSpace });
  });
  check('C4. Escape 关闭并把焦点还给 trigger', () => {
    openActionMenu(anchor, sampleItems());
    items()[0].focus();
    key('Escape', items()[0]);
    const ok = !menuEl() && window.document.activeElement === anchor;
    closeActionMenu();
    return ok || '焦点没回来 / 菜单没关';
  });
  check('C5. 点菜单外（mousedown）关闭', () => {
    openActionMenu(anchor, sampleItems());
    mouseDown(window.document.body);
    const ok = !menuEl();
    closeActionMenu();
    return ok || '没有关闭';
  });
  check('C6. 点菜单内部不关闭', () => {
    openActionMenu(anchor, sampleItems());
    mouseDown(menuEl());
    const ok = Boolean(menuEl());
    closeActionMenu();
    return ok || '点菜单自己被关掉了';
  });
  check('C7. 窗口 resize 关闭', () => {
    openActionMenu(anchor, sampleItems());
    window.dispatchEvent(new window.Event('resize'));
    const ok = !menuEl();
    closeActionMenu();
    return ok || 'resize 没关';
  });
  check('C8. 页面滚动关闭；菜单自己滚动不关', () => {
    openActionMenu(anchor, sampleItems());
    menuEl().dispatchEvent(new window.Event('scroll', { bubbles: false }));
    const keptOpen = Boolean(menuEl());
    window.document.body.dispatchEvent(new window.Event('scroll', { bubbles: false }));
    const closed = !menuEl();
    closeActionMenu();
    return (keptOpen && closed) || JSON.stringify({ keptOpen, closed });
  });
  check('C9. 点项时**先关闭再执行**动作（动作里开弹层不会被自己盖住）', () => {
    let menuStillOpenInside = null;
    openActionMenu(anchor, [
      { label: 'A', onClick: () => { menuStillOpenInside = actionMenuOpen(); } },
    ]);
    click(items()[0]);
    const ok = menuStillOpenInside === false && !menuEl();
    closeActionMenu();
    return ok || JSON.stringify({ menuStillOpenInside });
  });
  check('C10. 关闭之后键盘监听不再起作用（没有残留监听器）', () => {
    openActionMenu(anchor, sampleItems());
    closeActionMenu();
    key('ArrowDown');
    const ok = !menuEl() && window.document.querySelectorAll('.action-menu').length === 0;
    closeActionMenu();
    return ok || '关闭后仍有残留';
  });
  check('C11. 图标是常量 SVG（细线单色，不是字符图标）', () => {
    const icons = Object.values(MENU_ICONS);
    return (icons.length >= 4 && icons.every((svg) => /^<svg /.test(svg) && svg.includes('stroke="currentColor"')))
      || icons.length;
  });

  /* ================= D. 两个调用点的静态边界 ================= */
  section('D. 项目行 / 会话行的静态边界');

  /* 注释里会出现被弃用的字符 / 功能名（那是为什么弃用它们的说明），
   * 所以源码断言一律先剥掉注释再比 —— 否则守卫会被自己的文档绊倒。 */
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const projectsSrc = read('public/projects.js');
  const sessionsSrc = read('public/sessions.js');
  const sessionsCode = stripComments(sessionsSrc);
  const projectsCode = stripComments(projectsSrc);
  const styles = read('public/styles.css');

  check('D1. 项目行不再有 .pj-del，改成唯一的 .pj-row-menu-trigger', () =>
    (!projectsCode.includes('pj-del') && !styles.includes('.pj-del')
      && /pj-row-menu-trigger/.test(projectsCode)) || '旧删除按钮还在');
  check('D2. 会话行不再有 .pj-sess-act，也不再用 ✎ ⤓ ✕ ↩ 当图标', () => {
    const bad = ['✎', '⤓', '✕', '↩'].filter((t) => sessionsCode.includes(t));
    if (/pj-sess-act(?!s)/.test(sessionsCode)) bad.push('pj-sess-act');
    return (bad.length === 0 && /pj-sess-menu-trigger/.test(sessionsCode)) || bad.join(',');
  });
  check('D3. 新的三点类名与 .pj-sess-more（归档折叠）不冲突', () => {
    const cls = /'pj-sess-menu-trigger/.test(sessionsCode);
    return (cls && sessionsCode.includes("'pj-sess-more'") && styles.includes('.pj-sess-arch-toggle')) || '类名冲突了';
  });
  check('D4. 每行只有一个三点入口（项目和会话都是）', () => {
    const projectTriggers = [...projectsCode.matchAll(/pj-row-menu-trigger/g)].length;
    const sessionTriggers = [...sessionsCode.matchAll(/pj-sess-menu-trigger/g)].length;
    /* 各出现两次是正常的：一次建元素、一次用在注释/CSS 无关处；关键是**只建一个**。 */
    return (projectTriggers >= 1 && sessionTriggers >= 1
      && !projectsCode.includes('pj-del') && !/pj-sess-act(?!s)/.test(sessionsCode)) || `${projectTriggers}/${sessionTriggers}`;
  });
  check('D5. 项目菜单复用既有 openProjectSettings / removeProject，且移除前先确认', () => {
    const menu = /openActionMenu\(menuTrigger, \[[\s\S]{0,600}openProjectSettings\(\)[\s\S]{0,600}confirmRemoveProject/.test(projectsCode);
    const confirm = /confirmModal\(\{[\s\S]{0,300}不会删除磁盘上的项目文件/.test(projectsCode);
    const reuse = /async function confirmRemoveProject\(target, label\)[\s\S]{0,700}await removeProject\(target\)/.test(projectsCode);
    return (menu && confirm && reuse) || JSON.stringify({ menu, confirm, reuse });
  });
  check('D6. 会话菜单复用既有 startRename / doArchive / doDelete（没有第二套实现）', () => {
    const ok = /startRename\(row, titleEl, s\)/.test(sessionsCode)
      && /doArchive\(s, false\)/.test(sessionsCode)
      && /doArchive\(s, true\)/.test(sessionsCode)
      && /doDelete\(s\)/.test(sessionsCode);
    /* 重命名仍然只有那一个行内编辑器：没有第二个 input 工厂。 */
    const inputs = [...sessionsCode.matchAll(/pj-sess-input/g)].length;
    return (ok && inputs === 1) || `复用=${ok} inputs=${inputs}`;
  });
  check('D7. 当前会话只给重命名；pending 没有菜单；sessionNaming 缺失时整项消失', () => {
    const ok = /if \(s\.pending\) return \[\];/.test(sessionsCode)
      && /if \(s\.current\) \{[\s\S]{0,200}capMissing\('sessionNaming'\)\) return \[\];/.test(sessionsCode)
      && /if \(!items\.length\) return null;/.test(sessionsCode);
    return ok || '会话菜单的能力边界被改了';
  });
  check('D8. 两个 trigger 都自己拦掉冒泡（点三点绝不切换项目 / 会话）', () => {
    const project = /menuTrigger\.onclick = \(e\) => \{\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);/.test(projectsCode);
    const session = /trigger\.onclick = \(e\) => \{[\s\S]{0,300}e\.preventDefault\(\);\s*e\.stopPropagation\(\);/.test(sessionsCode);
    return (project && session) || JSON.stringify({ project, session });
  });
  check('D9. 菜单项只放真实已有功能（没有 Codex 的置顶 / 分区 / 分支 / 资源管理器）', () => {
    const forbidden = ['置顶', 'pin', '分区', '分支', '打开资源管理器', 'reveal'];
    const hit = forbidden.filter((t) => projectsCode.includes(t) || sessionsCode.includes(t));
    return hit.length === 0 || hit.join(',');
  });
  check('D10. trigger 默认透明，hover / focus-within / 打开时可见', () => {
    const ok = /\.project:hover \.pj-row-menu-trigger,[\s\S]{0,120}\.pj-row-menu-trigger\[aria-expanded="true"\]\{opacity:1\}/.test(styles)
      && /\.pj-sess:focus-within \.pj-sess-acts\{opacity:1\}/.test(styles);
    return ok || '缺少 hover / focus-within 可见规则';
  });
  check('D11. 菜单样式：单例浮层、在弹层之下、低对比分隔线、danger 只在 hover 变红', () => {
    const ok = /\.action-menu\{[\s\S]{0,200}position:fixed;z-index:30/.test(styles)
      && /\.action-menu-sep\{[^}]*var\(--line-soft\)/.test(styles)
      && /\.action-menu-item\.danger:hover/.test(styles)
      && !/\.action-menu-item\{[^}]*color:#f00/.test(styles);
    return ok || '菜单样式不符合约定';
  });

  closeActionMenu();
  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  assert.ok(true);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error('失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
