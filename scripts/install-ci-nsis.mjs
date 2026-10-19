// Pinned from Microsoft's WinGet NSIS.NSIS/3.13 installer manifest.
// https://github.com/microsoft/winget-pkgs/blob/master/manifests/n/NSIS/NSIS/3.13/NSIS.NSIS.installer.yaml
// Download remains on the NSIS project's official SourceForge distribution.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const NSIS = Object.freeze({
  version: '3.13',
  url: 'https://sourceforge.net/projects/nsis/files/NSIS%203/3.13/nsis-3.13-setup.exe/download',
  sha256: 'db9a1038bbc0e53fef24f423fd609979bd578e942f1be1198db186d1c42652a3',
});

export async function downloadVerified({ url, sha256, dest, fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxBytes = 10 * 1024 * 1024 }) {
  let bytes;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`NSIS download HTTP ${response.status}`);
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) throw new Error('NSIS download exceeds size limit');
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
      break;
    } catch (error) {
      if (attempt === 3 || /size limit/.test(error.message)) throw error;
      console.log(`NSIS download attempt ${attempt} failed; retrying`);
      await sleep(5000 * attempt);
    }
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256) throw new Error('NSIS installer SHA256 mismatch; refusing execution');
  fs.writeFileSync(dest, bytes, { flag: 'wx' });
  console.log(`NSIS installer SHA256 verified: ${actual}`);
}

export function installVerified({ installer, compiler, run = spawnSync, onVerified = () => {} }) {
  const install = run(installer, ['/S'], { timeout: 120000, windowsHide: true, encoding: 'utf8' });
  if (install.error || install.status !== 0) throw new Error('NSIS installer failed');
  const probe = run(compiler, ['/VERSION'], { timeout: 15000, windowsHide: true, encoding: 'utf8' });
  if (probe.error || probe.status !== 0) throw new Error('NSIS compiler probe failed');
  if (probe.stdout.trim() !== `v${NSIS.version}`) throw new Error('NSIS compiler version mismatch');
  console.log(`NSIS compiler verified: v${NSIS.version}`);
  onVerified(path.dirname(compiler));
}

async function main() {
  // Never silently install on the developer's machine.
  if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true'
    || !process.env.RUNNER_TEMP || !process.env.GITHUB_ENV) {
    throw new Error('NSIS bootstrap is restricted to Windows GitHub Actions runners');
  }
  const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'pi-gui-nsis-'));
  const installer = path.join(directory, 'nsis-setup.exe');
  try {
    await downloadVerified({ ...NSIS, dest: installer });
    installVerified({ installer, compiler: 'C:\\Program Files (x86)\\NSIS\\makensis.exe',
      onVerified: home => fs.appendFileSync(process.env.GITHUB_ENV, `NSIS_HOME=${home}\n`),
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
