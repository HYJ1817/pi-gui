/* Runtime 执行时间线的**纯数据投影**（无 DOM、无 I/O）。
 *
 * 它解决的是一件事：Runtime 原来只有聚合正文与扁平工具状态，无法证明
 * 「计划、思考、工具、正文」谁先发生。这里按 Pi 的真实消息/事件顺序
 * 投影出有界 block 列表；视图只按这个列表渲染，**不做 DOM 重排来伪造顺序**。
 *
 * 两条输入路径共用同一套 block 形状：
 *   1. 实时：runtime-store.js 直接消费已通过 owner/eventSequence 校验的事件；
 *   2. 历史：session-history.js 把原生 JSONL 的 message body 交给
 *      timelineFromMessages()，get_messages 恢复也走同一个纯函数。
 *
 * 安全边界：block 只保留用户可读的最小字段。工具 args / result 正文、
 * 环境变量、凭据、原始输出一律不进入投影。计划只保留 plan-model.js
 * 已白名单化的任务字段；思考只保留文本本身。
 */

import { planFromToolEntry, PLAN_TOOL_NAME } from './plan-model.js';

export const MAX_BLOCKS = 240;
export const MAX_TIMELINE_CHARS = 1024 * 1024;
export const MAX_BLOCK_TEXT = 48 * 1024;
export const MAX_THINKING_TEXT = 64 * 1024;
export const MAX_USER_TEXT = 16 * 1024;
export const MAX_TOOLS_PER_GROUP = 100;
export const MAX_CONTENT_SEGMENTS = 100;

const SAFE_TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/;

export function safeToolName(value) {
  return typeof value === 'string' && SAFE_TOOL_NAME.test(value) ? value : 'unknown_tool';
}

export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('\n');
}

export function contentThinking(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'thinking' && typeof part.thinking === 'string')
    .map(part => part.thinking).join('\n\n');
}

/**
 * 把 Pi 的权威 content 展开成按真实顺序排列的正文/Thinking 段。
 * 连续的同类 part 合并；中间夹了别的类型就另起一段。工具调用不在这里
 * 生成 block —— 它的可视位置由真实 tool_execution_* 事件决定，message_end
 * 不能替尚未执行的工具伪造时间线节点。
 *
 * 上限与有界时间线一致：content 再长也最多保留 100 段。
 */
export function contentSegments(content) {
  const out = [];
  const push = (kind, value) => {
    if (typeof value !== 'string' || !value) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) {
      last.text += (kind === 'thinking' ? '\n\n' : '\n') + value;
    } else if (out.length < MAX_CONTENT_SEGMENTS) {
      out.push({ kind, text: value });
    }
  };
  if (typeof content === 'string') {
    if (content) out.push({ kind: 'assistant', text: content });
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'thinking') push('thinking', part.thinking);
    else if (part.type === 'text') push('assistant', part.text);
  }
  return out;
}

/** 与 runtime-store 的正文上限同一条策略：按字节留末尾，不切出半个字符。 */
export function boundText(value, limit) {
  const text = String(value ?? '');
  if (!text) return { text: '', truncated: false };
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return { text, truncated: false };
  return {
    text: new TextDecoder().decode(bytes.slice(-limit)).replace(/^�+/, ''),
    truncated: true,
  };
}

export function blockChars(block) {
  if (!block) return 0;
  if (block.kind === 'user' || block.kind === 'assistant' || block.kind === 'thinking') return block.text.length;
  if (block.kind === 'tools') return block.tools.length * 24;
  if (block.kind === 'plan') {
    return (block.plan?.tasks || []).reduce((sum, task) => sum + task.title.length + task.id.length, 0)
      + (block.plan?.explanation?.length || 0);
  }
  return 0;
}

/** 有界化：保留最近 block，并给出明确的 truncated 标记。 */
export function boundTimeline(blocks, {
  maxBlocks = MAX_BLOCKS,
  maxChars = MAX_TIMELINE_CHARS,
} = {}) {
  const list = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  let truncated = false;
  let chars = list.reduce((sum, block) => sum + blockChars(block), 0);
  while (list.length > maxBlocks || chars > maxChars) {
    if (list.length <= 1) break;
    const removed = list.shift();
    chars -= blockChars(removed);
    truncated = true;
  }
  return { blocks: list, truncated };
}

function toolState(result) {
  if (!result) return 'incomplete';
  return result.isError === true ? 'error' : 'success';
}

function durationOf(assistant, result) {
  const start = Number.isFinite(assistant?.timestamp) ? assistant.timestamp : null;
  const end = Number.isFinite(result?.timestamp) ? result.timestamp : null;
  if (start === null || end === null || end < start) return null;
  return Math.min(end - start, 24 * 60 * 60 * 1000);
}

/**
 * 从 Pi 原生消息投影执行时间线。消息顺序就是记录顺序；同一个 assistant
 * message 内部按 content part 的顺序展开，因此「文本 / 思考 / 工具」的相对
 * 位置来自真实内容，而不是渲染时猜的类别排序。
 *
 * messageMeta 可选，与 messages 一一对应：{ messageId, userIndex }。
 * 它只服务于历史搜索定位，不参与内容判断。
 */
export function timelineFromMessages(messages, { messageMeta = null } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const results = new Map();
  for (const message of list) {
    if (message?.role !== 'toolResult' || typeof message.toolCallId !== 'string') continue;
    results.set(message.toolCallId, message);
  }

  const blocks = [];
  let id = 0;
  let userSequence = 0;
  /* V1 记录没有运行边界，只能按用户消息归并（legacyTurnPlan）。带 turnId 的
   * 计划来自扩展在真实新回合写入的 details，可跨 steer 的用户消息归并到同一张
   * 卡，同时不会把两个真实任务合并。两种记录可以同时存在。 */
  let legacyTurnPlan = null;
  const planByTurnId = new Map();
  const add = block => {
    block.id = 'h' + (++id);
    blocks.push(block);
    return block;
  };

  for (let index = 0; index < list.length; index++) {
    const message = list[index];
    if (!message || typeof message !== 'object') continue;
    const meta = messageMeta?.[index] || {};

    if (message.role === 'user') {
      const userIndex = Number.isInteger(meta.userIndex) ? meta.userIndex : userSequence;
      userSequence += 1;
      const bounded = boundText(contentText(message.content), MAX_USER_TEXT);
      if (!bounded.text) continue;
      add({
        kind: 'user',
        text: bounded.text,
        truncated: bounded.truncated,
        messageId: typeof meta.messageId === 'string' ? meta.messageId : null,
        userIndex,
      });
      legacyTurnPlan = null;
      continue;
    }

    if (message.role !== 'assistant') continue;

    /* 连续的同类型 content part 合并；一旦中间夹了别的类型（工具/思考/正文），
     * 后面的正文必须另起一段，不能并回更早的同类 block —— 那会改变真实顺序。 */
    const owned = [];
    const seenTools = new Set();
    const content = Array.isArray(message.content) ? message.content : [];
    let kind = null, current = null;

    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'thinking' && typeof part.thinking === 'string') {
        if (kind !== 'thinking') {
          current = add({ kind: 'thinking', text: '', state: 'complete', truncated: false });
          owned.push(current);
          kind = 'thinking';
        }
        const next = current.text + (current.text ? '\n\n' : '') + part.thinking;
        const bounded = boundText(next, MAX_THINKING_TEXT);
        current.text = bounded.text;
        current.truncated = current.truncated || bounded.truncated;
        continue;
      }
      if (part.type === 'text' && typeof part.text === 'string') {
        if (kind !== 'assistant') {
          current = add({ kind: 'assistant', text: '', state: 'complete', truncated: false });
          owned.push(current);
          kind = 'assistant';
        }
        const next = current.text + (current.text ? '\n' : '') + part.text;
        const bounded = boundText(next, MAX_BLOCK_TEXT);
        current.text = bounded.text;
        current.truncated = current.truncated || bounded.truncated;
        continue;
      }
      if (part.type !== 'toolCall' || typeof part.id !== 'string' || seenTools.has(part.id)) continue;
      seenTools.add(part.id);
      const name = safeToolName(part.name);
      const result = results.get(part.id) || null;
      if (name === PLAN_TOOL_NAME) {
        const plan = planFromToolEntry({ name: PLAN_TOOL_NAME, args: part.arguments, details: result?.details });
        if (!plan) continue;
        /* 有 turnId 时按真实运行归并；没有时退回用户回合，并明确标记该段
         * 归属无法确认。计划卡的位置取该任务第一次真实调用。 */
        if (plan.turnId) {
          let block = planByTurnId.get(plan.turnId);
          if (!block && legacyTurnPlan) {
            /* 同一用户回合内从旧记录升级到带 turnId 的更新，沿用原卡。 */
            block = legacyTurnPlan;
            legacyTurnPlan = null;
            planByTurnId.set(plan.turnId, block);
          }
          if (block) block.plan = plan;
          else { block = add({ kind: 'plan', plan }); planByTurnId.set(plan.turnId, block); owned.push(block); }
        } else if (legacyTurnPlan) {
          legacyTurnPlan.plan = plan;
        } else {
          legacyTurnPlan = add({ kind: 'plan', plan });
          owned.push(legacyTurnPlan);
        }
        kind = 'plan';
        continue;
      }
      if (kind !== 'tools') {
        current = add({ kind: 'tools', tools: [], truncated: false });
        owned.push(current);
        kind = 'tools';
      }
      if (current.tools.length >= MAX_TOOLS_PER_GROUP) { current.truncated = true; continue; }
      current.tools.push({
        id: 't' + (id + 1) + '-' + current.tools.length,
        name,
        state: toolState(result),
        waiting: false,
        durationMs: durationOf(message, result),
      });
    }

    /* 一条 assistant 消息的真实终态；只在历史记录里存在可信依据时才标注。 */
    const state = message.stopReason === 'aborted' ? 'interrupted'
      : message.stopReason === 'error' || message.errorMessage ? 'error' : 'complete';
    for (const block of owned) {
      if (block.kind === 'assistant') block.state = state;
      if (block.kind === 'thinking' && state === 'interrupted') block.state = 'interrupted';
    }
  }

  const bounded = boundTimeline(blocks);
  /* 给历史 UI 一个可解释的边界状态：verified 表示这张卡的更新都带真实
   * turnId；unknown 表示只有旧记录，按用户消息分组；mixed 表示两者混用。 */
  const plans = bounded.blocks.filter(block => block.kind === 'plan');
  const verified = plans.filter(block => typeof block.plan?.turnId === 'string' && block.plan.turnId).length;
  const planBoundary = !plans.length ? null : verified === plans.length ? 'verified' : verified ? 'mixed' : 'unknown';
  return { ...bounded, planBoundary };
}

/** 实时 store 用的小工具：把一个 block 的文本改掉并同步 truncated 标记。 */
export function setBlockText(block, text, limit) {
  const bounded = boundText(text, limit);
  block.text = bounded.text;
  block.truncated = block.truncated || bounded.truncated;
  return block;
}
