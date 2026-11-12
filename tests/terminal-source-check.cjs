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
const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runPowerShell(script) {
  return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  }).trim();
}

/* Command-line identity, not a bare PID: the same PID may be reused. */
function markerPids(marker) {
  const script = `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${marker}') } | ForEach-Object { [int]$_.ProcessId }) -join ','`;
  const out = runPowerShell(script);
  return out ? out.split(',').map(Number).filter(Number.isInteger) : [];
}

function killMarker(marker) {
  for (const pid of markerPids(marker)) {
    try { execFileSync(TASKKILL, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 }); } catch { /* already gone */ }
  }
}

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

    const terminalCall = async (body) => (await fetch(base + '/api/terminal', {
      method: 'POST', headers, body: JSON.stringify(body),
    })).json();
    const activated = async (target) => {
      const result = await (await fetch(base + '/api/projects/activate', {
        method: 'POST', headers, body: JSON.stringify({ path: target }),
      })).json();
      if (!result.ok) throw new Error('activate failed: ' + JSON.stringify(result));
      /* activate setCurrentCwd synchronously before responding; give the
       * restarted bridge a moment to settle as the real app would. */
      await sleep(400);
    };

    const started = await terminalCall({ action: 'start', cols: 100, rows: 30 });
    terminalId = started.session?.id || '';
    check('the source server loads repository node-pty and spawns PowerShell', () => {
      assert.equal(started.ok, true, JSON.stringify(started));
      assert.equal(started.session.pty, true);
      assert.equal(started.session.shell, 'PowerShell');
      assert.equal(started.session.cwd.replace(/\\/g, '/'), work.replace(/\\/g, '/'));
    });

    const readId = async (id, since = 0) => {
      const result = await (await fetch(base + '/api/terminal?id=' + encodeURIComponent(id) + '&since=' + since, { headers })).json();
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result;
    };
    const writeId = async (id, data) => {
      const result = await terminalCall({ action: 'input', id, data });
      if (!result.ok) throw new Error(JSON.stringify(result));
    };
    const readUntil = async (id, pattern, timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      let text = '';
      while (Date.now() < deadline) {
        const result = await readId(id, 0);
        text = result.text || '';
        if (pattern.test(text)) return text;
        await sleep(100);
      }
      throw new Error('timeout waiting for ' + pattern + ': ' + text.slice(-300));
    };

    const firstId = terminalId;
    await readUntil(firstId, /PS [^>]*>/);
    await writeId(firstId, 'node -v\r');
    const versionText = await readUntil(firstId, /v\d+\.\d+\.\d+/);
    check('a real Node.js process runs inside the source-mode ConPTY', () => {
      assert.match(versionText, /v\d+\.\d+\.\d+/);
    });

    await writeId(firstId, "if ($env:PI_GUI_TOKEN) { 'TOKEN_' + 'LEAK' } else { 'TOKEN_' + 'CLEAN' }\r");
    const tokenText = await readUntil(firstId, /TOKEN_(?:LEAK|CLEAN)/);
    check('the PTY child environment does not inherit PI_GUI_TOKEN', () => {
      assert.ok(tokenText.includes('TOKEN_CLEAN'), 'token leaked into the shell');
      assert.ok(!tokenText.includes('TOKEN_LEAK'));
    });

    const second = await terminalCall({ action: 'create', cols: 120, rows: 40 });
    const third = await terminalCall({ action: 'create', cols: 90, rows: 24 });
    const secondId = second.session?.id || '';
    const thirdId = third.session?.id || '';
    await readUntil(secondId, /PS [^>]*>/);
    await readUntil(thirdId, /PS [^>]*>/);
    const initialList = await terminalCall({ action: 'list' });
    const workspaceA = initialList.workspace?.id || '';
    check('three real ConPTY sessions belong to the same workspace with independent ids', () => {
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal(third.ok, true, JSON.stringify(third));
      assert.equal(new Set([firstId, secondId, thirdId]).size, 3);
      assert.equal(initialList.sessions.length, 3);
      assert.deepEqual(initialList.sessions.map((session) => session.ordinal), [1, 2, 3]);
      assert.ok(initialList.sessions.every((session) => session.cwd.replace(/\\/g, '/') === work.replace(/\\/g, '/')));
      assert.ok(initialList.sessions.every((session) => session.workspace.id === workspaceA));
      assert.equal(second.session.cols, 120);
      assert.equal(second.session.rows, 40);
    });

    /* Let the slow session echo its command before the fast one is written.
     * The marker is concatenated so the echoed command line does not match. */
    const parallelStart = Date.now();
    await writeId(firstId, "Start-Sleep -Milliseconds 3000; 'P2_SLOW_' + 'OK'\r");
    await sleep(150);
    await writeId(secondId, "'P2_FAST_' + 'OK'\r");
    const fastText = await readUntil(secondId, /P2_FAST_OK/, 10000);
    const fastMs = Date.now() - parallelStart;
    const slowText = await readUntil(firstId, /P2_SLOW_OK/, 12000);
    const slowMs = Date.now() - parallelStart;
    check('three real ConPTY sessions run commands in parallel, not one after another', () => {
      assert.ok(fastMs < 2000, `fast marker took ${fastMs}ms while the slow shell slept`);
      assert.ok(slowMs >= 2500, `slow marker returned after ${slowMs}ms`);
    });
    check('each ConPTY session only sees its own output', () => {
      assert.ok(fastText.includes('P2_FAST_OK'));
      assert.ok(!fastText.includes('P2_SLOW_OK'));
      assert.ok(slowText.includes('P2_SLOW_OK'));
      assert.ok(!slowText.includes('P2_FAST_OK'));
    });

    const keepOn = await terminalCall({ action: 'keep-alive', id: thirdId, enabled: true });
    const keepList = await terminalCall({ action: 'list' });
    const keepOff = await terminalCall({ action: 'keep-alive', id: thirdId, enabled: false });
    check('a real ConPTY session accepts server-owned Keep Alive and lists it', () => {
      assert.equal(keepOn.ok, true, JSON.stringify(keepOn));
      assert.equal(keepOn.session.keepAlive, true);
      assert.equal(keepList.sessions.find((session) => session.id === thirdId)?.keepAlive, true);
      assert.equal(keepOff.ok, true, JSON.stringify(keepOff));
      assert.equal(keepOff.session.keepAlive, false);
    });

    const workB = path.join(world, 'work-b');
    fs.mkdirSync(workB, { recursive: true });
    await activated(workB);
    const bCreated = await terminalCall({ action: 'create', cols: 80, rows: 24 });
    const bId = bCreated.session?.id || '';
    const bList = await terminalCall({ action: 'list' });
    const forgedRead = await (await fetch(base + '/api/terminal?id=' + encodeURIComponent(firstId) + '&since=0', { headers })).json();
    const forgedWrite = await terminalCall({ action: 'input', id: firstId, data: 'x' });
    const forgedClose = await terminalCall({ action: 'close', id: secondId });
    check('workspace B lists only its own terminal and cannot reach workspace A sessions', () => {
      assert.equal(bCreated.ok, true, JSON.stringify(bCreated));
      assert.equal(bCreated.session.cwd.replace(/\\/g, '/'), workB.replace(/\\/g, '/'));
      assert.notEqual(bList.workspace.id, workspaceA);
      assert.deepEqual(bList.sessions.map((session) => session.id), [bId]);
      assert.equal(forgedRead.code, 'stale_workspace');
      assert.equal(forgedWrite.code, 'stale_workspace');
      assert.equal(forgedClose.code, 'stale_workspace');
    });

    await activated(work);
    const backList = await terminalCall({ action: 'list' });
    const backText = await readUntil(firstId, /P2_SLOW_OK/, 5000);
    await writeId(secondId, "'P2_RETURN_' + 'OK'\r");
    const returnText = await readUntil(secondId, /P2_RETURN_OK/, 10000);
    check('returning to workspace A reconnects to the same three live PTYs and buffers', () => {
      assert.equal(backList.workspace.id, workspaceA);
      assert.deepEqual(backList.sessions.map((session) => session.id).sort(), [firstId, secondId, thirdId].sort());
      assert.ok(!backList.sessions.some((session) => session.id === bId));
      assert.ok(backText.includes('P2_SLOW_OK'));
      assert.ok(returnText.includes('P2_RETURN_OK'));
    });

    /* Close one tab and prove the real ConPTY tree (shell + foreground Node
     * child) is gone by command-line identity, not by PID reuse. */
    const marker = `PI_GUI_SOURCE_${process.pid}_${Date.now()}`;
    const nodePath = process.execPath.replace(/'/g, "''");
    await writeId(thirdId, `& '${nodePath}' -e 'setInterval(()=>{},1000)' '${marker}'\r`);
    let markerRunning = [];
    for (let i = 0; i < 40 && !markerRunning.length; i++) {
      await sleep(250);
      markerRunning = markerPids(marker);
    }
    check('a real foreground Node child is running inside the third PTY tree', () => {
      assert.ok(markerRunning.length > 0, 'marker child not found');
    });
    const closeThird = await terminalCall({ action: 'close', id: thirdId });
    let markerLeft = markerPids(marker);
    for (let i = 0; i < 60 && markerLeft.length; i++) {
      await sleep(250);
      markerLeft = markerPids(marker);
    }
    let thirdAfterClose = null;
    for (let i = 0; i < 40; i++) {
      thirdAfterClose = await (await fetch(base + '/api/terminal?id=' + encodeURIComponent(thirdId) + '&since=0', { headers })).json();
      if (thirdAfterClose.code === 'terminal_missing' || thirdAfterClose.state === 'exited') break;
      await sleep(100);
    }
    await writeId(secondId, "'P2_ALIVE_' + 'OK'\r");
    const aliveText = await readUntil(secondId, /P2_ALIVE_OK/, 8000);
    const firstState = (await readId(firstId, 0)).state;
    check('closing one tab tree-kills only its ConPTY and leaves the other sessions running', () => {
      assert.equal(closeThird.ok, true, JSON.stringify(closeThird));
      assert.deepEqual(markerLeft, []);
      assert.ok(
        thirdAfterClose.code === 'terminal_missing' || thirdAfterClose.state === 'exited',
        JSON.stringify(thirdAfterClose)
      );
      assert.ok(aliveText.includes('P2_ALIVE_OK'));
      assert.equal(firstState, 'running');
    });

    await terminalCall({ action: 'close', id: secondId });
    const stopped = await terminalCall({ action: 'stop', id: firstId });
    check('the source-mode terminal acknowledges stop', () => assert.equal(stopped.ok, true));
    let finalState = stopped.session?.state;
    for (let i = 0; i < 50 && finalState !== 'exited'; i++) {
      await sleep(100);
      finalState = (await readId(firstId, 0)).state;
    }
    check('the source-mode PTY reaches the real exit state', () => assert.equal(finalState, 'exited'));

    await activated(workB);
    const bAgain = await terminalCall({ action: 'list' });
    check('workspace B kept its terminal alive while workspace A was focused and closed', () => {
      assert.equal(bAgain.sessions.length, 1);
      assert.equal(bAgain.sessions[0].id, bId);
      assert.equal(bAgain.sessions[0].state, 'running');
    });
    await terminalCall({ action: 'close', id: bId });
    const bEmpty = await terminalCall({ action: 'list' });
    check('closing workspace B leaves no session in B', () => assert.deepEqual(bEmpty.sessions, []));

    const logTail = fs.readFileSync(logPath, 'utf8');
    check('no ConPTY helper crash stack in the source-mode log', () => {
      assert.ok(!/AttachConsole failed|conpty_console_list_agent\.js.*Error/i.test(logTail), 'ConPTY helper crash trace found');
    });

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
