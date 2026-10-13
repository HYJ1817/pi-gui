const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const h=require('./fixtures/session-revert-object-harness.cjs'),old=require('./session-revert-inplace.cjs');
let passed=0;const check=async(name,fn)=>{try{await fn();passed++;console.log('ok '+name);}catch(e){console.error('failed case '+name);throw e;}};
const C=Buffer.from('CCCCCCCC'),R=Buffer.from('RRRR');
// Fault adapter changes only reviewed API boundaries in memory, never the
// distributed helper, command schema or a production environment variable.
async function injected(name){let s=await fs.readFile(path.join(h.base,'server/session-revert-object-write-native.ps1'),'utf8');
 const denied=' [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr process,SafeFileHandle source,IntPtr other,out SafeFileHandle duplicate,uint access,bool inherit,uint options);\n [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();\n SafeFileHandle Denied(){SafeFileHandle h;Check(DuplicateHandle(GetCurrentProcess(),target,GetCurrentProcess(),out h,0x120089,false,0));pins.Add(h);return h;}\n';
 if(['write','partial','eof','flush'].includes(name))s=s.replace(' readonly List<SafeFileHandle>',denied+' readonly List<SafeFileHandle>');
 if(name==='write')s=s.replace('WriteFile(target,b,','WriteFile(Denied(),b,');
 if(name==='partial')s=s.replace('/*D2_WRITE_BOUNDARY*/','if(offset>=2){uint failed;Api(WriteFile(Denied(),b,(uint)b.Length,out failed,IntPtr.Zero),"write_failed");}').replace('Math.Min(65536,R.Length-offset)','Math.Min(2,R.Length-offset)');
 if(name==='short')s=s.replace('WriteFile(target,b,(uint)b.Length,','WriteFile(target,b,1,');
 if(name==='eof')s=s.replace('SetEndOfFile(target)','SetEndOfFile(Denied())');
 if(name==='flush')s=s.replace('FlushFileBuffers(target)','FlushFileBuffers(Denied())');
 if(name==='before_crash')s=s.replace('/*D2_WRITE_BOUNDARY*/','Environment.Exit(73);');
 if(name==='mid_crash')s=s.replace('/*D2_WRITE_BOUNDARY*/','if(offset>=2)Environment.Exit(73);').replace('Math.Min(65536,R.Length-offset)','Math.Min(2,R.Length-offset)');
 if(name==='after_crash')s=s.replace('/*D2_RESULT_BOUNDARY*/','Environment.Exit(73);');
 if(name==='timeout')s=s.replace('/*D2_WRITE_BOUNDARY*/','System.Threading.Thread.Sleep(60000);');
 if(name==='stdout')s=s.replace("$after=$writer.Commit();Emit 'result' 'verified' $after","$after=$writer.Commit();[Console]::Out.WriteLine('malformed');");
 return Buffer.from(s);
}
module.exports={injected};
if(require.main===module)(async()=>{
 if(process.platform!=='win32'){console.log('Object faults: 0/0; skipped=1 (Windows)');return;}
 for(const [name,expected,status] of [['write',C,'recovery_required'],['partial',Buffer.from('RRCCCCCC'),'recovery_required'],['short',R,'verified'],['eof',Buffer.from('RRRRCCCC'),'recovery_required'],['flush',R,'recovery_required'],['before_crash',C,'recovery_required'],['mid_crash',Buffer.from('RRCCCCCC'),'recovery_required'],['after_crash',R,'recovery_required'],['timeout',C,'recovery_required'],['stdout',R,'recovery_required']])await check('native injected '+name,()=>h.fixture(C,async(root,attempts)=>{
  const m=await h.prepare(root,C,R,{helperBytes:await injected(name),timeoutMs:name==='timeout'?20000:30000}),a=await m.open(m.args);attempts.push(a);const result=await a.commit(m.binding(a));assert.equal(result.status,status);assert.equal(result.durable,false);assert.equal(result.retryAllowed,false);
  const actual=await fs.readFile(path.join(root,'workspace/file.txt'));assert.deepEqual(actual,expected);const reopened=await m.reopen();assert.deepEqual(await reopened.restoreRead(h.scope,m.currentRef),C);assert.deepEqual(await reopened.restoreRead(h.scope,m.candidateRef),R);
  if(status==='recovery_required'){const saved=await m.retainFailure(actual,name);assert.deepEqual(await (await m.reopen()).restoreRead(h.scope,saved),actual);}
  if(['write','partial','eof','flush'].includes(name))assert.equal(result.measurement.nativeCode,5);
  await fs.writeFile(path.join(root,'workspace/file.txt'),'external new D');await m.reopen();assert.equal(await fs.readFile(path.join(root,'workspace/file.txt'),'utf8'),'external new D');
  console.log('fault measurement',JSON.stringify({name,kind:['write','partial','eof','flush'].includes(name)?'real Win32 access-denied injection':name==='short'?'real request-size injection':'process/protocol injection',nativeCode:result.measurement?.nativeCode??null,bytes:actual.length,digest:h.hash(actual),result:result.status,materials:true,automaticRetry:false}));
 }));
 await check('wrong attempt, extra field, wrong binding and duplicate commit rejected',()=>h.fixture(C,async(root,attempts)=>{const m=await h.prepare(root,C,R),a=await m.open(m.args);attempts.push(a);for(const patch of [{attemptId:'foreign'},{bindingDigest:'foreign'},{intentRevision:2},{extra:true}])await assert.rejects(()=>a.commit({...m.binding(a),...patch}),e=>e.code==='invalid_commit');assert.equal((await a.commit(m.binding(a))).status,'verified');await assert.rejects(()=>a.commit(m.binding(a)),e=>e.code==='invalid_commit');}));
 await check('cancel and expired authority never commit',()=>h.fixture(C,async(root,attempts)=>{const m=await h.prepare(root,C,R),a=await m.open(m.args);attempts.push(a);m.revoke();await assert.rejects(()=>a.commit(m.binding(a)),e=>e.code==='invalid_commit');assert.equal((await a.cancel()).status,'not_applied');await assert.rejects(()=>a.commit(m.binding(a)));assert.deepEqual(await fs.readFile(path.join(root,'workspace/file.txt')),C);}));
 for(const change of ['nonce','attemptId','version','extra','duplicate','command','budget'])await check('real native protocol refusal '+change,()=>h.fixture(C,async(root,attempts)=>{
  const {spawn}=require('node:child_process');
  const spawnProcess=(...args)=>{const child=spawn(...args),end=child.stdin.end.bind(child.stdin);child.stdin.end=input=>{
   const row=JSON.parse(input);if(change==='extra')row.extra=true;else if(change==='budget')row.extra='x'.repeat(32769);else if(change==='version')row.version=2;else if(change!=='duplicate')row[change]='unknown';const line=JSON.stringify(row)+'\n';return end(change==='duplicate'?line+line:line);
  };return child;};
  const m=await h.prepare(root,C,R,{spawnProcess}),a=await m.open(m.args);attempts.push(a);assert.equal((await a.commit(m.binding(a))).status,'refused');assert.deepEqual(await fs.readFile(path.join(root,'workspace/file.txt')),C);
 }));
 for(const action of ['content','replacement','hardlink','junction','badC','badR','proof','unknownVersion','arbitraryPath','oversize','readonly','profile','helper','network','filesystem','unknownEA','unknownADS','unknownDACL','attributes','invalidUTF8','controlText'])await check('pre-ready refusal '+action,()=>h.fixture(C,async(root,attempts)=>{
  const m=await h.prepare(root,C,action==='invalidUTF8'?Buffer.from([0xff]):action==='controlText'?Buffer.from([1]):R);const target=path.join(root,'workspace/file.txt');
  if(action==='content')await fs.writeFile(target,'external D');
  if(action==='replacement'){await fs.rename(target,target+'.old');await fs.writeFile(target,C);}
  if(action==='hardlink')await fs.link(target,target+'.link');
  if(action==='junction'){await fs.rename(path.join(root,'workspace'),path.join(root,'real'));await fs.symlink(path.join(root,'real'),path.join(root,'workspace'),'junction');}
  if(action==='badC'||action==='badR'){const d=await (await m.reopen()).restoreDescriptor(h.scope,action==='badC'?m.currentRef:m.candidateRef);await fs.writeFile(d.privatePath,'bad');}
  if(action==='proof')m.args.proofId='unknown';
  if(action==='unknownVersion')m.args.expectedObject.version=2;
  if(action==='profile')m.args.expectedObject.profileId='unknown';
  if(action==='helper')m.args.expectedObject.source.helperHash='0'.repeat(64);
  if(action==='network')m.args.expectedObject.platform.driveType=4;
  if(action==='filesystem')m.args.expectedObject.platform.fileSystem='FAT32';
  if(action==='unknownEA')m.args.expectedObject.ea.state='unavailable';
  if(action==='unknownADS')m.args.expectedObject.streams.state='unavailable';
  if(action==='unknownDACL')m.args.expectedObject.security.dacl.state='unavailable';
  if(action==='attributes')m.args.expectedObject.file.attributes=8192;
  if(action==='arbitraryPath')m.args.relativePath=target;
  if(action==='oversize'){m.args.candidateRef={...m.candidateRef,bytes:2097153};}
  if(action==='readonly')await old.fixturePowerShell("[IO.File]::SetAttributes((Join-Path $env:PI_INPLACE_ROOT 'workspace/file.txt'),[IO.FileAttributes]33)",root);
  await assert.rejects(()=>m.open(m.args));assert.deepEqual(await fs.readFile(target),action==='content'?Buffer.from('external D'):C);
  if(action==='junction')await fs.unlink(path.join(root,'workspace'));
  if(action==='readonly')await old.fixturePowerShell("[IO.File]::SetAttributes((Join-Path $env:PI_INPLACE_ROOT 'workspace/file.txt'),[IO.FileAttributes]32)",root);
 }));
 for(const race of ['ADS','DACL','attributes'])await check('real external metadata race '+race,()=>h.fixture(C,async(root,attempts)=>{
  const m=await h.prepare(root,C,R),a=await m.open(m.args);attempts.push(a);
  if(race==='ADS')await require('node:util').promisify(require('node:child_process').execFile)(process.execPath,['-e',"require('fs').writeFileSync(process.argv[1]+':external','external ADS')",path.join(root,'workspace/file.txt')],{windowsHide:true,timeout:10000});
  if(race==='DACL')await old.fixturePowerShell("$p=Join-Path $env:PI_INPLACE_ROOT 'workspace/file.txt';$source=Get-Acl -LiteralPath $p;$acl=[Security.AccessControl.FileSecurity]::new();$acl.SetSecurityDescriptorSddlForm($source.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access),[Security.AccessControl.AccessControlSections]::Access);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'Read','Allow'));[IO.File]::SetAccessControl($p,$acl)",root);
  if(race==='attributes')await old.fixturePowerShell("[IO.File]::SetAttributes((Join-Path $env:PI_INPLACE_ROOT 'workspace/file.txt'),[IO.FileAttributes]34)",root);
  assert.equal((await a.commit(m.binding(a))).status,'refused');assert.deepEqual(await fs.readFile(path.join(root,'workspace/file.txt')),C);
  console.log('external race measurement',JSON.stringify({race,externalProcessSucceeded:true,preCommitRefused:true,globalMetadataExclusion:false}));
 }));
 await check('new core held handles block independent main write, target rename and parent rename',()=>h.fixture(C,async(root,attempts)=>{
  const m=await h.prepare(root,C,R),a=await m.open(m.args);attempts.push(a);const run=require('node:util').promisify(require('node:child_process').execFile);
  for(const action of ['write','rename','parent']){const code="const fs=require('fs'),p=process.argv[1],a=process.argv[2];try{if(a==='write')fs.writeFileSync(p,'D');else{const at=a==='parent'?require('path').dirname(p):p;fs.renameSync(at,at+'.moved')}console.log(JSON.stringify({blocked:false}))}catch(e){console.log(JSON.stringify({blocked:true,code:e.code}))}";const row=JSON.parse((await run(process.execPath,['-e',code,path.join(root,'workspace/file.txt'),action],{windowsHide:true,timeout:10000})).stdout);assert.equal(row.blocked,true);assert.ok(['EPERM','EACCES','EBUSY'].includes(row.code));console.log('new core sharing',JSON.stringify({action,...row}));}
  assert.equal((await a.commit(m.binding(a))).status,'verified');assert.deepEqual(await fs.readFile(path.join(root,'workspace/file.txt')),R);
 }));
 await check('second independent recovery failure retains original C and intermediate D',()=>h.fixture(C,async(root,attempts)=>{const first=await h.prepare(root,C,R,{helperBytes:await injected('partial')}),a=await first.open(first.args);attempts.push(a);assert.equal((await a.commit(first.binding(a))).status,'recovery_required');const D=await fs.readFile(path.join(root,'workspace/file.txt'));await first.retainFailure(D,'first recovery');const second=await h.prepare(root,D,await first.read(first.currentRef),{helperBytes:await injected('partial')}),b=await second.open(second.args);attempts.push(b);assert.equal((await b.commit(second.binding(b))).status,'recovery_required');await second.retainFailure(await fs.readFile(path.join(root,'workspace/file.txt')),'second recovery');const reopen=await second.reopen();assert.deepEqual(await reopen.restoreRead(h.scope,first.currentRef),C);assert.deepEqual(await reopen.restoreRead(h.scope,second.currentRef),D);}));
 console.log(`Object faults: ${passed}/${passed}; failed=0; skipped=0; no production durable state machine`);
})().catch(e=>{console.error('FAIL object faults',e.code||e.message);process.exitCode=1;});
