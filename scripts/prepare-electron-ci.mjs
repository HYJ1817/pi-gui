/* CI 专用：准备 Electron 运行时与本地 zip。
 *
 * electron@44 的 npm 包没有 postinstall：第一次 require('electron') 时才调用
 * install.js；@electron/packager 又会自行下载 release zip 并读取远端
 * SHASUMS256.txt。GitHub release CDN 偶发 504 时，测试与打包会分别在这两个
 * 下载点失败。
 *
 * 这里在 CI 中显式安装一次（install.js 使用包内 checksums.json 校验），失败
 * 按退避重试；GitHub 全部重试失败后，才尝试 workflow 提供的只读镜像
 * （PI_GUI_ELECTRON_MIRROR），镜像下载同样受 checksums.json 约束。最后把
 * 已验证的 zip 交给 PI_GUI_ELECTRON_ZIP_DIR，build-app.mjs 不再联网。
 * 没有新增依赖，也没有改变产品运行时行为。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ELECTRON = path.join('node_modules', 'electron');
const ATTEMPTS = 4;

export function electronZipName(version, { platform = process.platform, arch = process.arch } = {}) {
  return `electron-v${version}-${platform}-${arch}.zip`;
}

export function findElectronZip(roots, zipName) {
  for (const root of roots.filter(Boolean)) {
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name === zipName) return full;
      }
    }
  }
  return null;
}

export function verifyElectronZip(zipPath, checksums) {
  const expected = checksums[path.basename(zipPath)];
  if (!expected) throw new Error(`Electron checksum is missing for ${path.basename(zipPath)}`);
  const actual = createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
  if (actual !== expected) throw new Error(`Electron zip SHA256 mismatch: ${zipPath}`);
  return true;
}

function defaultCacheRoot() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'electron', 'Cache');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'electron');
  return path.join(os.homedir(), '.cache', 'electron');
}

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

export function createZipFromDist(dist, zipPath, run = spawnSync) {
  if (process.platform !== 'win32') {
    throw new Error('creating the Electron zip from dist is only supported on Windows CI');
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$items = Get-ChildItem -LiteralPath '${psQuote(dist)}' -Force`,
    `Compress-Archive -LiteralPath $items.FullName -DestinationPath '${psQuote(zipPath)}' -Force`,
  ].join('; ');
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'inherit', windowsHide: true,
  });
  if (result.status !== 0 || !fs.existsSync(zipPath)) {
    throw new Error('failed to create the Electron zip from dist');
  }
}

export async function prepareElectronRuntime({
  root = process.cwd(),
  cacheRoot = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'pi-gui-electron-cache-')),
  attempts = ATTEMPTS,
  mirror = process.env.PI_GUI_ELECTRON_MIRROR,
  run = spawnSync,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = console.log,
} = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, ELECTRON, 'package.json'), 'utf8'));
  const zipName = electronZipName(pkg.version);
  const dist = path.join(root, ELECTRON, 'dist');
  const executable = path.join(dist, process.platform === 'win32' ? 'electron.exe' : 'electron');
  const pathFile = path.join(root, ELECTRON, 'path.txt');
  const installed = () => fs.existsSync(executable) && fs.existsSync(pathFile);
  const baseEnv = { ...process.env, electron_config_cache: cacheRoot };
  const sources = [
    { name: 'GitHub', env: baseEnv },
    ...(mirror ? [{ name: `镜像 ${mirror}`, env: { ...baseEnv, ELECTRON_MIRROR: mirror } }] : []),
  ];

  for (const source of sources) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (installed()) break;
      log(`Electron 运行时未安装；从 ${source.name} 第 ${attempt}/${attempts} 次安装`);
      const result = run(process.execPath, [path.join(root, ELECTRON, 'install.js')], {
        cwd: root, env: source.env, stdio: 'inherit', windowsHide: true, timeout: 180000,
      });
      if (result.status === 0 && installed()) break;
      if (attempt === attempts) break;
      const delay = 5000 * attempt;
      log(`Electron 下载失败；${delay / 1000}s 后重试`);
      await sleep(delay);
    }
    if (installed()) break;
  }
  if (!installed()) throw new Error(`Electron 运行时安装失败（已重试 ${attempts} 次${mirror ? '，并尝试镜像' : ''}）`);

  const checksums = JSON.parse(fs.readFileSync(path.join(root, ELECTRON, 'checksums.json'), 'utf8'));
  let zip = findElectronZip([cacheRoot, defaultCacheRoot()], zipName);
  if (zip) {
    verifyElectronZip(zip, checksums);
  } else {
    if (!installed()) throw new Error('Electron 已安装但找不到 zip，且 dist 不完整');
    const zipDir = fs.mkdtempSync(path.join(cacheRoot, 'zip-'));
    zip = path.join(zipDir, zipName);
    log('Electron 缓存 zip 不存在；从已校验的 dist 生成（跳过远端 SHASUMS）');
    createZipFromDist(dist, zip, run);
  }
  return { version: pkg.version, zip, zipDir: path.dirname(zip) };
}

async function main() {
  const result = await prepareElectronRuntime();
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `PI_GUI_ELECTRON_ZIP_DIR=${result.zipDir}\n`);
  }
  console.log(`Electron ${result.version} runtime ready: ${result.zip} (${fs.statSync(result.zip).size} bytes)`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
