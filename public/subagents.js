/* Subagents 的 Extensions 页设置区 + 运行观察。
 *
 * P22 起布局统一到 `ui/capability-setup.js`；这里只提供事实与措辞。 */
import { S } from './state.js';
import { createSubagentObservation, subagentCapability, subagentObservationState, acceptSubagentEvent } from './subagent-capabilities.js';
import { webSourceLink } from './web-activity.js';
import { renderFeatureSetup } from './ui/capability-setup.js';

const observation = createSubagentObservation();

export function observeSubagentEvent(event) {
  if (!acceptSubagentEvent(event, S)) return;
  observation.observe(event, S.workspaceGeneration, S.bridgeRun);
}

/** 统一的运行观察形状，供 Capability 视图复用同一个观察实例。 */
export function subagentObservation() {
  return subagentObservationState(observation, S.workspaceGeneration, S.bridgeRun);
}

export function renderSubagentSetup(box, registry) {
  /* 一键安装成功后重新读 Registry，按新证据重画（命令完成 ≠ 装上）。 */
  return renderFeatureSetup(box, (reg) => subagentCapability(reg, subagentObservation()), registry, { linkFactory: webSourceLink });
}
