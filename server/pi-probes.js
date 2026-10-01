/* P23 Capability probe registry。
 *
 * ---------- 这个模块解决什么 ----------
 *
 * P20.5 把「版本号当判据」换成了「读本机 pi 包给出证据」，但那些证据散在
 * 四个模块里（`pi-builtins` / `mcp` / `approval-probe` / `mcp-native`），
 * 各报各的，没有一个地方能回答「**我们到底 probe 了哪些能力，各自什么结论**」。
 * 升级 pi 之后要逐个模块点开看，很容易漏掉一项。
 *
 * 这里把它们收拢成一张**小型 probe 表**：每条 probe 只回答是 / 否 / 未知，
 * 带出处（读了哪个文件的哪一行）与**降级策略**（拿不到时 GUI 会怎样）。
 *
 * ---------- 四条硬纪律 ----------
 *
 * 1. **优先 probe feature，不写 `if version >= X`。** 同版本可能有构建差异，
 *    新版本通常仍兼容旧协议，fork 的版本号甚至完全不同。版本号只用来回答
 *    「这个版本我们核过没有」（见 `pi-compat-matrix.js`）。
 * 2. **只读、无副作用。** source probe 只 `readFileSync` 几个已知相对路径并限长；
 *    不 import pi 的模块、不 spawn、**绝不执行第三方 Extension 代码**。
 *    runtime probe 只读已有的观察（`pi-compat` 的能力三值、`mcp-native` 的摘要）。
 * 3. **拿不到就是 `null`（未知），不是 false。** false 只用于「文件读到了、
 *    里面确实没有这个东西」。
 * 4. **不回显整段原文。** 证据只留一行、截断到固定长度；绝对路径不进结果。
 *
 * ---------- 与 P20.5 的关系 ----------
 *
 * 这不是重写：`builtInExtensions` 的解析直接复用 `pi-builtins` 的
 * `parseBuiltInExtensions()`；MCP 的原生结论直接取 `mcp-native` 的摘要。
 * 这一层只是**汇总与统一形状**，不产生第二个事实。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseBuiltInExtensions } from './pi-builtins.js';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_EVIDENCE_CHARS = 200;
const MAX_RPC_UNION_CHARS = 64 * 1024;

/** 证据行截断（与其它 probe 模块同一条规矩：只留一行、不原样回显整段）。 */
const clip = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').slice(0, MAX_EVIDENCE_CHARS) : '');

function readTextSafe(file, maxBytes = MAX_FILE_BYTES) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 在文本里找第一行命中任一 pattern 的原文（截断）。找不到回 ''。 */
function findLine(text, patterns) {
  if (!text) return '';
  for (const line of text.split(/\r?\n/)) {
    for (const re of patterns) if (re.test(line)) return clip(line);
  }
  return '';
}

/** 读多个候选文件，返回第一条命中（带文件名）。用于「措辞/位置随版本漂移」的契约。 */
function findInFiles(dir, files, patterns) {
  let readable = 0;
  for (const rel of files) {
    const text = dir ? readTextSafe(path.join(dir, ...rel.split('/'))) : null;
    if (text === null) continue;
    readable++;
    const hit = findLine(text, patterns);
    if (hit) return { file: rel, evidence: hit };
  }
  return { file: null, evidence: '', readable };
}

/* ---------- 契约措辞与文档位置会随版本漂移（P23 实测）----------
 *
 * 0.87.0 / 0.99.1：对话框阻塞契约在 `docs/rpc.md`；tool_call 阻断写「**Can block.**」。
 * 0.99.2（本机实测）：对话框那一段**搬到** `docs/rpc-extension-ui.md`；
 * tool_call 的措辞改成「can mutate input or block execution」，配 `block: true` 示例。
 *
 * 所以 probe **同时接受两版**，证据里带上真正命中的文件 ——
 * 只认一处的话，升级之后 probe 会凭空给出 false（P23 的 live probe 就是这么
 * 抓到 P19 能力报告在实际 0.99.2 上把两件事都报成「不支持」的）。 */
const DIALOG_DOC_FILES = ['docs/rpc.md', 'docs/rpc-extension-ui.md'];
const DIALOG_BLOCK_PATTERNS = [/blocks? until the client sends back/i, /blocks? until the client/i];
const HOOK_DOC_PATTERNS = [
  /Can block/i,
  /before the tool executes/i,
  /can mutate input or block execution/i,
  /block:\s*true/,
];

/** 有没有这一行（只看存在性，不回显）。 */
function hasLine(text, patterns) {
  return Boolean(findLine(text, patterns));
}

/**
 * 解析 `dist/modes/rpc/rpc-types.d.ts` 里的 `RpcCommand` 联合 → 命令名数组。
 * 纯函数，便于用两个真实版本的原文做 fixture。
 *
 * 不用惰性正则去配 `};` —— 联合体里每个成员都以 `} | {` 结尾，边界很容易配错
 * （配错的表现是「只数到 1 条命令」这种**看起来正常**的结果）。
 * 改成「从 `export type RpcCommand` 切到下一个顶层 `export`」，与格式无关。
 *
 * @returns {string[]|null} null = 没找到这个联合（形状变了 / 读不到）
 */
export function parseRpcCommands(source) {
  if (typeof source !== 'string') return null;
  const start = source.indexOf('export type RpcCommand');
  if (start === -1) return null;
  const rest = source.slice(start + 'export type RpcCommand'.length, start + MAX_RPC_UNION_CHARS);
  const nextExport = rest.search(/\nexport\s/);
  const union = nextExport === -1 ? rest : rest.slice(0, nextExport);
  const names = [...new Set([...union.matchAll(/type:\s*"([a-z_]+)"/g)].map((m) => m[1]))].sort();
  return names.length ? names : null;
}

/**
 * probe 定义表。**顺序即展示顺序**：RPC 协议面在前，feature 面在后。
 *
 * - `kind: 'source'` 读 pi 包的文件（只读文本）；
 * - `kind: 'runtime'` 读已有观察（注入进来的快照）。
 *
 * `fallback` 是**降级策略**：这条 probe 拿不到（null）或为 false 时，GUI 会怎样。
 * 它是给人看的，也是升级复核时的清单。
 */
export const PROBE_DEFS = Object.freeze([
  Object.freeze({
    id: 'rpc-commands',
    kind: 'source',
    label: 'RPC 命令集',
    what: '能解析出 pi 的 RpcCommand 联合（协议面存在且形状认得）',
    fallback: '解析不出时 RPC 能力一律保持未知；GUI 不会因为读不到源码就拒绝启动。',
    file: 'dist/modes/rpc/rpc-types.d.ts',
  }),
  Object.freeze({
    id: 'rpc-no-tool-list',
    kind: 'source',
    label: 'RPC 无工具清单命令',
    what: '命令集里**确实没有**一条返回「已注册工具清单」的命令',
    fallback: '为 false（真出现了这样的命令）时仍不自动使用它 —— 需要人工核对后再接线。',
    file: 'dist/modes/rpc/rpc-types.d.ts',
  }),
  Object.freeze({
    id: 'extension-ui',
    kind: 'source',
    label: '扩展 UI 对话框子协议',
    what: '`extension_ui_request` 会阻塞等待客户端的 `extension_ui_response`',
    fallback: '为 false 时审批/提问框不出现，对话本身不受影响。',
    file: 'docs/rpc.md',
  }),
  Object.freeze({
    id: 'approval-hook',
    kind: 'source',
    label: 'tool_call 可阻断',
    what: 'Extension 能在工具执行前返回 `{ block: true }`（批准的真正闸门在这里）',
    fallback: '为 false 时 GUI 只说「拦不住」，不画假的允许 / 拒绝按钮。',
    file: 'dist/core/extensions/types.d.ts',
  }),
  Object.freeze({
    id: 'core-approval',
    kind: 'source',
    label: '核心自带审批闸门',
    what: 'pi 核心自己有没有审批弹窗 / 全局权限开关（有证据说「没有」时是 false）',
    fallback: '读不到就保持未知 —— 不据此宣称「已保护」。',
    file: 'docs/usage.md',
  }),
  Object.freeze({
    id: 'builtin-mcp',
    kind: 'source',
    label: 'builtin:mcp',
    what: '这个 pi 包里带了名为 mcp 的 built-in 扩展',
    fallback: '读不到包 → 未知；Native MCP 的能力报告保持未知，不猜成「不支持」。',
    file: 'dist/extensions/index.js',
  }),
  Object.freeze({
    id: 'builtin-codemode-tool-search',
    kind: 'source',
    label: 'builtin:codemode / tool-search',
    what: '包里带了 codemode 与 tool-search（都 replaceable）',
    fallback: '未知时只报「包里带了哪些」，不报「当前启用了哪个」。',
    file: 'dist/extensions/index.js',
  }),
  Object.freeze({
    id: 'mcp-runtime-states',
    kind: 'source',
    label: 'MCP 运行时状态闭集',
    what: '`ServerState` 联合与 GUI 的 allowlist 对得上（闭集外的值一律折成 unknown）',
    fallback: '对不上时运行时状态显示「无法识别」，不回显上游原文。',
    file: 'dist/extensions/mcp/runtime.d.ts',
  }),
  Object.freeze({
    id: 'mcp-cli-resources',
    kind: 'source',
    label: 'MCP list --json 资源字段',
    what: '`pi mcp list --json` 会带 resources / resourceTemplates（0.99.2 起）',
    fallback: '没有这两个字段时整行不显示（不写 0），其余字段照常。',
    file: 'dist/extensions/mcp/cli.js',
  }),
  Object.freeze({
    id: 'rpc',
    kind: 'runtime',
    label: 'RPC 通道真的通了',
    what: '收到过 pi 的合法 JSONL 信封（不只是外壳起来了）',
    fallback: 'false → 整个集成判为不兼容；unknown → 还没启动过 pi。',
  }),
  Object.freeze({
    id: 'tool-events',
    kind: 'runtime',
    label: 'tool_execution_* 事件',
    what: '见过 tool_execution_start / update / end（四个语义适配器都站在它上面）',
    fallback: '缺失时时间线条目收成「未完成」，四个适配器退回 generic 文案。',
  }),
  Object.freeze({
    id: 'extension-ui-runtime',
    kind: 'runtime',
    label: '扩展 UI 真的来过',
    what: '见过 extension_ui_request（当前这次运行真的弹过）',
    fallback: '没见过只是「这次没用上」，不是「不支持」。',
  }),
  Object.freeze({
    id: 'mcp-native',
    kind: 'runtime',
    label: 'Native MCP 生效',
    what: 'P20.6 原生状态是 active（builtin:mcp 在包里、未被禁用、未被接管）',
    fallback: 'replaced / disabled / unsupported 都如实显示成各自的结论；没有摘要时保持未知。',
  }),
  Object.freeze({
    id: 'mcp-replacement',
    kind: 'runtime',
    label: 'builtin MCP 是否被接管',
    what: '`get_commands` 里有扩展注册的 /mcp 命令（replaceable: true 的实际后果）',
    fallback: '未知时不宣称被接管，也不宣称没被接管。',
  }),
]);

const DEF_BY_ID = new Map(PROBE_DEFS.map((d) => [d.id, d]));

/* 「必须能下结论」的 probe：这些未知时，界面要明说「还验证不了」，
 * 而不是把未知当成「都正常」。 */
const REQUIRED_PROBE_IDS = new Set(['rpc-commands', 'rpc', 'builtin-mcp']);

/** 取定义里的相对路径（证据里只出现相对路径，绝对路径不进结果）。 */
const fileOf = (id) => DEF_BY_ID.get(id)?.file || '';

/** 能力三值 → probe 三值（同名直传；缺失一律 unknown）。 */
function capState(caps, key) {
  const v = caps ? caps[key] : null;
  return v === true || v === false ? v : null;
}

/**
 * @param resolvePackageDir 返回本机 pi 包目录（拿不到回 null）。**只从这里取**，
 *                          与 bridge 实际启动的那份 pi 同一身份（P20.5）。
 * @param identityKey       内部 identity key（launch 变化时立即重算缓存）。
 * @param compat            `createPiCompat()` 的实例（读能力三值）。
 * @param mcpNative         `createMcpNative()` 的实例（读原生摘要）。
 * @param now / ttlMs       时间源与缓存时长。
 */
export function createPiProbes({
  resolvePackageDir = null,
  identityKey = null,
  compat = null,
  mcpNative = null,
  now = () => Date.now(),
  ttlMs = 30_000,
} = {}) {
  let cache = null; // { key, at, probes }

  function currentKey() {
    let identity = '';
    try {
      identity = typeof identityKey === 'function' ? String(identityKey() || '') : '';
    } catch {
      identity = '';
    }
    let dir = '';
    try {
      dir = typeof resolvePackageDir === 'function' ? String(resolvePackageDir() || '') : '';
    } catch {
      dir = '';
    }
    return `${identity}|${dir}`;
  }

  function packageDir() {
    try {
      const dir = typeof resolvePackageDir === 'function' ? resolvePackageDir() : null;
      return typeof dir === 'string' && dir ? dir : null;
    } catch {
      return null;
    }
  }

  /** 读一次源文件集合（同一个 packageDir 只读一遍）。 */
  function readSources(dir) {
    const at = (rel) => (dir ? readTextSafe(path.join(dir, ...rel.split('/'))) : null);
    return {
      rpcTypes: at('dist/modes/rpc/rpc-types.d.ts'),
      extTypes: at('dist/core/extensions/types.d.ts'),
      extIndex: at('dist/extensions/index.js'),
      extDocs: at('docs/extensions.md'),
      usageDocs: at('docs/usage.md'),
      mcpRuntime: at('dist/extensions/mcp/runtime.d.ts'),
      mcpCli: at('dist/extensions/mcp/cli.js'),
    };
  }

  /** source probe：全部只读文本，全部限长，全部不回显原文。 */
  function sourceProbes(src, dir) {
    const out = new Map();

    const commands = parseRpcCommands(src.rpcTypes);
    out.set('rpc-commands', {
      state: commands ? true : (src.rpcTypes ? false : null),
      evidence: commands
        ? `${fileOf('rpc-commands')}: RpcCommand 联合共 ${commands.length} 条`
        : (src.rpcTypes ? '读到了 rpc-types.d.ts，但认不出 RpcCommand 联合的形状' : '读不到本机 pi 包的 rpc-types.d.ts'),
    });
    out.set('rpc-no-tool-list', {
      state: commands ? !commands.some((c) => /tool/.test(c)) : null,
      evidence: commands
        ? (commands.some((c) => /tool/.test(c))
          ? '命令集里出现了名字带 tool 的命令，需要人工核对它是不是工具清单'
          : `33 条量级的命令集里没有一条返回已注册工具清单（${commands.length} 条里没有 *tool*）`)
        : '命令集读不到，无法断言有没有工具清单命令',
    });

    const dialogBlock = findInFiles(dir, DIALOG_DOC_FILES, DIALOG_BLOCK_PATTERNS);
    out.set('extension-ui', {
      state: dialogBlock.evidence ? true : (dialogBlock.readable > 0 ? false : null),
      evidence: dialogBlock.evidence
        ? `${dialogBlock.file}: ${dialogBlock.evidence}`
        : (dialogBlock.readable > 0
          ? 'pi 的 rpc / rpc-extension-ui 文档里都没有找到对话框阻塞等待契约'
          : '读不到 docs/rpc.md 与 docs/rpc-extension-ui.md'),
    });

    const typeBlock = findLine(src.extTypes, [/block\?:\s*boolean/]);
    const docBlock = findLine(src.extDocs, HOOK_DOC_PATTERNS);
    out.set('approval-hook', {
      state: src.extTypes || src.extDocs ? Boolean(typeBlock && docBlock) : null,
      evidence: typeBlock && docBlock
        ? `${clip(typeBlock)}；${clip(docBlock)}`
        : (src.extTypes || src.extDocs ? '类型与文档里没有同时找到 tool_call 阻断契约' : '读不到本机 pi 包的类型与文档'),
    });

    /* 核心审批：**「有证据说没有」才是 false**。读到了 usage.md 但没有那句话 → unknown，
     * 不能据此断言核心「有」审批。 */
    const noApproval = findLine(src.usageDocs, [/permission popups/i, /does not include built-in/i]);
    out.set('core-approval', {
      state: src.usageDocs ? (noApproval ? false : null) : null,
      evidence: noApproval || (src.usageDocs ? 'docs/usage.md 里没有明确说法，不能据此断言核心有没有审批' : '读不到 docs/usage.md'),
    });

    const parsedBuiltins = src.extIndex ? parseBuiltInExtensions(src.extIndex) : null;
    const ids = parsedBuiltins && Array.isArray(parsedBuiltins.entries)
      ? parsedBuiltins.entries.map((e) => e.id)
      : null;
    out.set('builtin-mcp', {
      state: ids ? ids.includes('mcp') : null,
      evidence: ids
        ? (ids.includes('mcp') ? `builtInExtensions: ${ids.join(' / ')}` : `builtInExtensions 里没有 mcp：${ids.join(' / ') || '（空）'}`)
        : (src.extIndex ? '读到了 dist/extensions/index.js，但认不出 builtInExtensions 的形状' : '读不到 dist/extensions/index.js'),
    });
    out.set('builtin-codemode-tool-search', {
      state: ids ? (ids.includes('codemode') && ids.includes('tool-search')) : null,
      evidence: ids ? `builtInExtensions: ${ids.join(' / ')}` : '读不到 built-in 清单',
    });

    const stateLines = src.mcpRuntime
      ? [...src.mcpRuntime.matchAll(/['"](connecting|connected|disconnected|needs-auth|failed|closed)['"]/g)].map((m) => m[1])
      : null;
    const stateSet = stateLines ? [...new Set(stateLines)].sort() : null;
    out.set('mcp-runtime-states', {
      state: stateSet ? stateSet.length >= 6 : null,
      evidence: stateSet && stateSet.length
        ? `${fileOf('mcp-runtime-states')}: ${stateSet.join(' / ')}`
        : (src.mcpRuntime ? '没读到 MCP 运行时状态闭集' : '读不到 dist/extensions/mcp/runtime.d.ts'),
    });

    const cliHasResources = hasLine(src.mcpCli, [/resourceTemplates/]);
    out.set('mcp-cli-resources', {
      state: src.mcpCli ? cliHasResources : null,
      evidence: cliHasResources
        ? `${fileOf('mcp-cli-resources')}: 出现了 resourceTemplates`
        : (src.mcpCli ? 'cli.js 里没有 resourceTemplates —— 这个版本的 list --json 不带资源数字' : '读不到 dist/extensions/mcp/cli.js'),
    });

    return out;
  }

  /** runtime probe：只读已有观察，不触发任何新请求。 */
  function runtimeProbes() {
    const out = new Map();
    let caps = null;
    try {
      const r = compat && typeof compat.report === 'function' ? compat.report() : null;
      caps = r ? r.capabilities : null;
    } catch {
      caps = null;
    }
    out.set('rpc', { state: capState(caps, 'rpc'), evidence: '来自 pi-compat 的能力三值（收到过合法信封才为 true）' });
    out.set('tool-events', { state: capState(caps, 'toolEvents'), evidence: '来自 pi-compat 的能力三值（见过 tool_execution_* 才为 true）' });
    out.set('extension-ui-runtime', { state: capState(caps, 'extensionUi'), evidence: '来自 pi-compat 的能力三值（见过 extension_ui_request 才为 true）' });

    let native = null;
    try {
      native = mcpNative && typeof mcpNative.peekSummary === 'function' ? mcpNative.peekSummary() : null;
    } catch {
      native = null;
    }
    const state = native && native.native ? native.native.state : null;
    out.set('mcp-native', {
      state: state === 'active' ? true : (state && state !== 'unknown' ? false : null),
      evidence: native
        ? `原生状态：${state || '未知'}${native.native && native.native.reason ? ' —— ' + clip(native.native.reason) : ''}`
        : '尚未取到原生摘要（没打开过 MCP 页 / 换了项目）',
    });
    out.set('mcp-replacement', {
      state: state ? state === 'replaced' : null,
      evidence: state ? `原生状态：${state}` : '尚未取到原生摘要',
    });
    return out;
  }

  /**
   * 跑一遍 probe。同一个 identity + packageDir 内带 TTL 缓存；
   * `force` 用于显式刷新，`reset()` 用于 bridge 重启 / 换项目。
   */
  function report({ force = false } = {}) {
    const t = now();
    const key = currentKey();
    if (force || !cache || cache.key !== key || t - cache.at >= ttlMs) {
      const dir = packageDir();
      let source = new Map();
      try {
        source = sourceProbes(readSources(dir), dir);
      } catch (err) {
        if (process.env.PI_GUI_PROBE_DEBUG) console.error('probe source error:', err);
        // 单个文件读崩不该让整张表消失：下面按「没有结论」补 unknown
        source = new Map();
      }
      let runtime = new Map();
      try {
        runtime = runtimeProbes();
      } catch {
        runtime = new Map();
      }

      const probes = PROBE_DEFS.map((def) => {
        const hit = def.kind === 'source' ? source.get(def.id) : runtime.get(def.id);
        return {
          id: def.id,
          kind: def.kind,
          label: def.label,
          what: def.what,
          fallback: def.fallback,
          state: hit && (hit.state === true || hit.state === false) ? hit.state : null,
          evidence: hit && hit.evidence ? clip(hit.evidence) : '没有结论',
        };
      });
      cache = { key, at: t, probes, packageKnown: Boolean(dir) };
    }

    const probes = cache.probes.map((p) => ({ ...p }));
    const supported = probes.filter((p) => p.state === true).length;
    const unsupported = probes.filter((p) => p.state === false).length;
    const unknown = probes.filter((p) => p.state === null).length;
    return {
      ok: true,
      at: new Date(cache.at).toISOString(),
      packageKnown: cache.packageKnown,
      probes,
      summary: {
        total: probes.length,
        supported,
        unsupported,
        unknown,
        /* 核心 probe（拿不到就没法声称验证过任何东西）。 */
        unverified: probes.filter((p) => p.state === null && REQUIRED_PROBE_IDS.has(p.id)).map((p) => p.id),
      },
    };
  }

  /** 不触发任何 I/O，只看当前缓存（给同步报告用）。 */
  function peek() {
    if (!cache) return null;
    return {
      ok: true,
      at: new Date(cache.at).toISOString(),
      packageKnown: cache.packageKnown,
      probes: cache.probes.map((p) => ({ ...p })),
      summary: {
        total: cache.probes.length,
        supported: cache.probes.filter((p) => p.state === true).length,
        unsupported: cache.probes.filter((p) => p.state === false).length,
        unknown: cache.probes.filter((p) => p.state === null).length,
        unverified: cache.probes.filter((p) => p.state === null && REQUIRED_PROBE_IDS.has(p.id)).map((p) => p.id),
      },
    };
  }

  /** bridge 生命周期一变就清空 —— 旧 run 的 runtime probe 没有意义。 */
  function reset() {
    cache = null;
  }

  return {
    report,
    peek,
    reset,
    list: () => PROBE_DEFS.map((d) => ({ ...d })),
    _internals: { parseRpcCommands, DEF_BY_ID, REQUIRED_PROBE_IDS },
  };
}
