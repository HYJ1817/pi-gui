const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
let n=0;const check=(name,fn)=>{fn();n++;console.log('ok '+name);};
(async()=>{
 let createCandidateTransactions;try{({createCandidateTransactions}=await import('../server/candidate-transactions.js'));}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
 check('transaction store exists',()=>assert.equal(typeof createCandidateTransactions,'function'));
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'t4c2-store-'));try{
  const s=createCandidateTransactions({dataDir:data}),other=createCandidateTransactions({dataDir:data}),binding={runId:'a',scope:'b',source:path.join(data,'source')};
  check('reading empty state never creates storage',()=>{assert.deepEqual(s.list(),[]);assert.deepEqual(fs.readdirSync(data),[]);});
  const lock=s.acquire();
  check('transaction mutation requires exclusive store lock',()=>{assert.throws(()=>other.acquire(),e=>e.code==='candidate_storage_busy');assert.throws(()=>other.create({binding,plan:{files:[]},files:[]}),e=>e.code==='candidate_storage_busy');});
  check('owner can inspect its own execution lock',()=>{assert.equal(s.locked(),true);assert.equal(other.locked(),false);assert.deepEqual(s.list(),[]);});
  const tx=s.create({binding,plan:{files:[]},files:[]});
  check('intent is readable before source mutation',()=>{assert.equal(s.read(tx.id).state,'prepared');assert.deepEqual(s.read(tx.id).binding,binding);});
  s.append(tx.id,{state:'applying',step:0});
  check('restart preserves unconfirmed intent instead of success',()=>assert.equal(createCandidateTransactions({dataDir:data}).read(tx.id).state,'applying'));
  s.append(tx.id,{state:'recovery_required',step:0});
  check('terminal success requires explicit durable record',()=>assert.equal(s.read(tx.id).state,'recovery_required'));
  lock.release();
  check('stale execution lock blocks reads and new mutations',()=>{fs.writeFileSync(path.join(data,'candidate-transactions','execute.lock'),'stale');assert.throws(()=>s.list(),e=>e.code==='candidate_storage_busy');assert.throws(()=>s.acquire(),e=>e.code==='candidate_storage_busy');});
  const file=path.join(tx.directory,'000002.json');fs.appendFileSync(file,'corrupt');
  check('corrupt journal is refused and preserved',()=>{assert.throws(()=>s.read(tx.id));assert(fs.readFileSync(file,'utf8').endsWith('corrupt'));});
 }finally{fs.rmSync(data,{recursive:true,force:true});}
 console.log(`Candidate transactions: ${n}/${n}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
