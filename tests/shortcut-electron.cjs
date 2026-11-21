/* Real-Electron acceptance for P24 keyboard shortcut settings.
 *
 * Drives the actual renderer with real CDP keyboard events: click a keycap,
 * press a combination, then close settings and prove the new combination
 * dispatches while the old one is dead. Covers conflict, Escape precedence,
 * disable/reset, reset-all, persistence across reload, rapid saves, legacy
 * command-palette ids and the input/terminal guards. No real project, Pi
 * process or user data is touched; the visual harness serves deterministic
 * fixtures and localStorage lives in a throwaway userData directory.
 * Screenshots land in `.shots/shortcuts/`.
 */
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.shots', 'shortcuts');
const STORAGE_KEY = 'pi-gui.keybindings.v1';

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-shortcuts-'));
  env.SHORTCUT_WORLD = world;
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
    const world = process.env.SHORTCUT_WORLD;
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

    /* CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
    async function key(keyName, code, vk, modifiers = 0) {
      for (const type of ['keyDown', 'keyUp']) {
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type, key: keyName, code, windowsVirtualKeyCode: vk, modifiers
        });
      }
      await sleep(120);
    }
    async function waitFor(expression, label, attempts = 120) {
      for (let index = 0; index < attempts; index += 1) {
        if (await read(expression).catch(() => false)) return;
        await sleep(50);
      }
      const diagnostics = await read(`(()=>({
        detail:document.querySelector('.shortcut-settings-page')?.innerText?.slice(0,300),
        rows:document.querySelectorAll('.shortcut-row').length,
        storage:localStorage.getItem(${JSON.stringify(STORAGE_KEY)}),
        view:document.querySelector('#workspace')?.dataset.workspaceView,
        menu:document.querySelector('#globalMoreMenu')?.hidden,
        errors:[...document.querySelectorAll('.shortcut-error:not([hidden])')].map(n=>n.textContent)
      }))()`).catch((error) => ({ error: String(error) }));
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

    async function openSettingsMenu() {
      await read(`document.querySelector('#navGlobalMore').click()`);
      await waitFor(`!document.querySelector('#globalMoreMenu').hidden && !!document.querySelector('.settings-grid')`, 'settings overview');
    }
    async function openShortcuts() {
      if (await read(`document.querySelector('#globalMoreMenu').hidden`)) {
        await read(`document.querySelector('#navGlobalMore').click()`);
      }
      await waitFor(`!document.querySelector('#globalMoreMenu').hidden`, 'settings menu');
      await read(`document.querySelector('#navShortcutHelp').click()`);
      await waitFor(`!!document.querySelector('.shortcut-settings-page') && document.querySelectorAll('.shortcut-row').length === 8`, 'shortcut page');
    }
    /* 扩展是应用主导航目的地（不再挂在设置目录下）；技能在「设置 › Agent 能力」。 */
    async function openExtensionsPage() {
      await read(`document.querySelector('#navExtensions').click()`);
      await waitFor(`!!document.querySelector('#extensionsTabInstalled') && !!document.querySelector('.ext-tabs')`, 'extensions page');
      await read(`document.querySelector('#extensionsTabInstalled').click()`);
      await waitFor(`!!document.querySelector('.ext-list')`, 'installed tab');
    }
    async function openSkillsPage() {
      await openSettingsMenu();
      await read(`document.querySelector('#navSkills').click()`);
      await waitFor(`!!document.querySelector('.skills-page') && document.querySelectorAll('.skills-page .skill-row').length >= 1`, 'skills page');
    }
    async function openMcpPage() {
      await openSettingsMenu();
      await read(`document.querySelector('#navMcp').click()`);
      /* 读取中只画页头与加载态；读完才挂服务器分组与页尾能力报告。 */
      await waitFor(`!!document.querySelector('.mcp-page .mcp-report')`, 'mcp page');
    }
    async function closeSettings() {
      await read(`document.querySelector('#navHome').click()`);
      await waitFor(`!document.querySelector('.shortcut-settings-page')`, 'shortcut page disposed');
    }
    const focusNav = () => read(`document.querySelector('#navHome').focus()`);
    const storage = async () => JSON.parse(await read(`localStorage.getItem(${JSON.stringify(STORAGE_KEY)})`) || 'null');
    const rowExpr = (id) => `document.querySelector('.shortcut-row[data-shortcut-id=${JSON.stringify(id)}]')`;
    const recorderExpr = (id) => `${rowExpr(id)}.querySelector('.shortcut-recorder')`;
    async function rowState(id) {
      return read(`(()=>{
        const row=${rowExpr(id)};
        if(!row)return null;
        const rec=row.querySelector('.shortcut-recorder');
        const chip=row.querySelector('.shortcut-state');
        const error=row.querySelector('.shortcut-error');
        return {
          rowState:row.dataset.state,
          recording:rec.getAttribute('aria-pressed')==='true',
          text:rec.innerText.replace(/\\s+/g,' ').trim(),
          keys:rec.querySelectorAll('kbd').length,
          chipHidden:chip.hidden,
          chipText:chip.textContent,
          disableDisabled:row.querySelector('.shortcut-disable').disabled,
          resetDisabled:row.querySelector('.shortcut-reset').disabled,
          error:error.hidden?null:error.textContent
        };
      })()`);
    }
    async function clickRecorder(id) {
      await read(`${recorderExpr(id)}.click()`);
      await waitFor(`${recorderExpr(id)}.getAttribute('aria-pressed')==='true'`, 'recording ' + id);
    }
    async function clickAction(id, action) {
      await read(`${rowExpr(id)}.querySelector('.shortcut-${action}').click()`);
      await sleep(120);
    }
    async function setTheme(label) {
      const theme = label === '深色' ? 'dark' : 'light';
      if (await read(`document.querySelector('#globalMoreMenu').hidden`)) {
        await read(`document.querySelector('#navGlobalMore').click()`);
      }
      await waitFor(`!document.querySelector('#globalMoreMenu').hidden`, 'settings menu for theme');
      await read(`document.querySelector('#navAppearance').click()`);
      await waitFor(`!!document.querySelector('.settings-theme-trigger')`, 'appearance page');
      await read(`document.querySelector('.settings-theme-trigger').click()`);
      await waitFor(`!!document.querySelector('.settings-theme-menu-anchored.is-open')`, 'theme menu');
      const clicked = await read(`(()=>{const target=[...document.querySelectorAll('.settings-theme-option')].find(node=>node.textContent.trim()===${JSON.stringify(label)});if(!target)return false;target.click();return true})()`);
      if (!clicked) throw new Error('Theme option not rendered: ' + label);
      await waitFor(`!document.querySelector('.pi-anchored-menu')`, 'theme menu closed');
      await waitFor(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`, 'theme applied');
    }
    const noPalette = () => read(`!document.querySelector('#paletteLayer') && !document.querySelector('.palette-card')`);
    const workspaceView = () => read(`document.querySelector('#workspace').dataset.workspaceView`);

    try {
      await win.loadURL(origin);
      await waitFor(`document.querySelector('#connText')?.textContent==='已连接'`, 'fixture connected');
      win.showInactive();
      win.webContents.debugger.attach('1.3');

      /* ---------- removed palette: Ctrl+K / Ctrl+Shift+P do nothing ---------- */
      await focusNav();
      await key('k', 'KeyK', 75, 2);
      await key('P', 'KeyP', 80, 10);
      await sleep(220);
      check(await noPalette(), 'command palette layer no longer exists in the DOM');
      check((await workspaceView()) === 'chat', 'Ctrl+K and Ctrl+Shift+P no longer open any palette or view');

      /* ---------- settings navigation is trimmed ---------- */
      await openSettingsMenu();
      const nav = await read(`(()=>({
        groups:[...document.querySelectorAll('#globalMoreMenu section h3')].map(n=>n.textContent),
        agentGroup:[...(document.querySelector('#navSkills')?.closest('section')?.querySelectorAll('button')||[])].map(b=>b.id),
        emptyGroups:[...document.querySelectorAll('#globalMoreMenu section')].filter(s=>!s.querySelector('button')).length,
        extensionsInMenu:!!document.querySelector('#globalMoreMenu #navExtensions'),
        capabilities:!!document.querySelector('#navCapabilities'),
        palette:!!document.querySelector('#navPalette'),
        navCapabilityStatus:[...document.querySelectorAll('#globalMoreMenu button')].some(b=>b.textContent.includes('能力状态')),
        navPalette:[...document.querySelectorAll('#globalMoreMenu button')].some(b=>b.textContent.includes('命令面板'))
      }))()`);
      check(nav.groups.length === 7 && nav.groups.includes('扩展与 MCP') && nav.groups.includes('Agent 能力') && JSON.stringify(nav.agentGroup) === '["navSkills"]' && nav.emptyGroups === 0 && !nav.extensionsInMenu, 'settings navigation has seven non-empty groups; Agent 能力 holds only 技能 and 扩展 lives in the main nav', nav);
      check(!nav.capabilities && !nav.palette && !nav.navCapabilityStatus && !nav.navPalette, 'removed capability-status and palette entries are gone from settings navigation', nav);
      await shot('1320-dark-settings-nav');

      await read(`(()=>{const i=document.querySelector('#settingsSearchInput');i.value='能力状态';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      const searchRemoved = await read(`(()=>({
        sectionsHidden:[...document.querySelectorAll('#globalMoreMenu section')].every(s=>s.hidden),
        visible:[...document.querySelectorAll('#globalMoreMenu button')].filter(b=>!b.hidden&&!b.closest('section')?.hidden).length
      }))()`);
      check(searchRemoved.sectionsHidden && searchRemoved.visible === 0, 'settings search does not return the removed capability page', searchRemoved);
      await read(`(()=>{const i=document.querySelector('#settingsSearchInput');i.value='快捷键';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      const searchShortcut = await read(`[...document.querySelectorAll('#globalMoreMenu button')].filter(b=>!b.hidden&&!b.closest('section')?.hidden).map(b=>b.textContent.trim())`);
      check(JSON.stringify(searchShortcut) === JSON.stringify(['快捷键']), 'settings search still finds the shortcut page', searchShortcut);
      await read(`(()=>{const i=document.querySelector('#settingsSearchInput');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);

      /* ---------- default list ---------- */
      await openShortcuts();
      const initial = await read(`(()=>{
        const rows=[...document.querySelectorAll('.shortcut-row')];
        const rec=id=>document.querySelector('.shortcut-row[data-shortcut-id="'+id+'"] .shortcut-recorder');
        const firstKey=document.querySelector('.shortcut-keybinding kbd');
        return {
          count:rows.length,
          ids:rows.map(row=>row.dataset.shortcutId),
          groups:[...document.querySelectorAll('.shortcut-map .shortcut-group-label')].map(n=>n.textContent),
          helpText:rec('shortcut-help').innerText.replace(/\\s+/g,' ').trim(),
          helpKeys:rec('shortcut-help').querySelectorAll('kbd').length,
          resetAllDisabled:document.querySelector('.shortcut-reset-all').disabled,
          rowResetsDisabled:[...document.querySelectorAll('.shortcut-reset')].every(b=>b.disabled),
          chipsHidden:[...document.querySelectorAll('.shortcut-state')].every(c=>c.hidden),
          rowHeights:rows.map(row=>Math.round(row.getBoundingClientRect().height)),
          controlsWidth:Math.round(document.querySelector('.shortcut-row-controls').getBoundingClientRect().width),
          keycap:{height:Math.round(firstKey.getBoundingClientRect().height),shadow:getComputedStyle(firstKey).boxShadow,font:getComputedStyle(firstKey).fontFamily},
          scroll:[document.documentElement.scrollWidth,innerWidth],
          storage:localStorage.getItem(${JSON.stringify(STORAGE_KEY)})
        };
      })()`);
      check(initial.count === 8, 'eight registered shortcuts are listed', initial.count);
      check(JSON.stringify(initial.groups) === JSON.stringify(['通用', '视图', '工作面板']), 'shortcuts are grouped as 通用/视图/工作面板', initial.groups);
      check(JSON.stringify(initial.ids) === JSON.stringify(['shortcut-help', 'view-chat', 'view-planner', 'view-changes', 'view-extensions', 'work-changes', 'work-terminal', 'work-files']), 'stable shortcut ids are preserved in order', initial.ids);
      check(initial.helpText.includes('Ctrl') && initial.helpText.includes('/') && initial.helpKeys === 2, 'default Ctrl+/ renders as two independent keycaps', initial);
      check(initial.resetAllDisabled && initial.rowResetsDisabled && initial.chipsHidden, 'fresh page offers no reset and shows no custom/disabled chip');
      check(initial.rowHeights.every((height) => Math.abs(height - initial.rowHeights[0]) <= 1) && initial.rowHeights[0] >= 48, 'all rows share one usable height', initial.rowHeights);
      check(initial.controlsWidth >= 240 && initial.controlsWidth <= 280, 'row controls reserve a stable right-side column', initial.controlsWidth);
      check(initial.keycap.height >= 20 && initial.keycap.height <= 26 && initial.keycap.shadow !== 'none' && /mono/i.test(initial.keycap.font), 'keycaps are raised monospace caps', initial.keycap);
      check(initial.scroll[0] <= initial.scroll[1] + 1, '1320px page has no horizontal overflow', initial.scroll);
      check(initial.storage === null, 'fresh profile has no keybinding storage', initial.storage);
      await shot('1320-dark-default');

      /* ---------- record a real key combination ---------- */
      await clickRecorder('view-planner');
      const recording = await rowState('view-planner');
      check(recording.recording && recording.text === '请按下快捷键', 'clicking a keycap enters recording', recording);
      await shot('1320-dark-recording');
      await key('k', 'KeyK', 75, 3); // Ctrl + Alt
      await waitFor(`localStorage.getItem(${JSON.stringify(STORAGE_KEY)})?.includes('ctrl+alt+k')`, 'binding persisted');
      const custom = await rowState('view-planner');
      check(!custom.recording && custom.rowState === 'custom' && custom.chipText === '自定义' && !custom.chipHidden, 'saved custom binding is marked 自定义', custom);
      check(custom.text.includes('Ctrl') && custom.text.includes('Alt') && custom.text.includes('K') && custom.keys === 3, 'row shows the new combination immediately', custom);
      check(custom.resetDisabled === false && custom.disableDisabled === false, 'custom row enables per-item reset and disable');
      check(JSON.stringify(await storage()) === JSON.stringify({ 'view-planner': 'ctrl+alt+k' }), 'storage keeps the versioned three-state map', await storage());
      check(await read(`document.querySelector('.shortcut-reset-all').disabled===false`), 'reset-all becomes available after an override');
      await shot('1320-dark-custom');

      /* ---------- Escape cancels recording without closing settings ---------- */
      await clickRecorder('work-terminal');
      await key('Escape', 'Escape', 27);
      await waitFor(`${recorderExpr('work-terminal')}.getAttribute('aria-pressed')==='false'`, 'recording cancelled');
      const cancelled = await rowState('work-terminal');
      check(cancelled.recording === false && cancelled.rowState === 'default' && cancelled.error === null, 'Escape cancels recording and leaves the row at its default', cancelled);
      check(await read(`!!document.querySelector('.shortcut-settings-page') && document.querySelector('.shortcut-settings-page h3')?.textContent==='键盘快捷键'`), 'Escape during recording does not close the settings page');
      check(JSON.stringify(await storage()) === JSON.stringify({ 'view-planner': 'ctrl+alt+k' }), 'cancelled recording writes nothing', await storage());

      /* ---------- conflict and reserved keys ---------- */
      await clickRecorder('view-chat');
      await key('G', 'KeyG', 71, 10); // Ctrl + Shift
      await waitFor(`${rowExpr('view-chat')}.querySelector('.shortcut-error').hidden===false`, 'conflict error');
      const conflict = await rowState('view-chat');
      check(conflict.recording === true, 'conflict keeps the row in recording for an immediate retry', conflict);
      check(/冲突/.test(conflict.error) && /打开文件变更面板/.test(conflict.error), 'conflict names the owning action', conflict.error);
      check(JSON.stringify(await storage()) === JSON.stringify({ 'view-planner': 'ctrl+alt+k' }), 'conflict does not write storage', await storage());
      await shot('1320-dark-conflict');
      await key('Escape', 'Escape', 27);
      await waitFor(`${recorderExpr('view-chat')}.getAttribute('aria-pressed')==='false'`, 'conflict recording cancelled');
      check(await read(`!!document.querySelector('.shortcut-settings-page')`), 'Escape after a conflict still keeps the settings page');
      check((await rowState('view-chat')).error === null, 'Escape clears the conflict message');

      await clickRecorder('view-chat');
      await key('c', 'KeyC', 67, 2); // Ctrl+C
      await waitFor(`${rowExpr('view-chat')}.querySelector('.shortcut-error').hidden===false`, 'reserved error');
      const reserved = await rowState('view-chat');
      check(/保留/.test(reserved.error) && reserved.recording === true, 'system/terminal reserved combination is rejected in place', reserved.error);
      check(JSON.stringify(await storage()) === JSON.stringify({ 'view-planner': 'ctrl+alt+k' }), 'reserved combination writes nothing', await storage());
      await key('Escape', 'Escape', 27);
      await waitFor(`${recorderExpr('view-chat')}.getAttribute('aria-pressed')==='false'`, 'reserved recording cancelled');

      /* ---------- runtime dispatch: new combo works, old combo is dead ---------- */
      await closeSettings();
      await focusNav();
      await key('2', 'Digit2', 50, 1); // old Alt+2
      await sleep(220);
      check((await workspaceView()) === 'chat', 'old Alt+2 no longer switches to the planner');
      await key('k', 'KeyK', 75, 3); // new Ctrl+Alt+K
      await waitFor(`document.querySelector('#workspace').dataset.workspaceView==='planner'`, 'custom planner combo dispatches');
      check(await read(`document.querySelector('#workViewTitle')?.textContent==='任务与审阅'`), 'custom combo opens the planner surface');
      await read(`document.querySelector('#navHome').click()`);
      await waitFor(`document.querySelector('#workspace').dataset.workspaceView==='chat'`, 'back to chat');

      /* ---------- disable, verify dead, then per-item reset ---------- */
      await openShortcuts();
      await clickAction('view-planner', 'disable');
      await waitFor(`${rowExpr('view-planner')}.dataset.state==='disabled'`, 'planner disabled');
      const disabled = await rowState('view-planner');
      check(disabled.text === '未绑定' && disabled.chipText === '已禁用' && disabled.chipHidden === false, 'disabled row reads 未绑定 with a 已禁用 chip', disabled);
      check(disabled.disableDisabled === true && disabled.resetDisabled === false, 'disabled row disables the power button but keeps reset available');
      check(JSON.stringify(await storage()) === JSON.stringify({ 'view-planner': null }), 'disable persists explicit null, never an empty string', await storage());
      await shot('1320-dark-disabled');
      await closeSettings();
      await focusNav();
      await key('k', 'KeyK', 75, 3);
      await sleep(220);
      check((await workspaceView()) === 'chat', 'disabled custom combo no longer dispatches');
      await key('2', 'Digit2', 50, 1);
      await sleep(220);
      check((await workspaceView()) === 'chat', 'disabled shortcut does not fall back to its default combo');

      await openShortcuts();
      await clickAction('view-planner', 'reset');
      await waitFor(`${rowExpr('view-planner')}.dataset.state==='default'`, 'planner reset');
      const reset = await rowState('view-planner');
      check(reset.text.includes('Alt') && reset.text.includes('2') && reset.chipHidden === true, 'per-item reset restores the platform default', reset);
      check(reset.resetDisabled === true && reset.disableDisabled === false, 'reset row returns to the default button states');
      check(JSON.stringify(await storage()) === JSON.stringify({}), 'per-item reset deletes the override');
      await closeSettings();
      await focusNav();
      await key('2', 'Digit2', 50, 1);
      await waitFor(`document.querySelector('#workspace').dataset.workspaceView==='planner'`, 'default Alt+2 dispatches after reset');
      await read(`document.querySelector('#navHome').click()`);
      await waitFor(`document.querySelector('#workspace').dataset.workspaceView==='chat'`, 'back to chat after reset dispatch');

      /* ---------- reset conflict: never create a duplicate ---------- */
      await openShortcuts();
      await clickRecorder('work-changes');
      await key('o', 'KeyO', 79, 3);
      await waitFor(`${recorderExpr('work-changes')}.getAttribute('aria-pressed')==='false'`, 'work-changes rebound');
      await clickRecorder('view-chat');
      await key('G', 'KeyG', 71, 10);
      await waitFor(`${recorderExpr('view-chat')}.getAttribute('aria-pressed')==='false'`, 'view-chat rebound to ctrl+shift+g');
      await clickAction('work-changes', 'reset');
      await waitFor(`${rowExpr('work-changes')}.querySelector('.shortcut-error').hidden===false`, 'reset conflict error');
      const resetConflict = await rowState('work-changes');
      check(/无法恢复默认/.test(resetConflict.error) && /切到对话/.test(resetConflict.error), 'per-item reset refuses to create a duplicate and names the blocker', resetConflict.error);
      check((await storage())['work-changes'] === 'ctrl+alt+o', 'failed reset keeps the existing override', await storage());
      await shot('1320-dark-reset-conflict');
      await clickAction('view-chat', 'reset');
      await waitFor(`${rowExpr('view-chat')}.dataset.state==='default'`, 'view-chat reset');
      await clickAction('work-changes', 'reset');
      await waitFor(`${rowExpr('work-changes')}.dataset.state==='default'`, 'work-changes reset');
      check(JSON.stringify(await storage()) === JSON.stringify({}), 'both overrides cleared after the blocker is removed');

      /* ---------- persistence across reload ---------- */
      await clickRecorder('view-planner');
      await key('k', 'KeyK', 75, 3);
      await waitFor(`${recorderExpr('view-planner')}.getAttribute('aria-pressed')==='false'`, 'planner custom before reload');
      await clickAction('work-terminal', 'disable');
      await waitFor(`${rowExpr('work-terminal')}.dataset.state==='disabled'`, 'work-terminal disabled before reload');
      const saved = await storage();
      check(saved['view-planner'] === 'ctrl+alt+k' && saved['work-terminal'] === null, 'custom and disabled states are both persisted', saved);

      await win.webContents.reload();
      await waitFor(`document.querySelector('#connText')?.textContent==='已连接'`, 'reload connected');
      await waitFor(`!!document.querySelector('#navShortcutHelp')`, 'app ready after reload');
      check(JSON.stringify(await storage()) === JSON.stringify(saved), 'localStorage survives reload', await storage());
      await openShortcuts();
      const restoredPlanner = await rowState('view-planner');
      const restoredTerminal = await rowState('work-terminal');
      check(restoredPlanner.rowState === 'custom' && restoredPlanner.text.includes('Ctrl') && restoredPlanner.text.includes('Alt') && restoredPlanner.text.includes('K'), 'custom binding restores into the list', restoredPlanner);
      check(restoredTerminal.rowState === 'disabled' && restoredTerminal.text === '未绑定', 'disabled binding restores as 未绑定', restoredTerminal);
      await shot('1320-dark-restored');
      await closeSettings();
      await focusNav();
      await key('2', 'Digit2', 50, 1);
      await sleep(220);
      check((await workspaceView()) === 'chat', 'restored custom binding still suppresses the old default');
      await key('k', 'KeyK', 75, 3);
      await waitFor(`document.querySelector('#workspace').dataset.workspaceView==='planner'`, 'restored custom binding dispatches after reload');
      await read(`document.querySelector('#navHome').click()`);
      await waitFor(`document.querySelector('#workspace').dataset.workspaceView==='chat'`, 'back to chat after reload check');

      /* ---------- reset all clears custom and disabled ---------- */
      await openShortcuts();
      await read(`document.querySelector('.shortcut-reset-all').click()`);
      await waitFor(`localStorage.getItem(${JSON.stringify(STORAGE_KEY)})==='{}'`, 'reset all persisted');
      const resetAll = await read(`(()=>({
        states:[...document.querySelectorAll('.shortcut-row')].map(row=>row.dataset.state),
        chips:[...document.querySelectorAll('.shortcut-state')].every(c=>c.hidden),
        resetAllDisabled:document.querySelector('.shortcut-reset-all').disabled,
        status:document.querySelector('.shortcut-status').hidden?'':document.querySelector('.shortcut-status').textContent,
        terminal:(()=>{const row=document.querySelector('.shortcut-row[data-shortcut-id="work-terminal"]');return {state:row.dataset.state,text:row.querySelector('.shortcut-recorder').innerText.replace(/\\s+/g,' ').trim(),keys:row.querySelectorAll('kbd').length}})()
      }))()`);
      check(resetAll.states.every((state) => state === 'default') && resetAll.chips, 'reset all returns every row to default, including disabled ones', resetAll.states);
      check(resetAll.terminal.state === 'default' && resetAll.terminal.keys === 2 && resetAll.terminal.text.includes('Ctrl'), 'reset all re-enables a disabled shortcut with its platform default', resetAll.terminal);
      check(resetAll.resetAllDisabled === true && /已恢复全部默认快捷键/.test(resetAll.status), 'reset all disables itself and reports success', resetAll);
      await shot('1320-dark-reset-all');

      /* ---------- old palette storage ids are ignored safely ---------- */
      await closeSettings();
      await read(`localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify({ palette: 'ctrl+alt+k', 'palette-alt': null, 'view-chat': 'alt+5' }))`);
      await win.webContents.reload();
      await waitFor(`document.querySelector('#connText')?.textContent==='已连接'`, 'legacy reload connected');
      await waitFor(`!!document.querySelector('#navShortcutHelp')`, 'app ready after legacy reload');
      await openShortcuts();
      const legacy = await rowState('view-chat');
      check(legacy.rowState === 'custom' && legacy.text.includes('Alt') && legacy.text.includes('5'), 'legacy palette ids are ignored while other overrides still load', legacy);
      check(await read(`document.querySelectorAll('.shortcut-row').length===8 && !document.querySelector('.shortcut-row[data-shortcut-id="palette"]')`), 'legacy ids never create rows');
      check(await read(`document.querySelectorAll('.shortcut-error:not([hidden])').length===0`), 'legacy ids do not surface an error');
      await closeSettings();
      await focusNav();
      await key('k', 'KeyK', 75, 2);
      await key('P', 'KeyP', 80, 10);
      await sleep(220);
      check(await noPalette(), 'legacy palette bindings still cannot open a palette');
      await openShortcuts();
      await read(`document.querySelector('.shortcut-reset-all').click()`);
      await waitFor(`localStorage.getItem(${JSON.stringify(STORAGE_KEY)})==='{}'`, 'legacy cleanup reset all');
      await closeSettings();

      /* ---------- old defaults survive the key-first/code-fallback change ---------- */
      await focusNav();
      await key('/', 'Slash', 191, 2); // Ctrl+/
      await waitFor(`!!document.querySelector('.shortcut-settings-page')`, 'Ctrl+/ reopens shortcut settings');
      check(await read(`document.querySelector('.shortcut-settings-page h3')?.textContent==='键盘快捷键'`), 'Ctrl+/ still opens the shortcut settings page');
      await closeSettings();

      /* ---------- input and terminal guards (default bindings) ---------- */
      await read(`document.querySelector('#input').focus()`);
      await key('k', 'KeyK', 75, 2);
      await key('P', 'KeyP', 80, 10);
      await sleep(220);
      check(await noPalette(), 'Ctrl+K and Ctrl+Shift+P do nothing inside the composer');
      await key('/', 'Slash', 191, 2);
      await waitFor(`!!document.querySelector('.shortcut-settings-page')`, 'Ctrl+/ still opens shortcut settings from the composer');
      await closeSettings();

      await read(`(()=>{
        const host=document.createElement('div');host.className='xterm';
        const area=document.createElement('textarea');host.append(area);
        document.body.append(host);area.focus();window.__p24TerminalHost=host;
      })()`);
      await key('/', 'Slash', 191, 2);
      await sleep(220);
      check(await read(`!document.querySelector('.shortcut-settings-page')`), 'terminal focus keeps Ctrl+/ for the terminal');
      await key('p', 'KeyP', 80, 2);
      await sleep(220);
      check(await read(`!document.querySelector('#rightPane') || document.querySelector('#rightPane').dataset.surface!=='files'`), 'terminal focus keeps Ctrl+P for the terminal');
      await key('P', 'KeyP', 80, 10); // Ctrl+Shift+P
      await sleep(220);
      check(await noPalette(), 'Ctrl+Shift+P does nothing from the terminal');
      check((await workspaceView()) === 'chat', 'terminal Ctrl+Shift+P does not switch views');
      await read(`window.__p24TerminalHost.remove(); delete window.__p24TerminalHost`);

      /* ---------- rapid consecutive saves ---------- */
      await openShortcuts();
      for (const [letter, vk] of [['j', 74], ['h', 72], ['u', 85]]) {
        await clickRecorder('view-planner');
        await key(letter, 'Key' + letter.toUpperCase(), vk, 3);
        await waitFor(`${recorderExpr('view-planner')}.getAttribute('aria-pressed')==='false'`, 'rapid save ' + letter);
      }
      const rapid = await storage();
      const rapidRow = await rowState('view-planner');
      check(JSON.stringify(rapid) === JSON.stringify({ 'view-planner': 'ctrl+alt+u' }) && rapidRow.rowState === 'custom', 'rapid consecutive saves converge on the last binding', { rapid, rapidRow });
      await closeSettings();
      await focusNav();
      await key('j', 'KeyJ', 74, 3);
      await sleep(220);
      check((await workspaceView()) === 'chat', 'superseded rapid binding does not dispatch');
      await key('u', 'KeyU', 85, 3);
      await waitFor(`document.querySelector('#workspace').dataset.workspaceView==='planner'`, 'last rapid binding dispatches');
      await read(`document.querySelector('#navHome').click()`);
      await waitFor(`document.querySelector('#workspace').dataset.workspaceView==='chat'`, 'back to chat after rapid check');

      /* ---------- light theme, custom + disabled ---------- */
      await setTheme('浅色');
      await openSettingsMenu();
      await shot('1320-light-settings-nav');
      await openShortcuts();
      check(await read(`document.documentElement.dataset.theme==='light'`), 'light theme applies to the shortcut page');
      await shot('1320-light-custom');
      await clickAction('work-terminal', 'disable');
      await waitFor(`${rowExpr('work-terminal')}.dataset.state==='disabled'`, 'light disabled row');
      await shot('1320-light-disabled');

      /* P36：已知能力设置回到 Extensions 页；展开一项，截到真实的安装 / 观察布局。 */
      await openExtensionsPage();
      await waitFor(`document.querySelectorAll('.ext-known-item .cap-setup').length>=4`, 'known capability setups');
      await read(`document.querySelector('.ext-known>summary').click();document.querySelector('.ext-known-item>summary').click()`);
      await sleep(200);
      await shot('1320-light-extensions');
      await read(`document.querySelector('#extensionsTabMarket').click()`);
      await waitFor(`!!document.querySelector('.extensions-market-empty')`, 'market placeholder');
      await shot('1320-light-extensions-market');
      await openSkillsPage();
      await shot('1320-light-skills');
      await openMcpPage();
      /* 浏览器在 open 变化后自己派发 toggle；不再手动补发，免得重复请求。 */
      await read(`document.querySelector('.mcp-report').open=true`);
      await waitFor(`(document.querySelector('.mcp-report')?.textContent||'').includes('带 MCP 能力')`, 'mcp report expanded');
      /* 报告在页尾，滚到视口里再截，截图才能证明展开后的排版。 */
      await read(`document.querySelector('.mcp-report').scrollIntoView({block:'start'})`);
      await sleep(150);
      await shot('1320-light-mcp-report');
      await openShortcuts();

      /* ---------- 700x600 narrow layout ---------- */
      win.setContentSize(700, 600);
      await sleep(350);
      const narrow = await read(`(()=>{
        const rows=[...document.querySelectorAll('.shortcut-row')];
        const controls=[...document.querySelectorAll('.shortcut-row-controls')];
        const buttons=[...document.querySelectorAll('.shortcut-row-controls button')];
        const row=rows[0].getBoundingClientRect();
        const control=controls[0].getBoundingClientRect();
        return {
          inner:innerWidth,
          scrollWidth:document.documentElement.scrollWidth,
          rowHeights:rows.map(node=>Math.round(node.getBoundingClientRect().height)),
          rowWidth:Math.round(row.width),
          controlWidth:Math.round(control.width),
          buttonsInside:buttons.every(node=>{const b=node.getBoundingClientRect();return b.left>=-0.5&&b.right<=innerWidth+0.5}),
          controlsBelowTitle:control.top>document.querySelector('.shortcut-row-copy').getBoundingClientRect().top
        };
      })()`);
      check(narrow.scrollWidth <= narrow.inner + 1, '700px shortcut page has no horizontal overflow', narrow);
      check(narrow.buttonsInside, 'recorder and both icon buttons stay inside the 700px viewport', narrow);
      check(narrow.rowHeights.every((height) => height > 70), 'narrow rows stack instead of squeezing the controls', narrow.rowHeights);
      check(Math.abs(narrow.controlWidth - (narrow.rowWidth - 28)) <= 10, 'narrow controls fill the row content width', narrow);
      await shot('700-light-custom');

      await openSettingsMenu();
      await shot('700-light-settings-nav');
      await openExtensionsPage();
      const extensions = await read(`(()=>({
        tabs:[...document.querySelectorAll('.ext-tab')].map(n=>n.firstChild.textContent),
        removed:['#extensionsTabAll','#extensionsTabCapabilities','#extensionsTabSkills','#extensionsTabMcp'].some(id=>!!document.querySelector(id)),
        title:document.querySelector('#workViewTitle').textContent,
        scrollWidth:document.documentElement.scrollWidth,
        inner:innerWidth
      }))()`);
      check(JSON.stringify(extensions.tabs) === JSON.stringify(['已安装', '插件市场']), 'extensions page exposes only 已安装 / 插件市场 tabs', extensions.tabs);
      check(!extensions.removed, 'All / Capabilities / Skills / MCP tabs are gone from the extensions page');
      check(extensions.title === '扩展', 'extensions work surface is titled 扩展', extensions.title);
      check(extensions.scrollWidth <= extensions.inner + 1, '700px extensions page has no horizontal overflow', extensions);
      await shot('700-light-extensions');
      await read(`document.querySelector('#extensionsTabMarket').click()`);
      await waitFor(`!!document.querySelector('.extensions-market-empty')`, 'market placeholder');
      const market = await read(`({scrollWidth:document.documentElement.scrollWidth,inner:innerWidth})`);
      check(market.scrollWidth <= market.inner + 1, '700px extensions market tab has no horizontal overflow', market);
      await shot('700-light-extensions-market');
      await openSkillsPage();
      const skills = await read(`(()=>{
        const card=document.querySelector('.skills-page');
        const rows=[...card.querySelectorAll('.skill-row')];
        return {
          title:card.querySelector('.settings-page-title')?.textContent,
          headings:[...card.querySelectorAll('h2,h3')].filter(h=>h.textContent==='技能').length,
          rows:rows.length,
          rowsInside:rows.every(r=>{const b=r.getBoundingClientRect();return b.left>=-0.5&&b.right<=innerWidth+0.5}),
          scrollWidth:document.documentElement.scrollWidth,
          inner:innerWidth
        };
      })()`);
      check(skills.title === '技能' && skills.headings === 1, 'skills page shows a single 技能 heading', skills);
      check(skills.rows >= 1 && skills.rowsInside, 'skill rows stay inside the 700px viewport', skills);
      check(skills.scrollWidth <= skills.inner + 1, '700px skills page has no horizontal overflow', skills);
      await shot('700-light-skills');
      await openMcpPage();
      const mcp = await read(`({scrollWidth:document.documentElement.scrollWidth,inner:innerWidth,title:document.querySelector('.mcp-page .settings-page-title')?.textContent})`);
      check(mcp.title === 'MCP 服务器', 'MCP settings page still opens', mcp.title);
      check(mcp.scrollWidth <= mcp.inner + 1, '700px MCP page has no horizontal overflow', mcp);
      await shot('700-light-mcp');

      win.setContentSize(1320, 820);
      await sleep(350);
      await setTheme('深色');
      await openSettingsMenu();
      await shot('1320-dark-settings-nav-final');
      await openExtensionsPage();
      await shot('1320-dark-extensions');
      await openSkillsPage();
      await shot('1320-dark-skills');
      await openMcpPage();
      await shot('1320-dark-mcp');

      await openShortcuts();
      await read(`document.querySelector('.shortcut-reset-all').click()`);
      await waitFor(`localStorage.getItem(${JSON.stringify(STORAGE_KEY)})==='{}'`, 'cleanup reset all');
      await shot('1320-dark-clean');
      win.setContentSize(700, 600);
      await sleep(350);
      await shot('700-dark-default');
      const narrowDark = await read(`({scrollWidth:document.documentElement.scrollWidth,inner:innerWidth})`);
      check(narrowDark.scrollWidth <= narrowDark.inner + 1, '700px dark layout also has no horizontal overflow', narrowDark);
      await openSettingsMenu();
      await shot('700-dark-settings-nav');
      await openExtensionsPage();
      await shot('700-dark-extensions');
      await openSkillsPage();
      await shot('700-dark-skills');
      await openMcpPage();
      await shot('700-dark-mcp');
      win.setContentSize(1320, 820);
      await sleep(300);

      check(consoleErrors.length === 0, 'no renderer console errors', consoleErrors);
      console.log(`\nShortcut Electron: ${checks - failures.length}/${checks} checks passed; screenshots=${screenshots.length}`);
      if (failures.length) console.error('FAILED: ' + failures.join(' | '));
      fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, failures, screenshots, consoleErrors }, null, 2));
      app.exit(failures.length ? 1 : 0);
    } finally {
      harness.kill();
      if (win && !win.isDestroyed()) win.destroy();
    }
  }

  run().catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
