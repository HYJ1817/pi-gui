/* 从其他 MCP 客户端导入配置 —— **只读扫描，绝不改来源文件**。
 *
 * 覆盖 Claude Desktop / Cursor / VS Code（含当前项目的 .cursor 与 .vscode）。
 * 扫描结果刻意不包含 env / header 的明文值：敏感字面值直接判为不可导入，
 * `!command` 与未解析的 `${input:...}` 也拒绝。真正导入时由服务端重新扫描，
 * 客户端只提交条目 ID 与重命名/scope —— 配置值不经过 renderer。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_ENTRIES = 100;
const SECRET_NAME_RE = /(^|[_-])(token|secret|password|passwd|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|auth)([_-]|$)/i;
const SECRET_VALUE_RE = /^(?:sk-|pk-|gh[pousr]_|github_pat_|AKIA|ASIA|xox[baprs]-|eyJ[A-Za-z0-9_-]{10,}\.)/;
const REFERENCE_RE = /^(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+[ \t]+)?\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const ENV_REF_RE = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;
const UNRESOLVED_RE = /\$\{(?:input|command|workspaceFolder|file|config|selectedText|lineNumber|columnNumber)[^}]*\}/;

function isRecord(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function clip(s, max = 300) { const t = String(s ?? ''); return t.length > max ? t.slice(0, max) + '…' : t; }
function cleanText(s, max = 300) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function err(code, message, extra = {}) { return { ok: false, code, error: message, ...extra }; }

/** 去掉 JSONC 的注释与尾逗号；字符串内容原样保留（不用正则碰字符串内部）。 */
function stripJsonc(text) {
  const src = String(text || '').replace(/^﻿/, '');
  let out = '';
  let inString = false;
  let quote = '"';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const n = src[i + 1];
    if (lineComment) {
      if (c === '\n') { lineComment = false; out += c; }
      continue;
    }
    if (blockComment) {
      if (c === '*' && n === '/') { blockComment = false; i += 1; }
      else if (c === '\n') out += c;
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") { inString = true; quote = c; out += c; continue; }
    if (c === '/' && n === '/') { lineComment = true; i += 1; continue; }
    if (c === '/' && n === '*') { blockComment = true; i += 1; continue; }
    out += c;
  }
  /* 尾逗号：只在字符串外删除。 */
  let out2 = '';
  inString = false;
  escaped = false;
  for (let i = 0; i < out.length; i += 1) {
    const c = out[i];
    if (inString) {
      out2 += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out2 += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j += 1;
      if (out[j] === '}' || out[j] === ']') continue;
    }
    out2 += c;
  }
  return out2;
}

function sensitiveFlag(arg) {
  return /^--?[^=]+$/.test(arg) && isSensitiveName(arg.replace(/^--?/, ''));
}

function secretArgReason(args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (SECRET_VALUE_RE.test(a)) return 'args 含有明文凭据；请先在来源工具里改成环境变量引用';
    if (/^authorization\s*:/i.test(a) && !REFERENCE_RE.test(a)) return 'args 里的 Authorization 含有明文凭据；请改用环境变量引用';
    if (/^https?:\/\//i.test(a)) {
      try {
        const u = new URL(a);
        if (u.username || u.password) return 'args 里的 URL 含有用户名或密码';
        if ([...u.searchParams.keys()].some((k) => /token|secret|key|password|auth|signature/i.test(k))) {
          return 'args 里的 URL 查询串疑似包含凭据';
        }
      } catch { /* 非法 URL 留给配置校验 */ }
    }
    if (sensitiveFlag(a)) {
      const next = args[i + 1];
      if (typeof next === 'string' && next && !REFERENCE_RE.test(next)) {
        return `args 的 ${a} 参数含有明文凭据；请先在来源工具里改成环境变量引用`;
      }
    }
    const eq = /^(--?[^=]+)=(.+)$/.exec(a);
    if (eq && isSensitiveName(eq[1].replace(/^--?/, '')) && !REFERENCE_RE.test(eq[2])) {
      return `args 的 ${eq[1]} 参数含有明文凭据；请先在来源工具里改成环境变量引用`;
    }
  }
  return '';
}

function maskUrlArg(raw) {
  try {
    const u = new URL(raw);
    if (u.username || u.password) { u.username = '***'; u.password = ''; }
    for (const key of [...u.searchParams.keys()]) {
      if (/token|secret|key|password|auth|signature/i.test(key)) u.searchParams.set(key, '***');
    }
    return u.toString();
  } catch {
    return raw;
  }
}

function maskArg(arg, previousWasSensitiveFlag = false) {
  const s = String(arg);
  if (previousWasSensitiveFlag) return '***';
  if (SECRET_VALUE_RE.test(s)) return '***';
  if (/^authorization\s*:/i.test(s)) return s.replace(/:\s*.*$/, ': ***');
  if (/^https?:\/\//i.test(s)) return maskUrlArg(s);
  const eq = /^(--?[^=]+)=(.+)$/.exec(s);
  if (eq && isSensitiveName(eq[1].replace(/^--?/, ''))) return `${eq[1]}=***`;
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

/* 冲突预览只比较结构：传输、参数个数、env/header 的**键名**、启用状态与
 * 授权面。命令、URL、env/header 的值一律不进来 —— 扫描结果可能被贴进
 * 公开 issue，预览也没有必要拿到这些原文。 */
function shapeFromDetail(detail) {
  if (!detail || detail.ok !== true) return null;
  const entry = detail.entry || {};
  return {
    overrideOnly: detail.overrideOnly === true,
    transport: detail.overrideOnly ? 'inherited' : (entry.type === 'http' ? 'http' : 'stdio'),
    argsCount: Array.isArray(entry.args) ? entry.args.length : 0,
    envKeys: Array.isArray(entry.env) ? entry.env.map((row) => row.key).filter(Boolean).sort() : [],
    headerKeys: Array.isArray(entry.headers) ? entry.headers.map((row) => row.key).filter(Boolean).sort() : [],
    enabled: entry.enabled !== false,
    exposure: typeof entry.exposure === 'string' ? entry.exposure : '',
    oauth: entry.oauth === true,
    auth: entry.auth === true,
  };
}

function shapeFromIncoming(normalized) {
  return {
    overrideOnly: false,
    transport: normalized.transport,
    argsCount: normalized.argsCount || 0,
    envKeys: normalized.env.map((row) => row.key).filter(Boolean).sort(),
    headerKeys: normalized.headers.map((row) => row.key).filter(Boolean).sort(),
    enabled: true,
    // 导入的完整条目不会带 exposure；Pi 对完整条目的默认是 codemode。
    exposure: '',
    oauth: false,
    auth: false,
  };
}

function diffShapes(existing, incoming) {
  if (!existing || !incoming) return [];
  const out = [];
  if (existing.transport !== incoming.transport) {
    out.push({ field: 'transport', from: existing.transport, to: incoming.transport });
  }
  if (existing.overrideOnly) {
    out.push({ field: 'entry', from: '项目覆盖条目', to: '完整条目' });
  } else {
    if (existing.argsCount !== incoming.argsCount) {
      out.push({ field: 'args', from: existing.argsCount, to: incoming.argsCount });
    }
    const added = (a, b) => b.filter((k) => !a.includes(k));
    const removed = (a, b) => a.filter((k) => !b.includes(k));
    const envAdded = added(existing.envKeys, incoming.envKeys);
    const envRemoved = removed(existing.envKeys, incoming.envKeys);
    if (envAdded.length || envRemoved.length) out.push({ field: 'env', added: envAdded, removed: envRemoved });
    const headAdded = added(existing.headerKeys, incoming.headerKeys);
    const headRemoved = removed(existing.headerKeys, incoming.headerKeys);
    if (headAdded.length || headRemoved.length) out.push({ field: 'headers', added: headAdded, removed: headRemoved });
  }
  if (existing.enabled === false && incoming.enabled !== false) {
    out.push({ field: 'enabled', from: '已停用', to: '已启用' });
  }
  if (existing.oauth || existing.auth) {
    out.push({ field: 'auth', from: '现有 OAuth / auth 配置', to: '会被移除', warn: true });
  }
  if (existing.exposure && existing.exposure !== incoming.exposure) {
    out.push({ field: 'exposure', from: existing.exposure, to: incoming.exposure || '默认（codemode）' });
  }
  return out;
}

function commandSummary(command, args) {
  const list = Array.isArray(args) ? args.slice(0, 8) : [];
  const out = [command];
  let previousWasSensitiveFlag = false;
  for (const arg of list) {
    out.push(maskArg(arg, previousWasSensitiveFlag));
    previousWasSensitiveFlag = sensitiveFlag(String(arg));
  }
  return out.join(' ');
}

function displayPath(file, env) {
  const home = env.HOME || env.USERPROFILE || '';
  const appData = env.APPDATA || '';
  let out = String(file);
  if (appData && out.toLowerCase().startsWith(appData.toLowerCase())) out = '%APPDATA%' + out.slice(appData.length);
  else if (home && out.toLowerCase().startsWith(home.toLowerCase())) out = '~' + out.slice(home.length);
  return out.replace(/\\/g, '/');
}

function sourceCandidates(env, cwd) {
  const home = env.HOME || env.USERPROFILE || '';
  const appData = env.APPDATA || (home && path.join(home, 'AppData', 'Roaming'));
  const platform = process.platform;
  const list = [];
  const add = (tool, label, file, format) => {
    if (!file) return;
    list.push({ tool, label, file, format });
  };
  if (platform === 'win32') {
    add('claude-desktop', 'Claude Desktop', appData && path.join(appData, 'Claude', 'claude_desktop_config.json'), 'mcpServers');
    add('cursor', 'Cursor', home && path.join(home, '.cursor', 'mcp.json'), 'mcpServers');
    add('vscode', 'VS Code', appData && path.join(appData, 'Code', 'User', 'settings.json'), 'vscode-settings');
    add('vscode-insiders', 'VS Code Insiders', appData && path.join(appData, 'Code - Insiders', 'User', 'settings.json'), 'vscode-settings');
  } else if (platform === 'darwin') {
    add('claude-desktop', 'Claude Desktop', home && path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), 'mcpServers');
    add('cursor', 'Cursor', home && path.join(home, '.cursor', 'mcp.json'), 'mcpServers');
    add('vscode', 'VS Code', home && path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json'), 'vscode-settings');
  } else {
    add('claude-desktop', 'Claude Desktop', home && path.join(home, '.config', 'Claude', 'claude_desktop_config.json'), 'mcpServers');
    add('cursor', 'Cursor', home && path.join(home, '.cursor', 'mcp.json'), 'mcpServers');
    add('vscode', 'VS Code', home && path.join(home, '.config', 'Code', 'User', 'settings.json'), 'vscode-settings');
  }
  if (cwd) {
    add('cursor-project', 'Cursor（当前项目）', path.join(cwd, '.cursor', 'mcp.json'), 'mcpServers');
    add('vscode-project', 'VS Code（当前项目）', path.join(cwd, '.vscode', 'mcp.json'), 'vscode-mcp');
  }
  return list;
}

function readSource(file) {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return { exists: true, error: 'symlink', data: null };
    if (!st.isFile() || st.size > MAX_SOURCE_BYTES) return { exists: true, error: 'unreadable', data: null };
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    return { exists: true, error: '', data: JSON.parse(stripJsonc(raw)) };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { exists: false, error: '', data: null };
    return { exists: true, error: e instanceof SyntaxError ? 'invalid-json' : 'unreadable', data: null };
  }
}

function serverTable(data, format) {
  if (!isRecord(data)) return null;
  if (format === 'vscode-settings') {
    if (isRecord(data.mcp) && isRecord(data.mcp.servers)) return data.mcp.servers;
    if (isRecord(data.mcpServers)) return data.mcpServers;
    return null;
  }
  if (format === 'vscode-mcp') return isRecord(data.servers) ? data.servers : (isRecord(data.mcpServers) ? data.mcpServers : null);
  return isRecord(data.mcpServers) ? data.mcpServers : null;
}

function isSensitiveName(name) {
  return SECRET_NAME_RE.test(String(name)) || /authorization|credential/i.test(String(name));
}

function classifyValue(key, value, { headers = false } = {}) {
  if (typeof value !== 'string') return { ok: false, code: 'invalid-value', reason: `${key} 的值不是字符串` };
  if (value.startsWith('!')) return { ok: false, code: 'shell-command', reason: `${key} 使用了 !command 形式，Pi GUI 不会执行来源工具里的命令` };
  if (UNRESOLVED_RE.test(value)) return { ok: false, code: 'unresolved-input', reason: `${key} 含有来源工具的输入占位符，无法安全展开` };
  const envMatch = ENV_REF_RE.exec(value);
  if (envMatch) return { ok: true, value: `\${${envMatch[1]}}`, reference: true };
  const schemedEnv = /^((?:[!#$%&'*+.^_`|~0-9A-Za-z-]+[ \t]+)?)\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  if (schemedEnv) return { ok: true, value: `${schemedEnv[1]}\${${schemedEnv[2]}}`, reference: true };
  if (REFERENCE_RE.test(value)) return { ok: true, value, reference: true };
  if (isSensitiveName(key) || (headers && /^(?:bearer|basic|token|digest|negotiate)\s+/i.test(value)) || SECRET_VALUE_RE.test(value)) {
    return { ok: false, code: 'plaintext-secret', reason: `${key} 含有明文凭据；请先在来源工具里改成环境变量引用` };
  }
  return { ok: true, value, reference: false };
}

function normalizeEntry(raw) {
  if (!isRecord(raw)) return err('invalid-entry', '条目不是对象');
  const type = raw.type === 'sse' || raw.type === 'sse-only' ? 'sse' : raw.type === 'http' || raw.type === 'streamable-http' ? 'http' : raw.type === 'stdio' ? 'stdio' : (raw.url ? 'http' : 'stdio');
  if (type === 'sse') return err('unsupported-sse', 'Pi 不支持旧版 SSE transport');
  if (raw.envFile) return err('env-file', '该条目依赖 envFile，Pi GUI 不会读取来源工具的文件');
  if (type === 'stdio') {
    if (typeof raw.command !== 'string' || !raw.command.trim()) return err('invalid-entry', 'stdio 条目缺少 command');
    if (/[\u0000-\u001f\u007f]/.test(raw.command) || /\$\{/.test(raw.command)) return err('invalid-entry', 'command 含有控制字符或占位符');
    const args = Array.isArray(raw.args) ? raw.args : [];
    if (args.length > 32 || args.some((a) => typeof a !== 'string' || a.length > 1024 || /[\u0000]/.test(a) || UNRESOLVED_RE.test(a) || /\$\{env:/.test(a) || a.startsWith('!'))) {
      return err('invalid-entry', 'args 不合法或含有未解析的占位符');
    }
    const argSecret = secretArgReason(args);
    if (argSecret) return err('plaintext-secret', argSecret);
    const env = [];
    if (raw.env !== undefined) {
      if (!isRecord(raw.env)) return err('invalid-entry', 'env 不是对象');
      for (const [key, value] of Object.entries(raw.env)) {
        const v = classifyValue(key, value);
        if (!v.ok) return err(v.code, v.reason);
        if (v.value.length > 1024) return err('invalid-value', `env ${key} 过长`);
        env.push({ key, value: v.value, reference: v.reference });
      }
    }
    const config = { transport: 'stdio', command: raw.command.trim(), args, ...(env.length ? { env } : {}) };
    if (typeof raw.cwd === 'string' && raw.cwd && !/[\u0000-\u001f\u007f]/.test(raw.cwd)) config.cwd = raw.cwd;
    return { ok: true, config, transport: 'stdio', commandSummary: commandSummary(config.command, args), argsCount: args.length, env, headers: [] };
  }
  if (typeof raw.url !== 'string' || !raw.url.trim()) return err('invalid-entry', 'HTTP 条目缺少 url');
  let u;
  try { u = new URL(raw.url); } catch { return err('invalid-url', 'URL 不合法'); }
  if (!/^https?:$/.test(u.protocol)) return err('invalid-url', 'URL 只支持 http / https');
  if (u.username || u.password) return err('protected-url', 'URL 含有用户名或密码');
  if ([...u.searchParams.keys()].some((k) => /token|secret|key|password|auth|signature/i.test(k))
    || [...u.searchParams.values()].some((v) => SECRET_VALUE_RE.test(v))
    || SECRET_VALUE_RE.test(u.pathname)) {
    return err('protected-url', 'URL 查询串或路径疑似包含凭据；请先在来源工具里改成 header 环境变量引用');
  }
  const headers = [];
  if (raw.headers !== undefined) {
    if (!isRecord(raw.headers)) return err('invalid-entry', 'headers 不是对象');
    for (const [key, value] of Object.entries(raw.headers)) {
      const v = classifyValue(key, value, { headers: true });
      if (!v.ok) return err(v.code, v.reason);
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) return err('invalid-entry', `header 名 ${key} 不合法`);
      if (v.value.length > 1024) return err('invalid-value', `header ${key} 过长`);
      headers.push({ key, value: v.value, reference: v.reference });
    }
  }
  const config = { transport: 'http', url: raw.url.trim(), ...(headers.length ? { headers } : {}) };
  return {
    ok: true,
    config,
    transport: 'http',
    commandSummary: '',
    urlPreview: u.toString(),
    urlProtected: false,
    argsCount: 0,
    env: [],
    headers,
  };
}

export function createMcpImporter({ runtime, env = process.env, listServers = null, readTrust = null, configStore = null } = {}) {
  function cwd() {
    const v = runtime && typeof runtime.getCurrentCwd === 'function' ? runtime.getCurrentCwd() : null;
    return typeof v === 'string' && v ? v : null;
  }

  async function existingServers() {
    try {
      const rows = typeof listServers === 'function' ? await listServers() : [];
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  async function scan() {
    const candidates = sourceCandidates(env, cwd());
    const tools = [];
    const entries = [];
    for (const source of candidates) {
      const read = readSource(source.file);
      const table = read.data ? serverTable(read.data, source.format) : null;
      const tool = {
        id: source.tool,
        name: source.label,
        path: displayPath(source.file, env),
        detected: Boolean(read.exists),
        readable: Boolean(read.data && table),
        error: read.error || (read.exists && !table ? 'no-servers' : ''),
        count: 0,
      };
      if (table) {
        for (const [name, raw] of Object.entries(table).slice(0, MAX_ENTRIES)) {
          const normalized = normalizeEntry(raw);
          const item = {
            id: `${source.tool}:${name}`,
            source: source.tool,
            sourceLabel: source.label,
            name,
            transport: normalized.ok ? normalized.transport : '',
            commandSummary: normalized.ok ? normalized.commandSummary : '',
            urlPreview: normalized.ok ? (normalized.urlPreview || '') : '',
            urlProtected: Boolean(normalized.ok && normalized.urlProtected),
            argsCount: normalized.ok ? normalized.argsCount : 0,
            envKeys: normalized.ok ? normalized.env.map((e) => e.key) : [],
            headerKeys: normalized.ok ? normalized.headers.map((e) => e.key) : [],
            status: normalized.ok ? 'importable' : 'blocked',
            reason: normalized.ok ? '' : normalized.error,
            code: normalized.ok ? '' : normalized.code,
            conflicts: [],
            _config: normalized.ok ? normalized.config : null,
            _shape: normalized.ok ? shapeFromIncoming(normalized) : null,
            _rawName: name,
          };
          entries.push(item);
          tool.count += 1;
        }
      }
      tools.push(tool);
    }

    const existing = await existingServers();
    const existingByName = new Map();
    for (const s of existing) {
      if (!s || typeof s.name !== 'string') continue;
      const arr = existingByName.get(s.name) || [];
      arr.push({ scope: s.scope === 'project' ? 'project' : 'user', server: s });
      existingByName.set(s.name, arr);
    }
    /* 冲突条目的结构预览：逐条读配置详情，但只取 shapeFromDetail 的白名单字段。
     * 读不到详情时仍标冲突，只是 diff 为空（不阻断导入）。 */
    const details = new Map();
    if (configStore) {
      const jobs = [];
      for (const e of entries) {
        for (const target of existingByName.get(e.name) || []) {
          const key = `${target.scope}:${e.name}`;
          if (details.has(key)) continue;
          details.set(key, null);
          jobs.push((async () => {
            try {
              const d = await configStore.getDetail({ scope: target.scope, name: e.name });
              if (d && d.ok === true) details.set(key, shapeFromDetail(d));
            } catch { /* 读不到详情时保留空 diff */ }
          })());
        }
      }
      await Promise.all(jobs);
    }
    const byName = new Map();
    for (const e of entries) {
      const arr = byName.get(e.name) || [];
      arr.push(e);
      byName.set(e.name, arr);
    }
    for (const e of entries) {
      e.conflicts = [];
      const targets = existingByName.get(e.name);
      if (targets) {
        for (const target of targets) {
          const key = `${target.scope}:${e.name}`;
          e.conflicts.push({ kind: 'existing', scope: target.scope, diff: diffShapes(details.get(key), e._shape) });
        }
      }
      const peers = (byName.get(e.name) || []).filter((o) => o !== e);
      if (peers.length) e.conflicts.push(...peers.map((o) => ({ kind: 'scanned', source: o.source })));
    }
    const detected = tools.filter((t) => t.detected).length;
    return {
      ok: true,
      tools,
      entries: entries.map(({ _config, _shape, _rawName, ...rest }) => rest),
      detected,
      importable: entries.filter((e) => e.status === 'importable').length,
      blocked: entries.filter((e) => e.status === 'blocked').length,
      trust: await (async () => {
        try {
          const t = typeof readTrust === 'function' ? await readTrust() : null;
          return t && typeof t === 'object' ? { trusted: t.trusted === true ? true : t.trusted === false ? false : null } : { trusted: null };
        } catch { return { trusted: null }; }
      })(),
    };
  }

  async function apply(input = {}) {
    const scope = input.scope === 'project' ? 'project' : input.scope === 'user' ? 'user' : null;
    if (!scope) return err('bad-scope', 'scope 只能是 user 或 project');
    const ids = Array.isArray(input.ids) ? input.ids.filter((id) => typeof id === 'string') : [];
    if (!ids.length || ids.length > 50) return err('bad-selection', '请选择 1–50 个条目');
    const all = [];
    /* scan() 的公开 entries 不带配置，这里重新读一次内部表。 */
    const candidates = sourceCandidates(env, cwd());
    for (const source of candidates) {
      const read = readSource(source.file);
      const table = read.data ? serverTable(read.data, source.format) : null;
      if (!table) continue;
      for (const [name, raw] of Object.entries(table).slice(0, MAX_ENTRIES)) {
        all.push({ id: `${source.tool}:${name}`, source: source.tool, name, raw });
      }
    }
    const selected = [];
    for (const id of ids) {
      const row = all.find((e) => e.id === id);
      if (!row) return err('not-found', `扫描结果里已找不到条目 ${id}`);
      const normalized = normalizeEntry(row.raw);
      if (!normalized.ok) {
        return err('source-blocked', `${row.name} 无法导入：${normalized.error}`, { id });
      }
      selected.push({ ...row, normalized });
    }
    const rename = isRecord(input.rename) ? input.rename : {};
    const names = new Set();
    const prepared = [];
    for (const row of selected) {
      const requested = typeof rename[row.id] === 'string' && rename[row.id].trim() ? rename[row.id].trim() : row.name;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(requested)) {
        return err('bad-name', `“${requested}” 不是合法的 server 名（字母、数字、_、-，最多 64 字符）`, { id: row.id });
      }
      if (names.has(requested)) {
        return err('name-conflict', `导入列表里有重复的 server 名 “${requested}”，请先重命名其中一个`, { name: requested });
      }
      names.add(requested);
      prepared.push({ id: row.id, name: requested, config: row.normalized.config });
    }
    if (!configStore || typeof configStore.importMany !== 'function') return err('not-wired', '导入写入器未装配');
    const save = await configStore.importMany({
      scope,
      entries: prepared,
      expectedRevision: input.expectedRevision,
      allowReplace: input.allowReplace === true,
      confirmOverride: input.confirmOverride === true,
    });
    if (!save.ok) return save;
    return {
      ...save,
      imported: prepared.map((p) => p.name),
      configured: true,
      connected: null,
      loaded: null,
      connectionState: 'untested',
      loadState: 'reload-required',
      message: '配置已写入。运行中的 Pi 会话尚未加载它们，也没有验证连接。',
    };
  }

  return { scan, apply, _internals: { stripJsonc, normalizeEntry, serverTable, sourceCandidates, classifyValue, displayPath } };
}
