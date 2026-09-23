/* 端到端验收：真实浏览器 → 真实服务 → 真实 pi。
 *
 * 验证用户提的核心需求那条链路：
 *   选文件 → 后端抽取文本 → 拼成 <pi-file> 块 → 发给 pi → 回复渲染出来
 * 之前只分别验过碎片（抽取器 / images 字段 / 前端渲染），没串起来跑过。
 *
 * 两件事分开断言，避免把「上游模型挂了」误判成「附件功能坏了」：
 *   A. 附件链路：Node 侧监听事件流，确认 pi 收到的用户消息里带着文档正文
 *   B. 结果呈现：要么有正常回复，要么有可见的错误块 —— 但绝不能是一片空白
 *
 * 会真实调用一次模型。用法：node tests/e2e-attach.cjs [pdf路径]
 * 只用于开发期验收，不属于产品代码。 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9225);
const APP = process.env.APP_URL || 'http://127.0.0.1:7788/';
const OUT = path.join(__dirname, '..', '.shots');

const PDF = process.argv[2] || path.join(os.tmpdir(), 'pi-gui-fixtures', '发酵罐空气分布器设计.pdf');
// 答案就在文档里：「空气分布器出口内径 d ≈ 0.282 m，圆整后取 DN300」
const ASK = '这份文档里空气分布器出口内径的计算结果是多少？只回数值和单位，不要任何解释。';
// 只可能来自文档正文，用来证明正文真的送到了 pi
const NEEDLE = 'DN300';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Node 侧监听事件流 ---------- */
function watchEvents(sink) {
  const ac = new AbortController();
  fetch(APP + 'api/events', { signal: ac.signal })
    .then(async (r) => {
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) {
          if (!l.startsWith('data: ')) continue;
          try { sink(JSON.parse(l.slice(6))); } catch { /* 忽略半截 */ }
        }
      }
    })
    .catch(() => { /* 主动中断 */ });
  return () => ac.abort();
}

async function main() {
  if (!fs.existsSync(PDF)) throw new Error('找不到测试 PDF：' + PDF + '（先跑 npm run fixtures）');
  fs.mkdirSync(OUT, { recursive: true });
  console.log('附件: ' + path.basename(PDF) + '  (' + fs.statSync(PDF).size + ' 字节)');

  const events = [];
  const stopWatch = watchEvents((e) => events.push(e));

  const chrome = spawn(
    CHROME,
    [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--disable-sync', '--disable-component-update', '--disable-background-networking',
      '--disable-default-apps', '--metrics-recording-only', '--hide-scrollbars',
      `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(OUT, 'e2e')}`,
      '--window-size=1440,900', 'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = await r.json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch { /* 等 */ }
  }
  const page = targets && targets.find((t) => t.type === 'page');
  if (!page) throw new Error('拿不到 DevTools page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const errs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params?.exceptionDetails?.text || '异常');
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 240));
    return r.result?.result?.value;
  };
  const shot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, 'e2e-' + n + '.png');
    fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    console.log('  截图: ' + path.basename(p));
  };
  const waitFor = async (expr, ms, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evalJs(expr).catch(() => false)) return true;
      await sleep(400);
    }
    throw new Error('等待超时：' + label);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Page.navigate', { url: APP });
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    if (await evalJs('document.querySelector("#connText").textContent').catch(() => null)) break;
  }
  await sleep(1500);
  console.log('连接状态: ' + (await evalJs('document.querySelector("#connText").textContent')));

  /* 1. 选文件 —— 走真实 #fileInput */
  const r = await send('Runtime.evaluate', { expression: 'document.querySelector("#fileInput")' });
  const objectId = r.result?.result?.objectId;
  if (!objectId) throw new Error('拿不到 #fileInput');
  await send('DOM.setFileInputFiles', { files: [PDF], objectId });

  await waitFor('document.querySelectorAll("#attachTray .att:not(.loading)").length >= 1', 60000, '附件解析完成');
  console.log('1) 附件解析: ' + (await evalJs('document.querySelector("#attachTray .att").textContent.replace(/\\s+/g," ").trim()')));
  await shot('1-attached');

  /* 2. 提问并发送 */
  await evalJs(`(() => {
    const t = document.querySelector('#input');
    t.value = ${JSON.stringify(ASK)};
    t.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(300);
  await evalJs('document.querySelector("#btnSend").click()');

  /* 3. 等 pi 跑完 */
  await waitFor('!document.querySelector("#btnStop").hidden', 30000, '进入流式状态');
  console.log('2) 已进入流式，等 pi 结束…');
  await waitFor('document.querySelector("#btnStop").hidden', 240000, 'pi 结束');

  /* 4. A. 附件链路：pi 收到的用户消息里必须带着文档正文 */
  const userMsg = events
    .filter((e) => e.type === 'message_end' && e.message?.role === 'user')
    .map((e) => (Array.isArray(e.message.content) ? e.message.content.map((c) => c.text || '').join('') : ''))
    .pop() || '';
  const chainOk = userMsg.includes('<pi-file') && userMsg.includes(NEEDLE);
  console.log('3) 附件链路: ' + (chainOk ? `✅ pi 收到正文（含 ${NEEDLE}）` : '❌ 正文没送到 pi'));
  if (!chainOk) console.log('   实际收到: ' + JSON.stringify(userMsg.slice(0, 300)));

  /* 5. B. 结果呈现：有回复，或者有可见的错误块 —— 但不能是空白 */
  const lastAssistant = events.filter((e) => e.type === 'message_end' && e.message?.role === 'assistant').pop();
  const am = lastAssistant?.message || {};
  const hasText = (am.content || []).some((c) => c.type === 'text' && (c.text || '').trim());
  const apiError = am.stopReason === 'error' || am.errorMessage;

  const dom = JSON.parse(await evalJs(`(() => {
    const t = document.querySelector('#stream .thread');
    const ub = [...t.querySelectorAll('.msg.user .msg-body')].pop();
    const ab = [...t.querySelectorAll('.msg.assistant .msg-body')].pop();
    return JSON.stringify({
      fileCard: ub?.querySelector('.msg-file-head span')?.textContent || '',
      userRawTag: /<pi-file/.test(ub?.textContent || ''),
      reply: (ab?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      errBlock: ab?.querySelector('.me-head')?.textContent || '',
      note: ab?.querySelector('.msg-note')?.textContent || '',
    });
  })()`));
  console.log('4) 对话区: ' + JSON.stringify(dom));

  const renderOk = dom.fileCard && !dom.userRawTag && (dom.reply || dom.errBlock || dom.note);
  const pass = chainOk && renderOk;

  console.log('');
  if (chainOk && apiError) {
    console.log('⚠️  附件链路正常，但模型调用失败（上游问题，不是本项目的 bug）：');
    console.log('    ' + String(am.errorMessage || am.stopReason).slice(0, 200));
    console.log('    错误已在界面显示为「' + dom.errBlock + '」——这正是本轮修的问题。');
  } else if (pass) {
    const answered = /0\.28|DN300|282/.test(dom.reply);
    console.log(answered ? '✅ 端到端通过：PDF 文本送达 pi，且回复命中文档内容' : '✅ 端到端通过：链路与呈现都正常（回复未命中关键词，请人工看一眼）');
  } else {
    console.log('❌ 端到端未通过');
  }
  await shot('2-result');
  console.log('页面异常: ' + (errs.length ? errs.join(' | ') : '无'));

  stopWatch();
  ws.close();
  chrome.kill();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.log('失败: ' + e.message);
  process.exit(1);
});
