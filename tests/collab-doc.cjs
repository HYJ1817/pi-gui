const baseAssert = require('node:assert/strict');
let assertions = 0;
const assert = new Proxy(baseAssert, {
  apply(target, receiver, args) { assertions++; return Reflect.apply(target, receiver, args); },
  get(target, key) { const value = target[key]; return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value; },
});
const fs = require('node:fs');
let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log('ok ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); } };
(async () => {
  const m = await import('../lib/collab-doc.js');
  const fresh = () => m.createFlowchartDocument({ documentId: 'diagram' });
  const proposal = d => ({ proposalId: 'p1', schemaVersion: 1, documentId: d.documentId, baseRevision: d.revision,
    sessionId: 'session-a', rationale: '改文字', ops: [{ opId: 'a1', actor: 'agent', type: 'node.update', baseRevision: d.revision, params: { id: 'n1', label: '新文字' } }] });
  const unchanged = (d, fn) => { const bytes = JSON.stringify(d); fn(); assert.equal(JSON.stringify(d), bytes); };
  for (const method of ['previewProposal', 'previewProposalReadonly', 'acceptProposal', 'rejectProposal']) {
    const invoke = (d,p) => method === 'acceptProposal' ? m[method](d, m.createEditorState(), p, { expectedRevision: d.revision }) : m[method](d,p);
    for (const [name, mutate] of [
      ['user actor', p => { p.ops[0].actor='user'; }],
      ['oversize batch', p => { p.ops=Array.from({length:51}, (_,i)=>({...p.ops[0],opId:'a'+i})); }],
      ['duplicate opId', p => { p.ops.push(structuredClone(p.ops[0])); }],
      ['mismatched operation revision', p => { p.ops[0].baseRevision++; }],
      ['missing revision', p => { delete p.baseRevision; }],
      ['missing proposalId', p => { delete p.proposalId; }],
      ['unknown envelope field', p => { p.path='../escape'; }],
      ['missing session', p => { delete p.sessionId; }],
      ['bad document id', p => { p.documentId='../x'; }],
      ['unknown version', p => { p.schemaVersion=2; }],
      ['bad params', p => { p.ops[0].params.extra=1; }],
    ]) check(method + ' independently rejects ' + name, () => { const d=fresh(),p=proposal(d); mutate(p); unchanged(d,()=>assert.equal(invoke(d,p).ok,false)); });
  }
  check('valid raw proposal read-only diff and accept/duplicate after reload', () => {
    const d=fresh(),p=proposal(d), editor=m.createEditorState();
    unchanged(d,()=>assert.equal(m.previewProposalReadonly(d,p).preview.diff.length,1));
    const next=m.acceptProposal(d,editor,p,{expectedRevision:d.revision}); assert.equal(next.ok,true);
    assert.equal(next.doc.revision,d.revision+1); assert.equal(next.doc.graph.nodes[0].label,'新文字');
    const loaded=m.deserialize(m.serialize(next.doc));
    assert.equal(m.acceptProposal(loaded,editor,p,{expectedRevision:loaded.revision}).status,'duplicate');
    const forged={...p,ops:[{...p.ops[0],actor:'user'}]};
    assert.equal(m.acceptProposal(loaded,editor,forged,{expectedRevision:loaded.revision}).ok,false);
    for (const mutate of [x=>{x.baseRevision++;},x=>{x.ops.push(structuredClone(x.ops[0]));},x=>{x.extra=1;}]) {
      const bad=structuredClone(p);mutate(bad); assert.equal(m.acceptProposal(loaded,editor,bad,{expectedRevision:loaded.revision}).ok,false);
    }
  });
  check('strict serialize rejects corrupt document rather than normalizing it away', () => {
    for(const mutate of [d=>{d.extra=1;},d=>{d.revision=Number.MAX_SAFE_INTEGER+1;},d=>{d.graph.nodes[0].exec='x';},d=>{d.appliedOps[0].fp='garbage';}]) {
      const d=fresh();mutate(d);assert.throws(()=>m.serialize(d));
    }
  });
  check('strict deserialize validates persistent journal bounds identity and fingerprint', () => {
    const d=fresh(); assert.equal(m.deserialize(m.serialize(d)).appliedOps.length,5);
    for(const mutate of [d=>{d.appliedOps.push(d.appliedOps[0]);},d=>{d.appliedOps[0].fp='{}';},d=>{d.appliedOps=Array(501).fill(d.appliedOps[0]);}]) {
      const bad=structuredClone(d);mutate(bad);assert.throws(()=>m.deserialize(JSON.stringify(bad)));
    }
  });
  check('invalid in-memory document fails all mutation entrances without throwing TypeError', () => {
    for(const d of [null,{}, {...fresh(),revision:Infinity}]) assert.equal(m.applyOperations(d,[proposal(fresh()).ops[0]]).ok,false);
  });
  check('user batch refuses agent and transaction rolls back entire failing batch', () => {
    const d=fresh(),op={opId:'u1',type:'node.update',baseRevision:d.revision,actor:'user',params:{id:'n1',label:'用户'}};
    assert.equal(m.applyUserOperations(d,[{...op,actor:'agent'}]).ok,false);
    unchanged(d,()=>assert.equal(m.applyUserOperations(d,[op,{...op,opId:'u2',params:{id:'missing',label:'失败'}}]).ok,false));
    const first=m.applyUserOperations(d,[op]); assert.equal(first.ok,true);
    const reordered={params:{label:'用户',id:'n1'},actor:'user',baseRevision:d.revision,type:'node.update',opId:'u1'};
    assert.equal(m.applyUserOperations(m.deserialize(m.serialize(first.doc)),[reordered]).status,'duplicate');
    assert.equal(m.applyUserOperations(first.doc,[op,{...op,opId:'u3'}]).ok,false);
  });
  check('undo redo is reversible for sequential changes and bounded', () => {
    let d=fresh(); const e=m.createEditorState(),initial=structuredClone(d.graph);
    const ops=[{opId:'b1',type:'node.add',baseRevision:d.revision,actor:'user',params:{id:'n4',label:'新',x:100,y:100}},
      {opId:'b2',type:'node.update',baseRevision:d.revision,actor:'user',params:{id:'n4',label:'改'}}];
    d=m.commitOperations(d,e,ops).doc; const after=structuredClone(d.graph);
    d=m.undo(d,e).doc;assert.deepEqual(d.graph,initial); d=m.redo(d,e).doc;assert.deepEqual(d.graph,after);
    for(let i=0;i<110;i++) d=m.commitOperations(d,e,[{opId:'h'+i,type:'node.update',baseRevision:d.revision,actor:'user',params:{id:'n1',x:i}}]).doc;
    assert.equal(e.undoStack.length,100);assert.equal(e.redoStack.length,0);
  });
  check('corrupt operations rejected even before duplicate idempotent path', () => {
    let d=fresh();const p=proposal(d);d=m.acceptProposal(d,null,p,{expectedRevision:d.revision}).doc;
    const corrupt=structuredClone(p);corrupt.ops[0].params.extra=1;
    assert.equal(m.acceptProposal(d,null,corrupt,{expectedRevision:d.revision}).ok,false);
  });
  check('duplicate acceptance still requires explicit valid expectedRevision', () => {
    let d=fresh();const p=proposal(d);d=m.acceptProposal(d,null,p,{expectedRevision:d.revision}).doc;
    for(const value of [undefined,null,NaN,Infinity,0,Number.MAX_SAFE_INTEGER+1]) assert.equal(m.acceptProposal(d,null,p,{expectedRevision:value}).ok,false);
  });
  check('proposal constructor enforces production actor session and operation revision', () => {
    const p=proposal(fresh());assert.equal(m.createProposal(p).ops[0].actor,'agent');
    for(const mutate of [p=>{p.ops[0].actor='user';},p=>{delete p.sessionId;},p=>{p.ops[0].baseRevision++;}]) {
      const bad=proposal(fresh());mutate(bad);assert.throws(()=>m.createProposal(bad));
    }
  });
  check('long operation IDs cannot collide in generated proposal IDs', () => {
    const a=proposal(fresh()),b=proposal(fresh());a.ops[0].opId='a'.repeat(63)+'1';b.ops[0].opId='a'.repeat(63)+'2';
    assert.notEqual(m.createProposal(a).proposalId,m.createProposal(b).proposalId);
  });
  check('mixed previously accepted and new proposal operations never report duplicate success', () => {
    let d=fresh();const p=proposal(d);d=m.acceptProposal(d,null,p,{expectedRevision:d.revision}).doc;
    const mixed=structuredClone(p);mixed.ops.push({...mixed.ops[0],opId:'new-agent-op',params:{id:'n2',label:'未应用'}});
    unchanged(d,()=>{const result=m.acceptProposal(d,null,mixed,{expectedRevision:d.revision});assert.equal(result.ok,false);assert.equal(result.code,'stale-base');});
  });
  check('production module has no prototype frontend backend IO or dependency imports', () => {
    const src=fs.readFileSync(require('node:path').join(__dirname,'../lib/collab-doc.js'),'utf8');
    assert.equal(/\b(?:import|require)\s*(?:\(|.*?from\s*['"])/.test(src),false);
  });
  console.log(`Collab production document: ${passed}/${passed+failed}; assertions=${assertions}`);process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
