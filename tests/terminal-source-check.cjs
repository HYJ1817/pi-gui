/* Plain Node source-mode acceptance for the PTY terminal.
 *
 * This is the "source" leg of the three runtime environments:
 *   - source:   node server.js + <repo>/node_modules/node-pty
 *   - SEA:      build/Pi GUI.exe + build/node_modules/node-pty
 *   - Electron: dist-app/... + resources/app/node_modules/node-pty
 *
 * The backend contract in tests/files-terminal.cjs uses a fake PTY and cannot
 * prove the native module actually loads. This test starts the real source
 * server in a temp data/cwd, asks it for a real PowerShell, runs `node -v` and
 * verifies the child environment does not contain PI_GUI_TOKEN. It does not
 * touch a real project, user session, model or network.
 *
 * Usage: node tests/terminal-source-check.cjs
 * Exit 2 = skipped (not Windows); any failed check exits 1, never a fake pass.
 */
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'source-terminal-check-token';
const TASKKILL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.platform !== 'win32') {
  console.log('SKIP: terminal-source-check requires Windows/ConPTY.');
  process.exit(2);
}

let passed = 0;
let failed = 0;
const failures = [];
function check(name, fn) {
  try {
    const value = fn();
    if (value === false) throw new Error('returned false');
    passed++;
    console.log('  ok  ' + name);
  } catch (error) {
    failed++;
    failures.push(`${name}: ${error.message}`);
    console.error(` FAIL ${name}: ${error.message}`);
  }
}

function scrub(text) {
  return String(text)
    .replace(/(PI_GUI_TOKEN|PI_GUI_BROWSER_BRIDGE_TOKEN|PI_GUI_RUNTIME_BROWSER_TOKEN)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .replace(/([?&](?:token|auth|access_token)=)[^&\s]+/gi, '$1[redacted]');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

(async () => {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-source-terminal-'));
  const work = path.join(world, 'work');
  const data = path.join(world, 'data');
  const bin = path.join(world, 'bin');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'fake-pi.cjs'), [
    'const parentPid = process.ppid;',
    'let input = ""; process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", chunk => { input += chunk; let i; while ((i = input.indexOf("\\n")) >= 0) { const line = input.slice(0, i); input = input.slice(i + 1); try { const cmd = JSON.parse(line); process.stdout.write(JSON.stringify({ type: "response", command: cmd.type, id: cmd.id, success: true, data: { sessionId: "source-fixture" } }) + "\\n"); } catch {} } });',
    'setInterval(() => { try { process.kill(parentPid, 0); } catch { process.exit(0); } }, 400);',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(bin, 'fake-pi.cmd'), '@echo off\r\n"%FAKE_PI_NODE%" "%~dp0fake-pi.cjs" %*\r\n', 'utf8');

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logPath = path.join(world, 'server.log');
  const logFd = fs.openSync(logPath, 'w');
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      PI_GUI_OPEN: '0',
      PI_GUI_TOKEN: TOKEN,
      PI_GUI_DATA: data,
      PI_CWD: work,
      PI_BIN: path.join(bin, 'fake-pi.cmd'),
      FAKE_PI_NODE: process.execPath,
      PI_GUI_ENABLE_TERMINAL: '1',
    },
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  const headers = { 'content-type': 'application/json', 'x-pi-gui-token': TOKEN };
  let terminalId = '';
  let exited = false;
  server.once('exit', () => { exited = true; });

  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      await sleep(250);
      try { up = (await fetch(base + '/api/status', { headers })).ok; } catch { /* starting */ }
    }
    check('plain Node source server starts with the fixture project', () => assert.equal(up, true));

    let state = await (await fetch(base + '/api/status', { headers })).json();
    for (let i = 0; i < 40 && state.bridgeState === 'starting'; i++) {
      await sleep(50);
      state = await (await fetch(base + '/api/status', { headers })).json();
    }
    check('the source server reaches a ready pi bridge without a real pi', () => {
      assert.equal(state.piRunning, true);
      assert.equal(state.bridgeState, 'ready');
    });

    const started = await (await fetch(base + '/api/terminal', {
      method: 'POST', headers, body: JSON.stringify({ action: 'start', cols: 100, rows: 30 }),
    })).json();
    terminalId = started.session?.id || '';
    check('the source server loads repository node-pty and spawns PowerShell', () => {
      assert.equal(started.ok, true, JSON.stringify(started));
      assert.equal(started.session.pty, true);
      assert.equal(started.session.shell, 'PowerShell');
      assert.equal(started.session.cwd.replace(/\\/g, '/'), work.replace(/\\/g, '/'));
    });

    const read = async () => {
      const result = await (await fetch(base + '/api/terminal?id=' + encodeURIComponent(terminalId) + '&since=0', { headers })).json();
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result;
    };
    const write = async (data) => {
      const result = await (await fetch(base + '/api/terminal', {
        method: 'POST', headers, body: JSON.stringify({ action: 'input', id: terminalId, data }),
      })).json();
      if (!result.ok) throw new Error(JSON.stringify(result));
    };
    const readUntil = async (pattern, timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      let text = '';
      while (Date.now() < deadline) {
        const result = await read();
        text = result.text || '';
        if (pattern.test(text)) return text;
        await sleep(100);
      }
      throw new Error('timeout waiting for ' + pattern + ': ' + text.slice(-300));
    };

    await readUntil(/PS [^>]*>/);
    await write('node -v\r');
    const versionText = await readUntil(/v\d+\.\d+\.\d+/);
    check('a real Node.js process runs inside the source-mode ConPTY', () => {
      assert.match(versionText, /v\d+\.\d+\.\d+/);
    });

    await write("if ($env:PI_GUI_TOKEN) { 'TOKEN_' + 'LEAK' } else { 'TOKEN_' + 'CLEAN' }\r");
    const tokenText = await readUntil(/TOKEN_(?:LEAK|CLEAN)/);
    check('the PTY child environment does not inherit PI_GUI_TOKEN', () => {
      assert.ok(tokenText.includes('TOKEN_CLEAN'), 'token leaked into the shell');
      assert.ok(!tokenText.includes('TOKEN_LEAK'));
    });

    const stopped = await (await fetch(base + '/api/terminal', {
      method: 'POST', headers, body: JSON.stringify({ action: 'stop', id: terminalId }),
    })).json();
    check('the source-mode terminal acknowledges stop', () => assert.equal(stopped.ok, true));
    let finalState = stopped.session?.state;
    for (let i = 0; i < 50 && finalState !== 'exited'; i++) {
      await sleep(100);
      finalState = (await read()).state;
    }
    check('the source-mode PTY reaches the real exit state', () => assert.equal(finalState, 'exited'));

    if (failed) {
      console.error('\nFailure details:');
      for (const failure of failures) console.error('- ' + failure);
      console.error('\nLast server log lines:\n' + scrub(fs.readFileSync(logPath, 'utf8').split(/\r?\n/).slice(-60).join('\n')));
    }
    console.log(`\nSource-mode terminal acceptance: ${passed}/${passed + failed}`);
    console.log(`RESULT ${failed ? 'FAIL' : 'PASS'} (${passed}/${passed + failed})`);
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error('ACCEPTANCE ERROR:', error);
    try {
      console.error('\nLast server log lines:\n' + scrub(fs.readFileSync(logPath, 'utf8').split(/\r?\n/).slice(-60).join('\n')));
    } catch { /* no log */ }
    process.exitCode = 1;
  } finally {
    if (terminalId) {
      try {
        await fetch(base + '/api/terminal', {
          method: 'POST', headers, body: JSON.stringify({ action: 'stop', id: terminalId }),
        });
      } catch { /* already gone */ }
    }
    if (!exited) {
      try { execFileSync(TASKKILL, ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 }); } catch { /* already gone */ }
    }
    try { fs.closeSync(logFd); } catch { /* noop */ }
    try { fs.rmSync(world, { recursive: true, force: true }); } catch { /* best effort */ }
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
