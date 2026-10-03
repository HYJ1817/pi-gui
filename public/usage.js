/* 状态与用量：模型 / 思考档位 / 上下文占用 / token 与成本 / 远端额度。
 *
 * 两层数据模型（P21）：
 *   - LocalUsage：来自 Pi/模型返回的真实 usage（session total、当前 turn、context 占用、cache）
 *   - RemoteQuota：来自各 Provider 稳定官方额度接口，无标准接口一律 unsupported
 *
 * 字段没有证据就 null；0 只能表示真实 0。
 */

import { el, S, setUsageRenderHook } from './state.js';
import { fmt } from './util.js';
import { setTitleText } from './shell.js';
import { openPop, pop } from './ui/popover.js';
import { setStreaming } from './messages.js';
import { draftSync } from './draft.js';

/* ---------- 辅助工具 ---------- */

/** 货币符号：只有**有证据**的单位才有符号。
 *  USD → $、CNY → ¥，其它（含 null / undefined / TOKENS / CUSTOM）一律**不加符号**。
 *  没有证据时把数值标成 $ 就是编造单位 —— 尤其不能默认成美元。 */
export function currencySymbol(currency) {
  if (currency === 'USD') return '$';
  if (currency === 'CNY') return '¥';
  return '';
}

/** 格式化金额或额度数值（无单位时只输出数值） */
export function fmtCurrency(amount, currency = null) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
  return currencySymbol(currency) + amount.toFixed(4);
}

/** 格式化简短金额（保留 2 位小数，无单位时只输出数值） */
export function fmtBalanceShort(amount, currency = null) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
  return currencySymbol(currency) + amount.toFixed(2);
}

/** 数值缺省语义：只有真的有限数字才显示数字，null/undefined 一律「—」。
 *  这跟 `|| 0` 的区别就是 0 与「没有数据」的分界：0 是真实 0，必须显示 0。 */
export function fmtMaybeNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? fmt(v) : '—';
}

/** 金额缺省语义（同上；无单位时只输出数值）。 */
export function fmtMaybeMoney(v, currency = null) {
  return typeof v === 'number' && Number.isFinite(v) ? fmtCurrency(v, currency) : '—';
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
    /* 多币种（DeepSeek 的 balance_infos 可能同时有 CNY 与 USD）：
     * 只做并排摘要，**绝不相加**，也不在这里引入任何临时变量。 */
    const balances = Array.isArray(q.balances)
      ? q.balances.filter((b) => b && typeof b.amount === 'number')
      : [];
    if (balances.length > 0) {
      el.uQuota.textContent = balances.map((b) => fmtBalanceShort(b.amount, b.currency)).join(' | ');
    } else if (q.balance && typeof q.balance.amount === 'number') {
      /* 不写 `currency || 'USD'`：单位未知就是未知，不能默认成美元。 */
      el.uQuota.textContent = fmtBalanceShort(q.balance.amount, q.balance.currency);
    } else if (typeof q.windows?.limit === 'number' || typeof q.windows?.used === 'number') {
      el.uQuota.textContent = `${fmtMaybeNumber(q.windows?.used)} / ${fmtMaybeNumber(q.windows?.limit)}`;
    } else {
      /* ok 但没有任何可用数值（amount/limit/used 全是 null）：如实显示「—」，
       * 不写「可用」—— 那会让人以为已经查到了额度。 */
      el.uQuota.textContent = '—';
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

/** 会话身份变了（new / switch / fork）→ 会话级用量必须**立刻**清掉。
 *  远端额度不在这里清：它归 Provider identity 管，换会话不等于换供应商。 */
export function clearSessionUsage() {
  S.stats = null;
  Object.assign(S.localUsage, {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    contextUsed: null,
    contextLimit: null,
    contextPercent: null,
    estimatedCost: null,
    lastTurn: null,
    source: 'none',
    updatedAt: null,
  });
  renderUsageState();
}

export function applyState(d) {
  S.ready = true;

  /* 覆盖旧 state **之前**先比 sessionId：Session A 的统计绝不能留到 Session B。
   * 不等随后的 get_session_stats —— 那一刻界面就该已经干净了。 */
  const previousSessionId = S.localUsage.sessionId || S.state?.sessionId || null;
  const nextSessionId = typeof d?.sessionId === 'string' && d.sessionId ? d.sessionId : null;
  if (previousSessionId && nextSessionId && previousSessionId !== nextSessionId) {
    clearSessionUsage();
    /* P24：会话身份变了 = 草稿身份也变了 —— 未发送草稿按会话隔离，
     * 换会话要立刻对齐（旧会话的留在旧 key，新会话的有就恢复）。 */
    draftSync();
  }

  S.state = d;

  if (nextSessionId) {
    S.localUsage.sessionId = nextSessionId;
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
    } else {
      /* 新模型解析不出 Provider：旧供应商的额度不能继续挂在界面上，
       * 同时 ++epoch 让在途的旧应答回来也写不进来。 */
      S.quotaEpoch++;
      S.currentProviderId = null;
      S.remoteQuota = null;
      S.quotaLoading = false;
      renderRemoteQuota();
    }
  }

  if (!d.model) {
    el.modelText.textContent = '模型不可用';
    el.btnModel.title = '切换模型';
    el.btnModel.setAttribute('aria-label', '切换模型');
    S.localUsage.modelId = null;
    S.localUsage.providerId = null;
    S.quotaEpoch++;
    S.currentProviderId = null;
    S.remoteQuota = null;
    S.quotaLoading = false;
    renderRemoteQuota();
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

/**
 * 把用量相关的 DOM **一次画完**（侧栏 + 上下文 chip）。
 *
 * 所有入口都走这里：applyStats / workspace reset / 会话切换 / Provider 变化。
 * 这样「state → DOM」只有一份实现 —— 不会出现两套各自漏一格的 reset 逻辑。
 * 缺失一律显示「—」，**0 只可能来自真实数字 0**。
 */
export function renderUsageState() {
  const ctx = S.stats?.contextUsage || null;
  const t = S.stats?.tokens || null;

  let pct = null;
  if (ctx && typeof ctx.percent === 'number' && Number.isFinite(ctx.percent)) pct = ctx.percent;
  else if (ctx && ctx.tokens != null && ctx.contextWindow) pct = (ctx.tokens / ctx.contextWindow) * 100;

  if (el.uPct) el.uPct.textContent = pct == null ? '—' : Math.round(pct) + '%';
  if (el.uCtxBar) {
    const clamped = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    el.uCtxBar.style.width = clamped + '%';
    el.uCtxBar.style.background = pct == null ? '#aeb3b6' : pct > 85 ? 'var(--err)' : pct > 65 ? 'var(--warn)' : '#aeb3b6';
  }
  if (el.uNote) {
    el.uNote.textContent = ctx && ctx.tokens != null && ctx.contextWindow
      ? `上下文 ${fmt(ctx.tokens)} / ${fmt(ctx.contextWindow)}`
      : '上下文 —';
  }

  if (el.uTok) {
    el.uTok.textContent = t && (t.input != null || t.output != null)
      ? `${fmtMaybeNumber(t.input)} / ${fmtMaybeNumber(t.output)}`
      : '—';
  }
  if (el.uCache) el.uCache.textContent = t ? fmtMaybeNumber(t.cacheRead) : '—';
  if (el.uCost) el.uCost.textContent = S.stats && typeof S.stats.cost === 'number' ? '$' + S.stats.cost.toFixed(4) : '—';

  renderCtxChip();
  renderRemoteQuota();
}

export function applyStats(d) {
  S.stats = d;
  const ctx = d.contextUsage || {};
  const t = d.tokens || {};

  // 同步更新 LocalUsage（0 是真实 0；缺失保持 null）
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

  renderUsageState();

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
    const pctValue = ctxPct();
    if (pctValue == null) {
      /* 有上下文数据但算不出百分比（例如缺 contextWindow）：如实说没有，不按 0 显示。 */
      const head = document.createElement('div');
      head.className = 'tip-head';
      head.textContent = '背景信息窗口:';
      const dim = document.createElement('div');
      dim.className = 'tip-dim';
      dim.textContent = '暂无上下文数据';
      box.append(head, dim);
    } else {
      const pct = Math.round(pctValue);
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
    /* 行一律用 DOM 构建：这里出现过 innerHTML 插值，动态值（币种/金额/限额）
     * 都来自远端响应，绝不能拼进 HTML。 */
    const addRow = (label, value) => {
      const row = document.createElement('div');
      row.className = 'tip-row';
      const name = document.createElement('span');
      name.textContent = label;
      const amount = document.createElement('span');
      amount.textContent = value;
      row.append(name, amount);
      quotaSec.appendChild(row);
    };

    /* 多币种逐条展示（DeepSeek 可能同时有 CNY 与 USD），**不相加**。
     * 单位未知（currency 为 null，例如 NewAPI）时不加货币符号、也不编一个币种名。 */
    const label = (base, currency) => (currencySymbol(currency) ? `${base} (${currency})` : base);
    const balances = Array.isArray(q.balances)
      ? q.balances.filter((b) => b && typeof b.amount === 'number')
      : [];
    if (balances.length > 0) {
      for (const b of balances) {
        addRow(label('剩余额度', b.currency), fmtCurrency(b.amount, b.currency));
        if (b.granted != null) addRow(label('赠送额度', b.currency), fmtCurrency(b.granted, b.currency));
        if (b.toppedUp != null) addRow(label('充值额度', b.currency), fmtCurrency(b.toppedUp, b.currency));
      }
    } else if (q.balance && typeof q.balance.amount === 'number') {
      addRow(label('剩余额度', q.balance.currency), fmtCurrency(q.balance.amount, q.balance.currency));
      if (q.balance.granted != null) addRow(label('赠送额度', q.balance.currency), fmtCurrency(q.balance.granted, q.balance.currency));
      if (q.balance.toppedUp != null) addRow(label('充值额度', q.balance.currency), fmtCurrency(q.balance.toppedUp, q.balance.currency));
    }

    /* 限额窗口拆成独立行（不再挤成一行 "used / limit"）：
     * 「已使用」「总额度」照实显示；「额度剩余」只在它和上面的余额**不是同一个数**时才加，
     * 免得 OpenRouter（limit_remaining 就是 remaining）出现两行重复。 */
    if (q.windows && (q.windows.limit != null || q.windows.used != null)) {
      addRow('已使用', fmtMaybeNumber(q.windows.used));
      addRow('总额度', fmtMaybeNumber(q.windows.limit));
      const shownBalance = q.balance && typeof q.balance.amount === 'number' ? q.balance.amount : null;
      const duplicate = shownBalance != null && typeof q.windows.remaining === 'number'
        && Math.abs(q.windows.remaining - shownBalance) < 1e-9;
      if (q.windows.remaining != null && !duplicate) addRow('额度剩余', fmtMaybeNumber(q.windows.remaining));
    }

    /* 数值没有任何单位证据时，明确说清是「无单位数值」，并说明由谁决定单位。 */
    const hasSymbol = Boolean(currencySymbol(q.balance?.currency))
      || (Array.isArray(q.balances) && q.balances.some((b) => currencySymbol(b?.currency)));
    const hasUnit = Boolean(q.windows?.unit) || hasSymbol;
    if ((q.balance || q.windows || q.balances) && !hasUnit) {
      const note = document.createElement('div');
      note.className = 'tip-dim';
      note.textContent = '单位未知：由供应商站点的展示单位设置决定，Pi GUI 不猜货币';
      quotaSec.appendChild(note);
    }
    if (q.rateLimit && q.rateLimit.requests != null) {
      const row = document.createElement('div');
      row.className = 'tip-row';
      const name = document.createElement('span');
      name.textContent = '速率限制';
      const val = document.createElement('span');
      val.textContent = `${fmtMaybeNumber(q.rateLimit.requests)} req / ${q.rateLimit.interval || ''}`;
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

/* 注册用量 DOM 渲染钩子：workspace reset（state.js 的 resetUsageState）
 * 与正常更新走**同一条**渲染路径，不存在第二份 reset 逻辑。 */
setUsageRenderHook(() => renderUsageState());
