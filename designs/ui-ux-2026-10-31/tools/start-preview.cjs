'use strict';
// Direct Node launcher, compatible with Windows policies that require signed .ps1 files.
// Leaves execution policy unchanged; starts only this local, hidden preview helper.
const path=require('node:path'),{spawnSync,spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),port=Number(process.argv.find(x=>/^--port=/.test(x))?.split('=')[1]??8120);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid preview port');
const base='http://127.0.0.1:'+port;
async function ready(){try{const r=await fetch(base+'/index.html',{signal:AbortSignal.timeout(1500)});return r.ok&&(await r.text()).includes('pi-gui-design-review-20261031')}catch{return false}}
async function main(){
 if(!await ready()){
  const cmd='"'+process.execPath+'" "'+path.join(__dirname,'serve.cjs')+'" '+port;
  const quote=s=>"'"+s.replaceAll("'","''")+"'";
  const script="$startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; $r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine="+quote(cmd)+";ProcessStartupInformation=$startup}; $r | ConvertTo-Json -Compress";
  const p=spawnSync('powershell.exe',['-NoProfile','-Command',script],{windowsHide:true,encoding:'utf8'});if(p.status!==0)throw Error(p.stderr||'Could not start preview');
  const result=JSON.parse(p.stdout);if(result.ReturnValue!==0)throw Error('Windows process start code '+result.ReturnValue);
  for(let i=0;i<35&&!await ready();i++)await new Promise(r=>setTimeout(r,150));
  if(!await ready())throw Error('Preview unavailable; check the port or use --port=8121');
 }
 const url=base+'/review-refined.html';console.log('Review: '+url+'\nPrototype: '+base+'/exports/refined/Refined.dc.html');
 if(process.argv.includes('--open')){const p=spawn('explorer.exe',[url],{windowsHide:true,detached:true,stdio:'ignore'});p.unref()}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
