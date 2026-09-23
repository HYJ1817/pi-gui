/* 把 Pi GUI 打成真正的桌面应用（Electron）。
 *
 * 和「单文件 exe」的区别：
 *   - build/Pi GUI.exe 是 Node SEA，双击后仍要开浏览器 —— 本质是本地网页
 *   - 这里的产物是独立进程、独立窗口、独立任务栏图标的桌面程序，不经过浏览器
 *
 * 目录结构（打包后）：
 *   Pi GUI.exe                         Electron 运行时（窗口、Chromium）
 *   resources/app/main.cjs             主进程：起后端 + 开窗口
 *   resources/app/server.cjs           后端（esbuild 打的单文件，含 pdfjs 代码）
 *   resources/app/public/…             前端静态资源（index.html / app.js / styles.css）
 *   resources/app/pdfjs/…              pdfjs 的字体 / cmaps / worker
 *
 * 后端用 Electron 自带的 Node 跑（ELECTRON_RUN_AS_NODE），不再另带一份运行时。
 * 早先的做法是把 Node SEA 单文件 exe 塞进 resources/，结果是 Electron 和它
 * 各装一套 Node，白胖 93 MB —— 现在省掉了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
// 删目录 / 算体积 / 拷文件这套东西安装程序脚本也要用，统一放 scripts/util.mjs
import { sizeOf, mb, copyInto, removePaths, clearDir } from './util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const STAGE = path.join(BUILD, 'electron-app');
const OUT = path.join(ROOT, 'dist-app');
const PDFJS = path.join(ROOT, 'node_modules', 'pdfjs-dist');
const APP_NAME = 'Pi GUI';
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/* Chromium 自带几十种语言的 .pak，我们只需要中文和英文兜底，其余全部删掉。
 * 语言包不删的话光这一项就 48 MB。 */
const KEEP_LOCALES = new Set(['zh-CN.pak', 'en-US.pak']);

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);

/* 1. 图标 */
step(1, '生成图标');
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-icon.mjs')], { stdio: 'inherit', cwd: ROOT });

/* 2. 后端产物：server.cjs（含 pdfjs 代码）+ asset-manifest.json */
step(2, '构建后端产物');
const serverCjs = path.join(BUILD, 'server.cjs');
if (process.argv.includes('--rebuild') || !fs.existsSync(serverCjs)) {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-exe.mjs')], { stdio: 'inherit', cwd: ROOT });
} else {
  console.log('  复用已有的 build/server.cjs（要重建加 --rebuild）');
}

/* 3. 组装应用目录
 *
 * pdfjs 的字体 / cmaps / worker 必须和 server.cjs 放在一起：
 * lib/assets.js 的 hasBundledAssets() 靠 asset-manifest.json 判断
 * 「这是打包形态」，然后 materializeDir 会在非 SEA 下直接返回
 * ROOT/pdfjs/xxx —— ROOT 就是本目录。少一样 PDF 就会抽不出中文。 */
step(3, '组装应用目录');
clearDir(STAGE);
fs.mkdirSync(STAGE, { recursive: true });

fs.writeFileSync(
  path.join(STAGE, 'package.json'),
  JSON.stringify({ name: 'pi-gui', productName: APP_NAME, version: VERSION, main: 'main.cjs' }, null, 2)
);
fs.copyFileSync(path.join(ROOT, 'electron', 'main.cjs'), path.join(STAGE, 'main.cjs'));
fs.copyFileSync(serverCjs, path.join(STAGE, 'server.cjs'));
fs.copyFileSync(path.join(BUILD, 'asset-manifest.json'), path.join(STAGE, 'asset-manifest.json'));

/* 前端静态资源。漏了这个的话页面直接 404 —— 而且开发机上不会发现，
 * 因为开发模式读的是项目根的 public/。 */
copyInto(STAGE, path.join(ROOT, 'public'), 'public');

for (const [key, src] of [
  ['pdfjs/standard_fonts', path.join(PDFJS, 'standard_fonts')],
  ['pdfjs/cmaps', path.join(PDFJS, 'cmaps')],
]) {
  if (!fs.existsSync(src)) throw new Error(`缺少 ${src}，先运行 npm install`);
  copyInto(path.join(STAGE, path.dirname(key)), src, path.basename(key));
}

const worker = path.join(PDFJS, 'legacy', 'build', 'pdf.worker.mjs');
if (!fs.existsSync(worker)) throw new Error('缺少 pdf.worker.mjs，先运行 npm install');
copyInto(path.join(STAGE, 'pdfjs', 'worker'), worker, 'pdf.worker.mjs');

console.log(`  应用目录 ${(sizeOf(STAGE) / 1024 / 1024).toFixed(1)} MB`);

/* 4. 打 Electron 应用 */
step(4, '打包 Electron 应用');

/* packager 的 overwrite 走 fs.promises.rm，在带「批量删除保护」的环境里
 * 会因为文件数超阈值直接抛错。所以先自己把旧产物挪开（见 clearDir 的说明）——
 * dist-app/ 完全是可再生的构建输出，挪走没有任何风险。 */
clearDir(OUT);

const appPaths = await packager({
  dir: STAGE,
  name: APP_NAME,
  platform: 'win32',
  arch: 'x64',
  out: OUT,
  overwrite: true,
  asar: false, // 后端要往磁盘写上传临时文件，asar 里写不了
  prune: false,
  quiet: true,
  icon: path.join(BUILD, 'icon.ico'),
  appVersion: VERSION,
  win32metadata: {
    CompanyName: 'Pi GUI',
    FileDescription: 'Pi Coding Agent 桌面客户端',
    ProductName: APP_NAME,
    OriginalFilename: APP_NAME + '.exe',
  },
});

const appDir = appPaths[0];

/* 5. 精简语言包
 *
 * 做成「尽力而为」：删不掉只警告、不中断构建。有些受限环境（带批量删除
 * 保护、只读挂载）会拒绝这种批量删除，但那不该让整个打包流程失败 ——
 * 代价只是产物多占几十 MB。 */
step(5, '精简语言包');
const localesDir = path.join(appDir, 'locales');
if (fs.existsSync(localesDir)) {
  const doomed = fs.readdirSync(localesDir).filter((f) => !KEEP_LOCALES.has(f));

  // 体积必须在删之前量 —— 早先是在收尾时统一 sizeOf 一遍，
  // 结果已经删掉的文件会 stat 不到，直接 ENOENT 把构建打挂。
  const entries = doomed.map((f) => {
    const p = path.join(localesDir, f);
    let n = 0;
    try {
      n = sizeOf(p);
    } catch {
      /* 量不到就按 0 算，不影响流程 */
    }
    return { p, n };
  });

  const stuck = new Set(removePaths(entries.map((e) => e.p)));
  const freed = entries.filter((e) => !stuck.has(e.p)).reduce((a, e) => a + e.n, 0);
  const keptBytes = entries.filter((e) => stuck.has(e.p)).reduce((a, e) => a + e.n, 0);

  if (stuck.size) {
    console.log(
      `  保留 ${[...KEEP_LOCALES].join(' / ')}；有 ${stuck.size} 个语言包删不掉，` +
        `产物因此多占约 ${(keptBytes / 1024 / 1024).toFixed(0)} MB`
    );
  } else {
    console.log(`  保留 ${[...KEEP_LOCALES].join(' / ')}，清掉 ${(freed / 1024 / 1024).toFixed(1)} MB`);
  }
}

/* 6. 汇总 */
const total = sizeOf(appDir);
const exe = path.join(appDir, APP_NAME + '.exe');

console.log('');
console.log(`  完成 → ${path.relative(ROOT, appDir)}`);
console.log(`  入口 → ${APP_NAME}.exe  (${(sizeOf(exe) / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  整包 ${(total / 1024 / 1024).toFixed(1)} MB`);
console.log('');
console.log('  双击其中的 Pi GUI.exe 即可启动，不需要 Node，也不会打开浏览器。');
