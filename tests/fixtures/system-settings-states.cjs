/* Offline presentation/fault fixture in a separate sandboxed window. It loads
 * production HTML/CSS/modules; its explicitly synthetic bridge never writes
 * preferences or invokes native IPC. Native behavior is tested by desktop.cjs. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function contrastSample(selector, property = 'color', outside = false) {
  const element = document.querySelector(selector), style = getComputedStyle(element);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = css => {
    context.clearRect(0, 0, 1, 1); context.fillStyle = css; context.fillRect(0, 0, 1, 1);
    const values = [...context.getImageData(0, 0, 1, 1).data]; values[3] /= 255; return values;
  };
  const over = (top, bottom) => top.slice(0, 3).map((value, index) => value * top[3] + bottom[index] * (1 - top[3])).concat(1);
  const chain = []; for (let node = outside ? element.parentElement : element; node; node = node.parentElement) chain.unshift(node);
  let background = [255, 255, 255, 1];
  for (const node of chain) background = over(rgba(getComputedStyle(node).backgroundColor), background);
  const foreground = over(rgba(style[property]), background);
  const luminance = color => color.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const a = luminance(foreground), b = luminance(background);
  return { selector, property, css: style[property], foreground, background, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
}

async function runSystemStates({ BrowserWindow, origin, out, report, check }) {
  const window = new BrowserWindow({ show: true, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const read = expression => window.webContents.executeJavaScript(expression, true);
  async function until(expression) {
    for (let n = 0; n < 200; n++) { if (await read(expression)) return; await sleep(40); }
    throw Error('presentation fixture did not settle: ' + expression);
  }
  async function point(selector, down = false) {
    window.show(); window.focus(); window.webContents.focus();
    const point = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await sleep(180);
    if (down) window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    return point;
  }
  async function click(selector) {
    const position = await point(selector, true);
    window.webContents.sendInputEvent({ type: 'mouseUp', ...position, button: 'left', clickCount: 1 }); await sleep(80);
  }
  async function key(keyCode, modifiers = []) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(70);
  }
  async function shot(name) {
    const image = await window.webContents.capturePage(); assert.ok(!image.isEmpty());
    const file = name + '.png'; fs.writeFileSync(path.join(out, file), image.toPNG());
    report.screenshots.push({ file, fixture: 'synthetic-bridge-production-css', pixels: image.getSize() });
  }
  const sample = (selector, property, outside) => read(`(${contrastSample.toString()})(${JSON.stringify(selector)},${JSON.stringify(property || 'color')},${Boolean(outside)})`);
  const awake = 'button[aria-label="保持电脑唤醒"]', refresh = '#system-cache-actions button:first-child';
  report.presentation = { contrasts: [], states: [], sharedComparison: [], nonTextObservations: [] };
  try {
    await window.loadURL(origin);
    await until("!!document.querySelector('#navSystem') && typeof window.openSystemSettings==='undefined'");
    await read(`window.systemFixture={bytes:4096,failMeasure:false,failSave:false,pending:false,clears:0,
      snapshot:{persistence:'saved',effective:{keepAwake:false,preventDisplaySleep:false,closeBehavior:'quit'},capabilities:{power:true,tray:true,cache:true},browserDirectory:'C:\\Offline fixture\\Electron profile',error:''}};
      window.piGuiDesktop={systemSettings:{
        state:async()=>({ok:true,snapshot:systemFixture.snapshot}),
        set:async(key,value)=>{if(systemFixture.pending)await new Promise(resolve=>systemFixture.release=resolve);
          if(systemFixture.failSave){systemFixture.snapshot.error='系统设置未保存，请重试。';return{ok:false,snapshot:systemFixture.snapshot};}
          systemFixture.snapshot.error='';systemFixture.snapshot.effective[key]=value;return{ok:true,snapshot:systemFixture.snapshot};},
        measureCache:async()=>systemFixture.failMeasure?{ok:false,bytes:null,error:'缓存统计失败，请重试。'}:{ok:true,bytes:systemFixture.bytes,ticket:'offline-presentation-ticket'},
        clearCache:async()=>{systemFixture.clears++;systemFixture.bytes=0;return{ok:true,status:'cleared',bytes:0};},quit:async()=>({ok:true})}};
      document.querySelector('#navGlobalMore').click();document.querySelector('#navSystem').click();`);
    await until("!!document.querySelector('.system-settings-card') && !document.querySelector('button[aria-label=\"保持电脑唤醒\"]').disabled");
    window.setContentSize(700, 600);
    for (const theme of ['dark', 'light']) {
      await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)};systemFixture.failMeasure=false;systemFixture.failSave=false;systemFixture.bytes=4096;`);
      await click(refresh);
      for (const selector of ['.system-heading h2', '.system-heading p', '.ds-settings-row-label', '.system-path', '.system-path-detail span', '#system-cache-actions .danger']) {
        const value = { theme, state: 'default', ...await sample(selector) }; report.presentation.contrasts.push(value);
        check(theme + ' composited text AA ' + selector, value.ratio >= 4.5);
      }
      await point(refresh);
      check(theme + ' real pointer Hover uses shared action', await read(`document.querySelector('${refresh}').matches(':hover')`));
      report.presentation.contrasts.push({ theme, state: 'hover', ...await sample(refresh) });
      const position = await point(refresh, true); await sleep(160);
      check(theme + ' real pointer Pressed has active feedback', await read(`document.querySelector('${refresh}').matches(':active') && getComputedStyle(document.querySelector('${refresh}')).transform!=='none'`));
      report.presentation.contrasts.push({ theme, state: 'pressed', ...await sample(refresh) });
      window.webContents.sendInputEvent({ type: 'mouseUp', ...position, button: 'left', clickCount: 1 });
      await click(awake); await key('Tab', ['shift']);
      const focusSelector = 'button[aria-label="Pi Agent 配置目录提示"]';
      await until(`document.activeElement.matches(${JSON.stringify(focusSelector)})`);
      const ring = { theme, state: 'keyboard-focus', ...await sample(focusSelector, 'outlineColor', true) };
      report.presentation.contrasts.push(ring);
      check(theme + ' real keyboard focus has composited non-text AA', ring.ratio >= 3 && await read("document.activeElement.matches(':focus-visible')"));
      const off = await sample('button[aria-label="阻止屏幕休眠"]', 'borderTopColor', true);
      report.presentation.nonTextObservations.push({ theme, state: 'shared-switch-off-border', ...off, meetsAA: off.ratio >= 3 });
      await read('systemFixture.pending=true'); await click(awake);
      await until("!!systemFixture.release && document.querySelector('#system-preference-feedback').textContent.includes('正在保存')");
      check(theme + ' Loading preserves authoritative value and disables repeat', await read(`document.querySelector(${JSON.stringify(awake)}).disabled && document.querySelector(${JSON.stringify(awake)}).getAttribute('aria-checked')==='true'`));
      await shot('system-' + theme + '-loading');
      await read('systemFixture.pending=false;systemFixture.release()');
      await until("document.querySelector('#system-preference-feedback').textContent==='已保存。'");
      check(theme + ' Success follows confirmed state', await read(`document.querySelector(${JSON.stringify(awake)}).getAttribute('aria-checked')==='false'`));
      await read('systemFixture.failSave=true'); await click(awake);
      await until("document.querySelector('#system-preference-feedback').classList.contains('is-error')");
      const error = { theme, state: 'error', ...await sample('#system-preference-feedback') }; report.presentation.contrasts.push(error);
      check(theme + ' persistent Error has text AA and retry', error.ratio >= 4.5 && await read(`!document.querySelector(${JSON.stringify(awake)}).disabled && document.querySelector(${JSON.stringify(awake)}).getAttribute('aria-checked')==='false'`));
      await shot('system-' + theme + '-error'); await read('systemFixture.failSave=false');
      await read('systemFixture.failMeasure=true'); await click(refresh);
      check(theme + ' failed statistics is unknown, not empty', await read("document.querySelector('#system-cache-size').textContent==='大小未知' && document.querySelector('#system-cache-actions .danger').disabled"));
      await read('systemFixture.failMeasure=false;systemFixture.bytes=0'); await click(refresh);
      check(theme + ' Empty and Disabled retain retry', await read("document.querySelector('#system-cache-size').textContent==='0 B' && document.querySelector('#system-cache-actions .danger').disabled && !document.querySelector('#system-cache-actions button').disabled"));
      report.presentation.states.push({ theme, covered: ['default','hover','pressed','pointer-focus','focus-visible','disabled','loading','error','empty','success','selected'] });
    }
    // Explicit offline English labels, not a claim of product localization.
    for (const theme of ['dark', 'light']) {
      await read(`{document.documentElement.dataset.theme=${JSON.stringify(theme)};
        document.querySelector('.system-heading h2').textContent='System';
        document.querySelector('.system-heading p').textContent='Network, storage, power, and local window behavior.';
        const labels=new Map([['代理','Proxy configuration'],['代理地址','Custom proxy address'],['绕过列表','Proxy bypass addresses'],['网络宽松模式','Relaxed network mode'],['数据保存路径','Application data storage location'],['可清理缓存','Clearable browser cache'],['Electron 浏览器数据目录','Electron browser profile directory'],['Pi Agent 配置目录','Pi Agent configuration directory'],['用户项目目录','User project directories'],['保持电脑唤醒','Keep this computer awake'],['阻止屏幕休眠','Prevent automatic display sleep'],['关闭主窗口时','When closing the main window']]);
        document.querySelectorAll('.ds-settings-row-label > span:first-child').forEach(e=>{e.textContent=labels.get(e.textContent)||e.textContent});
        document.querySelector('#system-cache-actions button').textContent='Recalculate cache size';
        document.querySelector('#system-cache-actions .danger').textContent='Clear cache…';
        document.querySelector('[data-value="tray"] .ds-segment-label').textContent='Close to tray';
        document.querySelector('[data-value="quit"] .ds-segment-label').textContent='Quit application';
        document.querySelector('.settings-detail').scrollTop=0;}`);
      const bounds = await read(`(()=>{const host=document.querySelector('.settings-detail');return{overflow:host.scrollWidth>host.clientWidth+1,bad:[...document.querySelectorAll('.ds-settings-row')].filter(row=>{const r=row.getBoundingClientRect();return [...row.querySelectorAll('button,.system-path')].some(e=>{const b=e.getBoundingClientRect();return b.left<r.left-1||b.right>r.right+1})}).length}})()`);
      check(theme + ' narrow English long-label fixture keeps action bounds', !bounds.overflow && !bounds.bad);
      await shot('system-' + theme + '-english-top');
      await read("document.querySelector('.settings-detail').scrollTop=10000"); await shot('system-' + theme + '-english-bottom');
    }
    const geometry = selector => read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),s=getComputedStyle(e),r=e.getBoundingClientRect();return{height:r.height,font:s.fontSize,weight:s.fontWeight,radius:s.borderRadius}})()`);
    const systemSwitch = await geometry(awake), systemSegment = await geometry('[data-value="quit"]');
    await read("document.querySelector('#navAppearance').click()");
    await until("!!document.querySelector('.appearance-size-control .ds-segment-item') && !!document.querySelector('.ds-switch')");
    const otherSwitch = await geometry('.ds-switch'), otherSegment = await geometry('.appearance-size-control .ds-segment-item.is-active');
    report.presentation.sharedComparison.push({ systemSwitch, otherSwitch, systemSegment, otherSegment });
    check('System and General reuse equal switch/segment geometry and typography', JSON.stringify(systemSwitch) === JSON.stringify(otherSwitch) && JSON.stringify(systemSegment) === JSON.stringify(otherSegment));
  } finally { window.destroy(); }
}
module.exports = { runSystemStates, contrastSample };
