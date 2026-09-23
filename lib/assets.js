/* 静态资源访问层。
 *
 * 开发时资源就在磁盘上（public/、node_modules/pdfjs-dist/…）；
 * 打包成单文件 exe（Node SEA）后，这些资源以 asset 形式嵌在 exe 里，
 * 只能用 sea.getAsset() 取。上层只调 readPublic / materializeDir，
 * 不需要关心当前跑在哪种模式下。
 *
 * 构建脚本会额外生成一份 asset-manifest.json（所有 asset key 的清单），
 * 因为 SEA 没有「列出全部资源」的接口，要按前缀解包就得先知道有哪些。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

let sea = null;
try {
  sea = require('node:sea');
} catch {
  /* Node 20 没有 node:sea，按非 SEA 模式处理 */
}

const IN_SEA = Boolean(sea && typeof sea.isSea === 'function' && sea.isSea());

/* 项目根目录。
 *
 * 这个文件在两种布局下的位置不一样，不能靠「往上数一层」硬算：
 *   - 源码布局：lib/assets.js          → 根在上一层
 *   - 打包后：  build/server.cjs       → 本文件就在根目录（esbuild 把 lib/ 并进来了）
 * 早先按「上一层」写死，结果打包后 ROOT 跑到了应用目录的父目录，
 * readPublic 找不到 public/、hasBundledAssets 也认不出随包资源，
 * 表现是页面 404 + PDF 的 worker 加载失败。
 * 改成看 public/ 到底在哪一层，跟布局解耦。
 *
 * SEA 模式下 __SEA_URL__ 指向 exe 本身，ROOT 只是「exe 所在目录」，
 * 而 SEA 分支根本不走它（readAsset 用 sea.getAsset、materializeDir 用临时目录），
 * 所以取 HERE 即可。 */
const ROOT = (() => {
  if (IN_SEA) return HERE;
  if (fs.existsSync(path.join(HERE, 'public'))) return HERE;
  const up = path.resolve(HERE, '..');
  if (fs.existsSync(path.join(up, 'public'))) return up;
  return HERE;
})();

export const isSea = () => IN_SEA;
export const rootDir = () => ROOT;

/**
 * 有没有「随包附带」的资源（public/ 之外的那些：pdfjs 的字体、cmaps、worker）。
 *
 * 判断依据不是「是不是 SEA」，而是「有没有这份附带资源」——因为有两种打包形态
 * 都会带上它们：
 *   - SEA：资源内嵌在 exe 里，用 sea.getAsset() 取
 *   - Electron：构建时把同一批文件拷到 server.cjs 旁边，直接读磁盘
 * 两种情况下 pdfjs 的字体/cmaps/worker 都该从包里取，而不是去找 node_modules
 * （打包后根本没有 node_modules）。
 *
 * asset-manifest.json 在两种形态下都会生成，正好当标记用。
 */
export function hasBundledAssets() {
  if (IN_SEA) return true;
  try {
    return fs.existsSync(path.join(ROOT, 'asset-manifest.json'));
  } catch {
    return false;
  }
}

/** 读一个内嵌资源。非 SEA 模式下按项目根目录下的相对路径读磁盘。 */
export function readAsset(key) {
  if (IN_SEA) return Buffer.from(sea.getAsset(key));
  return fs.readFileSync(path.join(ROOT, key));
}

/** 读 public/ 下的文件。key 是相对 public 的路径，调用方负责挡目录穿越。 */
export function readPublic(rel) {
  const norm = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (IN_SEA) return readAsset('public/' + norm);
  return fs.readFileSync(path.join(ROOT, 'public', norm));
}

let manifestCache = null;
function manifest() {
  if (manifestCache) return manifestCache;
  try {
    manifestCache = JSON.parse(readAsset('asset-manifest.json').toString('utf8'));
  } catch {
    manifestCache = [];
  }
  return manifestCache;
}

/**
 * 把某一前缀下的资源解包到临时目录，返回目录绝对路径。
 * pdfjs 要的是真实文件路径（字体、cmaps），没法直接从内存喂给它。
 * 解过一次就留标记，后续启动不再重复解。
 */
export function materializeDir(prefix) {
  if (!IN_SEA) return path.join(ROOT, prefix);

  const dir = path.join(os.tmpdir(), 'pi-gui-assets', prefix.replace(/\//g, '__'));
  const done = path.join(dir, '.ok');
  if (fs.existsSync(done)) return dir;

  const keys = manifest().filter((k) => k.startsWith(prefix + '/'));
  if (!keys.length) throw new Error(`打包资源里没有 ${prefix}`);

  for (const k of keys) {
    const dest = path.join(dir, ...k.slice(prefix.length + 1).split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readAsset(k));
  }
  fs.writeFileSync(done, '');
  return dir;
}
