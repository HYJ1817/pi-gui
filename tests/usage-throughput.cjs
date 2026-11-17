/* 生成速度（TPS）专项测试（离线，纯内存 + jsdom）。
 *
 * 口径：TPS = Σ(有效响应的 usage.output) / Σ(对应响应的
 * message_start → message_end 单调时长)。逐条配对，缺一项整条丢弃；
 * 工具等待不计入。
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

  console.log('=== 2b. 逐条响应配对：只有同一条响应两项都有效才计入 ===');
  begin();
  /* A 没有开始时间：输出 300 不能进入分子。B 有效：450 / 10s。 */
  assistantEnd(2000, { usage: { output: 300 } });
  assistantStart(1000);
  assistantEnd(11000, { usage: { output: 450 } });
  usage.onTurnUsage({ output: 450 }, { source: 'message_end' });
  const pair1 = throughput.throughputSnapshot();
  check('第一条缺开始时间：只采用第二条的 450/10s', pair1.outputTokens === 450
    && pair1.durationMs === 10000 && pair1.tokensPerSecond === 45
    && pair1.validResponses === 1 && pair1.attempts === 2, JSON.stringify(pair1));

  begin();
  /* A 有效：300 / 2s。B 无开始时间：150 不能进入分子。 */
  assistantStart(1000);
  assistantEnd(3000, { usage: { output: 300 } });
  assistantEnd(5000, { usage: { output: 150 } });
  usage.onTurnUsage({ output: 300 }, { source: 'message_end' });
  const pair2 = throughput.throughputSnapshot();
  check('第二条缺开始时间：只采用第一条的 300/2s', pair2.outputTokens === 300
    && pair2.durationMs === 2000 && pair2.tokensPerSecond === 150
    && pair2.validResponses === 1 && pair2.attempts === 2, JSON.stringify(pair2));

  begin();
  /* A 有时长但缺 output；B 有效：450 / 5s。A 的时长不能被 B 的输出借用。 */
  assistantStart(1000);
  assistantEnd(3000, { stopReason: 'stop', content: [{ type: 'text', text: '没有 usage' }] });
  assistantStart(4000);
  assistantEnd(9000, { usage: { output: 450 } });
  usage.onTurnUsage({ output: 450 }, { source: 'message_end' });
  const pair3 = throughput.throughputSnapshot();
  check('某条缺 output：该条时长整条丢弃', pair3.outputTokens === 450
    && pair3.durationMs === 5000 && pair3.tokensPerSecond === 90
    && pair3.validResponses === 1 && pair3.attempts === 2, JSON.stringify(pair3));

  begin();
  /* 三条响应只有中间一条两项齐全：只计 200 / 2s。 */
  assistantEnd(2000, { usage: { output: 900 } });                 // 无开始
  assistantStart(3000);
  assistantEnd(5000, { usage: { output: 200 } });                 // 有效
  assistantStart(6000);
  assistantEnd(9000, { stopReason: 'stop' });                     // 无 output
  usage.onTurnUsage({ output: 200 }, { source: 'message_end' });
  const pair4 = throughput.throughputSnapshot();
  check('多条响应仅一条有效：只累计有效响应对', pair4.outputTokens === 200
    && pair4.durationMs === 2000 && pair4.tokensPerSecond === 100
    && pair4.validResponses === 1 && pair4.attempts === 3, JSON.stringify(pair4));

  begin();
  assistantEnd(5000, { usage: { output: 12 } });
  assistantEnd(7000, { usage: { output: 30 } });
  usage.onTurnUsage({ output: 30 }, { source: 'message_end' });
  const pairNone = throughput.throughputSnapshot();
  check('所有响应均无有效计时：输出/时长/速度都为 null', pairNone.outputTokens === null
    && pairNone.durationMs === null && pairNone.tokensPerSecond === null
    && pairNone.validResponses === 0 && pairNone.attempts === 2, JSON.stringify(pairNone));

  begin();
  /* 两次工具调用夹在两条有效响应之间：只累计两段响应时长，不含 90 秒空档。 */
  assistantStart(1000);
  assistantEnd(3000, { usage: { output: 300 } });
  assistantStart(93000);
  assistantEnd(95000, { usage: { output: 200 } });
  usage.onTurnUsage({ output: 200 }, { source: 'message_end' });
  const pairTools = throughput.throughputSnapshot();
  check('工具调用夹在两条响应之间：只累计 4 秒响应时间', pairTools.outputTokens === 500
    && pairTools.durationMs === 4000 && pairTools.tokensPerSecond === 125
    && pairTools.validResponses === 2, JSON.stringify(pairTools));

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
  usage.openCtxTip();
  check('非中断且无 usage → —（不按字符估算，也不伪造 lastTurn）',
    speedText() === '—' && S.localUsage.lastTurn === null, String(speedText()));

  begin();
  assistantEnd(5000, { usage: { output: 12 } });
  usage.openCtxTip();
  check('没有 message_start 时 → —（无 lastTurn 也能显示）',
    speedText() === '—' && S.localUsage.lastTurn === null, String(speedText()));

  console.log('=== 5. 被打断的响应：字符估算并标「≈」 ===');
  /* 真实序列：message_start → message_end(aborted，无 usage) → agent_settled。
   * 不调用 onTurnUsage，不伪造 lastTurn。 */
  begin();
  assistantStart(1000);
  assistantEnd(5000, {
    stopReason: 'aborted',
    content: [{ type: 'text', text: 'x'.repeat(40) }],
  });
  usage.onTurnThroughputSettled();
  const snap5 = throughput.throughputSnapshot();
  check('估算输出 40 字 / 4 = 10 token', snap5.outputTokens === 10, JSON.stringify(snap5));
  check('估算时长仍用实测 4000ms', snap5.durationMs === 4000, JSON.stringify(snap5));
  check('估算标记为 true', snap5.estimated === true);
  check('中断无 usage 时 lastTurn 保持 null（不伪造 usage）', S.localUsage.lastTurn === null);
  usage.openCtxTip();
  check('没有 lastTurn 也能显示估算速度「≈ 3 tokens/s」', speedText() === '≈ 3 tokens/s', String(speedText()));

  console.log('=== 5b. 中断响应的边界：无开始/无文本/切会话/新任务 ===');
  begin();
  assistantEnd(5000, {
    stopReason: 'aborted',
    content: [{ type: 'text', text: 'y'.repeat(40) }],
  });
  usage.onTurnThroughputSettled();
  usage.openCtxTip();
  check('中断但没有开始时间 → —，不借用其他时长', speedText() === '—', String(speedText()));

  begin();
  assistantStart(1000);
  assistantEnd(5000, { stopReason: 'aborted', content: [] });
  usage.onTurnThroughputSettled();
  usage.openCtxTip();
  check('中断但没有可见文本 → —，不凭空估算', speedText() === '—', String(speedText()));

  begin('session-abort');
  assistantStart(1000);
  assistantEnd(5000, {
    stopReason: 'aborted',
    content: [{ type: 'text', text: 'z'.repeat(40) }],
  });
  usage.onTurnThroughputSettled();
  usage.openCtxTip();
  check('中断估算先正常显示', speedText() === '≈ 3 tokens/s', String(speedText()));
  S.state = { sessionId: 'session-next', model: { provider: 'deepseek', id: 'deepseek-v4-pro' } };
  S.localUsage.sessionId = 'session-next';
  usage.clearSessionUsage();
  usage.openCtxTip();
  check('中断后切换会话：旧估算消失', speedText() === null, String(speedText()));

  begin('session-new-task');
  assistantStart(1000);
  assistantEnd(5000, {
    stopReason: 'aborted',
    content: [{ type: 'text', text: 'q'.repeat(40) }],
  });
  usage.onTurnThroughputSettled();
  usage.beginUsageTurn();
  usage.openCtxTip();
  check('中断后开始新任务：先显示生成中，不沿用旧估算', speedText() === '生成中…', String(speedText()));
  assistantStart(6000);
  assistantEnd(8000, { usage: { output: 100 } });
  usage.onTurnUsage({ output: 100 }, { source: 'message_end' });
  usage.onTurnThroughputSettled();
  usage.openCtxTip();
  check('新任务的真实速度不被旧估算污染', speedText() === '50 tokens/s', String(speedText()));

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
  check('生成速度行优先读取 throughputSnapshot，不要求 lastTurn',
    /snapshot\.status === 'ready'/.test(usageSource) && /throughput\.attempts > 0/.test(usageSource));
  check('ledger 逐条配对：duration 与 output 缺一即整条丢弃',
    /duration == null \|\| output == null/.test(fs.readFileSync(path.join(ROOT, 'public/turn-throughput.js'), 'utf8')));

  console.log(`\n${pass}/${pass + fail} 通过`);
  dom.window.close();
  if (fail) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
