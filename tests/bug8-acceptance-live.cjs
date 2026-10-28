// Opt-in acceptance harness; real model costs, temp-only writes, no automatic retry.
if(process.env.PI_GUI_BUG8_LIVE !== '1'){console.log('Set PI_GUI_BUG8_LIVE=1 only after approval');process.exit(0);}
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process'), { pathToFileURL } = require('node:url');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p32-real-pi-')), out = process.env.P32_LIVE_OUT || root;
  fs.mkdirSync(out, { recursive: true }); const report = { platform: process.platform, root, startedAt: new Date().toISOString(), rounds: [], samples: [], checks: 0 };
  const save = () => fs.writeFileSync(path.join(out, 'runtime-live.json'), JSON.stringify(report, null, 2));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo); git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'counter.js'), 'export const counter = 0;\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture');
  const workspaces = ['A', 'B'].map(id => { const cwd = path.join(root, id); git(repo, 'worktree', 'add', '-b', `live-${id}`, cwd, 'HEAD'); return cwd; });
  const agentDir = path.join(root, 'agent'); fs.mkdirSync(agentDir);
  const { createPiLaunch } = await import('../server/pi-launch.js');
  const launch = createPiLaunch({ getCwd: () => repo }), entry = launch.cliEntry(); if (!entry.ok) throw Error('pi_entry_unavailable');
  const sdk = await import(pathToFileURL(path.join(launch.packageDir(), 'dist/index.js')).href);
  const currentAgent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent');
  const settings = JSON.parse(fs.readFileSync(path.join(currentAgent, 'settings.json'), 'utf8'));
  const provider = process.env.P32_LIVE_PROVIDER || settings.defaultProvider, modelId = process.env.P32_LIVE_MODEL || settings.defaultModel;
  report.provider = provider; report.model = modelId;
  const models = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(currentAgent, 'models.json'), modelsStorePath: path.join(agentDir, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  if (models.isUsingOAuth(provider)) throw Error('oauth_live_test_requires_separate_fixture_credentials');
  const model = models.getModel(provider, modelId); if (!model) throw Error('default_model_unavailable');
  const auth = await models.getAuth(model); if (!auth?.auth?.apiKey) throw Error('fixture_api_key_unavailable');
  if (Object.keys(auth.auth.headers || {}).some(k => !['authorization', 'content-type'].includes(k.toLowerCase()))) throw Error('fixture_custom_auth_headers_unsupported');
  const config = models.getRegisteredProviderConfig(provider) || {};
  const sourceModel = (config.models || []).find(m => m.id === modelId) || model;
  const selectedModel = Object.fromEntries(['id', 'name', 'api', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'compat'].filter(k => sourceModel[k] !== undefined).map(k => [k, sourceModel[k]]));
  // Persist no API key/header. The one selected model is proven by Pi, not guessed.
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { [provider]: { baseUrl: auth.auth.baseUrl || config.baseUrl || model.baseUrl, api: config.api || model.api, apiKey: 'PI_GUI_LIVE_KEY', models: [{ ...selectedModel, headers: undefined }] } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: modelId, retry: { enabled: false, maxRetries: 0 } }));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_GUI_LIVE_KEY: auth.auth.apiKey, PI_PROVIDER: provider, PI_MODEL: modelId, PI_THINKING: 'off' };
  const { createHash } = require('node:crypto');
  const { createSessionRuntime } = await import('../server/session-runtime.js');
  const { createPiSupervisor } = await import('../server/pi-supervisor.js');
  const { createRuntimeRegistry } = await import('../server/runtime-registry.js');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const deadline = Date.now() + 600000;
  let prompts = 0, seq = 0;
  report.transport = []; report.checkResults = []; report.files = []; report.promptLimit = 6;
  const watchdog = setTimeout(() => { report.deadlineExceeded = true; void registry.dispose(); }, 600000);
  const check = (value, name) => { assert.ok(value, name); report.checks++; report.checkResults.push({name, at: ++seq}); save(); console.log('PASS '+name); };
  async function until(fn, label, budget=120000) { const end=Math.min(deadline,Date.now()+budget); while(Date.now()<end){if(await fn())return;await sleep(25);}throw Error('live_timeout_'+label); }
  const hash = file => { const data=fs.readFileSync(file); return {bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),lines:data.toString().trim().split('\n').length}; };
  const record = (i, direction, frame, injected=false) => { report.transport.push({seq:++seq,session:i,direction,injected,type:frame.type,id:frame.id,command:frame.command,success:frame.success,disposition:frame.data?.disposition}); };
  const controls = [], runtimes = [];
  function instrument(i) {
    return options => {
      const real=createPiSupervisor(options), ctl={hold:false,held:[],aborts:[],writes:[]}; controls[i]=ctl;
      return {...real,spawnProcess(...args) {
        const child=real.spawnProcess(...args), write=child.stdin.write.bind(child.stdin), emit=child.stdout.emit.bind(child.stdout);
        let buffer=''; ctl.deliver=frame=>emit('data',JSON.stringify(frame)+'\n');
        child.stdin.write=(chunk,...tail)=>{const frames=String(chunk).trim().split('\n').map(s=>JSON.parse(s)); for(const f of frames){ctl.writes.push({type:f.type,id:f.id});record(i,'stdin',f);}return write(chunk,...tail);};
        child.stdout.emit=(event,...values)=>{
          if(event!=='data')return emit(event,...values);
          buffer+=String(values[0]);let nl;
          while((nl=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,nl);buffer=buffer.slice(nl+1);if(!line)continue;const f=JSON.parse(line);record(i,'stdout',f);if(f.type==='response'&&f.command==='abort')ctl.aborts.push(f);
            if(ctl.hold&&(f.type==='agent_settled'||f.type==='response'&&f.command==='abort'))ctl.held.push(f);else emit('data',line+'\n');}
          return true;
        };return child;
      }};
    };
  }
  // Controlled writer fixtures deliberately remain active until Stop. Full records
  // and final markers reveal resumed writes; mtime is never an acceptance criterion.
  for(const cwd of workspaces)fs.writeFileSync(path.join(cwd,'writer.cjs'),`const fs=require('node:fs');const tag=process.argv[2],file='pulse-'+tag+'.ndjson';let n=0;const t=setInterval(()=>fs.appendFileSync(file,JSON.stringify({tag,n:++n})+'\\n'),100);setTimeout(()=>{clearInterval(t);fs.appendFileSync(file,JSON.stringify({tag,done:true})+'\\n')},120000);`);
  const events=[[],[]];
  const registry=createRuntimeRegistry({dataDir:path.join(root,'registry'),resolveWorkspace:async args=>{const i=['A','B'].indexOf(args.id);if(i<0)throw Error('bad_workspace');return {projectId:'fixture',repoId:'fixture',workspaceId:args.id,workspaceEpoch:'epoch',cwd:workspaces[i],root:workspaces[i],branch:'live-'+args.id};},
    publish(){},factory:async(context,emit)=>{const i=['A','B'].indexOf(context.workspace.workspaceId);const r=await createSessionRuntime({context,emit:event=>{events[i].push({type:event.type,id:event.id,command:event.command,success:event.success,disposition:event.data?.disposition});emit(event);},piBin:entry.entryPath,env,dataDir:path.join(root,'data-'+i),sessionDir:path.join(agentDir,'sessions'),extraArgs:['--no-extensions','--no-skills','--no-prompt-templates','--no-themes'],supervisorFactory:instrument(i)});runtimes[i]=r;return r;}});
  function owner(i){return registry.snapshot().items.find(x=>x.workspace.workspaceId===['A','B'][i])?.owner;}
  function activity(i){return registry.snapshot().items.find(x=>x.workspace.workspaceId===['A','B'][i])?.activity;}
  async function command(i,cmd){if(['prompt','steer','follow_up'].includes(cmd.type)&&!String(cmd.id).startsWith('blocked-')){if(++prompts>6)throw Error('prompt_budget_exceeded');report.prompts=prompts;save();}const pending=registry.command(owner(i),cmd);pending.catch(()=>{});return pending;}
  function verifySequence(file,tag){const lines=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);return lines.every((x,i)=>x.tag===tag&&x.n===i+1);}
  const startWriter=async(i,tag)=>{const id='start-'+tag;await command(i,{type:'prompt',id,message:`Use bash exactly once to run node writer.cjs ${tag} in the current workspace. Wait for that command; do not background it. Do not edit writer.cjs, do not use network, do not perform any other task. Reply briefly when done.`});await until(()=>fs.existsSync(path.join(workspaces[i],`pulse-${tag}.ndjson`))&&hash(path.join(workspaces[i],`pulse-${tag}.ndjson`)).lines>=5,'writer-'+tag);check(events[i].some(e=>e.type==='response'&&e.id===id&&e.command==='prompt'&&e.success&&e.disposition==='started'),'prompt '+tag+' started by real Pi');check(activity(i)==='running','writer '+tag+' running before Stop');};
  const rejectTurns=async i=>{for(const type of ['prompt','steer','follow_up']){const countTurns=()=>controls[i].writes.filter(x=>['prompt','steer','follow_up'].includes(x.type)).length;const before=countTurns();await assert.rejects(command(i,{type,id:'blocked-'+type,message:'must not enter Pi'}),e=>e.code==='stop_in_progress');check(countTurns()===before,type+' rejected before stdin');}};
  try {
    await registry.start({id:'A',epoch:'epoch'});await registry.start({id:'B',epoch:'epoch'});
    await until(()=>registry.snapshot().items.every(x=>x.lifecycle==='ready'&&x.owner?.sessionId),'two-ready',45000);
    check(owner(0).sessionId!==owner(1).sessionId,'two distinct real Pi native sessions');report.sessionIds=[owner(0).sessionId,owner(1).sessionId];
    await Promise.all([startWriter(0,'A'),startWriter(1,'B')]);
    const aFile=path.join(workspaces[0],'pulse-A.ndjson'),bFile=path.join(workspaces[1],'pulse-B.ndjson');
    // A/B/D: admission is challenged synchronously after the barrier is raised.
    controls[0].hold=true;const first=command(0,{type:'abort'});check(activity(0)==='stopping','A is stopping immediately');await rejectTurns(0);await until(()=>controls[0].held.some(f=>f.command==='abort'),'first-held-abort');controls[0].hold=false;for(const f of controls[0].held.splice(0)){record(0,'release-first-held',f,true);controls[0].deliver(f);}report.initialStopTransportDelay='A confirmation held only to guarantee B admission probes hit pending barrier';
    const stopped=await first;check(stopped.ok,'real A Stop acknowledged');report.firstStop=stopped;
    check((await runtimes[0].request({type:'get_state'})).isStreaming===false,'A native state idle after Stop');
    const aStopped=hash(aFile),bBefore=hash(bFile);await sleep(1800);
    check(hash(aFile).sha256===aStopped.sha256,'A full contents unchanged after Stop confirmation');
    check(hash(bFile).lines>bBefore.lines&&verifySequence(bFile,'B'),'B continued ordered writes while A stopped');check(verifySequence(aFile,'A'),'A write sequence has exact tag and consecutive n');
    check((await runtimes[1].request({type:'get_state'})).isStreaming===true,'B native state still streaming');
    check(!fs.readFileSync(aFile,'utf8').includes('"done":true'),'A writer interrupted before normal completion');
    report.files.push({phase:'A-stop',stopped:aStopped,after:hash(aFile),bBefore,bAfter:hash(bFile)});
    const firstAbort=controls[0].aborts[0];check(Boolean(firstAbort),'captured real abort response ID');
    const order=controls[0].writes;const clearAt=order.findIndex(x=>x.type==='clear_queue'),abortAt=order.findIndex(x=>x.type==='abort');check(clearAt>=0&&abortAt>=0&&clearAt<abortAt,'clear_queue exists and is written before abort');
    // C: first new prompt must start a separate turn and produce exact content.
    const cIndex=events[0].length;await command(0,{type:'prompt',id:'after-stop-C',message:'Use the write tool to create hello-C.txt containing exactly hello world followed by a newline. Do nothing else.'});
    await until(()=>events[0].slice(cIndex).some(e=>e.type==='agent_settled'),'C-settled');
    check(events[0].slice(cIndex).some(e=>e.type==='response'&&e.id==='after-stop-C'&&e.command==='prompt'&&e.disposition==='started'),'C is prompt/started, not queued steer or follow_up');
    check(fs.readFileSync(path.join(workspaces[0],'hello-C.txt'),'utf8')==='hello world\n','C exact file content');check(hash(aFile).sha256===aStopped.sha256,'old A contents stable after C');
    check((await command(1,{type:'abort'})).ok,'B stopped independently for cleanup');
    // E: real Pi and production bridge; only transport delivery is fault-injected.
    await startWriter(0,'E');const eFile=path.join(workspaces[0],'pulse-E.ndjson');controls[0].hold=true;
    const abortCount=controls[0].writes.filter(x=>x.type==='abort').length;
    const eStop=command(0,{type:'abort'}),eDuplicate=command(0,{type:'abort'});
    await until(()=>controls[0].held.some(f=>f.type==='response'&&f.command==='abort'),'held-E-abort');
    record(0,'replay-old-abort',firstAbort,true);controls[0].deliver(firstAbort);await sleep(25);
    check(runtimes[0].getState().stop?.pending===true,'old abort acknowledgement cannot release new Stop');await rejectTurns(0);
    const [eResult,duplicateResult]=await Promise.all([eStop,eDuplicate]);
    check(eResult.ok===false&&eResult.code==='stop_unconfirmed','withheld current acknowledgement reports stop_unconfirmed');
    check(duplicateResult.ok===false&&duplicateResult.code==='stop_unconfirmed','repeated Stop waits and also reports unconfirmed');
    check(controls[0].writes.filter(x=>x.type==='abort').length===abortCount+1,'repeated Stop sends only one abort');
    record(0,'replay-old-abort-after-timeout',firstAbort,true);controls[0].deliver(firstAbort);await sleep(25);
    check(runtimes[0].getState().stop?.pending===true&&activity(0)==='stopping','timeout and late old reply preserve bridge and registry barrier');await rejectTurns(0);
    controls[0].hold=false;const held=controls[0].held.splice(0);for(const f of held){record(0,'release-held',f,true);controls[0].deliver(f);}
    await until(()=>!runtimes[0].getState().stop&&activity(0)==='idle','E-release');
    check(held.some(f=>f.command==='abort'&&f.id!==firstAbort.id),'current abort ID differs from old Stop');
    const eStopped=hash(eFile);await sleep(1000);check(hash(eFile).sha256===eStopped.sha256,'E full contents stable after delayed confirmation');
    report.files.push({phase:'E-stop',stopped:eStopped,after:hash(eFile)});report.injectedScenario={name:'E',heldFrames:held.map(f=>({type:f.type,command:f.command,id:f.id})),report:eResult};
    check(fs.readFileSync(path.join(repo,'counter.js'),'utf8')==='export const counter = 0;\n','fixture main unchanged');
    report.ok=true;
  }catch(error){report.ok=false;report.errorType=error.name;report.errorCode=/^live_timeout_/.test(error.message)?error.message:'verification_failed';report.assertion=error.code==='ERR_ASSERTION'?error.message:undefined;save();console.error('FAIL '+report.errorCode+(report.assertion?': '+report.assertion:''));process.exitCode=1;}
  finally{clearTimeout(watchdog);await registry.dispose();report.cleanupConfirmed=runtimes.every(r=>r.cleanupConfirmed());report.endedAt=new Date().toISOString();save();}
  console.log('Bug8 real Pi evidence: '+path.join(out,'runtime-live.json'));
})().catch(error=>{console.error('Live setup failed: '+(['oauth_live_test_requires_separate_fixture_credentials','fixture_api_key_unavailable','default_model_unavailable','fixture_custom_auth_headers_unsupported','pi_entry_unavailable'].includes(error.message)?error.message:error.name));process.exitCode=1;});
