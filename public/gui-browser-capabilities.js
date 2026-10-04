import { S } from './state.js';
import { GUI_BROWSER_TOOLS } from './gui-browser-activity.js';

export function createGuiBrowserObservation() {
  let key = '', names = new Set();
  function snapshot(generation, run) {
    const next = `${generation}/${run}`;
    if (key !== next) { key = next; names.clear(); }
    return names.size ? { any: true, count: names.size, names: [...names] } : null;
  }
  function observe(event, generation, run, switching = false) {
    snapshot(generation, run);
    if (event?.type === 'bridge_status' && ['starting', 'restarting', 'exited', 'error', 'no-project', 'maintenance'].includes(event.state)) names.clear();
    if (switching || !Number.isInteger(run) || event?.bridgeRun !== run) return;
    if (/^tool_execution_(start|update|end)$/.test(event.type) && GUI_BROWSER_TOOLS.has(event.toolName)) names.add(event.toolName);
  }
  return { snapshot, observe };
}
const observation = createGuiBrowserObservation();
let mainState = null;
let mainRevision = 0;
let subscribedBridge = null;
// A projection of Electron's authoritative status, never a local permission.
export function acceptGuiBrowserState(next) {
  if (!next || typeof next !== 'object') return;
  const boolean = (v) => typeof v === 'boolean' ? v : null;
  mainRevision++;
  mainState = { available: boolean(next.available), enabled: boolean(next.enabled),
    attached: boolean(next.attached), browserOpen: boolean(next.open),
    loading: boolean(next.loading), busy: boolean(next.busy) };
}
export function initGuiBrowserState(desktop = globalThis.window?.piGuiDesktop) {
  const bridge = desktop?.browser;
  if (!bridge?.agentStatus || bridge === subscribedBridge) return;
  subscribedBridge = bridge;
  bridge.onAgentState?.(acceptGuiBrowserState);
  const revision = mainRevision;
  Promise.resolve(bridge.agentStatus()).then((next) => {
    if (revision === mainRevision && subscribedBridge === bridge) acceptGuiBrowserState(next);
  }).catch(() => {});
}
export function observeGuiBrowserEvent(event) {
  observation.observe(event, S.workspaceGeneration, S.bridgeRun, S.switching);
}
export function guiBrowserObservation() {
  return observation.snapshot(S.workspaceGeneration, S.bridgeRun);
}
export function guiBrowserCapability(registry, observed = null, desktop = globalThis.window?.piGuiDesktop) {
  const evidence = registry?.guiBrowser;
  const desktopAvailable = Boolean(desktop?.browser?.agentStatus && desktop?.browser?.setAgentControl);
  const tri = (v) => typeof v === 'boolean' ? v : null;
  const current = desktopAvailable ? mainState : { available: false, enabled: false, attached: false, browserOpen: false };
  const text = (v) => v === true ? '是' : v === false ? '否' : '未知（无法确认）';
  return {
    id: 'gui-browser', kind: 'capability', origin: 'gui', originLabel: 'pi-GUI 自带能力',
    name: 'Built-in Browser Agent Control',
    purpose: '通过 gui_browser_* 控制 pi-GUI 内置浏览器，验证 localhost 页面。',
    state: { installed: tri(evidence?.bundled), configured: desktopAvailable ? tri(evidence?.configured) : false,
      loaded: desktopAvailable ? tri(evidence?.loaded) : false, runtimeObserved: observed,
      available: tri(current?.available), enabled: tri(current?.enabled), attached: tri(current?.attached), browserOpen: tri(current?.browserOpen),
      automaticInstall: false },
    installNote: '随 pi-GUI 安装包提供，无需额外安装。仅桌面版可用。',
    notes: [`Electron 状态：可用 ${text(current?.available)} · Agent 控制 ${text(current?.enabled)} · CDP 已连接 ${text(current?.attached)} · 浏览器已打开 ${text(current?.browserOpen)}`,
      'Agent 控制默认关闭，需在内置浏览器工具栏主动开启；仅允许 localhost。',
      '页面内容、截图、console 和 network 会在工具调用时进入模型上下文；Activity 只显示动作和计数。',
      '与 pi-browser-harness 的外部 browser_* 能力独立，不控制用户 Chrome。'],
    limits: ['使用独立非持久化浏览器会话；应用重启后需重新开启 Agent 控制。'],
    source: 'Electron preload + bundled Extension 加载证据 + 当前 workspace / bridge run 工具事件',
  };
}
