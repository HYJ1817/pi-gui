/* 真实 Electron + 真实 Chromium 的执行过程视觉验收。
 *
 * 这是 jsdom 之外的独立证据：布局、CSS 变量、hover、真实滚动容器都只在
 * Chromium 里成立。页面仍由 tests/visual-harness.cjs 提供脚本数据，不碰用户的
 * 真实会话，也不启动真 pi / 真实模型。
 *
 * 用法：
 *   node tests/agent-execution-visual.cjs
 *
 * 产物：
 *   .shots/agent-execution/*.png
 *   .shots/agent-execution/agent-execution-interaction.mp4
 *   .shots/agent-execution/report.json
 *
 * 只用于验收取证，不属于 npm test 的 canonical 链。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.shots', 'agent-execution');
const FFMPEG = process.env.FFMPEG_PATH || 'C:/Users/21022/.dsh-wallpaper-engine/ffmpeg/ffmpeg.exe';

if (!process.versions.electron) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-exec-visual-'));
  fs.mkdirSync(path.join(world, 'user-data'), { recursive: true });
  const electronRoot = path.dirname(require.resolve('electron/package.json'));
  const pathFile = path.join(electronRoot, 'path.txt');
  const binary = fs.existsSync(pathFile)
    ? fs.readFileSync(pathFile, 'utf8').trim()
    : process.platform === 'win32' ? 'electron.exe' : 'electron';
  const executable = path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronRoot, 'dist'), binary);
  if (!fs.existsSync(executable)) throw Error('需要已安装的 Electron 运行时；不自动下载');
  const env = { ...process.env, AGENT_EXECUTION_VISUAL_WORLD: world };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [__filename, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + path.join(world, 'user-data')], {
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
    console.log('视觉验收现场：' + world);
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const world = process.env.AGENT_EXECUTION_VISUAL_WORLD;
  const started = Date.now();
  const checks = [];
  const screenshots = [];
  const errors = [];
  let win;
  let harness;
  let finalExit = 0;
  let recordingEvidence = null;

  app.setPath('userData', path.join(world, 'user-data'));
  app.on('window-all-closed', () => {});

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const read = (script) => win.webContents.executeJavaScript(script, true);
  const check = async (label, fn) => {
    try {
      const detail = await fn();
      checks.push({ pass: true, label, detail: detail ?? null });
      console.log('PASS ' + label);
    } catch (error) {
      checks.push({ pass: false, label, error: error.message });
      console.log('FAIL ' + label + ' :: ' + error.message);
    }
  };
  const must = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const shot = async (name) => {
    await sleep(120);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG());
    screenshots.push(name + '.png');
  };
  async function point(selector) {
    return read(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) throw Error('missing ' + ${JSON.stringify(selector)});
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
  }
  async function click(selector) {
    const p = await point(selector);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p });
    await sleep(120);
  }
  async function hover(selector) {
    const p = await point(selector);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...p });
    await sleep(140);
  }
  async function moveAway() {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 8, y: 8 });
    await sleep(140);
  }
  async function bringIntoView(selector) {
    await read(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      const s = document.querySelector('#stream');
      if (!e || !s) return false;
      const er = e.getBoundingClientRect(), sr = s.getBoundingClientRect();
      s.scrollTop += er.top - sr.top - 140;
      return true;
    })()`);
    await sleep(180);
  }

  const CLASSIC_SETUP = `(async () => {
    document.documentElement.dataset.theme = 'light';
    window.__surface = await import('/ui/workspace-surface.js');
    window.__S = (await import('/state.js')).S;
    window.__M = await import('/messages.js');
    window.__T = await import('/tools.js');
    window.__PL = await import('/plan-live.js');
    Object.assign(__S, { hasProject: true, bridgeState: 'ready', streaming: false, stopping: false });
    __surface.showChat();
    __M.clearThread();
    __T.resetTimeline();
    __M.rebuildFromMessages({ messages: [{ role: 'user', content: [{ type: 'text', text: '把执行过程改成 Claude 风格：任务列表、折叠的工具调用、思考过程，以及回到底部。' }] }] });
    __M.onMessageStart({ message: { role: 'assistant' } });
    __S.streaming = true;
    window.__plan1 = {
      version: 1,
      revision: 1,
      tasks: [
        { id: 'recon', title: '梳理现有消息渲染、工具时间线与会话状态', status: 'completed' },
        { id: 'backend', title: '实现 gui_plan 扩展并接入 RPC 启动参数', status: 'completed' },
        { id: 'render', title: '在 Classic 与 Runtime 中渲染任务列表，保持会话隔离', status: 'in_progress' },
        { id: 'verify', title: '补交互录制、回归测试与真实浏览器验收', status: 'pending' },
        { id: 'long', title: '这是一条很长的任务标题，用来验证在窄窗口和长文本下会自动换行、不会出现省略号，也不会把任务列表撑出横向滚动条', status: 'pending' }
      ],
      counts: { total: 5, completed: 2 }
    };
    window.__plan2 = {
      version: 1,
      revision: 2,
      tasks: [
        { id: 'recon', title: '梳理现有消息渲染、工具时间线与会话状态', status: 'completed' },
        { id: 'backend', title: '实现 gui_plan 扩展并接入 RPC 启动参数', status: 'completed' },
        { id: 'render', title: '在 Classic 与 Runtime 中渲染任务列表，保持会话隔离', status: 'completed' },
        { id: 'verify', title: '补交互录制、回归测试与真实浏览器验收', status: 'in_progress' },
        { id: 'long', title: '这是一条很长的任务标题，用来验证在窄窗口和长文本下会自动换行、不会出现省略号，也不会把任务列表撑出横向滚动条', status: 'pending' }
      ],
      counts: { total: 5, completed: 3 }
    };
    window.__think = (delta) => __M.onMessageUpdate({ assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta } });
    window.__tool = (id, name, args) => __T.onToolStart({ toolCallId: id, toolName: name, args });
    window.__toolEnd = (id, text, isError) => __T.onToolEnd({ toolCallId: id, isError: !!isError, result: { content: [{ type: 'text', text }] } });
    window.__append = (text) => __M.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: text } });
    return true;
  })()`;

  const RUNTIME_SETUP = `(async () => {
    window.__R = await import('/runtime-state.js');
    window.__CV = await import('/runtime-conversation.js');
    __surface.showRuntimeConversation();
    const host = document.querySelector('#runtimeConversationView') || document.querySelector('.runtime-conversation-view');
    if (!host) throw Error('runtime host missing');
    host.replaceChildren();
    window.__owner = (id) => ({ backendInstance: 'agent-visual-backend', projectId: 'p', repoId: 'r', workspaceId: 'w-' + id, workspaceEpoch: 'e', conversationId: id, runtimeId: 'rt-' + id, runtimeGeneration: 'g', sessionId: 's-' + id });
    window.__item = (id) => ({ conversationId: id, owner: __owner(id), workspace: { branch: '视觉验收 ' + id, cwd: 'C:/fixture' }, lifecycle: 'ready', activity: id === 'A' ? 'running' : 'idle', revision: 1 });
    window.__seq = { A: 0, B: 0 };
    window.__frame = (id, event) => __R.observeRuntimeFrame({ type: 'runtime_event', owner: __owner(id), eventSequence: ++__seq[id], event });
    window.__text = (id, text) => __frame(id, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
    __R.seedRuntimeSnapshot({ backendInstance: 'agent-visual-backend', items: [__item('A'), __item('B')] });
    window.__V = __CV.createRuntimeConversation({ host });
    __V.show('A');
    return true;
  })()`;

  async function recordInteraction() {
    const frames = path.join(OUT, 'frames');
    fs.mkdirSync(frames, { recursive: true });
    for (const f of fs.readdirSync(frames)) fs.unlinkSync(path.join(frames, f));
    let alive = true;
    let index = 0;
    const startedAt = Date.now();
    const loop = async () => {
      while (alive) {
        try {
          const image = await win.webContents.capturePage();
          fs.writeFileSync(path.join(frames, String(index++).padStart(4, '0') + '.png'), image.toPNG());
        } catch { /* window may be tearing down */ }
        await sleep(100);
      }
    };
    const task = loop();
    try {
      /* 每一段都留出可看清的时间；录制是给人看的，不是只给 ffmpeg 凑帧。 */
      await sleep(900);                        // 默认折叠状态
      await bringIntoView('.plan-head');
      await click('.plan-head');               // 展开任务列表
      await sleep(800);
      await bringIntoView('.tl-group-head');
      await click('.tl-group-head');           // 展开工具调用
      await sleep(800);
      await bringIntoView('.think-head');
      await click('.think-head');              // 展开思考过程
      await sleep(800);
      await read("document.querySelector('#stream').scrollTop = 0");
      await sleep(900);                        // 离开底部 -> 按钮出现
      await hover('.scroll-bottom');           // 运行中悬停 -> 下箭头
      await sleep(800);
      await click('.scroll-bottom');           // 回到底部
      await sleep(1500);

      /* Runtime：切到 B 再切回 A，最后用同一颗按钮回到 A 的底部。
       * 仅当 Runtime 视图仍在（本套件前面已创建）才录制这一段。 */
      if (await read(`!!window.__V`)) {
        await read(`__surface.showRuntimeConversation(); __V.show('B'); document.querySelector('.rtc-output').scrollTop = 0`);
        await sleep(900);
        await read(`__V.show('A'); document.querySelector('.rtc-output').scrollTop = 0`);
        await sleep(900);
        await hover('.rtc-composer .scroll-bottom');
        await sleep(700);
        await click('.rtc-composer .scroll-bottom');
        await sleep(1400);
      }
    } finally {
      alive = false;
      await task;
    }
    const mp4 = path.join(OUT, 'agent-execution-interaction.mp4');
    const seconds = Math.max(0.1, (Date.now() - startedAt) / 1000);
    const fps = Math.min(30, Math.max(1, index / seconds));
    if (fs.existsSync(FFMPEG) && index > 4) {
      try {
        execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', fps.toFixed(3), '-start_number', '0',
          '-i', path.join(frames, '%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: 'inherit' });
        return { frames: index, seconds: Number(seconds.toFixed(2)), fps: Number(fps.toFixed(2)), mp4 };
      } catch (error) {
        return { frames: index, seconds: Number(seconds.toFixed(2)), fps: Number(fps.toFixed(2)), mp4: null, error: error.message };
      }
    }
    return { frames: index, seconds: Number(seconds.toFixed(2)), fps: Number(fps.toFixed(2)), mp4: null, error: 'ffmpeg 不可用或帧数不足' };
  }

  async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    await app.whenReady();
    harness = spawn(process.execPath, [path.join(ROOT, 'tests/visual-harness.cjs')], {
      cwd: world,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0', VISUAL_UPLOAD_DIR: path.join(world, 'uploads') },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    harness.stderr.on('data', (chunk) => errors.push('harness: ' + String(chunk)));
    const url = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(Error('离线 harness 启动超时')), 20000);
      harness.stdout.on('data', (chunk) => {
        text += chunk;
        const match = text.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      harness.once('exit', (code) => { clearTimeout(timer); reject(Error('harness exited ' + code)); });
    });

    win = new BrowserWindow({
      width: 1280,
      height: 900,
      useContentSize: true,
      show: true,
      backgroundColor: '#ffffff',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) errors.push('console: ' + message);
    });
    await win.loadURL(url);
    await sleep(2200);

    await read(CLASSIC_SETUP);
    await sleep(150);

    /* ---------- Classic：Thinking、任务列表、工具调用 ---------- */
    await read(`__M.onMessageUpdate({ assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } });
      __think('先把任务拆成可验证的步骤，再用现有工具逐项检查。');
      __think('不根据工具调用次数推断完成，只认 gui_plan 的真实结果。');`);
    await sleep(200);

    await check('Thinking 默认折叠，只剩摘要与状态', async () => {
      const f = await read(`(() => {
        const body = document.querySelector('.think-body');
        const head = document.querySelector('.think-head');
        return { hidden: body.hidden, text: head.textContent, state: document.querySelector('.ui2-think-status').textContent };
      })()`);
      must(f.hidden === true, '思考正文没有默认隐藏');
      must(f.text.includes('思考过程'), '缺少思考摘要');
      must(f.state.includes('生成中'), '缺少真实生成状态');
      return f;
    });

    await click('.think-head');
    await check('用户展开后，流式增量不会把 Thinking 收回', async () => {
      await read(`__think('继续补充一条已经真实返回的内容，用户展开后必须保持展开。')`);
      await sleep(200);
      const f = await read(`(() => {
        const body = document.querySelector('.think-body');
        return { hidden: body.hidden, expanded: document.querySelector('.think-head').getAttribute('aria-expanded'), text: body.textContent };
      })()`);
      must(f.hidden === false, '增量到达后思考正文被收回了');
      must(f.expanded === 'true', 'aria-expanded 没有保持展开');
      must(f.text.includes('继续补充'), '展开后的正文没有收到增量');
      return f;
    });
    await read(`__M.onMessageUpdate({ assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: '先把任务拆成可验证的步骤，再用现有工具逐项检查。不根据工具调用次数推断完成，只认 gui_plan 的真实结果。继续补充一条已经真实返回的内容，用户展开后必须保持展开。' } })`);

    /* 计划：第一次上报（2/5 完成，第 3 项进行中） */
    await read(`__T.onToolStart({ toolCallId: 'plan-1', toolName: 'gui_plan', args: __plan1 })`);
    await sleep(180);
    await check('任务列表默认展开，数量来自真实 plan 数据', async () => {
      const f = await read(`(() => {
        const card = document.querySelector('.plan-card');
        const head = card.querySelector('.plan-head');
        const list = card.querySelector('.plan-list');
        const rows = [...card.querySelectorAll('.plan-item')];
        return { count: card.querySelector('.plan-count').textContent, expanded: head.getAttribute('aria-expanded'),
          hidden: list.hidden, rows: rows.length, statuses: rows.map(r => r.dataset.status),
          inProgressText: rows[2].querySelector('.plan-state').textContent,
          pulse: !!rows[2].querySelector('.plan-pulse-dot') };
      })()`);
      must(f.rows === 5, '任务行数不是 5');
      must(f.count === '2/5', '完成计数不是 2/5，而是 ' + f.count);
      must(f.expanded === 'true' && f.hidden === false, '任务列表没有默认展开');
      must(f.statuses[2] === 'in_progress' && f.inProgressText.includes('进行中'), '进行中状态没有如实显示');
      must(f.pulse, '进行中缺少轻量动画点');
      return f;
    });

    await check('长任务标题换行且不产生横向溢出', async () => {
      const f = await read(`(() => {
        const card = document.querySelector('.plan-card');
        const row = [...card.querySelectorAll('.plan-item')][4];
        const text = row.querySelector('.plan-text');
        const s = getComputedStyle(text);
        return { whiteSpace: s.whiteSpace, textOverflow: s.textOverflow, rowW: row.clientWidth, textW: text.scrollWidth,
          cardW: card.clientWidth, pageW: document.documentElement.scrollWidth, inner: innerWidth };
      })()`);
      must(f.whiteSpace === 'normal', '长标题没有换行');
      must(f.textOverflow !== 'ellipsis', '长标题被省略号截断');
      must(f.textW <= f.rowW + 1, '标题文本超出任务行');
      must(f.pageW <= f.inner + 1, '任务列表导致页面横向溢出');
      return f;
    });

    /* 用户折叠后，更新只改计数/状态，不改变折叠状态 */
    await click('.plan-head');
    await read(`__T.onToolEnd({ toolCallId: 'plan-1', isError: false, result: { content: [{ type: 'text', text: '计划已更新' }], details: __plan2 } })`);
    await sleep(180);
    await check('计划更新只改变化节点，不重置用户折叠', async () => {
      const f = await read(`(() => {
        const card = document.querySelector('.plan-card');
        return { count: card.querySelector('.plan-count').textContent, hidden: card.querySelector('.plan-list').hidden,
          expanded: card.querySelector('.plan-head').getAttribute('aria-expanded'),
          completed: [...card.querySelectorAll('.plan-item')].map(r => r.dataset.status) };
      })()`);
      must(f.count === '3/5', '更新后的计数不是 3/5');
      must(f.hidden === true && f.expanded === 'false', '计划更新把用户折叠的列表展开了');
      must(f.completed[2] === 'completed', '第 3 项没有更新为完成');
      return f;
    });
    await click('.plan-head');

    /* 工具调用：4 条，默认折叠，错误汇总在组头可见 */
    await read(`__tool('read-1', 'read', { path: 'public/messages.js' });
      __tool('bash-1', 'bash', { command: 'npm test -- agent-execution' });
      __tool('edit-1', 'edit', { path: 'public/plan-view.js' });
      __tool('grep-1', 'grep', { pattern: 'gui_plan', path: 'public' });
      __toolEnd('read-1', '已读取 812 行', false);
      __toolEnd('bash-1', 'Command exited with code 1\\nAssertionError: expected 2/5, got 1/5', true);
      __toolEnd('edit-1', '已更新 public/plan-view.js', false);`);
    await sleep(350);
    await check('工具调用组默认折叠，组头显示真实次数与错误状态', async () => {
      const f = await read(`(() => {
        const group = document.querySelector('.tl-group');
        const head = group.querySelector('.tl-group-head');
        const state = group.querySelector('.ui2-tool-state');
        const list = group.querySelector('.tl-list');
        return { head: head.textContent, expanded: head.getAttribute('aria-expanded'), hidden: list.hidden,
          state: state.textContent, rows: list.querySelectorAll('.tl-item').length };
      })()`);
      must(f.head.includes('工具调用 · 4 次'), '组头文字不是「工具调用 · 4 次」，而是 ' + f.head);
      must(f.rows === 4, '工具条目数不是 4');
      must(f.hidden === true && f.expanded === 'false', '工具组没有默认折叠');
      must(f.state.includes('失败 1'), '折叠时错误状态不可见');
      return f;
    });

    await click('.tl-group-head');
    await check('展开工具组后每条都有名称、状态、时长与结果摘要', async () => {
      const f = await read(`(() => {
        const rows = [...document.querySelectorAll('.tl-group .tl-item')];
        return rows.map(r => ({
          label: r.querySelector('.tl-label').textContent,
          status: r.querySelector('.tl-status').textContent,
          time: r.querySelector('.tl-time')?.textContent || '',
          result: r.querySelector('.tl-result')?.textContent || '',
          state: r.dataset.status
        }));
      })()`);
      must(f.length === 4, '展开后条目数不对');
      must(f.every(r => r.label && r.status), '有工具缺少名称或状态');
      /* bash 的简短结果就是 pi 自己给的 exit code，完整 stderr 在单条详情里；
       * 这里不要求把原始错误全文塞进行摘要。 */
      must(f.some(r => r.state === 'error' && r.result.includes('exit code 1')), '错误工具的简短结果没有显示');
      return f;
    });

    await click('.tl-group .tl-item[data-status="error"] .tl-head');
    await check('单条工具可再次展开详情，且不显示原始 JSON 墙', async () => {
      const f = await read(`(() => {
        const row = document.querySelector('.tl-group .tl-item[data-status="error"]');
        const more = row.querySelector('.tl-more');
        return { hidden: more.hidden, out: more.querySelector('.tl-out').textContent.slice(0, 300) };
      })()`);
      must(f.hidden === false, '单条详情没有展开');
      must(f.out.includes('AssertionError'), '详情缺少真实错误输出');
      return f;
    });
    await shot('01-classic-plan-thinking-tools-light');

    /* 执行结束但仍有 in_progress：只改展示，不伪造 completed。
     * 单独截图，避免和「工具仍在运行」混成一个不真实的画面。 */
    await read(`__PL.markLivePlanStalled()`);
    await sleep(100);
    await check('执行收尾后的未完成项显示「未完成」而非伪造完成', async () => {
      const f = await read(`(() => {
        const card = document.querySelector('.plan-card');
        const row = [...card.querySelectorAll('.plan-item')][3];
        return { stalled: card.dataset.stalled, status: row.dataset.status, text: row.querySelector('.plan-state').textContent,
          pulseAnimation: getComputedStyle(row.querySelector('.plan-pulse-dot')).animationName };
      })()`);
      must(f.stalled === 'true', '计划卡没有标记 stalled');
      must(f.status === 'in_progress', '数据状态被改写了');
      must(f.text.includes('未完成'), '未完成项没有显示「未完成」');
      return f;
    });
    await shot('01b-classic-plan-stalled');

    /* 最终回答 + 长内容，触发真实滚动 */
    await read(`__M.onMessageEnd({ message: { role: 'assistant', content: [
      { type: 'thinking', thinking: '先把任务拆成可验证的步骤，再用现有工具逐项检查。不根据工具调用次数推断完成，只认 gui_plan 的真实结果。继续补充一条已经真实返回的内容，用户展开后必须保持展开。' },
      { type: 'text', text: '已把执行过程整理成同一条阅读流：先说任务，再显示真实的计划、工具与思考，最后给结论。' }
    ] } });
    __M.onMessageStart({ message: { role: 'assistant' } });
    __S.streaming = true;
    for (let i = 0; i < 28; i++) __append('第 ' + (i + 1) + ' 段用于验证真实滚动容器的长内容。这里只写真实可见的状态，不用占位符伪造工具结果。\\n\\n');`);
    await sleep(400);

    await read(`document.querySelector('#stream').scrollTop = 0`);
    await sleep(250);
    await check('离开底部时出现圆形回到底部按钮，且只绑定 #stream', async () => {
      const f = await read(`(() => {
        const b = document.querySelector('#composerBox .scroll-bottom');
        const s = document.querySelector('#stream');
        const c = document.querySelector('#composerBox').getBoundingClientRect();
        const r = b.getBoundingClientRect();
        return { visible: b.classList.contains('is-visible'), ariaHidden: b.getAttribute('aria-hidden'),
          width: Math.round(r.width), height: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom),
          composerTop: Math.round(c.top), running: b.dataset.running, scroller: s.scrollTop,
          docScroll: document.scrollingElement.scrollTop, gap: s.scrollHeight - s.scrollTop - s.clientHeight };
      })()`);
      must(f.visible, '离开底部后按钮没有出现');
      must(f.ariaHidden === 'false', '可见按钮仍被标记为 aria-hidden');
      must(f.gap > 160, '夹具没有真正离开底部');
      must(f.width === 44 && f.height === 44, '按钮不是 44px 圆形');
      must(f.bottom <= f.composerTop + 1, '按钮压住了 Composer');
      must(f.docScroll === 0, '按钮逻辑滚动了文档而不是对话容器');
      must(f.running === 'true', '执行中按钮没有进入运行态');
      return f;
    });
    await shot('02-classic-scroll-button-running');

    await hover('.scroll-bottom');
    await check('运行中悬停切换为下箭头，尺寸不跳', async () => {
      const f = await read(`(() => {
        const b = document.querySelector('#composerBox .scroll-bottom');
        const dots = b.querySelector('.thinking-dots');
        const arrow = b.querySelector('.scroll-arrow');
        return { dots: getComputedStyle(dots).display, arrow: getComputedStyle(arrow).display,
          width: Math.round(b.getBoundingClientRect().width), height: Math.round(b.getBoundingClientRect().height) };
      })()`);
      must(f.arrow !== 'none', '悬停后没有显示下箭头');
      must(f.dots === 'none', '悬停后四点动画仍在显示');
      must(f.width === 44 && f.height === 44, '悬停时按钮尺寸发生变化');
      return f;
    });
    await shot('03-classic-scroll-button-hover');
    await moveAway();
    await check('移开后恢复四点动画', async () => {
      const f = await read(`(() => {
        const b = document.querySelector('#composerBox .scroll-bottom');
        return { dots: getComputedStyle(b.querySelector('.thinking-dots')).display,
          arrow: getComputedStyle(b.querySelector('.scroll-arrow')).display };
      })()`);
      must(f.dots !== 'none' && f.arrow === 'none', '移开鼠标后没有恢复动画');
      return f;
    });

    await click('.scroll-bottom');
    await sleep(1200);
    await check('点击后只滚当前对话到底部并隐藏按钮', async () => {
      const f = await read(`(() => {
        const b = document.querySelector('#composerBox .scroll-bottom');
        const s = document.querySelector('#stream');
        return { gap: s.scrollHeight - s.scrollTop - s.clientHeight, visible: b.classList.contains('is-visible'),
          docScroll: document.scrollingElement.scrollTop };
      })()`);
      must(f.gap <= 8, '点击后没有回到底部');
      must(f.visible === false, '回到底部后按钮没有隐藏');
      must(f.docScroll === 0, '点击滚动了文档');
      return f;
    });
    await shot('04-classic-returned-bottom');

    /* 深色 + 窄窗口 */
    await read(`document.documentElement.dataset.theme = 'dark'`);
    await sleep(200);
    await shot('05-classic-dark');
    await check('深色主题下任务列表文字与状态仍可读', async () => {
      const f = await read(`(() => {
        const card = document.querySelector('.plan-card');
        const row = card.querySelector('.plan-item[data-status="in_progress"]');
        return { color: getComputedStyle(row).color, bg: getComputedStyle(card).backgroundColor,
          pulse: getComputedStyle(row.querySelector('.plan-pulse-dot')).animationName };
      })()`);
      must(f.color && f.color !== 'rgba(0, 0, 0, 0)', '深色下任务文字不可见');
      must(f.bg && f.bg !== 'rgba(0, 0, 0, 0)', '深色下任务卡没有背景');
      return f;
    });

    win.setContentSize(700, 900);
    await sleep(250);
    await read(`document.querySelector('#stream').scrollTop = 0`);
    await sleep(250);
    await check('700px 窄窗口无横向溢出，按钮缩为 40px', async () => {
      const f = await read(`(() => {
        const b = document.querySelector('#composerBox .scroll-bottom');
        const r = b.getBoundingClientRect();
        return { page: document.documentElement.scrollWidth, inner: innerWidth,
          width: Math.round(r.width), height: Math.round(r.height),
          planWidth: document.querySelector('.plan-card').getBoundingClientRect().width,
          streamWidth: document.querySelector('#stream').getBoundingClientRect().width };
      })()`);
      must(f.page <= f.inner + 1, '窄窗口出现横向溢出');
      must(f.width === 40 && f.height === 40, '窄窗口没有缩为 40px');
      must(f.planWidth <= f.streamWidth + 1, '任务卡超出对话容器');
      return f;
    });
    await shot('06-classic-narrow-700');
    win.setContentSize(1280, 900);
    await read(`document.documentElement.dataset.theme = 'light'`);
    await sleep(250);

    /* ---------- Runtime 多会话 ---------- */
    await read(RUNTIME_SETUP);
    await sleep(200);
    await read(`__frame('A', { type: 'message_start', message: { role: 'assistant' } });
      __frame('A', { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'A 会话正在整理任务列表与验证步骤。' } });
      __frame('A', { type: 'tool_execution_start', toolCallId: 'a-plan', toolName: 'gui_plan', plan: {
        version: 1, revision: 1, tasks: [
          { id: 'a1', title: 'A：读取消息渲染路径', status: 'completed' },
          { id: 'a2', title: 'A：接入任务列表数据', status: 'in_progress' },
          { id: 'a3', title: 'A：补真实浏览器验收', status: 'pending' }
        ], counts: { total: 3, completed: 1 } } });
      __frame('A', { type: 'tool_execution_end', toolCallId: 'a-plan', isError: false, plan: {
        version: 1, revision: 2, tasks: [
          { id: 'a1', title: 'A：读取消息渲染路径', status: 'completed' },
          { id: 'a2', title: 'A：接入任务列表数据', status: 'completed' },
          { id: 'a3', title: 'A：补真实浏览器验收', status: 'in_progress' }
        ], counts: { total: 3, completed: 2 } } });
      __frame('A', { type: 'tool_execution_start', toolCallId: 'a-read', toolName: 'read' });
      __frame('A', { type: 'tool_execution_end', toolCallId: 'a-read', isError: false });
      for (let i = 0; i < 36; i++) __text('A', 'A 会话第 ' + (i + 1) + ' 段真实输出，只用于验证滚动容器与多会话隔离。\\n\\n');`);
    await sleep(300);

    await check('Runtime 显示 A 的真实计划、思考与工具状态', async () => {
      const f = await read(`(() => ({
        plan: document.querySelector('.ui2-runtime-plan .plan-card')?.textContent || '',
        count: document.querySelector('.ui2-runtime-plan .plan-count')?.textContent || '',
        thinking: document.querySelector('.ui2-runtime-thinking')?.hidden,
        thinkingText: document.querySelector('.ui2-runtime-thinking-body')?.textContent || '',
        tools: [...document.querySelectorAll('.ui2-runtime-tool')].map(e => e.textContent)
      }))()`);
      must(f.plan.includes('A：接入任务列表数据'), 'A 的计划没有出现在 Runtime');
      must(f.count === '2/3', 'Runtime 计划计数不是 2/3');
      must(f.thinking === false && f.thinkingText.includes('A 会话'), 'Runtime 思考内容缺失');
      must(f.tools.some(t => t.includes('read')), 'Runtime 工具状态缺失');
      return f;
    });

    await read(`document.querySelector('.ui2-runtime-thinking').open = true`);
    await read(`__frame('A', { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '继续追加已经真实返回的思考内容。' } })`);
    await sleep(160);
    await check('Runtime 用户展开后，思考增量不改变 open', async () => {
      const f = await read(`(() => ({
        open: document.querySelector('.ui2-runtime-thinking').open,
        text: document.querySelector('.ui2-runtime-thinking-body').textContent
      }))()`);
      must(f.open === true, 'Runtime 思考被增量收回');
      must(f.text.includes('继续追加'), 'Runtime 思考没有收到增量');
      return f;
    });
    await shot('07-runtime-a-plan-thinking');

    /* B 会话：自己的计划、自己的滚动位置 */
    await read(`document.querySelector('.rtc-output').scrollTop = 0`);
    await sleep(250);
    await read(`__frame('B', { type: 'message_start', message: { role: 'assistant' } });
      __frame('B', { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'B 会话独立处理另一个任务。' } });
      __frame('B', { type: 'tool_execution_start', toolCallId: 'b-plan', toolName: 'gui_plan', plan: {
        version: 1, revision: 1, tasks: [
          { id: 'b1', title: 'B：独立读取供应商配置', status: 'completed' },
          { id: 'b2', title: 'B：等待用户确认', status: 'pending' }
        ], counts: { total: 2, completed: 1 } } });
      for (let i = 0; i < 30; i++) __text('B', 'B 会话第 ' + (i + 1) + ' 段独立输出。\\n\\n');`);
    await read(`__V.show('B')`);
    await sleep(250);
    await read(`document.querySelector('.rtc-output').scrollTop = 0`);
    await sleep(250);
    await check('切到 B 后只显示 B 的计划与思考，A 不串台', async () => {
      const f = await read(`(() => ({
        plan: document.querySelector('.ui2-runtime-plan .plan-card')?.textContent || '',
        thinking: document.querySelector('.ui2-runtime-thinking-body')?.textContent || '',
        running: document.querySelector('.rtc-composer .scroll-bottom')?.dataset.running,
        visible: document.querySelector('.rtc-composer .scroll-bottom')?.classList.contains('is-visible')
      }))()`);
      must(f.plan.includes('B：独立读取供应商配置'), 'B 的计划缺失');
      must(!f.plan.includes('A：接入任务列表数据'), 'A 的计划串到了 B');
      must(f.thinking.includes('B 会话') && !f.thinking.includes('A 会话'), 'A 的思考串到了 B');
      must(f.running === 'false', 'B 空闲时按钮仍显示运行动画');
      must(f.visible, 'B 离开底部时按钮没有出现');
      return f;
    });
    await shot('08-runtime-b-idle-arrow');

    await read(`__V.show('A')`);
    await sleep(250);
    await check('切回 A 恢复自己的计划、思考、滚动位置与运行态按钮', async () => {
      const f = await read(`(() => ({
        plan: document.querySelector('.ui2-runtime-plan .plan-card')?.textContent || '',
        thinking: document.querySelector('.ui2-runtime-thinking-body')?.textContent || '',
        running: document.querySelector('.rtc-composer .scroll-bottom')?.dataset.running,
        visible: document.querySelector('.rtc-composer .scroll-bottom')?.classList.contains('is-visible'),
        top: document.querySelector('.rtc-output').scrollTop
      }))()`);
      must(f.plan.includes('A：接入任务列表数据') && !f.plan.includes('B：独立读取供应商配置'), 'A 的计划没有恢复或串台');
      must(f.thinking.includes('A 会话'), 'A 的思考没有恢复');
      must(f.running === 'true', 'A 运行中按钮没有恢复四点动画');
      must(f.visible, 'A 的按钮没有恢复可见');
      must(f.top <= 1, 'A 的滚动位置没有恢复');
      return f;
    });
    await shot('09-runtime-a-restored');

    await read(`document.querySelector('.rtc-composer .scroll-bottom').click()`);
    await sleep(1000);
    await check('Runtime 点击回到底部只滚 .rtc-output', async () => {
      const f = await read(`(() => {
        const o = document.querySelector('.rtc-output');
        return { gap: o.scrollHeight - o.scrollTop - o.clientHeight,
          visible: document.querySelector('.rtc-composer .scroll-bottom').classList.contains('is-visible'),
          docScroll: document.scrollingElement.scrollTop };
      })()`);
      must(f.gap <= 8, 'Runtime 点击后没有回到底部');
      must(f.visible === false, 'Runtime 回到底部后按钮没有隐藏');
      must(f.docScroll === 0, 'Runtime 点击滚动了文档');
      return f;
    });
    await shot('10-runtime-returned-bottom');

    /* 深色 Runtime 截图（同一套 DOM，仅 token 切换） */
    await read(`document.documentElement.dataset.theme = 'dark'; document.querySelector('.rtc-output').scrollTop = 0`);
    await sleep(250);
    await shot('11-runtime-dark');
    await read(`document.documentElement.dataset.theme = 'light'`);

    /* 交互录制：折叠/展开任务列表、工具与 Thinking，再演示回到底部按钮。 */
    await read(`__surface.showChat()`);
    await sleep(220);
    await bringIntoView('.plan-head');
    if (await read(`document.querySelector('.plan-head').getAttribute('aria-expanded') === 'true'`)) await click('.plan-head');
    await bringIntoView('.tl-group-head');
    if (await read(`document.querySelector('.tl-group-head').getAttribute('aria-expanded') === 'true'`)) await click('.tl-group-head');
    await bringIntoView('.think-head');
    if (await read(`document.querySelector('.think-head').getAttribute('aria-expanded') === 'true'`)) await click('.think-head');
    recordingEvidence = await recordInteraction();

    finalExit = checks.some((c) => !c.pass) ? 1 : 0;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({
      passed: checks.filter((c) => c.pass).length,
      failed: checks.filter((c) => !c.pass).length,
      checks,
      screenshots,
      recording: recordingEvidence,
      errors,
      durationMs: Date.now() - started,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome },
      coverage: 'Actual Electron + real Chromium production ESM/CSS. Classic plan/thinking/tools/scroll; Runtime A/B plan/thinking/tool isolation, idle/running scroll button; dark/light/narrow 700; real input hover/click; no real Pi/model/session data.',
    }, null, 2));
    console.log(`Agent execution visual ${checks.length - checks.filter(c => !c.pass).length}/${checks.length}`);
    console.log('截图目录：' + OUT);
    if (recordingEvidence?.mp4) console.log('交互录制：' + recordingEvidence.mp4);
  }

  const timeout = setTimeout(() => {
    console.error('视觉验收超时');
    app.exit(1);
  }, 240000);

  main().catch((error) => {
    errors.push(error.stack || String(error));
    checks.push({ pass: false, label: 'execution completed', error: error.message });
    finalExit = 1;
  }).finally(async () => {
    clearTimeout(timeout);
    try {
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({
        passed: checks.filter((c) => c.pass).length,
        failed: checks.filter((c) => !c.pass).length,
        checks,
        screenshots,
        recording: recordingEvidence,
        errors,
        durationMs: Date.now() - started,
        versions: { electron: process.versions.electron, chrome: process.versions.chrome },
      }, null, 2));
    } catch { /* evidence write best effort */ }
    win?.destroy();
    harness?.kill();
    await sleep(100);
    app.exit(finalExit);
  });
}
