/* Real-Electron visual and interaction acceptance for Appearance settings.
 *
 * Runs the actual renderer, the real preload font bridge and the real Windows
 * font enumerator against the offline visual harness. No real project, Pi
 * process or user data is touched; screenshots land in `.shots/appearance/`.
 */
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.shots', 'appearance');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-appearance-'));
  env.APPEARANCE_WORLD = world;
  const child = spawn(require('electron'), [__filename, '--no-sandbox'], { env, stdio: 'inherit', windowsHide: true });
  child.on('exit', (code) => {
    fs.rm(world, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }, () => {});
    process.exit(code ?? 0);
  });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { createSystemFontIpc } = require(path.join(ROOT, 'electron/system-fonts.cjs'));

  app.on('window-all-closed', () => {});
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function run() {
    const world = process.env.APPEARANCE_WORLD;
    app.setPath('userData', world);
    fs.mkdirSync(OUT, { recursive: true });
    await app.whenReady();

    const harness = spawn(process.execPath, [path.join(ROOT, 'tests/visual-harness.cjs')], {
      cwd: world,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    harness.stderr.on('data', (chunk) => process.stderr.write('harness: ' + chunk));
    const origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Harness startup timeout')), 15000);
      harness.stdout.on('data', (chunk) => {
        const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      harness.once('error', reject);
    });
    console.log('harness ' + origin);

    let win = null;
    const fontIpc = createSystemFontIpc({ ipcMain, getWindow: () => win, origin });
    fontIpc.register();

    const consoleErrors = [];
    win = new BrowserWindow({
      width: 1320,
      height: 820,
      useContentSize: true,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#18181b',
      webPreferences: {
        preload: path.join(ROOT, 'electron/preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: ['--pi-gui-font-bridge'],
        backgroundThrottling: false
      }
    });
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3 && !message.includes('Electron Security Warning')) consoleErrors.push(message);
    });
    win.webContents.on('render-process-gone', (_event, details) => consoleErrors.push('render-process-gone:' + details.reason));

    const read = (expression) => win.webContents.executeJavaScript(expression);
    async function key(keyName, code, vk, modifiers = 0) {
      for (const type of ['keyDown', 'keyUp']) {
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: keyName, code, windowsVirtualKeyCode: vk, modifiers });
      }
      await sleep(120);
    }
    async function waitFor(expression, label, attempts = 120) {
      for (let index = 0; index < attempts; index += 1) {
        if (await read(expression).catch(() => false)) return;
        await sleep(50);
      }
      const diagnostics = await read(`(()=>({view:document.querySelector('.stage')?.dataset.workspaceView,settings:!!document.querySelector('.settings-surface'),detail:document.querySelector('.settings-detail-card')?.innerText?.slice(0,200),menuHidden:document.querySelector('#globalMoreMenu')?.hidden,trigger:!!document.querySelector('.appearance-theme-trigger'),body:document.querySelector('#modalCard')?.innerText?.slice(0,200)}))()`).catch((error) => ({ error: String(error) }));
      throw new Error('Timeout: ' + label + ' ' + JSON.stringify({ diagnostics, consoleErrors }));
    }
    let checks = 0;
    const failures = [];
    function check(pass, label, detail) {
      checks += 1;
      if (pass) console.log('ok ' + checks + ' - ' + label);
      else { failures.push(label); console.error('FAIL ' + label + (detail === undefined ? '' : ' ' + JSON.stringify(detail))); }
    }
    const screenshots = [];
    async function shot(name) {
      await sleep(180);
      // capturePage is a native GPU capture. Wait for two committed frames so a
      // reload/resize transition cannot race the compositor (UnknownVizError),
      // but never wait forever if the window is occluded and rAF is suspended.
      await read(`new Promise((resolve) => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(true); } };
        requestAnimationFrame(() => requestAnimationFrame(finish));
        setTimeout(finish, 500);
      })`);
      const image = await win.webContents.capturePage();
      const file = path.join(OUT, name + '.png');
      fs.writeFileSync(file, image.toPNG());
      screenshots.push(path.relative(ROOT, file));
      console.log('shot ' + name + ' ' + JSON.stringify(image.getSize()));
    }
    async function openAppearance() {
      if (await read(`document.querySelector('#modal').hidden === false`)) await read(`document.querySelector('#modal').hidden = true`);
      await read(`document.querySelector('#navGlobalMore').click()`);
      await waitFor(`document.querySelector('#globalMoreMenu') && !document.querySelector('#globalMoreMenu').hidden`, 'settings menu');
      await read(`document.querySelector('#navAppearance').click()`);
      await waitFor(`!!document.querySelector('.appearance-theme-row .settings-theme-trigger')`, 'appearance page');
    }
    async function openFontMenu() {
      await read(`document.querySelector('.settings-font-trigger').click()`);
      await waitFor(`!!document.querySelector('.pi-anchored-menu.is-open')`, 'font menu');
      await waitFor(`document.querySelectorAll('.settings-font-option').length > 0`, 'font options');
    }
    async function closeMenu() {
      await read(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
      await waitFor(`!document.querySelector('.pi-anchored-menu')`, 'menu closed');
    }
    async function searchFont(text) {
      await read(`(()=>{const input=document.querySelector('.settings-font-search-input');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await sleep(120);
    }
    async function chooseFont(label) {
      const clicked = await read(`(()=>{const target=[...document.querySelectorAll('.settings-font-option')].find(node=>node.textContent.trim()===${JSON.stringify(label)});if(!target)return false;target.click();return true})()`);
      if (!clicked) throw new Error('Font option not rendered: ' + label);
      await waitFor(`!document.querySelector('.pi-anchored-menu')`, 'font menu closed after choose');
    }
    async function chooseTheme(label) {
      await read(`document.querySelector('.settings-theme-trigger').click()`);
      await waitFor(`!!document.querySelector('.settings-theme-menu-anchored.is-open')`, 'theme menu');
      const clicked = await read(`(()=>{const target=[...document.querySelectorAll('.settings-theme-option')].find(node=>node.textContent.trim()===${JSON.stringify(label)});if(!target)return false;target.click();return true})()`);
      if (!clicked) throw new Error('Theme option not rendered: ' + label);
      await waitFor(`!document.querySelector('.pi-anchored-menu')`, 'theme menu closed after choose');
    }
    const rootFont = () => read(`getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim()`);
    const rootMono = () => read(`getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()+'|'+getComputedStyle(document.documentElement).getPropertyValue('--ui-font-mono').trim()`);

    try {
      await win.loadURL(origin);
      await waitFor(`document.querySelector('#connText')?.textContent==='已连接'`, 'fixture connected');
      await waitFor(`typeof window.piGuiDesktop?.fonts?.list==='function'`, 'real preload font bridge');
      win.showInactive();
      win.webContents.debugger.attach('1.3');

      // Real enumeration crosses the actual IPC and PowerShell path.
      const ipcList = await read(`window.piGuiDesktop.fonts.list()`);
      check(ipcList?.ok === true, 'real IPC returns an ok font list', ipcList && { code: ipcList.code });
      check(Array.isArray(ipcList?.fonts) && ipcList.fonts.length > 100, 'real Windows enumeration returns a full font list', ipcList?.fonts?.length);
      check(ipcList.fonts.includes('微软雅黑') && ipcList.fonts.includes('Consolas'), 'real list keeps Chinese names and known families');

      await sleep(400);
      await openAppearance();
      await waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim()!==''`, 'initial font stack');

      const rows = await read(`(()=>{const r=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return {height:b.height,top:b.top,bottom:b.bottom}};return {theme:r('.appearance-theme-row'),font:r('.appearance-font-row'),size:r('.appearance-size-row'),selects:document.querySelectorAll('.appearance-body select').length,themeText:document.querySelector('.settings-theme-trigger').textContent.trim(),fontText:document.querySelector('.settings-font-trigger').textContent.trim()}})()`);
      check(rows.selects === 0, 'appearance uses no native select');
      check(rows.themeText === '深色', 'theme trigger reads the current preference', rows.themeText);
      check(rows.theme.height >= 64 && rows.font.height >= 64 && rows.size.height >= 64, 'theme/font/size rows share usable height', rows);
      check(await read(`document.documentElement.dataset.theme==='dark'`), 'default theme is dark');
      check(await read(`document.querySelector('.ds-slider-val').textContent.trim()==='100%' && getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim()==='1.00'`), 'fresh appearance keeps the default 100% scale');
      await shot('1320-dark-appearance');

      const monoBefore = await rootMono();
      const themeMenu = await (async () => {
        await read(`document.querySelector('.settings-theme-trigger').click()`);
        await waitFor(`!!document.querySelector('.settings-theme-menu-anchored.is-open')`, 'theme menu open');
        await waitFor(`document.activeElement===document.querySelector('.settings-theme-menu-anchored input')`, 'theme search focus', 30);
        return read(`(()=>{const menu=document.querySelector('.pi-anchored-menu');const input=menu.querySelector('input');const b=menu.getBoundingClientRect();return {fixed:getComputedStyle(menu).position,inside:b.left>=0&&b.top>=0&&b.right<=innerWidth+0.5&&b.bottom<=innerHeight+0.5,width:b.width,focused:document.activeElement===input,options:menu.querySelectorAll('[role="option"]').length,selected:menu.querySelector('[aria-selected="true"]')?.textContent.trim(),check:!!menu.querySelector('[aria-selected="true"] .settings-theme-check'),bg:getComputedStyle(menu).backgroundColor,shadow:getComputedStyle(menu).boxShadow}})()`);
      })();
      check(themeMenu.fixed === 'fixed', 'theme menu is a fixed portal layer');
      check(themeMenu.inside && themeMenu.width >= 200, 'theme menu fits inside the window', themeMenu);
      check(themeMenu.focused, 'theme search keeps focus');
      check(themeMenu.options === 3 && themeMenu.selected === '深色' && themeMenu.check, 'theme menu shows three options and checks the current one', themeMenu);
      check(themeMenu.bg !== 'rgba(0, 0, 0, 0)' && themeMenu.shadow !== 'none', 'theme menu uses the elevated surface tokens');
      await shot('1320-dark-theme-menu');
      await closeMenu();
      check(await read(`document.activeElement.matches('.settings-theme-trigger')`), 'Escape closes theme menu and restores trigger focus');

      await openFontMenu();
      await waitFor(`document.activeElement===document.querySelector('.settings-font-search-input')`, 'font search focus', 30);
      const fontMenuState = await read(`(()=>{const menu=document.querySelector('.pi-anchored-menu');const list=menu.querySelector('.settings-font-list');const viewport=menu.querySelector('.settings-font-viewport');const b=menu.getBoundingClientRect();const input=menu.querySelector('.settings-font-search-input');const options=[...menu.querySelectorAll('.settings-font-option')];return {fixed:getComputedStyle(menu).position,inside:b.left>=0&&b.top>=0&&b.right<=innerWidth+0.5&&b.bottom<=innerHeight+0.5,width:b.width,focused:document.activeElement===input,placeholder:input.placeholder,rendered:options.length,totalHeight:parseFloat(viewport.style.height),scrollable:list.scrollHeight>list.clientHeight,rowHeights:options.slice(0,6).map(o=>Math.round(o.getBoundingClientRect().height)),firstLabels:options.slice(0,3).map(o=>o.textContent.trim()),groups:[...menu.querySelectorAll('.settings-font-group')].map(n=>n.textContent)}})()`);
      check(fontMenuState.fixed === 'fixed' && fontMenuState.inside, 'font menu is a fixed layer inside the window', fontMenuState);
      check(fontMenuState.focused && fontMenuState.placeholder === '搜索字体…', 'font search input is focused');
      check(fontMenuState.rendered > 0 && fontMenuState.rendered < 100, 'font menu mounts a windowed slice, not every family', fontMenuState.rendered);
      check(fontMenuState.totalHeight > 5000 && fontMenuState.scrollable, 'virtual list reserves the full scroll height', fontMenuState.totalHeight);
      check(fontMenuState.rowHeights.every((height) => height === 32), 'font rows keep a uniform height', fontMenuState.rowHeights);
      check(fontMenuState.groups.includes('默认') && fontMenuState.groups.includes('系统字体'), 'font groups include default and installed fonts', fontMenuState.groups);
      await shot('1320-dark-font-menu');

      await searchFont('雅黑');
      const searchState = await read(`(()=>{const options=[...document.querySelectorAll('.settings-font-option')];return {count:options.length,label:options[0]?.textContent.trim(),focused:document.activeElement?.classList.contains('settings-font-search-input')}})()`);
      check(searchState.count === 1 && searchState.label === '微软雅黑', 'CJK search narrows the list to 微软雅黑', searchState);
      check(searchState.focused, 'searching does not steal focus');
      await shot('1320-dark-font-search');
      await searchFont('');
      await read(`document.querySelector('.settings-font-list').scrollTop=1200`);
      await sleep(200);
      await shot('1320-dark-font-scroll');

      await searchFont('微软雅黑');
      await chooseFont('微软雅黑');
      const chineseStack = await rootFont();
      check(/微软雅黑/.test(chineseStack) && /Microsoft YaHei/.test(chineseStack), 'Chinese family applies to the UI stack with CJK fallback', chineseStack);
      const chineseConsumers = await read(`({body:getComputedStyle(document.body).fontFamily,input:getComputedStyle(document.querySelector('#input')).fontFamily,button:getComputedStyle(document.querySelector('.btn')).fontFamily,nav:getComputedStyle(document.querySelector('.nav-item')).fontFamily})`);
      check(Object.values(chineseConsumers).every((stack) => /微软雅黑/.test(stack)), 'body, composer input, buttons and nav all consume the selected family', chineseConsumers);
      check(await read(`document.querySelector('.settings-font-trigger').textContent.trim()==='微软雅黑'`), 'font trigger shows the Chinese family');
      check(await read(`localStorage.getItem('pi-gui.font-family.v2')?.includes('微软雅黑')`), 'font choice persists as a full v2 stack');
      check((await rootMono()) === monoBefore, 'code/terminal mono variables are untouched');
      await shot('1320-dark-font-chinese');

      await openFontMenu();
      await searchFont('Georgia');
      await chooseFont('Georgia');
      const englishStack = await rootFont();
      check(/^['"]?Georgia['"]?/.test(englishStack) && /Microsoft YaHei/.test(englishStack), 'English family keeps a CJK fallback in the stack', englishStack);
      const englishBody = await read(`getComputedStyle(document.body).fontFamily`);
      check(/^['"]?Georgia['"]?/.test(englishBody) && /Microsoft YaHei/.test(englishBody), 'body consumes Georgia while keeping the CJK fallback', englishBody);
      await shot('1320-dark-font-english');

      await read(`(()=>{const slider=document.querySelector('.appearance-size-row input[type="range"]');slider.value='130';slider.dispatchEvent(new Event('input',{bubbles:true}));slider.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await sleep(200);
      const scale = await read(`({value:getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim(),percent:document.querySelector('.ds-slider-val').textContent.trim(),selected:document.querySelector('.appearance-size-row .is-active')?.textContent.trim()})`);
      check(scale.value === '1.30' && scale.percent === '130%', 'font size applies and reports 130%', scale);
      check(scale.selected === '超超大杯', 'size preset follows the slider', scale.selected);
      const scaledText = await read(`({row:parseFloat(getComputedStyle(document.querySelector('.appearance-theme-row .settings-row-title')).fontSize),trigger:parseFloat(getComputedStyle(document.querySelector('.settings-theme-trigger')).fontSize)})`);
      check(scaledText.row > 15 && scaledText.trigger > 14, 'interface text previews the larger scale immediately', scaledText);
      check(await read(`localStorage.getItem('pi-gui.font-scale.v1')==='130'`), 'font size persists');
      check(win.webContents.getZoomFactor() === 1, 'window zoom is unchanged by font scaling');
      await shot('1320-dark-font-size-130');

      await chooseTheme('浅色');
      await waitFor(`document.documentElement.dataset.theme==='light'`, 'light theme applied');
      check(await read(`document.documentElement.dataset.themePreference==='light'`), 'light preference persists through the existing theme controller');
      await shot('1320-light-appearance');

      await read(`document.querySelector('.settings-theme-trigger').click()`);
      await waitFor(`!!document.querySelector('.settings-theme-menu-anchored.is-open')`, 'light theme menu');
      await shot('1320-light-theme-menu');
      await closeMenu();

      await openFontMenu();
      await searchFont('微软雅黑');
      await shot('1320-light-font-search');
      await chooseFont('微软雅黑');
      await shot('1320-light-font-chinese');

      await openFontMenu();
      await sleep(120);
      await shot('1320-light-font-menu');
      await closeMenu();

      // Narrow window: menus must reposition and stay usable.
      win.setContentSize(700, 600);
      await sleep(350);
      const narrow = await read(`({inner:[innerWidth,innerHeight],scroll:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],themeRow:document.querySelector('.appearance-theme-row').getBoundingClientRect().width,fontRow:document.querySelector('.appearance-font-row').getBoundingClientRect().width,themeTrigger:document.querySelector('.settings-theme-trigger').getBoundingClientRect().right,fontTrigger:document.querySelector('.settings-font-trigger').getBoundingClientRect().right})`);
      check(narrow.scroll[0] <= narrow.inner[0] + 1, '700px layout has no horizontal page overflow', narrow);
      check(narrow.themeTrigger <= narrow.inner[0] && narrow.fontTrigger <= narrow.inner[0], 'both triggers stay inside the 700px viewport', narrow);
      await shot('700-light-appearance');

      await read(`document.querySelector('.settings-theme-trigger').click()`);
      await waitFor(`!!document.querySelector('.settings-theme-menu-anchored.is-open')`, 'narrow theme menu');
      const narrowTheme = await read(`(()=>{const b=document.querySelector('.pi-anchored-menu').getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,w:innerWidth,h:innerHeight}})()`);
      check(narrowTheme.left >= 0 && narrowTheme.right <= narrowTheme.w + 0.5 && narrowTheme.top >= 0 && narrowTheme.bottom <= narrowTheme.h + 0.5, 'narrow theme menu clamps inside the viewport', narrowTheme);
      await shot('700-light-theme-menu');
      await closeMenu();

      await openFontMenu();
      const narrowFont = await read(`(()=>{const b=document.querySelector('.pi-anchored-menu').getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,w:innerWidth,h:innerHeight}})()`);
      check(narrowFont.left >= 0 && narrowFont.right <= narrowFont.w + 0.5 && narrowFont.top >= 0 && narrowFont.bottom <= narrowFont.h + 0.5, 'narrow font menu clamps inside the viewport', narrowFont);
      await shot('700-light-font-menu');
      win.setContentSize(1320, 820);
      await sleep(350);
      const resizedMenu = await read(`(()=>{const b=document.querySelector('.pi-anchored-menu')?.getBoundingClientRect();return b?{left:b.left,right:b.right,top:b.top,bottom:b.bottom,w:innerWidth,h:innerHeight}:null})()`);
      check(resizedMenu && resizedMenu.left >= 0 && resizedMenu.right <= resizedMenu.w + 0.5 && resizedMenu.top >= 0 && resizedMenu.bottom <= resizedMenu.h + 0.5, 'open menu repositions when the window grows', resizedMenu);
      await closeMenu();
      win.setContentSize(700, 600);
      await sleep(300);

      await chooseTheme('深色');
      await waitFor(`document.documentElement.dataset.theme==='dark'`, 'dark theme re-applied');
      await openFontMenu();
      await shot('700-dark-font-menu');
      await closeMenu();
      await shot('700-dark-appearance');

      // Restart restore: reload keeps the saved font and scale before interaction.
      await win.webContents.reload();
      await waitFor(`document.querySelector('#connText')?.textContent==='已连接'`, 'reload connected');
      await waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim()!==''`, 'prepaint font after reload');
      const restored = await read(`({font:getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim(),scale:getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim(),theme:document.documentElement.dataset.theme})`);
      check(/微软雅黑/.test(restored.font), 'saved font restores before interaction after reload', restored.font);
      check(restored.scale === '1.30', 'saved font scale restores after reload', restored.scale);
      await win.setContentSize(1320, 820);
      await sleep(300);
      await openAppearance();
      check(await read(`document.querySelector('.settings-font-trigger').textContent.trim()==='微软雅黑'`), 'appearance shows the restored font');
      await shot('1320-dark-restored');

      // Real keyboard path: Enter opens the picker, typing filters, Enter commits.
      await read(`document.querySelector('.settings-font-trigger').focus()`);
      await key('Enter', 'Enter', 13);
      await waitFor(`!!document.querySelector('.settings-font-menu-anchored.is-open')`, 'keyboard font menu');
      await waitFor(`document.activeElement===document.querySelector('.settings-font-search-input')`, 'keyboard search focus', 30);
      await win.webContents.debugger.sendCommand('Input.insertText', { text: 'Georgia' });
      await sleep(150);
      await key('Enter', 'Enter', 13);
      await waitFor(`document.querySelector('.settings-font-trigger')?.textContent.trim()==='Georgia'`, 'keyboard font applied');
      check(/^['"]?Georgia['"]?/.test(await rootFont()), 'keyboard selection applies Georgia');
      await key('Enter', 'Enter', 13);
      await waitFor(`!!document.querySelector('.settings-font-menu-anchored.is-open')`, 'keyboard font menu reopened');
      await key('Escape', 'Escape', 27);
      check(await read(`!document.querySelector('.pi-anchored-menu') && document.activeElement.matches('.settings-font-trigger')`), 'keyboard menu handles Escape and focus');

      await key('Escape', 'Escape', 27);
      await sleep(250);
      check(await read(`!document.querySelector('.appearance-theme-row') && document.activeElement.id==='navAppearance'`), 'Escape leaves appearance and returns focus to its settings entry');
      await openAppearance();

      // Leaving the settings surface disposes an open menu.
      await openFontMenu();
      await read(`document.querySelector('#navHome').click()`);
      await sleep(300);
      check(await read(`!document.querySelector('.pi-anchored-menu')`), 'leaving settings closes the portaled menu');
      check(await read(`!document.querySelector('.appearance-theme-row')`), 'settings detail is disposed');

      check(consoleErrors.length === 0, 'no renderer console errors', consoleErrors);
      console.log(`\nAppearance Electron: ${checks - failures.length}/${checks} checks passed; screenshots=${screenshots.length}`);
      if (failures.length) console.error('FAILED: ' + failures.join(' | '));
      fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, failures, screenshots, consoleErrors }, null, 2));
      app.exit(failures.length ? 1 : 0);
    } finally {
      fontIpc.dispose();
      harness.kill();
      if (win && !win.isDestroyed()) win.destroy();
    }
  }

  run().catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
