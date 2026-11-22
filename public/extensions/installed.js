/* 扩展清单：包配置和磁盘事实来自清单，加载证据来自只读 Registry。 */
import { S, ownsWorkspace } from '../state.js';
import { fetchExtensions, fetchExtensionPackages, fetchApprovalCapability } from '../api.js';
import { openActionMenu } from '../ui/action-menu.js';
import { restartPi } from '../providers.js';
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
  buildExtensionUnits, extensionUnitChips, extensionUnitDescription, extensionUnitErrorText,
  extensionUnitFactRows, extensionUnitMeta, extensionUnitName, extensionUnitTags, filterExtensionUnits, groupExtensionUnits,
} from './model.js';
import { extensionRemoveConfirm, extensionUpdateConfirm } from './market-model.js';
import {
  extensionActionButton, extensionCommandRow, extensionGlyph, extensionGroupHead, extensionMoreButton,
  extensionOutcomeBox, extensionSearchField, extensionStateTile, extensionSyncActionButton,
} from './parts.js';

const KNOWN = new Map([
  ['web', ['Web Access', renderWebSetup]],
  ['subagents', ['Subagents', renderSubagentSetup]],
  ['memory', ['Pi Memory', renderMemorySetup]],
  ['browser', ['Browser Use', renderBrowserSetup]],
]);
const STALE_TEXT = '项目已切换，刷新后查看当前项目的扩展。';
const TOOL_REGISTRY_NOTE = 'Pi RPC 未提供已注册工具列表；工具来源未知时，聊天时间线仍按原始名称显示。';

export function renderInstalledExtensions(holder, { isLive, onCount = () => {}, operations }) {
  const toolbar = el('div', 'extensions-toolbar');
  const resultCount = el('span', 'extensions-result-count');
  resultCount.setAttribute('aria-live', 'polite');
  const { field, input } = extensionSearchField({ placeholder: '搜索扩展', label: '搜索已安装的扩展' });
  toolbar.append(resultCount, field);
  const actions = el('div', 'extensions-head-buttons');
  const refresh = extensionActionButton('btn ghost extensions-refresh', '刷新', 'refresh');
  const more = extensionMoreButton('已安装扩展选项');
  actions.append(refresh, more);

  const notes = el('div', 'extensions-notes');
  const list = el('div', 'extensions-list');
  const known = el('section', 'ext-known');
  const knownHead = extensionGroupHead('已知能力', KNOWN.size + 1, 'extensionsKnownTitle');
  known.setAttribute('aria-labelledby', 'extensionsKnownTitle');
  const knownBody = el('div', 'ext-known-body');
  known.append(knownHead, knownBody);
  const setupBoxes = new Map();
  for (const [id, [name]] of [...KNOWN, ['approval', ['Approval / Permission']]]) {
    const details = el('details', 'ext-known-item');
    const box = el('div', 'ext-known-item-body');
    details.append(el('summary', 'ext-known-item-summary', name), box);
    knownBody.append(details);
    setupBoxes.set(id, box);
  }
  holder.append(notes, list, known);

  let registry = null;
  let inventory = null;
  let units = [];
  let loading = true;
  let stale = false;
  let disposed = false;
  let request = 0;
  let detailSeq = 0;
  const expanded = new Set();
  const detailIds = new Map();
  const live = () => !disposed && isLive();

  function renderKnown() {
    const managed = new Map(units.filter((unit) => unit.pkg?.capabilityId)
      .map((unit) => [unit.pkg.capabilityId, unit]));
    for (const [id, [, renderSetup]] of KNOWN) {
      const box = setupBoxes.get(id);
      box.parentElement.hidden = managed.has(id);
      if (managed.has(id)) continue;
      const generation = S.workspaceGeneration;
      renderSetup(box, registry, { onRegistry: () => {
        if (live() && ownsWorkspace(generation)) operations?.rediscover();
      } });
    }
    knownHead.querySelector('.extensions-group-count').textContent = String(KNOWN.size + 1 - managed.size);
  }

  function renderDetails(node, unit) {
    const rows = el('div', 'ext-rows');
    for (const [label, value] of extensionUnitFactRows(unit)) rows.append(row(label, value));
    if (unit.pkg) {
      rows.append(row('已登记', '是'));
    }
    if (!unit.pkg?.capabilityId) rows.append(row('运行中观测', '未知'));
    if (unit.errorEntry?.state?.error?.phase) rows.append(row('错误阶段', unit.errorEntry.state.error.phase));
    node.append(rows);
    if (unit.pkg) {
      const reasons = new Set(Object.values(unit.pkg.actions || {}).filter((action) => !action.allowed && action.reason).map((action) => action.reason));
      for (const reason of reasons) node.append(note(reason, 'dim'));
      for (const command of Object.values(unit.pkg.manual || {}).filter(Boolean)) node.append(extensionCommandRow(command));
    }
    const observedSetup = KNOWN.get(unit.pkg?.capabilityId);
    if (observedSetup) {
      const setup = el('div', 'extensions-embedded-setup');
      observedSetup[1](setup, registry, { embedded: true });
      node.append(setup);
    }
    node.append(el('div', 'ext-sec-head', '已确认的能力'));
    const chips = extensionUnitChips(unit).filter((chip) => chip.mono);
    for (const chip of chips) node.append(note(chip.title, 'dim'));
    if (!chips.length) node.append(note('暂无可确认的能力。', 'dim'));
    node.append(note(TOOL_REGISTRY_NOTE, 'dim'));
  }

  function actionFor(unit, action, confirmation) {
    const button = extensionActionButton(action === 'remove' ? 'btn tiny danger' : 'btn tiny', confirmation.okText);
    const { id, name } = unit.pkg;
    button.dataset.packageAction = action;
    extensionSyncActionButton(button, operations?.busyFor(id, inventory?.operations?.running), action, {
      label: confirmation.okText, disabled: loading || S.switching,
    });
    button.onclick = () => operations?.run({ action, id, name, confirmation });
    return button;
  }

  function renderCard(unit) {
    const name = extensionUnitName(unit);
    const error = extensionUnitErrorText(unit);
    const card = el('article', 'ext-extension-item extensions-card' + (error ? ' is-error' : ''));
    card.setAttribute('role', 'listitem');
    card.dataset.extensionId = unit.id;
    const head = el('div', 'extensions-card-head');
    const heading = el('div', 'extensions-card-heading');
    const title = el('h4', 'ext-name', name);
    title.title = name;
    heading.append(title, el('div', 'extensions-card-meta', extensionUnitMeta(unit)));
    head.append(extensionGlyph(name, { error: !!error }), heading);
    const description = extensionUnitDescription(unit);
    const desc = el('p', 'extensions-card-desc', description || '（没有简介）');
    if (description) desc.title = description;
    card.append(head, desc);

    const tags = el('div', 'extensions-card-tags');
    for (const tag of extensionUnitTags(unit)) tags.append(createBadge(tag));
    const chips = extensionUnitChips(unit);
    for (const chip of chips.slice(0, 3)) {
      const node = el('span', 'extensions-cap' + (chip.mono ? '' : ' is-more'), chip.text);
      node.title = chip.title;
      tags.append(node);
    }
    if (chips.length > 3) tags.append(el('span', 'extensions-cap is-more', `另有 ${chips.length - 3} 项`));
    if (tags.childElementCount) card.append(tags);
    if (error) card.append(el('p', 'extensions-card-error', error));

    if (!detailIds.has(unit.id)) detailIds.set(unit.id, `extensionDetail-${++detailSeq}`);
    const details = el('div', 'extensions-card-details');
    details.id = detailIds.get(unit.id);
    const toggle = extensionActionButton('btn ghost tiny extensions-card-toggle', '详情');
    toggle.append(createIcon('chevronDown', { size: 13, className: 'extensions-card-chevron' }));
    toggle.setAttribute('aria-controls', details.id);
    toggle.setAttribute('aria-label', `${name} 详情`);
    function syncDetail() {
      const open = expanded.has(unit.id);
      toggle.setAttribute('aria-expanded', String(open));
      card.classList.toggle('is-open', open);
      details.hidden = !open;
      if (open && !details.childElementCount) renderDetails(details, unit);
    }
    toggle.onclick = () => {
      if (expanded.has(unit.id)) expanded.delete(unit.id);
      else expanded.add(unit.id);
      syncDetail();
    };
    syncDetail();
    const foot = el('div', 'extensions-card-foot');
    const packageActions = el('div', 'extensions-package-actions');
    if (unit.pkg?.actions?.update?.allowed) packageActions.append(actionFor(unit, 'update', extensionUpdateConfirm(unit.pkg)));
    if (unit.pkg?.actions?.remove?.allowed) packageActions.append(actionFor(unit, 'remove', extensionRemoveConfirm(unit.pkg)));
    foot.append(toggle, packageActions);
    card.append(foot, details);
    return card;
  }

  function render() {
    if (!live()) return;
    notes.replaceChildren();
    refresh.disabled = loading;
    known.hidden = stale;
    if (stale) {
      resultCount.textContent = '';
      list.replaceChildren(extensionStateTile(STALE_TEXT, { icon: 'refresh', actions: [{ label: '刷新', onClick: load }] }));
      return;
    }
    const query = input.value;
    const matches = filterExtensionUnits(units, query);
    resultCount.textContent = query.trim() ? `找到 ${matches.length} 个，共 ${units.length} 个` : '';
    const receipt = operations?.receipt();
    if (receipt) notes.append(extensionOutcomeBox(receipt.outcome, { name: receipt.name, onDismiss: operations.dismiss }));
    if (!loading && !registry && !inventory) {
      list.replaceChildren(extensionStateTile(SURFACE_COPY.failed('扩展'), {
        icon: 'warning', actions: [{ label: SURFACE_COPY.retry, onClick: load }],
      }));
      return;
    }
    if (!loading && registry && !registry.piReachable && S.hasProject) notes.append(note('Pi 未应答，无法确认实际加载状态。', 'warn'));
    if (!loading && !inventory && registry) notes.append(note('包清单未能读取，暂时只显示探测到的扩展入口。', 'warn'));
    if (!loading && inventory && !registry) notes.append(note('扩展入口读取失败，包的加载状态未知。', 'warn'));
    if (!loading && !S.hasProject) notes.append(note('还没有打开项目，只显示全局扩展与 pi 自带的能力。', 'dim'));
    for (const warning of inventory?.diagnostics || []) notes.append(note(warning.message, 'warn'));
    if (!matches.length) {
      const title = loading ? SURFACE_COPY.loading('扩展') : units.length ? '没有符合搜索条件的扩展' : '还没有发现已安装的扩展';
      list.replaceChildren(extensionStateTile(title, { icon: units.length ? 'search' : 'box' }));
      return;
    }
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const focusId = focused?.closest('[data-extension-id]')?.dataset.extensionId;
    const focusAction = focused?.dataset.packageAction;
    list.replaceChildren(...groupExtensionUnits(matches).map((group) => {
      const section = el('section', 'extensions-group');
      section.dataset.group = group.id;
      const titleId = `extensionsGroup-${group.id}`;
      section.setAttribute('aria-labelledby', titleId);
      const grid = el('div', 'extensions-grid');
      grid.setAttribute('role', 'list');
      for (const unit of group.items) grid.append(renderCard(unit));
      section.append(extensionGroupHead(group.label, group.items.length, titleId), grid);
      return section;
    }));
    if (focusId) {
      const card = [...list.querySelectorAll('[data-extension-id]')].find((node) => node.dataset.extensionId === focusId);
      const target = focusAction && card?.querySelector(`[data-package-action="${focusAction}"]:not([disabled])`);
      (target || card?.querySelector('.extensions-card-toggle') || input).focus();
    }
  }

  async function load() {
    if (!live()) return;
    if (S.switching) { invalidate(); return; }
    const token = ++request;
    const generation = S.workspaceGeneration;
    stale = false;
    loading = true;
    render();
    const [nextRegistry, nextInventory] = await Promise.all([fetchExtensions(), fetchExtensionPackages()]);
    if (!live() || token !== request) return;
    loading = false;
    if (!ownsWorkspace(generation)) { stale = true; render(); return; }
    registry = nextRegistry?.ok === true ? nextRegistry : null;
    inventory = nextInventory?.ok === true ? nextInventory : null;
    units = buildExtensionUnits(registry, inventory);
    onCount(registry || inventory ? units.length : null);
    render();
    renderKnown();
    const report = await fetchApprovalCapability();
    if (live() && token === request && ownsWorkspace(generation)) renderApprovalSetup(setupBoxes.get('approval'), report);
  }

  function invalidate() {
    ++request;
    registry = null;
    inventory = null;
    units = [];
    loading = false;
    stale = true;
    expanded.clear();
    detailIds.clear();
    onCount(null);
    render();
  }

  input.addEventListener('input', render);
  refresh.onclick = load;
  more.onclick = () => openActionMenu(more, [
    { label: '重启 Pi', disabled: !S.hasProject || S.switching || Boolean(operations?.busyFor(null, inventory?.operations?.running)),
      disabledReason: S.hasProject ? '等待当前 Pi 操作完成' : '打开项目后可以重启 Pi',
      onClick: async () => { if (await restartPi()) await load(); } },
    { label: '启用或停用扩展', onClick: () => {
      const message = el('div', 'extensions-inline-note');
      message.append(el('span', '', '当前 Pi 通过终端交互式配置管理启停。'), extensionCommandRow('pi config'));
      notes.append(message);
    } },
  ]);
  void load();

  return {
    toolbar, actions, sync: render, reload: load, invalidate,
    activate() { if (inventory?.operations?.running && !loading) void load(); },
    dispose() { disposed = true; request++; },
  };
}
