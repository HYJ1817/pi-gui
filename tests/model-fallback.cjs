const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let pass=0,fail=0;
async function check(name,fn){try{await fn();pass++;console.log('  ok '+name);}catch(e){fail++;console.error(' FAIL '+name+': '+e.message);}}
const A={providerId:'a',modelId:'m'},B={providerId:'b',modelId:'m'},C={providerId:'c',modelId:'other/x'};
async function main(){
  let pure;
  await check('P28 pure module exposes fallback contracts',async()=>{pure=await import('../lib/model-fallback.js');assert.equal(typeof pure.normalizeFallbackConfig,'function');});
  if(pure){
    const {normalizeFallbackConfig:n,classifyGenerationError:classify,nextFallbackCandidate:next,createFallbackRuntime:create}=pure;
    await check('default disabled',()=>assert.deepEqual(n(),{enabled:false,chain:[]}));
    await check('identity/order/slash preserved without credentials',()=>{const cfg=n({enabled:true,chain:[{...B,apiKey:'SECRET'},C]},A);assert.deepEqual(cfg,{enabled:true,chain:[B,C]});assert.ok(!JSON.stringify(cfg).includes('SECRET'));});
    await check('duplicate and primary excluded',()=>assert.deepEqual(n({enabled:true,chain:[A,B,B,C]},A).chain,[B,C]));
    await check('enabled empty chain downgraded',()=>assert.equal(n({enabled:true,chain:[A]},A).enabled,false));
    const cases=[
      ['429 {"error":{"code":"rate_limit_exceeded"}}','rate_limited',true],
      ['429 {"error":{"code":"insufficient_quota"}}','quota_exhausted',true],
      ['402: {"message":"Insufficient Balance"}','quota_exhausted',true],
      ['503 service unavailable','provider_unavailable',true],
      ['500 status code (no body)','retryable_provider_error',true],
      ['Connection error.','provider_unavailable',true],
      ['Request timed out.','provider_unavailable',true],
      ['404 {"error":{"code":"model_not_found"}}','model_unavailable',true],
      ['401 {"error":{"code":"insufficient_quota"}}','auth_error',false],
      ['403 forbidden','auth_error',false],
      ['400 {"error":{"code":"context_length_exceeded"}}','context_overflow',false],
      ['400 invalid parameters','request_incompatible',false],
      ['400 image unsupported','request_incompatible',false],
      ['404 page missing','unknown',false],
      ['a tool failed with 429','unknown',false],
      ['network somehow maybe bad','unknown',false],
    ];
    for(const [message,cls,retryable] of cases) await check('classification '+message,()=>{const e=classify({message,source:'pi-assistant'});assert.equal(e.class,cls);assert.equal(e.retryable,retryable);assert.ok(!e.reason.includes(message));});
    await check('aborted forbidden',()=>assert.equal(classify({stopReason:'aborted',source:'pi-assistant'}).class,'user_cancelled'));
    await check('non-generation source cannot retry',()=>assert.equal(classify({message:'429 too many requests',source:'tool'}).retryable,false));
    await check('history strips raw error body',()=>assert.ok(!JSON.stringify(classify({message:'503 {"Authorization":"SECRET"}',source:'pi-assistant'})).includes('SECRET')));
    await check('image false skipped unknown allowed and no cross-provider capability',()=>{const r=next({chain:[B,C],attemptedModels:[A],models:[{...B,input:['text']},C],requirements:{textInput:true,imageInput:true}});assert.deepEqual(r.candidate,C);assert.ok(r.unconfirmed.includes('imageInput'));assert.equal(r.skipped[0].reason,'imageInput-unsupported');});
    await check('text false filtered but tools false not hard constraint',()=>{const r=next({chain:[B,C],models:[{...B,input:['image']},{...C,capabilities:{toolCalling:false}}],requirements:{textInput:true}});assert.deepEqual(r.candidate,C);});
    await check('missing models skipped',()=>assert.equal(next({chain:[B],models:[]}).candidate,null));
    await check('runtime records each candidate once no loop',()=>{const rt=create({generation:1,originalModel:A});rt.attempt(B,classify({message:'429 x',source:'pi-assistant'}),[],1);assert.equal(rt.attempt(B,{},[],2),false);rt.attempt(C,classify({message:'503 x',source:'pi-assistant'}),[],3);rt.finish('exhausted');const s=rt.snapshot();assert.deepEqual(s.attemptedModels,[A,B,C]);assert.equal(s.exhausted,true);assert.equal(s.active,false);assert.ok(!JSON.stringify(s).includes('message'));});
  }
  await backendChecks();
  await check('project v1 reads disabled fallback without rewriting disk',async()=>{
    const {normalizeConfig,CONFIG_VERSION}=await import('../server/project-config.js');
    assert.equal(CONFIG_VERSION,2);const r=normalizeConfig({version:1,instructions:'keep'});
    assert.deepEqual(r.config.fallback,{enabled:false,chain:[]});assert.equal(r.config.instructions,'keep');
    const s=normalizeConfig({version:2,model:{provider:'a',id:'m'},fallback:{enabled:true,chain:[A,B,B],token:'SECRET'}}).config;
    assert.deepEqual(s.fallback.chain,[B]);assert.ok(!JSON.stringify(s).includes('SECRET'));
  });
  await uiChecks();
  console.log(`\nModel fallback: ${pass}/${pass+fail} 通过`);process.exitCode=fail?1:0;
}
async function backendChecks(){
  let create;
  await check('generation owner module available',async()=>{({createModelGeneration:create}=await import('../server/model-generation.js'));assert.equal(typeof create,'function');});
  if(!create)return;
  const start=()=>{const o=create();o.noteCommandAccepted({type:'prompt',id:'owned'});o.observe({type:'response',command:'prompt',id:'owned',success:true,data:{disposition:'started'}});return o;};
  await check('only settled current owned generation yields safe failure',()=>{const o=start();const end=o.observe({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'429 {"apiKey":"SECRET"}'}});assert.ok(!JSON.stringify(end).includes('SECRET'));assert.equal(o.observe({type:'agent_end',messages:[]}).generationResult,undefined);const done=o.observe({type:'agent_settled'}).generationResult;assert.equal(done.requestId,'owned');assert.equal(done.failure.class,'rate_limited');assert.equal(done.hasVisibleOutput,false);});
  await check('visible text / thinking / tool activity blocks replay',()=>{for(const event of [{type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'part'}},{type:'message_start',message:{role:'assistant',content:[{type:'thinking',thinking:'private'}]}},{type:'tool_execution_start'}]){const o=start();o.observe(event);o.observe({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'503 x'}});assert.equal(o.observe({type:'agent_settled'}).generationResult.hasVisibleOutput,true);}});
  await check('native retry success replaces earlier failure',()=>{const o=start();o.observe({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'429 x'}});o.observe({type:'auto_retry_start',errorMessage:'429 SECRET'});o.observe({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'ok'}],stopReason:'stop'}});assert.equal(o.observe({type:'agent_settled'}).generationResult.outcome,'success');});
  await check('queued/handled never own fallback generation',()=>{for(const disposition of ['queued','handled']){const o=create();o.noteCommandAccepted({type:'prompt',id:'owned'});o.observe({type:'response',command:'prompt',id:'owned',success:true,data:{disposition}});assert.equal(o.observe({type:'agent_settled'}).generationResult,undefined);}});
  await check('all unsafe generation error channels removed',()=>{const o=start();for(const event of [{type:'auto_retry_start',errorMessage:'SECRET'},{type:'auto_retry_end',finalError:'SECRET'},{type:'message_update',message:{role:'assistant',errorMessage:'SECRET'},assistantMessageEvent:{type:'error',error:{role:'assistant',errorMessage:'SECRET'},partial:{role:'assistant',errorMessage:'SECRET'}}},{type:'agent_end',messages:[{role:'assistant',errorMessage:'SECRET'}]}])assert.ok(!JSON.stringify(o.observe(event)).includes('SECRET'));});
  await check('tree history strips nested Provider errors without touching user content',()=>{const o=create();const event={type:'response',command:'get_tree',success:true,data:{tree:[{entry:{type:'message',message:{role:'assistant',stopReason:'error',errorMessage:'503 SECRET'}},children:[{entry:{type:'message',message:{role:'user',content:'keep'}},children:[]}]}]}};const out=o.observe(event);assert.ok(!JSON.stringify(out).includes('SECRET'));assert.equal(out.data.tree[0].children[0].entry.message.content,'keep');});
  await check('deep Pi tree safely normalizes without recursive stack overflow',()=>{const root={entry:{message:{role:'assistant',errorMessage:'503 SECRET'}},children:[]};let n=root;for(let i=0;i<12000;i++){const child={entry:{message:{role:'assistant',errorMessage:'503 SECRET'}},children:[]};n.children.push(child);n=child;}const out=create().observe({type:'response',command:'get_tree',success:true,data:{tree:[root]}});let count=0;for(let p=out.data.tree[0];p;p=p.children[0]){assert.ok(!p.entry.message.errorMessage.includes('SECRET'));count++;}assert.equal(count,12001);});
  for(const type of ['steer','follow_up','abort','new_session','fork','set_model'])await check(type+' cancels generation ownership',()=>{const o=start();o.noteCommandAccepted({type});assert.equal(o.observe({type:'agent_settled'}).generationResult,undefined);});
  await check('bridge reset cancels ownership',()=>{const o=start();o.observe({type:'bridge_status',state:'restarting'});assert.equal(o.observe({type:'agent_settled'}).generationResult,undefined);});
  await check('backend owner token refuses late automatic commands after manual override',()=>{const o=start();o.observe({type:'agent_settled'});o.guardCommand({type:'set_model',__fallbackOwner:'owned'});o.noteCommandAccepted({type:'set_model'});assert.throws(()=>o.guardCommand({type:'prompt',__fallbackOwner:'owned'}));});
  await check('new unowned agent invalidates backend replay token',()=>{const o=start();o.observe({type:'agent_settled'});o.observe({type:'agent_start'});o.observe({type:'agent_settled'});assert.throws(()=>o.guardCommand({type:'prompt',__fallbackOwner:'owned'}));});
  await check('unowned error never acquires fallback ownership',()=>{const o=create();o.observe({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'429 x'}});assert.equal(o.observe({type:'agent_settled'}).generationResult,undefined);});
}
main().catch(e=>{console.error(e);process.exitCode=1;});

async function uiChecks(){
  const {JSDOM}=require('jsdom'),{bundle}=require('./esm-bundle.cjs');
  const pub=path.resolve(__dirname,'../public');
  const dom=new JSDOM(fs.readFileSync(path.join(pub,'index.html'),'utf8'),{url:'http://localhost:7788',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,calls=[];let emit;
  w.matchMedia=()=>({matches:false,addEventListener(){}});w.ResizeObserver=class{observe(){}};w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.EventSource=class{constructor(){emit=e=>this.onmessage?.({data:JSON.stringify(e)});}close(){}};
  let cfg={fallback:{enabled:true,chain:[B,C]}};
  w.fetch=async(url,opts={})=>{if(url==='/api/command')calls.push(JSON.parse(opts.body));
    return {ok:true,json:async()=>url==='/api/project-config'?{ok:true,hasProject:true,cwd:'fixture',config:cfg,defaults:{},thinkingLevels:[]}:({ok:true,items:[],sessions:[]})};};
  w.eval(bundle(path.join(pub,'app.js')).code);await new Promise(r=>setTimeout(r,30));
  const tick=()=>new Promise(r=>setTimeout(r,5));
  const reset=()=>{w.cancelFallback?.('test');w.S.hasProject=true;w.S.switching=false;w.S.bridgeState='ready';w.S.bridgeRun=1;w.S.cwd='fixture';w.S.streaming=false;w.S.modelSwitchPending=false;
    w.onModels({models:[A,B,C]});w.applyState({model:A,sessionId:'session',thinkingLevel:'off'});w.onThinkingLevels({levels:[]});calls.length=0;w.el.input.value='original';w.S.attachments=[];cfg={fallback:{enabled:true,chain:[B,C]}};};
  const begin=async()=>{reset();await w.submit();await tick();return calls.find(c=>c.type==='prompt');};
  const failed=async(id,cls='rate_limited',visible=false)=>{emit({type:'agent_settled',bridgeRun:1,generationResult:{requestId:id,outcome:'failed',hasVisibleOutput:visible,failure:{class:cls,retryable:['rate_limited','provider_unavailable'].includes(cls),source:'pi-assistant',statusCode:429}}});await tick();};
  const confirm=async(model)=>{const set=calls.filter(c=>c.type==='set_model').at(-1);w.onResponse({command:'set_model',id:set.id,success:true,data:{provider:model.providerId,id:model.modelId}});
    const st=calls.filter(c=>c.type==='get_state'&&c.id).at(-1),lv=calls.filter(c=>c.type==='get_available_thinking_levels').at(-1);
    w.onResponse({command:'get_state',id:st.id,success:true,data:{model,sessionId:'session',thinkingLevel:'off'}});
    w.onResponse({command:'get_available_thinking_levels',id:lv.id,success:true,data:{levels:[]}});await tick();};
  await check('fallback coordinator wired into submit',async()=>{const cmd=await begin();assert.equal(w.S.fallbackActive,true);assert.ok(cmd.id);assert.equal(w.el.input.value,'original');});
  if(typeof w.cancelFallback!=='function'){dom.window.close();return;}
  await check('A -> B confirmed success preserves B and cleans once',async()=>{const cmd=await begin();w.S.attachments=[{kind:'text',name:'later',text:'keep'}];await failed(cmd.id);assert.equal(calls.filter(c=>c.type==='set_model').length,1);await confirm(B);const replay=calls.filter(c=>c.type==='prompt').at(-1);assert.equal(replay.message,cmd.message);assert.equal(replay.__fallbackOwner,cmd.id);
    emit({type:'agent_settled',bridgeRun:1,generationResult:{requestId:replay.id,outcome:'success',hasVisibleOutput:true}});await tick();assert.equal(w.el.input.value,'');assert.equal(w.S.attachments.length,1);assert.equal(w.S.state.model.providerId,'b');assert.equal(w.S.fallbackRuntime.phase,'completed');});
  await check('A -> B fails -> C succeeds ordered and finite',async()=>{const cmd=await begin();await failed(cmd.id);await confirm(B);const b=calls.filter(c=>c.type==='prompt').at(-1);await failed(b.id,'provider_unavailable');await confirm(C);const c=calls.filter(c=>c.type==='prompt').at(-1);emit({type:'agent_settled',bridgeRun:1,generationResult:{requestId:c.id,outcome:'success',hasVisibleOutput:true}});await tick();assert.equal(calls.filter(c=>c.type==='prompt').length,3);assert.equal(w.S.state.model.providerId,'c');});
  await check('exhausted stops preserves original input no duplicate replay',async()=>{const cmd=await begin();await failed(cmd.id);await confirm(B);await failed(calls.filter(c=>c.type==='prompt').at(-1).id);await confirm(C);const last=calls.filter(c=>c.type==='prompt').at(-1);await failed(last.id);await failed(last.id);assert.equal(calls.filter(c=>c.type==='prompt').length,3);assert.equal(w.S.fallbackRuntime.exhausted,true);assert.equal(w.el.input.value,'original');});
  for(const cls of ['auth_error','context_overflow','request_incompatible','unknown','user_cancelled'])await check(cls+' stops without switching',async()=>{const cmd=await begin();await failed(cmd.id,cls);assert.equal(calls.filter(c=>c.type==='set_model').length,0);});
  await check('visible output forbids replay',async()=>{const cmd=await begin();await failed(cmd.id,'rate_limited',true);assert.equal(calls.filter(c=>c.type==='set_model').length,0);});
  await check('history replay cannot trigger fallback',async()=>{const cmd=await begin();emit({type:'agent_settled',_replay:true,bridgeRun:1,generationResult:{requestId:cmd.id,outcome:'failed',hasVisibleOutput:false,failure:{class:'rate_limited',retryable:true}}});await tick();assert.equal(calls.filter(c=>c.type==='set_model').length,0);});
  await check('stop cancels while Pi not streaming',async()=>{const cmd=await begin();await failed(cmd.id);await w.stop();assert.equal(w.S.fallbackActive,false);await confirm(B);assert.equal(calls.filter(c=>c.type==='prompt').length,1);});
  await check('manual choice overrides in-flight fallback and stale set reply',async()=>{const cmd=await begin();await failed(cmd.id);const auto=calls.filter(c=>c.type==='set_model').at(-1);w.setModel('manual','chosen');assert.equal(w.S.fallbackActive,false);w.onResponse({command:'set_model',id:auto.id,success:true});await tick();const manual=calls.filter(c=>c.type==='set_model').at(-1);assert.equal(manual.provider,'manual');assert.equal(calls.filter(c=>c.type==='prompt').length,1);w.onResponse({command:'set_model',id:manual.id,success:false});});
  await check('workspace switch invalidates pending fallback',async()=>{const cmd=await begin();await failed(cmd.id);w.beginWorkspaceSwitch('next');assert.equal(w.S.fallbackActive,false);await tick();assert.equal(calls.filter(c=>c.type==='prompt').length,1);});
  await check('session request immediately invalidates fallback',async()=>{await begin();await w.switchSession('another');assert.equal(w.S.fallbackActive,false);});
  await check('restart immediately invalidates fallback',async()=>{await begin();await w.restartBackend();assert.equal(w.S.fallbackActive,false);});
  await check('changed session readback cannot replay',async()=>{const cmd=await begin();await failed(cmd.id);w.applyState({model:B,sessionId:'other'});await confirm(B);assert.equal(calls.filter(c=>c.type==='prompt').length,1);});
  await check('steer and slash command retain normal send semantics',async()=>{reset();w.S.streaming=true;await w.submit();assert.equal(calls.at(-1).type,'steer');assert.equal(w.S.fallbackActive,false);reset();w.el.input.value='/skill';await w.submit();assert.equal(w.S.fallbackActive,false);});
  await check('disabled config retains legacy immediate cleanup',async()=>{reset();cfg={fallback:{enabled:false,chain:[B]}};await w.submit();assert.equal(w.el.input.value,'');assert.equal(w.S.fallbackActive,false);});
  await check('project settings exposes ordered fallback editor',async()=>{reset();await w.openProjectSettings();assert.ok(w.document.querySelector('.fallback-settings'));assert.ok(w.document.querySelector('[data-fallback-add]'));});
  await check('settings option retains identity across live catalog reorder',()=>{reset();const ed=w.createFallbackSettings({chain:[]},()=>A);w.el.modalCard.appendChild(ed.element);const select=ed.element.querySelector('select');select.value=select.options[0].value;w.S.models=[A,C,B];ed.element.querySelector('[data-fallback-add]').click();assert.equal(ed.value().chain[0].providerId,'b');});
  await check('attachments survive retries and original images clean only after actual success',async()=>{reset();const att={kind:'image',name:'original.png',dataUrl:'data:image/png;base64,YQ==',data:'YQ==',mimeType:'image/png'};w.S.attachments=[att];w.onModels({models:[A,{...B,input:['text']},C]});await w.submit();const cmd=calls.find(c=>c.type==='prompt');assert.equal(w.S.attachments.length,1);await failed(cmd.id);assert.equal(calls.filter(c=>c.type==='set_model').at(-1).provider,'c');await confirm(C);const replay=calls.filter(c=>c.type==='prompt').at(-1);assert.deepEqual(replay.images,cmd.images);assert.equal(w.S.attachments.length,1);emit({type:'agent_settled',bridgeRun:1,generationResult:{requestId:replay.id,outcome:'success',hasVisibleOutput:true}});await tick();assert.equal(w.S.attachments.length,0);emit({type:'agent_settled',bridgeRun:1,generationResult:{requestId:replay.id,outcome:'success',hasVisibleOutput:true}});await tick();assert.equal(calls.filter(c=>c.type==='prompt').length,2);});
  await check('fallback confirmation timeout stops and preserves draft',async()=>{const timer=w.setTimeout;w.setTimeout=(fn,ms,...args)=>timer(fn,ms===30000?5:ms,...args);const cmd=await begin();await failed(cmd.id);await new Promise(r=>setTimeout(r,20));assert.equal(w.S.fallbackActive,false);assert.equal(w.el.input.value,'original');w.setTimeout=timer;});
  await check('Pi capability rejection records actual B -> C switch',async()=>{reset();w.S.attachments=[{kind:'image',name:'a.png',dataUrl:'data:image/png;base64,YQ=='}];await w.submit();const cmd=calls.find(c=>c.type==='prompt');await failed(cmd.id);await confirm({...B,input:['text']});assert.equal(w.S.fallbackRuntime.currentModel.providerId,'b');assert.equal(w.S.fallbackRuntime.history[1].from.providerId,'b');assert.equal(calls.filter(c=>c.type==='set_model').at(-1).provider,'c');w.cancelFallback();});
  await check('fallback status participates in composer height and uses readable results',async()=>{const cmd=await begin();await failed(cmd.id);const box=w.document.getElementById('fallbackStatus');assert.ok(w.el.composerBox.contains(box));assert.ok(box.textContent.includes('切换中'));assert.ok(!box.textContent.includes('switching'));w.cancelFallback();});
  dom.window.close();
}
