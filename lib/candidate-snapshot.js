/* Bounded raw-byte input and actual before/after comparison. No model calls. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {repository, adminDirectory, worktreeGit} from './git-worktree.js';
import {canonicalPath, isInside} from './safe-path.js';
import {runGit, parseStatusZ} from './git.js';

export const CANDIDATE_LIMITS=Object.freeze({files:512,fileBytes:1024*1024,totalBytes:8*1024*1024,entries:20000});
export const candidateFail=code=>{throw Object.assign(Error(code),{code});};
export const candidateHash=v=>createHash('sha256').update(v).digest('hex');
const fact=s=>[s.dev,s.ino,s.birthtimeMs];
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sensitive=p=>p.split('/').some(n=>/^(\.env(?:\..*)?|\.npmrc|\.git-credentials|\.ssh|auth\.json|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(n));
export function candidatePath(p){
  if(typeof p!=='string'||!p||p.length>512||/[\x00-\x1f\x7f\\:\ufffd]/.test(p)||p.startsWith('/')||p.split('/').some(n=>!n||n==='.'||n==='..'||n.toLowerCase()==='.git'||/[. ]$/.test(n)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(n)))candidateFail('candidate_unsafe');
  if(sensitive(p))candidateFail('candidate_sensitive');
  if(p.split('/').some(n=>n.toLowerCase()==='.gitattributes'))candidateFail('candidate_git_config');
  return p;
}
export function assertCandidateTarget(root,p){
  candidatePath(p);noLinks(root);let dir=root;
  const parts=p.split('/');
  for(let i=0;i<parts.length;i++){
    dir=path.join(dir,parts[i]);let s;try{s=fs.lstatSync(dir);}catch(e){if(e.code==='ENOENT')return;throw e;}
    if(s.isSymbolicLink()||(i<parts.length-1?!s.isDirectory():!s.isFile()||s.nlink!==1))candidateFail('candidate_unsafe');
    if(i<parts.length-1&&fs.existsSync(path.join(dir,'.git')))candidateFail('candidate_unsafe');
  }
}
function noLinks(p){
  for(let current=path.resolve(p);;current=path.dirname(current)){
    const s=fs.lstatSync(current);if(s.isSymbolicLink()||!s.isDirectory())candidateFail('candidate_unsafe');
    if(path.dirname(current)===current)break;
  }
}
function raw(root,p){
  candidatePath(p);const target=path.join(root,p);
  if(!isInside(root,target))candidateFail('candidate_unsafe');
  noLinks(path.dirname(target));
  let s;try{s=fs.lstatSync(target);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)candidateFail('candidate_unsafe');
  if(s.size>CANDIDATE_LIMITS.fileBytes)candidateFail('candidate_limit');
  const fd=fs.openSync(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{
    const opened=fs.fstatSync(fd);if(!same(fact(s),fact(opened)))candidateFail('candidate_changed');
    const bytes=Buffer.alloc(s.size+1);let length=0;
    while(length<bytes.length){const n=fs.readSync(fd,bytes,length,bytes.length-length,length);if(!n)break;length+=n;}
    const end=fs.fstatSync(fd);
    if(length!==s.size||end.size!==s.size||end.mtimeMs!==s.mtimeMs||end.ctimeMs!==s.ctimeMs||!same(fact(s),fact(end)))candidateFail('candidate_changed');
    return{bytes:bytes.subarray(0,length),identity:fact(s),mode:process.platform==='win32'?null:(s.mode&0o111?'100755':'100644')};
  }finally{fs.closeSync(fd);}
}
async function policy(root){
  noLinks(root);const repo=await repository(root);
  if(repo.prefix||canonicalPath(root)!==canonicalPath(repo.root))candidateFail('candidate_unsupported');
  const admin=await adminDirectory(root);noLinks(admin);noLinks(repo.common);
  for(const dir of [admin,repo.common])if(fs.readdirSync(dir).some(n=>n.endsWith('.lock')))candidateFail('candidate_locked');
  const config=await worktreeGit(root,['config','--null','--list']);
  const keys=config.split('\0').map(v=>v.split('\n')[0]);
  if(keys.some(k=>/^extensions\.partialclone/i.test(k))||config.split('\0').some(v=>/^(?:core\.(?:sparsecheckout|splitindex)|remote\..*\.promisor)\n(?:true|1|yes|on)$/i.test(v)))candidateFail('candidate_git_config');
  const head=(await worktreeGit(root,['rev-parse','--verify','HEAD^{commit}'])).trim();
  const tree=await worktreeGit(root,['ls-tree','-r','-z',head]);
  for(const entry of tree.split('\0').filter(Boolean)){
    const [meta,p]=entry.split('\t');candidatePath(p);
    if(!/^100(?:644|755) blob /.test(meta))candidateFail('candidate_unsafe');
  }
  const index=await worktreeGit(root,['ls-files','--stage','-z']);
  const staged=index.split('\0').filter(Boolean).map(v=>{
    const m=/^(100644|100755) ([a-f0-9]{40,64}) 0\t(.+)$/.exec(v);if(!m)candidateFail('candidate_unsafe');
    return{mode:m[1],oid:m[2],path:candidatePath(m[3])};
  });
  const flags=await worktreeGit(root,['ls-files','-v','-z']);
  if(flags.split('\0').some(v=>v&&v[0]!=='H'))candidateFail('candidate_unsupported');
  const names=[...new Set([...tree.split('\0').filter(Boolean).map(v=>v.split('\t')[1]),...staged.map(v=>v.path)])];
  if(names.length>CANDIDATE_LIMITS.files)candidateFail('candidate_limit');
  if(names.length){const attributes=(await worktreeGit(root,['check-attr','--all','-z','--',...names])).split('\0');
    for(let i=1;i<attributes.length;i+=3)if(['filter','working-tree-encoding','diff'].includes(attributes[i])&&!['unspecified','unset'].includes(attributes[i+1]))candidateFail('candidate_git_config');}
  return{root:repo.root,admin,common:repo.common,head,staged,indexDigest:candidateHash(fs.readFileSync(path.join(admin,'index'))),configDigest:candidateHash(config),identity:[fact(fs.statSync(repo.root)),fact(fs.statSync(admin)),fact(fs.statSync(repo.common))]};
}
export async function captureCandidateInput(root,{untracked=[],includeNew=false,checkpoint=()=>{}}={}){
  const context=await policy(root);
  const unknown=(await worktreeGit(root,['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
  const ignored=(await worktreeGit(root,['ls-files','--others','--ignored','--exclude-standard','--directory','-z'])).split('\0').filter(Boolean);
  // Validate paths before deciding unsupported, so links/attributes never hide as untracked.
  const excluded=new Set(ignored.map(v=>v.replace(/\/$/,'')));
  let entries=0;
  function walk(dir,rel=''){
    for(const e of fs.readdirSync(dir,{withFileTypes:true})){
      if(!rel&&e.name==='.git')continue;
      if(++entries>CANDIDATE_LIMITS.entries)candidateFail('candidate_limit');
      const p=rel?rel+'/'+e.name:e.name;
      if(e.isSymbolicLink()||e.name.toLowerCase()==='.git')candidateFail('candidate_unsafe');
      if(excluded.has(p))continue;
      candidatePath(p);if(e.isDirectory())walk(path.join(dir,e.name),p);
    }
  }
  walk(root);
  if(!includeNew&&(!Array.isArray(untracked)||new Set(untracked).size!==untracked.length||!same([...unknown].sort(),[...untracked].sort())))candidateFail('candidate_untracked');
  const paths=[...new Set([...context.staged.map(v=>v.path),...unknown])].sort();
  if(paths.length>CANDIDATE_LIMITS.files)candidateFail('candidate_limit');
  const files=[];let total=0;
  for(const p of paths){const value=raw(root,p);if(!value)continue;
    total+=value.bytes.length;if(total>CANDIDATE_LIMITS.totalBytes)candidateFail('candidate_limit');
    files.push({path:p,bytes:value.bytes,digest:candidateHash(value.bytes),mode:value.mode||context.staged.find(v=>v.path===p)?.mode||'100644',identity:value.identity});
  }
  await checkpoint('captured');
  const status=await worktreeGit(root,['status','--porcelain=v1','-z','--untracked-files=all','--ignored=matching','--ignore-submodules=none']);
  const items=parseStatusZ(status);const confirmed=await policy(root);
  if(!same(context,confirmed))candidateFail('candidate_changed');
  const finalUnknown=(await worktreeGit(root,['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
  const finalIgnored=(await worktreeGit(root,['ls-files','--others','--ignored','--exclude-standard','--directory','-z'])).split('\0').filter(Boolean);
  if(!same(unknown,finalUnknown)||!same(ignored,finalIgnored))candidateFail('candidate_changed');
  const byPath=new Map(files.map(f=>[f.path,f]));
  for(const p of paths){const f=byPath.get(p),current=raw(root,p);if(!f&&!current)continue;
    if(!f||!current||candidateHash(current.bytes)!==f.digest||!same(current.identity,f.identity)||current.mode&&current.mode!==f.mode)candidateFail('candidate_changed');}
  const contentId=candidateHash(JSON.stringify([context.head,context.staged,files.map(f=>[f.path,f.digest,f.mode])]));
  const id=candidateHash(JSON.stringify([contentId,context,status,files.map(f=>f.identity)]));
  return{...context,id,contentId,files,bytes:total,counts:{staged:items.filter(v=>v.x!==' '&&v.x!=='?'&&v.x!=='!').length,working:items.filter(v=>v.y!==' '&&v.y!=='?'&&v.y!=='!').length,untracked:unknown.length,ignored:ignored.length},untracked:unknown};
}
export async function installCandidateInput(input,root){
  const initial=await captureCandidateInput(root);
  if(initial.head!==input.head||initial.common!==input.common)candidateFail('candidate_changed');
  const wanted=new Map(input.files.map(f=>[f.path,f]));
  for(const f of initial.files){if(!wanted.has(f.path)){raw(root,f.path);fs.unlinkSync(path.join(root,f.path));}}
  for(const f of input.files){candidatePath(f.path);const parent=path.dirname(path.join(root,f.path));
    const relative=path.relative(root,parent).split(path.sep).filter(Boolean);let dir=root;
    for(const part of relative){dir=path.join(dir,part);if(!fs.existsSync(dir))fs.mkdirSync(dir);noLinks(dir);}
    if(fs.existsSync(path.join(root,f.path)))raw(root,f.path);
    fs.writeFileSync(path.join(root,f.path),f.bytes,{mode:f.mode==='100755'?0o700:0o600});
    if(process.platform!=='win32')fs.chmodSync(path.join(root,f.path),f.mode==='100755'?0o700:0o600);
  }
  await worktreeGit(root,['read-tree','--empty']);
  const data=Buffer.from(input.staged.map(f=>`${f.mode} ${f.oid}\t${f.path}\0`).join(''));
  await worktreeGit(root,['update-index','-z','--index-info'],{input:data});
  const installed=await captureCandidateInput(root,{includeNew:true});
  if(installed.contentId!==input.contentId)candidateFail('candidate_changed');
  return installed;
}
export async function compareCandidateInput(pre,post){
  const before=new Map(pre.files.map(f=>[f.path,f])),after=new Map(post.files.map(f=>[f.path,f]));
  const deleted=[...before.values()].filter(f=>!after.has(f.path)),added=[...after.values()].filter(f=>!before.has(f.path));
  const renames=new Map();
  for(const b of deleted){const found=added.filter(a=>a.digest===b.digest&&a.mode===b.mode);if(found.length===1&&deleted.filter(d=>d.digest===b.digest).length===1)renames.set(found[0].path,b.path);}
  const paths=[...new Set([...before.keys(),...after.keys()])].sort(),files=[];let budget=64*1024,truncated=false;
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pi-gui-candidate-diff-'));
  const env={...process.env};for(const key of Object.keys(env))if(/^GIT_/i.test(key))delete env[key];Object.assign(env,{GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_PAGER:'cat'});
  try{
    for(const p of paths){const oldPath=renames.get(p),b=before.get(oldPath||p),a=after.get(p);
      if([...renames.values()].includes(p))continue;
      if(a&&b&&a.digest===b.digest&&a.mode===b.mode&&!oldPath)continue;
      if(files.length>=50){truncated=true;break;}
      fs.writeFileSync(path.join(temp,'before'),b?.bytes||Buffer.alloc(0));fs.writeFileSync(path.join(temp,'after'),a?.bytes||Buffer.alloc(0));
      const args=['-c','core.attributesFile=/dev/null','diff','--no-index','--no-ext-diff','--no-textconv','--no-color'];
      const result=await runGit(temp,[...args,'--','before','after'],{okCodes:[0,1],maxBytes:2*1024*1024,env});
      const stat=await runGit(temp,[...args,'--numstat','--','before','after'],{okCodes:[0,1],env});
      if(!result.ok||!stat.ok)candidateFail('candidate_diff_failed');
      const numbers=stat.stdout.split('\t'),binary=numbers[0]==='-'||[a,b].some(f=>f&&(f.bytes.includes(0)||!Buffer.from(f.bytes.toString('utf8')).equals(f.bytes)));
      const offset=result.stdout.indexOf('@@');const header=`diff --git a/${oldPath||p} b/${p}\n${!b?'new file mode '+a.mode+'\n':!a?'deleted file mode '+b.mode+'\n':a.mode!==b.mode?'old mode '+b.mode+'\nnew mode '+a.mode+'\n':''}${oldPath?'similarity index 100%\nrename from '+oldPath+'\nrename to '+p+'\n':''}--- ${b?'a/'+(oldPath||p):'/dev/null'}\n+++ ${a?'b/'+p:'/dev/null'}\n`;
      const rawPatch=binary?'':header+(offset>=0?result.stdout.slice(offset):'');
      const limit=Math.min(24*1024,budget),patch=rawPatch.slice(0,limit),cut=patch.length<rawPatch.length;budget-=patch.length;truncated||=cut;
      files.push({path:p,oldPath:oldPath||null,change:oldPath?'renamed':!b?'added':!a?'deleted':'modified',binary,patch,truncated:cut,additions:binary?null:Number(numbers[0]||0),deletions:binary?null:Number(numbers[1]||0)});
    }
  }finally{const rel=path.relative(os.tmpdir(),temp);if(!rel||rel.startsWith('..')||path.isAbsolute(rel))candidateFail('candidate_unsafe');fs.rmSync(temp,{recursive:true,force:true});}
  return{files,truncated,inputId:pre.contentId,outputId:post.contentId};
}
