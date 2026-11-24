/* 会话内文件引用的识别与工作区解析。
 *
 * 纯函数，不碰 DOM、不发请求：Markdown 渲染、悬停查询、Files 面板联动
 * 都用这一套规则，避免“渲染时一套、点击时另一套”导致链接和实际打开
 * 的文件不是同一个。
 *
 * 规则参考 T3 Code（MIT）的 markdownLinks.ts / fileLinks.ts，并按 Pi-GUI
 * 的安全边界收紧：
 *   - 只解析“像文件”的路径（有扩展名或已知无扩展名文件名）；
 *   - 不把 HTTP(S)、mailto、npm 包名、模块标识符、版本号、提交哈希、
 *     省略号路径、主机名当成文件；
 *   - 相对路径按“这条消息所属会话的 cwd”解析，绝不使用全局当前项目；
 *   - 解析结果必须落在 cwd 内，`..` 越界直接拒绝；
 *   - 纯文件名（无分隔符）只作为候选，等后端确认唯一存在后才变成链接。
 *
 * 真正的权限判断仍在后端：这里只是“看起来可以”，不是授权。 */

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ELIDED = /(?:\.\.\.|…)/;

const KNOWN_EXTENSIONLESS = new Set([
  'makefile', 'dockerfile', 'readme', 'license', 'licence', 'changelog',
  'changes', 'procfile', 'gemfile', 'rakefile', 'vagrantfile', 'brewfile',
  'justfile', 'jenkinsfile', 'go.mod', 'go.sum', 'cargo.lock', 'pipfile',
]);
/* 点文件本身没有“扩展名”，但它们是真实文件，不该被当成普通技术术语。 */
const DOTFILES = new Set([
  '.env', '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig',
  '.npmrc', '.nvmrc', '.prettierrc', '.prettierignore', '.eslintrc',
  '.eslintignore', '.babelrc', '.stylelintrc', '.htaccess',
]);
/* 只有“单个文件名 + 点”的形态才需要排除的主机名后缀。带目录的
 * `src/foo.com` 仍然是文件路径。 */
const HOST_LIKE_TLDS = new Set([
  'com', 'org', 'net', 'io', 'dev', 'ai', 'cn', 'app', 'so', 'gg', 'me',
  'co', 'edu', 'gov', 'xyz', 'tech', 'site', 'online', 'top', 'info',
]);

const MAX_POSITION = 10_000_000;

export function toSlashes(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

export function isWindowsPath(value) {
  return WINDOWS_DRIVE.test(String(value ?? ''));
}

export function isAbsolutePath(value) {
  const p = String(value ?? '');
  return WINDOWS_DRIVE.test(p) || (p.startsWith('/') && !p.startsWith('//'));
}

export function baseName(value) {
  const p = toSlashes(value).replace(/\/+$/, '');
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

function extensionOf(name) {
  const bare = String(name ?? '');
  if (!bare || bare.startsWith('.') && bare.indexOf('.', 1) < 0) return '';
  const i = bare.lastIndexOf('.');
  return i > 0 ? bare.slice(i).toLowerCase() : '';
}

function hasSeparator(value) {
  return /[\\/]/.test(value);
}

function looksVersionLike(value) {
  return /^v?\d+(?:\.\d+){1,4}(?:[-+][\w.]+)?$/i.test(value)
    || /^[0-9a-f]{7,40}$/i.test(value)
    || /^\d+(?:\.\d+)+$/.test(value);
}

function looksLikeHostname(value) {
  if (hasSeparator(value)) return false;
  const ext = extensionOf(value).slice(1);
  return Boolean(ext) && HOST_LIKE_TLDS.has(ext) && value.split('.').length === 2;
}

/* `:128` / `:128:10` / `:128-145` / `:128:10-145:2`，以及 `#L128C10-L145`。
 * 只从**末尾**取，避免把 Windows 盘符的冒号当行号。 */
export function splitPosition(input) {
  const text = String(input ?? '');
  let hashLine = null;
  let hashColumn = null;
  let hashEndLine = null;
  let hashEndColumn = null;

  const hash = /#L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C(\d+))?)?$/i.exec(text);
  if (hash) {
    hashLine = Number(hash[1]);
    hashColumn = hash[2] ? Number(hash[2]) : null;
    hashEndLine = hash[3] ? Number(hash[3]) : null;
    hashEndColumn = hash[4] ? Number(hash[4]) : null;
    const path = text.slice(0, hash.index);
    const parsed = validPosition(hashLine, hashColumn, hashEndLine, hashEndColumn);
    if (parsed) return { path, ...parsed };
    return { path: text, line: null, column: null, endLine: null, endColumn: null };
  }

  const colon = /:(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?$/.exec(text);
  if (!colon) return { path: text, line: null, column: null, endLine: null, endColumn: null };
  // Windows 盘符后面必须还有路径分隔符；`C:12` 不是文件，别当路径。
  const path = text.slice(0, colon.index);
  if (!path || /^[A-Za-z]:$/.test(path)) {
    return { path: text, line: null, column: null, endLine: null, endColumn: null };
  }
  const parsed = validPosition(
    Number(colon[1]),
    colon[2] ? Number(colon[2]) : null,
    colon[3] ? Number(colon[3]) : null,
    colon[4] ? Number(colon[4]) : null,
  );
  return parsed ? { path, ...parsed } : { path: text, line: null, column: null, endLine: null, endColumn: null };
}

function validPosition(line, column, endLine, endColumn) {
  const ok = (n) => n === null || (Number.isSafeInteger(n) && n >= 1 && n <= MAX_POSITION);
  if (!Number.isSafeInteger(line) || line < 1 || line > MAX_POSITION) return null;
  if (!ok(column) || !ok(endLine) || !ok(endColumn)) return null;
  if (column !== null && endLine === null && endColumn !== null) return null;
  if (endLine !== null && endLine < line) return null;
  if (endLine !== null && endColumn !== null && endLine === line && column !== null && endColumn < column) return null;
  return { line, column, endLine, endColumn };
}

export function positionLabel({ line, column, endLine, endColumn } = {}) {
  if (!line) return '';
  if (!endLine) return ':' + line + (column ? ':' + column : '');
  const start = line + (column ? ':' + column : '');
  const end = endLine + (endColumn ? ':' + endColumn : '');
  return ':' + start + '-' + end;
}

export function rangeLabel({ line, endLine } = {}) {
  if (!line) return '';
  return endLine && endLine !== line ? `L${line}–${endLine}` : `L${line}`;
}

function validFilePathShape(value, { allowBare = false } = {}) {
  const p = String(value ?? '');
  if (!p || p.length > 1024) return false;
  if (CONTROL.test(p)) return false;
  if (ELIDED.test(p)) return false;
  if (/^[\\/]{2}/.test(p)) return false; // UNC / 协议相对地址
  if (/[<>"|?*]/.test(p)) return false;
  if (/\/\/+/.test(p.replace(WINDOWS_DRIVE, 'C:/'))) return false;
  if (/[\\/]$/.test(p)) return false;
  if (!allowBare && !hasSeparator(p) && !isAbsolutePath(p)) return false;

  const name = baseName(p);
  if (!name || name === '.' || name === '..') return false;
  if (looksVersionLike(name)) return false;
  if (looksLikeHostname(name)) return false;
  if (DOTFILES.has(name.toLowerCase())) return true;
  if (KNOWN_EXTENSIONLESS.has(name.toLowerCase())) return true;

  const ext = extensionOf(name);
  if (!ext) return false;
  if (ext.length > 12) return false;
  if (!/^\.[\p{L}\p{N}][\p{L}\p{N}+_-]*$/u.test(ext)) return false;
  // 文件名里不接受额外冒号（行号已经剥离）；Windows 盘符除外。
  const withoutDrive = p.replace(WINDOWS_DRIVE, '');
  if (withoutDrive.includes(':')) return false;
  return true;
}

function normalizeSegmentsAbsolute(absPath) {
  const p = toSlashes(absPath);
  const drive = /^([A-Za-z]):/.exec(p);
  const root = drive ? drive[1].toUpperCase() + ':/' : '/';
  const rest = drive ? p.slice(drive[0].length) : p;
  const out = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return root + out.join('/');
}

function normalizeCwd(cwd) {
  const value = String(cwd ?? '').trim();
  if (!value || !isAbsolutePath(value)) return null;
  return normalizeSegmentsAbsolute(value);
}

function samePathPrefix(cwd, abs, windows) {
  const a = windows ? cwd.toLowerCase() : cwd;
  const b = windows ? abs.toLowerCase() : abs;
  if (a === b) return { inside: true, rel: '' };
  const prefix = a.endsWith('/') ? a : a + '/';
  if (!b.startsWith(prefix)) return { inside: false };
  return { inside: true, rel: abs.slice(prefix.length) };
}

/**
 * 把引用路径解析到消息 cwd 下。
 * @returns {{ok:true, path:string, absolutePath:string, cwd:string, windows:boolean} |
 *           {ok:false, reason:string}}
 */
export function resolveFilePath(rawPath, cwd) {
  const root = normalizeCwd(cwd);
  if (!root) return { ok: false, reason: 'no_workspace' };
  const raw = String(rawPath ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty' };

  const windows = isWindowsPath(root);
  let abs;
  if (isAbsolutePath(raw)) {
    abs = normalizeSegmentsAbsolute(raw);
  } else {
    if (raw.startsWith('~')) return { ok: false, reason: 'home' };
    if (!validFilePathShape(raw, { allowBare: true })) return { ok: false, reason: 'shape' };
    abs = normalizeSegmentsAbsolute(root + '/' + raw);
  }
  if (!abs) return { ok: false, reason: 'escape' };

  const inside = samePathPrefix(root, abs, windows);
  if (!inside.inside) return { ok: false, reason: 'outside' };
  if (!inside.rel) return { ok: false, reason: 'directory' };
  if (!validFilePathShape(inside.rel, { allowBare: true })) return { ok: false, reason: 'shape' };

  return { ok: true, path: inside.rel, absolutePath: abs, cwd: root, windows };
}

function makeMeta(raw, cwd, source, { candidate = false } = {}) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const { path: pathPart, line, column, endLine, endColumn } = splitPosition(trimmed);
  const resolved = resolveFilePath(pathPart, cwd);
  if (!resolved.ok) return null;
  return {
    path: resolved.path,
    absolutePath: resolved.absolutePath,
    cwd: resolved.cwd,
    name: baseName(resolved.path),
    line,
    column,
    endLine,
    endColumn,
    position: positionLabel({ line, column, endLine, endColumn }),
    source,
    candidate: candidate === true,
  };
}

function decodePercent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/* Markdown 链接地址。显式链接视为作者意图，单文件名也可以直接成为链接；
 * 但地址形状仍必须是文件，且最终必须落在工作区内。 */
export function fileLinkFromHref(href, cwd) {
  let raw = String(href ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1).trim();
  if (!raw || raw.startsWith('#')) return null;
  if (/^https?:/i.test(raw) || /^(?:mailto|data|javascript|vbscript|blob|chrome|about):/i.test(raw)) return null;

  let text = raw;
  // 盘符也是“字母 + 冒号”，必须先排除，否则 C:/x 会被当成未知 scheme。
  const scheme = WINDOWS_DRIVE.test(text) ? null : SCHEME.exec(text);
  if (scheme) {
    if (scheme[0].toLowerCase() !== 'file:') return null;
    let rest = text.slice(5);
    if (rest.startsWith('//')) {
      rest = rest.slice(2);
      const slash = rest.indexOf('/');
      if (slash < 0) return null;
      const host = rest.slice(0, slash);
      if (host && host.toLowerCase() !== 'localhost') return null;
      rest = rest.slice(slash);
    }
    text = rest;
    if (/^\/[A-Za-z]:[\\/]/.test(text)) text = text.slice(1);
  }

  /* 查询串与片段不属于路径；`#L12C3-L20` 是位置信息，要保留给 splitPosition。
   * 先取片段再切查询串，`x.md?plain=1#L5` 才不会丢掉行号。 */
  let base = text;
  let fragment = '';
  const hash = text.indexOf('#');
  if (hash >= 0) {
    base = text.slice(0, hash);
    fragment = text.slice(hash);
  }
  const query = base.indexOf('?');
  if (query >= 0) base = base.slice(0, query);
  text = base + (/^#L\d/i.test(fragment) ? fragment : '');

  text = decodePercent(text);
  if (!text) return null;
  const { path: pathPart } = splitPosition(text);
  if (!validFilePathShape(pathPart, { allowBare: true })) return null;
  return makeMeta(text, cwd, 'markdown');
}

/* 行内代码。要求“明确像文件路径”；单文件名只生成候选，等后端确认唯一。 */
export function fileLinkFromInlineCode(code, cwd) {
  let text = String(code ?? '').trim();
  if (!text || text.length > 1024) return null;
  if (/[\n\r]/.test(text)) return null;
  if (text.startsWith('`') || text.endsWith('`')) return null;
  if (/^https?:/i.test(text) || /^(?:mailto|data|javascript|vbscript|blob|chrome|about):/i.test(text)) return null;
  if (text.includes(' ') && !isAbsolutePath(text) && !hasSeparator(text)) return null;
  if (isAbsolutePath(text) && /^\s|\s$/.test(text)) return null;
  if (text.startsWith('@')) return null;
  const { path: pathPart } = splitPosition(text);
  if (!validFilePathShape(pathPart, { allowBare: true })) return null;
  const separated = hasSeparator(pathPart) || isAbsolutePath(pathPart);
  const positioned = splitPosition(text).line !== null;
  const source = 'code';
  if (!separated && !positioned) {
    // 单个 `README.md`：可能是泛指的“README.md 这个文件”，必须查存在且唯一。
    return makeMeta(text, cwd, source, { candidate: true });
  }
  // 有分隔符但仍可能不存在；候选标记保持 false，渲染成链接，点击后给出简洁错误。
  return makeMeta(text, cwd, source);
}

/* 纯文本里只认绝对路径（或带行号的相对路径）。没有反引号/链接语义时，
 * 普通相对路径与 npm 包名/模块标识符无法可靠区分，宁可不转。 */
export function fileLinkFromPlainText(text, cwd) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const positioned = splitPosition(raw).line !== null;
  if (!isAbsolutePath(raw) && !positioned) return null;
  if (/\s/.test(raw)) return null;
  if (!validFilePathShape(raw.replace(/:(\d+)(?::\d+)?(?:-\d+(?::\d+)?)?$/, ''), { allowBare: false })) return null;
  return makeMeta(raw, cwd, 'text');
}

function trimPlainPath(value) {
  let text = value;
  while (text) {
    const last = text[text.length - 1];
    if (/[\s.,;:!?'"]/.test(last)) {
      text = text.slice(0, -1);
      continue;
    }
    if (last === ')' && (text.match(/\(/g) || []).length < (text.match(/\)/g) || []).length) {
      text = text.slice(0, -1);
      continue;
    }
    if (last === ']' && (text.match(/\[/g) || []).length < (text.match(/\]/g) || []).length) {
      text = text.slice(0, -1);
      continue;
    }
    break;
  }
  return text;
}

/** 扫描一段纯文本里的可识别文件引用，返回位置与元数据。
 *  调用方负责把匹配区间替换成自己的占位符；这里不改动原文。 */
export function scanPlainTextPaths(text, cwd) {
  const src = String(text ?? '');
  if (!src || !normalizeCwd(cwd)) return [];
  const out = [];
  const re = /(?:[A-Za-z]:[\\/]|\/(?!\/))[^\s<>"'`|?*，。；：！？、（）【】「」『』]+/g;
  let match;
  while ((match = re.exec(src))) {
    const prev = match.index > 0 ? src[match.index - 1] : '';
    if (prev && (/[\w@:/\\+\-.]/.test(prev) || prev === '&')) continue;
    const raw = trimPlainPath(match[0]);
    if (!raw || raw.length < 3) continue;
    const meta = fileLinkFromPlainText(raw, cwd);
    if (!meta) continue;
    // 位置后缀可能被 trim 掉尾随标点，重新按最终文本定位。
    const end = match.index + raw.length;
    out.push({ start: match.index, end, text: raw, meta });
    re.lastIndex = Math.max(re.lastIndex, end);
  }
  return out;
}

/** target 是否位于 root 之内（两端都归一化；Windows 大小写不敏感）。
 *  只用于校验后端返回的绝对路径是否仍属于消息所属工作区。 */
export function isPathWithin(root, target) {
  const base = normalizeSegmentsAbsolute(String(root ?? ''));
  const abs = normalizeSegmentsAbsolute(String(target ?? ''));
  if (!base || !abs) return false;
  const windows = isWindowsPath(base);
  const rel = samePathPrefix(base, abs, windows);
  return rel.inside && Boolean(rel.rel);
}

/** 文件名候选（无分隔符）是否值得查后端：只用于行内代码。 */
export function uniqueNameCandidate(meta) {
  return Boolean(meta?.candidate && meta.name && !hasSeparator(meta.path));
}

export function fileLinkAriaLabel(meta) {
  const p = meta?.path || '';
  const range = rangeLabel(meta);
  return range ? `${p}，${range}` : p;
}
