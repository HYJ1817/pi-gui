/* 供应商编辑草稿。
 *
 * 一条硬规则：**用户的选择与顺序只能由用户动作改变**。
 * 刷新、搜索、接口失败、迟到的异步结果都只影响可见列表，不能碰 order。
 *
 * 这一层不碰 DOM、不发现模型、不发请求 —— 只把服务快照变成可提交的草稿，
 * 并保证提交前的补丁/取消字段是合同允许的形状。 */

import {
  EDITABLE_MODEL_FIELDS,
  PROVIDER_API_TYPES,
  isEnvReference,
  isModelId,
  isProviderId,
  validateConnection,
  validateModelValues,
} from './contract.js';
import { suggestProviderId } from './catalog.js';
import {
  allVisibleSelected,
  moveBefore,
  moveByOffset,
  moveToIndex,
  normalizeOrder,
  setVisibleSelection,
  toggleSelection,
} from './model-visibility.js';

const plainRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copyConnection = connection => (plainRecord(connection)
  ? { baseUrl: String(connection.baseUrl || ''), api: String(connection.api || 'openai-completions') }
  : null);

const tri = value => (typeof value === 'boolean' ? value : null);
const positiveOrNull = value => (Number.isSafeInteger(value) && value > 0 ? value : null);

function copyInput(value) {
  if (!Array.isArray(value) || !value.length) return null;
  return value.filter(item => item === 'text' || item === 'image');
}

export function createModelRecord(raw = {}, { manual = false } = {}) {
  const overrides = plainRecord(raw.editableOverrides) ? raw.editableOverrides : {};
  const effective = plainRecord(raw.effectiveValues) ? raw.effectiveValues : {};
  const baseline = {
    name: typeof overrides.name === 'string' ? overrides.name : null,
    contextWindow: positiveOrNull(overrides.contextWindow),
    maxTokens: positiveOrNull(overrides.maxTokens),
    reasoning: tri(overrides.reasoning),
    input: copyInput(overrides.input),
  };
  // 远端/缓存候选与配置里已有、手动添加的模型必须可区分；只有真正写进
  // models.json 的记录才算 persisted。
  const source = manual ? 'manual'
    : raw.configSource === 'builtin-override' ? 'builtin-override'
      : raw.configSource === 'remote' ? 'remote'
        : raw.configSource === 'cache' ? 'cache' : 'configured';
  /* P6：发现/缓存候选带着服务端白名单化后的显示元数据（name/容量/推理/输入）。
   * 它们只用于展示回退，不进入 baseline/editableOverrides，也不会因为没有
   * 用户编辑而变成持久化覆盖。 */
  const displayValues = {
    name: typeof effective.name === 'string' && effective.name.length > 0 && effective.name.length <= 200
      && !/[\u0000-\u001f\u007f]/u.test(effective.name) ? effective.name : null,
    contextWindow: positiveOrNull(effective.contextWindow),
    maxTokens: positiveOrNull(effective.maxTokens),
    reasoning: tri(effective.reasoning),
    input: copyInput(effective.input),
  };
  return {
    modelId: String(raw.modelId || '').trim(),
    source,
    cachedStale: source === 'cache' && raw.cacheStale === true,
    persisted: (!manual && source === 'configured') || source === 'builtin-override',
    baseline,
    displayValues,
    name: baseline.name,
    contextWindow: baseline.contextWindow,
    maxTokens: baseline.maxTokens,
    reasoning: baseline.reasoning,
    input: baseline.input,
    toolCalling: tri(effective.toolCalling),
    streaming: tri(effective.streaming),
    // 高级编辑器的「更多参数」折叠状态不进屋，展开状态由视图持有。
  };
}

export function createManualModel(modelId) {
  return createModelRecord({ modelId, configSource: 'manual' }, { manual: true });
}

function selectedOrder(service) {
  const models = Array.isArray(service?.models) ? service.models : [];
  const existing = [...new Set(models.map(model => model.modelId))];
  // 只有 selectedModelIds 决定“选中了什么”；modelOrder 只是次序。
  // null/缺失表示继承当前可用模型，不能因为 modelOrder 非空就缩小选择集。
  if (Array.isArray(service?.selectedModelIds)) {
    const selected = service.selectedModelIds.filter(id => typeof id === 'string');
    return Array.isArray(service?.modelOrder)
      ? normalizeOrder(service.modelOrder, selected)
      : normalizeOrder(selected, selected);
  }
  return Array.isArray(service?.modelOrder)
    ? normalizeOrder(service.modelOrder, existing)
    : existing;
}

function serviceModels(service) {
  const models = (Array.isArray(service?.models) ? service.models : []).map(model => createModelRecord(model));
  const known = new Set(models.map(model => model.modelId));
  for (const id of selectedOrder(service)) {
    if (known.has(id)) continue;
    // 快照里被选中、却没有模型详情的标识仍要保留 —— 不能因为「没观察到」就丢掉。
    models.push({ ...createModelRecord({ modelId: id }), source: 'configured', persisted: true });
    known.add(id);
  }
  return models;
}

function signatureOf(draft) {
  let patches = [];
  try { patches = draftPatches(draft); } catch { patches = [{ invalid: true }]; }
  return JSON.stringify({
    providerId: String(draft.providerId || '').trim(),
    displayName: String(draft.displayName || '').trim(),
    authMode: draft.authMode,
    connection: draft.connection,
    enabled: draft.enabled,
    catalogId: draft.catalogId || null,
    envReference: String(draft.envReference || '').trim(),
    piRegistrationReference: String(draft.piRegistrationReference || '').trim(),
    selectedModelIds: draft.order,
    modelPatches: patches,
    removed: draft.removed,
    credentialAction: draft.credentialAction,
    confirmBuiltinOverride: Boolean(draft.confirmBuiltinOverride),
  });
}

function finish(draft) {
  return {
    ...draft,
    dirty: signatureOf(draft) !== draft.initialSignature,
    revision: (draft.revision || 0) + 1,
  };
}

function baseDraft(fields) {
  const draft = {
    mode: 'create',
    sourceServiceId: null,
    serviceId: null,
    providerId: '',
    catalogId: null,
    displayName: '',
    authMode: 'none',
    connection: null,
    enabled: true,
    models: [],
    order: [],
    removed: [],
    removedModels: {},
    envReference: '',
    piRegistrationReference: '',
    credentialAction: { type: 'keep' },
    // P5：受限窗暂存结果。只描述「哪个草稿代次暂存了什么」，不含任何密钥值。
    nativeStage: null,
    confirmBuiltinOverride: false,
    inheritedSelection: false,
    touchedSelection: false,
    credentialState: { state: 'none', source: 'none' },
    readOnly: false,
    compatibility: null,
    sourceState: null,
    revision: 0,
    dirty: false,
    touched: false,
    requestIds: {},
    requestIdKeys: {},
    savedState: null,
    conflict: null,
    ...fields,
  };
  draft.initialSignature = signatureOf(draft);
  return { ...draft, dirty: false };
}

export function draftFromService(service, snapshot, mode = 'edit') {
  const models = serviceModels(service);
  const order = selectedOrder(service);
  const serviceConnection = copyConnection(service?.connection);
  const draft = baseDraft({
    // 编辑既有服务在合同里叫 update；'edit' 只是对话框的入口名。
    mode: mode === 'edit' ? 'update' : mode,
    sourceServiceId: service?.serviceId || null,
    serviceId: service?.serviceId || null,
    providerId: service?.providerId || service?.serviceId || '',
    catalogId: service?.catalogId || null,
    displayName: service?.displayName || service?.providerId || '',
    authMode: service?.authMode || (service?.credentialState?.source === 'env' ? 'environment' : 'none'),
    connection: serviceConnection,
    enabled: service?.enabled !== false,
    models,
    order,
    inheritedSelection: !Array.isArray(service?.selectedModelIds),
    credentialState: service?.credentialState ? { ...service.credentialState } : { state: 'none', source: 'none' },
    readOnly: service?.readOnly === true,
    compatibility: service?.compatibility || null,
    sourceState: {
      displayName: service?.displayName || '',
      providerId: service?.providerId || '',
      connection: serviceConnection ? { ...serviceConnection } : null,
      authMode: service?.authMode || 'none',
      enabled: service?.enabled !== false,
      order: [...order],
      models: models.map(model => ({ modelId: model.modelId, ...model.baseline })),
      credentialState: service?.credentialState ? { ...service.credentialState } : null,
    },
  });
  return draft;
}

export function draftFromCatalog(snapshot, item, { mode = 'create', existingIds = [] } = {}) {
  const requestedId = item?.providerId || item?.id || 'provider';
  const providerId = existingIds.includes(requestedId)
    ? suggestProviderId(item?.name || requestedId, existingIds, requestedId)
    : suggestProviderId(requestedId, existingIds, requestedId);
  const envReference = typeof item?.suggestedEnvReference === 'string' ? item.suggestedEnvReference : '';
  const connection = copyConnection(item?.connection)
    || (item?.id === 'custom' ? { baseUrl: '', api: 'openai-completions' } : null);
  return baseDraft({
    mode,
    catalogId: item?.id || null,
    providerId,
    displayName: item?.name || providerId,
    authMode: item?.authMode || (envReference ? 'environment' : 'none'),
    connection,
    envReference,
    credentialAction: envReference ? { type: 'env', reference: envReference } : { type: 'keep' },
    models: [],
    order: [],
  });
}

export function draftFromClone(service, snapshot, providerId) {
  const base = draftFromService(service, snapshot, 'clone');
  const displayName = `${base.displayName || base.providerId} 副本`.slice(0, 200);
  const draft = {
    ...base,
    mode: 'clone',
    serviceId: null,
    sourceServiceId: service?.serviceId || null,
    providerId,
    displayName,
    authMode: 'none',
    envReference: '',
    piRegistrationReference: '',
    credentialAction: { type: 'keep' },
    credentialState: { state: 'none', source: 'none' },
    enabled: true,
    inheritedSelection: false,
  };
  draft.initialSignature = signatureOf(draft);
  return { ...draft, dirty: false };
}

export function effectiveAuthMode(draft) {
  if (draft.mode === 'clone') return 'none';
  if (draft.authMode === 'oauth') return 'oauth';
  if (String(draft.envReference || '').trim()) return 'environment';
  if (draft.credentialAction?.type === 'none' && !String(draft.piRegistrationReference || '').trim()) return 'none';
  if (draft.mode === 'create' && draft.authMode === 'environment' && !String(draft.envReference || '').trim()) return 'none';
  return draft.authMode || 'none';
}

/* 配置里的凭据引用与 Pi 原生凭据是两种东西：
 * `none` 只删除 models.json 中的 apiKey 字段，不会调用 Pi logout，
 * 因此绝不能把它当成“本机凭据已清除”。 */
export function credentialClearSupport(draft, { native = false } = {}) {
  const credential = draft?.credentialState;
  const source = credential?.source;
  if (source === 'env') {
    return {
      supported: true,
      source,
      label: '环境变量引用',
      message: '保存后会移除 Pi 模型配置中的环境变量引用；环境变量本身和 Pi 本机登录都不会被删除。',
    };
  }
  if (source === 'literal') {
    return {
      supported: true,
      source,
      label: '配置内字面量密钥',
      message: '保存后会删除 Pi 模型配置中的字面量 apiKey；Pi 本机登录不会被删除。',
    };
  }
  if (source === 'command') {
    return {
      supported: true,
      source,
      label: '配置内命令引用',
      message: '保存后会删除 Pi 模型配置中的命令取值引用；命令本身和 Pi 本机登录都不会被删除。',
    };
  }
  if (source === 'pi-credential') {
    if (native === true) {
      return {
        supported: true,
        native: true,
        source,
        label: 'Pi 本机凭据',
        message: '将通过受限制的安全桌面窗口确认清除；清除后旧的本机登录/密钥无法从 GUI 恢复，模型配置与环境变量不受影响。',
      };
    }
    return {
      supported: false,
      source,
      reason: 'Pi 本机凭据需要在桌面版的安全凭据窗口中清除；网页版或私有桥不可用时不会用“删除配置引用”冒充已清除。',
    };
  }
  return {
    supported: false,
    source: source || 'unknown',
    reason: '凭据来源未知，无法安全判断清除范围；请先确认该服务在 Pi 中的认证来源。',
  };
}

export function needsInheritedSelectionConfirmation(draft) {
  // P0 的 commit 只能提交显式 selectedModelIds，无法表达“继续继承”。
  // 因此无关编辑也必须先让用户确认固定，不能静默改变选择策略。
  return draft?.mode === 'update'
    && draft.inheritedSelection === true
    && draft.touchedSelection !== true;
}

export function commitCredentialAction(draft) {
  if (draft.mode === 'clone') return { type: 'keep' };
  if (draft.nativeStage?.action === 'set') return { type: 'apply-staged' };
  if (draft.nativeStage?.action === 'clear') return { type: 'clear-native' };
  const reference = String(draft.envReference || '').trim();
  if (reference) return { type: 'env', reference };
  if (draft.credentialAction?.type === 'none' && credentialClearSupport(draft).supported) {
    return { type: 'none', confirmed: true };
  }
  return { type: 'keep' };
}

export function modelPatchFor(draft, model) {
  if (draft.removed.includes(model.modelId)) return { modelId: model.modelId, operation: 'remove' };
  const set = {};
  const unsetFields = [];
  for (const field of EDITABLE_MODEL_FIELDS) {
    const value = model[field];
    const baseline = model.baseline?.[field];
    if (field === 'input') {
      const next = copyInput(value);
      const before = copyInput(baseline);
      if (!next) {
        if (before) unsetFields.push(field);
      } else if (JSON.stringify(next) !== JSON.stringify(before)) {
        set.input = next;
      }
      continue;
    }
    if (field === 'name') {
      const next = typeof value === 'string' ? value.trim() : '';
      const before = typeof baseline === 'string' ? baseline : null;
      if (!next) {
        if (before) unsetFields.push(field);
      } else if (next !== before) set.name = next;
      continue;
    }
    if (field === 'reasoning') {
      const next = tri(value);
      const before = tri(baseline);
      if (next === null) {
        if (before !== null) unsetFields.push(field);
      } else if (next !== before) set.reasoning = next;
      continue;
    }
    const next = positiveOrNull(value);
    const before = positiveOrNull(baseline);
    if (next === null) {
      if (before !== null) unsetFields.push(field);
    } else if (next !== before) set[field] = next;
  }
  const remoteCandidate = model.source === 'remote' || model.source === 'cache';
  if (model.source === 'manual' && model.persisted === false) {
    return { modelId: model.modelId, operation: 'upsert', ...(Object.keys(set).length ? { set } : {}), ...(unsetFields.length ? { unsetFields } : {}) };
  }
  // 远端发现只提供候选；只有被用户选中的候选才写入 Pi 配置。
  if (remoteCandidate) {
    if (!draft.order.includes(model.modelId)) return null;
    return { modelId: model.modelId, operation: 'upsert', ...(Object.keys(set).length ? { set } : {}), ...(unsetFields.length ? { unsetFields } : {}) };
  }
  if (!Object.keys(set).length && !unsetFields.length) return null;
  return { modelId: model.modelId, operation: 'upsert', ...(Object.keys(set).length ? { set } : {}), ...(unsetFields.length ? { unsetFields } : {}) };
}

export function draftPatches(draft) {
  const patches = [];
  for (const model of draft.models) {
    const patch = modelPatchFor(draft, model);
    if (patch) patches.push(patch);
  }
  for (const modelId of draft.removed) {
    if (draft.models.some(model => model.modelId === modelId)) continue;
    patches.push({ modelId, operation: 'remove' });
  }
  return patches;
}

export function toDraftPayload(draft) {
  const connection = validateConnection({
    baseUrl: String(draft.connection?.baseUrl || '').trim(),
    api: draft.connection?.api || 'openai-completions',
  });
  const payload = {
    providerId: String(draft.providerId || '').trim(),
    authMode: effectiveAuthMode(draft),
    displayName: String(draft.displayName || '').trim(),
    connection,
    modelPatches: draftPatches(draft),
    selectedModelIds: [...draft.order],
    modelOrder: [...draft.order],
    enabled: draft.enabled !== false,
  };
  if (draft.catalogId) payload.catalogId = draft.catalogId;
  if (draft.mode !== 'clone' && String(draft.piRegistrationReference || '').trim()) {
    payload.piRegistrationReference = String(draft.piRegistrationReference).trim();
  }
  if (draft.mode === 'update' && draft.sourceServiceId) payload.serviceId = draft.sourceServiceId;
  if (draft.confirmBuiltinOverride) payload.confirmBuiltinOverride = true;
  return payload;
}

export function validateDraft(draft) {
  const errors = {};
  const modelErrors = {};
  const displayName = String(draft.displayName || '').trim();
  if (!displayName) errors.displayName = '请填写服务名称';
  else if (displayName.length > 200) errors.displayName = '服务名称不能超过 200 个字符';
  if (draft.mode !== 'update') {
    const providerId = String(draft.providerId || '').trim();
    if (!isProviderId(providerId)) errors.providerId = '标识只能包含字母、数字、点、下划线和连字符（1–64 位）';
  }
  if (draft.authMode !== 'oauth') {
    try {
      validateConnection({
        baseUrl: String(draft.connection?.baseUrl || '').trim(),
        api: draft.connection?.api || 'openai-completions',
      });
    } catch {
      errors.connection = 'Base URL 必须是 http(s) 地址，且不能包含凭据、查询参数或片段';
    }
    if (!PROVIDER_API_TYPES.includes(draft.connection?.api)) errors.connectionApi = '请选择受支持的 API 类型';
  }
  const envReference = String(draft.envReference || '').trim();
  if (envReference && !isEnvReference(envReference)) errors.envReference = '只接受 $NAME 或 ${NAME} 形式的环境变量引用';
  const piReference = String(draft.piRegistrationReference || '').trim();
  if (piReference) {
    if (draft.mode === 'clone') errors.piRegistrationReference = '复制不会携带本机注册引用';
    else if (!isEnvReference(piReference)) errors.piRegistrationReference = '只接受 $NAME 或 ${NAME} 形式的环境变量引用';
    else if (effectiveAuthMode(draft) !== 'none') errors.piRegistrationReference = '本机注册引用只用于无凭据的本地服务';
    else {
      try {
        const host = new URL(String(draft.connection?.baseUrl || '').trim()).hostname;
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) errors.piRegistrationReference = '本机注册引用只支持本机端点';
      } catch { errors.piRegistrationReference = '请先填写有效的 Base URL'; }
    }
  }
  const seen = new Set();
  for (const model of draft.models) {
    const modelError = {};
    if (!isModelId(model.modelId)) modelError.modelId = '模型 ID 不能为空，且不能使用保留名称';
    else if (seen.has(model.modelId)) modelError.modelId = '模型 ID 重复';
    seen.add(model.modelId);
    if (model.name && (typeof model.name !== 'string' || model.name.trim() !== model.name || model.name.length > 200)) {
      modelError.name = '显示名不能超过 200 个字符，且首尾不能有空格';
    }
    for (const field of ['contextWindow', 'maxTokens']) {
      if (model[field] !== null && model[field] !== undefined && !(Number.isSafeInteger(model[field]) && model[field] > 0)) {
        modelError[field] = '必须是正整数';
      }
    }
    if (model.contextWindow && model.maxTokens && model.maxTokens > model.contextWindow) {
      modelError.maxTokens = '输出上限不能大于上下文窗口';
    }
    if (!Array.isArray(model.input) || !model.input.length) {
      if (model.input !== null && model.input !== undefined) modelError.input = '至少选择一种输入类型';
    }
    for (const field of ['contextWindow', 'maxTokens', 'reasoning', 'input', 'name']) {
      if (modelError[field]) continue;
      const probe = {};
      if (model[field] !== null && model[field] !== undefined && !(field === 'input' && !model.input.length)) probe[field] = model[field];
      if (!Object.keys(probe).length) continue;
      try { validateModelValues(probe); } catch { modelError[field] = '字段值不符合要求'; }
    }
    if (Object.keys(modelError).length) modelErrors[model.modelId] = modelError;
  }
  for (const id of draft.order) {
    if (!draft.models.some(model => model.modelId === id)) errors.selectedModelIds = `已选模型 ${id} 不在候选列表中`;
  }
  if (draftPatches(draft).length > 3000) errors.modelPatches = '模型变更超过 3000 条';
  return {
    ok: Object.keys(errors).length === 0 && Object.keys(modelErrors).length === 0,
    errors,
    modelErrors,
  };
}

export function needsBuiltinOverride(draft) {
  if (draft.confirmBuiltinOverride) return false;
  return draftPatches(draft).length > 0
    && draft.models.some(model => model.source === 'builtin-override');
}

export function setEnvReference(draft, value) {
  const reference = String(value || '');
  return finish({
    ...draft,
    envReference: reference,
    // 配置里的环境变量引用与 Pi 本机凭据是不同槽位；改引用即放弃暂存。
    nativeStage: null,
    credentialAction: reference.trim() ? { type: 'env', reference: reference.trim() } : { type: 'keep' },
    authMode: reference.trim() ? 'environment' : draft.mode === 'create' && draft.authMode === 'environment' ? 'none' : draft.authMode,
    requestIds: {},
  });
}

export function clearCredential(draft) {
  return finish({
    ...draft,
    envReference: '',
    authMode: 'none',
    nativeStage: null,
    credentialAction: { type: 'none', confirmed: true },
    requestIds: {},
  });
}

export function setModelField(draft, modelId, field, value) {
  if (!EDITABLE_MODEL_FIELDS.includes(field)) return draft;
  const models = draft.models.map(model => {
    if (model.modelId !== modelId) return model;
    if (field === 'input') return { ...model, input: copyInput(value) };
    if (field === 'reasoning') return { ...model, reasoning: tri(value) };
    if (field === 'name') return { ...model, name: value === null ? null : String(value) };
    return { ...model, [field]: value === '' || value === null ? null : Number(value) };
  });
  return finish({ ...draft, models, requestIds: {} });
}

export function addModel(draft, modelId) {
  const id = String(modelId || '').trim();
  if (!id) return { ...draft, error: '请填写模型 ID' };
  if (draft.models.some(model => model.modelId === id)) return { ...draft, error: '模型 ID 已存在' };
  // 先移除再加回同一个 ID 时，必须同时撤销 remove 补丁并恢复原记录；
  // 否则 payload 会同时出现 remove 与 selectedModelIds 中的该 ID。
  const restored = plainRecord(draft.removedModels?.[id]) ? draft.removedModels[id] : null;
  const model = restored ? { ...restored } : createManualModel(id);
  const removedModels = { ...(draft.removedModels || {}) };
  delete removedModels[id];
  return finish({
    ...draft,
    models: [...draft.models, model],
    order: [...draft.order, id],
    removed: draft.removed.filter(item => item !== id),
    removedModels,
    touchedSelection: true,
    requestIds: {},
    error: '',
  });
}

export function removeModel(draft, modelId) {
  const model = draft.models.find(item => item.modelId === modelId);
  if (!model) return draft;
  const shouldRemove = model.persisted || model.source !== 'manual';
  const removed = shouldRemove
    ? [...new Set([...draft.removed, modelId])]
    : draft.removed;
  const removedModels = { ...(draft.removedModels || {}) };
  if (shouldRemove) removedModels[modelId] = model;
  else delete removedModels[modelId];
  return finish({
    ...draft,
    models: draft.models.filter(item => item.modelId !== modelId),
    order: draft.order.filter(id => id !== modelId),
    removed,
    removedModels,
    touchedSelection: true,
    requestIds: {},
  });
}

/* 缓存候选在拿到新鲜远端结果时升级为远端记录（仅当用户没有编辑过它）。
 * 编辑过的记录保留用户输入，避免刷新覆盖手动参数。 */
function untouchedRecord(model) {
  return EDITABLE_MODEL_FIELDS.every(field => {
    const value = model[field];
    const baseline = model.baseline?.[field];
    if (field === 'input') return JSON.stringify(copyInput(value)) === JSON.stringify(copyInput(baseline));
    if (field === 'reasoning') return tri(value) === tri(baseline);
    if (field === 'name') return (typeof value === 'string' ? value.trim() : '') === (typeof baseline === 'string' ? baseline : '');
    return positiveOrNull(value) === positiveOrNull(baseline);
  });
}

export function mergeFetchedModels(draft, incoming) {
  // 只增不减：迟到的发现结果不能把用户已经选中的模型或编辑中的值冲掉。
  const byId = new Map(draft.models.map(model => [model.modelId, model]));
  const models = [...draft.models];
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const id = String(raw?.modelId || raw?.id || '').trim();
    if (!id) continue;
    const existing = byId.get(id);
    if (existing) {
      /* 缓存首屏 -> 新鲜远端结果：升级来源与显示信息；选择 order 不受影响。 */
      const incomingKind = raw.configSource === 'remote' ? 'remote' : raw.configSource === 'cache' ? 'cache' : null;
      if (existing.source === 'cache' && incomingKind === 'remote' && untouchedRecord(existing)) {
        const index = models.findIndex(model => model.modelId === id);
        if (index >= 0) {
          const record = createModelRecord({ ...raw, modelId: id, cacheStale: false });
          models[index] = record;
          byId.set(id, record);
        }
      }
      continue;
    }
    const record = createModelRecord({ ...raw, modelId: id });
    byId.set(id, record);
    models.push(record);
  }
  return finish({ ...draft, models, requestIds: {} });
}

/* 用户重新勾选（包括刷新后重新出现的候选）时撤销待删除记录。 */
function withoutPendingRemoval(draft, ids) {
  if (!draft?.removed?.length || !Array.isArray(ids) || !ids.length) return draft;
  const drop = new Set(ids.filter(id => draft.removed.includes(id)));
  if (!drop.size) return draft;
  const removedModels = { ...(draft.removedModels || {}) };
  for (const id of drop) delete removedModels[id];
  return { ...draft, removed: draft.removed.filter(id => !drop.has(id)), removedModels };
}

function reduce(draft, action) {
  switch (action.type) {
    case 'field': {
      const allowed = ['displayName', 'enabled', 'providerId', 'piRegistrationReference'];
      if (!allowed.includes(action.field)) return draft;
      // 换供应商标识/本机注册引用等于换凭据目标，暂存批准不再适用。
      const dropStage = action.field === 'providerId' || action.field === 'piRegistrationReference';
      return finish({ ...draft, [action.field]: action.value, ...(dropStage ? { nativeStage: null } : {}), requestIds: {} });
    }
    case 'connection': {
      return finish({ ...draft, connection: copyConnection(action.connection), nativeStage: null, requestIds: {} });
    }
    case 'connection-field': {
      return finish({
        ...draft,
        connection: { ...(draft.connection || { baseUrl: '', api: 'openai-completions' }), [action.field]: action.value },
        nativeStage: null,
        requestIds: {},
      });
    }
    case 'env-reference': return setEnvReference(draft, action.value);
    case 'clear-credential': return clearCredential(draft);
    case 'auth-mode': {
      if (!['environment', 'none', 'pi-credential'].includes(action.authMode)) return draft;
      return finish({ ...draft, authMode: action.authMode, ...(action.authMode === 'pi-credential' ? {} : { nativeStage: null }), requestIds: {} });
    }
    case 'native-stage': {
      const stage = action.stage;
      if (!stage || !['set', 'clear'].includes(stage.action) || typeof stage.draftId !== 'string') return draft;
      return finish({ ...draft, nativeStage: {
        action: stage.action,
        draftId: stage.draftId,
        connectionRevision: Number.isSafeInteger(stage.connectionRevision) ? stage.connectionRevision : null,
      }, requestIds: {} });
    }
    case 'native-stage-clear': {
      if (!draft.nativeStage) return draft;
      return finish({ ...draft, nativeStage: null, requestIds: {} });
    }
    case 'toggle-model': {
      /* P6：重新勾选一个曾经移除、又被刷新重新带回候选的模型时，必须撤销
       * 待删除补丁；否则同一 ID 同时出现在 remove 补丁与 selectedModelIds 里，
       * 服务端会以 invalid_request 拒绝保存。 */
      const base = action.selected === true ? withoutPendingRemoval(draft, [action.modelId]) : draft;
      return finish({
        ...base,
        order: toggleSelection(base.order, action.modelId, action.selected),
        touchedSelection: true,
        requestIds: {},
      });
    }
    case 'select-visible': {
      const base = action.selected === true
        ? withoutPendingRemoval(draft, action.visibleIds.filter(id => !draft.order.includes(id)))
        : draft;
      return finish({
        ...base,
        order: setVisibleSelection(base.order, action.visibleIds, action.selected, base.models.map(model => model.modelId)),
        touchedSelection: true,
        requestIds: {},
      });
    }
    case 'move-model': {
      return finish({ ...draft, order: moveByOffset(draft.order, action.modelId, action.offset), requestIds: {} });
    }
    case 'move-before': {
      return finish({ ...draft, order: moveBefore(draft.order, action.modelId, action.targetId), requestIds: {} });
    }
    case 'move-to-index': {
      return finish({ ...draft, order: moveToIndex(draft.order, action.modelId, action.index), requestIds: {} });
    }
    case 'model-field': return setModelField(draft, action.modelId, action.field, action.value);
    case 'add-model': return addModel(draft, action.modelId);
    case 'remove-model': return removeModel(draft, action.modelId);
    case 'merge-models': return mergeFetchedModels(draft, action.models);
    case 'builtin-override': return finish({ ...draft, confirmBuiltinOverride: true, requestIds: {} });
    case 'mark-saved': {
      // 保存收据落地后暂存批准已被消费（成功）或已失效（失败）；不再保留。
      // action.serviceId 用于「配置已保存、凭据失败」：草稿转为对已存在服务的更新，
      // 用户重试时不会再走一次 create。
      const saved = {
        ...draft,
        savedState: action.state || 'saved',
        ...(typeof action.serviceId === 'string' && action.serviceId
          ? { mode: 'update', serviceId: action.serviceId, sourceServiceId: action.serviceId }
          : {}),
        nativeStage: null,
        requestIds: {},
        initialSignature: '',
      };
      saved.initialSignature = signatureOf(saved);
      return { ...saved, dirty: false, revision: (draft.revision || 0) + 1 };
    }
    case 'conflict': return { ...draft, conflict: action.conflict || { code: 'config_conflict' }, revision: draft.revision + 1 };
    case 'clear-conflict': return { ...draft, conflict: null, revision: draft.revision + 1 };
    case 'clear-error': return { ...draft, error: '', revision: draft.revision + 1 };
    default: return draft;
  }
}

export function reduceDraft(draft, action) {
  return reduce(draft, action);
}

export function createDraftStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    dispatch(action) {
      const next = reduceDraft(state, action);
      if (next === state) return state;
      state = next;
      for (const listener of [...listeners]) {
        try { listener(state, action); } catch { /* 一个视图炸了不该让其它视图失联 */ }
      }
      return state;
    },
    replace(next) {
      state = next;
      for (const listener of [...listeners]) {
        try { listener(state, { type: 'replace' }); } catch { /* ignore */ }
      }
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function visibleSelectionState(models, order) {
  return {
    allSelected: allVisibleSelected(models, order),
    selectedCount: order.length,
  };
}

export function newRequestId(prefix = 'pm') {
  const cryptoApi = globalThis.crypto;
  const random = cryptoApi && typeof cryptoApi.randomUUID === 'function'
    ? cryptoApi.randomUUID().replace(/-/g, '').slice(0, 24)
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${random}`.slice(0, 128);
}

export function ensureRequestId(draft, phase, key = '') {
  // 同一内容重传要复用 ID；revision、草稿句柄或内容变化时必须换新 ID，
  // 否则服务端会把新请求判成 request_id_conflict。
  if (draft.requestIds?.[phase] && draft.requestIdKeys?.[phase] === key) return draft.requestIds[phase];
  const id = newRequestId(phase === 'commit' ? 'commit' : 'draft');
  draft.requestIds = { ...(draft.requestIds || {}), [phase]: id };
  draft.requestIdKeys = { ...(draft.requestIdKeys || {}), [phase]: key };
  return id;
}

export function draftSummary(draft) {
  return {
    providerId: draft.providerId,
    displayName: draft.displayName,
    modelCount: draft.order.length,
    credentials: draft.credentialAction,
    authMode: effectiveAuthMode(draft),
    dirty: draft.dirty,
  };
}

export function sortModels(models, order) {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...models].sort((a, b) => (rank.get(a.modelId) ?? 1e9) - (rank.get(b.modelId) ?? 1e9) || a.modelId.localeCompare(b.modelId));
}
