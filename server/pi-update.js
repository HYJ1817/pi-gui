/* Pi 运行时更新（Built-in Pi Updater）。
 *
 * ---------- 它是什么、不是什么 ----------
 *
 * 管的是**本机装着的那个 pi**（Pi GUI 的外部 runtime），不是 Pi GUI 自己。
 * Pi GUI 自己的 GitHub Release 检查在 `server/update-check.js`（`/api/update`），
 * 两者**互不复用状态**：一个是「GUI 要不要升级」，一个是「它驱动的 pi 要不要升级」。
 * 命名也刻意分开（`pi-update` vs `update`），免得以后代码里 `update` 指代不清。
 *
 * ---------- 六条硬规则（改动前先读） ----------
 *
 * 1. **自动检查可以，自动安装禁止。** 检查只读一个固定 HTTPS endpoint；
 *    真正更新必须由用户显式确认（`confirm === true`），且要在界面上先弹确认框。
 *    升级 pi 可能改变 RPC / MCP / Extension 契约，绝不能静默发生。
 *
 * 2. **只跑官方 self-update。** 真更新执行的命令永远是 `pi update --self`，
 *    而且用的是**当前 launch identity** 证明过的那份 pi（`server/pi-launch.js`
 *    的 `packageDir` → `buildPiEntry()`）。**绝不自作主张**：
 *    不 `npm install -g`、不 pnpm/bun、不下载安装包、不 fallback 到 PATH 上的
 *    另一份 `pi`（那正是 P20.5「两份 identity」的老坑）。
 *    路径证明不了就拒绝，并如实告诉用户「当前这份 Pi 无法通过官方 self-update 更新」。
 *
 * 3. **不接受 renderer 传任何执行参数。** endpoint 只认 `action/confirm/
 *    expectedCurrentVersion/expectedLatestVersion`（+ 一个 workspace 过期守卫）。
 *    command / args / packageName / version / url / installCommand 一律忽略，
 *    所以它不可能是「任意命令执行器」。
 *
 * 4. **更新前从后端再查一遍门。** 前端把按钮 disable 掉只是体验，
 *    后端必须自己确认「没有正在生成的回合 / 没有跑着的 Planner 任务 /
 *    没有独立验证 / 没有在飞的 Pi CLI 动作 / 没有另一次更新 / 工作区没在切」。
 *
 * 5. **更新期间 bridge 处于维护态**（`rpc.pauseForMaintenance()`）：
 *    不接新命令、不自动重启、不污染 crashStreak。**任何**失败路径都必须 resume，
 *    否则 GUI 会永久停在维护态。
 *
 * 6. **更新成功 ≠ updater 退出码 0。** 必须清掉所有与 Pi 包 identity 绑定的缓存，
 *    再用同一个 launch identity 重新读一次版本；读到的还是旧版本就是失败。
 *
 * ---------- 隐私与输出边界 ----------
 *
 * 检查请求：GET、固定 URL、只带 `User-Agent: pi-gui/<GUI 版本>` 与 `Accept`、
 * 超时、无 cookie、无 token、URL 里不带 cwd / 项目名 / session / 模型 / provider。
 * 响应只取白名单字段；`packageName` 必须严格等于官方包名，否则拒绝执行更新。
 * updater 的 stdout/stderr **原样不出后端**：只做截断 + 脱敏后的一句话摘要。
 *
 * ---------- 离线 ----------
 *
 * `PI_OFFLINE=1`（或 `PI_GUI_OFFLINE=1`）时完全不发请求，直接回
 * `{ok:false, code:'offline'}`。检查失败只影响这一块 UI，
 * 绝不影响启动 / Bridge / Chat / Planner / MCP / Git / 诊断。
 */
import { compareVersions } from './pi-compat-matrix.js';

/** 官方包名。响应里的 packageName 与它不一致就拒绝执行更新。 */
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
/** 官方 latest-version endpoint（固定，不接受调用方传 URL）。 */
export const LATEST_VERSION_URL = 'https://pi.dev/api/latest-version';
/** 允许的主机白名单（文档 + 测试用；请求本身是写死的 URL）。 */
export const PI_UPDATE_HOSTS = Object.freeze(['pi.dev']);
/** 状态机的全部相位（前端只认这几个字符串）。 */
export const PHASES = Object.freeze([
  'idle', 'checking', 'available', 'updating', 'verifying', 'restarting', 'latest', 'failed',
]);
/** 允许出现在安装包名位置的值：pi 的 bin 入口文件名。 */
export const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_VERSION_CHARS = 64;
const MAX_ERROR_CHARS = 240;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 4000;

/** 只允许白名单字段进响应（多一个都不行 —— 这是对外契约）。 */
const STATUS_FIELDS = Object.freeze([
  'ok', 'phase', 'currentVersion', 'latestVersion', 'packageName',
  'updateAvailable', 'verification', 'canUpdate', 'reason', 'cached',
  'installedVersion', 'errorCode', 'error', 'checkedAt', 'running',
]);

/** 离线开关。仓库里以前没有这个变量，本轮为「检查」这类公网行为新加：
 *  设了就完全不发请求（测试与内网环境用）。 */
export function isOffline(env = process.env) {
  const raw = env.PI_OFFLINE ?? env.PI_GUI_OFFLINE;
  if (raw === undefined || raw === null || raw === '') return false;
  const text = String(raw).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

/** 版本字符串是否可用（与 pi-version.js 的判定同一套：三段数字 + 可选后缀）。 */
export function isVersionText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_VERSION_CHARS && VERSION_RE.test(value.trim());
}

/** 把任意一句话摘要脱敏 + 截断：绝对路径、Bearer、token 形态都不出后端。 */
export function sanitizeLine(text, max = MAX_ERROR_CHARS) {
  let out = typeof text === 'string' ? text : '';
  // 只取第一行：updater 的输出可能很长，多行摘要没有意义
  out = out.split(/\r?\n/).find((l) => l.trim()) || '';
  out = out
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, '<path>')
    .replace(/\/(?:home|Users|root)\/[^\s"'`]+/g, '<path>')
    .replace(/(Bearer|token|password|_authToken|api[_-]?key)\s*[=:]\s*\S+/gi, '$1=<redacted>')
    .replace(/npm_[A-Za-z0-9]{8,}/g, '<redacted>');
  return out.length > max ? out.slice(0, max) + '…' : out;
}

function fail(code, error, extra = {}) {
  return { ok: false, code, error: sanitizeLine(error, 200), ...extra };
}

export function createPiUpdate({
  env = process.env,
  /** 读当前版本：`server/pi-version.js` 的 read（含 verification / verifiedAgainst）。 */
  readVersion = null,
  /** 解析「这份 pi 的官方 CLI 入口」：`{ok:true, entry}` 或 `{ok:false, code}`。 */
  resolveUpdaterTarget = null,
  /** 跑 updater：`(args, opts) => Promise<{ok, exitCode, timedOut, spawnFailed, error, stdout, stderr}>`。 */
  runUpdater = null,
  /** 维护暂停 / 恢复（rpc-bridge）。 */
  pauseBridge = null,
  resumeBridge = null,
  /** 更新成功后清掉所有与 Pi 包 identity 绑定的缓存。 */
  invalidateCaches = null,
  /** 服务端闸门：返回 `{code, error}` 或 null（忙就别更新）。 */
  busyReason = null,
  /** 当前工作区目录：用于「工作区正在切换」的过期守卫（house pattern）。 */
  currentCwd = null,
  /** GUI 版本，只用于 User-Agent。 */
  guiVersion = '0.0.0',
  fetchImpl = null,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  updateTimeoutMs = DEFAULT_UPDATE_TIMEOUT_MS,
} = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);

  /* ---------- 两个**互不兼任**的状态 ----------
   *
   * 1. `checkCache` —— 公网版本检查的结果（可 TTL 复用）。
   * 2. `updateState` —— 更新执行本身的状态：跑的时候是相位，
   *    跑完是**终态**（latest / failed），带 installedVersion / errorCode。
   *
   * 以前只有一个 `cache`，GET 在更新期间会命中它：明明在 updating，却回
   * `phase:'available', running:false`，前端据此停掉轮询、重新点亮「更新到
   * 1.0.0」按钮 —— 后台还在替换文件。更新失败更糟：失败结果被下一次检查
   * 直接覆盖成 available。所以现在**检查缓存不许兼任更新运行状态**：
   * 只要有 updateState，GET 一律回它，既不回旧缓存也不打公网。 */
  let checkCache = null; // { at, payload }
  let checkInflight = null;
  let updateInflight = null;
  let updateState = null; // { phase, ctx, startedAt, result|null }
  let checkPhase = 'idle'; // 仅用于「检查」这条线（idle/checking/available/latest/failed）
  let lastError = null; // { code, error } —— 检查或更新的最近一次失败

  function currentVersionInfo(force = false) {
    if (typeof readVersion !== 'function') return { value: null, verification: 'unchecked' };
    try {
      const v = readVersion({ force }) || {};
      return { value: isVersionText(v.value) ? v.value.trim() : null, verification: v.verification || 'unchecked' };
    } catch {
      return { value: null, verification: 'unchecked' };
    }
  }

  /** 状态负载（固定字段集，永远是这几个 key）。 */
  function payload(extra = {}) {
    const base = {
      ok: true,
      phase: checkPhase,
      currentVersion: null,
      latestVersion: null,
      packageName: null,
      updateAvailable: false,
      verification: 'unchecked',
      canUpdate: false,
      reason: null,
      cached: false,
      running: Boolean(updateInflight),
    };
    return Object.fromEntries(
      STATUS_FIELDS.filter((k) => k in base || k in extra).map((k) => [k, k in extra ? extra[k] : base[k]])
    );
  }

  /**
   * 更新自身的状态负载。**GET 在更新期间与更新终态都必须走这里。**
   *
   * - 运行中：`running:true` + 真实相位（updating / verifying / restarting），
   *   版本沿用本次 update 的 context —— 让轮询能一直跟到结束。
   * - 终态：成功回 `latest` + `installedVersion`；失败回 `failed` + errorCode，
   *   两者都 `updateAvailable:false`（当前状态已经没有待更新的东西，
   *   或者已经失败 —— 都不能再显示「更新到 x」）。
   *
   * 参数 `st` 只给测试用（默认就是当前 `updateState`），方便直接验证
   * 「终态必须带 result」这条不变量而不必去改模块内部状态。
   */
  function updateStatusPayload(st = updateState) {
    const ctx = st ? st.ctx : null;
    const res = st ? st.result : null;
    if (updateInflight) {
      return payload({
        phase: (st && st.phase) || 'updating',
        currentVersion: ctx ? ctx.currentVersion : null,
        latestVersion: ctx ? ctx.latestVersion : null,
        packageName: PI_PACKAGE,
        updateAvailable: true,
        canUpdate: false,
        verification: (ctx && ctx.verification) || 'unchecked',
        reason: null,
        cached: false,
        running: true,
      });
    }
    /* 终态却没有 result = 状态机自相矛盾（正常路径走完 execute 后不可能出现，
     * 因为出口只有一个 `finishUpdate`）。**fail closed**：绝不能把「没有失败」
     * 当成成功报 `latest` —— 那正是「updater 一次都没跑却显示已是最新版本」。 */
    if (!res) {
      return payload({
        ok: false,
        phase: 'failed',
        currentVersion: ctx ? ctx.currentVersion : null,
        latestVersion: ctx ? ctx.latestVersion : null,
        packageName: PI_PACKAGE,
        updateAvailable: false,
        canUpdate: false,
        verification: (ctx && ctx.verification) || 'unchecked',
        reason: null,
        cached: false,
        running: false,
        errorCode: 'state-inconsistent',
        error: '这次更新没有留下终态结果，已按失败处理',
      });
    }
    const failed = res.ok === false;
    return payload({
      ok: !failed,
      phase: failed ? 'failed' : 'latest',
      currentVersion: (res && (failed ? res.currentVersion : res.installedVersion)) || null,
      latestVersion: res ? res.latestVersion : null,
      packageName: PI_PACKAGE,
      updateAvailable: false,
      canUpdate: false,
      verification: (res && res.verification) || (ctx && ctx.verification) || 'unchecked',
      reason: null,
      // 这不是「检查缓存」，是刚刚真的跑完的更新结果
      cached: false,
      running: false,
      ...(res && res.installedVersion ? { installedVersion: res.installedVersion } : {}),
      ...(failed ? { errorCode: res.code, error: res.error } : {}),
    });
  }

  /**
   * 检查有没有新版本。**单飞 + TTL 缓存**：并发调用只会打一次公网，
   * 失败一律不缓存（下次仍可重试），且永不抛。
   *
   * ⚠️ 只有「没有任何更新状态」或调用方**显式 force**（用户点「检查 Pi 更新」）
   * 时才会走公网检查。更新中 / 更新终态一律回 updateStatusPayload()。
   */
  function readStatus({ force = false } = {}) {
    if (updateInflight || (updateState && !force)) {
      return Promise.resolve(updateStatusPayload());
    }
    /* 显式 force = 用户主动要一次新检查：这时才允许把终态覆盖掉。 */
    if (force) updateState = null;
    if (isOffline(env)) {
      checkPhase = checkPhase === 'failed' ? 'failed' : checkPhase;
      return Promise.resolve(payload({ ok: false, code: 'offline', error: '离线模式：已跳过 Pi 版本检查', errorCode: 'offline' }));
    }
    if (!doFetch) {
      return Promise.resolve(payload({ ok: false, error: '当前环境没有可用的 fetch', errorCode: 'no-fetch' }));
    }
    if (checkCache && !force && now() - checkCache.at < ttlMs) {
      return Promise.resolve({ ...checkCache.payload, cached: true });
    }
    if (checkInflight) return checkInflight;

    checkPhase = 'checking';
    checkInflight = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await doFetch(LATEST_VERSION_URL, {
          method: 'GET',
          headers: {
            /* 只有这两条。不带 cookie / token / Referer，也不带任何本机信息。 */
            Accept: 'application/json',
            'User-Agent': `pi-gui/${String(guiVersion).replace(/[^\w.+-]/g, '')}`,
          },
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const code = err && err.name === 'AbortError' ? 'timeout' : 'network';
        checkPhase = 'failed';
        lastError = { code, error: code === 'timeout' ? '检查超时' : '网络不可用' };
        return payload({ ok: false, errorCode: code, error: lastError.error, phase: 'failed' });
      }
      clearTimeout(timer);
      if (!res || !res.ok) {
        checkPhase = 'failed';
        const code = 'http-error';
        lastError = { code, error: `检查失败（HTTP ${res ? res.status : '?'}）` };
        return payload({ ok: false, errorCode: code, error: lastError.error, phase: 'failed' });
      }
      let body;
      try {
        body = await res.json();
      } catch {
        checkPhase = 'failed';
        lastError = { code: 'invalid-response', error: '检查响应不是合法 JSON' };
        return payload({ ok: false, errorCode: 'invalid-response', error: lastError.error, phase: 'failed' });
      }
      /* 形状校验：ok / version / packageName 三者都要对。
       * packageName 陌生 → 直接判失败，**绝不**据此执行更新。 */
      if (!body || body.ok !== true || !isVersionText(body.version) || typeof body.packageName !== 'string') {
        checkPhase = 'failed';
        lastError = { code: 'invalid-response', error: '检查响应形状不认识' };
        return payload({ ok: false, errorCode: 'invalid-response', error: lastError.error, phase: 'failed' });
      }
      const packageName = body.packageName;
      const latestVersion = body.version.trim();
      if (packageName !== PI_PACKAGE) {
        checkPhase = 'failed';
        lastError = { code: 'foreign-package', error: '官方 endpoint 报的是另一个包，已忽略' };
        return payload({ ok: false, errorCode: 'foreign-package', error: lastError.error, phase: 'failed' });
      }
      const cur = currentVersionInfo();
      const updateAvailable = Boolean(cur.value && compareVersions(latestVersion, cur.value) === 1);
      const target = resolveTarget();
      const ok = payload({
        phase: updateAvailable ? 'available' : 'latest',
        currentVersion: cur.value,
        latestVersion,
        packageName,
        updateAvailable,
        verification: cur.verification,
        canUpdate: updateAvailable && target.ok,
        reason: !cur.value ? 'version-unknown' : (!updateAvailable ? 'latest' : (target.ok ? null : target.code)),
        checkedAt: new Date(now()).toISOString(),
      });
      checkPhase = ok.phase;
      checkCache = { at: now(), payload: ok };
      return { ...ok, cached: false };
    })().finally(() => {
      checkInflight = null;
    });
    return checkInflight;
  }

  /** 解析 updater 目标（官方 CLI 入口）。**证明不了就拒绝**，不退回 PATH。 */
  function resolveTarget() {
    if (typeof resolveUpdaterTarget !== 'function') return { ok: false, code: 'no-proven-entry' };
    try {
      const r = resolveUpdaterTarget();
      if (r && r.ok === true && r.entry) return { ok: true, entry: r.entry };
      return { ok: false, code: (r && r.code) || 'no-proven-entry' };
    } catch {
      return { ok: false, code: 'no-proven-entry' };
    }
  }

  /**
   * 更新前的全部闸门（**后端自己再查一遍**，不信前端 disabled）。
   * 通过则返回 {ok:true, ctx}，否则 {ok:false, code, error}。
   */
  async function prepare(body = {}) {
    if (body.confirm !== true) {
      return fail('confirm-required', '需要用户显式确认才能更新 Pi');
    }
    if (body.action !== undefined && body.action !== 'update') {
      return fail('bad-action', '不支持的动作');
    }
    if (updateInflight) {
      return fail('update-running', 'Pi 更新已经在进行中');
    }
    /* 工作区过期守卫（与 mcp-native 的 staleGuard 同一套）：前端把点按钮那一刻的
     * cwd 带上来，这里与后端当前 cwd 比一次。切项目会让 pi 以新 cwd 重启 ——
     * 那次重启期间去替换 runtime 文件是我要避免的。 */
    if (typeof currentCwd === 'function' && typeof body.__expectedCwd === 'string') {
      let nowCwd = '';
      try {
        nowCwd = currentCwd() || '';
      } catch {
        nowCwd = '';
      }
      if (body.__expectedCwd !== nowCwd) {
        return fail('workspace-stale', '工作区已经切换，请刷新后再试');
      }
    }
    if (isOffline(env)) return fail('offline', '离线模式：不会执行 Pi 更新');

    /* latest 必须重新确认，或用仍有效的可信缓存 —— 不采信前端传来的目标版本。
     *
     * 特例：上一次更新**失败**了（终态 failed）时，用户再点一次「更新」是明确的
     * 主动动作 —— 这时允许做一次新检查（同时把失败的终态替换掉）。**轮询的 GET
     * 不会这么做**（见 readStatus 的 force 语义），所以失败不会在轮询中被悄悄
     * 覆盖成 available。成功终态则照常走 no-update：已经是最新了。 */
    const failedTerminal = Boolean(updateState && updateState.result && updateState.result.ok === false);
    const status = await readStatus({ force: failedTerminal });
    if (!status || status.ok !== true) {
      return fail((status && status.errorCode) || 'check-failed', (status && status.error) || '无法确认最新版本');
    }
    const currentVersion = status.currentVersion;
    const latestVersion = status.latestVersion;
    if (typeof body.expectedCurrentVersion !== 'string' || body.expectedCurrentVersion !== currentVersion) {
      return fail('stale-current', '当前 Pi 版本已经变了，请刷新后再试', { currentVersion });
    }
    if (typeof body.expectedLatestVersion !== 'string' || body.expectedLatestVersion !== latestVersion) {
      return fail('stale-target', '最新版本信息已经变了，请刷新后再试', { latestVersion });
    }
    if (!status.updateAvailable) {
      return fail('no-update', '当前已经是最新版本，不需要更新');
    }
    /* 服务端闸门：正在生成的回合 / 跑着的计划 / 独立验证 / 在飞的 CLI 动作 /
     * 正在切项目 —— 任何一条命中都拒绝（原因由注入方给）。 */
    if (typeof busyReason === 'function') {
      let busy = null;
      try {
        busy = busyReason();
      } catch {
        busy = { code: 'busy-unknown', error: '无法确认当前是否空闲，已拒绝更新' };
      }
      if (busy && busy.code) return fail(busy.code, busy.error || '当前有任务在跑，已拒绝更新');
    }
    const target = resolveTarget();
    if (!target.ok) {
      return fail('unsupported', '当前这份 Pi 无法通过官方 self-update 更新（没有证明到它的官方安装入口）');
    }
    return {
      ok: true,
      ctx: {
        currentVersion,
        latestVersion,
        entry: target.entry,
        /* 目标版本在兼容矩阵里核过没有 —— 一路带到终态，界面据此显示未验收警告。 */
        verification: status.verification || 'unchecked',
      },
    };
  }

  /**
   * 更新执行的**唯一终态出口**。
   *
   * 契约：任何走过 `beginUpdate()` 的执行都必须在返回前经过这里落一个 result。
   * 否则会留下 `updateState != null && updateInflight == null && result == null`
   * 这个自相矛盾的状态，而 `updateStatusPayload()` 只能把它读成「没有失败」→
   * 报 `phase:'latest'`。那正是「updater 一次都没跑、界面却说已是最新版本」的
   * 形态：一个**假成功**，比报错危险得多。
   */
  function finishUpdate(result) {
    /* 这次结论已经产生，检查缓存到此为止（下次普通 GET 只回终态）。 */
    checkCache = null;
    if (updateState) {
      updateState.phase = result && result.ok === false ? 'failed' : 'latest';
      updateState.result = result;
    }
    if (!result || result.ok !== true) {
      lastError = {
        code: (result && result.code) || 'update-failed',
        error: (result && result.error) || '更新失败',
      };
    }
    return result;
  }

  /**
   * 真正执行更新（会被 prepare 已通过的 ctx 调用；也直接给测试用）。
   *
   * 结构上**只有一个出口**：所有分支都只给 `result` 赋值，最后由 `finishUpdate`
   * 统一落终态。暂停失败这类「一个字节都没改」的路径也必须落一个 failed 终态。
   */
  async function execute(ctx) {
    /* 固定参数，只此一份。**没有** --all / --extensions / --models。 */
    const args = ['update', '--self'];
    const setPhase = (p) => {
      if (updateState) updateState.phase = p;
    };
    let result = null;
    /* **只有我们真的暂停成功过**才由我们 resume：`pause-timeout` 自己已经回滚
     * 维护态，`already-in-maintenance` 是别人（另一次更新）的维护态 ——
     * 这两种情况再 resume 会掀掉不属于我们的状态。 */
    let ownsMaintenance = false;
    try {
      /* 暂停 bridge。**超时不算已停止**：`pause-timeout` 意味着旧 Pi 进程还活着，
       * 这时绝不能去替换它的运行时文件，所以直接放弃，一次 updater 都不跑。 */
      const pause = typeof pauseBridge === 'function' ? pauseBridge('pi-update') : { ok: true };
      const paused = await Promise.resolve(pause).catch(() => ({ ok: false, code: 'pause-failed' }));
      if (paused && paused.ok === false) {
        /* ⚠️ 这里**绝不能 return** —— 早先就是这里提前返回，绕过了终态写入，
         * GET 于是把「一次都没跑」报成 `phase:'latest'`。只赋值，出口留到最后。 */
        const code = paused.code === 'already-in-maintenance' ? 'update-running'
          : paused.code === 'pause-timeout' ? 'pause-timeout'
            : 'pause-failed';
        result = fail(code, code === 'pause-timeout'
          ? '旧 Pi 进程在超时前没有退出，已放弃更新（不会在它还活着时替换运行时）'
          : code === 'update-running'
            ? 'Pi 已经在维护中（可能是另一次更新），本次更新已放弃'
            : '无法暂停 Pi 进程，已放弃更新', {
          currentVersion: ctx.currentVersion,
          latestVersion: ctx.latestVersion,
        });
      } else {
        ownsMaintenance = true;
        setPhase('updating');
        let raw;
        try {
          /* entry 一路带过来：**只解析一次**，保证「闸门检查的那份 pi」与
           * 「真正被更新的那份 pi」是同一个对象（identity 同源）。 */
          raw = await runUpdater(args, { timeoutMs: updateTimeoutMs, maxStdoutBytes: MAX_OUTPUT_CHARS, entry: ctx.entry });
        } catch (err) {
          raw = { ok: false, spawnFailed: true, error: (err && err.message) || 'updater 启动失败' };
        }
        if (!raw || raw.ok !== true) {
          const code = raw && raw.timedOut ? 'update-timeout'
            : raw && raw.spawnFailed ? 'update-spawn-failed'
              : 'update-failed';
          result = fail(code, sanitizeLine((raw && (raw.error || raw.stderr)) || '官方 updater 没有成功结束'), {
            currentVersion: ctx.currentVersion,
            latestVersion: ctx.latestVersion,
          });
        } else {
          /* 退出码 0 ≠ 完成：清缓存 → 用**同一个 launch identity** 重新读版本。 */
          setPhase('verifying');
          if (typeof invalidateCaches === 'function') {
            try {
              invalidateCaches();
            } catch {
              /* 清缓存失败不该把已经成功的更新说成失败；下面的强制重读仍然会验 */
            }
          }
          const after = currentVersionInfo(true);
          const installedVersion = after.value;
          if (installedVersion !== ctx.latestVersion) {
            result = fail('verify-failed', `更新后读到的仍是 ${installedVersion || '未知版本'}，没有变成 ${ctx.latestVersion}`, {
              currentVersion: ctx.currentVersion,
              latestVersion: ctx.latestVersion,
              installedVersion,
            });
          } else {
            setPhase('restarting');
            result = {
              ok: true,
              phase: 'latest',
              currentVersion: installedVersion,
              installedVersion,
              latestVersion: ctx.latestVersion,
              verification: after.verification,
            };
          }
        }
      }
    } catch (err) {
      /* 兜底：任何意外都必须变成**明确失败**，不能把 result 留空。 */
      result = fail('update-failed', sanitizeLine((err && err.message) || '更新过程中出错'), {
        currentVersion: ctx.currentVersion,
        latestVersion: ctx.latestVersion,
      });
    } finally {
      /* 落地失败与失败都得恢复 bridge —— 但只恢复**我们自己**暂停的那次。 */
      if (ownsMaintenance && typeof resumeBridge === 'function') {
        try {
          resumeBridge();
        } catch {
          /* resume 自己炸了：不要盖掉真正的失败原因 */
        }
      }
    }
    return finishUpdate(result);
  }

  /** 起一次更新：把检查缓存让位给执行状态，然后后台跑。 */
  function beginUpdate(ctx) {
    checkCache = null;
    updateState = { phase: 'updating', ctx, startedAt: now(), result: null };
    updateInflight = execute(ctx).finally(() => {
      updateInflight = null;
    });
    return updateInflight;
  }

  /** 给 handle/测试用：prepare + execute，全程可 await。 */
  async function runUpdate(body = {}) {
    const pre = await prepare(body);
    if (!pre.ok) return pre;
    if (updateInflight) return fail('update-running', 'Pi 更新已经在进行中');
    return beginUpdate(pre.ctx);
  }

  /** 给 HTTP 用：确认/闸门都过了就**后台**跑，立刻回 202 语义的响应，前端轮询相位。 */
  async function startUpdate(body = {}) {
    const pre = await prepare(body);
    if (!pre.ok) return pre;
    if (updateInflight) return fail('update-running', 'Pi 更新已经在进行中');
    beginUpdate(pre.ctx);
    return { ok: true, accepted: true, phase: 'updating', latestVersion: pre.ctx.latestVersion, currentVersion: pre.ctx.currentVersion };
  }

  async function handle(req, res, url, json) {
    const method = req.method || 'GET';
    if (method === 'GET') {
      const force = url && url.searchParams.get('force') === '1';
      const status = await readStatus({ force });
      return json(res, 200, status);
    }
    if (method !== 'POST') {
      return json(res, 405, { ok: false, code: 'method-not-allowed', error: '只支持 GET / POST' });
    }
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return json(res, 400, { ok: false, code: 'bad-body', error: String(err.message || '请求体不是合法 JSON').slice(0, 120) });
    }
    const started = await startUpdate(body);
    if (!started.ok) return json(res, 200, started);
    return json(res, 202, started);
  }

  return {
    handle,
    readStatus,
    runUpdate,
    startUpdate,
    isRunning: () => Boolean(updateInflight),
    reset: () => {
      checkCache = null;
      checkInflight = null;
      updateState = null;
      lastError = null;
      if (!updateInflight) checkPhase = 'idle';
    },
    /**
     * 诊断/状态条用：**不发请求、不触发检查**，只看当前状态。
     * 更新中/终态优先（那才是「Pi 现在到底怎么样」），否则回最近一次检查缓存。
     */
    snapshot: () => {
      if (updateInflight || updateState) {
        const s = updateStatusPayload();
        return {
          phase: s.phase,
          currentVersion: s.currentVersion || null,
          latestVersion: s.latestVersion || null,
          updateAvailable: Boolean(s.updateAvailable),
          verification: s.verification || 'unchecked',
          canUpdate: Boolean(s.canUpdate),
          reason: s.reason || null,
          running: Boolean(s.running),
          cached: false,
          errorCode: s.errorCode || null,
        };
      }
      return {
        phase: checkPhase,
        currentVersion: (checkCache && checkCache.payload.currentVersion) || null,
        latestVersion: (checkCache && checkCache.payload.latestVersion) || null,
        updateAvailable: Boolean(checkCache && checkCache.payload.updateAvailable),
        verification: (checkCache && checkCache.payload.verification) || 'unchecked',
        canUpdate: Boolean(checkCache && checkCache.payload.canUpdate),
        reason: (checkCache && checkCache.payload.reason) || null,
        running: false,
        cached: Boolean(checkCache),
        errorCode: lastError ? lastError.code : null,
      };
    },
    _internals: {
      payload,
      updateStatusPayload,
      finishUpdate,
      prepare,
      execute,
      resolveTarget,
      isOffline: () => isOffline(env),
      /* 只读状态探针：给「终态必须带 result」这条不变量用（不改任何状态）。 */
      state: () => ({
        hasUpdateState: Boolean(updateState),
        phase: updateState ? updateState.phase : null,
        hasResult: Boolean(updateState && updateState.result),
        running: Boolean(updateInflight),
        checkPhase,
        hasCheckCache: Boolean(checkCache),
      }),
    },
  };
}

/** 读请求体（小 JSON）。单独放在这里，避免 pi-update 依赖 router 的实现细节。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
  });
}
