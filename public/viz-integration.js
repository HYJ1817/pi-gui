/* 消息内交互图表卡片事件代理与生命周期集成。
 *
 * 采用事件委托机制监听所有 .viz-card 内的交互：
 * 1. [data-viz-open]：校验并提取原始 JSON，绑定当前会话身份打开右侧面板。
 * 2. [data-viz-toggle-raw]：展开/收起原始 JSON 代码块，确保开发者随时可查验数据。
 */

import { parseVizData } from './viz-schema.js';
import { openVizPanel } from './viz-panel.js';
import { S } from './state.js';
import { gitConversationScope } from './api.js';

let initialized = false;

export function handleVizCardClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;

  // 1. 打开可视化面板
  const openBtn = target.closest('[data-viz-open]');
  if (openBtn) {
    event.preventDefault();
    event.stopPropagation();

    const card = openBtn.closest('.viz-card');
    if (!card) return;

    const rawEl = card.querySelector('.viz-raw-code code');
    if (!rawEl) return;

    const raw = rawEl.textContent || '';
    const res = parseVizData(raw);
    if (!res.ok) {
      console.warn('可视化数据解析失败:', res.error);
      return;
    }

    // 绑定当前会话与真实消息 DOM 宿主：
    // Classic 消息为 article.msg.assistant（或 article.msg）；
    // Runtime 为带有 [data-history-message-id] 的消息行，或 .rtc-output-block 输出块
    const messageNode = card.closest('article.msg.assistant, article.msg, [data-history-message-id], .rtc-output-block');
    if (!messageNode || !messageNode.isConnected) {
      console.warn('可视化卡片没有有效的消息宿主或已脱离界面');
      return;
    }

    openVizPanel(res.data, {
      triggerId: openBtn.id || null,
      sourceNode: messageNode,
      cardNode: card,
    });
    return;
  }

  // 2. 切换展开原始 JSON 代码块
  const toggleBtn = target.closest('[data-viz-toggle-raw]');
  if (toggleBtn) {
    event.preventDefault();
    event.stopPropagation();

    const card = toggleBtn.closest('.viz-card');
    if (!card) return;

    const rawCode = card.querySelector('.viz-raw-code');
    if (!rawCode) return;

    const isHidden = Boolean(rawCode.hidden);
    rawCode.hidden = !isHidden;
    toggleBtn.setAttribute('aria-expanded', String(isHidden));
    toggleBtn.classList.toggle('is-active', isHidden);
  }
}

export function initVizIntegration() {
  if (initialized) return;
  initialized = true;
  document.addEventListener('click', handleVizCardClick);
}
