/* 端口探测与导航判定 —— 从 main.cjs 里抽出来的**纯逻辑**。
 *
 * 为什么单独成文件：这几段逻辑决定了「窗口能不能指向一个陌生程序」和
 * 「一个链接能不能在应用里打开」，是本项目安全边界上最要紧的两处判断，
 * 但它们原先埋在 main.cjs 里 —— 而 main.cjs 一 require('electron') 就没法在
 * 普通 Node 下跑，于是这些判断一直**没有测试**，只能靠人肉 review。
 *
 * 抽出来之后，tests/electron-guard.cjs 可以直接用真实 HTTP 服务来验证：
 *   - 端口上是个陌生服务   → 必须判成 foreign-service（绝不能复用）
 *   - 端口上是本应用后端   → 判成 pi-gui
 *   - 端口上什么都没有     → 判成 not-running
 *   - `http://127.0.0.1:7788.evil.com` 这类前缀伪装 → 必须判成「不是自己」
 *   - 站外地址 / 危险 scheme → 不得交给系统浏览器（isSafeExternal）
 *   - 版本检查的 Release / 下载链接 → 必须 https + GitHub 官方 host（isSafeReleaseUrl）
 *
 * 本文件不依赖 electron，也不持有任何全局状态（APP_ID / PROTOCOL 是协议常量，
 * 双方必须一致，所以在这里定义并由 main.cjs 引用，避免两处各写一份写歪）。 */

'use strict';

const net = require('node:net');

/* 应用身份常量。必须与 server.js 的 /api/health 返回的一致 ——
 * 两边对不上就等于「这不是我的后端」，会走 foreign-service 分支。 */
const APP_ID = 'pi-gui';
const PROTOCOL = 1;

/** 端口上有没有人在听。只用来判断「要不要试着去探测」，本身不构成结论。 */
function isPortOpen(port, host = '127.0.0.1', timeout = 500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

/** 取一个 JSON 端点，返回 { ok, status, body, detail }。失败一律结构化，不抛。 */
async function getJson(url, timeout, headers) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'Cache-Control': 'no-store', ...headers } });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* 不是 JSON —— 对身份判定来说等价于「不是自己人」 */
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: null, detail: err.name === 'AbortError' ? '探测超时' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 把一次 /api/health 的探测结果判成状态。**纯函数**，因此可以直接单测。 */
function classifyHealth(health) {
  if (!health || !health.ok) {
    const status = health ? health.status : 0;
    const detail =
      (health && health.detail) || `HTTP ${status}${!health || health.body === null ? '（响应不是 JSON）' : ''}`;
    return { state: 'foreign-service', detail };
  }
  if (health.body?.app !== APP_ID) {
    return { state: 'foreign-service', detail: `app=${JSON.stringify(health.body?.app)}` };
  }
  if (health.body?.protocol !== PROTOCOL) {
    return { state: 'foreign-service', detail: `protocol=${JSON.stringify(health.body?.protocol)}` };
  }
  return { state: 'pi-gui', version: health.body.version, protocol: health.body.protocol };
}

/** 探测端口上的服务到底是谁。
 *
 * 三种状态：
 *   'not-running'     端口没人听 —— 可以自己起后端
 *   'pi-gui'          是本应用的后端 —— 直接复用
 *   'foreign-service' 端口被别的程序占了 —— **绝不能**把窗口指过去
 *
 * 为什么不能只看「端口通不通」（旧实现就是 `isPortOpen()` 一把梭）：
 * 任何程序都可能占用 7788。旧逻辑只要 connect 成功就认定「自己的后端已经在跑」，
 * 于是把一个陌生程序的页面加载进主窗口 —— 界面完全不对、所有 API 404，
 * 而用户看到的只是「Pi GUI 打开了一片奇怪的东西」，完全指不到真正的原因。 */
async function probe(origin, port, timeout = 900) {
  if (!(await isPortOpen(port, '127.0.0.1', timeout))) return { state: 'not-running' };
  return classifyHealth(await getJson(`${origin}/api/health`, timeout));
}

/** 这个 URL 是不是我们自己的页面。 */
function isSelfUrl(url, origin) {
  try {
    // 必须比 origin，不能比字符串前缀：`http://127.0.0.1:7788.evil.com`
    // 也「以 origin 开头」，用 startsWith 判断会把它当成自己人放行。
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** 只有 http / https 才交给系统浏览器。
 *
 * file: / javascript: / data: 一律不转发：交给系统浏览器要么毫无意义
 * （javascript: 会被多数浏览器直接丢弃），要么等于把本地文件或一段脚本
 * 递出去执行。未知 scheme 同样不转发 —— 认不出来的东西就不该有副作用。
 *
 * ⚠️ 这是**通用导航**的判据（对话里的链接、target=_blank 等），
 * 所以只卡 scheme、不卡 host。给「版本检查」用的更严的判据是下面的
 * isSafeReleaseUrl —— 别把两者合并：收窄这个会改变既有导航行为。 */
function isSafeExternal(url) {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

/* ---------- 版本检查（P5）用的外链白名单 ----------
 *
 * Release / 下载链接必须是 **https + GitHub 官方 host**。
 * 比 isSafeExternal 严一档的理由：这些 URL 来自**外部响应**
 * （GitHub API 返回的 `html_url` / `browser_download_url`）。仓库被投毒或账号
 * 被接管时，一个指向 evil.example 的下载链接会被用户当成官方安装包 ——
 * 所以后端会先过滤一遍（server/update-check.js），主进程这里**再拦一遍**。
 * 两边是两个独立的边界：后端过滤保护的是「不进 DOM」，这里保护的是
 * 「即便页面被注入脚本，也打不开站外地址」。
 *
 * ⚠️ 这份名单与 `server/update-check.js` 的 RELEASE_HOSTS 等价。
 * 为什么是两份而不是一份：那一边是 ESM、跑在后端进程里（会被 esbuild 打成一个
 * 单文件包），这一边是 CJS、跑在 Electron 主进程里。跨这两种运行时共享一个模块
 * 要么得把它塞进后端 bundle（把 Electron 代码拖进服务器）、要么得在运行时按
 * 相对路径 require（打包后路径不同）—— 代价都比这十行大。
 * 改一处必须同步改另一处，两边各有测试钉着。
 */
const RELEASE_HOSTS = ['github.com', 'api.github.com', 'githubusercontent.com'];
const GITHUBUSERCONTENT_SUFFIX = '.githubusercontent.com';

/** 这个 URL 能不能作为 Release / 下载链接交给系统浏览器。纯函数，不抛。 */
function isSafeReleaseUrl(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  // 带用户名/密码的 URL 不认 —— `https://evil@github.com/` 会被当成 github.com
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (RELEASE_HOSTS.includes(host)) return true;
  // 带点的后缀匹配，`evilgithubusercontent.com` 不会命中
  return host.endsWith(GITHUBUSERCONTENT_SUFFIX);
}

module.exports = {
  APP_ID,
  PROTOCOL,
  isPortOpen,
  getJson,
  classifyHealth,
  probe,
  isSelfUrl,
  isSafeExternal,
  isSafeReleaseUrl,
  RELEASE_HOSTS,
};
