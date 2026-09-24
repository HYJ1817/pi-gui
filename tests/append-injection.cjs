/* 项目指令是否**真的**进了系统提示词（运行时实证）。
 *
 * 为什么单独一份、且不在 npm test 里：它要拉起真的 pi、跑两条 prompt，
 * 约 25 秒。跟 exe-check / app-check 一样属于「按需验收」。
 *
 * 为什么需要它：项目配置把 instructions 落成 instructions.generated.md，
 * 再用 --append-system-prompt <文件> 交给 pi。这条链在源码里能读出来，
 * 但「读出来」和「真的生效」是两件事 —— pi 完全可能解析了参数却没用上
 * （比如只在 TUI 模式接、或者被某个设置关掉）。一旦如此，用户看到的是
 * 「指令保存成功了，但 Agent 完全不理」，而且没有任何报错。
 *
 * 怎么观测：挂一个扩展，在 before_agent_start 把**组装好的系统提示词** dump 出来。
 * 这个钩子在 provider 请求之前触发，所以不需要模型应答 —— 本机模型调用超时
 * 也照样能拿到证据（这正是之前 4 个探针卡住的地方）。
 *
 * 顺带钉住本设计的**前提**：pi 在非交互模式下对 error 级启动诊断会 exit(1)。
 * 项目配置之所以不把模型当启动参数传，就是基于这条（见 server/project-config.js）。
 * 如果哪天 pi 改了，这里会红 —— 那不是测试坏了，是该回去复核设计前提。
 *
 * 用法：node tests/append-injection.cjs   （可用 PI_BIN 指定 pi 路径）
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';
const MARKER = 'PI-GUI-APPEND-PROBE-7F3A9C';
const BODY = `# 项目指令\n\n${MARKER}\n\n这个项目用 TypeScript，不要修改 generated/ 目录。\n`;

let pass = 0;
let fail = 0;
function check(name, cond) {
  const ok = typeof cond === 'function' ? cond() : cond;
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok ? '  → ' + ok : ''));
  }
}
function section(t) {
  console.log('\n--- ' + t + ' ---');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 与 server/rpc-bridge.js 的 spawnPi 同一套做法：
 *  自己拼命令字符串，不用 spawn(bin, args, {shell:true})（那会刷 DEP0190）。 */
function spawnPi(piBin, args, opts) {
  if (!IS_WIN) return spawn(piBin, args, opts);
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  return spawn([piBin, ...args].map(q).join(' '), { ...opts, shell: true });
}

const EXT_SRC = `
import fs from 'node:fs';

export default function (pi) {
  pi.on('before_agent_start', async (event) => {
    const out = process.env.PI_PROBE_OUT;
    if (!out) return;
    const opts = event.systemPromptOptions || {};
    fs.writeFileSync(out, JSON.stringify({
      systemPromptLength: (event.systemPrompt || '').length,
      appendSystemPrompt: opts.appendSystemPrompt ?? null,
      systemPrompt: event.systemPrompt || '',
    }, null, 2), 'utf8');
  });
}
`;

/** 起一次 pi RPC，发一条 prompt 触发钩子，等 dump 文件出现，然后关掉。 */
async function probe({ piBin, work, ext, outFile, extraArgs, timeoutMs = 25000 }) {
  const args = ['--mode', 'rpc', '--no-session', '-e', ext, ...extraArgs];
  const p = spawnPi(piBin, args, {
    cwd: work,
    env: { ...process.env, PI_PROBE_OUT: outFile, PI_NO_CONTINUE: '1', PI_GUI_TOKEN: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  /* 只记「pi 自己退出」——探针最后一定会 kill 掉它，那次 SIGTERM 不算数。 */
  let earlyExit = null;
  let killing = false;
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('exit', (c, s) => { if (!killing) earlyExit = { code: c, signal: s }; });

  await sleep(2500); // 等 pi 起来
  if (!earlyExit) {
    try {
      p.stdin.write(JSON.stringify({ id: 1, type: 'prompt', message: 'ping' }) + '\n');
    } catch { /* 已退出 */ }
  }

  const deadline = Date.now() + timeoutMs;
  // 三种结束条件任一命中就走：钩子写了 dump、pi 自己退了、超时。
  // 「自己退了」必须算一个 —— 否则一个本该秒退的用例要白等满超时。
  while (Date.now() < deadline && !fs.existsSync(outFile) && !earlyExit) await sleep(400);

  killing = true;
  try { p.kill(); } catch { /* 已退出 */ }
  await sleep(300);

  let dump = null;
  try {
    dump = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch { /* 没写出来 */ }

  return { dump, stdout, stderr, earlyExit };
}

/* ---------- 前置：pi 在不在 ---------- */

/** 跑一次 `pi --version`，只看能不能跑通。
 *
 * 用 spawn 而不是 spawnSync：本机受限环境下 spawnSync 走 shell 会报
 * `cmd.exe EBUSY`（spawn 没这个问题）。 */
function versionOk(piBin) {
  return new Promise((resolve) => {
    let p;
    try {
      p = IS_WIN
        ? spawn(`"${piBin}" --version`, { shell: true, stdio: 'ignore', windowsHide: true })
        : spawn(piBin, ['--version'], { stdio: 'ignore', windowsHide: true });
    } catch {
      return resolve(false);
    }
    const t = setTimeout(() => {
      try { p.kill(); } catch { /* 已退出 */ }
      resolve(false);
    }, 8000);
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('exit', (code) => { clearTimeout(t); resolve(code === 0); });
  });
}

/* pi 的位置。应用运行时用的是 PATH 上的 `pi`（见 server/rpc-bridge.js），
 * 但测试进程的 PATH 未必和用户桌面环境一致 —— 这台机器上就是如此：
 * `where pi` 返回空，而 %APPDATA%\npm\pi.cmd 明明在。所以这里多试几个位置。 */
async function resolvePi() {
  const cands = [process.env.PI_BIN, 'pi'];
  if (IS_WIN) {
    if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'npm', 'pi.cmd'));
    if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'pi', 'pi.cmd'));
  } else {
    cands.push(path.join(os.homedir(), '.local', 'bin', 'pi'), '/usr/local/bin/pi', '/opt/homebrew/bin/pi');
  }
  for (const bin of cands) {
    if (!bin) continue;
    if (await versionOk(bin)) return bin;
  }
  return null;
}

(async () => {
  const PI = await resolvePi();
  if (!PI) {
    console.log(`找不到可用的 pi（试过 PI_BIN、PATH、常见安装位置），跳过这组验收。`);
    console.log('这组测的是 pi 的注入行为，没有 pi 就无从观测。');
    process.exit(0);
  }
  console.log('pi：' + PI);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-inject-'));
  const ext = path.join(work, 'probe-ext.ts');
  const appendFile = path.join(work, 'instructions.generated.md');
  fs.writeFileSync(ext, EXT_SRC, 'utf8');
  fs.writeFileSync(appendFile, BODY, 'utf8');

  console.log('工作目录：' + work);

  /* ============ 1. 不带 append ============ */
  section('对照组：不传 --append-system-prompt');

  const a = await probe({ piBin: PI, work, ext, outFile: path.join(work, 'dump-a.json'), extraArgs: [] });
  check('钩子被触发（拿到组装后的系统提示词）', () => Boolean(a.dump) || 'dump 没写出来，stderr：' + a.stderr.slice(0, 300));
  check('不传参数时 pi 正常活着、不退出', () => a.earlyExit === null || JSON.stringify(a.earlyExit));

  if (a.dump) {
    check('系统提示词不是空的（pi 确实组装了一份）', () =>
      a.dump.systemPromptLength > 1000 || '只有 ' + a.dump.systemPromptLength + ' 字');
    check('对照组里没有我们的标记文本', () =>
      !a.dump.systemPrompt.includes(MARKER) || '标记文本不该出现');
    check('appendSystemPrompt 字段为空', () =>
      !a.dump.appendSystemPrompt || JSON.stringify(a.dump.appendSystemPrompt));
  }

  /* ============ 2. 带 append ============ */
  section('实验组：传 --append-system-prompt <文件>');

  const b = await probe({
    piBin: PI,
    work,
    ext,
    outFile: path.join(work, 'dump-b.json'),
    extraArgs: ['--append-system-prompt', appendFile],
  });
  check('钩子被触发', () => Boolean(b.dump) || 'dump 没写出来，stderr：' + b.stderr.slice(0, 300));
  check('传了参数也不退出（不是 error 级诊断）', () => b.earlyExit === null || JSON.stringify(b.earlyExit));

  if (a.dump && b.dump) {
    check('标记文本出现在系统提示词里（注入真的到达 prompt）', () =>
      b.dump.systemPrompt.includes(MARKER) || '没找到标记文本');
    check('追加的文本被包在 <addendum> 段里（走的是 pi 官方的附加段）', () =>
      /<addendum>[\s\S]*PI-GUI-APPEND-PROBE-7F3A9C[\s\S]*<\/addendum>/.test(b.dump.systemPrompt) ||
      '没有 <addendum> 包裹');
    check('系统提示词变长了（不是替换掉原有内容）', () =>
      b.dump.systemPromptLength > a.dump.systemPromptLength + 50 ||
      `长度 ${a.dump.systemPromptLength} → ${b.dump.systemPromptLength}`);
    check('pi 读到的 appendSystemPrompt 就是文件内容', () =>
      (typeof b.dump.appendSystemPrompt === 'string' && b.dump.appendSystemPrompt.includes(MARKER)) ||
      JSON.stringify(b.dump.appendSystemPrompt));
  }

  /* ============ 3. 钉住设计前提 ============ */
  section('设计前提：非交互模式下 error 级启动诊断会 exit(1)');

  /* 窗口给到 60 秒：这台机器上 pi 启动本身就要 20 秒左右，而
   * `Unknown provider` 这条诊断是在模型解析阶段才产生的（实测 22.1 秒才退）。
   * 窗口开小了会得到「pi 没有退出」这种假绿 —— 它只是还没走到那一步。
   * 循环会在 pi 真的退出时立刻结束，所以在快的机器上不会白等。 */
  const bad = await probe({
    piBin: PI,
    work,
    ext,
    outFile: path.join(work, 'dump-c.json'),
    extraArgs: ['--provider', 'no-such-provider-xyz', '--model', 'no-such-model-xyz'],
    timeoutMs: 60000,
  });
  check('假 provider + 假 model 会让 pi 直接退出（所以模型不能当启动参数传）', () =>
    bad.earlyExit !== null ||
    'pi 没有退出 —— 请复核 server/project-config.js 的 launchArgs 设计前提');
  check('退出码是 1（error 级诊断，不是普通失败）', () =>
    (bad.earlyExit && bad.earlyExit.code === 1) || JSON.stringify(bad.earlyExit));
  check('stderr 里是 Unknown provider（诊断确实来自模型解析）', () =>
    /Unknown provider/.test(bad.stderr) || JSON.stringify(bad.stderr.slice(0, 200)));

  /* ---------- 收尾 ---------- */
  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  } catch { /* Windows 临时目录偶发占用，不阻塞 */ }

  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
