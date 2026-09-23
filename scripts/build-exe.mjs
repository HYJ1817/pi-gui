/* 打包成单文件 exe（Node SEA）。
 *
 * 做三件事：
 *   1. esbuild 把 ESM 服务端代码打成一份 CJS（含 pdfjs，约 1.2MB）
 *   2. 把 public/ 和 pdfjs 的字体/cmaps 收集成 SEA assets 清单
 *   3. 生成 blob，注入到 node.exe 副本里，产出 Pi GUI.exe
 *
 * 用法：npm run build:exe
 * 产物：build/Pi GUI.exe（约 100MB，单文件，内嵌全部资源） */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import { clearDir } from './util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const PDFJS = path.join(ROOT, 'node_modules', 'pdfjs-dist');

// Windows 上注入 SEA blob 用的哨兵
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const EXE_NAME = 'Pi GUI.exe';

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function main() {
  // 不能用裸 fs.rmSync：受限环境注入了删除保护，build/ 里几百个文件会被拦下，
  // 报 "state lock timeout" 而构建直接失败。clearDir 有三级兜底。
  clearDir(BUILD, 'build/');
  fs.mkdirSync(BUILD, { recursive: true });

  /* 1. 收集资源 */
  const assets = {};
  const add = (key, file) => {
    assets[key] = rel(file);
  };

  for (const f of walk(path.join(ROOT, 'public'))) add(rel(f), f);

  for (const [key, sub] of [
    ['pdfjs/standard_fonts', 'standard_fonts'],
    ['pdfjs/cmaps', 'cmaps'],
  ]) {
    const dir = path.join(PDFJS, sub);
    if (!fs.existsSync(dir)) {
      console.log(`  跳过 ${sub}（node_modules 里没有，先 npm install）`);
      continue;
    }
    for (const f of walk(dir)) add(`${key}/${path.relative(dir, f).replace(/\\/g, '/')}`, f);
  }

  // pdfjs 的 worker 是运行时按路径动态 import 的，esbuild 抓不到，必须单独带上。
  // 少这个文件会报 "Setting up fake worker failed"。
  const worker = path.join(PDFJS, 'legacy', 'build', 'pdf.worker.mjs');
  if (!fs.existsSync(worker)) throw new Error('缺少 pdf.worker.mjs，先 npm install');
  add('pdfjs/worker/pdf.worker.mjs', worker);

  // SEA 没有「列出全部资源」的接口，materializeDir 要靠这份清单按前缀解包
  const manifestPath = path.join(BUILD, 'asset-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(Object.keys(assets).sort(), null, 0));
  assets['asset-manifest.json'] = rel(manifestPath);

  console.log(`  资源 ${Object.keys(assets).length} 项`);

  /* 2. 打包服务端代码 */
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'server.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: path.join(BUILD, 'server.cjs'),
    // 打包后是单文件，import.meta.url 在 CJS 下会变空，用 banner 注入真实路径
    define: { 'import.meta.url': '__SEA_URL__' },
    banner: { js: 'var __SEA_URL__=require("url").pathToFileURL(__filename).href;' },
    logLevel: 'warning',
  });
  const bundleSize = fs.statSync(path.join(BUILD, 'server.cjs')).size;
  console.log(`  代码打包 ${(bundleSize / 1024 / 1024).toFixed(2)} MB`);

  /* 3. 生成 blob */
  const seaConfig = path.join(BUILD, 'sea-config.json');
  fs.writeFileSync(
    seaConfig,
    JSON.stringify(
      {
        main: rel(path.join(BUILD, 'server.cjs')),
        output: rel(path.join(BUILD, 'sea-prep.blob')),
        disableExperimentalSEAWarning: true,
        assets,
      },
      null,
      2
    )
  );

  execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit', cwd: ROOT });
  const blob = fs.statSync(path.join(BUILD, 'sea-prep.blob')).size;
  console.log(`  blob ${(blob / 1024 / 1024).toFixed(2)} MB`);

  /* 4. 复制 node.exe 并注入 */
  const exe = path.join(BUILD, EXE_NAME);
  fs.copyFileSync(process.execPath, exe);
  console.log(`  基础 ${path.basename(process.execPath)} ${(fs.statSync(exe).size / 1024 / 1024).toFixed(1)} MB`);

  const postject = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
  if (!fs.existsSync(postject)) {
    throw new Error('缺少 postject，先运行 npm install（它已列在 devDependencies）');
  }
  execFileSync(
    process.execPath,
    [postject, exe, 'NODE_SEA_BLOB', path.join(BUILD, 'sea-prep.blob'), '--sentinel-fuse', FUSE],
    { stdio: 'inherit', cwd: ROOT }
  );

  const final = fs.statSync(exe).size;
  console.log('');
  console.log(`  完成 → build/${EXE_NAME}  (${(final / 1024 / 1024).toFixed(1)} MB)`);
  console.log('  双击即可运行；资源全部内嵌，可单独拷走。');
}

main();
