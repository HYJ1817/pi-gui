'use strict';
/* 会话标题服务（server/session-titles.js）的离线测试。
 *
 * 全部使用 os.tmpdir() 里的 fixture：会话文件、标题存储、设置都在临时目录，
 * 不读、不写任何真实项目或 Pi 会话；模型调用由假 SDK 代替。
 *
 * 覆盖：自动触发条件、只生成一次、失败降级、设置变更取消、手动生成与
 * 确认流程、迟到结果丢弃、Runtime 归属、并发上限、发布事件与不写会话文件。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  let ok = cond;
  try { ok = typeof cond === 'function' ? cond() : cond; }
  catch (err) { ok = 'threw: ' + err.message; }
  if (ok === true) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (typeof ok === 'string' ? '  → ' + ok : extra ? '  → ' + extra : '')); }
}
const section = (title) => console.log('\n--- ' + title + ' ---');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}

(async () => {
  const { createSessionTitleStore } = await import('../server/session-title-store.js');
  const { createSessionTitles } = await import('../server/session-titles.js');
  const { readSessionText } = await import('../server/session-history.js');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-title-service-'));
  const cwd = path.resolve(root, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(cwd, 'sessions'), { recursive: true });

  /* 会话文件的时间必须晚于设置的 enabledAt（默认「只对开启后新建的会话生效」），
   * 所以文件时间取自同一个前进中的时钟，而不是真实时间。 */
  let clock = Date.parse('2031-01-01T00:00:00.000Z');
  const now = () => new Date(clock += 1000);

  const line = (value) => JSON.stringify(value) + '\n';
  function writeSession(name, { id = crypto.randomUUID(), createdAt = new Date(clock + 10_000).toISOString(), nativeName = '', entries = [] } = {}) {
    const file = path.join(cwd, 'sessions', name + '.jsonl');
    let text = line({ type: 'session', version: 3, id, timestamp: createdAt, cwd });
    if (nativeName) text += line({ type: 'session_info', id: 'n0', parentId: null, timestamp: createdAt, name: nativeName });
    for (const e of entries) {
      text += line({
        type: 'message', id: e.id || crypto.randomUUID(), timestamp: createdAt,
        message: {
          role: e.role,
          content: typeof e.content === 'string' ? [{ type: 'text', text: e.content }] : e.content,
          ...(e.provider ? { provider: e.provider, model: e.model } : {}),
        },
      });
    }
    fs.writeFileSync(file, text, 'utf8');
    return { file, id, cwd };
  }

  const makeWorld = () => {
    const dir = path.join(root, crypto.randomUUID());
    const sdkCalls = [];
    let sdkResult = { ok: true, text: '修复登录接口 401 错误', usage: { input: 12, output: 8, totalTokens: 20 } };
    let hold = false;
    let releaseHeld = null;
    let stateGate = null;
    let releaseState = null;
    const events = [];
    const logs = [];
    const store = createSessionTitleStore({ dataDir: path.join(dir, 'data'), now });
    let classic = null;
    const service = createSessionTitles({
      store,
      sdk: {
        generate: (args) => {
          sdkCalls.push(args);
          if (hold) return new Promise((resolve) => { releaseHeld = resolve; });
          return Promise.resolve(sdkResult);
        },
        capability: () => ({ supported: true, reason: null, piVersion: '1.5.2' }),
      },
      readSessionText,
      resolveClassic: (id) => (classic && classic.id === id ? classic : null),
      rpcRequest: async () => {
        if (stateGate) await stateGate;
        return { sessionId: classic?.id, sessionFile: classic?.file, isStreaming: false };
      },
      getPrimarySessionId: () => classic?.id || null,
      getCurrentCwd: () => cwd,
      publish: (event) => events.push(event),
      logEvent: (event, details) => logs.push({ event, details }),
      now,
    });
    return {
      dir, store, service, events, logs,
      get calls() { return sdkCalls; },
      get classic() { return classic; },
      setResult(value) { sdkResult = value; hold = false; releaseHeld = null; },
      hold() { hold = true; },
      release(value = { ok: true, text: '修复登录接口 401 错误', usage: {} }) {
        hold = false;
        const fn = releaseHeld;
        releaseHeld = null;
        fn?.(value);
      },
      gateState() { stateGate = new Promise((resolve) => { releaseState = resolve; }); },
      releaseState() {
        const resolve = releaseState;
        stateGate = null;
        releaseState = null;
        resolve?.();
      },
      target(t) { classic = t; },
    };
  };

  const trigger = (world, requestId = 'req-1') =>
    world.service.observeClassic({ type: 'agent_settled', generationResult: { outcome: 'success', hasVisibleOutput: true, requestId } });

  try {
    /* ================= 1. 自动生成成功 ================= */
    section('1. 首轮成功后自动生成');
    {
      const w = makeWorld();
      const s = writeSession('ok', { entries: [
        { role: 'user', content: '帮我修登录接口' },
        { role: 'assistant', content: '问题在 token 过期判断。', provider: 'anthropic', model: 'claude-sonnet-5-5' },
      ] });
      w.target(s);
      const before = fs.readFileSync(s.file, 'utf8');
      trigger(w);
      const applied = await waitFor(() => Boolean(w.store.entry('classic:' + s.id)?.auto));
      check('1a. 自动标题写入存储', () => applied);
      check('1b. 标题是模型输出并通过校验', () =>
        w.store.entry('classic:' + s.id)?.auto.title === '修复登录接口 401 错误');
      check('1c. 记录实际使用的 provider / model', () => {
        const e = w.store.entry('classic:' + s.id)?.auto;
        return e.providerId === 'anthropic' && e.modelId === 'claude-sonnet-5-5';
      });
      check('1d. 模型调用只传素材，不传完整历史', () =>
        w.calls[0].system.includes('会话标题生成器')
        && w.calls[0].user.includes('帮我修登录接口')
        && w.calls[0].user.includes('问题在 token 过期判断')
        && !w.calls[0].user.includes('toolResult'));
      check('1e. 发布 session_title 事件（scope/sessionId/source）', () => {
        const e = w.events.find((x) => x.type === 'session_title');
        return Boolean(e) && e.scope === 'classic' && e.sessionId === s.id
          && e.title === '修复登录接口 401 错误' && e.source === 'auto' && typeof e.at === 'string';
      });
      check('1f. 不写 Pi 的会话文件', () => fs.readFileSync(s.file, 'utf8') === before);
      check('1g. 日志只有结构字段，没有标题 / 用户正文', () => {
        const json = JSON.stringify(w.logs);
        return !json.includes('帮我修登录接口') && !json.includes('修复登录接口 401 错误')
          && w.logs.some((x) => x.event === 'session-title.generated');
      });
      trigger(w, 'req-2');
      await sleep(50);
      check('1h. 同一会话第二次成功不会再调模型', () => w.calls.length === 1);
      w.service.dispose();
    }

    /* ================= 2. 自动触发门槛 ================= */
    section('2. 自动触发门槛');
    {
      const w = makeWorld();
      const s = writeSession('disabled', { entries: [
        { role: 'user', content: '问题' }, { role: 'assistant', content: '回答', provider: 'p', model: 'm' },
      ] });
      w.target(s);
      w.store.updateSettings({ autoEnabled: false });
      trigger(w);
      await sleep(80);
      check('2a. 关闭自动标题时不调用模型', () => w.calls.length === 0);
      w.service.dispose();
    }
    {
      const w = makeWorld();
      const s = writeSession('before-rollout', {
        createdAt: '2020-01-01T00:00:00.000Z',
        entries: [{ role: 'user', content: '老会话' }, { role: 'assistant', content: '老回复', provider: 'p', model: 'm' }],
      });
      w.target(s);
      trigger(w);
      await sleep(80);
      check('2b. 开启之前创建的会话不补标题（不批量生成历史）', () => w.calls.length === 0);
      w.service.dispose();
    }
    {
      const w = makeWorld();
      const s = writeSession('native-name', {
        nativeName: '用户起的名字',
        entries: [{ role: 'user', content: '问题' }, { role: 'assistant', content: '回答', provider: 'p', model: 'm' }],
      });
      w.target(s);
      trigger(w);
      await sleep(80);
      check('2c. 已有原生手动名的会话不自动生成', () => w.calls.length === 0);
      w.service.dispose();
    }
    {
      const w = makeWorld();
      const s = writeSession('resumed', { entries: [
        { role: 'assistant', content: '更早的回复', provider: 'p', model: 'm' },
        { role: 'user', content: '继续' },
        { role: 'assistant', content: '新的回复', provider: 'p', model: 'm' },
      ] });
      w.target(s);
      trigger(w);
      await sleep(80);
      check('2d. 恢复 / 分叉会话（首条不是 user）不自动生成', () => w.calls.length === 0);
      w.service.dispose();
    }
    {
      const w = makeWorld();
      const s = writeSession('no-reply', { entries: [{ role: 'user', content: '只问了问题' }] });
      w.target(s);
      trigger(w);
      await sleep(80);
      check('2e. 还没有有效回复时不生成、也不记 attempt', () =>
        w.calls.length === 0 && !w.store.entry('classic:' + s.id));
      w.service.dispose();
    }
    {
      const w = makeWorld();
      const s = writeSession('model-missing', { entries: [
        { role: 'user', content: '问题' }, { role: 'assistant', content: '回复但没有模型元数据' },
      ] });
      w.target(s);
      trigger(w);
      await waitFor(() => Boolean(w.store.entry('classic:' + s.id)?.attempt));
      check('2f. 无法确定模型时安全降级（记 attempt，不调用模型）', () =>
        w.calls.length === 0 && Boolean(w.store.entry('classic:' + s.id)?.attempt));
      w.service.dispose();
    }
    {
      const w = makeWorld();
      const s = writeSession('failed-then-ok', { entries: [
        { role: 'user', content: '第一问（首轮失败）' },
        { role: 'user', content: '第二问' },
        { role: 'assistant', content: '这是第一条有效回复。', provider: 'p9', model: 'm9' },
      ] });
      w.target(s);
      trigger(w);
      await waitFor(() => Boolean(w.store.entry('classic:' + s.id)?.auto));
      check('2g. 首轮失败后等到后续第一条有效回复再生成', () =>
        w.calls.length === 1 && w.calls[0].modelId === 'm9' && w.calls[0].user.includes('第一条有效回复'));
      w.service.dispose();
    }
    {
      /* settled 事件属于 A，但 get_state 在用户切到 B 之后才返回：
       * 不能拿 B 的“当前”身份给 B 补标题。 */
      const w = makeWorld();
      const a = writeSession('settle-a', { entries: [
        { role: 'user', content: 'A 的问题' }, { role: 'assistant', content: 'A 的回答', provider: 'p', model: 'm' },
      ] });
      const b = writeSession('settle-b', { entries: [
        { role: 'user', content: 'B 的问题' }, { role: 'assistant', content: 'B 的回答', provider: 'p', model: 'm' },
      ] });
      w.target(a);
      w.gateState();
      trigger(w, 'race-1');
      w.target(b);
      w.releaseState();
      await sleep(100);
      check('2h. settled 与 get_state 之间切换会话 → 不给新会话补标题', () =>
        w.calls.length === 0
        && !w.store.entry('classic:' + a.id)
        && !w.store.entry('classic:' + b.id));
      w.service.dispose();
    }

    /* ================= 3. 失败与降级 ================= */
    section('3. 失败保留原标题');
    {
      const w = makeWorld();
      const s = writeSession('sdk-fail', { entries: [
        { role: 'user', content: '问题' }, { role: 'assistant', content: '回答', provider: 'p', model: 'm' },
      ] });
      w.target(s);
      w.setResult({ ok: false, code: 'native-failed' });
      trigger(w);
      await waitFor(() => Boolean(w.store.entry('classic:' + s.id)?.attempt));
      check('3a. 模型失败时记录 attempt、不产生标题', () =>
        w.calls.length === 1 && !w.store.entry('classic:' + s.id)?.auto);
      trigger(w, 'req-2');
      await sleep(80);
      check('3b. 失败后不再自动重试', () => w.calls.length === 1);
      w.service.dispose();
    }
    {
      const w = makeWorld();
      const s = writeSession('invalid-out', { entries: [
        { role: 'user', content: '问题' }, { role: 'assistant', content: '回答', provider: 'p', model: 'm' },
      ] });
      w.target(s);
      w.setResult({ ok: true, text: '好的，以下是标题：\n修复登录' });
      trigger(w);
      await waitFor(() => w.logs.some((x) => x.event === 'session-title.invalid_output'));
      check('3c. 不合格输出（解释 / 多行）被拒，原标题保留', () =>
        !w.store.entry('classic:' + s.id)?.auto && w.logs.some((x) => x.event === 'session-title.invalid_output'));
      w.service.dispose();
    }
    {
      const w = makeWorld();
      const s = writeSession('cancelled', { entries: [
        { role: 'user', content: '问题' }, { role: 'assistant', content: '回答', provider: 'p', model: 'm' },
      ] });
      w.target(s);
      w.hold();
      trigger(w);
      await waitFor(() => w.calls.length === 1);
      w.service.setAutoEnabled(false);
      w.release({ ok: true, text: '迟到的标题' });
      await sleep(120);
      check('3d. 关闭开关会作废在途自动任务（迟到结果不落盘）', () =>
        !w.store.entry('classic:' + s.id)?.auto);
      w.service.dispose();
    }
    {
      /* 元数据目录写失败（磁盘满 / 只读）不能让后台链路变成进程级
       * unhandledRejection；标题放弃，聊天继续。 */
      const w = makeWorld();
      const s = writeSession('store-fail', { entries: [
        { role: 'user', content: '问题' }, { role: 'assistant', content: '回答', provider: 'p', model: 'm' },
      ] });
      w.target(s);
      w.store.recordAttempt = () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); };
      const unhandled = [];
      const onUnhandled = reason => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        trigger(w);
        await sleep(80);
        check('3e. attempt 写入失败不产生 unhandledRejection，标题保持原样', () =>
          unhandled.length === 0
          && w.calls.length === 0
          && !w.store.entry('classic:' + s.id)?.auto
          && w.logs.some((x) => x.event === 'session-title.auto_skipped' && x.details?.reason === 'store_write_failed'));
      } finally {
        process.off('unhandledRejection', onUnhandled);
        w.service.dispose();
      }
    }

    /* ================= 4. 手动生成 ================= */
    section('4. 手动生成与确认流程');
    {
      const w = makeWorld();
      const s = writeSession('manual', { entries: [
        { role: 'user', content: '用户问题' }, { role: 'assistant', content: '助手回答', provider: 'p', model: 'm' },
      ] });
      w.target(s);
      const missing = await w.service.generateClassic('a'.repeat(16));
      check('4a. 目标不存在时返回 not_found', () => missing.ok === false && missing.code === 'not_found');
      const stable = 'b'.repeat(16);
      w.target({ ...s, id: stable, sessionId: s.id });
      w.store.updateSettings({ autoEnabled: false });
      const ok = await w.service.generateClassic(stable);
      check('4b. 手动生成不受自动开关影响', () => ok.ok === true && ok.applied === true && ok.source === 'manual');
      check('4c. 手动结果写入存储并发布事件', () =>
        w.store.entry('classic:' + s.id)?.manual?.title === '修复登录接口 401 错误'
        && w.events.some((e) => e.type === 'session_title' && e.source === 'manual' && e.sessionId === s.id));
      check('4d. 手动生成没有记录 attempt（不影响自动计数）', () => !w.store.entry('classic:' + s.id)?.attempt);
      w.service.dispose();
    }
    {
      const w = makeWorld();
      const s = writeSession('proposal', {
        nativeName: '用户起的名字',
        entries: [{ role: 'user', content: '用户问题' }, { role: 'assistant', content: '助手回答', provider: 'p', model: 'm' }],
      });
      const stable = 'c'.repeat(16);
      w.target({ ...s, id: stable, sessionId: s.id });
      const result = await w.service.generateClassic(stable);
      check('4e. 当前是手动标题时返回待确认结果', () =>
        result.ok === true && result.requiresConfirmation === true
        && result.proposal.title === '修复登录接口 401 错误'
        && result.proposal.currentTitle === '用户起的名字');
      check('4f. 确认之前不改动标题', () =>
        w.store.resolve({ scope: 'classic', sessionId: s.id, nativeName: '用户起的名字' }).title === '用户起的名字');
      const applied = w.service.applyProposal(result.proposal.id);
      check('4g. 用户确认后保存为新的手动标题', () =>
        applied.ok === true && w.store.resolve({ scope: 'classic', sessionId: s.id, nativeName: '用户起的名字' }).title === '修复登录接口 401 错误');
      check('4h. 同一 proposal 不能重复应用', () =>
        w.service.applyProposal(result.proposal.id).ok === false);
      w.service.dispose();
    }
    {
      const w = makeWorld();
      const s = writeSession('late-rename', {
        entries: [{ role: 'user', content: '用户问题' }, { role: 'assistant', content: '助手回答', provider: 'p', model: 'm' }],
      });
      const stable = 'd'.repeat(16);
      w.target({ ...s, id: stable, sessionId: s.id });
      w.hold();
      const pending = w.service.generateClassic(stable);
      await waitFor(() => w.calls.length === 1);
      fs.appendFileSync(s.file, line({ type: 'session_info', id: 'n-late', parentId: null, timestamp: new Date().toISOString(), name: '生成期间改的名字' }), 'utf8');
      w.release({ ok: true, text: '迟到的标题' });
      const result = await pending;
      check('4i. 生成期间用户在 Pi 里改名 → 迟到结果丢弃', () =>
        result.ok === false && (result.code === 'stale_title' || result.code === 'native_title_changed'));
      check('4j. 丢弃的结果没有写入存储', () =>
        !w.store.entry('classic:' + s.id)?.manual && !w.store.entry('classic:' + s.id)?.auto);
      w.service.dispose();
    }
    {
      const w = makeWorld();
      const bad = await w.service.generateClassic('../../etc/passwd');
      check('4k. 非法的经典会话 ID 直接拒绝', bad.ok === false && bad.code === 'invalid_request');
      w.service.dispose();
    }

    /* ================= 5. Runtime 会话 ================= */
    section('5. 独立 Runtime 会话');
    {
      const w = makeWorld();
      const conversationId = crypto.randomUUID();
      const s = writeSession('runtime', { entries: [
        { role: 'user', content: '并行会话的问题' }, { role: 'assistant', content: '并行会话的回复', provider: 'p', model: 'm' },
      ] });
      w.service.observeRuntimeTurn({
        conversationId, sessionId: s.id, sessionLocator: s.file, cwd,
        generationResult: { outcome: 'success', hasVisibleOutput: true, requestId: 'r' },
      });
      await waitFor(() => Boolean(w.store.entry('runtime:' + conversationId)?.auto));
      check('5a. Runtime 会话首轮成功后生成标题', () =>
        w.store.entry('runtime:' + conversationId)?.auto?.title === '修复登录接口 401 错误');
      check('5b. Runtime 标题事件带 conversationId 与 sessionId', () => {
        const e = w.events.find((x) => x.type === 'session_title' && x.scope === 'runtime');
        return Boolean(e) && e.conversationId === conversationId && e.sessionId === s.id;
      });
      w.service.dispose();
    }
    {
      const w = makeWorld();
      const conversationId = crypto.randomUUID();
      w.service.observeRuntimeTurn({
        conversationId, sessionId: crypto.randomUUID(), sessionLocator: null, cwd,
        generationResult: { outcome: 'success', hasVisibleOutput: true },
      });
      await sleep(80);
      check('5c. 还没落盘的 Runtime 会话（无 locator）不触发', () => w.calls.length === 0);
      w.service.dispose();
    }
    {
      const w = makeWorld();
      w.service.observeRuntimeTurn({
        conversationId: 'not-a-uuid', sessionId: crypto.randomUUID(), sessionLocator: path.join(cwd, 'x.jsonl'), cwd,
        generationResult: { outcome: 'success', hasVisibleOutput: true },
      });
      await sleep(50);
      check('5d. 非法的 conversationId 被拒绝', () => w.calls.length === 0);
      w.service.dispose();
    }
    {
      const w = makeWorld();
      w.service.observeRuntimeTurn({
        conversationId: crypto.randomUUID(), sessionId: crypto.randomUUID(), sessionLocator: path.join(cwd, 'x.jsonl'), cwd,
        generationResult: { outcome: 'failed', hasVisibleOutput: true },
      });
      await sleep(50);
      check('5e. 失败 / 空回复的终态不触发', () => w.calls.length === 0);
      w.service.dispose();
    }

    /* ================= 6. 并发上限 ================= */
    section('6. 并发上限');
    {
      const w = makeWorld();
      const sessions = [1, 2, 3].map((n) => {
        const s = writeSession('conc-' + n, { entries: [
          { role: 'user', content: '问题' + n }, { role: 'assistant', content: '回答' + n, provider: 'p', model: 'm' },
        ] });
        return { ...s, id: String(n).repeat(16), sessionId: s.id };
      });
      let active = 0;
      let maxActive = 0;
      const gates = [];
      const svc = createSessionTitles({
        store: w.store,
        sdk: {
          generate: () => {
            active++;
            maxActive = Math.max(maxActive, active);
            return new Promise((resolve) => gates.push(() => { active--; resolve({ ok: true, text: '并发标题' }); }));
          },
          capability: () => ({ supported: true }),
        },
        readSessionText,
        resolveClassic: (id) => sessions.find((s) => s.id === id) || null,
        getCurrentCwd: () => cwd,
        publish: () => {},
      });
      const pending = sessions.map((s) => svc.generateClassic(s.id));
      await waitFor(() => gates.length >= 2);
      check('6a. 最多同时跑 2 个标题任务', () => maxActive === 2 && gates.length === 2);
      gates.shift()();
      /* 第一个任务结束后，队列里的第三个才会被 drain 起来并产生新 gate；
       * 不能只看 gates.length >= 1 —— 剩下的 gate2 会立刻让条件为真。 */
      await waitFor(() => gates.length >= 2);
      check('6b. 前一个结束后队列里的任务才开始', () => maxActive === 2);
      while (gates.length) gates.shift()();
      const results = await Promise.all(pending);
      check('6c. 三个任务最终都完成', () => results.every((r) => r.ok === true));
      svc.dispose();
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
})().catch((err) => {
  console.error('session-title-service 测试失败：', err);
  process.exit(1);
});
