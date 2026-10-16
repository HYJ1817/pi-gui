/* UI-2C 视觉层自检：真实 Chrome 渲染（CDP）驱动，Offline 静态 HTTP 夹具供给。
 *
 * 为什么单独一个套件：UI-2C 只动 public/styles.css 的样式层，但 jsdom 不做
 * 布局也不套用外部样式表 —— 阅读宽度、气泡圆角、分组 hairline、动画名这些
 * 只有真实浏览器里 getComputedStyle / getBoundingClientRect 才能成形。
 * 骨架照抄 cdp-shot.cjs（无头 Chrome + 远程调试 + WebSocket），差异只在：
 *  - 自己拉起 tests/visual-harness.cjs 子进程（HARNESS_PORT=0 随机端口），
 *    不与 dev-server(:7788) / cdp-shot(:9223) / 其他并行分支的端口撞车；
 *  - 断言按「claim」收口，失败时消息带实际值，方便把红和根因对上。
 *
 * 当前定位：这是独立可运行的开发期套件（node tests/ui2-visual.cjs），
 * 还没挂进 package.json 的 test 脚本 —— 三个 UI-2 分支都在平行工作，
 * package.json 由合并方统一接（并行期间谁都改它会互相踩）。
 *
 * 用法：
 *   node tests/ui2-visual.cjs              # 跑完即收口，exit code=fail 数
 *   node tests/ui2-visual.cjs --keep       # 保留 Chrome / harness 进程手测
 *   UI2C_CHROME=... UI2C_CDP_PORT=9226     # 可覆盖 Chrome 路径与调试端口 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.UI2C_CHROME || process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = Number(process.env.UI2C_CDP_PORT || 9226);
const OUT = path.join(__dirname, '..', 'docs', 'claude-ui-redesign', 'ui-2-c-evidence', 'cdp');
const KEEP = process.argv.includes('--keep');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let evalJs = null; /* 页面求值函数，main() 里接上 */
const KEYFRAME_FADE = 'ui2-fade-in';
const KEYFRAME_RISE = 'ui2-rise-in';

const claims = [];
let passed = 0, failed = 0;
async function expect(label, expr) {
  const got = await evalJs(expr).catch((e) => 'EVAL_ERROR: ' + String(e && e.message).slice(0, 200));
  const ok = got === true;
  if (ok) passed++; else failed++;
  claims.push({ label, ok, got });
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '' : '  —— 实际值: ' + JSON.stringify(got).slice(0, 240)));
  return ok;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  /* ---- 1. Offline HTTP 夹具：随机端口，进程结束时收掉 ---- */
  const harness = spawn(process.execPath, [path.join(__dirname, 'visual-harness.cjs')], {
    env: { ...process.env, HARNESS_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const url = await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error('夹具启动超时')), 15000);
    harness.stdout.on('data', (c) => {
      buf += String(c);
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(t); res(`http://127.0.0.1:${m[1]}/`); }
    });
    harness.on('exit', (code) => { clearTimeout(t); rej(new Error('夹具提前退出 code=' + code)); });
  });
  console.log('夹具: ' + url);
  try {
    /* ---- 2. 无头 Chrome + DevTools 协议（headless=new 下窗口参数即视口） ---- */
    const chrome = spawn(
      CHROME,
      [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
        '--disable-sync', '--hide-scrollbars', `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${path.join(os.tmpdir(), 'ui2c-cdp-profile')}`,
        '--window-size=1440,900', 'about:blank',
      ],
      { stdio: 'ignore' }
    );
    chrome.on('error', (e) => { console.error('Chrome 启动失败: ' + e.message); process.exitCode = 1; });
    let targets = null;
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      try {
        const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
        targets = await r.json();
        if (targets.some((t) => t.type === 'page')) break;
      } catch { /* 还没起来 */ }
    }
    const page = targets && targets.find((t) => t.type === 'page');
    if (!page) throw new Error('拿不到 DevTools page target');

    let send = null;
    let closeWs = () => {};
    await new Promise((res, rej) => {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      ws.onopen = res;
      ws.onerror = rej;
      const pending = new Map();
      let idc = 0;
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      };
      send = (method, params = {}) => new Promise((r2) => {
        const n = ++idc;
        pending.set(n, r2);
        ws.send(JSON.stringify({ id: n, method, params }));
      });
      closeWs = () => { try { ws.close(); } catch {} };
    });
    evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 240));
      return r.result?.result?.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url });
    for (let i = 0; i < 50; i++) {
      await sleep(300);
      if (await evalJs(`!!document.querySelector('#btnModel') && !!document.querySelector('.thread')`).catch(() => false)) break;
    }
    await sleep(1200);
    await suite(send);
    closeWs();
    if (!KEEP) { try { chrome.kill(); } catch {} }
    else console.log('(--keep) Chrome 保持: ' + url);
  } finally {
    if (!KEEP) try { harness.kill(); } catch {}
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ passed, failed, claims, cdpPort: CDP_PORT, out: OUT }, null, 2));
  console.log(`\nUI-2C 视觉自检: ${passed}/${passed + failed} 通过 —— 报告: ` + path.join('docs', 'claude-ui-redesign', 'ui-2-c-evidence', 'cdp', 'report.json'));
  if (failed) process.exitCode = 1;
}

async function suite(send) {
  const shot = async (n, clipSel) => {
    let params = { format: 'png' };
    if (clipSel) {
      /* 元素可能滚出视口：clip 坐标是视口坐标，先居中再取 rect，否则截到空黑 */
      await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(clipSel)});if(!e)throw new Error('missing '+${JSON.stringify(clipSel)});e.scrollIntoView({block:'center'});return 'ok'})()`);
      await sleep(260);
      const b = await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(clipSel)});if(!e)throw new Error('missing '+${JSON.stringify(clipSel)});const r=e.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,width:r.width,height:r.height,scale:1})})()`);
      params = { format: 'png', clip: JSON.parse(b), captureBeyondViewport: false };
    }
    const r = await send('Page.captureScreenshot', params);
    const p = path.join(OUT, n + '.png');
    fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    console.log('  截图: ' + path.basename(p));
  };

  /* ---- 3. 灌对话夹具：与 cdp-shot 走同一条 /api/__conversation 注入通道，
        并给它生成的节点打标记 id，让断言能定位到场景目标 ---- */
  await evalJs(`fetch('/api/__conversation?what=fixture').then(r => r.ok)`);
  await sleep(700);
  await evalJs(`(() => {
    const mark = (sel, phrase, id) => {
      const node = [...document.querySelectorAll(sel)].find(el => el.textContent.includes(phrase));
      if (node) node.id = id;
    };
    mark('.msg.user', '好，继续。', 'u2c-short');
    mark('.msg.user', '请保留完整路径', 'u2c-long');
    mark('.msg.assistant', '当前结论', 'u2c-assistant');
    mark('.msg.assistant', '下面是长代码块', 'u2c-code');
  })()`);
  const found = await evalJs(`['u2c-short','u2c-long','u2c-assistant','u2c-code'].filter(x => !document.getElementById(x)).length`);
  if (found > 0) throw new Error('夹具未生成标记节点（缺 ' + found + ' 个）—— visual-harness 的 fixture 场景变了，先对齐浇法再跑');

  /* ---- C1 · 阅读轴 与 排版（1440 默认窗，三列布局） ---- */
  await shot('c1-thread-layout');
  await expect('C1 · 阅读轴变量解析为 768px',
    `getComputedStyle(document.documentElement).getPropertyValue('--ui-prose-width').trim() === '768px'`);
  await expect('C1 · 输入框宽=正文轴（920/888 的 32px 历史差取消）',
    `(() => { const c = document.querySelector('.composer-box').getBoundingClientRect();
      const col = Math.min(768, innerWidth);
      return Math.abs(c.width - col) <= 1; })()`);
  await expect('C1 · 正文字级=UI-1 prose 档（14px）且行高放宽到 1.75',
    `(() => { const s = getComputedStyle(document.querySelector('.msg.assistant .msg-body'));
      return s.fontSize === '14px' && parseFloat(s.lineHeight) >= 14 * 1.74; })()`);
  await expect('C1 · 用户气泡 18px 圆角 + 端点内距 ≥16px（圆角不吃字）',
    `(() => { const s = getComputedStyle(document.querySelector('#u2c-short .msg-body'));
      return ['borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius']
        .every(k => s[k] === '18px') && parseFloat(s.paddingLeft) >= 16; })()`);
  await expect('C1 · 短气泡按内容收缩且贴正文右缘',
    `(() => { const b = document.querySelector('#u2c-short .msg-body').getBoundingClientRect();
      const t = document.querySelector('.thread').getBoundingClientRect(); const s = getComputedStyle(document.querySelector('.thread'));
      return b.width > 0 && b.width < 220 && Math.abs(b.right - (t.right - parseFloat(s.paddingRight))) <= 2; })()`);
  await expect('C1 · 长气泡不超过阅读列 76%',
    `(() => { const b = document.querySelector('#u2c-long .msg-body').getBoundingClientRect();
      const t = document.querySelector('.thread').getBoundingClientRect(); const s = getComputedStyle(document.querySelector('.thread'));
      return b.width <= (t.width - parseFloat(s.paddingLeft) * 2) * .76 + 2; })()`);
  await expect('C1 · 视口无横向溢出',
    `document.documentElement.scrollWidth <= innerWidth + 1`);
  await expect('C1 · 代码块 prt 圆角 8px + 1 hairline 框', `(() => {
    const s = getComputedStyle(document.querySelector('.msg-body pre.code'));
    return s.borderTopLeftRadius === '8px' && s.borderTopWidth === '1px'; })()`);
  await expect('C5 · 落场动画挂着（消息新进场的一次性 3px 上浮）',
    `(() => { const m = document.querySelector('.thread > .msg');
      return getComputedStyle(m).animationName === ${JSON.stringify(KEYFRAME_RISE)}; })()`);

  /* ---- C2 · thinking 展开 与 工具组 ---- */
  await evalJs(`document.querySelector('#u2c-assistant .think-head').click()`);
  await sleep(280);
  await expect('C2 · thinking 展开可见',
    `(() => { const b = document.querySelector('#u2c-assistant .think-body');
      return !b.hidden && b.getBoundingClientRect().height > 0; })()`);
  await expect('C5 · 展开淡入（display:none→block 重播 animation，JS 零改动）',
    `(() => { const s = getComputedStyle(document.querySelector('#u2c-assistant .think-body'));
      return s.animationName === ${JSON.stringify(KEYFRAME_FADE)}; })()`);
  await shot('c2-think-expanded', '#u2c-assistant .think');

  await evalJs(`fetch('/api/__conversation?what=tool-running').then(r => r.ok)`);
  await sleep(320);
  await shot('c2-tool-running', '.tl-group');
  await expect('C5 · 运行态呼吸保留（状态指示属必要动效）',
    `(() => { const svg = document.querySelector('.tl-item[data-status=running] .tl-dot svg');
      return svg && getComputedStyle(svg).animationName === 'tl-breathe'; })()`);
  await evalJs(`fetch('/api/__conversation?what=tool-success').then(r => r.ok)`);
  await sleep(240);
  await evalJs(`fetch('/api/__conversation?what=tool-failed').then(r => r.ok)`);
  await sleep(240);
  await shot('c2-tool-group', '.tl-group');
  await expect('C2 · 连续调用收进一个 hairline 卡片（8px 圆角）',
    `(() => { const g = document.querySelector('.tl-group'); const s = getComputedStyle(g);
      return s.borderTopLeftRadius === '8px' && s.borderTopWidth === '1px'; })()`);
  await expect('C2 · 行间用 1px 分隔线（替代左竖线列）',
    `(() => { const it = document.querySelectorAll('.tl-group .tl-list > .tl-item');
      return it.length >= 2 && getComputedStyle(it[1]).borderTopWidth === '1px'; })()`);
  await expect('C2 · 行最小高度保持 30px 紧凑体量',
    `(() => { const it = document.querySelector('.tl-group .tl-item');
      return getComputedStyle(it).minHeight === '30px'; })()`);
  const expanded = await evalJs(`(() => { const h = document.querySelector('.tl-group .tl-item.has-more .tl-head');
    if (!h) return 'no-item'; h.click(); return 'ok'; })()`);
  if (expanded === 'ok') {
    await sleep(280);
    await shot('c2-tl-more-expanded', '.tl-group');
    await expect('C2 · 工具详情展开态有内容高度',
      `(() => { const m = document.querySelector('.tl-more:not([hidden])');
        return m && m.getBoundingClientRect().height > 0; })()`);
    await expect('C5 · 工具详情展开走同一拍淡入',
      `(() => { const m = document.querySelector('.tl-more:not([hidden])');
        return m && getComputedStyle(m).animationName === ${JSON.stringify(KEYFRAME_FADE)}; })()`);
    await evalJs(`document.querySelector('.tl-item.has-more .tl-head').click()`);
    await sleep(160);
  } else {
    console.log('  (跳过) fixture 里没有 has-more 工具行 —— Resolved-verify 注释:该断言依赖 fixture,跳过不计入分母');
  }

  /* ---- 预留类探针：测试侧临时 DOM（从不落入产品代码），
        验证给 UI-2A/B 预备的 .ui2-* 类名是不是真的有样式 ---- */
  await evalJs(`(() => {
    const probe = document.createElement('div');
    probe.id = 'u2c-probes';
    probe.style.cssText = 'position:fixed;top:8px;left:400px;right:8px;display:flex;flex-direction:column;gap:8px;background:var(--main);border:1px solid var(--line);border-radius:8px;padding:10px;z-index:99';
    probe.innerHTML = [
      '<div class="runtime-conversation" style="width:100%">' +
        '<div class="rtc-output">RUNTIME_PROBE</div>' +
      '</div>',
      '<button class="ui2-tool-summary" aria-expanded="false"><svg class="ui2-chev" viewBox="0 0 24 24"></svg>SUMMARY_PROBE</button>',
      '<div class="ui2-msg-meta">META_PROBE</div>',
      '<div class="ui2-runtime-status" data-state="running">STATUS_PROBE</div>',
      '<div class="ui2-runtime-meta">RT_META_PROBE</div>',
    ].join('');
    document.body.appendChild(probe);
    return 'ok';
  })()`);
  await expect('预留 · .ui2-tool-summary 12px 次级色 + 120ms 过渡',
    `(() => { const s = getComputedStyle(document.querySelector('#u2c-probes .ui2-tool-summary'));
      return s.fontSize === '12px' && s.color !== getComputedStyle(document.querySelector('.msg.assistant .msg-body')).color &&
        s.transitionDuration.split(',').some(d => Math.abs(parseFloat(d) - 0.12) < 0.02); })()`);
  await evalJs(`document.querySelector('#u2c-probes .ui2-tool-summary').setAttribute('aria-expanded','true')`);
  await expect('预留 · .ui2-chev 展开态旋转（与 .think-head 同构）',
    `getComputedStyle(document.querySelector('#u2c-probes .ui2-chev')).transform !== 'none'`);
  await expect('预留 · .ui2-msg-meta 11.5px 弱化条',
    `(() => { const s = getComputedStyle(document.querySelector('#u2c-probes .ui2-msg-meta'));
      return s.fontSize === '11.5px' && s.color === 'rgb(166, 163, 155)'; })()`);
  await expect('预留 · .ui2-runtime-status[data-state=running] = running 语义色',
    `(() => { return getComputedStyle(document.querySelector('#u2c-probes .ui2-runtime-status')).color === 'rgb(34, 211, 238)'; })()`);
  await expect('预留 · .ui2-runtime-meta 弱化小字',
    `(() => { const s = getComputedStyle(document.querySelector('#u2c-probes .ui2-runtime-meta'));
      return s.fontSize === '11.5px'; })()`);
  await expect('C3 · runtime 转录跟随正文字级（14px / 行高 ≥1.7）',
    `(() => { const s = getComputedStyle(document.querySelector('#u2c-probes .rtc-output'));
      return s.fontSize === '14px' && parseFloat(s.lineHeight) > 21; })()`);
  await expect('C3 · runtime 会话跟随 768 阅读轴',
    `(() => { const r = document.querySelector('#u2c-probes .runtime-conversation').getBoundingClientRect();
      return Math.abs(r.width - Math.min(768, innerWidth)) <= 2; })()`);
  await shot('c3-reserved-probes');
  await evalJs(`document.querySelector('#u2c-probes').remove()`);

  /* ---- C6 · A/B 真实 DOM 适配：按 tool-view.js / messages.js / message-meta.js
         与 runtime-conversation.js 实际生成的类名/属性灌真实结构，验样式 ---- */
  await evalJs(`(() => {
    const probe = document.createElement('div');
    probe.id = 'u2c-ab';
    probe.style.cssText = 'position:fixed;top:8px;left:400px;right:8px;display:flex;flex-direction:column;gap:8px;background:var(--main);border:1px solid var(--line);border-radius:8px;padding:10px;z-index:99';
    probe.innerHTML = [
      '<section class="tl-group">',
        '<button type="button" class="tl-group-head ui2-tool-summary" id="u2c-sum" aria-expanded="true" aria-controls="u2c-l" aria-describedby="u2c-st">操作 3 项</button>',
        '<span class="ui2-tool-state" id="u2c-st" role="status">运行中 1 · 成功 1 · 失败 1</span>',
        '<div class="tl-list" id="u2c-l">',
          '<div class="tl-item" data-status="running"><span class="tl-dot"></span></div>',
          '<div class="tl-item" data-status="success"><span class="tl-dot"></span></div>',
          '<div class="tl-item" data-status="error"><span class="tl-dot"></span></div>',
        '</div>',
      '</section>',
      '<div class="msg assistant"><div class="msg-body">',
        '<div class="think" data-state="error"><button type="button" class="think-head">',
          '<span>思考过程 · 12 字</span><span class="ui2-think-status"> · 发生错误</span>',
        '</button><div class="think-body">思考内容</div></div>',
        '<footer class="ui2-msg-meta" aria-label="本条助手消息用量">',
          '<span class="ui2-msg-meta-item" data-kind="input">输入 1,234 Token</span>',
          ' · <span class="ui2-msg-meta-item" data-kind="output">输出 56 Token</span>',
        '</footer>',
      '</div></div>',
      '<div class="runtime-conversation">',
        '<details class="ui2-runtime-thinking" id="u2c-think" open>',
          '<summary class="ui2-runtime-thinking-head">思考过程 · 12 字</summary>',
          '<pre class="ui2-runtime-thinking-body" id="u2c-think-body">' + 'X'.repeat(400) + '</pre>',
        '</details>',
        '<p class="ui2-runtime-usage">本轮 · 输入 12 · 输出 3</p>',
        '<div class="rtc-state ui2-runtime-tools">',
          '<span class="ui2-runtime-tool" data-state="running">read · 运行中</span>',
          '<span class="ui2-runtime-tool" data-state="done">bash · 完成</span>',
          '<span class="ui2-runtime-tool" data-state="error">edit · 失败</span>',
          '<span class="ui2-runtime-tool" data-state="bogus">weird · 怪</span>',
        '</div>',
      '</div>',
    ].join('');
    document.body.appendChild(probe);
    return 'ok';
  })()`);

  /* --- A 侧 --- */
  await expect('A · .ui2-tool-summary 原生 button 重置（无边框、透明底）',
    `(() => { const s = getComputedStyle(document.getElementById('u2c-sum'));
      return s.borderTopWidth === '0px' && (s.backgroundColor === 'rgba(0, 0, 0, 0)' || s.backgroundColor === 'transparent'); })()`);
  await expect('A · .ui2-tool-summary:focus-visible 存在 2px 焦点环规则',
    `(() => { const hits = [];
      for (const ss of document.styleSheets) {
        let rules; try { rules = ss.cssRules; } catch { continue; }
        for (const r of rules) {
          if (r.selectorText && r.selectorText.includes('.ui2-tool-summary:focus-visible'))
            hits.push(r.style.outline || r.cssText);
        }
      }
      return hits.some(x => /(^|\\s)2px/.test(x)); })()`);
  await evalJs(`document.getElementById('u2c-sum').setAttribute('aria-expanded', 'false')`);
  await sleep(200);
  const chevCollapsed = await evalJs(`getComputedStyle(document.getElementById('u2c-sum'), '::before').transform`);
  await evalJs(`document.getElementById('u2c-sum').setAttribute('aria-expanded', 'true')`);
  await sleep(200);
  const chevExpanded = await evalJs(`getComputedStyle(document.getElementById('u2c-sum'), '::before').transform`);
  await expect('A · .ui2-tool-summary 折叠图标随 aria-expanded 旋转',
    `${JSON.stringify(chevCollapsed)} !== 'none' && ${JSON.stringify(chevExpanded)} !== 'none' && ${JSON.stringify(chevCollapsed)} !== ${JSON.stringify(chevExpanded)}`);
  await expect('A · .ui2-tool-state 组状态弱化小字（10.5px / t3）',
    `(() => { const s = getComputedStyle(document.getElementById('u2c-st'));
      return s.fontSize === '10.5px' && s.color === 'rgb(166, 163, 155)'; })()`);
  await expect('A · .ui2-msg-meta-item 等宽数字对齐（tabular-nums）',
    `(() => { const s = getComputedStyle(document.querySelector('#u2c-ab .ui2-msg-meta-item'));
      return s.fontVariantNumeric.includes('tabular'); })()`);
  await expect('A · .think[data-state=error] 状态文字用 err 色',
    `getComputedStyle(document.querySelector('#u2c-ab .ui2-think-status')).color === 'rgb(248, 113, 113)'`);

  /* --- B 侧 --- */
  await expect('B · .ui2-runtime-thinking-body 用 pre-wrap + overflow-wrap:anywhere',
    `(() => { const s = getComputedStyle(document.getElementById('u2c-think-body'));
      return s.whiteSpace === 'pre-wrap' && s.overflowWrap === 'anywhere'; })()`);
  await expect('B · 长思考文本不产生容器横向滚动',
    `(() => { const b = document.getElementById('u2c-think-body');
      return b.scrollWidth <= b.clientWidth + 1; })()`);
  await expect('B · .ui2-runtime-usage 弱化小字（11.5px / t3）',
    `(() => { const s = getComputedStyle(document.querySelector('#u2c-ab .ui2-runtime-usage'));
      return s.fontSize === '11.5px' && s.color === 'rgb(166, 163, 155)'; })()`);
  await expect('B · .ui2-runtime-tools 每项一行（flex 纵排）',
    `getComputedStyle(document.querySelector('#u2c-ab .ui2-runtime-tools')).flexDirection === 'column'`);
  await expect('B · .ui2-runtime-tool[data-state=running] = run 色',
    `(() => { const t = [...document.querySelectorAll('#u2c-ab .ui2-runtime-tool')];
      return getComputedStyle(t.find(e => e.dataset.state === 'running')).color === 'rgb(34, 211, 238)'; })()`);
  await expect('B · .ui2-runtime-tool[data-state=done] = ok 色',
    `(() => { const t = [...document.querySelectorAll('#u2c-ab .ui2-runtime-tool')];
      return getComputedStyle(t.find(e => e.dataset.state === 'done')).color === 'rgb(74, 222, 128)'; })()`);
  await expect('B · .ui2-runtime-tool[data-state=error] = err 色',
    `(() => { const t = [...document.querySelectorAll('#u2c-ab .ui2-runtime-tool')];
      return getComputedStyle(t.find(e => e.dataset.state === 'error')).color === 'rgb(248, 113, 113)'; })()`);
  await expect('B · 未知 data-state 不为任何真实状态着色（回落 t2）',
    `(() => { const t = [...document.querySelectorAll('#u2c-ab .ui2-runtime-tool')];
      return getComputedStyle(t.find(e => e.dataset.state === 'bogus')).color === 'rgb(195, 194, 183)'; })()`);
  if (process.env.UI2C_AB_SHOT !== '0') await shot('c6-ab-dom', '#u2c-ab');
  await evalJs(`document.getElementById('u2c-ab').remove()`);

  /* ---- C4 · 四档宽度 sweep：阅读列、气泡、代码块、无溢出 ---- */
  const colCentered = `(() => {
    const t = document.querySelector('.thread').getBoundingClientRect();
    const s = document.querySelector('#stream').getBoundingClientRect();
    if (t.width <= 0) return 'no-width';
    const centerOK = Math.abs((t.left + t.right) / 2 - (s.left + s.right) / 2) <= 3;
    return centerOK && t.width <= Math.min(840, s.width + 2) + 2;
  })()`;
  for (const width of [700, 900, 1200, 1536]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(340);
    await shot('c4-width-' + width);
    await expect('C4 · ' + width + 'px：视口无横向溢出',
      `document.documentElement.scrollWidth <= innerWidth + 1`);
    await expect('C4 · ' + width + 'px：阅读列居中并收在轴内', colCentered);
    await expect('C4 · ' + width + 'px：长代码块内部滚动不出列',
      `(() => { const c = document.querySelector('.msg-body pre.code');
        return c && c.getBoundingClientRect().right <= innerWidth + 1; })()`);
    await expect('C4 · ' + width + 'px：用户气泡仍在正文列内',
      `(() => { const b = document.querySelector('#u2c-short .msg-body').getBoundingClientRect();
        const t = document.querySelector('.thread').getBoundingClientRect();
        const s = getComputedStyle(document.querySelector('.thread'));
        return b.right <= t.right - parseFloat(s.paddingRight) + 1 && b.left >= t.left + parseFloat(s.paddingLeft) - 1; })()`);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);

  /* ---- C5 · prefers-reduced-motion：装饰动效关、必要动效留 ---- */
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(200);
  await expect('C5 · reduced-motion：落场动画关闭',
    `getComputedStyle(document.querySelector('.thread > .msg')).animationName === 'none'`);
  await evalJs(`(() => { const h = document.querySelector('#u2c-assistant .think-head'); if (h && h.getAttribute('aria-expanded') === 'false') h.click(); })()`);
  await sleep(200);
  await expect('C5 · reduced-motion：展开淡入关闭（内容仍可直接显示）',
    `(() => { const b = document.querySelector('#u2c-assistant .think-body');
      return !b.hidden && getComputedStyle(b).animationName === 'none'; })()`);
  await evalJs(`(() => { const h = document.querySelector('#u2c-assistant .think-head'); if (h && h.getAttribute('aria-expanded') === 'true') h.click(); })()`);
  await send('Emulation.setEmulatedMedia', { features: [] });
  await sleep(200);
  await expect('C5 · 移除模拟后落场动画恢复',
    `(() => { const m = document.querySelector('.thread > .msg');
      return getComputedStyle(m).animationName === ${JSON.stringify(KEYFRAME_RISE)}; })()`);
  await shot('c5-final');
}

main().catch((e) => {
  console.error('套件失败: ' + (e && e.stack || e));
  process.exitCode = 1;
});
