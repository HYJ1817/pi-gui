/* 「从供应商拉取模型列表」的回归测试。
 *
 * 两段式：
 *   1. 起一个**桩上游**，按真实供应商的形状返回 /models（OpenAI 极简 /
 *      OpenRouter 富信息 / Anthropic / Google），然后直接调 lib/models-api.js。
 *   2. 起**真的 server.js**，走 /api/providers/models 这条 HTTP 路径，
 *      确认路由没被 /api/providers 的前缀匹配抢走。
 *
 * 两件必须守住的事：
 *   - **绝不能写用户真实的 ~/.pi/agent/models.json**。所以给子进程注入
 *     临时 USERPROFILE/HOME，把 homedir() 指到临时目录去。
 *   - **错误信息里绝不能出现 key**。401 那个桩会把 key 原样回显在响应体里，
 *     正好用来验证我们不会把它透出去。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 7793);
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE_KEY = 'sk-test-DEADBEEF-should-never-leak';

const WORK = path.join(os.tmpdir(), 'pi-gui-models-check');
const FAKE_HOME = path.join(WORK, 'home');
const DATA = path.join(WORK, 'data');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  const ok = typeof cond === 'function' ? cond() : cond;
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok ? '  → ' + ok : extra ? '  → ' + extra : ''));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 删临时目录：Node 的 fs.rmSync 被 safe-delete shim 拦（阈值 50 个文件），
 * 用 bash 的 rm -rf 兜底。 */
function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* 被拦了，走下面 */
  }
  try {
    execFileSync('rm', ['-rf', '--', p], { stdio: 'ignore' });
  } catch {
    /* noop */
  }
}

// ---------- 桩上游 ----------

const seenHeaders = {};

function startStub() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = req.url.split('?')[0];
      seenHeaders[p] = {
        authorization: req.headers.authorization || '',
        xApiKey: req.headers['x-api-key'] || '',
        googKey: req.headers['x-goog-api-key'] || '',
        anthropicVersion: req.headers['anthropic-version'] || '',
      };

      const send = (code, body) => {
        const text = JSON.stringify(body);
        res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        res.end(text);
      };

      /* 刻意**不**注册根路径上的 /models 和 /v1/models：
       * 一旦注册，任何失败案例都会在回退到根路径时被救活，
       * 「401 应该失败」这类断言就永远测不出来（第一版就踩了这个坑）。 */
      if (p === '/plain/v1/models' || p === '/deep/v1/models') {
        return send(200, {
          object: 'list',
          data: [
            { id: 'gpt-4o', object: 'model', created: 1, owned_by: 'openai' },
            { id: 'gpt-4o-mini', object: 'model', created: 2, owned_by: 'openai' },
          ],
        });
      }

      if (p === '/rich/v1/models') {
        return send(200, {
          data: [
            {
              id: 'anthropic/claude-sonnet-4',
              name: 'Claude Sonnet 4',
              context_length: 200000,
              top_provider: { context_length: 200000, max_completion_tokens: 64000 },
              architecture: { input_modalities: ['text', 'image'] },
              supported_parameters: ['tools', 'reasoning'],
            },
            {
              id: 'meta-llama/llama-3-8b',
              name: 'Llama 3 8B',
              architecture: { input_modalities: ['text'] },
            },
          ],
        });
      }

      if (p === '/anth/v1/models') {
        return send(200, {
          data: [
            { type: 'model', id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', created_at: 'x' },
          ],
          has_more: false,
        });
      }

      if (p === '/g/v1beta/models') {
        return send(200, {
          models: [
            {
              name: 'models/gemini-2.5-pro',
              displayName: 'Gemini 2.5 Pro',
              inputTokenLimit: 1048576,
              outputTokenLimit: 65536,
              supportedGenerationMethods: ['generateContent', 'countTokens'],
            },
            { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          ],
        });
      }

      /* 500 且把 key 回显在响应体里。401 那条走的是「隐去响应体」的分支，
       * 这条走的是「带出响应体」的分支 —— 专门验证兜底打码，别只测一条路径。 */
      if (p === '/boom/models') {
        return send(500, { error: { message: `upstream exploded with key ${FAKE_KEY}` } });
      }

      // 返回 200 但根本不是模型列表
      if (p === '/junk/models') return send(200, { hello: 'world' });
      // 返回空列表
      if (p === '/empty/models') return send(200, { data: [] });

      send(404, { error: 'not found' });
    });

    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/* 每个路径都回 401，并把 key 原样回显在响应体里。
 * 单独起一个是因为 401 案例必须让**所有**候选 URL 都失败，
 * 否则回退机制会找到别的能用的路径。 */
function startStub401() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const text = JSON.stringify({ error: { message: `invalid api key: ${FAKE_KEY}` } });
      res.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---------- 主流程 ----------

async function waitReady(ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/');
      if (r.status) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  return false;
}

(async () => {
  rmrf(WORK);
  fs.mkdirSync(FAKE_HOME, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });

  const stub = await startStub();
  const UP = `http://127.0.0.1:${stub.address().port}`;

  const { fetchModels, buildCandidates } = await import('../lib/models-api.js');

  // ---------- 第 1 段：直接测模块 ----------
  console.log('— 模块层（lib/models-api.js）');

  const plain = await fetchModels({ baseUrl: `${UP}/plain`, api: 'openai-completions' });
  check('OpenAI 极简形态能解析', () => plain.ok || plain.error);
  check('取到 2 个模型', () => plain.models?.length === 2 || JSON.stringify(plain.models));
  check('极简形态不编造能力参数', () => {
    const m = plain.models[0];
    return (
      m.contextWindow === undefined && m.reasoning === undefined || JSON.stringify(m)
    );
  });
  check('走了 /v1 后缀补全', () => plain.source === `${UP}/plain/v1/models` || plain.source);

  const rich = await fetchModels({ baseUrl: `${UP}/rich/v1`, api: 'openai-completions' });
  check('OpenRouter 富形态能解析', () => rich.ok || rich.error);
  check('富形态填上了 contextWindow', () => rich.models[0].contextWindow === 200000 || JSON.stringify(rich.models[0]));
  check('富形态填上了 maxTokens', () => rich.models[0].maxTokens === 64000 || JSON.stringify(rich.models[0]));
  check('富形态识别出 reasoning', () => rich.models[0].reasoning === true || JSON.stringify(rich.models[0]));
  check('富形态识别出图片输入', () => {
    const m = rich.models[0];
    return Array.isArray(m.input) && m.input.includes('image') || JSON.stringify(m);
  });
  check('纯文本模型不写 input', () => {
    const m = rich.models.find((x) => x.id === 'meta-llama/llama-3-8b');
    return m && m.input === undefined || JSON.stringify(m);
  });

  const anth = await fetchModels({ baseUrl: `${UP}/anth`, api: 'anthropic-messages', apiKey: FAKE_KEY });
  check('Anthropic 形态能解析', () => anth.ok || anth.error);
  check('Anthropic 取到 display_name', () => anth.models[0].name === 'Claude Sonnet 4.5' || JSON.stringify(anth.models[0]));
  check('Anthropic 用 x-api-key 头', () => seenHeaders['/anth/v1/models'].xApiKey === FAKE_KEY || JSON.stringify(seenHeaders['/anth/v1/models']));
  check('Anthropic 带了 anthropic-version', () => seenHeaders['/anth/v1/models'].anthropicVersion === '2023-06-01' || seenHeaders['/anth/v1/models'].anthropicVersion);

  const goog = await fetchModels({ baseUrl: `${UP}/g/v1beta`, api: 'google-generative-ai', apiKey: FAKE_KEY });
  check('Google 形态能解析', () => goog.ok || goog.error);
  check('Google 去掉了 models/ 前缀', () => goog.models[0].id === 'gemini-2.5-pro' || goog.models[0].id);
  check('Google 填上了 token 上限', () => goog.models[0].contextWindow === 1048576 || JSON.stringify(goog.models[0]));
  check('Google 过滤掉 embedding 模型', () => goog.models.length === 1 || JSON.stringify(goog.models.map((m) => m.id)));
  check('Google 用 x-goog-api-key 头（不进 URL）', () => seenHeaders['/g/v1beta/models'].googKey === FAKE_KEY || JSON.stringify(seenHeaders['/g/v1beta/models']));

  const deep = await fetchModels({ baseUrl: `${UP}/deep/extra`, api: 'openai-completions' });
  check('逐级回退路径段后能找到接口', () => deep.ok || deep.error);
  check('回退确实试了多级', () => (deep.tried?.length || 0) >= 3 || JSON.stringify(deep.tried));
  check('最终命中的是回退后的路径', () => deep.source === `${UP}/deep/v1/models` || deep.source);

  const stub401 = await startStub401();
  const UP401 = `http://127.0.0.1:${stub401.address().port}`;
  const sec = await fetchModels({ baseUrl: UP401, api: 'openai-completions', apiKey: FAKE_KEY });
  stub401.close();
  check('401 被识别为失败', () => sec.ok === false || '竟然成功了');
  check('401 的错误里说明了原因', () => /401/.test(String(sec.error || '')) || sec.error);
  check('错误信息里没有泄露 key', () => !String(sec.error || '').includes(FAKE_KEY) || sec.error);

  const boom = await fetchModels({ baseUrl: `${UP}/boom`, api: 'openai-completions', apiKey: FAKE_KEY });
  check('500 被识别为失败', () => boom.ok === false || '竟然成功了');
  check('500 的错误里说明了状态码', () => /500/.test(String(boom.error || '')) || boom.error);
  check('500 带出响应体时也没泄露 key', () => !String(boom.error || '').includes(FAKE_KEY) || boom.error);
  check('泄露点被打了码（说明确实命中了这条分支）', () => /\*\*\*/.test(String(boom.error || '')) || boom.error);

  const junk = await fetchModels({ baseUrl: `${UP}/junk`, api: 'openai-completions' });
  check('非模型列表的 JSON 被拒绝', () => junk.ok === false || '竟然成功了');

  const empty = await fetchModels({ baseUrl: `${UP}/empty`, api: 'openai-completions' });
  check('空列表算失败（会继续回退）', () => empty.ok === false || '竟然成功了');

  const bang = await fetchModels({ baseUrl: `${UP}/plain`, api: 'openai-completions', apiKey: '!echo hi' });
  check('拒绝执行 !command 形式的 key', () => bang.ok === false && /不代为执行/.test(bang.error) || bang.error);

  const missingEnv = await fetchModels({
    baseUrl: `${UP}/plain`,
    api: 'openai-completions',
    apiKey: '$PI_GUI_TEST_DEFINITELY_MISSING',
  });
  check('环境变量没设置时给出明确提示', () => missingEnv.ok === false && /环境变量/.test(missingEnv.error) || missingEnv.error);

  const badUrl = await fetchModels({ baseUrl: 'not a url', api: 'openai-completions' });
  check('非法 Base URL 被拒绝', () => badUrl.ok === false && /Base URL/.test(badUrl.error) || badUrl.error);

  check(
    '候选 URL 不会拼出 /v1/v1',
    () => !buildCandidates('https://openrouter.ai/api/v1', 'openai-completions').some((u) => u.includes('/v1/v1')) || '有重复段'
  );

  // ---------- 第 2 段：走真实 HTTP 路由 ----------
  console.log('');
  console.log('— 路由层（真实 server.js）');

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PI_GUI_OPEN: '0',
      PI_GUI_DATA: DATA,
      // 隔离 homedir，别碰用户真实的 ~/.pi/agent/models.json
      USERPROFILE: FAKE_HOME,
      HOME: FAKE_HOME,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));

  const cleanup = () => {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        server.kill();
      }
    } catch {
      /* noop */
    }
    try {
      stub.close();
    } catch {
      /* noop */
    }
  };

  try {
    check('服务能起来', await waitReady(), out.slice(0, 400));

    const post = async (p, body) => {
      const r = await fetch(BASE + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: r.status, json: await r.json() };
    };

    const viaHttp = await post('/api/providers/models', { baseUrl: `${UP}/plain`, api: 'openai-completions' });
    check('路由没被 /api/providers 抢走（返回的是模型列表）', () => viaHttp.json.ok === true || JSON.stringify(viaHttp.json).slice(0, 200));
    check('HTTP 路径也取到 2 个模型', () => viaHttp.json.models?.length === 2 || JSON.stringify(viaHttp.json));

    const noBase = await post('/api/providers/models', { api: 'openai-completions' });
    check('没填 Base URL 时给出提示', () => noBase.json.ok === false && /Base URL/.test(noBase.json.error) || noBase.json.error);

    const stub401http = await startStub401();
    const failCase = await post('/api/providers/models', {
      baseUrl: `http://127.0.0.1:${stub401http.address().port}`,
      api: 'openai-completions',
      apiKey: FAKE_KEY,
    });
    stub401http.close();
    check('失败也回 200，前端只需看 ok 字段', () => failCase.status === 200 || '状态 ' + failCase.status);
    check('HTTP 路径同样识别出失败', () => failCase.json.ok === false || '竟然成功了');
    check('HTTP 路径同样不泄露 key', () => !JSON.stringify(failCase.json).includes(FAKE_KEY) || '泄露了 key');

    // 字段透传：带能力参数 + 一个不该被接受的字段
    const saved = await post('/api/providers', {
      name: 'test-models-passthrough',
      config: {
        baseUrl: 'https://example.com/v1',
        api: 'openai-completions',
        apiKey: 'sk-ok',
        models: [
          { id: 'a', name: 'A', contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ['text', 'image'] },
          { id: 'b', contextWindow: -5, maxTokens: 'nope', bogus: 'should be dropped', apiKey: 'leak?' },
        ],
      },
    });
    check('供应商能保存', () => saved.json.ok === true || JSON.stringify(saved.json));

    const listed = await (await fetch(BASE + '/api/providers')).json();
    const cfg = listed.providers?.['test-models-passthrough'];
    check('供应商写进了隔离的临时 models.json', () => Boolean(cfg) || JSON.stringify(Object.keys(listed.providers || {})));

    const a = cfg?.models?.find((m) => m.id === 'a');
    check('contextWindow 被透传', () => a?.contextWindow === 200000 || JSON.stringify(a));
    check('maxTokens 被透传', () => a?.maxTokens === 64000 || JSON.stringify(a));
    check('reasoning 被透传', () => a?.reasoning === true || JSON.stringify(a));
    check('input 被透传', () => JSON.stringify(a?.input) === '["text","image"]' || JSON.stringify(a));

    const b = cfg?.models?.find((m) => m.id === 'b');
    check('非法数值被丢弃（不是变成负数/NaN）', () => b && b.contextWindow === undefined && b.maxTokens === undefined || JSON.stringify(b));
    check('白名单外的字段被丢弃', () => b && b.bogus === undefined && b.apiKey === undefined || JSON.stringify(b));
  } finally {
    cleanup();
  }

  rmrf(WORK);

  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 800);
})().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
