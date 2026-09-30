/* Read-only Pi 0.87.0 path rules (package-manager.js / extensions/loader.js).
 * No Pi resolver, code import, package scripts or subprocesses.
 * Native glob APIs are available on the supported Node >=22.19 baseline. */
import fs from 'node:fs';
import path from 'node:path';

const MAX_JSON_BYTES = 256 * 1024;
const MAX_PATHS = 300;
const posix = (value) => value.split(path.sep).join('/');
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
function hasSymlinkComponent(file) {
  let current = path.resolve(file);
  while (true) {
    try { if (fs.lstatSync(current).isSymbolicLink()) return true; } catch { /* missing component */ }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
export function readExtensionJson(file) {
  try {
    if (hasSymlinkComponent(file)) return { data: null, error: 'metadata-invalid' };
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return { data: null, error: 'metadata-invalid' };
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return data && typeof data === 'object' && !Array.isArray(data)
      ? { data, error: null } : { data: null, error: 'metadata-invalid' };
  } catch (error) { return { data: null, error: error?.code === 'ENOENT' ? 'missing' : 'metadata-invalid' }; }
}

// Reject links in every component, including links to missing targets. Pi allows
// some explicit symlink roots; the GUI intentionally retains its stricter boundary.
export function containedExtensionPath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || path.posix.isAbsolute(relative)) return null;
  const candidate = path.resolve(root, relative);
  if (!inside(path.resolve(root), candidate)) return null;
  if (hasSymlinkComponent(candidate)) return null;
  try { if (!inside(fs.realpathSync(root), fs.realpathSync(candidate))) return null; } catch { /* missing remains a candidate */ }
  return candidate;
}
const stat = (file) => { try { const s = fs.lstatSync(file); return s.isSymbolicLink() ? null : s; } catch { return null; } };
const diagnostic = (diagnostics, code) => diagnostics.push({ phase: 'discovery', code,
  message: ({ 'outside-root': '扩展路径越过根目录或经过符号链接', 'metadata-invalid': '扩展元数据无法解析',
    'pattern-unresolved': '该扩展模式无法安全确认', 'discovery-limit': '扩展发现达到安全数量限制',
    'ignore-unresolved': '目录忽略文件尚未解析，配置启用状态无法完整确认' })[code] || '扩展路径无法确认' });

// matchesAnyPattern / matchesAnyExactPattern: extension paths have no SKILL.md
// parent matching. Exact patterns never match a basename alone.
function match(file, raw, base, exact) {
  if (typeof raw !== 'string' || raw.length > 2048 || raw.includes('\0')) return null;
  let pattern = posix(raw);
  if (exact && pattern.startsWith('./')) pattern = pattern.slice(2);
  const relative = posix(path.relative(base, file));
  const absolute = posix(file);
  if (exact) return pattern === relative || pattern === absolute;
  try { return [relative, path.basename(file), absolute].some(value => path.posix.matchesGlob(value, pattern)); }
  catch { return null; }
}
const any = (file, patterns, base, exact) => {
  const values = patterns.map(pattern => match(file, pattern, base, exact));
  return values.includes(true) ? true : values.includes(null) ? null : false;
};
export function applyExtensionPatterns(files, patterns, base, { overridesOnly = false, emptyDisables = false } = {}) {
  if (!Array.isArray(patterns) || patterns.some(p => typeof p !== 'string')) return new Map(files.map(file => [file, null]));
  const includes = patterns.filter(p => !/^[!+-]/.test(p));
  const excludes = patterns.filter(p => p.startsWith('!')).map(p => p.slice(1));
  const forceIncludes = patterns.filter(p => p.startsWith('+')).map(p => p.slice(1));
  const forceExcludes = patterns.filter(p => p.startsWith('-')).map(p => p.slice(1));
  return new Map(files.map(file => {
    let enabled = emptyDisables && patterns.length === 0 ? false
      : !overridesOnly && includes.length ? any(file, includes, base, false) : true;
    const exclude = any(file, excludes, base, false);
    if (exclude === true) enabled = false;
    else if (exclude === null && enabled !== false) enabled = null;
    const include = any(file, forceIncludes, base, true);
    if (include === true) enabled = true;
    else if (include === null && enabled !== true) enabled = null;
    const remove = any(file, forceExcludes, base, true);
    if (remove === true) enabled = false;
    else if (remove === null && enabled !== false) enabled = null;
    return [file, enabled];
  }));
}

export function resolveExtensionPaths(target, { diagnostics = [], boundary = target, missing = false } = {}) {
  if (hasSymlinkComponent(target)) { diagnostic(diagnostics, 'outside-root'); return []; }
  const result = [];
  const seen = new Set();
  const append = (file, ownerRoot, metadata, error = null, uncertain = false) => {
    if (result.length >= MAX_PATHS) { diagnostic(diagnostics, 'discovery-limit'); return; }
    if (!seen.has(file)) { seen.add(file); result.push({ file, ownerRoot, metadata, error, uncertain }); }
  };
  function directory(dir, depth = 0, allowCollection = true) {
    if (depth > 8) { diagnostic(diagnostics, 'discovery-limit'); return; }
    const meta = readExtensionJson(path.join(dir, 'package.json'));
    if (meta.error === 'metadata-invalid') diagnostic(diagnostics, 'metadata-invalid');
    const entries = meta.data?.pi?.extensions;
    const explicit = [];
    if (Array.isArray(entries) && entries.every(p => typeof p === 'string') && entries.length) {
      for (const entry of entries.slice(0, MAX_PATHS)) {
        // Unlike package manifests, directory entry manifests use literal paths.
        const file = containedExtensionPath(dir, entry);
        if (!file || !inside(boundary, file)) { diagnostic(diagnostics, 'outside-root'); continue; }
        if (stat(file)) explicit.push(file);
      }
    }
    if (explicit.length) {
      for (const file of explicit) append(file, dir, meta.data, meta.error === 'metadata-invalid' ? meta.error : null);
      return;
    }
    for (const name of ['index.ts', 'index.js']) {
      const file = containedExtensionPath(dir, name);
      if (file && stat(file)?.isFile()) { append(file, dir, meta.data, meta.error === 'metadata-invalid' ? meta.error : null); return; }
    }
    if (!allowCollection) return;
    let entriesInDir;
    try { entriesInDir = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const uncertain = ['.gitignore', '.ignore', '.fdignore'].some(name => stat(path.join(dir, name))?.isFile());
    if (uncertain) diagnostic(diagnostics, 'ignore-unresolved');
    for (const entry of entriesInDir.slice(0, MAX_PATHS)) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const file = containedExtensionPath(dir, entry.name);
      if (!file) { diagnostic(diagnostics, 'outside-root'); continue; }
      if (entry.isFile() && /\.[jt]s$/.test(entry.name)) append(file, dir, meta.data, meta.error === 'metadata-invalid' ? meta.error : null, uncertain);
      else if (entry.isDirectory()) {
        // Auto discovery only resolves child entry points; no arbitrary recursion.
        const childMeta = readExtensionJson(path.join(file, 'package.json'));
        const childEntries = childMeta.data?.pi?.extensions;
        const hasEntry = Array.isArray(childEntries) && childEntries.length || ['index.ts', 'index.js'].some(name => stat(path.join(file, name))?.isFile());
        if (hasEntry) {
          const start = result.length;
          directory(file, depth + 1, false);
          if (uncertain) for (const row of result.slice(start)) row.uncertain = true;
        } else if (childMeta.error === 'metadata-invalid') diagnostic(diagnostics, 'metadata-invalid');
      }
    }
  }
  const targetStat = stat(target);
  if (targetStat?.isDirectory()) directory(target);
  else if (targetStat?.isFile() || missing) append(target, path.dirname(target), null);
  return result;
}

export function resolvePackageExtensionPaths(root, metadata, { diagnostics = [], filtered = false, objectForm = false } = {}) {
  const pi = metadata?.pi;
  const manifest = pi && typeof pi === 'object' && !Array.isArray(pi);
  const declarations = Array.isArray(pi?.extensions) && pi.extensions.every(p => typeof p === 'string') ? pi.extensions : null;
  // Pi's filtered collectManifestFiles falls back for empty/absent declarations;
  // unfiltered collectPackageResources with a pi object does not.
  if (!declarations?.length) {
    if (!filtered && (declarations !== null || manifest && !objectForm)) return [];
    return resolveExtensionPaths(path.join(root, 'extensions'), { diagnostics, boundary: root });
  }
  const rows = new Map();
  for (const entry of declarations.filter(p => !/^[!+-]/.test(p)).slice(0, MAX_PATHS)) {
    if (!containedExtensionPath(root, entry)) { diagnostic(diagnostics, 'outside-root'); continue; }
    let targets = [];
    if (/[*?]/.test(entry)) {
      try {
        targets = fs.globSync(entry, { cwd: root }).filter(p => !p.split(/[\\/]/).some(segment => segment.startsWith('.'))).sort()
          .slice(0, MAX_PATHS).map(p => containedExtensionPath(root, p)).filter(Boolean);
      } catch { diagnostic(diagnostics, 'pattern-unresolved'); }
    } else targets = [containedExtensionPath(root, entry)];
    for (const target of targets) {
      for (const row of resolveExtensionPaths(target, { diagnostics, boundary: root })) {
        if (!rows.has(row.file)) rows.set(row.file, row);
      }
    }
  }
  const enabled = applyExtensionPatterns([...rows.keys()], declarations.filter(p => /^[!+-]/.test(p)), root);
  return [...rows.values()].filter(row => enabled.get(row.file) !== false)
    .map(row => ({ ...row, uncertain: row.uncertain || enabled.get(row.file) === null }));
}
