/* Local-only preview resources. These URLs never enter prompt/ImageContent.
 * The attachment owner calls reconcile after remove/send/reset; every URL,
 * decoder, timer and open preview is released with its own resource record. */
import { createIcon } from './ui/icons.js';
import { openModal } from './ui/modal.js';
import { fmtSize } from './util.js';

const previewResources = new Map();
let openPreview = null;

export function localPreviewSource(attachment) {
  const owned = previewResources.get(attachment);
  if (owned) return owned.url;
  // Existing in-memory image attachments use the already-read ImageContent.
  return /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[a-zA-Z0-9+/=\r\n]+$/.test(attachment.dataUrl || '') ? attachment.dataUrl : '';
}

export function prepareAttachmentPreview(attachment, file, type, onChange) {
  if (!['image', 'video'].includes(type) || previewResources.has(attachment)) return;
  let url;
  try { url = URL.createObjectURL(file); } catch { return; } // Preview is optional; upload remains independent.
  const resource = { url, cancel: null };
  previewResources.set(attachment, resource);
  if (type !== 'video') return;

  attachment.previewLoading = true;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  let settled = false, seeking = false, frameTimer = 0, frameHandle = null;
  const finish = thumbnail => {
    if (settled) return;
    settled = true;
    clearTimeout(timer); clearTimeout(frameTimer);
    if (frameHandle !== null) { try { video.cancelVideoFrameCallback?.(frameHandle); } catch { /* best-effort */ } }
    video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
    video.removeAttribute('src');
    // Reset Chromium's decoder. No native decoder was acquired in DOM-only environments.
    if (video.readyState) { try { video.load(); } catch { /* best-effort decoder release */ } }
    resource.cancel = null;
    if (previewResources.get(attachment) !== resource) return;
    attachment.previewLoading = false;
    if (thumbnail) attachment.thumbnailUrl = thumbnail;
    onChange();
  };
  const paint = () => {
    if (settled) return;
    try {
      const scale = Math.min(1, 160 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      finish(canvas.toDataURL('image/jpeg', .8));
    } catch { finish(''); }
  };
  const capture = () => {
    if (!video.videoWidth || !video.videoHeight) return finish('');
    // `seeked` may fire before the new frame reaches the compositor; drawing
    // then captures black. Wait for the presented frame, with a short fallback.
    if (typeof video.requestVideoFrameCallback === 'function') {
      frameHandle = video.requestVideoFrameCallback(paint);
      frameTimer = setTimeout(paint, 250);
      return;
    }
    paint();
  };
  const timer = setTimeout(() => finish(''), 5000);
  resource.cancel = () => finish('');
  video.onloadedmetadata = () => {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    try { seeking = true; video.currentTime = Math.min(.1, video.duration / 2); }
    catch { seeking = false; }
  };
  video.onseeked = capture;
  video.onloadeddata = () => { if (!seeking) capture(); };
  video.onerror = () => finish('');
  video.src = url;
}

export function releaseAttachmentPreview(attachment) {
  const resource = previewResources.get(attachment);
  if (openPreview?.attachment === attachment) openPreview.close();
  if (!resource) return;
  previewResources.delete(attachment); // A cancellation cannot publish a stale thumbnail.
  resource.cancel?.();
  URL.revokeObjectURL(resource.url);
  delete attachment.thumbnailUrl;
  delete attachment.previewLoading;
}

export function reconcileAttachmentPreviews(attachments) {
  const live = new Set(attachments);
  for (const attachment of previewResources.keys()) if (!live.has(attachment)) releaseAttachmentPreview(attachment);
  if (openPreview && !live.has(openPreview.attachment)) openPreview.close();
}

export function openAttachmentPreview(attachment, type, returnFocus) {
  const source = localPreviewSource(attachment);
  if (!source || !['image', 'video'].includes(type)) return;
  let media, instance;
  openModal((card, close) => {
    instance = { attachment, close };
    openPreview = instance;
    const head = document.createElement('div'); head.className = 'attachment-preview-head';
    const title = document.createElement('h3'); title.id = 'attachment-preview-title'; title.textContent = attachment.name;
    const size = document.createElement('span'); size.className = 'attachment-preview-size'; size.textContent = fmtSize(attachment.size);
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'icon-btn';
    dismiss.setAttribute('aria-label', '关闭预览'); dismiss.appendChild(createIcon('close')); dismiss.onclick = close;
    head.append(title, size, dismiss);
    const body = document.createElement('div'); body.className = 'attachment-preview-body';
    const error = document.createElement('p'); error.className = 'attachment-preview-error'; error.hidden = true; error.setAttribute('role', 'status');
    error.textContent = '当前浏览器无法预览此文件，原文件仍保留。';
    media = document.createElement(type === 'video' ? 'video' : 'img');
    if (type === 'video') {
      media.controls = true; media.playsInline = true; media.preload = 'metadata'; media.tabIndex = 0;
      media.setAttribute('aria-label', attachment.name);
    } else media.alt = attachment.name;
    media.onerror = () => { error.hidden = false; };
    media.src = source;
    body.append(media, error); card.append(head, body);
  }, () => {
    if (openPreview === instance) openPreview = null;
    media.onerror = null;
    if (type === 'video' && media.readyState) { try { media.pause(); } catch { /* best-effort */ } }
    media.removeAttribute('src');
    if (type === 'video' && media.readyState) { try { media.load(); } catch { /* best-effort */ } }
    // Async tray redraw may have replaced the original trigger while previewing.
    returnFocus?.();
  }, { className: 'attachment-preview-dialog', labelledBy: 'attachment-preview-title' });
}
