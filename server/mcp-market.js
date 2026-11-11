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
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import {
  argsContainSecret, queryLooksSensitive, settingNeedsReference, writeJsonAtomic,
} from './mcp-config.js';
import {
  blockedHostname, classifyAddress, classifyProxyRoute, hostnameOf,
  isAcceptableResolvedAddress, isFakeIpAddress, isPrivateIp,
} from '../lib/market-network-policy.cjs';

/* 官方现行文档的列表端点是 /v0.1/servers（旧 /v0 当前仍作为兼容别名返回
 * 同一份数据）。完整目录靠 metadata.nextCursor 逐页读取，单页 limit 上限
 * 为 100；超限时上游返回 422，所以这里不把上限交给调用方猜。 */
const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const SOURCES_FILE = 'mcp-market-sources.json';
const CACHE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCES = 10;
const REGISTRY_PAGE_LIMIT = 100;
const REGISTRY_DEFAULT_PAGE_SIZE = 24;
const REGISTRY_MAX_PAGE_SIZE = 100;
/* 防止上游异常游标把进程拖进无限翻页。2026-11 实测 618 页 / 61,758 条；
 * 这些上限只用来兜底，触发时明确报错，不缓存半份目录。 */
const REGISTRY_MAX_PAGES = 1_200;
const REGISTRY_MAX_ENTRIES = 100_000;
/* 官方 Registry 已增长到数万条、数百页。单页上限仍是 100（101 直接 422），
 * 只能按 cursor 顺序拉；实测 618 页 / 61,758 条约 4.5 分钟。总时限给足，
 * 单页仍是 8s —— 网络真断时第一页就会失败，不会干等十分钟。 */
const REGISTRY_CATALOG_TIMEOUT_MS = 600_000;
/* 完整目录落盘缓存：官方聚合器指南建议本地持久化并低频刷新。
 * 一小时内直接复用；过期时先返回旧目录，再在后台刷新。 */
const REGISTRY_CATALOG_TTL_MS = 60 * 60 * 1000;
const REGISTRY_CACHE_FILE = 'mcp-registry-catalog.json.gz';
const REGISTRY_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const REGISTRY_CACHE_MAX_SKEW_MS = 5 * 60 * 1000;
const REGISTRY_STALE_RETRY_MS = 30_000;
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
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
/* 市场只允许 HTTPS。不同工具对 HTTP_PROXY / HTTPS_PROXY 的语义并不完全
 * 一致；为避免“环境里有代理、系统却 DIRECT”时静默直连，任一代理变量都
 * 视为代理意图，必须由代理桥确认 proxied。NO_PROXY 是唯一明确的排除。 */
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'];
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

/**
 * 只做 URL 语法边界：HTTPS、443、无凭据、查询串无凭据形态、非本机主机名。
 * DNS / 线路判定在 `inspectMarketTarget` 里，因为同一条 URL 在直连与代理
 * 线路上的地址规则不同。
 */
function checkMarketUrl(rawUrl) {
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
  return { ok: true, url: u, hostname };
}

/**
 * 把目标地址收敛成一组**已经过校验的 IP**。直连时真正的 HTTPS 连接随后
 * 只允许连到这里的地址（自定义 lookup），域名只用于 TLS SNI 与证书校验。
 * 这样“先查一次、再让 fetch 自己查一次”的 DNS rebinding 窗口就不存在了。
 *
 * 代理线路上本地 DNS 结果仍要过同一套地址类别判定：
 *   - 公网地址：可以（代理会重新解析域名）
 *   - fake-IP（benchmark）：仅在代理线路、或桌面端明确允许 TUN fake-IP
 *     的直连线路上可以
 *   - 其它非公网地址：一律拒绝（本地解析器给出真实内网目标时，应用看不到
 *     代理会把它解析到哪里）
 */
async function inspectMarketTarget(parsed, {
  route = 'direct', allowFakeIp = false, lookupImpl = dns.promises.lookup,
} = {}) {
  const hostname = hostnameOf(parsed);
  const addresses = [];
  let fakeIp = false;
  /* 这里的判定都基于**本地**解析结果；连接若走代理，实际 DNS 在代理侧。
   * 错误元数据必须说清楚是哪一侧失败，不能让 dns:'proxy' 掩盖本地 DNS 失败。 */
  const localMeta = (fake = false) => ({ network: { route, addressVerified: false, dns: 'local', fakeIp: fake } });
  if (net.isIP(hostname)) {
    const family = net.isIP(hostname);
    if (isFakeIpAddress(hostname)) {
      return codeError(
        'proxy-blocked',
        '市场源 URL 直接使用了代理的 fake-IP 网段地址（198.18.0.0/15），无法确认实际连接目标；已拒绝。',
        localMeta(true),
      );
    }
    const kind = classifyAddress(hostname);
    if (kind !== 'public') return codeError('blocked-host', '不允许访问本机或内网地址', localMeta());
    addresses.push({ address: hostname, family });
  } else {
    let rows;
    try {
      rows = await lookupImpl(hostname, { all: true, verbatim: true });
    } catch {
      return codeError('dns-failed', '无法解析市场源域名', localMeta());
    }
    const list = Array.isArray(rows) ? rows : [rows];
    if (!list.length) return codeError('dns-failed', '市场源域名没有解析结果', localMeta());
    for (const row of list) {
      const address = String((row && row.address) || '');
      const family = net.isIP(address);
      const kind = family ? classifyAddress(address) : 'invalid';
      if (kind === 'benchmark') fakeIp = true;
      if (!isAcceptableResolvedAddress(kind, route, { allowFakeIp })) {
        if (kind === 'benchmark') {
          return codeError(
            'proxy-blocked',
            route === 'unknown'
              ? '该域名解析到代理的 fake-IP 网段（198.18.0.0/15），但无法确认系统代理线路；已拒绝请求。请启用系统代理后重试。'
              : '该域名解析到代理的 fake-IP 网段（198.18.0.0/15），但当前无法确认 TUN / 代理线路；已拒绝请求。请在桌面版中启用系统代理或改用直连 DNS 后重试。',
            localMeta(true),
          );
        }
        return codeError('blocked-host', '该域名解析到了本机或内网地址', localMeta());
      }
      addresses.push({ address, family: row.family === 4 || row.family === 6 ? row.family : family });
    }
  }
  if (!addresses.length) return codeError('dns-failed', '市场源域名没有解析结果', localMeta());
  return {
    ok: true,
    url: parsed,
    hostname,
    fakeIp,
    addresses: addresses.slice(0, MAX_PINNED_ADDRESSES),
  };
}

/**
 * 兼容旧调用点：严格直连判定（fake-IP 一律拒绝）。
 * 新代码请用 `checkMarketUrl` + `inspectMarketTarget`，把线路传进来。
 */
async function assertPublicHttps(rawUrl, lookupImpl, options = {}) {
  const checked = checkMarketUrl(rawUrl);
  if (!checked.ok) return checked;
  return inspectMarketTarget(checked.url, { lookupImpl, ...options });
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

function proxyEnvKeys(env) {
  const safeEnv = env || {};
  return PROXY_ENV_KEYS.filter((key) => typeof safeEnv[key] === 'string' && safeEnv[key].trim());
}

function usableNetworkBridge(network) {
  return Boolean(network
    && typeof network.resolveRoute === 'function'
    && typeof network.fetchProxied === 'function');
}

/**
 * 判断这条 URL 会走哪条线路。
 *
 * 优先级（从高到低）：
 *   1. `NO_PROXY` 命中 → 直连（仍走完整地址校验）。
 *   2. 任一环境变量代理（HTTPS_PROXY / https_proxy / ALL_PROXY /
 *      all_proxy / HTTP_PROXY / http_proxy）→ 必须由 Electron 代理桥给出
 *      `proxied`。桥给出 `direct` 或 `unknown` 都拒绝，不能静默绕过环境
 *      变量代理；没有桥则 `unsupported`，也不偷偷直连。市场只允许 HTTPS，
 *      这里保守地把所有代理变量都当作代理意图，避免工具间语义差异造成
 *      静默直连。
 *   3. 没有环境变量代理 → 以 Electron 代理桥的 `resolveProxy` 为准：
 *      `direct` / `proxied` / `unknown`。
 *   4. 没有桥且没有环境变量代理 → 直连（独立后端没有代理配置）。
 *
 * 任何解析超时、异常、非法值都收敛为 `unknown`；调用方必须在发起 DNS
 * 或 HTTP 之前拒绝，不能把 unknown 当成 direct。
 */
async function resolveMarketRoute(parsed, { network = null, env = process.env } = {}) {
  const host = hostnameOf(parsed);
  const port = parsed.port || '443';
  const safeEnv = env || {};
  if (noProxyMatches(host, port, safeEnv.NO_PROXY || safeEnv.no_proxy)) {
    return { route: 'direct', source: 'no-proxy' };
  }
  const envKeys = proxyEnvKeys(safeEnv);
  const bridge = usableNetworkBridge(network) ? network : null;
  if (!bridge) {
    if (network) {
      return {
        route: 'unsupported',
        source: envKeys.length ? 'env-proxy' : 'system-proxy',
        reason: 'bridge-incomplete',
        ...(envKeys.length ? { proxyKey: envKeys[0] } : {}),
      };
    }
    if (envKeys.length) return { route: 'unsupported', source: 'env-proxy', proxyKey: envKeys[0] };
    return { route: 'direct', source: 'no-proxy-stack' };
  }

  let route = 'unknown';
  let reason = '';
  try {
    route = await bridge.resolveRoute(parsed.toString());
  } catch {
    route = 'unknown';
    reason = 'resolve-failed';
  }
  if (route !== 'direct' && route !== 'proxied') {
    route = 'unknown';
    reason = reason || 'invalid-route';
  }
  if (envKeys.length) {
    if (route === 'proxied') {
      return { route, source: 'system-proxy', proxyKey: envKeys[0] };
    }
    return {
      route: 'unknown',
      source: 'env-proxy',
      reason: route === 'direct' ? 'env-proxy-bypassed' : 'env-proxy-route-unknown',
      proxyKey: envKeys[0],
    };
  }
  return { route, source: 'system-proxy', ...(reason ? { reason } : {}) };
}

function networkMeta(routeInfo, { fakeIp = false, resolution = null } = {}) {
  const route = routeInfo && routeInfo.route ? routeInfo.route : 'unknown';
  return {
    route,
    source: routeInfo && routeInfo.source ? routeInfo.source : 'unknown',
    /* 只有真正固定了已校验 IP 的直连才算 addressVerified。代理线路由
     * 可信代理栈连接但应用看不到最终对端；unknown / unsupported 根本没有
     * 发起连接，更不能标记为已验证。 */
    addressVerified: route === 'direct',
    dns: route === 'proxied' ? 'proxy' : (route === 'direct' ? 'local' : 'none'),
    fakeIp: fakeIp === true,
    ...(resolution ? { resolution } : {}),
  };
}

function pinnedLookupFor(address, family) {
  const fam = family === 4 || family === 6 ? family : (net.isIPv6(address) ? 6 : 4);
  return (hostname, options, callback) => {
    if (options && options.all) return callback(null, [{ address, family: fam }]);
    return callback(null, address, fam);
  };
}

/** 真实连接参数：hostname 保持原域名（SNI / 证书校验），lookup 只回已校验 IP。 */
function pinnedRequestOptions(url, address, family, headers = {}, agent = null) {
  const hostname = hostnameOf(url);
  const port = url.port ? Number(url.port) : 443;
  const options = {
    method: 'GET',
    protocol: 'https:',
    hostname,
    port,
    path: `${url.pathname || '/'}${url.search || ''}`,
    headers: { ...headers, host: url.host },
    /* 默认 agent:false：每个市场请求单独建连，不复用别的请求留下的连接。
     * 只有整份 Registry 目录抓取会传入自己的 keep-alive agent（见
     * fetchRegistryCatalog）；它仍走同一条固定 IP / 证书校验路径。 */
    agent: agent || false,
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
function httpsGetPinned(rawUrl, { address, family, timeoutMs, maxBytes, headers = {}, agent = null } = {}) {
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
      req = https.request(pinnedRequestOptions(u, address, family, headers, agent), (res) => {
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

/**
 * 代理桥返回的是 `{ ok, status, headers, body }`，不是真正的 `Response`。
 * 这里统一收敛状态码与 body 上限；`pinnedResponse` 负责挡住 204/205/304
 * 带 body 与 600–999 这类会让 Response 构造抛错的状态。
 */
function bridgeResponse(raw, maxBytes) {
  if (!raw || raw.ok !== true) {
    const err = new Error('market network bridge failed');
    err.marketCode = (raw && raw.code) || 'network';
    throw err;
  }
  const body = typeof raw.body === 'string' ? raw.body : '';
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    throw Object.assign(new Error('远端响应超过大小上限'), { marketCode: 'too-large' });
  }
  const status = Number(raw.status) || 0;
  const headers = {};
  for (const key of ['content-type', 'content-length', 'location']) {
    const value = raw.headers && raw.headers[key];
    if (typeof value === 'string' && value) headers[key] = value;
  }
  const bodyForbidden = status < 200 || status >= 300;
  return pinnedResponse(status, bodyForbidden ? null : body, headers);
}

/**
 * 代理线路的失败收口：固定文案 + 稳定 code，**不把代理地址、认证信息或
 * Chromium 原始错误回显给调用方**。代理凭据只属于系统/代理自身。
 */
function proxyFailureResult(err, routeInfo, fakeIp) {
  const code = err && err.marketCode;
  const network = networkMeta(routeInfo, { fakeIp });
  if (code === 'too-large') return codeError('too-large', '远端响应超过大小上限', { network });
  if (code === 'timeout' || (err && (err.name === 'TimeoutError' || err.name === 'AbortError'))) {
    return codeError('timeout', '市场源响应超时', { network });
  }
  if (code === 'proxy-auth-required') {
    return codeError(
      'proxy-auth-required',
      '系统代理要求认证或认证失败。Pi GUI 不接收代理凭据；请在操作系统或代理工具中完成认证后重试。',
      { network },
    );
  }
  if (code === 'proxy-unreachable') {
    return codeError('proxy-unreachable', '无法连接系统代理；请确认代理正在运行，或把目标域名加入 NO_PROXY 后重试。', { network });
  }
  if (code === 'tls-failed') {
    return codeError('tls-failed', 'HTTPS 证书校验失败；已拒绝连接。', { network });
  }
  if (code === 'dns-failed') {
    return codeError('dns-failed', '代理侧无法解析市场源域名。', { network });
  }
  if (code === 'blocked-route') {
    return codeError('proxy-blocked', '系统代理线路在请求前发生变化，无法确认实际连接路径；已拒绝请求。', { network });
  }
  return codeError('network', '无法通过系统代理连接市场源。', { network });
}

async function fetchJson(rawUrl, {
  requestImpl = httpsGetPinned,
  proxiedRequestImpl = null,
  lookupImpl = dns.promises.lookup,
  env = process.env,
  timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES,
  accept = 'application/json',
  network = null,
  allowFakeIp,
  agent = null,
} = {}) {
  const checked = checkMarketUrl(rawUrl);
  if (!checked.ok) return checked;
  const parsed = checked.url;
  const routeInfo = await resolveMarketRoute(parsed, { network, env });
  if (routeInfo.route === 'unsupported') {
    const detected = routeInfo.proxyKey ? `检测到代理环境变量 ${routeInfo.proxyKey}。` : '';
    const reason = routeInfo.reason === 'bridge-incomplete'
      ? '代理网络桥能力不完整。'
      : '当前运行方式没有可信的代理网络栈。';
    return codeError(
      'proxy-unsupported',
      `${detected}${reason}不能确认实际连接地址，也不会绕过代理直连。请在桌面版中通过系统代理访问，或把目标域名加入 NO_PROXY 后重试。`,
      { network: networkMeta(routeInfo) },
    );
  }
  /* unknown 不是 direct：线路无法确认时必须在这里拒绝，不能进入下面的
   * DNS 解析或 Node 直连。这样 PAC 混合线路、代理解析超时 / 异常 / 非法
   * 返回值都不会意外绕过代理。 */
  if (routeInfo.route === 'unknown') {
    const envConflict = routeInfo.reason === 'env-proxy-bypassed'
      || routeInfo.reason === 'env-proxy-route-unknown';
    const error = envConflict
      ? `检测到代理环境变量 ${routeInfo.proxyKey}，但系统代理线路为${routeInfo.reason === 'env-proxy-bypassed' ? '直连' : '未知'}；不能确认请求会走代理，已拒绝。请关闭环境变量代理，或让系统代理使用同一代理后重试。`
      : '无法确认系统代理线路（解析超时、异常或结果非法）；为避免绕过代理，市场请求已拒绝，且不会回退到直连。';
    return codeError('proxy-blocked', error, { network: networkMeta(routeInfo) });
  }
  /* 桌面版有主进程代理桥时，允许 TUN fake-IP 的直连路径：地址仍被固定，
   * TLS 仍按原域名校验。独立后端没有这条路径，fake-IP 继续 fail closed。
   * 只有两侧能力都在（判定线路 + 代理取数）才算可信桥，避免半截对象
   * 让直连 fake-IP 被误放行。 */
  const networkUsable = usableNetworkBridge(network);
  const fakeIpAllowed = allowFakeIp === true || (allowFakeIp === undefined && networkUsable);
  const safe = await inspectMarketTarget(parsed, {
    route: routeInfo.route,
    allowFakeIp: fakeIpAllowed,
    lookupImpl,
  });
  if (!safe.ok) return { ...safe, network: safe.network || networkMeta(routeInfo) };
  const meta = () => networkMeta(routeInfo, { fakeIp: safe.fakeIp });

  const deadline = Date.now() + timeoutMs;
  let response = null;
  if (routeInfo.route === 'proxied') {
    const proxyFetch = proxiedRequestImpl
      || (network && typeof network.fetchProxied === 'function'
        ? (url, opts) => network.fetchProxied(url, opts)
        : null);
    if (!proxyFetch) {
      return codeError('proxy-unsupported', '系统代理线路已确认，但代理网络桥不可用；市场请求已拒绝。', { network: meta() });
    }
    try {
      const raw = await proxyFetch(parsed.toString(), {
        timeoutMs: Math.max(1, deadline - Date.now()),
        maxBytes,
        headers: { accept, 'user-agent': 'pi-gui-mcp-market/1' },
      });
      response = bridgeResponse(raw, maxBytes);
    } catch (err) {
      return proxyFailureResult(err, routeInfo, safe.fakeIp);
    }
  } else {
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
          ...(agent ? { agent } : {}),
        });
        break;
      } catch (err) {
        if (err && err.marketCode === 'too-large') return codeError('too-large', '远端响应超过大小上限', { network: meta() });
        if (err && (err.marketCode === 'timeout' || err.name === 'TimeoutError' || err.name === 'AbortError')) sawTimeout = true;
        lastError = err;
        if (Date.now() >= deadline) break;
      }
    }
    if (!response) {
      if (sawTimeout) return codeError('timeout', '市场源响应超时', { network: meta() });
      return codeError('network', `无法连接市场源（${clip(lastError && lastError.message, 120)}）`, { network: meta() });
    }
  }
  const status = Number(response.status) || 0;
  if (status >= 300 && status < 400) {
    return codeError('redirect-blocked', '市场源返回重定向；为防绕过地址校验，已拒绝跟随', { network: meta() });
  }
  if (routeInfo.route === 'proxied' && status === 407) {
    return codeError(
      'proxy-auth-required',
      '系统代理要求认证或认证失败。Pi GUI 不接收代理凭据；请在操作系统或代理工具中完成认证后重试。',
      { network: meta() },
    );
  }
  if (!response.ok) {
    return codeError(`http-${status}`, `市场源返回 HTTP ${status || '未知'}`, { network: meta() });
  }
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (type && !type.includes('json')) return codeError('invalid-content-type', '市场源没有返回 JSON', { network: meta() });
  let text;
  try {
    text = await readCapped(response, maxBytes);
  } catch (err) {
    if (err && err.code) return { ...err, network: meta() };
    return codeError('read-failed', '读取市场源响应失败', { network: meta() });
  }
  try {
    const data = JSON.parse(text);
    if (!isRecord(data) && !Array.isArray(data)) return codeError('invalid-response', '市场源返回的 JSON 形状不认识', { network: meta() });
    return { ok: true, data, network: meta() };
  } catch {
    return codeError('invalid-response', '市场源返回的不是合法 JSON', { network: meta() });
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

function registryQueryUrl({ q, cursor, limit, version }) {
  const u = new URL(REGISTRY_BASE);
  if (q) u.searchParams.set('search', q.slice(0, 120));
  if (version) u.searchParams.set('version', String(version).slice(0, 200));
  u.searchParams.set('limit', String(Math.min(REGISTRY_PAGE_LIMIT, Math.max(1, Number(limit) || 20))));
  if (cursor) u.searchParams.set('cursor', String(cursor).slice(0, 500));
  return u.toString();
}

/* 完整目录只拉每个 server 的最新版本。不能把 `metadata.count` 当总数 ——
 * 它是**当前页**数量；总数必须在全部页合并、按 server name 去重后自己算。 */
function registryCatalogUrl({ cursor, limit = REGISTRY_PAGE_LIMIT } = {}) {
  const u = new URL(REGISTRY_BASE);
  u.searchParams.set('version', 'latest');
  u.searchParams.set('limit', String(Math.min(REGISTRY_PAGE_LIMIT, Math.max(1, Number(limit) || REGISTRY_PAGE_LIMIT))));
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
  proxiedRequestImpl = null,
  lookupImpl = dns.promises.lookup,
  network = null,
  allowFakeIp,
  now = () => Date.now(),
  /* 磁盘缓存默认开启；测试 / 只读嵌入可关闭，避免多个实例共享同一目录。 */
  registryCache = true,
} = {}) {
  const cache = new Map();
  /* 完整 Registry 目录（已去重、只含 latest）。`cache` 仍只管第三方源；
   * 这里单独保留 at / 上次成功结果，刷新失败时可以继续服务旧目录。 */
  let registryCatalog = null;
  let registryCatalogPromise = null;
  let registryRetryAt = 0;
  let registryLastError = null;
  let registryProgress = {
    active: false, done: false, pages: 0, items: 0, startedAt: 0, finishedAt: 0,
  };
  const sourcesFile = path.join(dataDir, SOURCES_FILE);
  const registryCacheFile = path.join(dataDir, REGISTRY_CACHE_FILE);

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

  function preferRegistryItem(current, next) {
    if (!current) return next;
    if (current.isLatest !== next.isLatest) return next.isLatest ? next : current;
    /* version=latest 理论上每个 name 只出现一次；这里仍按 isLatest 收敛，
     * 避免上游忽略筛选时把历史版本重复塞进完整目录。 */
    return current;
  }

  /** 磁盘缓存里的条目必须仍是 normalizeRegistryEntry 产出的形状。 */
  function isCachedRegistryItem(item) {
    if (!isRecord(item)) return false;
    if (item.source !== 'registry') return false;
    if (typeof item.id !== 'string' || !item.id || item.id.length > 500) return false;
    if (typeof item.identifier !== 'string' || !item.identifier || item.identifier.length > 200) return false;
    if (typeof item.name !== 'string' || item.name.length > 200) return false;
    if (typeof item.description !== 'string' || item.description.length > 400) return false;
    if (typeof item.category !== 'string' || typeof item.installable !== 'boolean') return false;
    return ['fields', 'envFields', 'headerFields', 'requires', 'requiredEnvKeys']
      .every((key) => Array.isArray(item[key]));
  }

  /**
   * 读取上次成功抓取的完整目录。缓存是自生成、可再生的数据：任何解析 /
   * 形状 / 时钟异常都按“没有缓存”处理，重新走网络，绝不让坏文件拖垮市场。
   */
  async function readRegistryCatalogFile() {
    if (registryCache !== true) return null;
    try {
      const st = await fs.promises.stat(registryCacheFile);
      if (!st.isFile() || st.size <= 0 || st.size > REGISTRY_CACHE_MAX_BYTES) return null;
      const packed = await fs.promises.readFile(registryCacheFile);
      const data = JSON.parse((await gunzip(packed)).toString('utf8'));
      if (!isRecord(data) || data.version !== 1) return null;
      if (!Number.isFinite(data.at) || !Array.isArray(data.items)) return null;
      if (data.items.length > REGISTRY_MAX_ENTRIES) return null;
      if (data.at - now() > REGISTRY_CACHE_MAX_SKEW_MS) return null;
      if (!data.items.every(isCachedRegistryItem)) return null;
      return {
        at: data.at,
        items: data.items,
        pages: Number.isFinite(data.pages) ? data.pages : 0,
        network: isRecord(data.network) ? data.network : null,
      };
    } catch {
      return null;
    }
  }

  /** 紧凑 JSON + gzip + 临时文件 rename；缓存可再生，不保留备份。 */
  async function writeRegistryCatalogFile(catalog) {
    if (registryCache !== true) return false;
    try {
      const text = JSON.stringify({
        version: 1,
        at: catalog.at,
        pages: catalog.pages,
        network: catalog.network,
        items: catalog.items,
      });
      const packed = await gzip(Buffer.from(text, 'utf8'), { level: zlib.constants.Z_BEST_SPEED });
      if (packed.length > REGISTRY_CACHE_MAX_BYTES) return false;
      const dir = path.dirname(registryCacheFile);
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = path.join(dir, `.${path.basename(registryCacheFile)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
      try {
        await fs.promises.writeFile(tmp, packed, { mode: 0o600 });
        await fs.promises.rename(tmp, registryCacheFile);
      } catch {
        try { await fs.promises.rm(tmp, { force: true }); } catch { /* ignore */ }
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** 给前端轮询用的加载进度：只有页数 / 条目数，不含任何远端内容。 */
  function registryStatus() {
    return {
      ok: true,
      active: registryProgress.active === true,
      done: registryProgress.done === true,
      pages: registryProgress.pages,
      items: registryProgress.items,
      startedAt: registryProgress.startedAt || null,
      finishedAt: registryProgress.finishedAt || null,
    };
  }

  /**
   * 按 cursor 拉完整 Registry 目录。任何一页失败都不返回半份数据：
   * 调用方要么拿到完整目录，要么拿到明确错误（旧缓存由调用方保留）。
   */
  async function fetchRegistryCatalog() {
    const byName = new Map();
    const seenCursors = new Set();
    let cursor = '';
    let pages = 0;
    let lastNetwork = null;
    const deadline = now() + REGISTRY_CATALOG_TIMEOUT_MS;
    /* 完整目录动辄数百页。默认的 agent:false 让每一页都重新做 TCP + TLS
     * 握手，数百页累计下来会先撞上总时限；这里只给“这一次目录抓取”配一个
     * 单连接 keep-alive agent。安全语义不变：每页仍由 fetchJson 重新解析
     * 并校验线路与 DNS，连接只可能复用同一 host:port 上已建立的那一条；
     * 抓完立即销毁，其它市场请求仍保持 agent:false。 */
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    registryProgress = {
      active: true, done: false, pages: 0, items: 0, startedAt: now(), finishedAt: 0,
    };
    try {
      for (;;) {
        /* 总时限是整份目录的，不只是“两页之间的检查点”：把剩余时间
         * 传给单页请求，避免最后一页在 deadline 前 1ms 起步再跑 8s。 */
        const remaining = deadline - now();
        if (remaining <= 0) {
          return { ...codeError('timeout', '完整加载 Registry 目录超时'), items: [], pages, network: lastNetwork };
        }
        const fetched = await fetchJson(registryCatalogUrl({ cursor }), {
          requestImpl, proxiedRequestImpl, lookupImpl, env, network, allowFakeIp, agent,
          timeoutMs: Math.min(FETCH_TIMEOUT_MS, Math.max(1, remaining)),
        });
        if (!fetched.ok) return { ...fetched, items: [], pages };
        lastNetwork = fetched.network || lastNetwork;
        const data = fetched.data;
        if (!isRecord(data) || !Array.isArray(data.servers)) {
          return { ...codeError('invalid-response', 'Registry 响应缺少 servers 数组'), items: [], pages, network: lastNetwork };
        }
        pages += 1;
        let shapedRows = 0;
        for (const row of data.servers) {
          if (isRecord(row) && isRecord(row.server)) shapedRows += 1;
          const item = normalizeRegistryEntry(row);
          if (!item) continue;
          byName.set(item.identifier, preferRegistryItem(byName.get(item.identifier), item));
        }
        registryProgress.pages = pages;
        registryProgress.items = byName.size;
        /* 非空页却没有任何 {server} 形状：多半是上游改了外层结构。
         * 不能把它当成“合法空目录”缓存一小时，否则整页市场静默变空。 */
        if (data.servers.length > 0 && shapedRows === 0) {
          return {
            ...codeError('invalid-response', 'Registry 返回的 servers 条目缺少 server 对象'),
            items: [], pages, network: lastNetwork,
          };
        }
        if (byName.size > REGISTRY_MAX_ENTRIES) {
          return {
            ...codeError('registry-too-large', `Registry 目录超过 ${REGISTRY_MAX_ENTRIES} 条，已停止加载`),
            items: [], pages, network: lastNetwork,
          };
        }
        const metadata = isRecord(data.metadata) ? data.metadata : {};
        const next = metadata.nextCursor;
        if (next === undefined || next === null) break;
        if (typeof next !== 'string') {
          return { ...codeError('invalid-response', 'Registry 分页游标不是字符串'), items: [], pages, network: lastNetwork };
        }
        if (!next.trim()) break;
        if (next === cursor || seenCursors.has(next)) {
          return { ...codeError('registry-cursor-loop', 'Registry 分页游标重复；已停止加载'), items: [], pages, network: lastNetwork };
        }
        if (pages >= REGISTRY_MAX_PAGES) {
          return {
            ...codeError('registry-too-large', `Registry 目录超过 ${REGISTRY_MAX_PAGES} 页，已停止加载`),
            items: [], pages, network: lastNetwork,
          };
        }
        seenCursors.add(next);
        cursor = next;
      }
      return { ok: true, items: [...byName.values()], pages, network: lastNetwork };
    } finally {
      agent.destroy();
      registryProgress = {
        ...registryProgress, active: false, done: true, finishedAt: now(),
      };
    }
  }

  function startRegistryRefresh() {
    if (registryCatalogPromise) return registryCatalogPromise;
    registryCatalogPromise = (async () => {
      try {
        const loaded = await fetchRegistryCatalog();
        if (!loaded.ok) {
          registryLastError = loaded;
          if (registryCatalog) {
            registryRetryAt = now() + REGISTRY_STALE_RETRY_MS;
            return { ok: true, catalog: registryCatalog, cached: true, stale: true, refreshError: loaded };
          }
          return { ...loaded, catalog: null };
        }
        registryCatalog = {
          at: now(), items: loaded.items, network: loaded.network, pages: loaded.pages,
        };
        registryLastError = null;
        registryRetryAt = 0;
        await writeRegistryCatalogFile(registryCatalog);
        return { ok: true, catalog: registryCatalog, cached: false, stale: false };
      } catch {
        const failed = codeError('registry-error', 'Registry 目录加载失败');
        registryLastError = failed;
        if (registryCatalog) {
          registryRetryAt = now() + REGISTRY_STALE_RETRY_MS;
          return { ok: true, catalog: registryCatalog, cached: true, stale: true, refreshError: failed };
        }
        return { ...failed, catalog: null };
      } finally {
        registryCatalogPromise = null;
      }
    })();
    return registryCatalogPromise;
  }

  async function ensureRegistryCatalog() {
    if (!registryCatalog) {
      const disk = await readRegistryCatalogFile();
      if (disk) registryCatalog = disk;
    }
    if (registryCatalog && now() - registryCatalog.at <= REGISTRY_CATALOG_TTL_MS) {
      return { ok: true, catalog: registryCatalog, cached: true, stale: false };
    }
    if (registryCatalog) {
      /* 过期目录立即返回，刷新放到后台：完整抓取要数分钟，不能让每次
       * 打开市场都卡在这里。刷新失败时下一次请求会带上 refreshError。 */
      if (!registryCatalogPromise && now() >= registryRetryAt) {
        startRegistryRefresh().catch(() => {});
      }
      return {
        ok: true, catalog: registryCatalog, cached: true, stale: true,
        ...(registryCatalogPromise ? { refreshing: true } : {}),
        ...(registryLastError ? { refreshError: registryLastError } : {}),
      };
    }
    return startRegistryRefresh();
  }

  /**
   * 启动后台预取：桌面版主进程会打开这个开关。调用立即返回，不阻塞启动，
   * 也不会抛错；已有新鲜缓存时只读盘，过期时走后台刷新，没有缓存才发起
   * 完整抓取。失败只记录状态 —— 用户打开市场时会重试并看到明确错误。
   */
  function warmRegistryCatalog() {
    return ensureRegistryCatalog().then(() => undefined, () => undefined);
  }

  /**
   * Registry 列表完全基于缓存目录做本地搜索 / 分类 / 分页。
   * 不用上游 search：官方要求至少 3 个 Unicode 字符，短词会直接 422；
   * 分页也只切缓存，不会因为翻页重新抓一遍完整 Registry。
   */
  async function registryList({
    q = '', category = '全部', page, pageSize, limit, offset,
  } = {}) {
    const ensured = await ensureRegistryCatalog();
    if (!ensured.ok) return { ...ensured, items: [] };
    const cat = CATEGORIES.includes(category) ? category : '全部';
    const query = String(q || '').trim().toLowerCase();
    /* 空串 / 0 / 非数字都按“没传”处理，回落到默认 24；合法值再夹到 1..100。 */
    const rawSize = pageSize !== undefined ? pageSize : limit;
    const requestedSize = rawSize === '' || rawSize === null ? NaN : Number(rawSize);
    const size = Number.isFinite(requestedSize) && requestedSize > 0
      ? Math.min(REGISTRY_MAX_PAGE_SIZE, Math.max(1, Math.floor(requestedSize)))
      : REGISTRY_DEFAULT_PAGE_SIZE;
    const all = ensured.catalog.items.filter((item) => {
      if (cat !== '全部' && item.category !== cat) return false;
      if (!query) return true;
      return `${item.name} ${item.identifier} ${item.description}`.toLowerCase().includes(query);
    });
    const total = all.length;
    const totalPages = total ? Math.ceil(total / size) : 0;
    const requestedPage = Number(page);
    let currentPage = Number.isFinite(requestedPage) && requestedPage >= 1
      ? Math.floor(requestedPage) : 0;
    if (!currentPage) {
      const requestedOffset = Number(offset);
      currentPage = Number.isFinite(requestedOffset) && requestedOffset > 0
        ? Math.floor(requestedOffset / size) + 1 : 1;
    }
    currentPage = totalPages > 0 ? Math.min(currentPage, totalPages) : 1;
    const start = (currentPage - 1) * size;
    return {
      ok: true,
      source: 'registry',
      items: all.slice(start, start + size),
      total,
      page: currentPage,
      pageSize: size,
      totalPages,
      hasMore: currentPage < totalPages,
      nextCursor: null,
      categories: CATEGORIES,
      network: ensured.catalog.network,
      cached: ensured.cached === true,
      catalogPages: ensured.catalog.pages,
      ...(ensured.stale ? { stale: true } : {}),
      ...(ensured.refreshing ? { refreshing: true } : {}),
      ...(ensured.refreshError ? { refreshError: ensured.refreshError } : {}),
    };
  }

  async function loadCustomSource(source) {
    const fetched = await fetchJson(source.url, {
      requestImpl, proxiedRequestImpl, lookupImpl, env, network, allowFakeIp,
    });
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
    return {
      ok: true, items, network: fetched.network,
      catalogName: cleanText(data.name || source.name, 80) || source.name,
    };
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
      network: loaded.network,
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
    const fetched = await fetchJson(registryQueryUrl({
      q: decoded.name, version: decoded.version, limit: REGISTRY_PAGE_LIMIT,
    }), {
      requestImpl, proxiedRequestImpl, lookupImpl, env, network, allowFakeIp,
    });
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
        network: fetched.network,
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
        requires: r.requires, requiredEnvKeys: r.requiredEnvKeys, network: r.network,
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
      network: built.network || null,
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
    const fetched = await fetchJson(rawUrl, {
      requestImpl, proxiedRequestImpl, lookupImpl, env, network, allowFakeIp,
    });
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
    return {
      ok: true,
      source: { id: source.id, name: source.name, url: source.url, addedAt: source.addedAt },
      count: probe.items.length,
      network: probe.network || fetched.network,
    };
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
    registryStatus,
    warmRegistryCatalog,
    _internals: {
      BUILTIN,
      CATEGORIES,
      isPrivateIp,
      isFakeIpAddress,
      classifyAddress,
      assertPublicHttps,
      checkMarketUrl,
      inspectMarketTarget,
      resolveMarketRoute,
      networkMeta,
      normalizeRegistryEntry,
      normalizeCustomEntry,
      buildBuiltinConfig,
      probeDependencies,
      fetchJson,
      builtinItems,
      registryCatalogUrl,
      registryQueryUrl,
      analyzeRegistryServer,
      buildRegistryConfig,
      pinnedRequestOptions,
      pinnedResponse,
      httpsGetPinned,
      noProxyMatches,
      proxyEnvKeys,
      commandPreviewOf,
    },
  };
}

function cryptoRandom() {
  return crypto.randomBytes(6).toString('hex');
}
