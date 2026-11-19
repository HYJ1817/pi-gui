/* 侧栏会话搜索的开关状态。
 *
 * 搜索框本身属于当前项目的会话区（见 session-search.js / sessions.js）；
 * 本模块只回答「现在是不是搜索态」，并把打开 / 关闭 / 切换收敛到同一处。
 *
 * 为什么要单独一层：
 *   - 侧栏图标、顶栏图标、Escape 与命令面板都会碰搜索；让每个入口各自
 *     改 `search-open`、`aria-expanded` 和搜索状态，迟早出现「图标还亮着、
 *     搜索框已经没了」这种半开状态。
 *   - 关闭必须是真关闭：取消 debounce、作废在途请求、清空真实输入框、
 *     把范围复位到默认，并把列表区重画回普通会话列表 —— 不能只用 CSS
 *     把搜索区藏起来。折叠整个「项目」分组或当前项目会话块时同理。
 */
import { resetSearch } from './session-search.js';
import { expandSidebarSessions } from './sessions.js';

let refs = null;

/**
 * @param {object} options
 * @param {HTMLElement} options.sidebar        项目侧栏根节点
 * @param {HTMLElement} options.navSearch      侧栏搜索图标
 * @param {HTMLElement} [options.topbarSearch] 顶栏搜索图标（与侧栏状态共享）
 * @param {HTMLElement} options.group          「项目」分组容器
 * @param {HTMLElement} options.groupHead      「项目」分组标题按钮
 * @param {() => void} options.ensureSidebarExpanded 侧栏折叠时把它展开
 */
export function initSidebarSearch(options) {
  refs = options;
  /* 当前项目的会话列表被用户折叠时，搜索框也跟着不可见 —— 此时
   * search-open 必须一起结束，且走同一个关闭入口。 */
  document.addEventListener('pi-gui:active-sessions-collapsed', () => {
    if (sessionSearchOpen()) closeSessionSearch({ restoreFocus: false });
  });
  /* 整个「项目」分组被收起时，搜索框也一起不可见。与单个项目折叠走
   * 同一个关闭入口，不能让图标停留在选中态、留下一个看不见的搜索。 */
  document.addEventListener('pi-gui:project-group-collapsed', () => {
    if (sessionSearchOpen()) closeSessionSearch({ focusTarget: refs.groupHead });
  });
}

export function sessionSearchOpen() {
  return Boolean(refs && refs.sidebar.classList.contains('search-open'));
}

function setIconState(open) {
  for (const button of [refs?.navSearch, refs?.topbarSearch]) {
    if (!button) continue;
    button.setAttribute('aria-expanded', String(open));
    button.classList.toggle('is-active', open);
  }
}

function expandProjectGroup() {
  refs.group.classList.add('open');
  refs.groupHead.setAttribute('aria-expanded', 'true');
}

/** 输入框由会话列表重建；首次加载还没画出来时有限次重试，别让「打开搜索」
 *  落在空气上。关闭搜索后重试自行停止（状态已经不再是打开）。 */
function focusSearchInput(attempt = 0) {
  if (!refs || !sessionSearchOpen()) return;
  const input = refs.sidebar.querySelector('.pj-search-input');
  if (input) {
    input.focus();
    return;
  }
  if (attempt < 20) setTimeout(() => focusSearchInput(attempt + 1), 50);
}

/**
 * 打开搜索并聚焦输入框。
 *
 * 这是**明确要求打开**的入口（命令 / 快捷键 / 菜单动作）。它不 toggle：
 * 搜索已经开着时只把焦点送回输入框，不会把用户刚打开的搜索又关掉。
 */
export function openSessionSearch({ focus = true } = {}) {
  if (!refs) return;
  refs.ensureSidebarExpanded?.();
  expandProjectGroup();
  refs.sidebar.classList.add('search-open');
  setIconState(true);
  /* 会话列表可能被用户折叠着 —— 输入框就在那块列表里，不先展开的话
   * 「搜索会话」点下去什么都不会发生（focus 一个隐藏元素是空操作）。 */
  expandSidebarSessions();
  if (focus) focusSearchInput();
}

/**
 * 关闭搜索并恢复正常会话列表。
 *
 * @param {object} options
 * @param {HTMLElement} [options.focusTarget] 关闭后把焦点还给谁（默认侧栏图标）
 * @param {boolean} [options.restoreFocus] 是否移动焦点
 */
export function closeSessionSearch({ focusTarget = null, restoreFocus = true } = {}) {
  if (!refs) return;
  const wasOpen = sessionSearchOpen();
  refs.sidebar.classList.remove('search-open');
  setIconState(false);
  /* 统一走 resetSearch：取消 debounce、requestId++ 作废在途请求、
   * 清空真实输入框，并触发宿主重画普通列表。 */
  resetSearch();
  if (restoreFocus && wasOpen) (focusTarget || refs.navSearch)?.focus();
}

/** 交替打开 / 关闭；用于侧栏与顶栏那两个图标入口。 */
export function toggleSessionSearch(trigger = null) {
  if (sessionSearchOpen()) closeSessionSearch({ focusTarget: trigger || refs?.navSearch });
  else openSessionSearch();
}
