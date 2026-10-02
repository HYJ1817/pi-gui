/* Web Access 的 Extensions 页设置区 + 运行观察。
 *
 * P22 起布局统一到 `ui/capability-setup.js`：这里只提供**事实与措辞**
 * （安装命令、观察入口、限制说明），排版交给那一层。渲染语义一个都没变。
 */
import { S } from './state.js';
import { createWebObservation, webSetup, webCapability, webObservationState, WEB_INSTALL_COMMAND } from './web-capabilities.js';
import { webSourceLink } from './web-activity.js';
import { renderFeatureSetup } from './ui/capability-setup.js';

const observation = createWebObservation();

export function observeWebEvent(event) {
  // The old run may still emit while workspace activation awaits the new bridge.
  if (S.switching && /^tool_execution_/.test(event?.type || '')) return;
  observation.observe(event, S.workspaceGeneration, S.bridgeRun);
}

export { createWebObservation, webSetup, webCapability, WEB_INSTALL_COMMAND };

/** 当前 Pi 真的调用过哪些 web 工具（统一形状，供 Capability 视图复用同一个观察）。 */
export function webObservation() {
  return webObservationState(observation, S.workspaceGeneration, S.bridgeRun);
}

export function renderWebSetup(box, registry) {
  /* 一键安装成功后重新读 Registry，按新证据重画（命令完成 ≠ 装上）。 */
  return renderFeatureSetup(box, (reg) => webCapability(reg, webObservation()), registry, { linkFactory: webSourceLink });
}
