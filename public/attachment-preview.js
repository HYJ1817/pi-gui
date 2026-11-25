/* Local-only preview resources. These URLs never enter prompt/ImageContent.
 * The attachment owner calls reconcile after remove/send/reset; every URL,
 * decoder, timer and open preview is released with its own resource record. */
import { openFileReference } from './files-panel.js';
import { gitConversationScope } from './api.js';
import { S } from './state.js';
import { runtimeStore } from './runtime-state.js';

// Records also own previews without thumbnails (TXT/PDF/Office/ZIP). Draft
// reconciliation must revoke those Files just as it revokes image object URLs.
const previewResources = new Map();
function previewResource(attachment) {
  let resource = previewResources.get(attachment);
  if (!resource) { resource = { url: null, cancel: null }; previewResources.set(attachment, resource); }
  return resource;
}
const IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_BASE64_LENGTH = Math.ceil(IMAGE_BYTES / 3) * 4;
const IMAGE_EXTENSIONS = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/avif': 'avif' });
let previewEpoch = 0;
for (const event of ['pi-gui:workspace-generation', 'pi-gui:session-switch', 'pi-gui:git-scope']) {
  document.addEventListener(event, () => { previewEpoch++; });
}
window.addEventListener('pagehide', () => { previewEpoch++; });

// Capture at render time, not click time: a retained message/tray node must not
// re-label an old File as an attachment belonging to the newly focused session.
export function attachmentPreviewOwner() {
  const conversationId = gitConversationScope() || '';
  const record = conversationId ? runtimeStore.get(conversationId) : null;
  const cwd = record?.item?.workspace?.cwd || S.cwd || '';
  const sessionId = conversationId ? record?.item?.nativeSessionId || record?.owner?.sessionId || '' : S.state?.sessionId || '';
  return { identity: JSON.stringify([S.workspaceGeneration, conversationId, cwd, sessionId]), epoch: previewEpoch };
}
export function attachmentPreviewIsCurrent(owner, { sameLifetime = true } = {}) {
  const current = attachmentPreviewOwner();
  return owner?.identity === current.identity && (!sameLifetime || owner.epoch === current.epoch);
}

// Both the thumbnail and File conversion use this gate. Bound raw input before
// regex/normalization/atob, then bound decoded size before allocating bytes.
export function imagePreviewData(data, mimeType) {
  if (typeof mimeType !== 'string' || !Object.hasOwn(IMAGE_EXTENSIONS, mimeType) || typeof data !== 'string' || !data.length || data.length > IMAGE_BASE64_LENGTH) return null;
  const encoded = data.replace(/[\r\n]/g, '');
  if (encoded.length % 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) return null;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const size = encoded.length / 4 * 3 - padding;
  if (!size || size > IMAGE_BYTES) return null;
  return { encoded, mimeType, size, extension: IMAGE_EXTENSIONS[mimeType], url: `data:${mimeType};base64,${encoded}` };
}
function localImageData(attachment) {
  const value = attachment?.dataUrl;
  if (typeof value !== 'string' || value.length > IMAGE_BASE64_LENGTH + 32) return null;
  const comma = value.indexOf(',');
  if (comma < 0 || comma > 31) return null;
  const prefix = /^data:(image\/[a-z]+);base64$/.exec(value.slice(0, comma));
  return prefix ? imagePreviewData(value.slice(comma + 1), prefix[1]) : null;
}
export function imagePreviewFile(value, name = '图片') {
  const data = imagePreviewData(value?.encoded, value?.mimeType);
  if (!data) return null;
  try {
    const binary = atob(data.encoded);
    if (binary.length !== data.size || binary.length > IMAGE_BYTES) return null;
    const safeName = String(name || '图片').slice(0, 480);
    const extension = safeName.split('.').at(-1).toLowerCase();
    const matches = data.mimeType === 'image/jpeg' ? ['jpg', 'jpeg', 'jpe', 'jfif'].includes(extension) : extension === data.extension;
    const filename = matches ? safeName : `${safeName}.${data.extension}`;
    return new File([Uint8Array.from(binary, char => char.charCodeAt(0))], filename, { type: data.mimeType });
  } catch { return null; }
}

export function localPreviewSource(attachment) {
  const owned = previewResources.get(attachment);
  if (owned?.url) return owned.url;
  // Existing in-memory image attachments use bounded, allowlisted ImageContent.
  return localImageData(attachment)?.url || '';
}

export function prepareAttachmentPreview(attachment, file, type, onChange) {
  if (!['image', 'video'].includes(type) || previewResources.get(attachment)?.url) return;
  let url;
  try { url = URL.createObjectURL(file); } catch { return; } // Preview is optional; upload remains independent.
  const resource = previewResource(attachment);
  resource.url = url;
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
  document.dispatchEvent(new CustomEvent('pi-gui:attachment-revoked', { detail: { attachmentId: String(attachment.id || '') } }));
  if (!resource) return;
  previewResources.delete(attachment); // A cancellation cannot publish a stale thumbnail.
  resource.cancel?.();
  if (resource.url) URL.revokeObjectURL(resource.url);
  delete attachment.thumbnailUrl;
  delete attachment.previewLoading;
}

export function reconcileAttachmentPreviews(attachments) {
  const live = new Set(attachments);
  for (const attachment of previewResources.keys()) if (!live.has(attachment)) releaseAttachmentPreview(attachment);
}

export function openAttachmentPreview(attachment, type, triggerId = '', owner = attachmentPreviewOwner()) {
  if (!['image', 'video'].includes(type) || !attachmentPreviewIsCurrent(owner) || !S.attachments.includes(attachment)) return null;
  const file = attachment.file || (type === 'image' ? imagePreviewFile(localImageData(attachment), attachment.name) : null);
  if (!file) return null;
  previewResource(attachment);
  // No uploaded path or preview URL crosses this boundary. The reader receives
  // only the original File (or bounded historical ImageContent converted to it).
  return openFileReference({ source: 'attachment', file, name: file.name || attachment.name, bytes: file.size, size: file.size,
    attachmentId: String(attachment.id || ''), triggerId });
}

export function openAttachmentFile(attachment, triggerId = '', owner = attachmentPreviewOwner()) {
  if (!attachment?.file || attachment.loading || attachment.uploadFailed || !attachmentPreviewIsCurrent(owner) || !S.attachments.includes(attachment)) return null;
  previewResource(attachment);
  return openFileReference({ source: 'attachment', file: attachment.file, name: attachment.name,
    bytes: attachment.file.size, size: attachment.file.size, attachmentId: String(attachment.id || ''), triggerId });
}
