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
 *   - 相对路径与裸文件名只先标记为候选，等后端确认存在（唯一）后才变成
 *     可点击链接；
 *   - 工作区绝对路径落在 cwd 内时仍按相对路径处理；落在 cwd 外则作为
 *     “工作区外文件”返回，但**不做任何读取**，授权由用户点击后的原生
 *     对话框完成（见 file-links-ui.js / electron/external-files.cjs）。
 *
 * 真正的权限判断仍在后端：这里只是“看起来可以”，不是授权。 */

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ELIDED = /(?:\.\.\.|…)/;
const WINDOWS_BAD_CHARS = /[<>"|?*]/;
const MAX_PATH_CHARS = 1024;
const MAX_POSITION = 10_000_000;

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
  if (!bare || (bare.startsWith('.') && bare.indexOf('.', 1) < 0)) return '';
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
  if (!p || p.length > MAX_PATH_CHARS) return false;
  if (CONTROL.test(p)) return false;
  if (ELIDED.test(p)) return false;
  if (/^[\\/]{2}/.test(p)) return false; // UNC / 协议相对地址
  if (WINDOWS_BAD_CHARS.test(p)) return false;
  if (/\/\/+/.test(p.replace(WINDOWS_DRIVE, 'C:/'))) return false;
  if (/[\\/]$/.test(p)) return false; // 目录
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

function sameFlavor(a, b) {
  return isWindowsPath(a) === isWindowsPath(b);
}

function internalResolution(root, abs, windows) {
  const inside = samePathPrefix(root, abs, windows);
  if (!inside.inside) return null;
  if (!inside.rel) return { code: 'directory' };
  if (!validFilePathShape(inside.rel, { allowBare: true })) return { code: 'shape' };
  return { path: inside.rel, absolutePath: abs, cwd: root, windows, external: false };
}

/**
 * 把引用路径解析到消息 cwd 下；默认只接受工作区内路径（既有调用与测试
 * 的安全默认）。需要展示工作区外绝对路径时显式传 `allowExternal: true`。
 *
 * @returns {{ok:true, path:string, absolutePath:string, cwd:string,
 *            windows:boolean, external:boolean} | {ok:false, reason:string}}
 */
export function resolveFileReference(rawPath, cwd, { allowExternal = false } = {}) {
  const raw = String(rawPath ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty' };
  const root = normalizeCwd(cwd);

  if (isAbsolutePath(raw)) {
    const abs = normalizeSegmentsAbsolute(raw);
    if (!abs) return { ok: false, reason: 'escape' };
    if (root && !sameFlavor(root, abs)) return { ok: false, reason: 'shape' };
    if (root) {
      const internal = internalResolution(root, abs, isWindowsPath(root));
      if (internal?.code) return { ok: false, reason: internal.code };
      if (internal) return { ok: true, ...internal };
    }
    if (!allowExternal) return { ok: false, reason: 'outside' };
    if (!validFilePathShape(abs, { allowBare: true })) return { ok: false, reason: 'shape' };
    return {
      ok: true,
      path: toSlashes(abs),
      absolutePath: abs,
      cwd: root || '',
      windows: isWindowsPath(abs),
      external: true,
    };
  }

  if (!root) return { ok: false, reason: 'no_workspace' };
  if (raw.startsWith('~')) return { ok: false, reason: 'home' };
  if (!validFilePathShape(raw, { allowBare: true })) return { ok: false, reason: 'shape' };
  const abs = normalizeSegmentsAbsolute(root + '/' + raw);
  if (!abs) return { ok: false, reason: 'escape' };
  const internal = internalResolution(root, abs, isWindowsPath(root));
  if (internal?.code) return { ok: false, reason: internal.code };
  if (!internal) return { ok: false, reason: 'outside' };
  return { ok: true, ...internal };
}

/** 工作区内部的严格解析（既有 API，行为不变）。 */
export function resolveFilePath(rawPath, cwd) {
  return resolveFileReference(rawPath, cwd, { allowExternal: false });
}

function makeMeta(raw, cwd, source, { candidate = false, allowExternal = false, verification = '' } = {}) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const { path: pathPart, line, column, endLine, endColumn } = splitPosition(trimmed);
  const resolved = resolveFileReference(pathPart, cwd, { allowExternal });
  if (!resolved.ok) return null;
  return {
    path: resolved.path,
    absolutePath: resolved.absolutePath,
    cwd: resolved.cwd,
    name: baseName(resolved.path),
    displayPath: pathPart,
    external: resolved.external === true,
    line,
    column,
    endLine,
    endColumn,
    position: positionLabel({ line, column, endLine, endColumn }),
    source,
    candidate: candidate === true,
    verification,
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
 * 但地址形状仍必须是文件，且最终必须落在工作区内（或明确允许的工作区外
 * 绝对路径，后者不做读取，等用户授权）。 */
export function fileLinkFromHref(href, cwd, { allowExternal = false } = {}) {
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
  return makeMeta(text, cwd, 'markdown', { allowExternal });
}

/* 行内代码。要求“明确像文件路径”；单文件名只生成候选，等后端确认唯一。 */
export function fileLinkFromInlineCode(code, cwd, { allowExternal = false } = {}) {
  const text = String(code ?? '').trim();
  if (!text || text.length > MAX_PATH_CHARS) return null;
  if (/[\n\r]/.test(text)) return null;
  if (text.startsWith('`') || text.endsWith('`')) return null;
  if (/^https?:/i.test(text) || /^(?:mailto|data|javascript|vbscript|blob|chrome|about):/i.test(text)) return null;
  if (text.includes(' ') && !isAbsolutePath(text) && !hasSeparator(text)) return null;
  if (isAbsolutePath(text) && /^\s|\s$/.test(text)) return null;
  if (text.startsWith('@')) return null;
  const { path: pathPart, line } = splitPosition(text);
  if (!validFilePathShape(pathPart, { allowBare: true })) return null;
  const separated = hasSeparator(pathPart) || isAbsolutePath(pathPart);
  const positioned = line !== null;
  const source = 'code';
  if (!separated && !positioned) {
    // 单个 `README.md`：可能是泛指的“README.md 这个文件”，必须查存在且唯一。
    return makeMeta(text, cwd, source, { candidate: true, allowExternal, verification: 'find' });
  }
  if (!separated && positioned) {
    // `main.ts:12` 有了明确位置，但仍是裸文件名，需要查同名文件。
    return makeMeta(text, cwd, source, { candidate: true, allowExternal, verification: 'find' });
  }
  // 有分隔符但仍可能不存在；点击后由后端给出简洁错误。
  return makeMeta(text, cwd, source, { allowExternal });
}

/* 纯文本里的 `example.com/x.ts` 更像网址而不是仓库路径；只有首段确实
 * 是带常见 TLD 的主机名形状时才排除，`src.v2/main.ts` 不受影响。 */
function looksLikeBareUrlPath(value) {
  const head = toSlashes(value).split('/')[0] || '';
  if (!hasSeparator(value) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(head)) return false;
  const tld = head.slice(head.lastIndexOf('.') + 1).toLowerCase();
  return HOST_LIKE_TLDS.has(tld);
}

/* 纯文本。没有反引号/链接语义时：
 *   - 绝对路径可以直接识别；
 *   - 相对路径必须含分隔符（或带明确行号），且只作为候选，等后端确认存在；
 *   - 默认不扫描相对路径（调用方显式传 relative: true），避免纯函数被误用。 */
export function fileLinkFromPlainText(text, cwd, { allowExternal = false, relative = false } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  if (/\s/.test(raw)) return null;
  if (raw.startsWith('@')) return null;
  const { path: pathPart, line } = splitPosition(raw);
  const positioned = line !== null;
  const absolute = isAbsolutePath(pathPart);
  if (!absolute && !relative && !positioned) return null;
  if (!absolute && !hasSeparator(pathPart) && !positioned) return null;
  if (!absolute && looksLikeBareUrlPath(pathPart)) return null;
  if (!validFilePathShape(pathPart, { allowBare: positioned })) return null;
  const candidate = !absolute;
  return makeMeta(raw, cwd, 'text', {
    candidate,
    allowExternal,
    verification: candidate ? 'metadata' : '',
  });
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

const PATH_STOP = '\\s<>"\'`|?*，。；：！？、（）【】「」『』';
const ABSOLUTE_PATH_RE = new RegExp(
  `(?:[A-Za-z]:[\\\\/]|/(?!/))[^${PATH_STOP}]+`,
  'g',
);
const FILE_URI_RE = new RegExp(
  `file:///[^${PATH_STOP}]+`,
  'gi',
);
const RELATIVE_PATH_RE = new RegExp(
  `(?:\\.{1,2}[\\\\/])?(?:[\\p{L}\\p{N}_.@-]+[\\\\/])+[\\p{L}\\p{N}_.@-]+` +
  `(?::\\d+(?::\\d+)?(?:-\\d+(?::\\d+)?)?|#L\\d+(?:C\\d+)?(?:-L?\\d+(?:C\\d+)?)?)?`,
  'gu',
);
const MAX_SCAN_MATCHES = 48;

/** 扫描一段纯文本里的可识别文件引用，返回位置与元数据。
 *  调用方负责把匹配区间替换成自己的占位符；这里不改动原文。
 *  相对路径默认不扫描；只有显式 `relative: true` 才产生候选。 */
export function scanPlainTextPaths(text, cwd, { allowExternal = false, relative = false } = {}) {
  const src = String(text ?? '');
  if (!src || !normalizeCwd(cwd)) return [];
  const found = [];
  const seen = new Set();

  const consider = (start, rawMatch) => {
    if (found.length >= MAX_SCAN_MATCHES) return;
    const prev = start > 0 ? src[start - 1] : '';
    // URL、模块说明符和已有占位符内部的字符不参与。
    if (prev && (/[\w@:/\\+\-.]/.test(prev) || prev === '&' || prev === '\u0001' || prev === '\u0002')) return;
    const raw = trimPlainPath(rawMatch);
    if (!raw || raw.length < 3) return;
    const key = start + ':' + raw;
    if (seen.has(key)) return;
    const meta = /^file:/i.test(raw)
      ? fileLinkFromHref(raw, cwd, { allowExternal })
      : fileLinkFromPlainText(raw, cwd, { allowExternal, relative });
    if (!meta) return;
    seen.add(key);
    found.push({ start, end: start + raw.length, text: raw, meta });
  };

  for (const match of src.matchAll(FILE_URI_RE)) consider(match.index, match[0]);
  for (const match of src.matchAll(ABSOLUTE_PATH_RE)) consider(match.index, match[0]);
  if (relative) for (const match of src.matchAll(RELATIVE_PATH_RE)) consider(match.index, match[0]);

  // 绝对匹配可能覆盖相对匹配；保留起点更早、终点更远的那个。
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let lastEnd = -1;
  for (const hit of found) {
    if (hit.start < lastEnd) continue;
    out.push(hit);
    lastEnd = hit.end;
  }
  return out;
}

/** target 是否位于 root 之内（两端都归一化；Windows 大小写不敏感）。
 *  只用于校验后端返回的绝对路径是否仍属于消息所属工作区。 */
export function isPathWithin(root, target) {
  const base = normalizeSegmentsAbsolute(String(root ?? ''));
  const abs = normalizeSegmentsAbsolute(String(target ?? ''));
  if (!base || !abs) return false;
  if (!sameFlavor(base, abs)) return false;
  const windows = isWindowsPath(base);
  const rel = samePathPrefix(base, abs, windows);
  return rel.inside && Boolean(rel.rel);
}

/** 文件名候选（无分隔符）是否值得查后端。 */
export function uniqueNameCandidate(meta) {
  return Boolean(meta?.candidate && meta.name && !hasSeparator(meta.path));
}

/** 显示用标签：工作区内显示文件名 + 位置；工作区外显示模型给的原始路径。 */
export function fileLinkDisplayLabel(meta) {
  if (!meta) return '';
  const base = meta.external ? (meta.displayPath || meta.path) : meta.name;
  return base + (meta.position || '');
}

export function fileLinkAriaLabel(meta) {
  const p = meta?.external ? (meta.displayPath || meta.path) : (meta?.path || '');
  const range = rangeLabel(meta);
  return range ? `${p}，${range}` : p;
}
