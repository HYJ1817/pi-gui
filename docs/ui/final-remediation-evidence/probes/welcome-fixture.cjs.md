# 本轮 TEMP 欢迎布局探针

```
module.exports=async({read,click,shot,paint,check,win})=>{
 await read(`document.querySelector("#navGlobalMore").click()`);await paint();await read(`document.querySelector("#navAppearance").click()`);await paint();
 await read("(()=>{const s=document.querySelector('.font-size-ctrls input[type=range]');s.value='130';s.dispatchEvent(new Event('input',{bubbles:true}))})()");
 await read(`document.querySelector("#settingsReturn").click()`);await paint();
 for(const [width,height] of [[1205,803],[700,600]])for(const mode of ['dark','light'])for(const state of ['ready','noProject','restore']){
  win.setContentSize(width,height);
  await read('(async()=>{await TH.setThemePreference('+JSON.stringify(mode)+');Object.assign(ST.S,{restoring:'+String(state==='restore')+',hasProject:'+String(state!=='noProject')+',bridgeState:"ready"});M.clearThread();SH.applyProjectState();document.querySelector("#stream").scrollTop=0;})()');await paint();
  const facts=await read('(()=>{const p=document.querySelector('+JSON.stringify('#welcome'+(state==='ready'?'Ready':state==='noProject'?'NoProj':'Restore'))+'),s=document.querySelector("#stream"),c=document.querySelector("#composerBox").getBoundingClientRect();s.scrollTop=s.scrollHeight;let last=p.querySelector("button")||p.lastElementChild,r=last.getBoundingClientRect();return{visible:p.checkVisibility(),last:r.toJSON(),composer:c.toJSON(),viewport:[innerWidth,innerHeight],scroll:s.scrollTop}})()');
  check('welcome '+state+' '+mode+' '+width+'px 130% remains readable above Composer',facts.visible&&facts.last.left>=0&&facts.last.right<=facts.viewport[0]&&facts.last.bottom<=facts.composer.top,facts);
  await shot('welcome-'+state+'-'+mode+'-'+width+'-130');
 }
};

```
