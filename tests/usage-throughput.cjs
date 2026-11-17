/* 生成速度（TPS）专项测试（离线，纯内存 + jsdom）。
 *
 * 口径：TPS = 本轮 assistant 响应 usage.output 之和 / 各响应
 * message_start → message_end 的单调时长之和。工具等待不计入。
 *
 * 这里用显式时间戳调用计时入口，避免 sleep 带来的抖动；业务层
 * （usage.onAssistantMessageEnd / onTurnUsage / openCtxTip）走真实路径。
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  const ok = typeof cond === 'function' ? cond() : cond;
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok && typeof ok === 'string' ? '  → ' + ok : extra ? '  → ' + extra : ''));
  }
}

(async function main() {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'), { url: 'http://127.0.0.1/' });
  global.document = dom.window.document;
  global.window = dom.window;
  global.navigator = dom.window.navigator;
  global.fetch = async () => ({ json: async () => ({ ok: false }) });
  dom.window.fetch = global.fetch;

  const { S } = await import('../public/state.js');
  const usage = await import('../public/usage.js');
  const throughput = await import('../public/turn-throughput.js');

  const speedRow = () => {
    const rows = [...document.querySelectorAll('.tip-row')];
    return rows.find((row) => row.firstElementChild?.textContent === '生成速度');
  };
  const speedText = () => speedRow()?.lastElementChild?.textContent ?? null;
  const reset = (sessionId = 's1') => {
    S.workspaceGeneration = 1;
    S.state = { sessionId, model: { provider: 'deepseek', id: 'deepseek-v4-pro' } };
    S.localUsage.sessionId = sessionId;
    S.localUsage.lastTurn = null;
    throughput.resetThroughput();
  };
  const begin = (sessionId = 's1') => {
    reset(sessionId);
    usage.beginUsageTurn();
  };
  const assistantStart = (at) => usage.onAssistantMessageStart({ message: { role: 'assistant' } }, at);
  const assistantEnd = (at, message) => usage.onAssistantMessageEnd({ message: { role: 'assistant', ...message } }, at);

  console.log('=== 1. 基础口径：output / 响应时长 ===');
  begin();
  assistantStart(1000);
  assistantEnd(11000, { usage: { output: 450 } });
  usage.onTurnUsage({ output: 450 }, { source: 'message_end' });
  const snap1 = throughput.throughputSnapshot();
  check('单条响应：450 token / 10 秒 = 45 tokens/s', snap1.tokensPerSecond === 45, JSON.stringify(snap1));
  check('单条响应：输出与时长进入 lastTurn', S.localUsage.lastTurn.responseOutputTokens === 450
    && S.localUsage.lastTurn.responseDurationMs === 10000
    && S.localUsage.lastTurn.tokensPerSecond === 45);
  usage.openCtxTip();
  check('上下文浮层显示「生成速度」行', Boolean(speedRow()));
  check('上下文浮层显示 45 tokens/s', speedText() === '45 tokens/s', String(speedText()));
  check('非估算不显示「≈」', !String(speedText()).includes('≈'));

  console.log('=== 2. 同一 Agent turn 内多条响应累计，工具等待不计入 ===');
  begin();
  assistantStart(1000);
  assistantEnd(3000, { usage: { output: 300 } });      // 响应 1：2 秒
  // 工具执行从 3 秒跑到 90 秒；下一轮响应重新起表。
  assistantStart(90000);
  assistantEnd(91000, { usage: { output: 150 } });     // 响应 2：1 秒
  usage.onTurnUsage({ output: 150 }, { source: 'message_end' });
  const snap2 = throughput.throughputSnapshot();
  check('累计输出 450', snap2.outputTokens === 450, JSON.stringify(snap2));
  check('累计时长 3000ms（不含 87 秒工具等待）', snap2.durationMs === 3000, JSON.stringify(snap2));
  check('累计速度 150 tokens/s', snap2.tokensPerSecond === 150, JSON.stringify(snap2));
  usage.openCtxTip();
  check('浮层显示累计速度 150 tokens/s', speedText() === '150 tokens/s', String(speedText()));

  console.log('=== 3. 生成中：只显示「生成中…」，不编造实时速度 ===');
  begin();
  assistantStart(1000);
  usage.onTurnUsage({ output: 20 }, { source: 'message_update' });
  usage.openCtxTip();
  check('生成中显示「生成中…」', speedText() === '生成中…', String(speedText()));
  check('生成中不显示 tokens/s 数字', !String(speedText()).includes('tokens/s'));
  assistantEnd(2000, { usage: { output: 50 } });
  usage.onTurnUsage({ output: 50 }, { source: 'message_end' });
  usage.onTurnThroughputSettled();
  usage.openCtxTip();
  check('收尾后显示实测速度', speedText() === '50 tokens/s', String(speedText()));

  console.log('=== 4. 缺证据显示「—」，不显示 0 TPS ===');
  begin();
  assistantStart(1000);
  assistantEnd(1000, { usage: { output: 450 } });      // 时长为 0
  usage.onTurnUsage({ output: 450 }, { source: 'message_end' });
  usage.openCtxTip();
  check('响应时长为 0 → —', speedText() === '—', String(speedText()));
  check('响应时长为 0 → lastTurn 速度为 null', S.localUsage.lastTurn.tokensPerSecond === null);

  begin();
  assistantStart(1000);
  assistantEnd(5000, { usage: { output: 0 } });       // output 真实 0
  usage.onTurnUsage({ output: 0 }, { source: 'message_end' });
  usage.openCtxTip();
  check('output 为 0 → —（不是 0 tokens/s）', speedText() === '—', String(speedText()));

  begin();
  assistantStart(1000);
  assistantEnd(5000, { stopReason: 'stop', content: [{ type: 'text', text: '没有 usage 的普通结束' }] });
  usage.onTurnUsage({ output: 0 }, { source: 'message_end' });
  usage.openCtxTip();
  check('非中断且无 usage → —（不按字符估算）', speedText() === '—', String(speedText()));

  begin();
  assistantEnd(5000, { usage: { output: 12 } });
  usage.onTurnUsage({ output: 12 }, { source: 'message_end' });
  usage.openCtxTip();
  check('没有 message_start 时 → —', speedText() === '—', String(speedText()));

  console.log('=== 5. 被打断的响应：字符估算并标「≈」 ===');
  begin();
  assistantStart(1000);
  assistantEnd(5000, {
    stopReason: 'aborted',
    content: [{ type: 'text', text: 'x'.repeat(40) }],
  });
  usage.onTurnUsage({ output: 0 }, { source: 'message_update' });
  const snap5 = throughput.throughputSnapshot();
  check('估算输出 40 字 / 4 = 10 token', snap5.outputTokens === 10, JSON.stringify(snap5));
  check('估算时长仍用实测 4000ms', snap5.durationMs === 4000, JSON.stringify(snap5));
  check('估算标记为 true', snap5.estimated === true);
  usage.openCtxTip();
  check('估算显示「≈ 3 tokens/s」', speedText() === '≈ 3 tokens/s', String(speedText()));
  check('lastTurn 保留估算标记', S.localUsage.lastTurn.responseOutputEstimated === true);

  console.log('=== 6. 会话 / 工作区 / 清除后的隔离 ===');
  begin('session-A');
  assistantStart(1000);
  S.state = { sessionId: 'session-B', model: { provider: 'deepseek', id: 'deepseek-v4-pro' } };
  S.localUsage.sessionId = 'session-B';
  usage.clearSessionUsage();
  assistantEnd(11000, { usage: { output: 450 } });
  usage.onTurnUsage({ output: 450 }, { source: 'message_end' });
  usage.openCtxTip();
  check('切会话后迟到的 message_end 不产生 TPS', speedText() === '—', String(speedText()));

  begin('session-C');
  assistantStart(1000);
  S.workspaceGeneration++;
  assistantEnd(11000, { usage: { output: 450 } });
  usage.onTurnUsage({ output: 450 }, { source: 'message_end' });
  usage.openCtxTip();
  check('换工作区后迟到的 message_end 不产生 TPS', speedText() === '—', String(speedText()));

  begin('session-D');
  assistantStart(1000);
  usage.onTurnUsage({ output: 100 }, { source: 'message_update' });
  usage.applyState({ sessionId: 'session-D', model: { provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' } });
  assistantEnd(11000, { usage: { output: 500 } });
  usage.onTurnUsage({ output: 500 }, { source: 'message_end' });
  usage.openCtxTip();
  check('换模型后旧响应的时长不记到新模型', speedText() === '—', String(speedText()));

  console.log('=== 7. 回放事件不参与计时 ===');
  begin('session-E');
  usage.onAssistantMessageStart({ _replay: true, message: { role: 'assistant' } }, 1000);
  usage.onAssistantMessageEnd({ _replay: true, message: { role: 'assistant', usage: { output: 900 } } }, 5000);
  usage.onTurnThroughputSettled();
  usage.onTurnUsage({ output: 900 }, { source: 'message_end' });
  usage.openCtxTip();
  check('回放 start/end 被忽略，无 TPS', speedText() === '—', String(speedText()));

  console.log('=== 8. 静态契约 ===');
  const appSource = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const usageSource = fs.readFileSync(path.join(ROOT, 'public/usage.js'), 'utf8');
  check('app.js 在 agent_start 开始计时', /beginUsageTurn\(\)/.test(appSource));
  check('app.js 在 agent_settled 收口计时', /onTurnThroughputSettled\(\)/.test(appSource));
  const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');
  check('不使用 liveTurn.startedAt 计算 TPS', !/liveTurn/.test(stripComments(usageSource))
    && !/liveTurn/.test(stripComments(fs.readFileSync(path.join(ROOT, 'public/turn-throughput.js'), 'utf8'))));
  check('使用单调时钟 performance.now', /performance\.now\(\)/.test(fs.readFileSync(path.join(ROOT, 'public/turn-throughput.js'), 'utf8')));
  check('openCtxTip 的生成速度行使用 lastTurn 单一来源', /const lt = S\.localUsage\?\.lastTurn/.test(usageSource));

  console.log(`\n${pass}/${pass + fail} 通过`);
  dom.window.close();
  if (fail) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
