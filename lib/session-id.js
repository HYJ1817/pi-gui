/* 会话 id 的**唯一**校验处。
 *
 * 为什么值得单独一个文件：同一个约束现在有两个消费者，而且它们分处两个模块 ——
 *   - `server/planner/model.js` 拼 id 时要保证合法（拼出来不合法就不能交给 pi）；
 *   - `server/sessions.js` 收到前端传来的 sessionId 时要先挡一道（它来自 HTTP，
 *     是不可信输入，绝不能直接拿去找文件）。
 * 两边各写一份正则，迟早会漂 —— 而这里漂掉的后果很具体：一边允许的字符另一边
 * 认为非法，于是「界面能点、后端说找不到」。
 *
 * 约束本身**不是我们定的**，是从 pi 抄来的（`dist/bundle/chunks/chunk-4DKZACXI.js`
 * 的 `assertValidSessionId`）：
 *
 *     /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
 *
 * 它必须被遵守，因为 pi 的 `validateSessionIdFlags` 在 id 非法时**直接
 * `process.exit(1)`** —— 也就是说，传一个带非法字符的 `--session-id` 会让任务
 * 在启动阶段就死掉，而报错内容跟「会话」这件事看起来毫无关系。
 *
 * 另外注意：这个字符集**天然排除了路径**（没有 `/`、`\`、`:`），所以「只接受
 * 稳定 id、不接受路径」这条安全要求是它的副产品，不需要再单独挡一次。
 * 但长度要自己限 —— 正则不限制长度。
 */
export const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
export const MAX_SESSION_ID = 120;

/** 是不是一个「可以安全落盘 / 可以交给 pi / 可以拿去查文件」的会话 id。 */
export function isSafeSessionId(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_SESSION_ID && SESSION_ID_RE.test(v);
}

/**
 * 把一个**想要**的字符串削成合法的会话 id（不合法就返回 ''）。
 * 用在「我们自己拼 id」的场景：拼出来的东西必须能交给 pi。
 */
export function toSafeSessionId(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, MAX_SESSION_ID)
    .replace(/[^A-Za-z0-9]+$/, ''); // 截断可能把尾巴切在分隔符上，再削一次
  return isSafeSessionId(s) ? s : '';
}
