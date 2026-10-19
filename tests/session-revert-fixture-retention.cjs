const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {appendRetentionIndex,preserveFixtureFailure}=require('./fixtures/session-revert-retention.cjs');
(async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'p33-retention-check-'));let passed=0;
 const check=async(name,run)=>{await run();passed++;console.log('ok '+name);};
 try{
  const index=path.join(root,'.probe','p33-d4-retained-materials.jsonl');
  await check('clean checkout creates missing evidence index directory',async()=>{await appendRetentionIndex(root,'p33-d4-retained-materials.jsonl',{testOnly:true,id:1});assert.deepEqual(JSON.parse(await fs.readFile(index,'utf8')),{testOnly:true,id:1});});
  await check('retained evidence records append without overwriting',async()=>{await appendRetentionIndex(root,'p33-d4-retained-materials.jsonl',{testOnly:true,id:2});assert.deepEqual((await fs.readFile(index,'utf8')).trim().split('\n').map(JSON.parse).map(r=>r.id),[1,2]);});
  await check('D2 retained materials initialize on a clean checkout',async()=>{const base=path.join(root,'d2');await appendRetentionIndex(base,'p33-d2-retained-materials.jsonl',{testOnly:true,id:4});assert.deepEqual(JSON.parse(await fs.readFile(path.join(base,'.probe','p33-d2-retained-materials.jsonl'),'utf8')),{testOnly:true,id:4});});
  await check('D3 durable retention also initializes a fresh directory',async()=>{const base=path.join(root,'d3');await appendRetentionIndex(base,'p33-d3-retained-materials.jsonl',{id:3});assert.deepEqual(JSON.parse(await fs.readFile(path.join(base,'.probe','p33-d3-retained-materials.jsonl'),'utf8')),{id:3});});
  await check('unknown or escaping index names are refused',async()=>{await assert.rejects(appendRetentionIndex(root,'../escape',{}),{code:'invalid_fixture_retention_index'});assert.equal(await fs.stat(path.join(root,'escape')).catch(()=>null),null);});
  const original=Object.assign(Error('original fixture failure'),{code:'original_failure'});
  await check('successful failure indexing preserves original error identity',async()=>{await assert.rejects(preserveFixtureFailure(root,{failed:true},original),error=>error===original);});
  await check('index failure cannot mask original error or remove material',async()=>{const base=path.join(root,'blocked');await fs.mkdir(base);await fs.writeFile(path.join(base,'.probe'),'occupied');await fs.writeFile(path.join(base,'material'),'preserved');const lines=[],log=console.error;console.error=(...parts)=>lines.push(parts.join(' '));try{await assert.rejects(preserveFixtureFailure(base,{failed:true},original),error=>error===original);}finally{console.error=log;}assert.deepEqual(lines,['fixture_retention_index_unavailable']);assert.equal(await fs.readFile(path.join(base,'material'),'utf8'),'preserved');});
  console.log(`Fixture retention: ${passed}/${passed}; failed=0; skipped=0; real TEMP filesystem, no Native writer`);
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
