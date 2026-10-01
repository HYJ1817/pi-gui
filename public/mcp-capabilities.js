/* MCP 的能力证据与运行观察（P20.6）。
 *
 * 四个状态分开表达，谁都不要替谁说话（与 Web / Memory / Browser 同一套纪律）：
 *   nativeActive —— /api/mcp/servers 的 native.state（active / replaced /
 *                   disabled / unsupported / unknown 三值外的值）
 *   configured   —— 配置里有没有 server 条目（enabled 与 effective 分开，不混）
 *   runtimeObserved —— 当前 workspace generation / bridge run 内**真实收到过**
 *                      `mcp__*` 或资源工具的 tool_execution_* 事件
 *
 * 运行观察只记「观察到几个 / 最近是哪几个」。**观察到的 server 名不构成
 * 「这个 server 已配置」的证据** —— 同名工具可能来自替代扩展，RPC 也没有
 * 权威的已注册工具清单（33 条命令里没有）。
 *
 * 没有安装动作：MCP server 因人而异（stdio 命令 / 远端 URL），没有一条固定
 * 安装命令；配置走 `pi mcp add`（页内受控动作）或直接编辑 mcp.json。
 * 本模块不含任何安装、包管理动作。 */

import { MCP_RESOURCE_TOOLS, parseMcpToolName } from './mcp-activity.js';
import { NA, TRI_UNKNOWN } from './capability-model.js';

const RECENT_MAX = 5;

/** 共享入口守卫：切换工作区期间的旧事件不能进入新工作区。 */
export function acceptMcpEvent(event, scope) {
  if (!/^tool_execution_(start|update|end)$/.test(event?.type || '')) return true;
  return !scope.switching && (!Number.isInteger(event.bridgeRun) || event.bridgeRun === scope.bridgeRun);
}

function observedKey(name) {
  if (typeof name !== 'string' || !name) return null;
  if (MCP_RESOURCE_TOOLS.includes(name)) return name;
  const p = parseMcpToolName(name);
  // 按 server 聚合：同一 server 的几十个 tool 不把观察撑爆。
  return p ? 'mcp__' + p.server : null;
}

export function createMcpObservation() {
  let key = '';
  let observed = {};
  let recent = [];
  function reset() { observed = {}; recent = []; }
  function snapshot(generation, run) {
    const next = `${generation}/${run}`;
    if (next !== key) { key = next; reset(); }
    const names = Object.keys(observed);
    return { any: names.length > 0, count: names.length, names: recent.slice() };
  }
  function observe(event, generation, run) {
    snapshot(generation, run);
    /* bridge 生命周期一变，旧 run 的观察就没有意义了。 */
    if (event?.type === 'bridge_status' && ['starting', 'restarting', 'exited', 'error', 'no-project'].includes(event.state)) reset();
    if (!/^tool_execution_(start|update|end)$/.test(event?.type || '') || event.bridgeRun !== run) return;
    const k = observedKey(event.toolName);
    if (!k) return;
    if (observed[k] !== true) recent = [k, ...recent.filter((n) => n !== k)].slice(0, RECENT_MAX);
    observed[k] = true;
  }
  return { snapshot, observe };
}

/** 原生摘要 → 三值（true / false / null）。缺证据不写成 false。 */
export function mcpSetup(native) {
  if (!native || native.fresh !== true) return { nativeActive: null, configured: null };
  const st = native.native && native.native.state;
  return {
    nativeActive: st === 'active' ? true : st === 'replaced' || st === 'disabled' || st === 'unsupported' ? false : null,
    nativeState: typeof st === 'string' ? st : null,
    configured: Array.isArray(native.servers) && native.servers.length ? true
      : Array.isArray(native.servers) ? false : null,
    serverCount: Array.isArray(native.servers) ? native.servers.length : null,
    automaticInstall: false,
  };
}

/** P20.6 原生状态词汇表。**只搬运，不重新判断** —— 判定在 server/mcp-native.js。 */
export const MCP_NATIVE_LABEL = Object.freeze({
  active: '生效中（builtin:mcp 在包里、未被禁用、未被接管）',
  replaced: '被扩展接管（扩展注册了 /mcp，以内置能力为证）',
  disabled: '被 settings 停用（extensions 里关掉了 builtin:mcp）',
  unsupported: '这个 pi 包里没有 builtin:mcp',
  unknown: '证据不足，不断言',
});

/** Native MCP 的 setup 说明。**它没有 npm 安装命令** —— 这是需求里点名的一条。 */
export const MCP_INSTALL_NOTE = 'Native MCP 来自 Pi 的 built-in capability（编译在 pi 包里的 builtin:mcp，或 ExtensionAPI 的 registerMcpServer）。它不是 npm 包，没有安装命令，也不由 Extension Registry 的目录扫描发现。';

/**
 * Native MCP → 统一 setup 布局用的 descriptor。
 *
 * `nativeState` **原样**取自 P20.6 的原生状态机；本函数只做两件事：
 * 把三份已算好的证据合到一行，并保留原始词汇供界面显示。
 *
 * @param report   `/api/mcp` 报告（P20.5：这个 pi 带不带 MCP 能力）
 * @param native   `/api/mcp/servers` 摘要（P20.6：原生状态 + server 条目）
 * @param observed 当前 bridge run 的 `mcp__*` / 资源工具观察（统一形状或 null）
 */
export function mcpCapability(report, native, observed = null) {
  const fresh = Boolean(native && native.fresh === true);
  const nativeState = fresh && native.native && typeof native.native.state === 'string'
    ? native.native.state : null;
  const setup = fresh ? mcpSetup(native) : { configured: null, serverCount: null };
  const supported = report && typeof report.supported === 'boolean' ? report.supported : null;
  return {
    id: 'mcp',
    kind: 'native-mcp',
    name: 'Native MCP（pi 内置）',
    purpose: 'pi 原生 MCP 集成：把外部 MCP server 的工具注册进 Pi，配置走 pi 自己的 mcp.json。',
    origin: 'native',
    packageName: null,
    // 需求点名：Native MCP **不显示** npm 安装命令。
    installCommand: null,
    installNote: MCP_INSTALL_NOTE,
    state: {
      // server 不是「装没装」的东西；原生能力也没有 npm 安装概念。
      installed: NA,
      configured: setup.configured,
      loaded: nativeState === 'active' ? true
        : ['replaced', 'disabled', 'unsupported'].includes(nativeState) ? false : null,
      nativeState,
      runtimeObserved: observed,
      restartRequired: null,
      diagnostic: native && native.ok === false
        ? { phase: 'runtime', message: native.error || '读不到原生 MCP 摘要' }
        : null,
    },
    statusOverride: statusFromNative(nativeState),
    notes: [
      `pi 能力检测：${supported === true ? '这个 pi 带 MCP 能力'
        : supported === false ? '这个 pi 不带原生 MCP'
          : '无法确定（读不到 pi 包时不猜成 false）'}（来自 P20.5 的 built-in 清单与 ExtensionAPI 探测）`,
      `原生状态：${nativeState ? (MCP_NATIVE_LABEL[nativeState] || nativeState) : '尚未取到（未打开过 MCP 页时按未知处理）'}`,
      `配置里 ${setup.serverCount === null ? 'server 条目数未知' : `${setup.serverCount} 个 server 条目`}；明细见下面的 server 行与 MCP 标签页。`,
      '运行观察只说明「这次 bridge run 真的调用过 MCP 工具」，不构成「某个 server 已配置」的证据 —— 同名工具可能来自替代扩展，RPC 也没有权威的已注册工具清单。',
    ],
    limits: [
      'pi mcp list --json 看不见 extension 注册的 server（shell 命令不加载 extensions）：这类 server 属于 unknown / 不可枚举，界面不伪造它们。',
      '启用 / 停用 / 重连 / 改 exposure 没有官方自动化接口 —— 请用 pi 的 /mcp 管理器（TUI）。这里不伪造这些开关。',
      'Pi GUI 的 MCP 接口不接收任何凭据值；OAuth token 全程由 pi 自己管理。',
    ],
    source: 'GET /api/mcp（P20.5 built-in 事实）+ GET /api/mcp/servers（P20.6 原生状态机，只搬运不重判）',
    mcp: true,
  };
}

/** P20.6 原生状态 → 结论行。与 `capability-model` 的 `statusOf` 用的是同一套词汇。 */
function statusFromNative(nativeState) {
  if (nativeState === 'active') return { dot: 'on', key: 'loaded', label: '原生 MCP 生效中' };
  if (nativeState === 'unsupported') return { dot: 'dim', key: 'unsupported', label: '这个 pi 不带原生 MCP' };
  if (nativeState === 'replaced') return { dot: 'warn', key: 'replaced', label: '内置 MCP 被扩展接管' };
  if (nativeState === 'disabled') return { dot: 'off', key: 'disabled', label: '内置 MCP 被设置停用' };
  return { dot: 'dim', key: 'unknown', label: `原生状态${TRI_UNKNOWN}` };
}
