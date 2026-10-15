const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net'),os=require('node:os');
const {spawn}=require('node:child_process'),builder=require('./fixtures/session-revert-object-packed-build.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
let passed=0;const evidence=[];const check=async(name,fn)=>{await fn();passed++;console.log('ok '+name);};
function challenge(file,args=[],env={},cwd){return new Promise((resolve,reject)=>{
 const child=spawn(file,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:['pipe','pipe','pipe']});
 let output='',buffer='',result=null,seen=false;const timer=setTimeout(()=>{child.kill();reject(Error('test_launcher_timeout'));},600000);
 child.stderr.resume();child.stdin.on('error',()=>{});
 child.stdout.on('data',chunk=>{output+=chunk.toString();if(Buffer.byteLength(output)>32768){child.kill();return reject(Error('launcher_output_budget'));}buffer+=chunk.toString();
  while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const row=JSON.parse(line);if(row.phase==='challenge'){assert.equal(seen,false);seen=true;assert.match(row.nonce,/^[a-f0-9]{64}$/);child.stdin.write(JSON.stringify({version:1,command:'run',nonce:row.nonce})+'\n');}else result=row;}catch(e){child.kill();reject(e);}}
 });
 child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);if(code!==0||result?.phase!=='result')return reject(Error('test_launcher_blocked:'+JSON.stringify(result)));resolve(result);});
});}
function refusedChallenge(file,makeRow){return new Promise((resolve,reject)=>{
 const child=spawn(file,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});let text='';const timer=setTimeout(()=>{child.kill();reject(Error('challenge_refusal_timeout'));},15000);
 child.stderr.resume();child.stdin.on('error',()=>{});child.stdout.on('data',b=>{text+=b.toString();if(text.includes('\n')){const first=JSON.parse(text.split('\n')[0]);child.stdin.end(makeRow(first.nonce));}});
 child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);try{assert.equal(code,2);assert.equal(text.includes('"phase":"result"'),false);resolve();}catch(e){reject(e);}});
});}
const {productionBoundary}=require('./fixtures/session-revert-object-packed-boundary.cjs');
function assertRecoveryCycle(r){
 assert.deepEqual(r.recovery?.states,['recovery_required','recovery_required','applied_verified']);
 assert.equal(r.recovery.commits,3);assert.equal(r.recovery.resultFaults,2);
 assert.equal(r.recovery.materialsByteExact,true);assert.equal(r.recovery.freshConfirmations,true);
 assert.equal(r.recovery.reopened,true);assert.equal(r.recovery.finalByteExact,true);
 assert.equal(r.recovery.objectMaintained,true);
}

(async()=>{
 if(process.platform!=='win32'){console.log('D4 packaged: 0/0; skipped=1 Windows only');return;}
 assert.equal(typeof builder.build,'function');const zip=process.env.PI_GUI_ELECTRON_ZIP_DIR;if(!zip)throw Error('D4 blocked: PI_GUI_ELECTRON_ZIP_DIR required for offline formal APP build');
 const preserved=new Map();for(const rel of ['build/server.cjs','build/Pi GUI.exe','dist-app/Pi GUI-win32-x64/resources/app/server.cjs','dist-app/Pi GUI-win32-x64/Pi GUI.exe']){const file=path.join(builder.ROOT,rel);try{preserved.set(file,hash(await fs.readFile(file)));}catch(e){if(e.code!=='ENOENT')throw e;}}
 const x=await builder.build({electronZipDir:zip});
 try{
  await check('fresh TEMP production builds exclude private writer and service cores',async()=>{for(const file of [path.join(x.buildDir,'server.cjs'),path.join(x.appDir,'resources/app/server.cjs')]){const source=await fs.readFile(file,'utf8');assert.equal(source.includes('createIsolatedWriter'),false);assert.equal(source.includes('createObjectServiceCore'),false);assert.equal(source.includes('p33-D4 中文 space-'),false);}});
  await check('test SEA issuer rejects client root/path/bytes, stale nonce, version and oversized protocol',async()=>{
   for(const make of [n=>JSON.stringify({version:1,command:'run',nonce:n,root:'client',path:'client',bytes:'client'})+'\n',n=>JSON.stringify({version:1,command:'run',nonce:'0'.repeat(64)})+'\n',n=>JSON.stringify({version:2,command:'run',nonce:n})+'\n',n=>JSON.stringify({version:1,command:'apply',nonce:n})+'\n',()=> 'x'.repeat(513)])await refusedChallenge(x.testExe,make);
  });
  await check('actual SEA test EXE reads production embedded Helpers and persists verified/recovery',async()=>{const r=await challenge(x.testExe);assert.equal(r.isSea,true);assert.equal(r.bundled,true);evidence.push({layer:'actualSEA-test-only',...r});});
  await check('actual SEA new confirmations persist C/R/D across two uncertain writes and final D-to-C recovery',async()=>assertRecoveryCycle(evidence.find(r=>r.layer==='actualSEA-test-only')));
  await check('Electron RUN_AS_NODE test backend persists real Native verified/recovery',async()=>{const r=await challenge(x.appExe,[x.backendLauncher],{ELECTRON_RUN_AS_NODE:'1',PI_GUI_DATA:path.join(x.root,'custom data 中文')});assert.equal(r.isSea,false);assert.equal(r.bundled,true);evidence.push({layer:'Electron-backend-test-only',...r});});
  await check('Electron backend uses the same fresh-plan and reopened C/R/D recovery cycle',async()=>assertRecoveryCycle(evidence.find(r=>r.layer==='Electron-backend-test-only')));
  await check('formal SEA process rejects stdin issuer and HTTP B entry',async()=>evidence.push({layer:'formal-productionSEA',...await productionBoundary(x.productionExe,[],x.root)}));
  await check('formal APP backend rejects stdin issuer and HTTP B entry',async()=>evidence.push({layer:'formal-productionAPP-backend',...await productionBoundary(x.appExe,[path.join(x.appDir,'resources/app/server.cjs')],x.root,{ELECTRON_RUN_AS_NODE:'1'})}));
  const observe=path.join(x.appDir,'resources/app/revert-object/observe.ps1'),write=path.join(x.appDir,'resources/app/revert-object/write.ps1');
  await check('same-name malicious scripts and readonly packaged resources cannot redirect Helper execution',async()=>{
   const decoy=path.join(x.root,'malicious cwd');await fs.mkdir(decoy);for(const name of ['powershell.exe','observe.ps1','write.ps1'])await fs.writeFile(path.join(decoy,name),'throw "malicious"');
   const snapshots=await Promise.all([observe,write].map(f=>fs.readFile(f)));await builder.command('attrib',['+R',observe]);await builder.command('attrib',['+R',write]);
   try{const r=await challenge(x.appExe,[x.backendLauncher],{ELECTRON_RUN_AS_NODE:'1'},decoy);assert.equal(r.outcomes[0].completion,'applied_verified');for(let i=0;i<2;i++)assert.deepEqual(await fs.readFile([observe,write][i]),snapshots[i]);}finally{await builder.command('attrib',['-R',observe]);await builder.command('attrib',['-R',write]);}
  });
  await check('tampered packaged Helper blocks before Native execution',async()=>{const original=await fs.readFile(write);await fs.writeFile(write,Buffer.concat([original,Buffer.from('\n# tampered')]));try{await assert.rejects(()=>challenge(x.appExe,[x.backendLauncher],{ELECTRON_RUN_AS_NODE:'1'}),/test_launcher_blocked/);}finally{await fs.writeFile(write,original);}});
  await check('old build/dist entry digests remain unchanged',async()=>{for(const [file,before] of preserved)assert.equal(hash(await fs.readFile(file)),before);});
  console.log(JSON.stringify({suite:'D4 packaged',passed,evidence:evidence.map(({nonce,...r})=>r),productionExeDigest:hash(await fs.readFile(x.productionExe)),testExeDigest:hash(await fs.readFile(x.testExe))}));console.log(`D4 packaged: ${passed}/${passed}; failed=0; skipped=0`);
 }finally{assert.match(path.basename(x.root),/^p33-D4 packaged 中文 /);assert.equal(path.dirname(x.root),path.resolve(os.tmpdir()));await fs.appendFile(path.join(builder.ROOT,'.probe/p33-d4-packed-materials.jsonl'),JSON.stringify({testOnly:true,root:x.root,productionExe:x.productionExe,testExe:x.testExe,appDir:x.appDir,appExe:x.appExe,backendLauncher:x.backendLauncher,passed})+'\n',{mode:0o600});}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
