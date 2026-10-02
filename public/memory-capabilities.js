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
import { registryEvidence, observationFromMap } from './capability-model.js';

export const MEMORY_INSTALL_COMMAND = 'pi install npm:pi-memory';

/** 这个 feature 对应的 Extension 包名（setup metadata，用于磁盘只读发现）。 */
export const MEMORY_EXTENSION_NAME = 'pi-memory';

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
    /* bridge 生命周期一变，旧 run 的观察就没有意义了。maintenance（Pi 正在被
     * self-update 替换）同样是「那个 runtime 已经不在了」—— 只是它是计划内的。 */
    if (event?.type === 'bridge_status' && ['starting', 'restarting', 'exited', 'error', 'no-project', 'maintenance'].includes(event.state)) observed = {};
    if (/^tool_execution_(start|update|end)$/.test(event?.type || '') && event.bridgeRun === run && MEMORY_TOOLS.includes(event.toolName)) {
      observed[event.toolName] = true;
    }
  }
  return { snapshot, observe };
}

/** 当前 bridge run 的运行观察（统一形状）。 */
export function memoryObservationState(observation, generation, run) {
  return observationFromMap(observation.snapshot(generation, run));
}

/** Registry 证据 → 三值（true / false / null）。缺证据不写成 false。 */
export function memorySetup(registry) {
  const evidence = registryEvidence(registry, MEMORY_EXTENSION_NAME);
  return {
    installed: evidence.installed,
    configured: evidence.configured,
    discovered: evidence.discovered,
    loaded: evidence.loaded,
    restartRequired: evidence.restartRequired,
    diagnostic: evidence.diagnostic,
    automaticInstall: false,
  };
}

/** 统一 setup 布局用的 descriptor。 */
export function memoryCapability(registry, observed = null) {
  const state = { ...memorySetup(registry), runtimeObserved: observed };
  return {
    id: 'memory',
    kind: 'capability',
    name: 'Pi Memory（长期记忆）',
    purpose: '跨会话的长期记忆检索与写入，由第三方 Extension 提供工具。',
    origin: 'extension',
    packageName: MEMORY_EXTENSION_NAME,
    installCommand: MEMORY_INSTALL_COMMAND,
    /* 一键安装的 capability id（服务端固定 allowlist 的键）。 */
    installId: 'memory',
    installNote: '这是第三方 Extension。页内「安装」会调用当前 Pi 的官方安装命令（用户级，不加 -l）；也可以复制命令在终端自己执行。Pi GUI 不安装 qmd、不建索引、不读 Pi 的 memory 目录、不建立第二份数据库。',
    state,
    notes: [
      '长期记忆由 Pi Extension 提供并落在 Pi 自己的目录里；Pi GUI 不读取、不索引、不复制它。绝对路径与记忆全文不进入 Activity。',
      '这不是「会话搜索」：会话搜索在当前项目的历史会话里找对话，Memory 工具检索的是 Extension 的长期记忆。两者不共享索引，也不会互相写入。',
      'qmd 是 Extension 的可选依赖，Pi GUI 不安装、不配置、不检测系统包管理器；只有真实 tool result 报告 qmd 状态才展示。',
      '运行观察只说明「这次 bridge run 真的调用过它」，磁盘上有目录不构成已加载的证据。',
    ],
    limits: [
      '第三方 Extension 与 Pi 进程拥有同等系统权限，可读写文件、执行 shell 和访问网络；Memory 可能保存偏好、决策与项目事实。只安装可信代码。',
      '在终端安装后重启 Pi，再刷新本页。当前没有 Memory Browser、编辑器或恢复入口：查看与恢复仍由 Pi / 模型通过 Extension 的工具完成。',
    ],
    source: 'GET /api/extensions（Extension Registry 只读发现）+ 本次 bridge run 的 tool_execution_* 事件',
    link: { url: 'https://github.com/jayzeng/pi-memory#readme', hostname: 'github.com', title: '查看 Extension 说明' },
    restart: { message: '请先在终端完成官方安装。重启会结束当前 Pi 运行并重新加载 Extension；Pi GUI 不安装 qmd，也不改动 Extension 配置。' },
  };
}
