// Explicit offline diagnostic only; not part of canonical or product startup.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
async function main() {
  const [zip, expected] = process.argv.slice(2);
  if (!zip || !path.isAbsolute(zip) || !/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Pass absolute offline Electron ZIP and previously verified SHA-256');
  const bytes = fs.readFileSync(zip), sha = crypto.createHash('sha256').update(bytes).digest('hex');
  console.log(JSON.stringify({ zipBytes: bytes.length, sha256: sha }));
  if (sha !== expected) throw new Error('runtime archive digest mismatch');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-preview-runtime-')), dist = path.join(root, 'runtime');
  fs.mkdirSync(dist);
  const quote = value => "'" + value.replace(/'/g, "''") + "'";
  const extracted = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(dist)}`], { encoding: 'utf8', timeout: 120000 });
  if (extracted.status !== 0) throw new Error('offline archive extraction failed: ' + extracted.stderr);
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { PREVIEW_PROBE_WORLD: root, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), APPDATA: path.join(root, 'home/AppData/Roaming'), LOCALAPPDATA: path.join(root, 'home/AppData/Local') });
  const exe = path.join(dist, 'electron.exe');
  console.log(JSON.stringify({ root, exeSha256: crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex') }));
  const child = spawn(exe, [path.join(__dirname, 'fixtures/file-preview-electron-probe.cjs'), '--enable-logging=stderr'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const timer = setTimeout(() => { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); console.error('runtime diagnostic timed out'); }, 45000);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  clearTimeout(timer); console.log(JSON.stringify({ root, ...exit }));
  process.exitCode = exit.code === 0 ? 0 : 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
