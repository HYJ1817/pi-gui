/* v1 -> v2 only inside the original transaction; all fixture writes in TEMP. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('  ok '+name);};
(async()=>{
  const {createReviewCommentStore}=await import('../server/review-comment-store.js');
  const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-gui-range-store-'));
  const project=path.join(world,'project');fs.mkdirSync(project);
  let serial=0;
  const single=()=>({id:randomUUID(),path:'a.js',text:'v1 retained',createdAt:1,updatedAt:1,
    anchor:{path:'a.js',section:'working',type:'add',oldLine:null,newLine:2,hunkIndex:0,hunkHeader:'12345678',codeHash:'abcdef01',diffFingerprint:'01234567'}});
  const range=()=>{const c=single();c.text='range';c.anchor.range={version:1,lines:[{type:'add',oldLine:null,newLine:2,codeHash:'abcdef01'},{type:'add',oldLine:null,newLine:3,codeHash:'12345678'}]};return c;};
  const fixture=()=>{
    const dataDir=path.join(world,'data-'+ ++serial);fs.mkdirSync(dataDir);fs.mkdirSync(path.join(dataDir,'review-comments'));
    const scope={key:'a'.repeat(64),projectRoot:project,gitCommon:project,assertCurrent(){}};
    const file=path.join(dataDir,'review-comments',scope.key+'.json'), old={version:1,scope:scope.key,revision:randomUUID(),comments:[single()]};
    const bytes=JSON.stringify(old)+'\n';fs.writeFileSync(file,bytes);
    return {dataDir,scope,file,old,bytes,store:createReviewCommentStore({dataDir})};
  };
  try{
    const f=fixture();
    check('reading v1 leaves bytes and revision unchanged',()=>{assert.deepEqual(f.store.read(f.scope),{revision:f.old.revision,comments:f.old.comments});assert.equal(fs.readFileSync(f.file,'utf8'),f.bytes);});
    let next;
    check('adding range atomically upgrades v1 while preserving original singles',()=>{
      next=f.store.write(f.scope,f.old.revision,[...f.old.comments,range()]);
      assert.equal(JSON.parse(fs.readFileSync(f.file,'utf8')).version,2);assert.deepEqual(next.comments[0],f.old.comments[0]);
    });
    check('v2 survives a store restart and retains the original scope key',()=>{assert.deepEqual(createReviewCommentStore({dataDir:f.dataDir}).read(f.scope),next);assert.equal(JSON.parse(fs.readFileSync(f.file,'utf8')).scope,f.old.scope);});
    check('an old instance with v1 revision cannot overwrite the upgrade',()=>{assert.throws(()=>f.store.write(f.scope,f.old.revision,[]),e=>e.code==='comment_conflict');});
    check('editing v1 and range together preserves anchors and ids',()=>{const records=structuredClone(next.comments);records.forEach(c=>{c.text+=' edited';c.updatedAt++;});next=f.store.write(f.scope,next.revision,records);assert.deepEqual(f.store.read(f.scope),next);});
    check('deleting range retains v2 and old single',()=>{next=f.store.write(f.scope,next.revision,[next.comments[0]]);assert.equal(JSON.parse(fs.readFileSync(f.file,'utf8')).version,2);assert.equal(next.comments[0].id,f.old.comments[0].id);});
    check('deleting all preserves v2 revision tombstone',()=>{next=f.store.write(f.scope,next.revision,[]);assert.equal(JSON.parse(fs.readFileSync(f.file,'utf8')).version,2);assert.deepEqual(createReviewCommentStore({dataDir:f.dataDir}).read(f.scope),next);});
    for(const stage of ['write','flush','rename'])check(stage+' failure preserves exact v1 bytes and allows explicit retry',()=>{
      const g=fixture(),io=Object.create(fs),method={write:'writeFileSync',flush:'fsyncSync',rename:'renameSync'}[stage];
      io[method]=()=>{throw Object.assign(Error('fixture failure'),{code:'ENOSPC'});};
      assert.throws(()=>createReviewCommentStore({dataDir:g.dataDir,io}).write(g.scope,g.old.revision,[...g.old.comments,range()]),e=>e.code==='comment_storage_write_failed');
      assert.equal(fs.readFileSync(g.file,'utf8'),g.bytes);assert.equal(fs.readdirSync(path.dirname(g.file)).length,1);
      assert.equal(g.store.write(g.scope,g.old.revision,[...g.old.comments,range()]).comments.length,2);
    });
    check('upgrade holds the same cross-instance writer lock',()=>{
      const g=fixture(),other=createReviewCommentStore({dataDir:g.dataDir});
      const store=createReviewCommentStore({dataDir:g.dataDir,checkpoint(){assert.throws(()=>other.write(g.scope,g.old.revision,[]),e=>e.code==='comment_storage_busy');}});
      store.write(g.scope,g.old.revision,[range()]);assert.equal(other.read(g.scope).comments[0].text,'range');
    });
    for(const [label,mutation] of [['future',v=>v.version=99],['v1 range',v=>v.comments.push(range())],['unknown range version',v=>{v.version=2;v.comments=[range()];v.comments[0].anchor.range.version=99;}],['source leakage',v=>{v.version=2;v.comments=[range()];v.comments[0].anchor.range.lines[1].source='not allowed';}]])check(label+' refuses read and overwrite, preserves original',()=>{
      const g=fixture(),v=structuredClone(g.old);mutation(v);const bytes=JSON.stringify(v);fs.writeFileSync(g.file,bytes);
      assert.throws(()=>g.store.read(g.scope),e=>e.code==='comment_storage_corrupt');
      assert.throws(()=>g.store.write(g.scope,g.old.revision,[]),e=>e.code==='comment_storage_corrupt');assert.equal(fs.readFileSync(g.file,'utf8'),bytes);
    });
    check('corrupt v2 bytes remain intact',()=>{const g=fixture();fs.writeFileSync(g.file,'{"version":2,');assert.throws(()=>g.store.write(g.scope,null,[range()]));assert.equal(fs.readFileSync(g.file,'utf8'),'{"version":2,');});
    check('same data root still isolates authoritative scope keys',()=>{const g=fixture();g.store.write(g.scope,g.old.revision,[range()]);assert.deepEqual(g.store.read({...g.scope,key:'b'.repeat(64)}),{revision:null,comments:[]});});
    console.log(`Review range storage: ${checks}/${checks}; failed=0; skipped=0`);
  }finally{fs.rmSync(world,{recursive:true,force:true,maxRetries:5});}
})().catch(e=>{console.error(e);process.exitCode=1;});
