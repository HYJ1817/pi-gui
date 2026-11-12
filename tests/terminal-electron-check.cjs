/* Real Electron + Windows PTY acceptance.
 *
 * This is deliberately NOT part of the canonical `npm test` chain: it needs a
 * built desktop app, a Windows desktop session and a real ConPTY. It proves a
 * different environment from tests/app-check.cjs (packaged server.cjs under the
 * Node runtime) and tests/exe-check.cjs (Node SEA single-file exe).
 *
 * Usage:
 *   npm run build:app -- --rebuild
 *   node tests/terminal-electron-check.cjs [--app <dir>]
 *
 * The app directory is copied to a fresh os.tmpdir() folder so the test never
 * reads the developer's node_modules or writes user data. Exit code 2 means
 * "skipped: not a Windows desktop session / build missing", never PASS.
 */
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_AT = process.argv.indexOf('--app');
const DEFAULT_APP = path.join(ROOT, 'dist-app', 'Pi GUI-win32-x64');
const SOURCE_APP = path.resolve(APP_AT >= 0 ? process.argv[APP_AT + 1] || '' : DEFAULT_APP);
const EXE = path.join(SOURCE_APP, 'Pi GUI.exe');
const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
);
const TASKKILL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.platform !== 'win32') {
  console.log('SKIP: terminal-electron-check requires Windows 11 + a desktop session.');
  process.exit(2);
}
if (!fs.existsSync(EXE)) {
  console.log(`SKIP: packaged Electron app not found at ${EXE}`);
  console.log('Run `npm run build:app -- --rebuild` first.');
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
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error: error.message });
    console.error(` FAIL ${name}: ${error.message}`);
  }
}

function runPowerShell(script) {
  return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  }).trim();
}

function markerPids(marker) {
  const script = `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${marker}') } | ForEach-Object { [int]$_.ProcessId }) -join ','`;
  const out = runPowerShell(script);
  return out ? out.split(',').map(Number).filter(Number.isInteger) : [];
}

function processIdentity(pid) {
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'; if($p){[string]$p.CreationDate + '|' + [string]$p.CommandLine}`;
  /* Do not swallow a failed CIM query: '' would look identical to "process not
   * found" and turn a still-running shell into a passing exit check. */
  return runPowerShell(script);
}

async function waitForIdentityChange(pid, identity, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let lastError = null;
  for (;;) {
    try {
      last = processIdentity(pid);
      lastError = null;
      if (!last || !last.startsWith(identity)) return { gone: last, error: null };
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) return { gone: last, error: lastError };
    await sleep(250);
  }
}

function killMarker(marker) {
  for (const pid of markerPids(marker)) {
    try { execFileSync(TASKKILL, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 }); } catch { /* already gone */ }
  }
}

/* App logs are printed only on failure. Never echo a token, even if a future
 * logging change starts including the launch environment. */
function scrub(text) {
  return String(text)
    .replace(/(PI_GUI_TOKEN|PI_GUI_BROWSER_BRIDGE_TOKEN|PI_GUI_RUNTIME_BROWSER_TOKEN)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .replace(/([?&](?:token|auth|access_token)=)[^&\s]+/gi, '$1[redacted]');
}

function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* fall through */ }
  if (fs.existsSync(target)) {
    try { execFileSync('rm', ['-rf', '--', target], { stdio: 'ignore' }); } catch { /* best effort */ }
  }
}

function nodeModulesAncestor(dir) {
  let current = path.dirname(path.resolve(dir));
  for (;;) {
    if (fs.existsSync(path.join(current, 'node_modules'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
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

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP websocket failed'));
  });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
    }
    return result.result?.value;
  };
  return { ws, send, evaluate };
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-terminal-electron-'));
  const appDir = path.join(temp, 'app');
  const work = path.join(temp, 'work');
  const data = path.join(temp, 'data');
  const profile = path.join(temp, 'profile');
  const bin = path.join(temp, 'bin');
  const logPath = path.join(temp, 'app.log');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.cpSync(SOURCE_APP, appDir, { recursive: true });

  const fakePiScript = path.join(bin, 'fake-pi.cjs');
  fs.writeFileSync(fakePiScript, [
    'const parentPid = process.ppid;',
    'let input = ""; process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", chunk => { input += chunk; let i; while ((i = input.indexOf("\\n")) >= 0) { const line = input.slice(0, i); input = input.slice(i + 1); try { const cmd = JSON.parse(line); process.stdout.write(JSON.stringify({ type: "response", command: cmd.type, id: cmd.id, success: true, data: { sessionId: "electron-fixture" } }) + "\\n"); } catch {} } });',
    'setInterval(() => { try { process.kill(parentPid, 0); } catch { process.exit(0); } }, 400);',
    '',
  ].join('\n'), 'utf8');
  const fakePi = path.join(bin, 'fake-pi.cmd');
  fs.writeFileSync(fakePi, '@echo off\r\n"%FAKE_PI_NODE%" "%~dp0fake-pi.cjs" %*\r\n', 'utf8');

  let app = null;
  let cdp = null;
  let appExited = false;
  let marker = '';
  let markerChild = 0;
  let shellPid = 0;
  let shellIdentity = '';
  let terminalId = '';

  try {
    check('packaged app is independent of the development repository', () => {
      assert.ok(!appDir.startsWith(ROOT + path.sep), 'app copy still lives inside the repository');
      assert.equal(nodeModulesAncestor(appDir), null, `unexpected node_modules ancestor: ${nodeModulesAncestor(appDir)}`);
    });
    check('packaged Electron app contains the node-pty ConPTY sidecar', () => {
      assert.ok(fs.existsSync(path.join(appDir, 'resources', 'app', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node')));
      assert.ok(fs.existsSync(path.join(appDir, 'resources', 'app', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty', 'conpty.dll')));
      assert.ok(fs.existsSync(path.join(appDir, 'resources', 'app', 'server.cjs')));
    });
    const electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
    check('the project pins Electron 44.4.3', () => {
      assert.equal(electronVersion, '44.4.3');
    });

    const cdpPort = await freePort();
    const appPort = await freePort();
    const logFd = fs.openSync(logPath, 'w');
    app = spawn(path.join(appDir, 'Pi GUI.exe'), [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
    ], {
      cwd: appDir,
      env: {
        ...process.env,
        PORT: String(appPort),
        PI_GUI_OPEN: '0',
        PI_GUI_DATA: data,
        PI_CWD: work,
        PI_BIN: fakePi,
        FAKE_PI_NODE: process.execPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    app.stdout.on('data', (chunk) => fs.writeSync(logFd, chunk));
    app.stderr.on('data', (chunk) => fs.writeSync(logFd, chunk));
    app.once('exit', () => { appExited = true; });

    let page = null;
    for (let i = 0; i < 160 && !page; i++) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
        page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      } catch { /* still starting */ }
    }
    if (!page) throw new Error('Electron CDP page did not appear');
    cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.bringToFront');

    let booted = false;
    for (let i = 0; i < 160 && !booted; i++) {
      booted = await cdp.evaluate("document.readyState==='complete'&&!!document.querySelector('#btnTerminal')&&!!document.querySelector('#rightPane')");
      if (!booted) await sleep(250);
    }
    check('real Electron renderer booted', () => assert.equal(booted, true));

    /* Inspect the running app, not just the devDependency: a stale dist-app
     * could have been built with a different Electron/ABI. The renderer UA
     * reports the actual runtime. */
    const userAgent = await cdp.evaluate('navigator.userAgent');
    check('the app under test runs Electron 44.4.3', () => {
      assert.match(String(userAgent), /Electron\/44\.4\.3(?:[\s;]|$)/);
    });

    const backend = await cdp.evaluate(`(async()=>{
      const r=await fetch('/api/status');
      return await r.json();
    })()`).catch(() => null);
    check('the desktop app reports its backend as running', () => {
      assert.equal(backend?.piRunning, true);
    });
    check('the packaged backend runs on the app Electron binary', () => {
      /* main.cjs starts resources/app/server.cjs with ELECTRON_RUN_AS_NODE.
       * A process whose image is the app exe and whose command line names
       * server.cjs is the Electron runtime, not a standalone Node SEA. */
      const rows = runPowerShell(`@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('resources') -and $_.CommandLine.Contains('server.cjs') } | ForEach-Object { [string]$_.ExecutablePath + '|' + [string]$_.CommandLine }) -join "\`n"`);
      assert.ok(rows.includes(path.join(appDir, 'Pi GUI.exe')), rows || 'no server.cjs process');
      assert.ok(/server\.cjs/i.test(rows), 'server.cjs not found on the command line');
    });

    const mounted = await cdp.evaluate(`(async()=>{
      const direct=document.getElementById('btnTerminal');
      if(direct) direct.click();
      await new Promise(r=>setTimeout(r,800));
      if(!document.querySelector('.term-host .xterm')){
        document.getElementById('btnWorkPanel')?.click();
        await new Promise(r=>setTimeout(r,300));
        const more=document.querySelector('.work-panel-launcher-more');
        if(more&&more.getAttribute('aria-expanded')!=='true')more.click();
        await new Promise(r=>setTimeout(r,200));
        document.querySelector('.work-panel-launcher-row[data-tool="btnTerminal"]')?.click();
      }
      return { xterm: !!document.querySelector('.term-host .xterm'),
        composer: !!document.querySelector('.term-input'),
        title: document.querySelector('.rp-head-title')?.textContent };
    })()`);
    check('the real xterm surface mounts without the removed command composer', () => {
      assert.equal(mounted.xterm, true);
      assert.equal(mounted.composer, false);
      assert.equal(mounted.title, '终端');
    });

    const started = await cdp.evaluate("(async()=>{const api=await import('/api.js');const s=await api.startTerminal({cols:100,rows:30});if(!s.ok)throw new Error(JSON.stringify(s));window.__terminalApi=api;window.__terminalId=s.session.id;return s.session;})()");
    terminalId = started.id;
    check('the packaged Electron app spawns a real PowerShell ConPTY', () => {
      assert.equal(started.shell, 'PowerShell');
      assert.equal(started.state, 'running');
      /* The xterm surface may already own a session sized to the panel; the
       * API start reuses it instead of spawning a second shell. */
      assert.ok(started.cols > 0 && started.rows > 0, 'missing size');
    });

    /* Follow our own cursor instead of re-reading the whole scrollback. A
     * full-buffer read makes a prompt that predates the command match
     * immediately, so "wait for PowerShell to regain the foreground" could
     * return before Ctrl+C was even processed. */
    let readCursor = 0;
    const readNew = async () => {
      const result = await cdp.evaluate(`(async()=>{const r=await window.__terminalApi.readTerminal(window.__terminalId,${readCursor});return {ok:r.ok,text:r.text||'',state:r.state,truncated:r.truncated,cursor:r.cursor};})()`);
      if (!result?.ok) throw new Error('terminal read failed');
      if (Number.isSafeInteger(result.cursor) && result.cursor >= 0) readCursor = result.cursor;
      return result;
    };
    const readUntil = async (pattern, timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      let text = '';
      while (Date.now() < deadline) {
        const chunk = await readNew();
        text += chunk.text || '';
        if (pattern.test(text)) return { matched: true, text };
        if (chunk.state !== 'running') break;
        await sleep(120);
      }
      return { matched: false, text };
    };
    const write = async (value) => {
      const result = await cdp.evaluate(`(async()=>window.__terminalApi.writeTerminal(window.__terminalId,${JSON.stringify(value)}))()`);
      if (!result?.ok) throw new Error('terminal write failed: ' + JSON.stringify(result));
      await sleep(60);
    };

    const prompt = await readUntil(/PS [^>]*>/);
    check('PowerShell produces an interactive prompt', () => assert.equal(prompt.matched, true, prompt.text.slice(-300)));

    const shellLine = await (async () => {
      await write("Write-Output ('SHELLPID=' + $PID)\r");
      const result = await readUntil(/SHELLPID=\d+/);
      const match = result.text.match(/SHELLPID=(\d+)/);
      return { matched: result.matched, match };
    })();
    if (shellLine.match) {
      shellPid = Number(shellLine.match[1]);
      shellIdentity = processIdentity(shellPid);
    }
    check('the PTY shell PID is observable', () => assert.ok(shellPid > 0 && shellIdentity, shellLine.match ? '' : 'no SHELLPID'));

    const panel = await (async () => {
      await write("Write-Output ('PANEL_' + 'SENTINEL')\r");
      const before = await readUntil(/PANEL_SENTINEL/);
      await cdp.evaluate("document.getElementById('workPanelClose')?.click()");
      await sleep(800);
      const closed = await cdp.evaluate("!!document.querySelector('.term-host .xterm')");
      const backend = await cdp.evaluate("(async()=>{const r=await window.__terminalApi.readTerminal(window.__terminalId,0);return {state:r.state,text:r.text||''};})()");
      await cdp.evaluate("document.getElementById('btnTerminal')?.click()");
      let mountedAgain = false;
      let rows = false;
      for (let i = 0; i < 60; i++) {
        await sleep(200);
        mountedAgain = await cdp.evaluate("!!document.querySelector('.term-host .xterm')");
        if (!mountedAgain) continue;
        rows = await cdp.evaluate("(document.querySelector('.xterm-rows')?.textContent||'').includes('PANEL_SENTINEL')");
        if (rows) break;
      }
      return {
        before: before.matched,
        closed,
        state: backend.state,
        buffer: backend.text.includes('PANEL_SENTINEL'),
        mountedAgain,
        rows,
      };
    })();
    check('closing the surface keeps the PTY alive and reopening replays its buffer', () => {
      assert.deepEqual(panel, {
        before: true, closed: false, state: 'running', buffer: true, mountedAgain: true, rows: true,
      });
    });

    const nodeVersion = await (async () => {
      await cdp.evaluate("(()=>{const t=document.querySelector('.xterm-helper-textarea');if(!t)return false;t.focus();return document.activeElement===t;})()");
      await cdp.send('Input.insertText', { text: 'node -v' });
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      }
      return readUntil(/v\d+\.\d+\.\d+/);
    })();
    check('keyboard bytes reach a real Node.js process through xterm', () => assert.equal(nodeVersion.matched, true, nodeVersion.text.slice(-200)));

    const repl = await (async () => {
      await write('node\r');
      const ready = await readUntil(/Welcome to Node\.js/);
      await write('1+1\r');
      const calc = await readUntil(/(?:^|\r?\n)2\s*(?:\x1b\[[^\n]*)?\r?\n/);
      await write('.exit\r');
      /* Wait for PowerShell itself to regain the foreground before asking it
       * to run the marker; a 60ms write can otherwise reach the exiting Node
       * process and be lost. */
      const promptBack = await readUntil(/PS [^>]*>/);
      await write("Write-Output ('REPL_' + 'EXIT_OK')\r");
      const back = await readUntil(/REPL_EXIT_OK/);
      return { ready: ready.matched, calc: calc.matched, prompt: promptBack.matched, back: back.matched };
    })();
    check('Node.js REPL starts, evaluates, and exits', () => assert.deepEqual(
      repl, { ready: true, calc: true, prompt: true, back: true }
    ));

    const interrupted = await (async () => {
      await write('node -e "setInterval(function(){},1000)"\r');
      await sleep(1200);
      await write('\x03');
      /* The marker is executed by PowerShell only after Ctrl+C has taken the
       * foreground away from the endless Node process. Wait for PowerShell to
       * print its prompt first; writing too early sends the marker to Node. */
      const promptBack = await readUntil(/PS [^>]*>/);
      if (!promptBack.matched) return promptBack;
      await write("Write-Output ('INTERRUPT_' + 'OK')\r");
      return readUntil(/INTERRUPT_OK/);
    })();
    check('Ctrl+C interrupts the foreground Node.js process', () => assert.equal(
      interrupted.matched, true, interrupted.text.slice(-200)
    ));

    const ansi = await (async () => {
      /* Markers are built with String.fromCharCode so the echoed command line
       * never contains the word we search for on the rendered screen. */
      await write("node -e \"process.stdout.write('\\x1b[31m'+String.fromCharCode(67,79,76,79,82,95,82,69,68)+'\\x1b[0m\\r\\n')\"\r");
      const seen = await readUntil(/COLOR_RED/);
      await sleep(300);
      const rendered = await cdp.evaluate(`(()=>{
        const rows=document.querySelector('.xterm-rows');
        if(!rows)return {text:false,color:null};
        const hit=[...rows.querySelectorAll('span')].find(s=>s.textContent.includes(String.fromCharCode(67,79,76,79,82,95,82,69,68)));
        return {text:rows.textContent.includes(String.fromCharCode(67,79,76,79,82,95,82,69,68)),color:hit?getComputedStyle(hit).color:null};
      })()`);
      return { seen: seen.matched, ...rendered };
    })();
    check('ANSI colors render in the real xterm', () => {
      assert.equal(ansi.seen, true, JSON.stringify(ansi));
      assert.equal(ansi.text, true, JSON.stringify(ansi));
      assert.match(String(ansi.color), /^rgb/, JSON.stringify(ansi));
    });

    const cursor = await (async () => {
      await write("node -e \"process.stdout.write('\\x1b[10;5H'+String.fromCharCode(67,85,82,83,79,82,95,80,79,83));setTimeout(function(){},900)\"\r");
      const seen = await readUntil(/CURSOR_POS/);
      return {
        seen: seen.matched,
        ...(await cdp.evaluate(`(()=>{
          const marker=String.fromCharCode(67,85,82,83,79,82,95,80,79,83);
          const rows=[...document.querySelectorAll('.xterm-rows > div')];
          const idx=rows.findIndex(r=>r.textContent.includes(marker));
          return {idx,row:idx>=0?rows[idx].textContent:''};
        })()`)),
      };
    })();
    check('cursor addressing places output on the requested row', () => {
      assert.equal(cursor.seen, true);
      assert.equal(cursor.idx, 9, JSON.stringify(cursor));
      const normalized = String(cursor.row).replace(/\u00a0/g, ' ');
      assert.equal(normalized.indexOf('CURSOR_POS'), 4, JSON.stringify(cursor.row));
    });

    const alt = await (async () => {
      await write("Write-Output ('NORMAL_' + 'MARK')\r");
      await readUntil(/NORMAL_MARK/);
      await write("node -e \"process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[H'+String.fromCharCode(65,76,84,95,83,67,82,69,69,78));setTimeout(function(){process.stdout.write('\\x1b[?1049l'+String.fromCharCode(78,79,82,77,65,76,95,66,65,67,75))},1200)\"\r");
      const altSeen = await readUntil(/ALT_SCREEN/);
      const during = await cdp.evaluate(`(()=>{
        const text=document.querySelector('.xterm-rows')?.textContent||'';
        return {shown:text.includes('ALT_SCREEN'),normal:text.includes('NORMAL_MARK')};
      })()`);
      const backSeen = await readUntil(/NORMAL_BACK/, 8000);
      await sleep(300);
      await write("Write-Output ('ALT_' + 'EXIT_OK')\r");
      await readUntil(/ALT_EXIT_OK/, 8000);
      const after = await cdp.evaluate(`(()=>{
        const text=document.querySelector('.xterm-rows')?.textContent||'';
        return {alt:text.includes('ALT_SCREEN'),normal:text.includes('NORMAL_BACK')};
      })()`);
      return { altSeen: altSeen.matched, during, backSeen: backSeen.matched, after };
    })();
    check('xterm handles alternate-screen output and restores the normal screen', () => {
      assert.deepEqual(alt, {
        altSeen: true,
        during: { shown: true, normal: false },
        backSeen: true,
        after: { alt: false, normal: true },
      });
    });

    const resized = await (async () => {
      const result = await cdp.evaluate("(async()=>window.__terminalApi.resizeTerminal(window.__terminalId,100,30))()");
      if (!result?.ok) return { resize: false, result };
      await sleep(300);
      await write('$w=$Host.UI.RawUI.WindowSize; "$($w.Width)x$($w.Height)"\r');
      const out = await readUntil(/100x30/);
      return { resize: true, matched: out.matched };
    })();
    check('resize reaches the real ConPTY', () => assert.deepEqual(resized, { resize: true, matched: true }));

    marker = `PI_GUI_ELECTRON_${process.pid}_${Date.now()}`;
    const tree = await (async () => {
      const command = `$p = Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' -ArgumentList '-e','setTimeout(()=>{},60000)','${marker}' -PassThru -WindowStyle Hidden; Write-Output ('TREEPID=' + $p.Id)\r`;
      await write(command);
      const result = await readUntil(/TREEPID=\d+/);
      const match = result.text.match(/TREEPID=(\d+)/);
      return { matched: result.matched, match };
    })();
    if (tree.match) markerChild = Number(tree.match[1]);
    check('a unique child process is running inside the PTY tree', () => {
      assert.ok(markerChild > 0, 'TREEPID missing');
      assert.ok(markerPids(marker).includes(markerChild), 'marker child not found by command-line identity');
    });

    console.log('  ..  closing the Electron app');
    const versionInfo = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
    const browser = await connect(versionInfo.webSocketDebuggerUrl);
    /* Browser.close tears down the target it was sent on; the reply may never
     * arrive, so do not let the acceptance hang on it. */
    await Promise.race([browser.send('Browser.close').catch(() => {}), sleep(3000)]);
    browser.ws.close();
    console.log('  ..  waiting for the app process to exit');
    for (let i = 0; i < 120 && !appExited; i++) await sleep(250);
    console.log('  ..  app exited:', appExited);
    check('the Electron app exits normally', () => assert.equal(appExited, true));

    let markerLeft = markerPids(marker);
    for (let i = 0; i < 60 && markerLeft.length; i++) {
      await sleep(250);
      markerLeft = markerPids(marker);
    }
    check('closing the app removes the PTY tree and its Node child', () => assert.deepEqual(markerLeft, []));

    const shellExit = shellPid
      ? await waitForIdentityChange(shellPid, shellIdentity)
      : { gone: '', error: null };
    check('the PowerShell shell is gone after app exit (identity, not bare PID)', () => {
      /* A reused PID has a different creation time/command line; compare the
       * full identity captured before shutdown. A failed query is not proof
       * the process is gone, so it fails this check instead of passing it. */
      assert.equal(shellExit.error, null, `could not verify shell exit: ${shellExit.error?.message || 'unknown error'}`);
      assert.notEqual(shellExit.gone, shellIdentity);
      assert.ok(!shellExit.gone || !shellExit.gone.startsWith(shellIdentity), 'shell identity survived');
    });

    const log = fs.readFileSync(logPath, 'utf8');
    check('no ConPTY helper crash stack in the Electron log', () => {
      assert.ok(!/AttachConsole failed|conpty_console_list_agent\.js.*Error/i.test(log), 'ConPTY helper crash trace found');
    });

    if (failed) {
      console.error('\nFailure details:');
      for (const failure of failures) console.error(`- ${failure.name}: ${failure.error}`);
      const tail = scrub(log.split(/\r?\n/).slice(-80).join('\n'));
      console.error('\nLast Electron log lines:\n' + tail);
    }
    console.log(`\nElectron terminal acceptance: ${passed}/${passed + failed}`);
    console.log(`RESULT ${failed ? 'FAIL' : 'PASS'} (${passed}/${passed + failed})`);
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error('ACCEPTANCE ERROR:', error);
    if (fs.existsSync(logPath)) {
      const tail = scrub(fs.readFileSync(logPath, 'utf8').split(/\r?\n/).slice(-80).join('\n'));
      console.error('\nLast Electron log lines:\n' + tail);
    }
    process.exitCode = 1;
  } finally {
    try { cdp?.ws.close(); } catch { /* noop */ }
    try { if (marker) killMarker(marker); } catch { /* best effort */ }
    if (app && !appExited) {
      try { execFileSync(TASKKILL, ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 }); } catch { /* already gone */ }
    }
    rmrf(temp);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
