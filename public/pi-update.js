/* Pi 运行时更新（Built-in Pi Updater）的前端一半。
 *
 * 管的是**本机装着的那个 pi**（Pi GUI 的外部 runtime），不是 Pi GUI 自己。
 * Pi GUI 自己的版本检查在 `public/update.js`（`/api/update`）—— 两者刻意
 * 不共用状态、不共用文案：「Pi GUI」与「Pi」是两件不同的东西，混在一起说，
 * 用户根本不知道自己点下去会被升级的是哪一个。
 *
 * ---------- 一条界：检查可以自动，安装必须由人点 ----------
 *
 * 启动后延迟一次**只检查**（`GET /api/pi-update`，只读官方版本信息）。
 * 真正执行更新（`POST`）只从 `confirmAndRunPiUpdate()` 走：先弹确认框，
 * 用户点了「更新」（`=== true`）才发。`runPiUpdate()` 是不带弹框的那一半，
 * 给测试与「已经确认过」的调用方用 —— 它照样带 `confirm: true`，
 * 因为后端那道门是硬门，前端不该是唯一一道。
 *
 * ---------- 相位直接镜像后端，不在前端拼 ----------
 *
 * 后端的 `phase` 是单一真相（idle / checking / available / updating /
 * verifying / restarting / latest / failed）。前端**不**用几个 boolean 去猜
 * 「现在是不是在更新」—— 那种拼装必然长出「按钮说可以更新、其实正在更新」
 * 这类自相矛盾的界面。`busy` 只表示「这一刻有请求在飞，或更新正在跑」。
 *
 * 202 之后开始**轮询**：后端在后台跑 updater，相位会走 updating →
 * verifying → restarting。不轮询的话界面会永远停在「更新中…」，而且
 * 用户看不出到底卡在哪一步。轮询有次数上限，到点自己停，绝不无限打后端。
 *
 * ---------- 失败必须是可读的、可重试的 ----------
 *
 * 后端的错误文案已经脱敏（没有绝对路径、没有 updater 的原始输出），这里**原样**
 * 显示，不重写、不加工。任何失败都要把按钮恢复成可用状态并保留重试路径 ——
 * 「点了一下，然后什么都没有」是最糟的体验。
 *
 * ---------- 检查失败只影响这一块 ----------
 *
 * 离线 / 网络不可用 / 响应形状不认识，都只让这一块显示成失败：不弹崩溃提示、
 * 不碰聊天、不碰其它面板。自动那一次失败**完全静默**，且回到 idle
 * （不留一个用户没请求过的错误态）。
 */
import { fetchPiUpdate, postPiUpdate } from './api.js';
import { $ } from './state.js';
import { confirmModal } from './ui/modal.js';
import { toast } from './ui/toast.js';

/** 自动检查的启动延迟。不阻塞启动、不在启动瞬间请求（那时桥接正在拉起）。
 *  比 GUI 自己的检查（8s）再晚一点：pi 的版本探测要走一次 pi 包的读盘。 */
const AUTO_DELAY_MS = 12000;
/** 更新期间轮询相位：间隔与次数上限（200 × 2s ≈ 6.7 分钟）。
 *  上限必须**比后端自己的 updateTimeoutMs（5 分钟）宽**，否则会出现
 *  「后端还在跑、前端先放弃」的窗口 —— 那种时候界面上的按钮状态没人能说清。 */
const POLL_INTERVAL_MS = 2000;
const POLL_MAX = 200;
/** 这三个相位意味着「更新正在跑」：按钮禁用，并显示对应的动词。 */
const BUSY_PHASES = ['updating', 'verifying', 'restarting'];
const BUSY_TEXT = { updating: '更新中…', verifying: '验证中…', restarting: '重启中…' };
const BUSY_HINT = {
  updating: '正在执行官方 self-update（pi update --self）…',
  verifying: '更新命令结束了，正在核对新版本是否真的装上…',
  restarting: '新版本已就位，正在重新启动 Pi…',
};
/** 后端 `reason` 码 → 给人看的一句话。**「未知」不是「不支持」**：
 *  读不到版本号只是读不到，不能说人家没有新版。 */
const REASON_TEXT = {
  latest: '已是最新版本',
  'version-unknown': '读不到本机 Pi 的版本号，无法判断是否需要更新。',
  'no-proven-entry': '当前这份 Pi 无法通过官方 self-update 更新（没有证明到它的官方安装入口）。',
};
/** 后端 `errorCode` → 兜底文案（正常情况下后端已经给了 `error`，这里只防缺字段）。 */
const ERROR_TEXT = {
  offline: '离线模式：已跳过 Pi 版本检查',
  network: '网络不可用',
  timeout: '检查超时',
  'invalid-response': '检查响应不是预期的形状',
  'foreign-package': '官方版本接口报的是另一个包，已忽略',
};
/** 未验收警告。**必须与确认框里那句一字不差** —— 两处说的是同一件事。
 *  它不是拦截条件：未知能力是**安全降级**，不是不能用。 */
const UNVERIFIED_WARNING =
  '这个 Pi 版本尚未经过 Pi GUI 的完整兼容验收。更新后会重新进行能力探测，未知能力会安全降级。';

/* ---------- 状态 ---------- */

let phase = 'idle'; // 后端相位（本地镜像）
let currentVersion = '';
let latestVersion = '';
let updateAvailable = false;
let verification = 'unchecked'; // verified | unverified | unknown | unchecked
let canUpdate = false;
let reason = null; // 'latest' | 'version-unknown' | 'no-proven-entry' | null
let errorCode = '';
let errorText = '';
/** 这一刻有检查请求在飞。与 phase 分开：phase 是后端说的，这个是我们自己知道的。 */
let checking = false;
/** 更新正在跑（本地的 POST 在飞，或后端 `running === true`）。 */
let running = false;
/** 失败来自哪一半：check（可以「重试」）还是 update（重试的是更新按钮）。 */
let failedKind = '';
/** 递增请求号：挡「旧请求比新请求晚回来」造成的 stale UI。 */
let seq = 0;
/** 自动检查已经提示过的版本 —— 同一个版本只弹一次，不重复打扰。 */
let notifiedVersion = '';
/** 打开着的区块（诊断面板重绘时重新指向）。 */
let mounted = null;
/** 上一次渲染时拿到的「当前版本」兜底值（来自诊断快照的 d.pi.version）。
 *
 *  **必须有这一份**：检查失败时响应里可能没有 currentVersion，而重画时不带
 *  兜底值，标题就会从「Pi 0.99.2」退化成「Pi」—— 也就是「检查失败一次，
 *  当前版本就不见了」。update.js 踩过同一个坑（真实截图抓出来的）。 */
let fallbackVersionText = '';
let autoTimer = null;
let pollTimer = null;
let pollTicks = 0;

/** 展示用的相位。跑着的时候绝不允许降回非忙态：一次并发 GET 会把后端的
 *  phase 写成 available/latest（`readStatus` 用的是同一个变量），照抄就会让
 *  按钮从「更新中…」跳回「更新到 1.0.0」。 */
function displayPhase() {
  if (running && !BUSY_PHASES.includes(phase)) return 'updating';
  return phase;
}

/**
 * 清掉相位、在飞标记与轮询。
 *
 * 两个用途：
 *   1. **测试**要能在一个干净状态上驱动真实轮询（否则上一段的 pollTimer
 *      会继续吃下一段的桩，断言就变成「碰巧成立」）；
 *   2. 同一页面里重新装配面板时不要把上一次的相位带过来。
 * 不碰 `notifiedVersion`（那是「同一个版本只提醒一次」的会话级记忆）与
 * `mounted`（那是指向当前 DOM 的引用）。
 */
export function resetPiUpdate() {
  cancelPoll();
  seq += 1; // 让在飞的请求作废
  checking = false;
  running = false;
  pollTicks = 0;
  failedKind = '';
  phase = 'idle';
  currentVersion = '';
  latestVersion = '';
  updateAvailable = false;
  verification = 'unchecked';
  canUpdate = false;
  reason = null;
  errorCode = '';
  errorText = '';
  applyPiUpdateDot();
}

function isBusy() {
  return checking || running || BUSY_PHASES.includes(phase);
}

/** 供测试与其它模块读。返回副本，外部改不动内部状态。 */
export function getPiUpdateState() {
  return {
    phase: displayPhase(),
    currentVersion,
    latestVersion,
    updateAvailable,
    verification,
    canUpdate,
    reason,
    errorCode,
    error: errorText,
    busy: isBusy(),
  };
}

/* ---------- 工具 ---------- */

function node(tag, cls = '', text = '') {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== '') n.textContent = String(text);
  return n;
}

function button(label, cls = 'btn') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  return b;
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

/** 「更多」入口上的小点：有新版时亮一下，用户看得到入口在哪。
 *
 *  判据与 update.js 一样是**相位**而不是一个布尔：检查失败（failed）时小点
 *  必须熄灭 —— 否则「检查失败」的面板外面还亮着一颗「有新版本」的点，
 *  两处说的是两件事。 */
export function applyPiUpdateDot() {
  const dot = $('piUpdateDot');
  if (dot) dot.hidden = displayPhase() !== 'available';
}

function setState(next) {
  if ('phase' in next) phase = next.phase || phase;
  if ('currentVersion' in next) currentVersion = str(next.currentVersion);
  if ('latestVersion' in next) latestVersion = str(next.latestVersion);
  if ('updateAvailable' in next) updateAvailable = next.updateAvailable === true;
  if ('verification' in next) verification = str(next.verification) || verification;
  if ('canUpdate' in next) canUpdate = next.canUpdate === true;
  if ('reason' in next) reason = typeof next.reason === 'string' && next.reason ? next.reason : null;
  if ('errorCode' in next) errorCode = str(next.errorCode);
  if ('error' in next) errorText = str(next.error);
  applyPiUpdateDot();
  if (mounted && mounted.isConnected) paint(mounted);
}

/** 吸收一份 `GET /api/pi-update` 的载荷。字段缺失一律保留原值，不清零。 */
function absorbStatus(j) {
  const serverPhase = str(j.phase);
  const stillRunning = j.running === true || BUSY_PHASES.includes(serverPhase);
  /* 相位缺失（协议外的响应 / 测试桩）时不要停在 checking 上 —— 那会让按钮
   * 永远显示「检查中…」。用能确定的结论兜底。 */
  const fallback = j.updateAvailable === true ? 'available' : (str(j.latestVersion) ? 'latest' : 'idle');
  /* **先更新 running，再 setState**：setState 会同步重画，而重画读的是
   * displayPhase()（它看 running）。顺序反过来，最后一次「更新已经结束」的
   * 重画会拿着旧的 running=true 画成「更新中…」，然后永远停在那里。 */
  running = stillRunning;
  if (!running) cancelPoll();
  setState({
    phase: serverPhase || fallback,
    currentVersion: str(j.currentVersion),
    latestVersion: str(j.latestVersion),
    updateAvailable: j.updateAvailable === true,
    verification: str(j.verification),
    canUpdate: j.canUpdate === true,
    reason: typeof j.reason === 'string' && j.reason ? j.reason : null,
    errorCode: str(j.errorCode),
    error: str(j.error),
  });
}

/* ---------- 检查 ---------- */

async function runCheck({ auto = false, force = false } = {}) {
  /* 已经在检查就直接返回：连点不会打出一串请求。后端还有单飞，两层各自有效。 */
  if (checking) return getPiUpdateState();

  const my = ++seq;
  checking = true;
  failedKind = '';
  setState({ phase: 'checking', error: '', errorCode: '' });

  const j = await fetchPiUpdate(force);

  // 旧请求回来得比新请求晚 —— 直接丢弃，绝不拿它去覆盖更新的状态
  if (my !== seq) {
    checking = false;
    return getPiUpdateState();
  }
  checking = false;

  if (!j || j.ok === false) {
    /* 自动检查失败**完全静默**，并且回到 idle（不留一个用户没请求过的错误态）。
     * 手动检查则明确说失败 —— 绝不能显示成「已是最新版本」。 */
    if (auto) {
      setState({ phase: 'idle', error: '', errorCode: '' });
      return getPiUpdateState();
    }
    failedKind = 'check';
    setState({
      phase: 'failed',
      error: str(j && j.error) || ERROR_TEXT[str(j && j.errorCode)] || '暂时无法检查 Pi 更新',
      errorCode: str(j && j.errorCode),
    });
    return getPiUpdateState();
  }

  absorbStatus(j);
  if (auto && j.updateAvailable) notifyOnce(j.latestVersion);
  return getPiUpdateState();
}

/** 检查本机 Pi 有没有新版本。`force: true` 是**用户主动**点的那次：
 *  绕过缓存，失败要说出来。自动那一次（`force: false`）失败完全静默。 */
export function checkPiUpdate({ force = false } = {}) {
  return runCheck({ auto: !force, force });
}

/** 启动后的低打扰自动检查。只调一次；不阻塞启动。**只检查，绝不安装。** */
export function initPiUpdateAuto({ delayMs = AUTO_DELAY_MS } = {}) {
  if (autoTimer) return;
  autoTimer = setTimeout(() => {
    autoTimer = null;
    checkPiUpdate({ force: false }).catch(() => {
      /* 自动检查的任何异常都不该冒到控制台之外 —— 它本来就是可有可无的 */
    });
  }, delayMs);
}

/** 取消**尚未触发**的自动检查。
 *
 *  存在的理由与 update.js 的同名函数一样：自动检查是个延迟任务，而
 *  「什么时候轮到它」是环境相关的。需要确定性时序的调用方先把它取消掉，
 *  再自己决定何时检查。已经触发过的调用不受影响。 */
export function cancelPiUpdateAuto() {
  if (autoTimer) {
    clearTimeout(autoTimer);
    autoTimer = null;
  }
}

function notifyOnce(version) {
  if (!version || notifiedVersion === version) return;
  notifiedVersion = version;
  toast(`Pi ${version} 可用 —— 在「设置 → 应用与更新」里可以更新`, 'info');
}

/* ---------- 执行更新 ---------- */

function cancelPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function schedulePoll() {
  if (pollTimer || !running) return;
  pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
}

/* 更新在后台跑，相位只有后端知道。这里按固定的间隔问一次，直到
 * 「不在跑」或到达上限 —— 到上限不当成失败：后端还在跑就让它跑，
 * 界面停在后端最后给的相位上，用户下次打开面板会看到新的结论。 */
async function pollOnce() {
  pollTimer = null;
  if (!running) return;
  pollTicks += 1;
  if (pollTicks > POLL_MAX) {
    running = false;
    setState({});
    return;
  }
  const j = await fetchPiUpdate(false);
  if (!running) return;
  if (j && typeof j === 'object') {
    const serverPhase = str(j.phase);
    const stillRunning = j.running === true || BUSY_PHASES.includes(serverPhase);
    /* ⚠️ **`ok:false` 也可能是有效的轮询结果**：更新失败时后端按契约回
     * `ok:false + phase:'failed' + running:false + errorCode/error`。
     * 早先这里只认 `ok === true`，于是失败终态被丢掉、轮询继续跑，
     * 下一轮拿到的是「检查缓存/默认桩」的 available —— 真正的失败被覆盖成
     * 「有新版本可更新」，用户会看到一个假的可更新按钮。 */
    if (j.ok === true) {
      /* 相邻相位（verifying / restarting）只有轮询这里拿得到，采纳它们；
       * 但还在跑的时候不把忙态降级，理由见 displayPhase 的说明。 */
      absorbStatus(stillRunning && !BUSY_PHASES.includes(serverPhase) ? { ...j, phase } : j);
      if (!running) return;
    } else if (j.running === false || serverPhase === 'failed' || serverPhase === 'latest') {
      /* 终态：吸收它（absorbStatus 会把 running 置 false 并停掉轮询）。 */
      absorbStatus(j);
      return;
    }
  }
  schedulePoll();
}

/** 真发 POST。不带确认框 —— 调用方负责先拿到用户的明确同意。 */
export async function runPiUpdate() {
  if (running) return getPiUpdateState();
  const before = getPiUpdateState();

  const my = ++seq; // 让在飞的检查结果作废：它们说的是更新之前的事
  checking = false;
  running = true;
  failedKind = '';
  setState({ phase: 'updating', error: '', errorCode: '' });

  const j = await postPiUpdate({
    action: 'update',
    confirm: true,
    expectedCurrentVersion: before.currentVersion || '',
    expectedLatestVersion: before.latestVersion || '',
  });

  if (my !== seq) return getPiUpdateState();

  /* 后端只有两种回法：202 + accepted，或 200 + ok:false + code。
   * **只看 accepted**：ok:true 但没 accepted 不是「已开始」。 */
  if (!j || j.ok !== true || j.accepted !== true) {
    running = false;
    const code = str(j && j.code);
    failedKind = 'update';
    const next = {
      phase: 'failed',
      error: str(j && j.error) || 'Pi 更新没有开始',
      errorCode: code,
    };
    /* 拒绝可能带来新的事实（stale-current / stale-target 会回它认定的版本号）。
     * **只在真有值时才覆盖** —— 无条件写空串会把「更新到 1.1.0」这个按钮
     * 连同目标版本一起抹掉，用户就再也没有重试入口了。 */
    if (str(j && j.currentVersion)) next.currentVersion = j.currentVersion;
    if (str(j && j.latestVersion)) next.latestVersion = j.latestVersion;
    setState(next);
    toast(errorText || 'Pi 更新没有开始', 'error');
    return getPiUpdateState();
  }

  setState({
    phase: 'updating',
    currentVersion: str(j.currentVersion) || currentVersion,
    latestVersion: str(j.latestVersion) || latestVersion,
  });
  startPoll();
  return getPiUpdateState();
}

function startPoll() {
  cancelPoll();
  pollTicks = 0;
  schedulePoll();
}

function reasonText(s) {
  if (s.reason && REASON_TEXT[s.reason]) return REASON_TEXT[s.reason];
  if (s.updateAvailable && s.reason) return `当前这份 Pi 不能自动更新（${s.reason}）。`;
  /* 有新版、但说不出原因的兜底：只说「不能自动更新」，**绝不**说成
   * 「没有可更新的版本」—— 那和上面那行「新版本 X 可用」自相矛盾。 */
  if (s.updateAvailable) return '当前这份 Pi 不能自动更新。';
  if (s.reason) return `当前没有可更新的版本（${s.reason}）。`;
  return '当前没有可以更新的 Pi 版本。';
}

/** 用户点的那个动作：先确认，再更新。
 *
 *  读**当前**状态来拼确认框：里面的当前版本 / 目标版本必须和即将发出去的
 *  POST 是同一份，否则用户确认的是一个版本、更新的是另一个。
 *  只有 `=== true`（点了「更新」）才发；遮罩关闭 / Esc / 「取消」都算取消。 */
export async function confirmAndRunPiUpdate() {
  const s = getPiUpdateState();
  if (!s.canUpdate || !s.latestVersion) {
    /* 按钮本来只在 canUpdate 时出现；走到这里说明状态在两次点击之间变了
     * （后端刚发现入口证明不了 / 目标变了）。不去更新，但要说清为什么。 */
    toast(reasonText(s), 'info');
    return getPiUpdateState();
  }

  const lines = [
    '更新期间会暂时停止当前 Pi 进程，完成后自动重新启动。',
    '不会更新 Extension、模型目录或 Node。',
    `当前 Pi：${s.currentVersion || '未知'}`,
    `目标 Pi：${s.latestVersion}`,
  ];
  /* 未验收必须**先说**，而不是藏起来或当成拦截条件：目标版本不在兼容矩阵里
   * 时用户有权知道，然后自己决定 —— 更新后重做能力探测，未知能力安全降级。 */
  if (s.verification !== 'verified') lines.push(UNVERIFIED_WARNING);

  const answer = await confirmModal({
    title: `更新 Pi 到 ${s.latestVersion}？`,
    message: lines.join('\n'),
    okText: '更新',
    cancelText: '取消',
  });
  if (answer !== true) return getPiUpdateState();
  return runPiUpdate();
}

/* ---------- 渲染 ---------- */

/** 把 Pi 运行时区块画进给定容器。诊断面板每次重绘都会调它。
 *
 *  `fallbackCurrentVersion` 是诊断快照里的 `pi.version`：这一块与「版本真值」
 *  说的是同一个东西，取不到接口数据时也该显示得出来。 */
export function renderPiUpdateSection(container, fallbackCurrentVersion = '') {
  if (fallbackCurrentVersion) fallbackVersionText = str(fallbackCurrentVersion);
  container.appendChild(node('div', 'ext-sec-head', 'Pi'));
  const box = node('div', 'update-sec');
  container.appendChild(box);
  mounted = box;
  paint(box, fallbackVersionText);
  /* 面板打开时如果还什么都没查过，静默补一次 —— 否则用户看到的是一个
   * 没有结论的空区块。失败静默（force:false 就是自动那一条路径）。 */
  if (!isBusy() && phase === 'idle') {
    checkPiUpdate({ force: false }).catch(() => {
      /* 静默：失败会由状态自己收成 idle，不该冒出来 */
    });
  }
  return box;
}

function paint(box, fallbackVersion = fallbackVersionText) {
  box.innerHTML = '';
  const shown = currentVersion || fallbackVersion || '';
  const p = displayPhase();
  /* 「正在更新」的判据是 **running**，不是相位字符串：displayPhase() 保证
   * running 为真时 p 一定是三个忙相位之一。反过来不成立 —— 轮询放弃之后
   * 相位会停在 updating，那时不该再画一个禁用又说「更新中…」的按钮。 */
  const busyPhase = running;
  const busy = isBusy();
  const checkingNow = checking || p === 'checking';
  const failed = p === 'failed';
  applyPiUpdateDot();

  const headRow = node('div', 'update-head');
  headRow.appendChild(node('div', 'update-title', shown ? `Pi ${shown}` : 'Pi'));

  /* 手动检查。文案与 update.js 同一套（检查中… / 重试 / 检查 Pi 更新）——
   * 同一个动作在两个区块里说法不同，用户会以为是两件事。 */
  const checkBtn = button(
    checkingNow ? '检查中…' : failed && failedKind === 'check' ? '重试' : '检查 Pi 更新'
  );
  checkBtn.disabled = busy;
  checkBtn.title = '只检查本机 Pi 有没有新版本，不会自动安装';
  checkBtn.onclick = () => {
    checkPiUpdate({ force: true }).catch(() => {
      /* runCheck 内部已经把失败收成状态了，这里只兜底不抛 */
    });
  };
  headRow.appendChild(checkBtn);
  box.appendChild(headRow);

  /* 更新按钮单独一行，而且**只在真的能更新时出现**：
   * 它是这一块唯一的破坏性动作，和「检查」挤在同一行容易点错；
   * 不能更新时给一个灰按钮只会让人反复点。 */
  if (canUpdate && latestVersion) {
    const acts = node('div', 'update-acts');
    const up = button(busyPhase ? BUSY_TEXT[p] : `更新到 ${latestVersion}`, 'btn primary');
    up.disabled = busy;
    up.title = `用官方 self-update 把本机 Pi 更新到 ${latestVersion}`;
    up.onclick = () => {
      confirmAndRunPiUpdate().catch(() => {
        /* 确认与 POST 的失败都收成状态了，这里只兜底不抛 */
      });
    };
    acts.appendChild(up);
    box.appendChild(acts);
  }

  if (checkingNow) {
    box.appendChild(node('div', 'update-hint', '正在检查本机 Pi 的版本…'));
    return;
  }

  if (failed) {
    box.appendChild(node('div', 'update-hint warn', failedKind === 'update' ? 'Pi 更新没有成功' : '暂时无法检查 Pi 更新'));
    if (errorText) box.appendChild(node('div', 'diag-note', errorText));
    box.appendChild(
      node(
        'div',
        'update-hint',
        failedKind === 'update'
          ? '可以用「更新到」再试一次，或先「检查 Pi 更新」看看现在到底是什么状态。Pi GUI 的其它功能不受影响。'
          : '只影响这一块；网络恢复后点「重试」即可。Pi GUI 的其它功能不受影响。'
      )
    );
    return;
  }

  if (busyPhase) {
    box.appendChild(node('div', 'update-hint', BUSY_HINT[p]));
    box.appendChild(node('div', 'update-hint', '更新期间暂时发不出消息；完成后 Pi 会自动重新启动，会话与草稿都还在。'));
    return;
  }

  if (updateAvailable) {
    box.appendChild(node('div', 'update-hint ok', `新版本 ${latestVersion} 可用`));
    /* canUpdate 为假时**必须**说清为什么（例如「证明不到官方安装入口」）。
     * 这是「不猜、不静默降级」：做不到就说做不到，而不是留一个点不动的按钮。 */
    if (!canUpdate) box.appendChild(node('div', 'diag-note', reasonText({ reason, updateAvailable })));
    if (verification !== 'verified') {
      box.appendChild(node('div', 'diag-note', `该版本尚未经过 Pi GUI 的完整兼容验收（${verification}）；更新后会重新做能力探测。`));
    }
    return;
  }

  /* 没有可更新的新版本。三种情况要分得开：读不到版本 / 已是最新 / 还没查过。 */
  if (reason === 'version-unknown') {
    box.appendChild(node('div', 'update-hint', REASON_TEXT['version-unknown']));
    return;
  }
  if (latestVersion) {
    box.appendChild(node('div', 'update-hint', '已是最新版本'));
    return;
  }
  box.appendChild(
    node('div', 'update-hint', '检查本机 Pi（Pi GUI 驱动的外部程序）有没有新版本。只读取官方版本信息，不自动安装。')
  );
}
