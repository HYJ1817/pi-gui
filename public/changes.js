/* 文件变更账本 —— 为后续的 Diff / Git 功能预留的落点。
 *
 * 这一版**不做任何 UI**，只干一件事：把「本次会话里哪些文件被改动过」
 * 按顺序累积起来，并通过 onChanges() 暴露一个订阅点。
 * 将来加「变更文件列表 → 逐文件 diff → 接受 / 撤销」时，面板只需订阅这个事件，
 * 不用再去翻 pi 的工具事件结构 —— 事件到「文件路径」的映射已经收敛在这里。
 *
 * 为什么单独成模块而不是留在 tools.js：
 *   1. tools.js 的职责是「渲染工具卡片」，而这里是纯数据，两者生命周期不同；
 *   2. 反过来，tools.js 要调用记录函数 —— 如果定义放在 tools.js，
 *      账本自身想被别的模块（例如将来的 diff 面板）引用就会绕回去，容易成环。
 *
 * 依赖方向：tools.js → changes.js（单向）。本文件不引任何业务模块。 */

/** 会改动磁盘的工具。判定依据是工具名，不解析命令内容 —— 宁可少判也不错判。 */
export const MUTATING_TOOLS = new Set(['write', 'edit']);

/** 从一次工具调用的参数里提取涉及的文件路径。
 *
 * 只认明确的 file_path / path 字段：写文件类工具的路径参数就在这两个键里，
 * 其余键（例如 content）不是路径，猜错比不猜更糟。 */
export function toolResultFiles(name, args) {
  if (!MUTATING_TOOLS.has(name)) return [];
  const p = args?.file_path || args?.path;
  return typeof p === 'string' && p ? [p] : [];
}

/* 账本本体。用数组而不是 Map：要保序（界面按改动先后展示更符合直觉），
 * 同一路径重复改动则累加 count 并挪到末尾。 */
let entries = [];
const listeners = new Set();

function snapshot() {
  return entries.map((e) => ({ ...e })); // 对外只给副本，外部改不动账本
}

function emit() {
  const list = snapshot();
  for (const fn of listeners) {
    try {
      fn(list);
    } catch {
      /* 订阅者自己炸了不该带塌账本 */
    }
  }
}

/** 记一次工具调用。非改动类工具直接忽略；返回本次涉及的文件（便于调用方复用）。 */
export function recordToolChange(name, args, at = Date.now()) {
  const files = toolResultFiles(name, args);
  if (!files.length) return [];
  for (const p of files) {
    const hit = entries.find((e) => e.path === p);
    if (hit) {
      hit.count += 1;
      hit.tool = name;
      hit.at = at;
    } else {
      entries.push({ path: p, tool: name, at, count: 1 });
    }
  }
  emit();
  return files;
}

/** 当前账本（副本）。 */
export function listChanges() {
  return snapshot();
}

/** 换会话 / 清空时调用。 */
export function clearChanges() {
  if (!entries.length) return;
  entries = [];
  emit();
}

/** 订阅账本变化，返回取消订阅函数。 */
export function onChanges(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
