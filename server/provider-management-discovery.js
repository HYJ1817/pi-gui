import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { PROVIDER_CATALOG, isLiteralKeyInput, isModelId, providerContractError, providerFailure } from '../public/provider-management/contract.js';
import { createDiscoveryConsentStore } from './provider-discovery-consent.js';
import { classifyAddress, createDiscoveryTransport, parseTarget } from './provider-network.js';

const operationTtl = 15 * 60_000;
const cacheTtl = 60_000;
const maxActive = 8;
const maxCacheBytes = 8 * 1024 * 1024;
const maxTerminals = 128;
const cancelBudget = 2_000;
const liveStates = new Set(['pending', 'running']);
const statusCodes = new Set([401, 403, 404, 429]);

function targetMatches(grant, draft) {
  const target = parseTarget(draft?.connection.baseUrl);
  return target && grant.providerId === draft.providerId && grant.connectionRevision === draft.connectionRevision &&
    grant.api === draft.connection.api && grant.target.protocol === target.protocol && grant.target.host === target.host &&
    grant.target.port === target.port && grant.target.basePath === target.basePath;
}

function modelsFrom(models, providerId) {
  return models.filter(model => isModelId(model.id)).map(({ id, ...values }) => ({
    modelId: id, providerId, configSource: 'remote', effectiveValues: { ...values, toolCalling: null, streaming: null }, editableOverrides: {},
  }));
}

export function createProviderManagementDiscovery({ draftLookup, draftFrozen = () => false, now = Date.now,
  monotonicNow = () => performance.now(), consentStore = createDiscoveryConsentStore({ strict: true, now }),
  env = process.env, io, executeNative, nativeCurrent, verifyNative, launchIdentity = () => 'default' }) {
  const discover = createDiscoveryTransport({ consentStore: {
    get(id) {
      const grant = consentStore.get(id);
      return grant && current(grant, draftLookup(grant.draftId)) ? grant : null;
    },
    signalFor: consentStore.signalFor,
  }, io, now: monotonicNow });
  const envKey = randomBytes(32);
  const operations = new Map();
  const commands = new Map();
  const active = new Map();
  const cache = new Map();
  const generations = new WeakMap();
  const latest = new WeakMap();
  let sequence = 0;
  let cacheBytes = 0;

  function environment(draft) {
    const preset = PROVIDER_CATALOG.find(item => item.id === draft.providerId && item.connection?.baseUrl === draft.connection.baseUrl &&
      item.connection.api === draft.connection.api);
    const reference = preset?.suggestedEnvReference?.slice(1);
    const key = reference && Object.hasOwn(env, reference) ? env[reference] : null;
    if (!isLiteralKeyInput(key)) return null;
    return { key, revision: createHmac('sha256', envKey).update(JSON.stringify([reference, key])).digest('hex') };
  }

  function current(grant, draft) {
    if (consentStore.get(grant.consentId) !== grant || !targetMatches(grant, draft) || draftFrozen(grant.draftId)) return false;
    if (grant.credentialSource === 'environment') return draft.authMode === 'environment' && environment(draft)?.revision === grant.credentialRevision;
    if (grant.credentialSource === 'none') return draft.authMode === 'none' ||
      (draft.authMode === 'pi-credential' && nativeCurrent?.(grant, draft) === true);
    return draft.authMode === 'pi-credential' && nativeCurrent?.(grant, draft) === true;
  }

  async function confirmed(grant, draft) {
    if (!current(grant, draft)) return false;
    if (grant.credentialSource === 'staged' || grant.credentialSource === 'stored' || (grant.credentialSource === 'none' && grant.workerEpoch)) {
      if (await verifyNative?.(grant, draft) !== true) return false;
    }
    return current(grant, draftLookup(grant.draftId));
  }

  function superseded(grant, { dialogGeneration, requestSeq }) {
    const previous = latest.get(grant);
    return previous && (dialogGeneration < previous.dialogGeneration ||
      (dialogGeneration === previous.dialogGeneration && requestSeq < previous.requestSeq));
  }

  function removeCache(id) {
    const entry = cache.get(id);
    if (!entry) return;
    cacheBytes -= entry.bytes;
    cache.delete(id);
  }

  function prune() {
    const time = now();
    let terminals = 0;
    let terminalBytes = 0;
    for (const [id, operation] of operations) {
      if (operation.finished == null || active.get(operation.grant.providerId) === operation) continue;
      if (operation.finished + operationTtl <= time) operations.delete(id);
      else { terminals++; terminalBytes += operation.bytes ?? 0; }
    }
    for (const [id, operation] of operations) {
      if (terminals <= maxTerminals && terminalBytes <= maxCacheBytes) break;
      if (operation.finished != null && active.get(operation.grant.providerId) !== operation) {
        operations.delete(id); terminals--; terminalBytes -= operation.bytes ?? 0;
      }
    }
    for (const [id, entry] of cache) if (!consentStore.get(id)) removeCache(id);
    for (const [id, entry] of commands) if (!entry.pending && entry.expires <= time) commands.delete(id);
  }

  function once(kind, id, request, run) {
    prune();
    const fingerprint = createHash('sha256').update(JSON.stringify([kind, id, Object.entries(request).sort()])).digest('hex');
    const previous = commands.get(request.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) providerFailure('request_id_conflict');
      return previous.result;
    }
    if (commands.size >= 256) providerFailure('config_busy');
    const entry = { fingerprint, expires: now() + operationTtl, pending: true };
    commands.set(request.requestId, entry);
    entry.result = Promise.resolve().then(run).finally(() => { entry.pending = false; });
    return entry.result;
  }

  function checkedDraft(request) {
    const draft = draftLookup(request.draftId);
    if (!draft || draft.draftRevision !== request.draftRevision) providerFailure('draft_conflict');
    if (draftFrozen(draft.draftId)) providerFailure('config_busy');
    return draft;
  }

  function authorize(request) {
    const draft = checkedDraft(request);
    const target = parseTarget(draft.connection.baseUrl);
    if (!target) providerFailure('invalid_target');
    const targetSummary = { providerId: draft.providerId, baseUrl: draft.connection.baseUrl, api: draft.connection.api };
    if (draft.authMode === 'pi-credential') return { ok: true, requiresDesktopConfirmation: true, targetSummary };
    if (!['none', 'environment'].includes(draft.authMode)) providerFailure('unsupported');
    const credentialSource = draft.authMode;
    const secret = credentialSource === 'environment' ? environment(draft) : null;
    if (credentialSource === 'environment' && !secret) providerFailure('unsupported');
    const loopback = target.isLoopbackName || classifyAddress(target.host) === 'loopback';
    const result = consentStore.issue({ ...draft, api: draft.connection.api, credentialSource, credentialRevision: secret?.revision,
      rememberTarget: request.rememberTarget, loopback });
    if (!result.ok) providerFailure(result.code);
    return { ok: true, consentId: result.consentId, expiresAt: result.expiresAt, targetSummary, requiresDesktopConfirmation: false };
  }

  function revoke(request) {
    if (!consentStore.revokeAndForget(request.consentId)) providerFailure('not_found');
    removeCache(request.consentId);
    return { ok: true, revoked: true };
  }

  function cacheResult(grant, models) {
    const bytes = Buffer.byteLength(JSON.stringify(models));
    if (bytes > maxCacheBytes) return;
    removeCache(grant.consentId);
    while (cache.size >= 64 || cacheBytes + bytes > maxCacheBytes) removeCache(cache.keys().next().value);
    cache.set(grant.consentId, { bytes, models, expires: now() + cacheTtl });
    cacheBytes += bytes;
  }

  function projectModels(operation, models, sourceKind, stale = false) {
    return { models: sourceKind === 'cache' ? models.map(model => ({ ...model, configSource: 'cache' })) : models,
      sourceKind, stale, count: models.length, ...operation.binding };
  }

  function closeOperation(operation, state, fields = {}) {
    if (!liveStates.has(operation.state)) return;
    Object.assign(operation, fields, { state, finished: now(), bytes: fields.result ? Buffer.byteLength(JSON.stringify(fields.result)) : 0 });
    prune();
  }

  function stop(operation, timeout = false) {
    if (!liveStates.has(operation.state)) return;
    if (!operation.controller.signal.aborted) operation.controller.abort();
    if (timeout) closeOperation(operation, 'failed', { error: providerContractError('timeout') });
    else if (!operation.stopTimer) {
      operation.stopTimer = setTimeout(() => stop(operation, true), cancelBudget);
      operation.stopTimer.unref?.();
    }
  }

  async function run(operation) {
    const { grant, controller, kind, deadline } = operation;
    const draft = draftLookup(grant.draftId);
    if (controller.signal.aborted || !await confirmed(grant, draft) || controller.signal.aborted ||
        operation.launch !== launchIdentity() || !current(grant, draftLookup(grant.draftId))) return;
    operation.state = 'running';
    const cached = cache.get(grant.consentId);
    if (kind === 'discover' && !operation.force && cached && cached.expires > now()) {
      closeOperation(operation, 'success', { result: projectModels(operation, cached.models, 'cache') });
      return;
    }
    const secret = grant.credentialSource === 'environment' ? environment(draft) : null;
    const params = { consentId: grant.consentId, url: grant.candidatePaths[0], credentialRevision: grant.credentialRevision,
      signal: controller.signal, deadline };
    const result = grant.credentialSource === 'stored' || grant.credentialSource === 'staged' ?
      await executeNative?.(grant, draft, params) : await discover({ ...params, key: secret?.key });
    if (controller.signal.aborted || !liveStates.has(operation.state) || !await confirmed(grant, draftLookup(grant.draftId)) || controller.signal.aborted ||
        operation.launch !== launchIdentity() || !current(grant, draftLookup(grant.draftId))) return;
    const code = statusCodes.has(result?.status) ? `http_${result.status}` : result?.code === 'http_status' ? 'network_failed' : result?.code ?? 'unsupported';
    if (kind === 'test') {
      const httpEvidence = Number.isInteger(result?.status) && result.status >= 100 && result.status < 600;
      const facts = { reachability: httpEvidence ? true : null, modelListAccess: result?.ok === true ? true : httpEvidence ? false : null,
        credentialAccepted: null, inferenceVerified: false, evidence: result?.ok === true ? 'model-list' : httpEvidence ? 'http-status' : 'none',
        checkedAt: now(), ...(Number.isFinite(result?.retryAt) ? { retryAt: result.retryAt } : {}), ...operation.binding };
      closeOperation(operation, result?.ok === true ? 'success' : 'failed', { result: facts,
        ...(result?.ok === true ? {} : { error: providerContractError(code) }) });
      return;
    }
    if (result?.ok !== true) {
      closeOperation(operation, 'failed', { error: providerContractError(code),
        ...(cached ? { result: projectModels(operation, cached.models, 'cache', true) } : {}) });
      return;
    }
    const models = modelsFrom(result.models, grant.providerId);
    cacheResult(grant, models);
    closeOperation(operation, 'success', { result: projectModels(operation, models, 'remote') });
  }

  function start(kind, request) {
    const draft = checkedDraft(request);
    const grant = consentStore.get(request.consentId);
    if (!grant || grant.draftId !== draft.draftId || !current(grant, draft)) providerFailure('invalid_target');
    if (superseded(grant, request)) providerFailure('config_conflict');
    if (active.size >= maxActive || active.has(grant.providerId)) providerFailure('config_busy');
    const { dialogGeneration, requestSeq, force } = request;
    const launch = launchIdentity();
    if (!generations.has(grant)) generations.set(grant, ++sequence);
    const controller = new AbortController();
    const duration = Math.max(0, Math.min(30_000, grant.expires - now()));
    const operationId = randomUUID();
    const operation = { kind, launch, force, grant, controller, state: 'pending', revision: draft.revision,
      deadline: monotonicNow() + duration,
      binding: { dialogGeneration, requestSeq, connectionRevision: draft.connectionRevision, targetFingerprint: draft.targetFingerprint,
        credentialGeneration: generations.get(grant) } };
    operations.set(operationId, operation);
    active.set(grant.providerId, operation);
    latest.set(grant, operation.binding);
    const consentSignal = consentStore.signalFor(grant.consentId);
    const revoke = () => { removeCache(grant.consentId); stop(operation); };
    consentSignal?.addEventListener('abort', revoke, { once: true });
    const timeout = setTimeout(() => stop(operation, true), duration);
    timeout.unref?.();
    operation.done = Promise.resolve().then(() => run(operation)).catch(() => {
      if (!controller.signal.aborted) closeOperation(operation, 'failed', { error: providerContractError('unavailable') });
    }).finally(() => {
      clearTimeout(timeout);
      clearTimeout(operation.stopTimer);
      consentSignal?.removeEventListener('abort', revoke);
      closeOperation(operation, 'cancelled');
      if (active.get(grant.providerId) === operation) active.delete(grant.providerId);
      prune();
    });
    return { ok: true, operationId };
  }

  async function get(id) {
    prune();
    const operation = operations.get(id);
    if (!operation) providerFailure('not_found');
    const { kind, revision, grant } = operation;
    const visible = operation.result ? await confirmed(grant, draftLookup(grant.draftId)) : current(grant, draftLookup(grant.draftId));
    if (!visible || operation.launch !== launchIdentity() || !current(grant, draftLookup(grant.draftId))) {
      removeCache(grant.consentId);
      stop(operation);
      return { ok: true, kind, revision, state: 'failed', error: providerContractError('invalid_target') };
    }
    if (superseded(grant, operation.binding)) return { ok: true, kind, revision, state: 'failed', error: providerContractError('config_conflict') };
    const { state, result, error } = operation;
    return { ok: true, kind, revision, state, ...(result ? { result } : {}), ...(error ? { error } : {}) };
  }

  async function cancel(id) {
    const operation = operations.get(id);
    if (!operation) providerFailure('not_found');
    if (operation.state === 'cancelled') return { ok: true, state: 'cancelled' };
    if (!liveStates.has(operation.state)) providerFailure('config_conflict');
    stop(operation);
    let timer;
    try { await Promise.race([operation.done, new Promise(resolve => { timer = setTimeout(resolve, cancelBudget); })]); }
    finally { clearTimeout(timer); }
    if (operation.state !== 'cancelled') {
      closeOperation(operation, 'failed', { error: providerContractError('timeout') });
      providerFailure('timeout');
    }
    return { ok: true, state: 'cancelled' };
  }

  function invalidate(draftId) {
    consentStore.revokeDraft(draftId);
    for (const operation of active.values()) if (operation.grant.draftId === draftId) stop(operation);
    prune();
  }

  async function projectDraft(result) {
    const grant = consentStore.forDraft(result.draftId);
    if (!grant || !await confirmed(grant, draftLookup(result.draftId))) return result;
    const draft = draftLookup(result.draftId);
    if (draft?.draftRevision !== result.draftRevision || !current(grant, draft)) return result;
    if (!generations.has(grant)) generations.set(grant, ++sequence);
    const cached = cache.get(grant.consentId);
    const entry = cached?.expires > now() ? cached : null;
    const cachedModels = entry?.models.map(model => ({ ...model, configSource: 'cache' })) ?? [];
    /* P5：主页面用 consentId 发起 /discover 与 /test。授权本身仍由服务端持有，
     * 这里只把与当前草稿/目标绑定的不透明句柄投影给同源管理 API 的调用方；
     * 原生凭据的值始终只在私有桥与输入窗里。 */
    return { ...result, credentialGeneration: generations.get(grant), consentState: 'authorized-idle',
      consentId: grant.consentId, consentExpiresAt: grant.expires,
      sourceKind: entry ? 'cache' : 'none', cachedModels };
  }

  return { get, invalidate, projectDraft, hasRequest(id) { prune(); return commands.has(id); },
    post(kind, id, request) {
      return once(kind, id, request, () => kind === 'authorize' ? authorize(request) : kind === 'revoke' ? revoke(request) :
        kind === 'cancel' ? cancel(id) : start(kind, request));
    },
  };
}
