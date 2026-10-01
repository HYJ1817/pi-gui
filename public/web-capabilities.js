/* Evidence scoped to workspace generation + bridge run. Not a registered tool list. */
import { registryEvidence, observationFromMap } from './capability-model.js';

export const WEB_INSTALL_COMMAND = 'pi install npm:pi-web-access';

/** 这个 feature 对应的 Extension 包名。**只是 setup metadata** —— 用于「磁盘上有没有它」。 */
export const WEB_EXTENSION_NAME = 'pi-web-access';

export function createWebObservation() {
  let key = '';
  let observed = {};
  function snapshot(generation, run) {
    const next = `${generation}/${run}`;
    if (next !== key) { key = next; observed = {}; }
    return Object.fromEntries(['web_search', 'fetch_content', 'get_search_content'].map(name => [name, observed[name] === true]));
  }
  function observe(event, generation, run) {
    snapshot(generation, run);
    if (event?.type === 'bridge_status' && ['restarting', 'starting', 'exited', 'error', 'no-project'].includes(event.state)) observed = {};
    if (!/^tool_execution_(start|update|end)$/.test(event?.type || '') || event.bridgeRun !== run) return;
    if (['web_search', 'fetch_content', 'get_search_content'].includes(event.toolName)) observed[event.toolName] = true;
  }
  return { snapshot, observe };
}

/**
 * Registry 证据 → 统一三值状态。**委托给 capability-model 的唯一实现**，
 * 这里不再自己写一份（四份拷贝正是措辞会分叉的原因）。
 */
export function webSetup(registry) {
  const evidence = registryEvidence(registry, WEB_EXTENSION_NAME);
  return {
    installed: evidence.installed,
    // Registry's enabled evidence is distinct from presence and runtime tool evidence.
    configured: evidence.configured,
    discovered: evidence.discovered,
    loaded: evidence.loaded,
    restartRequired: evidence.restartRequired,
    diagnostic: evidence.diagnostic,
    automaticInstall: false,
  };
}

/** 当前 bridge run 的运行观察（统一形状 `{any,count,names}`）。 */
export function webObservationState(observation, generation, run) {
  return observationFromMap(observation.snapshot(generation, run));
}

/** 统一 setup 布局用的 descriptor。**不含任何安装、下载或网络动作。** */
export function webCapability(registry, observed = null) {
  const state = { ...webSetup(registry), runtimeObserved: observed };
  return {
    id: 'web',
    kind: 'capability',
    name: 'Web Access',
    purpose: '联网搜索与抓取网页正文：web_search / fetch_content / get_search_content。',
    origin: 'extension',
    packageName: WEB_EXTENSION_NAME,
    installCommand: WEB_INSTALL_COMMAND,
    installNote: '这是第三方 Extension，需要在终端用 pi 官方命令安装。Pi GUI 不安装、不下载、不代管配置与凭据。',
    state,
    notes: [
      '其他 Extension 也可提供这些工具。磁盘发现不代表工具已注册。配置与凭据由 Extension 管理。',
      '运行观察只说明「这次 bridge run 真的调用过它」：Pi RPC 没有权威的已注册工具清单，同名工具也可能来自别的 Extension。',
    ],
    limits: [
      '第三方 Extension 与 Pi 进程拥有同等系统权限，可访问网络和本地资源；只安装你信任的代码。',
      '在终端执行安装后，重启 Pi，再刷新本页。供应商配置与凭据由 Extension 管理。',
    ],
    source: 'GET /api/extensions（Extension Registry 只读发现）+ 本次 bridge run 的 tool_execution_* 事件',
    link: { url: 'https://github.com/nicobailon/pi-web-access#readme', hostname: 'github.com', title: '查看 Extension 配置说明' },
    restart: { message: '请先在终端完成官方安装。重启会结束当前 Pi 会话运行，并重新加载 Extension。' },
  };
}
