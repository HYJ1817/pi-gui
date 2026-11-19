/* 全局按钮语义系统的回归测试。
 *
 * 阶段 A（纯 Node）守 CSS 契约：Secondary 是基类且必须是非透明填充，
 * Ghost 必须透明，Primary/Danger 必须由共享 Token 驱动，页面不得重新
 * 引入第二套按钮或旧的简洁描边规则。
 *
 * 阶段 B（真实 Electron + 离线 visual-harness）守计算样式与真实页面：
 * 深/浅主题下的填充、边框、几何、Hover/Pressed/Focus-visible/Disabled/
 * Loading，以及信息页上「检查更新 / 检查 Pi 更新 / 重启 Pi / 打开日志 /
 * 导出故障报告 / 打开诊断 / 打开 GitHub」的次级语义。
 *
 * 不使用真 Pi，不写用户数据；所有临时目录都在 os.tmpdir()。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  Promise.resolve(nodePhase()).then(electronPhase).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  electronMain().catch(error => {
    console.error(error);
    require('electron').app.exit(1);
  });
}

/* ---------------- 阶段 A：CSS 与类名契约 ---------------- */

function nodePhase() {
  const assert = require('node:assert/strict');
  let passed = 0;
  const check = (name, fn) => {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  };
  const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
  const block = (css, selector) => {
    const start = css.indexOf(selector);
    if (start < 0) return '';
    const open = css.indexOf('{', start + selector.length);
    const close = css.indexOf('}', open);
    if (open < 0 || close < 0) return '';
    return css.slice(open + 1, close);
  };

  const primitives = read('public/ui/primitives.css');
  const tokens = read('public/tokens.css');
  const styles = read('public/styles.css');
  const provider = read('public/provider-management.css');

  const base = block(primitives, '.btn,\n.pm-btn');
  check('base .btn owns a filled Secondary surface', () => {
    assert.match(base, /background:\s*var\(--ds-button-secondary-bg\)/);
    assert.doesNotMatch(base, /background:\s*transparent/);
    assert.match(base, /border:\s*1px solid transparent/);
    assert.match(base, /height:\s*var\(--ds-button-height\)/);
    assert.match(base, /border-radius:\s*var\(--ds-button-radius\)/);
    assert.match(base, /font-size:\s*var\(--ds-button-font-size\)/);
  });
  check('Secondary token is a real neutral fill, not transparent', () => {
    const value = tokens.match(/--ds-button-secondary-bg:\s*([^;]+);/);
    assert.ok(value, 'missing --ds-button-secondary-bg');
    assert.ok(!/transparent/.test(value[1]), value[1]);
    assert.match(value[1], /--ds-tile-hover/);
  });
  check('Ghost is the only base variant that is transparent', () => {
    const ghost = block(primitives, '.btn.ghost,\n.pm-btn.pm-btn-ghost');
    assert.match(ghost, /background:\s*transparent/);
    const primary = block(primitives, '.btn.primary,\n.pm-btn.pm-primary');
    assert.match(primary, /background:\s*var\(--ds-button-primary-bg\)/);
    assert.doesNotMatch(primary, /background:\s*transparent/);
    const danger = block(primitives, '.btn.danger,\n.pm-btn.pm-btn-danger');
    assert.match(danger, /background:\s*var\(--ds-button-danger-bg\)/);
    assert.doesNotMatch(danger, /background:\s*transparent/);
  });
  check('Primary ink and danger ink use semantic tokens in both themes', () => {
    for (const token of ['--ds-button-primary-ink', '--ds-button-ghost-ink', '--ds-button-danger-ink', '--ds-button-focus-width']) {
      assert.match(tokens, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':'));
    }
    assert.match(primitives, /outline:\s*var\(--ds-button-focus-width\) solid var\(--ds-focus\)/);
    assert.match(primitives, /opacity:\s*var\(--ds-button-disabled-opacity\)/);
    assert.match(primitives, /aria-busy="true"\]::before/);
  });
  check('pages no longer own a competing button implementation', () => {
    const sources = [];
    for (const dir of ['public', path.join('public', 'ui')]) {
      for (const name of fs.readdirSync(path.join(ROOT, dir))) {
        if (name.endsWith('.css') || name.endsWith('.js')) sources.push(fs.readFileSync(path.join(ROOT, dir, name), 'utf8'));
      }
    }
    const all = sources.join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert.ok(!/ds-btn-secondary/.test(all), 'ds-btn-secondary returned');
    assert.ok(!/\.btn\.danger\s*\{/.test(styles), 'styles.css redefines .btn.danger');
    assert.ok(!/\.btn\.alt\s*\{/.test(styles), 'styles.css redefines .btn.alt');
    assert.ok(!/^\.pm-btn\s*\{/m.test(provider), 'provider-management.css redefines .pm-btn');
  });

  console.log(`phase A: ${passed} checks passed`);
  process.exitCode = 0;
}

/* ---------------- 阶段 B：真实 Electron ---------------- */

async function electronPhase() {
  console.log('phase B: real Electron computed styles');
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-buttons-'));
  fs.mkdirSync(path.join(world, 'profile'), { recursive: true });
  if (process.platform === 'win32') {
    try { execFileSync('icacls', [world, '/setintegritylevel', '(OI)(CI)L'], { stdio: 'ignore', windowsHide: true }); } catch { /* 环境不允许时保持原样 */ }
  }
  const env = { ...process.env, PI_GUI_BUTTON_WORLD: world };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const code = await new Promise(resolve => {
    const child = spawn(require('electron'), ['--no-sandbox', '--disable-gpu', __filename], { env, stdio: 'inherit', windowsHide: true });
    child.on('error', error => { console.error('electron spawn error: ' + error.message); resolve(1); });
    child.once('exit', value => resolve(value ?? 1));
  });
  process.exitCode = code === 0 ? 0 : 1;
}

async function electronMain() {
  const { app, BrowserWindow } = require('electron');
  const world = process.env.PI_GUI_BUTTON_WORLD;
  if (!world || !fs.existsSync(world)) {
    console.error('FAIL missing PI_GUI_BUTTON_WORLD');
    app.exit(1);
    return;
  }
  app.setPath('userData', path.join(world, 'profile'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.on('window-all-closed', () => {});

  let failures = 0;
  const check = (name, value, detail) => {
    const ok = Boolean(value);
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ' ' + JSON.stringify(detail)}`);
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const watchdog = setTimeout(() => { console.error('FAIL electron phase watchdog'); app.exit(1); }, 120_000);
  watchdog.unref();

  const harness = spawn(process.execPath, [path.join(ROOT, 'tests/visual-harness.cjs')], {
    cwd: world,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0', VISUAL_PUBLIC_ROOT: path.join(ROOT, 'public'), VISUAL_UPLOAD_DIR: path.join(world, 'uploads') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let harnessOut = '';
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('harness timeout')), 20_000);
    harness.stdout.on('data', chunk => {
      harnessOut += chunk;
      const match = harnessOut.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    harness.stderr.on('data', chunk => process.stderr.write(chunk));
  });
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(origin + '/api/status')).ok) break; } catch { /* 等待服务就绪 */ }
    await sleep(100);
  }

  const win = new BrowserWindow({
    width: 1320, height: 820, useContentSize: true, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  const read = js => win.webContents.executeJavaScript(js, true);
  const errors = [];
  win.webContents.on('console-message', (event, level, message) => {
    const lvl = event && typeof event === 'object' && 'level' in event ? event.level : level;
    const msg = String(event && typeof event === 'object' && 'message' in event ? event.message : message);
    if ((lvl === 'error' || lvl >= 3) && !msg.includes('Electron Security Warning')) errors.push(msg);
  });
  const setTheme = async theme => {
    await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.themePreference=${JSON.stringify(theme)}`);
    await sleep(200);
  };
  const dismissModal = async () => {
    if (await read(`(()=>{const m=document.getElementById('modal');return !!m&&!m.hidden})()`)) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await sleep(300);
    }
  };
  const openSettings = async () => {
    await read(`document.getElementById('navGlobalMore')?.click()`);
    await sleep(250);
  };
  const openPage = async id => {
    await openSettings();
    await read(`document.getElementById(${JSON.stringify(id)})?.click()`);
    await sleep(500);
  };
  const styleOf = selector => read(`(()=>{
    const b=document.querySelector(${JSON.stringify(selector)});
    if(!b)return null;
    const s=getComputedStyle(b),r=b.getBoundingClientRect();
    return {cls:String(b.className),text:(b.textContent||'').trim().slice(0,40),bg:s.backgroundColor,color:s.color,
      borderWidth:s.borderTopWidth,borderColor:s.borderTopColor,radius:s.borderRadius,
      height:Math.round(r.height),width:Math.round(r.width),fontSize:s.fontSize,fontWeight:s.fontWeight,
      padding:s.padding,outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,outlineColor:s.outlineColor,
      opacity:s.opacity,pointerEvents:s.pointerEvents,transform:s.transform,whiteSpace:s.whiteSpace};
  })()`);
  const isTransparent = value => !value || value === 'transparent' || /rgba\([^)]*,\s*0\)/.test(value) || /\/\s*0\)/.test(value);
  const injectProbe = async () => {
    await read(`(()=>{
      document.getElementById('dsButtonProbe')?.remove();
      const anchor=document.createElement('button');anchor.id='dsProbeAnchor';anchor.textContent='锚点';
      anchor.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;padding:0;border:0';
      const host=document.createElement('div');host.id='dsButtonProbe';
      host.style.cssText='position:fixed;left:12px;top:12px;z-index:2147483647;display:flex;flex-wrap:wrap;gap:8px;padding:8px;background:var(--ds-bg-primary)';
      host.innerHTML='<button id="dsProbeSecondary" class="btn">次要动作</button>'+
        '<button id="dsProbeGhost" class="btn ghost">弱动作</button>'+
        '<button id="dsProbePrimary" class="btn primary">主要动作</button>'+
        '<button id="dsProbeDanger" class="btn danger">删除</button>'+
        '<button id="dsProbeTiny" class="btn tiny">紧凑</button>'+
        '<button id="dsProbeDisabled" class="btn" disabled>禁用</button>'+
        '<button id="dsProbeBusy" class="btn" aria-busy="true">载入</button>';
      document.body.append(anchor,host);
      return true;
    })()`);
    await sleep(150);
  };
  const removeProbe = () => read(`document.getElementById('dsButtonProbe')?.remove();document.getElementById('dsProbeAnchor')?.remove()`);
  /* 探针固定在左上角；切主题/重建探针时鼠标若仍停在上一个探针的位置，
   * 新探针会立即处于 :hover，基线就采不到默认填充。先把指针移到探针外。 */
  const parkMouse = async () => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
    await sleep(150);
  };

  try {
    await win.loadURL(origin);
    await sleep(1600);
    await dismissModal();

    for (const theme of ['dark', 'light']) {
      await setTheme(theme);
      await injectProbe();
      await parkMouse();
      const secondary = await styleOf('#dsProbeSecondary');
      const ghost = await styleOf('#dsProbeGhost');
      const primary = await styleOf('#dsProbePrimary');
      const danger = await styleOf('#dsProbeDanger');
      const tiny = await styleOf('#dsProbeTiny');
      const disabled = await styleOf('#dsProbeDisabled');
      const busy = await styleOf('#dsProbeBusy');
      check(`${theme}: Secondary is a filled neutral button`, secondary && !isTransparent(secondary.bg) && parseFloat(secondary.borderWidth) > 0 && isTransparent(secondary.borderColor), secondary);
      check(`${theme}: Ghost stays transparent and distinct`, ghost && isTransparent(ghost.bg) && ghost.bg !== secondary.bg, ghost);
      check(`${theme}: Primary is not overridden by page styles`, primary && !isTransparent(primary.bg) && primary.bg !== secondary.bg, primary);
      check(`${theme}: Danger is a low-emphasis tinted action`, danger && !isTransparent(danger.bg) && danger.bg !== secondary.bg && danger.color !== secondary.color, danger);
      check(`${theme}: base geometry is 32px / 10px / 13px`, secondary && secondary.height === 32 && secondary.radius === '10px' && secondary.fontSize === '13px' && secondary.padding === '0px 12px', secondary);
      check(`${theme}: compact size is 28px`, tiny && tiny.height === 28, tiny);
      check(`${theme}: disabled is dimmed and inert`, disabled && Math.abs(Number(disabled.opacity) - 0.45) < 0.02 && disabled.pointerEvents === 'none', disabled);
      check(`${theme}: aria-busy keeps its size and adds a spinner`, busy && busy.height === 32 && Math.abs(Number(busy.opacity) - 0.6) < 0.02, busy);

      const r = await read(`(()=>{const r=document.getElementById('dsProbeSecondary').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
      await sleep(250);
      const hover = await styleOf('#dsProbeSecondary');
      check(`${theme}: Secondary hover deepens its fill`, hover && hover.bg !== secondary.bg && hover.height === 32, hover);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await sleep(200);
      const pressed = await styleOf('#dsProbeSecondary');
      win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      check(`${theme}: pressed keeps geometry and scales down`, pressed && pressed.height >= 30 && pressed.height <= 32 && /matrix\(0\.98/.test(pressed.transform), pressed);

      await read(`document.getElementById('dsProbeAnchor').focus()`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await sleep(150);
      const focused = await styleOf('#dsProbeSecondary');
      const active = await read(`document.activeElement?.id`);
      check(`${theme}: keyboard focus draws the shared 2px ring`, active === 'dsProbeSecondary' && focused && focused.outlineStyle === 'solid' && focused.outlineWidth === '2px', { active, focused });
      await removeProbe();
    }

    /* 信息页：这些按钮是普通独立动作，必须使用共享 Secondary，而不是透明描边。 */
    await setTheme('dark');
    await openPage('navInfo');
    await sleep(500);
    const infoSelectors = [
      ['restart Pi', '[data-about-action="restart-pi"]'],
      ['open logs', '[data-about-action="open-logs"]'],
      ['export report', '[data-about-action="export-report"]'],
      ['open diagnostics', '[data-about-action="open-diagnostics"]'],
      ['open GitHub', '[data-about-action="open-github"]'],
      ['check app update', '[data-about-update="app"] [data-update-action="check"]'],
      ['check Pi update', '[data-about-update="pi"] .update-head .btn'],
    ];
    const infoStyles = [];
    for (const [label, selector] of infoSelectors) {
      const style = await styleOf(selector);
      infoStyles.push(style);
      check(`info/dark: ${label} uses the filled Secondary variant`, style && /(^|\s)btn(\s|$)/.test(style.cls) && !/ghost/.test(style.cls) && !isTransparent(style.bg) && isTransparent(style.borderColor) && style.height === 32, style);
    }
    const consistent = infoStyles.every(style => style && style.radius === '10px' && style.fontSize === '13px');
    check('info/dark: the listed actions share one radius and font size', consistent, infoStyles.map(style => style && [style.radius, style.fontSize]));
    const piPrimary = await styleOf('[data-about-update="pi"] .btn.primary');
    check('info/dark: installing a Pi update remains the single primary action', piPrimary && !isTransparent(piPrimary.bg) && piPrimary.bg !== infoStyles[0]?.bg && piPrimary.text.includes('更新到'), piPrimary);

    await setTheme('light');
    const lightInfo = await styleOf('[data-about-action="restart-pi"]');
    check('info/light: Secondary keeps a real fill and readable ink', lightInfo && !isTransparent(lightInfo.bg) && lightInfo.color !== 'rgba(0, 0, 0, 0)' && lightInfo.bg !== infoStyles[0]?.bg, { dark: infoStyles[0], light: lightInfo });

    win.setContentSize(700, 600);
    await sleep(500);
    const narrow = await read(`(()=>{
      const rows=[...document.querySelectorAll('.about-row-actions')];
      return {ok:rows.every(row=>row.scrollWidth<=row.clientWidth+1),
        buttons:[...document.querySelectorAll('[data-about-action="restart-pi"],[data-about-action="open-logs"],[data-about-action="export-report"],[data-about-action="open-diagnostics"],[data-about-action="open-github"]')].every(b=>{const s=getComputedStyle(b),r=b.getBoundingClientRect();return r.height>=30&&s.whiteSpace==='nowrap'})};
    })()`);
    check('info/narrow 700x600: actions stay inside their row and keep readable height', narrow.ok && narrow.buttons, narrow);

    win.setContentSize(1320, 820);
    await sleep(300);
    check('no renderer console errors during the button checks', errors.length === 0, errors.slice(0, 4));
  } catch (error) {
    failures += 1;
    console.error('FAIL electron assertions:', error && error.stack ? error.stack : error);
  } finally {
    clearTimeout(watchdog);
    try { win.destroy(); } catch { /* 已销毁 */ }
    try { harness.kill(); } catch { /* 已退出 */ }
    console.log(`phase B: ${failures === 0 ? 'passed' : failures + ' failure(s)'}`);
    app.exit(failures === 0 ? 0 : 1);
  }
}
