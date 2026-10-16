/* 附件。
 *
 * pi 的原生附件只有图片（prompt / steer 的 images 字段，ImageContent 格式）。
 * PDF、Word 这些它读不了 —— 内置工具只有 bash/edit/grep/ls/read/write，
 * 所以由后端 lib/extract.js 先转成文本，再以 <pi-file> 块拼进消息正文。
 * 图片则保持原样走 images 字段，让模型真正「看」到图。
 *
 * 因此这个文件有两条产出：
 *   - 托盘（renderAttachments / handleFiles）：给用户看的
 *   - 消息正文（buildMessage / attachmentImages）：真正发给 pi 的 */

import { el, S } from './state.js';
import { fmt, fmtSize, icon, iconFor } from './util.js';
import { uploadFile } from './api.js';
import { updateSendState, imageInputBlocked } from './composer.js';
import { toast } from './ui/toast.js';

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

function attMeta(a) {
  if (a.loading) return '解析中…';
  if (a.error) return a.error;
  if (a.kind === 'image') return imageInputBlocked() ? '当前模型不支持图片，请移除或切换模型' : '已就绪 · 图片';
  if (a.kind === 'text') {
    const bits = [];
    if (a.pages) bits.push(a.pages + ' 页');
    bits.push(fmt(a.chars) + ' 字');
    if (a.truncated) bits.push('已截断');
    if (a.note) bits.push(a.note);
    return `已就绪 · ${bits.join(' · ')}`;
  }
  return '二进制 · pi 读不了';
}

export async function handleFiles(fileList) {
  const files = [...fileList].filter((f) => f && f.size > 0);
  if (!files.length) return;

  for (const f of files) {
    const isImg = /^image\//.test(f.type || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name || '');
    if (isImg && imageInputBlocked()) {
      toast('当前模型不支持图片，仍可添加普通文件。', 'info');
      continue;
    }
    const att = {
      id: 'tmp-' + Math.random().toString(36).slice(2),
      name: f.name || '粘贴的图片.png',
      size: f.size,
      loading: true,
      kind: isImg ? 'image' : 'unknown',
    };

    if (isImg) {
      try {
        att.dataUrl = await fileToDataUrl(f);
      } catch {
        /* 缩略图失败不影响上传 */
      }
    }

    if (isImg && imageInputBlocked()) {
      toast('当前模型不支持图片，仍可添加普通文件。', 'info');
      continue;
    }
    S.attachments.push(att);
    renderAttachments();
    updateSendState();

    try {
      const j = await uploadFile(f, att.name);
      if (!j.ok) throw new Error(j.error || '上传失败');

      // 保留客户端算出来的 kind（mime 更可靠），其余以后端为准
      const keepImg = att.kind === 'image';
      Object.assign(att, j);
      if (keepImg) att.kind = 'image';
      att.loading = false;
      if (j.error) att.error = j.error;
    } catch (err) {
      att.loading = false;
      att.error = err.message || '上传失败';
    }

    renderAttachments();
  }

  updateSendState();
}

/* 输入区状态由 composer.js 负责，但附件一变就要立刻反映到发送键上。 */
export function removeAttachment(id) {
  S.attachments = S.attachments.filter((a) => a.id !== id);
  renderAttachments();
  updateSendState();
}

export function renderAttachments() {
  const box = el.attachTray;
  const focused = box.contains(document.activeElement) ? document.activeElement.dataset.attachmentId : undefined;
  const focusIndex = focused === undefined ? -1 : [...box.querySelectorAll('.att-x')].indexOf(document.activeElement);
  box.classList.add('ui3-attachment-tray');
  box.innerHTML = '';

  if (!S.attachments.length) {
    box.hidden = true;
    if (focused !== undefined) el.btnAttach.focus({ preventScroll: true });
    return;
  }
  box.hidden = false;

  for (const a of S.attachments) {
    const d = document.createElement('div');
    const state = a.loading ? 'loading' : a.error ? 'error'
      : a.kind === 'image' ? imageInputBlocked() ? 'blocked' : 'ready'
        : a.kind === 'text' ? a.truncated ? 'truncated' : 'ready' : 'unreadable';
    d.className = 'att ui3-attachment-card' + (a.loading ? ' loading' : '') + (a.error ? ' err' : '');
    d.dataset.state = state;
    d.setAttribute('role', 'listitem');
    d.setAttribute('aria-busy', String(Boolean(a.loading)));

    if (a.kind === 'image' && a.dataUrl) {
      const th = document.createElement('div');
      th.className = 'att-thumb';
      const img = document.createElement('img');
      img.src = a.dataUrl;
      img.alt = a.name;
      th.appendChild(img);
      d.appendChild(th);
    } else if (a.loading) {
      const ic = document.createElement('div');
      ic.className = 'att-ic';
      const sp = document.createElement('div');
      sp.className = 'att-spin';
      ic.appendChild(sp);
      d.appendChild(ic);
    } else {
      const ic = document.createElement('div');
      ic.className = 'att-ic';
      ic.appendChild(icon(iconFor(a.name)));
      d.appendChild(ic);
    }

    const body = document.createElement('div');
    body.className = 'att-body';
    const n = document.createElement('span');
    n.className = 'att-name';
    n.textContent = a.name;
    n.title = a.path || a.name;
    const m = document.createElement('span');
    m.className = 'att-meta';
    m.textContent = attMeta(a);
    m.title = m.textContent;
    const size = document.createElement('span');
    size.className = 'ui3-attachment-size';
    // Zero bytes is real information; missing sizes stay unknown.
    size.textContent = typeof a.size === 'number' && Number.isFinite(a.size) && a.size >= 0 ? fmtSize(a.size) : '';
    size.hidden = !size.textContent;
    body.append(n, m, size);
    d.appendChild(body);

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'att-x ui3-attachment-remove';
    x.dataset.attachmentId = String(a.id);
    x.title = '移除';
    x.setAttribute('aria-label', `移除附件：${a.name}`);
    x.appendChild(icon(['M7 7l10 10', 'M17 7L7 17']));
    x.onclick = (e) => {
      e.stopPropagation();
      removeAttachment(a.id);
    };
    d.appendChild(x);

    box.appendChild(d);
  }
  if (focused !== undefined) {
    const buttons = [...box.querySelectorAll('.att-x')];
    const target = buttons.find(button => button.dataset.attachmentId === focused)
      || buttons[Math.min(focusIndex, buttons.length - 1)];
    target?.focus({ preventScroll: true });
  }
}

/* ---------- 消息组装 ---------- */

/* 附件在消息正文里的标记。用自定义标签而不是 Markdown 代码块，
 * 是为了渲染时能折叠成一张卡片，避免几万字的 PDF 直接铺满对话。 */
export const FILE_BLOCK_RE = /<pi-file name="([^"]*)" meta="([^"]*)">\n?([\s\S]*?)\n?<\/pi-file>/g;

export function buildMessage(text) {
  const atts = S.attachments.slice();
  const images = atts.filter((a) => a.kind === 'image');
  const docs = atts.filter((a) => a.kind !== 'image');
  if (!atts.length) return text;

  const parts = [];
  if (text) parts.push(text);

  if (images.length) {
    parts.push(
      `【附件】以下 ${images.length} 张图片已作为图像内容提供：` + images.map((a) => a.name).join('、')
    );
  }

  const blocks = [];
  for (const a of docs) {
    if (a.kind === 'text') {
      const meta = [a.pages ? a.pages + ' 页' : '', fmt(a.chars) + ' 字', a.truncated ? '已截断' : '']
        .filter(Boolean)
        .join(' · ');
      blocks.push(
        `<pi-file name="${a.name}" meta="${meta}">\n${a.text}${a.truncated ? '\n…（内容过长，已截断）' : ''}\n</pi-file>`
      );
    } else {
      const why = a.error ? a.error : '无法解析为文本';
      blocks.push(
        `<pi-file name="${a.name}" meta="无法解析">\n（${why}）\n本机路径：${a.path || '未知'}\n如果这是文本类文件，可以用 read 工具按上面的路径读取。\n</pi-file>`
      );
    }
  }
  if (blocks.length) parts.push(blocks.join('\n\n'));

  return parts.join('\n\n');
}

export function attachmentImages() {
  return S.attachments
    .filter((a) => a.kind === 'image' && a.dataUrl)
    .map((a) => {
      const m = /^data:([^;]+);base64,(.*)$/.exec(a.dataUrl);
      return m ? { type: 'image', data: m[2], mimeType: m[1] } : null;
    })
    .filter(Boolean);
}
