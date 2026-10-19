// Opt-in real Electron input against the complete production app + offline harness.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
if (!process.versions.electron) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-review-electron-'));
  fs.mkdirSync(path.join(world, 'user-data'));
  const env = { ...process.env, REVIEW_ELECTRON_WORLD: world }; delete env.ELECTRON_RUN_AS_NODE;
  // electron/index.js may install a missing runtime. Offline tests must fail instead.
  const electronRoot = path.dirname(require.resolve('electron/package.json'));
  const pathFile = path.join(electronRoot, 'path.txt');
  const binary = fs.existsSync(pathFile) ? fs.readFileSync(pathFile, 'utf8').trim() : process.platform === 'win32' ? 'electron.exe' : 'electron';
  const executable = path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronRoot, 'dist'), binary);
  if (!fs.existsSync(executable)) throw Error('existing Electron runtime required; automatic download disabled');
  const child = spawn(executable, [__filename, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + path.join(world, 'user-data')], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', e => { console.error(e); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; console.log('Review Electron evidence: ' + world); });
} else {
  const assert = require('node:assert/strict'), { app, BrowserWindow } = require('electron');
  const world = process.env.REVIEW_ELECTRON_WORLD, results = [];
  let win, harness, proxy, finalExit = 0;
  app.on('window-all-closed', () => {});
  const read = script => win.webContents.executeJavaScript(script, true);
  const flush = () => read("new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture_animation_frame_timeout')),5000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve()}))})");
  const click = async expression => {
    const p = await read(`(()=>{const e=${expression};e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p }); await flush();
  };
  const type = async (expression, value) => { await read(`${expression}.focus();${expression}.select()`); await win.webContents.insertText(value); await flush(); };
  const check = async (name, run) => {
    await run(); const file = path.join(world, `case-${results.length + 1}.png`);
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); results.push({ name, passed: true, screenshot: file }); console.log('PASS Electron ' + name);
  };
  (async () => {
    app.setPath('userData', path.join(world, 'user-data')); await app.whenReady(); console.log('stage: Electron ready');
    harness = spawn(process.execPath, [path.join(__dirname, 'visual-harness.cjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0', VISUAL_UPLOAD_DIR: path.join(world, 'uploads') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    harness.stderr.on('data', b => fs.appendFileSync(path.join(world, 'harness-stderr.log'), b));
    const url = await new Promise((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => reject(Error('offline harness timeout')), 15000);
      harness.stdout.on('data', b => { text += b; const m = text.match(/http:\/\/127\.0\.0\.1:\d+\//); if (m) { clearTimeout(timer); resolve(m[0]); } });
      harness.once('exit', code => { clearTimeout(timer); reject(Error('offline harness exited ' + code)); });
    });
    console.log('stage: harness ready ' + url);
    const http = require('node:http');
    proxy = http.createServer((req, res) => {
      if (req.url === '/') {
        const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html.replace('<head>', '<head><script>window.__sources=[];const RealSource=window.EventSource;window.EventSource=class extends RealSource{constructor(...a){super(...a);window.__sources.push(this)}};</script>'));
      }
      const upstream = http.request(new URL(req.url, url), { method: req.method, headers: req.headers }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream); res.on('close', () => upstream.destroy());
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    win = new BrowserWindow({ width: 1280, height: 900, show: true, autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    console.log('stage: window created');
    let loadTimer;
    try { await Promise.race([win.loadURL('http://127.0.0.1:' + proxy.address().port + '/'), new Promise((_, reject) => { loadTimer = setTimeout(() => reject(Error('fixture page load timeout')), 20000); })]); }
    finally { clearTimeout(loadTimer); }
    console.log('stage: page loaded');
    await new Promise(r => setTimeout(r, 1500));
    await read(`(async()=>{
      __sources.forEach(s=>s.close());
      window.__classic=await import('/state.js');window.__rpc=await import('/rpc.js');window.__draft=await import('/draft.js');window.__attachments=await import('/attachments.js');window.__composer=await import('/composer.js');
      window.__runtime=await import('/runtime-state.js');window.__conversation=await import('/runtime-conversation.js');window.__modal=await import('/runtime-sessions.js');window.__layer=await import('/ui/modal.js');window.__surface=await import('/ui/workspace-surface.js');
      window.__S=__classic.S;window.__calls=[];window.__finish=null;
      window.fetch=async(url,opts={})=>({json:async()=>{
        if(String(url).startsWith('/api/upload'))return new Promise(r=>window.__finish=r);
        if(opts.body){const b=JSON.parse(opts.body);__calls.push(b);if(b.command?.type==='extension_ui_response')return new Promise(r=>window.__finish=r);return{ok:true,data:{messages:[]}}}
        return{ok:true,backendInstance:'fixture',items:window.__records||[],models:[],sessions:[]};
      }});
      Object.assign(__S,{hasProject:true,bridgeState:'ready',switching:false,submitting:false,modelSwitchPending:false,fallbackActive:false,stopping:false,streaming:true,attachments:[],cwd:'C:/fixture',state:{sessionId:'A',model:{input:['text','image']}}});__S.localUsage.sessionId='A';
      window.__input=document.getElementById('input');__input.disabled=false;__surface.showChat();
      window.__owner=g=>({backendInstance:'fixture',projectId:'p',repoId:'r',workspaceId:'w',workspaceEpoch:'e',conversationId:'A',runtimeId:'rt',runtimeGeneration:g,sessionId:'s'});
      window.__item=(g,rev=1)=>({conversationId:'A',owner:g?__owner(g):null,workspace:{branch:'Review fixture',projectId:'p'},lifecycle:g?'ready':'dormant',activity:'idle',revision:rev});
      window.__seed=(g,rev=1)=>{__records=[__item(g,rev)];__runtime.seedRuntimeSnapshot({ok:true,backendInstance:'fixture',items:__records})};
      window.__btn=(host,text)=>[...host.querySelectorAll('button')].find(b=>b.textContent===text);
    })()`);
    await check('attachment parsing disables real Send and trusted Enter preserves input', async () => {
      await type('__input', 'Keep this question until parsing finishes');
      await read(`window.__upload=__attachments.handleFiles([new File(['fixture'],'slow.docx')]);__calls=[]`); await flush();
      assert.equal(await read("document.getElementById('btnSend').disabled"), true);
      await read('__input.focus()'); win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }); await flush();
      assert.equal(await read('__calls.length'), 0); assert.equal(await read('__input.value'), 'Keep this question until parsing finishes');
    });
    await check('upload completion sends extracted body with trusted Send click', async () => {
      await read(`__finish({ok:true,id:'ready',kind:'text',name:'slow.docx',text:'Parsed document body',chars:20});__upload`); await flush();
      assert.equal(await read("document.getElementById('btnSend').disabled"), false);
      await click("document.getElementById('btnSend')");
      assert.equal(await read("__calls.filter(c=>c.type==='steer'&&c.message.includes('Parsed document body')).length"), 1);
    });
    await check('classic response path saves pending A draft and restores B then A', async () => {
      await read(`__draft.resetDraftState();localStorage.clear();__S.state={sessionId:'A'};__S.localUsage.sessionId='A';__input.value='';__draft.initDraft();__draft.writeDraftText(__draft.draftKey(__draft.workspaceHash(),__draft.hashKey('B')),'Saved B draft')`);
      await type('__input', 'Unsent A draft before debounce');
      await read(`__rpc.onResponse({command:'get_state',success:true,data:{sessionId:'B'}})`); await flush();
      assert.equal(await read('__input.value'), 'Saved B draft');
      await type('__input', 'Edited B draft');
      await read(`__rpc.onResponse({command:'get_state',success:true,data:{sessionId:'A'}})`); await flush();
      assert.equal(await read('__input.value'), 'Unsent A draft before debounce');
      await read(`__rpc.onResponse({command:'get_state',success:true,data:{sessionId:'B'}})`); await flush();
      assert.equal(await read('__input.value'), 'Edited B draft');
    });
    await read(`__draft.resetDraftState();__runtime.runtimeStore.seed({backendInstance:'reset',items:[]});__seed('one');__surface.showRuntimeConversation();window.__host=document.getElementById('runtimeView');__host.replaceChildren();window.__view=__conversation.createRuntimeConversation({host:__host});__view.show('A');window.__approval=(id,n)=>__runtime.observeRuntimeFrame({type:'runtime_event',owner:__owner('one'),eventSequence:n,event:{type:'extension_ui_request',id,method:'confirm',title:'Approval '+id}});void 0`);
    for (const surface of ['central', 'modal']) {
      if (surface === 'modal') { await read(`__modal.openRuntimeSessions({})`); await flush(); await click(`document.querySelector('#modalCard [data-conversation-id="A"]')`); }
      await read(`__calls=[];__approval('first',${surface === 'central' ? 1 : 3});__approval('second',${surface === 'central' ? 2 : 4});window.__approvalHost=${surface === 'central' ? '__host' : "document.getElementById('modalCard')"};void 0`); await flush();
      await check(surface + ' approval pending blocks repeat; success removes only answered card', async () => {
        await click(`__btn(__approvalHost,'确认')`);
        assert.equal(await read(`__btn(__approvalHost,'确认').disabled`), true);
        await click(`__btn(__approvalHost,'确认')`);
        assert.equal(await read(`__calls.filter(c=>c.command?.type==='extension_ui_response').length`), 1);
        await read(`__finish({ok:true})`); await flush();
        assert.deepEqual(await read(`__runtime.runtimeStore.get('A').approvals.map(a=>a.id)`), ['second']);
      });
      await check(surface + ' approval failure reports error and permits retry', async () => {
        await click(`__btn(__approvalHost,'确认')`); await read(`__finish({ok:false,error:'Fixture approval failed'})`); await flush();
        assert.equal(await read(`__btn(__approvalHost,'确认').disabled`), false);
        assert.ok(await read(`__approvalHost.textContent.includes('Fixture approval failed')`));
        await click(`__btn(__approvalHost,'确认')`); await read(`__finish({ok:true})`); await flush();
        assert.equal(await read(`__runtime.runtimeStore.get('A').approvals.length`), 0);
      });
      if (surface === 'modal') await read(`__layer.closeModal()`);
    }
    await check('history reopen after runtime resume and close fetches fresh body', async () => {
      await read(`__seed(null,2);window.__reads=0;window.fetch=async(url,opts={})=>({json:async()=>String(url).includes('conversationId=')?{ok:true,messages:[{role:'user',text:'History version '+(++__reads)}]}:{ok:true,backendInstance:'fixture',items:__records}});void 0`);
      await click(`__btn(__host,'打开历史')`); assert.equal(await read('__reads'), 1);
      await read(`__seed('two',3);__seed(null,4)`); await flush();
      await click(`__btn(__host,'打开历史')`); assert.equal(await read('__reads'), 2);
      assert.ok(await read(`__host.textContent.includes('History version 2')&&!__host.textContent.includes('History version 1')`));
    });
    await check('streaming status redraw preserves real scrolled reading position', async () => {
      await read(`__seed('one',5);__runtime.observeRuntimeFrame({type:'runtime_event',owner:__owner('one'),eventSequence:1,event:{type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Reading line\\n'.repeat(200)}}})`); await flush();
      await read(`window.__out=__host.querySelector('.rtc-output');__out.scrollTop=100`); await flush(); const before = await read('__out.scrollTop');
      await read(`__runtime.observeRuntimeFrame({type:'runtime_event',owner:__owner('one'),eventSequence:2,event:{type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'More content\\n'}}})`); await flush();
      assert.equal(await read('__out.scrollTop'), before); assert.ok(await read('__out.scrollHeight>__out.clientHeight+160'));
    });
    fs.writeFileSync(path.join(world, 'report.json'), JSON.stringify({ passed: results.length, failed: 0, skipped: 0, results, layer: 'complete production app; trusted Electron input; offline API/SSE fixtures' }, null, 2));
    console.log(`Review Electron: ${results.length}/${results.length}; failed=0; skipped=0`);
  })().catch(e => { console.error(e); fs.writeFileSync(path.join(world, 'failure.json'), JSON.stringify({ results, error: String(e.stack) }, null, 2)); finalExit = 1; }).finally(async () => {
    win?.destroy(); proxy?.closeAllConnections(); if (proxy) await new Promise(r => proxy.close(r));
    if (harness && harness.exitCode === null) { harness.kill(); await new Promise(r => harness.once('exit', r)); } app.exit(finalExit);
  });
}
