/* Shared, pure wire/disk schema. No DOM, I/O, code snippets or UI scope. */
export const REVIEW_DATA_LIMITS = Object.freeze({ scopes: 20, comments: 200, textChars: 2000, fileBytes: 2 * 1024 * 1024 });
export const REVIEW_STORAGE_MESSAGES = Object.freeze({
  comment_invalid: '评论格式或容量不符合要求，未保存。',
  comment_scope_unavailable: '当前会话或工作区身份尚未确认，评论恢复不可用；请同步会话后重试。',
  comment_storage_inside_project: '评论存储目录位于项目内；请将 PI_GUI_DATA 设置为项目外的专用目录后重启。',
  comment_storage_unsafe: '评论存储目录或文件身份已变化，已停止读写；请保留数据并检查目录。',
  comment_storage_corrupt: '评论文件损坏或版本不兼容，原始数据已保留，恢复暂不可用。',
  comment_storage_busy: '评论存储正被使用或上次写入中断；未覆盖数据，请稍后重试或检查残留锁。',
  comment_storage_limit: '评论存储已达容量上限，未覆盖已有数据。',
  comment_storage_unavailable: '无法读取评论存储，请检查应用数据目录权限后重试。',
  comment_storage_write_failed: '评论保存失败，原有数据未被主动清空；请保留正文并重试。',
  comment_conflict: '评论数据已变化；请保留编辑正文，重新加载后决定如何处理。',
});
const closed = (v, keys) => v && !Array.isArray(v) && typeof v === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Object.keys(v).every(k => keys.includes(k));
const invalid = () => { throw Object.assign(Error('comment_invalid'), { code: 'comment_invalid' }); };
const hash = v => typeof v === 'string' && /^[a-f0-9]{8}$/.test(v);
const line = v => v === null || Number.isSafeInteger(v) && v > 0 && v <= 100000000;
export const validReviewRevision = v => v === null || typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);

export function sanitizeReviewComments(value) {
  if (!Array.isArray(value) || value.length > REVIEW_DATA_LIMITS.comments) invalid();
  const ids = new Set(), positions = new Set();
  return value.map(c => {
    if (!closed(c, ['id', 'path', 'text', 'createdAt', 'updatedAt', 'anchor'])
      || typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(c.id) || ids.has(c.id)
      || typeof c.path !== 'string' || !c.path || c.path.length > 1024
      || /[\x00-\x1f\x7f:]/.test(c.path) || /^[\\/]/.test(c.path) || c.path.split(/[\\/]/).some(s => !s || s === '.' || s === '..')
      || typeof c.text !== 'string' || !c.text.trim() || c.text.length > REVIEW_DATA_LIMITS.textChars
      || !Number.isSafeInteger(c.createdAt) || c.createdAt < 0
      || !Number.isSafeInteger(c.updatedAt) || c.updatedAt < c.createdAt) invalid();
    const a = c.anchor;
    if (!closed(a, ['path', 'section', 'type', 'oldLine', 'newLine', 'hunkIndex', 'hunkHeader', 'codeHash', 'diffFingerprint'])
      || a.path !== c.path || !['working', 'staged'].includes(a.section) || !['add', 'del', 'context'].includes(a.type)
      || !line(a.oldLine) || !line(a.newLine) || a.oldLine === null && a.newLine === null
      || a.type === 'add' && (a.oldLine !== null || a.newLine === null)
      || a.type === 'del' && (a.newLine !== null || a.oldLine === null)
      || a.type === 'context' && (a.oldLine === null || a.newLine === null)
      || !Number.isSafeInteger(a.hunkIndex) || a.hunkIndex < 0 || a.hunkIndex > 1000000
      || !hash(a.hunkHeader) || !hash(a.codeHash) || !hash(a.diffFingerprint)) invalid();
    const position = JSON.stringify([c.path, a.section, a.type, a.oldLine, a.newLine]);
    if (positions.has(position)) invalid();
    ids.add(c.id); positions.add(position);
    return { id: c.id, path: c.path, text: c.text, createdAt: c.createdAt, updatedAt: c.updatedAt, anchor: { ...a } };
  });
}

export function reviewCommentWire(c) {
  const a = c.anchor;
  return { id: c.id, path: c.path, text: c.text, createdAt: c.createdAt, updatedAt: c.updatedAt,
    anchor: Object.fromEntries(['path', 'section', 'type', 'oldLine', 'newLine', 'hunkIndex', 'hunkHeader', 'codeHash', 'diffFingerprint'].map(k => [k, a[k]])) };
}
