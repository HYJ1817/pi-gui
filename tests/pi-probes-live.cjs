/* P23：**真实 pi** 的 probe 验收（opt-in，不进 `npm test`）。
 *
 * 与 `pi-probes.cjs` 的分工：
 *   - 那一套是 fixture 驱动，证明「给定这些形状，我们的判定对不对」；
 *   - 这一套跑在**这台机器上真的装着的那个 pi** 上，回答
 *     「这个版本的契约现在长什么样、我们核过没有」。
 *
 * 所以它**不会**断言「本机版本是某个值」——那种断言在别人机器上必红。
 * 它断言的是结构事实（每条 probe 都有结论、出处不含绝对路径），
 * 并把整张表打出来给升级的人看。
 *
 * 用法：
 *   node tests/pi-probes-live.cjs            # 打印报告，只在探测失败时非零退出
 *   node tests/pi-probes-live.cjs --strict   # 版本没被兼容矩阵核对过 → 退出码 1
 *
 * `--strict` 是升级流程里那一步「新版本必须人工核对」的机器可执行的落点：
 * **CI 绿不代表一个新版本被认证过**，这条命令会明确说不。
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const STRICT = process.argv.includes('--strict') || process.env.PI_GUI_LIVE_STRICT === '1';

(async () => {
  const { createPiLaunch } = await import('../server/pi-launch.js');
  const { createPiVersion, createPiVersionProbe } = await import('../server/pi-version.js');
  const { createPiProbes } = await import('../server/pi-probes.js');
  const matrix = await import('../server/pi-compat-matrix.js');

  const piBin = process.env.PI_BIN || 'pi';
  const launch = createPiLaunch({ piBin, env: process.env, getCwd: () => process.cwd() });
  const version = createPiVersion({
    resolvePackageDir: launch.packageDir,
    probeVersion: createPiVersionProbe({ launcher: launch.launcher }),
    identityKey: launch.identityKey,
    matrix,
  });
  const probes = createPiProbes({ resolvePackageDir: launch.packageDir, identityKey: launch.identityKey });

  const v = version.read();
  const report = probes.report();
  const summary = launch.summary();

  console.log('=== Pi capability probes（真实机器）===');
  console.log(`  pi 版本     : ${v.value || '(未知)'}`);
  console.log(`  版本来源    : ${v.source} · ${v.status} · ${v.updatedAt}`);
  console.log(`  版本核对    : ${v.verification}${v.verifiedAgainst ? `（基线 ${v.verifiedAgainst.version} · ${v.verifiedAgainst.verifiedAt}）` : ''}`);
  console.log(`  启动入口    : ${summary.source} · ${summary.binName} · 入口解析=${summary.entryKnown ? '是' : '否'} · 包目录绑定=${summary.packageDirKnown ? '是' : '否'}`);
  console.log(`  当前基线    : ${matrix.baselineSentence()}`);
  console.log(`  probe 概览  : 共 ${report.summary.total} · 支持 ${report.summary.supported} · 不支持 ${report.summary.unsupported} · 未知 ${report.summary.unknown}`);
  if (report.summary.unverified.length) {
    console.log(`  尚未下结论  : ${report.summary.unverified.join(', ')}`);
  }
  console.log('');
  for (const probe of report.probes) {
    const mark = probe.state === true ? '✓' : probe.state === false ? '✗' : '·';
    console.log(`  ${mark} ${probe.id.padEnd(28)} ${probe.evidence}`);
    if (probe.state === false) console.log(`      ↳ 降级：${probe.fallback}`);
  }
  console.log('');

  /* ---------- 结构断言（跨机器成立） ---------- */
  let passed = 0;
  const check = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };
  check('probe 表每条都有结论（是 / 否 / 未知），没有缺项', () => {
    assert.equal(report.probes.length, report.summary.total);
    for (const p of report.probes) {
      assert.ok(p.state === true || p.state === false || p.state === null, p.id);
      assert.ok(typeof p.evidence === 'string' && p.evidence.length > 0, p.id);
    }
  });
  check('证据里没有绝对路径（诊断与日志都可能被贴出去）', () => {
    const text = report.probes.map((p) => p.evidence).join('\n');
    assert.ok(!/[A-Za-z]:[\\/]/.test(text), '出现了 Windows 绝对路径');
    assert.ok(!text.includes('/home/') && !text.includes('/Users/'), '出现了 POSIX 绝对路径');
  });
  check('版本真值形状完整（value/source/status/updatedAt/verification）', () => {
    for (const key of ['value', 'source', 'status', 'updatedAt', 'verification']) {
      assert.ok(Object.hasOwn(v, key), key);
    }
    assert.ok(['verified', 'unverified', 'unknown', 'unchecked'].includes(v.verification));
  });

  if (summary.packageDirKnown) {
    check('包目录绑定成功 → 源码类 probe 都能下结论', () => {
      assert.equal(report.packageKnown, true);
      const sources = report.probes.filter((p) => p.kind === 'source');
      assert.ok(sources.some((p) => p.state !== null), '所有源码 probe 都读不到，包形状可能变了');
    });
  } else {
    console.log('  -- 包目录没能绑定：源码类 probe 保持未知（这是**合法**结果，不是失败）');
  }

  console.log(`\n${passed}/${passed} 通过`);

  /* ---------- 未核对版本：明确说不 ---------- */
  if (v.verification === 'unverified') {
    console.log('');
    console.log('⚠️  这个 pi 版本不在兼容矩阵里（' + (v.value || '未知') + '）。');
    console.log('    能力 probe 的结论仍然有效，但「这个版本的契约被核对过」这句话不成立。');
    console.log('    升级流程见 docs/upgrade-playbook.md —— 不要用 CI 绿来认证一个新版本。');
    if (STRICT) {
      console.log('    （--strict：以退出码 1 结束）');
      process.exit(1);
    }
  } else if (v.verification === 'unknown') {
    console.log('\n⚠️  读不到本机 pi 的版本 —— 无法判断它核对过没有（不猜）。');
    if (STRICT) process.exit(1);
  }

  process.exit(0);
})().catch((err) => {
  console.error('失败：' + (err && err.message ? err.message : err));
  process.exit(1);
});
