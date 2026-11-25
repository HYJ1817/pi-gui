import { iconMarkup } from './ui/icons.js';
/* Markdown 渲染。
 *
 * 覆盖 Coding Agent 实际会吐出来的东西：段落、标题、有序/无序/嵌套/任务列表、
 * 引用、表格、分隔线、围栏代码块（带语言标签，diff 额外着色）、
 * 行内代码 / 粗体 / 斜体 / 删除线 / 链接。
 *
 * ---------- 安全模型（改动时不要破坏） ----------
 *
 * **先整体转义，再插入本文件自己生成的白名单标签。**
 * 也就是说模型输出的原文里不可能出现「活的」标签 —— 不管模型返回什么，
 * 进入 HTML 的尖括号都来自这里。这样 XSS 不是「被过滤掉了」，而是
 * 在语法层面就不成立：不需要黑名单，也不存在「漏掉某个向量」的问题。
 * 具体约束：
 *   - 不渲染原始 HTML（原文里的 <div> 会变成 &lt;div&gt;）
 *   - 链接走 scheme 白名单（只放行 http / https / mailto 与相对路径），
 *     javascript: / data: / vbscript: / file: 一律退化成纯文本
 *   - 从不生成 on* 事件属性
 *   - 不渲染远程图片（避免把用户的 IP 暴露给模型随手写的一个地址）
 *
 * 为什么不用 markdown-it 之类的成熟库：见 README 的「Markdown 渲染」一节。
 * 简要说，本项目零构建、零前端依赖，引入它要额外随包分发两个 UMD 文件
 * （含 Apache-2.0 的署名义务），而上面这套「转义优先」的结构性防护
 * 已经把主要收益拿到了；渲染完整度上的差距用增量补齐更划算。 */

import { esc } from './util.js';
import { parseVizData } from './viz-schema.js';
import { fileLinkFromHref, fileLinkFromInlineCode, scanPlainTextPaths, fileLinkDisplayLabel, fileLinkAriaLabel } from './file-link-model.js';
import { fileIconHtml } from './ui/file-icons.js';

/* ---------- 链接安全 ---------- */

/* 去掉所有空白与控制字符再判断。
 * 这一步不能省：浏览器解析 href 时会**先剥掉** tab / LF / CR，
 * 于是 `java\nscript:alert(1)` 在浏览器眼里就是 `javascript:`。
 * 只按原样做正则匹配会把它当成「没有 scheme 的相对路径」放行。 */
const SAFE_SCHEME = /^(?:https?|mailto):/i;

function safeUrl(raw) {
  const u = String(raw || '').replace(/[\u0000-\u0020\u007f]/g, '');
  if (!u) return null;
  // 有 scheme 就必须在白名单里；没有 scheme（#锚点、/ 或 ./ 相对路径）放行
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) return u;
  return SAFE_SCHEME.test(u) ? u : null;
}

/* ---------- 行内 ---------- */

const CODE_SLOT = '\u0001';
const HTML_SLOT = '\u0002';

function fileSlots(ctx) {
  return ctx?.fileLinks && typeof ctx.fileLinks === 'object' ? ctx.fileLinks : null;
}

function fileAttrs(meta, links) {
  const attrs = [
    `data-file-link="1"`,
    `data-file-path="${esc(meta.path)}"`,
    `data-file-cwd="${esc(meta.cwd)}"`,
    `data-file-conversation="${esc(links.conversationId || '')}"`,
  ];
  if (meta.external) {
    attrs.push(`data-file-external="1"`);
    attrs.push(`data-file-display="${esc(meta.displayPath || meta.path)}"`);
  }
  if (meta.line) attrs.push(`data-file-line="${meta.line}"`);
  if (meta.column) attrs.push(`data-file-column="${meta.column}"`);
  if (meta.endLine) attrs.push(`data-file-end-line="${meta.endLine}"`);
  if (meta.endColumn) attrs.push(`data-file-end-column="${meta.endColumn}"`);
  return attrs.join(' ');
}

function fileChip(meta, links) {
  const label = fileLinkDisplayLabel(meta);
  return `<a href="#" class="md-file-link${meta.external ? ' is-external' : ''}" ${fileAttrs(meta, links)} aria-label="${esc(fileLinkAriaLabel(meta))}">` +
    fileIconHtml(meta.path) +
    `<span class="md-file-name">${esc(label)}</span>` +
    `</a>`;
}

/* 单个文件名先保持代码外观，等后端确认“唯一存在”后再原地升级为链接；
 * 否则 README.md 这类泛称会被错误地变成文件入口。 */
function fileCandidate(code, meta, links) {
  return `<code class="md-file-candidate" data-file-candidate="${esc(code)}"` +
    ` data-file-cwd="${esc(meta.cwd)}" data-file-conversation="${esc(links.conversationId || '')}"` +
    ` data-file-verify="${esc(meta.verification || 'find')}"` +
    (meta.line ? ` data-file-line="${meta.line}"` : '') +
    (meta.column ? ` data-file-column="${meta.column}"` : '') +
    (meta.endLine ? ` data-file-end-line="${meta.endLine}"` : '') +
    (meta.endColumn ? ` data-file-end-column="${meta.endColumn}"` : '') +
    `>${esc(code)}</code>`;
}

/* 纯文本相对路径在验证前保持原来的文字外观：不加代码底色、不加图标。
 * 后端确认存在后才由 file-links-ui 原地替换成 chip；不存在就什么都不做。 */
function fileTextCandidate(raw, meta, links) {
  const attrs = [
    `class="md-file-plain-candidate"`,
    `data-file-candidate="${esc(raw)}"`,
    `data-file-cwd="${esc(meta.cwd)}"`,
    `data-file-conversation="${esc(links.conversationId || '')}"`,
    `data-file-verify="${esc(meta.verification || 'metadata')}"`,
    `data-file-plain="1"`,
  ];
  if (meta.line) attrs.push(`data-file-line="${meta.line}"`);
  if (meta.column) attrs.push(`data-file-column="${meta.column}"`);
  if (meta.endLine) attrs.push(`data-file-end-line="${meta.endLine}"`);
  if (meta.endColumn) attrs.push(`data-file-end-column="${meta.endColumn}"`);
  return `<span ${attrs.join(' ')}>${esc(raw)}</span>`;
}

/* 链接文字已经能表示这个文件时，只显示 chip；否则保留作者写的文字，
 * 后面再跟 chip —— 和 T3 的 MarkdownFileLink 行为一致。 */
function labelNamesFile(label, meta) {
  const text = String(label || '').trim().replace(/^`|`$/g, '');
  if (!text) return true;
  return text === meta.name
    || text === meta.path
    || text === meta.name + (meta.position || '')
    || text === meta.path + (meta.position || '')
    || text.replace(/:[0-9].*$/, '') === meta.name;
}

function inline(text, ctx = {}) {
  const links = fileSlots(ctx);

  // 行内代码先摘出来占位，免得里面的 * / _ / [] 被后面的规则误伤
  const codes = [];
  const codeMetas = [];
  let s = String(text).replace(/`([^`\n]+)`/g, (_m, c) => {
    let html;
    const meta = links ? fileLinkFromInlineCode(c, links.cwd, { allowExternal: true }) : null;
    if (!meta) html = `<code>${esc(c)}</code>`;
    else if (meta.candidate) html = fileCandidate(c, meta, links);
    else html = fileChip(meta, links);
    codes.push(html);
    codeMetas.push(meta);
    return `${CODE_SLOT}${codes.length - 1}${CODE_SLOT}`;
  });

  const htmls = [];
  const slot = (html) => {
    htmls.push(html);
    return `${HTML_SLOT}${htmls.length - 1}${HTML_SLOT}`;
  };

  const link = (rawLabel, url, original) => {
    const meta = links ? fileLinkFromHref(url, links.cwd, { allowExternal: true }) : null;
    if (meta) {
      const chip = fileChip(meta, links);
      /* 标签本身是行内代码时，先摘出来的占位里可能已经渲染成同一个文件
       * 的 chip。此时只保留标签，避免“chip 后面再跟一个 chip”。 */
      const slots = [...String(rawLabel || '').matchAll(new RegExp(CODE_SLOT + '(\\d+)' + CODE_SLOT, 'g'))];
      const slotNamesFile = slots.some((m) => {
        const codeMeta = codeMetas[+m[1]];
        return codeMeta && !codeMeta.candidate && codeMeta.path === meta.path
          && codeMeta.line === meta.line && codeMeta.endLine === meta.endLine;
      });
      const bareLabel = String(rawLabel || '').replace(new RegExp(CODE_SLOT + '\\d+' + CODE_SLOT, 'g'), '').trim();
      if (!bareLabel) return slotNamesFile ? esc(rawLabel) : chip;
      if (slotNamesFile) return esc(rawLabel);
      return labelNamesFile(rawLabel, meta) ? chip : `${esc(rawLabel)} ${chip}`;
    }
    const u = safeUrl(url);
    const label = esc(rawLabel || url);
    // 危险 scheme 不丢弃、也不静默变成空链接 —— 退化成纯文本，用户看得见原文
    if (!u) return `${label}（${esc(url)}）`;
    // 普通 Markdown 链接目标不能含空白；带空格的路径必须写成 <...>。
    // 这里返回的是原文而不是自己生成的标签，必须转义后再放进 slot，
    // 否则 `[<img onerror=...>](a b)` 会绕过“转义优先”的安全模型。
    if (/\s/.test(url) && !/^https?:/i.test(url)) return esc(original);
    return `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  };

  // 图片同样不加载，降级成链接（见文件头的安全模型）。
  // `<...>` 目标允许路径里有空格（如 `C:/Program Files/...`）。
  s = s.replace(/!\[([^\]]*)\]\((?:<([^>\n]+)>|([^)\n]+))\)/g, (m, alt, angled, plain) => {
    const url = angled || plain;
    return slot(link(alt || url, url, m));
  });
  s = s.replace(/\[([^\]]*)\]\((?:<([^>\n]+)>|([^)\n]+))\)/g, (m, label, angled, plain) => slot(link(label, angled || plain, m)));

  // 纯文本：绝对路径直接识别；相对路径先作为“无样式候选”，由后端确认存在
  // 后才升级。反引号/链接已经处理过，不会重复扫描。
  if (links) {
    const found = scanPlainTextPaths(s, links.cwd, { allowExternal: true, relative: true });
    if (found.length) {
      let out = '';
      let last = 0;
      for (const hit of found) {
        if (hit.text.includes(HTML_SLOT) || hit.text.includes(CODE_SLOT)) continue;
        const html = hit.meta.candidate && hit.meta.verification === 'metadata'
          ? fileTextCandidate(hit.text, hit.meta, links)
          : fileChip(hit.meta, links);
        out += s.slice(last, hit.start) + slot(html);
        last = hit.end;
      }
      out += s.slice(last);
      s = out;
    }
  }

  // 到这里剩余的原文才整体转义；模型写出的尖括号从语法上就不成立。
  s = esc(s);

  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  // 强调的边界要卡住：否则 snake_case 里的下划线会被当成斜体
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');

  s = s.replace(new RegExp(HTML_SLOT + '(\\d+)' + HTML_SLOT, 'g'), (_m, i) => htmls[+i] ?? '');
  return s.replace(new RegExp(CODE_SLOT + '(\\d+)' + CODE_SLOT, 'g'), (_m, i) => codes[+i] ?? '');
}

/* ---------- 代码块 ---------- */

/** diff 逐行着色。行首字符决定类型，跟 git 的习惯一致。 */
function diffBody(code) {
  return code
    .split('\n')
    .map((line) => {
      const e = esc(line);
      if (/^@@/.test(line)) return `<span class="d-hunk">${e}</span>`;
      if (/^\+/.test(line)) return `<span class="d-add">${e}</span>`;
      if (/^-/.test(line)) return `<span class="d-del">${e}</span>`;
      return e;
    })
    .join('\n');
}

export function renderVizCardHtml(code) {
  const res = parseVizData(code);
  if (!res.ok) return null;
  const typeBadge = res.data.type === 'line' ? '折线图' : '柱状图';
  const metaText = `${res.data.series.length} 个系列 · ${res.data.labels.length} 个数据点`;
  const svgIcon = iconMarkup('chart');
  return `<div class="viz-card" data-viz-card>` +
    `<div class="viz-card-header">` +
    `<div class="viz-card-icon" aria-hidden="true">${svgIcon}</div>` +
    `<div class="viz-card-info">` +
    `<div class="viz-card-title">${esc(res.data.title)}</div>` +
    `<div class="viz-card-meta">` +
    `<span class="viz-badge">${typeBadge}</span>` +
    `<span class="viz-meta-text">${metaText}</span>` +
    `</div>` +
    `</div>` +
    `<div class="viz-card-actions">` +
    `<button type="button" class="btn tiny viz-open-btn" data-viz-open aria-label="打开「${esc(res.data.title)}」可视化图表">打开可视化</button>` +
    `<button type="button" class="btn tiny ghost viz-toggle-raw" data-viz-toggle-raw aria-expanded="false" title="切换显示原始数据">JSON</button>` +
    `</div>` +
    `</div>` +
    `<pre class="code viz-raw-code" data-lang="pi-gui-viz" hidden><code>${esc(code)}</code></pre>` +
    `</div>`;
}

function codeBlock(lang, code, { closed = true } = {}) {
  if (lang === 'pi-gui-viz' && closed === true) {
    const cardHtml = renderVizCardHtml(code);
    if (cardHtml) return cardHtml;
  }

  const body = lang === 'diff' ? diffBody(code) : esc(code);
  // 语言标签走 data-lang + CSS ::before，不额外包一层 DOM ——
  // 保持 <pre class="code"> 的结构不变，样式与既有断言都不用动。
  const attr = lang ? ` data-lang="${esc(lang)}"` : '';
  return `<pre class="code"${attr}><code>${body}</code></pre>`;
}

/* ---------- 列表 ---------- */

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** 任务列表项：`- [ ] 待办` / `- [x] 已完成` */
function asTask(text) {
  const m = /^\[([ xX])\]\s+(.*)$/.exec(text);
  if (!m) return { text, task: false };
  return { text: m[2], task: true, checked: m[1].toLowerCase() === 'x' };
}

/** 把摊平的列表项还原成嵌套结构。
 *
 * 输入是按出现顺序排列的项，每项带缩进宽度；缩进更深就开一层子列表。
 * 子列表必须塞进**上一个 li 里面**（`<li>甲<ul>…</ul></li>`），
 * 而不是接在它后面 —— 后者是非法 HTML，浏览器会自行修补，
 * 结果就是「缩进看起来生效了，但结构是错的」。 */
function listHtml(items, ctx) {
  let pos = 0;

  const level = (indent) => {
    const tag = items[pos].tag;
    let html = `<${tag}>`;

    while (pos < items.length && items[pos].indent >= indent) {
      const it = items[pos];

      if (it.indent > indent) {
        const sub = level(it.indent);
        if (/<\/li>$/.test(html)) html = html.replace(/<\/li>$/, sub + '</li>');
        else html += sub; // 畸形输入（首项就带缩进）：别把内容丢了
        continue;
      }

      // 同级但换了标记类型（ul↔ol）→ 收掉当前列表，由外层另开一个
      if (it.tag !== tag) break;

      pos++;
      const inner = it.task
        ? `<span class="md-task${it.checked ? ' on' : ''}"></span>${inline(it.text, ctx)}`
        : inline(it.text, ctx);
      html += `<li>${inner}</li>`;
    }

    return html + `</${tag}>`;
  };

  let out = '';
  while (pos < items.length) out += level(items[pos].indent);
  return out;
}

/* ---------- 表格 ---------- */

const splitRow = (line) =>
  String(line)
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((s) => s.trim());

function isTableSep(line) {
  const t = String(line).trim();
  if (!t.includes('-')) return false;
  const cells = splitRow(t);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

const cellAlign = (c) => {
  const left = c.startsWith(':');
  const right = c.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return '';
};

function table(head, aligns, rows, ctx) {
  const th = head.map((c, i) => `<th${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inline(c, ctx)}</th>`);
  const body = rows
    .map(
      (r) =>
        '<tr>' +
        head
          .map((_c, i) => `<td${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inline(r[i] ?? '', ctx)}</td>`)
          .join('') +
        '</tr>'
    )
    .join('');
  return `<div class="md-table"><table><thead><tr>${th.join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ---------- 块级 ---------- */

const FENCE_OPEN = /^(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})\s*$/;

function headingSlug(text, ctx) {
  const plain = String(text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'section';
  const seen = ctx.headingSlugs.get(plain) || 0;
  ctx.headingSlugs.set(plain, seen + 1);
  return seen ? plain + '-' + (seen + 1) : plain;
}

function renderBlocks(lines, ctx) {
  const out = [];
  let para = [];
  let i = 0;

  const flush = () => {
    if (!para.length) return;
    out.push('<p>' + para.map((line) => inline(line, ctx)).join('<br>') + '</p>');
    para = [];
  };

  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();

    if (!t) {
      flush();
      i++;
      continue;
    }

    // 围栏代码块：直接吃到闭合围栏，不需要占位符
    const fence = FENCE_OPEN.exec(t);
    if (fence) {
      flush();
      const lang = fence[2].toLowerCase();
      const buf = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (FENCE_CLOSE.test(lines[i].trim())) {
          closed = true;
          break;
        }
        buf.push(lines[i]);
        i++;
      }
      if (closed) {
        i++; // 吃掉闭合围栏
      }
      out.push(codeBlock(lang, buf.join('\n'), { closed }));
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flush();
      out.push('<hr>');
      i++;
      continue;
    }

    const h = /^(#{1,6})\s+(.+)$/.exec(t);
    if (h) {
      flush();
      // Chat keeps its compact h4 convention. The standalone document reader
      // explicitly requests the authored semantic hierarchy, without restyling chat.
      const level = ctx.documentHeadings ? h[1].length : 4;
      const id = ctx.headingIds ? ` id="${esc(headingSlug(h[2], ctx))}"` : '';
      out.push(`<h${level}${id}>` + inline(h[2], ctx) + `</h${level}>`);
      i++;
      continue;
    }

    if (/^>/.test(t)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + renderBlocks(buf, ctx) + '</blockquote>');
      continue;
    }

    /* 表格：当前行含 | 且下一行是分隔行，且两行列数一致。
     * 要求列数一致是为了避免把「正文 | 正文」后面跟一条 --- 误判成表格。 */
    if (t.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(t);
      const sep = splitRow(lines[i + 1]);
      if (sep.length === head.length) {
        flush();
        const aligns = sep.map(cellAlign);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        out.push(table(head, aligns, rows, ctx));
        continue;
      }
    }

    if (LIST_RE.test(raw)) {
      flush();
      const items = [];
      while (i < lines.length && LIST_RE.test(lines[i])) {
        const m = LIST_RE.exec(lines[i]);
        const { text, task, checked } = asTask(m[3]);
        items.push({
          // tab 按 4 空格算，否则同一层缩进会被算成不同层
          indent: m[1].replace(/\t/g, '    ').length,
          tag: /^\d/.test(m[2]) ? 'ol' : 'ul',
          text,
          task,
          checked,
        });
        i++;
      }
      out.push(listHtml(items, ctx));
      continue;
    }

    para.push(t);
    i++;
  }

  flush();
  return out.join('');
}

/** 渲染一段 Markdown 成 HTML。
 *  返回值里所有标签都由本文件生成，模型原文只以转义后的形式出现。
 *  `fileLinks` 只在“这条消息知道自己属于哪个工作区”时传入；不传就完全不
 *  识别文件，避免 Specs、更新说明等共享渲染器误把普通文本当成文件。 */
export function md(src, { headingIds = false, documentHeadings = false, fileLinks = null } = {}) {
  const ctx = { headingIds: headingIds === true, documentHeadings: documentHeadings === true, headingSlugs: new Map(), fileLinks };
  return renderBlocks(String(src ?? '').split(/\r?\n/), ctx);
}
