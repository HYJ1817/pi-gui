import { EDITABLE_MODEL_FIELDS, PROVIDER_API_TYPES, PROVIDER_CATALOG, isProviderId, isRecord, providerFailure, validateConnection, validateModelValues } from '../public/provider-management/contract.js';

export const own = (record, key) => record && Object.hasOwn(record, key) ? record[key] : undefined;
const presetTargets = new Map(PROVIDER_CATALOG.filter(item => item.connection).map(item => [item.id, item.connection]));
const fallbackNativeIds = new Set(['openai','anthropic','google','deepseek','openrouter']);
export const isBuiltinProvider = (id, evidence) => evidence?.builtIn ?? fallbackNativeIds.has(id);
const safeProviderFields = new Set(['name','baseUrl','api','models','modelOverrides']);
const targetNeutralProviderFields = new Set(['name','modelOverrides']);
const safeModelFields = new Set(['id','name','api','reasoning','input','contextWindow','maxTokens','cost','capabilities','thinkingLevelMap']);
const safeOverrideFields = new Set(EDITABLE_MODEL_FIELDS);
const unsupportedModelFlags = new Set(['toolCalling','streaming','textInput','imageInput','reasoning']);

export function targetChanged(previous, next) {
  if (!previous) return false;
  try {
    const old = validateConnection({ baseUrl: previous.baseUrl, api: previous.api ?? 'openai-completions' });
    return old.baseUrl !== next.baseUrl || old.api !== next.api;
  } catch { return true; }
}

function onlyKnownFields(value, allowed) {
  return isRecord(value) && Object.keys(value).every(key => allowed.has(key));
}
function safeModelWithoutAuthentication(model, allowed) {
  return onlyKnownFields(model, allowed) &&
    (!Object.hasOwn(model, 'capabilities') || onlyKnownFields(model.capabilities, unsupportedModelFlags));
}

export function guardExistingTarget(providerId, previous, next, credential) {
  if (previous?.api != null && !PROVIDER_API_TYPES.includes(previous.api)) providerFailure('unsupported');
  if (!targetChanged(previous, next)) return;
  if (!onlyKnownFields(previous, safeProviderFields) || credential?.present !== false || credential?.builtIn !== false ||
    (Object.hasOwn(previous,'models') && (!Array.isArray(previous.models) || previous.models.some(model => !safeModelWithoutAuthentication(model, safeModelFields)))) ||
    (Object.hasOwn(previous,'modelOverrides') && (!isRecord(previous.modelOverrides) || Object.values(previous.modelOverrides).some(model => !safeModelWithoutAuthentication(model, safeOverrideFields))))) {
    providerFailure('credential_target_conflict');
  }
}

export function guardNativeCredentialTarget({ config, metadata }, draft, credential, action) {
  const previous = own(config.providers, draft.providerId);
  if (credential?.builtIn !== false || own(metadata.services, draft.providerId)?.kind === 'builtin') providerFailure('unsupported');
  if (action === 'clear-native') return;
  if (!draft.connection.baseUrl.startsWith('https://') || (previous && (
      !onlyKnownFields(previous, safeProviderFields) ||
      (Object.hasOwn(previous, 'models') && (!Array.isArray(previous.models) || previous.models.some(model =>
        !safeModelWithoutAuthentication(model, safeModelFields) || (model.api && model.api !== draft.connection.api)))) ||
      (Object.hasOwn(previous, 'modelOverrides') && (!isRecord(previous.modelOverrides) ||
        Object.values(previous.modelOverrides).some(model => !safeModelWithoutAuthentication(model, safeOverrideFields))))))) {
    providerFailure('credential_target_conflict');
  }
}

function checkNewId(providerId, credential) {
  if (credential?.present !== false) providerFailure('credential_conflict');
  if (credential.builtIn === true) providerFailure('credential_target_conflict');
  if (credential.builtIn !== false) providerFailure('unsupported');
}

export function applyLegacyProvider(snapshot, providerId, next, credential) {
  const previous = own(snapshot.config.providers, providerId);
  if (previous !== undefined && !isRecord(previous)) providerFailure('config_invalid');
  if (previous) guardExistingTarget(providerId, previous, next, credential);
  else {
    const preset = presetTargets.get(providerId);
    if (!preset || targetChanged(preset, next)) checkNewId(providerId, credential);
    else if (credential?.present !== false) providerFailure('credential_conflict');
  }
  const previousModels = Array.isArray(previous?.models) ? previous.models : [];
  if ((Object.hasOwn(previous ?? {}, 'models') && !Array.isArray(previous.models)) ||
      previousModels.some(model => !isRecord(model) || typeof model.id !== 'string') ||
      new Set(previousModels.map(model => model.id)).size !== previousModels.length) providerFailure('config_invalid');
  const existing = new Map(previousModels.map(model => [model.id, model]));
  const models = next.models.map(model => {
    const old = existing.get(model.id);
    if (model.capabilities && Object.hasOwn(old ?? {}, 'capabilities') && !isRecord(old.capabilities)) providerFailure('config_invalid');
    const merged = editModel(old, { set: model });
    if (model.capabilities && old?.capabilities) merged.capabilities = { ...old.capabilities, ...model.capabilities };
    return merged;
  });
  const merged = { ...previous, ...next, models };
  if (previous && !targetChanged(previous, next)) preserveTarget(merged, previous);
  snapshot.config.providers[providerId] = merged;
  snapshot.metadata.syncRequired = true;
  return snapshot.config.providers[providerId];
}

function editModel(model, patch) {
  const next = { ...model, ...patch.set };
  for (const field of patch.unsetFields ?? []) delete next[field];
  if ((patch.set?.contextWindow !== undefined || patch.set?.maxTokens !== undefined) &&
      Number.isSafeInteger(next.contextWindow) && Number.isSafeInteger(next.maxTokens) && next.maxTokens > next.contextWindow) {
    providerFailure('invalid_request', 'modelPatches');
  }
  return next;
}

function preserveTarget(next, previous) {
  for (const field of ['baseUrl','api']) {
    if (Object.hasOwn(previous,field)) next[field] = previous[field];
    else delete next[field];
  }
}

function editableClone(model) {
  if (!isRecord(model) || typeof model.id !== 'string') return null;
  const next = { id: model.id };
  for (const field of EDITABLE_MODEL_FIELDS) {
    if (!Object.hasOwn(model, field)) continue;
    try { validateModelValues({ [field]: model[field] }); next[field] = model[field]; }
    catch { /* Existing unsupported values are preserved on the source only. */ }
  }
  return next;
}

export function removeProviderRecord({ config, metadata }, providerId, { builtin = false, credential } = {}) {
  if (!isProviderId(providerId) || (!Object.hasOwn(config.providers, providerId) && !Object.hasOwn(metadata.services, providerId))) providerFailure('not_found');
  if (builtin) {
    metadata.services[providerId] = { ...own(metadata.services, providerId), providerId, kind: 'builtin', enabled: false };
  } else {
    const previous = own(config.providers, providerId);
    if (previous !== undefined && credential?.builtIn !== false &&
        (!onlyKnownFields(previous, targetNeutralProviderFields) ||
          (Object.hasOwn(previous, 'modelOverrides') && (!isRecord(previous.modelOverrides) ||
            Object.values(previous.modelOverrides).some(model => !safeModelWithoutAuthentication(model, safeOverrideFields)))))) {
      // Removing an Endpoint or an unclassified override can restore a
      // different native target while leaving its credential or env slot live.
      providerFailure('credential_target_conflict');
    }
    delete config.providers[providerId];
    delete metadata.services[providerId];
  }
  metadata.syncRequired = true;
}

function applyBuiltin(config, metadata, draft) {
  const previous = own(config.providers, draft.providerId);
  if (previous !== undefined && !isRecord(previous)) providerFailure('config_invalid');
  if (!draft.modelPatches.length) return;
  if (!previous?.modelOverrides && draft.confirmBuiltinOverride !== true) providerFailure('invalid_request', 'confirmBuiltinOverride');
  if (Object.hasOwn(previous ?? {}, 'modelOverrides') && !isRecord(previous.modelOverrides)) providerFailure('config_invalid');
  const overrides = { ...previous?.modelOverrides };
  const owned = { ...metadata.ownedOverrides };
  for (const patch of draft.modelPatches) {
    const old = own(overrides, patch.modelId);
    if (old !== undefined && !isRecord(old)) providerFailure('config_invalid');
    const oldOwned = own(owned, patch.modelId) ?? {};
    const model = patch.operation === 'remove' ? { ...old } : editModel(old, patch);
    const nextOwned = { ...oldOwned };
    if (patch.operation === 'remove') {
      for (const field of EDITABLE_MODEL_FIELDS) {
        if (Object.hasOwn(oldOwned, field) && JSON.stringify(oldOwned[field]) === JSON.stringify(model[field])) delete model[field];
      }
      delete owned[patch.modelId];
    } else {
      for (const field of patch.unsetFields ?? []) delete nextOwned[field];
      Object.assign(nextOwned, patch.set);
      owned[patch.modelId] = nextOwned;
    }
    if (Object.keys(model).length) overrides[patch.modelId] = model;
    else delete overrides[patch.modelId];
  }
  if (previous || Object.keys(overrides).length) config.providers[draft.providerId] = { ...previous, modelOverrides: overrides };
  metadata.ownedOverrides = owned;
}

export function applyProviderCommit(snapshot, request, draft, credential) {
  const { config, metadata } = snapshot;
  const id = draft?.providerId ?? request.serviceId;
  const previous = own(config.providers, id);
  const previousMeta = own(metadata.services, id);
  const exists = previous !== undefined || previousMeta !== undefined;
  const builtin = isBuiltinProvider(id, credential) || previousMeta?.kind === 'builtin';
  if (request.action === 'delete') {
    removeProviderRecord(snapshot, id, { builtin, credential });
  } else if (request.action === 'disable' || request.action === 'enable') {
    /* P6：enable 与 disable 对称——OAuth/订阅服务没有可写端点草稿，停用后必须
     * 有恢复入口；两者都只改 GUI 元数据，不触碰 Pi 配置与认证。 */
    if (!exists) providerFailure('not_found');
    metadata.services[id] = { ...previousMeta, providerId: id, enabled: request.action === 'enable' };
    metadata.syncRequired = true;
  } else {
    const cloning = request.action === 'clone';
    if (request.action === 'update' && (!exists || id !== request.serviceId)) providerFailure('not_found');
    if (request.action !== 'update' && exists) providerFailure('provider_exists');
    if (previous !== undefined && !isRecord(previous)) providerFailure('config_invalid');
    const action = request.credentialAction?.type ?? 'keep';
    if (cloning && (action !== 'keep' || draft.authMode !== 'none' || draft.piRegistrationReference)) providerFailure('invalid_request', 'credentialAction');
    const service = { ...previousMeta, providerId: id, displayName: draft.displayName,
      ...(draft.catalogId ? { catalogId: draft.catalogId } : {}), enabled: draft.enabled,
      selectedModelIds: draft.selectedModelIds, modelOrder: draft.modelOrder, kind: builtin ? 'builtin' : 'custom' };
    if (builtin) {
      if (cloning || draft.piRegistrationReference) providerFailure('unsupported');
      /* P6：内置供应商的环境变量引用与旧入口一致地允许写入——目录卡片预填的
       * $NAME 引用必须有落盘路径，否则「添加内置 API Key 供应商」的主流程
       * 在管理界面里无法保存。原生化（apply-staged/clear-native）仍不开放：
       * 内置 Endpoint 没有 SDK 证据能精确证明目标。 */
      if (!['keep', 'env', 'none'].includes(action)) providerFailure('unsupported');
      if (previous?.baseUrl) guardExistingTarget(id, previous, draft.connection, credential);
      if (action === 'env') {
        /* 新建：与旧入口 applyLegacyProvider 的预设分支同一约束——只允许目录
         * 预设端点，且原生凭据槽必须可证明为空（避免 env 引用与已存登录混用）。
         * 更新：目标不变已由 guardExistingTarget 保证，只替换配置内引用。 */
        if (!previous) {
          const preset = presetTargets.get(id);
          if (!preset || targetChanged(preset, draft.connection)) providerFailure('credential_target_conflict');
          if (credential?.present !== false) providerFailure('credential_conflict');
          config.providers[id] = { baseUrl: preset.baseUrl, api: preset.api, models: [] };
        }
        config.providers[id] = { ...config.providers[id], apiKey: request.credentialAction.reference };
      } else if (action === 'none' && previous) {
        const next = { ...previous };
        delete next.apiKey;
        config.providers[id] = next;
      }
      if (draft.modelPatches.length && credential?.builtIn !== true) providerFailure('unsupported');
      applyBuiltin(config, service, draft);
    } else {
      if (!previous) checkNewId(id, credential);
      else guardExistingTarget(id, previous, draft.connection, credential);
      if (draft.authMode === 'oauth') providerFailure('unsupported');
      const source = cloning ? own(config.providers, request.serviceId) : previous;
      if (cloning && !source && !own(metadata.services, request.serviceId)) providerFailure('not_found');
      if (Object.hasOwn(source ?? {}, 'models') && !Array.isArray(source.models)) providerFailure('config_invalid');
      const sourceModels = source?.models ?? [];
      const models = new Map(sourceModels.map(model => {
        if (!isRecord(model) || typeof model.id !== 'string') providerFailure('config_invalid');
        return [model.id, cloning ? editableClone(model) : model];
      }));
      if (models.size !== sourceModels.length) providerFailure('config_invalid');
      for (const patch of draft.modelPatches) {
        if (patch.operation === 'remove') models.delete(patch.modelId);
        else models.set(patch.modelId, editModel(models.get(patch.modelId) ?? { id: patch.modelId }, patch));
      }
      if (models.size > 3000 || draft.selectedModelIds.some(modelId => !models.has(modelId))) providerFailure('invalid_request', 'selectedModelIds');
      const next = { ...previous, ...draft.connection, models: [...models.values()] };
      if (previous && !targetChanged(previous, draft.connection)) preserveTarget(next, previous);
      if (action === 'env') next.apiKey = request.credentialAction.reference;
      if (action === 'none') delete next.apiKey;
      if (draft.piRegistrationReference) {
        if (action !== 'keep' || !['127.0.0.1','localhost','[::1]'].includes(new URL(draft.connection.baseUrl).hostname)) providerFailure('invalid_request', 'piRegistrationReference');
        next.apiKey = draft.piRegistrationReference;
      }
      config.providers[id] = next;
    }
    metadata.services[id] = service;
    metadata.syncRequired = true;
  }
  return { ok: true, serviceId: id, saved: true, credentialSaved: null, credentialState: 'none', operationId: null,
    sync: { state: 'pending', reason: 'runtime_sync_pending' } };
}
