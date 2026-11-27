import { failHtmlResource, isHtmlResourceError } from './html-resource-policy.js';

export const HTML_RESOURCE_IMAGE_LIMITS = Object.freeze({
  side: 4096, pixels: 8 * 1024 * 1024, frames: 32, animationPixels: 16 * 1024 * 1024,
});
const invalid = () => failHtmlResource('html_resource_type');
const ascii = (bytes, start, end) => bytes.toString('latin1', start, end);
function dimensions(width, height, frames = 1) {
  const limits = HTML_RESOURCE_IMAGE_LIMITS;
  if (!width || !height || !frames) invalid();
  if (width > limits.side || height > limits.side || width * height > limits.pixels
    || frames > limits.frames || (frames > 1 && width * height * frames > limits.animationPixels)) failHtmlResource('html_resource_too_large');
}

// These are bounded container/header checks, not image decoders. Pixel decoding
// remains in the existing sandbox. Never infer MIME from a URL or extension.
function png(bytes) {
  if (bytes.length < 45 || ascii(bytes, 0, 8) !== '\x89PNG\r\n\x1a\n') invalid();
  let position = 8, header = false, data = false;
  while (position + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(position), type = ascii(bytes, position + 4, position + 8);
    if (position + size + 12 > bytes.length || (!header && (type !== 'IHDR' || size !== 13))) invalid();
    if (type === 'IHDR') {
      if (header || size !== 13) invalid();
      header = true;
      dimensions(bytes.readUInt32BE(position + 8), bytes.readUInt32BE(position + 12));
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[bytes[position + 17]]?.includes(bytes[position + 16]) || bytes[position + 18]
        || bytes[position + 19] || bytes[position + 20] > 1) invalid();
    }
    // APNG and animated WebP stay unsupported; GIF has an explicit frame budget.
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) invalid();
    if (type === 'IDAT' && size) data = true;
    if (type === 'IEND') {
      if (size || !data || position + 12 !== bytes.length) invalid();
      return;
    }
    position += size + 12;
  }
  invalid();
}

function jpeg(bytes) {
  if (bytes.length < 20 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) invalid();
  let offset = 2, sized = false;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 255) invalid();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0 || marker === 216 || marker === 217 || marker === undefined) invalid();
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length - 2) invalid();
    if ([192, 193, 194].includes(marker)) {
      const components = bytes[offset + 7];
      if (sized || size < 8 || bytes[offset + 2] !== 8 || ![1, 3, 4].includes(components) || size !== 8 + 3 * components) invalid();
      dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      sized = true;
    } else if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) invalid();
    if (marker === 218) {
      if (!sized || size < 6 || offset + size >= bytes.length - 2) invalid();
      return; // Compressed scan data is not decoded on the backend.
    }
    offset += size;
  }
  invalid();
}

function gif(bytes) {
  if (bytes.length < 14 || bytes.at(-1) !== 59 || !['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) invalid();
  const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8);
  dimensions(width, height);
  let offset = 13 + ((bytes[10] & 128) ? 3 * (2 ** ((bytes[10] & 7) + 1)) : 0), frames = 0;
  const blocks = () => {
    while (offset < bytes.length) {
      const size = bytes[offset++];
      if (!size) return;
      offset += size;
    }
    invalid();
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 59) {
      if (!frames || offset !== bytes.length) invalid();
      return;
    }
    if (marker === 33) { if (offset >= bytes.length) invalid(); offset++; blocks(); }
    else if (marker === 44) {
      if (offset + 9 > bytes.length) invalid();
      const frameWidth = bytes.readUInt16LE(offset + 4), frameHeight = bytes.readUInt16LE(offset + 6);
      dimensions(frameWidth, frameHeight);
      if (bytes.readUInt16LE(offset) + frameWidth > width || bytes.readUInt16LE(offset + 2) + frameHeight > height) invalid();
      const packed = bytes[offset + 8];
      offset += 9 + ((packed & 128) ? 3 * (2 ** ((packed & 7) + 1)) : 0);
      if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) invalid();
      offset++; blocks(); dimensions(width, height, ++frames);
    } else invalid();
  }
  invalid();
}

function webp(bytes) {
  if (bytes.length < 26 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP'
    || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
  let offset = 12, canvas = null, data = false;
  const u24 = pos => bytes.readUIntLE(pos, 3);
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size + (size & 1) > bytes.length || ['ANIM', 'ANMF'].includes(type)) invalid();
    if (type === 'VP8X') {
      if (offset !== 12 || size !== 10 || (bytes[start] & 0xc3) || bytes[start + 1] || bytes[start + 2] || bytes[start + 3]) invalid();
      canvas = [u24(start + 4) + 1, u24(start + 7) + 1];
      dimensions(...canvas);
    }
    if (type === 'VP8 ' || type === 'VP8L') {
      if (data) invalid();
      let width, height;
      if (type === 'VP8 ') {
        if (size < 10 || (bytes[start] & 1) || ascii(bytes, start + 3, start + 6) !== '\x9d\x01\x2a') invalid();
        width = bytes.readUInt16LE(start + 6) & 16383;
        height = bytes.readUInt16LE(start + 8) & 16383;
      } else {
        if (size < 5 || bytes[start] !== 47) invalid();
        const packed = bytes.readUInt32LE(start + 1);
        if (packed >>> 29) invalid();
        width = (packed & 16383) + 1; height = ((packed >>> 14) & 16383) + 1;
      }
      dimensions(width, height);
      if (canvas && (width !== canvas[0] || height !== canvas[1])) invalid();
      data = true;
    }
    offset = start + size + (size & 1);
  }
  if (!data || offset !== bytes.length) invalid();
}

export function htmlResourceImageMime(bytes, contentType) {
  const mime = typeof contentType === 'string' ? contentType.split(';', 1)[0].trim().toLowerCase() : '';
  const validators = { 'image/png': png, 'image/jpeg': jpeg, 'image/webp': webp, 'image/gif': gif };
  const validate = Object.hasOwn(validators, mime) ? validators[mime] : null;
  if (!Buffer.isBuffer(bytes) || !validate) invalid();
  try { validate(bytes); }
  catch (error) { if (isHtmlResourceError(error)) throw error; invalid(); }
  return mime;
}
