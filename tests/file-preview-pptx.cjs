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
  ['unprefixed element name', '<sldSz xmlns="http://schemas.openxmlformats.org/presentationml/2006/main" cx="9144000" cy="5143500"/>'],
  ['namespaced prefix with dash', '<p-x:sldSz xmlns:p-x="http://schemas.openxmlformats.org/presentationml/2006/main" cx="9144000" cy="5143500"/>'],
  ['entity-encoded gt in unrelated attribute', '<p:sldSz type="a&#62;b" cy="5143500" cx="9144000"/>'],
  ['cx before a quoted gt attribute', '<p:sldSz cx="9144000" type="a&#62;b" cy="5143500"/>'],
]) test('slide size parsed independent of attribute order: ' + label, async () => {
  const parts = pptxParts();
  parts['ppt/presentation.xml'] = parts['ppt/presentation.xml'].replace(/<p:sldSz[^>]*\/>/, sldSz);
  const deck = await parse(parts);
  assert.equal(deck.width, 960); assert.equal(deck.height, 540);
});

test('slide size scan is quote-aware: a decoy gt cannot truncate cy away', async () => {
  // Attributes after a quoted `>` are invisible to a `[^>]*` scanner; cy must
  // still be read, so this well-formed deck parses instead of falling into the
  // malformed rejection below.
  const parts = pptxParts();
  parts['ppt/presentation.xml'] = parts['ppt/presentation.xml'].replace(/<p:sldSz[^>]*\/>/, '<p:sldSz type="a&#62;b&#62;c" cx="9144000" cy="5143500"/>');
  const deck = await parse(parts);
  assert.equal(deck.width, 960); assert.equal(deck.height, 540);
});

test('comment or PI decoy sldSz cannot shadow the real element', async () => {
  for (const [label, prefix] of [
    ['comment decoy', '<!-- <p:sldSz cx="100" cy="100"/> -->'],
    ['comment decoy with wrong-but-valid size', '<!-- <p:sldSz cx="9144000" cy="9144000"/> -->'],
  ]) {
    const parts = pptxParts();
    parts['ppt/presentation.xml'] = parts['ppt/presentation.xml'].replace(/<p:sldSz[^>]*\/>/, prefix + '<p:sldSz cx="9144000" cy="5143500"/>');
    const deck = await parse(parts);
    assert.equal(deck.width, 960, label + ' must not corrupt the real size');
    assert.equal(deck.height, 540);
  }
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

/* Review I4: a plain indented paragraph without any bullet declaration must
 * NOT grow a bullet. marL indentation is ordinary paragraph geometry; the old
 * `buFont || marL > 0` fallback painted bullets on every indented paragraph. */
test('indented paragraph without bullet declaration has no marker', async () => {
  const parts = pptxParts();
  const plain = '<p:sp><p:nvSpPr><p:cNvPr id="32" name="Plain"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="5000000"/><a:ext cx="7315200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>' +
    '<a:p><a:pPr marL="685800" lvl="1"/><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>普通缩进段落</a:t></a:r></a:p>' +
    '</p:txBody></p:sp>';
  inject(parts, slidePath, plain);
  const deck = await parse(parts);
  const shape = deck.slides[0].shapes.find(item => item.text?.paragraphs.some(pp => pp.runs.some(r => r.text.includes('普通缩进'))));
  assert.ok(shape, 'plain shape projected');
  assert.equal(shape.text.paragraphs[0].marker, null);
});

test('buFont without buChar still yields the default bullet marker', async () => {
  const parts = pptxParts();
  const item = '<p:sp><p:nvSpPr><p:cNvPr id="33" name="FontOnly"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="5000000"/><a:ext cx="7315200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>' +
    '<a:p><a:pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>字体符号列表</a:t></a:r></a:p>' +
    '</p:txBody></p:sp>';
  inject(parts, slidePath, item);
  const deck = await parse(parts);
  const shape = deck.slides[0].shapes.find(item => item.text?.paragraphs.some(pp => pp.runs.some(r => r.text.includes('字体符号'))));
  assert.deepEqual(shape.text.paragraphs[0].marker, { kind: 'bullet', char: '•' });
});

test('buNone suppresses inherited-looking bullet geometry', async () => {
  const parts = pptxParts();
  const item = '<p:sp><p:nvSpPr><p:cNvPr id="34" name="Suppressed"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="5000000"/><a:ext cx="7315200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>' +
    '<a:p><a:pPr marL="342900" indent="-342900"><a:buNone/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>取消列表</a:t></a:r></a:p>' +
    '</p:txBody></p:sp>';
  inject(parts, slidePath, item);
  const deck = await parse(parts);
  const shape = deck.slides[0].shapes.find(item => item.text?.paragraphs.some(pp => pp.runs.some(r => r.text.includes('取消列表'))));
  assert.equal(shape.text.paragraphs[0].marker, null);
});

/* Review I6: bullet characters outside the BMP are surrogate pairs; a naive
 * slice(0, 4) on UTF-16 code units can cut a pair in half and emit an invalid
 * lone surrogate into the DOM. Truncation must count code points. */
test('astral bullet characters truncate by code point, never splitting a pair', async () => {
  const parts = pptxParts();
  const astral = '\u{1F4CC}'; // U+1F4CC, two UTF-16 units
  const item = '<p:sp><p:nvSpPr><p:cNvPr id="35" name="Astral"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="5000000"/><a:ext cx="7315200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>' +
    `<a:p><a:pPr marL="342900" indent="-342900"><a:buChar char="${astral}${astral}${astral}"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>表情符号列表</a:t></a:r></a:p>` +
    '</p:txBody></p:sp>';
  inject(parts, slidePath, item);
  const deck = await parse(parts);
  const shape = deck.slides[0].shapes.find(item => item.text?.paragraphs.some(pp => pp.marker));
  const chars = [...shape.text.paragraphs[0].marker.char];
  assert.ok(chars.length <= 4, 'truncated to at most 4 code points');
  for (const ch of shape.text.paragraphs[0].marker.char) {
    const code = ch.codePointAt(0);
    assert.ok(!(code >= 0xd800 && code <= 0xdfff), 'no lone surrogate emitted');
  }
  assert.equal(shape.text.paragraphs[0].marker.char, astral + astral + astral);
});

test('bullet characters beyond the 4-code-point cap truncate without splitting pairs', async () => {
  const parts = pptxParts();
  const astral = '\u{1F4CC}';
  // Five astral chars = 10 UTF-16 units. slice(0, 4) on units would cut the
  // second pair in half; code-point truncation must yield exactly 4 pairs.
  const item = '<p:sp><p:nvSpPr><p:cNvPr id="35b" name="AstralLong"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="5000000"/><a:ext cx="7315200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>' +
    `<a:p><a:pPr marL="342900" indent="-342900"><a:buChar char="${astral}${astral}${astral}${astral}${astral}"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>超长符号</a:t></a:r></a:p>` +
    '</p:txBody></p:sp>';
  inject(parts, slidePath, item);
  const deck = await parse(parts);
  const shape = deck.slides[0].shapes.find(item => item.text?.paragraphs.some(pp => pp.runs.some(r => r.text.includes('超长符号'))));
  assert.equal(shape.text.paragraphs[0].marker.char, astral + astral + astral + astral);
  assert.equal(shape.text.paragraphs[0].marker.char.length, 8, 'four complete surrogate pairs');
});

/* Review I5 rendering half: alphaUc/romanUc must render uppercase (the case
 * signal lives in the Uc infix, every OOXML format string starts lowercase),
 * and an explicit startAt restarts the counter even mid-list. These run the
 * real frame script in jsdom with the real worker projection path. */
test('numeral case and startAt restart render in the real frame', async () => {
  const { JSDOM } = require('jsdom');
  const fs = require('node:fs');
  const parts = pptxParts();
  const list = '<p:sp><p:nvSpPr><p:cNvPr id="36" name="Numbered"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="3000000"/><a:ext cx="7315200" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>' +
    '<a:p><a:pPr marL="342900" indent="-342900" lvl="0"><a:buAutoNum type="alphaUcPeriod" startAt="1"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>第一大项</a:t></a:r></a:p>' +
    '<a:p><a:pPr marL="342900" indent="-342900" lvl="0"><a:buAutoNum type="alphaUcPeriod"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>第二大项</a:t></a:r></a:p>' +
    '<a:p><a:pPr marL="685800" indent="-342900" lvl="1"><a:buAutoNum type="romanUcPeriod" startAt="1"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>子项一</a:t></a:r></a:p>' +
    '<a:p><a:pPr marL="685800" indent="-342900" lvl="1"><a:buAutoNum type="romanUcPeriod"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>子项二</a:t></a:r></a:p>' +
    '<a:p><a:pPr marL="342900" indent="-342900" lvl="0"><a:buAutoNum type="alphaUcPeriod" startAt="1"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>重新计数项</a:t></a:r></a:p>' +
    '</p:txBody></p:sp>';
  inject(parts, slidePath, list);
  const deck = await parse(parts);
  const slidesDom = new JSDOM('<!doctype html><div id="slides"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const frameWindow = slidesDom.window;
  const script = frameWindow.document.createElement('script'); script.dataset.key = 'numbered-key';
  Object.defineProperty(frameWindow.document, 'currentScript', { value: script });
  frameWindow.postMessage = () => {};
  frameWindow.URL.createObjectURL = () => 'blob:fixture';
  frameWindow.URL.revokeObjectURL = () => {};
  frameWindow.eval(fs.readFileSync(path.join(ROOT, 'public/file-preview/office-slides-frame.js'), 'utf8'));
  const frameDeck = { ...deck, images: Object.fromEntries(Object.entries(deck.images).map(([name, image]) => [name, { ...image, bytes: frameWindow.Uint8Array.from(image.bytes) }])) };
  frameWindow.dispatchEvent(new frameWindow.MessageEvent('message', { source: frameWindow, data: { officeSlides: 'numbered-key', type: 'load', deck: frameDeck, slides: 2 } }));
  const markers = [...frameWindow.document.querySelectorAll('.pptx-marker')].map(el => el.textContent.trim());
  assert.equal(markers[0], 'A.', 'alphaUcPeriod starts uppercase A');
  assert.equal(markers[1], 'B.', 'alphaUcPeriod continues uppercase B');
  assert.equal(markers[2], 'I.', 'romanUcPeriod starts uppercase I');
  assert.equal(markers[3], 'II.', 'romanUcPeriod continues uppercase II');
  assert.equal(markers[4], 'A.', 'explicit startAt=1 restarts the level counter');
  slidesDom.window.close();
});

test('lowercase alpha and roman formats keep their lowercase rendering', async () => {
  const { JSDOM } = require('jsdom');
  const fs = require('node:fs');
  const parts = pptxParts();
  const list = '<p:sp><p:nvSpPr><p:cNvPr id="37" name="NumberedLc"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="3000000"/><a:ext cx="7315200" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>' +
    '<a:p><a:pPr marL="342900" indent="-342900" lvl="0"><a:buAutoNum type="alphaLcPeriod" startAt="3"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>小写项</a:t></a:r></a:p>' +
    '<a:p><a:pPr marL="342900" indent="-342900" lvl="1"><a:buAutoNum type="romanLcParenR" startAt="4"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>小写罗马</a:t></a:r></a:p>' +
    '</p:txBody></p:sp>';
  inject(parts, slidePath, list);
  const deck = await parse(parts);
  const slidesDom = new JSDOM('<!doctype html><div id="slides"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const frameWindow = slidesDom.window;
  const script = frameWindow.document.createElement('script'); script.dataset.key = 'lc-key';
  Object.defineProperty(frameWindow.document, 'currentScript', { value: script });
  frameWindow.postMessage = () => {};
  frameWindow.URL.createObjectURL = () => 'blob:fixture';
  frameWindow.URL.revokeObjectURL = () => {};
  frameWindow.eval(fs.readFileSync(path.join(ROOT, 'public/file-preview/office-slides-frame.js'), 'utf8'));
  const frameDeck = { ...deck, images: Object.fromEntries(Object.entries(deck.images).map(([name, image]) => [name, { ...image, bytes: frameWindow.Uint8Array.from(image.bytes) }])) };
  frameWindow.dispatchEvent(new frameWindow.MessageEvent('message', { source: frameWindow, data: { officeSlides: 'lc-key', type: 'load', deck: frameDeck, slides: 2 } }));
  const markers = [...frameWindow.document.querySelectorAll('.pptx-marker')].map(el => el.textContent.trim());
  assert.equal(markers[0], 'c.', 'alphaLcPeriod startAt=3 renders lowercase c');
  assert.equal(markers[1], 'iv)', 'romanLcParenR startAt=4 renders lowercase iv)');
  slidesDom.window.close();
});

/* East-Asian font chain: a run whose document named only an EA face must carry
 * it even without a Latin face; the CJK fallback chain must not render boxes. */
test('east-asian typeface participates without a latin face', async () => {
  const parts = pptxParts();
  const eaOnly = '<p:sp><p:nvSpPr><p:cNvPr id="38" name="EA"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="5000000"/><a:ext cx="7315200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>' +
    '<a:p><a:r><a:rPr lang="zh-CN" sz="2000"><a:ea typeface="微软雅黑"/></a:rPr><a:t>纯中文字体</a:t></a:r></a:p>' +
    '</p:txBody></p:sp>';
  inject(parts, slidePath, eaOnly);
  const deck = await parse(parts);
  const shape = deck.slides[0].shapes.find(item => item.text?.paragraphs.some(pp => pp.runs.some(r => r.text.includes('纯中文字体'))));
  const run = shape.text.paragraphs[0].runs[0];
  assert.equal(run.eastFamily, '微软雅黑');
});

/* F6 real-software compatibility: these two decks were written by LibreOffice
 * Impress (headless conversion of the sibling .fodp sources, kept in the same
 * directory for provenance and regeneration). They are what real office
 * software actually emits for bullets, auto-numbering and multi-level lists —
 * notably, LibreOffice exports bullet glyphs as buChar with font-specific
 * characters, and real auto-numbering as buAutoNum with
 * arabicPlain/alphaLcPeriod/romanLcPeriod types. The projection must carry
 * their structure without rejection, silent drops or fabricated markers. */
const realDeck = name => new Uint8Array(require('node:fs').readFileSync(path.join(__dirname, 'fixtures/office-real', name)));

test('malformed startAt degrades the marker instead of killing the deck', async () => {
  for (const bad of ['32768', 'abc', '-5', '2.5']) {
    const parts = pptxParts();
    const list = '<p:sp><p:nvSpPr><p:cNvPr id="40" name="BadStart"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="3000000"/><a:ext cx="7315200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>' +
      '<a:p><a:pPr marL="342900" indent="-342900"><a:buAutoNum type="arabicPeriod" startAt="' + bad + '"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>畸形起点</a:t></a:r></a:p>' +
      '</p:txBody></p:sp>';
    inject(parts, slidePath, list);
    const deck = await parse(parts);
    const shape = deck.slides[0].shapes.find(item => item.text?.paragraphs.some(pp => pp.runs.some(r => r.text.includes('畸形起点'))));
    assert.ok(shape, 'deck with malformed startAt ' + bad + ' still projects');
    assert.equal(shape.text.paragraphs[0].marker.start, 1);
    assert.equal(shape.text.paragraphs[0].marker.explicitStart, false);
  }
});

test('alpha numbering beyond z uses spreadsheet bijective base-26', async () => {
  const { JSDOM } = require('jsdom');
  const fs = require('node:fs');
  const parts = pptxParts();
  const items = Array.from({ length: 28 }, (_, i) =>
    '<a:p><a:pPr marL="342900" indent="-342900" lvl="0"><a:buAutoNum type="alphaLcPeriod"' + (i === 0 ? ' startAt="24"' : '') + '/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>项' + (i + 1) + '</a:t></a:r></a:p>').join('');
  const list = '<p:sp><p:nvSpPr><p:cNvPr id="41" name="LongAlpha"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="1000000"/><a:ext cx="7315200" cy="4000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>' + items + '</p:txBody></p:sp>';
  inject(parts, slidePath, list);
  const deck = await parse(parts);
  const slidesDom = new JSDOM('<!doctype html><div id="slides"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const frameWindow = slidesDom.window;
  const script = frameWindow.document.createElement('script'); script.dataset.key = 'alpha-key';
  Object.defineProperty(frameWindow.document, 'currentScript', { value: script });
  frameWindow.postMessage = () => {};
  frameWindow.URL.createObjectURL = () => 'blob:x';
  frameWindow.URL.revokeObjectURL = () => {};
  frameWindow.eval(fs.readFileSync(path.join(ROOT, 'public/file-preview/office-slides-frame.js'), 'utf8'));
  const frameDeck = { ...deck, images: Object.fromEntries(Object.entries(deck.images).map(([name, image]) => [name, { ...image, bytes: frameWindow.Uint8Array.from(image.bytes) }])) };
  frameWindow.dispatchEvent(new frameWindow.MessageEvent('message', { source: frameWindow, data: { officeSlides: 'alpha-key', type: 'load', deck: frameDeck, slides: 2 } }));
  const markers = [...frameWindow.document.querySelectorAll('.pptx-marker')].map(el => el.textContent.trim());
  assert.equal(markers[0], 'x.');
  assert.equal(markers[2], 'z.');
  assert.equal(markers[3], 'aa.', 'item after z renders aa not a-repeat');
  assert.equal(markers[4], 'ab.', 'second item after z renders ab not bb');
  slidesDom.window.close();
});

test('font names with commas are rejected by the whitelist rather than splitting the chain', async () => {
  const parts = pptxParts();
  const item = '<p:sp><p:nvSpPr><p:cNvPr id="42" name="CommaFont"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="5000000"/><a:ext cx="7315200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>' +
    '<a:p><a:r><a:rPr lang="zh-CN" sz="2000"><a:latin typeface="FakeFont,system-ui"/></a:rPr><a:t>逗号字体</a:t></a:r></a:p>' +
    '</p:txBody></p:sp>';
  inject(parts, slidePath, item);
  const deck = await parse(parts);
  const shape = deck.slides[0].shapes.find(item => item.text?.paragraphs.some(pp => pp.runs.some(r => r.text.includes('逗号字体'))));
  assert.equal(shape.text.paragraphs[0].runs[0].family, undefined, 'comma-containing font name dropped whole, not split');
});

test('real LibreOffice mixed bullet deck passes preflight with complete structure', async () => {
  const bytes = realDeck('libreoffice-bullets-mixed.pptx');
  const { inspectOffice } = await import(pathToFileURL(path.join(ROOT, 'public/file-preview/office-policy.js')));
  const inspection = inspectOffice(bytes, 'pptx');
  assert.equal(inspection.slides, 2);
  const deck = await (await load).parseOffice('pptx', bytes).then(result => result.deck);
  assert.equal(deck.slides.length, 2);
  assert.equal(deck.unsupported, 0);
  const slide1 = deck.slides[0];
  const paragraphs = slide1.shapes.flatMap(shape => shape.text?.paragraphs || []).filter(p => p.runs.some(r => r.text.trim()));
  // CJK text survives the full pipeline without replacement characters.
  assert.ok(paragraphs.some(p => p.runs.map(r => r.text).join('').includes('真实软件兼容性验证')));
  assert.ok(paragraphs.some(p => p.runs.map(r => r.text).join('').includes('第一层项目符号')));
  assert.ok(paragraphs.some(p => p.runs.map(r => r.text).join('').includes('中文混排')));
  // Two nesting levels of bullets are projected with their indent geometry.
  const bulleted = paragraphs.filter(p => p.marker?.kind === 'bullet');
  assert.ok(bulleted.length >= 5, 'LibreOffice bullet items carry bullet markers');
  assert.ok(bulleted.some(p => p.level === 0) && bulleted.some(p => p.level === 1), 'nested levels preserved');
  for (const p of bulleted) {
    assert.ok(p.marL > 0, 'bullet paragraphs carry real marL');
    assert.ok(p.indent < 0, 'bullet paragraphs carry hanging indent');
  }
  // Plain paragraphs never grow a bullet from mere indentation (I4 regression).
  const plain = paragraphs.find(p => p.runs.map(r => r.text).join('').includes('普通段落'));
  assert.equal(plain.marker, null);
  // Slide 2 numbering items remain readable text; the projection must not
  // fabricate numbering the source does not carry.
  const slide2 = deck.slides[1];
  const items2 = slide2.shapes.flatMap(shape => shape.text?.paragraphs || []).filter(p => p.runs.some(r => r.text.trim()));
  assert.ok(items2.some(p => p.runs.map(r => r.text).join('').trim() === '甲'));
  assert.ok(items2.some(p => p.runs.map(r => r.text).join('').trim() === '乙'));
  assert.ok(items2.some(p => p.runs.map(r => r.text).join('').trim() === '丙'));
});

test('real LibreOffice auto-numbering deck projects true buAutoNum across three levels', async () => {
  const bytes = realDeck('libreoffice-autonum-multilevel.pptx');
  const { inspectOffice } = await import(pathToFileURL(path.join(ROOT, 'public/file-preview/office-policy.js')));
  assert.equal(inspectOffice(bytes, 'pptx').slides, 1);
  const deck = await (await load).parseOffice('pptx', bytes).then(result => result.deck);
  assert.equal(deck.unsupported, 0);
  const paragraphs = deck.slides[0].shapes.flatMap(shape => shape.text?.paragraphs || []).filter(p => p.runs.some(r => r.text.trim()));
  const numbered = paragraphs.filter(p => p.marker?.kind === 'number');
  // Real office software wrote arabicPlain at level 0, alphaLcPeriod at
  // level 1 and romanLcPeriod at level 2 — exactly the everyday formats.
  const formats = numbered.map(p => [p.level, p.marker.format]);
  assert.ok(formats.some(([level, format]) => level === 0 && format === 'arabicPlain'), JSON.stringify(formats));
  assert.ok(formats.some(([level, format]) => level === 1 && format === 'alphaLcPeriod'), JSON.stringify(formats));
  assert.ok(formats.some(([level, format]) => level === 2 && format === 'romanLcPeriod'), JSON.stringify(formats));
  // LibreOffice omits startAt when it means continuation — the projection
  // must read them as non-explicit so the counter continues 1,2,3.
  assert.ok(numbered.every(p => !p.marker.explicitStart));
  const arabicItems = numbered.filter(p => p.marker.format === 'arabicPlain');
  assert.ok(arabicItems.length >= 3, 'three top-level numbered items');
  // Multi-level bullets survive with their distinct glyphs.
  const bulletChars = new Set(paragraphs.filter(p => p.marker?.kind === 'bullet').map(p => p.marker.char));
  assert.ok(bulletChars.has('•') && bulletChars.has('◦') && bulletChars.has('▪'), JSON.stringify([...bulletChars]));
  // The spaced paragraph projects without a fabricated marker.
  const spaced = paragraphs.find(p => p.runs.map(r => r.text).join('').includes('间距段落'));
  assert.ok(spaced); assert.equal(spaced.marker, null);
});

test('real LibreOffice decks render numbered continuation correctly in the frame', async () => {
  const { JSDOM } = require('jsdom');
  const fs = require('node:fs');
  const bytes = realDeck('libreoffice-autonum-multilevel.pptx');
  const deck = await (await load).parseOffice('pptx', bytes).then(result => result.deck);
  const slidesDom = new JSDOM('<!doctype html><div id="slides"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const frameWindow = slidesDom.window;
  const script = frameWindow.document.createElement('script'); script.dataset.key = 'real-deck';
  Object.defineProperty(frameWindow.document, 'currentScript', { value: script });
  frameWindow.postMessage = () => {};
  frameWindow.URL.createObjectURL = () => 'blob:fixture';
  frameWindow.URL.revokeObjectURL = () => {};
  frameWindow.eval(fs.readFileSync(path.join(ROOT, 'public/file-preview/office-slides-frame.js'), 'utf8'));
  const frameDeck = { ...deck, images: Object.fromEntries(Object.entries(deck.images).map(([name, image]) => [name, { ...image, bytes: frameWindow.Uint8Array.from(image.bytes) }])) };
  frameWindow.dispatchEvent(new frameWindow.MessageEvent('message', { source: frameWindow, data: { officeSlides: 'real-deck', type: 'load', deck: frameDeck, slides: 1 } }));
  const markers = [...frameWindow.document.querySelectorAll('.pptx-marker')].map(el => el.textContent.trim());
  // arabicPlain at level 0 continues 1,2,3 across the list; alpha/roman
  // children render lowercase per their Lc infix.
  const arabic = markers.filter(text => /^\d+\.$/.test(text));
  assert.deepEqual(arabic, ['1.', '2.', '3.'], JSON.stringify(markers));
  assert.ok(markers.some(text => /^a\.$/.test(text)), 'alpha child renders a.');
  assert.ok(markers.some(text => /^i\.$/.test(text)), 'roman grandchild renders i.');
  assert.ok(markers.includes('•') && markers.includes('◦') && markers.includes('▪'), JSON.stringify(markers));
  slidesDom.window.close();
});
