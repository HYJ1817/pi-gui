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

function inline(text) {
  // 行内代码先摘出来占位，免得里面的 * / _ / [] 被后面的规则误伤
  const codes = [];
  let s = esc(text).replace(/`([^`\n]+)`/g, (_m, c) => {
    codes.push(c);
    return `\u0001${codes.length - 1}\u0001`;
  });

  const link = (label, url) => {
    const u = safeUrl(url);
    // 危险 scheme 不丢弃、也不静默变成空链接 —— 退化成纯文本，用户看得见原文
    if (!u) return `${label}（${url}）`;
    return `<a href="${u}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  };

  // 图片同样不加载，降级成链接（见文件头的安全模型）
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) => link(alt || url, url));
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, label, url) => link(label, url));

  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  // 强调的边界要卡住：否则 snake_case 里的下划线会被当成斜体
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');

  return s.replace(/\u0001(\d+)\u0001/g, (_m, i) => `<code>${codes[+i]}</code>`);
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

function codeBlock(lang, code) {
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
function listHtml(items) {
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
        ? `<span class="md-task${it.checked ? ' on' : ''}"></span>${inline(it.text)}`
        : inline(it.text);
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

function table(head, aligns, rows) {
  const th = head.map((c, i) => `<th${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inline(c)}</th>`);
  const body = rows
    .map(
      (r) =>
        '<tr>' +
        head
          .map((_c, i) => `<td${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inline(r[i] ?? '')}</td>`)
          .join('') +
        '</tr>'
    )
    .join('');
  return `<div class="md-table"><table><thead><tr>${th.join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ---------- 块级 ---------- */

const FENCE_OPEN = /^(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})\s*$/;

function renderBlocks(lines) {
  const out = [];
  let para = [];
  let i = 0;

  const flush = () => {
    if (!para.length) return;
    out.push('<p>' + para.map(inline).join('<br>') + '</p>');
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
      while (i < lines.length && !FENCE_CLOSE.test(lines[i].trim())) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 吃掉闭合围栏（未闭合时 i 越界，循环自然结束）
      out.push(codeBlock(lang, buf.join('\n')));
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
      // 统一渲染成 h4：对话正文里六级标题的视觉差异没有意义，字号也不该乱跳
      out.push('<h4>' + inline(h[2]) + '</h4>');
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
      out.push('<blockquote>' + renderBlocks(buf) + '</blockquote>');
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
        out.push(table(head, aligns, rows));
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
      out.push(listHtml(items));
      continue;
    }

    para.push(t);
    i++;
  }

  flush();
  return out.join('');
}

/** 渲染一段 Markdown 成 HTML。
 *  返回值里所有标签都由本文件生成，模型原文只以转义后的形式出现。 */
export function md(src) {
  return renderBlocks(String(src ?? '').split(/\r?\n/));
}
