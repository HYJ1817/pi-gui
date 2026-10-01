/* Subagents 的 Extensions 页设置区 + 运行观察。
 *
 * P22 起布局统一到 `ui/capability-setup.js`；这里只提供事实与措辞。 */
import { S } from './state.js';
import { createSubagentObservation, subagentCapability, subagentObservationState, acceptSubagentEvent } from './subagent-capabilities.js';
import { webSourceLink } from './web-activity.js';
import { renderSetupSection } from './ui/capability-setup.js';
import { setupViewModel } from './capability-model.js';

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
  const model = setupViewModel(subagentCapability(registry, subagentObservation()));
  box.replaceChildren(renderSetupSection(model, { linkFactory: webSourceLink }));
  return box;
}
