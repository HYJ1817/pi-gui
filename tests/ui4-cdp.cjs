/* Isolated offline wrapper around the existing CDP visual regression. */
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),OUT=process.env.UI4_CDP_EVIDENCE_ROOT||path.join(ROOT,'docs/claude-ui-redesign/ui4-integration-evidence');
async function main(){
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'ui4-cdp-'));let harness;let fixturesExit=null;
 /* cdp-shot 的附件矩阵从 os.tmpdir()/pi-gui-fixtures 读真实 docx/pdf。
  * 每次 run-job 都换新 TEMP，所以必须在同一 world 里先生成固件；
  * 否则附件相关断言会被静默跳过（跳过的断言不计入分子分母）。 */
 const env={...process.env,TEMP:world,TMP:world,TMPDIR:world};
 try{
  fs.mkdirSync(OUT,{recursive:true});
  fixturesExit=await new Promise((resolve,reject)=>{
   const f=spawn(process.execPath,[path.join(ROOT,'tests/fixtures.mjs')],{cwd:ROOT,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
   let log='';f.stdout.on('data',b=>{log+=b;});f.stderr.on('data',b=>{log+=b;});
   f.on('error',reject);f.on('exit',c=>{fs.writeFileSync(path.join(OUT,'fixtures.log'),log);resolve(c??1);});
  });
  harness=spawn(process.execPath,[path.join(ROOT,'tests/visual-harness.cjs')],{cwd:world,env:{...env,HARNESS_PORT:'0',VISUAL_UPLOAD_DIR:path.join(world,'uploads')},stdio:['ignore','pipe','pipe'],windowsHide:true});
  const origin=await new Promise((resolve,reject)=>{let s='';const t=setTimeout(()=>reject(Error('harness timeout')),15000);harness.stdout.on('data',b=>{s+=b;const m=s.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(t);resolve(m[0]);}});harness.on('error',reject);});
  const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
  const started=Date.now();
  /* 允许透传 cdp-shot 的过滤参数（如 --ux-only=true），便于只复跑某个场景；
   * 默认仍是完整矩阵。 */
  const extra=process.argv.slice(2).filter(a=>a.startsWith('--'));
  const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(ROOT,'tests/cdp-shot.cjs'),'--url='+origin,'--tag=ui4-integration',...extra],{cwd:ROOT,env:{...env,CDP_PORT:String(port)},stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',c=>resolve(c??1));});
  fs.writeFileSync(path.join(OUT,'cdp-process.json'),JSON.stringify({command:'node tests/ui4-cdp.cjs',childCommand:'node tests/cdp-shot.cjs --url=<offline port-0 harness> --tag=ui4-integration',fixturesExitCode:fixturesExit,exitCode:code,durationMs:Date.now()-started,screenshots:path.join(ROOT,'.shots')},null,2));
  process.exitCode=code;
 }finally{harness?.kill();fs.rm(world,{recursive:true,force:true,maxRetries:20,retryDelay:100},()=>{});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
