/* 会话标题服务：触发、生成、校验、归属与降级。
 *
 * ---------- 触发面 ----------
 *
 * 经典聊天：rpc.publish 里 `agent_settled` 携带的 `generationResult`
 *（由 model-generation.js 判定）。只认 success + hasVisibleOutput + 非 aborted。
 * 独立 Runtime：registry 在同一个 settled 帧上注入 observe 回调，带 owner、
 * 会话文件 locator 与 record.createdAt。
 *
 * 触发点只做「提交一个任务」，读会话文件、判断首轮、调用模型全在后台异步完成；
 * 不阻塞回复、不进入主会话上下文、不新增消息、不切换会话。
 *
 * ---------- 归属 ----------
 *
 * 标题存储键是原生会话 id（经典 `classic:<uuid>`，Runtime
 * `runtime:<conversationId>`）。生成开始时捕获目标文件与身份，应用前再读一次
 * 同一文件核对：header id、原生手动名、文件身份。任何一项变了就丢弃迟到的
 * 结果。自动标题只写 Pi GUI 自己的存储，从不写 Pi 的 JSONL。
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { json, readBody } from './http-utils.js';
import { buildTitlePrompt, normalizeGeneratedTitle, parseSessionTitleContext } from './session-title-context.js';

const MAX_READ_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const PROPOSAL_TTL_MS = 10 * 60 * 1000;
const MAX_PROPOSALS = 20;
const MAX_QUEUE = 16;
const DEFAULT_TIMEOUT_MS = 20_000;

const SCOPE_CLASSIC = 'classic';
const SCOPE_RUNTIME = 'runtime';

function uuidish(value) {
  return typeof value === 'string' && /^[\da-f-]{36}$/i.test(value);
}

function statIdentity(file) {
  try {
    const st = fs.statSync(file);
    return { dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs };
  } catch {
    return null;
  }
}

export function createSessionTitles({
  store,
  sdk,
  readSessionText,
  resolveClassic = () => null,
  resolveRuntime = () => null,
  rpcRequest = null,
  getPrimarySessionId = () => null,
  getCurrentCwd = () => null,
  publish = () => {},
  logEvent = () => {},
  now = () => Date.now(),
  autoConcurrency = 2,
} = {}) {
  if (!store || typeof store.resolve !== 'function') throw new Error('session-titles: store required');
  if (!sdk || typeof sdk.generate !== 'function') throw new Error('session-titles: sdk required');
  if (typeof readSessionText !== 'function') throw new Error('session-titles: readSessionText required');

  const inFlight = new Map();
  const queue = [];
  const proposals = new Map();
  let active = 0;
  let disposed = false;

  const safeLog = (event, details = {}) => {
    try {
      logEvent(event, details);
    } catch {
      /* 观察失败不影响标题 */
    }
  };

  const capability = () => (typeof sdk.capability === 'function' ? sdk.capability() : { supported: null, reason: null, piVersion: null });

  const modelInfo = () => ({ mode: 'current-session', label: '跟随当前会话' });

  function settingsPayload() {
    return { ok: true, settings: store.settings(), capability: capability(), model: modelInfo() };
  }

  function publishSettings() {
    publish({ type: 'session_title_settings', ...settingsPayload() });
  }

  function publishTitle({ scope, sessionId, conversationId = null, title, source }) {
    publish({
      type: 'session_title',
      scope,
      sessionId: sessionId || null,
      ...(scope === SCOPE_RUNTIME && conversationId ? { conversationId } : {}),
      title,
      source,
      at: new Date(now()).toISOString(),
    });
  }

  function setAutoEnabled(enabled) {
    const before = store.settings();
    let settings;
    try {
      settings = store.updateSettings({ autoEnabled: enabled });
    } catch {
      return { ok: false, code: 'settings_write_failed', error: '设置未能保存，请重试', settings: before };
    }
    if (settings.revision !== before.revision) {
      if (!settings.autoEnabled) cancelAuto();
      publishSettings();
    }
    return settingsPayload();
  }

  function cancelAuto() {
    for (const [key, task] of inFlight) {
      if (task.mode !== 'auto') continue;
      task.cancelled = true;
      try { task.controller?.abort(); } catch { /* ignore */ }
    }
    /* 队列里的自动任务不再值得跑；手动任务保留。 */
    for (let i = queue.length - 1; i >= 0; i--) {
      const entry = queue[i];
      if (entry.task.mode !== 'auto') continue;
      queue.splice(i, 1);
      if (inFlight.get(entry.task.key) === entry.task) inFlight.delete(entry.task.key);
      entry.resolve({ ok: false, code: 'cancelled' });
    }
  }

  function readTarget(target, identity = null) {
    const file = target.file;
    if (!file || !target.sessionId || !target.cwd) return { ok: false, code: 'invalid_target' };
    const expected = { sessionId: target.sessionId, cwd: target.cwd };
    const witness = identity || target.sessionIdentity || null;
    if (witness) expected.sessionIdentity = witness;
    const read = readSessionText(file, { maxBytes: MAX_READ_BYTES, expected });
    if (!read?.ok) return { ok: false, code: 'session_unavailable' };
    const ctx = parseSessionTitleContext(read.text);
    if (!ctx) return { ok: false, code: 'session_unparsable' };
    if (ctx.header.id !== target.sessionId) return { ok: false, code: 'identity_mismatch' };
    return { ok: true, ctx, truncated: read.truncated === true };
  }

  function targetKey(scope, id) {
    return store.keyFor(scope, id);
  }

  function autoBlockedReason(key, ctx, settings) {
    if (ctx.nativeName) return 'native_title';
    if (ctx.assistantBeforeFirstUser) return 'resumed_session';
    if (!ctx.userText) return 'no_user_message';
    if (!ctx.header.createdAt) return 'unknown_creation_time';
    const created = Date.parse(ctx.header.createdAt);
    const enabledAt = Date.parse(settings.enabledAt);
    if (!Number.isFinite(created) || !Number.isFinite(enabledAt) || created < enabledAt) return 'created_before_rollout';
    const existing = store.entry(key);
    if (existing?.manual) return 'manual_title';
    if (existing?.auto) return 'already_titled';
    if (existing?.attempt) return 'already_attempted';
    return null;
  }

  function autoContext(ctx) {
    /* 优先首轮完整回复；首轮失败/为空时，等到的第一条有效回复也算
     * 「第一次有效 AI 回复」，用它的模型与文本。 */
    if (ctx.assistantText) return { text: ctx.assistantText, providerId: ctx.providerId, modelId: ctx.modelId, source: 'first_turn' };
    if (ctx.firstAssistantText) {
      return { text: ctx.firstAssistantText, providerId: ctx.firstAssistantProvider, modelId: ctx.firstAssistantModel, source: 'first_valid_reply' };
    }
    return null;
  }

  function manualContext(ctx) {
    if (ctx.assistantText) {
      return {
        text: ctx.assistantText,
        providerId: ctx.providerId || ctx.firstAssistantProvider,
        modelId: ctx.modelId || ctx.firstAssistantModel,
      };
    }
    if (ctx.firstAssistantText) return { text: ctx.firstAssistantText, providerId: ctx.firstAssistantProvider, modelId: ctx.firstAssistantModel };
    if (ctx.lastAssistantText) return { text: ctx.lastAssistantText, providerId: ctx.lastAssistantProvider, modelId: ctx.lastAssistantModel };
    return null;
  }

  async function autoClassic(settings, meta = {}) {
    if (disposed || !settings.autoEnabled) return;
    if (typeof rpcRequest !== 'function') return;
    let state;
    try {
      state = await rpcRequest({ type: 'get_state' });
    } catch {
      return;
    }
    if (!state || state.__error || state.isStreaming === true) return;
    const sessionId = typeof state.sessionId === 'string' ? state.sessionId : '';
    const file = typeof state.sessionFile === 'string' ? state.sessionFile : '';
    const cwd = getCurrentCwd();
    if (!sessionId || !file || !cwd) return;
    /* 如果 get_state 已经切到别的会话，这一帧就不属于当前会话；
     * 不根据「刚好当前是谁」猜标题归属。settle 时的主会话也一并核对，
     * 防止用户在 settled 与 get_state 之间切走后，错给新会话生成标题。 */
    const primary = getPrimarySessionId();
    if (primary && primary !== sessionId) return;
    if (meta.primaryAtSettle && meta.primaryAtSettle !== sessionId) return;
    await maybeAuto({
      scope: SCOPE_CLASSIC,
      sessionId,
      file,
      cwd,
      sessionIdentity: statIdentity(file),
      key: targetKey(SCOPE_CLASSIC, sessionId),
    }, settings, meta);
  }

  function observeClassic(event) {
    if (disposed || !event || event.type !== 'agent_settled') return;
    const result = event.generationResult;
    if (!result || result.outcome !== 'success' || result.hasVisibleOutput !== true || event.aborted === true) return;
    const settings = store.settings();
    if (!settings.autoEnabled) return;
    void autoClassic(settings, { requestId: result.requestId || null, primaryAtSettle: getPrimarySessionId() })
      .catch(() => safeLog('session-title.auto_failed', { reason: 'internal', requestId: result.requestId || null }));
  }

  /** registry 的 summary/historyTarget 用它同步解析显示标题。 */
  function resolveRuntimeRecord(record) {
    if (!record || !record.conversationId) return null;
    return store.resolve({
      scope: SCOPE_RUNTIME,
      conversationId: record.conversationId,
      nativeName: record.sessionName || '',
      fallback: record.workspace?.branch || '',
      defaultTitle: '并行会话',
    });
  }

  function observeRuntimeTurn(payload) {
    if (disposed || !payload) return;
    const result = payload.generationResult;
    if (!result || result.outcome !== 'success' || result.hasVisibleOutput !== true || payload.aborted === true) return;
    const settings = store.settings();
    if (!settings.autoEnabled) return;
    if (!uuidish(payload.conversationId) || !payload.sessionId || !payload.sessionLocator || !payload.cwd) return;
    void maybeAuto({
      scope: SCOPE_RUNTIME,
      conversationId: payload.conversationId,
      sessionId: payload.sessionId,
      file: payload.sessionLocator,
      cwd: payload.cwd,
      sessionIdentity: payload.sessionIdentity || statIdentity(payload.sessionLocator),
      key: targetKey(SCOPE_RUNTIME, payload.conversationId),
    }, settings, { requestId: result.requestId || null })
      .catch(() => safeLog('session-title.auto_failed', { reason: 'internal', requestId: result.requestId || null }));
  }

  async function maybeAuto(target, settings, meta = {}) {
    if (disposed || !target.key || inFlight.has(target.key)) return;
    const read = readTarget(target, target.sessionIdentity);
    if (!read.ok) {
      safeLog('session-title.auto_skipped', { reason: read.code, requestId: meta.requestId || null });
      return;
    }
    const ctx = read.ctx;
    const reason = autoBlockedReason(target.key, ctx, settings);
    if (reason) return;
    const context = autoContext(ctx);
    if (!context) return; // 等后续有效回复；不记录 attempt
    if (!context.providerId || !context.modelId) {
      try { store.recordAttempt(target.key, settings.revision); } catch {
        safeLog('session-title.auto_skipped', { reason: 'store_write_failed' });
      }
      safeLog('session-title.auto_skipped', { reason: 'model_missing' });
      return;
    }
    let recorded = false;
    try {
      recorded = store.recordAttempt(target.key, settings.revision);
    } catch {
      /* 元数据目录不可写不能变成未处理的 rejection；保留原标题，聊天继续。 */
      safeLog('session-title.auto_skipped', { reason: 'store_write_failed' });
      return;
    }
    if (!recorded) return;
    void schedule({
      mode: 'auto',
      key: target.key,
      scope: target.scope,
      sessionId: target.sessionId,
      conversationId: target.conversationId || null,
      target,
      identity: target.sessionIdentity,
      nativeName: ctx.nativeName,
      providerId: context.providerId,
      modelId: context.modelId,
      userText: ctx.userText,
      assistantText: context.text,
      revision: settings.revision,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  }

  function schedule(task) {
    if (disposed) return Promise.resolve({ ok: false, code: 'cancelled' });
    if (inFlight.has(task.key)) return Promise.resolve({ ok: false, code: 'busy', error: '正在为这个会话生成标题，请稍候' });
    if (queue.length >= MAX_QUEUE) return Promise.resolve({ ok: false, code: 'busy', error: '标题生成任务较多，请稍后再试' });
    inFlight.set(task.key, task);
    return new Promise((resolve) => {
      queue.push({ task, resolve });
      drain();
    });
  }

  function drain() {
    while (!disposed && active < autoConcurrency && queue.length) {
      const entry = queue.shift();
      active++;
      void runTask(entry.task)
        .then(entry.resolve, () => entry.resolve({ ok: false, code: 'internal' }))
        .finally(() => {
          active--;
          if (inFlight.get(entry.task.key) === entry.task) inFlight.delete(entry.task.key);
          drain();
        });
    }
    if (disposed) {
      while (queue.length) queue.shift().resolve({ ok: false, code: 'cancelled' });
    }
  }

  async function runTask(task) {
    const settings = store.settings();
    if (task.mode === 'auto' && (!settings.autoEnabled || settings.revision !== task.revision)) {
      return { ok: false, code: 'cancelled' };
    }
    const controller = new AbortController();
    task.controller = controller;
    const prompt = buildTitlePrompt({ userText: task.userText, assistantText: task.assistantText });
    const started = now();
    let result;
    try {
      result = await sdk.generate({
        providerId: task.providerId,
        modelId: task.modelId,
        system: prompt.system,
        user: prompt.user,
        signal: controller.signal,
        timeout: task.timeoutMs,
      });
    } catch {
      result = { ok: false, code: 'internal' };
    }
    const durationMs = now() - started;
    if (task.cancelled || controller.signal.aborted) return { ok: false, code: 'cancelled' };
    if (!result || result.ok !== true) {
      const code = result?.code || 'failed';
      safeLog('session-title.generate_failed', { scope: task.scope, mode: task.mode, code, durationMs });
      if (code === 'unsupported') publishSettings();
      return { ok: false, code, error: titleError(code) };
    }
    const title = normalizeGeneratedTitle(result.text, { userText: task.userText });
    if (!title) {
      safeLog('session-title.invalid_output', { scope: task.scope, mode: task.mode, durationMs });
      return { ok: false, code: 'invalid_output', error: '生成的标题不合法，已保留原标题' };
    }
    const applied = applyGenerated(task, title, { durationMs, usage: result.usage || {} });
    return applied;
  }

  function applyGenerated(task, title, meta) {
    if (disposed) return { ok: false, code: 'cancelled' };
    if (task.mode === 'auto') {
      const settings = store.settings();
      if (!settings.autoEnabled || settings.revision !== task.revision) return { ok: false, code: 'cancelled' };
    }
    const read = readTarget(task.target, task.identity);
    if (!read.ok) {
      safeLog('session-title.apply_discarded', { reason: read.code, mode: task.mode });
      return { ok: false, code: read.code, error: '会话已变化，标题未应用' };
    }
    const ctx = read.ctx;
    if (ctx.header.id !== task.sessionId) {
      safeLog('session-title.apply_discarded', { reason: 'identity_mismatch', mode: task.mode });
      return { ok: false, code: 'identity_mismatch', error: '会话已变化，标题未应用' };
    }
    /* 用户在生成期间改了名（或在 Pi 里改了名）：迟到的结果一律丢弃，
     * 原生手动名是用户明确表达，不能被后台结果覆盖。 */
    if (ctx.nativeName !== task.nativeName) {
      safeLog('session-title.apply_discarded', { reason: 'native_title_changed', mode: task.mode });
      return { ok: false, code: 'stale_title', error: '会话标题已被修改，本次结果已丢弃' };
    }
    if (task.mode === 'auto') {
      const entry = store.entry(task.key);
      if (entry?.manual || entry?.auto) {
        safeLog('session-title.apply_discarded', { reason: entry?.manual ? 'manual_title' : 'already_titled', mode: task.mode });
        return { ok: false, code: 'stale_title' };
      }
      try {
        store.setAuto(task.key, { title, providerId: task.providerId, modelId: task.modelId });
      } catch {
        return { ok: false, code: 'store_write_failed', error: '标题未能保存' };
      }
      publishTitle({ scope: task.scope, sessionId: task.sessionId, conversationId: task.conversationId, title, source: 'auto' });
      safeLog('session-title.generated', {
        scope: task.scope, mode: task.mode, durationMs: meta.durationMs,
        inputTokens: meta.usage?.input ?? null, outputTokens: meta.usage?.output ?? null,
      });
      return { ok: true, applied: true, title, source: 'auto', sessionId: task.sessionId };
    }

    const resolved = store.resolve({
      scope: task.scope,
      sessionId: task.sessionId,
      conversationId: task.conversationId,
      nativeName: ctx.nativeName,
      fallback: ctx.userText,
      defaultTitle: '（还没有消息）',
    });
    if (resolved.source === 'manual' && task.forceApply !== true) {
      const proposal = createProposal(task, title, ctx.nativeName);
      return {
        ok: true,
        requiresConfirmation: true,
        proposal: { id: proposal.id, title, currentTitle: resolved.title },
      };
    }
    try {
      store.setManual(task.key, { title, nativeNameAt: ctx.nativeName });
    } catch {
      return { ok: false, code: 'store_write_failed', error: '标题未能保存' };
    }
    publishTitle({ scope: task.scope, sessionId: task.sessionId, conversationId: task.conversationId, title, source: 'manual' });
    safeLog('session-title.generated', {
      scope: task.scope, mode: task.mode, durationMs: meta.durationMs,
      inputTokens: meta.usage?.input ?? null, outputTokens: meta.usage?.output ?? null,
    });
    return { ok: true, applied: true, title, source: 'manual', sessionId: task.sessionId };
  }

  function createProposal(task, title, nativeNameAt) {
    pruneProposals();
    const id = randomUUID();
    proposals.set(id, {
      id,
      key: task.key,
      scope: task.scope,
      sessionId: task.sessionId,
      conversationId: task.conversationId || null,
      target: { ...task.target },
      identity: task.identity,
      title,
      nativeNameAt,
      createdAt: now(),
    });
    return proposals.get(id);
  }

  function pruneProposals() {
    const cutoff = now() - PROPOSAL_TTL_MS;
    for (const [id, proposal] of proposals) if (proposal.createdAt < cutoff) proposals.delete(id);
    if (proposals.size < MAX_PROPOSALS) return;
    const oldest = [...proposals.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const proposal of oldest.slice(0, proposals.size - MAX_PROPOSALS + 1)) proposals.delete(proposal.id);
  }

  function applyProposal(proposalId) {
    if (disposed) return { ok: false, code: 'cancelled', error: '标题服务已关闭' };
    pruneProposals();
    const proposal = proposals.get(proposalId);
    if (!proposal) return { ok: false, code: 'proposal_not_found', error: '这次生成结果已失效，请重新生成' };
    const read = readTarget(proposal.target, proposal.identity);
    if (!read.ok) {
      proposals.delete(proposalId);
      return { ok: false, code: read.code, error: '会话已变化，标题未应用' };
    }
    const ctx = read.ctx;
    if (ctx.header.id !== proposal.sessionId || ctx.nativeName !== proposal.nativeNameAt) {
      proposals.delete(proposalId);
      return { ok: false, code: 'stale_title', error: '会话标题已被修改，请重新生成' };
    }
    try {
      store.setManual(proposal.key, { title: proposal.title, nativeNameAt: ctx.nativeName });
    } catch {
      return { ok: false, code: 'store_write_failed', error: '标题未能保存' };
    }
    publishTitle({
      scope: proposal.scope,
      sessionId: proposal.sessionId,
      conversationId: proposal.conversationId,
      title: proposal.title,
      source: 'manual',
    });
    proposals.delete(proposalId);
    return { ok: true, applied: true, title: proposal.title, source: 'manual', sessionId: proposal.sessionId };
  }

  async function generateClassic(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) return { ok: false, code: 'invalid_request', error: '缺少合法的会话 ID' };
    let target;
    try {
      target = resolveClassic(id);
    } catch {
      target = null;
    }
    if (!target || !target.file || !target.sessionId || !target.cwd) {
      return { ok: false, code: 'not_found', error: '找不到这个会话（可能已被删除，或不属于当前项目）' };
    }
    return generateManual({
      scope: SCOPE_CLASSIC,
      sessionId: target.sessionId,
      file: target.file,
      cwd: target.cwd,
      sessionIdentity: statIdentity(target.file),
      key: targetKey(SCOPE_CLASSIC, target.sessionId),
    });
  }

  async function generateRuntime(conversationId) {
    if (!uuidish(conversationId)) return { ok: false, code: 'invalid_request', error: '缺少合法的并行会话 ID' };
    let target;
    try {
      target = resolveRuntime(conversationId);
    } catch {
      target = null;
    }
    if (!target || !target.sessionLocator || !target.sessionId || !target.cwd) {
      return { ok: false, code: 'no_session', error: '这个并行会话还没有可读取的历史' };
    }
    return generateManual({
      scope: SCOPE_RUNTIME,
      conversationId,
      sessionId: target.sessionId,
      file: target.sessionLocator,
      cwd: target.cwd,
      sessionIdentity: target.sessionIdentity || statIdentity(target.sessionLocator),
      key: targetKey(SCOPE_RUNTIME, conversationId),
    });
  }

  async function generateManual(target) {
    if (disposed) return { ok: false, code: 'cancelled', error: '标题服务已关闭' };
    if (!target.key) return { ok: false, code: 'invalid_request', error: '缺少合法的会话 ID' };
    if (inFlight.has(target.key)) return { ok: false, code: 'busy', error: '正在为这个会话生成标题，请稍候' };
    const read = readTarget(target, target.sessionIdentity);
    if (!read.ok) return { ok: false, code: read.code, error: '读取会话失败，标题未生成' };
    const ctx = read.ctx;
    const context = manualContext(ctx);
    if (!context) return { ok: false, code: 'no_reply', error: '这个会话还没有可用的 AI 回复' };
    if (!context.providerId || !context.modelId) {
      return { ok: false, code: 'model_missing', error: '无法确定该会话使用的模型，标题未生成' };
    }
    return schedule({
      mode: 'manual',
      key: target.key,
      scope: target.scope,
      sessionId: target.sessionId,
      conversationId: target.conversationId || null,
      target,
      identity: target.sessionIdentity,
      nativeName: ctx.nativeName,
      providerId: context.providerId,
      modelId: context.modelId,
      userText: ctx.userText,
      assistantText: context.text,
      revision: store.settings().revision,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (p === '/api/session-titles/settings') {
      if (req.method === 'GET') return json(res, 200, settingsPayload());
      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        if (body.err) return json(res, body.err.status, body.err.body);
        if (typeof body.value.autoEnabled !== 'boolean') {
          return json(res, 400, { ok: false, code: 'invalid_request', error: 'autoEnabled 必须是布尔值' });
        }
        return json(res, 200, setAutoEnabled(body.value.autoEnabled));
      }
      return json(res, 405, { ok: false, error: 'Method not allowed' });
    }
    if (p === '/api/session-titles/generate') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });
      const body = await readJsonBody(req);
      if (body.err) return json(res, body.err.status, body.err.body);
      const scope = body.value.scope;
      const result = scope === SCOPE_RUNTIME
        ? await generateRuntime(body.value.conversationId)
        : await generateClassic(body.value.id);
      return json(res, 200, result);
    }
    if (p === '/api/session-titles/apply') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });
      const body = await readJsonBody(req);
      if (body.err) return json(res, body.err.status, body.err.body);
      if (typeof body.value.proposalId !== 'string' || body.value.proposalId.length > 64) {
        return json(res, 400, { ok: false, code: 'invalid_request', error: '缺少合法的 proposalId' });
      }
      return json(res, 200, applyProposal(body.value.proposalId));
    }
    return json(res, 404, { ok: false, error: 'Not found' });
  }

  async function readJsonBody(req) {
    let raw;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch {
      return { err: { status: 413, body: { ok: false, code: 'too_large', error: '请求体过大' } } };
    }
    try {
      const value = JSON.parse(raw || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
      return { value };
    } catch {
      return { err: { status: 400, body: { ok: false, code: 'invalid_json', error: '请求体不是合法 JSON' } } };
    }
  }

  function dispose() {
    disposed = true;
    for (const task of inFlight.values()) {
      task.cancelled = true;
      try { task.controller?.abort(); } catch { /* ignore */ }
    }
    while (queue.length) queue.shift().resolve({ ok: false, code: 'cancelled' });
    proposals.clear();
    try { sdk.dispose?.(); } catch { /* ignore */ }
  }

  return {
    handle,
    observeClassic,
    observeRuntimeTurn,
    resolveRuntimeRecord,
    settings: settingsPayload,
    setAutoEnabled,
    generateClassic,
    generateRuntime,
    applyProposal,
    dispose,
    _internals: {
      maybeAuto, autoBlockedReason, autoContext, manualContext, readTarget,
      proposalCount: () => proposals.size,
      inFlightCount: () => inFlight.size,
    },
  };
}

function titleError(code) {
  switch (code) {
    case 'unsupported': return '当前 Pi 版本不支持独立模型调用，标题未生成';
    case 'model_unavailable': return '该会话使用的模型当前不可用，标题未生成';
    case 'cancelled': return '标题生成已取消';
    case 'timeout': return '标题生成超时，已保留原标题';
    default: return '标题生成失败，已保留原标题';
  }
}
