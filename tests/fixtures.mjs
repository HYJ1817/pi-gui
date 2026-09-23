/* 生成测试用的中文 docx，并用 LibreOffice 转出 PDF，然后验证两个抽取器。
 * 只在开发时跑，不属于产品代码。 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { extractDocx, extractPdf, extract } from '../lib/extract.js';

/* ---------- 最小 ZIP 写入器 ---------- */
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const raw = Buffer.from(data, 'utf8');
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const crc = zlib.crc32(raw);
    const nameBuf = Buffer.from(name, 'utf8');

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x2821, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x2821, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/* ---------- 造一个中文 docx ---------- */
const PARAS = [
  '发酵罐空气分布器的设计参数核算',
  '一、设计依据',
  '依据《发酵工程设备设计手册》第 3 版，通风发酵罐采用单管式空气分布器，',
  '出口气速取 10～15 m/s，管口距罐底 40 mm，罐底设置防冲刷钢板。',
  '二、结构参数',
  '罐体公称容积 V = 50 m³，装料系数 η = 0.75，实际装液量 37.5 m³。',
  '通气量 Q = 1.2 vvm，则标准状态下空气流量为 0.75 m³/s。',
  '空气分布器出口内径 d = √(4Q / (π·v))，取 v = 12 m/s，计算得 d ≈ 0.282 m。',
  '圆整后取 DN300 无缝钢管，壁厚 6 mm。',
  '三、结论',
  '轴承与联轴器仅保留选用及布置说明，删去具体设计计算；',
  '空气分布器补全结构、尺寸和通气核算，并检查其与下层叶轮、蛇管及排料口的位置关系。',
  '特殊字符测试：<尖括号> & "双引号" \'单引号\' — 破折号 · 间隔号',
];

const docXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:body>' +
  PARAS.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</w:t></w:r></w:p>`).join('') +
  '</w:body></w:document>';

const contentTypes =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const rels =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

const tmp = path.join(os.tmpdir(), 'pi-gui-fixtures');
fs.mkdirSync(tmp, { recursive: true });

const docxPath = path.join(tmp, '发酵罐空气分布器设计.docx');
fs.writeFileSync(
  docxPath,
  zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: docXml },
  ])
);
console.log('已生成 docx: ' + docxPath + '  (' + fs.statSync(docxPath).size + ' 字节)');

/* ---------- 1b. 造一张 PNG ----------
 *
 * app-check.cjs 的「图片识别为 image」要一张真图。早先这张图是手工丢进
 * 固件目录的，于是默认跑测试时那条上传路径会被静默跳过（断言外面套了
 * existsSync 判断）。这里顺手生成，覆盖就不再依赖人工文件。 */
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0; // 每行的过滤器字节：none
    for (let x = 0; x < w; x++) {
      const p = row + 1 + x * 3;
      raw[p] = rgb[0];
      raw[p + 1] = rgb[1];
      raw[p + 2] = rgb[2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 颜色类型：真彩色
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const pngPath = path.join(tmp, 'red.png');
fs.writeFileSync(pngPath, png(24, 24, [220, 60, 50]));
console.log('已生成 png: ' + pngPath + '  (' + fs.statSync(pngPath).size + ' 字节)');

/* ---------- 1. 测 docx 抽取 ---------- */
const r1 = extractDocx(fs.readFileSync(docxPath));
console.log('\n=== docx 抽取 ===');
console.log('长度: ' + r1.text.length + ' 字符');
console.log('前 200 字: ' + JSON.stringify(r1.text.slice(0, 200)));
const hits1 = PARAS.filter((p) => r1.text.includes(p));
console.log('段落命中: ' + hits1.length + '/' + PARAS.length);
if (hits1.length !== PARAS.length) {
  console.log('未命中: ' + JSON.stringify(PARAS.filter((p) => !r1.text.includes(p))));
}

/* ---------- 2. 转 PDF 并测 PDF 抽取 ---------- */
const soffice = 'C:/Program Files/LibreOffice/program/soffice.exe';
if (fs.existsSync(soffice)) {
  console.log('\n=== 用 LibreOffice 转 PDF ===');
  try {
    execFileSync(soffice, ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', tmp, docxPath], {
      stdio: 'ignore',
      timeout: 120000,
    });
    const pdfPath = path.join(tmp, '发酵罐空气分布器设计.pdf');
    if (!fs.existsSync(pdfPath)) throw new Error('转换后没有找到 PDF');
    console.log('已生成 PDF: ' + fs.statSync(pdfPath).size + ' 字节');

    const r2 = await extractPdf(fs.readFileSync(pdfPath));
    console.log('\n=== PDF 抽取（中文） ===');
    console.log('页数: ' + r2.pages + '，长度: ' + r2.text.length + ' 字符');
    console.log('前 200 字: ' + JSON.stringify(r2.text.slice(0, 200)));
    const hits2 = PARAS.filter((p) => r2.text.includes(p));
    console.log('段落命中: ' + hits2.length + '/' + PARAS.length);
    if (hits2.length !== PARAS.length) {
      console.log('未命中: ' + JSON.stringify(PARAS.filter((p) => !r2.text.includes(p))));
    }
  } catch (e) {
    console.log('PDF 环节失败: ' + e.message);
  }
} else {
  console.log('\n跳过 PDF 测试：没找到 LibreOffice');
}

/* ---------- 3. 测统一入口 ---------- */
console.log('\n=== extract() 统一入口 ===');
for (const [f, n] of [
  [docxPath, '发酵罐空气分布器设计.docx'],
  [path.join(tmp, 'nope.bin'), 'unknown.bin'],
]) {
  try {
    const r = await extract(f, n);
    console.log(`${n} → kind=${r.kind}${r.text ? ', ' + r.text.length + ' 字符' : ''}`);
  } catch (e) {
    console.log(`${n} → 抛错: ${e.message}`);
  }
}
