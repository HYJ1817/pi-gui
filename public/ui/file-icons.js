/* 文件类型图标：与 ui/icons.js 同一套 24×24 描边语言，颜色由 CSS token 决定。
 *
 * 为什么单独一个模块：文件类型有二十多种，塞进通用 glyphs 会让那本
 * “UI 图形字典”变成文件管理器；同时消息内的链接和 Files 文件树都要用
 * 同一份映射，不能各写一套。 */

const DOC = '<path d="M6.5 3.5h7l4.5 4.5v12.5h-11.5z"/><path d="M13.5 3.5V8H18"/>';
const letter = (text, size = 7.5) =>
  `<text x="12" y="18.2" text-anchor="middle" font-size="${size}" font-weight="700" letter-spacing="-.3" fill="currentColor" stroke="none">${text}</text>`;

const KINDS = Object.freeze({
  code: DOC + '<path d="m10 12.6-2 2 2 2M14 12.6l2 2-2 2"/>',
  style: DOC + '<path d="M10.2 12.4 9.7 17M13.8 12.4 13.3 17M8.8 13.8h6.2M8.6 15.8h6.2"/>',
  markup: DOC + '<path d="M9.6 12.2 7.4 14.6l2.2 2.4M14.4 12.2l2.2 2.4-2.2 2.4"/>',
  data: DOC + '<path d="M10.2 12.2c-1.1 0-1.1 2.4 0 2.4-1.1 0-1.1 2.4 0 2.4M13.8 12.2c1.1 0 1.1 2.4 0 2.4 1.1 0 1.1 2.4 0 2.4"/>',
  text: DOC + '<path d="M9 13h6M9 15.4h6M9 17.8h4"/>',
  config: DOC + '<path d="M8.8 13.2h6.4M8.8 16.2h6.4"/><circle cx="10.6" cy="13.2" r=".95"/><circle cx="13.4" cy="16.2" r=".95"/>',
  image: DOC + '<circle cx="10" cy="12.9" r="1"/><path d="m7.6 18 3-3 2 2 1.8-2.4L17 18"/>',
  pdf: DOC + letter('PDF', 6.4),
  word: DOC + letter('W'),
  sheet: DOC + '<path d="M8.6 12.6h6.8v5.4H8.6zM8.6 15.3h6.8M12 12.6v5.4"/>',
  slides: DOC + '<path d="M9.2 17.8v-3.6M12 17.8v-5.4M14.8 17.8v-2.2"/>',
  archive: DOC + '<path d="M8.8 12.4h6.4v5.6H8.8zM8.8 14h6.4M11.2 12.4v1.6M12.8 14v1.6"/>',
  font: DOC + letter('A'),
  audio: DOC + '<path d="M13.6 12.6v4.6"/><path d="M13.6 12.6l2.8-.7v3.4"/><circle cx="12" cy="17.4" r="1.2"/><circle cx="14.8" cy="15.8" r="1.2"/>',
  video: DOC + '<path d="m10.4 13 4.4 2.6-4.4 2.6z"/>',
  unknown: DOC,
});

const EXT_KINDS = new Map(Object.entries({
  js: 'code', mjs: 'code', cjs: 'code', jsx: 'code', ts: 'code', tsx: 'code',
  py: 'code', pyw: 'code', rs: 'code', go: 'code', java: 'code', kt: 'code',
  kts: 'code', scala: 'code', c: 'code', h: 'code', cc: 'code', cpp: 'code',
  cxx: 'code', hpp: 'code', hh: 'code', cs: 'code', rb: 'code', php: 'code',
  swift: 'code', m: 'code', mm: 'code', lua: 'code', r: 'code', dart: 'code',
  ex: 'code', exs: 'code', erl: 'code', hs: 'code', clj: 'code', fs: 'code',
  sh: 'code', bash: 'code', zsh: 'code', fish: 'code', ps1: 'code', bat: 'code',
  cmd: 'code', sql: 'code', graphql: 'code', gql: 'code', vue: 'code',
  svelte: 'code', astro: 'code', sol: 'code', zig: 'code', nim: 'code',
  css: 'style', scss: 'style', sass: 'style', less: 'style', styl: 'style',
  pcss: 'style',
  html: 'markup', htm: 'markup', xhtml: 'markup', xml: 'markup', svg: 'image',
  json: 'data', jsonc: 'data', json5: 'data', yaml: 'data', yml: 'data',
  toml: 'data', ini: 'data', env: 'data', csv: 'data', tsv: 'data',
  lock: 'data', properties: 'config', conf: 'config', cfg: 'config',
  md: 'text', markdown: 'text', mdx: 'text', txt: 'text', rst: 'text',
  adoc: 'text', log: 'text',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image',
  bmp: 'image', ico: 'image', avif: 'image', tif: 'image', tiff: 'image',
  pdf: 'pdf',
  doc: 'word', docx: 'word', odt: 'word', rtf: 'word',
  xls: 'sheet', xlsx: 'sheet', xlsm: 'sheet', ods: 'sheet',
  ppt: 'slides', pptx: 'slides', odp: 'slides',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive',
  gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive', zst: 'archive',
  woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', eot: 'font',
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio',
  aac: 'audio',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', avi: 'video',
  m4v: 'video',
}));

const NAME_KINDS = new Map(Object.entries({
  makefile: 'config', dockerfile: 'config', '.env': 'config', '.gitignore': 'config',
  '.gitattributes': 'config', '.editorconfig': 'config', '.npmrc': 'config',
  '.prettierrc': 'config', '.eslintrc': 'config', readme: 'text', license: 'text',
  licence: 'text', changelog: 'text', procfile: 'config', gemfile: 'code',
  rakefile: 'code', vagrantfile: 'config',
}));

export function fileNameOf(filePath) {
  const p = String(filePath ?? '').replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

export function fileKind(filePath) {
  const name = fileNameOf(filePath);
  if (!name) return 'unknown';
  const lower = name.toLowerCase();
  if (NAME_KINDS.has(lower)) return NAME_KINDS.get(lower);
  if (lower.startsWith('.') && !lower.includes('.', 1)) {
    return EXT_KINDS.get(lower.slice(1)) || 'unknown';
  }
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return NAME_KINDS.get(lower) || 'unknown';
  return EXT_KINDS.get(lower.slice(dot + 1)) || 'unknown';
}

/** 常量 SVG 字符串 —— 文件名不会拼进 SVG，调用方只拿 `data-kind` 上色。 */
export function fileIconMarkup(filePath) {
  return KINDS[fileKind(filePath)] || KINDS.unknown;
}

export function fileIconHtml(filePath, extraClass = '') {
  const kind = fileKind(filePath);
  return `<span class="file-kind-icon${extraClass ? ' ' + extraClass : ''}" data-file-kind="${kind}" aria-hidden="true">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" focusable="false">${fileIconMarkup(filePath)}</svg>` +
    `</span>`;
}

export function createFileIcon(ownerDocument, filePath, className = 'file-kind-icon') {
  const svgNS = 'http://www.w3.org/2000/svg';
  const span = ownerDocument.createElement('span');
  span.className = className;
  span.dataset.fileKind = fileKind(filePath);
  span.setAttribute('aria-hidden', 'true');
  const svg = ownerDocument.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = fileIconMarkup(filePath);
  span.append(svg);
  return span;
}

export const FILE_KINDS = Object.freeze(Object.keys(KINDS));
