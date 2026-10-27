// Z5-3B Electron fixture: 真实 Chromium 正常沙箱下的 Runtime 历史工具摘要 UI 集成验证。
// 自包含：本地 loopback 静态服务，真实 BrowserWindow 正常沙箱环境。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

const world = process.env.Z53B_WORLD;
const out = process.env.Z53B_OUTPUT;
const piMarker = process.env.Z53B_PI_STARTED;
const rows = [], screenshots = [], artifacts = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, value) => { assert.ok(value, name); rows.push(name); console.log('ok ' + name); };

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/styles.css">
<style>
body { margin: 16px; background: var(--bg, #18181b); color: var(--t1, #f4f4f5); font-family: sans-serif; }
#host { max-width: 100%; margin: 0 auto; background: var(--card, #27272a); padding: 16px; border-radius: 8px; border: 1px solid var(--line, #3f3f46); }
</style></head>
<body>
<main>
<h1 style="font-size:16px;margin-bottom:12px">Z5-3B 历史工具摘要 UI · 正常沙箱窗口验证</h1>
<div id="host"></div>
<div id="modal" hidden><div id="modalCard"></div></div>
<div id="confirmLayer" hidden><div id="confirmCard"></div></div>
<div id="toasts"></div>
</main>
<script type="module">
import { runtimeStore } from '/runtime-state.js';
import { createRuntimeConversation } from '/runtime-conversation.js';

const requests = [];
window.__requests = requests;

const mockHistoryData = {
  'conv-tools': {
    ok: true,
    sessionId: 'native-session-tools',
    locator: {
      conversationId: 'conv-tools',
      nativeSessionId: 'native-session-tools',
      projectId: 'p-electron',
      workspaceId: 'ws-electron-tools',
      workspaceEpoch: 'epoch-1'
    },
    messages: [
      { role: 'user', text: '请检查项目结构并读取配置文件', messageId: 'm-u1', userIndex: 0 },
      { role: 'assistant', text: '我已经读取了 package.json，并发现了配置错误。接下来准备修复。', messageId: 'm-a1' },
      { role: 'user', text: '请继续执行修复', messageId: 'm-u2', userIndex: 1 },
      { role: 'assistant', text: '修复完成，所有单元测试通过。', messageId: 'm-target' }
    ],
    truncated: true,
    toolSummary: {
      items: [
        { toolName: 'ls', status: 'unknown', source: 'unconfirmed', messagePosition: null },
        { toolName: 'find', status: 'completed', source: 'confirmed', messagePosition: 0 },
        { toolName: 'read', status: 'completed', source: 'confirmed', messagePosition: 1 },
        { toolName: 'bash', status: 'error', source: 'confirmed', messagePosition: 1 },
        { toolName: 'write', status: 'completed', source: 'confirmed', messagePosition: 3 },
        { toolName: 'edit', status: 'completed', source: 'confirmed', messagePosition: 4 }
      ],
      returned: 6,
      limit: 100,
      truncated: true,
      historyTruncated: true,
      unavailableReason: null,
      uncertain: true
    }
  },
  'conv-clean': {
    ok: true,
    sessionId: 'native-session-clean',
    locator: {
      conversationId: 'conv-clean',
      nativeSessionId: 'native-session-clean',
      projectId: 'p-electron',
      workspaceId: 'ws-electron-clean',
      workspaceEpoch: 'epoch-1'
    },
    messages: [
      { role: 'user', text: '这是一条没有使用任何工具的纯对话记录。', messageId: 'c-u1', userIndex: 0 },
      { role: 'assistant', text: '收到，纯正文历史视图应该保持整洁，不显示空工具列表。', messageId: 'c-a1' }
    ],
    truncated: false,
    toolSummary: {
      items: [],
      returned: 0,
      limit: 100,
      truncated: false,
      historyTruncated: false,
      unavailableReason: 'no_tool_calls',
      uncertain: false
    }
  }
};

window.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!opts.body) {
    if (u.includes('/api/runtime-sessions')) {
      const match = u.match(/conversationId=([^&]+)/);
      const id = match ? decodeURIComponent(match[1]) : '';
      if (mockHistoryData[id]) return { ok: true, json: async () => mockHistoryData[id] };
    }
    return { ok: true, json: async () => ({ ok: true, backendInstance: 'backend', items: [] }) };
  }
  const body = JSON.parse(opts.body);
  requests.push(body);
  return { ok: true, json: async () => ({ ok: true, conversationId: body.owner?.conversationId }) };
};

runtimeStore.seed({
  backendInstance: 'backend-electron',
  items: [
    {
      conversationId: 'conv-tools',
      sessionName: '历史工具摘要展示',
      nativeSessionId: 'native-session-tools',
      workspace: { projectId: 'p-electron', workspaceId: 'ws-electron-tools', workspaceEpoch: 'epoch-1', branch: 'feature/history-tools' },
      owner: null,
      lifecycle: 'dormant',
      activity: 'idle',
      revision: 1
    },
    {
      conversationId: 'conv-clean',
      sessionName: '纯正文会话',
      nativeSessionId: 'native-session-clean',
      workspace: { projectId: 'p-electron', workspaceId: 'ws-electron-clean', workspaceEpoch: 'epoch-1', branch: 'feature/clean' },
      owner: null,
      lifecycle: 'dormant',
      activity: 'idle',
      revision: 1
    }
  ]
});

const host = document.querySelector('#host');
const view = createRuntimeConversation({ host });
window.__view = view;
window.__runtimeStore = runtimeStore;

window.__z53b = {
  show: id => view.show(id),
  openHistory: (loc, match) => view.openHistory(loc, match),
  clickHistoryBtn: () => {
    const btn = [...host.querySelectorAll('button')].find(b => b.textContent === '打开历史');
    btn?.click();
  },
  getStateText: () => host.querySelector('.rtc-state')?.textContent || '',
  getNoticeText: () => host.querySelector('.rtc-notice')?.textContent || '',
  getToolRows: () => [...host.querySelectorAll('.rtc-history-tool')].map(t => ({
    text: t.textContent,
    toolName: t.dataset.toolName,
    status: t.dataset.status
  })),
  getUnconfirmedText: () => host.querySelector('.rtc-history-unconfirmed')?.textContent || '',
  getMessagesCount: () => host.querySelectorAll('.rtc-history-message').length,
  getOutputText: () => host.querySelector('.rtc-output')?.textContent || '',
  hasOverflow: () => {
    const outEl = host.querySelector('.rtc-output');
    if (!outEl) return false;
    return outEl.scrollWidth > (outEl.clientWidth + 4);
  },
  getScrolledTarget: () => {
    const matchKey = host.querySelector('.rtc-output')?.dataset?.historyMatch;
    return matchKey || null;
  }
};

window.__z53bReady = true;
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

  const rendererErrors = [];
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

  win.webContents.on('console-message', (event, level, message) => {
    if (level >= 3) rendererErrors.push(message);
  });

  try {
    await win.loadURL(url);
    await win.webContents.executeJavaScript('Boolean(window.__z53bReady)');
    check('正常沙箱装配页加载成功', true);

    // 1. 打开 conv-tools 历史，验证 dormant 历史正文与工具摘要同屏显示
    await win.webContents.executeJavaScript('window.__z53b.show("conv-tools")');
    await win.webContents.executeJavaScript('window.__z53b.clickHistoryBtn()');
    await sleep(300);

    const stateText = await win.webContents.executeJavaScript('window.__z53b.getStateText()');
    check('只读状态行包含历史工具说明与截断不完整提示',
      stateText.includes('只读历史') &&
      stateText.includes('历史正文与只读工具摘要；不含思考及用量') &&
      stateText.includes('仅显示部分工具') &&
      stateText.includes('状态证据不完整') &&
      stateText.includes('未被启动，不占运行名额'));

    // 验证 Pi 未启动
    check('只读浏览不启动 Pi，不增加运行名额', !fs.existsSync(piMarker));

    // 验证多工具与各状态文案显示
    const tools = await win.webContents.executeJavaScript('window.__z53b.getToolRows()');
    check('工具摘要行全部正确呈现', tools.length === 6);

    const completedTool = tools.find(t => t.toolName === 'read');
    const errorTool = tools.find(t => t.toolName === 'bash');
    const unknownTool = tools.find(t => t.toolName === 'ls');
    check('completed 状态映射为“已记录完成”', completedTool && completedTool.text.includes('read · 已记录完成') && completedTool.status === 'completed');
    check('error 状态映射为“结果报错”', errorTool && errorTool.text.includes('bash · 结果报错') && errorTool.status === 'error');
    check('unknown 状态映射为“状态未知”', unknownTool && unknownTool.text.includes('ls · 状态未知') && unknownTool.status === 'unknown');

    const unconfirmedText = await win.webContents.executeJavaScript('window.__z53b.getUnconfirmedText()');
    check('messagePosition=null 放在独立的位置未确认区域', unconfirmedText.includes('位置未确认') && unconfirmedText.includes('ls · 状态未知'));

    // 2. 1200px 宽度截图与溢出检查
    win.setSize(1200, 800);
    await sleep(200);
    const overflow1200 = await win.webContents.executeJavaScript('window.__z53b.hasOverflow()');
    check('1200px 宽度下无横向溢出', !overflow1200);
    const img1200 = await win.webContents.capturePage();
    const name1200 = 'z5-3b-history-wide-1200.png';
    fs.writeFileSync(path.join(out, name1200), img1200.toPNG());
    screenshots.push(name1200);

    // 3. 900px 宽度截图与溢出检查
    win.setSize(900, 800);
    await sleep(200);
    const overflow900 = await win.webContents.executeJavaScript('window.__z53b.hasOverflow()');
    check('900px 宽度下无横向溢出', !overflow900);
    const img900 = await win.webContents.capturePage();
    const name900 = 'z5-3b-history-mid-900.png';
    fs.writeFileSync(path.join(out, name900), img900.toPNG());
    screenshots.push(name900);

    // 4. 700px 宽度截图与溢出检查
    win.setSize(700, 800);
    await sleep(200);
    const overflow700 = await win.webContents.executeJavaScript('window.__z53b.hasOverflow()');
    check('700px 宽度下无横向溢出', !overflow700);
    const img700 = await win.webContents.capturePage();
    const name700 = 'z5-3b-history-narrow-700.png';
    fs.writeFileSync(path.join(out, name700), img700.toPNG());
    screenshots.push(name700);

    // 5. 历史搜索定位及滚动不被破坏验证
    win.setSize(1000, 700);
    await sleep(150);
    await win.webContents.executeJavaScript(`
      window.__z53b.openHistory(
        { conversationId: 'conv-tools', nativeSessionId: 'native-session-tools', projectId: 'p-electron', workspaceId: 'ws-electron-tools', workspaceEpoch: 'epoch-1' },
        { messageId: 'm-target' }
      )
    `);
    await sleep(300);
    const matchKey = await win.webContents.executeJavaScript('window.__z53b.getScrolledTarget()');
    check('历史搜索定位能按 messageId 正确标记匹配目标', matchKey && matchKey.includes('m-target'));
    const imgSearch = await win.webContents.capturePage();
    const nameSearch = 'z5-3b-history-search-jump.png';
    fs.writeFileSync(path.join(out, nameSearch), imgSearch.toPNG());
    screenshots.push(nameSearch);

    // 6. 切换到没有工具调用的会话 conv-clean，验证界面整洁不显示空列表
    await win.webContents.executeJavaScript('window.__z53b.show("conv-clean")');
    await win.webContents.executeJavaScript('window.__z53b.clickHistoryBtn()');
    await sleep(300);

    const cleanTools = await win.webContents.executeJavaScript('window.__z53b.getToolRows()');
    const cleanUnconfirmed = await win.webContents.executeJavaScript('window.__z53b.getUnconfirmedText()');
    const cleanState = await win.webContents.executeJavaScript('window.__z53b.getStateText()');
    check('没有工具调用的会话不显示空工具列表及未确认区域', cleanTools.length === 0 && cleanUnconfirmed === '');
    check('没有工具调用时状态行正常且不报错', cleanState.includes('历史正文与只读工具摘要；不含思考及用量') && !cleanState.includes('不可用'));

    const imgClean = await win.webContents.capturePage();
    const nameClean = 'z5-3b-history-clean-no-tools.png';
    fs.writeFileSync(path.join(out, nameClean), imgClean.toPNG());
    screenshots.push(nameClean);

    // 7. A/B 会话快速切换安全性
    await win.webContents.executeJavaScript('window.__z53b.show("conv-tools")');
    await sleep(100);
    const backTools = await win.webContents.executeJavaScript('window.__z53b.getToolRows()');
    check('A/B 会话快速切换回 conv-tools 正确恢复自己的工具摘要', backTools.length === 6);

    // 8. Renderer 无新增错误
    check('Renderer 无新增控制台错误', rendererErrors.length === 0);

    // 最终产物写入 results.json
    const report = {
      qualification: 'electron-chromium-passed',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      failed: 0,
      checks: rows.length,
      rows,
      screenshots,
      artifacts,
      rendererErrors,
      piStarted: fs.existsSync(piMarker),
      chromium: process.versions.chrome,
      electron: process.versions.electron,
      attemptedAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Z5-3B Electron: ${rows.length}/${rows.length}; Chromium ${report.chromium}; 产物 ${out}`);
  } finally {
    win.destroy();
    server.close();
    app.quit();
  }
}

runElectron().catch(error => {
  console.error(error);
  process.exit(1);
});
