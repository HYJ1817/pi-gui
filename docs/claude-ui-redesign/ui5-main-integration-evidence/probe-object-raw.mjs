import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadObjectHelper, resolveObjectInterpreter } from '../../../server/session-revert-object-resources.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p33-object-raw-'));
await fs.writeFile(path.join(root, 'file.txt'), 'probe fixture');
try {
  const helper = loadObjectHelper('observer');
  const interpreter = await resolveObjectInterpreter();
  const original = helper.bytes.toString('utf8');
  const marker = "catch { @{status='unavailable';reason='object_observation_unavailable';nonAtomic=$true}|ConvertTo-Json -Compress }";
  const diagnostic = original.replace(marker,
    "catch { @{status='unavailable';reason=$_.Exception.GetType().FullName+': '+$_.Exception.Message;nonAtomic=$true}|ConvertTo-Json -Compress }");
  const child = spawn(interpreter, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(diagnostic, 'utf16le').toString('base64')], {
    env: { ...process.env }, cwd: path.dirname(interpreter), shell: false, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const request = JSON.stringify({ mode: 'observe', root, relativePath: 'file.txt' })
    .replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  child.stdin.end(request);
  const code = await new Promise(resolve => child.on('close', resolve));
  console.log(JSON.stringify({ root, code, stdout, stderr }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
