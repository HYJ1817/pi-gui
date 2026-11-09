import fs from 'node:fs';
import path from 'node:path';

const oauthReasons = Object.freeze({
  no_live_runtime: '暂无运行中的会话，模型同步待确认',
  runtime_sync_pending: '当前会话继续运行，模型同步待确认',
  credential_unconfirmed: '认证操作尚未确认，模型同步仍待验证',
  sync_evidence_unavailable: '暂时无法读取模型同步状态，请稍后重试',
  runtime_readback_failed: 'Pi 未能确认当前会话的模型同步，请重试',
});

export function runtimeSessionWitness(state, resolveSession, expectedIdentity) {
  if (typeof state?.sessionId !== 'string' || typeof state.sessionFile !== 'string' || !path.isAbsolute(state.sessionFile)) return null;
  const target = resolveSession(state.sessionId);
  if (!target?.file) return null;
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalize(target.file) !== normalize(state.sessionFile)) return null;
  const file = fs.lstatSync(target.file);
  if (!file.isFile() || file.isSymbolicLink()) return null;
  if (expectedIdentity && (file.dev !== expectedIdentity.dev || file.ino !== expectedIdentity.ino ||
      file.birthtimeMs !== expectedIdentity.birthtimeMs)) return null;
  return `${normalize(target.file)}:${file.dev}:${file.ino}:${file.birthtimeMs}`;
}

export function runtimeWitnessCurrent(evidence) {
  try {
    return runtimeSessionWitness(evidence.state, () => ({ file: evidence.state.sessionFile })) === evidence.witness;
  } catch { return false; }
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const modelKey = model => typeof model?.provider === 'string' && typeof model.id === 'string' ? `${model.provider}/${model.id}` : null;
const stateKey = state => [state?.sessionId, state?.sessionFile, modelKey(state?.model), state?.thinkingLevel];
const idleState = state => state?.isStreaming === false && state.isCompacting === false && state.pendingMessageCount === 0 &&
  typeof state.thinkingLevel === 'string';

export function createProviderConfigSync({ store, hasLiveRuntime = () => false, authMutationActive = () => false, targets = () => [], blocked = () => false }) {
  const results = new Map();
  let queued = false;
  const evidence = () => store.readSyncEvidence?.();
  const status = (state, reason = null) => ({ state, reason });

  function capture(binding) {
    try {
      const source = evidence();
      return source && !source.unconfirmed && binding?.identity && binding.version === '1.5.0' && binding.agent
        ? { binding, native: source.native } : null;
    } catch { return null; }
  }

  function eligible(target, source) {
    return target.ready && target.launch?.native === source.native && target.current();
  }

  function collect(source, live) {
    for (const id of results.keys()) if (!live.some(target => target.id === id)) results.delete(id);
    return live.map(target => {
      const prior = results.get(target.id);
      const valid = eligible(target, source) && prior?.key === target.key && prior.native === source.native &&
        (prior.state !== 'applied' || !target.witnessCurrent || target.witnessCurrent(prior.session));
      return { id: target.id, kind: target.kind, ...(valid ? status(prior.state, prior.reason) : status('pending', 'runtime_sync_pending')) };
    });
  }

  function snapshot(metadata, revision) {
    try {
      const source = evidence();
      if (source) {
        if (revision !== undefined && source.revision !== revision) return status('pending', 'runtime_sync_pending');
        if (source.unconfirmed) return authMutationActive() ? status('pending', 'runtime_sync_pending') : status('error', 'credential_unconfirmed');
        if (!source.required) return status('idle');
        const runtimes = collect(source, targets());
        const state = !runtimes.length ? status('pending', 'no_live_runtime')
          : runtimes.some(item => item.state === 'syncing') ? status('syncing')
          : runtimes.some(item => item.state === 'error') ? status('error', 'runtime_readback_failed')
          : runtimes.every(item => item.state === 'applied') ? status('applied') : status('pending', 'runtime_sync_pending');
        return { ...state, runtimes };
      }
      const intent = store.readAuthSyncIntent();
      if (intent.unconfirmed) return authMutationActive() ? { state: 'pending', reason: 'runtime_sync_pending' }
        : { state: 'error', reason: 'credential_unconfirmed' };
      if (!intent.generation && (metadata ?? store.read().metadata).syncRequired !== true) return { state: 'idle', reason: null };
      return { state: 'pending', reason: hasLiveRuntime() ? 'runtime_sync_pending' : 'no_live_runtime' };
    } catch (error) { return error.code === 'config_busy' ? status('pending', 'runtime_sync_pending') : status('error', 'sync_evidence_unavailable'); }
  }

  async function readback(target, source, retryErrors) {
    if (!eligible(target, source)) return;
    const previous = results.get(target.id);
    if (previous?.key === target.key && previous.native === source.native) {
      if (previous.task) return previous.task;
      if (previous.state === 'applied' && (!target.witnessCurrent || target.witnessCurrent(previous.session))) return;
      if (previous.state === 'error' && !retryErrors) return;
    }
    if (blocked() || target.busy()) return;
    const record = { key: target.key, native: source.native, ...status('syncing') };
    results.set(target.id, record);
    const current = () => results.get(target.id) === record && target.current();
    const read = async type => {
      if (!current()) return null;
      const value = await target.request(type);
      if (!current()) return null;
      if (!value || Object.hasOwn(value, '__error')) throw Error('runtime_readback_failed');
      return value;
    };
    record.task = (async () => {
      try {
        const before = await read('get_state');
        const witness = before && await target.session(before);
        if (!witness || !current() || !idleState(before)) return;
        const directory = await read('get_available_models');
        const thinking = await read('get_available_thinking_levels');
        const after = await read('get_state');
        if (!after || !same(stateKey(before), stateKey(after)) || witness !== await target.session(after) || !current() ||
            blocked() || target.busy() || !idleState(after)) return;
        const models = directory?.models, levels = thinking?.levels;
        if (!Array.isArray(models) || !models.every(modelKey) || !Array.isArray(levels) || !levels.every(level => typeof level === 'string') ||
            (after.model != null && (!modelKey(after.model) || !models.some(model => modelKey(model) === modelKey(after.model)))) ||
            (after.thinkingLevel != null && !levels.includes(after.thinkingLevel) &&
              !(after.model == null && after.thinkingLevel === 'off' && levels.length === 0))) throw Error('runtime_readback_failed');
        const live = evidence();
        if (!live || live.unconfirmed || live.native !== source.native || !current()) return;
        const indexed = new Map(models.map(model => [modelKey(model), model]));
        if (live.removed?.some(([provider, id]) => indexed.has(modelKey({ provider, id }))) || !live.expected.every(item => {
          const model = indexed.get(modelKey(item));
          return model && Object.entries(item.fields).every(([name, value]) => same(model[name], value));
        })) return;
        record.session = { state: { sessionId: after.sessionId, sessionFile: after.sessionFile }, witness };
        Object.assign(record, status('applied'));
      } catch {
        if (current()) Object.assign(record, status('error', 'runtime_readback_failed'));
      } finally {
        if (record.state === 'syncing') Object.assign(record, status('pending', 'runtime_sync_pending'));
        record.task = null;
      }
    })();
    return record.task;
  }

  async function retry({ retryErrors = true, revision } = {}) {
    try {
      const source = evidence();
      if (source?.required && !source.unconfirmed && (revision === undefined || revision === source.revision))
        await Promise.all(targets().map(target => readback(target, source, retryErrors)));
    } catch { /* Snapshot projects unavailable evidence. */ }
    return snapshot();
  }

  function observe() {
    if (queued) return;
    queued = true;
    setImmediate(() => { queued = false; void retry({ retryErrors: false }); });
  }

  return { capture, retry, observe, snapshot, oauthSnapshot() {
    const result = snapshot();
    return { state: result.state === 'applied' ? 'synced' : result.state, reason: oauthReasons[result.reason] ?? null };
  } };
}
