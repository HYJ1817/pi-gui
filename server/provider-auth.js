/* User-level auth lifetime: independent of workspace and Composer generations.
 * Native credential commits are always followed by a fresh Pi status read. */
import { randomUUID } from 'node:crypto';
import { json, readBody } from './http-utils.js';
import { authDescriptor, safeAuthUrl } from './provider-auth-sdk.js';

const TERMINAL = new Set(['success', 'cancelled', 'failed']);
const ERRORS = {
  busy: '已有认证操作正在执行，请完成或取消后再试',
  unsupported: '当前 Pi 不支持此供应商的 GUI 登录，请在 Pi 交互终端使用 /login',
  stale: '这条认证交互已失效，请读取当前状态',
  input: '请输入当前 Pi 登录步骤要求的内容',
  timeout: '登录已超时，请重新发起登录',
  'unsafe-url': 'Pi 返回的授权地址不符合安全规则，登录已停止',
  'secret-input-not-supported': '此步骤需要秘密输入；请在 Pi 交互终端完成 /login',
  'native-auth-failed': 'Pi 原生认证未完成；请检查 Pi 登录或本机网络后重试',
  unconfirmed: '认证操作已结束，但 Pi 尚未确认结果；请刷新状态或在 Pi 终端检查',
};

export function createProviderAuth({ adapter, busyReason = () => null, synchronize = async () => ({ ok: true }),
  readModels = async () => null, customProviders = () => [], startBlocked = () => false, timeoutMs = 5 * 60 * 1000 } = {}) {
  let generation = 0, active = null, current = null, revision = 0, readSequence = 0, disposed = false;
  let data = { capability: { sdkAvailable: false, reason: '正在读取 Pi 认证能力', piVersion: null }, providers: [] };
  let synchronization = { state: 'idle', reason: null }; let needsSync = false, syncPromise = null;
  let readQueue = Promise.resolve();
  const snapshot = () => structuredClone({ ok: true, ...data, flow: current, sync: synchronization });
  const fail = code => ({ ok: false, code, error: ERRORS[code] || ERRORS['native-auth-failed'] });
  function update(flow, patch) {
    if (current !== flow || disposed) return;
    Object.assign(flow, patch, { revision: ++revision });
  }
  function owns(flow) { return !disposed && active?.flow === flow && flow.generation === generation && !active.controller.signal.aborted && !TERMINAL.has(flow.state); }
  function identity() { try { return adapter.identityKey?.() || ''; } catch { return ''; } }
  function refresh() {
    const gen = generation;
    // Serialize native reads. In particular the mandatory post-operation read
    // must not lose to an older status poll that started before credential commit.
    const next = readQueue.then(() => refreshOnce(gen));
    readQueue = next.catch(() => {});
    return next;
  }
  async function refreshOnce(gen) {
    const seq = ++readSequence;
    let result;
    try { result = await adapter.list(); } catch { result = { capability: { sdkAvailable: false, reason: '无法读取 Pi 认证状态（未知）', piVersion: null }, providers: [] }; }
    let models = null;
    try { models = await readModels(); } catch { /* model availability remains unknown */ }
    if (disposed || seq !== readSequence || gen !== generation) return snapshot();
    const providers = new Map((result.providers || []).map(p => [p.providerId, p]));
    // Runtime-only extension providers are discoverable but cannot be falsely
    // attributed to the separate SDK instance. Their auth status stays unknown.
    const custom = new Set(customProviders());
    for (const m of models || []) {
      if (!providers.has(m.provider)) providers.set(m.provider, authDescriptor({ providerId: m.provider, displayName: m.provider, unknown: true, source: custom.has(m.provider) ? 'models-json' : 'unknown' }));
    }
    for (const id of custom) if (!providers.has(id)) providers.set(id, authDescriptor({ providerId: id, displayName: id, unknown: true, source: 'models-json' }));
    for (const p of providers.values()) {
      p.models = (models || []).filter(m => m.provider === p.providerId).map(m => ({ id: m.id, name: m.name || m.id }));
      p.modelAvailable = Array.isArray(models) ? p.models.length > 0 : null;
    }
    data = { capability: result.capability, providers: [...providers.values()] };
    return snapshot();
  }
  function read() { return refresh().then(() => { void sync(); return snapshot(); }); }
  function notify(flow, event) {
    if (!owns(flow)) return;
    if (event?.type === 'auth_url' || event?.type === 'device_code') {
      const url = safeAuthUrl(event.type === 'auth_url' ? event.url : event.verificationUri);
      if (!url) { terminate(flow, 'unsafe-url'); return; }
      const userCode = event.type === 'device_code' && typeof event.userCode === 'string' && /^[A-Za-z0-9 -]{1,64}$/.test(event.userCode) ? event.userCode : null;
      if (event.type === 'device_code' && !userCode) { terminate(flow, 'native-auth-failed'); return; }
      if (flow.url === url && flow.userCode === userCode) return;
      update(flow, { state: event.type === 'device_code' ? 'waiting-device-code' : 'waiting-browser', url, userCode, notice: event.type === 'device_code' ? '请打开授权页面并输入设备代码' : '请在浏览器授权，正在等待 Pi 登录完成' });
    } else if (!flow.prompt && !flow.url) update(flow, { state: 'verifying', notice: 'Pi 正在处理认证…' });
  }
  function prompt(flow, p) {
    if (!owns(flow)) return Promise.reject(new Error('cancelled'));
    if (!['text', 'manual_code', 'select'].includes(p?.type)) {
      const error = new Error('secret input forbidden'); error.code = 'secret-input-not-supported'; return Promise.reject(error);
    }
    if (active.answer) return Promise.reject(new Error('duplicate prompt'));
    return new Promise((resolve, reject) => {
      const id = flow.id + '-prompt-' + (++revision);
      const options = p.type === 'select' ? (p.options || []).filter(o => typeof o.id === 'string' && o.id.length <= 100 && typeof o.label === 'string').slice(0, 20).map(o => ({ id: o.id, label: o.label.slice(0, 200) })) : [];
      const onAbort = () => { if (active?.answer?.id === id) { active.answer = null; update(flow, { prompt: null, state: 'verifying', notice: 'Pi 正在确认浏览器回调…' }); } reject(new Error('cancelled')); };
      active.answer = { id, nativeId: p.id, resolve: v => { p.signal?.removeEventListener('abort', onAbort); resolve(v); }, reject: e => { p.signal?.removeEventListener('abort', onAbort); reject(e); } };
      p.signal?.addEventListener('abort', onAbort, { once: true });
      if (p.signal?.aborted) { onAbort(); return; }
      update(flow, { state: 'waiting-input', prompt: { id, type: p.type, options }, notice: p.type === 'select' ? '请选择 Pi 提供的登录方式' : '请按 Pi 的授权流程粘贴授权码或完整回调地址' });
    });
  }
  function abortPrompt(flow, nativeId) {
    if (!owns(flow) || active.answer?.nativeId !== nativeId) return;
    const answer = active.answer; active.answer = null;
    answer.reject(new Error('native prompt cancelled'));
    update(flow, { prompt: null, state: 'verifying', notice: 'Pi 正在确认浏览器回调…' });
  }
  function terminate(flow, code) {
    if (!active || current !== flow || TERMINAL.has(flow.state)) return fail('stale');
    update(flow, { state: code === 'cancelled' ? 'cancelled' : 'failed', errorCode: code === 'cancelled' ? null : code,
      prompt: null, url: null, userCode: null, notice: code === 'cancelled' ? '已取消登录' : (ERRORS[code] || ERRORS['native-auth-failed']) });
    if (active.answer) { active.answer.reject(new Error('cancelled')); active.answer = null; }
    needsSync = true;
    synchronization = { state: 'pending', reason: '正在等待 Pi 终止认证并回读状态' };
    active.controller.abort(); return snapshot();
  }
  async function execute(op) {
    const { flow, controller } = op;
    let errorCode = null;
    try {
      await refresh();
      if (!owns(flow)) return;
      const provider = data.providers.find(p => p.providerId === flow.providerId);
      if (!data.capability.sdkAvailable || !provider || (flow.operation === 'login' ? !provider.canLogin : !provider.canLogout)) { errorCode = 'unsupported'; return; }
      if (flow.operation === 'login') await adapter.login(flow.providerId, 'oauth', { signal: controller.signal, notify: e => notify(flow, e), prompt: p => prompt(flow, p), abortPrompt: id => abortPrompt(flow, id) });
      else await adapter.logout(flow.providerId, { signal: controller.signal });
    } catch (error) {
      errorCode = Object.hasOwn(ERRORS, error?.code) ? error.code : 'native-auth-failed';
    } finally {
      clearTimeout(op.timer);
      if (op.answer) { op.answer.reject(new Error('auth ended')); op.answer = null; }
      if (active === op && !disposed) {
        await refresh();
        if (!TERMINAL.has(flow.state)) {
          const provider = data.providers.find(p => p.providerId === flow.providerId);
          const confirmed = flow.operation === 'login' ? provider?.authenticated === true && provider?.authType === 'oauth' && provider?.credentialStored === true : provider?.credentialStored === false && data.capability.sdkAvailable;
          const code = errorCode || (confirmed ? null : 'unconfirmed');
          update(flow, { state: code ? 'failed' : 'success', errorCode: code, prompt: null, url: null, userCode: null,
            notice: code ? ERRORS[code] : flow.operation === 'login' ? 'Pi 已确认保存登录；正在同步模型状态' : 'Pi 已确认移除保存的认证；环境变量或自定义配置仍可能有效' });
        }
        active = null;
        // A native operation may commit and then fail to synchronize. Even
        // cancellation is read back; exit code/Promise alone is not evidence.
        needsSync = true; synchronization = { state: 'pending', reason: null };
        await sync();
      }
    }
  }
  async function begin(providerId, operation, authType = 'oauth') {
    if (disposed) return fail('unsupported');
    if (active || syncPromise || startBlocked()) return fail('busy');
    if (typeof providerId !== 'string' || !providerId || providerId.length > 200 || /[\u0000-\u001f]/.test(providerId) || authType !== 'oauth') return fail('unsupported');
    const flow = current = { id: randomUUID(), generation: ++generation, revision: ++revision, providerId, operation, state: 'starting', url: null, userCode: null, prompt: null, errorCode: null, notice: operation === 'login' ? '正在启动 Pi 原生登录…' : '正在请求 Pi 移除保存的认证…' };
    const op = active = { flow, identity: identity(), controller: new AbortController(), answer: null };
    op.timer = setTimeout(() => terminate(flow, 'timeout'), Math.max(1, timeoutMs)); op.timer.unref?.();
    void execute(op);
    return snapshot();
  }
  function respond(flowId, promptId, value) {
    const flow = current;
    if (!active || !flow || flow.id !== flowId || !owns(flow) || !active.answer || active.answer.id !== promptId) return fail('stale');
    if (typeof value !== 'string' || !value.trim() || value.length > 8192 || (flow.prompt.type === 'select' && !flow.prompt.options.some(o => o.id === value))) return fail('input');
    const answer = active.answer; active.answer = null;
    update(flow, { state: 'verifying', prompt: null, notice: 'Pi 正在验证授权…' }); answer.resolve(value); return snapshot();
  }
  function cancel(flowId) { if (!current || current.id !== flowId) return fail('stale'); return terminate(current, 'cancelled'); }
  async function sync() {
    if (disposed || !needsSync || active) return snapshot();
    if (syncPromise) { await syncPromise; return snapshot(); }
    if (busyReason()) { synchronization = { state: 'pending', reason: '当前 Pi 正在运行任务，空闲后同步认证和模型' }; return snapshot(); }
    const gen = generation;
    synchronization = { state: 'syncing', reason: '正在回读当前 Pi 的模型状态' };
    syncPromise = (async () => {
      // Reserve single-flight before lifecycle events can synchronously reenter.
      await Promise.resolve();
      let result; try { result = await synchronize(); } catch { result = { ok: false }; }
      if (disposed || gen !== generation) return;
      needsSync = !result?.ok;
      synchronization = { state: result?.ok ? 'synced' : 'error', reason: result?.ok ? null : '认证已回读，模型同步尚未确认；请重试同步' };
      await refresh();
    })();
    try { await syncPromise; } finally { syncPromise = null; }
    return snapshot();
  }
  function observeRuntime() {
    if (active && active.identity !== identity()) terminate(active.flow, 'cancelled');
    void sync();
  }
  async function handle(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/provider-auth') return json(res, 200, await read());
    if (req.method !== 'POST') return json(res, 405, fail('unsupported'));
    let payload;
    try { payload = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, fail('input')); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json(res, 400, fail('input'));
    const action = url.pathname.slice('/api/provider-auth/'.length);
    let result;
    if (action === 'login') result = await begin(payload.providerId, 'login', payload.authType);
    else if (action === 'logout') result = await begin(payload.providerId, 'logout');
    else if (action === 'respond') result = respond(payload.flowId, payload.promptId, payload.value);
    else if (action === 'cancel') result = cancel(payload.flowId);
    else if (action === 'sync') result = await sync();
    else result = fail('unsupported');
    return json(res, result.ok ? 200 : result.code === 'busy' || result.code === 'stale' ? 409 : 400, result);
  }
  function dispose() {
    if (active) { clearTimeout(active.timer); active.answer?.reject(new Error('shutdown')); active.controller.abort(); }
    disposed = true; generation++; readSequence++; adapter.dispose?.();
  }
  return { read, snapshot, start: (id, type) => begin(id, 'login', type), logout: id => begin(id, 'logout'), respond, cancel, sync, observeRuntime, inFlight: () => !!active || !!syncPromise, handle, dispose };
}
