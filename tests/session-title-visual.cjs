/* Real-Electron visual acceptance for AI session titles.
 *
 * Drives the actual renderer against the offline visual harness:
 *   - the "常规" settings card at 1320×820 / 700×600, dark and light;
 *   - switch states (on / off / hover / keyboard focus / saving / error);
 *   - the session overflow menu with "AI 生成标题" at the same four combos;
 *   - an English AI title applied through the real SSE → in-place update path.
 *
 * No real project, Pi process or user data is touched. Screenshots land in
 * `.shots/session-title/`; results.json records the actual CSS viewports, DPR,
 * console errors and check outcomes. Not part of `npm test` (it needs Electron).
 *
 * Usage: node tests/session-title-visual.cjs
 */
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.shots', 'session-title');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-title-visual-'));
  env.TITLE_VISUAL_WORLD = world;
  const child = spawn(require('electron'), [__filename, '--no-sandbox'], { env, stdio: 'inherit', windowsHide: true });
  child.on('exit', (code) => {
    fs.rm(world, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }, () => {});
    process.exit(code ?? 0);
  });
} else {
  const { app, BrowserWindow } = require('electron');

  app.on('window-all-closed', () => {});
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function run() {
    const world = process.env.TITLE_VISUAL_WORLD;
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

    const consoleErrors = [];
    const win = new BrowserWindow({
      width: 1320,
      height: 820,
      useContentSize: true,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#18181b',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3 && !message.includes('Electron Security Warning')) consoleErrors.push(message);
    });
    win.webContents.on('render-process-gone', (_event, details) => consoleErrors.push('render-process-gone:' + details.reason));

    const read = (expression) => win.webContents.executeJavaScript(expression);
    async function key(keyName, code, vk) {
      for (const type of ['keyDown', 'keyUp']) {
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: keyName, code, windowsVirtualKeyCode: vk });
      }
      await sleep(120);
    }
    async function waitFor(expression, label, attempts = 120) {
      for (let index = 0; index < attempts; index += 1) {
        if (await read(expression).catch(() => false)) return;
        await sleep(50);
      }
      const diagnostics = await read(`(()=>({view:document.querySelector('.stage')?.dataset.workspaceView,title:document.querySelector('#title')?.textContent,card:!!document.querySelector('.appearance-title-card'),menu:!!document.querySelector('#actionMenu'),status:document.querySelector('.appearance-status')?.textContent,theme:document.documentElement.dataset.theme}))()`).catch((error) => ({ error: String(error) }));
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
    const combos = [];
    async function shot(name) {
      await sleep(160);
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
    async function viewport(label) {
      const info = await read(`({innerWidth,innerHeight,devicePixelRatio,scrollWidth:document.documentElement.scrollWidth,theme:document.documentElement.dataset.theme})`);
      combos.push({ label, ...info });
      check(info.scrollWidth <= info.innerWidth + 1, label + ': no horizontal page overflow', info);
      return info;
    }
    async function openSettings() {
      if (await read(`!!document.querySelector('.appearance-title-card')`)) return;
      if (await read(`document.querySelector('#modal') && document.querySelector('#modal').hidden === false`)) {
        await read(`document.querySelector('#modal').hidden = true`);
      }
      await read(`document.querySelector('#navGlobalMore').click()`);
      await waitFor(`document.querySelector('#globalMoreMenu') && !document.querySelector('#globalMoreMenu').hidden`, 'settings menu');
      await read(`document.querySelector('#navAppearance').click()`);
      await waitFor(`!!document.querySelector('.appearance-title-card')`, 'title settings card');
    }
    async function leaveSettings() {
      if (!(await read(`!!document.querySelector('.appearance-title-card')`))) return;
      await key('Escape', 'Escape', 27);
      try {
        await waitFor(`!document.querySelector('.appearance-title-card')`, 'settings detail closed');
      } catch {
        /* reload 后第一次 Escape 偶尔落在焦点切换的间隙里；补按一次，
         * 不改产品行为，只避免测试把偶发当回归。 */
        await key('Escape', 'Escape', 27);
        await waitFor(`!document.querySelector('.appearance-title-card')`, 'settings detail closed');
      }
      await read(`document.querySelector('#navHome').click()`);
      await waitFor(`document.querySelector('.stage')?.dataset.workspaceView!=='settings' && !!document.querySelector('#projects .pj-sess')`, 'back to app');
      await sleep(220);
    }
    async function chooseTheme(label) {
      await read(`document.querySelector('.settings-theme-trigger').click()`);
      await waitFor(`!!document.querySelector('.settings-theme-menu-anchored.is-open')`, 'theme menu');
      const clicked = await read(`(()=>{const target=[...document.querySelectorAll('.settings-theme-option')].find(node=>node.textContent.trim()===${JSON.stringify(label)});if(!target)return false;target.click();return true})()`);
      if (!clicked) throw new Error('Theme option not rendered: ' + label);
      await waitFor(`!document.querySelector('.pi-anchored-menu')`, 'theme menu closed');
    }
    async function scrollTitleCard() {
      await read(`document.querySelector('.appearance-title-card').scrollIntoView({block:'center'})`);
      await sleep(180);
    }
    const titleCard = () => read(`(()=>{
      const card=document.querySelector('.appearance-title-card');
      if(!card) return null;
      const rows=[...card.querySelectorAll('.settings-row')];
      const sw=card.querySelector('.ds-switch');
      const model=card.querySelector('.session-title-model-value');
      const b=card.getBoundingClientRect();
      const modelRect=model?model.getBoundingClientRect():null;
      const swRect=sw?sw.getBoundingClientRect():null;
      return {
        card:!!card,
        rows:rows.length,
        titles:rows.map(r=>r.querySelector('.settings-row-title')?.textContent.trim()),
        details:rows.map(r=>r.querySelector('.settings-row-detail')?.textContent.trim()||''),
        model:model?model.textContent.trim():'',
        modelInside:!!modelRect&&modelRect.right<=innerWidth+0.5,
        cardW:Math.round(b.width),
        cardInside:b.left>=0&&b.right<=innerWidth+0.5,
        rowHeights:rows.map(r=>Math.round(r.getBoundingClientRect().height)),
        switch:{role:sw?.getAttribute('role'),label:sw?.getAttribute('aria-label'),checked:sw?.getAttribute('aria-checked'),disabled:Boolean(sw?.disabled),w:Math.round(swRect?.width||0),h:Math.round(swRect?.height||0)},
        status:document.querySelector('.appearance-status')?.hidden===false?document.querySelector('.appearance-status').textContent.trim():'',
        statusError:document.querySelector('.appearance-status')?.classList.contains('is-error')===true
      };
    })()`);
    async function openHistoryMenu() {
      const opened = await read(`(()=>{
        const row=document.querySelector('#projects .pj-sess[data-session-id="sid-b"]')||document.querySelector('#projects .pj-sess:not(.on):not(.pending)');
        if(!row) return false;
        row.querySelector('.pj-sess-menu-trigger')?.click();
        return true;
      })()`);
      if (!opened) throw new Error('No session row for menu');
      await waitFor(`!!document.querySelector('#actionMenu')`, 'session action menu');
      await sleep(120);
    }
    const runtimeId = '12121212-1212-4212-8212-121212121212';
    async function openRuntimeMenu() {
      const opened = await read(`(()=>{
        const row=document.querySelector('.pj-runtime[data-conversation-id="${runtimeId}"]');
        const trigger=row?.querySelector('.pj-sess-menu-trigger');
        if(!trigger) return false;
        trigger.click();
        return true;
      })()`);
      if (!opened) throw new Error('No runtime row for menu');
      await waitFor(`!!document.querySelector('#actionMenu')`, 'runtime title menu');
      await sleep(120);
    }
    const menuState = () => read(`(()=>{
      const m=document.querySelector('#actionMenu');
      if(!m) return null;
      const items=[...m.querySelectorAll('[role="menuitem"]')];
      const first=items[0];
      const b=m.getBoundingClientRect();
      return {
        labels:items.map(n=>n.textContent.trim()),
        disabled:items.map(n=>n.disabled),
        separators:m.querySelectorAll('[role="separator"]').length,
        firstIcon:Boolean(first?.querySelector('.action-menu-ic svg')),
        focused:document.activeElement===first,
        firstBg:first?getComputedStyle(first).backgroundColor:'',
        inside:b.left>=0&&b.top>=0&&b.right<=innerWidth+0.5&&b.bottom<=innerHeight+0.5,
        width:Math.round(b.width),
        height:Math.round(b.height),
        note:m.querySelector('.action-menu-note')?.textContent.trim()||'',
        overflow:document.documentElement.scrollWidth<=innerWidth
      };
    })()`);
    async function closeMenu() {
      await key('Escape', 'Escape', 27);
      await waitFor(`!document.querySelector('#actionMenu')`, 'menu closed');
    }
    async function hoverFirstMenuItem() {
      const point = await read(`(()=>{const b=document.querySelector('#actionMenu [role="menuitem"]');const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await sleep(200);
    }

    let attached = false;
    try {
      await fetch(origin + '/api/__runtime-title-row', { method: 'POST' });
      await win.loadURL(origin);
      await waitFor(`document.querySelector('#connText')?.textContent==='已连接'`, 'fixture connected');
      await waitFor(`!!document.querySelector('.pj-runtime[data-conversation-id="${runtimeId}"] .pj-sess-menu-trigger')`, 'runtime title row');
      win.showInactive();
      win.webContents.debugger.attach('1.3');
      attached = true;

      /* ---------- 1320 dark：设置卡片与开关状态 ---------- */
      const darkView = await viewport('1320×820 dark');
      check(darkView.theme === 'dark', 'default theme is dark', darkView);
      await openSettings();
      await scrollTitleCard();
      let card = await titleCard();
      check(card?.rows === 2, 'title card has two rows', card);
      check(JSON.stringify(card?.titles) === JSON.stringify(['自动生成会话标题', '标题生成模型']), 'title card labels are the agreed copy', card?.titles);
      check(card?.model === '跟随当前会话', 'model row reads 跟随当前会话', card?.model);
      check(card?.switch.role === 'switch' && card?.switch.label === '自动生成会话标题' && card?.switch.checked === 'true', 'auto title switch is a labelled, checked switch', card?.switch);
      check(card?.switch.w === 38 && card?.switch.h === 22, 'switch keeps the shared 38×22 control size', card?.switch);
      check(card?.rowHeights.every((height) => height >= 64), 'both rows keep the shared ≥64px rhythm', card?.rowHeights);
      check(card?.cardInside && card?.modelInside, 'card and model value stay inside the 1320 viewport', card);
      check(card?.details.some((text) => text.includes('会消耗少量模型用量')), 'usage is disclosed in the card', card?.details);
      await shot('1320-dark-title-card');

      /* 键盘 Focus-visible：从字号滑杆 Tab 到开关。 */
      await read(`document.querySelector('.appearance-size-row input[type="range"]').focus()`);
      await key('Tab', 'Tab', 9);
      const focused = await read(`(()=>{const sw=document.querySelector('.appearance-title-card .ds-switch');const s=getComputedStyle(sw);return {active:document.activeElement===sw,outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,outlineColor:s.outlineColor};})()`);
      check(focused.active && focused.outlineStyle === 'solid' && focused.outlineWidth === '2px', 'keyboard focus draws the shared 2px focus ring on the switch', focused);
      await shot('1320-dark-title-switch-focus');

      /* 保存中：真实点击后开关禁用，再成功关闭。 */
      const switchPoint = await read(`(()=>{const b=document.querySelector('.appearance-title-card .ds-switch').getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)};})()`);
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...switchPoint, button: 'left', clickCount: 1 });
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...switchPoint, button: 'left', clickCount: 1 });
      await sleep(60);
      const saving = await titleCard();
      check(saving?.switch.disabled === true && saving?.switch.checked === 'false', 'switch disables itself while the setting is saving', saving?.switch);
      await shot('1320-dark-title-switch-saving');
      await waitFor(`document.querySelector('.appearance-status')?.textContent==='已关闭自动会话标题。'`, 'auto title off saved');
      card = await titleCard();
      check(card?.switch.checked === 'false' && !card?.switch.disabled, 'successful save leaves the switch off and enabled', card?.switch);
      await shot('1320-dark-title-off');

      /* 关闭态 hover：轨道有可见反馈（不是只换 cursor）。 */
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...switchPoint });
      await sleep(180);
      const hoverOff = await read(`(()=>{const sw=document.querySelector('.appearance-title-card .ds-switch');return {bg:getComputedStyle(sw).backgroundColor,border:getComputedStyle(sw).borderColor};})()`);
      await shot('1320-dark-title-hover-off');
      check(hoverOff.bg !== 'rgba(0, 0, 0, 0)' && hoverOff.border !== 'rgba(0, 0, 0, 0)', 'off-state hover keeps a visible track and border', hoverOff);

      /* 错误：下一次保存失败 → 开关回滚并显示错误，不假装已保存。 */
      await read(`fetch('/api/__title-settings-fail',{method:'POST'}).then(r=>r.json())`);
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...switchPoint, button: 'left', clickCount: 1 });
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...switchPoint, button: 'left', clickCount: 1 });
      await waitFor(`document.querySelector('.appearance-status')?.classList.contains('is-error')===true`, 'auto title save error');
      const failed = await titleCard();
      check(failed?.switch.checked === 'false' && /设置未能保存/.test(failed?.status || ''), 'failed save reverts the switch and explains the error', failed);
      await shot('1320-dark-title-save-error');

      /* 再点一次成功开启，作为后续组合的基线。 */
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...switchPoint, button: 'left', clickCount: 1 });
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...switchPoint, button: 'left', clickCount: 1 });
      await waitFor(`document.querySelector('.appearance-title-card .ds-switch')?.getAttribute('aria-checked')==='true' && document.querySelector('.appearance-status')?.textContent==='已开启自动会话标题。'`, 'auto title on saved');
      await leaveSettings();

      /* ---------- 英文 AI 标题走真实 SSE → 就地更新 ---------- */
      const englishTitle = 'Fix SSE reconnect race on resume';
      const applied = await read(`fetch('/api/__title',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'sid-b',title:${JSON.stringify(englishTitle)}})}).then(r=>r.json())`);
      await waitFor(`(document.querySelector('#projects .pj-sess[data-session-id="sid-b"]')?.textContent||'').includes(${JSON.stringify(englishTitle)})`, 'English title applied in place');
      check(applied?.ok === true, 'fixture title event accepted', applied);
      const titleUpdate = await read(`(()=>({row:document.querySelector('#projects .pj-sess[data-session-id="sid-b"] .pj-sess-title')?.textContent,rows:document.querySelectorAll('#projects .pj-sess').length,menuLabel:document.querySelector('#projects .pj-sess[data-session-id="sid-b"] .pj-sess-menu-trigger')?.getAttribute('aria-label')}))()`);
      check(titleUpdate.row === englishTitle, 'sidebar row applies the English title in place', titleUpdate);
      check(titleUpdate.menuLabel === '会话操作：' + englishTitle, 'row menu aria-label follows the new title', titleUpdate.menuLabel);

      /* ---------- 1320 dark：会话菜单 ---------- */
      await openHistoryMenu();
      const menuDark = await menuState();
      check(JSON.stringify(menuDark?.labels) === JSON.stringify(['AI 生成标题', '重命名', '归档', '删除会话']), 'session menu puts AI 生成标题 first', menuDark?.labels);
      check(JSON.stringify(menuDark?.disabled) === JSON.stringify([false, false, false, false]), 'history row exposes rename without activating the session', menuDark?.disabled);
      check(menuDark?.firstIcon && menuDark?.separators === 2, 'AI item carries the spark icon and its own separator', menuDark);
      check(menuDark?.focused && menuDark?.firstBg !== 'rgba(0, 0, 0, 0)', 'keyboard focus lands on the AI item with the shared hover surface', menuDark);
      check(menuDark?.inside && menuDark?.overflow, 'menu stays inside the 1320 viewport without page overflow', menuDark);
      check(menuDark?.note === '', 'no disabled note when every action is available', menuDark?.note);
      await shot('1320-dark-session-menu');
      await hoverFirstMenuItem();
      await shot('1320-dark-session-menu-hover');
      await closeMenu();
      const afterEscape = await read(`(()=>({tag:document.activeElement?.tagName,cls:document.activeElement?.className,aria:document.activeElement?.getAttribute?.('aria-label'),connected:document.activeElement?.isConnected}))()`);
      check(afterEscape?.cls?.includes?.('pj-sess-menu-trigger'), 'Escape closes the menu and returns focus to the row trigger', afterEscape);

      /* ---------- 1320 dark：历史会话行内改名（不激活会话） ---------- */
      const topBeforeClassicRename = await read(`document.querySelector('#title')?.textContent`);
      await openHistoryMenu();
      const clickedClassicRename = await read(`(()=>{const b=[...document.querySelectorAll('#actionMenu [role="menuitem"]')].find(n=>n.textContent.trim()==='重命名');if(!b)return false;b.click();return true})()`);
      check(clickedClassicRename, 'history row menu exposes the rename action');
      await waitFor(`!!document.querySelector('#projects .pj-sess[data-session-id="sid-b"] .pj-sess-input')`, 'classic rename input');
      const classicRenameInput = await read(`(()=>{const i=document.querySelector('#projects .pj-sess[data-session-id="sid-b"] .pj-sess-input');return {value:i.value,focused:document.activeElement===i,all:i.selectionStart===0&&i.selectionEnd===i.value.length,inside:i.getBoundingClientRect().right<=innerWidth+0.5};})()`);
      check(classicRenameInput.value === englishTitle && classicRenameInput.focused && classicRenameInput.all && classicRenameInput.inside,
        'rename opens an in-row editor with the current title selected', classicRenameInput);
      await shot('1320-dark-session-rename-input');
      const classicRenamed = '重命名后的 README 测试章节';
      await win.webContents.insertText(classicRenamed);
      await key('Enter', 'Enter', 13);
      await waitFor(`document.querySelector('#projects .pj-sess[data-session-id="sid-b"] .pj-sess-title')?.textContent===${JSON.stringify(classicRenamed)}`, 'classic rename applied');
      check((await read(`document.querySelector('#title')?.textContent`)) === topBeforeClassicRename,
        'renaming a history row does not touch the top title of the current session');
      await shot('1320-dark-session-renamed');

      /* Runtime 行：同一套行尾入口与生成服务，目标不必是当前会话。 */
      await openRuntimeMenu();
      const runtimeMenu = await menuState();
      check(JSON.stringify(runtimeMenu?.labels) === JSON.stringify(['AI 生成标题', '重命名']) && runtimeMenu?.separators === 0,
        'Runtime row exposes the same AI title and rename actions', runtimeMenu);
      check(runtimeMenu?.disabled.every((value) => value === false) && runtimeMenu?.inside && runtimeMenu?.firstIcon,
        'Runtime title actions are enabled, iconised and inside the viewport', runtimeMenu);
      await shot('1320-dark-runtime-title-menu');
      const clickedRuntimeRename = await read(`(()=>{const b=[...document.querySelectorAll('#actionMenu [role="menuitem"]')].find(n=>n.textContent.trim()==='重命名');if(!b)return false;b.click();return true})()`);
      check(clickedRuntimeRename, 'Runtime row menu exposes the rename action');
      await waitFor(`!!document.querySelector('.pj-runtime[data-conversation-id="${runtimeId}"] .pj-sess-input')`, 'runtime rename input');
      const runtimeRenameInput = await read(`(()=>{const i=document.querySelector('.pj-runtime[data-conversation-id="${runtimeId}"] .pj-sess-input');return {value:i.value,focused:document.activeElement===i,all:i.selectionStart===0&&i.selectionEnd===i.value.length};})()`);
      check(runtimeRenameInput.value === '修复登录接口超时' && runtimeRenameInput.focused && runtimeRenameInput.all,
        'Runtime rename opens the same in-row editor', runtimeRenameInput);
      await shot('1320-dark-runtime-rename-input');
      const runtimeRenamed = '并行会话改名示例';
      await win.webContents.insertText(runtimeRenamed);
      await key('Enter', 'Enter', 13);
      await waitFor(`document.querySelector('.pj-runtime[data-conversation-id="${runtimeId}"] .pj-sess-title')?.textContent===${JSON.stringify(runtimeRenamed)}`, 'runtime rename applied');
      await shot('1320-dark-runtime-renamed');

      /* ---------- 1320 light ---------- */
      await openSettings();
      await chooseTheme('浅色');
      await waitFor(`document.documentElement.dataset.theme==='light'`, 'light theme');
      await scrollTitleCard();
      await viewport('1320×820 light');
      await shot('1320-light-title-card');
      await leaveSettings();
      await openHistoryMenu();
      const menuLight = await menuState();
      check(menuLight?.inside && menuLight?.overflow, 'light menu stays inside the 1320 viewport', menuLight);
      await shot('1320-light-session-menu');
      const lightRenameClicked = await read(`(()=>{const b=[...document.querySelectorAll('#actionMenu [role="menuitem"]')].find(n=>n.textContent.trim()==='重命名');if(!b)return false;b.click();return true})()`);
      check(lightRenameClicked, 'light theme exposes the history rename action');
      await waitFor(`!!document.querySelector('#projects .pj-sess[data-session-id="sid-b"] .pj-sess-input')`, 'light classic rename input');
      const lightRename = await read(`(()=>{const i=document.querySelector('#projects .pj-sess[data-session-id="sid-b"] .pj-sess-input');const b=i.getBoundingClientRect();return {value:i.value,focused:document.activeElement===i,inside:b.right<=innerWidth+0.5&&b.left>=0};})()`);
      check(lightRename.value === classicRenamed && lightRename.focused && lightRename.inside,
        'light theme rename editor keeps the current title and stays inside the viewport', lightRename);
      await shot('1320-light-session-rename-input');
      await key('Escape', 'Escape', 27);
      await waitFor(`!document.querySelector('#projects .pj-sess[data-session-id="sid-b"] .pj-sess-input')`, 'light rename cancelled');
      await closeMenu();
      await openRuntimeMenu();
      const runtimeLight = await menuState();
      check(runtimeLight?.inside && runtimeLight?.overflow, 'light Runtime title menu stays inside the 1320 viewport', runtimeLight);
      await shot('1320-light-runtime-title-menu');
      await read(`(()=>{const b=[...document.querySelectorAll('#actionMenu [role="menuitem"]')].find(n=>n.textContent.trim()==='重命名');b?.click();return true})()`);
      await waitFor(`!!document.querySelector('.pj-runtime[data-conversation-id="${runtimeId}"] .pj-sess-input')`, 'light runtime rename input');
      await shot('1320-light-runtime-rename-input');
      await key('Escape', 'Escape', 27);
      await waitFor(`!document.querySelector('.pj-runtime[data-conversation-id="${runtimeId}"] .pj-sess-input')`, 'light runtime rename cancelled');
      await closeMenu();

      /* ---------- 700 light ---------- */
      win.setContentSize(700, 600);
      await sleep(400);
      await openSettings();
      await scrollTitleCard();
      const narrowLight = await viewport('700×600 light');
      card = await titleCard();
      check(card?.cardInside && card?.modelInside, '700px title card keeps every value inside the viewport', card);
      check(card?.rowHeights.every((height) => height >= 64), '700px rows keep usable height', card?.rowHeights);
      await shot('700-light-title-card');
      await leaveSettings();
      await openHistoryMenu();
      const menuNarrowLight = await menuState();
      check(menuNarrowLight?.inside && menuNarrowLight?.overflow, '700px light menu clamps inside the viewport', menuNarrowLight);
      check((await read(`document.querySelector('#projects .pj-sess[data-session-id="sid-b"] .pj-sess-title')?.textContent`)) === classicRenamed, 'renamed title survives at 700px');
      await shot('700-light-session-menu');
      await read(`(()=>{const b=[...document.querySelectorAll('#actionMenu [role="menuitem"]')].find(n=>n.textContent.trim()==='重命名');b?.click();return true})()`);
      await waitFor(`!!document.querySelector('#projects .pj-sess[data-session-id="sid-b"] .pj-sess-input')`, '700 light rename input');
      const narrowRename = await read(`(()=>{const i=document.querySelector('#projects .pj-sess[data-session-id="sid-b"] .pj-sess-input');const b=i.getBoundingClientRect();return {value:i.value,inside:b.left>=0&&b.right<=innerWidth+0.5};})()`);
      check(narrowRename.value === classicRenamed && narrowRename.inside, '700px light rename editor stays inside the viewport', narrowRename);
      await shot('700-light-session-rename-input');
      await key('Escape', 'Escape', 27);
      await waitFor(`!document.querySelector('#projects .pj-sess[data-session-id="sid-b"] .pj-sess-input')`, '700 light rename cancelled');
      await closeMenu();
      await openRuntimeMenu();
      const runtimeNarrow = await menuState();
      check(runtimeNarrow?.inside && runtimeNarrow?.overflow, '700px Runtime title menu clamps inside the viewport', runtimeNarrow);
      await shot('700-light-runtime-title-menu');
      await closeMenu();

      /* ---------- 700 dark ---------- */
      await openSettings();
      await chooseTheme('深色');
      await waitFor(`document.documentElement.dataset.theme==='dark'`, 'dark theme');
      await scrollTitleCard();
      await viewport('700×600 dark');
      card = await titleCard();
      check(card?.cardInside && card?.modelInside, '700px dark card keeps every value inside the viewport', card);
      await shot('700-dark-title-card');
      await leaveSettings();
      await openHistoryMenu();
      const menuNarrowDark = await menuState();
      check(menuNarrowDark?.inside && menuNarrowDark?.overflow, '700px dark menu clamps inside the viewport', menuNarrowDark);
      await shot('700-dark-session-menu');
      await read(`(()=>{const b=[...document.querySelectorAll('#actionMenu [role="menuitem"]')].find(n=>n.textContent.trim()==='重命名');b?.click();return true})()`);
      await waitFor(`!!document.querySelector('#projects .pj-sess[data-session-id="sid-b"] .pj-sess-input')`, '700 dark rename input');
      const narrowDarkRename = await read(`(()=>{const i=document.querySelector('#projects .pj-sess[data-session-id="sid-b"] .pj-sess-input');const b=i.getBoundingClientRect();return {value:i.value,inside:b.left>=0&&b.right<=innerWidth+0.5,focused:document.activeElement===i};})()`);
      check(narrowDarkRename.value === classicRenamed && narrowDarkRename.inside && narrowDarkRename.focused,
        '700px dark rename editor stays inside the viewport with focus', narrowDarkRename);
      await shot('700-dark-session-rename-input');
      await key('Escape', 'Escape', 27);
      await waitFor(`!document.querySelector('#projects .pj-sess[data-session-id="sid-b"] .pj-sess-input')`, '700 dark rename cancelled');
      await closeMenu();
      await openRuntimeMenu();
      const runtimeNarrowDark = await menuState();
      check(runtimeNarrowDark?.inside && runtimeNarrowDark?.overflow, '700px dark Runtime title menu clamps inside the viewport', runtimeNarrowDark);
      await shot('700-dark-runtime-title-menu');
      await closeMenu();

      /* ---------- 重启读取：设置与标题来自服务端，不靠内存 ---------- */
      win.setContentSize(1320, 820);
      await sleep(350);
      await win.webContents.reload();
      await waitFor(`document.querySelector('#connText')?.textContent==='已连接'`, 'reload connected');
      await openSettings();
      await scrollTitleCard();
      const restored = await titleCard();
      check(restored?.switch.checked === 'true' && restored?.model === '跟随当前会话', 'settings restore from the server after reload', restored && { switch: restored.switch, model: restored.model });
      check((await read(`document.documentElement.dataset.theme`)) === 'dark', 'theme preference restores after reload');
      await leaveSettings();
      await waitFor(`document.querySelector('#projects .pj-sess[data-session-id="sid-b"] .pj-sess-title')?.textContent===${JSON.stringify(classicRenamed)}`, 'renamed classic title restored');
      check((await read(`document.querySelector('.pj-runtime[data-conversation-id="${runtimeId}"] .pj-sess-title')?.textContent`)) === runtimeRenamed,
        'renamed Runtime title restores from the server after reload');
      check((await read(`document.querySelector('#title')?.textContent`)) === '发酵罐空气分布器设计核算',
        'reload keeps the current session top title, not a history rename');

      check(consoleErrors.length === 0, 'no renderer console errors', consoleErrors);
      console.log(`\nSession title visual: ${checks - failures.length}/${checks} checks passed; screenshots=${screenshots.length}`);
      if (failures.length) console.error('FAILED: ' + failures.join(' | '));
      fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, failures, combos, screenshots, consoleErrors }, null, 2));
      app.exit(failures.length ? 1 : 0);
    } finally {
      try { if (attached && win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); } catch { /* ignore */ }
      harness.kill();
      if (win && !win.isDestroyed()) win.destroy();
    }
  }

  run().catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
