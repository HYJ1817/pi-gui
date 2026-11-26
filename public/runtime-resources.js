/* One authoritative running-count projection and launch path for every view.
 * Counts include external classic children and cleanup_pending. Never count
 * DOM rows or infer completed cleanup from an individual item. */
import { fetchRuntimeSessions, runtimeSessionAction } from './api.js';
import { runtimeStore, seedRuntimeSnapshot, onRuntimeLifecycle } from './runtime-state.js';

export function resourceText(resources = runtimeStore.resources()) {
  if (!Number.isInteger(resources?.totalCount) || resources.totalCount < 0) return '运行数量暂不可用';
  return `${resources.totalCount} 个会话正在运行`;
}
export function runtimeActionNotice(result) {
  if (result?.code === 'runtime_busy') return '此会话已有任务正在执行，草稿已保留；可以切到其它会话继续。';
  if (result?.code === 'tool_guard_unavailable') return '工具写入协调未能就绪，输入已保留；请等待任务结束后，手动重启受影响会话再试。';
  if (result?.code === 'cleanup_pending') return '清理未完成。请等待清理完成后再试。';
  return null;
}

export function createResourceLauncher({ read, send, seed = () => {} }) {
  return async payload => {
    const result = await send(payload);
    // Readback updates counts and owners, never authorizes or repeats a launch.
    // A failed readback must not hide the actual operation result.
    try {
      const snapshot = await read();
      if (snapshot?.ok !== false) seed(snapshot);
    } catch { /* Best-effort readback; lifecycle refresh reconciles later. */ }
    return result;
  };
}

let pending = null, again = false;
export function refreshRuntimeResources() {
  if (pending) return pending;
  pending = (async () => {
    do {
      again = false;
      const snapshot = await fetchRuntimeSessions();
      if (snapshot?.ok !== false && Array.isArray(snapshot?.items)) seedRuntimeSnapshot(snapshot);
    } while (again);
  })().finally(() => { pending = null; });
  return pending;
}
onRuntimeLifecycle(() => {
  if (pending) again = true;
  else void refreshRuntimeResources().catch(() => {});
});

export const launchRuntimeSession = createResourceLauncher({
  read: fetchRuntimeSessions, send: runtimeSessionAction, seed: seedRuntimeSnapshot,
});
