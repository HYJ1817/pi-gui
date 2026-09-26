/* 把正式资产集中到 dist-release/ —— 发布目录里**只允许**放这三个文件。
 *
 * 为什么不直接传 dist-installer/：那个目录是构建中间产物，里面可能有
 * 上次版本的残留、`--zip-only` 留下的半成品、以及以后新增的其它中间文件。
 * 「上传时对着目录 glob 一下」这种做法，迟早会把不该传的东西传上去。
 * 所以中间产物留在 dist-app/ 与 dist-installer/，**要上传的东西一律先集中到
 * dist-release/**，release workflow 只允许上传这个目录里的文件。
 *
 * 用法：
 *   node scripts/collect-release-artifacts.mjs
 *   node scripts/collect-release-artifacts.mjs --version=0.13.0
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, readVersionSources } from './check-version.mjs';
import { clearDir, sizeOf } from './util.mjs';
import { expectedAssetNames, staleVersionsInName } from './check-release-artifacts.mjs';
import { writeChecksums } from './make-checksums.mjs';

export const RELEASE_DIR = 'dist-release';

/**
 * @returns {{dir:string, version:string, copied:string[], warnings:string[]}}
 */
export function collectReleaseArtifacts({ version, root = ROOT } = {}) {
  const v = version || readVersionSources(root).pkgVersion;
  const src = path.join(root, 'dist-installer');
  const out = path.join(root, RELEASE_DIR);
  const expected = expectedAssetNames(v);
  const warnings = [];

  if (!fs.existsSync(src)) {
    throw new Error(
      `没有 ${path.relative(root, src)}。\n` +
        '  先跑：npm run build:app -- --rebuild && npm run build:installer -- --zip'
    );
  }

  /* 源目录里有**别的版本**的产物时提醒一句 —— 几乎总是「忘了重新构建」。
   * 这里只警告不失败：收集阶段本来就会按期望文件名精确取，
   * 混不进 dist-release；真正拦截由 check-release-artifacts 负责。 */
  for (const name of fs.readdirSync(src)) {
    const stale = staleVersionsInName(name, v);
    if (stale.length && !name.endsWith('.trash')) {
      warnings.push(`${path.relative(root, src)} 里有别的版本的产物：${name}（出现 ${stale.join('、')}）`);
    }
  }

  const copied = [];
  const missing = [];
  for (const [kind, name] of Object.entries(expected)) {
    if (kind === 'checksums') continue; // 校验和在目标目录重新算，不从源目录搬
    const from = path.join(src, name);
    if (!fs.existsSync(from)) {
      missing.push(`${name}（${kind}）`);
      continue;
    }
    copied.push({ from, name, size: sizeOf(from) });
  }

  if (missing.length) {
    /* 最常见的成因就是「忘了重新构建」—— dist-installer 里还躺着上个版本的产物。
     * 所以把那个线索直接写进错误里，而不是让人自己去 ls。 */
    const staleHint = warnings.length ? `\n  注意：${warnings.join('\n        ')}\n  → 多半是忘了重新构建。` : '';
    throw new Error(
      `dist-installer 里缺少这些产物：\n  ${missing.join('\n  ')}\n` +
        staleHint +
        '\n  修法：npm run build:app -- --rebuild && npm run build:installer -- --zip'
    );
  }

  /* 清空重建 —— 发布目录必须是「本次构建的精确快照」，
   * 留着上次的文件就会出现「文件名版本不一致」这种最难查的形态。 */
  clearDir(out, RELEASE_DIR);
  fs.mkdirSync(out, { recursive: true });

  for (const { from, name } of copied) {
    fs.copyFileSync(from, path.join(out, name));
  }

  /* 校验和在**目标目录**里重新算一遍，而不是把源目录那份拷过来 ——
   * 这样校验和覆盖的就是「真正要上传的那几个字节」。 */
  const { entries } = writeChecksums({ dir: out, names: copied.map((c) => c.name) });

  return { dir: out, version: v, copied: copied.map((c) => c.name), checksums: entries.length, warnings };
}

/* ---------- CLI ---------- */

function main() {
  const versionArg = process.argv.slice(2).find((a) => a.startsWith('--version='))?.slice('--version='.length);
  let r;
  try {
    r = collectReleaseArtifacts({ version: versionArg });
  } catch (err) {
    console.error('\n  ✗ ' + err.message + '\n');
    process.exit(1);
  }

  console.log('');
  for (const w of r.warnings) console.log(`  ! ${w}`);
  for (const name of r.copied) console.log(`  + ${name}  ${(sizeOf(path.join(r.dir, name)) / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  + SHA256SUMS.txt  （${r.checksums} 条）`);
  console.log('');
  console.log(`  已集中到 ${path.relative(ROOT, r.dir)}/  （版本 ${r.version}）`);
  console.log('  下一步：npm run release:verify');
  console.log('');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
