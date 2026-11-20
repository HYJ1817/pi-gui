/* Actual Electron CSS, native input and capturePage; no composed images. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runSystemVisual({ win, read, until, click, key, check, out, report }) {
  const system = '.system-settings-card';
  async function shot(name, theme, requested) {
    await sleep(120);
    const metrics = await read(`(()=>{
      const q=(s)=>document.querySelector(s), box=e=>e.getBoundingClientRect().toJSON();
      const host=q('.settings-detail'), card=q('${system}'), title=q('.system-heading h2');
      const colors=(s,bg)=>{const e=q(s),style=getComputedStyle(e);return {foreground:style.color,background:getComputedStyle(e.closest(bg)||q(bg)).backgroundColor}};
      const bad=[...card.querySelectorAll('.ds-settings-row')].filter(row=>{
        const r=box(row);return r.width>0&&[...row.querySelectorAll('button,.system-path')].some(e=>{const b=box(e);return b.left<r.left-1||b.right>r.right+1});
      }).length;
      return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,zoom:getComputedStyle(document.documentElement).getPropertyValue('--font-scale'),
        detail:box(host),card:box(card),textWidth:host.scrollWidth,visibleWidth:host.clientWidth,bad,bodyOverflow:document.documentElement.scrollWidth>innerWidth,
        title:{font:getComputedStyle(title).fontSize,weight:getComputedStyle(title).fontWeight},theme:document.documentElement.dataset.theme,
        colors:{title:colors('.system-heading h2','#workspace'), intro:colors('.system-heading p','#workspace'), path:colors('.system-path','.ds-settings-row'), detail:colors('.ds-settings-row-desc','.ds-settings-row')},
        shared:{buttonHeight:box(q('.system-actions button')).height,switchHeight:box(q('button[aria-label="保持电脑唤醒"]')).height,segmentHeight:box(q('.ds-segment-item')).height},
        pathHeight:box(q('.system-path')).height,pathLineHeight:parseFloat(getComputedStyle(q('.system-path')).lineHeight)};
    })()`);
    const image = await win.webContents.capturePage();
    const file = name + '.png';
    assert.ok(!image.isEmpty(), file);
    fs.writeFileSync(path.join(out, file), image.toPNG());
    report.screenshots.push({ file, theme, requested, pixels: image.getSize(), metrics });
    return metrics;
  }
  async function scroll(top) { await read(`document.querySelector('.settings-detail').scrollTop=${top}`); }
  for (const [theme, width, height] of [['dark',1320,820],['dark',700,600],['light',1320,820],['light',700,600]]) {
    const label = `${theme}-${width}`;
    await read(`import('/theme.js').then(m=>m.setThemePreference('${theme}'))`);
    await until(() => read(`document.documentElement.dataset.theme==='${theme}'`), 'theme ' + theme);
    win.setContentSize(width, height);
    await until(() => read(`Math.abs(innerWidth-${width})<=2 && Math.abs(innerHeight-${height})<=6`), 'content size ' + label);
    await scroll(0);
    const m = await shot('system-' + label + '-top', theme, [width,height]);
    check(label + ' real geometry and public primitive sizes', !m.bodyOverflow && m.bad === 0 && m.textWidth <= m.visibleWidth + 1 && m.title.font === '20px' && m.title.weight === '600' && m.shared.buttonHeight >= 31 && m.shared.switchHeight >= 21 && m.shared.segmentHeight >= 25);
    if (width === 700) check(label + ' mixed Chinese/English path wraps', m.pathHeight >= 2 * m.pathLineHeight);
    await scroll(10000);
    await shot('system-' + label + '-bottom', theme, [width,height]);
  }
  // Start from the overview, not an already selected System page. aria-current
  // must result from this keyboard activation, not the earlier pointer setup.
  await key('Escape');
  await until(() => read("!!document.querySelector('.settings-surface-head') && !document.querySelector('.system-settings-card')"), 'settings overview');
  await click('#settingsSearchInput');
  win.webContents.insertText('tray');
  await until(() => read("document.querySelector('#navInfo').hidden && !document.querySelector('#navSystem').hidden"), 'real settings search');
  await key('Down'); await until(() => read("document.activeElement.id==='navSystem'"), 'search keyboard focus');
  await key('Enter');
  await until(() => read("document.querySelector('#navSystem').getAttribute('aria-current')==='page' && document.activeElement.matches('.system-settings-card')"), 'keyboard system navigation and detail focus');
  await read("const input=document.querySelector('#settingsSearchInput');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));");
  await key('Tab');
  const ring = await read(`(()=>{const e=document.activeElement,c=getComputedStyle(e),r=e.getBoundingClientRect(),host=document.querySelector('.settings-detail').getBoundingClientRect(),pad=parseFloat(c.outlineWidth)+parseFloat(c.outlineOffset);return {label:e.getAttribute('aria-label'),within:!!e.closest('${system}'),visible:e.matches(':focus-visible'),width:c.outlineWidth,color:c.outlineColor,offset:c.outlineOffset,unclipped:r.left-pad>=host.left&&r.right+pad<=host.right&&r.top-pad>=host.top&&r.bottom+pad<=host.bottom}})()`);
  report.keyboardFocus = ring;
  check('real search, arrow/Enter and visible Tab focus', ring.within && ring.label === '数据保存路径提示' && ring.visible && ring.unclipped && parseFloat(ring.width) >= 2);
  await key('Tab');
  check('real Tab advances to cache help', await read("document.activeElement.getAttribute('aria-label')==='可清理缓存提示'"));
  await key('Tab', ['shift']);
  check('real Shift+Tab returns to the same visible path help', await read("document.activeElement.getAttribute('aria-label')==='数据保存路径提示' && document.activeElement.matches(':focus-visible')"));
  await click('button[aria-label="保持电脑唤醒"]');
  report.pointerFocus = await read("document.activeElement.matches(':focus-visible')");
  check('pointer activation does not show a keyboard-only focus ring', !report.pointerFocus);
  await until(() => read("document.querySelector('button[aria-label=\"保持电脑唤醒\"]').getAttribute('aria-checked')==='true'"), 'native switch through real pointer');
  await read(`document.documentElement.style.setProperty('--font-scale','1.2')`);
  const scaled = await shot('system-light-700-scaled', 'light', [700,600]);
  check('narrow 120% font fixture retains control bounds', !scaled.bodyOverflow && scaled.bad === 0 && scaled.textWidth <= scaled.visibleWidth + 1);
  await read(`document.documentElement.style.removeProperty('--font-scale')`);
}
module.exports = { runSystemVisual };
