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
