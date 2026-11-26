/* 日志与诊断：真实生产入口 + 离线 visual-harness + 正常 sandbox 的 Electron。
 * 所有 API 均为 fixture；截图/配置写入 os.tmpdir，不接真 Pi 或用户数据。
 * ZIP 真服务与脱敏由 logging / logging-packaged 套件另验，不以此截图夹具代替。
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.UI5_EVIDENCE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-logs-evidence-'));

if (!process.versions.electron) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'ui5-logs-electron-'));
  const env = { ...process.env, UI5_WORLD: world, UI5_EVIDENCE_ROOT: OUT };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: false });
  const cleanup = () => { try { fs.rmSync(world, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* temp only */ } };
  child.on('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    if (code !== 0) console.error(`Electron runner exited: code=${code}, signal=${signal || 'none'}, executable=${require('electron')}`);
    cleanup(); process.exitCode = code === 0 ? 0 : 1;
  });
} else {
  run().catch(error => { console.error(error); require('electron').app.exit(1); });
}

async function run() {
  const { app, BrowserWindow } = require('electron');
  const world = process.env.UI5_WORLD;
  if (!world || !fs.existsSync(world)) throw new Error('missing isolated world');
  app.setPath('userData', path.join(world, 'user-data'));
  app.on('window-all-closed', () => {});
  const checks = [], shots = [], errors = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (pass, name, detail) => {
    checks.push({ pass: Boolean(pass), name, detail });
    console.log((pass ? 'PASS ' : 'FAIL ') + name + (pass ? '' : ' ' + JSON.stringify(detail)));
  };
  let harness = null, win = null;
  const read = expression => win.webContents.executeJavaScript(expression, true);
  const until = async (expression, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await read(expression)) return; await sleep(60); }
    throw new Error('timeout: ' + expression);
  };
  const shot = async name => {
    await sleep(180);
    fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG());
    shots.push(name + '.png');
  };
  const timeout = setTimeout(() => { console.error('logs Electron timeout'); app.exit(1); }, 240000);
  try {
    fs.mkdirSync(OUT, { recursive: true });
    await app.whenReady();
    harness = spawn(process.execPath, [path.join(ROOT, 'tests/visual-harness.cjs')], {
      cwd: world,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0',
        VISUAL_PUBLIC_ROOT: process.env.UI5_ASSETS_ROOT || path.join(ROOT, 'public'), VISUAL_UPLOAD_DIR: path.join(world, 'uploads') },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    harness.stderr.on('data', chunk => errors.push('harness: ' + String(chunk)));
    const origin = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('harness timeout')), 20000);
      harness.stdout.on('data', chunk => {
        buffer += chunk;
        const found = buffer.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (found) { clearTimeout(timer); resolve(found[0]); }
      });
      harness.on('error', reject);
    });
    win = new BrowserWindow({ width: 1440, height: 960, useContentSize: true, show: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3 && !String(message).includes('Electron Security Warning')) errors.push(String(message));
    });
    await win.loadURL(origin);
    await until(`typeof document.getElementById('navLogs')?.onclick === 'function'`);
    win.show(); win.focus(); win.webContents.focus();
    const open = () => read(`document.getElementById('navLogs').click()`);
    const selectTab = async id => {
      await read(`document.getElementById('ui5-log-tab-${id}').click()`);
      if (id === 'overview') await until(`Boolean(document.querySelector('[data-log-setting="enabled"]'))`);
      if (id === 'logs') await until(`document.querySelectorAll('.ui5-log-entry').length >= 3`);
      if (id === 'export') await until(`document.querySelector('[data-log-action="copy-json"]')?.disabled === false`);
      await read(`document.activeElement?.blur?.();document.getElementById('workSurface').scrollTop=0`);
    };
    const facts = () => read(`(()=>{
      const card=document.querySelector('.settings-detail-card.ui5-logs-modal'),body=document.querySelector('.ui5-logs-body');
      const b=card.getBoundingClientRect(), scroller=document.getElementById('workSurface');
      return { count:document.querySelectorAll('.settings-detail-card.ui5-logs-modal').length,role:card.getAttribute('role'),
        modal:document.getElementById('modal').hidden===false,tabs:[...card.querySelectorAll('[role=tab]')].map(t=>t.textContent),
        overflow:document.documentElement.scrollWidth>innerWidth+1 || card.scrollWidth>card.clientWidth+1,
        right:b.right,vw:innerWidth,titleSize:getComputedStyle(card.querySelector('h2')).fontSize,
        innerOverflow:getComputedStyle(body).overflowY,outerOverflow:getComputedStyle(scroller).overflowY,
        selected:document.getElementById('navLogs').getAttribute('aria-current'),
        legacy:document.getElementById('navDiagnostics')!==null,
        footers:card.querySelectorAll('.modal-actions,.ui5-logs-toolbar').length };
    })()`);
    await open(); await selectTab('overview');
    const initial = await facts();
    check(initial.count === 1 && !initial.modal && initial.role === 'region' && initial.selected === 'page' && !initial.legacy,
      'unique central settings destination, no retired page/modal', initial);
    check(initial.tabs.join('|') === '概览|日志查看|导出故障报告', 'three tabs preserve product roles', initial.tabs);
    check(initial.titleSize === '20px' && initial.footers === 0 && initial.innerOverflow === 'visible',
      'design-system title, one parent scroll owner, no duplicate chrome', initial);
    check(await read(`document.querySelector('[data-log-setting="enabled"]').getAttribute('role')==='switch' &&
      document.querySelector('[data-log-setting="mode"]').classList.contains('ds-select')`), 'shared toggle/select primitives');
    await read(`document.querySelector('.ui5-logs-recent-error details').open=true`);
    check(await read(`document.querySelector('.ui5-logs-recent-error').textContent.includes('BRIDGE_TIMEOUT') &&
      Boolean(document.querySelector('.ui5-logs-recent-error .ui5-log-copy'))`), 'recent error expands safe details and copy/reference actions');

    await selectTab('logs');
    check(await read(`document.querySelector('.ui5-log-entry[data-level="ERROR"] details').open &&
      document.querySelector('.ui5-logs-search').classList.contains('ds-search-field')`), 'viewer error details and shared search');
    await read(`document.getElementById('ui5-log-tab-logs').focus()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    await until(`document.getElementById('ui5-log-tab-export').getAttribute('aria-selected')==='true'`);
    check(await read(`document.activeElement.id==='ui5-log-tab-export' && document.querySelectorAll('[role=tab][tabindex="0"]').length===1`),
      'real keyboard switches tabs and roving focus');
    await selectTab('export');
    await read(`[...document.querySelectorAll('.settings-detail-card button')].find(b=>b.textContent==='预览摘要').click()`);
    await until(`document.querySelector('.ui5-logs-preview').textContent.includes('errors.jsonl')`);
    check(await read(`![...document.querySelectorAll('.settings-detail-card button')].find(b=>b.textContent==='确认导出 ZIP').disabled &&
      document.querySelectorAll('[data-log-action="copy-summary"]').length===1`), 'fixed ZIP preview and one summary action');
    await read(`(()=>{const e=document.querySelector('select[aria-label="故障报告时间范围"]');e.value='120';e.dispatchEvent(new Event('change'));})()`);
    check(await read(`[...document.querySelectorAll('.settings-detail-card button')].find(b=>b.textContent==='确认导出 ZIP').disabled`), 'changed range invalidates preview consent');

    for (const theme of ['dark', 'light']) {
      for (const width of [1440, 700]) {
        win.webContents.setZoomFactor(1); win.setContentSize(width, 960);
        await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        for (const id of ['overview', 'logs', 'export']) {
          await selectTab(id); await sleep(100);
          const f = await facts();
          check(!f.overflow && f.right <= f.vw + 1, `layout ${theme}-${width}-${id}`, f);
          if (id === 'export' && width === 700) {
            const row = await read(`(()=>{const r=document.querySelector('.ui5-logs-actions')?.closest('.settings-row');
              if(!r) return null;const c=r.querySelector('.settings-row-copy').getBoundingClientRect();
              return {wrap:getComputedStyle(r).flexWrap,labelWidth:c.width};})()`);
            check(row && row.wrap === 'wrap' && row.labelWidth >= 120, 'narrow export action row wraps whole buttons instead of crushing its label', row);
          }
          await shot(`logs-${theme}-${width}-${id}`);
        }
      }
    }
    // At scaled narrow width, long English and Chinese labels must wrap, not clip.
    win.setContentSize(900, 960); win.webContents.setZoomFactor(1.25);
    await selectTab('overview');
    await read(`document.querySelector('#navLogs > span').textContent='Logs and diagnostics · 日志与诊断';
      document.querySelector('[data-log-setting="mode"] option').textContent='Standard logging (INFO and above)';`);
    const long = await read(`(()=>{const b=document.getElementById('navLogs'),s=b.querySelector('span');return {
      overflow:s.scrollWidth>s.clientWidth+1 || s.scrollHeight>s.clientHeight+1,
      whiteSpace:getComputedStyle(s).whiteSpace,height:b.getBoundingClientRect().height,page:document.documentElement.scrollWidth>innerWidth+1};})()`);
    check(!long.overflow && !long.page && long.whiteSpace !== 'nowrap', '125% narrow long-label sidebar wraps without clipping', long);
    await shot('logs-light-scaled-long-label');
    await read(`document.getElementById('btnSidebarCollapse').click()`);
    check((await facts()).overflow === false, 'collapsed sidebar keeps logs usable');
    await shot('logs-light-scaled-collapsed');
    await read(`document.getElementById('btnSidebarExpand').click()`);
    win.webContents.setZoomFactor(1); win.setContentSize(1440, 960);
    await read(`document.querySelector('#navLogs > span').textContent='日志与诊断'`);
    await read(`document.getElementById('navGlobalMore').click()`);
    for (const term of ['diagnostics', '故障报告', '运行状态与诊断']) {
      await read(`(()=>{const s=document.getElementById('settingsSearchInput');s.value=${JSON.stringify(term)};s.dispatchEvent(new Event('input'));})()`);
      check(await read(`!document.getElementById('navLogs').hidden && !document.getElementById('navDiagnostics')`), 'search resolves migrated keyword: ' + term);
    }
    await read(`(()=>{const s=document.getElementById('settingsSearchInput');s.value='';s.dispatchEvent(new Event('input'));})()`);
    await read(`document.getElementById('navInfo').click()`);
    await until(`document.querySelector('.about-hero-version')?.textContent.includes('0.')`);
    check(await read(`document.querySelectorAll('[data-about-update]').length===2 && !document.getElementById('aboutDiagnosticsRow') &&
      !document.querySelector('.about-hero-meta').textContent.includes('Windows')`), 'info uniquely owns both update sections, not runtime diagnostics');
    await shot('info-migrated');
    await read(`document.getElementById('navSystem').click()`);
    await until(`document.getElementById('system-runtime-feedback')?.textContent.includes('当前快照')`);
    check(await read(`document.querySelector('.system-settings-card').textContent.includes('宿主 Node.js') &&
      document.querySelector('.system-settings-card').textContent.includes('操作系统')`), 'system owns runtime snapshot without dependency installers');
    await shot('system-runtime');
    await read(`document.dispatchEvent(new CustomEvent('pi-gui:open-logs',{cancelable:true,detail:{initialTab:'export'}}))`);
    await until(`document.getElementById('ui5-log-tab-export')?.getAttribute('aria-selected')==='true'`);
    check((await facts()).selected === 'page', 'historical wizard diagnostics intent uses same central destination');
    for (let i = 0; i < 5; i++) { await open(); await read(`document.getElementById('navInfo').click()`); }
    await open(); await selectTab('overview');
    check((await facts()).count === 1 && await read(`document.querySelectorAll('link[href*="ui5-logs.css"]').length===1`), 'repeated navigation retains one page and stylesheet');
    check(errors.length === 0, 'no renderer/harness errors', errors);
  } finally {
    clearTimeout(timeout);
    const failed = checks.filter(c => !c.pass).length;
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ passed: checks.length - failed, failed, checks,
      screenshots: shots, errors, electron: process.versions.electron, chrome: process.versions.chrome, sandbox: true }, null, 2));
    console.log(`Logs Electron: ${checks.length - failed}/${checks.length}, failed=${failed}, screenshots=${shots.length}, evidence=${OUT}`);
    if (harness) try { harness.kill(); } catch { /* already exited */ }
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(failed || errors.length ? 1 : 0);
  }
}
