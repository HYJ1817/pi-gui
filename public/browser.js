/* Browser Use（真实浏览器自动化）的设置区 + 运行观察。
 *
 * 立场与 P16/P18 一致：**Pi GUI 不发明 pi 没有的能力，也不假装保护用户。**
 *
 * 默认兼容 pi-browser-harness（原生 Pi Extension，经 CDP 驱动真实 Chrome）。
 * 它没有针对 `browser_*` 工具执行的审批协议：源码里没有 `pi.on("tool_call")`
 * 拦截，也没有在这些工具执行前调用 `ctx.ui.confirm`。`/browser-profile` 会使用
 * `ctx.ui.select` 做 Profile 配置；Pi 0.87.0 的 RPC 会把这类选择交给 GUI 处理，
 * 但这属于配置交互，不是浏览器动作的权限闸门。所以 GUI 侧**不提供**浏览器
 * 动作的允许 / 拒绝按钮，也不宣称「已保护」——只如实说明「这些动作会直接发生」。
 *
 * P22 起布局统一到 `ui/capability-setup.js`；这里只提供事实与措辞。 */
import { S } from './state.js';
import { createBrowserObservation, browserCapability, acceptBrowserEvent } from './browser-capabilities.js';
import { webSourceLink } from './web-activity.js';
import { renderSetupSection } from './ui/capability-setup.js';
import { setupViewModel } from './capability-model.js';

const observation = createBrowserObservation();

/** SSE 入口：先过 workspace/run 守卫，再记「当前 Pi 真的调用过哪些 browser 工具」。 */
export function observeBrowserEvent(event) {
  if (!acceptBrowserEvent(event, S)) return;
  observation.observe(event, S.workspaceGeneration, S.bridgeRun);
}

/** 统一的运行观察形状，供 Capability 视图复用同一个观察实例。 */
export function browserObservation() {
  return observation.snapshot(S.workspaceGeneration, S.bridgeRun);
}

export function renderBrowserSetup(box, registry) {
  const model = setupViewModel(browserCapability(registry, browserObservation()));
  box.replaceChildren(renderSetupSection(model, { linkFactory: webSourceLink }));
  return box;
}
