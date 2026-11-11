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
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import {
  argsContainSecret, queryLooksSensitive, settingNeedsReference, writeJsonAtomic,
} from './mcp-config.js';

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io/v0/servers';
const SOURCES_FILE = 'mcp-market-sources.json';
const CACHE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCES = 10;
const MAX_REGISTRY_ENTRIES = 50;
const CATEGORIES = ['全部', '开发工具', '网络', '文档', '数据', '效率'];
const NPM_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const PYPI_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
/* Registry 的 Package.version 必须是**具体版本**：`latest`、`^1.2.3`、
 * `~1.2.3`、`>=1.2.3`、`1.x`、`1.*` 都会被上游拒绝。这里再用更窄的
 * semver 形态挡一次，避免把范围写进 npx / uvx 的包规格。 */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ARG_NAME_RE = /^--?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_REFERENCE_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const SETTING_REFERENCE_RE = /^(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+[ \t]+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const REMOTE_COMMANDS = new Set(['npx', 'uvx']);
/* runtimeArguments 会直接交给 npx / uvx，必须挡住能改写包来源或执行
 * 任意命令的参数；packageArguments 是传给 server 自己的，不受此限。 */
const UNSAFE_RUNTIME_FLAGS = new Set([
  '-c', '--call', '--package', '-p',
  '--registry', '--registry-url', '--userconfig', '--globalconfig',
  '--node-options',
  '--index-url', '--extra-index-url', '--default-index', '--find-links',
  '--from', '--with',
]);

function unsafeRuntimeArg(text) {
  const s = String(text || '');
  for (const flag of UNSAFE_RUNTIME_FLAGS) {
    if (s === flag || s.startsWith(`${flag}=`)) return flag;
  }
  return '';
}

function unsafeRuntimeToken(token) {
  for (const part of token.parts) {
    if (typeof part !== 'string') continue;
    const flag = unsafeRuntimeArg(part);
    if (flag) return flag;
  }
  return '';
}
const NPM_REGISTRY_BASE_RE = /^https:\/\/registry\.npmjs\.org\/?$/i;
const PYPI_REGISTRY_BASE_RE = /^https:\/\/(?:pypi\.org|pypi\.python\.org)\/?$/i;
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
const MAX_PINNED_ADDRESSES = 4;

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
  return BUILTIN.map((e) => {
    const fields = (e.fields || []).map(({ key, label, type, required, placeholder }) => ({
      key, label, type, required: Boolean(required), placeholder: placeholder || '',
      default: '', choices: [], help: '',
    }));
    const commandTemplate = e.transport === 'stdio' ? [e.command, ...e.args].join(' ') : '';
    return {
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
    commandSummary: e.transport === 'stdio' ? templateWithLabels(commandTemplate, fields) : '',
    commandTemplate,
    urlPreview: e.url || '',
    urlTemplate: e.transport === 'http' ? e.url : '',
    homepage: e.homepage || '',
    requires: e.requires || [],
    fields,
    envFields: (e.envFields || []).map(({ key, label, required, placeholder }) => ({ key, label, required: Boolean(required), placeholder: placeholder || '', secret: false })),
    headerFields: (e.headerFields || []).map(({ key, label, required, placeholder, help }) => ({ key, label, required: Boolean(required), placeholder: placeholder || '', help: help || '' })),
    warning: e.warning || '',
    installable: true,
    installReason: '',
    };
  });
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

/* 198.18.0.0/15 是 RFC 2544 的基准测试网段；Clash / Surge 等 TUN 代理
 * 常用它做 fake-IP。它不是公网地址，但也不是“内网服务” —— 单独区分出来，
 * 才能给出“代理无法确认实际连接地址”的准确提示，而不是误报内网。 */
function isFakeIpAddress(ip) {
  if (typeof ip !== 'string' || !net.isIPv4(ip)) return false;
  const p = ip.split('.').map(Number);
  return p[0] === 198 && (p[1] === 18 || p[1] === 19);
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
    /* 2001::/23 IETF 协议分配段（含 Teredo 2001::/32、benchmarking
     * 2001:2::/48、ORCHID 2001:10::/28），不是全局单播。 */
    if (parts[0] === 0x2001 && parts[1] <= 0x01ff) return true;
    /* 2001:db8::/32 documentation. */
    if (parts[0] === 0x2001 && parts[1] === 0x0db8) return true;
    /* 3fff::/20 documentation. */
    if ((parts[0] & 0xfff0) === 0x3ff0) return true;
    /* 100::/64 discard-only. */
    if (parts[0] === 0x0100 && parts.slice(1, 4).every((v) => v === 0)) return true;
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

/**
 * 把 DNS 结果收敛成一组**已经过校验的 IP**。真正的 HTTPS 连接随后只允许
 * 连到这里的地址（自定义 lookup），域名只用于 TLS SNI 与证书校验。
 * 这样“先查一次、再让 fetch 自己查一次”的 DNS rebinding 窗口就不存在了。
 */
async function assertPublicHttps(rawUrl, lookupImpl) {
  let u;
  try { u = new URL(rawUrl); } catch { return codeError('blocked-url', 'URL 不是合法地址'); }
  if (u.protocol !== 'https:') return codeError('blocked-url', '市场源只允许 HTTPS');
  if (u.username || u.password) return codeError('blocked-url', 'URL 不能包含用户名或密码');
  /* 查询串 / 路径里的凭据形态值同样会明文落盘并回显到前端，必须和
   * server URL 用同一条判据拒绝。 */
  if (queryLooksSensitive(u)) return codeError('blocked-url', 'URL 查询串或路径中疑似包含凭据');
  if (u.port && u.port !== '443') return codeError('blocked-url', '市场源只允许 443 端口');
  const hostname = hostnameOf(u);
  if (blockedHostname(hostname)) return codeError('blocked-host', '不允许访问本机或内网主机');

  const addresses = [];
  if (net.isIP(hostname)) {
    if (isFakeIpAddress(hostname)) {
      return codeError('proxy-blocked', '目标地址属于代理的 fake-IP 网段（198.18.0.0/15），无法确认实际连接地址；已拒绝。');
    }
    if (isPrivateIp(hostname)) return codeError('blocked-host', '不允许访问本机或内网地址');
    addresses.push({ address: hostname, family: net.isIP(hostname) });
  } else {
    let rows;
    try {
      rows = await lookupImpl(hostname, { all: true, verbatim: true });
    } catch {
      return codeError('dns-failed', '无法解析市场源域名');
    }
    const list = Array.isArray(rows) ? rows : [rows];
    if (!list.length) return codeError('dns-failed', '市场源域名没有解析结果');
    for (const row of list) {
      const address = String((row && row.address) || '');
      const family = net.isIP(address);
      if (isFakeIpAddress(address)) {
        return codeError(
          'proxy-blocked',
          '该域名解析到了代理的 fake-IP 网段（198.18.0.0/15），无法确认实际连接地址；已拒绝请求。请改用直连 DNS 或关闭 TUN / fake-IP 后重试。',
        );
      }
      /* 无法判定族、或命中私网 / 环回 / 链路本地 / 保留地址，整台主机拒绝。
       * 不做“跳过坏地址、继续用另一个”的降级 —— 同一域名同时解析出公网与
       * 私网地址时，那本身就是可疑输入。 */
      if (!family || isPrivateIp(address)) {
        return codeError('blocked-host', '该域名解析到了本机或内网地址');
      }
      addresses.push({ address, family: row.family === 4 || row.family === 6 ? row.family : family });
    }
  }
  if (!addresses.length) return codeError('dns-failed', '市场源域名没有解析结果');
  return {
    ok: true,
    url: u,
    hostname,
    addresses: addresses.slice(0, MAX_PINNED_ADDRESSES),
  };
}

function noProxyMatches(host, port, raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  for (const part of raw.split(',')) {
    let entry = part.trim();
    if (!entry) continue;
    if (entry === '*') return true;
    let entryHost = entry;
    let entryPort = '';
    const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    if (bracket) {
      entryHost = bracket[1];
      entryPort = bracket[2] || '';
    } else {
      const plain = /^([^:]+)(?::(\d+))?$/.exec(entry);
      if (plain) { entryHost = plain[1]; entryPort = plain[2] || ''; }
    }
    if (entryPort && entryPort !== String(port || '443')) continue;
    entryHost = entryHost.replace(/^\*?\./, '').toLowerCase();
    if (!entryHost) continue;
    if (h === entryHost || h.endsWith(`.${entryHost}`)) return true;
  }
  return false;
}

/**
 * 市场只做“直连 + 固定已校验 IP”。代理会在代理侧重新解析域名，客户端
 * 无法证明它连到的就是刚才校验的地址；因此检测到代理时明确拒绝，而不是
 * 把一次未经校验的连接说成已防护。NO_PROXY 排除目标域名后可以直连。
 */
function blockingProxy(env, url) {
  const safeEnv = env || {};
  const keys = PROXY_ENV_KEYS.filter((key) => typeof safeEnv[key] === 'string' && safeEnv[key].trim());
  if (!keys.length) return null;
  const host = hostnameOf(url);
  const port = url.port || '443';
  if (noProxyMatches(host, port, safeEnv.NO_PROXY || safeEnv.no_proxy)) return null;
  return { key: keys[0] };
}

function pinnedLookupFor(address, family) {
  const fam = family === 4 || family === 6 ? family : (net.isIPv6(address) ? 6 : 4);
  return (hostname, options, callback) => {
    if (options && options.all) return callback(null, [{ address, family: fam }]);
    return callback(null, address, fam);
  };
}

/** 真实连接参数：hostname 保持原域名（SNI / 证书校验），lookup 只回已校验 IP。 */
function pinnedRequestOptions(url, address, family, headers = {}) {
  const hostname = hostnameOf(url);
  const port = url.port ? Number(url.port) : 443;
  const options = {
    method: 'GET',
    protocol: 'https:',
    hostname,
    port,
    path: `${url.pathname || '/'}${url.search || ''}`,
    headers: { ...headers, host: url.host },
    agent: false,
    rejectUnauthorized: true,
    lookup: pinnedLookupFor(address, family),
  };
  /* IP 字面量不能作为 TLS ServerName（Node 会直接拒绝）；此时证书按
   * IP SAN 校验。域名则显式保留 SNI，证书仍按域名校验。 */
  if (!net.isIP(hostname)) options.servername = hostname;
  return options;
}

function responseHeaders(raw) {
  const out = {};
  for (const key of ['content-type', 'content-length', 'location']) {
    const value = raw && raw[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  return out;
}

/**
 * 构造 Response 不能让远端状态码把异常抛出回调：undici 对 204/205
 * 携带 body、对 600–999 都会抛错，而这里运行在 https.request 的异步
 * 回调里，Promise executor 的 try/catch 包不住，异常会直接终止后端。
 * 统一收敛状态码，并对禁止 body 的状态显式传 null。
 */
function pinnedResponse(status, body, headers) {
  let code = Number(status) || 0;
  if (code < 200 || code > 599) code = 502;
  const bodyForbidden = code === 204 || code === 205 || code === 304;
  return new Response(bodyForbidden ? null : body, { status: code, headers });
}

/**
 * 一次 HTTPS GET：不跟随重定向、整体超时、响应体上限。连接由
 * pinnedRequestOptions 固定到已经校验过的 IP。
 */
function httpsGetPinned(rawUrl, { address, family, timeoutMs, maxBytes, headers = {} } = {}) {
  const u = new URL(rawUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const fail = (err) => finish(reject, err);
    let req;
    try {
      req = https.request(pinnedRequestOptions(u, address, family, headers), (res) => {
        const status = Number(res.statusCode) || 0;
        /* 3xx 与错误状态不读 body：既避免下载无关内容，也让 fetchJson 能
         * 先给出明确的 redirect-blocked / http-xxx。 */
        /* Response 构造仍可能因未预见的状态/头部组合抛错；必须接住，
         * 否则会从 res 的事件回调冒成 uncaughtException。 */
        const send = (body, statusCode, headers) => {
          try {
            finish(resolve, pinnedResponse(statusCode, body, headers));
          } catch (err) {
            fail(err);
          }
        };
        if (status < 200 || status >= 300) {
          res.resume();
          send(null, status, responseHeaders(res.headers));
          return;
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.resume();
          send(null, status, { ...responseHeaders(res.headers), 'content-length': String(declared) });
          return;
        }
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            const err = new Error('远端响应超过大小上限');
            err.marketCode = 'too-large';
            res.destroy();
            req.destroy();
            fail(err);
            return;
          }
          chunks.push(chunk);
        });
        res.on('aborted', () => fail(Object.assign(new Error('响应被中断'), { marketCode: 'network' })));
        res.on('error', fail);
        res.on('end', () => {
          send(Buffer.concat(chunks), status, responseHeaders(res.headers));
        });
      });
    } catch (err) {
      fail(err);
      return;
    }
    timer = setTimeout(() => {
      const err = new Error('市场源响应超时');
      err.name = 'TimeoutError';
      err.marketCode = 'timeout';
      req.destroy(err);
    }, Math.max(1, timeoutMs));
    req.on('error', fail);
    req.end();
  });
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

async function fetchJson(rawUrl, {
  requestImpl = httpsGetPinned,
  lookupImpl,
  env = process.env,
  timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES,
  accept = 'application/json',
} = {}) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return codeError('blocked-url', 'URL 不是合法地址'); }
  const proxy = blockingProxy(env, parsed);
  if (proxy) {
    return codeError(
      'proxy-blocked',
      `检测到代理环境变量 ${proxy.key}。代理会在代理侧重新解析域名，无法确认实际连接地址；为防止绕过 DNS 校验，市场请求已拒绝。请把目标域名加入 NO_PROXY 后重试，或手动配置该 server。`,
    );
  }
  const safe = await assertPublicHttps(rawUrl, lookupImpl);
  if (!safe.ok) return safe;

  const deadline = Date.now() + timeoutMs;
  let response = null;
  let lastError = null;
  let sawTimeout = false;
  for (const target of safe.addresses) {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      response = await requestImpl(safe.url.toString(), {
        hostname: safe.hostname,
        address: target.address,
        family: target.family,
        timeoutMs: remaining,
        maxBytes,
        headers: { accept, 'user-agent': 'pi-gui-mcp-market/1' },
      });
      break;
    } catch (err) {
      if (err && err.marketCode === 'too-large') return codeError('too-large', '远端响应超过大小上限');
      if (err && (err.marketCode === 'timeout' || err.name === 'TimeoutError' || err.name === 'AbortError')) sawTimeout = true;
      lastError = err;
      if (Date.now() >= deadline) break;
    }
  }
  if (!response) {
    if (sawTimeout) return codeError('timeout', '市场源响应超时');
    return codeError('network', `无法连接市场源（${clip(lastError && lastError.message, 120)}）`);
  }
  const status = Number(response.status) || 0;
  if (status >= 300 && status < 400) {
    return codeError('redirect-blocked', '市场源返回重定向；为防绕过地址校验，已拒绝跟随');
  }
  if (!response.ok) {
    return codeError(`http-${status}`, `市场源返回 HTTP ${status || '未知'}`);
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

function exactVersion(value) {
  return typeof value === 'string' && EXACT_VERSION_RE.test(value) ? value : '';
}

function inputLabel(input, fallback) {
  const text = cleanText(
    (isRecord(input) && (input.description || input.placeholder || input.valueHint)) || fallback,
    80,
  );
  return text || fallback;
}

function inputFieldType(format) {
  if (format === 'filepath') return 'path';
  if (format === 'number') return 'number';
  if (format === 'boolean') return 'boolean';
  return 'text';
}

function checkInputValue(input, value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
    return codeError('bad-field', '参数值不合法或过长');
  }
  const choices = isRecord(input) && Array.isArray(input.choices)
    ? input.choices.filter((c) => typeof c === 'string') : [];
  if (choices.length && !choices.includes(value)) {
    return codeError('bad-field', '参数值不在 Registry 声明的可选项内');
  }
  const format = isRecord(input) ? input.format : '';
  if (format === 'number' && !/^-?\d+(?:\.\d+)?$/.test(value)) {
    return codeError('bad-field', '参数值必须是数字');
  }
  if (format === 'boolean' && value !== 'true' && value !== 'false') {
    return codeError('bad-field', '参数值必须是 true 或 false');
  }
  if (format === 'filepath' && !SETTING_REFERENCE_RE.test(value) && !path.isAbsolute(value)) {
    return codeError('bad-field', '参数值必须是绝对路径');
  }
  return { ok: true, value };
}

function publicField(field) {
  return {
    key: field.key,
    label: field.label,
    type: inputFieldType(field.format),
    required: field.required === true,
    placeholder: field.placeholder || '',
    default: field.default || '',
    choices: Array.isArray(field.choices) ? field.choices.slice(0, 30) : [],
    help: field.help || '',
  };
}

function publicEnvField(field) {
  return {
    ...publicField(field),
    envKey: field.envKey,
    secret: field.secret === true,
  };
}

function publicHeaderField(field) {
  return {
    ...publicField(field),
    header: field.header,
    secret: field.secret === true,
    literal: field.literal === true,
    prefix: field.prefix || '',
  };
}

/* `{curly}` 是 Registry 的变量模板。静态值在这里直接替换；没有静态值的
 * 变量变成一个待填字段，安装时才取值。安全关键点：
 *   - 参数里的敏感变量一律拒绝（凭据不能进 args）；
 *   - 未定义的 `{name}` 按上游语义保留为字面量，但不允许它出现在 URL
 *     的 host / 端口等位置后被当成“已校验”。 */
function resolveTemplateParts(template, variables, keyPrefix, { label, allowSecret = false } = {}) {
  if (typeof template !== 'string') return { ok: false, reason: '模板不是字符串' };
  if (template.length > 2048 || /[\u0000\u007f]/.test(template)) {
    return { ok: false, reason: '模板过长或包含控制字符' };
  }
  const vars = isRecord(variables) ? variables : {};
  const parts = [];
  const fields = [];
  const re = /\{([A-Za-z0-9_.-]+)\}/g;
  let last = 0;
  let match;
  while ((match = re.exec(template))) {
    if (match.index > last) parts.push(template.slice(last, match.index));
    const name = match[1];
    const def = isRecord(vars[name]) ? vars[name] : null;
    if (!def) {
      parts.push(match[0]);
      last = re.lastIndex;
      continue;
    }
    const staticValue = def.value !== undefined ? def.value : def.default;
    if (staticValue !== undefined) {
      const checked = checkInputValue(def, staticValue);
      if (!checked.ok) return { ok: false, reason: checked.error };
      parts.push(checked.value);
    } else {
      if (def.isSecret === true && !allowSecret) {
        return { ok: false, reason: '该参数需要明文凭据，凭据不能写入 args' };
      }
      const field = {
        key: `${keyPrefix}.${name}`,
        label: inputLabel(def, name),
        required: def.isRequired === true,
        format: typeof def.format === 'string' ? def.format : 'string',
        choices: Array.isArray(def.choices) ? def.choices.filter((c) => typeof c === 'string') : [],
        placeholder: typeof def.placeholder === 'string' ? def.placeholder : '',
        default: '',
        help: cleanText(def.description, 160),
        secret: def.isSecret === true,
      };
      fields.push(field);
      parts.push({ field });
    }
    last = re.lastIndex;
  }
  if (last < template.length) parts.push(template.slice(last));
  if (!parts.length) parts.push('');
  return { ok: true, parts, fields, label };
}

function tokenTemplate(token) {
  return token.parts.map((part) => (typeof part === 'string' ? part : `{${part.field.key}}`)).join('');
}

function templateWithLabels(template, fields) {
  let out = String(template || '');
  for (const field of Array.isArray(fields) ? fields : []) {
    out = out.split(`{${field.key}}`).join(`<${field.label}>`);
  }
  return out;
}

function planArgument(arg, index, { prefix = 'arg' } = {}) {
  if (!isRecord(arg)) return { ok: false, reason: '参数条目不是对象' };
  if (arg.isRepeated === true) return { ok: false, reason: '重复参数（isRepeated）暂不支持安全转换' };
  const type = arg.type === 'named' || arg.type === 'positional'
    ? arg.type
    : (typeof arg.name === 'string' ? 'named' : 'positional');
  const keyPrefix = `${prefix}${index}`;
  const label = inputLabel(arg, arg.valueHint || arg.name || `参数 ${index + 1}`);
  const format = typeof arg.format === 'string' ? arg.format : 'string';
  const choices = Array.isArray(arg.choices) ? arg.choices.filter((c) => typeof c === 'string') : [];

  if (type === 'named') {
    const name = typeof arg.name === 'string' ? arg.name : '';
    if (!ARG_NAME_RE.test(name)) return { ok: false, reason: '参数名不是合法的命令行开关' };
    /* `--api-key <value>` 这种开关必然把凭据写进 args；Pi GUI 的配置层
     * 会拒绝，市场也不应该把它伪装成可安装。 */
    if (argsContainSecret([name, 'x'])) {
      return { ok: false, reason: '该参数要求把凭据写入启动参数，Pi GUI 不支持' };
    }
    const template = typeof arg.value === 'string'
      ? arg.value
      : (typeof arg.default === 'string' ? arg.default : null);
    if (template !== null) {
      const resolved = resolveTemplateParts(template, arg.variables, keyPrefix, { label });
      if (!resolved.ok) return resolved;
      if (!resolved.fields.length) {
        const checked = checkInputValue(arg, template);
        if (!checked.ok) return { ok: false, reason: checked.error };
      }
      const parts = [`${name}=`, ...resolved.parts];
      return {
        ok: true,
        token: {
          kind: 'value',
          parts,
          fields: resolved.fields,
          skipIfEmpty: resolved.fields.length > 0 && arg.isRequired !== true,
          template: tokenTemplate({ parts }),
        },
        fields: resolved.fields,
      };
    }
    if (typeof arg.valueHint === 'string' || arg.isRequired === true) {
      const field = {
        key: keyPrefix, label, required: arg.isRequired === true, format, choices,
        placeholder: typeof arg.placeholder === 'string' ? arg.placeholder : (arg.valueHint || ''),
        default: '', help: cleanText(arg.description, 160), secret: false,
      };
      const parts = [`${name}=`, { field }];
      return {
        ok: true,
        token: { kind: 'value', parts, fields: [field], skipIfEmpty: arg.isRequired !== true, template: tokenTemplate({ parts }) },
        fields: [field],
      };
    }
    return { ok: true, token: { kind: 'literal', parts: [name], fields: [], template: name }, fields: [] };
  }

  const template = typeof arg.value === 'string'
    ? arg.value
    : (typeof arg.default === 'string' ? arg.default : null);
  if (template !== null) {
    const resolved = resolveTemplateParts(template, arg.variables, keyPrefix, { label });
    if (!resolved.ok) return resolved;
    if (!resolved.fields.length) {
      const checked = checkInputValue(arg, template);
      if (!checked.ok) return { ok: false, reason: checked.error };
    }
    return {
      ok: true,
      token: {
        kind: 'value', parts: resolved.parts, fields: resolved.fields,
        skipIfEmpty: resolved.fields.length > 0 && arg.isRequired !== true,
        template: tokenTemplate({ parts: resolved.parts }),
      },
      fields: resolved.fields,
    };
  }
  if (typeof arg.valueHint === 'string' || arg.isRequired === true) {
    const field = {
      key: keyPrefix, label, required: arg.isRequired === true, format, choices,
      placeholder: typeof arg.placeholder === 'string' ? arg.placeholder : (arg.valueHint || ''),
      default: '', help: cleanText(arg.description, 160), secret: false,
    };
    const parts = [{ field }];
    return {
      ok: true,
      token: { kind: 'value', parts, fields: [field], skipIfEmpty: arg.isRequired !== true, template: tokenTemplate({ parts }) },
      fields: [field],
    };
  }
  return { ok: false, reason: '位置参数既没有固定值也没有 valueHint' };
}

function planArguments(list, { prefix = 'arg' } = {}) {
  if (list === undefined) return { ok: true, tokens: [], fields: [] };
  if (!Array.isArray(list)) return { ok: false, reason: '参数列表不是数组' };
  if (list.length > 24) return { ok: false, reason: '参数过多，无法安全转换' };
  const tokens = [];
  const fields = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = planArgument(list[i], i, { prefix });
    if (!item.ok) return item;
    tokens.push(item.token);
    fields.push(...item.fields);
  }
  return { ok: true, tokens, fields };
}

function secretRefOf(value) {
  const m = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(String(value || ''));
  return m ? m[1] : '';
}

function envReference(raw) {
  const value = String(raw || '').trim();
  if (ENV_REFERENCE_RE.test(value)) return value;
  if (ENV_NAME_RE.test(value)) return `\${${value}}`;
  return '';
}

function headerReference(raw, prefix = '') {
  const value = String(raw || '').trim();
  if (SETTING_REFERENCE_RE.test(value)) return value;
  if (ENV_NAME_RE.test(value)) return `${prefix || ''}\${${value}}`;
  return '';
}

function planEnvEntry(entry) {
  if (!isRecord(entry)) return { ok: false, reason: '环境变量条目不是对象' };
  const name = typeof entry.name === 'string' ? entry.name : '';
  if (!ENV_NAME_RE.test(name) || name.length > 128) {
    return { ok: false, reason: '环境变量名不合法' };
  }
  const label = inputLabel(entry, name);
  const required = entry.isRequired === true;
  const secret = entry.isSecret === true;
  const staticValue = entry.value !== undefined ? entry.value : (entry.default !== undefined ? entry.default : null);

  if (secret) {
    if (typeof staticValue === 'string') {
      if (ENV_REFERENCE_RE.test(staticValue)) {
        return { ok: true, staticEnv: { name, value: staticValue }, requiredEnvKeys: [secretRefOf(staticValue)] };
      }
      if (/\{[A-Za-z0-9_.-]+\}/.test(staticValue)) {
        return { ok: false, reason: '敏感环境变量使用模板时无法安全转换' };
      }
    }
    const field = {
      key: `env.${name}`, label, envKey: name, required, secret: true, standalone: true,
      format: 'string', choices: [], placeholder: name, default: required ? name : '',
      help: '填写系统环境变量名；配置里只写 ${环境变量名}，值不会经过 Pi GUI。',
    };
    return {
      ok: true, envFields: [field],
      requiredEnvKeys: required ? [name] : [],
    };
  }

  if (typeof staticValue === 'string') {
    const resolved = resolveTemplateParts(staticValue, entry.variables, `env.${name}`, { label });
    if (!resolved.ok) return resolved;
    if (!resolved.fields.length) {
      const resolvedText = resolved.parts.join('');
      const checked = checkInputValue(entry, resolvedText);
      if (!checked.ok) return { ok: false, reason: checked.error };
      if (settingNeedsReference(name, resolvedText) && !ENV_REFERENCE_RE.test(resolvedText)) {
        const field = {
          key: `env.${name}`, label, envKey: name, required, secret: true, standalone: true,
          format: 'string', choices: [], placeholder: name, default: required ? name : '',
          help: '这个环境变量看起来是凭据。填写系统环境变量名，配置里只写 ${环境变量名}。',
        };
        return { ok: true, envFields: [field], requiredEnvKeys: required ? [name] : [] };
      }
      return { ok: true, staticEnv: { name, value: resolvedText } };
    }
    return {
      ok: true,
      envFields: resolved.fields,
      envInputs: [{ name, parts: resolved.parts, required, label }],
    };
  }

  if (!required) return { ok: true };
  const field = {
    key: `env.${name}`, label, envKey: name, required: true, secret: false, standalone: true,
    format: typeof entry.format === 'string' ? entry.format : 'string',
    choices: Array.isArray(entry.choices) ? entry.choices.filter((c) => typeof c === 'string') : [],
    placeholder: typeof entry.placeholder === 'string' ? entry.placeholder : '',
    default: '', help: cleanText(entry.description, 160),
  };
  return { ok: true, envFields: [field] };
}

function planHeaderEntry(entry) {
  if (!isRecord(entry)) return { ok: false, reason: '请求头条目不是对象' };
  const name = typeof entry.name === 'string' ? entry.name : '';
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || name.length > 128) {
    return { ok: false, reason: '请求头名不合法' };
  }
  const label = inputLabel(entry, name);
  const required = entry.isRequired === true;
  const secret = entry.isSecret === true;
  const staticValue = entry.value !== undefined ? entry.value : (entry.default !== undefined ? entry.default : null);

  if (secret) {
    if (typeof staticValue === 'string') {
      if (SETTING_REFERENCE_RE.test(staticValue)) {
        return { ok: true, staticHeader: { name, value: staticValue }, requiredEnvKeys: [secretRefOf(staticValue)] };
      }
      if (/\{[A-Za-z0-9_.-]+\}/.test(staticValue)) {
        return { ok: false, reason: '敏感请求头使用模板时无法安全转换' };
      }
    }
    const field = {
      key: `header.${name}`, label, header: name, required, secret: true, literal: false, standalone: true,
      format: 'string', choices: [], placeholder: name, default: required ? name : '',
      help: '填写系统环境变量名；配置里只写 ${环境变量名}，值不会经过 Pi GUI。',
    };
    return {
      ok: true, headerFields: [field],
      requiredEnvKeys: required ? [name] : [],
    };
  }

  if (typeof staticValue === 'string') {
    const resolved = resolveTemplateParts(staticValue, entry.variables, `header.${name}`, { label });
    if (!resolved.ok) return resolved;
    if (!resolved.fields.length) {
      const resolvedText = resolved.parts.join('');
      const checked = checkInputValue(entry, resolvedText);
      if (!checked.ok) return { ok: false, reason: checked.error };
      if (settingNeedsReference(name, resolvedText, { headers: true }) && !SETTING_REFERENCE_RE.test(resolvedText)) {
        const field = {
          key: `header.${name}`, label, header: name, required, secret: true, literal: false, standalone: true,
          format: 'string', choices: [], placeholder: name, default: required ? name : '',
          help: '这个请求头看起来是凭据。填写系统环境变量名，配置里只写 ${环境变量名}。',
        };
        return { ok: true, headerFields: [field], requiredEnvKeys: required ? [name] : [] };
      }
      return { ok: true, staticHeader: { name, value: resolvedText } };
    }
    /* 请求头模板里只允许非敏感变量；secret 变量已经在 resolveTemplateParts
     * 里被拒（allowSecret=false）。字段值拼进头值，安装时再校验一次。 */
    return {
      ok: true,
      headerFields: resolved.fields,
      headerInputs: [{ name, parts: resolved.parts, required, label }],
    };
  }

  if (!required) return { ok: true };
  const field = {
    key: `header.${name}`, label, header: name, required: true, secret: false, literal: true, standalone: true,
    format: 'string', choices: [], placeholder: typeof entry.placeholder === 'string' ? entry.placeholder : '',
    default: '', help: cleanText(entry.description, 160),
  };
  return { ok: true, headerFields: [field] };
}

function planPackage(pkg, server) {
  if (!isRecord(pkg)) return { ok: false, reason: '包条目不是对象' };
  const transport = isRecord(pkg.transport) ? pkg.transport.type : '';
  if (transport !== 'stdio') {
    return { ok: false, reason: '包的 transport 不是 stdio，暂不支持安全转换' };
  }
  const registryType = pkg.registryType;
  if (registryType !== 'npm' && registryType !== 'pypi') {
    return { ok: false, reason: `不支持的包类型 ${clip(registryType || '未知', 40)}` };
  }
  const id = typeof pkg.identifier === 'string' ? pkg.identifier : '';
  if (registryType === 'npm' ? !NPM_RE.test(id) : !PYPI_RE.test(id)) {
    return { ok: false, reason: '包标识符不合法' };
  }
  const declaredVersion = typeof pkg.version === 'string' && pkg.version ? pkg.version : '';
  const version = declaredVersion ? exactVersion(declaredVersion) : exactVersion(server.version);
  if (!version) return { ok: false, reason: '包版本不是具体版本（拒绝 latest / 范围 / 通配符）' };
  const hint = typeof pkg.runtimeHint === 'string' ? pkg.runtimeHint : '';
  const runtime = registryType === 'npm' ? 'npx' : 'uvx';
  if (hint && hint !== runtime) {
    return { ok: false, reason: `runtimeHint ${clip(hint, 40)} 与 ${registryType} 包不匹配` };
  }
  const base = typeof pkg.registryBaseUrl === 'string' ? pkg.registryBaseUrl : '';
  if (base && !(registryType === 'npm' ? NPM_REGISTRY_BASE_RE : PYPI_REGISTRY_BASE_RE).test(base)) {
    return { ok: false, reason: '自定义 registryBaseUrl 暂不支持，避免包来源与 Registry 声明不一致' };
  }
  const packageSpec = registryType === 'npm' ? `${id}@${version}` : `${id}==${version}`;
  const runtimePlan = planArguments(pkg.runtimeArguments, { prefix: 'rt' });
  if (!runtimePlan.ok) return runtimePlan;
  const badRuntime = runtimePlan.tokens.map(unsafeRuntimeToken).find(Boolean);
  if (badRuntime) {
    return { ok: false, reason: `runtimeArguments 使用了会改写包来源或执行命令的参数 ${badRuntime}，暂不支持安全转换` };
  }
  const packagePlan = planArguments(pkg.packageArguments, { prefix: 'arg' });
  if (!packagePlan.ok) return packagePlan;

  const hasYesFlag = runtimePlan.tokens.some((token) => token.parts.includes('-y') || token.parts.includes('--yes'));
  const runtimeDefaults = registryType === 'npm' && !hasYesFlag
    ? [{ kind: 'literal', parts: ['-y'], fields: [], template: '-y' }]
    : [];
  const tokens = [
    ...runtimeDefaults,
    ...runtimePlan.tokens,
    { kind: 'literal', parts: [packageSpec], fields: [], template: packageSpec },
    ...packagePlan.tokens,
  ];
  const fields = [...runtimePlan.fields, ...packagePlan.fields];
  const command = runtime;
  const commandTemplate = [command, ...tokens.map(tokenTemplate)].join(' ');

  /* 固定参数里如果已经带凭据形态的值，直接标成不可安装。带字段的参数在
   * 安装时还会用同一判据再检查一次。 */
  const literalArgs = tokens.flatMap((token) => token.parts.filter((p) => typeof p === 'string'));
  if (argsContainSecret(literalArgs)) {
    return { ok: false, reason: '固定参数疑似包含明文凭据，Pi GUI 不支持写入 args' };
  }

  const envPlan = { ok: true, envFields: [], requiredEnvKeys: [], staticEnv: [], envInputs: [] };
  const envList = Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables : [];
  if (pkg.environmentVariables !== undefined && !Array.isArray(pkg.environmentVariables)) {
    return { ok: false, reason: 'environmentVariables 不是数组' };
  }
  if (envList.length > 64) return { ok: false, reason: '环境变量过多' };
  const seenEnv = new Set();
  for (const entry of envList) {
    const p = planEnvEntry(entry);
    if (!p.ok) return p;
    if (entry && typeof entry.name === 'string') {
      if (seenEnv.has(entry.name)) return { ok: false, reason: '环境变量名重复' };
      seenEnv.add(entry.name);
    }
    envPlan.envFields.push(...(p.envFields || []));
    envPlan.requiredEnvKeys.push(...(p.requiredEnvKeys || []).filter(Boolean));
    if (p.staticEnv) envPlan.staticEnv.push(p.staticEnv);
    if (p.envInputs) envPlan.envInputs.push(...p.envInputs);
  }

  if (tokens.length > 32) return { ok: false, reason: '参数量超过 Pi 的 32 项上限' };

  return {
    ok: true,
    plan: {
      kind: 'stdio',
      command,
      tokens,
      fields,
      commandTemplate,
      envFields: envPlan.envFields,
      requiredEnvKeys: [...new Set(envPlan.requiredEnvKeys)],
      staticEnv: envPlan.staticEnv,
      envInputs: envPlan.envInputs,
      requires: registryType === 'npm' ? ['node', 'npx'] : ['python', 'uv', 'uvx'],
      runtimeArgCount: runtimeDefaults.length + runtimePlan.tokens.length,
      packageSpec,
    },
  };
}

function probeUrlFromParts(parts) {
  return parts.map((part) => (typeof part === 'string' ? part : 'x')).join('');
}

function planRemote(remote) {
  if (!isRecord(remote)) return { ok: false, reason: '远程条目不是对象' };
  if (remote.type === 'sse') return { ok: false, reason: 'Pi 不支持 legacy SSE transport' };
  if (remote.type !== 'streamable-http') return { ok: false, reason: '远程 transport 不是 streamable-http' };
  if (typeof remote.url !== 'string' || remote.url.length > 2048) {
    return { ok: false, reason: '远程 URL 模板不合法' };
  }
  const variables = isRecord(remote.variables) ? remote.variables : {};
  const parts = [];
  const fields = [];
  const re = /\{([A-Za-z0-9_.-]+)\}/g;
  let last = 0;
  let match;
  while ((match = re.exec(remote.url))) {
    if (match.index > last) parts.push(remote.url.slice(last, match.index));
    const name = match[1];
    const def = isRecord(variables[name]) ? variables[name] : null;
    if (!def) return { ok: false, reason: `URL 模板变量 ${name} 没有定义` };
    if (def.isSecret === true) return { ok: false, reason: 'URL 模板不能包含敏感变量（凭据不能进 URL）' };
    const staticValue = def.value !== undefined ? def.value : def.default;
    if (staticValue !== undefined) {
      const checked = checkInputValue(def, staticValue);
      if (!checked.ok) return { ok: false, reason: checked.error };
      parts.push(encodeURIComponent(checked.value));
    } else {
      const field = {
        key: `url.${name}`,
        label: inputLabel(def, name),
        required: def.isRequired === true,
        format: 'string',
        choices: Array.isArray(def.choices) ? def.choices.filter((c) => typeof c === 'string') : [],
        placeholder: typeof def.placeholder === 'string' ? def.placeholder : '',
        default: '',
        help: cleanText(def.description, 160),
        secret: false,
      };
      fields.push(field);
      parts.push({ field });
    }
    last = re.lastIndex;
  }
  if (last < remote.url.length) parts.push(remote.url.slice(last));
  if (!parts.length) return { ok: false, reason: '远程 URL 为空' };
  if (parts.some((p) => typeof p === 'string' && /[{}]/.test(p))) {
    return { ok: false, reason: 'URL 模板包含无法解析的花括号变量' };
  }
  const probe = probeUrlFromParts(parts);
  let parsed;
  try { parsed = new URL(probe); } catch { return { ok: false, reason: '远程 URL 模板不是合法 URL' }; }
  if (parsed.protocol !== 'https:') return { ok: false, reason: '远程 URL 只允许 HTTPS' };
  if (parsed.username || parsed.password) return { ok: false, reason: '远程 URL 不能包含用户名或密码' };
  if (parsed.port && parsed.port !== '443') return { ok: false, reason: '远程 URL 只允许 443 端口' };
  if (queryLooksSensitive(parsed)) {
    return { ok: false, reason: '远程 URL 的查询串或路径疑似包含凭据，无法安全转换；请改用请求头环境变量引用' };
  }
  const host = hostnameOf(parsed);
  if (blockedHostname(host) || (net.isIP(host) && isPrivateIp(host))) {
    return { ok: false, reason: '远程 URL 指向本机或内网地址' };
  }

  const headerPlan = { headerFields: [], requiredEnvKeys: [], staticHeaders: [], headerInputs: [] };
  if (remote.headers !== undefined && !Array.isArray(remote.headers)) {
    return { ok: false, reason: '远程 headers 不是数组' };
  }
  const seenHeaders = new Set();
  for (const entry of Array.isArray(remote.headers) ? remote.headers : []) {
    const p = planHeaderEntry(entry);
    if (!p.ok) return p;
    if (entry && typeof entry.name === 'string') {
      if (seenHeaders.has(entry.name)) return { ok: false, reason: '请求头名称重复' };
      seenHeaders.add(entry.name);
    }
    headerPlan.headerFields.push(...(p.headerFields || []));
    headerPlan.requiredEnvKeys.push(...(p.requiredEnvKeys || []).filter(Boolean));
    if (p.staticHeader) headerPlan.staticHeaders.push(p.staticHeader);
    if (p.headerInputs) headerPlan.headerInputs.push(...p.headerInputs);
  }

  const urlTemplate = parts.map((p) => (typeof p === 'string' ? p : `{${p.field.key}}`)).join('');
  return {
    ok: true,
    plan: {
      kind: 'http',
      urlParts: parts,
      fields,
      urlTemplate,
      headerFields: headerPlan.headerFields,
      requiredEnvKeys: [...new Set(headerPlan.requiredEnvKeys)],
      staticHeaders: headerPlan.staticHeaders,
      headerInputs: headerPlan.headerInputs,
      requires: [],
    },
  };
}

function analyzeRegistryServer(server) {
  if (!isRecord(server)) return { ok: false, reason: 'Registry server 不是对象' };
  const reasons = [];
  const packages = Array.isArray(server.packages) ? server.packages : [];
  for (const pkg of packages) {
    const p = planPackage(pkg, server);
    if (p.ok) return { ok: true, plan: p.plan };
    if (p.reason) reasons.push(p.reason);
  }
  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  for (const remote of remotes) {
    const p = planRemote(remote);
    if (p.ok) return { ok: true, plan: p.plan };
    if (p.reason) reasons.push(p.reason);
  }
  return {
    ok: false,
    reason: reasons[0] || '该条目没有可直接安装的 npm / PyPI stdio 包或 HTTPS streamable-http 端点，请在来源仓库按文档手动配置。',
  };
}

function resolveToken(token, values) {
  const used = [];
  let text = '';
  let empty = true;
  for (const part of token.parts) {
    if (typeof part === 'string') {
      text += part;
      if (part) empty = false;
      continue;
    }
    const field = part.field;
    const raw = values && values[field.key] !== undefined ? values[field.key] : field.default;
    const value = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!value) {
      if (field.required) {
        return codeError('missing-field', `请填写「${field.label}」`, { field: field.key });
      }
      continue;
    }
    const checked = checkInputValue(field, value);
    if (!checked.ok) {
      return codeError('bad-field', `「${field.label}」不合法：${checked.error}`, { field: field.key });
    }
    used.push({ key: field.key, value: checked.value, secret: field.secret === true });
    text += checked.value;
    empty = false;
  }
  return { ok: true, text, empty, used };
}

function displayArg(arg) {
  return /^[A-Za-z0-9_@%+=:,.\\/.-]+$/.test(arg) ? arg : `"${String(arg).replace(/"/g, '\\"')}"`;
}

function commandPreviewOf(command, args) {
  return [command, ...args].map(displayArg).join(' ');
}

function resolveEnvPlan(plan, values) {
  const env = {};
  for (const item of plan.staticEnv || []) {
    if (settingNeedsReference(item.name, item.value) && !ENV_REFERENCE_RE.test(item.value)) {
      return codeError('secret-value-unsupported', `环境变量「${item.name}」的值疑似凭据；请改用 \${环境变量名} 引用`);
    }
    env[item.name] = item.value;
  }
  for (const item of plan.envInputs || []) {
    const token = { parts: item.parts, fields: [] };
    const r = resolveToken(token, values);
    if (!r.ok) return r;
    if (r.empty) {
      if (item.required) return codeError('missing-field', `请填写「${item.label}」`);
      continue;
    }
    if (settingNeedsReference(item.name, r.text) && !ENV_REFERENCE_RE.test(r.text)) {
      return codeError('secret-value-unsupported', `环境变量「${item.name}」的值疑似凭据；请改用 \${环境变量名} 引用`);
    }
    env[item.name] = r.text;
  }
  for (const field of (plan.envFields || []).filter((f) => f.standalone === true)) {
    const raw = values && values[field.key] !== undefined ? values[field.key] : field.default;
    const value = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!value) {
      if (field.required) return codeError('missing-field', `请填写「${field.label}」`, { field: field.key });
      continue;
    }
    if (field.secret) {
      const ref = envReference(value);
      if (!ref) return codeError('bad-field', `「${field.label}」必须是合法的环境变量名`, { field: field.key });
      env[field.envKey] = ref;
    } else {
      const checked = checkInputValue(field, value);
      if (!checked.ok) return codeError('bad-field', `「${field.label}」不合法：${checked.error}`, { field: field.key });
      if (settingNeedsReference(field.envKey, checked.value) && !ENV_REFERENCE_RE.test(checked.value)) {
        return codeError('secret-value-unsupported', `环境变量「${field.envKey}」的值疑似凭据；请改用 \${环境变量名} 引用`, { field: field.key });
      }
      env[field.envKey] = checked.value;
    }
  }
  return { ok: true, env };
}

function resolveHeaderPlan(plan, values) {
  const headers = {};
  for (const item of plan.staticHeaders || []) {
    if (settingNeedsReference(item.name, item.value, { headers: true }) && !SETTING_REFERENCE_RE.test(item.value)) {
      return codeError('secret-value-unsupported', `请求头「${item.name}」的值疑似凭据；请改用 \${环境变量名} 引用`);
    }
    headers[item.name] = item.value;
  }
  for (const item of plan.headerInputs || []) {
    const r = resolveToken({ parts: item.parts, fields: [] }, values);
    if (!r.ok) return r;
    if (r.empty) {
      if (item.required) return codeError('missing-field', `请填写「${item.label}」`);
      continue;
    }
    if (settingNeedsReference(item.name, r.text, { headers: true }) && !SETTING_REFERENCE_RE.test(r.text)) {
      return codeError('secret-value-unsupported', `请求头「${item.name}」的值疑似凭据；请改用 \${环境变量名} 引用`);
    }
    if (/[\r\n\u0000]/.test(r.text)) return codeError('bad-field', `请求头「${item.name}」的值包含非法字符`);
    headers[item.name] = r.text;
  }
  for (const field of (plan.headerFields || []).filter((f) => f.standalone === true)) {
    const raw = values && values[field.key] !== undefined ? values[field.key] : field.default;
    const value = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!value) {
      if (field.required) return codeError('missing-field', `请填写「${field.label}」`, { field: field.key });
      continue;
    }
    if (field.secret) {
      const ref = headerReference(value, field.prefix || '');
      if (!ref) return codeError('bad-field', `「${field.label}」必须是合法的环境变量名`, { field: field.key });
      headers[field.header] = ref;
    } else {
      const checked = checkInputValue(field, value);
      if (!checked.ok) return codeError('bad-field', `「${field.label}」不合法：${checked.error}`, { field: field.key });
      if (/[\r\n\u0000]/.test(checked.value)) {
        return codeError('bad-field', `「${field.label}」包含非法字符`, { field: field.key });
      }
      if (settingNeedsReference(field.header, checked.value, { headers: true }) && !SETTING_REFERENCE_RE.test(checked.value)) {
        return codeError('secret-value-unsupported', `请求头「${field.header}」的值疑似凭据；请改用 \${环境变量名} 引用`, { field: field.key });
      }
      headers[field.header] = checked.value;
    }
  }
  return { ok: true, headers };
}

function resolveUrlPlan(plan, values) {
  let url = '';
  for (const part of plan.urlParts) {
    if (typeof part === 'string') { url += part; continue; }
    const field = part.field;
    const raw = values && values[field.key] !== undefined ? values[field.key] : field.default;
    const value = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!value) {
      if (field.required) return codeError('missing-field', `请填写「${field.label}」`, { field: field.key });
      continue;
    }
    const checked = checkInputValue(field, value);
    if (!checked.ok) return codeError('bad-field', `「${field.label}」不合法：${checked.error}`, { field: field.key });
    url += encodeURIComponent(checked.value);
  }
  if (url.length > 2048 || /[\u0000-\u001f\u007f]/.test(url)) {
    return codeError('bad-url', '远程 URL 不合法或过长');
  }
  let parsed;
  try { parsed = new URL(url); } catch { return codeError('bad-url', '远程 URL 不是合法地址'); }
  if (parsed.protocol !== 'https:') return codeError('bad-url', '远程 URL 只允许 HTTPS');
  if (parsed.username || parsed.password) return codeError('bad-url', '远程 URL 不能包含用户名或密码');
  if (parsed.port && parsed.port !== '443') return codeError('bad-url', '远程 URL 只允许 443 端口');
  if (queryLooksSensitive(parsed)) {
    return codeError('bad-url', '远程 URL 的查询串或路径疑似包含凭据；请改用请求头环境变量引用');
  }
  const host = hostnameOf(parsed);
  if (blockedHostname(host) || (net.isIP(host) && isPrivateIp(host))) {
    return codeError('bad-url', '远程 URL 指向本机或内网地址');
  }
  return { ok: true, url: parsed.toString() };
}

function buildRegistryConfig(server, values = {}) {
  const analysis = analyzeRegistryServer(server);
  if (!analysis.ok) return codeError('unsupported', analysis.reason);
  const plan = analysis.plan;
  const input = isRecord(values) ? values : {};
  if (plan.kind === 'stdio') {
    const args = [];
    for (const token of plan.tokens) {
      const r = resolveToken(token, input);
      if (!r.ok) return r;
      /* 可选参数没有填值时整项省略，不能留成 `--name=`。named 参数带有
       * `--name=` 前缀，单看 r.empty 永远为 false；要看实际填了几个字段值。 */
      if (token.skipIfEmpty && (r.empty || !r.used.length)) continue;
      args.push(r.text);
    }
    if (args.length > 32) return codeError('bad-args', '参数量超过 Pi 的 32 项上限');
    /* 用户填写的 runtime 参数也要再查一次：字段值可能是 `--registry=…`
     * 或 `-c`，不能靠模板阶段的静态检查。 */
    const badRuntime = args.slice(0, plan.runtimeArgCount || 0).map(unsafeRuntimeArg).find(Boolean);
    if (badRuntime) {
      return codeError('unsupported', `运行时参数 ${badRuntime} 会改写包来源或执行命令，已拒绝`);
    }
    if (argsContainSecret(args)) {
      return codeError('secret-value-unsupported', '启动参数疑似包含明文凭据；请改用环境变量，Pi GUI 不接收明文凭据');
    }
    const envResult = resolveEnvPlan(plan, input);
    if (!envResult.ok) return envResult;
    const config = {
      transport: 'stdio',
      command: plan.command,
      args,
      description: cleanText(server.description, 200),
      timeout: 60,
      exposure: 'codemode',
      ...(Object.keys(envResult.env).length ? { env: envResult.env } : {}),
    };
    return {
      ok: true,
      config,
      commandPreview: commandPreviewOf(plan.command, args),
      requires: plan.requires,
      requiredEnvKeys: plan.requiredEnvKeys,
    };
  }
  const urlResult = resolveUrlPlan(plan, input);
  if (!urlResult.ok) return urlResult;
  const headersResult = resolveHeaderPlan(plan, input);
  if (!headersResult.ok) return headersResult;
  const config = {
    transport: 'http',
    url: urlResult.url,
    description: cleanText(server.description, 200),
    timeout: 60,
    exposure: 'codemode',
    ...(Object.keys(headersResult.headers).length ? { headers: headersResult.headers } : {}),
  };
  return {
    ok: true,
    config,
    urlPreview: urlResult.url,
    requires: [],
    requiredEnvKeys: plan.requiredEnvKeys,
  };
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
  const analysis = analyzeRegistryServer(s);
  const plan = analysis.ok ? analysis.plan : null;
  const title = cleanText(s.title || name.split('/').pop() || name, 80);
  const description = cleanText(s.description, 400);
  const id = `registry:${Buffer.from(JSON.stringify({ name, version })).toString('base64url')}`;
  const installName = safeInstallName(title || name);
  const hasSse = Array.isArray(s.remotes) && s.remotes.some((r) => isRecord(r) && r.type === 'sse');
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
    transport: plan ? plan.kind : (hasSse ? 'sse' : (Array.isArray(s.packages) && s.packages.length ? 'stdio' : '')),
    commandSummary: plan && plan.kind === 'stdio' ? templateWithLabels(plan.commandTemplate, plan.fields) : '',
    commandTemplate: plan && plan.kind === 'stdio' ? plan.commandTemplate : '',
    urlPreview: plan && plan.kind === 'http' ? templateWithLabels(plan.urlTemplate, plan.fields) : '',
    urlTemplate: plan && plan.kind === 'http' ? plan.urlTemplate : '',
    homepage: isRecord(s.repository) && typeof s.repository.url === 'string' ? s.repository.url : '',
    requires: plan ? plan.requires : [],
    requiredEnvKeys: plan ? plan.requiredEnvKeys : [],
    installable: Boolean(plan),
    installReason: plan ? '' : analysis.reason,
    warning: '',
    fields: plan ? plan.fields.filter((f) => !f.key.startsWith('env.') && !f.key.startsWith('header.')).map(publicField) : [],
    envFields: plan ? (plan.envFields || []).map(publicEnvField) : [],
    headerFields: plan ? (plan.headerFields || []).map(publicHeaderField) : [],
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
      if (queryLooksSensitive(u)) return null;
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
  requestImpl = httpsGetPinned,
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
      const fetched = await fetchJson(registryQueryUrl({ q, cursor: pageCursor, limit }), { requestImpl, lookupImpl, env });
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
    const fetched = await fetchJson(source.url, { requestImpl, lookupImpl, env });
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

  async function resolveRegistry(id, values = {}) {
    if (!id.startsWith('registry:')) return codeError('bad-id', 'Registry 条目 ID 不合法');
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(id.slice('registry:'.length), 'base64url').toString('utf8'));
    } catch { return codeError('bad-id', 'Registry 条目 ID 不合法'); }
    if (!isRecord(decoded) || typeof decoded.name !== 'string' || typeof decoded.version !== 'string') {
      return codeError('bad-id', 'Registry 条目 ID 不合法');
    }
    const fetched = await fetchJson(registryQueryUrl({ q: decoded.name, limit: 50 }), { requestImpl, lookupImpl, env });
    if (!fetched.ok) return fetched;
    const rows = isRecord(fetched.data) && Array.isArray(fetched.data.servers) ? fetched.data.servers : [];
    let unsupported = null;
    for (const row of rows) {
      const item = normalizeRegistryEntry(row);
      if (!item || item.identifier !== decoded.name || item.version !== decoded.version) continue;
      const built = buildRegistryConfig(row.server, values);
      if (!built.ok) { unsupported = built; continue; }
      return {
        ok: true,
        entry: item,
        config: built.config,
        commandPreview: built.commandPreview || '',
        urlPreview: built.urlPreview || '',
        requires: built.requires || [],
        requiredEnvKeys: built.requiredEnvKeys || [],
      };
    }
    if (unsupported) return unsupported;
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
      const r = await resolveRegistry(catalogId, isRecord(input.values) ? input.values : {});
      if (!r.ok) return r;
      built = {
        ok: true, config: r.config, name: r.entry.installName, entry: r.entry,
        commandPreview: r.commandPreview, urlPreview: r.urlPreview,
        requires: r.requires, requiredEnvKeys: r.requiredEnvKeys,
      };
    } else if (source.startsWith('custom:')) {
      const r = await resolveCustom(catalogId);
      if (!r.ok) return r;
      built = { ok: true, config: { ...r.entry._config }, name: r.entry.installName, entry: r.entry };
    } else {
      return codeError('bad-source', '未知的市场源');
    }

    const requestedName = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : built.name;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestedName)
      || ['__proto__', 'prototype', 'constructor'].includes(requestedName)) {
      return codeError('bad-name', 'server 名只允许字母、数字、_ 和 -（1–64 字符，且不能是保留键）', { field: 'name' });
    }
    const entry = built.entry;
    const cfg = built.config;
    const save = await configStore.save({
      scope,
      name: requestedName,
      expectedRevision: input.expectedRevision,
      allowReplace: input.allowReplace === true,
      confirmOverride: input.confirmOverride === true,
      /* 覆盖安装是完整替换：不得把旧条目的 env / headers 带到新端点。 */
      replaceExisting: true,
      transport: cfg.transport,
      command: cfg.command,
      args: cfg.args,
      url: cfg.url,
      env: cfg.env ? Object.entries(cfg.env).map(([key, value]) => ({ key, value })) : undefined,
      headers: cfg.headers ? Object.entries(cfg.headers).map(([key, value]) => ({ key, value })) : undefined,
      description: cleanText(cfg.description || entry.description, 200),
      timeout: cfg.timeout || 60,
      exposure: cfg.exposure || 'codemode',
      enabled: true,
    });
    if (!save.ok) return save;
    const requires = Array.isArray(built.requires) ? built.requires : (entry.requires || []);
    const actualPreview = cfg.transport === 'stdio'
      ? commandPreviewOf(cfg.command, cfg.args || [])
      : (cfg.url || '');
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
      requires,
      commandPreview: built.commandPreview || actualPreview,
      urlPreview: built.urlPreview || (cfg.transport === 'http' ? (cfg.url || '') : ''),
      requiredEnvKeys: built.requiredEnvKeys || entry.requiredEnvKeys || [],
      dependencyProbe: probeDependencies(requires, env),
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
    const fetched = await fetchJson(rawUrl, { requestImpl, lookupImpl, env });
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
    /* 上面读列表与这里写列表之间隔着网络请求。两个并发 add-source 都
     * 基于旧的 sources 写回会静默丢掉其中一条；写前重新读一次，并重新
     * 检查重复与上限。readSources→writeSources 之间没有 await，Node
     * 单线程下不会再被另一个请求插入。 */
    const latest = readSources();
    if (!latest.ok) return codeError(latest.code, '现有市场源列表无法读取，为避免覆盖已拒绝写入');
    if (latest.sources.some((s) => s.url === rawUrl)) return codeError('source-exists', '这个市场源已经添加过了');
    if (latest.sources.length >= MAX_SOURCES) return codeError('too-many-sources', `最多只能添加 ${MAX_SOURCES} 个第三方市场源`);
    const write = writeSources([...latest.sources, source]);
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
      isFakeIpAddress,
      assertPublicHttps,
      normalizeRegistryEntry,
      normalizeCustomEntry,
      buildBuiltinConfig,
      probeDependencies,
      fetchJson,
      builtinItems,
      analyzeRegistryServer,
      buildRegistryConfig,
      pinnedRequestOptions,
      pinnedResponse,
      httpsGetPinned,
      noProxyMatches,
      blockingProxy,
      commandPreviewOf,
    },
  };
}

function cryptoRandom() {
  return crypto.randomBytes(6).toString('hex');
}
