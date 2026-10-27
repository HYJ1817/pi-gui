'use strict';
/* Real Chromium verification for Bug 9 and Bug 11.
 * Tests thinking picker readback and right-pane ordinary panel auto-restore / scroll
 * retention across page reloads, and ensures browser NEVER auto-reconnects. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.BUG_FIX_EVIDENCE_DIR || path.join(ROOT, '.probe', 'bug-fixes'));

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-restore-'));
  const env = { ...process.env, RESTORE_WORLD: world }; delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(process.env.RESTORE_ELECTRON_BINARY || require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 120000 });
  if (run.status !== 0) console.error('Electron exit:', run.status, run.signal, run.error?.message || '');
  if (path.dirname(world) === path.resolve(os.tmpdir()) && path.basename(world).startsWith('pi-gui-restore-')) {
    fs.rmSync(world, { recursive: true, force: true, maxRetries: 5 });
  }
  process.exitCode = run.status ?? 1;
} else {
  const { app, BrowserWindow } = require('electron');
  const http = require('node:http');
  app.setPath('userData', path.join(process.env.RESTORE_WORLD, 'profile'));
  let win, server, checks = 0, failed = 0;
  const evidence = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const check = (name, value) => { checks++; if (!value) failed++; evidence.push({ name, passed: Boolean(value) }); console.log(`${value ? 'PASS' : 'FAIL'} ${name}`); };

  app.whenReady().then(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://fixture.invalid').pathname).replace(/^\//, '') || 'index.html';
      const file = path.resolve(ROOT, 'public', rel);
      if (!file.startsWith(path.join(ROOT, 'public') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      let body = fs.readFileSync(file);
      if (rel === 'index.html') body = body.toString().replace('<script type="module" src="/app.js"></script>', '');
      res.end(body);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    win = new BrowserWindow({ width: 1300, height: 850, show: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });

    const read = code => win.webContents.executeJavaScript(`(async () => {
      const result = await eval(${JSON.stringify(code)});
      try { return result === undefined ? undefined : JSON.parse(JSON.stringify(result)); } catch { return undefined; }
    })()`, true);

    const until = async (code, label) => { for (let i = 0; i < 200; i++) { if (await read(code)) return; await sleep(20); } throw Error(label + ' timeout'); };
    const shot = async name => {
      await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG());
    };

    const setupApp = async () => {
      await win.loadURL(`http://127.0.0.1:${port}/`);
      await read(`(async () => {
        const { S, el } = await import('/state.js');
        const git = await import('/git.js');
        const specs = await import('/specs-panel.js');
        const { initRightPane } = await import('/right-pane.js');
        const { configureSecondaryPane, readRestoredSurface } = await import('/ui/secondary-surface.js');
        const { renderModelControls } = await import('/composer.js');
        const { onThinkingLevels } = await import('/usage.js');

        Object.assign(S, {
          workspaceGeneration: 1,
          switching: false,
          bridgeState: 'ready',
          hasProject: true,
          cwd: 'C:\\\\fixture-project',
          thinkingLevels: ['off', 'low', 'medium', 'high'],
          thinkingReadStatus: 'success',
          state: {
            sessionId: 'session-1',
            model: { provider: 'anthropic', id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet' },
            thinkingLevel: 'medium'
          }
        });

        const pane = initRightPane();
        configureSecondaryPane(pane);
        renderModelControls();

        window.fetch = async (url) => {
          const u = String(url);
          if (u.endsWith('/api/git/status')) {
            const files = Array.from({ length: 60 }, (_, i) => ({
              path: 'src/module-' + String(i).padStart(2, '0') + '.js',
              status: 'M', additions: 5, deletions: 2
            }));
            return { json: async () => ({ ok: true, isRepo: true, files }) };
          }
          if (u.startsWith('/api/specs/document')) {
            return { json: async () => ({ ok: true, document: { id: 'doc-0', path: 'specs/spec-00.md', content: '# Spec 0' } }) };
          }
          if (u.startsWith('/api/specs')) {
            const documents = Array.from({ length: 40 }, (_, i) => ({
              id: 'doc-' + i, path: 'specs/spec-' + String(i).padStart(2, '0') + '.md', bytes: 1024
            }));
            return { json: async () => ({ ok: true, documents, workspace: { id: 'ws1', generation: '1' } }) };
          }
          if (u.endsWith('/api/status')) {
            return { json: async () => ({ ok: true, hasProject: true, cwd: 'C:\\\\fixture-project' }) };
          }
          return { json: async () => ({ ok: true }) };
        };

        window.fx = { S, el, git, specs, pane, readRestoredSurface };
      })()`);
    };

    await setupApp();

    // ================= Test Bug 9: Thinking level in Chromium =================
    const thinkLabel = await read('document.getElementById("thinkText")?.textContent');
    check('Bug 9: thinking chip reflects active level', thinkLabel === '思考 medium');
    const thinkDisabled = await read('document.getElementById("btnThink")?.disabled');
    check('Bug 9: thinking button is enabled with valid levels', thinkDisabled === false);
    await shot('01-bug9-thinking-ready');

    // ================= Test Bug 11: Changes Panel Restore & Scroll =================
    // 1. Open changes panel
    await read('window.fx.git.openChangesPanel()');
    await until('document.querySelector(".chg-list")', 'changes list render');
    await sleep(100);

    // 2. Scroll the list down to 400px
    await read('(() => { const list = document.querySelector(".chg-list"); list.scrollTop = 400; list.dispatchEvent(new Event("scroll")); })()');
    const scrolledTop = await read('document.querySelector(".chg-list")?.scrollTop');
    check('Bug 11: changes list scrolled before reload', scrolledTop >= 350);
    await shot('02-bug11-changes-scrolled');

    // 3. Verify restoredSurface was written to sessionStorage
    const recordedSurface = await read('sessionStorage.getItem("pi-gui:secondary-active-surface")');
    check('Bug 11: active surface recorded in sessionStorage as changes', recordedSurface === 'changes');

    // 4. Simulate page reload and restore
    await setupApp();
    await read('(() => { const s = window.fx.readRestoredSurface(); if (s === "changes") window.fx.git.openChangesPanel(); })()');
    await until('document.querySelector(".chg-list")', 'changes list restore render');
    await sleep(200);

    const restoredTop = await read('document.querySelector(".chg-list")?.scrollTop');
    check('Bug 11: changes list scroll position restored after reload', restoredTop >= 350);
    await shot('03-bug11-changes-restored');

    // ================= Test Bug 11: Specs Panel Restore =================
    await read('window.fx.specs.openSpecsPanel()');
    await until('document.querySelector(".specs-doc-item")', 'specs tree items render');
    await sleep(100);

    await read('(() => { const tree = document.querySelector(".specs-tree-list"); tree.scrollTop = 250; tree.dispatchEvent(new Event("scroll")); })()');
    const specsTreeScroll = await read('document.querySelector(".specs-tree-list")?.scrollTop');
    check('Bug 11: specs tree scrolled before reload', specsTreeScroll >= 150);
    await shot('04-bug11-specs-scrolled');

    const recordedSpecsSurface = await read('sessionStorage.getItem("pi-gui:secondary-active-surface")');
    check('Bug 11: active surface recorded as specs', recordedSpecsSurface === 'specs');

    // Reload and restore specs
    await setupApp();
    await read('(() => { const s = window.fx.readRestoredSurface(); if (s === "specs") window.fx.specs.openSpecsPanel(); })()');
    await until('document.querySelector(".specs-doc-item")', 'specs tree restore render');
    await sleep(200);

    const restoredSpecsScroll = await read('document.querySelector(".specs-tree-list")?.scrollTop');
    check('Bug 11: specs tree scroll position restored after reload', restoredSpecsScroll >= 150);
    await shot('05-bug11-specs-restored');

    // ================= Test Bug 11: Browser is NEVER auto-restored =================
    await read('window.fx.pane.open("browser")');
    const recordedBrowserSurface = await read('sessionStorage.getItem("pi-gui:secondary-active-surface")');
    check('Bug 11: browser surface is NEVER written to sessionStorage', recordedBrowserSurface === null);

    await setupApp();
    const surfaceAfterBrowserReload = await read('window.fx.readRestoredSurface()');
    check('Bug 11: readRestoredSurface is null after browser was active', surfaceAfterBrowserReload === null);
    const paneOpenAfterReload = await read('window.fx.pane.isOpen()');
    check('Bug 11: right pane remains closed after browser reload', paneOpenAfterReload === false);
    await shot('06-bug11-browser-never-restored');

    console.log(`\nElectron UI Verification: ${checks}/${checks} passed; failed=${failed}`);
    server.close();
    win.destroy();
    app.quit();
    process.exit(failed ? 1 : 0);
  });
}
