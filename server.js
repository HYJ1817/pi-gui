#!/usr/bin/env node
/**
 * Pi GUI —— 后端桥接层
 *
 * 职责：
 *   1. 提供 public/ 下的静态文件
 *   2. spawn 一个 `pi --mode rpc` 子进程（只读调用，不修改全局 pi 安装）
 *   3. 解析子进程 stdout 的 JSONL 事件流，经 SSE 推送给浏览器
 *   4. 把浏览器发来的命令写进子进程的 stdin
 *
 * 协议要点（摘自 pi 官方 docs/rpc.md）：
 *   - 严格 JSONL：记录分隔符只有 LF。官方明确警告不能用 Node 的 readline，
 *     因为它还会在 U+2028 / U+2029 处切分，而这两个字符在 JSON 字符串里是合法的。
 *   - 命令：每行一个 JSON 对象写进 stdin
 *   - 事件：每行一个 JSON 对象从 stdout 出来
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { extract, clampInline, maxBytes } from './lib/extract.js';
import { readPublic, isSea } from './lib/assets.js';
import { fetchModels } from './lib/models-api.js';
import { gitDiff, gitRestore, gitStatus, resolveOpenTarget, restoreAllGit } from './lib/git.js';

// 数据目录：projects.json 和上传缓存放这里。
//
// 默认用「代码/exe 所在目录」—— 开发时是项目根；单文件 exe 是便携模式，
// 拷走 exe 数据一起带走。但桌面版（Electron）装在 Program Files 之类的地方
// 时那个目录不可写，所以主进程会用 PI_GUI_DATA 指到用户数据目录去。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PI_GUI_DATA || __dirname;
const PORT = Number(process.env.PORT || 7788);
const PI_BIN = process.env.PI_BIN || 'pi';
const IS_WIN = process.platform === 'win32';

/* 应用身份。
 *
 * Electron 启动时要判断「7788 上跑的到底是不是 Pi GUI」，而不是
 * 「7788 上有没有人监听」—— 后者会把任何一个恰好占了这个端口的程序
 * 当成自己的后端，然后加载出一个别人的页面。判断依据就是这两个字段。 */
const APP_ID = 'pi-gui';
const PROTOCOL = 1;

/* 版本号。
 *
 * 构建脚本用 esbuild `--define:__PI_GUI_VERSION__` 注入 —— 打包后没有
 * package.json 可读（SEA 里根本没有这个文件，Electron 的 resources/app
 * 那份是构建时另写的精简版）。直接 `node server.js` 开发时没有这个常量，
 * 退回读磁盘上的 package.json。
 * 注意 `typeof` 对未声明的标识符是合法的，不会抛 ReferenceError。 */
const VERSION = typeof __PI_GUI_VERSION__ === 'undefined' ? readOwnVersion() : __PI_GUI_VERSION__;

function readOwnVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// pi 的用户级自定义供应商配置。
// 注意：这是「用户配置」，与 pi 自身的 models-store.json（模型目录缓存）不是一回事。
const MODELS_JSON = path.join(os.homedir(), '.pi', 'agent', 'models.json');

// 本应用自己的项目列表
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

// ---------- pi 子进程参数 ----------

// pi 的会话按 cwd 分目录存储，而 RPC 协议本身没有「切换工作目录」的命令，
// 所以「切换项目」= 用新的 cwd 重启子进程。
//
// 没有项目时是 **null**，此时不启动 pi —— 见 resolveInitialCwd 的说明。
let currentCwd = resolveInitialCwd();

/** 启动时该用哪个目录当项目。
 *
 * 优先 PI_CWD（开发与自动化测试用它把工作目录隔离到临时目录）；
 * 否则读 projects.json 里上次激活的项目；都没有就是 null。
 *
 * 早先这里兜底成 process.cwd()，桌面版又把后端进程的 cwd 设成用户主目录，
 * 于是**首次启动直接落在用户主目录**，还会把该目录下的 pi 历史会话整段恢复出来。
 * 用户第一眼看到一堆跟自己无关的对话，完全不知道发生了什么。
 * 宁可空着、让界面明确提示「添加文件夹」，也不要猜一个目录。
 *
 * 返回 null 之后所有下游都要能接受它：startPi 会跳过，前端会切到「未选项目」形态。 */
function resolveInitialCwd() {
  const fromEnv = String(process.env.PI_CWD || '').trim();
  if (fromEnv) return path.resolve(fromEnv);

  try {
    const data = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    const active = String(data?.active || '').trim();
    // 上次的项目可能已经被删掉/移走/拔了盘 —— 那就当作没有，别开在一个不存在的目录上
    if (active && fs.statSync(active).isDirectory()) return path.resolve(active);
  } catch {
    /* 没有 projects.json，或目录已经不在了 */
  }
  return null;
}

function buildPiArgs() {
  const args = ['--mode', 'rpc'];
  // --continue 恢复该 cwd 下最近的会话；实测在没有历史的目录下也不会报错，会正常新建
  if (process.env.PI_NO_CONTINUE !== '1') args.push('--continue');
  if (process.env.PI_PROVIDER) args.push('--provider', process.env.PI_PROVIDER);
  if (process.env.PI_MODEL) args.push('--model', process.env.PI_MODEL);
  if (process.env.PI_THINKING) args.push('--thinking', process.env.PI_THINKING);
  if (process.env.PI_NO_SESSION === '1') args.push('--no-session');
  return args;
}

let pi = null;
let stdoutBuf = '';
let shuttingDown = false;

const clients = new Set();
const backlog = [];
const BACKLOG_MAX = 800;

function frame(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

let seq = 0;

function publish(event) {
  // 附上单调递增序号：SSE 断线重连时服务端会补发 backlog，
  // 客户端据此去重，避免历史事件被重复渲染。
  event._seq = ++seq;
  backlog.push(event);
  if (backlog.length > BACKLOG_MAX) backlog.shift();
  const line = frame(event);
  for (const res of clients) {
    try {
      res.write(line);
    } catch {
      /* 连接已断，close 回调会清理 */
    }
  }
}

// ---------- 拉起 pi ----------

/* 拉起 pi 子进程。
 * Windows 上 pi 是 npm 的 .cmd 包装脚本，必须经 shell 启动；
 * 但 spawn(bin, argsArray, {shell:true}) 会触发 DEP0190
 * （args 只拼接不转义），每次启动刷两行弃用警告，双击启动时看着像报错。
 * 改成按 Node 文档认可的方式自己拼一条命令字符串 —— 实测不再报警告。 */
function spawnPi(bin, args) {
  /* 把访问令牌从 pi 的环境里摘掉。
   *
   * pi 自带 bash 工具，环境变量对它（以及它跑的任何命令）都是可读的。
   * 令牌一旦被读进工具输出，就会随对话内容一起进模型上下文 —— 属于
   * 没必要存在的暴露面。pi 本身也不需要这个变量。 */
  const env = { ...process.env };
  delete env.PI_GUI_TOKEN;

  const opts = {
    cwd: currentCwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };

  if (!IS_WIN) return spawn(bin, args, opts);

  // 参数都是命令行开关和模型名，不含引号；万一有就剔掉，避免把命令拼坏
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  return spawn([bin, ...args].map(q).join(' '), { ...opts, shell: true });
}

function startPi() {
  /* 没有项目就不启动 pi。
   *
   * pi 的 cwd 只能在启动时确定，没有 cwd 就没有合理的启动参数；
   * 更重要的是：随便挑一个目录当 cwd 会凭空造出一批会话文件，
   * 而且会把那个目录的历史会话显示给用户 —— 正是我们要避免的。
   * 这里只发一个状态，前端据此切到「先添加文件夹」的引导形态。 */
  if (!currentCwd) {
    publish({ type: 'bridge_status', state: 'no-project' });
    return;
  }

  const args = buildPiArgs();
  publish({ type: 'bridge_status', state: 'starting', bin: PI_BIN, args, cwd: currentCwd });

  try {
    pi = spawnPi(PI_BIN, args);
  } catch (err) {
    publish({ type: 'bridge_status', state: 'error', error: String(err.message) });
    return;
  }

  pi.on('error', (err) => {
    publish({
      type: 'bridge_status',
      state: 'error',
      error: `无法启动 pi：${err.message}`,
      hint: '确认 pi 已安装并在 PATH 中，或用环境变量 PI_BIN 指定完整路径。',
    });
  });

  pi.stdout.setEncoding('utf8');
  pi.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    // 只按 LF 切分 —— pi 协议明确要求
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      let line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line) continue;
      try {
        publish(JSON.parse(line));
      } catch {
        publish({ type: 'bridge_parse_error', raw: line.slice(0, 400) });
      }
    }
  });

  pi.stderr.setEncoding('utf8');
  pi.stderr.on('data', (text) => {
    publish({ type: 'bridge_stderr', text });
  });

  pi.on('spawn', () => {
    publish({ type: 'bridge_status', state: 'ready', pid: pi?.pid ?? null });
  });

  pi.on('exit', (code, signal) => {
    pi = null;
    stdoutBuf = '';
    publish({ type: 'bridge_status', state: 'exited', code, signal });
    if (!shuttingDown) {
      setTimeout(startPi, 1200);
    }
  });
}

function sendToPi(cmd) {
  // 没项目时给出可执行的指引，别只说「子进程未运行」—— 用户会以为是崩溃
  if (!currentCwd) {
    throw new Error('还没有选择项目：先在左侧「添加文件夹」选一个目录，再发送消息。');
  }
  if (!pi || !pi.stdin || pi.stdin.destroyed) {
    throw new Error('pi 子进程未运行');
  }
  pi.stdin.write(JSON.stringify(cmd) + '\n');
}

/** 重启 pi 子进程 —— 用于让它重新读取 ~/.pi/agent/models.json */
function restartPi() {
  if (pi) {
    publish({ type: 'bridge_status', state: 'restarting', reason: 'reload-config' });
    try {
      pi.stdin.end();
    } catch {
      /* noop */
    }
    try {
      pi.kill();
    } catch {
      /* noop */
    }
    // exit 回调里会自动重新拉起
  } else {
    startPi();
  }
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/* ---------- 本地访问控制 ---------- */

/* 这个服务的权限相当大：能把任意命令写进 pi 的 stdin（pi 自带 bash 工具）、
 * 能读写项目文件、能改 ~/.pi/agent/models.json、能接收文件上传。
 *
 * 「只监听 127.0.0.1」并不足够 —— CORS 只拦「读响应」，不拦「发请求」，
 * 所以用户浏览器里打开的任意网页都能向 127.0.0.1:7788 发 POST。
 * 于是加两层：
 *
 *   1. Origin 校验。带了 Origin 且不是自己人，直接拒。挡掉网页发起的跨站请求。
 *      只在自己这个端口上服务页面，所以「同源」= 自己人，判据很干净。
 *
 *   2. 共享令牌。桌面版由 Electron 生成 32 字节随机 token，经环境变量传进来，
 *      再由主进程用 webRequest 统一给发往本后端的请求加头 —— 于是 token
 *      不进页面、不进 URL、不进日志、不落盘。浏览器里根本拿不到它。
 *
 * 没设令牌时退化成「开发模式」：只做 Origin 校验，启动日志会明确写出来。
 * 这样 `npm start` 的纯浏览器开发流程完全不受影响。 */
const AUTH_TOKEN = String(process.env.PI_GUI_TOKEN || '').trim();
const TOKEN_HEADER = 'x-pi-gui-token';
const SELF_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

/** 定长比较，避免按字符前缀提前返回。长度不等直接判否。 */
function tokenEquals(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** 返回 null 表示放行；否则返回 {code, error}。
 *  错误信息里**不回显**收到的值，也不回显令牌本身。 */
function denyRequest(req) {
  const origin = req.headers.origin;
  if (origin && !SELF_ORIGINS.has(origin)) {
    return { code: 403, error: '拒绝来自其他站点的请求' };
  }
  if (!AUTH_TOKEN) return null;

  const header = req.headers[TOKEN_HEADER];
  const auth = String(req.headers.authorization || '');
  const bearer = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : '';
  const given = String((Array.isArray(header) ? header[0] : header) || bearer || '').trim();

  if (given && tokenEquals(given, AUTH_TOKEN)) return null;
  return { code: 401, error: '缺少或无效的访问令牌' };
}

/* 身份探测端点：**免认证**。
 *
 * Electron 要在「还没建立任何信任」之前就问出「这个端口上是不是 Pi GUI」，
 * 所以它必须无门槛 —— 否则拿不到令牌的探测请求会被 401，而 401 恰恰
 * 也是一个「不是随便什么服务」的信号，会让 foreign-service 的判定变模糊。
 * 这里暴露的信息只有应用名、协议号和版本号，不构成风险。 */
function handleHealth(res) {
  return json(res, 200, { ok: true, app: APP_ID, protocol: PROTOCOL, version: VERSION });
}

// ---------- 供应商配置（~/.pi/agent/models.json） ----------

function readModelsConfig() {
  try {
    const raw = fs.readFileSync(MODELS_JSON, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      if (!data.providers || typeof data.providers !== 'object') data.providers = {};
      return data;
    }
  } catch {
    /* 文件不存在或损坏，按空配置处理 */
  }
  return { providers: {} };
}

function writeModelsConfig(data) {
  fs.mkdirSync(path.dirname(MODELS_JSON), { recursive: true });
  // 原子写：先落临时文件再 rename，避免中途失败把用户配置写坏
  const tmp = `${MODELS_JSON}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, MODELS_JSON);
}

// 读取小型 JSON 请求体。同样按 Buffer 累积，避免多字节字符被 chunk 边界切开。
function readBody(req, limit = 2 * 1024 * 1024) {
  return readRawBody(req, limit).then((buf) => buf.toString('utf8'));
}

// 上传走裸二进制（文件名放 query），省掉 multipart 解析。
// 超限时不 destroy 请求，而是停止缓冲并让连接自然读完 —— 否则响应写不回去，
// 前端只能看到连接被重置，拿不到「文件过大」这个明确原因。
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > limit) {
        tooBig = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) reject(new Error(`文件超过上限 ${Math.round(limit / 1024 / 1024)} MB`));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

// ---------- 附件上传 ----------

const UPLOAD_DIR = path.join(DATA_DIR, '.uploads');

// 去掉路径分隔符和控制字符，避免文件名穿越目录
function safeName(name) {
  const base = path.basename(String(name || 'file'));
  const cleaned = base.replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/^\.+/, '');
  return cleaned.slice(0, 120) || 'file';
}

function handleUpload(req, res, url) {
  const rawName = url.searchParams.get('name') || 'file';
  const name = safeName(decodeURIComponent(rawName));

  readRawBody(req, maxBytes())
    .then(async (buf) => {
      if (!buf.length) return json(res, 400, { ok: false, error: '文件内容为空' });

      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const stored = `${stamp}_${name}`;
      const filePath = path.join(UPLOAD_DIR, stored);
      fs.writeFileSync(filePath, buf);

      let result;
      try {
        result = await extract(filePath, name);
      } catch (err) {
        return json(res, 200, {
          ok: true,
          id: stored,
          name,
          size: buf.length,
          path: filePath,
          kind: 'binary',
          error: err.message,
        });
      }

      const payload = {
        ok: true,
        id: stored,
        name,
        size: buf.length,
        path: filePath,
        kind: result.kind,
        pages: result.pages ?? null,
        note: result.note || '',
      };

      if (result.kind === 'text') {
        const { text, truncated } = clampInline(result.text);
        payload.chars = result.text.length;
        payload.truncated = truncated;
        payload.text = text;
        payload.preview = result.text.slice(0, 160).replace(/\s+/g, ' ');
      }

      return json(res, 200, payload);
    })
    .catch((err) => json(res, 400, { ok: false, error: String(err.message) }));
}

const API_TYPES = new Set([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
]);

/* pi 的模型条目字段白名单（见 pi docs/models.md 的 Model Configuration）。
 * 前端只允许写这几个 —— 其余键一律丢弃，避免把任意结构塞进用户配置。
 * 数值做范围检查：写进 0 或负数会让 pi 的上下文压缩阈值算错。 */
const MODEL_FIELDS = {
  name: (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined),
  contextWindow: (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
  },
  maxTokens: (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
  },
  reasoning: (v) => (typeof v === 'boolean' ? v : undefined),
  input: (v) => {
    if (!Array.isArray(v)) return undefined;
    const kinds = [...new Set(v.filter((x) => x === 'text' || x === 'image'))];
    return kinds.length ? kinds : undefined;
  },
};

function cleanModelEntry(m) {
  if (!m || typeof m !== 'object') return null;
  const id = String(m.id ?? '').trim();
  if (!id) return null;

  const out = { id: id.slice(0, 300) };
  for (const [key, coerce] of Object.entries(MODEL_FIELDS)) {
    const value = coerce(m[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/* pi 的 apiKey 支持三种写法：$ENV_VAR 引用环境变量、!command 执行命令取值、字面量。
 * 实测：$VAR 未设置时 pi 会**静默丢掉整个供应商**——get_available_models 里完全查不到，
 * 也不报错。所以这里主动检查并提示，否则用户根本不知道为什么加完没反应。 */
function apiKeyState(apiKey) {
  const raw = String(apiKey ?? '').trim();

  if (!raw) {
    return { kind: 'none', ok: false, note: '没有填 apiKey：pi 会要求先登录该供应商，否则模型不会出现在列表里' };
  }
  if (raw.startsWith('$$') || raw.startsWith('$!')) {
    return { kind: 'literal', ok: true, note: '' };
  }
  if (raw.startsWith('$')) {
    // 两种等价写法：$NAME 和 ${NAME}。只取 slice(1) 会把 ${NAME} 解析成 "{NAME}"，
    // 于是一个明明设置好的变量被误报成「没有设置」。
    const body = raw.slice(1);
    const name = body.startsWith('{') && body.endsWith('}') ? body.slice(1, -1) : body;
    if (process.env[name]) return { kind: 'env', ok: true, note: `已从环境变量 ${name} 取值` };
    return {
      kind: 'env',
      ok: false,
      note: `环境变量 ${name} 没有设置，pi 会忽略这个供应商。请先设置该变量，再用同样的环境启动本服务`,
    };
  }
  if (raw.startsWith('!')) {
    return { kind: 'command', ok: true, note: '将由命令取值，请确认命令可用' };
  }
  return { kind: 'literal', ok: true, note: '' };
}

function handleProviders(req, res, url) {
  // 读取全部供应商
  if (req.method === 'GET') {
    const cfg = readModelsConfig();
    const keyStates = {};
    for (const [name, c] of Object.entries(cfg.providers || {})) {
      keyStates[name] = apiKeyState(c?.apiKey);
    }
    return json(res, 200, {
      ok: true,
      path: MODELS_JSON,
      exists: fs.existsSync(MODELS_JSON),
      providers: cfg.providers,
      keyStates,
    });
  }

  // 新增或更新一个供应商
  if (req.method === 'POST') {
    readBody(req)
      .then((raw) => {
        let payload;
        try {
          payload = JSON.parse(raw || '{}');
        } catch {
          return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        }

        const name = String(payload.name || '').trim();
        const config = payload.config || {};

        if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
          return json(res, 400, {
            ok: false,
            error: '供应商 ID 只能包含字母、数字、点、下划线和连字符，长度 1-64',
          });
        }
        if (!config.baseUrl || typeof config.baseUrl !== 'string') {
          return json(res, 400, { ok: false, error: 'Base URL 必填' });
        }
        if (config.api && !API_TYPES.has(config.api)) {
          return json(res, 400, { ok: false, error: `不支持的 API 类型：${config.api}` });
        }
        if (!Array.isArray(config.models)) {
          return json(res, 400, { ok: false, error: 'models 必须是数组' });
        }

        const clean = {
          baseUrl: String(config.baseUrl).trim(),
          api: config.api || 'openai-completions',
        };
        if (config.apiKey && String(config.apiKey).trim()) {
          clean.apiKey = String(config.apiKey).trim();
        }
        clean.models = config.models.map(cleanModelEntry).filter(Boolean);

        const cfg = readModelsConfig();
        cfg.providers[name] = clean;
        writeModelsConfig(cfg);

        const key = apiKeyState(clean.apiKey);
        return json(res, 200, {
          ok: true,
          path: MODELS_JSON,
          provider: name,
          warning: key.ok ? '' : key.note,
          keyState: key,
        });
      })
      .catch((err) => json(res, 500, { ok: false, error: String(err.message) }));
    return;
  }

  // 删除一个供应商
  if (req.method === 'DELETE') {
    const name = decodeURIComponent(url.pathname.slice('/api/providers/'.length));
    const cfg = readModelsConfig();
    if (!cfg.providers[name]) {
      return json(res, 404, { ok: false, error: `供应商 ${name} 不存在` });
    }
    delete cfg.providers[name];
    writeModelsConfig(cfg);
    return json(res, 200, { ok: true, path: MODELS_JSON, removed: name });
  }

  return json(res, 405, { ok: false, error: 'Method not allowed' });
}

// ---------- 项目（工作目录） ----------

function readProjects() {
  try {
    const data = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    if (data && Array.isArray(data.items)) {
      // active 兜底用「正在跑的那个目录」：用户可能刚把 active 那条从列表里移掉，
      // 但当前会话还在那个目录里跑着，界面上的高亮要跟着实际状态走。
      return { active: data.active || currentCwd || '', items: data.items };
    }
  } catch {
    /* 首次运行 —— 空列表，等用户自己添加 */
  }
  /* 不再拿「当前目录」当默认项目。
   * 早先这里返回 items:[当前目录]，等于把「程序碰巧运行在哪」当成用户的项目，
   * 桌面版上就是用户主目录。 */
  return { active: currentCwd || '', items: [] };
}

function writeProjects(data) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// 返回 null 表示读不了（不存在 / 无权限），与「空目录」区分开
function readDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => {
        try {
          return e.isDirectory() && !e.name.startsWith('.');
        } catch {
          return false;
        }
      })
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      .slice(0, 400);
  } catch {
    return null;
  }
}

function listDirectory(target) {
  if (!target) {
    if (IS_WIN) {
      const drives = [];
      for (let i = 67; i <= 90; i++) {
        const d = String.fromCharCode(i) + ':\\';
        try {
          if (fs.existsSync(d)) drives.push({ name: d, path: d });
        } catch {
          /* 盘符不存在或无权限 */
        }
      }
      return { path: '', parent: null, dirs: drives };
    }
    const home = os.homedir();
    return { path: home, parent: path.dirname(home), dirs: readDirs(home) || [] };
  }

  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) return { error: `目录不存在：${resolved}` };

  const dirs = readDirs(resolved);
  if (dirs === null) return { error: `无法读取（可能没有权限）：${resolved}` };

  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent === resolved ? null : parent,
    dirs,
  };
}

function handleFs(res, url) {
  const target = url.searchParams.get('path') || '';
  try {
    const r = listDirectory(target);
    if (r.error) return json(res, 200, { ok: false, error: r.error });
    return json(res, 200, { ok: true, ...r });
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err.message) });
  }
}

// Windows 与 macOS 的路径不区分大小写，去重必须归一后再比，
// 否则同一个目录换个大小写就能重复加进来。
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (s) => {
    const t = String(s).replace(/[\\/]+$/, '');
    return IS_WIN || process.platform === 'darwin' ? t.toLowerCase() : t;
  };
  return norm(a) === norm(b);
}

function handleProjects(req, res, url) {
  if (req.method === 'GET') {
    return json(res, 200, { ok: true, ...readProjects(), cwd: currentCwd });
  }

  if (req.method === 'POST' && url.pathname === '/api/projects') {
    return readBody(req)
      .then((raw) => {
        let payload;
        try {
          payload = JSON.parse(raw || '{}');
        } catch {
          return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        }

        const target = String(payload.path || '').trim();
        if (!target) return json(res, 400, { ok: false, error: '路径必填' });

        const resolved = path.resolve(target);
        let stat;
        try {
          stat = fs.statSync(resolved);
        } catch {
          return json(res, 400, { ok: false, error: `目录不存在：${resolved}` });
        }
        if (!stat.isDirectory()) {
          return json(res, 400, { ok: false, error: `不是目录：${resolved}` });
        }

        const cfg = readProjects();
        if (!cfg.items.some((p) => samePath(p.path, resolved))) {
          cfg.items.push({
            path: resolved,
            name: String(payload.name || '').trim() || path.basename(resolved) || resolved,
          });
          writeProjects(cfg);
        }
        return json(res, 200, { ok: true, path: resolved });
      })
      .catch((err) => json(res, 500, { ok: false, error: String(err.message) }));
  }

  if (req.method === 'DELETE') {
    const raw = url.searchParams.get('path') || '';
    const resolved = path.resolve(raw);
    const cfg = readProjects();
    const before = cfg.items.length;
    cfg.items = cfg.items.filter((p) => !samePath(p.path, resolved));
    /* 移掉的正好是「上次激活的那个」时，把 active 也清掉。
     *
     * 不清的话会出现这种怪事：从列表里移除了，重启之后它又回来了
     * （resolveInitialCwd 读的就是 active）。用户会觉得「移除没生效」。
     * 注意这里**不**动 currentCwd —— 当前会话还在那个目录里跑着，
     * 立刻把 pi 掐掉比留着更让人困惑。 */
    if (samePath(cfg.active, resolved)) cfg.active = '';
    writeProjects(cfg);
    return json(res, 200, { ok: true, removed: resolved, count: before - cfg.items.length });
  }

  if (req.method === 'POST' && url.pathname === '/api/projects/activate') {
    return readBody(req)
      .then((raw) => {
        let payload;
        try {
          payload = JSON.parse(raw || '{}');
        } catch {
          return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        }

        const resolved = path.resolve(String(payload.path || ''));
        try {
          if (!fs.statSync(resolved).isDirectory()) throw new Error('not a directory');
        } catch {
          return json(res, 400, { ok: false, error: `目录不可用：${resolved}` });
        }

        const cfg = readProjects();
        cfg.active = resolved;
        if (!cfg.items.some((p) => samePath(p.path, resolved))) {
          cfg.items.push({ path: resolved, name: path.basename(resolved) || resolved });
        }
        writeProjects(cfg);

        // pi 只能在启动时确定 cwd，所以切换项目必须重启子进程
        currentCwd = resolved;
        restartPi();
        return json(res, 200, { ok: true, cwd: resolved });
      })
      .catch((err) => json(res, 500, { ok: false, error: String(err.message) }));
  }

  return json(res, 405, { ok: false, error: 'Method not allowed' });
}

/* ---------- Git 变更（Changed Files / Diff / 撤销 / 打开） ----------
 *
 * 设计要点：
 *   - **不是 Git 仓库不是错误。** Pi GUI 允许打开普通文件夹，那种情况下 Agent
 *     照常工作，只是没有变更信息。所以一律回 200 + isRepo:false，让前端安静降级，
 *     而不是弹一串错误提示。
 *   - 真正的错误（路径越权、git 未安装）也用 200 + ok:false 回，但带明确的
 *     error 文案 —— 前端只有「解析 JSON 看 ok」这一条路径，不必同时处理
 *     HTTP 错误码和业务错误两套逻辑。唯一的例外是**路径越权**：那属于明确的
 *     拒绝，用 403 表态，便于审计与测试。
 *   - 路径安全统一由 lib/safe-path.js 把关（见那里的说明）。这里只负责把
 *     结果映射成 HTTP 语义。
 *
 * 写操作有两条**默认关闭**的闸门（删未跟踪文件 / 取消暂存）。没有授权时后端
 * 不会动手，而是回 `needsPlan` / `needsUnstage` / `needsConfirm` + 一份计划，
 * 由前端问过用户再带授权重发 —— 所以这里不需要为「需要确认」单独设计状态码。
 */

/** 越权类错误 → 403；参数缺失 → 400；其余（非仓库 / git 未安装 / 没有改动 / 需确认）→ 200。 */
function gitStatusOf(result) {
  if (result.ok) return 200;
  if (result.code === 'empty') return 400;
  if (result.code === 'absolute' || result.code === 'escape' || result.code === 'symlink' || result.code === 'illegal') {
    return 403;
  }
  return 200;
}

function handleGit(req, res, url) {
  const sub = url.pathname.slice('/api/git/'.length);

  if (sub === 'status' && req.method === 'GET') {
    return gitStatus(currentCwd)
      .then((r) => json(res, 200, r))
      .catch((err) => json(res, 200, { ok: false, isRepo: false, files: [], error: String(err.message) }));
  }

  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });

  // 没有项目时这些操作都无从谈起，直接给出可执行的指引
  if (!currentCwd) {
    return json(res, 200, { ok: false, isRepo: false, noProject: true, error: '还没有选择项目：先在左侧「添加文件夹」选一个目录。' });
  }

  return readBody(req)
    .then(async (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }

      /* 撤销全部。不接受 path —— 它作用于整个工作区，多一个参数只会让
       * 「到底撤了什么」变得含糊。放在 `path` 校验**之前**，因为它本来就不需要。 */
      if (sub === 'restore-all') {
        const r = await restoreAllGit(currentCwd, {
          deleteUntracked: payload.deleteUntracked === true,
          unstage: payload.unstage === true,
          planned: payload.planned === true,
        });
        return json(res, gitStatusOf(r), r);
      }

      const rel = String(payload.path ?? '');
      if (!rel.trim()) return json(res, 400, { ok: false, error: '缺少 path' });

      if (sub === 'diff') {
        const r = await gitDiff(currentCwd, rel, { context: payload.context });
        return json(res, gitStatusOf(r), r);
      }

      if (sub === 'restore') {
        const r = await gitRestore(currentCwd, rel, {
          deleteUntracked: payload.deleteUntracked === true,
          unstage: payload.unstage === true,
        });
        return json(res, gitStatusOf(r), r);
      }

      if (sub === 'open') {
        /* 只做校验并给出绝对路径 —— **不在这里打开文件**。
         * 浏览器模式下后端没有「用系统默认程序打开」的能力，桌面版则由 Electron
         * 主进程拿着这个绝对路径去 shell.openPath。好处是「什么算项目内的文件」
         * 只有这一处答案，Electron 那边不必再实现一遍同样的判断。 */
        const r = resolveOpenTarget(currentCwd, rel);
        return json(res, gitStatusOf(r), r);
      }

      return json(res, 404, { ok: false, error: '未知的 Git 接口' });
    })
    .catch((err) => json(res, 500, { ok: false, error: String(err.message) }));
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  try {
    rel = decodeURIComponent(rel);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad request');
    return;
  }

  // 挡目录穿越。打包成 exe 后资源是内存里的 key，更要自己把关。
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (norm.startsWith('..') || norm.includes('/../') || path.isAbsolute(norm)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }

  try {
    const data = readPublic(norm);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(norm).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': pi-gui event stream\n\n');
  for (const evt of backlog) {
    try {
      res.write(frame(evt));
    } catch {
      break;
    }
  }
  clients.add(res);

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* noop */
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

// 带图的 prompt 要装 base64，手机截图动辄 3-5MB，编码后还要涨三分之一，
// 所以这里给足余量；上限可用环境变量覆盖。
const MAX_COMMAND_BYTES = Number(process.env.PI_GUI_MAX_COMMAND_BYTES || 96 * 1024 * 1024);

function handleCommand(req, res) {
  // 必须按 Buffer 累积再一次性解码：逐块 body += chunk 会在 chunk 边界
  // 把多字节字符切开，中文就会变成乱码。
  readRawBody(req, MAX_COMMAND_BYTES)
    .then((buf) => {
      let cmd;
      try {
        cmd = JSON.parse(buf.toString('utf8') || '{}');
      } catch {
        return json(res, 400, { ok: false, error: '命令不是合法 JSON' });
      }
      try {
        sendToPi(cmd);
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 503, { ok: false, error: String(err.message) });
      }
    })
    .catch((err) => json(res, 413, { ok: false, error: String(err.message) }));
}

/* 从供应商的 /models 接口拉取模型列表。
 *
 * 必须由服务端代发：浏览器直连会撞 CORS。实现细节在 lib/models-api.js。
 * 无论成功失败都回 200，让前端统一走「解析 JSON 里的 ok」这条路径 ——
 * 否则前端要同时处理 HTTP 错误和业务错误两套逻辑。 */
function handleProviderModels(req, res) {
  readBody(req)
    .then(async (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }

      const baseUrl = String(payload.baseUrl || '').trim();
      if (!baseUrl) return json(res, 200, { ok: false, error: '请先填写 Base URL' });

      const api = API_TYPES.has(payload.api) ? payload.api : 'openai-completions';

      const out = await fetchModels({
        baseUrl,
        api,
        apiKey: payload.apiKey,
        headers: payload.headers && typeof payload.headers === 'object' ? payload.headers : {},
      });

      if (!out.ok) return json(res, 200, { ok: false, error: out.error, tried: out.tried });
      return json(res, 200, {
        ok: true,
        source: out.source,
        keySource: out.keySource,
        tried: out.tried,
        models: out.models,
      });
    })
    .catch((err) => json(res, 500, { ok: false, error: String(err.message) }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 身份探测：必须排在鉴权之前（见 handleHealth 的说明）
  if (url.pathname === '/api/health' && req.method === 'GET') return handleHealth(res);

  /* 其余 /api/* 一律先过访问控制。
   * 注意是「全部」而不是挑几个敏感的 —— 逐个列敏感项迟早会漏一个，
   * 而漏掉的那个正好是新加的功能。静态资源不受影响。 */
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    const denied = denyRequest(req);
    if (denied) return json(res, denied.code, { ok: false, error: denied.error });
  }

  if (url.pathname === '/api/events' && req.method === 'GET') return handleEvents(req, res);
  if (url.pathname === '/api/command' && req.method === 'POST') return handleCommand(req, res);
  if (url.pathname === '/api/status' && req.method === 'GET') {
    return json(res, 200, {
      piRunning: Boolean(pi),
      pid: pi?.pid ?? null,
      args: buildPiArgs(),
      cwd: currentCwd,
      // 前端用它决定「显示引导还是显示输入框」。cwd 为空就等价于没有项目，
      // 但显式给一个字段更不容易被将来的改动弄丢。
      hasProject: Boolean(currentCwd),
    });
  }
  // 必须排在下面那条前缀匹配之前 —— 否则 /api/providers/models 会被
  // 当成「保存一个叫 models 的供应商」，而且前端拿不到任何报错。
  if (url.pathname === '/api/providers/models' && req.method === 'POST') {
    return handleProviderModels(req, res);
  }
  if (url.pathname === '/api/providers' || url.pathname.startsWith('/api/providers/')) {
    return handleProviders(req, res, url);
  }
  if (url.pathname === '/api/projects' || url.pathname.startsWith('/api/projects/')) {
    return handleProjects(req, res, url);
  }
  if (url.pathname === '/api/fs' && req.method === 'GET') {
    return handleFs(res, url);
  }
  // 必须排在下面「req.method !== 'GET' → 405」之前
  if (url.pathname === '/api/git' || url.pathname.startsWith('/api/git/')) {
    return handleGit(req, res, url);
  }
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    return handleUpload(req, res, url);
  }
  if (url.pathname === '/api/restart' && req.method === 'POST') {
    restartPi();
    return json(res, 200, { ok: true });
  }
  if (req.method !== 'GET') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  serveStatic(res, url.pathname);
});

// ---------- 生命周期 ----------

function shutdown() {
  shuttingDown = true;
  for (const res of clients) {
    try {
      res.end();
    } catch {
      /* noop */
    }
  }
  clients.clear();
  if (pi) {
    try {
      pi.stdin.end();
    } catch {
      /* noop */
    }
    try {
      pi.kill();
    } catch {
      /* noop */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* 双击启动时自动打开浏览器（PI_GUI_OPEN=1 或 --open）。
 * 打包成 exe 后默认就开 —— 它本来就是给双击用的。
 * 注意 Windows 的 start 是 cmd 内建命令，必须经 cmd /c 调用。 */
const AUTO_OPEN =
  process.env.PI_GUI_OPEN === '1' ||
  process.argv.includes('--open') ||
  (isSea() && process.env.PI_GUI_OPEN !== '0');

function openBrowser(url) {
  const [bin, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(bin, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* 打不开就算了，控制台里印了地址 */
  }
}

// 端口被占用：多半是已经开着一个，直接把浏览器指过去，别报一堆错吓人
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('');
    console.log(`  端口 ${PORT} 已被占用，说明已经有一个 Pi GUI 在跑。`);
    console.log(`  直接用它：http://127.0.0.1:${PORT}`);
    console.log(`  （想开新的：set PORT=7799 && node server.js）`);
    if (AUTO_OPEN) openBrowser(`http://127.0.0.1:${PORT}`);
    setTimeout(() => process.exit(0), 400);
    return;
  }
  console.error('\n  启动失败：' + err.message + '\n');
  process.exit(1);
});

startPi();
/* 显式绑定回环地址。
 *
 * 不要依赖 Node 的默认行为，也不要写 '0.0.0.0' —— 这个服务能驱动 pi 执行
 * 任意命令，一旦暴露到局域网就是一台无认证的远程 shell。
 * 日志里也只用 127.0.0.1，不给任何「可以从别的机器访问」的暗示。 */
server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  Pi GUI 已启动');
  console.log(`  → http://127.0.0.1:${PORT}`);
  console.log(`  → 工作目录: ${currentCwd || '（未选择 —— 在界面里「添加文件夹」）'}`);
  if (currentCwd) console.log(`  → pi 子进程: ${PI_BIN} ${buildPiArgs().join(' ')}`);
  console.log(
    AUTH_TOKEN
      ? '  → 访问控制: 令牌校验已启用（由桌面端注入，浏览器直连会被拒）'
      : '  → 访问控制: 开发模式（未配置令牌，仅校验请求来源；仅供本机开发使用）'
  );
  console.log('');
  if (AUTO_OPEN) openBrowser(`http://127.0.0.1:${PORT}`);
});
