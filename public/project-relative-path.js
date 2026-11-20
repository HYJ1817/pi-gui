export const looksWindows = (p) => /^[a-z]:[\\/]/i.test(String(p)) || String(p).includes('\\');

/**
 * 把「工具参数里的原始路径」归一成「项目相对路径」。
 *
 * 为什么需要它：pi 工具参数里的路径**多数时候是绝对路径**
 * （`C:\proj\src\a.js`），偶尔是相对的；而 `git status` 给的一律是相对项目根的
 * 路径。两边要放进同一个坐标系才能比较。
 *
 * 两个消费者：
 *   - git.js 的「仅本次会话」过滤（账本 vs Git 列表）
 *   - tool-model.js 的 +N −M 回填（工具参数 vs Git 列表）
 * 这个纯模块让它们用**同一份**归一化规则 —— 各写一份迟早会漂移。
 *
 * 返回 '' 表示「这个路径不参与匹配」（在项目外，或者拿不到项目根）。
 * 返回 '' 而不是抛错：混进一个项目外的路径只是不该被标记，不是故障。
 */
export function toProjectRel(p, projectRoot) {
  const s = String(p ?? '').replace(/\\/g, '/');
  const root = String(projectRoot ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!s || !root) return '';

  // Windows 上盘符与目录名的大小写经常和实际不一致，比较时统一小写
  const ci = looksWindows(root);
  const a = ci ? s.toLowerCase() : s;
  const b = ci ? root.toLowerCase() : root;

  if (a === b) return '';
  if (a.startsWith(b + '/')) return s.slice(root.length + 1);

  /* 相对路径：没有盘符、也不以 / 开头。直接原样用（剥掉可能的前导 ./）。 */
  if (!looksWindows(s) && !s.startsWith('/')) return s.replace(/^\.\//, '');

  return ''; // 绝对路径但落在项目外
}
