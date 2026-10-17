/* UI-3A: production modules, temporary/offline fixtures. --electron renders real CSS. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs/claude-ui-redesign/ui3a-evidence');
const checks = [];
function check(name, fn) {
  try { fn(); checks.push({ name, pass: true }); console.log('PASS ' + name); }
  catch (e) { checks.push({ name, pass: false, error: e.message }); console.error('FAIL ' + name + ': ' + e.message); }
}
function finish(extra = {}) {
  const failed = checks.filter(c => !c.pass).length;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, process.versions.electron ? 'electron.json' : 'unit.json'), JSON.stringify({ passed: checks.length - failed, failed, skipped: 0, checks, ...extra }, null, 2));
  console.log(`UI3 Composer: ${checks.length - failed}/${checks.length}, failed=${failed}, skipped=0`);
  return failed ? 1 : 0;
}
async function unit() {
  const { JSDOM } = require('jsdom'), { bundle } = require('./esm-bundle.cjs');
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'), { url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  w.eval(bundle(path.join(ROOT, 'public/attachments.js')).code);
  Object.assign(w.S, { hasProject: true, bridgeState: 'ready', switching: false, modelSwitchPending: false, submitting: false, stopping: false, fallbackActive: false, attachments: [], state: { model: { input: ['text', 'image'] } } });
  const input = d.getElementById('input'), tray = d.getElementById('attachTray'), send = d.getElementById('btnSend');
  input.value = '草稿';
  for (const flag of ['switching', 'modelSwitchPending', 'submitting', 'stopping', 'fallbackActive']) {
    w.S[flag] = true; w.updateSendState();
    check(flag + ' blocks actual send and mirrors disabled state', () => { assert.equal(send.disabled, true); assert.equal(d.getElementById('composerBox').dataset.sendDisabled, 'true'); });
    w.S[flag] = false;
  }
  w.S.hasProject = false; w.updateSendState();
  check('no project cannot send', () => assert.equal(send.disabled, true));
  w.S.hasProject = true; w.S.bridgeState = 'starting'; w.updateSendState();
  check('bridge not ready cannot send', () => assert.equal(send.disabled, true));
  w.S.bridgeState = 'ready'; w.updateSendState();
  check('ready text sends without changing draft', () => { assert.equal(send.disabled, false); assert.equal(input.value, '草稿'); });
  input.value = ''; w.updateSendState();
  check('empty composer disabled', () => assert.equal(send.disabled, true));
  for (const attachment of [{ id: 'load', name: 'upload.txt', loading: true }, { id: 'err', name: 'bad.pdf', error: '提取失败' }]) {
    w.S.attachments = [attachment]; w.renderAttachments(); w.updateSendState();
    check('existing attachment send policy preserved: ' + attachment.id, () => assert.equal(send.disabled, false));
  }
  const fixtures = [
    { id: 'img', name: 'image.png', size: 1024, kind: 'image', dataUrl: 'data:image/png;base64,YQ==' },
    { id: 'txt', name: '长文件名'.repeat(40) + '.txt', path: 'C:/fixture/long/file.txt', size: 2048, kind: 'text', chars: 3, text: '原文', truncated: true },
    { id: 'load', name: 'loading.pdf', size: 10, loading: true },
    { id: 'err', name: '<img src=x onerror=alert(1)>.docx', size: 30, error: '<b>提取失败</b>' },
    { id: 'binary', name: 'archive.bin', size: 50, kind: 'binary' },
  ];
  w.S.attachments = fixtures; const original = JSON.stringify(fixtures);
  w.renderAttachments();
  check('all attachments render without content mutation', () => { assert.equal(tray.children.length, 5); assert.equal(JSON.stringify(fixtures), original); });
  check('explicit states distinguish ready/loading/error/unreadable', () => assert.equal([...tray.children].map(e => e.dataset.state).join(','), 'ready,truncated,loading,error,unreadable'));
  check('thumbnail and size shown, long filename retains full path', () => { assert.equal(tray.querySelector('img').getAttribute('src'), fixtures[0].dataUrl); assert.equal(tray.querySelectorAll('.ui3-attachment-size').length, 5); assert.equal(tray.children[1].querySelector('.att-name').title, fixtures[1].path); });
  check('untrusted name and error are inert text', () => { assert.equal(tray.children[3].querySelector('img,b'), null); assert.ok(tray.children[3].textContent.includes('<b>提取失败</b>')); });
  check('loading exposes busy state and truncation stays explicit', () => { assert.equal(tray.children[2].getAttribute('aria-busy'), 'true'); assert.ok(tray.children[1].textContent.includes('已截断')); });
  for (const inputTypes of [['text'], ['text', 'image'], null]) {
    w.S.state.model = inputTypes ? { input: inputTypes } : {};
    w.renderAttachments(); w.updateSendState();
    check('image capability ' + JSON.stringify(inputTypes), () => { assert.equal(send.disabled, inputTypes?.length === 1); assert.equal(tray.children[0].dataset.state, inputTypes?.length === 1 ? 'blocked' : 'ready'); });
  }
  w.S.state.model = { input: ['text', 'image'] };
  const beforeMessage = w.buildMessage('正文'), beforeImages = JSON.stringify(w.attachmentImages());
  w.renderAttachments();
  check('presentation preserves message and image wire format', () => { assert.equal(w.buildMessage('正文'), beforeMessage); assert.equal(JSON.stringify(w.attachmentImages()), beforeImages); assert.ok(beforeMessage.includes('<pi-file name="' + fixtures[1].name + '" meta="3 字 · 已截断">\n原文\n…（内容过长，已截断）\n</pi-file>')); assert.equal(beforeImages, '[{"type":"image","data":"YQ==","mimeType":"image/png"}]'); });
  tray.querySelectorAll('.att-x')[1].focus(); w.renderAttachments();
  check('async redraw retains focused removal button', () => assert.equal(d.activeElement.dataset.attachmentId, 'txt'));
  d.activeElement.click();
  check('remove transfers focus and removes only selected file', () => { assert.equal(w.S.attachments.length, 4); assert.equal(d.activeElement.dataset.attachmentId, 'load'); });
  w.S.attachments = [fixtures[0]]; w.renderAttachments(); tray.querySelector('.att-x').focus(); d.activeElement.click();
  check('last removal returns focus to attach control', () => { assert.equal(tray.hidden, true); assert.equal(d.activeElement.id, 'btnAttach'); });
  w.S.attachments = [{ id: 'zero', name: 'zero.txt', kind: 'text', size: 0, chars: 0 }, { id: 'unknown', name: 'unknown.bin', kind: 'binary' }];
  w.renderAttachments();
  check('zero file size is real while missing file size stays hidden', () => { assert.equal(tray.children[0].querySelector('.ui3-attachment-size').textContent, '0 B'); assert.equal(tray.children[1].querySelector('.ui3-attachment-size').hidden, true); });
  w.S.attachments = [];
  let resolveUpload, uploadBody;
  w.fetch = (_url, options) => { uploadBody = options.body; return new Promise(resolve => { resolveUpload = payload => resolve({ json: async () => payload }); }); };
  const file = new w.File(['fixture body'], 'fixture.txt', { type: 'text/plain' });
  const uploading = w.handleFiles([file]);
  check('actual upload pipeline exposes loading without changing file body', () => { assert.equal(tray.firstElementChild.dataset.state, 'loading'); assert.equal(uploadBody, file); });
  resolveUpload({ ok: true, kind: 'text', size: 12, chars: 12, text: 'fixture body', truncated: true }); await uploading;
  check('actual extraction result exposes truncation and original text', () => { assert.equal(tray.firstElementChild.dataset.state, 'truncated'); assert.equal(w.S.attachments[0].text, 'fixture body'); });
  w.fetch = async () => ({ json: async () => ({ ok: false, error: '无法提取 PDF 内容' }) });
  await w.handleFiles([new w.File(['invalid pdf'], 'bad.pdf')]);
  check('actual failed extraction never presents success', () => { assert.equal(tray.lastElementChild.dataset.state, 'error'); assert.ok(!tray.lastElementChild.textContent.includes('已就绪')); });
  w.S.state.model = { input: ['text'] }; const count = w.S.attachments.length;
  await w.handleFiles([new w.File(['image'], 'blocked.png', { type: 'image/png' })]);
  check('actual file selection obeys image capability false', () => assert.equal(w.S.attachments.length, count));
  let scrollHeight = 300;
  Object.defineProperty(input, 'scrollHeight', { get: () => scrollHeight });
  w.autoGrow(); check('long input caps at 184px', () => assert.equal(input.style.height, '184px'));
  Object.defineProperty(w, 'innerHeight', { value: 600, configurable: true });
  w.autoGrow(); check('short viewport caps at 24vh', () => assert.equal(input.style.height, '144px'));
  scrollHeight = 42; w.autoGrow(); check('input shrinks after text removal', () => assert.equal(input.style.height, '42px'));
  const composer = d.getElementById('chatComposer'); let width = 500, height = 230, observer;
  composer.getBoundingClientRect = () => ({ width, height });
  w.ResizeObserver = class { constructor(fn) { observer = fn; } observe() {} };
  w.initComposerLayout();
  check('single measured reserved height', () => assert.equal(composer.closest('.stage').style.getPropertyValue('--composer-reserved-height'), '230px'));
  scrollHeight = 115; width = 340; observer();
  await new Promise(resolve => w.requestAnimationFrame(resolve));
  check('side pane width change recalculates input height', () => assert.equal(input.style.height, '115px'));
  height = 280; w.dispatchEvent(new w.Event('resize'));
  check('window resize refreshes reservation and preserves draft', () => { assert.equal(composer.closest('.stage').style.getPropertyValue('--composer-reserved-height'), '280px'); assert.equal(input.value, ''); });
  dom.window.close(); process.exitCode = finish();
}

if (!process.versions.electron && !process.argv.includes('--electron')) unit().catch(e => { console.error(e); process.exitCode = 1; });
else if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'ui3a-electron-'));
  const env = { ...process.env, UI3A_WORLD: world }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: false });
  child.on('error', e => { console.error(e); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; fs.rm(world, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }, () => {}); });
} else electron();

async function electron() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { spawn } = require('node:child_process');
  const { createBrowserController } = require('../electron/browser-view.cjs');
  const { createBrowserAgentHost } = require('../electron/browser-agent-host.cjs');
  app.setPath('userData', process.env.UI3A_WORLD);
  app.on('window-all-closed', () => {});
  let win, harness, controller, agent;
  const errors = [], facts = [], screenshots = [], started = Date.now();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const read = code => win.webContents.executeJavaScript(code, true);
  const verify = (name, ok, detail) => check(name, () => assert.ok(ok, JSON.stringify(detail)));
  async function shot(name) {
    const file = name + '.png';
    fs.writeFileSync(path.join(OUT, file), (await win.webContents.capturePage()).toPNG());
    screenshots.push(file);
  }
  async function setInput(value) {
    await read(`ST.el.input.value=${JSON.stringify(value)};ST.el.input.dispatchEvent(new Event('input',{bubbles:true}));`);
    await sleep(90);
  }
  async function geometry(name) {
    const f = await read(`(()=>{
      const q=s=>document.querySelector(s), rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}};
      const box=q('#composerBox'),stream=q('#stream'), last=q('.thread>.msg:last-of-type');
      const br=rect(box),ir=rect(q('#input'));
      return {width:innerWidth,height:innerHeight,headerBottom:q('.stage-head').getBoundingClientRect().bottom,page:document.documentElement.scrollWidth,box:br,input:ir,inputScrollWidth:q('#input').scrollWidth,inputClientWidth:q('#input').clientWidth,
        pane:{hidden:q('#rightPane').hidden,surface:q('#rightPane').dataset.surface,mode:q('#rightPane').dataset.mode},
        reserved:parseFloat(getComputedStyle(q('.stage')).getPropertyValue('--composer-reserved-height')),
        composer:rect(q('#chatComposer')),last:last?rect(last):null, draft:ST.el.input.value,
        gap:stream.scrollHeight-stream.clientHeight-stream.scrollTop,
        controls:[...box.querySelectorAll('.composer-bar button:not([hidden])')].filter(e=>e.getClientRects().length).map(e=>({id:e.id||e.className,...rect(e)})),
        attachments:[...box.querySelectorAll('.att')].map(e=>({...rect(e),sw:e.scrollWidth,cw:e.clientWidth})),
        tray:{h:q('#attachTray').clientHeight,sh:q('#attachTray').scrollHeight},
        surface:getComputedStyle(box).backgroundColor,focus:getComputedStyle(box).borderColor,
        axis:{boxCenter:br.x+br.w/2,threadCenter:(()=>{const r=q('.thread').getBoundingClientRect();return r.x+r.width/2})()}};
    })()`);
    facts.push({ name, ...f });
    verify(name + ' viewport, controls and cards fit', f.page <= f.width + 1 && f.box.right <= f.width + 1 && f.box.x >= 0
      && f.controls.every(r => r.x >= f.box.x - 1 && r.right <= f.box.right + 1 && r.bottom <= f.box.bottom + 1)
      && f.inputScrollWidth <= f.inputClientWidth + 1 && f.attachments.every(r => r.sw <= r.cw + 1 && r.w <= f.box.w), f);
    verify(name + ' measured reservation, axis and input cap', Math.abs(f.reserved - f.composer.h) <= 1 && Math.abs(f.axis.boxCenter - f.axis.threadCenter) <= 2
      && f.input.h <= Math.min(184, f.height * .24) + 1, f);
    return f;
  }
  const timer = setTimeout(() => { console.error('UI3A Electron timeout'); app.exit(1); }, 240000);
  try {
    fs.mkdirSync(OUT, { recursive: true }); await app.whenReady();
    harness = spawn(process.execPath, [path.join(ROOT, 'tests/visual-harness.cjs')], { cwd: process.env.UI3A_WORLD, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    harness.stderr.on('data', c => errors.push(String(c)));
    const origin = await new Promise((resolve, reject) => {
      let output = ''; const timeout = setTimeout(() => reject(Error('harness timeout')), 15000);
      harness.stdout.on('data', c => { output += c; const m = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timeout); resolve(m[0]); } });
      harness.on('error', reject);
    });
    win = new BrowserWindow({ width: 1200, height: 900, useContentSize: true, show: true, webPreferences: { preload: path.join(ROOT, 'electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    controller = createBrowserController({ origin, getWindow: () => win, ipcMain }); controller.register();
    agent = createBrowserAgentHost({ browser: controller, origin, getWindow: () => win, ipcMain, extensionPath: path.join(ROOT, 'extensions/pi-gui-browser/index.js') });await agent.start();
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    await win.loadURL(origin); await sleep(2300);
    await read(`(async()=>{
      window.ST=await import('/state.js');window.C=await import('/composer.js');window.A=await import('/attachments.js');window.M=await import('/messages.js');
      const link=document.createElement('link');link.rel='stylesheet';link.href='/ui3-composer.css';await new Promise((res,rej)=>{link.onload=res;link.onerror=rej;document.head.append(link)});
      M.rebuildFromMessages(Array.from({length:18},(_,i)=>({role:i%2?'assistant':'user',content:[{type:'text',text:i===17?'最后一条消息：输入增高后仍应可见。':'Offline fixture '+i+' '+('中文与 English history paragraph. '.repeat(12))}]})));
      Object.assign(ST.S,{hasProject:true,bridgeState:'ready',switching:false,modelSwitchPending:false,submitting:false,stopping:false,fallbackActive:false,attachments:[],state:{...ST.S.state,model:{input:['text','image']}}});
      ST.el.input.disabled=false;ST.el.composerBox.classList.remove('is-locked');
      window.atts=()=>[
        {id:'image',name:'示例缩略图.png',kind:'image',size:1024,dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH4kAAAAASUVORK5CYII='},
        {id:'long',name:'LongFilename'.repeat(20)+'.txt',path:'C:/temporary/fixture/example.txt',kind:'text',size:10240,chars:1234,text:'fixture',truncated:true},
        {id:'loading',name:'正在解析.pdf',size:2048,loading:true},
        {id:'error',name:'失败文件.docx',size:3000,error:'无法提取内容，请更换文件'},
        {id:'binary',name:'未解析.zip',size:5000,kind:'binary'},
        {id:'ready',name:'已读取.txt',size:0,kind:'text',chars:0,text:''}];
      ST.S.attachments=atts();A.renderAttachments();C.updateSendState();
      document.querySelector('#modelText').textContent='Long model identifier '+ 'model'.repeat(15);
    })()`);
    await setInput('第一行'); const single = await geometry('single-line'); await shot('single-line');
    await setInput(Array.from({ length: 10 }, (_, i) => '第 ' + i + ' 行中文 English 输入内容。').join('\n'));
    const ten = await geometry('ten-lines'); verify('ten lines grow and preserve text', ten.input.h > single.input.h && ten.draft.split('\n').length === 10);
    await shot('ten-lines');
    // Bottom visibility measured after growth, not inferred from CSS strings.
    await read(`ST.el.stream.scrollTop=ST.el.stream.scrollHeight`); await sleep(80);
    await setInput('短输入'); await read(`ST.el.stream.scrollTop=ST.el.stream.scrollHeight`); await sleep(80);
    await setInput(('十行输入内容\n').repeat(10)); const grown = await geometry('growth-at-bottom');
    verify('last message remains above composer after growth', grown.last.bottom <= grown.box.y + 1 && grown.last.bottom > grown.composer.y - 90, grown);
    verify('actual final assistant text rendered', await read(`document.querySelector('.thread>.msg:last-of-type').textContent.includes('最后一条消息')`));
    await read(`ST.el.stream.scrollTop=120`); await setInput('短输入');await setInput(('十行内容\n').repeat(10));
    verify('composer growth leaves history reader position intact', await read(`Math.abs(ST.el.stream.scrollTop-120)<=2`));
    await setInput('VeryLongEnglishWithoutSpaces'.repeat(300)); await geometry('long-English');
    await setInput('中文粘贴段落'.repeat(500)); await geometry('long-Chinese');
    // Actual keyboard event enters textarea through the production app listener.
    await setInput('Shift'); await read(`ST.el.input.focus();ST.el.input.setSelectionRange(5,5)`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] });
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['shift'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] }); await sleep(80);
    verify('Shift+Enter inserts newline without submission', await read(`ST.el.input.value==='Shift\\n'&&!ST.S.submitting`));
    await setInput(('布局验收 English 0123456789\n').repeat(10));
    for (const theme of ['dark', 'light']) for (const width of [700, 900, 1200, 1536]) for (const sidebar of [true, false]) {
      win.setContentSize(width, 900);
      await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector(${JSON.stringify(sidebar ? '#btnSidebarExpand' : '#btnSidebarCollapse')}).click();`);
      // Click chosen above ensures the requested state using existing collapse/focus code.
      for (const pane of ['closed', 'changes', 'browser']) {
        await read(`(async()=>{if(${JSON.stringify(pane)}==='closed')document.querySelector('#rightPane .secondary-close,#browserClose')?.click();else if(${JSON.stringify(pane)}==='browser'){const b=document.querySelector('#btnBrowser');if(b.getAttribute('aria-pressed')!=='true')b.click();}else{const g=await import('/git.js');g.openChangesPanel();}})()`);
        await sleep(130); await read(`ST.el.stream.scrollTop=ST.el.stream.scrollHeight`); await sleep(30);
        const name = `${theme}-${width}-sidebar-${sidebar}-${pane}`;
        const g = await geometry(name);
        verify(name + ' requested real pane state', pane==='closed'?g.pane.hidden:!g.pane.hidden&&g.pane.surface===pane, g.pane);
        await shot(name);
      }
    }
    for (const zoom of [.8, 1.25, 1.5]) for (const theme of ['dark', 'light']) {
      win.webContents.setZoomFactor(zoom);win.setContentSize(900, 600);
      await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('#btnSidebarExpand').click();document.querySelector('#rightPane .secondary-close,#browserClose')?.click()`);await sleep(150);
      await read(`ST.el.stream.scrollTop=ST.el.stream.scrollHeight`);await sleep(40);
      const g = await geometry(`${theme}-zoom-${zoom}-short-window`);
      verify(`${theme} zoom ${zoom} last message text remains visible at bottom`,g.last.bottom<=g.box.y+1&&g.last.bottom>=g.headerBottom+20,g);
      await shot(`${theme}-zoom-${zoom}-short-window`);
    }
    win.webContents.setZoomFactor(1);win.setContentSize(1200,900);
    await read(`ST.S.stopping=true;C.updateSendState();ST.el.btnStop.hidden=false;ST.el.btnSend.hidden=false;ST.el.input.focus()`);await sleep(100);await shot('stopping-focus');
    verify('stopping disables both actual controls without losing draft', await read(`ST.el.btnSend.disabled&&ST.el.btnStop.disabled&&ST.el.composerBox.dataset.sendDisabled==='true'&&ST.el.input.value.length>0`));
    await read(`ST.S.state.model={input:['text']};A.renderAttachments();ST.el.attachTray.scrollTop=0`); await shot('image-unsupported');
    verify('unsupported image presentation remains blocked in real Electron', await read(`document.querySelector('.att[data-state="blocked"]').textContent.includes('不支持图片')`));
    await read(`ST.S.stopping=false;C.updateSendState();document.querySelector('#btnSidebarCollapse').click();document.querySelector('#btnBrowser').click();`);await sleep(100);
    await read(`ST.el.attachTray.querySelector('.att-x').focus()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });await sleep(100);
    verify('keyboard removes attachment and retains tray focus', await read(`ST.S.attachments.length===5&&ST.el.attachTray.contains(document.activeElement)`));
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    verify('reduced motion disables local transition and spinner', await read(`getComputedStyle(ST.el.composerBox).transitionDuration==='0s'&&getComputedStyle(document.querySelector('.att-spin')).animationName==='none'`));
    await shot('reduced-motion');
    verify('no renderer/harness errors', errors.length === 0, errors);
  } catch (e) { check('Electron fixture completed', () => { throw e; }); }
  finally {
    clearTimeout(timer);
    const code = finish({ facts, screenshots, errors, durationMs: Date.now() - started, versions: { electron: process.versions.electron, chromium: process.versions.chrome }, scope: 'Actual production app, modules, styles, preload and Browser controller, offline fixture APIs; CSS explicitly injected by fixture only. Synthetic keyboard, no real IME or real Pi. No native titlebar claim.' });
    await agent?.stop?.();controller?.destroy?.();win?.destroy();harness?.kill();await sleep(150);app.exit(code);
  }
}
