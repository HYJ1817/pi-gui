/* Production renderer/CSS + offline harness; fixtures only in os.tmpdir(). */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-visual-finish-'));
  const env = { ...process.env, VISUAL_WORLD: world }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, '--no-sandbox'], { env, stdio: 'inherit', windowsHide: true });
  child.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
} else run().catch(error => { console.error(error); require('electron').app.exit(1); });

async function run() {
  const { app, BrowserWindow } = require('electron');
  const world = process.env.VISUAL_WORLD, out = process.env.VISUAL_FINISH_OUT || path.join(world, 'evidence');
  app.setPath('userData', path.join(world, 'profile'));
  app.on('window-all-closed', () => {});
  const checks = [], errors = [], shots = [];
  let win, harness;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const read = source => win.webContents.executeJavaScript(source, true);
  function check(pass, name, detail) { checks.push({ pass: !!pass, name, detail }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (pass ? '' : ' ' + JSON.stringify(detail))); }
  async function shot(name) { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); shots.push(file); }
  async function key(name) {
    const codes = { Enter: ['Enter', 13, '\r'], Space: ['Space', 32, ' '], Right: ['ArrowRight', 39], Left: ['ArrowLeft', 37], Down: ['ArrowDown', 40], End: ['End', 35] };
    const [keyName, vk, text] = codes[name];
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName === 'Space' ? ' ' : keyName, code: keyName, windowsVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) });
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName === 'Space' ? ' ' : keyName, code: keyName, windowsVirtualKeyCode: vk }); await sleep(70);
  }
  async function waitFor(test) { for (let i = 0; i < 80; i++) { if (await read(test)) return; await sleep(60); } }
  async function click(selector, dy = 0) {
    const rect = await read(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)+${dy}}})()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', ...rect, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...rect, button: 'left', clickCount: 1 }); await sleep(80);
  }
  const timeout = setTimeout(() => { console.error('visual test timeout'); app.exit(1); }, 180000);
  try {
    fs.mkdirSync(out, { recursive: true }); await app.whenReady();
    harness = spawn(process.execPath, [path.join(ROOT, 'tests/visual-harness.cjs')], {
      cwd: world, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0', VISUAL_PUBLIC_ROOT: process.env.VISUAL_ASSETS_ROOT || path.join(ROOT, 'public'), VISUAL_UPLOAD_DIR: path.join(world, 'uploads') },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    harness.stderr.on('data', data => errors.push(String(data)));
    const origin = await new Promise((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => reject(Error('harness timeout')), 15000);
      harness.stdout.on('data', data => { text += data; const match = text.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
      harness.on('error', reject);
    });
    win = new BrowserWindow({ width: 1200, height: 900, show: true, useContentSize: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    await win.loadURL(origin); await sleep(1500); win.focus(); win.webContents.focus(); win.webContents.debugger.attach('1.3');
    await read(`(async()=>{window.ST=await import('/state.js');window.V=await import('/ui3-model-picker.js');window.POP=await import('/ui/popover.js');window.M=await import('/messages.js');window.N=await import('/conversation-nav.js');window.T=await import('/ui/toast.js');window.E=await import('/extension-notices.js');window.X=await import('/extensions.js');window.C=await import('/composer.js');
      Object.assign(ST.S,{hasProject:true,bridgeState:'ready',switching:false,modelSwitchPending:false,submitting:false,stopping:false,fallbackActive:false,attachments:[],thinkingReadStatus:'success',thinkingLevels:['off','low','high'],state:{...ST.S.state,model:{provider:'alpha',id:'one',reasoning:true},thinkingLevel:'low'}});ST.el.input.disabled=false;ST.el.composerBox.classList.remove('is-locked');C.renderModelControls();
      window.models=[{provider:'alpha',id:'one',name:'当前模型',reasoning:true},{provider:'beta',id:'two',name:'备用模型',reasoning:true}];window.picks=[];window.expanded=new Set();
      window.openModel=()=>V.renderModelPicker({models,current:models[0],expanded,onSelect:(...args)=>picks.push(args)});
      window.openThink=()=>V.renderThinkingPicker({levels:['off','low','high'],current:'low',model:models[0],onSelect:level=>picks.push(level)});
      M.rebuildFromMessages([{role:'user',content:[{type:'text',text:'请检查这次请求。'}]},{role:'assistant',stopReason:'error',errorMessage:'当前模型认证失败，自动备用未执行',content:[]}]);
    })()`);
    const summary = '#usageDetails summary';
    await click(summary);
    check(await read(`document.querySelector('#usageDetails').open`), 'context whole row opens details with mouse');
    await key('Enter'); check(await read(`!document.querySelector('#usageDetails').open`), 'context native keyboard Enter closes details');
    check(await read(`['none','normal','""'].includes(getComputedStyle(document.querySelector('#usageDetails summary'),'::after').content)`), 'context has no decorative arrow');
    for (const theme of ['light', 'dark']) {
      await read(`document.documentElement.dataset.theme='${theme}';openModel()`); await sleep(100);
      const model = await read(`(()=>{const e=document.querySelector('.ui3-model-item.on'),s=getComputedStyle(e),p=document.querySelector('.pop-provider'),r=p.getBoundingClientRect();return {bg:s.backgroundColor,shadow:s.boxShadow,check:getComputedStyle(e.querySelector('.pi-check')).color,arrow:document.querySelectorAll('.pop-provider-chev').length,width:r.width}})()`);
      check(model.bg === 'rgba(0, 0, 0, 0)' && model.shadow === 'none' && model.arrow === 0 && model.width > 200, theme + ': flat model selection and full provider button', model);
      await shot(theme + '-models');
      await read(`document.querySelector('.pop-provider[data-provider="beta"]').focus()`); await key('Right');
      check(await read(`document.querySelector('.pop-provider[data-provider="beta"]').getAttribute('aria-expanded')==='true'`), theme + ': keyboard expands arrowless provider');
      await key('Left'); await key('Space');
      check(await read(`document.querySelector('.pop-provider[data-provider="beta"]').getAttribute('aria-expanded')==='true'`), theme + ': native Space toggles provider');
      await click('.ui3-model-item[data-provider="beta"]');
      check(await read(`picks.filter(p=>Array.isArray(p)&&p[0]==='beta'&&p[1]==='two').length===${theme === 'light' ? 1 : 2}`), theme + ': actual mouse selects correct provider/model once');
      await read('openThink()'); await sleep(80);
      check(await read(`(()=>{const s=getComputedStyle(document.querySelector('.ui3-think-item.on'));return s.backgroundColor==='rgba(0, 0, 0, 0)'&&s.boxShadow==='none'})()`), theme + ': flat thinking selection');
      await read(`document.querySelector('.ui3-think-item.on').focus()`); await key('Down');
      check(await read(`getComputedStyle(document.activeElement).outlineStyle!=='none'`), theme + ': keyboard focus remains visible');
      await shot(theme + '-thinking'); await key('Enter');
      check(await read(`picks.filter(p=>p==='high').length===${theme === 'light' ? 1 : 2}`), theme + ': keyboard changes thinking once');
      const error = await read(`(()=>{const e=document.querySelector('.msg-err');return [e,...e.children].map(n=>{const s=getComputedStyle(n);return {bg:s.backgroundColor,border:s.borderTopWidth,left:s.borderLeftWidth,pad:s.paddingLeft,color:s.color}})})()`);
      check(error.every(s => s.bg === 'rgba(0, 0, 0, 0)' && s.border === '0px' && s.left === '0px'), theme + ': error has no nested panels or borders', error);
      check(await read(`document.querySelector('.me-raw').textContent.includes('自动备用未执行')&&!document.querySelector('.msg-err svg')&&!document.querySelector('.msg-err[role=alert]')`), theme + ': history detail retained without repeated alert');
      await shot(theme + '-error');
    }
    await read(`document.getElementById('toasts').replaceChildren();for(let i=0;i<20;i++){T.toast('保存成功','success');E.handleExtensionNotification({message:'memory_search requires qmd. Install qmd',notifyType:'warning'})}`);
    check(await read(`document.querySelectorAll('.toast').length===0&&E.extensionNotices()[0].count===20`), 'routine operations and repeated optional dependency produce zero popups');
    await read(`X.openExtensions({tab:'capabilities'})`); await sleep(300);
    check(await read(`document.querySelector('.extension-notices').textContent.includes('memory_search requires qmd')`), 'dependency remains in live extension settings');
    await shot('extension-status');
    await read(`(async()=>{(await import('/ui/workspace-surface.js')).showChat();M.rebuildFromMessages(Array.from({length:500},(_,i)=>[{role:'user',content:[{type:'text',text:'问题 '+i}]},{role:'assistant',content:[{type:'text',text:'离线导航验证。'.repeat(60)}]}]).flat());N.rebuildConversationNav();ST.el.stream.style.scrollBehavior='auto';})()`); await sleep(250);
    const nav = await read(`(()=>{const n=document.querySelector('#convoNav'),m=[...n.querySelectorAll('.cn-marker')],r=n.getBoundingClientRect();return {h:r.height,sh:n.scrollHeight,width:r.width,min:Math.min(...m.map(e=>e.getBoundingClientRect().height)),gap:parseFloat(m[1].style.top)-parseFloat(m[0].style.top),stage:document.querySelector('.stage').scrollTop,page:document.documentElement.scrollWidth}})()`);
    check(nav.h <= 280 && nav.sh > nav.h && nav.width === 24 && nav.min === 12 && nav.gap >= 12 && nav.page <= 1200, '500 targets remain in bounded thin rail with nonoverlapping hit areas', nav);
    await read(`const target=document.querySelectorAll('.cn-marker')[320];document.querySelector('#convoNav').scrollTop=parseFloat(target.style.top)-100`);
    await click('.cn-marker:nth-child(321)', 4); await waitFor(`Math.abs(ST.S.thread.querySelectorAll('.msg.user')[320].getBoundingClientRect().top-ST.el.stream.getBoundingClientRect().top-20)<=2`);
    const jump = await read(`(()=>{const stream=ST.el.stream,n=ST.S.thread.querySelectorAll('.msg.user')[320];return {delta:n.getBoundingClientRect().top-stream.getBoundingClientRect().top,index:N.currentNavIndex(),stage:document.querySelector('.stage').scrollTop,current:document.querySelectorAll('.cn-marker[aria-current=true]').length}})()`);
    check(Math.abs(jump.delta - 20) <= 2 && jump.current === 1 && jump.stage === nav.stage, 'clicking transparent area jumps to exact message without moving stage', jump);
    await key('End');
    check(await read(`document.activeElement===document.querySelectorAll('.cn-marker')[499]`), 'End reveals and focuses last of 500 targets');
    const tip = await read(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),t=e.querySelector('.cn-tip').getBoundingClientRect();return {targetRight:r.right,tipLeft:t.left,tipRight:t.right}})()`);
    check(Math.abs(tip.tipLeft - tip.targetRight - 8) <= 2 && tip.tipRight <= 1200, 'navigation preview escapes the scroll rail without clipping or offset', tip);
    await key('Enter'); await waitFor(`Math.abs(ST.el.stream.scrollTop-Math.min(ST.el.stream.scrollHeight-ST.el.stream.clientHeight,N.navEntries()[499].topInContent-20))<=2`);
    check(await read(`Math.abs(ST.el.stream.scrollTop-Math.min(ST.el.stream.scrollHeight-ST.el.stream.clientHeight,N.navEntries()[499].topInContent-20))<=2`), 'last target remains keyboard accessible at clamped scroll position');
    await shot('long-navigation');
    for (const width of [700, 900, 1536]) {
      win.setContentSize(width, 800); await sleep(200);
      check(await read(`document.documentElement.scrollWidth<=innerWidth`), width + 'px: no page overflow');
      await shot('responsive-' + width);
    }
    check(errors.length === 0, 'no renderer or harness errors', errors);
  } catch (error) { check(false, 'runner completed', error.stack); }
  finally {
    clearTimeout(timeout); const failed = checks.filter(c => !c.pass).length;
    fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ passed: checks.length - failed, failed, checks, shots, errors }, null, 2));
    console.log(`Visual Electron: ${checks.length - failed}/${checks.length}; failed=${failed}; evidence=${out}`);
    win?.destroy(); harness?.kill(); app.exit(failed ? 1 : 0);
  }
}
