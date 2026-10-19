// Opt-in trusted Electron interaction against production renderer modules/CSS.
// No real Pi, projects or accounts. Artifacts remain in a fresh TEMP directory.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-high-risk-electron-'));
  const env = { ...process.env, HIGH_RISK_ELECTRON_WORLD: world }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + path.join(world, 'user-data')], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; console.log('Electron evidence: ' + world); });
} else {
  const assert = require('node:assert/strict');
  const { app, BrowserWindow } = require('electron');
  const world = process.env.HIGH_RISK_ELECTRON_WORLD;
  let win, server, passed = 0;
  const results = [];
  const read = script => win.webContents.executeJavaScript(script, true);
  const flush = () => read('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const click = async selector => {
    const point = await read(`(()=>{const e=${selector};e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await flush();
  };
  const type = async text => { await read('__input().focus(); __input().select()'); await win.webContents.insertText(text); await flush(); };
  const shot = async name => { const file = path.join(world, name + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); return file; };
  (async () => {
    app.setPath('userData', path.join(world, 'user-data')); await app.whenReady();
    const { createRouter } = await import('../server/router.js');
    const route = createRouter({ auth: { denyRequest: () => null } });
    server = require('node:http').createServer((req, res) => {
      if (req.url === '/fixture') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/styles.css"><body><div class="app"><main class="stage" style="grid-column:1/-1"><div id="host" style="width:100%;height:100%"></div></main></div><div id="modal" class="modal" hidden><div id="modalCard" class="modal-card"></div></div><div id="confirmLayer" hidden><div id="confirmCard"></div></div><div id="toasts"></div></body></html>');
      }
      route(req, res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    win = new BrowserWindow({ width: 1200, height: 800, show: true, autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await win.loadURL(`http://127.0.0.1:${server.address().port}/fixture`);
    await read(`(async()=>{
      window.__state=await import('/runtime-state.js');window.__central=await import('/runtime-conversation.js');window.__modal=await import('/runtime-sessions.js');window.__layer=await import('/ui/modal.js');
      window.__owner=id=>({backendInstance:'fixture',projectId:'p',repoId:'r',workspaceId:id,workspaceEpoch:'e',conversationId:id,runtimeId:id,runtimeGeneration:'1',sessionId:id});
      window.__setup=async(surface)=>{
        window.__view?.dispose();window.__layer.closeModal();window.__surface=surface;
        __state.runtimeStore.seed({backendInstance:crypto.randomUUID(),items:[]});
        window.__records=['A','B'].map(id=>({conversationId:id,owner:__owner(id),workspace:{branch:id,projectId:'p'},lifecycle:'ready',activity:'running'}));
        __state.seedRuntimeSnapshot({ok:true,backendInstance:'fixture',items:__records});
        window.__calls=[];window.__finish=null;
        window.fetch=async(_url,opts={})=>({json:async()=>{
          if(!opts.body)return{ok:true,backendInstance:'fixture',items:__records};
          const body=JSON.parse(opts.body);__calls.push(body);
          if(body.command?.type==='prompt')return new Promise(r=>{window.__finish=r});
          if(body.action==='read')return{ok:true,data:{messages:[]}};return{ok:true};
        }});
        window.__view=null;
        if(surface==='central'){__view=__central.createRuntimeConversation({host:document.getElementById('host')});__view.show('A')}
        else __modal.openRuntimeSessions({});
      };
      window.__host=()=>document.getElementById(__surface==='central'?'host':'modalCard');
      window.__input=()=>__host().querySelector('textarea');window.__send=()=>[...__host().querySelectorAll('button')].find(b=>b.textContent==='发送');
    })()`);
    for (const surface of ['central', 'modal']) for (const scenario of ['unchanged', 'new', 'same-text', 'switch', 'failure', 'owner']) {
      await read(`__setup(${JSON.stringify(surface)})`); await flush();
      if (surface === 'modal') await click(`__host().querySelector('[data-conversation-id="A"]')`);
      await type('submitted draft'); await click('__send()');
      assert.equal(await read('typeof __finish'), 'function');
      assert.equal(await read('__input().disabled'), false);
      let expected = '';
      if (scenario === 'new' || scenario === 'switch') { await type('New draft stays after the previous request succeeds.'); expected = 'New draft stays after the previous request succeeds.'; }
      if (scenario === 'same-text') { await type('edited'); await type('submitted draft'); expected = 'submitted draft'; }
      if (scenario === 'failure') expected = 'submitted draft';
      if (scenario === 'owner') {
        await read(`__records[0]={...__records[0],owner:{...__owner('A'),runtimeId:'new',runtimeGeneration:'2'}};__state.seedRuntimeSnapshot({ok:true,backendInstance:'fixture',items:__records})`);
        await type('new owner draft'); expected = 'new owner draft';
      }
      if (scenario === 'switch') {
        if (surface === 'central') await read(`__view.show('B')`);
        else await click(`__host().querySelector('[data-conversation-id="B"]')`);
        await type('B independent draft');
      }
      if (scenario === 'new') await shot(surface + '-before-ack');
      await read(`__finish({ok:${scenario !== 'failure'}})`); await flush();
      const actual = await read(`({draft:__state.runtimeStore.get('A').draft,input:__input().value,requests:__calls.filter(c=>c.command?.type==='prompt').length})`);
      assert.equal(actual.draft, expected, surface + '/' + scenario + ' store');
      assert.equal(actual.input, scenario === 'switch' ? 'B independent draft' : expected, surface + '/' + scenario + ' textarea');
      assert.equal(actual.requests, 1);
      const screenshot = scenario === 'new' ? await shot(surface + '-after-ack') : null;
      passed++; results.push({ surface, scenario, pass: true, screenshot }); console.log('PASS Electron ' + surface + ': ' + scenario);
    }
    fs.writeFileSync(path.join(world, 'report.json'), JSON.stringify({ passed, failed: 0, results, layer: 'trusted Electron input; production renderer and CSS; fixture API' }, null, 2));
    console.log(`High-risk Electron: ${passed}/${passed}; trusted input; no real Pi`);
  })().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    win?.destroy(); await new Promise(resolve => server ? server.close(resolve) : resolve()); app.exit(process.exitCode || 0);
  });
}
