// Reproducible local editor export. Requires inspect-prototype.cjs and the canvas editor.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const qaInfo=JSON.parse(await fs.readFile(path.join(root,'evidence/prototype/driver.json'),'utf8'));
const editor=JSON.parse(await fs.readFile(path.join(root,'canvas/.artifact-server.json'),'utf8'));
const qa=async(op,body)=>{const r=await fetch(qaInfo.url+'/'+op,{method:body===undefined?'GET':'POST',body:typeof body==='string'?body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error);return data};
const read=code=>qa('eval?target=main',code),sleep=ms=>new Promise(r=>setTimeout(r,ms));
await qa('load',{url:editor.url});await sleep(900);
const records=[];
for(const [file,slug,label] of [['Main.dc.html','workbench','A · 工作台 / 正常会话'],['Reading.dc.html','reading','B · 阅读空间 / 正常会话']]){
 await qa('load',{url:editor.url});await sleep(700);
 for(let i=0;i<80;i++){if(await read(`Boolean(document.querySelector('button[aria-label=${JSON.stringify('Export artboard '+label)}]'))`))break;await sleep(100)}
 await read(`window.__qaDownload=null;HTMLAnchorElement.prototype.click=function(){window.__qaDownload={href:this.href,name:this.download}};document.querySelector('button[aria-label=${JSON.stringify('Export artboard '+label)}]').click()`);
 for(let i=0;i<40;i++){if(await read(`[...document.querySelectorAll('[role="menuitem"]')].some(e=>e.innerText.startsWith('HTML'))`))break;await sleep(100)}
 const r=await read(`[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.innerText.startsWith('HTML')).getBoundingClientRect().toJSON()`);
 await qa('click',{x:r.x+r.width/2,y:r.y+r.height/2});
 for(let i=0;i<100;i++){if(await read('Boolean(window.__qaDownload)'))break;await sleep(100)}
 const b64=await read(`(async()=>{const b=await(await fetch(window.__qaDownload.href)).blob();return await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result.split(',')[1]);f.readAsDataURL(b)})})()`);
 const bytes=Buffer.from(b64,'base64'),zip=path.join(root,'exports',slug+'.zip'),dest=path.join(root,'exports',slug);await fs.mkdir(path.dirname(zip),{recursive:true});await fs.writeFile(zip,bytes);
 const p=spawnSync('powershell.exe',['-NoProfile','-Command',`Expand-Archive -LiteralPath '${zip.replaceAll("'","''")}' -DestinationPath '${dest.replaceAll("'","''")}' -Force`],{encoding:'utf8',windowsHide:true});if(p.status!==0)throw Error(p.stderr);
 const source=await fs.readFile(path.join(root,'canvas/project',file));records.push({file,slug,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),sourceSha256:createHash('sha256').update(source).digest('hex'),route:'/exports/'+slug+'/'+file});console.log('Exported '+slug+' '+bytes.length+' bytes');await sleep(200);
}
await fs.writeFile(path.join(root,'exports/export-manifest.json'),JSON.stringify({via:'claude-design editor HTML (.zip), local resources',records},null,2));
