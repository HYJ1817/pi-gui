/* P32.4-D: one resource policy projection and launch path for every view.
 * The backend remains the only authority on limits, including external classic
 * children and cleanup_pending. Never count DOM rows or infer released slots. */
import { fetchRuntimeSessions, runtimeSessionAction } from './api.js';
import { runtimeStore, seedRuntimeSnapshot, onRuntimeLifecycle } from './runtime-state.js';
import { confirmModal } from './ui/modal.js';

export function resourceText(resources = runtimeStore.resources()) {
  if (!resources || !Number.isInteger(resources.totalCount) || !Number.isInteger(resources.limit)) return '运行名额暂不可用';
  return resources.totalCount > resources.limit ? `${resources.totalCount} 个会话正在运行` : `正在运行 ${resources.totalCount} / ${resources.limit}`;
}
export function runtimeLimitNotice(result) {
  if (result?.code === 'runtime_limit') return '运行名额已满。可以打开历史，关闭一个运行中的会话后再恢复，或稍后恢复。';
  if (result?.code === 'cleanup_pending') return '清理未完成，运行名额仍被占用。请等待清理完成后再试。';
  return null;
}

export function createResourceLauncher({ read, send, confirm, seed = () => {} }) {
  const snapshot = async () => { const s = await read(); if (s?.ok !== false) seed(s); return s; };
  const third = s => s?.ok !== false && Number.isInteger(s?.totalCount) && s.totalCount === s.limit && s.totalCount < s.hardLimit;
  const ask = () => confirm({ title: '启动第三个会话？', message: '当前已有两个活动会话。继续将启动第 3 个 Pi 会话，会增加 CPU、内存和模型请求占用。', okText: '继续启动', cancelText: '取消' });
  const extra = p => p.action === 'start' ? { ...p, args: { ...p.args, allowThird: true } } : { ...p, allowThird: true };
  return async payload => {
    let approved = false;
    const before = await snapshot();
    if (third(before)) {
      if (await ask() !== true) return { ok: false, cancelled: true };
      approved = true;
    }
    let result = await send(approved ? extra(payload) : payload);
    const after = await snapshot();
    // A concurrent launch may consume the second regular slot after preflight.
    // At most one confirmation and one retry; fourth requests always hit backend.
    if (result?.code === 'runtime_limit' && !approved && third(after)) {
      if (await ask() !== true) return { ...result, cancelled: true };
      result = await send(extra(payload));
      await snapshot();
    }
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
  read: fetchRuntimeSessions, send: runtimeSessionAction, confirm: confirmModal, seed: seedRuntimeSnapshot,
});
