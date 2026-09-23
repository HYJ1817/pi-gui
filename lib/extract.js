/* 文档解析
 *
 * pi 的原生附件只支持图片（prompt 命令的 images 字段，ImageContent 格式）。
 * 它的内置工具也只有 bash / edit / grep / ls / read / write —— 没有 PDF、Word 解析能力，
 * 所以「把文件路径丢给 pi 让它自己读」这条路对二进制文档是走不通的。
 *
 * 因此这里由 GUI 这一层负责把文档转成纯文本，再拼进消息正文交给 pi：
 *   - 图片          → 不做处理，走 pi 原生 images 附件（真多模态）
 *   - PDF           → pdfjs-dist 抽取（能正确处理 CJK 的 ToUnicode 映射）
 *   - .docx         → 解 ZIP + 解析 word/document.xml（零依赖，用内置 zlib）
 *   - .doc（旧格式）→ 二进制 OLE 复合文档，尝试调用 LibreOffice 转换，没有则明确报错
 *   - 纯文本类      → 直接按 UTF-8 读入
 *   - 其他二进制    → 只保留路径，并如实告知 pi 读不了
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { hasBundledAssets, materializeDir } from './assets.js';

const require = createRequire(import.meta.url);

/* 单次内联进消息的文本上限。太大既撑爆上下文又拖慢首字延迟，
 * 超出部分截断并在末尾注明，让模型知道有省略。 */
export const MAX_INLINE_CHARS = 120000;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yml', '.yaml',
  '.html', '.htm', '.css', '.scss', '.less', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.toml', '.ini', '.conf', '.env',
  '.log', '.srt', '.vtt', '.tex', '.r', '.m', '.swift', '.lua', '.vue', '.svelte',
]);

export function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

export function isImage(name) {
  return IMAGE_EXT.has(extOf(name));
}

export function isTextLike(name) {
  return TEXT_EXT.has(extOf(name));
}

export function maxBytes() {
  return MAX_UPLOAD_BYTES;
}

/* ============ ZIP（.docx 本质是个 zip） ============ */

/* 只实现读取所需的最小 ZIP 解析：定位中央目录 → 按名字取条目 → 解压。
 * Node 内置 zlib，所以整个 .docx 解析链路零外部依赖。 */
function readZipEntries(buf) {
  // EOCD 签名 0x06054b50，从尾部往前找（注释最长 65535 字节）
  const maxBack = Math.min(buf.length, 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
    if (i < 0) break;
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/docx：找不到中央目录');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipFile(buf, entries, name) {
  const e = entries.get(name);
  if (!e) return null;

  // 本地头的 extra 长度可能和中央目录不同，必须按本地头重新算数据偏移
  const lp = e.localOffset;
  if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error('zip 本地头损坏：' + name);
  const nameLen = buf.readUInt16LE(lp + 26);
  const extraLen = buf.readUInt16LE(lp + 28);
  const start = lp + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compSize);

  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('不支持的 zip 压缩方式：' + e.method);
}

/* ============ .docx ============ */

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

export function extractDocx(buf) {
  const entries = readZipEntries(buf);
  const xmlBuf = readZipFile(buf, entries, 'word/document.xml');
  if (!xmlBuf) throw new Error('docx 里找不到 word/document.xml');

  const xml = xmlBuf.toString('utf8');
  const out = [];

  // 按段落切，段内再取 <w:t> 文本。w:t 可能带 xml:space="preserve"
  const paras = xml.split(/<w:p[ >]/).slice(1);
  for (const para of paras) {
    const texts = [...para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) =>
      decodeXmlEntities(m[1])
    );
    let line = texts.join('');
    // 制表符和软换行在 docx 里是独立标签，不在 w:t 内
    line = line.replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:br\b[^>]*\/>/g, '\n');
    out.push(line);
  }

  // 表格单元格会被拆成独立段落，段落之间用换行保持可读性
  let text = out.join('\n');

  // 表格里的 <w:tc> 之间没有换行，压一下连续空行
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  if (!text) throw new Error('docx 解析结果为空');
  return { text, pages: null };
}

/* ============ PDF ============ */

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
      .then((m) => {
        applyWorkerSrc(m);
        return m;
      })
      .catch((e) => {
        pdfjsPromise = null;
        throw new Error('缺少 pdfjs-dist，无法解析 PDF。请先运行 npm install。（' + e.message + '）');
      });
  }
  return pdfjsPromise;
}

function standardFontsUrl() {
  // 打包后（SEA 内嵌 / Electron 随包）没有 node_modules，字体要从包里取
  try {
    if (hasBundledAssets()) {
      return materializeDir('pdfjs/standard_fonts').replace(/\\/g, '/') + '/';
    }
  } catch {
    /* 取不到就退回到「不带标准字体」——多数 PDF 自带字体，仍能抽取 */
  }

  try {
    const pkg = require.resolve('pdfjs-dist/package.json');
    const dir = path.join(path.dirname(pkg), 'standard_fonts');
    if (!fs.existsSync(dir)) return undefined;
    // pdfjs 要求目录 URL 以分隔符结尾
    return dir.replace(/\\/g, '/') + '/';
  } catch {
    return undefined;
  }
}

/* cmaps 用于没有内嵌字体的 CJK PDF —— 中文文档很常见，
 * 缺了它这类 PDF 抽出来会是乱码或空。 */
function cMapsUrl() {
  try {
    if (hasBundledAssets()) {
      const dir = materializeDir('pdfjs/cmaps');
      return { url: dir.replace(/\\/g, '/') + '/', packed: true };
    }
    const pkg = require.resolve('pdfjs-dist/package.json');
    const dir = path.join(path.dirname(pkg), 'cmaps');
    if (!fs.existsSync(dir)) return null;
    return { url: dir.replace(/\\/g, '/') + '/', packed: true };
  } catch {
    return null;
  }
}

/* pdfjs 默认用 './pdf.worker.mjs' 这个相对路径去动态 import worker，
 * 开发时它就在 node_modules 里能找到；打包后那个路径不存在，
 * 会报 "Setting up fake worker failed"。所以有随包资源时显式给一个真实文件路径
 * （必须是 file:// URL，Windows 裸路径会被当成 URL scheme）。
 * 开发模式不用管，默认相对路径能解析。 */
function applyWorkerSrc(pdfjs) {
  if (!hasBundledAssets()) return;
  try {
    const f = path.join(materializeDir('pdfjs/worker'), 'pdf.worker.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(f).href;
  } catch {
    /* 拿不到就退回默认行为，至少不崩 */
  }
}

export async function extractPdf(buf) {
  const pdfjs = await loadPdfjs();

    const task = pdfjs.getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false,
      standardFontDataUrl: standardFontsUrl(),
      ...(() => {
        const cm = cMapsUrl();
        return cm ? { cMapUrl: cm.url, cMapPacked: cm.packed } : {};
      })(),
      // 关闭 worker：Node 下用主线程解析，省掉 worker 文件解析的麻烦
      useWorkerFetch: false,
      disableFontFace: true,
    });

  const doc = await task.promise;
  const parts = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let line = '';
      const lines = [];
      for (const item of tc.items) {
        if (item.str) line += item.str;
        // hasEOL 标记换行；没有这个标记的 PDF 就只能靠间距，先不做
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        }
      }
      if (line) lines.push(line);
      parts.push(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim());
      page.cleanup();
    }
  } finally {
    // 不同 pdfjs 版本把销毁方法挂在 document 或 loadingTask 上，两处都试
    try {
      if (typeof doc.destroy === 'function') await doc.destroy();
      else if (typeof task.destroy === 'function') await task.destroy();
    } catch {
      /* 销毁失败不影响已经拿到的文本 */
    }
  }

  const text = parts
    .map((p, i) => (doc.numPages > 1 ? `【第 ${i + 1} 页】\n${p}` : p))
    .join('\n\n')
    .trim();

  if (!text) throw new Error('PDF 里没有可提取的文字（可能是扫描件，需要 OCR）');
  return { text, pages: doc.numPages };
}

/* ============ .doc（旧二进制格式） ============ */

function findSoffice() {
  const candidates = [
    'C:/Program Files/LibreOffice/program/soffice.exe',
    'C:/Program Files (x86)/LibreOffice/program/soffice.exe',
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* 忽略 */
    }
  }
  return process.env.SOFFICE_BIN || null;
}

export function extractDoc(filePath) {
  const soffice = findSoffice();
  if (!soffice) {
    throw new Error(
      '.doc 是旧版二进制格式，无法直接解析。请用 Word/WPS 另存为 .docx 后再上传。'
    );
  }

  const outDir = fs.mkdtempSync(path.join(path.dirname(filePath), 'conv-'));
  try {
    execFileSync(
      soffice,
      ['--headless', '--norestore', '--convert-to', 'docx', '--outdir', outDir, filePath],
      { stdio: 'ignore', timeout: 90000 }
    );
    const produced = fs.readdirSync(outDir).find((f) => f.toLowerCase().endsWith('.docx'));
    if (!produced) throw new Error('LibreOffice 转换没有产出 .docx');
    const buf = fs.readFileSync(path.join(outDir, produced));
    const r = extractDocx(buf);
    return { ...r, converted: true };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

/* ============ 纯文本 ============ */

export function extractTextFile(buf) {
  let s = buf.toString('utf8');
  // 去掉 BOM
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  // 大量替换字符说明不是 UTF-8，退到 latin1 至少不丢字节
  const bad = (s.match(/\uFFFD/g) || []).length;
  if (bad > s.length * 0.02) s = buf.toString('latin1');
  return { text: s, pages: null };
}

/* ============ 统一入口 ============ */

/**
 * @returns {{kind:'image'|'text'|'binary', text?:string, pages?:number|null, note?:string}}
 */
export async function extract(filePath, originalName) {
  const ext = extOf(originalName);
  const buf = fs.readFileSync(filePath);

  if (IMAGE_EXT.has(ext)) return { kind: 'image' };

  if (ext === '.pdf') {
    const r = await extractPdf(buf);
    return { kind: 'text', text: r.text, pages: r.pages };
  }
  if (ext === '.docx') {
    const r = extractDocx(buf);
    return { kind: 'text', text: r.text, pages: null };
  }
  if (ext === '.doc') {
    const r = extractDoc(filePath);
    return { kind: 'text', text: r.text, pages: null, note: '已用 LibreOffice 转换' };
  }
  if (TEXT_EXT.has(ext)) {
    const r = extractTextFile(buf);
    return { kind: 'text', text: r.text, pages: null };
  }

  return { kind: 'binary' };
}

export function clampInline(text) {
  if (text.length <= MAX_INLINE_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_INLINE_CHARS), truncated: true };
}
