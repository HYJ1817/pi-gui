import { SUBAGENT_TOOLS } from './subagent-activity.js';
import { registryEvidence, observationFromMap } from './capability-model.js';

export const SUBAGENT_INSTALL_COMMAND = 'pi install npm:pi-subagents';

/** 这个 feature 对应的 Extension 包名（setup metadata，用于磁盘只读发现）。 */
export const SUBAGENT_EXTENSION_NAME = 'pi-subagents';

/** Shared entry guard: old tool events cannot enter a newly activating workspace. */
export function acceptSubagentEvent(event, scope) {
  if (!/^tool_execution_(start|update|end)$/.test(event?.type || '')) return true;
  return !scope.switching && (!Number.isInteger(event.bridgeRun) || event.bridgeRun === scope.bridgeRun);
}

export function createSubagentObservation() {
  let key = '', observed = {};
  function snapshot(generation, run) {
    const next = `${generation}/${run}`;
    if (next !== key) { key = next; observed = {}; }
    return Object.fromEntries(SUBAGENT_TOOLS.map(name => [name, observed[name] === true]));
  }
  function observe(event, generation, run) {
    snapshot(generation, run);
    /* bridge 生命周期一变，旧 run 的观察就没有意义了。maintenance（Pi 正在被
     * self-update 替换）同样是「那个 runtime 已经不在了」—— 只是它是计划内的。 */
    if (event?.type === 'bridge_status' && ['starting', 'restarting', 'exited', 'error', 'no-project', 'maintenance'].includes(event.state)) observed = {};
    if (/^tool_execution_(start|update|end)$/.test(event?.type || '') && event.bridgeRun === run && SUBAGENT_TOOLS.includes(event.toolName)) observed[event.toolName] = true;
  }
  return { snapshot, observe };
}

/** 当前 bridge run 的运行观察（统一形状）。 */
export function subagentObservationState(observation, generation, run) {
  return observationFromMap(observation.snapshot(generation, run));
}

/** Registry 证据 → 统一三值状态（唯一实现在 capability-model）。 */
export function subagentSetup(registry) {
  const evidence = registryEvidence(registry, SUBAGENT_EXTENSION_NAME);
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
export function subagentCapability(registry, observed = null) {
  const state = { ...subagentSetup(registry), runtimeObserved: observed };
  return {
    id: 'subagents',
    kind: 'capability',
    name: 'Subagents',
    purpose: '在当前对话内把工作委派给子 Agent：subagent / subagents_enable / bg_wait / subagent_supervisor。',
    origin: 'extension',
    packageName: SUBAGENT_EXTENSION_NAME,
    installCommand: SUBAGENT_INSTALL_COMMAND,
    /* 一键安装的 capability id（服务端固定 allowlist 的键）。 */
    installId: 'subagents',
    installNote: '这是第三方 Extension。页内「安装」会调用当前 Pi 的官方安装命令（用户级，不加 -l）；也可以复制命令在终端自己执行。Pi GUI 不扫描 Agent 定义、不控制子进程。',
    state,
    notes: [
      '仅观察到 subagents_enable 时不代表安装失败；它只激活后续模型请求的工具，不启动 child。其他 Extension 也可提供同名工具。',
      'Pi 0.86.1+ fresh unrestricted parent 初始可用 subagents_enable、bg_wait、subagent_supervisor；subagent 已注册但初始 inactive，在启用后的后续模型请求中激活。仅观察到 Supervisor 而未观察到 subagent 是正常的。',
      '运行观察只说明「这次 bridge run 真的调用过它」，不构成「这个包已加载」的证据。',
    ],
    limits: [
      '子会话隔离不是系统沙箱。第三方 Extension 与 Pi 拥有同等权限，可读写文件、运行 shell 和访问网络；后台任务可独立运行。只安装可信代码。',
      '在终端安装后重启 Pi，再刷新本页。Agent 定义、模型与凭据由 Extension / Pi 管理。GUI 不安装、不扫描 Agent、不控制子进程。',
    ],
    source: 'GET /api/extensions（Extension Registry 只读发现）+ 本次 bridge run 的 tool_execution_* 事件',
    link: { url: 'https://github.com/nicobailon/pi-subagents#readme', hostname: 'github.com', title: '查看 Extension 说明' },
    restart: { message: '请先在终端完成安装。重启会结束当前 Pi 运行并重新加载 Extension；独立后台任务不由 GUI 终止。' },
  };
}
