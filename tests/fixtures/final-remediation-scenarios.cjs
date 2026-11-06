/* Production pages, handlers and styles; all writes are intercepted in memory. */
module.exports = async ({ read, click, key, shot, paint, check, win, waitFor }) => {
  await read(`(async()=>{const w=await import('/ui/workspace-surface.js');w.showChat();Object.assign(ST.S,{restoring:false,hasProject:true,bridgeState:'ready'});M.clearThread();SH.applyProjectState();await TH.setThemePreference('dark')})()`);
  check('R3 welcome uses the centered reference hero hierarchy', await read(`(()=>{let p=document.querySelector('#welcomeReady'),m=p.querySelector('.welcome-mark');return getComputedStyle(p).display==='flex'&&m.getBoundingClientRect().width===100&&getComputedStyle(p).textAlign==='center'})()`));
  const welcome=await read(`(()=>{let s=document.querySelector('#stream'),w=document.querySelector('#welcome');return {scroll:s.scrollHeight,client:s.clientHeight,welcome:w.getBoundingClientRect().toJSON()}})()`);
  check('R3 empty welcome fits the actual content viewport without phantom thread scroll',welcome.scroll<=welcome.client+1,welcome);
  await click('#navGlobalMore'); await click('#navAppearance');
  check('R3 appearance group dissolves into the page without a second card', await read(`(()=>{let c=getComputedStyle(document.querySelector('.appearance-body'));return c.borderTopWidth==='0px'&&c.backgroundColor==='rgba(0, 0, 0, 0)'&&c.padding==='0px'})()`));
  const appearanceActions = await read(`document.querySelector('.settings-detail-card > .modal-actions').checkVisibility()`);
  check('R1 appearance completion action is visible in the real stylesheet', appearanceActions);
  await win.setContentSize(700, 600); await paint();
  const label = await read(`(()=>{let e=document.querySelector('.ds-settings-row-multiline .ds-settings-row-label > span'),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {width:r.width,height:r.height,font:parseFloat(s.fontSize)}})()`);
  check('R1 narrow settings keeps the size label readable on one line', label.width >= label.font * 3 && label.height < label.font * 2, label);
  await shot('r01-settings-narrow');
  for (const size of [900,700]) for (const mode of ['dark','light']) {
    await win.setContentSize(size,600);
    await read(`(async()=>{await TH.setThemePreference(${JSON.stringify(mode)});const e=document.querySelector('.font-size-ctrls input[type="range"]');e.value='130';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`);await paint();
    const geometry=await read(`(()=>{const row=document.querySelector('.ds-settings-row-multiline'),l=row.querySelector('.ds-settings-row-label > span'),r=l.getBoundingClientRect(),c=getComputedStyle(l),controls=[...row.querySelectorAll('input,button')].map(e=>e.getBoundingClientRect());return {readable:r.height<parseFloat(c.fontSize)*2,inView:controls.every(r=>r.width>0&&r.left>=0&&r.right<=innerWidth),overflow:document.documentElement.scrollWidth>innerWidth}})()`);
    check(`R1 ${size}px ${mode} settings remain readable at 130 percent`,geometry.readable&&geometry.inView&&!geometry.overflow,geometry);
  }
  await shot('r09-appearance-130-narrow-light');
  await read(`(()=>{const e=document.querySelector('.font-size-ctrls input[type="range"]');e.value='100';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await win.setContentSize(1205, 803); await paint();
  await read(`TH.setThemePreference('dark')`);
  await click('#navProviders'); await click('.prov-btn-main');
  const providerActions = await read(`[...document.querySelectorAll('.settings-detail-card > .modal-actions button')].map(e=>({text:e.textContent,visible:e.checkVisibility()}))`);
  check('R1 provider primary entry exposes both Save and Cancel', providerActions.length === 2 && providerActions.every(e => e.visible), providerActions);
  await shot('r02-provider-add-dark');
  if (providerActions.every(e => e.visible)) {
    await read(`(()=>{const original=window.fetch;window.rProviderWrites=[];window.rProviders={};window.fetch=async(url,options={})=>{let u=new URL(String(url),location.href);if(u.pathname!=='/api/providers')return original(url,options);if(options.method&&options.method!=='GET'){let payload=JSON.parse(options.body);rProviderWrites.push(payload);rProviders[payload.name]=payload.config;}return new Response(JSON.stringify({ok:true,path:'fixture/models.json',providers:rProviders,keyStates:{}}),{headers:{'content-type':'application/json'}})}})()`);
    await read(`document.querySelector('.settings-detail-card input[placeholder="my-provider"]').value=''`);
    await click('.settings-detail-card > .modal-actions button:last-child');
    check('R1 missing provider ID never reaches save API', await read('rProviderWrites.length===0'));
    await read(`document.querySelector('.settings-detail-card input[placeholder="my-provider"]').value='fixture-provider';document.querySelector('.settings-detail-card input[placeholder="https://api.example.com/v1"]').value='https://example.invalid/v1';document.querySelector('.settings-detail-card textarea').value='fixture-model|Fixture Model';document.querySelector('.settings-detail-card input[placeholder^="$MY"]').value='fixture-plaintext-rejected'`);
    await click('.settings-detail-card > .modal-actions button:last-child');
    check('R1 plaintext provider credentials remain rejected', await read('rProviderWrites.length===0'));
    await read(`document.querySelector('.settings-detail-card input[placeholder^="$MY"]').value='$FIXTURE_KEY'`);
    // Walk the real tab chain from the last text field to Save.
    await read(`document.querySelector('.settings-detail-card textarea').focus()`);
    let tabReachedSave = false;
    for (let i = 0; i < 12; i++) {
      await key('Tab');
      if (await read(`document.activeElement===document.querySelector('.settings-detail-card > .modal-actions button:last-child')`)) { tabReachedSave = true; break; }
    }
    check('R1 provider Save is reachable using the native Tab chain', tabReachedSave);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await paint();
    await waitFor('rProviderWrites.length===1');
    await waitFor(`!!document.querySelector('.prov-btn-main')`);
    check('R1 valid provider form delegates once to the real API wrapper', await read(`rProviderWrites.length===1&&rProviderWrites[0].name==='fixture-provider'&&rProviderWrites[0].config.apiKey==='$FIXTURE_KEY'`));
    await read(`(async()=>{rProviders={};const p=await import('/providers.js');await p.loadProviders()})()`);
    await click('.prov-empty-btn');
    check('R1 empty and primary Add share the same existing presenter', await read(`!!document.querySelector('.settings-detail-card > .modal-actions')&&document.querySelector('#modal').hidden`));
    await click('.settings-detail-card > .modal-actions button:first-child');
    check('R1 cancelling provider form performs no writes', await read('rProviderWrites.length===1'));
  }
  await read(`document.querySelector('#navDiagnostics').scrollIntoView({block:'nearest'})`);
  await click('#navDiagnostics');
  await waitFor(`document.querySelectorAll('.settings-detail-card > .modal-actions button').length >= 4`);
  check('R1 diagnostic export and refresh remain reachable', await read(`(()=>{let b=[...document.querySelectorAll('.settings-detail-card > .modal-actions button')];return b.length>=4&&b.every(e=>e.checkVisibility())})()`));
  await shot('r10-diagnostics-dark');
  for(const [id,name] of [['navShortcutHelp','shortcuts'],['navProviderAuth','auth'],['navAppUpdates','updates'],['navMcp','mcp'],['navCapabilities','capabilities'],['navExtensions','skills']]){
    if(!await read(`!!document.getElementById(${JSON.stringify(id)})`))throw Error('Unknown settings navigation '+id);
    await read(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({block:'nearest'})`);await click('#'+id);await paint();
    await shot('r11-settings-'+name+'-dark');
    if(['navMcp','navCapabilities','navExtensions'].includes(id))check('R1 '+name+' current navigation matches its real tab owner',await read(`document.getElementById(${JSON.stringify(id)}).getAttribute('aria-current')==='page'&&document.querySelectorAll('#globalMoreMenu [aria-current="page"]').length===1`));
  }
  await click('#settingsReturn');
  await read(`(async()=>{await TH.setThemePreference('light');M.clearThread();M.setStreaming(false);let data={version:1,type:'line',title:'主题与键盘回归',labels:['A','B','C'],series:[{name:'数值',data:[1,2,3]}]};M.rebuildFromMessages([{role:'assistant',content:[{type:'text',text:String.fromCharCode(96).repeat(3)+'pi-gui-viz'+String.fromCharCode(10)+JSON.stringify(data)+String.fromCharCode(10)+String.fromCharCode(96).repeat(3)}]}])})()`);
  await click('.viz-open-btn'); await read(`document.querySelector('.viz-point').focus()`); await paint();
  const viz = await read(`(()=>{let tip=document.querySelector('.viz-tooltip'),body=document.querySelector('.viz-tip-body'),b=document.querySelector('.viz-open-btn'),wrapper=tip.parentElement;const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');const solid=e=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=getComputedStyle(document.body).backgroundColor;ctx.fillRect(0,0,1,1);ctx.fillStyle=getComputedStyle(e).backgroundColor;ctx.fillRect(0,0,1,1);return 'rgb('+[...ctx.getImageData(0,0,1,1).data].slice(0,3).join(',')+')'};return{tip:tip.getBoundingClientRect().toJSON(),wrapper:wrapper.getBoundingClientRect().toJSON(),background:solid(tip),color:getComputedStyle(body).color,buttonBackground:solid(b),buttonColor:getComputedStyle(b).color}})()`);
  check('R1 keyboard chart tooltip stays in its actual panel', viz.tip.left >= viz.wrapper.left && viz.tip.right <= viz.wrapper.right && viz.tip.top >= viz.wrapper.top && viz.tip.bottom <= viz.wrapper.bottom, viz);
  const luminance = css => {
    const rgb = css.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
    return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
  };
  const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  check('R1 light chart button and tooltip have readable contrast', ratio(viz.background, viz.color) >= 4.5 && ratio(viz.buttonBackground, viz.buttonColor) >= 4.5, viz);
  await shot('r03-viz-light-keyboard');
  await click('#workPanelClose');
  await read(`(async()=>{const w=await import('/ui/workspace-surface.js');w.showChat();document.querySelector('#input').value='/';document.querySelector('#input').dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await waitFor(`!!document.querySelector('.ui3-inline-menu:not([hidden])')`);
  check('R5 slash aligns to the outer Composer and exposes existing command groups',await read(`(()=>{const e=document.querySelector('.ui3-inline-menu'),r=e.getBoundingClientRect(),c=document.querySelector('#composerBox').getBoundingClientRect();return Math.abs(r.width-c.width)<=1&&Math.abs(r.left-c.left)<=1&&!!e.querySelector('.ui3-inline-section')&&!!e.querySelector('.ui3-inline-footer')})()`));
  await shot('r04-slash-light');await key('ESC');
  await click('#btnCtx');await waitFor(`!document.querySelector('#composerPopover').hidden`);
  check('R5 usage tip uses reference 376px / 14px / 16px geometry',await read(`(()=>{const e=document.querySelector('#composerPopover'),r=e.getBoundingClientRect(),c=getComputedStyle(e);return r.width===376&&c.borderRadius==='14px'&&c.padding==='16px'})()`));
  await shot('r05-context-light');await key('ESC');
  await read(`(async()=>{shellExtraSessions=40;await SESS.refreshSidebarSessions();})()`);
  if (await read(`document.querySelector('.project.active .pj-chev').getAttribute('aria-expanded')!=='true'`)) await click('.project.active .pj-chev');
  if (await read(`!!document.querySelector('#pjSessionsBox .pj-sess-more:not(.pj-sess-arch-toggle)')`)) await click('#pjSessionsBox .pj-sess-more:not(.pj-sess-arch-toggle)');
  const sticky=await read(`(()=>{const s=document.querySelector('.rail-group'),h=document.querySelector('#groupHead');s.scrollTop=0;const before=h.getBoundingClientRect().top;s.scrollTop=s.scrollHeight;return {scroll:s.scrollTop,before,after:h.getBoundingClientRect().top}})()`);
  check('R5 project heading stays visible in its existing long-list scroller',sticky.scroll>0&&Math.abs(sticky.after-sticky.before)<=1,sticky);
  await shot('r06-sticky-projects-light');
};
