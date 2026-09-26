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
 *   3. **令牌不能进 pi 的环境**（见 spawnPi 的说明）。
 *
 * 除了 fire-and-forget 的 send()，这里还提供 request()：把命令发出去并等它那条
 * 应答。pi 的应答信封是 `{ id, type:"response", command, success, data }` ——
 * **id 会原样回显**，所以按 id 配对是可靠的。需要它的场景是后端自己要读 pi 的
 * 权威状态（例如 server/skills.js 用 `get_commands` 拿「pi 实际加载了哪些 skill」）。
 * 注意 request() 不影响 SSE：同一条应答仍然照常 publish 给前端。
 */
import { spawn } from 'node:child_process';

/** 崩溃后自动重启的延迟。 */
const RESTART_DELAY_MS = 1200;

/** request() 的默认超时。pi 冷启动约 20 秒，但 request() 只在 pi 已经起来之后才用，
 *  所以这里给 10 秒足够；超时返回 null 而不是抛错，让调用方自己降级。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

/**
 * @param runtime       共享运行态（要 cwd）。只读，不改。
 * @param publish       事件出口（SSE 总线的 publish）。
 * @param piBin         pi 可执行文件（默认 'pi'，可用 PI_BIN 覆盖）。
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
  isWin,
  env = process.env,
  projectLaunch = null,
  compat = null,
  spawnProcess = spawn,
  restartDelayMs = RESTART_DELAY_MS,
}) {
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
   * 改成按 Node 文档认可的方式自己拼一条命令字符串 —— 实测不再报警告。 */
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

    if (!isWin) return spawnProcess(bin, args, opts);

    // 参数都是命令行开关和模型名，不含引号；万一有就剔掉，避免把命令拼坏
    const q = (s) => `"${String(s).replace(/"/g, '')}"`;
    return spawnProcess([bin, ...args].map(q).join(' '), { ...opts, shell: true });
  }

  function start() {
    if (runtime.isShuttingDown() || pi) return;
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
    publish({ type: 'bridge_status', state: 'starting', bin: piBin, args, cwd, bridgeRun: run });

    let child;
    try {
      child = spawnPi(piBin, args);
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
      if (!runtime.getCurrentCwd() || restartRequested || !pi || !pi.stdin || pi.stdin.destroyed) {
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
    };
  }

  return { start, send, request, restart, stop, getState, buildArgs };
}
