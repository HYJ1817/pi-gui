import { Inflate } from '../vendor/file-preview/fflate.js';

// Shared by the archive UI and Office workers. No filesystem, DOM or eager unzip.
export const ZIP_LIMITS = Object.freeze({
  maxEntries: 4096,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxArchiveBytes: 64 * 1024 * 1024,
  maxRatio: 200,
});

function fail(code = 'invalid') {
  const error = new Error('压缩包无法安全预览。');
  error.code = `zip_${code}`;
  throw error;
}

function budget(options, key) {
  const value = options[key] ?? ZIP_LIMITS[key];
  if (!Number.isSafeInteger(value) || value < 1) fail('options');
  return Math.min(value, ZIP_LIMITS[key]);
}

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  crcTable[i] = value >>> 0;
}

function crcUpdate(crc, bytes) {
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255];
  return crc >>> 0;
}

function sameBytes(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function checkExtras(bytes, offset, length) {
  const end = offset + length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset < end) {
    if (offset + 4 > end) fail('extra');
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    offset += 4;
    if (offset + size > end) fail('extra');
    // Alternate Unicode path fields create ambiguous names; UTF-8 headers work.
    if (id === 1 || id === 0x9901 || id === 0x7075) fail('unsupported');
    offset += size;
  }
}

function safeName(raw, flags) {
  if (!raw.length || raw.length > 1024) fail('name');
  if (!(flags & 0x800) && raw.some(byte => byte > 127)) fail('encoding');
  let name;
  try { name = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { fail('encoding'); }
  if (/^[\\/]|[\\:\x00-\x1f\x7f-\x9f<>"|?*‪-‮⁦-⁩]/u.test(name)) fail('path');
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.length > 64) fail('path');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) fail('path');
  }
  return name;
}

/**
 * Inspect ordinary single-volume ZIP (stored/deflate). options only tighten caps.
 * Legacy non-ASCII names, ZIP64, encryption and Unicode alternate names are not
 * supported. read() verifies bounded ACTUAL output, final stream, size and CRC.
 */
export function inspectZip(input, options = {}) {
  const limits = Object.fromEntries(Object.keys(ZIP_LIMITS).map(key => [key, budget(options, key)]));
  if (!(input instanceof Uint8Array) || input.length < 22 || input.length > limits.maxArchiveBytes) fail('size');
  // Own the inspected snapshot so a caller cannot alter headers/data after checks.
  const bytes = new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = offset => view.getUint16(offset, true);
  const u32 = offset => view.getUint32(offset, true);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === bytes.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail('directory');
  const count = u16(eocd + 10);
  const centralSize = u32(eocd + 12);
  const centralOffset = u32(eocd + 16);
  if (u16(eocd + 4) || u16(eocd + 6) || u16(eocd + 8) !== count) fail('multivolume');
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('zip64');
  if (count > limits.maxEntries || centralOffset + centralSize !== eocd) fail('directory');
  const records = new Map();
  const paths = new Map();
  const spans = [];
  let offset = centralOffset;
  let declaredTotal = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > eocd || u32(offset) !== 0x02014b50) fail('directory');
    const needed = u16(offset + 6);
    const flags = u16(offset + 8);
    const method = u16(offset + 10);
    const crc = u32(offset + 16);
    const compressedSize = u32(offset + 20);
    const size = u32(offset + 24);
    const nameLength = u16(offset + 28);
    const extraLength = u16(offset + 30);
    const commentLength = u16(offset + 32);
    const external = u32(offset + 38);
    const local = u32(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > eocd || u16(offset + 34) || needed > 20) fail('unsupported');
    if ((flags & ~0x80e) || (method !== 0 && method !== 8) || (method === 0 && (flags & 6))) fail('unsupported');
    if ([size, compressedSize, local].includes(0xffffffff)) fail('zip64');
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = safeName(rawName, flags);
    const directory = name.endsWith('/');
    const unixType = (external >>> 16) & 0xf000;
    if ((unixType && unixType !== (directory ? 0x4000 : 0x8000))
      || (external & 0x440) // Windows device/reparse-point attributes
      || ((external & 0x10) && !directory) || (directory && size !== 0)) fail('special_file');
    checkExtras(bytes, offset + 46 + nameLength, extraLength);
    const key = name.replace(/\/$/, '').normalize('NFC').toLowerCase();
    if (paths.has(key)) fail('duplicate');
    paths.set(key, directory);
    if (size > limits.maxEntryBytes || size > compressedSize * limits.maxRatio
      || (!compressedSize && size) || (method === 0 && size !== compressedSize)) fail('budget');
    declaredTotal += size;
    if (declaredTotal > limits.maxTotalBytes) fail('budget');
    if (local + 30 > centralOffset || u32(local) !== 0x04034b50) fail('local_header');
    const localNameLength = u16(local + 26);
    const localExtraLength = u16(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset || u16(local + 4) !== needed || u16(local + 6) !== flags
      || u16(local + 8) !== method || !sameBytes(rawName, bytes.subarray(local + 30, local + 30 + localNameLength))) fail('local_header');
    checkExtras(bytes, local + 30 + localNameLength, localExtraLength);
    let spanEnd = dataEnd;
    if (flags & 8) {
      for (const [field, expected] of [[14, crc], [18, compressedSize], [22, size]]) {
        if (u32(local + field) !== 0 && u32(local + field) !== expected) fail('local_header');
      }
      let descriptor = dataEnd;
      if (descriptor + 4 <= centralOffset && u32(descriptor) === 0x08074b50) descriptor += 4;
      if (descriptor + 12 > centralOffset || u32(descriptor) !== crc
        || u32(descriptor + 4) !== compressedSize || u32(descriptor + 8) !== size) fail('descriptor');
      spanEnd = descriptor + 12;
    } else if (u32(local + 14) !== crc || u32(local + 18) !== compressedSize || u32(local + 22) !== size) fail('local_header');
    spans.push([local, spanEnd]);
    records.set(name, { name, size, compressedSize, directory, method, crc, dataStart, dataEnd });
    offset = next;
  }
  if (offset !== eocd) fail('directory');
  spans.sort((a, b) => a[0] - b[0]);
  if (!spans.length ? centralOffset !== 0 : spans[0][0] !== 0 || spans.at(-1)[1] !== centralOffset) fail('local_header');
  // Deliberately reject SFX prefixes, hidden local entries, overlaps and padding.
  for (let index = 1; index < spans.length; index++) if (spans[index][0] !== spans[index - 1][1]) fail('overlap');
  // A regular file must not be an ancestor of another entry (even on Windows).
  for (const key of paths.keys()) {
    const parts = key.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (paths.get(parts.join('/')) === false) fail('path');
    }
  }
  const verified = new Set();
  let actualTotal = 0;
  const entries = Array.from(records.values(), ({ name, size, compressedSize, directory }) =>
    Object.freeze({ name, size, compressedSize, directory }));
  return {
    entries: Object.freeze(entries),
    read(name, maxBytes = limits.maxEntryBytes) {
      const record = records.get(name);
      if (!record) fail('missing');
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('options');
      const cap = Math.min(maxBytes, limits.maxEntryBytes, record.compressedSize * limits.maxRatio);
      if (record.size > cap || (!verified.has(name) && actualTotal + record.size > limits.maxTotalBytes)) fail('budget');
      const output = new Uint8Array(record.size);
      let written = 0;
      let crc = 0xffffffff;
      let ended = record.method === 0;
      const collect = (chunk, final) => {
        if (written + chunk.length > cap || written + chunk.length > record.size) fail('actual_budget');
        output.set(chunk, written);
        written += chunk.length;
        crc = crcUpdate(crc, chunk);
        if (final) ended = true;
      };
      try {
        if (record.method === 0) collect(bytes.subarray(record.dataStart, record.dataEnd), true);
        else {
          const inflate = new Inflate(collect);
          // Small compressed chunks bound transient Inflate allocation even when a
          // dishonest stream has vastly more output than its advertised size.
          const step = 128;
          if (!record.compressedSize) fail('corrupt');
          for (let pos = record.dataStart; pos < record.dataEnd; pos += step) {
            const end = Math.min(pos + step, record.dataEnd);
            inflate.push(bytes.subarray(pos, end), end === record.dataEnd);
          }
          // fflate 0.8.3's callback `final` means final INPUT, not verified
          // BFINAL/EOB. Its pinned stream state is needed to reject a valid
          // prefix followed by ignored compressed garbage. Fail closed if this
          // shape changes on a dependency upgrade; the regression locks it.
          const state = inflate.s;
          const tail = inflate.p;
          if (!state || state.f !== 1 || state.l || !(tail instanceof Uint8Array)
            || !Number.isInteger(state.p) || state.p < 0 || state.p > 7
            || tail.length !== (state.p ? 1 : 0)) fail('corrupt');
        }
      } catch (error) {
        if (error?.code?.startsWith('zip_')) throw error;
        fail('corrupt');
      }
      if (!ended || written !== record.size || ((crc ^ 0xffffffff) >>> 0) !== record.crc) fail('corrupt');
      if (!verified.has(name)) {
        actualTotal += written;
        verified.add(name);
      }
      return output;
    },
  };
}
