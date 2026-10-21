/* Pure tree and link helpers for the read-only Specs surface. */

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const EXTERNAL = /^(?:https?|mailto):/i;

const basename = (rel) => rel.split('/').filter(Boolean).at(-1) || rel;
const splitPath = (rel) => String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean);

function folder(name, rel) {
  return { type: 'dir', name, path: rel, children: [] };
}

function sortNodes(nodes) {
  const rank = (node) => node.type === 'doc' && node.name === 'SPEC.md' ? -1 : node.type === 'dir' ? 0 : 1;
  nodes.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'zh'));
  for (const node of nodes) if (node.children.length) sortNodes(node.children);
  return nodes;
}

export function buildSpecTree(documents = []) {
  const roots = [];
  const folders = new Map();
  for (const document of documents) {
    const parts = splitPath(document.path);
    if (!parts.length) continue;
    let list = roots;
    let rel = '';
    for (let index = 0; index < parts.length - 1; index++) {
      const name = parts[index];
      rel = rel ? rel + '/' + name : name;
      let node = folders.get(rel);
      if (!node) {
        node = folder(name, rel);
        folders.set(rel, node);
        list.push(node);
      }
      list = node.children;
    }
    const name = parts.at(-1);
    list.push({ type: 'doc', name, path: document.path, document, children: [] });
  }
  return sortNodes(roots);
}

export function specDirectoryPaths(documents = []) {
  const paths = [];
  const visit = (nodes) => {
    for (const node of nodes) {
      if (node.type === 'dir') {
        paths.push(node.path);
        visit(node.children);
      }
    }
  };
  visit(buildSpecTree(documents));
  return paths;
}

export function resolveSpecLink(currentPath, href, indexedPaths) {
  const raw = String(href || '').trim();
  if (!raw) return { kind: 'blocked', reason: 'empty' };
  if (raw.startsWith('#')) {
    return { kind: 'anchor', anchor: decodeHash(raw.slice(1)) };
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('//') || raw.startsWith('/') || raw.startsWith('\\')) {
    return { kind: 'blocked', reason: 'absolute' };
  }
  if (SCHEME.test(raw)) return EXTERNAL.test(raw) ? { kind: 'external' } : { kind: 'blocked', reason: 'scheme' };

  let url;
  try {
    url = new URL(raw.replace(/\\/g, '/'), 'https://specs.invalid/' + String(currentPath || ''));
  } catch {
    return { kind: 'blocked', reason: 'invalid' };
  }
  let target;
  try {
    target = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    return { kind: 'blocked', reason: 'invalid' };
  }
  if (!target) return { kind: 'anchor', anchor: decodeHash(url.hash.slice(1)) };
  const has = typeof indexedPaths?.has === 'function' ? (value) => indexedPaths.has(value) : (value) => new Set(indexedPaths || []).has(value);
  if (!has(target)) return { kind: 'blocked', reason: 'not-indexed' };
  return { kind: 'document', path: target, anchor: decodeHash(url.hash.slice(1)) };
}

function decodeHash(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}
