/* 把已经打好的桌面应用包成 Windows 安装程序（NSIS）+ 便携版 zip。
 *
 * 为什么不换 electron-builder 整体接管打包：
 *   @electron/packager 那条链（含「裁 Chromium 语言包省 47 MB」的自定义步骤）
 *   已经过 17 项打包验收 + 端到端 + 窗口状态验收，产物路径 dist-app/Pi GUI-win32-x64
 *   被一堆测试脚本引用。让 electron-builder 重来一遍会全部推翻重验。
 *   所以这里只做「包装」—— 拿现成的应用目录生成安装程序，其余不动。
 *
 * 用法：
 *   npm run build:installer            # 装完应用后执行
 *   node scripts/build-installer.mjs --zip            # 顺带出便携版 zip
 *   node scripts/build-installer.mjs --nsis=C:\...\makensis.exe
 *
 * 需要 makensis（NSIS 3）。找不到时会给出明确的获取方式。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sizeOf, mb, kb, clearDir, slash } from './util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = 'Pi GUI';
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const APP_DIR = path.join(ROOT, 'dist-app', `${APP_NAME}-win32-x64`);
const ICON = path.join(ROOT, 'build', 'icon.ico');
const NSI = path.join(ROOT, 'installer', 'pi-gui.nsi');
const OUT = path.join(ROOT, 'dist-installer');
const SETUP = path.join(OUT, `Pi-GUI-Setup-${VERSION}.exe`);
const ZIP = path.join(OUT, `Pi-GUI-${VERSION}-portable.zip`);

const argv = process.argv.slice(2);
const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const wantsZip = argv.includes('--zip');
/* 跳过 NSIS 重编译，只出 zip + 校验和。
 * 压缩 300+ MB 要 3~4 分钟，改 zip 打包方式时不该每次都重跑一遍。
 * 要求 dist-installer 里已经有上一步编出来的安装程序。 */
const zipOnly = argv.includes('--zip-only');

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);

/* ---------- 1. 找 makensis ---------- */

/* 候选位置按「最可能」排：
 *   1) --nsis= 显式指定
 *   2) 环境变量 NSIS_HOME
 *   3) PATH
 *   4) 常规安装位置
 *   5) electron-builder 的缓存 —— 本机就是靠这一条，白捡一份免安装的 NSIS
 *      （目录名带哈希后缀，所以要 glob）
 */
function findMakensis() {
  const explicit = flag('nsis');
  if (explicit) {
    const p = path.resolve(explicit);
    if (!fs.existsSync(p)) throw new Error(`--nsis 指定的文件不存在：${p}`);
    return p;
  }

  const home = process.env.NSIS_HOME;
  if (home) {
    const p = path.join(home, 'makensis.exe');
    if (fs.existsSync(p)) return p;
  }

  try {
    const out = execFileSync('where', ['makensis.exe'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && fs.existsSync(first)) return first;
  } catch {
    /* PATH 里没有 */
  }

  for (const p of [
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
  ]) {
    if (fs.existsSync(p)) return p;
  }

  const cache = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache');
  for (const dir of ['nsis', 'nsis-3.0.4.1']) {
    const base = path.join(cache, dir);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base)) {
      // 缓存目录名形如 nsis-3.0.4.1-1mx3n，哈希后缀不固定，逐层找
      for (const sub of [entry, ...safeList(path.join(base, entry))]) {
        const p = path.join(base, entry, sub, 'makensis.exe');
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/* ---------- 2. 校验输入 ---------- */

step(1, '检查输入');
if (!fs.existsSync(path.join(APP_DIR, `${APP_NAME}.exe`))) {
  throw new Error(
    `没有 ${APP_DIR}\\${APP_NAME}.exe\n` +
      '  先跑一次 npm run build:app 生成应用目录，再来做安装程序。'
  );
}
if (!fs.existsSync(ICON)) throw new Error(`没有图标 ${ICON}，先跑 npm run build:app`);
if (!fs.existsSync(NSI)) throw new Error(`缺 ${NSI}`);

const makensis = findMakensis();
if (!makensis) {
  throw new Error(
    '没找到 makensis（NSIS 编译器）。\n\n' +
      '  三种办法任选其一：\n' +
      '    1) 下载免安装版 NSIS 解压后：node scripts/build-installer.mjs --nsis=<目录>\\makensis.exe\n' +
      '       https://nsis.sourceforge.io/Download\n' +
      '    2) 用包管理器装：  winget install NSIS.NSIS   （或 choco install nsis）\n' +
      '    3) 设环境变量 NSIS_HOME 指向 NSIS 根目录\n'
  );
}
console.log(`  应用目录   ${path.relative(ROOT, APP_DIR)}  ${mb(sizeOf(APP_DIR))}`);
console.log(`  makensis   ${makensis}`);

/* ---------- 3. 编译安装程序 ---------- */

if (zipOnly) {
  if (!fs.existsSync(SETUP)) {
    throw new Error(`--zip-only 需要已有的 ${path.relative(ROOT, SETUP)}，先完整跑一次`);
  }
  console.log(`\n[2] 跳过安装程序编译（--zip-only），沿用 ${path.basename(SETUP)}`);
} else {
  step(2, '编译安装程序（LZMA 固体压缩，300+ MB 需要几分钟）');
  clearDir(OUT, 'dist-installer');
  fs.mkdirSync(OUT, { recursive: true });

const args = [
  `/DAPP_NAME=${APP_NAME}`,
  `/DAPP_EXE=${APP_NAME}.exe`,
  `/DVERSION=${VERSION}`,
  '/DPUBLISHER=Pi GUI',
  `/DAPP_DIR=${APP_DIR}`,
  `/DICON_FILE=${ICON}`,
  `/DESTIMATED_KB=${kb(sizeOf(APP_DIR))}`,
  `/DOUT_FILE=${SETUP}`,
  NSI,
];

const t0 = Date.now();
try {
  // 不用 shell：路径里有空格（Pi GUI.exe、dist-app\Pi GUI-win32-x64），
  // 拼成一条字符串传过去必然被切坏。
  //
  // 输出路径用 /DOUT_FILE= 传给脚本里的 OutFile，别用 /XOutFile ——
  // 后者与值的分隔方式不同，实测会被整条忽略，于是 OutFile 落到一个未定义的宏上，
  // NSIS 就拿字面量 "${OUT_FILE}" 当文件名，在脚本目录里生成出一个叫这名字的
  // 100 MB 文件，然后照样打印 "Total size"，看起来完全像成功。
  // 所以 .nsi 里加了 !ifndef 检查（见 installer/pi-gui.nsi 的宏检查段）。
  const out = execFileSync(makensis, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const tail = out.trim().split(/\r?\n/).slice(-4).join('\n');
  if (tail) console.log('  ' + tail.split('\n').join('\n  '));
} catch (err) {
  const msg = String(err.stdout || '') + String(err.stderr || '');
  throw new Error('makensis 编译失败：\n\n' + msg);
}
console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

/* ---------- 4. 便携版 zip ---------- */

let zipPath = null;
if (wantsZip) {
  step(3, '打便携版 zip');
  /* 用系统自带的 tar（Windows 10+ 的 bsdtar），-a 按扩展名自动选压缩方式。
   * 不引第三方压缩库 —— 只为出一个 zip 装一个大依赖不划算。
   *
   * 两条限制都得绕：
   *   1) 路径不能带盘符：Windows 的 tar 会把 "C:\..." 里的 "C:" 当成 rsh 远程主机
   *      （"Cannot connect to C: resolve failed"）。-f 一样中招，不是只有 -C。
   *      → 用 cwd + 相对路径。
   *   2) 相对路径里的反斜杠是**转义字符**：`dist-app\7zip` 会被解析成八进制转义，
   *      路径变形后报 "Cannot open"，看不出跟分隔符有关。→ 一律换成正斜杠。
   *      （这条是 portable-check 里踩到的，当时路径里有个 `\21022`。） */
  execFileSync(
    'tar',
    [
      '-a',
      '-cf',
      slash(path.relative(ROOT, ZIP)),
      '-C',
      slash(path.relative(ROOT, path.dirname(APP_DIR))),
      path.basename(APP_DIR),
    ],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  zipPath = ZIP;
  console.log(`  ${path.basename(ZIP)}  ${mb(sizeOf(ZIP))}`);
}

/* ---------- 5. 校验和 ---------- */

step(wantsZip ? 4 : 3, '生成校验和');
const sums = [SETUP, zipPath].filter(Boolean).map((p) => {
  const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  return `${h}  ${path.basename(p)}`;
});
fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), sums.join('\n') + '\n', 'utf8');
for (const l of sums) console.log('  ' + l);

/* ---------- 结果 ---------- */

console.log('\n  完成 → ' + path.relative(ROOT, OUT));
console.log(`  安装程序  ${path.basename(SETUP)}  ${mb(sizeOf(SETUP))}`);
if (zipPath) console.log(`  便携版    ${path.basename(zipPath)}  ${mb(sizeOf(zipPath))}`);
console.log('\n  上传 GitHub 时把 dist-installer 里的文件一起传上去；');
console.log('  建议再附一句：需要本机已安装 pi（pi-coding-agent）。');
