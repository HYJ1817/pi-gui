/* 状态与用量：模型 / 思考档位 / 上下文占用 / token 与成本 / 远端额度。
 *
 * 两层数据模型（P21）：
 *   - LocalUsage：来自 Pi/模型返回的真实 usage（session total、当前 turn、context 占用、cache）
 *   - RemoteQuota：来自各 Provider 稳定官方额度接口，无标准接口一律 unsupported
 *
 * 字段没有证据就 null；0 只能表示真实 0。
 */

import { el, S } from './state.js';
import { fmt } from './util.js';
import { setTitleText } from './shell.js';
import { openPop, pop } from './ui/popover.js';
import { setStreaming } from './messages.js';

/* ---------- 辅助工具 ---------- */

/** 格式化金额或额度数值 */
export function fmtCurrency(amount, currency = 'USD') {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
  const prefix = currency === 'CNY' ? '¥' : '$';
  return prefix + amount.toFixed(4);
}

/** 格式化简短金额（保留 2 位小数） */
export function fmtBalanceShort(amount, currency = 'USD') {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
  const prefix = currency === 'CNY' ? '¥' : '$';
  return prefix + amount.toFixed(2);
}

/** 从模型名称或 ID 反推 providerId */
function resolveProvider(modelObj) {
  if (!modelObj) return null;
  if (typeof modelObj.provider === 'string' && modelObj.provider) return modelObj.provider;
  const rawId = modelObj.id || modelObj.name;
  if (typeof rawId === 'string') {
    // 查 S.models 列表
    const found = (S.models || []).find((m) => m.id === rawId || m.name === rawId);
    if (found && found.provider) return found.provider;
    // 兼容 provider/model 命名
    if (rawId.includes('/')) {
      return rawId.split('/')[0];
    }
  }
  return null;
}

/* ---------- 远端额度 (Remote Quota) 管理与拉取 ---------- */

/**
 * 拉取指定 Provider 的远端额度。
 * 防竞态：利用 S.quotaEpoch 与当前 Provider 核验，丢弃过期的异步应答。
 */
export async function syncRemoteQuota(providerId, { force = false } = {}) {
  if (!providerId) {
    S.currentProviderId = null;
    S.remoteQuota = null;
    renderRemoteQuota();
    return;
  }

  S.currentProviderId = providerId;
  const epoch = ++S.quotaEpoch;
  S.quotaLoading = true;
  renderRemoteQuota();

  try {
    const url = `/api/quota/${encodeURIComponent(providerId)}${force ? '?force=1' : ''}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => null);

    // 过期检查：如果已切走或有了更新的请求，直接丢弃
    if (epoch !== S.quotaEpoch || S.currentProviderId !== providerId) {
      return;
    }

    S.quotaLoading = false;
    if (data && data.ok && data.quota) {
      S.remoteQuota = data.quota;
    } else {
      S.remoteQuota = {
        providerId,
        status: 'error',
        balance: null,
        windows: null,
        rateLimit: null,
        resetAt: null,
        source: 'none',
        updatedAt: new Date().toISOString(),
        message: data?.error || '无法获取额度信息',
      };
    }
  } catch (err) {
    if (epoch !== S.quotaEpoch || S.currentProviderId !== providerId) return;
    S.quotaLoading = false;
    S.remoteQuota = {
      providerId,
      status: 'unavailable',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: 'none',
      updatedAt: new Date().toISOString(),
      message: '网络异常或服务未响应',
    };
  }

  renderRemoteQuota();
  // 若 Popover 展开中，重新渲染弹层
  if (pop && pop.querySelector('.tip-quota-section')) {
    openCtxTip();
  }
}

/** 渲染侧栏 Remote Quota 摘要 */
export function renderRemoteQuota() {
  if (!el.uQuota) return;

  if (S.quotaLoading) {
    el.uQuota.textContent = '查询中…';
    return;
  }

  const q = S.remoteQuota;
  if (!q) {
    el.uQuota.textContent = '—';
    return;
  }

  if (q.status === 'ok') {
    if (q.balance && typeof q.balance.amount === 'number') {
      el.uQuota.textContent = fmtBalanceShort(q.balance.amount, q.balance.currency || 'USD');
    } else if (q.windows && typeof q.windows.limit === 'number' && typeof q.windows.used === 'number') {
      el.uQuota.textContent = `${fmt(q.windows.used)} / ${fmt(q.windows.limit)}`;
    } else {
      el.uQuota.textContent = '可用';
    }
    return;
  }

  if (q.status === 'unsupported') {
    el.uQuota.textContent = '不支持';
    return;
  }
  if (q.status === 'auth_error') {
    el.uQuota.textContent = '未认证';
    return;
  }
  if (q.status === 'unavailable') {
    el.uQuota.textContent = '不可用';
    return;
  }
  if (q.status === 'error') {
    el.uQuota.textContent = '错误';
    return;
  }

  el.uQuota.textContent = '—';
}

/* ---------- Local Usage 更新 ---------- */

export function applyState(d) {
  S.ready = true;
  S.state = d;

  if (d.sessionId) {
    S.localUsage.sessionId = d.sessionId;
  }

  if (d.model) {
    const modelName = d.model.name || d.model.id || '模型';
    el.modelText.textContent = modelName;
    el.btnModel.title = `切换模型：${modelName}`;
    el.btnModel.setAttribute('aria-label', `切换模型：${modelName}`);

    S.localUsage.modelId = d.model.id || d.model.name || null;
    const providerId = resolveProvider(d.model);
    if (providerId) {
      S.localUsage.providerId = providerId;
      if (providerId !== S.currentProviderId) {
        syncRemoteQuota(providerId);
      }
    }
  }

  if (d.thinkingLevel) {
    el.thinkText.textContent = '思考 ' + d.thinkingLevel;
    el.btnThink.title = `思考强度：${d.thinkingLevel}`;
    el.btnThink.setAttribute('aria-label', `思考强度：${d.thinkingLevel}`);
  }

  if (d.sessionName) setTitleText(d.sessionName);
  el.footName.textContent = d.sessionName || '本地会话';
  setStreaming(Boolean(d.isStreaming));
}

export function applyStats(d) {
  S.stats = d;
  const ctx = d.contextUsage || {};
  const pct = typeof ctx.percent === 'number' ? ctx.percent : 0;

  // 严格区别 null 和 0：只有有 tokens 时才显示数字
  el.uPct.textContent = ctx.tokens != null ? Math.round(pct) + '%' : '—';
  el.uCtxBar.style.width = ctx.tokens != null ? Math.min(100, pct) + '%' : '0%';
  el.uCtxBar.style.background = pct > 85 ? 'var(--err)' : pct > 65 ? 'var(--warn)' : '#aeb3b6';
  el.uNote.textContent = ctx.tokens != null && ctx.contextWindow
    ? `上下文 ${fmt(ctx.tokens)} / ${fmt(ctx.contextWindow)}`
    : '上下文 —';

  const t = d.tokens || {};
  el.uTok.textContent = t.input != null || t.output != null ? `${fmt(t.input || 0)} / ${fmt(t.output || 0)}` : '—';
  el.uCache.textContent = t.cacheRead != null ? fmt(t.cacheRead) : '—';
  el.uCost.textContent = typeof d.cost === 'number' ? '$' + d.cost.toFixed(4) : '—';

  // 同步更新 LocalUsage
  S.localUsage.sessionId = d.sessionId || S.state?.sessionId || S.localUsage.sessionId || null;
  S.localUsage.inputTokens = t.input != null ? t.input : null;
  S.localUsage.outputTokens = t.output != null ? t.output : null;
  S.localUsage.cacheReadTokens = t.cacheRead != null ? t.cacheRead : null;
  S.localUsage.cacheWriteTokens = t.cacheWrite != null ? t.cacheWrite : null;
  S.localUsage.totalTokens = t.total != null ? t.total : null;
  S.localUsage.contextUsed = ctx.tokens != null ? ctx.tokens : null;
  S.localUsage.contextLimit = ctx.contextWindow != null ? ctx.contextWindow : null;
  S.localUsage.contextPercent = typeof ctx.percent === 'number' ? ctx.percent : null;
  S.localUsage.estimatedCost = typeof d.cost === 'number' ? d.cost : null;
  S.localUsage.source = 'session_stats';
  S.localUsage.updatedAt = new Date().toISOString();

  renderCtxChip();
  renderRemoteQuota();

  // 统计面板是一次性拉取，拿到数据后回调渲染
  if (S.onStats) {
    const fn = S.onStats;
    S.onStats = null;
    fn(d);
  }
}

/** 接收来自 message_update 或 message_end 的单轮真实 usage */
export function onTurnUsage(usage, meta = {}) {
  if (!usage || typeof usage !== 'object') return;

  S.localUsage.lastTurn = {
    inputTokens: usage.input != null ? usage.input : null,
    outputTokens: usage.output != null ? usage.output : null,
    cacheReadTokens: usage.cacheRead != null ? usage.cacheRead : null,
    cacheWriteTokens: usage.cacheWrite != null ? usage.cacheWrite : null,
    cacheWrite1hTokens: usage.cacheWrite1h != null ? usage.cacheWrite1h : null,
    reasoningTokens: usage.reasoning != null ? usage.reasoning : null,
    totalTokens: usage.totalTokens != null ? usage.totalTokens : null,
    estimatedCost: typeof usage.cost?.total === 'number' ? usage.cost.total : null,
  };

  if (meta.provider) S.localUsage.providerId = meta.provider;
  if (meta.model) S.localUsage.modelId = meta.model;
  S.localUsage.source = meta.source || 'message_end';
  S.localUsage.updatedAt = new Date().toISOString();
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
    el.btnCtx.setAttribute('aria-label', '上下文占用：暂无数据');
    return;
  }

  const clamped = Math.max(0, Math.min(100, pct));
  el.ctxPct.textContent = Math.round(clamped) + '%';
  el.ctxRing.style.strokeDashoffset = String(RING_LEN * (1 - clamped / 100));
  el.btnCtx.className = 'ctx-chip' + (clamped > 85 ? ' hot' : clamped > 65 ? ' warn' : '');
  el.btnCtx.setAttribute('aria-label', `上下文占用：${Math.round(clamped)}%`);
}

/** 弹出上下文与额度明细 Tip */
export function openCtxTip() {
  const ctx = S.stats?.contextUsage;

  pop.innerHTML = '';
  const box = document.createElement('div');

  // 1. 上下文背景信息 (Context Window)
  if (!ctx || ctx.tokens == null || !ctx.contextWindow) {
    const head = document.createElement('div');
    head.className = 'tip-head';
    head.textContent = '背景信息窗口:';
    const dim = document.createElement('div');
    dim.className = 'tip-dim';
    dim.textContent = '暂无上下文数据';
    box.append(head, dim);
  } else {
    const pct = Math.round(ctxPct() ?? 0);
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

  // 2. 会话累计用量 (Session Usage)
  const tokens = S.stats?.tokens || {};
  const details = [
    ['输入', tokens.input == null ? null : fmt(tokens.input)],
    ['输出', tokens.output == null ? null : fmt(tokens.output)],
    ['缓存读取', tokens.cacheRead == null ? null : fmt(tokens.cacheRead)],
    ['缓存写入', tokens.cacheWrite == null ? null : fmt(tokens.cacheWrite)],
    ['累计成本', typeof S.stats?.cost === 'number' ? '$' + S.stats.cost.toFixed(4) : null],
  ].filter(([, value]) => value != null);

  if (details.length) {
    const extra = document.createElement('div');
    extra.className = 'tip-extra';

    const secTitle = document.createElement('div');
    secTitle.className = 'tip-sec-title';
    secTitle.textContent = '会话累计用量';
    extra.appendChild(secTitle);

    for (const [label, value] of details) {
      const row = document.createElement('div');
      row.className = 'tip-row';
      const name = document.createElement('span');
      name.textContent = label;
      const amount = document.createElement('span');
      amount.textContent = value;
      row.append(name, amount);
      extra.appendChild(row);
    }
    box.appendChild(extra);
  }

  // 3. 本轮 Turn 用量 (Last Turn Usage)
  const lt = S.localUsage?.lastTurn;
  if (lt && (lt.inputTokens != null || lt.outputTokens != null)) {
    const turnSec = document.createElement('div');
    turnSec.className = 'tip-extra';

    const secTitle = document.createElement('div');
    secTitle.className = 'tip-sec-title';
    secTitle.textContent = '最近一轮用量';
    turnSec.appendChild(secTitle);

    const turnItems = [
      ['本轮输入', lt.inputTokens == null ? null : fmt(lt.inputTokens)],
      ['本轮输出', lt.outputTokens == null ? null : fmt(lt.outputTokens)],
      ['本轮缓存读取', lt.cacheReadTokens == null ? null : fmt(lt.cacheReadTokens)],
      ['本轮缓存写入', lt.cacheWriteTokens == null ? null : fmt(lt.cacheWriteTokens)],
      ['思考 Token', lt.reasoningTokens == null ? null : fmt(lt.reasoningTokens)],
      ['本轮预估成本', lt.estimatedCost == null ? null : '$' + lt.estimatedCost.toFixed(4)],
    ].filter(([, v]) => v != null);

    for (const [label, value] of turnItems) {
      const row = document.createElement('div');
      row.className = 'tip-row';
      const name = document.createElement('span');
      name.textContent = label;
      const amount = document.createElement('span');
      amount.textContent = value;
      row.append(name, amount);
      turnSec.appendChild(row);
    }
    box.appendChild(turnSec);
  }

  // 4. 供应商远端额度 (Remote Quota)
  const quotaSec = document.createElement('div');
  quotaSec.className = 'tip-extra tip-quota-section';

  const qHead = document.createElement('div');
  qHead.className = 'tip-quota-head';
  const qTitle = document.createElement('span');
  qTitle.className = 'tip-sec-title';
  const pid = S.currentProviderId || resolveProvider(S.state?.model) || '当前供应商';
  qTitle.textContent = `远端额度 (${pid})`;
  qHead.appendChild(qTitle);

  if (S.currentProviderId) {
    const btnRefresh = document.createElement('button');
    btnRefresh.type = 'button';
    btnRefresh.className = 'tip-refresh-btn';
    btnRefresh.textContent = S.quotaLoading ? '刷新中…' : '刷新';
    btnRefresh.disabled = Boolean(S.quotaLoading);
    btnRefresh.onclick = (e) => {
      e.stopPropagation();
      syncRemoteQuota(S.currentProviderId, { force: true });
    };
    qHead.appendChild(btnRefresh);
  }
  quotaSec.appendChild(qHead);

  const q = S.remoteQuota;
  if (S.quotaLoading) {
    const r = document.createElement('div');
    r.className = 'tip-dim';
    r.textContent = '正在获取供应商额度…';
    quotaSec.appendChild(r);
  } else if (!q) {
    const r = document.createElement('div');
    r.className = 'tip-dim';
    r.textContent = '暂无远端额度信息';
    quotaSec.appendChild(r);
  } else if (q.status === 'ok') {
    if (q.balance && typeof q.balance.amount === 'number') {
      const row = document.createElement('div');
      row.className = 'tip-row';
      const name = document.createElement('span');
      name.textContent = '剩余额度';
      const val = document.createElement('span');
      val.textContent = fmtCurrency(q.balance.amount, q.balance.currency || 'USD');
      row.append(name, val);
      quotaSec.appendChild(row);

      if (q.balance.granted != null) {
        const rGrant = document.createElement('div');
        rGrant.className = 'tip-row';
        rGrant.innerHTML = `<span>赠送额度</span><span>${fmtCurrency(q.balance.granted, q.balance.currency)}</span>`;
        quotaSec.appendChild(rGrant);
      }
      if (q.balance.toppedUp != null) {
        const rTop = document.createElement('div');
        rTop.className = 'tip-row';
        rTop.innerHTML = `<span>充值额度</span><span>${fmtCurrency(q.balance.toppedUp, q.balance.currency)}</span>`;
        quotaSec.appendChild(rTop);
      }
    }
    if (q.windows && q.windows.limit != null) {
      const row = document.createElement('div');
      row.className = 'tip-row';
      const name = document.createElement('span');
      name.textContent = '限额窗口';
      const val = document.createElement('span');
      val.textContent = `${fmt(q.windows.used || 0)} / ${fmt(q.windows.limit)} ${q.windows.unit || ''}`;
      row.append(name, val);
      quotaSec.appendChild(row);
    }
    if (q.rateLimit && q.rateLimit.requests != null) {
      const row = document.createElement('div');
      row.className = 'tip-row';
      const name = document.createElement('span');
      name.textContent = '速率限制';
      const val = document.createElement('span');
      val.textContent = `${q.rateLimit.requests} req / ${q.rateLimit.interval || ''}`;
      row.append(name, val);
      quotaSec.appendChild(row);
    }
  } else if (q.status === 'unsupported') {
    const dim = document.createElement('div');
    dim.className = 'tip-dim';
    dim.textContent = '该供应商未提供公开的官方额度接口';
    quotaSec.appendChild(dim);
  } else if (q.status === 'auth_error') {
    const dim = document.createElement('div');
    dim.className = 'tip-dim tip-warn';
    dim.textContent = q.message || 'API Key 无效或未授权查询额度';
    quotaSec.appendChild(dim);
  } else if (q.status === 'unavailable') {
    const dim = document.createElement('div');
    dim.className = 'tip-dim tip-warn';
    dim.textContent = q.message || '额度服务暂时无法连接';
    quotaSec.appendChild(dim);
  } else {
    const dim = document.createElement('div');
    dim.className = 'tip-dim tip-warn';
    dim.textContent = q.message || '额度查询失败';
    quotaSec.appendChild(dim);
  }

  box.appendChild(quotaSec);

  pop.appendChild(box);
  openPop(el.btnCtx, { tip: true });
}

/* ---------- 可用模型 / 思考档位 ---------- */

let modelWaiters = [];

export function onModels(d) {
  S.models = Array.isArray(d) ? d : d?.models || [];
  if (modelWaiters.length) {
    const ws = modelWaiters;
    modelWaiters = [];
    for (const w of ws) w(S.models);
  }
}

/** 拿到可用模型列表；已经在手就立刻返回，否则等一次应答（最多 timeoutMs）。 */
export function whenModels(timeoutMs = 4000) {
  if (S.models.length) return Promise.resolve(S.models);
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      modelWaiters = modelWaiters.filter((w) => w !== onReady);
      resolve([]);
    }, timeoutMs);
    function onReady(list) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(list);
    }
    modelWaiters.push(onReady);
  });
}

export function onThinkingLevels(d) {
  S.thinkingLevels = Array.isArray(d) ? d : d?.levels || [];
}
