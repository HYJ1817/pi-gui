// Security preflight, not an OOXML parser. The mature readers only see a fully
// bounded, locally self-contained package that passed the shared ZIP boundary.
import { inspectZip } from './zip-policy.js';

export const OFFICE_LIMITS = Object.freeze({
  fileBytes: 16 * 1024 * 1024,
  csvBytes: 8 * 1024 * 1024,
  entries: 2048,
  entryBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  xmlBytes: 8 * 1024 * 1024,
  xmlNodes: 150000,
  rows: 50000,
  columns: 128,
  cells: 500000,
  sheets: 40,
  slides: 80,
  images: 128,
  imagePixels: 32 * 1024 * 1024,
  totalImagePixels: 64 * 1024 * 1024,
  textChars: 4 * 1024 * 1024,
  parseMs: 20000,
});

export function officeError(code = 'invalid') {
  const error = new Error('Office preview unavailable');
  error.code = code;
  return error;
}

export function xmlText(bytes) {
  // UTF-16 XML can hide a declaration from an ASCII-only preflight. Decode it
  // explicitly, and reject malformed encodings rather than guessing.
  let encoding = 'utf-8';
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)) encoding = 'utf-16le';
  if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)) encoding = 'utf-16be';
  let text;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw officeError('encoding'); }
  if (/<!\s*(?:DOCTYPE|ENTITY)|<\?xml-stylesheet|\u0000/i.test(text)) throw officeError('active-content');
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-f]{1,6});)/i.test(text)) throw officeError('entity');
  return text;
}

export function columnNumber(label) {
  let value = 0;
  for (const char of label.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64;
  return value;
}

/* The one external relationship type ordinary Office documents legitimately
 * carry. Compared as the exact, case-sensitive OPC URI — a namespace whose
 * tail merely resembles "hyperlink" is not this type. */
export const OOXML_HYPERLINK_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

/* Walk one XML tag forward from `<`, honoring quoted attribute values, and
 * return the position of its closing `>`. Shared by every scanner here:
 * regexes like `[^>]*` lie about tags whose attribute values legally contain
 * `>`. Throws closed on an unterminated tag. */
function tagEnd(xml, open) {
  let quote = null;
  for (let cursor = open + 1; cursor < xml.length; cursor++) {
    const ch = xml[cursor];
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return cursor;
  }
  throw officeError('format');
}

/* Read attributes from a tag body with XML lexical rules. Namespace-prefixed
 * attributes are never reported as their unprefixed local name (x:Type is not
 * Type). Input is already entity-decoded by the caller, so values are exactly
 * what the real XML parser will see. */
function tagAttributes(body) {
  const attributes = {};
  const attrPattern = /([A-Za-z][\w.-]*(?::[A-Za-z][\w.-]*)?)\s*=\s*("([^"]*)"|'([^']*)')/g;
  for (const attr of body.matchAll(attrPattern)) {
    if (attr[1].includes(':')) continue;
    if (!(attr[1] in attributes)) attributes[attr[1]] = attr[3] ?? attr[4] ?? '';
  }
  return attributes;
}

/* Quote-aware scanner for `<…Relationship …>` elements in a .rels part. A
 * hand-rolled regex (`[^>]*`) truncates at a `>` inside a quoted attribute
 * value and misreads namespace-prefixed attributes; this scanner walks the
 * tag character by character, honoring quote state, then reads attributes
 * with XML lexical rules (prefixes may contain `-` and `.`). Malformed tags
 * fail closed. */
export function scanRelationshipElements(xml) {
  const results = [];
  let index = 0;
  while (index < xml.length) {
    const open = xml.indexOf('<', index);
    if (open < 0) break;
    if (xml.startsWith('<!--', open)) { const close = xml.indexOf('-->', open); index = close < 0 ? xml.length : close + 3; continue; }
    if (xml.startsWith('<![CDATA[', open)) { const close = xml.indexOf(']]>', open); index = close < 0 ? xml.length : close + 3; continue; }
    if (xml[open + 1] === '?') { const close = xml.indexOf('?>', open); index = close < 0 ? xml.length : close + 2; continue; }
    const nameMatch = /^<((?:[A-Za-z][\w.-]*:)?Relationship)(?=[\s/>])/.exec(xml.slice(open, open + 128));
    // Walk every tag to its real end so a `>` inside an unrelated attribute
    // value cannot hide a later Relationship element in the skipped region.
    const end = tagEnd(xml, open);
    if (!nameMatch) { index = end + 1; continue; }
    const attributes = tagAttributes(xml.slice(open + nameMatch[0].length, end));
    index = end + 1;
    results.push({
      type: attributes.Type || '',
      target: attributes.Target || '',
      mode: attributes.TargetMode || 'Internal',
    });
  }
  return results;
}

function dimensionGuard(xml) {
  let mergeCells = 0, mergeArea = 0;
  for (const match of xml.matchAll(/<(?:\w+:)?col\b[^>]*>/g)) {
    for (const bound of match[0].matchAll(/\b(?:min|max)\s*=\s*["'](\d+)["']/g)) {
      if (Number(bound[1]) > OFFICE_LIMITS.columns) throw officeError('sheet-limit');
    }
  }
  for (const match of xml.matchAll(/<(?:\w+:)?row\b[^>]*\br\s*=\s*["'](\d+)["']/g)) {
    if (Number(match[1]) > OFFICE_LIMITS.rows) throw officeError('sheet-limit');
  }
  for (const match of xml.matchAll(/<(?:\w+:)?mergeCell\b[^>]*\bref\s*=\s*["']([A-Z]+)(\d+):([A-Z]+)(\d+)["']/g)) {
    mergeArea += Math.abs(columnNumber(match[3]) - columnNumber(match[1]) + 1) * Math.abs(Number(match[4]) - Number(match[2]) + 1);
    if (++mergeCells > 2048 || mergeArea > OFFICE_LIMITS.cells) throw officeError('sheet-limit');
  }
  for (const match of xml.matchAll(/\b(?:r|ref)\s*=\s*["']\$?([A-Z]{1,4})\$?(\d+)(?::\$?([A-Z]{1,4})\$?(\d+))?["']/gi)) {
    if (columnNumber(match[1]) > OFFICE_LIMITS.columns || Number(match[2]) > OFFICE_LIMITS.rows
      || (match[3] && (columnNumber(match[3]) > OFFICE_LIMITS.columns || Number(match[4]) > OFFICE_LIMITS.rows))) {
      throw officeError('sheet-limit');
    }
  }
}

function rasterPixels(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0;
  if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (bytes.length >= 10 && String.fromCharCode(...bytes.subarray(0, 6)).match(/^GIF8[79]a$/)) {
    width = view.getUint16(6, true); height = view.getUint16(8, true);
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
      }
      offset += length;
    }
  }
  // Deliberately no SVG/EMF/WMF or unknown image codec: no active markup and
  // no unbounded decoder allocation before dimensions have been established.
  if (!width || !height || width > 8192 || height > 8192 || width * height > OFFICE_LIMITS.imagePixels) {
    throw officeError('image-limit');
  }
  return width * height;
}

export function inspectOffice(bytes, kind, { validateXml } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length > OFFICE_LIMITS.fileBytes
    || !['docx', 'xlsx', 'pptx'].includes(kind)) throw officeError('size');
  const zip = inspectZip(bytes, {
    maxArchiveBytes: OFFICE_LIMITS.fileBytes,
    maxEntries: OFFICE_LIMITS.entries,
    maxEntryBytes: OFFICE_LIMITS.entryBytes,
    maxTotalBytes: OFFICE_LIMITS.totalBytes,
    maxRatio: 200,
  });
  const names = new Set();
  let nodes = 0, pixels = 0, images = 0, slides = 0, sheets = 0, cells = 0, aspect = 16 / 9;
  const required = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[kind];
  for (const entry of zip.entries) {
    const name = entry.name.toLowerCase();
    if (names.has(name)) throw officeError('duplicate');
    names.add(name);
    if (entry.directory) continue;
    if (/(?:^|\/)(?:vbaproject|vbasignature)|\.(?:bin|exe|dll|com|js|html?|mhtml|mht|vbs|ps1)$/i.test(name)
      || /(?:^|\/)(?:embeddings|activex|externallinks|customui)\//.test(name)) throw officeError('active-content');
    // Read every part once: actual inflated lengths/CRC and cumulative budget
    // must be checked before JSZip inside a third-party reader sees the bytes.
    const data = zip.read(entry.name, OFFICE_LIMITS.entryBytes);
    if (/\.(?:xml|rels)$/.test(name)) {
      if (data.length > OFFICE_LIMITS.xmlBytes) throw officeError('xml-limit');
      const rawXml = xmlText(data);
      // The pinned PPTX reader has a small hand-written tokenizer, not a full
      // XML lexer. CDATA and non-prolog PIs can make it scan quoted text as
      // markup despite being well-formed XML. Refuse those unsupported forms
      // in the killable worker before any DOM-dependent PPTX work begins.
      if (kind === 'pptx' && (/<!\[CDATA\[/.test(rawXml) || /<\?(?!xml\s)/i.test(rawXml))) throw officeError('format');
      if (validateXml) validateXml(rawXml);
      // Attribute numbers and defined-name text can contain numeric XML
      // references. The security scan must see the values readers will see.
      const xml = rawXml.replace(/&#(x[\da-f]+|\d+);/gi, (_all, value) => {
        const point = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
        if (!point || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw officeError('entity');
        return String.fromCodePoint(point);
      });
      nodes += (xml.match(/</g) || []).length;
      if (nodes > OFFICE_LIMITS.xmlNodes) throw officeError('xml-limit');
      if (/(?:macroEnabled|vbaProject|oleObject|activeX|attachedTemplate)/i.test(xml)) {
        throw officeError('active-content');
      }
      /* External relationships are classified by their OOXML Type, not rejected
       * wholesale. Ordinary documents routinely carry harmless hyperlinks (a
       * reference or a web address); only those, and only over a network-safe
       * scheme, may survive — and they are never fetched during preview. Every
       * other external target (remote image, template, workbook, data
       * connection, OLE object, or an unknown type) still refuses the package.
       *
       * The scan is quote-aware and namespace-aware rather than regex-shaped:
       * attribute values may legally contain `>`, prefixes may legally contain
       * `-`/`.`, and `x:Type` is not `Type`. The type comparison is the exact
       * OOXML hyperlink relationship URI — the scheme of the URI itself is
       * fixed, but the relationship type string is case-sensitive in OPC. */
      if (name.endsWith('.rels')) {
        for (const rel of scanRelationshipElements(xml)) {
          if (rel.mode !== 'Internal') {
            if (rel.mode !== 'External') throw officeError('external-link');
            if (rel.type !== OOXML_HYPERLINK_TYPE) throw officeError('active-content');
            if (!/^https?:\/\//i.test(rel.target)) throw officeError('external-link');
            continue;
          }
          // Internal targets cannot be a URI, protocol-relative URL or a
          // Windows path. Relative ../ targets are valid package relationships.
          if (/[:\\]|^\s*\/|&#/i.test(rel.target)) throw officeError('external-link');
        }
      } else if (/TargetMode\s*=\s*["']\s*External\s*["']/i.test(xml)) {
        // A TargetMode outside a .rels part is not a package relationship and
        // has no legitimate reading in the supported formats.
        throw officeError('active-content');
      }
      if (name === 'xl/workbook.xml') {
        let namedArea = 0;
        for (const defined of xml.matchAll(/<(?:\w+:)?definedName\b[^>]*>([\s\S]*?)<\//g)) {
          // ExcelJS CellMatrix eagerly materializes every cell in a named
          // range. A tiny name like $A$1:$XFD$1048576 is otherwise a heap bomb.
          for (const range of defined[1].matchAll(/\$(\w+)\$(\d+)(?::\$(\w+)\$(\d+))?/g)) {
            if (!/^[A-Z]{1,3}$/.test(range[1]) || (range[3] && !/^[A-Z]{1,3}$/.test(range[3]))) throw officeError('sheet-limit');
            const left = columnNumber(range[1]), right = columnNumber(range[3] || range[1]);
            const top = Number(range[2]), bottom = Number(range[4] || range[2]);
            namedArea += Math.abs(right - left + 1) * Math.abs(bottom - top + 1);
            if (Math.max(left, right) > OFFICE_LIMITS.columns || Math.max(top, bottom) > OFFICE_LIMITS.rows || namedArea > OFFICE_LIMITS.cells) throw officeError('sheet-limit');
          }
        }
      }
      if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) {
        sheets++;
        dimensionGuard(xml);
        cells += (xml.match(/<(?:\w+:)?c(?:\s|>)/g) || []).length;
      }
      if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) slides++;
      if (name === 'ppt/presentation.xml') {
        // Refuse abnormal slide surfaces before a renderer can allocate an
        // enormous canvas. Attribute order in XML is not significant, so the
        // scan reads cx/cy independently of their positions, quote style and
        // whitespace, and tolerates any namespace prefix on the element.
        let element = null;
        for (const found of xml.matchAll(/<(?:[A-Za-z][\w.-]*:)?sldSz(?=[\s/>])/g)) {
          const end = tagEnd(xml, found.index);
          element = tagAttributes(xml.slice(found.index + found[0].length, end));
          break;
        }
        if (!element || !/^\d+$/.test(element.cx || '') || !/^\d+$/.test(element.cy || '')) throw officeError('slide-size');
        const cx = Number(element.cx), cy = Number(element.cy);
        aspect = cx / cy;
        if (cx < 914400 || cy < 914400 || cx > 36576000 || cy > 36576000 || cx / cy > 4 || cy / cx > 4) throw officeError('slide-size');
      }
    } else if (/(?:^|\/)media\//.test(name) || /^docprops\/thumbnail\.(?:png|jpe?g)$/.test(name)) {
      images++;
      pixels += rasterPixels(data);
      if (images > OFFICE_LIMITS.images || pixels > OFFICE_LIMITS.totalImagePixels) throw officeError('image-limit');
    } else {
      // Unknown part extensions must not be reinterpreted as XML by a library
      // via a forged ContentType/relationship that bypasses XML validation.
      throw officeError('active-content');
    }
  }
  if (!names.has('[content_types].xml') || !names.has('_rels/.rels') || !names.has(required)) throw officeError('format');
  if (sheets > OFFICE_LIMITS.sheets || cells > OFFICE_LIMITS.cells) throw officeError('sheet-limit');
  if (slides < (kind === 'pptx' ? 1 : 0) || slides > OFFICE_LIMITS.slides) throw officeError('slide-limit');
  return { entries: zip.entries.length, sheets, slides, images, aspect };
}
