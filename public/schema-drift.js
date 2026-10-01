/* P23：schema 漂移的**渲染进程侧**观察环。
 *
 * ---------- 这个模块解决什么 ----------
 *
 * 语义适配器遇到不认识的形状时，P18-Fix / P20 的策略是「安全降级」：忽略未知
 * 字段、关键字段缺失显示「结果不可用」、闭集外的枚举折成 unknown。策略是对的，
 * 但**降级是静默的** —— 上游哪天多了一个 `details.kind` 取值，界面只会从
 * 「Error: timeout」变成「Result details unavailable」，没人知道发生了什么。
 *
 * 后端已经有一份协议漂移记录（`server/pi-compat.js` 的 `category: 'schema'`）。
 * 但适配器跑在浏览器里，它们看到的东西后端看不到（后端不解析 tool result 的
 * details）。所以这里放一个小环，把**前端看到的**漂移也记下来，进诊断面板。
 *
 * ---------- 只记三样（硬规矩）----------
 *
 *   source —— 哪个适配器 / 哪条链路（我们代码里的字面量）
 *   field  —— **我们自己的**字段路径（`details.kind`），不是从数据里取的名字
 *   type   —— 值的 `typeof`（数组给长度）
 *
 * **不记值**。漂移记录是「上游变了」的提示，不是数据样本；tool result 里可能
 * 有用户内容。所以连对象键名都不记（那是从数据里取的名字）。
 *
 * 上限 20 条，环形 —— 一个畸形 payload 不该把诊断报告撑爆。
 */

const MAX_DRIFT = 20;
const items = [];

/** 只给 typeof（对象给 `object`，数组给长度）—— **绝不带值、不带键名**。 */
function typeOf(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/**
 * 记一条漂移。
 * @param source 适配器 / 链路名（字面量，例如 `'browser'`、`'tool'`）
 * @param field  我们代码里的字段路径（字面量，例如 `'details.kind'`）
 * @param value  那个值 —— **只取它的 typeof**
 * @param kind   `'unknown-field'` | `'unknown-enum-value'` | `'unknown-tool'`
 */
export function noteDrift(source, field, value, kind = 'unknown-field') {
  if (typeof source !== 'string' || !source) return;
  if (typeof field !== 'string' || !field) return;
  const resolvedKind = typeof kind === 'string' && kind ? kind : 'unknown-field';
  const type = typeOf(value);
  /* 去重：同一个 (来源, 字段, 类别, 类型) 只留一条。
   * updateEntry 会在一条工具调用的每个阶段都跑一遍，不去重的话环里会被
   * 同一条漂移刷满（20 条上限会因此挤掉其它真正不同的漂移）。 */
  if (items.some((item) => item.source === source && item.field === field && item.kind === resolvedKind && item.type === type)) {
    return null;
  }
  const entry = { at: Date.now(), source, field, kind: resolvedKind, type };
  items.push(entry);
  while (items.length > MAX_DRIFT) items.shift();
  return entry;
}

/** 上游多了一个我们没处理的字段。 */
export function noteUnknownField(source, field, value) {
  return noteDrift(source, field, value, 'unknown-field');
}

/** 上游给了一个闭集之外的枚举值。 */
export function noteUnknownEnum(source, field, value) {
  return noteDrift(source, field, value, 'unknown-enum-value');
}

/** 一个语义适配器都不认识的工具名（generic fallback 接管）。 */
export function noteUnknownTool(name) {
  return noteDrift('tool', 'name', name, 'unknown-tool');
}

/** 当前环内容（副本）。给诊断面板用。 */
export function driftSnapshot() {
  return items.map((item) => ({ ...item }));
}

/** 换项目 / 重启：旧 workspace 的观察没有意义。 */
export function resetDrift() {
  items.length = 0;
}
