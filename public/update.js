/* 版本检查与更新体验（P5）。
 *
 * 只做**发现**：查 GitHub 上有没有新的稳定 Release → 展示版本与发布说明 →
 * 用户自己点开 Release / 下载页。**不下载、不安装、不静默升级、不重启。**
 * 下载交给系统浏览器（安全边界最简单，见 docs/updates.md）。
 *
 * ---------- 状态只有一个 ----------
 *
 * `status` 是单一字段：idle / checking / latest / available / error。
 * 刻意**不用几个互相冲突的 boolean 拼** —— `loading && hasUpdate && !error`
 * 这种组合有 8 种取值，其中一半没有意义，而「网络失败显示成已是最新版」
 * 正是从这种状态拼装里长出来的。
 *
 * ---------- 手动与自动共用同一套状态与缓存 ----------
 *
 * 自动检查（启动后延迟一次）和手动检查走的是同一个 runCheck()，只是
 * `auto` 为真时：失败完全静默、无更新完全静默、有更新才给一次轻提示。
 *
 * ---------- Release Notes 是不可信外部 Markdown ----------
 *
 * 复用 public/markdown.js（先整体转义再插白名单标签，XSS 在语法层面不成立），
 * **绝不** `innerHTML = release.body`。除此之外这里还多做一件事：
 * 笔记里的链接点击被拦下，改走同一套外链白名单 —— 否则一条
 * 「[点这里领奖](https://evil.example)」就能把用户引到站外。
 */

import { fetchUpdate } from './api.js';
import { md } from './markdown.js';
import { $ } from './state.js';
import { toast } from './ui/toast.js';

/** 与后端 server/update-check.js 的 MAX_NOTES_CHARS 一致（后端已截断，这里兜底）。 */
const MAX_NOTES = 4000;
/** 资产类型 → 中文标签。**与后端 ASSET_LABELS 一致**；认不出的类型不显示按钮。 */
const ASSET_LABELS = { installer: '安装版', portable: '便携版', checksums: '校验和' };
/** 自动检查的启动延迟。不阻塞启动、不在启动瞬间请求（那时 pi 桥接正在拉起）。 */
const AUTO_DELAY_MS = 8000;

/* ---------- 状态 ---------- */

let status = 'idle'; // idle | checking | latest | available | error
let currentVersion = '';
let latestVersion = '';
let release = null;
let errorText = '';
/** 递增请求号：挡「旧请求比新请求晚回来」造成的 stale UI。 */
let seq = 0;
/** 自动检查已经提示过的版本 —— 同一个版本只弹一次，不重复打扰。 */
let notifiedVersion = '';
/** 打开着的更新区块（诊断面板重绘时重新指向）。 */
let mounted = null;
/** 上一次渲染时拿到的「当前版本」兜底值（来自诊断快照的 app.version）。
 *
 * **必须有这一份**：`/api/update` 失败时响应里没有 currentVersion，而
 * setState() 会重画 —— 如果重画时不带上兜底值，标题就会从
 * 「Pi GUI v0.12.0」退化成「Pi GUI」，也就是「检查失败一次，当前版本就消失了」。
 * 这个缺陷是真实截图抓出来的：无网那轮里失败后标题真的丢了版本号。 */
let fallbackVersionText = '';
let autoTimer = null;

function snapshot() {
  return { status, currentVersion, latestVersion, release, error: errorText };
}

/** 供测试与其它模块读。返回副本，外部改不动内部状态。 */
export function getUpdateState() {
  return snapshot();
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

/** 「诊断」侧栏项上的小点：有新版时亮一下，用户看得到入口在哪。 */
function applyDot() {
  const dot = $('updateDot');
  if (dot) dot.hidden = status !== 'available';
}

function setState(next) {
  if ('status' in next) status = next.status;
  if ('currentVersion' in next) currentVersion = next.currentVersion || '';
  if ('latestVersion' in next) latestVersion = next.latestVersion || '';
  if ('release' in next) release = next.release || null;
  if ('error' in next) errorText = next.error || '';
  applyDot();
  if (mounted && mounted.isConnected) paint(mounted);
}
/* ---------- 外链 ----------
 *
 * 页面只能说「请打开这个 URL」，**能不能打开由主进程决定**
 * （electron/main.cjs 的 pi-gui:open-external → net-probe.cjs 的
 * isSafeReleaseUrl：https + GitHub 官方 host）。页面从来不持有 shell 能力。
 *
 * 这里只做一层很薄的 scheme 预检，为的是网页版（npm start，没有主进程可转发）
 * 那条回退分支 —— 那种情况下浏览器是唯一的边界，而它只认 https 才安全。
 * **host 白名单的权威判定在主进程，不在页面。**
 */
export async function openExternal(url) {
  const target = String(url || '');
  if (!/^https:\/\//i.test(target)) {
    toast('已拒绝打开非 https 链接', 'warn');
    return { ok: false, error: '已拒绝打开非 https 链接' };
  }

  const bridge = globalThis.piGuiDesktop;
  if (bridge && typeof bridge.openExternal === 'function') {
    let r;
    try {
      r = await bridge.openExternal(target);
    } catch (err) {
      r = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    if (!r || r.ok !== true) {
      toast((r && r.error) || '打开失败', 'warn');
      return { ok: false, error: (r && r.error) || '打开失败' };
    }
    return { ok: true };
  }

  /* 网页版没有主进程。退化成新标签页 —— 不用 window.open，因为桌面版把
   * window.open 一律 deny（见 hardenWebContents），用 <a> 的语义更直白，
   * 也不会在两个形态下走出两套行为。 */
  try {
    const a = document.createElement('a');
    a.href = target;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return { ok: true };
  } catch {
    toast('请在浏览器里打开：' + target, 'info');
    return { ok: false, error: '无法自动打开' };
  }
}

/* ---------- 检查 ---------- */

async function runCheck({ auto = false, force = false } = {}) {
  /* 已经在检查就直接返回：连点不会打出一串请求，也不会出现「后发的先回」。
   * 后端还有一层 single-flight，两层各自独立有效。 */
  if (status === 'checking') return snapshot();

  const my = ++seq;
  setState({ status: 'checking' });

  const j = await fetchUpdate(force);

  // 旧请求回来得比新请求晚 —— 直接丢弃，绝不拿它去覆盖更新的状态
  if (my !== seq) return snapshot();

  if (!j || j.ok === false) {
    /* 自动检查失败**完全静默**，并且回到 idle（不留一个用户没请求过的错误态）。
     * 手动检查则明确说「检查失败」—— 绝不能显示成「已是最新版」。 */
    if (auto) {
      setState({ status: 'idle', error: '' });
      return snapshot();
    }
    setState({ status: 'error', error: (j && j.error) || '暂时无法检查更新' });
    return snapshot();
  }

  setState({
    status: j.updateAvailable ? 'available' : 'latest',
    currentVersion: j.currentVersion || '',
    latestVersion: j.latestVersion || '',
    release: j.release || null,
    error: '',
  });

  if (auto && j.updateAvailable) notifyOnce(j.latestVersion);
  return snapshot();
}

/** 手动检查：绕过缓存，失败要说出来。 */
export function checkForUpdate() {
  return runCheck({ auto: false, force: true });
}

/** 启动后的低打扰自动检查。只调一次；不阻塞启动。 */
export function initUpdateAuto({ delayMs = AUTO_DELAY_MS } = {}) {
  if (autoTimer) return;
  autoTimer = setTimeout(() => {
    autoTimer = null;
    runCheck({ auto: true }).catch(() => {
      /* 自动检查任何异常都不该冒到控制台之外 —— 它本来就是可有可无的 */
    });
  }, delayMs);
}

/** 取消**尚未触发**的自动检查。
 *
 * 存在的理由：自动检查是个延迟任务，而「什么时候轮到它」是环境相关的
 * （慢机器上 8 秒可能落在别的事情中间）。需要确定性时序的调用方
 * （前端冒烟测试、以后可能的「用户已经手动检查过了」优化）先把这
 * 一次取消掉，再自己决定何时检查。已经触发过的调用不受影响。 */
export function cancelUpdateAuto() {
  if (autoTimer) {
    clearTimeout(autoTimer);
    autoTimer = null;
  }
}

function notifyOnce(version) {
  if (!version || notifiedVersion === version) return;
  notifiedVersion = version;
  toast(`Pi GUI v${version} 已发布 —— 详情见侧栏「诊断」`, 'info');
}

/* ---------- 渲染 ---------- */

/** 把「版本与更新」区块画进给定容器。诊断面板每次重绘都会调它。 */
export function renderUpdateSection(container, fallbackVersion = '') {
  if (fallbackVersion) fallbackVersionText = fallbackVersion;
  container.appendChild(node('div', 'ext-sec-head', '版本'));
  const box = node('div', 'update-sec');
  container.appendChild(box);
  mounted = box;
  paint(box, fallbackVersionText);
  return box;
}

/* 默认值取 fallbackVersionText，而不是空串 —— setState() 里的
 * `paint(mounted)` 只有两个参数可传（没地方再传兜底版本），
 * 所以兜底值必须存在模块作用域里。见 fallbackVersionText 的说明。 */
function paint(box, fallbackVersion = fallbackVersionText) {
  box.innerHTML = '';
  const shown = currentVersion || fallbackVersion || '';
  applyDot();

  const head = node('div', 'update-head');
  head.appendChild(node('div', 'update-title', shown ? `Pi GUI v${shown}` : 'Pi GUI'));

  const busy = status === 'checking';
  const btn = button(busy ? '检查中…' : status === 'error' ? '重试' : '检查更新');
  btn.disabled = busy;
  btn.onclick = () => {
    checkForUpdate().catch(() => {
      /* runCheck 内部已经把失败收成状态了，这里只兜底不抛 */
    });
  };
  head.appendChild(btn);
  box.appendChild(head);

  if (status === 'checking') {
    box.appendChild(node('div', 'update-hint', '正在检查更新…'));
    return;
  }

  if (status === 'error') {
    box.appendChild(node('div', 'update-hint warn', '暂时无法检查更新'));
    if (errorText) box.appendChild(node('div', 'diag-note', errorText));
    box.appendChild(
      node('div', 'update-hint', 'Pi GUI 的其它功能不受影响。网络恢复后点「重试」即可。')
    );
    return;
  }

  if (status === 'latest') {
    box.appendChild(node('div', 'update-hint', '当前已是最新版本'));
    box.appendChild(node('div', 'update-sub', shown ? `v${shown}` : ''));
    return;
  }

  if (status !== 'available' || !release) {
    box.appendChild(
      node('div', 'update-hint', '在应用内检查 GitHub 上有没有新版本。只读取公开的发布信息，不上传任何使用数据。')
    );
    return;
  }

  paintAvailable(box, shown);
}

function paintAvailable(box, shownVersion) {
  box.appendChild(node('div', 'update-hint ok', `发现新版本 v${latestVersion || release.tag || ''}`));
  box.appendChild(node('div', 'update-sub', `当前版本 v${shownVersion || '未知'}`));
  if (release.publishedAt) {
    box.appendChild(node('div', 'update-sub', `发布时间：${formatTime(release.publishedAt)}`));
  }

  const notes = typeof release.notes === 'string' ? release.notes.slice(0, MAX_NOTES) : '';
  if (notes.trim()) {
    box.appendChild(node('div', 'update-label', '更新内容：'));
    const notesEl = node('div', 'update-notes msg-body');
    /* 复用项目已有的安全渲染器（先整体转义、再插白名单标签）。
     * 本文件里往 innerHTML 写**内容**只有这一处，且来源是 md() 的返回值，
     * 不是外部原文 —— 绝不 `innerHTML = release.body`。 */
    notesEl.innerHTML = md(notes);
    /* 笔记里的链接同样要过外链白名单 —— 否则一条恶意 release note 里的
     * 「[点这里](https://evil.example)」就能把用户引到站外。 */
    notesEl.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a') : null;
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      openExternal(a.getAttribute('href'));
    });
    box.appendChild(notesEl);
    if (release.notesTruncated) {
      box.appendChild(node('div', 'diag-note', '发布说明过长，已截断。完整内容见 Release 页面。'));
    }
  }

  const acts = node('div', 'update-acts');
  if (release.url) {
    const open = button('查看 Release', 'btn');
    open.onclick = () => openExternal(release.url);
    acts.appendChild(open);
  }

  /* 只给**识别出来**的资产下载按钮（安装版 / 便携版 / 校验和）。
   * 认不出来的不给按钮 —— 宁可只留「查看 Release」，也不猜一个可能错的下载文件。 */
  const assets = Array.isArray(release.assets) ? release.assets : [];
  let shownAssets = 0;
  for (const a of assets) {
    const label = ASSET_LABELS[a && a.kind];
    if (!label || !a.url) continue;
    shownAssets += 1;
    const b = button(label, 'btn primary');
    b.title = a.name || label;
    b.onclick = () => openExternal(a.url);
    acts.appendChild(b);
  }
  if (acts.children.length) box.appendChild(acts);

  if (assets.length > shownAssets) {
    box.appendChild(
      node(
        'div',
        'diag-note',
        `另有 ${assets.length - shownAssets} 个文件未自动识别，请在 Release 页面查看。`
      )
    );
  }
}

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
