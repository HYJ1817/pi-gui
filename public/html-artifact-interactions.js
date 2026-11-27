import { safeWebUrl } from './web-activity.js';
import { confirmModal, confirmSurfaceMeta, dismissConfirm } from './ui/modal.js';
import { createArtifactControls } from './html-artifact-controls.js';

const BASE_FIELDS = ['schemaVersion', 'type', 'id', 'nonce'];
const MESSAGE_FIELDS = Object.freeze({
  ready: [], escape: [], resize: ['height', 'naturalHeight', 'naturalWidth', 'capped', 'feedback'],
  'presentation-ready': ['expanded', 'sequence'], link: ['href'], image: ['src', 'alt'],
});
const MAX_IMAGE_LENGTH = 2 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
const pendingActions = new WeakMap();
const lastRequests = new WeakMap();

/** Called only after the viewer checked source, opaque origin, id and nonce.
 * This is an instance envelope, NOT an authentication proof for page scripts.
 */
export function validArtifactMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1
      || !Object.hasOwn(MESSAGE_FIELDS, value.type)) return false;
  const allowed = BASE_FIELDS.concat(MESSAGE_FIELDS[value.type]);
  if (Object.keys(value).some(key => !allowed.includes(key))) return false;
  if (value.type === 'resize') {
    if (typeof value.height !== 'number' || !Number.isFinite(value.height)) return false;
    for (const key of ['naturalHeight', 'naturalWidth']) if (value[key] !== undefined
      && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0)) return false;
    return (value.capped === undefined || typeof value.capped === 'boolean')
      && (value.feedback === undefined || typeof value.feedback === 'boolean');
  }
  if (value.type === 'presentation-ready') return Object.keys(value).length === allowed.length
    && allowed.every(key => Object.hasOwn(value, key))
    && typeof value.id === 'string' && typeof value.nonce === 'string'
    && typeof value.expanded === 'boolean' && Number.isSafeInteger(value.sequence) && value.sequence > 0;
  if (value.type === 'link') return Boolean(artifactWebUrl(value.href));
  if (value.type === 'image') return typeof value.src === 'string' && value.src.length <= MAX_IMAGE_LENGTH
    && typeof value.alt === 'string' && value.alt.length <= 256;
  return true;
}

export function artifactWebUrl(href) {
  if (typeof href !== 'string' || href.length > 2048 || /[\u007f-\u009f]/.test(href)) return null;
  return safeWebUrl(href);
}

// Before giving the decoder any bytes, bound the advertised raster dimensions.
// The decoder's real dimensions are checked again. No SVG/HTML/URL/Blob input.
export function artifactRaster(src, view) {
  if (typeof src !== 'string' || src.length > MAX_IMAGE_LENGTH) return null;
  const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(src);
  if (!match || match[2].length % 4 !== 0) return null;
  let bytes;
  try { bytes = Uint8Array.from(view.atob(match[2]), character => character.charCodeAt(0)); }
  catch { return null; }
  const data = new DataView(bytes.buffer);
  const ascii = (start, length) => String.fromCharCode(...bytes.slice(start, start + length));
  let width = 0, height = 0;
  const kind = match[1].toLowerCase();
  if (kind === 'png' && bytes.length >= 33 && ascii(1, 3) === 'PNG'
      && bytes[0] === 137 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10
      && data.getUint32(8) === 13 && ascii(12, 4) === 'IHDR') {
    width = data.getUint32(16); height = data.getUint32(20);
  } else if (kind === 'gif' && bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) {
    width = data.getUint16(6, true); height = data.getUint16(8, true);
  } else if (kind === 'webp' && bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    if (ascii(12, 4) === 'VP8X') {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (ascii(12, 4) === 'VP8 ' && ascii(23, 3) === '\u009d\u0001*') {
      width = data.getUint16(26, true) & 16383; height = data.getUint16(28, true) & 16383;
    } else if (ascii(12, 4) === 'VP8L' && bytes[20] === 47) {
      const bits = data.getUint32(21, true);
      width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1;
    }
  } else if (kind === 'jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    let cursor = 2;
    while (cursor + 8 < Math.min(bytes.length, 65536)) {
      if (bytes[cursor++] !== 255) break;
      while (bytes[cursor] === 255) cursor++;
      const marker = bytes[cursor++];
      if (marker === 217 || marker === 218 || cursor + 2 > bytes.length) break;
      const length = data.getUint16(cursor);
      if (length < 2 || cursor + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8) {
        height = data.getUint16(cursor + 3); width = data.getUint16(cursor + 5); break;
      }
      cursor += length;
    }
  }
  if (!width || !height || width > 8192 || height > 8192 || width * height > MAX_IMAGE_PIXELS) return null;
  return { src, width, height };
}

/** The user must activate the opaque frame recently, then STILL explicitly
 * confirm a link in host UI. A forged nonce or userAction flag cannot grant it.
 * One pending action / bounded prompt rate across all artifacts in a document.
 */
export function createArtifactInteractions({ document: doc, isCurrent, getFrame, closeExpanded, report }) {
  const view = doc.defaultView;
  const token = {};
  let disposed = false, imageDialog = null, imageTimer = null;
  const alive = () => !disposed && isCurrent();
  const active = () => alive() && doc.activeElement === getFrame() && view.navigator.userActivation?.isActive === true;
  function take() {
    const now = view.performance.now();
    if (!active() || pendingActions.has(doc) || now - (lastRequests.get(doc) ?? -Infinity) < 1000) return false;
    lastRequests.set(doc, now); pendingActions.set(doc, token); return true;
  }
  function release() { if (pendingActions.get(doc) === token) pendingActions.delete(doc); }
  async function link(href) {
    const target = artifactWebUrl(href);
    if (!target || !take()) return;
    // Existing confirmLayer is outside the native top layer. Collapse without
    // removing/reloading the frame so the shared host confirmation is reachable.
    closeExpanded();
    try {
      const approved = await confirmModal({ title: '打开可视化中的链接？',
        message: '此链接来自生成的页面，将在系统浏览器中打开。',
        details: [{ label: '地址', text: target, mono: true }],
        okText: '在浏览器中打开', surface: 'html-artifact-link', meta: { token } });
      if (approved !== true || !alive()) return;
      const open = view.piGuiDesktop?.openWebUrl;
      if (typeof open !== 'function') { report('当前环境无法打开外部链接。'); return; }
      const result = await open(target);
      if (alive() && result?.ok !== true) report('链接未能打开，请重试。');
    } catch { if (alive()) report('链接未能打开，请重试。'); }
    finally { release(); }
  }
  function closeImage() {
    if (imageTimer !== null) view.clearTimeout(imageTimer);
    imageTimer = null;
    if (!imageDialog) return;
    const { dialog, controls, image, returnFocus } = imageDialog;
    imageDialog = null;
    if (dialog.open) dialog.close();
    image.onload = null; image.onerror = null; image.removeAttribute('src');
    controls.dispose(); dialog.remove(); release();
    if (alive() && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  function image(src, alt) {
    const raster = artifactRaster(src, view);
    if (!raster || !take()) return;
    const dialog = doc.createElement('dialog');
    if (typeof dialog.showModal !== 'function') { release(); return; }
    // Cancel an in-flight expansion too; its late ACK must not cover this image.
    closeExpanded();
    dialog.className = 'html-artifact-image-dialog';
    dialog.setAttribute('aria-label', alt || '查看图片');
    const viewport = doc.createElement('div'); viewport.className = 'html-artifact-image-viewport';
    const img = doc.createElement('img'); img.alt = alt; img.referrerPolicy = 'no-referrer';
    viewport.append(img);
    let scale = 1, fitting = true;
    const paint = () => {
      const fitScale = Math.min(1, (viewport.clientWidth || 700) / raster.width);
      const factor = fitting ? fitScale : scale;
      img.style.width = `${raster.width * factor}px`; img.style.height = `${raster.height * factor}px`;
      controls.update(factor, fitting);
    };
    const controls = createArtifactControls(doc, {
      onClose: closeImage, onFit() { fitting = true; paint(); },
      onReset() { fitting = false; scale = 1; paint(); },
      onZoom(delta) { fitting = false; scale = Math.max(0.5, Math.min(2, scale + delta)); paint(); },
    });
    dialog.append(viewport, controls.node);
    const returnFocus = doc.activeElement;
    imageDialog = { dialog, controls, image: img, returnFocus };
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeImage(); });
    dialog.addEventListener('close', () => { if (!dialog.open) closeImage(); });
    img.onerror = () => { closeImage(); if (alive()) report('图片暂时无法显示。'); };
    img.onload = () => {
      if (!alive() || imageDialog?.dialog !== dialog || img.naturalWidth !== raster.width || img.naturalHeight !== raster.height) { closeImage(); return; }
      view.clearTimeout(imageTimer); imageTimer = null; paint();
    };
    doc.body.append(dialog); dialog.showModal(); paint(); controls.close.focus({ preventScroll: true });
    imageTimer = view.setTimeout(closeImage, 5000);
    img.src = raster.src;
  }
  return {
    link, image, closeImage,
    hasImage: () => Boolean(imageDialog),
    dispose() {
      disposed = true; closeImage();
      if (confirmSurfaceMeta()?.token === token) dismissConfirm();
      release();
    },
  };
}
