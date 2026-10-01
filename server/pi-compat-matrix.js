/* P23 兼容矩阵：**小型、明确、可核对**的 metadata。
 *
 * ---------- 为什么要有这个文件 ----------
 *
 * P20.5 把「文档里写着 0.87.0，机器上跑着 0.99.1」那次事故拆成了四件事
 * （历史基线 / 当前基线 / 运行中版本 / 未知能力）。但「当前基线」当时只活在
 * 文档与注释里 —— 升级 pi 之后没有人能一眼回答：
 *
 *   - 我们现在**声称**验证过哪些 pi 版本？
 *   - 这台机器上跑的版本在不在那张表里？
 *   - 关键 Extension 的版本与我们对齐的那份 release 是否一致？
 *
 * 所以这里放一张**刻意很小**的表：只写真的逐项核对过的版本，每条都带核对日期
 * 与范围说明。**它不是版本支持列表，更不是 capability 判据** ——
 * 能力判定一律走 `server/pi-probes.js` 的 probe 或真实事件，
 * 版本号只用来回答「这个版本我们核过没有」。
 *
 * ---------- 纪律 ----------
 *
 * - **不联网。** 这里没有任何 URL、没有 release 查询；写入的值来自人工核对
 *   （npm 发布 tarball / GitHub tag，见 docs/pi-compatibility.md）。
 * - **不猜。** 没核对过的版本就是 `unverified` —— `relative`（比基线新/旧）
 *   只是给升级者的一句提示，**明确标注为不作判据**。
 * - **不放路径、不放凭据、不放 payload。** 这个模块的输出会原样进 Diagnostics。
 * - **不做庞大版本表。** 表越大越容易变成「维护两个真相」；这里只保留
 *   「最后一个历史基线 + 当前基线」这种量级。
 */

/** 语义化版本比较用的解析（只认三段数字 + 可选 prerelease/build）。 */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * 数字三段比较。**只用于「比基线新/旧」这一句提示**，不参与任何能力判定。
 * @returns {-1|0|1|null} null = 有一边不是版本号（不比较，不猜）
 */
export function compareVersions(a, b) {
  const ma = typeof a === 'string' ? VERSION_RE.exec(a.trim()) : null;
  const mb = typeof b === 'string' ? VERSION_RE.exec(b.trim()) : null;
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const x = Number(ma[i]);
    const y = Number(mb[i]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/* ---------- 已验证的 Pi 版本 ----------
 *
 * `scope: 'historical'` = 当时的验收对象（今天不该再拿它当「pi 的现状」）；
 * `scope: 'current'`    = 当前对照物。
 *
 * ⚠️ 加一条进来的前提是**真的逐项核对过**（RPC 命令集 / 事件 / 扩展 API / built-ins），
 * 而不是「CI 绿了」。CI 只证明「给定这些 fixture，我们的判定对不对」。
 */
export const PI_BASELINES = Object.freeze([
  Object.freeze({
    version: '0.87.0',
    verifiedAt: '2026-09-30',
    scope: 'historical',
    note: 'P15–P19 的验收对象。RPC 33 条命令、9 个 extension_ui_request 方法、built-in 只有 llama.cpp（hidden）。',
  }),
  Object.freeze({
    version: '0.99.1',
    verifiedAt: '2026-10-01',
    scope: 'historical',
    note: 'P20.5 迁移时的对照物。新增 codemode / tool-search / mcp 三个 built-in；RPC 面与 0.87.0 硬一致。',
  }),
  Object.freeze({
    version: '0.99.2',
    verifiedAt: '2026-10-01',
    scope: 'current',
    note: 'P20.6-Fix 与本轮（P22/P23）的对照物。自带 builtin:mcp；MCP 配置层词汇表变化（见 KNOWN_DIFFERENCES）。',
  }),
]);

/* ---------- 关键 Extension 的已验证 release ----------
 *
 * 「关键」= Pi GUI 有专门语义适配器或 setup 文案的包。
 * 版本值来自公开发布包的核对（见各 feature 文档的「核对的公开契约」一节）。
 * `contract` 写的是**我们依赖它什么** —— 升级时要照着这句去 diff。
 */
export const EXTENSION_BASELINES = Object.freeze([
  Object.freeze({
    name: 'pi-web-access',
    version: '0.33.0',
    verifiedAt: '2026-09-30',
    contract: '工具名 web_search / fetch_content / get_search_content；结构化 details（urls / sources / curatedQueries / totalResults / title）。',
  }),
  Object.freeze({
    name: 'pi-subagents',
    version: '0.73.1',
    verifiedAt: '2026-09-30',
    contract: 'parent-side 工具名 subagent / subagents_enable / bg_wait / subagent_supervisor；child 结果落在 details.results[]。',
  }),
  Object.freeze({
    name: 'pi-memory',
    version: '0.4.2',
    verifiedAt: '2026-09-30',
    contract: 'memory_write / memory_read / memory_search / memory_forget / memory_restore / memory_status / scratchpad；details 只有 mode / query / count / needsEmbed / snapshotMode。',
  }),
  Object.freeze({
    name: 'pi-browser-harness',
    version: '0.11.0',
    verifiedAt: '2026-10-01',
    contract: '40 个 browser_* 工具名；成功证据只认 details.ok === true；失败细节 details.kind 是闭集；截图落本机文件、不在 result 里带 image。',
  }),
]);

/* ---------- Native MCP 契约（P20.6 核对过的那份） ----------
 *
 * 这张表**不是**新的事实源：它是 `server/mcp-native.js` 里那些 allowlist 的
 * 「人类可读副本」，用于升级时 diff。真正的判定仍在 mcp-native。
 */
export const NATIVE_MCP_CONTRACT = Object.freeze({
  source: 'pi 包的 dist/extensions/index.js + dist/core/extensions/types.d.ts + dist/extensions/mcp/*',
  builtinId: 'mcp',
  replaceable: true,
  /** `list()` 给 `enabled:false` 条目合成的那个值由 GUI 侧补，不在上游闭集里。 */
  serverStates: Object.freeze(['connecting', 'connected', 'disconnected', 'needs-auth', 'failed', 'closed']),
  /** 0.99.2 起 `codemode-deferred` 降为输入别名，规范值只有这四个。 */
  exposures: Object.freeze(['codemode', 'deferred', 'direct', 'hidden']),
  cliSubcommands: Object.freeze(['add', 'remove', 'list', 'login', 'logout']),
  toolNamePattern: 'mcp__<server>__<tool>',
  note: 'enable / disable / reconnect 没有官方 shell 接口；RPC 也没有 MCP 管理命令。GUI 只代理官方 CLI。',
});

/* ---------- 已知差异：**我们主动记下来的上游行为差异** ----------
 *
 * 每条都要写清「影响哪一层」与「我们怎么处理」。升级时照这张表逐条复核。
 * 只放**影响 Pi GUI 行为**的差异，不抄 changelog。
 */
export const KNOWN_DIFFERENCES = Object.freeze([
  Object.freeze({
    id: 'approval-doc-wording',
    between: '0.87.0 / 0.99.1 → 0.99.2',
    affects: 'P19 Approval 能力报告（`/api/approvals/capability` 的 toolCallHook）',
    handling: 'probe 同时接受两版措辞（「Can block」/「before the tool executes」与「can mutate input or block execution」/`block: true` 示例）。**P23 的 live probe 在本机 0.99.2 上实测发现**：只认旧措辞时，类型里明明有 `block?: boolean`，报告却说「没有阻断契约」。',
    probe: 'approval-hook',
  }),
  Object.freeze({
    id: 'dialog-doc-moved',
    between: '0.87.0 / 0.99.1 → 0.99.2',
    affects: 'P19 Approval 能力报告（uiPromptDialog）与 P23 的 extension-ui probe',
    handling: '对话框阻塞契约从 `docs/rpc.md` 搬到了 `docs/rpc-extension-ui.md`；probe 两处都读，证据里带上真正命中的文件。同样由 P23 的 live probe 实测发现（否则报告会把「阻塞等待应答」说成不支持）。',
    probe: 'extension-ui',
  }),
  Object.freeze({
    id: 'iserror-propagation',
    between: '0.87.0 → 0.99.1',
    affects: 'P18 Pi Memory / P20 Browser 的成功证据',
    handling: 'GUI 只认结构化 details（P18-Fix / P20 同一条规则），所以**不需要改代码**；但「Extension 的 isError 到不了 GUI」这句话在 0.99.1 上已不成立。',
    probe: 'approval-hook',
  }),
  Object.freeze({
    id: 'builtin-mcp-added',
    between: '0.87.0 → 0.99.1',
    affects: 'MCP 能力报告 / Capability 视图',
    handling: '能力判定改成读本机 pi 包的 built-in 清单（P20.5）；不按版本号下结论。',
    probe: 'builtin-mcp',
  }),
  Object.freeze({
    id: 'mcp-exposure-alias',
    between: '0.99.1 → 0.99.2',
    affects: 'MCP server 的 exposure 展示',
    handling: '两版都认，一律归一成 codemode。',
    probe: 'mcp-runtime-states',
  }),
  Object.freeze({
    id: 'mcp-tool-name-charset',
    between: '0.99.1 → 0.99.2',
    affects: 'MCP 工具调用的 server/tool 解析',
    handling: '解析接受两版并集（`-` 与 `_` 都认），不做单版本正则。',
    probe: 'mcp-runtime-states',
  }),
  Object.freeze({
    id: 'mcp-list-json-extra-fields',
    between: '0.99.1 → 0.99.2',
    affects: 'MCP 运行时状态投影',
    handling: '逐项 allowlist：新字段默认丢弃；resources / resourceTemplates 只在真有值时显示。',
    probe: 'mcp-cli-resources',
  }),
]);

/** 「当前基线」= scope 为 current 的那条；没有则取数字最大的那条。 */
export function currentBaseline() {
  const explicit = PI_BASELINES.find((b) => b.scope === 'current');
  if (explicit) return explicit;
  return newestBaseline();
}

function newestBaseline() {
  return PI_BASELINES.reduce((best, item) => {
    if (!best) return item;
    const cmp = compareVersions(item.version, best.version);
    return cmp === 1 ? item : best;
  }, null);
}

/** 相对基线的方向。**只作提示**，不作判据（fork / 自定义实现可能版本号完全不同）。 */
function relativeTo(value, baseline) {
  if (!baseline) return 'unknown';
  const cmp = compareVersions(value, baseline.version);
  if (cmp === null) return 'unknown';
  if (cmp === 0) return 'same';
  return cmp > 0 ? 'newer' : 'older';
}

/**
 * 运行中的 pi 版本 vs 兼容矩阵。
 *
 * @returns {{
 *   status: 'verified'|'unverified'|'unknown',
 *   verifiedAgainst: {version:string, verifiedAt:string, scope:string}|null,
 *   relative: 'same'|'newer'|'older'|'unknown',
 * }}
 *   `unknown` = 版本本身没读到（不是「未验证」——那是两件事）。
 */
export function lookupPiVersion(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { status: 'unknown', verifiedAgainst: null, relative: 'unknown' };
  const hit = PI_BASELINES.find((b) => b.version === text) || null;
  if (hit) {
    return {
      status: 'verified',
      verifiedAgainst: { version: hit.version, verifiedAt: hit.verifiedAt, scope: hit.scope },
      relative: 'same',
    };
  }
  return { status: 'unverified', verifiedAgainst: null, relative: relativeTo(text, newestBaseline()) };
}

/**
 * Extension 版本 vs 兼容矩阵。
 *
 * 名字按包名精确匹配（`pi-memory`）；拿不到版本的（Registry 只读 package.json，
 * 版本可能为 null）回 `unknown` —— 不把「没读到」说成「版本不对」。
 */
export function lookupExtension(name, value) {
  const pkg = typeof name === 'string' ? name.trim() : '';
  const ver = typeof value === 'string' ? value.trim() : '';
  const baseline = EXTENSION_BASELINES.find((b) => b.name === pkg) || null;
  if (!baseline) return { status: 'unlisted', baseline: null, relative: 'unknown' };
  if (!ver) return { status: 'unknown', baseline, relative: 'unknown' };
  if (ver === baseline.version) return { status: 'verified', baseline, relative: 'same' };
  return { status: 'unverified', baseline, relative: relativeTo(ver, baseline.version) };
}

/**
 * 给 Diagnostics 的脱敏摘要：**只有版本号、日期与范围**。
 * 没有路径、没有 URL、没有包内容。
 */
export function matrixSummary() {
  return {
    piBaselines: PI_BASELINES.map((b) => ({ version: b.version, verifiedAt: b.verifiedAt, scope: b.scope })),
    currentBaseline: (() => {
      const cur = currentBaseline();
      return cur ? cur.version : null;
    })(),
    extensionBaselines: EXTENSION_BASELINES.map((b) => ({ name: b.name, version: b.version, verifiedAt: b.verifiedAt })),
    nativeMcp: {
      builtinId: NATIVE_MCP_CONTRACT.builtinId,
      replaceable: NATIVE_MCP_CONTRACT.replaceable,
      serverStates: [...NATIVE_MCP_CONTRACT.serverStates],
      exposures: [...NATIVE_MCP_CONTRACT.exposures],
      cliSubcommands: [...NATIVE_MCP_CONTRACT.cliSubcommands],
    },
    knownDifferences: KNOWN_DIFFERENCES.map((d) => ({ id: d.id, between: d.between, affects: d.affects })),
  };
}

/** 给「我声称验证过什么」的一句话（诊断摘要与文档共用同一份措辞来源）。 */
export function baselineSentence() {
  const cur = currentBaseline();
  if (!cur) return '尚未登记任何已验证的 Pi 版本';
  return `当前验证基线 Pi ${cur.version}（核对于 ${cur.verifiedAt}）`;
}
