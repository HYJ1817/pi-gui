/* Browser 的能力证据与运行观察。
 *
 * 四个状态分开表达，谁都不要替谁说话（与 P16/P18 同一套纪律）：
 *   installed   —— Extension Registry 在磁盘上发现了 pi-browser-harness
 *   configured  —— Registry 的 enabled 证据（存在 ≠ 已启用）
 *   loaded      —— Registry 的 loaded 证据（无证据就是 unknown）
 *   runtimeObserved —— 当前 workspace generation / bridge run 内**真实收到过**
 *                      browser_* 工具的 tool_execution_* 事件
 *
 * 40 个工具逐个列出来没有意义（Extensions 页会被撑爆），所以运行观察只记
 * 「观察到几个 / 最近是哪几个」。**观察到的工具名不构成「这个包已加载」的证据** ——
 * 同名工具可能来自别的 Extension，RPC 也没有权威的已注册工具清单。
 *
 * 安装仍然由用户在终端执行固定命令；本模块不含任何安装、Chrome 启动、
 * 驱动下载或包管理动作。 */

import { BROWSER_TOOLS } from './browser-activity.js';

export const BROWSER_INSTALL_COMMAND = 'pi install npm:pi-browser-harness';

/** 默认兼容的 Extension 包名。仅用于「磁盘上有没有它」这一条证据。 */
export const BROWSER_EXTENSION_NAME = 'pi-browser-harness';

const RECENT_MAX = 3;

/** 共享入口守卫：切换工作区期间的旧事件不能进入新工作区。 */
export function acceptBrowserEvent(event, scope) {
  if (!/^tool_execution_(start|update|end)$/.test(event?.type || '')) return true;
  return !scope.switching && (!Number.isInteger(event.bridgeRun) || event.bridgeRun === scope.bridgeRun);
}

export function createBrowserObservation() {
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
    const name = event.toolName;
    if (typeof name !== 'string' || !BROWSER_TOOLS.has(name)) return;
    if (observed[name] !== true) recent = [name, ...recent.filter((n) => n !== name)].slice(0, RECENT_MAX);
    observed[name] = true;
  }
  return { snapshot, observe };
}

/** Registry 证据 → 三值（true / false / null）。缺证据不写成 false。 */
export function browserSetup(registry) {
  const items = (registry?.extensions || []).filter((e) => e.name === BROWSER_EXTENSION_NAME);
  const known = registry && registry.ok !== false && Array.isArray(registry.extensions);
  return {
    installed: items.some((e) => e.state?.installed === true) ? true : known && !registry.diagnostics?.length ? false : null,
    // Registry 的 enabled 证据与「存在」是两件事。
    configured: items.some((e) => e.state?.enabled === true) ? true : items.length && items.every((e) => e.state?.enabled === false) ? false : null,
    discovered: items.some((e) => e.state?.installed === true),
    loaded: items.some((e) => e.state?.loaded === true) ? true : null,
    automaticInstall: false,
  };
}
