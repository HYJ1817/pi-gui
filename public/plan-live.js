/* Classic 实时任务列表：把 gui_plan 的 start/end 事件接到一张卡上。
 *
 * 一张卡 = 一个用户回合。真实的新任务边界（agent_start 时上一轮已 settled）
 * 到来后，第一条用户消息只把「当前卡」指针清空，旧卡留在时间线里（那是上一
 * 回合的真实记录）。本回合第一次 gui_plan 调用会新建一张卡，后续更新复用
 * 同一张。运行中的 steer/follow-up 不是新任务，不会切换卡片。
 *
 * 计划工具**不进 Tool Timeline**：它的调用本身没有用户可读的操作结果，
 * 任务列表就是它的全部呈现。tools.js 在 onToolStart/onToolEnd 最先询问
 * 这里，命中就不再创建工具条目。
 *
 * 事件顺序里有一个坑：pi 的 tool_execution_end 不带 toolName（见 tools.js
 * 文件头）。所以按 toolCallId 记住哪些调用是计划调用，结束时按 id 认领；
 * 不能靠 end 事件的工具名。
 */

import { S } from './state.js';
import { isPlanTool, normalizePlan } from './plan-model.js';
import { renderPlan, setPlanStalled, updatePlan } from './plan-view.js';

let current = null;              // { node, plan } —— 本回合当前卡
const calls = new Map();         // toolCallId -> { previous, created }
/* Pi 的事件顺序：session 级 run 开始时发 agent_start；整个 run 结束时发
 * agent_settled。自动重试 / 压缩会再次发 agent_start，但上一轮尚未 settled，
 * 不是新任务；运行中的 steer / follow-up 用户消息甚至不会发新的 agent_start。
 * 所以「新任务」只在 agent_start 到来且上一轮已 settled 时成立 —— 这个信号
 * 由 app.js 在真实事件处打点，renderUser 不再自行把每条 user 消息当新回合。 */
let taskBoundaryPending = false;

function thread() {
  return S.thread;
}

function appendCard(plan) {
  const t = thread();
  if (!t) return null;
  const node = renderPlan(plan);
  t.appendChild(node);
  if (S.working) t.appendChild(S.working);
  return node;
}

/** app.js 在「agent_start 且上一轮已 settled」时打点：这是真实的新任务边界。 */
export function beginPlanTaskBoundary() {
  taskBoundaryPending = true;
}

/** run 收尾时消费掉未使用的边界信号：它只对本次 run 的第一条用户消息有效，
 *  不能让下一次运行中的 steer 误用上一次的标记。 */
export function settlePlanTaskBoundary() {
  taskBoundaryPending = false;
}

/** 用户消息到达时消费边界：只有真实的新任务才切换当前卡；steer 不清。
 *  旧卡始终留在时间线里，那是上一回合的真实记录。 */
export function resetPlanLiveForUserTurn() {
  if (!taskBoundaryPending) return;
  taskBoundaryPending = false;
  current = null;
  calls.clear();
}

/** 清空线程 / 切会话 / 历史重建前：DOM 由调用方清，指针与调用表必须一起清。 */
export function clearPlanLive() {
  taskBoundaryPending = false;
  current = null;
  calls.clear();
}

export function isLivePlanCall(toolCallId) {
  return calls.has(toolCallId);
}

/**
 * @returns {boolean} 是否是计划工具调用（true 表示 tools.js 不应再建工具条目）
 */
export function handlePlanToolStart(evt) {
  if (!isPlanTool(evt?.toolName)) return false;
  const id = String(evt?.toolCallId ?? '');
  const plan = normalizePlan(evt?.args);
  const previous = current?.plan || null;
  calls.set(id, { previous, created: false });

  if (!plan) return true;   // 参数还不合法：等结束事件；失败时什么都不画
  if (!current?.node) {
    const node = appendCard(plan);
    if (!node) return true;
    current = { node, plan };
    calls.get(id).created = true;
  } else {
    setPlanStalled(current.node, false);
    current = { node: current.node, plan };
    updatePlan(current.node, plan);
  }
  return true;
}

/**
 * @returns {boolean} 是否是计划工具调用结束（true 表示已消费）
 */
export function handlePlanToolEnd(evt) {
  const id = String(evt?.toolCallId ?? '');
  const call = calls.get(id);
  if (!call) return false;
  calls.delete(id);

  const plan = normalizePlan(evt?.result?.details);
  if (plan) {
    current = { node: current?.node || appendCard(plan), plan };
    if (current.node) {
      setPlanStalled(current.node, false);
      updatePlan(current.node, plan);
    }
    return true;
  }

  /* 扩展明确拒绝了这次更新（invalid_plan）：退回上一次已确认的计划。
   * 如果这张卡就是本次调用新建的，删掉它 —— 不留一张没有真实结果的卡。 */
  if (current?.node) {
    if (call.previous) {
      setPlanStalled(current.node, false);
      updatePlan(current.node, call.previous);
      current = { node: current.node, plan: call.previous };
    } else if (call.created) {
      current.node.remove();
      current = null;
    }
  }
  return true;
}

/** agent 已收尾但计划里还有 in_progress：展示层标成「未完成」，不改数据状态。 */
export function markLivePlanStalled() {
  if (current?.node) setPlanStalled(current.node, true);
}
