/* Stop 语义的真机验证（opt-in，**不在 `npm test` 链里**，因为它要调真实模型）。
 *
 * 单测（tests/stop-barrier.cjs）用假 pi 把时序钉死；这一份补的是另一半：
 * **真 pi + 真模型**下，「停止之后发的那一条」到底走的是 prompt 还是 steer。
 * 那正是用户报的 bug：
 *
 *     math-utils.js 正在生成 → Stop → 立刻发 hello.txt
 *     → 前端还认为在跑 → hello.txt 被当成 steer 排进旧 run
 *     → 旧任务继续完成，新任务也被吞进去
 *
 * 复现步骤与用户的原始场景一致，判据是可观察的**官方应答形状**，不是猜：
 *   - 第一条消息的应答必须是 `{"command":"prompt","data":{"disposition":"started"}}`
 *   - 停止期间再发一条，必须被后端拒（`code: "stop_in_progress"`），
 *     而且 pi 那边**不能**出现 steer
 *   - Stop 的 HTTP 200 表示 pi 已确认空闲（abort 应答的官方语义）
 *   - 之后那条 hello.txt 的应答必须是 `{"command":"prompt",...}`，
 *     绝不能是 `{"command":"steer","data":{"disposition":"queued"}}`
 *   - math-utils.js 在 Stop 之后**不再推进**（记录停止时的字节数再对比）
 *
 * ⚠️ 磁盘写操作**全部落在 os.tmpdir() 里临时造的项目目录**，不碰用户的任何真实项目
 * （AGENTS.md 的硬约束）。`PI_GUI_DATA` 也指向临时目录，所以退出时会把那个目录删掉。
 *
 * 刻意**不**改 `PI_CODING_AGENT_DIR`：模型与凭据就在 `<agent-dir>/models.json` 里，
 * 换掉它这次验证就跑不起来，而为了一次测试把用户的 key 复制到临时目录更糟。
 * 所以 pi 会照常在自己的 agent 目录里为这个临时项目**新建**一条会话 —— 与用户在
 * 界面里打开任何项目是同一件事；不读、不改他已有的任何会话文件。
 *
 * 用法：node tests/stop-live.cjs            （需要本机装了 pi、配好了模型，约 3-6 分钟）
 *      PI_BIN=/path/to/pi node tests/stop-live.cjs
 *      PI_PROVIDER=magpie PI_MODEL=deepseek/deepseek-v4-pro node tests/stop-live.cjs
 *
 * ⚠️ 用**环境里配的那个模型**跑。它要真的能生成文件（默认那条链在当前环境
 * 被上游停用时会一直是 `provider_unavailable`），模型不可用时的失败信息会说清
 * 楚是「等文件落盘超时」，不是断言失败。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FIRST = '创建一个包含 10 个函数的 math-utils.js，每个函数加英文注释和 JSDoc';
const SECOND = '在项目里创建一个 hello.txt，内容只写一行 hello world';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(label, test, ms = 120000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await test();
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`超时：${label}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
/** 订阅 SSE，把事件收进数组（与 reliability-live.cjs 同一个读法）。 */
function watch(url, events) {
  const controller = new AbortController();
  const done = fetch(url, { signal: controller.signal }).then(async (response) => {
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += new TextDecoder().decode(chunk);
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const line = frame.split('\n').find((item) => item.startsWith('data: '));
        if (line) events.push(JSON.parse(line.slice(6)));
      }
    }
  }).catch((error) => { if (!controller.signal.aborted) throw error; });
  return { stop: () => { controller.abort(); return done; } };
}

async function main() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-stop-live-project-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-stop-live-data-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const events = [];
  let child = null;
  let watcher = null;
  const evidence = [];

  try {
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        PI_CWD: project,
        PI_GUI_DATA: data,
        PI_NO_CONTINUE: '1',
        PI_GUI_OPEN: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const log = [];
    child.stdout.on('data', (chunk) => log.push(String(chunk)));
    child.stderr.on('data', (chunk) => log.push(String(chunk)));

    await waitFor('后端启动', async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok, 30000);
    watcher = watch(`${base}/api/events`, events);
    await waitFor('pi 就绪', async () => {
      const status = await (await fetch(`${base}/api/status`)).json();
      if (status.bridgeState === 'error') throw new Error('pi 启动失败：' + status.bridgeError + ' ' + status.bridgeHint);
      return status.bridgeState === 'ready';
    }, 120000);

    const command = async (body, timeoutMs = 300000) => {
      const response = await fetch(`${base}/api/command`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: response.status, body: await response.json() };
    };
    const prompt = (message) => command({ type: 'prompt', message });
    /* RPC 应答本身走 SSE（后端只把命令写进 pi 的 stdin）。 */
    const responseFor = (name, since) => events
      .slice(since)
      .find((e) => e.type === 'response' && e.command === name);
    const eventIndex = () => events.length;

    /* ---------- 第一条：长任务 ---------- */
    const beforeFirst = eventIndex();
    assert.equal((await prompt(FIRST)).status, 200, '第一条 prompt 必须被接受');
    await waitFor('第一条开始跑', () => events.slice(beforeFirst).some((e) => e.type === 'agent_start'), 180000);
    const started = await waitFor('第一条 prompt 的官方应答', () => responseFor('prompt', beforeFirst), 30000);
    assert.equal(started.success, true, JSON.stringify(started));
    assert.equal(started.data?.disposition, 'started', '第一条必须真的开了一轮');
    evidence.push(`第一条 prompt 应答：disposition=${started.data.disposition}`);

    /* 等它真的在写文件 —— 「明显仍在运行」的可观察证据。 */
    const target = path.join(project, 'math-utils.js');
    await waitFor('math-utils.js 开始落盘', () => fs.existsSync(target), 180000);
    await sleep(600);
    const sizeAtStop = fs.statSync(target).size;
    const running = await (await fetch(`${base}/api/status`)).json();
    assert.equal(running.stop, null, 'Stop 之前不该有屏障');
    evidence.push(`Stop 时 math-utils.js = ${sizeAtStop} 字节，且仍在生成`);

    /* ---------- Stop：等 pi 的权威确认 ---------- */
    const beforeStop = eventIndex();
    const aborting = command({ type: 'abort' });
    /* 用户原场景里最关键的一步：Stop **还没确认**的时候就把新任务发出去。
     * 真实前端这时不会发；这里**故意**模拟「前端 bug / 旧 tab / 手工 HTTP」
     * 绕过界面直接问后端 —— 后端必须自己挡住（这是防复发的核心保护）。
     * 判据的前提是「那一枪确实打在屏障立着的时候」，所以先轮询确认屏障在。 */
    let sawBarrier = false;
    for (let i = 0; i < 400 && !sawBarrier; i++) {
      const live = await (await fetch(`${base}/api/status`)).json();
      if (live.stop?.pending) sawBarrier = true;
      else await sleep(1);
    }
    const sneaky = await command({ type: 'prompt', message: '这条不许进旧 run' });
    const whileSneaking = await (await fetch(`${base}/api/status`)).json();
    const stop = await aborting;
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    assert.equal(stop.body.ok, true, 'Stop 必须是权威确认：' + JSON.stringify(stop.body));
    /* evidence 就是后端那句「凭哪条权威证据解除的屏障」。`abort-response` =
     * pi 回了 success 的 abort（官方语义：应答发出时会话已经空闲）。
     * ⚠️ 别去 SSE 里找那条应答：后端自己发起的 request 用**数字 id**，
     * 按设计不广播给 Renderer（见 server/rpc-bridge.js 的 stdout 分支）。 */
    assert.equal(stop.body.stop?.evidence, 'abort-response', '必须是 pi 的权威应答，不是「写下去就算」');
    const settled = events.slice(beforeStop).filter((e) => e.type === 'agent_settled');
    evidence.push(`Stop 已确认：evidence=${stop.body.stop.evidence}，clear_queue=${stop.body.stop?.queue}，agent_settled ${settled.length} 次`);
    if (sawBarrier) {
      assert.equal(sneaky.body.code, 'stop_in_progress',
        `屏障立着时新 prompt 必须被拒（sneaky=${JSON.stringify(sneaky.body)}，随后 stop.pending=${Boolean(whileSneaking.stop?.pending)}）`);
      assert.ok(!events.slice(beforeStop).some((e) => e.type === 'response' && e.command === 'steer'),
        'pi 那边不能出现任何 steer 应答（命令根本没写下去）');
      evidence.push('停止期间插队的 prompt 被后端拒绝（stop_in_progress），pi 未收到');
    } else {
      /* 竞态：这一枪没赶上窗口。如实记下来，不当成通过。 */
      evidence.push('⚠️ 插队那一枪没赶上停止窗口（Stop 确认太快），屏障保护以 tests/stop-barrier.cjs 为准');
    }

    /* ---------- 第二条：必须走 prompt ---------- */
    const beforeSecond = eventIndex();
    assert.equal((await prompt(SECOND)).status, 200, 'Stop 之后的新任务必须被接受');
    const second = await waitFor('第二条 prompt 的官方应答', () => responseFor('prompt', beforeSecond), 30000);
    assert.equal(second.success, true, JSON.stringify(second));
    assert.equal(responseFor('steer', beforeSecond), undefined, '第二条绝不能走 steer');
    evidence.push(`第二条 prompt 应答：disposition=${second.data?.disposition}（不是 steer）`);

    const hello = path.join(project, 'hello.txt');
    await waitFor('hello.txt 落盘', () => fs.existsSync(hello) && fs.statSync(hello).size > 0, 300000);
    await waitFor('这一轮结束（agent_settled）',
      () => events.slice(beforeSecond).some((e) => e.type === 'agent_settled'), 300000);
    /* 等 pi 把文件写完再读一次，避免读到半行。 */
    await sleep(500);
    const content = fs.readFileSync(hello, 'utf8').trim();
    assert.equal(content, 'hello world', 'hello.txt 的内容必须是 hello world，实际：' + JSON.stringify(content));
    evidence.push(`hello.txt 内容正确：${JSON.stringify(content)}`);

    /* ---------- 旧任务没有在 Stop 之后继续推进 ---------- */
    const sizeAfter = fs.existsSync(target) ? fs.statSync(target).size : 0;
    evidence.push(`math-utils.js：Stop 时 ${sizeAtStop} 字节 → 结束 ${sizeAfter} 字节`);
    assert.equal(sizeAfter, sizeAtStop,
      'math-utils.js 在 Stop 之后不允许再被旧任务写（允许 Stop 之前已经写下的部分）');
    assert.equal(fs.readdirSync(project).filter((name) => /hello/i.test(name)).length, 1);

    console.log('\n真机 Stop 复现：通过');
    for (const line of evidence) console.log('  · ' + line);
  } catch (error) {
    console.error('\n真机 Stop 复现：失败 —— ' + error.message);
    if (events.length) console.error('最近事件类型：' + events.slice(-12).map((e) => e.type + (e.command ? `:${e.command}` : '')).join(' '));
    process.exitCode = 1;
  } finally {
    try { watcher?.stop(); } catch { /* noop */ }
    try { child?.kill(); } catch { /* noop */ }
    await sleep(300);
    /* 临时目录（含 pi 在 fake project 里写的会话）用完就删；删不掉不报错。 */
    for (const dir of [project, data]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
