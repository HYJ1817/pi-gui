/* Pi Memory 的 Extensions 页设置区 + 运行观察。
 *
 * P22 起布局统一到 `ui/capability-setup.js`；这里只提供事实与措辞。 */
import { S } from './state.js';
import { createMemoryObservation, memoryCapability, memoryObservationState, acceptMemoryEvent } from './memory-capabilities.js';
import { webSourceLink } from './web-activity.js';
import { renderSetupSection } from './ui/capability-setup.js';
import { setupViewModel } from './capability-model.js';

const observation = createMemoryObservation();

/** SSE 入口：先过 workspace/run 守卫，再记「当前 Pi 真的调用过哪个 memory 工具」。 */
export function observeMemoryEvent(event) {
  if (!acceptMemoryEvent(event, S)) return;
  observation.observe(event, S.workspaceGeneration, S.bridgeRun);
}

/** 统一的运行观察形状，供 Capability 视图复用同一个观察实例。 */
export function memoryObservation() {
  return memoryObservationState(observation, S.workspaceGeneration, S.bridgeRun);
}

export function renderMemorySetup(box, registry) {
  const model = setupViewModel(memoryCapability(registry, memoryObservation()));
  box.replaceChildren(renderSetupSection(model, { linkFactory: webSourceLink }));
  return box;
}
