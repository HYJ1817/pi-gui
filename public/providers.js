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
  saveProvider as apiSaveProvider,
  saveProviderDraft,
  commitProviderDraft,
} from './api.js';
import { PROVIDER_CATALOG, isEnvReference, providerManagementCapabilities } from './provider-management/contract.js';
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

/* ---------- 管理接口关闭时的兼容适配 ----------
 *
 * 默认配置下 PI_GUI_PROVIDER_MANAGEMENT 是关闭的，旧 /api/providers 仍然
 * 访问同一个 P1 仓储。这里把旧 DTO 投影成 P4 快照，并实现草稿/提交适配，
 * 让 P4 的同一套选择器、双栏模型和高级设置继续可用；不复制第二套状态机。
 * 旧接口没有 displayName/enabled/目录/本机注册引用，兼容界面不展示或禁用
 * 这些字段，避免报告一个不会落盘的“成功”。 */

function legacyRevision(data) {
  const value = data?.revision;
  if (typeof value === 'string' && value) return `legacy-${value}`;
  if (typeof value === 'number' && Number.isFinite(value)) return `legacy-${value}`;
  return 'legacy-0';
}

function legacyCredentialState(key) {
  const kind = key?.kind;
  if (kind === 'env' || kind === 'literal' || kind === 'command') {
    return { state: key.ok ? 'saved' : 'none', source: kind };
  }
  return { state: 'none', source: 'unknown' };
}

function legacyCatalogId(name, config) {
  const direct = PROVIDER_CATALOG.find(item => item.id === name || item.providerId === name);
  if (direct) return direct.id;
  if (!config?.baseUrl) return null;
  const byTarget = PROVIDER_CATALOG.find(item => item.connection?.baseUrl === config.baseUrl);
  return byTarget ? byTarget.id : null;
}

function legacyModel(model, providerId) {
  const values = {};
  for (const field of ['name', 'contextWindow', 'maxTokens', 'reasoning', 'input']) {
    if (model?.[field] !== undefined) values[field] = model[field];
  }
  return {
    modelId: model.id,
    providerId,
    configSource: 'configured',
    effectiveValues: {
      ...values,
      toolCalling: model?.capability?.capabilities?.toolCalling ?? null,
      streaming: typeof model?.capabilities?.streaming === 'boolean' ? model.capabilities.streaming : null,
    },
    editableOverrides: values,
  };
}

export function legacySnapshot(data) {
  const providers = data?.providers && typeof data.providers === 'object' ? data.providers : {};
  const keyStates = data?.keyStates && typeof data.keyStates === 'object' ? data.keyStates : {};
  const services = Object.entries(providers).map(([name, config]) => {
    const key = legacyCredentialState(keyStates[name]);
    const models = (Array.isArray(config?.models) ? config.models : [])
      .filter(model => model && typeof model.id === 'string')
      .map(model => legacyModel(model, name));
    const ids = models.map(model => model.modelId);
    const connection = config?.baseUrl
      ? { baseUrl: String(config.baseUrl), api: String(config.api || 'openai-completions') }
      : null;
    return {
      serviceId: name,
      providerId: name,
      catalogId: legacyCatalogId(name, config),
      displayName: name,
      enabled: true,
      connection,
      credentialState: key,
      authMode: key.source === 'env' ? 'environment' : key.source === 'literal' || key.source === 'command' ? 'pi-credential' : 'none',
      models,
      // 旧接口没有“继承/显式选择”的概念；列表中的模型就是当前配置。
      selectedModelIds: ids,
      modelOrder: ids,
      readOnly: false,
      compatibility: 'unknown',
    };
  });
  return {
    ok: true,
    schemaVersion: 1,
    revision: legacyRevision(data),
    capabilities: providerManagementCapabilities({ oauthLogin: null, modelOverrides: null }),
    catalog: PROVIDER_CATALOG.map(item => ({ ...item })),
    services,
    auth: { sdkAvailable: false, piVersion: null, providers: [], flow: null },
    sync: { state: 'idle', reason: null },
  };
}

function applyLegacyModelPatches(models, patches) {
  const byId = new Map((Array.isArray(models) ? models : [])
    .filter(model => model && typeof model.id === 'string')
    .map(model => [model.id, { ...model }]));
  for (const patch of Array.isArray(patches) ? patches : []) {
    if (!patch || typeof patch.modelId !== 'string') continue;
    if (patch.operation === 'remove') { byId.delete(patch.modelId); continue; }
    const next = { ...(byId.get(patch.modelId) || { id: patch.modelId }), ...(patch.set || {}) };
    for (const field of patch.unsetFields || []) delete next[field];
    byId.set(patch.modelId, next);
  }
  return [...byId.values()];
}

function legacyFailure(code, message) {
  return { ok: false, code, message, error: message, retryable: false };
}

export function createLegacyProviderApi({ read = fetchProviders, write = apiSaveProvider } = {}) {
  const pending = new Map();
  async function readData() {
    const data = await read().catch(() => null);
    return data && data.ok !== false ? data : null;
  }
  return {
    async fetchProviderManagement() {
      const data = await readData();
      if (!data) return legacyFailure('unavailable', '无法读取供应商配置。');
      return legacySnapshot(data);
    },
    async saveProviderDraft(request) {
      const draft = request?.draft;
      if (!draft) return legacyFailure('invalid_request', '草稿不完整。');
      if (draft.authMode === 'oauth') return legacyFailure('unsupported', '兼容模式不接受订阅认证草稿。');
      if (draft.piRegistrationReference) return legacyFailure('unsupported', '兼容模式不保存本机注册引用。');
      if (request.credentialAction?.type === 'none') {
        return legacyFailure('unsupported', '兼容模式不会假装清除凭据；请开启管理接口或使用 Pi 本机登录管理。');
      }
      if (request.credentialAction?.type === 'env' && !isEnvReference(request.credentialAction.reference)) {
        return legacyFailure('invalid_request', '只接受 $NAME 或 ${NAME} 形式的环境变量引用。');
      }
      const draftId = newRequestId('legacy-draft');
      pending.set(draftId, { draft, serviceId: request.serviceId ?? null });
      if (pending.size > 32) pending.delete(pending.keys().next().value);
      return { ok: true, draftId, draftRevision: 1, connectionRevision: 1, targetFingerprint: 'legacy',
        credentialState: 'none', consentState: 'unapproved', cachedModels: [], sourceKind: 'none' };
    },
    async commitProviderDraft(request) {
      const staged = pending.get(request.draftId);
      if (!staged) return legacyFailure('draft_conflict', '兼容草稿已过期，请重新保存。');
      if (request.action !== 'create' && request.action !== 'update') {
        return legacyFailure('unsupported', '兼容模式只使用旧接口完成新增和编辑。');
      }
      const data = await readData();
      if (!data) return legacyFailure('unavailable', '无法读取供应商配置。');
      const providers = data.providers || {};
      const draft = staged.draft;
      const name = request.action === 'update'
        ? String(request.serviceId || draft.providerId || '')
        : String(draft.providerId || '');
      if (!name) return legacyFailure('invalid_request', '请填写供应商标识。');
      if (request.action === 'create' && Object.hasOwn(providers, name)) {
        return legacyFailure('provider_exists', '该供应商标识已被使用。');
      }
      if (request.action === 'update' && !Object.hasOwn(providers, name)) {
        return legacyFailure('not_found', '要编辑的供应商不存在。');
      }
      const current = providers[name] || null;
      const models = applyLegacyModelPatches(request.action === 'update' ? current?.models : [], draft.modelPatches);
      const config = {
        baseUrl: String(draft.connection?.baseUrl || ''),
        api: String(draft.connection?.api || 'openai-completions'),
        models,
      };
      if (request.credentialAction?.type === 'env') config.apiKey = request.credentialAction.reference;
      const result = await write(name, config);
      if (!result?.ok) return result || legacyFailure('unavailable', '保存失败。');
      pending.delete(request.draftId);
      return {
        ok: true,
        revision: legacyRevision(data),
        serviceId: name,
        saved: true,
        credentialSaved: null,
        credentialState: 'none',
        operationId: null,
        sync: { state: 'idle', reason: null },
        legacy: true,
        warning: result.warning || '',
      };
    },
  };
}

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

function closeMenu({ restoreFocus = false } = {}) {
  if (!menuCloser) return;
  const current = menuCloser;
  menuCloser = null;
  current.close({ restoreFocus });
}

function openMenu(row, menu, trigger) {
  closeMenu();
  menu.hidden = false;
  row.classList.add('menu-open');
  trigger.setAttribute('aria-expanded', 'true');
  let timer = null;
  let attached = false;
  const onDocumentClick = event => {
    // 触发按钮自己处理开/关；全局 closer 抢先把菜单关掉会让第二次点击
    // 变成“关了又开”，并让 aria-expanded 与真实可见状态相反。
    if (menu.contains(event.target) || trigger.contains(event.target)) return;
    closeMenu();
  };
  const onDocumentKey = event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    // 菜单打开时 Escape 属于菜单；否则弹窗的全局 Escape 处理会再把焦点移走。
    event.stopImmediatePropagation();
    closeMenu({ restoreFocus: true });
  };
  const close = ({ restoreFocus = false } = {}) => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    menu.hidden = true;
    row.classList.remove('menu-open');
    trigger.setAttribute('aria-expanded', 'false');
    if (attached) {
      attached = false;
      document.removeEventListener('click', onDocumentClick, true);
      window.removeEventListener('keydown', onDocumentKey, true);
    }
    if (restoreFocus && trigger.isConnected) trigger.focus();
  };
  menuCloser = { row, close };
  // 打开菜单的这次点击不能立刻被同一个 closer 关掉，因此延迟到本轮事件之后挂载。
  // keydown 挂在 window 捕获阶段：弹窗自己的 document 捕获处理器更早注册，
  // 若菜单不先拿到 Escape，弹窗会先关闭并把焦点还回去。
  timer = setTimeout(() => {
    timer = null;
    attached = true;
    document.addEventListener('click', onDocumentClick, true);
    window.addEventListener('keydown', onDocumentKey, true);
  }, 0);
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
  const name = service.displayName || service.serviceId;
  const ok = await confirmModal({
    title: service.readOnly ? '停用只读服务？' : '删除服务？',
    message: service.readOnly
      ? `内置或只读服务 ${name} 不会被真正删除；操作只会从 GUI 中停用并保留 Pi 配置。Pi 本机认证、auth.json 与环境变量都不会因此清除。`
      : `将从 GUI 移除 ${name}：内置服务只会停用并保留 Pi 配置，自定义服务会删除其 Pi 配置（含模型与配置内的密钥引用/字面量）。两种情况下都不会删除 Pi 本机认证（auth.json）或环境变量；如果删除可能回落到另一个内置端点，安全检查会拒绝本次操作。`,
    okText: service.readOnly ? '停用' : '删除',
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
  // 后端对内置服务是停用、对自定义服务是删除；不要用一句“已删除”覆盖两种语义。
  toast('服务变更已保存，等待 Runtime 同步。', 'info', { important: true });
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

async function openLegacyEdit(name) {
  const data = await fetchProviders().catch(() => null);
  if (!data || data.ok === false) {
    toast(data?.error || '无法读取供应商配置', 'error', { important: true });
    return;
  }
  const snapshot = legacySnapshot(data);
  const service = snapshot.services.find(item => item.serviceId === name);
  if (!service) {
    toast('这个供应商已经不存在；请刷新后重试。', 'error', { important: true });
    return;
  }
  openProviderDialog({
    present: openModal,
    snapshot,
    mode: 'edit',
    service,
    legacy: true,
    api: createLegacyProviderApi(),
    onSaved: () => {
      pageStatus('服务已保存；重载 pi 配置后生效。', 'info');
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
      if (menuCloser?.row === row) closeMenu();
      else openMenu(row, menu, more);
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
  const row = h('div', {
    class: 'prov',
    role: 'button',
    tabindex: '0',
    'aria-label': `编辑供应商 ${name}`,
    'data-service-name': name,
  },
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
  row.addEventListener('click', event => {
    if (event.target.closest('button')) return;
    openLegacyEdit(name);
  });
  row.addEventListener('keydown', event => {
    if (event.target !== row) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openLegacyEdit(name);
    }
  });
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
  closeMenu();
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
    pageStatus('管理接口未启用：当前使用兼容编辑器；保存后重载 pi 配置生效。', 'info');
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
    closeMenu();
    if (panels.providers === ownedBox) panels.providers = null;
    if (pageStatusHost === document.querySelector('.pm-page-status')) pageStatusHost = null;
  });
}

export async function openAddProvider({ present = openModal, snapshot = managementSnapshot } = {}) {
  let active = snapshot;
  if (!active) {
    // 页面加载与管理接口探测存在时间差；不要因为 snapshot 尚未写入就误判为兼容模式。
    const management = await fetchProviderManagement().catch(() => null);
    if (management?.ok === true && Array.isArray(management.services)) {
      managementSnapshot = management;
      legacyMode = false;
      active = management;
    } else if (!legacyMode) {
      // 还没确认管理接口不可用就探测失败：不能静默退回旧写入路径。
      toast('尚未确认供应商管理能力，请等待页面加载后重试。', 'error', { important: true });
      return;
    }
  }
  if (active) {
    openProviderDialog({
      present,
      snapshot: active,
      mode: 'create',
      onSaved: result => {
        if (result?.sync?.state === 'pending') pageStatus('服务已保存，等待 Runtime 同步（P3 尚未接通）。', 'info');
        refreshManagement();
      },
      onClosed: refreshManagement,
    });
    return;
  }
  const data = await fetchProviders().catch(() => null);
  if (!data || data.ok === false) {
    toast(data?.error || '无法读取供应商配置', 'error', { important: true });
    return;
  }
  openProviderDialog({
    present,
    snapshot: legacySnapshot(data),
    mode: 'create',
    legacy: true,
    api: createLegacyProviderApi(),
    onSaved: () => {
      pageStatus('服务已保存；重载 pi 配置后生效。', 'info');
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
  toast(`已移除供应商 ${name} 的 Pi 配置；Pi 本机认证与环境变量未改动。重载 pi 后生效。`, 'info', { important: true });
  await loadProviders();
}

export async function reloadPi() {
  await restartBackend();
  toast('正在重载 pi 配置…', 'info');
  clearThread();
}
