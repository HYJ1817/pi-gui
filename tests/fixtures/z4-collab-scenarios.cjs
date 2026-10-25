const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');

module.exports=async function({win,repo,data,out,read,until,check,screenshots,geometry}) {
  const q=selector=>JSON.stringify(selector);
  const click=selector=>read(`(()=>{const el=document.querySelector(${q(selector)});if(el instanceof SVGElement)el.dispatchEvent(new MouseEvent('click',{bubbles:true}));else el.click()})()`);
  const action=text=>read(`Array.from(document.querySelectorAll('.collab-canvas button')).find(b=>b.textContent===${JSON.stringify(text)}).click()`);
  const saved=()=>read("document.querySelector('.collab-panel-status')?.textContent.includes('已保存')");
  let classicFile=null;
  const graph=()=>{
    const root=path.join(data,'collab-documents');
    const names=fs.existsSync(root)?fs.readdirSync(root).filter(n=>n.endsWith('.json')):[];
    if(!classicFile){assert.equal(names.length,1);classicFile=path.join(root,names[0]);}
    return JSON.parse(fs.readFileSync(classicFile,'utf8')).doc;
  };
  const original=fs.readFileSync(path.join(repo,'example.js'));
  await read("window.z4ComposerNode=document.querySelector('#input');window.z4ComposerNode.value='Z4 保留的未发送草稿';window.z4ComposerNode.dispatchEvent(new Event('input',{bubbles:true}))");
  await click('#btnCollab');
  await until(()=>read("!!Array.from(document.querySelectorAll('.collab-panel-actions button')).find(b=>!b.hidden&&b.textContent==='新建流程图')"),'explicit create entry');
  check('opening editor performs no persistent document creation',!fs.existsSync(path.join(data,'collab-documents')));
  await read("Array.from(document.querySelectorAll('.collab-panel-actions button')).find(b=>b.textContent==='新建流程图').click()");
  await until(saved,'initial document saved');
  check('real production panel creates three nodes and two edges',graph().graph.nodes.length===3&&graph().graph.edges.length===2);
  check('graph labels are not stroked by global SVG icon styles',await read("getComputedStyle(document.querySelector('.collab-node text')).stroke==='none'"));
  check('production panel reports the qualified Agent proposal source and preview-first contract',await read("document.querySelector('.collab-panel-source').textContent.includes('建议由当前 Pi 会话生成')"));
  await click('[data-node-id="n2"]');
  await read("document.querySelector('.collab-edit-form input').value='用户修改处理节点'");
  await action('保存文字');await until(()=>graph().graph.nodes.find(n=>n.id==='n2').label==='用户修改处理节点','label durable');
  check('real user text edit reaches safe store',graph().graph.nodes.find(n=>n.id==='n2').label==='用户修改处理节点');
  await until(saved,'label acknowledgement');
  const rect=await read("(()=>{const r=document.querySelector('[data-node-id=\"n2\"] rect').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  const before=graph().graph.nodes.find(n=>n.id==='n2');
  win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(rect.x),y:Math.round(rect.y),button:'left',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(rect.x+40),y:Math.round(rect.y+30),button:'left'});
  win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(rect.x+40),y:Math.round(rect.y+30),button:'left',clickCount:1});
  await until(()=>graph().graph.nodes.find(n=>n.id==='n2').x!==before.x,'real pointer drag saved');
  check('native pointer drag changes coordinates through operations',graph().graph.nodes.find(n=>n.id==='n2').y!==before.y);
  await until(saved,'drag ack');
  await action('撤销');await until(()=>graph().graph.nodes.find(n=>n.id==='n2').x===before.x,'undo drag');
  check('server undo restores exact pre-drag coordinates',graph().graph.nodes.find(n=>n.id==='n2').y===before.y);
  await until(saved,'undo ack');await action('重做');await until(()=>graph().graph.nodes.find(n=>n.id==='n2').x!==before.x,'redo drag');
  check('server redo persists new revision',graph().revision>=5);
  await until(saved,'redo ack');await action('新增节点');await until(()=>graph().graph.nodes.length===4,'new node');
  check('new node persisted with stable id',graph().graph.nodes.length===4);
  await until(saved,'add ack');
  // Z4-3：真实 Agent 建议链路——fake Pi 以真实协议形状应答生成请求。
  await read("document.querySelector('.collab-agent-input').value='把开始节点文字改成 Agent 修改的开始'");
  await read("document.querySelector('.collab-agent-input').dispatchEvent(new Event('input',{bubbles:true}))");
  await read("Array.from(document.querySelectorAll('.collab-agent-row button')).find(b=>b.textContent==='让 Agent 修改').click()");
  try {
    await until(()=>read("!!document.querySelector('.collab-proposal-diff li')"),'agent proposal previewed');
  } catch (error) {
    const diag=await read(`(()=>({status:document.querySelector('.collab-panel-status')?.textContent,
      source:document.querySelector('.collab-panel-source')?.textContent,
      proposal:document.querySelector('.collab-proposal')?.textContent?.slice(0,120)}))()`);
    console.error('Z43-DIAG '+JSON.stringify(diag));
    throw error;
  }
  check('agent suggestion card shows rationale and one diff entry',await read("document.querySelector('.collab-rationale').textContent.includes('Fixture 建议')&&document.querySelectorAll('.collab-proposal-diff li').length===1"));
  check('preview does not change the persisted document',graph().graph.nodes.find(n=>n.id==='n1').label!=='Agent 修改的开始');
  fs.writeFileSync(path.join(out,'collab-agent-proposal.png'),(await win.capturePage()).toPNG());screenshots.push('collab-agent-proposal.png');
  await read("Array.from(document.querySelectorAll('.collab-proposal-actions button')).find(b=>b.textContent==='接受建议').click()");
  await until(()=>graph().graph.nodes.find(n=>n.id==='n1').label==='Agent 修改的开始','agent suggestion applied');
  await until(saved,'agent accept ack');
  check('accepted agent suggestion applies through CAS and enables undo',await read("Array.from(document.querySelectorAll('.collab-canvas button')).find(b=>b.textContent==='撤销').disabled===false")&&graph().graph.nodes.find(n=>n.id==='n1').label==='Agent 修改的开始');
  await action('撤销');await until(()=>graph().graph.nodes.find(n=>n.id==='n1').label!=='Agent 修改的开始','agent suggestion undo');
  check('accepted agent suggestion is undoable like user edits',graph().graph.nodes.find(n=>n.id==='n1').label!=='Agent 修改的开始');
  await until(saved,'agent undo ack');
  const added=graph().graph.nodes.find(n=>!['n1','n2','n3'].includes(n.id));
  await click('[data-node-id="n3"]');
  await read(`document.querySelector('.collab-connect-form select').value=${JSON.stringify(added.id)}`);
  await action('新增连线');await until(()=>graph().graph.edges.length===3,'edge add');
  check('new directed edge references existing endpoints',graph().graph.edges.some(e=>e.from==='n3'&&e.to===added.id));
  await until(saved,'edge ack');
  const addedEdge=graph().graph.edges.find(e=>e.to===added.id);
  await click('[data-edge-id="'+addedEdge.id+'"]');await action('删除所选');
  await until(()=>read("!document.querySelector('#confirmLayer').hidden"),'delete confirmation');
  check('delete requires explicit confirmation before storage changes',graph().graph.edges.length===3);
  await read("Array.from(document.querySelectorAll('#confirmCard button')).find(b=>b.textContent==='删除').click()");
  await until(()=>graph().graph.edges.length===2,'edge deletion');
  check('confirmed edge deletion persists',graph().graph.edges.length===2);
  await until(saved,'delete ack');
  check('editing documents preserves Classic composer node and unsent draft',await read("window.z4ComposerNode===document.querySelector('#input')&&window.z4ComposerNode.value==='Z4 保留的未发送草稿'"));
  for(const width of [760,1200,1536]) {
    win.setContentSize(width,900);
    await until(()=>read(`innerWidth===${width}`),'window width');
    const bounds=await read("(()=>{const r=document.querySelector('.collab-stage').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}})()");
    check('canvas has visible bounded layout at '+width,bounds.width>200&&bounds.height>=220&&!bounds.overflow&&bounds.x+bounds.width<=bounds.viewport+1);
    geometry.push({kind:'collab',requestedWidth:width,...bounds});
    const name='collab-'+width+'.png';fs.writeFileSync(path.join(out,name),(await win.capturePage()).toPNG());screenshots.push(name);
  }
  await read(`(async()=>{
    const theme=await import('/theme.js');
    await theme.setThemePreference('light');
    document.documentElement.dataset.theme='light';
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  })()`);
  const lightStyles=await read(`(()=>{
    const stage=document.querySelector('.collab-stage');
    const nodeText=document.querySelector('.collab-node text');
    if(!stage||!nodeText)return null;
    const stageStyle=getComputedStyle(stage);
    const textStyle=getComputedStyle(nodeText);
    return {
      theme:document.documentElement.dataset.theme,
      display:stageStyle.display,
      stageBg:stageStyle.backgroundColor,
      textFill:textStyle.fill,
      textStroke:textStyle.stroke
    };
  })()`);
  check('light theme graph remains visible',lightStyles&&lightStyles.display!=='none');
  check('light theme graph renders light canvas with dark node text and no stroke',
    lightStyles?.theme==='light'&&
    lightStyles?.stageBg==='rgb(252, 252, 251)'&&
    lightStyles?.textFill==='rgb(11, 11, 11)'&&
    lightStyles?.textStroke==='none'
  );
  fs.writeFileSync(path.join(out,'collab-light.png'),(await win.capturePage()).toPNG());screenshots.push('collab-light.png');
  await read(`(async()=>{
    const theme=await import('/theme.js');
    await theme.setThemePreference('dark');
    document.documentElement.dataset.theme='dark';
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  })()`);
  await click('#rightPaneClose');await click('#btnCollab');await until(saved,'reopen saved document');
  check('reopen keeps graph and clears undo history',graph().graph.nodes.length===4&&await read("Array.from(document.querySelectorAll('.collab-canvas button')).find(b=>b.textContent==='撤销').disabled"));
  // Populate through the real controlled server operation endpoint, never an
  // injected mock document. Then reopen to measure the production component.
  await read(`(async()=>{const {collabDocumentAction}=await import('/api.js');const {S}=await import('/state.js');
    const headers={'X-Pi-Gui-Owner':JSON.stringify(S.legacyOwner)};let state=await collabDocumentAction({action:'open'},headers);
    for(let offset=state.document.graph.nodes.length;offset<100;offset+=50){const ops=[];
      for(let n=offset;n<Math.min(offset+50,100);n++)ops.push({opId:'perf-op-'+n,actor:'user',type:'node.add',baseRevision:state.document.revision,params:{id:'perf-'+n,label:'节点 '+n,x:(n%10)*180,y:Math.floor(n/10)*100}});
      state=await collabDocumentAction({action:'operations',editorId:state.editorId,expectedRevision:state.document.revision,ops},headers);if(!state.ok)throw Error('performance fixture commit failed');}
    const ids=state.document.graph.nodes.map(n=>n.id),pairs=new Set(state.document.graph.edges.map(e=>e.from+':'+e.to)),intents=[];
    for(let n=0;n<ids.length;n++)for(const step of [1,10]){const from=ids[n],to=ids[(n+step)%ids.length],pair=from+':'+to;if(pairs.has(pair))continue;pairs.add(pair);intents.push({type:'edge.add',params:{id:'perf-edge-'+n+'-'+step,from,to}});}
    for(let offset=0;offset<intents.length;offset+=50){const ops=intents.slice(offset,offset+50).map((intent,n)=>({...intent,opId:'perf-connect-'+(offset+n),baseRevision:state.document.revision,actor:'user'}));
      state=await collabDocumentAction({action:'operations',editorId:state.editorId,expectedRevision:state.document.revision,ops},headers);if(!state.ok)throw Error('performance edges commit failed');}
    await collabDocumentAction({action:'close',editorId:state.editorId},headers);})()`);
  const conflictRevision=graph().revision;
  await action('新增节点');await until(()=>read("document.querySelector('.collab-panel-status').textContent.includes('文档已被修改')"),'real concurrent revision conflict');
  check('real stale UI operation refuses without changing the newer persisted graph',graph().revision===conflictRevision&&graph().graph.nodes.length===100&&await read("Array.from(document.querySelectorAll('.collab-canvas button')).find(b=>b.textContent==='新增节点').disabled"));
  fs.writeFileSync(path.join(out,'collab-conflict.png'),(await win.capturePage()).toPNG());screenshots.push('collab-conflict.png');
  await click('#rightPaneClose');const start=Date.now();await click('#btnCollab');await until(()=>read("document.querySelectorAll('.collab-stage [data-node-id]').length===100"),'100 node canvas');
  const duration=Date.now()-start,edges=graph().graph.edges.length;
  check('100 persisted nodes and at least 180 directed edges render within 5 seconds',duration<5000&&edges>=180&&await read(`document.querySelectorAll('.collab-stage [data-edge-id]').length===${edges}`));
  geometry.push({kind:'performance',nodes:100,edges,renderMilliseconds:duration});
  fs.writeFileSync(path.join(out,'collab-100-nodes.png'),(await win.capturePage()).toPNG());screenshots.push('collab-100-nodes.png');
  await runtimeIsolation();
  await projectIsolation();
  await read("import('/state.js').then(({S})=>{S.workspaceGeneration++;document.dispatchEvent(new CustomEvent('pi-gui:workspace-generation'));})");
  check('workspace switch synchronously clears old graph controls',await read("!document.querySelector('.collab-canvas')&&document.querySelector('.collab-panel-status').textContent.includes('失效')"));
  await click('#rightPaneClose');
  check('collab editing never writes source project bytes',fs.readFileSync(path.join(repo,'example.js')).equals(original));

  async function runtimeIsolation() {
    const classicBytes=fs.readFileSync(classicFile);
    await read(`(async()=>{const api=await import('/api.js');const {S}=await import('/state.js');
      const list=await api.fetchWorktrees(S.cwd);const plan=await api.worktreeAction('prepare',{project:S.cwd,branch:'codex/z4-electron-fixture',source:'HEAD'},list.contextGeneration);
      if(!plan.ok)throw Error('runtime fixture prepare '+plan.code);const created=await api.worktreeAction('create',{nonce:plan.nonce},list.contextGeneration);
      if(!created.ok)throw Error('runtime fixture create '+created.code);
      const started=await api.runtimeSessionAction({action:'start',args:{id:created.workspace.id,epoch:created.workspace.epoch}});
      if(!started.ok)throw Error('runtime fixture start '+started.code);window.z4RuntimeId=started.owner?.conversationId||started.conversationId;})()`);
    const ready=()=>read(`(async()=>{const {fetchRuntimeSessions}=await import('/api.js');const m=await import('/runtime-state.js');m.seedRuntimeSnapshot(await fetchRuntimeSessions());
      const record=m.runtimeStore.get(window.z4RuntimeId);return record?.item?.lifecycle==='ready'&&!!record.owner?.sessionId;})()`);
    await until(ready,'actual runtime ready');
    await read("import('/runtime-nav.js').then(m=>m.focusRuntimeById(window.z4RuntimeId))");
    await until(()=>read("document.querySelector('#workspace').dataset.workspaceView==='runtime'"),'runtime focus UI');
    check('focusing actual Runtime invalidates Classic canvas synchronously',await read("!document.querySelector('.collab-canvas')"));
    if(await read("!!document.querySelector('#rightPaneClose')"))await click('#rightPaneClose');
    await click('#btnCollab');
    await until(()=>read("!!Array.from(document.querySelectorAll('.collab-panel-actions button')).find(b=>!b.hidden&&b.textContent==='新建流程图')"),'runtime scope empty');
    await read("Array.from(document.querySelectorAll('.collab-panel-actions button')).find(b=>b.textContent==='新建流程图').click()");await until(saved,'runtime document create');
    const allDocuments=()=>fs.readdirSync(path.join(data,'collab-documents')).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(data,'collab-documents',n),'utf8')).doc);
    check('Classic and Runtime persist separate session documents',allDocuments().length===2&&new Set(allDocuments().map(d=>d.boundSessionId)).size===2);
    await click('[data-node-id="n1"]');await read("document.querySelector('.collab-edit-form input').value='Runtime 独立编辑'");await action('保存文字');await until(saved,'runtime user edit');
    check('Runtime edit leaves complete Classic document bytes unchanged',fs.readFileSync(classicFile).equals(classicBytes));
    // Z4-3 验收修复：Runtime 生成不依赖 Classic capture 就绪——真实组合根全链路。
    await read("document.querySelector('.collab-agent-input').value='Runtime 侧让 Agent 修改开始节点'");
    await read("document.querySelector('.collab-agent-input').dispatchEvent(new Event('input',{bubbles:true}))");
    await read("Array.from(document.querySelectorAll('.collab-agent-row button')).find(b=>b.textContent==='让 Agent 修改').click()");
    await until(()=>read("!!document.querySelector('.collab-proposal-diff li')"),'runtime agent proposal previewed');
    check('Runtime agent generation completes via registry command without Classic capture',await read("document.querySelector('.collab-rationale').textContent.includes('Fixture 建议')"));
    await read("Array.from(document.querySelectorAll('.collab-proposal-actions button')).find(b=>b.textContent==='接受建议').click()");
    await until(()=>{const names=fs.readdirSync(path.join(data,'collab-documents')).filter(n=>n.endsWith('.json'));return names.length===2&&names.some(n=>JSON.parse(fs.readFileSync(path.join(data,'collab-documents',n),'utf8')).doc.graph.nodes.find(x=>x.id==='n1')?.label==='Agent 修改的开始');},'runtime agent suggestion applied');
    check('Runtime agent suggestion applies through CAS and Classic bytes stay unchanged',fs.readFileSync(classicFile).equals(classicBytes));
    await read(`(async()=>{const {runtimeStore}=await import('/runtime-state.js');const {collabDocumentAction,runtimeSessionAction}=await import('/api.js');
      window.z4OldRuntimeOwner=structuredClone(runtimeStore.get(window.z4RuntimeId).owner);
      const headers={'X-Pi-Gui-Conversation':window.z4RuntimeId,'X-Pi-Gui-Owner':JSON.stringify(window.z4OldRuntimeOwner)};
      window.z4OldEditor=await collabDocumentAction({action:'open'},headers);const closed=await runtimeSessionAction({action:'close',owner:window.z4OldRuntimeOwner});if(!closed.ok)throw Error('runtime close');})()`);
    await until(()=>read("!document.querySelector('.collab-canvas')"),'runtime close clears graph');
    check('closing actual Runtime clears document controls',await read("!document.querySelector('.collab-canvas')"));
    const stale=await read(`(async()=>{const {collabDocumentAction}=await import('/api.js');const old=window.z4OldEditor;
      return collabDocumentAction({action:'operations',editorId:old.editorId,expectedRevision:old.document.revision,ops:[{opId:'stale-after-close',type:'node.update',actor:'user',baseRevision:old.document.revision,params:{id:'n1',label:'不应写入'}}]},
      {'X-Pi-Gui-Conversation':window.z4RuntimeId,'X-Pi-Gui-Owner':JSON.stringify(window.z4OldRuntimeOwner)});})()`);
    check('closed Runtime old owner cannot submit a document operation',stale.ok===false&&stale.code==='collab_scope_unavailable');
    await read("import('/api.js').then(m=>m.runtimeSessionAction({action:'resume',conversationId:window.z4RuntimeId})).then(r=>{if(!r.ok)throw Error('runtime resume '+r.code)})");
    await until(ready,'actual Runtime resumed');
    await read("import('/runtime-nav.js').then(m=>m.focusRuntimeById(window.z4RuntimeId))");
    await until(()=>read("import('/runtime-state.js').then(m=>m.runtimeStore.get(window.z4RuntimeId)?.owner?.runtimeGeneration!==window.z4OldRuntimeOwner.runtimeGeneration)"),'new runtime generation');
    if(await read("!!document.querySelector('#rightPaneClose')"))await click('#rightPaneClose');await click('#btnCollab');await until(saved,'resumed Runtime doc restored');
    check('resumed Runtime restores document with a fresh empty undo stack',await read("document.querySelector('[data-node-id=\"n1\"]').getAttribute('aria-label').includes('Agent 修改的开始')&&Array.from(document.querySelectorAll('.collab-canvas button')).find(b=>b.textContent==='撤销').disabled"));
    fs.writeFileSync(path.join(out,'collab-runtime.png'),(await win.capturePage()).toPNG());screenshots.push('collab-runtime.png');
    await read("(async()=>{const {runtimeStore}=await import('/runtime-state.js');const {runtimeSessionAction}=await import('/api.js');await runtimeSessionAction({action:'close',owner:runtimeStore.get(window.z4RuntimeId).owner});})()");
    await click('#navHome');
    await until(()=>read("import('/api.js').then(m=>m.fetchRuntimeSessions()).then(s=>!s.focusedConversationId)"),'classic focus authority restored');
    if(await read("!!document.querySelector('#rightPaneClose')"))await click('#rightPaneClose');await click('#btnCollab');await until(saved,'Classic document restored');
    check('returning to Classic restores the original 100-node document',await read("document.querySelectorAll('.collab-stage [data-node-id]').length===100"));
    check('Runtime close and resume preserve Classic bytes exactly',fs.readFileSync(classicFile).equals(classicBytes));
  }

  async function projectIsolation() {
    const {execFileSync}=require('node:child_process');
    const other=path.join(path.dirname(data),'other-project');fs.mkdirSync(other);
    const git=(...args)=>execFileSync('git',args,{cwd:other,windowsHide:true,stdio:'ignore',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(path.dirname(data),'gitconfig')}});
    git('init','-b','main');git('config','user.name','Offline fixture');git('config','user.email','fixture@example.invalid');
    fs.writeFileSync(path.join(other,'fixture.txt'),'second project original bytes\n');git('add','.');git('commit','-m','fixture');
    const classicBytes=fs.readFileSync(classicFile);
    const prior=await read("import('/state.js').then(({S})=>({session:S.legacyOwner.sessionId,generation:S.workspaceGeneration}))");
    await read(`(async()=>{
      const api=await import('/api.js');
      const created=await api.createProject(${JSON.stringify(other)},'Z4 Other Project');
      if(!created.ok)throw Error('project fixture create: '+(created.error||created.code));
    })()`);

    // In this fixture all background runtimes were previously closed (runtime_closed sets record.owner=null),
    // so hasBackground is false. Directly call production projects.activateProject for real workspace switching.
    const activatedOther=await read(`import('/projects.js').then(m=>m.activateProject(${JSON.stringify(other)},'Z4 Other Project'))`);
    assert.equal(activatedOther,true,'second project activation returned true');
    await until(()=>read(`import('/state.js').then(({S})=>S.cwd===${JSON.stringify(other)}&&S.workspaceGeneration>${prior.generation}&&!!S.legacyOwner?.sessionId&&S.legacyOwner.sessionId!==${JSON.stringify(prior.session)}&&S.bridgeState==='ready'&&!S.switching)`),'second actual project ready');
    check('actual project activation removes prior document controls',await read("!document.querySelector('.collab-canvas')"));
    if(await read("!!document.querySelector('#rightPaneClose')"))await click('#rightPaneClose');await click('#btnCollab');
    await until(()=>read("!!Array.from(document.querySelectorAll('.collab-panel-actions button')).find(b=>!b.hidden&&b.textContent==='新建流程图')"),'second project has no borrowed document');
    check('second actual project cannot borrow first project document',fs.readFileSync(classicFile).equals(classicBytes));

    const activatedRepo=await read(`import('/projects.js').then(m=>m.activateProject(${JSON.stringify(repo)},'G2 Offline Smoke'))`);
    assert.equal(activatedRepo,true,'original project activation returned true');
    await until(()=>read(`import('/state.js').then(({S})=>S.cwd===${JSON.stringify(repo)}&&S.legacyOwner?.sessionId===${JSON.stringify(prior.session)}&&S.bridgeState==='ready'&&!S.switching)`),'original actual project ready');
    if(await read("!!document.querySelector('#rightPaneClose')"))await click('#rightPaneClose');await click('#btnCollab');await until(saved,'original project document reopens');
    check('A-B-A project activation restores saved graph with empty history',await read("document.querySelectorAll('.collab-stage [data-node-id]').length===100&&Array.from(document.querySelectorAll('.collab-canvas button')).find(b=>b.textContent==='撤销').disabled"));
    check('project switching preserves both source files and saved document bytes',fs.readFileSync(classicFile).equals(classicBytes)&&fs.readFileSync(path.join(other,'fixture.txt'),'utf8')==='second project original bytes\n');
  }
};
