/* Liberation source custody only. Offline unless --download is explicitly used.
 * No upstream script is executed, no archive is extracted onto the filesystem.
 * Full upstream archives live outside Git; generated vendor/legal files are the
 * distribution copy. Archive availability is NOT proof of correspondence. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export const FONT_REVIEW = freeze({
  pdfjsVersion: '6.3.289',
  npmIntegrity: 'sha512-ZHjSVpDa3D6izMq8/04lvkhkATUmL9px6ChPaXc1k6nU2Mrhlg1/7F0bdUqCwUjw3NsPTfPZsMDUU6ZIcRaeQw==',
  pdfjsCommit: '1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56',
  fontVersion: '1.07.4',
  // No operator flag, environment variable or generated boolean may approve this.
  // A future change requires new correspondence evidence and independent review.
  correspondence: 'unresolved',
  blocker: 'Liberation 1.07.4 source correspondence is unresolved: PDF.js fonts differ in bytes and glyph counts from the preserved upstream TTF release. See docs/pdf-font-license-verification.md.',
  fonts: {
    'LiberationSans-Regular.ttf': { bytes: 139512, sha256: 'f8ace1f892b2bd9dc1792ba7f097fa7588f84fed48321480e04de5390828221f', upstreamSha256: 'fc977b8f8a736c45ee4126383d0b8a929af7d4f4a9c4a1c974ed5a32387db822', sfdSha256: '27b216a54fb8f46b902f69c4310ac8d4de28bc1b2fb794bc3e7cd93da2492320' },
    'LiberationSans-Bold.ttf': { bytes: 137052, sha256: '361c61b82d575c5c35fd9157fda8b0194bcfcd0d88ea8521a4fb5dd53d33dddc', upstreamSha256: '32f8698422f13692f85b57b32b72d726e0aae3190a7cef0b5c10a8e36ef82845', sfdSha256: '433c768b831c1e34d4e0292dc2fd069cb8a2636ca3ca4ffe47681a32f7fdc2c6' },
    'LiberationSans-Italic.ttf': { bytes: 162036, sha256: '832b4406dbef23628800d3aaad21048534ac84d7e3ad955be83b8172ed8ef512', upstreamSha256: '36c6d220d11c157f499c0371f2b2aa29a4ef2aa868b6b93564d8d460ae2ffad3', sfdSha256: 'ad9034d03d1c1c4e764b7e131891486e31a6c2d6590a3021e8cfa6f967995231' },
    'LiberationSans-BoldItalic.ttf': { bytes: 135124, sha256: 'a224075ac17495ad0a3af3bc0a419ac0704a8b3fd1095456201fb9b095fc281d', upstreamSha256: 'cba635aca7f71a00faffe7e89a2301fbb1bb9739b4ac44329ccaf90d622b5fe3', sfdSha256: '3d547dc11bd35cfc8a59f79911844e3538393e2d169820eeae68fa631498a749' },
  },
  assets: {
    'pdf.js': '495588717f62303a839e91a5343deebf1b41f52e2f9f6361e73dee6ea6a4355e',
    'pdf.worker.mjs': 'f2870db902eaff8397442c912b69459980ac91f6f4b5ed827167b12cf7057930',
    'pdf/standard_fonts/LICENSE_LIBERATION': 'd2c4d5b3e115a519cb58eb691aa64538397e2611f9ebe801392cf9667997e7dc',
  },
  archives: {
    source: { name: 'liberation-fonts-1.07.4.tar.gz', bytes: 2937949, sha256: 'ad98b7498dc2992f7f0868f79b65ce4a720a3acdb63ab3f1f1cb6881117a5406', prefix: 'liberation-fonts-1.07.4/', url: 'https://archive.debian.org/debian/pool/main/f/fonts-liberation/fonts-liberation_1.07.4.orig.tar.gz' },
    binary: { name: 'liberation-fonts-ttf-1.07.4.tar.gz', bytes: 1333593, sha256: '61a7e2b6742a43c73e8762cdfeaf6dfcf9abdd2cfa0b099a9854d69bc4cfee5c', prefix: 'liberation-fonts-ttf-1.07.4/', url: 'https://dev-www.libreoffice.org/src/134d8262145fc793c6af494dcace3e71-liberation-fonts-ttf-1.07.4.tar.gz' },
  },
});
export const FONT_LEGAL_DIR = `licenses/${encodeURIComponent('pdfjs-dist@' + FONT_REVIEW.pdfjsVersion)}/liberation-source`;
export function fontSourceCache() {
  return path.resolve(process.env.PI_GUI_THIRD_PARTY_CACHE || path.join(os.homedir(), '.cache', 'pi-gui', 'third-party'));
}

// Check every existing ancestor, including a dangling symlink. Never write
// through a junction in a caller-selected cache or a generated distribution.
function noLinks(file) {
  const absolute = path.resolve(file);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('font source path contains a link'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return absolute;
}
export function archiveCachePath(cacheDir, spec) {
  return noLinks(path.join(cacheDir, spec.sha256, spec.name));
}
export function verifyArchive(bytes, spec) {
  if (bytes.length !== spec.bytes || hash(bytes) !== spec.sha256) throw new Error('font source archive integrity mismatch: ' + spec.name);
  return bytes;
}
function readArchiveFile(file, spec) {
  const checked = noLinks(file), stat = fs.lstatSync(checked);
  if (!stat.isFile() || stat.size !== spec.bytes) throw new Error('font source archive integrity mismatch (not a pinned regular file): ' + spec.name);
  return verifyArchive(fs.readFileSync(checked), spec);
}

// Only the two digest-verified historical tar layouts are read here. Deliberate
// narrow support: regular files/directories, octal sizes, no PAX/links/extraction.
export function readFontTar(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 });
  const files = new Map(), seen = new Set();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (tar.subarray(offset).some(byte => byte !== 0)) throw new Error('font source tar has trailing data');
      return files;
    }
    const text = (start, end) => header.toString('utf8', start, end).replace(/\0.*$/s, '');
    const prefix = text(345, 500), name = (prefix ? prefix + '/' : '') + text(0, 100);
    const parts = name.replace(/\/$/, '').split('/');
    if (!name || name.includes('\\') || name.includes(':') || parts.some(part => !part || part === '.' || part === '..') || seen.has(name)) throw new Error('unsafe font source tar path');
    seen.add(name);
    const octal = text(124, 136).trim();
    if (!/^[0-7]+$/.test(octal)) throw new Error('invalid font source tar size');
    const size = parseInt(octal, 8), type = header[156];
    if (![0, 48, 53].includes(type)) throw new Error('font source tar links or extensions rejected');
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== parseInt(text(148, 156).trim(), 8)) throw new Error('invalid font source tar checksum');
    if (offset + 512 + size > tar.length) throw new Error('truncated font source tar');
    if (type !== 53) files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('font source tar end marker missing');
}

export function verifyPdfFontIdentity({ version, integrity, files }) {
  if (version !== FONT_REVIEW.pdfjsVersion || integrity !== FONT_REVIEW.npmIntegrity) throw new Error('PDF.js identity changed; font license re-verification required');
  const names = Object.keys(files).filter(name => /^pdf\/standard_fonts\/.*\.ttf$/i.test(name)).sort();
  const expected = Object.keys(FONT_REVIEW.fonts).map(name => 'pdf/standard_fonts/' + name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('PDF font inventory changed; font license re-verification required');
  const pins = { ...FONT_REVIEW.assets, ...Object.fromEntries(Object.entries(FONT_REVIEW.fonts).map(([name, info]) => ['pdf/standard_fonts/' + name, info.sha256])) };
  for (const [name, expectedHash] of Object.entries(pins)) {
    const bytes = files[name];
    if (!Buffer.isBuffer(bytes) || hash(bytes) !== expectedHash) throw new Error('PDF/font bytes changed; font license re-verification required: ' + name);
  }
}

export function fontSourceMaterials({ cacheDir = fontSourceCache() } = {}) {
  const files = {}, archives = {};
  for (const [kind, spec] of Object.entries(FONT_REVIEW.archives)) {
    const file = archiveCachePath(cacheDir, spec);
    let bytes;
    try { bytes = readArchiveFile(file, spec); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    archives[kind] = { ...spec, included: Boolean(bytes), file: `${FONT_LEGAL_DIR}/${spec.name}` };
    if (!bytes) continue;
    files[archives[kind].file] = bytes; // Original tar.gz bytes, not a repack.
    const members = readFontTar(bytes);
    if (kind === 'source') {
      for (const name of ['License.txt', 'COPYING', 'AUTHORS', 'README', 'Makefile', 'scripts/fontexport.pe', 'scripts/sfd2ttf.pe', 'scripts/ttf2sfd.pe']) {
        const member = members.get(spec.prefix + name);
        if (!member) throw new Error('font source archive lacks ' + name);
        if (['License.txt', 'COPYING', 'AUTHORS', 'README'].includes(name)) files[`${FONT_LEGAL_DIR}/upstream/${name}`] = member;
      }
      for (const [name, info] of Object.entries(FONT_REVIEW.fonts)) {
        const sfd = members.get(spec.prefix + 'src/' + name.replace(/\.ttf$/, '.sfd'));
        if (!sfd || hash(sfd) !== info.sfdSha256) throw new Error('font SFD identity mismatch');
      }
      if ([...members.keys()].filter(name => name.endsWith('.sfd')).length !== 16) throw new Error('incomplete font source archive');
    } else {
      for (const [name, info] of Object.entries(FONT_REVIEW.fonts)) {
        const font = members.get(spec.prefix + name);
        if (!font || hash(font) !== info.upstreamSha256) throw new Error('upstream TTF identity mismatch');
      }
    }
  }
  const review = { license: 'GPLv2 with Liberation font exceptions', fontVersion: FONT_REVIEW.fontVersion,
    sourceDistributionVerified: false, correspondence: FONT_REVIEW.correspondence,
    verification: 'docs/pdf-font-license-verification.md', blocker: FONT_REVIEW.blocker, archives,
    noticeFile: `${FONT_LEGAL_DIR}/SOURCE-INFO.txt`, identityFile: `${FONT_LEGAL_DIR}/identity.json` };
  files[review.identityFile] = Buffer.from(JSON.stringify({ ...FONT_REVIEW, archives }, null, 2) + '\n');
  files[review.noticeFile] = Buffer.from([
    'Liberation Sans 1.07.4 — GPLv2 with Liberation font exceptions (not Apache-2.0 or OFL).',
    'Font copyright (TTF name table): Copyright (c) 2007 Red Hat, Inc. All rights reserved. LIBERATION is a trademark of Red Hat, Inc.',
    'Source License.txt copyright: Copyright © 2007-2011 Red Hat, Inc. All rights reserved. LIBERATION is a trademark of Red Hat, Inc.',
    'Contributors include Ascender, Red Hat and Oracle; original AUTHORS is in the source archive.',
    'Full GPLv2 and exceptions: ../standard_fonts/LICENSE_LIBERATION (also next to the distributed TTFs).',
    'Source archive includes 16 SFD files, Makefile, three FontForge scripts, README, AUTHORS, License.txt and COPYING.',
    'Source acquisition (original archive bytes and SHA256):',
    ...Object.values(archives).flatMap(spec => [`${spec.name}: ${spec.included ? 'included beside this notice' : 'NOT INCLUDED — release blocked'}`, spec.url, `SHA256 ${spec.sha256}`]),
    'The complete preserved upstream source is provided for inspection; exact correspondence to the PDF.js TTFs is NOT established.',
    FONT_REVIEW.blocker,
    'A local cache is not a public source offer. No three-year written source offer is made here.',
    'Release policy: accompany the binaries with the complete verified corresponding source, not a link-only offer.',
    'Do not substitute Liberation 2.x or rebuild fonts without reviewing PDF.js glyph-order/width-table coupling.',
    'No claim of bit-for-bit rebuilding or legal approval is made. See identity.json for full pinned identities.',
    '',
  ].join('\n'));
  return { files, review };
}

// Reused by App's existing root notice; never label subcomponent fonts as
// Apache-2.0, and never silently omit the source status in a stale local build.
export function fontDistributionNotice(vendorDir) {
  const license = fs.readFileSync(noLinks(path.join(vendorDir, 'pdf/standard_fonts/LICENSE_LIBERATION')));
  if (hash(license) !== FONT_REVIEW.assets['pdf/standard_fonts/LICENSE_LIBERATION']) throw new Error('PDF font license changed; re-verification required');
  /* The same text is also shipped beside the fonts; when copied into the App's
   * root notices its relative references ("next to this notice") would otherwise
   * point at the App root, where the archives do not exist. */
  const origin = `以下字体说明原文位于 App 内 public/vendor/file-preview/${FONT_LEGAL_DIR}/SOURCE-INFO.txt；原文中的 “next to this notice / beside this notice” 均相对该目录，不是本通知所在的 App 根目录。\n\n`;
  return origin + fs.readFileSync(noLinks(path.join(vendorDir, FONT_LEGAL_DIR, 'SOURCE-INFO.txt')), 'utf8') + '\n' + license.toString('utf8');
}

export function assertFontReviewComplete() {
  // This gate is intentionally independent of generated/possibly stale booleans.
  if (FONT_REVIEW.correspondence !== 'verified') throw new Error(FONT_REVIEW.blocker);
}

export function verifyFontDistribution(vendorDir) {
  noLinks(vendorDir);
  const get = name => {
    if (!name || name.includes('\\') || name.includes(':') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('unsafe font distribution path');
    return fs.readFileSync(noLinks(path.join(vendorDir, name)));
  };
  const manifest = JSON.parse(get('versions.json'));
  const id = 'pdfjs-dist@' + FONT_REVIEW.pdfjsVersion, pkg = manifest.versions?.packages?.[id];
  const files = Object.fromEntries(Object.keys(manifest.files || {}).filter(name => /^pdf\/standard_fonts\/.*\.ttf$/i.test(name)).map(name => [name, get(name)]));
  for (const name of Object.keys(FONT_REVIEW.assets)) files[name] = get(name);
  verifyPdfFontIdentity({ version: pkg?.version, integrity: pkg?.instances?.[0]?.integrity, files });
  let sourceMembers;
  for (const [kind, spec] of Object.entries(FONT_REVIEW.archives)) {
    const bytes = readArchiveFile(path.join(vendorDir, FONT_LEGAL_DIR, spec.name), spec);
    if (kind === 'source') sourceMembers = readFontTar(bytes);
  }
  for (const name of ['License.txt', 'COPYING', 'AUTHORS', 'README']) {
    if (!get(`${FONT_LEGAL_DIR}/upstream/${name}`).equals(sourceMembers.get(FONT_REVIEW.archives.source.prefix + name))) throw new Error('font source legal bytes changed: ' + name);
  }
  const legalFiles = pkg?.legalFiles || [];
  for (const name of [FONT_LEGAL_DIR + '/SOURCE-INFO.txt', FONT_LEGAL_DIR + '/identity.json', ...['License.txt', 'COPYING', 'AUTHORS', 'README'].map(name => FONT_LEGAL_DIR + '/upstream/' + name)]) {
    const bytes = get(name), info = manifest.files?.[name];
    if (!legalFiles.includes(name) || !info || info.sha256 !== hash(bytes) || info.bytes !== bytes.length) throw new Error('font legal distribution is incomplete: ' + name);
  }
  assertFontReviewComplete();
  return { sourceDistributionVerified: true };
}

// Explicit maintenance command; production/test imports never fetch. Each item
// is first downloaded into its own fresh OS TEMP directory, checked, then copied
// into a content-addressed cache. Failed downloads cannot poison a good cache.
export async function prepareFontArchives({ cacheDir = fontSourceCache(), download = false, source, binary } = {}) {
  const result = {};
  for (const [kind, spec] of Object.entries(FONT_REVIEW.archives)) {
    const target = archiveCachePath(cacheDir, spec);
    const input = kind === 'source' ? source : binary;
    if (!input && fs.existsSync(target)) { readArchiveFile(target, spec); result[kind] = target; continue; }
    if (!input && !download) throw new Error('missing font source cache; import original archives or explicitly use --download: ' + spec.name);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-preview-font-fetch-'));
    try {
      let bytes;
      if (input) bytes = readArchiveFile(input, spec);
      else {
        const response = await fetch(spec.url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error('font archive download HTTP ' + response.status);
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > spec.bytes) throw new Error('font archive download exceeds pinned size');
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks);
      }
      verifyArchive(bytes, spec);
      const staged = path.join(temp, spec.name);
      fs.writeFileSync(staged, bytes, { flag: 'wx' });
      noLinks(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      noLinks(target);
      // Never overwrite an existing cache entry, including concurrent writers.
      try { fs.copyFileSync(staged, target, fs.constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== 'EEXIST') throw error; readArchiveFile(target, spec); }
      result[kind] = target;
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = flag => { const at = args.indexOf(flag); if (at < 0) return undefined; if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(flag + ' requires a value'); return args[at + 1]; };
  try {
    if (args.includes('--check-review')) assertFontReviewComplete();
    else if (args.includes('--verify-vendor')) console.log(verifyFontDistribution(value('--verify-vendor')));
    else console.log(JSON.stringify(await prepareFontArchives({ cacheDir: value('--cache-dir'), download: args.includes('--download'), source: value('--source'), binary: value('--binary') }), null, 2));
  } catch (error) { console.error('Font source gate: ' + error.message); process.exitCode = 1; }
}
