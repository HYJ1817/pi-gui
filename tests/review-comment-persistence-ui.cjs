const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { JSDOM } = require('jsdom');
let checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log('  ok '+name);};

(async()=>{
  assert.ok(fs.existsSync(path.join(__dirname,'../public/review-comment-persistence.js')),
    'T3-B must provide durable UI coordination');
  const dom=new JSDOM('<!doctype html><body></body>',{url:'http://127.0.0.1/'});
  Object.assign(global,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,CustomEvent:dom.window.CustomEvent});
  const {S}=await import('../public/state.js');
  const {setGitConversationScope}=await import('../public/api.js');
  const model=await import('../public/diff-comments.js');
  const p=await import('../public/review-comment-persistence.js');
  S.cwd='C:\\fixture-a';S.state={sessionId:'classic-a'};S.workspaceGeneration=1;
  S.legacyOwner={sessionId:'classic-a'};
  const disk=new Map();let held=null,holdRead=false,holdWrite=false,failWrite=false,conflict=false,unavailable=false;
  const calls=[];
  global.fetch=async(url,options={})=>{
    assert.equal(String(url),'/api/review-comments');
    calls.push({url:String(url),options});
    const key=options.headers?.['X-Pi-Gui-Conversation']||S.state.sessionId;
    const scope=(key==='A'?'a':key==='B'?'b':'c').repeat(64);
    const value=disk.get(key)||{revision:null,comments:[]};
    let answer;
    if(options.method==='POST'){
      const body=JSON.parse(options.body);
      assert.equal(JSON.stringify(body).includes('private code snippet'),false);
      if(failWrite)answer={ok:false,code:'comment_storage_write_failed'};
      else if(conflict||body.revision!==value.revision)answer={ok:false,code:'comment_conflict'};
      else {const next={revision:randomUUID(),comments:structuredClone(body.comments)};disk.set(key,next);answer={ok:true,scope,token:'d'.repeat(64),...next};}
      if(holdWrite){holdWrite=false;return new Promise(resolve=>{held=()=>resolve({json:async()=>answer});});}
    }else{
      answer=unavailable?{ok:false,code:'comment_storage_corrupt'}:{ok:true,scope,token:'d'.repeat(64),...structuredClone(value)};
      if(holdRead){holdRead=false;return new Promise(resolve=>{held=()=>resolve({json:async()=>answer});});}
    }
    return {json:async()=>answer};
  };
  const input={path:'a.js',text:'请核对这一行',anchor:{path:'a.js',section:'working',type:'add',oldLine:null,newLine:1,
    hunkIndex:0,hunkHeader:'12345678',codeHash:'abcdef01',diffFingerprint:'01234567',snippet:'private code snippet'}};
  try{
    setGitConversationScope('A');
    await check('lazy restore reports loading before accepting current scope',async()=>{
      holdRead=true;const loading=p.loadReviewComments();assert.equal(p.reviewPersistenceState().status,'loading');
      assert.equal(model.commentCount(),0);held();assert.equal((await loading).ok,true);assert.equal(p.reviewPersistenceState().status,'ready');
    });
    let created;
    await check('save waits for durable acknowledgement before changing saved comments',async()=>{
      holdWrite=true;const saving=p.saveReviewComment(input);await Promise.resolve();
      assert.equal(p.reviewPersistenceState().status,'saving');assert.equal(model.commentCount(),0);
      held();created=await saving;assert.equal(created.ok,true);assert.equal(model.commentCount(),1);
    });
    await check('outbound payload contains bounded metadata rather than code snippets or UI scope',()=>{
      const body=JSON.parse(calls.find(c=>c.options.method==='POST').options.body);
      assert.equal(body.scope,'a'.repeat(64));assert.equal('snippet' in body.comments[0].anchor,false);
      assert.equal('scope' in body.comments[0],false);assert.equal('cwd' in body,false);
    });
    await check('restore never claims the old anchor is already verified',async()=>{
      await p.loadReviewComments({force:true});assert.equal(model.commentsForScope()[0].verified,false);
    });
    await check('a failed edit preserves the last saved comment',async()=>{
      failWrite=true;const before=model.commentsForScope()[0].text;
      const result=await p.saveReviewComment({...input,commentId:created.comment.id,text:'未保存的新内容'});
      assert.equal(result.ok,false);assert.equal(model.commentsForScope()[0].text,before);failWrite=false;
    });
    await check('explicit reload and retry saves the edited content',async()=>{
      await p.loadReviewComments({force:true});const result=await p.saveReviewComment({...input,commentId:created.comment.id,text:'已修改'});
      assert.equal(result.ok,true);assert.equal(model.commentsForScope()[0].text,'已修改');
    });
    await check('revision conflict is explicit and never last-write-wins',async()=>{
      conflict=true;const result=await p.removeReviewComment(created.comment.id);
      assert.equal(result.ok,false);assert.equal(p.reviewPersistenceState().status,'conflict');assert.equal(model.commentCount(),1);conflict=false;
    });
    await check('confirmed delete remains absent after reloading',async()=>{
      await p.loadReviewComments({force:true});assert.equal((await p.removeReviewComment(created.comment.id)).ok,true);
      await p.loadReviewComments({force:true});assert.equal(model.commentCount(),0);assert.deepEqual(disk.get('A').comments,[]);
    });
    await check('late loading response cannot land after switching conversations',async()=>{
      const existing={...input,id:randomUUID(),createdAt:1,updatedAt:1};delete existing.anchor.snippet;
      disk.set('A',{revision:randomUUID(),comments:[existing]});holdRead=true;
      const old=p.loadReviewComments({force:true});setGitConversationScope('B');await p.loadReviewComments();held();
      assert.equal((await old).ok,false);assert.equal(model.commentCount(),0);assert.equal(p.reviewPersistenceState().scope,'b'.repeat(64));
    });
    await check('late save acknowledgement cannot change the next conversation',async()=>{
      holdWrite=true;const saving=p.saveReviewComment({...input,text:'B 的评论'});await Promise.resolve();
      setGitConversationScope('A');await p.loadReviewComments();held();await saving;
      assert.equal(model.commentsForScope()[0].text,input.text);assert.equal(model.commentsForScope().some(c=>c.text==='B 的评论'),false);
    });
    await check('project and classic session invalidation stops old responses',async()=>{
      setGitConversationScope(null);holdRead=true;const old=p.loadReviewComments();
      document.dispatchEvent(new window.CustomEvent('pi-gui:session-switch'));
      S.state={sessionId:'classic-b'};held();assert.equal((await old).ok,false);assert.equal(model.commentCount(),0);
    });
    await check('corrupt storage is unavailable and does not issue writes',async()=>{
      unavailable=true;await p.loadReviewComments({force:true});const before=calls.length;
      assert.equal(p.reviewPersistenceState().status,'unavailable');
      assert.equal((await p.saveReviewComment(input)).ok,false);assert.equal(calls.length,before);unavailable=false;
    });
    await check('owner replacement without a scope event releases a pending load for explicit retry',async()=>{
      holdRead=true;const old=p.loadReviewComments({force:true});
      S.legacyOwner={...S.legacyOwner,runtimeGeneration:'changed'};held();
      assert.equal((await old).ok,false);assert.equal(p.reviewPersistenceState().status,'idle');
    });
    await check('owner replacement releases pending save without accepting the old acknowledgement',async()=>{
      await p.loadReviewComments({force:true});holdWrite=true;const old=p.saveReviewComment({...input,text:'older owner'});
      await Promise.resolve();S.legacyOwner={...S.legacyOwner,runtimeGeneration:'changed-again'};held();
      assert.equal((await old).ok,false);assert.equal(p.reviewPersistenceState().status,'idle');
      assert.equal(model.commentCount(),0);
    });
    await check('the coordinator never uses localStorage or sends Agent commands',()=>{
      assert.equal(localStorage.length,0);assert.equal(calls.every(c=>c.url==='/api/review-comments'),true);
    });
    await check('range write confirmation obeys the same old-response owner barrier',async()=>{
      setGitConversationScope('B');await p.loadReviewComments({force:true});
      const range=structuredClone(input);range.anchor.newLine=100;range.text='range from B';
      range.anchor.range={version:1,lines:[{type:'add',oldLine:null,newLine:100,codeHash:'abcdef01'},{type:'add',oldLine:null,newLine:101,codeHash:'12345678'}]};
      holdWrite=true;const saving=p.saveReviewComment(range);await Promise.resolve();
      assert.equal(p.reviewPersistenceState().status,'saving');
      setGitConversationScope('A');await p.loadReviewComments({force:true});held();assert.equal((await saving).ok,false);
      assert.equal(model.commentsForScope().some(c=>c.anchor.range),false);
      setGitConversationScope('B');await p.loadReviewComments({force:true});
      assert.equal(model.commentsForScope().find(c=>c.anchor.range).text,'range from B');
      assert.equal(model.commentsForScope().find(c=>c.anchor.range).verified,false);
    });
    console.log(`Review comment persistence UI: ${checks}/${checks}; skipped=0`);
  }finally{dom.window.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
