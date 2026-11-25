/* Self-authored, bounded PresentationML projection. No third-party PPTX reader.
 * ECMA-376 / DrawingML: package relationships, ordered sldIdLst, xfrm, sp/pic.
 * Only data leaves the killable Office worker; no document markup is rendered. */
import { inspectZip } from './zip-policy.js';
import { OFFICE_LIMITS, officeError, xmlText } from './office-policy.js';
import { projectSlideShapes } from './pptx-shapes.js';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const children = (element, namespace, name) => Array.from(element?.childNodes || []).filter(n => n.nodeType === 1 && n.namespaceURI === namespace && n.localName === name);
const child = (element, namespace, name) => children(element, namespace, name)[0] || null;
const first = (element, namespace, name) => element?.getElementsByTagNameNS(namespace, name)?.item(0) || null;
const attr = (element, name) => element?.getAttribute(name) || '';

function targetPath(part, target) {
  if (!target || /[:\\\u0000-\u001f]|^\//.test(target)) throw officeError('external-link');
  const pieces = part.split('/').slice(0, -1);
  for (const value of target.split('/')) {
    if (!value || value === '.') continue;
    if (value === '..') { if (!pieces.length) throw officeError('format'); pieces.pop(); }
    else pieces.push(value);
  }
  return pieces.join('/');
}

export function projectPptx(bytes, DOMParser, expectedSlides) {
  const zip = inspectZip(bytes, { maxArchiveBytes: OFFICE_LIMITS.fileBytes, maxEntries: OFFICE_LIMITS.entries,
    maxEntryBytes: OFFICE_LIMITS.entryBytes, maxTotalBytes: OFFICE_LIMITS.totalBytes, maxRatio: 200 });
  const names = new Set(zip.entries.map(entry => entry.name));
  const documents = new Map(), relationships = new Map(), images = new Map();
  const budget = { shapes: 0, text: 0, unsupported: 0 };
  function xml(name) {
    if (documents.has(name)) return documents.get(name);
    if (!names.has(name) || !/\.(xml|rels)$/.test(name)) throw officeError('format');
    const data = zip.read(name, OFFICE_LIMITS.xmlBytes);
    let invalid = false;
    const document = new DOMParser({ onError() { invalid = true; throw officeError('format'); } }).parseFromString(xmlText(data), 'application/xml');
    if (invalid || !document?.documentElement) throw officeError('format');
    documents.set(name, document.documentElement); return document.documentElement;
  }
  function rels(part) {
    if (relationships.has(part)) return relationships.get(part);
    const slash = part.lastIndexOf('/');
    const relPath = part.slice(0, slash + 1) + '_rels/' + part.slice(slash + 1) + '.rels';
    const result = new Map();
    if (names.has(relPath)) for (const item of children(xml(relPath), REL, 'Relationship')) {
      const id = attr(item, 'Id'), target = attr(item, 'Target'), type = attr(item, 'Type');
      const mode = attr(item, 'TargetMode') || 'Internal';
      if (!id || result.has(id)) throw officeError('external-link');
      if (mode !== 'Internal') {
        /* The preflight already classified external relationships: only a
         * network-safe hyperlink survived, and it is text, not a resource.
         * It is never resolved into the package or fetched, so it simply is
         * not registered as an internal part. Anything else the preflight let
         * through by mistake still fails closed here. */
        if (type.split('/').pop().toLowerCase() !== 'hyperlink' || !/^https?:\/\//i.test(target)) throw officeError('external-link');
        continue;
      }
      const resolved = targetPath(part, target);
      if (!names.has(resolved)) throw officeError('format');
      result.set(id, { target: resolved, type });
    }
    relationships.set(part, result); return result;
  }
  function related(part, suffix) { return [...rels(part).values()].find(item => item.type === R + '/' + suffix)?.target || null; }
  function image(part, id) {
    const relationship = rels(part).get(id);
    if (!relationship || relationship.type !== R + '/image' || !/^ppt\/media\//.test(relationship.target)) throw officeError('image-limit');
    const name = relationship.target;
    if (!images.has(name)) {
      const data = zip.read(name, OFFICE_LIMITS.entryBytes);
      const mime = data[0] === 137 && data[1] === 80 ? 'image/png' : data[0] === 255 && data[1] === 216 ? 'image/jpeg' : String.fromCharCode(...data.subarray(0, 3)) === 'GIF' ? 'image/gif' : '';
      if (!mime || images.size >= OFFICE_LIMITS.images) throw officeError('image-limit');
      images.set(name, { mime, bytes: data });
    }
    return name;
  }
  const presentation = xml('ppt/presentation.xml');
  if (presentation.namespaceURI !== P || presentation.localName !== 'presentation') throw officeError('format');
  const dimensions = child(presentation, P, 'sldSz');
  const cx = Number(attr(dimensions, 'cx')), cy = Number(attr(dimensions, 'cy'));
  if (!(cx >= 914400 && cy >= 914400 && cx <= 36576000 && cy <= 36576000 && cx / cy <= 4 && cy / cx <= 4)) throw officeError('slide-size');
  const scale = 960 / cx;
  const slides = [];
  const defaultColors = { dk1: '#000000', lt1: '#ffffff', dk2: '#1f497d', lt2: '#eeece1', accent1: '#4f81bd', accent2: '#c0504d', accent3: '#9bbb59', accent4: '#8064a2', accent5: '#4bacc6', accent6: '#f79646' };
  for (const id of children(child(presentation, P, 'sldIdLst'), P, 'sldId')) {
    if (slides.length >= OFFICE_LIMITS.slides) throw officeError('slide-limit');
    const relation = rels('ppt/presentation.xml').get(id.getAttributeNS(R, 'id'));
    if (!relation || relation.type !== R + '/slide') throw officeError('format');
    const slidePart = relation.target, slide = xml(slidePart);
    if (slide.namespaceURI !== P || slide.localName !== 'sld') throw officeError('format');
    const layoutPart = related(slidePart, 'slideLayout');
    const masterPart = layoutPart && related(layoutPart, 'slideMaster');
    const themePart = (masterPart && related(masterPart, 'theme')) || related('ppt/presentation.xml', 'theme');
    const colors = { ...defaultColors };
    if (themePart) for (const entry of Array.from(first(xml(themePart), A, 'clrScheme')?.childNodes || [])) {
      if (entry.nodeType !== 1 || entry.namespaceURI !== A) continue;
      const value = attr(child(entry, A, 'srgbClr'), 'val') || attr(child(entry, A, 'sysClr'), 'lastClr');
      if (/^[\da-f]{6}$/i.test(value)) colors[entry.localName] = '#' + value;
    }
    const layers = [masterPart, layoutPart, slidePart].filter(Boolean).map(part => ({ part, root: xml(part) }));
    const colorMap = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
    for (const layer of layers) {
      const map = child(layer.root, P, 'clrMap') || first(layer.root, A, 'overrideClrMapping');
      if (map) for (const name of Object.keys(colorMap)) if (attr(map, name)) colorMap[name] = attr(map, name);
    }
    const context = { P, A, R, children, child, first, attr, colors, colorMap, scale, budget, image };
    let background = '#ffffff';
    const shapes = [];
    // Static master/layout artwork is inherited; placeholders are matched by
    // type/index for missing slide geometry, not duplicated as visible text.
    const placeholders = new Map();
    for (const layer of layers) {
      const common = child(layer.root, P, 'cSld'), tree = child(common, P, 'spTree');
      const bg = child(common, P, 'bg');
      if (bg) background = projectSlideShapes.background(bg, context) || background;
      const projected = projectSlideShapes(tree, layer.part, context, placeholders, layer.part === slidePart);
      if (layer.part === slidePart || attr(slide, 'showMasterSp') !== '0') shapes.push(...projected);
    }
    slides.push({ background, shapes });
  }
  if (!slides.length || slides.length !== expectedSlides) throw officeError('slide-limit');
  return { width: 960, height: cy * scale, slides, images: Object.fromEntries(images), unsupported: budget.unsupported };
}
