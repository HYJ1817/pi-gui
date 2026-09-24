/* 状态与用量：模型 / 思考档位 / 上下文占用 / token 与成本。
 *
 * 数据都来自 pi 的 get_state 与 get_session_stats 两个应答。
 * 这里只做「把数据摆到界面上」，不做任何请求。 */

import { el, S } from './state.js';
import { fmt } from './util.js';
import { setTitleText } from './shell.js';
import { openPop, pop } from './ui/popover.js';
import { setStreaming } from './messages.js';

export function applyState(d) {
  S.ready = true;
  S.state = d;
  if (d.model) el.modelText.textContent = d.model.name || d.model.id || '模型';
  if (d.thinkingLevel) el.thinkText.textContent = '思考 ' + d.thinkingLevel;
  if (d.sessionName) setTitleText(d.sessionName);
  el.footName.textContent = d.sessionName || '本地会话';
  setStreaming(Boolean(d.isStreaming));
}

export function applyStats(d) {
  S.stats = d;
  const ctx = d.contextUsage || {};
  const pct = typeof ctx.percent === 'number' ? ctx.percent : 0;

  el.uPct.textContent = ctx.tokens ? Math.round(pct) + '%' : '—';
  el.uCtxBar.style.width = Math.min(100, pct) + '%';
  el.uCtxBar.style.background = pct > 85 ? 'var(--err)' : pct > 65 ? 'var(--warn)' : 'var(--accent)';
  el.uNote.textContent = ctx.tokens ? `上下文 ${fmt(ctx.tokens)} / ${fmt(ctx.contextWindow)}` : '上下文 —';

  const t = d.tokens || {};
  el.uTok.textContent = t.input || t.output ? `${fmt(t.input)} / ${fmt(t.output)}` : '—';
  el.uCache.textContent = t.cacheRead ? fmt(t.cacheRead) : '—';
  el.uCost.textContent = typeof d.cost === 'number' ? '$' + d.cost.toFixed(4) : '—';

  renderCtxChip();

  // 统计面板是一次性拉取，拿到数据后回调渲染
  if (S.onStats) {
    const fn = S.onStats;
    S.onStats = null;
    fn(d);
  }
}

/* ---------- 上下文占用指示器 ---------- */

const RING_LEN = 2 * Math.PI * 15.5;

export function ctxPct() {
  const ctx = S.stats?.contextUsage;
  if (!ctx || ctx.tokens == null || !ctx.contextWindow) return null;
  return typeof ctx.percent === 'number' ? ctx.percent : Math.round((ctx.tokens / ctx.contextWindow) * 100);
}

export function renderCtxChip() {
  const pct = ctxPct();

  if (pct == null) {
    el.ctxPct.textContent = '—';
    el.ctxRing.style.strokeDashoffset = String(RING_LEN);
    el.btnCtx.className = 'ctx-chip';
    return;
  }

  const clamped = Math.max(0, Math.min(100, pct));
  el.ctxPct.textContent = Math.round(clamped) + '%';
  el.ctxRing.style.strokeDashoffset = String(RING_LEN * (1 - clamped / 100));
  el.btnCtx.className = 'ctx-chip' + (clamped > 85 ? ' hot' : clamped > 65 ? ' warn' : '');
}

export function openCtxTip() {
  const ctx = S.stats?.contextUsage;

  pop.innerHTML = '';
  const box = document.createElement('div');

  if (!ctx || ctx.tokens == null || !ctx.contextWindow) {
    box.innerHTML = '<div class="tip-head">背景信息窗口:</div><div class="tip-dim">暂无数据</div>';
  } else {
    const pct = Math.round(ctxPct());
    const left = Math.max(0, 100 - pct);
    const head = document.createElement('div');
    head.className = 'tip-head';
    head.textContent = '背景信息窗口:';

    const big = document.createElement('div');
    big.className = 'tip-big';
    big.textContent = `${pct}% 已用 (剩余 ${left}%)`;

    const dim = document.createElement('div');
    dim.className = 'tip-dim';
    dim.textContent = `已用 ${fmt(ctx.tokens)} 标记, 共 ${fmt(ctx.contextWindow)}`;

    box.append(head, big, dim);
  }

  pop.appendChild(box);
  openPop(el.btnCtx, { tip: true });
}

/* ---------- 可用模型 / 思考档位 ---------- */

export function onModels(d) {
  S.models = Array.isArray(d) ? d : d?.models || [];
}

export function onThinkingLevels(d) {
  S.thinkingLevels = Array.isArray(d) ? d : d?.levels || [];
}
