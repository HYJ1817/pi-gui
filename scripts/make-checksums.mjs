/* 生成 / 校验 SHA256SUMS.txt。
 *
 * 这份逻辑原先内联在 scripts/build-installer.mjs 里（只覆盖安装程序与便携版）。
 * 发版流程还需要对 `dist-release/` 再算一次，所以**抽出来共用** ——
 * 两份实现必然漂，而「校验和与文件对不上」是发版里最不该出现的错。
 *
 * 格式约定（与 GNU coreutils 的 `sha256sum` 输出一致，可直接
 * `sha256sum -c SHA256SUMS.txt` 验证）：
 *
 *     <64 位小写十六进制>␣␣<文件名>
 *
 * 两条硬要求：
 *   1. **只写文件名，不写路径** —— 绝不能出现 `C:\pi-GUI\dist-release\...`。
 *      校验和文件是给别人用的，带开发机的绝对路径既泄露环境又没法用。
 *   2. **排序稳定** —— 按文件名字节序升序。否则同样的产物每次生成的
 *      SHA256SUMS.txt 内容不同，diff 永远是脏的，也就没人会去核它。
 *
 * 用法：
 *   node scripts/make-checksums.mjs                      # 默认 dist-release/
 *   node scripts/make-checksums.mjs --dir=dist-installer
 *   node scripts/make-checksums.mjs --dir=X a.exe b.zip  # 只算指定的几个
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT } from './util.mjs';

export const CHECKSUM_FILE = 'SHA256SUMS.txt';

/** 一个文件的 SHA-256（小写十六进制）。 */
export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 列出目录里该参与校验和的文件：只算普通文件，排除校验和文件自己。 */
export function listChecksumTargets(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== CHECKSUM_FILE)
    .map((e) => e.name)
    .sort();
}

/** 纯函数：给定文件名列表，算出 SHA256SUMS.txt 的内容。 */
export function buildChecksums(dir, names) {
  const sorted = [...names].sort();
  const lines = [];
  for (const name of sorted) {
    // 只接受裸文件名 —— 传进来带路径说明调用方搞错了，早失败早好
    if (name !== path.basename(name)) throw new Error(`只接受裸文件名，收到：${name}`);
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) throw new Error(`文件不存在，无法算校验和：${full}`);
    const st = fs.statSync(full);
    if (!st.isFile()) throw new Error(`不是普通文件：${full}`);
    if (st.size === 0) throw new Error(`文件是空的，算校验和没有意义：${name}`);
    lines.push(`${sha256File(full)}  ${name}`);
  }
  return lines.join('\n') + '\n';
}

/** 解析 SHA256SUMS.txt 的内容 → [{ hash, name }]；格式不对时抛错。 */
export function parseChecksums(text) {
  const entries = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([0-9a-f]{64})\s{1,2}(.+)$/.exec(line);
    if (!m) throw new Error(`SHA256SUMS.txt 里有不认识的格式：${JSON.stringify(line)}`);
    entries.push({ hash: m[1], name: m[2].trim() });
  }
  return entries;
}

/**
 * 校验一个目录里的文件与 SHA256SUMS.txt 是否对得上。
 * @returns {{ok:boolean, errors:string[], entries:Array<{hash:string,name:string}>}}
 */
export function verifyChecksums(dir, text) {
  const errors = [];
  let entries;
  try {
    entries = parseChecksums(text);
  } catch (err) {
    return { ok: false, errors: [err.message], entries: [] };
  }

  if (!entries.length) errors.push('SHA256SUMS.txt 里一条都没有');

  for (const { hash, name } of entries) {
    if (name !== path.basename(name)) {
      errors.push(`条目里带了路径（只允许裸文件名）：${name}`);
      continue;
    }
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) {
      errors.push(`SHA256SUMS.txt 里列了 ${name}，但目录里没有这个文件`);
      continue;
    }
    const actual = sha256File(full);
    if (actual !== hash) errors.push(`${name} 的校验和对不上：文件是 ${actual}，记录是 ${hash}`);
  }

  // 反向：目录里的正式文件都必须在校验和文件里（防止「传了但没登记」）
  const listed = new Set(entries.map((e) => e.name));
  for (const name of listChecksumTargets(dir)) {
    if (!listed.has(name)) errors.push(`${name} 在目录里但不在 SHA256SUMS.txt 里`);
  }

  return { ok: errors.length === 0, errors, entries };
}

/** 写 SHA256SUMS.txt 并返回条目。 */
export function writeChecksums({ dir, names, outFile } = {}) {
  const targets = names && names.length ? names : listChecksumTargets(dir);
  const text = buildChecksums(dir, targets);
  const out = outFile || path.join(dir, CHECKSUM_FILE);
  fs.writeFileSync(out, text, 'utf8');
  return { outFile: out, entries: parseChecksums(text) };
}

/* ---------- CLI ---------- */

function main() {
  const argv = process.argv.slice(2);
  const dirArg = argv.find((a) => a.startsWith('--dir='))?.slice('--dir='.length);
  const outArg = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
  const dir = path.resolve(ROOT, dirArg || 'dist-release');
  const names = argv.filter((a) => !a.startsWith('--'));

  if (!fs.existsSync(dir)) {
    console.error(`\n  ✗ 目录不存在：${dir}\n`);
    process.exit(1);
  }

  let result;
  try {
    result = writeChecksums({ dir, names, outFile: outArg ? path.resolve(ROOT, outArg) : undefined });
  } catch (err) {
    console.error(`\n  ✗ ${err.message}\n`);
    process.exit(1);
  }

  console.log('');
  for (const e of result.entries) console.log(`  ${e.hash}  ${e.name}`);
  console.log('');
  console.log(`  → ${path.relative(ROOT, result.outFile)}（${result.entries.length} 条）`);
  console.log('');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
