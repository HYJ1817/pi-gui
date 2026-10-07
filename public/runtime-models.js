/* Per-conversation model metadata, confirmed by native Pi readback. Mutating
 * commands are correlated with accepted runtime events; an HTTP write ack only
 * confirms transport. Credentials and raw response diagnostics never live here. */
import { runtimeSessionAction } from './api.js';
import { runtimeStore, onRuntimeChange } from './runtime-state.js';
import { modelIdentity, modelCapability } from './model-capabilities.js';

const OWNER_KEYS = ['backendInstance', 'projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'conversationId', 'runtimeId', 'runtimeGeneration', 'sessionId'];
const same = (a, b) => Boolean(a && b && OWNER_KEYS.every(k => Object.hasOwn(a, k) && Object.hasOwn(b, k) && a[k] === b[k]));
const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 300) : null;
let commandSequence = 0;
const commandId = () => globalThis.crypto?.randomUUID?.() || `runtime-model-${Date.now()}-${++commandSequence}`;
function safeModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const identity = modelIdentity(raw);
  if (!identity.providerId || !identity.modelId) return null;
  const capability = modelCapability(raw);
  return { ...identity, provider: identity.providerId, id: identity.modelId,
    name: text(raw.name) || identity.modelId, reasoning: capability.reasoning.supported, capability };
}
const empty = () => ({ model: null, models: [], thinkingLevel: null, levels: null, reasoning: null, capability: null, sessionName: null, pending: false, notice: '' });

export function createRuntimeModels({ store = runtimeStore, request = runtimeSessionAction,
  subscribe = onRuntimeChange, onChange = () => {}, timeoutMs = 10000 } = {}) {
  const entries = new Map(); let alive = true;
  function retire(entry) { entry.token++; entry.cancel?.(); entry.cancel = null; }
  function entryFor(id) {
    const record = store.get(id), owner = record?.owner;
    let entry = entries.get(id);
    if (!owner || !OWNER_KEYS.every(k => Object.hasOwn(owner, k) && (typeof owner[k] === 'string' || k === 'sessionId' && owner[k] === null))) {
      if (entry) { retire(entry); entries.delete(id); }
      return null;
    }
    if (!entry || !same(entry.owner, owner)) {
      if (entry) retire(entry);
      entry = { owner: { ...owner }, token: 0, value: empty(), cancel: null, waiter: null };
      entries.set(id, entry);
    }
    return entry;
  }
  function current(id, entry, token) { return alive && entries.get(id) === entry && entry.token === token && same(store.get(id)?.owner, entry.owner); }
  function notify(id) { if (alive) onChange(id); }
  function begin(id, entry) { retire(entry); entry.value.pending = true; entry.value.notice = ''; notify(id); return entry.token; }
  function finish(id, entry, token, notice = '') {
    if (!current(id, entry, token)) return;
    entry.value.pending = false; entry.value.notice = notice; entry.cancel = null; entry.waiter = null; notify(id);
  }
  async function readback(id, entry, token) {
    const owner = { ...entry.owner };
    const read = type => request({ action: 'read', owner, command: { type } });
    const state = await read('get_state');
    if (!current(id, entry, token)) return false;
    if (!state?.ok || !state.data || !Object.hasOwn(state.data, 'model')) return false;
    const model = safeModel(state.data.model);
    if (state.data.model && !model) return false;
    const [available, thinking] = await Promise.all([read('get_available_models'), read('get_available_thinking_levels')]);
    if (!current(id, entry, token)) return false;
    const capability = model ? modelCapability(model) : null;
    const reasoning = capability?.reasoning.supported ?? null;
    const levels = thinking?.ok && Array.isArray(thinking.data?.levels) && thinking.data.levels.every(v => typeof v === 'string' && text(v))
      ? [...new Set(thinking.data.levels.map(text))] : null;
    entry.value = { ...entry.value, model, capability, reasoning,
      models: available?.ok && Array.isArray(available.data?.models) ? available.data.models.map(safeModel).filter(Boolean) : [],
      thinkingLevel: text(state.data.thinkingLevel), sessionName: text(state.data.sessionName),
      // A no-model Pi may return every level. That is not capability evidence.
      levels: reasoning === true ? levels : null };
    return true;
  }
  async function refresh(id) {
    const entry = alive && entryFor(id); if (!entry) return false;
    const token = begin(id, entry); let success = false;
    try { success = await readback(id, entry, token); return success; }
    catch { return false; }
    finally { finish(id, entry, token, success ? '' : '未能确认当前模型，请重试。'); }
  }
  async function mutate(id, command) {
    const entry = alive && entryFor(id); if (!entry) return false;
    const token = begin(id, entry), wire = { ...command, id: commandId() };
    let resolveResponse, cancelWait, timer;
    const response = new Promise(resolve => { resolveResponse = resolve; });
    const cancelled = new Promise(resolve => { cancelWait = () => resolve(null); });
    entry.cancel = cancelWait;
    entry.waiter = { id: wire.id, command: wire.type, resolve: resolveResponse };
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
    let success = false;
    try {
      const ack = Promise.resolve(request({ action: 'command', owner: { ...entry.owner }, command: wire }))
        .then(result => { if (!result?.ok) resolveResponse(null); return result; }).catch(() => { resolveResponse(null); return null; });
      const result = await Promise.race([Promise.all([ack, response]), cancelled, timeout]);
      if (!current(id, entry, token) || !result || !result[0]?.ok || result[1]?.success !== true) return false;
      success = await readback(id, entry, token);
      return success;
    } catch { return false; }
    finally { clearTimeout(timer); finish(id, entry, token, success ? '' : 'Pi 未能确认模型操作，请重试或检查模型配置。'); }
  }
  const unsubscribe = subscribe(frame => {
    for (const [id, entry] of [...entries]) {
      if (!same(store.get(id)?.owner, entry.owner)) { retire(entry); entries.delete(id); notify(id); }
    }
    if (frame?.type !== 'runtime_event' || frame.event?.type !== 'response') return;
    const id = frame.owner?.conversationId, entry = entries.get(id), waiter = entry?.waiter;
    if (!waiter || !same(entry.owner, frame.owner) || !same(store.get(id)?.owner, frame.owner)) return;
    if (frame.event.id === waiter.id && frame.event.command === waiter.command) { entry.waiter = null; waiter.resolve({ success: frame.event.success === true }); }
  });
  return {
    get(id) { if (!alive) return null; const entry = entryFor(id); return entry ? { ...entry.value, models: [...entry.value.models], levels: entry.value.levels && [...entry.value.levels] } : null; },
    refresh,
    setModel(id, identity) { const model = modelIdentity(identity); return model.providerId && model.modelId ? mutate(id, { type: 'set_model', provider: model.providerId, modelId: model.modelId }) : Promise.resolve(false); },
    setThinking(id, level) { const entry = alive && entryFor(id); return entry?.value.reasoning === true && entry.value.levels?.includes(level) ? mutate(id, { type: 'set_thinking_level', level }) : Promise.resolve(false); },
    dispose() { alive = false; unsubscribe(); for (const entry of entries.values()) retire(entry); entries.clear(); },
  };
}
