const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
let passed=0;async function check(name,run){await run();passed++;console.log('PASS '+name);}
(async()=>{
 const {createOrdinarySessions}=await import('../server/ordinary-sessions.js');const {createSessions}=await import('../server/sessions.js');
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-ordinary-resolver-')),a=path.join(world,'A'),b=path.join(world,'B'),agent=path.join(world,'agent');fs.mkdirSync(a);fs.mkdirSync(b);
 let primary=null;const calls=[],projects=[{path:a},{path:b}];
 const sessions=createSessions({runtime:{getCurrentCwd:()=>a},env:{PI_CODING_AGENT_DIR:agent},getProjects:()=>projects});
 function fixture(cwd){const native=randomUUID(),dir=path.join(agent,'sessions',sessions._internals.dirNameFor(cwd));fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'2026-10-20_'+native+'.jsonl');fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id:native,cwd})+'\n');return {native,id:sessions._internals.sessionId(file),file};}
 const one=fixture(a),two=fixture(b);
 const ordinary=createOrdinarySessions({getProjects:()=>projects,sessions,currentNative:async()=>primary,resolveRoot:async p=>p,
  getRegistry:()=>({openProjectSession:async(value,options)=>{calls.push({value,options});return {ok:true};}})});
 try{
  await check('stable ID is resolved to its native file at the exact registered cwd',async()=>{await ordinary.open({project:a,session:one.id});assert.equal(calls[0].value.sessionId,one.native);assert.equal(calls[0].value.workspace.cwd,a);assert.equal(calls[0].value.sessionLocator,one.file);assert.ok(calls[0].value.sessionIdentity.ino);});
  await check('paths, native UUIDs and cross-project stable IDs cannot be substituted',async()=>{
   for(const args of [{project:a,session:one.native},{project:a,session:two.id},{project:a,session:one.id,sessionPath:one.file},{project:world,session:one.id}])await assert.rejects(()=>ordinary.open(args));assert.equal(calls.length,1);
  });
  await check('a native session already owned by classic cannot be opened by another child',async()=>{primary=one.native;await assert.rejects(()=>ordinary.open({project:a,session:one.id}),e=>e.code==='session_in_use');primary=null;});
  await check('new ordinary session keeps project cwd and bounded retry identity',async()=>{const requestId=randomUUID();await ordinary.open({project:a,requestId,allowThird:true});assert.equal(calls[1].value.requestId,requestId);assert.equal(calls[1].value.sessionId,null);assert.equal(calls[1].value.workspace.cwd,a);assert.equal(calls[1].options.allowThird,true);});
  await check('directory replacement invalidates recorded workspace epoch',async()=>{const w=await ordinary.workspaceFor(b);fs.renameSync(b,b+'-old');fs.mkdirSync(b);await assert.rejects(()=>ordinary.validate(w),e=>e.code==='stale_workspace');});
  await check('removing project registration revokes later workspace operations',async()=>{const w=await ordinary.workspaceFor(a);projects.shift();await assert.rejects(()=>ordinary.validate(w),e=>e.code==='unknown_project');});
  await check('ordinary startup instructions use a private file instead of mutating the shared project',async()=>{
    const {createProjectConfig,instructionsPath}=await import('../server/project-config.js');
    const privateFile=path.join(world,'private-instructions.md'),config=createProjectConfig({runtime:{getCurrentCwd:()=>a},instructionsFile:privateFile});
    config.write({instructions:'fixture instructions'});const launch=config.prepareLaunch();
    assert.ok(launch.args.includes(privateFile));assert.equal(fs.readFileSync(privateFile,'utf8'),'fixture instructions');assert.equal(fs.existsSync(instructionsPath(a)),false);
  });
  console.log(`Ordinary session resolver: ${passed}/${passed}`);
 }finally{fs.rmSync(world,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
