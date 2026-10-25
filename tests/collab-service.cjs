const assert=require('node:assert/strict');
let checks=0;
const check=(name,fn)=>{fn();checks++;console.log('ok '+name);};
(async()=>{
  const {createCollabService}=await import('../server/collab-service.js');
  const {createProposal,serialize,validateDocument}=await import('../lib/collab-doc.js');
  const docs=new Map();let writeFailure=false,current=true;
  const scope={key:'a'.repeat(64),token:'b'.repeat(64),sessionId:'session-a',assertCurrent(){if(!current)throw Object.assign(Error(),{code:'collab_scope_unavailable'});}};
  const store={read:s=>({doc:docs.get(s.key)||null}),write(s,expected,d){
    s.assertCurrent();assert.equal(docs.get(s.key)?.revision??null,expected);if(writeFailure)throw Object.assign(Error('sensitive/path'),{code:'collab_storage_write_failed'});
    docs.set(s.key,validateDocument(d));return {doc:structuredClone(d)};
  }};
  let evidence=null;
  const service=createCollabService({store,proposals:{get:()=>evidence}});
  let editor=service.execute(scope,{action:'open'}),d;
  const run=(action,extra={})=>service.execute(scope,{action,editorId:editor.editorId,expectedRevision:d?.revision??null,...extra});
  check('open creates no document or write; explicit create binds verified scope',()=>{
    assert.equal(editor.document,null);assert.equal(docs.size,0);editor=run('create');d=editor.document;
    assert.equal(d.graph.nodes.length,3);assert.equal(d.graph.edges.length,2);assert.equal(d.revision,1);assert.equal(d.boundSessionId,scope.sessionId);assert.equal('appliedOps' in d,false);
  });
  const op=(opId,label,base=d.revision)=>({opId,actor:'user',type:'node.update',baseRevision:base,params:{id:'n1',label}});
  check('user change persists; undo/redo are server controlled',()=>{
    const first=op('u1','用户');editor=run('operations',{ops:[first]});d=editor.document;assert.equal(d.graph.nodes[0].label,'用户');assert.equal(editor.canUndo,true);
    const replay=run('operations',{expectedRevision:first.baseRevision,ops:[first]});assert.equal(replay.status,'duplicate');assert.equal(replay.document.revision,d.revision);
    assert.throws(()=>run('undo',{expectedRevision:1}),e=>e.code==='collab_conflict');
    editor=run('undo');assert.equal(editor.ok,true);d=editor.document;assert.equal(d.graph.nodes[0].label,'开始');assert.equal(editor.canRedo,true);
    editor=run('redo');d=editor.document;assert.equal(d.graph.nodes[0].label,'用户');
  });
  check('failed durable write preserves document and undo stack',()=>{
    const before=serialize(docs.get(scope.key));writeFailure=true;
    assert.throws(()=>run('operations',{ops:[op('badwrite','不可提交')]}),e=>e.code==='collab_storage_write_failed');
    assert.equal(serialize(docs.get(scope.key)),before);writeFailure=false;
    editor=run('undo');d=editor.document;assert.equal(d.graph.nodes[0].label,'开始');
    editor=run('redo');d=editor.document;assert.equal(d.graph.nodes[0].label,'用户');
  });
  check('invalid actor and full document overwrite refused without persistence',()=>{
    const before=serialize(docs.get(scope.key));assert.equal(run('operations',{ops:[{...op('a1','注入'),actor:'agent'}]}).ok,false);
    assert.throws(()=>run('operations',{ops:[op('a2','注入')],document:d}),e=>e.code==='collab_invalid');assert.equal(serialize(docs.get(scope.key)),before);
  });
  check('unknown and renderer forged proposals never preview or apply',()=>{
    assert.throws(()=>run('preview',{proposalId:'unknown'}),e=>e.code==='collab_proposal_unavailable');
    assert.throws(()=>run('accept',{proposalId:'unknown',proposal:{actor:'agent'}}),e=>e.code==='collab_invalid');
  });
  check('backend-only sourced proposal preview is readonly and explicit accept is reversible',()=>{
    const proposal=createProposal({documentId:d.documentId,sessionId:scope.sessionId,baseRevision:d.revision,
      ops:[{...op('agent1','建议'),actor:'agent'}]});evidence={scopeToken:scope.token,proposal};
    const before=serialize(docs.get(scope.key));const view=run('preview',{proposalId:proposal.proposalId});
    assert.equal(view.preview.diff.length,1);assert.equal(serialize(docs.get(scope.key)),before);
    assert.equal(run('reject',{proposalId:proposal.proposalId}).status,'rejected');assert.equal(serialize(docs.get(scope.key)),before);
    editor=run('accept',{proposalId:proposal.proposalId});d=editor.document;assert.equal(d.graph.nodes[0].label,'建议');
    editor=run('undo');d=editor.document;assert.equal(d.graph.nodes[0].label,'用户');
  });
  check('old proposal conflicts and leaves current user edit intact',()=>{
    evidence={scopeToken:scope.token,proposal:createProposal({documentId:d.documentId,sessionId:scope.sessionId,baseRevision:d.revision,
      ops:[{...op('agent2','未接受的旧建议'),actor:'agent'}]})};
    editor=run('operations',{ops:[op('newer','用户后续编辑')]});d=editor.document;
    const before=serialize(docs.get(scope.key));assert.equal(run('accept',{proposalId:evidence.proposal.proposalId}).ok,false);assert.equal(serialize(docs.get(scope.key)),before);
  });
  check('external revision clears history; stale editor cannot overwrite',()=>{
    const another=service.execute(scope,{action:'open'});const updated=service.execute(scope,{action:'operations',editorId:another.editorId,expectedRevision:d.revision,ops:[op('external','另一窗口')]});
    assert.throws(()=>run('operations',{ops:[op('stale','旧修改')]}),e=>e.code==='collab_conflict');assert.equal(docs.get(scope.key).graph.nodes[0].label,'另一窗口');d=updated.document;
  });
  check('close and reopen discard undo state without losing saved document',()=>{
    service.execute(scope,{action:'close',editorId:editor.editorId});assert.throws(()=>run('undo'),e=>e.code==='collab_editor_expired');
    editor=service.execute(scope,{action:'open'});d=editor.document;assert.equal(editor.canUndo,false);assert.equal(d.graph.nodes[0].label,'另一窗口');
  });
  check('old owner token and wrong scope cannot reuse an editor',()=>{
    assert.throws(()=>service.execute({...scope,token:'c'.repeat(64)},{action:'undo',editorId:editor.editorId,expectedRevision:d.revision}),e=>e.code==='collab_scope_unavailable');
    editor=service.execute(scope,{action:'open'});
    assert.throws(()=>service.execute({...scope,key:'d'.repeat(64)},{action:'undo',editorId:editor.editorId,expectedRevision:d.revision}),e=>e.code==='collab_scope_unavailable');
    assert.equal(run('undo').code,'collab_undo_empty');
  });
  check('scope invalidation prevents even readonly open',()=>{current=false;assert.throws(()=>service.execute(scope,{action:'open'}),e=>e.code==='collab_scope_unavailable');current=true;});
  check('unconfigured production source remains honestly unavailable',()=>{
    const production=createCollabService({store});const open=production.execute(scope,{action:'open'});assert.equal(open.proposalSourceAvailable,false);
    assert.throws(()=>production.execute(scope,{action:'accept',editorId:open.editorId,expectedRevision:d.revision,proposalId:'p1'}),e=>e.code==='collab_proposal_unavailable');
  });
  check('capacity eviction keeps a recently active editor and expires the least active',()=>{
    let clock=1;const bounded=createCollabService({store,now:()=>clock});const entries=[];
    for(let i=0;i<32;i++){clock++;entries.push(bounded.execute(scope,{action:'open'}));}
    clock++;const request={action:'undo',editorId:entries[0].editorId,expectedRevision:d.revision};
    assert.equal(bounded.execute(scope,request).code,'collab_undo_empty');clock++;bounded.execute(scope,{action:'open'});
    assert.equal(bounded.execute(scope,request).code,'collab_undo_empty');
    assert.throws(()=>bounded.execute(scope,{...request,editorId:entries[1].editorId}),e=>e.code==='collab_editor_expired');
  });
  console.log(`Collab service: ${checks}/${checks}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
