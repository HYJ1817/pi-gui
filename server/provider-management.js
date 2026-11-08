import { createHash, randomUUID } from 'node:crypto';
import { json, readBody } from './http-utils.js';
import { apiKeyState, publicProviderConfig } from './providers.js';
import { applyProviderCommit, own } from './provider-config-records.js';
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

export function createProviderManagement({ store, inspectCredential, readAuth = () => null, mutationBlocked = () => false, now = Date.now, enabled = false, desktopCapabilities = null }) {
  const drafts = new Map();
  const receipts = new Map();
  function prune() {
    const time = now();
    for (const [id, item] of drafts) if (item.expires <= time) drafts.delete(id);
    for (const [id, item] of receipts) if (item.expires <= time) receipts.delete(id);
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
      capabilities: providerManagementCapabilities({ oauthLogin: auth.sdkAvailable ? true : null, modelOverrides: auth.sdkAvailable && auth.piVersion === '1.5.0' ? true : null, desktop }),
      catalog: [...PROVIDER_CATALOG, ...subscriptions], services, auth, sync: metadata.syncRequired === true ? pendingSync : { state: 'idle', reason: null } };
  }

  /* P2 私有桥用：读取草稿的非秘密绑定（不含任何凭据值）。
   * draft 对象本身只有合同字段，这里再收敛为桥需要的绑定面。 */
  function draftSnapshot(draftId) {
    prune();
    const item = drafts.get(draftId);
    if (!item) return null;
    return { draftId, draftRevision: item.draftRevision, connectionRevision: item.connectionRevision,
      serviceId: item.serviceId, providerId: item.draft.providerId, connection: item.draft.connection, expires: item.expires };
  }

  function saveDraft(request) {
    const fingerprint = digest(request);
    const priorReceipt = receipts.get(request.requestId);
    if (priorReceipt) {
      if (priorReceipt.fingerprint !== fingerprint) providerFailure('request_id_conflict');
      return priorReceipt.result;
    }
    const current = store.read();
    if (own(current.metadata.receipts, request.requestId)) providerFailure('request_id_conflict');
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
    const result = { ok: true, draftId, draftRevision, connectionRevision, targetFingerprint,
      credentialState: 'none', consentState: 'unapproved', cachedModels: [], sourceKind: 'none' };
    receipts.set(request.requestId, { result, fingerprint, expires });
    if (receipts.size > 128) receipts.delete(receipts.keys().next().value);
    return result;
  }

  async function commit(request) {
    if (['apply-staged','clear-native'].includes(request.credentialAction?.type)) providerFailure('unsupported');
    if (receipts.has(request.requestId)) providerFailure('request_id_conflict');
    if (mutationBlocked()) providerFailure('config_busy');
    const staged = drafts.get(request.draftId);
    const providerId = staged?.draft.providerId ?? request.serviceId;
    const credential = providerId ? await inspectCredential(providerId) : null;
    return store.transact({ expectedRevision: request.expectedRevision, requestId: request.requestId, fingerprint: digest(request), apply(current) {
      if (mutationBlocked()) providerFailure('config_busy');
      if (request.draftId && (!staged || drafts.get(request.draftId) !== staged || staged.expires <= now() || staged.draftRevision !== request.draftRevision ||
        staged.serviceId !== request.serviceId || staged.revision !== request.expectedRevision)) providerFailure('draft_conflict');
      return applyProviderCommit(current, request, staged?.draft, credential);
    } });
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
      if (operation && !operation[2] && req.method === 'GET') providerFailure('unsupported');
      const kind = operation?.[2] ? 'cancel' : post.get(suffix);
      if (!kind) providerFailure(!suffix || operation ? 'method_not_allowed' : 'not_found');
      if (req.method !== 'POST') providerFailure('method_not_allowed');
      let value;
      try { value = JSON.parse(await readBody(req)); } catch { providerFailure('invalid_request'); }
      const request = validateProviderRequest(kind, value);
      if (kind === 'drafts') return json(res, 200, saveDraft(request));
      if (kind === 'commit') return json(res, 200, await commit(request));
      providerFailure('unsupported');
    } catch (error) {
      const result = providerContractError(error?.code, error?.providerMutation === true ? error.fieldErrors : undefined);
      return json(res, providerErrorStatus(result.code), result);
    }
  }
  return { handle, draftSnapshot };
}
