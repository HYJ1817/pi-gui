// Design qualification only; never calls a production endpoint or real model.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const qaInfo=JSON.parse(await fs.readFile(path.join(root,'evidence/prototype/driver.json'),'utf8'));
const preview=JSON.parse(await fs.readFile(path.join(root,'evidence/preview-server.json'),'utf8'));
const qa=async(op,body)=>{const r=await fetch(qaInfo.url+'/'+op,{method:body===undefined?'GET':'POST',body:typeof body==='string'?body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v};
const read=code=>qa('eval?target=preview',code),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const checks=[],shots=[],facts=[];const check=(pass,name,detail)=>{checks.push({name,pass:!!pass,detail});if(!pass)console.log('FAIL '+name+' '+JSON.stringify(detail??''))};
const click=async(sel,button='left')=>{const r=await read(`document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().toJSON()`);await qa('click',{x:r.x+r.width/2,y:r.y+r.height/2,button});await sleep(80)};
const key=async(key,modifiers=[])=>{await qa('key',{key,modifiers});await sleep(70)};
const fill=async(sel,text)=>{await read(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.focus();const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await sleep(60)};
const geometry=()=>read(`(()=>{const r=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height,right:b.right,bottom:b.bottom}};return {w:innerWidth,h:innerHeight,dpr:devicePixelRatio,pageWidth:document.documentElement.scrollWidth,theme:document.querySelector('.pg-app').dataset.theme,variant:document.querySelector('.pg-app').dataset.variant,header:r('.pg-header'),sidebar:r('.pg-sidebar'),composer:r('.pg-composer'),input:r('#message-input'),panel:r('.pg-panel'),popover:r('.pg-popover'),menu:r('.pg-menu'),dialog:r('.pg-dialog'),scroll:r('.pg-scroll'),focus:document.activeElement?.id}})()`);
async function shot(name){await sleep(130);await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const g=await geometry();const snap=await qa('shot?name='+name);shots.push({name,file:path.basename(snap.file),pixels:snap.size,...g});check(g.pageWidth<=g.w+1,name+' page does not overflow',g);if(g.panel)check(Math.abs(g.panel.bottom-(g.h-28))<2,name+' panel fills workspace',g.panel);if(g.composer)check(g.composer.bottom<=g.h-28&&g.composer.y>0,name+' composer visible',g.composer);if(g.popover)check(g.popover.x>=7&&g.popover.y>=7&&g.popover.right<=g.w-7&&g.popover.bottom<=g.h-7,name+' picker in viewport',g.popover);}
const url=(variant)=>preview.url+'/exports/'+(variant==='a'?'workbench/Main.dc.html':'reading/Reading.dc.html');
async function load(variant,w=1440,h=900){await qa('size',{width:w,height:h,zoom:1});await qa('load',{url:url(variant)});await sleep(160)}
async function theme(t){const current=await read("document.querySelector('.pg-app').dataset.theme");if(current!==t)await click('#toggle-theme')}
try{
if(!process.argv.includes('--interactions-only'))for(const variant of ['a','b'])for(const t of ['dark','light'])for(const [w,h] of [[1280,800],[1440,900],[1920,1080]]){
 await load(variant,w,h);await theme(t);await shot(`${variant}-${t}-${w}-chat`);
 await click('#new-session');await shot(`${variant}-${t}-${w}-empty`);
 await click('[data-session="s2"]');await shot(`${variant}-${t}-${w}-running`);
 await click('[data-session="s3"]');await read("document.querySelector('.pg-scroll').scrollTop=340");await shot(`${variant}-${t}-${w}-long`);
 await click('[data-session="s1"]');await click('#open-changes');await shot(`${variant}-${t}-${w}-changes`);
 await click('#open-browser');await shot(`${variant}-${t}-${w}-browser`);
 await click('#panel-close');await click('[data-session="s4"]');await read("document.querySelector('.pg-scroll').scrollTop=99999");await shot(`${variant}-${t}-${w}-error`);
}
for(const variant of ['a','b']){
 await load(variant);await click('#model-trigger');const actualTheme=await read("document.querySelector('.pg-app').dataset.theme");await shot(`${variant}-${actualTheme}-1440-model`);
 check(await read("document.activeElement?.id==='model-search'"),variant+' model search receives focus');
 await fill('#model-search','not-present');check(await read("document.body.innerText.includes('没有匹配的模型')"),variant+' model search empty state');
 await fill('#model-search','Claude');await key('ArrowDown');await key('Enter');await sleep(400);
 check(await read("document.querySelector('#model-trigger').innerText.includes('Claude Sonnet')"),variant+' keyboard selects model');
 check(await read("!document.querySelector('#model-popover')"),variant+' model picker closes');
 await click('#model-trigger');await key('Escape');check(await read("document.activeElement?.id==='model-trigger'"),variant+' model Escape restores trigger');
 await click('#think-trigger');await key('Escape');check(await read("document.activeElement?.id==='think-trigger'"),variant+' thinking Escape restores trigger');
 const before=await read("[...document.querySelectorAll('[data-session]')].map(e=>({id:e.dataset.session,y:e.getBoundingClientRect().y}))");
 await fill('#message-input','会话一草稿 / draft A');await click('[data-session="s2"]');await fill('#message-input','运行中补充说明 / draft B');await click('[data-session="s1"]');
 check(await read("document.querySelector('#message-input').value==='会话一草稿 / draft A'"),variant+' session draft A restored');
 await click('[data-session="s2"]');check(await read("document.querySelector('#message-input').value==='运行中补充说明 / draft B'"),variant+' session draft B isolated');
 const after=await read("[...document.querySelectorAll('[data-session]')].map(e=>({id:e.dataset.session,y:e.getBoundingClientRect().y}))");check(JSON.stringify(before)===JSON.stringify(after),variant+' selection preserves row identity order and Y coordinates',{before,after});
 await click('#send-message');check(await read("document.querySelector('#send-message').disabled&&document.querySelector('#message-input').disabled&&document.body.innerText.includes('停止请求处理中')"),variant+' stop waits with disabled input');await shot(`${variant}-1440-stopping`);await sleep(750);
 check(await read("!document.querySelector('[data-session="+JSON.stringify('s2')+"]').closest('.pg-session').innerText.includes('运行')"),variant+' stopped session sidebar status updated');
 await click('[data-session="s1"]');await click('[data-session="s2"]');check(await read("document.querySelector('#send-message').getAttribute('aria-label')==='发送演示消息'"),variant+' stopped state survives session switch');
 await click('[data-session="s3"]');await read("document.querySelector('.pg-scroll').scrollTop=280");await sleep(90);const top=await read("document.querySelector('.pg-scroll').scrollTop");await click('[data-session="s1"]');await click('[data-session="s3"]');check(Math.abs((await read("document.querySelector('.pg-scroll').scrollTop"))-top)<2,variant+' long session restores reading position');
 await fill('#message-input','长会话待发送');await click('#nav-tasks');await shot(`${variant}-1440-tasks`);await click('#nav-chat');check(await read("document.querySelector('#message-input').value==='长会话待发送'"),variant+' task page roundtrip preserves draft');
 await click('#collapse-sidebar');check(await read("!document.querySelector('.pg-sidebar')"),variant+' sidebar collapses');await click('#expand-sidebar');check(await read("!!document.querySelector('.pg-sidebar')"),variant+' sidebar reopens');
 await click('[data-session="s1"]');await click('[data-session="s1"]','right');await sleep(80);const menu=await geometry();const row=await read("document.querySelector('[data-session=\"s1\"]').getBoundingClientRect().toJSON()");check(menu.menu?.x<400&&menu.menu?.y>=row.y-1,variant+' context menu anchored near row',{menu:menu.menu,row});await shot(`${variant}-1440-contextmenu`);
 await click('.pg-menu button');await shot(`${variant}-1440-rename-dialog`);check(await read("document.activeElement?.id==='dialog-input'"),variant+' dialog initial focus');
 await key('Tab',['shift']);check(await read("document.activeElement?.id==='dialog-confirm'"),variant+' dialog focus trap');await key('Escape');check(await read("document.activeElement?.dataset.session==='s1'"),variant+' menu dialog restores original session trigger');
 await click('#session-more');await click('#message-input');check(await read("!document.querySelector('.pg-menu')"),variant+' menu closes on outside pointer');
 await click('#project-more');await qa('size',{width:1280,height:800});await sleep(100);check(await read("!document.querySelector('.pg-menu')"),variant+' viewport resize closes anchored menu');
 await click('[data-session="s4"]');await read("document.querySelector('.pg-scroll').scrollTop=99999");await click('#retry-error');await click('[data-session="s2"]');await sleep(1000);check(await read("document.querySelector('#message-input').value==='运行中补充说明 / draft B'&&document.querySelector('#send-message').getAttribute('aria-label')==='发送演示消息'"),variant+' background retry does not alter other stopped session');
 await click('[data-session="s4"]');check(await read("!document.querySelector('#retry-error')"),variant+' retry owner recovered');
 await click('#new-session');await fill('#message-input','第一行');await key('Enter',['shift']);check(await read("document.querySelector('#message-input').value.includes('\\n')"),variant+' Shift Enter adds newline');
 await click('#attach-file');check(await read("!!document.querySelector('.pg-attachment')"),variant+' Classic attachment demo');await click('#toggle-runtime');check(await read("document.querySelector('#attach-file').disabled&&!document.querySelector('.pg-attachment')"),variant+' Runtime does not claim attachment support');
 await click('#nav-skills');await shot(`${variant}-1440-skills`);await click('#nav-settings');await shot(`${variant}-1440-settings`);await click('#nav-chat');
 await qa('media',[{name:'prefers-reduced-motion',value:'reduce'}]);check(await read("matchMedia('(prefers-reduced-motion:reduce)').matches"),variant+' reduced motion media active');
 for(const zoom of [1.25,1.5]){await qa('size',{width:1440,height:900,zoom});await click('#model-trigger');await shot(`${variant}-zoom-${zoom}-model`);await key('Escape')}
 await qa('size',{width:1440,height:900,zoom:1});await qa('media',[{name:'prefers-reduced-motion',value:'no-preference'}]);
}
}catch(e){check(false,'QA runner completed',e.stack)}
const state=await qa('state');const results={scope:'exported design prototypes only; normal sandbox Electron, host Windows DPR=1.5; no production backend or model',sourceManifest:JSON.parse(await fs.readFile(path.join(root,'exports/export-manifest.json'),'utf8')),passed:checks.filter(c=>c.pass).length,failed:checks.filter(c=>!c.pass).length,skipped:0,checks,shots,facts,driverConsole:state.errors};await fs.writeFile(path.join(root,'evidence/prototype',process.argv.includes('--interactions-only')?'interaction-results.json':'results.json'),JSON.stringify(results,null,2));console.log(`Prototype checks ${results.passed}/${checks.length}; failed=${results.failed}; screenshots=${shots.length}`);process.exitCode=results.failed?1:0;
