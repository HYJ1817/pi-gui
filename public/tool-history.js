/* 从 get_messages 的消息数组重建 Tool Timeline。
 *
 * ---------- 真实结构（实测 11 个会话 / 125 次工具调用，不是推测） ----------
 *
 * get_messages 返回的是 pi 的 AgentMessage[]，和会话 jsonl 里 `message` 记录同源：
 *
 *   { role:'user',      content:[{type:'text'|'image', …}] }
 *   { role:'assistant', content:[{type:'thinking'|'text'|'toolCall', …}], timestamp, stopReason }
 *   { role:'toolResult', toolCallId, toolName, content:[{type:'text'}], details, isError, timestamp }
 *
 * 关键结论：
 *   1. **toolResult 是独立的一条消息**，不在 assistant.content 里；
 *   2. 配对键是 `toolResult.toolCallId === toolCall.id`（实测 0 个孤儿）；
 *   3. 一条 assistant 消息可以带**多个** toolCall，后面跟同样多条 toolResult；
 *   4. **顺序是可靠的** —— assistant(toolCall) 紧跟着它的 toolResult(s)，
 *      所以「文本 → 工具 → 文本」这种交错能忠实还原（§13）。
 *
 * ---------- 为什么是纯函数 ----------
 *
 * 配对规则有好几种退化情况（缺 result / 孤儿 result / 未知 role），
 * 放在 DOM 循环里写就没法单独测了。这里只产出「渲染计划」，
 * 由 messages.js 消费 —— 计划和渲染分开，测试才能钉住配对本身。 */

import { entryFromHistory } from './tool-model.js';

/** assistant 消息里的 toolCall 部分。 */
function callsOf(msg) {
  const c = msg?.content;
  if (!Array.isArray(c)) return [];
  return c.filter((x) => x && x.type === 'toolCall');
}

/**
 * 把消息数组整理成渲染计划。
 *
 * 计划项：
 *   { kind:'user',      message }
 *   { kind:'assistant', message }            ← 正文由 messages.js 的 rebuildAssistant 画
 *   { kind:'tools',     entries:[ToolEntry] } ← 一组工具（§12：一组 = 一条 assistant 消息的 toolCall）
 *
 * @returns {Array<{kind:string}>}
 */
export function planHistory(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];

  /* 先收一遍「哪些 toolCallId 有对应的 toolCall」。
   * 用途是识别孤儿 result：它的 id 不在这个集合里，说明配对不上，
   * 得在**它自己的位置**降级显示，而不是被静默吃掉（§10）。 */
  const known = new Set();
  for (const m of list) {
    if (m?.role !== 'assistant') continue;
    for (const c of callsOf(m)) if (c.id) known.add(c.id);
  }

  /* toolCallId → toolResult。同一个 id 出现多次时取第一条 —— 理论上不该发生，
   * 真发生了也别让后面的覆盖掉已经配对好的。 */
  const results = new Map();
  for (const m of list) {
    if (m?.role !== 'toolResult') continue;
    const id = m.toolCallId;
    if (id && !results.has(id)) results.set(id, m);
  }

  for (const m of list) {
    if (!m || typeof m !== 'object') continue;

    if (m.role === 'user') {
      out.push({ kind: 'user', message: m });
      continue;
    }

    if (m.role === 'toolResult') {
      /* 正常路径下它已经被上面的 assistant 分支消费掉了；走到这里说明是孤儿。
       * 造一条只有 result 的 entry：名字用 toolResult.toolName，参数是空的。
       * 它不该消失 —— 消失会让用户以为「什么都没发生」。 */
      if (!m.toolCallId || known.has(m.toolCallId)) continue;
      out.push({ kind: 'tools', entries: [entryFromHistory(null, m, null)] });
      continue;
    }

    if (m.role === 'assistant') {
      out.push({ kind: 'assistant', message: m });

      const calls = callsOf(m);
      if (!calls.length) continue;

      /* 这条 assistant 消息的 toolCall 全部挂在它自己后面，顺序不变。
       * 缺 result 的会拿到 status:'incomplete'（entryFromHistory 内部判定）。 */
      const entries = calls.map((c) => entryFromHistory(c, results.get(c.id) || null, m));
      out.push({ kind: 'tools', entries });
      continue;
    }

    /* 未知 role（pi 支持扩展注册自定义消息类型）—— 跳过，不报错。
     * 为一条不认识的消息把整段历史重建搞崩，代价远大于收益。 */
  }

  return out;
}
