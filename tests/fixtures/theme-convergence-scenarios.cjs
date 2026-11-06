/* Presentation audit of production modules in the normal-sandbox app runner.
 * No real Pi, model, project writes, or invented file-completion capability. */
module.exports = async function ({ read, click, key, shot, nativeShot, paint, check, win, theme, browser, browserFixtureUrl, waitFor }) {
  const answer = '### 代码与项目\n- 阅读和修改已有代码\n- 保留会话、项目和工具状态\n\n`inline code` 与 **Markdown** 保持原有行为。';
  win.setContentSize(1205, 803);
  await read(`(async()=>{
    DWS.showChat();await TH.setThemePreference('light');M.clearThread();M.setStreaming(false);
    Object.assign(ST.S,{hasProject:true,switching:false,streaming:false,stopping:false,submitting:false,modelSwitchPending:false,bridgeState:'ready',attachments:[]});
    DU.applyState({model:dModel,thinkingLevel:'low',isStreaming:false});
    ST.S.stats={contextUsage:{tokens:1200,contextWindow:128000,percent:.9375},tokens:{input:1100,output:100}};DU.renderCtxChip();
    M.rebuildFromMessages([{role:'user',content:[{type:'text',text:'继续检查浅色主题与已有功能。'}]},{role:'assistant',content:[{type:'text',text:${JSON.stringify(answer)}}]}]);
    window.fInput=document.querySelector('#input');fInput.value='阶段 F：保留这份草稿';DC.autoGrow();DC.updateSendState();M.scrollBottom(true);
  })()`); await paint();
  check('F light canvas/sidebar/Composer and send use reference semantic palette', await read(`(()=>{const css=s=>getComputedStyle(document.querySelector(s));return css('.stage-head').backgroundColor==='rgb(255, 255, 255)'&&css('#projectSidebar').backgroundColor==='rgb(243, 243, 243)'&&css('#composerBox').backgroundColor==='rgb(255, 255, 255)'&&css('#btnSend').backgroundColor==='rgb(26, 28, 31)'&&css('#btnSend').color==='rgb(255, 255, 255)'})()`));
  await shot('f01-conversation-light'); await nativeShot('f01-conversation-light');
  async function input(value) {
    await click('#input');
    await read(`fInput.value=${JSON.stringify(value)};fInput.setSelectionRange(fInput.value.length,fInput.value.length);fInput.dispatchEvent(new Event('input',{bubbles:true}));`); await paint();
  }
  const menuMetrics = () => read(`(()=>{const e=document.querySelector('.ui3-inline-menu'),r=e.getBoundingClientRect(),a=fInput.closest('.composer-box').getBoundingClientRect(),c=getComputedStyle(e);return {width:r.width,anchor:a.width,x:r.x,right:r.right,top:r.y,bottom:r.bottom,vw:innerWidth,vh:innerHeight,ink:c.color,bg:c.backgroundColor,border:c.borderTopWidth,focus:document.activeElement===fInput}})()`);
  await input('/'); await waitFor(`!!document.querySelector('.ui3-inline-menu:not([hidden])')`);
  let m=await menuMetrics();
  check('F slash menu honors outer Composer width instead of obsolete 320px cap', Math.abs(m.width-m.anchor)<=1&&m.width>500,m);
  check('F slash light surface uses reference ink and keeps textarea focus', m.ink==='rgb(26, 28, 31)'&&m.bg==='rgb(255, 255, 255)'&&m.border==='0px'&&m.focus,m);
  const selected=await read(`fInput.getAttribute('aria-activedescendant')`); await key('DOWN');
  check('F real slash keyboard navigation preserves draft and source focus', await read(`fInput.getAttribute('aria-activedescendant')!==${JSON.stringify(selected)}&&fInput.value==='/'&&document.activeElement===fInput`));
  await shot('f02-slash-light'); await key('ESC');
  check('F real Escape closes slash without submitting or replacing input', await read(`document.querySelector('.ui3-inline-menu').hidden&&document.querySelector('#input')===fInput&&fInput.value==='/'`));
  await click('#btnCtx'); await waitFor(`!document.querySelector('#composerPopover').hidden`);
  check('F context light panel uses semantic ink and actual known context', await read(`(()=>{const e=document.querySelector('#composerPopover');return getComputedStyle(e).color==='rgb(26, 28, 31)'&&e.textContent.includes('128')&&e.textContent.includes('99%')&&!/网络耗时|模型耗时/.test(e.textContent)})()`));
  await shot('f03-context-light'); win.webContents.sendInputEvent({type:'mouseMove',x:600,y:70}); await key('ESC');
  await read(`window.fQuota=ST.S.remoteQuota;ST.S.remoteQuota={status:'unavailable',message:'离线夹具：额度服务暂时无法连接'};ST.S.quotaLoading=false`);
  await click('#btnCtx'); await waitFor(`!!document.querySelector('#composerPopover .tip-warn')`);
  const quotaWarning=await read(`getComputedStyle(document.querySelector('#composerPopover .tip-warn')).color`);
  check('F real quota warning retains semantic warning ink beside neutral details',quotaWarning==='rgb(133, 77, 14)',quotaWarning);
  await shot('f14-quota-warning-light');win.webContents.sendInputEvent({type:'mouseMove',x:600,y:70});await key('ESC');
  await read(`ST.S.remoteQuota=fQuota`);
  await read(`ST.S.stats={};DU.renderCtxChip()`); await click('#btnCtx'); await waitFor(`!document.querySelector('#composerPopover').hidden`);
  check('F unknown usage remains unknown instead of a fabricated zero', await read(`document.querySelector('#ctxPct').textContent==='—'&&document.querySelector('#composerPopover').textContent.includes('暂无上下文数据')`));
  await shot('f04-context-unknown-light'); win.webContents.sendInputEvent({type:'mouseMove',x:600,y:70}); await key('ESC');
  await input('@');
  check('F absent file mention capability stays plain draft with no fake menu', await read(`fInput.value==='@'&&document.querySelector('.ui3-inline-menu').hidden&&document.activeElement===fInput`));
  await shot('f05-at-draft-light');
  await read(`(async()=>{const a=await import('/attachments.js');ST.S.attachments=[{id:'f-file',name:'浅色附件.txt',kind:'text',size:24,chars:12,text:'offline fixture'}];a.renderAttachments();DC.updateSendState()})()`);
  check('F real attachment tray retains file and remove action', await read(`!document.querySelector('#attachTray').hidden&&document.querySelector('#attachTray').textContent.includes('浅色附件.txt')&&!!document.querySelector('#attachTray button')`));
  await shot('f06-attachment-light');
  await click('#attachTray button');
  check('F attachment removal keeps the same @ draft and input node', await read(`ST.S.attachments.length===0&&fInput.value==='@'&&document.querySelector('#input')===fInput`));
  await click('#btnModel'); await waitFor(`!document.querySelector('#composerPopover').hidden`); await shot('f07-model-light'); await key('ESC');
  await click('#navGlobalMore'); await click('#navAppearance'); await waitFor(`!!document.querySelector('.appearance-status')`);
  const groupInk=await read(`getComputedStyle(document.querySelector('.settings-menu h3')).color`);
  check('F settings group labels use reference muted ink, not faint text', groupInk==='rgb(93, 93, 93)',groupInk);
  await shot('f08-appearance-light');
  // The primitive has no current business caller. Mount its actual factory only
  // for component CSS assertions, remove it before any product screenshot.
  const primitive=await read(`(async()=>{const {createSettingsToggle}=await import('/ui/primitives.js');window.fToggle=createSettingsToggle({ariaLabel:'原语组件验证'});document.body.append(fToggle.element);const e=fToggle.element,c=getComputedStyle(e),k=getComputedStyle(e.firstElementChild);const off={bg:c.backgroundColor,knob:k.backgroundColor,ring:c.borderTopColor,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height};e.click();await new Promise(r=>setTimeout(r,220));const on={bg:getComputedStyle(e).backgroundColor,knob:getComputedStyle(e.firstElementChild).backgroundColor,checked:e.getAttribute('aria-checked')};fToggle.setDisabled(true);e.click();const unchanged=e.getAttribute('aria-checked');e.remove();return {off,on,unchanged}})()`);
  check('F production switch off knob/ring use A tokens despite later stylesheet', primitive.off.knob==='rgb(255, 255, 255)'&&primitive.off.ring!=='rgba(0, 0, 0, 0)'&&primitive.off.w===38&&primitive.off.h===22,primitive);
  check('F production switch on inverts and disabled click preserves state', primitive.on.bg==='rgb(26, 28, 31)'&&primitive.on.knob==='rgb(255, 255, 255)'&&primitive.on.checked==='true'&&primitive.unchanged==='true',primitive);
  // Deliberately injected presentation classes, not proof of persistence faults.
  const status=await read(`(async()=>{const e=document.querySelector('.appearance-status');e.classList.add('is-error');await new Promise(r=>setTimeout(r,220));const error=getComputedStyle(e).color;e.classList.remove('is-error');e.classList.add('is-warning');await new Promise(r=>setTimeout(r,220));const warning=getComputedStyle(e).color;e.classList.remove('is-warning');return {error,warning}})()`);
  check('F appearance error/warning use existing readable semantic colors', status.error==='rgb(185, 28, 28)'&&status.warning==='rgb(133, 77, 14)',status);
  await click('#navProviders'); await waitFor(`!!document.querySelector('.prov-toolbar')||!!document.querySelector('.prov')`);
  check('F provider primary action follows the shared light accent inversion', await read(`(()=>{const a=[...document.querySelectorAll('.prov-btn-main,.prov-empty-btn')];return a.length>0&&a.every(e=>{const c=getComputedStyle(e);return c.backgroundColor==='rgb(26, 28, 31)'&&c.color==='rgb(255, 255, 255)'})})()`));
  await shot('f09-providers-light');
  await click('#settingsReturn'); await waitFor(`document.querySelector('#workspace').dataset.workspaceView==='chat'`);
  win.setContentSize(700,600); await input('/'); await waitFor(`!!document.querySelector('.ui3-inline-menu:not([hidden])')`); m=await menuMetrics();
  check('F narrow slash stays wholly in CSS viewport with usable input width', m.x>=0&&m.top>=0&&m.right<=m.vw&&m.bottom<=m.vh&&Math.abs(m.width-m.anchor)<=1,m);
  await shot('f10-slash-narrow-light'); await key('ESC');
  await click('#btnCtx'); await waitFor(`!document.querySelector('#composerPopover').hidden`);
  check('F narrow unknown context panel stays inside viewport', await read(`(()=>{const r=document.querySelector('#composerPopover').getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`));
  await shot('f11-context-narrow-light'); win.webContents.sendInputEvent({type:'mouseMove',x:500,y:60}); await key('ESC');
  win.setContentSize(1205,803); await input('阶段 F：保留这份草稿');
  for (const mode of ['dark','light','dark','light']) {
    await read(`TH.setThemePreference(${JSON.stringify(mode)})`); await paint();
    check('F repeated theme '+mode+' keeps source input/draft and native caption', await read(`document.documentElement.dataset.theme===${JSON.stringify(mode)}&&document.querySelector('#input')===fInput&&fInput.value==='阶段 F：保留这份草稿'`) && theme.windowOptions().titleBarOverlay.color===(mode==='light'?'#ffffff':'#181818'));
  }
  await click('#btnSidebarCollapse'); await shot('f12-collapsed-light'); await click('#btnSidebarExpand');
  await read(`TH.setThemePreference('dark')`); await input('/'); await waitFor(`!!document.querySelector('.ui3-inline-menu:not([hidden])')`);m=await menuMetrics();
  check('F dark slash retains reference surface and full measured width', m.ink==='rgb(255, 255, 255)'&&Math.abs(m.width-m.anchor)<=1,m);
  await shot('f13-slash-dark'); await key('ESC');
  await read(`TH.setThemePreference('light')`);await click('#btnWorkPanel');await click('.work-panel-launcher-row[data-tool="btnBrowser"]');
  await browser.navigate(browserFixtureUrl);
  await waitFor(`!!document.querySelector('#browserViewport')`);
  const native=()=>win.contentView.children.find(view=>view.webContents===browser.getWebContents());
  for(let i=0;i<40&&!native();i++)await paint();
  await input('/');await waitFor(`!!document.querySelector('.ui3-inline-menu:not([hidden])')`);m=await menuMetrics();
  const bounds=native()?.getBounds(),zoom=win.webContents.getZoomFactor();
  check('F expanded slash stays before the actual attached native Browser',bounds&&m.right*zoom<=bounds.x&&m.focus,{menu:m,native:bounds,zoom});
  await shot('f15-slash-browser-light');await nativeShot('f15-slash-browser-light');await key('ESC');
  await click('#workPanelHome');await click('#workPanelClose');
};
