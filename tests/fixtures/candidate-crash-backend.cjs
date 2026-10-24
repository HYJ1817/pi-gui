/* Fixture-only checkpoints. The production server gets no kill endpoint or flag. */
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {registerHooks} = require('node:module');
const root = path.resolve(__dirname, '../..');
const target = pathToFileURL(path.join(root, 'server/candidate-apply.js')).href;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== target) return result;
    const marker = ' const store=createCandidateTransactions';
    const source = String(result.source);
    if (source.split(marker).length !== 2) throw Error('checkpoint marker changed');
    const checkpoint = `
 hooks={
  beforeStep:async(i,id)=>{
   if(process.env.CANDIDATE_CRASH_PHASE==='before_write'&&i===0)await hold(id);
   if(process.env.CANDIDATE_CRASH_PHASE==='recovering'&&i===1)throw Error('fixture_step_failure');
  },
  afterStep:async(i,id)=>{
   if(process.env.CANDIDATE_CRASH_PHASE==='first_verified'&&i===0||process.env.CANDIDATE_CRASH_PHASE==='last_verified'&&i===1)await hold(id);
  },
  afterRecoveryStep:async(i,id)=>{if(i===0)await hold(id);}
 };
 async function hold(id){
  fs.writeFileSync(path.join(process.env.T4B_EVIDENCE_DIR,'checkpoint.json'),JSON.stringify({id,phase:process.env.CANDIDATE_CRASH_PHASE,pid:process.pid}));
  await new Promise(()=>{});
 }
`;
    const applied = 'const result=await writer.apply(i);';
    if (source.split(applied).length !== 2) throw Error('native result marker changed');
    return {...result, source: source.replace(marker, checkpoint + marker).replace(applied,
      applied + "if(process.env.CANDIDATE_CRASH_PHASE==='after_native_write'&&i===0)await hold(tx.id);")};
  },
});
void import(pathToFileURL(path.join(root, 'server.js')).href);
