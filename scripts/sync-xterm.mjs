/* Materialize the pinned xterm browser files into public/vendor/xterm.
 *
 * This repository serves public/ directly and has no frontend bundler. The
 * npm packages ship browser-ready ESM files, so copying them is enough; no
 * second build system is introduced. Build scripts run this before packaging
 * so the vendor copy can never lag behind package.json.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'vendor', 'xterm');

const FILES = [
  ['@xterm/xterm/lib/xterm.mjs', 'xterm.mjs'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/xterm/LICENSE', 'LICENSE.xterm'],
  ['@xterm/addon-fit/lib/addon-fit.mjs', 'addon-fit.mjs'],
  ['@xterm/addon-fit/LICENSE', 'LICENSE.addon-fit'],
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function packageVersion(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
}

fs.mkdirSync(OUT, { recursive: true });
const versions = {
  '@xterm/xterm': packageVersion('@xterm/xterm'),
  '@xterm/addon-fit': packageVersion('@xterm/addon-fit'),
  files: {},
};
for (const [source, name] of FILES) {
  const from = path.join(ROOT, 'node_modules', ...source.split('/'));
  if (!fs.existsSync(from)) {
    throw new Error(`缺少 ${source}，先运行 npm install`);
  }
  const to = path.join(OUT, name);
  fs.copyFileSync(from, to);
  versions.files[name] = sha256(to);
}
fs.writeFileSync(path.join(OUT, 'versions.json'), JSON.stringify(versions, null, 2) + '\n', 'utf8');
console.log(`xterm ${versions['@xterm/xterm']} + addon-fit ${versions['@xterm/addon-fit']} → public/vendor/xterm`);
