/* Files UI keeps descriptions and reading positions, never document bytes or
 * grants. The storage budget is shared by a small LRU of exact session scopes. */
export const FILES_STORAGE_KEY = 'pi-gui:files-view:v1';
export const FILES_TAB_LIMIT = 24;
const SCOPE_LIMIT = 6;
const STORAGE_LIMIT = 192 * 1024;
const memory = new Map();
const numericState = new Set(['scrollTop', 'scrollLeft', 'top', 'left', 'page', 'pageNumber', 'slide', 'sheet', 'sheetIndex', 'row', 'column', 'zoom', 'scale', 'time', 'currentTime', 'volume', 'line']);
const booleanState = new Set(['wrap', 'lineNumbers', 'muted', 'rendered', 'formulas', 'fitWidth']);
const enumState = new Map([['mode', new Set(['fit', 'original'])], ['scale', new Set(['fit', '50', '75', '100', '125', '150', '200'])], ['encoding', new Set(['auto', 'utf-8', 'gb18030', 'utf-16le', 'utf-16be'])]]);
const short = (value, max = 4096) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f]/.test(value) ? value : '';
export const pathKey = (path, cwd = '') => /^[a-z]:[\\/]/i.test(cwd || path) ? String(path).replace(/\\/g, '/').toLowerCase() : String(path);
export const scopeKey = ({ cwd = '', conversationId = '', sessionId = '' } = {}) => JSON.stringify([pathKey(cwd), conversationId || '', sessionId || '']);
export const sameScope = (a, b) => scopeKey(a) === scopeKey(b);

function archivePath(value) {
  if (typeof value !== 'string' || !value.length || value.length > 1024 || /^[\/]|[\\:\x00-\x1f\x7f-\x9f]/.test(value)) return false;
  return value.replace(/\/$/, '').split('/').every(part => part && part !== '.' && part !== '..');
}
function archiveExpansion(value) {
  const result = new Set();
  let characters = 0;
  for (const path of value.slice(0, 4096)) {
    if (!archivePath(path) || result.has(path)) continue;
    if (result.size === 96 || characters + path.length > 8192) break;
    result.add(path); characters += path.length;
  }
  return [...result];
}

export function readingState(value) {
  const result = {};
  if (!value || typeof value !== 'object') return result;
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    if (key === 'pageOffset' && Number.isFinite(item)) result[key] = Math.max(0, Math.min(item, 1));
    else if (numericState.has(key) && Number.isFinite(item)) result[key] = Math.max(-1e9, Math.min(item, 1e9));
    else if (booleanState.has(key) && typeof item === 'boolean') result[key] = item;
    else if (enumState.get(key)?.has(item)) result[key] = item;
    else if (key === 'search' && typeof item === 'string' && short(item, 256) === item) result[key] = item;
    else if (key === 'selected' && (item === '' || archivePath(item))) result[key] = item;
    else if (key === 'expanded' && Array.isArray(item)) result[key] = archiveExpansion(item);
    else if (key === 'scroll' || key === 'position') {
      const nested = {};
      if (item && typeof item === 'object') for (const [name, number] of Object.entries(item)) {
        if (numericState.has(name) && Number.isFinite(number)) nested[name] = Math.max(-1e9, Math.min(number, 1e9));
      }
      result[key] = nested;
    }
  }
  return result;
}

export function requestKey(request) {
  if (request.source === 'attachment') return `attachment:${request.attachmentId || request.name || request.file?.name || ''}`;
  if (request.source === 'archive') return `archive:${JSON.stringify([requestKey(request.parent || {}), request.parent?.fileId || '', request.archiveEntry || request.name])}`;
  return `${request.external ? 'external:' : 'workspace:'}${pathKey(request.path, request.cwd)}`;
}

function storedTab(tab) {
  const request = tab.request || tab;
  if (request.external || request.source === 'attachment' || request.source === 'archive' || !short(request.path)
    || /^(?:[\\/]|[a-z]:)/i.test(request.path) || request.path.split(/[\\/]/).includes('..')) return null;
  const result = {
    path: short(request.path), name: short(request.name, 512), cwd: short(request.cwd),
    conversationId: short(request.conversationId, 256) || null,
    fileId: short(request.fileId, 256), state: readingState(tab.state),
  };
  // Restoring without the old object token would silently read a replacement.
  if (!result.fileId) return null;
  for (const key of ['line', 'column', 'endLine', 'endColumn']) {
    if (Number.isSafeInteger(request[key]) && request[key] > 0) result[key] = request[key];
  }
  return result;
}

function project(value) {
  if (!value || typeof value !== 'object') return null;
  const tabs = (Array.isArray(value.tabs) ? value.tabs : []).slice(0, FILES_TAB_LIMIT).map(storedTab).filter(Boolean);
  return {
    tabs,
    active: short(value.active, 4200),
    tree: {
      expanded: (Array.isArray(value.tree?.expanded) ? value.tree.expanded : []).filter((p) => short(p) && !p.startsWith('/') && !p.includes('..')).slice(0, 96),
      selected: short(value.tree?.selected),
      scrollTop: Math.max(0, Math.min(Number(value.tree?.scrollTop) || 0, 1e8)),
      hidden: value.tree?.hidden === true,
    },
    layout: {
      treeVisible: value.layout?.treeVisible !== false,
      treeWidth: Math.max(140, Math.min(Number(value.layout?.treeWidth) || 220, 480)),
    },
  };
}

function storedScopes(storage) {
  try {
    const raw = storage?.getItem(FILES_STORAGE_KEY);
    if (!raw || raw.length > STORAGE_LIMIT) return [];
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !Array.isArray(parsed.scopes)) return [];
    return parsed.scopes.slice(-SCOPE_LIMIT).filter((item) => short(item.key, 9000) && item.value);
  } catch { return []; }
}

export function readFilesState(identity, storage = globalThis.localStorage) {
  const key = scopeKey(identity);
  const cached = memory.get(key);
  const value = project(cached || storedScopes(storage).find((item) => item.key === key)?.value);
  if (cached) { memory.delete(key); memory.set(key, value); }
  return value;
}

export function writeFilesState(identity, value, storage = globalThis.localStorage) {
  if (!identity.cwd || !identity.sessionId || String(identity.sessionId).startsWith('pending:')) return;
  const key = scopeKey(identity);
  const safe = project(value);
  if (!safe) return;
  memory.delete(key);
  memory.set(key, safe);
  while (memory.size > SCOPE_LIMIT) memory.delete(memory.keys().next().value);
  const scopes = storedScopes(storage).filter((item) => item.key !== key);
  scopes.push({ key, value: safe });
  while (scopes.length > SCOPE_LIMIT || JSON.stringify(scopes).length > STORAGE_LIMIT - 64) scopes.shift();
  try { storage?.setItem(FILES_STORAGE_KEY, JSON.stringify({ version: 1, scopes })); } catch { /* Storage is optional; the bounded in-memory copy remains. */ }
}

/* Minimal distinguishing suffix, not a duplicate full-path subtitle. */
export function tabLabels(tabs) {
  const names = new Map();
  const fullPaths = new Map();
  for (const tab of tabs) {
    const request = tab.request || tab;
    const name = String(request.name || request.path || '文件').split(/[\\/]/).pop();
    names.set(tab.key, name);
    fullPaths.set(tab.key, request.source === 'attachment' ? `附件/${name}` : request.source === 'archive'
      ? `${request.parent?.path || request.parent?.name || '压缩包'}/${request.archiveEntry || request.name}` : request.path || request.name);
  }
  const original = new Map(names);
  for (const tab of tabs) {
    const peers = tabs.filter((other) => original.get(other.key) === original.get(tab.key));
    if (peers.length < 2) continue;
    const parts = String(fullPaths.get(tab.key)).split(/[\\/]/);
    let unique = false;
    for (let count = 2; count <= parts.length; count++) {
      const suffix = parts.slice(-count).join('/');
      if (peers.every((other) => other === tab || String(fullPaths.get(other.key)).split(/[\\/]/).slice(-count).join('/') !== suffix)) {
        names.set(tab.key, suffix); unique = true; break;
      }
    }
    const identical = peers.filter((other) => fullPaths.get(other.key) === fullPaths.get(tab.key));
    if (!unique && identical.length > 1) names.set(tab.key, `${parts.slice(-2).join('/')} (${identical.indexOf(tab) + 1})`);
  }
  return names;
}
