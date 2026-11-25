'use strict';
// Real, self-contained OOXML fixtures. No original project/user documents, no
// downloaded documents and no document-provided scripts are ever executed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '..');
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5b8AAAAASUVORK5CYII=', 'base64');
const rels = records => XML + `<Relationships xmlns="${NS_REL}">${records.map(([id, type, target, mode]) => `<Relationship Id="${id}" Type="${NS_OFFICE}/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`).join('')}</Relationships>`;
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
function zipParts(parts) {
  const { zipSync } = require('fflate');
  return zipSync(Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, typeof value === 'string' ? Buffer.from(value) : value])), { level: 0 });
}
function contentTypes(overrides) {
  return XML + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${overrides.map(([name, type]) => `<Override PartName="/${name}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`).join('')}</Types>`;
}

function docxParts() {
  return {
    '[Content_Types].xml': contentTypes([['word/document.xml', 'wordprocessingml.document.main+xml'], ['word/styles.xml', 'wordprocessingml.styles+xml'], ['word/numbering.xml', 'wordprocessingml.numbering+xml']]),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/_rels/document.xml.rels': rels([['rId1', 'styles', 'styles.xml'], ['rId2', 'numbering', 'numbering.xml'], ['rId3', 'image', 'media/image1.png']]),
    'word/styles.xml': XML + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>',
    'word/numbering.xml': XML + '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>',
    'word/document.xml': XML + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${NS_OFFICE}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>中文 Office Preview</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/><w:i/><w:u w:val="single"/><w:strike/></w:rPr><w:t>粗体 Bold 格式</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>项目列表</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>编号列表</w:t></w:r></w:p><w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>表格 A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>表格 B</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>${escape('<img src=x onerror="parent.hacked=1">')}</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Local image" descr="嵌入图片"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId3"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`,
    'word/media/image1.png': PNG,
  };
}

function pptxParts() {
  const a = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const p = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
  const shape = (id, text, y, color = '1C5D99') => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="${y}"/><a:ext cx="7315200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="l"/><a:r><a:rPr lang="zh-CN" sz="2400"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>${escape(text)}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
  const picture = '<p:pic><p:nvPicPr><p:cNvPr id="5" name="Local picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="7772400" y="457200"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
  const slide = index => XML + `<p:sld xmlns:a="${a}" xmlns:r="${NS_OFFICE}" xmlns:p="${p}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${group}${shape(2, `第 ${index} 页 / Slide ${index}`, 457200)}${shape(3, index === 1 ? '中文文本与真实布局' : '第二页内容 · Navigation', 1828800, '287271')}${picture}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  const scheme = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map((name, i) => `<a:${name}><a:srgbClr val="${i === 0 ? '000000' : i === 1 ? 'FFFFFF' : '1C5D99'}"/></a:${name}>`).join('');
  return {
    '[Content_Types].xml': contentTypes([['ppt/presentation.xml', 'presentationml.presentation.main+xml'], ['ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster+xml'], ['ppt/slideLayouts/slideLayout1.xml', 'presentationml.slideLayout+xml'], ['ppt/slides/slide1.xml', 'presentationml.slide+xml'], ['ppt/slides/slide2.xml', 'presentationml.slide+xml'], ['ppt/theme/theme1.xml', 'theme+xml']]),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': XML + `<p:presentation xmlns:a="${a}" xmlns:r="${NS_OFFICE}" xmlns:p="${p}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'slide', 'slides/slide2.xml']]),
    'ppt/slideMasters/slideMaster1.xml': XML + `<p:sldMaster xmlns:a="${a}" xmlns:r="${NS_OFFICE}" xmlns:p="${p}"><p:cSld><p:spTree>${group}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': XML + `<p:sldLayout xmlns:a="${a}" xmlns:r="${NS_OFFICE}" xmlns:p="${p}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/theme/theme1.xml': XML + `<a:theme xmlns:a="${a}" name="Office"><a:themeElements><a:clrScheme name="Office">${scheme}</a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>`,
    'ppt/slides/slide1.xml': slide(1), 'ppt/slides/slide2.xml': slide(2),
    'ppt/slides/_rels/slide1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'image', '../media/image1.png']]),
    'ppt/slides/_rels/slide2.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'image', '../media/image1.png']]),
    'ppt/media/image1.png': PNG,
  };
}

async function xlsxBytes() {
  const ExcelJS = require('exceljs');
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('中文数据');
  sheet.columns = [{ width: 22 }, { width: 18 }, { width: 18 }, { width: 18 }];
  sheet.addRow(['日期 Date', '数值 Amount', '布尔 Boolean', '公式 Cached']);
  sheet.addRow([new Date('2026-11-25T00:00:00Z'), 1234.5, false, { formula: 'B2*2', result: 2469 }]);
  sheet.getCell('A2').numFmt = 'yyyy-mm-dd'; sheet.getCell('B2').numFmt = '#,##0.00';
  sheet.getCell('B2').font = { bold: true, color: { argb: 'FF1C5D99' } };
  sheet.getCell('B2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F6FB' } };
  sheet.getCell('D3').value = { formula: '1+2' }; // No cached value: display the formula, do not calculate.
  sheet.mergeCells('A4:B5'); sheet.getCell('A4').value = '合并单元格';
  sheet.getCell('C6').value = { richText: [{ text: 'Rich ' }, { text: '中文', font: { bold: true } }] };
  book.addWorksheet('Second Sheet').addRow(['独立工作表', true, 0]);
  const tall = book.addWorksheet('Virtual Rows');
  for (let row = 1; row <= 2000; row++) tall.addRow([`Row ${row}`, row, row % 2 === 0]);
  return new Uint8Array(await book.xlsx.writeBuffer());
}

module.exports = { docxParts, pptxParts, zipParts, xlsxBytes, PNG };

async function unitTests() {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-office-test-'));
  let passed = 0;
  const check = (label, fn) => { fn(); passed++; console.log('PASS ' + label); };
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="toolbar"></div><main id="host"></main>', { url: 'http://127.0.0.1/', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'DOMParser', 'XMLSerializer', 'Node', 'NodeFilter', 'HTMLElement']) global[key] = dom.window[key];
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  const load = file => import(pathToFileURL(path.join(ROOT, 'public/file-preview', file)));
  const { inspectOffice, OFFICE_LIMITS } = await load('office-policy.js');
  const { parseOffice } = await load('office-parse.js');
  const docx = zipParts(docxParts());
  const pptx = zipParts(pptxParts());
  const xlsx = await xlsxBytes();
  const fixtureFiles = { 'document.docx': docx, 'presentation.pptx': pptx, 'workbook.xlsx': xlsx,
    'quoted.csv': Buffer.from('名称,备注,数值\r\n"中文,名字","第一行\n第二行 \"\"quoted\"\"",0\r\nFormula,=1+2,FALSE\r\n'),
    'tabbed.tsv': Buffer.from('名称\t描述\n中文\t"带\t制表符"\n'),
  };
  for (const [name, bytes] of Object.entries(fixtureFiles)) fs.writeFileSync(path.join(world, name), bytes);
  check('DOCX complete package passes shared ZIP preflight', () => assert.equal(inspectOffice(docx, 'docx').images, 1));
  check('PPTX real two-slide package passes shared ZIP preflight', () => assert.equal(inspectOffice(pptx, 'pptx').slides, 2));
  const withThumbnail = docxParts(); withThumbnail['docProps/thumbnail.png'] = PNG;
  check('ordinary Office thumbnail is accepted under raster budget', () => assert.equal(inspectOffice(zipParts(withThumbnail), 'docx').images, 2));
  check('ExcelJS-written three-sheet workbook passes preflight', () => assert.equal(inspectOffice(xlsx, 'xlsx').sheets, 3));
  const rejectDocx = (label, mutate, code) => {
    const parts = docxParts(); mutate(parts);
    check(label, () => assert.throws(() => inspectOffice(zipParts(parts), 'docx'), error => !code || error.code === code));
  };
  rejectDocx('DOCTYPE rejected before mature parser', parts => { parts['word/document.xml'] = parts['word/document.xml'].replace('<w:document ', '<!DOCTYPE x [<!ENTITY ext SYSTEM "file:///private">]><w:document '); }, 'active-content');
  rejectDocx('UTF-16 DTD cannot bypass byte preflight', parts => { parts['word/document.xml'] = Buffer.from('﻿<!DOCTYPE x><x/>', 'utf16le'); }, 'active-content');
  rejectDocx('custom entity without declaration rejected', parts => { parts['word/document.xml'] = '<x>&injected;</x>'; }, 'entity');
  rejectDocx('external relationship rejected', parts => { parts['word/_rels/document.xml.rels'] = rels([['rId3', 'image', 'https://invalid.example/x.png', 'External']]); }, 'active-content');
  rejectDocx('URI relationship rejected without TargetMode', parts => { parts['word/_rels/document.xml.rels'] = rels([['rId3', 'image', 'https://invalid.example/x.png']]); }, 'external-link');
  rejectDocx('entity-encoded external target rejected', parts => { parts['word/_rels/document.xml.rels'] = rels([['rId3', 'image', 'https&#58;//invalid.example/x.png']]); }, 'external-link');
  rejectDocx('entity-encoded external mode rejected', parts => { parts['word/_rels/document.xml.rels'] = rels([['rId3', 'image', 'relative.png', 'Ext&#101;rnal']]); }, 'active-content');
  rejectDocx('macro payload rejected', parts => { parts['word/vbaProject.bin'] = Buffer.from('fixture'); }, 'active-content');
  rejectDocx('embedded package rejected', parts => { parts['word/embeddings/object.dat'] = Buffer.from('fixture'); }, 'active-content');
  rejectDocx('raw SVG media rejected before DOM', parts => { parts['word/media/active.svg'] = '<svg onload="alert(1)"/>'; }, 'image-limit');
  rejectDocx('raster decompression dimensions bounded', parts => { const image = Buffer.from(PNG); image.writeUInt32BE(100000, 16); parts['word/media/image1.png'] = image; }, 'image-limit');
  rejectDocx('per-XML length bounded', parts => { parts['word/document.xml'] = ' '.repeat(OFFICE_LIMITS.xmlBytes + 1); }, 'xml-limit');
  const wrongPackage = { '[Content_Types].xml': contentTypes([]), '_rels/.rels': rels([]), 'word/not-document.xml': '<x/>' };
  check('extension is not accepted as proof of DOCX format', () => assert.throws(() => inspectOffice(zipParts(wrongPackage), 'docx')));
  check('non-ZIP bytes rejected', () => assert.throws(() => inspectOffice(Buffer.from('not zip'), 'docx')));
  const { unzipSync } = require('fflate');
  for (const [label, replacement] of [['huge sparse row', '<sheetData><row r="1048576"/></sheetData>'], ['huge merged area', '<mergeCells><mergeCell ref="A1:DX50000"/></mergeCells>'], ['huge column definition', '<cols><col min="1" max="16384"/></cols>'], ['encoded huge column', '<cols><col min="1" max="&#49;6384"/></cols>']]) {
    const parts = unzipSync(xlsx);
    parts['xl/worksheets/sheet1.xml'] = Buffer.from(`<worksheet>${replacement}</worksheet>`);
    check(label + ' rejected before ExcelJS allocation', () => assert.throws(() => inspectOffice(zipParts(parts), 'xlsx'), error => error.code === 'sheet-limit'));
  }
  for (const reference of ['$A$1:$XFD$1048576', '&#36;A&#36;1:&#36;XFD&#36;1048576', '$A$1:$DX$50000']) {
    const parts = unzipSync(xlsx);
    parts['xl/workbook.xml'] = Buffer.from(`<workbook><definedNames><definedName name="Explosive">Sheet!${reference}</definedName></definedNames></workbook>`);
    check('named range allocation bounded: ' + reference, () => assert.throws(() => inspectOffice(zipParts(parts), 'xlsx'), error => error.code === 'sheet-limit'));
  }
  // Real worker_threads with only the browser worker messaging API shimmed;
  // notably there is NO DOMParser/window/document in this execution context.
  const bootstrap = path.join(world, 'office-worker-bootstrap.mjs');
  fs.writeFileSync(bootstrap, `import {parentPort,workerData} from 'node:worker_threads';\nglobalThis.self=globalThis;self.postMessage=data=>parentPort.postMessage(data);const queue=[];parentPort.on('message',data=>self.onmessage?self.onmessage({data}):queue.push(data));await import(workerData.target);for(const data of queue)await self.onmessage({data});`);
  const { Worker: NodeWorker } = require('node:worker_threads');
  let workersStarted = 0, workersTerminated = 0;
  class RealBrowserWorker {
    constructor(url) {
      workersStarted++; this.done = false;
      this.thread = new NodeWorker(bootstrap, { workerData: { target: String(url) } });
      this.thread.on('message', data => this.onmessage?.({ data }));
      this.thread.on('error', () => this.onerror?.({ preventDefault() {} }));
    }
    postMessage(data, transfer) { this.thread.postMessage(data, transfer); }
    terminate() { if (!this.done) { this.done = true; workersTerminated++; } this.thread.terminate(); }
  }
  global.Worker = RealBrowserWorker;
  const { parseInWorker } = await load('office-worker-client.js');
  const workerContext = () => { const abort = new AbortController(); return { abort, resources: { signal: abort.signal, isCurrent: () => true, own() {} } }; };
  const workerDoc = await parseInWorker(workerContext(), 'docx', docx);
  check('real DOM-free worker parses Mammoth DOCX', () => assert.match(workerDoc.html, /<h1>/));
  const workerBook = await parseInWorker(workerContext(), 'xlsx', xlsx);
  check('real DOM-free worker loads ExcelJS workbook', () => assert.equal(workerBook.sheets.length, 3));
  const workerCsv = await parseInWorker(workerContext(), 'csv', new Uint8Array(fixtureFiles['quoted.csv']));
  check('real DOM-free worker parses PapaParse CSV', () => assert.equal(workerCsv.sheets[0].rows[1].cells[0].text, '中文,名字'));
  const workerPptx = await parseInWorker(workerContext(), 'pptx', pptx);
  check('real DOM-free worker preflights complete PPTX', () => assert.equal(workerPptx.slides, 2));
  const malformedPptx = pptxParts(); malformedPptx['ppt/slides/slide1.xml'] = '<p:sld unterminated="';
  await assert.rejects(parseInWorker(workerContext(), 'pptx', zipParts(malformedPptx))); passed++;
  const cdataPptx = pptxParts(); cdataPptx['ppt/slides/slide1.xml'] = cdataPptx['ppt/slides/slide1.xml'].replace('中文文本与真实布局', '<![CDATA[> <x unclosed=" text]]>');
  await assert.rejects(parseInWorker(workerContext(), 'pptx', zipParts(cdataPptx)), error => error.code === 'format'); passed++;
  const piPptx = pptxParts(); piPptx['ppt/slides/slide1.xml'] = '<?preview unsupported?><x/>';
  await assert.rejects(parseInWorker(workerContext(), 'pptx', zipParts(piPptx)), error => error.code === 'format'); passed++;
  const unicodeNamePptx = pptxParts(); unicodeNamePptx['ppt/slides/slide1.xml'] = unicodeNamePptx['ppt/slides/slide1.xml'].replace('<p:sld ', '<p:sld 中文="value" ');
  await assert.rejects(parseInWorker(workerContext(), 'pptx', zipParts(unicodeNamePptx)), error => error.code === 'format'); passed++;
  const unsupportedAttributePptx = pptxParts(); unsupportedAttributePptx['ppt/slides/slide1.xml'] = unsupportedAttributePptx['ppt/slides/slide1.xml'].replace('<p:sld ', '<p:sld _123="value" ');
  await assert.rejects(parseInWorker(workerContext(), 'pptx', zipParts(unsupportedAttributePptx)), error => error.code === 'format'); passed++;
  const cancelled = workerContext(); cancelled.abort.abort();
  await assert.rejects(parseInWorker(cancelled, 'xlsx', xlsx), error => error.code === 'cancelled'); passed++;
  const inFlight = workerContext();
  const pendingWorker = parseInWorker(inFlight, 'xlsx', xlsx); inFlight.abort.abort();
  await assert.rejects(pendingWorker, error => error.code === 'cancelled'); passed++;
  check('all successful and cancelled real workers terminated', () => assert.equal(workersStarted, workersTerminated));
  // Accelerate only the deadline clock; the hung parser is a real native
  // worker and must actually be terminated, not merely left running by race().
  const nativeTimeout = global.setTimeout;
  let hungTerminated = false;
  global.Worker = class {
    constructor() { this.thread = new NodeWorker('for(;;){}', { eval: true }); }
    postMessage() {}
    terminate() { hungTerminated = true; this.thread.terminate(); }
  };
  global.setTimeout = (callback, delay, ...args) => nativeTimeout(callback, delay === OFFICE_LIMITS.parseMs ? 30 : delay, ...args);
  try { await assert.rejects(parseInWorker(workerContext(), 'xlsx', xlsx), error => error.code === 'timeout'); passed++; }
  finally { global.setTimeout = nativeTimeout; }
  check('deadline terminates the real stalled worker', () => assert.ok(hungTerminated));
  delete global.Worker;
  // Execute our actual data-only frame with the real worker projection. jsdom
  // proves DOM/resource behavior only; desktop tests prove rendered layout.
  const slidesDom = new JSDOM('<!doctype html><div id="slides"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const frameWindow = slidesDom.window, messages = [], revoked = [];
  const script = frameWindow.document.createElement('script'); script.dataset.key = 'offline-key';
  Object.defineProperty(frameWindow.document, 'currentScript', { value: script });
  frameWindow.postMessage = data => messages.push(data);
  frameWindow.URL.createObjectURL = () => 'blob:offline-fixture';
  frameWindow.URL.revokeObjectURL = value => revoked.push(value);
  frameWindow.eval(fs.readFileSync(path.join(ROOT, 'public/file-preview/office-slides-frame.js'), 'utf8'));
  const deck = { ...workerPptx.deck, images: Object.fromEntries(Object.entries(workerPptx.deck.images).map(([name, image]) => [name, { ...image, bytes: frameWindow.Uint8Array.from(image.bytes) }])) };
  const frameMessage = (type, extra = {}) => frameWindow.dispatchEvent(new frameWindow.MessageEvent('message', { source: frameWindow, data: { officeSlides: 'offline-key', type, ...extra } }));
  frameMessage('load', { deck, slides: 2 });
  check('real PPTX reader loads both legal slides', () => assert.equal(messages.find(value => value.type === 'loaded').count, 2));
  check('real PPTX renderer emits shape SVGs, not a text dump', () => assert.equal(frameWindow.document.querySelectorAll('svg rect').length, 2));
  check('real PPTX renderer emits embedded raster image', () => assert.match(frameWindow.document.querySelector('img').src, /^blob:/));
  check('real PPTX source layout has genuine slide dimensions', () => assert.equal(frameWindow.document.querySelector('.pptx-slide').style.width, '960px'));
  frameMessage('page', { page: 1 });
  check('real PPTX navigation replaces content with second slide', () => assert.ok(frameWindow.document.body.textContent.includes('Slide 2') && !frameWindow.document.body.textContent.includes('Slide 1')));
  frameMessage('dispose');
  check('real PPTX disposal empties slide DOM and revokes image URLs', () => { assert.equal(frameWindow.document.querySelector('#slides').childElementCount, 0); assert.deepEqual(revoked, ['blob:offline-fixture']); });
  slidesDom.window.close();
  const doc = await parseOffice('docx', docx);
  const docDom = new JSDOM(doc.html).window.document;
  check('real Mammoth preserves heading', () => assert.equal(docDom.querySelector('h1').textContent, '中文 Office Preview'));
  check('real Mammoth preserves bold italic', () => assert.match(doc.html, /<(?:strong|em)>/));
  check('real Mammoth preserves underline', () => assert.ok(docDom.querySelector('u')));
  check('real Mammoth preserves strike', () => assert.ok(docDom.querySelector('s')));
  check('real Mammoth preserves unordered list', () => assert.equal(docDom.querySelector('ul li').textContent, '项目列表'));
  check('real Mammoth preserves ordered list', () => assert.equal(docDom.querySelector('ol li').textContent, '编号列表'));
  check('real Mammoth preserves table cells', () => assert.equal(docDom.querySelectorAll('td').length, 2));
  check('real Mammoth projects embedded image, no network URL', () => assert.match(docDom.querySelector('img').src, /^data:image\/png;base64,/));
  check('raw markup in DOCX text remains text', () => assert.equal(docDom.querySelectorAll('img').length, 1));
  const book = await parseOffice('xlsx', xlsx);
  const cell = (sheet, row, column) => book.sheets[sheet].rows.find(item => item.index === row)?.cells.find(item => item.column === column);
  check('real ExcelJS multiple sheet names preserved', () => assert.deepEqual(book.sheets.map(sheet => sheet.name), ['中文数据', 'Second Sheet', 'Virtual Rows']));
  check('real ExcelJS date value rendered', () => assert.equal(cell(0, 2, 1).text, '2026-11-25'));
  check('real ExcelJS basic numeric format rendered', () => assert.equal(cell(0, 2, 2).text, '1,234.50'));
  check('real ExcelJS false not replaced by empty', () => assert.equal(cell(0, 2, 3).text, 'FALSE'));
  check('real ExcelJS formula cache preserved', () => assert.equal(cell(0, 2, 4).text, '2469'));
  check('formula text retained without computation', () => assert.equal(cell(0, 3, 4).text, '=1+2'));
  check('real ExcelJS zero preserved', () => assert.equal(cell(1, 1, 3).text, '0'));
  check('real ExcelJS rich text projected as text', () => assert.equal(cell(0, 6, 3).text, 'Rich 中文'));
  check('real ExcelJS source bold and fill preserved', () => assert.deepEqual({ bold: cell(0, 2, 2).style.bold, fill: cell(0, 2, 2).style.background }, { bold: true, fill: '#F1F6FB' }));
  check('real ExcelJS merge geometry preserved', () => assert.deepEqual(book.sheets[0].merges[0], { row: 4, column: 1, endRow: 5, endColumn: 2 }));
  check('real ExcelJS merged children not duplicated', () => assert.equal(cell(0, 4, 2), undefined));
  check('large sheet projected for virtualization', () => assert.equal(book.sheets[2].rowCount, 2000));
  const csv = await parseOffice('csv', new Uint8Array(fixtureFiles['quoted.csv']));
  check('PapaParse handles comma inside quoted Chinese field', () => assert.equal(csv.sheets[0].rows[1].cells[0].text, '中文,名字'));
  check('PapaParse handles quoted newline and double quotes', () => assert.equal(csv.sheets[0].rows[1].cells[1].text, '第一行\n第二行 "quoted"'));
  check('CSV formulas remain literal uncomputed text', () => assert.equal(csv.sheets[0].rows[2].cells[1].text, '=1+2'));
  const emptyCsv = await parseOffice('csv', Buffer.from('a,b\n,\n  ,value\n'));
  check('CSV empty fields are not silently dropped as greedy empty rows', () => assert.equal(emptyCsv.sheets[0].rows.length, 3));
  check('CSV meaningful leading whitespace is retained', () => assert.equal(emptyCsv.sheets[0].rows[2].cells[0].text, '  '));
  const tsv = await parseOffice('tsv', new Uint8Array(fixtureFiles['tabbed.tsv']));
  check('PapaParse handles quoted tabs', () => assert.equal(tsv.sheets[0].rows[1].cells[1].text, '带\t制表符'));
  const utf16 = await parseOffice('csv', Buffer.from('﻿名称,值\n中文,1', 'utf16le'));
  check('UTF-16 BOM CSV decoded', () => assert.equal(utf16.sheets[0].rows[1].cells[0].text, '中文'));
  const gb = await parseOffice('csv', new Uint8Array([0xc3, 0xfb, 0xb3, 0xc6, 44, 49]));
  check('GB18030 fallback preserves Chinese', () => assert.equal(gb.sheets[0].rows[0].cells[0].text, '名称'));
  await assert.rejects(parseOffice('csv', new Uint8Array(Buffer.from('a,"unterminated'))), error => error.code === 'csv-format'); passed++;
  await assert.rejects(parseOffice('csv', new Uint8Array(Buffer.from(Array(130).fill('x').join(',')))), error => error.code === 'sheet-limit'); passed++;
  const host = document.querySelector('#host'), toolbar = document.querySelector('#toolbar');
  const abort = new AbortController(); const owned = [];
  const ctx = { host, toolbar, state: {}, resources: { signal: abort.signal, isCurrent: () => true, own: fn => owned.push(fn) } };
  const { mountDocument } = await load('office-document.js');
  const docView = mountDocument(ctx, { html: doc.html + '<script>globalThis.hacked=1</script><img src="https://invalid.example/leak" onerror="globalThis.hacked=1"><svg onload="alert(1)"></svg><a href="javascript:alert(1)">unsafe link</a>' });
  check('DOMPurify removes raw scripts and SVG', () => assert.equal(host.querySelectorAll('script,svg').length, 0));
  check('DOCX only locally generated raster data images survive', () => assert.equal(host.querySelectorAll('img').length, 1));
  check('DOCX external and script links cannot navigate', () => assert.equal(host.querySelectorAll('a,[onclick],[onerror]').length, 0));
  check('sanitizer retains formatted document table', () => assert.equal(host.querySelectorAll('td').length, 2));
  const docInput = toolbar.querySelector('input'); docInput.value = '列表'; docInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 250));
  check('DOCX search marks rendered real parser text', () => assert.equal(host.querySelectorAll('mark').length, 2));
  docView.dispose();
  check('DOCX dispose releases view and toolbar', () => assert.equal(host.childElementCount + toolbar.childElementCount, 0));
  const { mountGrid } = await load('office-grid.js');
  const grid = mountGrid(ctx, book);
  check('grid has accessible sheet tabs', () => assert.equal(toolbar.ownerDocument.querySelectorAll('[role="tab"]').length, 3));
  check('grid renders real cached value', () => assert.ok(host.textContent.includes('2469')));
  check('grid renders merged geometry', () => assert.ok(host.querySelector('[aria-colspan="2"][aria-rowspan="2"]')));
  const tab = host.querySelectorAll('[role="tab"]')[2]; tab.click();
  check('virtualization does not mount 2000 logical rows', () => assert.ok(host.querySelectorAll('[role="row"]').length < 100));
  const viewport = host.querySelector('.office-grid-viewport'); viewport.scrollTop = 1990 * 28; viewport.dispatchEvent(new dom.window.Event('scroll'));
  await new Promise(resolve => setTimeout(resolve, 50));
  check('virtual scrolling reaches real final row', () => assert.ok(host.textContent.includes('Row 2000')));
  const input = toolbar.querySelector('input'); input.value = 'Row 1999'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 250));
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  check('grid search navigates to real parsed cell', () => assert.equal(host.querySelector('.office-grid-cell[aria-selected="true"]').textContent, 'Row 1999'));
  let copied;
  const copy = new dom.window.Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(copy, 'clipboardData', { value: { setData: (_type, value) => { copied = value; } } }); viewport.dispatchEvent(copy);
  check('grid copy uses selected cell text only', () => assert.equal(copied, 'Row 1999'));
  const state = grid.getState(); grid.dispose();
  check('grid reading state preserves active sheet and position', () => assert.equal(state.sheet, 2));
  check('grid dispose releases DOM and toolbar', () => assert.equal(host.childElementCount + toolbar.childElementCount, 0));
  dom.window.close();
  console.log(`Office unit: ${passed}/${passed}; fixtures: ${world}`);
  return { world, passed };
}

async function chromeHarness(world) {
  const { spawn } = require('node:child_process');
  const WebSocket = require('ws');
  const { EventEmitter } = require('node:events');
  const executable = process.env.OFFICE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const args = ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + path.join(world, 'chrome-profile'), '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank'];
  const processHandle = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const endpoint = await new Promise((resolve, reject) => {
    let text = ''; const timeout = setTimeout(() => reject(Error('Chrome DevTools unavailable')), 20000);
    processHandle.stderr.on('data', chunk => { text += chunk; const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text); if (match) { clearTimeout(timeout); resolve(match[1]); } });
    processHandle.on('error', error => { clearTimeout(timeout); reject(error); });
    processHandle.on('exit', code => { clearTimeout(timeout); reject(Error('Chrome exited: ' + code)); });
  });
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0; const pending = new Map(), events = new EventEmitter();
  socket.on('message', bytes => {
    const message = JSON.parse(String(bytes));
    if (message.id) { const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); message.error ? waiter.reject(Error(message.error.message)) : waiter.resolve(message.result); } }
    else events.emit(message.method, message.params, message.sessionId);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => send(method, params, sessionId);
  const frameContexts = new Map();
  events.on('Runtime.executionContextCreated', (event, owner) => { if (owner === sessionId && event.context.auxData?.isDefault) frameContexts.set(event.context.auxData.frameId, event.context.id); });
  await command('Page.enable'); await command('Runtime.enable'); await command('Network.enable');
  const evaluate = async (expression, contextId) => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true, ...(contextId ? { contextId } : {}) });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  let beforeRequest;
  events.on('Fetch.requestPaused', (event, owner) => {
    if (owner !== sessionId) return;
    const done = result => command(result.cancel ? 'Fetch.failRequest' : 'Fetch.continueRequest', result.cancel ? { requestId: event.requestId, errorReason: 'BlockedByClient' } : { requestId: event.requestId }).catch(() => {});
    if (beforeRequest) beforeRequest({ url: event.request.url, resourceType: event.resourceType }, done); else done({ cancel: false });
  });
  await command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  const content = new EventEmitter();
  content.executeJavaScript = expression => evaluate(expression);
  content.sendInputEvent = event => {
    if (event.type === 'keyDown' || event.type === 'keyUp') {
      const keys = { Down: ['ArrowDown', 40], Up: ['ArrowUp', 38], Right: ['ArrowRight', 39], Left: ['ArrowLeft', 37], Enter: ['Enter', 13] };
      const [key, code] = keys[event.keyCode] || [event.keyCode, 0];
      return command('Input.dispatchKeyEvent', { type: event.type, key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: event.modifiers?.includes('shift') ? 8 : 0 });
    }
    const types = { mouseMove: 'mouseMoved', mouseDown: 'mousePressed', mouseUp: 'mouseReleased' };
    return command('Input.dispatchMouseEvent', { type: types[event.type], x: event.x, y: event.y, button: event.button || 'none', clickCount: event.clickCount || 0 });
  };
  content.getLastWebPreferences = () => ({ sandbox: !args.includes('--no-sandbox') });
  content.session = { webRequest: { onBeforeRequest: callback => { beforeRequest = callback; } } };
  content.capturePage = async () => { const result = await command('Page.captureScreenshot', { format: 'png' }); const pixels = await evaluate('({width:innerWidth,height:innerHeight})'); return { toPNG: () => Buffer.from(result.data, 'base64'), getSize: () => pixels }; };
  content.childEvaluate = async expression => {
    const { frameTree } = await command('Page.getFrameTree');
    const frame = frameTree.childFrames?.find(item => item.frame.url === 'about:srcdoc')?.frame;
    if (!frame) {
      const { targetInfos } = await send('Target.getTargets');
      const target = targetInfos.find(item => item.type === 'iframe' && item.url === 'about:srcdoc');
      if (!target) throw Error('Missing sandbox iframe target');
      const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, attached.sessionId);
      await send('Target.detachFromTarget', { sessionId: attached.sessionId });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
      return result.result.value;
    }
    const contextId = frameContexts.get(frame.id);
    if (!contextId) throw Error('Missing sandbox main-world context');
    return evaluate(expression, contextId);
  };
  class BrowserWindow {
    constructor(options) { this.webContents = content; this.setContentSize(options.width, options.height); }
    setContentSize(width, height) { command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }).catch(() => {}); }
    async loadURL(url) { const loaded = new Promise(resolve => events.once('Page.loadEventFired', resolve)); await command('Page.navigate', { url }); await loaded; }
    destroy() { send('Browser.close').catch(() => {}); socket.close(); }
  }
  return { app: { setPath() {}, whenReady: async () => {}, exit(code) { process.exitCode = code; } }, BrowserWindow };
}

async function electronTests() {
  const http = require('node:http');
  const world = process.env.OFFICE_TEST_WORLD;
  if (!world) throw Error('Missing fixture directory');
  const browserMode = process.argv.includes('--browser');
  const { app, BrowserWindow } = browserMode ? await chromeHarness(world) : require('electron');
  app.setPath('userData', path.join(world, 'profile'));
  const startupDeadline = setTimeout(() => { console.error('Office app.whenReady timeout'); app.exit(1); }, 20000);
  await app.whenReady(); clearTimeout(startupDeadline);
  const fixtures = { 'document.docx': zipParts(docxParts()), 'presentation.pptx': zipParts(pptxParts()), 'workbook.xlsx': await xlsxBytes(), 'quoted.csv': Buffer.from('名称,备注,数值\n"中文,名字","第一行\n第二行",0\n') };
  // Malicious text is XML data, never a script supplied to the browser test.
  const attack = pptxParts();
  attack['ppt/slides/slide1.xml'] = attack['ppt/slides/slide1.xml'].replace('中文文本与真实布局', escape('<img src="https://invalid.example/leak" onerror="parent.hacked=1">'));
  fixtures['markup.pptx'] = zipParts(attack);
  for (const [name, bytes] of Object.entries(fixtures)) fs.writeFileSync(path.join(world, name), bytes);
  const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/ui/primitives.css"><link rel="stylesheet" href="/file-preview/office.css"><style>*{box-sizing:border-box}html,body{margin:0;height:100%;font-family:var(--font-sans);background:var(--ds-bg-primary);color:var(--ds-text-primary)}body{display:flex;flex-direction:column}#toolbar{padding:12px;border-bottom:1px solid var(--ds-border-default)}#host{flex:1;min-height:0}</style></head><body><div id="toolbar"></div><main id="host"></main><script type="module">
    import {mount} from '/file-preview/office.js';
    const NativeWorker=window.Worker;window.workerStats={started:0,terminated:0};
    window.Worker=class extends NativeWorker{constructor(...args){super(...args);window.workerStats.started++;this.done=false}terminate(){if(!this.done){window.workerStats.terminated++;this.done=true}return super.terminate()}};
    window.cleanup=()=>{};window.lastError='';
    window.showFixture=async(name,state={})=>{
      window.cleanup();document.querySelector('#host').replaceChildren();document.querySelector('#toolbar').replaceChildren();window.lastError='';
      const abort=new AbortController(),owned=[];let current=true,view;
      window.cleanup=()=>{if(!current)return;current=false;abort.abort();view?.dispose?.();for(const fn of owned.reverse())fn();document.querySelector('#host').replaceChildren();document.querySelector('#toolbar').replaceChildren()};
      const ctx={host:document.querySelector('#host'),toolbar:document.querySelector('#toolbar'),state,request:{name},meta:{name},resources:{signal:abort.signal,isCurrent:()=>current,own:fn=>owned.push(fn),url:blob=>{const url=URL.createObjectURL(blob);owned.push(()=>URL.revokeObjectURL(url));return url}},access:{bytes:async max=>{const bytes=new Uint8Array(await(await fetch('/fixture/'+name)).arrayBuffer());if(bytes.length>max)throw Error('limit');return bytes}},error:message=>{window.lastError=message;ctx.host.textContent=message}};
      view=await mount(ctx);window.currentView=view;return {error:window.lastError,state:view.getState()};
    };window.fixtureReady=true;
  </script></body></html>`;
  const publicRoot = path.join(ROOT, 'public');
  const requests = [], blocked = [], errors = [], screenshots = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1'); requests.push(url.pathname);
    if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
    if (url.pathname.startsWith('/fixture/')) {
      const bytes = fixtures[url.pathname.slice(9)]; response.writeHead(bytes ? 200 : 404); response.end(bytes || ''); return;
    }
    const file = path.resolve(publicRoot, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const win = new BrowserWindow({ width: 1320, height: 820, useContentSize: true, show: true, autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  let checks = 0;
  const check = (label, pass) => { assert.ok(pass, label); checks++; console.log('PASS ' + label); };
  const read = code => win.webContents.executeJavaScript(code, true);
  const paint = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const child = () => win.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc');
  const childRead = async code => { if (browserMode) return win.webContents.childEvaluate(code); const frame = child(); if (!frame) throw Error('Missing sandbox iframe'); return frame.executeJavaScript(code, true); };
  const shot = async name => { await paint(); const picture = await win.webContents.capturePage(); const file = path.join(world, name + '.png'); fs.writeFileSync(file, picture.toPNG()); screenshots.push({ file, pixels: picture.getSize() }); };
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const cancel = !details.url.startsWith(origin + '/') && !details.url.startsWith('blob:') && !details.url.startsWith('data:');
    if (cancel) blocked.push(details.resourceType); callback({ cancel });
  });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(message.slice(0, 200)); });
  const deadline = setTimeout(() => { console.error('Office Electron timed out'); win.destroy(); server.close(); app.exit(1); }, 120000);
  try {
    await win.loadURL(origin);
    await read('new Promise(resolve=>{const tick=()=>window.fixtureReady?resolve():requestAnimationFrame(tick);tick()})');
    check(browserMode ? 'normal Chrome launch without sandbox bypass' : 'normal Electron sandbox enabled', win.webContents.getLastWebPreferences().sandbox);
    for (const [width, height] of [[1320, 820], [700, 600]]) for (const theme of ['light', 'dark']) {
      win.setContentSize(width, height); await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      const doc = await read('showFixture("document.docx")');
      check(`real DOCX Worker render ${width} ${theme}`, !doc.error && await read('document.querySelector(".office-document h1")?.textContent==="中文 Office Preview"'));
      check(`DOCX raster decoded ${width} ${theme}`, await read('new Promise(resolve=>{const image=document.querySelector(".office-document img");if(image.complete)resolve(image.naturalWidth===1);else{image.onload=()=>resolve(image.naturalWidth===1);image.onerror=()=>resolve(false)}})'));
      await shot(`docx-${width}-${theme}`);
      const book = await read('showFixture("workbook.xlsx")');
      check(`real XLSX Worker render ${width} ${theme}`, !book.error && await read('document.querySelectorAll("[role=tab]").length===3 && document.querySelector(".office-grid-viewport").textContent.includes("1,234.50")'));
      await shot(`xlsx-${width}-${theme}`);
      if (width === 1320 && theme === 'light') {
        await read('document.querySelector(".office-grid-viewport").focus()');
        await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' }); await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' }); await paint();
        check('real keyboard moves grid selection', await read('document.querySelector(".office-grid-cell[aria-selected=true]").textContent==="2026-11-25"'));
        const point = await read('(()=>{const r=document.querySelectorAll("[role=tab]")[2].getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
        await win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 }); await win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 }); await paint();
        check('real pointer switches to another worksheet', await read('document.querySelectorAll("[role=tab]")[2].getAttribute("aria-selected")==="true" && document.querySelector(".office-grid-viewport").textContent.includes("Row 1")'));
      }
      const csv = await read('showFixture("quoted.csv")');
      check(`real CSV Worker render ${width} ${theme}`, !csv.error && await read('document.querySelector(".office-grid-viewport").textContent.includes("中文,名字")'));
      await shot(`csv-${width}-${theme}`);
      const ppt = await read('showFixture("presentation.pptx")');
      check(`real PPTX sandbox render ${width} ${theme}`, !ppt.error && await childRead('document.querySelectorAll(".pptx-slide").length===1 && document.body.textContent.includes("Slide 1")'));
      check(`PPTX shape and image layout ${width} ${theme}`, await childRead('document.querySelectorAll("svg").length>0 && document.querySelectorAll("img").length>0'));
      check(`PPTX opaque origin ${width} ${theme}`, await read('document.querySelector("iframe").contentDocument===null'));
      check(`toolbar fits ${width} ${theme}`, await read('document.querySelector("#toolbar").scrollWidth<=innerWidth'));
      await shot(`pptx-${width}-${theme}`);
    }
    await read('document.querySelector("button[aria-label=下一页]").click()'); await paint();
    check('PPTX navigation renders genuine second slide', await childRead('document.body.textContent.includes("Slide 2") && !document.body.textContent.includes("Slide 1")'));
    await read('document.querySelector("select.office-zoom").value="150";document.querySelector("select.office-zoom").dispatchEvent(new Event("change"))'); await paint();
    check('PPTX zoom state preserved', await read('currentView.getState().scale==="150"'));
    check('oversized zoom remains scrollable from the left edge', await childRead('document.querySelector("#slides").getBoundingClientRect().left>=0'));
    await read('document.querySelector("input.office-page-input").value="1.5";document.querySelector("input.office-page-input").dispatchEvent(new Event("change"))'); await paint();
    check('fractional page input is clamped to an integer without renderer failure', await read('currentView.getState().page===0 && !lastError') && await childRead('document.body.textContent.includes("Slide 1")'));
    const attackResult = await read('showFixture("markup.pptx")');
    check('PPTX markup fixture rendered without parent execution', !attackResult.error && await read('window.hacked===undefined'));
    check('PPTX text cannot create active elements', await childRead('!document.querySelector("#slides script,#slides iframe,#slides [onerror],#slides [onload]")'));
    check('PPTX raw image text cannot create remote src', await childRead('[...document.querySelectorAll("#slides img")].every(image=>image.src.startsWith("blob:")||image.src.startsWith("data:image/"))'));
    check('PPTX projects markup as inert text without an HTML insertion sink', await childRead(`[...document.querySelectorAll('.pptx-text')].some(element=>element.textContent.includes('<img src="https://invalid.example/leak" onerror="parent.hacked=1">')) && document.querySelectorAll('#slides img').length===1 && document.querySelectorAll('#slides svg').length===2`) && !/innerHTML|outerHTML|insertAdjacentHTML|DOMParser/.test(fs.readFileSync(path.join(ROOT, 'public/file-preview/office-slides-frame.js'), 'utf8')));
    await read('cleanup()');
    check('dispose removes sandbox and toolbar', await read('!document.querySelector("iframe") && !document.querySelector("#toolbar").children.length'));
    const stats = await read('workerStats');
    check('all real parsing workers terminated', stats.started >= 17 && stats.started === stats.terminated);
    check('no external request escaped CSP and sandbox', blocked.length === 0);
    fs.writeFileSync(path.join(world, 'evidence.json'), JSON.stringify({ platform: browserMode ? 'Chrome' : 'Electron', checks, screenshots, stats, blocked, errors, requests: [...new Set(requests)], sandboxBypass: false }, null, 2));
    console.log(`Office ${browserMode ? 'Chrome' : 'Electron'}: ${checks}/${checks}; screenshots=${screenshots.length}; workers=${stats.started}/${stats.terminated}; evidence=${world}`);
  } finally { clearTimeout(deadline); win.destroy(); await new Promise(resolve => server.close(resolve)); }
  app.exit(0);
}

// Electron's default-app loader does not reliably set require.main to this
// CommonJS file. Only the explicitly fixture-scoped child may use this entry.
if (require.main === module || (process.versions.electron && process.env.OFFICE_TEST_WORLD && path.resolve(process.argv[1] || '') === __filename)) {
  if (process.versions.electron) electronTests().catch(error => { console.error(error); require('electron').app.exit(1); });
  else if (process.argv.includes('--electron')) {
    const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-office-electron-'));
    const root = path.dirname(require.resolve('electron/package.json'));
    const executable = path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(root, 'dist'), process.platform === 'win32' ? 'electron.exe' : 'electron');
    const env = { ...process.env, OFFICE_TEST_WORLD: world }; delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(executable, [__filename], { cwd: ROOT, env, stdio: 'inherit', windowsHide: false });
    child.on('error', error => { console.error(error); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; console.log('Office evidence: ' + world); });
  } else if (process.argv.includes('--browser')) {
    process.env.OFFICE_TEST_WORLD = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-office-browser-'));
    electronTests().catch(error => { console.error(error); process.exitCode = 1; });
  } else unitTests().catch(error => { console.error(error); process.exitCode = 1; });
}
