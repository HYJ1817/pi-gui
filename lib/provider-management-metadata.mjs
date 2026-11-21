import { isModelId, isOpaqueId, isProviderId, validateModelValues } from '../public/provider-management/contract.js';

// One schema authority for the provider store and the cold-migration reader.
// This module has no filesystem, credential, or recovery side effects.
export const RECEIPT_LIMIT = 128;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = code => { throw Object.assign(Error(code), { code }); };
export const defaultMetadata = () => ({ schemaVersion: 1, services: {}, receipts: {} });

export function safeReceipt(value) {
  const id = v => typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v);
  if (!record(value) || value.ok !== true || !id(value.serviceId) || value.saved !== true || value.credentialSaved !== null ||
      value.credentialState !== 'none' || value.operationId !== null || value.sync?.state !== 'pending' ||
      value.sync?.reason !== 'runtime_sync_pending' || !digest(value.revision)) fail('config_invalid');
  return { ok: true, serviceId: value.serviceId, saved: true, credentialSaved: null, credentialState: 'none', operationId: null,
    sync: { state: 'pending', reason: 'runtime_sync_pending' }, revision: value.revision };
}

export function validateMetadata(value) {
  if (!record(value) || !record(value.services) || !record(value.receipts)) fail('config_invalid');
  if (value.schemaVersion !== 1 || Object.keys(value).some(key => !['schemaVersion','services','receipts','syncRequired','syncGeneration','syncRemoved'].includes(key))) fail('config_unsupported');
  if (Object.hasOwn(value, 'syncRequired') && typeof value.syncRequired !== 'boolean') fail('config_invalid');
  if (Object.hasOwn(value, 'syncGeneration') && !isOpaqueId(value.syncGeneration)) fail('config_invalid');
  if (Object.hasOwn(value, 'syncRemoved') && (!Array.isArray(value.syncRemoved) || value.syncRemoved.length > 3000 ||
      !value.syncRemoved.every(item => Array.isArray(item) && item.length === 2 && isProviderId(item[0]) && isModelId(item[1])))) fail('config_invalid');
  for (const [id, service] of Object.entries(value.services)) {
    if (!isProviderId(id) || !record(service) || Object.keys(service).some(key => !['providerId','catalogId','displayName','enabled','selectedModelIds','modelOrder','kind','ownedOverrides'].includes(key))) fail('config_invalid');
    if (Object.hasOwn(service,'providerId') && service.providerId !== id) fail('config_invalid');
    if (Object.hasOwn(service,'catalogId') && !isOpaqueId(service.catalogId)) fail('config_invalid');
    if (Object.hasOwn(service,'displayName') && (typeof service.displayName !== 'string' || service.displayName.length > 200 || /[\u0000-\u001f\u007f]/u.test(service.displayName))) fail('config_invalid');
    if (Object.hasOwn(service,'enabled') && typeof service.enabled !== 'boolean') fail('config_invalid');
    if (Object.hasOwn(service,'kind') && !['custom','builtin'].includes(service.kind)) fail('config_invalid');
    for (const field of ['selectedModelIds','modelOrder']) {
      if (Object.hasOwn(service,field) && (!Array.isArray(service[field]) || service[field].length > 3000 || !service[field].every(isModelId) || new Set(service[field]).size !== service[field].length)) fail('config_invalid');
    }
    if (Object.hasOwn(service,'ownedOverrides')) {
      if (!record(service.ownedOverrides)) fail('config_invalid');
      for (const [modelId, fields] of Object.entries(service.ownedOverrides)) {
        if (!isModelId(modelId)) fail('config_invalid');
        try { validateModelValues(fields); } catch { fail('config_invalid'); }
      }
    }
  }
  const receipts = Object.entries(value.receipts);
  if (receipts.length > RECEIPT_LIMIT) fail('config_invalid');
  for (const [id, item] of receipts) {
    if (!isOpaqueId(id) || !record(item) || Object.keys(item).some(key => !['fingerprint','result'].includes(key)) || !digest(item.fingerprint)) fail('config_invalid');
    const safe = safeReceipt(item.result);
    if (Object.keys(item.result).some(key => !Object.hasOwn(safe,key)) || Object.keys(item.result.sync).some(key => !Object.hasOwn(safe.sync,key))) fail('config_invalid');
  }
}
