/* 版本一致性校验 —— 发版流程里最危险的一类错误。
 *
 * 症状是**静默的**：`package.json` 说 0.13.0、tag 打的是 v0.12.0、
 * 安装程序叫 Pi-GUI-Setup-0.13.0.exe —— 三处各自都「正常」，
 * 拼起来才是错的。而 GitHub Release 一旦发出去，
 * 用户装到的版本与页面宣称的版本对不上，且**看起来一切正常**。
 *
 * 所以这一层的原则是：**发现不一致直接失败，绝不猜**。
 * 不要「tag 是 v0.13.0、package.json 是 0.12.0，那就自动把 package.json 改成
 * 0.13.0 然后继续」—— 那样 release 的 source code 就与 tag 声称的内容不符了
 * （见 docs/releasing.md 的「版本号必须在 tag 之前进仓库」）。
 *
 * 本文件既提供纯函数（给测试用，不碰磁盘），也提供 CLI（给 workflow / 本机用）。
 *
 * 用法：
 *   node scripts/check-version.mjs                     # 只查 package / lock
 *   node scripts/check-version.mjs --tag=v0.13.0       # 额外要求 tag === v<version>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVersion } from '../server/update-check.js';
import { ROOT } from './util.mjs';

/* 继续 re-export：ROOT 的真身在 util.mjs（那边不依赖任何项目内模块），
 * 这里转出去只是为了让 `from './check-version.mjs'` 的老调用方不用改。 */
export { ROOT };

/* ---------- SemVer ----------
 *
 * **复用 P5 那份解析器**（server/update-check.js 的 parseVersion），
 * 不在这里再写一遍 —— 两份 SemVer 迟早会漂，而「哪一份说了算」这种问题
 * 在发版流程里代价最高。
 *
 * 但发版比「比较大小」严一档：**必须是完整的三段**。
 * parseVersion 为了容错接受 `1` 与 `1.0`（缺段按 0 补），那是给
 * 「GitHub 上出现奇怪 tag」准备的；发版不能这么宽松 ——
 * `0.13` 与 `0.13.0` 在文件名、tag、npm 元数据里是三个不同的字符串。 */
const STRICT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** 合法的发版版本号（三段 + 可选 prerelease/build）。 */
export function isValidReleaseVersion(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!STRICT_VERSION_RE.test(s)) return false;
  return parseVersion(s) !== null;
}

/** 是不是预发布版本（`0.13.0-beta.1`）。 */
export function isPrerelease(v) {
  const p = parseVersion(typeof v === 'string' ? v.trim() : v);
  return Boolean(p && p.prerelease.length);
}

/* ---------- 读版本源 ---------- */

export function readVersionSources(root = ROOT) {
  const pkgPath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  return {
    pkgPath,
    lockPath,
    pkgVersion: typeof pkg.version === 'string' ? pkg.version : null,
    lockVersion: typeof lock.version === 'string' ? lock.version : null,
    /* package-lock 的 v2/v3 格式里版本号出现两次：顶层 version 和
     * packages[""].version。**两个都要查** —— 只改一处是最常见的
     * 「手改了 package.json 然后 npm install」留下的形态。 */
    lockRootVersion:
      lock.packages && lock.packages[''] && typeof lock.packages[''].version === 'string'
        ? lock.packages[''].version
        : null,
  };
}

/* ---------- 一致性判定（纯函数，不碰磁盘） ---------- */

/**
 * @param pkgVersion      package.json 的 version
 * @param lockVersion     package-lock.json 顶层的 version
 * @param lockRootVersion package-lock.json 里 packages[""].version
 * @param tag             形如 `v0.13.0`；不传就只查前三个
 * @returns {{ok:boolean, version:string|null, errors:string[], warnings:string[]}}
 */
export function checkVersionConsistency({ pkgVersion, lockVersion, lockRootVersion, tag = null } = {}) {
  const errors = [];
  const warnings = [];

  if (!isValidReleaseVersion(pkgVersion)) {
    errors.push(
      `package.json 的 version 不是合法的发版版本号：${JSON.stringify(pkgVersion)}` +
        `（要求三段 x.y.z，可选 -prerelease）`
    );
    // 版本号本身就不合法时，后面几条比对没有意义，直接返回
    return { ok: false, version: null, errors, warnings };
  }

  if (lockVersion !== pkgVersion) {
    errors.push(
      `package-lock.json 顶层 version 与 package.json 不一致：` +
        `${JSON.stringify(lockVersion)} ≠ ${JSON.stringify(pkgVersion)}`
    );
  }
  if (lockRootVersion !== pkgVersion) {
    errors.push(
      `package-lock.json 的 packages[""].version 与 package.json 不一致：` +
        `${JSON.stringify(lockRootVersion)} ≠ ${JSON.stringify(pkgVersion)}` +
        `（用 npm run version:set 一次改齐，别手改）`
    );
  }

  if (tag !== null && tag !== undefined) {
    if (typeof tag !== 'string' || !tag) {
      errors.push(`tag 为空或不是字符串：${JSON.stringify(tag)}`);
    } else {
      const expected = `v${pkgVersion}`;
      if (tag !== expected) {
        errors.push(
          `tag 与 package.json 的版本不匹配：tag=${JSON.stringify(tag)}，` +
            `期望 ${JSON.stringify(expected)}（tag 必须是 v<package.json 的 version>）`
        );
      }
      /* 只支持稳定版发布（P6 的策略）。
       * 理由：P5 的 /api/update 读的是 GitHub 的 /releases/latest，
       * 它按定义**不含 prerelease** —— 发一个 beta 出去，应用内根本发现不了，
       * 用户会以为「发布成功了但没生效」。所以宁可在这里明确拒绝，
       * 也不要发一个「发得出去但看不到」的版本。 */
      if (isPrerelease(pkgVersion)) {
        errors.push(
          `本轮只支持稳定版发布，而 package.json 是预发布版本 ${JSON.stringify(pkgVersion)}。` +
            `（P5 的 /releases/latest 不含 prerelease，发了应用内也发现不了）`
        );
      }
    }
  } else if (isPrerelease(pkgVersion)) {
    warnings.push(`当前是预发布版本 ${pkgVersion} —— 带 --tag 校验时会拒绝发布`);
  }

  return { ok: errors.length === 0, version: pkgVersion, errors, warnings };
}

/* ---------- 静态版本源守卫 ----------
 *
 * 检查「构建 / 发布链路」里有没有人把版本号**写死**。
 * 那些地方必须从 package.json 派生 —— 写死一份就等于多了一个版本源，
 * 而它不会跟着 version:set 走。
 *
 * 刻意**不**扫 tests/ 与 docs/：测试 fixture 里的版本号是桩值
 * （见 tests/smoke.cjs 的说明，故意不联动），文档里的历史版本是叙述。
 */
const NO_HARDCODED_VERSION = [
  ['installer', '.nsi'],
  ['.github/workflows', '.yml'],
  ['scripts', '.mjs'],
  ['electron', '.cjs'],
];

/** 去掉注释再扫。
 *
 * **只看代码，不看注释。** 这条是本项目踩过的坑：结构性断言若扫原文，
 * 一句解释性的注释（例如「package.json 是 0.13.0、文件名却是 0.12.0」）
 * 就会把断言判成失败，而修法只能是「把注释写含糊」—— 反而降低可读性。
 *
 * 只剥**整行注释**与块注释，不做行内 `//` 切割：后者会把 `https://` 这类
 * 字符串从中间截断，可能把真正写死的版本号一起吃掉（假阴性比假阳性危险）。 */
export function stripComments(text, ext) {
  let t = String(text).replace(/\/\*[\s\S]*?\*\//g, '');
  if (ext === '.yml') t = t.replace(/^[ \t]*#.*$/gm, '');
  if (ext === '.nsi') t = t.replace(/^[ \t]*;.*$/gm, '');
  if (ext === '.mjs' || ext === '.cjs') t = t.replace(/^[ \t]*\/\/.*$/gm, '');
  return t;
}

/** 返回写死了 `version` 的文件列表（相对路径）。 */
export function findHardcodedVersions(version, root = ROOT) {
  const hits = [];
  for (const [dir, ext] of NO_HARDCODED_VERSION) {
    const base = path.join(root, dir);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      if (!name.endsWith(ext)) continue;
      const full = path.join(base, name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      // 自己不能算 —— 它读的是 package.json，不该出现字面量
      if (rel === 'scripts/check-version.mjs' || rel === 'scripts/set-version.mjs') continue;
      const code = stripComments(fs.readFileSync(full, 'utf8'), ext);
      if (code.includes(version)) hits.push(rel);
    }
  }
  return hits;
}

/* ---------- CLI ---------- */

function main() {
  const argv = process.argv.slice(2);
  const tag = argv.find((a) => a.startsWith('--tag='))?.slice('--tag='.length) ?? null;
  const sources = readVersionSources();
  const result = checkVersionConsistency({ ...sources, tag });

  console.log('');
  console.log('  版本一致性校验');
  console.log(`    package.json        ${sources.pkgVersion}`);
  console.log(`    package-lock.json   ${sources.lockVersion} / packages[""] ${sources.lockRootVersion}`);
  if (tag !== null) console.log(`    tag                 ${tag}`);

  for (const w of result.warnings) console.log(`  ! ${w}`);

  const hard = result.ok ? findHardcodedVersions(result.version) : [];
  if (hard.length) {
    result.errors.push(
      `这些构建 / 发布链路的文件里写死了版本号 ${result.version}，应该从 package.json 派生：${hard.join('、')}`
    );
    result.ok = false;
  }

  if (!result.ok) {
    console.log('');
    for (const e of result.errors) console.error(`  ✗ ${e}`);
    console.error('\n  版本一致性校验失败。修好再继续 —— 不要绕过这一步。\n');
    process.exit(1);
  }

  console.log('  ✓ 一致');
  console.log('');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
