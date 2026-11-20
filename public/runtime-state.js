/* P32.4：前端 runtime conversation 的**唯一事实源**。
 *
 * 侧栏导航（runtime-nav.js）与「独立会话」面板（runtime-sessions.js）必须共用
 * **同一个 store 实例**。各建一份会把 revision / eventSequence / owner 这三条
 * 防护拆成两份：A 视图漏掉的迟到事件会从 B 视图漏进去。P32.3 花了很多力气才把
 * 这三条钉住（见 docs/p32-3-acceptance.md 的「异步操作在 preflight 和执行/返回后
 * 重新校验 owner」），这里不退回。
 *
 * store 本身仍是 runtime-store.js 里的**纯模型**（不碰 DOM、不碰网络），
 * 本模块只负责「只建一次」并把它暴露出去。
 */
import { createRuntimeStore } from './runtime-store.js';
import { observeRuntimeExecution, retireRuntimeExecution, seedRuntimeExecution } from './execution-timeline-state.js';

export const runtimeStore = createRuntimeStore();

/* 变化广播放在**这里**（store 旁边），而不是某个视图模块里：
 * 侧栏与独立会话面板都是同一份 store 的视图，谁都不该依赖对方。
 * 谁 apply 谁广播一次，视图只订阅、不自己 apply（各自 apply 会把
 * eventSequence 游标吃两遍，第二个视图就再也看不到那一帧）。 */
const listeners = new Set();
export function onRuntimeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const lifecycleListeners = new Set();
export function onRuntimeLifecycle(fn) { lifecycleListeners.add(fn); return () => lifecycleListeners.delete(fn); }
export function setRuntimeStoreRejectObserver(fn) { runtimeStore.setRejectObserver(fn); }
function broadcast(frame) { for (const fn of [...listeners]) fn(frame); }
// 共享待提交状态，防止中央/弹窗同时提交同一审批。后端仍是权限校验的唯一裁决者。
export async function respondToRuntimeApproval(owner, approval, send) {
  if (!runtimeStore.beginApproval(owner, approval)) return null;
  broadcast();
  let result;
  try { result = await send(); return result; }
  finally { runtimeStore.finishApproval(owner, approval, result?.ok === true); broadcast(); }
}
export function seedRuntimeSnapshot(snapshot) {
  if (!runtimeStore.seed(snapshot)) return;
  try {
    for (const item of snapshot.items || []) seedRuntimeExecution(runtimeStore.get(item.conversationId)?.item);
  } catch { /* The shadow projection cannot gate the existing store. */ }
  broadcast();
}
export function refreshRuntimeViews() { broadcast(); }

/** 标题就地更新：不广播、不重排、不改 revision。
 *  payload：{title, source, revision}，revision 是后端标题修订号；
 *  store 只接受不旧于当前 titleRevision 的值（旧 SSE 不能覆盖新标题）。 */
export function patchRuntimeTitle(conversationId, payload) {
  return runtimeStore.patchTitle(conversationId, payload);
}

/** SSE 帧入口：返回 true 表示这份帧真的改动了 store（视图据此重画）。 */
export function observeRuntimeFrame(frame) {
  const id = frame.owner?.conversationId || frame.conversationId;
  const prior = runtimeStore.get(id);
  const lifecycle = prior?.item?.lifecycle, owner = prior?.owner, error = prior?.item?.error;
  try { observeRuntimeExecution(frame, prior); } catch { /* observation only */ }
  if (!runtimeStore.apply(frame)) return false;
  const next = runtimeStore.get(id);
  try {
    if (frame.type === 'runtime_state') seedRuntimeExecution(next?.item);
    else if (frame.type === 'runtime_closed') retireRuntimeExecution(frame.owner);
  } catch { /* observation only */ }
  broadcast(frame);
  if (frame.type === 'runtime_closed' || frame.type === 'runtime_state' &&
      (lifecycle !== next?.item?.lifecycle || owner?.runtimeGeneration !== next?.owner?.runtimeGeneration || error !== next?.item?.error)) {
    for (const fn of [...lifecycleListeners]) fn();
  }
  return true;
}
