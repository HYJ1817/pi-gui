/* 「回到底部」悬浮按钮。
 *
 * 铁律：只滚**传进来的那个**滚动容器。Classic 是 #stream，Runtime 是
 * .rtc-output；这里没有 document.documentElement / window 的任何滚动调用，
 * 所以切会话、开分栏、多个工作区同时更新时都不会滚错地方。
 *
 * 可见性用「远底 160px 出现 / 近底 8px 消失」两条线，而不是同一个阈值：
 * 同一条线会在边界上反复开关，看起来像闪。判据与 messages.js /
 * runtime-display.js 的 follow 阈值一致（160px）。
 *
 * 运行中显示复用 thinking-dots 的四点/三点动画；非运行态显示下箭头。
 * 悬停时动画切箭头是纯 CSS（不重建节点，所以按钮尺寸不会跳）。点击后
 * 进入短暂的 follow 状态：流式内容继续追加时，超时点会再补一次到底，
 * 不会停在旧底部。用户一滚轮 / 触摸 / 按方向键就立刻退出 follow。
 */

import { startThinkingDotsCycle, stopThinkingDotsCycle, thinkingDots } from './thinking-dots.js';

const AWAY_PX = 160;
const BACK_PX = 8;
const FOLLOW_MS = 900;

export function isAwayFromBottom(node, away = AWAY_PX) {
  if (!node) return false;
  return node.scrollHeight - node.scrollTop - node.clientHeight > away;
}

function reducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* jsdom（以及极老的浏览器）没有 rAF；退化成 0ms 计时器，行为一致。 */
const raf = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame
  : cb => setTimeout(cb, 0);
const cancelRaf = typeof cancelAnimationFrame === 'function'
  ? cancelAnimationFrame
  : id => clearTimeout(id);

export function createScrollButton({ host, scroller, running = () => false, label = '回到最新消息' } = {}) {
  if (!host || !scroller) return { update() {}, setRunning() {}, dispose() {}, element: null };

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'scroll-bottom';
  button.dataset.running = 'false';
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  button.setAttribute('aria-hidden', 'true');
  button.tabIndex = -1;

  const dots = thinkingDots('scroll-bottom-dots', 'triangle');
  const arrow = document.createElement('span');
  arrow.className = 'scroll-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v13m-5.5-5.5L12 18l5.5-5.5"/></svg>';
  button.append(dots, arrow);
  host.appendChild(button);

  let alive = true;
  let isRunning = false;
  let following = false;
  let followTimer = null;
  let pendingFrame = 0;
  let observer = null;

  const clearFollow = () => {
    following = false;
    if (followTimer) { clearTimeout(followTimer); followTimer = null; }
  };

  function sync() {
    if (!alive) return;
    const metricsAway = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    /* 两段阈值：已在显示时允许更贴近底部才消失，避免边界抖动。 */
    const show = button.classList.contains('is-visible') ? metricsAway > BACK_PX : metricsAway > AWAY_PX;
    button.classList.toggle('is-visible', show);
    button.setAttribute('aria-hidden', String(!show));
    button.tabIndex = show ? 0 : -1;
    const nextRunning = running() === true;
    if (nextRunning !== isRunning) setRunning(nextRunning);
  }

  function schedule() {
    if (pendingFrame || !alive) return;
    pendingFrame = raf(() => {
      pendingFrame = 0;
      sync();
    });
  }

  function setRunning(value) {
    const next = value === true;
    if (next === isRunning) return;
    isRunning = next;
    button.dataset.running = String(next);
    if (next) startThinkingDotsCycle(dots, { immediate: true, restart: true });
    else stopThinkingDotsCycle(dots);
  }

  function onClick() {
    const bottom = scroller.scrollHeight;
    if (reducedMotion()) {
      clearFollow();
      scroller.scrollTop = bottom;
      schedule();
      return;
    }
    clearFollow();
    following = true;
    try { scroller.scrollTo({ top: bottom, behavior: 'smooth' }); }
    catch { scroller.scrollTop = bottom; }
    followTimer = setTimeout(() => {
      followTimer = null;
      following = false;
      /* 平滑滚动期间可能又追加了内容：到底时补一次，别停在旧底部。 */
      scroller.scrollTop = scroller.scrollHeight;
      schedule();
    }, FOLLOW_MS);
  }

  function onScroll() { schedule(); }

  function onUserIntent() { clearFollow(); schedule(); }

  button.addEventListener('click', onClick);
  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('wheel', onUserIntent, { passive: true });
  scroller.addEventListener('touchstart', onUserIntent, { passive: true });
  scroller.addEventListener('keydown', onUserIntent);
  window.addEventListener('resize', schedule);
  if (typeof MutationObserver === 'function') {
    observer = new MutationObserver(schedule);
    observer.observe(scroller, { childList: true, subtree: true, characterData: true });
  }
  let resizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(scroller);
    resizeObserver.observe(host);
  }

  setRunning(running() === true);
  schedule();

  return {
    element: button,
    update: schedule,
    setRunning,
    dispose() {
      alive = false;
      clearFollow();
      if (pendingFrame) cancelRaf(pendingFrame);
      pendingFrame = 0;
      observer?.disconnect();
      resizeObserver?.disconnect();
      button.removeEventListener('click', onClick);
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('wheel', onUserIntent);
      scroller.removeEventListener('touchstart', onUserIntent);
      scroller.removeEventListener('keydown', onUserIntent);
      window.removeEventListener('resize', schedule);
      stopThinkingDotsCycle(dots);
      button.remove();
    },
  };
}
