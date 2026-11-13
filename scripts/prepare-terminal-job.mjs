import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PATCH_DIR = 'vendor/node-pty-job';
const PLATFORM = 'win32-x64';
const ADDON = 'prebuilds/win32-x64/conpty.node';
const RUNTIME_FILES = ['lib/index.js', 'lib/utils.js', 'lib/windowsConoutConnection.js', 'lib/windowsPtyAgent.js', 'lib/windowsTerminal.js'];
const SOURCE_FILES = ['src/win/conpty.cc', 'typings/node-pty.d.ts'];

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function applyTerminalJobPatch(root, destination, platform, { source = false } = {}) {
  if (platform !== PLATFORM) return null;
  const patch = path.join(root, PATCH_DIR);
  const manifest = JSON.parse(fs.readFileSync(path.join(patch, 'manifest.json'), 'utf8'));
  const { version } = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'));
  if (version !== manifest.nodePtyVersion || manifest.platform !== PLATFORM) {
    throw new Error(`Terminal Job patch expects node-pty ${manifest.nodePtyVersion} for ${PLATFORM}, got ${version}`);
  }
  if (sha256(path.join(patch, ADDON)) !== manifest.sha256) {
    throw new Error('Terminal Job prebuild SHA-256 mismatch');
  }
  for (const file of [...(source ? SOURCE_FILES : []), ADDON, ...RUNTIME_FILES]) {
    fs.copyFileSync(path.join(patch, file), path.join(destination, file));
  }
  const installedSha = sha256(path.join(destination, ADDON));
  if (installedSha !== manifest.sha256) throw new Error('Installed Terminal Job prebuild SHA-256 mismatch');
  return installedSha;
}

const script = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  const root = path.resolve(path.dirname(script), '..');
  const sha = applyTerminalJobPatch(root, path.join(root, 'node_modules/node-pty'),
    `${process.platform}-${process.arch}`, { source: true });
  console.log(sha ? `Terminal Job node-pty prebuild SHA-256: ${sha}` : 'Terminal Job patch targets Windows x64');
}
