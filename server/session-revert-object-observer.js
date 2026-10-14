import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { OBJECT_HELPER_HASH, loadObjectHelper, resolveObjectInterpreter } from './session-revert-object-resources.js';
import { OBJECT_PROFILE_ID, objectScopeBinding, normalizeObjectObservation } from './session-revert-object-profile.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
export async function observeFileObject({root,relativePath,scope,operationId,expectedDigest}={}){
 const binding=objectScopeBinding(scope);
 if(typeof root!=='string'||!path.isAbsolute(root)||root.startsWith('\\\\')||typeof relativePath!=='string'||relativePath.length>4096||path.isAbsolute(relativePath)||/[\x00-\x1f\x7f:]/.test(relativePath)||relativePath.replaceAll('\\','/').split('/').some(p=>!p||p==='.'||p==='..'||['.git','.pi'].includes(p.toLowerCase())))throw Object.assign(Error('unsupported_path'),{code:'unsupported_path'});
 if(!binding||typeof operationId!=='string'||!/^[a-zA-Z0-9_-]{1,256}$/.test(operationId))throw Object.assign(Error('invalid_evidence_scope'),{code:'invalid_evidence_scope'});
 const relative=relativePath.replaceAll('\\','/'),pathHash=hash(relative);
 const base={version:1,profileId:OBJECT_PROFILE_ID,source:{kind:'win32-observe',helperVersion:1,helperHash:OBJECT_HELPER_HASH},binding:{scope:binding,operationId,relativePathHash:pathHash}};
 const unavailable=()=>({...base,status:'unavailable',reason:'object_observation_unavailable',nonAtomic:true});
 if(process.platform!=='win32')return unavailable();
 let helper,interpreter;try{helper=loadObjectHelper('observer');interpreter=await resolveObjectInterpreter();}catch{return unavailable();}
 const script=helper.bytes.toString('utf8'),env={...process.env};for(const k of Object.keys(env))if(k.toLowerCase()==='psmodulepath')delete env[k];
 const result=await new Promise(resolve=>{
  const child=spawn(interpreter,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,cwd:path.dirname(interpreter),shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let chunks=[],length=0,done=false;const timer=setTimeout(()=>{child.kill();finish(null);},30000);timer.unref?.();
  const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
  child.stdout.on('data',b=>{length+=b.length;if(length>65536){child.kill();finish(null);}else chunks.push(b);});child.stderr.resume();child.on('error',()=>finish(null));child.stdin.on('error',()=>{});
  child.on('close',code=>{if(code!==0)return finish(null);try{finish(JSON.parse(Buffer.concat(chunks).toString('utf8').trim()));}catch{finish(null);}});
  // Windows PowerShell's redirected Console.In may use the legacy code page.
  // ASCII JSON preserves all UTF-16 path characters without changing encodings.
  const request=JSON.stringify({mode:'observe',root,relativePath:relative}).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
  child.stdin.end(request);
 });
 if(!result||result.status!=='observed')return unavailable();
 if(expectedDigest!==undefined&&result.file?.digest!==expectedDigest)return unavailable();
 try{return normalizeObjectObservation({...base,...result,path:{...result.path,relativePathHash:pathHash}});}catch{return unavailable();}
}
