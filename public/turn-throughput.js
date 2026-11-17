/* 本轮生成速度（TPS）的计时账本。
 *
 * 口径（与上游 PI-Desktop v0.22.0 一致）：
 *   TPS = 本轮所有 assistant 响应的 usage.output 之和
 *         / 这些响应各自的「开始 → message_end」时长之和
 *
 * 只统计模型真正在产出的时间：message_start 到 message_end 的区间，
 * 工具执行、等待审批、下一轮请求前的空档都不计入。**不能**拿
 * messages.js 的 liveTurn.startedAt —— 那是整个 Agent 任务的起点，
 * 里面包含工具时间，算出来会系统性偏低。
 *
 * 没有证据就不猜：
 *   - 没有 message_start（拿不到起点）→ 该响应不计时长；
 *   - usage.output 缺失或为 0 → 不拿 0 当分子；
 *   - 只有被打断（stopReason=aborted）且没有最终 usage 时，才按可见文本
 *     估算输出，并标 estimated，界面显示「≈」；
 *   - 历史消息没有实时计时，重建时不会调用这里，因此不会凭空生成 TPS。
 *
 * 隔离：开始 / 结束都校验 workspaceGeneration 与会话身份；换工作区、换会话、
 * 换模型由调用方 reset。所有时钟都是单调时钟，不读系统墙钟。
 */
import { S } from './state.js';

let generation = 0;
let turn = null;

function monotonicNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function currentSessionId() {
  return S.state?.sessionId || S.localUsage?.sessionId || null;
}

function newTurn() {
  return {
    generation: ++generation,
    workspace: S.workspaceGeneration,
    sessionId: currentSessionId(),
    outputTokens: 0,
    durationMs: 0,
    estimated: false,
    active: null,
    generating: false,
    settled: false,
  };
}

function stale() {
  if (!turn) return true;
  if (turn.workspace !== S.workspaceGeneration) return true;
  const sessionId = currentSessionId();
  return Boolean(turn.sessionId && sessionId && turn.sessionId !== sessionId);
}

function ensureTurn() {
  if (stale()) turn = newTurn();
  return turn;
}

/** 丢弃本轮计时。换会话 / 换模型 / 换工作区 / 清空线程时调用。 */
export function resetThroughput() {
  ++generation;
  turn = null;
}

/** 新的 Agent turn（agent_start，且上一轮已收尾）。 */
export function beginThroughputTurn() {
  turn = newTurn();
  turn.generating = true;
  return turn.generation;
}

/** assistant message_start：记下这一条响应的单调起点。 */
export function noteAssistantStart(evt, at = monotonicNow()) {
  const message = evt?.message;
  if (!message || message.role !== 'assistant') return;
  const t = ensureTurn();
  t.active = { startedAt: at };
  t.generating = true;
  t.settled = false;
}

function messageVisibleText(message) {
  let text = '';
  if (Array.isArray(message?.content)) {
    for (const part of message.content) {
      if (typeof part === 'string') text += part;
      else if (part?.type === 'text' && typeof part.text === 'string') text += part.text;
      else if (part?.type === 'thinking') text += part.thinking || part.text || '';
    }
  } else if (typeof message?.content === 'string') {
    text += message.content;
  }
  if (typeof message?.thinking === 'string') text += message.thinking;
  return text.trim();
}

/** 被打断的响应没有最终 usage 时，按可见文本估算输出（与上游同口径）。 */
export function estimateResponseOutputTokens(message) {
  const visible = messageVisibleText(message);
  return visible ? Math.max(1, Math.ceil(Array.from(visible).length / 4)) : undefined;
}

function positiveOutput(usage) {
  const value = usage?.output;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * assistant message_end：结算这一条响应。
 * `at` 仅供测试注入；生产调用一律用单调时钟。
 */
export function noteAssistantEnd(evt, at = monotonicNow()) {
  const message = evt?.message;
  if (!message || message.role !== 'assistant') return throughputSnapshot();
  const t = ensureTurn();
  const startedAt = t.active?.startedAt;
  const duration = Number.isFinite(startedAt) && at > startedAt ? at - startedAt : null;
  t.active = null;
  t.generating = false;

  let output = positiveOutput(message.usage);
  let estimated = false;
  if (output == null && message.stopReason === 'aborted') {
    const estimate = estimateResponseOutputTokens(message);
    if (estimate != null) {
      output = estimate;
      estimated = true;
    }
  }

  /* 时长与输出分别累加：上游的聚合口径也是这样。缺一项的响应仍然给
   * 另一项贡献数据，但最终 TPS 只有两项都有值时才计算。 */
  if (duration != null) t.durationMs += duration;
  if (output != null) t.outputTokens += output;
  if (estimated) t.estimated = true;
  return throughputSnapshot();
}

/** agent_settled：本轮结束。没有 message_end 的响应不编造时长。 */
export function settleThroughputTurn() {
  if (!turn) return throughputSnapshot();
  turn.active = null;
  turn.generating = false;
  turn.settled = true;
  return throughputSnapshot();
}

/** 当前投影。status: generating | ready | none。 */
export function throughputSnapshot() {
  if (!turn) {
    return {
      status: 'none', generating: false, outputTokens: null,
      durationMs: null, tokensPerSecond: null, estimated: false,
    };
  }
  const outputTokens = turn.outputTokens > 0 ? turn.outputTokens : null;
  const durationMs = turn.durationMs > 0 ? turn.durationMs : null;
  const tokensPerSecond = outputTokens != null && durationMs != null
    ? Math.round(outputTokens / (durationMs / 1000))
    : null;
  return {
    status: turn.generating ? 'generating' : tokensPerSecond != null ? 'ready' : 'none',
    generating: Boolean(turn.generating),
    outputTokens,
    durationMs,
    tokensPerSecond,
    estimated: Boolean(turn.estimated),
  };
}

/** 把投影写进 S.localUsage.lastTurn 的响应时间/速度字段。 */
export function throughputFields(snapshot = throughputSnapshot()) {
  return {
    responseDurationMs: snapshot.durationMs,
    responseOutputTokens: snapshot.outputTokens,
    responseOutputEstimated: snapshot.estimated,
    tokensPerSecond: snapshot.tokensPerSecond,
  };
}
