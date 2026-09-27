/* 创建 / 复用 draft → 上传 → 核对 → 发布。
 *
 * ---------- 为什么从 release.yml 里挪出来 ----------
 *
 * 这几步真正容易错的是**分支**，不是命令本身：
 *   - tag 上已经有**已发布**的 Release → 必须拒绝（绝不覆盖已发布的二进制）
 *   - 只剩一个 draft（上次失败的残留）→ 复用它
 *   - 核对没过 → **绝不能** publish
 *   - publish 必须排在最后
 * 写在 YAML 里这些分支**没法单元测试** —— 只能靠真的打一个 tag 跑一次，
 * 而那会真的产生一个 Release。挪进这里之后，注入一个假的 gh 就能把分支表全测一遍
 * （见 tests/release-artifacts.cjs 的「发布编排」一节），YAML 里只剩一行调用。
 *
 * ---------- 为什么用 draft 兜上传 ----------
 *
 * 上传可能中途失败，而 GitHub 没有事务。draft 对用户不可见，
 * 上传 + 核对全过了才 publish —— 所以**不会出现「正式 Release 页面已经发布、
 * 但便携版没传成功」**。
 *
 * 用法：
 *   node scripts/publish-release.mjs --tag=v0.13.0              # 真发布
 *   node scripts/publish-release.mjs --tag=v0.13.0 --dry-run    # 做到「核对通过」就停，不发布
 *
 * ⚠️ `--dry-run` 也需要 tag 在远端**已存在**（`gh release create` 会按需创建 tag），
 * 所以它不是一个「零副作用的彩排」—— 它仍会在远端留下一个 draft。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './util.mjs';
import { expectedAssetNames } from './check-release-artifacts.mjs';
import { compareReleaseAssets, readLocalAssets, fetchRemoteAssets, makeGhRunner } from './verify-uploaded-release.mjs';

/** 追加到 Release 页面末尾的固定说明。
 *
 * 用 `<版本>` 占位而不是插真实版本号 —— 这样它永远不需要跟着发版改。
 * 放在代码里（而不是 YAML 的 heredoc 里）是为了能跟着脚本一起被版本控制与审阅。 */
export const ASSET_NOTES = `
---

## 交付物

| 文件 | 说明 |
| --- | --- |
| \`Pi-GUI-Setup-<版本>.exe\` | 安装程序（单用户，不弹 UAC）。装在 \`%LOCALAPPDATA%\\Programs\\Pi GUI\` |
| \`Pi-GUI-<版本>-portable.zip\` | 便携版，解压直接跑 \`Pi GUI.exe\`，不用装 |
| \`SHA256SUMS.txt\` | 上面两个文件的 SHA-256 校验和 |

下载后建议核一下（把 \`<版本>\` 换成实际版本号）：

\`\`\`powershell
certutil -hashfile Pi-GUI-Setup-<版本>.exe SHA256
\`\`\`

与 \`SHA256SUMS.txt\` 里的值逐位比对。

卸载只删程序文件 —— \`%APPDATA%\\Pi GUI\` 下的项目列表与窗口布局会保留。

## 前置条件

界面本身不含 pi。**本机要先装好 pi 并配好模型供应商**：

\`\`\`bash
npm i -g @earendil-works/pi-coding-agent   # 需要 Node >= 22.19.0
pi --version
\`\`\`

否则界面能打开，但发出去的消息会报错。
`;

/**
 * 纯函数：根据 tag 上现有 Release 的状态，决定该做什么。
 * @param state 'missing' | 'draft' | 'published'
 * @returns {{action:'create'|'reuse'|'refuse', reason:string}}
 */
export function planRelease({ state }) {
  switch (state) {
    case 'missing':
      return { action: 'create', reason: 'tag 上还没有 Release，创建 draft' };
    case 'draft':
      return { action: 'reuse', reason: '已存在 draft（上次失败的残留，对用户不可见），复用它继续上传' };
    case 'published':
      return {
        action: 'refuse',
        reason: '这个 tag 上已经有**已发布**的 Release —— 请人工处理，不要覆盖已发布的二进制',
      };
    default:
      throw new Error(`不认识的 Release 状态：${JSON.stringify(state)}`);
  }
}

/** 查 tag 上 Release 的状态。 */
export function releaseState(gh, tag) {
  let out;
  try {
    out = gh(['release', 'view', tag, '--json', 'isDraft', '-q', '.isDraft']);
  } catch (err) {
    /* 只把「确实不存在」当成 missing。
     * 网络 / 认证错误也当成 missing 的话，下一步会去 create，
     * 而在「其实已经有已发布 Release」时那一步会失败 —— 失败得晚且难懂。 */
    const msg = String((err && (err.stderr || err.message)) || '');
    if (/not found|HTTP 404/i.test(msg)) return 'missing';
    throw err;
  }
  return String(out).trim() === 'true' ? 'draft' : 'published';
}

/**
 * 跑完「创建/复用 draft → 上传 → 核对 → 追加说明 → 发布 → 发布后确认」。
 *
 * @param tag      形如 v0.13.0
 * @param dir      发布目录（dist-release）
 * @param gh       可注入的 gh 调用器 —— 测试传假的
 * @param dryRun   true 时做到「核对通过 + 追加说明」就停，**不 publish**
 * @returns {{steps:string[], state:string, published:boolean, url:string|null}}
 */
export function publishRelease({ tag, dir, gh = makeGhRunner(), dryRun = false, log = console.log } = {}) {
  if (!tag) throw new Error('必须给 tag');
  const steps = [];
  const version = tag.replace(/^v/, '');
  const expected = Object.values(expectedAssetNames(version));

  /* 先确认发布目录里有东西，**再去碰 GitHub**。
   * 顺序反过来的话，会在远端 create 一个永远没有附件的 draft ——
   * 一个纯粹的垃圾，还得人工去删。 */
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
  if (!files.length) throw new Error(`发布目录是空的：${dir}（先跑 npm run release:collect）`);

  const state = releaseState(gh, tag);
  const plan = planRelease({ state });
  log(`  tag ${tag} 上的状态：${state}`);
  log(`  → ${plan.action}：${plan.reason}`);
  if (plan.action === 'refuse') throw new Error(plan.reason);

  if (plan.action === 'create') {
    gh(['release', 'create', tag, '--draft', '--title', `Pi GUI ${tag}`, '--generate-notes']);
    steps.push('create-draft');
  } else {
    steps.push('reuse-draft');
  }

  /* 上传只针对发布目录里的文件（**不对整个项目 glob**）。 */
  gh(['release', 'upload', tag, ...files.map((f) => path.join(dir, f)), '--clobber']);
  steps.push('upload');
  log(`  上传 ${files.length} 个文件：${files.join('、')}`);

  /* 核对：GitHub 报的附件名 / 大小 / sha256 与本机逐项比。
   * **核对不过就直接抛** —— 此时还只是 draft，用户完全不知道它存在过。 */
  const local = readLocalAssets(dir);
  const remote = fetchRemoteAssets(tag, gh);
  const cmp = compareReleaseAssets({ local, remote: remote.assets });
  const errors = [...cmp.errors];
  if (remote.assets.length !== expected.length) {
    errors.push(`附件数量不对：期望 ${expected.length} 个（${expected.join('、')}），实际 ${remote.assets.length} 个`);
  }
  if (errors.length) {
    throw new Error(
      '上传后核对没通过 —— **不发布**（此时还只是 draft）：\n  ' + errors.join('\n  ')
    );
  }
  steps.push('verify');
  log(`  核对通过：${remote.assets.length} 个附件的大小与 sha256 都与本机一致`);

  /* 追加固定说明（保留 GitHub 自动生成的 notes）。 */
  const body = gh(['release', 'view', tag, '--json', 'body', '-q', '.body']);
  const tmp = path.join(os.tmpdir(), `pi-gui-release-notes-${process.pid}.md`);
  fs.writeFileSync(tmp, String(body) + ASSET_NOTES, 'utf8');
  try {
    gh(['release', 'edit', tag, '--notes-file', tmp]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  steps.push('append-notes');

  if (dryRun) {
    log('  --dry-run：停在这里，**没有发布**（远端留下一个 draft）');
    return { steps, state, published: false, url: remote.url };
  }

  /* 最后才发布。 */
  gh(['release', 'edit', tag, '--draft=false']);
  steps.push('publish');

  /* 发布之后再确认一次 —— 「publish 命令退出 0」同样不构成完整成功判据。 */
  const after = fetchRemoteAssets(tag, gh);
  if (after.isDraft) throw new Error('publish 之后仍然是 draft');
  if (after.assets.length !== expected.length) {
    throw new Error(`publish 之后附件数不是 ${expected.length}：${after.assets.length}`);
  }
  steps.push('confirm-published');

  return { steps, state, published: true, url: after.url };
}

/* ---------- CLI ---------- */

function main() {
  const argv = process.argv.slice(2);
  const tag = argv.find((a) => a.startsWith('--tag='))?.slice('--tag='.length);
  const dirArg = argv.find((a) => a.startsWith('--dir='))?.slice('--dir='.length);
  const dryRun = argv.includes('--dry-run');

  if (!tag) {
    /* ⚠️ 这里**不能写具体的版本号**。静态守卫（scripts/check-version.mjs 的
     * `findHardcodedVersions`）扫的就是「构建 / 发布链路里有没有把版本号写死」，
     * 而它只看代码、剥掉注释 —— 这一行是 `console.error` 的**字符串字面量**，
     * 剥不掉。写死一个版本号，等发到那一个版本时 `release:check` 会在第 1 步
     * 直接红（`✗ 构建 / 发布链路里写死了版本号 X.Y.Z`），而修法只能是改这一行。
     * 用 `<版本>` 占位就永远不用跟着发版改（与 docs/releasing.md §八 同一条规矩）。 */
    console.error('用法：node scripts/publish-release.mjs --tag=v<版本> [--dry-run]');
    process.exit(1);
  }

  console.log('');
  let r;
  try {
    r = publishRelease({ tag, dir: path.resolve(ROOT, dirArg || 'dist-release'), dryRun });
  } catch (err) {
    console.error(`\n  ✗ ${err.message}\n`);
    process.exit(1);
  }

  console.log('');
  console.log(`  步骤：${r.steps.join(' → ')}`);
  if (r.published) console.log(`  已发布：${r.url}`);
  console.log('');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
