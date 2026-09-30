/* 真实浏览器验收（**opt-in**，不在 `npm test` 链里，CI 永远不会跑它）。
 *
 * 单测（tests/browser.cjs）用的是离线 fixture —— 它能证明「给定 pi-browser-harness
 * 的应答形状，我们的判定对不对」，但证明不了「真实 Extension 真的会那样应答」。
 * 这一份补上后者：拉起真的 `pi --mode rpc`，让模型真的调浏览器工具，
 * 把真实事件喂给**同一个** browserActivity，看渲染结果对不对。
 *
 * 它**不会**替你安装任何东西，也不会启动第二个 Chrome：
 *   - 浏览器与 Profile 由 pi-browser-harness 自己管理；
 *   - 本脚本只在一个临时工作目录里跑，`--no-session`，不碰你的真实项目与会话；
 *   - 只访问公开、无需登录、无副作用的页面（example.com / iana.org）。
 *
 * 用法（需要本机已装 pi、已装并配置好 pi-browser-harness、本机有 Chrome）：
 *
 *   PI_GUI_BROWSER_LIVE=1 npm run test:browser-live
 *   PI_GUI_BROWSER_LIVE=1 PI_BIN=/path/to/pi node tests/browser-live.cjs
 *
 * 不带 `PI_GUI_BROWSER_LIVE=1` 时只打印手工验收清单并退出 0 —— 这样它既不会
 * 在 CI 上误跑，也不会让手滑的人花掉模型额度。
 *
 * 环境注意（与 skills-live.cjs 同一批坑）：
 *   - pi 冷启动约 20 秒 → 一律轮询等应答，不 sleep 固定时间；
 *   - spawn 的 cwd **必须先建出来**，否则 Windows 上报的是误导性的
 *     `spawn C:\WINDOWS\system32\cmd.exe ENOENT`；
 *   - 必须监听 child 的 'error'，否则启动失败会静默挂住。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MANUAL = `
手工验收清单（脚本覆盖不到的部分，请在 Pi GUI 里照着走一遍）：

  1. 用公开、无需登录、无副作用的站点：https://example.com
  2. 打开页面          → 时间线出现「Opening…」→「Opened example.com」
  3. 点击无副作用链接   → 「Clicking…」→「Clicked [eN]」（只显示元素句柄，不显示页面文本）
  4. 读取内容          → 「Reading page…」→「Read example.com」，折叠区只有 Words 计数
  5. 返回 / 关闭标签页  → 「Went back」/「Closed tab」
  6. 中途点 Stop       → 标签变成「<动作> stopped」，**不残留 spinner**，状态点不是对勾
  7. 重新打开这个历史会话 → 同样的 Activity，**不铺原始 JSON**、不显示输入内容
  8. 切项目 / 重启 Pi   → Extensions 页的「已观察到调用」归零
  9. 表单：只用专门的测试页面，且**不提交**真实个人信息
 10. 高风险动作（提交、购买、删除、发布、发送消息）：Pi GUI **没有**任何批准流，
     这个 Extension 也没有审批协议 —— 不要指望界面会拦你

前置检查（脚本自己会做的）：Extension 是否已安装、模型是否可用。
`;

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkWorld() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-browser-live-'));
  const proj = path.join(base, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  // 项目里放 .git，把「祖先目录扫描」钉在临时目录内，避免扫到真实用户主目录。
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  return { base, proj };
}

/** 极简 RPC 客户端：帧格式照抄 server/rpc-bridge.js。 */
function startPi({ cwd, env, timeoutMs = 120000 }) {
  const bin = env.PI_BIN || 'pi';
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  const child = spawn([bin, '--mode', 'rpc', '--no-session'].map(q).join(' '), {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: true,
  });

  let buf = '';
  let stderrText = '';
  let spawnError = null;
  let exited = null;
  const events = [];
  const pending = new Map();
  let nextId = 1;

  child.on('error', (err) => { spawnError = err; });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    for (const [, e] of pending) { clearTimeout(e.timer); e.resolve(null); }
    pending.clear();
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (!msg || typeof msg !== 'object') continue;
      if (msg.type === 'response' && pending.has(msg.id)) {
        const e = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(e.timer);
        e.resolve(msg.success === false ? { __error: msg.error || '命令失败' } : (msg.data ?? {}));
        continue;
      }
      events.push(msg);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (t) => { stderrText += t; });

  /** 与 server/rpc-bridge.js 同契约：永不 reject，失败回 null。 */
  function request(cmd, { timeout = timeoutMs } = {}) {
    return new Promise((resolve) => {
      if (spawnError || exited) { resolve(null); return; }
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); resolve(null); }, timeout);
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(id, { resolve, timer });
      try {
        child.stdin.write(JSON.stringify({ ...cmd, id }) + '\n', (err) => {
          if (!err || !pending.has(id)) return;
          clearTimeout(timer);
          pending.delete(id);
          resolve(null);
        });
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        resolve(null);
      }
    });
  }

  function stop() {
    try { child.stdin.end(); } catch { /* 已经关了 */ }
    try { child.kill(); } catch { /* 已经退了 */ }
  }

  return {
    request,
    stop,
    events,
    get spawnError() { return spawnError; },
    get exited() { return exited; },
    get stderr() { return stderrText; },
  };
}

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  const ok = typeof cond === 'function' ? cond() : cond;
  if (ok === true) { pass++; console.log('  ok   ' + name); return; }
  fail++;
  console.log('  FAIL ' + name + (typeof ok === 'string' ? '  → ' + ok : extra ? '  → ' + extra : ''));
}

(async () => {
  if (process.env.PI_GUI_BROWSER_LIVE !== '1') {
    console.log('未设置 PI_GUI_BROWSER_LIVE=1 —— 这是 opt-in 的真实浏览器验收，不在这里跑。');
    console.log(MANUAL);
    return;
  }

  const args = parseArgs(process.argv);
  const { browserActivity } = await import('../public/browser-activity.js');

  const world = mkWorld();
  const pi = startPi({
    cwd: world.proj,
    env: { ...process.env, PI_BIN: process.env.PI_BIN || 'pi' },
  });

  const cleanup = () => {
    pi.stop();
    try { fs.rmSync(world.base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows 偶发占用 */ }
  };
  process.on('exit', cleanup);

  console.log('pi 可执行文件：' + (process.env.PI_BIN || 'pi'));
  console.log('临时工作目录：' + world.proj + '（--no-session，不碰你的真实项目）');

  console.log('\n--- 1. pi 是否起来了 ---');
  let state = null;
  for (let i = 0; i < 40 && !state; i++) {
    state = await pi.request({ type: 'get_state' }, { timeout: 5000 });
    if (!state) await sleep(1500);
  }
  check('pi RPC 应答 get_state', () => Boolean(state) || (pi.spawnError && String(pi.spawnError.message)) || 'pi 没应答');

  const tools = await pi.request({ type: 'get_commands' }, { timeout: 20000 });
  const commands = Array.isArray(tools?.commands) ? tools.commands : [];
  const browserCommands = commands.filter((c) => String(c?.source) === 'extension' && /browser/.test(String(c?.name || '')));
  console.log('  （Extension 命令里和 browser 相关的：' + (browserCommands.map((c) => c.name).join(', ') || '无') + '）');

  console.log('\n--- 2. 让模型真的调浏览器工具（只走公开无登录页面） ---');
  const prompt = [
    '请只使用浏览器工具完成下面 4 步，不要使用其它工具，不要访问 example.com / iana.org 之外的站点：',
    '1) browser_navigate 打开 https://example.com',
    '2) browser_read_page 读取当前页',
    '3) browser_go_back 返回',
    '4) browser_close_tab 关闭你打开的那个标签页',
    '每一步只调用一次；全部做完后用一句话总结。',
  ].join('\n');
  await pi.request({ type: 'prompt', message: prompt }, { timeout: 30000 });

  const deadline = Date.now() + 240000;
  let sawEnd = 0;
  while (Date.now() < deadline) {
    sawEnd = pi.events.filter((e) => e.type === 'tool_execution_end').length;
    if (sawEnd >= 1 && pi.events.some((e) => e.type === 'agent_settled')) break;
    if (pi.exited) break;
    await sleep(2000);
  }

  const starts = pi.events.filter((e) => e.type === 'tool_execution_start' && /^browser_/.test(String(e.toolName || '')));
  const ends = pi.events.filter((e) => e.type === 'tool_execution_end' && /^browser_/.test(String(e.toolName || '')));
  console.log('  观察到：start=' + starts.length + ' end=' + ends.length +
    '（' + [...new Set(starts.map((e) => e.toolName))].join(', ') + '）');

  check('真实 browser_* 工具事件到达', () => starts.length > 0 ||
    '没有观察到 browser_* 事件：Extension 没装 / 没启用 / 模型没调它 / Chrome 没起来 —— 三者都要自己确认');

  console.log('\n--- 3. 真实事件喂给同一个 browserActivity ---');
  const rendered = [];
  for (const evt of ends) {
    const entry = {
      name: evt.toolName,
      args: evt.args ?? null,
      details: evt.result?.details ?? null,
      status: evt.isError ? 'error' : 'success',
    };
    const a = browserActivity(entry);
    rendered.push({ name: evt.toolName, isError: Boolean(evt.isError), ok: evt.result?.details?.ok, a });
    console.log('  ' + evt.toolName + '  →  ' + (a ? a.label + (a.summary ? '  ·  ' + a.summary : '') : '(generic fallback)'));
  }
  check('真实结果有结构化成功证据（details.ok === true）', () => rendered.some((r) => r.ok === true) ||
    '一个 details.ok === true 都没有：确认装的是 pi-browser-harness，且版本与 docs/browser.md 记录的一致');
  check('至少一条走的是专用 renderer（不是 generic fallback）', () => rendered.some((r) => r.a));
  check('真实 Activity 里没有原始结果正文', () => rendered.every((r) => !JSON.stringify(r.a ?? {}).includes('RAW_RESULT')));

  console.log('\n--- 4. 结果 ---');
  console.log(`  ${pass} 通过 / ${fail} 失败`);
  if (fail) console.log('  提示：这一份是**真实环境**验收，失败先确认 Extension 与 Chrome 的状态，再怀疑代码。');
  console.log(MANUAL);
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
