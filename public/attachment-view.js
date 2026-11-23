/* Compact tray projection. Upload state belongs to attachments.js; the view
 * only renders metadata and delegates preview/remove to that owner. */
import { createIcon } from './ui/icons.js';
import { fmtSize } from './util.js';
import { attachmentFileType, ATTACHMENT_ICONS, ATTACHMENT_LABELS } from './attachment-types.js';
import { localPreviewSource, openAttachmentPreview } from './attachment-preview.js';
import { currentAnchor, closePop, toggleHelpPop } from './ui/popover.js';

function statusText(a, blocked) {
  if (a.loading) return '上传并解析中…';
  if (a.error) return a.error;
  if (blocked) return '当前模型不支持图片，请移除或切换模型';
  if (a.truncated) return '内容已截断';
  return '';
}

function sizeText(a) {
  return typeof a.size === 'number' && Number.isFinite(a.size) && a.size >= 0 ? fmtSize(a.size) : '';
}

function fileInfo(a, type, media) {
  const body = document.createElement(media ? 'div' : 'button');
  body.className = 'att-body' + (media ? ' att-media-info' : ' att-info');
  const description = [ATTACHMENT_LABELS[type], a.name, sizeText(a)].filter(Boolean).join(' · ');
  if (!media) {
    body.type = 'button';
    body.setAttribute('aria-label', description);
    body.title = description;
    body.onclick = () => toggleHelpPop(body, description);
    const mark = document.createElement('span'); mark.className = 'att-ic';
    mark.appendChild(createIcon(ATTACHMENT_ICONS[type])); body.appendChild(mark);
  }
  const name = document.createElement('span'); name.className = 'att-name';
  name.textContent = a.name; name.title = a.name;
  const size = document.createElement('span'); size.className = 'ui3-attachment-size';
  size.textContent = sizeText(a); size.hidden = !size.textContent;
  body.append(name, size);
  return body;
}

function mediaButton(a, type, box) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'att-thumb att-preview';
  button.dataset.attachmentId = String(a.id);
  const label = [a.name, sizeText(a)].filter(Boolean).join(' · ');
  button.title = label;
  button.setAttribute('aria-label', `预览${ATTACHMENT_LABELS[type]}：${label}`);
  button.setAttribute('aria-haspopup', 'dialog');
  const source = localPreviewSource(a);
  // Only local owner-created URLs or the existing native ImageContent are used.
  const thumbnail = type === 'video' ? source && a.thumbnailUrl : source;
  const fallback = createIcon(ATTACHMENT_ICONS[type], { className: 'att-media-placeholder' });
  fallback.toggleAttribute('hidden', Boolean(thumbnail));
  if (thumbnail) {
    const image = document.createElement('img'); image.src = thumbnail; image.alt = '';
    image.onerror = () => { image.remove(); fallback.removeAttribute('hidden'); };
    button.appendChild(image);
  }
  button.appendChild(fallback);
  if (type === 'video') {
    const play = document.createElement('span'); play.className = 'att-play';
    play.appendChild(createIcon('play')); button.appendChild(play);
  }
  // A missing decoder/thumbnail does not disable a file that uploaded correctly.
  button.disabled = !source;
  button.onclick = () => openAttachmentPreview(a, type, () => {
    const target = [...box.querySelectorAll('.att-preview')].find(node => node.dataset.attachmentId === String(a.id));
    target?.focus({ preventScroll: true });
  });
  return button;
}

export function renderAttachmentTray(box, attachments, { imageBlocked, remove, emptyFocus }) {
  const active = document.activeElement;
  const focused = box.contains(active) ? active.dataset.attachmentId : undefined;
  const focusRole = active?.classList.contains('att-preview') ? 'att-preview' : active?.classList.contains('att-info') ? 'att-info' : 'att-x';
  const oldButtons = [...box.querySelectorAll('.' + focusRole)];
  const focusIndex = oldButtons.indexOf(active);
  const scrollTop = box.scrollTop;
  if (box.contains(currentAnchor())) closePop();
  box.classList.add('ui3-attachment-tray');
  box.replaceChildren();
  box.hidden = !attachments.length;
  if (!attachments.length) {
    if (focused !== undefined) emptyFocus?.focus({ preventScroll: true });
    return;
  }
  const typed = attachments.map(a => ({ a, type: attachmentFileType(a.name, a.mimeType) }));
  const isMedia = type => type === 'image' || type === 'video';
  // DOM/focus order matches the visual media-first / file-list layout.
  typed.sort((left, right) => Number(isMedia(right.type)) - Number(isMedia(left.type)));
  for (const { a, type } of typed) {
    const media = isMedia(type);
    const blocked = a.kind === 'image' && imageBlocked;
    const status = statusText(a, blocked);
    const item = document.createElement('div');
    item.className = `att ui3-attachment-card ${media ? 'att-media' : 'att-file'}${a.loading ? ' loading' : ''}${a.error ? ' err' : ''}`;
    item.dataset.fileType = type;
    item.dataset.state = a.loading ? 'loading' : a.error ? 'error' : blocked ? 'blocked' : a.truncated ? 'truncated' : a.kind === 'binary' ? 'reference' : 'ready';
    item.setAttribute('role', 'listitem'); item.setAttribute('aria-busy', String(Boolean(a.loading)));
    if (media) item.appendChild(mediaButton(a, type, box));
    const body = fileInfo(a, type, media);
    if (!media) body.dataset.attachmentId = String(a.id);
    item.appendChild(body);
    const meta = document.createElement('span'); meta.className = 'att-meta';
    meta.id = 'attachment-status-' + String(a.id).replace(/[^a-z0-9_-]/gi, '_');
    meta.textContent = status; meta.title = status; meta.hidden = !status;
    if (status) {
      meta.setAttribute('role', a.error ? 'alert' : 'status');
      (media ? item.querySelector('.att-preview') : body).setAttribute('aria-describedby', meta.id);
    }
    if (a.loading) {
      const spin = document.createElement('span'); spin.className = 'att-spin'; spin.setAttribute('aria-hidden', 'true');
      meta.prepend(spin);
    }
    item.appendChild(meta);
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'icon-btn att-x ui3-attachment-remove'; button.dataset.attachmentId = String(a.id);
    button.title = '移除'; button.setAttribute('aria-label', `移除附件：${a.name}`);
    button.appendChild(createIcon('close')); button.onclick = event => { event.stopPropagation(); remove(a.id); };
    item.appendChild(button); box.appendChild(item);
  }
  box.scrollTop = scrollTop;
  if (focused !== undefined) {
    // A disabled media control cannot take focus; never let it swallow the
    // fallback and leave focus outside the tray.
    const usable = node => !node.disabled;
    const sameRole = [...box.querySelectorAll('.' + focusRole)].filter(usable);
    // Removing the last item of one role must not drop focus out of the tray:
    // fall back to whatever attachment control remains before leaving it.
    const anyControl = () => {
      const all = [...box.querySelectorAll('.att-preview, .att-info, .att-x')].filter(usable);
      return all.find(node => node.dataset.attachmentId === focused) || all[Math.min(focusIndex, all.length - 1)];
    };
    const next = sameRole.find(button => button.dataset.attachmentId === focused)
      || sameRole[Math.min(focusIndex, sameRole.length - 1)] || anyControl() || emptyFocus;
    next?.focus({ preventScroll: true });
  }
}
