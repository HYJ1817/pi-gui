const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync}=require('node:child_process');
(async () => {
  const { createSessionRevertWriter } = await import('../server/session-revert-writer.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-revert-writer-'));
  let count = 0;
  const check = async (name, fn) => { await fn(); count++; console.log('ok', name); };
  const profile = { supported:true, version:1, platform:'win32', volume:'fixture-volume', acl:'fixture', attributes:32, streams:[] };
  const adapter = { inspectFileMetadata:async () => ({...profile}), preserveFileMetadata:async () => {} };
  const writer = createSessionRevertWriter({metadata:adapter});
  try {
    await fs.writeFile(path.join(root,'a.txt'),'C');
    const current = await writer.inspect(root,'a.txt');
    const args = {root, relativePath:'a.txt', currentFingerprint:current.fingerprint, currentMetadata:current.metadata,
      candidate:Buffer.from('R'), action:'replace', backupVerified:true, stateCheck:async () => {}, recordState:async () => {}};
    await check('backup mandatory', async () => { await assert.rejects(writer.apply({...args,backupVerified:false}), {code:'backup_unverified'}); assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'C'); });
    await check('stale content untouched', async () => { await fs.writeFile(path.join(root,'a.txt'),'D'); await assert.rejects(writer.apply(args), {code:'stale_current'}); assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'D'); });
    await fs.writeFile(path.join(root,'a.txt'),'C');
    args.currentFingerprint=(await writer.inspect(root,'a.txt')).fingerprint;
    await check('fixture metadata replace and durable ordering', async () => {const states=[]; const r=await writer.apply({...args,recordState:async s=>states.push(s)}); assert.equal(r.status,'applied_confirmed_limited'); assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'R'); assert.deepEqual(states,['replacing','applied_verified']); assert.equal(r.residualRacePossible,true);});
    const reset=async()=>{await fs.writeFile(path.join(root,'a.txt'),'C');return {...args,currentFingerprint:(await writer.inspect(root,'a.txt')).fingerprint};};
    await check('unsupported metadata refuses before write',async()=>{const a=await reset();await assert.rejects(writer.apply({...a,currentMetadata:{supported:false}}),{code:'metadata_unsupported'});assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'C');});
    await check('state authority failure leaves C',async()=>{const a=await reset();await assert.rejects(writer.apply({...a,stateCheck:async()=>{throw Object.assign(Error('stale_evidence'),{code:'stale_evidence'});}}),{code:'stale_evidence'});assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'C');});
    await check('durable journal failure leaves C',async()=>{const a=await reset();await assert.rejects(writer.apply({...a,recordState:async()=>{throw Object.assign(Error('disk'),{code:'EIO'});}}),{code:'EIO'});assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'C');});
    await check('metadata copy failure leaves C',async()=>{const a=await reset();const bad=createSessionRevertWriter({metadata:{...adapter,preserveFileMetadata:async()=>{throw Object.assign(Error('acl'),{code:'ACL_FAIL'});}}});await assert.rejects(bad.apply(a),{code:'ACL_FAIL'});assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'C');});
    await check('staging digest rechecked',async()=>{const a=await reset();const bad=createSessionRevertWriter({metadata:adapter,hooks:{afterStage:async()=>{for(const f of await fs.readdir(root))if(f.startsWith('.pi-revert-'))await fs.writeFile(path.join(root,f),'bad');}}});await assert.rejects(bad.apply(a),{code:'stale_current'});assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'C');});
    await check('rename failure no unlink fallback',async()=>{const a=await reset();let unlinks=0;const bad=createSessionRevertWriter({metadata:adapter,fs:{...fs,rename:async()=>{throw Error('rename fail');},unlink:async()=>{unlinks++;}}});await assert.rejects(bad.apply(a),{code:'recovery_required'});assert.equal(unlinks,0);assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'C');});
    await check('post-write journal failure recovery required',async()=>{const a=await reset();await assert.rejects(writer.apply({...a,recordState:async s=>{if(s==='applied_verified')throw Error('disk');}}),{code:'recovery_required'});assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'R');});
    await check('independent child final-window D lost and absent from C backup',async()=>{const a=await reset();const cBackup=Buffer.from('C');const racer=createSessionRevertWriter({metadata:adapter,hooks:{afterFinalCheckBeforeCommit:async()=>execFileSync(process.execPath,['-e',"require('fs').writeFileSync(process.argv[1],'D')",path.join(root,'a.txt')])}});const result=await racer.apply(a);assert.equal(result.residualRacePossible,true);assert.equal(result.exclusive,false);assert.equal(cBackup.toString(),'C');assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'R');});
    await check('post verification detects unrelated D and preserves D',async()=>{const a=await reset();const racer=createSessionRevertWriter({metadata:adapter,hooks:{afterRename:async()=>fs.writeFile(path.join(root,'a.txt'),'D')}});await assert.rejects(racer.apply(a),{code:'recovery_required'});assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'D');});
    await check('path traversal rejected',async()=>{await assert.rejects(writer.inspect(root,'../outside'),{code:'unsupported_path'});});
    await check('hardlinks rejected',async()=>{await fs.link(path.join(root,'a.txt'),path.join(root,'linked'));try{await assert.rejects(writer.inspect(root,'a.txt'),{code:'unsupported_path'});}finally{await fs.unlink(path.join(root,'linked'));}});
    const privateRoot=path.join(root,'private');await fs.mkdir(privateRoot);
    const movingAdapter={...adapter,protectRecoveryPath:async()=>{},moveFileNoReplace:async(source,dest)=>{try{await fs.lstat(dest);throw Object.assign(Error('exists'),{code:'EEXIST'});}catch(e){if(e.code!=='ENOENT')throw e;}await fs.rename(source,dest);}};
    const mover=createSessionRevertWriter({metadata:movingAdapter});let moved;
    await check('fixture move preserves object instead of unlink',async()=>{const a=await reset();moved=await mover.apply({...a,candidate:null,recoveryRoot:privateRoot,recoveryRootVerified:true});assert.equal((await mover.inspect(root,'a.txt')).bytes,null);assert.equal(await fs.readFile(moved.recoveryPath,'utf8'),'C');});
    await check('fixture moved restore',async()=>{const absent=await mover.inspect(root,'a.txt');const result=await mover.apply({...args,...absent,currentFingerprint:absent.fingerprint,currentMetadata:null,action:'restore_moved',candidate:Buffer.from('C'),restoredMetadata:profile,recoveryMetadata:moved.recoveryMetadata,recoveryRoot:privateRoot,recoveryRootVerified:true,recoveryPath:moved.recoveryPath});assert.equal(result.status,'applied_confirmed_limited');assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'C');});
    await check('native metadata is fail closed or fully observed',async()=>{const {inspectFileMetadata}=await import('../server/session-revert-metadata.js');const result=await inspectFileMetadata(path.join(root,'a.txt'));assert.equal(typeof result.supported,'boolean');if(result.supported){assert.equal(result.profile,'windows-local-ntfs-v1');assert.equal(typeof result.acl,'string');}else assert.equal(typeof result.reason,'string');console.log('native profile:',result.supported?'supported':result.reason);});
    if(process.platform==='win32'){
      const {inspectFileMetadata,protectRecoveryPath,moveFileNoReplace}=await import('../server/session-revert-metadata.js');
      await check('native private recovery directory ACL verifies',async()=>{const dir=path.join(root,'native-private');await fs.mkdir(dir);await protectRecoveryPath(dir,{initialize:true});await protectRecoveryPath(dir);});
      await check('native ADS refuses',async()=>{await fs.writeFile(path.join(root,'a.txt:extra'),'secret');try{assert.equal((await inspectFileMetadata(path.join(root,'a.txt'))).reason,'metadata_streams_unsupported');}finally{await fs.unlink(path.join(root,'a.txt:extra'));}});
      await check('native readonly refuses',async()=>{const p=path.join(root,'readonly');await fs.writeFile(p,'C');await fs.chmod(p,0o444);try{assert.equal((await inspectFileMetadata(p)).reason,'metadata_attributes_unsupported');}finally{await fs.chmod(p,0o666);}});
      await check('native no-replace move refuses existing destination',async()=>{const from=path.join(root,'native-source'),to=path.join(root,'native-dest');await fs.writeFile(from,'C');await fs.writeFile(to,'D');await assert.rejects(moveFileNoReplace(from,to),{code:'restore_move_failed'});assert.equal(await fs.readFile(from,'utf8'),'C');assert.equal(await fs.readFile(to,'utf8'),'D');});
      await check('native no-replace move succeeds for absent destination',async()=>{const from=path.join(root,'native-source'),to=path.join(root,'native-absent');await moveFileNoReplace(from,to);assert.equal(await fs.readFile(to,'utf8'),'C');await assert.rejects(fs.stat(from),{code:'ENOENT'});});
    }
  } finally { await fs.rm(root,{recursive:true,force:true}); }
  console.log(`session-revert-writer: ${count}/${count}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
