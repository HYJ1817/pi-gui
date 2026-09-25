const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function occupiedServer(health) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/health' ? health : { ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function runCli(port, args = []) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-port-'));
  try {
    const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'server.js'), ...args], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PORT: String(port), PI_GUI_DATA: dataDir, PI_GUI_OPEN: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('CLI did not exit')); }, 6000);
      child.on('exit', (value) => { clearTimeout(timer); resolve(value); });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
    return { code, output };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

(async () => {
  const foreign = await occupiedServer({ app: 'foreign', protocol: 1 });
  try {
    const result = await runCli(foreign.address().port, ['--open']);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /其他程序占用/);
  } finally {
    await new Promise((resolve) => foreign.close(resolve));
  }

  const own = await occupiedServer({ app: 'pi-gui', protocol: 1, version: '0.7.0' });
  try {
    const result = await runCli(own.address().port);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /已有 Pi GUI/);
  } finally {
    await new Promise((resolve) => own.close(resolve));
  }
  console.log('port-owner: passed');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
