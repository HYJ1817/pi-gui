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

    // 绑定当前会话与消息上下文
    const messageNode = card.closest('[data-history-message-id], .message[data-id]');
    const messageId = messageNode?.dataset?.historyMessageId || messageNode?.dataset?.id || null;
    const sessionId = gitConversationScope() || S.state?.sessionId || null;

    openVizPanel(res.data, {
      triggerId: openBtn.id || null,
      sessionId,
      workspaceGeneration: S.workspaceGeneration,
      messageId,
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
