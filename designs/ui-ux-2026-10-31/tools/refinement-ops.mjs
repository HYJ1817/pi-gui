import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const info=JSON.parse(await fs.readFile(path.join(root,'evidence/prototype/driver.json'),'utf8'));
export const qa=async(op,body)=>{const r=await fetch(info.url+'/'+op,{method:body===undefined?'GET':'POST',body:typeof body==='string'?body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error);return d};
export const read=code=>qa('eval?target=preview',code);
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const mode=process.argv[2];
if(mode==='inspect')console.log(await qa('eval?target=main',`JSON.stringify([...document.querySelectorAll('button')].map(b=>({text:b.innerText,label:b.getAttribute('aria-label')})))`));
if(mode==='syntax'){const text=await fs.readFile(path.join(root,'canvas/project/Refined.dc.html'),'utf8');const block=text.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];new Function('DCLogic',block);console.log('DC logic parses');}
if(mode==='fonts')console.log(await read(`JSON.stringify(['.pg-app','.pg-assistant','#message-input','.pg-sideaction'].map(s=>{const e=document.querySelector(s),c=getComputedStyle(e);return {s,font:c.font,family:c.fontFamily,variable:c.getPropertyValue('--font-sans')}}))`));
if(mode==='close')console.log(await qa('quit'));
if(mode==='font-proof'){
 await qa('load',{url:'http://127.0.0.1:8120/exports/refined/Refined.dc.html'});await sleep(400);
 const record={platform:await qa('fonts'),computed:await read(`['.pg-app','.pg-assistant','#message-input'].map(s=>{const c=getComputedStyle(document.querySelector(s));return {selector:s,family:c.fontFamily,size:c.fontSize,lineHeight:c.lineHeight}})`),state:await qa('state')};
 await fs.writeFile(path.join(root,'evidence/refined/final-font-smoke.json'),JSON.stringify(record,null,2));console.log(JSON.stringify(record.platform));
}
if(mode==='review-proof'){
 await qa('size',{width:1440,height:900,zoom:1});await qa('load',{url:'http://127.0.0.1:8120/review-refined.html'});await sleep(450);
 const main=code=>qa('eval?target=main',code);console.log(await main(`JSON.stringify({title:document.title,stats:document.querySelector('#checks').innerText,loaded:[...document.images].filter(i=>i.complete&&i.naturalWidth>0).length,broken:[...document.images].filter(i=>i.complete&&!i.naturalWidth).length})`));
 const snap=await qa('shot?name=input-review-portal');await fs.rename(snap.file,path.join(root,'evidence/input-assistance/review-portal.png'));
}
if(mode==='first'){
 await qa('size',{width:1440,height:900,zoom:1});await qa('load',{url:'http://127.0.0.1:8120/exports/refined/Refined.dc.html'});await sleep(500);
 console.log(await read(`JSON.stringify({text:document.body.innerText.slice(0,250),w:innerWidth,h:innerHeight,app:!!document.querySelector('.pg-app'),color:document.querySelector('.pg-app')?getComputedStyle(document.querySelector('.pg-app')).backgroundColor:null})`));
 console.log(await qa('shot?name=r2-first'));
}
if(mode==='export'){
 const editor=JSON.parse(await fs.readFile(path.join(root,'canvas/.artifact-server.json'),'utf8'));
 const main=code=>qa('eval?target=main',code);
 await qa('load',{url:editor.url});await sleep(1500);
 const label='Export artboard 统一修订版 · 中性单侧栏';
 await main(`window.__qaDownload=null;HTMLAnchorElement.prototype.click=function(){window.__qaDownload={href:this.href,name:this.download}};(document.querySelector('button[aria-label=${JSON.stringify(label)}]')??document.querySelector('button[aria-label="Export"]')).click()`);
 await sleep(350);
 const r=await main(`[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.innerText.startsWith('HTML')).getBoundingClientRect().toJSON()`);
 await qa('click',{x:r.x+r.width/2,y:r.y+r.height/2});
 for(let i=0;i<80;i++){if(await main('Boolean(window.__qaDownload)'))break;await sleep(150)}
 const b64=await main(`(async()=>{const b=await(await fetch(window.__qaDownload.href)).blob();return await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result.split(',')[1]);f.readAsDataURL(b)})})()`);
 const bytes=Buffer.from(b64,'base64'),zip=path.join(root,'exports/refined.zip'),dest=path.join(root,'exports/refined');await fs.mkdir(dest,{recursive:true});await fs.writeFile(zip,bytes);
 const p=spawnSync('powershell.exe',['-NoProfile','-Command',`Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`],{windowsHide:true,encoding:'utf8'});if(p.status!==0)throw Error(p.stderr);
 const source=await fs.readFile(path.join(root,'canvas/project/Refined.dc.html'));
 await fs.writeFile(path.join(root,'exports/refined-manifest.json'),JSON.stringify({via:'claude-design editor HTML (.zip), local resources',file:'Refined.dc.html',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),sourceSha256:createHash('sha256').update(source).digest('hex'),route:'/exports/refined/Refined.dc.html'},null,2));
 console.log('Exported refined '+bytes.length+' bytes');
}
