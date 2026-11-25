import { node, navigationButton, toolbarMenu, formatBytes } from './common.js';

export const IMAGE_LIMITS = Object.freeze({
  maxBytes: 32 * 1024 * 1024,
  maxSide: 16384,
  maxPixels: 32 * 1024 * 1024,
  maxFrames: 100,
  maxAnimationPixels: 64 * 1024 * 1024,
});

function invalid(code = 'invalid') {
  const error = new Error(code === 'budget' ? '图片分辨率或动画超出安全预览范围。' : '图片格式损坏或暂不支持。');
  error.code = `image_${code}`;
  throw error;
}

function dimensions(width, height, frames = 1) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) invalid();
  if (width > IMAGE_LIMITS.maxSide || height > IMAGE_LIMITS.maxSide || width * height > IMAGE_LIMITS.maxPixels
    || frames > IMAGE_LIMITS.maxFrames || (frames > 1 && width * height * frames > IMAGE_LIMITS.maxAnimationPixels)) invalid('budget');
  return { width, height, frames };
}

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function png(bytes) {
  if (ascii(bytes, 0, 8) !== '\x89PNG\r\n\x1a\n') invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 8;
  let result;
  let data = false;
  let frames = 1;
  let animationControl = false;
  let frameControls = 0;
  while (position + 12 <= bytes.length) {
    const size = view.getUint32(position);
    const type = ascii(bytes, position + 4, 4);
    if (position + size + 12 > bytes.length) invalid();
    if (!result && (type !== 'IHDR' || size !== 13)) invalid();
    if (type === 'IHDR') {
      if (result || size !== 13) invalid();
      result = dimensions(view.getUint32(position + 8), view.getUint32(position + 12));
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[bytes[position + 17]]?.includes(bytes[position + 16]) || bytes[position + 18]
        || bytes[position + 19] || bytes[position + 20] > 1) invalid();
    }
    if (type === 'acTL') {
      if (size !== 8 || data || animationControl) invalid();
      animationControl = true;
      frames = view.getUint32(position + 8);
      if (!frames) invalid();
      dimensions(result.width, result.height, frames);
    }
    if (type === 'fcTL') {
      if (size !== 26 || !animationControl) invalid();
      const width = view.getUint32(position + 12);
      const height = view.getUint32(position + 16);
      dimensions(width, height);
      if (view.getUint32(position + 20) + width > result.width || view.getUint32(position + 24) + height > result.height) invalid();
      frameControls++;
      if (frameControls > IMAGE_LIMITS.maxFrames) invalid('budget');
    }
    if (type === 'IDAT') data = true;
    if (type === 'IEND') {
      if (size || !data || position + 12 !== bytes.length || (animationControl && frameControls !== frames)) invalid();
      return { ...result, frames };
    }
    position += size + 12;
  }
  invalid();
}

function jpeg(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  let result;
  if (bytes.at(-2) !== 255 || bytes.at(-1) !== 217) invalid();
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 255) invalid();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda) {
      if (!result || offset + 2 > bytes.length) invalid();
      const size = view.getUint16(offset);
      if (size < 6 || offset + size > bytes.length - 2) invalid();
      return result;
    }
    if (marker === 0 || marker === 0xd9 || marker === 0xd8) invalid();
    if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) invalid();
    const size = view.getUint16(offset);
    if (size < 2 || offset + size > bytes.length) invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (result || size < 8 || bytes[offset + 2] !== 8 || ![1, 3, 4].includes(bytes[offset + 7])
        || size !== 8 + 3 * bytes[offset + 7]) invalid();
      result = dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) invalid('unsupported');
    offset += size;
  }
  invalid();
}

function gif(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 14) invalid();
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  dimensions(width, height);
  let offset = 13 + ((bytes[10] & 128) ? 3 * (2 ** ((bytes[10] & 7) + 1)) : 0);
  let frames = 0;
  function subBlocks() {
    while (offset < bytes.length) {
      const size = bytes[offset++];
      if (!size) return;
      offset += size;
      if (offset > bytes.length) invalid();
    }
    invalid();
  }
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) {
      if (!frames || offset !== bytes.length) invalid();
      return dimensions(width, height, frames);
    }
    if (marker === 0x21) {
      if (offset >= bytes.length) invalid();
      offset++;
      subBlocks();
    } else if (marker === 0x2c) {
      if (offset + 9 > bytes.length) invalid();
      const frameWidth = view.getUint16(offset + 4, true);
      const frameHeight = view.getUint16(offset + 6, true);
      dimensions(frameWidth, frameHeight);
      if (view.getUint16(offset, true) + frameWidth > width || view.getUint16(offset + 2, true) + frameHeight > height) invalid();
      const packed = bytes[offset + 8];
      offset += 9 + ((packed & 128) ? 3 * (2 ** ((packed & 7) + 1)) : 0);
      if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) invalid();
      offset++;
      subBlocks();
      dimensions(width, height, ++frames);
    } else invalid();
  }
  invalid();
}

function bitmap(bytes, icon = false) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base = icon ? 0 : 14;
  if (bytes.length < base + 40) invalid();
  const header = view.getUint32(base, true);
  if (![40, 52, 56, 108, 124].includes(header) || base + header > bytes.length) invalid('unsupported');
  const width = view.getInt32(base + 4, true);
  const rawHeight = view.getInt32(base + 8, true);
  const height = Math.abs(rawHeight) / (icon ? 2 : 1);
  const bpp = view.getUint16(base + 14, true);
  const compression = view.getUint32(base + 16, true);
  if (view.getUint16(base + 12, true) !== 1 || ![1, 4, 8, 16, 24, 32].includes(bpp) || ![0, 3, 6].includes(compression)) invalid('unsupported');
  const result = dimensions(width, height);
  const pixelOffset = icon ? header + (bpp <= 8 ? (2 ** bpp) * 4 : 0) : view.getUint32(10, true);
  if ((!icon && view.getUint32(2, true) !== bytes.length) || pixelOffset < base + header
    || pixelOffset + Math.ceil(width * bpp / 32) * 4 * height > bytes.length) invalid();
  return result;
}

function ico(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, true);
  if (!count || count > 64 || 6 + 16 * count > bytes.length) invalid();
  let largest;
  let total = 0;
  for (let index = 0; index < count; index++) {
    const offset = 6 + index * 16;
    const width = bytes[offset] || 256;
    const height = bytes[offset + 1] || 256;
    const size = view.getUint32(offset + 8, true);
    const start = view.getUint32(offset + 12, true);
    if (start < 6 + 16 * count || !size || start + size > bytes.length) invalid();
    const data = bytes.subarray(start, start + size);
    const result = ascii(data, 1, 3) === 'PNG' ? png(data) : bitmap(data, true);
    if (width !== result.width || height !== result.height || result.frames !== 1) invalid();
    total += width * height;
    if (total > IMAGE_LIMITS.maxPixels) invalid('budget');
    if (!largest || width * height > largest.width * largest.height) largest = result;
  }
  return largest;
}

function webp(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(4, true) + 8 !== bytes.length) invalid();
  const u24 = pos => bytes[pos] + bytes[pos + 1] * 256 + bytes[pos + 2] * 65536;
  let offset = 12;
  let result;
  let frames = 0;
  let animation = false;
  let animationSettings = false;
  let imageData = false;
  function frameDimensions(start, size, type) {
    if (type === 'VP8 ') {
      if (size < 10 || ascii(bytes, start + 3, 3) !== '\x9d\x01\x2a') invalid();
      return dimensions(view.getUint16(start + 6, true) & 16383, view.getUint16(start + 8, true) & 16383);
    }
    if (size < 5 || bytes[start] !== 47) invalid();
    const packed = view.getUint32(start + 1, true);
    return dimensions((packed & 16383) + 1, ((packed >>> 14) & 16383) + 1);
  }
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > bytes.length) invalid();
    if (type === 'VP8X') {
      if (result || size !== 10) invalid();
      result = dimensions(u24(start + 4) + 1, u24(start + 7) + 1);
      animation = !!(bytes[start] & 2);
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (animation) invalid();
      const frame = frameDimensions(start, size, type);
      if (result && (frame.width !== result.width || frame.height !== result.height)) invalid();
      result ??= frame;
      imageData = true;
    } else if (type === 'ANIM') {
      if (!animation || size !== 6 || animationSettings) invalid();
      animationSettings = true;
    } else if (type === 'ANMF') {
      if (!result || !animation || !animationSettings || size < 24) invalid();
      const width = u24(start + 6) + 1;
      const height = u24(start + 9) + 1;
      dimensions(width, height);
      if (u24(start) * 2 + width > result.width || u24(start + 3) * 2 + height > result.height) invalid();
      let child = start + 16;
      let frameData = false;
      while (child < start + size) {
        if (child + 8 > start + size) invalid();
        const frameType = ascii(bytes, child, 4);
        const frameSize = view.getUint32(child + 4, true);
        if (child + 8 + frameSize > start + size) invalid();
        if (frameType === 'VP8 ' || frameType === 'VP8L') {
          if (frameData) invalid();
          const frame = frameDimensions(child + 8, frameSize, frameType);
          if (frame.width !== width || frame.height !== height) invalid();
          frameData = true;
        } else if (frameType !== 'ALPH') invalid();
        child += 8 + frameSize + (frameSize & 1);
      }
      if (!frameData || child !== start + size) invalid();
      dimensions(result.width, result.height, ++frames);
      imageData = true;
    }
    offset = start + size + (size & 1);
  }
  if (!result || !imageData || offset !== bytes.length || (animation && !frames)) invalid();
  return { ...result, frames: Math.max(frames, 1) };
}

function avif(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let boxes = 0;
  let branded = false;
  let payload = false;
  let result;
  function walk(start, end, depth) {
    if (depth > 6) invalid();
    let offset = start;
    while (offset < end) {
      if (offset + 8 > end || ++boxes > 2048) invalid();
      let size = view.getUint32(offset);
      const type = ascii(bytes, offset + 4, 4);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end || view.getUint32(offset + 8) !== 0) invalid();
        size = view.getUint32(offset + 12);
        header = 16;
      }
      if (!size) size = end - offset;
      if (size < header || offset + size > end) invalid();
      const data = offset + header;
      if (type === 'ftyp') {
        if (depth !== 0 || size < header + 8 || (size - header) % 4) invalid();
        const brands = [];
        for (let pos = data; pos < offset + size; pos += 4) if (pos !== data + 4) brands.push(ascii(bytes, pos, 4));
        if (brands.includes('avis')) invalid('unsupported'); // no unbounded AV1 sequences
        branded = brands.includes('avif');
      } else if (type === 'ispe') {
        if (size !== header + 12) invalid();
        const item = dimensions(view.getUint32(data + 4), view.getUint32(data + 8));
        if (!result || item.width * item.height > result.width * result.height) result = item;
      } else if (type === 'mdat' || type === 'idat') payload = size > header;
      else if (['meta', 'iprp', 'ipco'].includes(type)) walk(data + (type === 'meta' ? 4 : 0), offset + size, depth + 1);
      offset += size;
    }
  }
  walk(0, bytes.length, 0);
  if (!branded || !payload || !result) invalid();
  return result;
}

function svg(bytes) {
  if (bytes.length > 2 * 1024 * 1024 || typeof DOMParser !== 'function') invalid('unsupported');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { invalid(); }
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(text)) invalid('unsafe');
  const document = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = document.documentElement;
  if (document.querySelector('parsererror') || root?.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg') invalid();
  const elements = root.querySelectorAll('*');
  if (elements.length > 20000) invalid('budget');
  for (const element of [root, ...elements]) {
    if (/^(?:script|style|foreignObject|iframe|object|embed|image|feImage|filter|animate.*|set|audio|video)$/i.test(element.localName)) invalid('unsafe');
    for (const attribute of element.attributes) {
      const value = attribute.value;
      if (/^on/i.test(attribute.localName) || attribute.localName === 'base'
        || (/href$/i.test(attribute.localName) && !/^#[^\s]*$/.test(value))
        || /@import|expression\s*\(|javascript\s*:|url\s*\(\s*(?!['"]?#)/i.test(value)
        || attribute.localName === 'filter'
        || (attribute.localName === 'style' && /(?:width|height|filter|animation|transition)\s*:/i.test(value))) invalid('unsafe');
    }
  }
  const length = value => /^\d+(?:\.\d+)?(?:px)?$/.test(value || '') ? Number.parseFloat(value) : 0;
  const box = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const width = length(root.getAttribute('width')) || (box.length === 4 ? box[2] : 0);
  const height = length(root.getAttribute('height')) || (box.length === 4 ? box[3] : 0);
  return dimensions(Math.ceil(width), Math.ceil(height));
}

/** Header/container validation precedes native decode; extension is never proof. */
export function inspectImage(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > IMAGE_LIMITS.maxBytes) invalid('budget');
  let format;
  let result;
  if (bytes.length >= 8 && ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') { format = 'png'; result = png(bytes); }
  else if (bytes[0] === 255 && bytes[1] === 216) { format = 'jpeg'; result = jpeg(bytes); }
  else if (/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) { format = 'gif'; result = gif(bytes); }
  else if (ascii(bytes, 0, 2) === 'BM') { format = 'bmp'; result = bitmap(bytes); }
  else if (bytes.length >= 6 && ascii(bytes, 0, 4) === '\x00\x00\x01\x00') { format = 'ico'; result = ico(bytes); }
  else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') { format = 'webp'; result = webp(bytes); }
  else if (ascii(bytes, 4, 4) === 'ftyp') { format = 'avif'; result = avif(bytes); }
  else {
    const prefix = new TextDecoder().decode(bytes.subarray(0, 512)).replace(/^﻿/, '').trimStart();
    if (!/^(?:<\?xml\b|<svg\b|<!--)/i.test(prefix)) invalid();
    format = 'svg'; result = svg(bytes);
  }
  const mime = { jpeg: 'image/jpeg', svg: 'image/svg+xml', ico: 'image/x-icon' }[format] || `image/${format}`;
  return { ...result, format, mime, bytes: bytes.length };
}

export async function mount(ctx) {
  let disposed = false;
  let dragging = null;
  let image;
  let viewport;
  let mode = ctx.state?.mode === 'original' ? 'original' : 'fit';
  let zoom = Number.isFinite(ctx.state?.zoom) ? Math.max(0.1, Math.min(8, ctx.state.zoom)) : 1;
  const listeners = [];
  const listen = (target, event, fn) => {
    target.addEventListener(event, fn);
    listeners.push(() => target.removeEventListener(event, fn));
  };
  const current = () => !disposed && !ctx.resources.signal.aborted && ctx.resources.isCurrent();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    dragging = null;
    listeners.splice(0).forEach(remove => remove());
    if (image) image.removeAttribute('src');
  };
  ctx.resources.own(dispose);
  const handle = { dispose, getState: () => ({ mode, zoom, scrollLeft: viewport?.scrollLeft || 0, scrollTop: viewport?.scrollTop || 0 }) };
  try {
    const bytes = await ctx.access.bytes(IMAGE_LIMITS.maxBytes);
    if (!current()) return handle;
    const info = inspectImage(bytes);
    viewport = node('div', 'fp-image-viewport');
    viewport.tabIndex = 0;
    viewport.setAttribute('aria-label', '图片预览；原始尺寸时可拖动浏览');
    image = node('img', 'fp-image-content');
    image.alt = ctx.meta.name || ctx.request.name || '图片';
    image.draggable = false;
    image.decoding = 'async';
    const details = `${info.width} × ${info.height} · ${formatBytes(info.bytes)}${info.frames > 1 ? ` · ${info.frames} 帧` : ''}`;
    const scale = node('span', 'fp-image-scale');
    function update() {
      if (!current()) return;
      viewport.dataset.mode = mode;
      image.style.width = mode === 'fit' ? '' : `${Math.round(info.width * zoom)}px`;
      image.style.height = mode === 'fit' ? '' : `${Math.round(info.height * zoom)}px`;
      scale.textContent = mode === 'fit' ? '适合窗口' : `${Math.round(zoom * 100)}%`;
      fit.setAttribute('aria-pressed', String(mode === 'fit'));
      minus.disabled = mode === 'original' && zoom <= .1;
      plus.disabled = mode === 'original' && zoom >= 8;
    }
    const fit = navigationButton('适合窗口', () => { mode = 'fit'; update(); });
    const changeZoom = delta => { mode = 'original'; zoom = Math.max(0.1, Math.min(8, zoom * delta)); update(); };
    const minus = navigationButton('缩小', () => changeZoom(1 / 1.25));
    const plus = navigationButton('放大', () => changeZoom(1.25));
    const options = toolbarMenu(ctx, [
      { label: '原始尺寸', onClick: () => { mode = 'original'; zoom = 1; update(); } },
      { label: '图片信息', disabled: true, disabledReason: details },
    ]);
    scale.title = details;
    ctx.toolbar.append(minus, scale, plus, fit, options);
    listen(image, 'load', () => {
      if (!current()) return;
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > IMAGE_LIMITS.maxSide
        || image.naturalHeight > IMAGE_LIMITS.maxSide || image.naturalWidth * image.naturalHeight > IMAGE_LIMITS.maxPixels) {
        image.removeAttribute('src');
        ctx.error('图片无法在安全尺寸内解码。');
      }
    });
    listen(image, 'error', () => { if (current()) ctx.error('当前环境无法解码此图片。'); });
    listen(viewport, 'pointerdown', event => {
      if (mode === 'fit' || event.button !== 0) return;
      dragging = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.setPointerCapture?.(event.pointerId);
    });
    listen(viewport, 'pointermove', event => {
      if (!dragging || event.pointerId !== dragging.id) return;
      viewport.scrollLeft = dragging.left - event.clientX + dragging.x;
      viewport.scrollTop = dragging.top - event.clientY + dragging.y;
    });
    const stopDrag = () => { dragging = null; };
    listen(viewport, 'pointerup', stopDrag);
    listen(viewport, 'pointercancel', stopDrag);
    listen(viewport, 'lostpointercapture', stopDrag);
    listen(viewport, 'keydown', event => {
      if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(1.25); }
      if (event.key === '-') { event.preventDefault(); changeZoom(1 / 1.25); }
    });
    image.src = ctx.resources.url(new Blob([bytes], { type: info.mime }));
    viewport.append(image);
    ctx.host.append(viewport);
    update();
    if (mode === 'original') {
      viewport.scrollLeft = Math.max(0, Number(ctx.state?.scrollLeft) || 0);
      viewport.scrollTop = Math.max(0, Number(ctx.state?.scrollTop) || 0);
    }
  } catch (error) {
    if (current()) ctx.error(error?.code?.startsWith('image_') ? error.message : '图片读取失败。');
  }
  return handle;
}
