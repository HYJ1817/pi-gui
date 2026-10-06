import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {readAsset,isSea,rootDir} from '../lib/assets.js';

const AMBIENT=['PATH','Path','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','LANG','LC_ALL','TZ'];
let extracted=null;
export function processAssets(){
  if(!isSea())return path.join(rootDir(),'extensions','pi-gui-process');
  if(!extracted){
    extracted=fs.mkdtempSync(path.join(os.tmpdir(),'pi-gui-process-'));fs.chmodSync(extracted,0o700);
    for(const name of ['index.js','runner-win.ps1','runner-posix.cjs','runtime-child.cjs'])fs.writeFileSync(path.join(extracted,name),readAsset(`extensions/pi-gui-process/${name}`),{mode:0o600,flag:'wx'});
    fs.writeFileSync(path.join(extracted,'package.json'),'{"type":"module"}',{mode:0o600,flag:'wx'});
  }
  return extracted;
}
export function limitedEnvironment(source=process.env,overrides={}){const out={},seen=new Set();for(const key of AMBIENT)if(!seen.has(key.toUpperCase())&&typeof source[key]==='string'){out[key]=source[key];seen.add(key.toUpperCase());}return {...out,...overrides};}
export function resolveExecutable(command,args,env=process.env,platform=process.platform){
  const dirs=(env.PATH||env.Path||'').split(path.delimiter);
  const candidates=path.isAbsolute(command)?[command]:dirs.flatMap(dir=>platform==='win32'?[path.join(dir,`${command}.exe`),path.join(dir,`${command}.cmd`),path.join(dir,command)]:[path.join(dir,command)]);
  const file=candidates.find(p=>{try{return fs.statSync(p).isFile();}catch{return false;}});
  if(!file)throw Error('executable_not_found');
  if(/\.cmd$/i.test(file)&&/^npm(?:\.cmd)?$/i.test(path.basename(file))){
    const cli=path.join(path.dirname(file),'node_modules','npm','bin','npm-cli.js');
    if(!fs.existsSync(cli))throw Error('npm_launcher_unavailable');
    const node=resolveExecutable('node',[],env,platform);return {command:node.command,args:[cli,...args]};
  }
  if(platform==='win32'&&!/\.exe$/i.test(file))throw Error('launcher_unsupported');
  return {command:fs.realpathSync(file),args};
}
export function launchOwnedProcess(spec,{identity,platform=process.platform,spawnProcess=spawn,envSource=process.env,assets=processAssets()}={}){
  const emitter=new EventEmitter(),env=limitedEnvironment(envSource,spec.env);
  const executable=resolveExecutable(spec.command,spec.args,env,platform);
  let child;
  if(platform==='win32'){
    const powershell=path.join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    child=spawnProcess(powershell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(assets,'runner-win.ps1')],{cwd:spec.cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
  }else{
    child=spawnProcess(process.execPath,[path.join(assets,'runner-posix.cjs')],{cwd:spec.cwd,env:{...env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe'],detached:true});
  }
  let closed=false,stopping=false,started=false,control='',resolveClose;const completion=new Promise(resolve=>{resolveClose=resolve;});
  child.stdout.on('data',chunk=>{control+=chunk.toString('utf8');if(control.length>4096){emitter.emit('failure');child.stdin.end();control='';return;}let idx;while((idx=control.indexOf('\n'))>=0){const line=control.slice(0,idx);control=control.slice(idx+1);try{const e=JSON.parse(line);if(e.identity!==identity)continue;if(e.type==='started')emitter.emit('started');else if(e.type==='exit')emitter.emit('exit',e.code);else if(e.type==='failure')emitter.emit('failure');}catch{emitter.emit('failure');child.stdin.end();}}});
  child.stderr.on('data',chunk=>emitter.emit('log',chunk));
  child.on('error',()=>emitter.emit('failure'));child.stdin.on('error',()=>{});
  emitter.once('started',()=>{started=true;});
  child.once('close',code=>{closed=true;if(!stopping&&(!started||code!==0))emitter.emit('failure');emitter.emit('close',code);resolveClose();});
  child.stdin.write(JSON.stringify({...executable,cwd:spec.cwd,env,identity})+'\n');
  emitter.stop=async()=>{
    if(closed)return;
    stopping=true;
    // The pipe refers to this guardian instance. Never signal a remembered PID.
    child.stdin.end();let timer;
    try{await Promise.race([completion,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('stop_unconfirmed')),10000);})]);}finally{clearTimeout(timer);}
  };
  return emitter;
}
