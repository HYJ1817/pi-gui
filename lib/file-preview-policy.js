/* Preview format policy only; authorization remains in server/files.js.
 * The extension selects a parser, never establishes the type of the bytes.
 * No parser, shell, network or unbounded allocation runs in this module. */
import path from 'node:path';

const MiB = 1024 * 1024;
export const PREVIEW_LIMITS = Object.freeze({
  maxRangeBytes: 8 * MiB,
  maxTextBytes: 4 * MiB,
  maxImageBytes: 8 * MiB,
  maxPdfBytes: 32 * MiB,
  maxOfficeBytes: 32 * MiB,
  maxArchiveBytes: 32 * MiB,
  maxMediaBytes: 1024 * MiB,
  headerBytes: 4096,
});

const IMAGES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.avif': 'image/avif',
});
const MEDIA = Object.freeze({
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.ogv': 'video/ogg', '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.wma': 'audio/x-ms-wma', '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv', '.3gp': 'video/3gpp',
});
const OFFICE = new Set(['.docx', '.xlsx', '.pptx']);
const ARCHIVES = new Set(['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.bz2', '.xz', '.zst']);
const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.com', '.scr', '.msi', '.msp', '.lnk', '.url', '.app',
  '.dmg', '.iso', '.class', '.jar', '.wasm', '.so', '.dylib', '.bin',
  '.doc', '.xls', '.ppt', '.docm', '.xlsm', '.pptm', '.pdf.exe',
]);
const error = (code) => Object.assign(new Error(code), { code });

export function previewPolicy(filename) {
  const ext = path.extname(String(filename)).toLowerCase();
  let type = 'text';
  let mime = 'text/plain; charset=utf-8';
  let maxBytes = PREVIEW_LIMITS.maxTextBytes;
  if (IMAGES[ext] || ext === '.svg') {
    type = 'image'; mime = IMAGES[ext] || 'image/svg+xml'; maxBytes = PREVIEW_LIMITS.maxImageBytes;
  } else if (MEDIA[ext]) {
    type = 'media'; mime = MEDIA[ext]; maxBytes = PREVIEW_LIMITS.maxMediaBytes;
  } else if (ext === '.pdf') {
    type = 'pdf'; mime = 'application/pdf'; maxBytes = PREVIEW_LIMITS.maxPdfBytes;
  } else if (OFFICE.has(ext)) {
    type = 'office'; mime = 'application/octet-stream'; maxBytes = PREVIEW_LIMITS.maxOfficeBytes;
  } else if (ARCHIVES.has(ext)) {
    type = 'archive'; mime = 'application/octet-stream'; maxBytes = PREVIEW_LIMITS.maxArchiveBytes;
  } else if (['.html', '.htm'].includes(ext)) {
    type = 'html'; mime = 'text/html; charset=utf-8';
  } else if (['.md', '.markdown', '.mdown', '.mkd'].includes(ext)) {
    type = 'markdown';
  } else if (ext === '.csv' || ext === '.tsv') {
    type = 'office';
  } else if (BINARY_EXTENSIONS.has(ext)) {
    type = 'unsupported'; mime = 'application/octet-stream'; maxBytes = 0;
  }
  return Object.freeze({ type, mime, maxBytes, ext, media: type === 'media' });
}

function starts(buffer, bytes, offset = 0) {
  const expected = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return buffer.length >= offset + expected.length && buffer.subarray(offset, offset + expected.length).equals(expected);
}

function isIsoMedia(header, ext) {
  if (!starts(header, 'ftyp', 4) || header.length < 16) return false;
  const brands = [header.toString('ascii', 8, 12)];
  const boxSize = Math.min(header.readUInt32BE(0), header.length, 256);
  if (boxSize < 16) return false;
  for (let i = 16; i + 4 <= boxSize; i += 4) brands.push(header.toString('ascii', i, i + 4));
  if (ext === '.avif') return brands.some(b => b === 'avif' || b === 'avis');
  const allowed = ext === '.m4a' ? /^(M4A |M4B |isom|iso2|mp41|mp42)$/
    : ext === '.mov' ? /^(qt  |isom|iso2|mp41|mp42)$/
      : ext === '.3gp' ? /^3g[p2]/ : /^(isom|iso[2-9]|mp41|mp42|avc1|dash|M4V |MSNV)$/;
  return brands.some(b => allowed.test(b));
}

function matchesHeader(header, ext) {
  switch (ext) {
    case '.png': return starts(header, [137, 80, 78, 71, 13, 10, 26, 10]);
    case '.jpg': case '.jpeg': return starts(header, [255, 216, 255]);
    case '.gif': return starts(header, 'GIF87a') || starts(header, 'GIF89a');
    case '.webp': return starts(header, 'RIFF') && starts(header, 'WEBP', 8);
    case '.bmp': return starts(header, 'BM');
    case '.ico': return starts(header, [0, 0, 1, 0]);
    case '.avif': return isIsoMedia(header, ext);
    case '.pdf': return starts(header, '%PDF-');
    case '.docx': case '.xlsx': case '.pptx': case '.zip':
      return starts(header, [80, 75, 3, 4]) || starts(header, [80, 75, 5, 6]);
    case '.gz': case '.tgz': return starts(header, [31, 139, 8]);
    case '.7z': return starts(header, [55, 122, 188, 175, 39, 28]);
    case '.rar': return starts(header, 'Rar!\x1a\x07');
    case '.bz2': return starts(header, 'BZh');
    case '.xz': return starts(header, [253, 55, 122, 88, 90, 0]);
    case '.zst': return starts(header, [40, 181, 47, 253]);
    case '.tar': return starts(header, 'ustar', 257);
    case '.wav': return starts(header, 'RIFF') && starts(header, 'WAVE', 8);
    case '.avi': return starts(header, 'RIFF') && starts(header, 'AVI ', 8);
    case '.flac': return starts(header, 'fLaC');
    case '.ogg': case '.oga': case '.ogv': case '.opus': return starts(header, 'OggS');
    case '.mp3':
      return starts(header, 'ID3') || (header.length >= 4 && header[0] === 255
        && (header[1] & 0xe0) === 0xe0 && (header[1] & 6) !== 0
        && (header[2] >> 4) > 0 && (header[2] >> 4) < 15 && (header[2] & 12) !== 12);
    case '.aac': return header.length >= 4 && header[0] === 255 && (header[1] & 0xf6) === 0xf0;
    case '.mp4': case '.m4v': case '.m4a': case '.mov': case '.3gp': return isIsoMedia(header, ext);
    case '.webm': case '.mkv':
      return starts(header, [26, 69, 223, 163])
        && header.includes(Buffer.from(ext === '.webm' ? 'webm' : 'matroska'));
    case '.wma': case '.wmv': return starts(header, [48, 38, 178, 117, 142, 102, 207, 17, 166, 217, 0, 170, 0, 98, 206, 108]);
    case '.flv': return starts(header, 'FLV');
    default: return true;
  }
}

export function assertPreviewHeader(header, policy, executableMagic = []) {
  if (policy.type === 'unsupported') throw error('unsupported_type');
  for (const { bytes } of executableMagic) {
    // A source-code reader must display Shell/Python shebangs as inert text.
    // This exception is NOT used by the OS system-open whitelist.
    if (policy.type === 'text' && Buffer.from(bytes).equals(Buffer.from('#!'))) continue;
    if (starts(header, bytes)) throw error('unsafe_type');
  }
  // Catch missing FAT/Mach-O variants; executable binaries remain refused.
  if (starts(header, [190, 186, 254, 202]) || starts(header, [202, 254, 186, 191])
    || starts(header, [191, 186, 254, 202])) throw error('unsafe_type');
  const textHead = header.toString('utf8').replace(/^﻿/, '').trimStart();
  if (policy.type !== 'text' && textHead.startsWith('#!')) throw error('unsafe_type');
  if (!matchesHeader(header, policy.ext)) throw error('type_mismatch');
  if (['text', 'html', 'markdown'].includes(policy.type) || ['.svg', '.csv', '.tsv'].includes(policy.ext)) {
    const utf16 = starts(header, [255, 254]) || starts(header, [254, 255]);
    if (!utf16 && header.includes(0)) throw error('unsupported_type');
    if (policy.ext === '.svg' && !/<svg(?:\s|>)/i.test(textHead)) throw error('type_mismatch');
  }
}

/** One range only. Open-ended requests (native media's usual bytes=0-) are
 * served in bounded windows; Content-Range always describes the actual window.
 * Explicit/suffix ranges exceeding the budget are refused, never truncated. */
export function previewRange(value, size, maxBytes = PREVIEW_LIMITS.maxRangeBytes) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 128) throw error('range_not_satisfiable');
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) throw error('range_not_satisfiable');
  const integer = (raw) => {
    const number = Number(raw);
    if (!Number.isSafeInteger(number) || number < 0) throw error('range_not_satisfiable');
    return number;
  };
  let start, end;
  if (!match[1]) {
    const suffix = integer(match[2]);
    if (!suffix) throw error('range_not_satisfiable');
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = integer(match[1]);
    end = match[2] ? Math.min(integer(match[2]), size - 1) : Math.min(size - 1, start + maxBytes - 1);
  }
  if (start >= size || end < start || end - start + 1 > maxBytes) throw error('range_not_satisfiable');
  return { start, end, length: end - start + 1 };
}
