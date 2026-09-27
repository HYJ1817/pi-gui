/* 上传之后的核对 —— 不能只看 `gh release upload` 的退出码。
 *
 * 为什么需要这一步：`gh release upload` 成功只说明「这条命令跑完了」，
 * 不说明「Release 上现在有三个正确的文件」。真实的失败形态有：
 *   - 上传了一部分就断了（网络 / 限流）
 *   - 传上去的文件与本地不是同一份（中间被替换过）
 *   - 少传了校验和，或者校验和没更新
 * 而 Release 页面看起来一切正常 —— 用户下载到的东西是错的，页面不会告诉你。
 *
 * 所以这里做**双向核对**：本地算一遍，GitHub 报一遍，逐项比。
 * GitHub 的 assets API 会给出每个附件的 `size` 与 `digest`（`sha256:<hex>`），
 * 后者是 GitHub 自己对收到的字节算的 —— 与我们本地的 hash 一致，
 * 才说明「用户下载到的就是本地验证过的那份」。
 *
 * 用法（需要 gh 已认证，或设了 GH_TOKEN）：
 *   node scripts/verify-uploaded-release.mjs --tag=v0.13.0
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, readVersionSources } from './check-version.mjs';
import { sha256File, parseChecksums } from './make-checksums.mjs';
import { expectedAssetNames } from './check-release-artifacts.mjs';

/**
 * 纯函数：比对本地资产与 GitHub 上报告的资产。
 * @param local  [{ name, size, hash }]
 * @param remote [{ name, size, digest }]   digest 形如 `sha256:<hex>`，可能为 null
 * @returns {{ok:boolean, errors:string[]}}
 */
export function compareReleaseAssets({ local, remote } = {}) {
  const errors = [];
  const L = new Map((local || []).map((a) => [a.name, a]));
  const R = new Map((remote || []).map((a) => [a.name, a]));

  for (const name of L.keys()) {
    if (!R.has(name)) errors.push(`GitHub 上没有这个附件：${name}`);
  }
  for (const name of R.keys()) {
    if (!L.has(name)) errors.push(`GitHub 上多了一个不该有的附件：${name}`);
  }

  for (const [name, l] of L) {
    const r = R.get(name);
    if (!r) continue;
    if (r.size !== l.size) {
      errors.push(`${name} 的大小对不上：GitHub 报 ${r.size}，本地是 ${l.size}`);
    }
    if (!r.digest) {
      /* 不静默跳过 —— 「核对不了」和「核对通过」是两件事。 */
      errors.push(`${name} 没有返回摘要，无法核对内容是否与本地一致`);
      continue;
    }
    const want = `sha256:${l.hash}`;
    if (r.digest !== want) {
      errors.push(`${name} 的内容与本地不一致：GitHub ${r.digest}，本地 ${want}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** 把本地 dist-release 的资产读成 [{name,size,hash}]。
 *
 * ⚠️ **目录里的每个文件，不只是 SHA256SUMS.txt 里列的那几个。**
 *
 * 这一点踩过：早先只读 SUMS 里列的两个二进制，而 GitHub 报的是上传的三个
 * （含 `SHA256SUMS.txt` 自己）—— 于是比对必然报「GitHub 上多了一个不该有的附件」，
 * 也就是**这个脚本在每一次真实发布上都会失败**。
 *
 * 发现它的是单元测试：把假 gh 造得跟真实 GitHub 一样（返回三个）就立刻红了。
 * 又一次印证那条规矩 —— **fixture 要照真实形状造**，造得太随意会把
 * 「真实世界必然失败」的路径测成绿的。
 *
 * 「SUMS 是否覆盖了所有正式资产」是另一个问题，由 check-release-artifacts.mjs
 * 的 verifyChecksums() 负责（那里有反向覆盖断言）。这里只做「本地有什么 / 远端有什么」。 */
export function readLocalAssets(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort()
    .map((name) => ({
      name,
      size: fs.statSync(path.join(dir, name)).size,
      hash: sha256File(path.join(dir, name)),
    }));
}

/** 默认的 gh 调用器：把 gh 的 stdout 当字符串返回，失败时抛错。
 *
 * 抽成可注入的一层，是为了让 `scripts/publish-release.mjs` 的分支逻辑
 * （已发布必须拒绝 / 只剩 draft 才复用 / 核对不过绝不 publish）能**被单元测试**——
 * 那些分支写在 YAML 里就只能靠真的打一个 tag 去试，而试就会真的产生 Release。 */
export function makeGhRunner() {
  return (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 用 gh 取远端 Release 的资产。 */
export function fetchRemoteAssets(tag, gh = makeGhRunner()) {
  const json = JSON.parse(gh(['release', 'view', tag, '--json', 'assets,isDraft,url']));
  return {
    isDraft: Boolean(json.isDraft),
    url: json.url || null,
    assets: (json.assets || []).map((a) => ({ name: a.name, size: a.size, digest: a.digest || null })),
  };
}

/* ---------- CLI ---------- */

function main() {
  const argv = process.argv.slice(2);
  const tag = argv.find((a) => a.startsWith('--tag='))?.slice('--tag='.length) || `v${readVersionSources().pkgVersion}`;
  const dirArg = argv.find((a) => a.startsWith('--dir='))?.slice('--dir='.length);
  const dir = path.resolve(ROOT, dirArg || 'dist-release');

  const version = tag.replace(/^v/, '');
  const expected = Object.values(expectedAssetNames(version));

  let remote;
  try {
    remote = fetchRemoteAssets(tag);
  } catch (err) {
    console.error(`\n  ✗ 读不到 GitHub 上的 Release ${tag}：${err.message}\n`);
    process.exit(1);
  }

  const local = readLocalAssets(dir);
  const res = compareReleaseAssets({ local, remote: remote.assets });

  console.log('');
  console.log(`  Release ${tag}${remote.isDraft ? '（draft）' : ''}  ${remote.url || ''}`);
  for (const a of remote.assets) {
    const ok = local.find((l) => l.name === a.name && l.hash === (a.digest || '').replace(/^sha256:/, ''));
    console.log(`    ${ok ? '✓' : '✗'} ${a.name}  ${(a.size / 1024 / 1024).toFixed(1)} MB`);
  }

  /* 数量也要对 —— 这是「资产不完整」最直接的判据（§25）。 */
  if (remote.assets.length !== expected.length) {
    res.errors.push(`附件数量不对：期望 ${expected.length} 个（${expected.join('、')}），实际 ${remote.assets.length} 个`);
    res.ok = false;
  }

  if (!res.ok) {
    console.log('');
    for (const e of res.errors) console.error(`  ✗ ${e}`);
    console.error('\n  上传后的核对没通过 —— 不要把它当成发布成功。\n');
    process.exit(1);
  }

  console.log('');
  console.log(`  ✓ ${remote.assets.length} 个附件齐全，大小与 sha256 都与本地一致`);
  console.log('');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
