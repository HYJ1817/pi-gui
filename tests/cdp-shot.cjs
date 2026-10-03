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
  const hit = process.argv.findLast((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const APP = arg('url', 'http://127.0.0.1:7788/');
const TAG = arg('tag', '');
const AUTH_ONLY = arg('auth-only', 'false') === 'true';

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

  if (!AUTH_ONLY) {
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
      groups: [...p.querySelectorAll('.pop-provider-name')].map(x => x.textContent),
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
  const authShots = async () => {
    // Phase changes are local fixture routes; no browser authorization is opened.
    for (const [width, height] of [[700, 600], [900, 700], [1200, 800], [1536, 900]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      for (const phase of ['native-list', 'browser', 'device', 'select', 'unknown', 'connected']) {
        await evalJs(`if(!document.querySelector('#modal').hidden) document.querySelector('#modal').click()`);
        await evalJs(`fetch('/api/__provider-auth/${phase}',{method:'POST'}).then(r=>r.json())`);
        await evalJs(`window.__authComposerBefore=document.querySelector('#composerBox').getBoundingClientRect().toJSON();document.querySelector('#navProviders').click()`);
        await sleep(450);
        const flowPhase = ['browser', 'device', 'select'].includes(phase);
        const must = flowPhase ? [] : ['供应商与认证', 'ChatGPT'];
        if (phase === 'browser') must.push('等待浏览器授权', '打开授权页面');
        if (phase === 'device') must.push('DEMO-2048', '在浏览器中输入设备码');
        if (phase === 'select') must.push('选择认证方法', '设备码授权');
        if (phase === 'unknown') must.push('未知（无法确认）', '/login');
        if (phase === 'connected') must.push('已连接（本机凭据）');
        await shotOf(flowPhase ? '.auth-flow' : '.modal-card', `P25-auth-${phase}-${width}x${height}`, 'P25：离线认证状态、灰阶有界弹层与稳定 Composer', must, [
          ['弹层完全在视口内，仅内部滚动', `(() => {const e=document.querySelector('.modal-card'),r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&e.scrollWidth<=e.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth})()`],
          ['Composer 不位移', `['x','y','width','height'].every(k=>Math.abs(document.querySelector('#composerBox').getBoundingClientRect()[k]-window.__authComposerBefore[k])<.5)`],
          ['认证视图不含密钥输入或凭据值', `(() => {const e=document.querySelector('.provider-auth');return !e.querySelector('input[type="password"],input[name="apiKey"]')&&!/(access_token|refresh_token|client_secret|Bearer |sk-[a-z0-9]{12})/i.test(e.textContent)})()`],
          ['原生登录方法来自安全描述', `document.querySelectorAll('.auth-provider').length===2&&document.querySelector('[data-provider-id="openai"] .auth-method').textContent==='ChatGPT 订阅'`],
          ['认证状态和流程符合相位', phase === 'unknown' ? `document.querySelectorAll('[data-auth-login]').length===0` : phase === 'select' ? `document.querySelector('[data-auth-prompt]').tagName==='SELECT'&&document.querySelector('[data-auth-prompt]').options.length===2` : phase === 'device' ? `document.querySelector('.auth-device-code').textContent==='DEMO-2048'` : phase === 'connected' ? `document.querySelector('.auth-status').textContent==='已连接（本机凭据）'` : `!!document.querySelector('[data-auth-login="openai"]')`],
        ]);
        await clickIn('.modal-card button', '关闭');
      }
    }
    await send('Emulation.clearDeviceMetricsOverride');
  };
  if (AUTH_ONLY) {
    await authShots();
    console.log('页面异常: ' + (pageErrors.length ? pageErrors.join(' | ') : '无'));
    console.log('P25 取景判据: ' + (shotFailures.length ? shotFailures.join('；') : '全部成立'));
    ws.close(); chrome.kill();
    process.exit(shotFailures.length || pageErrors.length ? 1 : 0);
  }

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
  /* P22：Extensions 工作区默认落在 All（统一能力视图），Skills 是它的第四个过滤器。 */
  await shotOf('#workSurface', '115-workspace-extensions', 'P14-D / P22：扩展工作区默认落在 All 能力视图', ['Web Access', 'Native MCP', '已加载'], [...surfaceChecks('extensions'), ['能力行与统一状态行都在', `document.querySelectorAll('#workSurface .cap-view .ext-item').length>=8 && [...document.querySelectorAll('#workSurface .cap-view .cap-status-line')].every(e=>e.textContent.trim().length>0)`], ['项目级 Extension 没丢', `[...document.querySelectorAll('#workSurface .cap-view .ext-name')].some(e=>e.textContent==='acme-toolkit')`]]);
  await evalJs(`document.querySelector('#extensionsTabSkills').click()`);
  await sleep(400);
  await shotOf('#workSurface', '115b-workspace-skills', 'P14-D：Skills Stage 工作区', ['Skills', 'code-review'], [['Skill 列表可见', `document.querySelectorAll('#workSurface .ext-list .ext-item').length===3`]]);
  await evalJs(`document.querySelector('#workSurface .ext-list .ext-item')?.click()`);
  await sleep(250);
  await shotOf('#workSurface .ext-detail', '116-workspace-skill-detail', 'P14-D：Skill 详情', ['code-review'], [['唯一选中 Skill', `document.querySelectorAll('#workSurface .ext-list .ext-item[aria-current="true"]').length===1`]]);
  await evalJs(`[...document.querySelectorAll('#workSurface .ext-list .ext-item')].find(x=>x.textContent.includes('proj-only'))?.click()`);
  await sleep(220);
  await shotOf('#workSurface', '117-workspace-skill-untrusted', 'P14-D：未信任 Skill 状态', ['项目未被信任'], [['状态有文字', `document.querySelector('#workSurface .ext-list .ext-item.on')?.textContent.includes('项目未被信任')`]]);
  await evalJs(`[...document.querySelectorAll('#workSurface .ext-tab')].find(x=>x.textContent==='MCP')?.click()`);
  await sleep(250);
  await shotOf('#workSurface', '118-workspace-mcp', 'P14-D / P20.6：MCP 原生集成（版本真值 + built-in + Server 管理面）', ['这个 pi 带 MCP 能力', 'builtin:mcp', '0.99.1'], [
    ['Server 明细走原生摘要', `document.querySelector('#workSurface .ext-mcp')?.textContent.includes('MCP Servers（pi 原生）')`],
    ['原生状态横幅有证据', `document.querySelector('#workSurface .ext-mcp')?.textContent.includes('原生 MCP 生效中')`],
    ['built-in 不被当成普通 Extension', `document.querySelector('#workSurface .ext-mcp')?.textContent.includes('不由 Extension Registry 的目录扫描发现')`],
    ['不伪造工具注册表', `document.querySelector('#workSurface .ext-mcp')?.textContent.includes('没有一条返回已注册工具清单')`],
    ['版本带出处', `document.querySelector('#workSurface .ext-mcp')?.textContent.includes('来源 package.json')`],
    ['不再写死「没有原生 MCP」', `!document.querySelector('#workSurface .ext-mcp')?.textContent.includes('没有原生 MCP 支持')`],
    ['enable 等如实说走 /mcp', `document.querySelector('#workSurface .ext-mcp')?.textContent.includes('没有官方自动化接口')`],
  ]);
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
  /* P22：默认落在 All 能力视图；这一张量的是 Skill 选中行的中性色，所以先切到 Skills。 */
  await evalJs(`document.querySelector('#extensionsTabSkills')?.click()`);
  await sleep(350);
  await evalJs(`document.querySelector('#workSurface .ext-list .ext-item')?.click()`);
  await shotOf('#workSurface', '132-neutral-extensions', 'P14-E：Skill 选中与 Tabs 为灰阶', ['code-review'], [...viewportChecks('#workSurface')]);
  await evalJs(`document.querySelector('#navGlobalMore').click(); document.querySelector('#navProviders').click()`);
  await sleep(200);
  await shotOf('#modal', '133-neutral-modal', 'P14-E：供应商 Modal 按钮为灰阶', ['供应商与认证'], [['计算后的交互色为中性', neutralControls], ['Modal 位于视口内', `(() => {const r=document.querySelector('#modal .modal-card').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()`]]);
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
  await shotOf('#modal', '152-modal-700-low', 'P14-E：700×600 Modal 按钮可见', ['供应商与认证'], [['Modal 在视口内', `(() => {const r=document.querySelector('#modal .modal-card').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()`], ['计算后的交互色为中性', neutralControls]]);
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

  /* P15: 在真浏览器布局中检查 Extension 列表和详情。 */
  await evalJs(`document.querySelector('#navExtensions').click()`);
  await sleep(260);
  await evalJs(`document.querySelector('#extensionsTabExtensions').click()`);
  for (let i=0; i<40 && !await evalJs(`document.querySelector('#workSurface .ext-extension-item')`); i++) await sleep(50);
  /* P22 夹具里 registry 有多条（Web / Memory / example-tools / 两条未知），
   * 所以按名字点，不按位置点 —— 位置会随夹具顺序漂。 */
  await evalJs(`[...document.querySelectorAll('#workSurface .ext-extension-item')].find(n=>n.textContent.includes('example-tools'))?.click()`);
  for (let i=0; i<40 && !(await evalJs(`document.querySelector('#workSurface .ext-detail')?.textContent.includes('command: example')`)); i++) await sleep(50);
  await shotOf('#workSurface', '155-extension-registry', 'P15：Extension 发现列表和只读详情', ['example-tools', '1.2.3', 'command: example'], [
    ...viewportChecks('#workSurface'),
    ['Extensions 标签选中', `document.querySelector('#extensionsTabExtensions').getAttribute('aria-selected')==='true'`],
    ['工具来源未知有明确说明', `document.querySelector('#workSurface .ext-detail').textContent.includes('未提供已注册工具列表')`],
  ]);

  await evalJs(`document.querySelector('#navHome').click()`);
  await evalJs(`fetch('/api/__conversation?what=web-activity').then(r=>r.ok)`);
  await sleep(300);
  await evalJs(`document.querySelector('[data-id="p16-search"] .tl-toggle').click()`);
  await shotOf('#workspace', '156-web-activity', 'P16：离线 Web Search 与 URL Fetch Activity', ['Searched the web', 'Read Pi documentation', 'pi.dev'], [
    ...viewportChecks('#chatView'),
    ['来源只允许 HTTPS 且明确用户点击', `document.querySelector('[data-id="p16-search"] .web-source').href==='https://pi.dev/'`],
    ['网页全文未铺开', `!document.querySelector('[data-id="p16-fetch"]').textContent.includes('Offline page body')`],
  ]);

  await evalJs(`fetch('/api/__conversation?what=browser-activity').then(r=>r.ok)`);
  await sleep(340);
  await evalJs(`document.querySelector('[data-id="p20-nav"] .tl-toggle').click()`);
  await shotOf('#workspace', '165-browser-activity', 'P20：真实浏览器 Activity，输入内容与页面正文不投影', ['Opened example.com', 'Clicked [e12]', 'Entered text', 'Read example.com', 'Captured page screenshot', 'Waiting for page failed'], [
    ...viewportChecks('#chatView'),
    ['只给安全的可点击来源', `document.querySelector('[data-id="p20-nav"] .web-source').href==='https://example.com/'`],
    ['输入内容不进 DOM', `!document.querySelector('[data-id="p20-fill"]').outerHTML.includes('PRIVATE_TYPED_SECRET')`],
    ['页面正文与标题不进 DOM', `!document.querySelector('[data-id="p20-read"]').outerHTML.includes('PRIVATE_PAGE_BODY') && !document.querySelector('[data-id="p20-read"]').outerHTML.includes('PRIVATE_PAGE_TITLE')`],
    ['点击的页面文本不进 DOM', `!document.querySelector('[data-id="p20-click"]').outerHTML.includes('PRIVATE_ELEMENT_TEXT')`],
    ['本机路径不进 DOM', `!document.querySelector('[data-id="p20-shot"]').outerHTML.includes('PRIVATE')`],
    ['上游错误原文不进 DOM', `!document.querySelector('[data-id="p20-timeout"]').outerHTML.includes('PRIVATE_UPSTREAM_MESSAGE')`],
    ['整体没有浏览器 PRIVATE_ 残留', `!['PRIVATE_TYPED_SECRET','PRIVATE_PAGE_BODY','PRIVATE_PAGE_TITLE','PRIVATE_ELEMENT_TEXT','PRIVATE_UPSTREAM_MESSAGE'].some(m=>document.querySelector('#stream').outerHTML.includes(m))`],
  ]);

  await evalJs(`fetch('/api/__conversation?what=subagent-activity').then(r=>r.ok)`);
  await sleep(350);
  await evalJs(`document.querySelector('[data-id="p17-workflow"] .tl-toggle').click(); document.querySelector('[data-id="p17-workflow"]').scrollIntoView({block:'center'})`);
  await shotOf('#workspace', '157-subagent-workflow', 'P17：真实结构化 child 状态与显式关系', ['Children: 2', 'review-ui', 'review-api'], [
    ...viewportChecks('#chatView'),
    ['child 状态互不覆盖', `document.querySelector('[data-id="p17-workflow"] .tl-out').textContent.includes('review-ui · custom-ui · completed') && document.querySelector('[data-id="p17-workflow"] .tl-out').textContent.includes('review-api · custom-api · running')`],
    ['父关系来自实际字段', `document.querySelector('[data-id="p17-workflow"] .tl-out').textContent.includes('Parent tool: p17-workflow')`],
    ['raw transcript 不展示', `!document.querySelector('#stream').textContent.includes('RAW_CHILD_SECRET')`],
  ]);
  await evalJs(`document.querySelector('[data-id="p17-bg"] .tl-toggle').click(); document.querySelector('[data-id="p17-bg"]').scrollIntoView({block:'center'})`);
  await shotOf('#workspace', '158-subagent-background', 'P17：后台启动与完成分开、loader 不启动 child', ['Background launched', 'bg-run', 'Subagent tools enabled'], [
    ...viewportChecks('#chatView'),
    ['background 明确未知完成状态', `document.querySelector('[data-id="p17-bg"]').textContent.includes('completion unknown')`],
    ['并发调用只有一个节点', `document.querySelectorAll('[data-id="p17-bg"]').length===1 && document.querySelectorAll('[data-id="p17-single"]').length===1`],
  ]);
  await evalJs(`fetch('/api/__conversation?what=supervisor-activity').then(r=>r.ok)`);
  await sleep(300);
  await evalJs(`for(const action of ['status','pending','reply']) document.querySelector('[data-id="supervisor-'+action+'"] .tl-toggle').click(); document.querySelector('[data-id="supervisor-pending"]').scrollIntoView({block:'center'})`);
  await shotOf('#workspace', '159-subagent-supervisor', 'P17 收口：Supervisor 安全 metadata，消息与路径不展示', ['Checked supervisor channel', 'Pending replies: 2', 'Pending requests: 1', 'Replied to subagent'], [
    ...viewportChecks('#chatView'),
    ['raw payload 不进入 DOM', `![...document.querySelectorAll('[data-id^="supervisor-"]')].some(n=>n.outerHTML.includes('PRIVATE_'))`],
    ['reply 只用实际 result metadata', `document.querySelector('[data-id="supervisor-reply"] .tl-out').textContent.includes('Request: req-1') && document.querySelector('[data-id="supervisor-reply"] .tl-out').textContent.includes('Agent: worker')`],
    ['未知 action 仍走安全语义路径', `document.querySelector('[data-id="supervisor-something-new"] .tl-label').textContent==='Subagent supervisor action' && document.querySelector('[data-id="supervisor-something-new"] .tl-args').textContent===''`],
  ]);
  await evalJs(`fetch('/api/__conversation?what=memory-activity').then(r=>r.ok)`);
  await sleep(350);
  await evalJs(`for(const id of ['p18-write','p18-search']) document.querySelector('[data-id="'+id+'"] .tl-toggle').click(); document.querySelector('[data-id="p18-search"]').scrollIntoView({block:'center'})`);
  await shotOf('#workspace', '160-memory-activity', 'P18：Pi Memory 写入与检索 Activity，正文与绝对路径不铺开', ['Saved to memory', 'Searched memory', 'Matches: 4'], [
    ...viewportChecks('#chatView'),
    ['记忆正文不进入 DOM', `!document.querySelector('#stream').textContent.includes('PRIVATE_MEMORY_TEXT')`],
    ['绝对路径不进入 DOM', `!document.querySelector('#stream').textContent.includes('p18user')`],
    ['raw args/details 为空', `document.querySelector('[data-id="p18-search"] .tl-args').textContent===''`],
  ]);
  await evalJs(`for(const id of ['p18-forget','p18-status','p18-scratchpad']) document.querySelector('[data-id="'+id+'"] .tl-toggle').click(); document.querySelector('[data-id="p18-status"]').scrollIntoView({block:'center'})`);
  await shotOf('#workspace', '161-memory-status', 'P18：忘记 / 状态 / Scratchpad 的语义与安全投影', ['Removed from memory', 'Recovery available', 'Checked memory status', 'Added to scratchpad'], [
    ...viewportChecks('#chatView'),
    ['recovery ID 与路径不展示', `!document.querySelector('#stream').textContent.includes('0f0e6b3c') && !document.querySelector('#stream').textContent.includes('.json')`],
    ['scratchpad 条目文本不展示', `!document.querySelector('#stream').textContent.includes('PRIVATE_SCRATCHPAD_ITEM')`],
    ['qmd 状态只来自 result', `document.querySelector('[data-id="p18-status"] .tl-out').textContent.includes('qmd: available') && document.querySelector('[data-id="p18-status"] .tl-out').textContent.includes('Embeddings: ready')`],
  ]);
  await evalJs(`fetch('/api/__conversation?what=memory-soft-failure').then(r=>r.ok)`);
  await sleep(350);
  await evalJs(`for(const id of ['p18sf-read','p18sf-sp','p18sf-write','p18sf-status']) document.querySelector('[data-id="'+id+'"] .tl-toggle').click(); document.querySelector('[data-id="p18sf-sp"]').scrollIntoView({block:'center'})`);
  await shotOf('#workspace', '163-memory-soft-failure', 'P18-Fix：details={} 的 soft-failure 降级为「结果不可用」，不按请求参数猜成功', ['Memory read result unavailable', 'Scratchpad result unavailable', 'Memory write result unavailable'], [
    ...viewportChecks('#chatView'),
    ['请求参数不顶成成功', `!document.querySelector('[data-id="p18sf-read"]').textContent.includes('Read daily log') && !document.querySelector('[data-id="p18sf-sp"]').textContent.includes('Checked off scratchpad item')`],
    ['soft-failure raw 文本与路径不进 DOM', `!document.querySelector('#stream').textContent.includes('No daily log') && !document.querySelector('#stream').textContent.includes('No matching open item') && !document.querySelector('#stream').textContent.includes('p18user')`],
    ['soft-failure 不被改判成失败', `document.querySelector('[data-id="p18sf-read"]').dataset.status==='success' && document.querySelector('[data-id="p18sf-sp"]').dataset.status==='success'`],
    ['未发布的 refresh snapshot 不冒充已知模式', `document.querySelector('[data-id="p18sf-status"] .tl-out').textContent.includes('Snapshot: unrecognized') && !document.querySelector('[data-id="p18sf-status"] .tl-out').textContent.includes('refresh')`],
  ]);
  await evalJs(`fetch('/api/__conversation?what=approval-request').then(r=>r.ok)`);
  await sleep(300);
  await shotOf('#confirmLayer', '164-approval-request', 'P19：Extension 审批请求走统一确认层，只给一次性的允许 / 拒绝', ['Allow rm -rf build/?', '允许一次', '拒绝'], [
    ['确认层在视口内且有高度', `(() => {const r=document.querySelector('#confirmLayer .modal-card').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.height>0})()`],
    ['只给一次性的两个决定', `[...document.querySelectorAll('#confirmLayer button')].map(b=>b.textContent).join(',')==='拒绝,允许一次'`],
    ['按钮文字完整且操作区不溢出', `(() => {const a=document.querySelector('#confirmLayer .modal-actions');return a.scrollWidth<=a.clientWidth+1&&[...a.querySelectorAll('button')].every(b=>getComputedStyle(b).whiteSpace==='nowrap'&&b.getBoundingClientRect().height>=30)})()`],
    ['额外字段与原始 payload 不进 DOM', `!document.querySelector('#confirmLayer').outerHTML.includes('PRIVATE_')`],
  ]);
  await evalJs(`[...document.querySelectorAll('#confirmLayer button')].find(b=>b.textContent==='拒绝')?.click()`);
  await sleep(120);
  await evalJs(`document.querySelector('#usageDetails').open = true`);
  await sleep(180);
  await shotOf('#usageDetails', '167-usage-multicurrency', 'P21-Fix-2：DeepSeek 多币种额度只做并排摘要（不相加）', ['远端额度', '¥110.00 | $15.00'], [
    ['侧栏摘要是两币种并排且不相加', `document.querySelector('#uQuota').textContent === '¥110.00 | $15.00'`],
    ['没有把缺失当 0', `!document.querySelector('#uQuota').textContent.includes('$0.00')`],
    ['行高正常、没有溢出', `(() => {const d=document.querySelector('#usageDetails .quota-detail');return d.scrollWidth<=d.clientWidth+1&&d.getBoundingClientRect().height>0})()`],
  ]);
  await evalJs(`document.querySelector('#btnCtx').click()`);
  await sleep(220);
  await shotOf('#composerPopover', '168-usage-quota-popover', 'P21-Fix-2：额度 Popover 逐币种展示（DOM 构建，无 innerHTML 插值）', ['剩余额度 (CNY)', '剩余额度 (USD)'], [
    ['逐币种各一行', `(() => {const t=document.querySelector('#composerPopover').textContent;return t.includes('剩余额度 (CNY)')&&t.includes('剩余额度 (USD)')})()`],
    ['赠送/充值行存在', `document.querySelector('#composerPopover').textContent.includes('赠送额度 (CNY)')&&document.querySelector('#composerPopover').textContent.includes('充值额度 (CNY)')`],
    ['没有 HTML 元素被动态注入', `document.querySelector('#composerPopover').querySelectorAll('img,script').length===0`],
    ['Popover 在视口内', `(() => {const r=document.querySelector('#composerPopover').getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth+1})()`],
  ]);
  await evalJs(`document.querySelector('#btnCtx').click()`);
  await sleep(120);
  await evalJs(`fetch('/api/__conversation?what=quota-unknown-unit').then(r=>r.ok)`);
  await sleep(420);
  await evalJs(`document.querySelector('#usageDetails').open = true`);
  await sleep(180);
  await shotOf('#usageDetails', '169-usage-unknown-unit', 'P21-Fix-4：单位未知时只显示数值（不加 $ / ¥）', ['远端额度', '75.00'], [
    ['侧栏是纯数值 75.00', `document.querySelector('#uQuota').textContent === '75.00'`],
    ['没有货币符号或币种名', `!/[$¥]|USD|CNY/.test(document.querySelector('#uQuota').textContent)`],
    ['行高正常、没有溢出', `(() => {const d=document.querySelector('#usageDetails .quota-detail');return d.scrollWidth<=d.clientWidth+1&&d.getBoundingClientRect().height>0})()`],
  ]);
  await evalJs(`document.querySelector('#btnCtx').click()`);
  await sleep(220);
  await shotOf('#composerPopover', '170-usage-unknown-unit-popover', 'P21-Fix-4：单位未知时 Popover 拆成数值行并标注「单位未知」', ['剩余额度', '已使用', '总额度', '单位未知'], [
    ['三行数值都在', `(() => {const t=document.querySelector('.tip-quota-section').textContent;return t.includes('剩余额度')&&t.includes('已使用')&&t.includes('总额度')})()`],
    /* 只看额度区：会话累计成本那行本来就是 $（本地用量，单位明确），不该被这条判据扫到。 */
    ['额度区正文里没有 $ / ¥ / USD / CNY', `!/[$¥]|USD|CNY/.test(document.querySelector('.tip-quota-section').textContent)`],
    ['额度区明确标注单位未知', `document.querySelector('.tip-quota-section').textContent.includes('单位未知')`],
    ['没有 HTML 元素被动态注入', `document.querySelector('#composerPopover').querySelectorAll('img,script').length===0`],
  ]);
  await evalJs(`document.querySelector('#btnCtx').click()`);
  await sleep(120);
  await evalJs(`fetch('/api/__conversation?what=quota-restore-model').then(r=>r.ok)`);
  await sleep(160);
  await evalJs(`document.querySelector('#navExtensions').click()`);
  await sleep(300);
  /* P22：Pi Memory 的 setup 已并入统一的 Capability 详情（不再是 Extensions 页里的一段）。 */
  await evalJs(`document.querySelector('#extensionsTabCapabilities')?.click()`);
  await sleep(400);
  await evalJs(`[...document.querySelectorAll('#workSurface .cap-view .ext-item')].find(n=>n.textContent.includes('Pi Memory'))?.click()`);
  await sleep(300);
  await shotOf('#workSurface .cap-view .ext-detail', '162-memory-setup', 'P22：Pi Memory 设置区（统一布局：固定命令 + 真实运行观察 + 限制）', ['Pi Memory（长期记忆）', 'pi install npm:pi-memory', '这不是「会话搜索」'], [
    ['固定官方安装命令只出现一次', `document.querySelectorAll('#workSurface .cap-view .ext-detail code').length===1`],
    ['运行观察来自真实事件', `document.querySelector('#workSurface .cap-rows [data-k="运行观察"] .ext-row-v').textContent.includes('memory_search')`],
    ['动作是安装 / 复制 / 安装后重启', `[...document.querySelectorAll('#workSurface .cap-view .ext-acts button')].every(b=>b.textContent==='安装'||b.textContent==='复制安装命令'||b.textContent==='安装后重启 Pi'||b.textContent==='重新检查')`],
    ['已安装（Registry 确认过）的能力不摆动作按钮', `document.querySelector('#workSurface .cap-view .cap-install')===null`],
  ]);
  /* ---------- P22：Capability 视图（统一状态 / Native MCP / built-in / 未知 / 响应式） ----------
   *
   * 这里量的是 jsdom 量不到的那几样：真实布局宽度、列表项高度、横向溢出、
   * 700/900/1200/1536 四档宽度。断言只描述**结构事实**（有几个字段、有没有
   * 那个元素），不描述像素值 —— 像素值随字体变，钉它只会得到假红。 */
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evalJs(`document.querySelector('#navExtensions').click()`);
  await sleep(500);
  await evalJs(`document.querySelector('#extensionsTabAll')?.click()`);
  await sleep(400);
  await shotOf('#workSurface', '171-capability-all', 'P22：All —— 一条统一界面回答「这个能力现在能不能用」', ['Web Access', 'Native MCP', 'builtin:mcp', 'acme-toolkit', '未知'], [
    ...surfaceChecks('extensions'),
    ['每行都有统一状态行', `(() => {const rows=[...document.querySelectorAll('#workSurface .cap-view .ext-item')];return rows.length>=8&&rows.every(r=>(r.querySelector('.cap-status-line')?.textContent||'').trim().length>0)})()`],
    ['unknown Extension 仍在列表里', `[...document.querySelectorAll('#workSurface .cap-view .ext-name')].some(e=>e.textContent==='acme-toolkit')`],
    ['built-in 不伪装成普通 Extension', `[...document.querySelectorAll('#workSurface .cap-view .ext-name')].some(e=>e.textContent==='builtin:mcp')`],
    ['没有巨型卡片（每项高度受控）', `[...document.querySelectorAll('#workSurface .cap-view .ext-item')].every(e=>e.getBoundingClientRect().height<120)`],
    ['列表与详情都是真实宽度', `(() => {const l=document.querySelector('#workSurface .cap-view .ext-list'),d=document.querySelector('#workSurface .cap-view .ext-detail');return l.getBoundingClientRect().width>0&&d.getBoundingClientRect().width>0})()`],
  ]);

  await evalJs(`[...document.querySelectorAll('#workSurface .cap-view .ext-item')].find(n=>(n.querySelector('.ext-name')||{}).textContent==='Web Access')?.click()`);
  await sleep(320);
  await shotOf('#workSurface .cap-view .ext-detail', '172-capability-web-setup', 'P22：统一 setup 布局 —— 名称 / 用途 / **只画适用的字段** / 固定官方命令 / 一键安装 / 限制', ['Web Access', 'pi install npm:pi-web-access', '运行观察', '限制'], [
    ['只画适用的状态字段（第三方 Extension 五个，没有空诊断行）', `(() => {const keys=[...document.querySelectorAll('#workSurface .cap-rows .ext-row')].map(r=>r.dataset.k);return JSON.stringify(keys)===JSON.stringify(['安装状态','启用配置','已加载','运行观察','需要重启'])})()`],
    ['固定官方命令只出现一次', `document.querySelectorAll('#workSurface .cap-view .ext-detail code').length===1`],
    ['已安装的能力不摆动作按钮：只剩复制命令与安装后重启（顺序固定）', `(() => {const t=[...document.querySelectorAll('#workSurface .cap-view .ext-acts button')].map(b=>b.textContent);return t.length===2&&t[0]==='复制安装命令'&&t[1]==='安装后重启 Pi'})()`],
    ['没有安装表单（不提供任意包名入口）', `document.querySelectorAll('#workSurface .cap-view .ext-detail input').length===0`],
  ]);

  await evalJs(`[...document.querySelectorAll('#workSurface .cap-view .ext-item')].find(n=>n.textContent.includes('Native MCP'))?.click()`);
  await sleep(320);
  await shotOf('#workSurface .cap-view .ext-detail', '173-capability-native-mcp', 'P22：Native MCP 进入统一体验，但**不显示** npm 安装命令', ['Native MCP（pi 内置）', '没有安装命令', '原生 MCP 生效中', '不构成'], [
    ['没有安装命令元素', `document.querySelector('#workSurface .cap-view .ext-detail code')===null`],
    ['说明来自 Pi built-in capability', `document.querySelector('#workSurface .cap-view .ext-detail').textContent.includes('built-in capability')`],
    ['原生状态原文来自 P20.6', `document.querySelector('#workSurface .cap-view .ext-detail').textContent.includes('未被接管')`],
    ['一个伪造开关都没有', `document.querySelectorAll('#workSurface .cap-view .ext-acts button').length===0`],
  ]);

  await evalJs(`[...document.querySelectorAll('#workSurface .cap-view .ext-item')].find(n=>n.textContent.includes('builtin:mcp'))?.click()`);
  await sleep(300);
  await shotOf('#workSurface .cap-view .ext-detail', '174-capability-builtin', 'P22：built-in 能力 —— 「包里带了它」≠「当前启用了它」', ['builtin:mcp', 'pi 内置扩展', '出处'], [
    ['「启用 / 加载」显示不适用而不是否', `(() => {const v=k=>document.querySelector('#workSurface .cap-rows [data-k="'+k+'"] .ext-row-v').textContent;return v('启用配置')==='不适用'&&v('已加载')==='不适用'})()`],
    ['带原文出处', `document.querySelector('#workSurface .cap-view .ext-detail .ext-code.quote').textContent.includes('builtin: true')`],
    ['说明不由目录扫描发现', `document.querySelector('#workSurface .cap-view .ext-detail').textContent.includes('不由 Extension Registry 的目录扫描发现')`],
  ]);

  /* 发现失败 → 只能显示「未知（无法确认）」。这一条是整页纪律的核心。 */
  await evalJs(`fetch('/api/__capability/registry-fail?value=1').then(r=>r.ok)`);
  await evalJs(`[...document.querySelectorAll('#workSurface .cap-view .ext-bar .btn')].find(b=>b.textContent==='刷新')?.click()`);
  await sleep(520);
  await evalJs(`[...document.querySelectorAll('#workSurface .cap-view .ext-item')].find(n=>n.textContent.includes('Web Access'))?.click()`);
  await sleep(300);
  await shotOf('#workSurface .cap-view .ext-detail', '175-capability-unknown', 'P22：发现失败时是「未知（无法确认）」，绝不是「未安装」', ['未知（无法确认）'], [
    ['安装状态是未知而不是否', `document.querySelector('#workSurface .cap-rows [data-k="安装状态"] .ext-row-v').textContent==='未知（无法确认）'`],
    ['已加载同样是未知', `document.querySelector('#workSurface .cap-rows [data-k="已加载"] .ext-row-v').textContent==='未知（无法确认）'`],
    ['没有把未知写成「未安装」', `!document.querySelector('#workSurface .cap-rows [data-k="安装状态"] .ext-row-v').textContent.includes('未安装')`],
    ['结论行也是未知', `document.querySelector('#workSurface .cap-verdict-text').textContent.includes('未知')`],
  ]);
  await evalJs(`fetch('/api/__capability/registry-fail?value=0').then(r=>r.ok)`);

  for (const [width, label] of [[700, '176-capability-700'], [900, '177-capability-900'], [1200, '178-capability-1200'], [1536, '179-capability-1536']]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evalJs(`document.querySelector('#navExtensions').click()`);
    await sleep(460);
    await shotOf('#workSurface', label, `P22：${width}px 能力视图 —— 无横向溢出、无巨型卡片`, ['Web Access'], [
      ...surfaceChecks('extensions'),
      ['页面无横向溢出', `document.documentElement.scrollWidth<=innerWidth+1`],
      ['能力行高度受控', `[...document.querySelectorAll('#workSurface .cap-view .ext-item')].every(e=>e.getBoundingClientRect().height<140)`],
      ['每行文字不横向溢出', `[...document.querySelectorAll('#workSurface .cap-view .ext-item')].every(e=>e.scrollWidth<=e.clientWidth+1)`],
    ]);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);

  await evalJs(`document.querySelector('#navExtensions').click()`);
  await sleep(460);
  await evalJs(`(() => {const s=document.querySelector('#workSurface .cap-view .ext-search');s.value='memory';s.dispatchEvent(new Event('input'))})()`);
  await sleep(260);
  await shotOf('#workSurface', '180-capability-search', 'P22：按名称 / 用途 / 状态搜索（搜索与过滤器叠加）', ['Pi Memory'], [
    ['搜索结果收窄且仍是完整行', `(() => {const rows=[...document.querySelectorAll('#workSurface .cap-view .ext-item')];return rows.length>=1&&rows.length<10&&rows.every(r=>r.querySelector('.cap-status-line'))})()`],
    ['汇总行显示当前筛选数', `document.querySelector('#workSurface .cap-view .ext-sum-label').textContent.includes('当前筛选')`],
    ['搜索框是 type=search（不是任意输入口）', `document.querySelector('#workSurface .cap-view .ext-search').type==='search'`],
  ]);
  /* ---------- P24 收口：侧栏三点菜单 + Capability 一键安装 ----------
   *
   * 参考用户给的 Codex 侧栏截图，只取四件事：**紧凑、三点入口、单色线性图标、
   * danger 的层级**。这些场景量的是排版事实，不是「文本里有没有某个词」：
   *   - 菜单挂在 body 上 → 不会被侧栏的 overflow 裁掉，也不会跑出窗口；
   *   - trigger 不把项目行 / 会话行撑高（UX-03 / UX-09 的几何仍然成立）；
   *   - danger 项静止时**不是**鲜红，hover 才有轻微红色；
   *   - 详情只画适用的字段（不再有一串「不适用」）；
   *   - 一键安装的确认、安装中、结束后按重新发现的结果显示。
   *
   * ⚠️ 前面那些场景会折叠侧栏、开搜索，所以这里先 reload 回到干净的首屏。 */
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.reload');
  await sleep(1700);
  await evalJs(`document.querySelector('#navHome').click()`);
  await sleep(320);

  const projectHoverPoint = await evalJs(`(() => {
    const row = document.querySelector('#projects .project');
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (projectHoverPoint) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...projectHoverPoint });
    await sleep(280);
  }
  await shotOf('#projects', 'UX-MENU-01-project-row-hover', 'P24 侧栏：项目行 hover —— 行尾三点显形，行仍然是紧凑的一行', ['pi-GUI'], [
    ['三点在 hover 时可见', `getComputedStyle(document.querySelector('#projects .project .pj-row-menu-trigger')).opacity==='1'`],
    ['项目行仍然 ≤36px（没有被 trigger 撑高）', `document.querySelector('#projects .project').offsetHeight<=36`],
    ['旧的行尾 ✕ 已经不存在', `document.querySelectorAll('#projects .pj-del').length===0`],
    ['每行只有一个三点入口', `document.querySelectorAll('#projects .project .pj-row-menu-trigger').length===document.querySelectorAll('#projects .project').length`],
    ['trigger 本身很小（≤22px 高）', `(() => {const t=document.querySelector('#projects .project .pj-row-menu-trigger');return t.getBoundingClientRect().height<=22})()`],
    ['完整路径仍在 title 上（没有多出第二行）', `(() => {const p=document.querySelector('#projects .project');return !p.querySelector('.pj-path')&&/[\\\\/]/.test(p.title)})()`],
  ]);

  const projectTriggerPoint = await evalJs(`(() => {
    const t = document.querySelector('#projects .project .pj-row-menu-trigger');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (projectTriggerPoint) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...projectTriggerPoint });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...projectTriggerPoint });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...projectTriggerPoint });
    await sleep(300);
  }
  await shotOf('#actionMenu', 'UX-MENU-02-project-menu-open', 'P24 侧栏：项目菜单 —— 项目设置 / 分隔线 / 移除项目（danger）', ['项目设置', '移除项目'], [
    ['菜单挂在 body 上（不被侧栏 overflow 裁掉）', `document.querySelector('#actionMenu').parentElement===document.body`],
    ['菜单完全在视口内（不跑出窗口）', `(() => {const r=document.querySelector('#actionMenu').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1})()`],
    ['没有盖住对话区', `(() => {const m=document.querySelector('#actionMenu').getBoundingClientRect();const c=document.querySelector('#chatView');if(!c)return true;return m.right<=c.getBoundingClientRect().left+1})()`],
    ['role=menu + 两个 menuitem', `document.querySelector('#actionMenu').getAttribute('role')==='menu'&&document.querySelectorAll('#actionMenu [role="menuitem"]').length===2`],
    ['有低对比分隔线', `Boolean(document.querySelector('#actionMenu [role="separator"]'))`],
    ['宽度 180–240px', `(() => {const w=document.querySelector('#actionMenu').getBoundingClientRect().width;return w>=180&&w<=240})()`],
    ['每项高 30–38px', `[...document.querySelectorAll('#actionMenu .action-menu-item')].every(b=>{const h=b.getBoundingClientRect().height;return h>=30&&h<=38})`],
    ['每项都有单色线性图标', `[...document.querySelectorAll('#actionMenu .action-menu-item')].every(b=>Boolean(b.querySelector('.action-menu-ic svg')))`],
    ['trigger 的 aria-expanded=true', `document.querySelector('#projects .project .pj-row-menu-trigger').getAttribute('aria-expanded')==='true'`],
    ['菜单只有一个浮层实例', `document.querySelectorAll('#actionMenu').length===1`],
  ]);

  /* danger 的层级：静止时**不是**鲜红（也不整行常驻红底）。 */
  await shotOf('#actionMenu', 'UX-MENU-05a-danger-at-rest', 'P24 侧栏：危险项的静止态 —— 不常驻鲜红，只比普通项略暗一档', ['移除项目'], [
    ['危险项静止时没有红底', `(() => {const b=[...document.querySelectorAll('#actionMenu .action-menu-item')].find(x=>x.textContent.includes('移除项目'));return getComputedStyle(b).backgroundColor==='rgba(0, 0, 0, 0)'})()`],
    ['危险项有 danger 类（层级由 CSS 决定）', `(() => {const b=[...document.querySelectorAll('#actionMenu .action-menu-item')].find(x=>x.textContent.includes('移除项目'));return b.classList.contains('danger')})()`],
  ]);
  const dangerPoint = await evalJs(`(() => {
    const b=[...document.querySelectorAll('#actionMenu .action-menu-item')].find(x=>x.textContent.includes('移除项目'));
    if (!b) return null;
    const r=b.getBoundingClientRect();
    return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
  })()`);
  if (dangerPoint) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...dangerPoint });
    await sleep(260);
  }
  await shotOf('#actionMenu', 'UX-MENU-05-danger-item-hover', 'P24 侧栏：危险项 hover —— 这时才有轻微红色', ['移除项目'], [
    ['hover 时才有底色', `(() => {const b=[...document.querySelectorAll('#actionMenu .action-menu-item')].find(x=>x.textContent.includes('移除项目'));return getComputedStyle(b).backgroundColor!=='rgba(0, 0, 0, 0)'})()`],
    ['文字色是柔和的暖色，不是纯红 #f00', `(() => {const b=[...document.querySelectorAll('#actionMenu .action-menu-item')].find(x=>x.textContent.includes('移除项目'));const c=getComputedStyle(b).color.replace('rgb(','').replace(')','').split(',').map(Number);return c[0]>150&&c[1]<c[0]&&c[2]<c[0]})()`],
  ]);
  await pressKey('Escape', 'Escape', 27);
  await sleep(200);
  await shotOf('#projects', 'UX-MENU-05b-menu-escaped', 'P24 侧栏：Escape 关闭菜单并把焦点还给三点', ['pi-GUI'], [
    ['Escape 关闭了菜单', `!document.querySelector('#actionMenu')`],
    ['焦点回到三点 trigger', `document.activeElement===document.querySelector('#projects .project .pj-row-menu-trigger')`],
  ]);
  await evalJs(`document.querySelector('#projects .project .pj-row-menu-trigger')?.click()`);
  await sleep(240);
  await evalJs(`(() => { const b=[...document.querySelectorAll('#actionMenu .action-menu-item')].find(x=>x.textContent.includes('移除项目')); if (b) b.click(); })()`);
  await sleep(240);
  await shotOf('#confirmCard', 'UX-MENU-02b-remove-confirm', 'P24 侧栏：移除项目前确认 —— 只移除列表，不删磁盘文件', ['移除这个项目', '不会删除磁盘上的项目文件'], [
    ['确认文案说清不动磁盘文件', `document.querySelector('#confirmCard').textContent.includes('不会删除磁盘上的项目文件')`],
    ['按钮是「取消 / 移除项目」', `[...document.querySelectorAll('#confirmCard .modal-actions .btn')].map(b=>b.textContent).join(',')==='取消,移除项目'`],
  ]);
  await evalJs(`[...document.querySelectorAll('#confirmCard .modal-actions .btn')].find(b=>b.textContent==='取消')?.click()`);
  await sleep(200);

  /* 会话行：同样只有一个三点，行高不变。 */
  const sessionHoverPoint = await evalJs(`(() => {
    const row=[...document.querySelectorAll('#projects .pj-sess')].find(x=>!x.classList.contains('on'));
    if (!row) return null;
    row.scrollIntoView({block:'nearest'});
    const r=row.getBoundingClientRect();
    return { x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2) };
  })()`);
  if (sessionHoverPoint) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...sessionHoverPoint });
    await sleep(280);
  }
  await shotOf('#projects', 'UX-MENU-03-session-row-hover', 'P24 侧栏：会话行 hover —— 行尾三点显形，标题与时间仍在同一行', [], [
    ['三点在 hover 时可见', `getComputedStyle(document.querySelector('#projects .pj-sess:not(.on) .pj-sess-menu-trigger')).opacity==='1'`],
    ['会话行没有变高（与项目行差 ≤ 2px）', `(() => {const p=document.querySelector('#projects .project').offsetHeight;const s=document.querySelector('#projects .pj-sess').offsetHeight;return Math.abs(p-s)<=2})()`],
    ['行尾只有这一个动作入口（旧的 ✎ / ⤓ / ✕ 都不在）', `(() => {const row=document.querySelector('#projects .pj-sess:not(.on)');return row.querySelectorAll('.pj-sess-menu-trigger').length===1&&!row.querySelector('.pj-sess-act:not(.pj-sess-acts)')})()`],
    ['三点是 SVG，不是字符图标', `Boolean(document.querySelector('#projects .pj-sess-menu-trigger svg'))`],
  ]);

  await evalJs(`(() => {
    const row=[...document.querySelectorAll('#projects .pj-sess')].find(x=>!x.classList.contains('on'));
    row?.querySelector('.pj-sess-menu-trigger')?.click();
  })()`);
  await sleep(300);
  await shotOf('#actionMenu', 'UX-MENU-04-session-menu-open', 'P24 侧栏：统一会话菜单，历史会话的重命名禁用并解释', ['重命名', '归档', '删除会话', '请先打开'], [
    ['菜单挂在 body 上且在视口内', `(() => {const m=document.querySelector('#actionMenu');const r=m.getBoundingClientRect();return m.parentElement===document.body&&r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1})()`],
    ['三个 menuitem + 一条分隔线', `document.querySelectorAll('#actionMenu [role="menuitem"]').length===3&&Boolean(document.querySelector('#actionMenu [role="separator"]'))`],
    ['删除项是 danger 层级', `(() => {const b=[...document.querySelectorAll('#actionMenu .action-menu-item')].find(x=>x.textContent.includes('删除会话'));return b.classList.contains('danger')})()`],
    ['危险项静止时没有红底', `(() => {const b=[...document.querySelectorAll('#actionMenu .action-menu-item')].find(x=>x.textContent.includes('删除会话'));return getComputedStyle(b).backgroundColor==='rgba(0, 0, 0, 0)'})()`],
    ['菜单属于被点的那一行（当前会话那行没有被标记展开）', `document.querySelector('#projects .pj-sess.on .pj-sess-menu-trigger').getAttribute('aria-expanded')==='false'`],
  ]);
  await pressKey('Escape', 'Escape', 27);
  await sleep(200);

  const sessionMenuViewport = await evalJs(`({width:innerWidth,height:innerHeight})`);
  for (const [width,height] of [[700,600],[900,700],[1200,800],[1536,900]]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await sleep(300); // 等真实 resize 事件完成；菜单本来就应在 resize 时关闭。
    for (const current of [true,false]) {
      await evalJs(`document.querySelector('#projects .pj-sess${current ? '.on' : ':not(.on):not(.pending)'} .pj-sess-menu-trigger').click()`);
      await shotOf('#actionMenu',`UX-SESSION-MENU-${current ? 'current' : 'history'}-${width}x${height}`,'统一菜单：当前与历史会话的受限操作有可见说明',['重命名','归档','删除会话',current ? '先切换' : '请先打开'],[
        ['菜单与说明在视口内，不产生横向溢出',`(() => { const m=document.querySelector('#actionMenu'),r=m.getBoundingClientRect();return r.left>=8&&r.right<=innerWidth-8&&r.top>=8&&r.bottom<=innerHeight-8&&m.scrollWidth<=m.clientWidth&&document.documentElement.scrollWidth<=innerWidth; })()`],
        ['统一三个动作及正确禁用状态',`(() => {const b=[...document.querySelectorAll('#actionMenu [role="menuitem"]')];return b.length===3 && b.map(n=>n.disabled).join(',')==='${current ? 'false,true,true' : 'true,false,false'}';})()`],
        ['禁用原因可访问、文字没有截断',`(() => { const n=document.querySelector('.action-menu-note');return !!n && n.scrollWidth<=n.clientWidth && [...document.querySelectorAll('#actionMenu button:disabled')].every(b=>b.getAttribute('aria-disabled')==='true' && b.getAttribute('aria-describedby')===n.id); })()`],
      ]);
      await pressKey('Escape','Escape',27);
    }
  }
  await send('Emulation.setDeviceMetricsOverride',{...sessionMenuViewport,deviceScaleFactor:1,mobile:false});

  /* UX-CAP-01：Native MCP 的详情 —— 只留适用的字段。 */
  await evalJs(`document.querySelector('#navExtensions').click()`);
  await sleep(520);
  await evalJs(`document.querySelector('#extensionsTabAll')?.click()`);
  await sleep(320);
  await evalJs(`[...document.querySelectorAll('#workSurface .cap-view .ext-item')].find(n=>n.textContent.includes('Native MCP'))?.click()`);
  await sleep(300);
  await shotOf('#workSurface .cap-view .ext-detail', 'UX-CAP-01-native-clean-detail', 'P24 Capability：Native MCP 详情只留适用的字段（不再是一串「不适用」）', ['已加载'], [
    ['详情里没有「不适用」', `!document.querySelector('#workSurface .cap-rows').textContent.includes('不适用')`],
    ['不再有「安装状态」那一行（MCP 不是 npm 包）', `!document.querySelector('#workSurface .cap-rows [data-k="安装状态"]')`],
    ['仍然显示真正适用的字段', `Boolean(document.querySelector('#workSurface .cap-rows [data-k="已加载"]'))`],
    ['没有 npm 安装命令', `document.querySelector('#workSurface .cap-view code')===null`],
    ['没有安装按钮', `document.querySelector('#workSurface .cap-view .cap-install')===null`],
    ['字段行数受控（≤4）', `document.querySelectorAll('#workSurface .cap-rows .ext-row').length<=4`],
    ['诊断行只在真的有错误时才出现', `!document.querySelector('#workSurface .cap-rows [data-k="诊断"]')`],
  ]);

  /* UX-CAP-02：未安装的第三方能力 —— 主按钮「安装」，复制命令作为恢复入口。 */
  await evalJs(`[...document.querySelectorAll('#workSurface .cap-view .ext-item')].find(n=>n.textContent.includes('Subagents'))?.click()`);
  await sleep(300);
  await shotOf('#workSurface .cap-view .ext-detail', 'UX-CAP-02-install-available', 'P24 Capability：未安装的第三方能力 —— 一键安装 + 复制命令', ['pi install npm:pi-subagents'], [
    ['主按钮是「安装」', `document.querySelector('#workSurface .cap-install')?.dataset.installState==='install'`],
    ['安装状态如实说「未安装」（有证据才敢这么说）', `document.querySelector('#workSurface .cap-rows [data-k="安装状态"] .ext-row-v').textContent==='未安装'`],
    ['复制安装命令仍在（高级 / 故障恢复入口）', `[...document.querySelectorAll('#workSurface .cap-view .ext-acts .btn')].some(b=>b.textContent==='复制安装命令')`],
    ['没有自由输入口（不接受任意包名）', `document.querySelector('#workSurface .cap-view input:not([type="search"])')===null`],
    ['按钮不溢出操作区', `(() => {const a=document.querySelector('#workSurface .cap-view .ext-acts');return a.scrollWidth<=a.clientWidth+1})()`],
  ]);

  /* UX-CAP-03：确认 → 安装中… → 按重新发现的结果显示。 */
  await evalJs(`fetch('/api/__capability/install-hold?value=1').then(r=>r.ok)`);
  await evalJs(`document.querySelector('#workSurface .cap-install')?.click()`);
  await sleep(300);
  await shotOf('#confirmCard', 'UX-CAP-03a-install-confirm', 'P24 Capability：安装前确认 —— 命令 / 权限 / 用户级 / 会自动重启 Pi', ['pi install npm:pi-subagents', '用户级'], [
    ['确认框说明了权限边界', `document.querySelector('#confirmCard').textContent.includes('Pi 进程的权限')`],
    ['确认框说明会自动重启 Pi', `document.querySelector('#confirmCard').textContent.includes('自动重新启动 Pi')`],
    ['确认框说明是用户级安装', `document.querySelector('#confirmCard').textContent.includes('安装范围：用户级')`],
    ['按钮是「取消 / 安装」', `[...document.querySelectorAll('#confirmCard .modal-actions .btn')].map(b=>b.textContent).join(',')==='取消,安装'`],
  ]);
  await evalJs(`[...document.querySelectorAll('#confirmCard .modal-actions .btn')].find(b=>b.textContent==='安装')?.click()`);
  await sleep(420);
  await shotOf('#workSurface .cap-setup', 'UX-CAP-03b-install-progress', 'P24 Capability：安装中… —— 按钮禁用、禁止重复提交', ['安装中'], [
    ['按钮进入安装中状态且被禁用', `(() => {const b=document.querySelector('#workSurface .cap-install');return b.dataset.installState==='installing'&&b.disabled===true})()`],
    ['文案是「安装中…」', `document.querySelector('#workSurface .cap-install').textContent==='安装中…'`],
    ['只有一个安装按钮（不能重复提交）', `document.querySelectorAll('#workSurface .cap-install').length===1`],
  ]);
  await evalJs(`fetch('/api/__capability/install-release').then(r=>r.ok)`);
  await evalJs(`fetch('/api/__capability/install-hold?value=0').then(r=>r.ok)`);
  await sleep(700);
  await shotOf('#workSurface .cap-setup', 'UX-CAP-03c-install-unconfirmed', 'P24 Capability：命令跑完但 Registry 还没确认到它 —— 如实显示「尚未确认」，不伪造已加载', ['安装'], [
    ['按钮不再是「安装中…」', `document.querySelector('#workSurface .cap-install')?.textContent!=='安装中…'`],
    ['没有伪造「已确认加载」', `!document.querySelector('#workSurface .cap-rows').textContent.includes('已确认加载')`],
    ['提示说明了「尚未确认到 Extension」', `(() => {const t=document.querySelector('#toasts').textContent;return t.includes('尚未确认到 Extension')||t.includes('安装完成')})()`],
  ]);
  await evalJs(`document.querySelector('#toasts').innerHTML=''`);

  /* ---------- P23：诊断面板（升级安全面） ---------- */
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evalJs(`document.querySelector('#navGlobalMore').click(); document.querySelector('#navDiagnostics').click()`);
  await sleep(500);
  await evalJs(`(() => { const p = document.querySelector('#globalMoreMenu'); if (p) p.hidden = true; })()`);
  await shotOf('#modalCard', '181-diagnostics-upgrade', 'P23：诊断面板 —— 版本核对 / 能力 probe / 兼容矩阵 / Native MCP / Extension 版本 + 复制诊断摘要', ['版本真值', '能力 probe', '兼容矩阵', 'Native MCP', '关键 Extension 版本', '复制诊断摘要'], [
    ['版本核对显示「已核对」与基线', `(() => {const t=document.querySelector('#modalCard').textContent;return t.includes('已核对')&&t.includes('0.99.2')})()`],
    ['probe 三值文案分得开', `(() => {const t=document.querySelector('#modalCard').textContent;return t.includes('支持')&&t.includes('未知')})()`],
    ['probe 带出处（相对路径）', `document.querySelector('#modalCard').textContent.includes('dist/modes/rpc/rpc-types.d.ts')`],
    ['Native MCP 显示状态与计数', `(() => {const t=document.querySelector('#modalCard').textContent;return t.includes('生效中')&&t.includes('server 条目')})()`],
    ['Extension 版本按 name@version 显示', `document.querySelector('#modalCard').textContent.includes('pi-memory@0.4.2')`],
    ['按钮区不溢出（复制诊断摘要在最前）', `(() => {const a=document.querySelector('#modalCard .modal-actions');return a.scrollWidth<=a.clientWidth+1&&[...a.querySelectorAll('button')].every(b=>b.getBoundingClientRect().height>=30)})()`],
    ['内容区自己滚动、底部按钮可见', `(() => {const b=document.querySelector('#modalCard .diag-body'),a=document.querySelector('#modalCard .modal-actions');return b.scrollHeight>b.clientHeight&&a.getBoundingClientRect().bottom<=innerHeight+1})()`],
  ]);
  /* 窄窗口：底部有六个按钮，必须换行而不是横向溢出 */
  await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(420);
  await shotOf('#modalCard', '182-diagnostics-700', 'P23：700px —— 诊断面板按钮换行、内容区滚动、无横向溢出', ['版本真值', '能力 probe'], [
    ['没有横向溢出', `document.documentElement.scrollWidth<=innerWidth+1`],
    ['卡片在视口内', `(() => {const r=document.querySelector('#modalCard').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})()`],
    ['按钮区换行而不是溢出', `(() => {const a=document.querySelector('#modalCard .modal-actions');return a.scrollWidth<=a.clientWidth+1})()`],
  ]);
  await send('Emulation.clearDeviceMetricsOverride');
  await evalJs(`document.querySelector('#modal').hidden = true; document.querySelector('#modalCard').innerHTML = ''`);
  await sleep(200);
  /* ---------- P24：日常使用面（命令面板 / 快捷键帮助 / 草稿恢复 / 状态条）----------
   *
   * ⚠️ 这里**只能走真实用户路径**：浏览器里 `app.js` 是 `<script type="module">`，
   * 模块导出**不在 window 上**（jsdom 那套 `window.openPalette()` 在这里用不了）。
   * 所以下面一律用「真按键 / 真点击 / 真刷新」。 */
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evalJs(`document.querySelector('#navHome').click()`);
  await sleep(260);
  const isMac = await evalJs(`/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)`);
  const mod = isMac ? { metaKey: true } : { ctrlKey: true };
  const pressCombo = (key, extra = {}) => evalJs(`(() => {
    const o = ${JSON.stringify({ ...mod, ...extra })};
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...o }));
    return true;
  })()`);

  await evalJs(`document.querySelector('#input').value = '写了一半的想法'`);
  await pressCombo('k');
  await sleep(320);
  await shotOf('#paletteLayer', '183-command-palette', 'P24：命令面板（默认列表就是常用动作，不含不可执行项）', ['对话', '能力视图（Capabilities）', '诊断'], [
    ['面板在视口内且不裁切', `(() => {const c=document.querySelector('.palette-card').getBoundingClientRect();return c.top>=0&&c.left>=0&&c.right<=innerWidth+1&&c.bottom<=innerHeight+1})()`],
    ['焦点在搜索框里', `document.activeElement === document.querySelector('.palette-input')`],
    ['容器上沿对齐（靠上而不是居中）', `(() => {const c=document.querySelector('.palette-card').getBoundingClientRect();return c.top < innerHeight*0.35})()`],
    ['没有横向溢出', `document.documentElement.scrollWidth<=innerWidth+1`],
    ['列出的是已有动作（没有「停止生成」这类当前不可执行的项）', `![...document.querySelectorAll('.palette-item .palette-title')].some(t=>t.textContent==='停止生成')`],
  ]);

  await evalJs(`(() => { const i=document.querySelector('.palette-input'); i.value='会话'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(260);
  await shotOf('#paletteLayer', '184-palette-search', 'P24：搜索（中文名 / 关键词 / 组名都能命中，会话条目按需出现）', ['搜索会话'], [
    ['搜索收窄了列表', `document.querySelectorAll('.palette-item').length < 30`],
    ['选中项始终只有一个', `document.querySelectorAll('.palette-item.on').length===1`],
  ]);
  await evalJs(`document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  await sleep(220);
  await shotOf('#composerBox', '184b-palette-focus-restored', 'P24：Esc 关面板后焦点回到输入框（不是丢在 body 上）', [], [
    ['焦点回到输入框', `document.activeElement === document.querySelector('#input')`],
    ['草稿没被动过', `document.querySelector('#input').value === '写了一半的想法'`],
  ]);

  /* 快捷键帮助：用**真实快捷键**打开（Ctrl+/），验证「注册表 → 界面」这条链路 */
  await pressCombo('/');
  await sleep(360);
  await shotOf('#modalCard', '185-shortcut-help', 'P24：快捷键帮助（注册表渲染 + 当前平台映射 + 既有输入键位）', ['键盘快捷键', '输入与弹层'], [
    ['键位列不换行且不溢出', `(() => {const k=[...document.querySelectorAll('.kb-keys')];return k.length>0&&k.every(n=>getComputedStyle(n).whiteSpace==='nowrap')})()`],
    ['帮助面板不越过视口', `(() => {const r=document.querySelector('#modalCard').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight+1})()`],
    ['按平台显示修饰键', `document.querySelector('#modalCard').textContent.includes(${JSON.stringify(isMac ? '⌘' : 'Ctrl+')})`],
  ]);
  await evalJs(`document.querySelector('#modalCard .btn.primary').click()`);
  await sleep(200);

  /* 草稿恢复：**真的刷新页面**再回来看输入框 —— 这是 localStorage 唯一有意义的验法 */
  await evalJs(`(() => { const i=document.querySelector('#input'); i.value='刷新之后我还在'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(700); // 过防抖窗口，验的是「真的落盘」而不是内存里
  await send('Page.reload');
  await sleep(2800);
  await shotOf('#composerBox', '186-draft-restore', 'P24：未发送草稿在刷新后恢复（只存纯文本，按项目 + 会话隔离）', [], [
    ['输入框里是刷新前那句话', `document.querySelector('#input').value === '刷新之后我还在'`],
    ['localStorage 里只有 v/text/at 三个字段', `(() => {const k=Object.keys(localStorage).find(x=>x.startsWith('pi-gui.draft.'));if(!k)return 'no-key';const o=JSON.parse(localStorage.getItem(k));return JSON.stringify(Object.keys(o).sort())==='["at","text","v"]'})()`],
    ['key 里没有项目路径原文', `(() => {const k=Object.keys(localStorage).find(x=>x.startsWith('pi-gui.draft.'))||'';return !k.includes('pi-GUI')&&!k.includes('/')&&!k.includes('\\\\')})()`],
  ]);
  await evalJs(`(() => { const i=document.querySelector('#input'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(700);
  await shotOf('#composerBox', '186b-draft-cleared', 'P24：清空输入框后本地草稿被删除（不留幽灵草稿）', [], [
    ['localStorage 里已经没有草稿键', `!Object.keys(localStorage).some(x=>x.startsWith('pi-gui.draft.'))`],
  ]);

  /* 连接断开 / 启动失败：状态条 + 可执行下一步 */
  await evalJs(`fetch('/api/__push?what=startup-error').then(r=>r.ok)`);
  await sleep(420);
  await shotOf('#stageNotice', '187-startup-error', 'P24：pi 启动失败 —— 常驻说明 + 后端给的下一步 + 两个已有入口', ['pi 启动失败', 'ENOENT', '重启 Pi', '打开诊断'], [
    ['不遮住输入区', `(() => {const n=document.querySelector('#stageNotice').getBoundingClientRect(),c=document.querySelector('#composerBox').getBoundingClientRect();return n.bottom<=c.top+1})()`],
    ['按钮整块换行、不溢出', `(() => {const a=document.querySelector('#stageNotice .notice-actions');return a.scrollWidth<=a.clientWidth+1})()`],
    ['没有横向溢出', `document.documentElement.scrollWidth<=innerWidth+1`],
  ]);
  /* 连接断开：先回到在线状态，再断开 —— 否则会沿用上一条更具体的启动错误
   * （那是刻意的：更具体的错误不该被一句「已退出」盖掉）。 */
  await evalJs(`fetch('/api/__push?what=online').then(r=>r.ok)`);
  await sleep(320);
  await evalJs(`fetch('/api/__push?what=offline').then(r=>r.ok)`);
  await sleep(360);
  await shotOf('#stageNotice', '188-connection-lost', 'P24：pi 已退出 —— 同一套文案与同一个下一步', ['pi 已退出', '重启 Pi'], [
    ['说明里说清当前无法继续发消息', `document.querySelector('#stageNotice').textContent.includes('重启')`],
  ]);
  await evalJs(`fetch('/api/__push?what=online').then(r=>r.ok)`);
  await sleep(360);
  await shotOf('#stageNotice', '189-connection-restored', 'P24：恢复连接后状态条自动收起（不留残影）', [], [
    ['状态条已隐藏', `document.querySelector('#stageNotice').hidden===true`],
  ]);

  /* 700×600 与 701×602：窄 + 低高度 + DPI 取整（701 是 700 的相邻像素） */
  for (const [w, h, label] of [[700, 600, '190-daily-700x600'], [701, 602, '191-daily-701x602']]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await pressCombo('k');
    await sleep(360);
    await shotOf('#paletteLayer', label, `P24：${w}×${h} 命令面板 —— 不裁切、不横向溢出`, [], [
      ['面板完整在视口内', `(() => {const c=document.querySelector('.palette-card').getBoundingClientRect();return c.top>=0&&c.left>=0&&c.right<=innerWidth+1&&c.bottom<=innerHeight+1})()`],
      ['面板有实际高度', `document.querySelector('.palette-card').getBoundingClientRect().height>60`],
      ['没有横向溢出', `document.documentElement.scrollWidth<=innerWidth+1`],
      ['列表可滚动（内容多时不撑破）', `(() => {const l=document.querySelector('.palette-list');return l.scrollHeight<=l.clientHeight+1||l.clientHeight>40})()`],
    ]);
    await evalJs(`document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
    await sleep(180);
  }

  /* 低高度对话：Composer 不能盖住最后一条消息 */
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 560, deviceScaleFactor: 1, mobile: false });
  await sleep(420);
  await shotOf('#chatView', '192-composer-not-covering', 'P24：低高度（900×560）输入区不遮消息、不横向溢出', [], [
    /* 消息区的**元素**本来就延伸到输入区下面（底部留白靠 padding 顶住），
     * 所以判据不能拿元素矩形比，要比「最后一条消息的底边」与输入区的顶边。 */
    ['最后一条消息不被输入区遮住', `(() => {
      const msgs=[...document.querySelectorAll('#stream .msg')];
      const last=msgs[msgs.length-1];
      if(!last) return true;
      const c=document.querySelector('#composerBox').getBoundingClientRect();
      return last.getBoundingClientRect().bottom <= c.top + 1;
    })()`],
    ['消息区留白 ≥ 输入区高度（机制上就不该遮）', `(() => {
      /* 留白做在 .thread 的 padding-bottom 上（--composer-reserved-height + 余量），
       * 不是 #stream 上 —— 判据要跟着机制走，不要跟着猜。 */
      const t=document.querySelector('#stream .thread');
      if(!t) return true;
      const pad=parseFloat(getComputedStyle(t).paddingBottom)||0;
      return pad >= document.querySelector('#composerBox').getBoundingClientRect().height - 2;
    })()`],
    ['页面无横向溢出', `document.documentElement.scrollWidth<=innerWidth+1`],
    ['消息区自己滚动', `(() => {const s=document.querySelector('#stream');return s.scrollHeight<=s.clientHeight+1||s.clientHeight>0})()`],
  ]);
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);
  /* ================= UX：本轮真实使用里发现的四个问题 =================
   *
   *   1. 深色界面里出现 Windows / Chromium 默认的**亮白滚动条**（命令面板、
   *      诊断、扩展与能力两栏都漏了）。
   *   2. 项目行是「名字 + 绝对路径」两行的大卡片，比会话行高出一大截；
   *      当前项目下面的会话列表不能折叠。
   *   3. Conversation Minimap 把 marker 按内容比例铺满整个纵向区域，
   *      又散又远、很难连续点。
   *   4. 点 marker 时 element.scrollIntoView() 连带把 .stage 滚了 46px，
   *      .stage-head 被推出视口 —— 看起来就是「标题栏消失 / 顶部断开」。
   *
   * 这里的判据一律是**结构事实**（computed style / aria / 矩形关系 / 计数），
   * 不是像素值。滚动条宽度用 computed style 量：Chrome 里
   * getComputedStyle(el, '::-webkit-scrollbar') 会回样式表里写的宽度，
   * 这样即使跑在 --hide-scrollbars 下也验得到（截图里看不到滚动条本身）。
   * https://chromium.googlesource.com/chromium/src/+/main/docs/ */
  const uxCheck = (name, ok, detail) => {
    console.log('      ' + name + ' [' + (ok ? '✓' : '✗ ' + (detail || '')) + ']');
    if (!ok) shotFailures.push(name + (detail ? ': ' + detail : ''));
  };
  const barStyleOk = (sel) => `(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return 'no-element';
    const bar = getComputedStyle(e, '::-webkit-scrollbar');
    const th = getComputedStyle(e, '::-webkit-scrollbar-thumb');
    const tr = getComputedStyle(e, '::-webkit-scrollbar-track');
    if (bar.getPropertyValue('width') !== '10px') return '宽度不是 10px：' + bar.getPropertyValue('width');
    if (bar.getPropertyValue('height') !== '10px') return '横向不是 10px：' + bar.getPropertyValue('height');
    if (!/rgb\\(44, 44, 44\\)/.test(th.getPropertyValue('background-color'))) return '滑块不是深灰：' + th.getPropertyValue('background-color');
    if (!/rgba\\(0, 0, 0, 0\\)/.test(tr.getPropertyValue('background-color'))) return '轨道不是透明：' + tr.getPropertyValue('background-color');
    return true;
  })()`;
  const scrollableOk = (sel) => `(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return 'no-element';
    return e.scrollHeight > e.clientHeight + 1 || '内容没超出一屏，这条判据测不到滚动条';
  })()`;
  const noOverflowX = `document.documentElement.scrollWidth <= innerWidth + 1`;

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evalJs(`document.querySelector('#navHome').click()`);
  await sleep(300);

  /* --- UX-01 命令面板：滚动条 --- */
  await pressCombo('k');
  await sleep(360);
  await shotOf('.palette-card', 'UX-01-scrollbars-palette', 'UX-01：命令面板 —— 深色细滚动条（不是 Windows 默认亮白条）', ['命令'], [
    ['面板完整在视口内', `(() => {const c=document.querySelector('.palette-card').getBoundingClientRect();return c.top>=0&&c.left>=0&&c.right<=innerWidth+1&&c.bottom<=innerHeight+1})()`],
    ['列表可滚动（否则测不到滚动条）', scrollableOk('.palette-list')],
    ['滚动条全局规则命中：细 10px / 深灰 / 轨道透明', barStyleOk('.palette-list')],
    ['没有整体横向溢出', noOverflowX],
  ]);
  await evalJs(`document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  await sleep(240);

  /* --- UX-02 诊断：滚动条 --- */
  await evalJs(`document.querySelector('#navGlobalMore').click()`);
  await sleep(220);
  await evalJs(`document.querySelector('#navDiagnostics').click()`);
  await sleep(760);
  await shotOf('.diag-body', 'UX-02-scrollbars-diagnostics', 'UX-02：诊断弹层 —— 中间滚动区同样是深色细滚动条', ['版本'], [
    ['诊断内容区可滚动', scrollableOk('.diag-body')],
    ['滚动条全局规则命中', barStyleOk('.diag-body')],
    ['弹层卡片本身也没有亮白条', barStyleOk('.modal-card')],
    ['弹层完整在视口内', `(() => {const c=document.querySelector('.modal-card').getBoundingClientRect();return c.top>=0&&c.left>=0&&c.right<=innerWidth+1&&c.bottom<=innerHeight+1})()`],
    ['没有整体横向溢出', noOverflowX],
  ]);
  await evalJs(`document.querySelector('#modalClose') ? document.querySelector('#modalClose').click() : document.querySelector('#modal').setAttribute('hidden','')`);
  await sleep(260);
  /* 兜底：不管关没关掉，都把它藏起来，别影响后面的取景 */
  await evalJs(`document.querySelector('#modal').hidden = true`);
  await sleep(160);

  /* --- UX-03 侧栏：项目行紧凑 + 会话展开 --- */
  await evalJs(`document.querySelector('#navHome').click()`);
  await sleep(200);
  await evalJs(`window.dispatchEvent(new Event('resize'))`);
  await sleep(320);
  await shotOf('#projects', 'UX-03-sidebar-project-expanded', 'UX-03：项目行与会话行是同一套紧凑层级（路径不再占第二行），当前项目默认展开', ['pi-GUI'], [
    ['项目行与会话行高度接近（差 ≤ 2px）', `(() => {const p=document.querySelector('.project.active'),s=document.querySelector('.pj-sess');if(!p||!s)return 'no-row';return Math.abs(p.offsetHeight-s.offsetHeight)<=2 || ('project='+p.offsetHeight+' session='+s.offsetHeight)})()`],
    ['项目行是紧凑的一行（≤ 36px，不再是两行卡片）', `(() => {const p=document.querySelector('.project.active');return (p&&p.offsetHeight<=36)||('h='+(p&&p.offsetHeight))})()`],
    ['没有常驻的绝对路径副标题', `document.querySelectorAll('#projects .pj-path').length === 0`],
    ['完整路径仍在 title 上（hover 看得到）', `(() => {const p=document.querySelector('.project.active');return Boolean(p&&p.title&&/[\\\\/]/.test(p.title))})()`],
    ['折叠箭头 aria-expanded=true 且 aria-controls 指向会话块', `(() => {const c=document.querySelector('.project.active .pj-chev'),b=document.querySelector('.pj-sessions');return Boolean(c&&b&&b.id&&c.getAttribute('aria-expanded')==='true'&&c.getAttribute('aria-controls')===b.id)})()`],
    ['会话块紧跟当前项目行（结构没被箭头破坏）', `(() => {const p=document.querySelector('.project.active');return Boolean(p&&p.nextElementSibling&&p.nextElementSibling.classList.contains('pj-sessions'))})()`],
    ['会话列表默认可见且有会话', `(() => {const b=document.querySelector('.pj-sessions');return Boolean(b&&b.hidden===false&&b.querySelectorAll('.pj-sess').length>0)})()`],
  ]);

  /* --- UX-04 侧栏：折叠 --- */
  await evalJs(`document.querySelector('.project.active .pj-chev').click()`);
  await sleep(320);
  await shotOf('.project.active', 'UX-04-sidebar-project-collapsed', 'UX-04：点箭头折叠该项目的会话（只剩项目行，且箭头语义同步）', ['pi-GUI'], [
    ['会话块已隐藏', `document.querySelector('.pj-sessions').hidden === true`],
    ['aria-expanded=false 且标签变成「展开」', `(() => {const c=document.querySelector('.project.active .pj-chev');return Boolean(c&&c.getAttribute('aria-expanded')==='false'&&/^展开/.test(c.getAttribute('aria-label')||''))})()`],
    ['会话行仍在 DOM 里（只是隐藏，搜索/改名还要用）', `document.querySelectorAll('.pj-sessions .pj-sess').length > 0`],
    ['项目行本身没被折掉（折的只是会话）', `(() => {const p=document.querySelector('.project.active');return Boolean(p&&p.isConnected&&p.offsetHeight>=28)})()`],
    ['折叠没有让侧栏整体位移（项目行顶部不变）', `(() => {const p=document.querySelector('.project.active').getBoundingClientRect();return p.top>0&&p.top<innerHeight})()`],
  ]);
  /* 展开回去，别把折叠态留给后面的场景 */
  await evalJs(`document.querySelector('.project.active .pj-chev').click()`);
  await sleep(240);

  /* --- UX-05 会话导航：紧凑聚簇 --- */
  await evalJs(`fetch('/api/__conversation?what=long-thread&turns=24').then(r=>r.ok)`);
  await sleep(900);
  await shotOf('#convoNav', 'UX-05-conversation-nav-compact', 'UX-05：24 次提问的 marker 聚成一组紧凑短线（不再按内容比例铺满整屏）', [], [
    ['marker 数 = 24（一次提问一条）', `document.querySelectorAll('#convoNav .cn-marker').length === 24`],
    ['整组跨度 < 导航容器高度的 1/3（紧凑）', `(() => {
      const m=[...document.querySelectorAll('#convoNav .cn-marker')];
      if(m.length<2) return 'marker 不够';
      const t=m.map((x)=>x.getBoundingClientRect().top);
      const nav=document.querySelector('#convoNav');
      const span=Math.max(...t)-Math.min(...t);
      return span < nav.clientHeight/3 || ('span='+Math.round(span)+' navH='+nav.clientHeight);
    })()`],
    ['整组纵向居中（不贴顶、不贴底）', `(() => {
      const nav=document.querySelector('#convoNav');
      const base=nav.getBoundingClientRect().top;
      const t=[...document.querySelectorAll('#convoNav .cn-marker')].map((x)=>x.getBoundingClientRect().top-base);
      const mid=(Math.min(...t)+Math.max(...t))/2;
      return Math.abs(mid-nav.clientHeight/2)<=4 || ('mid='+mid.toFixed(1)+' navH='+nav.clientHeight);
    })()`],
    ['相邻 marker 等距（一组规则的短线）', `(() => {
      const t=[...document.querySelectorAll('#convoNav .cn-marker')].map((x)=>x.getBoundingClientRect().top);
      const g=t.slice(1).map((v,i)=>v-t[i]);
      return (g[0]>0.5 && g.every((x)=>Math.abs(x-g[0])<0.6)) || ('gaps='+g.slice(0,4).map((x)=>x.toFixed(1)).join(','));
    })()`],
    ['当前提问只有一条，且更亮更长', `(() => {
      const on=[...document.querySelectorAll('#convoNav .cn-marker.on')];
      if(on.length!==1) return '高亮条数='+on.length;
      const other=document.querySelector('#convoNav .cn-marker:not(.on)');
      return (on[0].getBoundingClientRect().width > other.getBoundingClientRect().width) || '当前条没有更长';
    })()`],
    ['导航列自己没有冒出独立滚动条', `(() => {const n=document.querySelector('#convoNav');return n.offsetWidth-n.clientWidth<=2})()`],
    ['hover 摘要仍然在（可读的截断 prompt）', `(() => {const t=document.querySelector('#convoNav .cn-tip');return Boolean(t&&t.textContent.trim().length>0)})()`],
    ['不遮输入区 / 不遮顶栏（判的是 marker 簇，不是整列容器）', `(() => {
      /* .convo-nav 这一列本身贯穿整个会话区（输入区浮在它上面），
       * 所以判据必须落在**簇**的实际矩形上，不是容器的。 */
      const rs=[...document.querySelectorAll('#convoNav .cn-marker')].map((x)=>x.getBoundingClientRect());
      if(!rs.length) return 'no-marker';
      const top=Math.min(...rs.map((r)=>r.top));
      const bottom=Math.max(...rs.map((r)=>r.bottom));
      const head=document.querySelector('.stage-head').getBoundingClientRect();
      const box=document.querySelector('#composerBox').getBoundingClientRect();
      return (top>=head.bottom-1 && bottom<=box.top+1) ||
        ('cluster='+Math.round(top)+'..'+Math.round(bottom)+' head='+Math.round(head.bottom)+' composer='+Math.round(box.top));
    })()`],
    ['没有整体横向溢出', noOverflowX],
  ]);

  /* --- UX-06 点击 marker：只让 #stream 滚，外层布局一个像素都不动 --- */
  const outerRects = `(() => {
    const r=(s)=>{const e=document.querySelector(s);const b=e.getBoundingClientRect();return [b.top,b.bottom,b.height,b.left]};
    const stream=document.querySelector('#stream');
    return JSON.stringify({
      stageHead: r('.stage-head'), chatView: r('#chatView'), composer: r('#chatComposer'),
      stageScroll: document.querySelector('#workspace').scrollTop,
      docScroll: document.scrollingElement.scrollTop,
      streamScroll: stream.scrollTop,
      streamTop: stream.getBoundingClientRect().top,
    });
  })()`;
  const jumpAndCheck = async (idx, name) => {
    await evalJs(`document.querySelector('#stream').scrollTop = 0`);
    await sleep(260);
    const before = JSON.parse(await evalJs(outerRects));
    await evalJs(`document.querySelectorAll('#convoNav .cn-marker')[${idx}].click()`);
    await sleep(1000);
    const after = JSON.parse(await evalJs(outerRects));
    const near = (x, y) => Math.abs(x - y) <= 0.5;
    uxCheck(name + '：.stage-head 位置不变', near(before.stageHead[0], after.stageHead[0]) && near(before.stageHead[2], after.stageHead[2]),
      JSON.stringify({ before: before.stageHead, after: after.stageHead }));
    uxCheck(name + '：#chatView 的 top/bottom 不变', near(before.chatView[0], after.chatView[0]) && near(before.chatView[1], after.chatView[1]),
      JSON.stringify({ before: before.chatView, after: after.chatView }));
    uxCheck(name + '：输入区位置不变', near(before.composer[0], after.composer[0]) && near(before.composer[2], after.composer[2]),
      JSON.stringify({ before: before.composer, after: after.composer }));
    uxCheck(name + '：只有 #stream.scrollTop 变了', after.streamScroll !== before.streamScroll,
      JSON.stringify({ before: before.streamScroll, after: after.streamScroll }));
    uxCheck(name + '：.stage 没有被滚动（恒为 0）', before.stageScroll === 0 && after.stageScroll === 0,
      JSON.stringify({ before: before.stageScroll, after: after.stageScroll }));
    uxCheck(name + '：文档没有被滚动', before.docScroll === 0 && after.docScroll === 0,
      JSON.stringify({ before: before.docScroll, after: after.docScroll }));
    const landed = await evalJs(`(() => {
      const stream=document.querySelector('#stream');
      const users=[...document.querySelectorAll('#stream .msg.user')];
      const t=users[${idx}];
      if(!t) return 'no-target';
      const r=t.getBoundingClientRect();
      const s=stream.getBoundingClientRect();
      /* 目标已经到底了就必须 clamp —— 最后一条提问后面还跟着一大段回答，
       * 那种情况下它不可能停在离顶部 20px 的地方。这不是失败，是 clamp 生效。 */
      const atMax = Math.abs(stream.scrollTop - (stream.scrollHeight - stream.clientHeight)) <= 2;
      return JSON.stringify({ delta: Math.round(r.top-s.top), visible: r.top >= s.top - 2 && r.top < s.bottom - 8, atMax });
    })()`);
    const info = JSON.parse(landed === 'no-target' ? '{"delta":-1,"visible":false,"atMax":false}' : landed);
    uxCheck(name + '：目标消息落在滚动区里、且留了顶部余量（或已到底 clamp）',
      info.visible && info.delta >= 0 && (info.delta <= 40 || info.atMax),
      JSON.stringify(info));
    return after;
  };
  await jumpAndCheck(0, 'UX-06 第一条');
  await jumpAndCheck(11, 'UX-06 中间一条');
  await jumpAndCheck(23, 'UX-06 最后一条');
  await jumpAndCheck(8, 'UX-06 很长回答之后的那一条');
  /* 历史恢复（重新灌一次会话历史）之后，跳转仍然只动 #stream */
  await evalJs(`fetch('/api/__conversation?what=long-thread&turns=24').then(r=>r.ok)`);
  await sleep(900);
  await jumpAndCheck(5, 'UX-06 历史恢复之后');
  await shotOf('#chatView', 'UX-06-conversation-nav-after-jump', 'UX-06：点 marker 之后 —— 顶栏 / 正文 / 输入区都没动，只有正文自己滚了', [], [
    ['顶栏仍在窗口顶部', `Math.abs(document.querySelector('.stage-head').getBoundingClientRect().top)<=0.5`],
    ['#chatView 顶边紧贴顶栏底边', `(() => {
      const h=document.querySelector('.stage-head').getBoundingClientRect();
      const c=document.querySelector('#chatView').getBoundingClientRect();
      return Math.abs(c.top-h.bottom)<=0.5;
    })()`],
    ['.stage 没有被脚本滚动', `document.querySelector('#workspace').scrollTop === 0`],
    ['文档没有被滚动', `document.scrollingElement.scrollTop === 0`],
    ['正文确实滚到了第 6 条附近', `(() => {
      const s=document.querySelector('#stream');
      const u=document.querySelectorAll('#stream .msg.user')[5];
      const r=u.getBoundingClientRect(), sr=s.getBoundingClientRect();
      return r.top>=sr.top-2 && r.top<sr.bottom-8;
    })()`],
  ]);

  /* --- UX-07 标题栏：一条连续、稳定的顶栏 --- */
  const headStable = `(() => {
    const h=document.querySelector('.stage-head');
    const cs=getComputedStyle(h);
    const r=h.getBoundingClientRect();
    const token=getComputedStyle(document.documentElement).getPropertyValue('--titlebar').trim();
    if (Math.abs(r.top)>0.5) return '顶栏不在窗口顶部：top='+r.top;
    if (Math.abs(r.height-46)>0.5) return '高度不是 46：'+r.height;
    if (r.right < innerWidth-1) return '顶栏没有铺到右侧原生按钮区：right='+r.right+' innerWidth='+innerWidth;
    if (!/rgb\\(13, 13, 13\\)/.test(cs.backgroundColor)) return '背景色不对：'+cs.backgroundColor;
    if (token.toLowerCase() !== '#0d0d0d') return '--titlebar 不是 electron overlay 的颜色：'+token;
    if (cs.borderBottomWidth !== '1px') return '底部分隔线不见了：'+cs.borderBottomWidth;
    if (getComputedStyle(document.querySelector('#workspace')).overflowY !== 'clip') return '.stage 不是 overflow:clip';
    return true;
  })()`;
  const dragRegions = `(() => {
    const h=document.querySelector('.stage-head');
    const rail=document.querySelector('.rail-head');
    const btn=document.querySelector('.stage-head button');
    const out=[];
    if (getComputedStyle(h).getPropertyValue('-webkit-app-region')!=='drag') out.push('.stage-head 拖拽区丢了');
    if (getComputedStyle(rail).getPropertyValue('-webkit-app-region')!=='drag') out.push('.rail-head 拖拽区丢了');
    if (getComputedStyle(btn).getPropertyValue('-webkit-app-region')!=='no-drag') out.push('顶栏按钮没有 no-drag');
    return out.length ? out.join('；') : true;
  })()`;

  await shotOf('.stage-head', 'UX-07-titlebar-chat', 'UX-07：Chat 顶栏 —— 明确背景、和原生按钮同色、贴着窗口顶部的一条', [], [
    ['顶栏几何与颜色稳定（top 0 / 46px / 同色 / 有分隔线 / .stage 不可被滚）', headStable],
    ['拖拽区与 no-drag 没被破坏（窗口能拖、按钮能点）', dragRegions],
    ['没有整体横向或纵向滚动', `document.documentElement.scrollWidth<=innerWidth+1 && document.documentElement.scrollHeight<=innerHeight+1`],
    ['正文没有被顶栏盖住（首条可见内容在顶栏下方）', `(() => {
      const h=document.querySelector('.stage-head').getBoundingClientRect();
      const c=document.querySelector('#chatView').getBoundingClientRect();
      return c.top >= h.bottom - 1;
    })()`],
  ]);

  /* --- UX-08 视图切换（Chat / 任务 / 文件变更 / 扩展）之后顶栏必须还在 --- */
  for (const [id, view] of [['navPlanner', '任务'], ['navChanges', '文件变更'], ['navExtensions', '扩展'], ['navHome', '对话']]) {
    await evalJs(`document.querySelector('#${id}').click()`);
    await sleep(560);
    const ok = await evalJs(headStable);
    uxCheck('UX-08 切到「' + view + '」后顶栏仍然稳定', ok === true, typeof ok === 'string' ? ok : '');
  }
  /* 长对话滚动 + 开关弹层之后再确认一次 */
  await evalJs(`fetch('/api/__conversation?what=long-thread&turns=24').then(r=>r.ok)`);
  await sleep(800);
  await evalJs(`document.querySelector('#stream').scrollTop = 400`);
  await sleep(360);
  const afterScroll = await evalJs(headStable);
  uxCheck('UX-08 长对话滚动后顶栏仍然稳定', afterScroll === true, typeof afterScroll === 'string' ? afterScroll : '');
  await pressCombo('k');
  await sleep(300);
  await evalJs(`document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  await sleep(260);
  const afterPalette = await evalJs(headStable);
  uxCheck('UX-08 开关命令面板后顶栏仍然稳定', afterPalette === true, typeof afterPalette === 'string' ? afterPalette : '');
  await shotOf('#chatView', 'UX-08-titlebar-after-view-switch', 'UX-08：Chat / 任务 / 文件变更 / 扩展来回切换、滚动、开关面板之后，顶栏位置与颜色不变', [], [
    ['顶栏几何与颜色稳定', headStable],
    ['正文顶边仍紧贴顶栏', `(() => {
      const h=document.querySelector('.stage-head').getBoundingClientRect();
      const c=document.querySelector('#chatView').getBoundingClientRect();
      return Math.abs(c.top-h.bottom)<=0.5;
    })()`],
    ['.stage 没有被任何一次切换滚动过', `document.querySelector('#workspace').scrollTop === 0`],
  ]);

  /* --- UX-09 关键布局在 700 / 900 / 1200 / 1536 下抽查 ---
   * 窄窗口下 .convo-nav 会被隐藏（既有策略），所以 marker 那条只在 ≥900 时判。 */
  for (const [w, h] of [[700, 600], [900, 700], [1200, 800], [1536, 900]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(420);
    const ok = await evalJs(headStable);
    uxCheck('UX-09 ' + w + '×' + h + '：顶栏稳定', ok === true, typeof ok === 'string' ? ok : '');
    const projectRow = await evalJs(`(() => {
      const p=document.querySelector('.project.active');
      const s=document.querySelector('.pj-sess');
      if(!p) return 'no-project';
      if(!s) return 'project='+p.offsetHeight+'（没有会话行可比）';
      return Math.abs(p.offsetHeight-s.offsetHeight)<=2 || ('project='+p.offsetHeight+' session='+s.offsetHeight);
    })()`);
    uxCheck('UX-09 ' + w + '×' + h + '：项目行与会话行高度接近', projectRow === true, typeof projectRow === 'string' ? projectRow : '');
    const navHiddenOrCompact = await evalJs(`(() => {
      const nav=document.querySelector('#convoNav');
      if (getComputedStyle(nav).display === 'none') return true;   // 窄窗口按既有策略隐藏
      const t=[...nav.querySelectorAll('.cn-marker')].map((x)=>x.getBoundingClientRect().top);
      if (t.length < 2) return 'marker 不够';
      return Math.max(...t)-Math.min(...t) < nav.clientHeight/3 || 'span 过大';
    })()`);
    uxCheck('UX-09 ' + w + '×' + h + '：导航聚簇或按策略隐藏', navHiddenOrCompact === true, typeof navHiddenOrCompact === 'string' ? navHiddenOrCompact : '');
    const noOverflow = await evalJs(noOverflowX);
    uxCheck('UX-09 ' + w + '×' + h + '：没有整体横向溢出', noOverflow === true, 'scrollWidth 超出');
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 600, deviceScaleFactor: 1, mobile: false });
  await sleep(360);
  await shotOf('.stage-head', 'UX-09-titlebar-narrow-700x600', 'UX-09：700×600 关键布局抽查 —— 顶栏仍是同一色、同一条', [], [
    ['顶栏几何与颜色稳定', headStable],
    ['窄窗口下导航按既有策略隐藏', `(() => {
      const nav=document.querySelector('#convoNav');
      return getComputedStyle(nav).display==='none' || nav.clientHeight>0;
    })()`],
    ['没有整体横向溢出', noOverflowX],
  ]);
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(240);

  /* Composer 小修：四档视口，实际 Provider 交互和真实 RPC 回读。 */
  const modelLayout = `(() => {
    const p=document.querySelector('.pop'), r=p.getBoundingClientRect();
    const c=document.querySelector('#composerBox').getBoundingClientRect();
    const before=window.__composerBefore;
    return !p.hidden && r.top>=8 && r.left>=8 && r.right<=innerWidth-8 && r.bottom<=innerHeight-8
      && ['x','y','width','height'].every(k=>Math.abs(c[k]-before[k])<0.5)
      && document.documentElement.scrollHeight<=innerHeight && document.documentElement.scrollWidth<=innerWidth
      && p.scrollWidth<=p.clientWidth;
  })()`;
  for (const [width,height] of [[700,600],[900,700],[1200,800],[1536,900]]) {
    await closePop();
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await evalJs(`fetch('/api/__composer-models',{method:'POST'}).then(r=>r.json())`);
    await sleep(350);
    await evalJs(`window.__composerBefore=document.querySelector('#composerBox').getBoundingClientRect().toJSON(); document.querySelector('#btnModel').click();`);
    // 运行期状态会保留：每档先手动收起上一档已展开的非当前组。
    await evalJs(`document.querySelectorAll('.pop-model-group').forEach(g=>{if(g.dataset.provider!=='deepseek' && g.firstElementChild.getAttribute('aria-expanded')==='true')g.firstElementChild.click()})`);
    const suffix=width+'x'+height;
    await shotOf('.pop','UX-MODEL-01-provider-collapsed-'+suffix,'Provider 默认折叠，当前组可见',['deepseek','openrouter','100'],[
      ['弹层有界、Composer 不位移、页面不滚动',modelLayout],
      ['当前展开、其它收起且百模型不占高度',`(() => { const g=[...document.querySelectorAll('.pop-model-group')]; return g.length===3 && g.every(x=>x.firstElementChild.getAttribute('aria-expanded')===String(x.dataset.provider==='deepseek')) && g.filter(x=>x.dataset.provider!=='deepseek').every(x=>x.lastElementChild.getBoundingClientRect().height===0 && x.getBoundingClientRect().height===32); })()`],
      ['标题层级、数量与安全 controls',`[...document.querySelectorAll('.pop-provider')].every(h=>h.tagName==='BUTTON' && h.offsetHeight===32 && document.getElementById(h.getAttribute('aria-controls'))===h.nextElementSibling && getComputedStyle(h.querySelector('.pop-provider-count')).fontFamily.includes('mono'))`],
    ]);
    await evalJs(`document.querySelector('[data-provider="zhipu"] .pop-provider').focus()`);
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await shotOf('.pop','UX-MODEL-02-provider-expanded-'+suffix,'小 Provider 整行展开，无需滚过百模型',['GLM'],[
      ['布局稳定',modelLayout],
      ['展开状态、箭头朝下，GLM 可见',`(() => { const g=document.querySelector('[data-provider="zhipu"]');const r=g.querySelector('.pop-item').getBoundingClientRect();const p=document.querySelector('.pop').getBoundingClientRect();return g.firstElementChild.getAttribute('aria-expanded')==='true' && g.querySelector('.pop-provider-chev').textContent==='⌄' && r.top>=p.top && r.bottom<=p.bottom; })()`],
    ]);
    await evalJs(`document.querySelector('[data-provider="openrouter"] .pop-provider').focus()`);
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await shotOf('.pop','UX-MODEL-03-many-models-'+suffix,'100 模型展开，仅 picker 内滚动、长 id 截断',[],[
      ['布局稳定',modelLayout],
      ['picker 可以内部滚动',`(() => {const p=document.querySelector('.pop');p.scrollTop=120;const ok=p.scrollTop>0 && p.scrollHeight>p.clientHeight && getComputedStyle(p).overflowY==='auto';p.scrollTop=0;return ok})()`],
      ['长 id 使用 ellipsis，没有横向溢出',`(() => { const e=document.querySelector('[data-provider="openrouter"] .pi-text'); return getComputedStyle(e).textOverflow==='ellipsis' && e.scrollWidth>e.clientWidth; })()`],
    ]);
    await evalJs(`document.querySelector('[data-provider="zhipu"] .pop-item').click()`);
    await sleep(350);
    await evalJs(`document.querySelector('#btnModel').click()`);
    await shotOf('.pop','UX-MODEL-04-current-provider-after-switch-'+suffix,'Pi 确认跨 Provider 切换后，当前组展开且对勾唯一',['GLM'],[
      ['布局稳定',modelLayout],
      ['当前模型可见，旧展开状态保留',`(() => { const cur=document.querySelector('.pop [aria-current="true"]');const g=cur.closest('.pop-model-group');const r=cur.getBoundingClientRect(),p=document.querySelector('.pop').getBoundingClientRect();return document.querySelectorAll('.pop [aria-current="true"]').length===1 && g.dataset.provider==='zhipu' && !g.lastElementChild.hidden && r.top>=p.top && r.bottom<=p.bottom && document.querySelector('[data-provider="deepseek"] .pop-provider').getAttribute('aria-expanded')==='true'; })()`],
    ]);
    await closePop();
    await evalJs(`document.querySelector('#btnThink').click()`);
    await shotOf('.pop','UX-MODEL-05-thinking-after-model-switch-'+suffix,'模型切换后 medium 生效，候选四档没有 max',['medium'],[
      ['布局稳定',modelLayout],
      ['Pi 实际 thinkingLevel 与 candidates',`document.querySelector('#thinkText').textContent==='思考 medium' && [...document.querySelectorAll('.pop .pi-text')].map(e=>e.textContent).join(',')==='off,low,medium,high' && !document.querySelector('.pop').classList.contains('model-mode')`],
    ]);
  }
  await closePop();
  await send('Emulation.clearDeviceMetricsOverride');

  await evalJs(`document.querySelector('#projectSidebar').classList.remove('search-open')`);
  for (const [width,height] of [[700,600],[900,700],[1200,800],[1536,900]]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await sleep(300);
    const point = await evalJs(`(() => {
      const row=document.querySelector('.project:not(.active)');
      row.scrollIntoView({block:'nearest'});
      const box=row.nextElementSibling,c=row.querySelector('.pj-chev');
      window.__sidebarBefore={title:document.querySelector('#title').textContent,composer:document.querySelector('#composerBox').getBoundingClientRect().toJSON()};
      if(!box.hidden)return null;
      const r=c.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};
    })()`);
    if(point) {
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
      await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    }
    await sleep(350);
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:width-12,y:height-12});
    await shotOf('#projects','UX-SIDEBAR-project-sessions-'+width+'x'+height,'项目标题、圆点会话和独立展开；预览不切聊天',['简单问候','你好'],[
      ['预览展开且没有当前会话标记',`(() => {const row=document.querySelector('.project:not(.active)'),box=row.nextElementSibling;return row.querySelector('.pj-chev').getAttribute('aria-expanded')==='true'&&!box.hidden&&box.querySelectorAll('.pj-sess').length===3&&!box.querySelector('[aria-current]')})()`],
      ['展开不切换聊天，Composer 不移动',`document.querySelector('#title').textContent===window.__sidebarBefore.title && ['x','y','width','height'].every(k=>Math.abs(document.querySelector('#composerBox').getBoundingClientRect()[k]-window.__sidebarBefore.composer[k])<.5)`],
      ['圆点、项目标题和单行文本无水平溢出',`[...document.querySelectorAll('.pj-sess')].every(r=>r.querySelector('.pj-sess-dot')&&r.scrollWidth<=r.clientWidth) && getComputedStyle(document.querySelector('.project .pj-icon')).display==='none' && getComputedStyle(document.querySelector('.pj-sess-time')).display==='none' && document.documentElement.scrollWidth<=innerWidth`],
    ]);
  }
  await send('Emulation.clearDeviceMetricsOverride');

  await authShots();
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
