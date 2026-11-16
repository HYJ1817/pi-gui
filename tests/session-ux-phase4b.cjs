/* 会话 UX P4-B：结构化错误恢复动作。
 *
 * 只测行为与安全契约：哪些结构化失败允许出现动作、动作在错误块里如何
 * 展示与执行、执行中/失败/重复点击、无会话上下文、会话变化、无命令副作用、
 * 原始错误保留与敏感字段不落地。真实排版见 tests/session-ux-phase4b-shots.cjs。
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const url = rel => pathToFileURL(path.join(PUB, rel)).href;
const text = value => ({ type: 'text', text: value });

let passed = 0;
let failed = 0;
function ok(label, value) {
  try {
    if (typeof value === 'function') value();
    else assert.ok(value, label);
    passed++;
    console.log('  ok  ' + label);
  } catch (error) {
    failed++;
    console.error('  FAIL ' + label + ': ' + error.message);
  }
}
const equal = (a, b, label) => ok(label, () => assert.equal(a, b));
const deep = (a, b, label) => ok(label, () => assert.deepEqual(a, b));

const fail = (cls, statusCode, extra = {}) => ({
  class: cls, retryable: false, reason: '安全原因', source: 'pi-assistant', statusCode, ...extra,
});
const authFailure = (code = 401) => fail('auth_error', code);
const modelFailure = () => fail('model_unavailable', 404);

(async () => {
  console.log('P4-B 恢复策略');
  const R = await import(url('error-recovery.js'));
  {
    const cases = [
      ['401 认证失败', authFailure(401), 'provider_auth'],
      ['403 供应商权限拒绝', authFailure(403), 'provider_auth'],
      ['404 模型不存在', modelFailure(), 'model_picker'],
      ['429 限流', fail('rate_limited', 429), null],
      ['余额耗尽', fail('quota_exhausted', 429), null],
      ['provider 不可用', fail('provider_unavailable', 503), null],
      ['5xx 可重试错误', fail('retryable_provider_error', 500), null],
      ['请求不兼容', fail('request_incompatible', 400), null],
      ['上下文超限', fail('context_overflow', 400), null],
      ['请求已取消', fail('user_cancelled', null), null],
      ['未知错误', fail('unknown', null), null],
    ];
    for (const [label, failure, expected] of cases) {
      equal(R.recoveryForFailure(failure)?.id || null, expected, label + ' 的动作匹配');
    }
    equal(R.recoveryForFailure(authFailure(401))?.label, '检查供应商认证', '认证动作文案');
    equal(R.recoveryForFailure(modelFailure())?.label, '选择其他模型', '模型动作文案');
    equal(R.recoveryForFailure({ ...authFailure(401), source: 'tool' }), null, '不可信来源不给动作');
    equal(R.recoveryForFailure({ ...authFailure(401), source: 'unknown' }), null, '未知来源不给动作');
    equal(R.recoveryForFailure({ ...authFailure(401), statusCode: 500 }), null, '类别与状态码不匹配不给动作');
    equal(R.recoveryForFailure({ ...modelFailure(), statusCode: 401 }), null, '模型错误缺少 404 证据不给动作');
    equal(R.recoveryForFailure({ class: 'auth_error', source: 'pi-assistant' }), null, '缺少状态码证据不给动作');
    const secret = R.recoveryForFailure(authFailure(401, { apiKey: 'SECRET_KEY', message: 'SECRET_MESSAGE', raw: 'SECRET_RAW' }));
    ok('动作对象不携带原始 payload', !JSON.stringify(secret).includes('SECRET'));
    const first = R.recoveryForFailure(authFailure(401));
    first.label = 'tampered';
    equal(R.recoveryForFailure(authFailure(401)).label, '检查供应商认证', '返回值是副本，不污染常量');
  }

  console.log('P4-B 服务端结构化链路');
  {
    const { createModelGeneration } = await import('../server/model-generation.js');
    const settledFailure = (errorMessage) => {
      const o = createModelGeneration();
      o.noteCommandAccepted({ type: 'prompt', id: 'owned' });
      o.observe({ type: 'response', command: 'prompt', id: 'owned', success: true, data: { disposition: 'started' } });
      o.observe({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage } });
      return o.observe({ type: 'agent_settled' }).generationResult;
    };
    const auth = settledFailure('401 {"error":{"code":"invalid_api_key"}}');
    equal(auth.failure.class, 'auth_error', '服务端识别 401 认证失败');
    equal(R.recoveryForFailure(auth.failure)?.id, 'provider_auth', '认证失败映射到供应商认证');
    const model = settledFailure('404 {"error":{"code":"model_not_found"}}');
    equal(R.recoveryForFailure(model.failure)?.id, 'model_picker', '模型不存在映射到模型列表');
    const limited = settledFailure('429 {"error":{"code":"rate_limit_exceeded"}}');
    equal(R.recoveryForFailure(limited.failure), null, '限流不显示动作');
    const unknown = settledFailure('404 page missing');
    equal(R.recoveryForFailure(unknown.failure), null, '不可靠的 404 文本不显示动作');
    ok('归一化失败对象不含原始错误正文', !JSON.stringify(auth).includes('invalid_api_key'));
  }

  console.log('P4-B 错误块交互');
  const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), {
    url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  const d = w.document;
  global.window = w;
  global.document = d;
  global.localStorage = w.localStorage;
  global.HTMLElement = w.HTMLElement;
  global.Event = w.Event;
  global.CustomEvent = w.CustomEvent;
  global.Node = w.Node;
  global.MutationObserver = w.MutationObserver;
  global.ResizeObserver = w.ResizeObserver;
  global.requestAnimationFrame = w.requestAnimationFrame.bind(w);
  global.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  global.fetch = w.fetch;

  const M = await import(url('messages.js'));
  const { S } = await import(url('state.js'));
  const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

  const renderError = (message = '当前模型认证失败，自动备用未执行') => {
    M.clearThread();
    M.beginTurn();
    M.onMessageStart({ message: { role: 'user', content: [text('触发错误')] } });
    M.onMessageStart({ message: { role: 'assistant' } });
    M.onMessageEnd({ message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: message } });
    return d.querySelector('#stream .msg-err');
  };

  {
    const err = renderError();
    const box = M.attachErrorRecovery(R.recoveryForFailure(authFailure(401)), { run: async () => ({ ok: true, message: '已打开供应商认证。' }) });
    ok('错误块内生成恢复入口', Boolean(box) && box === err.querySelector('.me-actions'));
    equal(box.querySelectorAll('button').length, 1, '每类错误最多一个主要动作');
    equal(box.querySelector('.me-action')?.textContent, '检查供应商认证', '动作文案来自允许列表');
    ok('动作带可读说明', /供应商与认证/.test(box.querySelector('.me-action')?.title || ''));
    equal(err.querySelector('.me-raw')?.textContent, '当前模型认证失败，自动备用未执行', '原始错误保留');
    equal(box.querySelector('.me-action-status')?.getAttribute('role'), 'status', '动作结果有状态语义');
    equal(box.querySelector('.me-action-status')?.getAttribute('aria-live'), 'polite', '动作结果可被读屏播报');
    ok('动作按钮复用现有紧凑按钮样式', box.querySelector('button').classList.contains('tiny'));
  }

  {
    M.clearThread();
    equal(M.attachErrorRecovery(R.recoveryForFailure(authFailure(401)), { run: async () => ({ ok: true }) }), null, '没有错误块时不生成入口');
    const err = renderError();
    equal(M.attachErrorRecovery(null, { run: async () => ({ ok: true }) }), null, '没有动作时不生成入口');
    equal(M.attachErrorRecovery(R.recoveryForFailure(authFailure(401)), {}), null, '没有执行器时不生成入口');
    equal(err.querySelectorAll('.me-actions').length, 0, '拒绝路径不留下空容器');
  }

  {
    renderError();
    let runs = 0;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const box = M.attachErrorRecovery(R.recoveryForFailure(authFailure(401)), {
      run: () => { runs++; return pending; },
    });
    const btn = box.querySelector('button');
    const status = box.querySelector('.me-action-status');
    btn.click();
    btn.click();
    equal(runs, 1, '重复点击只执行一次');
    ok('执行中按钮禁用', btn.disabled === true);
    equal(btn.getAttribute('aria-busy'), 'true', '执行中暴露 aria-busy');
    equal(status.textContent, '正在打开…', '执行中有可见状态');
    release({ ok: true, message: '已打开供应商认证。' });
    await tick();
    equal(runs, 1, '执行中重复点击没有第二次执行');
    equal(btn.disabled, false, '完成后恢复按钮');
    equal(btn.getAttribute('aria-busy'), null, '完成后移除 aria-busy');
    equal(status.textContent, '已打开供应商认证。', '成功结果就地展示');
    equal(status.dataset.state, 'success', '成功状态可区分');
    ok('成功后原始错误仍在', d.querySelector('#stream .me-raw')?.textContent.includes('当前模型认证失败'));

    let releaseFail;
    const failPending = new Promise(resolve => { releaseFail = resolve; });
    const box2 = M.attachErrorRecovery(R.recoveryForFailure(authFailure(401)), {
      run: () => failPending,
    });
    box2.querySelector('button').click();
    releaseFail({ ok: false, message: '设置没有打开，请重试。' });
    await tick();
    equal(box2.querySelector('.me-action-status').textContent, '设置没有打开，请重试。', '失败结果就地展示');
    equal(box2.querySelector('.me-action-status').dataset.state, 'error', '失败状态可区分');
    equal(box2.querySelector('button').disabled, false, '失败后允许再次尝试');
    ok('失败后原始错误仍在', d.querySelector('#stream .me-raw')?.textContent.includes('当前模型认证失败'));

    const box3 = M.attachErrorRecovery(R.recoveryForFailure(authFailure(401)), {
      run: async () => { throw new Error('SECRET throw'); },
    });
    box3.querySelector('button').click();
    await tick();
    equal(box3.querySelector('.me-action-status').textContent, '操作失败，请稍后重试。', '异常被收口为安全提示');
    ok('异常文本不落地', !d.querySelector('#stream').textContent.includes('SECRET'));
  }

  console.log('P4-B 装配层：真实设置入口与会话边界');
  const appDom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), {
    url: 'http://localhost:7791', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const aw = appDom.window;
  const ad = aw.document;
  let emit = null;
  const calls = [];
  aw.matchMedia = () => ({ matches: false, addEventListener() {} });
  aw.ResizeObserver = class { observe() {} disconnect() {} };
  aw.HTMLElement.prototype.scrollIntoView = () => {};
  aw.EventSource = class {
    constructor() { emit = event => this.onmessage?.({ data: JSON.stringify(event) }); }
    close() {}
  };
  aw.fetch = async (request, opts = {}) => {
    if (request === '/api/command') calls.push(JSON.parse(opts.body));
    return {
      ok: true,
      json: async () => request === '/api/project-config'
        ? { ok: true, hasProject: true, cwd: 'fixture', config: {}, defaults: {}, thinkingLevels: [] }
        : { ok: true, items: [], sessions: [] },
    };
  };
  aw.eval(bundle(path.join(PUB, 'app.js')).code);
  await new Promise(resolve => setTimeout(resolve, 30));

  const A = { providerId: 'provider-a', modelId: 'model-a' };
  const B = { providerId: 'provider-b', modelId: 'model-b' };
  const resetApp = () => {
    ad.querySelector('#modal').hidden = true;
    ad.querySelector('#composerPopover').hidden = true;
    calls.length = 0;
    Object.assign(aw.S, {
      hasProject: true, bridgeState: 'ready', bridgeRun: 1, cwd: 'fixture',
      streaming: false, stopping: false, switching: false, modelSwitchPending: false, fallbackActive: false,
    });
    aw.onModels({ models: [A, B] });
    aw.applyState({ model: A, sessionId: 'session-p4b', thinkingLevel: 'off' });
    aw.clearThread();
  };
  const errorText = failure => failure?.class === 'model_unavailable'
    ? '404 {"error":{"code":"model_not_found"}}'
    : '当前模型认证失败，自动备用未执行';
  /* 真实事件顺序：agent_start 打开 streaming，message_start/message_end 产出
   * 错误块，agent_settled 才收口并挂恢复入口。不再手动把 streaming 预置为
   * false —— 那会掩盖「收口前判断恢复动作」的时序缺陷。 */
  const runGeneration = async (failure, { extra = {}, errorMessage = errorText(failure), beforeSettle } = {}) => {
    emit({ type: 'message_start', message: { role: 'user', content: [text('请回答')] } });
    emit({ type: 'agent_start', bridgeRun: 1 });
    emit({ type: 'message_start', message: { role: 'assistant' } });
    emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage } });
    beforeSettle?.();
    emit({ type: 'agent_settled', bridgeRun: 1,
      generationResult: { requestId: 'owned-p4b', outcome: 'failed', hasVisibleOutput: false, failure, ...extra } });
    await tick();
  };
  const actionButton = () => ad.querySelector('#stream .me-action');
  const statusText = () => ad.querySelector('#stream .me-action-status')?.textContent || '';
  const commands = () => calls.map(command => command.type);

  {
    resetApp();
    await runGeneration(authFailure(401), {
      beforeSettle: () => {
        equal(aw.S.streaming, true, 'agent_start 到 message_end 之间仍在运行');
        equal(actionButton(), null, 'agent_settled 收口前不提前生成动作');
      },
    });
    equal(aw.S.streaming, false, 'agent_settled 后 streaming 已收口');
    equal(actionButton()?.textContent, '检查供应商认证', '401 在真实事件顺序显示认证入口');
    const beforeRaw = ad.querySelector('#stream .me-raw')?.textContent;
    actionButton().click();
    await tick();
    equal(ad.querySelector('#modal').hidden, false, '点击打开既有设置弹窗');
    ok('弹窗是供应商与认证页', /供应商与认证/.test(ad.querySelector('#modalCard')?.textContent || ''));
    equal(statusText(), '已打开供应商认证。', '操作成功就地反馈');
    equal(ad.querySelector('#stream .me-raw')?.textContent, beforeRaw, '打开设置不改变原始错误');
    deep(commands().filter(type => ['prompt', 'steer', 'follow_up', 'set_model', 'new_session', 'switch_session', 'fork', 'abort'].includes(type)), [], '恢复动作不发命令');
    equal(aw.S.state.sessionId, 'session-p4b', '恢复动作不切换会话');
    ad.querySelector('#modal').hidden = true;
  }

  {
    resetApp();
    await runGeneration(authFailure(403));
    equal(actionButton()?.textContent, '检查供应商认证', '403 供应商权限拒绝显示认证入口');
    actionButton().click();
    await tick();
    equal(ad.querySelector('#modal').hidden, false, '403 打开既有认证设置');
    ad.querySelector('#modal').hidden = true;
  }

  {
    /* 用户报告的时序：agent_start → message_start → message_end(404) →
     * agent_settled。修复前 attachGenerationRecovery 在 onSettled 之前运行，
     * 此处 streaming 仍为 true，模型入口会被吞掉。 */
    resetApp();
    emit({ type: 'message_start', message: { role: 'user', content: [text('请回答')] } });
    emit({ type: 'agent_start', bridgeRun: 1 });
    equal(aw.S.streaming, true, 'agent_start 后 streaming=true');
    emit({ type: 'message_start', message: { role: 'assistant' } });
    emit({ type: 'message_end', message: {
      role: 'assistant', content: [], stopReason: 'error',
      errorMessage: '404 {"error":{"code":"model_not_found"}}',
    } });
    equal(aw.S.streaming, true, 'message_end 后 streaming 仍为 true');
    equal(actionButton(), null, 'agent_settled 收口前不生成模型入口');
    emit({ type: 'agent_settled', bridgeRun: 1,
      generationResult: { requestId: 'owned-p4b', outcome: 'failed', hasVisibleOutput: false, failure: modelFailure() } });
    await tick();
    equal(aw.S.streaming, false, 'agent_settled 后 streaming=false');
    equal(actionButton()?.textContent, '选择其他模型', '真实 404 事件顺序显示模型入口');
    actionButton().click();
    await tick();
    ok('模型列表弹层打开', ad.querySelector('#composerPopover')?.hidden === false);
    equal(statusText(), '已打开模型列表。', '模型入口成功反馈');
    deep(commands().filter(type => ['set_model', 'prompt', 'new_session', 'switch_session'].includes(type)), [], '不自动换模型也不发请求');
    equal(aw.S.state.model.modelId, 'model-a', '当前模型保持不变');
    ad.querySelector('#composerPopover').hidden = true;
  }

  {
    const silent = [
      ['限流', fail('rate_limited', 429)],
      ['余额不足', fail('quota_exhausted', 429)],
      ['provider 不可用', fail('provider_unavailable', 503)],
      ['5xx', fail('retryable_provider_error', 500)],
      ['请求不兼容', fail('request_incompatible', 400)],
      ['上下文超限', fail('context_overflow', 400)],
      ['取消', fail('user_cancelled', null)],
      ['未知错误', fail('unknown', null)],
    ];
    for (const [label, failure] of silent) {
      resetApp();
      await runGeneration(failure);
      equal(actionButton(), null, label + '不显示恢复按钮');
    }
  }

  {
    resetApp();
    await runGeneration({ ...authFailure(401), source: 'tool', apiKey: 'SECRET_KEY', message: 'SECRET_MESSAGE' });
    equal(actionButton(), null, '不可信来源不显示动作');
    ok('不可信失败不泄露字段', !ad.querySelector('#stream').textContent.includes('SECRET'));
    resetApp();
    await runGeneration(authFailure(401), { extra: { requestId: undefined } });
    equal(actionButton(), null, '没有请求归属不显示动作');
    resetApp();
    await runGeneration(authFailure(401), { extra: { outcome: 'success' } });
    equal(actionButton(), null, '成功结果不显示动作');
    resetApp();
    await runGeneration(fail('unknown', null));
    emit({ type: 'agent_settled', _replay: true, bridgeRun: 1,
      generationResult: { requestId: 'replay-p4b', outcome: 'failed', hasVisibleOutput: false, failure: authFailure(401) } });
    await tick();
    equal(actionButton(), null, '历史回放不生成动作');
  }

  {
    resetApp();
    await runGeneration(authFailure(401));
    ok('认证入口已生成', Boolean(actionButton()));
    aw.S.state.sessionId = 'another-session';
    actionButton().click();
    await tick();
    equal(statusText(), '会话或模型已变化，未执行操作。', '切走会话后拒绝执行');
    equal(ad.querySelector('#modal').hidden, true, '拒绝执行时没有打开设置');
    deep(commands().filter(type => ['new_session', 'switch_session', 'fork'].includes(type)), [], '拒绝执行也不切换会话');
    equal(aw.S.state.sessionId, 'another-session', '当前会话保持不变');
  }

  {
    resetApp();
    await runGeneration(authFailure(401));
    aw.S.state.model = B;
    actionButton().click();
    await tick();
    equal(statusText(), '会话或模型已变化，未执行操作。', '模型已变化后拒绝使用旧错误上的动作');
    equal(ad.querySelector('#modal').hidden, true, '模型变化时没有打开设置');
  }

  {
    resetApp();
    aw.S.state.sessionId = null;
    aw.S.state.sessionFile = null;
    await runGeneration(authFailure(401));
    equal(actionButton(), null, '无会话上下文时不生成恢复入口');
    resetApp();
    aw.S.bridgeState = 'error';
    await runGeneration(authFailure(401));
    equal(actionButton(), null, 'Pi 未就绪时不生成恢复入口');
    resetApp();
    await runGeneration(modelFailure());
    ok('模型入口已生成', Boolean(actionButton()));
    emit({ type: 'agent_start', bridgeRun: 1 });
    equal(aw.S.streaming, true, '新一轮开始时 streaming=true');
    actionButton().click();
    await tick();
    equal(statusText(), '当前状态无法打开该设置，请稍后重试。', '运行中拒绝打开模型列表');
    equal(ad.querySelector('#composerPopover').hidden, true, '运行中不打开模型列表');
    resetApp();
    aw.S.models = [];
    await runGeneration(modelFailure());
    equal(actionButton(), null, '模型列表未知时不生成模型入口');
    resetApp();
    aw.S.fallbackActive = true;
    await runGeneration(modelFailure());
    equal(actionButton(), null, '自动备用接管模型错误时不并排手动入口');
    resetApp();
    await runGeneration(authFailure(401));
    ok('认证错误不受自动备用影响', Boolean(actionButton()));
  }

  {
    resetApp();
    await runGeneration(authFailure(401));
    actionButton().focus();
    ok('动作按钮可键盘聚焦', ad.activeElement === actionButton());
    ok('动作按钮复用现有按钮类', actionButton().classList.contains('btn') && actionButton().classList.contains('tiny'));
  }

  {
    /* 历史重建只有归一后的错误原因，没有结构化失败：不得凭空生成动作。 */
    aw.clearThread();
    aw.rebuildFromMessages([
      { role: 'user', content: [text('历史错误')] },
      { role: 'assistant', timestamp: 1200, stopReason: 'error', errorMessage: '当前模型认证失败，自动备用未执行', content: [] },
    ]);
    equal(ad.querySelectorAll('#stream .me-actions').length, 0, '历史重建不生成恢复动作');
    equal(ad.querySelectorAll('#stream .msg-err').length, 1, '历史错误原文仍然展示');
  }

  console.log(`\nSession UX P4-B: ${passed}/${passed + failed} 通过`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
