/* 扩展 › 已安装：Pi 原生 Extension Registry 的只读清单 + 已知能力设置。
 *
 * - 清单来自 `/api/extensions`（只读 Registry，包括完全不认识的扩展，保持可浏览可诊断）。
 *   本面板不安装、不启用、不执行任何扩展；Registry 的 actions 由服务端声明。
 * - 「已知能力设置」沿用 Web Access / Subagents / Pi Memory / Browser Use 的 setup 投影
 *   （一键安装走 ui/capability-setup.js 的白名单实现）和 Approval 协议探测。
 *   setup 安装后的 recheck 会交回新的 Registry，左栏随之换成同一份新证据。
 * - 所有异步结果都经过 `isLive()`（页面实例仍是当前）+ 工作区代号 + 本面板的请求序号三重校验。 */

import { S, ownsWorkspace } from '../state.js';
import { fetchExtensions, fetchApprovalCapability } from '../api.js';
import { SURFACE_COPY } from '../status-copy.js';
import { createIcon } from '../ui/icons.js';
import { resourceEl as el, resourceRow as row, resourceNote as note } from '../ui/resource-dom.js';
import { renderWebSetup } from '../web-access.js';
import { renderSubagentSetup } from '../subagents.js';
import { renderMemorySetup } from '../memory.js';
import { renderBrowserSetup } from '../browser.js';
import { renderApprovalSetup } from '../approval.js';
import {
  extensionDisplayName, extensionFactRows, extensionItemSummary, extensionStateLabel, filterExtensions,
} from './model.js';

const KNOWN_SETUPS = Object.freeze([
  Object.freeze({ id: 'web', label: 'Web Access', render: renderWebSetup }),
  Object.freeze({ id: 'subagents', label: 'Subagents', render: renderSubagentSetup }),
  Object.freeze({ id: 'memory', label: 'Pi Memory', render: renderMemorySetup }),
  Object.freeze({ id: 'browser', label: 'Browser Use', render: renderBrowserSetup }),
]);
const STALE_TEXT = '项目已切换，刷新后查看当前项目的扩展。';
const NO_PROJECT_NOTE = '还没有选择项目 —— 现在只能看到全局扩展与 pi 自带的能力。选一个文件夹后项目级的才会出现。';

function knownSetupsSection() {
  const known = el('details', 'ext-known');
  known.append(el('summary', 'ext-known-summary', '已知能力设置（安装 / 运行观察）'));
  const body = el('div', 'ext-known-body');
  body.append(note('Web Access / Subagents / Pi Memory / Browser Use 的安装与运行观察；Approval 是 Pi 的协议能力，没有安装命令。', 'dim'));
  known.append(body);
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
 * @returns {{ dispose(): void }}
 */
export function renderInstalledExtensions(holder, { isLive, onCount = () => {} }) {
  const known = knownSetupsSection();
  const toolbar = el('div', 'extensions-toolbar');
  const search = el('label', 'extensions-search ds-search-field ds-search-control');
  search.append(createIcon('search', { size: 14, className: 'extensions-search-icon' }));
  const searchInput = el('input', 'extensions-search-input');
  searchInput.type = 'search';
  searchInput.placeholder = '搜索名称 / 简介 / 状态…';
  searchInput.setAttribute('aria-label', '搜索已安装的扩展');
  search.append(searchInput);
  const refresh = el('button', 'btn ghost extensions-refresh');
  refresh.type = 'button';
  refresh.append(createIcon('refresh', { size: 14 }), el('span', '', '刷新'));
  toolbar.append(search, refresh);
  const summary = el('div', 'ext-summary');
  const split = el('div', 'ext-split');
  const list = el('div', 'ext-list');
  const detail = el('div', 'ext-detail');
  split.append(list, detail);
  holder.append(known.element, toolbar, summary, split);

  let data = null;
  let selected = null;
  let stale = false;
  let disposed = false;
  let loadToken = 0;
  let approvalToken = 0;
  let loadedGeneration = S.workspaceGeneration;
  const live = () => !disposed && isLive();

  /** 一键安装的 recheck 拿到新 Registry 后，左栏也换成同一份新证据。 */
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

  function showDetail(item) {
    detail.replaceChildren();
    if (!item) { detail.append(el('div', 'ext-empty', '选择一个 Extension 查看详情。')); return; }
    detail.append(el('h4', '', extensionDisplayName(item)));
    const rows = el('div', 'ext-rows');
    for (const [label, value] of extensionFactRows(item)) rows.append(row(label, value));
    detail.append(rows);
    if (item.description) detail.append(note(item.description, 'dim'));
    detail.append(el('div', 'ext-sec-head', '已确认的能力'));
    if (item.capabilities?.length) {
      for (const capability of item.capabilities) detail.append(note(`${capability.type}: ${capability.displayName || capability.id}`, 'dim'));
    } else detail.append(note('暂无可确认的能力。', 'dim'));
    detail.append(note('Pi RPC 未提供已注册工具列表；工具来源未知时，聊天时间线仍按原始名称显示。', 'dim'));
    if (item.state?.error) detail.append(note(`${item.state.error.phase}: ${item.state.error.message}`, 'warn'));
  }

  function emptyWithAction(text, actionLabel) {
    const box = el('div', 'ext-empty', text);
    const retry = el('button', 'btn tiny', actionLabel);
    retry.type = 'button';
    retry.onclick = () => load();
    box.append(retry);
    return box;
  }

  function render() {
    if (!live()) return;
    if (stale) {
      summary.replaceChildren();
      list.replaceChildren(emptyWithAction(STALE_TEXT, '刷新'));
      detail.replaceChildren();
      return;
    }
    const all = data?.extensions || [];
    const items = filterExtensions(all, searchInput.value);
    summary.replaceChildren(el('span', 'ext-sum-label',
      `发现 ${all.length} 个 Extension${items.length !== all.length ? ` · 当前筛选 ${items.length}` : ''} · 加载状态仅在 Pi 提供证据时确认`));
    if (!data?.piReachable) summary.append(note('Pi 未应答；无法确认实际加载状态。', 'warn'));
    if (!S.hasProject) summary.append(note(NO_PROJECT_NOTE, 'dim'));
    list.replaceChildren();
    if (!items.length) list.append(el('div', 'ext-empty', all.length ? '没有符合筛选条件的 Extension' : '没有发现可只读定位的 Extension。'));
    for (const item of items) {
      const button = el('button', 'ext-item ext-extension-item');
      button.type = 'button';
      const isSelected = selected === item.id;
      button.classList.toggle('on', isSelected);
      button.setAttribute('aria-current', String(isSelected));
      button.append(el('span', 'ext-name', extensionDisplayName(item)), el('span', 'ext-badge', extensionStateLabel(item)),
        el('div', 'ext-item-desc', extensionItemSummary(item)));
      button.onclick = () => { selected = item.id; render(); };
      list.append(button);
    }
    showDetail(items.find((item) => item.id === selected) || all.find((item) => item.id === selected) || null);
  }

  async function load() {
    const token = ++loadToken;
    const generation = S.workspaceGeneration;
    refresh.disabled = true;
    list.replaceChildren(el('div', 'ext-empty', SURFACE_COPY.loading('Extensions')));
    const result = await fetchExtensions();
    if (!live() || token !== loadToken) return;
    refresh.disabled = false;
    if (!ownsWorkspace(generation)) { stale = true; render(); return; }
    stale = false;
    loadedGeneration = generation;
    if (!result || result.ok === false) {
      /* 失败态给真实存在的重试路径（就是本函数）。设置区仍可打开：
       * Registry 失败不代表安装状态可被猜成「未安装」，所以传 null。 */
      data = null;
      onCount(null);
      const box = el('div', 'ext-empty');
      box.append(el('div', '', SURFACE_COPY.failed('Extensions')), el('div', 'cfg-note dim', '聊天与其它功能不受影响。'));
      const retry = el('button', 'btn tiny', SURFACE_COPY.retry);
      retry.type = 'button';
      retry.onclick = () => load();
      box.append(retry);
      summary.replaceChildren();
      list.replaceChildren(box);
      detail.replaceChildren();
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
    dispose() {
      if (disposed) return;
      disposed = true;
      loadToken += 1;
      approvalToken += 1;
      document.removeEventListener('pi-gui:workspace-generation', onGeneration);
    },
  };
}
