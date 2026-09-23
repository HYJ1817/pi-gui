/* 给「已经跑起来的 Electron 窗口」截图 + 取证。
 *
 * 和 cdp-shot.cjs 的区别：那个是自己拉一个 Chrome 去访问网页，
 * 这个是连到 Electron 应用自己的调试端口，截的是应用窗口里的真实内容。
 *
 * 用法：先带调试端口启动应用，再跑本脚本
 *   electron . --remote-debugging-port=9222
 *   node tests/shot-app.cjs
 *
 * 除了截图，还会读几项运行期事实：userAgent 里有没有 Electron
 * （这是「独立应用窗口」而非「浏览器标签页」的硬证据）、页面尺寸、
 * 有没有渲染出对话内容、控制台有没有报错。
 */
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.CDP_PORT || 9222);
const OUT = path.join(__dirname, '..', '.shots');
const TAG = (() => {
  const eq = process.argv.find((a) => a.startsWith('--tag='));
  if (eq) return eq.slice(6);
  const i = process.argv.indexOf('--tag');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'app';
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickPage() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!page) throw new Error('调试端口上没有页面目标，应用起来了吗？');
  return page;
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return { ws, ready, send, events };
}

(async () => {
  const page = await pickPage();
  const { ready, send, events } = connect(page.webSocketDebuggerUrl);
  await ready;

  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(2500); // 等前端把历史渲染完

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  };

  const facts = await evaluate(`(() => {
    const t = document.querySelector('#stream .thread');
    const cs = getComputedStyle(document.body);
    // 带 hidden 属性的元素，实际是否真的不可见。
    // 这是 jsdom 测不出来的那类问题：JS 侧 el.hidden 是对的，
    // 但组件自己的 display 规则把 [hidden]{display:none} 盖掉了。
    const hiddenProbe = {};
    for (const sel of ['#modal', '#btnStop', '#attachTray']) {
      const el = document.querySelector(sel);
      if (!el) { hiddenProbe[sel] = 'missing'; continue; }
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const visuallyHidden = style.display === 'none' || rect.width === 0 || rect.height === 0;
      hiddenProbe[sel] = {
        attr: el.hidden,
        display: style.display,
        visible: !visuallyHidden,
      };
    }
    // 自绘标题栏（titleBarStyle:'hidden'）的运行期事实。
    // 这几项都是「只在真实窗口里量得到、jsdom 完全测不了」的那类：
    //   frameGap      外框减视口。标题栏并进客户区后，垂直差值应当明显变小
    //   captionReserve 顶栏最右图标到窗口右边的距离。必须够放下 3 个原生按钮（3×46）
    //   drag*         -webkit-app-region 是否配对（漏了窗口拖不动 / 按钮点不动）
    const head = document.querySelector('.head-right');
    const headRight = head ? Math.round(head.getBoundingClientRect().right) : null;
    const region = (sel) => {
      const n = document.querySelector(sel);
      if (!n) return 'missing';
      return getComputedStyle(n).getPropertyValue('-webkit-app-region').trim() || '(空)';
    };
    const titlebar = {
      frameGap: [window.outerWidth - window.innerWidth, window.outerHeight - window.innerHeight],
      captionReserve: headRight === null ? null : window.innerWidth - headRight,
      dragRail: region('.rail-head'),
      dragStage: region('.stage-head'),
      dragBtn: region('#btnStats'),
    };

    return {
      ua: navigator.userAgent,
      title: document.title,
      inner: [window.innerWidth, window.innerHeight],
      outer: [window.outerWidth, window.outerHeight],
      hasThread: !!t,
      msgs: document.querySelectorAll('#stream .thread .msg').length,
      bg: cs.backgroundColor,
      hiddenProbe,
      titlebar,
    };
  })()`);

  fs.mkdirSync(OUT, { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUT, `${TAG}-window.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));

  const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown');
  const errLogs = events.filter(
    (e) => e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error'
  );

  console.log('窗口事实');
  console.log('  标题        ', JSON.stringify(facts.title));
  console.log('  视口 / 外框 ', facts.inner.join('x'), '/', facts.outer.join('x'));
  console.log('  对话容器    ', facts.hasThread ? '已渲染' : '缺失');
  console.log('  消息条数    ', facts.msgs);
  console.log('  页面底色    ', facts.bg);
  console.log('');
  console.log('hidden 属性是否真的生效（jsdom 测不到的那类）');
  let hiddenBad = 0;
  for (const [sel, info] of Object.entries(facts.hiddenProbe)) {
    if (info === 'missing') {
      console.log(`  ${sel.padEnd(13)} 元素不存在`);
      continue;
    }
    // 只有「标了 hidden 却还看得见」才算错；标了 hidden 且确实不可见是对的
    const wrong = info.attr === true && info.visible === true;
    if (wrong) hiddenBad++;
    const verdict = info.attr === true ? (info.visible ? '✗ 标了 hidden 却还可见' : '✓ 已藏住') : '（当前应当可见）';
    console.log(`  ${sel.padEnd(13)} hidden=${String(info.attr).padEnd(5)} display=${String(info.display).padEnd(6)} ${verdict}`);
  }
  console.log('');
  console.log('自绘标题栏（窗口拖动 / 原生按钮避让）');
  const tb = facts.titlebar;
  let titlebarBad = 0;
  console.log(`  外框 - 视口   ${tb.frameGap[0]} x ${tb.frameGap[1]}  （标题栏并进客户区后，垂直差值应当很小）`);
  // 原生最小化/最大化/关闭共 3 个按钮，每个约 46px 宽
  const needReserve = 3 * 46;
  if (tb.captionReserve === null) {
    console.log('  右侧避让      量不到（没找到 .head-right）');
    titlebarBad++;
  } else {
    const ok = tb.captionReserve >= needReserve;
    if (!ok) titlebarBad++;
    console.log(
      `  右侧避让      ${tb.captionReserve}px（需要 ≥ ${needReserve}px）${ok ? '✓' : '✗ 会被系统按钮压住'}`
    );
  }
  for (const [label, val, want] of [
    ['.rail-head ', tb.dragRail, 'drag'],
    ['.stage-head', tb.dragStage, 'drag'],
    ['#btnStats  ', tb.dragBtn, 'no-drag'],
  ]) {
    const ok = val === want;
    if (!ok) titlebarBad++;
    console.log(`  ${label}  -webkit-app-region=${val.padEnd(8)}（应为 ${want}）${ok ? '✓' : '✗'}`);
  }
  console.log('');

  console.log('是不是独立应用窗口');
  const isElectron = /Electron\//.test(facts.ua);
  console.log('  userAgent 含 Electron :', isElectron ? '是 ✓' : '否 ✗');
  console.log('  userAgent             :', facts.ua);
  console.log('');
  console.log('运行期错误');
  console.log('  未捕获异常  ', exceptions.length);
  console.log('  console.error', errLogs.length);
  for (const e of exceptions.slice(0, 3)) {
    console.log('   ', e.params?.exceptionDetails?.text || JSON.stringify(e.params).slice(0, 160));
  }
  console.log('');
  console.log('截图 →', path.relative(path.join(__dirname, '..'), file));

  process.exit(exceptions.length || !isElectron || hiddenBad || titlebarBad ? 1 : 0);
})().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
