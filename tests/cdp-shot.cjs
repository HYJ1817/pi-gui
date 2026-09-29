/* 用 Chrome DevTools Protocol 驱动真实浏览器截图。
 *
 * 无头 Chrome 直接 --screenshot 在本机会挂住，但配 --remote-debugging-port
 * 后可以用 Node 内置的 WebSocket 手动控制，能点击、能等状态、能截多张。
 *
 * 附件走 DOM.setFileInputFiles 塞真实文件，触发 #fileInput 的 change，
 * 也就是用户点「+」选文件的同一条路径 —— 不去碰 app.js 里的模块作用域函数
 * （app.js 是 <script type="module">，顶层函数不会挂到 window 上）。
 *
 * 用法：
 *   node tests/cdp-shot.cjs                          # 默认核对真实服务 :7788
 *   node tests/cdp-shot.cjs --url=http://127.0.0.1:7789/ --tag=h
 * 只用于开发期视觉核对，不属于产品代码。 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9223);
const OUT = path.join(__dirname, '..', '.shots');

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const APP = arg('url', 'http://127.0.0.1:7788/');
const TAG = arg('tag', '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const name = (n) => (TAG ? TAG + '-' + n : n);

// 真实附件：用 fixtures.mjs 生成的中文 docx / pdf
const FIX = path.join(os.tmpdir(), 'pi-gui-fixtures');
const ATTACH = ['发酵罐空气分布器设计.pdf', '发酵罐空气分布器设计.docx', 'red.png']
  .map((f) => path.join(FIX, f))
  .filter((f) => fs.existsSync(f));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-default-apps',
      '--metrics-recording-only',
      '--hide-scrollbars',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${path.join(OUT, 'cdp' + TAG)}`,
      '--window-size=1440,900',
      'about:blank',
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
    } catch {
      /* 还没起来 */
    }
  }
  const page = targets && targets.find((t) => t.type === 'page');
  if (!page) throw new Error('拿不到 DevTools page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  const pageErrors = [];

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || '未知异常');
    }
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };

  const send = (method, params = {}) =>
    new Promise((res) => {
      const n = ++id;
      pending.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };

  const shot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, name(n) + '.png');
    fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    console.log('  截图: ' + path.basename(p));
  };

  const closePop = async () => {
    await evalJs('document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles:true}))');
    await sleep(220);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Page.navigate', { url: APP });

  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const ready = await evalJs('!!document.querySelector("#btnModel") && document.querySelector("#connText").textContent').catch(() => null);
    if (ready) break;
  }
  await sleep(1500);

  console.log('目标: ' + APP);
  console.log('页面状态: ' + (await evalJs('document.querySelector("#connText").textContent')));
  console.log('模型 chip: ' + (await evalJs('document.querySelector("#modelText").textContent')));

  // 左下供应商入口：位置、是否在侧栏内、是否在用量卡上方
  const railInfo = await evalJs(`(() => {
    const prov = document.querySelector('#navProviders');
    if (!prov) return 'no-prov-entry';
    const r = prov.getBoundingClientRect();
    const rail = document.querySelector('.rail').getBoundingClientRect();
    const quota = document.querySelector('.quota').getBoundingClientRect();
    return JSON.stringify({
      text: prov.textContent.trim(),
      top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), w: Math.round(r.width),
      railBottom: Math.round(rail.bottom),
      aboveQuota: r.bottom <= quota.top + 1,
      inRail: r.left >= rail.left && r.right <= rail.right + 1,
      inViewport: r.top >= 0 && r.bottom <= innerHeight,
      navItems: document.querySelectorAll('.rail-nav .nav-item').length,
      cornerBtns: document.querySelectorAll('.corner .icon-btn').length,
    });
  })()`);
  console.log('左下供应商入口: ' + railInfo);

  await shot('01-default');

  /* --- 模型浮层 --- */
  await evalJs('document.querySelector("#btnModel").click()');
  await sleep(450);
  const popInfo = await evalJs(`(() => {
    const p = document.querySelector('.pop');
    if (!p || p.hidden) return 'no-pop';
    const r = p.getBoundingClientRect();
    const a = document.querySelector('#btnModel').getBoundingClientRect();
    return JSON.stringify({
      left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      anchorRight: Math.round(a.right), anchorTop: Math.round(a.top),
      inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      items: p.querySelectorAll('.pop-item').length,
      groups: [...p.querySelectorAll('.pop-label')].map(x => x.textContent),
    });
  })()`);
  console.log('模型浮层: ' + popInfo);
  await shot('02-model-popover');

  /* --- 思考浮层 --- */
  await closePop();
  await evalJs('document.querySelector("#btnThink").click()');
  await sleep(400);
  console.log('思考浮层项数: ' + (await evalJs('document.querySelectorAll(".pop .pop-item").length')));
  await shot('03-think-popover');

  /* --- 上下文提示 --- */
  await closePop();
  await evalJs('document.querySelector("#btnCtx").click()');
  await sleep(400);
  const tipInfo = await evalJs(`(() => {
    const p = document.querySelector('.pop');
    if (!p || p.hidden) return 'no-tip';
    const r = p.getBoundingClientRect();
    return JSON.stringify({ text: p.textContent, left: Math.round(r.left), top: Math.round(r.top),
      inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight });
  })()`);
  console.log('上下文提示: ' + tipInfo);
  await shot('04-ctx-tooltip');
  await closePop();

  /* --- 附件：走真实文件输入 --- */
  if (!ATTACH.length) {
    console.log('附件: 跳过（先跑 npm run fixtures 生成固件）');
  } else {
    const r = await send('Runtime.evaluate', { expression: 'document.querySelector("#fileInput")' });
    const objectId = r.result?.result?.objectId;
    if (!objectId) throw new Error('拿不到 #fileInput 的 objectId');

    await send('DOM.setFileInputFiles', { files: ATTACH, objectId });

    await sleep(260); // 趁解析中截一张，看得到 loading 态
    await shot('05-attach-loading');

    await sleep(1800);
    const tray = await evalJs(`(() => {
      const box = document.querySelector('#attachTray');
      if (!box || box.hidden) return 'tray-hidden';
      const rect = box.getBoundingClientRect();
      return JSON.stringify({
        count: box.querySelectorAll('.att').length,
        hidden: box.hidden,
        inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        items: [...box.querySelectorAll('.att')].map(a => ({
          cls: a.className,
          text: a.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60),
          hasThumb: !!a.querySelector('img'),
        })),
      });
    })()`);
    console.log('附件托盘: ' + tray);
    await shot('06-attach-tray');

    // 输入文字，看发送按钮是否因附件而可用
    await evalJs(`(() => {
      const t = document.querySelector('#input');
      t.value = '帮我看下这三份文件';
      t.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(300);
    console.log('发送按钮可用: ' + (await evalJs('!document.querySelector("#btnSend").disabled')));
    await shot('07-attach-ready');
  }

  /* --- 对话区 --- */
  const thread = await evalJs(`(() => {
    const t = document.querySelector('#stream .thread');
    if (!t) return 'no-thread';
    return JSON.stringify({
      user: t.querySelectorAll('.msg.user').length,
      assistant: t.querySelectorAll('.msg.assistant').length,
      fileCards: t.querySelectorAll('.msg-file').length,
      imgChips: t.querySelectorAll('.msg-att-chip').length,
      rawTags: (t.textContent.match(/<pi-file/g) || []).length,
    });
  })()`);
  console.log('对话区: ' + thread);
  await shot('08-thread');

  // 滚到顶部看用户消息（图片缩略图 + 折叠卡片收起态）
  await evalJs(`(() => { const s = document.querySelector('#stream'); if (s) s.scrollTop = 0; })()`);
  await sleep(500);
  await shot('09-thread-top');

  // 展开第一张折叠卡片
  const opened = await evalJs(`(() => {
    const h = document.querySelector('.msg-file .msg-file-head');
    if (!h) return 'no-card';
    h.click();
    return 'ok';
  })()`);
  if (opened === 'ok') {
    await sleep(400);
    await shot('10-file-expanded');
  }

  /* ================= P8-C：Attempt 人工审阅（视觉核对场景） =================
   *
   * 场景数据全部来自 tests/visual-harness.cjs 的 PLAN_DETAIL / PLAN_STRESS ——
   * **不依赖真实后端、不跑任何 Agent**（§五十九）。判据也刻意不是「文本包含 X」，
   * 而是真实的排版截图：jsdom 不做布局，那种断言全绿也说明不了排版对不对。 */
  /* 每张截图都把「框住的那个元素」的取景信息打出来：矩形在不在视口里、文本是什么、
   * 关键词齐不齐。判据不再靠人眼比对 png —— 日志就是截图内容的机器可查证据。 */
  const shotFailures = [];
  /* `mustTrue`：结构判据 —— 收起/展开、真 button、aria-*、可见高度这些。
   * 截图和 textContent **都分不出**收起与展开（收起的节点还在 DOM 里，文本照样
   * 算进去），所以这类判据必须显式算出来，算不过就进失败清单、最后 exit 1。 */
  const shotOf = async (sel, n, label, must, mustTrue) => {
    const probe = await evalJs(
      `(() => {
        const e = document.querySelector(${JSON.stringify(sel)});
        if (!e) return null;
        e.scrollIntoView({ block: 'center' });
        const r = e.getBoundingClientRect();
        const text = (e.textContent || '').replace(/\\s+/g, ' ').trim();
        const must = ${JSON.stringify(must || [])};
        const center = (r.top + r.bottom) / 2;
        return {
          /* 判据是「取景中心落在视口里」：scrollIntoView(block:center) 之后成立。
           * 不能用 top/bottom 都在视口内 —— 比视口还高的元素（1000 字说明、10 次尝试）
           * 按构造就不可能满足，那种断言是自己骗自己。 */
          inView: center >= 0 && center <= innerHeight,
          top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
          missing: must.filter((k) => !text.includes(k)),
          text: text.slice(0, 160),
        };
      })()`
    );
    if (!probe) {
      console.log('  跳过（找不到 ' + sel + '）');
      shotFailures.push(n + ': 找不到 ' + sel);
      return false;
    }
    await sleep(450);
    await shot(n);
    let badTrue = [];
    if (mustTrue && mustTrue.length) {
      badTrue =
        (await evalJs(
          `(() => { const bad = []; for (const [what, expr] of ${JSON.stringify(mustTrue)}) { let v; try { v = eval(expr); } catch (e) { v = 'eval 抛错：' + e.message; } if (!v) bad.push(what + (typeof v === 'string' && v !== 'false' ? '（' + v + '）' : '')); } return bad; })()`
        )) || [];
    }
    const flag = (probe.missing.length ? '✗ 缺 ' + probe.missing.join('/') : '✓') +
      (probe.inView ? ' 取景中心在视口内' : ' 取景中心不在视口内') +
      (badTrue.length ? ' ✗ 结构判据不成立: ' + badTrue.join('；') : (mustTrue && mustTrue.length ? ' 结构判据成立' : ''));
    console.log('      ' + n + ' [' + flag + '] rect=' + probe.top + '..' + probe.bottom + '/' + probe.h);
    console.log('        取景元素文本: ' + probe.text);
    if (label) console.log('      ' + label);
    if (probe.missing.length) shotFailures.push(n + ': 取景元素缺关键词 ' + probe.missing.join('/'));
    if (!probe.inView) shotFailures.push(n + ': 取景中心不在视口内 (rect=' + probe.top + '..' + probe.bottom + ')');
    for (const m of badTrue) shotFailures.push(n + ': 结构判据不成立 —— ' + m);
    return probe.missing.length === 0 && probe.inView && badTrue.length === 0;
  };
  const clickIn = async (sel, text) =>
    evalJs(
      `(() => {
        const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)});
        if (!b) return false;
        b.onclick();
        return true;
      })()`
    );

  /* P14-A：同一夹具里的项目、会话与现有面板；每张图附结构与宽度判据。 */
  const shellChecks = [
    ['三列都在视口', `(() => { const a = ['#globalRail','#projectSidebar','#workspace'].map(s => document.querySelector(s).getBoundingClientRect()); return a.every(r => r.width > 0 && r.left >= 0 && r.right <= innerWidth + 1); })()`],
    ['激活项唯一', `document.querySelectorAll('#globalRail [aria-current="page"]').length === 1`],
    ['没有空功能入口', `[...document.querySelectorAll('#globalRail .rail-icon')].every(b => b.tagName === 'BUTTON' && b.getAttribute('aria-label') && typeof b.onclick === 'function')`],
  ];
  await shotOf('#projectSidebar', '57-shell-expanded', 'P14-A：Rail + 项目侧栏 + 工作区', ['新对话', '搜索会话', '项目'], shellChecks);
  await shotOf('.pj-sessions', '58-project-sessions', 'P14-A：项目下有多条会话', ['发酵罐', 'README', 'server.js'], [['会话都属于当前项目', `document.querySelector('.project.active').nextElementSibling?.classList.contains('pj-sessions')`]]);
  await shotOf('.pj-sess.on', '59-session-selected', 'P14-A：当前会话选中', ['发酵罐'], [['选中项唯一且有语义', `document.querySelectorAll('.pj-sess[aria-current="true"]').length === 1`]]);
  await evalJs(`document.querySelector('#groupHead').click()`);
  await shotOf('#groupHead', '67-project-group-collapsed', 'P14-A：项目分组点击后实际折叠', ['项目'], [
    ['项目容器不含 open', `!document.querySelector('#groupHead').closest('.rail-group').classList.contains('open')`],
    ['项目内容不可见', `getComputedStyle(document.querySelector('#groupBody')).display === 'none' && document.querySelector('#groupBody').getBoundingClientRect().height === 0`],
    ['折叠语义一致', `document.querySelector('#groupHead').getAttribute('aria-expanded') === 'false'`],
  ]);
  await evalJs(`document.querySelector('#groupHead').click()`);
  await shotOf('#groupHead', '68-project-group-restored', 'P14-A：项目分组再次点击后恢复', ['项目'], [
    ['项目容器含 open', `document.querySelector('#groupHead').closest('.rail-group').classList.contains('open')`],
    ['项目内容可见', `getComputedStyle(document.querySelector('#groupBody')).display !== 'none' && document.querySelector('#groupBody').getBoundingClientRect().height > 0`],
    ['展开语义一致', `document.querySelector('#groupHead').getAttribute('aria-expanded') === 'true'`],
  ]);
  await evalJs(`document.querySelector('#btnSidebarCollapse').click()`);
  await shotOf('#globalRail', '60-sidebar-collapsed', 'P14-A：折叠后 Rail 仍在', [], [['侧栏已隐藏且工作区在视口', `document.querySelector('#projectSidebar').hidden && document.querySelector('#workspace').getBoundingClientRect().right <= innerWidth + 1`]]);
  await evalJs(`document.querySelector('#btnSidebarExpand').click()`);
  await shotOf('#usageDetails', '61-usage-compact', 'P14-A：用量摘要', ['上下文'], [['详情默认收起', `!document.querySelector('#usageDetails').open`]]);
  await evalJs(`document.querySelector('#usageDetails summary').click()`);
  await shotOf('#usageDetails', '62-usage-expanded', 'P14-A：用量明细', ['输入 / 输出', '缓存读取', '累计成本'], [['详情已展开', `document.querySelector('#usageDetails').open`]]);
  await evalJs(`document.querySelector('#navGlobalMore').click()`);
  await shotOf('#globalMoreMenu', '63-global-more', 'P14-A：低频入口', ['诊断', '模型供应商'], [['More 展开且入口为真按钮', `!document.querySelector('#globalMoreMenu').hidden && [...document.querySelectorAll('#globalMoreMenu button')].every(b => b.tagName === 'BUTTON' && typeof b.onclick === 'function')`], ['More 左边缘贴齐 Global Rail', `Math.abs(document.querySelector('#globalMoreMenu').getBoundingClientRect().left - document.querySelector('#globalRail').getBoundingClientRect().right) <= 1`]]);
  await evalJs(`document.querySelector('#navGlobalMore').click()`);
  await evalJs(`document.querySelector('#navChanges').click()`);
  await shotOf('#globalRail', '64-rail-changes', 'P14-A：文件变更激活', [], [['文件变更为唯一激活', `document.querySelector('#navChanges[aria-current="page"]') && document.querySelectorAll('#globalRail [aria-current="page"]').length === 1`]]);
  await evalJs(`document.querySelector('#navHome').click()`);
  await evalJs(`document.querySelector('#navPlanner').click()`);
  await shotOf('#globalRail', '65-rail-planner', 'P14-A：任务激活', [], [['任务为唯一激活', `document.querySelector('#navPlanner[aria-current="page"]') && document.querySelectorAll('#globalRail [aria-current="page"]').length === 1`]]);
  await evalJs(`document.querySelector('#navHome').click()`);
  await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(350);
  await shotOf('#workspace', '66-shell-narrow-700', 'P14-A：700px 工作区仍在视口', [], [['无水平溢出', `document.documentElement.scrollWidth <= innerWidth + 1`], ['工作区仍有内容宽度', `document.querySelector('#workspace').getBoundingClientRect().width >= 300`], ...shellChecks]);
  for (const width of [900, 1200, 1536]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(220);
    await shotOf('#workspace', `${width}-shell-width`, `P14-A：${width}px 三列布局`, [], [['无水平溢出', `document.documentElement.scrollWidth <= innerWidth + 1`], ...shellChecks]);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);

  /* P14-B：P14-A 场景全部结束后才切换对话夹具，保持 57–68 的原始语义。 */
  await evalJs(`fetch('/api/__conversation?what=fixture').then(r => r.ok)`);
  await sleep(500);
  await evalJs(`(() => {
    const mark = (selector, phrase, id) => {
      const node = [...document.querySelectorAll(selector)].find(el => el.textContent.includes(phrase));
      if (node) node.id = id;
    };
    mark('.msg.user', '好，继续。', 'p14b-short');
    mark('.msg.user', '请保留完整路径', 'p14b-long');
    mark('.msg.user', '设备图全套_6张A2.pdf', 'p14b-multiple');
    mark('.msg.user', '发酵罐空气分布器设计.pdf', 'p14b-single');
    mark('.msg.assistant', '当前结论', 'p14b-assistant');
    mark('.msg.assistant', '下面是长代码块', 'p14b-code');
  })()`);
  const bubbleBounds = `(() => { const b=document.querySelector('#p14b-short .msg-body').getBoundingClientRect(); const c=document.querySelector('.thread').getBoundingClientRect(); return b.width > 0 && b.width < c.width * .5 && Math.abs(b.right - (c.right - parseFloat(getComputedStyle(document.querySelector('.thread')).paddingRight))) <= 2; })()`;
  await shotOf('#p14b-short', '69-conversation-user-short', 'P14-B：短 User Bubble 靠右且按内容收缩', ['好，继续'], [['短 Bubble 真实位置与宽度', bubbleBounds]]);
  await shotOf('#p14b-long', '70-conversation-user-long', 'P14-B：长 User Bubble 有宽度上限且换行', ['请保留完整路径'], [['长 Bubble 不超过阅读列 78%', `(() => { const b=document.querySelector('#p14b-long .msg-body').getBoundingClientRect(); const c=document.querySelector('.thread').getBoundingClientRect(); return b.width <= (c.width - 2*parseFloat(getComputedStyle(document.querySelector('.thread')).paddingLeft)) * .78 + 2 && document.documentElement.scrollWidth <= innerWidth + 1; })()`]]);
  await shotOf('#p14b-assistant', '71-assistant-open-text', 'P14-B：Assistant 开放正文与 Markdown', ['当前结论'], [['Assistant 无大卡背景且 Markdown 在', `(() => { const b=document.querySelector('#p14b-assistant .msg-body'); const s=getComputedStyle(b); return s.backgroundColor === 'rgba(0, 0, 0, 0)' && parseFloat(s.borderTopWidth) === 0 && !!b.querySelector('h4, strong, code'); })()`]]);
  await shotOf('#p14b-assistant .think-head', '72-thinking-collapsed', 'P14-B：Thinking 默认折叠', ['思考过程'], [['Thinking 控件与内容真实折叠', `(() => { const h=document.querySelector('#p14b-assistant .think-head'); const b=document.querySelector('#p14b-assistant .think-body'); return h.tagName === 'BUTTON' && h.getAttribute('aria-expanded') === 'false' && b.hidden && b.getBoundingClientRect().height === 0; })()`]]);
  await evalJs(`document.querySelector('#p14b-assistant .think-head').click()`);
  await shotOf('#p14b-assistant .think', '73-thinking-expanded', 'P14-B：Thinking 展开后显示真实内容', ['先核对步骤'], [['Thinking 展开且内容可见', `(() => { const h=document.querySelector('#p14b-assistant .think-head'); const b=document.querySelector('#p14b-assistant .think-body'); return h.getAttribute('aria-expanded') === 'true' && !b.hidden && b.getBoundingClientRect().height > 0; })()`]]);
  await evalJs(`document.querySelector('#p14b-assistant .think-head').click()`);
  await evalJs(`fetch('/api/__conversation?what=tool-running').then(r => r.ok)`);
  await sleep(280);
  await shotOf('.tl-item[data-id="p14b-running"]', '74-tool-running', 'P14-B：工具运行状态', ['读取文件'], [['运行态图标与文字', `(() => { const e=document.querySelector('.tl-item[data-id="p14b-running"]'); return e?.dataset.status === 'running' && !!e.querySelector('.tl-dot svg') && /运行中/.test(e.querySelector('.tl-status')?.textContent || ''); })()`]]);
  await evalJs(`fetch('/api/__conversation?what=tool-success').then(r => r.ok)`);
  await sleep(200);
  await shotOf('.tl-item[data-id="p14b-running"]', '75-tool-success', 'P14-B：工具成功状态', ['读取文件'], [['成功态图标与文字', `(() => { const e=document.querySelector('.tl-item[data-id="p14b-running"]'); return e?.dataset.status === 'success' && !!e.querySelector('.tl-dot svg') && /成功/.test(e.querySelector('.tl-status')?.textContent || ''); })()`]]);
  await evalJs(`fetch('/api/__conversation?what=tool-failed').then(r => r.ok)`);
  await sleep(200);
  await shotOf('.tl-item[data-id="p14b-failed"]', '76-tool-failed', 'P14-B：工具失败状态与退出码', ['执行命令'], [['失败态有文字和结果', `(() => { const e=document.querySelector('.tl-item[data-id="p14b-failed"]'); return e?.dataset.status === 'error' && /失败/.test(e.querySelector('.tl-status')?.textContent || '') && /exit code 1/.test(e.querySelector('.tl-result')?.textContent || ''); })()`]]);
  await shotOf('.tl-group', '77-tool-group-mixed', 'P14-B：连续工具组有成功与失败', ['操作 3 项'], [['历史工具同组且状态混合', `(() => { const g=document.querySelector('.tl-group'); return g?.querySelectorAll('.tl-item').length === 3 && !!g.querySelector('[data-status=success]') && !!g.querySelector('[data-status=error]'); })()`]]);
  await shotOf('#p14b-single .msg-file', '78-attachment-single', 'P14-B：单附件紧凑文件块', ['发酵罐空气分布器设计.pdf'], [['文件块有按钮且高度紧凑', `(() => { const f=document.querySelector('#p14b-single .msg-file'); return f.getBoundingClientRect().height < 80 && f.querySelector('button.msg-file-head[aria-expanded="false"]') && f.querySelector('.msg-file-body').hidden; })()`]]);
  await shotOf('#p14b-multiple', '79-attachment-multiple', 'P14-B：多附件自然堆叠', ['设备图全套', '核对记录'], [['两文件块均在 Bubble 内', `document.querySelectorAll('#p14b-multiple .msg-file').length === 2 && document.querySelectorAll('#p14b-multiple button.msg-file-head').length === 2`]]);
  await evalJs(`document.querySelectorAll('#convoNav .cn-marker')[2].click()`);
  await sleep(700);
  await shotOf('#convoNav', '80-minimap', 'P14-B：Minimap 当前点与点击定位', [], [['四个用户 Turn、当前项与定位', `(() => { const marks=[...document.querySelectorAll('#convoNav .cn-marker')]; const users=[...document.querySelectorAll('.thread .msg.user')]; const target=document.querySelector('#p14b-long'); const stream=document.querySelector('#stream').getBoundingClientRect(); const r=target.getBoundingClientRect(); const band=stream.top+stream.height*.1; let expected=0; users.forEach((user,i)=>{ if(user.getBoundingClientRect().top<=band) expected=i; }); return marks.length === 4 && users.length === 4 && marks.filter(m=>m.classList.contains('on')).length === 1 && marks[expected].classList.contains('on') && r.top >= stream.top-2 && r.top < stream.bottom; })()`]]);
  await shotOf('#p14b-code pre.code', '81-long-code', 'P14-B：长代码只在代码块内横向滚动', [], [['代码内部溢出、页面无横向溢出', `(() => { const c=document.querySelector('#p14b-code pre.code'); return c.scrollWidth > c.clientWidth && c.getBoundingClientRect().right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1; })()`]]);
  for (const [width, scene] of [[700,'82-narrow-700'],[900,'83-conversation-900'],[1200,'84-conversation-1200'],[1536,'85-conversation-1536']]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(260);
    await shotOf('#p14b-long', scene, `P14-B：${width}px 阅读列与长 URL`, ['请保留完整路径'], [['页面与消息都无横向溢出', `document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('#p14b-long').getBoundingClientRect().right <= innerWidth + 1`], ['阅读列在视口内且居中', `(() => { const c=document.querySelector('.thread').getBoundingClientRect(); const s=document.querySelector('#stream').getBoundingClientRect(); return c.width > 0 && c.width <= s.width + 1 && Math.abs((c.left+c.right)/2-(s.left+s.right)/2) <= 2; })()`], ['代码块内部滚动', `(() => { const c=document.querySelector('#p14b-code pre.code'); return c.scrollWidth > c.clientWidth && document.documentElement.scrollWidth <= innerWidth + 1; })()`]]);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(250);
  await evalJs(`fetch('/api/__conversation?what=reset').then(r => r.ok)`);
  await sleep(300);

  /* P14-C：真实 Chrome 的 Composer 几何、滚动留白和键盘弹层。 */
  const box = `document.querySelector('#composerBox')`;
  const outer = `document.querySelector('.composer')`;
  const fit = `(() => { const c=${box}.getBoundingClientRect(); const s=document.querySelector('#stream').getBoundingClientRect(); return c.width > 0 && Math.abs((c.left+c.right-s.left-s.right)/2) <= 2 && c.left >= 0 && c.right <= innerWidth + 1 && c.bottom <= innerHeight && c.bottom >= innerHeight - 26; })()`;
  const reserve = `(() => { const c=${outer}.getBoundingClientRect(); const v=parseFloat(getComputedStyle(document.querySelector('.stage')).getPropertyValue('--composer-reserved-height')); return Math.abs(v-c.height) <= 2; })()`;
  const controls = `(() => { const c=${box}.getBoundingClientRect(); return ['btnAttach','btnCtx','btnModel','btnThink','btnSend','btnStop'].every(id => { const e=document.getElementById(id); if(e.hidden) return true; const r=e.getBoundingClientRect(); return r.width>0 && r.left>=c.left-1 && r.right<=c.right+1 && r.top>=c.top-1 && r.bottom<=c.bottom+1; }); })()`;
  const setText = async (text) => evalJs(`(() => { const t=document.querySelector('#input'); t.value=${JSON.stringify(text)}; t.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  const setFiles = async (files) => {
    if (!files.length) return false;
    await evalJs(`document.querySelector('#fileInput').value=''`);
    const r = await send('Runtime.evaluate', { expression: 'document.querySelector("#fileInput")' });
    await send('DOM.setFileInputFiles', { files, objectId: r.result?.result?.objectId });
    return true;
  };
  await evalJs(`(() => { document.querySelectorAll('#attachTray .att-x').forEach(b=>b.click()); const s=document.querySelector('#stream'); s.scrollTop=s.scrollHeight; })()`);
  await setText('');
  await sleep(220);
  await shotOf('#composerBox', '86-composer-idle', 'P14-C：浮动单容器，空输入', [], [['与阅读区同轴且在视口内', fit], ['实测高度同步', reserve], ['控件均在容器内', controls], ['只有一套输入区', `document.querySelectorAll('#composerBox').length===1 && document.querySelectorAll('#input').length===1`], ['空输入禁用发送', `document.querySelector('#btnSend').disabled`], ['末条消息可滚到输入区上方', `(() => { const m=[...document.querySelectorAll('.thread .msg')].at(-1)?.getBoundingClientRect(); const c=${box}.getBoundingClientRect(); return m && m.bottom <= c.top - 10; })()`]]);
  await setText('单行输入');
  await sleep(180);
  const oneHeight = await evalJs(`${outer}.getBoundingClientRect().height`);
  await shotOf('#composerBox', '87-composer-text', 'P14-C：单行输入可发送', [], [['输入确实有单行内容', `document.querySelector('#input').value==='单行输入'`], ['发送启用', `!document.querySelector('#btnSend').disabled`], ['同轴与留白', fit], ['留白同步', reserve]]);
  await setText('第一行\n第二行\n第三行');
  await sleep(180);
  const threeHeight = await evalJs(`${outer}.getBoundingClientRect().height`);
  await shotOf('#composerBox', '88-composer-multiline', 'P14-C：三行向上增长', [], [['输入确实三行', `document.querySelector('#input').value.split('\\n').length===3`], ['实际高度大于单行', `${threeHeight} > ${oneHeight} && ${outer}.getBoundingClientRect().height > ${oneHeight}`], ['底部位置稳定', fit], ['留白同步', reserve]]);
  await setText(Array.from({length:36},(_,i)=>`第${i+1}行：多行输入内容`).join('\n'));
  await sleep(180);
  await shotOf('#composerBox', '89-composer-max-height', 'P14-C：长输入在 textarea 内滚动', [], [['输入确实有多行', `document.querySelector('#input').value.split('\\n').length===36`], ['输入确实内部滚动', `(() => { const t=document.querySelector('#input'); return t.scrollHeight > t.clientHeight + 10 && t.clientHeight <= Math.min(184,innerHeight*.24)+1; })()`], ['输入区不越界', fit], ['留白同步', reserve]]);
  await setText('');
  if (ATTACH.length) {
    await setFiles(ATTACH.slice(0,1));
    await sleep(1650);
    await shotOf('#composerBox', '90-composer-attachment-single', 'P14-C：单附件在紧凑托盘', [], [['单附件可见且可删', `document.querySelectorAll('#attachTray .att').length===1 && !!document.querySelector('#attachTray .att-x[aria-label]')`], ['附件增高后留白同步', reserve], ['同轴', fit]]);
    await setFiles(ATTACH.slice(1,3));
    await sleep(1650);
    await shotOf('#composerBox', '91-composer-attachment-multiple', 'P14-C：多附件横向换行', [], [['多附件都在托盘', `document.querySelectorAll('#attachTray .att').length>=2`], ['托盘未溢出输入区', `(() => { const a=document.querySelector('#attachTray').getBoundingClientRect(),c=${box}.getBoundingClientRect(); return a.left>=c.left && a.right<=c.right+1; })()`], ['留白同步', reserve]]);
    await evalJs(`document.querySelectorAll('#attachTray .att-x').forEach(b=>b.click())`);
    await evalJs(`fetch('/api/__composer?what=hold-upload').then(r=>r.ok)`);
    await setFiles(ATTACH.slice(0,1));
    await sleep(120);
    await shotOf('#composerBox', '92-composer-attachment-parsing', 'P14-C：解析中有文字状态', [], [['解析中附件实际可见', `!!document.querySelector('#attachTray .att.loading .att-meta') && /解析中/.test(document.querySelector('#attachTray .att.loading .att-meta').textContent)`], ['留白同步', reserve]]);
    await sleep(1650);
    await evalJs(`document.querySelectorAll('#attachTray .att-x').forEach(b=>b.click())`);
  }
  await evalJs(`${box}.dispatchEvent(new DragEvent('dragenter',{bubbles:true,dataTransfer:new DataTransfer()}))`);
  await shotOf('#composerBox', '93-composer-dragover', 'P14-C：拖入态仅增强边界', [], [['拖入态边框真实变化', `(() => { const b=${box}; return b.classList.contains('drop') && getComputedStyle(b).borderTopColor !== 'rgb(54, 54, 54)'; })()`]]);
  await evalJs(`${box}.dispatchEvent(new DragEvent('dragleave',{bubbles:true,dataTransfer:new DataTransfer()}))`);
  const popFit = `(() => { const p=document.querySelector('.pop').getBoundingClientRect(), c=${box}.getBoundingClientRect(); return p.width>0 && p.left>=0 && p.right<=innerWidth && p.top>=0 && p.bottom<=innerHeight && p.bottom<=c.top+2; })()`;
  await evalJs(`document.querySelector('#btnModel').click()`);
  await shotOf('.pop', '94-composer-model-picker', 'P14-C：模型选择器向上展开', ['选择模型'], [['弹层真实位置在视口且位于输入区上方', popFit], ['选项是真按钮', `document.querySelectorAll('.pop button.pop-item').length>0`], ['锚点已展开', `document.querySelector('#btnModel').getAttribute('aria-expanded')==='true'`]]);
  await evalJs(`document.querySelector('#btnModel').click(); document.querySelector('#btnThink').click()`);
  await shotOf('.pop', '95-composer-thinking-picker', 'P14-C：思考等级选择器向上展开', ['思考等级'], [['弹层真实位置', popFit], ['选项可键盘访问', `document.querySelectorAll('.pop button.pop-item').length>0`]]);
  await evalJs(`document.querySelector('#btnThink').click(); document.querySelector('#btnCtx').click()`);
  await shotOf('.pop', '96-composer-context-popover', 'P14-C：上下文占用提示', ['背景信息窗口'], [['提示真实位置', popFit], ['百分比来自真实夹具', `document.querySelector('#ctxPct').textContent.includes('%')`]]);
  await evalJs(`document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);
  const ctxHoverErrors = pageErrors.length;
  const ctxPoint = await evalJs(`(() => { const r=document.querySelector('#btnCtx').getBoundingClientRect(); return { x:(r.left+r.right)/2, y:(r.top+r.bottom)/2 }; })()`);
  await send('Input.dispatchMouseEvent', { type:'mouseMoved', ...ctxPoint });
  await sleep(170);
  await shotOf('.pop', '96a-composer-context-hover', 'P14-C：真实鼠标悬停打开 Context 提示', ['背景信息窗口'], [
    ['hover 后弹层可见且为 tip-mode', `(() => {const p=document.querySelector('.pop');return !p.hidden && p.classList.contains('tip-mode')})()`],
    ['按钮展开语义同步', `document.querySelector('#btnCtx').getAttribute('aria-expanded')==='true'`],
    ['提示位置在视口内', popFit],
    ['hover 无页面运行时异常', String(pageErrors.length === ctxHoverErrors)],
  ]);
  const tipPoint = await evalJs(`(() => { const r=document.querySelector('.pop').getBoundingClientRect(); return { x:(r.left+r.right)/2, y:(r.top+r.bottom)/2 }; })()`);
  await send('Input.dispatchMouseEvent', { type:'mouseMoved', ...tipPoint });
  await sleep(260);
  await shotOf('.pop', '96b-composer-context-hover-retained', 'P14-C：鼠标移到提示上方仍保持打开', ['背景信息窗口'], [
    ['提示仍可见', `(() => {const p=document.querySelector('.pop');return !p.hidden && p.classList.contains('tip-mode')})()`],
    ['按钮仍标记展开', `document.querySelector('#btnCtx').getAttribute('aria-expanded')==='true'`],
    ['未产生页面运行时异常', String(pageErrors.length === ctxHoverErrors)],
  ]);
  await send('Input.dispatchMouseEvent', { type:'mouseMoved', x:10, y:10 });
  await sleep(60);
  await shotOf('#btnCtx', '96c-composer-context-hover-leave', 'P14-C：离开提示后关闭', [], [
    ['提示已关闭且展开语义恢复', `document.querySelector('.pop').hidden && document.querySelector('#btnCtx').getAttribute('aria-expanded')==='false'`],
    ['未产生页面运行时异常', String(pageErrors.length === ctxHoverErrors)],
  ]);
  await evalJs(`fetch('/api/__push?what=running').then(r=>r.ok)`);
  await sleep(160);
  await shotOf('#composerBox', '97-composer-running', 'P14-C：运行时 Stop 为主操作', ['停止'], [['停止可用且发送入口仍在', `!document.querySelector('#btnStop').hidden && document.querySelector('#btnSend').getBoundingClientRect().width>0`], ['控件不越界', controls]]);
  await evalJs(`fetch('/api/__push?what=settled').then(r=>r.ok)`);
  await evalJs(`(() => { const b=${box}; b.classList.add('is-locked'); document.querySelector('#input').disabled=true; document.querySelector('#btnSend').disabled=true; })()`);
  await shotOf('#composerBox', '98-composer-locked', 'P14-C：无项目时输入区锁定视觉夹具', [], [['输入不可编辑且发送不可用', `document.querySelector('#input').disabled && document.querySelector('#btnSend').disabled && ${box}.classList.contains('is-locked')`]]);
  await evalJs(`(() => { ${box}.classList.remove('is-locked'); document.querySelector('#input').disabled=false; })()`);
  for (const [width, scene] of [[700,'99-composer-700'],[900,'100-composer-900'],[1200,'101-composer-1200'],[1536,'102-composer-1536']]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(230);
    await shotOf('#composerBox', scene, `P14-C：${width}px 控件全部可达`, [], [['同轴且不越界', fit], ['控件全部在输入区内', controls], ['页面无水平溢出', `document.documentElement.scrollWidth<=innerWidth+1`], ['留白同步', reserve]]);
  }
  await send('Emulation.setDeviceMetricsOverride', { width:700, height:600, deviceScaleFactor:1, mobile:false });
  await setText(Array.from({length:24},(_,i)=>`第${i+1}行`).join('\n'));
  await sleep(250);
  await shotOf('#composerBox', '103-composer-low-height', 'P14-C：700×600 仍留有对话空间', [], [['输入区不占半屏', `${outer}.getBoundingClientRect().height < innerHeight*.5`], ['输入内部滚动', `(() => {const t=document.querySelector('#input');return t.scrollHeight>t.clientHeight && t.clientHeight<=innerHeight*.24+1})()`], ['控件可达', controls], ['无水平溢出', `document.documentElement.scrollWidth<=innerWidth+1`], ['留白同步', reserve]]);
  await send('Emulation.setDeviceMetricsOverride', { width:700, height:900, deviceScaleFactor:1, mobile:false });
  await setText('https://example.com/'+'very-long-unbroken-segment'.repeat(18)+'\nC:\\work\\'+('very-long-folder\\'.repeat(18))+'\n这是一段用于验证输入区换行的中文内容。'.repeat(18));
  await sleep(220);
  await shotOf('#composerBox', '104-composer-long-text', 'P14-C：长 URL、路径和中文不推出页面', [], [['长文本确实在输入框', `document.querySelector('#input').value.length>700`], ['页面没有水平溢出', `document.documentElement.scrollWidth<=innerWidth+1`], ['控件仍在容器里', controls], ['留白同步', reserve]]);
  await setText('');
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(250);

  await evalJs('document.querySelector("#navPlanner").click()');
  await sleep(900);
  const pickPlan = async (i) => {
    const ok = await evalJs(
      `(() => { const r = document.querySelectorAll('#workSurface .planner-list .ext-item')[${i}]; if (!r) return false; r.onclick(); return true; })()`
    );
    await sleep(800);
    return ok;
  };

  console.log('\n--- P8-C：人工审阅场景 ---');
  if (await pickPlan(0)) {
    await shotOf('.planner-revsum', '11-rev-summary', 'Plan 顶部审阅汇总（只看最新一次 attempt）');
    await shotOf('.planner-task[data-task-id="tests"] .planner-attempt:last-of-type', '12-rev-pending', 'Scene 1：成功 + 待审阅 + 验证要求(description) + 会话 + 当前 Diff 入口');
    await shotOf('.planner-task[data-task-id="analyze"] .planner-attempt:last-of-type', '13-rev-accepted', 'Scene 2：已接受 + 说明 + reviewedAt');
    await shotOf('.planner-task[data-task-id="backend"] .planner-attempt:last-of-type', '14-rev-needs-changes', 'Scene 3：需修改（失败 + 已写明理由）');
    await shotOf('.planner-task[data-task-id="live"] .planner-attempts', '15-rev-retry-history', 'Scene 4：Attempt 1 已接受 + Attempt 2 执行中（运行期不给审阅操作）');
    /* Scene 5 用 backend 的**第 1 次**尝试：它失败了且还没审阅，
       所以只该出现「需要修改」，不该有「接受本次结果」。 */
    await shotOf('.planner-task[data-task-id="backend"] .planner-attempts > .planner-attempt', '16-rev-failed', 'Scene 5：失败的 Attempt 只有「需要修改」');
    /* P13 收尾：**收起的那行**摘要不再给失败的尝试挂「待审阅」——
     * 那不是一份可验收的产物。展开区里的完整审阅（状态 / 按钮 / 时间）一条不动。 */
    await shotOf('.planner-task[data-task-id="backend"] .planner-attempts > .planner-attempt', '56-attempt-failed-compact',
      'P13：失败的 Attempt —— 折叠头不写「待审阅」，展开的审阅区照旧',
      ['第 1 次', '失败'],
      [
        ['折叠头没有「待审阅」', `(() => { const h = document.querySelector('.planner-task[data-task-id="backend"] .planner-attempt[data-attempt="1"] .planner-attempt-head'); return !!h && !h.querySelector('.planner-att-review'); })()`],
        ['折叠头的验证 / 证据两格还在', `(() => { const h = document.querySelector('.planner-task[data-task-id="backend"] .planner-attempt[data-attempt="1"] .planner-attempt-head'); return !!h && !!h.querySelector('.planner-att-verify') && !!h.querySelector('.planner-att-ev'); })()`],
        ['展开的审阅区仍写「待审阅」（收起 ≠ 删状态）', `(() => { const a = document.querySelector('.planner-task[data-task-id="backend"] .planner-attempt[data-attempt="1"]'); return !!a && !!a.querySelector('.planner-rv') && /待审阅/.test(a.querySelector('.planner-rv').textContent); })()`],
      ]);
    await shotOf('.planner-task[data-task-id="docs"] .planner-attempt:last-of-type', '17-rev-null-snapshot', '没有历史验证要求 → 另起一行标「当前任务验证要求」');

    /* 编辑态 → 保存。夹具对 `tests` 的保存回冲突，所以这一条正好截到 Scene 6。 */
    const opened = await clickIn('.planner-task[data-task-id="tests"] .planner-rv-acts button', '接受本次结果');
    await sleep(450);
    if (opened) {
      await evalJs(
        `(() => { const ta = document.querySelector('.planner-task[data-task-id="tests"] .planner-rv-note-in'); if (!ta) return false; ta.value = '本地写的内容：这条断言我还没确认'; ta.oninput(); return true; })()`
      );
      await sleep(250);
      await shotOf('.planner-task[data-task-id="tests"] .planner-rv', '18-rev-editor', '编辑态：状态选择 + 说明 + 字数 + 保存');
      await clickIn('.planner-task[data-task-id="tests"] .planner-rv-acts button', '保存');
      await sleep(800);
      await shotOf('.planner-task[data-task-id="tests"] .planner-rv', '19-rev-conflict', 'Scene 6：冲突 —— 本地输入保留，等你点重新加载');
    } else {
      console.log('  跳过：没找到「接受本次结果」');
    }

    /* ---------- P9：独立验证的几种状态（都在 plan-1 上） ---------- */
    await shotOf('.planner-task[data-task-id="tests"] .planner-attempt:last-of-type', '24-verify-never', 'P9：从未验证 ——「尚未独立确认」+「运行验证」');
    await shotOf('.planner-task[data-task-id="analyze"] .planner-attempt:last-of-type', '25-verify-passed', 'P9：验证通过 —— 命令 / 退出码 / 耗时 / 输出摘要');
    await shotOf('.planner-task[data-task-id="backend"] .planner-attempts > .planner-attempt', '26-verify-failed', 'P9：验证失败 —— 失败输出 +「输出已截断」');
    await shotOf('.planner-task[data-task-id="hub"] .planner-attempt:last-of-type', '27-verify-interrupted', 'P9：已中断 +「重新运行验证」');
    await shotOf('.planner-task[data-task-id="live"] .planner-attempts > .planner-attempt', '28-verify-running', 'P9：正在验证… +「停止验证」');

    /* ---------- P10：历史变更证据 ---------- */
    /* 打开某条 attempt 的「查看本次 Diff」——它会用 openModal 换掉 Planner 那张卡。 */
    const openEvidence = async (taskId) => {
      const ok = await clickIn(`.planner-task[data-task-id="${taskId}"] .planner-attempt-evidence button`, '查看本次 Diff');
      await sleep(500);
      return ok;
    };
    const reopenPlanner = async () => {
      await evalJs('document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles:true}))');
      await sleep(250);
      await evalJs('document.querySelector("#navPlanner").click()');
      await sleep(700);
      await pickPlan(0);
    };

    if (await openEvidence('analyze')) {
      await shotOf('.modal-card.evidence', '31-attempt-diff', 'P10：历史 Diff（修改）—— 面板写明这是执行前后的冻结证据');
    }
    await reopenPlanner();
    if (await openEvidence('tests')) {
      await shotOf('.modal-card.evidence', '32-attempt-diff-added-deleted', 'P10：历史 Diff —— 新增 / 删除');
    }
    await reopenPlanner();
    if (await openEvidence('backend')) {
      /* 两条都以「展开该文件」来取景 —— 默认收起时这两行在同一张卡片上、滚到
       * 同一个位置，截出来会是**同一张图**（shot() 截的是整个视口）。展开后
       * 画面真正不同，而且各自证明各自的点。
       * 二进制那行**没有** `.ev-patch`（换成一句说明），用结构选中它 ——
       * 不要用 `.ev-kind.added`：那行的 change 是 modified。 */
      const openEvRow = (sel) => evalJs(`(() => { const d = document.querySelector(${JSON.stringify(sel)}); if (!d) return false; d.open = true; return true; })()`);
      const collapseEvRows = () => evalJs(`(() => { for (const d of document.querySelectorAll('.modal-card.evidence .ev-file')) d.open = false; return true; })()`);
      await openEvRow('.modal-card.evidence .ev-file:not(:has(.ev-patch))');
      await shotOf('.modal-card.evidence .ev-file:not(:has(.ev-patch))', '33-attempt-diff-binary', 'P10：历史 Diff —— 二进制文件（展开：不展示文本 Diff）');
      await collapseEvRows();
      await openEvRow('.modal-card.evidence .ev-file:has(.ev-warn)');
      await shotOf('.modal-card.evidence .ev-file:has(.ev-warn)', '34-attempt-diff-truncated', 'P10：历史 Diff —— 截断（展开：单文件 patch + 已截断）');
    }
    await reopenPlanner();
    /* ⚠️ `unavailable` 时**没有**「查看本次 Diff」按钮（smoke W3 把这条钉住了）——
     * 如实说的那句就在 attempt 卡片上，所以拍卡片本身，不是弹层。 */
    await shotOf('.planner-task[data-task-id="hub"] .planner-attempt:last-of-type', '35-attempt-diff-unavailable', 'P10：历史 Diff —— 采集不到（如实说原因，不给按钮）');
    await reopenPlanner();

    /* 长内容 + 700px：整页不许横向溢出 */
    if (await pickPlan(1)) {
      if (await openEvidence('longnote')) {
        const of = await evalJs('({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })');
        console.log('      历史 Diff 长内容：scrollWidth=' + of.sw + ' innerWidth=' + of.iw + ' → 横向溢出=' + (of.sw > of.iw + 1));
        await shotOf('.modal-card.evidence', '36-attempt-diff-long', 'P10：历史 Diff —— 超长路径 + 超长单行 patch');
        await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 950, deviceScaleFactor: 1, mobile: false });
        await sleep(600);
        const of2 = await evalJs('({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })');
        console.log('      历史 Diff @700：scrollWidth=' + of2.sw + ' innerWidth=' + of2.iw + ' → 横向溢出=' + (of2.sw > of2.iw + 1));
        await shotOf('.modal-card.evidence', '37-attempt-diff-narrow-700', 'P10：历史 Diff —— 窄窗口 700px');
        await send('Emulation.clearDeviceMetricsOverride');
        await sleep(400);
      }
    }
    await evalJs('document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles:true}))');
    await sleep(300);
    await reopenPlanner();

    /* ---------- P13：下一步 / Attempt 折叠 / 历史默认收起（都在 plan-1 上） ---------- */
    /* 下一步命中「独立验证在跑」这一支 —— 它排在最前面，连「开始执行」都会被压掉。
     * 这一张同时证明两件事：优先级，以及 running 态不给会失败的 CTA。 */
    await shotOf('.planner-next', '48-next-action-verification', 'P13：下一步 —— 独立验证在跑（优先级最高，且不给「开始执行」）',
      ['下一步', '正在独立验证 live', '第 1 次尝试'],
      [
        ['kind=verification-active', `document.querySelector('.planner-next-text').classList.contains('verification-active')`],
        ['没有「开始执行」按钮', `![...document.querySelectorAll('.planner-next .btn')].some((b) => b.textContent.trim() === '开始执行')`],
        ['CTA 是「查看任务」', `(() => { const b = document.querySelector('.planner-next .btn'); return !!b && b.textContent.trim() === '查看任务'; })()`],
      ]);

    /* 历史默认收起：backend 有两次尝试 —— 只展开最新那条，旧的收起但**内容仍留在
     * DOM 里**（收起不等于删掉）。
     * 判据只能是 aria-expanded / hidden：收起节点的文本照样算进 textContent，
     * 光看文本根本分不出收起还是展开（jsdom 那边同理）。 */
    const backHeads = `.planner-task[data-task-id="backend"] .planner-attempt-head`;
    const backBody1 = `.planner-task[data-task-id="backend"] .planner-attempt[data-attempt="1"] .planner-attempt-body`;
    const backBody2 = `.planner-task[data-task-id="backend"] .planner-attempt[data-attempt="2"] .planner-attempt-body`;
    await shotOf('.planner-task[data-task-id="backend"]', '49-attempt-history-collapsed', 'P13：历史尝试默认收起（每条任务只展开最新一次）',
      ['第 1 次', '第 2 次', '需修改'],
      [
        ['两条尝试各有一个折叠头', `[...document.querySelectorAll(${JSON.stringify(backHeads)})].length === 2`],
        ['折叠头是真 button', `(() => { const h = document.querySelector(${JSON.stringify(backHeads)}); return !!h && h.tagName === 'BUTTON'; })()`],
        ['展开态依次是 false,true', `[...document.querySelectorAll(${JSON.stringify(backHeads)})].map((h) => h.getAttribute('aria-expanded')).join(',') === 'false,true'`],
        ['旧尝试的详情是 hidden', `(() => { const b = document.querySelector(${JSON.stringify(backBody1)}); return !!b && b.hidden === true; })()`],
        ['最新尝试的详情展开', `(() => { const b = document.querySelector(${JSON.stringify(backBody2)}); return !!b && b.hidden === false; })()`],
        ['aria-controls 指向真实节点', `(() => { const h = document.querySelector(${JSON.stringify(backHeads)}); return !!h && !!document.getElementById(h.getAttribute('aria-controls')); })()`],
      ]);

    /* 用户显式展开旧那一条 —— `attemptOpen` 记下他的选择，下一次重绘照它来。 */
    const clickedHead = await evalJs(`(() => { const h = document.querySelector(${JSON.stringify(backHeads)}); if (!h || h.tagName !== 'BUTTON') return false; h.click(); return true; })()`);
    await sleep(500);
    if (clickedHead) {
      await shotOf('.planner-task[data-task-id="backend"]', '50-attempt-history-expanded', 'P13：手动展开历史那一次（用户的选择盖过默认规则）',
        ['第 1 次', '第 2 次'],
        [
          ['展开态 true,true', `[...document.querySelectorAll(${JSON.stringify(backHeads)})].map((h) => h.getAttribute('aria-expanded')).join(',') === 'true,true'`],
          ['旧尝试的详情已展开', `(() => { const b = document.querySelector(${JSON.stringify(backBody1)}); return !!b && b.hidden === false; })()`],
          ['展开的内容有实际高度', `(() => { const b = document.querySelector(${JSON.stringify(backBody1)}); return !!b && b.getBoundingClientRect().height > 20; })()`],
        ]);
    } else {
      console.log('  跳过：没找到 backend 的折叠头');
    }

    /* 混态：同一条头部上，执行结论 / 独立验证 / 人工验收三个维度**各说各的**，
     * 不合并成一个「状态」—— 收起之后更要能一眼分清楚（P13 Blocker 5）。 */
    await shotOf('.planner-task[data-task-id="live"] .planner-attempt[data-attempt="1"]', '52-attempt-head-summary',
      'P13：折叠头 —— 执行 / 验证 / 验收 / 证据四个维度分行（验证在跑 → 强制展开）',
      ['第 1 次', '已接受', '正在验证', '停止验证'],
      [
        ['折叠头是真 button', `(() => { const h = document.querySelector('.planner-task[data-task-id="live"] .planner-attempt[data-attempt="1"] .planner-attempt-head'); return !!h && h.tagName === 'BUTTON'; })()`],
        ['验证在跑 → 必须看得见（交互必需）', `(() => { const h = document.querySelector('.planner-task[data-task-id="live"] .planner-attempt[data-attempt="1"] .planner-attempt-head'); return !!h && h.getAttribute('aria-expanded') === 'true'; })()`],
        ['三个维度各占一格', `(() => { const h = document.querySelector('.planner-task[data-task-id="live"] .planner-attempt[data-attempt="1"] .planner-attempt-head'); return !!h && !!h.querySelector('.planner-att-verify') && !!h.querySelector('.planner-att-review') && !!h.querySelector('.planner-att-ev'); })()`],
        ['证据维度有字', `(() => { const e = document.querySelector('.planner-task[data-task-id="live"] .planner-attempt[data-attempt="1"] .planner-att-ev'); return !!e && e.textContent.trim().length > 0; })()`],
      ]);

    /* focus 到**旧的那一次**：面板是新开的（`attemptOpen` 从空开始），所以老那条
     * 展开只可能来自 focus 参数 —— 按默认规则它会被收起来（见上面的 49）。 */
    const focused = await evalJs(`import('/planner.js').then((m) => { m.openPlanner({ planId: 'plan-1', taskId: 'backend', attempt: 1 }); return true; }).catch((e) => 'import 失败: ' + e.message)`);
    await sleep(1000);
    if (focused === true) {
      await shotOf('.planner-task[data-task-id="backend"]', '53-focus-attempt', 'P13：focus 到旧 attempt —— 打开面板就展开它并滚到视口内',
        ['第 1 次', '第 2 次'],
        [
          ['focus 到的那条是展开的', `(() => { const b = document.querySelector(${JSON.stringify(backBody1)}); return !!b && b.hidden === false; })()`],
          ['新实例默认展开最新那条', `(() => { const b = document.querySelector(${JSON.stringify(backBody2)}); return !!b && b.hidden === false; })()`],
          ['聚焦的那条落在视口内', `(() => { const e = document.querySelector('.planner-task[data-task-id="backend"] .planner-attempt[data-attempt="1"]'); if (!e) return false; const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`],
        ]);
    } else {
      console.log('  跳过：' + focused);
    }

    /* ---------- P11：人工验收门控 ----------
     * plan-gate 是列表里的第 3 个（plan-1 / plan-stress / plan-gate）。 */
    if (await pickPlan(2)) {
      await shotOf('.planner-task[data-task-id="gated-a"] .planner-gate', '38-review-gate-pending', 'P11：门控 —— 执行成功，等待人工验收', ['等待人工验收']);
      await shotOf('.planner-task[data-task-id="gated-ok"] .planner-gate', '39-review-gate-accepted', 'P11：门控 —— 已接受（门控已通过）', ['门控已通过']);
      await shotOf('.planner-task[data-task-id="gated-need"] .planner-gate', '40-review-gate-needs-changes', 'P11：门控 —— 需要修改 · 门控未通过', ['需要修改', '门控未通过']);
      /* P12 blocker 的前端那一半：Retry 之后当前这次还没成功，但历史 attempt1 被接受过。
       * `satisfied=true` 是历史、`required=false` 是当前 —— 文案必须说「执行未成功」，
       * 说「门控已通过」就是拿历史骗人。
       * P13 §二十九再细分一步：这条任务的 status 还是 `pending`（重试排队中、**还没跑**），
       * 说「执行未成功」等于指控一次还没发生的执行 → 改成「尚未产生新结果」。 */
      await shotOf('.planner-task[data-task-id="gated-retry"] .planner-gate', '45-review-gate-retry-pending', 'P12→P13：门控 —— 重试排队中（历史 accepted 不算已通过；还没跑过 ≠ 执行未成功）', ['尚未产生新结果', '门控未开始']);
      /* ---------- P13：下一步（被依赖挡住这一支） ----------
       * plan-gate 里有一条 `blockedReason: 'dependency-failed'` 的下游（P11 夹具），
       * 而「被阻塞」排在「等验收」前面 —— 所以这个计划的下一步说的是它，不是验收。
       * 这是对的：验收救不了一条被依赖失败挡住的任务。等验收那一支见 47（plan-wait）。 */
      await shotOf('.planner-next', '55-next-action-blocked', 'P13：下一步 —— 被上游卡住（点名到具体任务，排在「等验收」之前）',
        ['下一步', '处理被阻塞的任务 gated-faildown', '查看任务'],
        [
          ['kind=blocked', `document.querySelector('.planner-next-text').classList.contains('blocked')`],
          ['不给「开始执行」', `![...document.querySelectorAll('.planner-next .btn')].some((b) => b.textContent.trim() === '开始执行')`],
        ]);
      await shotOf('.planner-task[data-task-id="gated-down"] .planner-blocked', '41-review-gate-downstream-blocked', 'P11：下游 —— 等待人工验收：gated-a', ['等待人工验收', 'gated-a']);
      await shotOf('.planner-progress', '42-review-gate-plan-paused', 'P11：Plan 顶部 —— 已暂停·等待人工验收 + 门控汇总', ['已暂停', '人工门控 1/5']);
      await shotOf('.planner-task[data-task-id="gated-a"] .planner-gate-toggle', '43-review-gate-editor', 'P11：任务上的门控勾选框', ['需要人工验收后再继续下游']);
      const go = await evalJs('({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })');
      console.log('      门控页：scrollWidth=' + go.sw + ' innerWidth=' + go.iw + ' → 横向溢出=' + (go.sw > go.iw + 1));
      await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 950, deviceScaleFactor: 1, mobile: false });
      await sleep(600);
      const go2 = await evalJs('({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })');
      console.log('      门控页 @700：scrollWidth=' + go2.sw + ' innerWidth=' + go2.iw + ' → 横向溢出=' + (go2.sw > go2.iw + 1));
      await shotOf('.planner-task[data-task-id="gated-long"]', '44-review-gate-narrow-700', 'P11：窄窗口 700px —— 超长标题 + 门控行', ['gated-long', '门控']);
      await send('Emulation.clearDeviceMetricsOverride');
      await sleep(400);
    }

    /* ---------- P13：下一步的 ready 态（列表第 4 个：plan-ux） ----------
     * 这是唯一会给出「开始执行」的一支：没有失败、没有门控、没有阻塞、没有验证在跑。 */
    if (await pickPlan(3)) {
      await shotOf('.planner-next', '46-next-action-ready', 'P13：下一步 —— 可以执行（唯一给「开始执行」的分支）',
        ['下一步', '有 1 个任务可以执行', '开始执行'],
        [
          ['kind=ready', `document.querySelector('.planner-next-text').classList.contains('ready')`],
          ['文案精确是「有 1 个任务可以执行」（数量是数出来的）', `document.querySelector('.planner-next-text').textContent.trim() === '有 1 个任务可以执行'`],
          ['CTA 是「开始执行」', `(() => { const b = document.querySelector('.planner-next .btn'); return !!b && b.textContent.trim() === '开始执行'; })()`],
          ['状态不是只靠颜色', `(() => { const e = document.querySelector('.planner-next-text'); return !!e && e.textContent.trim().length > 0; })()`],
        ]);
      /* 窄窗口：下一步那一行是「文字 + 右侧按钮」，700px 下要确认没把按钮挤出界。 */
      await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 950, deviceScaleFactor: 1, mobile: false });
      await sleep(600);
      const nx = await evalJs('({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })');
      console.log('      下一步 @700：scrollWidth=' + nx.sw + ' innerWidth=' + nx.iw + ' → 横向溢出=' + (nx.sw > nx.iw + 1));
      await shotOf('.planner-next', '54-next-action-narrow-700', 'P13：窄窗口 700px —— 下一步与它的按钮不挤成一团',
        ['下一步', '有 1 个任务可以执行', '开始执行'],
        [
          ['按钮还在视口里', `(() => { const b = document.querySelector('.planner-next .btn'); if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth; })()`],
          ['没有横向溢出', `document.documentElement.scrollWidth <= window.innerWidth + 1`],
        ]);
      await send('Emulation.clearDeviceMetricsOverride');
      await sleep(400);
    }

    /* ---------- P13：下一步的 waiting-review 态（列表第 5 个：plan-wait） ---------- */
    if (await pickPlan(4)) {
      await shotOf('.planner-next', '47-next-action-review', 'P13：下一步 —— 等人工验收（点名到具体任务，不写「去验收」）',
        ['下一步', '验收 gated-main 的最新成功结果', '查看任务'],
        [
          ['kind=waiting-review', `document.querySelector('.planner-next-text').classList.contains('waiting-review')`],
          ['不给「开始执行」', `![...document.querySelectorAll('.planner-next .btn')].some((b) => b.textContent.trim() === '开始执行')`],
          ['主按钮是「查看任务」', `(() => { const b = document.querySelector('.planner-next .btn'); return !!b && b.textContent.trim() === '查看任务'; })()`],
        ]);
    }

    /* 压力项（§五十八）：1000 字说明 / 20 个变更文件 / 超长路径 / 10 次尝试 / 窄窗口 */
    if (await pickPlan(1)) {
      await shotOf('.planner-task[data-task-id="longnote"] .planner-attempt:last-of-type', '20-stress-long-note', '压力：1000 字说明 + 20 个文件 + 超长路径');
      await shotOf('.planner-task[data-task-id="longnote"] .planner-verify-detail', '29-verify-long', 'P9 压力：长命令 + 长输出（被截断）');
      await shotOf('.planner-task[data-task-id="manyattempts"] .planner-attempts', '21-stress-many-attempts', '压力：10 次尝试');
      /* P13：10 次尝试不该摊成一面墙 —— 默认只展开最新那一条，其余 9 条收着。 */
      const manyHeads = `.planner-task[data-task-id="manyattempts"] .planner-attempt-head`;
      await shotOf('.planner-task[data-task-id="manyattempts"] .planner-attempts', '51-attempt-history-10', 'P13：10 次尝试 —— 默认只展开第 10 次，9 条历史收起但一条不少',
        ['第 1 次', '第 10 次', '失败'],
        [
          ['10 个折叠头', `[...document.querySelectorAll(${JSON.stringify(manyHeads)})].length === 10`],
          ['每条头都是真 button', `[...document.querySelectorAll(${JSON.stringify(manyHeads)})].every((h) => h.tagName === 'BUTTON')`],
          ['只有 1 条展开', `[...document.querySelectorAll(${JSON.stringify(manyHeads)})].filter((h) => h.getAttribute('aria-expanded') === 'true').length === 1`],
          ['展开的是最新那条', `[...document.querySelectorAll(${JSON.stringify(manyHeads)})].pop().getAttribute('aria-expanded') === 'true'`],
        ]);
      await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 950, deviceScaleFactor: 1, mobile: false });
      await sleep(700);
      const of = await evalJs('({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })');
      console.log('      窄窗口 700：scrollWidth=' + of.sw + ' innerWidth=' + of.iw + ' → 横向溢出=' + (of.sw > of.iw + 1));
      await shotOf('.planner-task[data-task-id="longnote"] .planner-attempt:last-of-type', '22-stress-narrow-700', '压力：窄窗口 700px');

      /* 回到 plan-1 再截一次汇总 —— 「中断」是这一轮新增的 token，
       * 它让那一行更长，所以窄窗口下要单独确认没有挤坏 / 溢出。 */
      if (await pickPlan(0)) {
        const of2 = await evalJs('({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })');
        console.log('      plan-1 @700：scrollWidth=' + of2.sw + ' innerWidth=' + of2.iw + ' → 横向溢出=' + (of2.sw > of2.iw + 1));
        await shotOf('.planner-revsum', '23-summary-narrow-700', '窄窗口 700px：含「中断」的汇总行');
        await shotOf('.planner-task[data-task-id="backend"] .planner-verify-detail', '30-verify-narrow-700', 'P9 窄窗口 700px：验证明细（命令 + 输出）');
      }
      await send('Emulation.clearDeviceMetricsOverride');
      await sleep(400);
    }

    await evalJs('document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles:true}))');
    await sleep(300);
  } else {
    console.log('  跳过：打不开 Planner 面板（夹具服务里没有计划？）');
  }

  /* P14-D: primary Stage surfaces, navigation continuity and real layout bounds. */
  const surfaceChecks = (view) => [
    ['一级工作区与唯一 rail active', `document.querySelector('#workspace').dataset.workspaceView===${JSON.stringify(view)} && document.querySelectorAll('#globalRail [aria-current="page"]').length===1`],
    ['没有一级 Modal 遮罩', `document.querySelector('#modal').hidden`],
    ['Chat DOM 仍挂载且非 Chat 时 Composer 隐藏', `!!document.querySelector('#stream .thread') && ${view === 'chat' ? `!document.querySelector('#chatComposer').hidden` : `document.querySelector('#chatComposer').hidden && document.querySelector('#chatView').hidden`}`],
    ['Surface 在 Stage 内且无页面横向溢出', `(() => { const s=document.querySelector(${view === 'chat' ? "'#chatView'" : "'#workSurface'"}).getBoundingClientRect(),w=document.querySelector('#workspace').getBoundingClientRect(); return s.left>=w.left-1 && s.right<=w.right+1 && s.bottom<=w.bottom+1 && document.documentElement.scrollWidth<=innerWidth+1; })()`],
  ];
  await evalJs(`document.querySelector('#navHome').click()`);
  await evalJs(`fetch('/api/__conversation?what=fixture').then(r=>r.ok)`);
  await sleep(350);
  await shotOf('#workspace', '105-workspace-chat', 'P14-D：Chat 默认一级视图', [], surfaceChecks('chat'));
  await setText('未发送草稿');
  if (ATTACH.length) { await setFiles(ATTACH.slice(0, 1)); await sleep(1650); }
  await evalJs(`(() => { const stream=document.querySelector('#stream'); stream.scrollTop=Math.floor((stream.scrollHeight-stream.clientHeight)*.5); window.__p14d={node:document.querySelector('#stream .msg'),scroll:stream.scrollTop,atBottom:stream.scrollHeight-stream.clientHeight-stream.scrollTop<=24,attachment:document.querySelector('#attachTray .att')}; })()`);
  await evalJs(`document.querySelector('#navPlanner').click()`);
  await sleep(550);
  await shotOf('#workSurface', '106-workspace-planner', 'P14-D：Planner Stage 工作区', ['生成计划'], [...surfaceChecks('planner'), ['计划列表与详情真实可见', `(() => {const l=document.querySelector('#workSurface .planner-list'),d=document.querySelector('#workSurface .planner-detail');return l?.getBoundingClientRect().width>0&&d?.getBoundingClientRect().width>0})()`]]);
  await evalJs(`document.querySelector('#workSurface .planner-list .ext-item')?.click()`);
  await sleep(420);
  await shotOf('#workSurface .planner-detail', '107-workspace-planner-detail', 'P14-D：Plan detail 与下一步', ['下一步'], [['下一步位于详情前段', `(() => {const d=document.querySelector('.planner-detail'),n=d?.querySelector('.planner-next');return !!n&&n.getBoundingClientRect().top<d.getBoundingClientRect().top+360})()`], ['唯一选中 Plan', `document.querySelectorAll('#workSurface .planner-list .ext-item[aria-current="true"]').length===1`]]);
  await shotOf('.planner-task[data-task-id="backend"] .planner-attempts', '108-workspace-planner-attempts', 'P14-D：Attempt 历史折叠', [], [['折叠语义有效', `[...document.querySelectorAll('.planner-task[data-task-id="backend"] .planner-attempt-toggle')].every(b=>b.getAttribute('aria-controls')&&document.getElementById(b.getAttribute('aria-controls'))?.hidden===(b.getAttribute('aria-expanded')==='false'))`]]);
  await shotOf('.planner-task[data-task-id="tests"] .planner-rv', '109-workspace-planner-review', 'P14-D：人工验收', [], [['审阅操作仍在', `!!document.querySelector('.planner-task[data-task-id="tests"] .planner-rv')`]]);
  await shotOf('.planner-task[data-task-id="live"] .planner-verify-detail', '110-workspace-planner-verification', 'P14-D：验证状态', [], [['验证细节来自原 renderer', `!!document.querySelector('.planner-verify-detail')`]]);
  await evalJs(`fetch('/api/__conversation?what=work-stream').then(r=>r.ok)`);
  await sleep(180);
  await evalJs(`document.querySelector('#navChanges').click()`);
  await sleep(500);
  await shotOf('#workSurface', '111-workspace-changes', 'P14-D：Changes Stage 工作区', ['文件变更', 'public/app.js'], [...surfaceChecks('changes'), ['真实文件行', `document.querySelectorAll('#workSurface .chg-row').length>=3`]]);
  await evalJs(`document.querySelector('#workSurface .chg-main')?.click()`);
  await sleep(300);
  await shotOf('#workSurface .chg-row.open', '112-workspace-changes-expanded', 'P14-D：展开的 unified diff', ['public/app.js'], [['diff 有实际高度', `document.querySelector('#workSurface .chg-diff')?.getBoundingClientRect().height>30`], ['页面无横向溢出', `document.documentElement.scrollWidth<=innerWidth+1`]]);
  await evalJs(`document.querySelector('#chgFilterSession')?.click()`);
  await shotOf('#workSurface', '113-workspace-changes-filter-session', 'P14-D：仅本次会话', ['仅本次会话'], [['过滤按钮选中', `document.querySelector('#chgFilterSession')?.classList.contains('on')`]]);
  await evalJs(`fetch('/api/__work-surface/git-clean?value=1').then(r=>r.ok)`);
  await evalJs(`document.querySelector('#workSurface .chg-head .btn:not(.danger)')?.click()`);
  await sleep(350);
  await shotOf('#workSurface', '114-workspace-changes-clean', 'P14-D：干净工作区中性空态', ['没有文件变更'], [['无文件行', `document.querySelectorAll('#workSurface .chg-row').length===0`]]);
  await evalJs(`fetch('/api/__work-surface/git-clean?value=0').then(r=>r.ok)`);
  await evalJs(`document.querySelector('#navExtensions').click()`);
  await sleep(550);
  await shotOf('#workSurface', '115-workspace-extensions', 'P14-D：Skills Stage 工作区', ['Skills', 'code-review'], [...surfaceChecks('extensions'), ['Skill 列表可见', `document.querySelectorAll('#workSurface .ext-list .ext-item').length===3`]]);
  await evalJs(`document.querySelector('#workSurface .ext-list .ext-item')?.click()`);
  await sleep(250);
  await shotOf('#workSurface .ext-detail', '116-workspace-skill-detail', 'P14-D：Skill 详情', ['code-review'], [['唯一选中 Skill', `document.querySelectorAll('#workSurface .ext-list .ext-item[aria-current="true"]').length===1`]]);
  await evalJs(`[...document.querySelectorAll('#workSurface .ext-list .ext-item')].find(x=>x.textContent.includes('proj-only'))?.click()`);
  await sleep(220);
  await shotOf('#workSurface', '117-workspace-skill-untrusted', 'P14-D：未信任 Skill 状态', ['项目未被信任'], [['状态有文字', `document.querySelector('#workSurface .ext-list .ext-item.on')?.textContent.includes('项目未被信任')`]]);
  await evalJs(`[...document.querySelectorAll('#workSurface .ext-tab')].find(x=>x.textContent==='MCP')?.click()`);
  await sleep(250);
  await shotOf('#workSurface', '118-workspace-mcp', 'P14-D：MCP 能力报告', ['没有原生 MCP 支持'], [['不是虚构 Server 列表', `document.querySelector('#workSurface .ext-mcp')?.textContent.includes('没有可列出的 MCP Server')`]]);
  await evalJs(`document.querySelector('#navHome').click()`);
  await sleep(200);
  console.log('P14-D 保持诊断: ' + JSON.stringify(await evalJs(`(() => {const p=window.__p14d,s=document.querySelector('#stream');return {node:s.querySelector('.msg')===p.node,draft:document.querySelector('#input').value,attachment:document.querySelector('#attachTray .att')===p.attachment,scroll:s.scrollTop,expected:p.scroll};})()`)));
  await shotOf('#workspace', '119-workspace-switch-preserves-chat', 'P14-D：切换后保留 Chat、草稿、附件与后台流式内容', ['离开 Chat 时继续生成的正文'], [...surfaceChecks('chat'), ['节点、草稿、附件与滚动保持', `(() => {const p=window.__p14d,s=document.querySelector('#stream');const correctScroll=p.atBottom?s.scrollHeight-s.clientHeight:s.scrollTop-p.scroll;return s.querySelector('.msg')===p.node&&document.querySelector('#input').value==='未发送草稿'&&document.querySelector('#attachTray .att')===p.attachment&&(p.atBottom?Math.abs(s.scrollTop-correctScroll)<=1:Math.abs(correctScroll)<=1)})()`]]);
  for (const [width, label] of [[700,'120-workspace-700'],[900,'121-workspace-900'],[1200,'122-workspace-1200'],[1536,'123-workspace-1536']]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evalJs(`document.querySelector('#navPlanner').click()`);
    await sleep(350);
    await shotOf('#workSurface', label, `P14-D：${width}px Planner 无整体横向溢出`, ['生成计划'], [...surfaceChecks('planner'), ['页面无横向溢出', `document.documentElement.scrollWidth<=innerWidth+1`]]);
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 600, deviceScaleFactor: 1, mobile: false });
  await sleep(350);
  await shotOf('#workSurface', '124-workspace-low-height', 'P14-D：700×600 工作区内部滚动', ['生成计划'], [...surfaceChecks('planner'), ['工作区底部不越过 Stage', `document.querySelector('#workSurface').getBoundingClientRect().bottom<=document.querySelector('#workspace').getBoundingClientRect().bottom+1`]]);
  await send('Emulation.clearDeviceMetricsOverride');

  /* P14-D 收口：从 Planner 侧栏成功切换历史会话，必须回到 Chat 并重建那条会话。 */
  const switchedFromPlanner = await evalJs(`(() => { const b=[...document.querySelectorAll('#projects .pj-sess-primary')].find(x=>x.textContent.includes('README')); if (!b) return false; b.click(); return true; })()`);
  if (!switchedFromPlanner) shotFailures.push('125-workspace-session-switch-to-chat: 找不到 README 历史会话入口');
  await sleep(750);
  await shotOf('#workspace', '125-workspace-session-switch-to-chat', 'P14-D 收口：Planner 切历史会话后回 Chat', ['这是 README 会话的历史消息'], [
    ['Chat 是唯一 primary active', `document.querySelector('#workspace').dataset.workspaceView==='chat' && document.querySelector('#navHome').getAttribute('aria-current')==='page' && document.querySelectorAll('#globalRail [aria-current="page"]').length===1`],
    ['Chat 与 Composer 实际可见', `(() => { const c=document.querySelector('#chatView'),p=document.querySelector('#chatComposer'); return !c.hidden && !p.hidden && c.getBoundingClientRect().height>0 && p.getBoundingClientRect().height>0; })()`],
    ['Work Surface 已卸载', `document.querySelector('#workSurface').hidden && document.querySelector('#workSurface').childElementCount===0`],
    ['新会话历史已重建且可见', `(() => { const e=[...document.querySelectorAll('#chatView .msg')].find(x=>x.textContent.includes('这是 README 会话的历史消息')); return !!e && e.getBoundingClientRect().height>0; })()`],
    ['没有页面运行时异常', pageErrors.length === 0 ? 'true' : 'false'],
  ]);

  /* P14-E: computed colors are checked on rendered controls, including selected state. */
  const neutralControls = `(() => {
    const amber = value => { const m=value.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/); if(!m)return false; const [r,g,b]=m.slice(1).map(Number); return r>130&&g>90&&r>g*1.06&&g>b*1.3; };
    return [...document.querySelectorAll('button,[role="button"],.project.active,.pj-sess.on,.ext-item.on,.modal-item.on')]
      .filter(e => { const r=e.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'; })
      .every(e => { const s=getComputedStyle(e); return ![s.color,s.backgroundColor,s.borderTopColor,s.borderBottomColor,s.borderLeftColor,s.borderRightColor].some(amber); });
  })()`;
  const viewportChecks = (selector) => [
    ['无整体横向或纵向滚动', `document.documentElement.scrollWidth<=innerWidth+1 && document.documentElement.scrollHeight<=innerHeight+1`],
    ['工作区有可用高度且位于 Stage 内', `(() => {const a=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(),s=document.querySelector('#workspace').getBoundingClientRect();return a.height>180&&a.left>=s.left-1&&a.right<=s.right+1&&a.bottom<=s.bottom+1})()`],
    ['关键操作在 Stage 水平边界内', `(() => {const s=document.querySelector('#workspace').getBoundingClientRect();return [...document.querySelectorAll('#chatComposer button,#workSurface .chg-head button,#workSurface .ext-bar button,#workSurface .planner-bar button')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}).every(e=>{const r=e.getBoundingClientRect();return r.left>=s.left-1&&r.right<=s.right+1})})()`],
    ['内部滚动容器承担滚动', `getComputedStyle(document.querySelector(${JSON.stringify(selector==='#chatView'?'#stream':'#workSurface')})).overflowY===${JSON.stringify(selector==='#chatView'?'auto':'hidden')}`],
    ['可见交互控件无琥珀色', neutralControls],
  ];
  await shotOf('#workspace', '126-neutral-buttons-chat', 'P14-E：Chat 控件与选中侧栏为灰阶', [], [['计算后的交互色为中性', neutralControls]]);
  await shotOf('#chatComposer', '127-neutral-composer-controls', 'P14-E：Composer 控件与发送按钮为灰阶', [], [['计算后的交互色为中性', neutralControls]]);
  await evalJs(`document.querySelector('#btnModel').click()`);
  await sleep(180);
  await shotOf('.pop', '128-neutral-popover', 'P14-E：Popover 当前项为灰阶', [], [['计算后的交互色为中性', neutralControls], ['选中项可见', `!!document.querySelector('.pop-item.on')`]]);
  await closePop();
  await evalJs(`document.querySelector('#navPlanner').click()`);
  await sleep(450);
  await shotOf('#workSurface', '129-neutral-planner', 'P14-E：Planner 主次按钮为灰阶', ['生成计划'], [...viewportChecks('#workSurface')]);
  await evalJs(`document.querySelector('#workSurface .planner-list .ext-item')?.click()`);
  await sleep(250);
  await shotOf('.planner-rv', '130-neutral-planner-review', 'P14-E：Review 操作为灰阶', [], [['计算后的交互色为中性', neutralControls]]);
  await evalJs(`document.querySelector('#navChanges').click()`);
  await sleep(350);
  await shotOf('#workSurface', '131-neutral-changes', 'P14-E：Git 过滤与危险按钮主体中性', ['文件变更'], [...viewportChecks('#workSurface')]);
  await evalJs(`document.querySelector('#navExtensions').click()`);
  await sleep(350);
  await evalJs(`document.querySelector('#workSurface .ext-list .ext-item')?.click()`);
  await shotOf('#workSurface', '132-neutral-extensions', 'P14-E：Skill 选中与 Tabs 为灰阶', ['code-review'], [...viewportChecks('#workSurface')]);
  await evalJs(`document.querySelector('#navGlobalMore').click(); document.querySelector('#navProviders').click()`);
  await sleep(200);
  await shotOf('#modal', '133-neutral-modal', 'P14-E：供应商 Modal 按钮为灰阶', ['模型供应商'], [['计算后的交互色为中性', neutralControls], ['Modal 位于视口内', `(() => {const r=document.querySelector('#modal .modal-card').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()`]]);
  await evalJs(`document.querySelector('#modal').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  await evalJs(`document.querySelector('#navChanges').click()`);
  await sleep(320);
  await evalJs(`document.querySelector('#chgFilterAll')?.click()`);
  await sleep(150);
  await evalJs(`document.querySelector('#workSurface .chg-head .btn.danger')?.click()`);
  await sleep(200);
  await shotOf('#confirmLayer', '134-neutral-confirm', 'P14-E：危险确认主操作使用中性底色', ['撤销全部'], [['计算后的交互色为中性', neutralControls], ['危险按钮无大面积红色背景', `(() => {const b=document.querySelector('#confirmLayer .btn.danger');return !!b&&getComputedStyle(b).backgroundColor!=='rgb(248, 113, 113)'})()`], ['确认按钮文字完整且操作区不溢出', `(() => {const a=document.querySelector('#confirmLayer .modal-actions');return a.scrollWidth<=a.clientWidth+1&&[...a.querySelectorAll('button')].every(b=>getComputedStyle(b).whiteSpace==='nowrap'&&b.getBoundingClientRect().height>=30)})()`]]);
  await evalJs(`document.querySelector('#confirmLayer .btn:not(.danger)')?.click()`);

  const pressKey = async (key, code, windowsVirtualKeyCode) => {
    await send('Input.dispatchKeyEvent', {type:'keyDown',key,code,windowsVirtualKeyCode});
    await send('Input.dispatchKeyEvent', {type:'keyUp',key,code,windowsVirtualKeyCode});
  };
  await evalJs(`document.querySelector('#navGlobalMore').click()`);
  await pressKey('Escape','Escape',27);
  const moreReturned = await evalJs(`document.activeElement?.id==='navGlobalMore' && document.querySelector('#globalMoreMenu').hidden`);
  await pressKey('Tab','Tab',9);
  await pressKey('Tab','Tab',9);
  await shotOf('#workspace', '135-focus-keyboard', 'P14-E：真实键盘 Tab 焦点环', [], [
    ['More Escape 回触发器', moreReturned ? 'true' : 'false'],
    ['两次 Tab 后焦点可见', `(() => {const e=document.activeElement,s=getComputedStyle(e);return e!==document.body&&e.matches(':focus-visible')&&s.outlineStyle!=='none'&&s.outlineWidth!=='0px'})()`],
  ]);
  await pressKey('Enter','Enter',13);
  await pressKey('Escape','Escape',27);
  if (await evalJs(`!document.querySelector('#modal').hidden`)) await evalJs(`document.querySelector('#modal').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);

  for (const [view, width, height, n] of [
    ['chat',700,900,'139-responsive-chat-700'],['planner',700,900,'140-responsive-planner-700'],
    ['changes',700,900,'141-responsive-changes-700'],['extensions',700,900,'142-responsive-extensions-700'],
    ['chat',900,650,'143-low-height-chat'],['planner',700,600,'144-low-height-planner'],
    ['extensions',700,600,'145-low-height-extensions'],
    ['chat',700,600,'147-low-height-chat-700'],['chat',1200,650,'148-low-height-chat-1200'],
    ['chat',1536,650,'149-low-height-chat-1536'],
  ]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor:1, mobile:false });
    await evalJs(`document.querySelector(${JSON.stringify(view==='chat'?'#navHome':'#nav'+view[0].toUpperCase()+view.slice(1))})?.click()`);
    await sleep(320);
    const selector = view==='chat'?'#chatView':'#workSurface';
    await shotOf('#workspace', n, `P14-E：${view} ${width}×${height}`, [], viewportChecks(selector));
  }
  await send('Emulation.setDeviceMetricsOverride', { width:700,height:600,deviceScaleFactor:1,mobile:false });
  await closePop();
  await evalJs(`document.querySelector('#btnModel').click()`);
  await sleep(180);
  await shotOf('.pop', '150-popover-700-low', 'P14-E：700×600 Popover 不裁切', [], [['浮层可见且完全在视口', `(() => {const p=document.querySelector('.pop'),r=p.getBoundingClientRect();return !p.hidden&&r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`], ['计算后的交互色为中性', neutralControls]]);
  await closePop();
  await evalJs(`document.querySelector('#navGlobalMore').click()`);
  await shotOf('#globalMoreMenu', '151-more-700-low', 'P14-E：700×600 More 可访问', [], [['More 在视口内', `(() => {const r=document.querySelector('#globalMoreMenu').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`], ['计算后的交互色为中性', neutralControls]]);
  await evalJs(`document.querySelector('#navProviders').click()`);
  await sleep(160);
  await shotOf('#modal', '152-modal-700-low', 'P14-E：700×600 Modal 按钮可见', ['模型供应商'], [['Modal 在视口内', `(() => {const r=document.querySelector('#modal .modal-card').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()`], ['计算后的交互色为中性', neutralControls]]);
  await evalJs(`document.querySelector('#modal').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  await send('Emulation.setDeviceMetricsOverride', { width:701,height:602,deviceScaleFactor:1,mobile:false });
  await evalJs(`document.querySelector('#navPlanner').click()`);
  await sleep(220);
  await shotOf('#workspace', '153-dpi-rounded-701', 'P14-E：Electron DPI 取整后仍进入窄屏布局', ['生成计划'], [
    ...viewportChecks('#workSurface'),
    ['项目侧栏已收窄，计划列表上下排列', `document.querySelector('#projectSidebar').getBoundingClientRect().width<=191 && getComputedStyle(document.querySelector('#workSurface .ext-split')).flexDirection==='column'`],
  ]);
  await send('Emulation.clearDeviceMetricsOverride');
  await evalJs(`fetch('/api/__work-surface/session-reset').then(r=>r.ok)`);

  /* P14-E 收口：真鼠标先聚焦 Sidebar 按钮；刷新移除旧按钮后仍需落在 Composer。 */
  await send('Page.reload');
  await sleep(1600);
  await evalJs(`document.querySelector('#navPlanner').click()`);
  await sleep(350);
  const sessionPoint = await evalJs(`(() => {
    const b=[...document.querySelectorAll('#projects .pj-sess-primary')].find(x=>x.tagName==='BUTTON'&&x.textContent.includes('README'));
    if (!b) return null;
    window.__p14eOldSessionButton=b;
    b.scrollIntoView({block:'nearest'});
    const r=b.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
  })()`);
  if (!sessionPoint) throw new Error('154-session-switch-focus: 找不到 README 历史会话按钮');
  await send('Input.dispatchMouseEvent', {type:'mouseMoved', ...sessionPoint});
  await send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...sessionPoint});
  const focusedByMouse = await evalJs(`document.activeElement===window.__p14eOldSessionButton`);
  await send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...sessionPoint});
  for (let i=0; i<40 && await evalJs(`window.__p14eOldSessionButton.isConnected`); i++) await sleep(50);
  for (let i=0; i<40 && !await evalJs(`document.querySelector('#chatView').textContent.includes('这是 README 会话的历史消息')`); i++) await sleep(50);
  await shotOf('#workspace', '154-session-switch-focus', 'P14-E：真鼠标切换侧栏历史会话后 Composer 获焦点', ['这是 README 会话的历史消息'], [
    ['鼠标按下先聚焦旧会话按钮', focusedByMouse ? 'true' : 'false'],
    ['Sidebar 刷新已移除旧按钮', `!window.__p14eOldSessionButton.isConnected`],
    ['Chat 与 Composer 可见', `document.querySelector('#workspace').dataset.workspaceView==='chat' && !document.querySelector('#chatView').hidden && !document.querySelector('#chatComposer').hidden`],
    ['焦点位于 Composer 而非 body', `document.activeElement===document.querySelector('#input') && document.activeElement!==document.body`],
    ['历史已重建', `document.querySelector('#chatView').textContent.includes('这是 README 会话的历史消息')`],
  ]);

  console.log('页面异常: ' + (pageErrors.length ? pageErrors.join(' | ') : '无'));
  console.log('取景判据: ' + (shotFailures.length ? '✗ ' + shotFailures.length + ' 条 —— ' + shotFailures.join('；') : '✓ 全部截图的取景中心都在视口内且关键词齐'));

  ws.close();
  chrome.kill();
  console.log('\n完成');
  process.exit(shotFailures.length ? 1 : 0);
}

main().catch((e) => {
  console.log('失败: ' + e.message);
  process.exit(1);
});
