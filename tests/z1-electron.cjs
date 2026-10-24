'use strict';
/* Real Chromium layout with production HTML/CSS/modules and in-memory API
 * fixtures. No backend, Pi, model calls or user project writes. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.Z1_EVIDENCE_DIR || path.join(ROOT, '.probe', 'z1'));
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-z1-'));
  const env = { ...process.env, Z1_WORLD: world }; delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(process.env.Z1_ELECTRON_BINARY || require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 120000 });
  if (run.status !== 0) console.error('Electron exit:', run.status, run.signal, run.error?.message || '');
  // Only remove the exact temporary directory created by this test.
  if (path.dirname(world) === path.resolve(os.tmpdir()) && path.basename(world).startsWith('pi-gui-z1-')) {
    fs.rmSync(world, { recursive: true, force: true, maxRetries: 5 });
  }
  process.exitCode = run.status ?? 1;
} else {
  const { app, BrowserWindow } = require('electron');
  const http = require('node:http');
  app.setPath('userData', path.join(process.env.Z1_WORLD, 'profile'));
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
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    await read(`(async () => {
      const { S } = await import('/state.js');
      const git = await import('/git.js'), specs = await import('/specs-panel.js');
      const { initRightPane } = await import('/right-pane.js');
      const { configureSecondaryPane } = await import('/ui/secondary-surface.js');
      const { openSplitWorkbench } = await import('/ui/split-workbench.js');
      const { openLogs } = await import('/logs.js');
      const { runtimeStore } = await import('/runtime-state.js');
      const api = await import('/api.js'), views = await import('/ui/workspace-surface.js');
      Object.assign(S, { workspaceGeneration: 1, switching: false, bridgeState: 'ready', hasProject: true, cwd: 'C:\\\\fixture-z1', state: { sessionId: 'z1' } });
      const pane = initRightPane(); configureSecondaryPane(pane);
      const fx = window.fx = { S, git, specs, pane, openSplitWorkbench, openLogs, runtimeStore, api, views, count: 80, delay: 0, diffDelay: 0, fail: false, calls: [], releases: [] };
      fx.entry = { timestamp: '2026-10-24T08:00:00.000Z', level: 'ERROR', source: 'pi-bridge', event: 'bridge.request_timeout', code: 'BRIDGE_TIMEOUT', details: { operation: 'secret-canary' } };
      window.fetch = async (url, opts = {}) => {
        const u = String(url); fx.calls.push({ u, method: opts.method || 'GET' });
        if (u.endsWith('/api/git/status')) {
          const count = fx.count; if (fx.delay) await new Promise(r => fx.releases.push(r));
          return { json: async () => fx.fail ? { ok: false, error: 'Fixture unavailable' } : { ok: true, isRepo: true, files: Array.from({ length: count }, (_, i) => ({ path: 'file-' + String(i).padStart(2, '0') + '.txt', status: 'M', additions: 1, deletions: 1 })) } };
        }
        if (u.endsWith('/api/git/diff')) {
          if (fx.diffDelay) await new Promise(r => fx.releases.push(r));
          return { json: async () => ({ ok: true, working: '@@ -1 +1,20 @@\\n-old\\n' + Array.from({ length: 20 }, (_, i) => '+' + i + ' ' + 'long line '.repeat(30)).join('\\n') + '\\n', staged: '@@ -1 +1 @@\\n-old\\n+' + 'staged '.repeat(80) + '\\n' }) };
        }
        if (u.startsWith('/api/specs/document')) return { json: async () => ({ ok: true, document: { id: 'doc', path: 'SPEC.md', content: '# Fixture document' } }) };
        if (u.startsWith('/api/specs')) return { json: async () => ({ ok: true, workspace: { id: 'fixture', generation: '1' }, documents: [{ id: 'doc', path: 'SPEC.md', main: true }] }) };
        if (u.endsWith('/api/logs/status')) return { json: async () => ({ ok: true, status: { enabled: true, mode: 'standard', retentionDays: 7, maxTotalMB: 20, usageBytes: 2048, fileCount: 1, files: [], session: {}, recentErrors: [fx.entry] } }) };
        if (u.startsWith('/api/review-comments')) return { json: async () => ({ ok: false, code: 'fixture_unavailable' }) };
        return { json: async () => ({ ok: true }) };
      };
      fx.metrics = () => Object.fromEntries(['.chg-body', '.chg-list', '.chg-diff', '.diff'].map(s => { const n = document.querySelector(s); return [s, n && { top: n.scrollTop, left: n.scrollLeft, client: n.clientHeight, height: n.scrollHeight, width: n.clientWidth, fullWidth: n.scrollWidth, overflow: getComputedStyle(n).overflowY }]; }));
      fx.closeModal = () => [...document.querySelectorAll('#modalCard .modal-actions button')].find(b => b.textContent === '关闭')?.click();
      git.openChangesPanel();
    })()`);
    await until("document.querySelectorAll('.chg-row').length === 80", 'initial list');
    await sleep(100);
    evidence.push({ single: await read('fx.metrics()') });
    check('single panel has a genuinely scrollable .chg-list', await read("document.querySelector('.chg-list').scrollHeight > document.querySelector('.chg-list').clientHeight"));
    await read("document.querySelector('.chg-list').scrollTop = 650"); await sleep(70);
    evidence.push({ beforeSingleReopen: await read('fx.metrics()') });
    await read('fx.specs.openSpecsPanel(); fx.git.openChangesPanel()');
    await sleep(200);
    evidence.push({ afterSingleReopen: await read('fx.metrics()') });
    check('single-panel reopen restores real list scroll after status redraw', await read("Math.abs(document.querySelector('.chg-list').scrollTop - 650) < 2"));
    await shot('01-single-reopen');

    await read("document.querySelector('.chg-row .chg-main').click()");
    await until("document.querySelector('.diff .d-row')", 'expanded diff');
    await read("document.querySelector('.chg-list').scrollTop = 0; document.querySelectorAll('.diff')[0].scrollLeft = 180; document.querySelectorAll('.diff')[1].scrollLeft = 260");
    await sleep(70);
    check('Diff uses real horizontal scrollers for staged and working sections', await read("[...document.querySelectorAll('.diff')].every(n => n.scrollWidth > n.clientWidth && n.scrollLeft > 0)"));
    await read('fx.specs.openSpecsPanel(); fx.git.openChangesPanel()'); await sleep(200);
    await until("document.querySelectorAll('.diff').length === 2", 'restored diff');
    check('reopen restores expanded Diff and both horizontal positions', await read("!document.querySelector('.chg-diff').hidden && document.querySelectorAll('.diff')[0].scrollLeft === 180 && document.querySelectorAll('.diff')[1].scrollLeft === 260"));
    await shot('02-diff-horizontal');

    await read("document.querySelector('.chg-list').scrollTop = 650"); await sleep(70);
    await read('fx.delay = 1; fx.specs.openSpecsPanel(); fx.git.openChangesPanel()'); await sleep(80);
    await read('fx.delay = 0; fx.diffDelay = 1; fx.releases.splice(0).forEach(r => r())'); await sleep(80);
    await read('fx.diffDelay = 0; fx.releases.splice(0).forEach(r => r())'); await sleep(200);
    check('delayed status and Diff loading retain requested list scroll', await read("Math.abs(document.querySelector('.chg-list').scrollTop - 650) < 2"));
    await read('fx.git.refreshGitNow()'); await sleep(100);
    check('ordinary status refresh preserves actual list scroll after DOM replacement', await read("Math.abs(document.querySelector('.chg-list').scrollTop - 650) < 2"));
    await read("document.querySelector('.chg-list').scrollTop = 2800"); await sleep(60);
    await read('fx.count = 25; fx.git.refreshGitNow()'); await sleep(100);
    evidence.push({ shortenedList: await read('fx.metrics()') });
    check('shortened list clamps saved position to actual scroll range', await read("Math.abs(document.querySelector('.chg-list').scrollTop - Math.max(0, document.querySelector('.chg-list').scrollHeight - document.querySelector('.chg-list').clientHeight)) < 1"));
    await read('fx.count = 0; fx.git.refreshGitNow()'); await sleep(80);
    await read('fx.count = 80; fx.git.refreshGitNow()'); await sleep(100);
    check('an empty refresh resets scroll before files reappear', await read("document.querySelector('.chg-list').scrollTop === 0"));

    await read("document.querySelector('.chg-list').scrollTop = 500"); await sleep(60);
    await read('fx.fail = true; fx.git.refreshGitNow()');
    check('failed Git status renders an explicit error', await read("document.querySelector('.chg-hint.err')?.textContent.includes('Fixture unavailable')"));
    await read('fx.fail = false; fx.git.refreshGitNow()'); await sleep(100);
    check('retry restores list position after a status failure', await read("document.querySelector('.chg-list').scrollTop === 500"));

    await read('fx.count = 80; fx.git.refreshGitNow()'); await sleep(150);
    await read('fx.openSplitWorkbench({ returnSurface: "changes" })'); await sleep(200);
    evidence.push({ split: await read('fx.metrics()') });
    check('split panel also scrolls the actual .chg-list', await read("document.querySelector('.chg-list').scrollHeight > document.querySelector('.chg-list').clientHeight"));
    await read("document.querySelector('.chg-list').scrollTop = 400"); await sleep(70);
    evidence.push({ beforeSplitReopen: await read('fx.metrics()') });
    await read('fx.specs.openSpecsPanel(); fx.openSplitWorkbench({ returnSurface: "changes" })'); await sleep(200);
    evidence.push({ afterSplitReopen: await read('fx.metrics()') });
    check('split reopen restores actual list position', await read("Math.abs(document.querySelector('.chg-list').scrollTop - 400) < 2"));
    await shot('03-split-reopen');
    await read("document.querySelector('.workbench-exit').click()"); await sleep(120);
    check('split-to-single transition preserves list scroll', await read("!document.querySelector('.workbench-split') && document.querySelector('.chg-list').scrollTop === 400"));

    await read('fx.delay = 1; fx.count = 15; fx.specs.openSpecsPanel(); fx.git.openChangesPanel()'); await sleep(60);
    await read("fx.delay = 0; fx.count = 80; fx.S.workspaceGeneration++; document.dispatchEvent(new CustomEvent('pi-gui:workspace-generation')); fx.specs.openSpecsPanel(); fx.git.openChangesPanel()"); await sleep(100);
    await read('fx.releases.splice(0).forEach(r => r())'); await sleep(100);
    check('late old-workspace status cannot restore old rows or scroll', await read("document.querySelectorAll('.chg-row').length === 80 && document.querySelector('.chg-list').scrollTop === 0"));

    await read("document.dispatchEvent(new CustomEvent('pi-gui:session-switch')); fx.specs.openSpecsPanel(); fx.git.openChangesPanel()"); await sleep(150);
    check('session switch drops previous scroll and expanded Diff', await read("document.querySelector('.chg-list').scrollTop === 0 && document.querySelector('.chg-diff').hidden"));
    await read("document.querySelector('.chg-list').scrollTop = 400"); await sleep(70);
    await read("fx.S.workspaceGeneration++; document.dispatchEvent(new CustomEvent('pi-gui:workspace-generation')); fx.specs.openSpecsPanel(); fx.git.openChangesPanel()"); await sleep(150);
    check('workspace switch drops previous list position', await read("document.querySelector('.chg-list').scrollTop === 0"));

    await read("fx.diffDelay = 1; document.querySelector('.chg-main').click()"); await sleep(50);
    await read("document.dispatchEvent(new CustomEvent('pi-gui:session-switch')); fx.specs.openSpecsPanel(); fx.git.openChangesPanel(); fx.diffDelay = 0; fx.releases.splice(0).forEach(r => r())"); await sleep(130);
    check('late old-session Diff cannot reopen a file or restore its horizontal state', await read("document.querySelector('.chg-diff').hidden && !document.querySelector('.diff')"));

    await read("document.querySelector('#input').value = 'Existing draft'; fx.openLogs()");
    await until("document.querySelector('.ui5-log-ref')", 'overview reference');
    await read("document.querySelector('.ui5-log-ref').click()");
    check('overview Classic success is visible and preserves draft', await read("document.querySelector('.ui5-logs-recent-error [role=status]')?.textContent.includes('已引用') && document.querySelector('#input').value.startsWith('Existing draft')"));
    await read("document.querySelector('.ui5-logs-recent-error').scrollIntoView({ block: 'center' })");
    await shot('04-log-success');
    win.focus(); await read("document.querySelector('.ui5-log-ref').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await sleep(60);
    check('keyboard activates overview reference once and keeps inline feedback', await read("document.querySelector('#input').value.split('日志引用').length === 3 && document.querySelector('.ui5-logs-recent-error [role=status]')?.textContent.includes('已引用')"));
    await read("fx.S.bridgeState = 'disconnected'; document.querySelector('.ui5-log-ref').click()");
    check('overview not-ready failure is visible and does not append', await read("document.querySelector('.ui5-logs-recent-error [role=status]')?.textContent.includes('尚未就绪') && document.querySelector('#input').value.split('日志引用').length === 3"));
    await shot('05-log-failure');
    await read(`fx.S.bridgeState = 'ready'; fx.views.showRuntimeConversation(); fx.api.setGitConversationScope('A');
      fx.runtimeStore.seed({ backendInstance: 'fixture', items: [{ conversationId: 'A', owner: { backendInstance: 'fixture', conversationId: 'A', runtimeId: 'ra', runtimeGeneration: '1', sessionId: 'sa' }, lifecycle: 'ready' }] });
      document.querySelector('#runtimeView').innerHTML = '<section class="runtime-conversation" data-conversation-id="A"><textarea aria-label="给当前会话的任务">Runtime draft</textarea></section>';
      document.querySelector('.ui5-log-ref').click()`);
    check('overview Runtime success fills only its owned composer', await read("document.querySelector('.ui5-logs-recent-error [role=status]')?.textContent.includes('已引用') && document.querySelector('#runtimeView textarea').value.startsWith('Runtime draft')"));
    await read("document.querySelector('.runtime-conversation').dataset.conversationId = 'B'; document.querySelector('.ui5-log-ref').click()");
    check('overview mismatched Runtime identity reports failure without filling B', await read("document.querySelector('.ui5-logs-recent-error [role=status]')?.textContent.includes('身份不一致') && document.querySelector('#runtimeView textarea').value.split('日志引用').length === 2"));
    check('reference contains only safe fields and never sends or executes', await read("!document.querySelector('#runtimeView textarea').value.includes('secret-canary') && !fx.calls.some(c => /prompt|steer|follow.up|command|execute/.test(c.u))"));
    win.setSize(760, 850); win.webContents.setZoomFactor(1.25); await sleep(100);
    await read("document.querySelector('.ui5-logs-recent-error').scrollIntoView({ block: 'center' })");
    await shot('06-narrow-feedback');
    check('narrow log feedback stays within the modal', await read("document.querySelector('.ui5-logs-body').scrollWidth <= document.querySelector('.ui5-logs-body').clientWidth + 1"));
    check('Chromium ran with normal sandbox and context isolation', win.webContents.getLastWebPreferences().sandbox && win.webContents.getLastWebPreferences().contextIsolation);
  }).catch(error => { failed++; evidence.push({ error: error.stack }); console.error(error); }).finally(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, passed: checks - evidence.filter(e => e.passed === false).length, failed, skipped: 0, electron: process.versions.electron, chromium: process.versions.chrome, evidence }, null, 2));
    console.log(`Z1 Electron: ${checks - evidence.filter(e => e.passed === false).length}/${checks}; failed=${failed}; skipped=0`);
    win?.destroy(); if (server) await new Promise(r => server.close(r)); app.exit(failed ? 1 : 0);
  });
}
