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
import { withModelCapability, modelCapability, modelIdentity } from './model-capabilities.js';
import { thinkingAvailability } from './thinking-availability.js';
import { renderModelControls } from './composer.js';
import { renderAttachments } from './attachments.js';
import { observeFallbackState } from './fallback.js';
import { logRendererEvent } from './log-client.js';
import { requestSessionStats } from './session-stats.js';
import {
  beginThroughputTurn,
  noteAssistantStart,
  noteAssistantEnd,
  settleThroughputTurn,
  resetThroughput,
  throughputSnapshot,
  throughputFields,
} from './turn-throughput.js';

/* 能力未知只用于低频诊断日志；它不是业务判定，视图仍由 model-capabilities 决定。 */
function contextWindowMissing(c) {
  return c?.contextWindow === null || c?.contextWindow === undefined;
}

const positiveNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

/** 两个模型身份是否能确认是同一个。
 *  只有两边都具备完整的 providerId + modelId，且两个字段逐一相等时，
 *  才允许把统计载荷里的 contextWindow 当作当前模型的容量。
 *  任意一边缺字段（哪怕两边缺得一模一样、或只剩 modelId 相同）都无法
 *  证明是同一个模型，一律拒绝 —— 身份不完整时宁可显示「未知」，
 *  也不能让旧模型的容量借着「都是未知身份」溜到新模型上。 */
function identityCompatible(a, b) {
  const aComplete = Boolean(a?.providerId && a?.modelId);
  const bComplete = Boolean(b?.providerId && b?.modelId);
  if (!aComplete || !bComplete) return false;
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

/* 最近一次被接受的统计属于哪一代请求。`object` 用来识别外部直接
 * 赋值 S.stats 的情况（测试 / 旧路径），此时没有请求身份可用。 */
let statsRecord = null;

function currentStatsRecord() {
  if (!S.stats) {
    statsRecord = null;
    return null;
  }
  if (!statsRecord || statsRecord.object !== S.stats) {
    statsRecord = {
      object: S.stats,
      identity: modelIdentity(S.state?.model),
      seq: 0,
      workspace: S.workspaceGeneration,
      sessionId: S.stats.sessionId || null,
    };
  }
  return statsRecord;
}

/** 当前模型可用的上下文容量。只认完整 providerId + modelId 的元数据；
 *  先看 get_state 的模型（Pi 运行态），再按同一身份查可用模型列表。 */
function modelContextWindow() {
  const model = S.state?.model;
  if (!model || typeof model !== 'object') return null;
  const identity = modelIdentity(model);
  if (!identity.providerId || !identity.modelId) return null;

  const own = modelCapability(model);
  if (own?.contextWindow != null) {
    return { value: own.contextWindow, source: own.evidence?.contextWindow || 'model' };
  }
  const raw = positiveNumber(model.contextWindow);
  if (raw != null) return { value: raw, source: 'model' };

  const listed = (S.models || []).find((m) =>
    m && m.providerId === identity.providerId && m.modelId === identity.modelId);
  if (!listed) return null;
  const cap = modelCapability(listed);
  if (cap?.contextWindow != null) {
    return { value: cap.contextWindow, source: cap.evidence?.contextWindow || 'model' };
  }
  const listedRaw = positiveNumber(listed.contextWindow);
  return listedRaw != null ? { value: listedRaw, source: 'model' } : null;
}

/** 上下文用量的唯一投影：已用 token 来自当前会话统计；容量来自当前
 *  已确认模型的 contextWindow。统计里的 contextWindow 只在它确实属于
 *  同一模型时作为回退证据 —— 模型切换后旧统计的容量绝不沿用。
 *
 *  `pending` 表示 set_model / get_state 回读尚未完成：此时保留已用
 *  token（同一会话不因换模型清零），但容量显示为「同步中」，不展示
 *  上一模型的旧容量。 */
export function contextUsage() {
  const ctx = S.stats?.contextUsage || null;
  const used = ctx && typeof ctx.tokens === 'number' && Number.isFinite(ctx.tokens) && ctx.tokens >= 0
    ? ctx.tokens
    : null;
  const pending = S.modelSwitchPending === true;

  let limit = null;
  let source = null;
  if (!pending) {
    const fromModel = modelContextWindow();
    if (fromModel) {
      limit = fromModel.value;
      source = fromModel.source;
    } else {
      const record = currentStatsRecord();
      const fromStats = positiveNumber(ctx?.contextWindow);
      if (fromStats != null && record
        && identityCompatible(record.identity, modelIdentity(S.state?.model))) {
        limit = fromStats;
        source = 'session-stats';
      }
    }
  }

  const percent = used != null && limit != null ? (used / limit) * 100 : null;
  return { used, limit, percent, pending, source };
}

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

/** Structured identity first; old ID-only state uses a unique legacy match. */
function resolveProvider(modelObj) {
  if (!modelObj) return null;
  if (typeof modelObj.providerId === 'string' && modelObj.providerId) return modelObj.providerId;
  if (typeof modelObj.provider === 'string' && modelObj.provider) return modelObj.provider;
  const rawId = modelObj.id || modelObj.name;
  if (typeof rawId === 'string') {
    // 查 S.models 列表
    const found = (S.models || []).filter((m) => m.id === rawId || m.name === rawId);
    if (found.length === 1 && (found[0].providerId || found[0].provider)) return found[0].providerId || found[0].provider;
    if (found.length > 1) return null;
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
  resetThroughput();
  S.stats = null;
  statsRecord = null;
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
  observeFallbackState(d);
  S.ready = true;
  const previousModel = modelIdentity(S.state?.model);
  const nextModel = modelIdentity(d.model);
  /* provider + model 才是身份。只比 modelId 会把两个供应商下的同名模型
   * 当成同一次切换，旧容量/旧档位就留下来了。 */
  const changedModel = previousModel.modelId !== nextModel.modelId
    || previousModel.providerId !== nextModel.providerId;
  if (changedModel) {
    S.thinkingLevels = [];
    S.thinkingReadStatus = 'unconfirmed';
    /* 换模型就换了计时口径：旧模型未收尾的响应不能把时长记到新模型头上。 */
    resetThroughput();
  }

  /* 覆盖旧 state **之前**先比 sessionId：Session A 的统计绝不能留到 Session B。
   * 不等随后的 get_session_stats —— 那一刻界面就该已经干净了。 */
  const previousSessionId = S.localUsage.sessionId || S.state?.sessionId || null;
  const nextSessionId = typeof d?.sessionId === 'string' && d.sessionId ? d.sessionId : null;
  if (previousSessionId && nextSessionId && previousSessionId !== nextSessionId) {
    S.thinkingLevels = [];
    S.thinkingReadStatus = 'unconfirmed';
    clearSessionUsage();
  }

  if (d.model) {
    const providerId = resolveProvider(d.model);
    const identity = modelIdentity({ ...d.model, providerId });
    const listed = S.models.find(m => m.providerId === identity.providerId && m.modelId === identity.modelId);
    d = { ...d, model: withModelCapability({ ...listed, ...d.model, providerId,
      capability: d.model.capability,
      capabilities: { ...listed?.capability?.capabilities, ...d.model.capabilities },
    }) };
  }
  S.state = d;

  /* 模型变了：Pi 的统计缓存键包含当前模型，必须重新取一次，才能让
   * 已用 token 与新的 contextWindow 对齐。请求会登记当前身份，迟到的
   * 旧应答由 applyStats 的代次检查丢掉。 */
  if (changedModel && S.hasProject && S.bridgeState === 'ready') {
    requestSessionStats();
  }

  if (nextSessionId) {
    S.localUsage.sessionId = nextSessionId;
  }
  // 身份写入后再对齐；draftSync 用内部旧 key 归档输入，不会把旧文本带入新会话。
  draftSync();

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

  renderModelControls();
  renderAttachments();

  if (d.sessionName) setTitleText(d.sessionName);
  el.footName.textContent = d.sessionName || '本地会话';
  setStreaming(Boolean(d.isStreaming));
  /* 模型/会话身份变化后立刻重画：侧栏、chip、浮层、统计面板都从
   * contextUsage() 这一份投影取值，不各自缓存容量。 */
  renderUsageState();
}

/**
 * 把用量相关的 DOM **一次画完**（侧栏 + 上下文 chip）。
 *
 * 所有入口都走这里：applyStats / workspace reset / 会话切换 / Provider 变化。
 * 这样「state → DOM」只有一份实现 —— 不会出现两套各自漏一格的 reset 逻辑。
 * 缺失一律显示「—」，**0 只可能来自真实数字 0**。
 */
export function renderUsageState() {
  const t = S.stats?.tokens || null;
  const view = contextUsage();
  const pct = view.percent;

  /* LocalUsage 的上下文字段也跟同一份投影走。没有统计时保持 null，
   * 不把「当前模型容量」冒充成「已经用掉的会话数据」。 */
  if (S.stats) {
    S.localUsage.contextUsed = view.used;
    S.localUsage.contextLimit = view.limit;
    S.localUsage.contextPercent = view.percent;
  }

  if (el.uPct) el.uPct.textContent = pct == null ? '—' : Math.round(pct) + '%';
  if (el.uCtxBar) {
    const clamped = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    el.uCtxBar.style.width = clamped + '%';
    el.uCtxBar.style.background = pct == null ? 'var(--ui-text-muted)' : pct > 85 ? 'var(--err)' : pct > 65 ? 'var(--warn)' : 'var(--ui-text-muted)';
  }
  if (el.uNote) {
    if (view.used == null) el.uNote.textContent = '上下文 —';
    else if (view.pending) el.uNote.textContent = `上下文 ${fmt(view.used)} / 同步中`;
    else if (view.limit == null) el.uNote.textContent = `上下文 ${fmt(view.used)} / 未知`;
    else el.uNote.textContent = `上下文 ${fmt(view.used)} / ${fmt(view.limit)}`;
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
  /* 明细浮层若正开着，内容也必须跟同一份投影一起刷新。 */
  if (pop && pop.querySelector('.tip-quota-section')) openCtxTip();
}

export function applyStats(d, meta = null) {
  if (!d || typeof d !== 'object') return;

  /* 过期检查：换了工作区 / 会话之后，旧请求的统计不能再写进来。
   * 模型身份不在这里拒绝 —— 同一会话换模型时已用 token 仍然有效，
   * 只是容量不再采用旧统计的 contextWindow（见 contextUsage）。 */
  if (meta?.stale) return;
  if (meta && meta.workspace !== S.workspaceGeneration) return;
  const currentSessionId = S.state?.sessionId || S.localUsage.sessionId || null;
  if (!S.modelSwitchPending && d.sessionId && currentSessionId && d.sessionId !== currentSessionId) return;

  const previous = currentStatsRecord();
  if (meta && previous?.seq && meta.seq < previous.seq) return;

  const identity = meta?.identity || modelIdentity(S.state?.model);
  statsRecord = {
    object: d,
    identity,
    seq: meta?.seq ?? 0,
    workspace: meta?.workspace ?? S.workspaceGeneration,
    sessionId: d.sessionId || meta?.sessionId || null,
  };
  S.stats = d;
  const t = d.tokens || {};

  // 同步更新 LocalUsage（0 是真实 0；缺失保持 null）
  S.localUsage.sessionId = d.sessionId || S.state?.sessionId || S.localUsage.sessionId || null;
  S.localUsage.inputTokens = t.input != null ? t.input : null;
  S.localUsage.outputTokens = t.output != null ? t.output : null;
  S.localUsage.cacheReadTokens = t.cacheRead != null ? t.cacheRead : null;
  S.localUsage.cacheWriteTokens = t.cacheWrite != null ? t.cacheWrite : null;
  S.localUsage.totalTokens = t.total != null ? t.total : null;
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

/* ---------- 本轮生成速度（TPS） ----------
 *
 * 计时在 turn-throughput.js；这里只负责把它并进 lastTurn 这一份投影，
 * 以及让已经打开的上下文浮层跟着刷新。 */

function refreshUsagePopover() {
  if (pop && pop.querySelector('.tip-quota-section')) openCtxTip();
}

function syncThroughputToLastTurn() {
  const lt = S.localUsage?.lastTurn;
  if (lt) Object.assign(lt, throughputFields());
  refreshUsagePopover();
}

/** 新 Agent turn：开始计时（app.js 的 agent_start 调用）。 */
export function beginUsageTurn() {
  beginThroughputTurn();
}

/** assistant message_start：记录单条响应的单调起点。 */
export function onAssistantMessageStart(evt, at) {
  if (evt?._replay) return;
  noteAssistantStart(evt, at);
}

/** assistant message_end：结算单条响应；没有 usage 时也保留估算/时长口径。 */
export function onAssistantMessageEnd(evt, at) {
  if (evt?._replay) return;
  noteAssistantEnd(evt, at);
  syncThroughputToLastTurn();
}

/** agent_settled：本轮收尾，界面不再显示「生成中…」。 */
export function onTurnThroughputSettled() {
  settleThroughputTurn();
  syncThroughputToLastTurn();
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
    /* 同一轮可能有多次 assistant 响应（中间夹工具调用），时间与输出都按
     * 本轮累计；单条 usage 仍按 Pi 的原值展示。 */
    ...throughputFields(),
  };

  if (meta.provider) S.localUsage.providerId = meta.provider;
  if (meta.model) S.localUsage.modelId = meta.model;
  S.localUsage.source = meta.source || 'message_end';
  S.localUsage.updatedAt = new Date().toISOString();
  refreshUsagePopover();
}

/* ---------- 上下文占用指示器 ---------- */

const RING_LEN = 2 * Math.PI * 15.5;

export function ctxPct() {
  return contextUsage().percent;
}

export function renderCtxChip() {
  const view = contextUsage();
  const pct = view.percent;

  if (pct == null) {
    el.ctxPct.textContent = '—';
    el.ctxRing.style.strokeDashoffset = String(RING_LEN);
    el.btnCtx.className = 'ctx-chip';
    el.btnCtx.setAttribute('aria-label', view.used == null
      ? '上下文占用：暂无数据'
      : view.pending ? '上下文占用：模型同步中' : '上下文占用：容量未知');
    return;
  }

  const clamped = Math.max(0, Math.min(100, pct));
  el.ctxPct.textContent = Math.round(clamped) + '%';
  el.ctxRing.style.strokeDashoffset = String(RING_LEN * (1 - clamped / 100));
  el.btnCtx.className = 'ctx-chip' + (clamped > 85 ? ' hot' : clamped > 65 ? ' warn' : '');
  el.btnCtx.setAttribute('aria-label', `上下文占用：${Math.round(clamped)}%`);
}

/* 生成速度只从「本轮累计输出 / 本轮累计响应时长」算；任何一边缺证据
 * 都显示「—」，绝不把 0 或墙钟差当成速度。历史重建不会产生计时，因此
 * 老会话不会凭空出现一个看似精确的数字。 */
function throughputDisplay(lt, snapshot) {
  if (snapshot.generating) {
    return { value: '生成中…', title: '本轮仍在生成，结束后显示实测速度' };
  }
  /* 本轮速度以 throughputSnapshot 为准：它按「响应」逐条配对输出与时长，
   * 不要求 lastTurn 存在（中断响应没有最终 usage 时不会有 lastTurn）。
   * 只有当前轮账本完全为空时，才退回 lastTurn 的兼容字段；两组数据不交叉
   * 取值，避免出现「A 的输出配 B 的时长」。 */
  let source;
  if (snapshot.status === 'ready') {
    source = {
      output: snapshot.outputTokens,
      duration: snapshot.durationMs,
      estimated: snapshot.estimated,
    };
  } else if (lt && (lt.responseOutputTokens != null || lt.responseDurationMs != null)) {
    source = {
      output: lt.responseOutputTokens,
      duration: lt.responseDurationMs,
      estimated: Boolean(lt.responseOutputEstimated),
    };
  } else {
    source = { output: null, duration: null, estimated: false };
  }
  const hasOutput = typeof source.output === 'number' && Number.isFinite(source.output) && source.output > 0;
  const hasDuration = typeof source.duration === 'number' && Number.isFinite(source.duration) && source.duration > 0;
  if (!hasOutput || !hasDuration) {
    return { value: '—', title: '缺少本轮输出 Token 或响应时间' };
  }
  const rate = Math.round(source.output / (source.duration / 1000));
  if (!(rate > 0)) return { value: '—', title: '缺少本轮输出 Token 或响应时间' };
  return {
    value: `${source.estimated ? '≈ ' : ''}${rate} tokens/s`,
    title: source.estimated
      ? `按可见文本估算的输出 ${fmt(source.output)} token / 实测 ${(source.duration / 1000).toFixed(1)} 秒`
      : `本轮输出 ${fmt(source.output)} token / 响应 ${(source.duration / 1000).toFixed(1)} 秒`,
  };
}

/** 弹出上下文与额度明细 Tip */
export function openCtxTip() {
  const view = contextUsage();

  pop.innerHTML = '';
  const box = document.createElement('div');

  // 1. 上下文背景信息 (Context Window)
  const head = document.createElement('div');
  head.className = 'tip-head';
  head.textContent = '背景信息窗口:';

  if (view.used == null) {
    const dim = document.createElement('div');
    dim.className = 'tip-dim';
    dim.textContent = '暂无上下文数据';
    box.append(head, dim);
  } else {
    const big = document.createElement('div');
    big.className = 'tip-big';
    const dim = document.createElement('div');
    dim.className = 'tip-dim';

    if (view.pending) {
      big.textContent = `已用 ${fmt(view.used)}`;
      dim.textContent = '正在同步新模型的上下文容量…';
    } else if (view.limit == null) {
      big.textContent = `已用 ${fmt(view.used)}`;
      dim.textContent = '容量未知（当前模型未提供 contextWindow）';
    } else {
      const pct = Math.round(view.percent);
      const left = Math.max(0, 100 - pct);
      big.textContent = `${pct}% 已用 (剩余 ${left}%)`;
      dim.textContent = `已用 ${fmt(view.used)} 标记, 共 ${fmt(view.limit)}`;
    }
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
  const throughput = throughputSnapshot();
  /* attempts 表示本轮已经结束过 assistant 响应。即使没有 lastTurn（中断且
   * 没有最终 usage），也要把「生成速度 —」显示出来；不为显示 TPS 伪造 usage。
   * 换会话/工作区/模型后 resetThroughput 会把 attempts 清零，页面不会残留。 */
  if (throughput.generating || throughput.attempts > 0
    || (lt && (lt.inputTokens != null || lt.outputTokens != null))) {
    const turnSec = document.createElement('div');
    turnSec.className = 'tip-extra';

    const secTitle = document.createElement('div');
    secTitle.className = 'tip-sec-title';
    secTitle.textContent = '最近一轮用量';
    turnSec.appendChild(secTitle);

    const turnItems = [
      ['本轮输入', lt?.inputTokens == null ? null : fmt(lt.inputTokens)],
      ['本轮输出', lt?.outputTokens == null ? null : fmt(lt.outputTokens)],
      ['本轮缓存读取', lt?.cacheReadTokens == null ? null : fmt(lt.cacheReadTokens)],
      ['本轮缓存写入', lt?.cacheWriteTokens == null ? null : fmt(lt.cacheWriteTokens)],
      ['思考 Token', lt?.reasoningTokens == null ? null : fmt(lt.reasoningTokens)],
      ['本轮预估成本', lt?.estimatedCost == null ? null : '$' + lt.estimatedCost.toFixed(4)],
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

    const speed = throughputDisplay(lt, throughput);
    const speedRow = document.createElement('div');
    speedRow.className = 'tip-row tip-speed-row';
    const speedName = document.createElement('span');
    speedName.textContent = '生成速度';
    const speedValue = document.createElement('span');
    speedValue.className = 'tip-speed';
    speedValue.textContent = speed.value;
    if (speed.title) speedValue.title = speed.title;
    speedRow.append(speedName, speedValue);
    turnSec.appendChild(speedRow);
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
      addRow(label(q.kind === 'key-quota' ? 'Key 剩余额度' : '剩余额度', q.balance.currency), fmtCurrency(q.balance.amount, q.balance.currency));
      if (q.balance.granted != null) addRow(label('赠送额度', q.balance.currency), fmtCurrency(q.balance.granted, q.balance.currency));
      if (q.balance.toppedUp != null) addRow(label('充值额度', q.balance.currency), fmtCurrency(q.balance.toppedUp, q.balance.currency));
    }

    /* 限额窗口拆成独立行（不再挤成一行 "used / limit"）：
     * 「已使用」「总额度」照实显示；「额度剩余」只在它和上面的余额**不是同一个数**时才加，
     * 免得 OpenRouter（limit_remaining 就是 remaining）出现两行重复。 */
    if (q.windows && (q.windows.limit != null || q.windows.used != null)) {
      addRow(q.kind === 'key-quota' ? 'Key 已用额度' : '已使用', fmtMaybeNumber(q.windows.used));
      addRow(q.kind === 'key-quota' ? 'Key 限额' : '总额度', fmtMaybeNumber(q.windows.limit));
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
    dim.textContent = q.message || '该供应商当前没有已验证的远端额度接口';
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
  const list = Array.isArray(d) ? d : d?.models;
  S.models = (Array.isArray(list) ? list : []).map(withModelCapability).filter(m => m?.modelId);
  const unknownCapability = S.models.filter(m => {
    const c = m.capability || {};
    return contextWindowMissing(c) && !['imageInput', 'reasoning', 'toolCalling'].some(k => c.capabilities?.[k] !== null && c.capabilities?.[k] !== undefined);
  }).length;
  if (unknownCapability) logRendererEvent('ui.model_capability_unknown', { count: unknownCapability });
  /* 模型列表晚于 get_state 到达时，当前模型的 contextWindow 可能
   * 这时才变得可解析 —— 用量视图要跟着刷新。 */
  renderUsageState();
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
  const list = Array.isArray(d) ? d : d?.levels;
  const availability = thinkingAvailability({ model: S.state?.model, levels: list });
  S.thinkingLevels = availability.levels;
  S.thinkingReadStatus = !Array.isArray(list) || availability.state === 'invalid' ? 'invalid' : 'success';
  renderModelControls();
}

/* 注册用量 DOM 渲染钩子：workspace reset（state.js 的 resetUsageState）
 * 与正常更新走**同一条**渲染路径，不存在第二份 reset 逻辑。 */
setUsageRenderHook(() => renderUsageState());
