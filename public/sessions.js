import { iconMarkup } from './ui/icons.js';
/* 侧栏的会话列表。
 *
 * ---------- 为什么不是弹窗 ----------
 *
 * 第一版做成了一个独立的「会话」面板（点侧栏入口开 Modal）。但会话本来就属于
 * 项目 —— 把它单开一个窗口，等于让用户先想「我要看会话」再想「是哪个项目的」，
 * 而且和项目列表分处两个地方，切项目之后还要重新打开。
 *
 * 现在照 Codex 的做法：**会话直接列在当前项目那一行下面**，随项目列表一起渲染。
 * 点一条即打开；运行中查看其它历史时保留原执行会话，当前项可返回实时输出。
 *
 * ---------- 为什么需要它 ----------
 *
 * Pi GUI 一直有「新对话」，却**没有入口切回旧会话** —— 用户点一下，旧对话就
 * 从界面上消失了。它其实完整躺在磁盘上（pi 把每个会话存成独立的 `.jsonl`），
 * 但界面上再也够不着，看起来就像「对话丢了」。
 *
 * pi 的 RPC 有 `switch_session` 但没有「列出会话」，所以列表由后端扫
 * `<agentDir>/sessions/` 得到（见 server/sessions.js）。
 *
 * ---------- 五条必须守住的规矩 ----------
 *
 * 1. **只传后端给的稳定 ID**，不传路径。后端在自己的索引里解析真实路径，
 *    并核对那条会话确实属于当前项目 ⇒ 不可能切到别的项目上去。
 * 2. **切换后必须走 afterSessionSwitch()**：清空对话区与变更账本再重建。
 *    不走这一步的话，切完界面还挂着上一个会话的消息，看着像「切了没生效」。
 * 3. **浏览与执行交接分离**：后台运行时只切视图，不能调用会中断 Pi 的 switch_session。
 * 4. ⚠️ **会话一变就必须重画这个列表。** 列表原本只在 renderProjects() 里渲染，
 *    而 new_session / fork / 切换都不触发它 —— 于是列表停在旧状态：旧会话仍然
 *    带着 `current` 标记，而当前项是**不给点**的（你已经在里面了），用户就再也
 *    回不到那条对话。这正是「开个新对话，旧对话就消失了」的真正原因。
 *    现在由 rpc.js 的 afterSessionSwitch() 通过 setSessionListRefresh() 回调触发。
 * 5. **归档 / 删除不能碰当前会话**：pi 正开着那个文件往里追加。后端也会拒，
 *    界面保留统一菜单，但禁用受限动作并说明原因。
 * 6. **搜索框只建一次，重画只画列表区。** 输入框挂在列表区上面；跟着列表区
 *    一起重建的话，每敲一个字都会丢焦点与光标位置。搜索状态本体在
 *    `session-search.js` 里，本模块只负责「按状态决定列表区画什么」。
 */
import { fetchSessions, switchSession, renameSession, archiveSession, deleteSession } from './api.js';
import { afterSessionSwitch } from './rpc.js';
import { S, ownsWorkspace } from './state.js';
import { setTitleText } from './shell.js';
import { isNewSessionEntry, projectSessionTitle, sessionDisplayTitle } from './session-title.js';
import { fmtTime } from './util.js';
import { toast } from './ui/toast.js';
import { confirmModal } from './ui/modal.js';
import { openActionMenu, MENU_ICONS } from './ui/action-menu.js';
import { classicThreadSessionId, clearClassicSessionView, setAfterHistoryRendered } from './messages.js';
import { scrollToUserTurn } from './conversation-nav.js';
import { clearSessionPlans, refreshSessionPlans } from './session-plans.js';
import { projectExpanded, setProjectExpanded } from './sidebar-expansion.js';
import { showChat } from './ui/workspace-surface.js';
import { runtimeStore } from './runtime-state.js';
import {
  createSearchBar,
  renderSearchResults,
  searchViewMode,
  resetSearch,
  refreshSearch,
  setSearchChangeHandler,
} from './session-search.js';
import { clearRuntimeNav, loadRuntimeNav, repaintRuntimeNav, runtimeNavCount, setRuntimeNavParent } from './runtime-nav.js';

/* P32.4：并行会话与经典会话共用同一块列表区，两边都要能独立决定这块存不存在。
 * runtime 状态变化由 runtime-nav 自己订阅（它不该依赖本模块替它接线）。 */
let currentProject = {};
let runtimeHistoryHandler = null;
let sessionOpenHandler = null;
export function setSessionOpenHandler(fn) { sessionOpenHandler = typeof fn === 'function' ? fn : null; }
export function setRuntimeHistoryHandler(fn) { runtimeHistoryHandler = typeof fn === 'function' ? fn : null; }

/** 进行中的会话一次最多列几条，超出折叠（和 Codex 一样给个「展开显示」）。 */
const COLLAPSED = 6;
/** 已归档的默认全部展开，但给个上限，免得几百条把侧栏撑爆。 */
const MAX_ARCHIVED = 50;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

/**
 * 某个 pi 能力是否**已被证实**不可用（兼容层报告，见 server/pi-compat.js）。
 *
 * 没拿到兼容摘要时一律返回 false（= 按可用处理）。这是刻意的：**未验证 ≠ 不支持**，
 * 而且宁可让用户点一下发现不行，也不要在状态还没回来时先把功能藏了。
 */
function capMissing(name) {
  return Boolean(S.compat && Array.isArray(S.compat.missing) && S.compat.missing.indexOf(name) !== -1);
}

/* fmtTime 搬去了 util.js —— 搜索模块也要用同一套相对时间写法，
 * 各写一份会让同一个会话在侧栏和搜索结果里显示成两个时间。 */

/* 当前挂着的那块列表、它的「列表区」、以及这份会话数据。
 * 只可能有一块（会话只列在当前项目下面），所以用模块级状态就够。
 *
 * 为什么要把「列表区」单独拎出来：搜索框挂在列表区**上面**且只建一次，
 * 输入时只重画列表区 —— 否则每敲一个字都会重建输入框，光标和焦点全丢。 */
let boxRef = null;
let listRef = null;
let dataRef = null;
let loadToken = 0;
let expanded = false;
let archivedOpen = false;
/* 用户刚切过去的那条会话（稳定 ID）。列表异步回来时只认它，
 * 免得旧的 current 标记把顶部标题换成另一条会话。 */
let expectedSessionKey = null;
/* 新会话 / 分叉还没有稳定 ID。记住切换前的那条，列表如果仍把旧会话
 * 标成 current，就不能拿它覆盖「新会话」。 */
let awaitingNewSession = false;
let newSessionPreviousKey = null;
let newSessionKnownIds = new Set();

/* rpc.js 不能 import 本模块（会成环），所以切换事件经 DOM 传过来。 */
document.addEventListener('pi-gui:session-switch', (event) => {
  const detail = event.detail || {};
  if (detail.newSession) {
    awaitingNewSession = true;
    newSessionPreviousKey = expectedSessionKey;
    /* 记下切换前已经见过的会话 ID：列表如果还没更新，current 仍是其中
     * 一条旧会话 —— 不能把它当成新会话认领。 */
    newSessionKnownIds = new Set((dataRef?.sessions || []).map((s) => s.id));
    expectedSessionKey = null;
    return;
  }
  expectedSessionKey = detail.sessionKey || null;
  awaitingNewSession = false;
  newSessionPreviousKey = null;
  newSessionKnownIds = new Set();
});

/* ---------- 折叠（每个项目自己的会话列表）----------
 *
 * 用户要的是「项目 / 会话是一套紧凑层级」，而不是把「项目」分组整个折起来。
 * 项目标题区域（`.pj-select`）是唯一的折叠触发器：箭头、文件夹图标、名称和
 * 右侧空白都属于它；点它只隐藏 / 恢复 `.pj-sessions`，不切换项目、不碰对话区。
 *
 * 三件必须守住的事：
 *   1. **折叠用 [hidden]，不删 DOM。** 搜索、重命名、归档、删除都靠查询现有
 *      行工作，把行删掉会让它们的状态全丢；[hidden] 有 display:none !important
 *      兜底（见 styles.css 顶部），不会像别处那样被 display:flex 盖掉。
 *   2. **点击不得误触。** 标题按钮自己 stopPropagation；行尾的 + 与三点入口
 *      （`.pj-header-action` / `.pj-row-menu-trigger`）是它的兄弟节点，同样
 *      自己拦掉冒泡 —— 三条路互不影响。
 *   3. **项目展开状态按路径保留；重新进搜索会展开当前项目。**
 *      openSessionSearch()（sidebar-search.js）会显式调用
 *      expandSidebarSessions()，否则用户点了「搜索会话」却看不到输入框。
 */
/* 行尾的动作入口：三点（…）。**没有用 ✎ / ⤓ / ✕ / ↩ 这些字符当图标** ——
 * 字符图标在不同字体下大小与基线都不可控，换成自己画的三个圆。 */
const SVG_MORE =
  iconMarkup('more');

let collapsed = false;
let triggerRef = null;
let projectKey = '';
/** 折叠/展开：只碰 box.hidden 与标题触发器的 aria 状态，不动列表内容。 */
function toggleSessions() {
  if (!boxRef || !boxRef.isConnected) return;
  collapsed = !collapsed;
  setProjectExpanded(projectKey, !collapsed);
  applyCollapsed();
  /* 搜索框就在这块列表里；把它折起来后 search-open 不能继续亮着，
   * 否则用户再点搜索图标只会「关掉」一个已经看不见的搜索。统一交给
   * sidebar-search 的关闭入口处理（本模块不直接改 search-open）。 */
  if (collapsed) document.dispatchEvent(new CustomEvent('pi-gui:active-sessions-collapsed'));
}

function applyCollapsed() {
  const box = boxRef;
  if (!box || !box.isConnected) return;
  box.hidden = collapsed;
  const trigger = triggerRef;
  if (trigger && trigger.isConnected) trigger.setAttribute('aria-expanded', String(!collapsed));
}

/** 展开当前项目的会话列表（搜索入口要用它）。已经是展开态就什么都不做。 */
export function expandSidebarSessions() {
  if (!collapsed) return false;
  collapsed = false;
  setProjectExpanded(projectKey, true);
  applyCollapsed();
  return true;
}

/** 供测试用：当前是不是折叠着。 */
export function sessionsCollapsed() {
  return collapsed;
}

/* 点了搜索结果之后要跳到的那次提问。切会话是异步的（afterSessionSwitch 只是
 * setTimeout(boot,250)，还要等 get_messages 一个来回），所以**不能在点击处
 * 直接滚** —— 那时新历史还没渲染出来。存下来，等「历史渲染完成」的生命周期
 * 回调来消费。带时间戳是为了兜底：万一那个会话没渲染成功（切失败 / 文件没了），
 * 这个待办不能一直挂着等下一次重建时错误地生效。 */
let pendingLocate = null;
const LOCATE_TTL_MS = 15000;

setAfterHistoryRendered(sessionId => {
  const p = pendingLocate;
  if (!p) return false;
  if (Date.now() - p.at > LOCATE_TTL_MS) {
    pendingLocate = null;
    return false;
  }
  if (!p.switched || (p.sessionId && p.sessionId !== sessionId)) return false;
  pendingLocate = null;
  return scrollToUserTurn(p.userIndex);
});

/* ---------- 供行内命令复用（P24）----------
 *
 * 「切到某个会话」的命令**不自己拉一遍会话列表** —— 那是第二份数据。
 * 这里把已经渲染出来的那份数据（`dataRef`）只读地暴露出去，命令拿到的就是
 * 用户此刻在侧栏看到的那几条。 */
export function knownSessions() {
  const data = dataRef;
  if (!data || !Array.isArray(data.items)) return [];
  return data.items.map((s) => ({
    id: s.id,
    title: s.title || '（无标题）',
    archived: Boolean(s.archived),
    current: Boolean(s.current),
  }));
}

/** 面板里「切换会话」走的也是侧栏那一条路径（含流式守卫与 afterSessionSwitch）。 */
export async function switchToSessionById(id) {
  const item = (dataRef && Array.isArray(dataRef.items) ? dataRef.items : []).find((s) => s.id === id);
  if (item) return doSwitch(item);
  toast('这条会话已经不在列表里了，刷新后重试', 'warn');
  return false;
}

/* 搜索结果变化 → 重画列表区（不碰输入框）。 */
setSearchChangeHandler(() => {
  paintList();
});

function moreBtn(text, onclick, cls) {
  const b = el('button', 'pj-sess-more' + (cls ? ' ' + cls : ''), text);
  b.type = 'button';
  b.onclick = onclick;
  return b;
}

/**
 * 已落盘会话统一显示三个动作，受限项禁用并解释原因。
 * 重命名只作用于当前会话；当前会话不可归档 / 删除。
 * pending 没有有效动作（文件还没落盘），不显示三点。
 */
function sessionMenuItems(s, row, titleEl) {
  if (s.pending) return [];
  const namingUnavailable = capMissing('sessionNaming');
  const currentReason = '当前会话正在使用，请先切换到其它会话再归档或删除。';
  return [
    { label: '重命名', icon: MENU_ICONS.pencil, disabled: !s.current || namingUnavailable,
      disabledReason: namingUnavailable ? '当前 Pi 不支持会话重命名。' : '重命名：请先打开这条会话。',
      onClick: () => startRename(row, titleEl, s) },
    s.archived
      ? { label: '取消归档', icon: MENU_ICONS.restore, disabled: s.current, disabledReason: currentReason, onClick: () => doArchive(s, false) }
      : { label: '归档', icon: MENU_ICONS.archive, disabled: s.current, disabledReason: currentReason, onClick: () => doArchive(s, true) },
    { separator: true },
    { label: '删除会话', icon: MENU_ICONS.trash, danger: true, disabled: s.current, disabledReason: currentReason, onClick: () => doDelete(s) },
  ];
}

/**
 * 行尾的**唯一**入口：三点（…）。原来散落的 ✎ / ⤓ / ↩ / ✕ 四个字符按钮
 * 全部收进这一个菜单；菜单项调用的仍然是既有的 `startRename` / `doArchive` /
 * `doDelete`，**没有第二套实现**。
 */
function makeRowMenu(s, row, titleEl, preview = false) {
  const items = sessionMenuItems(s, row, titleEl).map(item => preview && !item.separator
    ? { ...item, disabled: true, disabledReason: '请先打开这个项目的会话，再执行操作。' } : item);
  if (!items.length) return null; // 没有动作 → 连三点都不画（不留一个点了没反应的入口）
  const acts = el('span', 'pj-sess-acts');
  const trigger = el('button', 'pj-sess-menu-trigger row-action-trigger');
  trigger.type = 'button';
  trigger.title = '更多操作';
  trigger.setAttribute('aria-label', `会话操作：${s.title || '（无标题）'}`);
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  /* 常量 SVG 模板，不含用户数据。 */
  trigger.innerHTML = SVG_MORE;
  trigger.onclick = (e) => {
    /* 点三点**绝不能**触发 doSwitch：`.pj-sess-primary` 才是切换入口，
     * 这里拦住冒泡，两个行为完全隔离。 */
    e.preventDefault();
    e.stopPropagation();
    openActionMenu(trigger, items);
  };
  acts.append(trigger);
  row.oncontextmenu = e => {
    // Reuse the exact same permissions and callbacks as the overflow button.
    // The row anchor keeps both pointer and keyboard menus in the viewport.
    if (e.target.closest('input,textarea')) return;
    e.preventDefault();
    e.stopPropagation();
    trigger.click();
  };
  return acts;
}

/**
 * 把当前项目的会话渲染到项目行下面。
 * 由 app.js 通过 projects.setSessionsSlot() 注入 —— projects.js 不 import 本模块，
 * 两边不互相依赖。
 *
 * @param projectEl 当前项目那一行的元素（`.project.active`）
 */
export async function renderSidebarSessions(projectEl, project = {}) {
  const parent = projectEl && projectEl.parentNode;
  if (!parent) return;

  const box = el('div', 'pj-sessions');
  box.id = 'pjSessionsBox';
  parent.insertBefore(box, projectEl.nextSibling);
  box.append(el('div', 'pj-sess-hint', '读取会话…'));

  boxRef = box;
  listRef = null;
  dataRef = null;
  expanded = false;
  archivedOpen = false;
  expectedSessionKey = null;
  awaitingNewSession = false;
  newSessionPreviousKey = null;
  newSessionKnownIds = new Set();
  /* 每个项目记住自己的展开状态；标题触发器由 projects.js 建好，这里只把
   * 会话块的控制关系和当前状态接上去（箭头只是触发器里的装饰）。 */
  projectKey = project.path || projectEl.title;
  currentProject = project || {};
  /* 换了项目 → 并行会话的归属与列表必须整块丢掉重来，不能拿着 A 的
   * conversationId 去画 B 的侧栏。 */
  clearRuntimeNav();
  collapsed = !projectExpanded(projectKey, true);
  triggerRef = projectEl.querySelector('.pj-select');
  if (triggerRef) {
    triggerRef.setAttribute('aria-controls', box.id);
    triggerRef.setAttribute('aria-expanded', String(!collapsed));
  }
  /* 行上的点击统一交给本模块的状态机；箭头 / 图标 / 名称 / 空白都走这一条。 */
  projectEl.__pjToggle = toggleSessions;
  applyCollapsed();
  /* 换了项目就丢掉上一个项目的搜索状态。searchViewMode() 是模块级的，
   * 不清的话会拿着 A 的结果去画 B 的侧栏（迟到的响应虽然会被 generation
   * 校验丢掉，但那只是「刚好没出错」）。 */
  pendingLocate = null;
  resetSearch();
  /* 换了项目就丢掉上一个项目的「关联任务」窄条（P7）。不清的话会短暂显示
   * A 项目的关联 —— 那条数据在后端是按项目过滤的，但**已经画出来的 DOM**
   * 不会自己消失。 */
  clearSessionPlans();
  await fill(box, ++loadToken);
}

/**
 * 会话变了（新开 / 分叉 / 切到别的会话）之后重画那块列表。
 *
 * 没有这一步，列表就停在旧状态：旧会话仍然标着「当前」，而当前项不给点 ——
 * 用户于是再也回不到那条对话，看起来就是「开个新对话，旧对话没了」。
 */
export async function refreshSidebarSessions() {
  const box = boxRef;
  if (!box || !box.isConnected) return;
  await fill(box, ++loadToken);
}

/** 顶部改名弹窗保存后立刻同步侧栏当前行。
 *  只改已渲染的数据与标题，不重新扫会话文件 —— 文件落盘可能比这个
 *  交互晚一拍，重扫反而会拿回旧标题。下一次 refresh 会以文件为准。 */
export function applySessionRename(name) {
  const value = String(name || '').trim();
  if (!value || !dataRef || !Array.isArray(dataRef.sessions)) return;
  const target = (expectedSessionKey && dataRef.sessions.find((s) => s.id === expectedSessionKey))
    || dataRef.sessions.find((s) => s.current);
  if (!target) return;
  target.title = value;
  paintList();
  setTitleText(value);
}

async function fill(box, token) {
  const generation = S.workspaceGeneration;
  let data;
  try {
    data = await fetchSessions();
  } catch {
    /* 读取失败不再把整块列表和标题触发器一起删掉：那会让项目看起来
     * 「不能展开」，也没有重试路径。保留块本身，就地显示错误与重试。 */
    if (token === loadToken && box.isConnected) {
      listRef = null;
      dataRef = null;
      const hint = el('div', 'pj-sess-hint', '读取会话失败。');
      const retry = el('button', 'pj-sess-more pj-sess-retry', '重试');
      retry.type = 'button';
      retry.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        void fill(box, ++loadToken);
      };
      box.replaceChildren(hint, retry);
    }
    return;
  }
  // 旧请求回来晚了，或者这块已经被项目列表重渲染带走了
  if (token !== loadToken || !box.isConnected || !ownsWorkspace(generation) || !S.hasProject) return;

  /* P32.4：并行会话与经典会话共用这块区域，所以「有没有内容可显示」要两边一起看。
   * 只读快照 + worktrees 归属，**不 spawn**；列出来本身不消耗 Runtime slot。 */
  const runtimeCount = await loadRuntimeNav(currentProject, { parent: null });
  if (token !== loadToken || !box.isConnected || !ownsWorkspace(generation) || !S.hasProject) return;

  if ((!data.hasProject || !(data.sessions || []).length) && !runtimeCount) {
    clearSessionPlans(); // 没有会话就没有关联可显示
    /* 空项目也要能展开：保留列表块并显示空态，而不是删掉块和折叠入口。
     * 搜索框仍照常建出来，重试 / 后续新会话都会复用同一块。 */
    dataRef = data;
    paint(box, data);
    return;
  }
  /* P7 §8：会话标题旁的「关联任务」。这里只把**当前会话的 pi 会话 id** 递过去 ——
   * 拉取与显隐由 session-plans.js 负责（它自己带 stale 保护）。
   * 注意用 `s.sessionId`（pi 的 UUID）而不是 `s.id`（我们那个路径 sha1）：
   * 任务元数据里存的是前者，两者不是一回事。 */
  const cur = (data.sessions || []).find((s) => s.current);

  /* 顶部标题与会话列表共用同一份数据。Pi 的实时 sessionName 优先
   * （projectSessionTitle 在 liveName 非空时返回 null）；否则用列表里
   * 当前会话的标题。expectedSessionKey 防止迟到的旧列表把标题改回
   * 上一条会话。 */
  const liveName = S.state?.sessionName;
  if (!(typeof liveName === 'string' && liveName.trim()) && awaitingNewSession) {
    /* 刚新建/分叉，等列表给出一个**不同于旧会话**的 current。旧列表
     * 回来时保持「新会话」，不能把上一条的标题画上去。 */
    const next = (data.sessions || []).find((s) => s.current);
    if (isNewSessionEntry(next, newSessionPreviousKey, newSessionKnownIds)) {
      awaitingNewSession = false;
      newSessionPreviousKey = null;
      newSessionKnownIds = new Set();
      expectedSessionKey = next.id;
      setTitleText(sessionDisplayTitle(next));
    }
  } else {
    const projected = projectSessionTitle({
      sessions: data.sessions,
      currentId: data.currentId,
      expectedKey: expectedSessionKey,
      liveName,
    });
    if (projected) {
      expectedSessionKey = projected.key;
      setTitleText(projected.title);
    }
  }

  refreshSessionPlans(cur ? cur.sessionId : '');
  paint(box, data);
}

function paint(box, data) {
  dataRef = data;
  box.replaceChildren();

  /* 搜索框**只在这里建一次**。列表区由 paintList() 反复重画，输入框始终不重建
   * —— 否则每敲一个字都会丢焦点、丢光标位置。 */
  box.append(createSearchBar());

  const listArea = el('div', 'pj-sess-list');
  box.append(listArea);
  listRef = listArea;
  paintList();
  /* 重画不是展开 —— 折叠状态在 box 自己身上，这里只是把它重新贴回去
   * （box 元素没换，但 applyCollapsed 顺带校正箭头的 aria 状态）。 */
  applyCollapsed();
}

/** 只重画列表区：搜索态画结果，否则画普通会话列表。 */
function paintList() {
  const area = listRef;
  const data = dataRef;
  if (!area || !area.isConnected || !data) return;

  /* 关键词非空时，整块列表区交给搜索视图（结果 / 正在搜索 / 没找到 / 失败 /
   * 「还差几个字」）。空关键词才回落到普通列表 —— 这正是「清空搜索恢复普通
   * 列表」那条要求的落点。 */
  if (searchViewMode() !== 'list') {
    renderSearchResults(area, { onPick: pickResult });
    return;
  }

  area.dataset.view = 'list';
  area.replaceChildren();

  /* P32.4：并行会话排在经典会话**之前** —— 它们是「正在跑的活」，经典列表是
   * 「历史」。identity 仍然分开：并行会话走 registry 的 conversationId，
   * 经典会话走 pi 的 session id，两者不合并成一个字段。
   * 容器由 runtime-nav 自己在 area 里 prepend，重画时会被 replaceChildren 清掉再建。 */
  setRuntimeNavParent(area);
  repaintRuntimeNav();

  const owned = new Set(runtimeStore.values().filter(r=>r.item.kind==='project').map(r=>r.item.nativeSessionId).filter(Boolean));
  const all = (data.sessions || []).filter(s=>!s.sessionId||!owned.has(s.sessionId));
  const live = all.filter((s) => !s.archived);
  const arch = all.filter((s) => s.archived);

  /* 空项目也要有可展开的内容：显示空态而不是空白，否则收起 / 展开
   * 看起来都像没反应。并行会话也是内容，不能把它们判成空。 */
  if (!all.length && runtimeNavCount() === 0) {
    area.append(el('div', 'pj-sess-hint', '还没有会话'));
    return;
  }

  const shown = expanded ? live : live.slice(0, COLLAPSED);
  for (const s of shown) area.append(makeRow(s));

  if (live.length > COLLAPSED) {
    area.append(
      moreBtn(expanded ? '收起' : `展开显示（还有 ${live.length - COLLAPSED} 条）`, () => {
        expanded = !expanded;
        paintList();
      })
    );
  }

  if (arch.length) {
    area.append(
      moreBtn(archivedOpen ? `已归档 ${arch.length} 条 · 收起` : `已归档 ${arch.length} 条`, () => {
        archivedOpen = !archivedOpen;
        paintList();
      }, 'pj-sess-arch-toggle')
    );
    if (archivedOpen) {
      for (const s of arch.slice(0, MAX_ARCHIVED)) area.append(makeRow(s));
      if (arch.length > MAX_ARCHIVED) {
        area.append(el('div', 'pj-sess-hint', `还有 ${arch.length - MAX_ARCHIVED} 条已归档未显示`));
      }
    }
  }
}

export function createSidebarPreviewRow(s, onPick) {
  return makeRow(s, onPick);
}

export async function openSidebarPreviewSession(s) {
  return doSwitch(s);
}

function makeRow(s, onPick = null) {
  const row = el('div', 'pj-sess' + (s.current ? ' on' : '') + (s.pending ? ' pending' : ''));
  row.title = s.pending
    ? '新会话：还没有消息，pi 还没把它写到磁盘上'
    : `${s.messageCount} 条消息 · ${fmtTime(s.updatedAt)}${s.createdAt ? ' · 创建于 ' + fmtTime(Date.parse(s.createdAt)) : ''}`;

  const canSwitch = !s.pending && (s.current || !capMissing('switchSession'));
  const primary = el(canSwitch ? 'button' : 'span', 'pj-sess-primary');
  if (canSwitch) {
    primary.type = 'button';
    primary.setAttribute('aria-label', `切换会话：${s.title || '（无标题）'}`);
    primary.onclick = () => onPick ? onPick(s) : s.current ? showChat({ focusComposer: true }) : doSwitch(s);
  }
  if (s.current) row.setAttribute('aria-current', 'true');
  if (s.current) row.dataset.classicCurrent = 'true';
  if (s.current) row.dataset.activity = S.streaming ? 'running' : 'idle';
  const dot = el('span', 'pj-sess-dot');
  dot.setAttribute('aria-hidden', 'true');
  const title = el('span', 'pj-sess-title', s.title || '（无标题）');
  const time = el('span', 'pj-sess-time', s.current && S.streaming ? '运行中' : fmtTime(s.updatedAt));
  time.dataset.idleLabel = fmtTime(s.updatedAt);
  primary.append(dot, title, time);
  row.append(primary);

  const acts = makeRowMenu(s, row, title, Boolean(onPick));
  if (acts) row.append(acts);

  /* 切换会话要 pi 的 `switch_session`。它被证实不可用时不给点，并在 title 里
   * 说明原因 —— 留一个点了毫无反应的入口比藏起来更让人困惑。 */
  if (!s.current && !s.pending) {
    if (capMissing('switchSession')) {
      row.classList.add('pj-sess-off');
      row.title = '当前 pi 没有提供「切换会话」能力（详情见侧栏「诊断」）';
    }
  }

  return row;
}

function startRename(row, titleEl, s) {
  const input = el('input', 'pj-sess-input');
  input.type = 'text';
  input.value = s.title || '';
  input.maxLength = 120;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== s.title) {
      try {
        const r = await renameSession(v);
        if (!r.ok) toast(r.error || '改名失败', 'error');
        else {
          s.title = v;
          /* 行内改名改的就是当前会话：顶部必须同步，不能只重画侧栏。 */
          setTitleText(v);
          toast('已改名：' + v, 'info');
        }
      } catch (err) {
        toast('改名失败：' + err.message, 'error');
      }
    }
    paintList();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
}

let busy = false;
document.addEventListener('pi-gui:classic-activity', () => {
  for (const row of document.querySelectorAll('[data-classic-current]')) row.dataset.activity = S.streaming ? 'running' : 'idle';
  for (const time of document.querySelectorAll('[data-classic-current] .pj-sess-time')) time.textContent = S.streaming ? '运行中' : time.dataset.idleLabel || '';
});

/**
 * 切到某个会话。
 * @param s               会话（来自普通列表或搜索结果；只要有 id / title）
 * @param locateUserIndex 可选：切过去之后跳到第 N 次提问（搜索结果带的 userIndex）
 */
async function doSwitch(s, locateUserIndex = null) {
  if (sessionOpenHandler?.(s, currentProject, locateUserIndex)) return;
  if (busy) return;
  busy = true;
  const previousSessionId = classicThreadSessionId();
  /* **先挂待办再切** —— 顺序反了就可能挂在「历史已重建」回调之后，
   * 那一次定位永远等不到。 */
  pendingLocate = Number.isInteger(locateUserIndex)
    ? { userIndex: locateUserIndex, sessionId: s.sessionId, at: Date.now(), switched: false }
    : null;
  try {
    const r = await switchSession(s.id);
    if (!r.ok) {
      pendingLocate = null; // 没切成功就把待办撤掉，别留给下一次重建
      toast(r.error || '切换失败', 'error');
      return;
    }
    // 换会话之后必须清界面再重建，否则旧消息还挂在上面。
    // 列表的重画由 afterSessionSwitch 的回调负责（见文件头规矩 4）；
    // 「跳到第 N 次提问」由 messages.js 的「历史渲染完成」回调消费（规矩 6）。
    if (pendingLocate) {
      pendingLocate.sessionId = r.sessionId || pendingLocate.sessionId;
      pendingLocate.switched = true;
    }
    /* switch_session 的应答已经带回目标会话的权威标题。先画上它，
     * 再让 afterSessionSwitch 去重建历史；不要等 get_state 的
     * sessionName —— 没有显式命名的会话那里是空的。 */
    afterSessionSwitch(previousSessionId, {
      title: sessionDisplayTitle({ ...s, title: r.title || s.title }),
      sessionKey: r.id || s.id,
    });
  } catch (err) {
    pendingLocate = null;
    toast('切换失败：' + err.message, 'error');
  } finally {
    busy = false;
  }
}

/**
 * 点了一条搜索结果：切到那个会话，并尽量跳到命中的那次提问。
 *
 * 定位用 `match.userIndex`（后端扫文件时算好的「第几次用户提问」），
 * **不用消息 ID** —— 前端的 nav id（`msg-N`）是渲染时按顺序现发的计数器，
 * 跨重建不稳定；只有「第 N 次提问」这个序号在两边语义一致
 * （见 conversation-nav.js 的 scrollToUserTurn）。
 */
function pickResult(res, match) {
  if (!res) return;
  if (res.locator) {
    const locator = res.locator;
    if (!['projectId', 'workspaceId', 'workspaceEpoch', 'conversationId', 'nativeSessionId'].every(k => typeof locator[k] === 'string' && locator[k])) return;
    runtimeHistoryHandler?.({ ...locator }, match ? { ...match } : null);
    return;
  }
  if (capMissing('switchSession')) {
    toast('当前 pi 没有提供「切换会话」能力（详情见侧栏「诊断」）', 'warn');
    return;
  }
  doSwitch({ id: res.id, sessionId: res.sessionId, title: res.title, archived: res.archived }, match ? match.userIndex : null);
}

async function doArchive(s, archived) {
  try {
    const r = await archiveSession(s.id, archived);
    if (!r.ok) {
      toast(r.error || '操作失败', 'error');
      return;
    }
    toast(archived ? '已归档：' + s.title : '已取消归档：' + s.title, 'info');
    // 归档只影响我们自己的列表，不需要重开会话
    await refreshSidebarSessions();
    /* 归档会影响 scope 过滤（active / archived / all），所以搜索开着的时候
     * 要重搜一次 —— 不然刚归档的那条还挂在「活跃」结果里。 */
    refreshSearch();
  } catch (err) {
    toast('操作失败：' + err.message, 'error');
  }
}

async function doDelete(s) {
  const ok = await confirmModal({
    title: '删除这个会话？',
    message:
      `「${s.title || '（无标题）'}」会从列表里消失。\n\n` +
      '会话文件**不会被抹掉** —— 它会移到 Pi GUI 的回收站目录，事后仍可人工找回。',
    okText: '删除会话',
    danger: true,
  });
  if (ok !== true) return;
  try {
    const r = await deleteSession(s.id);
    if (!r.ok) {
      toast(r.error || '删除失败', 'error');
      return;
    }
    toast('已删除：' + (s.title || '（无标题）'), 'info');
    if (s.sessionId) clearClassicSessionView(s.sessionId);
    await refreshSidebarSessions();
    // 删掉的东西不该再出现在搜索结果里
    refreshSearch();
  } catch (err) {
    toast('删除失败：' + err.message, 'error');
  }
}
