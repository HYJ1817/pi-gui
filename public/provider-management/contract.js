export const PROVIDER_MANAGEMENT_SCHEMA_VERSION = 1;
export const PROVIDER_API_TYPES = Object.freeze(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']);
export const EDITABLE_MODEL_FIELDS = Object.freeze(['name', 'contextWindow', 'maxTokens', 'reasoning', 'input']);
export const PROVIDER_MANAGEMENT_STATES = Object.freeze({
  dialog: Object.freeze(['loading','ready','empty','discovering','testing','saving','saved-pending-sync','saved-credential-error','credential-unconfirmed','syncing','success','conflict','error','unsupported','disabled']),
  credential: Object.freeze(['none','editing','staged','persisting','saved','clear-staged','cleared','expired','unsupported']),
  discovery: Object.freeze(['unapproved','authorized-idle','debouncing','refreshing','ready','empty','error-stale','unsupported']),
  source: Object.freeze(['none','offline','cache','remote','configured','manual']),
  operation: Object.freeze(['pending','running','success','failed','cancelled']),
  sync: Object.freeze(['idle','pending','syncing','applied','error','unsupported']),
});

const catalog = (id, name, baseUrl, api, reference) => Object.freeze({ id, name, category: 'api-key', authMode: reference ? 'environment' : 'none',
  connection: baseUrl ? Object.freeze({ baseUrl, api }) : null, ...(reference ? { suggestedEnvReference: reference } : {}) });
export const PROVIDER_CATALOG = Object.freeze([
  catalog('custom', '自定义端点', null),
  catalog('openai', 'OpenAI', 'https://api.openai.com/v1', 'openai-responses', '$OPENAI_API_KEY'),
  catalog('anthropic', 'Anthropic', 'https://api.anthropic.com', 'anthropic-messages', '$ANTHROPIC_API_KEY'),
  catalog('google', 'Google Gemini', 'https://generativelanguage.googleapis.com/v1beta', 'google-generative-ai', '$GEMINI_API_KEY'),
  catalog('deepseek', 'DeepSeek', 'https://api.deepseek.com', 'openai-completions', '$DEEPSEEK_API_KEY'),
  catalog('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'openai-completions', '$OPENROUTER_API_KEY'),
  catalog('ollama', 'Ollama', 'http://127.0.0.1:11434/v1', 'openai-completions'),
  catalog('moonshotai-cn', 'Moonshot 中国', 'https://api.moonshot.cn/v1', 'openai-completions', '$MOONSHOT_API_KEY'),
  catalog('siliconflow', '硅基流动', 'https://api.siliconflow.cn/v1', 'openai-completions', '$SILICONFLOW_API_KEY'),
  catalog('zhipu', '智谱 GLM', 'https://open.bigmodel.cn/api/paas/v4', 'openai-completions', '$ZHIPU_API_KEY'),
  catalog('dashscope', '阿里百炼', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'openai-completions', '$DASHSCOPE_API_KEY'),
]);

const errors = Object.freeze({
  invalid_request: [400, '请求字段无效。'], not_found: [404, '供应商、草稿或操作不存在。'],
  unsupported: [422, '此能力尚未开放。'], method_not_allowed: [405, '请求方法不受支持。'],
  config_conflict: [409, '供应商配置已变化，请重读后保存。'],
  draft_conflict: [409, '草稿已变化，请重读后保存。'],
  request_id_conflict: [409, '请求标识已用于不同操作。'],
  provider_exists: [409, '该供应商标识已被使用。'],
  credential_target_conflict: [409, '已有认证的服务需复制为新标识后才能更换端点。'],
  credential_conflict: [409, '无法证明目标没有存量凭据，请检查 Pi 认证或换用新标识。'],
  config_busy: [423, '供应商配置正在被其他进程使用。'],
  config_invalid: [422, '配置已损坏，请先检查原文件。'],
  config_unsupported: [422, '配置版本不受支持。'],
  config_unsafe: [422, '无法确认配置文件和权限的安全性。'],
  config_unreadable: [503, '无法读取供应商配置。'],
  config_write_failed: [503, '无法保存供应商配置。'],
  config_recovery_required: [503, '配置事务需要恢复，请重读状态。'],
  invalid_target: [422, '发现目标或授权已失效。'],
  policy_rejected: [422, '发现目标不符合已授权的网络策略。'],
  private_address: [422, '发现目标解析到不允许访问的地址。'],
  loopback_requires_consent: [422, '回环发现需要单独授权，且不允许附带凭据。'],
  redirect_rejected: [422, '供应商返回了重定向，已停止发现。'],
  too_large: [422, '供应商目录响应超过大小限制。'],
  not_json: [422, '供应商返回的模型目录格式不受支持。'],
  http_401: [422, '供应商拒绝了认证请求。'],
  http_403: [422, '供应商拒绝了目录访问权限。'],
  http_404: [422, '授权目标没有模型目录。'],
  http_429: [503, '供应商限制了目录查询频率。'],
  timeout: [503, '发现操作超时。'],
  dns_failed: [503, '发现目标的 DNS 解析失败。'],
  network_failed: [503, '无法读取供应商模型目录。'],
  unavailable: [503, '供应商管理暂不可用。'],
});
export const providerErrorStatus = code => Object.hasOwn(errors, code) ? errors[code][0] : 503;
export function providerContractError(code, fieldErrors) {
  if (!Object.hasOwn(errors, code)) code = 'unavailable';
  return { ok: false, code, message: errors[code][1], retryable: [409,423,503].includes(errors[code][0]),
    ...(fieldErrors ? { fieldErrors } : {}) };
}
export function providerFailure(code, field) {
  const details = providerContractError(code, field ? { [field]: 'invalid' } : undefined);
  throw Object.assign(Error(details.message), details, { providerMutation: true });
}
export function providerManagementCapabilities({ oauthLogin = null, modelOverrides = null, desktop = null, runtimeSync = false, discoveryModes = [] } = {}) {
  const desktopPart = desktop && typeof desktop === 'object'
    ? {
      rawKeyInput: desktop.rawKeyInput === true,
      keyStaging: desktop.keyStaging === true,
      nativeCredentialPersistence: desktop.nativeCredentialPersistence === true,
      privateDesktopBridge: desktop.privateDesktopBridge === true,
    }
    : { rawKeyInput: false, keyStaging: false, nativeCredentialPersistence: false, privateDesktopBridge: false };
  const reason = (granted, pending) => granted ? null : pending;
  // 发现模式是后端真实接线的能力，不在前端硬编码。未知值不冒领。
  const modes = [...new Set((Array.isArray(discoveryModes) ? discoveryModes : []).filter(mode => ['none','environment','pi-credential'].includes(mode)))];
  return { ...desktopPart,
    oauthLogin, discoveryModes: modes, modelOverrides, syncMode: runtimeSync ? 'deferred' : 'unsupported', reasons: {
      rawKeyInput: reason(desktopPart.rawKeyInput, 'desktop_input_pending'),
      keyStaging: reason(desktopPart.keyStaging, 'private_bridge_pending'),
      nativeCredentialPersistence: reason(desktopPart.nativeCredentialPersistence, 'private_bridge_pending'),
      privateDesktopBridge: reason(desktopPart.privateDesktopBridge, 'p2_pending'),
      discoveryModes: reason(modes.length > 0, 'discovery_transport_pending'),
      syncMode: reason(runtimeSync, 'runtime_sync_pending'),
    } };
}

export const isRecord = v => v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const safeText = (v, max) => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
export const isProviderId = v => typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v) && !reserved.has(v) && v !== '.' && v !== '..';
export const isModelId = v => safeText(v, 300) && !reserved.has(v);
export const isOpaqueId = v => typeof v === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(v) && !reserved.has(v);
export const isEnvReference = v => typeof v === 'string' && v.length <= 256 && /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(v);
const positive = v => Number.isSafeInteger(v) && v > 0;
const counter = v => Number.isSafeInteger(v) && v >= 0;
const bool = v => typeof v === 'boolean';
const need = (test, field) => { if (!test) providerFailure('invalid_request', field); };
const has = (v, k) => Object.hasOwn(v, k);

function fields(value, required, optional, field) {
  need(isRecord(value) && required.every(k => has(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k)), field);
}
function uniqueList(value, check, max, field) {
  need(Array.isArray(value) && value.length <= max && value.every(check) && new Set(value).size === value.length, field);
}
export function validateConnection(value) {
  fields(value, ['baseUrl','api'], [], 'connection');
  need(safeText(value.baseUrl, 2048) && !/[\\?#]/u.test(value.baseUrl) && PROVIDER_API_TYPES.includes(value.api), 'connection');
  let url;
  try { url = new URL(value.baseUrl); } catch { providerFailure('invalid_request', 'connection'); }
  need(/^https?:\/\//iu.test(value.baseUrl) && !url.username && !url.password, 'connection');
  return { baseUrl: url.pathname === '/' ? url.origin : url.href, api: value.api };
}
export function validateModelValues(value) {
  fields(value, [], EDITABLE_MODEL_FIELDS, 'modelPatches');
  if (has(value, 'name')) need(safeText(value.name, 200), 'modelPatches');
  for (const field of ['contextWindow','maxTokens']) if (has(value, field)) need(positive(value[field]), 'modelPatches');
  if (has(value, 'reasoning')) need(bool(value.reasoning), 'modelPatches');
  if (has(value, 'input')) {
    uniqueList(value.input, item => ['text','image'].includes(item), 2, 'modelPatches');
    need(value.input.length > 0, 'modelPatches');
  }
  if (has(value,'contextWindow') && has(value,'maxTokens')) need(value.maxTokens <= value.contextWindow, 'modelPatches');
  return value;
}
function modelPatch(value) {
  fields(value, ['modelId','operation'], ['set','unsetFields'], 'modelPatches');
  need(isModelId(value.modelId) && ['upsert','remove'].includes(value.operation), 'modelPatches');
  if (value.operation === 'remove') need(!has(value,'set') && !has(value,'unsetFields'), 'modelPatches');
  if (has(value, 'set')) validateModelValues(value.set);
  if (has(value, 'unsetFields')) {
    uniqueList(value.unsetFields, k => EDITABLE_MODEL_FIELDS.includes(k), EDITABLE_MODEL_FIELDS.length, 'modelPatches');
    need(value.unsetFields.every(k => !has(value.set ?? {}, k)), 'modelPatches');
  }
}
function draft(value) {
  fields(value, ['providerId','authMode','displayName','connection','modelPatches','selectedModelIds','modelOrder','enabled'],
    ['serviceId','catalogId','piRegistrationReference','confirmBuiltinOverride'], 'draft');
  need(isProviderId(value.providerId) && safeText(value.displayName, 200) && bool(value.enabled), 'draft');
  for (const key of ['serviceId','catalogId']) if (has(value,key)) need(isOpaqueId(value[key]), 'draft');
  need(['environment','pi-credential','oauth','none'].includes(value.authMode), 'authMode');
  if (has(value,'piRegistrationReference')) need(value.authMode === 'none' && isEnvReference(value.piRegistrationReference), 'piRegistrationReference');
  if (has(value,'confirmBuiltinOverride')) need(value.confirmBuiltinOverride === true, 'confirmBuiltinOverride');
  need(Array.isArray(value.modelPatches) && value.modelPatches.length <= 3000, 'modelPatches');
  value.modelPatches.forEach(modelPatch);
  need(new Set(value.modelPatches.map(m => m.modelId)).size === value.modelPatches.length, 'modelPatches');
  uniqueList(value.selectedModelIds, isModelId, 3000, 'selectedModelIds');
  uniqueList(value.modelOrder, isModelId, 3000, 'modelOrder');
  const selected = new Set(value.selectedModelIds);
  need(value.modelOrder.length === selected.size && value.modelOrder.every(id => selected.has(id)), 'modelOrder');
  return { ...value, connection: validateConnection(value.connection) };
}
function credentialAction(action) {
  fields(action, ['type'], ['reference','confirmed'], 'credentialAction');
  switch (action.type) {
    case 'env': need(isEnvReference(action.reference) && !has(action,'confirmed'), 'credentialAction'); break;
    case 'none': need(action.confirmed === true && !has(action,'reference'), 'credentialAction'); break;
    case 'keep': case 'apply-staged': case 'clear-native': need(Object.keys(action).length === 1, 'credentialAction'); break;
    default: providerFailure('invalid_request', 'credentialAction');
  }
}

const requests = Object.freeze({
  drafts: [['requestId','expectedRevision','draft'], ['serviceId','draftId','expectedDraftRevision']],
  commit: [['requestId','expectedRevision','action'], ['draftId','draftRevision','serviceId','credentialAction']],
  authorize: [['requestId','draftId','draftRevision','confirm','rememberTarget'], []],
  revoke: [['requestId','consentId'], []],
  discover: [['requestId','draftId','draftRevision','consentId','dialogGeneration','requestSeq','force'], []],
  test: [['requestId','draftId','draftRevision','consentId','dialogGeneration','requestSeq','force'], []],
  cancel: [['requestId'], []], sync: [['requestId','revision'], []],
});
export function validateProviderRequest(kind, value) {
  need(Object.hasOwn(requests, kind), 'request');
  fields(value, ...requests[kind], 'request');
  for (const key of ['requestId','expectedRevision','revision','serviceId','draftId','consentId']) {
    if (has(value,key)) need(isOpaqueId(value[key]), key);
  }
  for (const key of ['expectedDraftRevision','draftRevision']) if (has(value,key)) need(positive(value[key]), key);
  if (kind === 'drafts') {
    need(has(value,'draftId') === has(value,'expectedDraftRevision'), 'draftId');
    return { ...value, draft: draft(value.draft) };
  }
  if (kind === 'commit') {
    const action = value.action;
    need(['create','update','clone','delete','disable'].includes(action), 'action');
    const needsDraft = ['create','update','clone'].includes(action);
    need(has(value,'draftId') === needsDraft && has(value,'draftRevision') === needsDraft && has(value,'serviceId') === (action !== 'create'), 'action');
    if (has(value,'credentialAction')) {
      need(needsDraft, 'credentialAction');
      credentialAction(value.credentialAction);
    }
  }
  if (kind === 'authorize') need(value.confirm === true && bool(value.rememberTarget), 'confirm');
  if (['discover','test'].includes(kind)) need(counter(value.dialogGeneration) && counter(value.requestSeq) && bool(value.force), 'operation');
  return value;
}

const keyBytes = value => typeof value === 'string' ? new TextEncoder().encode(value).length : 0;
export const isLiteralKeyInput = value => typeof value === 'string' && keyBytes(value) >= 1 && keyBytes(value) <= 8192 && !/[\u0000\r\n]/u.test(value);
const flowFields = ['flowId','promptId','nonce'];
const frames = Object.freeze({
  capability: [], prepare: ['draftId','draftRevision','purpose'], stage: [...flowFields,'input','allowDiscovery','rememberTarget'],
  'clear-stage': [...flowFields,'confirmed'], 'authorize-target': [...flowFields,'confirmed','rememberTarget'],
  status: ['flowId'], cancel: ['flowId'], 'close-draft': ['draftId'],
});
export function validateCredentialFrame(value) {
  need(isRecord(value) && value.type === 'provider-credential' && Object.hasOwn(frames, value.action), 'frame');
  fields(value, ['type','action','requestId','backendEpoch', ...frames[value.action]], value.action === 'prepare' ? ['flowId'] : [], 'frame');
  for (const key of ['requestId','backendEpoch','draftId', ...flowFields]) if (has(value,key)) need(isOpaqueId(value[key]), 'frame');
  if (value.action === 'prepare') need(positive(value.draftRevision) && ['set','replace','clear','authorize-target'].includes(value.purpose), 'frame');
  if (value.action === 'stage') need(isLiteralKeyInput(value.input) && bool(value.allowDiscovery), 'frame');
  if (has(value,'confirmed')) need(value.confirmed === true, 'frame');
  if (has(value,'rememberTarget')) need(bool(value.rememberTarget), 'frame');
  return value;
}
