/* 输入区的「状态」部分：自动增高 + 发送键可用性。
 *
 * 单独成模块是为了打断一个循环依赖：attachments.js 与 messages.js 都需要
 * 在内容变化后刷新发送键，而它们又在 composer 的下游。
 * 这里只依赖 state.js，是叶子节点，谁都可以引。
 * 真正的发送动作（submit / stop）在 rpc.js —— 那是「和 pi 打交道」的事。 */

import { el, S } from './state.js';
import { modelCapability } from './model-capabilities.js';

export function imageInputBlocked() {
  return !S.modelSwitchPending && !S.switching && S.bridgeState === 'ready'
    && modelCapability(S.state?.model).capabilities.imageInput === false;
}

export function renderModelControls() {
  const canUse = S.hasProject && !S.switching && (S.bridgeState === 'ready' || S.bridgeState === 'maintenance');
  const levels = S.thinkingLevels;
  const available = !!S.state?.model && levels.some(level => level !== 'off');
  el.btnThink.disabled = !canUse || S.modelSwitchPending || !available;
  const level = S.state?.thinkingLevel;
  const label = S.modelSwitchPending ? '思考同步中…' : !available ? '思考不可用' : levels.includes(level) ? '思考 ' + level : '思考 —';
  el.thinkText.textContent = label;
  el.btnThink.title = S.modelSwitchPending ? '正在读取当前模型支持的思考等级' : !available ? 'Pi 未提供可选思考等级' : `思考强度：${level || '—'}`;
  el.btnThink.setAttribute('aria-label', el.btnThink.title);
  const imageBlocked = imageInputBlocked();
  el.btnAttach.title = imageBlocked ? '添加文件：当前模型不支持图片，普通文件仍可用' : '添加文件：图片 / PDF / Word / 文本';
  el.btnAttach.setAttribute('aria-label', el.btnAttach.title);
  // Keep the shared picker open to every ordinary file type. Image selection,
  // drop and paste are rejected together in handleFiles when explicitly false.
  el.fileInput.accept = '';
  updateSendState();
}

export function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 184, window.innerHeight * 0.24) + 'px';
}

/* 浮动输入区占据的可视高度由浏览器实测。附件、换行和窗口尺寸变化
 * 都会改变它；对话底部用同一高度留白，末条消息才不会被覆盖。 */
export function initComposerLayout() {
  const composer = el.composerBox.closest('.composer');
  const stage = composer?.closest('.stage');
  if (!composer || !stage) return;
  const sync = () => {
    const height = Math.ceil(composer.getBoundingClientRect().height);
    stage.style.setProperty('--composer-reserved-height', `${height}px`);
  };
  sync();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(sync).observe(composer);
  window.addEventListener('resize', () => {
    autoGrow();
    sync();
  });
}

export function updateSendState() {
  // 没有项目时 pi 没起来，发出去只会 503 —— 直接按住发送键
  if (!S.hasProject || S.switching || S.bridgeState !== 'ready' || S.submitting || S.modelSwitchPending || S.fallbackActive
    || (imageInputBlocked() && S.attachments.some(a => a.kind === 'image'))) {
    el.btnSend.disabled = true;
    return;
  }
  const hasText = Boolean(el.input.value.trim());
  const hasAtt = S.attachments.length > 0;
  el.btnSend.disabled = !hasText && !hasAtt;
}
