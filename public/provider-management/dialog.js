/* 供应商管理弹窗。
 *
 * 一个壳，三种视图：服务选择 → 服务配置 → 高级设置；订阅服务直接进认证视图。
 * 真实可用的只有 snapshot / drafts / commit 与既有 OAuth；发现、测试、同步
 * 由 capabilities 门控，P4 一律显示「待接通」，不会用 fixture 成功态冒充连接。 */

import {
  fetchProviderManagement,
  fetchProviderServiceCache,
  saveProviderDraft,
  commitProviderDraft,
  authorizeProviderDiscovery,
  revokeProviderDiscovery,
  discoverProviderModels,
  testProviderConnection,
  fetchProviderOperation,
  cancelProviderOperation,
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
  credentialClearSupport,
  draftFromCatalog,
  draftFromClone,
  draftFromService,
  effectiveAuthMode,
  ensureRequestId,
  newRequestId,
  needsBuiltinOverride,
  needsInheritedSelectionConfirmation,
  toDraftPayload,
  validateDraft,
} from './state.js';
import { renderServiceChooser } from './service-chooser.js';
import { renderConnectionFields } from './connection-fields.js';
import { renderModelPanes } from './model-panes.js';
import { renderAdvanced } from './advanced.js';
import {
  createDiscoveryController,
  discoveryModes,
  discoverySupported,
  discoverySupportsAuth,
  discoveryUnavailableReason,
} from './discovery.js';
import { createCredentialController, desktopCredentialBridge } from './credentials.js';
import { recommendModels } from './recommend.js';
import { button, field, h, icon } from './dom.js';

const DEFAULT_API = Object.freeze({
  fetchProviderManagement,
  fetchProviderServiceCache,
  saveProviderDraft,
  commitProviderDraft,
  authorizeProviderDiscovery,
  revokeProviderDiscovery,
  discoverProviderModels,
  testProviderConnection,
  fetchProviderOperation,
  cancelProviderOperation,
});

const MODE_LABEL = Object.freeze({
  create: '新建服务',
  update: '编辑服务',
  clone: '复制为新服务',
});

/* 跨弹窗实例的活跃草稿登记。
 *
 * 迟到的草稿响应只能撤销它自己创建的服务端草稿。新弹窗可能正在使用同一个
 * 标识（测试夹具或幂等重放都可能复用），所以清理前必须确认没有任何活动
 * 流程仍持有它；否则旧响应会把新流程的暂存凭据一起删掉。 */
const liveDraftOwners = new Map();
function retainLiveDraft(draftId) {
  if (!draftId) return;
  liveDraftOwners.set(draftId, (liveDraftOwners.get(draftId) || 0) + 1);
}
function releaseLiveDraft(draftId) {
  if (!draftId) return;
  const count = (liveDraftOwners.get(draftId) || 0) - 1;
  if (count > 0) liveDraftOwners.set(draftId, count);
  else liveDraftOwners.delete(draftId);
}
function liveDraftInUse(draftId) {
  return Boolean(draftId) && (liveDraftOwners.get(draftId) || 0) > 0;
}

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
  legacy = false,
  onSaved = null,
  onClosed = null,
  intent = null,
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
  /* 缓存首屏（FIX-01）：草稿保存响应里的匹配缓存候选只做展示合并；
   * 不改变选择/顺序，且同一目标只合并一次（避免刷新后复活已移除项）。 */
  let cacheNote = null;
  let cacheMergedIds = new Set();
  let cacheKey = '';
  let cacheBootstrapKey = '';
  /* FIX-A：首次推荐只在「新建草稿 + 用户未改过选择 + 首次新鲜远端结果」时
   * 发生一次。recommendedKey 绑定服务目标，换端点/协议后旧推荐作废。 */
  let recommendation = null;
  let recommendedKey = '';
  let recommendedHandled = false;
  let autoPickedIds = new Set();
  let currentErrors = { errors: {}, modelErrors: {} };
  let authDispose = null;
  let lastSnapshotRead = 0;
  // P5：受限窗控制器与目标指纹。任何目标/认证来源变化都要撤销服务端暂存与授权。
  const credentials = legacy ? null : createCredentialController();
  let credentialBusy = false;
  // 草稿写请求串行化：同一时刻只能有一个在途保存，避免两个调用互相覆盖
  // draftHandle、用旧 revision 写同一个草稿。
  let draftSaveChain = Promise.resolve();
  let targetSignature = draftTargetSignature(null);
  let authSignature = '';
  // 每次撤销草稿/换目标/关闭弹窗都递增。所有跨 await 的旧响应必须核对
  // 这个代次，不能把旧目标的服务端句柄或凭据暂存写回当前界面。
  let lifecycleEpoch = 0;
  // 从服务列表菜单进入「测试连接」时，打开弹窗后自动走一次授权 + 测试。
  let pendingTestIntent = intent === 'test';

  let titleNode = null;
  let subtitleNode = null;
  let advancedButton = null;
  let cancelButton = null;
  let saveButton = null;

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    // 关闭弹窗后，所有在途的草稿保存、凭据窗口与发现请求都失效。
    revokeDraftArtifacts();
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (discovery) {
      const controller = discovery;
      discovery = null;
      // revokeDraftArtifacts 已发起服务端撤销；这里只停止本地轮询。
      controller.dispose();
    }
    credentials?.dispose();
    if (authDispose) { authDispose(); authDispose = null; }
  };

  function draftTargetSignature(value) {
    if (!value) return '';
    return JSON.stringify([value.providerId, value.connection || null, effectiveAuthMode(value),
      String(value.envReference || '').trim(), String(value.piRegistrationReference || '').trim()]);
  }

  /* 模型目录跟着端点/供应商标识走；认证来源变化不改变目录，只影响推荐是否
   * 还成立（由 recommendationKeyFor 处理）。 */
  function modelTargetSignature(value) {
    if (!value) return '';
    return JSON.stringify([value.providerId || '', value.connection || null]);
  }

  /* 只清理迟到的服务端草稿；新流程（本弹窗或另一个弹窗）仍持有该标识时
   * 绝不撤销，否则会把用户刚暂存的凭据一起删掉。 */
  function closeLateDraft(draftId) {
    if (!draftId || liveDraftInUse(draftId)) return;
    try { void credentials?.closeDraft(draftId); } catch { /* best effort */ }
  }

  function cacheIdentity() {
    /* 凭据引用与清除意图也算身份：服务端缓存按当前权威凭据代次查询，
     * 草稿改了引用/清除后，迟到的旧代次响应不得再并入。 */
    return JSON.stringify([draft?.providerId || '', draft?.connection?.baseUrl || '',
      draft?.connection?.api || '', effectiveAuthMode(draft),
      String(draft?.envReference || '').trim(), draft?.credentialAction?.type || 'keep',
      draft?.nativeStage ? [draft.nativeStage.action || '', draft.nativeStage.draftId || ''] : '']);
  }

  function resetCacheState() {
    cacheNote = null;
    cacheMergedIds = new Set();
    cacheKey = '';
  }

  function recommendationKeyFor(value) {
    if (!value) return '';
    /* 认证来源也是推荐上下文：换 env 引用/本机注册引用会改变 Pi 实际读取的
     * 凭据，同一端点的目录结果不再能代表新目标。 */
    return JSON.stringify([value.providerId || '', value.connection?.baseUrl || '', value.connection?.api || '',
      effectiveAuthMode(value), String(value.envReference || '').trim(), String(value.piRegistrationReference || '').trim()]);
  }

  function resetRecommendation() {
    recommendation = null;
    recommendedKey = '';
    recommendedHandled = false;
    autoPickedIds = new Set();
  }

  /* 首次推荐：只消费每个服务目标的**第一次新鲜远端结果**。缓存首屏、失败
   * 降级、编辑既有服务、用户已经改过选择，以及之后的刷新都不改选择。
   * 证据不足时不动选择，只把“无法可靠推荐”的原因交给界面。 */
  function recommendFromFirstTrustedResult(meta, incoming = []) {
    if (!draft || draft.mode !== 'create' || draft.touchedSelection === true) return;
    if (meta?.sourceKind !== 'remote' || meta?.stale === true) return;
    const key = recommendationKeyFor(draft);
    if (recommendedHandled && recommendedKey === key) return;
    // 已经不是本流程自动选择的内容（用户或别的流程选过/排过序），绝不覆盖。
    const autoPickedOrder = [...autoPickedIds];
    const onlyAutoPicked = autoPickedIds.size > 0 && draft.order.length === autoPickedOrder.length &&
      draft.order.every((id, index) => id === autoPickedOrder[index]);
    if (draft.order.length > 0 && !onlyAutoPicked) return;
    recommendedKey = key;
    recommendedHandled = true;
    // 只对**本次**远端结果排序。草稿里可能还留有上一目标的候选（例如同一
    // 实例里换回旧端点），它们不能参与新目标的推荐，更不能被自动选中。
    const batch = (Array.isArray(incoming) ? incoming : []).map(raw => {
      const values = raw?.effectiveValues && typeof raw.effectiveValues === 'object' ? raw.effectiveValues : {};
      return {
        modelId: String(raw?.modelId || raw?.id || '').trim(),
        source: 'remote',
        toolCalling: values.toolCalling ?? raw?.toolCalling,
        chatCapable: values.chatCapable ?? raw?.chatCapable,
      };
    });
    const result = recommendModels(batch, { limit: 3 });
    if (!result.picks.length) {
      autoPickedIds = new Set();
      recommendation = { autoPicked: false, picks: [], reasons: {}, insufficient: result.insufficient === true,
        candidates: result.candidates, unknown: result.unknown };
      return;
    }
    autoPickedIds = new Set(result.picks);
    draftStore.dispatch({ type: 'auto-select-models', modelIds: result.picks });
    draft = draftStore.get();
    recommendation = { autoPicked: true, picks: result.picks, reasons: result.reasons, insufficient: false };
  }

  /* 把草稿响应的匹配缓存并入候选列表：只增候选，不改 order/高级参数；
   * 同一目标同一 ID 只合并一次，因此关闭重开不会重复，也不会复活已移除项。 */
  function applyCachedCandidates(handle) {
    if (disposed || view !== 'setup' || !draftStore || !draft) return;
    // 编辑场景下响应必须属于当前服务；防止调用方漏检时跨服务合并。
    if (handle?.serviceId && draft.mode === 'update' && handle.serviceId !== draft.sourceServiceId) return;
    const list = Array.isArray(handle?.cachedModels) ? handle.cachedModels : [];
    if (!list.length) return;
    const key = cacheIdentity();
    if (cacheKey !== key) { cacheKey = key; cacheMergedIds = new Set(); cacheNote = null; }
    const current = draftStore.get();
    const known = new Set(current.models.map(model => model.modelId));
    // 已移除的候选不能被任何缓存响应复活，即使身份键变化导致 merged 集合重置。
    const removed = new Set(Array.isArray(current.removed) ? current.removed : []);
    const incoming = [];
    for (const model of list) {
      const id = String(model?.modelId || '').trim();
      if (!id || known.has(id) || removed.has(id) || cacheMergedIds.has(id)) continue;
      cacheMergedIds.add(id);
      incoming.push(model);
    }
    if (!incoming.length) return;
    const stale = handle.cacheStale === true || incoming.some(model => model.cacheStale === true);
    draftStore.dispatch({ type: 'merge-models', models: incoming });
    draft = draftStore.get();
    panes?.update(draft, { errors: currentErrors.modelErrors, discovery: discovery?.getState() });
    cacheNote = { count: incoming.length, stale, at: Number.isFinite(handle.cachedAt) ? handle.cachedAt : null };
    renderStatus();
  }

  /* 目标（标识/端点/认证来源/本机注册引用）变化后，旧草稿句柄、暂存批准与
   * 发现授权都不再适用。这里同时通知后端撤销，避免只清本地状态而服务端仍可
   * 用旧批准写入。 */
  function revokeDraftArtifacts() {
    // 先让所有跨 await 的旧流程过期，再取消可能正在等待输入的受限窗。
    lifecycleEpoch += 1;
    // 句柄可能先被重置，而暂存仍绑定在旧草稿上；两个标识都要撤销。
    const ids = new Set([draftHandle?.draftId, draft?.nativeStage?.draftId].filter(Boolean));
    draftHandle = null;
    try { credentials?.cancel(); } catch { /* 主进程会自行清理 */ }
    for (const id of ids) {
      releaseLiveDraft(id);
      closeLateDraft(id);
    }
    if (discovery) { try { void discovery.revoke(); } catch { /* best effort */ } }
    if (draft) { draft.requestIds = {}; draft.requestIdKeys = {}; }
    if (draft?.nativeStage) draftStore?.dispatch({ type: 'native-stage-clear' });
  }

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
        actions: Array.isArray(errorState.actions) ? errorState.actions : [],
      }));
    }
    if (successState) {
      statusHost.appendChild(renderBanner({
        tone: successState.tone || 'success',
        title: successState.title,
        message: successState.message,
        actions: Array.isArray(successState.actions) ? successState.actions : [],
      }));
    }
    if (cacheNote) {
      statusHost.appendChild(renderBanner({
        tone: 'info',
        title: cacheNote.stale ? '显示已过期的匹配缓存' : '显示匹配缓存',
        message: `${cacheNote.count} 个候选来自该目标的最近一次发现${cacheNote.stale
          ? '（已超过 60 秒，仅作历史参考；不会自动选择或改变顺序）'
          : '（60 秒内，仅作参考；不会自动选择或改变顺序）'}。授权或刷新可获取最新目录。`,
      }));
    }
    if (draft?.readOnly) {
      statusHost.appendChild(renderBanner({
        tone: 'info',
        title: '只读服务',
        message: '该服务由 Pi 内置配置管理，当前只能查看；不会写入配置。',
      }));
    }
    if (legacy) {
      statusHost.appendChild(renderBanner({
        tone: 'info',
        title: '管理接口未启用 · 兼容模式',
        message: '当前直接写入 Pi 模型配置，保存后需要重载 pi。旧接口没有模型选择元数据：勾选与排序不会保存，请用移除/添加模型修改列表。',
      }));
    }
    if (needsInheritedSelectionConfirmation(draft)) {
      statusHost.appendChild(renderBanner({
        tone: 'info',
        title: '当前模型集是继承的',
        message: '现有保存合同不能表达“继续继承”。保存前会请你确认，确认后才会把上方列表固定为显式选择；零选择也是有效状态。',
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
    if (!discovery) return;
    const controller = discovery;
    discovery = null;
    // 视图切换（换服务、高级设置、登录）也要撤销服务端授权；网页版没有
    // closeDraft 兜底，不能把 consent 留在服务端直到 15 分钟 TTL。
    try { void controller.revoke(); } catch { /* 已失效的授权无需再撤 */ }
    controller.dispose();
  }

  /* 保存/发现/凭据窗口都需要同一个草稿句柄。内容没变时复用，内容变化时
   * 在同一草稿上递增 revision；force 用于授权后重新读取服务器投影的
   * consentId —— 必须换新 requestId，否则服务端会回放旧收据。 */
  async function saveDraftHandle({ force, epoch, target }) {
    if (disposed || lifecycleEpoch !== epoch || targetSignature !== target) {
      return { ok: false, code: 'stale', stale: true, message: '草稿准备期间目标已变化，请重试。' };
    }
    if (!draft) return { ok: false, code: 'invalid_request', message: '没有正在编辑的服务草稿。' };
    if (!snapshotState) return { ok: false, code: 'unavailable', message: '还没有读取到供应商配置。' };
    let payload;
    try { payload = toDraftPayload(draft); }
    catch { return { ok: false, code: 'invalid_request', message: '请先填写有效的服务名称、Base URL 与模型参数。' }; }
    const payloadSignature = JSON.stringify(payload);
    if (!force && draftHandle && draftHandle.payloadSignature === payloadSignature) {
      return { ok: true, ...draftHandle };
    }
    const draftRequest = { expectedRevision: snapshotState.revision, draft: payload };
    if (draft.mode !== 'create') draftRequest.serviceId = draft.sourceServiceId;
    if (draftHandle) {
      draftRequest.draftId = draftHandle.draftId;
      draftRequest.expectedDraftRevision = draftHandle.draftRevision;
    }
    const key = JSON.stringify(draftRequest);
    draftRequest.requestId = force ? newRequestId('draft') : ensureRequestId(draft, 'draft', key);
    let result;
    try { result = await managementApi.saveProviderDraft(draftRequest); }
    catch { result = null; }
    // await 返回后再次核对身份：关闭弹窗、换目标或换草稿都会让这次响应过期。
    if (disposed || lifecycleEpoch !== epoch || targetSignature !== target) {
      if (result?.ok === true && result.draftId) closeLateDraft(result.draftId);
      return { ok: false, code: 'stale', stale: true, message: '草稿响应已过期，未应用到当前目标。' };
    }
    if (!result) return { ok: false, network: true, code: 'network_failed', message: '网络请求失败，草稿没有保存。' };
    if (result.ok !== true) return result || { ok: false, code: 'failed', message: '草稿保存失败。' };
    const previousId = draftHandle?.draftId;
    draftHandle = {
      draftId: result.draftId,
      draftRevision: result.draftRevision,
      connectionRevision: result.connectionRevision ?? null,
      targetFingerprint: result.targetFingerprint || '',
      consentId: result.consentId || null,
      consentExpiresAt: result.consentExpiresAt || null,
      sourceKind: result.sourceKind || 'none',
      cachedModels: Array.isArray(result.cachedModels) ? result.cachedModels : [],
      payloadSignature,
    };
    if (previousId !== draftHandle.draftId) {
      if (previousId) {
        releaseLiveDraft(previousId);
        closeLateDraft(previousId);
      }
      retainLiveDraft(draftHandle.draftId);
    }
    configureDiscovery(discovery);
    applyCachedCandidates(draftHandle);
    return { ok: true, ...draftHandle };
  }

  function ensureDraftHandle({ force = false } = {}) {
    const epoch = lifecycleEpoch;
    const target = targetSignature;
    const run = () => saveDraftHandle({ force, epoch, target });
    const next = draftSaveChain.then(run, run);
    draftSaveChain = next.then(() => {}, () => {});
    return next;
  }

  async function authorizeDesktopDiscovery({ draftId, draftRevision, rememberTarget = false } = {}) {
    if (!credentials) return { ok: false, code: 'unsupported', reason: '当前环境没有可用的安全凭据窗口。' };
    if (disposed) return { ok: false, code: 'stale', reason: '供应商设置已经关闭。' };
    const epoch = lifecycleEpoch;
    const target = targetSignature;
    const opened = await credentials.open({ draftId, draftRevision, action: 'authorize-target' });
    // 授权窗等待期间关闭弹窗或换目标：授权可能已经落到旧草稿上，必须撤销。
    if (disposed || lifecycleEpoch !== epoch || targetSignature !== target) {
      if (opened.ok) closeLateDraft(draftId);
      return { ok: false, code: 'stale', reason: '授权期间目标已变化，本次授权已作废。', cancelled: true };
    }
    if (!opened.ok) return { ok: false, code: opened.code, reason: opened.reason, cancelled: opened.cancelled };
    // 授权由私有桥写入服务端；重存同一草稿以读取与当前绑定匹配的 consentId。
    const handle = await ensureDraftHandle({ force: true });
    if (disposed || lifecycleEpoch !== epoch || targetSignature !== target) {
      if (handle.ok) closeLateDraft(handle.draftId);
      return { ok: false, code: 'stale', reason: '授权期间目标已变化，本次授权已作废。', cancelled: true };
    }
    if (!handle.ok) return { ok: false, code: handle.code || 'failed', message: handle.message || '草稿没有保存成功。' };
    if (!handle.consentId) {
      return { ok: false, code: 'invalid_target', reason: '授权已确认，但没能在草稿上读取到有效授权句柄；请重试。' };
    }
    return { ok: true, draftId: handle.draftId, draftRevision: handle.draftRevision,
      connectionRevision: handle.connectionRevision, targetFingerprint: handle.targetFingerprint,
      consentId: handle.consentId, consentExpiresAt: handle.consentExpiresAt };
  }

  async function authorizeDiscovery() {
    if (!discovery) return;
    if (!discoverySupported(snapshotState)) {
      errorState = { title: '自动发现尚未开放', message: discoveryUnavailableReason(snapshotState) };
      renderStatus();
      return;
    }
    const mode = effectiveAuthMode(draft);
    const supported = discoverySupportsAuth(snapshotState, mode);
    if (supported === false) {
      errorState = {
        title: '当前认证来源不能自动发现',
        message: mode === 'pi-credential'
          ? 'Pi 本机凭据模式需要桌面安全凭据桥；当前环境没有把它列为可用发现模式。'
          : '当前认证来源不在自动发现的支持范围内。',
      };
      renderStatus();
      return;
    }
    if (mode === 'pi-credential' && !draft?.nativeStage && draft?.credentialState?.source !== 'pi-credential') {
      errorState = {
        title: '请先暂存 Pi 本机凭据',
        message: '本机凭据模式下，发现与测试都需要一把已暂存或已保存的密钥。请先通过安全凭据窗口暂存密钥，再授权读取模型目录。',
        actions: [button('配置 API Key', 'pm-btn pm-btn-small', () => openCredentialSheet())],
      };
      renderStatus();
      return;
    }
    errorState = null;
    renderStatus();
    await discovery.authorize({ rememberTarget: false });
  }

  async function testConnection() {
    if (!discovery) return;
    if (!discoverySupported(snapshotState)) {
      errorState = { title: '连接测试尚未开放', message: discoveryUnavailableReason(snapshotState) };
      renderStatus();
      return;
    }
    await discovery.test();
  }

  async function runConnectionTest() {
    if (!discovery) return;
    if (!discovery.getState().consentId) await authorizeDiscovery();
    if (discovery.getState().consentId) await discovery.test();
  }

  function maybeRunIntent() {
    if (!pendingTestIntent || view !== 'setup' || !draft) return;
    pendingTestIntent = false;
    // 等本轮渲染完成后再走授权/测试，避免在构造 DOM 时打开受限窗。
    setTimeout(() => { if (!disposed) void runConnectionTest(); }, 0);
  }

  async function openCredentialSheet({ action = 'set' } = {}) {
    if (disposed || !draft || draft.readOnly || credentialBusy || saving) return;
    if (legacy || !credentials || !desktopCredentialBridge()) {
      errorState = { title: '安全凭据窗口不可用', message: '网页版或兼容模式没有 Electron 安全凭据窗口；这里只写入 $NAME 环境变量引用。' };
      renderStatus();
      return;
    }
    const capabilities = snapshotState?.capabilities || {};
    if (capabilities.privateDesktopBridge !== true || capabilities.keyStaging !== true ||
        capabilities.nativeCredentialPersistence !== true) {
      errorState = {
        title: '安全凭据窗口尚未开放',
        message: '需要桌面应用已连接后端、未被 PI_GUI_PROVIDER_KEY_INPUT=0 关闭、通过 SDK 资格检查，且本机凭据存储通过安全资格检查。',
      };
      renderStatus();
      return;
    }
    credentialBusy = true;
    errorState = null;
    try {
      if (action === 'set') {
        // 原生凭据槽要求草稿先切到 pi-credential，并放弃配置内的环境变量引用。
        if (String(draft.envReference || '').trim()) draftStore.dispatch({ type: 'env-reference', value: '' });
        draftStore.dispatch({ type: 'auth-mode', authMode: 'pi-credential' });
      }
      draft = draftStore.get();
      // auth-mode 切换本身可能改变目标并撤销旧句柄；代次必须在切换之后取。
      const epoch = lifecycleEpoch;
      const target = targetSignature;
      const handle = await ensureDraftHandle();
      if (disposed || lifecycleEpoch !== epoch || targetSignature !== target) return;
      if (!handle.ok) {
        errorState = { title: action === 'clear' ? '无法准备清除凭据' : '无法准备凭据输入', message: handle.message || '草稿没有保存成功。' };
        if (isConflict(handle) || handle.code === 'draft_conflict') await handleConflict(handle);
        else renderStatus();
        return;
      }
      const opened = await credentials.open({ draftId: handle.draftId, draftRevision: handle.draftRevision, action });
      // 凭据窗等待期间关闭弹窗或换目标：即使窗口刚刚暂存成功，也不能把
      // 这份暂存挂到新目标上；服务端草稿由 closeLateDraft 撤销（若仍无人持有）。
      if (disposed || lifecycleEpoch !== epoch || targetSignature !== target) {
        if (opened.ok) closeLateDraft(handle.draftId);
        return;
      }
      if (!opened.ok) {
        if (!opened.cancelled) {
          errorState = { title: '安全凭据窗口没有完成', message: opened.reason || '凭据输入已取消。' };
          renderStatus();
        }
        return;
      }
      draftStore.dispatch({ type: 'native-stage', stage: { action, draftId: handle.draftId, connectionRevision: handle.connectionRevision } });
      draft = draftStore.get();
      successState = {
        tone: 'info',
        title: action === 'clear' ? '已暂存清除' : '密钥已暂存',
        message: action === 'clear'
          ? '保存服务时会从 Pi 本机凭据槽移除；模型配置与环境变量不受影响。'
          : '保存服务时会写入 Pi 本机凭据；密钥值没有进入主页面。',
      };
      renderStatus();
      refreshHeader();
    } finally {
      credentialBusy = false;
    }
  }

  async function discardNativeStage() {
    if (!draft?.nativeStage) return;
    const ok = await confirmModal({
      title: '放弃已暂存的凭据？',
      message: '暂存的密钥或清除操作不会用于保存，之后可以重新打开安全凭据窗口。发现授权也会一并失效。',
      okText: '放弃暂存',
      cancelText: '保留',
      danger: true,
    });
    if (!ok) return;
    // close-draft 会让后端删除草稿本身；本地句柄与 requestId 也必须一起作废，
    // 否则下次保存会复用已删除的 draftId，被 draft_conflict 打回。
    revokeDraftArtifacts();
    successState = { tone: 'info', title: '已放弃暂存', message: '保存会保留现有凭据配置；需要时重新打开安全凭据窗口。' };
    renderStatus();
  }

  function rebuildConnection() {
    if (!connectionHost || !draft) return;
    connectionHost.innerHTML = '';
    const item = catalogForDraft(snapshotState, draft);
    connectionHost.appendChild(renderConnectionFields({
      draft,
      snapshot: snapshotState,
      item,
      legacy,
      errors: currentErrors.errors || {},
      onDispatch: action => draftStore.dispatch(action),
      onChangeService: () => changeService(),
      onOpenAuth: () => {
        const providerId = item?.providerId || draft.providerId;
        showAuth(providerId);
      },
      onCredentialTrigger: () => openCredentialSheet(),
      onClearCredential: intent => clearCredential(intent),
      onDiscardStage: () => discardNativeStage(),
    }));
  }

  function createDiscovery() {
    if (!draft) return null;
    const supported = discoverySupported(snapshotState);
    const controller = createDiscoveryController({
      api: managementApi,
      supported,
      debounceMs: 600,
      ensureDraft: () => ensureDraftHandle(),
      authorizeDesktop: payload => authorizeDesktopDiscovery(payload),
      onModels: (models, meta) => {
        if (!draft || disposed) return;
        draftStore.dispatch({ type: 'merge-models', models });
        draft = draftStore.get();
        // 首次可信结果可以自动推荐；其余情况候选只进入候选列表，选择不变。
        recommendFromFirstTrustedResult(meta, models);
        panes?.update(draft, { errors: currentErrors.modelErrors, discovery: controller.getState(), recommendation });
        if (meta?.sourceKind === 'remote' && cacheNote) { cacheNote = null; renderStatus(); }
        if (meta?.stale) {
          successState = {
            tone: 'info',
            title: '正在显示上次的缓存候选',
            message: '供应商这次没有返回新的模型目录；缓存候选只用于参考，不会改变已选模型。',
          };
          renderStatus();
        }
      },
    });
    configureDiscovery(controller);
    controller.subscribe(state => {
      if (!panes) return;
      panes.setDiscovery(state);
    });
    return controller;
  }

  function configureDiscovery(controller) {
    if (!controller || !draft) return;
    controller.configure({
      supported: discoverySupported(snapshotState),
      draftId: draftHandle?.draftId || null,
      draftRevision: draftHandle?.draftRevision || null,
      dialogGeneration: 1,
      connectionRevision: draftHandle?.connectionRevision ?? null,
      targetFingerprint: draftHandle?.targetFingerprint || '',
      models: draft.models.map(model => ({ modelId: model.modelId, name: model.name || '' })),
      source: draftHandle?.sourceKind === 'cache' ? 'cache' : 'none',
      authMode: effectiveAuthMode(draft),
      modes: discoveryModes(snapshotState),
    });
  }

  function dispatchFromPane(action) {
    if (legacy && ['toggle-model', 'select-visible', 'move-model', 'move-before', 'move-to-index'].includes(action.type)) {
      toast('兼容模式不会保存勾选或排序；请用“移除模型配置”或添加模型修改列表。', 'warn', { important: true });
      return draftStore.get();
    }
    return draftStore.dispatch(action);
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
      dispatch: dispatchFromPane,
      errors: currentErrors.modelErrors,
      capabilities: snapshotState?.capabilities || {},
      discovery: discovery?.getState(),
      recommendation,
      onRefresh: payload => {
        if (!discovery) return;
        if (!discoverySupported(snapshotState)) return;
        discovery.refresh(payload);
      },
      onAuthorize: () => authorizeDiscovery(),
      onTest: () => testConnection(),
      onCancel: () => discovery?.cancel(),
      onRemove: model => confirmRemoveModel(model),
      onDraftChange: () => syncChrome(),
    });
    modelHost.appendChild(panes.node);
    discovery = createDiscovery();
    panes.setDiscovery(discovery.getState());
    syncChrome();
    renderStatus();
    maybeRunIntent();
    focusAfterSetup();
    /* FIX-01：编辑既有服务时用只读缓存端点取与当前权威目标严格绑定的首屏
     * 候选（不写草稿、不联网）。失败不阻塞编辑；用户动作会走正常授权流程。
     * 迟到响应必须仍属于发起请求时的服务与目标，否则丢弃——切换服务或改
     * 目标后把旧服务的缓存并进新草稿，会把旧模型 ID 写进新供应商配置。 */
    if (!legacy && snapshotState && draft?.mode === 'update' && typeof managementApi.fetchProviderServiceCache === 'function') {
      const key = cacheIdentity();
      const serviceId = draft.sourceServiceId;
      const epoch = lifecycleEpoch;
      const target = targetSignature;
      const stillCurrent = () => !disposed && view === 'setup' && lifecycleEpoch === epoch &&
        targetSignature === target && draft?.mode === 'update' && draft?.sourceServiceId === serviceId &&
        cacheIdentity() === key;
      if (cacheBootstrapKey !== key && serviceId) {
        cacheBootstrapKey = key;
        setTimeout(() => {
          if (!stillCurrent()) return;
          Promise.resolve(managementApi.fetchProviderServiceCache(serviceId))
            .then(result => {
              // 丢弃迟到结果时清掉标记：切回同一服务/目标后仍可重新取首屏缓存。
              if (!stillCurrent()) { cacheBootstrapKey = ''; return; }
              // 服务端回显的 serviceId 也必须一致；不一致说明响应已属另一目标。
              if (result?.ok === true && result.serviceId === serviceId) applyCachedCandidates(result);
              else if (result?.ok !== true) cacheBootstrapKey = '';
            })
            .catch(() => { cacheBootstrapKey = ''; });
        }, 0);
      }
    }
  }

  function focusAfterSetup() {
    const credential = document.querySelector('#pmCredentialTrigger:not([disabled])');
    if (credential) { credential.focus(); return; }
    const first = document.querySelector('.pm-model-row input, [data-custom-model-input], .pm-service-chip .pm-change-service');
    first?.focus();
  }

  function openDraft(nextDraft) {
    // 换草稿前先撤销上一个草稿的暂存批准与授权；它们不能跨草稿复用。
    revokeDraftArtifacts();
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (draftStore) draftStore = null;
    draft = nextDraft;
    draftHandle = null;
    targetSignature = draftTargetSignature(nextDraft);
    authSignature = effectiveAuthMode(nextDraft);
    resetRecommendation();
    draftStore = createDraftStore(nextDraft);
    unsubscribe = draftStore.subscribe((state, action) => {
      const previous = draft;
      draft = state;
      const nextTarget = draftTargetSignature(state);
      const nextAuth = effectiveAuthMode(state);
      const targetContextChanged = nextTarget !== targetSignature || nextAuth !== authSignature;
      if (targetContextChanged) {
        targetSignature = nextTarget;
        authSignature = nextAuth;
        /* 端点/供应商标识变化：上一目标的发现/缓存候选不属于新目标，先从
         * 草稿里移除，避免被重新推荐或随保存写入新端点。认证来源变化只
         * 改变凭据读取方式，目录候选仍保留。 */
        if (modelTargetSignature(previous) !== modelTargetSignature(state)) {
          draftStore.dispatch({ type: 'drop-target-discovery' });
          state = draftStore.get();
          draft = state;
        }
        /* 换端点/协议后，上一目标的自动推荐不再适用；只在用户还没碰过
         * 选择时撤销，并且不把这次撤销算成用户操作。 */
        const nextRecommendationKey = recommendationKeyFor(state);
        if (recommendedKey && nextRecommendationKey !== recommendedKey) {
          if (autoPickedIds.size && state.touchedSelection !== true) {
            draftStore.dispatch({ type: 'auto-select-models', modelIds: [] });
            state = draftStore.get();
            draft = state;
          }
          resetRecommendation();
        }
        // 目标/认证来源变化：旧句柄、暂存批准、发现授权与首屏缓存全部作废。
        resetCacheState();
        const hadStage = Boolean(previous?.nativeStage);
        revokeDraftArtifacts();
        if (hadStage && !state.nativeStage && view === 'setup') {
          // 改环境变量引用/端点会同时清掉暂存；界面必须立刻收回“已暂存”的说法，
          // 否则用户会以为保存仍会写入刚才的密钥。
          successState = {
            tone: 'info',
            title: '已放弃暂存凭据',
            message: '目标或认证来源已变化，先前的暂存批准已撤销；需要时重新打开安全凭据窗口。',
          };
          rebuildConnection();
          renderStatus();
        }
      }
      refreshHeader();
      syncServiceChip();
      if (discovery && view === 'setup') configureDiscovery(discovery);
      /* 端点/认证来源变化可能已经撤销自动选择（或让推荐失去意义），
       * 但模型栏不订阅 draftStore；必须显式同步，否则界面仍显示旧的
       * 已选行，用户保存时却提交了空选择。 */
      if (targetContextChanged && panes && view === 'setup') {
        panes.update(state, {
          errors: currentErrors.modelErrors,
          discovery: discovery?.getState(),
          recommendation,
        });
      }
      // mark-saved 也会清掉 nativeStage：配置已保存但凭据失败/未确认时，
      // 必须立刻收回「已暂存」的状态文案，否则页面会继续声称暂存仍有效。
      if (['native-stage', 'native-stage-clear', 'clear-credential', 'mark-saved'].includes(action?.type) && view === 'setup') {
        rebuildConnection();
        renderStatus();
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
      legacy,
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
        // 兼容接口没有独立显示名；用供应商标识作为名称，避免界面承诺一个不会落盘的字段。
        const chosen = legacy ? { ...picked, name: picked.providerId || picked.id } : picked;
        const next = draftFromCatalog(snapshotState, chosen, { existingIds });
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

  function clearCredential(intent = {}) {
    if (!draft || draft.readOnly) return;
    if (legacy) {
      toast('兼容模式不会写入清除操作；请开启管理接口或在 Pi 配置中处理该凭据。', 'warn', { important: true });
      return;
    }
    const capabilities = snapshotState?.capabilities || {};
    const source = draft.credentialState?.source;
    const nativeCapable = capabilities.privateDesktopBridge === true && capabilities.keyStaging === true;
    const wantsNative = intent?.native === true || (source === 'pi-credential' && nativeCapable);
    const persistence = capabilities.nativeCredentialPersistence === true;
    const support = credentialClearSupport(draft, { native: wantsNative && persistence });
    if (!support.supported) {
      toast(source === 'pi-credential' && wantsNative && !persistence
        ? '本机凭据存储未通过安全资格检查；GUI 无法在这里清除 Pi 本机凭据。'
        : support.reason, 'warn', { important: true });
      return;
    }
    confirmModal({
      title: `清除${support.label}？`,
      message: support.message,
      okText: support.native ? '打开安全窗口确认清除' : '保存时清除配置凭据',
      cancelText: '保留',
      danger: true,
    }).then(ok => {
      if (!ok) return;
      if (support.native) { void openCredentialSheet({ action: 'clear' }); return; }
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
    if (disposed || !draft || saving) return;
    if (draft.readOnly) return;
    saving = true;
    errorState = null;
    conflictState = null;
    successState = null;
    // 保存期间迟到的发现结果不能改写正在提交的模型集合。
    if (discovery) discovery.cancel();
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
      if (!legacy && needsInheritedSelectionConfirmation(draft)) {
        const ok = await confirmModal({
          title: '固定当前模型选择？',
          message: '这个服务当前继承 Pi 的模型列表。现有保存合同不能表达“继续继承”，保存会把上方当前列表固定为显式选择。只想修改名称、启用状态或其它无关字段时，可以取消并保持原状。',
          okText: '固定并保存',
          cancelText: '返回检查',
        });
        if (!ok) {
          saving = false;
          dialogCard?.removeAttribute('aria-busy');
          refreshHeader();
          return;
        }
      }
      const stage = draft.nativeStage;
      if (stage) {
        if (!draftHandle || stage.draftId !== draftHandle.draftId) {
          saving = false;
          dialogCard?.removeAttribute('aria-busy');
          refreshHeader();
          if (stage.draftId && credentials) { try { void credentials.closeDraft(stage.draftId); } catch { /* best effort */ } }
          draftStore.dispatch({ type: 'native-stage-clear' });
          errorState = {
            title: '凭据暂存已失效',
            message: '草稿绑定已经变化，暂存的密钥不能用于这次保存。请重新打开安全凭据窗口。',
            actions: [button('重新配置凭据', 'pm-btn pm-btn-small', () => openCredentialSheet())],
          };
          renderStatus();
          return;
        }
        if (snapshotState?.capabilities?.nativeCredentialPersistence !== true) {
          saving = false;
          dialogCard?.removeAttribute('aria-busy');
          refreshHeader();
          errorState = {
            title: '无法保存本机凭据',
            message: '本机凭据存储未通过安全资格检查（auth.json 的所有者/权限见证不足），保存不会写入凭据。可以放弃暂存后仅保存配置，或修复存储资格后重新打开安全凭据窗口。',
            actions: [button('放弃暂存', 'pm-btn pm-btn-small', () => discardNativeStage())],
          };
          renderStatus();
          return;
        }
      }
      try {
        toDraftPayload(draft);
      } catch {
        saving = false;
        dialogCard?.removeAttribute('aria-busy');
        errorState = { title: '配置不完整', message: '请检查 Base URL、服务名称与模型参数。' };
        renderStatus();
        return;
      }
      const action = draft.mode === 'update' ? 'update' : draft.mode === 'clone' ? 'clone' : 'create';
      // 同一内容重试时复用草稿；内容变化时在同一草稿上递增 revision。
      const handle = await ensureDraftHandle();
      if (disposed) return;
      if (handle.stale) {
        saving = false;
        dialogCard?.removeAttribute('aria-busy');
        refreshHeader();
        errorState = { title: '保存目标已变化', message: '准备草稿期间目标或认证来源发生变化，旧草稿没有复用；请检查当前配置后重新保存。' };
        renderStatus();
        return;
      }
      if (!handle.ok) {
        await handleFailure(handle, 'draft');
        return;
      }
      // 从提交请求发出到响应返回期间，目标/认证来源仍可能变化。旧回调不能
      // 把结果标到新目标上，也不能关闭用户正在编辑的新草稿。
      const commitEpoch = lifecycleEpoch;
      const commitTarget = targetSignature;
      const commitBody = {
        action,
        expectedRevision: snapshotState.revision,
        draftId: handle.draftId,
        draftRevision: handle.draftRevision,
        credentialAction: commitCredentialAction(draft),
      };
      if (draft.mode !== 'create') commitBody.serviceId = draft.sourceServiceId;
      const request = {
        requestId: ensureRequestId(draft, 'commit', JSON.stringify(commitBody)),
        ...commitBody,
      };
      const result = await managementApi.commitProviderDraft(request);
      if (disposed) return;
      if (lifecycleEpoch !== commitEpoch || targetSignature !== commitTarget) {
        saving = false;
        dialogCard?.removeAttribute('aria-busy');
        refreshHeader();
        errorState = {
          title: '保存结果未应用到当前草稿',
          message: '提交期间目标或认证来源发生了变化；刚才的请求可能已经落盘。请重新读取配置，确认当前服务状态后再操作。',
        };
        renderStatus();
        return;
      }
      // 配置已落盘但凭据失败/未确认：不能当成“保存失败”，也不能自动重发。
      if (!result?.ok && result?.saved === true
        && (result.credentialSaved === false || result.credentialSaved === null)) {
        await handleCredentialAfterSave(result, commitBody.credentialAction);
        return;
      }
      if (!result?.ok) {
        await handleFailure(result, 'commit');
        return;
      }
      saving = false;
      dialogCard?.removeAttribute('aria-busy');
      draftStore.dispatch({ type: 'mark-saved', state: result.sync?.state === 'pending' ? 'saved-pending-sync' : 'saved' });
      onSaved?.(result);
      // 保存结果必须可见：info/success 默认不弹 toast，这里显式标成 important。
      if (result.legacy) toast('服务已保存；重载 pi 配置后生效。', 'info', { important: true });
      else {
        const credential = result.credentialSaved === true
          ? result.credentialState === 'cleared' ? '本机凭据已清除' : 'Pi 本机凭据已保存'
          : '';
        const syncPending = result.sync?.state === 'pending';
        toast(`服务已保存${credential ? `，${credential}` : ''}${syncPending ? '；Runtime 生效状态待核验' : ''}。`,
          syncPending ? 'info' : 'success', { important: true });
      }
      close();
    } catch {
      saving = false;
      dialogCard?.removeAttribute('aria-busy');
      errorState = { title: '保存失败', message: '请求没有完成；草稿还在，可以重试。' };
      renderStatus();
      refreshHeader();
    }
  }

  /* 配置事务已提交、凭据没有保存或结果无法确认。这里绝不自动重发：
   * 未确认时重发可能造成第二次写入；失败时也必须由用户明确重开凭据窗口。
   * 凭据是否成功只认提交回执的 credentialSaved/credentialState；服务快照
   * 里的 credentialState 可能仍是操作前的旧凭据，不能拿来把失败说成成功。 */
  async function handleCredentialAfterSave(result, credentialAction = null) {
    if (disposed) return;
    saving = false;
    dialogCard?.removeAttribute('aria-busy');
    successState = null; // 「已暂存」不再成立：暂存批准已被本次提交消费
    const unconfirmed = result.credentialState === 'credential-unconfirmed' || result.credentialSaved === null;
    const clearing = credentialAction?.type === 'clear-native';
    const serviceId = result.serviceId || draft?.sourceServiceId || '';
    // 配置已经是新版本：把草稿转成对该服务的更新，但保留当前编辑内容。
    draftStore.dispatch({ type: 'mark-saved', state: unconfirmed ? 'credential-unconfirmed' : 'saved-credential-error', serviceId });
    draft = draftStore.get();
    // 提交已经消费了服务端草稿；本地句柄不能再被关闭或复用。
    if (draftHandle?.draftId) releaseLiveDraft(draftHandle.draftId);
    draftHandle = null;
    await readLatestSnapshot();
    if (disposed) return;
    const savedService = serviceId ? serviceFromSnapshot(snapshotState, serviceId) : null;
    const observed = savedService?.credentialState?.state === 'saved'
      ? clearing
        ? 'Pi 当前仍报告有凭据，本次清除没有完成。'
        : 'Pi 当前仍报告有凭据；这不能证明本次输入的新密钥已经写入，可能是操作前的旧凭据。'
      : savedService?.credentialState?.state === 'none'
        ? 'Pi 当前没有读到该服务的本机凭据。'
        : 'Pi 当前的凭据状态无法确认。';
    // mark-saved 会清掉 nativeStage，订阅者可能补一条「已放弃暂存」提示；
    // 本次保存已有明确的错误/待确认结论，不能再叠一条成功语气横幅。
    successState = null;
    errorState = {
      title: unconfirmed
        ? '配置已保存，凭据结果待确认'
        : clearing ? '配置已保存，但凭据清除失败' : '配置已保存，但凭据没有保存',
      message: unconfirmed
        ? `配置事务已提交；凭据写入结果无法确认。${observed}为避免重复写入，GUI 不会自动重试。请稍后重新读取状态，或明确重新打开安全凭据窗口。`
        : `配置事务已提交；凭据部分失败。${observed}草稿已保留为对该服务的更新，请重新打开安全凭据窗口后再保存。`,
      actions: [
        button('重新读取状态', 'pm-btn pm-btn-small', () => refreshCredentialOutcome(serviceId, unconfirmed, clearing)),
        button(clearing ? '重新清除凭据' : '重新配置凭据', 'pm-btn pm-btn-small', () => {
          if (clearing) clearCredential({ native: true });
          else openCredentialSheet();
        }),
      ],
    };
    renderStatus();
    refreshHeader();
    onSaved?.(result);
  }

  async function refreshCredentialOutcome(serviceId, unconfirmed, clearing = false) {
    if (disposed) return;
    successState = null;
    const latest = await readLatestSnapshot();
    if (disposed) return;
    const service = latest && serviceId ? serviceFromSnapshot(latest, serviceId) : null;
    const state = service?.credentialState?.state;
    // 快照只能说明「当前是否有凭据」，不能证明这次写入/清除已经生效：
    // 失败后旧凭据仍在时，快照同样是 saved。
    const observed = state === 'saved'
      ? clearing
        ? 'Pi 当前仍报告有凭据，本次清除没有完成。'
        : 'Pi 当前报告有凭据，但无法确认是不是本次输入的新密钥。'
      : state === 'none'
        ? 'Pi 当前没有读到该服务的本机凭据。'
        : 'Pi 当前的凭据状态无法确认。';
    errorState = {
      title: unconfirmed ? '凭据结果仍未确认' : clearing ? '凭据清除失败' : '凭据仍未保存',
      message: `${observed}${unconfirmed ? '本次保存的凭据结果仍无法确认。' : ''}没有凭据写入成功的回执；GUI 不会自动重复写入。`,
      actions: [
        button(clearing ? '重新清除凭据' : '重新配置凭据', 'pm-btn pm-btn-small', () => {
          if (clearing) clearCredential({ native: true });
          else openCredentialSheet();
        }),
      ],
    };
    renderStatus();
  }

  async function handleFailure(result, phase) {
    saving = false;
    dialogCard?.removeAttribute('aria-busy');
    refreshHeader();
    if (phase === 'commit' && result?.code === 'invalid_request' && result?.fieldErrors?.confirmBuiltinOverride
        && draft && draft.confirmBuiltinOverride !== true) {
      /* P6：内置供应商首次写模型覆盖时服务端强制确认。快照没有可靠的
       * builtin 标识（旧入口写入的 provider 没有 GUI 元数据），因此由服务端的
       * 明确字段错误触发确认；确认后只重试一次（draft 已带 confirm 标记）。 */
      const ok = await confirmModal({
        title: '覆盖内置模型配置？',
        message: '该供应商的模型由 Pi 内置配置提供。保存会把当前模型的字段写入 GUI 覆盖层：只影响你改过的字段，内置默认值仍保留。',
        okText: '覆盖并保存',
        cancelText: '取消',
      });
      if (disposed) return;
      if (!ok) {
        errorState = { title: '已取消保存', message: '未确认覆盖内置模型配置，本次没有写入任何更改。' };
        renderStatus();
        return;
      }
      draftStore.dispatch({ type: 'builtin-override' });
      draft = draftStore.get();
      await save();
      return;
    }
    if (phase === 'draft' && result?.code === 'draft_conflict') {
      // 草稿已被服务端替换：旧句柄上的暂存与发现授权都不能继续使用。
      revokeDraftArtifacts();
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
      if (disposed) return null;
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
    // 最新 revision 已读到，旧草稿句柄、暂存批准与发现授权都不能跨 revision 复用。
    // 下一次保存会按新 revision 重新创建草稿并轮换 requestId。
    revokeDraftArtifacts();
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
    // 读取新版本后旧句柄失效；暂存凭据与授权也不得继续沿用。
    revokeDraftArtifacts();
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

  /* 桌面私有桥只有在 main ↔ backend 完成 capability 握手后才会报告能力。
   * 页面拿到的快照可能早于握手；打开弹窗时先探测一次，再重读快照，
   * 让发现模式与凭据资格显示真实值。网页版没有桥，保持同步启动。 */
  function primeDesktopCapabilities() {
    if (legacy || !credentials || credentials.getState().bridge !== true) {
      if (snapshotState) start(); else loadSnapshot();
      return;
    }
    credentials.probe().catch(() => {}).then(() => {
      if (disposed) return;
      if (!snapshotState) { loadSnapshot(); return; }
      if (snapshotState.capabilities?.privateDesktopBridge === true) { start(); return; }
      readLatestSnapshot().then(() => { if (!disposed) start(); });
    });
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
      const chosen = legacy ? { ...item, name: item.providerId || item.id } : item;
      openDraft(draftFromCatalog(snapshotState, chosen, { existingIds }));
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
    primeDesktopCapabilities();
  }, () => {
    cleanup();
    try { onClosed?.(); } catch { /* 页面刷新失败不影响关闭 */ }
  }, {
    className: 'pm-dialog-card',
    onCancel: requestCancel,
    labelledBy: 'pmDialogTitle',
  });
}
