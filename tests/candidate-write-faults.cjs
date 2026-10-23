const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
const hash=b=>createHash('sha256').update(b).digest('hex');let n=0;const check=async(name,fn)=>{await fn();n++;console.log('ok '+name);};
(async()=>{if(process.platform!=='win32'){console.log('SKIP Windows candidate fault provider');return;}
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'t4c2-fault-')),root=path.join(world,'source'),recovery=path.join(world,'recovery');fs.mkdirSync(root);fs.mkdirSync(recovery);const file=path.join(root,'a.txt'),C=Buffer.from('original C'),R=Buffer.from('candidate R');
 const reset=()=>{fs.writeFileSync(file,C);return{path:'a.txt',identity:fs.statSync(file,{bigint:true}).ino.toString(),before:hash(C),after:hash(R),bytes:R.toString('base64')};};let w;
 try{
  for(const fault of ['write','partial','flush']){const api=await require('./fixtures/candidate-writer-harness.cjs').load(fault),entry=reset();w=await api.openCandidateWriter({root,recovery,files:[entry]});
   await check(fault+' failure never returns verified success',()=>assert.rejects(w.apply(0)));
   await w.close();w=null;
   await check(fault+' retains source object for conservative recovery',()=>{assert.equal(fs.statSync(file,{bigint:true}).ino.toString(),entry.identity);if(fault==='write')assert.deepEqual(fs.readFileSync(file),C);if(fault==='partial')assert.equal(fs.readFileSync(file)[0],90);if(fault==='flush')assert.deepEqual(fs.readFileSync(file),R);});
  }
  const api=await require('./fixtures/candidate-writer-harness.cjs').load('rename'),entry=reset();w=await api.openCandidateWriter({root,recovery,files:[{...entry,after:null,bytes:null}]});await check('rename API failure keeps deletion target',async()=>{await assert.rejects(w.apply(0));assert.deepEqual(fs.readFileSync(file),C);});await w.close();w=null;
  const real=await import('../server/candidate-writer.js');const readonly=reset();fs.chmodSync(file,0o444);await check('read-only target refuses before writing',async()=>{try{await assert.rejects(real.openCandidateWriter({root,recovery,files:[readonly]}));assert.deepEqual(fs.readFileSync(file),C);}finally{fs.chmodSync(file,0o666);}});
  const killed=await require('./fixtures/candidate-writer-harness.cjs').load('kill');w=await killed.openCandidateWriter({root,recovery,files:[reset()]});w.killForFixture();await check('native process termination never becomes success',async()=>{await assert.rejects(w.apply(0));assert.deepEqual(fs.readFileSync(file),C);});await w.close();w=null;
 }finally{await w?.close().catch(()=>{});fs.rmSync(world,{recursive:true,force:true});}console.log(`Candidate write faults: ${n}/${n}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
