/* Deterministic, offline documents. All callers write these only into their
 * own os.tmpdir fixture. OOXML parts follow the existing parser's real shape. */
'use strict';
const zlib = require('node:zlib');
const { crc32 } = require('../../lib/zip.cjs');

function zipParts(parts) {
  const local = [], directory = [];
  let offset = 0;
  for (const [filename, content] of parts) {
    const name = Buffer.from(filename), body = Buffer.from(content);
    const compressed = zlib.deflateRawSync(body), crc = crc32(body);
    const header = Buffer.alloc(30), central = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); directory.push(central, name); offset += header.length + name.length + compressed.length;
  }
  const end = Buffer.alloc(22), central = Buffer.concat(directory);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}

function minimalPdf() {
  const text = 'BT /F1 14 Tf 72 760 Td (Attachment fixture: keep the original file.) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}endstream`,
  ];
  let content = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

function documentFiles() {
  return [
    { name: '1.主修中文成绩单.pdf', type: 'application/pdf', body: minimalPdf() },
    { name: '备忘录.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: zipParts([
      ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
      ['word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>备忘录 &amp; notes</w:t><w:tab/><w:t>原始内容</w:t></w:r></w:p></w:body></w:document>'],
    ]) },
    { name: '评审演示.pptx', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', body: zipParts([
      ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'],
      ['ppt/slides/slide1.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>Attachment fixture</a:t></p:sld>'],
    ]) },
    { name: '预算明细.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: zipParts([
      ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
      ['xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>'],
    ]) },
    { name: 'README.md', type: 'text/markdown', body: Buffer.from('# 附件说明\n保留真实名称、大小与原文。') },
    { name: '资料归档.zip', type: 'application/zip', body: zipParts([['notes.txt', 'Archive reference fixture']]) },
  ];
}

/* A real 1×1 PNG. Image tests must prove bytes, not just a .png name or MIME.
 * IHDR/IDAT/IEND CRCs are valid; decoders reject a damaged IDAT chunk. */
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
function tinyPng() { return Buffer.from(TINY_PNG_BASE64, 'base64'); }

/* A valid 58-byte 1×1 24-bit BMP with a 40-byte BITMAPINFOHEADER. The image
 * branch validates structure, so the fixture must carry a real header. */
function tinyBmp() {
  const bytes = Buffer.alloc(58);
  bytes.write('BM', 0, 'ascii');
  bytes.writeUInt32LE(58, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(1, 18);
  bytes.writeInt32LE(1, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(0, 30);
  bytes.writeUInt32LE(4, 34);
  bytes[54] = 0xff;
  return bytes;
}

/* Format-shaped, deterministic audio bytes. Uploads keep them as opaque file
 * references; no transcoding or model audio input is claimed. */
function audioFiles() {
  const id3 = Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.alloc(64)]);
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0, 'ascii'); wav.writeUInt32LE(36, 4); wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34); wav.write('data', 36, 'ascii');
  const m4a = Buffer.alloc(64);
  m4a.writeUInt32BE(32, 0); m4a.write('ftypM4A ', 4, 'ascii');
  m4a.write('M4A mp42isom', 16, 'ascii');
  const aac = Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc]), Buffer.alloc(64)]);
  const flac = Buffer.concat([Buffer.from('fLaC', 'ascii'), Buffer.alloc(64)]);
  const ogg = Buffer.concat([Buffer.from('OggS', 'ascii'), Buffer.alloc(64)]);
  const opus = Buffer.concat([Buffer.from('OggS', 'ascii'), Buffer.from('OpusHead', 'ascii'), Buffer.alloc(56)]);
  return [
    { name: '示例音频.mp3', type: 'audio/mpeg', body: id3 },
    { name: '录音.wav', type: 'audio/wav', body: wav },
    { name: '播客.m4a', type: 'audio/mp4', body: m4a },
    { name: '铃声.aac', type: 'audio/aac', body: aac },
    { name: '无损.flac', type: 'audio/flac', body: flac },
    { name: '语音.ogg', type: 'audio/ogg', body: ogg },
    { name: '语音.opus', type: 'audio/opus', body: opus },
  ];
}

function archiveFiles() {
  const rar = Buffer.concat([Buffer.from('Rar!\x1a\x07\x00', 'latin1'), Buffer.alloc(32)]);
  const seven = Buffer.concat([Buffer.from('7z\xbc\xaf\x27\x1c', 'latin1'), Buffer.alloc(32)]);
  const tar = Buffer.alloc(512);
  tar.write('notes.txt', 0, 'ascii'); tar.write('ustar', 257, 'ascii');
  const gz = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]), Buffer.alloc(32)]);
  return [
    { name: '备份.rar', type: 'application/vnd.rar', body: rar },
    { name: '归档.7z', type: 'application/x-7z-compressed', body: seven },
    { name: '归档.tar', type: 'application/x-tar', body: tar },
    { name: '日志.tar.gz', type: 'application/gzip', body: gz },
    { name: '表格.csv', type: 'text/csv', body: Buffer.from('名称,数量\n附件,2\n') },
    { name: '表格.tsv', type: 'text/tab-separated-values', body: Buffer.from('名称\t数量\n附件\t2\n') },
  ];
}

module.exports = { documentFiles, audioFiles, archiveFiles, minimalPdf, zipParts, TINY_PNG_BASE64, tinyPng, tinyBmp };
