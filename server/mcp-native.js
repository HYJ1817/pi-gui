/* P20.6 Native MCP 状态与受控动作 —— 用 pi 原生的 MCP，不自建 client runtime。
 *
 * ---------- 这个模块是什么 ----------
 *
 * P20.5 的 `/api/mcp` 只是一份能力报告（包里带不带 `builtin:mcp`、配置文件在不在、
 * `servers` 恒为空）。这一层把它升级成真实集成，但**只用 pi 官方的路**：
 *
 *   1. **状态**：`pi mcp list --json`（官方结构化输出，实测形状
 *      `{servers:[{name,scope,source,enabled,exposure,transport,state,tools[],error?}],errors:[]}`，
 *      状态词汇 `connecting/connected/needs-auth/disconnected/disabled/failed`）。
 *      人类文本（`pi mcp list` 裸输出、`/mcp` TUI）**绝不解析** —— 文案不是 API。
 *   2. **配置 scope**：安全解析两处 `mcp.json`（只取结构：名 / scope / enabled /
 *      exposure / transport 类型 / toolExposure 键；`env` / `headers` / `oauth` 的
 *      **值一个字节都不进报告**）。`mcp-auth.json` 的 token **绝不读**。
 *   3. **动作**：只代理 pi 官方 shell CLI（add / remove / login / logout）。
 *      enable / disable / reconnect / 改 exposure **没有** shell 接口
 *      （实测 `pi mcp --help` 只有上述五个）→ 本轮 unsupported，指引 `/mcp` TUI，
 *      不手改 JSON 伪装成官方 manager。
 *
 * ---------- 三条硬边界 ----------
 *
 * - **跑的必须是 bridge 正在跑的那份 pi。** 入口从 `resolvePackageDir()`
 *   （launch identity）派生：`<packageDir>/<bin.pi>`（实测 `dist/bundle/cli.js`）
 *   + `process.execPath`，`shell:false` + args 数组。`packageDir` 证明不了
 *   （null）→ 状态 unknown、动作 unsupported —— **不退回裸 `pi`**，那会命中
 *   另一份安装（P20.5 Blocker A 的同一种错）。
 * - **`list --json` 会启动用户配置的 stdio servers**（连 HTTP 也会联网）。
 *   所以它只在用户显式手势（MCP 页「刷新状态」）时跑一次，60s TTL 缓存，
 *   **绝不后台轮询**。自动返回的永远是轻量摘要（配置解析 + 内置 probe）。
 * - **OAuth 全程 pi 负责**：注册 client、开浏览器、存 `mcp-auth.json`、自动刷新。
 *   in-session 的 select / input 经 P19 的 extension_ui 管道自动承接（mcp 扩展
 *   只用 `ctx.ui.notify/select/input`，实测无 confirm），本模块不新增任何
 *   OAuth 代码，不读、不缓存、不复制任何 token / clientSecret。
 *
 * ---------- 依赖注入（模块之间不互相 import） ----------
 *
 *   runtime            共享运行态（cwd、stale 判定）
 *   env                环境变量（agent 目录、HOME）
 *   resolvePackageDir  launch identity 的包目录（server.js 注入 piLaunch.packageDir）
 *   readTrust          项目信任状态（server.js 注入，与 extension-registry 同一个来源）
 *   rpc                桥接（可选）：`get_commands` 里找 `{source:'extension',name:'mcp'}`
 *                      —— 替代 builtin 的扩展只留下这一条 RPC 可见证据
 *   runCli             执行原语 `(entry, args, {cwd, timeoutMs}) => Promise<result>`，
 *                      server.js 从 `server/agents/cli.js` 的 `runCli` 包一层注入
 *   piBuiltins         共用的 built-in 探测 `(cwd) => 探测结果`
 *   now / ttlMs        时间源与缓存时长（单测注入）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json, readBody } from './http-utils.js';

const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EXPOSURES = new Set(['codemode', 'codemode-deferred', 'deferred', 'direct', 'hidden']);
const DEFAULT_EXPOSURE = 'codemode';
const MAX_FILE_BYTES = 256 * 1024;
const MAX_ERROR_CHARS = 500;
const MAX_TOOLS = 200;
const MAX_TOOL_NAME = 128;

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

/** 脱敏：把已知绝对路径折成占位符。错误文本里常带 stderr 尾巴（含路径）。 */
function redactPaths(text, { cwd = null, agentDir = null, homeDir = null } = {}) {
  let out = String(text ?? '');
  if (cwd) out = out.split(cwd).join('<project>');
  if (agentDir) out = out.split(agentDir).join('<agent-dir>');
  if (homeDir) out = out.split(homeDir).join('<home>');
  return out;
}

/**
 * 安全解析一份 mcp.json：只取结构，不取 secret 值。
 * @returns {{servers: Array, invalid: string[], error: string}}
 *   server = {name, enabled, exposure, transportType, hasSecrets, toolExposure, toolExposureNote}
 */
export function parseMcpServers(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { servers: [], invalid: [], error: 'not-an-object' };
  }
  const table = data.mcpServers;
  if (table === undefined) return { servers: [], invalid: [], error: '' };
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    return { servers: [], invalid: [], error: 'mcpServers-not-an-object' };
  }
  const servers = [];
  const invalid = [];
  for (const [name, cfg] of Object.entries(table)) {
    if (!SERVER_NAME_RE.test(name)) {
      invalid.push(`invalid server name "${String(name).slice(0, 80)}" (use letters, digits, "_" and "-")`);
      continue;
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      invalid.push(`invalid server "${name}": not an object`);
      continue;
    }
    const enabled = cfg.enabled === undefined ? true : cfg.enabled;
    if (typeof enabled !== 'boolean') {
      invalid.push(`invalid server "${name}": enabled must be boolean`);
      continue;
    }
    const exposure = cfg.exposure === undefined ? DEFAULT_EXPOSURE : cfg.exposure;
    if (!EXPOSURES.has(exposure)) {
      invalid.push(`invalid server "${name}": unknown exposure`);
      continue;
    }
    const hasCommand = typeof cfg.command === 'string' && cfg.command.length > 0;
    const hasUrl = typeof cfg.url === 'string' && cfg.url.length > 0;
    if ((hasCommand && hasUrl) || (!hasCommand && !hasUrl)) {
      invalid.push(`invalid server "${name}": need exactly one of command/url`);
      continue;
    }
    if (cfg.type !== undefined && cfg.type !== 'stdio' && cfg.type !== 'http' && cfg.type !== 'streamable-http') {
      invalid.push(`invalid server "${name}": unknown type`);
      continue;
    }
    // secret 面：只记「有没有」，值一个字节都不留。
    const hasSecrets = Boolean(
      (cfg.env && typeof cfg.env === 'object') ||
      (cfg.headers && typeof cfg.headers === 'object') ||
      (cfg.oauth && typeof cfg.oauth === 'object'),
    );
    let toolExposure = null;
    let toolExposureNote = '';
    if (cfg.toolExposure !== undefined) {
      if (!cfg.toolExposure || typeof cfg.toolExposure !== 'object' || Array.isArray(cfg.toolExposure)) {
        toolExposureNote = 'toolExposure ignored: not an object';
      } else {
        toolExposure = {};
        for (const [k, v] of Object.entries(cfg.toolExposure)) {
          // 键是工具名/ pattern（标识符面，可展示）；值必须是 exposure 枚举。
          if (typeof k !== 'string' || !k || k.length > MAX_TOOL_NAME) continue;
          if (!EXPOSURES.has(v)) {
            toolExposureNote = 'some toolExposure entries ignored: unknown exposure';
            continue;
          }
          toolExposure[k] = v;
        }
      }
    }
    servers.push({
      name,
      enabled,
      exposure,
      transportType: hasCommand ? 'stdio' : 'http',
      hasSecrets,
      toolExposure,
      toolExposureNote,
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
 * @param readTrust          () => {trusted, requiresTrust}（可为 async）
 * @param rpc                桥接（可选，get_commands 找替代 /mcp）
 * @param runCli             (entry, args, {cwd, timeoutMs}) => Promise<{ok, exitCode, stdout, stderr, timedOut, spawnFailed, error}>
 * @param piBuiltins         (cwd) => built-in 探测结果
 * @param readSettingsExt    () => {disabled: boolean|null}（-builtin:mcp 判定，可注入；缺省自己读）
 */
export function createMcpNative({
  runtime,
  env = process.env,
  resolvePackageDir = null,
  readTrust = null,
  rpc = null,
  runCli = null,
  piBuiltins = null,
  readSettingsExt = null,
  now = () => Date.now(),
  ttlMs = STATUS_TTL_MS,
} = {}) {
  const agentDir = agentDirOf(env);
  const homeDir = env.HOME || env.USERPROFILE || null;
  let statusCache = null; // {at, data}
  let commandsCache = null; // {at, data}
  let lastSummary = null;

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

  /** 两处 mcp.json 的安全解析（结构 only）。读不到/坏了就按空处理，不抛。 */
  function readConfigs() {
    const f = files();
    const u = readJsonSafe(f.user);
    const p = f.project ? readJsonSafe(f.project) : { exists: null, data: null, error: '' };
    const up = u.data ? parseMcpServers(u.data) : { servers: [], invalid: [], error: u.error || '' };
    const pp = p.data ? parseMcpServers(p.data) : { servers: [], invalid: [], error: p.error || '' };
    const projectNames = new Set(pp.servers.map((s) => s.name));
    const user = up.servers.map((s) => ({
      ...s,
      scope: 'user',
      // 项目同名覆盖用户级（pi 原语，docs/mcp.md）—— 被覆盖的那条标出来，不报两条都生效。
      overridden: projectNames.has(s.name),
    }));
    const project = pp.servers.map((s) => ({ ...s, scope: 'project', overridden: false }));
    return {
      user: { exists: u.exists, error: u.error, invalid: up.invalid, parseError: up.error },
      project: { exists: p.exists, error: p.error, invalid: pp.invalid, parseError: pp.error },
      servers: [...user, ...project],
    };
  }

  async function trust() {
    try {
      const t = typeof readTrust === 'function' ? await readTrust() : null;
      if (t && typeof t === 'object') {
        return { trusted: Boolean(t.trusted), requiresTrust: Boolean(t.requiresTrust) };
      }
    } catch {
      /* 拿不到就按未知处理 */
    }
    return { trusted: null, requiresTrust: null };
  }

  /** settings.json 的 extensions 数组里有没有 -builtin:mcp（项目覆盖用户）。 */
  function disabledBySettings() {
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
      if (cwd) {
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

  /** 替代 builtin 的扩展：get_commands 里找 source=extension 的 mcp 命令。 */
  async function replacedProbe() {
    const t = now();
    if (commandsCache && t - commandsCache.at < ttlMs) return commandsCache.data;
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
    commandsCache = { at: t, data };
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

  /** native 状态机：只认三份证据，缺一律 unknown，不猜。 */
  async function nativeState() {
    const [rep, bi] = [await replacedProbe(), builtins()];
    const dis = disabledBySettings();
    if (rep.replaced === true) {
      return { state: 'replaced', replaced: true, disabled: dis, builtinPresent: bi.present, reason: '扩展注册了 /mcp，接管了内置 MCP（以 get_commands 为证）' };
    }
    if (dis === true) {
      return { state: 'disabled', replaced: false, disabled: true, builtinPresent: bi.present, reason: 'settings 的 extensions 关掉了 builtin:mcp' };
    }
    if (bi.present === true && rep.replaced === false && dis !== true) {
      return { state: 'active', replaced: false, disabled: false, builtinPresent: true, reason: 'builtin:mcp 在包里、未被禁用、未被接管' };
    }
    if (bi.present === false) {
      return { state: 'unsupported', replaced: false, disabled: dis, builtinPresent: false, reason: '这个 pi 包里没有 builtin:mcp' };
    }
    return { state: 'unknown', replaced: rep.replaced, disabled: dis, builtinPresent: bi.present, reason: '证据不足（包读不到或 pi 未应答），不断言' };
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
    const servers = [];
    for (const s of parsed.servers) {
      if (!s || typeof s !== 'object') continue;
      const name = typeof s.name === 'string' && SERVER_NAME_RE.test(s.name) ? s.name : null;
      if (!name) continue;
      const tools = Array.isArray(s.tools)
        ? s.tools.filter((x) => typeof x === 'string' && x.length <= MAX_TOOL_NAME).slice(0, MAX_TOOLS)
        : null;
      servers.push({
        name,
        scope: s.scope === 'project' ? 'project' : s.scope === 'global' ? 'user' : null,
        enabled: typeof s.enabled === 'boolean' ? s.enabled : null,
        exposure: typeof s.exposure === 'string' && EXPOSURES.has(s.exposure) ? s.exposure : null,
        // transport 原文含命令路径/URL，只留类型面。
        transportType: typeof s.transport === 'string' && /^https?:\/\//.test(s.transport) ? 'http'
          : typeof s.transport === 'string' && s.transport ? 'stdio' : null,
        state: typeof s.state === 'string' && s.state.length <= 64 ? s.state : null,
        toolCount: tools ? tools.length : null,
        tools,
        error: typeof s.error === 'string' && s.error ? redactPaths(clip(s.error), { cwd: f.cwd, agentDir, homeDir }) : '',
      });
    }
    const errors = Array.isArray(parsed.errors)
      ? parsed.errors.filter((x) => typeof x === 'string').slice(0, 20).map((x) => redactPaths(clip(x), { cwd: f.cwd, agentDir, homeDir }))
      : [];
    return { ok: true, code: '', error: '', servers, errors, exitCode: r.exitCode };
  }

  /** 轻量摘要：不 spawn，只读配置 + 内置 probe。每次 GET /api/mcp 都带它。 */
  async function summary() {
    const cfg = readConfigs();
    const tr = await trust();
    const nat = await nativeState();
    const servers = cfg.servers.map((s) => {
      const effective = s.scope === 'project' && tr.requiresTrust && tr.trusted === false
        ? { active: false, reason: 'untrusted' }
        : { active: Boolean(s.enabled) && !s.overridden, reason: s.overridden ? 'overridden' : (s.enabled ? '' : 'disabled') };
      if (nat.state === 'replaced') {
        effective.active = false;
        effective.reason = 'replaced';
      } else if (nat.state === 'disabled' || nat.state === 'unsupported') {
        effective.active = false;
        effective.reason = nat.state;
      }
      return { ...s, effective };
    });
    lastSummary = {
      fresh: true,
      at: new Date(now()).toISOString(),
      native: nat,
      trust: tr.trusted === null ? null : tr,
      servers,
      configInvalid: [...cfg.user.invalid, ...cfg.project.invalid],
      configError: { user: cfg.user.parseError || cfg.user.error, project: cfg.project.parseError || cfg.project.error },
    };
    return lastSummary;
  }

  /** 同步看一眼上次算出的摘要（给 /api/mcp 这种同步报告用；没算过就是 null）。 */
  function peekSummary() {
    return lastSummary;
  }

  /** 显式刷新：跑 list --json 并进 60s 缓存。 */
  async function refresh() {
    const t = now();
    if (statusCache && t - statusCache.at < ttlMs) return { ...statusCache.data, cached: true };
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
      exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
      servers: (r.servers || []).map((s) => {
        const c = byKey.get(`${s.scope}:${s.name}`) || byKey.get(`user:${s.name}`) || null;
        return {
          ...s,
          // exposure 以运行时为准，拿不到才退回配置。
          exposure: s.exposure || (c ? c.exposure : null),
          hasSecrets: c ? c.hasSecrets : null,
          toolExposure: c ? c.toolExposure : null,
          configured: Boolean(c),
        };
      }),
    };
    statusCache = { at: t, data };
    return data;
  }

  function peekStatus() {
    if (!statusCache) return null;
    return { ...statusCache.data, cached: true };
  }

  function reset() {
    statusCache = null;
    commandsCache = null;
    lastSummary = null;
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
    if (typeof name !== 'string' || !SERVER_NAME_RE.test(name)) {
      return { ok: false, code: 'bad-name', error: 'server 名只允许字母、数字、_ 和 -（1–64 字符）' };
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
    if (exposure !== undefined && !EXPOSURES.has(exposure)) {
      return { ok: false, code: 'bad-exposure', error: 'exposure 必须是 codemode / codemode-deferred / deferred / direct / hidden' };
    }
    return null;
  }

  const str = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0') ? v : null);

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
    const argv = ['mcp', 'add', b.name];
    if (b.scope === 'project') argv.push('-l');
    if (b.exposure !== undefined) argv.push('--exposure', b.exposure);
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
      const headers = Array.isArray(b.headers) ? b.headers.slice(0, 16) : [];
      for (const h of headers) {
        if (!h || typeof h.key !== 'string' || typeof h.value !== 'string') {
          return { ok: false, code: 'bad-header', error: 'header 必须是 {key, value}' };
        }
        if (!/^[A-Za-z0-9-]+$/.test(h.key) || h.value.length > 1024 || h.value.includes('\0')) {
          return { ok: false, code: 'bad-header', error: 'header 名不合法或值过长' };
        }
        // 值透传给 pi 写文件，响应里永不回显（见 handle）。
        argv.push('--header', `${h.key}=${h.value}`);
      }
      if (b.bearerTokenEnvVar !== undefined) {
        if (typeof b.bearerTokenEnvVar !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(b.bearerTokenEnvVar)) {
          return { ok: false, code: 'bad-env-var', error: 'bearerTokenEnvVar 必须是环境变量名' };
        }
        argv.push('--bearer-token-env-var', b.bearerTokenEnvVar);
      }
      const oauth = b.oauth && typeof b.oauth === 'object' ? b.oauth : null;
      if (oauth) {
        if (oauth.clientId !== undefined) {
          if (!str(oauth.clientId, 256)) return { ok: false, code: 'bad-oauth', error: 'oauth.clientId 不合法' };
          argv.push('--oauth-client-id', oauth.clientId);
        }
        if (oauth.clientSecret !== undefined) {
          if (typeof oauth.clientSecret !== 'string' || !oauth.clientSecret || oauth.clientSecret.length > 1024) {
            return { ok: false, code: 'bad-oauth', error: 'oauth.clientSecret 不合法' };
          }
          argv.push('--oauth-client-secret', oauth.clientSecret);
        }
        if (oauth.callbackPort !== undefined) {
          if (!Number.isInteger(oauth.callbackPort) || oauth.callbackPort < 1 || oauth.callbackPort > 65535) {
            return { ok: false, code: 'bad-oauth', error: 'oauth.callbackPort 必须是 1–65535' };
          }
          argv.push('--oauth-callback-port', String(oauth.callbackPort));
        }
      }
    } else if (b.transport === 'stdio' || b.transport === undefined) {
      const command = str(b.command, 512);
      if (!command) return { ok: false, code: 'bad-command', error: 'stdio server 需要 command（单个可执行文件，不是 shell 串）' };
      const args = Array.isArray(b.args) ? b.args : [];
      if (args.length > 32 || args.some((a) => typeof a !== 'string' || a.length > 1024 || a.includes('\0'))) {
        return { ok: false, code: 'bad-args', error: 'args 必须是字符串数组（≤32 项，每项 ≤1024 字符）' };
      }
      const envPairs = Array.isArray(b.env) ? b.env.slice(0, 16) : [];
      for (const p of envPairs) {
        if (!p || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.key || '') || typeof p.value !== 'string' || p.value.length > 1024) {
          return { ok: false, code: 'bad-env', error: 'env 必须是 {key: 环境变量名, value}（≤16 项）' };
        }
        argv.push('--env', `${p.key}=${p.value}`);
      }
      if (b.cwd !== undefined) {
        if (!str(b.cwd, 512)) return { ok: false, code: 'bad-cwd', error: 'cwd 不合法' };
        argv.push('--cwd', b.cwd);
      }
      argv.push('--', command, ...args);
    } else {
      return { ok: false, code: 'bad-transport', error: 'transport 只能是 stdio 或 http' };
    }
    const r = await runMcpAction('add', argv, { cwd: runtime.getCurrentCwd(), timeoutMs: TIMEOUT_WRITE_MS });
    if (!r.ok) return r;
    reset();
    return { ok: true, code: '', error: '', name: b.name, scope: b.scope };
  }

  async function actRemove(b) {
    const bad = checkName(b.name) || checkScope(b.scope);
    if (bad) return bad;
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
        const light = statusCache ? { ...statusCache.data, cached: true } : null;
        return json(res, 200, { ok: true, status: light });
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
          // 响应里永不回显 secret 面：env / headers / oauth 值只进 pi 的文件，不进 HTTP。
          if (!r.ok) return json(res, 200, r);
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
    _internals: { parseMcpServers, buildPiEntry, SERVER_NAME_RE, EXPOSURES },
  };
}
