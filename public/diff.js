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
 * 这里不解析任何 HTML，只输出 <span class="…"> / <button> + 转义后的文本。
 *
 * ---------- 结构：为什么要按 hunk 分块 ----------
 *
 * 输出是一棵「元信息行 + 若干 hunk 块」的树，而不是一串平铺的行：
 *
 *   <div class="diff" data-hunks="2">
 *     <pre class="diff-body">
 *       <span class="dl d-meta">diff --git …</span>        ← 首个 hunk 之前的文件级信息
 *       <span class="d-hunkwrap" data-open="1">            ← 一个 hunk（可整体折叠）
 *         <button class="d-hunkbar">▾ @@ -1,3 +1,4 @@  +1 −1</button>
 *         <span class="dl d-add">+新增</span>
 *         …
 *       </span>
 *     </pre>
 *   </div>
 *
 * 只有分了块，才谈得上「按 hunk 折叠」——平铺的行串没有可折叠的边界。
 * 容器仍然用 <pre>（`.d-hunkwrap` 是 span + display:block，在 <pre> 里合法），
 * 于是等宽、保留空格、横向滚动这些既有的视觉约定一行 CSS 都不用改。
 *
 * 分块还顺手修掉了一个老毛病：`META_RE` 原先无差别地作用在每一行上，于是
 * **hunk 内部**一行内容为 `++ x` 的新增行（diff 里写作 `+++ x`）会被误判成
 * `+++ b/…` 文件头而着色成灰色。现在元信息只在首个 hunk 之前识别。
 */

import { esc } from './util.js';

/* hunk 头：`@@ -1,3 +1,4 @@`，后面可能跟一段函数上下文 */
const HUNK_RE = /^@@/;
/* 文件级元信息。必须排在 + / - 判断**之前** —— 否则 `+++ b/x` 会被当成新增行、
 * `--- a/x` 会被当成删除行，整份 diff 的头两行永远是花的。
 * 但它**只对 hunk 之前的行**成立，见 classify() 的 inHunk 参数。 */
const META_RE = /^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to |copy from |copy to |Binary files )/;

/**
 * 给一行分类。
 *
 * @param {string} line
 * @param {boolean} inHunk 已经在某个 hunk 内部 —— 此时不再识别文件级元信息，
 *        因为 hunk 里的 `+++ x` 是一行**新增的、内容以 `++ ` 开头的代码**。
 */
function classify(line, inHunk) {
  if (HUNK_RE.test(line)) return 'd-hunk';
  if (line.startsWith('\\')) return 'd-note'; // \ No newline at end of file
  if (!inHunk && META_RE.test(line)) return 'd-meta';
  if (line.startsWith('+')) return 'd-add';
  if (line.startsWith('-')) return 'd-del';
  return '';
}

function lineHtml(line, cls) {
  // 空行也要占一行高度，否则空行会被折叠掉，diff 读起来会错位
  return `<span class="dl${cls ? ' ' + cls : ''}">${esc(line) || ' '}</span>`;
}

/** 一个 hunk 块：可点击的标题栏 + 若干行。 */
function hunkWrap(header, bodyHtml, add, del) {
  const stat = [];
  if (add) stat.push(`<b class="add">+${add}</b>`);
  if (del) stat.push(`<b class="del">−${del}</b>`);

  return (
    '<span class="d-hunkwrap" data-open="1">' +
    '<button class="d-hunkbar" type="button" title="折叠 / 展开这一块">' +
    '<span class="d-chev" aria-hidden="true">▾</span>' +
    `<span class="dl d-hunk">${esc(header) || ' '}</span>` +
    (stat.length ? `<span class="d-hunkstat">${stat.join('')}</span>` : '') +
    '</button>' +
    bodyHtml +
    '</span>'
  );
}

/** 把一段 unified diff 渲染成 HTML。空输入返回空串。 */
export function diffHtml(text) {
  const src = String(text ?? '');
  if (!src.trim()) return '';

  const lines = src.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');

  const out = []; // 顶层片段：元信息行 + hunk 块
  let hunk = null; // 当前 hunk 的累积状态
  let hunkCount = 0;

  const flush = () => {
    if (!hunk) return;
    out.push(hunkWrap(hunk.header, hunk.body.join(''), hunk.add, hunk.del));
    hunk = null;
  };

  for (const line of lines) {
    if (HUNK_RE.test(line)) {
      flush();
      hunkCount += 1;
      hunk = { header: line, body: [], add: 0, del: 0 };
      continue;
    }

    const cls = classify(line, hunk !== null);
    if (hunk) {
      hunk.body.push(lineHtml(line, cls));
      if (cls === 'd-add') hunk.add += 1;
      else if (cls === 'd-del') hunk.del += 1;
    } else {
      out.push(lineHtml(line, cls));
    }
  }
  flush();

  // 顶层片段之间**不插换行**：每一行都是 display:block，换行会再叠一个空行。
  // 容器是 white-space:pre，源码里的换行是真会被渲染出来的。
  return `<div class="diff" data-hunks="${hunkCount}"><pre class="diff-body">${out.join('')}</pre></div>`;
}

/* ---------- 折叠交互 ---------- */

function setHunkOpen(wrap, open) {
  if (!wrap) return;
  wrap.dataset.open = open ? '1' : '0';
  const chev = wrap.querySelector('.d-chev');
  if (chev) chev.textContent = open ? '▾' : '▸';
}

/** 切换一个 hunk 的展开状态。 */
export function toggleHunk(wrap) {
  setHunkOpen(wrap, wrap && wrap.dataset.open !== '1');
}

/** 全部展开 / 全部折叠。`root` 是 diffHtml() 产出的 .diff 节点。 */
export function setAllHunks(root, open) {
  if (!root) return 0;
  const all = root.querySelectorAll('.d-hunkwrap');
  for (const w of all) setHunkOpen(w, open);
  return all.length;
}

/** hunk 个数（从 DOM 数，比解析 data-hunks 更贴近实际渲染结果）。 */
export const hunkCount = (root) => (root ? root.querySelectorAll('.d-hunkwrap').length : 0);

/** 是否所有 hunk 都展开着（用来决定「全部折叠」还是「全部展开」更有用）。 */
export function allHunksOpen(root) {
  const all = root ? [...root.querySelectorAll('.d-hunkwrap')] : [];
  return all.length > 0 && all.every((w) => w.dataset.open === '1');
}

/**
 * 给一个 diff 容器挂上点击折叠。
 *
 * 用事件委托而不是逐个 hunk 绑：hunk 数量随 diff 大小变化，而且整块内容是
 * 一次性 innerHTML 注入的，逐个绑容易漏。挂一次，管全部。
 */
export function bindDiffToggles(root) {
  if (!root) return;
  root.addEventListener('click', (e) => {
    const bar = e.target && e.target.closest ? e.target.closest('.d-hunkbar') : null;
    if (!bar || !root.contains(bar)) return;
    toggleHunk(bar.closest('.d-hunkwrap'));
  });
}

/** 从 diff 文本里数增删行数。
 *  用在「后端没能给出 numstat」的降级场景（例如未跟踪文件太多被跳过），
 *  打开某个文件时用它补上 +N -M。 */
export function countDiffLines(text) {
  let add = 0;
  let del = 0;
  let inHunk = false;
  for (const line of String(text ?? '').split('\n')) {
    if (HUNK_RE.test(line)) {
      inHunk = true;
      continue;
    }
    if (line.startsWith('\\')) continue;
    /* hunk 之前只有文件级元信息，不计入。进入 hunk 之后**不再**看 META_RE ——
     * 和 classify() 保持一致：hunk 里的 `+++ x` 是一行新增代码，不是文件头。 */
    if (!inHunk) continue;
    if (line.startsWith('+')) add++;
    else if (line.startsWith('-')) del++;
  }
  return { add, del };
}
