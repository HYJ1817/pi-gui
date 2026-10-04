/* 内置浏览器的**纯判定**：地址归一化、导航放行、几何收敛。
 *
 * 为什么单独一个文件、而且不 require('electron')：
 * 和 net-probe.cjs 同一个理由 —— 这几条是「右栏里的网页能去哪里」的判据，
 * 是这一版最要紧的安全边界，但它们的宿主（browser-view.cjs）一 require electron
 * 就没法在普通 Node 下跑，于是只能靠人肉 review。抽成纯函数之后
 * tests/electron-guard.cjs 可以拿真值直接验。
 *
 * ⚠️ 这里**故意不复用** net-probe.cjs 的 isSafeWebUrl / isSafeExternal：
 * 那两条是「对话里的链接 / target=_blank 要不要交给系统浏览器」，判据是
 * 「http 或 https 就放行」—— 比内置浏览器**宽**得多。内置浏览器要的是
 * 「远程只能 https、http 只准回环」，还多一条「不许回 Pi GUI 自己」。
 * 两者的取值空间不同，合并成一份只会让其中一边失真。所以这里是**另一条规则**，
 * 名字也起得不一样（isAllowedBrowserUrl），改哪边都不会误伤另一边。 */

'use strict';

/* 内置浏览器用的 Electron session partition。
 *
 * **没有 `persist:` 前缀** = 非持久化（内存态）：cookie / cache / storage 不落盘，
 * 退出应用即清空。放在这个纯模块里而不是 browser-view.cjs，是为了让
 * tests/electron-guard.cjs 能验它 —— 那份测试跑在普通 Node 下，**不能**
 * require 到 electron。 */
const PARTITION = 'pi-gui-browser';

/** 主机名是不是本机回环。
 *
 * **必须精确比对**，不能用 endsWith / includes：
 *   localhost.evil.com / 127.0.0.1.evil.com 都「包含」本机名，
 *   但它们解析到的是别人的服务器 —— 那是标准的绕过手法。 */
function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/** 从「主机[:端口]」这种片段里认本机地址。
 *
 * 单独抽出来是因为 `localhost:3000` 会被 URL 的 scheme 语法**误当成**
 * 「scheme=localhost」。所以归一化时必须先判 host:port 的形状。 */
function isLoopbackHostPort(text) {
  const m = /^(\[[^\]]+\]|[^:/?#\s]+)(?::(\d+))?$/.exec(String(text || ''));
  if (!m) return false;
  return isLoopbackHost(m[1]);
}

/** 把地址栏里的一串文本归一成 URL 字符串。
 *
 * 规则（第一版）：
 *   example.com            → https://example.com        （远程默认 https）
 *   example.com:8080/x     → https://example.com:8080/x
 *   localhost:3000         → http://localhost:3000      （本机默认 http）
 *   127.0.0.1:5173         → http://127.0.0.1:5173
 *   [::1]:3000             → http://[::1]:3000
 *   https://… / http://…   → 原样
 *   file: / javascript: …  → 原样返回，**由 isAllowedBrowserUrl 拒掉**
 *
 * 注意这里只做「补全成 URL」，**不做放行判断** —— 放行统一由
 * isAllowedBrowserUrl 说了算，免得两处各判一半。 */
function normalizeAddressInput(input) {
  const text = String(input ?? '').trim();
  if (!text) return { ok: false, reason: '地址为空' };
  if (text.length > 8192) return { ok: false, reason: '地址过长' };

  if (/^https?:\/\//i.test(text)) return { ok: true, url: text };

  /* 先认 host:port —— 顺序不能反：`localhost:3000` 与 `example.com:8080`
   * 都长着 scheme 的样子，交给下面的 scheme 分支会被整条当 scheme。 */
  const head = text.split(/[/?#]/, 1)[0];
  if (isLoopbackHostPort(head)) return { ok: true, url: 'http://' + text };
  if (/^[^:/\s]+:\d+$/.test(head)) return { ok: true, url: 'https://' + text };

  /* 显式写了别的 scheme（file: / javascript: / data: / ftp: / chrome: …）。
   * 原样交给判定去拒 —— 归一化阶段不替它做决定。 */
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return { ok: true, url: text };

  return { ok: true, url: 'https://' + text };
}

/** 默认端口 —— 用来把「没写端口」和「写了默认端口」归一成同一个数。 */
function effectivePort(u) {
  if (u.port) return u.port;
  return u.protocol === 'https:' ? '443' : '80';
}

/** 这个 URL 是不是「Pi GUI 自己那台服务」。
 *
 * 只比 origin 是不够的：后端监听的是 127.0.0.1:7788，但同一台服务用
 * `localhost:7788` 或 `[::1]:7788` 一样访问得到，而它们的 origin 字符串
 * **各不相同**。只比 origin 就会漏掉这些写法 —— 用户手输 `localhost:7788`
 * 就绕过去了。
 *
 * 所以判据是「**回环主机 + 同一个端口**」。这比「等于原 origin」严一档，
 * 是有意的：内置浏览器没有任何理由去访问 Pi GUI 后端自己那个端口，
 * 而放过去的好处是零、代价是把本机 API 暴露给任意网页。
 *
 * （即便真被绕过，令牌那道边界仍然在 —— defaultSession 的 onBeforeSendHeaders
 *   不作用于浏览器的独立 partition，请求不带 X-Pi-Gui-Token，后端会 401。
 *   两道是不同层面的防线，这条管「能不能往那儿去」，不替代令牌。） */
function isSelfEndpoint(u, origin) {
  if (!origin) return false;
  let self;
  try {
    self = new URL(origin);
  } catch {
    return false;
  }
  if (u.origin === self.origin) return true;
  return isLoopbackHost(u.hostname) && effectivePort(u) === effectivePort(self);
}

/** 内置浏览器能不能导航到这个 URL。**纯函数**，不抛。
 *
 * 放行：
 *   https://任意              —— 远程只准 https
 *   http://localhost|127.0.0.1|[::1][:port]  —— 本机开发服务器（主要使用场景）
 * 拒绝：
 *   其它一切 http（明文远程）
 *   file: / javascript: / data: / vbscript: / ftp: / chrome: / devtools: / about: …
 *   带用户名密码的 URL
 *   **Pi GUI 自己那台服务**（含 localhost / [::1] 等同一端口的别名写法，
 *   尤其 /api/*）—— 即便用户手输也不放行
 *
 * @param {string} rawUrl
 * @param {{origin?: string}} ctx  Pi GUI 后端 origin（形如 http://127.0.0.1:7788） */
function isAllowedBrowserUrl(rawUrl, { origin } = {}) {
  if (typeof rawUrl !== 'string' || !rawUrl || rawUrl.length > 8192) return false;
  /* 空白与控制字符一律拒：`https://evil.com\n...` 这类要先把控制字符摘掉再去
   * 解析，才不会被 URL 解析器「宽容地」吞掉。这里直接拒，不做清理。 */
  if (/[\s\u0000-\u001f\u007f]/.test(rawUrl)) return false;

  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (isSelfEndpoint(u, origin)) return false;

  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return isLoopbackHost(u.hostname);
  return false;
}

/** 把渲染进程量出来的矩形收敛到窗口客户区里。
 *
 * WebContentsView 的几何来自 renderer 的 getBoundingClientRect()，
 * 而那是**页面算出来的数** —— 缩放 / 布局切换 / 竞态下可能拿到负数、
 * NaN 或者超出窗口的值。主进程必须自己再夹一次：
 * 负的原点会让 view 跑到窗口外面，超出的宽高会让它盖住工具栏。
 *
 * @param {{x?:number,y?:number,width?:number,height?:number}} rect
 * @param {{width:number,height:number}} content  BrowserWindow 的客户区尺寸 */
function clampBounds(rect, content) {
  const cw = Number.isFinite(content?.width) ? Math.max(0, Math.floor(content.width)) : 0;
  const ch = Number.isFinite(content?.height) ? Math.max(0, Math.floor(content.height)) : 0;

  const dim = (v, max) => {
    if (!Number.isFinite(v)) return 0;
    return Math.min(Math.max(0, Math.round(v)), max);
  };

  const x = dim(rect?.x, cw);
  const y = dim(rect?.y, ch);
  // 宽高还要再按「离右边/下边还剩多少」夹一次，否则 x=700 时 420 宽的 view 会溢出去
  const width = dim(rect?.width, Math.max(0, cw - x));
  const height = dim(rect?.height, Math.max(0, ch - y));
  return { x, y, width, height };
}

module.exports = {
  PARTITION,
  isLoopbackHost,
  isLoopbackHostPort,
  isSelfEndpoint,
  normalizeAddressInput,
  isAllowedBrowserUrl,
  clampBounds,
};
