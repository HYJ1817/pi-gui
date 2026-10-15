// Opt-in actual SEA process restart. All mutations belong to a fresh TEMP fixture.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process');
function validateRestartResult(r){
 assert.equal(r.isSea,true);assert.equal(r.actualProcessRestart,true);assert.equal(r.newRegistryBackend,true);
 assert.equal(r.reconciledState,'recovery_required');assert.equal(r.historyMaterialsByteExact,true);
 assert.equal(r.historyJournalUnchanged,true);assert.equal(r.oldOwnerRejected,true);assert.equal(r.oldAttemptRejected,true);
 assert.equal(r.nativeOpensAfterRestart,0);assert.equal(r.nativeCommitsAfterRestart,0);assert.equal(r.currentDUnchanged,true);
 assert.equal(r.crossBackendRecovery,'blocked_contract');assert.equal(r.newRecoveryPlanCreated,false);
}
module.exports={validateRestartResult};
if(require.main===module)(async()=>{
 if(process.platform!=='win32'){console.log('SEA restart: 0/0; failed=0; skipped=1 Windows only');return;}
 const builder=require('./fixtures/session-revert-object-sea-restart-build.cjs'),x=await builder.build();
 let passed=0;const evidence=[];const check=async(name,fn)=>{await fn();passed++;console.log('ok '+name);};
 async function launch(stage,onCheckpoint){
  return new Promise((resolve,reject)=>{
   const child=spawn(x.testExe,[stage],{windowsHide:true,stdio:['pipe','pipe','pipe']});let buffer='',result=null,checkpoint=null,handling=false,stderrBytes=0;
   const timer=setTimeout(()=>{child.kill();reject(Error('sea_restart_timeout:'+stage));},240000);
   child.stdin.on('error',()=>{});child.stderr.on('data',b=>{stderrBytes+=b.length;});
   child.stdout.on('data',b=>{buffer+=b.toString('utf8');if(Buffer.byteLength(buffer)>65536){child.kill();return reject(Error('sea_restart_output_budget'));}
    while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);let row;try{row=JSON.parse(line);}catch{child.kill();reject(Error('sea_restart_protocol'));return;}
     if(row.phase==='challenge')child.stdin.write(JSON.stringify({version:1,command:'run',nonce:row.nonce})+'\n');
     else if(row.phase==='checkpoint'&&!handling){handling=true;checkpoint=row;void onCheckpoint(row,child).catch(e=>{child.kill();reject(e);});}
     else if(row.phase==='result')result=row;
     else if(row.phase==='blocked'){child.kill();reject(Error('sea_restart_blocked:'+row.code+':line='+row.line));}
    }
   });
   child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',(code,signal)=>{clearTimeout(timer);resolve({pid:child.pid,code,signal,result,checkpoint,stderrBytes});});
  });
 }
 // PID plus OS creation identity prevents PID reuse from masquerading as cleanup.
 const nativeIdentity=pid=>builder.processIdentity(pid);
 let nativeBefore,first;
 await check('first actual SEA reaches Native Ready and durable replacing before parent kills the entire SEA',async()=>{
  first=await launch('first',async(row,child)=>{assert.equal(row.isSea,true);assert.equal(row.durableReplacing,true);assert.equal(row.nativeReady,true);assert.equal(row.nativeCommitsSent,0);nativeBefore=await nativeIdentity(row.nativePid);assert.ok(nativeBefore);child.kill();});
  assert.ok(first.checkpoint);assert.equal(first.result,null);assert.notEqual(first.code,0);assert.equal(first.checkpoint.pid,first.pid);evidence.push({stage:'forced-process-termination',pid:first.pid,exit:first.code,signal:first.signal,checkpoint:first.checkpoint,nativeCreation:nativeBefore.creation});
 });
 await check('original Native process ends after SEA pipe closure without a commit or target write',async()=>{
  const end=Date.now()+15000;let current;do{current=await nativeIdentity(first.checkpoint.nativePid);if(!current||current.creation!==nativeBefore.creation)break;await new Promise(r=>setTimeout(r,50));}while(Date.now()<end);
  assert.ok(!current||current.creation!==nativeBefore.creation,'original Native process must end');
  const control=JSON.parse(await fs.readFile(path.join(x.testDir,'restart-control.json'),'utf8'));
  assert.equal(await fs.readFile(path.join(control.root,'file.txt'),'utf8'),'agent\nanchor\nuser-new\n');
 });
 let second;
 await check('second new SEA process creates a new Registry backend and reconciles durable uncertainty',async()=>{
  second=await launch('second',()=>{throw Error('unexpected_second_checkpoint');});assert.equal(second.code,0);assert.ok(second.result);validateRestartResult(second.result);
  assert.notEqual(second.result.backendInstance,first.checkpoint.backendInstance);assert.equal(second.result.previousPid,first.pid);evidence.push({stage:'new-process-recovery-read-only',pid:second.pid,...second.result});
 });
 await check('test SEA excludes formal server entry and production writer/service remain fixed closed',async()=>{assert.equal(second.result.formalServiceClosed,true);assert.equal(second.result.formalWriterClosed,true);assert.equal(second.result.allowlistEmpty,true);});
 const summary={suite:'SEA process restart',passed,failed:0,skipped:0,scope:{actualSEAProcessRestart:true,actualOSReboot:false,naturalPowerLoss:false,nativeCommitBeforeKill:false,registry:'real Registry with fixture adapter; no Pi/model',capture:'synthetic TEMP evidence',crossBackendDToC:'blocked existing owner-bound contract',productionB:false},build:x,evidence};
 await fs.writeFile(path.join(builder.ROOT,'.probe/p33-d6final-sea-restart-summary.json'),JSON.stringify(summary,null,2));
 console.log(JSON.stringify(summary));console.log(`SEA process restart: ${passed}/${passed}; failed=0; skipped=0; cross-backend D-to-C=BLOCKED_CONTRACT`);
})().catch(e=>{console.error(e.stack??e.message);process.exitCode=1;});
