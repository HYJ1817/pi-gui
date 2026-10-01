/* MCP 运行观察的**浏览器单例**（P20.6）。
 *
 * 单独一个文件，是为了让 `mcp-capabilities.js` 保持**纯函数、不 import
 * state.js** —— 后者在模块加载时就会碰 `document`，node 单测里 import 不了它。
 * 纯逻辑（acceptMcpEvent / createMcpObservation / mcpSetup）留在 capabilities，
 * 需要 S（workspaceGeneration / bridgeRun）的单例放这里。
 *
 * 与 Browser / Web / Memory 的观察同一种模式：先过 workspace/run 守卫，
 * 再记「当前 Pi 真的调用过哪个 MCP server」。 */

import { S } from './state.js';
import { acceptMcpEvent, createMcpObservation } from './mcp-capabilities.js';

const observation = createMcpObservation();

/** SSE 入口：先过 workspace/run 守卫，再记「当前 Pi 真的调用过哪个 MCP server」。 */
export function observeMcpEvent(event) {
  if (!acceptMcpEvent(event, S)) return;
  observation.observe(event, S.workspaceGeneration, S.bridgeRun);
}

export function snapshotMcpObservation() {
  return observation.snapshot(S.workspaceGeneration, S.bridgeRun);
}
