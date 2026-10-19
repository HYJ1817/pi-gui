/* 发布预检 —— 一条命令跑完「打 tag 之前该做的事」。
 *
 * 存在的理由很朴素：发版流程原先散在文档里，是 8 条要照着敲的命令
 * （npm test → build:app → build:installer → 4 个 test:* → 手工核对产物）。
 * 靠记忆执行多步流程，迟早会漏一步，而漏掉的那一步恰好是「没验产物就上传」。
 *
 * 所以这里把顺序钉进代码，最后只回答一句话：**READY TO RELEASE** 还是不能发。
 *
 * 用法：
 *   npm run release:check                      # 全量：版本一致性 + 测试 + 构建 + 产物验证 + 守卫
 *   npm run release:check -- --with-installer  # 额外真装一遍安装程序（见下）
 *   npm run release:check -- --tag=v<版本> --ci-sha=<精确Commit> --with-installer
 *                                               # Release 专用：验证该 SHA 的完整 CI 后跳过重复测试
 *   npm run release:prepare                    # 跳过 npm test（迭代时用）
 *   node scripts/release-check.mjs --tag=v0.13.0
 *
 * 每一步都是**已有的入口**（npm test / npm run build:* / npm run test:*），
 * 不在这里重写构建逻辑 —— CI 与本机跑的是同一套，所以本机通过就意味着 CI 也该通过。
 *
 * ---------- --with-installer 为什么是显式开关 ----------
 *
 * `test:installer` 会**真的安装** Pi GUI（写注册表、建快捷方式），测完再卸掉。
 * 在一次性 runner 上这没问题；但开发机上可能装着一份**你自己在用的** Pi GUI，
 * 跑一遍就会把它卸掉。所以：
 *   - 默认**不跑**（本机安全）
 *   - CI 显式传 --with-installer（runner 是一次性虚拟机）
 *
 * 代价要说清楚：安装程序是「构建成功但一跑就废」的重灾区，而名字 / 大小 /
 * 校验和都**验不出**它坏在哪（实测踩到过：被 SIGTERM 掉的 makensis 留下一个
 * 48 MB 的半截 Setup.exe，而正常是 100 MB —— 除了真去运行它，没有任何静态
 * 检查能发现）。所以不带这个开关时，脚本会明确告诉你「安装程序没有被真正执行过」。
 */
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, readVersionSources, checkVersionConsistency, findHardcodedVersions } from './check-version.mjs';
import { readReleaseSummary } from './release-summary.mjs';
import { collectReleaseArtifacts, RELEASE_DIR } from './collect-release-artifacts.mjs';
import { checkReleaseDir } from './check-release-artifacts.mjs';
import { verifyChecksums } from './make-checksums.mjs';
import { createGitHubApi, verifyCheckoutCiProof } from './verify-ci-proof.mjs';

const argv = process.argv.slice(2);
let skipTests = argv.includes('--skip-tests');
const skipBuild = argv.includes('--skip-build');
const withInstaller = argv.includes('--with-installer');
const tag = argv.find((a) => a.startsWith('--tag='))?.slice('--tag='.length) ?? null;
const ciSha = argv.find((a) => a.startsWith('--ci-sha='))?.slice('--ci-sha='.length) ?? null;
const expectedSha = process.env.EXPECTED_SHA ?? null;
const repo = argv.find((a) => a.startsWith('--repo='))?.slice('--repo='.length)
  ?? process.env.GITHUB_REPOSITORY
  ?? null;

const APP_DIR = path.join(ROOT, 'dist-app', 'Pi GUI-win32-x64');

let stepNo = 0;
const t0 = Date.now();
const timings = [];

/* 子进程一律走 `shell: true` + 一条命令字符串。
 *
 * 不用 args 数组：Windows 上 npm 是 `npm.cmd`，直接 spawn 会 EINVAL；
 * 而 `{shell:true}` 配 args 数组在 Node 22+ 会刷 DEP0190 警告。
 * 这里拼进去的只有本文件里写死的字面量（没有外部输入），不存在注入面。
 * 这也是项目既有的做法（见 server/agents/cli.js 的说明）。 */
function runStep(label, command) {
  stepNo += 1;
  console.log(`\n[${stepNo}] ${label}`);
  console.log(`     $ ${command}`);
  const t = Date.now();
  execFileSync(command, { stdio: 'inherit', shell: true, cwd: ROOT });
  const secs = (Date.now() - t) / 1000;
  timings.push([label, secs]);
  console.log(`     （${secs.toFixed(0)}s）`);
}

function fail(msg, details = []) {
  console.log('');
  for (const d of details) console.error(`  ✗ ${d}`);
  console.error(`\n  NOT READY TO RELEASE：${msg}\n`);
  process.exit(1);
}

console.log('');
console.log('  ══════════════════════════════════════════════════');
console.log(
  '   Pi GUI 发布预检' +
    (ciSha ? '（精确 SHA CI 证明）' : skipTests ? '（--skip-tests）' : '') +
    (skipBuild ? '（--skip-build）' : '') +
    (withInstaller ? '（含安装程序真装验证）' : '')
);
console.log('  ══════════════════════════════════════════════════');

/* ---------- 1. 版本一致性 ---------- */
{
  stepNo += 1;
  console.log(`\n[${stepNo}] 版本一致性`);
  const sources = readVersionSources();
  const res = checkVersionConsistency({ ...sources, tag });
  console.log(`     package.json ${sources.pkgVersion} · lock ${sources.lockVersion} · packages[""] ${sources.lockRootVersion}`);
  if (tag) console.log(`     tag ${tag}`);
  for (const w of res.warnings) console.log(`  !  ${w}`);
  const hard = res.ok ? findHardcodedVersions(res.version) : [];
  const errors = [...res.errors];
  if (hard.length) errors.push(`构建 / 发布链路里写死了版本号 ${res.version}：${hard.join('、')}`);

  let summary = null;
  if (!errors.length) {
    try {
      summary = readReleaseSummary({ expectedVersion: res.version });
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (errors.length) fail('版本一致性校验没过', errors);
  console.log('     ✓ 一致');
  console.log(`     ✓ Release 摘要 ${path.relative(ROOT, summary.path).split(path.sep).join('/')}`);
}

/* ---------- 2. 精确 SHA 的完整 CI 证明 ----------
 *
 * Release 的 tag 只有在该 tag 指向的 commit 已经有一轮 main push CI 完成、
 * 且最终 CI gate 成功时，才允许跳过重复的 npm test。任何未完成、失败、
 * 无运行或身份不一致都会在这里阻断；API 错误也不会被当成“没有运行”。 */
if (ciSha) {
  stepNo += 1;
  console.log(`\n[${stepNo}] 精确 SHA CI 证明`);
  let api;
  try {
    api = createGitHubApi({ token: process.env.GITHUB_TOKEN });
  } catch (err) {
    fail('CI 证明不可用', [err.message]);
  }
  let head = '';
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim().toLowerCase();
  } catch {
    fail('无法读取当前 checkout 的 SHA');
  }
  if (!expectedSha) fail('缺少 workflow 事件 SHA', ['EXPECTED_SHA 未设置']);
  if (ciSha !== head) fail('调用参数中的 SHA 与当前 checkout 不一致', [`参数 ${ciSha}`, `HEAD ${head}`]);
  const proof = await verifyCheckoutCiProof({
    tag,
    checkoutSha: head,
    expectedEventSha: expectedSha,
    repo,
    api,
  });
  if (!proof.ok) fail('精确 SHA 的 CI 证明未通过', proof.errors);
  console.log(`     ✓ tag ${tag} → ${proof.tagCommitSha}`);
  console.log(`     ✓ GitHub CI run #${proof.run.id}：${proof.run.conclusion}`);
  console.log(`     ✓ ${proof.gate.id ? 'CI gate #' + proof.gate.id : 'CI gate'}：${proof.gate.conclusion}`);
  skipTests = true;
}

/* ---------- 全量测试（手动完整检查时） ---------- */
if (skipTests) {
  console.log(ciSha
    ? '\n[--] 跳过 npm test（精确 SHA 的完整 CI 与最终 gate 已通过）'
    : '\n[--] 跳过 npm test（--skip-tests）');
} else {
  runStep('全量测试（npm test）', 'npm test');
}

/* ---------- 3. 构建 ---------- */
if (skipBuild) {
  console.log('\n[--] 跳过构建（--skip-build），沿用已有的 dist-app / dist-installer');
} else {
  runStep('构建 Electron 应用', 'npm run build:app -- --rebuild');
}

/* ---------- 4. 打包产物验证（打包链路真的能跑） ----------
 *
 * test:app / test:exe 都要拿一个真 PDF 去验「打包后 PDF 抽取还能用」，
 * 所以先跑 fixtures。 */
if (skipBuild) {
  console.log('\n[--] 跳过打包产物验证（--skip-build）');
} else {
  runStep('生成测试固件', 'npm run fixtures');
  runStep('验证打包后的应用目录', 'npm run test:app');
  runStep('验证单文件 exe', 'npm run test:exe');
}

if (skipBuild) {
  console.log('\n[--] 跳过安装程序构建（--skip-build）');
} else {
  runStep('构建安装程序 + 便携版 + 校验和', 'npm run build:installer -- --zip');
}

if (skipBuild) {
  console.log('\n[--] 跳过便携版 / 安装程序验证（--skip-build）');
} else {
  runStep('验证便携版 zip（解压 → 跑 → 删）', 'npm run test:portable');
  if (withInstaller) {
    runStep('验证安装程序（真的装一遍再卸掉）', 'npm run test:installer');
  } else {
    console.log('\n[--] 跳过安装程序真装验证');
    console.log('     注意：安装程序**没有被真正执行过** —— 半截的 Setup.exe');
    console.log('     （名字 / 大小 / 校验和全都正常）只有真去装才会暴露。');
    console.log('     CI 上请传 --with-installer（runner 是一次性虚拟机）。');
  }
}

/* ---------- 5. 集中正式资产 ---------- */
{
  stepNo += 1;
  console.log(`\n[${stepNo}] 集中正式资产到 ${RELEASE_DIR}/`);
  let r;
  try {
    r = collectReleaseArtifacts({});
  } catch (err) {
    fail('收集发布资产失败', [err.message]);
  }
  for (const w of r.warnings) console.log(`  !  ${w}`);
  for (const name of r.copied) console.log(`     + ${name}`);
  console.log(`     + SHA256SUMS.txt（${r.checksums} 条）`);
}

/* ---------- 6. 产物守卫 ---------- */
{
  stepNo += 1;
  console.log(`\n[${stepNo}] 发布产物守卫`);
  const res = checkReleaseDir({
    dir: path.join(ROOT, RELEASE_DIR),
    appDir: fs.existsSync(APP_DIR) ? APP_DIR : null,
  });
  for (const a of res.assets) console.log(`     ✓ ${a.name}  ${(a.size / 1024 / 1024).toFixed(1)} MB  [${a.kind}]`);
  for (const w of res.warnings) console.log(`  !  ${w}`);
  if (!res.ok) fail('发布产物检查没过', res.errors);
}

/* ---------- 7. 独立复算一遍校验和 ----------
 *
 * 第 6 步的守卫已经验过一次，这里再独立算一遍的理由：守卫用的是
 * verifyChecksums()（比对记录与文件），而这一步模拟的是**用户拿到文件之后
 * 会做的事** —— 重新算 hash 再对。两者路径不同，同时通过才说明
 * 「校验和文件对第三方可用」，而不只是「自己跟自己对得上」。 */
{
  stepNo += 1;
  console.log(`\n[${stepNo}] 独立复算 SHA256`);
  const dir = path.join(ROOT, RELEASE_DIR);
  const text = fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8');
  const res = verifyChecksums(dir, text);
  if (!res.ok) fail('独立复算校验和失败', res.errors);
  for (const e of res.entries) console.log(`     ✓ ${e.name}`);
}

/* ---------- 结果 ---------- */
const total = (Date.now() - t0) / 1000;
console.log('');
console.log('  ──────────────────────────────────────────────────');
for (const [label, secs] of timings) console.log(`   ${secs.toFixed(0).padStart(4)}s  ${label}`);
console.log(`   ${total.toFixed(0).padStart(4)}s  合计`);
console.log('  ──────────────────────────────────────────────────');
console.log('');
if (withInstaller) {
  console.log('  READY TO RELEASE');
} else {
  /* 「可以发」有两种，必须区分开 —— 混成一句话就会有人按这句话发版，
   * 而实际上安装程序**从来没有被执行过**。
   *
   * 为什么不用静态检查去兜（比如按 app 目录大小设一个比例下限）：
   * 那是凭猜的魔法数字，一旦误判就会挡住一次本来正常的发布，
   * 而它想抓的那个场景（被中断的构建留下的半截 Setup.exe，
   * 名字/大小/校验和/魔数全都正常）在 CI 上本来就会被「步骤非零退出」拦住。
   * 所以这里选择**把话说清楚**，而不是加一个会误伤的判据。 */
  console.log('  READY TO RELEASE —— 但**安装程序没有被真正执行过**');
  console.log('');
  console.log('  ⚠️ 半截的 Setup.exe 在名字、大小、校验和、魔数上全都「正常」，');
  console.log('     只有真去装一遍才会暴露。要真装验证请重跑：');
  console.log('');
  console.log('       npm run release:check -- --with-installer');
  console.log('');
  console.log('     （CI 的 release.yml 强制带这个开关；本机默认不带，');
  console.log('      因为开发机上可能装着一份你在用的 Pi GUI。）');
}
console.log('');
console.log(`  正式资产在 ${RELEASE_DIR}/，下一步见 docs/releasing.md：`);
console.log(`    git commit -m "v${readVersionSources().pkgVersion}" && git push`);
console.log(`    git tag v${readVersionSources().pkgVersion} && git push origin v${readVersionSources().pkgVersion}`);
console.log('');
