const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{randomUUID,createHash}=require('node:crypto');
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('ok '+name);};
(async()=>{
 const {createCandidateStore}=await import('../server/candidate-store.js');
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'t4b-store-')),data=path.join(world,'data');fs.mkdirSync(data);
 const options={dataDir:data},store=createCandidateStore(options),other=createCandidateStore(options),root=path.join(data,'candidate-runs');
 const bytes=Buffer.from('fixture\n'),id=randomUUID(),workspaceId=randomUUID(),record={version:1,run:{id,sourceScope:'a'.repeat(64),state:'completed',rootIdentity:[1,2,3],gitIdentity:'b'.repeat(64),workspace:{id:workspaceId,repoId:'c'.repeat(24),path:path.join(data,'worktrees','c'.repeat(24),workspaceId)}},input:{files:[{path:'a.txt',bytes:bytes.toString('base64'),digest:createHash('sha256').update(bytes).digest('hex')}]}},file=path.join(root,id+'.json');
 try{
  check('read-only empty inspection creates no storage',()=>{assert.deepEqual(store.readAll(),[]);assert(!fs.existsSync(root));});
  store.acquire();check('cross-instance writer lock refuses overlap',()=>assert.throws(()=>other.acquire(),e=>e.code==='candidate_storage_busy'));
  store.save(record);check('saved record is readable without exposing input in memory',()=>{const rows=other.readAll();assert.equal(rows.length,1);assert.equal(rows[0].run.id,id);assert.deepEqual(rows[0].input.files,[]);});
  const original=fs.readFileSync(file);
  check('corrupt optional adoption extension cannot hide legacy history',()=>{
   const nested=original.toString('utf8').slice(0,-1)+',"adoptionEvidence":'+'['.repeat(12000)+'null'+']'.repeat(12000)+'}';
   try{fs.writeFileSync(file,nested);const rows=other.readAll();assert.equal(rows[0].run.id,id);assert.equal(rows[0].adoptionEvidence,null);}finally{fs.writeFileSync(file,original);}
  });
  fs.writeFileSync(file,'{');check('corrupt JSON remains intact after refusal',()=>{assert.throws(()=>other.readAll());assert.equal(fs.readFileSync(file,'utf8'),'{');});fs.writeFileSync(file,original);
  const write=v=>fs.writeFileSync(file,JSON.stringify(v));
  write({...record,version:2});check('unknown future version refuses and preserves bytes',()=>{assert.throws(()=>other.readAll());assert.equal(JSON.parse(fs.readFileSync(file)).version,2);});fs.writeFileSync(file,original);
  write({...record,run:{...record.run,rootIdentity:undefined}});check('completion without retained identity proof refuses recovery',()=>assert.throws(()=>other.readAll()));fs.writeFileSync(file,original);
  write({...record,input:{files:[{...record.input.files[0],digest:'0'.repeat(64)}]}});check('input hash mismatch refuses recovery',()=>assert.throws(()=>other.readAll()));fs.writeFileSync(file,original);
  write({...record,run:{...record.run,workspace:{repoId:'b'.repeat(24),id:randomUUID(),path:world}}});check('arbitrary workspace path refuses recovery',()=>assert.throws(()=>other.readAll()));fs.writeFileSync(file,original);
  write({...record,result:{files:[{path:'../escape',patch:''}]}});check('unsafe retained Diff path refuses recovery',()=>assert.throws(()=>other.readAll()));fs.writeFileSync(file,original);
  fs.unlinkSync(file);fs.linkSync(path.join(root,'writer.lock'),file);check('hardlinked records refuse reads',()=>assert.throws(()=>other.readAll()));fs.unlinkSync(file);fs.writeFileSync(file,original);
  check('materials inside protected source cannot be created',()=>{const unsafe=createCandidateStore({dataDir:data,protectedRoots:()=>[world]});assert.throws(()=>unsafe.acquire(),e=>e.code==='candidate_storage_unsafe');});
  store.release();other.acquire();other.release();check('confirmed release permits next instance without deleting result',()=>assert(fs.existsSync(file)));
  fs.renameSync(root,root+'-retained');fs.mkdirSync(root);check('replaced material directory identity refuses access',()=>assert.throws(()=>store.readAll(),e=>e.code==='candidate_storage_unsafe'));
 }finally{const relative=path.relative(os.tmpdir(),fs.realpathSync(world));assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(world,{recursive:true,force:true});}
 console.log(`Candidate store: ${checks}/${checks}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
