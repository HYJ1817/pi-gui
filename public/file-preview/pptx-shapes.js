/* DrawingML data projection only. Never copies OOXML markup/CSS into the DOM. */
import { OFFICE_LIMITS, officeError } from './office-policy.js';
const IDENTITY = [1, 0, 0, 1, 0, 0];
function multiply(a, b) {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
function number(value, fallback = 0, maximum = 36576000) {
  if (value === '' || value === null || value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isFinite(result) || Math.abs(result) > maximum) throw officeError('slide-size');
  return result;
}
function color(element, ctx) {
  const { child, attr, A, colors, colorMap } = ctx;
  let source = child(element, A, 'srgbClr');
  let value = attr(source, 'val');
  if (!source) {
    source = child(element, A, 'schemeClr');
    const name = attr(source, 'val'); value = (colors[colorMap[name] || name] || '').slice(1);
  }
  if (!source) { source = child(element, A, 'sysClr'); value = attr(source, 'lastClr'); }
  if (!/^[\da-f]{6}$/i.test(value)) return null;
  const channels = [0, 2, 4].map(offset => parseInt(value.slice(offset, offset + 2), 16));
  let opacity = 1;
  for (const transform of Array.from(source.childNodes || [])) {
    if (transform.nodeType !== 1 || transform.namespaceURI !== A) continue;
    const fraction = Math.max(0, Math.min(1, number(attr(transform, 'val'), 100000, 1000000) / 100000));
    if (transform.localName === 'alpha') opacity = fraction;
    else if (['tint', 'lumOff'].includes(transform.localName)) channels.forEach((v, i) => { channels[i] = transform.localName === 'tint' ? v + (255 - v) * fraction : v + 255 * fraction; });
    else if (['shade', 'lumMod'].includes(transform.localName)) channels.forEach((v, i) => { channels[i] = v * fraction; });
  }
  return '#' + channels.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('') + (opacity < 1 ? Math.round(opacity * 255).toString(16).padStart(2, '0') : '');
}
function paint(properties, ctx) {
  if (ctx.child(properties, ctx.A, 'noFill')) return null;
  const solid = ctx.child(properties, ctx.A, 'solidFill');
  if (solid) return color(solid, ctx);
  const gradient = ctx.child(properties, ctx.A, 'gradFill');
  if (gradient) { ctx.budget.unsupported++; return color(ctx.first(gradient, ctx.A, 'gs'), ctx); }
  return null;
}
function xfrm(properties, ctx, fallback) { return ctx.child(properties, ctx.A, 'xfrm') || fallback || null; }
function transform(element, ctx) {
  const { child, attr, A, scale } = ctx;
  const off = child(element, A, 'off'), ext = child(element, A, 'ext');
  const x = number(attr(off, 'x')) * scale, y = number(attr(off, 'y')) * scale;
  const width = number(attr(ext, 'cx')) * scale, height = number(attr(ext, 'cy')) * scale;
  if (width < 0 || height < 0) throw officeError('slide-size');
  const rotation = number(attr(element, 'rot'), 0, 216000000) / 60000 * Math.PI / 180;
  const sx = attr(element, 'flipH') === '1' || attr(element, 'flipH') === 'true' ? -1 : 1;
  const sy = attr(element, 'flipV') === '1' || attr(element, 'flipV') === 'true' ? -1 : 1;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  const rotate = [cos*sx, sin*sx, -sin*sy, cos*sy, 0, 0];
  const matrix = multiply(multiply([1,0,0,1,x+width/2,y+height/2], rotate), [1,0,0,1,-width/2,-height/2]);
  return { width, height, matrix };
}
function placeholder(shape, ctx) {
  const ph = ctx.first(shape, ctx.P, 'ph');
  return ph ? { index: ctx.attr(ph, 'idx') || '0', type: ctx.attr(ph, 'type') || 'obj' } : null;
}
function font(properties, ctx, inherited = {}) {
  const result = { ...inherited };
  const { attr, child, A } = ctx;
  if (!properties) return result;
  if (attr(properties, 'sz')) result.size = Math.max(1, Math.min(600, number(attr(properties, 'sz'), 1800, 400000) / 100 * (12700 * ctx.scale)));
  for (const [source, target] of [['b', 'bold'], ['i', 'italic']]) if (attr(properties, source)) result[target] = ['1', 'true'].includes(attr(properties, source));
  if (attr(properties, 'u')) result.underline = !['none', '0', 'false'].includes(attr(properties, 'u'));
  const fill = paint(properties, ctx); if (fill) result.color = fill;
  const typeface = attr(child(properties, A, 'latin'), 'typeface');
  if (/^[\p{L}\p{N} _.+-]{1,80}$/u.test(typeface)) result.family = typeface;
  return result;
}
function text(shape, inherited, ctx) {
  const { child, children, first, attr, A, P } = ctx;
  const body = child(shape, P, 'txBody'); if (!body) return null;
  const inheritedBodies = inherited.map(value => child(value, P, 'txBody')).filter(Boolean);
  const bodyProperties = [body, ...inheritedBodies].map(value => child(value, A, 'bodyPr')).filter(Boolean);
  const bodyAttr = name => bodyProperties.map(value => attr(value, name)).find(Boolean) || '';
  const baseFont = { size: 18 * 12700 * ctx.scale, color: ctx.colors[ctx.colorMap.tx1] || '#000000' };
  const defaultFont = [...inheritedBodies].reverse().reduce((value, inheritedBody) => font(first(inheritedBody, A, 'defRPr'), ctx, value), baseFont);
  /* East-Asian typeface is a separate attribute in DrawingML; without it a
   * Chinese run falls back to the Latin face even though the document named a
   * proper CJK font. Latin is still the primary face for Latin text. */
  const eaTypeface = properties => attr(child(properties, A, 'ea'), 'typeface');
  const paragraphs = children(body, A, 'p').map(paragraph => {
    const pPr = child(paragraph, A, 'pPr');
    const paragraphFont = font(child(pPr, A, 'defRPr'), ctx, defaultFont);
    const alignment = { ctr: 'center', r: 'right', just: 'justify', l: 'left' }[attr(pPr, 'algn')] || 'left';
    /* Common list/paragraph structure: bullet or auto-number, indentation level
     * and the hanging indent geometry. These are ordinary in everyday decks. */
    const level = Math.max(0, Math.min(8, number(attr(pPr, 'lvl'), 0, 8)));
    const marL = Math.max(0, number(attr(pPr, 'marL'), 0, 36576000) * ctx.scale);
    const indent = number(attr(pPr, 'indent'), 0, 36576000) * ctx.scale;
    let marker = null;
    if (!child(pPr, A, 'buNone')) {
      const bulletChar = attr(child(pPr, A, 'buChar'), 'char');
      const autoNum = child(pPr, A, 'buAutoNum');
      if (bulletChar) marker = { kind: 'bullet', char: [...bulletChar].slice(0, 4).join('') };
      else if (autoNum) {
        const format = attr(autoNum, 'type') || 'arabicPeriod';
        /* Whether startAt was written matters: an explicit startAt — even 1 —
         * is exactly how PowerPoint encodes "restart numbering here", while a
         * paragraph without one continues the level's counter. A malformed
         * startAt must not kill the whole document: the numbering degrades to
         * a continuation at 1, which is how office software treats corrupt
         * list markup — degrading the marker, not the deck. */
        let start = 1, explicitStart = false;
        const rawStart = attr(autoNum, 'startAt');
        if (rawStart !== '') {
          const parsed = Number(rawStart);
          /* ECMA-376 types startAt as a positive decimal (minimum 1): a written
           * but out-of-range value is invalid markup. Office software treats the
           * restart *intent* as present and clamps the value into the valid range
           * rather than silently dropping the attribute — so startAt="0" renders
           * as a restart at 1, not a continuation. Clamping here keeps the
           * projection honest: the value the renderer uses is the value the
           * projection carries, and explicitStart stays true because the document
           * did write a startAt. A non-numeric startAt carries no usable intent
           * and degrades to a continuation, exactly the malformed-markup rule
           * the comment above describes. */
          if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 32767) {
            start = Math.max(1, parsed); explicitStart = true;
          }
        }
        marker = { kind: 'number', format, start, explicitStart };
      } else if (child(pPr, A, 'buFont')) marker = { kind: 'bullet', char: '•' };
    }
    const spacing = {
      before: Math.max(0, number(attr(child(child(pPr, A, 'spcBef'), A, 'spcPts'), 'val'), 0, 400000) / 100 * (12700 * ctx.scale)),
      after: Math.max(0, number(attr(child(child(pPr, A, 'spcAft'), A, 'spcPts'), 'val'), 0, 400000) / 100 * (12700 * ctx.scale)),
    };
    const runs = [];
    for (const item of Array.from(paragraph.childNodes || [])) {
      if (item.nodeType !== 1 || item.namespaceURI !== A) continue;
      if (item.localName === 'br') { runs.push({ text: '\n', ...paragraphFont }); continue; }
      if (!['r', 'fld'].includes(item.localName)) continue;
      const value = child(item, A, 't')?.textContent || '';
      ctx.budget.text += value.length;
      if (ctx.budget.text > OFFICE_LIMITS.textChars) throw officeError('size');
      const runFont = font(child(item, A, 'rPr'), ctx, paragraphFont);
      const east = eaTypeface(child(item, A, 'rPr')) || eaTypeface(child(pPr, A, 'defRPr'));
      /* The East-Asian face participates whenever the document named one,
       * whether or not a Latin face exists — Latin handles the ASCII runs,
       * the EA face is the script-correct fallback for CJK text. */
      if (/^[\p{L}\p{N} _.+-]{1,80}$/u.test(east)) runFont.eastFamily = east;
      runs.push({ text: value, ...runFont });
    }
    return { alignment, runs, level, marL, indent, marker, spacing };
  });
  const margins = {};
  for (const [side, name] of [['left','lIns'],['top','tIns'],['right','rIns'],['bottom','bIns']]) margins[side] = Math.max(0, number(bodyAttr(name), side === 'left' || side === 'right' ? 91440 : 45720) * ctx.scale);
  return { paragraphs, margins, anchor: { ctr: 'center', b: 'end', t: 'start' }[bodyAttr('anchor')] || 'start', wrap: bodyAttr('wrap') !== 'none' };
}

export function projectSlideShapes(tree, part, ctx, placeholders, isSlide) {
  const result = [];
  const { children, child, first, attr, P, A } = ctx;
  function visit(parent, matrix, depth) {
    if (depth > 16) throw officeError('xml-limit');
    for (const shape of Array.from(parent?.childNodes || [])) {
      if (shape.nodeType !== 1 || shape.namespaceURI !== P) continue;
      if (['nvGrpSpPr', 'grpSpPr', 'extLst'].includes(shape.localName)) continue;
      if (++ctx.budget.shapes > 4000) throw officeError('slide-limit');
      if (shape.localName === 'grpSp') {
        const group = xfrm(child(shape, P, 'grpSpPr'), ctx);
        const geometry = transform(group, ctx);
        const offset = child(group, A, 'chOff'), extent = child(group, A, 'chExt');
        const cx = number(attr(extent, 'cx')) * ctx.scale, cy = number(attr(extent, 'cy')) * ctx.scale;
        if (!(cx > 0 && cy > 0)) throw officeError('slide-size');
        const sx = geometry.width / cx, sy = geometry.height / cy;
        if (sx > 100 || sy > 100) throw officeError('slide-size');
        const coordinate = [sx,0,0,sy,-number(attr(offset,'x'))*ctx.scale*sx,-number(attr(offset,'y'))*ctx.scale*sy];
        visit(shape, multiply(matrix, multiply(geometry.matrix, coordinate)), depth + 1); continue;
      }
      if (!['sp', 'pic', 'cxnSp'].includes(shape.localName)) { ctx.budget.unsupported++; continue; }
      const ph = placeholder(shape, ctx);
      const key = ph && ph.type + ':' + ph.index;
      const inherited = (key && (placeholders.get(key) || placeholders.get('idx:' + ph.index) || placeholders.get('type:' + ph.type))) || [];
      const properties = child(shape, P, 'spPr');
      const inheritedTransform = inherited.map(value => xfrm(child(value, P, 'spPr'), ctx)).find(Boolean);
      const geometry = transform(xfrm(properties, ctx, inheritedTransform), ctx);
      if (!isSlide && ph) {
        const chain = [shape, ...inherited];
        placeholders.set(key, chain); placeholders.set('idx:' + ph.index, chain); placeholders.set('type:' + ph.type, chain); continue;
      }
      if (!geometry.width && !geometry.height) continue;
      const item = { kind: 'shape', width: geometry.width, height: geometry.height, matrix: multiply(matrix, geometry.matrix) };
      if (!item.matrix.every(v => Number.isFinite(v) && Math.abs(v) <= 100000)) throw officeError('slide-size');
      const description = first(shape, P, 'cNvPr'); item.description = attr(description, 'descr').slice(0, 1024);
      if (shape.localName === 'pic') {
        const blipFill = child(shape, P, 'blipFill');
        const blip = child(blipFill, A, 'blip');
        item.kind = 'image'; item.image = ctx.image(part, blip?.getAttributeNS(ctx.R, 'embed'));
        const crop = child(blipFill, A, 'srcRect'); item.crop = {};
        for (const side of ['l', 't', 'r', 'b']) item.crop[side] = Math.max(0, Math.min(.99, number(attr(crop, side), 0, 100000) / 100000));
        if (item.crop.l + item.crop.r >= 1 || item.crop.t + item.crop.b >= 1) throw officeError('image-limit');
      } else {
        const style = child(shape, P, 'style');
        item.fill = paint(properties, ctx) || (!child(properties, A, 'noFill') && color(child(style, A, 'fillRef'), ctx)) || null;
        const line = child(properties, A, 'ln');
        item.stroke = paint(line, ctx) || (!child(line, A, 'noFill') && color(child(style, A, 'lnRef'), ctx)) || null;
        item.strokeWidth = Math.min(32, Math.max(0, number(attr(line, 'w'), 12700) * ctx.scale));
        item.geometry = shape.localName === 'cxnSp' ? 'line' : attr(child(properties, A, 'prstGeom'), 'prst') || 'rect';
        if (!['rect','roundRect','ellipse','triangle','rtTriangle','diamond','line'].includes(item.geometry) || child(properties, A, 'custGeom')) { ctx.budget.unsupported++; item.geometry = 'unsupported'; }
        item.text = text(shape, inherited, ctx);
      }
      result.push(item);
    }
  }
  visit(tree, IDENTITY, 0); return result;
}
projectSlideShapes.background = (bg, ctx) => paint(ctx.child(bg, ctx.P, 'bgPr'), ctx) || color(ctx.child(bg, ctx.P, 'bgRef'), ctx);
