/* 真实 pi 的运行时验证（opt-in，不在 `npm test` 链里）。
 *
 * 单测（tests/skills.cjs）用的是桩 rpc —— 它能证明「给定 pi 的应答，我们的判定对不对」，
 * 但证明不了「pi 真的会那样应答」。这一份专门补上后者：**拉起真的 pi 子进程**，
 * 用真的 `get_commands` 当权威加载集，和 server/skills.js 的枚举结果对拍。
 *
 * 验证的是这几条结论（全部在开发期用探针实测过，这里固化成断言，防止将来回归）：
 *   1. 项目级 skill 在 `--mode rpc`（非交互、无 UI）下**默认不加载**；
 *      `--approve` 之后才加载 —— 这就是「项目未被信任」这条状态的事实依据。
 *   2. 同名冲突时**项目级胜出**（不是 user）。
 *   3. 停用语法：`-skills/<dir>/SKILL.md`（带 skills/ 前缀的 posix 相对路径）有效；
 *      `-<裸名字>` **无效**；`!<glob>` 有效。
 *   4. 改 settings.json 之后 pi **不会**热加载，必须重启才生效 —— 这是
 *      /api/skills 返回 restartRequired 的依据。
 *   5. `enableSkillCommands:false` 时 `get_commands` **仍然返回** skill ——
 *      所以它可以放心当权威来源。
 *   6. `--no-skills` 关掉全部发现。
 *
 * 用法：node tests/skills-live.cjs        （需要本机装了 pi，约 2-3 分钟）
 *      PI_BIN=/path/to/pi node tests/skills-live.cjs
 *
 * 环境注意（踩过的坑）：
 *   - pi 冷启动约 20 秒，所以是「轮询等应答」而不是「sleep 固定时间」；
 *   - **spawn 的 cwd 必须先建出来**，否则 Windows 上报的是
 *     `spawn C:\WINDOWS\system32\cmd.exe ENOENT` —— 一个极具误导性的错误；
 *   - 必须监听 child 的 'error'，否则启动失败会静默挂住。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  const ok = typeof cond === 'function' ? cond() : cond;
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok ? '  → ' + ok : extra ? '  → ' + extra : ''));
  }
}
function section(t) {
  console.log('\n--- ' + t + ' ---');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-skills-live-'));
function cleanup() {
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows 偶发占用 */
  }
}

/* ---------- 隔离世界 ---------- */

function mkWorld(name) {
  const base = path.join(TMP, name);
  const home = path.join(base, 'home');
  const agent = path.join(base, 'agent');
  const proj = path.join(base, 'proj');
  // 三个目录都必须先建出来：spawn 的 cwd 不存在会报一个完全误导的 ENOENT
  for (const d of [home, agent, proj]) fs.mkdirSync(d, { recursive: true });
  // 项目里放 .git，把「祖先 .agents/skills」的扫描钉在项目内 —— 否则会一路扫到
  // 真实用户主目录，测试结果就跟着这台机器上装了什么而变了
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  return { base, home, agent, proj };
}

function writeSkill(root, name, description) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, 'utf8');
  return path.join(d, 'SKILL.md');
}
function writeSettings(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/* ---------- 极简 RPC 客户端（帧格式照抄 server/rpc-bridge.js） ---------- */

function startPi({ cwd, env, args }) {
  const bin = env.PI_BIN || 'pi';
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  const full = [bin, '--mode', 'rpc', '--no-session', ...args];
  const child = spawn(full.map(q).join(' '), {
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
  const pending = new Map();
  let nextId = 1;

  child.on('error', (err) => {
    spawnError = err;
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    for (const [, e] of pending) {
      clearTimeout(e.timer);
      e.resolve(null);
    }
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
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && msg.type === 'response' && pending.has(msg.id)) {
        const e = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(e.timer);
        e.resolve(msg.success === false ? { __error: msg.error || '命令失败' } : msg.data ?? {});
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (t) => {
    stderrText += t;
  });

  /** 与 server/rpc-bridge.js 的 request() 同契约：永不 reject，失败回 null。 */
  function request(cmd, { timeoutMs = 8000 } = {}) {
    return new Promise((resolve) => {
      if (spawnError || exited) {
        resolve(null);
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      try {
        child.stdin.write(JSON.stringify({ ...cmd, id }) + '\n');
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        resolve(null);
      }
    });
  }

  /** 轮询到 pi 给出 skill 列表为止（冷启动约 20 秒）。返回 null 表示超时/起不来。 */
  async function waitForSkills({ maxMs = 90000 } = {}) {
    const deadline = Date.now() + maxMs;
    let first = null;
    while (Date.now() < deadline) {
      if (spawnError) return { error: spawnError.message, skills: null };
      if (exited) return { error: `pi 提前退出（code=${exited.code}）`, skills: null };
      const data = await request({ type: 'get_commands' }, { timeoutMs: 6000 });
      if (data && !data.__error) {
        first = data;
        break;
      }
      await sleep(2500);
    }
    if (!first) return { error: '等 pi 应答超时', skills: null };
    // 再问一次确认稳定，避免拿到「还没加载完」的中间态
    await sleep(1200);
    const second = await request({ type: 'get_commands' }, { timeoutMs: 6000 });
    const data = second && !second.__error ? second : first;
    const names = new Set();
    for (const cmd of data.commands || []) {
      if (cmd.source !== 'skill') continue;
      const n = String(cmd.name || '').replace(/^skill:/, '');
      if (n) names.add(n);
    }
    return { error: null, skills: names, raw: data };
  }

  function stop() {
    for (const [, e] of pending) {
      clearTimeout(e.timer);
      e.resolve(null);
    }
    pending.clear();
    try {
      child.stdin.end();
    } catch {
      /* noop */
    }
    try {
      child.kill();
    } catch {
      /* noop */
    }
  }

  return { request, waitForSkills, stop, get stderr() { return stderrText; }, get spawnError() { return spawnError; } };
}

function mkRuntime(cwd) {
  return { getCurrentCwd: () => cwd };
}

(async () => {
  const { createSkills } = await import('../server/skills.js');

  const PI_BIN = process.env.PI_BIN || 'pi';
  console.log('pi 可执行文件：' + PI_BIN);
  console.log('临时世界：' + TMP);

  /* ---------- 世界：一份固定的 skill 布局，四个场景共用 ---------- */
  const w = mkWorld('main');
  writeSkill(path.join(w.agent, 'skills'), 'u-one', 'USER-ONE');
  writeSkill(path.join(w.agent, 'skills'), 'u-two', 'USER-TWO');
  writeSkill(path.join(w.agent, 'skills'), 'clash-skill', 'CLASH from USER');
  writeSkill(path.join(w.home, '.agents', 'skills'), 'ua-one', 'AGENTS-ONE');
  writeSkill(path.join(w.proj, '.pi', 'skills'), 'p-one', 'PROJECT-ONE');
  const projClashFile = writeSkill(path.join(w.proj, '.pi', 'skills'), 'clash-skill', 'CLASH from PROJECT');
  const userClashFile = path.join(w.agent, 'skills', 'clash-skill', 'SKILL.md');

  const baseEnv = {
    ...process.env,
    HOME: w.home,
    USERPROFILE: w.home,
    PI_CODING_AGENT_DIR: w.agent,
    PI_NO_CONTINUE: '1',
    PI_BIN,
  };

  /** Pi GUI 侧的判定 —— 用同一个 pi 进程当 rpc，两边看的是同一份事实。 */
  async function guiIndex(pi, approve = null) {
    const mod = createSkills({
      runtime: mkRuntime(w.proj),
      rpc: { request: (cmd) => pi.request(cmd) },
      env: baseEnv,
      homeDir: w.home,
      approve,
    });
    return mod.readIndex();
  }

  /* ================= L1. 默认（项目未被信任） ================= */
  section('L1. 默认启动：项目级 skill 不加载');

  let pi = startPi({ cwd: w.proj, env: baseEnv, args: [] });
  {
    const r = await pi.waitForSkills();
    if (r.error) {
      console.log('  !! 无法与 pi 通信：' + r.error);
      console.log('     stderr: ' + pi.stderr.slice(0, 400));
      pi.stop();
      cleanup();
      console.log('\n0 passed, 0 failed（跳过：本机 pi 起不来）');
      return;
    }
    const names = r.skills;
    check('L1.1. 真实 pi 发现了用户级 skill（agent/skills + ~/.agents/skills）', () =>
      (names.has('u-one') && names.has('u-two') && names.has('ua-one')) || [...names].join(','));
    check('L1.2. 项目级 skill p-one **没有**被加载（非交互模式未信任项目）', () => !names.has('p-one') || [...names].join(','));
    check('L1.3. clash-skill 加载的是 USER 那一份（项目那份没进来）', () => {
      const cmd = (r.raw.commands || []).find((c) => c.name === 'skill:clash-skill');
      return (cmd && cmd.description === 'CLASH from USER') || JSON.stringify(cmd && cmd.description);
    });
    check('L1.4. get_commands 里每条 skill 都带 sourceInfo.path（这是按路径配对的前提）', () => {
      const cmd = (r.raw.commands || []).find((c) => c.name === 'skill:u-one');
      return (cmd && cmd.sourceInfo && typeof cmd.sourceInfo.path === 'string' && cmd.sourceInfo.path.length > 0) || JSON.stringify(cmd && cmd.sourceInfo);
    });
    check('L1.5. sourceInfo 的五个字段齐全（path/source/scope/origin/baseDir）', () => {
      const cmd = (r.raw.commands || []).find((c) => c.name === 'skill:u-one');
      const si = (cmd && cmd.sourceInfo) || {};
      return (['path', 'source', 'scope', 'origin', 'baseDir'].every((k) => k in si)) || JSON.stringify(si);
    });

    // Pi GUI 侧的判定必须和 pi 的实际加载集一致
    const idx = await guiIndex(pi, null);
    const by = (n) => idx.skills.find((s) => s.name === n);
    check('L1.6. Pi GUI 报 piReachable=true 且 loaded 与 get_commands 一致', () => {
      const agree = ['u-one', 'u-two', 'ua-one'].every((n) => by(n).loaded === true) && by('p-one').loaded === false;
      return (idx.piReachable === true && agree) || JSON.stringify(idx.skills.map((s) => [s.name, s.loaded]));
    });
    check('L1.7. Pi GUI 把 p-one 标成 untrusted（不是 enabled）', () => by('p-one').state === 'untrusted' || by('p-one').state);
    check('L1.8. Pi GUI 的 trust 结论是「未信任」', () => (idx.trust.trusted === false && idx.trust.requiresTrust === true) || JSON.stringify(idx.trust));
    check('L1.9. Pi GUI 也认得出 clash-skill 的 user 那份是生效的', () => {
      const u = idx.skills.find((s) => s.name === 'clash-skill' && s.scope === 'user');
      return (u && u.state === 'enabled') || JSON.stringify(u && u.state);
    });
    check('L1.10. 用户级 skill 的 disablePattern 带 skills/ 前缀', () =>
      by('u-one').disablePattern === '-skills/u-one/SKILL.md' || by('u-one').disablePattern);
  }
  pi.stop();

  /* ================= L2. --approve：项目级进来，同名项目胜 ================= */
  section('L2. --approve：项目级加载 + 同名冲突项目胜出');

  pi = startPi({ cwd: w.proj, env: baseEnv, args: ['--approve'] });
  {
    const r = await pi.waitForSkills();
    check('L2.1. --approve 之后项目级 p-one 被加载', () => (r.skills && r.skills.has('p-one')) || JSON.stringify(r.error || [...(r.skills || [])]));
    check('L2.2. 同名冲突：加载的是 PROJECT 那一份（项目级胜出）', () => {
      const cmd = ((r.raw || {}).commands || []).find((c) => c.name === 'skill:clash-skill');
      return (cmd && cmd.description === 'CLASH from PROJECT') || JSON.stringify(cmd && cmd.description);
    });
    check('L2.3. pi 报的 clash-skill 路径就是项目文件', () => {
      const cmd = ((r.raw || {}).commands || []).find((c) => c.name === 'skill:clash-skill');
      const p = cmd && cmd.sourceInfo && cmd.sourceInfo.path;
      return (p && path.resolve(p).toLowerCase() === path.resolve(projClashFile).toLowerCase()) || p;
    });

    const idx = await guiIndex(pi, true);
    const by = (n, scope) => idx.skills.find((s) => s.name === n && (!scope || s.scope === scope));
    check('L2.4. Pi GUI 报 trust.trusted=true / reason=approve-flag', () =>
      (idx.trust.trusted === true && idx.trust.reason === 'approve-flag') || JSON.stringify(idx.trust));
    check('L2.5. Pi GUI 把项目那份 clash 标成 enabled、user 那份标成 shadowed', () => {
      const proj = by('clash-skill', 'project');
      const user = by('clash-skill', 'user');
      return (proj.state === 'enabled' && user.state === 'shadowed') || JSON.stringify({ proj: proj.state, user: user.state });
    });
    check('L2.6. shadowed 那条的 shadowedBy 指向项目文件（这是按路径配对的成果）', () => {
      const user = by('clash-skill', 'user');
      return (user.shadowedBy && path.resolve(user.shadowedBy).toLowerCase() === path.resolve(projClashFile).toLowerCase()) || user.shadowedBy;
    });
    check('L2.7. shadowed 那条的描述用磁盘上的 USER 版本（不张冠李戴）', () => {
      const user = by('clash-skill', 'user');
      return user.description === 'CLASH from USER' || user.description;
    });
    check('L2.8. 项目那份 clash 的描述来自 pi 报的项目版本', () => by('clash-skill', 'project').description === 'CLASH from PROJECT' || by('clash-skill', 'project').description);
    check('L2.9. p-one 现在是 enabled（不再 untrusted）', () => by('p-one').state === 'enabled' || by('p-one').state);
  }
  pi.stop();

  /* ================= L3. 改 settings 必须重启才生效 ================= */
  section('L3. 改 settings.json 不会热加载（restartRequired 的依据）');

  pi = startPi({ cwd: w.proj, env: baseEnv, args: ['--approve'] });
  {
    const before = await pi.waitForSkills();
    check('L3.1. 重启前 u-one 已加载', () => (before.skills && before.skills.has('u-one')) || JSON.stringify(before.error || [...(before.skills || [])]));

    // 在 pi 运行期间改 settings —— 这正是 Pi GUI 的 PUT /api/skills 会做的事
    writeSettings(path.join(w.agent, 'settings.json'), { skills: ['-skills/u-one/SKILL.md'] });
    await sleep(3000);
    const after = await pi.waitForSkills({ maxMs: 20000 });
    check('L3.2. 改完 settings 但**不重启** → u-one 仍然在（pi 没有文件监听）', () =>
      (after.skills && after.skills.has('u-one')) || JSON.stringify([...(after.skills || [])]));

    // Pi GUI 的判定会「看到」这条停用规则（它读磁盘），但会如实说需要重启
    const idx = await guiIndex(pi, true);
    const uOne = idx.skills.find((s) => s.name === 'u-one');
    check('L3.3. Pi GUI 同时报出「被 settings 关掉」与「pi 还加载着」两个事实', () =>
      (uOne.state === 'disabled' && uOne.disabledBy === '-skills/u-one/SKILL.md' && uOne.loaded === true) ||
      JSON.stringify({ state: uOne.state, by: uOne.disabledBy, loaded: uOne.loaded }));
  }
  pi.stop();

  pi = startPi({ cwd: w.proj, env: baseEnv, args: ['--approve'] });
  {
    const restarted = await pi.waitForSkills();
    check('L3.4. 重启 pi 之后 u-one 真的消失了（停用生效）', () =>
      (restarted.skills && !restarted.skills.has('u-one')) || JSON.stringify([...(restarted.skills || [])]));
    check('L3.5. 其它 skill 不受影响（u-two / ua-one / p-one 仍在）', () =>
      (restarted.skills && restarted.skills.has('u-two') && restarted.skills.has('ua-one') && restarted.skills.has('p-one')) ||
      JSON.stringify([...(restarted.skills || [])]));

    const idx = await guiIndex(pi, true);
    const uOne = idx.skills.find((s) => s.name === 'u-one');
    check('L3.6. 重启后 Pi GUI 报 state=disabled（两边终于一致）', () =>
      (uOne.state === 'disabled' && uOne.loaded === false) || JSON.stringify({ state: uOne.state, loaded: uOne.loaded }));
  }
  pi.stop();

  /* ================= L4. 停用语法 + enableSkillCommands ================= */
  section('L4. 停用语法（带 skills/ 前缀 vs 裸名字）与 enableSkillCommands');

  writeSettings(path.join(w.agent, 'settings.json'), {
    // 正确的写法：相对 baseDir（这里是 agentDir）的 posix 路径
    skills: ['-skills/u-one/SKILL.md', '-u-two', '!ua-one'],
    // 关掉 skill 命令注册 —— 用来验证 get_commands 仍然返回（可以当权威来源）
    enableSkillCommands: false,
  });

  pi = startPi({ cwd: w.proj, env: baseEnv, args: ['--approve'] });
  {
    const r = await pi.waitForSkills();
    check('L4.1. `-skills/u-one/SKILL.md`（带前缀）→ u-one 被关掉', () =>
      (r.skills && !r.skills.has('u-one')) || JSON.stringify([...(r.skills || [])]));
    check('L4.2. `-u-two`（裸名字）→ **无效**，u-two 仍然加载（这是最容易踩的坑）', () =>
      (r.skills && r.skills.has('u-two')) || JSON.stringify([...(r.skills || [])]));
    check('L4.3. `!ua-one`（glob）→ ua-one 被关掉', () =>
      (r.skills && !r.skills.has('ua-one')) || JSON.stringify([...(r.skills || [])]));
    check('L4.4. enableSkillCommands=false 时 get_commands **仍然返回** skill（可当权威来源）', () =>
      (r.skills && r.skills.size > 0) || JSON.stringify([...(r.skills || [])]));

    const idx = await guiIndex(pi, true);
    const by = (n) => idx.skills.find((s) => s.name === n);
    check('L4.5. Pi GUI 判定与真实加载集一致：u-one disabled / u-two enabled / ua-one disabled', () => {
      const got = { 'u-one': by('u-one').state, 'u-two': by('u-two').state, 'ua-one': by('ua-one').state };
      return (got['u-one'] === 'disabled' && got['u-two'] === 'enabled' && got['ua-one'] === 'disabled') || JSON.stringify(got);
    });
    check('L4.6. ua-one 是被 glob 关掉的，disabledBy 如实报出 `!ua-one`', () => by('ua-one').disabledBy === '!ua-one' || by('ua-one').disabledBy);
  }
  pi.stop();

  /* ================= L5. --no-skills ================= */
  section('L5. --no-skills 关掉全部发现');

  pi = startPi({ cwd: w.proj, env: baseEnv, args: ['--no-skills'] });
  {
    const r = await pi.waitForSkills();
    check('L5.1. --no-skills → get_commands 里一个 skill 都没有', () =>
      (r.skills && r.skills.size === 0) || JSON.stringify([...(r.skills || [])]));
  }
  pi.stop();

  /* ---------- 收尾 ---------- */
  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
})().catch((err) => {
  console.error('\n测试自身崩了：', err);
  cleanup();
  process.exitCode = 1;
});
