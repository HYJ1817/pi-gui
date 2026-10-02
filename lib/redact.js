/* 脱敏：把「外部程序吐出来的一句话」压成可以贴进 issue 的形态。
 *
 * ---------- 为什么单独一个共享文件 ----------
 *
 * 这条规则原来只在 `server/pi-update.js` 里（`sanitizeLine`）。P24 的
 * Capability 安装也要走同一条边界 —— 官方 `pi install` 的输出里可能有绝对路径、
 * Bearer 头、npm token 形态。**两份正则迟早会分叉**，而分叉的那一份就是泄露面，
 * 所以搬到这里做唯一实现：Pi 更新与 Capability 安装都从这一处取。
 * （`server/pi-update.js` 继续 re-export 它，保持既有的公开名字不变。）
 *
 * ---------- 它做什么、不做什么 ----------
 *
 * 只做四件事，全部是「把值换成占位符」，**不解析、不结构化、不推断**：
 *   1. 只取第一行（多行摘要没有意义，而且更容易夹带正文）；
 *   2. 盘符路径与 /home|/Users|/root 开头的路径 → `<path>`；
 *   3. `Bearer <值>`（空格分隔的授权头）→ `Bearer <redacted>`；
 *   4. `token=xxx` / `api_key: xxx` 形态 → `<redacted>`；
 *   5. npm token 形态（`npm_` + 8 位以上）→ `<redacted>`。
 * 最后按 `max` 截断。**不保证穷尽**：这是「降低泄露面」，不是「保证无秘密」——
 * 所以调用方仍然不许把原始 stdout 交给 renderer。
 */

/** 默认截断长度（与 pi-update 原来的取值一致）。 */
export const MAX_ERROR_CHARS = 240;

export function sanitizeLine(text, max = MAX_ERROR_CHARS) {
  let out = typeof text === 'string' ? text : '';
  // 只取第一行：外部程序的输出可能很长，多行摘要没有意义
  out = out.split(/\r?\n/).find((l) => l.trim()) || '';
  out = out
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, '<path>')
    .replace(/\/(?:home|Users|root)\/[^\s"'`]+/g, '<path>')
    /* `Bearer <token>` 是空格分隔的（Authorization 头的形态），
     * 下面的 `key=value` 规则匹配不到它 —— 而它恰恰是最常见的凭据回显。 */
    .replace(/\bBearer\s+[^\s"'`]+/gi, 'Bearer <redacted>')
    .replace(/(Bearer|token|password|_authToken|api[_-]?key)\s*[=:]\s*\S+/gi, '$1=<redacted>')
    .replace(/npm_[A-Za-z0-9]{8,}/g, '<redacted>');
  return out.length > max ? out.slice(0, max) + '…' : out;
}
