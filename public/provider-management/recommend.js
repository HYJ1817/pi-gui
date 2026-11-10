/* FIX-A：新建供应商的首次可信模型推荐。
 *
 * 触发条件（由调用方保证）：新建草稿、用户还没有改过选择、且拿到的是**新鲜
 * 远端结果**。缓存首屏、失败/降级结果、编辑既有服务、以及之后的刷新都不触发。
 *
 * 只使用供应商自己声明的能力证据，不按模型名/ID 猜测：
 *   - toolCalling === true     目录声明支持工具调用（最强）；
 *   - chatCapable === true     目录声明可用于聊天生成（Google generateContent、
 *                              输出模态含 text、参数表含 tools）；
 *   - toolCalling/chatCapable === false  明确不是聊天/工具模型，排除；
 *   - 两者都未知              不猜。没有任何可证实候选时明确报告“无法可靠推荐”，
 *                              把候选留给用户手动选择。
 */

export const RECOMMENDED_MODEL_LIMIT = 3;

const REASON = Object.freeze({
  tools: '目录声明支持工具调用',
  chat: '目录声明支持聊天生成',
});

export function recommendModels(models, { limit = RECOMMENDED_MODEL_LIMIT } = {}) {
  const ranked = [];
  let unknown = 0;
  for (const [index, model] of (Array.isArray(models) ? models : []).entries()) {
    const id = typeof model?.modelId === 'string' ? model.modelId.trim() : '';
    if (!id || model.source !== 'remote') continue;
    // 明确的否定证据：输出非文本、或目录声明不支持工具调用。
    if (model.toolCalling === false || model.chatCapable === false) continue;
    if (model.toolCalling === true) ranked.push({ id, index, rank: 0, reason: REASON.tools });
    else if (model.chatCapable === true) ranked.push({ id, index, rank: 1, reason: REASON.chat });
    else unknown += 1;
  }
  // 证据强的优先；同等级保持目录顺序（稳定、可解释）。
  ranked.sort((left, right) => left.rank - right.rank || left.index - right.index);
  const picks = ranked.slice(0, Math.max(0, Number.isSafeInteger(limit) ? limit : RECOMMENDED_MODEL_LIMIT));
  return {
    picks: picks.map(item => item.id),
    reasons: Object.fromEntries(picks.map(item => [item.id, item.reason])),
    candidates: ranked.length,
    unknown,
    insufficient: ranked.length === 0,
  };
}
