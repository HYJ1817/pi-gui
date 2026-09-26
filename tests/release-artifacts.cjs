/* 发布产物守卫（P6）。
 *
 * 守的是「这批东西配得上叫正式 Release 吗」—— 构建成功但资产错的情况
 * 每一种都能静默发出去：版本号对不上（上次的产物没清）、少一个资产、
 * 混进调试文件、校验和与文件对不上、语义重复。
 *
 * 全部在 os.tmpdir() 的 fixture 上跑：**不碰 dist-release/**，也不需要真构建。
 * 用几 KB 的假文件就够了 —— 守卫看的是名字、存在性、大小与 hash，
 * 与文件内容是不是真的 Electron 应用无关。
 *
 * 最后一节额外钉住「P5 能识别正式资产名」：资产改名但没同步
 * server/update-check.js 的 classifyAsset()，Release 会发得很成功，
 * 而用户那边只有「查看 Release」、没有下载按钮 —— 这个失败在用户那边才暴露。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  const ok = typeof cond === 'function' ? cond() : cond;
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok ? '  → ' + ok : extra ? '  → ' + extra : ''));
  }
}

const V = '0.13.0';
const SETUP = `Pi-GUI-Setup-${V}.exe`;
const PORTABLE = `Pi-GUI-${V}-portable.zip`;
const SUMS = 'SHA256SUMS.txt';

(async () => {
  const { checkReleaseDir, expectedAssetNames, allowedReleaseFiles, staleVersionsInName } = await import(
    '../scripts/check-release-artifacts.mjs'
  );
  const { buildChecksums, verifyChecksums, parseChecksums, writeChecksums, listChecksumTargets, sha256File, CHECKSUM_FILE } =
    await import('../scripts/make-checksums.mjs');
  const { classifyAsset } = await import('../server/update-check.js');
  const { compareReleaseAssets } = await import('../scripts/verify-uploaded-release.mjs');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-rel-'));
  const dir = path.join(root, 'dist-release');
  const appDir = path.join(root, 'dist-app', 'Pi GUI-win32-x64');

  /* 魔数：fixture 必须造得像真的，否则守卫的魔数检查会把它们全判红。
   * （这正是本项目那条「fixture 要照真实形状造」的规矩 —— 两个方向都会出事：
   *   造得太假会把守卫的**正确行为**当成缺陷。） */
  const MZ = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64, 0x90)]);
  /* 结构上像个真 zip：本地文件头 + 中央目录结尾记录（EOCD）。
   * 守卫除了查开头 `PK\x03\x04`，还要查末尾的 EOCD —— 见下面那条回归用例。 */
  const PKZIP = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.alloc(26, 0),
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    Buffer.alloc(18, 0),
  ]);
  /* tar 归档的头几个字节就是文件名字段，offset 257 是 magic `ustar`。
   * **这是真的发出去过的形态**：build-installer 曾用 GNU tar 的 `-a -cf x.zip`
   * 打「便携版 zip」，而 GNU tar 不支持 zip，于是静默产出了 tar 改名件，
   * Windows 用户双击打不开。 */
  const FAKE_ZIP_TAR = (() => {
    const b = Buffer.alloc(1024, 0);
    b.write('Pi GUI-win32-x64/', 0, 'utf8');
    b.write('ustar', 257, 'utf8');
    return b;
  })();

  /** 造一个「看起来像正式发布目录」的 fixture。 */
  function makeRelease({
    setup = true,
    portable = true,
    sums = true,
    extra = {},
    setupBody = MZ,
    portableBody = PKZIP,
  } = {}) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    if (setup) fs.writeFileSync(path.join(dir, SETUP), setupBody);
    if (portable) fs.writeFileSync(path.join(dir, PORTABLE), portableBody);
    if (sums) {
      const names = [setup && SETUP, portable && PORTABLE].filter(Boolean);
      /* 空文件的用例要造得出来，而 buildChecksums 会主动拒绝空文件
       * （那是它的职责）—— 所以这里兜一层，写一份格式合法但内容无意义的记录。
       * 「空文件」这条断言关心的是守卫能不能发现空文件，不是校验和对不对。 */
      let text;
      try {
        text = buildChecksums(dir, names);
      } catch {
        text = names.map((n) => `${'0'.repeat(64)}  ${n}`).join('\n') + '\n';
      }
      fs.writeFileSync(path.join(dir, SUMS), text, 'utf8');
    }
    for (const [name, body] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), body);
    return dir;
  }

  /* ================= 1. 命名契约 ================= */
  console.log('\n--- 1. 资产命名契约 ---');

  check('6. installer 名正确', () => expectedAssetNames(V).installer === SETUP || expectedAssetNames(V).installer);
  check('7. portable 名正确', () => expectedAssetNames(V).portable === PORTABLE || expectedAssetNames(V).portable);
  check('8. checksum 名正确', () => expectedAssetNames(V).checksums === 'SHA256SUMS.txt' || expectedAssetNames(V).checksums);
  check('8b. 允许文件就是这三个（白名单，不是黑名单）', () => {
    const a = allowedReleaseFiles(V);
    return (a.length === 3 && a.includes(SETUP) && a.includes(PORTABLE) && a.includes(SUMS)) || JSON.stringify(a);
  });
  check('9. 文件名里的版本与期望一致时不算 stale', () => staleVersionsInName(SETUP, V).length === 0);
  check('10. 旧版本文件名会被认出来', () =>
    JSON.stringify(staleVersionsInName('Pi-GUI-Setup-0.12.0.exe', V)) === JSON.stringify(['0.12.0']) ||
    JSON.stringify(staleVersionsInName('Pi-GUI-Setup-0.12.0.exe', V)));

  /* ================= 2. 干净的一批 → 通过 ================= */
  console.log('\n--- 2. 正式资产齐全 ---');

  makeRelease();
  {
    const r = checkReleaseDir({ dir, version: V });
    check('11. 三个资产齐全 + 校验和正确 → 通过', () => r.ok === true || JSON.stringify(r.errors));
    check('11b. 报告里带每个资产的类型与大小', () =>
      r.assets.length === 3 && r.assets.every((a) => a.size > 0 && typeof a.kind === 'string') || JSON.stringify(r.assets));
  }

  /* ================= 3. 缺资产 / 空文件 ================= */
  console.log('\n--- 3. 缺失与空文件 ---');

  makeRelease({ portable: false, sums: false });
  {
    const r = checkReleaseDir({ dir, version: V });
    check('15. 缺便携版 → 失败', () => (!r.ok && r.errors.some((e) => /缺少正式资产（portable）/.test(e))) || JSON.stringify(r.errors));
  }

  makeRelease({ setup: false, portable: false, sums: false });
  {
    const r = checkReleaseDir({ dir, version: V });
    check('15b. 三个都缺 → 三条错误都报出来（不是只报第一条）', () =>
      (r.errors.filter((e) => /缺少正式资产/.test(e)).length === 3) || JSON.stringify(r.errors));
  }

  makeRelease({ setupBody: '' });
  {
    const r = checkReleaseDir({ dir, version: V });
    check('17. 空文件 → 失败', () => (!r.ok && r.errors.some((e) => /空文件/.test(e))) || JSON.stringify(r.errors));
  }

  /* 魔数：最便宜的一条完整性检查。挡的是「存在、非空、名字对，但内容不是那东西」：
   *   - 下载失败时把 HTML 错误页存成了 .exe
   *   - 被中断的构建留下的半截文件（实测踩到过） */
  console.log('\n--- 3b. 文件魔数 ---');

  makeRelease({ setupBody: '<!doctype html><title>404 Not Found</title>' });
  {
    const r = checkReleaseDir({ dir, version: V });
    check('17a. .exe 里其实是 HTML 错误页 → 失败', () =>
      (!r.ok && r.errors.some((e) => /不是有效文件/.test(e) && e.includes(SETUP))) || JSON.stringify(r.errors));
  }

  makeRelease({ portableBody: MZ });
  {
    const r = checkReleaseDir({ dir, version: V });
    check('17b. .zip 里其实是 PE 可执行文件 → 失败', () =>
      (!r.ok && r.errors.some((e) => /不是有效文件/.test(e) && e.includes(PORTABLE))) || JSON.stringify(r.errors));
  }

  makeRelease({ setupBody: Buffer.alloc(1, 0x00) });
  {
    const r = checkReleaseDir({ dir, version: V });
    check('17c. 截断成一个字节的 .exe → 失败', () => (!r.ok && r.errors.some((e) => /不是有效文件/.test(e))) || JSON.stringify(r.errors));
  }

  makeRelease();
  {
    const r = checkReleaseDir({ dir, version: V });
    check('17d. 魔数正确时不误报', () => r.ok === true || JSON.stringify(r.errors));
  }

  /* 回归守卫：**这个形态真的发出去过**。
   * build-installer 用 GNU tar 的 `-a -cf x.zip` 打「便携版 zip」，
   * 而 GNU tar 不支持 zip —— 不报错，静默产出 tar。Windows 用户双击打不开
   * （Expand-Archive：「找不到中央目录结尾记录」）。
   * 当时 test:portable 全绿，因为解压用的也是同一个 GNU tar（能读 tar）。 */
  makeRelease({ portableBody: FAKE_ZIP_TAR });
  {
    const r = checkReleaseDir({ dir, version: V });
    check('17e. tar 改名成 .zip → 失败（曾真的发布出去过的缺陷）', () =>
      (!r.ok && r.errors.some((e) => /不是有效文件/.test(e) && e.includes(PORTABLE))) || JSON.stringify(r.errors));
  }

  /* 只有 PK 开头、没有 EOCD 的「zip」也要拦 —— 它同样解不开。 */
  makeRelease({ portableBody: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 0)]) });
  {
    const r = checkReleaseDir({ dir, version: V });
    check('17f. 有 PK 开头但没有 EOCD → 失败（半截 / 伪造的 zip）', () =>
      (!r.ok && r.errors.some((e) => /EOCD|中央目录/.test(e))) || JSON.stringify(r.errors));
  }

  makeRelease();
  {
    const r = checkReleaseDir({ dir, version: V });
    check('17g. 结构完整的 zip 不误报', () => r.ok === true || JSON.stringify(r.errors));
  }

  {
    const r = checkReleaseDir({ dir: path.join(root, 'nope'), version: V });
    check('15c. 目录不存在 → 失败（不是崩）', () => (!r.ok && r.errors.some((e) => /目录不存在/.test(e))) || JSON.stringify(r.errors));
  }

  /* ================= 4. 混进不该有的文件 ================= */
  console.log('\n--- 4. 不该出现的文件 ---');

  for (const [name, why] of [
    ['fake-pi.cjs', '测试用的假 pi'],
    ['test-fixtures.zip', '测试固件'],
    ['debug.log', '日志'],
    ['.env', '环境变量文件'],
    ['app.pdb', '调试符号'],
    ['setup.exe', '不在白名单'],
  ]) {
    makeRelease({ extra: { [name]: 'x' } });
    const r = checkReleaseDir({ dir, version: V });
    check(`18. 混进 ${name} → 失败`, () => (!r.ok && r.errors.some((e) => e.includes(name))) || JSON.stringify(r.errors));
  }

  check('16. 只允许三个正式资产（白名单语义，不是列举几个黑名单）', () => {
    makeRelease({ extra: { 'whatever-unknown.bin': 'x' } });
    const r = checkReleaseDir({ dir, version: V });
    return (!r.ok && r.errors.some((e) => e.includes('whatever-unknown.bin'))) || JSON.stringify(r.errors);
  });

  /* ================= 5. 版本混入 ================= */
  console.log('\n--- 5. 旧版本混入 ---');

  makeRelease({ extra: { 'Pi-GUI-Setup-0.12.0.exe': 'old' } });
  {
    const r = checkReleaseDir({ dir, version: V });
    check('10a. 上次版本的安装包混进来 → 失败（且同时报「不该出现」与「版本不符」）', () =>
      (!r.ok &&
        r.errors.some((e) => /Pi-GUI-Setup-0\.12\.0\.exe/.test(e) && /版本与 package\.json/.test(e))) ||
      JSON.stringify(r.errors));
  }

  /* ================= 6. 校验和 ================= */
  console.log('\n--- 6. 校验和 ---');

  makeRelease();
  check('11c. 校验和与文件一致 → verifyChecksums 通过', () => {
    const text = fs.readFileSync(path.join(dir, SUMS), 'utf8');
    const r = verifyChecksums(dir, text);
    return r.ok === true || JSON.stringify(r.errors);
  });
  check('11d. 校验和文件里只有裸文件名，没有绝对路径', () => {
    const text = fs.readFileSync(path.join(dir, SUMS), 'utf8');
    return (!/[A-Za-z]:[\\/]/.test(text) && !text.includes(root)) || text.slice(0, 120);
  });
  check('14. 排序稳定：同样的文件集每次生成的内容完全一样', () => {
    const a = buildChecksums(dir, [SETUP, PORTABLE]);
    const b = buildChecksums(dir, [PORTABLE, SETUP]);
    return a === b || '两次生成的顺序不同';
  });
  check('14b. 排序是按文件名字节序（`0` < `S`，所以 portable 在 Setup 之前）', () => {
    const lines = parseChecksums(fs.readFileSync(path.join(dir, SUMS), 'utf8'));
    return JSON.stringify(lines.map((l) => l.name)) === JSON.stringify([PORTABLE, SETUP]) || JSON.stringify(lines.map((l) => l.name));
  });
  check('14c. hash 是 64 位小写十六进制', () => parseChecksums(fs.readFileSync(path.join(dir, SUMS), 'utf8')).every((e) => /^[0-9a-f]{64}$/.test(e.hash)));

  check('12. 文件被改过之后校验和校验失败', () => {
    fs.writeFileSync(path.join(dir, SETUP), 'tampered!');
    const r = checkReleaseDir({ dir, version: V });
    return (!r.ok && r.errors.some((e) => /校验和对不上/.test(e))) || JSON.stringify(r.errors);
  });

  check('12b. 篡改后独立复算也能发现（verifyChecksums 直接对文件）', () => {
    const text = fs.readFileSync(path.join(dir, SUMS), 'utf8');
    const r = verifyChecksums(dir, text);
    return r.ok === false || '篡改没被发现';
  });

  makeRelease({ sums: false });
  {
    const r = checkReleaseDir({ dir, version: V });
    check('15d. 缺 SHA256SUMS.txt → 失败', () => (!r.ok && r.errors.some((e) => /缺少正式资产（checksums）/.test(e))) || JSON.stringify(r.errors));
  }

  makeRelease();
  {
    fs.writeFileSync(path.join(dir, SUMS), `${'a'.repeat(64)}  ${SETUP}\n`, 'utf8');
    const r = checkReleaseDir({ dir, version: V });
    check('12c. 校验和内容错 → 失败', () => (!r.ok && r.errors.some((e) => /校验和/.test(e))) || JSON.stringify(r.errors));
    check('15e. 校验和没覆盖便携版 → 失败（防止「传了但没登记」）', () =>
      (!r.ok && r.errors.some((e) => new RegExp(`${PORTABLE} 在目录里但不在`).test(e))) || JSON.stringify(r.errors));
  }

  {
    makeRelease();
    fs.writeFileSync(path.join(dir, SUMS), `not-a-hash  ${SETUP}\n`, 'utf8');
    const r = checkReleaseDir({ dir, version: V });
    check('12d. 校验和格式不合法 → 失败（不静默跳过）', () => (!r.ok && r.errors.some((e) => /不认识的格式/.test(e))) || JSON.stringify(r.errors));
  }

  {
    makeRelease();
    fs.writeFileSync(path.join(dir, SUMS), `${'a'.repeat(64)}  C:\\pi-GUI\\dist-release\\${SETUP}\n`, 'utf8');
    const r = checkReleaseDir({ dir, version: V });
    check('13. 校验和里带绝对路径 → 失败', () => (!r.ok && r.errors.some((e) => /出现了路径/.test(e))) || JSON.stringify(r.errors));
  }

  check('14d. 校验和文件自己不进清单（不会自指）', () => {
    makeRelease();
    const targets = listChecksumTargets(dir);
    return (!targets.includes(CHECKSUM_FILE) && targets.length === 2) || JSON.stringify(targets);
  });
  check('14e. writeChecksums 默认排除校验和文件自身', () => {
    const { entries } = writeChecksums({ dir });
    return entries.length === 2 || JSON.stringify(entries.map((e) => e.name));
  });

  /* ================= 7. 语义重复 ================= */
  console.log('\n--- 7. 语义重复 ---');

  makeRelease({ extra: { [`Pi-GUI-Setup-${V}-2.exe`]: 'another installer' } });
  {
    const r = checkReleaseDir({ dir, version: V });
    check('19. 两个文件都被识别成 installer → 失败（用户不知道该点哪个）', () =>
      (!r.ok && r.errors.some((e) => /都会被识别成「installer」/.test(e))) || JSON.stringify(r.errors));
  }

  /* ================= 8. 构建 metadata ================= */
  console.log('\n--- 8. 构建 metadata 版本 ---');

  function makeApp(version) {
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(appDir, 'resources', 'app'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'resources', 'app', 'package.json'), JSON.stringify({ name: 'pi-gui', version }, null, 2));
  }

  makeRelease();
  makeApp(V);
  check('20. 构建 metadata 版本一致 → 通过', () => {
    const r = checkReleaseDir({ dir, version: V, appDir });
    return r.ok === true || JSON.stringify(r.errors);
  });

  makeApp('0.12.0');
  check('20b. 构建 metadata 是旧版本 → 失败（产物是旧版本打的）', () => {
    const r = checkReleaseDir({ dir, version: V, appDir });
    return (!r.ok && r.errors.some((e) => /构建 metadata 的版本/.test(e))) || JSON.stringify(r.errors);
  });

  fs.rmSync(appDir, { recursive: true, force: true });
  check('20c. 没有构建 metadata 时只警告、不失败（单独跑守卫的场景）', () => {
    const r = checkReleaseDir({ dir, version: V, appDir });
    return (r.ok === true && r.warnings.length === 1) || JSON.stringify([r.ok, r.warnings]);
  });

  /* ================= 9. P5 兼容 ================= */
  console.log('\n--- 9. P5 兼容（资产必须被应用内更新面板认出来）---');

  check('21. 正式安装包被 classifyAsset 识别成 installer', () => classifyAsset(SETUP) === 'installer' || classifyAsset(SETUP));
  check('22. 正式便携版被识别成 portable', () => classifyAsset(PORTABLE) === 'portable' || classifyAsset(PORTABLE));
  check('23. SHA256SUMS.txt 被识别成 checksums', () => classifyAsset(SUMS) === 'checksums' || classifyAsset(SUMS));
  check('23b. 命名契约与 classifyAsset 一致（改名字会同时打红这两边）', () => {
    const n = expectedAssetNames(V);
    return (
      classifyAsset(n.installer) === 'installer' &&
      classifyAsset(n.portable) === 'portable' &&
      classifyAsset(n.checksums) === 'checksums' ||
      '命名契约与 classifyAsset 漂了'
    );
  });
  check('23c. 干净的一批资产全部能被 P5 识别（不会出现「只有查看 Release」）', () => {
    makeRelease();
    const r = checkReleaseDir({ dir, version: V });
    const kinds = r.assets.map((a) => a.kind).sort();
    return JSON.stringify(kinds) === JSON.stringify(['checksums', 'installer', 'portable']) || JSON.stringify(kinds);
  });

  /* ================= 10. 上传后的核对（§25） =================
   *
   * 「上传命令退出码是 0」不等于「Release 上有三个正确的文件」。
   * 这一段验的是纯比对逻辑（不碰网络）。 */
  console.log('\n--- 10. 上传后核对 ---');

  const localAssets = [
    { name: SETUP, size: 105020429, hash: 'a'.repeat(64) },
    { name: PORTABLE, size: 342487040, hash: 'b'.repeat(64) },
  ];
  const remoteFrom = (list) => list.map((l) => ({ name: l.name, size: l.size, digest: `sha256:${l.hash}` }));

  check('24. 本地与远端一致 → 通过', () => {
    const r = compareReleaseAssets({ local: localAssets, remote: remoteFrom(localAssets) });
    return r.ok === true || JSON.stringify(r.errors);
  });

  check('24a. 少传一个附件 → 失败', () => {
    const r = compareReleaseAssets({ local: localAssets, remote: remoteFrom([localAssets[0]]) });
    return (!r.ok && r.errors.some((e) => e.includes(PORTABLE) && /没有这个附件/.test(e))) || JSON.stringify(r.errors);
  });

  check('24b. 远端多了一个不该有的附件 → 失败', () => {
    const r = compareReleaseAssets({
      local: localAssets,
      remote: [...remoteFrom(localAssets), { name: 'extra.bin', size: 1, digest: `sha256:${'c'.repeat(64)}` }],
    });
    return (!r.ok && r.errors.some((e) => /多了一个不该有的附件/.test(e))) || JSON.stringify(r.errors);
  });

  check('24c. 内容与本地不一致（digest 不同）→ 失败', () => {
    const remote = remoteFrom(localAssets);
    remote[0] = { ...remote[0], digest: `sha256:${'d'.repeat(64)}` };
    const r = compareReleaseAssets({ local: localAssets, remote });
    return (!r.ok && r.errors.some((e) => /内容与本地不一致/.test(e))) || JSON.stringify(r.errors);
  });

  check('24d. 大小对不上 → 失败', () => {
    const remote = remoteFrom(localAssets);
    remote[1] = { ...remote[1], size: 123 };
    const r = compareReleaseAssets({ local: localAssets, remote });
    return (!r.ok && r.errors.some((e) => /大小对不上/.test(e))) || JSON.stringify(r.errors);
  });

  check('24e. 远端没给 digest → 失败（「核对不了」不等于「核对通过」）', () => {
    const remote = remoteFrom(localAssets).map((a) => ({ ...a, digest: null }));
    const r = compareReleaseAssets({ local: localAssets, remote });
    return (!r.ok && r.errors.some((e) => /无法核对内容/.test(e))) || JSON.stringify(r.errors);
  });

  check('24f. 一个附件都没有 → 失败', () => {
    const r = compareReleaseAssets({ local: localAssets, remote: [] });
    return r.ok === false && r.errors.length >= 2 || JSON.stringify(r.errors);
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});