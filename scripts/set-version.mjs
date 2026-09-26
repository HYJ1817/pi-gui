/* 改版本号 —— 发版流程的第一步。
 *
 * 用法：
 *   npm run version:set -- 0.13.0
 *   node scripts/set-version.mjs 0.13.0
 *
 * 只改**真正需要同步的版本源**：`package.json` 与 `package-lock.json`。
 * 其余都是派生的，不需要动：
 *   - Electron 的 package.json 由 scripts/build-app.mjs 构建时从 package.json 写
 *   - Diagnostics / 更新检查 / /api/health 用的是 server.js 的 VERSION
 *     （打包期由 esbuild `--define:__PI_GUI_VERSION__` 写死，开发期读 package.json）
 *   - 安装程序的版本经 `/DVERSION=` 传给 NSIS（installer/pi-gui.nsi 里
 *     `!ifndef VERSION → !error` 守着，没有静态副本）
 *   - 产物文件名（Pi-GUI-Setup-<v>.exe / Pi-GUI-<v>-portable.zip）由构建脚本拼
 *
 * 刻意**不动**：测试 fixture 里的桩版本号（tests/smoke.cjs 明确写了「故意不联动」）、
 * 文档里的历史版本与示例版本。scripts/check-version.mjs 会反过来扫一遍
 * 构建 / 发布链路，防止有人把版本号写死进 .nsi / workflow / scripts。
 *
 * ---------- 为什么是「按字段改写」而不是文本替换 ----------
 *
 * package-lock.json 里 `"version": "0.12.0"` **不止一处** —— 依赖
 * `node_modules/retry` 的版本恰好也是 0.12.0。用 `text.replace()` 会把那个依赖
 * 的版本一起改掉，而 npm ci 之后 lockfile 与 registry 对不上，
 * 报错完全指不到版本号上。所以只改两个明确的字段：
 *   - 顶层 `version`
 *   - `packages[""].version`（根包自己）
 *
 * 安全性由两个断言兜住：① 写完立刻用 check-version 复核；
 * ② 逐行比对，**任何一行不含 `"version"` 的改动都算失败**（防止顺手把整个
 * 文件重新格式化，那会让 git diff 变成几万行）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, isValidReleaseVersion, checkVersionConsistency, readVersionSources } from './check-version.mjs';

/** 逐行找出「除了 version 行之外」的差异。空数组 = 只动了版本号。 */
export function unexpectedDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length !== b.length) return ['行数变了'];
  const bad = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (!a[i].includes('"version"') || !b[i].includes('"version"')) bad.push(`第 ${i + 1} 行：${a[i].trim()} → ${b[i].trim()}`);
  }
  return bad;
}

/**
 * 把版本号同步到 package.json 与 package-lock.json。
 * @returns {{version:string, changed:Array<{file:string,from:string|null,to:string}>}}
 */
export function setVersion(version, root = ROOT) {
  const v = typeof version === 'string' ? version.trim() : '';
  if (!isValidReleaseVersion(v)) {
    throw new Error(
      `不是合法的发版版本号：${JSON.stringify(version)}\n` +
        '  要求三段 x.y.z（可选 -prerelease），例如 0.13.0 / 1.0.0 / 0.13.0-beta.1。\n' +
        '  不接受 v0.13（缺段 / 带前缀）、0.13.0.1（多段）、abc。'
    );
  }

  const files = [
    { file: 'package.json', set: (o) => { o.version = v; } },
    {
      file: 'package-lock.json',
      set: (o) => {
        o.version = v;
        if (o.packages && o.packages[''] && typeof o.packages[''] === 'object') o.packages[''].version = v;
      },
    },
  ];

  const changed = [];
  for (const { file, set } of files) {
    const full = path.join(root, file);
    const before = fs.readFileSync(full, 'utf8');
    const obj = JSON.parse(before);
    const from = typeof obj.version === 'string' ? obj.version : null;
    if (from === v && file === 'package.json') {
      // package.json 已经是目标版本，但 lock 可能没跟上 —— 继续处理（幂等）
    }
    set(obj);
    const after = JSON.stringify(obj, null, 2) + '\n';

    const bad = unexpectedDiff(before, after);
    if (bad.length) {
      throw new Error(`${file} 的改动不止版本号，已中止（不做任何写入）：\n  ` + bad.join('\n  '));
    }
    if (before !== after) {
      fs.writeFileSync(full, after, 'utf8');
      changed.push({ file, from, to: v });
    }
  }

  // 自校验：写完立刻复核，不一致就别让调用方以为成功了
  const check = checkVersionConsistency(readVersionSources(root));
  if (!check.ok) {
    throw new Error('写完自校验失败（这是脚本自身的 bug）：\n  ' + check.errors.join('\n  '));
  }

  return { version: v, changed };
}

function main() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!arg) {
    console.error('用法：node scripts/set-version.mjs <版本号>');
    console.error('例如：node scripts/set-version.mjs 0.13.0');
    process.exit(1);
  }

  let result;
  try {
    result = setVersion(arg);
  } catch (err) {
    console.error('\n  ✗ ' + err.message + '\n');
    process.exit(1);
  }

  console.log('');
  if (!result.changed.length) {
    console.log(`  package.json / package-lock.json 已经是 ${result.version}，无需改动`);
  } else {
    for (const c of result.changed) console.log(`  ${c.file}  ${c.from} → ${c.to}`);
  }
  console.log('');
  console.log(`  版本已同步到 ${result.version}`);
  console.log('  下一步：npm run release:check（跑完整发布预检）');
  console.log('');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
