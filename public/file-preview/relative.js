/* Relative references are projected to a fresh descriptor; a source fileId is
 * never carried onto a different path. Backend workspace/grant authority is
 * still revalidated for each metadata and byte read. */
export function relativeRequest(owner, href) {
  if (owner.source || typeof href !== 'string' || href.length > 4096) return null;
  let value;
  try { value = decodeURIComponent(href.split(/[?#]/, 1)[0]); } catch { return null; }
  if (!value || /^[a-z][a-z\d+.-]*:/i.test(value) || /^[\\/]/.test(value) || /[\x00-\x1f\x7f]/.test(value)) return null;
  const original = String(owner.path || '').replace(/\\/g, '/');
  const drive = /^[a-z]:\//i.exec(original)?.[0] || '';
  const unc = !drive && original.startsWith('//');
  const absolute = !drive && !unc && original.startsWith('/');
  const parts = original.slice(drive.length).split('/').filter(Boolean); parts.pop();
  const minimum = unc ? 2 : 0;
  const win = Boolean(drive || unc || /^[a-z]:[\\/]/i.test(owner.cwd || '') || /^[\\/]{2}/.test(owner.cwd || ''));
  let rootParts = null;
  // Workspace descriptors normally carry a relative path. Its lexical root is
  // already the workspace, not the drive-prefixed absolute cwd.
  if (!owner.external && owner.cwd && (drive || unc || absolute)) {
    const root = String(owner.cwd).replace(/\\/g, '/');
    const rootDrive = /^[a-z]:\//i.exec(root)?.[0] || '';
    if (rootDrive.toLowerCase() !== drive.toLowerCase()) return null;
    rootParts = root.slice(rootDrive.length).split('/').filter(Boolean);
    const compare = (a, b) => win ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (rootParts.length > parts.length || !rootParts.every((part, index) => compare(part, parts[index]))) return null;
  }
  const floor = rootParts ? rootParts.length : minimum;
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (parts.length <= floor) return null; parts.pop(); }
    else { if (/[<>:"|?*]/.test(part)) return null; parts.push(part); }
  }
  const nextPath = `${drive || (unc ? '//' : absolute ? '/' : '')}${parts.join('/')}`;
  if (!nextPath) return null;
  return {
    path: nextPath, name: parts.at(-1), cwd: owner.cwd || '',
    conversationId: owner.conversationId || null, workspace: owner.workspace,
    generation: owner.generation, external: owner.external === true,
    ...(owner.external ? { grantId: owner.grantId } : {}),
  };
}
