/* Private bounded execution materials, not logs or a second Worktree registry. */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalPath,isInside} from '../lib/safe-path.js';
import {candidateFail,candidatePath,candidateHash} from '../lib/candidate-snapshot.js';
const identity=s=>`${s.dev}:${s.ino}:${s.birthtimeMs}`;
export function createCandidateStore({dataDir,protectedRoots=()=>[]}={}){
  const data=path.resolve(dataDir),root=path.join(data,'candidate-runs');let remembered=null,rootIdentity=null,lock=null,lockId=null;
  function guard(create=false){
    for(let p=data;;p=path.dirname(p)){const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())candidateFail('candidate_storage_unsafe');if(path.dirname(p)===p)break;}
    if(canonicalPath(data)!==data)candidateFail('candidate_storage_unsafe');
    const id=identity(fs.statSync(data));if(remembered&&id!==remembered)candidateFail('candidate_storage_unsafe');remembered=id;
    for(const p of protectedRoots())if(isInside(canonicalPath(p),data))candidateFail('candidate_storage_unsafe');
    if(!fs.existsSync(root)){if(rootIdentity)candidateFail('candidate_storage_unsafe');if(!create)return false;fs.mkdirSync(root,{mode:0o700});}
    const s=fs.lstatSync(root);if(!s.isDirectory()||s.isSymbolicLink()||rootIdentity&&rootIdentity!==identity(s))candidateFail('candidate_storage_unsafe');rootIdentity=identity(s);return true;
  }
  function plain(file,max=24*1024*1024){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>max)candidateFail('candidate_storage_unsafe');return s;}
  function bounded(file){
    const before=plain(file),fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    try{if(identity(fs.fstatSync(fd))!==identity(before))candidateFail('candidate_storage_unsafe');
      const bytes=Buffer.alloc(before.size+1);let length=0;while(length<bytes.length){const n=fs.readSync(fd,bytes,length,bytes.length-length,length);if(!n)break;length+=n;}
      const after=fs.fstatSync(fd);if(length!==before.size||after.mtimeMs!==before.mtimeMs||identity(after)!==identity(before)||identity(plain(file))!==identity(before))candidateFail('candidate_storage_unsafe');
      const text=bytes.subarray(0,length).toString('utf8');if(!Buffer.from(text).equals(bytes.subarray(0,length)))candidateFail('candidate_storage_unsafe');return text;
    }finally{fs.closeSync(fd);}
  }
  function readAll(){
    if(!guard())return[];const names=fs.readdirSync(root).filter(n=>n.endsWith('.json'));
    if(names.length>20)candidateFail('candidate_limit');
    return names.map(n=>{if(!/^[a-f0-9-]{36}\.json$/.test(n))candidateFail('candidate_storage_unsafe');const v=JSON.parse(bounded(path.join(root,n)));
      if(v.version!==1||v.run?.id!==n.slice(0,-5)||!/^[a-f0-9]{64}$/.test(v.run.sourceScope)||!['pending','running','completed','failed','stopped','interrupted'].includes(v.run.state)||!Array.isArray(v.input?.files)||v.input.files.length>512)candidateFail('candidate_storage_unsafe');
      const w=v.run.workspace;if(w&&(!/^[a-f0-9]{24}$/.test(w.repoId)||!(/^[a-f0-9-]{36}$/.test(w.id))||w.path!==path.join(data,'worktrees',w.repoId,w.id)))candidateFail('candidate_storage_unsafe');
      if((v.run.state==='completed'||v.result)&&(!w||!Array.isArray(v.run.rootIdentity)||v.run.rootIdentity.length!==3||!v.run.rootIdentity.every(Number.isFinite)||!/^[a-f0-9]{64}$/.test(v.run.gitIdentity)))candidateFail('candidate_storage_unsafe');
      let total=0;for(const f of v.input.files){candidatePath(f.path);if(typeof f.bytes!=='string'||f.bytes.length>1400000)candidateFail('candidate_storage_unsafe');const bytes=Buffer.from(f.bytes,'base64');total+=bytes.length;
        if(bytes.toString('base64')!==f.bytes||bytes.length>1024*1024||total>8*1024*1024||candidateHash(bytes)!==f.digest)candidateFail('candidate_storage_unsafe');}
      if(v.result&&(!Array.isArray(v.result.files)||v.result.files.length>50))candidateFail('candidate_storage_unsafe');
      for(const f of v.result?.files||[]){candidatePath(f.path);if(f.oldPath)candidatePath(f.oldPath);if(typeof f.patch!=='string'||f.patch.length>24*1024)candidateFail('candidate_storage_unsafe');}
      return{version:1,run:v.run,result:v.result,input:{files:[]}};});
  }
  function acquire(){
    guard(true);if(readAll().length>=20)candidateFail('candidate_limit');
    const file=path.join(root,'writer.lock');try{lock=fs.openSync(file,'wx',0o600);lockId=identity(fs.fstatSync(lock));}catch{candidateFail('candidate_storage_busy');}
  }
  function save(value){
    guard(true);if(lock===null||identity(plain(path.join(root,'writer.lock'),4096))!==lockId)candidateFail('candidate_storage_unsafe');
    const text=JSON.stringify(value);if(Buffer.byteLength(text)>24*1024*1024)candidateFail('candidate_limit');
    const temp=path.join(root,`.${randomUUID()}.tmp`),target=path.join(root,value.run.id+'.json');
    if(fs.existsSync(target))plain(target);
    let fd;try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,text);fs.fsyncSync(fd);fs.closeSync(fd);fd=null;guard();fs.renameSync(temp,target);}finally{if(fd!=null)fs.closeSync(fd);if(fs.existsSync(temp)&&fs.lstatSync(temp).isFile())fs.unlinkSync(temp);}
  }
  function release(){if(lock===null)return;const file=path.join(root,'writer.lock');guard();if(identity(plain(file,4096))!==lockId)candidateFail('candidate_storage_unsafe');fs.closeSync(lock);lock=null;fs.unlinkSync(file);lockId=null;}
  return{readAll,acquire,save,release};
}
