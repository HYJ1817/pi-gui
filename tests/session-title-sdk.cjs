'use strict';
/* 独立标题模型调用（server/session-title-sdk.js）的离线测试。
 *
 * 不启动真 Worker、不加载真 Pi、不联网：Pi 包目录用临时 fixture 造，
 * Worker 用假对象代替，只验证主进程侧的边界 —— 能力判定、消息投影、
 * 取消、重建、环境清理与输入校验。
 */
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  let ok = cond;
  try { ok = typeof cond === 'function' ? cond() : cond; }
  catch (err) { ok = 'threw: ' + err.message; }
  if (ok === true) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (typeof ok === 'string' ? '  → ' + ok : extra ? '  → ' + extra : '')); }
}
const section = (title) => console.log('\n--- ' + title + ' ---');
const tick = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  const { createSessionTitleSdk } = await import('../server/session-title-sdk.js');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-title-sdk-'));
  const emptyDir = path.join(root, 'empty');
  fs.mkdirSync(emptyDir, { recursive: true });

  function makePackage(name, version = '1.5.2') {
    const dir = path.join(root, 'pkg-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export const ModelRuntime = {};\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name, version, type: 'module', exports: { '.': './lib/index.js' },
    }), 'utf8');
    return dir;
  }
  const goodDir = makePackage('@earendil-works/pi-coding-agent');
  const wrongDir = makePackage('some-other-package');

  function makeWorker() {
    const worker = new EventEmitter();
    worker.posted = [];
    worker.terminated = false;
    worker.stdout = { resume() {} };
    worker.stderr = { resume() {} };
    worker.postMessage = (msg) => { worker.posted.push(msg); };
    worker.terminate = async () => { worker.terminated = true; };
    return worker;
  }

  function makeSdk({ dir = goodDir, packageDir = dir, env = { HOME: 'home', PI_GUI_TOKEN: 'secret-token' }, identityKey = () => 'k1', authPath = 'C:\\auth.json', modelsPath = 'C:\\models.json' } = {}) {
    const workers = [];
    const sdk = createSessionTitleSdk({
      resolvePackageDir: () => packageDir,
      identityKey,
      env,
      authPath,
      modelsPath,
      workerFactory: (source, entry, childEnv) => {
        const worker = makeWorker();
        worker.source = source;
        worker.entry = entry;
        worker.childEnv = childEnv;
        workers.push(worker);
        return worker;
      },
    });
    return { sdk, workers };
  }

  const generateArgs = { providerId: 'anthropic', modelId: 'claude-sonnet-5-5', system: 'system', user: 'user' };

  try {
    /* ================= 1. 能力判定 ================= */
    section('1. 能力判定');
    {
      const { sdk, workers } = makeSdk({ packageDir: emptyDir });
      const result = await sdk.generate(generateArgs);
      check('1a. 找不到 Pi 包 → unsupported，不建 Worker', () =>
        result.ok === false && result.code === 'unsupported' && workers.length === 0);
      check('1b. 能力是明确的三值之「否」，带原因', () => {
        const c = sdk.capability();
        return c.supported === false && typeof c.reason === 'string' && c.reason.length > 0;
      });
      sdk.dispose();
    }
    {
      const { sdk, workers } = makeSdk({ packageDir: wrongDir });
      const result = await sdk.generate(generateArgs);
      check('1c. 包名不是 Pi → unsupported', () => result.code === 'unsupported' && workers.length === 0);
      sdk.dispose();
    }
    {
      const { sdk, workers } = makeSdk();
      const pending = sdk.generate(generateArgs);
      check('1d. 有合法包时创建 Worker 并带 Pi 版本', () =>
        workers.length === 1 && workers[0].entry.version === '1.5.2');
      check('1e. 首次调用前能力是「未知」，不是假装支持', () => sdk.capability().supported === null);
      workers[0].emit('message', { id: workers[0].posted[0].id, type: 'result', ok: true, text: '标题', usage: {} });
      const result = await pending;
      check('1f. 成功一次后能力变为「是」', () => result.ok === true && sdk.capability().supported === true);
      sdk.dispose();
    }

    /* ================= 2. 消息投影 ================= */
    section('2. Worker 结果只投影固定字段');
    {
      const { sdk, workers } = makeSdk();
      const pending = sdk.generate(generateArgs);
      const worker = workers[0];
      const sent = worker.posted[0];
      check('2a. 发出的请求只带必要参数', () =>
        sent.type === 'generate' && sent.providerId === 'anthropic' && sent.modelId === 'claude-sonnet-5-5'
        && sent.system === 'system' && sent.user === 'user'
        && typeof sent.sessionId === 'string' && sent.sessionId.startsWith('pi-gui-title-')
        && sent.timeoutMs === 20_000);
      check('2b. Worker 源码是纯文本生成：有界输出、低推理、无工具', () => {
        const src = worker.source;
        return src.includes('completeSimple') && src.includes('maxTokens: 64') && src.includes("reasoning: 'minimal'")
          && src.includes("cacheRetention: 'none'") && src.includes('disableContinuation: true')
          && src.includes('maxRetries: 0') && !src.includes('toolCall');
      });
      worker.emit('message', {
        id: sent.id, type: 'result', ok: true,
        text: '标'.repeat(600), stopReason: 'stop',
        usage: { input: 12, output: 8, totalTokens: 20, cost: { total: 99 } },
        secret: 'should-not-escape', extra: { apiKey: 'sk-leak' },
      });
      const result = await pending;
      check('2c. 文本最多 512 字符', () => result.ok === true && result.text.length === 512);
      check('2d. usage 只保留三个数字字段', () =>
        result.usage.input === 12 && result.usage.output === 8 && result.usage.totalTokens === 20
        && !('cost' in result.usage));
      check('2e. 额外字段与嵌套秘密不进入主进程结果', () =>
        !('secret' in result) && !('extra' in result) && !JSON.stringify(result).includes('sk-leak'));
      sdk.dispose();
    }
    {
      const { sdk, workers } = makeSdk();
      const pending = sdk.generate(generateArgs);
      workers[0].emit('message', { id: workers[0].posted[0].id, type: 'result', ok: true, text: '标题', usage: { input: '12', output: null, totalTokens: Infinity } });
      const result = await pending;
      check('2f. 非数字 usage 被丢弃为 null', () =>
        result.usage.input === null && result.usage.output === null && result.usage.totalTokens === null);
      sdk.dispose();
    }
    {
      const { sdk, workers } = makeSdk();
      const pending = sdk.generate(generateArgs);
      workers[0].emit('message', { id: workers[0].posted[0].id, type: 'result', ok: false, code: 'API_KEY sk-live-123 无效' });
      const result = await pending;
      check('2g. 未知错误码统一成 native-failed，不转发原文', () =>
        result.ok === false && result.code === 'native-failed' && !JSON.stringify(result).includes('sk-live'));
      sdk.dispose();
    }
    {
      const { sdk, workers } = makeSdk();
      const pending = sdk.generate(generateArgs);
      workers[0].emit('message', { id: workers[0].posted[0].id, type: 'result', ok: false, code: 'model_unavailable' });
      const result = await pending;
      check('2h. model_unavailable 原样保留（调用方可区分）', () => result.code === 'model_unavailable');
      sdk.dispose();
    }
    {
      const { sdk, workers } = makeSdk();
      const pending = sdk.generate(generateArgs);
      workers[0].emit('message', { id: workers[0].posted[0].id, type: 'result', ok: false, code: 'unsupported' });
      await pending;
      check('2i. Worker 报 unsupported 时能力翻成否', () =>
        sdk.capability().supported === false && sdk.capability().reason.includes('不支持'));
      sdk.dispose();
    }
    {
      const { sdk, workers } = makeSdk();
      const pending = sdk.generate(generateArgs);
      workers[0].emit('message', { id: workers[0].posted[0].id, type: 'event', data: { type: 'auth_url', url: 'https://secret' } });
      workers[0].emit('message', { id: workers[0].posted[0].id, type: 'result', ok: true, text: '标题' });
      const result = await pending;
      check('2j. 非 result 消息不会提前结算', () => result.ok === true && result.text === '标题');
      sdk.dispose();
    }

    /* ================= 3. 取消 ================= */
    section('3. 取消与关闭');
    {
      const { sdk, workers } = makeSdk();
      const controller = new AbortController();
      const pending = sdk.generate({ ...generateArgs, signal: controller.signal });
      const id = workers[0].posted[0].id;
      controller.abort();
      const result = await pending;
      check('3a. AbortSignal 取消 → cancelled', () => result.ok === false && result.code === 'cancelled');
      check('3b. 取消会通知 Worker', () =>
        workers[0].posted.some((m) => m.type === 'abort' && m.id === id));
      workers[0].emit('message', { id, type: 'result', ok: true, text: '迟到的标题' });
      await tick();
      check('3c. 取消后迟到的 Worker 结果被忽略', () => sdk.capability().supported === null);
      sdk.dispose();
    }
    {
      const { sdk, workers } = makeSdk();
      const a = sdk.generate(generateArgs);
      const b = sdk.generate({ ...generateArgs, modelId: 'other' });
      const ids = workers[0].posted.filter((m) => m.type === 'generate').map((m) => m.id);
      sdk.abortAll();
      const [ra, rb] = await Promise.all([a, b]);
      check('3d. abortAll 取消全部在途调用', () =>
        ra.code === 'cancelled' && rb.code === 'cancelled');
      check('3e. abortAll 给每个任务都发了 abort', () =>
        ids.length === 2 && ids.every((id) => workers[0].posted.some((m) => m.type === 'abort' && m.id === id)));
      sdk.dispose();
    }
    {
      const { sdk, workers } = makeSdk();
      const pending = sdk.generate(generateArgs);
      sdk.dispose();
      const result = await pending;
      check('3f. dispose 终止 Worker 并取消在途任务', () =>
        result.code === 'cancelled' && workers[0].terminated === true);
    }
    {
      let key = 'one';
      const sdk2 = makeSdk({ identityKey: () => key });
      const p1 = sdk2.sdk.generate(generateArgs);
      sdk2.workers[0].emit('message', { id: sdk2.workers[0].posted[0].id, type: 'result', ok: true, text: '标题' });
      await p1;
      key = 'two';
      const p2 = sdk2.sdk.generate(generateArgs);
      check('3g. 身份变化时重建 Worker', () => sdk2.workers.length === 2 && sdk2.workers[0].terminated === true);
      sdk2.workers[1].emit('message', { id: sdk2.workers[1].posted[0].id, type: 'result', ok: true, text: '标题2' });
      await p2;
      sdk2.sdk.dispose();
    }

    /* ================= 4. 环境与输入边界 ================= */
    section('4. 环境与输入边界');
    {
      const { sdk, workers } = makeSdk();
      void sdk.generate(generateArgs);
      check('4a. Worker 环境里删掉 Renderer 令牌', () =>
        workers[0].childEnv.PI_GUI_TOKEN === undefined && workers[0].childEnv.HOME === 'home');
      check('4b. authPath / modelsPath 只交给 Worker', () =>
        workers[0].entry.authPath === 'C:\\auth.json' && workers[0].entry.modelsPath === 'C:\\models.json');
      sdk.dispose();
    }
    {
      const { sdk, workers } = makeSdk();
      const bad = await sdk.generate({ providerId: '', modelId: 'm', system: 's', user: 'u' });
      const bad2 = await sdk.generate({ providerId: 'p', modelId: '', system: 's', user: 'u' });
      const bad3 = await sdk.generate({ providerId: 'p', modelId: 'm', system: '', user: 'u' });
      check('4c. 缺 provider / model / 提示词 → invalid_request，不建 Worker', () =>
        bad.code === 'invalid_request' && bad2.code === 'invalid_request'
        && bad3.code === 'invalid_request' && workers.length === 0);
      sdk.dispose();
    }
    {
      const { sdk, workers } = makeSdk();
      const controller = new AbortController();
      controller.abort();
      const result = await sdk.generate({ ...generateArgs, signal: controller.signal });
      check('4d. 已中止的 signal 不会把请求发给 Worker', () => {
        const sent = workers.flatMap((w) => w.posted).filter((m) => m.type === 'generate');
        return result.code === 'cancelled' && sent.length === 0;
      });
      sdk.dispose();
    }
    {
      const workers = [];
      const sdk = createSessionTitleSdk({
        resolvePackageDir: () => goodDir,
        identityKey: () => 'k',
        workerFactory: (source) => {
          workers.push(source);
          const worker = makeWorker();
          worker.postMessage = () => { throw new Error('worker gone'); };
          worker.source = source;
          return worker;
        },
      });
      const result = await sdk.generate(generateArgs);
      check('4e. Worker 通道关闭 → unavailable', () => result.ok === false && result.code === 'unavailable');
      sdk.dispose();
    }

    /* ================= 5. 真实 Worker 源码 ================= */
    section('5. 真实 Worker 源码可执行');
    {
      /* 之前的假 Worker 只能证明主进程投影；这里让**真实 Worker**
       * 加载一个离线 Pi 包桩，执行 WORKER_SOURCE 里的 completeSimple 路径。
       * 桩不联网、不读凭据，只回固定文本。 */
      const realDir = makePackage('@earendil-works/pi-coding-agent');
      fs.writeFileSync(path.join(realDir, 'lib', 'index.js'), `
export class ModelRuntime {
  static async create() { return new ModelRuntime(); }
  getModel(providerId, modelId) {
    return providerId === 'anthropic' && modelId === 'claude-sonnet-5-5' ? { providerId, modelId } : null;
  }
  async completeSimple() {
    return { content: [{ type: 'text', text: '真实 Worker 标题' }], stopReason: 'end',
      usage: { input: 3, output: 4, totalTokens: 7 } };
  }
}
`, 'utf8');
      const sdk = createSessionTitleSdk({
        resolvePackageDir: () => realDir,
        authPath: null,
        modelsPath: null,
        env: { PATH: process.env.PATH },
      });
      try {
        const ok = await sdk.generate(generateArgs);
        check('5a. 真实 Worker 执行 completeSimple 并回传标题', () =>
          ok.ok === true && ok.text === '真实 Worker 标题' && ok.stopReason === 'end');
        check('5b. 真实 Worker 的 usage 只保留三个数字', () =>
          ok.usage?.input === 3 && ok.usage?.output === 4 && ok.usage?.totalTokens === 7);
        const missing = await sdk.generate({ ...generateArgs, modelId: 'not-installed' });
        check('5c. 真实 Worker 对未知模型返回固定 model_unavailable', () =>
          missing.ok === false && missing.code === 'model_unavailable');
      } finally {
        sdk.dispose();
      }
    }

    /* ================= 6. 源码不泄露 ================= */
    section('6. Worker 源码边界');
    {
      const { sdk, workers } = makeSdk();
      void sdk.generate(generateArgs);
      const src = workers[0].source;
      check('6a. Worker 源码里没有会话写入 / 工具调用路径', () =>
        !src.includes('writeFile') && !src.includes('appendFile') && !src.includes('sessionFile')
        && !src.includes('tool'));
      check('6b. 异常只返回固定错误码，不带 error.message', () => {
        const catchBlock = src.slice(src.lastIndexOf('} catch {'));
        return catchBlock.includes("code: signal.aborted ? 'cancelled'")
          && !catchBlock.includes('error.message') && !catchBlock.includes('.stack');
      });
      check('6c. 系统提示与实际回复由调用方传入，不在 Worker 里拼历史', () =>
        src.includes('systemPrompt: m.system') && src.includes('content: m.user')
        && !src.includes('messages: m.'));
      sdk.dispose();
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
})().catch((err) => {
  console.error('session-title-sdk 测试失败：', err);
  process.exit(1);
});
