/* Claude 风格的「四点折叠」执行指示。
 *
 * ---------- 它是什么 ----------
 *
 * 四个珊瑚色小点排成 2x2 方阵；执行期间方阵交替沿两条对角线收拢、再从
 * 拐角摊开（详见 thinking-dots.css 顶部的时间轴）。不是「三个点一起上下跳」
 * 的通用 loader —— 四个点各有自己的时间线，相位错开。
 *
 * ---------- 为什么由 JS 生成结构 ----------
 *
 * 聊天流（messages.js 的 `Pi 正在处理…`）和并行会话头
 * （runtime-conversation.js 的 `.rtc-state`）都要用同一个指示器。点数、类名、
 * aria 只在这里定义一份；调用方只负责把它插到自己的状态位里，以后调点数不会
 * 漏改一处。
 *
 * 纯装饰：真正的状态信息由旁边的文字承载（`.working` 的文案、`.rtc-state` 的
 * `role=status`），所以整组点对读屏隐藏，不产生四个空的朗读项。 */

export const THINKING_DOT_COUNT = 4;

export function thinkingDots(className = '') {
  const node = document.createElement('span');
  node.className = className ? `thinking-dots ${className}` : 'thinking-dots';
  node.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < THINKING_DOT_COUNT; i++) node.appendChild(document.createElement('span'));
  return node;
}
