/* Known Capability Installer —— **受控**的一键安装。
 *
 * ---------- 它是什么，不是什么 ----------
 *
 * 只服务 Pi GUI **自己明确维护**的那几个固定 capability descriptor（Web Access /
 * Subagents / Pi Memory / Browser Use）。它**不是** Extension 商店：
 *   - 不接受 renderer 传任何 source / packageName / command / args / url；
 *   - 不查 npm、不搜包、不发现陌生 Extension；
 *   - 不 uninstall、不 update、不做 project-local 安装。
 * 未知 capability id 一律 fail closed。
 *
 * 这也是为什么它**不**放进 `server/extension-registry.js`：Registry 是通用、只读的
 * 发现层（`actions.install === false` 是它的契约），往那里塞安装动作会把它变成
 * 插件商店。两者共用的是「发现了什么」这件事，不是写权限。
 *
 * ---------- 执行的永远是「当前那一份 Pi」 ----------
 *
 * 与 `server/pi-update.js` 同源：入口由**当前 launch identity** 派生
 * （`piLaunch.packageDir()` → `buildPiEntry()`，在 server.js 里注入），
 * 经 `agents/cli.js` 的 `runCli`（`shell:false` + args 数组 + 超时 + 有界输出）。
 * **绝不**自己 npm install、不 PATH 上另找一份 pi、不 spawn('pi')。
 *
 * 固定 argv（只有这三个位置，没有 `-l` / `--local` / `--approve` / `--all` / `--self`）：
 *
 *     pi install <allowlisted source> --no-approve
 *
 * 依据（Pi 1.0.0 实机核对，本机 `@earendil-works/pi-coding-agent@1.0.0`）：
 *   - `docs/cli.md`：`pi install <source> [options]`；「Personal installs are written to
 *     `~/.pi/agent/settings.json`」；「Add `--local` or `-l` … to use project settings」；
 *     package 命令选项里有 `-a/--approve` 与 `-na/--no-approve`。
 *   - 包里 `dist/bundle/chunks/chunk-33XOIQ5N.js` 的 `parsePackageCommand()`：
 *     `--no-approve` 只设 `projectTrustOverride = false`，不影响写哪个 scope；
 *     `install` 分支走 `packageManager.installAndPersist(source, { local })`，
 *     成功打印 `Installed <source>`、退出码 0；`local` 为真且项目未信任时才拒绝。
 *   所以固定 `--no-approve` + 不带 `-l` = **用户级安装**，且不会因为项目未信任而失败。
 *   （`--no-approve` 的语义是「忽略受信任闸门的项目级资源」，与本轮「装到用户级」
 *   不冲突 —— 它只关掉项目级资源的自动采信。）
 *
 * ---------- 维护期间才动 Pi ----------
 *
 * 复用 `rpc.pauseForMaintenance('capability-install')` / `resumeFromMaintenance()`，
 * 与 Pi 自更新同一套安全规则：**暂停超时 = 失败**（旧进程还活着就绝不安装）、
 * 只 resume 自己拥有的那次维护态、不污染 crash backoff、不产生第二个 Pi child。
 *
 * ---------- 退出码 0 ≠ 已安装 ≠ 已加载 ----------
 *
 * 成功只回 `commandCompleted: true` + `loaded: null`：**是否真的装上，由重新发现的
 * Extension Registry 回答**（前端刷新后按 `state.installed === true` 判定），
 * `loaded` 在拿到 Pi 的加载证据之前一直是未知。后端在这里**不宣布任何加载状态**。
 */
import { readBody } from './http-utils.js';
import { sanitizeLine } from '../lib/redact.js';

/**
 * 固定 allowlist：capability id → 官方 npm source。
 * **这是全后端唯一的 id → source 映射处**，renderer 只能送 id。
 * 与 `public/*-capabilities.js` 的 `installId` 由 `tests/capability-install.cjs`
 * 交叉核对（两边漂了就必须红）。
 */
export const CAPABILITY_SOURCES = Object.freeze({
  web: 'npm:pi-web-access',
  subagents: 'npm:pi-subagents',
  memory: 'npm:pi-memory',
  browser: 'npm:pi-browser-harness',
});

/** `capabilityId` → 固定 source。未知 id 回 null（调用方 fail closed）。 */
export function capabilitySource(id) {
  if (typeof id !== 'string' || !id) return null;
  return Object.prototype.hasOwnProperty.call(CAPABILITY_SOURCES, id) ? CAPABILITY_SOURCES[id] : null;
}

/** 固定 argv。**只有命令、固定 source、`--no-approve` 三格。** */
export function buildInstallArgs(source) {
  return ['install', source, '--no-approve'];
}

/** 安装默认超时：npm 拉包 + 依赖，比更新宽松（10 分钟）。 */
export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** 输出上限：官方 CLI 的 stdout/stderr 只用来取一句脱敏摘要，永不原样出后端。 */
const MAX_OUTPUT_CHARS = 4000;
const MAX_ERROR_CHARS = 200;

/**
 * @param currentCwd        () => 当前工作区（工作区过期守卫用）
 * @param busyReason        () => {code,error} | null —— **服务端唯一的「Pi 忙不忙」判据**
 *                          （与 Pi Updater 共用同一份，见 server.js 的 piBusyReason）
 * @param resolveInstallTarget () => {ok:true, entry} | {ok:false, code}
 * @param runInstall        (args, opts) => Promise<runCli 的结果>
 * @param pauseBridge       (reason) => Promise<{ok, code?}>
 * @param resumeBridge      () => void
 * @param invalidateCaches  () => void（清掉与 Pi 包 identity 绑定的缓存）
 * @param timeoutMs         安装子进程超时
 */
export function createCapabilityInstall({
  currentCwd = null,
  busyReason = null,
  resolveInstallTarget = null,
  runInstall = null,
  pauseBridge = null,
  resumeBridge = null,
  invalidateCaches = null,
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  /** 单飞：**后端自己的锁**，不靠前端 disabled。 */
  let inflight = null;
  let lastResult = null;

  function fail(code, error, extra = {}) {
    return { ok: false, code, error: sanitizeLine(error, MAX_ERROR_CHARS), ...extra };
  }

  /** 解析「这份 Pi 自己的官方 CLI 入口」。证明不了就拒绝，**不退回 PATH**。 */
  function target() {
    if (typeof resolveInstallTarget !== 'function') return { ok: false, code: 'no-proven-entry' };
    try {
      const r = resolveInstallTarget();
      if (r && r.ok === true && r.entry) return { ok: true, entry: r.entry };
      return { ok: false, code: (r && r.code) || 'no-proven-entry' };
    } catch {
      return { ok: false, code: 'no-proven-entry' };
    }
  }

  /**
   * 闸门。**全部在后端**：确认、单飞、allowlist、工作区、忙、入口。
   *
   * ⚠️ 刻意是**同步**的：这里没有任何需要 await 的东西，而「检查」与「上锁」
   * 之间只要让出一次事件循环，两个几乎同时到达的请求就可能都通过检查
   * （前端的 disabled 本来就不可信）。同步之后 `start()` 能在同一个 tick 里
   * 判完并上锁，`isRunning()` 也是调用后立刻为真。
   *
   * @returns {{ok:true, ctx}|{ok:false, code, error}}
   */
  function prepare(body = {}) {
    if (body.confirm !== true) return fail('confirm-required', '需要用户显式确认才能安装 Extension');
    if (inflight) return fail('install-running', '另一个扩展安装正在进行中');
    const id = typeof body.capabilityId === 'string' ? body.capabilityId : '';
    const source = capabilitySource(id);
    /* 未知 id fail closed：这里**没有**任何「按名字猜一个包」的余地。 */
    if (!source) return fail('unknown-capability', '这不是 Pi GUI 维护的已知能力，已拒绝安装');
    /* 工作区过期守卫（与 mcp-native 的 staleGuard / pi-update 同一套）。
     * 前端按仓库惯例发 `__expectedCwd`；兼容直写的 `expectedCwd`。
     * **只用于比较** —— 它不是一个可以被执行的参数。 */
    const raw = body.__expectedCwd !== undefined ? body.__expectedCwd : body.expectedCwd;
    if (typeof raw === 'string' && typeof currentCwd === 'function') {
      let cur = '';
      try {
        cur = currentCwd() || '';
      } catch {
        cur = '';
      }
      if (raw !== cur) return fail('workspace-stale', '项目已切换，这次安装作废（请在当前项目上重试）');
    }
    /* 忙闸门：正在生成的回合 / Planner / 独立验证 / 在飞的 Pi CLI 动作 /
     * 正在进行的 Pi 更新 / 另一次安装 —— 规则只有一份，由注入方给。 */
    if (typeof busyReason === 'function') {
      let busy = null;
      try {
        busy = busyReason();
      } catch {
        busy = { code: 'busy-unknown', error: '无法确认当前是否空闲，已拒绝安装' };
      }
      if (busy && busy.code) return fail(busy.code, busy.error || '当前有任务在跑，已拒绝安装');
    }
    const t = target();
    if (!t.ok) {
      return fail('unsupported', '当前这份 Pi 无法通过官方安装命令安装（没有证明到它的官方安装入口）');
    }
    return { ok: true, ctx: { capabilityId: id, source, entry: t.entry } };
  }

  /**
   * 真正执行。结构上**只有一个出口**：所有分支只给 `result` 赋值，
   * 最后统一返回（与 pi-update 的 `finishUpdate` 同一条纪律）。
   */
  async function execute(ctx) {
    const args = buildInstallArgs(ctx.source);
    let result = null;
    /* **只有我们真的暂停成功过**才由我们 resume：
     * `pause-timeout` 由 rpc-bridge 自己回滚维护态，`already-in-maintenance`
     * 是别人的维护态 —— 这两种情况再 resume 会掀掉不属于我们的状态。 */
    let ownsMaintenance = false;
    try {
      const pause = typeof pauseBridge === 'function' ? pauseBridge('capability-install') : { ok: true };
      const paused = await Promise.resolve(pause).catch(() => ({ ok: false, code: 'pause-failed' }));
      if (paused && paused.ok === false) {
        const code = paused.code === 'already-in-maintenance' ? 'install-running'
          : paused.code === 'pause-timeout' ? 'pause-timeout'
            : 'pause-failed';
        result = fail(code, code === 'pause-timeout'
          ? '旧 Pi 进程在超时前没有退出，已放弃安装（不会在它还活着时安装 Extension）'
          : code === 'install-running'
            ? 'Pi 已经在维护中（可能是另一次安装或更新），本次安装已放弃'
            : '无法暂停 Pi 进程，已放弃安装', {
          capabilityId: ctx.capabilityId,
          source: ctx.source,
        });
      } else {
        ownsMaintenance = true;
        let raw;
        try {
          /* entry 一路带过来：**只解析一次**，保证「闸门检查的那份 Pi」与
           * 「真正被安装的那份 Pi」是同一个对象（identity 同源）。 */
          raw = await runInstall(args, { timeoutMs, maxStdoutBytes: MAX_OUTPUT_CHARS, entry: ctx.entry });
        } catch (err) {
          raw = { ok: false, spawnFailed: true, error: (err && err.message) || '安装命令启动失败' };
        }
        if (!raw || raw.ok !== true) {
          const code = raw && raw.timedOut ? 'install-timeout'
            : raw && raw.spawnFailed ? 'install-spawn-failed'
              : 'install-failed';
          result = fail(code, sanitizeLine((raw && (raw.error || raw.stderr)) || '官方安装命令没有成功结束'), {
            capabilityId: ctx.capabilityId,
            source: ctx.source,
          });
        } else {
          /* 退出码 0 ≠ 已安装。先清掉与 Pi 包 identity 绑定的缓存（Extension 发现
           * 是按 (cwd, bridgeRun) 绑定的，resume 之后旧索引本来就不可见），
           * 再 resume —— resume 会真的把 Pi 重新拉起来，这就是「安装后自动重启」。
           * **这里不宣布 installed / loaded**：那是 Registry 重新发现之后的结论。 */
          if (typeof invalidateCaches === 'function') {
            try {
              invalidateCaches();
            } catch {
              /* 清缓存失败不该让一次真的安装变成失败；重新发现仍会给出结论 */
            }
          }
          result = {
            ok: true,
            code: 'installed',
            phase: 'installed',
            capabilityId: ctx.capabilityId,
            source: ctx.source,
            commandCompleted: true,
            exitCode: Number.isInteger(raw.exitCode) ? raw.exitCode : 0,
            restarted: true,
            /* 事实边界：装没装由刷新后的 Registry 回答；加载状态此时一律未知。 */
            loaded: null,
          };
        }
      }
    } catch (err) {
      result = fail('install-failed', sanitizeLine((err && err.message) || '安装过程中出错'), {
        capabilityId: ctx.capabilityId,
        source: ctx.source,
      });
    } finally {
      /* 成功与失败都要恢复 bridge（**只恢复我们自己暂停的那次**），
       * 否则 GUI 会永久停在维护态。 */
      if (ownsMaintenance && typeof resumeBridge === 'function') {
        try {
          resumeBridge();
        } catch {
          /* resume 自己炸了：不要盖掉真正的失败原因 */
        }
      }
    }
    lastResult = result;
    return result;
  }

  /**
   * 给 HTTP 用：闸门过了才跑，**等它跑完再回**（安装可能要几分钟）。
   *
   * `prepare()` 是同步的，所以「判闸门」与「上锁」在同一个 tick 里完成 ——
   * 两个几乎同时到达的请求不可能都过闸（见 prepare 的说明）。
   */
  function start(body = {}) {
    const pre = prepare(body);
    if (!pre.ok) return Promise.resolve(pre);
    inflight = execute(pre.ctx).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function handle(req, res, url, json) {
    if (req.method !== 'POST') {
      return json(res, 405, { ok: false, code: 'method-not-allowed', error: '只支持 POST' });
    }
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return json(res, 400, { ok: false, code: 'bad-body', error: '请求体不是合法 JSON' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json(res, 400, { ok: false, code: 'bad-body', error: '请求体不是合法 JSON 对象' });
    }
    const result = await start(body);
    /* 业务上的拒绝（未知能力 / 忙 / 过期 / 暂停失败）一律 200 + ok:false，
     * 与 pi-update、mcp-native 的受控动作同一种约定：前端只读 body。 */
    return json(res, 200, result);
  }

  return {
    handle,
    start,
    prepare,
    isRunning: () => Boolean(inflight),
    /** 诊断/测试用：只读最近一次结果（脱敏后的一句话 + 状态码）。 */
    snapshot: () => (lastResult
      ? {
        ok: Boolean(lastResult.ok),
        code: lastResult.code || null,
        capabilityId: lastResult.capabilityId || null,
        running: Boolean(inflight),
      }
      : { ok: null, code: null, capabilityId: null, running: Boolean(inflight) }),
    _internals: { prepare, execute, target, now },
  };
}
