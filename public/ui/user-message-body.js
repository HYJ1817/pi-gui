/* Authorized message presentation shared by Classic and Runtime. */
import { createIcon } from './icons.js';
import { md } from '../markdown.js';
import { icon, iconFor } from '../util.js';
import { FILE_BLOCK_RE } from '../attachments.js';

let disclosureId = 0;
const decodeFileAttribute = value => value.replace(/&(quot|amp|lt|gt|#39);/g, (_, entity) => ({ quot: '"', amp: '&', lt: '<', gt: '>', '#39': "'" })[entity]);
/* New messages mark escaped attributes with `esc="1"` on the opening tag.
 * Older builds wrote literal names, which may themselves contain `&amp;`;
 * decoding those would rewrite filenames that were never escaped. */
const ESCAPED_FILE_BLOCK_RE = /^<pi-file name="[^"]*" meta="[^"]*" esc="1">/;

function fileBlockCard(name, meta, content) {
  const d = document.createElement('div');
  d.className = 'msg-file';

  const head = document.createElement('button');
  head.className = 'msg-file-head';
  head.type = 'button';
  head.appendChild(icon(iconFor(name)));

  const n = document.createElement('span');
  n.textContent = name;
  head.appendChild(n);

  const mt = document.createElement('span');
  mt.className = 'msg-file-meta';
  mt.textContent = meta || '';
  head.appendChild(mt);

  const chev = document.createElement('span');
  chev.className = 'mf-chev';
  chev.appendChild(createIcon('chevronRight'));
  head.appendChild(chev);

  const inner = document.createElement('div');
  inner.className = 'msg-file-body';
  inner.id = 'file-detail-' + ++disclosureId;
  inner.hidden = true;
  inner.textContent = content;

  head.setAttribute('aria-controls', inner.id);
  head.setAttribute('aria-expanded', 'false');
  head.onclick = () => {
    const open = inner.hidden;
    d.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
    inner.hidden = !open;
  };
  d.append(head, inner);
  return d;
}

/* 图片附件的缩略图行。数据取自消息 content 里的 image 部分，
 * 所以刷新页面后从历史重建也能还原，不依赖内存里的 S.attachments。 */
function attChips(imgs) {
  const row = document.createElement('div');
  row.className = 'msg-att-chips';
  for (const c of imgs) {
    const chip = document.createElement('div');
    chip.className = 'msg-att-chip';
    chip.title = '图片附件';
    const img = document.createElement('img');
    img.src = `data:${c.mimeType || 'image/png'};base64,${c.data}`;
    img.alt = '图片附件';
    chip.appendChild(img);
    row.appendChild(chip);
  }
  return row;
}

/* 用户消息体：把附件正文切成折叠卡片，否则一份长 PDF 会把对话整个铺满。
 * 实时渲染和历史重建共用，避免刷新后裸标签直接暴露出来。 */
export function userBody(msg) {
  const body = document.createElement('div');
  body.className = 'msg-body';

  const raw = textOf(msg) || '(空消息)';

  const imgs = Array.isArray(msg?.content) ? msg.content.filter((c) => c?.type === 'image' && c.data) : [];
  if (imgs.length) body.appendChild(attChips(imgs));

  FILE_BLOCK_RE.lastIndex = 0;
  let last = 0;
  let m;
  const pushText = (s) => {
    const v = s.trim();
    if (!v) return;
    const seg = document.createElement('div');
    seg.innerHTML = md(v);
    body.appendChild(seg);
  };

  while ((m = FILE_BLOCK_RE.exec(raw))) {
    pushText(raw.slice(last, m.index));
    const escaped = ESCAPED_FILE_BLOCK_RE.test(m[0]);
    body.appendChild(fileBlockCard(escaped ? decodeFileAttribute(m[1]) : m[1], escaped ? decodeFileAttribute(m[2]) : m[2], m[3]));
    last = m.index + m[0].length;
  }
  pushText(raw.slice(last));

  if (!body.childNodes.length) body.textContent = raw;
  return body;
}

export function textOf(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  return '';
}
