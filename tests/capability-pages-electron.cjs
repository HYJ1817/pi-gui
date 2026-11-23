/* 技能 / 扩展 / MCP 三个能力页在真实 Electron 窗口里的渲染取证。
 *
 * 与 capability-pages-visual.cjs 的分工：那边用无头 Chromium 覆盖四组尺寸 × 主题与状态；
 * 这边跑真实桌面窗口（Electron 44），用系统缩放对应的 devicePixelRatio 取证，
 * 回答「实际桌面窗口及缩放 / DPR 下排版是否一致」。
 *
 * 数据仍来自 tests/visual-harness.cjs（隔离、离线、不启动真 pi）。
 * 用法：node tests/capability-pages-electron.cjs --tag=after
 * 产物：.shots/capability-pages/<tag>-electron/*.png 与 manifest.json
 * 只用于验收取证，不属于 npm test 的 canonical 链。 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

const root = path.resolve(__dirname, '..');
const tag = (() => {
  const arg = process.argv.find((value) => value.startsWith('--tag='));
  return arg ? arg.slice(6).replace(/[^\w.-]/g, '') || 'run' : 'run';
})();
const out = path.join(root, '.shots', 'capability-pages', `${tag}-electron`);
const scale = Number(process.env.CAPABILITY_SCALE || '1.5');
const limit = Number(process.env.CAPABILITY_ELECTRON_LIMIT || '0');

if (!process.versions.electron) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-capability-electron-'));
  fs.mkdirSync(out, { recursive: true });
  const env = { ...process.env, CAPABILITY_ELECTRON_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, `--tag=${tag}`, '--no-sandbox'], {
    env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const artifact = /^ARTIFACT ([a-z0-9.-]+) ([a-z0-9+/=]+)$/i.exec(line);
    if (artifact) fs.writeFileSync(path.join(out, artifact[1]), Buffer.from(artifact[2], 'base64'));
    else console.log(line);
  });
  child.on('close', (code) => {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    process.exit(code ?? 1);
  });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.CAPABILITY_ELECTRON_PROFILE);
  app.commandLine.appendSwitch('force-device-scale-factor', String(scale));
  app.commandLine.appendSwitch('disable-http-cache');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function run() {
    await app.whenReady();
    const emit = (name, data) => new Promise((resolve) => process.stdout.write(`ARTIFACT ${name} ${data.toString('base64')}\n`, resolve));
    const harness = spawn(process.execPath, [path.join(root, 'tests', 'visual-harness.cjs')], {
      cwd: process.env.CAPABILITY_ELECTRON_PROFILE,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0' },
      windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
    });
    let window;
    const shots = [];
    const metrics = [];
    const errors = [];
    try {
      const origin = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('visual harness did not start')), 10000);
        harness.stdout.on('data', (chunk) => {
          const url = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
          if (url) { clearTimeout(timer); resolve(url); }
        });
        harness.once('error', reject);
      });
      window = new BrowserWindow({
        width: 1320, height: 820, useContentSize: true, show: false, autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      window.webContents.on('console-message', (_event, level, message) => {
        if (level >= 3 && !message.includes('Electron Security Warning')) errors.push(message);
      });
      window.showInactive();
      window.webContents.debugger.attach('1.3');
      const js = (code) => window.webContents.executeJavaScript(code);
      const key = async (keyName, code, windowsVirtualKeyCode) => {
        for (const type of ['keyDown', 'keyUp']) {
          await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
            type, key: keyName, code, windowsVirtualKeyCode,
          });
        }
      };
      const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
        .catch((error) => { throw new Error('Unable to click ' + selector, { cause: error }); });
      const clickText = (selector, text) => js(`(() => {
        const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find((candidate) => (candidate.textContent || '').includes(${JSON.stringify(text)}));
        if (!node) throw new Error('missing ${text}');
        node.click();
      })()`);
      async function wait(expression, label = expression) {
        for (let i = 0; i < 160; i++) {
          if (await js(expression).catch(() => false)) return;
          await sleep(50);
        }
        throw new Error('Not rendered: ' + label + ' ' + JSON.stringify(errors));
      }
      async function shot(name, width, height) {
        await sleep(180);
        const image = await window.webContents.capturePage();
        assert.deepEqual(image.getSize(), { width: Math.round(width * scale), height: Math.round(height * scale) },
          'capturePage must be physical pixels for DPR ' + scale);
        await emit(name + '.png', image.toPNG());
        shots.push({ name, size: image.getSize() });
      }
      async function measure(label) {
        const value = await js(`(() => {
          const surface = document.getElementById('workSurface');
          const inner = surface.firstElementChild;
          return {
            dpr: devicePixelRatio,
            innerWidth, innerHeight,
            documentScrollWidth: document.documentElement.scrollWidth,
            surfaceScrollWidth: surface.scrollWidth, surfaceClientWidth: surface.clientWidth,
            innerScrollWidth: inner ? inner.scrollWidth : null, innerClientWidth: inner ? inner.clientWidth : null,
            theme: document.documentElement.dataset.theme,
          };
        })()`);
        metrics.push({ label, ...value });
        assert.ok(value.documentScrollWidth <= value.innerWidth, `${label}: horizontal document overflow`);
        assert.ok(value.surfaceScrollWidth <= value.surfaceClientWidth, `${label}: horizontal surface overflow`);
        return value;
      }

      async function fresh(theme) {
        console.log('nav', theme);
        await window.loadURL(origin + '/');
        console.log('loaded', theme);
        await wait(`document.getElementById('connText')?.textContent === '已连接'`, 'connected');
        console.log('connected', theme);
        await js(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
        await sleep(250);
      }
      async function openSkills() {
        await click('#navGlobalMore');
        await wait(`!document.getElementById('globalMoreMenu').hidden`, 'settings menu');
        await click('#navSkills');
        await wait(`document.querySelectorAll('#workSurface .skills-group .skill-row').length > 0`, 'skills rows');
        await sleep(350);
      }
      async function openExtensions(tab) {
        await click('#navExtensions');
        await wait(`!!document.querySelector('#workSurface.extensions-page .extensions-head')`, 'extensions page');
        if (tab === 'market') {
          await click('#extensionsTabMarket');
          await wait(`!!document.querySelector('.extensions-market-card')`, 'extensions market');
        } else {
          await wait(`!!document.querySelector('.extensions-card')`, 'installed extensions');
        }
        await sleep(450);
      }
      async function openMcp() {
        await click('#navGlobalMore');
        await wait(`!document.getElementById('globalMoreMenu').hidden`, 'settings menu');
        await click('#navMcp');
        await wait(`!!document.querySelector('#workSurface .mcp-page .mcp-server')`, 'mcp rows');
        await sleep(450);
      }

      /* ---------- 表单里的共享 listbox（exposure / 三处写入目标） ---------- */
      const pickerProofs = [];
      const importFixture = path.join(process.env.CAPABILITY_ELECTRON_PROFILE, 'picker-import.md');
      fs.writeFileSync(importFixture, '---\nname: claude-notes\ndescription: 导入位置选择器取证\n---\n# 会议笔记\n');
      const scrollInto = async (selector) => {
        await js(`(() => {
          const node = document.querySelector(${JSON.stringify(selector)});
          if (node) node.scrollIntoView({ block: 'center' });
          return Boolean(node);
        })()`);
        await sleep(250);
      };
      const setFileInput = async (selector, filePath) => {
        const documentResult = await window.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
        const found = await window.webContents.debugger.sendCommand('DOM.querySelector', {
          nodeId: documentResult.root.nodeId, selector,
        });
        assert.ok(found.nodeId, '找不到文件输入：' + selector);
        await window.webContents.debugger.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId: found.nodeId });
      };
      async function provePicker(control, selector, theme, width, height, move) {
        await scrollInto(selector);
        const before = await js(`document.querySelector(${JSON.stringify(selector)}).dataset.value`);
        await click(selector);
        await wait(`!!document.querySelector('.pi-anchored-menu.ds-picker-menu [role="option"]')`, control + ' menu');
        await key(move, move, move === 'End' ? 35 : 40);
        const box = await js(`(() => {
          const menu = document.querySelector('.pi-anchored-menu.ds-picker-menu');
          const rect = menu.getBoundingClientRect();
          return {
            parent: menu.parentElement === document.body,
            left: Math.round(rect.left), top: Math.round(rect.top),
            right: Math.round(rect.right), bottom: Math.round(rect.bottom),
            viewport: [innerWidth, innerHeight],
            focused: document.activeElement?.dataset?.value ?? null,
            theme: document.documentElement.dataset.theme,
          };
        })()`);
        assert.equal(box.parent, true, control + ': menu must be portaled to body');
        assert.ok(box.left >= 0 && box.top >= 0
          && box.right <= box.viewport[0] + 1 && box.bottom <= box.viewport[1] + 1,
          control + ': menu is clipped by the viewport ' + JSON.stringify(box));
        await shot(`${control}-menu-${width}x${height}-${theme}`, width, height);
        await key('Enter', 'Enter', 13);
        await wait(`!document.querySelector('.pi-anchored-menu')`, control + ' menu closed');
        const after = await js(`document.querySelector(${JSON.stringify(selector)}).dataset.value`);
        const label = await js(`document.querySelector(${JSON.stringify(selector)}).textContent.trim()`);
        assert.notEqual(after, before, control + ': keyboard selection must change the value');
        const trigger = await js(`(() => {
          const node = document.querySelector(${JSON.stringify(selector)});
          const style = getComputedStyle(node);
          return {
            height: Math.round(node.getBoundingClientRect().height),
            background: style.backgroundColor,
            fontSize: style.fontSize,
          };
        })()`);
        if (control === 'mcp-exposure') {
          const input = await js(`(() => {
            const node = document.querySelector('.mcp-form-modal .mcp-input.ds-input');
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return { height: Math.round(rect.height), background: style.backgroundColor };
          })()`);
          assert.equal(trigger.height, input.height, 'mcp exposure: trigger height must match sibling ds-input');
          assert.equal(trigger.background, input.background, 'mcp exposure: trigger surface must match sibling ds-input');
        }
        pickerProofs.push({ control, theme, size: [width, height], before, after, label, box, trigger });
      }
      async function captureFormPickers(theme, width, height) {
        await fresh(theme);
        window.setContentSize(width, height);
        await wait(`innerWidth === ${width} && innerHeight === ${height}`, 'content size');
        await openMcp();
        await click('[data-focus-key="add"]');
        await wait(`!!document.querySelector('.mcp-form-modal [data-field="exposure"]')`, 'mcp exposure picker');
        await provePicker('mcp-exposure', '.mcp-form-modal [data-field="exposure"]', theme, width, height, 'ArrowDown');
        await clickText('.mcp-form-modal .mcp-modal-foot-actions button', '取消');
        await wait(`!document.querySelector('.mcp-form-modal')`, 'mcp form closed');

        await openSkills();
        await clickText('.skills-actions-bar button', '新建');
        await wait(`!!document.querySelector('.skills-editor-dialog [data-field="target"]')`, 'editor target picker');
        await provePicker('skills-editor-target', '.skills-editor-dialog [data-field="target"]', theme, width, height, 'End');
        await clickText('.skills-editor-dialog .skills-dialog-foot button', '取消');
        await wait(`!document.querySelector('.skills-editor-dialog')`, 'editor closed');

        await openSkills();
        await clickText('.skills-page .skills-group[data-scope="user"] .skills-group-actions button', '导入文件');
        await wait(`!!document.querySelector('.skills-import-dialog')`, 'import dialog');
        await setFileInput('.skills-import-dialog .skills-file-input', importFixture);
        await wait(`!!document.querySelector('.skills-import-dialog .skills-import-plan:not([hidden])')`, 'import plan');
        await wait(`!!document.querySelector('.skills-import-dialog [data-field="target"]')`, 'import target picker');
        await provePicker('skills-import-target', '.skills-import-dialog [data-field="target"]', theme, width, height, 'End');
        await clickText('.skills-import-dialog .skills-dialog-foot button', '取消');
        await wait(`!document.querySelector('.skills-import-dialog')`, 'import closed');

        await openSkills();
        await clickText('.skills-actions-bar button', '市场');
        await wait(`document.querySelectorAll('.skills-market-card').length > 0`, 'market cards');
        await clickText('.skills-market-card button', '安装');
        await wait(`!!document.querySelector('.skills-preview-dialog [data-field="install-target"]')`, 'install target picker');
        await provePicker('skills-market-target', '.skills-preview-dialog [data-field="install-target"]', theme, width, height, 'End');
        await clickText('.skills-preview-dialog .skills-dialog-foot button', '关闭');
        await wait(`!document.querySelector('.skills-preview-dialog')`, 'preview closed');
      }

      const pages = [
        { name: 'skills-list', open: openSkills, menu: '.skills-project .project-picker-trigger', fontScale: true },
        { name: 'skills-market', open: async () => { await openSkills(); await clickText('.skills-actions-bar button', '市场'); await wait(`!!document.querySelector('.skills-market')`, 'skills market'); await sleep(450); } },
        { name: 'extensions-installed', open: () => openExtensions('installed'), fontScale: true },
        { name: 'extensions-market', open: () => openExtensions('market') },
        { name: 'mcp-list', open: openMcp, menu: '.mcp-project-picker .project-picker-trigger', fontScale: true },
        { name: 'mcp-market', open: async () => { await openMcp(); await clickText('.mcp-page-actions button', '市场'); await wait(`!!document.querySelector('.mcp-market-page')`, 'mcp market'); await sleep(450); } },
      ];

      const sizes = limit ? [{ width: 1320, height: 820 }] : [{ width: 1320, height: 820 }, { width: 700, height: 600 }];
      const themes = limit ? ['dark'] : ['dark', 'light'];
      const chosen = limit ? pages.slice(0, limit) : pages;
      /* 先导航一次：在第一次 loadURL 之前调用 executeJavaScript 会一直挂住。 */
      await window.loadURL(origin + '/');
      await wait(`document.getElementById('connText')?.textContent === '已连接'`, 'connected');
      for (const dims of sizes) {
        window.setContentSize(dims.width, dims.height);
        await wait(`innerWidth === ${dims.width} && innerHeight === ${dims.height}`, 'content size');
        for (const theme of themes) {
          for (const page of chosen) {
            console.log('open', page.name, dims.width, theme);
            await fresh(theme);
            await page.open();
            console.log('capture', page.name, dims.width, theme);
            await measure(`${page.name}-${dims.width}x${dims.height}-${theme}`);
            await shot(`${page.name}-${dims.width}x${dims.height}-${theme}`, dims.width, dims.height);
            console.log('shot', page.name, dims.width, theme);
            /* Project switchers: real anchored listbox, opened by pointer and
             * moved with a real ArrowDown key, in both themes and window sizes. */
            if (page.menu) {
              await click(page.menu);
              await wait(`!!document.querySelector('.pi-anchored-menu.ds-picker-menu [role="option"]')`, page.name + ' project menu');
              await key('ArrowDown', 'ArrowDown', 40);
              await shot(`${page.name}-project-menu-${dims.width}x${dims.height}-${theme}`, dims.width, dims.height);
              await key('Escape', 'Escape', 27);
              await wait(`!document.querySelector('.pi-anchored-menu')`, page.name + ' project menu closed');
            }
            /* 旧缓存刷新失败：真实 Electron 里也必须是一行状态，不是横幅。 */
            if (page.name === 'mcp-market' && process.env.MCP_MARKET_STALE === '1') {
              await click('[data-focus-key="source:registry"]');
              await wait(`!!document.querySelector('.mcp-market-page .mcp-market-refresh-note.is-warn')`, 'mcp stale status');
              const stale = await js(`(() => {
                const node = document.querySelector('.mcp-market-refresh-note');
                const style = getComputedStyle(node);
                return {
                  text: node.textContent,
                  banner: node.classList.contains('mcp-banner'),
                  background: style.backgroundColor,
                  borderLeft: style.borderLeftWidth,
                  height: Math.round(node.getBoundingClientRect().height),
                };
              })()`);
              assert.equal(stale.banner, false, 'stale status must not be a banner');
              assert.equal(stale.background, 'rgba(0, 0, 0, 0)', 'stale status must not paint a surface');
              assert.equal(stale.borderLeft, '0px', 'stale status must not draw a left bar');
              assert.ok(stale.height <= 24, 'stale status must stay one line: ' + stale.height);
              assert.equal(stale.text.includes('fixture'), false, 'stale status must not expose diagnostics');
              await shot(`mcp-market-stale-${dims.width}x${dims.height}-${theme}`, dims.width, dims.height);
              await click('[data-focus-key="source:builtin"]');
              await wait(`document.querySelectorAll('.mcp-market-card:not(.is-skeleton)').length >= 9`, 'back to builtin');
            }
            /* Font scaling is the app's --font-scale, not window zoom. */
            if (page.fontScale && !limit) {
              for (const font of [125, 150]) {
                await js(`document.documentElement.style.setProperty('--font-scale', '${(font / 100).toFixed(2)}')`);
                await sleep(220);
                await measure(`${page.name}-font-${font}-${dims.width}x${dims.height}-${theme}`);
                await shot(`${page.name}-font-${font}-${dims.width}x${dims.height}-${theme}`, dims.width, dims.height);
              }
              await js(`document.documentElement.style.removeProperty('--font-scale')`);
            }
          }
        }
      }

      if (!limit) {
        for (const combo of [
          { theme: 'dark', width: 1320, height: 820 },
          { theme: 'light', width: 700, height: 600 },
        ]) {
          console.log('form pickers', combo.width, combo.theme);
          await captureFormPickers(combo.theme, combo.width, combo.height);
        }
      }

      fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
        tag, scale, origin, generatedAt: new Date().toISOString(), shots, metrics, pickerProofs, errors,
        electron: process.versions.electron,
      }, null, 2));
      console.log(`electron visual: ${shots.length} shots, ${metrics.length} measurements, ${errors.length} renderer errors`);
      assert.equal(errors.length, 0, 'renderer errors: ' + errors.join('\n'));
    } finally {
      if (window) window.destroy();
      try { harness.kill(); } catch { /* ignore */ }
    }
  }

  app.whenReady().then(run).then(() => app.exit(0)).catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
