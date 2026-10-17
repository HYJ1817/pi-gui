/* Isolated offline wrapper around the existing CDP visual regression. */
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'docs/claude-ui-redesign/ui3-integration-evidence');
async function main(){
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'ui3-cdp-'));let harness;
 try{
  fs.mkdirSync(OUT,{recursive:true});
  harness=spawn(process.execPath,[path.join(ROOT,'tests/visual-harness.cjs')],{cwd:world,env:{...process.env,HARNESS_PORT:'0',VISUAL_UPLOAD_DIR:path.join(world,'uploads')},stdio:['ignore','pipe','pipe'],windowsHide:true});
  const origin=await new Promise((resolve,reject)=>{let s='';const t=setTimeout(()=>reject(Error('harness timeout')),15000);harness.stdout.on('data',b=>{s+=b;const m=s.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(t);resolve(m[0]);}});harness.on('error',reject);});
  const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
  const started=Date.now();
  const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(ROOT,'tests/cdp-shot.cjs'),'--url='+origin,'--tag=ui3-integration'],{cwd:ROOT,env:{...process.env,CDP_PORT:String(port)},stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',c=>resolve(c??1));});
  fs.writeFileSync(path.join(OUT,'cdp-process.json'),JSON.stringify({command:'node tests/ui3-cdp.cjs',childCommand:'node tests/cdp-shot.cjs --url=<offline port-0 harness> --tag=ui3-integration',exitCode:code,durationMs:Date.now()-started,screenshots:path.join(ROOT,'.shots')},null,2));
  process.exitCode=code;
 }finally{harness?.kill();fs.rm(world,{recursive:true,force:true,maxRetries:20,retryDelay:100},()=>{});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
