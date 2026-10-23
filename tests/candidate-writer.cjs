const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const hash=b=>createHash('sha256').update(b).digest('hex');
let passed=0;const check=async(name,fn)=>{await fn();passed++;console.log('ok '+name);};
(async()=>{
 let api={};try{api=await import('../server/candidate-writer.js');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
 await check('candidate native writer exists',()=>assert.equal(typeof api.openCandidateWriter,'function'));
 if(process.platform!=='win32'){console.log('SKIP Windows native provider');return;}
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'t4c2-writer-')),root=path.join(world,'source'),recovery=path.join(world,'recovery');fs.mkdirSync(root);fs.mkdirSync(recovery);
 const source=Buffer.from('original\r\n'),output=Buffer.from([82,0,255,10]);
 const file=path.join(root,'a.txt');fs.writeFileSync(file,source);
 const entry=(p,b,after)=>({path:p,identity:fs.statSync(path.join(root,p),{bigint:true}).ino.toString(),before:hash(b),after:after===null?null:hash(after),bytes:after?.toString('base64')??null});
 let w;try{
  w=await api.openCandidateWriter({root,recovery,files:[entry('a.txt',source,output)],pins:[]});
  await check('opening writer is read-only',()=>assert.deepEqual(fs.readFileSync(file),source));
  await check('independent process cannot write held original',()=>assert.throws(()=>execFileSync(process.execPath,['-e',"require('fs').writeFileSync(process.argv[1],'D')",file],{windowsHide:true,stdio:'pipe'})));
  await check('independent process cannot replace held original',()=>{const other=path.join(world,'D');fs.writeFileSync(other,'D');assert.throws(()=>fs.renameSync(other,file));assert.equal(fs.readFileSync(other,'utf8'),'D');});
  await check('pinned parent cannot be replaced',()=>assert.throws(()=>fs.renameSync(root,root+'-moved')));
  const result=await w.apply(0);
  await check('raw bytes verified on held original object',()=>{assert.equal(result.digest,hash(output));assert.deepEqual(fs.readFileSync(file),output);});
  await w.close();w=null;
  fs.writeFileSync(file,source);fs.writeFileSync(path.join(root,'delete.txt'),'delete');
  w=await api.openCandidateWriter({root,recovery,files:[entry('delete.txt',Buffer.from('delete'),null),{path:'new.txt',identity:null,before:null,after:hash(output),bytes:output.toString('base64')}],pins:[]});
  const deleted=await w.apply(0);
  await check('delete retains exact original object for recovery',()=>{assert(!fs.existsSync(path.join(root,'delete.txt')));assert.equal(fs.readFileSync(path.join(recovery,'deleted-0'),'utf8'),'delete');assert.equal(fs.statSync(path.join(recovery,'deleted-0'),{bigint:true}).ino.toString(),deleted.identity);});
  await w.apply(1);
  await check('create uses exact bytes',()=>assert.deepEqual(fs.readFileSync(path.join(root,'new.txt')),output));
  await w.close();w=null;
  fs.unlinkSync(path.join(root,'new.txt'));
  w=await api.openCandidateWriter({root,recovery,files:[{path:'new.txt',identity:null,before:null,after:hash(output),bytes:output.toString('base64')}],pins:[]});
  fs.writeFileSync(path.join(root,'new.txt'),'external D');
  await check('late create occupant is never overwritten',async()=>{await assert.rejects(w.apply(0));assert.equal(fs.readFileSync(path.join(root,'new.txt'),'utf8'),'external D');});
 }finally{await w?.close().catch(()=>{});fs.rmSync(world,{recursive:true,force:true});}
 console.log(`Candidate writer: ${passed}/${passed}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
