/* Capability 投影层（P22）。
 *
 * ---------- 这一层是什么，不是什么 ----------
 *
 * 它**不是第二套事实源**，也**不是数据库**。它只做一件事：把已经存在、已经带出处的
 * 证据重新投影成一张统一的表。三条来源，一条都不新增：
 *
 *   1. **Extension Registry**（`/api/extensions`）—— 磁盘上有没有、配置里启没启用、
 *      Pi 有没有证实加载（`loaded`）、有没有发现错误；
 *   2. **feature runtime observation** —— 各 feature 模块自己的观察（本次
 *      `workspaceGeneration` / `bridgeRun` 内真的收到过哪些 `tool_execution_*`）；
 *   3. **P20.5 / P20.6 capability truth** —— `/api/mcp` 的 built-in 清单与
 *      `/api/mcp/servers` 的原生状态机（active / replaced / disabled /
 *      unsupported / unknown）。**MCP 的原生状态在这里只做搬运，不重新判断** ——
 *      判定留在 `server/mcp-native.js`，投影只把它的原文词汇翻译成界面文案。
 *
 * ---------- 三值纪律（写错就是骗人）----------
 *
 * `null` 一律显示「未知（无法确认）」，**绝不显示成 false**。磁盘上没有 ≠ 未加载，
 * 没观察到调用 ≠ 没这个能力。只有真读到了「没有」才给 false。
 * `'n/a'` 是第四种值：这个字段对这类能力**不适用**（例如 pi 原生能力没有 npm 安装概念），
 * 显示「不适用」—— 它不是未知，也不是否。
 *
 * ---------- 为什么单独成文件 ----------
 *
 * 纯函数、不碰 `document`、不 import `state.js`，所以 node 单测可以直接 import
 * 它，不需要 jsdom。渲染在 `ui/capability-setup.js` 与 `capability-view.js`。
 */

/** 缺证据时的统一文案。**不允许**用「否」「未安装」代替它。 */
export const TRI_UNKNOWN = '未知（无法确认）';

/** 第四种值：该字段对这类能力不适用（既不是未知，也不是否）。 */
export const NA = 'n/a';

/** 三值 / 四值 → 界面文案。这是全局唯一一处做这个翻译的地方。 */
export function triText(value, yes = '是', no = '否') {
  if (value === NA) return '不适用';
  if (value === true) return yes;
  if (value === false) return no;
  return TRI_UNKNOWN;
}

/* Capability 视图的过滤器。**与需求里点名的那几个词一一对应**，
 * 顺序固定：All 在最前，且是默认。 */
export const FILTERS = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
]);

/* 行类型 → 默认归属的过滤器。
 * 「known capability」进 Capabilities；pi 包里的 built-in 与用户装的 Extension
 * 同属 Extensions，但 origin 文案不同（built-in **不**伪装成普通 Extension）。 */
const KIND_FILTERS = Object.freeze({
  capability: ['all', 'capabilities'],
  'native-mcp': ['all', 'capabilities', 'mcp'],
  builtin: ['all', 'extensions'],
  extension: ['all', 'extensions'],
  skill: ['all', 'skills'],
  server: ['all', 'mcp'],
});
export const ORIGIN_LABEL = Object.freeze({
  extension: '第三方 Extension',
  native: 'pi 内置能力',
  builtin: 'pi 内置扩展',
  pi: 'pi 原生能力',
  registry: 'Extension Registry 只读发现',
});

/**
 * Registry 证据 → 统一状态。**四值**：true / false / null / 'n/a'。
 *
 * 语义与原 `webSetup` / `subagentSetup` / `memorySetup` / `browserSetup`
 * 逐字一致（那些函数现在都委托到这里），只是多了 `restartRequired` 与 `diagnostic`。
 *
 * 注意 `loaded` 保持「只有 true 或 null」：Registry 只在有证据时才写 false，
 * 所以这里同样不把「没证据」写成 false。
 *
 * @param registry   `/api/extensions` 的报告，可空
 * @param packageName 这个 feature 对应的 Extension 包名（`pi-web-access` 之类）
 */
export function registryEvidence(registry, packageName) {
  const known = Boolean(registry && registry.ok !== false && Array.isArray(registry.extensions));
  const items = known && typeof packageName === 'string'
    ? registry.extensions.filter((entry) => entry && entry.name === packageName)
    : [];
  const diagnostics = Array.isArray(registry?.diagnostics) ? registry.diagnostics : [];
  const some = (pick) => items.some((entry) => pick(entry));
  const all = (pick) => items.length > 0 && items.every((entry) => pick(entry));
  return {
    known,
    items,
    discovered: some((entry) => entry.state?.installed === true),
    installed: some((entry) => entry.state?.installed === true) ? true
      : known && !diagnostics.length ? false : null,
    // Registry 的 enabled 证据与「存在」是两件事。
    configured: some((entry) => entry.state?.enabled === true) ? true
      : all((entry) => entry.state?.enabled === false) ? false : null,
    loaded: some((entry) => entry.state?.loaded === true) ? true : null,
    // 配置改了但还没重启时，Registry 可以给出 restartRequired；没证据就是未知。
    restartRequired: some((entry) => entry.state?.restartRequired === true) ? true
      : all((entry) => entry.state?.restartRequired === false) ? false : null,
    diagnostic: registryDiagnostic(registry, items),
  };
}

function registryDiagnostic(registry, items) {
  const broken = items.find((entry) => entry.state?.error);
  if (broken) {
    const error = broken.state.error;
    return { phase: typeof error.phase === 'string' ? error.phase : 'load',
      message: typeof error.message === 'string' ? error.message : '该 Extension 报告了错误' };
  }
  if (registry && registry.ok === false) {
    return { phase: 'discovery', message: 'Extension 发现失败：安装与加载状态无法确认' };
  }
  return null;
}

/** `{toolName: boolean}` 观察快照 → 统一的 `{any, count, names}`。 */
export function observationFromMap(map) {
  const names = Object.entries(map || {})
    .filter(([, seen]) => seen === true)
    .map(([key]) => key)
    .sort();
  return { any: names.length > 0, count: names.length, names };
}

/** 运行观察 → 一行文案。**只描述这次 bridge run 真的见过什么**，不推断安装/加载。 */
export function observationText(observed) {
  if (observed === NA) return '不适用（不是工具型能力）';
  if (!observed || typeof observed !== 'object') return TRI_UNKNOWN;
  if (!observed.any) return '本次 Pi 运行尚未观察到调用';
  const names = Array.isArray(observed.names) ? observed.names.slice(0, 5) : [];
  const total = Number.isInteger(observed.count) ? observed.count : names.length;
  const suffix = total > 1 ? `（共 ${total} 个）` : '';
  return `本次 Pi 运行观察到调用：${names.join(' · ')}${suffix}`;
}

/**
 * 统一状态 → 结论行（圆点 + 文案）。顺序即优先级：
 * 原生 MCP 的原生状态排在「装没装」之前 —— 它不是 npm 包，没有「未安装」这一说。
 *
 * ⚠️ `nativeState` 的取值**只来自 P20.6 的原生状态机**（`server/mcp-native.js`），
 * 这里只把它翻成界面文案，不重新判断 active / replaced / disabled。
 */
export function statusOf(state) {
  const s = state && typeof state === 'object' ? state : {};
  let base;
  if (s.nativeState === 'active') base = { dot: 'on', key: 'loaded', label: '原生 MCP 生效中' };
  else if (s.nativeState === 'unsupported') base = { dot: 'dim', key: 'unsupported', label: '这个 pi 不带原生 MCP' };
  else if (s.nativeState === 'replaced') base = { dot: 'warn', key: 'replaced', label: '内置 MCP 被扩展接管' };
  else if (s.nativeState === 'disabled') base = { dot: 'off', key: 'disabled', label: '内置 MCP 被设置停用' };
  else if (s.installed === false) base = { dot: 'off', key: 'absent', label: '未安装' };
  else if (s.installed !== true) base = { dot: 'dim', key: 'unknown', label: `状态${TRI_UNKNOWN}` };
  else if (s.loaded === false) base = { dot: 'warn', key: 'not-loaded', label: '已安装，未加载' };
  else if (s.loaded === true) base = { dot: 'on', key: 'loaded', label: '已加载' };
  else base = { dot: 'warn', key: 'load-unknown', label: '已安装，加载状态未知' };
  if (s.restartRequired === true) return { ...base, label: `${base.label} · 需重启 Pi`, restartRequired: true };
  return base;
}

/** 概览计数。**replaced 计入未知** —— 原生被接管不等于 MCP 不可用，那是两件事。 */
export function catalogCounts(rows = []) {
  let available = 0;
  let unavailable = 0;
  let unknown = 0;
  for (const row of rows) {
    const key = row?.status?.key;
    if (key === 'loaded') available++;
    else if (key === 'absent' || key === 'not-loaded' || key === 'unsupported' || key === 'disabled') unavailable++;
    else unknown++;
  }
  return { total: rows.length, available, unavailable, unknown };
}

function searchTextOf(row) {
  const state = row.state || {};
  return [
    row.name,
    row.purpose,
    row.originLabel,
    row.packageName,
    row.status?.label,
    triText(state.installed, '已安装', '未安装'),
    triText(state.configured, '已启用', '已停用'),
    triText(state.loaded, '已加载', '未加载'),
    observationText(state.runtimeObserved),
    (row.notes || []).join(' '),
    (row.limits || []).join(' '),
  ]
    // 「未知（无法确认）」不参与搜索 —— 它不是状态，是「没有证据」；
    // 让它进索引的话搜「未知」会命中几乎每一行，反而找不到真正未知的那几条。
    .filter((part) => typeof part === 'string' && part && part !== TRI_UNKNOWN)
    .join(' ')
    .toLowerCase();
}

/** 一行补齐派生字段：filters / status / searchText。**不修改输入**。 */
export function normalizeRow(row) {
  const kind = row.kind || 'capability';
  const declared = Array.isArray(row.filters) && row.filters.length ? row.filters : KIND_FILTERS[kind] || ['all'];
  const filters = ['all', ...declared.filter((id) => id !== 'all')];
  const state = { ...(row.state || {}) };
  const originLabel = row.originLabel || ORIGIN_LABEL[row.origin] || '来源未知';
  /* 配置条目（MCP server）不是「装没装」的东西：它的结论是「生效与否」，
   * 由后端 P20.6 的 effective 给出。这类行自带结论，不走安装状态机。 */
  const status = row.statusOverride || statusOf(state);
  const normalized = { ...row, kind, filters, state, originLabel, status };
  normalized.searchText = searchTextOf(normalized);
  return normalized;
}

/**
 * Usage / Quota 的入口行。
 *
 * 它是**入口**，不是可安装的能力：所以 `installed` 是 `'n/a'`，界面不会编一个
 * 「未安装」出来。明细仍在侧栏「上下文」与 Composer 的上下文 Tip 里 ——
 * 这里不复制第二份数据。`onOpen` 由调用方注入（模型层不碰 DOM）。
 */
export function usageEntry() {
  return {
    id: 'usage',
    kind: 'capability',
    name: 'Usage / Quota（用量与额度）',
    purpose: '会话 token / 成本 / 上下文占用，以及 Provider 的远端配额。',
    origin: 'pi',
    packageName: null,
    installCommand: null,
    installNote: '数据来自 Pi RPC 的会话统计与 Provider 官方接口 —— 它不是 Extension，没有安装命令。',
    statusOverride: { dot: 'dim', key: 'unknown', label: '随会话提供（不是 Extension，没有安装状态）' },
    state: { installed: NA, configured: NA, loaded: NA, runtimeObserved: NA, restartRequired: NA, diagnostic: null },
    notes: [
      '本地用量来自 Pi 的真实 usage（session total / 当前 turn / context 占用 / cache）；远端配额按 Provider 官方 adapter 读取，带 TTL 缓存。',
      '单位未知时不标成美元：余额与额度的单位由 Provider 决定，缺失一律留空。',
    ],
    limits: ['这里只放入口：明细与远端配额在侧栏「上下文」与 Composer 的上下文 Tip 里，不在这里复制第二份数据。'],
    source: 'Pi RPC 会话统计 + GET /api/quota（Provider 官方接口）',
    openLabel: '打开上下文与额度',
  };
}

/**
 * Skills（pi 原生能力）→ 一行。
 *
 * **它不是 Extension**：没有安装、没有 npm 包、没有 qmd。所以 `installed` 只在
 * 「pi 真的应答了」时为真，其余保持未知 —— 不把「没探测」写成「没有」。
 * 具体的 Skill 清单、启停与正文仍归 Skills 标签页，这里只给能力级结论。
 */
export function skillsCapability(report) {
  const list = report && Array.isArray(report.skills) ? report.skills : null;
  const reachable = report?.piReachable === true ? true : report?.piReachable === false ? false : null;
  const counts = report?.counts || {};
  const loadedCount = list ? list.filter((skill) => skill.loaded === true).length : null;
  const untrusted = report?.trust && report.trust.requiresTrust && report.trust.trusted === false;
  const statusOverride = reachable === true
    ? { dot: 'on', key: 'loaded', label: 'pi 原生能力可用（Skills 随 Pi 提供，无需安装）' }
    : reachable === false
      ? { dot: 'warn', key: 'not-loaded', label: 'pi 未应答：加载状态无法确认' }
      : { dot: 'dim', key: 'unknown', label: `状态${TRI_UNKNOWN}` };
  return {
    id: 'skills',
    kind: 'skill',
    name: 'Skills（pi 原生）',
    purpose: '给模型阅读的指令包（Agent Skills 标准），按 pi 的发现规则从 4 个根目录与 settings 收集。',
    origin: 'pi',
    packageName: null,
    installCommand: null,
    installNote: 'Skills 是 pi 的原生能力，不是 Extension：没有安装命令，也没有 npm 包。所谓「装」就是把 SKILL.md 放到 pi 会扫的目录里。',
    statusOverride,
    state: {
      installed: reachable === true ? true : null,
      configured: list ? list.length > 0 : null,
      loaded: list ? (loadedCount > 0 ? true : list.length ? false : null) : null,
      runtimeObserved: NA,
      restartRequired: null,
      diagnostic: report && report.ok === false
        ? { phase: 'discovery', message: report.error || '读取 Skills 失败' }
        : null,
    },
    notes: [
      `本次发现：共 ${counts.total ?? (list ? list.length : TRI_UNKNOWN)} 个`
        + `（用户 ${counts.user ?? TRI_UNKNOWN} · 项目 ${counts.project ?? TRI_UNKNOWN}）`
        + `${loadedCount === null ? '' : ` · pi 证实已加载 ${loadedCount} 个`}`,
      '「磁盘上有」≠「pi 加载了」：pi 只在启动时读 settings.json，改完必须重启 pi。',
      untrusted
        ? '当前项目未被信任：pi 在非交互模式下不会加载项目级 Skill / Extension，所以项目里那些会显示成「未加载（项目未信任）」。这是 pi 的默认行为，不是配置丢了。'
        : '启停写的是 pi 的 settings.json；具体每一个 Skill 的状态、正文与开关在 Skills 标签页。',
    ],
    limits: [
      'Pi GUI 不安装 Skill、不建商店；查看正文交给系统编辑器，不内置文本编辑器。',
    ],
    source: 'GET /api/skills（按 pi 的发现规则只读扫描 + RPC get_commands 证实的加载证据）',
  };
}

/**
 * 把三条来源投影成一张表。
 *
 * @param registry    `/api/extensions` 报告（可空 → 相关行全部保持未知）
 * @param mcp         `/api/mcp` 报告（P20.5 built-in 事实）
 * @param mcpNative   `/api/mcp/servers` 摘要（P20.6 原生状态真值）
 * @param skills      `/api/skills` 报告（只用于能力级的 Skills 行）
 * @param features    各 feature 模块给出的 descriptor（Web / Subagents / Memory /
 *                    Browser / Approval / Native MCP）—— **顺序即展示顺序**
 */
export function buildCapabilityCatalog({ registry = null, mcp = null, mcpNative = null, skills = null, features = [] } = {}) {
  const rows = [];
  const diagnostics = [];
  for (const feature of features) {
    if (feature && typeof feature === 'object' && feature.id) rows.push(normalizeRow(feature));
  }
  if (skills) rows.push(normalizeRow(skillsCapability(skills)));

  /* pi 包里的 built-in 扩展（P20.5 事实）。**不伪装成普通 Extension**：
   * origin 不同、名字带 builtin: 前缀、并且没有 npm 安装命令。 */
  const builtins = mcp && mcp.builtins;
  if (builtins && builtins.known && Array.isArray(builtins.entries)) {
    for (const entry of builtins.entries) {
      if (!entry || typeof entry.id !== 'string') continue;
      rows.push(normalizeRow({
        id: `builtin:${entry.id}`,
        kind: 'builtin',
        name: `builtin:${entry.id}`,
        purpose: entry.replaceable
          ? 'pi 包自带的 built-in 扩展；第三方 Extension 注册同名能力时会被接管'
          : 'pi 包自带的 built-in 扩展',
        origin: 'builtin',
        packageName: null,
        installCommand: null,
        installNote: '编译在 pi 包里（dist/extensions/），不由 Extension Registry 的目录扫描发现，也没有 npm 安装命令。',
        state: { installed: true, configured: NA, loaded: NA, runtimeObserved: NA, restartRequired: NA, diagnostic: null },
        notes: [
          '「包里带了它」不等于「当前启用了它」：mcp / codemode / tool-search 标着 replaceable: true，第三方 Extension 可以接管。',
        ],
        limits: ['启用与接管与否只能看真实运行证据；这里不硬编码结论。'],
        source: 'GET /api/mcp → builtins（读 pi 包的 dist/extensions/index.js，只读文本、不执行）',
        evidence: entry.evidence || '',
      }));
    }
  } else if (mcp && mcp.builtins) {
    diagnostics.push({ phase: 'capability', message: '读不到这个 pi 包的 built-in 扩展清单 —— 按「未知」处理，不硬编码结论。' });
  }

  /* 通用 Extension Registry 的每一行 —— 包括**完全不认识的**那些。
   * unknown Extension 必须留在表里且可诊断，不能因为我们不认识它就消失。 */
  const extensions = registry && registry.ok !== false && Array.isArray(registry.extensions)
    ? registry.extensions
    : null;
  if (!extensions) {
    diagnostics.push({ phase: 'capability', message: 'Extension 发现不可用：Extension 行按「未知」显示，聊天不受影响。' });
  } else {
    for (const item of extensions) {
      const state = item.state || {};
      rows.push(normalizeRow({
        id: `extension:${item.id}`,
        kind: 'extension',
        name: item.displayName || item.name || '（未命名）',
        purpose: item.description || '（没有简介；Registry 只读目录项与限长元数据）',
        origin: 'registry',
        originLabel: `Extension Registry 只读发现 · ${item.source?.type === 'local' ? '本地' : item.source?.type || '未知来源'}`,
        packageName: item.name || null,
        installCommand: null,
        installNote: 'Pi GUI 不安装 Extension：这里只读发现已存在的资源。装什么请在 pi 那边决定。',
        state: {
          installed: state.installed ?? null,
          configured: state.enabled ?? null,
          loaded: state.loaded ?? null,
          runtimeObserved: null,
          restartRequired: state.restartRequired ?? null,
          diagnostic: state.error
            ? { phase: state.error.phase || 'load', message: state.error.message || '该 Extension 报告了错误' }
            : null,
        },
        notes: [
          `作用域：${item.scope === 'project' ? '项目' : item.scope === 'global' ? '用户' : '未知'}`
            + ` · 已确认能力：${(item.capabilities || []).length} 个`,
        ],
        limits: ['Pi RPC 未提供已注册工具列表；工具来源未知时，聊天时间线仍按原始名称显示。'],
        source: 'GET /api/extensions（只读发现；loaded 只在 Pi 给出证据时为真）',
      }));
    }
  }

  for (const diagnostic of Array.isArray(registry?.diagnostics) ? registry.diagnostics : []) {
    diagnostics.push({ phase: diagnostic.phase || 'config', message: diagnostic.message || '发现诊断' });
  }

  /* MCP server 明细（P20.6）。**这里不判断状态** —— enabled / exposure /
   * effective 全部来自后端已算好的结论；运行时状态只来自显式刷新的缓存。 */
  const servers = mcpNative && Array.isArray(mcpNative.servers) ? mcpNative.servers : null;
  if (servers) {
    for (const server of servers) {
      const effective = server.effective || null;
      const runtime = (mcpNative.runtime && Array.isArray(mcpNative.runtime.servers)
        ? mcpNative.runtime.servers : []).find((entry) => entry.name === server.name) || null;
      /* `effective` 是后端按 enabled / 覆盖 / 信任 / 原生状态算好的结论 —— 照搬。 */
      const statusOverride = effective
        ? (effective.active === true
          ? { dot: 'on', key: 'loaded', label: '生效中' }
          : { dot: 'warn', key: 'not-loaded', label: `未生效（${effective.reason || '原因未知'}）` })
        : { dot: 'dim', key: 'unknown', label: `生效状态${TRI_UNKNOWN}` };
      const notes = [
        `exposure：${server.exposure || TRI_UNKNOWN} · 传输：${server.transportType === 'http' ? '远端' : server.transportType === 'stdio' ? '本地命令' : TRI_UNKNOWN}`,
      ];
      if (runtime) {
        notes.push(`运行时状态：${runtime.state}${typeof runtime.toolCount === 'number' ? ` · ${runtime.toolCount} 个工具` : ''}（来自显式刷新的 pi mcp list --json）`);
      } else {
        notes.push('尚未获取运行时状态（在 MCP 标签页点「获取运行时状态」；未知 ≠ 没有）');
      }
      rows.push(normalizeRow({
        id: `mcp:${server.scope || 'unknown'}:${server.name}`,
        kind: 'server',
        name: `MCP · ${server.name}`,
        purpose: server.description || 'pi 原生 MCP server（配置来自 pi 自己的 mcp.json）',
        origin: 'pi',
        originLabel: `pi 原生 MCP · ${server.scope === 'project' ? '项目级' : server.scope === 'user' ? '用户级' : server.scope === 'extension' ? '扩展注册' : '作用域未知'}`,
        packageName: null,
        installCommand: null,
        installNote: 'MCP server 因人而异（本地命令 / 远端 URL），没有固定安装命令；配置走 pi 自己的 mcp.json 或页内受控动作。',
        statusOverride,
        state: {
          // server 是配置条目，不是「装没装」的东西 —— 这一格如实说「不适用」。
          installed: NA,
          configured: server.enabled ?? null,
          loaded: effective ? effective.active === true : null,
          // 运行观察指的是「这次 bridge run 真的调用过它的工具」。运行时连接状态
          // （pi mcp list）是另一件事，写在说明里，不混进这一格。
          runtimeObserved: null,
          restartRequired: null,
          diagnostic: runtime && runtime.error ? { phase: 'runtime', message: String(runtime.error).slice(0, 200) } : null,
        },
        notes,
        limits: ['启用 / 停用 / 重连 / 改 exposure 没有官方自动化接口 —— 请用 pi 的 /mcp 管理器（TUI）。这里不伪造这些开关。'],
        source: 'GET /api/mcp/servers（P20.6 原生摘要；运行时状态只在显式刷新后有值）',
        mcpServer: true,
      }));
    }
  }

  for (const message of Array.isArray(mcpNative?.configInvalid) ? mcpNative.configInvalid : []) {
    diagnostics.push({ phase: 'config', message });
  }

  return { ok: true, rows, counts: catalogCounts(rows), diagnostics };
}

/** 过滤器 + 搜索。搜索覆盖名称 / 用途 / 状态 / 说明。 */
export function filterRows(rows = [], filterId = 'all', query = '') {
  const id = FILTERS.some((filter) => filter.id === filterId) ? filterId : 'all';
  const q = String(query || '').trim().toLowerCase();
  return rows.filter((row) => {
    if (id !== 'all' && !(row.filters || []).includes(id)) return false;
    if (!q) return true;
    return String(row.searchText || '').includes(q) || String(row.status?.label || '').toLowerCase().includes(q);
  });
}

/**
 * 行 → 统一 setup 布局的视图模型（需求「三、统一 setup pattern」）。
 * 渲染器只做 DOM，不做判断：这里算不出来的东西，界面就不该显示。
 */
export function setupViewModel(row) {
  const state = row.state || {};
  const observed = state.runtimeObserved;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    purpose: row.purpose || '',
    status: row.status || statusOf(state),
    originLabel: row.originLabel,
    packageName: row.packageName || null,
    // 固定官方命令：只有第三方 Extension 才有；Native MCP / built-in 一律 null。
    installCommand: typeof row.installCommand === 'string' && row.installCommand ? row.installCommand : null,
    installNote: row.installNote || '',
    // 「安装 / 内置状态」——原生与内置能力在这一行说清它从哪来，而不是给一条 npm 命令。
    stateRows: [
      ['安装状态', triText(state.installed, '已安装', '未安装')],
      ['启用配置', triText(state.configured, '已启用', '已停用')],
      ['已加载', triText(state.loaded, '已确认加载', '未加载')],
      ['运行观察', observationText(observed)],
      ['需要重启', triText(state.restartRequired, '是', '否')],
      ['诊断', state.diagnostic ? String(state.diagnostic.message) : '无'],
    ],
    notes: Array.isArray(row.notes) ? row.notes.filter(Boolean) : [],
    limits: Array.isArray(row.limits) ? row.limits.filter(Boolean) : [],
    source: row.source || '',
    evidence: row.evidence || '',
    link: row.link || null,
    // 重启流程由 descriptor 给出确认文案；没有安装动作的能力给 null（不画假按钮）。
    restart: row.restart || null,
    copyLabel: row.copyLabel || '复制安装命令',
    // 只读入口（例如 Usage 打开上下文与额度 Tip）。handler 由调用方注入，
    // 这一层不发明动作、也不执行任何安装。
    onOpen: typeof row.onOpen === 'function' ? row.onOpen : null,
    openLabel: row.openLabel || null,
    // 第三方 Extension 的权限提示：与 Pi 进程同等权限，要用户自己判断信任。
    thirdParty: row.origin === 'extension' || row.origin === 'registry',
  };
}
