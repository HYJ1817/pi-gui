/* MCP 市场：内置精选目录 + 官方 MCP Registry + 可添加的第三方源。
 *
 * 三条硬边界：
 *   1. **安装只认服务端解析结果。** 客户端只发 catalogId（外加 scope / revision），
 *      绝不发 command / url / args。内置条目、Registry 条目、第三方源条目都由
 *      这里重新查一次并用自己的白名单模板构造配置 —— 市场响应是数据，不是代码。
 *   2. **远端响应一律当不可信输入。** 固定 HTTPS、禁止重定向、超时、限长、
 *      解析前先做 DNS 私网检查；第三方源只允许 npx / uvx 作为 stdio 命令。
 *   3. **信任标记必须有出处。** 内置条目标 "官方仓库" 并给出链接；Registry
 *      条目标 "官方 Registry 收录（未审核安全性）"；第三方源一律 community，
 *      不采信源里自称的 trust。
 *
 * 目录本身是离线可用的：远端失败时内置精选仍然完整可见。
 */
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { settingNeedsReference, writeJsonAtomic } from './mcp-config.js';

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io/v0/servers';
const SOURCES_FILE = 'mcp-market-sources.json';
const CACHE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCES = 10;
const MAX_REGISTRY_ENTRIES = 50;
const CATEGORIES = ['全部', '开发工具', '网络', '文档', '数据', '效率'];
const NPM_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SETTING_REFERENCE_RE = /^(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+[ \t]+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const REMOTE_COMMANDS = new Set(['npx', 'uvx']);

function isRecord(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function clip(s, max = 300) { const t = String(s ?? ''); return t.length > max ? t.slice(0, max) + '…' : t; }
function cleanText(s, max = 500) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function codeError(code, error, extra = {}) { return { ok: false, code, error, ...extra }; }

/* ---------------- 内置精选目录 ----------------
 *
 * `args` 里的 `{key}` 必须是**独立参数**（整项恰好是占位符），安装时只替换
 * 目录自己声明的字段。这样客户端无法把 `{x}` 拼进别的参数里改变命令形状。
 * 依赖探测只读 PATH，不 spawn、不联网。
 */
const BUILTIN = [
  {
    id: 'memory', name: 'Memory', identifier: 'modelcontextprotocol/server-memory',
    category: '效率', trust: 'official',
    trustEvidence: 'Anthropic 官方仓库 modelcontextprotocol/servers（src/memory）',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    description: '基于知识图谱的长期记忆，让 Agent 在会话之间保留实体、关系与观察。',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'],
    requires: ['node', 'npx'],
    envFields: [{
      key: 'memoryFile', label: '记忆文件路径（可选）', envKey: 'MEMORY_FILE_PATH',
      type: 'path', required: false, placeholder: '例如 C:\\Users\\me\\.pi\\memory.json',
    }],
  },
  {
    id: 'sequential-thinking', name: 'Sequential Thinking', identifier: 'modelcontextprotocol/server-sequential-thinking',
    category: '效率', trust: 'official',
    trustEvidence: 'Anthropic 官方仓库 modelcontextprotocol/servers（src/sequentialthinking）',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    description: '把复杂问题拆成可修订的连续思考步骤，适合规划、排错与多步推理。',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    requires: ['node', 'npx'],
  },
  {
    id: 'everything', name: 'Everything', identifier: 'modelcontextprotocol/server-everything',
    category: '开发工具', trust: 'official',
    trustEvidence: 'Anthropic 官方仓库 modelcontextprotocol/servers（src/everything）',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
    description: 'MCP 官方测试服务器，覆盖 tools / resources / prompts 等全部能力，用于验证客户端兼容性。',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'],
    requires: ['node', 'npx'],
    warning: '这是测试服务器，不适合承载真实数据。',
  },
  {
    id: 'filesystem', name: 'Filesystem', identifier: 'modelcontextprotocol/server-filesystem',
    category: '开发工具', trust: 'official',
    trustEvidence: 'Anthropic 官方仓库 modelcontextprotocol/servers（src/filesystem）',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    description: '在明确授权的目录内读写文件。权限边界由你填写的目录决定，请只授予必要范围。',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '{path}'],
    requires: ['node', 'npx'],
    fields: [{
      key: 'path', label: '允许访问的目录', type: 'path', required: true,
      mustExist: true, directory: true, placeholder: '例如 C:\\projects\\demo',
    }],
    warning: '该服务器能读写所选目录中的文件；不要授予主目录或整个磁盘。',
  },
  {
    id: 'playwright', name: 'Playwright', identifier: '@playwright/mcp',
    category: '开发工具', trust: 'official',
    trustEvidence: 'Microsoft 官方仓库 microsoft/playwright-mcp',
    homepage: 'https://github.com/microsoft/playwright-mcp',
    description: '用无障碍树驱动浏览器：导航、点击、填表、截图，适合端到端验证与网页调研。',
    transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'],
    requires: ['node', 'npx'],
    warning: '首次运行可能下载浏览器；安装前请确认网络与磁盘占用。',
  },
  {
    id: 'context7', name: 'Context7', identifier: 'context7',
    category: '文档', trust: 'verified',
    trustEvidence: 'Upstash 提供的公开 MCP 端点（mcp.context7.com），非 Anthropic 官方',
    homepage: 'https://github.com/upstash/context7',
    description: '按库名查询最新版文档与代码示例，减少模型凭记忆编造 API。',
    transport: 'http', url: 'https://mcp.context7.com/mcp',
    requires: [],
    headerFields: [{
      key: 'apiKeyEnv', label: 'API Key 的环境变量名（可选）', envRef: true,
      header: 'Authorization', prefix: 'Bearer ', placeholder: 'CONTEXT7_API_KEY',
      help: '填写的是“变量名”，不是 Key 本身；Pi 启动时会从系统环境读取它的值。',
    }],
  },
  {
    id: 'fetch', name: 'Fetch', identifier: 'mcp-server-fetch',
    category: '网络', trust: 'official',
    trustEvidence: 'Anthropic 官方仓库 modelcontextprotocol/servers（src/fetch）',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    description: '抓取网页并转成 Markdown，支持 robots.txt 与分页读取，适合资料收集。',
    transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'],
    requires: ['python', 'uv', 'uvx'],
  },
  {
    id: 'git', name: 'Git', identifier: 'mcp-server-git',
    category: '开发工具', trust: 'official',
    trustEvidence: 'Anthropic 官方仓库 modelcontextprotocol/servers（src/git）',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    description: '只读浏览仓库状态、提交、分支与 diff；写操作仍由你明确发起。',
    transport: 'stdio', command: 'uvx', args: ['mcp-server-git'],
    requires: ['python', 'uv', 'uvx', 'git'],
    envFields: [{
      key: 'repo', label: '仓库路径（可选）', envKey: 'GIT_REPOSITORY_PATH',
      type: 'path', required: false, mustExist: true, directory: true, placeholder: '留空则使用当前项目',
    }],
  },
  {
    id: 'time', name: 'Time', identifier: 'mcp-server-time',
    category: '效率', trust: 'official',
    trustEvidence: 'Anthropic 官方仓库 modelcontextprotocol/servers（src/time）',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    description: '时区转换与当前时间查询，使用 IANA 时区名，避免跨时区排期出错。',
    transport: 'stdio', command: 'uvx', args: ['mcp-server-time'],
    requires: ['python', 'uv', 'uvx'],
  },
  {
    id: 'serena', name: 'Serena', identifier: 'oraios/serena',
    category: '开发工具', trust: 'community',
    trustEvidence: '社区项目 oraios/serena（GitHub），未经过 Anthropic 审核',
    homepage: 'https://github.com/oraios/serena',
    description: '基于语言服务器的代码理解与编辑助手，提供符号级检索、引用与项目记忆。',
    transport: 'stdio', command: 'uvx',
    args: ['--from', 'git+https://github.com/oraios/serena', 'serena', 'start-mcp-server', '--context', 'ide-assistant'],
    requires: ['python', 'uv', 'uvx', 'git'],
    warning: '安装时会从 GitHub 拉取项目源码；请确认你信任该来源。',
  },
];

function builtinItems() {
  return BUILTIN.map((e) => ({
    id: `builtin:${e.id}`,
    source: 'builtin',
    sourceLabel: '内置精选',
    catalogId: e.id,
    name: e.name,
    installName: e.id,
    identifier: e.identifier,
    version: '',
    category: e.category,
    trust: e.trust,
    trustEvidence: e.trustEvidence,
    description: e.description,
    transport: e.transport,
    commandSummary: e.transport === 'stdio' ? [e.command, ...e.args].join(' ') : '',
    urlPreview: e.url || '',
    homepage: e.homepage || '',
    requires: e.requires || [],
    fields: (e.fields || []).map(({ key, label, type, required, placeholder }) => ({ key, label, type, required: Boolean(required), placeholder: placeholder || '' })),
    envFields: (e.envFields || []).map(({ key, label, required, placeholder }) => ({ key, label, required: Boolean(required), placeholder: placeholder || '', secret: false })),
    headerFields: (e.headerFields || []).map(({ key, label, required, placeholder, help }) => ({ key, label, required: Boolean(required), placeholder: placeholder || '', help: help || '' })),
    warning: e.warning || '',
    installable: true,
    installReason: '',
  }));
}

/* ---------------- 通用安全网络读取 ---------------- */

function hostnameOf(u) {
  return String(u.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
}

/* IPv6 必须按 8 个 hextet 解析后再判私网；字符串前缀判断会漏掉
 * `::ffff:7f00:1`（IPv4-mapped 十六进制）和 `::ffff:0:7f00:1`
 * （IPv4-translated），它们都能把服务端请求带到 127.0.0.1。 */
function ipv6Hextets(ip) {
  let s = String(ip || '').toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  s = s.replace(/^\[|\]$/g, '');
  if (!net.isIPv6(s)) return null;
  const parse = (part) => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    return parseInt(part, 16);
  };
  if (s.includes('::')) {
    const [left, right] = s.split('::');
    const l = left ? left.split(':') : [];
    const r = right ? right.split(':') : [];
    if (l.length + r.length > 7) return null;
    const values = [...l, ...new Array(8 - l.length - r.length).fill('0'), ...r].map(parse);
    return values.some((v) => v === null) ? null : values;
  }
  const parts = s.split(':');
  if (parts.length !== 8) return null;
  const values = parts.map(parse);
  return values.some((v) => v === null) ? null : values;
}

function embeddedIpv4(parts) {
  const hi = parts[6];
  const lo = parts[7];
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isPrivateIp(ip) {
  if (typeof ip !== 'string') return true;
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b, c] = p;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0 && c === 0) return true;
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const parts = ipv6Hextets(ip);
    if (!parts) return true;
    if (parts.every((v) => v === 0)) return true;
    if (parts.slice(0, 7).every((v) => v === 0) && parts[7] === 1) return true;
    /* fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast. */
    if ((parts[0] & 0xfe00) === 0xfc00) return true;
    if ((parts[0] & 0xffc0) === 0xfe80) return true;
    if ((parts[0] & 0xff00) === 0xff00) return true;
    /* 2001:db8::/32 documentation. */
    if (parts[0] === 0x2001 && parts[1] === 0x0db8) return true;
    /* ::ffff:a.b.c.d (IPv4-mapped) and ::ffff:0:a.b.c.d (IPv4-translated). */
    if (parts.slice(0, 5).every((v) => v === 0) && parts[5] === 0xffff) {
      return isPrivateIp(embeddedIpv4(parts));
    }
    if (parts.slice(0, 4).every((v) => v === 0) && parts[4] === 0xffff && parts[5] === 0) {
      return isPrivateIp(embeddedIpv4(parts));
    }
    /* IPv4-compatible ::a.b.c.d (deprecated but still parseable). */
    if (parts.slice(0, 6).every((v) => v === 0)) return isPrivateIp(embeddedIpv4(parts));
    /* 64:ff9b::/96 NAT64 embeds IPv4 in the last 32 bits; 2002::/16 6to4
     * embeds it in hextets 1–2. */
    if (parts[0] === 0x0064 && parts[1] === 0xff9b) return isPrivateIp(embeddedIpv4(parts));
    if (parts[0] === 0x2002) {
      const hi = parts[1];
      const lo = parts[2];
      return isPrivateIp(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    return false;
  }
  return true;
}

function blockedHostname(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return !h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
}

async function assertPublicHttps(rawUrl, lookupImpl) {
  let u;
  try { u = new URL(rawUrl); } catch { return codeError('blocked-url', 'URL 不是合法地址'); }
  if (u.protocol !== 'https:') return codeError('blocked-url', '市场源只允许 HTTPS');
  if (u.username || u.password) return codeError('blocked-url', 'URL 不能包含用户名或密码');
  if (u.port && u.port !== '443') return codeError('blocked-url', '市场源只允许 443 端口');
  const hostname = hostnameOf(u);
  if (blockedHostname(hostname)) return codeError('blocked-host', '不允许访问本机或内网主机');
  if (net.isIP(hostname) && isPrivateIp(hostname)) return codeError('blocked-host', '不允许访问本机或内网地址');
  try {
    const rows = await lookupImpl(hostname, { all: true });
    const list = Array.isArray(rows) ? rows : [rows];
    if (!list.length || list.some((r) => !r || isPrivateIp(String(r.address || '')))) {
      return codeError('blocked-host', '该域名解析到了本机或内网地址');
    }
  } catch {
    return codeError('dns-failed', '无法解析市场源域名');
  }
  return { ok: true, url: u };
}

async function readCapped(response, maxBytes) {
  const len = Number(response.headers.get('content-length'));
  if (Number.isFinite(len) && len > maxBytes) throw codeError('too-large', '远端响应超过大小上限');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw codeError('too-large', '远端响应超过大小上限');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

async function fetchJson(rawUrl, { fetchImpl, lookupImpl, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES, accept = 'application/json' } = {}) {
  const safe = await assertPublicHttps(rawUrl, lookupImpl);
  if (!safe.ok) return safe;
  let response;
  try {
    response = await fetchImpl(safe.url.toString(), {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept, 'user-agent': 'pi-gui-mcp-market/1' },
    });
  } catch (err) {
    const name = err && err.name;
    if (name === 'TimeoutError' || name === 'AbortError') return codeError('timeout', '市场源响应超时');
    return codeError('network', `无法连接市场源（${clip(err && err.message, 120)}）`);
  }
  if (!response || !response.ok) {
    return codeError(`http-${response ? response.status : 0}`, `市场源返回 HTTP ${response ? response.status : '未知'}`);
  }
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (type && !type.includes('json')) return codeError('invalid-content-type', '市场源没有返回 JSON');
  let text;
  try {
    text = await readCapped(response, maxBytes);
  } catch (err) {
    if (err && err.code) return err;
    return codeError('read-failed', '读取市场源响应失败');
  }
  try {
    const data = JSON.parse(text);
    if (!isRecord(data) && !Array.isArray(data)) return codeError('invalid-response', '市场源返回的 JSON 形状不认识');
    return { ok: true, data };
  } catch {
    return codeError('invalid-response', '市场源返回的不是合法 JSON');
  }
}

/** 依赖探测：只查 PATH，不执行任何程序；找不到是 `false`，无法判断是 `null`。 */
function probeDependencies(names, env) {
  const pathValue = env.PATH || env.Path || '';
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  return (names || []).map((name) => {
    let found = false;
    for (const dir of dirs) {
      for (const ext of exts) {
        try {
          const candidate = path.join(dir, name + ext.toLowerCase());
          if (fs.existsSync(candidate)) { found = true; break; }
        } catch { /* ignore */ }
      }
      if (found) break;
      for (const ext of exts) {
        try {
          const candidate = path.join(dir, name + ext.toUpperCase());
          if (fs.existsSync(candidate)) { found = true; break; }
        } catch { /* ignore */ }
      }
      if (found) break;
    }
    return { name, found };
  });
}

/* ---------------- 配置构造 ---------------- */

function substituteArgs(args, fields, values) {
  const out = [];
  for (const arg of args) {
    const m = /^\{([A-Za-z0-9_]+)\}$/.exec(arg);
    if (!m) { out.push(arg); continue; }
    const field = fields.find((f) => f.key === m[1]);
    if (!field) return codeError('invalid-catalog', '市场条目的参数占位符没有对应字段');
    const raw = values && values[m[1]];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      if (field.required) return codeError('missing-field', `请填写「${field.label}」`, { field: m[1] });
      continue;
    }
    const checked = checkFieldValue(field, String(raw).trim());
    if (!checked.ok) return checked;
    out.push(checked.value);
  }
  return { ok: true, args: out };
}

function checkFieldValue(field, value) {
  if (value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
    return codeError('bad-field', `「${field.label}」不合法`, { field: field.key });
  }
  if (field.type === 'path') {
    if (!path.isAbsolute(value)) return codeError('bad-field', `「${field.label}」必须是绝对路径`, { field: field.key });
    if (field.mustExist) {
      try {
        const st = fs.statSync(value);
        if (field.directory && !st.isDirectory()) return codeError('bad-field', `「${field.label}」必须是目录`, { field: field.key });
        if (!field.directory && !st.isFile()) return codeError('bad-field', `「${field.label}」必须是文件`, { field: field.key });
      } catch {
        return codeError('bad-field', `「${field.label}」指向的路径不存在`, { field: field.key });
      }
    }
  }
  if (field.type === 'envName' && !ENV_NAME_RE.test(value)) {
    return codeError('bad-field', `「${field.label}」必须是合法的环境变量名`, { field: field.key });
  }
  if (field.type === 'url') {
    try {
      const u = new URL(value);
      if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error('bad');
    } catch {
      return codeError('bad-field', `「${field.label}」必须是合法的 http(s) URL`, { field: field.key });
    }
  }
  return { ok: true, value };
}

function buildBuiltinConfig(entry, values = {}) {
  const config = {
    transport: entry.transport,
    description: cleanText(entry.description, 200),
    timeout: 60,
    exposure: 'codemode',
  };
  if (entry.transport === 'stdio') {
    const args = substituteArgs(entry.args, entry.fields || [], values);
    if (!args.ok) return args;
    config.command = entry.command;
    config.args = args.args;
  } else {
    config.url = entry.url;
  }
  const env = {};
  for (const f of entry.envFields || []) {
    const raw = values[f.key];
    if (raw === undefined || String(raw).trim() === '') {
      if (f.required) return codeError('missing-field', `请填写「${f.label}」`, { field: f.key });
      continue;
    }
    const checked = checkFieldValue(f, String(raw).trim());
    if (!checked.ok) return checked;
    env[f.envKey] = checked.value;
  }
  if (Object.keys(env).length) config.env = env;
  const headers = {};
  for (const f of entry.headerFields || []) {
    const raw = values[f.key];
    if (raw === undefined || String(raw).trim() === '') {
      if (f.required) return codeError('missing-field', `请填写「${f.label}」`, { field: f.key });
      continue;
    }
    const name = String(raw).trim();
    if (!ENV_NAME_RE.test(name)) return codeError('bad-field', `「${f.label}」必须是合法的环境变量名`, { field: f.key });
    headers[f.header] = `${f.prefix || ''}\${${name}}`;
  }
  if (Object.keys(headers).length) config.headers = headers;
  return { ok: true, config };
}

function safeInstallName(input) {
  const s = String(input || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  if (s && /^[A-Za-z0-9_-]+$/.test(s)) return s;
  return 'mcp-server';
}

function guessCategory(text) {
  const t = String(text || '').toLowerCase();
  if (/(git|code|developer|filesystem|file |repo|build|test|playwright|browser)/.test(t)) return '开发工具';
  if (/(fetch|http|web|search|network|browser|url)/.test(t)) return '网络';
  if (/(doc|context|knowledge|wiki|rag|memory)/.test(t)) return '文档';
  if (/(data|sql|database|postgres|mysql|sqlite|mongo|db)/.test(t)) return '数据';
  return '效率';
}

/* ---------------- Registry 适配 ---------------- */

function registryQueryUrl({ q, cursor, limit }) {
  const u = new URL(REGISTRY_BASE);
  if (q) u.searchParams.set('search', q.slice(0, 120));
  u.searchParams.set('limit', String(Math.min(50, Math.max(1, Number(limit) || 20))));
  if (cursor) u.searchParams.set('cursor', String(cursor).slice(0, 500));
  return u.toString();
}

function npmPackageConfig(pkg) {
  if (!isRecord(pkg) || pkg.registryType !== 'npm') return null;
  const id = typeof pkg.identifier === 'string' ? pkg.identifier : '';
  const version = typeof pkg.version === 'string' && VERSION_RE.test(pkg.version) ? pkg.version : '';
  if (!NPM_RE.test(id) || !version) return null;
  const runtime = typeof pkg.runtimeHint === 'string' ? pkg.runtimeHint : 'npx';
  if (runtime !== 'npx') return null;
  const env = {};
  for (const v of Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables : []) {
    if (!isRecord(v) || v.isRequired !== true || typeof v.name !== 'string' || !ENV_NAME_RE.test(v.name)) continue;
    env[v.name] = `\${${v.name}}`;
  }
  return {
    transport: 'stdio', command: 'npx', args: ['-y', `${id}@${version}`],
    ...(Object.keys(env).length ? { env } : {}),
    requires: ['node', 'npx'],
    requiredEnvKeys: Object.keys(env),
  };
}

function remoteConfig(remotes) {
  for (const r of Array.isArray(remotes) ? remotes : []) {
    if (!isRecord(r) || r.type !== 'streamable-http' || typeof r.url !== 'string') continue;
    try {
      const u = new URL(r.url);
      if (u.protocol !== 'https:' || u.username || u.password) continue;
      if (u.port && u.port !== '443') continue;
      const host = hostnameOf(u);
      if (net.isIP(host) && isPrivateIp(host)) continue;
      if (blockedHostname(host)) continue;
      return { transport: 'http', url: u.toString(), requires: [] };
    } catch { /* skip */ }
  }
  return null;
}

function normalizeRegistryEntry(raw) {
  if (!isRecord(raw) || !isRecord(raw.server)) return null;
  const s = raw.server;
  const meta = isRecord(raw._meta) && isRecord(raw._meta['io.modelcontextprotocol.registry/official'])
    ? raw._meta['io.modelcontextprotocol.registry/official'] : {};
  if (meta.status && meta.status !== 'active') return null;
  const name = typeof s.name === 'string' ? s.name : '';
  const version = typeof s.version === 'string' && VERSION_RE.test(s.version) ? s.version : '';
  if (!name || name.length > 200 || !version) return null;
  const packages = Array.isArray(s.packages) ? s.packages : [];
  const npmPackage = packages.find((p) => isRecord(p) && p.registryType === 'npm') || packages[0];
  const config = npmPackageConfig(npmPackage) || remoteConfig(s.remotes);
  const title = cleanText(s.title || name.split('/').pop() || name, 80);
  const description = cleanText(s.description, 400);
  const id = `registry:${Buffer.from(JSON.stringify({ name, version })).toString('base64url')}`;
  const installName = safeInstallName(title || name);
  return {
    id,
    source: 'registry',
    sourceLabel: '官方 MCP Registry',
    catalogId: id,
    name: title,
    installName,
    identifier: name,
    version,
    isLatest: meta.isLatest === true,
    category: guessCategory(`${name} ${title} ${description}`),
    trust: 'registry',
    trustEvidence: 'MCP 官方 Registry 收录；收录不代表安全性审核',
    description,
    transport: config ? config.transport : (Array.isArray(s.remotes) && s.remotes[0] && s.remotes[0].type === 'sse' ? 'sse' : ''),
    commandSummary: config && config.transport === 'stdio' ? [config.command, ...config.args].join(' ') : '',
    urlPreview: config && config.transport === 'http' ? config.url : '',
    homepage: isRecord(s.repository) && typeof s.repository.url === 'string' ? s.repository.url : '',
    requires: config ? config.requires : [],
    requiredEnvKeys: config && config.requiredEnvKeys ? config.requiredEnvKeys : [],
    installable: Boolean(config),
    installReason: config ? '' : '该条目没有可直接安装的 npm(npx) 包或 HTTPS streamable-http 端点，请在来源仓库按文档手动配置。',
    warning: '',
    fields: [],
    envFields: [],
    headerFields: [],
  };
}

/* ---------------- 第三方源适配 ---------------- */

function normalizeCustomEntry(src, raw, index) {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : `entry-${index + 1}`;
  const name = cleanText(raw.name || raw.title || id, 80);
  if (!name) return null;
  const title = cleanText(raw.title || name, 80);
  const description = cleanText(raw.description, 400);
  const transport = raw.transport === 'http' || (raw.url && !raw.command) ? 'http' : 'stdio';
  let config = null;
  if (transport === 'stdio') {
    const command = typeof raw.command === 'string' ? raw.command : '';
    if (!REMOTE_COMMANDS.has(command)) return null;
    const args = Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === 'string') : [];
    if (args.length > 32 || args.some((a) => a.length > 512 || /[\u0000-\u001f\u007f]/.test(a) || /^\{.*\}$/.test(a))) return null;
    const env = {};
    if (isRecord(raw.env)) {
      for (const [k, v] of Object.entries(raw.env)) {
        if (!ENV_NAME_RE.test(k) || typeof v !== 'string' || !v || v.length > 1024) return null;
        if (v.startsWith('!')) return null;
        if (settingNeedsReference(k, v) && !SETTING_REFERENCE_RE.test(v)) return null;
        env[k] = v;
      }
    }
    config = { transport: 'stdio', command, args, ...(Object.keys(env).length ? { env } : {}), requires: command === 'npx' ? ['node', 'npx'] : ['python', 'uv', 'uvx'] };
  } else {
    try {
      const u = new URL(String(raw.url || ''));
      if (u.protocol !== 'https:' || u.username || u.password) return null;
      if (u.port && u.port !== '443') return null;
      const host = hostnameOf(u);
      if (net.isIP(host) && isPrivateIp(host)) return null;
      if (blockedHostname(host)) return null;
    } catch { return null; }
    const headers = {};
    if (isRecord(raw.headers)) {
      for (const [k, v] of Object.entries(raw.headers)) {
        if (typeof v !== 'string' || !v || v.length > 1024 || /[\r\n\u0000]/.test(v)) return null;
        if (v.startsWith('!')) return null;
        if (settingNeedsReference(k, v, { headers: true }) && !SETTING_REFERENCE_RE.test(v)) return null;
        headers[k] = v;
      }
    }
    config = { transport: 'http', url: String(raw.url), ...(Object.keys(headers).length ? { headers } : {}), requires: [] };
  }
  const installName = safeInstallName(id || title || name);
  const fullId = `custom:${Buffer.from(JSON.stringify({ sourceId: src.id, entryId: id })).toString('base64url')}`;
  return {
    id: fullId,
    source: `custom:${src.id}`,
    sourceLabel: src.name,
    catalogId: fullId,
    _entryId: id,
    name: title,
    installName,
    identifier: name,
    version: typeof raw.version === 'string' && VERSION_RE.test(raw.version) ? raw.version : '',
    category: CATEGORIES.includes(raw.category) ? raw.category : guessCategory(`${name} ${description}`),
    trust: 'community',
    trustEvidence: `来自第三方市场源 ${src.name}（${new URL(src.url).host}）；未审核安全性`,
    description,
    transport: config.transport,
    commandSummary: config.transport === 'stdio' ? [config.command, ...config.args].join(' ') : '',
    urlPreview: config.transport === 'http' ? config.url : '',
    homepage: typeof raw.homepage === 'string' && /^https:\/\//.test(raw.homepage) ? raw.homepage.slice(0, 500) : '',
    requires: config.requires,
    installable: true,
    installReason: '',
    warning: '第三方市场源条目；安装前请核对命令、端点与来源。',
    fields: [], envFields: [], headerFields: [],
    _config: config,
  };
}

/* ---------------- 工厂 ---------------- */

export function createMcpMarket({
  dataDir,
  configStore,
  env = process.env,
  fetchImpl = globalThis.fetch,
  lookupImpl = dns.promises.lookup,
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const sourcesFile = path.join(dataDir, SOURCES_FILE);

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
    return hit.data;
  }
  function cacheSet(key, data) { cache.set(key, { at: now(), data }); }

  function readSources() {
    try {
      const st = fs.statSync(sourcesFile);
      if (!st.isFile() || st.size > 256 * 1024) return { ok: false, code: 'sources-unreadable', sources: [] };
      const data = JSON.parse(fs.readFileSync(sourcesFile, 'utf8').replace(/^﻿/, ''));
      if (!isRecord(data) || !Array.isArray(data.sources)) return { ok: false, code: 'sources-corrupt', sources: [] };
      const sources = data.sources.filter((s) => isRecord(s) && typeof s.id === 'string' && typeof s.url === 'string');
      return { ok: true, sources };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: true, sources: [] };
      return { ok: false, code: 'sources-unreadable', sources: [] };
    }
  }

  function writeSources(sources) {
    try {
      writeJsonAtomic(sourcesFile, { version: 1, sources }, now());
      return { ok: true };
    } catch {
      return codeError('sources-write-failed', '无法保存市场源列表');
    }
  }

  function sourceMeta() {
    const read = readSources();
    return {
      builtin: { id: 'builtin', name: '内置精选', count: BUILTIN.length },
      registry: { id: 'registry', name: '官方 MCP Registry', count: null },
      custom: read.sources.map((s) => ({ id: s.id, name: s.name, url: s.url, addedAt: s.addedAt || '' })),
      ...(read.ok ? {} : { error: read.code }),
    };
  }

  function builtinList({ q = '', category = '全部', offset = 0, limit = 12 } = {}) {
    const query = String(q || '').trim().toLowerCase();
    const cat = CATEGORIES.includes(category) ? category : '全部';
    const all = builtinItems().filter((item) => {
      if (cat !== '全部' && item.category !== cat) return false;
      if (!query) return true;
      return `${item.name} ${item.identifier} ${item.description}`.toLowerCase().includes(query);
    });
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.min(50, Math.max(1, Number(limit) || 12));
    return {
      ok: true,
      source: 'builtin',
      items: all.slice(start, start + size),
      total: all.length,
      hasMore: start + size < all.length,
      nextCursor: null,
      categories: CATEGORIES,
    };
  }

  async function registryList({ q = '', category = '全部', cursor = '', limit = 20 } = {}) {
    const cat = CATEGORIES.includes(category) ? category : '全部';
    const key = `registry:${q}:${cat}:${cursor}:${limit}`;
    const cached = cacheGet(key);
    if (cached) return { ...cached, cached: true };
    const byIdentifier = new Map();
    let pageCursor = cursor;
    let nextCursor = null;
    /* Registry 的分类是我们从名称 / 描述推出来的，服务端没有 category 参数。
     * 只取当前页会在“第一页全是别的分类”时显示空分类；最多再追两页，
     * 找到匹配条目就停，避免为了一个筛选把 Registry 翻个底朝天。 */
    for (let page = 0; page < 3; page += 1) {
      const fetched = await fetchJson(registryQueryUrl({ q, cursor: pageCursor, limit }), { fetchImpl, lookupImpl });
      if (!fetched.ok) return { ...fetched, items: [] };
      const data = fetched.data;
      if (!isRecord(data) || !Array.isArray(data.servers)) return { ...codeError('invalid-response', 'Registry 响应缺少 servers 数组'), items: [] };
      for (const row of data.servers.slice(0, MAX_REGISTRY_ENTRIES)) {
        const item = normalizeRegistryEntry(row);
        if (!item) continue;
        const prev = byIdentifier.get(item.identifier);
        if (!prev || (!prev.isLatest && item.isLatest)) byIdentifier.set(item.identifier, item);
      }
      nextCursor = isRecord(data.metadata) && typeof data.metadata.nextCursor === 'string' ? data.metadata.nextCursor : null;
      pageCursor = nextCursor;
      if (cat === '全部' || !pageCursor) break;
      if ([...byIdentifier.values()].some((item) => item.category === cat)) break;
    }
    const items = [...byIdentifier.values()].filter((item) => cat === '全部' || item.category === cat);
    const out = { ok: true, source: 'registry', items, total: null, hasMore: Boolean(nextCursor), nextCursor, categories: CATEGORIES };
    cacheSet(key, out);
    return out;
  }

  async function loadCustomSource(source) {
    const fetched = await fetchJson(source.url, { fetchImpl, lookupImpl });
    if (!fetched.ok) return fetched;
    const data = fetched.data;
    const rows = Array.isArray(data) ? data : (isRecord(data) && Array.isArray(data.servers) ? data.servers : null);
    if (!rows) return codeError('invalid-source', '第三方源必须返回 servers 数组');
    const items = [];
    for (let i = 0; i < Math.min(rows.length, 200); i += 1) {
      const item = normalizeCustomEntry(source, rows[i], i);
      if (item) items.push(item);
    }
    if (!items.length) return codeError('invalid-source', '第三方源里没有可用的 MCP server 条目');
    return { ok: true, items, catalogName: cleanText(data.name || source.name, 80) || source.name };
  }

  async function customList(sourceId, { q = '', category = '全部', offset = 0, limit = 12 } = {}) {
    const read = readSources();
    if (!read.ok) return codeError(read.code, '市场源列表无法读取');
    const source = read.sources.find((s) => s.id === sourceId);
    if (!source) return codeError('source-not-found', '找不到这个市场源');
    const key = `custom:${sourceId}`;
    let loaded = cacheGet(key);
    if (!loaded) {
      loaded = await loadCustomSource(source);
      if (!loaded.ok) return { ...loaded, items: [] };
      cacheSet(key, loaded);
    }
    const query = String(q || '').trim().toLowerCase();
    const cat = CATEGORIES.includes(category) ? category : '全部';
    const all = loaded.items.filter((item) => {
      if (cat !== '全部' && item.category !== cat) return false;
      if (!query) return true;
      return `${item.name} ${item.identifier} ${item.description}`.toLowerCase().includes(query);
    }).map(({ _config, _entryId, ...rest }) => rest);
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.min(50, Math.max(1, Number(limit) || 12));
    return {
      ok: true,
      source: `custom:${sourceId}`,
      items: all.slice(start, start + size),
      total: all.length,
      hasMore: start + size < all.length,
      nextCursor: null,
      categories: CATEGORIES,
      sourceLabel: source.name,
    };
  }

  async function list(params = {}) {
    const source = String(params.source || 'builtin');
    if (source === 'builtin') return builtinList(params);
    if (source === 'registry') return registryList(params);
    if (source.startsWith('custom:')) return customList(source.slice('custom:'.length), params);
    return codeError('bad-source', '未知的市场源');
  }

  async function resolveBuiltin(catalogId) {
    const entry = BUILTIN.find((e) => e.id === catalogId);
    if (!entry) return codeError('not-found', '内置市场里没有这个条目');
    return { ok: true, entry };
  }

  async function resolveRegistry(id) {
    if (!id.startsWith('registry:')) return codeError('bad-id', 'Registry 条目 ID 不合法');
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(id.slice('registry:'.length), 'base64url').toString('utf8'));
    } catch { return codeError('bad-id', 'Registry 条目 ID 不合法'); }
    if (!isRecord(decoded) || typeof decoded.name !== 'string' || typeof decoded.version !== 'string') {
      return codeError('bad-id', 'Registry 条目 ID 不合法');
    }
    const fetched = await fetchJson(registryQueryUrl({ q: decoded.name, limit: 50 }), { fetchImpl, lookupImpl });
    if (!fetched.ok) return fetched;
    const rows = isRecord(fetched.data) && Array.isArray(fetched.data.servers) ? fetched.data.servers : [];
    for (const row of rows) {
      const item = normalizeRegistryEntry(row);
      if (!item || item.identifier !== decoded.name || item.version !== decoded.version || !item.installable) continue;
      const packages = Array.isArray(row.server.packages) ? row.server.packages : [];
      const npmPackage = packages.find((p) => isRecord(p) && p.registryType === 'npm') || packages[0];
      const config = npmPackageConfig(npmPackage) || remoteConfig(row.server.remotes);
      if (!config) continue;
      return { ok: true, entry: item, config };
    }
    return codeError('not-found', 'Registry 中已找不到这个版本，请刷新市场');
  }

  async function resolveCustom(id) {
    if (!id.startsWith('custom:')) return codeError('bad-id', '第三方条目 ID 不合法');
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(id.slice('custom:'.length), 'base64url').toString('utf8'));
    } catch { return codeError('bad-id', '第三方条目 ID 不合法'); }
    if (!isRecord(decoded) || typeof decoded.sourceId !== 'string' || typeof decoded.entryId !== 'string') {
      return codeError('bad-id', '第三方条目 ID 不合法');
    }
    const read = readSources();
    if (!read.ok) return codeError(read.code, '市场源列表无法读取');
    const source = read.sources.find((s) => s.id === decoded.sourceId);
    if (!source) return codeError('source-not-found', '找不到这个市场源');
    const loaded = await loadCustomSource(source);
    if (!loaded.ok) return loaded;
    const entry = loaded.items.find((e) => e._entryId === decoded.entryId);
    if (!entry) return codeError('not-found', '第三方市场源已不再提供这个条目，请刷新市场');
    return { ok: true, entry, source };
  }

  async function install(input = {}) {
    const source = String(input.source || '');
    const catalogId = String(input.catalogId || '');
    const scope = input.scope === 'project' ? 'project' : input.scope === 'user' ? 'user' : null;
    if (!scope) return codeError('bad-scope', 'scope 只能是 user 或 project');
    if (!catalogId) return codeError('bad-id', '缺少 catalogId');

    let built;
    if (source === 'builtin') {
      const r = await resolveBuiltin(catalogId);
      if (!r.ok) return r;
      built = buildBuiltinConfig(r.entry, isRecord(input.values) ? input.values : {});
      if (!built.ok) return built;
      built.name = r.entry.id;
      built.entry = r.entry;
    } else if (source === 'registry' || catalogId.startsWith('registry:')) {
      const r = await resolveRegistry(catalogId);
      if (!r.ok) return r;
      built = { ok: true, config: r.config, name: r.entry.installName, entry: r.entry };
    } else if (source.startsWith('custom:')) {
      const r = await resolveCustom(catalogId);
      if (!r.ok) return r;
      built = { ok: true, config: { ...r.entry._config }, name: r.entry.installName, entry: r.entry };
    } else {
      return codeError('bad-source', '未知的市场源');
    }

    const requestedName = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : built.name;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestedName)) {
      return codeError('bad-name', 'server 名只允许字母、数字、_ 和 -（1–64 字符）', { field: 'name' });
    }
    const entry = built.entry;
    const cfg = built.config;
    const save = await configStore.save({
      scope,
      name: requestedName,
      expectedRevision: input.expectedRevision,
      allowReplace: input.allowReplace === true,
      confirmOverride: input.confirmOverride === true,
      transport: cfg.transport,
      command: cfg.command,
      args: cfg.args,
      url: cfg.url,
      env: cfg.env ? Object.entries(cfg.env).map(([key, value]) => ({ key, value })) : undefined,
      headers: cfg.headers ? Object.entries(cfg.headers).map(([key, value]) => ({ key, value })) : undefined,
      description: cleanText(entry.description, 200),
      timeout: 60,
      exposure: 'codemode',
      enabled: true,
    });
    if (!save.ok) return save;
    return {
      ...save,
      configured: true,
      connected: null,
      loaded: null,
      connectionState: 'untested',
      loadState: 'reload-required',
      source: source || (catalogId.startsWith('registry:') ? 'registry' : 'builtin'),
      catalogId,
      entry: {
        name: entry.name,
        identifier: entry.identifier || '',
        version: entry.version || '',
        trust: entry.trust,
        trustEvidence: entry.trustEvidence,
      },
      requires: entry.requires || [],
      dependencyProbe: probeDependencies(entry.requires || [], env),
      message: '配置已保存。它还没有被运行中的 Pi 会话加载，也没有验证连接；保存 ≠ 已连接 ≠ 可调用。',
    };
  }

  async function addSource(input = {}) {
    const rawUrl = typeof input.url === 'string' ? input.url.trim() : '';
    if (!rawUrl) return codeError('bad-url', '请填写市场源 URL', { field: 'url' });
    if (rawUrl.length > 2048) return codeError('bad-url', '市场源 URL 过长', { field: 'url' });
    const read = readSources();
    if (!read.ok) return codeError(read.code, '现有市场源列表无法读取，为避免覆盖已拒绝写入');
    if (read.sources.length >= MAX_SOURCES) return codeError('too-many-sources', `最多只能添加 ${MAX_SOURCES} 个第三方市场源`);
    if (read.sources.some((s) => s.url === rawUrl)) return codeError('source-exists', '这个市场源已经添加过了');
    const fetched = await fetchJson(rawUrl, { fetchImpl, lookupImpl });
    if (!fetched.ok) return fetched;
    const rows = Array.isArray(fetched.data) ? fetched.data : (isRecord(fetched.data) && Array.isArray(fetched.data.servers) ? fetched.data.servers : null);
    if (!rows) return codeError('invalid-source', '第三方源必须返回 servers 数组');
    const sourceName = cleanText(input.name || (isRecord(fetched.data) ? fetched.data.name : '') || new URL(rawUrl).host, 80) || '第三方市场源';
    const source = {
      id: `src-${cryptoRandom()}`,
      name: sourceName,
      url: rawUrl,
      addedAt: new Date(now()).toISOString(),
    };
    const probe = await loadCustomSource(source);
    if (!probe.ok) return probe;
    const write = writeSources([...read.sources, source]);
    if (!write.ok) return write;
    cache.delete(`custom:${source.id}`);
    return { ok: true, source: { id: source.id, name: source.name, url: source.url, addedAt: source.addedAt }, count: probe.items.length };
  }

  async function removeSource(input = {}) {
    const id = typeof input.id === 'string' ? input.id : '';
    const read = readSources();
    if (!read.ok) return codeError(read.code, '市场源列表无法读取');
    const source = read.sources.find((s) => s.id === id);
    if (!source) return codeError('source-not-found', '找不到这个市场源');
    const write = writeSources(read.sources.filter((s) => s.id !== id));
    if (!write.ok) return write;
    cache.delete(`custom:${id}`);
    return { ok: true, id };
  }

  function sources() {
    return { ok: true, ...sourceMeta(), categories: CATEGORIES };
  }

  return {
    list,
    install,
    addSource,
    removeSource,
    sources,
    _internals: {
      BUILTIN,
      CATEGORIES,
      isPrivateIp,
      assertPublicHttps,
      normalizeRegistryEntry,
      normalizeCustomEntry,
      buildBuiltinConfig,
      probeDependencies,
      fetchJson,
      builtinItems,
    },
  };
}

function cryptoRandom() {
  return crypto.randomBytes(6).toString('hex');
}
