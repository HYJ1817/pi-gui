const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {randomUUID}=require('node:crypto');
let checks=0;const check=async(name,fn)=>{await fn();checks++;console.log('  ok '+name);};
(async()=>{
  assert.ok(fs.existsSync(path.join(__dirname,'../server/review-comment-routes.js')),'T3-B must provide bounded authenticated persistence routes');
  const {createReviewCommentRoutes}=await import('../server/review-comment-routes.js');
  const {createReviewCommentStore}=await import('../server/review-comment-store.js');
  const {createRouter}=await import('../server/router.js');
  const {createAuth}=await import('../server/auth.js');
  const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-gui-comment-http-'));
  const dataDir=path.join(world,'data'),project=path.join(world,'project');fs.mkdirSync(dataDir);fs.mkdirSync(project);
  let current='A',currentOwner='owner-A';const key=id=>(id==='A'?'a':'b').repeat(64);
  const scopes=new Map();let handled=0;
  const routes=createReviewCommentRoutes({store:createReviewCommentStore({dataDir}),withAuthority:async(req,action)=>{
    const selected=req.headers['x-pi-gui-conversation'];
    if(selected!==current||req.headers['x-pi-gui-owner']!==currentOwner)throw Object.assign(Error('comment_scope_unavailable'),{code:'comment_scope_unavailable'});
    const scope={key:key(current),token:key(current),projectRoot:project,gitCommon:project,assertCurrent(){
      if(selected!==current||req.headers['x-pi-gui-owner']!==currentOwner)throw Object.assign(Error('comment_scope_unavailable'),{code:'comment_scope_unavailable'});
    }};scopes.set(current,scope);handled++;return action(scope);
  }});
  const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port,base='http://127.0.0.1:'+port,token='fixture-only';
  server.on('request',createRouter({auth:createAuth({port,token}),reviewComments:routes}));
  async function request(method='GET',body,extra={}){
    const response=await fetch(base+'/api/review-comments',{method,headers:{'x-pi-gui-token':token,'x-pi-gui-conversation':current,'x-pi-gui-owner':currentOwner,...extra},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  }
  let state;
  const makeComment=()=>({id:randomUUID(),path:'a.js',text:'sensitive-comment',createdAt:1,updatedAt:1,
    anchor:{path:'a.js',section:'working',type:'add',oldLine:null,newLine:1,hunkIndex:0,hunkHeader:'12345678',codeHash:'abcdef01',diffFingerprint:'01234567'}});
  try{
    await check('router authenticates reads before resolving any scope',async()=>{
      const before=handled;const r=await fetch(base+'/api/review-comments');assert.equal(r.status,401);assert.equal(handled,before);
    });
    await check('cross-origin writes are denied by the existing auth boundary',async()=>{
      const r=await request('POST',{}, {origin:'https://evil.invalid'});assert.equal(r.status,403);
    });
    await check('GET returns a backend-issued scope and revision',async()=>{
      const r=await request();assert.equal(r.status,200);assert.equal(r.body.ok,true);assert.equal(r.body.scope,key('A'));assert.equal(r.body.revision,null);state=r.body;
    });
    await check('caller cannot supply another conversation authority',async()=>{
      const r=await request('GET',undefined,{'x-pi-gui-conversation':'B'});assert.equal(r.status,409);assert.equal(r.body.code,'comment_scope_unavailable');
    });
    await check('POST persists bounded comments and returns the committed revision',async()=>{
      const r=await request('POST',{scope:state.scope,token:state.token,revision:state.revision,comments:[makeComment()]});
      assert.equal(r.status,200);assert.equal(r.body.comments.length,1);assert.equal(typeof r.body.revision,'string');state=r.body;
    });
    for(const extra of [{path:'../source.js'},{cwd:project},{sessionId:'other'},{owner:'forged'},{action:'restore'}]){
      await check('unknown request fields cannot expand file or session authority',async()=>{
        const r=await request('POST',{scope:state.scope,token:state.token,revision:state.revision,comments:[],...extra});assert.equal(r.status,400);assert.equal(r.body.code,'comment_invalid');
      });
    }
    await check('forged permanent scope and stale context tokens are refused',async()=>{
      for(const patch of [{scope:key('B')},{token:key('B')}]){
        const r=await request('POST',{scope:state.scope,token:state.token,revision:state.revision,comments:[],...patch});assert.equal(r.status,409);
      }
      assert.equal((await request()).body.comments.length,1);
    });
    await check('revision conflicts do not delete confirmed comments',async()=>{
      const r=await request('POST',{scope:state.scope,token:state.token,revision:null,comments:[]});assert.equal(r.status,409);assert.equal(r.body.code,'comment_conflict');
      assert.equal((await request()).body.comments.length,1);
    });
    await check('malformed and oversized JSON are bounded and never echoed',async()=>{
      for(const input of ['{','private-text-'.repeat(200000)]){
        const r=await request('POST',input);assert.ok([400,413].includes(r.status));assert.equal(JSON.stringify(r.body).includes('private-text'),false);
      }
    });
    await check('malformed UTF-8 cannot silently alter a submitted comment',async()=>{
      const bytes=Buffer.from(JSON.stringify({scope:state.scope,token:state.token,revision:state.revision,comments:state.comments}));
      bytes[bytes.indexOf('sensitive-comment')]=0xff;
      const response=await fetch(base+'/api/review-comments',{method:'POST',headers:{'x-pi-gui-token':token,'x-pi-gui-conversation':current,'x-pi-gui-owner':currentOwner},body:bytes});
      assert.equal(response.status,400);assert.deepEqual((await request()).body.comments,state.comments);
    });
    await check('authenticated range roundtrip preserves the single and rejects forged row evidence',async()=>{
      const range=makeComment();range.anchor.range={version:1,lines:[{type:'add',oldLine:null,newLine:1,codeHash:'abcdef01'},{type:'add',oldLine:null,newLine:2,codeHash:'12345678'}]};
      let r=await request('POST',{scope:state.scope,token:state.token,revision:state.revision,comments:[...state.comments,range]});
      assert.equal(r.status,200);assert.deepEqual((await request()).body.comments,r.body.comments);state=r.body;
      const bad=structuredClone(state.comments);bad[1].anchor.range.lines[1].source='private source';
      r=await request('POST',{scope:state.scope,token:state.token,revision:state.revision,comments:bad});assert.equal(r.status,400);assert.deepEqual((await request()).body.comments,state.comments);
      // Return to the original single snapshot for the original isolation tests.
      r=await request('POST',{scope:state.scope,token:state.token,revision:state.revision,comments:[state.comments[0]]});assert.equal(r.status,200);state=r.body;
    });
    await check('switching scope cannot read or delete the previous scope',async()=>{
      current='B';currentOwner='owner-B';assert.equal((await request()).body.comments.length,0);
      const r=await request('POST',{scope:state.scope,token:state.token,revision:state.revision,comments:[]});assert.equal(r.status,409);
      current='A';currentOwner='owner-A';assert.equal((await request()).body.comments.length,1);
    });
    await check('corrupt storage is reported without echoing comments or overwriting original data',async()=>{
      const file=path.join(dataDir,'review-comments',key('A')+'.json');fs.writeFileSync(file,'sensitive-comment {broken');
      const r=await request();assert.equal(r.status,409);assert.equal(r.body.code,'comment_storage_corrupt');
      assert.equal(JSON.stringify(r.body).includes('sensitive-comment'),false);
      const saved=await request('POST',{scope:state.scope,token:state.token,revision:state.revision,comments:[]});assert.equal(saved.status,409);
      assert.equal(fs.readFileSync(file,'utf8'),'sensitive-comment {broken');
    });
    await check('unsupported methods never create files',async()=>{assert.equal((await request('PUT',{})).status,405);});
    console.log(`Review comment HTTP: ${checks}/${checks}; skipped=0`);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(world,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
