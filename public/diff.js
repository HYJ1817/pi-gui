/* Unified Diff 渲染。
 *
 * 为什么不复用 markdown.js 的 diff 着色：
 *   那条路径是「Markdown 围栏代码块」，输入是**模型吐出的文本**；
 *   而这里的输入是 **Git 的真实输出**，要处理 hunk 头、`\ No newline at end of file`、
 *   文件元信息行（`diff --git` / `index` / `---` / `+++` / `new file mode`）、
 *   二进制提示、以及超长行。硬塞进 Markdown 解析器会让两边都变脆
 *   （比如 `--- a/x` 会被当成分隔线）。所以单独实现，但**视觉上保持一致** ——
 *   复用 styles.css 里已有的 .d-add / .d-del / .d-hunk 配色。
 *
 * ---------- 安全模型（与 markdown.js 一致） ----------
 * **先整体转义，再插入本文件自己生成的白名单标签。**
 * diff 文本里包含文件名与代码内容，两者都可能被 Agent 间接控制
 * （创建一个名字叫 `<img onerror=...>` 的文件就够了），所以一律当不可信输入。
 * 这里不解析任何 HTML，只输出 <span class="…"> + 转义后的文本。
 */

import { esc } from './util.js';

/* hunk 头：`@@ -1,3 +1,4 @@`，后面可能跟一段函数上下文 */
const HUNK_RE = /^@@/;
/* 文件级元信息。必须排在 + / - 判断**之前** —— 否则 `+++ b/x` 会被当成新增行、
 * `--- a/x` 会被当成删除行，整份 diff 的头两行永远是花的。 */
const META_RE = /^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to |copy from |copy to |Binary files )/;

/** 把一段 unified diff 渲染成 HTML。空输入返回空串。 */
export function diffHtml(text) {
  const src = String(text ?? '');
  if (!src.trim()) return '';

  const lines = src.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const out = [];

  for (const line of lines) {
    let cls = 'dl';
    if (HUNK_RE.test(line)) cls += ' d-hunk';
    else if (line.startsWith('\\')) cls += ' d-note'; // \ No newline at end of file
    else if (META_RE.test(line)) cls += ' d-meta';
    else if (line.startsWith('+')) cls += ' d-add';
    else if (line.startsWith('-')) cls += ' d-del';

    // 空行也要占一行高度，否则空行会被折叠掉，diff 读起来会错位
    out.push(`<span class="${cls}">${esc(line) || ' '}</span>`);
  }

  return `<div class="diff"><pre class="diff-body">${out.join('\n')}</pre></div>`;
}

/** 从 diff 文本里数增删行数。
 *  用在「后端没能给出 numstat」的降级场景（例如未跟踪文件太多被跳过），
 *  打开某个文件时用它补上 +N -M。 */
export function countDiffLines(text) {
  let add = 0;
  let del = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (HUNK_RE.test(line) || META_RE.test(line) || line.startsWith('\\')) continue;
    if (line.startsWith('+')) add++;
    else if (line.startsWith('-')) del++;
  }
  return { add, del };
}
