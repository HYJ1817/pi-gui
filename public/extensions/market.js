/* 插件市场：只从受控目录读取，以本机包清单决定操作。 */
import { S, ownsWorkspace } from '../state.js';
import { extensionMarketAction, fetchExtensionMarket } from '../api.js';
import { openActionMenu } from '../ui/action-menu.js';
import { confirmModal, confirmSurfaceMeta, dismissConfirm } from '../ui/modal.js';
import { createBadge } from '../ui/primitives.js';
import { resourceEl as el } from '../ui/resource-dom.js';
import {
  extensionActionButton, extensionGlyph, extensionMoreButton, extensionOutcomeBox,
  extensionSearchField, extensionStateTile, extensionSyncActionButton,
} from './parts.js';
import { extensionMarketCardState, extensionMarketCountText, extensionMarketMeta, extensionMarketNotes } from './market-model.js';
import { openExtensionPackageDetail } from './package-detail.js';

const PAGE_SIZE = 24;

export function renderExtensionMarket(holder, { isLive, operations, onCount = () => {} }) {
  const { field: toolbar, input } = extensionSearchField({ placeholder: '搜索插件', label: '搜索插件市场' });
  toolbar.classList.add('is-rounded');
  const actions = el('div', 'extensions-head-buttons');
  /* 刷新是弱操作（设计系统把「刷新」列在 Ghost 下）；卡片里的安装 / 更新才是本页的 Primary。 */
  const refresh = extensionActionButton('btn ghost extensions-refresh', '刷新插件市场', 'refresh');
  const more = extensionMoreButton('插件市场选项');
  actions.append(refresh, more);

  const notices = el('div', 'extensions-notes');
  const filters = el('div', 'extensions-market-filters');
  const categories = el('div', 'ds-filter-chips extensions-categories');
  categories.setAttribute('role', 'group');
  categories.setAttribute('aria-label', '插件分类');
  const sorts = el('div', 'ds-segmented is-rounded extensions-sorts');
  sorts.setAttribute('role', 'group');
  sorts.setAttribute('aria-label', '插件排序');
  filters.append(categories, sorts);
  const results = el('div', 'extensions-market-result');
  results.setAttribute('aria-live', 'polite');
  const grid = el('div', 'extensions-market-grid');
  const pager = el('div', 'extensions-pager');
  const next = extensionActionButton('btn', '加载更多');
  const deep = extensionActionButton('btn ghost', '在 npm 搜索更多', 'search');
  pager.append(next, deep);
  holder.append(notices, filters, results, grid, pager);

  let disposed = false;
  let generation = S.workspaceGeneration;
  let request = 0;
  let timer = null;
  let snapshotTimer = null;
  let detail = null;
  let response = null;
  let items = [];
  let category = 'all';
  let sort = 'recommended';
  let loading = false;
  let resultsQuery = null;
  let changing = false;
  let error = '';
  let stale = false;
  const consentOwner = {};
  const current = () => !disposed && isLive();
  const live = () => current() && ownsWorkspace(generation);

  function dismissConsent() {
    if (confirmSurfaceMeta()?.owner === consentOwner) dismissConfirm();
  }

  function showDetail(item, trigger) {
    const fromAction = trigger.classList.contains('extensions-market-card-action');
    detail = openExtensionPackageDetail(item, {
      operations, isLive: live,
      onClose() {
        detail = null;
        render();
        queueMicrotask(() => {
          if (!live() || !holder.isConnected || document.activeElement !== document.body) return;
          const card = [...grid.children].find((node) => node.dataset.marketId === item.id);
          const action = fromAction && card?.querySelector('.extensions-market-card-action:not(:disabled)');
          (action || card?.querySelector('.extensions-card-hit') || input).focus();
        });
      },
    });
  }

  function cardFor(item) {
    const card = el('article', 'extensions-card extensions-market-card');
    card.dataset.marketId = item.id;
    const main = el('div', 'extensions-market-card-body');
    const view = el('button', 'extensions-card-hit');
    view.type = 'button';
    view.setAttribute('aria-label', `${item.name} 详情`);
    view.onclick = () => showDetail(item, view);
    const head = el('div', 'extensions-card-head');
    const heading = el('div', 'extensions-card-heading');
    const title = el('h4', 'ext-name', item.name);
    title.title = item.name;
    const meta = el('span', 'extensions-card-meta', extensionMarketMeta(item));
    meta.title = meta.textContent;
    heading.append(title, meta);
    head.append(extensionGlyph(item.name), heading);
    main.append(head);
    if (item.description) main.append(el('p', 'extensions-card-desc', item.description));
    if (item.tags?.length || item.flagged) {
      const tags = el('span', 'extensions-card-tags extensions-market-tags');
      // npm 关键词不是声明式权限；只有注册表明确给出的警告才用警示色。
      if (item.flagged) tags.append(createBadge({ text: 'npm 安全警告', tone: 'warning' }));
      for (const tag of item.tags || []) tags.append(createBadge({ text: tag, tone: 'neutral' }));
      main.append(tags);
    }
    // Keep the heading, description and npm facts readable outside the named button. Its hit area covers only the body.
    main.append(view);
    const foot = el('div', 'extensions-market-card-foot');
    const state = extensionMarketCardState(item);
    const isAction = state.kind === 'install' || state.kind === 'update';
    if (isAction) {
      if (state.kind === 'update' && item.installed.version) {
        foot.append(el('span', 'extensions-card-meta', `已安装 v${item.installed.version}`));
      }
      const action = extensionActionButton('btn primary extensions-market-card-action', state.label);
      action.setAttribute('aria-label', `${state.label} ${item.name}`);
      action.onclick = () => showDetail(item, action);
      const id = state.kind === 'install' ? item.id : item.installed.packageId;
      extensionSyncActionButton(action, operations.busyFor(id, response?.operations?.running), state.kind, {
        label: state.label, disabled: stale || S.switching,
      });
      foot.append(action);
    } else {
      const label = state.kind === 'blocked' && state.label === '安装' ? '安装不可用' : state.label;
      const badge = el('span', 'extensions-card-meta', label);
      badge.title = state.reason;
      foot.append(badge);
    }
    card.append(main, foot);
    return card;
  }

  function inlineNote(text, action, label = '重试') {
    const line = el('div', 'extensions-inline-note');
    line.append(el('span', '', text));
    if (action) {
      const button = extensionActionButton('btn tiny', label);
      button.disabled = changing;
      button.onclick = action;
      line.append(button);
    }
    return line;
  }

  function renderFilters() {
    filters.hidden = !response;
    const focus = document.activeElement;
    const focused = filters.contains(focus) ? focus.dataset.filter : null;
    const buttons = (values, value, onChange, reset = null) => values.map((option) => {
      const button = el('button', 'ds-segment-item', option.label);
      button.type = 'button';
      button.dataset.filter = option.id;
      button.disabled = option.available === false;
      button.setAttribute('aria-pressed', String(option.id === value));
      button.classList.toggle('is-active', option.id === value);
      if (option.id !== 'all' && Number.isInteger(option.count)) button.append(el('span', 'ds-segment-count', String(option.count)));
      button.onclick = () => {
        if (option.id !== value) onChange(option.id);
        else if (reset !== null && reset !== value) onChange(reset);
      };
      return button;
    });
    categories.replaceChildren(...buttons(response?.categories || [], category, (value) => {
      category = value;
      void load();
    }, 'all'));
    sorts.replaceChildren(...buttons(response?.sorts || [], sort, (value) => {
      sort = value;
      void load();
    }));
    if (focused) [...filters.querySelectorAll('button')].find((button) => button.dataset.filter === focused)?.focus();
  }

  function render() {
    if (!current()) return;
    refresh.disabled = changing || loading;
    more.disabled = changing || !response;
    notices.replaceChildren();
    const receipt = operations.receipt();
    if (receipt && !detail) notices.append(extensionOutcomeBox(receipt.outcome, { name: receipt.name, onDismiss: operations.dismiss }));
    if (response?.consent?.remote === false) {
      notices.append(inlineNote('正在浏览内置目录。启用在线目录可发现更多 Pi 包。', () => changeRemote('consent'), '启用在线目录'));
    }
    for (const note of extensionMarketNotes(response)) notices.append(inlineNote(note.text, note.retry ? () => changeRemote('refresh') : null));
    if (error) notices.append(inlineNote(error, () => load()));
    if (response?.deep?.state === 'failed') {
      notices.append(inlineNote('在线搜索失败，仍可浏览现有目录。', () => load({ deepSearch: true })));
    }
    renderFilters();
    results.textContent = stale ? '' : extensionMarketCountText(response);
    pager.hidden = stale || !response;
    next.hidden = response?.nextOffset == null || resultsQuery !== queryKey();
    next.disabled = loading || changing;
    deep.hidden = response?.consent?.remote !== true || input.value.trim().length < 2;
    deep.disabled = loading || changing;
    grid.setAttribute('aria-busy', String(loading || changing));
    if (stale || !items.length) {
      const message = stale ? '项目已切换，刷新后查看当前项目的扩展。'
        : changing || loading ? '正在读取插件市场…'
          : error ? '无法读取插件市场' : '没有符合条件的插件';
      const canClear = !stale && !loading && !changing && !error && (input.value.trim() || category !== 'all');
      grid.replaceChildren(extensionStateTile(message, {
        icon: stale ? 'refresh' : 'search',
        actions: stale ? [{ label: '刷新', onClick: () => load() }] : canClear ? [{
          label: '清除筛选', onClick() { input.value = ''; category = 'all'; input.focus(); void load(); },
        }] : [],
      }));
    } else {
      const focused = grid.contains(document.activeElement) ? document.activeElement : null;
      const focusedId = focused?.closest('[data-market-id]')?.dataset.marketId;
      const useAction = focused?.classList.contains('btn');
      grid.replaceChildren(...items.map(cardFor));
      if (focusedId) {
        const card = [...grid.children].find((node) => node.dataset.marketId === focusedId);
        (card?.querySelector(useAction ? '.btn:not([disabled])' : '.extensions-card-hit') || card?.querySelector('.extensions-card-hit'))?.focus();
      }
    }
  }

  const queryKey = () => JSON.stringify([input.value.trim(), category, sort]);

  async function load({ append = false, deepSearch = false } = {}) {
    if (!current()) return;
    if (S.switching) { invalidate(); return; }
    if (append && (loading || resultsQuery !== queryKey() || response?.nextOffset == null)) return;
    clearTimeout(timer);
    clearTimeout(snapshotTimer);
    const token = ++request;
    generation = S.workspaceGeneration;
    stale = false;
    loading = true;
    error = '';
    const offset = append ? response?.nextOffset || 0 : 0;
    if (resultsQuery !== queryKey()) items = [];
    render();
    const result = await fetchExtensionMarket({ q: input.value.trim(), category, sort, limit: PAGE_SIZE, offset, ...(deepSearch ? { deep: 1 } : {}) });
    if (!live() || token !== request) return;
    loading = false;
    if (result?.ok === true) {
      if (append && response.snapshot?.at !== result.snapshot?.at) return load();
      response = result;
      sort = result.query.sort;
      resultsQuery = queryKey();
      const old = append ? items : [];
      const combined = new Map(old.map((item) => [item.id, item]));
      for (const item of result.items) combined.set(item.id, item);
      items = [...combined.values()];
      onCount(result.catalogTotal);
      if ((result.snapshot?.refreshing || result.operations?.running) && holder.isConnected) {
        snapshotTimer = setTimeout(() => { if (holder.isConnected) void load(); }, 1800);
      }
    } else {
      error = '插件市场读取失败。';
      items = [];
      resultsQuery = null;
    }
    render();
  }

  async function changeRemote(action) {
    if (!live() || changing || S.switching) return;
    const owner = generation;
    if (action === 'consent' || action === 'revoke') {
      const consent = action === 'consent';
      const confirmed = await confirmModal({
        title: consent ? '启用在线目录？' : '关闭在线目录？',
        message: consent
          ? 'Pi GUI 将通过网络设置访问 registry.npmjs.org。仅在点「在 npm 搜索更多」时发送搜索词。'
          : '将清除缓存的在线目录。已安装的扩展仍可管理。',
        okText: consent ? '启用' : '关闭在线目录',
        meta: { owner: consentOwner },
      });
      if (confirmed !== true || !live() || !ownsWorkspace(owner) || S.switching) return;
    }
    changing = true;
    render();
    const result = await extensionMarketAction(action);
    if (!live() || !ownsWorkspace(owner)) return;
    if (action === 'revoke' && result?.consent?.remote === false) {
      response = null;
      items = [];
      category = 'all';
      sort = 'recommended';
      onCount(null);
    }
    changing = false;
    await load();
    if (!live() || !ownsWorkspace(owner)) return;
    if (result?.ok !== true && !response?.snapshot?.error) {
      error = result?.network ? '目录操作连接失败，请重试。' : result?.error || '目录操作失败，请重试。';
      render();
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    clearTimeout(snapshotTimer);
    ++request;
    next.disabled = true;
    deep.disabled = true;
    timer = setTimeout(() => void load(), 180);
  });
  refresh.onclick = () => response?.consent?.remote ? changeRemote('refresh') : load();
  more.onclick = () => openActionMenu(more, [{
    label: response?.consent?.remote ? '关闭在线目录' : '启用在线目录',
    onClick: () => changeRemote(response?.consent?.remote ? 'revoke' : 'consent'),
  }]);
  next.onclick = () => load({ append: true });
  deep.onclick = () => load({ deepSearch: true });
  function invalidate() {
    ++request;
    clearTimeout(timer);
    clearTimeout(snapshotTimer);
    dismissConsent();
    detail?.close();
    detail = null;
    response = null;
    items = [];
    resultsQuery = null;
    loading = false;
    changing = false;
    stale = true;
    error = '';
    onCount(null);
    render();
  }
  void load();

  return {
    toolbar, actions,
    activate() {
      if ((response?.snapshot?.refreshing || response?.operations?.running) && !loading) void load();
    },
    deactivate: dismissConsent,
    sync: () => { render(); detail?.sync(); },
    reload: () => Promise.all([load(), detail?.refresh()]),
    invalidate,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(snapshotTimer);
      dismissConsent();
      detail?.close();
    },
  };
}
