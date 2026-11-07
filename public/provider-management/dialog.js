/* 供应商管理弹窗。
 *
 * 一个壳，三种视图：服务选择 → 服务配置 → 高级设置；订阅服务直接进认证视图。
 * 真实可用的只有 snapshot / drafts / commit 与既有 OAuth；发现、测试、同步
 * 由 capabilities 门控，P4 一律显示「待接通」，不会用 fixture 成功态冒充连接。 */

import {
  fetchProviderManagement,
  saveProviderDraft,
  commitProviderDraft,
  authorizeProviderDiscovery,
  revokeProviderDiscovery,
  discoverProviderModels,
  testProviderConnection,
} from '../api.js';
import { confirmModal, openModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { mountProviderAuth } from '../provider-auth.js';
import {
  authenticateCatalog,
  catalogEndpointText,
  endpointLabel,
  isSubscription,
  normalizeCatalog,
  suggestProviderId,
} from './catalog.js';
import {
  commitCredentialAction,
  createDraftStore,
  draftFromCatalog,
  draftFromClone,
  draftFromService,
  effectiveAuthMode,
  ensureRequestId,
  needsBuiltinOverride,
  toDraftPayload,
  validateDraft,
} from './state.js';
import { renderServiceChooser } from './service-chooser.js';
import { renderConnectionFields } from './connection-fields.js';
import { renderModelPanes } from './model-panes.js';
import { renderAdvanced } from './advanced.js';
import {
  connectionTestSupported,
  createDiscoveryController,
  discoverySupported,
  discoveryUnavailableReason,
} from './discovery.js';
import { button, field, h, icon } from './dom.js';

const DEFAULT_API = Object.freeze({
  fetchProviderManagement,
  saveProviderDraft,
  commitProviderDraft,
  authorizeProviderDiscovery,
  revokeProviderDiscovery,
  discoverProviderModels,
  testProviderConnection,
});

const MODE_LABEL = Object.freeze({
  create: '新建服务',
  update: '编辑服务',
  clone: '复制为新服务',
});

function messageOf(result, fallback = '操作失败，请重试') {
  return (result && (result.message || result.error)) || fallback;
}

function isConflict(result) {
  return result && ['config_conflict', 'draft_conflict', 'provider_exists', 'credential_target_conflict', 'credential_conflict'].includes(result.code);
}

function serviceFromSnapshot(snapshot, id) {
  return (snapshot?.services || []).find(service => service.serviceId === id) || null;
}

function catalogForDraft(snapshot, draft) {
  return authenticateCatalog(normalizeCatalog(snapshot), snapshot)
    .find(item => item.id === (draft?.catalogId || '')) || null;
}

function firstFieldSelector(errors) {
  if (errors.displayName) return '[aria-label="服务名称"], [data-advanced-field="displayName"]';
  if (errors.providerId) return '.pm-provider-id';
  if (errors.connection || errors.connectionApi) return '[data-connection-base-url]';
  if (errors.envReference) return '.pm-env-input';
  if (errors.piRegistrationReference) return '[data-advanced-field="piRegistrationReference"]';
  return '';
}

export function openProviderDialog({
  present = openModal,
  snapshot = null,
  mode = 'create',
  service = null,
  item = null,
  onSaved = null,
  onClosed = null,
  api = DEFAULT_API,
} = {}) {
  const managementApi = { ...DEFAULT_API, ...api };
  let snapshotState = snapshot;
  let view = 'loading';
  let previousView = null;
  let draftStore = null;
  let draft = null;
  let draftHandle = null;
  let saving = false;
  let disposed = false;
  let closeCard = () => {};
  let bodyHost = null;
  let alertHost = null;
  let statusHost = null;
  let dialogCard = null;
  let connectionHost = null;
  let modelHost = null;
  let panes = null;
  let discovery = null;
  let unsubscribe = null;
  let errorState = null;
  let conflictState = null;
  let conflictLoading = false;
  let successState = null;
  let currentErrors = { errors: {}, modelErrors: {} };
  let authDispose = null;
  let lastSnapshotRead = 0;

  let titleNode = null;
  let subtitleNode = null;
  let advancedButton = null;
  let cancelButton = null;
  let saveButton = null;

  const cleanup = () => {
    disposed = true;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (discovery) { discovery.dispose(); discovery = null; }
    if (authDispose) { authDispose(); authDispose = null; }
  };

  const close = () => {
    if (saving) return;
    closeCard();
  };

  const refreshHeader = () => {
    if (!titleNode || !subtitleNode) return;
    if (view === 'chooser') {
      titleNode.textContent = '添加 AI 服务';
      subtitleNode.textContent = '选择一个服务开始配置；订阅账户通过 Pi 官方登录。';
      if (advancedButton) advancedButton.hidden = true;
      if (saveButton) saveButton.hidden = true;
      return;
    }
    if (view === 'auth') {
      titleNode.textContent = '订阅账户';
      subtitleNode.textContent = '状态来自 Pi 官方认证；这里不接收令牌。';
      if (advancedButton) advancedButton.hidden = true;
      if (saveButton) saveButton.hidden = true;
      return;
    }
    if (!draft) return;
    if (advancedButton) advancedButton.hidden = false;
    if (saveButton) {
      saveButton.hidden = false;
      saveButton.disabled = saving || draft.readOnly;
      saveButton.textContent = saving ? '保存中…' : '保存服务';
      saveButton.title = draft.readOnly ? '该服务由 Pi 内置配置管理，只读' : '';
    }
    if (view === 'advanced') {
      titleNode.textContent = '高级设置';
      subtitleNode.textContent = `${draft.displayName || draft.providerId} · ${MODE_LABEL[draft.mode] || '服务配置'}`;
      if (advancedButton) advancedButton.textContent = '返回配置';
      return;
    }
    titleNode.textContent = draft.mode === 'update' ? '编辑 AI 服务'
      : draft.mode === 'clone' ? '复制 AI 服务' : '添加 AI 服务';
    const dirty = draft.dirty ? ' · 未保存' : '';
    const count = `${draft.order.length} 个已选模型`;
    subtitleNode.textContent = `${draft.displayName || '未命名服务'}${dirty} · ${count}`;
    if (advancedButton) advancedButton.textContent = '高级设置';
  };

  const renderBanner = ({ tone = 'error', title, message, actions = [] } = {}) => {
    const banner = h('div', { class: `pm-status-banner is-${tone}`, role: tone === 'error' ? 'alert' : 'status' },
      icon(tone === 'error' ? 'alert' : tone === 'success' ? 'check' : 'info', 15),
      h('div', { class: 'pm-status-copy' },
        title ? h('div', { class: 'pm-status-title', text: title }) : null,
        message ? h('div', { class: 'pm-status-message', text: message }) : null,
      ),
      actions.length ? h('div', { class: 'pm-status-actions' }, ...actions) : null,
    );
    return banner;
  };

  const focusAfterValidation = () => {
    const selector = firstFieldSelector(currentErrors.errors);
    if (selector) {
      const target = document.querySelector(selector);
      if (target) { target.focus(); return; }
    }
    const firstModel = Object.keys(currentErrors.modelErrors || {})[0];
    if (firstModel && panes) {
      const toggle = panes.node.querySelector(`[data-model-advanced-toggle="${cssEscape(firstModel)}"]`);
      if (toggle) { if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click(); toggle.focus(); return; }
      panes.node.querySelector(`[data-model-check="${cssEscape(firstModel)}"]`)?.focus();
    }
  };

  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  const renderStatus = () => {
    if (!statusHost) return;
    statusHost.innerHTML = '';
    if (conflictState) {
      const actions = [];
      if (conflictLoading) {
        actions.push(h('span', { class: 'pm-status-loading', text: '正在读取最新配置…' }));
      } else {
        if (conflictState.canKeep) {
          actions.push(button('重读并继续', 'pm-btn pm-btn-small', () => reloadForContinue()));
        }
        if (conflictState.canReload) {
          actions.push(button('重新载入最新配置', 'pm-btn pm-btn-small pm-btn-danger-ghost', () => reloadLatestDraft()));
        }
        if (conflictState.canClone) {
          actions.push(button('保留草稿并复制为新服务', 'pm-btn pm-btn-small', () => retryAsClone()));
        }
        if (conflictState.canFixId) {
          actions.push(button('修改供应商标识', 'pm-btn pm-btn-small', () => {
            conflictState = null;
            renderStatus();
            document.querySelector('.pm-provider-id')?.focus();
          }));
        }
      }
      statusHost.appendChild(renderBanner({
        tone: 'error',
        title: conflictState.title || '配置已变化',
        message: conflictState.message,
        actions,
      }));
    }
    if (errorState) {
      statusHost.appendChild(renderBanner({
        tone: 'error',
        title: errorState.title || '保存失败',
        message: errorState.message,
      }));
    }
    if (successState) {
      statusHost.appendChild(renderBanner({
        tone: successState.tone || 'success',
        title: successState.title,
        message: successState.message,
      }));
    }
    if (draft?.readOnly) {
      statusHost.appendChild(renderBanner({
        tone: 'info',
        title: '只读服务',
        message: '该服务由 Pi 内置配置管理，当前只能查看；不会写入配置。',
      }));
    }
    if (draft?.inheritedSelection && !draft.touchedSelection && draft.mode === 'update') {
      statusHost.appendChild(renderBanner({
        tone: 'info',
        title: '当前模型集是继承的',
        message: '这个服务还没有固定已选模型。保存会把当前模型集固定为上方选择；零选择也是有效状态。',
      }));
    }
  };

  const syncChrome = () => {
    draft = draftStore ? draftStore.get() : draft;
    refreshHeader();
  };

  // 自定义服务的名称与地址在主区编辑；左侧服务卡随之更新，
  // 避免用户输入后仍看到旧名称或“自定义端点”。
  const syncServiceChip = () => {
    if (!connectionHost || !draft || view !== 'setup') return;
    const item = catalogForDraft(snapshotState, draft);
    const cloning = draft.mode === 'clone';
    const subscription = !cloning && (draft.authMode === 'oauth' || isSubscription(item));
    const name = connectionHost.querySelector('.pm-service-chip-name');
    if (name) name.textContent = draft.displayName || draft.providerId || '未命名服务';
    const detail = connectionHost.querySelector('.pm-service-chip-detail');
    if (!detail) return;
    detail.textContent = cloning
      ? '复制为新服务 · 不携带凭据'
      : subscription
        ? (item?.auth?.status === 'connected' ? '订阅账户 · 已连接' : '订阅账户 · 使用 Pi 登录')
        : endpointLabel(draft.connection) || catalogEndpointText(item || {}) || '自定义端点';
  };

  function focusSetup() {
    if (!panes && !connectionHost) return;
    const target = document.querySelector('.pm-model-row input, [data-model-advanced-toggle], [data-custom-model-input], .pm-service-chip button');
    target?.focus();
  }

  function disposeDiscovery() {
    if (discovery) { discovery.dispose(); discovery = null; }
  }

  function rebuildConnection() {
    if (!connectionHost || !draft) return;
    connectionHost.innerHTML = '';
    const item = catalogForDraft(snapshotState, draft);
    connectionHost.appendChild(renderConnectionFields({
      draft,
      snapshot: snapshotState,
      item,
      errors: currentErrors.errors || {},
      onDispatch: action => draftStore.dispatch(action),
      onChangeService: () => changeService(),
      onOpenAuth: () => {
        const providerId = item?.providerId || draft.providerId;
        showAuth(providerId);
      },
      onCredentialTrigger: () => {
        successState = {
          tone: 'info',
          title: '安全凭据输入',
          message: '桌面凭据窗口由 P2 提供；当前构建只保留触发器，不会在主页面创建密钥输入框。',
        };
        renderStatus();
      },
      onClearCredential: () => clearCredential(),
    }));
  }

  function createDiscovery() {
    if (!draft) return null;
    const supported = discoverySupported(snapshotState);
    const controller = createDiscoveryController({
      api: managementApi,
      supported,
      debounceMs: 600,
    });
    controller.configure({
      supported,
      draftId: draftHandle?.draftId || null,
      draftRevision: draftHandle?.draftRevision || null,
      dialogGeneration: 1,
      connectionRevision: JSON.stringify([draft.connection?.baseUrl, draft.connection?.api]),
      models: draft.models.map(model => ({ modelId: model.modelId, name: model.name || '' })),
    });
    controller.subscribe(state => {
      if (!panes) return;
      panes.setDiscovery(state);
      if (state.status === 'unsupported' && !successState) {
        // 状态条里只说明一次；不把 unsupported 当成错误弹窗。
      }
    });
    return controller;
  }

  function renderSetup(nextDraft = draft) {
    if (!nextDraft) return;
    view = 'setup';
    draft = nextDraft;
    disposeDiscovery();
    successState = null;
    conflictState = null;
    currentErrors = { errors: {}, modelErrors: {} };
    bodyHost.innerHTML = '';
    const setup = h('div', { class: 'pm-setup' });
    connectionHost = h('div', { class: 'pm-connection-host' });
    modelHost = h('div', { class: 'pm-model-host' });
    setup.append(connectionHost, modelHost);
    bodyHost.appendChild(setup);
    rebuildConnection();

    const item = catalogForDraft(snapshotState, draft);
    panes = renderModelPanes({
      draft,
      dispatch: action => draftStore.dispatch(action),
      errors: currentErrors.modelErrors,
      capabilities: snapshotState?.capabilities || {},
      discovery: discovery?.getState(),
      onRefresh: payload => {
        if (!discovery) return;
        if (!discoverySupported(snapshotState)) return;
        discovery.refresh(payload);
      },
      onAuthorize: () => {
        if (!discovery) return;
        discovery.authorize({ rememberTarget: false });
      },
      onRemove: model => confirmRemoveModel(model),
      onDraftChange: () => syncChrome(),
    });
    modelHost.appendChild(panes.node);
    discovery = createDiscovery();
    panes.setDiscovery(discovery.getState());
    syncChrome();
    renderStatus();
    focusAfterSetup();
  }

  function focusAfterSetup() {
    const credential = document.querySelector('#pmCredentialTrigger:not([disabled])');
    if (credential) { credential.focus(); return; }
    const first = document.querySelector('.pm-model-row input, [data-custom-model-input], .pm-service-chip .pm-change-service');
    first?.focus();
  }

  function openDraft(nextDraft) {
    draft = nextDraft;
    draftHandle = null;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (draftStore) draftStore = null;
    draftStore = createDraftStore(nextDraft);
    unsubscribe = draftStore.subscribe(state => {
      draft = state;
      refreshHeader();
      syncServiceChip();
      if (discovery && view === 'setup') {
        discovery.configure({
          supported: discoverySupported(snapshotState),
          draftId: draftHandle?.draftId || null,
          draftRevision: draftHandle?.draftRevision || null,
          dialogGeneration: 1,
          connectionRevision: JSON.stringify([state.connection?.baseUrl, state.connection?.api]),
          models: state.models.map(model => ({ modelId: model.modelId, name: model.name || '' })),
        });
      }
    });
    renderSetup(nextDraft);
  }

  function showAdvanced() {
    if (!draft) return;
    view = 'advanced';
    disposeDiscovery();
    bodyHost.innerHTML = '';
    bodyHost.appendChild(renderAdvanced({
      draft,
      snapshot: snapshotState,
      errors: currentErrors.errors || {},
      onDispatch: action => draftStore.dispatch(action),
      onBack: () => renderSetup(draftStore.get()),
    }));
    syncChrome();
    renderStatus();
    document.querySelector('[data-advanced-field="displayName"]')?.focus();
  }

  function showChooser({ returnToSetup = false } = {}) {
    if (!snapshotState) { loadSnapshot(); return; }
    view = 'chooser';
    previousView = returnToSetup ? 'setup' : null;
    successState = null;
    conflictState = null;
    disposeDiscovery();
    bodyHost.innerHTML = '';
    const chooser = renderServiceChooser({
      snapshot: snapshotState,
      selectedId: draft?.catalogId || null,
      onPick: picked => {
        if (isSubscription(picked)) {
          showAuth(picked.providerId);
          return;
        }
        const existingIds = (snapshotState.services || []).map(service => service.providerId);
        const next = draftFromCatalog(snapshotState, picked, { existingIds });
        openDraft(next);
      },
      onUnavailable: picked => {
        // 选择器内部已经显示原因；这里不做任何登录或网络操作。
      },
    });
    bodyHost.appendChild(chooser.node);
    if (statusHost) statusHost.innerHTML = '';
    refreshHeader();
    chooser.focusSearch();
  }

  function showAuth(providerId) {
    view = 'auth';
    previousView = null;
    disposeDiscovery();
    if (authDispose) { authDispose(); authDispose = null; }
    bodyHost.innerHTML = '';
    const authBox = h('div', { class: 'pm-auth-view', 'data-auth-provider': providerId || '' });
    authBox.appendChild(h('div', { class: 'pm-auth-intro' },
      icon('lock', 16),
      h('div', {},
        h('div', { class: 'pm-auth-title', text: 'Pi 官方认证' }),
        h('div', { class: 'pm-auth-sub', text: '以下状态是真实读取；登录、退出与授权回复都由 Pi 处理，页面不接触令牌。' }),
      ),
    ));
    const mount = h('div', { class: 'pm-auth-mount' });
    authBox.appendChild(mount);
    bodyHost.appendChild(authBox);
    if (statusHost) statusHost.innerHTML = '';
    try {
      authDispose = mountProviderAuth(mount, () => {
        successState = {
          tone: 'success',
          title: '认证状态已更新',
          message: '已重新读取 Pi 的认证状态；服务列表会在关闭后刷新。',
        };
        onSaved?.({ authChanged: true, providerId });
        renderStatus();
      });
    } catch {
      authBox.appendChild(renderBanner({ tone: 'error', title: '无法加载认证视图', message: '请关闭后重试。' }));
    }
    refreshHeader();
    mount.querySelector('button')?.focus();
  }

  function changeService() {
    if (!draft) return;
    if (!snapshotState) { loadSnapshot(); return; }
    if (draft.mode === 'create') {
      if (draft.dirty) {
        confirmModal({
          title: '更换服务？',
          message: '当前草稿还没有保存；更换服务会丢弃这些改动。',
          okText: '更换服务',
          cancelText: '继续编辑',
          danger: true,
        }).then(ok => { if (ok) showChooser({ returnToSetup: true }); });
        return;
      }
      showChooser({ returnToSetup: true });
      return;
    }
    confirmModal({
      title: '更换服务？',
      message: '编辑现有服务不能更换身份。继续会开始一个新的服务草稿；原服务不会被修改。',
      okText: '开始新草稿',
      cancelText: '取消',
      danger: true,
    }).then(ok => { if (ok) showChooser({ returnToSetup: true }); });
  }

  function clearCredential() {
    if (!draft || draft.readOnly) return;
    confirmModal({
      title: '清除凭据？',
      message: '保存后 Pi 配置里的 apiKey 会被删除。若凭据来自环境变量或 Pi 本机认证，服务可能立即不可用。',
      okText: '保存时清除',
      cancelText: '保留',
      danger: true,
    }).then(ok => {
      if (!ok) return;
      draftStore.dispatch({ type: 'clear-credential' });
      rebuildConnection();
      renderStatus();
    });
  }

  function confirmRemoveModel(model) {
    if (!draft) return;
    confirmModal({
      title: '移除模型配置？',
      message: `将从 ${draft.displayName || draft.providerId} 的 Pi 配置中移除 ${model.modelId}。这不会删除凭据，也不会改变其它服务。`,
      okText: '移除',
      cancelText: '保留',
      danger: true,
    }).then(ok => {
      if (!ok) return;
      draftStore.dispatch({ type: 'remove-model', modelId: model.modelId });
      panes?.update(draftStore.get(), { errors: currentErrors.modelErrors, discovery: discovery?.getState() });
      syncChrome();
    });
  }

  function validationFailure(validation) {
    currentErrors = validation;
    saveButton.disabled = false;
    if (panes) panes.setErrors(validation.modelErrors);
    rebuildConnection();
    const modelCount = Object.keys(validation.modelErrors || {}).length;
    const fieldCount = Object.keys(validation.errors || {}).length;
    errorState = {
      title: '请先修正配置',
      message: `还有 ${fieldCount + modelCount} 处需要处理。${Object.values(validation.errors || {})[0] || ''}`,
    };
    renderStatus();
    focusAfterValidation();
  }

  async function save() {
    if (!draft || saving) return;
    if (draft.readOnly) return;
    saving = true;
    errorState = null;
    conflictState = null;
    successState = null;
    refreshHeader();
    dialogCard?.setAttribute('aria-busy', 'true');
    try {
      const validation = validateDraft(draft);
      if (!validation.ok) {
        saving = false;
        dialogCard?.removeAttribute('aria-busy');
        validationFailure(validation);
        return;
      }
      currentErrors = validation;
      if (needsBuiltinOverride(draft)) {
        const ok = await confirmModal({
          title: '覆盖内置模型配置？',
          message: '保存会为 Pi 内置模型写入覆盖项。原内置定义不会被删除，但同名配置会以这里的值为准。',
          okText: '继续保存',
          cancelText: '返回检查',
        });
        if (!ok) {
          saving = false;
          dialogCard?.removeAttribute('aria-busy');
          refreshHeader();
          return;
        }
        draftStore.dispatch({ type: 'builtin-override' });
        draft = draftStore.get();
      }
      let payload;
      try {
        payload = toDraftPayload(draft);
      } catch {
        saving = false;
        dialogCard?.removeAttribute('aria-busy');
        errorState = { title: '配置不完整', message: '请检查 Base URL、服务名称与模型参数。' };
        renderStatus();
        return;
      }
      const action = draft.mode === 'update' ? 'update' : draft.mode === 'clone' ? 'clone' : 'create';
      const payloadSignature = JSON.stringify(payload);
      // 同一内容重试时复用草稿，避免把一个已经成功的草稿再写一遍；
      // requestId 由草稿持有，传输失败后重传仍是同一请求。
      if (!draftHandle || draftHandle.payloadSignature !== payloadSignature) {
        const draftRequest = {
          expectedRevision: snapshotState.revision,
          draft: payload,
        };
        if (draft.mode !== 'create') draftRequest.serviceId = draft.sourceServiceId;
        if (draftHandle) {
          draftRequest.draftId = draftHandle.draftId;
          draftRequest.expectedDraftRevision = draftHandle.draftRevision;
        }
        draftRequest.requestId = ensureRequestId(draft, 'draft', JSON.stringify(draftRequest));
        const draftResult = await managementApi.saveProviderDraft(draftRequest);
        if (!draftResult?.ok) {
          await handleFailure(draftResult, 'draft');
          return;
        }
        draftHandle = {
          draftId: draftResult.draftId,
          draftRevision: draftResult.draftRevision,
          payloadSignature,
        };
      }
      if (discovery) {
        discovery.configure({
          supported: discoverySupported(snapshotState),
          draftId: draftHandle.draftId,
          draftRevision: draftHandle.draftRevision,
          dialogGeneration: 1,
          connectionRevision: JSON.stringify([draft.connection?.baseUrl, draft.connection?.api]),
          models: draft.models.map(model => ({ modelId: model.modelId, name: model.name || '' })),
        });
      }
      const commitBody = {
        action,
        expectedRevision: snapshotState.revision,
        draftId: draftHandle.draftId,
        draftRevision: draftHandle.draftRevision,
        credentialAction: commitCredentialAction(draft),
      };
      if (draft.mode !== 'create') commitBody.serviceId = draft.sourceServiceId;
      const request = {
        requestId: ensureRequestId(draft, 'commit', JSON.stringify(commitBody)),
        ...commitBody,
      };
      const result = await managementApi.commitProviderDraft(request);
      if (!result?.ok) {
        await handleFailure(result, 'commit');
        return;
      }
      saving = false;
      dialogCard?.removeAttribute('aria-busy');
      draftStore.dispatch({ type: 'mark-saved', state: result.sync?.state === 'pending' ? 'saved-pending-sync' : 'saved' });
      onSaved?.(result);
      if (result.credentialSaved === false || result.credentialState === 'error') {
        successState = {
          tone: 'error',
          title: '配置已保存，但凭据没有保存',
          message: '配置事务已提交；凭据部分需要 P2 桌面窗口重新处理。草稿仍保留在这里。',
        };
        renderStatus();
        refreshHeader();
        return;
      }
      // 保存结果必须可见：info/success 默认不弹 toast，这里显式标成 important。
      if (result.sync?.state === 'pending') toast('服务已保存，等待 Runtime 同步。', 'info', { important: true });
      else toast('服务已保存。', 'success', { important: true });
      close();
    } catch {
      saving = false;
      dialogCard?.removeAttribute('aria-busy');
      errorState = { title: '保存失败', message: '请求没有完成；草稿还在，可以重试。' };
      renderStatus();
      refreshHeader();
    }
  }

  async function handleFailure(result, phase) {
    saving = false;
    dialogCard?.removeAttribute('aria-busy');
    refreshHeader();
    if (phase === 'draft' && result?.code === 'draft_conflict') {
      draftHandle = null;
      if (draft) { draft.requestIds = {}; draft.requestIdKeys = {}; }
      errorState = { title: '草稿已过期', message: '已保留当前内容；再次保存会重新创建草稿。' };
      renderStatus();
      return;
    }
    if (isConflict(result)) {
      await handleConflict(result);
      return;
    }
    if (result?.code === 'unsupported') {
      errorState = { title: '此能力尚未开放', message: messageOf(result) };
      renderStatus();
      return;
    }
    if (result?.network) {
      errorState = { title: '网络连接失败', message: '草稿没有丢失，可以重试。' };
      renderStatus();
      return;
    }
    const fieldMessages = result?.fieldErrors ? Object.values(result.fieldErrors).filter(Boolean) : [];
    errorState = {
      title: '保存失败',
      message: messageOf(result) + (fieldMessages.length ? `（${fieldMessages.join('；')}）` : ''),
    };
    renderStatus();
  }

  async function readLatestSnapshot() {
    try {
      const result = await managementApi.fetchProviderManagement();
      if (result?.ok && typeof result.revision === 'string' && result.revision) {
        snapshotState = result;
        lastSnapshotRead += 1;
        return result;
      }
    } catch { /* 保留旧快照，界面明确说明 */ }
    return null;
  }

  async function handleConflict(result) {
    conflictState = {
      code: result.code,
      title: result.code === 'provider_exists' ? '供应商标识已被使用' : '配置已变化',
      message: messageOf(result),
      canKeep: false,
      canReload: false,
      canClone: false,
      canFixId: result.code === 'provider_exists',
    };
    if (result.code === 'provider_exists') {
      renderStatus();
      document.querySelector('.pm-provider-id')?.focus();
      return;
    }
    conflictLoading = true;
    renderStatus();
    const latest = await readLatestSnapshot();
    conflictLoading = false;
    if (!latest) {
      conflictState.message = `${conflictState.message} 无法读取最新配置；草稿保留，可稍后重试。`;
      renderStatus();
      return;
    }
    // 最新 revision 已读到，旧草稿句柄不能再用于下一次提交。
    // 下一次保存会按新 revision 重新创建草稿并轮换 requestId。
    draftHandle = null;
    if (draft) { draft.requestIds = {}; draft.requestIdKeys = {}; }
    const source = draft?.sourceServiceId ? serviceFromSnapshot(latest, draft.sourceServiceId) : null;
    if (result.code === 'credential_target_conflict' || result.code === 'credential_conflict') {
      conflictState.title = '端点与凭据目标冲突';
      conflictState.canClone = Boolean(draft?.sourceServiceId) && !draft?.readOnly;
      conflictState.canFixId = !draft?.sourceServiceId && Boolean(document.querySelector('.pm-provider-id'));
      conflictState.message = conflictState.canClone
        ? '已有认证的服务不能直接更换端点。请保留草稿并复制为新服务，或先清除凭据。'
        : conflictState.canFixId
          ? '这个目标已有认证凭据，当前草稿也没有可复制的来源服务。请修改供应商标识，或先清除原服务的凭据。'
          : '这个目标已有认证凭据，当前草稿也没有可复制的来源服务。请返回选择其它服务，或先清除原服务的凭据。';
      renderStatus();
      return;
    }
    if (draft?.mode === 'update') {
      if (!source) {
        conflictState.title = '原服务已不存在';
        conflictState.message = '最新配置里找不到这个服务。你的草稿还在，可以复制为新服务。';
        conflictState.canClone = !draft.readOnly;
      } else if (sourceUnchanged(draft, source)) {
        conflictState.title = '配置版本已更新';
        conflictState.message = '服务本身没有变化，只是读取版本更新了。可以保留当前草稿继续保存。';
        conflictState.canKeep = true;
      } else {
        conflictState.message = '服务在别处被修改过。重新载入会放弃当前改动；也可以把当前草稿复制成新服务。';
        conflictState.canReload = true;
        conflictState.canClone = !draft.readOnly;
      }
    } else if (draft?.mode === 'create') {
      conflictState.title = '保存时发现版本变化';
      conflictState.message = '供应商标识没有被占用；最新配置已读取，可以重试。';
      conflictState.canKeep = true;
    } else if (draft?.mode === 'clone') {
      conflictState.canReload = Boolean(source);
      conflictState.canClone = Boolean(source);
      conflictState.message = '源服务已变化。重新载入会重置草稿；也可以保留当前改动并换一个标识复制。';
    }
    renderStatus();
  }

  function sourceUnchanged(draftState, source) {
    const before = draftState.sourceState;
    if (!before) return false;
    const latestOrder = Array.isArray(source.modelOrder)
      ? source.modelOrder
      : Array.isArray(source.selectedModelIds) ? source.selectedModelIds : source.models.map(model => model.modelId);
    const currentModels = source.models.map(model => {
      const overrides = model.editableOverrides || {};
      return JSON.stringify({
        modelId: model.modelId,
        name: overrides.name ?? null,
        contextWindow: overrides.contextWindow ?? null,
        maxTokens: overrides.maxTokens ?? null,
        reasoning: overrides.reasoning ?? null,
        input: overrides.input ?? null,
      });
    }).sort();
    const beforeModels = (before.models || []).map(model => JSON.stringify({
      modelId: model.modelId,
      name: model.name ?? null,
      contextWindow: model.contextWindow ?? null,
      maxTokens: model.maxTokens ?? null,
      reasoning: model.reasoning ?? null,
      input: model.input ?? null,
    })).sort();
    return before.displayName === source.displayName
      && before.connection?.baseUrl === source.connection?.baseUrl
      && before.connection?.api === source.connection?.api
      && before.authMode === source.authMode
      && before.enabled === source.enabled
      && JSON.stringify(before.order) === JSON.stringify(latestOrder)
      && JSON.stringify(beforeModels) === JSON.stringify(currentModels);
  }

  async function reloadForContinue() {
    if (!draft || !snapshotState) return;
    const latest = await readLatestSnapshot();
    if (!latest) {
      conflictState.message = '仍然无法读取最新配置，请稍后再试。';
      renderStatus();
      return;
    }
    conflictState = null;
    draftHandle = null;
    if (draft) { draft.requestIds = {}; draft.requestIdKeys = {}; }
    errorState = null;
    renderStatus();
    refreshHeader();
    toast('已读取最新版本，可以再次保存。', 'info');
  }

  async function reloadLatestDraft() {
    if (!draft || !snapshotState) return;
    const ok = await confirmModal({
      title: '重新载入最新配置？',
      message: '当前未保存的改动会丢失。',
      okText: '重新载入',
      cancelText: '保留草稿',
      danger: true,
    });
    if (!ok) return;
    const latest = await readLatestSnapshot();
    if (!latest) return;
    const source = serviceFromSnapshot(latest, draft.sourceServiceId);
    if (!source) {
      errorState = { title: '服务已不存在', message: '无法重新载入；可以关闭后从服务列表重新开始。' };
      conflictState = null;
      renderStatus();
      return;
    }
    if (draft.mode === 'clone') {
      const existingIds = (latest.services || []).map(service => service.providerId);
      openDraft(draftFromClone(source, latest, suggestProviderId(`${source.providerId}-copy`, existingIds, 'copy')));
    } else {
      openDraft(draftFromService(source, latest, 'edit'));
    }
  }

  function retryAsClone() {
    if (!draft) return;
    const existingIds = (snapshotState.services || []).map(service => service.providerId);
    const providerId = suggestProviderId(`${draft.providerId || draft.sourceServiceId || 'service'}-copy`, existingIds, 'copy');
    const next = {
      ...draft,
      mode: 'clone',
      sourceServiceId: draft.sourceServiceId,
      serviceId: null,
      providerId,
      displayName: `${draft.displayName || draft.providerId} 副本`.slice(0, 200),
      authMode: 'none',
      envReference: '',
      piRegistrationReference: '',
      credentialAction: { type: 'keep' },
      credentialState: { state: 'none', source: 'none' },
      confirmBuiltinOverride: false,
      initialSignature: '',
      requestIds: {},
    };
    if (!next.sourceServiceId) {
      errorState = { title: '无法复制', message: '找不到源服务标识。' };
      conflictState = null;
      renderStatus();
      return;
    }
    openDraft(next);
  }

  function requestCancel() {
    if (saving) return;
    if (view === 'advanced') { renderSetup(draftStore.get()); return; }
    if (view === 'chooser' && previousView === 'setup' && draft) { renderSetup(draft); return; }
    if (view === 'auth') { close(); return; }
    if (!draft || !draft.dirty) { close(); return; }
    confirmModal({
      title: '放弃未保存的更改？',
      message: '关闭后这些改动不会写入 Pi 配置。',
      okText: '放弃更改',
      cancelText: '继续编辑',
      danger: true,
    }).then(ok => { if (ok) close(); });
  }

  function loadSnapshot() {
    view = 'loading';
    bodyHost.innerHTML = '';
    bodyHost.appendChild(h('div', { class: 'pm-dialog-loading' },
      h('div', { class: 'pm-spinner', 'aria-hidden': 'true' }),
      h('div', { text: '正在读取供应商配置…' }),
    ));
    managementApi.fetchProviderManagement().then(result => {
      if (disposed) return;
      if (!result?.ok) {
        bodyHost.innerHTML = '';
        bodyHost.appendChild(renderBanner({
          tone: 'error',
          title: '无法读取供应商配置',
          message: messageOf(result, '供应商管理接口不可用。'),
          actions: [button('重试', 'pm-btn pm-btn-small', loadSnapshot)],
        }));
        return;
      }
      snapshotState = result;
      start();
    }).catch(() => {
      if (!disposed) loadSnapshotFailure();
    });
  }

  function loadSnapshotFailure() {
    bodyHost.innerHTML = '';
    bodyHost.appendChild(renderBanner({
      tone: 'error',
      title: '无法读取供应商配置',
      message: '请求没有完成，请重试。',
      actions: [button('重试', 'pm-btn pm-btn-small', loadSnapshot)],
    }));
  }

  function start() {
    if (!snapshotState) { loadSnapshot(); return; }
    const existingIds = (snapshotState.services || []).map(service => service.providerId);
    if (mode === 'auth') {
      showAuth(service?.providerId || item?.providerId || 'openai');
      return;
    }
    if (mode === 'create' && !item) {
      showChooser();
      return;
    }
    if (mode === 'create' && item) {
      if (isSubscription(item)) { showAuth(item.providerId); return; }
      openDraft(draftFromCatalog(snapshotState, item, { existingIds }));
      return;
    }
    if (mode === 'edit' && service) {
      if (service.authMode === 'oauth' || !service.connection) {
        showAuth(service.providerId);
        return;
      }
      openDraft(draftFromService(service, snapshotState, 'edit'));
      return;
    }
    if (mode === 'clone' && service) {
      if (service.authMode === 'oauth' || service.readOnly) {
        view = 'error';
        bodyHost.innerHTML = '';
        bodyHost.appendChild(renderBanner({
          tone: 'error',
          title: '这个服务不能复制',
          message: service.readOnly ? '内置或只读服务不能复制。' : '订阅账户不能复制；请直接登录。',
        }));
        refreshHeader();
        return;
      }
      openDraft(draftFromClone(service, snapshotState, suggestProviderId(`${service.providerId}-copy`, existingIds, 'copy')));
      return;
    }
    view = 'error';
    bodyHost.innerHTML = '';
    bodyHost.appendChild(renderBanner({
      tone: 'error',
      title: '找不到要编辑的服务',
      message: '它可能已经被删除。请关闭后刷新服务列表。',
    }));
    refreshHeader();
  }

  present((card, close) => {
    closeCard = close;
    dialogCard = card;
    card.classList.add('pm-dialog-card');
    card.setAttribute('aria-labelledby', 'pmDialogTitle');
    card.innerHTML = '';
    titleNode = h('h2', { class: 'pm-dialog-title', id: 'pmDialogTitle', text: '供应商' });
    subtitleNode = h('div', { class: 'pm-dialog-subtitle' });
    advancedButton = button('高级设置', 'pm-btn pm-btn-ghost pm-advanced-entry', () => {
      if (view === 'advanced') renderSetup(draftStore.get()); else showAdvanced();
    });
    cancelButton = button('取消', 'pm-btn pm-btn-ghost', requestCancel);
    saveButton = button('保存服务', 'pm-btn pm-primary', save);
    const header = h('header', { class: 'pm-dialog-head' },
      h('div', { class: 'pm-dialog-heading' }, titleNode, subtitleNode),
      h('div', { class: 'pm-dialog-actions' }, advancedButton, cancelButton, saveButton),
    );
    bodyHost = h('div', { class: 'pm-dialog-body' });
    alertHost = h('div', { class: 'pm-alert-host' });
    statusHost = alertHost;
    card.append(h('div', { class: 'pm-dialog' }, header, alertHost, bodyHost));
    if (snapshotState) start(); else loadSnapshot();
  }, () => {
    cleanup();
    try { onClosed?.(); } catch { /* 页面刷新失败不影响关闭 */ }
  }, {
    className: 'pm-dialog-card',
    onCancel: requestCancel,
    labelledBy: 'pmDialogTitle',
  });
}
