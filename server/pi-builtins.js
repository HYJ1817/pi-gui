/* Pi built-in capability 探测（P20.5）。
 *
 * ---------- 为什么要有这个模块 ----------
 *
 * pi 0.99.x 自带四个 **built-in extension**：`llama.cpp`、`codemode`、
 * `tool-search`、`mcp`。它们**不是** npm 上装的包，也不出现在
 * `~/.pi/agent/extensions/` —— 它们编译在 pi 包里面（`dist/extensions/`）。
 *
 * 所以：
 *
 *   - **不能拿 Extension Registry 的目录扫描去找它们**（那边扫的是用户装的
 *     extension；扫不到 built-in，扫到了也说明不了什么）；
 *   - 也不能硬编码「当前一定启用」—— `builtinExtensions` 里 `mcp` / `codemode` /
 *     `tool-search` 是 `replaceable: true`，第三方 extension 注册同名能力时
 *     **会接管**；`llama.cpp` 在 0.87.0 里甚至标着 `hidden: true`。
 *
 * 这里做的是**只读证据**：把 pi 包里那份 `builtInExtensions` 原文解析出来，
 * 逐条报告「这个版本带了哪些 built-in」，并说明**这只证明包里带了它**，
 * 不证明当前会话启用了它。启用与否要看真实运行事件（或 `/api/mcp` 的
 * capability 报告），本模块不猜。
 *
 * ---------- 纪律 ----------
 *
 * - **只读、不执行。** 不 import pi 的任何模块、不 spawn、不 require。
 *   只 `readFileSync` 几个已知路径，全部限长。
 * - **不读配置内容。** MCP 配置文件只报**存在与否**：里面可能有
 *   `headers.Authorization` 与 `env` 密钥，一个字节都不读进来。
 * - **拿不到就是 unknown。** 包目录找不到、文件读不到、格式不认识 → null，
 *   不写成 false。false 只用于「文件读到了、但里面确实没有这个东西」。
 * - **不回显整段原文。** 证据只留一行，截断到固定长度。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_EVIDENCE_CHARS = 220;
/** builtInExtensions 数组字面量的长度上限（防止正则吃到文件末尾）。 */
const MAX_ARRAY_CHARS = 4096;

function readTextSafe(file, maxBytes = MAX_FILE_BYTES) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const clip = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').slice(0, MAX_EVIDENCE_CHARS) : '');

/**
 * 解析 `dist/extensions/index.js` 里的 `builtInExtensions` 数组。
 * 纯函数（输入源码文本），便于用两个真实版本的原文做 fixture。
 *
 * @returns {{ entries: Array<{id:string, replaceable:boolean, hidden:boolean, evidence:string}>, evidence: string }|null}
 *          null = 没找到这个数组（版本太老或形状变了）→ 调用方按 unknown 处理
 */
export function parseBuiltInExtensions(source) {
  if (typeof source !== 'string') return null;
  const block = new RegExp(`export const builtInExtensions\\s*=\\s*\\[([\\s\\S]{0,${MAX_ARRAY_CHARS}}?)\\]\\s*;`).exec(source);
  if (!block) return null;
  const body = block[1];
  const entries = [];
  const re = /\{\s*name:\s*"([^"]+)"([^}]*)\}/g;
  let m;
  while ((m = re.exec(body))) {
    const flags = m[2] || '';
    entries.push({
      id: m[1].slice(0, 64),
      replaceable: /replaceable:\s*true/.test(flags),
      hidden: /hidden:\s*true/.test(flags),
      evidence: clip(m[0]),
    });
  }
  if (!entries.length) return null;
  return { entries, evidence: clip(block[0]) };
}

/**
 * @param resolvePackageDir 返回本机 pi 包目录（找不到回 null）。注入便于单测。
 * @param env               环境变量（找 `~/.pi/agent`）。
 * @param now               时间源。
 * @param ttlMs             缓存时长。
 */
export function createPiBuiltins({
  resolvePackageDir = null,
  env = process.env,
  now = () => Date.now(),
  ttlMs = 30_000,
} = {}) {
  let cache = null;

  function packageDir() {
    if (typeof resolvePackageDir !== 'function') return null;
    try {
      const dir = resolvePackageDir();
      return typeof dir === 'string' && dir ? dir : null;
    } catch {
      return null;
    }
  }

  /** 在 pi 包的某个源码文件里找 token，返回三值与出处行。 */
  function probeTokens(dir, rel, tokens) {
    const text = readTextSafe(path.join(dir, ...rel.split('/')));
    if (text === null) return { available: null, found: Object.fromEntries(tokens.map((t) => [t, null])), evidence: '' };
    const lines = text.split(/\r?\n/);
    const found = {};
    let evidence = '';
    for (const token of tokens) {
      const hit = lines.find((l) => l.includes(token));
      found[token] = Boolean(hit);
      if (hit && !evidence) evidence = clip(hit);
    }
    return { available: true, found, evidence };
  }

  /** RPC 命令联合里的命令名（用来证明「有没有工具清单命令」）。
   *
   *  不用惰性正则去配 `};` —— 联合体里每个成员都以 `} | {` 结尾，
   *  边界很容易配错（配错的表现是「只数到 1 条命令」这种**看起来正常**的结果）。
   *  改成「从 `export type RpcCommand` 切到下一个顶层 `export`」，与格式无关。 */
  function probeRpcCommands(dir) {
    const text = readTextSafe(path.join(dir, 'dist', 'modes', 'rpc', 'rpc-types.d.ts'));
    if (text === null) return { available: null, commands: null };
    const start = text.indexOf('export type RpcCommand');
    if (start === -1) return { available: true, commands: null };
    const rest = text.slice(start + 'export type RpcCommand'.length);
    const nextExport = rest.search(/\nexport\s/);
    const union = nextExport === -1 ? rest : rest.slice(0, nextExport);
    const names = [...new Set([...union.matchAll(/type:\s*"([a-z_]+)"/g)].map((m) => m[1]))].sort();
    return { available: true, commands: names.length ? names : null };
  }

  /** MCP 配置文件：只报存在与否，**不读内容**。 */
  function probeMcpConfig(cwd) {
    const home = env.HOME || os.homedir();
    const agentDir = env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent');
    const exists = (file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    };
    const projectRoot = typeof cwd === 'string' && cwd ? cwd : null;
    return {
      // 用户级：~/.pi/agent/mcp.json
      user: { exists: exists(path.join(agentDir, 'mcp.json')) },
      // 项目级：<cwd>/.pi/mcp.json（pi 只在项目被信任后才读它）
      project: projectRoot ? { exists: exists(path.join(projectRoot, '.pi', 'mcp.json')) } : { exists: null },
    };
  }

  function compute(cwd) {
    const dir = packageDir();
    if (!dir) {
      /* 包找不到，但「本机有没有 mcp.json」与包在哪无关 —— 这一条照常给，
       * 其余的（built-ins / ExtensionAPI / RPC）保持 unknown。 */
      return {
        known: false,
        source: null,
        builtins: null,
        builtinsEvidence: '',
        extensionApi: { available: null, registerMcpServer: null, getMcpServers: null, getAllTools: null, evidence: '' },
        rpc: { available: null, commands: null, toolListCommand: null, evidence: '' },
        mcpConfig: probeMcpConfig(cwd),
        mcpCli: { available: null, evidence: '' },
        at: now(),
      };
    }

    const extIndex = readTextSafe(path.join(dir, 'dist', 'extensions', 'index.js'));
    const parsed = parseBuiltInExtensions(extIndex);

    const api = probeTokens(dir, 'dist/core/extensions/types.d.ts', [
      'registerMcpServer',
      'getMcpServers',
      'getAllTools',
    ]);
    const rpcRaw = probeRpcCommands(dir);
    // 「有没有一条返回已注册工具清单的命令」—— 只有命令名列表可信时才给结论。
    const toolListCommand = rpcRaw.commands
      ? rpcRaw.commands.some((c) => /tool/.test(c))
      : null;
    const rpcEvidence = rpcRaw.commands
      ? `RpcCommand 联合共 ${rpcRaw.commands.length} 条：${rpcRaw.commands.join(', ')}`
      : '';

    const mcpDoc = readTextSafe(path.join(dir, 'docs', 'mcp.md'));
    const cliLine = typeof mcpDoc === 'string'
      ? (mcpDoc.split(/\r?\n/).find((l) => /pi mcp add/.test(l)) || '')
      : '';

    return {
      known: true,
      source: 'dist/extensions/index.js',
      builtins: parsed ? parsed.entries : null,
      builtinsEvidence: parsed ? parsed.evidence : '',
      extensionApi: {
        available: api.available,
        registerMcpServer: api.found.registerMcpServer,
        getMcpServers: api.found.getMcpServers,
        getAllTools: api.found.getAllTools,
        evidence: api.evidence,
      },
      rpc: { available: rpcRaw.available, commands: rpcRaw.commands, toolListCommand, evidence: clip(rpcEvidence) },
      mcpConfig: probeMcpConfig(cwd),
      mcpCli: { available: mcpDoc === null ? null : Boolean(cliLine), evidence: clip(cliLine) },
      at: now(),
    };
  }

  /**
   * @param cwd 当前项目目录（决定要不要看项目级 mcp.json）。可空。
   *
   * 缓存键里带上 cwd —— 否则切了项目之后 `mcpConfig.project` 会返回上一个
   * 项目的结论（TTL 内不重算）。这种「看起来正常的旧值」是最难查的一类错。
   */
  function read({ cwd = null, force = false } = {}) {
    const key = typeof cwd === 'string' ? cwd : '';
    const t = now();
    if (force || !cache || cache.key !== key || t - cache.at >= ttlMs) {
      cache = { key, at: t, data: compute(cwd) };
    }
    const { at, data } = cache;
    return { ...data, updatedAt: new Date(at).toISOString() };
  }

  function reset() {
    cache = null;
  }

  return { read, reset, _internals: { parseBuiltInExtensions } };
}
