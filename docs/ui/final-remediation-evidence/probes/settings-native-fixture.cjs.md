# 本轮 TEMP 设置交互探针

```
module.exports=async({read,click,key,paint,check,win})=>{
 await click('#navGlobalMore');
 await read("window.settingsTrusted=[];document.querySelector('#settingsSearchInput').addEventListener('keydown',function record(e){settingsTrusted.push(e.isTrusted)},{once:true});document.querySelector('#settingsSearchInput').focus()");
 await key('Down');
 check('R1 trusted settings search Down reaches the first item exactly once',await read("document.activeElement===document.querySelector('#navAppearance')&&settingsTrusted[0]===true"));
 await key('Up');
 check('R1 trusted Up from the first item returns to settings search',await read("document.activeElement===document.querySelector('#settingsSearchInput')"));
 await read("document.querySelector('#settingsSearchInput').value='MCP';document.querySelector('#settingsSearchInput').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#settingsSearchInput').focus()");
 await key('Down');
 check('R1 trusted Down after filtering reaches the actual first match',await read("document.activeElement===document.querySelector('#navMcp')"));
 await key('Escape');
 check('R1 trusted Escape closes settings without a stale navigation focus',await read("document.querySelector('#workspace').dataset.workspaceView==='chat'"));
 await click('#navGlobalMore');await read(`document.querySelector("#settingsSearchInput").value="";document.querySelector("#settingsSearchInput").dispatchEvent(new Event("input",{bubbles:true}))`);await paint();await click('#navProviders');await click('.prov-btn-main');
 await read(`(()=>{const original=fetch;window.emptyBaseWrites=0;window.fetch=async(url,options={})=>{if(new URL(String(url),location.href).pathname==='/api/providers'&&options.method==='POST'){emptyBaseWrites++;return new Response(JSON.stringify({ok:false,error:'fixture guard'}),{headers:{'content-type':'application/json'}})}return original(url,options)};document.querySelector('.settings-detail-card input[placeholder="my-provider"]').value='fixture-provider';document.querySelector('.settings-detail-card input[placeholder="https://api.example.com/v1"]').value=''})()`);
 await click('.settings-detail-card>.modal-actions button:last-child');
 check('R1 missing Base URL remains rejected before the production API wrapper',await read(`emptyBaseWrites===0&&[...document.querySelectorAll('.ui4-feedback-toast-body')].some(e=>e.textContent.includes('请填写 Base URL'))`));
};

```
