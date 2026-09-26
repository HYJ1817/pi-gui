/* 版本检查（P5）。
 *
 * 回答一个问题：**本机这份 Pi GUI 有没有更新版？**
 *
 * 架构（renderer 不直接碰 GitHub）：
 *
 *     Renderer
 *        ↓  GET /api/update[?force=1]
 *     server/router.js
 *        ↓
 *     server/update-check.js   ← 本文件
 *        ↓  GET https://api.github.com/repos/HYJ1817/pi-gui/releases/latest
 *     GitHub
 *
 * ---------- 这一层刻意不做的事 ----------
 *
 * - **不自动下载、不自动安装、不静默升级、不改 exe、不重启。**
 *   只做「发现 + 展示 + 让用户自己点开 Release」。
 * - **不发 telemetry、不带任何凭据。** 请求里只有公开 GitHub API 必需的
 *   `User-Agent` 与 `Accept`，没有 token、没有安装 ID、没有设备 ID、
 *   没有 cwd / 项目名 / session / prompt / model / provider / 诊断内容。
 * - **不新增依赖。** 用全局 `fetch` + `AbortController` + `URL`（Node ≥ 22 自带）。
 *   没有 `semver`：版本比较是本文件里的纯函数，因为只需要「比大小 + 预发布优先级」
 *   这两条规则，而引入一个包要付随包分发与许可证的成本。
 *
 * ---------- 失败必须无害 ----------
 *
 * 任何失败（DNS / timeout / 403 / rate limit / 404 / 5xx / 非 JSON / 缺 tag_name /
 * 没有 Release / assets 为空）都只让**这一个接口**回 `ok:false`，
 * 不允许影响 server.js 启动、Electron 启动、pi bridge、会话、Git、Planner、
 * Diagnostics、附件或供应商 —— 所以这里所有异常都在模块内部收成结构化错误，
 * 绝不向上抛，也绝不写进程级的 unhandled rejection。
 */

import { json } from './http-utils.js';

/** 数据源固定为这一个仓库。**不做自定义更新服务器**（本轮明确不做）。 */
const GITHUB_REPO = 'HYJ1817/pi-gui';
const RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
/** 拼「查看 Release」兜底链接用。tag 会经 encodeURIComponent，不直接进 URL。 */
const RELEASE_TAG_BASE = `https://github.com/${GITHUB_REPO}/releases/tag/`;

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;
/** Release Notes 的最大展示长度。GitHub 的 body 是不可信外部 Markdown，不设上限
 *  等于把一整篇文档塞进弹层（还可能带上几万个链接）。 */
const MAX_NOTES_CHARS = 4000;
const MAX_ASSETS = 20;

/* ---------- 外链白名单 ----------
 *
 * Release / 下载链接必须是 **https + GitHub 官方 host**。别的 scheme 与第三方 host
 * 一律拒绝，连响应里都不出现（见 sanitizeRelease）。
 *
 * ⚠️ 这份名单在 `electron/net-probe.cjs` 里有一份**等价实现**，这是有意的：
 * 那一边是 CJS、跑在主进程（不受页面控制），这边是 ESM、跑在后端。
 * 两条链路是两个独立的边界，各自都要能独立拦住 —— 「两处一致」由
 * `tests/update-check.cjs` 与 `tests/electron-guard.cjs` 同时钉住。
 * 改这里时**必须同步改那边**。
 *
 * 为什么不是「只要 https 就行」：asset 的 URL 来自外部响应。仓库被投毒 / 账号被
 * 接管时，一个指向 evil.example 的 `browser_download_url` 会被用户当成官方下载。
 */
export const RELEASE_HOSTS = ['github.com', 'api.github.com', 'githubusercontent.com'];
const GITHUBUSERCONTENT_SUFFIX = '.githubusercontent.com';

/**
 * 这个 URL 能不能作为「Release / 下载」链接交给系统浏览器。
 * 纯函数，不抛异常 —— 非法输入返回 false。
 */
export function isSafeReleaseUrl(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  // 必须带用户名/密码的 URL 不认（`https://evil@github.com/` 这类伪装）
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (RELEASE_HOSTS.includes(host)) return true;
  /* `objects.githubusercontent.com` / `raw.githubusercontent.com` 这些是 GitHub
   * 官方下载重定向的落地域，属于同一棵 DNS 树。用后缀匹配（带点）而不是
   * `includes` —— 否则 `evilgithubusercontent.com` 也会被放行。 */
  return host.endsWith(GITHUBUSERCONTENT_SUFFIX);
}

/* ---------- SemVer ----------
 *
 * 支持：`0.11.0` / `v0.11.0` / `0.11.1` / `1.0.0` / `0.12.0-beta.1` / `0.12.0-rc.1`。
 * 也容忍 `1` 与 `1.2`（缺的段按 0），但**拒绝** `0.11.0.5` 这类多余段 ——
 * 「多出来的段被静默忽略」会让比较结果无声地错。
 *
 * 非法版本一律返回 null，由调用方决定怎么处理；**这里不抛异常**，
 * 因为「GitHub 上出现一个奇怪的 tag」不该把整个检查流程弄崩。
 */
const VERSION_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().replace(/^[vV]/, '');
  if (!s) return null;
  const m = VERSION_RE.exec(s);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] || 0),
    patch: Number(m[3] || 0),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

/**
 * 比较两个版本。返回 -1 / 0 / 1；任一边解析不了返回 **null**（不是 0 ——
 * 「不知道」和「一样大」是两件事，混起来会把非法版本判成「已是最新」）。
 *
 * 规则（semver 的核心子集）：
 *   1. major > minor > patch
 *   2. 有 prerelease 的**小于**同版本正式版
 *   3. prerelease 逐段比：数字段之间按数值比，数字段**小于**字母段，其余按字典序
 */
export function compareVersions(a, b) {
  const A = typeof a === 'string' ? parseVersion(a) : a;
  const B = typeof b === 'string' ? parseVersion(b) : b;
  if (!A || !B) return null;

  for (const key of ['major', 'minor', 'patch']) {
    if (A[key] !== B[key]) return A[key] < B[key] ? -1 : 1;
  }

  const ap = A.prerelease;
  const bp = B.prerelease;
  if (!ap.length && !bp.length) return 0;
  if (!ap.length) return 1; // 正式版 > 预发布
  if (!bp.length) return -1;

  const n = Math.max(ap.length, bp.length);
  for (let i = 0; i < n; i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === undefined) return -1; // 段数少的更小
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx !== dy) return dx < dy ? -1 : 1;
      continue;
    }
    if (xn !== yn) return xn ? -1 : 1; // 数字段 < 字母段
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 稳定用户要不要被提示「有新版」。 */
function isUpdateAvailable(current, latest) {
  const cmp = compareVersions(latest, current);
  if (cmp === null || cmp <= 0) return false;
  /* 稳定用户不提示 prerelease。
   *
   * GitHub 的 `/releases/latest` 本身就**不含 prerelease 与 draft**，
   * 所以这条是双保险 —— 它挡的是「有人把 prerelease 发成了正式 Release」
   * 以及以后换成 `releases` 列表接口的情况。
   * 当前版本本身就是 prerelease 的人不受这条限制（他在那条轨道上）。 */
  if (latest.prerelease.length && !current.prerelease.length) return false;
  return true;
}

/* ---------- 资产识别 ----------
 *
 * 命名规则取自**真实 Release 的 asset 名字**（HYJ1817/pi-gui 的 12 个 Release
 * 都是这三个）：
 *
 *     Pi-GUI-Setup-0.11.1.exe        安装程序
 *     Pi-GUI-0.11.1-portable.zip     便携版
 *     SHA256SUMS.txt                 校验和
 *
 * 刻意**不写死** `installer.exe` / `portable.zip`：真实名字带版本号。
 * 识别不出来的 asset **不给下载按钮**（宁可只留「查看 Release」，
 * 也不猜一个可能错的下载文件）。
 */
const ASSET_RULES = [
  { kind: 'installer', test: (n) => /setup|installer/i.test(n) && /\.exe$/i.test(n) },
  { kind: 'portable', test: (n) => /portable/i.test(n) && /\.zip$/i.test(n) },
  { kind: 'checksums', test: (n) => /sha256sums/i.test(n) },
];

/** 纯函数：给 asset 名字定类型。识别不出来回 'other'。 */
export function classifyAsset(name) {
  const n = String(name || '');
  if (!n) return 'other';
  for (const rule of ASSET_RULES) {
    if (rule.test(n)) return rule.kind;
  }
  return 'other';
}

/** 资产类型的中文标签。**单一真相**：前端不自己再维护一份映射。 */
export const ASSET_LABELS = { installer: '安装版', portable: '便携版', checksums: '校验和' };

/* ---------- 错误语义 ---------- */

/** 内部错误类型 → 用户可读文案。
 *  renderer **看不到**技术细节（状态码、header、堆栈），只看到这句话。 */
const ERROR_TEXT = {
  timeout: '暂时无法连接 GitHub（请求超时）',
  network: '暂时无法连接 GitHub',
  'rate-limit': 'GitHub 暂时限制了更新检查，请稍后再试',
  'github-error': 'GitHub 返回了异常响应，请稍后再试',
  'invalid-response': 'GitHub 返回了无法识别的 Release 信息',
  'no-release': '仓库上还没有已发布的 Release',
};

function failure(code) {
  const err = new Error(code);
  err.code = code;
  err.userText = ERROR_TEXT[code] || '暂时无法检查更新';
  return err;
}

function headerValue(res, name) {
  try {
    if (res && res.headers && typeof res.headers.get === 'function') return res.headers.get(name);
  } catch {
    /* header 拿不到不影响判定 */
  }
  return null;
}

/** 只留下「能给用户看」的字段。**外部响应的任何原始字段都不许直接透传。** */
function sanitizeRelease(body, tag) {
  const rawAssets = Array.isArray(body.assets) ? body.assets : [];
  const assets = [];
  let droppedAssets = 0;

  for (const a of rawAssets) {
    if (!a || typeof a !== 'object') {
      droppedAssets += 1;
      continue;
    }
    const name = typeof a.name === 'string' ? a.name.trim() : '';
    const url = typeof a.browser_download_url === 'string' ? a.browser_download_url : '';
    if (!name || !isSafeReleaseUrl(url)) {
      droppedAssets += 1;
      continue;
    }
    if (assets.length >= MAX_ASSETS) {
      droppedAssets += 1;
      continue;
    }
    assets.push({
      name: name.slice(0, 200),
      size: Number.isFinite(a.size) && a.size >= 0 ? a.size : null,
      url,
      kind: classifyAsset(name),
    });
  }

  const bodyText = typeof body.body === 'string' ? body.body : '';
  const notes = bodyText.slice(0, MAX_NOTES_CHARS);

  /* html_url 优先，但**必须过白名单**；过不了就用自己拼的 tag 链接兜底
   * （那个 URL 由常量 + encodeURIComponent(tag) 构成，天然安全）。
   * 绝不把未校验的 html_url 递给前端。 */
  const htmlUrl = typeof body.html_url === 'string' ? body.html_url : '';
  const url = isSafeReleaseUrl(htmlUrl) ? htmlUrl : RELEASE_TAG_BASE + encodeURIComponent(tag);

  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 200) : tag;

  return {
    name,
    tag,
    publishedAt: typeof body.published_at === 'string' ? body.published_at : null,
    notes,
    notesTruncated: bodyText.length > MAX_NOTES_CHARS,
    url,
    assets,
    droppedAssets,
  };
}

/* ---------- 模块 ---------- */

/**
 * @param version    当前 Pi GUI 版本。**必须由 server.js 注入**（版本号的唯一真相
 *                   在那里），本模块不自己读 package.json —— 否则打包形态下会多出
 *                   第二个版本来源，两边迟早对不上。
 * @param fetchImpl  可注入的 fetch。默认用全局 fetch；测试一律注入假实现，
 *                   所以**默认测试不访问真实公网**。
 * @param now        可注入的时钟，用来测 TTL 过期。
 * @param ttlMs      缓存有效期。
 * @param timeoutMs  单次请求超时。
 */
export function createUpdateCheck({
  version,
  fetchImpl,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const currentText = String(version || '0.0.0');
  const current = parseVersion(currentText) || { major: 0, minor: 0, patch: 0, prerelease: [] };
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;

  /** 内存缓存。**只缓存成功结果** —— 失败要能立刻重试，不能被缓存按住。 */
  let cache = null; // { at, payload }
  /** single-flight：同一个 Promise 被并发请求复用。 */
  let inflight = null;

  function buildSuccess(release, { cached }) {
    const latest = parseVersion(release.tag);
    const updateAvailable = latest ? isUpdateAvailable(current, latest) : false;
    return {
      ok: true,
      currentVersion: currentText,
      latestVersion: release.tag.replace(/^[vV]/, ''),
      updateAvailable,
      cached,
      /* 无更新时不带 release —— 前端没有可展示的东西，
       * 少传一份外部内容就少一份暴露面。 */
      ...(updateAvailable ? { release } : {}),
    };
  }

  function buildFailure(err) {
    return { ok: false, error: err.userText || '暂时无法检查更新', code: err.code || 'unknown' };
  }

  async function requestLatest() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(RELEASE_API, {
        signal: ctl.signal,
        /* 只有公开 GitHub API 必需的两项。没有 Authorization、没有 Cookie、
         * 没有 X-Pi-Gui-Token、没有任何自定义标识。 */
        headers: {
          'User-Agent': `pi-gui/${currentText}`,
          Accept: 'application/vnd.github+json',
        },
      });
    } catch (err) {
      throw failure(err && err.name === 'AbortError' ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }

    if (!res || typeof res.status !== 'number') throw failure('network');

    if (res.status === 404) throw failure('no-release');
    if (res.status === 403 || res.status === 429) {
      /* 403 既可能是「限流」也可能是「被拒」。用 x-ratelimit-remaining 区分 ——
       * 但**只用来选错误类型**，header 本身绝不进响应。 */
      const remaining = headerValue(res, 'x-ratelimit-remaining');
      throw failure(remaining === '0' ? 'rate-limit' : 'github-error');
    }
    if (res.status < 200 || res.status >= 300) throw failure('github-error');

    let body;
    try {
      body = await res.json();
    } catch {
      throw failure('invalid-response');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('invalid-response');

    const tag = typeof body.tag_name === 'string' ? body.tag_name.trim() : '';
    if (!tag) throw failure('invalid-response');
    if (!parseVersion(tag)) throw failure('invalid-response');

    return sanitizeRelease(body, tag);
  }

  /**
   * 拿一份更新检查结果。
   *
   * - `force` 为假：TTL 内直接复用缓存
   * - `force` 为真：绕过缓存
   * - 无论哪种，**只要已有请求在飞就复用它**（single-flight）——
   *   三个并发的 `force=1` 只真正请求 GitHub 一次。
   */
  async function readUpdate({ force = false } = {}) {
    if (!force && cache && now() - cache.at < ttlMs) {
      return { ...cache.payload, cached: true };
    }
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        const release = await requestLatest();
        const payload = buildSuccess(release, { cached: false });
        cache = { at: now(), payload };
        return payload;
      } catch (err) {
        /* 失败不写缓存、不抛 —— 调用方永远拿到一个结构化结果。 */
        return buildFailure(err && err.code ? err : failure('network'));
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  }

  function handle(req, res, url) {
    if (req.method !== 'GET') {
      return json(res, 405, { ok: false, error: 'Method not allowed' });
    }
    let force = false;
    try {
      force = url && url.searchParams ? url.searchParams.get('force') === '1' : false;
    } catch {
      force = false;
    }
    /* 永远回 200：HTTP 层这次调用是成功的，「检查失败」是**业务结果**，
     * 用 5xx 表示会让前端把它当成后端故障。 */
    return readUpdate({ force }).then((payload) => json(res, 200, payload));
  }

  return {
    handle,
    readUpdate,
    /** 仅供测试与调试：清掉缓存。 */
    clearCache() {
      cache = null;
    },
    currentVersion: currentText,
    releaseApi: RELEASE_API,
    ttlMs,
  };
}
