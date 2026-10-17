/* UI-5：真实 Electron + 真实生产前端中的日志管理与故障报告界面。
 *
 * 使用离线 visual-harness（所有 /api/* 为 fixture），不连接真实 Pi、不读写
 * 用户项目/会话/真实日志。截图是 Electron 网页像素，不包含原生窗口装饰。
 * 用法：node tests/ui5-logs-electron.cjs
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.UI5_EVIDENCE_ROOT || path.join(ROOT, 'docs/claude-ui-redesign/ui5-evidence/electron-logs');

if (!process.versions.electron) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'ui5-logs-electron-'));
  const env = { ...process.env, UI5_WORLD: world };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: false });
  const cleanup = () => { try { fs.rmSync(world, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* temp cleanup is best effort */ } };
  child.on('error', (error) => { console.error(error); cleanup(); process.exitCode = 1; });
  child.on('exit', (code) => { cleanup(); process.exitCode = code ?? 1; });
} else {
  run().catch((error) => { console.error(error); process.exitCode = 1; });
}

async function run() {
  const { app, BrowserWindow } = require('electron');
  const world = process.env.UI5_WORLD || fs.mkdtempSync(path.join(os.tmpdir(), 'ui5-logs-electron-'));
  app.setPath('userData', path.join(world, 'user-data'));
  app.on('window-all-closed', () => { /* this fixture exits explicitly */ });

  const checks = [];
  const shots = [];
  const errors = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (pass, name, detail) => {
    checks.push({ pass: Boolean(pass), name, detail });
    console.log((pass ? 'PASS ' : 'FAIL ') + name + (pass ? '' : ' ' + JSON.stringify(detail)));
  };
  const read = (expression) => win.webContents.executeJavaScript(expression, true);
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return true;
      await sleep(60);
    }
    throw new Error('timeout');
  };
  const shot = async (name) => {
    await sleep(220);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG());
    shots.push(name + '.png');
  };

  let harness = null;
  let win = null;
  const timeout = setTimeout(() => { console.error('UI5 logs Electron timeout'); app.exit(1); }, 240000);
  try {
    fs.mkdirSync(OUT, { recursive: true });
    await app.whenReady();
    harness = spawn(process.execPath, [path.join(ROOT, 'tests/visual-harness.cjs')], {
      cwd: world,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0', VISUAL_PUBLIC_ROOT: process.env.UI5_ASSETS_ROOT || path.join(ROOT, 'public'), VISUAL_UPLOAD_DIR: path.join(world, 'uploads') },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    harness.stderr.on('data', (chunk) => errors.push('harness: ' + String(chunk)));
    const origin = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('harness timeout')), 20000);
      harness.stdout.on('data', (chunk) => {
        buffer += chunk;
        const found = buffer.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (found) { clearTimeout(timer); resolve(found[0]); }
      });
      harness.on('error', reject);
    });

    win = new BrowserWindow({
      width: 1440, height: 900, useContentSize: true, show: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3 && !String(message).includes('Electron Security Warning')) errors.push(String(message));
    });
    await win.loadURL(origin);
    await sleep(1200);
    win.show(); win.focus(); win.webContents.focus();
    await until(() => read(`Boolean(document.getElementById('navLogs'))`));
    check(true, 'production entry exposes the diagnostics/logs settings entry');

    const open = () => read(`document.getElementById('navLogs').click()`);
    const close = () => read(`(()=>{const b=[...document.querySelectorAll('#modalCard .modal-actions button')].find(x=>x.textContent==='关闭');if(b)b.click();})()`);
    const modal = () => read(`(()=>{
      const card=document.getElementById('modalCard'), b=card.getBoundingClientRect(), body=document.querySelector('.ui5-logs-body');
      const styles=getComputedStyle(card);
      return { hidden:document.getElementById('modal').hidden, x:b.x,y:b.y,right:b.right,bottom:b.bottom,w:b.width,h:b.height,
        vw:innerWidth,vh:innerHeight, role:card.getAttribute('role'), aria:card.getAttribute('aria-modal'),
        overflow:document.documentElement.scrollWidth>innerWidth+1, bodyScroll:Boolean(body), bodyScrollHeight:body?body.scrollHeight:0,
        bodyClientHeight:body?body.clientHeight:0, tabs:[...document.querySelectorAll('.ui5-logs-tab')].map(t=>t.textContent),
        bg: styles.backgroundColor, color: styles.color };
    })()`);

    await open();
    await until(async () => !(await modal()).hidden);
    await until(() => read(`document.querySelector('.ui5-logs-body')?.textContent.includes('app-20261017.jsonl')`));
    const initial = await modal();
    check(initial.role === 'dialog' && initial.aria === 'true', 'logs surface is a real modal dialog');
    check(initial.tabs.join('|') === '概览|日志查看|导出故障报告', 'logs modal exposes overview/viewer/export tabs');
    check(!initial.overflow && initial.right <= initial.vw + 1 && initial.bottom <= initial.vh + 1, 'logs modal fits the viewport without page overflow', initial);
    check(initial.bodyScroll, 'logs content uses its own scroll region');
    await shot('logs-dark-1200-overview');

    await read(`document.getElementById('ui5-log-tab-logs').click()`);
    await until(() => read(`document.querySelectorAll('.ui5-log-entry').length >= 3`));
    const viewer = await read(`(()=>({
      entries:document.querySelectorAll('.ui5-log-entry').length,
      errorOpen:document.querySelector('.ui5-log-entry[data-level="ERROR"] details')?.open===true,
      hasCode:document.querySelector('.ui5-log-entry .ui5-log-code')?.textContent,
      hasDebug:document.body.textContent.includes('electron.browser_view_state'),
      bodyOverflow:document.querySelector('.ui5-logs-list').scrollWidth>document.querySelector('.ui5-logs-list').clientWidth+1
    }))()`);
    check(viewer.entries >= 3, 'viewer renders structured entries', viewer);
    check(viewer.errorOpen && viewer.hasCode === 'BRIDGE_TIMEOUT', 'error entries expand and show the stable code');
    check(!viewer.bodyOverflow, 'log entries do not force horizontal overflow');
    await shot('logs-dark-1200-viewer');

    await read(`document.getElementById('ui5-log-tab-export').click()`);
    await until(() => read(`Boolean([...document.querySelectorAll('#modalCard button')].find(b=>b.textContent==='预览摘要'))`));
    await read(`[...document.querySelectorAll('#modalCard button')].find(b=>b.textContent==='预览摘要').click()`);
    await until(() => read(`document.querySelector('.ui5-logs-preview')?.textContent.includes('24')`));
    const exportState = await read(`(()=>({
      preview:document.querySelector('.ui5-logs-preview').textContent,
      confirmDisabled:[...document.querySelectorAll('#modalCard button')].find(b=>b.textContent==='确认导出 ZIP').disabled,
      overflow:document.documentElement.scrollWidth>innerWidth+1
    }))()`);
    check(!exportState.confirmDisabled && exportState.preview.includes('errors.jsonl') && !exportState.overflow, 'export preview enables confirmation and lists the fixed ZIP manifest', exportState);
    await shot('logs-dark-1200-export');

    for (const theme of ['dark', 'light']) {
      for (const width of [700, 900, 1200, 1536]) {
        await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        win.setContentSize(width, 900);
        await sleep(120);
        await read(`document.getElementById('ui5-log-tab-overview').click()`);
        await sleep(80);
        const facts = await modal();
        check(!facts.overflow && facts.x >= -1 && facts.y >= -1 && facts.right <= facts.vw + 1 && facts.bottom <= facts.vh + 1,
          `logs overview fits ${theme}-${width}`, facts);
        if (width === 700) {
          const b = await read(`(()=>{const card=document.getElementById('modalCard'), cw=card.clientWidth, btns=[...card.querySelectorAll('.ui5-logs-toolbar .btn')].map(x=>x.getBoundingClientRect().width);return {cw,btns};
          })()`);
          check(b.btns.every((w) => w < b.cw * 0.85), `narrow logs toolbar keeps natural-width actions: ${theme}-${width}`, b);
        }
        if (theme === 'light' && width === 700) await shot('logs-light-700-overview');
        if (theme === 'dark' && width === 700) await shot('logs-dark-700-overview');
      }
    }

    for (const theme of ['dark', 'light']) {
      await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      win.setContentSize(1200, 900);
      await read(`document.getElementById('ui5-log-tab-logs').click()`);
      await sleep(100);
      await shot('logs-' + theme + '-1200-viewer-final');
      await read(`document.getElementById('ui5-log-tab-export').click()`);
      await sleep(100);
      await shot('logs-' + theme + '-1200-export-final');
      if (theme === 'light') {
        win.setContentSize(700, 900);
        await sleep(100);
        await read(`[...document.querySelectorAll('#modalCard button')].find(b=>b.textContent==='预览摘要')?.click()`);
        await sleep(100);
        const narrowExport = await read(`(()=>{const p=document.querySelector('.ui5-logs-preview'),m=document.getElementById('modalCard');return {overflow:document.documentElement.scrollWidth>innerWidth+1,pw:p.scrollWidth,pv:p.clientWidth,mw:m.getBoundingClientRect().right,vw:innerWidth}})()`);
        check(!narrowExport.overflow && narrowExport.mw <= narrowExport.vw + 1, 'narrow export preview stays within viewport', narrowExport);
        await shot('logs-light-700-export');
      }
    }

    await close();
    check(await read(`document.getElementById('modal').hidden === true`), 'logs modal closes and restores the page');
    check(errors.length === 0, 'no renderer/harness console errors during logs UI checks', errors.slice(0, 8));

    const failed = checks.filter((item) => !item.pass).length;
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({
      passed: checks.length - failed, failed, checks, screenshots: shots, errors,
      electron: process.versions.electron, chrome: process.versions.chrome,
    }, null, 2));
    console.log(`UI5 logs Electron: ${checks.length - failed}/${checks.length}, failed=${failed}, screenshots=${shots.length}`);
    process.exitCode = failed || errors.length ? 1 : 0;
  } finally {
    clearTimeout(timeout);
    if (harness) {
      try { harness.kill(); } catch { /* noop */ }
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/pid', String(harness.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* noop */ }
      }
    }
    if (win && !win.isDestroyed()) win.destroy();
    try { fs.rmSync(world, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* noop */ }
    app.quit();
  }
}
