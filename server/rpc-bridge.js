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
 */
import { spawn } from 'node:child_process';

/** 崩溃后自动重启的延迟。 */
const RESTART_DELAY_MS = 1200;

/**
 * @param runtime     共享运行态（要 cwd）。只读，不改。
 * @param publish     事件出口（SSE 总线的 publish）。
 * @param piBin       pi 可执行文件（默认 'pi'，可用 PI_BIN 覆盖）。
 * @param isWin       是否 Windows。显式传入而不是自己判断平台 —— 便于单测。
 * @param env         环境变量来源，默认 process.env。单测可以注入。
 */
export function createRpcBridge({ runtime, publish, piBin, isWin, env = process.env }) {
  let pi = null;
  let stdoutBuf = '';

  /** pi 的启动参数。 */
  function buildArgs() {
    const args = ['--mode', 'rpc'];
    // --continue 恢复该 cwd 下最近的会话；实测在没有历史的目录下也不会报错，会正常新建
    if (env.PI_NO_CONTINUE !== '1') args.push('--continue');
    if (env.PI_PROVIDER) args.push('--provider', env.PI_PROVIDER);
    if (env.PI_MODEL) args.push('--model', env.PI_MODEL);
    if (env.PI_THINKING) args.push('--thinking', env.PI_THINKING);
    if (env.PI_NO_SESSION === '1') args.push('--no-session');
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

    if (!isWin) return spawn(bin, args, opts);

    // 参数都是命令行开关和模型名，不含引号；万一有就剔掉，避免把命令拼坏
    const q = (s) => `"${String(s).replace(/"/g, '')}"`;
    return spawn([bin, ...args].map(q).join(' '), { ...opts, shell: true });
  }

  function start() {
    /* 没有项目就不启动 pi。
     *
     * pi 的 cwd 只能在启动时确定，没有 cwd 就没有合理的启动参数；
     * 更重要的是：随便挑一个目录当 cwd 会凭空造出一批会话文件，
     * 而且会把那个目录的历史会话显示给用户 —— 正是我们要避免的。
     * 这里只发一个状态，前端据此切到「先添加文件夹」的引导形态。 */
    const cwd = runtime.getCurrentCwd();
    if (!cwd) {
      publish({ type: 'bridge_status', state: 'no-project' });
      return;
    }

    const args = buildArgs();
    publish({ type: 'bridge_status', state: 'starting', bin: piBin, args, cwd });

    try {
      pi = spawnPi(piBin, args);
    } catch (err) {
      publish({ type: 'bridge_status', state: 'error', error: String(err.message) });
      return;
    }

    pi.on('error', (err) => {
      publish({
        type: 'bridge_status',
        state: 'error',
        error: `无法启动 pi：${err.message}`,
        hint: '确认 pi 已安装并在 PATH 中，或用环境变量 PI_BIN 指定完整路径。',
      });
    });

    pi.stdout.setEncoding('utf8');
    pi.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let nl;
      // 只按 LF 切分 —— pi 协议明确要求
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        let line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line) continue;
        try {
          publish(JSON.parse(line));
        } catch {
          publish({ type: 'bridge_parse_error', raw: line.slice(0, 400) });
        }
      }
    });

    pi.stderr.setEncoding('utf8');
    pi.stderr.on('data', (text) => {
      publish({ type: 'bridge_stderr', text });
    });

    pi.on('spawn', () => {
      publish({ type: 'bridge_status', state: 'ready', pid: pi?.pid ?? null });
    });

    pi.on('exit', (code, signal) => {
      pi = null;
      stdoutBuf = '';
      publish({ type: 'bridge_status', state: 'exited', code, signal });
      if (!runtime.isShuttingDown()) {
        setTimeout(start, RESTART_DELAY_MS);
      }
    });
  }

  /** 把一条命令写进 pi 的 stdin。 */
  function send(cmd) {
    // 没项目时给出可执行的指引，别只说「子进程未运行」—— 用户会以为是崩溃
    if (!runtime.getCurrentCwd()) {
      throw new Error('还没有选择项目：先在左侧「添加文件夹」选一个目录，再发送消息。');
    }
    if (!pi || !pi.stdin || pi.stdin.destroyed) {
      throw new Error('pi 子进程未运行');
    }
    pi.stdin.write(JSON.stringify(cmd) + '\n');
  }

  /** 重启 pi 子进程 —— 用于让它重新读取 ~/.pi/agent/models.json */
  function restart() {
    if (pi) {
      publish({ type: 'bridge_status', state: 'restarting', reason: 'reload-config' });
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
      start();
    }
  }

  /** 收尾时关掉子进程。不触发自动重启（shuttingDown 由 runtime 表达）。 */
  function stop() {
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

  /** /api/status 要的那几个字段。args 每次现算，与启动时保持一致。 */
  function getState() {
    const cwd = runtime.getCurrentCwd();
    return {
      piRunning: Boolean(pi),
      pid: pi?.pid ?? null,
      args: buildArgs(),
      cwd,
      // 前端用它决定「显示引导还是显示输入框」。cwd 为空就等价于没有项目，
      // 但显式给一个字段更不容易被将来的改动弄丢。
      hasProject: Boolean(cwd),
    };
  }

  return { start, send, restart, stop, getState, buildArgs };
}
