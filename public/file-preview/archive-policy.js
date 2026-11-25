/* One lightweight member policy for both the archive action and byte access.
 * It must not import ZIP parsers/Office vendors into the eager access module. */
const TEXT = new Set(['txt', 'md', 'markdown', 'json', 'jsonl', 'log', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'sh', 'sql']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'ico', 'avif']);
export function archivePreviewLimit(entry) {
  if (!entry || entry.directory || !Number.isSafeInteger(entry.size) || entry.size < 0) return 0;
  const extension = String(entry.name || '').toLowerCase().split('.').pop();
  if (TEXT.has(extension) && entry.size <= 256 * 1024) return 256 * 1024;
  if (IMAGE.has(extension) && entry.size <= 8 * 1024 * 1024) return 8 * 1024 * 1024;
  return 0; // No HTML, nested archives or binary Office packages.
}
