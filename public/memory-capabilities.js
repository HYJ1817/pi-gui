/* Memory 的能力证据与运行观察。
 *
 * 四个状态分开表达，谁都不要替谁说话：
 *   installed   —— Extension Registry 在磁盘上发现了 pi-memory
 *   configured  —— Registry 的 enabled 证据（存在 ≠ 已启用）
 *   loaded      —— Registry 的 loaded 证据（无证据就是 unknown）
 *   runtimeObserved —— 当前 workspace generation / bridge run 内**真实收到过**
 *                      memory 工具的 tool_execution_* 事件
 *
 * 「~/.pi/agent/memory 目录存在」不构成任何一条证据：Pi GUI 不读那个目录，
 * 也不因为磁盘上有文件就推断 Extension 已加载。restart / 切项目 / 退出 /
 * 错误 / 无项目一律清空运行观察。
 *
 * 安装仍然由用户在终端执行固定命令；本模块不含任何安装、qmd 检测或包管理动作。 */

import { MEMORY_TOOLS } from './memory-activity.js';

export const MEMORY_INSTALL_COMMAND = 'pi install npm:pi-memory';

/** 共享入口守卫：切换工作区期间的旧事件不能进入新工作区。 */
export function acceptMemoryEvent(event, scope) {
  if (!/^tool_execution_(start|update|end)$/.test(event?.type || '')) return true;
  return !scope.switching && (!Number.isInteger(event.bridgeRun) || event.bridgeRun === scope.bridgeRun);
}

export function createMemoryObservation() {
  let key = '';
  let observed = {};
  function snapshot(generation, run) {
    const next = `${generation}/${run}`;
    if (next !== key) { key = next; observed = {}; }
    return Object.fromEntries(MEMORY_TOOLS.map(name => [name, observed[name] === true]));
  }
  function observe(event, generation, run) {
    snapshot(generation, run);
    /* bridge 生命周期一变，旧 run 的观察就没有意义了。 */
    if (event?.type === 'bridge_status' && ['starting', 'restarting', 'exited', 'error', 'no-project'].includes(event.state)) observed = {};
    if (/^tool_execution_(start|update|end)$/.test(event?.type || '') && event.bridgeRun === run && MEMORY_TOOLS.includes(event.toolName)) {
      observed[event.toolName] = true;
    }
  }
  return { snapshot, observe };
}

/** Registry 证据 → 三值（true / false / null）。缺证据不写成 false。 */
export function memorySetup(registry) {
  const items = (registry?.extensions || []).filter(e => e.name === 'pi-memory');
  const known = registry && registry.ok !== false && Array.isArray(registry.extensions);
  return {
    installed: items.some(e => e.state?.installed === true) ? true : known && !registry.diagnostics?.length ? false : null,
    configured: items.some(e => e.state?.enabled === true) ? true : items.length && items.every(e => e.state?.enabled === false) ? false : null,
    loaded: items.some(e => e.state?.loaded === true) ? true : null,
    automaticInstall: false,
  };
}
