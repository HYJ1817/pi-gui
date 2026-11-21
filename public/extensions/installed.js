/* 扩展 › 已安装：Pi 原生 Extension Registry 的只读清单 + 已知能力设置。
 *
 * - 清单来自 `/api/extensions`（只读 Registry，包括完全不认识的扩展，保持可浏览可诊断）。
 *   本面板不安装、不启用、不执行任何扩展；Registry 的 actions 由服务端声明。
 *   版式对照 PI-Desktop 已安装页：按状态分组的卡片网格，卡片可展开查看完整事实。
 * - 「已知能力」沿用 Web Access / Subagents / Pi Memory / Browser Use 的 setup 投影
 *   （一键安装走 ui/capability-setup.js 的白名单实现）和 Approval 协议探测。
 *   setup 安装后的 recheck 会交回新的 Registry，清单随之换成同一份新证据。
 * - 所有异步结果都经过 `isLive()`（页面实例仍是当前）+ 工作区代号 + 本面板的请求序号三重校验。
 * - 返回 `{ toolbar, actions }`：搜索框与刷新按钮由页面壳挂到页签行 / 页头（与 PI-Desktop 同一位置），
 *   节点归本面板所有，切页签时复用。 */

import { S, ownsWorkspace } from '../state.js';
import { fetchExtensions, fetchApprovalCapability } from '../api.js';
import { SURFACE_COPY } from '../status-copy.js';
import { createIcon } from '../ui/icons.js';
import { createBadge } from '../ui/primitives.js';
import { resourceEl as el, resourceRow as row, resourceNote as note } from '../ui/resource-dom.js';
import { renderWebSetup } from '../web-access.js';
import { renderSubagentSetup } from '../subagents.js';
import { renderMemorySetup } from '../memory.js';
import { renderBrowserSetup } from '../browser.js';
import { renderApprovalSetup } from '../approval.js';
import {
  extensionCardMeta, extensionCardTags, extensionDisplayName, extensionFactRows, extensionStateLabel,
  filterExtensions, groupExtensions,
} from './model.js';

const KNOWN_SETUPS = Object.freeze([
  Object.freeze({ id: 'web', label: 'Web Access', render: renderWebSetup }),
  Object.freeze({ id: 'subagents', label: 'Subagents', render: renderSubagentSetup }),
  Object.freeze({ id: 'memory', label: 'Pi Memory', render: renderMemorySetup }),
  Object.freeze({ id: 'browser', label: 'Browser Use', render: renderBrowserSetup }),
]);
const STALE_TEXT = '项目已切换，刷新后查看当前项目的扩展。';
const PI_SILENT_NOTE = 'Pi 未应答，无法确认实际加载状态。';
const NO_PROJECT_NOTE = '还没有打开项目，只显示全局扩展与 pi 自带的能力。';
const EMPTY_FILTERED = '没有符合搜索条件的扩展';
const EMPTY_NONE = '还没有发现已安装的扩展';
const TOOL_REGISTRY_NOTE = 'Pi RPC 未提供已注册工具列表；工具来源未知时，聊天时间线仍按原始名称显示。';
/** 卡片上直接列出的已确认能力个数；多出来的折成「另有 N 项」，完整清单在详情里。 */
const CARD_CAPABILITY_LIMIT = 3;

/** 分组标题：名称 + 条数（与技能页、PI-Desktop 同一种组头）。 */
function groupHead(title, count, titleId) {
  const head = el('header', 'extensions-group-head');
  const heading = el('h3', 'extensions-group-title', title);
  if (titleId) heading.id = titleId;
  head.append(heading, el('span', 'extensions-group-count', String(count)));
  return head;
}

/** 空 / 失败 / 已切换项目时的状态瓦片。 */
function stateTile(text, { icon = 'box', hint = '', action = null } = {}) {
  const box = el('div', 'extensions-empty');
  const chip = el('span', 'extensions-empty-icon');
  chip.append(createIcon(icon, { size: 16 }));
  box.append(chip, el('div', 'extensions-empty-title', text));
  if (hint) box.append(el('div', 'extensions-empty-text', hint));
  if (action) {
    const button = el('button', 'btn tiny', action.label);
    button.type = 'button';
    button.onclick = action.onClick;
    box.append(button);
  }
  return box;
}

function knownSetupsSection() {
  const known = el('section', 'ext-known');
  const titleId = 'extensionsKnownTitle';
  known.setAttribute('aria-labelledby', titleId);
  const body = el('div', 'ext-known-body');
  known.append(groupHead('已知能力', KNOWN_SETUPS.length + 1, titleId), body);
  const boxes = new Map();
  const addItem = (id, label) => {
    const details = el('details', 'ext-known-item');
    const box = el('div', 'ext-known-item-body');
    details.append(el('summary', 'ext-known-item-summary', label), box);
    body.append(details);
    boxes.set(id, box);
  };
  for (const item of KNOWN_SETUPS) addItem(item.id, item.label);
  addItem('approval', 'Approval / Permission');
  return { element: known, boxes };
}

/**
 * @param holder  面板容器（由页面壳创建并持有）
 * @param options.isLive   页面实例是否仍是当前（Work Surface 身份）
 * @param options.onCount  已安装数量变化时回调（null = 未知），供页签显示
 * @returns {{ dispose(): void, toolbar: HTMLElement, actions: HTMLElement }}
 */
export function renderInstalledExtensions(holder, { isLive, onCount = () => {} }) {
  /* 页签行右侧：结果数（只在搜索时出现）+ 搜索框。 */
  const toolbar = el('div', 'extensions-toolbar');
  const resultCount = el('span', 'extensions-result-count');
  resultCount.setAttribute('aria-live', 'polite');
  const search = el('label', 'extensions-search ds-search-field ds-search-control');
  search.append(createIcon('search', { size: 14, className: 'extensions-search-icon' }));
  const searchInput = el('input', 'extensions-search-input');
  searchInput.type = 'search';
  searchInput.placeholder = '搜索扩展';
  searchInput.setAttribute('aria-label', '搜索已安装的扩展');
  search.append(searchInput);
  toolbar.append(resultCount, search);
  /* 页头右侧：刷新（重读 Registry）。 */
  const refresh = el('button', 'btn ghost extensions-refresh');
  refresh.type = 'button';
  refresh.append(createIcon('refresh', { size: 14 }), el('span', '', '刷新'));

  const notes = el('div', 'extensions-notes');
  const list = el('div', 'extensions-list');
  const known = knownSetupsSection();
  holder.append(notes, list, known.element);

  let data = null;
  let stale = false;
  let disposed = false;
  let loadToken = 0;
  let approvalToken = 0;
  let loadedGeneration = S.workspaceGeneration;
  let detailSeq = 0;
  const expanded = new Set(); // 展开了详情的扩展 id：搜索重绘后保持展开
  const detailIds = new Map(); // 扩展 id → 详情节点 id（Registry id 可能含路径字符，不直接拿来当 DOM id）
  const live = () => !disposed && isLive();

  /** 一键安装的 recheck 拿到新 Registry 后，清单也换成同一份新证据。 */
  function refreshRegistry(fresh) {
    if (!live() || !fresh || fresh.ok === false || !ownsWorkspace(loadedGeneration)) return;
    data = fresh;
    onCount((fresh.extensions || []).length);
    render();
  }

  function renderKnownSetups(registry) {
    for (const item of KNOWN_SETUPS) item.render(known.boxes.get(item.id), registry, { onRegistry: refreshRegistry });
  }

  async function loadApproval() {
    const generation = S.workspaceGeneration;
    const token = ++approvalToken;
    const report = await fetchApprovalCapability();
    if (!live() || !ownsWorkspace(generation) || token !== approvalToken) return;
    renderApprovalSetup(known.boxes.get('approval'), report);
  }

  function detailIdFor(item) {
    if (!detailIds.has(item.id)) detailIds.set(item.id, `extensionDetail-${++detailSeq}`);
    return detailIds.get(item.id);
  }

  /** 卡片展开后的完整事实：事实行、已确认能力全集、工具清单限制。
   *  简介与错误已经在卡片上（展开时简介不再截断），这里不重复写第二遍。 */
  function renderDetails(node, item) {
    const rows = el('div', 'ext-rows');
    for (const [label, value] of extensionFactRows(item)) rows.append(row(label, value));
    // 卡片上的错误标签只区分「发现异常 / 加载失败」；Registry 给的原始阶段名留在事实行里，不丢信息。
    if (item.state?.error?.phase) rows.append(row('错误阶段', item.state.error.phase));
    node.append(rows);
    node.append(el('div', 'ext-sec-head', '已确认的能力'));
    if (item.capabilities?.length) {
      for (const capability of item.capabilities) node.append(note(`${capability.type}: ${capability.displayName || capability.id}`, 'dim'));
    } else node.append(note('暂无可确认的能力。', 'dim'));
    node.append(note(TOOL_REGISTRY_NOTE, 'dim'));
  }

  function renderCard(item) {
    const error = item.state?.error || null;
    const name = extensionDisplayName(item);
    const card = el('article', 'ext-extension-item extensions-card' + (error ? ' is-error' : ''));
    card.setAttribute('role', 'listitem');
    card.dataset.extensionId = item.id;

    const head = el('div', 'extensions-card-head');
    const glyph = el('span', 'extensions-card-glyph');
    glyph.append(createIcon(error ? 'warning' : 'box', { size: 15 }));
    const heading = el('div', 'extensions-card-heading');
    const title = el('h4', 'ext-name', name);
    title.title = name;
    heading.append(title, el('div', 'extensions-card-meta', extensionCardMeta(item)));
    head.append(glyph, heading);
    card.append(head);

    const desc = el('p', 'extensions-card-desc', item.description || '（没有简介）');
    if (item.description) desc.title = item.description;
    card.append(desc);

    const capabilities = Array.isArray(item.capabilities) ? item.capabilities : [];
    const tags = extensionCardTags(item);
    if (tags.length || capabilities.length) {
      const tagBox = el('div', 'extensions-card-tags');
      for (const tag of tags) tagBox.append(createBadge(tag));
      for (const capability of capabilities.slice(0, CARD_CAPABILITY_LIMIT)) {
        const chip = el('span', 'extensions-cap', capability.displayName || capability.id);
        chip.title = `${capability.type}: ${capability.displayName || capability.id}`;
        tagBox.append(chip);
      }
      if (capabilities.length > CARD_CAPABILITY_LIMIT) {
        tagBox.append(el('span', 'extensions-cap is-more', `另有 ${capabilities.length - CARD_CAPABILITY_LIMIT} 项`));
      }
      card.append(tagBox);
    }
    if (error) card.append(el('p', 'extensions-card-error', `${extensionStateLabel(item)}：${error.message || '没有错误信息'}`));

    const open = expanded.has(item.id);
    card.classList.toggle('is-open', open);
    const foot = el('div', 'extensions-card-foot');
    const toggle = el('button', 'btn ghost tiny extensions-card-toggle');
    toggle.type = 'button';
    toggle.append(el('span', '', '详情'), createIcon('chevronDown', { size: 13, className: 'extensions-card-chevron' }));
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-controls', detailIdFor(item));
    toggle.setAttribute('aria-label', `${name} 详情`);
    foot.append(toggle);
    card.append(foot);

    const details = el('div', 'extensions-card-details');
    details.id = detailIdFor(item);
    details.hidden = !open;
    if (open) renderDetails(details, item);
    card.append(details);
    toggle.onclick = () => {
      const next = !expanded.has(item.id);
      if (next) expanded.add(item.id); else expanded.delete(item.id);
      if (next && !details.childElementCount) renderDetails(details, item);
      details.hidden = !next;
      card.classList.toggle('is-open', next);
      toggle.setAttribute('aria-expanded', String(next));
    };
    return card;
  }

  function render() {
    if (!live()) return;
    notes.replaceChildren();
    if (stale) {
      resultCount.textContent = '';
      list.replaceChildren(stateTile(STALE_TEXT, { icon: 'refresh', action: { label: '刷新', onClick: () => load() } }));
      return;
    }
    const all = data?.extensions || [];
    const query = searchInput.value;
    const items = filterExtensions(all, query);
    resultCount.textContent = query.trim() ? `找到 ${items.length} 个，共 ${all.length} 个` : '';
    if (!data?.piReachable) notes.append(note(PI_SILENT_NOTE, 'warn'));
    if (!S.hasProject) notes.append(note(NO_PROJECT_NOTE, 'dim'));
    if (!items.length) {
      list.replaceChildren(all.length ? stateTile(EMPTY_FILTERED, { icon: 'search' }) : stateTile(EMPTY_NONE));
      return;
    }
    list.replaceChildren(...groupExtensions(items).map((group) => {
      const section = el('section', 'extensions-group');
      section.dataset.group = group.id;
      const titleId = `extensionsGroup-${group.id}`;
      section.setAttribute('aria-labelledby', titleId);
      const grid = el('div', 'extensions-grid');
      grid.setAttribute('role', 'list');
      for (const item of group.items) grid.append(renderCard(item));
      section.append(groupHead(group.label, group.items.length, titleId), grid);
      return section;
    }));
  }

  async function load() {
    const token = ++loadToken;
    const generation = S.workspaceGeneration;
    refresh.disabled = true;
    list.replaceChildren(stateTile(SURFACE_COPY.loading('扩展'), { icon: 'refresh' }));
    const result = await fetchExtensions();
    if (!live() || token !== loadToken) return;
    refresh.disabled = false;
    if (!ownsWorkspace(generation)) { stale = true; render(); return; }
    stale = false;
    loadedGeneration = generation;
    if (!result || result.ok === false) {
      /* 失败态给真实存在的重试路径（就是本函数）。已知能力区仍可打开：
       * Registry 失败不代表安装状态可被猜成「未安装」，所以传 null。 */
      data = null;
      onCount(null);
      notes.replaceChildren();
      resultCount.textContent = '';
      list.replaceChildren(stateTile(SURFACE_COPY.failed('扩展'), {
        icon: 'warning', hint: '聊天与其它功能不受影响。', action: { label: SURFACE_COPY.retry, onClick: () => load() },
      }));
      renderKnownSetups(null);
      void loadApproval();
      return;
    }
    data = result;
    onCount((result.extensions || []).length);
    render();
    renderKnownSetups(result);
    void loadApproval();
  }

  /* 换项目后不自动重读（后端可能还在切换），先把清单换成提示，避免看着旧项目的数据。 */
  const onGeneration = () => {
    if (!live() || !data) return;
    stale = true;
    onCount(null);
    render();
  };
  searchInput.addEventListener('input', render);
  refresh.onclick = () => load();
  document.addEventListener('pi-gui:workspace-generation', onGeneration);
  void load();

  return {
    toolbar,
    actions: refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      loadToken += 1;
      approvalToken += 1;
      document.removeEventListener('pi-gui:workspace-generation', onGeneration);
    },
  };
}
