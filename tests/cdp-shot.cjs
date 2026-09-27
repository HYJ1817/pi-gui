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
  const shotOf = async (sel, n, label) => {
    const ok = await evalJs(
      `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.scrollIntoView({ block: 'center' }); return true; })()`
    );
    if (!ok) {
      console.log('  跳过（找不到 ' + sel + '）');
      return false;
    }
    await sleep(450);
    await shot(n);
    if (label) console.log('      ' + label);
    return true;
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

  await evalJs('document.querySelector("#navPlanner").click()');
  await sleep(900);
  const pickPlan = async (i) => {
    const ok = await evalJs(
      `(() => { const r = document.querySelectorAll('#modalCard .planner-list .ext-item')[${i}]; if (!r) return false; r.onclick(); return true; })()`
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

    /* 压力项（§五十八）：1000 字说明 / 20 个变更文件 / 超长路径 / 10 次尝试 / 窄窗口 */
    if (await pickPlan(1)) {
      await shotOf('.planner-task[data-task-id="longnote"] .planner-attempt:last-of-type', '20-stress-long-note', '压力：1000 字说明 + 20 个文件 + 超长路径');
      await shotOf('.planner-task[data-task-id="manyattempts"] .planner-attempts', '21-stress-many-attempts', '压力：10 次尝试');
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
      }
      await send('Emulation.clearDeviceMetricsOverride');
      await sleep(400);
    }

    await evalJs('document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles:true}))');
    await sleep(300);
  } else {
    console.log('  跳过：打不开 Planner 面板（夹具服务里没有计划？）');
  }

  console.log('页面异常: ' + (pageErrors.length ? pageErrors.join(' | ') : '无'));

  ws.close();
  chrome.kill();
  console.log('\n完成');
  process.exit(0);
}

main().catch((e) => {
  console.log('失败: ' + e.message);
  process.exit(1);
});
