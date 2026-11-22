/* 绘制真实应用 Renderer，数据与包命令均来自隔离的 visual-harness fixture。 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { contrastSample } = require('./fixtures/system-settings-states.cjs');

const root = path.resolve(__dirname, '..');
const out = process.env.EXTENSIONS_SHOTS_DIR || path.join(root, '.shots', 'extensions-facelift');

if (!process.versions.electron) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-extensions-electron-'));
  fs.mkdirSync(out, { recursive: true });
  const env = { ...process.env, EXTENSIONS_ELECTRON_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, '--no-sandbox'], { env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
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
  app.setPath('userData', process.env.EXTENSIONS_ELECTRON_PROFILE);
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('disable-http-cache');
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function run() {
    await app.whenReady();
    const emit = (name, data) => new Promise((resolve) => process.stdout.write(`ARTIFACT ${name} ${data.toString('base64')}\n`, resolve));
    const harness = spawn(process.execPath, [path.join(root, 'tests', 'visual-harness.cjs')], {
      cwd: process.env.EXTENSIONS_ELECTRON_PROFILE,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0' },
      windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
    });
    let window;
    let checks = 0;
    const metrics = [];
    const shots = [];
    const errors = [];
    const verify = (condition, label) => {
      assert.ok(condition, label);
      checks++;
      console.log('ok', checks, label);
    };
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
      const js = (code) => window.webContents.executeJavaScript(code);
      const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
        .catch((error) => { throw new Error('Unable to click ' + selector, { cause: error }); });
      async function wait(expression) {
        for (let i = 0; i < 100; i++) {
          if (await js(expression).catch(() => false)) return;
          await sleep(50);
        }
        throw new Error('Not rendered: ' + expression + ' ' + JSON.stringify(errors));
      }
      async function shot(name, width, height) {
        await sleep(140);
        const image = await window.webContents.capturePage();
        assert.deepEqual(image.getSize(), { width, height });
        await emit(name + '.png', image.toPNG());
        shots.push(name);
      }
      async function key(keyName, code, windowsVirtualKeyCode) {
        for (const type of ['keyDown', 'keyUp']) {
          const text = type === 'keyDown' && keyName === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {};
          await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: keyName, code, windowsVirtualKeyCode, ...text });
        }
      }
      await window.loadURL(origin);
      await wait(`document.querySelector('#connText')?.textContent==='已连接'`);
      window.showInactive();
      window.webContents.debugger.attach('1.3');
      // Feed multiline diagnostics through the production notification path, not the DOM or a real installation.
      const warnings = [
        'Optional index unavailable.\n\n离线验收：索引未就绪。\n' + ' Check the local fixture settings.\n'.repeat(12) + 'End of fixture.',
        'Fixture connection unavailable.\nDetail: ' + 'offline-'.repeat(45),
      ];
      const seedWarnings = () => js(`(async () => { const { handleExtensionNotification } = await import('/extension-notices.js');
        for (const message of ${JSON.stringify(warnings)}) handleExtensionNotification({ message, notifyType:'warning' }); })()`);
      const freshRun = () => js(`(async () => {
        const { S } = await import('/state.js'); S.bridgeRun = (S.bridgeRun || 0) + 1;
        document.dispatchEvent(new Event('pi-gui:capability-bridge-ready'));
        await new Promise(requestAnimationFrame);
        return { hidden: document.querySelector('.extension-notices').hidden, focus: document.activeElement.id,
          search: document.activeElement.getAttribute('aria-label') };
      })()`);

      for (const [width, height] of [[1320, 820], [700, 600]]) {
        window.setContentSize(width, height);
        await wait(`innerWidth===${width} && innerHeight===${height}`);
        for (const theme of ['dark', 'light']) {
          await js(`document.documentElement.dataset.theme = '${theme}'`);
          const prefix = `${width}-${theme}`;
          await seedWarnings();
          await click('#navExtensions');
          await wait(`document.querySelectorAll('.extensions-list .extensions-card').length>=3`);
          const installed = await js(`(() => {
            const title = document.querySelector('.extensions-title');
            const titleStyle = getComputedStyle(title);
            const groups = [...document.querySelectorAll('.extensions-grid')];
            const broken = document.querySelector('[data-extension-id="ext-broken"]');
            return {
              plainTitle: titleStyle.fontSize === '30px' && titleStyle.fontWeight === '700'
                && ![...document.querySelectorAll('.extensions-head svg:not(.extensions-head-actions svg)')].some(svg => svg.getClientRects().length),
              fullRows: groups.every(group => [...group.children].every(row =>
                Math.abs(row.getBoundingClientRect().width - group.getBoundingClientRect().width) < 1)),
              descriptionOmitted: !!broken?.querySelector('.extensions-card-error') && !broken.querySelector('.extensions-card-desc'),
            };
          })()`);
          verify(installed.plainTitle, prefix + ' plain 30px title');
          verify(installed.fullRows && installed.descriptionOmitted, prefix + ' full-width rows without placeholder descriptions');
          const labels = ['.extensions-list .ext-name', '.extensions-card-meta', '.extensions-card-error', '.extensions-list .ds-badge-success', '.extensions-list .ds-badge-warning'];
          const contrasts = await js(`${JSON.stringify(labels)}.map(selector => (${contrastSample.toString()})(selector))`);
          verify(contrasts.every(sample => sample.ratio >= 4.5), prefix + ' installed labels and status text meet 4.5:1');
          const notices = await js(`(() => {
            const details = document.querySelector('.extension-notices'), summary = details.querySelector('summary');
            return { height: details.getBoundingClientRect().height, closed: !details.open,
              summary: summary.innerText, firstRowTop: document.querySelector('.extensions-list .extensions-card').getBoundingClientRect().top };
          })()`);
          verify(notices.closed && notices.summary.includes('2 条警告') && notices.height <= 44 && notices.firstRowTop < height / 2,
            prefix + ' long diagnostics take one row; first installed extension is visible');
          await shot(prefix + '-installed', width, height);
          await js(`document.querySelector('.extensions-notice-summary').focus()`);
          await key('Enter', 'Enter', 13);
          await wait(`document.querySelector('.extension-notices').open`);
          const detail = await js(`(() => {const b=document.querySelector('.extensions-notice-body');
            return {top:b.getBoundingClientRect().top, height:b.clientHeight, contentHeight:b.scrollHeight, overflow:b.scrollWidth-b.clientWidth,
              fullText:b.innerText.includes('End of fixture.'), focus:document.activeElement.matches('.extensions-notice-summary')};})()`);
          verify(detail.focus && detail.fullText && detail.contentHeight > detail.height && detail.height <= height / 3 && detail.overflow <= 1,
            prefix + ' keyboard opens a bounded panel; the full multiline text fits horizontally');
          if (prefix === '1320-dark' || prefix === '700-light') await shot(prefix + '-run-notices', width, height);
          await key('Tab', 'Tab', 9);
          await wait(`document.activeElement.matches('.extensions-notice-body')`);
          const pageScroll = await js(`document.querySelector('.extensions-scroll').scrollTop`);
          await key('PageDown', 'PageDown', 34);
          await wait(`document.querySelector('.extensions-notice-body').scrollTop > 0`);
          verify(await js(`document.querySelector('.extensions-scroll').scrollTop`) === pageScroll, prefix + ' keyboard scroll stays inside the diagnostic text');
          await js(`document.querySelector('.extensions-notice-summary').focus()`);
          await key('Enter', 'Enter', 13);
          await wait(`!document.querySelector('.extension-notices').open`);
          await freshRun(); // Normal browsing screenshot, without hiding real notices via CSS.
          const tabPoint = await js(`(() => {const r=document.querySelector('#extensionsTabMarket').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
          for (const type of ['mousePressed', 'mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type, ...tabPoint, button:'left', clickCount:1,
          });
          await wait(`document.querySelectorAll('.extensions-market-card').length===13`);
          const layout = await js(`(() => {
            const grid = document.querySelector('.extensions-market-grid');
            const cards = [...grid.children].map((node) => {
              const rect = node.getBoundingClientRect();
              return { width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top),
                left: Math.round(rect.left), right: Math.round(rect.right),
                foot: Math.round(node.querySelector('.extensions-market-card-foot').getBoundingClientRect().bottom) };
            });
            const scroll = document.querySelector('.extensions-scroll');
            return { cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
              width: innerWidth, height: innerHeight, scrollWidth: scroll.scrollWidth, scrollInner: scroll.clientWidth,
              button: Math.round(grid.querySelector('.btn').getBoundingClientRect().height),
              radius: getComputedStyle(grid.firstElementChild).borderRadius, cards,
              footerBackground: getComputedStyle(grid.querySelector('.extensions-market-card-foot')).backgroundColor,
              descriptionClamp: getComputedStyle(grid.querySelector('.extensions-card-desc')).webkitLineClamp,
              title: getComputedStyle(document.querySelector('.extensions-title')).fontSize,
              titleGlyph: document.querySelector('.extensions-market-title-glyph').getBoundingClientRect().width,
              primaryRefresh: document.querySelector('.extensions-head-actions .extensions-refresh').classList.contains('primary'),
              facetRows: new Set([...document.querySelectorAll('.extensions-categories button')].map(b=>Math.round(b.getBoundingClientRect().top))).size,
              facetRadius: getComputedStyle(document.querySelector('.extensions-categories button')).borderTopLeftRadius,
              sortBounds: document.querySelector('.extensions-sorts').getBoundingClientRect().toJSON(),
              facetBounds: document.querySelector('.extensions-categories').getBoundingClientRect().toJSON() };
          })()`);
          const firstRow = layout.cards.filter((item) => item.top === layout.cards[0].top);
          verify(layout.cols === (width === 1320 ? 3 : 1), prefix + ' market column count');
          verify(layout.scrollWidth <= layout.scrollInner + 1 && layout.cards.every(({ left, right }) => left >= 0 && right <= width), prefix + ' no horizontal overflow');
          verify(new Set(firstRow.map(({ foot }) => foot)).size === 1, prefix + ' aligned action row');
          verify(layout.button === 32, prefix + ' standard market card action height');
          const marketLabels = ['.extensions-categories [aria-pressed="true"]','.extensions-categories [aria-pressed="false"]','.extensions-market-card .ext-name','.extensions-market-card .extensions-card-meta','.extensions-market-card .extensions-card-desc','.extensions-market-card-action'];
          layout.marketContrasts = await js(`${JSON.stringify(marketLabels)}.map(selector => (${contrastSample.toString()})(selector))`);
          verify(layout.marketContrasts.every(sample=>sample.ratio >= 4.5), prefix + ' composited market text and filter labels meet 4.5:1');
          verify(layout.radius === '16px' && layout.descriptionClamp === '4' && layout.footerBackground !== 'rgba(0, 0, 0, 0)', prefix + ' soft tiles, four-line descriptions and toned footers');
          verify(layout.title === '16px' && layout.titleGlyph === 24 && layout.primaryRefresh, prefix + ' compact market header, icon and refresh action');
          verify(layout.facetRows >= 2 && parseFloat(layout.facetRadius) >= 100 && (width === 1320
            ? layout.sortBounds.left >= layout.facetBounds.right && Math.abs(layout.sortBounds.top - layout.facetBounds.top) < 1
            : layout.sortBounds.top >= layout.facetBounds.bottom), prefix + ' rounded facets wrap separately from sort');
          metrics.push({ theme, ...layout, contrasts, noticeHeight: notices.height, firstInstalledTop: notices.firstRowTop, expandedNoticeHeight: detail.height });
          await shot(prefix + '-market', width, height);
          if (prefix === '1320-dark') {
            await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {width:1204,height:804,deviceScaleFactor:1.5,mobile:false});
            await wait(`innerWidth===1204 && devicePixelRatio===1.5`);
            verify(await js(`getComputedStyle(document.querySelector('.extensions-market-grid')).gridTemplateColumns.split(' ').length === 3`), 'reference scale 1204×804 CSS at DPR 1.5: three columns');
            // capturePage() returns DIP here; CDP captures the renderer's physical pixels at the emulated DPR.
            const physical = await window.webContents.debugger.sendCommand('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
            const png = Buffer.from(physical.data, 'base64');
            assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1806, 1206]);
            await emit('reference-scale-dark-market.png', png);
            shots.push('reference-scale-dark-market');
            await window.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
            window.setContentSize(1010, 700);
            await wait('innerWidth===1010');
            verify(await js(`getComputedStyle(document.querySelector('.extensions-market-grid')).gridTemplateColumns.split(' ').length === 2`), '1010px: intermediate viewport has two columns');
            window.setContentSize(width,height);
            await wait(`innerWidth===${width} && innerHeight===${height}`);
          }

          if (prefix === '1320-dark' || prefix === '700-light') {
            const footerTrigger = '[data-market-id="npm:pi-project-notes"] .extensions-market-card-action';
            await js(`document.querySelector('${footerTrigger}').focus()`);
            await key('Enter', 'Enter', 13);
            await wait(`!!document.querySelector('#modalCard [data-action="install"]:not(:disabled)')`);
            await key('Escape', 'Escape', 27);
            await wait(`document.querySelector('#modal').hidden`);
            verify(await js(`document.activeElement.matches('${footerTrigger}')`), prefix + ' footer opens details and Escape returns to that action');
            await click('[data-filter="devtools"]');
            await wait(`document.querySelectorAll('.extensions-market-card').length===3`);
            await click('[data-filter="name"]');
            await wait(`document.querySelector('.extensions-market-card .ext-name')?.textContent==='pi-change-timeline'`);
            await shot(prefix + '-filtered', width, height);
            await click('[data-filter="all"]');
            await wait(`document.querySelectorAll('.extensions-market-card').length===13`);
            const trigger = '[data-market-id="npm:pi-project-notes"] .extensions-card-hit';
            await js(`document.querySelector('${trigger}').focus()`);
            await click(trigger);
            await wait(`document.querySelector('#modalCard [data-action="install"]:not(:disabled)') !== null`);
            await shot(prefix + '-detail', width, height);
            await click('#modalCard [data-action="install"]');
            await wait(`!document.querySelector('#confirmLayer').hidden`);
            verify(await js(`document.querySelector('#confirmCard').textContent.includes('npm:pi-project-notes')`), prefix + ' confirmation identifies exact package');
            await shot(prefix + '-confirm', width, height);
            await js(`[...document.querySelectorAll('#confirmCard .btn')].find((node) => node.textContent==='安装').click()`);
            await wait(`document.querySelector('#modalCard [data-action="install"]')?.getAttribute('aria-busy')==='true'`);
            await shot(prefix + '-installing', width, height);
            await wait(`document.querySelector('#modalCard .extensions-outcome-title')?.textContent==='安装超时'`);
            await shot(prefix + '-install-failed', width, height);
            await key('Escape', 'Escape', 27);
            await wait(`document.querySelector('#modal').hidden`);
            verify(await js(`document.activeElement.matches('${trigger}')`), prefix + ' focus restored after result and Escape');
            await js(`(() => {
              const input = document.querySelector('[aria-label="搜索插件市场"]');
              input.value='missing-result'; input.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            await wait(`document.querySelector('.extensions-market-grid').textContent.includes('没有符合条件')`);
            await shot(prefix + '-empty', width, height);
            await click('.extensions-market-grid .extensions-empty-actions button');
            await wait(`document.querySelectorAll('.extensions-market-card').length===13`);
            verify(await js(`document.activeElement.matches('[aria-label="搜索插件市场"]') && !document.activeElement.value`), prefix + ' clear filters restores catalog and search focus');
          }
          await click('#navHome');
        }
      }
      // Scope changes are isolated fixture events. Assert the settled browser focus, not just a call to focus().
      await click('#navExtensions');
      await seedWarnings();
      await wait(`!document.querySelector('.extension-notices').hidden`);
      const newNotice = () => js(`import('/extension-notices.js').then(m => m.handleExtensionNotification({message:'Offline focus fixture', notifyType:'info'}))`);
      await js(`document.querySelector('.extensions-notice-summary').focus()`);
      const fromSummary = await freshRun();
      verify(fromSummary.hidden && fromSummary.focus === 'extensionsTabInstalled', 'restart restores focused notice summary to Installed; actual focus: ' + fromSummary.focus);
      await click('#extensionsTabMarket');
      await newNotice();
      await js(`document.querySelector('.extensions-notice-summary').focus()`);
      await key('Enter', 'Enter', 13);
      await key('Tab', 'Tab', 9);
      await wait(`document.activeElement.matches('.extensions-notice-body')`);
      const fromBody = await freshRun();
      verify(fromBody.hidden && fromBody.focus === 'extensionsTabMarket', 'restart restores focused notice text to Market');
      await newNotice();
      await js(`document.querySelector('[aria-label="搜索插件市场"]').focus()`);
      const fromSearch = await freshRun();
      verify(fromSearch.hidden && fromSearch.search === '搜索插件市场', 'clearing notices leaves the focused search untouched');
      verify(errors.length === 0, 'renderer has no console errors ' + JSON.stringify(errors));
      await emit('measurements.json', Buffer.from(JSON.stringify({ checks, metrics, shots }, null, 2) + '\n'));
      console.log(`${checks}/${checks} passed, ${shots.length} captures in ${out}`);
    } finally {
      window?.destroy();
      harness.kill();
    }
  }
  run().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
}
