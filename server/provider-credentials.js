// Kept self-contained so the bundled backend can start this private worker
// without loading a second application bundle or exposing a public IPC route.
export const credentialWorkerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHmac, randomBytes, randomUUID } = require('node:crypto');
const { authPath, entry, ttlMs } = workerData;
const stages = new Map();
const active = new Map();
const nativeActive = new Map();
const queued = new Map();
const expired = new Set();
const revisionKey = randomBytes(32);
let loaded, catalogue;
let tail = Promise.resolve();
const failure = (code, credentialState = 'none', credentialSaved = false) => ({ ok: false, code, credentialState, credentialSaved });
const sync = { state: 'pending', reason: 'runtime_sync_pending' };
const fingerprint = value => createHmac('sha256', revisionKey).update(JSON.stringify(value)).digest('hex');
const unchanged = (a, b) => a && b && fingerprint(a) === fingerprint(b);
const cancelled = signal => signal?.throwIfAborted();

function memoryStore() {
  const values = new Map();
  return {
    async read(id, opts) { cancelled(opts?.signal); return structuredClone(values.get(id)); },
    async list(opts) { cancelled(opts?.signal); return [...values].map(([providerId, value]) => ({ providerId, type: value.type })); },
    async modify(id, fn, opts) {
      cancelled(opts?.signal);
      const value = await fn(structuredClone(values.get(id)));
      cancelled(opts?.signal);
      if (value !== undefined) values.set(id, structuredClone(value));
      return structuredClone(values.get(id));
    },
    async delete(id, opts) { cancelled(opts?.signal); values.delete(id); },
  };
}

function pathState() {
  const parents = [];
  for (let p = path.dirname(authPath); ; p = path.dirname(p)) { parents.unshift(p); if (p === path.dirname(p)) break; }
  const identity = [];
  for (const parent of parents) {
    let stat;
    try { stat = fs.lstatSync(parent, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return { stamp: null, parents: identity }; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe');
    identity.push([String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]);
  }
  try {
    const stat = fs.lstatSync(authPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 8n * 1024n * 1024n) throw new Error('unsafe');
    return { stamp: [stat.dev,stat.ino,stat.birthtimeNs,stat.size,stat.mtimeNs,stat.ctimeNs,stat.mode].map(String).join(':'), parents: identity };
  } catch (error) { if (error.code === 'ENOENT') return { stamp: null, parents: identity }; throw error; }
}

async function sdk() {
  loaded ??= import(entry).then(value => {
    if (typeof value.ModelRuntime?.create !== 'function' || typeof value.readStoredCredential !== 'function') throw new Error('unsupported');
    return value;
  });
  return loaded;
}
async function runtime({ credentials, signal, modelsPath = null } = {}) {
  const { ModelRuntime } = await sdk();
  const models = new Map();
  return ModelRuntime.create({ authPath, ...(credentials ? { credentials } : {}), modelsPath,
    ...(modelsPath ? { modelsStore: {
      async read(id) { return models.get(id); }, async write(id, item) { models.set(id, item); }, async delete(id) { models.delete(id); },
    } } : {}),
    allowModelNetwork: false, refreshOnCreate: false, signal });
}
async function builtIn(id) {
  catalogue ??= runtime({ credentials: memoryStore() }).then(rt => new Set(rt.getProviders().map(provider => provider.id)));
  return (await catalogue).has(id);
}

async function inspect(id, signal = new AbortController().signal) {
  let known = null;
  try { known = await builtIn(id); } catch { /* Method proof is independent of file absence. */ }
  try {
    const before = pathState();
    if (before.stamp === null) return { present: false, type: null, builtIn: known, revision: fingerprint([id,before,null]), raw: null };
    const { readStoredCredential } = await sdk();
    const rt = await runtime({ signal });
    const listed = await rt.listCredentials({ signal });
    if (!Array.isArray(listed)) throw new Error('unknown');
    const matches = listed.filter(item => item.providerId === id);
    const raw = readStoredCredential(id, authPath);
    if (!unchanged(before, pathState()) || matches.length > 1 || (matches.length === 0) !== (raw === undefined)) throw new Error('unknown');
    if (raw && (!['api_key','oauth'].includes(raw.type) || raw.type !== matches[0]?.type)) throw new Error('unknown');
    return { present: Boolean(raw), type: raw?.type ?? null, builtIn: known, revision: fingerprint([id,before,raw ?? null]), raw: raw ?? null };
  } catch { return { present: null, type: null, builtIn: known, revision: null, raw: null }; }
}
const publicInspection = data => ({ ok: data.present !== null, present: data.present, type: data.type, builtIn: data.builtIn, credentialRevision: data.revision });

function literalEncode(value) {
  const escaped = value.replace(/\$/g, () => '$$');
  return escaped.startsWith('!') ? '$!' + escaped.slice(1) : escaped;
}
function literalDecode(value) {
  if (typeof value !== 'string' || value.startsWith('!')) return null;
  let result = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '$') { result += value[i]; continue; }
    const escape = value[++i];
    if (escape !== '$' && escape !== '!') return null;
    result += escape;
  }
  return result;
}
function disposeStage(id, revision) {
  const items = stages.get(id);
  if (!items) return;
  for (const [key, stage] of items) {
    if (revision !== undefined && key !== revision) continue;
    clearTimeout(stage.timer);
    items.delete(key);
  }
  if (items.size === 0) stages.delete(id);
}
function stageFor(binding, value, retain) {
  for (const revision of stages.get(binding.draftId)?.keys() ?? []) {
    if (revision !== retain) disposeStage(binding.draftId, revision);
  }
  expired.delete(binding.draftId);
  const stagedRevision = randomUUID();
  const expires = Date.now() + ttlMs;
  const timer = setTimeout(() => {
    disposeStage(binding.draftId, stagedRevision);
    if (!stages.has(binding.draftId)) expired.add(binding.draftId);
    if (expired.size > 32) expired.delete(expired.values().next().value);
  }, ttlMs);
  timer.unref();
  if (!stages.has(binding.draftId)) stages.set(binding.draftId, new Map());
  stages.get(binding.draftId).set(stagedRevision, { ...value, binding, expires, timer });
  return { stagedRevision, expires };
}

async function login(rt, binding, value, signal, memory = false) {
  const { providerId, connection } = binding;
  let provider = rt.getProviders().find(item => item.id === providerId);
  if (!provider && memory) {
    rt.registerProvider(providerId, { ...connection, models: [] });
    provider = rt.getProviders().find(item => item.id === providerId);
  }
  if (typeof provider?.auth?.apiKey?.login !== 'function') throw new Error('unsupported');
  let used = false;
  await rt.login(providerId, 'api_key', {
    signal,
    prompt: async prompt => {
      cancelled(signal);
      cancelled(prompt?.signal);
      if (prompt?.type !== 'secret' || used) throw new Error('unsupported prompt');
      used = true;
      return value;
    },
    notify: () => {},
  });
  if (!used) throw new Error('unsupported login');
}

async function stage(message) {
  const { binding, input, expectedCredentialRevision, confirmOAuthReplacement, retain } = message;
  if (message.cancelled) return failure('cancelled');
  if (!stages.has(binding.draftId) && stages.size >= 16) return failure('busy');
  const controller = new AbortController();
  active.set(binding.draftId, controller);
  const signal = controller.signal;
  try {
    const before = await inspect(binding.providerId, signal);
    cancelled(signal);
    if (!before.revision || before.revision !== expectedCredentialRevision) return failure('credential_conflict');
    if (before.type === 'oauth' && !confirmOAuthReplacement) return failure('oauth_conflict');
    if (message.action === 'stage-clear') {
      if (!before.present) return failure('credential_conflict');
      return { ok: true, credentialState: 'clear-staged', credentialSaved: null,
        ...stageFor(binding, { kind: 'clear', expectedCredentialRevision }, retain) };
    }
    const memory = memoryStore();
    await login(await runtime({ credentials: memory, signal }), binding, input, signal, true);
    const raw = await memory.read(binding.providerId, { signal });
    if (raw?.type !== 'api_key' || raw.key !== input) return failure('unsupported');
    cancelled(signal);
    return { ok: true, credentialState: 'staged', credentialSaved: null,
      ...stageFor(binding, { kind: 'set', memory, expectedCredentialRevision }, retain) };
  } catch { return failure(signal.aborted ? 'cancelled' : 'unsupported'); }
  finally { active.delete(binding.draftId); }
}

async function withNativeRuntime(binding, signal, run) {
  if (await builtIn(binding.providerId)) return run(await runtime({ signal }));
  // registerProvider() starts an unscoped availability refresh. The native
  // storage runtime instead receives a temporary, non-secret registration for
  // just this custom provider and starts with refreshOnCreate:false.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provider-native-'));
  const modelsPath = path.join(directory, 'models.json');
  try {
    fs.writeFileSync(modelsPath, JSON.stringify({ providers: { [binding.providerId]: { ...binding.connection, models: [] } } }), { flag: 'wx', mode: 0o600 });
    return await run(await runtime({ modelsPath, signal }));
  } finally {
    try { fs.unlinkSync(modelsPath); } finally { fs.rmdirSync(directory); }
  }
}

function matchingStage(binding, stagedRevision, kind) {
  const items = stages.get(binding.draftId);
  const revision = stagedRevision ?? (items?.size === 1 ? items.keys().next().value : null);
  const pending = items?.get(revision);
  if (pending?.kind !== kind || !unchanged(pending.binding, binding)) return null;
  return pending;
}

async function persist(message, signal) {
  const { binding, stagedRevision } = message;
  if (message.cancelled || signal.aborted) return failure('cancelled');
  const pending = matchingStage(binding, stagedRevision, message.action === 'clear' ? 'clear' : 'set');
  if (!pending) return expired.has(binding.draftId) ? failure('expired', 'expired') : failure('credential_conflict');
  disposeStage(binding.draftId);
  if (pending.expires <= Date.now()) return failure('expired', 'expired');
  const before = await inspect(binding.providerId, signal);
  if (signal.aborted) return failure('cancelled');
  if (!before.revision || before.revision !== pending.expectedCredentialRevision) return failure('credential_conflict');
  const key = (await pending.memory?.read(binding.providerId, { signal }))?.key;
  if (pending.kind === 'set' && typeof key !== 'string') return failure('credential_conflict');
  let threw = false, sdkSyncFailed = false;
  try {
    const api = await sdk();
    try {
      await withNativeRuntime(binding, signal, rt => {
        cancelled(signal);
        return pending.kind === 'clear' ? rt.logout(binding.providerId, { signal }) : login(rt, binding, literalEncode(key), signal);
      });
    } catch (error) {
      threw = true;
      sdkSyncFailed = typeof api.CredentialSynchronizationError === 'function' && error instanceof api.CredentialSynchronizationError;
    }
  } catch { threw = true; }
  const after = await inspect(binding.providerId, signal);
  const confirmed = pending.kind === 'clear' ? after.present === false : after.type === 'api_key' && literalDecode(after.raw?.key) === key;
  if (confirmed) return { ok: true, credentialSaved: true, credentialState: pending.kind === 'clear' ? 'cleared' : 'saved', sync,
    ...(sdkSyncFailed ? { code: 'sdk_sync_pending' } : {}) };
  if (threw && !sdkSyncFailed && after.present !== null && fingerprint(before.raw) === fingerprint(after.raw)) return failure('native_write_failed', 'saved-credential-error');
  return failure('credential_unconfirmed', 'credential-unconfirmed', null);
}

async function handle(message, signal) {
  if (message.action === 'probe') {
    await sdk();
    return { ok: true, sdk: true };
  }
  if (message.action === 'inspect') return publicInspection(await inspect(message.providerId));
  if (message.action === 'stage' || message.action === 'stage-clear') return stage(message);
  if (message.action === 'inspect-stage') {
    const pending = matchingStage(message.binding, message.stagedRevision, message.kind);
    if (!pending || pending.expires <= Date.now()) return failure('credential_conflict');
    const before = await inspect(message.binding.providerId);
    return before.revision && before.revision === pending.expectedCredentialRevision && pending.expires > Date.now() ?
      { ok: true, expires: pending.expires } : failure('credential_conflict');
  }
  if (message.action === 'persist' || message.action === 'clear') return persist(message, signal);
  return failure('unsupported');
}
parentPort.on('message', message => {
  if (message.action === 'cancel-native') {
    const queuedAttempt = queued.get(message.id);
    if (queuedAttempt) queuedAttempt.cancelled = true;
    nativeActive.get(message.id)?.abort();
    return;
  }
  if (message.action === 'discard-stage') {
    disposeStage(message.draftId, message.stagedRevision);
    parentPort.postMessage({ id: message.id, result: { ok: true } });
    return;
  }
  if (message.action === 'dispose-draft') {
    active.get(message.draftId)?.abort();
    disposeStage(message.draftId);
    expired.delete(message.draftId);
    for (const request of queued.values()) if (request.binding.draftId === message.draftId) request.cancelled = true;
    // Also clear work that was queued before this cancellation.
    tail = tail.then(() => { disposeStage(message.draftId); parentPort.postMessage({ id: message.id, result: { ok: true } }); });
    return;
  }
  const mutation = message.action === 'persist' || message.action === 'clear';
  if (mutation || ['stage','stage-clear'].includes(message.action)) queued.set(message.id, message);
  tail = tail.then(async () => {
    queued.delete(message.id);
    const controller = mutation ? new AbortController() : null;
    if (controller) nativeActive.set(message.id, controller);
    let result;
    try { result = await handle(message, controller?.signal); } catch { result = failure('credential_unconfirmed', 'credential-unconfirmed', null); }
    finally { if (controller) nativeActive.delete(message.id); }
    parentPort.postMessage({ id: message.id, result, nativeQuiesced: mutation });
  });
});
`;
