/* Offline attachment acceptance: production app/CSS, real Chromium input and
 * screenshots. Uploads use the production handler through a local fixture proxy;
 * every project, profile and uploaded byte belongs to a fresh TEMP directory. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-attachments-'));
  const env = { ...process.env, ATTACHMENT_WORLD: world };
  delete env.ELECTRON_RUN_AS_NODE;
  const electronRoot = path.dirname(require.resolve('electron/package.json'));
  const executable = path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronRoot, 'dist'), 'electron.exe');
  if (!fs.existsSync(executable)) throw Error('An existing offline Electron runtime is required');
  const child = spawn(executable, [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: false });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; console.log('Attachment evidence: ' + world); });
} else {
  run().catch(error => { console.error(error); require('electron').app.exit(1); });
}

async function run() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { createUploads } = await import('../server/uploads.js');
  const world = process.env.ATTACHMENT_WORLD;
  const out = path.join(world, 'evidence');
  const baseline = process.argv.includes('--baseline');
  fs.mkdirSync(out);
  app.setPath('userData', path.join(world, 'profile'));
  app.on('window-all-closed', () => {});
  let win, harness, proxy;
  const checks = [], screenshots = [], facts = [], errors = [], commands = [];
  const uploads = createUploads({ dataDir: path.join(world, 'data') });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const read = code => win.webContents.executeJavaScript(code, true);
  const check = (name, pass, detail) => {
    checks.push({ name, pass: Boolean(pass), detail });
    console.log((pass ? 'PASS ' : 'FAIL ') + name + (pass ? '' : ' ' + JSON.stringify(detail)));
  };
  async function waitFor(code) {
    for (let attempt = 0; attempt < 160; attempt++) { if (await read(code)) return; await pause(50); }
    throw Error('Timed out: ' + code);
  }
  async function paint() { await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await pause(180); }
  async function shot(name) {
    await paint();
    const picture = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, name + '.png'), picture.toPNG());
    screenshots.push({ name, pixels: picture.getSize() });
  }
  async function click(selector) {
    win.focus(); win.webContents.focus();
    const point = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await paint();
  }
  async function key(keyCode, modifiers = []) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await paint();
  }
  const deadline = setTimeout(() => { console.error('Attachment Electron timeout'); win?.destroy(); harness?.kill(); proxy?.close(); app.exit(1); }, 240000);
  try {
    await app.whenReady();
    harness = spawn(process.execPath, [path.join(ROOT, 'tests/visual-harness.cjs')], {
      cwd: world, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0', VISUAL_UPLOAD_DIR: path.join(world, 'unused-harness-uploads') },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    harness.stderr.on('data', chunk => errors.push(String(chunk)));
    const upstream = await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(Error('Harness timeout')), 15000);
      harness.stdout.on('data', chunk => { output += chunk; const m = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); resolve(m[0]); } });
      harness.on('error', error => { clearTimeout(timer); reject(error); });
    });
    proxy = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/upload' && req.method === 'POST') return uploads.handle(req, res, url);
      if (url.pathname === '/api/command' && req.method === 'POST') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          const cmd = JSON.parse(Buffer.concat(chunks).toString());
          if (['prompt', 'steer'].includes(cmd.type)) {
            commands.push(cmd); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
          } else {
            const request = http.request(new URL(req.url, upstream), { method: 'POST', headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
            request.on('error', () => { res.writeHead(502); res.end(); }); request.end(Buffer.concat(chunks));
          }
        });
        return;
      }
      const request = http.request(new URL(req.url, upstream), { method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
      request.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(request);
      res.on('close', () => request.destroy());
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + proxy.address().port;
    ipcMain.handle('pi-gui:browser-agent-status', () => ({ ok: false, error: 'offline_fixture' }));
    ipcMain.handle('pi-gui:app-update-state', () => ({ state: 'idle' }));
    win = new BrowserWindow({ width: 1320, height: 820, useContentSize: true, show: true, autoHideMenuBar: true,
      webPreferences: { preload: path.join(ROOT, 'electron/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('blob:') && !details.url.startsWith('data:') && !details.url.startsWith('devtools:') }));
    win.webContents.on('render-process-gone', (_event, detail) => errors.push(detail.reason));
    await win.loadURL(origin);
    await waitFor(`document.querySelector('.project.active') && !document.querySelector('#input').disabled`);
    await pause(1600); // Let the existing harness's delayed boot readbacks settle.
    await read(`(async()=>{
      window.ST=await import('/state.js');window.A=await import('/attachments.js');window.C=await import('/composer.js');window.M=await import('/messages.js');window.TH=await import('/theme.js');
      M.setStreaming(false);M.rebuildFromMessages([{role:'user',content:[{type:'text',text:'检查这些附件，保留原文件。'}]},{role:'assistant',content:[{type:'text',text:'可以继续添加文件，或在下方输入具体任务。'}]}]);
      Object.assign(ST.S,{hasProject:true,bridgeState:'ready',switching:false,modelSwitchPending:false,submitting:false,stopping:false,fallbackActive:false,attachments:[],state:{...ST.S.state,model:{id:'offline-fixture',name:'离线验收',input:['text','image']}}});
      ST.el.input.disabled=false;ST.el.input.value='';ST.el.composerBox.classList.remove('is-locked');C.renderModelControls();
      window.mediaFixture=async()=>{
        const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const ctx=canvas.getContext('2d');
        const scene=frame=>{ctx.fillStyle='#182126';ctx.fillRect(0,0,320,180);ctx.fillStyle='#78b49b';ctx.fillRect(18,18,100,6);
          ctx.font='13px monospace';for(let i=0;i<6;i++){ctx.fillStyle=i%2?'#9eabb1':'#dadfe2';ctx.fillText('const frame_'+i+' = '+(i+1)+';',20,50+i*19);}
          ctx.fillStyle=frame%2?'#78b49b':'#9eabb1';ctx.fillRect(280,140,20,20);};
        scene(0);
        const image=new File([await new Promise(r=>canvas.toBlob(r,'image/png'))],'界面预览.png',{type:'image/png'});
        const stream=canvas.captureStream(12);
        const record=async(mime,name,frames)=>{const chunks=[];const recorder=new MediaRecorder(stream,{mimeType:mime});
          const stopped=new Promise(r=>{recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.onstop=r;});recorder.start();
          for(let frame=0;frame<frames;frame++){scene(frame);await new Promise(r=>setTimeout(r,100));}
          recorder.stop();await stopped;return new File(chunks,name,{type:mime.split(';')[0]});};
        const video=await record('video/webm;codecs=vp8','操作演示.webm',8);
        const mp4Supported=MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E');
        const videoMp4=mp4Supported?await record('video/mp4;codecs=avc1.42E01E','操作演示.mp4',10):null;
        let videoMp4Unsupported=null;window.mp4SampleEntryReplaced=false;
        if(videoMp4){const bytes=new Uint8Array(await videoMp4.arrayBuffer());let start=-1;
          /* Probe on this Chromium: an unknown sample-entry fourcc (zzzz) fails
           * with MEDIA_ERR_SRC_NOT_SUPPORTED, while hvc1/av01 still decode via
           * the avcC config. Keep the mutation at the real stsd sample entry. */
          for(let i=0;i<bytes.length-8;i++){if(bytes[i]===0x73&&bytes[i+1]===0x74&&bytes[i+2]===0x73&&bytes[i+3]===0x64){start=i;break;}}
          if(start>=0)for(let i=start+4;i<bytes.length-4;i++){if(bytes[i]===0x61&&bytes[i+1]===0x76&&bytes[i+2]===0x63&&bytes[i+3]===0x31){bytes.set([0x7a,0x7a,0x7a,0x7a],i);window.mp4SampleEntryReplaced=true;break;}}
          videoMp4Unsupported=new File([bytes],'不支持的编码.mp4',{type:'video/mp4'});}
        stream.getTracks().forEach(track=>track.stop());
        return {image,video,videoMp4,videoMp4Unsupported,mp4Supported};
      };
      window.fixtureMedia=await mediaFixture();
    })()`);
    check('normal sandbox enabled', win.webContents.getLastWebPreferences().sandbox);
    if (baseline) {
      await read(`(async()=>{await A.handleFiles([fixtureMedia.video,new File(['# 附件参考'],'说明文档.md',{type:'text/markdown'}),fixtureMedia.image]);})()`);
      for (const theme of ['dark', 'light']) {
        await read(`TH.setThemePreference('${theme}')`); await waitFor(`document.documentElement.dataset.theme==='${theme}'`); await shot('before-' + theme);
      }
      check('baseline actual upload and renderer', await read(`ST.S.attachments.length===3&&!ST.S.attachments.some(a=>a.loading)`));
    } else {
      const scenarios = require('./fixtures/attachment-scenarios.cjs');
      await scenarios({ read, waitFor, paint, shot, click, key, check, win, facts, commands, world, uploads });
    }
    check('no renderer crash or fixture server errors', errors.length === 0, errors);
  } catch (error) {
    check('attachment scenario completed', false, error.stack);
    if (win && !win.isDestroyed()) {
      try {
        facts.push({ failure: await read(`(()=>{const pane=document.querySelector('#rightPane');return{paneHidden:pane?.hidden,paneClass:pane?.className,previewKinds:[...pane.querySelectorAll('[class]')].map(e=>e.className).filter(v=>typeof v==='string'&&/^(?:fp-|files-)/.test(v)).slice(0,80),notes:[...pane.querySelectorAll('[role=status],.fp-fallback,.fp-media-status')].map(e=>e.textContent.slice(0,180)),media:[...pane.querySelectorAll('video,audio')].map(e=>({tag:e.tagName,readyState:e.readyState,networkState:e.networkState,error:e.error?.code||0,hasSource:e.hasAttribute('src')}))}})()`) });
        await shot('failure');
      } catch { /* retain the original failure even if screenshot capture fails */ }
    }
  } finally {
    clearTimeout(deadline);
    const failed = checks.filter(item => !item.pass).length;
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ baseline, passed: checks.length - failed, failed, skipped: 0, checks, facts, screenshots, errors,
      versions: { electron: process.versions.electron, chromium: process.versions.chrome },
      scope: 'Production renderer/CSS and upload/parser; offline fixture command receiver, no real Pi/model. Trusted pointer/keyboard; file input/CDP and synthetic drop/paste fixtures. Normal sandbox.' }, null, 2));
    console.log(`Attachment Electron: ${checks.length - failed}/${checks.length}; failed=${failed}; evidence=${out}`);
    win?.destroy(); harness?.kill();
    if (proxy) { proxy.closeAllConnections(); proxy.close(); }
    app.exit(failed ? 1 : 0);
  }
}
