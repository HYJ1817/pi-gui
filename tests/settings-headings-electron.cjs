const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const tempWorld = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-headings-'));
  env.HEADINGS_WORLD = tempWorld;
  const electronPath = require('c:\\pi-GUI\\node_modules\\electron');
  const child = spawn(electronPath, [__filename, '--no-sandbox'], { env, stdio: 'inherit' });
  child.on('exit', code => {
    fs.rm(tempWorld, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }, () => {});
    process.exit(code ?? 0);
  });
} else {
  const { app, BrowserWindow } = require('electron');

  app.on('window-all-closed', () => {});

  async function run() {
    console.log('Running tests/settings-headings-electron.cjs (Real Electron Page Title Visibility Test)...');
    const world = process.env.HEADINGS_WORLD;
    app.setPath('userData', world);
    await app.whenReady();

    const ROOT = 'c:\\pi-GUI';
    const harness = spawn(process.execPath, [path.join(ROOT, 'tests/visual-harness.cjs')], {
      cwd: world,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const ORIGIN = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Harness did not start')), 10000);
      harness.stdout.on('data', chunk => {
        const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      harness.once('error', reject);
    });

    const win = new BrowserWindow({
      width: 1205,
      height: 803,
      show: false,
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: 46, color: '#00000000', symbolColor: '#71717a' },
      webPreferences: { nodeIntegration: false }
    });
    await win.loadURL(ORIGIN);
    await new Promise(r => setTimeout(r, 1200));

    // 1. Check Settings Overview H2 visibility
    await win.webContents.executeJavaScript(`document.querySelector('#navGlobalMore').click()`);
    await new Promise(r => setTimeout(r, 500));

    const overview = await win.webContents.executeJavaScript(`(()=>{
      const h2 = document.querySelector('.settings-surface h2');
      if (!h2) return null;
      const cs = getComputedStyle(h2);
      const rect = h2.getBoundingClientRect();
      const titlebar = document.querySelector('.settings-titlebar');
      const tbRect = titlebar ? titlebar.getBoundingClientRect() : null;
      return {
        text: h2.textContent,
        display: cs.display,
        visibility: cs.visibility,
        top: rect.top,
        height: rect.height,
        titlebarVisible: titlebar ? cs.display !== 'none' && tbRect && tbRect.height > 0 : false
      };
    })()`);

    assert.ok(overview, 'Overview H2 must exist');
    assert.equal(overview.text, '设置', 'Overview H2 text must be 设置');
    assert.equal(overview.display, 'block');
    assert.equal(overview.visibility, 'visible');
    assert.ok(overview.top >= 46, `Overview H2 top (${overview.top}) must be below top titlebar (46px)`);
    assert.ok(overview.height >= 30, `Overview H2 height (${overview.height}) must be >= 30px`);
    assert.equal(overview.titlebarVisible, false, 'Redundant titlebar must not occlude overview H2');
    console.log('✓ Settings Overview H2 is completely visible at y=' + overview.top);

    // 2. Check Appearance Page Title visibility
    await win.webContents.executeJavaScript(`document.querySelector('#navAppearance').click()`);
    await new Promise(r => setTimeout(r, 500));

    const appearance = await win.webContents.executeJavaScript(`(()=>{
      const h3 = document.querySelector('.settings-detail-card > h3');
      if (!h3) return null;
      const cs = getComputedStyle(h3);
      const rect = h3.getBoundingClientRect();
      return {
        text: h3.textContent,
        display: cs.display,
        visibility: cs.visibility,
        top: rect.top,
        height: rect.height
      };
    })()`);

    assert.ok(appearance, 'Appearance H3 must exist');
    assert.equal(appearance.text, '外观与主题', 'Appearance H3 text must be 外观与主题');
    assert.equal(appearance.display, 'block');
    assert.equal(appearance.visibility, 'visible');
    assert.ok(appearance.top >= 46, `Appearance H3 top (${appearance.top}) must be below top titlebar`);
    console.log('✓ Appearance H3 is completely visible at y=' + appearance.top);

    // 3. Check Providers Page Title visibility
    await win.webContents.executeJavaScript(`document.querySelector('#navProviders').click()`);
    await new Promise(r => setTimeout(r, 500));

    const providers = await win.webContents.executeJavaScript(`(()=>{
      const h3 = document.querySelector('.settings-detail-card .settings-page-title');
      if (!h3) return null;
      const cs = getComputedStyle(h3);
      const rect = h3.getBoundingClientRect();
      return {
        text: h3.textContent,
        display: cs.display,
        visibility: cs.visibility,
        top: rect.top,
        height: rect.height
      };
    })()`);

    assert.ok(providers, 'Providers H3 must exist');
    assert.equal(providers.text, '模型配置', 'Providers H3 text must be 模型配置');
    assert.equal(providers.display, 'block');
    assert.equal(providers.visibility, 'visible');
    assert.ok(providers.top >= 46, `Providers H3 top (${providers.top}) must be below top titlebar`);
    console.log('✓ Providers H3 is completely visible at y=' + providers.top);

    // 4. Check App Updates Page Title visibility
    await win.webContents.executeJavaScript(`document.querySelector('#navAppUpdates').click()`);
    await new Promise(r => setTimeout(r, 500));

    const appUpdates = await win.webContents.executeJavaScript(`(()=>{
      const h3 = document.querySelector('.settings-detail-card > h3');
      if (!h3) return null;
      const cs = getComputedStyle(h3);
      const rect = h3.getBoundingClientRect();
      return {
        text: h3.textContent,
        display: cs.display,
        visibility: cs.visibility,
        top: rect.top,
        height: rect.height
      };
    })()`);

    assert.ok(appUpdates, 'App Updates H3 must exist');
    assert.equal(appUpdates.text, '应用与更新', 'App Updates H3 text must be 应用与更新');
    assert.equal(appUpdates.display, 'block');
    assert.equal(appUpdates.visibility, 'visible');
    assert.ok(appUpdates.top >= 46, `App Updates H3 top (${appUpdates.top}) must be below top titlebar`);
    console.log('✓ App Updates H3 is completely visible at y=' + appUpdates.top);

    harness.kill();
    console.log('\nAll Real Electron page title visibility assertions PASSED!\n');
    app.exit(0);
  }

  run().catch(err => {
    console.error(err);
    app.exit(1);
  });
}
