/* pi 子进程桥接。
 *
 * 职责：spawn `pi --mode rpc`、解析它的 stdout JSONL、把命令写进 stdin、
 * 崩溃后自动重启、收尾时关掉。
 *
 * 协议要点（摘自 pi 官方 docs/rpc.md）：
 *   - 严格 JSONL：记录分隔符只有 LF。官方明确警告不能用 Node 的 readline，
 *     因为它还会在 U+2028 / U+2029 处切分，而这两个字符在 JSON 字符串里是合法的。
 *   - 命令：每行一个 JSON 对象写进 stdin
 *   - 事件：每行一个 JSON 对象从 stdout 出来
 *
 * 三件事很容易在重构时改坏，这里逐条钉住：
 *   1. **只按 LF 切分**，不用 readline，不碰 U+2028 / U+2029。
 *   2. **Windows 上经 shell 启动**（pi 是 npm 的 .cmd 包装脚本），且自己拼命令串，
 *      不用 spawn(..., {shell:true}) —— 后者会触发 DEP0190 刷弃用警告。
 *      命令串的成形在 `server/pi-launch.js` 的 `formatLaunch()` —— **与 `--version`
 *      探测共用同一份**，所以「启动命令」和「版本探测命令」不可能各拼各的。
 *   3. **令牌不能进 pi 的环境**（见 spawnPi 的说明）。
 *
 * 除了 fire-and-forget 的 send()，这里还提供 request()：把命令发出去并等它那条
 * 应答。pi 的应答信封是 `{ id, type:"response", command, success, data }` ——
 * **id 会原样回显**，所以按 id 配对是可靠的。需要它的场景是后端自己要读 pi 的
 * 权威状态（例如 server/skills.js 用 `get_commands` 拿「pi 实际加载了哪些 skill」）。
 * 注意 request() 不影响 SSE：同一条应答仍然照常 publish 给前端。
 */
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { formatLaunch } from './pi-launch.js';

/** 崩溃后自动重启的延迟。 */
const RESTART_DELAY_MS = 1200;

/** request() 的默认超时。pi 冷启动约 20 秒，但 request() 只在 pi 已经起来之后才用，
 *  所以这里给 10 秒足够；超时返回 null 而不是抛错，让调用方自己降级。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

/**
 * @param runtime       共享运行态（要 cwd）。只读，不改。
 * @param publish       事件出口（SSE 总线的 publish）。
 * @param piBin         pi 可执行文件（默认 'pi'，可用 PI_BIN 覆盖）。
 * @param launch        **launch identity**（`server/pi-launch.js` 的 `identity()`）。
 *                      传了就以它的 `bin` 为准 —— 这样「bridge 真正 spawn 的那个命令」
 *                      与「version / built-in / MCP 探测用的那份 identity」是**同一个对象**，
 *                      不可能各走各的解析路径（P20.5 Blocker A）。缺省退回 `piBin`。
 * @param isWin         是否 Windows。显式传入而不是自己判断平台 —— 便于单测。
 * @param env           环境变量来源，默认 process.env。单测可以注入。
 * @param projectLaunch 项目配置贡献的启动参数（可选）。**刻意只认两个方法**，
 *                      为的是把「有副作用」和「纯读」分开：
 *                        - prepareLaunch() 允许写磁盘（同步项目指令文件），
 *                          每次 spawn 前调用一次；
 *                        - launchArgs() 必须是纯读，getState / 启动日志会反复调用。
 *                      两者都返回 { args: string[], warnings: string[] }。
 *                      默认 null —— 不传时行为与没有项目配置时完全一致。
 *
 *                      注意本模块**不**知道项目配置里有什么。哪些参数能安全地
 *                      当启动参数传（以及为什么模型不能）是 project-config 的判断，
 *                      见那里的 launchArgs 说明。
 */
export function createRpcBridge({
  runtime,
  publish,
  piBin,
  launch = null,
  isWin,
  env = process.env,
  projectLaunch = null,
  compat = null,
  spawnProcess = spawn,
  restartDelayMs = RESTART_DELAY_MS,
}) {
  /* 实际启动命令：launch identity 优先，`piBin` 只是缺省（老调用方 / 单测）。
   * 这是「bridge spawn 的那个东西」的唯一取值处 —— 下面不再出现第二个来源。 */
  const launchBin = (launch && typeof launch.bin === 'string' && launch.bin) ? launch.bin : piBin;
  /* 事件里能露出去的只有 basename（见 start() 里的说明）。 */
  const binLabel = (() => {
    try {
      return basename(launchBin) || launchBin;
    } catch {
      return launchBin;
    }
  })();
  /* 兼容层（P4，可选注入）。
   *
   * 它只**观察**，不参与任何判断 —— 桥接的行为一行都不因它改变。
   * 三处喂证据：bridge_status（生命周期）、stdout 上来的每一条消息
   * （信封 / 能力 / 未知事件）、以及解析失败的那一行。
   * 全部包在 try 里：兼容层自己出问题绝不能影响 pi 的正常工作。 */
  function observeCompat(fn) {
    if (!compat) return;
    try {
      fn(compat);
    } catch {
      /* 观察失败就当没看见 —— 它只是个旁路 */
    }
  }

  /* 所有往外发的事件都从这里过一遍。
   * 这样不必在十来个 publish 调用点各加一行（那种改法以后新加一处就会漏）。 */
  const rawPublish = publish;
  publish = (evt) => {
    if (evt && evt.type === 'bridge_status') observeCompat((c) => c.observeBridge(evt));
    rawPublish(evt);
  };

  let pi = null;
  let restartTimer = null;
  let restartRequested = false;
  let bridgeRun = 0;
  let crashStreak = 0;

  /* ---------- 维护暂停（Pi 自更新用） ----------
   *
   * 「更新 Pi」要替换正在运行的 runtime 文件，所以必须先把 bridge 停下来，
   * 而且**停下来的这段时间不能被自动重启逻辑拉起来**。不能借用
   * `runtime.shuttingDown` —— 那个语义是「Pi GUI 正在退出」，而这里是
   * 短时维护，进程还活着、还要 resume。
   *
   * `maintenance` 非 null 时：
   *   - start() 直接返回（不会拉起新 child）
   *   - send() 抛「维护中」、request() 直接回 null（不再接受新命令）
   *   - restart() 变成空操作（用户点重启不该插进维护流程）
   *   - child exit **不进** 自动重启分支，也不动 crashStreak（维护不是崩溃）
   * resume 之后一切回到原样，start() 只被调用一次。 */
  let maintenance = null; // { reason, at } | null
  /* kill 是异步的：resume 可能早于 exit 回调到达。这时标记一下，
   * 由 onStopped 的维护分支负责真正启动 —— 保证「只启动一次」。 */
  let resumeRequested = false;

  /* 挂起的请求：id → { resolve, timer }。
   *
   * id 由本模块自己发号（从 1 递增），与前端发命令用的 id 空间**不重叠**
   * 是不必要的 —— pi 只是原样回显，本模块只认自己发出去的那些 id。
   * 真正需要防的是「同一时刻有多条 request 在等」，所以用 Map 而不是单变量。 */
  const pending = new Map();
  let nextRequestId = 1;

  /** 结束所有挂起请求（超时/退出/重启时用）。reason 只用于内部排查，不外发。 */
  function settleAllPending(value) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve(value);
    }
    pending.clear();
  }

  /** 项目配置贡献的参数。纯读，失败不抛（拿不到就当没有）。 */
  function projectArgs() {
    if (!projectLaunch || typeof projectLaunch.launchArgs !== 'function') return [];
    try {
      const r = projectLaunch.launchArgs();
      return (r && r.args) || [];
    } catch {
      return [];
    }
  }

  /** pi 的启动参数。extra 用来复用「spawn 前刚算好的那份」，避免算两次。 */
  function buildArgs(extra = null) {
    const args = ['--mode', 'rpc'];
    // --continue 恢复该 cwd 下最近的会话；实测在没有历史的目录下也不会报错，会正常新建
    if (env.PI_NO_CONTINUE !== '1') args.push('--continue');
    if (env.PI_PROVIDER) args.push('--provider', env.PI_PROVIDER);
    if (env.PI_MODEL) args.push('--model', env.PI_MODEL);
    if (env.PI_THINKING) args.push('--thinking', env.PI_THINKING);
    if (env.PI_NO_SESSION === '1') args.push('--no-session');
    // 项目配置的参数排在环境变量之后。两者不会互相覆盖：project-config 对
    // 已被环境变量钉住的开关不会再给值（优先级：环境变量 > 项目配置）。
    const tail = extra || projectArgs();
    if (tail.length) args.push(...tail);
    return args;
  }

  /* 拉起 pi 子进程。
   * Windows 上 pi 是 npm 的 .cmd 包装脚本，必须经 shell 启动；
   * 但 spawn(bin, argsArray, {shell:true}) 会触发 DEP0190
   * （args 只拼接不转义），每次启动刷两行弃用警告，双击启动时看着像报错。
   * 所以成形交给 `formatLaunch()`（Node 文档认可的方式），见文件头第 2 条。 */
  function spawnPi(bin, args) {
    /* 把访问令牌从 pi 的环境里摘掉。
     *
     * pi 自带 bash 工具，环境变量对它（以及它跑的任何命令）都是可读的。
     * 令牌一旦被读进工具输出，就会随对话内容一起进模型上下文 —— 属于
     * 没必要存在的暴露面。pi 本身也不需要这个变量。 */
    const childEnv = { ...env };
    delete childEnv.PI_GUI_TOKEN;

    const opts = {
      cwd: runtime.getCurrentCwd(),
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    };

    const spec = formatLaunch(bin, args, isWin);
    return spawnProcess(spec.command, spec.spawnArgs, { ...opts, shell: spec.shell });
  }

  function start() {
    if (runtime.isShuttingDown() || pi) return;
    /* 维护中不拉起新 child —— resumeFromMaintenance() 才会。 */
    if (maintenance) return;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    /* 新进程的 id 空间是干净的 —— 上一轮挂起的请求不会有应答了，先放掉。
     * （正常路径上 exit 回调已经放过一次，这里是幂等的兜底。） */
    settleAllPending(null);
    /* 没有项目就不启动 pi。
     *
     * pi 的 cwd 只能在启动时确定，没有 cwd 就没有合理的启动参数；
     * 更重要的是：随便挑一个目录当 cwd 会凭空造出一批会话文件，
     * 而且会把那个目录的历史会话显示给用户 —— 正是我们要避免的。
     * 这里只发一个状态，前端据此切到「先添加文件夹」的引导形态。 */
    const cwd = runtime.getCurrentCwd();
    if (!cwd) {
      restartRequested = false;
      publish({ type: 'bridge_status', state: 'no-project' });
      return;
    }
    const run = ++bridgeRun;

    /* 项目配置要先「准备」再取参数。
     *
     * prepareLaunch 会把项目指令同步成一个 pi 能读的文件（那是写磁盘的动作），
     * launchArgs 只做纯读。顺序不能反 —— 反了就会漏掉刚写出来的文件，
     * 表现为「指令保存了但这次启动没生效，下次才生效」。
     *
     * 这一步同时覆盖了「切项目」的场景：projects.activate 先更新 runtime.cwd
     * 再调 restart()，所以这里读到的已经是新项目的配置 —— 不存在
     * 「先按旧项目启动 pi、再改模型、再重启一次」的双重启动。 */
    let extra = [];
    if (projectLaunch && typeof projectLaunch.prepareLaunch === 'function') {
      try {
        const r = projectLaunch.prepareLaunch();
        extra = (r && r.args) || [];
        for (const w of (r && r.warnings) || []) {
          publish({ type: 'project_config_notice', level: 'warn', message: w });
        }
      } catch (err) {
        publish({ type: 'project_config_notice', level: 'warn', message: `项目配置未能应用：${err.message}` });
      }
    }

    const args = buildArgs(extra);
    /* `bin` 只给 basename —— 完整绝对路径（`PI_BIN=C:\...\pi.cmd`）不出后端，
     * renderer 与诊断里都只该看到「哪个入口」，不该看到它装在哪。 */
    publish({ type: 'bridge_status', state: 'starting', bin: binLabel, args, cwd, bridgeRun: run });

    let child;
    try {
      child = spawnPi(launchBin, args);
      pi = child;
    } catch (err) {
      restartRequested = false;
      publish({ type: 'bridge_status', state: 'error', error: String(err.message), cwd, bridgeRun: run });
      return;
    }

    child.on('error', (err) => {
      restartRequested = false;
      publish({
        type: 'bridge_status',
        state: 'error',
        error: `无法启动 pi：${err.message}`,
        hint: '确认 pi 已安装并在 PATH 中，或用环境变量 PI_BIN 指定完整路径。',
        cwd,
        bridgeRun: run,
      });
    });

    let stdoutBuf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (pi !== child) return;
      stdoutBuf += chunk;
      let nl;
      // 只按 LF 切分 —— pi 协议明确要求
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        let line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          observeCompat((c) => c.observeParseError());
          publish({ type: 'bridge_parse_error', raw: line.slice(0, 400) });
          continue;
        }
        /* 兼容层先看一眼上游发了什么 —— 应答与事件都看。
         * **放在配对之前**：后端自己发起的 request 的应答也要被观察到。 */
        observeCompat((c) => c.observeUpstream(msg));
        /* 先看是不是某条挂起请求的应答。
         * 只认 type:"response" 且 id 在 pending 里 —— 事件（type 不是 response）
         * 和别人的应答都直接落到下面的 publish。 */
        if (msg && msg.type === 'response' && pending.has(msg.id)) {
          const entry = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(entry.timer);
          entry.resolve(msg.success === false ? { __error: msg.error || '命令失败' } : (msg.data ?? {}));
        }
        publish({ ...msg, bridgeRun: run, cwd });
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => {
      if (pi !== child) return;
      publish({ type: 'bridge_stderr', text, bridgeRun: run, cwd });
    });

    child.on('spawn', () => {
      if (pi !== child) return;
      restartRequested = false;
      publish({ type: 'bridge_status', state: 'ready', pid: child.pid ?? null, cwd, bridgeRun: run });
    });

    const startedAt = Date.now();
    const onStopped = (code, signal) => {
      if (pi !== child) return;
      pi = null;
      // 进程没了，挂起的请求不可能再有应答 —— 立刻放掉，别让调用方干等到超时
      settleAllPending(null);
      publish({ type: 'bridge_status', state: 'exited', code, signal, cwd, bridgeRun: run });
      /* 维护分支：**不自动重启，也不动 crashStreak**。
       * 维护是刻意停机，不是崩溃 —— 走得越少，越不会把 backoff 状态搞脏。 */
      if (maintenance) {
        publish({
          type: 'bridge_status',
          state: 'maintenance',
          phase: 'stopped',
          reason: maintenance.reason,
          cwd,
          bridgeRun: run,
        });
        if (resumeRequested) {
          resumeRequested = false;
          start();
        }
        return;
      }
      if (!runtime.isShuttingDown()) {
        const deliberate = restartRequested;
        crashStreak = deliberate || Date.now() - startedAt >= 5000 ? 0 : crashStreak + 1;
        const delay = deliberate ? 0 : Math.min(restartDelayMs * 2 ** Math.max(0, crashStreak - 1), 30000);
        restartRequested = false;
        restartTimer = setTimeout(() => {
          restartTimer = null;
          start();
        }, delay);
      }
    };
    child.on('exit', onStopped);
    // spawn ENOENT 只有 error + close，没有 exit；否则 pi 会永远卡在非空的旧 child。
    child.on('close', onStopped);
  }

  /** 把一条命令写进 pi 的 stdin。 */
  function send(cmd) {
    // 没项目时给出可执行的指引，别只说「子进程未运行」—— 用户会以为是崩溃
    if (!runtime.getCurrentCwd()) {
      throw new Error('还没有选择项目：先在左侧「添加文件夹」选一个目录，再发送消息。');
    }
    /* 维护中不接受新命令 —— 否则命令会写进一个正在被替换的 runtime。 */
    if (maintenance) throw new Error('Pi 正在更新，完成后会自动恢复；稍后再试。');
    if (restartRequested) throw new Error('pi 正在重启，请稍后重试');
    if (!pi || !pi.stdin || pi.stdin.destroyed) {
      throw new Error('pi 子进程未运行');
    }
    if (cmd.__bridgeRun != null && cmd.__bridgeRun !== bridgeRun) {
      throw new Error('项目已切换，请在当前项目重试此操作');
    }
    const { __bridgeRun, ...wireCommand } = cmd;
    pi.stdin.write(JSON.stringify(wireCommand) + '\n');
  }

  /* 发一条命令并等它的应答。**永不 reject**，失败一律回 null ——
   * 调用方（如 /api/skills）要的是「拿不到就降级」，不是让一个读接口抛 500。
   *
   * 返回：成功 → pi 应答里的 data 对象（无 data 时是 {}）；
   *       pi 明确报错 → { __error: "..." }（调用方自己决定要不要展示）；
   *       超时 / 子进程没起来 / 进程退出 → null。
   *
   * 注意这里**不**校验 cmd.id —— 由本模块发号，调用方传的 id 会被覆盖。 */
  function request(cmd, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
      if (!runtime.getCurrentCwd() || restartRequested || maintenance || !pi || !pi.stdin || pi.stdin.destroyed) {
        resolve(null);
        return;
      }
      const id = nextRequestId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, timeoutMs);
      // timer.unref() 让一个挂起的请求不会拖住进程退出
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(id, { resolve, timer });
      try {
        pi.stdin.write(JSON.stringify({ ...cmd, id }) + '\n', (err) => {
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

  /** 重启 pi 子进程 —— 用于让它重新读取 ~/.pi/agent/models.json */
  function restart() {
    /* 维护期间用户点「重启 Pi」不该插进维护流程：更新完成后会自己 resume。 */
    if (maintenance) return;
    // 重启等于把挂起请求的应答机会掐掉，先放掉再动进程
    settleAllPending(null);
    if (pi) {
      if (restartRequested) return;
      restartRequested = true;
      publish({ type: 'bridge_status', state: 'restarting', reason: 'reload-config', bridgeRun, cwd: runtime.getCurrentCwd() });
      try {
        pi.stdin.end();
      } catch {
        /* noop */
      }
      try {
        pi.kill();
      } catch {
        /* noop */
      }
      // exit 回调里会自动重新拉起
    } else {
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      restartRequested = true;
      start();
    }
  }

  /** 收尾时关掉子进程。不触发自动重启（shuttingDown 由 runtime 表达）。 */
  function stop() {
    settleAllPending(null);
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (!pi) return;
    try {
      pi.stdin.end();
    } catch {
      /* noop */
    }
    try {
      pi.kill();
    } catch {
      /* noop */
    }
  }

  /* ---------- 维护暂停 / 恢复（Pi 自更新专用） ---------- */

  /**
   * 暂停 bridge，等当前 pi 子进程真的退出。
   *
   * 语义（Pi 更新流程依赖这几条，改动前先读文件头那段说明）：
   *   - 不再接受新命令（send 抛、request 回 null）
   *   - 挂起请求立刻安全 settle（不会有人干等到超时）
   *   - 当前 child 退出，**且 exit 回调不自动重启**
   *   - 发布 `bridge_status{state:'maintenance', phase:'pausing'|'stopped'}`
   *   - crashStreak 原样保留（维护不是崩溃）
   *
   * **防重复/嵌套**：已经在维护中就直接回 `{ok:false, code:'already-in-maintenance'}`。
   * 调用方（`server/pi-update.js`）也有一把自己的锁，两层都不允许并发的维护。
   *
   * @returns {Promise<{ok:boolean, code?:string, stopped?:boolean}>} 进程已退出才 resolve
   */
  function pauseForMaintenance(reason = 'pi-update') {
    if (maintenance) return Promise.resolve({ ok: false, code: 'already-in-maintenance' });
    const cwd = runtime.getCurrentCwd();
    maintenance = { reason: String(reason).slice(0, 80), at: Date.now() };
    resumeRequested = false;
    // 挂起请求先放掉：维护期间不可能再有应答
    settleAllPending(null);
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    publish({
      type: 'bridge_status',
      state: 'maintenance',
      phase: 'pausing',
      reason: maintenance.reason,
      cwd,
      bridgeRun,
    });

    /* 没有 child（本来就没起来 / 没有项目）→ 已经处于「停着」的状态。
     * 这时 start() 已经被 maintenance 挡住，直接算停好了。 */
    if (!pi) return Promise.resolve({ ok: true, stopped: false });

    const child = pi;
    return new Promise((resolve) => {
      let done = false;
      const finish = (stopped) => {
        if (done) return;
        done = true;
        resolve({ ok: true, stopped });
      };
      /* 以 exit 为准。给一个兜底定时器：万一 exit 事件丢了（子进程已经被
       * 别的东西收走），也不能把更新流程永久卡死。 */
      const timer = setTimeout(() => finish(true), 10000);
      if (typeof timer.unref === 'function') timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        finish(true);
      });
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
    });
  }

  /**
   * 维护结束，恢复正常启动。**只启动一次**：
   *   - 不在维护中 → `{ok:false, code:'not-paused'}`（不会顺手把 pi 拉起来）
   *   - kill 是异步的、exit 还没到 → 交给 onStopped 的维护分支去 start
   * 失败路径也必须调它（见 pi-update 的 finally），否则 GUI 会永久停在维护态。
   */
  function resumeFromMaintenance() {
    if (!maintenance) return { ok: false, code: 'not-paused' };
    maintenance = null;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (pi) {
      // 进程还在：等它退出的那个回调来启动（onStopped 里看 resumeRequested）
      resumeRequested = true;
      return { ok: true, deferred: true };
    }
    resumeRequested = false;
    start();
    return { ok: true, deferred: false };
  }

  /** 维护中？给 /api/status、诊断与前端状态条用。 */
  function maintenanceState() {
    return maintenance ? { reason: maintenance.reason, at: maintenance.at } : null;
  }

  /** /api/status 要的那几个字段。
   * args 每次现算（含项目配置贡献的那部分），与启动时一致 —— 除非两次之间
   * 用户改了项目配置，那种情况下这里给的是「按当前配置启动会是哪些参数」，
   * 也正是界面该显示的。 */
  function getState() {
    const cwd = runtime.getCurrentCwd();
    return {
      piRunning: Boolean(pi),
      pid: pi?.pid ?? null,
      bridgeRun,
      args: buildArgs(),
      cwd,
      // 前端用它决定「显示引导还是显示输入框」。cwd 为空就等价于没有项目，
      // 但显式给一个字段更不容易被将来的改动弄丢。
      hasProject: Boolean(cwd),
      /* 维护态必须能从轮询里看出来：SSE 不重放，刷新页面之后前端就只剩
       * 这一个来源了（否则界面会显示成「pi 未运行」）。 */
      maintenance: maintenanceState(),
    };
  }

  return { start, send, request, restart, stop, getState, buildArgs, pauseForMaintenance, resumeFromMaintenance, maintenanceState };
}
