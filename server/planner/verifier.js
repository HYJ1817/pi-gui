/* 独立验证执行器（P9）。
 *
 * ---------- 它存在的理由 ----------
 *
 * P8 之前，「验证结果」那一行永远写着「尚未独立确认」—— 因为 Pi GUI **从不**
 * 自己跑验证：它只显示 Agent 自己声称的结论，而「Agent 说 tests passed」
 * 不构成证据。P9 把这一格补上：用户可以对**某一次已经结束的 Attempt**
 * 明确点一次「运行验证」，由 Pi GUI 自己执行那次 Attempt 当初冻结的
 * `verificationSnapshot.command`，并把机器真实跑出来的结果写回那条 Attempt。
 *
 *     要求   verificationSnapshot   这次 Attempt 开始时**要求**验证什么（冻结）
 *     证据   verificationResult     Pi GUI **真的执行过什么**、结果如何
 *
 * ---------- 四条不能破的规则 ----------
 *
 * 1. **只跑冻结的要求。** 命令只从 `attempt.verificationSnapshot.command` 来。
 *    没有快照（或只有 description）就**不跑** —— 绝不拿当前 `task.verification`
 *    冒充历史要求，也绝不由 description 猜一条命令出来。
 *
 * 2. **验证只写验证。** 不碰 `task.status`、不碰 `review`、不触发重试、
 *    不自动 accepted。验证通过也不等于人工验收通过 —— 那是人的判断。
 *
 * 3. **写盘只写自己的字段，而且不跨 await。** 每次落盘都是
 *    「重新 load → 只改目标 attempt 的 verificationResult → save」，
 *    全在同一个同步块里。这样既不会把用户刚保存的 Review 冲掉，
 *    也不会把 Scheduler 的执行状态冲掉（见 docs/workflows.md 的字段所有权表）。
 *
 * 4. **同一个 Attempt 同时最多一个验证。** 在内存里按
 *    `planId:taskId:attempt` 记账；落盘的 `running` 只是给界面看的，
 *    **liveness 的唯一权威是这里的 Map**（进程重启后 Map 就空了，
 *    落盘的 running 由 store 的启动恢复翻成 interrupted）。
 *
 * ---------- 执行能力靠注入 ----------
 *
 * 真正的 spawn 在 `server/agents/cli.js`（全项目唯一的 spawn 出口），
 * 而 `server/` 下的模块不许跨目录 import（tests/modules.cjs 的守卫）——
 * 所以这里通过 `runShell` 注入拿执行能力，由 server.js 装配。
 */

import path from 'node:path';
import {
  MAX_VERIFICATION_OUTPUT,
  VERIFICATION_STATUS,
  WORKDIR_SOURCE,
  normalizeVerificationResult,
} from './model.js';
import { resolveProjectPath } from '../../lib/safe-path.js';

/**
 * 验证命令的超时。
 *
 * 比 coding agent 那个 30 分钟短得多：跑一遍测试/构建通常几分钟，
 * 而这是一个**用户主动点击**的动作，卡十分钟没动静比直接说「超时了」更糟。
 */
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 交给 shell 的 stdout 字节上限（**尾部**保留）。
 *
 * 落盘的 `outputSummary` 另有 2000 字符上限（model.js），这才是第一道闸 ——
 * 它挡住的是「后端内存被一条刷屏的命令吃掉」，不需要为了落盘而留全量。
 */
export const DEFAULT_VERIFY_OUTPUT_BYTES = 256 * 1024;

export function createVerifier({
  store,
  runtime,
  scheduler,
  runShell,
  publish = () => {},
  timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_VERIFY_OUTPUT_BYTES,
  now = () => Date.now(),
}) {
  /**
   * 正在跑的验证。key = `planId:taskId:attempt`。
   *
   * **liveness 的权威在这里**，不在磁盘上：磁盘上的 `running` 只表示
   * 「上次写盘时它在跑」，进程崩过之后那是假象（由启动恢复翻成 interrupted）。
   */
  const running = new Map();
  /** 应用正在退出（由 shutdown() 置位）。退出后异步回来的结果不再改状态。 */
  let shuttingDown = false;

  const keyOf = (planId, taskId, attempt) => `${planId}:${taskId}:${attempt}`;

  function emit(planId, taskId, attempt, kind, data = {}) {
    try {
      publish({ type: 'execution_event', planId, taskId, agent: null, kind, timestamp: now(), data: { attempt, ...data } });
    } catch {
      /* 推送失败不能影响执行 */
    }
  }

  /**
   * 重新读盘 → 只改目标 attempt → 落盘。**调用方保证 fn 里没有 await。**
   *
   * 这是这个模块唯一的写路径，也是「不覆盖别人字段」的实现方式：
   * 改的是刚从磁盘读出来的那一份，所以别人（Review API / Scheduler）在这之前
   * 写进去的东西都在里面。`fn` 返回 false 表示「没什么要改的」→ 不落盘。
   *
   * @returns 改动后的 attempt（没找到 / 没改动时返回 null）
   */
  function mutateAttempt(planId, taskId, attempt, fn) {
    const fresh = store.load(planId);
    const plan = fresh ? fresh.plan : null;
    if (!plan) return null;
    const task = (plan.tasks || []).find((x) => x.id === taskId);
    const att = task && (Array.isArray(task.attempts) ? task.attempts : []).find((x) => x.attempt === attempt);
    if (!att) return null;
    if (fn(att, plan) === false) return att;
    store.save(plan);
    return att;
  }

  /** 该 Attempt 现在是不是 Pi GUI 正在跑验证。 */
  function isRunning(planId, taskId, attempt) {
    return running.has(keyOf(planId, taskId, attempt));
  }

  /**
   * 当前有没有正在跑的独立验证 —— **跨所有计划**（P9 收口）。
   *
   * 这是「同一个工作区同一时间只有一个实际执行者」那条规则在 Verifier 这一侧的
   * 权威答案，Scheduler / 路由 / 切项目闸门都读它（由 server.js 注入过去，
   * 谁也不 import 谁）。
   */
  const hasRunning = () => running.size > 0;

  /**
   * 正在跑的那次验证的身份；没有则 null。
   *
   * 给闸门做提示用：「有独立验证正在运行」比「操作被拒绝」有用得多 ——
   * 用户需要知道该去停哪一条。第一阶段只允许一个，所以取第一个就是全部。
   */
  function activeVerification() {
    const first = running.values().next();
    if (first.done) return null;
    const e = first.value;
    return { planId: e.planId, taskId: e.taskId, attempt: e.attempt, command: e.command || '', startedAt: e.startedAt || null };
  }

  /** 正在跑的验证的键列表（诊断 / 测试用）。 */
  const runningKeys = () => [...running.keys()];

  /**
   * 把一次运行的原始输出压成要落盘的那一小段。
   *
   * **保留末尾**：失败原因几乎总在最后几行，掐头比掐尾有用。
   * stdout 和 stderr 都收 —— 命令把错误写在哪一边没有统一的规矩。
   */
  function summarize(out) {
    const so = String((out && out.stdout) || '').trim();
    const se = String((out && out.stderr) || '').trim();
    const text = [so, se].filter(Boolean).join('\n');
    const cut = text.length > MAX_VERIFICATION_OUTPUT;
    return {
      outputSummary: cut ? text.slice(-MAX_VERIFICATION_OUTPUT) : text,
      truncated: Boolean(out && out.truncated) || cut,
    };
  }

  /**
   * 起一次独立验证。**同步返回**（与 scheduler.start 同一风格：HTTP 要立刻回）。
   *
   * 准入判定 + 登记 + 落盘 `running` 全在同一个同步块里完成 ——
   * 中间不许有 await，否则两次连点就能同时通过「有没有在跑」的检查。
   *
   * @returns {{ok:true, verification}|{ok:false, code, error}}
   *   失败时的 code 是对外契约（前端按它分辨原因，不看 HTTP 状态码）：
   *   `not-found` / `workspace-stale` / `no-project` / `plan-active` /
   *   `attempt-not-found` / `already-running` / `no-command` / `invalid-cwd`
   */
  function start({ planId, taskId, attempt }) {
    const fresh = store.load(planId);
    const plan = fresh ? fresh.plan : null;
    if (!plan) return { ok: false, code: 'not-found', error: '找不到这个计划' };

    /* 归属：这个计划必须属于**当前**项目。切走之后旧面板不该还能对着旧项目跑命令
     *（前端也有 workspaceGeneration 守卫，这里是后端那一半）。 */
    const cwd = runtime.getCurrentCwd();
    if (!cwd) return { ok: false, code: 'no-project', error: '还没有选择项目' };
    const norm = (p) => (process.platform === 'win32' ? String(p || '').toLowerCase() : String(p || ''));
    if (norm(plan.projectRoot) !== norm(cwd)) {
      return { ok: false, code: 'workspace-stale', error: '这个计划属于另一个项目，切回那个项目才能运行验证' };
    }

    /* 计划正在执行时拒绝 —— **任何一个计划**，不只是这一个（P9 收口）。
     * 原来只比 `=== plan.id`，于是「Plan A 在跑，去验证同一个 workspace 的 Plan B」
     * 能穿过去：两个主体同时在同一个工作区里跑命令。 */
    if (scheduler && typeof scheduler.activePlanId === 'function' && scheduler.activePlanId() !== null) {
      return { ok: false, code: 'plan-active', error: `计划 ${scheduler.activePlanId()} 正在执行，等它结束或先停止计划，再运行验证` };
    }

    const task = (plan.tasks || []).find((x) => x.id === taskId);
    if (!task) return { ok: false, code: 'attempt-not-found', error: '找不到这个任务' };
    const att = (Array.isArray(task.attempts) ? task.attempts : []).find((x) => x.attempt === attempt);
    if (!att) return { ok: false, code: 'attempt-not-found', error: '找不到这次尝试' };

    const key = keyOf(planId, taskId, attempt);
    /* 「你点的就是正在跑的那一条」与「**另外**一条正在跑」是两件事，不能糊成一种
     * 提示 —— 前者该让你去停它，后者该告诉你去停那次。 */
    if (running.has(key)) return { ok: false, code: 'already-running', error: '这次尝试正在验证中' };
    /* P9 收口：第一阶段**不支持多 Verification 并行**。同一个工作区同一时间只允许
     * 一个实际执行者，所以只要还有别的验证在跑就直接拒绝，**不排队**
     *（排队意味着「点一下、等一会儿、自己开始跑」，那更吓人也更难解释）。 */
    if (running.size > 0) {
      const other = activeVerification();
      return {
        ok: false,
        code: 'verification-active',
        error: `另一次独立验证正在运行（${other.planId} / ${other.taskId} 第 ${other.attempt} 次），请先停止它`,
      };
    }

    /* 命令**只**从冻结的快照来。没有快照 → 不跑：拿当前 task.verification 顶上
     * 就是在伪造「当时的要求」，而 description 解析成命令更是在猜。 */
    const command = att.verificationSnapshot && typeof att.verificationSnapshot.command === 'string'
      ? att.verificationSnapshot.command.trim()
      : '';
    if (!command) {
      return {
        ok: false,
        code: 'no-command',
        error: att.verificationSnapshot && att.verificationSnapshot.description
          ? '这次执行只记了验证说明，没有可执行的验证命令'
          : '这次执行没有保存验证要求，无法独立验证',
      };
    }

    /* ---------- 用哪个目录：优先那次 attempt **冻结**的那个（P9 收口） ----------
     *
     * 拿**当前** `task.workingDirectory` 去验证一条历史 attempt 是错的：
     * 用户改过 task 之后，那条证据就不再对应那次执行了 ——
     * Attempt 1 当初在 `packages/a` 里跑，改成 `packages/b` 之后再验证，
     * 会在 `packages/b` 里跑 `npm test`，却把结果记在「Attempt 1」名下。
     *
     * 老 attempt（P9 收口之前产生的）没有这个字段，只能退到当前值 ——
     * 但**必须如实标记**：`current-task-fallback` 是「我现在猜它当初在哪儿跑的」，
     * 不是「我当时在哪儿跑的」。两者证据强度不一样，界面上也要分开说。 */
    const snapshotDir = att.workingDirectorySnapshot;
    const usingSnapshot = typeof snapshotDir === 'string' && snapshotDir.trim() !== '';
    const wantedDir = usingSnapshot ? snapshotDir : task.workingDirectory || '.';
    const dirSource = usingSnapshot ? WORKDIR_SOURCE.SNAPSHOT : WORKDIR_SOURCE.FALLBACK;

    /* **两条路都要过 safe-path** —— fallback 不等于可以不校验。
     * 冻结值同样可能被人手工改坏（绝对路径、`../`、junction），
     * 所以这里不区分来源，一律按同一把尺子量。 */
    const resolved = resolveProjectPath(plan.projectRoot, wantedDir);
    if (!resolved.ok) {
      return {
        ok: false,
        code: 'invalid-cwd',
        error: usingSnapshot
          ? `这次执行冻结的工作目录不可用（${resolved.error}）`
          : `任务的工作目录不可用：${resolved.error}`,
      };
    }
    if (resolved.missing) {
      return { ok: false, code: 'invalid-cwd', error: '执行时的工作目录已经不存在了' };
    }
    /* 存**项目相对路径**（绝对路径随项目搬走就失真）。与 normalizeTask 同一套换算。 */
    const relDir = resolved.rel ? resolved.rel.split(path.sep).join('/') : '.';

    const controller = new AbortController();
    const startedAt = now();
    const result = normalizeVerificationResult({
      status: VERIFICATION_STATUS.RUNNING,
      command,
      workingDirectory: relDir,
      workingDirectorySource: dirSource,
      startedAt,
    });

    /* 能走到 start() 就说明进程还在正常服务 —— 上一轮的 shutdown 已经过去了。
     * 不复位的话调度器会**因为一次退出而永久失效**：`shuttingDown` 一直为真，
     * 之后每次 runOnce 都在开头 return，验证结果永远停在 running。
     * （scheduler.start() 里对同名字段有一样的复位，是同一个坑。）
     * 生产里 shutdown 之后就是 exit，所以这条主要救的是「同一进程内复用」
     * 的场景 —— 测试、以及将来可能的「重启服务而不退出进程」。 */
    shuttingDown = false;

    running.set(key, { planId, taskId, attempt, controller, command, startedAt });
    /* 先落盘 running 再跑命令：界面刷新一次就能看到「正在验证…」，
     * 而不是等命令结束才出现一行结果。 */
    mutateAttempt(planId, taskId, attempt, (a) => {
      a.verificationResult = result;
    });
    emit(planId, taskId, attempt, 'verification_start', { command, workingDirectory: relDir, workingDirectorySource: dirSource, startedAt });

    /* 不 await：HTTP 立刻回「已启动」，结果走 SSE + 下一次读取。 */
    runOnce({ planId, taskId, attempt, command, cwd: resolved.abs, relDir, dirSource, controller, startedAt }).catch(() => {
      /* runOnce 内部已经尽力落盘；这里只保证不会变成 unhandledRejection */
    });

    return { ok: true, verification: result };
  }

  /** 真正跑一次。所有异常都收在这里，绝不让它冒成 unhandledRejection。 */
  async function runOnce({ planId, taskId, attempt, command, cwd, relDir, dirSource, controller, startedAt }) {
    const key = keyOf(planId, taskId, attempt);
    let out;
    try {
      out = await runShell({ command, cwd, signal: controller.signal, timeoutMs, maxStdoutBytes: maxOutputBytes });
    } catch (err) {
      out = {
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false,
        cancelled: false,
        spawnFailed: true,
        error: `无法启动：${err && err.message ? err.message : String(err)}`,
      };
    }
    running.delete(key);

    /* 退出中：状态已经由 shutdown() 定成 interrupted，这里不再改（同 scheduler
     * 里那条规矩 —— 否则会把「应用被关掉」翻成「命令失败」）。 */
    if (shuttingDown) return;

    const finishedAt = now();
    const status = out.cancelled
      ? VERIFICATION_STATUS.INTERRUPTED
      : out.ok
        ? VERIFICATION_STATUS.PASSED
        : VERIFICATION_STATUS.FAILED;
    const { outputSummary, truncated } = summarize(out);
    const error = out.timedOut
      ? `超时（${Math.round(timeoutMs / 1000)}s）`
      : out.cancelled
        ? '已停止'
        : out.spawnFailed
          ? String(out.error || '无法启动验证命令')
          : '';

    mutateAttempt(planId, taskId, attempt, (a) => {
      a.verificationResult = normalizeVerificationResult({
        status,
        command,
        /* 实际在哪个目录跑的、以及这个目录是怎么来的 —— 证据的一部分。 */
        workingDirectory: relDir,
        workingDirectorySource: dirSource,
        exitCode: out.exitCode,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        outputSummary,
        truncated,
        error,
      });
    });
    emit(planId, taskId, attempt, 'verification_end', { status, exitCode: out.exitCode, durationMs: finishedAt - startedAt });
  }

  /** 停止某次正在跑的验证。abort 之后 runOnce 会以 interrupted 收尾。 */
  function stop({ planId, taskId, attempt }) {
    const key = keyOf(planId, taskId, attempt);
    const entry = running.get(key);
    if (!entry) return { ok: false, code: 'not-running', error: '这次尝试当前没有在验证' };
    try {
      entry.controller.abort();
    } catch {
      /* noop */
    }
    return { ok: true };
  }

  /**
   * 应用退出时收尾 —— **同步**做完（SIGINT 里没有第二次机会）。
   *
   * 与 `scheduler.shutdown()` 把 running 的 task 标成 interrupted 是同一条规矩：
   * 进程一走，那条「正在验证…」就永远不会有下文了，留在盘上就是撒谎。
   *
   * 这里能记的比硬崩多一样：**耗时**。优雅退出时我们知道从 startedAt 到现在的
   * 真实时长（硬崩那条路径由 store 的启动恢复处理，那时只能留空 —— 因为
   * 「现在 − startedAt」会把应用关闭到重启之间的时间也算进去）。
   */
  function shutdown() {
    if (!running.size) return;
    shuttingDown = true;
    const finishedAt = now();
    for (const [, entry] of running) {
      try {
        entry.controller.abort();
      } catch {
        /* noop */
      }
      mutateAttempt(entry.planId, entry.taskId, entry.attempt, (a) => {
        const cur = a.verificationResult;
        /* 只改还停在 running 的那条（可能已经被别处收过尾）。 */
        if (!cur || cur.status !== VERIFICATION_STATUS.RUNNING) return false;
        a.verificationResult = normalizeVerificationResult({
          ...cur,
          status: VERIFICATION_STATUS.INTERRUPTED,
          finishedAt,
          durationMs: Number.isFinite(cur.startedAt) ? finishedAt - cur.startedAt : null,
          error: '应用关闭时被中断',
        });
        return true;
      });
    }
    running.clear();
  }

  return { start, stop, shutdown, isRunning, hasRunning, activeVerification, runningKeys, _summarize: summarize };
}
