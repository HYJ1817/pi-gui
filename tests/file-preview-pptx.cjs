'use strict';
// Self-authored PresentationML fixtures, not a vendor PPTX implementation.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { pptxParts, zipParts, PNG } = require('./file-preview-office.cjs');
const ROOT = path.resolve(__dirname, '..');
const load = import(pathToFileURL(path.join(ROOT, 'public/file-preview/office-parse.js')));
const parse = async parts => (await (await load).parseOffice('pptx', zipParts(parts))).deck;
const slidePath = 'ppt/slides/slide1.xml';
const masterPath = 'ppt/slideMasters/slideMaster1.xml';
const layoutPath = 'ppt/slideLayouts/slideLayout1.xml';
const firstShape = parts => parts[slidePath].match(/<p:sp>[\s\S]*?<\/p:sp>/)[0];
const inject = (parts, part, shape) => { parts[part] = parts[part].replace('</p:spTree>', shape + '</p:spTree>'); };
const text = slide => slide.shapes.flatMap(shape => shape.text?.paragraphs.flatMap(p => p.runs.map(r => r.text)) || []).join('\n');
function inheritedFixture() {
  const parts = pptxParts(), shape = firstShape(parts);
  const placeholder = shape.replace('<p:nvPr/>', '<p:nvPr><p:ph type="title" idx="7"/></p:nvPr>');
  inject(parts, masterPath, placeholder.replace('第 1 页 / Slide 1', 'Master placeholder'));
  inject(parts, layoutPath, placeholder.replace(/<a:xfrm>[\s\S]*?<\/a:xfrm>/, '').replace('第 1 页 / Slide 1', 'Layout placeholder'));
  parts[slidePath] = parts[slidePath].replace(shape, placeholder.replace(/<a:xfrm>[\s\S]*?<\/a:xfrm>/, '').replace('<a:rPr lang="zh-CN" sz="2400">', '<a:rPr lang="zh-CN">'));
  return parts;
}

test('independent projection retains real page, shape, text and raster data', async () => {
  const deck = await parse(pptxParts());
  assert.equal(deck.width, 960); assert.equal(deck.height, 540);
  assert.equal(deck.slides.length, 2); assert.equal(deck.slides[0].shapes.length, 3);
  const shape = deck.slides[0].shapes[0];
  assert.equal(shape.geometry, 'rect'); assert.equal(shape.fill, '#1c5d99');
  assert.equal(shape.width, 768); assert.equal(shape.height, 96);
  assert.deepEqual(shape.matrix, [1, 0, 0, 1, 48, 48]);
  assert.match(text(deck.slides[0]), /中文文本与真实布局/);
  assert.deepEqual(Buffer.from(deck.images['ppt/media/image1.png'].bytes), PNG);
  assert.equal(deck.unsupported, 0);
});

test('sldIdLst relationship order wins over ZIP or lexical slide order', async () => {
  const parts = pptxParts();
  parts['ppt/presentation.xml'] = parts['ppt/presentation.xml'].replace('id="256" r:id="rId2"', 'id="256" r:id="rId3"').replace('id="257" r:id="rId3"', 'id="257" r:id="rId2"');
  const deck = await parse(parts);
  assert.match(text(deck.slides[0]), /Slide 2/); assert.match(text(deck.slides[1]), /Slide 1/);
});

test('master-layout-slide placeholder chain inherits missing geometry', async () => {
  const deck = await parse(inheritedFixture());
  const shape = deck.slides[0].shapes.find(value => value.text && text({ shapes: [value] }).includes('Slide 1'));
  assert.ok(shape); assert.equal(shape.width, 768); assert.deepEqual(shape.matrix.slice(4), [48, 48]);
  assert.doesNotMatch(text(deck.slides[0]), /Master placeholder|Layout placeholder/);
});

test('static master artwork precedes slide artwork in z-order', async () => {
  const parts = pptxParts(); inject(parts, masterPath, firstShape(parts).replace('Slide 1', 'Master artwork'));
  const deck = await parse(parts);
  assert.match(text({ shapes: [deck.slides[0].shapes[0]] }), /Master artwork/);
  assert.match(text({ shapes: [deck.slides[0].shapes[1]] }), /Slide 1/);
});

test('showMasterSp=false removes inherited artwork but not slide content', async () => {
  const parts = pptxParts(); inject(parts, masterPath, firstShape(parts).replace('Slide 1', 'Master artwork'));
  parts[slidePath] = parts[slidePath].replace('<p:sld ', '<p:sld showMasterSp="0" ');
  const deck = await parse(parts);
  assert.doesNotMatch(text(deck.slides[0]), /Master artwork/); assert.match(text(deck.slides[0]), /Slide 1/);
});

test('theme colors and color-map overrides are resolved without CSS injection', async () => {
  const parts = pptxParts();
  parts[slidePath] = parts[slidePath].replace('<a:srgbClr val="1C5D99"/>', '<a:schemeClr val="accent1"/>');
  parts['ppt/theme/theme1.xml'] = parts['ppt/theme/theme1.xml'].replace('<a:accent1><a:srgbClr val="1C5D99"/>', '<a:accent1><a:srgbClr val="AABBCC"/>');
  assert.equal((await parse(parts)).slides[0].shapes[0].fill, '#aabbcc');
});

test('group child coordinate transform composes scale and translation', async () => {
  const parts = pptxParts(), shape = firstShape(parts);
  const group = '<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="3657600" cy="1828800"/><a:chOff x="0" y="0"/><a:chExt cx="7315200" cy="3657600"/></a:xfrm></p:grpSpPr>' + shape + '</p:grpSp>';
  parts[slidePath] = parts[slidePath].replace(shape, group);
  const item = (await parse(parts)).slides[0].shapes[0];
  assert.deepEqual(item.matrix, [.5, 0, 0, .5, 120, 120]);
});

test('shape rotation, flip, rich text and description stay bounded data', async () => {
  const parts = pptxParts();
  parts[slidePath] = parts[slidePath].replace('<a:xfrm>', '<a:xfrm rot="5400000" flipH="1">').replace('name="Text 2"', 'name="Text 2" descr="描述"').replace('lang="zh-CN" sz="2400"', 'lang="zh-CN" sz="2400" b="1" i="1" u="sng"');
  const shape = (await parse(parts)).slides[0].shapes[0];
  assert.ok(shape.matrix.every(Number.isFinite)); assert.equal(shape.description, '描述');
  const run = shape.text.paragraphs[0].runs[0];
  assert.equal(run.size, 32); assert.ok(run.bold && run.italic && run.underline);
});

test('image crop remains local raster identity and bounded geometry', async () => {
  const parts = pptxParts();
  parts[slidePath] = parts[slidePath].replace('<a:stretch>', '<a:srcRect l="10000" r="20000"/><a:stretch>');
  const item = (await parse(parts)).slides[0].shapes[2];
  assert.equal(item.kind, 'image'); assert.deepEqual(item.crop, { l: .1, t: 0, r: .2, b: 0 });
});

test('actual unsupported geometry is flagged rather than silently faked', async () => {
  const parts = pptxParts(); parts[slidePath] = parts[slidePath].replace('prst="rect"', 'prst="cloud"');
  const deck = await parse(parts); assert.equal(deck.unsupported, 1); assert.equal(deck.slides[0].shapes[0].geometry, 'unsupported');
});

test('encoded HTML text stays text in the worker model', async () => {
  const parts = pptxParts(); parts[slidePath] = parts[slidePath].replace('第 1 页 / Slide 1', '&lt;img src=x onerror=alert(1)&gt;');
  const deck = await parse(parts); assert.match(text(deck.slides[0]), /<img src=x onerror=alert\(1\)>/);
  assert.equal(deck.slides[0].shapes.filter(value => value.kind === 'image').length, 1);
});

for (const [label, mutate] of [
  ['missing slide relationship', p => { p['ppt/presentation.xml'] = p['ppt/presentation.xml'].replace('r:id="rId2"', 'r:id="missing"'); }],
  ['duplicate relationship id', p => { p['ppt/slides/_rels/slide1.xml.rels'] = p['ppt/slides/_rels/slide1.xml.rels'].replace('Id="rId2"', 'Id="rId1"'); }],
  ['negative dimension', p => { p[slidePath] = p[slidePath].replace('cx="7315200"', 'cx="-1"'); }],
  ['nonfinite coordinate', p => { p[slidePath] = p[slidePath].replace('x="457200"', 'x="NaN"'); }],
  ['oversized transform', p => { p[slidePath] = p[slidePath].replace('x="457200"', 'x="99999999999999"'); }],
  ['empty crop area', p => { p[slidePath] = p[slidePath].replace('<a:stretch>', '<a:srcRect l="80000" r="80000"/><a:stretch>'); }],
  ['wrong image relationship type', p => { p['ppt/slides/_rels/slide1.xml.rels'] = p['ppt/slides/_rels/slide1.xml.rels'].replace('/image"', '/hyperlink"'); }],
  ['relationship traversal', p => { p['ppt/slides/_rels/slide1.xml.rels'] = p['ppt/slides/_rels/slide1.xml.rels'].replace('../media/image1.png', '../../../../outside.png'); }],
  ['external raster relationship', p => { p['ppt/slides/_rels/slide1.xml.rels'] = p['ppt/slides/_rels/slide1.xml.rels'].replace('../media/image1.png', 'https://invalid.example/leak'); }],
]) test(label + ' is rejected before frame rendering', async () => { const parts = pptxParts(); mutate(parts); await assert.rejects(parse(parts)); });

/* F4: slide dimensions must be read independent of XML attribute order, quote
 * style, whitespace and namespace prefix — order is not significant in XML. */
for (const [label, sldSz] of [
  ['canonical cx-then-cy', '<p:sldSz cx="9144000" cy="5143500"/>'],
  ['reversed cy-then-cx', '<p:sldSz cy="5143500" cx="9144000"/>'],
  ['single-quoted reversed', "<p:sldSz cy='5143500' cx='9144000'/>"],
  ['extra whitespace and other attrs', '<p:sldSz  type="screen16x9"   cy="5143500"   cx="9144000"  />'],
]) test('slide size parsed independent of attribute order: ' + label, async () => {
  const parts = pptxParts();
  parts['ppt/presentation.xml'] = parts['ppt/presentation.xml'].replace(/<p:sldSz[^>]*\/>/, sldSz);
  const deck = await parse(parts);
  assert.equal(deck.width, 960); assert.equal(deck.height, 540);
});

test('malformed slide size still rejected regardless of attribute order', async () => {
  for (const bad of ['<p:sldSz cy="5143500"/>', '<p:sldSz cx="9144000"/>', '<p:sldSz cx="100" cy="5143500"/>', '<p:sldSz cy="100" cx="9144000"/>']) {
    const parts = pptxParts();
    parts['ppt/presentation.xml'] = parts['ppt/presentation.xml'].replace(/<p:sldSz[^>]*\/>/, bad);
    await assert.rejects(parse(parts));
  }
});

/* F5: a plain network hyperlink in slide relationships is inert text, never a
 * fetched resource, so it must not reject the whole deck. */
test('plain hyperlink relationship in slide rels does not reject the deck', async () => {
  const parts = pptxParts();
  parts['ppt/slides/_rels/slide1.xml.rels'] = parts['ppt/slides/_rels/slide1.xml.rels'].replace('</Relationships>',
    '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/reference" TargetMode="External"/></Relationships>');
  const deck = await parse(parts);
  assert.equal(deck.slides.length, 2);
  // No remote fetch occurs: the hyperlink is never resolved as a package part.
  assert.equal(deck.images['ppt/media/image1.png'] !== undefined, true);
});

test('non-hyperlink external relationship in slide rels is still rejected', async () => {
  const parts = pptxParts();
  parts['ppt/slides/_rels/slide1.xml.rels'] = parts['ppt/slides/_rels/slide1.xml.rels'].replace('</Relationships>',
    '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://invalid.example/leak.png" TargetMode="External"/></Relationships>');
  await assert.rejects(parse(parts));
});

/* F6: everyday list/paragraph structure is projected, not dropped. The model
 * carries bullet/auto-number markers, indent levels, hanging indents, spacing
 * and East-Asian font fallback so ordinary decks do not lose their lists. */
test('bullet and auto-number markers are projected with indent level', async () => {
  const parts = pptxParts();
  const list = '<p:sp><p:nvSpPr><p:cNvPr id="30" name="List"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="3000000"/><a:ext cx="7315200" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>' +
    '<a:p><a:pPr marL="342900" indent="-342900" lvl="0"><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>项目一</a:t></a:r></a:p>' +
    '<a:p><a:pPr marL="685800" indent="-342900" lvl="1"><a:buChar char="◦"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>子项目</a:t></a:r></a:p>' +
    '<a:p><a:pPr marL="342900" indent="-342900" lvl="0"><a:buAutoNum type="arabicPeriod" startAt="1"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>编号项</a:t></a:r></a:p>' +
    '</p:txBody></p:sp>';
  inject(parts, slidePath, list);
  const deck = await parse(parts);
  const shape = deck.slides[0].shapes.find(item => item.text?.paragraphs.some(pp => pp.marker));
  assert.ok(shape, 'list shape projected');
  const [bullet, sub, numbered] = shape.text.paragraphs;
  assert.deepEqual(bullet.marker, { kind: 'bullet', char: '•' });
  assert.equal(bullet.level, 0); assert.equal(sub.level, 1);
  assert.equal(numbered.marker.kind, 'number'); assert.equal(numbered.marker.start, 1);
  assert.ok(bullet.marL > 0, 'marL projected'); assert.ok(bullet.indent < 0, 'hanging indent projected');
});

test('paragraph spacing and East-Asian font fallback are projected', async () => {
  const parts = pptxParts();
  const spaced = '<p:sp><p:nvSpPr><p:cNvPr id="31" name="Spaced"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="5000000"/><a:ext cx="7315200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>' +
    '<a:p><a:pPr><a:spcBef><a:spcPts val="1200"/></a:spcBef><a:spcAft><a:spcPts val="600"/></a:spcAft></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"><a:ea typeface="微软雅黑"/></a:rPr><a:t>中文</a:t></a:r></a:p>' +
    '</p:txBody></p:sp>';
  inject(parts, slidePath, spaced);
  const deck = await parse(parts);
  const shape = deck.slides[0].shapes.find(item => item.text?.paragraphs.some(pp => pp.spacing?.before > 0));
  assert.ok(shape, 'spaced paragraph projected');
  assert.ok(shape.text.paragraphs[0].spacing.before > 0);
  assert.ok(shape.text.paragraphs[0].spacing.after > 0);
  assert.equal(shape.text.paragraphs[0].runs[0].eastFamily, '微软雅黑');
});
