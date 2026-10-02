/* P24 命令面板的**纯逻辑**：命令注册表 + 搜索排序。
 *
 * 与 `palette.js`（DOM 层）分开，理由与本仓库既有的
 * `capability-model.js` / `capability-view.js` 一致：**不碰 DOM 的部分要能离线单测**。
 * 这里没有 `document`、没有 `state.js` —— `tests/daily-use.cjs` 直接 import 它。
 */

/** 静态命令表（装配阶段由 app.js 填）。 */
const commands = [];
let dynamicProvider = null;

/** 把外部给的命令规范成内部形状（静态与动态共用同一套字段）。 */
export function normalizeCommand(item) {
  if (!item || typeof item.id !== 'string' || typeof item.run !== 'function') {
    throw new Error('palette command 需要 id 与 run()');
  }
  return {
    id: item.id,
    title: item.title || item.id,
    group: item.group || '通用',
    keywords: typeof item.keywords === 'string' ? item.keywords : '',
    hint: typeof item.hint === 'string' ? item.hint : '',
    when: typeof item.when === 'function' ? item.when : null,
    run: item.run,
  };
}

/**
 * 注册一批命令。
 * @param list 形如 `{ id, title, group, keywords?, hint?, when?, run }`
 */
export function defineCommands(list) {
  for (const item of Array.isArray(list) ? list : []) {
    const cmd = normalizeCommand(item);
    if (commands.some((c) => c.id === cmd.id)) throw new Error(`palette command id 重复：${cmd.id}`);
    commands.push(cmd);
  }
}

/** 动态命令（会随数据变化，例如「切换到会话 X」）。每次求值时拿到当前 query。 */
export function setDynamicCommands(fn) {
  dynamicProvider = typeof fn === 'function' ? fn : null;
}

export function registeredCommands() {
  return commands.slice();
}

/** 当前可执行的命令（`when()` 为 false 的不出现 —— 不灰着骗人）。 */
export function allCommands(ctx = {}) {
  const extra = dynamicProvider ? dynamicProvider(ctx) || [] : [];
  return [...commands, ...extra.map(normalizeCommand)].filter((c) => (c.when ? Boolean(c.when(ctx)) : true));
}

/**
 * 搜索 + 排序。纯函数。
 *
 * 排序：前缀命中 > 词首命中 > 子串命中 > 子序列命中；同档按标题长度（短的更像用户要的）。
 * 空查询返回全部，保持定义顺序 —— 打开面板先看到的是常用动作，不是随机顺序。
 */
export function filterCommands(list, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list.slice();
  const scored = [];
  for (const cmd of list) {
    const title = cmd.title.toLowerCase();
    const hay = `${title} ${cmd.group.toLowerCase()} ${(cmd.keywords || '').toLowerCase()}`;
    let score = -1;
    if (title.startsWith(q)) score = 0;
    else if (title.split(/[\s/·：:()]+/).some((w) => w.startsWith(q))) score = 1;
    else if (hay.includes(q)) score = 2;
    else if (subsequence(q, hay)) score = 3;
    if (score >= 0) scored.push({ cmd, score });
  }
  scored.sort((a, b) => a.score - b.score || a.cmd.title.length - b.cmd.title.length);
  return scored.map((s) => s.cmd);
}

/** 子序列匹配：`mcp` 能命中「能力视图 MCP」。 */
export function subsequence(needle, hay) {
  if (!needle) return true;
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i >= needle.length) return true;
  }
  return false;
}

/** 只给测试用。 */
export function resetPaletteRegistry() {
  commands.length = 0;
  dynamicProvider = null;
}
