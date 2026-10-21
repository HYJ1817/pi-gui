/* Real Electron proof for the read-only Specs surface. No Pi/model/user project
 * is used: the backend is started with a nonexistent PI_BIN and a TEMP project. */
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.T1_SPECS_EVIDENCE_DIR || path.join(ROOT, 'docs', 'evidence', 't1-specs'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
const check = (name, value) => {
  assert.ok(value, name);
  checks++;
  console.log('  ok  ' + name);
};

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitUp(base, child) {
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(base + '/api/health');
      const body = await response.json();
      if (body?.app === 'pi-gui') return;
    } catch { /* server still starting */ }
    if (child.exitCode !== null) throw new Error('backend exited before health check');
    await sleep(100);
  }
  throw new Error('backend health timeout');
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

(async () => {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-specs-electron-'));
  const project = path.join(world, 'Spec Worktree');
  const data = path.join(world, 'data');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  write(project, 'SPEC.md', '# Product Spec\n\n## Purpose\n\nA real Electron fixture for Specs.\n\n[Open the delivery guide](specs/guide.md).\n');
  write(project, 'specs/guide.md', '# Delivery Guide\n\n## Steps\n\n[Configure](setup.md#configure) the fixture.\n\n[Outside](../outside.md)\n');
  write(project, 'specs/setup.md', '# Setup\n\n## Configure\n\nRead the heading anchor proof.\n\n[Back to SPEC](../SPEC.md)\n');
  fs.mkdirSync(OUT, { recursive: true });
  const fakePiScript = path.join(world, 'fake-pi.cjs');
  fs.writeFileSync(fakePiScript, [
    'const parentPid = process.ppid;',
    'let input = ""; process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", chunk => { input += chunk; let i; while ((i = input.indexOf("\\n")) >= 0) { const line = input.slice(0, i); input = input.slice(i + 1); try { const cmd = JSON.parse(line); process.stdout.write(JSON.stringify({ type: "response", command: cmd.type, id: cmd.id, success: true, data: { sessionId: "specs-electron-fixture", sessionName: "Specs Electron Fixture", messages: [], models: [], thinkingLevels: [] } }) + "\\n"); } catch {} } });',
    'setInterval(() => { try { process.kill(parentPid, 0); } catch { process.exit(0); } }, 400);',
  ].join('\n'), 'utf8');
  const fakePi = path.join(world, 'fake-pi.cmd');
  fs.writeFileSync(fakePi, '@echo off\r\n"%FAKE_PI_NODE%" "%~dp0fake-pi.cjs" %*\r\n', 'utf8');

  app.setPath('userData', world);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(port),
    PI_CWD: project,
    PI_GUI_DATA: data,
    PI_GUI_OPEN: '0',
    PI_GUI_OFFLINE: '1',
    PI_OFFLINE: '1',
    PI_BIN: fakePi,
    FAKE_PI_NODE: process.execPath,
    PI_CODING_AGENT_DIR: path.join(world, 'agent'),
    TEMP: world,
    TMP: world,
    TMPDIR: world,
  };
  const backend = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let backendOutput = '';
  backend.stdout.on('data', (chunk) => { backendOutput += chunk; });
  backend.stderr.on('data', (chunk) => { backendOutput += chunk; });

  let win;
  try {
    await waitUp(base, backend);
    await app.whenReady();
    win = new BrowserWindow({
      show: true,
      useContentSize: true,
      autoHideMenuBar: true,
      width: 1200,
      height: 850,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const rendererErrors = [];
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') rendererErrors.push(event.message);
    });
    await win.loadURL(base + '/');
    const read = (code) => win.webContents.executeJavaScript(code, true);
    const until = async (code, label = 'Electron UI state') => {
      for (let i = 0; i < 240; i++) {
        if (await read(code)) return;
        await sleep(50);
      }
      throw new Error(label + ' timeout');
    };
    const shot = async (name) => {
      const file = path.join(OUT, name + '.png');
      fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
      return file;
    };

    await until("document.querySelector('#btnSpecs') && !document.querySelector('#projects').textContent.includes('加载中')");
    await until("document.querySelector('#connText').textContent.includes('已连接')", 'Pi fixture ready');
    await read("document.querySelector('#btnSpecs').click()");
    await until("document.querySelector('#rightPane').dataset.surface==='specs' && document.querySelector('[data-spec-path=\"SPEC.md\"]')");
    check('production Electron entry opens Specs in the existing right pane', await read(
      "document.querySelector('#btnSpecs').getAttribute('aria-pressed')==='true'"
    ));
    check('document tree and selected SPEC.md render in real Chromium', await read(
      "document.querySelector('[data-spec-path=\"SPEC.md\"]').getAttribute('aria-current')==='page' && document.querySelector('.specs-markdown').textContent.includes('Product Spec')"
    ));

    await read("document.querySelector('[data-spec-path=\"specs/guide.md\"]').click()");
    await until("document.querySelector('.specs-doc-path')?.textContent==='specs/guide.md'");
    await read("document.querySelector('.specs-markdown a[href=\"setup.md#configure\"]').click()");
    await until("document.querySelector('.specs-doc-path')?.textContent==='specs/setup.md' && document.querySelector('.specs-markdown #configure')");
    check('relative Markdown link and heading anchor work across documents', await read(
      "document.querySelector('.specs-markdown').textContent.includes('Configure')"
    ));
    const populated = await shot('specs-populated-1200');
    check('populated evidence screenshot exists', fs.statSync(populated).size > 0);

    await read("document.querySelector('.specs-markdown a[href=\"../SPEC.md\"]').click()");
    await until("document.querySelector('.specs-doc-path')?.textContent==='SPEC.md'");
    await read("document.querySelector('.specs-markdown a[href=\"specs/guide.md\"]').click()");
    await until("document.querySelector('.specs-doc-path')?.textContent==='specs/guide.md'");
    await read("document.querySelector('.specs-markdown a[href=\"../outside.md\"]').click()");
    await until("document.querySelector('.specs-doc-notice')?.textContent.includes('仅支持')");
    check('a non-indexed relative path is blocked without a filesystem request', await read(
      "document.querySelector('.specs-doc-path').textContent==='specs/guide.md'"
    ));

    win.setContentSize(720, 850);
    await sleep(250);
    check('narrow Electron window keeps Specs inside the viewport', await read(
      "(()=>{const r=document.querySelector('#rightPane').getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&r.width>=300})()"
    ));
    const narrow = await shot('specs-narrow-720');
    check('narrow evidence screenshot exists', fs.statSync(narrow).size > 0);

    win.setContentSize(1200, 850);
    fs.rmSync(path.join(project, 'SPEC.md'), { force: true });
    fs.rmSync(path.join(project, 'specs'), { recursive: true, force: true });
    await read("document.querySelector('.rp-head-actions button').click()");
    await until("document.querySelector('.specs-empty')?.textContent.includes('没有 Specs')");
    check('removing all Specs files degrades to the compact empty state', await read(
      "document.querySelectorAll('[data-spec-path]').length===0 && document.querySelector('#rightPane').dataset.surface==='specs'"
    ));
    const empty = await shot('specs-empty-1200');
    check('empty evidence screenshot exists', fs.statSync(empty).size > 0);
    check('real Electron renderer has no error-level console entries', rendererErrors.length === 0);
    console.log(`Specs Electron: ${checks}/${checks}; screenshots=${OUT}`);
  } catch (error) {
    console.error('Specs Electron failed: ' + error.message);
    if (win && !win.isDestroyed()) {
      try { fs.writeFileSync(path.join(OUT, 'failure.png'), (await win.webContents.capturePage()).toPNG()); } catch {}
    }
    if (backendOutput) console.error(backendOutput.slice(-4000));
    process.exitCode = 1;
  } finally {
    win?.destroy();
    try { backend.kill(); } catch {}
    try { fs.rmSync(world, { recursive: true, force: true }); } catch {}
    app.exit(process.exitCode || 0);
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
