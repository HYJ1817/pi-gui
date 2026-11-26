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
    const openPicker = async field => {
      const point = await read(`(()=>{const trigger=document.querySelector('[data-field="${field}"]');
        if(!trigger) return null;trigger.scrollIntoView({ block: 'nearest' });
        const r=trigger.getBoundingClientRect();
        return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
      if (!point) throw new Error('missing picker ' + field);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await until(`Boolean(document.querySelector('.pi-anchored-menu.ds-picker-menu'))`);
      await sleep(80);
    };
    const escapeMenu = async () => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await until(`!document.querySelector('.pi-anchored-menu')`);
    };
    const menuFacts = () => read(`(()=>{
      const menu=document.querySelector('.pi-anchored-menu.ds-picker-menu');
      if(!menu) return null;
      const b=menu.getBoundingClientRect(), s=getComputedStyle(menu);
      const opts=[...menu.querySelectorAll('.ds-picker-option')];
      const selected=menu.querySelector('.ds-picker-option.is-selected');
      const focused=document.activeElement?.closest?.('.ds-picker-option');
      const trigger=document.querySelector('[data-field][aria-expanded="true"]');
      const tb=trigger?.getBoundingClientRect();
      const gap=tb?(b.top>=tb.bottom?b.top-tb.bottom:tb.top-b.bottom):null;
      return {portal:menu.parentElement===document.body,position:s.position,
        inside:b.left>=0&&b.top>=0&&b.right<=innerWidth+0.5&&b.bottom<=innerHeight+0.5,
        menuTop:Math.round(b.top),menuBottom:Math.round(b.bottom),
        triggerTop:tb?Math.round(tb.top):null,triggerBottom:tb?Math.round(tb.bottom):null,
        gap:gap===null?null:Math.round(gap),
        width:Math.round(b.width),height:Math.round(b.height),bg:s.backgroundColor,color:s.color,
        radius:s.borderTopLeftRadius,shadow:s.boxShadow,options:opts.length,
        optionHeight:opts[0]?Math.round(opts[0].getBoundingClientRect().height):0,
        optionFont:opts[0]?getComputedStyle(opts[0]).fontSize:'',
        selected:selected?.textContent.trim()||'',selectedBg:selected?getComputedStyle(selected).backgroundColor:'',
        focused:focused?.textContent.trim()||'',focusBg:focused?getComputedStyle(focused).backgroundColor:'',
        focusOutline:focused?getComputedStyle(focused).outlineStyle:'',
        hovered:Boolean(opts[1]?.matches(':hover')),hoverBg:opts[1]?getComputedStyle(opts[1]).backgroundColor:'',
        nativeSelects:document.querySelectorAll('.ui5-logs-modal select').length,
        trigger:trigger?.dataset.field||'',triggerHaspopup:trigger?.getAttribute('aria-haspopup')||'',
        activeField:document.activeElement?.dataset?.field||'',
        triggerFocused:trigger===document.activeElement,
        triggerOutline:trigger?getComputedStyle(trigger).outline:'',
        triggerBorder:trigger?getComputedStyle(trigger).borderTopColor:''};
    })()`);
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
      document.querySelector('[data-field="mode"]').getAttribute('aria-haspopup')==='listbox' &&
      document.querySelectorAll('.ui5-logs-modal select').length===0`), 'shared switch + custom listbox, no native selects');
    const flat = await read(`(()=>{
      const rows=[...document.querySelectorAll('.ui5-logs-settings .settings-row')];
      const summary=[...document.querySelectorAll('.ui5-logs-summary > div')];
      const panel=document.querySelector('.ui5-logs-settings .settings-panel');
      const style=row=>getComputedStyle(row);
      return {count:rows.length,
        backgrounds:rows.map(row=>style(row).backgroundColor),
        radii:rows.map(row=>style(row).borderTopLeftRadius),
        borders:rows.map(row=>parseFloat(style(row).borderTopWidth)),
        paddings:rows.map(row=>style(row).paddingLeft),
        heights:rows.map(row=>Math.round(row.getBoundingClientRect().height)),
        widths:rows.map(row=>Math.round(row.getBoundingClientRect().width)),
        summaryHeights:summary.map(row=>Math.round(row.getBoundingClientRect().height)),
        summaryBackgrounds:summary.map(row=>style(row).backgroundColor),
        panelGap:style(panel).rowGap,panelBackground:style(panel).backgroundColor,panelPadding:style(panel).paddingLeft,
        sectionWidth:Math.round(document.querySelector('.ui5-logs-settings').getBoundingClientRect().width)};
    })()`);
    check(flat.count === 4 && flat.backgrounds.every(bg => bg === 'rgba(0, 0, 0, 0)') &&
      flat.radii.every(radius => radius === '0px') && flat.borders[0] === 0 &&
      flat.borders.slice(1).every(width => width > 0 && width < 2) &&
      flat.paddings.every(padding => padding === '0px') && flat.panelGap === '0px' &&
      flat.panelBackground === 'rgba(0, 0, 0, 0)' && flat.panelPadding === '0px' &&
      flat.widths.every(width => width === flat.sectionWidth), 'settings rows are flat continuous lines with no per-row tiles', flat);
    check(flat.summaryHeights.every(height => Math.abs(height - flat.heights[0]) <= 1) &&
      flat.summaryBackgrounds.every(bg => bg === 'rgba(0, 0, 0, 0)') && flat.heights[0] === 56,
      'log status and log settings share the same flat 56px row rhythm', flat);
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
    await openPicker('exportRange');
    await read(`document.querySelector('.ds-picker-menu [data-value="120"]').click()`);
    await sleep(120);
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
          if (id === 'overview' && width === 1440) {
            await read(`document.querySelector('.ui5-logs-disclosure summary')?.click()`);
            await sleep(100);
            await read(`(()=>{const s=document.getElementById('workSurface');s.scrollTop=s.scrollHeight;})()`);
            await sleep(160);
            await shot(`logs-${theme}-1440-overview-bottom`);
            const clear = await read(`(()=>{const row=document.querySelector('.ui5-logs-clear-row');
              if(!row) return null;const b=row.querySelector('button'),s=getComputedStyle(row);
              return {bg:s.backgroundColor,radius:s.borderTopLeftRadius,border:s.borderTopWidth,
                button:b?.textContent||'',disabled:Boolean(b?.disabled)};})()`);
            check(clear && clear.bg === 'rgba(0, 0, 0, 0)' && parseFloat(clear.radius) === 0 &&
              clear.button.startsWith('清理') && !clear.disabled,
              `overview clear row stays in the flat list ${theme}`, clear);
            await read(`document.querySelector('.ui5-logs-disclosure[open] summary')?.click();
              document.getElementById('workSurface').scrollTop=0`);
          }
          if (width === 1440) {
            const fields = id === 'overview' ? ['mode', 'retention', 'capacity']
              : id === 'logs' ? ['level', 'source'] : ['exportRange'];
            for (const field of fields) {
              await openPicker(field);
              if (field === 'mode') {
                const point = await read(`(()=>{const option=document.querySelectorAll('.ds-picker-option')[1];
                  if(!option) return null;const r=option.getBoundingClientRect();
                  return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
                if (point) { win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y }); await sleep(80); }
              }
              const m = await menuFacts();
              check(m && m.portal && m.position === 'fixed' && m.inside && m.bg !== 'rgba(0, 0, 0, 0)' &&
                m.color && m.radius !== '0px' && m.shadow !== 'none' && m.options > 1 && m.optionHeight >= 30 &&
                m.nativeSelects === 0 && m.trigger === field && m.triggerHaspopup === 'listbox' &&
                (!m.selected || m.selectedBg !== 'rgba(0, 0, 0, 0)') && m.focusOutline === 'none' &&
                (m.gap === null || m.gap >= 0),
                `picker menu ${theme}-${id}-${field}`, m);
              if (field === 'mode') {
                check(m?.selected === '标准（INFO 及以上）' && m?.focused === '标准（INFO 及以上）' &&
                  m?.hovered && m?.hoverBg !== 'rgba(0, 0, 0, 0)',
                  `picker menu shows selected, keyboard focus and real hover ${theme}`, m);
              }
              await shot(`logs-${theme}-1440-${id}-${field}-menu`);
              await escapeMenu();
              check(await read(`document.activeElement?.dataset?.field === ${JSON.stringify(field)}`),
                `picker Escape closes and restores trigger focus ${theme}-${id}-${field}`);
            }
          }
          if (width === 1440 && theme === 'dark' && id === 'overview') {
            await openPicker('mode');
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
            await sleep(60);
            check(await read(`document.activeElement?.closest?.('.ds-picker-option')?.textContent.trim() === '详细（24 小时）' &&
              getComputedStyle(document.activeElement.closest('.ds-picker-option')).outlineStyle === 'solid'`),
              'picker keyboard navigation moves the active option and restores the focus ring');
            await escapeMenu();
            await openPicker('capacity');
            const point = await read(`(()=>{const h=document.querySelector('.ui5-logs-heading h2');
              if(!h) return null;const r=h.getBoundingClientRect();
              return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
            if (point) {
              win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
              win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
            }
            await until(`!document.querySelector('.pi-anchored-menu')`);
            check(true, 'picker closes on outside pointer down');
          }
          if (width === 700 && id === 'overview') {
            await openPicker('mode');
            const m = await menuFacts();
            check(m && m.inside, `narrow picker menu stays inside the viewport ${theme}`, m);
            await shot(`logs-${theme}-700-overview-mode-menu`);
            await escapeMenu();
          }
        }
      }
    }
    // Reference settings pages: read their row rhythm under both themes so the
    // visual comparison is against the running product, not an old screenshot.
    let appearanceRhythm = null;
    for (const theme of ['dark', 'light']) {
      win.setContentSize(1440, 960); win.webContents.setZoomFactor(1);
      await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await read(`document.getElementById('navAppearance').click()`);
      await until(`Boolean(document.querySelector('.appearance-body .settings-row'))`);
      await shot(`reference-appearance-${theme}`);
      appearanceRhythm = await read(`(()=>{const cs=element=>getComputedStyle(element);
        const row=document.querySelector('.appearance-body .settings-row');
        const title=row.querySelector('.settings-row-title');
        return {height:Math.round(row.getBoundingClientRect().height),font:cs(title).fontSize,weight:cs(title).fontWeight};})()`);
      await read(`document.getElementById('navShortcutHelp').click()`);
      await until(`Boolean(document.querySelector('.shortcut-row'))`);
      await shot(`reference-shortcuts-${theme}`);
      await read(`document.getElementById('navInfo').click()`);
      await until(`document.querySelector('.about-hero-version')?.textContent.includes('0.')`);
      await shot(`reference-info-${theme}`);
      await read(`document.getElementById('navLogs').click()`);
      await until(`Boolean(document.querySelector('[data-field="mode"]'))`);
      if (theme === 'dark') {
        const rhythm = await read(`(()=>{const cs=element=>getComputedStyle(element);
          const logRow=document.querySelector('.ui5-logs-settings .settings-row');
          const logTitle=logRow.querySelector('.settings-row-title');
          const summaryLabel=document.querySelector('.ui5-logs-summary dt');
          const summaryRow=document.querySelector('.ui5-logs-summary > div');
          return {logRowHeight:Math.round(logRow.getBoundingClientRect().height),
            summaryHeight:Math.round(summaryRow.getBoundingClientRect().height),logFont:cs(logTitle).fontSize,
            logWeight:cs(logTitle).fontWeight,summaryFont:cs(summaryLabel).fontSize,summaryWeight:cs(summaryLabel).fontWeight};})()`);
        check(rhythm.logFont === appearanceRhythm.font && rhythm.logWeight === appearanceRhythm.weight &&
          rhythm.summaryFont === appearanceRhythm.font && rhythm.summaryWeight === appearanceRhythm.weight &&
          Math.abs(rhythm.summaryHeight - rhythm.logRowHeight) <= 1,
          'log status/settings typography and rhythm match the live appearance reference',
          { ...rhythm, appearance: appearanceRhythm });
      }
    }
    // At scaled narrow width, long English and Chinese labels must wrap, not clip.
    win.setContentSize(900, 960); win.webContents.setZoomFactor(1.25);
    await selectTab('overview');
    await read(`document.querySelector('#navLogs > span').textContent='Logs and diagnostics · 日志与诊断';
      document.querySelector('[data-field="mode"] .ds-picker-label').textContent='Standard logging (INFO and above)';`);
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
