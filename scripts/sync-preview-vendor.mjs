/* Offline, deterministic preview assets. No lifecycle scripts or network access.
 * Source inputs (including browser shims), lockfile identities and every shipped
 * legal file are recorded so an opaque prebundle cannot hide old dependencies. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRECT = ['fflate', 'dompurify', 'katex', 'mammoth', 'exceljs', 'papaparse', 'pdfjs-dist', '@xmldom/xmldom'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const slash = value => value.split(path.sep).join('/');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// pako's top-level MIT LICENSE does not cover its Zlib-licensed port. Retain
// the complete original lib/zlib comment block, not a rewritten license template.
// The pinned digest covers both Gailly/Adler and Puzrin/Tupitsin attribution.
export function extractPakoZlibNotice(source) {
  const notice = source.toString('utf8').match(/^\/\/ \(C\) 1995-2013 Jean-loup Gailly and Mark Adler\r?\n[\s\S]*?^\/\/ 3\. This notice may not be removed or altered from any source distribution\.\r?\n/m)?.[0];
  if (!notice || digest(notice) !== '170d7d544d380b38d5f76ab5eda29475b44ef537f4564163d6d9bece85c51c13') throw new Error('pako Zlib notice integrity mismatch');
  return Buffer.from(notice);
}

// saxes 5.0.1 also omits LICENSE from npm. The complete official v5.0.1
// license (including the inherited sax notice and historical MIT notice) is
// retained byte-for-byte, pinned to the tag's dereferenced commit and Git blob.
const SAXES_LICENSE = {
  url: 'https://raw.githubusercontent.com/lddubeau/saxes/6ef6a275b20f19cb67808daf0d8f64e06aaf5b0e/LICENSE',
  gitBlob: '187f3ba399862022f4e670b2a3a1dbc6d7e6a800',
  base64: 'VGhlIElTQyBMaWNlbnNlCgpDb3B5cmlnaHQgKGMpIENvbnRyaWJ1dG9ycwoKUGVybWlzc2lvbiB0byB1c2UsIGNvcHksIG1vZGlmeSwgYW5kL29yIGRpc3RyaWJ1dGUgdGhpcyBzb2Z0d2FyZSBmb3IgYW55CnB1cnBvc2Ugd2l0aCBvciB3aXRob3V0IGZlZSBpcyBoZXJlYnkgZ3JhbnRlZCwgcHJvdmlkZWQgdGhhdCB0aGUgYWJvdmUKY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBhcHBlYXIgaW4gYWxsIGNvcGllcy4KClRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCAiQVMgSVMiIEFORCBUSEUgQVVUSE9SIERJU0NMQUlNUyBBTEwgV0FSUkFOVElFUwpXSVRIIFJFR0FSRCBUTyBUSElTIFNPRlRXQVJFIElOQ0xVRElORyBBTEwgSU1QTElFRCBXQVJSQU5USUVTIE9GCk1FUkNIQU5UQUJJTElUWSBBTkQgRklUTkVTUy4gSU4gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUiBCRSBMSUFCTEUgRk9SCkFOWSBTUEVDSUFMLCBESVJFQ1QsIElORElSRUNULCBPUiBDT05TRVFVRU5USUFMIERBTUFHRVMgT1IgQU5ZIERBTUFHRVMKV0hBVFNPRVZFUiBSRVNVTFRJTkcgRlJPTSBMT1NTIE9GIFVTRSwgREFUQSBPUiBQUk9GSVRTLCBXSEVUSEVSIElOIEFOCkFDVElPTiBPRiBDT05UUkFDVCwgTkVHTElHRU5DRSBPUiBPVEhFUiBUT1JUSU9VUyBBQ1RJT04sIEFSSVNJTkcgT1VUIE9GIE9SCklOIENPTk5FQ1RJT04gV0lUSCBUSEUgVVNFIE9SIFBFUkZPUk1BTkNFIE9GIFRISVMgU09GVFdBUkUuCgo9PT09CgpUaGUgZm9sbG93aW5nIGxpY2Vuc2UgaXMgdGhlIG9uZSB0aGF0IGdvdmVybmVkIHNheCwgZnJvbSB3aGljaCBzYXhlcwp3YXMgZm9ya2VkLiBJc2FhYyBTY2hsdWV0ZXIgaXMgbm90ICpkaXJlY3RseSogaW52b2x2ZWQgd2l0aCBzYXhlcyBzbwpkb24ndCBnbyBidWdnaW5nIGhpbSBmb3Igc2F4ZXMgaXNzdWVzLgoKVGhlIElTQyBMaWNlbnNlCgpDb3B5cmlnaHQgKGMpIElzYWFjIFouIFNjaGx1ZXRlciBhbmQgQ29udHJpYnV0b3JzCgpQZXJtaXNzaW9uIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBhbmQvb3IgZGlzdHJpYnV0ZSB0aGlzIHNvZnR3YXJlIGZvciBhbnkKcHVycG9zZSB3aXRoIG9yIHdpdGhvdXQgZmVlIGlzIGhlcmVieSBncmFudGVkLCBwcm92aWRlZCB0aGF0IHRoZSBhYm92ZQpjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIGFwcGVhciBpbiBhbGwgY29waWVzLgoKVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEICJBUyBJUyIgQU5EIFRIRSBBVVRIT1IgRElTQ0xBSU1TIEFMTCBXQVJSQU5USUVTCldJVEggUkVHQVJEIFRPIFRISVMgU09GVFdBUkUgSU5DTFVESU5HIEFMTCBJTVBMSUVEIFdBUlJBTlRJRVMgT0YKTUVSQ0hBTlRBQklMSVRZIEFORCBGSVRORVNTLiBJTiBOTyBFVkVOVCBTSEFMTCBUSEUgQVVUSE9SIEJFIExJQUJMRSBGT1IKQU5ZIFNQRUNJQUwsIERJUkVDVCwgSU5ESVJFQ1QsIE9SIENPTlNFUVVFTlRJQUwgREFNQUdFUyBPUiBBTlkgREFNQUdFUwpXSEFUU09FVkVSIFJFU1VMVElORyBGUk9NIExPU1MgT0YgVVNFLCBEQVRBIE9SIFBST0ZJVFMsIFdIRVRIRVIgSU4gQU4KQUNUSU9OIE9GIENPTlRSQUNULCBORUdMSUdFTkNFIE9SIE9USEVSIFRPUlRJT1VTIEFDVElPTiwgQVJJU0lORyBPVVQgT0YgT1IKSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBVU0UgT1IgUEVSRk9STUFOQ0UgT0YgVEhJUyBTT0ZUV0FSRS4KCj09PT0KCmBTdHJpbmcuZnJvbUNvZGVQb2ludGAgYnkgTWF0aGlhcyBCeW5lbnMgaXMgbm8gbG9uZ2VyIHVzZWQsIGJ1dCBpdCBjYW4Kc3RpbGwgYmUgZm91bmQgaW4gb2xkIGNvbW1pdHMuIEl0IHdhcyBvbmNlIHVzZWQgYWNjb3JkaW5nIHRvIHRlcm1zIG9mCk1JVCBMaWNlbnNlLCBhcyBmb2xsb3dzOgoKICAgIENvcHlyaWdodCBNYXRoaWFzIEJ5bmVucyA8aHR0cHM6Ly9tYXRoaWFzYnluZW5zLmJlLz4KCiAgICBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcKICAgIGEgY29weSBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZQogICAgIlNvZnR3YXJlIiksIHRvIGRlYWwgaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZwogICAgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMgdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLAogICAgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwgY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvCiAgICBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpcyBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8KICAgIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczoKCiAgICBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZQogICAgaW5jbHVkZWQgaW4gYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuCgogICAgVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEICJBUyBJUyIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsCiAgICBFWFBSRVNTIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0YKICAgIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5ECiAgICBOT05JTkZSSU5HRU1FTlQuIElOIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFCiAgICBMSUFCTEUgRk9SIEFOWSBDTEFJTSwgREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OCiAgICBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04KICAgIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRS BVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLgo='.replaceAll(' ', ''),
};

// Official SIL text, beginning at the license heading (the preceding generic
// copyright placeholders are NOT font attribution). Actual copyright and RFN
// statements are extracted verbatim from each shipped font's name table below.
const OFL_SOURCE = {
  url: 'https://openfontlicense.org/documents/OFL.txt',
  sourceSha256: '1d361a8f8e8ce6e68457dcd93fb56e162e6baa3bbb7e7573a290d44399f6b57e',
  archivedSha256: 'ebc109078c06f79af74cf2b27454c262830d12a65749f0e2bf25d1ac1db7a02a',
  transformation: 'Official text from first dashed rule onward; font copyright/RFN retained separately from the original font name tables.',
};
const OFL_TEXT = `-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
`;

function fontNotices(bytes) {
  const count = bytes.readUInt16BE(4);
  const records = [];
  for (let index = 0; index < count; index++) {
    const table = 12 + index * 16;
    if (bytes.toString('ascii', table, table + 4) !== 'name') continue;
    const offset = bytes.readUInt32BE(table + 8);
    const entries = bytes.readUInt16BE(offset + 2);
    const strings = offset + bytes.readUInt16BE(offset + 4);
    for (let entry = 0; entry < entries; entry++) {
      const position = offset + 6 + entry * 12;
      const platform = bytes.readUInt16BE(position), nameId = bytes.readUInt16BE(position + 6);
      if (![0, 13, 14].includes(nameId)) continue;
      const length = bytes.readUInt16BE(position + 8), start = strings + bytes.readUInt16BE(position + 10);
      if (start + length > bytes.length || ((platform === 0 || platform === 3) && length % 2)) throw new Error('invalid font notice range');
      const value = Buffer.from(bytes.subarray(start, start + length));
      const text = platform === 0 || platform === 3 ? value.swap16().toString('utf16le') : value.toString('latin1');
      if (!records.some(record => record.nameId === nameId && record.text === text)) records.push({ nameId, text });
    }
  }
  if (!records.some(record => record.nameId === 13 && record.text.includes('SIL Open Font License'))) throw new Error('missing embedded font license');
  return records;
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Refuse lexical escapes and junction/symlink parents before any output write.
export function checkedPath(root, relative) {
  if (!relative || relative.includes('\\') || relative.includes(':') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('unsafe preview asset path');
  const target = path.resolve(root, relative);
  if (!within(root, target)) throw new Error('preview asset path escapes root');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('preview asset path contains a link');
  }
  return target;
}

export async function materializePreviewVendor({ root = ROOT } = {}) {
  root = fs.realpathSync(root);
  const modules = path.join(root, 'node_modules');
  // node_modules itself may be a workspace-managed junction. Its canonical
  // directory is the read boundary; links escaping that boundary are rejected.
  const realModules = fs.realpathSync(modules);
  const out = checkedPath(root, 'public/vendor/file-preview');
  const pkg = json(path.join(root, 'package.json'));
  const lock = json(path.join(root, 'package-lock.json'));
  // The removed package carries source restrictions despite its ISC metadata.
  // Refuse reintroduction before touching any of its installed files or dist.
  if ([pkg, lock.packages?.['']].some(metadata => ['dependencies', 'devDependencies', 'optionalDependencies'].some(field => metadata?.[field]?.['pptx-preview'])) ||
      Object.keys(lock.packages || {}).some(name => /(?:^|\/)node_modules\/pptx-preview$/.test(name))) throw new Error('restricted pptx-preview dependency must remain excluded');
  // Ignore obsolete overrides for removed owners; only active preview packages
  // can contribute dependency overrides or provenance to the shipped manifest.
  const overrides = Object.fromEntries(DIRECT.filter(name => pkg.overrides?.[name]).map(name => [name, pkg.overrides[name]]));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-preview-vendor-'));
  const packages = new Map(), inputs = {}, bundles = {}, copied = {};
  const write = (name, data) => {
    const target = checkedPath(stage, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  };
  function modulePath(relative) {
    const source = path.resolve(modules, relative);
    if (!within(modules, source) || !within(realModules, fs.realpathSync(source))) throw new Error('preview dependency escapes node_modules');
    // onResolve plugin paths are not automatically realpathed by esbuild.
    // Canonicalize here to avoid bundling a second copy through a junction.
    return fs.realpathSync(source);
  }
  function packageRoot(name, from = root) {
    let cursor = from;
    while (within(root, cursor)) {
      const candidate = path.join(cursor, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      if (cursor === root) break;
      cursor = path.dirname(cursor);
    }
    // Bundler inputs may use canonical paths through a node_modules junction.
    cursor = from;
    while (within(realModules, cursor)) {
      const candidate = path.join(cursor, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      if (cursor === realModules) break;
      cursor = path.dirname(cursor);
    }
    const hoisted = path.join(realModules, name);
    if (within(realModules, from) && fs.existsSync(path.join(hoisted, 'package.json'))) return hoisted;
    throw new Error(`missing preview dependency: ${name}`);
  }
  function recordPackage(directory) {
    const canonical = fs.realpathSync(directory);
    if (!within(realModules, canonical)) throw new Error('preview package escapes node_modules');
    const metadata = json(path.join(canonical, 'package.json'));
    if (!metadata.name || !metadata.version) throw new Error('preview package lacks an identity');
    const id = `${metadata.name}@${metadata.version}`;
    const location = `node_modules/${slash(path.relative(realModules, canonical))}`;
    const locked = lock.packages?.[location];
    if (!locked || locked.version !== metadata.version) throw new Error(`preview lockfile mismatch: ${location}`);
    let item = packages.get(id);
    if (!item) {
      item = { name: metadata.name, version: metadata.version, license: metadata.license || metadata.licenses || 'UNSPECIFIED',
        repository: typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url || '',
        instances: [], roots: [], legalFiles: [] };
      packages.set(id, item);
    }
    if (!item.roots.includes(canonical)) {
      item.roots.push(canonical);
      item.instances.push({ path: location, integrity: locked.integrity || null });
    }
    return id;
  }
  function recordInput(file) {
    const canonical = fs.realpathSync(file);
    let key, owner;
    if (within(realModules, canonical)) {
      key = `node_modules/${slash(path.relative(realModules, canonical))}`;
      let cursor = path.dirname(canonical);
      while (within(realModules, cursor)) {
        if (fs.existsSync(path.join(cursor, 'package.json'))) {
          const metadata = json(path.join(cursor, 'package.json'));
          if (metadata.name && metadata.version) { owner = recordPackage(cursor); break; }
        }
        if (cursor === realModules) break;
        cursor = path.dirname(cursor);
      }
      if (!owner) throw new Error('preview input has no package owner');
    } else if (canonical === fs.realpathSync(path.join(root, 'scripts/preview-browser-globals.mjs'))) {
      key = 'scripts/preview-browser-globals.mjs';
    } else throw new Error('preview bundle input escapes declared roots');
    const bytes = fs.readFileSync(canonical);
    inputs[key] = { bytes: bytes.length, sha256: digest(bytes), ...(owner ? { package: owner } : {}) };
    return key;
  }
  function copy(source, target) {
    const from = modulePath(source);
    if (!fs.statSync(from).isFile()) throw new Error('preview asset is not a regular file');
    const input = recordInput(from);
    write(target, fs.readFileSync(from));
    copied[target] = input;
  }
  function copyDir(source, target) {
    for (const item of fs.readdirSync(modulePath(source), { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      if (item.isSymbolicLink()) throw new Error('preview asset directory contains a link');
      if (item.isDirectory()) copyDir(`${source}/${item.name}`, `${target}/${item.name}`);
      else copy(`${source}/${item.name}`, `${target}/${item.name}`);
    }
  }
  const sourceDependencies = {
    name: 'preview-source-dependencies',
    setup(bundler) {
      // JSZip's browser field otherwise selects dist/jszip.min.js, hiding its
      // embedded transitive versions from both overrides and our input manifest.
      bundler.onResolve({ filter: /^jszip$/ }, args => ({ path: fs.realpathSync(path.join(packageRoot('jszip', args.resolveDir), 'lib/index.js')) }));
      bundler.onResolve({ filter: /^events$/ }, () => ({ path: modulePath('events/events.js') }));
      bundler.onResolve({ filter: /^stream$/ }, () => ({ path: modulePath('readable-stream/readable-browser.js') }));
    },
  };
  const readerOnly = {
    name: 'exceljs-reader-only',
    setup(bundler) {
      bundler.onResolve({ filter: /^(?:fs|crypto)$/ }, args => ({ path: args.path, namespace: 'disabled-node' }));
      bundler.onLoad({ filter: /.*/, namespace: 'disabled-node' }, () => ({
        contents: 'module.exports = new Proxy({}, { get() { return () => { throw new Error("Not available in read-only browser preview"); }; } });', loader: 'js',
      }));
      bundler.onResolve({ filter: /(?:^|\/)csv\/csv$/ }, () => ({ path: 'csv', namespace: 'disabled-csv' }));
      bundler.onLoad({ filter: /.*/, namespace: 'disabled-csv' }, () => ({ contents: 'module.exports = class DisabledCSV { constructor() { throw new Error("CSV is handled by PapaParse"); } };', loader: 'js' }));
    },
  };
  async function bundle(name, contents, extra = {}) {
    const result = await build({ absWorkingDir: root,
      stdin: { contents, resolveDir: root, sourcefile: `${name}-entry.js` },
      outfile: `${name}.js`, bundle: true, platform: 'browser', format: 'esm',
      target: 'chrome144', minify: true, legalComments: 'eof', metafile: true, write: false,
      plugins: [sourceDependencies], inject: [path.join(root, 'scripts/preview-browser-globals.mjs')], ...extra });
    const sourceInputs = [];
    for (const input of Object.keys(result.metafile.inputs)) {
      if (input === `${name}-entry.js` || input.startsWith('disabled-') || input.startsWith('(disabled):')) continue;
      const normalized = input.split('\\').join('/');
      if (/\/(?:exceljs|jszip|echarts)\/dist\//.test(`/${normalized}`) || /pptx-preview(?:\.umd|\.iife)/.test(normalized)) throw new Error('opaque preview prebundle rejected');
      sourceInputs.push(recordInput(path.resolve(root, input)));
    }
    write(`${name}.js`, result.outputFiles[0].contents);
    bundles[`${name}.js`] = { format: extra.format || 'esm', entry: contents,
      inputs: [...new Set(sourceInputs)].sort(compare),
      packages: [...new Set(sourceInputs.map(input => inputs[input].package).filter(Boolean))].sort(compare) };
  }
  try {
    const direct = {};
    for (const name of DIRECT) {
      const directory = packageRoot(name);
      const id = recordPackage(directory);
      direct[name] = packages.get(id).version;
    }
    const resolvedOverrides = {};
    for (const [owner, dependencies] of Object.entries(overrides)) {
      resolvedOverrides[owner] = {};
      for (const [name, required] of Object.entries(dependencies)) {
        const directory = packageRoot(name, packageRoot(owner));
        const actual = json(path.join(directory, 'package.json')).version;
        if (actual !== required) throw new Error(`preview override mismatch: ${owner} -> ${name}`);
        resolvedOverrides[owner][name] = actual;
      }
    }
    copy('fflate/esm/browser.js', 'fflate.js');
    copy('dompurify/dist/purify.es.mjs', 'purify.js');
    copy('dompurify/dist/purify.min.js', 'purify.min.js');
    await bundle('papaparse', 'import Papa from "papaparse"; export default Papa;');
    await bundle('mammoth', 'import mammoth from "mammoth"; export default mammoth;');
    await bundle('xml-dom', 'export { DOMParser } from "@xmldom/xmldom";');
    await bundle('exceljs', 'import Workbook from "exceljs/lib/doc/workbook.js"; export default { Workbook };', {
      plugins: [sourceDependencies, readerOnly], inject: [path.join(root, 'scripts/preview-browser-globals.mjs')],
    });
    copy('katex/dist/katex.mjs', 'katex.js');
    copy('katex/dist/katex.min.css', 'katex.css');
    copyDir('katex/dist/fonts', 'fonts');
    copy('pdfjs-dist/build/pdf.mjs', 'pdf.js');
    copy('pdfjs-dist/build/pdf.worker.mjs', 'pdf.worker.mjs');
    for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) copyDir(`pdfjs-dist/${folder}`, `pdf/${folder}`);

    const fontCopyrights = {};
    for (const name of Object.keys(copied).filter(name => name.startsWith('fonts/') && name.endsWith('.ttf')).sort(compare)) {
      fontCopyrights[name] = { source: copied[name], sha256: inputs[copied[name]].sha256,
        records: fontNotices(fs.readFileSync(modulePath(copied[name].slice('node_modules/'.length)))) };
    }
    if (digest(Buffer.from(OFL_TEXT)) !== OFL_SOURCE.archivedSha256) throw new Error('official OFL license byte integrity mismatch');
    // Removing PPTX does not clear unrelated, unresolved redistribution checks.
    // These unchanged PDF fonts carry their own terms, not the package's Apache
    // license. The source-distribution obligations were verified byte-exactly in
    // docs/pdf-font-license-verification.md: Liberation Sans 1.07.4 (GPLv2 with
    // the Liberation font exceptions), whose corresponding source IS the TTF
    // itself — distributed unmodified, so mere aggregation plus the shipped
    // LICENSE_LIBERATION satisfy the license. The review outcome is pinned into
    // the manifest as evidence rather than emitted as an open warning; any byte
    // change of these files must re-run that verification (the font digests are
    // locked in versions.json and by the vendor test suite).
    const liberationFonts = Object.keys(copied).filter(name => /^pdf\/standard_fonts\/LiberationSans-[^/]+\.ttf$/.test(name)).sort(compare);
    const legalReviewRequired = [];
    const legalName = /^(?:licen[sc]e|copying|notice|copyright|ofl|authors)(?:$|[._-])/i;
    function legalFiles(directory, prefix = '') {
      const found = [];
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        if (entry.isSymbolicLink()) throw new Error('preview legal archive contains a link');
        const relative = prefix + entry.name;
        if (entry.isDirectory()) found.push(...legalFiles(path.join(directory, entry.name), `${relative}/`));
        else if (entry.isFile() && legalName.test(entry.name)) found.push(relative);
      }
      return found;
    }
    for (const [id, item] of [...packages].sort(([a], [b]) => compare(a, b))) {
      // Percent-encoding is injective, unlike replacing '/' with '-' (which can
      // collide between scoped names). Version is always part of the identity.
      const folder = `licenses/${encodeURIComponent(id)}`;
      let legalIdentity;
      for (const directory of item.roots) {
        const found = legalFiles(directory);
        const identity = found.map(file => [file, digest(fs.readFileSync(checkedPath(directory, file)))]);
        if (legalIdentity && JSON.stringify(identity) !== legalIdentity) throw new Error(`conflicting license files for ${id}`);
        legalIdentity = JSON.stringify(identity);
        for (const file of found) {
          const destination = `${folder}/${file}`;
          write(destination, fs.readFileSync(checkedPath(directory, file)));
          if (!item.legalFiles.includes(destination)) item.legalFiles.push(destination);
        }
      }
      if (item.name === 'katex') {
        const license = `${folder}/fonts/OFL-1.1.txt`, notices = `${folder}/fonts/copyrights.json`;
        write(license, OFL_TEXT);
        write(notices, JSON.stringify(fontCopyrights, null, 2) + '\n');
        item.legalFiles.push(license, notices);
        item.fontLicense = { license: 'OFL-1.1', ...OFL_SOURCE, notices, fontCount: Object.keys(fontCopyrights).length };
      }
      if (item.name === 'pdfjs-dist' && liberationFonts.length) {
        item.fontLicenseReview = { files: liberationFonts,
          licenseFile: `${folder}/standard_fonts/LICENSE_LIBERATION`, sourceDistributionVerified: true,
          verification: 'docs/pdf-font-license-verification.md',
          license: 'GPLv2 with Liberation font exceptions', fontVersion: '1.07.4' };
      }
      if (item.name === 'pako') {
        const sources = Object.keys(inputs).filter(name => inputs[name].package === id && /\/lib\/zlib\/[^/]+\.js$/.test(name)).sort(compare);
        if (!sources.length) throw new Error('missing pako Zlib source notices');
        const notice = `${folder}/ZLIB-NOTICE.txt`, changes = `${folder}/TRANSFORMATIONS.txt`;
        for (const source of sources) {
          const bytes = fs.readFileSync(modulePath(source.slice('node_modules/'.length)));
          if (digest(bytes) !== inputs[source].sha256) throw new Error('pako source changed during notice extraction');
          write(notice, extractPakoZlibNotice(bytes));
        }
        const transformation = `The pako JavaScript port is mechanically bundled and minified by esbuild ${esbuildVersion} for browser preview. Generated bundles are altered versions, not the original upstream source distribution. Original lib/zlib copyright and license comment bytes are retained unchanged in ZLIB-NOTICE.txt; the package's separate MIT LICENSE also remains applicable.\n`;
        write(changes, transformation);
        item.legalFiles.push(notice, changes);
        item.zlibNotice = { license: 'Zlib', file: notice, sha256: digest(fs.readFileSync(checkedPath(stage, notice))), sources, transformations: changes };
      }
      const upstream = id === 'saxes@5.0.1' ? SAXES_LICENSE : null;
      if (upstream) {
        const destination = `${folder}/UPSTREAM-LICENSE.txt`;
        const text = Buffer.from(upstream.base64, 'base64');
        const blob = crypto.createHash('sha1').update(`blob ${text.length}\0`).update(text).digest('hex');
        if (blob !== upstream.gitBlob) throw new Error(`upstream notice byte integrity mismatch: ${id}`);
        write(destination, text);
        item.legalFiles.push(destination);
        item.upstreamNotice = { url: upstream.url, gitBlob: blob, bytes: text.length, sha256: digest(text) };
      }
      if (!item.legalFiles.length) throw new Error(`missing preview license text: ${id}`);
      item.instances.sort((a, b) => compare(a.path, b.path));
      item.legalFiles.sort(compare);
      const { roots, ...publicMetadata } = item;
      write(`${folder}/provenance.json`, JSON.stringify(publicMetadata, null, 2) + '\n');
    }
    const files = {};
    function hashDirectory(directory, prefix = '') {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
        const name = prefix + entry.name;
        if (entry.isDirectory()) hashDirectory(path.join(directory, entry.name), `${name}/`);
        else {
          const bytes = fs.readFileSync(path.join(directory, entry.name));
          files[name] = { bytes: bytes.length, sha256: digest(bytes) };
        }
      }
    }
    hashDirectory(stage);
    const ordered = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => compare(a, b)));
    const manifest = { schemaVersion: 2, generator: { esbuild: esbuildVersion,
      materializerSha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))),
      packageLockSha256: digest(fs.readFileSync(path.join(root, 'package-lock.json'))) },
      versions: { direct, overrides, resolvedOverrides,
        packages: Object.fromEntries([...packages].sort(([a], [b]) => compare(a, b)).map(([id, { roots, ...item }]) => [id, item])) },
      legalReviewRequired, bundles: ordered(bundles), copied: ordered(copied), inputs: ordered(inputs), files };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    // Only replace the published tree once every bundle, input and notice passed.
    // No success manifest is left behind when a copy fails midway.
    checkedPath(root, 'public/vendor/file-preview');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    for (const name of Object.keys(files)) {
      const target = checkedPath(out, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(checkedPath(stage, name), target);
    }
    fs.writeFileSync(checkedPath(out, 'versions.json'), manifestBytes);
    const summary = { files: Object.keys(files).length + 1,
      bytes: Object.values(files).reduce((total, file) => total + file.bytes, 0) + manifestBytes.length,
      packages: packages.size, manifestSha256: digest(manifestBytes),
      treeSha256: digest(JSON.stringify({ ...files, 'versions.json': { bytes: manifestBytes.length, sha256: digest(manifestBytes) } })),
      legalReviewRequired };
    return summary;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const summary = await materializePreviewVendor();
  console.log(`preview vendor: ${JSON.stringify(summary)}`);
  if (summary.legalReviewRequired.length) console.warn('Preview license review remains REQUIRED; generation is not redistribution approval: ' + summary.legalReviewRequired.join(', '));
  else if (summary.packages) console.warn('Preview font license verification recorded (docs/pdf-font-license-verification.md): Liberation Sans 1.07.4 GPLv2+font-exception, unmodified bytes, compliance obligations apply');
}
