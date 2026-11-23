/* Attachment intake and message assembly. Pi RPC still receives message plus
 * optional ImageContent; a local preview never implies native model support.
 * PDF/DOCX/text extraction and controlled file storage remain server-owned. */
import { el, S } from './state.js';
import { fmt, esc } from './util.js';
import { uploadFile } from './api.js';
import { updateSendState, imageInputBlocked } from './composer.js';
import { toast } from './ui/toast.js';
import { logRendererEvent } from './log-client.js';
import { attachmentMimeType, attachmentFileType, nativeImageMime, sniffImageMime, imageContent, attachmentSendBlocked } from './attachment-types.js';
import { prepareAttachmentPreview, releaseAttachmentPreview, reconcileAttachmentPreviews } from './attachment-preview.js';
import { renderAttachmentTray } from './attachment-view.js';

let attachmentSequence = 0;
let intakeGeneration = 0;
const readers = new Map();
const uploads = new Map();

function fileToDataUrl(file, attachment) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    readers.set(attachment, reader);
    const finish = (error, value) => {
      readers.delete(attachment);
      reader.onload = reader.onerror = reader.onabort = null;
      if (error) reject(error); else resolve(value);
    };
    reader.onload = () => finish(null, String(reader.result));
    reader.onerror = () => finish(new Error('图片数据读取失败'));
    reader.onabort = () => finish(new Error('已取消读取'));
    reader.readAsDataURL(file);
  });
}

function releaseAttachment(attachment) {
  const reader = readers.get(attachment);
  if (reader) { readers.delete(attachment); reader.abort(); }
  // An invalidated item must not leave a request running against the server.
  const upload = uploads.get(attachment);
  if (upload) { uploads.delete(attachment); upload.abort(); }
  releaseAttachmentPreview(attachment);
}

export async function handleFiles(fileList) {
  const generation = intakeGeneration;
  const workspace = S.workspaceGeneration;
  const pending = [];
  let rejectedImages = false;
  // Reserve the whole selection before awaiting a read/upload. Removing a
  // pending item cannot let the remainder of the batch silently send early.
  for (const file of [...fileList]) {
    if (!file || !Number.isFinite(file.size) || file.size < 0) continue;
    const name = file.name || (String(file.type).startsWith('image/') ? '粘贴的图片.png' : '附件');
    const mimeType = attachmentMimeType(name, file.type);
    const nativeImage = Boolean(nativeImageMime(name, mimeType));
    if (nativeImage && imageInputBlocked()) { rejectedImages = true; continue; }
    const attachment = { id: 'attachment-' + ++attachmentSequence, name, size: file.size, mimeType, file,
      loading: true, kind: nativeImage ? 'image' : 'unknown' };
    S.attachments.push(attachment);
    pending.push({ file, attachment, nativeImage });
  }
  if (rejectedImages) toast('当前模型不支持图片，仍可添加普通文件。', 'info');
  renderAttachments(); updateSendState();
  const current = attachment => generation === intakeGeneration && workspace === S.workspaceGeneration && S.attachments.includes(attachment);

  // Existing sequential upload avoids allocating one decoder/body per item in
  // an arbitrarily large selection. Preview decoding is independent of sending.
  for (const { file, attachment, nativeImage } of pending) {
    if (!current(attachment)) continue;
    if (!file.size) {
      attachment.loading = false; attachment.uploadFailed = true; attachment.error = '文件内容为空';
      renderAttachments(); updateSendState(); continue;
    }
    prepareAttachmentPreview(attachment, file, attachmentFileType(attachment.name, attachment.mimeType), () => {
      if (current(attachment)) renderAttachments();
    });
    if (nativeImage) {
      try {
        const dataUrl = await fileToDataUrl(file, attachment);
        if (!current(attachment)) continue;
        // FileReader uses octet-stream when the browser supplied no MIME. The
        // bytes, not the name or declared MIME, decide the actual wire format.
        const detected = sniffImageMime(dataUrl);
        if (!detected) {
          attachment.error = '文件内容与图片格式不符，将作为文件引用附加';
          logRendererEvent('ui.attachment_failed', { kind: 'image', reason: 'signature_mismatch' });
        } else {
          attachment.mimeType = detected;
          attachment.dataUrl = dataUrl.replace(/^data:[^;,]*;base64,/, `data:${detected};base64,`);
        }
      } catch {
        if (!current(attachment)) continue;
        attachment.error = '图片数据读取失败，保留原文件引用';
        logRendererEvent('ui.attachment_failed', { kind: 'image', reason: 'read_failed' });
      }
    }
    if (!current(attachment)) continue;
    if (nativeImage && imageInputBlocked()) {
      removeAttachment(attachment.id);
      toast('当前模型不支持图片，仍可添加普通文件。', 'info');
      continue;
    }
    const upload = new AbortController();
    uploads.set(attachment, upload);
    try {
      const result = await uploadFile(file, attachment.name, { signal: upload.signal });
      if (!current(attachment)) continue;
      if (!result.ok) throw new Error(result.error || '上传失败，请移除后重新添加');
      // Keep client identity and original File metadata. Server name is the
      // sanitized storage component, not necessarily the full displayed name.
      attachment.serverId = result.id;
      for (const key of ['path', 'text', 'chars', 'pages', 'truncated', 'note']) {
        if (Object.hasOwn(result, key)) attachment[key] = result[key];
      }
      // Only a verified data URL may claim image input. A read failure or a
      // name-only image remains a normal file reference with its stored path.
      attachment.kind = nativeImage && attachment.dataUrl ? 'image' : result.kind === 'image' ? 'binary' : result.kind || 'binary';
      attachment.loading = false;
      if (result.error && !attachment.error) attachment.error = result.error;
    } catch (error) {
      if (!current(attachment)) continue;
      attachment.loading = false;
      attachment.uploadFailed = true;
      attachment.error = error.message || '上传失败，请移除后重新添加';
      logRendererEvent('ui.attachment_failed', { kind: nativeImage ? 'image' : 'text', reason: 'upload_failed' });
    } finally {
      uploads.delete(attachment);
    }
    renderAttachments(); updateSendState();
  }
}

export function removeAttachment(id) {
  const removed = S.attachments.filter(attachment => attachment.id === id);
  S.attachments = S.attachments.filter(attachment => attachment.id !== id);
  removed.forEach(releaseAttachment);
  renderAttachments(); updateSendState();
}

export function renderAttachments() {
  reconcileAttachmentPreviews(S.attachments);
  if (!el.attachTray) return;
  renderAttachmentTray(el.attachTray, S.attachments, {
    imageBlocked: imageInputBlocked(), remove: removeAttachment, emptyFocus: el.btnAttach,
  });
}

function resetAttachmentIntake() {
  intakeGeneration++;
  const old = S.attachments;
  S.attachments = [];
  old.forEach(releaseAttachment);
  renderAttachments(); updateSendState();
}
// Same boundaries as the existing draft/approval/command surfaces; delayed
// uploads cannot append the rest of a batch into a different conversation.
for (const event of ['pi-gui:workspace-generation', 'pi-gui:session-switch']) {
  document.addEventListener(event, resetAttachmentIntake);
}
window.addEventListener('pagehide', () => {
  /* A hidden page cannot finish intake predictably. Invalidate the generation
   * before releasing anything, so a late read/upload can neither mark an item
   * ready nor create a preview after cleanup. Incomplete items are reported
   * honestly instead of staying in a permanent loading state after bfcache. */
  intakeGeneration++;
  for (const attachment of S.attachments) {
    releaseAttachment(attachment);
    if (attachment.loading) {
      attachment.loading = false;
      attachment.uploadFailed = true;
      attachment.error = '页面已离开，请重新添加此附件';
      delete attachment.file;
    }
  }
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  // Local previews are memory-only and released on pagehide. Rebuild them from
  // the original draft File; uploaded file references themselves are unaffected.
  for (const attachment of S.attachments) {
    const type = attachmentFileType(attachment.name, attachment.mimeType);
    if (attachment.file && !attachment.uploadFailed && (type === 'image' || type === 'video')) {
      prepareAttachmentPreview(attachment, attachment.file, type, () => {
        if (S.attachments.includes(attachment)) renderAttachments();
      });
    }
  }
  renderAttachments(); updateSendState();
});

/* ---------- Message assembly: unchanged Pi protocol ---------- */
// `esc="1"` marks attributes written by the escaping serializer. Messages from
// older builds contain literal filenames, so the decoder must not rewrite them.
export const FILE_BLOCK_RE = /<pi-file name="([^"]*)" meta="([^"]*)"(?: esc="1")?>\n?([\s\S]*?)\n?<\/pi-file>/g;

function fileBlock(name, meta, content) {
  const escaped = esc(name);
  return `<pi-file name="${escaped}" meta="${esc(meta)}"${escaped === name ? '' : ' esc="1"'}>\n${content}\n</pi-file>`;
}

export function buildMessage(text) {
  const attachments = S.attachments.filter(a => !a.loading && !attachmentSendBlocked(a));
  const images = attachments.filter(a => imageContent(a));
  const documents = attachments.filter(a => !imageContent(a));
  const parts = text ? [text] : [];
  if (images.length) parts.push(`【附件】以下 ${images.length} 张图片已作为图像内容提供：` + images.map(a => a.name).join('、'));
  for (const a of documents) {
    if (a.kind === 'text') {
      const meta = [a.pages ? a.pages + ' 页' : '', fmt(a.chars) + ' 字', a.truncated ? '已截断' : ''].filter(Boolean).join(' · ');
      parts.push(fileBlock(a.name, meta, `${a.text || ''}${a.truncated ? '\n…（内容过长，已截断）' : ''}`));
    } else if (a.path) {
      const content = [a.error ? `文本提取未完成：${a.error}` : '', `本机路径：${a.path}`,
        '原文件引用；文件内容未内联到消息中。按需使用可用工具读取，不要假定已读取或理解其内容。'].filter(Boolean).join('\n');
      parts.push(fileBlock(a.name, '文件引用', content));
    }
  }
  return parts.join('\n\n');
}

export function attachmentImages() {
  return S.attachments.filter(a => !attachmentSendBlocked(a)).map(imageContent).filter(Boolean);
}
