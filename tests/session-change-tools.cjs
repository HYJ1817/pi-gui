const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const modulePath = path.resolve(__dirname, '../extensions/pi-gui-revert/index.js');
  assert.equal(require('node:fs').existsSync(modulePath), true, 'session capture extension exists');
  const { default: defaultExtension, installSessionChangeExtension, transport } = await import(pathToFileURL(modulePath));
  let passed = 0;
  const check = (name, fn) => async () => { await fn(); passed++; console.log(`ok ${passed} - ${name}`); };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-change-tools-'));
  const hooks = new Map(), tools = new Map(), commands = new Map(), posts = [];
  const builtin = name => ({ name, sourceInfo: { source: 'builtin', path: `builtin:${name}` } });
  const all = new Map(['write','edit','read','bash'].map(n => [n,builtin(n)]));
  const pi = { on(n,f) { const a=hooks.get(n)||[]; a.push(f); hooks.set(n,a); }, getAllTools:()=>[...all.values()],
    registerTool(t) { tools.set(t.name,t); all.set(t.name,{...t,sourceInfo:{path:'fixture-own'}}); }, registerCommand(n,c) { commands.set(n,c); } };
  let enabled = false, rejectAt = '', afterPrepare = null, corrupt=false, userDisabled=false;
  const connection = { async post(endpoint,body) { posts.push({endpoint,body});
    if(corrupt) { if(endpoint==='/configure'&&body.enabled===false) { userDisabled=true;enabled=false;return {ok:true,enabled:false,persisted:false,reason:'disabled_not_persisted'}; } if(endpoint==='/state'&&userDisabled) return {ok:true,enabled:false,exclusions:[],sourceVerified:false}; throw Error('SECRET CORRUPT STORE'); }
    if(endpoint===rejectAt) throw Error('SECRET RAW');
    if(endpoint==='/prepare'&&afterPrepare) await afterPrepare(body);
    if(endpoint==='/configure') { if(body.enabled&&!body.acknowledged) throw Error('consent required'); enabled=body.enabled; }
    return {ok:true,enabled,exclusions:[],sourceVerified:true}; } };
  // Public operation contracts, with the same order as Pi's definitions. No installed Pi dependency.
  function factory(name) { return (cwd, options={}) => ({name, parameters:{type:'object'}, prepareArguments: x=>x, renderCall:()=>name,
    async execute(id,args,signal,update,ctx) { const p=path.resolve(ctx.cwd,args.path), ops=options.operations;
      if(name==='write') { if(ops) await ops.mkdir(path.dirname(p)); else await fs.mkdir(path.dirname(p),{recursive:true}); }
      let content=args.content;
      if(name==='edit') { if(ops) await ops.access(p); const b=ops?await ops.readFile(p):await fs.readFile(p); content=b.toString().replace(args.oldText,args.newText); if(content===b.toString()) throw Error('Text not found'); }
      if(ops) await ops.writeFile(p,content); else await fs.writeFile(p,content);
      if(signal?.aborted) throw Error('Operation aborted');
      return {content:[{type:'text',text:'official result'}],details:{official:true}};
    } }); }
  const ctx = {cwd:root,sessionManager:{getSessionId:()=> 'native-fixture'},ui:{confirm:async()=>true}};
  const emit = async (name,event={}) => { let result; for(const hook of hooks.get(name)||[]) result=await hook(event,ctx)||result; return result; };
  const run = async (name,args,id='call-1',signal) => { await emit('tool_call',{toolName:name,toolCallId:id,input:args}); return tools.get(name).execute(id,args,signal,()=>{},ctx); };
  let fileOpens=0;
  const trackedFs={...fs,open(...args){fileOpens++;return fs.open(...args);}};
  installSessionChangeExtension(pi,{createWriteToolDefinition:factory('write'),createEditToolDefinition:factory('edit'),connection,ownSource:'fixture-own',fs:trackedFs});
  try {
    await check('default extension imports the backend supplied public entry URL',async()=>{
      const keys=['PI_GUI_SESSION_CHANGE_URL','PI_GUI_SESSION_CHANGE_TOKEN','PI_GUI_SESSION_CHANGE_API']; const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
      const entry=path.join(root,'public-entry.mjs'); await fs.writeFile(entry,'export function createWriteToolDefinition(){return {name:"write",parameters:{type:"object"},renderCall:()=>"public-entry",execute:async()=>({content:[]})};} export function createEditToolDefinition(){return {...createWriteToolDefinition(),name:"edit"};}');
      let start; const registered=[]; const api={on(n,f){if(n==='session_start')start=f;},registerCommand(){},getAllTools:()=>['write','edit'].map(builtin),registerTool:t=>registered.push(t)};
      try { process.env.PI_GUI_SESSION_CHANGE_URL='http://127.0.0.1:1';process.env.PI_GUI_SESSION_CHANGE_TOKEN='fixture-token';process.env.PI_GUI_SESSION_CHANGE_API=pathToFileURL(entry).href;
        await defaultExtension(api); await start({},ctx); assert.equal(registered[0].renderCall(),'public-entry');
      } finally { for(const key of keys) {if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];} }
    })();
    await check('missing public entry fails with a fixed API unavailable error',async()=>{
      const keys=['PI_GUI_SESSION_CHANGE_URL','PI_GUI_SESSION_CHANGE_TOKEN','PI_GUI_SESSION_CHANGE_API'];const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
      try {process.env.PI_GUI_SESSION_CHANGE_URL='http://127.0.0.1:1';process.env.PI_GUI_SESSION_CHANGE_TOKEN='fixture-token';delete process.env.PI_GUI_SESSION_CHANGE_API; await assert.rejects(defaultExtension({}),e=>e.message==='pi_api_unavailable');process.env.PI_GUI_SESSION_CHANGE_API='https://example.com/index.js';await assert.rejects(defaultExtension({}),e=>e.message==='pi_api_unavailable');}
      finally {for(const key of keys){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}}
    })();
    await check('session_start does not wait on RPC-dependent bridge authority',async()=>{
      let start, resolveHello; const info=new Map(['write','edit'].map(n=>[n,builtin(n)]));
      const startupPi={on(n,f){if(n==='session_start')start=f;},registerCommand(){},getAllTools:()=>[...info.values()],registerTool(t){info.set(t.name,{...t,sourceInfo:{path:'startup-own'}});}};
      installSessionChangeExtension(startupPi,{createWriteToolDefinition:factory('write'),createEditToolDefinition:factory('edit'),ownSource:'startup-own',connection:{post:()=>new Promise(resolve=>{resolveHello=resolve;})}});
      const result=await Promise.race([start({},ctx).then(()=> 'returned'),new Promise(resolve=>setTimeout(()=>resolve('blocked'),100))]);
      resolveHello({ok:true}); assert.equal(result,'returned');
    })();
    await check('private HTTP transport uses token and sanitizes rejections',async()=>{
      const server=require('node:http').createServer((req,res)=>{ assert.equal(req.headers['x-pi-session-change-token'],'private-token'); let bytes='';req.on('data',b=>bytes+=b);req.on('end',()=>{assert.equal(JSON.parse(bytes).nativeSessionId,'native-fixture');res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,code:'SECRET RAW'}));}); });
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      try { await assert.rejects(transport({url:`http://127.0.0.1:${server.address().port}`,token:'private-token'},'/state',{nativeSessionId:'native-fixture'}),e=>e.message==='capture_failed'); await assert.rejects(transport({url:'http://example.com',token:'private-token'},'/state',{}),e=>e.message==='capture_failed'); }
      finally { await new Promise(resolve=>server.close(resolve)); }
    })();
    await check('late registration preserves official public metadata',async()=>{ assert.equal(tools.size,0); await emit('session_start'); assert.equal(tools.get('write').renderCall(),'write'); assert.equal(typeof tools.get('edit').prepareArguments,'function'); })();
    await check('default off writes normally and records a durable gap',async()=>{ await run('write',{path:'a.txt',content:'old'}); assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'old'); assert(posts.some(p=>p.endpoint==='/gap')); assert(!posts.some(p=>p.endpoint==='/before')); })();
    await commands.get('gui-capture').handler('enable',ctx);
    await check('write records durable B and A then independently observed P',async()=>{ posts.length=0; const result=await run('write',{path:'a.txt',content:'new'}); assert.equal(result.details.official,true); assert.deepEqual(posts.filter(p=>['/before','/prepare','/settle'].includes(p.endpoint)).map(p=>p.endpoint),['/before','/prepare','/settle']); const before=posts.find(p=>p.endpoint==='/before').body, settle=posts.find(p=>p.endpoint==='/settle').body; assert.equal(Buffer.from(before.before,'base64').toString(),'old'); assert.equal(Buffer.from(settle.observedAfter,'base64').toString(),'new'); assert.equal(settle.evidenceLevel,'intent_verified'); })();
    await check('prepare failure prevents writes and directory side effects',async()=>{ rejectAt='/prepare'; await assert.rejects(run('write',{path:'missing/a.txt',content:'bad'}),/capture_failed/); rejectAt=''; await assert.rejects(fs.stat(path.join(root,'missing')),/ENOENT/); })();
    await check('edit uses its actual operation B and preserves ordinary error',async()=>{ posts.length=0; await run('edit',{path:'a.txt',oldText:'new',newText:'edited'}); assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'edited'); await assert.rejects(run('edit',{path:'a.txt',oldText:'absent',newText:'x'}),/Text not found/); })();
    await check('concurrent modification after prepare rejects stale overwrite',async()=>{ posts.length=0; afterPrepare=()=>fs.writeFile(path.join(root,'a.txt'),'external'); await assert.rejects(run('write',{path:'a.txt',content:'clobber'}),/capture_conflict/); afterPrepare=null; assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'external'); assert.equal(posts.find(p=>p.endpoint==='/settle').body.mutationOutcome,'unknown'); })();
    await check('outside workspace and hard links are rejected without mutation',async()=>{ await assert.rejects(run('write',{path:'../escape.txt',content:'x'}),/capture_path/); await fs.link(path.join(root,'a.txt'),path.join(root,'hard.txt')); await assert.rejects(run('write',{path:'hard.txt',content:'x'}),/capture_path/); await fs.unlink(path.join(root,'hard.txt')); })();
    await check('abort after mutation still settles actual bytes',async()=>{ const controller=new AbortController(); afterPrepare=()=>{controller.abort();}; posts.length=0; await assert.rejects(run('write',{path:'a.txt',content:'aborted'},'aborted-call',controller.signal),/Operation aborted/); afterPrepare=null; const settle=posts.find(p=>p.endpoint==='/settle').body; assert.equal(settle.toolOutcome,'aborted'); assert.equal(Buffer.from(settle.observedAfter,'base64').toString(),'aborted'); })();
    await check('unknown tools create a durable coverage gap',async()=>{ posts.length=0; await emit('tool_call',{toolName:'bash',toolCallId:'bash-call'}); assert(posts.some(p=>p.endpoint==='/gap')); })();
    await check('excluded policy is checked before reading or transporting private bytes',async()=>{rejectAt='/policy';for(const name of ['write','edit']){posts.length=0;const opened=fileOpens;await assert.rejects(run(name,{path:'a.txt',content:'bad',oldText:'aborted',newText:'bad'}),/capture_failed/);assert.equal(fileOpens,opened);assert(posts.some(p=>p.endpoint==='/policy'));assert(!posts.some(p=>p.endpoint==='/before'||p.endpoint==='/prepare'||p.endpoint==='/settle'));}rejectAt='';})();
    await check('before failure prevents mutation without leaking transport details',async()=>{ rejectAt='/before'; await assert.rejects(run('write',{path:'a.txt',content:'bad'}),error=>error.message==='capture_failed'); rejectAt=''; assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'aborted'); })();
    await check('settle failure reports capture failure after mutation',async()=>{ rejectAt='/settle'; await assert.rejects(run('write',{path:'a.txt',content:'settle-failed'}),error=>error.message==='capture_failed'); rejectAt=''; assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'settle-failed'); })();
    await check('oversized before content cannot be overwritten',async()=>{ await fs.writeFile(path.join(root,'large.txt'),Buffer.alloc(2*1024*1024+1)); await assert.rejects(run('write',{path:'large.txt',content:'bad'}),/capture_path/); assert.equal((await fs.stat(path.join(root,'large.txt'))).size,2*1024*1024+1); })();
    await check('symlink paths are rejected',async()=>{ await fs.mkdir(path.join(root,'real')); await fs.symlink(path.join(root,'real'),path.join(root,'linked'),'junction'); await assert.rejects(run('write',{path:'linked/a.txt',content:'bad'}),/capture_path/); await assert.rejects(fs.stat(path.join(root,'real','a.txt')),/ENOENT/); })();
    await check('cancelled user consent cannot enable capture',async()=>{ await commands.get('gui-capture').handler('disable',ctx); posts.length=0; await commands.get('gui-capture').handler('enable',{...ctx,ui:{confirm:async()=>false}}); assert.equal(enabled,false); assert(!posts.some(p=>p.endpoint==='/configure')); await commands.get('gui-capture').handler('enable',ctx); })();
    await check('exclude command preserves existing enabled consent',async()=>{ posts.length=0; await commands.get('gui-capture').handler('exclude private',ctx); const config=posts.find(p=>p.endpoint==='/configure').body; assert.equal(config.enabled,true); assert.deepEqual(config.exclusions,['private']); })();
    await check('new directories are explicitly incomplete evidence',async()=>{ posts.length=0; await run('write',{path:'new-dir/a.txt',content:'new directory'}); const settle=posts.find(p=>p.endpoint==='/settle').body; assert.equal(settle.evidenceLevel,'incomplete'); assert(posts.some(p=>p.endpoint==='/gap'&&p.body.reason==='incomplete')); })();
    await check('nested caller identity remains explicitly untracked when parent is not guarded',async()=>{ posts.length=0; await emit('tool_call',{toolName:'write',toolCallId:'nested',parentToolCallId:'bash-call'}); await tools.get('write').execute('nested',{path:'a.txt',content:'nested'},undefined,()=>{},ctx); const before=posts.find(p=>p.endpoint==='/before').body; assert.equal(before.parentOperationId,null); assert(posts.some(p=>p.endpoint==='/gap'&&p.body.reason==='incomplete')); })();
    await check('native session change is reflected before the next operation',async()=>{ posts.length=0; const switched={...ctx,sessionManager:{getSessionId:()=> 'native-switched'}}; await tools.get('write').execute('switched',{path:'a.txt',content:'switched'},undefined,()=>{},switched); assert.equal(posts.find(p=>p.endpoint==='/before').body.nativeSessionId,'native-switched'); assert(posts.some(p=>p.endpoint==='/hello'&&p.body.nativeSessionId==='native-switched')); })();
    await check('final tool_result failure updates outcome without rewriting B A or P',async()=>{posts.length=0;await run('write',{path:'a.txt',content:'written-before-result-hook'},'outcome-call');const settle=posts.find(p=>p.endpoint==='/settle').body;assert.equal(settle.toolOutcome,'success');assert(!posts.some(p=>p.endpoint==='/outcome'));const count=posts.filter(p=>['/before','/prepare','/settle'].includes(p.endpoint)).length;await emit('tool_execution_end',{toolCallId:'outcome-call',toolName:'write',isError:true});const outcome=posts.find(p=>p.endpoint==='/outcome').body;assert.equal(outcome.operationId,settle.operationId);assert.equal(outcome.toolOutcome,'error');assert.equal(posts.filter(p=>['/before','/prepare','/settle'].includes(p.endpoint)).length,count);assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'written-before-result-hook');})();
    await check('missing terminal tool event never fabricates an observed outcome',async()=>{posts.length=0;await run('write',{path:'a.txt',content:'no-terminal-event'},'no-terminal');assert(posts.some(p=>p.endpoint==='/settle'));assert(!posts.some(p=>p.endpoint==='/outcome'));})();
    await check('failed final outcome transport records incomplete gap and fails closed',async()=>{posts.length=0;await run('write',{path:'a.txt',content:'outcome-transport-failed'},'failed-outcome');rejectAt='/outcome';await assert.rejects(emit('tool_execution_end',{toolCallId:'failed-outcome',toolName:'write',isError:false}),/capture_failed/);rejectAt='';assert(posts.some(p=>p.endpoint==='/gap'&&p.body.reason==='incomplete'));})();
    await check('dynamic source conflict blocks before unprotected mutation',async()=>{ all.set('write',{name:'write',sourceInfo:{path:'competitor'}}); const result=await emit('tool_call',{toolName:'write',toolCallId:'conflict'}); assert.equal(result.block,true); await assert.rejects(tools.get('write').execute('conflict',{path:'a.txt',content:'bad'},undefined,()=>{},ctx),/capture_source_conflict/); })();
    await check('explicit disable bypasses a corrupt store and warns about persistence',async()=>{corrupt=true;posts.length=0;const notices=[];await commands.get('gui-capture').handler('disable',{...ctx,ui:{notify:(text,type)=>notices.push({text,type})}});assert.equal(userDisabled,true);assert.deepEqual(posts.map(p=>p.endpoint),['/configure']);assert.equal(notices.length,1);assert(!notices[0].text.includes('SECRET'));})();
    await check('disabled capture remains usable despite hello and gap failure',async()=>{posts.length=0;await run('write',{path:'disabled-corrupt.txt',content:'normal official'});await emit('tool_call',{toolName:'bash',toolCallId:'disabled-bash'});assert.equal(await fs.readFile(path.join(root,'disabled-corrupt.txt'),'utf8'),'normal official');assert(!posts.some(p=>p.endpoint==='/hello'||p.endpoint==='/before'));})();
    console.log(`session-change-tools: ${passed}/${passed}`);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
