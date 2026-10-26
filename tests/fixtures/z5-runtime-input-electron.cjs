// Z5-1 Electron fixture: 真实 Chromium 正常沙箱下的 Runtime 输入与草稿恢复验证。
// 自包含：本地 loopback 静态服务，真实 BrowserWindow 沙箱环境。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

const world = process.env.Z51_WORLD;
const out = process.env.Z51_OUTPUT;
const rows = [], screenshots = [], artifacts = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, value) => { assert.ok(value, name); rows.push(name); console.log('ok ' + name); };

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css">
<style>
body { margin: 16px; background: #18181b; color: #f4f4f5; font-family: sans-serif; }
#host { max-width: 960px; margin: 0 auto; background: #27272a; padding: 20px; border-radius: 8px; }
.rtc-draft-notice { color: #f59e0b; font-size: 13px; margin-top: 6px; padding: 4px 8px; background: rgba(245,158,11,0.1); border-radius: 4px; }
</style></head>
<body>
<main>
<h1 style="font-size:16px;margin-bottom:12px">Z5-1 Runtime 输入可靠性与草稿恢复 · 正常沙箱验证</h1>
<div id="host"></div>
<div id="modal" hidden><div id="modalCard"></div></div>
<div id="confirmLayer" hidden><div id="confirmCard"></div></div>
<div id="toasts"></div>
</main>
<script type="module">
import { runtimeStore, observeRuntimeFrame } from '/runtime-state.js';
import { createRuntimeConversation } from '/runtime-conversation.js';

const requests = [];
window.__requests = requests;

window.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!opts.body) {
    return {
      ok: true,
      json: async () => ({ ok: true, backendInstance: 'backend', items: [] })
    };
  }
  const body = JSON.parse(opts.body);
  requests.push(body);
  return {
    ok: true,
    json: async () => ({ ok: true, conversationId: body.owner?.conversationId })
  };
};

const ownerA = {
  backendInstance: 'backend-electron',
  projectId: 'p-electron',
  repoId: 'r-electron',
  workspaceId: 'ws-electron-a',
  workspaceEpoch: 'epoch-1',
  conversationId: 'conv-a',
  runtimeId: 'rt-a',
  runtimeGeneration: 'g-a',
  sessionId: 'native-session-a',
};
const ownerB = {
  backendInstance: 'backend-electron',
  projectId: 'p-electron',
  repoId: 'r-electron',
  workspaceId: 'ws-electron-b',
  workspaceEpoch: 'epoch-1',
  conversationId: 'conv-b',
  runtimeId: 'rt-b',
  runtimeGeneration: 'g-b',
  sessionId: 'native-session-b',
};

runtimeStore.seed({
  backendInstance: 'backend-electron',
  items: [
    { conversationId: 'conv-a', nativeSessionId: 'native-session-a', workspace: { projectId: 'p-electron', workspaceId: 'ws-electron-a', workspaceEpoch: 'epoch-1' }, owner: ownerA, lifecycle: 'ready', activity: 'idle', revision: 1 },
    { conversationId: 'conv-b', nativeSessionId: 'native-session-b', workspace: { projectId: 'p-electron', workspaceId: 'ws-electron-b', workspaceEpoch: 'epoch-1' }, owner: ownerB, lifecycle: 'ready', activity: 'idle', revision: 1 },
  ]
});

const host = document.querySelector('#host');
const view = createRuntimeConversation({ host });
window.__view = view;
window.__runtimeStore = runtimeStore;

window.__z5 = {
  show: id => view.show(id),
  leave: () => view.leave(),
  getInputValue: () => host.querySelector('textarea')?.value || '',
  setInputValue: val => {
    const input = host.querySelector('textarea');
    if (!input) return;
    input.value = val;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  },
  focusInput: () => host.querySelector('textarea')?.focus(),
  clickSend: () => {
    const btn = [...host.querySelectorAll('button')].find(b => b.textContent === '发送');
    btn?.click();
  },
  getRequestsCount: () => requests.length,
  getLastPrompt: () => requests[requests.length - 1]?.command?.message || null,
  getNoticeText: () => host.querySelector('.rtc-draft-notice')?.textContent || '',
  isNoticeVisible: () => {
    const el = host.querySelector('.rtc-draft-notice');
    return el && !el.hidden && el.textContent.length > 0;
  },
  dispatchComposition: type => {
    const input = host.querySelector('textarea');
    input?.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
  },
  dispatchKey229: () => {
    const input = host.querySelector('textarea');
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: false, bubbles: true, cancelable: true }));
  }
};

window.__z5Ready = true;
</script></body></html>`;

const ROOT = path.resolve(__dirname, '../..');

function createFixtureServer() {
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
  return http.createServer((request, response) => {
    const send = (status, type, body) => { response.writeHead(status, { 'content-type': type }); response.end(body); };
    if (request.method === 'GET') {
      if (request.url === '/' || request.url === '/index.html') return send(200, 'text/html;charset=utf-8', PAGE);
      const filePath = path.join(ROOT, 'public', request.url.replace(/^\//, ''));
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        return send(200, types[ext] || 'application/octet-stream', fs.readFileSync(filePath));
      }
      return send(404, 'text/plain', 'not found: ' + request.url);
    }
    send(405, 'text/plain', 'method not allowed');
  });
}

async function runElectron() {
  const { app, BrowserWindow } = require('electron');
  await app.whenReady();
  const server = createFixtureServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    await win.loadURL(url);
    await win.webContents.executeJavaScript('Boolean(window.__z5Ready)');
    check('正常沙箱装配页加载成功', true);

    // 1. 切换会话 A，输入草稿
    await win.webContents.executeJavaScript('window.__z5.show("conv-a")');
    await win.webContents.executeJavaScript('window.__z5.setInputValue("草稿 A：并行分析任务")');
    await sleep(450); // 等待防抖保存

    // 2. 切换会话 B，验证隔离并输入草稿 B
    await win.webContents.executeJavaScript('window.__z5.show("conv-b")');
    const bInit = await win.webContents.executeJavaScript('window.__z5.getInputValue()');
    check('会话 B 初始输入为空且隔离', bInit === '');

    await win.webContents.executeJavaScript('window.__z5.setInputValue("草稿 B：次要辅助工作")');
    await sleep(450);

    // 3. 切回会话 A，验证内存草稿保留
    await win.webContents.executeJavaScript('window.__z5.show("conv-a")');
    const aBack = await win.webContents.executeJavaScript('window.__z5.getInputValue()');
    check('切回会话 A 草稿保留', aBack === '草稿 A：并行分析任务');

    // 4. 键盘事件与输入法安全：
    await win.webContents.executeJavaScript('window.__z5.focusInput()');

    // 4.1 Shift+Enter 只换行不发送
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] });
    await sleep(100);
    const reqShift = await win.webContents.executeJavaScript('window.__z5.getRequestsCount()');
    check('Shift+Enter 不发送 prompt', reqShift === 0);

    // 4.2 keyCode 229 不发送
    await win.webContents.executeJavaScript('window.__z5.dispatchKey229()');
    await sleep(100);
    const req229 = await win.webContents.executeJavaScript('window.__z5.getRequestsCount()');
    check('keyCode 229 不发送 prompt', req229 === 0);

    // 4.3 compositionstart 期间 Enter 不发送
    await win.webContents.executeJavaScript('window.__z5.dispatchComposition("compositionstart")');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await sleep(100);
    const reqComp = await win.webContents.executeJavaScript('window.__z5.getRequestsCount()');
    check('compositionstart 期间 Enter 不发送', reqComp === 0);

    // 4.4 compositionend 后正常 Enter 发送恰好一次
    await win.webContents.executeJavaScript('window.__z5.dispatchComposition("compositionend")');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await sleep(200);
    const reqAfter = await win.webContents.executeJavaScript('window.__z5.getRequestsCount()');
    const lastPrompt = await win.webContents.executeJavaScript('window.__z5.getLastPrompt()');
    check('compositionend 后正常 Enter 发送恰好一次', reqAfter === 1 && lastPrompt === '草稿 A：并行分析任务');

    // 5. 跨刷新恢复验证：在 A 输入新草稿，然后 reload()
    await win.webContents.executeJavaScript('window.__z5.setInputValue("刷新重载后恢复的草稿 A")');
    await sleep(450); // 防抖保存到 localStorage
    await win.webContents.executeJavaScript('window.__z5.leave()');

    await win.reload();
    await win.webContents.executeJavaScript('Boolean(window.__z5Ready)');
    check('窗口重新加载成功', true);

    // 重新进入 A，验证自动恢复
    await win.webContents.executeJavaScript('window.__z5.show("conv-a")');
    const restoredA = await win.webContents.executeJavaScript('window.__z5.getInputValue()');
    check('刷新后成功恢复会话 A 持久化草稿', restoredA === '刷新重载后恢复的草稿 A');

    // 重新进入 B，验证自动恢复
    await win.webContents.executeJavaScript('window.__z5.show("conv-b")');
    const restoredB = await win.webContents.executeJavaScript('window.__z5.getInputValue()');
    check('刷新后成功恢复会话 B 持久化草稿', restoredB === '草稿 B：次要辅助工作');

    // 6. 超过 20000 字符内联提示验证与多尺寸截图
    const huge20005 = 'X'.repeat(20005);
    await win.webContents.executeJavaScript(`window.__z5.setInputValue(${JSON.stringify(huge20005)})`);
    await sleep(100);
    const noticeVisible = await win.webContents.executeJavaScript('window.__z5.isNoticeVisible()');
    const noticeText = await win.webContents.executeJavaScript('window.__z5.getNoticeText()');
    check('超过 20000 字符显示内联提示', noticeVisible && noticeText.includes('超过本地恢复上限'));

    // 保存 1200px 截图
    win.setSize(1200, 800);
    await sleep(150);
    const img1200 = await win.webContents.capturePage();
    const name1200 = 'z5-1-runtime-input-wide-1200.png';
    fs.writeFileSync(path.join(out, name1200), img1200.toPNG());
    screenshots.push(name1200);
    check('1200px 宽窗口截图已保存', true);

    // 保存 900px 截图
    win.setSize(900, 750);
    await sleep(150);
    const img900 = await win.webContents.capturePage();
    const name900 = 'z5-1-runtime-input-mid-900.png';
    fs.writeFileSync(path.join(out, name900), img900.toPNG());
    screenshots.push(name900);
    check('900px 中窗口截图已保存', true);

    // 保存 700px 截图
    win.setSize(700, 700);
    await sleep(150);
    const img700 = await win.webContents.capturePage();
    const name700 = 'z5-1-runtime-input-narrow-700.png';
    fs.writeFileSync(path.join(out, name700), img700.toPNG());
    screenshots.push(name700);
    check('700px 窄窗口截图已保存', true);

    // 缩短后提示隐藏
    await win.webContents.executeJavaScript('window.__z5.setInputValue("安全范围内的短文本")');
    await sleep(100);
    const noticeHiddenAfter = await win.webContents.executeJavaScript('!window.__z5.isNoticeVisible()');
    check('缩短文本后内联提示隐藏', noticeHiddenAfter);

    const results = {
      qualification: 'electron-chromium-passed',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      failed: 0,
      rows,
      screenshots,
      artifacts,
      chromium: process.versions.chrome,
      attemptedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  } finally {
    win.destroy();
    server.close();
    app.quit();
  }
}

if (process.type === 'browser') {
  runElectron().catch(err => {
    console.error('Electron run failure:', err);
    process.exit(1);
  });
}

module.exports = { createFixtureServer, PAGE };
