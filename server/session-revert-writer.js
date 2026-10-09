import nativeFs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as nativeMetadata from './session-revert-metadata.js';

const fail=code=>{throw Object.assign(Error(code),{code});};
const digest=bytes=>bytes===null?null:createHash('sha256').update(bytes).digest('hex');
const stable=value=>JSON.stringify(value);
export const metadataEquivalent=(a,b)=>stable(a)===stable(b);
const identity=s=>[s.dev,s.ino,s.birthtimeMs,s.mode].join(':');
const fileIdentity=s=>[identity(s),s.size,s.mtimeMs,s.ctimeMs,s.nlink].join(':');
function target(root,relative) {
  if(typeof root!=='string'||!path.isAbsolute(root)||typeof relative!=='string'||!relative||/[\x00-\x1f\x7f:]/.test(relative)||path.isAbsolute(relative))fail('unsupported_path');
  const parts=relative.replaceAll('\\','/').split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||['.git','.pi'].includes(p.toLowerCase())||/^\.env(?:\.|$)/i.test(p)||/\.(?:pem|key|p12|pfx)$/i.test(p)))fail('unsupported_path');
  return path.resolve(root,...parts);
}
/** Limited writer: repeated reads are not OS exclusion. Unobserved D can be lost. */
export function createSessionRevertWriter({metadata=nativeMetadata,fs=nativeFs,hooks={},fileBytes=2*1024**2}={}) {
  async function ensureRecoveryRoot(root, privateRoot) {
    if(typeof privateRoot!=='string'||!path.isAbsolute(privateRoot))fail('recovery_storage_unavailable');
    const recoveryRoot=path.resolve(privateRoot);
    const inside=path.relative(path.resolve(root),recoveryRoot);
    if(!inside||(!inside.startsWith('..'+path.sep)&&inside!=='..'&&!path.isAbsolute(inside)))fail('recovery_storage_unavailable');
    await parents(root,recoveryRoot);
    let initialize=false;
    try{await fs.mkdir(recoveryRoot,{mode:0o700});initialize=true;}catch(e){if(e.code!=='EEXIST')throw e;}
    const stat=await fs.lstat(recoveryRoot);if(!stat.isDirectory()||stat.isSymbolicLink())fail('recovery_storage_unavailable');
    await (metadata.protectRecoveryPath||nativeMetadata.protectRecoveryPath)(recoveryRoot,{initialize,directory:true});
    if(identity(await fs.lstat(recoveryRoot))!==identity(stat))fail('recovery_storage_unavailable');
    return recoveryRoot;
  }
  async function parents(root,absolute) {
    const ids=[];let p=path.dirname(absolute);
    // Include ancestors above the workspace as well: a junction containing an
    // otherwise ordinary workspace is still outside the supported path profile.
    while(true){const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink())fail('unsupported_path');ids.push([p,identity(s)]);const next=path.dirname(p);if(next===p)break;p=next;}
    return stable(ids);
  }
  async function inspect(root,relativePath) {
    const absolute=target(root,relativePath), parentIdentity=await parents(root,absolute);
    let stat;try{stat=await fs.lstat(absolute);}catch(e){if(e.code!=='ENOENT')throw e;return {bytes:null,metadata:null,parentIdentity,fingerprint:'absent:'+parentIdentity};}
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('unsupported_path');if(stat.size>fileBytes)fail('oversized');
    const h=await fs.open(absolute,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    let bytes;
    try{
      if(fileIdentity(await h.stat())!==fileIdentity(stat))fail('stale_current');
      const b=Buffer.alloc(stat.size+1);let offset=0;
      while(offset<b.length){const {bytesRead}=await h.read(b,offset,b.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
      if(offset!==stat.size||fileIdentity(await h.stat())!==fileIdentity(stat)||fileIdentity(await fs.lstat(absolute))!==fileIdentity(stat))fail('stale_current');bytes=b.subarray(0,offset);
    }finally{await h.close();}
    const meta=await metadata.inspectFileMetadata(absolute);
    if(await parents(root,absolute)!==parentIdentity||fileIdentity(await fs.lstat(absolute))!==fileIdentity(stat))fail('stale_current');
    return {bytes,metadata:meta,parentIdentity,fingerprint:fileIdentity(stat)+':'+parentIdentity+':'+digest(bytes)};
  }
  async function apply(args) {
    const {root,relativePath,currentFingerprint,currentMetadata,candidate,backupVerified,recordState,stateCheck}=args;
    let recoveryRoot=args.recoveryRoot,recoveryMetadata=null;
    if(backupVerified!==true)fail('backup_unverified');
    if(typeof recordState!=='function'||typeof stateCheck!=='function')fail('writer_state_unavailable');
    if(candidate!==null&&(!Buffer.isBuffer(candidate)||candidate.length>fileBytes))fail('writer_candidate_invalid');
    const restore=args.action==='restore_moved';
    if(!(restore?args.restoredMetadata:currentMetadata)?.supported)fail('metadata_unsupported');
    const absolute=target(root,relativePath);let stage=null,stageIdentity=null,mutating=false,recoveryPath=null,restoreFingerprint=null,recoveryParentIdentity=null;
    const check=async()=>{const c=await inspect(root,relativePath);if(c.fingerprint!==currentFingerprint||stable(c.metadata)!==stable(currentMetadata))fail('stale_current');await stateCheck();return c;};
    const cleanup=async()=>{if(stage&&stageIdentity){try{const s=await fs.lstat(stage);if(identity(s)===stageIdentity)await fs.unlink(stage);}catch{}}};
    try {
      const initial=await check();
      if(restore){
        if(initial.bytes!==null||!args.recoveryPath||!recoveryRoot||args.recoveryRootVerified!==true)fail('recovery_storage_unavailable');
        const rel=path.relative(path.resolve(recoveryRoot),path.resolve(args.recoveryPath));
        if(!rel||rel.startsWith('..')||path.isAbsolute(rel))fail('recovery_storage_unavailable');
        const source=await inspect(recoveryRoot,rel);
        if(source.bytes===null||!Buffer.isBuffer(candidate)||digest(source.bytes)!==digest(candidate)||stable(source.metadata)!==stable(args.recoveryMetadata||args.restoredMetadata))fail('stale_current');
        const sourceStat=await fs.lstat(args.recoveryPath),destStat=await fs.lstat(path.dirname(absolute));
        if(sourceStat.dev!==destStat.dev)fail('recovery_volume_unsupported');
        recoveryPath=args.recoveryPath;
        restoreFingerprint=source.fingerprint;
      }else if(candidate!==null){
        stage=path.join(path.dirname(absolute),'.pi-revert-'+randomUUID()+'.tmp');
        const h=await fs.open(stage,'wx',0o600);
        try{
          stageIdentity=identity(await h.stat());
          // Windows creation modes do not install a private DACL. Install the
          // captured descriptor before putting candidate contents into the file.
          await metadata.preserveFileMetadata(stage,currentMetadata);
          stageIdentity=identity(await h.stat());
          await h.writeFile(candidate);await h.sync();
        }finally{await h.close();}
        // Writing can set Archive; restore the observed attribute profile too.
        await metadata.preserveFileMetadata(stage,currentMetadata);
        const synced=await fs.open(stage,'r+');try{await synced.sync();}finally{await synced.close();}
        if(stable(await metadata.inspectFileMetadata(stage))!==stable(currentMetadata))fail('metadata_validation_failed');
        stageIdentity=identity(await fs.lstat(stage));
      }else{
        // Caller supplies an already ACL-verified private same-volume recovery root.
        if(!recoveryRoot)recoveryRoot=await ensureRecoveryRoot(root);
        else if(args.recoveryRootVerified!==true)fail('recovery_storage_unavailable');
        const source=await fs.lstat(absolute), dest=await fs.lstat(recoveryRoot);
        if(!dest.isDirectory()||dest.isSymbolicLink()||source.dev!==dest.dev)fail('recovery_volume_unsupported');
        const sub=await fs.mkdtemp(path.join(recoveryRoot,'move-'));recoveryPath=path.join(sub,'object');
        recoveryParentIdentity=await parents(recoveryRoot,recoveryPath);
        await hooks.afterRecoveryPrepared?.(recoveryPath);
      }
      await hooks.afterStage?.();
      const before=await check();
      if(candidate===null&&!restore){try{await fs.lstat(recoveryPath);fail('recovery_destination_exists');}catch(e){if(e.code!=='ENOENT')throw e;}}
      if(stage){const staged=await inspect(path.dirname(stage),path.basename(stage));if(identity(await fs.lstat(stage))!==stageIdentity||digest(staged.bytes)!==digest(candidate)||stable(staged.metadata)!==stable(currentMetadata))fail('stale_current');}
      await recordState(candidate===null||restore?'moving':'replacing',{recoveryPath});
      await check();
      if(restore){const source=await inspect(recoveryRoot,path.relative(recoveryRoot,recoveryPath));if(source.fingerprint!==restoreFingerprint)fail('stale_current');}
      if(candidate===null){
        if(await parents(recoveryRoot,recoveryPath)!==recoveryParentIdentity)fail('stale_current');
        await (metadata.protectRecoveryPath||nativeMetadata.protectRecoveryPath)(recoveryRoot,{initialize:false,directory:true});
      }
      // This hook models the unavoidable last-read-to-rename window explicitly.
      await hooks.afterFinalCheckBeforeCommit?.();
      mutating=true;
      if(restore)await (metadata.moveFileNoReplace||nativeMetadata.moveFileNoReplace)(recoveryPath,absolute);
      else if(candidate===null)await (metadata.moveFileNoReplace||nativeMetadata.moveFileNoReplace)(absolute,recoveryPath);
      else await fs.rename(stage,absolute);
      stage=null;
      await hooks.afterRename?.();
      let observed;
      if(candidate===null){
        observed=await inspect(path.dirname(recoveryPath),path.basename(recoveryPath));
        const missing=await inspect(root,relativePath);
        if(missing.bytes!==null||missing.parentIdentity!==before.parentIdentity||digest(observed.bytes)!==digest(before.bytes)||stable(observed.metadata)!==stable(currentMetadata))fail('post_verification_failed');
        await (metadata.protectRecoveryPath||nativeMetadata.protectRecoveryPath)(recoveryPath,{initialize:true,directory:false});
        observed=await inspect(path.dirname(recoveryPath),path.basename(recoveryPath));
        if(digest(observed.bytes)!==digest(before.bytes)||!observed.metadata?.supported)fail('post_verification_failed');
        recoveryMetadata=observed.metadata;
      }else{
        if(restore)await metadata.preserveFileMetadata(absolute,args.restoredMetadata);
        observed=await inspect(root,relativePath);
        if(digest(observed.bytes)!==digest(candidate)||stable(observed.metadata)!==stable(restore?args.restoredMetadata:currentMetadata)||observed.parentIdentity!==before.parentIdentity)fail('post_verification_failed');
        if(restore){try{await fs.lstat(recoveryPath);fail('post_verification_failed');}catch(e){if(e.code!=='ENOENT')throw e;}}
      }
      await recordState('applied_verified',{digest:digest(observed.bytes),recoveryPath,recoveryMetadata});
      return {status:'applied_confirmed_limited',digest:digest(candidate),observedDigest:digest(observed.bytes),recoveryPath,recoveryMetadata,exclusive:false,residualRacePossible:true};
    } catch(e){
      if(mutating){e.code='recovery_required';e.recoveryPath=recoveryPath;e.residualRacePossible=true;}
      else await cleanup();
      throw e;
    }
  }
  return {inspect,apply,ensureRecoveryRoot,capabilities:{exclusive:false,residualRacePossible:true,directoryFsync:false,powerLossAtomic:false}};
}
