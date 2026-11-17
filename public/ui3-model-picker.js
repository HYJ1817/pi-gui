/* UI-3B：模型与思考的统一选择器（视图层）。
 *
 * ---------- 它是什么 ----------
 *
 * 一个把「调用方状态里已经存在的模型/档位事实」排版成 DOM 的纯视图。它不持有
 * 模型状态、不缓存业务事实、不发任何 RPC —— 选择动作经注入的 onSelect /
 * onSelectThinking 交回调用方，由既有的 setModel(provider, modelId) /
 * setThinkingLevel(level) 执行。所以这里不存在第二份业务状态，也不存在第二个
 * 模型注册表。
 *
 * ---------- 它复用什么 ----------
 *
 * 弹层外壳、位置管理与关闭行为全部来自 ui/popover.js：同一个 pop 单例、同一个
 * openPop/closePop，本模块不新建全局弹层。条目结构沿用 popItem 的类名契约
 * （.pop-item / .pi-text / .pi-sub / .pi-check），能力数据来自
 * model-capabilities.js，档位来自 thinking-availability.js 与 Pi 的
 * get_available_thinking_levels。
 *
 * ---------- 交互边界 ----------
 *
 *   - 左侧是「最近使用 + 已配置供应商」栏，右侧是当前来源的模型列表；
 *     顶部搜索跨全部供应商，底部是等宽分段推理滑杆。
 *   - 选择模型后菜单不关闭：等 Pi 回读确认，再刷新当前勾选与底部档位。
 *     所有写操作仍由调用方的既有 RPC 路径完成，视图不做乐观选择。
 *   - 推理滑杆的档位完全由 Pi 返回的列表决定；不硬编码 off..max。
 *   - 档位不可用时仍画出来但不可提交，原因来自 thinking-availability。
 *   - 能力三值：未知显示「能力未知」，不画成不支持。
 *   - 最近使用只记 providerId + modelId，存 localStorage；模型清单本身仍以
 *     S.models 为唯一来源，不在本地保存模型元数据。
 */

import { pop, openPop, closePop, currentAnchor, popTitle, popItem } from './ui/popover.js';
import { createIcon } from './ui/icons.js';
import { modelIdentity, modelCapability, modelCapabilitySummary } from './model-capabilities.js';
import { thinkingAvailability as sharedThinkingAvailability } from './thinking-availability.js';

/* Thinking 档位的说明文案。这是**展示文案**不是档位清单 —— 档位一律来自 Pi 的
 * get_available_thinking_levels；这里只是给已知的名字配一句人话，配不上就不配。 */
export const THINK_DESC = {
  off: '不思考，最快',
  minimal: '最少思考',
  low: '轻量思考',
  medium: '中等思考',
  high: '深度思考',
  xhigh: '较高思考预算',
  max: '最大思考预算',
};

const PROVIDER_FALLBACK = '默认';
const RECENT_KEY = 'pi-gui.recent-models.v1';
const RECENT_LIMIT = 6;

/* 当前渲染的折叠记忆与弹层模式。pop 是单例，所以这里也只需要一份。
 * expanded 由调用方持有（跨次打开的记忆），本模块只在原地增删，不复制。 */
let activeExpanded = null;
let activeOptions = null;

/* 统一菜单的重绘状态。只有 preserve 重绘（模型/档位回读刷新）会读它，
 * 用户重新打开菜单时从空状态开始。 */
let menuState = null;
let activeMenuOptions = null;

/* 思考档位提交的短锁：读回前禁用滑杆，避免连续点击发出多条 set_thinking_level。
 * 回读到达（currentLevel 变成请求值）或超时后释放。 */
let thinkingBusy = false;
let thinkingRequestedLevel = null;
let thinkingTimer = null;

/* ---------- 最近使用（只有身份，没有模型元数据） ---------- */

function modelStore() {
  try {
    return globalThis.window?.localStorage || globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function readRecentModelIdentities(store = modelStore()) {
  try {
    const raw = store?.getItem(RECENT_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const providerId = typeof item?.providerId === 'string' ? item.providerId.trim() : '';
      const modelId = typeof item?.modelId === 'string' ? item.modelId.trim() : '';
      if (!providerId || !modelId) continue;
      const key = providerId + '\u0000' + modelId;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ providerId, modelId });
      if (out.length >= RECENT_LIMIT) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function rememberRecentModel(providerId, modelId, store = modelStore()) {
  if (!providerId || !modelId) return;
  try {
    const next = [
      { providerId, modelId },
      ...readRecentModelIdentities(store).filter((item) => item.providerId !== providerId || item.modelId !== modelId),
    ].slice(0, RECENT_LIMIT);
    store?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式 / 存储被禁用：最近使用降级为空，不影响选择模型。 */
  }
}

function modelKey(providerId, modelId) {
  return providerId + '\u0000' + modelId;
}

function recentModelsFor(models, current) {
  const byKey = new Map();
  for (const model of models) {
    const { providerId, modelId } = modelIdentity(model);
    if (providerId && modelId) byKey.set(modelKey(providerId, modelId), model);
  }
  const out = [];
  const seen = new Set();
  const add = (providerId, modelId) => {
    if (!providerId || !modelId) return;
    const key = modelKey(providerId, modelId);
    if (seen.has(key)) return;
    const model = byKey.get(key);
    if (!model) return;
    seen.add(key);
    out.push(model);
  };
  const currentIdentity = modelIdentity(current);
  add(currentIdentity.providerId, currentIdentity.modelId);
  for (const item of readRecentModelIdentities()) add(item.providerId, item.modelId);
  return out.slice(0, RECENT_LIMIT);
}

/* ---------- 纯函数：三值能力 ---------- */

/* 把模型能力摊成带三值状态的行。state 只会是 yes / no / unknown，
 * unknown **不是** no —— 没证据不等于不支持（AGENTS.md 的三值纪律）。 */
export function capabilityFacts(model) {
  const m = modelCapability(model);
  const rows = [];
  const put = (key, label) => {
    const value = m.capabilities[key];
    rows.push({ key, label, state: value === true ? 'yes' : value === false ? 'no' : 'unknown' });
  };
  put('reasoning', '推理');
  put('imageInput', '图片');
  put('toolCalling', 'Tools');
  return {
    rows,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    /* 只有「至少有一条明确证据」才叫已知；全 unknown 时调用方可以据此说「能力未知」。 */
    anyKnown: rows.some((r) => r.state !== 'unknown') || m.contextWindow !== null,
  };
}

/* Runtime 的 <select> 用它做 option 文案：同名不同 Provider 的模型必须能分辨。
 * 纯函数，不碰 DOM，Runtime 可以直接用而不必把状态绑到 Classic 的 S 上。 */
export function modelDisplayLabel(model) {
  const { providerId, modelId } = modelIdentity(model);
  const name = typeof model?.name === 'string' && model.name.trim() ? model.name.trim() : modelId;
  if (!name) return '';
  return providerId ? `${name} · ${providerId}` : name;
}

/* ---------- 纯函数：Thinking 可用性 ---------- */

/* 判定顺序是有讲究的，别调换：
 *
 *   1. pending 优先 —— 正在回读时说什么都不算数（renderModelControls 同此）。
 *   2. **Pi 的实时档位优先于静态 reasoning 位**。Pi 说这个模型有 off/low/high，
 *      那就是有；静态 metadata 里 reasoning=false 是更弱的证据，不覆盖它。
 *      （smoke「reasoning=false 仍按 Pi 返回两档」钉的就是这条。）
 *   3. 没有可用档位时才回头解释原因，且区分三种：明确不支持 / 能力未知 / Pi 没给。
 *
 * 只有 off 的清单视为不可用：全是 off 等于没有可调的推理强度。 */
export function thinkingAvailability(input = {}) {
  return sharedThinkingAvailability(input);
}

/* ---------- 键盘导航 ---------- */

/* 可见且可操作的节点：跳掉折叠起来的那几组，也跳掉 disabled 的。
 * closest('[hidden]') 对条目能找到收起的容器，对独立按钮返回 null。 */
function navigables() {
  return [...new Set(pop.querySelectorAll('.model-rail-item, .ui3-model-item, .pop-provider, .pop-item'))]
    .filter((node) => !node.disabled && !node.closest('[hidden]'));
}

function focusNav(node, list = navigables()) {
  for (const n of list) n.tabIndex = n === node ? 0 : -1;
  node.focus();
  /* jsdom 没有布局，scrollIntoView 可能不存在或不做布局。 */
  if (typeof node.scrollIntoView === 'function') {
    try { node.scrollIntoView({ block: 'nearest' }); } catch { /* 布局不可用，忽略 */ }
  }
}

/* openPop 会自己挑一个初始焦点；把它对齐到 roving tabindex 上，
 * 否则第一个被聚焦的元素 tabindex 是 -1，下一次 Tab 会从别处接上。 */
function syncRoving() {
  const list = navigables();
  if (!list.length) return;
  const active = list.includes(document.activeElement) ? document.activeElement : list[0];
  for (const node of list) node.tabIndex = node === active ? 0 : -1;
}

/* 展开/收起一组 Provider（保留给旧的 renderThinkingPicker / 兼容路径）。 */
function toggleProvider(header, force) {
  const group = header.closest('.pop-model-group');
  const container = group?.querySelector('.pop-provider-models');
  if (!container) return;
  const expand = force === undefined ? container.hidden : force;
  const provider = group.dataset.provider;
  if (activeExpanded) {
    if (expand) activeExpanded.add(provider);
    else activeExpanded.delete(provider);
  }
  container.hidden = !expand;
  header.setAttribute('aria-expanded', String(expand));
  /* 折叠改变了弹层高度，位置按外壳自己的算法重算；openPop 会顺手挪一次焦点，
   * 所以焦点要重新落回组头，漫游索引也跟着重算。 */
  reposition();
  header.focus();
  syncRoving();
}

/* 折叠会改变弹层高度，位置得按外壳自己的算法重算一遍。
 * 直接复用 openPop —— 本模块不实现第二套定位。 */
function reposition() {
  const anchor = currentAnchor();
  if (!anchor || !activeOptions) return;
  openPop(anchor, activeOptions);
}

pop.addEventListener('keydown', (event) => {
  const node = event.target?.closest?.('.model-rail-item, .ui3-model-item, .pop-provider, .pop-item');
  if (!node || !pop.contains(node)) return;
  const list = navigables();
  const index = list.indexOf(node);
  if (index < 0) return;
  const move = (next) => {
    event.preventDefault();
    focusNav(list[(next + list.length) % list.length], list);
  };
  if (event.key === 'ArrowDown') return move(index + 1);
  if (event.key === 'ArrowUp') return move(index - 1);
  if (event.key === 'Home') return move(0);
  if (event.key === 'End') return move(list.length - 1);
  if (event.key === 'ArrowLeft' && node.classList.contains('ui3-model-item')) {
    event.preventDefault();
    const rail = pop.querySelector('.model-rail-item.on') || pop.querySelector('.model-rail-item');
    if (rail) focusNav(rail);
    return;
  }
  if (event.key === 'ArrowRight' && node.classList.contains('model-rail-item')) {
    event.preventDefault();
    const row = pop.querySelector('.ui3-model-item:not(:disabled)');
    if (row) focusNav(row);
    return;
  }
  if (event.key === 'ArrowRight' && node.classList.contains('pop-provider')) {
    event.preventDefault();
    return toggleProvider(node, true);
  }
  if (event.key === 'ArrowLeft' && node.classList.contains('pop-provider')) {
    event.preventDefault();
    return toggleProvider(node, false);
  }
  /* Enter / Space 不处理：条目是原生 button，交给浏览器默认行为，
   * 免得手动派发 click 把「回调只触发一次」变成两次。 */
});

/* Escape 在搜索框有内容时先清搜索，再交给外壳关闭浮层。
 * 只注册一次：重复注册会在每次回读重绘后叠加监听器。 */
pop.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !pop.classList.contains('model-menu')) return;
  const field = pop.querySelector('.ui3-model-search');
  if (!field?.value) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  field.value = '';
  menuState = { ...(menuState || {}), query: '', caret: 0 };
  const view = renderModelPicker({ ...activeMenuOptions, preserve: true });
  view?.search?.focus();
}, true);

/* ---------- Chip 状态 ---------- */

/* 给 Chip 挂一个可供 CSS 选择的状态值。Chip 的文案与 disabled 仍由 composer.js 的
 * renderModelControls 决定（那是它的职责）；这里只补一个它表达不了的东西：
 * 「不可用」到底是哪一种。接线前 CSS 只认 :disabled，接线后才有分档配色。 */
export function applyChipState(button, state) {
  if (!button) return;
  if (state) button.dataset.ui3State = state;
  else delete button.dataset.ui3State;
}

/* ---------- 模型 + 思考统一菜单 ---------- */

function groupByProvider(models) {
  const groups = new Map();
  for (const model of models) {
    const provider = modelIdentity(model).providerId || PROVIDER_FALLBACK;
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(model);
  }
  return groups;
}

function focusKeyOf(node) {
  if (!node) return null;
  if (node.dataset?.menuKey) return node.dataset.menuKey;
  return null;
}

function markFocusable(node, key) {
  node.dataset.menuKey = key;
  return node;
}

function sectionExists(section, recentCount, groups) {
  if (section === 'recent') return recentCount > 0;
  if (typeof section === 'string' && section.startsWith('provider:')) {
    return groups.has(section.slice('provider:'.length));
  }
  return false;
}

function matchesQuery(model, query) {
  if (!query) return true;
  const { providerId, modelId } = modelIdentity(model);
  return `${model?.name || ''}\n${modelId}\n${providerId}`.toLocaleLowerCase().includes(query);
}

function clearThinkingBusy(refresh = false) {
  clearTimeout(thinkingTimer);
  thinkingTimer = null;
  thinkingBusy = false;
  thinkingRequestedLevel = null;
  if (refresh) activeMenuOptions?.onRefresh?.();
}

function beginThinkingBusy(level) {
  clearTimeout(thinkingTimer);
  thinkingBusy = true;
  thinkingRequestedLevel = level;
  thinkingTimer = setTimeout(() => {
    thinkingTimer = null;
    thinkingBusy = false;
    thinkingRequestedLevel = null;
    if (activeMenuOptions?.onRefresh) activeMenuOptions.onRefresh();
    else if (!pop.hidden && pop.classList.contains('model-menu')) {
      renderModelPicker({ ...activeMenuOptions, preserve: true });
    }
  }, 2600);
}

/**
 * 把模型与思考画进共享弹层并打开。
 * 参数全部显式注入，本函数不读任何全局业务状态。
 *
 * @param {object}   o
 * @param {object[]} o.models           可用模型列表（S.models）
 * @param {object}   o.current          当前模型（S.state.model），原样传入即可
 * @param {boolean}  o.pending          set_model 是否在途
 * @param {string[]} o.levels           Pi 返回的思考档位（S.thinkingLevels）
 * @param {string}   o.currentLevel     当前档位（S.state.thinkingLevel）
 * @param {string}   o.readStatus       档位读取状态（S.thinkingReadStatus）
 * @param {Function} o.onSelect         (providerId, modelId) => void
 * @param {Function} o.onSelectThinking (level) => void
 * @param {Function} o.onClose          本视图主动关闭时回调
 * @param {Function} [o.onOpenSettings] 顶部齿轮：打开现有的模型/供应商设置
 * @param {Function} [o.onRefresh]      请求调用方用最新状态重绘本菜单
 * @param {Function} [o.capabilitySummary]
 * @param {string}   [o.title]
 * @param {boolean}  [o.preserve]       回读刷新用；不要由打开入口传 true
 */
export function renderModelPicker({
  models = [],
  current = null,
  expanded = null,
  pending = false,
  levels = [],
  currentLevel = null,
  readStatus = 'success',
  onSelect = () => {},
  onSelectThinking = () => {},
  onClose = () => {},
  onOpenSettings = null,
  onRefresh = null,
  capabilitySummary = modelCapabilitySummary,
  title = '模型与思考',
  preserve = false,
  /* 只由本模块点击档位后的那次自绘传入：提交已发出、回读未到，短锁要继续；
   * 任何外部刷新（回读/失败纠正）都应立即解锁，不能让失败把滑杆锁 2.6 秒。 */
  keepBusy = false,
} = {}) {
  activeExpanded = expanded;
  activeOptions = { model: true };

  const wasOpen = Boolean(preserve && !pop.hidden && pop.classList.contains('model-menu'));
  const previousFocus = wasOpen ? focusKeyOf(document.activeElement) : null;
  const previousSearch = wasOpen ? pop.querySelector('.ui3-model-search') : null;
  const previousCaret = previousSearch ? previousSearch.selectionStart : null;
  const previousScroll = wasOpen ? (pop.querySelector('.model-pane-list')?.scrollTop || 0) : 0;
  const previousQuery = previousSearch ? previousSearch.value : '';
  const previousSection = wasOpen ? menuState?.section : null;

  /* 外部刷新（回读成功、失败纠正、模型切换）到达时释放短锁。
   * 自己点完档位的那次重绘用 keepBusy 留住锁，避免回读前重复提交。 */
  if (thinkingBusy && !keepBusy) clearThinkingBusy(false);

  activeMenuOptions = {
    models, current, pending, levels, currentLevel, readStatus,
    onSelect, onSelectThinking, onClose, onOpenSettings, onRefresh,
    capabilitySummary, title,
  };

  const list = Array.isArray(models) ? models.filter((model) => modelIdentity(model).modelId) : [];
  const groups = groupByProvider(list);
  const providerIds = [...groups.keys()];
  const recent = recentModelsFor(list, current);
  const { providerId: currentProvider, modelId: currentId } = modelIdentity(current);
  const currentKey = currentProvider && currentId ? modelKey(currentProvider, currentId) : '';

  /* 输入框保留用户原样大小写与光标；匹配时才折叠大小写。
   * menuState.query 也存原样，重绘回来才不会把「GLM」改写成「glm」。 */
  const query = previousQuery.trim().toLocaleLowerCase();
  let section = previousSection;
  if (!query) {
    if (!sectionExists(section, recent.length, groups)) {
      section = recent.length
        ? 'recent'
        : currentProvider && groups.has(currentProvider)
          ? 'provider:' + currentProvider
          : providerIds[0] ? 'provider:' + providerIds[0] : 'recent';
    }
  }
  menuState = { section, query: previousQuery };

  pop.innerHTML = '';
  /* 根标记：回读重绘要靠它判断「菜单还开着」，Escape 先清搜索也靠它。
   * 搜索/左栏/右栏都只是它的子节点。 */
  pop.classList.add('model-menu');

  /* ---------- 顶部：搜索 + 设置 ---------- */
  const searchRow = document.createElement('div');
  searchRow.className = 'model-menu-search';
  searchRow.append(createIcon('search', { className: 'model-menu-search-ic' }));

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'ui3-model-search ds-readable-placeholder';
  search.placeholder = '搜索模型';
  search.setAttribute('aria-label', '搜索模型');
  search.value = previousQuery;
  markFocusable(search, 'search');
  searchRow.appendChild(search);

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'model-search-clear';
  clear.setAttribute('aria-label', '清除搜索');
  clear.title = '清除搜索';
  clear.hidden = !query;
  clear.appendChild(createIcon('close', { size: 12, className: 'model-search-clear-ic' }));
  markFocusable(clear, 'clear');
  clear.onclick = () => {
    /* 重绘从输入框读原样查询，所以清空也要写回 DOM，不能只改 menuState。 */
    search.value = '';
    menuState = { ...menuState, query: '', caret: 0 };
    const view = renderModelPicker({ ...activeMenuOptions, preserve: true });
    view?.search?.focus();
  };
  searchRow.appendChild(clear);

  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'model-menu-settings';
  gear.setAttribute('aria-label', '模型与供应商设置');
  gear.title = '模型与供应商设置';
  gear.appendChild(createIcon('settings', { size: 14, className: 'model-menu-settings-ic' }));
  markFocusable(gear, 'settings');
  gear.onclick = () => {
    closePop();
    onOpenSettings?.();
  };
  searchRow.appendChild(gear);
  search.addEventListener('input', () => {
    menuState = { ...menuState, query: search.value, caret: search.selectionStart };
    renderModelPicker({ ...activeMenuOptions, preserve: true });
  });
  search.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const first = pop.querySelector('.ui3-model-item:not(:disabled)');
      if (first) focusNav(first);
    }
    if (event.key === 'Enter') event.preventDefault();
  });

  /* ---------- 主体：左栏 + 右列表 ---------- */
  const body = document.createElement('div');
  body.className = 'model-menu-body';

  const rail = document.createElement('div');
  rail.className = 'model-rail';
  rail.setAttribute('role', 'tablist');
  rail.setAttribute('aria-label', '模型来源');
  rail.setAttribute('aria-orientation', 'vertical');

  const matches = query ? list.filter((model) => matchesQuery(model, query)) : [];
  const matchGroups = new Map();
  for (const model of matches) {
    const provider = modelIdentity(model).providerId || PROVIDER_FALLBACK;
    if (!matchGroups.has(provider)) matchGroups.set(provider, []);
    matchGroups.get(provider).push(model);
  }

  const railEntries = [];
  if (query) {
    railEntries.push({ section: 'search', label: '搜索结果', count: matches.length, active: true });
    for (const provider of providerIds) {
      const count = matchGroups.get(provider)?.length || 0;
      if (count) railEntries.push({ section: 'provider:' + provider, label: provider, count, provider });
    }
  } else {
    if (recent.length) {
      railEntries.push({ section: 'recent', label: '最近使用', count: recent.length, active: section === 'recent' });
    }
    for (const provider of providerIds) {
      railEntries.push({
        section: 'provider:' + provider,
        label: provider,
        count: groups.get(provider).length,
        active: section === 'provider:' + provider,
        provider,
      });
    }
  }

  for (const entry of railEntries) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'model-rail-item' + (entry.active ? ' on' : '');
    item.dataset.section = entry.section;
    if (entry.provider) item.dataset.provider = entry.provider;
    item.setAttribute('role', 'tab');
    item.setAttribute('aria-selected', String(Boolean(entry.active)));
    item.title = entry.label;
    markFocusable(item, 'rail:' + entry.section);

    const name = document.createElement('span');
    name.className = 'model-rail-name pop-provider-name';
    name.textContent = entry.label;
    const count = document.createElement('span');
    count.className = 'model-rail-count pop-provider-count';
    count.textContent = String(entry.count);
    item.append(name, count);

    item.onclick = () => {
      const nextQuery = entry.section === 'search' ? menuState.query : '';
      menuState = { section: entry.section, query: nextQuery };
      renderModelPicker({ ...activeMenuOptions, preserve: true });
    };
    rail.appendChild(item);
  }

  const pane = document.createElement('div');
  pane.className = 'model-pane';
  const paneHead = document.createElement('div');
  paneHead.className = 'model-pane-head';
  const paneTitle = document.createElement('span');
  paneTitle.className = 'model-pane-title';
  const paneCount = document.createElement('span');
  paneCount.className = 'model-pane-count';
  paneHead.append(paneTitle, paneCount);

  const listWrap = document.createElement('div');
  listWrap.className = 'model-pane-list';
  listWrap.setAttribute('role', 'menu');
  listWrap.setAttribute('aria-label', '模型列表');
  listWrap.setAttribute('aria-busy', String(Boolean(pending)));

  const addGroupLabel = (provider) => {
    const label = document.createElement('div');
    label.className = 'model-group-label';
    label.textContent = provider;
    listWrap.appendChild(label);
  };

  const addRow = (model, { showProvider }) => {
    const { providerId, modelId } = modelIdentity(model);
    const provider = providerId || PROVIDER_FALLBACK;
    const id = modelId || model?.name || '';
    const on = Boolean(currentKey) && modelKey(provider, id) === currentKey;
    const name = typeof model?.name === 'string' && model.name.trim() ? model.name.trim() : id;
    const summary = capabilitySummary(model);
    const facts = capabilityFacts(model);
    const unknown = !summary.text && !facts.anyKnown;
    const bits = [];
    if (showProvider) bits.push(provider);
    if (summary.text) bits.push(summary.text);
    else if (unknown) bits.push('能力未知');
    if (!showProvider && name !== id) bits.push(id);
    const sub = bits.join(' · ');

    const item = popItem({
      label: name,
      sub,
      on,
      onClick: () => {
        /* pending 时仍允许点下一个：setModel 自己维护 queuedModelSwitch，
         * 这是既有行为，选择器不额外把连点变成静默丢弃。 */
        if (on) return;
        rememberRecentModel(provider, id);
        onSelect(provider, id);
      },
    });
    item.classList.add('ui3-model-item');
    item.dataset.provider = provider;
    item.dataset.modelId = id;
    item.dataset.reasoning = facts.rows.find((row) => row.key === 'reasoning')?.state || 'unknown';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(on));
    item.tabIndex = -1;
    markFocusable(item, 'row:' + provider + '/' + id);
    if (unknown) item.querySelector('.pi-sub')?.classList.add('ui3-cap-unknown');
    /* 完整能力（含明确不支持项与 Max output）留在 title —— 行内只放正向事实，
     * 未知绝不在行内显示成不支持（docs/model-capabilities.md）。 */
    item.title = [
      name,
      `${provider} / ${id}`,
      summary.title || (unknown ? 'Pi 未提供这个模型的能力信息' : ''),
    ].filter(Boolean).join('\n');
    listWrap.appendChild(item);
    return item;
  };

  if (!list.length) {
    paneTitle.textContent = '模型';
    paneCount.textContent = '0';
    const empty = document.createElement('div');
    empty.className = 'model-menu-empty';
    empty.textContent = '还没有可用的模型';
    listWrap.appendChild(empty);
  } else if (query) {
    paneTitle.textContent = '搜索结果';
    paneCount.textContent = String(matches.length);
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'model-menu-empty';
      empty.textContent = '没有匹配的模型';
      listWrap.appendChild(empty);
    } else {
      for (const [provider, providerModels] of matchGroups) {
        addGroupLabel(provider);
        for (const model of providerModels) addRow(model, { showProvider: true });
      }
    }
  } else if (section === 'recent') {
    paneTitle.textContent = '最近使用';
    paneCount.textContent = String(recent.length);
    const recentGroups = new Map();
    for (const model of recent) {
      const provider = modelIdentity(model).providerId || PROVIDER_FALLBACK;
      if (!recentGroups.has(provider)) recentGroups.set(provider, []);
      recentGroups.get(provider).push(model);
    }
    for (const [provider, providerModels] of recentGroups) {
      addGroupLabel(provider);
      /* 最近使用可能混着多个 Provider：行内必须带 Provider，
       * 同名模型才分得清是哪一个。 */
      for (const model of providerModels) addRow(model, { showProvider: true });
    }
  } else {
    const provider = section.slice('provider:'.length);
    const providerModels = groups.get(provider) || [];
    paneTitle.textContent = provider;
    paneCount.textContent = String(providerModels.length);
    for (const model of providerModels) addRow(model, { showProvider: false });
  }

  if (pending) {
    const status = document.createElement('div');
    status.className = 'model-menu-pending';
    status.setAttribute('role', 'status');
    status.textContent = '正在切换模型…';
    paneHead.appendChild(status);
  }

  pane.append(paneHead, listWrap);
  body.append(rail, pane);
  pop.append(searchRow, body);

  /* ---------- 底部：推理档位滑杆 ---------- */
  const availability = thinkingAvailability({ model: current, levels, pending, readStatus });
  const canSelectThinking = availability.state === 'ready' && !pending && !thinkingBusy;
  const thinkSection = document.createElement('div');
  thinkSection.className = 'model-thinking';

  const thinkHead = document.createElement('div');
  thinkHead.className = 'model-thinking-head';
  const thinkLabel = document.createElement('span');
  thinkLabel.className = 'model-thinking-label';
  thinkLabel.textContent = '推理';
  const thinkCurrent = document.createElement('span');
  thinkCurrent.className = 'model-thinking-current';
  thinkCurrent.textContent = thinkingBusy
    ? '同步中…'
    : availability.state === 'ready'
      ? (currentLevel || '—')
      : '不可用';
  thinkHead.append(thinkLabel, thinkCurrent);
  thinkSection.appendChild(thinkHead);

  if (availability.state !== 'ready') {
    const state = document.createElement('div');
    state.className = 'ui3-think-state';
    state.dataset.state = availability.state;
    state.textContent = availability.detail;
    thinkSection.appendChild(state);
  }

  const sliderLevels = availability.levels;
  if (sliderLevels.length) {
    const selectedIndex = Math.max(0, sliderLevels.indexOf(currentLevel));
    const slider = document.createElement('div');
    slider.className = 'model-thinking-slider';
    slider.style.setProperty('--stop-count', String(sliderLevels.length));
    slider.style.setProperty('--thinking-progress', `${(selectedIndex / sliderLevels.length) * 100}%`);

    const railEl = document.createElement('div');
    railEl.className = 'model-thinking-rail';
    const thumb = document.createElement('span');
    thumb.className = 'model-thinking-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    const ticks = document.createElement('div');
    ticks.className = 'model-thinking-ticks';
    ticks.setAttribute('role', 'radiogroup');
    ticks.setAttribute('aria-label', '思考等级');

    for (const level of sliderLevels) {
      const tick = document.createElement('button');
      tick.type = 'button';
      tick.className = 'model-thinking-tick ui3-think-item' + (level === currentLevel ? ' on' : '');
      tick.dataset.level = level;
      tick.setAttribute('role', 'radio');
      tick.setAttribute('aria-checked', String(level === currentLevel));
      tick.tabIndex = -1;
      tick.disabled = !canSelectThinking;
      tick.textContent = level;
      if (THINK_DESC[level]) tick.title = THINK_DESC[level];
      tick.onclick = () => {
        if (!canSelectThinking || level === currentLevel) return;
        beginThinkingBusy(level);
        onSelectThinking(level);
        renderModelPicker({ ...activeMenuOptions, preserve: true, keepBusy: true });
      };
      ticks.appendChild(tick);
    }

    const range = document.createElement('input');
    range.type = 'range';
    range.className = 'model-thinking-range';
    range.min = '0';
    range.max = String(Math.max(0, sliderLevels.length - 1));
    range.step = '1';
    range.value = String(selectedIndex);
    range.disabled = !canSelectThinking;
    range.setAttribute('aria-label', '思考等级');
    range.setAttribute('aria-valuetext', currentLevel || sliderLevels[selectedIndex] || '');
    markFocusable(range, 'slider');
    range.addEventListener('input', () => {
      const level = sliderLevels[Number(range.value)];
      if (!canSelectThinking || !level || level === currentLevel) return;
      beginThinkingBusy(level);
      onSelectThinking(level);
      renderModelPicker({ ...activeMenuOptions, preserve: true, keepBusy: true });
    });

    railEl.append(thumb, ticks, range);
    slider.appendChild(railEl);
    thinkSection.appendChild(slider);
  }

  pop.appendChild(thinkSection);

  openPop(anchorFor('model'), { model: true });
  pop.setAttribute('aria-label', title);
  syncRoving();

  if (previousFocus) {
    const target = [...pop.querySelectorAll('[data-menu-key]')]
      .find((node) => node.dataset.menuKey === previousFocus);
    if (target) {
      focusNav(target);
      if (target === search && Number.isInteger(previousCaret)) {
        try { target.setSelectionRange(previousCaret, previousCaret); } catch { /* range 不支持时忽略 */ }
      }
    }
  }
  if (previousScroll && listWrap) listWrap.scrollTop = previousScroll;

  return { search };
}

/* ---------- Thinking 等级选择器（保留给只读说明 / 兼容路径） ---------- */

/**
 * 把 Thinking 档位画进共享弹层并打开。档位只来自 Pi 的 get_available_thinking_levels。
 * @param {object}   o
 * @param {string[]} o.levels       Pi 返回的档位（S.thinkingLevels）
 * @param {string}   o.current      当前档位（S.state.thinkingLevel）
 * @param {object}   o.model        当前模型（用于解释「为什么没有档位」）
 * @param {boolean}  o.pending      set_model 是否在途
 * @param {Function} o.onSelect     (level) => void
 * @param {Function} o.onClose
 * @param {object}   [o.descriptions]
 * @param {string}   [o.title]
 */
export function renderThinkingPicker({
  levels = [],
  current = null,
  model = null,
  pending = false,
  readStatus = 'success',
  onSelect = () => {},
  onClose = () => {},
  descriptions = THINK_DESC,
  title = '思考等级',
} = {}) {
  activeExpanded = null;
  activeOptions = {};
  pop.classList.remove('model-menu');

  const availability = thinkingAvailability({ model, levels, pending, readStatus });

  pop.innerHTML = '';
  pop.appendChild(popTitle(title));

  /* 有档位时不画状态行 —— 「有 4 个档位」不是信息。不可用时才解释原因。 */
  if (availability.state !== 'ready') {
    const state = document.createElement('div');
    state.className = 'ui3-think-state';
    state.dataset.state = availability.state;
    state.textContent = availability.detail;
    pop.appendChild(state);
  }

  for (const level of availability.levels) {
    const item = popItem({
      label: level,
      sub: descriptions[level] || '',
      on: level === current,
      onClick: () => {
        closePop({ restoreFocus: true });
        onClose();
        onSelect(level);
      },
    });
    item.classList.add('ui3-think-item');
    item.dataset.level = level;
    /* 不可用时档位照画但不可点 —— 让用户看见「Pi 到底给了哪几个」，而不是一个空弹层。 */
    if (availability.state !== 'ready') {
      item.disabled = true;
      item.tabIndex = -1;
    }
    pop.appendChild(item);
  }

  openPop(anchorFor('think'), activeOptions);
  syncRoving();
  // Read-only explanations may have no enabled options. Give the dialog
  // keyboard focus so its existing Escape handler remains reachable.
  if (!pop.contains(document.activeElement)) {
    pop.tabIndex = -1;
    pop.focus();
  }
}

/* ---------- 触发元素 ---------- */

/* 触发按钮由调用方通过 setTrigger 告知，或者由 anchor 参数显式传入。
 * 之所以要这一层：openPop 需要一个真实的锚元素来定位与写 aria-expanded，
 * 而本模块不 import app.js 的 el 表（那会造成视图反向依赖装配层）。 */
let triggers = { model: null, think: null };
export function setTriggers(next = {}) {
  triggers = { ...triggers, ...next };
}
function anchorFor(kind) {
  const explicit = triggers[kind];
  if (explicit) return explicit;
  return document.getElementById(kind === 'model' ? 'btnModel' : 'btnThink');
}
