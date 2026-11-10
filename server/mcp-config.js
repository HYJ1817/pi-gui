/* MCP 配置的受控读写层。
 *
 * 这一层解决的是 P20.6 之前刻意**不做**的那一半：Pi 的 `pi mcp` CLI 只提供
 * add / remove / login / logout，所以 Pi GUI 过去连「停用一台 server」都只能
 * 请用户去 `/mcp` TUI。现在 Pi 1.5.x 的配置语义已经稳定（全局 + 项目覆盖），
 * 因此这里提供一条受控的配置文件读写路径：
 *
 *   - 校验规则与上游 `validateMcpServerConfig` 对齐（复用 mcp-native 的 parser）；
 *   - **原子写**：同目录临时文件 → fsync → rename，绝不原地截断；
 *   - 写前备份，写后保留最近若干份，失败不碰原文件；
 *   - 项目 scope 仍然受项目信任闸门约束（false / 未知一律 fail closed）；
 *   - `env` / `headers` 中**看起来是凭据的键/值只接受 `${VAR}` 引用**
 *     （或对已有条目使用 keep 语义）；非敏感的普通字面值（路径、模式名等）
 *     可以保存。任何明文凭据在 HTTP 边界被拒 —— 这是 P20.6 secret contract 的延续；
 *   - 读详情时同样不回显明文：已有的字面值只回「已设置」，UI 以 keep 语义
 *     原样保留，不把凭据带进 renderer。
 *
 * 这不是第二套 MCP Runtime：运行时状态仍只来自 `pi mcp list --json`
 * （mcp-native），这里只改 Pi 自己会读的那两份 mcp.json。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMcpServers } from './mcp-native.js';

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_BACKUPS = 5;
const MAX_NAME = 64;
const MAX_COMMAND = 512;
const MAX_ARGS = 32;
const MAX_ARG = 1024;
const MAX_URL = 2048;
const MAX_DESCRIPTION = 200;
const MAX_TIMEOUT = 3600;
const MAX_ENV = 64;
const MAX_HEADERS = 32;
const MAX_ENV_KEY = 128;

const SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/* RFC 7230 token —— 用于 header 名。CR/LF/NUL 本来就不在集合里。 */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const REFERENCE_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
/* `Authorization: Bearer ${TOKEN}` 这种「scheme + 引用」也允许；值本身仍是引用。 */
const SCHEMED_REFERENCE_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+[ \t]+\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const SECRET_QUERY_RE = /(?:token|secret|password|passwd|credential|api[-_]?key|access[-_]?key|signature|auth)/i;
/* 敏感 env / header 的判据。只有命中这些的**字面值**才强制走 `${VAR}`；
 * `MEMORY_FILE_PATH=C:\\data` 这类非敏感配置可以正常填写（任务要求 env 可编辑），
 * 但 `API_KEY=sk-...` 会在 HTTP 边界被拒。 */
const SECRET_NAME_RE = /(^|[_-])(token|secret|password|passwd|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|auth)([_-]|$)/i;
const SECRET_VALUE_RE = /^(?:sk-|pk-|gh[pousr]_|github_pat_|AKIA|ASIA|xox[baprs]-|eyJ[A-Za-z0-9_-]{10,}\.)/;
const SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'api-key', 'x-auth-token', 'x-access-token',
]);

function nameNeedsReference(key) {
  return SECRET_NAME_RE.test(String(key)) || /authorization|credential/i.test(String(key));
}

function valueNeedsReference(key, value, { headers = false } = {}) {
  if (nameNeedsReference(key)) return true;
  if (headers && SENSITIVE_HEADERS.has(String(key).toLowerCase())) return true;
  if (valuesLikeSecret(value)) return true;
  if (headers && /^(?:bearer|basic|token|digest|negotiate)\s+/i.test(String(value))) return true;
  return false;
}

function valuesLikeSecret(value) {
  return SECRET_VALUE_RE.test(String(value || ''));
}

/* args 也会进磁盘，而且详情接口会把它们回给编辑表单。这里用与来源扫描
 * 相同的判据：敏感开关的**下一个参数**、`--key=value`、Authorization 字面值、
 * URL userinfo / 凭据查询串、以及凭据形态的裸值都算敏感。
 * 引用值（${VAR}）仍允许：它不是明文。 */
function sensitiveFlag(arg) {
  return /^--?[^=]+$/.test(arg) && nameNeedsReference(arg.replace(/^--?/, ''));
}

function argLooksSecret(arg, previousWasSensitiveFlag = false) {
  const s = String(arg);
  if (previousWasSensitiveFlag) return true;
  if (valuesLikeSecret(s)) return true;
  if (/^authorization\s*:/i.test(s)) return true;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.username || u.password) return true;
      if ([...u.searchParams.keys()].some((k) => SECRET_QUERY_RE.test(k))) return true;
    } catch { /* 非法 URL 交给 Pi 的校验 */ }
  }
  const eq = /^(--?[^=]+)=(.+)$/.exec(s);
  if (eq && nameNeedsReference(eq[1].replace(/^--?/, '')) && !REFERENCE_RE.test(eq[2])) return true;
  return false;
}

function argsContainSecret(args) {
  let previousWasSensitiveFlag = false;
  for (const raw of Array.isArray(args) ? args : []) {
    if (typeof raw !== 'string') return false;
    if (argLooksSecret(raw, previousWasSensitiveFlag)) return true;
    previousWasSensitiveFlag = sensitiveFlag(raw);
  }
  return false;
}

const EXPOSURES = new Set(['codemode', 'deferred', 'direct', 'hidden']);
const OVERRIDE_KEYS = new Set(['enabled', 'exposure', 'toolExposure']);

function isRecord(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function clip(s, max = 300) {
  const t = String(s ?? '');
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function oneLine(s) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

function namespace(name) {
  return String(name).replace(/-/g, '_');
}

function isReference(value) {
  return typeof value === 'string' && REFERENCE_RE.test(value);
}

function isHeaderReference(value) {
  return typeof value === 'string' && (REFERENCE_RE.test(value) || SCHEMED_REFERENCE_RE.test(value));
}

function isOverrideEntry(raw) {
  return isRecord(raw)
    && raw.command === undefined
    && raw.url === undefined
    && raw.type === undefined;
}

function resultError(code, error, field) {
  return { ok: false, code, error, ...(field ? { field } : {}) };
}

export function mcpFiles({ env = process.env, cwd = null } = {}) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const agentDir = env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent');
  return {
    agentDir,
    user: path.join(agentDir, 'mcp.json'),
    cwd: typeof cwd === 'string' && cwd ? cwd : null,
    project: typeof cwd === 'string' && cwd ? path.join(cwd, '.pi', 'mcp.json') : null,
  };
}

/** 检测缩进：上游 `editMcpServers` 用的是同一条正则，保持逐字节兼容。 */
function detectIndent(text) {
  return (text && /^([ \t]+)\S/m.exec(text)?.[1]) || '  ';
}

function readFileState(file, maxBytes = MAX_CONFIG_BYTES) {
  if (!file) return { file: null, exists: false, raw: '', data: null, revision: '', error: '', corrupt: false };
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { file, exists: false, raw: '', data: null, revision: '', error: '', corrupt: false };
    }
    return { file, exists: true, raw: '', data: null, revision: '', error: 'unreadable', corrupt: true };
  }
  if (stat.isSymbolicLink()) {
    /* 不跟随符号链接：否则一个被替换成链接的 mcp.json 会把原子写带到
     * 项目/主目录之外。读也按损坏处理，界面可以提示用户手工处理。 */
    return { file, exists: true, raw: '', data: null, revision: '', error: 'symlink', corrupt: true };
  }
  if (!stat.isFile() || stat.size > maxBytes) {
    return { file, exists: true, raw: '', data: null, revision: '', error: stat.isFile() ? 'too-large' : 'not-a-file', corrupt: true };
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch {
    return { file, exists: true, raw: '', data: null, revision: '', error: 'unreadable', corrupt: true };
  }
  try {
    const data = JSON.parse(raw || '{}');
    if (!isRecord(data)) {
      return { file, exists: true, raw, data: null, revision: sha256(raw), error: 'not-an-object', corrupt: true };
    }
    if (data.mcpServers !== undefined && !isRecord(data.mcpServers)) {
      return { file, exists: true, raw, data: null, revision: sha256(raw), error: 'mcpServers-not-an-object', corrupt: true };
    }
    return { file, exists: true, raw, data, revision: sha256(raw), error: '', corrupt: false };
  } catch {
    return { file, exists: true, raw, data: null, revision: sha256(raw), error: 'invalid-json', corrupt: true };
  }
}

/** 备份文件名只包含 basename + 时间戳，正文与原文件同权限（POSIX 下 0600）。 */
function backupFile(file, nowMs) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date(nowMs).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const name = `${path.basename(file)}.bak-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
  const target = path.join(path.dirname(file), name);
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) throw Object.assign(new Error('backup-target-invalid'), { code: 'backup-failed' });
  fs.copyFileSync(file, target);
  try { fs.chmodSync(target, 0o600); } catch { /* Windows 上 chmod 语义有限 */ }
  return name;
}

function pruneBackups(file) {
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.bak-`;
    const names = fs.readdirSync(dir)
      .filter((n) => n.startsWith(prefix))
      .sort()
      .reverse();
    for (const old of names.slice(MAX_BACKUPS)) {
      try { fs.unlinkSync(path.join(dir, old)); } catch { /* 清理失败不影响本次写入 */ }
    }
  } catch { /* 目录读不到时忽略 */ }
}

/**
 * 同目录临时文件 → fsync → rename。目标被替换前，原文件始终完整。
 * 备份失败会中止写入 —— 没有回滚副本就不动用户配置。
 */
function writeAtomic(file, text, nowMs) {
  const dir = path.dirname(file);
  const existed = fs.existsSync(file);
  if (existed) {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) throw Object.assign(new Error('symlink'), { code: 'symlink' });
    if (!st.isFile()) throw Object.assign(new Error('not-a-file'), { code: 'not-a-file' });
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let backup = null;
  try {
    backup = backupFile(file, nowMs);
  } catch (err) {
    throw Object.assign(new Error('backup-failed'), { code: 'backup-failed', cause: err });
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* 某些文件系统不支持，rename 仍是原子的 */ }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw Object.assign(new Error('write-failed'), { code: 'write-failed', cause: err });
  }
  pruneBackups(file);
  return backup;
}

/** 市场模块也用它过滤第三方源里的明文凭据（不把「可安装」标在会被拒绝的条目上）。 */
export function settingNeedsReference(key, value, { headers = false } = {}) {
  return valueNeedsReference(key, value, { headers });
}

/** 通用 JSON 原子写（市场源列表等 GUI 自己的数据也走同一条可靠路径）。 */
export function writeJsonAtomic(file, data, nowMs = Date.now()) {
  return writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`, nowMs);
}

function serializeConfig(data, rawText) {
  /* 与上游 editMcpServers 同形：沿用文件缩进，结尾恒为一个换行。 */
  const indent = detectIndent(rawText);
  return `${JSON.stringify(data, null, indent)}\n`;
}

/* URL 的敏感判定不能只看参数名：`?sid=ghp_...`、`/mcp/sk-...` 这类
 * “无害参数名 / 路径 + 凭据形态的值”同样会把明文带进 renderer。
 * 只要值看起来像凭据，就按敏感处理；预览只保留 origin。 */
function queryLooksSensitive(u) {
  for (const [key, value] of u.searchParams) {
    if (SECRET_QUERY_RE.test(key)) return true;
    if (valuesLikeSecret(value)) return true;
    if (/(?:^|[_-])(?:key|code|session|sid|sig)$/i.test(key) && value.length >= 8) return true;
  }
  return valuesLikeSecret(u.pathname);
}

function inspectUrl(value) {
  if (typeof value !== 'string') return { full: null, preview: null, sensitive: false };
  try {
    const u = new URL(value);
    const sensitive = Boolean(u.username || u.password) || queryLooksSensitive(u);
    const preview = sensitive ? u.origin : `${u.origin}${u.pathname}`;
    return { full: sensitive ? null : value, preview, sensitive };
  } catch {
    return { full: null, preview: null, sensitive: true };
  }
}

function maskSettings(record, { headers = false } = {}) {
  const out = [];
  if (!isRecord(record)) return out;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') continue;
    const reference = headers ? isHeaderReference(value) : isReference(value);
    /* 非敏感字面值（例如 MEMORY_FILE_PATH）可以回填到编辑表单；
     * 敏感值仍然只回「已设置」，UI 用 keep 保留。 */
    const sensitive = !reference && valueNeedsReference(key, value, { headers });
    out.push({
      key,
      value: reference || !sensitive ? value : null,
      reference,
      secret: sensitive,
    });
  }
  return out;
}

function overrideDetail(baseRaw) {
  if (!isRecord(baseRaw)) return null;
  const url = inspectUrl(baseRaw.url);
  const rawArgs = Array.isArray(baseRaw.args) ? baseRaw.args.filter((a) => typeof a === 'string') : [];
  const argsProtected = argsContainSecret(rawArgs);
  return {
    transport: typeof baseRaw.url === 'string' ? 'http' : 'stdio',
    command: typeof baseRaw.command === 'string' ? baseRaw.command : null,
    /* 覆盖条目继承的全局 base 同样可能带凭据；详情接口不能因为
     * “只是展示继承值”就绕过普通条目的 args / URL 边界。 */
    args: argsProtected ? [] : rawArgs,
    argsProtected,
    argsCount: rawArgs.length,
    url: url.full,
    urlPreview: url.preview,
    urlProtected: url.sensitive,
    cwd: typeof baseRaw.cwd === 'string' ? baseRaw.cwd : null,
    description: typeof baseRaw.description === 'string' ? oneLine(baseRaw.description) : '',
    enabled: baseRaw.enabled === undefined ? true : baseRaw.enabled,
    envKeys: isRecord(baseRaw.env) ? Object.keys(baseRaw.env) : [],
    headerKeys: isRecord(baseRaw.headers) ? Object.keys(baseRaw.headers) : [],
    hasSecrets: Boolean(isRecord(baseRaw.env) || isRecord(baseRaw.headers) || isRecord(baseRaw.oauth) || isRecord(baseRaw.auth)),
  };
}

/**
 * 把编辑表单转成 Pi 配置对象。只接受引用形式的凭据值。
 *
 * `existingEntry` 提供 keep 语义：`{key, keep:true}` 表示保留原值（可以是历史
 * 遗留的明文），因此编辑一台已有 server 不会强迫用户把明文搬进界面。
 */
function normalizeInput(input, { scope, existingEntry = null } = {}) {
  if (!isRecord(input)) return resultError('bad-config', '配置必须是对象');
  const type = input.transport === 'http' ? 'http' : input.transport === 'stdio' ? 'stdio' : null;
  if (!type) return resultError('bad-transport', 'transport 只能是 stdio 或 http', 'transport');

  const description = input.description === undefined || input.description === ''
    ? ''
    : oneLine(input.description);
  if (description.length > MAX_DESCRIPTION) {
    return resultError('bad-description', `描述最多 ${MAX_DESCRIPTION} 个字符`, 'description');
  }

  let timeout = null;
  if (input.timeout !== undefined && input.timeout !== null && input.timeout !== '') {
    const n = typeof input.timeout === 'number' ? input.timeout : Number(input.timeout);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TIMEOUT) {
      return resultError('bad-timeout', `超时必须是 1–${MAX_TIMEOUT} 秒的整数`, 'timeout');
    }
    timeout = n;
  }

  let exposure = '';
  if (input.exposure !== undefined && input.exposure !== '') {
    exposure = input.exposure === 'codemode-deferred' ? 'codemode' : input.exposure;
    if (!EXPOSURES.has(exposure)) {
      return resultError('bad-exposure', 'exposure 必须是 codemode / deferred / direct / hidden', 'exposure');
    }
  }

  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return resultError('bad-enabled', 'enabled 必须是布尔值', 'enabled');
  }

  const config = { type };
  if (type === 'stdio') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command) return resultError('bad-command', 'stdio server 需要 command', 'command');
    if (command.length > MAX_COMMAND || /[\u0000-\u001f\u007f]/.test(command)) {
      return resultError('bad-command', 'command 不合法（单行、≤512 字符）', 'command');
    }
    config.command = command;
    if (input.args !== undefined) {
      if (!Array.isArray(input.args) || input.args.length > MAX_ARGS) {
        return resultError('bad-args', `args 必须是最多 ${MAX_ARGS} 项的数组`, 'args');
      }
      const args = [];
      for (const a of input.args) {
        if (typeof a !== 'string' || a.length > MAX_ARG || /[\u0000]/.test(a)) {
          return resultError('bad-args', `每个 arg 必须是 ≤${MAX_ARG} 字符的字符串`, 'args');
        }
        args.push(a);
      }
      if (argsContainSecret(args)) {
        return resultError(
          'secret-value-unsupported',
          'args 疑似包含明文凭据；请改用服务自己的环境变量配置（body 不会经过 Pi GUI）',
          'args',
        );
      }
      if (args.length) config.args = args;
    }
    if (input.cwd !== undefined && input.cwd !== null && input.cwd !== '') {
      if (typeof input.cwd !== 'string' || input.cwd.length > MAX_COMMAND || /[\u0000-\u001f\u007f]/.test(input.cwd)) {
        return resultError('bad-cwd', 'cwd 不合法', 'cwd');
      }
      config.cwd = input.cwd;
    }
    const envResult = buildStringRecord(input.env, existingEntry && existingEntry.env, {
      kind: 'env', keyRe: ENV_KEY_RE, valueAllowed: isReference, field: 'env', max: MAX_ENV,
      needsReference: (key, value) => valueNeedsReference(key, value),
    });
    if (!envResult.ok) return envResult;
    if (input.env !== undefined) config.env = envResult.record;
  } else {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!url) return resultError('bad-url', 'HTTP server 需要 server URL', 'url');
    if (url.length > MAX_URL || /[\u0000-\u001f\u007f]/.test(url)) {
      return resultError('bad-url', 'URL 不合法或过长', 'url');
    }
    let parsed;
    try { parsed = new URL(url); } catch { return resultError('bad-url', 'URL 不是合法地址', 'url'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return resultError('bad-url', 'URL 只支持 http / https', 'url');
    }
    if (parsed.username || parsed.password) {
      return resultError('bad-url', 'URL 不能包含用户名或密码，请改用 header 的 ${VAR} 引用', 'url');
    }
    if (queryLooksSensitive(parsed)) {
      return resultError('bad-url', 'URL 查询串或路径中疑似包含凭据，请改用 header 的 ${VAR} 引用', 'url');
    }
    config.url = parsed.toString();
    const headerResult = buildStringRecord(input.headers, existingEntry && existingEntry.headers, {
      kind: 'header', keyRe: HEADER_NAME_RE, valueAllowed: isHeaderReference, field: 'headers', max: MAX_HEADERS,
      needsReference: (key, value) => valueNeedsReference(key, value, { headers: true }),
    });
    if (!headerResult.ok) return headerResult;
    if (input.headers !== undefined) config.headers = headerResult.record;
  }

  if (description) config.description = description;
  if (timeout !== null) config.timeout = timeout;
  if (exposure) config.exposure = exposure;
  if (input.enabled !== undefined) config.enabled = input.enabled;
  return { ok: true, config };
}

/* 编辑已有条目时，GUI 只管理自己认识的字段；上游的 `oauth` / `auth` /
 * `toolExposure` 以及未来新增的键必须原样留下。
 *
 * 这不是“宽容”，而是兼容性边界：`normalizeInput` 从空对象重建配置，
 * 如果直接落盘，一次改名就会把 OAuth 客户端配置与单工具 exposure 抹掉。
 * 用户没有在编辑页看到这些字段，也就不可能同意删除它们。
 *
 * 对“显式清空”的字段（description / timeout / exposure / enabled）不做保留：
 * 调用方传了 `''` / null / false 就是明确的意图；只有 **undefined**（没传）
 * 才视为“这次不涉及”。env / headers 同理，但 UI 每次都会整组回传。 */
const PRESERVED_ON_EDIT = new Set([
  'type', 'command', 'args', 'cwd', 'env', 'url', 'headers',
  'description', 'timeout', 'exposure', 'enabled',
]);
function preserveExistingConfig(config, existing, input, { scope } = {}) {
  if (!isRecord(existing) || !isRecord(config)) return config;
  const oldTransport = typeof existing.url === 'string' ? 'http'
    : typeof existing.command === 'string' ? 'stdio' : '';
  const nextTransport = typeof config.url === 'string' ? 'http'
    : typeof config.command === 'string' ? 'stdio' : '';
  const out = { ...config };

  /* 保留原有 type 的原文（streamable-http / http），只要传输家族没变。
   * 上游两者等价，但无意义的改写会让配置 diff 变脏。 */
  if (oldTransport === nextTransport && ['stdio', 'http', 'streamable-http'].includes(existing.type)) {
    out.type = existing.type;
  }

  for (const key of Object.keys(existing)) {
    if (PRESERVED_ON_EDIT.has(key)) continue;
    /* oauth / auth 只属于 HTTP 条目。把传输切到 stdio 时它们已无意义，
     * 但不主动删除未知键之外的业务字段也说不通 —— 这里只跳过这两个
     * 由上游定义、且与传输强绑定的键；其它未知键一律保留。 */
    if (nextTransport !== 'http' && (key === 'oauth' || key === 'auth')) continue;
    out[key] = existing[key];
  }

  if (input.enabled === undefined && typeof existing.enabled === 'boolean') out.enabled = existing.enabled;
  if (input.exposure === undefined && typeof existing.exposure === 'string') out.exposure = existing.exposure;
  if (input.description === undefined && typeof existing.description === 'string') out.description = existing.description;
  if (input.timeout === undefined && typeof existing.timeout === 'number') out.timeout = existing.timeout;
  if (input.env === undefined && isRecord(existing.env) && nextTransport === 'stdio') out.env = { ...existing.env };
  if (input.headers === undefined && isRecord(existing.headers) && nextTransport === 'http') out.headers = { ...existing.headers };
  /* `cwd` 不在编辑表单里（只读展示）；省略就表示原样保留，否则一次普通
   * 编辑会把 stdio server 的工作目录静默重置为 Pi 进程的 cwd。 */
  if (input.cwd === undefined && typeof existing.cwd === 'string' && nextTransport === 'stdio') out.cwd = existing.cwd;
  /* 含敏感值的 args 不回填表单；前端以“省略 args”表示原样保留。 */
  if (input.args === undefined && Array.isArray(existing.args) && nextTransport === 'stdio') out.args = existing.args.slice();

  /* 项目文件里不允许 auth（Pi 上游硬约束）；已有项目条目若带 auth，
   * 原样保留会被 parser 拒掉。那不是 GUI 该“修复”的配置 —— 明确报错，
   * 让用户知道这条配置本身不合规。保留后由 validateAgainstParser 判定。 */
  void scope;
  return out;
}

function buildStringRecord(input, existing, { kind, keyRe, valueAllowed, needsReference, field, max }) {
  if (input === undefined) return { ok: true, record: {} };
  if (!Array.isArray(input)) return resultError(`bad-${field}`, `${field} 必须是键值数组`, field);
  if (input.length > max) return resultError(`bad-${field}`, `${field} 最多 ${max} 项`, field);
  const record = {};
  const existingRecord = isRecord(existing) ? existing : {};
  const seen = new Set();
  for (const item of input) {
    if (!isRecord(item)) return resultError(`bad-${field}`, `${field} 项必须是对象`, field);
    const key = typeof item.key === 'string' ? item.key.trim() : '';
    if (!key || key.length > MAX_ENV_KEY || !keyRe.test(key) || seen.has(key)) {
      return resultError(`bad-${field}`, `${kind} 名称不合法或重复`, field);
    }
    seen.add(key);
    if (item.keep === true) {
      if (!(key in existingRecord) || typeof existingRecord[key] !== 'string') {
        return resultError('missing-secret', `${kind} “${key}” 没有可保留的现有值`, field);
      }
      record[key] = existingRecord[key];
      continue;
    }
    const value = typeof item.value === 'string' ? item.value.trim() : '';
    if (needsReference(key, value) && !valueAllowed(value)) {
      return resultError(
        'secret-value-unsupported',
        `${kind} “${key}” 的值必须使用 \${VAR} 环境变量引用；明文凭据不会经过 Pi GUI`,
        field,
      );
    }
    if (!value) {
      return resultError(`bad-${field}`, `${kind} “${key}” 的值不能为空`, field);
    }
    record[key] = value;
  }
  return { ok: true, record };
}

function validateAgainstParser(name, config, scope) {
  const parsed = parseMcpServers({ mcpServers: { [name]: config } }, { scope });
  if (parsed.error) return resultError('bad-config', parsed.error);
  if (parsed.invalid.length || parsed.servers.length !== 1) {
    return resultError('bad-config', parsed.invalid[0] || '配置未通过 Pi 的校验');
  }
  return { ok: true, server: parsed.servers[0] };
}

function validateOverride(name, patch, userTable) {
  if (!isRecord(patch)) return resultError('bad-config', '项目覆盖必须是对象');
  const extra = Object.keys(patch).filter((k) => !OVERRIDE_KEYS.has(k));
  if (extra.length) {
    return resultError('bad-override', `项目覆盖只能设置 ${[...OVERRIDE_KEYS].join(' / ')}`, extra[0]);
  }
  const base = userTable && userTable[name];
  if (!isRecord(base)) {
    return resultError('base-not-found', `用户级没有名为 “${name}” 的 server，项目覆盖无处继承`);
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
    return resultError('bad-enabled', 'enabled 必须是布尔值', 'enabled');
  }
  if (patch.exposure !== undefined && !EXPOSURES.has(patch.exposure)) {
    return resultError('bad-exposure', 'exposure 不合法', 'exposure');
  }
  if (patch.toolExposure !== undefined) {
    if (!isRecord(patch.toolExposure)) return resultError('bad-override', 'toolExposure 必须是对象', 'toolExposure');
    for (const v of Object.values(patch.toolExposure)) {
      if (!EXPOSURES.has(v)) return resultError('bad-exposure', 'toolExposure 含有非法值', 'toolExposure');
    }
  }
  /* 对齐上游：用 base + override 跑一次 validateMcpServerConfig。 */
  const merged = validateAgainstParser(name, { ...base, ...patch }, 'project');
  if (!merged.ok) return merged;
  return { ok: true, patch: { ...patch } };
}

/**
 * @param runtime  { getCurrentCwd() }
 * @param env      同 pi 进程一致的环境（agent 目录 / HOME）
 * @param readTrust 与 Skills / extension-registry 同一个信任源
 * @param now      时间源（单测注入）
 */
export function createMcpConfigStore({
  runtime,
  env = process.env,
  readTrust = null,
  now = () => Date.now(),
} = {}) {
  function cwd() {
    const v = runtime && typeof runtime.getCurrentCwd === 'function' ? runtime.getCurrentCwd() : null;
    return typeof v === 'string' && v ? v : null;
  }

  function files() {
    return mcpFiles({ env, cwd: cwd() });
  }

  function fileFor(scope) {
    const f = files();
    if (scope === 'user') return f.user;
    if (scope === 'project') return f.project;
    return null;
  }

  async function trust() {
    try {
      const t = typeof readTrust === 'function' ? await readTrust() : null;
      if (t && typeof t === 'object') {
        return { trusted: t.trusted === true ? true : t.trusted === false ? false : null, requiresTrust: t.requiresTrust === true ? true : t.requiresTrust === false ? false : null };
      }
    } catch { /* 未知 */ }
    return { trusted: null, requiresTrust: null };
  }

  function checkScope(scope) {
    if (scope !== 'user' && scope !== 'project') return resultError('bad-scope', 'scope 只能是 user 或 project', 'scope');
    if (scope === 'project' && !cwd()) return resultError('no-project', '当前没有打开项目，不能写项目级 MCP 配置');
    return null;
  }

  /* `mcp.json` 自己不是链接还不够：整个 `.pi` 目录也可能是指向别处的
   * symlink / junction。项目目录由仓库内容控制，若跟随这种父链接，一次
   * “项目级保存”就可能写进用户的全局 mcp.json（或任意可写目录）。
   * 项目 scope 因此要求 `.pi` 的 realpath 恰好是 <real cwd>/.pi。
   * 用户级的父目录是用户自己的 agent 目录，允许用户用 dotfiles 链接管理；
   * 这里仍拒绝最后一级父目录是链接，避免 GUI 意外写到链接目标。 */
  function unsafeParent(scope) {
    const file = fileFor(scope);
    const dir = path.dirname(file);
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      return resultError('unsafe-parent', '无法确认 mcp.json 所在目录的安全性，已拒绝操作');
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return resultError('unsafe-parent', 'mcp.json 所在目录是符号链接或不是目录，已拒绝操作');
    }
    if (scope === 'project') {
      try {
        const realDir = fs.realpathSync(dir);
        const realCwd = fs.realpathSync(cwd());
        if (realDir !== path.join(realCwd, '.pi')) {
          return resultError('unsafe-parent', '项目 .pi 目录指向了项目之外，已拒绝操作');
        }
      } catch {
        return resultError('unsafe-parent', '无法确认项目 .pi 目录的真实位置，已拒绝操作');
      }
    }
    return null;
  }

  async function projectGate() {
    const tr = await trust();
    if (tr.trusted !== true) {
      return {
        error: resultError(
          tr.trusted === false ? 'project-untrusted' : 'trust-unknown',
          tr.trusted === false
            ? '当前项目未被信任：Pi 不会读取它的 .pi/mcp.json。请先在 Pi 里信任这个项目。'
            : '读不到当前项目的信任状态，为避免写入不会被加载的配置，本次操作已拒绝。',
        ),
        trust: tr,
      };
    }
    return { error: null, trust: tr };
  }

  function checkRevision(state, expectedRevision) {
    /* 所有写入都必须带页面读取时的 revision。缺省不能当成“跳过并发检查”：
     * 那会让外部程序刚改过的 mcp.json 被一个旧页面静默覆盖。 */
    if (expectedRevision === undefined) {
      return resultError('missing-revision', '缺少配置 revision，请刷新后重试', 'revision');
    }
    if (typeof expectedRevision !== 'string') return resultError('bad-revision', 'revision 必须是字符串', 'revision');
    if (state.revision !== expectedRevision) {
      return resultError('stale-config', 'mcp.json 在编辑期间被其他程序修改，请刷新后重试');
    }
    return null;
  }

  function revisionOf(scope) {
    return readFileState(fileFor(scope)).revision;
  }

  /* Pi 读项目文件时会带上全局已接受的 server 名；写前校验必须用同一份
   * 累积集合，否则 GUI 会接受一个 Pi 实际会跳过的项目条目。 */
  function acceptedNamesOfGlobal() {
    const state = readFileState(files().user);
    const table = state.data && isRecord(state.data.mcpServers) ? state.data.mcpServers : {};
    return parseMcpServers({ mcpServers: table }, { scope: 'global' }).servers.map((s) => s.name);
  }

  /** 列表页用的两个文件 revision；前端保存时原样带回。 */
  function revisions() {
    return { user: revisionOf('user'), project: revisionOf('project') };
  }

  /**
   * 读取一台 server 的可编辑详情。**不返回任何明文凭据值**：
   * env / headers 里的字面值只标记 `secret:true`，UI 用 keep 保留。
   */
  async function getDetail({ scope, name } = {}) {
    const scopeError = checkScope(scope);
    if (scopeError) return scopeError;
    const parentError = unsafeParent(scope);
    if (parentError) return parentError;
    if (typeof name !== 'string' || !SERVER_NAME_RE.test(name) || name.length > MAX_NAME) {
      return resultError('bad-name', 'server 名只允许字母、数字、_ 和 -（1–64 字符）', 'name');
    }
    const file = fileFor(scope);
    const state = readFileState(file);
    if (state.error) return resultError('config-unreadable', `读不到 ${scope === 'project' ? '项目' : '用户'}级 mcp.json（${state.error}）`);
    const table = state.data && isRecord(state.data.mcpServers) ? state.data.mcpServers : {};
    const raw = table[name];
    if (!isRecord(raw)) return resultError('not-found', `mcp.json 里没有 “${name}”`);
    const tr = scope === 'project' ? await trust() : { trusted: null, requiresTrust: null };
    if (scope === 'project' && isOverrideEntry(raw)) {
      const user = readFileState(files().user);
      const userTable = user.data && isRecord(user.data.mcpServers) ? user.data.mcpServers : {};
      const base = overrideDetail(userTable[name]);
      return {
        ok: true,
        scope,
        name,
        revision: state.revision,
        trust: tr,
        overrideOnly: true,
        entry: {
          type: 'override',
          enabled: raw.enabled === undefined ? (base ? base.enabled : true) : raw.enabled,
          exposure: raw.exposure === undefined ? '' : raw.exposure,
          toolExposure: isRecord(raw.toolExposure) ? raw.toolExposure : null,
          description: '',
          inherited: base,
        },
      };
    }
    const url = inspectUrl(raw.url);
    const type = typeof raw.url === 'string' ? 'http' : 'stdio';
    const env = maskSettings(raw.env);
    const headers = maskSettings(raw.headers, { headers: true });
    const rawArgs = Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === 'string') : [];
    const argsProtected = type === 'stdio' && argsContainSecret(rawArgs);
    return {
      ok: true,
      scope,
      name,
      revision: state.revision,
      trust: tr,
      overrideOnly: false,
      entry: {
        type,
        command: typeof raw.command === 'string' ? raw.command : null,
        /* args 含疑似凭据时整组不回填（原文可能被贴进公开 issue）；
         * 前端用“省略 args”保留原值，用户仍可手动编辑 mcp.json。 */
        args: argsProtected ? [] : rawArgs,
        argsProtected,
        argsCount: rawArgs.length,
        url: url.full,
        urlPreview: url.preview,
        urlProtected: url.sensitive,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
        env,
        headers,
        oauth: isRecord(raw.oauth),
        auth: isRecord(raw.auth),
        description: typeof raw.description === 'string' ? oneLine(raw.description) : '',
        timeout: typeof raw.timeout === 'number' ? raw.timeout : null,
        exposure: raw.exposure === undefined ? '' : (raw.exposure === 'codemode-deferred' ? 'codemode' : raw.exposure),
        toolExposure: isRecord(raw.toolExposure) ? raw.toolExposure : null,
        enabled: raw.enabled === undefined ? true : raw.enabled,
      },
    };
  }

  /** 读原始条目（仅服务端内部 / keep 语义用，绝不直接返回给 HTTP）。 */
  function rawEntry(scope, name) {
    const state = readFileState(fileFor(scope));
    const table = state.data && isRecord(state.data.mcpServers) ? state.data.mcpServers : {};
    return { state, table, raw: isRecord(table[name]) ? table[name] : null };
  }

  /**
   * 新建或修改一台 server。`name` 是新名字，`originalName` 是编辑前的名字。
   *
   * 项目 scope 分两种：普通条目（完整 command/url）与 override（只改
   * enabled/exposure/toolExposure，继承全局）。编辑已有 override 时沿用
   * `overrideOnly:true`；普通条目不会被静默改成 override。
   */
  async function save(input = {}) {
    const { scope, name, originalName = null, expectedRevision, allowReplace = false, overrideOnly = false } = input;
    const scopeError = checkScope(scope);
    if (scopeError) return scopeError;
    if (typeof name !== 'string' || !SERVER_NAME_RE.test(name) || name.length > MAX_NAME) {
      return resultError('bad-name', 'server 名只允许字母、数字、_ 和 -（1–64 字符）', 'name');
    }
    if (originalName !== null && (typeof originalName !== 'string' || !SERVER_NAME_RE.test(originalName))) {
      return resultError('bad-name', '原 server 名不合法', 'originalName');
    }
    const parentError = unsafeParent(scope);
    if (parentError) return parentError;
    if (scope === 'project') {
      const gate = await projectGate();
      if (gate.error) return gate.error;
    }

    const file = fileFor(scope);
    const state = readFileState(file);
    if (state.corrupt) {
      return resultError('config-corrupt', `${scope === 'project' ? '项目' : '用户'}级 mcp.json 无法解析（${state.error}），为避免覆盖现有内容已拒绝写入。`);
    }
    const revError = checkRevision(state, expectedRevision);
    if (revError) return revError;
    const data = isRecord(state.data) ? JSON.parse(JSON.stringify(state.data)) : {};
    if (!isRecord(data.mcpServers)) data.mcpServers = {};
    const table = data.mcpServers;
    const isEdit = typeof originalName === 'string';
    const sourceName = isEdit ? originalName : name;
    const existing = isRecord(table[sourceName]) ? table[sourceName] : null;
    const targetExisting = isRecord(table[name]) ? table[name] : null;
    if (name !== sourceName && targetExisting) {
      return resultError('name-conflict', `“${name}” 已经存在，不能重命名到这个名字`, 'name');
    }
    /* 编辑同一条配置不算“覆盖”—— 用户已经在编辑页里看过原值。
     * 只有“新建时撞名”才要求 allowReplace（市场安装 / 导入走这条）。 */
    if (targetExisting && !allowReplace && !isEdit) {
      return {
        ...resultError('name-conflict', `“${name}” 已经存在；确认后会覆盖原配置`, 'name'),
        canReplace: true,
      };
    }
    if (!existing && name !== sourceName) return resultError('not-found', `找不到原 server “${sourceName}”`);
    if (existing && originalName && originalName !== name && targetExisting) {
      return resultError('name-conflict', `目标名字 “${name}” 已被占用`, 'name');
    }

    /* 项目覆盖：只允许 patch 三个键，且全局必须有 base。
     *
     * 编辑已有 override 时必须从**原有 patch** 出发，而不是从空对象重建：
     * 表单只编辑 enabled，若整条替换就会把用户原有的 exposure / toolExposure
     * 静默删掉，工具可能因此重新暴露。省略的键表示“这次不改”。 */
    if (scope === 'project' && overrideOnly) {
      if (isRecord(existing) && !isOverrideEntry(existing)) {
        return resultError('bad-override', '这条项目条目不是覆盖条目，不能按覆盖方式保存');
      }
      const user = readFileState(files().user);
      const userTable = user.data && isRecord(user.data.mcpServers) ? user.data.mcpServers : {};
      const patch = {};
      if (isRecord(existing)) {
        for (const key of OVERRIDE_KEYS) {
          if (existing[key] !== undefined) {
            patch[key] = key === 'toolExposure' && isRecord(existing[key])
              ? { ...existing[key] }
              : existing[key];
          }
        }
      }
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (input.exposure !== undefined) {
        if (input.exposure === '') delete patch.exposure;
        else patch.exposure = input.exposure === 'codemode-deferred' ? 'codemode' : input.exposure;
      }
      if (input.toolExposure !== undefined) {
        if (input.toolExposure === null) delete patch.toolExposure;
        else patch.toolExposure = input.toolExposure;
      }
      const v = validateOverride(name, patch, userTable);
      if (!v.ok) return v;
      /* 单条再用 Pi 的累积 namespace 规则检查一次。只检查“这次写的名字”，
       * 不拿整张项目表去对全局 —— 否则一个历史遗留的冲突条目会让所有
       * 无关编辑都无法保存。 */
      const cross = parseMcpServers(
        { mcpServers: { [name]: v.patch } },
        { scope: 'project', takenNames: acceptedNamesOfGlobal() },
      );
      if (cross.error || cross.invalid.length) {
        return resultError('config-conflict', cross.invalid[0] || '项目覆盖与全局 namespace 冲突');
      }
      table[name] = v.patch;
      if (name !== sourceName) delete table[sourceName];
    } else {
      const normalized = normalizeInput(input, { scope, existingEntry: existing });
      if (!normalized.ok) return normalized;
      normalized.config = preserveExistingConfig(normalized.config, existing, input, { scope });
      /* 项目里的普通条目如果再与全局同名，上游会用完整条目覆盖全局；
       * 这是允许的，但必须让 UI 明确确认（不是创建，也不是编辑同名）。 */
      if (scope === 'project' && !existing) {
        const user = readFileState(files().user);
        const userTable = user.data && isRecord(user.data.mcpServers) ? user.data.mcpServers : {};
        if (isRecord(userTable[name]) && input.confirmOverride !== true) {
          return {
            ...resultError('scope-conflict', `用户级已有同名 server “${name}”；项目级完整条目会覆盖它（包含凭据来源）。确认后继续。`, 'name'),
            canOverride: true,
          };
        }
      }
      const parsed = validateAgainstParser(name, normalized.config, scope);
      if (!parsed.ok) return parsed;
      /* 跨文件 namespace 冲突：Pi 读取项目文件时会把全局已接受的名字
       * 作为累积集合。这里只对**本次写入的条目**做这项检查，避免让一条
       * 历史遗留的冲突条目阻塞其它无关编辑。 */
      if (scope === 'project') {
        const cross = parseMcpServers(
          { mcpServers: { [name]: normalized.config } },
          { scope: 'project', takenNames: acceptedNamesOfGlobal() },
        );
        if (cross.error || cross.invalid.length) {
          return resultError('config-conflict', cross.invalid[0] || '项目条目与全局 namespace 冲突');
        }
      }
      table[name] = normalized.config;
      if (name !== sourceName) delete table[sourceName];
      /* 同 namespace（- / _）冲突：上游对普通条目会拒绝。这里在写入前
       * 用同一份 parser 对整张表再跑一遍，避免“单条合法、整份文件非法”。
       * 跨文件部分已在上面对本次写入条目单独检查。 */
      const whole = parseMcpServers({ mcpServers: table }, { scope });
      if (whole.error || whole.invalid.length) {
        return resultError('config-conflict', whole.invalid[0] || `整份 mcp.json 未通过 Pi 的校验（${whole.error}）`);
      }
    }

    if (scope === 'project' && !overrideOnly) {
      /* 普通项目条目也不能和别的项目条目撞 namespace。 */
      const clash = Object.keys(table).find((other) => other !== name && namespace(other) === namespace(name));
      if (clash) return resultError('name-conflict', `“${name}” 与 “${clash}” 属于同一个 namespace`, 'name');
    }

    const text = serializeConfig(data, state.raw);
    let backup;
    try {
      backup = writeAtomic(file, text, now());
    } catch (err) {
      return resultError(err.code || 'write-failed', `写入 mcp.json 失败（${clip(err.message, 100)}），原文件未被修改`);
    }
    return {
      ok: true,
      scope,
      name,
      renamedFrom: originalName && originalName !== name ? originalName : null,
      replaced: Boolean(existing && name === sourceName),
      overrideOnly: Boolean(scope === 'project' && overrideOnly),
      backup,
      revision: sha256(text),
      reloadRequired: true,
    };
  }

  async function remove({ scope, name, expectedRevision } = {}) {
    const scopeError = checkScope(scope);
    if (scopeError) return scopeError;
    if (typeof name !== 'string' || !SERVER_NAME_RE.test(name) || name.length > MAX_NAME) {
      return resultError('bad-name', 'server 名不合法', 'name');
    }
    const parentError = unsafeParent(scope);
    if (parentError) return parentError;
    if (scope === 'project') {
      const gate = await projectGate();
      if (gate.error) return gate.error;
    }
    const file = fileFor(scope);
    const state = readFileState(file);
    if (state.corrupt) return resultError('config-corrupt', 'mcp.json 无法解析，已拒绝写入');
    const revError = checkRevision(state, expectedRevision);
    if (revError) return revError;
    const data = isRecord(state.data) ? JSON.parse(JSON.stringify(state.data)) : {};
    const table = isRecord(data.mcpServers) ? data.mcpServers : {};
    if (!isRecord(table[name])) return resultError('not-found', `mcp.json 里没有 “${name}”`);
    delete table[name];
    data.mcpServers = table;
    const text = serializeConfig(data, state.raw);
    let backup;
    try {
      backup = writeAtomic(file, text, now());
    } catch (err) {
      return resultError(err.code || 'write-failed', `写入 mcp.json 失败（${clip(err.message, 100)}），原文件未被修改`);
    }
    return { ok: true, scope, name, backup, revision: sha256(text), reloadRequired: true };
  }

  /**
   * 启用 / 停用。用户级直接改该条目；项目级优先改已有项目条目，
   * 没有则创建一条只含 enabled 的 override（继承全局的 transport / 凭据）。
   */
  async function setEnabled({ scope, name, enabled, expectedRevision } = {}) {
    const scopeError = checkScope(scope);
    if (scopeError) return scopeError;
    if (typeof name !== 'string' || !SERVER_NAME_RE.test(name) || name.length > MAX_NAME) {
      return resultError('bad-name', 'server 名不合法', 'name');
    }
    if (typeof enabled !== 'boolean') return resultError('bad-enabled', 'enabled 必须是布尔值', 'enabled');
    const parentError = unsafeParent(scope);
    if (parentError) return parentError;
    if (scope === 'project') {
      const gate = await projectGate();
      if (gate.error) return gate.error;
    }
    const file = fileFor(scope);
    const state = readFileState(file);
    if (state.corrupt) return resultError('config-corrupt', 'mcp.json 无法解析，已拒绝写入');
    const revError = checkRevision(state, expectedRevision);
    if (revError) return revError;
    const data = isRecord(state.data) ? JSON.parse(JSON.stringify(state.data)) : {};
    if (!isRecord(data.mcpServers)) data.mcpServers = {};
    const table = data.mcpServers;
    let raw = isRecord(table[name]) ? table[name] : null;
    let createdOverride = false;

    if (scope === 'project' && !raw) {
      const user = readFileState(files().user);
      const userTable = user.data && isRecord(user.data.mcpServers) ? user.data.mcpServers : {};
      if (!isRecord(userTable[name])) {
        return resultError('not-found', `用户级没有 “${name}”，项目级无法创建覆盖`);
      }
      const v = validateOverride(name, { enabled }, userTable);
      if (!v.ok) return v;
      raw = { enabled };
      table[name] = raw;
      createdOverride = true;
    } else if (!raw) {
      return resultError('not-found', `mcp.json 里没有 “${name}”`);
    } else if (isOverrideEntry(raw)) {
      raw.enabled = enabled;
    } else if (enabled) {
      delete raw.enabled;
    } else {
      raw.enabled = false;
    }

    const text = serializeConfig(data, state.raw);
    let backup;
    try {
      backup = writeAtomic(file, text, now());
    } catch (err) {
      return resultError(err.code || 'write-failed', `写入 mcp.json 失败（${clip(err.message, 100)}），原文件未被修改`);
    }
    return {
      ok: true,
      scope,
      name,
      enabled,
      createdOverride,
      backup,
      revision: sha256(text),
      reloadRequired: true,
    };
  }

  /**
   * 批量导入（扫描其他工具用）。一次写入，避免导入到一半留下半份配置。
   * 每条都先过与单条相同的校验；任何一条不合法都不写。
   */
  async function importMany({ scope, entries, expectedRevision, allowReplace = false, confirmOverride = false } = {}) {
    const scopeError = checkScope(scope);
    if (scopeError) return scopeError;
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 50) {
      return resultError('bad-import', '导入条目数量必须是 1–50');
    }
    const parentError = unsafeParent(scope);
    if (parentError) return parentError;
    if (scope === 'project') {
      const gate = await projectGate();
      if (gate.error) return gate.error;
    }
    const file = fileFor(scope);
    const state = readFileState(file);
    if (state.corrupt) return resultError('config-corrupt', 'mcp.json 无法解析，已拒绝写入');
    const revError = checkRevision(state, expectedRevision);
    if (revError) return revError;
    const data = isRecord(state.data) ? JSON.parse(JSON.stringify(state.data)) : {};
    if (!isRecord(data.mcpServers)) data.mcpServers = {};
    const table = data.mcpServers;
    const userTable = scope === 'project'
      ? (() => {
          const u = readFileState(files().user);
          return u.data && isRecord(u.data.mcpServers) ? u.data.mcpServers : {};
        })()
      : {};
    const globalNames = scope === 'project' ? acceptedNamesOfGlobal() : null;

    const prepared = [];
    for (const entry of entries) {
      if (!isRecord(entry)) return resultError('bad-import', '导入条目必须是对象');
      const name = entry.name;
      if (typeof name !== 'string' || !SERVER_NAME_RE.test(name) || name.length > MAX_NAME) {
        return resultError('bad-name', `导入条目名不合法：${clip(name, 80)}`);
      }
      if (isRecord(table[name]) && !allowReplace) {
        return { ...resultError('name-conflict', `“${name}” 已经存在`, 'name'), canReplace: true, name };
      }
      if (scope === 'project' && !isRecord(userTable[name]) && isRecord(table[name]) === false) {
        // 项目级普通条目可以直接创建；只有 override 需要全局 base。
      }
      if (scope === 'project' && entry.overrideOnly === true) {
        const v = validateOverride(name, entry.config, userTable);
        if (!v.ok) return v;
        const cross = parseMcpServers(
          { mcpServers: { [name]: v.patch } },
          { scope: 'project', takenNames: globalNames },
        );
        if (cross.error || cross.invalid.length) {
          return resultError('config-conflict', cross.invalid[0] || '项目覆盖与全局 namespace 冲突');
        }
        prepared.push([name, v.patch]);
        continue;
      }
      const normalized = normalizeInput(entry.config, { scope, existingEntry: isRecord(table[name]) ? table[name] : null });
      if (!normalized.ok) return normalized;
      if (scope === 'project' && isRecord(userTable[name]) && !confirmOverride) {
        return { ...resultError('scope-conflict', `用户级已有同名 server “${name}”`, 'name'), canOverride: true, name };
      }
      const parsed = validateAgainstParser(name, normalized.config, scope);
      if (!parsed.ok) return parsed;
      if (scope === 'project') {
        const cross = parseMcpServers(
          { mcpServers: { [name]: normalized.config } },
          { scope: 'project', takenNames: globalNames },
        );
        if (cross.error || cross.invalid.length) {
          return resultError('config-conflict', cross.invalid[0] || '项目条目与全局 namespace 冲突');
        }
      }
      prepared.push([name, normalized.config]);
    }
    for (const [name, config] of prepared) table[name] = config;
    const whole = parseMcpServers({ mcpServers: table }, { scope });
    if (whole.error || whole.invalid.length) {
      return resultError('config-conflict', whole.invalid[0] || '整份 mcp.json 未通过 Pi 的校验');
    }
    const text = serializeConfig(data, state.raw);
    let backup;
    try {
      backup = writeAtomic(file, text, now());
    } catch (err) {
      return resultError(err.code || 'write-failed', `写入 mcp.json 失败（${clip(err.message, 100)}），原文件未被修改`);
    }
    return { ok: true, scope, names: prepared.map(([n]) => n), backup, revision: sha256(text), reloadRequired: true };
  }

  return {
    revisions,
    getDetail,
    save,
    remove,
    setEnabled,
    importMany,
    _internals: {
      MAX_CONFIG_BYTES,
      MAX_BACKUPS,
      mcpFiles,
      normalizeInput,
      validateOverride,
      writeAtomic,
      readFileState,
      isReference,
      isHeaderReference,
    },
  };
}
