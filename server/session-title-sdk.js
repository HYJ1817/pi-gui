/* 独立标题模型调用（Pi SDK，凭据只留在 worker 内）。
 *
 * 复用 provider-auth-sdk 的边界：只解析 Pi 包的**公开导出**，Worker 里用
 * `ModelRuntime.create` 读取同一份 auth.json / models.json，调用
 * `completeSimple` 做一次有界的纯文本生成。不会创建 Pi 会话、不会写会话
 * 文件、不会触发工具，也不会把 SDK 错误原文、凭据或完整回复带回主进程。
 *
 * 返回给调用方的只有：固定错误码、标题文本（仍要再校验）、stopReason 与
 * 纯数字的 usage。
 */
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import { resolveAuthSdk } from './provider-auth-sdk.js';
import { systemWorkerProxy, systemWorkerProxyPrelude } from './system-network-agent.js';
import { scrubInternalEnv } from './child-env.js';

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
let sdk, runtime, initialization;
const operations = new Map();
function createRuntime() {
  const models = new Map();
  return sdk.ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
    ...(workerData.authPath ? { authPath: workerData.authPath } : {}),
    ...(workerData.modelsPath ? {
      modelsPath: workerData.modelsPath,
      modelsStore: {
        async read(id) { return models.get(id); },
        async write(id, item) { models.set(id, item); },
        async delete(id) { models.delete(id); },
      },
    } : {}),
  });
}
async function initialize() {
  sdk = await import(workerData.entry);
  const M = sdk.ModelRuntime;
  if (!M || typeof M.create !== 'function' || typeof M.prototype.getModel !== 'function'
    || typeof M.prototype.completeSimple !== 'function') throw Error('unsupported');
  runtime = await createRuntime();
}
function ready() { return initialization || (initialization = initialize()); }
function reply(value) { parentPort.postMessage(value); }
parentPort.on('message', async (m) => {
  if (m.type === 'abort') { operations.get(m.id)?.abort(); return; }
  const controller = new AbortController();
  operations.set(m.id, controller);
  const signal = controller.signal;
  try {
    await ready();
    if (signal.aborted) return reply({ id: m.id, type: 'result', ok: false, code: 'cancelled' });
    if (m.type !== 'generate') return reply({ id: m.id, type: 'result', ok: false, code: 'unsupported' });
    const model = runtime.getModel(m.providerId, m.modelId);
    if (!model) return reply({ id: m.id, type: 'result', ok: false, code: 'model_unavailable' });
    const message = await runtime.completeSimple(model, {
      systemPrompt: m.system,
      messages: [{ role: 'user', content: m.user, timestamp: Date.now() }],
    }, {
      maxTokens: 64,
      temperature: 0.2,
      reasoning: 'minimal',
      cacheRetention: 'none',
      disableContinuation: true,
      sessionId: m.sessionId,
      timeoutMs: m.timeoutMs,
      maxRetries: 0,
      signal,
    });
    if (signal.aborted) return reply({ id: m.id, type: 'result', ok: false, code: 'cancelled' });
    if (!message || message.stopReason === 'error') return reply({ id: m.id, type: 'result', ok: false, code: 'native-failed' });
    if (message.stopReason === 'aborted') return reply({ id: m.id, type: 'result', ok: false, code: 'cancelled' });
    const content = Array.isArray(message.content) ? message.content : [];
    /* 标题最多 80 字符；在 worker 里先截到 512，避免异常模型把整段回复
     * 跨过消息边界。最终长度与格式由主进程再校验一次。 */
    const text = content.filter(c => c && c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('').slice(0, 512);
    const usage = message.usage && typeof message.usage === 'object' ? message.usage : {};
    const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
    reply({ id: m.id, type: 'result', ok: true, text,
      stopReason: typeof message.stopReason === 'string' ? message.stopReason : null,
      usage: { input: num(usage.input), output: num(usage.output), totalTokens: num(usage.totalTokens) } });
  } catch {
    reply({ id: m.id, type: 'result', ok: false,
      code: signal.aborted ? 'cancelled' : !runtime ? 'unsupported' : 'native-failed' });
  } finally {
    operations.delete(m.id);
  }
});
`;

export function createSessionTitleSdk({
  resolvePackageDir,
  identityKey = () => '',
  authPath = null,
  modelsPath = null,
  env = process.env,
  workerFactory = null,
  timeoutMs = 20_000,
} = {}) {
  let worker = null;
  let workerKey = null;
  let sequence = 0;
  let capability = { supported: null, reason: null, piVersion: null };
  const pending = new Map();

  const publicCapability = () => ({ ...capability });

  /* auth.json / models.json 会在用户登录、切换供应商、添加自定义模型时被改写。
   * worker 只在创建时读一次这两份文件，因此身份键必须带上它们的指纹：
   * 配置变了就重建 worker，而不是一直持有过期的认证或模型表。 */
  function fileFingerprint(file) {
    if (!file) return '-';
    try {
      const stat = fs.statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return 'missing';
    }
  }

  function workerIdentity() {
    const base = typeof identityKey === 'function' ? identityKey() : '';
    return `${base}\u0000${fileFingerprint(authPath)}\u0000${fileFingerprint(modelsPath)}`;
  }

  function finishAll(code) {
    for (const task of pending.values()) task.finish({ ok: false, code });
    pending.clear();
  }

  function dispose() {
    const old = worker;
    worker = null;
    workerKey = null;
    finishAll('cancelled');
    if (old) void old.terminate().catch(() => {});
  }

  function ensure() {
    const key = workerIdentity();
    if (worker && workerKey === key) return true;
    dispose();
    const resolved = resolveAuthSdk(typeof resolvePackageDir === 'function' ? resolvePackageDir() : resolvePackageDir);
    capability = {
      supported: false,
      reason: resolved ? 'Pi SDK 未提供独立模型调用能力' : '当前 Pi 版本不支持独立模型调用',
      piVersion: resolved?.version || null,
    };
    if (!resolved) return false;
    capability = { supported: null, reason: null, piVersion: resolved.version };
    const entry = { ...resolved, ...(authPath ? { authPath } : {}), ...(modelsPath ? { modelsPath } : {}) };
    const childEnv = scrubInternalEnv(env);
    const systemProxy = systemWorkerProxy(env);
    const data = systemProxy ? { ...entry, systemProxy } : entry;
    const source = systemWorkerProxyPrelude(systemProxy) + WORKER_SOURCE;
    worker = workerFactory
      ? workerFactory(source, data, childEnv)
      : new Worker(source, { eval: true, workerData: data, env: childEnv, stdout: true, stderr: true });
    workerKey = key;
    worker.stdout?.resume();
    worker.stderr?.resume();
    const instance = worker;
    worker.on('message', (msg) => {
      if (worker !== instance) return;
      const task = pending.get(msg?.id);
      if (!task || msg.type !== 'result') return;
      /* 只把需要的东西投影回主进程：文本仍有上限，错误码只认固定枚举，
       * 不转发任何 SDK 错误原文或额外字段。 */
      if (msg.ok === true) {
        capability = { ...capability, supported: true, reason: null };
        const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
        const usage = msg.usage && typeof msg.usage === 'object' ? msg.usage : null;
        task.finish({
          ok: true,
          text: typeof msg.text === 'string' ? msg.text.slice(0, 512) : '',
          stopReason: typeof msg.stopReason === 'string' ? msg.stopReason : null,
          usage: usage ? { input: num(usage.input), output: num(usage.output), totalTokens: num(usage.totalTokens) } : null,
        });
        return;
      }
      const code = ['unsupported', 'model_unavailable', 'cancelled', 'native-failed'].includes(msg.code)
        ? msg.code : 'native-failed';
      if (code === 'unsupported') capability = { ...capability, supported: false, reason: '当前 Pi 版本不支持独立模型调用' };
      task.finish({ ok: false, code });
    });
    worker.on('error', () => { if (worker === instance) dispose(); });
    worker.on('exit', () => { if (worker === instance) dispose(); });
    return true;
  }

  function generate({ providerId, modelId, system, user, signal, timeout = timeoutMs } = {}) {
    if (typeof providerId !== 'string' || !providerId || typeof modelId !== 'string' || !modelId
      || typeof system !== 'string' || !system || typeof user !== 'string' || !user) {
      return Promise.resolve({ ok: false, code: 'invalid_request' });
    }
    const limit = Number.isFinite(timeout) ? Math.max(5000, Math.min(60_000, timeout)) : timeoutMs;
    if (!ensure()) return Promise.resolve({ ok: false, code: 'unsupported' });
    const id = 'title-sdk-' + (++sequence);
    return new Promise((resolve) => {
      let timer = null;
      let settled = false;
      const task = {
        finish(result) {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          pending.delete(id);
          resolve(result);
        },
      };
      const onAbort = () => {
        worker?.postMessage({ type: 'abort', id });
        task.finish({ ok: false, code: 'cancelled' });
      };
      pending.set(id, task);
      if (signal?.aborted) {
        task.finish({ ok: false, code: 'cancelled' });
        return;
      }
      /* 父进程的硬超时比 SDK 自己的 timeoutMs 多 5 秒；到点先 abort，
       * 再给 worker 2 秒收尾，仍然不回就重建 worker。 */
      timer = setTimeout(() => {
        worker?.postMessage({ type: 'abort', id });
        task.finish({ ok: false, code: 'timeout' });
        const instance = worker;
        const killer = setTimeout(() => { if (worker === instance) dispose(); }, 2000);
        killer.unref?.();
      }, limit + 5000);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        worker.postMessage({
          id, type: 'generate', providerId, modelId, system, user,
          timeoutMs: limit,
          /* 每次调用一个独立的缓存/路由标识：避免供应商把它当成主会话的
           * 续写，也不与真实会话共享服务端状态。 */
          sessionId: 'pi-gui-title-' + id,
        });
      } catch {
        task.finish({ ok: false, code: 'unavailable' });
      }
    });
  }

  /** 关闭开关 / 退出时取消全部在途调用。 */
  function abortAll() {
    for (const id of pending.keys()) worker?.postMessage({ type: 'abort', id });
    finishAll('cancelled');
    const instance = worker;
    if (!instance) return;
    const timer = setTimeout(() => { if (worker === instance) dispose(); }, 2000);
    timer.unref?.();
  }

  return { generate, abortAll, dispose, capability: publicCapability, _internals: { WORKER_SOURCE } };
}
