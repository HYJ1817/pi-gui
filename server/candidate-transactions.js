/* Append-only recovery materials. Unknown/corrupt records are never overwritten. */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {candidateFail,candidateHash} from '../lib/candidate-snapshot.js';
const idPattern=/^[a-f0-9-]{36}$/;
const identity=s=>[s.dev,s.ino,s.birthtimeNs].map(String).join(':');
export function createCandidateTransactions({dataDir,protectedRoots=()=>[]}={}){
 const data=path.resolve(dataDir),root=path.join(data,'candidate-transactions'),seen=new Map(),executionName='execute.lock';let execution=null;
 function directory(p,create=false){
  if(create&&!fs.existsSync(p)){directory(path.dirname(p));fs.mkdirSync(p,{mode:0o700});}
  for(let at=p;;at=path.dirname(at)){const s=fs.lstatSync(at,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink())candidateFail('candidate_storage_unsafe');const previous=seen.get(at),current=identity(s);if(previous&&previous!==current)candidateFail('candidate_storage_unsafe');seen.set(at,current);if(path.dirname(at)===at)break;}
  if(fs.realpathSync.native(p)!==p)candidateFail('candidate_storage_unsafe');
 }
 function guard(create=false){directory(data);for(const p of protectedRoots()){const rel=path.relative(path.resolve(p),root);if(rel===''||!rel.startsWith('..')&&!path.isAbsolute(rel))candidateFail('candidate_storage_unsafe');}if(!fs.existsSync(root)){if(!create)return false;directory(root,true);}else directory(root);return true;}
 function lockIdentity(){const file=path.join(root,executionName);try{const s=fs.lstatSync(file,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||s.size>4096n)candidateFail('candidate_storage_unsafe');return identity(s);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 function acquire(){
  if(execution)candidateFail('candidate_storage_busy');guard(true);
  const file=path.join(root,executionName);let fd=null,id=null;
  try{fd=fs.openSync(file,'wx',0o600);id=identity(fs.fstatSync(fd,{bigint:true}));fs.writeFileSync(fd,JSON.stringify({version:1,token:randomUUID()}));fs.fsyncSync(fd);if(lockIdentity()!==id)candidateFail('candidate_storage_unsafe');}
  catch(e){if(fd!==null)try{fs.closeSync(fd);}catch{}if(e.code==='EEXIST')candidateFail('candidate_storage_busy');throw e;}
  const lease={file,id,released:false};execution=lease;
  return Object.freeze({release(){if(lease.released)return;if(execution!==lease||lockIdentity()!==lease.id)candidateFail('candidate_storage_unsafe');fs.closeSync(fd);lease.released=true;if(lockIdentity()!==lease.id)candidateFail('candidate_storage_unsafe');fs.unlinkSync(file);if(lockIdentity()!==null)candidateFail('candidate_storage_unsafe');execution=null;}});
 }
 function location(id){if(!idPattern.test(id))candidateFail('candidate_invalid');guard();const p=path.join(root,id);directory(p);return p;}
 function readFile(p){const before=fs.lstatSync(p,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>25000000n)candidateFail('candidate_storage_unsafe');const fd=fs.openSync(p,'r');try{if(identity(fs.fstatSync(fd,{bigint:true}))!==identity(before))candidateFail('candidate_storage_unsafe');const b=fs.readFileSync(fd),after=fs.fstatSync(fd,{bigint:true});if(b.length!==Number(before.size)||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs||identity(fs.lstatSync(p,{bigint:true}))!==identity(before))candidateFail('candidate_storage_unsafe');return b;}finally{fs.closeSync(fd);}}
 function read(id){
  const p=location(id),names=fs.readdirSync(p).filter(n=>n.endsWith('.json')).sort();if(!names.length||names.length>4096||names.some((n,i)=>n!==String(i).padStart(6,'0')+'.json'))candidateFail('candidate_storage_unsafe');
  let previous=null,base=null,latest=null;const events=[];
  try{for(const [seq,name]of names.entries()){const raw=readFile(path.join(p,name)),row=JSON.parse(raw.toString('utf8')),{digest,...value}=row;if(Buffer.from(raw.toString('utf8')).compare(raw)||value.version!==1||value.id!==id||value.seq!==seq||value.previous!==previous||candidateHash(JSON.stringify(value))!==digest)candidateFail('candidate_storage_unsafe');if(seq===0)base=value.event;latest=value.event;events.push(latest);previous=digest;}}
  catch{candidateFail('candidate_storage_unsafe');}
  if(!base?.binding||!base.plan||!Array.isArray(base.files)||base.files.length>512||typeof latest?.state!=='string')candidateFail('candidate_storage_unsafe');
  return{id,directory:p,...base,state:latest.state,events,revision:names.length,digest:previous};
 }
 function write(id,seq,previous,event){const p=location(id),value={version:1,id,seq,previous,event},text=JSON.stringify({...value,digest:candidateHash(JSON.stringify(value))});if(Buffer.byteLength(text)>24000000)candidateFail('candidate_limit');const file=path.join(p,String(seq).padStart(6,'0')+'.json'),fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(readFile(file).toString('utf8')!==text)candidateFail('candidate_storage_unsafe');return read(id);}
 function list(){
  if(!guard())return[];
  const all=fs.readdirSync(root),foreign=all.includes(executionName)&&(!execution||lockIdentity()!==execution.id);
  const names=all.filter(n=>n!=='active.lock'&&n!==executionName);
  if(names.length>100||names.some(n=>!idPattern.test(n)))candidateFail('candidate_storage_unsafe');
  const transactions=names.map(read).sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
  if(foreign)candidateFail('candidate_storage_busy');
  return transactions;
 }
 function create({binding,plan,files}){if(!execution)candidateFail('candidate_storage_busy');guard(true);if(list().length>=100)candidateFail('candidate_limit');const id=randomUUID();directory(path.join(root,id),true);return write(id,0,null,{state:'prepared',createdAt:Date.now(),binding,plan,files});}
 function append(id,event){if(!execution)candidateFail('candidate_storage_busy');const old=read(id);return write(id,old.revision,old.digest,event);}
 return{acquire,list,read,create,append,locked:()=>execution!==null};
}
