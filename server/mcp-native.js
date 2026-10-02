/* P20.6 Native MCP 状态与受控动作 —— 用 pi 原生的 MCP，不自建 client runtime。
 *
 * ---------- 这个模块是什么 ----------
 *
 * P20.5 的 `/api/mcp` 只是一份能力报告（包里带不带 `builtin:mcp`、配置文件在不在、
 * `servers` 恒为空）。这一层把它升级成真实集成，但**只用 pi 官方的路**：
 *
 *   1. **状态**：`pi mcp list --json`（官方结构化输出，实测形状
 *      `{servers:[{name,scope,source,enabled,exposure,transport,state,tools[],
 *      toolExposure?,resources?,resourceTemplates?,error?}],errors:[],note?}`，
 *      状态词汇 `connecting/connected/needs-auth/disconnected/disabled/failed/closed`）。
 *      人类文本（`pi mcp list` 裸输出、`/mcp` TUI）**绝不解析** —— 文案不是 API。
 *      **每一项都过 allowlist**（见 §运行时投影）：上游新增字段默认丢弃，
 *      未知枚举值折成 `unknown`，绝不把任意字符串原样投影进 DOM。
 *   2. **配置 scope**：安全解析两处 `mcp.json`（只取结构：名 / scope / enabled /
 *      exposure / description / transport 类型 / toolExposure 键；`env` / `headers` /
 *      `oauth` / `auth` 的**值一个字节都不进报告**）。`mcp-auth.json` 的 token
 *      **绝不读**。
 *   3. **动作**：只代理 pi 官方 shell CLI（add / remove / login / logout）。
 *      enable / disable / reconnect / 改 exposure **没有** shell 接口
 *      （实测 `pi mcp --help` 只有上述五个）→ 本轮 unsupported，指引 `/mcp` TUI，
 *      不手改 JSON 伪装成官方 manager。
 *
 * ---------- 四条硬边界 ----------
 *
 * - **跑的必须是 bridge 正在跑的那份 pi。** 入口从 `resolvePackageDir()`
 *   （launch identity）派生：`<packageDir>/<bin.pi>`（实测 `dist/bundle/cli.js`）
 *   + `process.execPath`，`shell:false` + args 数组。`packageDir` 证明不了
 *   （null）→ 状态 unknown、动作 unsupported —— **不退回裸 `pi`**，那会命中
 *   另一份安装（P20.5 Blocker A 的同一种错）。
 * - **`list --json` 会启动用户配置的 stdio servers**（连 HTTP 也会联网）。
 *   所以它只在用户显式手势（MCP 页「刷新状态」）时跑一次，60s TTL 缓存，
 *   **绝不后台轮询**。自动返回的永远是轻量摘要（配置解析 + 内置 probe）。
 * - **缓存必须绑定 workspace 与 launch identity。** runtime 状态与 replaced
 *   结论都是「当前这个 cwd、当前这份 pi」的事实；换项目或换 pi 实例后它们
 *   立即失效（见 §缓存）。一个进程内的全局 TTL 会把 A 项目的 `connected` /
 *   `replaced=true` 带到 B 项目 —— 那是这条边界要挡的错。
 * - **OAuth 全程 pi 负责**：注册 client、开浏览器、存 `mcp-auth.json`、自动刷新。
 *   in-session 的 select / input 经 P19 的 extension_ui 管道自动承接（mcp 扩展
 *   只用 `ctx.ui.notify/select/input`，实测无 confirm），本模块不新增任何
 *   OAuth 代码，不读、不缓存、不复制任何 token / clientSecret。
 *
 * ---------- 写操作的 trust gate（P20.6-Fix）----------
 *
 * 上游实测（0.99.2 `dist/extensions/mcp/cli.js`）：`runMcpCommand` 在
 * `add` / `remove` 两条分支上**直接返回，不查 project trust**；只有
 * `list` / `login` / `logout` 才 `new ProjectTrustStore(agentDir).get(cwd)`。
 * 也就是说 `pi mcp add -l` 会照写未信任项目的 `.pi/mcp.json`。
 *
 * GUI 因此必须自己立这道闸：**scope=project 的 add / remove 只有
 * `trusted === true` 才允许落到 pi CLI**；`false` 与「拿不到」（null）
 * 一律 fail closed（不执行、返回 `project-untrusted`）。user scope 不受影响。
 * 这不是复制第二套 trust 真值 —— 判定来源仍是注入的 `readTrust`
 * （与 Skills / extension-registry 同一个）。
 *
 * ---------- secret contract（P20.6-Fix）----------
 *
 * GUI 的 MCP 添加接口**只接受不含 secret value 的配置**。`headers[].value` /
 * `env[].value` / `oauth.*` / `auth.*` 一律在 HTTP 边界拒绝（`secret-input-unsupported`），
 * 不进 argv —— 这样即使 pi 哪天把敏感 argv 回显到 stderr，也没有东西可泄。
 * 允许保留的只有**引用名**：`bearerTokenEnvVar: "GITHUB_TOKEN"`（argv 里是
 * `--bearer-token-env-var GITHUB_TOKEN`，pi 把它写成 `Bearer ${GITHUB_TOKEN}`，
 * 值本身从不经过 GUI）。带凭据的 server 走终端 `pi mcp add` 或直接编辑 mcp.json。
 *
 * ---------- 依赖注入（模块之间不互相 import） ----------
 *
 *   runtime              共享运行态（cwd、stale 判定）
 *   env                  环境变量（agent 目录、HOME）
 *   resolvePackageDir    launch identity 的包目录（server.js 注入 piLaunch.packageDir）
 *   resolveLaunchIdentity launch identity 的不透明 key（server.js 注入
 *                        piLaunch.identityKey）—— 只参与缓存分键，永不进响应
 *   readTrust            项目信任状态（server.js 注入，与 extension-registry 同一个来源）
 *   rpc                  桥接（可选）：`get_commands` 里找 `{source:'extension',name:'mcp'}`
 *                        —— 替代 builtin 的扩展只留下这一条 RPC 可见证据
 *   runCli               执行原语 `(entry, args, {cwd, timeoutMs}) => Promise<result>`，
 *                        server.js 从 `server/agents/cli.js` 的 `runCli` 包一层注入
 *   piBuiltins           共用的 built-in 探测 `(cwd) => 探测结果`
 *   now / ttlMs          时间源与缓存时长（单测注入）
 *
 * ---------- 契约核对对象 ----------
 *
 * pi **0.99.2** 发布包（`dist/core/mcp-servers.d.ts`、`dist/extensions/mcp/{cli,config,runtime,tools}.d.ts`、
 * `docs/mcp.md`、`docs/rpc-commands.md`）。0.99.1 → 0.99.2 的差异见
 * `docs/pi-compatibility.md`；RPC 命令面在两个版本上逐字节相同（仍无 MCP 管理接口）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json, readBody } from './http-utils.js';

/* server 名的判定有**两套**，别混（见 `isServerName` / `isActionName`）：
 *   - 配置解析用上游规则（`/^[A-Za-z0-9_-]+$/`，不限长度）—— 决定「Pi 会不会加载它」；
 *   - GUI 动作入参额外加 64 字符上限 —— 那是输入侧防御，不是配置判定。 */
/* 0.99.2 的闭集是 `codemode | deferred | direct | hidden`（`core/mcp-servers.js`
 * 的 `MCP_EXPOSURES`）；`codemode-deferred` 是**输入别名**，`validateMcpServerConfig`
 * 会把它解析成 `codemode`，所以 `list --json` 报出来的永远是 `codemode`。
 * 我们读的是**原始文件**，所以两边都要认；但只把规范值往下游传。 */
const EXPOSURE_ALIASES = new Map([['codemode-deferred', 'codemode']]);
const EXPOSURES = new Set(['codemode', 'deferred', 'direct', 'hidden']);
const DEFAULT_EXPOSURE = 'codemode';
/* `pi mcp list --json` 的 `state` 闭集（`runtime.d.ts` 的 `ServerState`
 * 加上 `list()` 给 `enabled:false` 条目合成的 `disabled`）。上游若加新值，
 * 这里**不跟着放行** —— 折成 `unknown` 并让界面说「无法识别」。 */
const RUNTIME_STATES = new Set(['connecting', 'connected', 'needs-auth', 'disconnected', 'disabled', 'failed', 'closed']);
/** `list --json` 的 `scope` 闭集（`config.d.ts` 的 `McpServerEntry.scope`）。
 *
 * ⚠️ 这是**类型**上的三值，不是 CLI 实际会产出的三值：`scope:"extension"` 由
 * session 内的 MCP 扩展赋值（`mcp/index.js` 的 `registeredServers()` 走
 * `pi.getMcpServers()`），而 `pi mcp list --json` 是 shell 命令、**不加载扩展**
 * （0.99.2 `docs/mcp.md`：「Shell commands do not load extensions.」），
 * 它只能产出 `global` / `project`。这里保留 `extension` 只是**防御性前向兼容**
 * —— 上游若哪天从 CLI 侧也报这个值，我们不会把它折成 `null`。 */
const RUNTIME_SCOPES = new Set(['global', 'project', 'extension']);
const MAX_FILE_BYTES = 256 * 1024;
const MAX_ERROR_CHARS = 500;
const MAX_TOOLS = 200;
/** raw MCP tool name 的展示长度上限（见 `sanitizeMcpRawToolName`）。 */
const MAX_TOOL_NAME = 128;
/** server 的 `description`（0.99.2 新增）：纯文本、单行化、限长。 */
const MAX_DESCRIPTION = 200;
/** add 接口允许的 argv 长度上限（防御式，不是产品约束）。 */
const MAX_ARGV_ITEMS = 40;

/* `pi mcp` 各子命令的超时：list 要连所有启用的 server，给 30s；
 * login 等浏览器回调，默认 120s（可短、不可长过 180s）；其余都是本地操作。 */
const TIMEOUT_LIST_MS = 30_000;
const TIMEOUT_WRITE_MS = 15_000;
const TIMEOUT_LOGIN_DEFAULT_S = 120;
const TIMEOUT_LOGIN_MAX_S = 180;

const STATUS_TTL_MS = 60_000;

function readJsonSafe(file, maxBytes = MAX_FILE_BYTES) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return { exists: true, data: null, error: 'unreadable' };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return { exists: true, data: parsed && typeof parsed === 'object' ? parsed : null, error: parsed ? '' : 'not-an-object' };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, data: null, error: '' };
    return { exists: true, data: null, error: 'unreadable' };
  }
}

function agentDirOf(env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent');
}

function clip(s, max = MAX_ERROR_CHARS) {
  const t = String(s ?? '');
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/* 控制字符（C0 + DEL + C1）。任何外部文本进 DOM 之前都要先过这一关 ——
 * 换行 / 回车 / NUL 是「一行文本」这个前提的破坏者，C1 区间（0x80–0x9f）在
 * 部分终端与渲染器里同样有控制语义。 */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]+/g;

/** 单行化 + 截断（`description` 这类外部自由文本进界面前统一走这里）。 */
function oneLine(s, max = MAX_DESCRIPTION) {
  const t = String(s ?? '').replace(CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/**
 * **raw MCP tool name 的安全投影**（P20.6-Fix-2 Blocker B）。
 *
 * ⚠️ 这一层和 `mcp__<server>__<tool>` 的**注册期标识符**是两回事，别混：
 *
 *   - `pi mcp list --json` 的 `tools[]` 是 `connection.tools.map(t => t.name)`
 *     （0.99.2 `mcp/cli.ts` 第 460 行）—— **MCP server 自己报的原始 tool name**，
 *     pi 一个字符都没改。它可以含 `-`、空格、`/`、`:`、Unicode、emoji…
 *   - `createMcpToolName()`（`mcp/tools.ts`）才负责把 `mcp__<server>__<tool>`
 *     里除 `[A-Za-z0-9_]` 之外的字符换成 `_`（重名再挂 8 位 sha256 后缀）。
 *     那是**注册为 Pi tool 时**的另一层逻辑，只在 Tool Timeline 那一侧出现。
 *
 * 所以这里**绝不能**套用标识符正则 —— 用 `^[A-Za-z0-9_.]+$` 过滤会把
 * `get-user`、`工具搜索`、`emoji-🔎` 这些完全合法的 raw tool name 静默删掉，
 * 于是 `toolCount` 也跟着失真。
 *
 * 这里做的是**安全文本边界**，不是字符集白名单：
 *   1. 只接受 `string`（对象 / 数字 / 数组 / null 一律丢）
 *   2. 控制字符 → 空格（NUL / CR / LF / C0 / C1 都挡掉，防注入与多行破坏）
 *   3. 折叠空白 + trim
 *   4. 空串丢弃（清一色控制字符的名字没有可展示形态）
 *   5. 超长**安全截断**（保留「server 确实报了这个工具」这个事实）
 *
 * @returns {string} 可安全放进 DOM 文本节点的单行串；不可用时回 `''`
 */
function sanitizeMcpRawToolName(v) {
  if (typeof v !== 'string') return '';
  return oneLine(v, MAX_TOOL_NAME);
}

/* ---------- 上游校验原语的复刻（0.99.2 `src/core/mcp-servers.ts`） ----------
 *
 * 这些是**判定「Pi 会不会接受并加载这条配置」**用的，不是 GUI 自己的口味。
 * 逐条对应上游同名/同义函数，注释里标明出处，改动前先回去读源码。 */

/** 上游 `SERVER_NAME`：**只限字符集，不限长度**（`/^[A-Za-z0-9_-]+$/`）。 */
const UPSTREAM_SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;
/** GUI 侧的**动作入参**长度上限（上游没有；这是输入侧防御，不是配置判定规则）。 */
const ACTION_NAME_MAX = 64;
/** 上游 `LOOPBACK_HOSTS`。 */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
/** 报错文案里用的 exposure 枚举串（与上游 `${exposures}` 同形）。 */
const EXPOSURE_LIST = [...EXPOSURES].map((e) => `"${e}"`).join(', ');

/** 上游 `isRecord`。 */
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 上游 `isStringRecord`（空对象通过 —— 与上游 `[].every()` 一致）。 */
function isStringRecord(v) {
  return isRecord(v) && Object.values(v).every((e) => typeof e === 'string');
}

/** 上游 `mcpNamespace`：`mcp__<server>`，`-` 折成 `_`。 */
function mcpNamespace(server) {
  return `mcp__${String(server).replace(/-/g, '_')}`;
}

/** 上游 `isLoopbackRedirectUri`。 */
function isLoopbackRedirectUri(value) {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname) && url.search === '' && url.hash === '';
}

/** 上游 `validateOAuth`：返回错误文案或 undefined。
 *
 * ⚠️ 逐条对应 `src/core/mcp-servers.ts` 的 `validateOAuth`。**1.0.0 起多了一条**
 * `authServerMetadataUrl`：必须是 https，或者 http + loopback 主机
 * （`localhost` / `127.0.0.1` / `[::1]`）。
 *
 * 这条**不能少**：GUI 的 `parseMcpServers()` 是「Pi 会不会接受这条配置」的复刻，
 * 少了它就会出现 P20.6-Fix-3 那类语义漂移 —— GUI 认为项目里那条合法、于是把
 * 同名用户级条目标成 `overridden`，而上游真的去加载时把它整条拒掉，
 * 结果**两条都不生效**。
 *
 * 与 `callbackUrl` 的差别（照抄上游，不要"顺手统一"）：
 *   - metadata URL **允许** query 与 fragment（上游只用协议 + 主机判）；
 *   - 不校验端口。 */
function validateOAuthConfig(value) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return 'oauth must be an object';
  if (value.clientId !== undefined && typeof value.clientId !== 'string') return 'oauth.clientId must be a string';
  if (value.clientSecret !== undefined && typeof value.clientSecret !== 'string') return 'oauth.clientSecret must be a string';
  const port = value.callbackPort;
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
    return 'oauth.callbackPort must be a port number';
  }
  if (value.callbackUrl !== undefined) {
    if (!isLoopbackRedirectUri(value.callbackUrl)) {
      return 'oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment';
    }
    const urlPort = new URL(value.callbackUrl).port;
    if (urlPort && port !== undefined && Number(urlPort) !== port) {
      return 'oauth.callbackUrl and oauth.callbackPort name different ports';
    }
  }
  if (value.scope !== undefined && typeof value.scope !== 'string') return 'oauth.scope must be a string';
  if (value.clientName !== undefined && (typeof value.clientName !== 'string' || !value.clientName.trim())) {
    return 'oauth.clientName must be a non-empty string';
  }
  /* 1.0.0 新增：认证服务器 metadata 文档地址（RFC 8414 / OIDC discovery）。
   * 上游原文：
   *   const url = typeof metadataUrl === "string" && URL.canParse(metadataUrl) ? new URL(metadataUrl) : undefined;
   *   if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)))) → 拒绝 */
  const metadataUrl = value.authServerMetadataUrl;
  if (metadataUrl !== undefined) {
    const url = typeof metadataUrl === 'string' && URL.canParse(metadataUrl) ? new URL(metadataUrl) : undefined;
    const ok = url && (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname)));
    if (!ok) {
      return 'oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]';
    }
  }
  return undefined;
}

/** 上游 HTTP 分支的 URL 判定：`URL.canParse` 且协议是 http/https。 */
function isHttpUrl(value) {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  return /^https?:$/.test(new URL(value).protocol);
}

/** 配置里的 server 名判定（**用上游规则**，不限长度）。 */
function isServerName(name) {
  return typeof name === 'string' && UPSTREAM_SERVER_NAME_RE.test(name);
}

/** 动作入参的名字判定：上游规则 + GUI 侧长度上限。 */
function isActionName(name) {
  return isServerName(name) && name.length <= ACTION_NAME_MAX;
}

/** exposure 别名解析：只认 0.99.2 的规范闭集，别名折成规范值，其余回 null。 */
function normalizeExposure(v) {
  if (typeof v !== 'string') return null;
  const canon = EXPOSURE_ALIASES.get(v) || v;
  return EXPOSURES.has(canon) ? canon : null;
}

/** 脱敏：把已知绝对路径折成占位符。错误文本里常带 stderr 尾巴（含路径）。 */
function redactPaths(text, { cwd = null, agentDir = null, homeDir = null } = {}) {
  let out = String(text ?? '');
  if (cwd) out = out.split(cwd).join('<project>');
  if (agentDir) out = out.split(agentDir).join('<agent-dir>');
  if (homeDir) out = out.split(homeDir).join('<home>');
  return out;
}

/**
 * 安全解析一份 mcp.json：**完整复刻上游 `validateMcpServerConfig()` 的接受/拒绝判定**
 * （P20.6-Fix-3），再叠加 GUI 侧的安全投影（不取 secret 值）。
 *
 * ---------- 为什么必须复刻校验，而不是只做结构解析 ----------
 *
 * 「项目同名项覆盖用户级」的判定必须用**「Pi 会接受并加载的 project entry」**。
 * 只要 GUI 的 parser 比上游**宽**，一个上游会拒绝、而 GUI 认为合法的项目条目
 * 就会被算进覆盖集合 —— 于是用户级被标成 `overridden`、项目那条又被上游跳过，
 * **两条都不生效**。这正是 P20.6-Fix-2 修掉的那个 bug 的隐蔽变体。
 * 所以这里逐条对齐 0.99.2 `src/core/mcp-servers.ts` 的 `validateMcpServerConfig`。
 *
 * 上游判定顺序（照抄，含分支优先级）：
 *   1. `SERVER_NAME.test(name)`（`/^[A-Za-z0-9_-]+$/`，**不限长度**）
 *   2. `isRecord(raw)`
 *   3. `exposure` 必须是闭集（别名先归一）
 *   4. `toolExposure` 必须是 record 且**每个值**都是闭集 → 否则**整条拒绝**
 *   5. `enabled` 必须是 boolean
 *   6. `description` 必须是 string
 *   7. `timeout` 必须是正数
 *   8. `type === "sse"` 明确拒绝（legacy SSE 不支持）
 *   9. `typeof url === "string" && (type 缺省 | "http" | "streamable-http")` → HTTP 分支：
 *      `URL.canParse` + 协议 http/https、`headers` 必须 string→string、
 *      `oauth` 走 `validateOAuth`、`auth` 必须 `{provider: 非空 string}` 且 URL 为
 *      https（或 loopback http）
 *  10. 否则 `typeof command === "string" && (type 缺省 | "stdio")` → stdio 分支：
 *      `args` 必须 string[]、`env` 必须 string→string、`cwd` 必须 string
 *  11. 都不满足 → 拒绝（"needs either command or url"）
 *
 * ⚠️ 两个**与直觉相反**但上游确实如此的细节：
 *   - `{command, url}` **同时存在**时，第 9 条先命中 → 上游把它当 **HTTP** 接受，
 *     不是拒绝（旧的 GUI 实现按「只能二选一」拒绝了它，那是错的）。
 *   - `type` 是未知值时两条分支的 guard 都不成立 → 落到第 11 条拒绝。
 *
 * ---------- 另外两条来自 `readConfigFile()` 的规则 ----------
 *
 *  12. **namespace 冲突**：`mcpNamespace(other) === mcpNamespace(name)` 且
 *      `other !== name`（即名字只在 `-` / `_` 上不同，如 `my-server` vs `my_server`）
 *      → 后者被拒绝。判据是**累积的**：同文件内已接受的名字 + 通过 `takenNames`
 *      传入的、前一个文件（global）已接受的名字。
 *  13. `scope === "project"` 且是 HTTP 且带 `auth` → 拒绝（`auth` 只允许在 global）。
 *
 * ---------- GUI 侧的安全投影（在上游校验通过之后） ----------
 *
 * `hasSecrets` 只记「有没有」（`env` / `headers` / `oauth` / `auth`），值一个字节不留；
 * `exposure` 折成规范值；`description` 单行化 + 限长；`toolExposure` 只留键与枚举值。
 *
 * @param data       解析后的 mcp.json 对象
 * @param scope      `'global' | 'project' | null`（null = 不做 scope 专属规则，独立调用时用）
 * @param takenNames 前一个配置文件里**已被接受**的名字（跨文件 namespace 冲突判定）
 * @returns {{servers: Array, invalid: string[], error: string}}
 */
export function parseMcpServers(data, { scope = null, takenNames = null } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { servers: [], invalid: [], error: 'not-an-object' };
  }
  const table = data.mcpServers;
  if (table === undefined) return { servers: [], invalid: [], error: '' };
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    return { servers: [], invalid: [], error: 'mcpServers-not-an-object' };
  }
  const prior = Array.isArray(takenNames) ? takenNames : [];
  const accepted = []; // 本文件内已接受的名字（供同文件冲突判定）
  const servers = [];
  const invalid = [];

  /** 上游 `readConfigFile` 的冲突判据：别的名字映射到同一个 namespace。 */
  const clashes = (name) => {
    const ns = mcpNamespace(name);
    return prior.some((o) => o !== name && mcpNamespace(o) === ns)
      || accepted.some((o) => o !== name && mcpNamespace(o) === ns);
  };

  for (const [name, raw] of Object.entries(table)) {
    // 1. 名字
    if (!isServerName(name)) {
      invalid.push(`invalid server name "${String(name).slice(0, 80)}" (use letters, digits, "_" and "-")`);
      continue;
    }
    // 2. 必须是对象
    if (!isRecord(raw)) {
      invalid.push(`invalid server "${name}": must be an object`);
      continue;
    }
    // 3. exposure（别名先归一；缺省即 codemode）
    const exposure = raw.exposure === undefined ? DEFAULT_EXPOSURE : normalizeExposure(raw.exposure);
    if (exposure === null) {
      invalid.push(`invalid server "${name}": exposure must be one of ${EXPOSURE_LIST}`);
      continue;
    }
    // 4. toolExposure：整条校验，任一不合法就**拒绝整条**（上游行为）
    let toolExposure = null;
    if (raw.toolExposure !== undefined) {
      if (!isRecord(raw.toolExposure)) {
        invalid.push(`invalid server "${name}": toolExposure must map tool names to exposures`);
        continue;
      }
      const out = {};
      let bad = false;
      for (const [tool, v] of Object.entries(raw.toolExposure)) {
        const exp = normalizeExposure(v);
        if (!exp) {
          invalid.push(`invalid server "${name}": toolExposure "${String(tool).slice(0, 80)}" must be one of ${EXPOSURE_LIST}`);
          bad = true;
          break;
        }
        out[tool] = exp;
      }
      if (bad) continue;
      toolExposure = Object.keys(out).length ? out : null;
    }
    // 5. enabled
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
      invalid.push(`invalid server "${name}": enabled must be a boolean`);
      continue;
    }
    // 6. description
    if (raw.description !== undefined && typeof raw.description !== 'string') {
      invalid.push(`invalid server "${name}": description must be a string`);
      continue;
    }
    // 7. timeout
    if (raw.timeout !== undefined && (typeof raw.timeout !== 'number' || !(raw.timeout > 0))) {
      invalid.push(`invalid server "${name}": timeout must be a positive number of seconds`);
      continue;
    }
    // 8. legacy SSE
    if (raw.type === 'sse') {
      invalid.push(`invalid server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`);
      continue;
    }

    const isHttpType = raw.type === undefined || raw.type === 'http' || raw.type === 'streamable-http';
    const isStdioType = raw.type === undefined || raw.type === 'stdio';
    let transportType = null;

    // 9. HTTP 分支（注意：url 是 string 且 type 允许 http 时**优先于** command）
    if (typeof raw.url === 'string' && isHttpType) {
      if (!isHttpUrl(raw.url)) {
        invalid.push(`invalid server "${name}": url must be an http or https URL`);
        continue;
      }
      if (raw.headers !== undefined && !isStringRecord(raw.headers)) {
        invalid.push(`invalid server "${name}": headers must map names to strings`);
        continue;
      }
      const oauthError = validateOAuthConfig(raw.oauth);
      if (oauthError) {
        invalid.push(`invalid server "${name}": ${oauthError}`);
        continue;
      }
      if (raw.auth !== undefined) {
        if (!isRecord(raw.auth) || typeof raw.auth.provider !== 'string' || !raw.auth.provider) {
          invalid.push(`invalid server "${name}": auth.provider must be a provider name`);
          continue;
        }
        // 13. auth 只允许 https（或 loopback http），且**不允许出现在项目文件里**
        const u = new URL(raw.url);
        if (u.protocol !== 'https:' && !LOOPBACK_HOSTS.includes(u.hostname)) {
          invalid.push(`invalid server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`);
          continue;
        }
        if (scope === 'project') {
          invalid.push(`invalid server "${name}": auth is only allowed in the global mcp.json`);
          continue;
        }
      }
      transportType = 'http';
    } else if (typeof raw.command === 'string' && isStdioType) {
      // 10. stdio 分支
      if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((a) => typeof a === 'string'))) {
        invalid.push(`invalid server "${name}": args must be an array of strings`);
        continue;
      }
      if (raw.env !== undefined && !isStringRecord(raw.env)) {
        invalid.push(`invalid server "${name}": env must map names to strings`);
        continue;
      }
      if (raw.cwd !== undefined && typeof raw.cwd !== 'string') {
        invalid.push(`invalid server "${name}": cwd must be a string`);
        continue;
      }
      transportType = 'stdio';
    } else {
      // 11. 两条分支都不成立
      invalid.push(`invalid server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`);
      continue;
    }

    // 12. namespace 冲突（同文件 + 跨文件）
    if (clashes(name)) {
      invalid.push(`invalid server "${name}": conflicts with another server of the same namespace`);
      continue;
    }

    // ---- 上游校验通过：做 GUI 侧的安全投影 ----
    accepted.push(name);
    const description = typeof raw.description === 'string' ? oneLine(raw.description) : '';
    servers.push({
      name,
      enabled: raw.enabled === undefined ? true : raw.enabled,
      exposure,
      description,
      transportType,
      // secret 面：只记「有没有」，值一个字节都不留。
      hasSecrets: Boolean(
        (raw.env && typeof raw.env === 'object') ||
        (raw.headers && typeof raw.headers === 'object') ||
        (raw.oauth && typeof raw.oauth === 'object') ||
        (raw.auth && typeof raw.auth === 'object'),
      ),
      toolExposure,
      /* 保留字段（前端结构约定）。上游对非法 toolExposure 是**整条拒绝**，
       * 所以这里不会再出现「部分丢弃」的说明，恒为 ''。 */
      toolExposureNote: '',
    });
  }
  return { servers, invalid, error: '' };
}

/** 从 launch identity 派生可执行的 pi 入口（与 bridge 同一份包，无 PATH、无 shim）。 */
export function buildPiEntry(packageDir) {
  if (typeof packageDir !== 'string' || !packageDir) return null;
  try {
    const file = path.join(packageDir, 'package.json');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const bin = pkg && pkg.bin;
    const rel = typeof bin === 'string' ? bin : bin && bin.pi;
    if (typeof rel !== 'string' || !rel) return null;
    const entryPath = path.join(packageDir, rel);
    const ext = path.extname(entryPath).toLowerCase();
    if ((ext !== '.js' && ext !== '.mjs' && ext !== '.cjs') || !fs.statSync(entryPath).isFile()) return null;
    return { ok: true, kind: 'node', cmd: process.execPath, baseArgs: [entryPath], packageDir, version: '', entryPath };
  } catch {
    return null;
  }
}

/**
 * @param runtime            共享运行态
 * @param env                环境变量
 * @param resolvePackageDir  launch identity 包目录
 * @param resolveLaunchIdentity launch identity 的不透明 key（缓存分键用，永不进响应）
 * @param readTrust          () => {trusted, requiresTrust}（可为 async；三值语义）
 * @param rpc                桥接（可选，get_commands 找替代 /mcp）
 * @param runCli             (entry, args, {cwd, timeoutMs}) => Promise<{ok, exitCode, stdout, stderr, timedOut, spawnFailed, error}>
 * @param piBuiltins         (cwd) => built-in 探测结果
 * @param readSettingsExt    () => {disabled: boolean|null}（-builtin:mcp 判定，可注入；缺省自己读）
 * @param onDrift            (source, field, value) => void，可选。**schema 漂移的
 *                           观察出口**（P23）：上游给了一个闭集之外的运行时状态时
 *                           通知一次，由 `pi-compat` 记下「来源 + 字段名 + 类型」。
 *                           默认 null（老调用方 / 单测不受影响）。
 */
export function createMcpNative({
  runtime,
  env = process.env,
  resolvePackageDir = null,
  resolveLaunchIdentity = null,
  readTrust = null,
  rpc = null,
  runCli = null,
  piBuiltins = null,
  readSettingsExt = null,
  onDrift = null,
  now = () => Date.now(),
  ttlMs = STATUS_TTL_MS,
} = {}) {
  const agentDir = agentDirOf(env);
  const homeDir = env.HOME || env.USERPROFILE || null;

  /* ---------- 缓存（绑定 workspace + launch identity） ----------
   *
   * runtime 状态与 replaced 结论都是**「这个 cwd + 这份 pi」**的事实，不是
   * 进程级事实。原先的全局 `statusCache` / `commandsCache` 会把 A 项目的
   * `connected` 与 `replaced=true` 在 60s TTL 内带进 B 项目 —— 用户看到的
   * 是「刚切过去的项目 MCP 全是已连接」，而 B 其实一个都没探过。
   *
   * 修法只有一套真值逻辑：**每次读写前算一次 key，key 不符就当没有缓存**。
   * key = cwd（规范化）+ launch identity 的不透明串。两者任一变化即失效：
   *   - 换项目 → cwd 变 → 旧 runtime/replaced 结论不可见（回到「未刷新」）；
   *   - 换 pi 实例（PI_BIN 改了 / 换了包）→ identity 变 → 同上，且不再复用
   *     「A 的 pi 里 builtin:mcp 被接管」这类结论。
   * TTL 仍在（同一个 key 内 60s 复用）；**不新增任何后台轮询**。
   * 这里存的 key 是**内部比较用**的字符串，不进任何响应。 */
  let statusCache = null; // {key, at, data}
  let commandsCache = null; // {key, at, data}
  let summaryCache = null; // {key, at, data}

  function canonCwd(v) {
    if (typeof v !== 'string' || !v) return '';
    try {
      const n = path.normalize(v);
      return process.platform === 'win32' ? n.toLowerCase() : n;
    } catch {
      return String(v);
    }
  }

  function launchIdentity() {
    try {
      const k = typeof resolveLaunchIdentity === 'function' ? resolveLaunchIdentity() : null;
      return typeof k === 'string' && k ? k : 'no-launch-identity';
    } catch {
      return 'no-launch-identity';
    }
  }

  /** 当前 (cwd, launch identity)。**所有缓存读写都必须先算它。** */
  function workspaceKey() {
    return `${canonCwd(runtime.getCurrentCwd())}\u0000${launchIdentity()}`;
  }

  function cacheHit(entry, key, t) {
    return Boolean(entry) && entry.key === key && t - entry.at < ttlMs;
  }

  function packageDir() {
    try {
      const d = typeof resolvePackageDir === 'function' ? resolvePackageDir() : null;
      return typeof d === 'string' && d ? d : null;
    } catch {
      return null;
    }
  }

  function entry() {
    return buildPiEntry(packageDir());
  }

  function files() {
    const cwd = runtime.getCurrentCwd();
    return {
      cwd,
      user: path.join(agentDir, 'mcp.json'),
      project: cwd ? path.join(cwd, '.pi', 'mcp.json') : null,
    };
  }

  /**
   * 两处 mcp.json 的安全解析。读不到/坏了就按空处理，不抛。
   *
   * **这里只产出「文件里写了什么」这个事实，不产出任何 effective 结论。**
   * 尤其是 `overridden` —— 「项目同名项覆盖用户级」这条上游语义**只在项目
   * 被信任时才成立**（`loadMcpConfig` 只在 `projectTrusted` 时读项目文件，
   * 见 §Blocker A）。trust 在这里还不知道，所以不能在这里决定覆盖关系；
   * 覆盖在 `summary()` 拿到 `tr` 之后算。
   *
   * `projectServers` 之所以能当「**Pi 会接受并加载的 project entry**」用，
   * 靠的是 `parseMcpServers` **完整复刻了上游的校验**（含 `validateMcpServerConfig`
   * 的每一条，以及 `readConfigFile` 的 namespace 冲突规则）—— 不是「结构看起来像」。
   * 上游对每条非法条目是 `errors.push` + `continue`（跳过、从不进那个 Map），
   * 所以被拒的条目**不参与覆盖**，全局同名项保留。
   *
   * 两份文件的读取顺序与上游一致（先 global 后 project），namespace 冲突判据
   * 也是**累积的**：project 里的条目要同时避开 global 已接受的名字与同文件内
   * 已接受的名字。所以这里把 global 的结果作为 `takenNames` 传给 project。
   */
  function readConfigs() {
    const f = files();
    const u = readJsonSafe(f.user);
    const p = f.project ? readJsonSafe(f.project) : { exists: null, data: null, error: '' };
    const up = u.data
      ? parseMcpServers(u.data, { scope: 'global' })
      : { servers: [], invalid: [], error: u.error || '' };
    const pp = p.data
      ? parseMcpServers(p.data, { scope: 'project', takenNames: up.servers.map((s) => s.name) })
      : { servers: [], invalid: [], error: p.error || '' };
    const userServers = up.servers.map((s) => ({ ...s, scope: 'user' }));
    const projectServers = pp.servers.map((s) => ({ ...s, scope: 'project' }));
    return {
      user: { exists: u.exists, error: u.error, invalid: up.invalid, parseError: up.error },
      project: { exists: p.exists, error: p.error, invalid: pp.invalid, parseError: pp.error },
      userServers,
      projectServers,
      // 仍给 refresh() 按 `scope:name` 查配置结构（exposure / hasSecrets / toolExposure）用。
      servers: [...userServers, ...projectServers],
    };
  }

  /**
   * 项目信任状态。**三值**：`true` / `false` / `null`（拿不到）。
   *
   * `null` 不能被当成 `true` —— 写操作与「项目 settings 参不参与」两处都
   * fail closed。真值来源仍是注入的 `readTrust`（与 Skills / extension-registry
   * 同一个），这里不复制第二套判定。
   */
  async function trust() {
    try {
      const t = typeof readTrust === 'function' ? await readTrust() : null;
      if (t && typeof t === 'object') {
        const tri = (v) => (v === true ? true : v === false ? false : null);
        return { trusted: tri(t.trusted), requiresTrust: tri(t.requiresTrust) };
      }
    } catch {
      /* 拿不到就按未知处理 */
    }
    return { trusted: null, requiresTrust: null };
  }

  /** 项目级资源是否参与生效判定。`true` 只在**确证**信任时才给。 */
  function projectTrusted(tr) {
    return Boolean(tr) && tr.trusted === true;
  }

  /** 未确证信任时的原因码（写操作与 effective 共用一套词汇）。 */
  function untrustedReason(tr) {
    return tr && tr.trusted === false ? 'untrusted' : 'trust-unknown';
  }

  /**
   * settings.json 的 extensions 数组里有没有 `-builtin:mcp`（项目覆盖用户）。
   *
   * **项目 `.pi/settings.json` 只在项目被信任（`trusted === true`）时才参与** ——
   * pi 在非交互模式下压根不读未信任项目的配置，GUI 若拿它下结论，就会出现
   * 「界面说 builtin:mcp 被禁用、pi 其实用得好好的」这种凭空断言。
   * 用户级 settings 与信任无关，照读。
   *
   * `readSettingsExt` 是显式注入的判定（单测用），它一旦给出结论就代表
   * 调用方已经处理过 trust，这里不再二次过滤。
   */
  function disabledBySettings(tr) {
    if (typeof readSettingsExt === 'function') {
      try {
        const r = readSettingsExt();
        if (r && typeof r.disabled === 'boolean') return r.disabled;
        if (r && r.disabled === null) return null;
      } catch {
        return null;
      }
    }
    try {
      const pick = (data) => {
        if (!data || !Array.isArray(data.extensions)) return null;
        let off = null;
        for (const e of data.extensions) {
          if (e === '-builtin:mcp') off = true;
          else if (e === '+builtin:mcp') off = false;
        }
        return off;
      };
      const u = readJsonSafe(path.join(agentDir, 'settings.json'));
      const pu = u.data ? pick(u.data) : null;
      const cwd = runtime.getCurrentCwd();
      let pp = null;
      if (cwd && projectTrusted(tr)) {
        const ps = readJsonSafe(path.join(cwd, '.pi', 'settings.json'));
        pp = ps.data ? pick(ps.data) : null;
      }
      // 项目覆盖用户（pi 原语）；两边都没写 → null（不是 false）。
      if (pp !== null) return pp;
      if (pu !== null) return pu;
      return null;
    } catch {
      return null;
    }
  }

  /** 替代 builtin 的扩展：get_commands 里找 source=extension 的 mcp 命令。
   *
   * 缓存同样按 (cwd, launch identity) 分键 —— 「A 项目里 /mcp 被扩展接管」
   * 是 A 的 session 事实，切到 B 之后必须重新 probe，不能把 `replaced=true`
   * 带过去（那会让 B 的 MCP 页凭空说「被接管」）。 */
  async function replacedProbe() {
    const t = now();
    const key = workspaceKey();
    if (cacheHit(commandsCache, key, t)) return commandsCache.data;
    let data = { replaced: null, checked: false };
    try {
      if (rpc && typeof rpc.request === 'function') {
        const res = await rpc.request({ type: 'get_commands' });
        const list = res && Array.isArray(res.commands) ? res.commands : null;
        if (list) {
          const hit = list.find((c) => c && c.source === 'extension' && /^mcp(?::\d+)?$/.test(String(c.name || '')));
          data = { replaced: Boolean(hit), checked: true };
        }
      }
    } catch {
      data = { replaced: null, checked: false };
    }
    commandsCache = { key, at: t, data };
    return data;
  }

  function builtins() {
    try {
      const cwd = runtime.getCurrentCwd();
      const b = typeof piBuiltins === 'function' ? piBuiltins(cwd) : null;
      if (!b || !Array.isArray(b.builtins)) return { present: null };
      return { present: b.builtins.some((e) => e && e.id === 'mcp') };
    } catch {
      return { present: null };
    }
  }

  /** native 状态机：只认三份证据，缺一律 unknown，不猜。
   *  `tr` 由调用方传入（summary 已经算过一次），避免同一请求里重复问 trust。 */
  async function nativeState(tr = null) {
    const trs = tr || (await trust());
    const [rep, bi] = [await replacedProbe(), builtins()];
    const dis = disabledBySettings(trs);
    if (rep.replaced === true) {
      return { state: 'replaced', replaced: true, disabled: dis, builtinPresent: bi.present, reason: '扩展注册了 /mcp，接管了内置 MCP（以 get_commands 为证）' };
    }
    if (dis === true) {
      return { state: 'disabled', replaced: false, disabled: true, builtinPresent: bi.present, reason: 'settings 的 extensions 关掉了 builtin:mcp' };
    }
    if (bi.present === true && rep.replaced === false && dis !== true) {
      // `disabled` 保持三值：settings 里显式 +builtin:mcp → false；压根没写 → null。
      // 不把「没写」说成「没禁用」—— 那是同一类凭空断言。
      return { state: 'active', replaced: false, disabled: dis, builtinPresent: true, reason: 'builtin:mcp 在包里、未被禁用、未被接管' };
    }
    if (bi.present === false) {
      return { state: 'unsupported', replaced: false, disabled: dis, builtinPresent: false, reason: '这个 pi 包里没有 builtin:mcp' };
    }
    return { state: 'unknown', replaced: rep.replaced, disabled: dis, builtinPresent: bi.present, reason: '证据不足（包读不到或 pi 未应答），不断言' };
  }

  /**
   * 把 `pi mcp list --json` 的一条 server 投影成**白名单事实**。
   *
   * 逐项 allowlist（P20.6-Fix §五），上游新增字段默认**丢弃**：
   *   - `state`：不在闭集里 → `'unknown'`（绝不把任意上游字符串原样放进 DOM）
   *   - `scope`：只认 global / project / extension，其余 → null
   *   - `exposure`：只认 0.99.2 闭集（含别名归一），其余 → null
   *   - `transport`：只留类型面，**原文（命令 / URL）永不进报告**
   *   - `tools`：**raw MCP tool name**，走 `sanitizeMcpRawToolName`（安全文本边界，
   *     不是字符集白名单）+ 数量上限；`toolCount` 是上游合法字符串项的数量
   *   - `toolExposure`：键是 raw tool name（同样只做单行化 + 限长）、值限枚举
   *   - `resources` / `resourceTemplates`：非负整数，否则 null
   *   - `error`：截断 + 路径脱敏
   *   - `source`（绝对路径）/ `command` / `url` / `headers` / `env`：**一律不取**
   */
  function projectRuntimeServer(s, f) {
    if (!s || typeof s !== 'object') return null;
    // 运行时报告里的 server 名同样按上游规则判定（不限长度；payload 已被 stdout 上限约束）。
    if (!isServerName(s.name)) return null;
    /* ---------- tools：raw MCP tool name（Blocker B） ----------
     *
     * `toolCount` 是**上游事实**：server 报了几个工具（合法字符串项的数量）。
     * 它**不因字符集**减少 —— 名字里带 `-` / 空格 / Unicode 不是「少一个工具」。
     * `tools` 是**有界的安全展示列表**：单行化 + 限长 + 截断到 MAX_TOOLS。
     * 两者在极端情况下可以不等（例如一个纯控制字符的名字没有可展示形态），
     * 这是有意的：数量说事实，列表说能安全显示的部分。 */
    const rawTools = Array.isArray(s.tools) ? s.tools : null;
    const stringTools = rawTools ? rawTools.filter((x) => typeof x === 'string') : null;
    const tools = stringTools
      ? stringTools.map(sanitizeMcpRawToolName).filter(Boolean).slice(0, MAX_TOOLS)
      : null;
    let toolExposure = null;
    if (s.toolExposure && typeof s.toolExposure === 'object' && !Array.isArray(s.toolExposure)) {
      const out = {};
      for (const [k, v] of Object.entries(s.toolExposure)) {
        // 键也是 raw tool name —— 同样只做安全文本边界，不套标识符正则。
        const key = sanitizeMcpRawToolName(k);
        if (!key) continue;
        const exp = normalizeExposure(v);
        if (exp) out[key] = exp;
      }
      toolExposure = Object.keys(out).length ? out : null;
    }
    const count = (v) => (Number.isInteger(v) && v >= 0 && v <= 100000 ? v : null);
    /* 运行时状态不在闭集里 → 折成 unknown（**绝不把上游任意字符串放进 DOM**），
     * 同时让 schema 漂移可见。只报字段名与类型，不报那个值。 */
    const rawState = typeof s.state === 'string' ? s.state : null;
    const stateKnown = rawState !== null && RUNTIME_STATES.has(rawState);
    if (rawState !== null && !stateKnown && typeof onDrift === 'function') {
      try {
        onDrift('mcp-runtime', 'server.state', rawState);
      } catch {
        /* 漂移记录不该影响投影本身 */
      }
    }
    /* exposure 同理：认不出来的值折成 null（界面显示「未知」），
     * 但让「上游多了一个 exposure 取值」这件事可见。 */
    const exposure = normalizeExposure(s.exposure);
    if (typeof s.exposure === 'string' && exposure === null && typeof onDrift === 'function') {
      try {
        onDrift('mcp-runtime', 'server.exposure', s.exposure);
      } catch {
        /* 同上 */
      }
    }
    return {
      name: s.name,
      scope: typeof s.scope === 'string' && RUNTIME_SCOPES.has(s.scope)
        ? (s.scope === 'global' ? 'user' : s.scope)
        : null,
      enabled: typeof s.enabled === 'boolean' ? s.enabled : null,
      exposure,
      // transport 原文含命令路径/URL，只留类型面。
      transportType: typeof s.transport === 'string' && /^https?:\/\//.test(s.transport) ? 'http'
        : typeof s.transport === 'string' && s.transport ? 'stdio' : null,
      state: stateKnown ? rawState : 'unknown',
      // 数量说事实（上游合法字符串项），列表说有界的安全展示面。
      toolCount: stringTools ? stringTools.length : null,
      tools,
      toolExposure,
      resources: count(s.resources),
      resourceTemplates: count(s.resourceTemplates),
      error: typeof s.error === 'string' && s.error ? redactPaths(clip(s.error), { cwd: f.cwd, agentDir, homeDir }) : '',
    };
  }

  /** 跑一次 `pi mcp list --json`（官方结构化输出）。只允许显式刷新调用。 */
  async function runListJson() {
    const e = entry();
    const cwd = runtime.getCurrentCwd();
    if (!e || typeof runCli !== 'function') {
      return { ok: false, code: !e ? 'no-proven-entry' : 'no-runner', error: !e ? '证明不了 bridge 正在跑哪份 pi，不代它执行（未知≠没有）' : '执行器不可用' };
    }
    let r;
    try {
      r = await runCli(e, ['mcp', 'list', '--json'], { cwd, timeoutMs: TIMEOUT_LIST_MS });
    } catch (err) {
      return { ok: false, code: 'spawn-failed', error: clip(String((err && err.message) || err), 200) };
    }
    if (!r || r.spawnFailed) return { ok: false, code: 'spawn-failed', error: clip((r && r.error) || '无法启动 pi', 200) };
    if (r.timedOut) return { ok: false, code: 'list-timeout', error: '等待 pi 响应超时（30s），部分 server 可能还没连上' };
    let parsed = null;
    try {
      parsed = JSON.parse(String(r.stdout || ''));
    } catch {
      return { ok: false, code: 'bad-json', error: 'pi 的输出不是合法 JSON（不解析人类文本）' };
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.servers)) {
      return { ok: false, code: 'bad-shape', error: 'pi 的输出形状不认识（不猜）' };
    }
    const f = files();
    const servers = parsed.servers.map((s) => projectRuntimeServer(s, f)).filter(Boolean);
    const errors = Array.isArray(parsed.errors)
      ? parsed.errors.filter((x) => typeof x === 'string').slice(0, 20).map((x) => redactPaths(clip(x), { cwd: f.cwd, agentDir, homeDir }))
      : [];
    /* `note`：pi 在「项目未信任 → 项目 mcp.json 被忽略」时给的一句人类可读说明。
     * 它本身含绝对路径，所以照错误文本一样脱敏 + 截断。 */
    const note = typeof parsed.note === 'string' && parsed.note
      ? redactPaths(clip(parsed.note), { cwd: f.cwd, agentDir, homeDir })
      : '';
    return { ok: true, code: '', error: '', servers, errors, note, exitCode: r.exitCode };
  }

  /** 轻量摘要：不 spawn，只读配置 + 内置 probe。每次 GET /api/mcp/servers 都带它。
   *
   * 摘要本身是**实时算**的（读文件，不跑 pi），所以不参与 TTL；但 `peekSummary`
   * 拿的是上一次的结果，那个必须绑定 workspace（见 peekSummary）。 */
  async function summary() {
    const key = workspaceKey();
    const cfg = readConfigs();
    const tr = await trust();
    const nat = await nativeState(tr);
    /* ---------- 覆盖关系（effective truth，受 trust 约束） ----------
     *
     * 上游 `loadMcpConfig`（0.99.2 `mcp/config.ts`）：
     *   readConfigFile(global)            // 总是读
     *   if (projectTrusted) readConfigFile(project)   // 只在信任时读
     * 两份都往同一个 `Map<name, entry>` 里 `set`，所以「项目同名覆盖用户级」
     * **只在项目被信任时才发生**。
     *
     * 因此「项目文件里有没有这个 key」≠「用户级那条被覆盖了」：
     *   - trusted === true  → 项目同名项参与覆盖
     *   - trusted === false → 项目文件被 pi 整个忽略，用户级照旧生效
     *   - trusted === null  → 同上，fail closed（不能拿未知当已加载）
     *
     * 只有 `projectServers`（= `parseMcpServers` 认可的条目）才进这个集合 ——
     * 非法 project entry 被上游 `readConfigFile` 的 `continue` 跳过，不覆盖全局项。
     */
    const loadableProjectNames = projectTrusted(tr)
      ? new Set(cfg.projectServers.map((s) => s.name))
      : new Set();

    const servers = cfg.servers.map((s) => {
      /* 项目条目只有**确证信任**时才按「生效」算。`false` 与「拿不到」（null）
       * 都 fail closed —— 与写操作的闸门同一条规则，理由也一样：pi 在非交互
       * 模式下不读未信任项目的 mcp.json，界面不该替它说「生效中」。 */
      const projectBlocked = s.scope === 'project' && !projectTrusted(tr);
      // 用户级被覆盖，只在项目**确实会被加载**时才成立。
      const overridden = s.scope === 'user' && loadableProjectNames.has(s.name);
      const effective = projectBlocked
        ? { active: false, reason: untrustedReason(tr) }
        : { active: Boolean(s.enabled) && !overridden, reason: overridden ? 'overridden' : (s.enabled ? '' : 'disabled') };
      if (nat.state === 'replaced') {
        effective.active = false;
        effective.reason = 'replaced';
      } else if (nat.state === 'disabled' || nat.state === 'unsupported') {
        effective.active = false;
        effective.reason = nat.state;
      }
      return { ...s, overridden, effective };
    });
    summaryCache = {
      key,
      at: now(),
      data: {
        fresh: true,
        at: new Date(now()).toISOString(),
        native: nat,
        // 三值：true / false / null（拿不到）。null 不是 false，也不是 true。
        trust: tr.trusted === null ? null : tr,
        servers,
        configInvalid: [...cfg.user.invalid, ...cfg.project.invalid],
        configError: { user: cfg.user.parseError || cfg.user.error, project: cfg.project.parseError || cfg.project.error },
      },
    };
    return summaryCache.data;
  }

  /** 同步看一眼上次算出的摘要（给 /api/mcp 这种同步报告用）。
   *  **必须绑定 workspace** —— 换项目后旧摘要里的 trust / effective 都不再成立。 */
  function peekSummary() {
    if (!summaryCache || summaryCache.key !== workspaceKey()) return null;
    return summaryCache.data;
  }

  /** 显式刷新：跑 list --json 并进 60s 缓存（缓存绑定 workspace + launch identity）。 */
  async function refresh() {
    const t = now();
    const key = workspaceKey();
    if (cacheHit(statusCache, key, t)) return { ...statusCache.data, cached: true };
    const cfg = readConfigs();
    const byKey = new Map(cfg.servers.map((s) => [`${s.scope}:${s.name}`, s]));
    const r = await runListJson();
    const data = {
      at: new Date(t).toISOString(),
      cached: false,
      ok: r.ok,
      code: r.code || '',
      error: r.error || '',
      errors: r.errors || [],
      note: r.note || '',
      exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
      servers: (r.servers || []).map((s) => {
        const c = byKey.get(`${s.scope}:${s.name}`) || byKey.get(`user:${s.name}`) || null;
        return {
          ...s,
          // exposure 以运行时为准，拿不到才退回配置。
          exposure: s.exposure || (c ? c.exposure : null),
          hasSecrets: c ? c.hasSecrets : null,
          toolExposure: s.toolExposure || (c ? c.toolExposure : null),
          configured: Boolean(c),
        };
      }),
    };
    statusCache = { key, at: t, data };
    return data;
  }

  /** 上一次刷新的运行时状态 —— 只在**同一个 workspace**里才给。 */
  function peekStatus() {
    if (!statusCache || statusCache.key !== workspaceKey()) return null;
    return { ...statusCache.data, cached: true };
  }

  /** 清空所有派生结论（runtime / replaced / 摘要）。动作成功与显式 reset 都走这里。 */
  function reset() {
    statusCache = null;
    commandsCache = null;
    summaryCache = null;
  }

  /* ---------- 受控动作 ---------- */

  function staleGuard(body) {
    // 前端按仓库惯例发 `__expectedCwd`（见 saveProjectConfig）；兼容直写的 expectedCwd。
    const raw = body && (body.__expectedCwd !== undefined ? body.__expectedCwd : body.expectedCwd);
    const expected = typeof raw === 'string' ? raw : null;
    const cur = runtime.getCurrentCwd();
    if (!expected || expected !== cur) {
      return { ok: false, code: 'workspace-stale', error: '项目已切换，这次操作作废（请在当前项目上重试）' };
    }
    return null;
  }

  function checkName(name) {
    // 动作入参：上游字符集 + GUI 侧 64 字符上限（输入侧防御，不是配置判定规则）。
    if (!isActionName(name)) {
      return { ok: false, code: 'bad-name', error: `server 名只允许字母、数字、_ 和 -（1–${ACTION_NAME_MAX} 字符）` };
    }
    return null;
  }

  function checkScope(scope) {
    if (scope !== 'user' && scope !== 'project') {
      return { ok: false, code: 'bad-scope', error: 'scope 只能是 user 或 project' };
    }
    return null;
  }

  function checkExposure(exposure) {
    // 输入侧接受 0.99.2 的规范闭集 + `codemode-deferred` 别名（pi 自己也是这么收的）。
    if (exposure !== undefined && !normalizeExposure(exposure)) {
      return { ok: false, code: 'bad-exposure', error: 'exposure 必须是 codemode / deferred / direct / hidden（codemode-deferred 是 codemode 的别名）' };
    }
    return null;
  }

  const str = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0') ? v : null);

  /* ---------- secret contract（P20.6-Fix §三） ----------
   *
   * GUI 的 MCP 添加接口**只接受不含 secret value 的配置**。这条不是靠前端
   * 「表单里没有输入框」保证的 —— 后端在这里防御式校验，任何携带 credential
   * 值的 payload 在 HTTP 边界就被拒，**不进 argv**。
   *
   * 为什么必须堵死源头：`runCli` 把 stderr / stdout 尾巴回显进错误文案
   * （`pi-error` 分支）。我们无法假设 pi 永远不回显敏感 argv；既然 GUI 不再
   * 传 secret argv，这条风险就从源头消失了 —— 而不是靠「响应里不打印」。
   *
   * 允许保留的只有**引用名**：`bearerTokenEnvVar: "GITHUB_TOKEN"`。pi 会把它
   * 写成 `Authorization: Bearer ${GITHUB_TOKEN}`，值由 pi 在**运行时**从环境里取，
   * 从不经过 renderer / HTTP / GUI 进程。
   *
   * 带凭据的 server 一律走终端 `pi mcp add` 或直接编辑 mcp.json。 */

  /** 出现 secret 面就拒。`field` 只报**字段名**，绝不回显值。 */
  function secretRejected(field) {
    return {
      ok: false,
      code: 'secret-input-unsupported',
      field,
      error: `Pi GUI 不接受凭据值（${field}）。含 env / headers / OAuth / auth 的 server 请在终端跑 \`pi mcp add\`，或直接编辑 pi 的 mcp.json —— 凭据值不进 Pi GUI。`,
    };
  }

  /**
   * 扫描 add payload 里所有 credential 面。
   * 返回 null 表示干净；否则返回拒绝结果。
   */
  function scanSecrets(b) {
    // 1. headers：只允许「没有 value」的形态存在。任何 value 都算 credential。
    if (b.headers !== undefined) {
      if (Array.isArray(b.headers)) {
        for (const h of b.headers) {
          if (!h || typeof h !== 'object') return secretRejected('headers[]');
          if (h.value !== undefined && h.value !== null && String(h.value) !== '') return secretRejected('headers[].value');
          if (h.key !== undefined && h.key !== null && String(h.key) !== '') return secretRejected('headers[].key');
        }
      } else if (b.headers && typeof b.headers === 'object') {
        return secretRejected('headers');
      } else {
        return secretRejected('headers');
      }
    }
    // 2. env：同上，值就是 secret。
    if (b.env !== undefined) {
      if (Array.isArray(b.env)) {
        for (const p of b.env) {
          if (!p || typeof p !== 'object') return secretRejected('env[]');
          if (p.value !== undefined && p.value !== null && String(p.value) !== '') return secretRejected('env[].value');
          if (p.key !== undefined && p.key !== null && String(p.key) !== '') return secretRejected('env[].key');
        }
      } else {
        return secretRejected('env');
      }
    }
    // 3. OAuth 整块（clientSecret 是明确的凭据；clientId / callbackUrl / scope /
    //    clientName 也是只能由 pi 官方 CLI 或手改文件写入的配置，GUI 没有对应 UI）。
    if (b.oauth !== undefined) {
      if (!b.oauth || typeof b.oauth !== 'object') return secretRejected('oauth');
      if (b.oauth.clientSecret !== undefined) return secretRejected('oauth.clientSecret');
      return secretRejected('oauth');
    }
    // 4. 0.99.2 新增的 `auth: { provider }` —— 它让 pi 把某个 provider 的
    //    `/login` token 当 bearer 发出去，是明确的凭据面。
    if (b.auth !== undefined) return secretRejected('auth');
    // 5. 常见「换个名字再传一遍」的凭据字段。宁可误拒也不放过。
    for (const k of ['token', 'accessToken', 'refreshToken', 'bearerToken', 'apiKey', 'apikey', 'secret', 'password', 'authorization', 'Authorization']) {
      if (b[k] !== undefined && b[k] !== null && String(b[k]) !== '') return secretRejected(k);
    }
    return null;
  }

  /** 项目级写操作的 trust gate。**fail closed**：拿不到信任就不执行。 */
  async function trustGate(scope) {
    if (scope !== 'project') return null;
    const tr = await trust();
    if (projectTrusted(tr)) return null;
    const unknown = tr.trusted !== false;
    return {
      ok: false,
      code: 'project-untrusted',
      error: unknown
        ? '项目信任状态无法确认，已拒绝修改项目级 MCP 配置（fail closed）。请在 pi 里打开这个项目并完成信任确认后重试；用户级配置不受影响。'
        : '当前项目未被信任，pi 在非交互模式下不会读它的 .pi/mcp.json，所以不允许在这里改项目级 MCP 配置。请在 pi 里信任这个项目后重试；用户级配置不受影响。',
    };
  }

  async function runMcpAction(action, argv, { cwd, timeoutMs }) {
    const e = entry();
    if (!e) return { ok: false, code: 'no-proven-entry', error: '证明不了 bridge 正在跑哪份 pi，不代它执行（未知≠没有）' };
    if (typeof runCli !== 'function') return { ok: false, code: 'no-runner', error: '执行器不可用' };
    let r;
    try {
      r = await runCli(e, argv, { cwd, timeoutMs });
    } catch (err) {
      return { ok: false, code: 'spawn-failed', error: clip(String((err && err.message) || err), 200) };
    }
    if (!r || r.spawnFailed) return { ok: false, code: 'spawn-failed', error: clip((r && r.error) || '无法启动 pi', 200) };
    if (r.timedOut) {
      return {
        ok: false,
        code: action === 'login' ? 'login-timeout' : 'timeout',
        error: action === 'login'
          ? '等待浏览器回调超时。请在终端跑 `pi mcp login <server>`（可等更久），成功后点刷新状态'
          : '等待 pi 响应超时',
      };
    }
    if (r.exitCode !== 0) {
      const f = files();
      const tail = clip(String(r.stderr || r.stdout || ''), 300);
      return { ok: false, code: 'pi-error', error: redactPaths(tail, { cwd: f.cwd, agentDir, homeDir }) || `pi 退出码 ${r.exitCode}` };
    }
    return { ok: true, code: '', error: '' };
  }

  async function actAdd(b) {
    const bad = checkName(b.name) || checkScope(b.scope) || checkExposure(b.exposure);
    if (bad) return bad;
    /* 顺序有意：secret 扫描在 trust gate 之前 —— 带凭据的 payload 无论项目
     * 信任与否都不该被接受，报的也应该是更准确的那个原因。两者都**不调 runCli**。 */
    const secret = scanSecrets(b);
    if (secret) return secret;
    const gate = await trustGate(b.scope);
    if (gate) return gate;
    const argv = ['mcp', 'add', b.name];
    if (b.scope === 'project') argv.push('-l');
    if (b.exposure !== undefined) argv.push('--exposure', normalizeExposure(b.exposure));
    /* `description`（0.99.2 新增，`pi mcp add --description`）：纯文本、非凭据，
     * 所以可以安全接收。界面暂不暴露输入框（本轮不改布局），字段留给 API 调用方。
     *
     * **必须放在 `--` 之前**：pi 的 `parseOptions` 一旦遇到 `--` 就把剩下的
     * 全部当成 positionals（= stdio 的 command 与 args），放后面会被当成命令参数。 */
    if (b.description !== undefined) {
      const desc = typeof b.description === 'string' ? oneLine(b.description) : '';
      if (!desc) return { ok: false, code: 'bad-description', error: 'description 必须是非空单行文本' };
      argv.push('--description', desc);
    }
    if (b.transport === 'http' || (b.transport === undefined && typeof b.url === 'string')) {
      const url = str(b.url, 2048);
      let okUrl = false;
      try {
        const u = new URL(url);
        okUrl = u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        okUrl = false;
      }
      if (!url || !okUrl) return { ok: false, code: 'bad-url', error: 'http server 需要合法的 http(s) url' };
      argv.push('--url', url);
      // 这里已经没有 header / oauth / auth 可加 —— scanSecrets 已经全拒了。
      // 唯一保留的是**引用名**：argv 里只有变量名，没有值。
      if (b.bearerTokenEnvVar !== undefined) {
        if (typeof b.bearerTokenEnvVar !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(b.bearerTokenEnvVar)) {
          return { ok: false, code: 'bad-env-var', error: 'bearerTokenEnvVar 必须是环境变量名（只传名字，值由 pi 运行时从环境里取）' };
        }
        argv.push('--bearer-token-env-var', b.bearerTokenEnvVar);
      }
    } else if (b.transport === 'stdio' || b.transport === undefined) {
      const command = str(b.command, 512);
      if (!command) return { ok: false, code: 'bad-command', error: 'stdio server 需要 command（单个可执行文件，不是 shell 串）' };
      const args = Array.isArray(b.args) ? b.args : [];
      if (args.length > 32 || args.some((a) => typeof a !== 'string' || a.length > 1024 || a.includes('\0'))) {
        return { ok: false, code: 'bad-args', error: 'args 必须是字符串数组（≤32 项，每项 ≤1024 字符）' };
      }
      if (b.cwd !== undefined) {
        if (!str(b.cwd, 512)) return { ok: false, code: 'bad-cwd', error: 'cwd 不合法' };
        argv.push('--cwd', b.cwd);
      }
      argv.push('--', command, ...args);
    } else {
      return { ok: false, code: 'bad-transport', error: 'transport 只能是 stdio 或 http' };
    }
    if (argv.length > MAX_ARGV_ITEMS) return { ok: false, code: 'bad-request', error: '参数过多' };
    const r = await runMcpAction('add', argv, { cwd: runtime.getCurrentCwd(), timeoutMs: TIMEOUT_WRITE_MS });
    if (!r.ok) return r;
    reset();
    return { ok: true, code: '', error: '', name: b.name, scope: b.scope };
  }

  async function actRemove(b) {
    const bad = checkName(b.name) || checkScope(b.scope);
    if (bad) return bad;
    const gate = await trustGate(b.scope);
    if (gate) return gate;
    const argv = ['mcp', 'remove', b.name];
    if (b.scope === 'project') argv.push('-l');
    const r = await runMcpAction('remove', argv, { cwd: runtime.getCurrentCwd(), timeoutMs: TIMEOUT_WRITE_MS });
    if (!r.ok) return r;
    reset();
    // remove 不删 OAuth 凭据（pi 原语）—— 必须明说，否则用户以为退干净了。
    return { ok: true, code: '', error: '', name: b.name, scope: b.scope, note: '已移除配置；已存的 OAuth 凭据保留，如需清掉请 logout' };
  }

  async function actLogin(b) {
    const bad = checkName(b.name);
    if (bad) return bad;
    let secs = TIMEOUT_LOGIN_DEFAULT_S;
    if (b.timeoutSec !== undefined) {
      if (!Number.isInteger(b.timeoutSec) || b.timeoutSec < 10 || b.timeoutSec > TIMEOUT_LOGIN_MAX_S) {
        return { ok: false, code: 'bad-timeout', error: `timeoutSec 只能是 10–${TIMEOUT_LOGIN_MAX_S}` };
      }
      secs = b.timeoutSec;
    }
    const r = await runMcpAction('login', ['mcp', 'login', b.name, '--timeout', String(secs)], {
      cwd: runtime.getCurrentCwd(),
      timeoutMs: (secs + 10) * 1000,
    });
    if (!r.ok) return r;
    reset();
    return { ok: true, code: '', error: '', name: b.name };
  }

  async function actLogout(b) {
    const bad = checkName(b.name);
    if (bad) return bad;
    const r = await runMcpAction('logout', ['mcp', 'logout', b.name], { cwd: runtime.getCurrentCwd(), timeoutMs: TIMEOUT_WRITE_MS });
    if (!r.ok) return r;
    reset();
    return { ok: true, code: '', error: '', name: b.name };
  }

  /* ---------- HTTP ---------- */

  function handleStatus(req, res) {
    if (req.method === 'POST') {
      return readBody(req)
        .then(async (raw) => {
          let body = {};
          try {
            body = JSON.parse(raw || '{}');
          } catch {
            return json(res, 400, { ok: false, code: 'bad-json', error: '请求体不是合法 JSON' });
          }
          const stale = staleGuard(body);
          if (stale) return json(res, 409, stale);
          try {
            const data = await refresh();
            return json(res, 200, { ok: true, ...data });
          } catch (err) {
            return json(res, 200, { ok: false, code: 'refresh-failed', error: clip(String((err && err.message) || err), 200) });
          }
        })
        .catch((err) => json(res, 500, { ok: false, code: 'read-failed', error: String((err && err.message) || err).slice(0, 200) }));
    }
    if (req.method === 'GET') {
      try {
        // peekStatus 自带 workspace 守卫：换了项目就是 null（未刷新），不是旧项目的状态。
        return json(res, 200, { ok: true, status: peekStatus() });
      } catch (err) {
        return json(res, 500, { ok: false, code: 'read-failed', error: String((err && err.message) || err).slice(0, 200) });
      }
    }
    return json(res, 405, { ok: false, code: 'method-not-allowed', error: 'Method not allowed' });
  }

  function handleServers(req, res) {
    if (req.method === 'GET') {
      return (async () => {
        try {
          const s = await summary();
          return json(res, 200, { ok: true, ...s, runtime: peekStatus() });
        } catch (err) {
          return json(res, 500, { ok: false, code: 'read-failed', error: String((err && err.message) || err).slice(0, 200) });
        }
      })();
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method-not-allowed', error: 'Method not allowed' });
    return readBody(req)
      .then(async (raw) => {
        let body;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          return json(res, 400, { ok: false, code: 'bad-json', error: '请求体不是合法 JSON' });
        }
        if (!body || typeof body !== 'object') return json(res, 400, { ok: false, code: 'bad-json', error: '请求体不是合法 JSON' });
        const stale = staleGuard(body);
        if (stale) return json(res, 409, stale);
        const action = body.action;
        if (action !== 'add' && action !== 'remove' && action !== 'login' && action !== 'logout') {
          // enable / disable / reconnect / 改 exposure 没有官方自动化接口 ——
          // Saw：/mcp TUI 里做。这里不猜一个 code，不编一个假动作。
          return json(res, 400, {
            ok: false,
            code: 'unsupported-action',
            error: '只支持 add / remove / login / logout；enable / disable / reconnect / 改 exposure 请用 pi 的 /mcp 管理器（TUI）',
          });
        }
        try {
          const r = action === 'add' ? await actAdd(body)
            : action === 'remove' ? await actRemove(body)
            : action === 'login' ? await actLogin(body)
            : await actLogout(body);
          /* 响应里永不回显 secret 面：含凭据的 payload 在 actAdd 里就被拒了
           * （secret-input-unsupported），拒绝文案只带**字段名**，不带值。
           * 成功时也只回 name / scope / note。 */
          if (!r.ok) {
            const { code, error, field } = r;
            return json(res, 200, field ? { ok: false, code, error, field } : { ok: false, code, error });
          }
          const { name, scope, note } = r;
          return json(res, 200, { ok: true, code: '', error: '', name, scope, note });
        } catch (err) {
          return json(res, 200, { ok: false, code: 'action-failed', error: clip(String((err && err.message) || err), 200) });
        }
      })
      .catch((err) => json(res, 500, { ok: false, code: 'read-failed', error: String((err && err.message) || err).slice(0, 200) }));
  }

  return {
    handleStatus,
    handleServers,
    summary,
    refresh,
    peekStatus,
    peekSummary,
    reset,
    /** 内部件：单测用。只暴露纯函数，不暴露任何状态。 */
    _internals: {
      parseMcpServers,
      buildPiEntry,
      projectRuntimeServer,
      normalizeExposure,
      sanitizeMcpRawToolName,
      scanSecrets,
      // 上游校验原语（单测直接对拍用）
      isServerName,
      isActionName,
      mcpNamespace,
      validateOAuthConfig,
      isHttpUrl,
      EXPOSURES,
      RUNTIME_STATES,
      RUNTIME_SCOPES,
    },
  };
}
