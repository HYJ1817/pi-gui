/* 模型供应商管理页。
 *
 * P4 的主界面。配置读写全部走 P0/P1 的 /api/provider-management；
 * 旧的 /api/providers 只保留为「管理接口未启用」时的只读降级视图，
 * 也用于兼容需要路径/密钥状态提示的旧调用方。
 *
 * 这里没有多行 textarea 模型配置，也没有 API Key 输入框：
 * 模型在双栏弹窗里管理，密钥由 P2 的安全桌面窗口负责。 */

import { el, panels } from './state.js';
import { fmtTokens } from './util.js';
import {
  deleteProvider as apiDeleteProvider,
  fetchProviderManagement,
  fetchProviders,
  restartBackend,
  saveProviderDraft,
  commitProviderDraft,
} from './api.js';
import { openModal, confirmModal } from './ui/modal.js';
import { toast } from './ui/toast.js';
import { clearThread } from './messages.js';
import { mountProviderAuth } from './provider-auth.js';
import { openProviderDialog } from './provider-management/dialog.js';
import {
  credentialSourceLabel,
  endpointLabel,
  monogram,
  serviceDisplayName,
  serviceModelCount,
  serviceSelectable,
  subscriptionAvailability,
} from './provider-management/catalog.js';
import { draftFromService, newRequestId, toDraftPayload } from './provider-management/state.js';
import { button, h, icon } from './provider-management/dom.js';

/* ---------- 旧版模型行语法（保留导出，供模型快捷键与既有测试使用） ---------- */

const MODEL_PARAM_ALIAS = {
  ctx: 'contextWindow',
  context: 'contextWindow',
  contextwindow: 'contextWindow',
  max: 'maxTokens',
  maxtokens: 'maxTokens',
};

export function parseModelLine(line) {
  const parts = String(line).split('|').map((s) => s.trim());
  const id = parts.shift();
  if (!id) return null;

  const model = { id };

  for (const part of parts) {
    if (!part) continue;

    const eq = part.indexOf('=');
    if (eq === -1) {
      if (!model.name) model.name = part;
      continue;
    }

    const rawKey = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    const key =
      MODEL_PARAM_ALIAS[rawKey.toLowerCase()] ||
      ['contextWindow', 'maxTokens', 'reasoning', 'input', 'toolCalling', 'streaming'].find((k) => k.toLowerCase() === rawKey.toLowerCase());
    if (!key) continue;

    if (key === 'reasoning') {
      if (/^(1|true|yes|on|0|false|no|off)$/i.test(value)) model.reasoning = /^(1|true|yes|on)$/i.test(value);
    } else if (key === 'toolCalling' || key === 'streaming') {
      if (/^(1|true|yes|on|0|false|no|off)$/i.test(value)) {
        if (!model.capabilities) model.capabilities = {};
        model.capabilities[key] = /^(1|true|yes|on)$/i.test(value);
      }
    } else if (key === 'input') {
      const kinds = value.split(',').map((s) => s.trim()).filter(Boolean);
      if (kinds.length) model.input = kinds;
    } else {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) model[key] = Math.round(n);
    }
  }

  return model;
}

export function modelLine(m) {
  const parts = [m.id];
  if (m.name) parts.push(String(m.name).replace(/\|/g, '/'));
  if (m.contextWindow) parts.push(`contextWindow=${m.contextWindow}`);
  if (m.maxTokens) parts.push(`maxTokens=${m.maxTokens}`);
  if (typeof m.reasoning === 'boolean') parts.push(`reasoning=${m.reasoning}`);
  const input = m.input || (m.capability?.capabilities?.imageInput === false && m.capability?.capabilities?.textInput === true ? ['text'] : null);
  if (Array.isArray(input) && input.length) parts.push(`input=${input.join(',')}`);
  for (const key of ['toolCalling', 'streaming']) {
    const value = m.capabilities?.[key] ?? m.capability?.capabilities?.[key];
    if (typeof value === 'boolean') parts.push(`${key}=${value}`);
  }
  return parts.join('|');
}

/* ---------- 页面状态 ---------- */

let providerData = { path: '', providers: {}, keyStates: {} };
let providerError = '';
let providerRequest = 0;
let managementSnapshot = null;
let legacyMode = false;
let menuCloser = null;
let pageStatusHost = null;

function catalogSpanText(count) {
  return `目录: 内置快照 · ${count} 个自定义服务 · 更新于 本地`;
}

function updateCatalogFooter(count) {
  for (const span of document.querySelectorAll('.prov-catalog-info span')) span.textContent = catalogSpanText(count);
}

function updateProviderCount(count) {
  if (el.providerCount) el.providerCount.textContent = count ? String(count) : '';
}

function pageStatus(text, tone = 'info') {
  const host = pageStatusHost?.isConnected ? pageStatusHost : document.querySelector('.pm-page-status');
  if (!host) return;
  host.hidden = !text;
  host.className = `pm-page-status is-${tone}`;
  host.innerHTML = '';
  if (text) {
    host.append(icon(tone === 'error' ? 'alert' : tone === 'success' ? 'check' : 'info', 15), h('span', { text }));
  }
}

function serviceBadges(service) {
  const badges = [];
  if (service.enabled === false) badges.push({ text: '已停用', tone: 'muted' });
  if (service.authMode === 'oauth') badges.push({ text: '订阅账户', tone: 'info' });
  if (service.credentialState?.source === 'env') badges.push({ text: '环境变量', tone: '' });
  if (service.credentialState?.source === 'pi-credential') badges.push({ text: 'Pi 凭据', tone: '' });
  if (service.credentialState?.state === 'none') badges.push({ text: '无凭据', tone: 'muted' });
  if (service.readOnly) badges.push({ text: '只读', tone: 'muted' });
  if (service.compatibility === 'unsupported') badges.push({ text: '兼容性未知', tone: 'warning' });
  return badges;
}

function serviceMeta(service) {
  const endpoint = endpointLabel(service.connection) || '订阅账户';
  const count = service.selectedModelIds === null
    ? `${service.models?.length || 0} 个已配置模型 · 继承`
    : `${serviceModelCount(service)} 个已选模型`;
  return `${endpoint} · ${count}`;
}

function serviceMenu(service, { onEdit, onClone, onToggle, onDelete, onAuth }) {
  const menu = h('div', { class: 'pm-row-menu', role: 'menu', hidden: true });
  const item = (label, action, { disabled = false, reason = '', danger = false } = {}) => {
    const b = h('button', {
      type: 'button',
      class: `pm-row-menu-item${danger ? ' is-danger' : ''}`,
      role: 'menuitem',
      disabled,
      title: reason,
      'data-service-action': label,
      on: { click: event => {
        event.stopPropagation();
        closeMenu();
        if (!disabled) action();
      } },
    }, label);
    return b;
  };
  menu.append(
    item('编辑', onEdit),
    service.authMode === 'oauth'
      ? item('管理登录', onAuth)
      : item('复制', onClone, { disabled: service.readOnly || !serviceSelectable(service), reason: service.readOnly ? '只读服务不能复制' : '' }),
    item('测试连接', () => {}, { disabled: true, reason: '连接测试随 P3 网络授权接通' }),
    item(service.enabled === false ? '启用' : '停用', onToggle, {
      disabled: service.readOnly || (service.authMode === 'oauth' && service.enabled === false),
      reason: service.readOnly ? '只读服务不能停用'
        : service.authMode === 'oauth' && service.enabled === false ? '订阅账户需在 Pi 官方登录中启用' : '',
    }),
    item('删除', onDelete, { danger: true, disabled: service.readOnly, reason: service.readOnly ? '只读服务不能删除' : '' }),
  );
  return menu;
}

function closeMenu() {
  if (menuCloser) {
    const fn = menuCloser;
    menuCloser = null;
    fn();
  }
}

function openMenu(row, menu) {
  closeMenu();
  menu.hidden = false;
  row.classList.add('menu-open');
  const closer = event => {
    if (!menu.contains(event.target)) {
      menu.hidden = true;
      row.classList.remove('menu-open');
      document.removeEventListener('click', closer, true);
      if (menuCloser === closer) menuCloser = null;
    }
  };
  menuCloser = () => {
    menu.hidden = true;
    row.classList.remove('menu-open');
    document.removeEventListener('click', closer, true);
  };
  setTimeout(() => document.addEventListener('click', closer, true), 0);
}

async function refreshManagement() {
  await loadProviders(panels.providers || document.querySelector('.providers'));
}

async function commitServiceAction(action, service, draft = null) {
  const request = {
    requestId: newRequestId('service'),
    action,
    expectedRevision: managementSnapshot?.revision,
    serviceId: service.serviceId,
  };
  if (draft) {
    const draftResult = await saveProviderDraft({
      requestId: newRequestId('draft'),
      serviceId: service.serviceId,
      expectedRevision: managementSnapshot?.revision,
      draft: toDraftPayload(draft),
    });
    if (!draftResult?.ok) return draftResult;
    request.draftId = draftResult.draftId;
    request.draftRevision = draftResult.draftRevision;
  }
  return commitProviderDraft(request);
}

async function toggleService(service) {
  if (!managementSnapshot) return;
  if (service.enabled !== false) {
    const ok = await confirmModal({
      title: '停用服务？',
      message: `停用后 ${service.displayName || service.serviceId} 不会出现在模型选择器里；配置和凭据都保留。`,
      okText: '停用',
      cancelText: '取消',
    });
    if (!ok) return;
    const result = await commitServiceAction('disable', service);
    if (!result?.ok) {
      toast(result?.message || '停用失败', 'error');
      await refreshManagement();
      return;
    }
    toast('服务已停用，等待 Runtime 同步。', 'info', { important: true });
    await refreshManagement();
    return;
  }
  const draft = draftFromService(service, managementSnapshot, 'edit');
  draft.enabled = true;
  const result = await commitServiceAction('update', service, draft);
  if (!result?.ok) {
    toast(result?.message || '启用失败', 'error');
    await refreshManagement();
    return;
  }
  toast('服务已启用，等待 Runtime 同步。', 'info', { important: true });
  await refreshManagement();
}

async function removeService(service) {
  const ok = await confirmModal({
    title: service.readOnly ? '删除只读服务？' : '删除服务？',
    message: service.readOnly
      ? `内置服务 ${service.displayName || service.serviceId} 不会被真正删除，而是从 GUI 中停用。`
      : `将删除 ${service.displayName || service.serviceId} 的 Pi 配置。模型与凭据会随配置一起移除；其它服务不受影响。`,
    okText: '删除',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;
  const result = await commitServiceAction('delete', service);
  if (!result?.ok) {
    toast(result?.message || '删除失败', 'error');
    await refreshManagement();
    return;
  }
  toast('服务已删除，等待 Runtime 同步。', 'info', { important: true });
  await refreshManagement();
}

function openEdit(service) {
  if (service.authMode === 'oauth') {
    openProviderDialog({ present: openModal, snapshot: managementSnapshot, mode: 'auth', service, onSaved: refreshManagement, onClosed: refreshManagement });
    return;
  }
  openProviderDialog({
    present: openModal,
    snapshot: managementSnapshot,
    mode: 'edit',
    service,
    onSaved: result => {
      if (result?.sync?.state === 'pending') pageStatus('服务已保存，等待 Runtime 同步（P3 尚未接通）。', 'info');
      refreshManagement();
    },
    onClosed: refreshManagement,
  });
}

function openClone(service) {
  openProviderDialog({
    present: openModal,
    snapshot: managementSnapshot,
    mode: 'clone',
    service,
    onSaved: result => {
      if (result?.sync?.state === 'pending') pageStatus('服务已保存，等待 Runtime 同步（P3 尚未接通）。', 'info');
      refreshManagement();
    },
    onClosed: refreshManagement,
  });
}

function managementRow(service) {
  const editable = serviceSelectable(service) && service.authMode !== 'oauth';
  const row = h('div', {
    class: `prov pm-service-row${service.enabled === false ? ' is-disabled' : ''}${service.readOnly ? ' is-readonly' : ''}`,
    'data-service-id': service.serviceId,
    role: 'button',
    tabindex: '0',
    'aria-label': `编辑服务 ${serviceDisplayName(service, managementSnapshot)}`,
  });
  const menu = serviceMenu(service, {
    onEdit: () => openEdit(service),
    onClone: () => openClone(service),
    onToggle: () => toggleService(service),
    onDelete: () => removeService(service),
    onAuth: () => openProviderDialog({ present: openModal, snapshot: managementSnapshot, mode: 'auth', service, onSaved: refreshManagement, onClosed: refreshManagement }),
  });
  const more = h('button', {
    type: 'button',
    class: 'pm-row-more',
    'aria-label': `更多操作 ${service.displayName || service.serviceId}`,
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    on: { click: event => {
      event.stopPropagation();
      const open = menu.hidden;
      openMenu(row, menu);
      more.setAttribute('aria-expanded', String(open));
    } },
  }, icon('more', 18));

  row.append(
    h('span', { class: 'prov-avatar pm-service-monogram', 'aria-hidden': 'true', text: monogram({ id: service.catalogId || service.providerId, name: service.displayName }) }),
    h('span', { class: 'prov-main pm-service-main' },
      h('span', { class: 'prov-title-row' },
        h('span', { class: 'prov-name', text: serviceDisplayName(service, managementSnapshot) }),
        ...serviceBadges(service).map(badge => h('span', { class: `pm-badge${badge.tone ? ` is-${badge.tone}` : ''}`, text: badge.text })),
      ),
      h('span', { class: 'prov-meta', text: serviceMeta(service) }),
      providerData.keyStates?.[service.providerId] && !providerData.keyStates[service.providerId].ok
        ? h('span', { class: 'prov-warn ds-badge ds-badge-warning', text: providerData.keyStates[service.providerId].note })
        : null,
      service.readOnly ? h('span', { class: 'prov-warn pm-inline-note', text: '由 Pi 内置配置管理，当前只读。' }) : null,
    ),
    h('span', { class: 'pm-row-actions' }, more, menu),
  );
  const activate = event => {
    if (event && event.target.closest('button, .pm-row-menu')) return;
    openEdit(service);
  };
  row.addEventListener('click', activate);
  row.addEventListener('keydown', event => {
    // 子按钮（尤其是“更多操作”）自己处理键盘；事件冒泡不能把编辑弹窗抢开。
    if (event.target !== row) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openEdit(service);
    }
  });
  return row;
}

function legacyRow(name) {
  const cfg = providerData.providers[name] || {};
  const count = Array.isArray(cfg.models) ? cfg.models.length : 0;
  const row = h('div', { class: 'prov' },
    h('div', { class: 'prov-avatar', 'aria-hidden': 'true', text: (name.charAt(0) || 'P').toUpperCase() }),
    h('div', { class: 'prov-main' },
      h('div', { class: 'prov-title-row' },
        h('span', { class: 'prov-name', text: name }),
        h('span', { class: 'prov-status-dot', title: '已配置' }),
      ),
      h('span', { class: 'prov-meta', text: `${count} 个模型 · ${cfg.api || 'openai-completions'}`, title: cfg.baseUrl || '' }),
      providerData.keyStates[name] && !providerData.keyStates[name].ok
        ? h('span', { class: 'prov-warn ds-badge ds-badge-warning', text: providerData.keyStates[name].note })
        : null,
    ),
  );
  const del = h('button', {
    type: 'button',
    class: 'prov-del',
    title: '删除该供应商',
    'aria-label': `删除供应商 ${name}`,
    on: { click: async event => {
      event.stopPropagation();
      await removeProvider(name);
    } },
  }, icon('close', 15));
  row.appendChild(del);
  return row;
}

function emptyCard(box) {
  const card = h('div', { class: 'hint-empty prov-empty-card ds-settings-card' },
    h('div', { class: 'prov-empty-icon', 'aria-hidden': 'true' }, icon('globe', 38)),
    h('h4', { class: 'prov-empty-title', text: '还没有 AI 服务' }),
    h('p', { class: 'prov-empty-desc', text: '添加 AI 服务即可开始；订阅账户与 API Key 服务都在这里管理。' }),
  );
  const add = h('button', {
    type: 'button',
    class: 'btn primary prov-empty-btn',
    text: '添加服务',
    on: { click: () => openAddProvider({ snapshot: managementSnapshot }) },
  });
  card.appendChild(add);
  return card;
}

export async function loadProviders(container) {
  const request = ++providerRequest;
  const [management, legacy] = await Promise.all([
    fetchProviderManagement().catch(() => null),
    fetchProviders().catch(() => null),
  ]);
  if (request !== providerRequest) return;
  if (legacy && legacy.ok !== false) {
    providerData = { path: legacy.path || '', providers: legacy.providers || {}, keyStates: legacy.keyStates || {} };
  }
  providerError = '';
  if (management && management.ok === true && Array.isArray(management.services)) {
    managementSnapshot = management;
    legacyMode = false;
  } else {
    managementSnapshot = null;
    legacyMode = true;
    // 管理能力默认关闭时旧路由仍然可用；只有旧路由也失败才显示错误，
    // 否则会把整页旧供应商列表吞掉。
    if (legacy && legacy.ok !== false) providerError = '';
    else providerError = legacy?.error || management?.message || management?.error || '供应商配置暂时无法读取，请稍后重试。';
  }
  renderProviders(container || panels.providers || document.querySelector('.providers'));
}

export function renderProviders(box) {
  const target = box || panels.providers || document.querySelector('.providers');
  if (target) {
    target.innerHTML = '';
    target.classList.add('pm-service-list');
  }
  if (legacyMode) {
    const names = Object.keys(providerData.providers || {});
    updateProviderCount(names.length);
    updateCatalogFooter(names.length);
    if (!target) return;
    if (providerError) {
      target.appendChild(h('div', { class: 'hint-empty' }, providerError));
      return;
    }
    if (!names.length) { target.appendChild(emptyCard(target)); return; }
    for (const name of names) target.appendChild(legacyRow(name));
    return;
  }

  const services = managementSnapshot?.services || [];
  updateProviderCount(services.length);
  updateCatalogFooter(services.length);
  if (!target) return;
  if (!services.length) { target.appendChild(emptyCard(target)); return; }
  for (const service of services) target.appendChild(managementRow(service));

  const sync = managementSnapshot?.sync;
  if (sync?.state === 'pending') pageStatus('配置已保存，等待 Runtime 同步（P3 尚未接通）。', 'info');
  else if (sync?.state === 'error') pageStatus('Runtime 同步失败；配置已保存，可以稍后重试。', 'error');
  else pageStatus('');
}

export function setProvidersData(data) {
  providerRequest += 1;
  managementSnapshot = null;
  legacyMode = true;
  providerData = {
    path: data?.path || '',
    providers: data?.providers || {},
    keyStates: data?.keyStates || {},
  };
  providerError = data?.error || '';
  renderProviders(panels.providers || (typeof document !== 'undefined' ? document.querySelector('.providers') : null));
}

export function openProvidersPanel({ present = openModal } = {}) {
  let ownedBox = null;
  present((card, close) => {
    card.classList.add('wide', 'prov-settings-page', 'pm-settings-page');

    const topHeader = document.createElement('div');
    topHeader.className = 'settings-detail-header-row';

    const titleCol = document.createElement('div');
    const hTitle = document.createElement('h3');
    hTitle.className = 'settings-page-title';
    hTitle.textContent = '模型配置';
    const subLabel = document.createElement('div');
    subLabel.className = 'ds-settings-group-header';
    subLabel.style.marginTop = '14px';
    subLabel.textContent = 'AI 服务';
    titleCol.append(hTitle, subLabel);

    const actionCol = document.createElement('div');
    actionCol.className = 'prov-header-actions';
    const addTopBtn = h('button', {
      type: 'button',
      class: 'btn primary prov-btn-main',
      on: { click: () => openAddProvider({ snapshot: managementSnapshot }) },
    }, '+ 添加服务');
    actionCol.append(addTopBtn);
    topHeader.append(titleCol, actionCol);
    card.appendChild(topHeader);

    const desc = document.createElement('div');
    desc.className = 'modal-desc settings-page-desc';
    desc.textContent = `管理 Pi 的模型服务（${providerData.path || '~/.pi/agent/models.json'}）。API Key 不经过这个页面。`;
    card.appendChild(desc);

    const status = h('div', { class: 'pm-page-status', role: 'status', hidden: true });
    pageStatusHost = status;
    card.appendChild(status);

    const box = document.createElement('div');
    box.className = 'providers pm-service-list';
    card.appendChild(box);
    panels.providers = box;
    ownedBox = box;
    box.innerHTML = '<div class="hint-empty">加载中…</div>';

    const catalogFooter = document.createElement('div');
    catalogFooter.className = 'prov-catalog-footer ds-settings-card';
    catalogFooter.innerHTML = `
      <div class="prov-catalog-info">
        <span>目录: 内置快照 · 0 个自定义服务 · 更新于 本地</span>
      </div>
    `;
    const reloadBtn = h('button', {
      type: 'button',
      class: 'btn tiny ds-btn-secondary prov-reload-btn',
      on: { click: () => { close(); reloadPi(); } },
    }, icon('refresh', 14), h('span', { text: '重载 pi 配置' }));
    catalogFooter.appendChild(reloadBtn);
    card.appendChild(catalogFooter);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const add = h('button', { type: 'button', class: 'btn primary', text: '添加服务', on: { click: () => openAddProvider({ snapshot: managementSnapshot }) } });
    const reload = h('button', { type: 'button', class: 'btn', text: '重载 pi 配置', on: { click: () => { close(); reloadPi(); } } });
    const done = h('button', { type: 'button', class: 'btn', text: '关闭', on: { click: close } });
    actions.append(add, reload, done);
    card.appendChild(actions);

    loadProviders(box);
  }, () => {
    if (panels.providers === ownedBox) panels.providers = null;
    if (pageStatusHost === document.querySelector('.pm-page-status')) pageStatusHost = null;
  });
}

export function openAddProvider({ present = openModal, snapshot = managementSnapshot } = {}) {
  openProviderDialog({
    present,
    snapshot,
    mode: 'create',
    onSaved: result => {
      if (result?.sync?.state === 'pending') pageStatus('服务已保存，等待 Runtime 同步（P3 尚未接通）。', 'info');
      refreshManagement();
    },
    onClosed: refreshManagement,
  });
}

export function openProviderAuthPanel({ present = openModal } = {}) {
  let dispose = () => {};
  present((card, close) => {
    card.classList.add('wide');
    const heading = document.createElement('h3');
    heading.textContent = '供应商与认证';
    const auth = document.createElement('div');
    auth.className = 'provider-auth';
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const done = document.createElement('button');
    done.className = 'btn';
    done.textContent = '关闭';
    done.onclick = close;
    actions.appendChild(done);
    card.append(heading, auth, actions);
    dispose = mountProviderAuth(auth, () => loadProviders());
  }, () => dispose());
}

export async function removeProvider(name) {
  const j = await apiDeleteProvider(name);
  if (!j.ok) return toast(j.error || '删除失败', 'error');
  toast(`已删除供应商 ${name}。重载 pi 后生效。`, 'info');
  await loadProviders();
}

export async function reloadPi() {
  await restartBackend();
  toast('正在重载 pi 配置…', 'info');
  clearThread();
}
