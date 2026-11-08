/* CI Electron 缓存的离线回归。
 *
 * 只验证纯逻辑：zip 名称、嵌套缓存查找、SHA256 校验、安装失败重试。
 * 不下载 Electron，不启动构建，也不依赖这台机器是否装过 Electron。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'scripts', 'prepare-electron-ci.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-ci-electron-cache-'));
  const name = mod.electronZipName('44.4.3', { platform: 'win32', arch: 'x64' });
  assert.equal(name, 'electron-v44.4.3-win32-x64.zip');

  try {
    const nested = path.join(tmp, 'cache', 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    const zip = path.join(nested, name);
    fs.writeFileSync(zip, 'fixture-zip');
    assert.equal(mod.findElectronZip([tmp], name), zip);
    assert.equal(mod.findElectronZip([path.join(tmp, 'missing')], name), null);

    const digest = createHash('sha256').update('fixture-zip').digest('hex');
    assert.equal(mod.verifyElectronZip(zip, { [name]: digest }), true);
    assert.throws(() => mod.verifyElectronZip(zip, { [name]: '0'.repeat(64) }), /SHA256 mismatch/);
    assert.throws(() => mod.verifyElectronZip(zip, {}), /checksum is missing/);

    const repo = path.join(tmp, 'repo');
    const electron = path.join(repo, 'node_modules', 'electron');
    fs.mkdirSync(path.join(electron, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ version: '44.4.3' }));
    fs.writeFileSync(path.join(electron, 'path.txt'), process.platform === 'win32' ? 'electron.exe' : 'electron');
    fs.writeFileSync(path.join(electron, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'), 'fixture');
    fs.writeFileSync(path.join(electron, 'checksums.json'), JSON.stringify({ [name]: digest }));

    const cache = path.join(tmp, 'cache');
    const result = await mod.prepareElectronRuntime({
      root: repo,
      cacheRoot: cache,
      mirror: '',
      run: () => { throw new Error('installed Electron must not be downloaded again'); },
      sleep: async () => {},
      log: () => {},
    });
    assert.equal(result.zip, zip);
    assert.equal(result.zipDir, path.dirname(zip));

    const bare = path.join(tmp, 'bare');
    fs.mkdirSync(path.join(bare, 'node_modules', 'electron'), { recursive: true });
    fs.writeFileSync(path.join(bare, 'node_modules', 'electron', 'package.json'), JSON.stringify({ version: '44.4.3' }));
    fs.writeFileSync(path.join(bare, 'node_modules', 'electron', 'checksums.json'), JSON.stringify({ [name]: digest }));
    let attempts = 0;
    const waits = [];
    await assert.rejects(() => mod.prepareElectronRuntime({
      root: bare,
      cacheRoot: path.join(tmp, 'empty-cache'),
      attempts: 3,
      mirror: '',
      run: () => { attempts += 1; return { status: 1 }; },
      sleep: async ms => { waits.push(ms); },
      log: () => {},
    }), /已重试 3 次/);
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [5000, 10000]);

    const mirrorRepo = path.join(tmp, 'mirror-repo');
    const mirrorElectron = path.join(mirrorRepo, 'node_modules', 'electron');
    fs.mkdirSync(path.join(mirrorElectron, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(mirrorElectron, 'package.json'), JSON.stringify({ version: '44.4.3' }));
    const mirrorCache = path.join(tmp, 'mirror-cache');
    fs.mkdirSync(mirrorCache, { recursive: true });
    const mirrorZip = path.join(mirrorCache, name);
    fs.writeFileSync(mirrorZip, 'mirror-zip');
    fs.writeFileSync(path.join(mirrorElectron, 'checksums.json'), JSON.stringify({
      [name]: createHash('sha256').update('mirror-zip').digest('hex'),
    }));
    const mirrorEnv = [];
    let mirrorAttempts = 0;
    const mirrorRun = (command, args, options) => {
      mirrorAttempts += 1;
      if (!options.env.ELECTRON_MIRROR) return { status: 1 };
      mirrorEnv.push(options.env.ELECTRON_MIRROR);
      const executable = process.platform === 'win32' ? 'electron.exe' : 'electron';
      fs.writeFileSync(path.join(mirrorElectron, 'path.txt'), executable);
      fs.writeFileSync(path.join(mirrorElectron, 'dist', executable), 'fixture');
      return { status: 0 };
    };
    const mirrored = await mod.prepareElectronRuntime({
      root: mirrorRepo,
      cacheRoot: mirrorCache,
      attempts: 2,
      mirror: 'https://mirror.invalid/electron/',
      run: mirrorRun,
      sleep: async () => {},
      log: () => {},
    });
    assert.equal(mirrorAttempts, 3);
    assert.deepEqual(mirrorEnv, ['https://mirror.invalid/electron/']);
    assert.equal(mirrored.zip, mirrorZip);

    console.log('ci-electron-cache: zip discovery, checksum guard, retry and mirror fallback verified');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
