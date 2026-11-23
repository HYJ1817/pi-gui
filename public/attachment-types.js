/* Presentation types are not model capabilities. Native image input follows
 * Pi's existing ImageContent formats; all other files keep their saved path. */
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
const MIME_BY_EXT = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', ogv: 'video/ogg',
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  md: 'text/markdown', markdown: 'text/markdown', zip: 'application/zip',
});
const GENERIC_MIMES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/unknown']);
const TYPE_BY_EXT = Object.freeze({
  pdf: 'pdf', doc: 'word', docx: 'word', odt: 'word', rtf: 'word',
  ppt: 'slides', pptx: 'slides', odp: 'slides', xls: 'sheet', xlsx: 'sheet', ods: 'sheet', csv: 'sheet', tsv: 'sheet',
  md: 'markdown', markdown: 'markdown', zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
});
export const ATTACHMENT_ICONS = Object.freeze({
  image: 'image', video: 'video', pdf: 'file', word: 'fileText', slides: 'panel',
  sheet: 'grid', markdown: 'book', archive: 'archive', text: 'fileText', file: 'file',
});
export const ATTACHMENT_LABELS = Object.freeze({
  image: '图片', video: '视频', pdf: 'PDF', word: '文档', slides: '演示文稿', sheet: '表格',
  markdown: 'Markdown', archive: '压缩文件', text: '文本', file: '文件',
});
function extension(name) { return (String(name || '').match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase(); }
export function attachmentMimeType(name, mimeType = '') {
  const mime = String(mimeType || '').split(';', 1)[0].trim().toLowerCase();
  return GENERIC_MIMES.has(mime) ? MIME_BY_EXT[extension(name)] || 'application/octet-stream' : mime;
}
export function nativeImageMime(name, mimeType) {
  const mime = attachmentMimeType(name, mimeType);
  return IMAGE_MIMES.has(mime) ? mime : null;
}
/* The name and declared MIME only decide whether a file is worth considering;
 * the bytes decide what can be sent as ImageContent. Thirty-six bytes cover
 * RIFF/WEBP at offset 8 and a BMP file + DIB header; a two-byte "BM" prefix
 * alone is not enough evidence for the image claim. */
function uint32le(bytes, offset) {
  return (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0;
}
function int32le(bytes, offset) {
  return bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24;
}
const IMAGE_SIGNATURES = Object.freeze([
  ['image/png', b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a],
  ['image/jpeg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61],
  ['image/webp', b => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50],
  ['image/bmp', b => {
    if (b.length < 30 || b[0] !== 0x42 || b[1] !== 0x4d) return false;
    const fileSize = uint32le(b, 2), pixelOffset = uint32le(b, 10), dib = uint32le(b, 14);
    const width = int32le(b, 18), height = int32le(b, 22);
    const planes = b[26] | b[27] << 8, bits = b[28] | b[29] << 8;
    return b[6] === 0 && b[7] === 0 && b[8] === 0 && b[9] === 0
      && [40, 52, 56, 64, 108, 124].includes(dib)
      && fileSize >= 14 + dib && pixelOffset >= 14 + dib && pixelOffset <= fileSize
      && width > 0 && width <= 100000 && height !== 0 && Math.abs(height) <= 100000
      && planes === 1 && [1, 4, 8, 16, 24, 32].includes(bits);
  }],
]);
function base64Head(dataUrl) {
  const prefix = /^data:[^;,]+;base64,/.exec(dataUrl || '');
  if (!prefix) return null;
  const clean = String(dataUrl).slice(prefix[0].length, prefix[0].length + 64).replace(/[^A-Za-z0-9+/]/g, '').slice(0, 48);
  const usable = clean.slice(0, clean.length - clean.length % 4);
  if (!usable) return null;
  try {
    const binary = globalThis.atob(usable);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch { return null; }
}
export function sniffImageMime(dataUrl) {
  const head = base64Head(dataUrl);
  if (!head) return null;
  for (const [mimeType, matches] of IMAGE_SIGNATURES) if (matches(head)) return mimeType;
  return null;
}
export function attachmentFileType(name, mimeType) {
  const mime = attachmentMimeType(name, mimeType);
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (/wordprocessingml|msword|opendocument\.text|rtf/.test(mime)) return 'word';
  if (/presentationml|powerpoint|opendocument\.presentation/.test(mime)) return 'slides';
  if (/spreadsheetml|ms-excel|opendocument\.spreadsheet/.test(mime)) return 'sheet';
  return TYPE_BY_EXT[extension(name)] || (mime.startsWith('text/') ? 'text' : 'file');
}
export function attachmentSendBlocked(attachment) {
  // Parser errors still have a usable file reference. Transport/read failures
  // without one must not be turned into a message with an invented path.
  return Boolean(attachment.uploadFailed || (attachment.error && !attachment.path && attachment.kind !== 'text'));
}
export function imageContent(attachment) {
  if (attachment.kind !== 'image' || attachment.loading || attachment.uploadFailed) return null;
  const match = /^data:([^;,]+);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(attachment.dataUrl || '');
  if (!match) return null;
  // The wire MIME follows the actual bytes. A text file renamed to .png can
  // pass the extension check but must never be presented as an image.
  const mimeType = sniffImageMime(attachment.dataUrl);
  return mimeType ? { type: 'image', data: match[2], mimeType } : null;
}
