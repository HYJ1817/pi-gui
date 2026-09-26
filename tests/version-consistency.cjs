/* 版本一致性（P6）。
 *
 * 这一段守的是**发版流程里代价最高的一类错误**：三处版本号各自都「正常」，
 * 拼起来才是错的（package.json 0.13.0 / tag v0.12.0 / 文件名 0.13.0）。
 * 而 GitHub Release 一旦发出去，用户装到的版本与页面宣称的版本对不上，
 * 且看起来一切正常。
 *
 * 全部在 os.tmpdir() 的 fixture 上跑 —— **不碰仓库真实的 package.json**。
 * 唯一读真实文件的是最后那条「当前仓库自检」，它只读不写。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

const ROOT = path.resolve(__dirname, '..');

(async () => {
  const { isValidReleaseVersion, isPrerelease, checkVersionConsistency, findHardcodedVersions, readVersionSources } =
    await import('../scripts/check-version.mjs');
  const { setVersion, unexpectedDiff } = await import('../scripts/set-version.mjs');

  /* ================= 1. SemVer 合法性 ================= */
  console.log('\n--- 1. 版本号合法性 ---');

  check('1a. 三段版本合法', () =>
    ['0.13.0', '1.0.0', '0.0.1', '10.20.30'].every(isValidReleaseVersion) || '有三段版本被判非法');
  check('1b. 预发布版本合法（set-version 允许，发布时再拦）', () =>
    ['0.13.0-beta.1', '1.0.0-rc.1', '0.13.0-alpha.beta.1'].every(isValidReleaseVersion) || '预发布被判非法');
  check('1c. build metadata 合法', () => isValidReleaseVersion('0.13.0+build.5') === true);
  check('1d. 非法版本一律拒绝', () => {
    const bad = ['abc', 'v0.13', '0.13', '0.13.0.1', 'v0.13.0', '', '  ', '0.13.0-', '1.0.0-', '-1.0.0', null, undefined, 42];
    const leaked = bad.filter((v) => isValidReleaseVersion(v));
    return leaked.length === 0 || '被放行：' + JSON.stringify(leaked);
  });
  check('1e. isPrerelease 只对预发布为真', () =>
    isPrerelease('0.13.0-beta.1') === true && isPrerelease('0.13.0') === false && isPrerelease('nope') === false);

  /* ================= 2. package / lock / tag 一致性 ================= */
  console.log('\n--- 2. package / lock / tag 一致性 ---');

  check('2. 三处一致 → 通过', () => {
    const r = checkVersionConsistency({ pkgVersion: '0.13.0', lockVersion: '0.13.0', lockRootVersion: '0.13.0' });
    return r.ok === true || JSON.stringify(r.errors);
  });

  check('2b. lock 顶层与 package 不一致 → 失败', () => {
    const r = checkVersionConsistency({ pkgVersion: '0.13.0', lockVersion: '0.12.0', lockRootVersion: '0.13.0' });
    return (!r.ok && r.errors.some((e) => /package-lock\.json 顶层/.test(e))) || JSON.stringify(r);
  });

  check('2c. lock 的 packages[""] 与 package 不一致 → 失败（只改一处最常见的形态）', () => {
    const r = checkVersionConsistency({ pkgVersion: '0.13.0', lockVersion: '0.13.0', lockRootVersion: '0.12.0' });
    return (!r.ok && r.errors.some((e) => /packages\[""\]/.test(e))) || JSON.stringify(r);
  });

  check('3. tag === v<version> → 通过', () => {
    const r = checkVersionConsistency({ pkgVersion: '0.13.0', lockVersion: '0.13.0', lockRootVersion: '0.13.0', tag: 'v0.13.0' });
    return r.ok === true || JSON.stringify(r.errors);
  });

  check('4. tag 与 package 不一致 → 失败，且说明期望值', () => {
    const r = checkVersionConsistency({ pkgVersion: '0.13.0', lockVersion: '0.13.0', lockRootVersion: '0.13.0', tag: 'v0.12.0' });
    return (!r.ok && r.errors.some((e) => /tag 与 package\.json 的版本不匹配/.test(e) && e.includes('v0.13.0'))) || JSON.stringify(r);
  });

  check('4b. tag 少了 v 前缀 → 失败', () => {
    const r = checkVersionConsistency({ pkgVersion: '0.13.0', lockVersion: '0.13.0', lockRootVersion: '0.13.0', tag: '0.13.0' });
    return (!r.ok && r.errors.some((e) => /tag 与 package/.test(e))) || JSON.stringify(r);
  });

  check('4c. tag 大小写不同（V0.13.0）→ 失败（不做规范化猜测）', () => {
    const r = checkVersionConsistency({ pkgVersion: '0.13.0', lockVersion: '0.13.0', lockRootVersion: '0.13.0', tag: 'V0.13.0' });
    return (!r.ok && r.errors.some((e) => /tag 与 package/.test(e))) || JSON.stringify(r);
  });

  check('5. package.json 版本本身非法 → 失败', () => {
    const r = checkVersionConsistency({ pkgVersion: 'abc', lockVersion: 'abc', lockRootVersion: 'abc' });
    return (!r.ok && r.errors.some((e) => /不是合法的发版版本号/.test(e))) || JSON.stringify(r);
  });

  check('5b. 预发布 + tag → 失败（本轮只支持稳定版发布）', () => {
    const r = checkVersionConsistency({
      pkgVersion: '0.13.0-beta.1',
      lockVersion: '0.13.0-beta.1',
      lockRootVersion: '0.13.0-beta.1',
      tag: 'v0.13.0-beta.1',
    });
    return (!r.ok && r.errors.some((e) => /只支持稳定版发布/.test(e))) || JSON.stringify(r);
  });

  check('5c. 预发布但**不带 tag** 只警告、不失败（本地迭代不该被挡住）', () => {
    const r = checkVersionConsistency({ pkgVersion: '0.13.0-beta.1', lockVersion: '0.13.0-beta.1', lockRootVersion: '0.13.0-beta.1' });
    return (r.ok === true && r.warnings.length === 1) || JSON.stringify([r.ok, r.warnings]);
  });

  /* ================= 3. set-version 的写入行为 ================= */
  console.log('\n--- 3. set-version（fixture，不碰真实 package.json） ---');

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-ver-'));
  const write = (version) => {
    fs.writeFileSync(
      path.join(fixture, 'package.json'),
      JSON.stringify({ name: 'pi-gui', version, license: 'MIT', scripts: { test: 'x' } }, null, 2) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(fixture, 'package-lock.json'),
      JSON.stringify(
        {
          name: 'pi-gui',
          version,
          lockfileVersion: 3,
          requires: true,
          packages: { '': { name: 'pi-gui', version, license: 'MIT' }, 'node_modules/retry': { version: '0.12.0' } },
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
  };
  write('0.12.0');

  {
    const r = setVersion('0.13.0', fixture);
    const pkg = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(fixture, 'package-lock.json'), 'utf8'));
    check('6. set-version 同步 package.json 与 lock 的两处版本', () =>
      pkg.version === '0.13.0' && lock.version === '0.13.0' && lock.packages[''].version === '0.13.0' || JSON.stringify([pkg.version, lock.version, lock.packages[''].version]));
    check('6b. set-version 不改依赖的版本（lock 里有别的包也是 0.12.0）', () =>
      lock.packages['node_modules/retry'].version === '0.12.0' || lock.packages['node_modules/retry'].version);
    check('6c. set-version 不动其它字段', () =>
      pkg.name === 'pi-gui' && pkg.license === 'MIT' && pkg.scripts.test === 'x' && lock.lockfileVersion === 3 || JSON.stringify(pkg));
    check('6d. 报告改动了哪些文件', () => r.changed.length === 2 && r.version === '0.13.0' || JSON.stringify(r.changed));
  }

  check('7. set-version 幂等：已是目标版本时不再改动', () => {
    const before = fs.readFileSync(path.join(fixture, 'package.json'), 'utf8');
    const r = setVersion('0.13.0', fixture);
    return (r.changed.length === 0 && fs.readFileSync(path.join(fixture, 'package.json'), 'utf8') === before) || JSON.stringify(r.changed);
  });

  check('8. set-version 拒绝非法版本，且**一个字节都不写**', () => {
    const before = fs.readFileSync(path.join(fixture, 'package.json'), 'utf8');
    let threw = false;
    try {
      setVersion('v0.14', fixture);
    } catch {
      threw = true;
    }
    return (threw && fs.readFileSync(path.join(fixture, 'package.json'), 'utf8') === before) || '非法版本被接受或文件被改';
  });

  check('8b. set-version 接受预发布版本', () => {
    const r = setVersion('0.14.0-rc.1', fixture);
    return (r.changed.length === 2 && JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8')).version === '0.14.0-rc.1') || JSON.stringify(r);
  });

  check('9. unexpectedDiff 只容忍含 "version" 的行', () => {
    const a = '{\n  "name": "x",\n  "version": "1.0.0"\n}\n';
    const onlyVersion = '{\n  "name": "x",\n  "version": "2.0.0"\n}\n';
    const reformatted = '{\n"name": "x",\n"version": "1.0.0"\n}\n';
    return (
      unexpectedDiff(a, onlyVersion).length === 0 &&
      unexpectedDiff(a, reformatted).length > 0 ||
      JSON.stringify([unexpectedDiff(a, onlyVersion), unexpectedDiff(a, reformatted)])
    );
  });

  /* ================= 4. 写死版本号的守卫 ================= */
  console.log('\n--- 4. 静态版本源守卫 ---');

  check('10. 构建链路里写死版本号会被发现', () => {
    fs.mkdirSync(path.join(fixture, 'installer'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'installer', 'x.nsi'), 'Name "Pi GUI 0.13.0"\n', 'utf8');
    const hits = findHardcodedVersions('0.13.0', fixture);
    fs.rmSync(path.join(fixture, 'installer'), { recursive: true, force: true });
    return hits.includes('installer/x.nsi') || JSON.stringify(hits);
  });

  /* 反向：注释里提到版本号**不算**写死。
   * 这条是踩出来的 —— 扫原文时，一句解释性注释
   *（「package.json 是 0.13.0、文件名却是 0.12.0」）会把守卫判红，
   *  而修法只能是「把注释写含糊」，反而降低可读性。
   *  所以剥注释之后再扫，并**双向验证**（代码里写死仍然要红）。 */
  check('10a. 注释里提到版本号不算写死（只看代码，不看注释）', () => {
    fs.mkdirSync(path.join(fixture, 'installer'), { recursive: true });
    fs.writeFileSync(
      path.join(fixture, 'installer', 'y.nsi'),
      '; 注意：这里不要写 0.13.0，要从 package.json 派生\n/* 也不要在块注释里写 0.13.0 */\nName "${APP_NAME}"\n',
      'utf8'
    );
    const hits = findHardcodedVersions('0.13.0', fixture);
    fs.rmSync(path.join(fixture, 'installer'), { recursive: true, force: true });
    return hits.length === 0 || JSON.stringify(hits);
  });

  check('10b. 不误报：文件里没有那个版本号时返回空', () => findHardcodedVersions('9.9.9', fixture).length === 0);

  /* ================= 5. 真实仓库自检（只读） ================= */
  console.log('\n--- 5. 当前仓库自检（只读） ---');

  {
    const s = readVersionSources(ROOT);
    check('11. 真实仓库的 package / lock 一致', () => {
      const r = checkVersionConsistency(s);
      return r.ok === true || JSON.stringify(r.errors);
    });
    check('11b. 真实仓库的构建链路里没有写死的版本号', () => {
      const hits = findHardcodedVersions(s.pkgVersion, ROOT);
      return hits.length === 0 || '写死在：' + hits.join('、');
    });
    check('11c. 真实仓库的版本号是合法三段 SemVer', () => isValidReleaseVersion(s.pkgVersion) || String(s.pkgVersion));
  }

  fs.rmSync(fixture, { recursive: true, force: true });
  console.log(`\n${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
