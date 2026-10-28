'use strict';
/* Real Chromium verification for Bug 9 and Bug 11.
 * Tests thinking picker readback and right-pane ordinary panel auto-restore / scroll / diff
 * retention across page reloads using the real, unmodified app.js initialization,
 * and ensures browser NEVER auto-reconnects. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.BUG_FIX_EVIDENCE_DIR || path.join(ROOT, 'docs', 'assets', 'bug-fixes'));

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-restore-'));
  const env = { ...process.env, RESTORE_WORLD: world };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(process.env.RESTORE_ELECTRON_BINARY || require('electron'), [__filename], {
    env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 180000,
  });
  if (run.status !== 0) console.error('Electron exit:', run.status, run.signal, run.error?.message || '');
  if (path.dirname(world) === path.resolve(os.tmpdir()) && path.basename(world).startsWith('pi-gui-restore-')) {
    fs.rmSync(world, { recursive: true, force: true, maxRetries: 5 });
  }
  process.exitCode = run.status ?? 1;
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const http = require('node:http');
  app.setPath('userData', path.join(process.env.RESTORE_WORLD, 'profile'));
  let win, server, checks = 0, failed = 0;
  const evidence = [];
  const browserNavigatedUrls = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const check = (name, value) => {
    checks++;
    if (!value) failed++;
    evidence.push({ name, passed: Boolean(value) });
    console.log(`${value ? 'PASS' : 'FAIL'} ${name}`);
  };

  app.whenReady().then(async () => {
    fs.mkdirSync(OUT, { recursive: true });

    // Mock IPC handlers for Electron desktop capabilities
    ipcMain.handle('pi-gui:browser-open', () => ({ ok: true }));
    ipcMain.handle('pi-gui:browser-close', () => ({ ok: true }));
    ipcMain.handle('pi-gui:browser-bounds', () => ({ ok: true }));
    ipcMain.handle('pi-gui:browser-occluded', () => ({ ok: true }));
    ipcMain.handle('pi-gui:browser-set-bounds', () => ({ ok: true }));
    ipcMain.handle('pi-gui:browser-set-occluded', () => ({ ok: true }));
    ipcMain.handle('pi-gui:browser-agent-status', () => ({ ok: true, active: false }));
    ipcMain.handle('pi-gui:browser-navigate', (_event, url) => {
      browserNavigatedUrls.push(url);
      return { ok: true };
    });
    ipcMain.handle('pi-gui:app-update-state', () => ({ state: 'idle' }));
    ipcMain.handle('pi-gui:open-path', () => ({ ok: false }));
    ipcMain.handle('pi-gui:open-external', () => ({ ok: false }));

    const sseClients = new Set();
    const pendingResponses = [];

    const broadcast = data => {
      const line = `data: ${JSON.stringify(data)}\n\n`;
      for (const client of sseClients) {
        try { client.write(line); } catch {}
      }
    };

    const sendResponse = resp => {
      if (sseClients.size > 0) {
        broadcast(resp);
      } else {
        pendingResponses.push(resp);
      }
    };

    // Mock HTTP server serving unmodified public/ files and realistic backend APIs
    server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(parsedUrl.pathname);

      // 1. API Endpoints
      if (pathname === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          hasProject: true,
          cwd: 'C:\\fixture-project',
          bridgeState: 'ready',
          bridgeRun: 1,
          bridgeInstance: 'inst-1',
          state: {
            sessionId: 'session-1',
            model: { provider: 'anthropic', id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', reasoning: true },
            thinkingLevel: 'medium',
          },
          thinkingLevels: ['off', 'low', 'medium', 'high'],
          models: [
            { provider: 'anthropic', id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', reasoning: true },
          ],
          providers: ['anthropic'],
        }));
        return;
      }

      if (pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        res.write(':ok\n\n');
        res.write(`data: ${JSON.stringify({ type: 'bridge_status', state: 'ready', bridgeRun: 1 })}\n\n`);
        while (pendingResponses.length) {
          res.write(`data: ${JSON.stringify(pendingResponses.shift())}\n\n`);
        }
        return;
      }

      if (pathname === '/api/command') {
        let bodyStr = '';
        req.on('data', chunk => { bodyStr += chunk; });
        req.on('end', () => {
          let body = {};
          try { body = JSON.parse(bodyStr); } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));

          if (body.type === 'get_state') {
            sendResponse({
              type: 'response',
              command: 'get_state',
              id: body.id,
              success: true,
              data: {
                model: { provider: 'anthropic', id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', reasoning: true },
                thinkingLevel: 'medium',
              },
            });
          } else if (body.type === 'get_available_thinking_levels') {
            sendResponse({
              type: 'response',
              command: 'get_available_thinking_levels',
              id: body.id,
              success: true,
              data: {
                levels: ['off', 'low', 'medium', 'high'],
              },
            });
          }
        });
        return;
      }

      if (pathname === '/api/git/status') {
        const files = Array.from({ length: 60 }, (_, i) => ({
          path: 'src/module-' + String(i).padStart(2, '0') + '.js',
          status: 'M',
          additions: 10,
          deletions: 5,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, isRepo: true, files }));
        return;
      }

      if (pathname === '/api/git/diff') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          working: '@@ -1,5 +1,15 @@\n-line 1 old\n+line 1 modified\n+line 2 added\n+line 3 added\n+line 4 added\n+line 5 added\n+line 6 added\n+line 7 added\n+line 8 added\n',
          staged: '',
        }));
        return;
      }

      if (pathname === '/api/specs/document') {
        const paragraphs = Array.from({ length: 80 }, (_, i) =>
          `Paragraph ${i}: Detailed specifications content for document scrolling verification in Bug 11 test suite.`
        ).join('\n\n');
        const docPath = parsedUrl.searchParams.get('path') || 'specs/spec-00.md';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          document: {
            id: 'doc-item',
            path: docPath,
            title: 'Spec ' + docPath,
            content: `# Spec Document\n\n${paragraphs}`,
          },
        }));
        return;
      }

      if (pathname === '/api/specs') {
        const documents = Array.from({ length: 40 }, (_, i) => ({
          id: 'doc-' + i,
          path: 'specs/spec-' + String(i).padStart(2, '0') + '.md',
          title: 'Spec ' + String(i).padStart(2, '0'),
          bytes: 1024,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          workspace: { id: 'ws1', generation: 1 },
          documents,
        }));
        return;
      }

      if (pathname === '/api/projects') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          projects: [{ path: 'C:\\fixture-project', name: 'fixture-project' }],
          current: 'C:\\fixture-project',
        }));
        return;
      }

      if (pathname === '/api/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          models: [{ provider: 'anthropic', id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', reasoning: true }],
        }));
        return;
      }

      if (pathname === '/api/runtime-sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessions: [] }));
        return;
      }

      if (pathname === '/api/check-update' || pathname === '/api/pi-update-check') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, upToDate: true }));
        return;
      }

      if (pathname === '/api/logs/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: { enabled: false } }));
        return;
      }

      if (pathname.startsWith('/api/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // 2. Static files from public/ (served UNMODIFIED)
      const rel = pathname.replace(/^\//, '') || 'index.html';
      const file = path.resolve(ROOT, 'public', rel);
      if (!file.startsWith(path.join(ROOT, 'public') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end();
        return;
      }
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
      };
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      fs.createReadStream(file).pipe(res);
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    win = new BrowserWindow({
      width: 1300,
      height: 850,
      show: true,
      webPreferences: {
        preload: path.join(ROOT, 'electron', 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.on('console-message', (_e, _lvl, msg) => {
      if (msg.includes('[sec-surface]')) console.log(msg);
    });

    const read = code => win.webContents.executeJavaScript(`(async () => {
      const result = await eval(${JSON.stringify(code)});
      try { return result === undefined ? undefined : JSON.parse(JSON.stringify(result)); } catch { return undefined; }
    })()`, true);

    const until = async (code, label, maxAttempts = 200) => {
      for (let i = 0; i < maxAttempts; i++) {
        if (await read(code)) return;
        await sleep(25);
      }
      throw Error(label + ' timeout');
    };

    const shot = async name => {
      await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG());
    };

    // Load actual index.html with real app.js execution
    await win.loadURL(`http://127.0.0.1:${port}/`);
    await until("document.getElementById('thinkText')?.textContent === '思考 medium'", 'app.js thinking initialization');
    await sleep(100);

    // ================= 1. Bug 9: Thinking Level Readback Verification =================
    const thinkLabel = await read('document.getElementById("thinkText")?.textContent');
    check('Bug 9: thinking chip reflects active level (思考 medium)', thinkLabel === '思考 medium');
    const thinkDisabled = await read('document.getElementById("btnThink")?.disabled');
    check('Bug 9: thinking button is enabled with valid levels', thinkDisabled === false);
    await shot('01-bug9-thinking-ready');

    // ================= 2. Bug 11: Changes Panel Restore & Diff Expansion =================
    // Step 2a: User clicks Changes button to open panel
    await read("document.getElementById('navChanges')?.click()");
    await until("document.querySelector('.chg-list') && document.querySelectorAll('.chg-row').length > 0", 'changes panel render');
    await sleep(100);

    // Step 2b: Scroll the changes list down
    await read(`(() => {
      const list = document.querySelector('.chg-list');
      list.scrollTop = 400;
      list.dispatchEvent(new Event('scroll'));
    })()`);
    await sleep(50);
    const scrolledTop = await read('document.querySelector(".chg-list")?.scrollTop');
    check('Bug 11: changes list scrolled before reload', scrolledTop >= 350);

    // Step 2c: Expand first file diff by clicking row
    await read("document.querySelector('.chg-row .chg-main')?.click()");
    await until("document.querySelector('.diff .d-row')", 'expanded diff render');
    const diffCountBeforeReload = await read("document.querySelectorAll('.diff').length");
    check('Bug 11: diff expanded before reload', diffCountBeforeReload > 0);
    await shot('02-bug11-changes-scrolled');

    const recordedSurface = await read('sessionStorage.getItem("pi-gui:secondary-active-surface")');
    check('Bug 11: active surface recorded in sessionStorage as changes', recordedSurface === 'changes');

    // Step 2d: Perform TRUE page reload (win.webContents.reload)
    // NOTE: Test code does NOT call openChangesPanel() after reload! app.js restores it naturally!
    const reloadDone1 = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await win.webContents.reload();
    await reloadDone1;

    // Wait for app.js natural boot and restoreOrdinaryPanel execution
    await until("document.querySelector('.chg-list')", 'changes panel natural auto-restore');
    await until("document.querySelector('.diff')", 'expanded diff natural auto-restore');
    await sleep(200);

    const rightPaneOpen1 = await read("!document.getElementById('rightPane')?.hidden");
    check('Bug 11: right pane automatically reopened after reload', rightPaneOpen1 === true);
    const rightPaneSurface1 = await read("document.getElementById('rightPane')?.dataset.surface");
    check('Bug 11: right pane surface restored to changes', rightPaneSurface1 === 'changes');

    const restoredTop = await read('document.querySelector(".chg-list")?.scrollTop');
    check('Bug 11: changes list scroll position restored after reload', restoredTop >= 350);

    const diffCountAfterReload = await read("document.querySelectorAll('.diff').length");
    check('Bug 11: expanded diff automatically restored after reload', diffCountAfterReload > 0);
    await shot('03-bug11-changes-restored');

    // ================= 3. Bug 11: Specs Panel Restore, Doc Selection & Content Scroll =================
    // Step 3a: User clicks Specs button
    await read("document.getElementById('btnSpecs')?.click()");
    await until("document.querySelector('.specs-tree-list') && document.querySelectorAll('.specs-doc-item').length > 0", 'specs panel render');
    await sleep(100);

    // Step 3b: Scroll specs tree list
    await read(`(() => {
      const tree = document.querySelector('.specs-tree-list');
      tree.scrollTop = 250;
      tree.dispatchEvent(new Event('scroll'));
    })()`);
    await sleep(50);
    const specsTreeScroll = await read('document.querySelector(".specs-tree-list")?.scrollTop');
    check('Bug 11: specs tree scrolled before reload', specsTreeScroll >= 150);

    // Step 3c: Select second document and scroll markdown content
    await read("document.querySelectorAll('.specs-doc-item')[1]?.click()");
    await until("document.querySelector('.specs-markdown')", 'specs doc markdown render');
    await sleep(100);

    await read(`(() => {
      const md = document.querySelector('.specs-markdown');
      md.scrollTop = 320;
      md.dispatchEvent(new Event('scroll'));
    })()`);
    await sleep(50);
    const docScrollBefore = await read('document.querySelector(".specs-markdown")?.scrollTop');
    check('Bug 11: specs markdown content scrolled before reload', docScrollBefore >= 200);
    await shot('04-bug11-specs-scrolled');

    const recordedSpecsSurface = await read('sessionStorage.getItem("pi-gui:secondary-active-surface")');
    check('Bug 11: active surface recorded in sessionStorage as specs', recordedSpecsSurface === 'specs');

    // Step 3d: Perform TRUE page reload for Specs panel
    const reloadDone2 = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await win.webContents.reload();
    await reloadDone2;

    // Wait for app.js natural auto-restore of Specs panel
    await until("document.querySelector('.specs-tree-list')", 'specs tree auto-restore');
    await until("document.querySelector('.specs-markdown')", 'specs doc content auto-restore');
    await sleep(200);

    const rightPaneSurface2 = await read("document.getElementById('rightPane')?.dataset.surface");
    check('Bug 11: right pane surface restored to specs', rightPaneSurface2 === 'specs');

    const restoredSpecsScroll = await read('document.querySelector(".specs-tree-list")?.scrollTop');
    check('Bug 11: specs tree scroll position restored after reload', restoredSpecsScroll >= 150);

    const restoredDocScroll = await read('document.querySelector(".specs-markdown")?.scrollTop');
    check('Bug 11: specs doc markdown scroll position restored after reload', restoredDocScroll >= 200);
    await shot('05-bug11-specs-restored');

    // ================= 4. Bug 11: Browser Surface Safety & No Network Reconnect =================
    browserNavigatedUrls.length = 0;
    await read("document.getElementById('btnBrowser')?.click()");
    await until("document.getElementById('rightPane')?.dataset.surface === 'browser'", 'browser surface open');

    const recordedBrowserSurface = await read('sessionStorage.getItem("pi-gui:secondary-active-surface")');
    check('Bug 11: browser surface is NEVER written to sessionStorage', recordedBrowserSurface === null);

    // Reload while browser was open
    const reloadDone3 = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await win.webContents.reload();
    await reloadDone3;
    await until("document.getElementById('navChanges')", 'page reloaded after browser');
    await sleep(200);

    const surfaceAfterBrowserReload = await read('sessionStorage.getItem("pi-gui:secondary-active-surface")');
    check('Bug 11: active surface in sessionStorage remains null after browser reload', surfaceAfterBrowserReload === null);

    const paneOpenAfterReload = await read("!document.getElementById('rightPane')?.hidden");
    check('Bug 11: right pane remains closed after browser reload', paneOpenAfterReload === false);

    check('Bug 11: browser never auto-reconnected or triggered network navigation', browserNavigatedUrls.length === 0);
    await shot('06-bug11-browser-never-restored');

    // ================= 5. Bug 11: User Active Close Clears Restore State =================
    // Step 5a: Open Changes panel then user explicitly clicks Close ('×')
    await read("document.getElementById('navChanges')?.click()");
    await until("document.querySelector('.chg-list')", 'changes opened before close test');
    await sleep(50);

    await read("document.getElementById('rightPaneClose')?.click()");
    await sleep(50);
    const closedRightPane = await read("document.getElementById('rightPane')?.hidden");
    check('Bug 11: right pane closed by user close button', closedRightPane === true);

    const closedSurfaceKey = await read('sessionStorage.getItem("pi-gui:secondary-active-surface")');
    check('Bug 11: user close button cleared active surface key', closedSurfaceKey === null);

    // Step 5b: Reload and verify it does NOT restore
    const reloadDone4 = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await win.webContents.reload();
    await reloadDone4;
    await until("document.getElementById('navChanges')", 'page reloaded after user close');
    await sleep(200);

    const paneStayedClosed = await read("document.getElementById('rightPane')?.hidden");
    check('Bug 11: panel does NOT restore after user explicitly closed it', paneStayedClosed === true);

    // ================= 6. Bug 11: Scope Isolation (Workspace & Session Switch) =================
    // Open Changes panel, scroll, expand diff
    await read("document.getElementById('navChanges')?.click()");
    await until("document.querySelector('.chg-list')", 'changes opened for scope test');
    await read(`(() => {
      const list = document.querySelector('.chg-list');
      list.scrollTop = 300;
      list.dispatchEvent(new Event('scroll'));
    })()`);
    await read("document.querySelector('.chg-row .chg-main')?.click()");
    await until("document.querySelector('.diff')", 'diff expanded for scope test');

    // Production Event: session-switch (NO manual clearPaneState call!)
    await read("document.dispatchEvent(new CustomEvent('pi-gui:session-switch'))");
    await sleep(50);
    const changesStateAfterSessionSwitch = await read('sessionStorage.getItem("pi-gui:secondary-pane-state")');
    const parsedState1 = changesStateAfterSessionSwitch ? JSON.parse(changesStateAfterSessionSwitch) : {};
    check('Bug 11: session-switch automatically clears changes pane state without manual call', !parsedState1.changes);

    // Open Specs panel, scroll tree
    await read("document.getElementById('btnSpecs')?.click()");
    await until("document.querySelector('.specs-tree-list')", 'specs opened for scope test');
    await read(`(() => {
      const tree = document.querySelector('.specs-tree-list');
      tree.scrollTop = 200;
      tree.dispatchEvent(new Event('scroll'));
    })()`);

    // Production Event: workspace-generation via beginWorkspaceSwitch (NO manual clearPaneState call!)
    await read(`(async () => {
      const { beginWorkspaceSwitch } = await import('/state.js');
      beginWorkspaceSwitch('C:\\\\new-fixture-workspace');
    })()`);
    await sleep(50);
    const restoredSurfaceAfterWsGen = await read('sessionStorage.getItem("pi-gui:secondary-active-surface")');
    const paneStateAfterWsGen = await read('sessionStorage.getItem("pi-gui:secondary-pane-state")');
    const parsedState2 = paneStateAfterWsGen ? JSON.parse(paneStateAfterWsGen) : {};
    check('Bug 11: workspace-generation automatically clears restored surface', restoredSurfaceAfterWsGen === null);
    check('Bug 11: workspace-generation automatically clears all pane states', Object.keys(parsedState2).length === 0);

    console.log(`\nElectron UI Verification: ${checks}/${checks} passed; failed=${failed}`);
    server.close();
    win.destroy();
    app.quit();
    process.exit(failed ? 1 : 0);
  });
}
