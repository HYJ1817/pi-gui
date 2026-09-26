/* 发布产物守卫 —— 上传之前的最后一道闸。
 *
 * 这一层的价值在于：它检查的是**「这批东西配得上叫正式 Release 吗」**，
 * 而不是「构建成功了没有」。构建成功但资产错的情况有好几种，
 * 每一种都能静默地发出去：
 *
 *   - 版本号对不上（package.json 是 0.13.0，文件名却是 0.12.0 —— 上次的产物没清）
 *   - 少一个资产（便携版没打成功，只传了安装程序）
 *   - 混进了调试 / 测试文件（fake-pi.cjs、debug.log、.env）
 *   - SHA256SUMS.txt 与文件对不上（改过文件没重算）
 *   - 语义重复（两个都被 P5 识别成 installer，用户不知道该点哪个）
 *
 * 其中「P5 能不能识别」这一条尤其重要：资产名字改了但没同步
 * server/update-check.js 的 classifyAsset()，Release 会发得很成功，
 * 而应用内的更新面板只有「查看 Release」、没有「安装版 / 便携版」按钮 ——
 * 这个失败是**在用户那边**才暴露的。所以这里直接复用 P5 的分类函数来验。
 *
 * 用法：
 *   node scripts/check-release-artifacts.mjs
 *   node scripts/check-release-artifacts.mjs --dir=dist-release --version=0.12.0
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, readVersionSources } from './check-version.mjs';
import { CHECKSUM_FILE, verifyChecksums } from './make-checksums.mjs';
import { fileMagicMismatch } from './util.mjs';
import { classifyAsset } from '../server/update-check.js';

/** 正式资产的命名契约。**改这里必须同步 server/update-check.js 的 classifyAsset()。** */
export function expectedAssetNames(version) {
  return {
    installer: `Pi-GUI-Setup-${version}.exe`,
    portable: `Pi-GUI-${version}-portable.zip`,
    checksums: CHECKSUM_FILE,
  };
}

/** 允许出现在 dist-release/ 里的文件名（**白名单**，不是黑名单）。 */
export function allowedReleaseFiles(version) {
  const n = expectedAssetNames(version);
  return [n.installer, n.portable, n.checksums];
}

/* 明确不许出现的形态。
 * 白名单已经挡住了绝大多数，这一层是为了给出**看得懂的原因**
 * —— 「为什么这个文件不能进发布目录」比「不在白名单里」有用得多。 */
const FORBIDDEN = [
  [/^fake-|fake-pi/i, '测试用的假 pi'],
  [/test-?fixtures?/i, '测试固件'],
  [/\.(log|dmp|tmp|bak|orig|rej)$/i, '日志 / 崩溃转储 / 临时文件'],
  [/^\.env|\.env$/i, '环境变量文件（可能含密钥）'],
  [/\.(pdb|map)$/i, '调试符号 / sourcemap'],
  [/^\.(git|DS_Store|gitignore)|Thumbs\.db$/i, '版本控制或系统文件'],
  [/\.(cjs|mjs|js|ts|json)$/i, '源码或元数据（发布目录只放二进制与校验和）'],
  [/SHA256SUMS\.txt\./i, '校验和文件的临时副本'],
];

/** 文件名里出现的、与期望版本不同的版本号 —— **只用于诊断提示**。
 *
 * 两条设计决定，都是踩出来的：
 *
 * 1. **先看名字里有没有期望版本，有就放行。**
 *    不能「先抽取所有像版本号的片段再逐个比对」—— `Pi-GUI-0.13.0-portable.zip`
 *    里的 `0.13.0-portable` 在语法上**是**一个合法 semver（`portable` 是合法的
 *    预发布标识符）。那样抽取会把正常文件名判成「版本不符」。
 *
 * 2. **只报核心三段版本**（`0.11.1`），不带上 `-portable.zip` 这类后缀。
 *    `-portable.zip` 与 `-beta.1` 在语法上无法区分，而这里要回答的是
 *    「这个文件名里带着哪个版本」，`0.11.1` 就是答案。
 *
 * ⚠️ 这一条**不是**主闸 —— 主闸是 `allowedReleaseFiles()` 的白名单：
 * 名字不对的文件根本不在白名单里，必然被拦。这个函数只是让报错更可读
 * （「文件名里的版本与 package.json 不符」比「不在白名单里」有用得多）。 */
export function staleVersionsInName(name, version) {
  const s = String(name);
  if (s.includes(version)) return [];
  return s.match(/\d+\.\d+\.\d+/g) || [];
}

/** 文件魔数检查在 `scripts/util.mjs` 的 `fileMagicMismatch()` 里 ——
 * 构建脚本打完 zip 会**立刻**用它验一遍（失败定位更直接），
 * 这里再验一次作为发布前的兜底。两处必须同一份实现。
 *
 * 它挡的是「存在、非空、名字对，但内容根本不是那个东西」：
 *   - 下载失败时把 HTML 错误页存成了 .exe
 *   - 被中断的构建留下的半截文件（实测踩到过：SIGTERM 掉 makensis 之后
 *     留下一个 48 MB 的 Setup.exe，而正常是 100 MB）
 *   - **tar 改名成 .zip** —— 这个是**真的发出去过**的缺陷：build-installer 用
 *     GNU tar 的 `-a` 打「zip」，实际产出 tar，Windows 用户双击打不开。
 *     zip 除了查开头 `PK\x03\x04`，还要查末尾的中央目录结尾记录（EOCD）。 */

/**
 * 检查一个「发布目录」配不配上传。
 * @param dir       发布目录（dist-release）
 * @param version   期望版本；不传就从 package.json 读
 * @param appDir    可选的已构建应用目录 —— 给了就顺带核对构建 metadata 的版本
 * @returns {{ok:boolean, version:string, errors:string[], warnings:string[], assets:Array}}
 */
export function checkReleaseDir({ dir, version, appDir = null } = {}) {
  const errors = [];
  const warnings = [];
  const assets = [];

  const v = version || readVersionSources().pkgVersion;
  const expected = expectedAssetNames(v);
  const allowed = allowedReleaseFiles(v);

  if (!fs.existsSync(dir)) {
    return { ok: false, version: v, errors: [`发布目录不存在：${dir}`], warnings, assets };
  }

  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();

  /* 1. 白名单：多一个都不行。 */
  for (const name of names) {
    if (!allowed.includes(name)) {
      const why = FORBIDDEN.find(([re]) => re.test(name));
      errors.push(`发布目录里有不该出现的文件：${name}${why ? `（${why[1]}）` : '（不在正式资产白名单里）'}`);
    }
  }

  /* 2. 期望的三个资产：存在、非空、魔数对得上。 */
  for (const [kind, name] of Object.entries(expected)) {
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) {
      errors.push(`缺少正式资产（${kind}）：${name}`);
      continue;
    }
    const size = fs.statSync(full).size;
    if (size === 0) {
      errors.push(`资产是空文件：${name}`);
      continue;
    }
    const badMagic = fileMagicMismatch(full);
    if (badMagic) {
      errors.push(`${name} 看起来不是有效文件：${badMagic}`);
      continue;
    }
    assets.push({ name, size, kind });
  }

  /* 3. 版本号：文件名里的版本必须与 package.json 一致。 */
  for (const name of names) {
    const stale = staleVersionsInName(name, v);
    if (stale.length) {
      errors.push(`文件名里的版本与 package.json（${v}）不符：${name}（出现 ${stale.join('、')}）`);
    }
  }

  /* 4. 语义重复：两个都被 P5 识别成 installer / portable / checksums
   *    会让用户不知道该点哪个。这一条顺带钉住了「命名契约与 classifyAsset 一致」。 */
  const byKind = new Map();
  for (const name of names) {
    const kind = classifyAsset(name);
    if (kind === 'other') continue;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(name);
  }
  for (const [kind, list] of byKind) {
    if (list.length > 1) errors.push(`有 ${list.length} 个文件都会被识别成「${kind}」：${list.join('、')}`);
  }

  /* 5. P5 兼容：正式资产必须被应用内的更新面板认出来。
   *    认不出来的话，Release 发得成功，但用户那边只有「查看 Release」。 */
  if (fs.existsSync(path.join(dir, expected.installer)) && classifyAsset(expected.installer) !== 'installer') {
    errors.push(`安装程序 ${expected.installer} 没被 classifyAsset 识别成 installer —— P5 更新面板不会给下载按钮`);
  }
  if (fs.existsSync(path.join(dir, expected.portable)) && classifyAsset(expected.portable) !== 'portable') {
    errors.push(`便携版 ${expected.portable} 没被 classifyAsset 识别成 portable —— P5 更新面板不会给下载按钮`);
  }
  if (fs.existsSync(path.join(dir, expected.checksums)) && classifyAsset(expected.checksums) !== 'checksums') {
    errors.push(`${expected.checksums} 没被 classifyAsset 识别成 checksums`);
  }

  /* 6. 校验和：内容必须与目录里的文件对得上，且覆盖完整。 */
  const sumsPath = path.join(dir, expected.checksums);
  if (fs.existsSync(sumsPath)) {
    const text = fs.readFileSync(sumsPath, 'utf8');
    if (/[A-Za-z]:[\\/]|^\s*\/|\.\./.test(text)) {
      errors.push('SHA256SUMS.txt 里出现了路径 —— 只允许裸文件名');
    }
    const res = verifyChecksums(dir, text);
    if (!res.ok) for (const e of res.errors) errors.push(`校验和：${e}`);
  }

  /* 7. 构建 metadata 的版本（给了 appDir 才查）。
   *    这是「产物到底是哪个版本打出来的」最直接的证据 —— 它来自构建时写进
   *    resources/app/package.json 的那一份。 */
  if (appDir) {
    const appPkg = path.join(appDir, 'resources', 'app', 'package.json');
    if (!fs.existsSync(appPkg)) {
      warnings.push(`找不到构建 metadata（${path.relative(ROOT, appPkg)}），跳过版本核对`);
    } else {
      try {
        const meta = JSON.parse(fs.readFileSync(appPkg, 'utf8'));
        if (meta.version !== v) {
          errors.push(`构建 metadata 的版本与 package.json 不符：${meta.version} ≠ ${v}（产物是旧版本打的）`);
        }
      } catch (err) {
        errors.push(`构建 metadata 读不出来：${err.message}`);
      }
    }
  }

  return { ok: errors.length === 0, version: v, errors, warnings, assets };
}

/* ---------- CLI ---------- */

function main() {
  const argv = process.argv.slice(2);
  const dirArg = argv.find((a) => a.startsWith('--dir='))?.slice('--dir='.length);
  const versionArg = argv.find((a) => a.startsWith('--version='))?.slice('--version='.length);
  const dir = path.resolve(ROOT, dirArg || 'dist-release');
  const appDir = path.resolve(ROOT, 'dist-app', 'Pi GUI-win32-x64');

  const result = checkReleaseDir({ dir, version: versionArg, appDir: fs.existsSync(appDir) ? appDir : null });

  console.log('');
  console.log(`  发布产物检查  ${path.relative(ROOT, dir)}  （版本 ${result.version}）`);
  for (const a of result.assets) console.log(`    ✓ ${a.name}  ${(a.size / 1024 / 1024).toFixed(1)} MB  [${a.kind}]`);
  for (const w of result.warnings) console.log(`  ! ${w}`);

  if (!result.ok) {
    console.log('');
    for (const e of result.errors) console.error(`  ✗ ${e}`);
    console.error('\n  发布产物检查失败 —— 不要上传这批东西。\n');
    process.exit(1);
  }

  console.log('  ✓ 三个正式资产齐全、版本一致、校验和正确、P5 都能识别');
  console.log('');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
