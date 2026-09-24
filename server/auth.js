/* 本地访问控制。
 *
 * 这个服务的权限相当大：能把任意命令写进 pi 的 stdin（pi 自带 bash 工具）、
 * 能读写项目文件、能改 ~/.pi/agent/models.json、能接收文件上传。
 *
 * 「只监听 127.0.0.1」并不足够 —— CORS 只拦「读响应」，不拦「发请求」，
 * 所以用户浏览器里打开的任意网页都能向 127.0.0.1:7788 发 POST。
 * 于是加两层：
 *
 *   1. Origin 校验。带了 Origin 且不是自己人，直接拒。挡掉网页发起的跨站请求。
 *      只在自己这个端口上服务页面，所以「同源」= 自己人，判据很干净。
 *
 *   2. 共享令牌。桌面版由 Electron 生成 32 字节随机 token，经环境变量传进来，
 *      再由主进程用 webRequest 统一给发往本后端的请求加头 —— 于是 token
 *      不进页面、不进 URL、不进日志、不落盘。浏览器里根本拿不到它。
 *
 * 没设令牌时退化成「开发模式」：只做 Origin 校验，启动日志会明确写出来。
 * 这样 `npm start` 的纯浏览器开发流程完全不受影响。
 */
import crypto from 'node:crypto';
import { json } from './http-utils.js';

/** 令牌也可以走这个自定义头（Electron 的 webRequest 用它）。 */
export const TOKEN_HEADER = 'x-pi-gui-token';

/**
 * @param token      共享令牌。空字符串 = 开发模式（不做令牌校验）。
 * @param port       服务端口。用来算「自己人」的 Origin 集合。
 * @param appId      身份探测端点回报的应用标识。
 * @param protocol   身份探测端点回报的协议号。
 * @param version    身份探测端点回报的版本号。
 */
export function createAuth({ token, port, appId, protocol, version }) {
  const AUTH_TOKEN = String(token || '').trim();
  const SELF_ORIGINS = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  /** 定长比较，避免按字符前缀提前返回。长度不等直接判否。 */
  function tokenEquals(a, b) {
    const x = Buffer.from(String(a), 'utf8');
    const y = Buffer.from(String(b), 'utf8');
    if (x.length !== y.length) return false;
    return crypto.timingSafeEqual(x, y);
  }

  /** 返回 null 表示放行；否则返回 {code, error}。
   *  错误信息里**不回显**收到的值，也不回显令牌本身。 */
  function denyRequest(req) {
    const origin = req.headers.origin;
    if (origin && !SELF_ORIGINS.has(origin)) {
      return { code: 403, error: '拒绝来自其他站点的请求' };
    }
    if (!AUTH_TOKEN) return null;

    const header = req.headers[TOKEN_HEADER];
    const auth = String(req.headers.authorization || '');
    const bearer = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : '';
    const given = String((Array.isArray(header) ? header[0] : header) || bearer || '').trim();

    if (given && tokenEquals(given, AUTH_TOKEN)) return null;
    return { code: 401, error: '缺少或无效的访问令牌' };
  }

  /* 身份探测端点：**免认证**。
   *
   * Electron 要在「还没建立任何信任」之前就问出「这个端口上是不是 Pi GUI」，
   * 所以它必须无门槛 —— 否则拿不到令牌的探测请求会被 401，而 401 恰恰
   * 也是一个「不是随便什么服务」的信号，会让 foreign-service 的判定变模糊。
   * 这里暴露的信息只有应用名、协议号和版本号，不构成风险。 */
  function handleHealth(res) {
    return json(res, 200, { ok: true, app: appId, protocol, version });
  }

  return {
    denyRequest,
    handleHealth,
    /** 开发模式：没有配令牌，只校验来源。启动日志据此选文案。 */
    isDevMode: !AUTH_TOKEN,
  };
}
