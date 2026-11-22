/* Known Capability Installer + 受控的 Pi 包操作执行器。
 *
 * ---------- 它是什么，不是什么 ----------
 *
 * 这个模块是后端**唯一**会为了 Extension 去跑 Pi 官方包管理命令的地方。两个入口，
 * 共用同一把锁、同一套闸门、同一条执行与恢复路径：
 *
 *   1. **已知能力一键安装**（`start` / `handle`，P24 起）：只服务 Pi GUI 自己维护的
 *      四个固定 capability descriptor（Web Access / Subagents / Pi Memory /
 *      Browser Use）。renderer 只送 capabilityId，source 由下面的 allowlist 决定。
 *   2. **受控包操作**（`startOperation`，第二阶段 B 起）：安装 / 卸载 / 更新一个
 *      **服务端已经解析好**的 npm 包。调用方是 `server/extension-packages.js`，
 *      它把 renderer 送来的受控 id 解析成 source；这里再独立校验一次形状。
 *
 * 两条都**不**接受 renderer 传的 source / packageName / command / args / url，
 * 都不查 npm、不搜包。未知 id / 未知动作 / 形状不对的 source 一律 fail closed。
 *
 * 这也是为什么安装动作**不**放进 `server/extension-registry.js`：Registry 是通用、
 * 只读的发现层（`actions.install === false` 是它的契约）。两者共用的是
 * 「发现了什么」这件事，不是写权限。
 *
 * ---------- 执行的永远是「当前那一份 Pi」 ----------
 *
 * 与 `server/pi-update.js` 同源：入口由**当前 launch identity** 派生
 * （`piLaunch.packageDir()` → `buildPiEntry()`，在 server.js 里注入），
 * 经 `agents/cli.js` 的 `runCli`（`shell:false` + args 数组 + 超时 + 有界输出）。
 * **绝不**自己装包、不 PATH 上另找一份 pi、不自己起进程。
 *
 * 固定 argv（每个动作只有一种形状，source 永远是 `npm:<严格包名>`）：
 *
 *     pi install <source> --no-approve
 *     pi remove  <source> --no-approve
 *     pi update  --extension <source> --no-approve
 *
 * 依据（Pi 1.6.0 实机核对，本机 `@earendil-works/pi-coding-agent@1.6.0`，
 * `dist/package-manager-cli.js` 的 `parsePackageCommand()` 与命令分支）：
 *   - `--no-approve` 只设 `projectTrustOverride = false`：项目级 settings 在这条命令里
 *     被忽略，install / remove 不带 `-l` 时只读写**用户级** `settings.json`；
 *     update 只看用户级登记的包。所以三条命令都不会因为项目未信任而失败，
 *     也都不会碰项目级安装。
 *   - `install` 走 `installAndPersist(source)`，成功打印 `Installed <source>`、退出码 0。
 *   - `remove` 走 `removeAndPersist(source)`：按包身份（忽略版本）匹配 settings 条目；
 *     settings 里没有这个包时打印 `No matching package found …`、退出码 1。
 *   - `update --extension <source>` 走 `update(source)`：按包身份匹配；
 *     **固定了精确版本的包会被跳过**；退出码 0 时 stdout 末尾四种结论之一
 *     （见 `updateOutcome()`）。
 *   - Pi 没有声明式的 Extension 权限清单，也没有非交互的启用 / 停用命令
 *     （`pi config` 只有交互式 TUI），所以这里没有、也不会有 toggle 动作。
 *
 * ---------- 维护期间才动 Pi ----------
 *
 * 复用 `rpc.pauseForMaintenance(reason)` / `resumeFromMaintenance()`，
 * 与 Pi 自更新同一套安全规则：**暂停超时 = 失败**（旧进程还活着就绝不执行）、
 * 只 resume 自己拥有的那次维护态、不污染 crash backoff、不产生第二个 Pi child。
 *
 * ---------- 退出码 0 ≠ 已安装 ≠ 已加载 ----------
 *
 * 成功只回 `commandCompleted: true` + `loaded: null`：**是否真的装上 / 卸掉 / 换了
 * 版本，由调用方在同一把锁里重新读盘回答**（`finish` 钩子），`loaded` 在拿到 Pi 的
 * 加载证据之前一直是未知。后端在这里**不宣布任何加载状态**。
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

/** 卸载：与安装同一种三格形状。 */
export function buildRemoveArgs(source) {
  return ['remove', source, '--no-approve'];
}

/** 更新：`--extension <source>` 把目标钉成「这一个包」，永远不是 self / all。 */
export function buildUpdateArgs(source) {
  return ['update', '--extension', source, '--no-approve'];
}

/**
 * 受控 source 的形状：`npm:` + 严格的小写 npm 包名（可带 scope），**不带版本**。
 *
 * 比 npm 自己的规则更窄（不收 `~`、不收以 `.` `_` `-` 开头的名字）——
 * 这个字符串会原样成为 argv 的一格，再被 Pi 交给包管理器；首字符是字母数字
 * 就不可能被任何一层当成选项，也不可能拼出路径分隔符之外的东西。
 */
const CONTROLLED_SOURCE_RE = /^npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_SOURCE_CHARS = 'npm:'.length + 214;

export function isControlledSource(source) {
  return typeof source === 'string' && source.length <= MAX_SOURCE_CHARS && CONTROLLED_SOURCE_RE.test(source);
}

/**
 * 三个受控动作。`reason` 是暂停 Pi 时的维护原因（前端按它选措辞，
 * 见 `public/status-copy.js` 的 `maintenanceCopy`）。
 */
export const PACKAGE_OPERATIONS = Object.freeze({
  install: Object.freeze({ action: 'install', reason: 'capability-install', noun: '安装', buildArgs: buildInstallArgs }),
  remove: Object.freeze({ action: 'remove', reason: 'extension-remove', noun: '卸载', buildArgs: buildRemoveArgs }),
  update: Object.freeze({ action: 'update', reason: 'extension-update', noun: '更新', buildArgs: buildUpdateArgs }),
});

/** 动作名 → 定义。未知动作 / 原型键回 null。 */
export function packageOperation(action) {
  if (typeof action !== 'string' || !action) return null;
  return Object.prototype.hasOwnProperty.call(PACKAGE_OPERATIONS, action) ? PACKAGE_OPERATIONS[action] : null;
}

/** 去掉终端着色（Pi 的输出经 chalk；强制着色的环境里会带 ANSI 序列）。 */
const plain = (text) => (typeof text === 'string' ? text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '') : '');

/**
 * `pi update --extension <source>` 退出码 0 时 stdout 里的结论。
 *
 * 这是**提示**，不是判据：是否真的换了版本由调用方读盘决定。认不出就回 null
 * （Pi 改了措辞也只是少一句解释，不会把「没更新」说成「更新了」）。
 */
export function updateOutcome(stdout) {
  const text = plain(stdout);
  if (/Skipped package updates \(offline mode\)/.test(text)) return 'skipped-offline';
  if (/Updated \d+ packages?:/.test(text)) return 'updated';
  if (/ was not updated, see the warnings above/.test(text)) return 'not-updated';
  if (/ is already up to date/.test(text)) return 'up-to-date';
  return null;
}

/**
 * 失败原因的**粗分类**：只回枚举，原文不出后端。认不出就是 null —— 不猜。
 * 调用方据此给一句「下一步怎么办」，一行脱敏摘要仍然单独给。
 */
export function failureCause(raw) {
  const text = plain(`${(raw && raw.stderr) || ''}\n${(raw && raw.stdout) || ''}`);
  if (!text.trim()) return null;
  if (/No matching package found for /.test(text)) return 'not-configured';
  if (/\bE404\b|404 Not Found|is not in this registry/i.test(text)) return 'package-not-found';
  if (/\b(?:ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b|getaddrinfo|network (?:timeout|request)/i.test(text)) return 'network';
  if (/\b(?:EACCES|EPERM|EBUSY)\b|permission denied|operation not permitted/i.test(text)) return 'permission';
  if (/\bENOSPC\b|no space left/i.test(text)) return 'disk-full';
  if (/\bEINTEGRITY\b|integrity check(?:sum)? failed/i.test(text)) return 'integrity';
  if (/\b(?:ETARGET|ERESOLVE)\b|No matching version found/i.test(text)) return 'version-unresolved';
  if (/(?:npm|pnpm|bun)(?:\.cmd)? ENOENT|is not recognized as an internal or external command|command not found/i.test(text)) {
    return 'package-manager-missing';
  }
  return null;
}

/** 安装默认超时：包管理器拉包 + 依赖，比更新宽松（10 分钟）。 */
export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** 输出上限：官方 CLI 的 stdout/stderr 只用来取一句脱敏摘要，永不原样出后端。 */
const MAX_OUTPUT_CHARS = 4000;
const MAX_ERROR_CHARS = 200;
const LOCK_TEXT = '另一个扩展安装、卸载或更新正在进行中';

/**
 * @param currentCwd        () => 当前工作区（工作区过期守卫用）
 * @param busyReason        () => {code,error} | null —— **服务端唯一的「Pi 忙不忙」判据**
 *                          （与 Pi Updater 共用同一份，见 server.js 的 piBusyReason）
 * @param resolveInstallTarget () => {ok:true, entry} | {ok:false, code}
 * @param runInstall        (args, opts) => Promise<runCli 的结果>（三个动作共用这一条出口）
 * @param pauseBridge       (reason) => Promise<{ok, code?}>
 * @param resumeBridge      () => void
 * @param invalidateCaches  () => void（清掉与 Pi 包 identity 绑定的缓存）
 * @param timeoutMs         包管理子进程超时
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
  /** 单飞：**后端自己的锁**，不靠前端 disabled。三个动作与已知能力安装共用这一把。 */
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

  /** 闸门前半：确认 + 单飞。`lockCode` 让两条入口各自保留自己的稳定 code。 */
  function gateLock(body, noun, lockCode) {
    if (!body || body.confirm !== true) return fail('confirm-required', `需要用户显式确认才能${noun} Extension`);
    if (inflight) return fail(lockCode, LOCK_TEXT);
    return null;
  }

  /**
   * 闸门后半：工作区、忙、入口。
   * @returns {{ok:true, entry}|{ok:false, code, error}}
   */
  function gateRuntime(body, noun) {
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
      if (raw !== cur) return fail('workspace-stale', `项目已切换，这次${noun}作废（请在当前项目上重试）`);
    }
    /* 忙闸门：正在生成的回合 / Planner / 独立验证 / 在飞的 Pi CLI 动作 /
     * 正在进行的 Pi 更新 / 另一次包操作 —— 规则只有一份，由注入方给。 */
    if (typeof busyReason === 'function') {
      let busy = null;
      try {
        busy = busyReason();
      } catch {
        busy = { code: 'busy-unknown', error: `无法确认当前是否空闲，已拒绝${noun}` };
      }
      if (busy && busy.code) return fail(busy.code, busy.error || `当前有任务在跑，已拒绝${noun}`);
    }
    const t = target();
    if (!t.ok) {
      return fail('unsupported', `当前这份 Pi 无法通过官方${noun}命令${noun}（没有证明到它的官方${noun}入口）`);
    }
    return { ok: true, entry: t.entry };
  }

  /**
   * 已知能力安装的闸门。**全部在后端**：确认、单飞、allowlist、工作区、忙、入口。
   *
   * ⚠️ 刻意是**同步**的：这里没有任何需要 await 的东西，而「检查」与「上锁」
   * 之间只要让出一次事件循环，两个几乎同时到达的请求就可能都通过检查
   * （前端的 disabled 本来就不可信）。同步之后 `start()` 能在同一个 tick 里
   * 判完并上锁，`isRunning()` 也是调用后立刻为真。
   *
   * @returns {{ok:true, ctx}|{ok:false, code, error}}
   */
  function prepare(body = {}) {
    const locked = gateLock(body, '安装', 'install-running');
    if (locked) return locked;
    const id = typeof body.capabilityId === 'string' ? body.capabilityId : '';
    const source = capabilitySource(id);
    /* 未知 id fail closed：这里**没有**任何「按名字猜一个包」的余地。 */
    if (!source) return fail('unknown-capability', '这不是 Pi GUI 维护的已知能力，已拒绝安装');
    const gate = gateRuntime(body, '安装');
    if (!gate.ok) return gate;
    return {
      ok: true,
      ctx: { def: PACKAGE_OPERATIONS.install, capabilityId: id, source, entry: gate.entry, finish: null },
    };
  }

  /**
   * 真正执行。结构上**只有一个出口**：所有分支只给 `result` 赋值，
   * 最后统一返回（与 pi-update 的 `finishUpdate` 同一条纪律）。
   *
   * `ctx.capabilityId` 有值 = 已知能力那条入口（code / 字段保持 P24 的形状）；
   * 为 null = 受控包操作（code 以动作名开头，另带 `outcome` / `cause`）。
   */
  async function execute(ctx) {
    const def = ctx.def || PACKAGE_OPERATIONS.install;
    const noun = def.noun;
    const generic = ctx.capabilityId == null;
    /* 失败响应里带回的身份。受控包操作多一格 `commandStarted`：
     * 官方命令的进程**有没有真的跑起来过** —— 没跑过就一定没动磁盘。 */
    const tag = (started) => (generic
      ? { action: def.action, source: ctx.source, commandStarted: started }
      : { capabilityId: ctx.capabilityId, source: ctx.source });
    const args = def.buildArgs(ctx.source);
    let result = null;
    let started = false;
    /* **只有我们真的暂停成功过**才由我们 resume：
     * `pause-timeout` 由 rpc-bridge 自己回滚维护态，`already-in-maintenance`
     * 是别人的维护态 —— 这两种情况再 resume 会掀掉不属于我们的状态。 */
    let ownsMaintenance = false;
    try {
      const pause = typeof pauseBridge === 'function' ? pauseBridge(def.reason) : { ok: true };
      const paused = await Promise.resolve(pause).catch(() => ({ ok: false, code: 'pause-failed' }));
      if (paused && paused.ok === false) {
        const code = paused.code === 'already-in-maintenance' ? (generic ? 'operation-running' : 'install-running')
          : paused.code === 'pause-timeout' ? 'pause-timeout'
            : 'pause-failed';
        result = fail(code, code === 'pause-timeout'
          ? `旧 Pi 进程在超时前没有退出，已放弃${noun}（不会在它还活着时${noun} Extension）`
          : code === 'pause-failed'
            ? `无法暂停 Pi 进程，已放弃${noun}`
            : `Pi 已经在维护中（可能是另一次安装或更新），本次${noun}已放弃`, tag(false));
      } else {
        ownsMaintenance = true;
        let raw;
        try {
          /* entry 一路带过来：**只解析一次**，保证「闸门检查的那份 Pi」与
           * 「真正被执行的那份 Pi」是同一个对象（identity 同源）。 */
          raw = await runInstall(args, {
            timeoutMs, maxStdoutBytes: MAX_OUTPUT_CHARS, entry: ctx.entry,
            ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
          });
        } catch (err) {
          raw = { ok: false, spawnFailed: true, error: (err && err.message) || `${noun}命令启动失败` };
        }
        started = !(raw && raw.spawnFailed);
        if (!raw || raw.ok !== true) {
          const code = raw && raw.timedOut ? `${def.action}-timeout`
            : raw && raw.spawnFailed ? `${def.action}-spawn-failed`
              : `${def.action}-failed`;
          result = fail(code, sanitizeLine(plain((raw && (raw.error || raw.stderr)) || '') || `官方${noun}命令没有成功结束`), {
            ...tag(started),
            ...(generic ? { cause: failureCause(raw) } : {}),
          });
          /* 受控包操作：命令起来过就可能已经动了磁盘（超时被杀、装到一半），
           * 与 Pi 包 identity 绑定的缓存一律作废，让随后的重新发现从盘上读。 */
          if (generic && started && typeof invalidateCaches === 'function') {
            try {
              invalidateCaches();
            } catch {
              /* 清缓存失败不改变这次失败的结论 */
            }
          }
        } else {
          /* 退出码 0 ≠ 已安装。先清掉与 Pi 包 identity 绑定的缓存（Extension 发现
           * 是按 (cwd, bridgeRun) 绑定的，resume 之后旧索引本来就不可见），
           * 再 resume —— resume 会真的把 Pi 重新拉起来，这就是「操作后自动重启」。
           * **这里不宣布 installed / loaded**：那是重新发现之后的结论。 */
          if (typeof invalidateCaches === 'function') {
            try {
              invalidateCaches();
            } catch {
              /* 清缓存失败不该让一次真的安装变成失败；重新发现仍会给出结论 */
            }
          }
          const exitCode = Number.isInteger(raw.exitCode) ? raw.exitCode : 0;
          result = generic
            ? {
              ok: true,
              code: 'command-completed',
              action: def.action,
              source: ctx.source,
              commandCompleted: true,
              commandStarted: true,
              exitCode,
              restarted: false,
              /* 只有 update 的 stdout 带结论；它是提示，读盘才是判据。 */
              outcome: def.action === 'update' ? updateOutcome(raw.stdout) : null,
              loaded: null,
            }
            : {
              ok: true,
              code: 'installed',
              phase: 'installed',
              capabilityId: ctx.capabilityId,
              source: ctx.source,
              commandCompleted: true,
              exitCode,
              restarted: true,
              /* 事实边界：装没装由刷新后的 Registry 回答；加载状态此时一律未知。 */
              loaded: null,
            };
        }
      }
    } catch (err) {
      result = fail(`${def.action}-failed`, sanitizeLine((err && err.message) || `${noun}过程中出错`), tag(started));
    } finally {
      /* 成功与失败都要恢复 bridge（**只恢复我们自己暂停的那次**），
       * 否则 GUI 会永久停在维护态。 */
      if (ownsMaintenance && typeof resumeBridge === 'function') {
        try {
          const resumed = resumeBridge();
          if (generic && result && resumed?.ok !== false) result.restarted = true;
        } catch {
          /* resume 自己炸了：不要盖掉真正的失败原因 */
        }
      }
    }
    /* 复核仍在锁里：下一次包操作要等这次读完盘才可能开始，
     * 所以调用方读到的就是「这一次命令之后」的磁盘状态。 */
    if (typeof ctx.finish === 'function') {
      try {
        const settled = await ctx.finish(result);
        if (settled && typeof settled === 'object') result = settled;
      } catch {
        /* 复核自己失败：命令的结论照旧，只是「盘上现在是什么」未知 */
        result = { ...result, verified: null };
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

  /**
   * 受控包操作：安装 / 卸载 / 更新一个**服务端解析好**的 npm 包。
   *
   * @param body  renderer 的请求体。这里**只读** `confirm` 与 `__expectedCwd`；
   *              它里面的 source / name / args 一概不看。
   * @param op    服务端调用方给的计划：
   *              - `action`  'install' | 'remove' | 'update'
   *              - `source`  `npm:<严格包名>`（这里再独立校验一次，不信调用方）
   *              - `finish`  (result) => result' —— 在锁里复核磁盘状态（可异步）
   *
   * 与 `start()` 一样，从判闸门到上锁**全程同步**，没有让出事件循环的空隙。
   */
  function startOperation(body = {}, op = {}) {
    const def = packageOperation(op && op.action);
    if (!def) return Promise.resolve(fail('unknown-action', '不支持的扩展操作，已拒绝'));
    const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const locked = gateLock(input, def.noun, 'operation-running');
    if (locked) return Promise.resolve(locked);
    if (!isControlledSource(op.source)) {
      return Promise.resolve(fail('source-rejected', `这个来源不是受控的 npm 包标识，已拒绝${def.noun}`));
    }
    const gate = gateRuntime(input, def.noun);
    if (!gate.ok) return Promise.resolve(gate);
    inflight = execute({
      def,
      capabilityId: null,
      source: op.source,
      entry: gate.entry,
      agentDir: op.agentDir,
      finish: typeof op.finish === 'function' ? op.finish : null,
    }).finally(() => {
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
    startOperation,
    prepare,
    isRunning: () => Boolean(inflight),
    /** 这份 Pi 有没有可证明的官方 CLI 入口（没有就不该出现任何操作按钮）。 */
    available: () => target().ok === true,
    /** 诊断/测试用：只读最近一次结果（脱敏后的一句话 + 状态码）。 */
    snapshot: () => (lastResult
      ? {
        ok: Boolean(lastResult.ok),
        code: lastResult.code || null,
        capabilityId: lastResult.capabilityId || null,
        action: lastResult.action || null,
        running: Boolean(inflight),
      }
      : { ok: null, code: null, capabilityId: null, action: null, running: Boolean(inflight) }),
    _internals: { prepare, execute, target, now },
  };
}
