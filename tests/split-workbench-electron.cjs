/* Real Electron proof for the optional Specs + Changes workbench.
 * The data lives in a temporary Git repository; no user project or real Pi is used. */
const { app, BrowserWindow } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.T2A_EVIDENCE_DIR || path.join(ROOT, 'docs', 'evidence', 't2-a-split-workbench'));
const FORCED_SCALE = Number(process.env.T2A_FORCE_DEVICE_SCALE_FACTOR || 0);
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
  for (let i = 0; i < 150; i++) {
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
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-t2a-electron-'));
  const project = path.join(world, 'Split Workbench');
  const data = path.join(world, 'data');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  write(project, 'SPEC.md', '# Split Workbench\n\n## Purpose\n\nReal Electron proof for Specs plus Changes.\n\n[Delivery](specs/delivery.md)\n');
  write(project, 'specs/delivery.md', '# Delivery\n\n## Checks\n\nKeep the selected document while inspecting a diff.\n');
  write(project, 'src/example.js', 'export const value = 1;\n');
  const git = (...args) => execFileSync('git', args, {
    cwd: project,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(world, 'gitconfig'), GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  git('init', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.');
  git('commit', '-m', 'fixture baseline');
  write(project, 'src/example.js', 'export const value = 2;\nexport const added = true;\n');
  const worktreeB = path.join(world, 'Worktree B');
  git('worktree', 'add', '-b', 'fixture/t2a-b', worktreeB);
  write(worktreeB, 'SPEC.md', '# Worktree B\n\nOnly workspace B documents.\n');
  write(worktreeB, 'src/B.js', 'export const onlyB = true;\n');

  fs.mkdirSync(OUT, { recursive: true });
  const fakePiScript = path.join(world, 'fake-pi.cjs');
  fs.writeFileSync(fakePiScript, [
    'const parentPid = process.ppid;',
    'let input = ""; process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", chunk => { input += chunk; let i; while ((i = input.indexOf("\\n")) >= 0) { const line = input.slice(0, i); input = input.slice(i + 1); try { const cmd = JSON.parse(line); process.stdout.write(JSON.stringify({ type: "response", command: cmd.type, id: cmd.id, success: true, data: { sessionId: "t2a-electron-fixture", sessionName: "T2-A Electron Fixture", messages: [], models: [], thinkingLevels: [] } }) + "\\n"); } catch {} } });',
    'setInterval(() => { try { process.kill(parentPid, 0); } catch { process.exit(0); } }, 400);',
  ].join('\n'), 'utf8');
  const fakePi = path.join(world, 'fake-pi.cmd');
  fs.writeFileSync(fakePi, '@echo off\r\n"%FAKE_PI_NODE%" "%~dp0fake-pi.cjs" %*\r\n', 'utf8');

  if (Number.isFinite(FORCED_SCALE) && FORCED_SCALE > 0) {
    app.commandLine.appendSwitch('force-device-scale-factor', String(FORCED_SCALE));
  }
  app.setPath('userData', world);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const backend = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
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
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let backendOutput = '';
  backend.stdout.on('data', (chunk) => { backendOutput += chunk; });
  backend.stderr.on('data', (chunk) => { backendOutput += chunk; });

  let win;
  const screenshots = [];
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
      if (event.level === 'error' && !String(event.message).includes('Electron Security Warning')) rendererErrors.push(event.message);
    });
    await win.loadURL(base + '/');
    const read = (code) => win.webContents.executeJavaScript(code, true);
    const until = async (code, label = 'Electron UI state') => {
      for (let i = 0; i < 260; i++) {
        if (await read(code)) return;
        await sleep(50);
      }
      throw new Error(label + ' timeout');
    };
    const shot = async (name) => {
      await sleep(180);
      const file = path.join(OUT, name + '.png');
      fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
      screenshots.push(name + '.png');
      check(name + ' screenshot exists', fs.statSync(file).size > 0);
      return file;
    };
    const layout = () => read(`(()=>{
      const pane=document.querySelector('#rightPane'), host=document.querySelector('.workbench-split');
      const top=document.querySelector('#workbenchSpecsPane'), bottom=document.querySelector('#workbenchChangesPane');
      const splitter=document.querySelector('.workbench-splitter');
      const r=pane.getBoundingClientRect(), t=top?.getBoundingClientRect(), b=bottom?.getBoundingClientRect(), s=splitter?.getBoundingClientRect();
      return {
        surface:pane.dataset.surface||null, mode:host?.dataset.workbenchMode||null,
        pane:{left:r.left,right:r.right,width:r.width,height:r.height},
        top:t?{top:t.top,height:t.height}:null,bottom:b?{top:b.top,height:b.height}:null,
        splitter:s?{top:s.top,height:s.height}:null,
        overflow:document.documentElement.scrollWidth>innerWidth+1,
        inner:[innerWidth,innerHeight]
      };
    })()`);
    await win.webContents.debugger.attach('1.3');
    const key = async name => {
      for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type, key:name});
    };
    const pointer = (type, x, y, clickCount=1) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type,x,y,button:'left',clickCount});

    await until("document.querySelector('#btnSpecs') && !document.querySelector('#projects').textContent.includes('加载中')");
    await until("document.querySelector('#connText').textContent.includes('已连接')", 'Pi fixture ready');
    await read("document.querySelector('#btnSpecs').click()");
    await until("document.querySelector('#rightPane').dataset.surface==='specs' && document.querySelector('[data-spec-path=\"SPEC.md\"]')");
    await shot('01-single-panel-specs');

    await read("document.querySelector('#btnSpecsSplit').click()");
    await until("document.querySelector('#rightPane').dataset.surface==='workbench-split' && document.querySelector('[data-spec-path=\"SPEC.md\"]') && document.querySelector('.chg-row')");
    let facts = await layout();
    check('real production entry opens the split workbench with both children', facts.surface === 'workbench-split' && facts.top && facts.bottom && facts.splitter);
    check('both panes have usable heights and no horizontal overflow', facts.top.height >= 220 - 1 && facts.bottom.height >= 220 - 1 && !facts.overflow, facts);
    check('Changes reflects the temporary Git worktree file count', await read("document.querySelectorAll('.chg-row').length===1 && document.querySelector('.chg-path').textContent==='src/example.js'"));

    await sleep(900);
    await read("document.querySelector('.chg-main').click()");
    await until("document.querySelector('.chg-diff') && !document.querySelector('.chg-diff').hidden && document.querySelector('.chg-diff').textContent.includes('added = true')");
    await read("document.querySelector('[data-spec-path=\"specs/delivery.md\"]').click()");
    await until("document.querySelector('.specs-doc-path')?.textContent==='specs/delivery.md'");
    check('document selection and expanded diff remain independent', await read(
      "!document.querySelector('.chg-diff').hidden && document.querySelector('.specs-doc-path').textContent==='specs/delivery.md'"
    ));

    for (const width of [1536, 1200, 900, 720]) {
      win.setContentSize(width, 850);
      await sleep(260);
      facts = await layout();
      check(`${width}px uses a readable layout without horizontal overflow`, !facts.overflow && (width < 900
        ? facts.mode === 'fallback' && await read("document.querySelector('#workbenchChangesPane').hidden")
        : facts.mode === 'split' && facts.top.height >= 220 - 1 && facts.bottom.height >= 220 - 1), facts);
      await shot(`02-split-${width}`);
    }

    win.setContentSize(1200, 850);
    await sleep(220);
    await read("document.querySelector('#rightPaneResizer').focus()");
    await key('End');
    await sleep(180);
    check('wide Specs preserves the existing two-column full-height document layout', await read("(()=>{const a=document.querySelector('.specs-layout').getBoundingClientRect();const d=document.querySelector('.specs-doc-pane').getBoundingClientRect();return a.width>=560 && d.height>=a.height-1})()"));
    await shot('10-wide-specs');
    await read("document.querySelector('#rightPaneResizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await sleep(180);
    const splitterRect = await read(`(()=>{const r=document.querySelector('.workbench-splitter').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await pointer('mousePressed', splitterRect.x, splitterRect.y);
    await pointer('mouseMoved', splitterRect.x, splitterRect.y + 82);
    await pointer('mouseReleased', splitterRect.x, splitterRect.y + 82);
    await sleep(180);
    check('mouse drag persists a new split ratio', await read(
      "JSON.parse(localStorage.getItem('pi-gui.workbench.split.v1')||'{}').ratio>0.56"
    ));
    const adjusted = await read("(()=>{const r=document.querySelector('.workbench-splitter').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await pointer('mousePressed', adjusted.x, adjusted.y, 2);
    await pointer('mouseReleased', adjusted.x, adjusted.y, 2);
    check('double-click restores the default ratio', await read(
      "Math.abs(JSON.parse(localStorage.getItem('pi-gui.workbench.split.v1')||'{}').ratio-0.56)<0.0001"
    ));
    await read("document.querySelector('.workbench-splitter').focus()");
    await key('ArrowUp');
    check('trusted keyboard resizes the split', await read("JSON.parse(localStorage.getItem('pi-gui.workbench.split.v1')).ratio<0.56"));

    win.setContentSize(1200, 330);
    await sleep(260);
    facts = await layout();
    check('short window falls back to one visible panel', facts.mode === 'fallback' && await read(
      "!document.querySelector('.workbench-modebar').hidden && document.querySelector('#workbenchChangesPane').hidden"
    ), facts);
    await shot('03-short-window-fallback');
    await read("document.querySelector('[data-workbench-tab=\"changes\"]').click()");
    await read("document.querySelector('[data-workbench-tab=\"changes\"]').focus()");
    await shot('04-short-window-changes-tab');
    check('fallback tab shows the preserved Changes instance', await read(
      "!document.querySelector('#workbenchChangesPane').hidden && document.querySelector('.chg-diff') && !document.querySelector('.chg-diff').hidden"
    ));

    win.setContentSize(1200, 850);
    await sleep(260);
    check('growing back transfers focus to the visible splitter', await read("document.activeElement===document.querySelector('.workbench-splitter')"));
    win.webContents.setZoomFactor(1.25);
    await sleep(260);
    facts = await layout();
    check('125% app zoom keeps both panes inside the viewport', facts.mode === 'split' && !facts.overflow, facts);
    await shot('05-split-zoom-125');
    win.webContents.setZoomFactor(1);
    await sleep(180);

    const activate = async target => {
      const encoded = JSON.stringify(target);
      await read(`(async()=>{const a=await import('/api.js');const p=await import('/projects.js');await a.createProject(${encoded},'T2-A fixture');await p.activateProject(${encoded},'T2-A fixture');})()`);
    };
    await read("document.querySelector('#input').value='T2-A draft retained'");
    await activate(worktreeB);
    await until("document.querySelector('.specs-markdown')?.textContent.includes('Worktree B') && document.querySelector('.chg-body')?.textContent.includes('src/B.js')");
    check('real project activation switches both Specs and Changes to Worktree B', await read("!document.querySelector('.chg-body').textContent.includes('src/example.js') && !document.querySelector('.specs-markdown').textContent.includes('Split Workbench')"));
    await shot('08-worktree-b');
    await activate(project);
    await until("document.querySelector('.specs-markdown')?.textContent.includes('Split Workbench') && document.querySelector('.chg-body')?.textContent.includes('src/example.js')");
    check('returning to Worktree A removes B documents and changes', await read("!document.querySelector('.chg-body').textContent.includes('src/B.js') && !document.querySelector('.specs-markdown').textContent.includes('Worktree B')"));
    await shot('09-worktree-a-return');

    await read("document.querySelector('.workbench-pane-specs .workbench-exit').click()");
    await until("document.querySelector('#rightPane').dataset.surface==='specs' && !document.querySelector('.workbench-split')");
    await until("document.querySelector('.specs-markdown') && document.querySelector('#btnSpecsSplit')");
    check('exiting split restores the single Specs panel', await read(
      "document.querySelector('.specs-markdown') && document.querySelector('#btnSpecsSplit')"
    ));
    await shot('06-single-panel-restored');
    check('real Electron renderer has no error-level console entries', rendererErrors.length === 0, rendererErrors.slice(0, 5));
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      forcedDeviceScaleFactor: FORCED_SCALE || null,
      checks,
      failed: 0,
      screenshots,
      fixture: 'temporary Git repository; no real Pi or user project',
    }, null, 2));
    console.log(`Split workbench Electron: ${checks}/${checks}; screenshots=${OUT}`);
  } catch (error) {
    console.error('Split workbench Electron failed: ' + error.message);
    try {
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, 'failure-results.json'), JSON.stringify({
        generatedAt: new Date().toISOString(),
        error: String(error?.stack || error),
        checks,
        screenshots,
      }, null, 2));
    } catch {}
    if (win && !win.isDestroyed()) {
      try { fs.writeFileSync(path.join(OUT, 'failure.png'), (await win.webContents.capturePage()).toPNG()); } catch {}
    }
    if (backendOutput) console.error(backendOutput.slice(-5000));
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
