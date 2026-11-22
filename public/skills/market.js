/* 技能市场：目录（离线缓存）→ 搜索 / 分类 / 分页 → 预览全文 → 确认安装。
 *
 * 联网只发生在三种用户手势上：
 *   1.「加载目录 / 刷新」—— 读 GitHub / jsDelivr 的公开文件清单；
 *   2.「预览」—— 下载这个技能的全部文件并核对哈希；
 *   3.「安装」—— **不联网**，只把预览时已经核对过的字节写进技能目录。
 * 打开市场、搜索、翻页、切换分类都只读本机缓存（GET /api/skills/market）。
 *
 * 预览令牌是安装的唯一凭据；预览过期（15 分钟）后必须重新预览。
 * 同名的处理（不覆盖 / 保留两者 / 覆盖）由服务端给出精确的冲突对象，界面照实呈现。 */

import {
  fetchSkillMarket, fetchSkillMarketFile, installSkillMarketEntry, previewSkillMarketEntry,
  refreshSkillMarket, skillMarketSources,
} from '../api.js';
import { createIcon } from '../ui/icons.js';
import { confirmModal, confirmSurfaceMeta, dismissConfirm, openModal } from '../ui/modal.js';
import { createBadge, createSegmentedControl } from '../ui/primitives.js';
import { resourceEl as el, resourceNote as note } from '../ui/resource-dom.js';
import {
  filterMarketEntries, formatSkillBytes, marketCategoryLabel, marketEntryInstalled, marketPageCount,
  marketPageItems, marketPageWindow, marketSourceName, skillWritableTargets,
} from './model.js';

const CATEGORY_ICON = Object.freeze({
  workflow: 'task', writing: 'edit', coding: 'terminal', data: 'chart', docs: 'fileText',
});

function button(label, className, iconName) {
  const node = el('button', 'btn' + (className ? ' ' + className : ''));
  node.type = 'button';
  if (iconName) node.append(createIcon(iconName, { size: 14 }));
  node.append(el('span', '', label));
  return node;
}

function stateTile(text, { icon = 'market', hint = '', action = null } = {}) {
  const box = el('div', 'skills-empty');
  const chip = el('span', 'skills-empty-icon');
  chip.append(createIcon(icon, { size: 16 }));
  box.append(chip, el('div', 'skills-empty-title', text));
  if (hint) box.append(el('div', 'skills-empty-text', hint));
  if (action) {
    const node = button(action.label, 'tiny', action.icon || null);
    node.onclick = action.onClick;
    box.append(node);
  }
  return box;
}

function selectField(labelText, select) {
  const wrap = el('label', 'skills-field');
  const head = el('span', 'skills-field-head');
  head.append(el('span', 'skills-field-label', labelText));
  wrap.append(head, select);
  return wrap;
}

/**
 * @param options.project     项目上下文（?project=）
 * @param options.listData    当前列表数据（写入目标）
 * @param options.installedNames Set<string>，用来标「已安装」
 * @param options.onBack      返回「我的技能」
 * @param options.onInstalled 安装成功后的回调（含 undo / restartRequired / warnings）
 */
export function renderSkillsMarket(holder, {
  project = 'none', listData = null, installedNames = new Set(), isCurrent = () => true,
  onBack = () => {}, onInstalled = () => {},
} = {}) {
  let disposed = false;
  let closeDialog = null;
  const confirmOwner = {};
  const isActive = () => !disposed && isCurrent();
  let stateToken = 0;
  let busyToken = 0;
  let data = null;
  let loading = true;
  let error = '';
  let successText = '';
  let query = '';
  let category = '';
  let page = 1;
  let busyAll = false;
  let busyText = '';
  let previewId = '';
  const installed = new Set(installedNames);
  const targets = skillWritableTargets(listData);

  const root = el('section', 'skills-market');
  const back = el('button', 'btn ghost tiny skills-market-back');
  back.type = 'button';
  back.append(createIcon('chevronLeft', { size: 14 }), el('span', '', '我的技能'));
  back.onclick = () => onBack();
  const title = el('h2', 'skills-title settings-page-title skills-market-title', '技能市场');
  const headActions = el('div', 'skills-market-head-actions');
  const sourceButton = button('目录源', 'ghost', 'server');
  const sourceLabel = sourceButton.querySelector('span');
  const loadAll = button('加载目录', '', 'refresh');
  const search = el('label', 'skills-market-search ds-search-field ds-search-control');
  search.append(createIcon('search', { size: 14, className: 'skills-market-search-icon' }));
  const searchInput = el('input', 'skills-market-search-input');
  searchInput.type = 'search';
  searchInput.placeholder = '搜索技能';
  searchInput.setAttribute('aria-label', '搜索技能市场');
  search.append(searchInput);
  headActions.append(sourceButton, loadAll);
  const head = el('header', 'skills-market-head-top');
  head.append(title, headActions);
  root.append(back, head);

  const filters = el('div', 'skills-market-filter-slot');
  const toolbar = el('div', 'skills-market-toolbar');
  const resultCount = el('span', 'skills-market-count');
  resultCount.setAttribute('aria-live', 'polite');
  toolbar.append(search, resultCount);
  root.append(toolbar, filters);

  const notices = el('div', 'skills-market-notices');
  root.append(notices);
  const grid = el('div', 'skills-market-grid');
  grid.setAttribute('role', 'list');
  root.append(grid);
  const pagination = el('nav', 'skills-market-pagination');
  pagination.setAttribute('aria-label', '技能市场分页');
  root.append(pagination);
  holder.append(root);

  sourceButton.onclick = () => openSources();
  loadAll.onclick = () => {
    const sources = data?.sources || [];
    const allLoaded = sources.length > 0 && sources.every((source) => source.loaded && !source.error);
    void refreshAll(allLoaded);
  };
  searchInput.addEventListener('input', () => { query = searchInput.value; page = 1; renderGrid(); });

  /* ---------- 状态 ---------- */

  async function loadState(statusMessage = '') {
    const token = ++stateToken;
    if (!data) { loading = true; renderAll(); }
    busyText = statusMessage;
    renderNotices();
    const result = await fetchSkillMarket();
    if (!isActive() || token !== stateToken) return;
    loading = false;
    busyText = '';
    if (!result || result.ok === false) {
      error = (result && result.error) || '读取本机缓存失败';
      renderAll();
      return;
    }
    error = '';
    data = result;
    syncControls();
    renderAll();
  }

  function syncControls() {
    // 服务端的 MARKET_CATEGORIES 是固定目录。首次成功读取后装配，刷新不重建焦点目标。
    if (!filters.firstElementChild) {
      const control = createSegmentedControl({
        ariaLabel: '按分类筛选', value: category,
        options: [{ value: '', label: '全部' }, ...(data.categories || []).map(({ id, label }) => ({ value: id, label }))],
        onChange: (value) => { category = value; page = 1; renderGrid(); },
      });
      control.element.classList.add('skills-market-filters');
      filters.append(control.element);
    }
    const sources = data?.sources || [];
    sourceLabel.textContent = `目录源·${sources.length}`;
  }

  function renderAll() {
    if (disposed) return;
    loadAll.disabled = !data || busyAll || loading;
    loadAll.setAttribute('aria-busy', String(busyAll));
    const sources = data?.sources || [];
    const allLoaded = sources.length > 0 && sources.every((source) => source.loaded && !source.error);
    loadAll.querySelector('span').textContent = allLoaded ? '刷新目录' : '加载目录';
    renderNotices();
    renderGrid();
  }

  function renderNotices() {
    notices.replaceChildren();
    if (busyText) notices.append(note(busyText, 'dim'));
    if (successText) {
      const box = el('div', 'skills-market-banner is-success');
      box.append(el('span', 'skills-market-banner-text', successText));
      const dismiss = button('', 'ghost tiny', 'close');
      dismiss.setAttribute('aria-label', '关闭提示');
      dismiss.onclick = () => { successText = ''; renderNotices(); };
      box.append(dismiss);
      notices.append(box);
    }
    if (error && data) { // 首次读取失败已在网格空态提供原因和重试。
      const box = el('div', 'skills-market-banner is-error');
      box.append(el('span', 'skills-market-banner-text', error));
      const retry = button('重试', 'tiny ghost', 'refresh');
      retry.onclick = () => { void loadState(); };
      box.append(retry);
      notices.append(box);
    }
    if (!data) return;
    const unloaded = (data.sources || []).filter((source) => !source.loaded && !source.error);
    if (unloaded.length) {
      const box = el('div', 'skills-market-banner');
      box.append(el('span', 'skills-market-banner-text',
        `还有 ${unloaded.length} 个目录没有加载。加载会读取 GitHub / jsDelivr 上的公开文件清单；预览时才会下载技能文件。`));
      notices.append(box);
    }
    for (const source of data.sources || []) {
      if (!source.error) continue;
      const box = el('div', 'skills-market-banner is-error');
      box.append(el('span', 'skills-market-banner-text', `${marketSourceName(source)}：${source.error}`));
      const retry = button('重试', 'tiny ghost', 'refresh');
      retry.onclick = () => { void refreshSource(source, true); };
      box.append(retry);
      notices.append(box);
    }
  }

  function renderGrid() {
    if (disposed) return;
    grid.replaceChildren();
    pagination.replaceChildren();
    if (!data) {
      resultCount.textContent = '';
      grid.append(loading
        ? stateTile('正在读取本机缓存…', { icon: 'refresh' })
        : stateTile('读不到技能市场', { icon: 'warning', hint: error || '', action: { label: '重试', onClick: () => { void loadState(); } } }));
      return;
    }
    const entries = filterMarketEntries(data.entries || [], { query, category });
    resultCount.textContent = query.trim() || category
      ? `找到 ${entries.length} 个，共 ${(data.entries || []).length} 个`
      : `共 ${(data.entries || []).length} 个技能`;
    const pageSize = data.limits?.pageSize || 24;
    const pages = marketPageCount(entries.length, pageSize);
    page = Math.min(Math.max(1, page), pages);
    const items = marketPageItems(entries, page, pageSize);
    if (!items.length) {
      grid.append(stateTile(query.trim() || category ? '没有符合筛选条件的技能' : '目录里还没有技能', {
        icon: query.trim() ? 'search' : 'market',
      }));
      return;
    }
    for (const entry of items) grid.append(renderCard(entry));
    renderPagination(pages, entries.length);
  }

  function renderCard(entry) {
    const card = el('article', 'skills-market-card');
    card.setAttribute('role', 'listitem');
    card.dataset.entryId = entry.id;
    const glyph = el('span', 'skills-market-glyph');
    glyph.append(createIcon(CATEGORY_ICON[entry.categories?.[0]] || 'book', { size: 16 }));
    const main = el('div', 'skills-market-card-main');
    const titleRow = el('div', 'skills-market-card-title-row');
    const title = el('h3', 'skills-market-card-title', entry.title || entry.slug || entry.dir);
    title.title = entry.title || entry.slug || entry.dir;
    titleRow.append(title);
    if (entry.official) titleRow.append(createBadge({ text: '官方', tone: 'success' }));
    if (marketEntryInstalled(entry, installed)) titleRow.append(createBadge({ text: '已安装', tone: 'neutral' }));
    if (entry.listed === false) titleRow.append(createBadge({ text: '未加载清单', tone: 'neutral' }));
    for (const id of entry.categories || []) titleRow.append(el('span', 'skills-market-tag', marketCategoryLabel(data?.categories, id)));
    main.append(titleRow);
    if (entry.repo) main.append(el('span', 'skills-market-repo', entry.repo));
    if (entry.description) main.append(el('p', 'skills-market-card-desc', entry.description));
    const meta = el('div', 'skills-market-card-meta');
    if (Number.isFinite(entry.fileCount)) meta.append(el('span', '', `${entry.fileCount} 个文件`));
    if (Number.isFinite(entry.bytes)) meta.append(el('span', '', formatSkillBytes(entry.bytes)));
    if (entry.installable === false) meta.append(el('span', 'skills-market-blocked', entry.reason || '不可安装'));
    if (meta.childElementCount) main.append(meta);
    const actions = el('div', 'skills-market-card-actions');
    const isInstalled = marketEntryInstalled(entry, installed);
    const actionLabel = isInstalled || entry.installable === false ? '查看' : '安装';
    /* 卡片的动作一律是有底色的按钮：ghost 文字在窄窗里会和描述混在一起。 */
    const preview = button(actionLabel, actionLabel === '安装' ? 'primary tiny' : 'tiny', null);
    preview.disabled = previewId === entry.id;
    preview.setAttribute('aria-label', `${actionLabel} ${entry.title || entry.slug}`);
    preview.onclick = () => { void openPreview(entry, preview); };
    actions.append(preview);
    card.append(glyph, main, actions);
    return card;
  }

  function renderPagination(pages, total) {
    pagination.replaceChildren();
    if (pages <= 1) return;
    const prev = button('', 'ghost tiny skills-page-step', 'chevronLeft');
    prev.setAttribute('aria-label', '上一页');
    prev.disabled = page <= 1;
    prev.onclick = () => goPage(page - 1);
    pagination.append(prev);
    for (const item of marketPageWindow(page, pages, 1)) {
      if (item === '…') { pagination.append(el('span', 'skills-page-ellipsis', '…')); continue; }
      const node = el('button', 'btn tiny skills-page-number' + (item === page ? ' is-current' : ''), String(item));
      node.type = 'button';
      if (item === page) node.setAttribute('aria-current', 'page');
      node.setAttribute('aria-label', `第 ${item} 页`);
      node.onclick = () => goPage(item);
      pagination.append(node);
    }
    const next = button('', 'ghost tiny skills-page-step', 'chevronRight');
    next.setAttribute('aria-label', '下一页');
    next.disabled = page >= pages;
    next.onclick = () => goPage(page + 1);
    pagination.append(next);
    const jumpWrap = el('span', 'skills-page-jump-wrap');
    jumpWrap.append(el('span', 'skills-page-jump-label', `第 ${page} / ${pages} 页 · 共 ${total} 个`));
    const jump = el('input', 'ds-input skills-page-jump');
    jump.type = 'number';
    jump.min = '1';
    jump.max = String(pages);
    jump.value = String(page);
    jump.setAttribute('aria-label', '跳转到页码');
    jump.onchange = () => {
      const value = Number(jump.value);
      if (Number.isInteger(value) && value >= 1 && value <= pages) goPage(value);
      else jump.value = String(page);
    };
    jumpWrap.append(jump);
    pagination.append(jumpWrap);
  }

  function goPage(next) {
    page = next;
    renderGrid();
    pagination.querySelector('.skills-page-number[aria-current="page"]')?.focus();
  }

  /* ---------- 刷新目录（联网，用户手势） ---------- */

  async function refreshAll(force = false) {
    if (busyAll || !data) return;
    const sources = (data.sources || []).filter((source) => !source.loaded || source.error);
    const list = sources.length ? sources : (data.sources || []);
    const token = ++busyToken;
    busyAll = true;
    successText = '';
    renderAll();
    const failures = [];
    for (let index = 0; index < list.length; index += 1) {
      if (disposed || token !== busyToken) return;
      busyText = `正在加载目录 ${index + 1}/${list.length}：${marketSourceName(list[index])}…`;
      renderNotices();
      const result = await refreshSkillMarket({ sourceId: list[index].id, force });
      if (disposed || token !== busyToken) return;
      if (!result || result.ok === false) failures.push(`${marketSourceName(list[index])}：${(result && result.error) || '加载失败'}`);
    }
    if (disposed || token !== busyToken) return;
    busyAll = false;
    busyText = '';
    await loadState();
    if (failures.length) {
      error = failures.join('；');
      renderAll();
    }
  }

  async function refreshSource(source, force) {
    const token = ++busyToken;
    busyAll = true;
    busyText = `正在加载 ${marketSourceName(source)}…`;
    renderAll();
    const result = await refreshSkillMarket({ sourceId: source.id, force });
    if (disposed || token !== busyToken) return;
    busyAll = false;
    busyText = '';
    if (!result || result.ok === false) {
      error = `${marketSourceName(source)}：${(result && result.error) || '加载失败'}`;
      renderAll();
      return;
    }
    await loadState();
  }

  /* ---------- 目录源管理 ---------- */

  function openSources() {
    if (!data) return;
    let localToken = 0;
    let localBusy = false;
    let closed = false;
    openModal((card, close) => {
      closeDialog = close;
      card.classList.add('skills-dialog', 'skills-market-sources-dialog');
      card.setAttribute('aria-label', '技能市场目录源');
      const head = el('header', 'skills-dialog-head');
      const heading = el('div', 'skills-dialog-heading');
      const glyph = el('span', 'skills-dialog-glyph');
      glyph.append(createIcon('server', { size: 15 }));
      const titles = el('div', 'skills-dialog-titles');
      titles.append(el('h3', 'skills-dialog-title', '目录源'), el('p', 'skills-dialog-sub', '默认来源固定保留；你可以添加自己的公开 GitHub 仓库。'));
      heading.append(glyph, titles);
      head.append(heading);
      const body = el('div', 'skills-dialog-body');
      const footer = el('div', 'skills-dialog-foot');
      const list = el('div', 'skills-sources-list');
      const status = el('div', 'skills-dialog-status');
      status.setAttribute('aria-live', 'polite');
      if (data.hosts?.length) {
        body.append(note(`联网主机：${data.hosts.join('、')}`, 'dim'));
      }
      const addRow = el('div', 'skills-sources-add');
      const addInput = el('input', 'ds-input skills-input');
      addInput.type = 'text';
      addInput.placeholder = 'owner/repo 或 GitHub 网址';
      addInput.setAttribute('aria-label', '添加目录源');
      const addButton = button('添加', 'tiny primary', 'plus');
      addRow.append(addInput, addButton);
      body.append(list, addRow, status);
      const done = button('完成', 'ghost');
      done.onclick = () => close();
      footer.append(done);
      card.append(head, body, footer);

      function render() {
        list.replaceChildren();
        for (const source of data?.sources || []) {
          const row = el('div', 'skills-sources-row');
          const info = el('div', 'skills-sources-info');
          const nameLine = el('div', 'skills-sources-name');
          nameLine.append(el('span', '', marketSourceName(source)));
          if (source.builtin) nameLine.append(createBadge({ text: '默认', tone: 'neutral' }));
          info.append(nameLine);
          const state = el('div', 'skills-sources-meta');
          if (source.error) state.append(el('span', 'skills-sources-error', source.error));
          else if (source.loaded) state.append(el('span', '', `${source.count} 个技能 · ${source.mode === 'pinned' ? '固定提交' : '分支'} · ${source.resolvedRef.slice(0, 10)}`));
          else state.append(el('span', '', '未加载'));
          info.append(state);
          const actions = el('div', 'skills-sources-actions');
          const refresh = button('刷新', 'ghost tiny', 'refresh');
          refresh.disabled = localBusy;
          refresh.onclick = () => { void runRefresh(source, refresh); };
          actions.append(refresh);
          if (!source.builtin) {
            const removeButton = button('移除', 'danger ghost tiny', 'trash');
            removeButton.disabled = localBusy;
            removeButton.onclick = () => { void remove(source); };
            actions.append(removeButton);
          }
          row.append(info, actions);
          list.append(row);
        }
        if (!(data?.sources || []).length) list.append(note('还没有目录源。', 'dim'));
        addButton.disabled = localBusy || (data?.sources || []).length >= (data?.limits?.maxCustomSources || 20) + 7;
      }

      async function runRefresh(source, control) {
        if (localBusy) return;
        const token = ++localToken;
        localBusy = true;
        control.setAttribute('aria-busy', 'true');
        status.replaceChildren(note(`正在加载 ${marketSourceName(source)}…`, 'dim'));
        render();
        const result = await refreshSkillMarket({ sourceId: source.id, force: true });
        if (token !== localToken) return;
        localBusy = false;
        if (!result || result.ok === false) status.replaceChildren(note((result && result.error) || '加载失败', 'err'));
        else status.replaceChildren(note('已更新目录。', 'dim'));
        await loadState();
        render();
      }

      async function remove(source) {
        const ok = await confirmModal({
          title: '移除这个目录源？',
          message: `会从列表里移除 ${marketSourceName(source)}，并清掉它的本机缓存。技能本身不会被删除。`,
          okText: '移除',
          danger: true,
          meta: { owner: confirmOwner },
        });
        if (!ok || closed || !isActive()) return;
        const token = ++localToken;
        localBusy = true;
        render();
        const result = await skillMarketSources({ action: 'remove', id: source.id });
        if (token !== localToken) return;
        localBusy = false;
        if (!result || result.ok === false) status.replaceChildren(note((result && result.error) || '移除失败', 'err'));
        else status.replaceChildren(note('已移除。', 'dim'));
        await loadState();
        render();
      }

      addButton.onclick = async () => {
        const repo = addInput.value.trim();
        if (!repo || localBusy) return;
        const token = ++localToken;
        localBusy = true;
        addButton.setAttribute('aria-busy', 'true');
        status.replaceChildren();
        const result = await skillMarketSources({ action: 'add', repo });
        if (token !== localToken) return;
        localBusy = false;
        addButton.removeAttribute('aria-busy');
        if (!result || result.ok === false) {
          status.replaceChildren(note((result && result.error) || '添加失败', 'err'));
        } else {
          addInput.value = '';
          status.replaceChildren(note('已添加；点它的「刷新」加载清单。', 'dim'));
          await loadState();
        }
        render();
      };
      addInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); addButton.click(); }
      });

      render();
    }, () => {
      closed = true;
      localToken += 1;
      if (confirmSurfaceMeta()?.owner === confirmOwner) dismissConfirm();
      closeDialog = null;
    });
  }

  /* ---------- 预览与安装 ---------- */

  async function openPreview(entry, buttonNode) {
    if (previewId || !isActive()) return;
    previewId = entry.id;
    buttonNode.disabled = true;
    buttonNode.setAttribute('aria-busy', 'true');
    const result = await previewSkillMarketEntry({ entryId: entry.id });
    previewId = '';
    if (!isActive()) return;
    renderGrid();
    if (!result || result.ok === false) {
      error = `${entry.title || entry.slug}：${(result && result.error) || '预览失败'}`;
      renderAll();
      return;
    }
    if (error) { error = ''; renderAll(); }
    showPreview(entry, result);
  }

  function showPreview(entry, preview) {
    let disposedPreview = false;
    let fileToken = 0;
    let installToken = 0;
    let installing = false;
    let allowPartial = false;
    const previewTargets = skillWritableTargets(listData);
    let targetKey = previewTargets[0]?.key || '';
    let conflict = 'fail';
    const origin = preview.source || {};

    openModal((card, close) => {
      closeDialog = close;
      card.classList.add('skills-dialog', 'skills-preview-dialog');
      card.setAttribute('aria-label', '预览技能');

      const head = el('header', 'skills-dialog-head');
      const heading = el('div', 'skills-dialog-heading');
      const glyph = el('span', 'skills-dialog-glyph');
      glyph.append(createIcon(CATEGORY_ICON[preview.entry?.categories?.[0]] || 'book', { size: 15 }));
      const titles = el('div', 'skills-dialog-titles');
      const title = el('h3', 'skills-dialog-title', preview.entry?.title || preview.suggestedName || entry.title);
      const sub = el('p', 'skills-dialog-sub', `${origin.repo || entry.repo}${origin.dir ? ' · ' + origin.dir : ''}`);
      titles.append(title, sub);
      heading.append(glyph, titles);
      const badges = el('div', 'skills-preview-badges');
      if (preview.entry?.official) badges.append(createBadge({ text: '官方', tone: 'success' }));
      if (marketEntryInstalled(preview.entry || entry, installed)) badges.append(createBadge({ text: '已安装', tone: 'neutral' }));
      if (preview.installable === false) badges.append(createBadge({ text: '不可安装', tone: 'warning' }));
      if (preview.partial) badges.append(createBadge({ text: '部分文件缺失', tone: 'warning' }));
      head.append(heading, badges);
      card.append(head);

      const body = el('div', 'skills-dialog-body skills-preview-body');
      const contentPane = el('div', 'skills-preview-content');
      const fileBar = el('div', 'skills-preview-files');
      const pre = el('pre', 'ext-code skills-preview-pre', preview.content || '（SKILL.md 是空的）');
      contentPane.append(fileBar, pre);
      const side = el('aside', 'skills-preview-side');
      const desc = el('p', 'skills-preview-desc', preview.description || preview.entry?.description || '（没有描述）');
      side.append(desc);

      const facts = el('div', 'ext-rows');
      const fact = (key, value) => {
        if (!value) return;
        const row = el('div', 'ext-row');
        const v = el('span', 'ext-row-v', value);
        v.title = String(value);
        row.append(el('span', 'ext-row-k', key), v);
        facts.append(row);
      };
      fact('来源', origin.repo || entry.repo);
      fact('目录', origin.dir || entry.dir);
      fact('版本', origin.mode === 'pinned' ? `提交 ${String(origin.ref || '').slice(0, 10)}` : `分支 ${origin.ref || ''}`);
      fact('大小', formatSkillBytes(preview.totalBytes));
      fact('文件', `${(preview.files || []).filter((file) => file.status === 'ok').length} / ${(preview.files || []).length}`);
      side.append(facts);

      const fileList = el('div', 'skills-preview-file-list');
      fileList.append(el('div', 'skills-preview-side-title', '文件'));
      for (const file of preview.files || []) {
        const node = el('button', 'skills-preview-file' + (file.status === 'ok' ? '' : ' is-missing'));
        node.type = 'button';
        node.append(el('span', 'skills-preview-file-path', file.path));
        node.append(el('span', 'skills-preview-file-note', file.status === 'ok' ? formatSkillBytes(file.size) : '缺失'));
        if (file.status === 'ok') node.onclick = () => { void showFile(file.path, node); };
        else node.disabled = true;
        fileList.append(node);
      }
      side.append(fileList);

      const notes = el('div', 'skills-preview-notes');
      for (const problem of preview.problems || []) notes.append(note(problem.message, problem.level === 'error' ? 'err' : 'warn'));
      if (preview.partial) notes.append(note(`有 ${(preview.files || []).filter((file) => file.status !== 'ok').length} 个文件没有取到；安装的是不完整的技能。`, 'warn'));
      if (preview.installable === false) notes.append(note(preview.reason || '这个条目不符合安装限制。', 'err'));
      side.append(notes);

      /* 安装区 */
      const installBox = el('div', 'skills-preview-install');
      installBox.append(el('div', 'skills-preview-side-title', '安装'));
      const targetSelect = el('select', 'ds-select skills-select');
      targetSelect.setAttribute('aria-label', '安装到');
      for (const target of previewTargets) {
        const option = el('option', '', `${target.scope === 'project' ? '项目' : '全局'} · ${target.label}`);
        option.value = target.key;
        targetSelect.append(option);
      }
      if (!previewTargets.length) {
        const option = el('option', '', '没有可写的位置');
        option.value = '';
        targetSelect.append(option);
      }
      targetSelect.value = targetKey;
      targetSelect.onchange = () => { targetKey = targetSelect.value; };
      installBox.append(selectField('安装到', targetSelect));
      const nameInput = el('input', 'ds-input skills-input');
      nameInput.type = 'text';
      nameInput.value = preview.suggestedName || preview.entry?.slug || '';
      nameInput.spellcheck = false;
      nameInput.setAttribute('aria-label', '安装后的名称');
      installBox.append(selectField('名称', nameInput));
      const conflictSelect = el('select', 'ds-select skills-select');
      conflictSelect.setAttribute('aria-label', '同名技能怎么处理');
      for (const [value, label] of [['fail', '不覆盖，提示我'], ['rename', '保留两者（自动改名）'], ['replace', '覆盖已有的']]) {
        const option = el('option', '', label);
        option.value = value;
        conflictSelect.append(option);
      }
      conflictSelect.onchange = () => { conflict = conflictSelect.value; };
      installBox.append(selectField('同名时', conflictSelect));
      let partialCheck = null;
      if (preview.partial) {
        const label = el('label', 'skills-checkbox-row');
        partialCheck = el('input', 'skills-checkbox');
        partialCheck.type = 'checkbox';
        partialCheck.onchange = () => { allowPartial = partialCheck.checked; };
        label.append(partialCheck, el('span', '', '仍然安装不完整的技能'));
        installBox.append(label);
      }
      const installButton = button('安装', 'primary', 'arrowDown');
      installButton.disabled = preview.installable === false || !previewTargets.length;
      installBox.append(installButton);
      installBox.append(note('安装不会再联网：写入的就是刚刚核对过的这些字节。', 'dim'));
      side.append(installBox);

      const installError = el('div', 'skills-preview-install-error');
      installError.setAttribute('aria-live', 'polite');
      side.append(installError);

      body.append(contentPane, side);
      card.append(body);
      const footer = el('div', 'skills-dialog-foot');
      const closeButton = button('关闭', 'ghost');
      closeButton.onclick = () => close();
      footer.append(closeButton);
      card.append(footer);

      async function showFile(path, node) {
        const token = ++fileToken;
        node.setAttribute('aria-busy', 'true');
        const result = await fetchSkillMarketFile(preview.previewId, path);
        if (!isActive() || disposedPreview || token !== fileToken) return;
        node.removeAttribute('aria-busy');
        if (!result || result.ok === false) {
          pre.textContent = (result && result.error) || '读不到这个文件';
          return;
        }
        pre.textContent = result.binary
          ? `（二进制文件，${formatSkillBytes(result.size)}，不能在这里预览）`
          : (result.text || '（空文件）') + (result.truncated ? '\n\n…（预览已截断）' : '');
        for (const item of fileList.querySelectorAll('button')) item.classList.toggle('is-current', item === node);
      }

      installButton.onclick = async () => {
        if (installing || disposedPreview || !isActive()) return;
        const name = nameInput.value.trim();
        if (!name) { installError.replaceChildren(note('请填写名称', 'err')); nameInput.focus(); return; }
        if (!targetKey) { installError.replaceChildren(note('没有可写的位置', 'err')); return; }
        const token = ++installToken;
        installing = true;
        installButton.setAttribute('aria-busy', 'true');
        installButton.disabled = true;
        installError.replaceChildren(note('正在安装…', 'dim'));
        const result = await installSkillMarketEntry(project, {
          previewId: preview.previewId, target: targetKey, name, onConflict: conflict, allowPartial,
        });
        if (!isActive() || disposedPreview || token !== installToken) return;
        installing = false;
        installButton.removeAttribute('aria-busy');
        installButton.disabled = preview.installable === false || !previewTargets.length;
        if (result && result.ok === true) {
          installed.add(String(result.name || name).toLowerCase());
          successText = result.notice || `已安装 ${result.name || name}。`;
          error = '';
          renderNotices();
          renderGrid();
          onInstalled(result);
          close();
          return;
        }
        if (result && result.code === 'exists' && result.conflict) {
          renderConflict(result);
          return;
        }
        if (result && result.code === 'partial') {
          installError.replaceChildren(note(result.error || '有文件没有取到', 'warn'));
          if (partialCheck) { partialCheck.checked = true; allowPartial = true; partialCheck.focus(); }
          return;
        }
        if (result && result.code === 'preview-expired') {
          installError.replaceChildren(note(`${result.error || '预览已过期'}。关闭后重新点「预览」。`, 'err'));
          installButton.disabled = true;
          return;
        }
        installError.replaceChildren(note((result && result.error) || '安装失败', 'err'));
      };

      function renderConflict(result) {
        const info = result.conflict || {};
        installError.replaceChildren();
        installError.append(note(result.error || '目标目录里已经有同名技能。', 'warn'));
        const row = el('div', 'skills-preview-conflict-actions');
        if (info.suggestion) {
          const keep = button(`保留两者（${info.suggestion}）`, 'tiny');
          keep.onclick = () => { conflictSelect.value = 'rename'; conflict = 'rename'; installButton.click(); };
          row.append(keep);
        }
        if (info.replaceable === true) {
          const replace = button('覆盖已有的', 'tiny danger');
          replace.onclick = () => { conflictSelect.value = 'replace'; conflict = 'replace'; installButton.click(); };
          row.append(replace);
        }
        const rename = button('换个名字', 'tiny ghost');
        rename.onclick = () => { nameInput.focus(); nameInput.select(); };
        row.append(rename);
        installError.append(row);
      }

      return;
    }, () => {
      closeDialog = null;
      disposedPreview = true;
      fileToken += 1;
      installToken += 1;
    });
  }

  /* ---------- 生命周期 ---------- */

  if (data === null) void loadState();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      closeDialog?.();
      stateToken += 1;
      busyToken += 1;
      previewId = '';
    },
  };
}
