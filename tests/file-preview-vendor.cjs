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
 const book = new Excel.Workbook(); await book.xlsx.load(vm.runInContext('Uint8Array.from(fixtureXlsx).buffer',context));
 const result = await mammoth.convertToHtml({arrayBuffer: vm.runInContext('Uint8Array.from(fixtureDocx).buffer',context)});
 const csv = Papa.parse('name,value\\n中文,0');
 let csvDisabled = false; try { void book.csv; } catch { csvDisabled = true; }
 parentPort.postMessage({sheets:book.worksheets.map(sheet=>sheet.name), cell:book.worksheets[0].getCell('B2').value,
  docx: result.value, csv:csv.data, csvDisabled, pptxGlobalAbsent:vm.runInContext('typeof PptxPreview === "undefined"',context),
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
  const { materializePreviewVendor: materialize, checkedPath, extractPakoZlibNotice } = await import(pathToFileURL(path.join(ROOT, 'scripts/sync-preview-vendor.mjs')));
  const fonts = await import(pathToFileURL(path.join(ROOT, 'scripts/preview-font-source.mjs')));
  const emptyCache = path.join(fixture, 'font-source-cache');
  const materializePreviewVendor = options => materialize({ fontSourceCache: emptyCache, ...options });
  try {
    fs.mkdirSync(path.join(fixture, 'scripts'));
    for (const file of ['preview-browser-globals.mjs', 'sync-preview-vendor.mjs', 'preview-font-source.mjs']) {
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
    // Old node_modules may still contain the excluded package. Generation must
    // not inspect it, even when it is installed and inaccessible to JS readers.
    fs.writeFileSync(path.join(fixture, 'deny-restricted-package.mjs'), `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
for (const name of ['readFileSync','readdirSync','existsSync','statSync','lstatSync','realpathSync']) {
 const original=fs[name];
 const checked=(file,...args)=>{ if (/(?:^|[\\\\/])pptx-preview(?:[\\\\/]|$)/.test(String(file))) throw new Error('restricted package filesystem access'); return original(file,...args); };
 if (original.native) checked.native=(file,...args)=>{ if (/(?:^|[\\\\/])pptx-preview(?:[\\\\/]|$)/.test(String(file))) throw new Error('restricted package filesystem access'); return original.native(file,...args); };
 fs[name]=checked;
}
syncBuiltinESMExports();
`);
    let cliSummary;
    await check('installation command creates the complete vendor tree from a clean TEMP checkout', () => {
      assert.equal(fs.existsSync(output), false);
      const cli = require('node:child_process').spawnSync(process.execPath, ['--import', './deny-restricted-package.mjs', 'scripts/sync-preview-vendor.mjs'], {
        cwd: fixture, env: { ...process.env, PI_GUI_OFFLINE: '1', PI_OFFLINE: '1', PI_GUI_THIRD_PARTY_CACHE: emptyCache }, encoding: 'utf8', windowsHide: true, timeout: 60000,
      });
      assert.ifError(cli.error);
      assert.equal(cli.status, 0, cli.stderr);
      assert.match(cli.stderr, /license review remains REQUIRED/);
      assert.match(cli.stderr, /source correspondence is unresolved/);
      assert.doesNotMatch(cli.stdout + cli.stderr, /redistribution approved|release approved/i);
      cliSummary = JSON.parse(cli.stdout.trim().replace(/^preview vendor: /, ''));
      assert.equal(cliSummary.legalReviewRequired.length, 2);
      assert.match(cliSummary.legalReviewRequired[1], /archives missing/);
      assert.equal(fs.existsSync(path.join(output, 'pptx-preview.js')), false);
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
    await check('scoped overrides remain effective for ExcelJS without retaining removed PPTX owners', () => {
      assert.deepEqual(manifest.versions.resolvedOverrides, { exceljs: { uuid: '11.1.1' } });
      assert.deepEqual(manifest.versions.overrides, { exceljs: { uuid: '11.1.1' } });
      assert.ok(manifest.bundles['exceljs.js'].packages.includes('uuid@11.1.1'));
      assert.deepEqual(manifest.bundles['exceljs.js'].packages.filter(id => id.startsWith('uuid@')), ['uuid@11.1.1']);
      assert.equal(manifest.bundles['pptx-preview.js'], undefined);
      assert.ok(!Object.keys(manifest.versions.packages).some(id => /^(?:pptx-preview|echarts|zrender|tslib|lodash)@/.test(id)));
    });
    await check('source graph rejects opaque ExcelJS, JSZip and removed PPTX/ECharts prebundles', () => {
      for (const asset of ['mammoth.js', 'exceljs.js']) {
        const sources = manifest.bundles[asset].inputs;
        assert.ok(sources.some(file => file.includes('jszip/lib/index.js')));
        assert.ok(!sources.some(file => /\/(?:exceljs|jszip|echarts)\/dist\//.test(file)));
      }
      assert.ok(manifest.bundles['exceljs.js'].inputs.includes('node_modules/exceljs/lib/doc/workbook.js'));
      assert.ok(!Object.keys(manifest.inputs).some(file => /\/(?:pptx-preview|echarts|zrender|tslib|lodash)\//.test(file)));
      assert.doesNotMatch(manifestBytes.toString(), /pptx-preview|echarts|zrender/);
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
    await check('MIT and embedded Zlib notices coexist without dropping font/wasm subcomponent licenses', () => {
      const pako = manifest.versions.packages['pako@1.0.11'];
      assert.ok(pako.legalFiles.some(file => file.endsWith('/LICENSE')));
      assert.ok(pako.legalFiles.some(file => file.endsWith('/ZLIB-NOTICE.txt')));
      const pdf = manifest.versions.packages['pdfjs-dist@' + manifest.versions.direct['pdfjs-dist']];
      for (const suffix of ['/cmaps/LICENSE', '/standard_fonts/LICENSE_FOXIT', '/standard_fonts/LICENSE_LIBERATION', '/wasm/LICENSE_OPENJPEG', '/wasm/LICENSE_QCMS']) {
        assert.ok(pdf.legalFiles.some(file => file.endsWith(suffix)), suffix);
      }
      for (const pkg of Object.values(manifest.versions.packages)) for (const file of pkg.legalFiles) assert.ok(manifest.files[file]);
    });
    await check('PDF font verification is pinned into the manifest with its compliance evidence', () => {
      const pdf = manifest.versions.packages['pdfjs-dist@' + manifest.versions.direct['pdfjs-dist']];
      const review = pdf.fontLicenseReview;
      // Authentic 1.07.4 source contains SFD/build scripts. Current PDF.js TTFs
      // differ from the preserved TTF release, so neither metadata nor archive
      // availability is proof that corresponding-source obligations are met.
      assert.equal(review.sourceDistributionVerified, false);
      assert.equal(review.correspondence, 'unresolved');
      assert.equal(review.archives.source.included, false);
      assert.equal(review.archives.binary.included, false);
      assert.ok(pdf.legalFiles.includes(review.noticeFile));
      assert.ok(pdf.legalFiles.includes(review.identityFile));
      assert.match(fs.readFileSync(path.join(output, review.noticeFile), 'utf8'), /NOT INCLUDED — release blocked/);
      assert.equal(review.license, 'GPLv2 with Liberation font exceptions');
      assert.equal(review.fontVersion, '1.07.4');
      assert.equal(review.verification, 'docs/pdf-font-license-verification.md');
      assert.equal(review.files.length, 4);
      assert.deepEqual(review.files, Object.keys(manifest.copied).filter(file => /^pdf\/standard_fonts\/LiberationSans-[^/]+\.ttf$/.test(file)).sort(compare));
      assert.ok(pdf.legalFiles.includes(review.licenseFile));
      const license = fs.readFileSync(path.join(output, review.licenseFile), 'utf8');
      assert.match(license, /GNU General Public License v\.2/);
      assert.match(license, /physical product/);
      for (const file of review.files) assert.ok(manifest.files[file] && manifest.inputs[manifest.copied[file]]);
      assert.deepEqual(manifest.legalReviewRequired, cliSummary.legalReviewRequired);
      assert.match(manifest.legalReviewRequired[0], /source correspondence is unresolved/);
    });
    await check('real App notice-writing block retains complete font terms, copyright and source retrieval status', () => {
      const script = fs.readFileSync(path.join(ROOT, 'scripts/build-app.mjs'), 'utf8');
      const start = script.indexOf("fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(STAGE, 'LICENSE'));");
      const end = script.indexOf('console.log(`  应用目录', start);
      assert.ok(start >= 0 && end > start, 'identify the real notice-writing block; never execute a full App build');
      const stage = path.join(fixture, 'app-notice-fixture'); fs.mkdirSync(stage);
      const license = path.join(moduleRoot, 'pdfjs-dist/LICENSE');
      vm.runInNewContext(script.slice(start, end), { fs, path, ROOT, STAGE: stage,
        pdfjsVersion: fonts.FONT_REVIEW.pdfjsVersion, stagedPty: { version: 'fixture' }, xtermVersion: 'fixture', fitVersion: 'fixture',
        pdfjsLicense: license, ptyLicense: license, xtermLicensePath: license, fitLicensePath: license,
        fontDistributionNotice: () => fonts.fontDistributionNotice(output) });
      const notice = fs.readFileSync(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
      assert.match(notice, /Apache-2.0 不覆盖随附字体/);
      assert.match(notice, /SOURCE-INFO\.txt；原文中的 .* 均相对该目录，不是本通知所在的 App 根目录/, 'root notice states where its relative references resolve');
      assert.match(notice, /Copyright \(c\) 2007 Red Hat/);
      assert.match(notice, /NOT INCLUDED — release blocked/);
      for (const spec of Object.values(fonts.FONT_REVIEW.archives)) { assert.ok(notice.includes(spec.url)); assert.ok(notice.includes(spec.sha256)); }
      assert.ok(notice.includes(fs.readFileSync(path.join(output, 'pdf/standard_fonts/LICENSE_LIBERATION'), 'utf8')));
      assert.throws(() => fonts.fontDistributionNotice(stage), /ENOENT/);
    });
    await check('all four PDF.js font identities use complete SHA256, not version strings or hash prefixes', () => {
      for (const [name, pin] of Object.entries(fonts.FONT_REVIEW.fonts)) {
        const file = 'pdf/standard_fonts/' + name;
        assert.equal(manifest.files[file].sha256, pin.sha256);
        assert.equal(manifest.files[file].bytes, pin.bytes);
        assert.notEqual(pin.sha256, pin.upstreamSha256, 'do not claim binary-release identity');
      }
    });
    await check('PDF version/integrity, font inventory, license and every font byte fail closed automatically', () => {
      const files = Object.fromEntries([...Object.keys(fonts.FONT_REVIEW.assets), ...Object.keys(fonts.FONT_REVIEW.fonts).map(name => 'pdf/standard_fonts/' + name)].map(name => [name, fs.readFileSync(path.join(output, name))]));
      const identity = { version: fonts.FONT_REVIEW.pdfjsVersion, integrity: fonts.FONT_REVIEW.npmIntegrity, files };
      fonts.verifyPdfFontIdentity(identity);
      for (const key of ['version', 'integrity']) assert.throws(() => fonts.verifyPdfFontIdentity({ ...identity, [key]: 'changed' }), /re-verification required/);
      for (const name of Object.keys(files)) {
        assert.throws(() => fonts.verifyPdfFontIdentity({ ...identity, files: { ...files, [name]: Buffer.concat([files[name], Buffer.from('changed')]) } }), /re-verification required/);
      }
      const missing = { ...files }; delete missing['pdf/standard_fonts/LiberationSans-Regular.ttf'];
      for (const changed of [missing, { ...files, 'pdf/standard_fonts/Other.ttf': Buffer.from('new') }]) assert.throws(() => fonts.verifyPdfFontIdentity({ ...identity, files: changed }), /inventory changed/);
    });
    await check('production materializer refuses changed PDF font bytes before replacing existing vendor output', async () => {
      const original = fs.readFileSync, source = path.join(moduleRoot, 'pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf');
      fs.readFileSync = function(file, ...args) {
        const bytes = original(file, ...args);
        if (typeof file !== 'string' || path.resolve(file) !== source) return bytes;
        const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; return changed;
      };
      try {
        await assert.rejects(materializePreviewVendor({ root: fixture }), /font bytes changed/);
        assert.deepEqual(inventory(output), before);
      } finally { fs.readFileSync = original; }
    });
    await check('missing cache stays offline and corrupt cache cannot produce compliance metadata or replace good output', async () => {
      const originalFetch = global.fetch;
      global.fetch = () => { throw new Error('network forbidden'); };
      try {
        await assert.rejects(fonts.prepareFontArchives({ cacheDir: emptyCache }), /missing font source cache/);
        const spec = fonts.FONT_REVIEW.archives.source, cacheFile = fonts.archiveCachePath(emptyCache, spec);
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, 'corrupt');
        assert.throws(() => fonts.fontSourceMaterials({ cacheDir: emptyCache }), /not a pinned regular file/);
        await assert.rejects(materializePreviewVendor({ root: fixture }), /not a pinned regular file/);
        assert.deepEqual(inventory(output), before);
        fs.unlinkSync(cacheFile);
      } finally { global.fetch = originalFetch; }
    });
    await check('failed explicit archive import/download never writes an unverified cache entry', async () => {
      const corrupt = path.join(fixture, 'corrupt.tar.gz'); fs.writeFileSync(corrupt, 'bad');
      await assert.rejects(fonts.prepareFontArchives({ cacheDir: emptyCache, source: corrupt }), /integrity mismatch/);
      const originalFetch = global.fetch;
      global.fetch = async () => ({ ok: true, body: (async function* () { yield Buffer.from('bad'); })() });
      try { await assert.rejects(fonts.prepareFontArchives({ cacheDir: emptyCache, download: true }), /integrity mismatch/); }
      finally { global.fetch = originalFetch; }
      assert.equal(fs.existsSync(fonts.archiveCachePath(emptyCache, fonts.FONT_REVIEW.archives.source)), false);
    });
    await check('font source cache junctions are rejected without touching their target', () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-font-cache-outside-'));
      const link = path.join(fixture, 'linked-cache'); fs.symlinkSync(outside, link, 'junction');
      try {
        assert.throws(() => fonts.fontSourceMaterials({ cacheDir: link }), /contains a link/);
        assert.deepEqual(fs.readdirSync(outside), []);
      } finally { fs.unlinkSync(link); fs.rmSync(outside, { recursive: true, force: true }); }
    });
    await check('font tar reader rejects links, traversal, duplicates and bad/truncated records without extraction', () => {
      const { gzipSync } = require('node:zlib');
      const tar = (name, type = '0', body = Buffer.from('fixture')) => {
        const header = Buffer.alloc(512);
        header.write(name); header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
        header.write('        ', 148); header.write(type, 156);
        let sum = 0; for (const byte of header) sum += byte;
        header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
        return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
      };
      const entry = tar('source/README');
      const valid = gzipSync(Buffer.concat([entry, Buffer.alloc(1024)]));
      assert.equal(fonts.readFontTar(valid).get('source/README').toString(), 'fixture');
      for (const bytes of [tar('../escape'), tar('C:/escape'), tar('source/link', '2'), Buffer.concat([entry, entry]), Buffer.from('bad')]) {
        assert.throws(() => fonts.readFontTar(gzipSync(Buffer.concat([bytes, Buffer.alloc(1024)]))));
      }
      assert.throws(() => fonts.readFontTar(gzipSync(entry.subarray(0, 513))), /truncated/);
      const badChecksum = Buffer.from(entry); badChecksum[10] ^= 1;
      assert.throws(() => fonts.readFontTar(gzipSync(Buffer.concat([badChecksum, Buffer.alloc(1024)]))), /checksum/);
    });
    await check('Release precheck and publish CLI refuse unresolved fonts even with bypass flags, without network/build', () => {
      assert.throws(fonts.assertFontReviewComplete, /source correspondence is unresolved/);
      for (const [script, args] of [['release-check.mjs', ['--skip-tests', '--skip-build']], ['publish-release.mjs', ['--tag=v0.0.0', '--dry-run']]]) {
        const child = require('node:child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
          cwd: fixture, env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '', PI_GUI_OFFLINE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 15000,
        });
        assert.ifError(child.error); assert.equal(child.status, 1);
        assert.match(child.stdout + child.stderr, /source correspondence is unresolved/);
        assert.doesNotMatch(child.stdout, /READY TO RELEASE\s*$|npm run build:|创建 draft|已发布：/m);
      }
    });
    if (process.env.PI_GUI_FONT_SOURCE_TEST_CACHE) await check('real pinned archives are copied into TEMP vendor legal distribution but do not resolve correspondence', async () => {
      const cacheDir = process.env.PI_GUI_FONT_SOURCE_TEST_CACHE;
      const archived = await materializePreviewVendor({ root: fixture, fontSourceCache: cacheDir });
      const withSource = readJson(path.join(output, 'versions.json'));
      const review = withSource.versions.packages['pdfjs-dist@' + fonts.FONT_REVIEW.pdfjsVersion].fontLicenseReview;
      assert.equal(review.sourceDistributionVerified, false);
      assert.equal(archived.legalReviewRequired.length, 1);
      for (const spec of Object.values(review.archives)) {
        assert.equal(spec.included, true);
        assert.equal(sha256(fs.readFileSync(path.join(output, spec.file))), spec.sha256);
        assert.deepEqual(fs.readFileSync(path.join(output, spec.file)), fs.readFileSync(fonts.archiveCachePath(cacheDir, spec)));
      }
      for (const name of ['Makefile', 'README', 'License.txt', 'COPYING', 'AUTHORS', 'scripts/fontexport.pe', 'scripts/sfd2ttf.pe', 'scripts/ttf2sfd.pe']) {
        const members = fonts.readFontTar(fs.readFileSync(path.join(output, review.archives.source.file)));
        assert.ok(members.has(review.archives.source.prefix + name));
      }
      assert.throws(() => fonts.verifyFontDistribution(output), /source correspondence is unresolved/);
      // A stale/forged success boolean cannot bypass the immutable review gate.
      withSource.legalReviewRequired = []; review.sourceDistributionVerified = true;
      fs.writeFileSync(path.join(output, 'versions.json'), JSON.stringify(withSource));
      assert.throws(() => fonts.verifyFontDistribution(output), /source correspondence is unresolved/);
      await materializePreviewVendor({ root: fixture });
      assert.deepEqual(inventory(output), before);
      console.log('Real font archive distribution: ' + JSON.stringify({ files: archived.files, bytes: archived.bytes, manifest: archived.manifestSha256, tree: archived.treeSha256 }));
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
    await check('excluded PPTX retains authentic npm/upstream restriction evidence only in a non-shipped fixture', () => {
      const evidence = readJson(path.join(ROOT, 'tests/fixtures/preview-legal/pptx-preview-1.0.7.json'));
      assert.equal(evidence.package.name, 'pptx-preview');
      assert.equal(evidence.package.version, '1.0.7');
      assert.equal(evidence.package.licenseMetadata, 'ISC');
      assert.equal(evidence.npmArchive.integrity, 'sha512-YByocJuyxAR4YB4Q3+VAxdLfEvA5LojG1gAJsx2Mw0QU5FJPps/2fkJOupJ6oBbA+KdWRpuAk6G6T34rKCHVxw==');
      assert.equal(evidence.npmArchive.sha256, '93e7e270f93305a5238894760862a0e4471529cea5ee1dec8991cfa415c3b1b0');
      assert.equal(evidence.npmArchive.fileCount, 47);
      assert.deepEqual(evidence.npmArchive.standaloneLegalFiles, []);
      const excerpt = Buffer.from(evidence.npmReadme.excerpt);
      assert.equal(excerpt.length, evidence.npmReadme.excerptBytes);
      assert.equal(sha256(excerpt), evidence.npmReadme.excerptSha256);
      assert.equal(evidence.npmReadme.excerptSha256, 'efe4ae5410d35977b5b6856b8f06ea97d719481a0e9e2d203442983a578f972e');
      assert.match(excerpt.toString(), /自用商用均可/);
      assert.match(excerpt.toString(), /源码仅供个人学习使用，不得发布到互联网平台中/);
      const bytes = Buffer.from(evidence.upstreamLicense.base64, 'base64');
      assert.equal(bytes.length, 200);
      assert.match(bytes.toString('utf8'), /源码仅供个人学习使用/);
      assert.doesNotMatch(bytes.toString('utf8'), /Permission to use|Copyright \(c\)/);
      assert.equal(crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), evidence.upstreamLicense.gitBlob);
      assert.equal(evidence.upstreamLicense.gitBlob, 'f2d9e1ed347b274e9b8e0b552058fb8b0a9889fb');
      assert.match(evidence.upstreamLicense.url, /b9bb0460a426ffe155487ee124ad9d57fd9c4c51\/LICENSE$/);
      assert.doesNotMatch(manifest.legalReviewRequired.join('\n'), /pptx-preview/);
      assert.ok(!Object.keys(before).some(file => /pptx-preview|preview-legal/.test(file)));
    });
    await check('pako archives every bundled lib/zlib copyright and full Zlib terms alongside its MIT license', () => {
      const pkg = manifest.versions.packages['pako@1.0.11'];
      assert.equal(pkg.license, '(MIT AND Zlib)');
      assert.equal(pkg.zlibNotice.license, 'Zlib');
      const bytes = fs.readFileSync(path.join(output, pkg.zlibNotice.file));
      const expected = fs.readFileSync(path.join(ROOT, 'tests/fixtures/preview-legal/pako-1.0.11-zlib-notice.txt'));
      assert.deepEqual(bytes, expected);
      assert.equal(bytes.length, 960);
      assert.equal(sha256(bytes), '170d7d544d380b38d5f76ab5eda29475b44ef537f4564163d6d9bece85c51c13');
      assert.equal(sha256(bytes), pkg.zlibNotice.sha256);
      assert.match(bytes.toString(), /1995-2013 Jean-loup Gailly and Mark Adler/);
      assert.match(bytes.toString(), /2014-2017 Vitaly Puzrin and Andrey Tupitsin/);
      for (const clause of ['1. The origin', '2. Altered source versions', '3. This notice']) assert.ok(bytes.includes(clause));
      const sources = Object.keys(manifest.inputs).filter(name => /^node_modules\/pako\/lib\/zlib\/[^/]+\.js$/.test(name));
      assert.equal(sources.length, 11);
      assert.deepEqual(pkg.zlibNotice.sources, sources);
      for (const source of sources) {
        const original = fs.readFileSync(path.join(ROOT, source));
        assert.ok(original.includes(bytes), source);
        assert.equal(sha256(original), manifest.inputs[source].sha256);
      }
      const changes = fs.readFileSync(path.join(output, pkg.zlibNotice.transformations), 'utf8');
      assert.match(changes, /mechanically bundled and minified by esbuild/);
      assert.match(changes, /altered versions, not the original upstream source distribution/);
      const mit = fs.readFileSync(path.join(output, 'licenses/pako%401.0.11/LICENSE'));
      assert.deepEqual(mit, fs.readFileSync(path.join(moduleRoot, 'pako/LICENSE')));
      assert.match(mit.toString(), /Vitaly Puzrin and Andrei Tuputcyn/);
      for (const asset of ['mammoth.js', 'exceljs.js']) assert.ok(manifest.bundles[asset].packages.includes('pako@1.0.11'));
      assert.deepEqual(readJson(path.join(output, 'licenses/pako%401.0.11/provenance.json')).zlibNotice, pkg.zlibNotice);
    });
    await check('missing, truncated or altered pako Zlib notices fail closed rather than falling back to MIT', () => {
      const bytes = fs.readFileSync(path.join(ROOT, 'tests/fixtures/preview-legal/pako-1.0.11-zlib-notice.txt'));
      assert.deepEqual(extractPakoZlibNotice(Buffer.concat([Buffer.from("'use strict';\n\n"), bytes, Buffer.from('\nvar code = 1;\n')])), bytes);
      for (const source of [Buffer.from(''), fs.readFileSync(path.join(moduleRoot, 'pako/LICENSE')), bytes.subarray(0, -10), Buffer.from(bytes.toString().replace('Jean-loup Gailly', 'Unknown author'))]) {
        assert.throws(() => extractPakoZlibNotice(source), /pako Zlib notice integrity mismatch/);
      }
    });
    await check('source notice loss aborts materialization before replacing the published tree', async () => {
      const original = fs.readFileSync, source = path.join(moduleRoot, 'pako/lib/zlib/inflate.js');
      fs.readFileSync = function(file, ...args) {
        const bytes = original(file, ...args);
        if (typeof file !== 'string' || path.resolve(file) !== source) return bytes;
        const text = bytes.toString().replace(/^\/\/ \(C\) 1995-2013[\s\S]*?^\/\/ 3\. This notice[^\n]*\n/m, '');
        return Buffer.isBuffer(bytes) ? Buffer.from(text) : text;
      };
      try {
        await assert.rejects(materializePreviewVendor({ root: fixture }), /pako Zlib notice integrity mismatch/);
        assert.deepEqual(inventory(output), before);
      } finally { fs.readFileSync = original; }
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
      assert.equal(result.pptxGlobalAbsent, true);
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
    await check('removed PPTX-only lock subgraph stays excluded while all retained dependency edges resolve offline', () => {
      const pkg = readJson(path.join(ROOT, 'package.json'));
      const lock = readJson(path.join(ROOT, 'package-lock.json'));
      const excluded = ['pptx-preview', 'echarts', 'zrender', 'lodash', 'tslib'];
      for (const name of excluded) {
        assert.equal(pkg.dependencies[name], undefined);
        assert.ok(!Object.keys(lock.packages).some(key => key.endsWith('/node_modules/' + name) || key === 'node_modules/' + name));
        assert.ok(!Object.values(lock.packages).some(item => item.dependencies?.[name] || item.devDependencies?.[name] || item.optionalDependencies?.[name]));
      }
      assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
      assert.equal(lock.packages['node_modules/pako'].version, '1.0.11');
      assert.equal(lock.packages['node_modules/jszip'].version, '3.10.2');
      assert.equal(lock.packages['node_modules/uuid'].version, '11.1.1');
      const visited = new Set();
      function visit(key) {
        if (visited.has(key)) return;
        visited.add(key);
        const item = lock.packages[key];
        for (const name of Object.keys({ ...item.dependencies, ...item.devDependencies, ...item.optionalDependencies })) {
          let cursor = key, resolved;
          while (true) {
            const candidate = (cursor ? cursor + '/' : '') + 'node_modules/' + name;
            if (lock.packages[candidate]) { resolved = candidate; break; }
            if (!cursor) break;
            const at = cursor.lastIndexOf('/node_modules/');
            cursor = at < 0 ? '' : cursor.slice(0, at);
          }
          if (!resolved && item.optionalDependencies?.[name]) continue;
          assert.ok(resolved, `${key || 'root'} -> ${name}`);
          visit(resolved);
        }
      }
      visit('');
      assert.equal(visited.size, Object.keys(lock.packages).length, 'no unrelated or PPTX-only lock entries become orphaned');
    });
    await check('reintroduced PPTX declarations or nested lock entries fail before touching installed code or publication', async () => {
      for (const [name, mutate] of [
        ['package.json', pkg => { pkg.dependencies['pptx-preview'] = '1.0.7'; }],
        ['package-lock.json', lock => { lock.packages[''].dependencies['pptx-preview'] = '1.0.7'; }],
        ['package-lock.json', lock => { lock.packages['node_modules/pptx-preview'] = { version: '1.0.7', license: 'ISC' }; }],
        ['package-lock.json', lock => { lock.packages['node_modules/other/node_modules/pptx-preview'] = { version: '1.0.7', license: 'ISC' }; }],
      ]) {
        const file = path.join(fixture, name), bytes = fs.readFileSync(file), metadata = JSON.parse(bytes);
        mutate(metadata); fs.writeFileSync(file, JSON.stringify(metadata));
        try {
          await assert.rejects(materializePreviewVendor({ root: fixture }), /restricted pptx-preview dependency must remain excluded/);
          assert.deepEqual(inventory(output), before);
        } finally { fs.writeFileSync(file, bytes); }
      }
    });
    await check('staged materialization removes stale PPTX bundle and legal artifacts only after successful validation', async () => {
      for (const name of ['pptx-preview.js', 'licenses/pptx-preview%401.0.7/UPSTREAM-LICENSE.txt', 'licenses/echarts%406.1.0/NOTICE']) {
        const file = checkedPath(output, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'obsolete fixture artifact');
      }
      const stale = inventory(output), file = path.join(fixture, 'package-lock.json'), bytes = fs.readFileSync(file), lock = JSON.parse(bytes);
      lock.packages['node_modules/fflate'].version = '0.0.0'; fs.writeFileSync(file, JSON.stringify(lock));
      try {
        await assert.rejects(materializePreviewVendor({ root: fixture }), /lockfile mismatch/);
        assert.deepEqual(inventory(output), stale);
      } finally { fs.writeFileSync(file, bytes); }
      assert.deepEqual(await materializePreviewVendor({ root: fixture }), first);
      assert.deepEqual(inventory(output), before);
      assert.ok(!Object.keys(inventory(output)).some(name => /pptx-preview|echarts/.test(name)));
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
