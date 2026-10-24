/* Backend-only fixed native protocol; no renderer paths, shell or fallback writer. */
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {readAsset,hasBundledAssets} from '../lib/assets.js';
import {resolveObjectInterpreter} from './session-revert-object-resources.js';
import {candidatePath,candidateHash,candidateFail,CANDIDATE_LIMITS} from '../lib/candidate-snapshot.js';
const encode=o=>JSON.stringify(o).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))+'\n';
export async function openCandidateWriter({root,recovery,files,pins=[],gate=path.join(path.dirname(recovery),'active.lock')}){
 if(process.platform!=='win32')candidateFail('candidate_platform_unsupported');
 if(!path.isAbsolute(root)||!path.isAbsolute(recovery)||!path.isAbsolute(gate)||!Array.isArray(files)||files.length>512||pins.length>2048)candidateFail('candidate_unsafe');
 let total=0;for(const f of files){candidatePath(f.path);if(f.identity!==null&&!/^\d+$/.test(f.identity)||f.before!==null&&!/^[a-f0-9]{64}$/.test(f.before)||f.after!==null&&!/^[a-f0-9]{64}$/.test(f.after))candidateFail('candidate_unsafe');if(f.bytes!==null){const b=Buffer.from(f.bytes,'base64');total+=b.length;if(b.toString('base64')!==f.bytes||b.length>CANDIDATE_LIMITS.fileBytes||candidateHash(b)!==f.after)candidateFail('candidate_unsafe');}}
 if(total>CANDIDATE_LIMITS.totalBytes)candidateFail('candidate_limit');
 const helper=readAsset(hasBundledAssets()?'candidate/write.ps1':'server/candidate-write-native.ps1');
 const hash=candidateHash(helper),interpreter=await resolveObjectInterpreter(),token=randomBytes(32).toString('hex');
 const bootstrap=`$ErrorActionPreference='Stop';$s=[Console]::In.ReadLine();if($s.Length -gt 65536){exit 2};$b=[Convert]::FromBase64String($s);if([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)).Replace('-','').ToLowerInvariant() -cne '${hash}'){exit 2};& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($b)))`;
 const env={...process.env};for(const k of Object.keys(env))if(k.toLowerCase()==='psmodulepath')delete env[k];
 const child=spawn(interpreter,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(bootstrap,'utf16le').toString('base64')],{env,cwd:path.dirname(interpreter),shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let pending=null,buffer='',received=0,closed=false;const error=()=>Object.assign(Error('candidate_native_refused'),{code:'candidate_native_refused'});
 const reject=()=>{closed=true;if(pending){clearTimeout(pending.timer);pending.reject(error());pending=null;}};
 child.on('error',reject);child.on('close',reject);child.stdin.on('error',reject);child.stderr.resume();
 child.stdout.on('data',b=>{received+=b.length;if(received>1024*1024){reject();child.kill();return;}buffer+=b.toString('utf8');while(buffer.includes('\n')){const n=buffer.indexOf('\n'),line=buffer.slice(0,n);buffer=buffer.slice(n+1);let row;try{row=JSON.parse(line);}catch{reject();child.kill();return;}const p=pending;pending=null;if(!p||row.token!==token){reject();child.kill();return;}clearTimeout(p.timer);if(row.ok===true)p.resolve(row.value);else p.reject(error());}});
 function receive(){if(closed||pending)return Promise.reject(error());return new Promise((resolve,rejectWait)=>{const timer=setTimeout(()=>{reject();child.kill();},45000);timer.unref?.();pending={resolve,reject:rejectWait,timer};});}
 const ready=receive();child.stdin.write(helper.toString('base64')+'\n'+encode({version:1,token,root,recovery,gate,files,pins}));
 try{await ready;}catch(e){const ended=child.exitCode!==null?Promise.resolve():new Promise(resolve=>child.once('close',resolve));child.stdin.end();child.kill();await ended;throw e;}
 return Object.freeze({async apply(index){const reply=receive();if(!closed)child.stdin.write(encode({token,command:'apply',index}));return reply;},async close(){if(closed)return;closed=true;const ended=new Promise(resolve=>child.once('close',resolve));child.stdin.end(encode({token,command:'close'}));const timer=setTimeout(()=>child.kill(),3000);timer.unref?.();await ended;clearTimeout(timer);}});
}
