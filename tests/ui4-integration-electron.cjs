/* Extends the owned UI4 pane Electron fixture, using the unmodified production
 * entry and native Browser controller. No Pi/model or user project is used. */
const path = require('node:path');
const { spawn } = require('node:child_process');
if (require.main === module) {
  const env = { ...process.env, UI4_INTEGRATION: '1' };
  env.UI4_EVIDENCE_ROOT ||= path.resolve(__dirname, '../docs/claude-ui-redesign/ui4-integration-evidence/electron');
  const child = spawn(process.execPath, [path.join(__dirname, 'ui4-pane.cjs')], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}

exports.run = async function run({ win, read, check, shot, key, click, closePane, nativeView, sleep, until, facts }) {
  // Instrument observations without dropping callbacks, preventing errors, or
  // muting console output. Installed before the production entry executes.
  const instrumentation = '(' + function () {
    const diag = window.__ui4Diagnostics = { callbacks: {}, resizeErrors: 0, unexpected: [], measurements: [] };
    window.addEventListener('error', event => {
      if (/^ResizeObserver loop (?:completed with undelivered notifications\.|limit exceeded)$/.test(event.message || '')) diag.resizeErrors++;
      else diag.unexpected.push({ type: 'error', name: event.error?.name || 'Error' });
    });
    window.addEventListener('unhandledrejection', event => diag.unexpected.push({ type: 'rejection', name: event.reason?.name || 'Error' }));
    const Original = window.ResizeObserver;
    window.ResizeObserver = class extends Original {
      constructor(callback) {
        const trace = new Error().stack || '';
        const source = trace.includes('composer.js') ? 'composer' : trace.includes('right-pane.js') ? 'pane' : 'other';
        super((entries, observer) => {
          diag.callbacks[source] = (diag.callbacks[source] || 0) + 1;
          if (diag.measurements.length < 500) diag.measurements.push({ source, width: entries[0]?.contentRect.width, height: entries[0]?.contentRect.height });
          callback(entries, observer);
        });
      }
    };
  }.toString() + ')();';
  await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });
  win.reload();
  try { await until(() => read('Boolean(window.__ui4Diagnostics && document.getElementById("btnThinkInfo"))')); }
  catch (error) { console.error('UI4 reload diagnostics', await read('({diagnostics:!!window.__ui4Diagnostics,thinkingInfo:!!document.getElementById("btnThinkInfo"),readyState:document.readyState,errors:window.__ui4Diagnostics?.unexpected})')); throw error; }
  await sleep(1000);
  win.focus(); win.webContents.focus();
  await read(`(async()=>{
    window.__joint={commands:[],mode:'ok',release:null};
    const original=window.fetch;
    window.fetch=async(url,options={})=>{
      if(String(url)==='/api/command' && options.body){const body=JSON.parse(options.body);
        if(body.type==='extension_ui_response'){
          __joint.commands.push(body);
          if(__joint.mode==='held')await new Promise(resolve=>__joint.release=resolve);
          return {json:async()=>{if(__joint.mode==='unknown')throw new Error('fixture lost response');return __joint.mode==='reject'?{ok:false,error:'fixture_rejected'}:{ok:true};}};
        }
      }
      return original(url,options);
    };
    __joint.approval=await import('/approval.js');__joint.notice=await import('/ui/notice.js');
    __joint.toast=await import('/ui/toast.js');__joint.modal=await import('/ui/modal.js');
    __joint.state=await import('/state.js');
  })()`);
  check(await read(`['ui4-pane-style','ui4-approval-style','ui4-feedback-style'].every(id=>document.querySelectorAll('#'+id).length===1)`), 'UI4 production entry statically loads each owned stylesheet once');
  check(await read(`['pane','approval','feedback'].every(name=>[...document.styleSheets].some(s=>s.href?.endsWith('/ui4-'+name+'.css')&&s.cssRules.length>0))`), 'all three production CSS files parsed without test style injection');
  check(await read(`(()=>{const ids=[...document.querySelectorAll('[id]')].map(n=>n.id);return new Set(ids).size===ids.length})()`), 'production entry has no duplicate IDs');

  const startApproval = async (id, mode = 'ok') => read(`(()=>{
    const {S}=__joint.state; S.switching=false;S.bridgeState='ready';S.hasProject=true;
    __joint.mode=${JSON.stringify(mode)};
    __joint.approval.observeApprovalEvent({type:'extension_ui_request',id:${JSON.stringify(id)},method:'confirm',title:'真实投递状态（离线夹具）',message:'node fixture-command --path '+('中文/long/'.repeat(30))},S);
  })()`);
  const clickText = text => read(`[...document.querySelectorAll('#confirmCard button')].find(b=>b.textContent===${JSON.stringify(text)})?.click()`);
  const clearFeedback = () => read(`__joint.notice.hideNotice();document.getElementById('toasts').replaceChildren()`);
  const geometry = () => read(`(()=>{
    const host=document.getElementById('toasts'),t=host.getBoundingClientRect(),c=document.getElementById('chatComposer').getBoundingClientRect(),pane=document.getElementById('rightPane'),r=pane.getBoundingClientRect();
    return {top:t.top,bottom:t.bottom,left:t.left,right:t.right,composerTop:c.top,paneLeft:pane.hidden?innerWidth:r.left,w:innerWidth,h:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth+1};
  })()`);
  let serial = 0;
  for (const theme of ['dark', 'light']) for (const width of [700, 900, 1200, 1536]) for (const sidebar of [true, false]) {
    win.setContentSize(width, 900);
    await read(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};if(document.getElementById('projectSidebar').hidden===${sidebar})document.getElementById(${JSON.stringify(sidebar ? 'btnSidebarExpand' : 'btnSidebarCollapse')}).click();})()`);
    await closePane();
    await read(`document.getElementById('btnBrowser').click()`);
    await until(() => nativeView().attached);
    check(await read(`document.getElementById('projectSidebar').hidden===${!sidebar}`), 'real sidebar collapse control matches matrix state: ' + theme + '-' + width + '-' + sidebar);
    await read(`(()=>{const i=document.getElementById('input');i.value=('十行 English 中文 '+('long'.repeat(20))+'\\n').repeat(10);i.dispatchEvent(new Event('input'));})()`);
    check(await read(`document.getElementById('input').value.trimEnd().split(String.fromCharCode(10)).length===10`), 'matrix uses ten actual newline-separated Composer lines');
    await clearFeedback();
    await read(`(()=>{
      for(const kind of ['info','success','warning','error'])__joint.toast.toast('联合通知 '+kind+' '+${JSON.stringify(theme + '-' + width + '-' + sidebar)}+' '+('long 中文 '.repeat(10)),kind,{persistent:true});
      __joint.notice.showNotice({id:'joint',tone:'unknown',title:'状态未知（夹具）',detail:'不推断成功或失败',actions:[{label:'重新读取',run:()=>{}}]});
    })()`);
    check(await read(`document.querySelectorAll('.toast').length===4`), 'matrix contains all four actual notification kinds');
    await sleep(220);
    const g = await geometry(), name = `${theme}-${width}-sidebar-${sidebar}`;
    facts.push({ jointGeometry: name, ...g });
    check(!g.overflow && g.left >= -1 && g.top >= -1 && g.right <= g.paneLeft + 1 && g.bottom <= g.composerTop + 1, 'Toast stack stays above Composer and left of native Browser: ' + name, g);
    check(nativeView().attached, 'Toast/Notice leaves real Browser attached: ' + name);
    await shot('joint-feedback-' + name);
    await clearFeedback();
    await startApproval('matrix-' + serial++);
    await until(() => !nativeView().attached);
    check(await read(`document.getElementById('confirmLayer').hidden===false && document.activeElement?.textContent==='拒绝'`), 'Classic approval is visible with safe initial focus: ' + name);
    const modal = await read(`(()=>{const r=document.getElementById('confirmCard').getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight}})()`);
    check(modal.x >= -1 && modal.y >= -1 && modal.right <= modal.w + 1 && modal.bottom <= modal.h + 1, 'approval fits actual Chromium viewport: ' + name, modal);
    await shot('joint-approval-' + name);
    await key('Escape', 'Escape', 27);
    await until(() => read('document.getElementById("confirmLayer").hidden'));
    await until(() => nativeView().attached);
    check(nativeView().attached, 'cancelled approval restores real native View: ' + name);
  }

  win.setContentSize(1200, 900);
  await clearFeedback();
  await startApproval('delivery-failed', 'reject'); await clickText('允许一次');
  await until(() => read(`!!document.querySelector('#confirmCard .ui4-confirm-status[data-state="error"]')`));
  check(await read(`!document.querySelector('#confirmLayer').hidden && [...document.querySelectorAll('#confirmCard .modal-actions button')].every(b=>!b.disabled)`), 'explicit backend refusal stays visible and permits explicit retry');
  await shot('joint-explicit-delivery-failure');
  await read(`__joint.mode='ok'`); await clickText('拒绝');
  await until(() => read('document.getElementById("confirmLayer").hidden'));

  await startApproval('delivery-unknown', 'unknown'); await clickText('允许一次');
  await until(() => read(`/未知|无法确认/.test(document.getElementById('confirmCard').textContent)`));
  check(await read(`(()=>{const buttons=[...document.querySelectorAll('#confirmCard button')];return buttons.filter(b=>['允许一次','拒绝'].includes(b.textContent)).every(b=>b.disabled)})()`), 'unknown delivery locks both decisions without claiming failure or execution');
  await shot('joint-unknown-delivery');
  await key('Escape', 'Escape', 27);
  await until(() => read('document.getElementById("confirmLayer").hidden'));

  await startApproval('old-held', 'held'); await clickText('允许一次');
  await read(`__joint.approval.cancelPendingApprovals()`);
  await startApproval('replacement', 'ok');
  const before = await read('__joint.commands.length');
  await read('__joint.release()'); await sleep(100);
  check(await read(`__joint.commands.length===${before} && __joint.modal.confirmSurfaceMeta()?.requestId==='replacement'`), 'real Chromium late decision never authorizes a replacement approval');
  await shot('joint-late-result-replacement');
  await key('Escape', 'Escape', 27);
  await until(() => nativeView().attached);

  // Exercise the existing popover/command/modal ordering above a native View.
  await read(`(()=>{const i=document.getElementById('input');i.focus();i.value='/';i.dispatchEvent(new Event('input'));})()`);
  await sleep(160);
  check(await read(`!!document.querySelector('.ui3-inline-menu:not([hidden])')`), 'Slash menu still opens with UI4 surfaces');
  await read(`document.getElementById('input').focus()`); await key('Escape', 'Escape', 27);
  await read(`document.getElementById('btnModel').click()`); await sleep(150);
  check(await read(`!document.getElementById('composerPopover').hidden`), 'UI3 model popover still opens with native Browser');
  await key('Escape', 'Escape', 27);

  await clearFeedback();
  await read(`__joint.toast.toast('拖动右栏期间的持久通知','error')`);
  const drag = await read(`(()=>{const r=document.getElementById('rightPaneResizer').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for (const [type, x] of [['mousePressed',drag.x],['mouseMoved',drag.x-65],['mouseReleased',drag.x-65]]) {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y: drag.y, button: 'left', clickCount: 1 });
  }
  await sleep(300);
  const dragged = await geometry(); facts.push({ toastDuringActualDrag: dragged, nativeView: nativeView() });
  check(dragged.top >= -1 && dragged.right <= dragged.paneLeft + 1 && dragged.bottom <= dragged.composerTop + 1, 'actual pane drag repositions Toast without covering Composer or Browser', dragged);
  await shot('joint-pane-drag-feedback');
  await read(`document.getElementById('input').focus()`);
  await key('k', 'KeyK', 75, 2);
  check(await read(`!document.getElementById('paletteLayer').hidden`), 'Ctrl+K still opens the independent command palette');
  await key('Escape', 'Escape', 27);

  for (const zoom of [0.8, 1.25, 1.5]) {
    win.webContents.setZoomFactor(zoom); await sleep(160);
    await clearFeedback();
    await read(`__joint.toast.toast('缩放下真实通知 '+${JSON.stringify(zoom)}+' '+('长文本 '.repeat(20)),'warning',{persistent:true})`);
    check(await read(`document.querySelectorAll('.toast').length===1`), 'zoom fixture has one actual visible Toast');
    const g = await geometry(); facts.push({ zoom, ...g });
    check(!g.overflow && g.top >= -1 && g.right <= g.paneLeft + 1 && g.bottom <= g.composerTop + 1, 'actual app zoom preserves Toast/Composer/Browser separation: ' + zoom, g);
    await shot('joint-zoom-' + zoom);
  }
  win.webContents.setZoomFactor(1);
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  check(await read(`getComputedStyle(document.querySelector('.toast')).animationName==='none'`), 'reduced motion applies to combined production Toast');
  await shot('joint-reduced-motion');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });

  // A finite deferred ResizeObserver delivery is reported, never silenced. An
  // ongoing callback/geometry/error loop after inputs stop fails this test.
  for (let i = 0; i < 18; i++) {
    win.setContentSize(900 + i * 17, 720 + i % 3 * 24);
    await read(`(()=>{const i=document.getElementById('input');i.value=('重排 English\\n').repeat(${i % 10 + 1});i.dispatchEvent(new Event('input'));__joint.notice.${i % 2 ? "hideNotice()" : "showNotice({id:'resize',tone:'busy',title:'读取中'})"};})()`);
    await sleep(25);
  }
  await clearFeedback(); await sleep(600);
  const stableA = await read(`({diag:__ui4Diagnostics,composer:document.getElementById('chatComposer').getBoundingClientRect().toJSON(),reserved:document.querySelector('.stage').style.getPropertyValue('--composer-reserved-height')})`);
  await sleep(600);
  const stableB = await read(`({diag:__ui4Diagnostics,composer:document.getElementById('chatComposer').getBoundingClientRect().toJSON(),reserved:document.querySelector('.stage').style.getPropertyValue('--composer-reserved-height')})`);
  facts.push({ resizeObserverInvestigation: { stableA, stableB } });
  check(stableB.diag.unexpected.length === 0, 'no unhandled non-ResizeObserver renderer exceptions', stableB.diag.unexpected);
  check(JSON.stringify(stableA.composer) === JSON.stringify(stableB.composer) && stableA.reserved === stableB.reserved
    && stableA.diag.resizeErrors === stableB.diag.resizeErrors && JSON.stringify(stableA.diag.callbacks) === JSON.stringify(stableB.diag.callbacks),
  'after resize/Composer/Notice changes cease, geometry and observer callbacks/errors stop changing');
  await closePane();
};
