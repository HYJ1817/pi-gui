/* Claude 风格执行指示：四点方阵 / 三点轨道。
 *
 * 两个形态**不是**由工具起停临时决定的。按录屏逐帧测量，它们是在一条长动画里
 * 自动交替的：
 *
 *   开场  三点轨道约 5.5s（录屏从一段三点轨道的尾部开始）
 *   之后  四点方阵约 15s → 三点轨道约 26s → 四点方阵约 15s → …
 *
 * 所以只要指示器可见，就按这个节奏自己走；「有没有工具在跑」只决定它显不显示，
 * 不再决定当前是哪个形态。切换时先收成一个点、再展开成另一套（CSS 注释里有
 * 完整的帧时间轴）。
 *
 * 为什么切换要绕这么一圈：CSS 动画没法从任意中间帧无缝接到另一条时间线，
 * 直接换 animation-name 会跳。所以这里只在**循环边界**动手 —— 等当前形态
 * 走完一圈（animationiteration），画面回到该形态的 0% 姿态，再挂上
 * data-transition；过渡关键帧的 0% 就是这个姿态，接缝不可见。过渡结束
 * （animationend）后换回目标形态的无限动画，目标形态也从 0% 开始，仍然对得上。
 *
 * 每个点组在自己的 WeakMap 里存相位、计时器和监听器：聊天流、并行会话卡片
 * 各有一份，切换会话或另一条会话更新不会碰这个点组。jsdom / reduced-motion /
 * 隐藏节点没有可运行的动画时，直接落相位，不排队。
 */

export const THINKING_DOT_COUNT = 4;

const PHASES = new Set(['square', 'triangle']);
const state = new WeakMap();

/* 录屏实测节奏：先露出三点轨道的尾段，然后方阵、三点长时间交替。
 * 15s / 26s 看起来很长，但录屏里的状态计时器（18m 2s → 18m 31s）证明它就是
 * 这个速度，不是播放器快进。 */
const AUTO_CYCLE = [
  { phase: 'triangle', hold: 5500 },
  { phase: 'square', hold: 15000 },
  { phase: 'triangle', hold: 26000 },
];

function nextStep(step) {
  return step === 0 ? 1 : step === 1 ? 2 : 1;
}

function reducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 造一个点组。phase 是初始形态；调用方通常直接按当前执行状态给。 */
export function thinkingDots(className = '', phase = 'square') {
  const node = document.createElement('span');
  node.className = className ? `thinking-dots ${className}` : 'thinking-dots';
  node.dataset.phase = PHASES.has(phase) ? phase : 'square';
  node.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < THINKING_DOT_COUNT; i++) node.appendChild(document.createElement('span'));
  return node;
}

/**
 * 请求把点组切到某个形态。
 *
 * 有动画在跑时不会立刻改：先记下目标，等当前循环走完再过渡（最多 1.25s / 2s）。
 * 等待或过渡期间目标又变回去，就作废这次切换，短暂的工具调用不会让动画闪。
 * 没有动画可等（jsdom、reduced-motion、隐藏节点）时直接落相位。
 *
 * immediate 用于「刚从隐藏变为可见」：旧画面已经断掉，没有姿态需要保留，
 * 直接落到当前状态，不要先播一段过时的形态。
 */
export function setThinkingDotsPhase(node, phase, { immediate = false } = {}) {
  if (!node || !PHASES.has(phase)) return;
  const st = stateOf(node);

  if (immediate) { applyPhase(node, st, phase); return; }

  if (phase === st.phase) {
    /* 最新的请求就是当前形态：撤掉还没开始的等待；过渡中的目标也一并清掉。 */
    if (st.transitioning) st.target = null;
    else cancelWait(node, st);
    return;
  }

  st.target = phase;
  if (st.transitioning || st.waiting) return;
  if (!canAnimate(node)) { applyPhase(node, st, phase); return; }
  waitForBoundary(node, st);
}

/**
 * 让点组按录屏节奏自动交替两套形态；重复调用不会重置进度。
 *
 * restart 用于「刚显示 / 切到另一条会话」：从开场形态重新开始，不接着上一条
 * 会话或上一次显示的进度。immediate 让开场形态直接落位，避免先闪一下方阵。
 * cycle 参数只给测试注入更短的节奏，生产调用不传。
 */
export function startThinkingDotsCycle(node, { immediate = false, restart = false, cycle = AUTO_CYCLE } = {}) {
  if (!node) return;
  const st = stateOf(node);
  if (st.auto && !restart) return;
  stopThinkingDotsCycle(node);
  const first = cycle[0];
  if (!first) return;
  st.auto = { step: 0, cycle, timer: null };
  /* 初始形态直接落位：节点刚创建 / 刚从隐藏恢复，没有需要保留的旧姿态。 */
  if (immediate || !canAnimate(node)) applyPhase(node, st, first.phase);
  else setThinkingDotsPhase(node, first.phase);
  if (reducedMotion()) return;
  armCycle(node, st);
}

/** 停下自动交替；隐藏、卸载或进入 reduced-motion 时调用。 */
export function stopThinkingDotsCycle(node) {
  if (!node) return;
  const st = state.get(node);
  if (!st?.auto) return;
  if (st.auto.timer) clearTimeout(st.auto.timer);
  st.auto = null;
}

function armCycle(node, st) {
  const auto = st.auto;
  if (!auto) return;
  const entry = auto.cycle[auto.step];
  if (!entry) return;
  auto.timer = setTimeout(() => {
    auto.timer = null;
    if (st.auto !== auto) return;
    /* 节点已被移出 / 已隐藏 / 用户切到 reduced-motion：不要再改相位。 */
    if (!node.isConnected || node.hidden || reducedMotion()) {
      stopThinkingDotsCycle(node);
      return;
    }
    auto.step = nextStep(auto.step);
    const next = auto.cycle[auto.step];
    if (!next) { stopThinkingDotsCycle(node); return; }
    setThinkingDotsPhase(node, next.phase);
    armCycle(node, st);
  }, entry.hold);
}

function stateOf(node) {
  let st = state.get(node);
  if (st) return st;
  st = {
    phase: node.dataset.phase === 'triangle' ? 'triangle' : 'square',
    target: null,
    waiting: false,
    transitioning: false,
    boundary: null,
    end: null,
    auto: null,
  };
  state.set(node, st);
  return st;
}

/* 真的在跑 CSS 动画才值得等边界。jsdom 没有 getAnimations，直接落相位；
 * display:none / reduced-motion 下浏览器也不返回活动动画。 */
function canAnimate(node) {
  const dot = node.firstElementChild;
  if (!node.isConnected || !dot || typeof dot.getAnimations !== 'function') return false;
  return dot.getAnimations().length > 0;
}

function waitForBoundary(node, st) {
  const dot = node.firstElementChild;
  if (!dot) { applyPhase(node, st, st.target); return; }
  st.waiting = true;
  const onBoundary = (event) => {
    if (event.target !== dot) return;
    dot.removeEventListener('animationiteration', onBoundary);
    st.boundary = null;
    st.waiting = false;
    const target = st.target;
    if (!target || target === st.phase) { st.target = null; return; }
    morph(node, st, target);
  };
  st.boundary = onBoundary;
  dot.addEventListener('animationiteration', onBoundary);
}

function cancelWait(node, st) {
  const dot = node.firstElementChild;
  if (st.boundary && dot) dot.removeEventListener('animationiteration', st.boundary);
  st.boundary = null;
  st.waiting = false;
  st.target = null;
}

function morph(node, st, target) {
  const dot = node.firstElementChild;
  if (!dot) { applyPhase(node, st, target); return; }
  cancelWait(node, st);
  st.transitioning = true;
  st.phase = target;
  st.target = null;
  node.dataset.phase = target;
  node.dataset.transition = target === 'triangle' ? 'to-triangle' : 'to-square';

  const onEnd = (event) => {
    if (event.target !== dot) return;
    dot.removeEventListener('animationend', onEnd);
    st.end = null;
    st.transitioning = false;
    delete node.dataset.transition;
    const next = st.target;
    st.target = null;
    if (!next || next === st.phase) return;
    /* 刚结束的过渡把画面留在了目标形态的 0%，正好是反向过渡的起点，
     * 所以状态如果又变回去，可以立刻往回走，不必再等一整圈。 */
    morph(node, st, next);
  };
  st.end = onEnd;
  dot.addEventListener('animationend', onEnd);
}

function applyPhase(node, st, phase) {
  cancelWait(node, st);
  const dot = node.firstElementChild;
  if (st.end && dot) dot.removeEventListener('animationend', st.end);
  st.end = null;
  st.transitioning = false;
  st.phase = phase;
  node.dataset.phase = phase;
  delete node.dataset.transition;
}
