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
import { registryEvidence } from './capability-model.js';

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
    /* bridge 生命周期一变，旧 run 的观察就没有意义了。maintenance（Pi 正在被
     * self-update 替换）同样是「那个 runtime 已经不在了」—— 只是它是计划内的。 */
    if (event?.type === 'bridge_status' && ['starting', 'restarting', 'exited', 'error', 'no-project', 'maintenance'].includes(event.state)) reset();
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
  const evidence = registryEvidence(registry, BROWSER_EXTENSION_NAME);
  return {
    installed: evidence.installed,
    // Registry 的 enabled 证据与「存在」是两件事。
    configured: evidence.configured,
    discovered: evidence.discovered,
    loaded: evidence.loaded,
    restartRequired: evidence.restartRequired,
    diagnostic: evidence.diagnostic,
    automaticInstall: false,
  };
}

/** 统一 setup 布局用的 descriptor。 */
export function browserCapability(registry, observed = null) {
  const state = { ...browserSetup(registry), runtimeObserved: observed };
  return {
    id: 'browser',
    kind: 'capability',
    name: 'Browser Use（真实浏览器自动化）',
    purpose: `通过 CDP 驱动你正在用的浏览器：打开页面、点击、输入、截图、读正文（${BROWSER_TOOLS.size} 个 browser_* 工具）。`,
    origin: 'extension',
    packageName: BROWSER_EXTENSION_NAME,
    installCommand: BROWSER_INSTALL_COMMAND,
    /* 一键安装的 capability id（服务端固定 allowlist 的键）。 */
    installId: 'browser',
    installNote: '这是第三方 Extension。页内「安装」会调用当前 Pi 的官方安装命令（用户级，不加 -l）；也可以复制命令在终端自己执行。Pi GUI 不安装浏览器、不下载驱动、不改动 Extension 配置。',
    state,
    notes: [
      'Browser Use 与 Web Search 是两件事：Web Search 只做搜索与取正文，不驱动浏览器；Browser Use 会真的打开页面、点击、输入、截图。两者互相独立，各自的工具各自渲染。',
      '这些动作会直接发生，Pi GUI 拦不住它们：这个 Extension 没有审批协议，所以这里不提供允许 / 拒绝按钮，也不声称已保护。高风险动作（提交表单、购买、删除、发布、发送消息）请自己盯住页面。',
      'Activity 只显示结构化字段（动作、主机名、计数）。输入框内容默认不显示，截图不自动上传，页面正文、控制台与网络记录不进 Activity。',
      '观察到工具名只说明「当前这次运行真的调用过它」，不构成「这个包已加载」的证据 —— 同名工具也可能来自别的 Extension。Pi RPC 没有权威的已注册工具清单。',
    ],
    limits: [
      '第三方 Extension 与 Pi 进程拥有同等系统权限，可访问网络、本地文件，并能控制你已登录的浏览器。只安装可信代码。',
      '在终端安装后重启 Pi，再刷新本页。浏览器连接、Profile 与页面状态都由 Extension 自己管理：Pi GUI 不做浏览器 UI、不导入 Cookie、不管密码、不建下载中心，也不自动登录。',
    ],
    source: 'GET /api/extensions（Extension Registry 只读发现）+ 本次 bridge run 的 tool_execution_* 事件',
    link: { url: 'https://github.com/amankumarsingh77/pi-browser-harness#readme', hostname: 'github.com', title: '查看 Extension 说明' },
    restart: { message: '请先在终端完成官方安装。重启会结束当前 Pi 运行并重新加载 Extension；Pi GUI 不安装浏览器、不下载驱动、不改动 Extension 配置。' },
  };
}
