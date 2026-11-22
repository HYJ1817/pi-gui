/* 包详情使用共享弹层。网络详情、安装清单和命令结果各保留自己的证据。 */
import { S, ownsWorkspace } from '../state.js';
import { fetchExtensionMarketItem, fetchExtensionPackages } from '../api.js';
import { openModal } from '../ui/modal.js';
import { safeWebUrl, webSourceLink } from '../web-activity.js';
import { resourceEl as el } from '../ui/resource-dom.js';
import {
  extensionDetailLinks, extensionDetailSections, extensionInstallConfirm, extensionMarketCardState,
  extensionMarketMeta, extensionRemoveConfirm, extensionUpdateConfirm,
} from './market-model.js';
import {
  extensionActionButton, extensionCommandRow, extensionGlyph, extensionOutcomeBox, extensionSyncActionButton,
} from './parts.js';

export function openExtensionPackageDetail(initial, { operations, isLive, onClose }) {
  const generation = S.workspaceGeneration;
  let active = true;
  let closeDialog = () => {};
  let paint = () => {};
  let item = initial;
  let inventory = null;
  let response = null;
  let loading = true;
  let request = 0;
  const live = () => active && isLive() && ownsWorkspace(generation);

  async function load({ preserve = false } = {}) {
    if (!live()) return;
    const token = ++request;
    loading = true;
    if (!preserve) paint();
    const [nextResponse, nextInventory] = await Promise.all([
      fetchExtensionMarketItem(initial.id), fetchExtensionPackages(),
    ]);
    if (!live() || token !== request) return;
    loading = false;
    response = nextResponse;
    inventory = nextInventory?.ok === true ? nextInventory : null;
    if (response?.ok === true) item = response.item;
    paint();
  }

  openModal((card, close) => {
    closeDialog = close;
    const header = el('header', 'extensions-detail-head');
    const heading = el('div', 'extensions-card-heading');
    const title = el('h3', '', initial.name);
    title.id = 'extensionsPackageTitle';
    title.tabIndex = -1;
    const meta = el('div', 'extensions-card-meta');
    heading.append(title, meta);
    const closeButton = extensionActionButton('btn ghost tiny', '关闭', 'close');
    closeButton.onclick = close;
    header.append(extensionGlyph(initial.name), heading, closeButton);
    const body = el('div', 'extensions-detail-body');
    const footer = el('div', 'extensions-detail-footer');
    card.append(header, body, footer);

    paint = () => {
      if (!live()) return;
      const focused = document.activeElement;
      const focusAction = footer.contains(focused) ? focused.dataset.action : null;
      const detail = response?.detail || null;
      const installedId = item.installed?.packageId;
      const pkg = inventory?.packages?.find((record) => record.id === installedId);
      const serverBusy = Boolean(inventory?.operations?.running && !operations.receipt());
      meta.textContent = extensionMarketMeta(item);
      body.replaceChildren();
      footer.replaceChildren();
      if (item.description) body.append(el('p', 'extensions-detail-desc', item.description));

      const links = el('div', 'extensions-detail-links');
      for (const link of extensionDetailLinks(item, detail)) {
        const url = safeWebUrl(link.url);
        if (!url || !url.startsWith('https:')) continue;
        const node = webSourceLink({ url, title: link.title, hostname: new URL(url).hostname });
        if (node) {
          node.tabIndex = 0;
          links.append(node);
        }
      }
      if (links.childElementCount) body.append(links);

      const receipt = operations.receipt();
      if (receipt && (receipt.id === item.id || receipt.id === installedId || receipt.name === item.name)) {
        body.append(extensionOutcomeBox(receipt.outcome));
      }
      if (loading) {
        const status = el('p', 'extensions-detail-desc', '正在读取包详情…');
        status.setAttribute('role', 'status');
        body.append(status);
      } else if (response?.ok !== true || response.detailState === 'failed') {
        const error = el('div', 'extensions-inline-note');
        error.append(el('span', '', '在线清单读取失败，以下为已知资料。'));
        const retry = extensionActionButton('btn tiny', '重试');
        retry.onclick = () => load();
        error.append(retry);
        body.append(error);
      }

      for (const section of extensionDetailSections({
        item, pkg, detail, compatibility: response?.compatibility, installRoot: inventory?.installRoot,
      })) {
        const group = el('section', 'extensions-detail-section');
        group.append(el('h4', '', section.title));
        if (section.note) group.append(el('p', '', section.note));
        const facts = el('dl', 'extensions-detail-facts');
        for (const row of section.rows) {
          const value = el('dd', row.mono ? 'is-mono' : '');
          if (row.copy) value.append(extensionCommandRow(row.value));
          else value.textContent = row.value;
          facts.append(el('dt', '', row.label), value);
        }
        group.append(facts);
        body.append(group);
      }

      function action(verb, id, label, confirmation, css) {
        const button = extensionActionButton(css, label);
        button.dataset.action = verb;
        extensionSyncActionButton(button, operations.busyFor(id, serverBusy), verb, { label, disabled: loading || S.switching });
        button.onclick = () => operations.run({ action: verb, id, name: item.name, confirmation });
        footer.append(button);
      }

      const state = extensionMarketCardState(item);
      if (state.kind === 'install') {
        action('install', item.id, '安装', extensionInstallConfirm(item, detail, { installRoot: inventory?.installRoot }), 'btn primary');
      }
      if (pkg?.actions?.update?.allowed) {
        const latest = state.kind === 'update' ? item.version : pkg.latest;
        const confirmation = extensionUpdateConfirm({ ...pkg, latest });
        action('update', pkg.id, confirmation.okText, confirmation, 'btn primary');
      }
      if (pkg?.actions?.remove?.allowed) {
        action('remove', pkg.id, '卸载', extensionRemoveConfirm(pkg), 'btn danger');
      }
      if (state.kind === 'blocked') footer.append(el('span', 'extensions-card-meta', state.reason));
      if (focusAction) {
        const next = [...footer.querySelectorAll('button')].find((node) => node.dataset.action === focusAction && !node.disabled);
        (next || title).focus();
      }
    };
    paint();
  }, () => { active = false; onClose?.(); }, {
    className: 'extensions-package-dialog', surface: 'extensions-package-detail',
    labelledBy: 'extensionsPackageTitle',
  });
  void load();

  return {
    refresh: () => load({ preserve: true }),
    sync: () => paint(),
    close: () => closeDialog(),
  };
}
