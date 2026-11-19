/* 历史消息编辑：真实 Electron + 真实后端 + 真实 Pi + 回环模型夹具。
 *
 * 可选验收，默认跳过（CI 不依赖真 Pi / 图形环境）：
 *   PI_GUI_MESSAGE_EDIT_ELECTRON=1 node tests/message-edit-electron.cjs
 *
 * 产物：.shots/message-edit/*.png（真实 capturePage，不是 jsdom 截图）。
 * 数据：os.tmpdir() 下的临时项目 / 会话 / agent 目录；不碰用户真实数据。
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ================================================================== */
/* Electron 子进程                                                     */
/* ================================================================== */
async function runChild() {
  const { app, BrowserWindow, nativeTheme } = require('electron');
  const url = process.env.ME_URL;
  const token = process.env.ME_TOKEN;
  const out = process.env.ME_OUT;
  const project = process.env.ME_PROJECT;
  fs.mkdirSync(out, { recursive: true });
  const result = { checks: 0, errors: [], screenshots: [], sessionId: null, sidebarCount: null };
  let win = null;
  let phase = 'bootstrap';
  const errors = result.errors;
  const check = (name, value) => {
    if (!value) throw Object.assign(new Error('check failed: ' + name), { code: 'CHECK' });
    result.checks++;
    console.log('PASS ' + name);
  };
  const read = code => win.webContents.executeJavaScript(code, true);
  const until = async (code, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { if (await read(code)) return true; } catch { /* page not ready */ }
      await sleep(100);
    }
    throw new Error('timeout: ' + code.slice(0, 160));
  };
  const center = async selector => read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  const hover = async selector => {
    const p = await center(selector);
    if (!p) throw new Error('missing ' + selector);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...p });
    await sleep(250);
  };
  const click = async selector => {
    const p = await center(selector);
    if (!p) throw new Error('missing ' + selector);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...p });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p });
    await sleep(150);
  };
  const shot = async name => {
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
    result.screenshots.push(name + '.png');
  };
  const sendText = async text => {
    await read("document.querySelector('#input').focus()");
    await win.webContents.insertText(text);
    await until("!document.querySelector('#btnSend').disabled", 5000);
    await click('#btnSend');
  };
  /* 走生产 HTTP 接口取证：页面 DOM 与后端权威数据必须一致。 */
  const api = async (pathname, init = {}) => {
    const response = await fetch(url + pathname, {
      ...init,
      headers: { 'x-pi-gui-token': token, 'content-type': 'application/json' },
    });
    return response.json();
  };
  const waitReply = async (marker, timeout = 60000) => until(`(()=>{const a=[...document.querySelectorAll('#stream .msg.assistant .msg-body')];return a.some(e=>e.textContent.includes(${JSON.stringify(marker)}));})()`, timeout);
  const assistantTexts = () => read("[...document.querySelectorAll('#stream .msg.assistant .msg-body')].map(e=>e.textContent)");
  const userTexts = () => read("[...document.querySelectorAll('#stream .msg.user .msg-body')].map(e=>e.textContent)");

  try {
    await app.whenReady();
    nativeTheme.themeSource = 'light';
    win = new BrowserWindow({
      show: true, width: 1200, height: 860, useContentSize: true, autoHideMenuBar: true,
      title: '历史消息编辑验收',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.on('console-message', details => {
      if (details.level === 'error') errors.push(details.message);
    });
    win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, 'x-pi-gui-token': token } });
    });

    phase = 'load';
    await win.loadURL(url + '/');
    await until("document.querySelector('#welcomeReady')&&!document.querySelector('#welcomeReady').hidden", 60000);
    await until("document.querySelector('#btnSend')!==null");

    phase = 'first-turn';
    await sendText('first question');
    await waitReply('reply', 90000);
    await until("document.querySelector('#btnStop').hidden===true", 30000);
    await until("document.querySelectorAll('#stream .msg.user').length===1");

    phase = 'second-turn';
    await sendText('second question');
    await waitReply('second question', 90000);
    await until("document.querySelector('#btnStop').hidden===true", 30000);
    await until("document.querySelectorAll('#stream .msg.user').length===2");
    check('two classic turns rendered from real Pi', (await userTexts()).length === 2);

    result.sessionId = await read("document.querySelector('#projects .pj-sess[data-session-id]')?.dataset.sessionId || null");
    result.sidebarCount = await read("document.querySelectorAll('#projects .pj-sess').length");
    check('sidebar shows one native session', result.sidebarCount === 1);
    check('sidebar row carries the native session id', typeof result.sessionId === 'string' && result.sessionId.length > 0);

    /* 标题取证：真实列表行 + 手动标题。编辑/重发/重新生成都不得清空它。
     * 之前用 PI_CODING_AGENT_SESSION_DIR 时列表看不到文件，只剩 pending 占位行，
     * 测出来的「标题」其实是发送时的临时兜底，不能证明标题持久化。 */
    phase = 'title';
    const listBefore = await api('/api/sessions');
    const currentBefore = (listBefore.sessions || []).find(s => s.current) || null;
    check('session list contains the live native session', Boolean(currentBefore) && currentBefore.pending === false && currentBefore.sessionId === result.sessionId);
    check('fallback title is the first user message', currentBefore.title === 'first question');
    const manualTitle = '手工标题·保留';
    const renamed = await api('/api/session-titles/rename', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'classic', id: currentBefore.id, project,
        title: manualTitle, expectedRevision: currentBefore.titleRevision || 0,
      }),
    });
    check('manual title is accepted through the production API', renamed.ok === true && renamed.title === manualTitle);
    await until(`document.querySelector('#title')?.textContent===${JSON.stringify(manualTitle)} && document.querySelector('#projects .pj-sess-title')?.textContent===${JSON.stringify(manualTitle)}`, 10000);
    check('manual title reaches the header and the sidebar row', true);
    result.manualTitle = manualTitle;
    result.titleBefore = currentBefore.title;
    console.log('TITLE-DEBUG ' + JSON.stringify({
      header: await read("document.querySelector('#title').textContent"),
      row: await read("document.querySelector('#projects .pj-sess-title').textContent"),
      list: (listBefore.sessions || []).map(s => ({ title: s.title, source: s.titleSource, rev: s.titleRevision, pending: s.pending, current: s.current, id: s.id, sessionId: s.sessionId })),
    }));

    phase = 'hover';
    await read("document.documentElement.dataset.theme='light'");
    await read("document.querySelector('#stream').scrollTop=0");
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 });
    await sleep(150);
    const hiddenOpacity = await read("getComputedStyle(document.querySelector('#stream .msg.user .message-actions')).opacity");
    await hover('#stream .msg.user');
    const hoverOpacity = await read("getComputedStyle(document.querySelector('#stream .msg.user .message-actions')).opacity");
    check('edit action is hidden until hover', hiddenOpacity === '0');
    check('hover reveals the edit action', hoverOpacity === '1');
    await shot('edit-hover-light');

    phase = 'focus';
    await read("document.querySelector('#stream .msg.user .message-edit').focus()");
    await sleep(150);
    const focusOpacity = await read("getComputedStyle(document.querySelector('#stream .msg.user .message-actions')).opacity");
    check('keyboard focus reveals the same action bar', focusOpacity === '1');
    check('edit button has an accessible name', await read("document.querySelector('#stream .msg.user .message-edit').getAttribute('aria-label')==='编辑并重新发送'"));
    await shot('edit-focus-light');

    phase = 'editor';
    await click('#stream .msg.user .message-edit');
    await until("document.querySelector('.message-edit-input')!==null", 10000);
    await until("document.querySelector('.message-edit-warning')&&!document.querySelector('.message-edit-warning').hidden", 10000);
    const editorState = await read(`(()=>{const e=document.querySelector('.message-edit[role="group"]');const t=e.querySelector('textarea');const w=e.querySelector('.message-edit-warning');const body=document.querySelector('#stream .msg.user .msg-body');return {value:t.value,focused:document.activeElement===t,warning:!w.hidden,warningText:w.textContent,bodyHidden:body.hidden,rect:e.getBoundingClientRect().toJSON(),viewport:innerWidth};})()`);
    check('inline editor is prefilled at the original message position', editorState.value === 'first question' && editorState.bodyHidden);
    check('inline editor autofocuses its textarea', editorState.focused);
    check('tool/file warning is shown only for replaced tool history', editorState.warning && editorState.warningText.includes('不会自动撤销'));
    check('editor stays inside the chat width', editorState.rect.left >= 0 && editorState.rect.right <= editorState.viewport + 1);
    await shot('editor-light');

    phase = 'editor-dark';
    await read("document.documentElement.dataset.theme='dark'");
    await sleep(200);
    await shot('editor-dark');
    const darkBg = await read("getComputedStyle(document.querySelector('.message-edit[role=\"group\"]')).backgroundColor");
    await read("document.documentElement.dataset.theme='light'");
    await sleep(100);

    phase = 'editor-narrow';
    win.setSize(560, 860);
    await sleep(300);
    const narrow = await read(`(()=>{const e=document.querySelector('.message-edit[role="group"]');const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth};})()`);
    check('narrow window keeps the editor inside the viewport', narrow.left >= 0 && narrow.right <= narrow.viewport + 1);
    check('narrow window has no horizontal page scroll', narrow.scrollWidth <= narrow.viewport + 1);
    await shot('editor-narrow');
    win.setSize(1200, 860);
    await sleep(250);

    phase = 'cancel';
    await click('.message-edit-cancel');
    await until("document.querySelector('.message-edit-input')===null");
    const restored = await read("document.querySelector('#stream .msg.user .msg-body').textContent");
    check('cancel restores the original message', restored.includes('first question'));

    phase = 'resend';
    await hover('#stream .msg.user');
    await click('#stream .msg.user .message-edit');
    await until("document.querySelector('.message-edit-input')!==null");
    await read("(()=>{const t=document.querySelector('.message-edit-input');t.focus();t.select();})()");
    await win.webContents.insertText('edited first question');
    const typed = await read("document.querySelector('.message-edit-input').value");
    check('edited text is accepted by the real textarea', typed === 'edited first question');
    await click('.message-edit-submit');
    await until("document.querySelector('.message-edit-input')===null", 30000);
    await waitReply('edited first question', 90000);
    await until("document.querySelector('#btnStop').hidden===true", 30000);
    await sleep(300);
    const afterUsers = await userTexts();
    const afterAssistants = await assistantTexts();
    check('resend keeps exactly one edited user message', afterUsers.length === 1 && afterUsers[0].includes('edited first question'));
    check('old reply leaves the active conversation', !afterAssistants.some(text => text.includes('reply') && text.includes('first question') && !text.includes('edited first question')));
    check('new reply follows the edited message', afterAssistants.some(text => text.includes('edited first question')));
    check('sidebar still shows one session after resend', await read("document.querySelectorAll('#projects .pj-sess').length") === 1);
    const headerAfterResend = await read("document.querySelector('#title').textContent");
    const rowAfterResend = await read("document.querySelector('#projects .pj-sess-title').textContent");
    const listAfterResend = await api('/api/sessions');
    const currentAfterResend = (listAfterResend.sessions || []).find(s => s.current) || null;
    check('manual title survives edit resend in the UI', headerAfterResend === manualTitle && rowAfterResend === manualTitle);
    check('backend still reports the manual title after resend', Boolean(currentAfterResend) && currentAfterResend.title === manualTitle && currentAfterResend.titleSource === 'manual');
    check('session identity and file identity are unchanged after resend', Boolean(currentAfterResend) && currentAfterResend.id === currentBefore.id && currentAfterResend.sessionId === result.sessionId && currentAfterResend.pending === false);
    result.titleAfterResend = currentAfterResend?.title;
    result.titleSourceAfterResend = currentAfterResend?.titleSource;
    await shot('after-resend-light');

    phase = 'regenerate';
    const beforeRegen = (await assistantTexts()).at(-1) || '';
    await hover('#stream .msg.assistant');
    await click('#stream .msg.assistant .message-regenerate');
    await until(`(()=>{const a=[...document.querySelectorAll('#stream .msg.assistant .msg-body')];return a.length>0&&a[a.length-1].textContent!==${JSON.stringify(beforeRegen)};})()`, 90000);
    await until("document.querySelector('#btnStop').hidden===true", 30000);
    const afterRegenUsers = await userTexts();
    check('regenerate keeps the original user text', afterRegenUsers.length === 1 && afterRegenUsers[0].includes('edited first question'));
    check('regenerate produces a fresh reply', ((await assistantTexts()).at(-1) || '') !== beforeRegen);
    const titleAfterRegen = await read("document.querySelector('#title').textContent");
    const listAfterRegen = await api('/api/sessions');
    const currentAfterRegen = (listAfterRegen.sessions || []).find(s => s.current) || null;
    check('manual title survives regenerate', titleAfterRegen === manualTitle && currentAfterRegen?.title === manualTitle);
    result.titleAfterRegen = currentAfterRegen?.title;
    await shot('regenerate-light');

    phase = 'final';
    check('no renderer console errors', errors.length === 0);
    result.finalUserTexts = await userTexts();
    result.finalAssistantTexts = await assistantTexts();
    result.sidebarCountAfter = await read("document.querySelectorAll('#projects .pj-sess').length");
    result.darkEditorBackground = darkBg;
    result.narrow = narrow;
    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = error.message;
    result.phase = phase;
    try { if (win) fs.writeFileSync(path.join(out, 'failure-' + phase + '.png'), (await win.webContents.capturePage()).toPNG()); } catch { /* best effort */ }
  } finally {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    try { win?.destroy(); } catch { /* already gone */ }
    app.exit(result.ok ? 0 : 1);
  }
}

/* ================================================================== */
/* 父进程：临时项目 + 回环模型 + 生产后端 + Electron                    */
/* ================================================================== */
async function runParent() {
  if (process.env.PI_GUI_MESSAGE_EDIT_ELECTRON !== '1') {
    console.log('SKIP message edit Electron: set PI_GUI_MESSAGE_EDIT_ELECTRON=1 to run');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-message-edit-electron-'));
  const project = path.join(root, 'project');
  const agentDir = path.join(root, 'agent');
  const dataDir = path.join(root, 'data');
  const userData = path.join(root, 'electron');
  const out = path.join(ROOT, '.shots', 'message-edit');
  for (const dir of [project, agentDir, dataDir, userData, out]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), '# message edit fixture\n');
  /* 侧栏只读 projects.json；PI_CWD 只决定当前 cwd。两者都给，侧栏才会出现
   * 与真实用户一致的项目 / 会话行。 */
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({
    active: project,
    items: [{ path: project, name: path.basename(project) }],
  }, null, 2) + '\n');

  const modelRequests = [];
  const modelServer = http.createServer(async (req, res) => {
    let raw = '';
    try { for await (const chunk of req) raw += chunk; } catch { /* aborted */ }
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const textOf = content => typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('') : '';
    const userTexts = messages.filter(message => message.role === 'user').map(message => textOf(message.content));
    modelRequests.push({ userTexts });
    const lastUser = userTexts.at(-1) || '';
    const last = messages.at(-1);
    const n = modelRequests.length;
    const wantsTool = lastUser === 'first question' && last?.role !== 'tool';
    try {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const chunk = (delta, finish = null) => 'data: ' + JSON.stringify({
        id: 'fixture-' + n, object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) + '\n\n';
      res.write(chunk({ role: 'assistant' }));
      if (wantsTool) {
        res.write(chunk({ tool_calls: [{ index: 0, id: 'fixture-call-' + n, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'fixture-note.txt', content: 'fixture\n' }) } }] }));
        res.write(chunk({}, 'tool_calls'));
      } else {
        res.write(chunk({ content: `reply(${n}) to ${lastUser}` }));
        res.write(chunk({}, 'stop'));
      }
      res.end('data: [DONE]\n\n');
    } catch { /* aborted */ }
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const provider = 'message-edit-electron-fixture';
  const modelId = 'fixture';
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      [provider]: {
        baseUrl: 'http://127.0.0.1:' + modelServer.address().port + '/v1',
        api: 'openai-completions', apiKey: 'fixture-unused',
        models: [{
          id: modelId, name: 'Message edit Electron fixture', api: 'openai-completions', reasoning: false,
          input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000, maxTokens: 4096, compat: { supportsDeveloperRole: false, supportsStore: false },
        }],
      },
    },
  }));
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: modelId, retry: { enabled: false, maxRetries: 0 } }));

  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const token = 'message-edit-electron-' + Math.random().toString(36).slice(2);
  const env = {
    ...process.env,
    PORT: String(port), PI_GUI_OPEN: '0', PI_GUI_DATA: dataDir, PI_GUI_LOG_DIR: path.join(dataDir, 'logs'),
    PI_GUI_TOKEN: token, PI_CWD: project, PI_CODING_AGENT_DIR: agentDir,
    PI_PROVIDER: provider, PI_MODEL: modelId,
    PI_THINKING: 'off', PI_OFFLINE: '1', PI_TELEMETRY: '0',
  };
  let backend = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let backendOutput = '';
  backend.stdout.on('data', chunk => { backendOutput += chunk; });
  backend.stderr.on('data', chunk => { backendOutput += chunk; });
  const stopBackend = () => {
    if (!backend || backend.exitCode !== null) return;
    if (process.platform === 'win32') {
      try { spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* gone */ }
    } else {
      try { backend.kill('SIGTERM'); } catch { /* gone */ }
    }
  };
  const api = async pathname => {
    const response = await fetch('http://127.0.0.1:' + port + pathname, { headers: { 'x-pi-gui-token': token } });
    return response.json();
  };

  let child = null;
  const cleanup = async () => {
    if (child && child.exitCode === null) {
      try { child.kill(); } catch { /* gone */ }
    }
    stopBackend();
    await new Promise(resolve => modelServer.close(resolve));
    if (process.env.ME_KEEP !== '1') fs.rmSync(root, { recursive: true, force: true });
  };

  try {
    let ready = null;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try {
        const status = await api('/api/status');
        if (status && status.piRunning === true && status.bridgeState === 'ready' && status.hasProject === true) { ready = status; break; }
      } catch { /* backend not up yet */ }
      await sleep(250);
    }
    if (!ready) throw new Error('backend/Pi not ready: ' + backendOutput.slice(-1200));
    console.log('PASS backend and real Pi are ready');

    const electronPath = require('electron');
    child = spawn(electronPath, ['--no-sandbox', '--disable-gpu', __filename, '--user-data-dir=' + userData], {
      cwd: ROOT,
      env: { ...process.env, ME_CHILD: '1', ME_URL: 'http://127.0.0.1:' + port, ME_TOKEN: token, ME_OUT: out, ME_PROJECT: project },
      stdio: 'inherit', windowsHide: true,
    });
    const exitCode = await new Promise(resolve => {
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve('timeout'); }, 240000);
      child.on('exit', code => { clearTimeout(timer); resolve(code); });
    });
    const resultFile = path.join(out, 'result.json');
    if (!fs.existsSync(resultFile)) throw new Error('Electron child produced no result (exit ' + exitCode + ')');
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    if (exitCode !== 0 || result.ok !== true) throw new Error('Electron child failed at ' + (result.phase || '?') + ': ' + (result.error || exitCode));

    /* Pi 自己把会话写到 <agent>/sessions/<cwd 编码>/；pi-GUI 的会话列表也只
     * 扫描这棵树。测试顺着同一棵树找文件，不用 PI_CODING_AGENT_SESSION_DIR
     * 把文件挪到一个列表看不见的位置。 */
    const files = fs.readdirSync(agentDir, { recursive: true })
      .map(name => String(name))
      .filter(name => name.endsWith('.jsonl'))
      .map(name => path.join(agentDir, name));
    assert.equal(files.length, 1, 'one native session file');
    const sessionFile = files[0];
    const raw = fs.readFileSync(sessionFile, 'utf8');
    const header = JSON.parse(raw.split('\n')[0]);
    assert.equal(header.type, 'session');
    assert.equal(header.id || header.sessionId, result.sessionId);
    assert.ok(raw.includes('first question'), 'old text remains in the append-only file');
    assert.ok(raw.includes('edited first question'), 'edited text is appended to the same file');
    const editRequest = modelRequests.filter(request => request.userTexts.includes('edited first question')).at(-1);
    assert.ok(editRequest, 'model received the edited turn');
    assert.deepEqual(editRequest.userTexts, ['edited first question'], 'model context contains only the edited history');
    assert.equal(result.sidebarCount, 1);
    assert.equal(result.sidebarCountAfter, 1);
    assert.equal(result.errors.length, 0);
    assert.ok(result.darkEditorBackground && result.darkEditorBackground !== 'rgba(0, 0, 0, 0)');
    assert.equal(result.titleBefore, 'first question');
    assert.equal(result.titleAfterResend, result.manualTitle);
    assert.equal(result.titleSourceAfterResend, 'manual');
    assert.equal(result.titleAfterRegen, result.manualTitle);

    console.log('EVIDENCE ' + JSON.stringify({
      sessionId: result.sessionId,
      sessionFileCount: files.length,
      sessionBytes: fs.statSync(sessionFile).size,
      sidebarCount: result.sidebarCount,
      sidebarCountAfter: result.sidebarCountAfter,
      titleBefore: result.titleBefore,
      manualTitle: result.manualTitle,
      titleAfterResend: result.titleAfterResend,
      titleSourceAfterResend: result.titleSourceAfterResend,
      titleAfterRegen: result.titleAfterRegen,
      modelRequests: modelRequests.length,
      editedModelContext: editRequest.userTexts,
      screenshots: result.screenshots,
      checks: result.checks,
    }));
    console.log(`Message edit Electron: ${result.checks + 1}/${result.checks + 1}`);
  } catch (error) {
    console.error('FAIL ' + error.message);
    if (fs.existsSync(path.join(out, 'result.json'))) {
      try { console.error('child result: ' + JSON.stringify(JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8')), null, 2)); } catch { /* ignore */ }
    }
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

if (process.versions.electron && process.env.ME_CHILD === '1') {
  runChild();
} else {
  runParent().catch(error => { console.error(error); process.exitCode = 1; });
}
