/* 会话统计请求的身份与竞态账本。
 *
 * `get_session_stats` 的载荷里没有模型身份，而 Pi 的统计缓存会随当前
 * 模型变化。GUI 在请求发出时记下**那一刻**的模型身份、工作区与会话，
 * 应答回来时据此判断它属于哪一代 —— 否则模型/会话切换后迟到的旧应答
 * 会把旧模型的 contextWindow 重新画到界面上。
 *
 * 单独成模块是为了避开 messages.js ↔ usage.js 的环：两边都只依赖
 * 这里，不互相 import。
 */
import { S } from './state.js';
import { modelIdentity } from './model-capabilities.js';
import { sendCommand } from './api.js';

let sequence = 0;
let floor = 0;
const pending = new Map();

/** 发一次 get_session_stats，并登记请求时的上下文身份。 */
export function requestSessionStats() {
  const id = 'session-stats-' + (++sequence);
  pending.set(id, {
    seq: sequence,
    identity: modelIdentity(S.state?.model),
    workspace: S.workspaceGeneration,
    sessionId: S.state?.sessionId || S.localUsage?.sessionId || null,
  });
  // 上限保护：旧版本 / 异常情况下不留下无界 Map。
  if (pending.size > 32) pending.delete(pending.keys().next().value);
  sendCommand({ type: 'get_session_stats', id });
  return id;
}

/** 会话切换时调用：切换前发出的统计应答即使迟到，也不能写进新会话。 */
export function invalidateSessionStats() {
  floor = sequence;
}

/** 取走某个请求的身份记录；不是本模块发的请求返回 null。
 *  切换前发出的请求带 stale 标记，applyStats 会直接丢弃。 */
export function takeSessionStatsRequest(id) {
  if (typeof id !== 'string' || !pending.has(id)) return null;
  const meta = pending.get(id);
  pending.delete(id);
  return meta.seq <= floor ? { ...meta, stale: true } : meta;
}
