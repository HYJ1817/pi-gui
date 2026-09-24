/* 通用工具：格式化、转义、路径、图标。
 *
 * 这个文件不碰业务状态（唯一的例外是 absPath —— 它要用 S.cwd 把 pi 返回的
 * 相对路径补成绝对的），也不发起网络请求。放在最底层，谁都能引。 */

import { S } from './state.js';

/* HTML 转义。
 *
 * 这是整个前端 XSS 防线的地基：**所有**来自 pi / 模型的文本在拼进 innerHTML
 * 之前都必须先过这里。注意 markdown.js 的做法是「先整体转义，再把自己生成的
 * 白名单标签插回去」，所以模型输出里的 <script> 在语法层面就没有机会成立。 */
export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmt(n) {
  if (n == null || n === 0) return '0';
  // 用 Number() 去掉小数尾零：61000 → 61k，1000000 → 1M，1500000 → 1.5M
  const trim = (x) => String(Number(x.toFixed(2)));
  if (n >= 1e6) return trim(n / 1e6) + 'M';
  if (n >= 1e3) return trim(n / 1e3) + 'k';
  return String(n);
}

/** 128000 → 128K，1048576 → 1M。只用于展示，不参与计算。 */
export function fmtTokens(n) {
  if (n >= 1e6) return `${Number((n / 1e6).toFixed(1))}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

export function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** 路径比较。
 *
 * Windows / macOS 的路径不区分大小写，去重必须归一后再比，
 * 否则同一个目录换个大小写就能重复加进来、而且删不掉。 */
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (s) => String(s).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/* pi 的 export_html 不传 outputPath 时会返回相对文件名（落在 pi 的 cwd 下），
 * 这里补成绝对路径，免得用户找不到文件。 */
export function absPath(p) {
  if (!p) return '';
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')) return p;
  const base = S.cwd || '';
  if (!base) return p;
  const sep = base.includes('\\') ? '\\' : '/';
  return base.replace(/[\\/]+$/, '') + sep + p.replace(/^[\\/]+/, '');
}

/* ---------- 路径归一 ---------- */

/** 路径看起来是不是 Windows 形态。用来决定比较时是否忽略大小写 ——
 *  不靠 navigator.platform：那个值在 jsdom 和真实浏览器里不一样，
 *  而路径字符串本身已经足够说明问题。 */
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
 * 放在 util.js 是为了让它们用**同一份**归一化规则 —— 各写一份迟早会漂移。
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

/* ---------- 图标 ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(paths) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
  }
  return s;
}

export const ICONS = {
  terminal: '<svg viewBox="0 0 24 24"><polyline points="5 8 9.5 12 5 16"/><path d="M12.5 16h6.5"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M16.5 4.5l3 3L8.5 18.5 4.5 20l1.5-4z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>',
  tool: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 1 5 5l-8.4 8.4a2 2 0 0 1-2.8-2.8z"/><path d="M5 5l4 4"/></svg>',
};

export const FILE_ICON = {
  pdf: ['M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z', 'M14 3.5V7.5H18'],
  doc: ['M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z', 'M14 3.5V7.5H18', 'M9 12h6M9 15.5h4'],
  text: ['M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z', 'M14 3.5V7.5H18', 'M9 12h6M9 15.5h6'],
  bin: ['M6 5.5h12v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z', 'M9.5 5.5V4h5v1.5', 'M10 10v6M14 10v6'],
};

export function iconFor(name) {
  const ext = (String(name).match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  if (ext === 'pdf') return FILE_ICON.pdf;
  if (ext === 'doc' || ext === 'docx') return FILE_ICON.doc;
  if (['txt', 'md', 'csv', 'json', 'log', 'yml', 'yaml', 'xml'].includes(ext)) return FILE_ICON.text;
  return FILE_ICON.bin;
}
