import { createHash, randomUUID } from 'node:crypto';
import { json, readBody } from './http-utils.js';
import { apiKeyState, publicProviderConfig } from './providers.js';
import { applyProviderCommit, guardNativeCredentialTarget, own } from './provider-config-records.js';
import { createNativeCommit } from './provider-management-commit.js';
import { createProviderManagementDiscovery } from './provider-management-discovery.js';
import { EDITABLE_MODEL_FIELDS, PROVIDER_API_TYPES, PROVIDER_CATALOG, PROVIDER_MANAGEMENT_SCHEMA_VERSION, isModelId, isOpaqueId, isProviderId, isRecord,
  providerContractError, providerErrorStatus, providerFailure, providerManagementCapabilities, validateModelValues, validateProviderRequest } from '../public/provider-management/contract.js';

const routeRoot = '/api/provider-management';
const draftTtlMs = 15 * 60_000;
const limit = 32;
const digest = value => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  isRecord(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');
const pendingSync = Object.freeze({ state: 'pending', reason: 'runtime_sync_pending' });
const safeText = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v) ? v : null;

function safeOverrides(model) {
  return Object.fromEntries(EDITABLE_MODEL_FIELDS.filter(key => {
    if (!Object.hasOwn(model ?? {}, key)) return false;
    try { validateModelValues({ [key]: model[key] }); return true; } catch { return false; }
  }).map(key => [key, model[key]]));
}

function projectAuth(snapshot) {
  const providers = (Array.isArray(snapshot?.providers) ? snapshot.providers : []).filter(item => isProviderId(item?.providerId)).slice(0, 300).map(item => ({
    providerId: item.providerId,
    displayName: safeText(item.displayName, 200) ?? item.providerId,
    status: ['connected','disconnected','unknown','unsupported'].includes(item.status) ? item.status : 'unknown',
    authType: ['oauth','api-key','environment'].includes(item.authType) ? item.authType : null,
    canLogin: item.canLogin === true,
    canLogout: item.canLogout === true,
    methods: (Array.isArray(item.methods) ? item.methods : []).filter(method => ['oauth','api-key','environment'].includes(method?.type)).slice(0, 8).map(method => ({
      type: method.type, canLogin: method.canLogin === true, isSubscription: method.isSubscription === true,
    })),
  }));
  const piVersion = typeof snapshot?.capability?.piVersion === 'string' && /^\d+\.\d+\.\d+$/.test(snapshot.capability.piVersion) ? snapshot.capability.piVersion : null;
  return { sdkAvailable: snapshot?.capability?.sdkAvailable === true, piVersion, providers, flow: null };
}

function projectService(id, config, meta, auth) {
  const safe = publicProviderConfig(config, id);
  const apiSupported = config?.api == null || PROVIDER_API_TYPES.includes(config.api);
  const safeModels = new Map(safe.models.map(model => [model.id, model]));
  const configModels = new Map((Array.isArray(config?.models) ? config.models : []).filter(m => isModelId(m?.id)).map(m => [m.id, m]));
  const modelIds = new Set([...configModels.keys(), ...Object.keys(config?.modelOverrides ?? {}).filter(isModelId)]);
  const models = [...modelIds].slice(0, 3000).map(modelId => {
    const local = configModels.get(modelId);
    const overrides = { ...safeOverrides(local), ...safeOverrides(own(config?.modelOverrides, modelId)) };
    const projected = safeModels.get(modelId);
    return { modelId, providerId: id, configSource: local ? 'configured' : 'builtin-override', effectiveValues: {
      ...overrides, toolCalling: projected?.capability?.capabilities?.toolCalling ?? null,
      streaming: typeof local?.capabilities?.streaming === 'boolean' ? local.capabilities.streaming : null,
    }, editableOverrides: overrides };
  });
  const selected = Array.isArray(meta?.selectedModelIds) ? [...new Set(meta.selectedModelIds.filter(isModelId))].slice(0, 3000) : null;
  const ordered = Array.isArray(meta?.modelOrder) ? [...new Set(meta.modelOrder.filter(isModelId))].slice(0, 3000) : selected;
  const key = apiKeyState(config?.apiKey);
  const credentialState = ['env','literal','command'].includes(key.kind) ? { state: key.ok ? 'saved' : 'none', source: key.kind } :
    { state: auth?.status === 'connected' ? 'saved' : 'none', source: auth?.status === 'connected' ? 'pi-credential' : 'unknown' };
  return { serviceId: id, providerId: id, catalogId: isOpaqueId(meta?.catalogId) ? meta.catalogId : null,
    displayName: safeText(meta?.displayName, 200) ?? auth?.displayName ?? id, enabled: meta?.enabled !== false,
    connection: safe.baseUrl && apiSupported ? { baseUrl: safe.baseUrl, api: safe.api } : null, credentialState,
    authMode: auth?.authType === 'oauth' ? 'oauth' : key.kind === 'env' ? 'environment' : key.kind !== 'none' || credentialState.state === 'saved' ? 'pi-credential' : 'none',
    models, selectedModelIds: selected, modelOrder: ordered,
    readOnly: Boolean(config && (!isRecord(config) || !apiSupported || (config.baseUrl && !safe.baseUrl))),
    compatibility: apiSupported ? 'unknown' : 'unsupported' };
}

export function createProviderManagement({ store, inspectCredential, readAuth = () => null, mutationBlocked = () => false, now = Date.now,
  enabled = false, desktopCapabilities = null, nativeCredentials = null, invalidateDraft = () => {}, discovery = null, runtimeSync = null }) {
  const drafts = new Map();
  const receipts = new Map();
  const syncOperations = new Map();
  const nativeCommit = nativeCredentials && createNativeCommit({ store, credentials: nativeCredentials, mutationBlocked });
  const discoveryService = discovery && createProviderManagementDiscovery({ ...discovery, draftLookup: draftSnapshot,
    draftFrozen: id => nativeCommit?.hasDraft(id), now });
  function invalidate(id) {
    discoveryService?.invalidate(id);
    invalidateDraft(id);
  }
  function prune() {
    const time = now();
    for (const [id, item] of drafts) if (item.expires <= time) {
      drafts.delete(id);
      invalidate(id);
    }
    for (const [id, item] of receipts) if (item.expires <= time) receipts.delete(id);
    for (const [id, item] of syncOperations) if (item.expires <= time) syncOperations.delete(id);
  }

  async function snapshot() {
    const { config, metadata, revision } = store.read();
    const auth = projectAuth(readAuth());
    const byProvider = new Map(auth.providers.map(p => [p.providerId, p]));
    const ids = new Set([...Object.keys(config.providers), ...Object.keys(metadata.services)]);
    const services = [...ids].filter(isProviderId).slice(0, 300).map(id => projectService(id, own(config.providers, id), own(metadata.services, id), byProvider.get(id)));
    const subscriptions = auth.providers.filter(p => p.methods.some(method => method.type === 'oauth' && method.isSubscription)).map(p => ({
      id: `${p.providerId}-subscription`, providerId: p.providerId, name: p.displayName, category: 'subscription', authMode: 'oauth',
      connection: null, enabled: p.canLogin, disabledReason: p.canLogin ? null : 'oauth_unavailable',
    }));
    /* desktopCapabilities 供给方可能是 async（桥内部要做一次只读 SDK
     * 资格探测）；直接吞 Promise 会把「能力恒关」错写成 truthy Promise。
     * 这里必须等待，任何探测异常按无桌面能力处理。 */
    const desktopSource = typeof desktopCapabilities === 'function' ? await Promise.resolve(desktopCapabilities()).catch(() => null) : desktopCapabilities ?? null;
    const desktop = desktopSource && typeof desktopSource === 'object' ? desktopSource : null;
    return { ok: true, schemaVersion: PROVIDER_MANAGEMENT_SCHEMA_VERSION, revision,
      capabilities: providerManagementCapabilities({ oauthLogin: auth.sdkAvailable ? true : null, modelOverrides: auth.sdkAvailable && auth.piVersion === '1.5.0' ? true : null, desktop, runtimeSync: Boolean(runtimeSync) }),
      catalog: [...PROVIDER_CATALOG, ...subscriptions], services, auth,
      sync: runtimeSync ? runtimeSync.snapshot(metadata) : metadata.syncRequired === true ? pendingSync : { state: 'idle', reason: null } };
  }

  /* P2 私有桥用：读取草稿的非秘密绑定（不含任何凭据值）。
   * draft 对象本身只有合同字段，这里再收敛为桥需要的绑定面。 */
  function draftSnapshot(draftId) {
    prune();
    const item = drafts.get(draftId);
    if (!item) return null;
    return { draftId, draftRevision: item.draftRevision, connectionRevision: item.connectionRevision,
      serviceId: item.serviceId, providerId: item.draft.providerId, connection: item.draft.connection, expires: item.expires,
      authMode: item.draft.authMode, revision: item.revision, targetFingerprint: item.targetFingerprint };
  }

  function saveDraft(request) {
    const fingerprint = digest(request);
    const priorReceipt = receipts.get(request.requestId);
    if (priorReceipt) {
      if (priorReceipt.fingerprint !== fingerprint) providerFailure('request_id_conflict');
      return priorReceipt.result;
    }
    const current = store.read();
    if (nativeCommit?.hasDraft(request.draftId)) providerFailure('config_busy');
    if (own(current.metadata.receipts, request.requestId) || discoveryService?.hasRequest(request.requestId)) providerFailure('request_id_conflict');
    if (current.revision !== request.expectedRevision) providerFailure('config_conflict');
    const prior = request.draftId ? drafts.get(request.draftId) : null;
    if (request.draftId && (!prior || prior.draftRevision !== request.expectedDraftRevision || prior.serviceId !== request.serviceId || prior.revision !== request.expectedRevision)) providerFailure('draft_conflict');
    if (!prior && drafts.size >= limit) providerFailure('config_busy');
    const draftId = request.draftId ?? randomUUID();
    const draftRevision = (prior?.draftRevision ?? 0) + 1;
    const draft = request.draft;
    if (draft.serviceId !== undefined && draft.serviceId !== request.serviceId) providerFailure('invalid_request', 'serviceId');
    const targetFingerprint = digest([draft.providerId, draft.connection, draft.authMode, draft.piRegistrationReference ?? null]);
    const connectionRevision = prior ? prior.connectionRevision + Number(prior.targetFingerprint !== targetFingerprint) : 1;
    const expires = now() + draftTtlMs;
    drafts.set(draftId, { draft, draftRevision, connectionRevision, targetFingerprint, expires, serviceId: request.serviceId, revision: request.expectedRevision });
    if (prior && prior.connectionRevision !== connectionRevision) invalidate(draftId);
    const result = { ok: true, draftId, draftRevision, connectionRevision, targetFingerprint,
      credentialState: 'none', consentState: 'unapproved', cachedModels: [], sourceKind: 'none' };
    receipts.set(request.requestId, { result, fingerprint, expires });
    if (receipts.size > 128) receipts.delete([...receipts].find(([, receipt]) => !receipt.sync)[0]);
    return result;
  }

  async function commit(request) {
    const action = request.credentialAction?.type;
    const native = action === 'apply-staged' || action === 'clear-native';
    if (native && !nativeCommit) providerFailure('unsupported');
    if (receipts.has(request.requestId) || discoveryService?.hasRequest(request.requestId)) providerFailure('request_id_conflict');
    const staged = drafts.get(request.draftId);
    const fingerprint = digest(request);
    function assertDraft() {
      if (mutationBlocked()) providerFailure('config_busy');
      if (request.draftId && (!staged || drafts.get(request.draftId) !== staged || staged.expires <= now() || staged.draftRevision !== request.draftRevision ||
        staged.serviceId !== request.serviceId || staged.revision !== request.expectedRevision)) providerFailure('draft_conflict');
    }
    if (native) return nativeCommit.commit({ request, fingerprint, inspect: inspectCredential,
      binding() {
        assertDraft();
        const { draft, connectionRevision } = staged;
        if (request.action === 'clone' || (action === 'apply-staged' && draft.authMode !== 'pi-credential')) providerFailure('unsupported');
        discoveryService?.invalidate(request.draftId);
        return { draftId: request.draftId, providerId: draft.providerId, connection: draft.connection, connectionRevision, action };
      },
      apply(current, credential) {
        assertDraft();
        guardNativeCredentialTarget(current, staged.draft, credential, action);
        return applyProviderCommit(current, { ...request, credentialAction: { type: 'keep' } }, staged.draft, credential);
      } });
    if (mutationBlocked() || nativeCommit?.hasDraft(request.draftId)) providerFailure('config_busy');
    const providerId = staged?.draft.providerId ?? request.serviceId;
    const credential = providerId ? await inspectCredential(providerId) : null;
    const saved = store.transact({ expectedRevision: request.expectedRevision, requestId: request.requestId, fingerprint, apply(current) {
      assertDraft();
      return applyProviderCommit(current, request, staged?.draft, credential);
    } });
    if (request.draftId) discoveryService?.invalidate(request.draftId);
    return saved;
  }

  function retrySync(request) {
    const { requestId, revision } = request;
    const fingerprint = digest(['sync', request]);
    const prior = receipts.get(requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) providerFailure('request_id_conflict');
      return prior.result;
    }
    const current = store.read();
    if (own(current.metadata.receipts, requestId) || discoveryService?.hasRequest(requestId)) providerFailure('request_id_conflict');
    if (current.revision !== revision) providerFailure('config_conflict');
    if (syncOperations.size >= 64 || receipts.size >= 128) providerFailure('config_busy');
    const operationId = randomUUID();
    const operation = { revision, state: 'running', expires: now() + draftTtlMs };
    syncOperations.set(operationId, operation);
    const result = Promise.resolve().then(async () => {
      try {
        const sync = await runtimeSync.retry({ revision });
        if (store.read().revision !== revision) providerFailure('config_conflict');
        operation.state = 'success';
        operation.result = { sync };
        return { ok: true, operationId, sync };
      } catch (error) {
        operation.state = 'failed';
        operation.error = providerContractError(error?.code);
        throw error;
      }
    });
    receipts.set(requestId, { fingerprint, result, expires: operation.expires, sync: true });
    return result;
  }

  const post = new Map([['/drafts','drafts'], ['/commit','commit'], ['/discovery-authorizations','authorize'],
    ['/discovery-authorizations/revoke','revoke'], ['/discover','discover'], ['/test','test'], ['/sync','sync']]);
  async function handle(req, res, url) {
    try {
      if (!enabled) providerFailure('unsupported');
      prune();
      const suffix = url.pathname.slice(routeRoot.length);
      if (!suffix && req.method === 'GET') return json(res, 200, await snapshot());
      const operation = /^\/operations\/([^/]+)(\/cancel)?$/.exec(suffix);
      if (operation && !isOpaqueId(operation[1])) providerFailure('invalid_request');
      if (operation && !operation[2] && req.method === 'GET') {
        const sync = syncOperations.get(operation[1]);
        if (sync) return json(res, 200, { ok: true, kind: 'sync', state: sync.state, revision: sync.revision,
          ...(sync.result ? { result: sync.result } : {}), ...(sync.error ? { error: sync.error } : {}) });
        if (!discoveryService) providerFailure('unsupported');
        return json(res, 200, await discoveryService.get(operation[1]));
      }
      const kind = operation?.[2] ? 'cancel' : post.get(suffix);
      if (!kind) providerFailure(!suffix || operation ? 'method_not_allowed' : 'not_found');
      if (req.method !== 'POST') providerFailure('method_not_allowed');
      let value;
      try { value = JSON.parse(await readBody(req)); } catch { providerFailure('invalid_request'); }
      const request = validateProviderRequest(kind, value);
      if (kind === 'drafts') {
        const result = saveDraft(request);
        return json(res, 200, discoveryService ? await discoveryService.projectDraft(result) : result);
      }
      if (kind === 'commit') return json(res, 200, await commit(request));
      if (kind === 'sync' && runtimeSync) return json(res, 200, await retrySync(request));
      if (discoveryService && kind !== 'sync') {
        let persisted;
        try { persisted = own(store.read().metadata.receipts, request.requestId); }
        catch (error) { if (kind !== 'cancel' && kind !== 'revoke') throw error; }
        if (receipts.has(request.requestId) || persisted) providerFailure('request_id_conflict');
        return json(res, kind === 'discover' || kind === 'test' ? 202 : 200, await discoveryService.post(kind, operation?.[1], request));
      }
      providerFailure('unsupported');
    } catch (error) {
      const result = providerContractError(error?.code, error?.providerMutation === true ? error.fieldErrors : undefined);
      return json(res, providerErrorStatus(result.code), result);
    }
  }
  return { handle, draftSnapshot,
    nativeInFlight: () => nativeCommit?.inFlight() === true,
    draftFrozen: id => nativeCommit?.hasDraft(id) === true,
    forgetDraft(id) { drafts.delete(id); discoveryService?.invalidate(id); },
  };
}
