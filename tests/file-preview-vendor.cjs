'use strict';
// Offline materializer/build-boundary tests. All generated output and injected
// failures live in os.tmpdir(); installed dependencies are only ever read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const { transformSync } = require('esbuild');
const ROOT = path.resolve(__dirname, '..');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const slash = value => value.split(path.sep).join('/');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function inventory(directory, prefix = '') {
  const found = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
    assert.equal(entry.isSymbolicLink(), false, 'generated output must not contain links');
    if (entry.isDirectory()) Object.assign(found, inventory(path.join(directory, entry.name), `${prefix}${entry.name}/`));
    else {
      const bytes = fs.readFileSync(path.join(directory, entry.name));
      found[prefix + entry.name] = { bytes: bytes.length, sha256: sha256(bytes) };
    }
  }
  return found;
}
async function browserWorker(directory, fixtures) {
  const bootstrap = path.join(directory, 'browser-worker.mjs');
  fs.writeFileSync(bootstrap, `import {parentPort,workerData} from 'node:worker_threads';
import vm from 'node:vm'; import fs from 'node:fs'; import path from 'node:path';
// A separate realm, not deletion of Node's globals (which breaks its own lazy
// undici accessors). No require, Buffer, process, module loader or network API.
const context = vm.createContext({setTimeout,clearTimeout,console,TextEncoder,TextDecoder,URL,
 fetch() { throw new Error('network forbidden in vendor test'); },
 fixtureXlsx: Array.from(new Uint8Array(workerData.fixtures.xlsx)),
 fixtureDocx: Array.from(new Uint8Array(workerData.fixtures.docx))});
vm.runInContext('self=globalThis;', context);
async function load(name) {
 const module = new vm.SourceTextModule(fs.readFileSync(path.join(workerData.base,name),'utf8'), {context});
 await module.link(() => { throw new Error('unexpected external module import'); });
 await module.evaluate(); return module.namespace;
}
try {
 const {default: Excel} = await load('exceljs.js');
 const {default: mammoth} = await load('mammoth.js');
 const {default: Papa} = await load('papaparse.js');
 vm.runInContext(fs.readFileSync(path.join(workerData.base,'pptx-preview.js'),'utf8'),context);
 const book = new Excel.Workbook(); await book.xlsx.load(vm.runInContext('Uint8Array.from(fixtureXlsx).buffer',context));
 const result = await mammoth.convertToHtml({arrayBuffer: vm.runInContext('Uint8Array.from(fixtureDocx).buffer',context)});
 const csv = Papa.parse('name,value\\n中文,0');
 let csvDisabled = false; try { void book.csv; } catch { csvDisabled = true; }
 parentPort.postMessage({sheets:book.worksheets.map(sheet=>sheet.name), cell:book.worksheets[0].getCell('B2').value,
  docx: result.value, csv:csv.data, csvDisabled, pptxInit:vm.runInContext('typeof PptxPreview.init',context),
  nodeGlobalsAbsent: vm.runInContext('typeof Buffer === "undefined" && typeof process === "undefined"',context)});
} catch(error) { parentPort.postMessage({error: String(error)}); }
`);
  const worker = new Worker(bootstrap, { execArgv: ['--experimental-vm-modules'],
    workerData: { base: path.join(directory, 'public/vendor/file-preview'), fixtures } });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('browser vendor worker deadline')), 20000);
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('message', result => { clearTimeout(timer); resolve(result); });
    });
  } finally { await worker.terminate(); }
}
function executeBuildHook({ failVendor = false } = {}) {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/build-exe.mjs'), 'utf8');
  const code = transformSync(source, { format: 'cjs', platform: 'node',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts/build-exe.mjs')).href) } }).code;
  const events = [];
  const stop = new Error('stop before asset collection; not a full build');
  const vendorFailure = new Error('fixture vendor failure');
  const fakeFs = {
    existsSync: () => false,
    mkdirSync: () => events.push('mkdir-build'),
    readdirSync: () => { events.push('collect-assets'); throw stop; },
  };
  const childProcess = { execFileSync(executable, args, options) {
    assert.equal(executable, process.execPath);
    assert.equal(options.cwd, ROOT);
    assert.equal(options.stdio, 'inherit');
    const script = path.basename(args[0]);
    events.push(script);
    if (script === 'sync-preview-vendor.mjs' && failVendor) throw vendorFailure;
    if (!['sync-preview-vendor.mjs', 'sync-xterm.mjs'].includes(script)) throw new Error('unexpected process in hook test');
  } };
  const imports = { 'node:fs': fakeFs, 'node:path': path, 'node:url': require('node:url'),
    'node:child_process': childProcess, esbuild: {},
    './util.mjs': { clearDir: () => events.push('clear-build') },
    './node-pty-package.mjs': { stageNodePty: () => { throw new Error('must not build PTY'); } } };
  assert.throws(() => vm.runInNewContext(code, { process: { argv: [process.execPath, 'build-exe.mjs'], execPath: process.execPath },
    require(name) { if (!(name in imports)) throw new Error('unexpected import: ' + name); return imports[name]; }, console }),
  error => error === (failVendor ? vendorFailure : stop));
  return events;
}

async function main() {
  let passed = 0;
  const check = async (label, fn) => { await fn(); passed++; console.log('PASS ' + label); };
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-preview-vendor-test-'));
  const moduleRoot = fs.realpathSync(path.join(ROOT, 'node_modules'));
  const { materializePreviewVendor, checkedPath } = await import(pathToFileURL(path.join(ROOT, 'scripts/sync-preview-vendor.mjs')));
  try {
    fs.mkdirSync(path.join(fixture, 'scripts'));
    for (const file of ['preview-browser-globals.mjs', 'sync-preview-vendor.mjs']) {
      fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(fixture, 'scripts', file));
    }
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(fixture, 'package.json'));
    fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(fixture, 'package-lock.json'));
    fs.symlinkSync(moduleRoot, path.join(fixture, 'node_modules'), 'junction');
    await check('clean dependency installation generates ignored vendor assets without a second CI test list', () => {
      const pkg = readJson(path.join(ROOT, 'package.json'));
      assert.equal(pkg.scripts.postinstall, 'npm run sync:preview');
      assert.equal(pkg.scripts['sync:preview'], 'node scripts/sync-preview-vendor.mjs');
      const { status, stdout } = require('node:child_process').spawnSync('git', ['check-ignore', '--stdin'], {
        cwd: ROOT, input: 'public/vendor/file-preview/pptx-preview.js\npublic/vendor/file-preview/versions.json\n', encoding: 'utf8', windowsHide: true,
      });
      assert.equal(status, 0);
      assert.deepEqual(stdout.trim().split(/\r?\n/), ['public/vendor/file-preview/pptx-preview.js', 'public/vendor/file-preview/versions.json']);
    });
    const output = path.join(fixture, 'public/vendor/file-preview');
    let cliSummary;
    await check('installation command creates the complete vendor tree from a clean TEMP checkout', () => {
      assert.equal(fs.existsSync(output), false);
      const cli = require('node:child_process').spawnSync(process.execPath, ['scripts/sync-preview-vendor.mjs'], {
        cwd: fixture, env: { ...process.env, PI_GUI_OFFLINE: '1', PI_OFFLINE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 60000,
      });
      assert.ifError(cli.error);
      assert.equal(cli.status, 0, cli.stderr);
      assert.match(cli.stderr, /Preview license review remains REQUIRED/);
      cliSummary = JSON.parse(cli.stdout.trim().replace(/^preview vendor: /, ''));
      assert.deepEqual(cliSummary.legalReviewRequired, ['pptx-preview@1.0.7']);
      assert.ok(fs.statSync(path.join(output, 'pptx-preview.js')).size > 0);
      assert.ok(fs.statSync(path.join(output, 'pdf.worker.mjs')).size > 0);
    });
    const first = await materializePreviewVendor({ root: fixture });
    assert.deepEqual(first, cliSummary, 'installation CLI and direct materializer must have identical output identity');
    const before = inventory(output);
    const manifestBytes = fs.readFileSync(path.join(output, 'versions.json'));
    const manifest = JSON.parse(manifestBytes);
    const second = await materializePreviewVendor({ root: fixture });
    await check('two real source materializations are byte-for-byte deterministic', () => {
      assert.deepEqual(inventory(output), before);
      assert.deepEqual(second, first);
      assert.equal(first.manifestSha256, sha256(manifestBytes));
      assert.equal(first.files, Object.keys(before).length);
      assert.equal(first.bytes, Object.values(before).reduce((sum, file) => sum + file.bytes, 0));
    });
    await check('a different temporary root/junction produces the identical bundle and manifest', async () => {
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-preview-vendor-second-root-'));
      try {
        fs.mkdirSync(path.join(other, 'scripts'));
        for (const file of ['package.json', 'package-lock.json', 'scripts/preview-browser-globals.mjs']) fs.copyFileSync(path.join(fixture, file), path.join(other, file));
        fs.symlinkSync(moduleRoot, path.join(other, 'node_modules'), 'junction');
        assert.deepEqual(await materializePreviewVendor({ root: other }), first);
        assert.deepEqual(inventory(path.join(other, 'public/vendor/file-preview')), before);
      } finally { fs.rmSync(other, { recursive: true, force: true }); }
    });
    await check('every shipped asset has the declared actual size and digest', () => {
      const { 'versions.json': self, ...assets } = before;
      assert.ok(self.bytes > 0);
      assert.deepEqual(manifest.files, assets);
      for (const name of Object.keys(assets)) assert.equal(slash(path.relative(output, checkedPath(output, name))), name);
    });
    await check('direct versions and every source package are tied to the real installed lockfile', () => {
      const lock = readJson(path.join(ROOT, 'package-lock.json'));
      for (const [id, pkg] of Object.entries(manifest.versions.packages)) {
        assert.equal(id, `${pkg.name}@${pkg.version}`);
        for (const instance of pkg.instances) {
          assert.equal(lock.packages[instance.path].version, pkg.version);
          assert.equal(instance.integrity, lock.packages[instance.path].integrity || null);
          assert.equal(readJson(path.join(ROOT, instance.path, 'package.json')).version, pkg.version);
        }
      }
      for (const [name, version] of Object.entries(manifest.versions.direct)) {
        assert.equal(readJson(path.join(ROOT, 'node_modules', name, 'package.json')).version, version);
      }
    });
    await check('scoped overrides are used in the actual ExcelJS/PPTX bundle inputs', () => {
      assert.deepEqual(manifest.versions.resolvedOverrides, { exceljs: { uuid: '11.1.1' }, 'pptx-preview': { uuid: '11.1.1', echarts: '6.1.0' } });
      for (const asset of ['exceljs.js', 'pptx-preview.js']) {
        assert.ok(manifest.bundles[asset].packages.includes('uuid@11.1.1'));
        assert.deepEqual(manifest.bundles[asset].packages.filter(id => id.startsWith('uuid@')), ['uuid@11.1.1']);
      }
      assert.ok(manifest.bundles['pptx-preview.js'].packages.includes('echarts@6.1.0'));
      assert.deepEqual(manifest.bundles['pptx-preview.js'].packages.filter(id => id.startsWith('echarts@')), ['echarts@6.1.0']);
    });
    await check('source graph rejects opaque ExcelJS, JSZip and ECharts prebundles', () => {
      for (const asset of ['mammoth.js', 'exceljs.js', 'pptx-preview.js']) {
        const sources = manifest.bundles[asset].inputs;
        assert.ok(sources.some(file => file.includes('jszip/lib/index.js')));
        assert.ok(!sources.some(file => /\/(?:exceljs|jszip|echarts)\/dist\//.test(file)));
      }
      assert.ok(manifest.bundles['exceljs.js'].inputs.includes('node_modules/exceljs/lib/doc/workbook.js'));
      assert.ok(manifest.bundles['pptx-preview.js'].inputs.includes('node_modules/echarts/index.js'));
      assert.ok(manifest.bundles['pptx-preview.js'].inputs.includes('node_modules/pptx-preview/dist/pptx-preview.es.js'));
    });
    await check('every recorded source is within its declared root and has its real digest', () => {
      for (const [name, info] of Object.entries(manifest.inputs)) {
        assert.ok(name.startsWith('node_modules/') || name === 'scripts/preview-browser-globals.mjs');
        const file = name.startsWith('node_modules/') ? checkedPath(moduleRoot, name.slice('node_modules/'.length)) : checkedPath(fixture, name);
        const bytes = fs.readFileSync(file);
        assert.equal(bytes.length, info.bytes);
        assert.equal(sha256(bytes), info.sha256);
        if (name.startsWith('node_modules/')) assert.ok(manifest.versions.packages[info.package]);
      }
    });
    await check('LICENSE and NOTICE coexist without dropping font/wasm subcomponent licenses', () => {
      const echarts = manifest.versions.packages['echarts@6.1.0'];
      assert.ok(echarts.legalFiles.some(file => file.endsWith('/LICENSE')));
      assert.ok(echarts.legalFiles.some(file => file.endsWith('/NOTICE')));
      const pdf = manifest.versions.packages['pdfjs-dist@' + manifest.versions.direct['pdfjs-dist']];
      for (const suffix of ['/cmaps/LICENSE', '/standard_fonts/LICENSE_FOXIT', '/standard_fonts/LICENSE_LIBERATION', '/wasm/LICENSE_OPENJPEG', '/wasm/LICENSE_QCMS']) {
        assert.ok(pdf.legalFiles.some(file => file.endsWith(suffix)), suffix);
      }
      for (const pkg of Object.values(manifest.versions.packages)) for (const file of pkg.legalFiles) assert.ok(manifest.files[file]);
    });
    await check('KaTeX font copyright/RFN and complete OFL are separate from its MIT code license', () => {
      const pkg = manifest.versions.packages['katex@' + manifest.versions.direct.katex];
      assert.equal(pkg.license, 'MIT');
      assert.equal(pkg.fontLicense.license, 'OFL-1.1');
      const notices = readJson(path.join(output, pkg.fontLicense.notices));
      const fonts = Object.keys(manifest.copied).filter(file => file.startsWith('fonts/') && file.endsWith('.ttf'));
      assert.equal(Object.keys(notices).length, fonts.length);
      assert.equal(pkg.fontLicense.fontCount, fonts.length);
      for (const name of fonts) {
        const font = fs.readFileSync(path.join(output, name));
        assert.equal(sha256(font), notices[name].sha256);
        assert.ok(notices[name].records.some(record => record.nameId === 0 && record.text.includes('Copyright')));
        assert.ok(notices[name].records.some(record => record.nameId === 13 && record.text.includes('Reserved Font Name')));
        for (const record of notices[name].records) {
          const utf16 = Buffer.from(record.text, 'utf16le'); utf16.swap16();
          assert.ok(font.includes(utf16) || font.includes(Buffer.from(record.text, 'latin1')));
        }
      }
      const license = fs.readFileSync(path.join(output, `licenses/${encodeURIComponent('katex@' + pkg.version)}/fonts/OFL-1.1.txt`));
      assert.equal(license.length, 4128);
      assert.equal(sha256(license), 'ebc109078c06f79af74cf2b27454c262830d12a65749f0e2bf25d1ac1db7a02a');
      assert.match(license.toString(), /5\) The Font Software/);
      assert.match(license.toString(), /DISCLAIMER/);
    });
    await check('same-name versions retain independent identity, legal text and provenance', () => {
      const ids = Object.keys(manifest.versions.packages).filter(id => id.startsWith('@xmldom/xmldom@'));
      assert.ok(ids.length >= 2);
      assert.equal(new Set(ids.flatMap(id => manifest.versions.packages[id].legalFiles)).size,
        ids.flatMap(id => manifest.versions.packages[id].legalFiles).length);
      for (const id of ids) {
        const file = `licenses/${encodeURIComponent(id)}/provenance.json`;
        assert.equal(readJson(path.join(output, file)).version, manifest.versions.packages[id].version);
      }
    });
    await check('PPTX ISC conflict is explicit and archived upstream bytes are authentic, not a template', () => {
      const pkg = manifest.versions.packages['pptx-preview@1.0.7'];
      assert.equal(pkg.license, 'ISC');
      assert.match(pkg.licenseStatus, /^unresolved:/);
      assert.deepEqual(manifest.legalReviewRequired, ['pptx-preview@1.0.7']);
      const bytes = fs.readFileSync(path.join(output, 'licenses/pptx-preview%401.0.7/UPSTREAM-LICENSE.txt'));
      assert.equal(bytes.length, 200);
      assert.match(bytes.toString('utf8'), /源码仅供个人学习使用/);
      assert.doesNotMatch(bytes.toString('utf8'), /Permission to use|Copyright \(c\)/);
      assert.equal(sha256(bytes), pkg.upstreamNotice.sha256);
      assert.equal(pkg.upstreamNotice.gitBlob, 'f2d9e1ed347b274e9b8e0b552058fb8b0a9889fb');
      assert.match(pkg.upstreamNotice.url, /b9bb0460a426ffe155487ee124ad9d57fd9c4c51\/LICENSE$/);
    });
    await check('saxes npm omission is repaired with complete pinned upstream copyright/ISC text', () => {
      const pkg = manifest.versions.packages['saxes@5.0.1'];
      const bytes = fs.readFileSync(path.join(output, 'licenses/saxes%405.0.1/UPSTREAM-LICENSE.txt'));
      assert.equal(bytes.length, 3011);
      assert.match(bytes.toString(), /Copyright \(c\) Contributors/);
      assert.match(bytes.toString(), /Isaac Z\. Schlueter and Contributors/);
      assert.equal(pkg.upstreamNotice.gitBlob, '187f3ba399862022f4e670b2a3a1dbc6d7e6a800');
      assert.equal(sha256(bytes), pkg.upstreamNotice.sha256);
    });
    await check('local PDF worker, CMaps, fonts, wasm and ICC assets are complete byte copies', () => {
      for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
        const source = path.join(moduleRoot, 'pdfjs-dist', folder);
        assert.deepEqual(inventory(path.join(output, 'pdf', folder)), inventory(source));
      }
      assert.equal(sha256(fs.readFileSync(path.join(output, 'pdf.worker.mjs'))), sha256(fs.readFileSync(path.join(moduleRoot, 'pdfjs-dist/build/pdf.worker.mjs'))));
      assert.deepEqual(inventory(path.join(output, 'fonts')), inventory(path.join(moduleRoot, 'katex/dist/fonts')));
      const css = fs.readFileSync(path.join(output, 'katex.css'), 'utf8');
      for (const [, font] of css.matchAll(/url\(([^)]+)\)/g)) {
        assert.ok(!/^(?:https?:|data:|\/)/i.test(font));
        assert.ok(fs.statSync(checkedPath(output, font)).isFile());
      }
    });
    await check('browser-like worker parses real XLSX/DOCX/CSV without Node globals or network', async () => {
      const { xlsxBytes, zipParts, docxParts } = require('./file-preview-office.cjs');
      const xlsx = await xlsxBytes();
      const docx = zipParts(docxParts());
      const result = await browserWorker(fixture, { xlsx: xlsx.buffer.slice(xlsx.byteOffset, xlsx.byteOffset + xlsx.byteLength), docx: docx.buffer.slice(docx.byteOffset, docx.byteOffset + docx.byteLength) });
      assert.equal(result.error, undefined);
      assert.equal(result.nodeGlobalsAbsent, true);
      assert.ok(result.sheets.includes('中文数据'));
      assert.equal(result.cell, 1234.5);
      assert.match(result.docx, /中文 Office Preview/);
      assert.deepEqual(result.csv[1], ['中文', '0']);
      assert.equal(result.csvDisabled, true);
      assert.equal(result.pptxInit, 'function');
    });
    await check('failed lockfile verification preserves the previously published tree', async () => {
      const file = path.join(fixture, 'package-lock.json');
      const bytes = fs.readFileSync(file);
      const lock = JSON.parse(bytes);
      lock.packages['node_modules/fflate'].version = '0.0.0';
      fs.writeFileSync(file, JSON.stringify(lock));
      await assert.rejects(materializePreviewVendor({ root: fixture }), /lockfile mismatch/);
      assert.deepEqual(inventory(output), before);
      fs.writeFileSync(file, bytes);
    });
    await check('unapplied overrides are fatal before publication', async () => {
      const file = path.join(fixture, 'package.json');
      const bytes = fs.readFileSync(file);
      const pkg = JSON.parse(bytes); pkg.overrides.exceljs.uuid = '0.0.0';
      fs.writeFileSync(file, JSON.stringify(pkg));
      await assert.rejects(materializePreviewVendor({ root: fixture }), /override mismatch/);
      assert.deepEqual(inventory(output), before);
      fs.writeFileSync(file, bytes);
    });
    await check('asset paths reject parent, absolute, Windows drive and alternate separator escapes', () => {
      for (const name of ['../outside', '/outside', 'a/../../outside', 'C:/outside', 'a\\..\\outside', 'a//outside', './outside', 'a/./outside', 'a:stream']) {
        assert.throws(() => checkedPath(fixture, name), /unsafe|escapes/);
      }
    });
    await check('output symlink/junction escapes fail without touching their target', async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-preview-vendor-outside-'));
      const victim = path.join(outside, 'keep.txt'); fs.writeFileSync(victim, 'unchanged');
      fs.rmSync(output, { recursive: true, force: true });
      fs.symlinkSync(outside, output, 'junction');
      try {
        await assert.rejects(materializePreviewVendor({ root: fixture }), /contains a link/);
        assert.equal(fs.readFileSync(victim, 'utf8'), 'unchanged');
        assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
      } finally { fs.unlinkSync(output); fs.rmSync(outside, { recursive: true, force: true }); }
    });
    await check('dependency links cannot escape the canonical node_modules read boundary', async () => {
      const malicious = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-preview-vendor-module-'));
      try {
        fs.mkdirSync(path.join(malicious, 'node_modules'));
        for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, file), path.join(malicious, file));
        fs.symlinkSync(path.join(moduleRoot, 'fflate'), path.join(malicious, 'node_modules/fflate'), 'junction');
        await assert.rejects(materializePreviewVendor({ root: malicious }), /escapes node_modules/);
        assert.equal(fs.existsSync(path.join(malicious, 'public')), false);
      } finally { fs.rmSync(malicious, { recursive: true, force: true }); }
    });
    await check('build hook runs materialization before deleting old build and collecting assets', () => {
      assert.deepEqual(executeBuildHook(), ['sync-preview-vendor.mjs', 'clear-build', 'mkdir-build', 'sync-xterm.mjs', 'collect-assets']);
    });
    await check('materializer failure aborts build before cleanup/xterm/assets (no full build)', () => {
      assert.deepEqual(executeBuildHook({ failVendor: true }), ['sync-preview-vendor.mjs']);
    });
    console.log(`Vendor tests: ${passed}/${passed}; files=${first.files}; bytes=${first.bytes}; manifest=${first.manifestSha256}; tree=${first.treeSha256}`);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
