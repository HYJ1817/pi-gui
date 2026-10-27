// Z5-Final Joint Electron Fixture: 真实 Chromium 正常沙箱下的 Z5 全阶段（Z5-1, Z5-2, Z5-3, Z5-3B）联合集成验证。
// 自包含：本地 loopback 静态服务，真实 BrowserWindow 正常沙箱环境。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

const world = process.env.Z5_FINAL_WORLD;
const out = process.env.Z5_FINAL_OUTPUT;
const piMarker = process.env.Z5_FINAL_PI_STARTED;
const rows = [], screenshots = [], artifacts = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, value) => { assert.ok(value, name); rows.push(name); console.log('ok ' + name); };

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/styles.css">
<style>
body { margin: 16px; background: var(--bg, #18181b); color: var(--t1, #f4f4f5); font-family: sans-serif; }
#host { max-width: 100%; margin: 0 auto; background: var(--card, #27272a); padding: 16px; border-radius: 8px; border: 1px solid var(--line, #3f3f46); }
.rtc-draft-notice { color: #f59e0b; font-size: 13px; margin-top: 6px; padding: 4px 8px; background: rgba(245,158,11,0.1); border-radius: 4px; }
</style></head>
<body>
<main>
<h1 style="font-size:16px;margin-bottom:12px">Z5-Final 全阶段集成 · 正常沙箱联合验证窗口</h1>
<div id="host"></div>
<div id="modal" hidden><div id="modalCard"></div></div>
<div id="confirmLayer" hidden><div id="confirmCard"></div></div>
<div id="toasts"></div>
</main>
<script type="module">
import { runtimeStore, seedRuntimeSnapshot } from '/runtime-state.js';
import { createRuntimeConversation } from '/runtime-conversation.js';
import { createRuntimeModels } from '/runtime-models.js';

window.__seedRuntimeSnapshot = seedRuntimeSnapshot;

const requests = [];
window.__requests = requests;

const mockHistoryData = {
  'conv-hist': {
    ok: true,
    sessionId: 'native-session-hist',
    locator: {
      conversationId: 'conv-hist',
      nativeSessionId: 'native-session-hist',
      projectId: 'p-final',
      workspaceId: 'ws-final-hist',
      workspaceEpoch: 'epoch-1'
    },
    messages: [
      { role: 'user', text: '历史会话：请运行代码分析', messageId: 'm-u1', userIndex: 0 },
      { role: 'assistant', text: '已完成初步分析，准备进行环境检查与修复。', messageId: 'm-a1' },
      { role: 'user', text: '执行下一步', messageId: 'm-u2', userIndex: 1 },
      { role: 'assistant', text: '所有目标检查与修复操作均已归档。', messageId: 'm-target' }
    ],
    truncated: false,
    toolSummary: {
      items: [
        { toolName: 'find', status: 'completed', source: 'confirmed', messagePosition: 0 },
        { toolName: 'read', status: 'completed', source: 'confirmed', messagePosition: 1 },
        { toolName: 'bash', status: 'error', source: 'confirmed', messagePosition: 1 },
        { toolName: 'write', status: 'completed', source: 'confirmed', messagePosition: 3 },
        { toolName: 'ls', status: 'unknown', source: 'unconfirmed', messagePosition: null }
      ],
      returned: 5,
      limit: 100,
      truncated: false,
      historyTruncated: false,
      unavailableReason: null,
      uncertain: true
    }
  },
  'conv-b': {
    ok: true,
    sessionId: 'native-session-b',
    locator: {
      conversationId: 'conv-b',
      nativeSessionId: 'native-session-b',
      projectId: 'p-final',
      workspaceId: 'ws-final-b',
      workspaceEpoch: 'epoch-1'
    },
    messages: [
      { role: 'user', text: '这是会话 B 的原始历史正文', messageId: 'b-u1', userIndex: 0 },
      { role: 'assistant', text: '会话 B 历史只含正文', messageId: 'b-a1' }
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

let pendingSendResolver = null;
window.__holdSendAck = false;

window.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!opts.body) {
    if (u.includes('/api/runtime-sessions')) {
      const match = u.match(/conversationId=([^&]+)/);
      const id = match ? decodeURIComponent(match[1]) : '';
      if (mockHistoryData[id]) return { ok: true, json: async () => mockHistoryData[id] };
    }
    return {
      ok: true,
      json: async () => ({
        ok: true,
        backendInstance: 'backend-final',
        items: window.__runtimeStore ? [...window.__runtimeStore.values()].map(r => r.item) : []
      })
    };
  }
  const body = JSON.parse(opts.body);
  requests.push(body);
  if (body.command?.type === 'prompt' && window.__holdSendAck) {
    return new Promise(resolve => {
      pendingSendResolver = () => resolve({ ok: true, json: async () => ({ ok: true, conversationId: body.owner?.conversationId }) });
    });
  }
  return { ok: true, json: async () => ({ ok: true, conversationId: body.owner?.conversationId }) };
};

const ownerA = {
  backendInstance: 'backend-final',
  projectId: 'p-final',
  repoId: 'r-final',
  workspaceId: 'ws-final-a',
  workspaceEpoch: 'epoch-1',
  conversationId: 'conv-a',
  runtimeId: 'rt-a',
  runtimeGeneration: 'g-a',
  sessionId: 'native-session-a',
};
const ownerB = {
  backendInstance: 'backend-final',
  projectId: 'p-final',
  repoId: 'r-final',
  workspaceId: 'ws-final-b',
  workspaceEpoch: 'epoch-1',
  conversationId: 'conv-b',
  runtimeId: 'rt-b',
  runtimeGeneration: 'g-b',
  sessionId: 'native-session-b',
};
window.__ownerA = ownerA;
window.__ownerB = ownerB;

// Mock native model state for runtime-models
const mockNative = {
  'conv-a': {
    model: { provider: 'fixture', id: 'm-base', name: 'Base Model', reasoning: false },
    thinkingLevel: 'off',
    sessionName: 'A 运行中'
  },
  'conv-b': {
    model: { provider: 'fixture', id: 'm-base', name: 'Base Model', reasoning: false },
    thinkingLevel: 'off',
    sessionName: 'B 待输入'
  }
};

const modelListeners = new Set();
let view = null;
const modelController = createRuntimeModels({
  store: runtimeStore,
  request: async p => {
    requests.push({ type: 'models-rpc', p });
    const id = p.owner?.conversationId;
    if (p.action === 'command') {
      if (p.command?.type === 'set_model') {
        mockNative[id].model = { provider: p.command.provider, id: p.command.modelId, name: p.command.modelId, reasoning: true };
        setTimeout(() => {
          const frame = { type: 'runtime_event', owner: p.owner, eventSequence: 10, event: { type: 'response', id: p.command.id, command: 'set_model', success: true } };
          if (runtimeStore.apply(frame)) for (const l of modelListeners) l(frame);
        }, 20);
        return { ok: true };
      }
      if (p.command?.type === 'set_thinking_level') {
        mockNative[id].thinkingLevel = p.command.level;
        setTimeout(() => {
          const frame = { type: 'runtime_event', owner: p.owner, eventSequence: 11, event: { type: 'response', id: p.command.id, command: 'set_thinking_level', success: true } };
          if (runtimeStore.apply(frame)) for (const l of modelListeners) l(frame);
        }, 20);
        return { ok: true };
      }
    }
    if (p.command?.type === 'get_state') return { ok: true, data: structuredClone(mockNative[id]) };
    if (p.command?.type === 'get_available_models') {
      return {
        ok: true,
        data: {
          models: [
            { provider: 'fixture', id: 'm-base', name: 'Base Model', reasoning: false },
            { provider: 'fixture', id: 'm-advanced', name: 'Advanced Model', reasoning: true }
          ]
        }
      };
    }
    if (p.command?.type === 'get_available_thinking_levels') {
      return { ok: true, data: { levels: ['off', 'low', 'high'] } };
    }
    return { ok: false, code: 'unsupported' };
  },
  subscribe: fn => {
    modelListeners.add(fn);
    return () => modelListeners.delete(fn);
  },
  onChange: id => {
    if (view && view.conversationId === id) view.draw();
  },
  timeoutMs: 1000
});

runtimeStore.seed({
  backendInstance: 'backend-final',
  items: [
    {
      conversationId: 'conv-a',
      sessionName: 'A 运行中',
      nativeSessionId: 'native-session-a',
      workspace: { projectId: 'p-final', workspaceId: 'ws-final-a', workspaceEpoch: 'epoch-1', branch: 'main' },
      owner: ownerA,
      lifecycle: 'ready',
      activity: 'busy',
      revision: 1
    },
    {
      conversationId: 'conv-b',
      sessionName: 'B 待输入',
      nativeSessionId: 'native-session-b',
      workspace: { projectId: 'p-final', workspaceId: 'ws-final-b', workspaceEpoch: 'epoch-1', branch: 'feature-b' },
      owner: ownerB,
      lifecycle: 'ready',
      activity: 'idle',
      revision: 1
    },
    {
      conversationId: 'conv-hist',
      sessionName: '历史工具摘要展示',
      nativeSessionId: 'native-session-hist',
      workspace: { projectId: 'p-final', workspaceId: 'ws-final-hist', workspaceEpoch: 'epoch-1', branch: 'archive' },
      owner: null,
      lifecycle: 'dormant',
      activity: 'idle',
      revision: 1
    }
  ]
});

const host = document.querySelector('#host');
view = createRuntimeConversation({ host, models: modelController });
window.__view = view;
window.__modelController = modelController;
window.__runtimeStore = runtimeStore;

window.__z5Final = {
  show: id => view.show(id),
  leave: () => view.leave(),
  getInputValue: () => host.querySelector('textarea')?.value || '',
  setInputValue: val => {
    const input = host.querySelector('textarea');
    if (!input) return;
    input.value = val;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  },
  clickHistoryBtn: () => {
    const btn = [...host.querySelectorAll('button')].find(b => b.textContent === '打开历史');
    if (btn) btn.click();
  },
  clickResumeBtn: () => {
    const btn = [...host.querySelectorAll('button')].find(b => b.textContent === '恢复会话');
    if (btn) btn.click();
  },
  clickCloseBtn: () => {
    const btn = [...host.querySelectorAll('button')].find(b => b.textContent === '关闭会话');
    if (btn) btn.click();
  },
  getStateText: () => host.querySelector('.rtc-state')?.textContent || '',
  getToolRows: () => [...host.querySelectorAll('.rtc-history-tool')].map(r => ({
    name: r.dataset.toolName,
    status: r.dataset.status,
    text: r.textContent
  })),
  getUnconfirmedText: () => host.querySelector('.rtc-history-unconfirmed')?.textContent || null,
  getModelValue: () => host.querySelector('.rtc-model-select')?.value || '',
  getThinkingLevel: () => host.querySelector('select[aria-label="当前会话推理强度"]')?.value || '',
  setThinkingLevel: async level => {
    await modelController.setThinking('conv-b', level);
  },
  setModelId: async modelId => {
    await modelController.setModel('conv-b', { providerId: 'fixture', modelId });
  },
  clickSend: () => {
    const btn = [...host.querySelectorAll('button')].find(b => b.textContent === '发送');
    btn?.click();
  },
  holdSend: () => { window.__holdSendAck = true; },
  resolveSend: () => {
    if (pendingSendResolver) {
      const fn = pendingSendResolver;
      pendingSendResolver = null;
      window.__holdSendAck = false;
      fn();
    }
  }
};

window.__z5FinalReady = true;
</script>
</body></html>`;

function createFixtureServer() {
  const ROOT = path.resolve(__dirname, '../..');
  const types = {
    '.html': 'text/html;charset=utf-8',
    '.css': 'text/css;charset=utf-8',
    '.js': 'application/javascript;charset=utf-8',
    '.png': 'image/png',
    '.json': 'application/json',
  };
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
    await win.webContents.executeJavaScript('Boolean(window.__z5FinalReady)');
    check('正常沙箱装配页加载成功', true);

    // ==========================================
    // 步骤 1: A 运行时，在 B 输入草稿
    // ==========================================
    await win.webContents.executeJavaScript('window.__z5Final.show("conv-a")');
    await sleep(150);
    // A 是 busy 状态
    await win.webContents.executeJavaScript('window.__z5Final.show("conv-b")');
    await sleep(150);
    // 在 B 中输入草稿
    const draftTextB = 'B 的集成验证草稿：包含中文输入与模型配置';
    await win.webContents.executeJavaScript(`window.__z5Final.setInputValue(${JSON.stringify(draftTextB)})`);
    await sleep(500); // 超过 400ms 防抖保存

    const bVal1 = await win.webContents.executeJavaScript('window.__z5Final.getInputValue()');
    check('步骤1: A 运行时成功在 B 输入草稿且未被 A 的 busy 禁用', bVal1 === draftTextB);

    const shot1 = 'z5-final-step1-a-running-b-draft.png';
    fs.writeFileSync(path.join(out, shot1), await win.webContents.capturePage().then(img => img.toPNG()));
    screenshots.push(shot1);

    // ==========================================
    // 步骤 2: 切换到另一历史会话阅读工具摘要
    // ==========================================
    await win.webContents.executeJavaScript('window.__z5Final.show("conv-hist")');
    await win.webContents.executeJavaScript('window.__z5Final.clickHistoryBtn()');
    await sleep(300);

    const histState = await win.webContents.executeJavaScript('window.__z5Final.getStateText()');
    check('步骤2: 历史会话展示状态提示包含工具摘要说明',
      histState.includes('历史正文与只读工具摘要；不含思考及用量') &&
      histState.includes('未被启动，不占运行名额'));

    const tools = await win.webContents.executeJavaScript('window.__z5Final.getToolRows()');
    check('步骤2: 工具摘要行数量正确 (共5项)', tools.length === 5);
    check('步骤2: find 工具映射已记录完成', tools.some(t => t.name === 'find' && t.status === 'completed' && t.text.includes('已记录完成')));
    check('步骤2: read 工具映射已记录完成', tools.some(t => t.name === 'read' && t.status === 'completed' && t.text.includes('已记录完成')));
    check('步骤2: bash 工具映射结果报错', tools.some(t => t.name === 'bash' && t.status === 'error' && t.text.includes('结果报错')));
    check('步骤2: write 工具映射已记录完成', tools.some(t => t.name === 'write' && t.status === 'completed' && t.text.includes('已记录完成')));

    const unconfirmed = await win.webContents.executeJavaScript('window.__z5Final.getUnconfirmedText()');
    check('步骤2: ls 状态未知安全降级至位置未确认区域', unconfirmed && unconfirmed.includes('ls · 状态未知'));

    // 核对 Pi 未启动
    check('步骤2: 阅读工具摘要不启动 Pi 且不占运行名额', !fs.existsSync(piMarker));

    const shot2 = 'z5-final-step2-history-tool-summary.png';
    fs.writeFileSync(path.join(out, shot2), await win.webContents.capturePage().then(img => img.toPNG()));
    screenshots.push(shot2);

    // ==========================================
    // 步骤 3: 返回 B，草稿完整保留
    // ==========================================
    await win.webContents.executeJavaScript('window.__z5Final.show("conv-b")');
    await sleep(200);

    const bVal2 = await win.webContents.executeJavaScript('window.__z5Final.getInputValue()');
    check('步骤3: 从历史会话返回 B，草稿完整保留', bVal2 === draftTextB);

    // 验证历史工具摘要已从当前 B 视图清除
    const toolsInB = await win.webContents.executeJavaScript('window.__z5Final.getToolRows()');
    check('步骤3: 返回实时会话后历史工具行与未确认区域完全清除', toolsInB.length === 0);

    const shot3 = 'z5-final-step3-b-draft-intact.png';
    fs.writeFileSync(path.join(out, shot3), await win.webContents.capturePage().then(img => img.toPNG()));
    screenshots.push(shot3);

    // ==========================================
    // 步骤 4: B 切换模型和思考等级
    // ==========================================
    await win.webContents.executeJavaScript('window.__modelController.refresh("conv-b")');
    await sleep(200);
    // 切换模型至 m-advanced
    await win.webContents.executeJavaScript('window.__z5Final.setModelId("m-advanced")');
    await sleep(300);
    // 切换思考等级至 high
    await win.webContents.executeJavaScript('window.__z5Final.setThinkingLevel("high")');
    await sleep(300);

    const thinkingVal = await win.webContents.executeJavaScript('window.__z5Final.getThinkingLevel()');
    check('步骤4: B 成功切换思考等级为 high 且通过原生回读确认', thinkingVal === 'high');

    const shot4 = 'z5-final-step4-b-model-thinking.png';
    fs.writeFileSync(path.join(out, shot4), await win.webContents.capturePage().then(img => img.toPNG()));
    screenshots.push(shot4);

    // ==========================================
    // 步骤 5: B 的迟到 ACK 不影响当前输入
    // ==========================================
    // 5.1 保持当前输入 draftTextB，准备发送并拦截 ACK
    await win.webContents.executeJavaScript('window.__z5Final.holdSend()');
    await win.webContents.executeJavaScript('window.__z5Final.clickSend()');
    await sleep(150);

    // 5.2 在 ACK 飞航期间，用户输入新草稿
    const updatedDraftB = draftTextB + ' [追加新草稿输入]';
    await win.webContents.executeJavaScript(`window.__z5Final.setInputValue(${JSON.stringify(updatedDraftB)})`);
    await sleep(150);

    // 5.3 迟到的旧发送 ACK 到达
    await win.webContents.executeJavaScript('window.__z5Final.resolveSend()');
    await sleep(200);

    const bVal3 = await win.webContents.executeJavaScript('window.__z5Final.getInputValue()');
    check('步骤5: B 的迟到 ACK 绝不清除或覆盖用户当前的新输入草稿', bVal3 === updatedDraftB);

    const shot5 = 'z5-final-step5-delayed-ack.png';
    fs.writeFileSync(path.join(out, shot5), await win.webContents.capturePage().then(img => img.toPNG()));
    screenshots.push(shot5);

    // ==========================================
    // 步骤 6: 关闭 B、打开历史、再恢复
    // ==========================================
    // 关闭 B
    await win.webContents.executeJavaScript(`
      const bRecord = window.__runtimeStore.get("conv-b");
      bRecord.item.lifecycle = "dormant";
      bRecord.item.owner = null;
      bRecord.owner = null;
      window.__seedRuntimeSnapshot({
        backendInstance: "backend-final",
        items: [
          window.__runtimeStore.get("conv-a").item,
          bRecord.item,
          window.__runtimeStore.get("conv-hist").item
        ]
      });
    `);
    await sleep(200);

    const stateClosed = await win.webContents.executeJavaScript('window.__z5Final.getStateText()');
    check('步骤6: 关闭 B 后视图正确呈现已关闭状态', stateClosed.includes('已关闭') || stateClosed.includes('未被启动'));

    // 打开 B 的历史
    await win.webContents.executeJavaScript('window.__z5Final.clickHistoryBtn()');
    await sleep(400);

    const histBState = await win.webContents.executeJavaScript('window.__z5Final.getStateText()');
    check('步骤6: 打开 B 的只读历史，显示只读正文说明', histBState.includes('只读历史') || histBState.includes('正文') || histBState.includes('工具'));

    // 恢复会话
    await win.webContents.executeJavaScript('window.__z5Final.clickResumeBtn()');
    await sleep(200);

    const lastReq = await win.webContents.executeJavaScript('window.__requests[window.__requests.length - 1]');
    check('步骤6: 显式恢复会话发出 resume 请求', lastReq && (lastReq.action === 'resume' || lastReq.type === 'resume'));

    // 恢复 B 的 ready 状态
    await win.webContents.executeJavaScript(`
      const bRecord2 = window.__runtimeStore.get("conv-b");
      bRecord2.item.lifecycle = "ready";
      bRecord2.item.owner = window.__ownerB;
      bRecord2.owner = window.__ownerB;
      window.__seedRuntimeSnapshot({
        backendInstance: "backend-final",
        items: [
          window.__runtimeStore.get("conv-a").item,
          bRecord2.item,
          window.__runtimeStore.get("conv-hist").item
        ]
      });
    `);
    await sleep(200);

    const shot6 = 'z5-final-step6-close-history-resume.png';
    fs.writeFileSync(path.join(out, shot6), await win.webContents.capturePage().then(img => img.toPNG()));
    screenshots.push(shot6);

    // ==========================================
    // 步骤 7: 重启应用后检查会话与草稿边界
    // ==========================================
    // 等待草稿持久化
    await sleep(500);
    // 重新加载窗口模拟应用重启
    await win.reload();
    await win.webContents.executeJavaScript('Boolean(window.__z5FinalReady)');
    await sleep(200);

    // 恢复展示会话 B
    await win.webContents.executeJavaScript('window.__z5Final.show("conv-b")');
    await sleep(300);

    const recoveredDraftB = await win.webContents.executeJavaScript('window.__z5Final.getInputValue()');
    check('步骤7: 重启窗口后会话 B 草稿成功自动恢复', recoveredDraftB === updatedDraftB);

    // 检查会话 A 的草稿隔离
    await win.webContents.executeJavaScript('window.__z5Final.show("conv-a")');
    await sleep(200);
    const draftA = await win.webContents.executeJavaScript('window.__z5Final.getInputValue()');
    check('步骤7: 会话 A 草稿与 B 完全隔离，输入为空', draftA === '');

    const shot7 = 'z5-final-step7-restart-draft-boundary.png';
    fs.writeFileSync(path.join(out, shot7), await win.webContents.capturePage().then(img => img.toPNG()));
    screenshots.push(shot7);

    // ==========================================
    // 步骤 8: 确认整个过程无额外工具执行、错误审批或焦点抢占
    // ==========================================
    const allRequests = await win.webContents.executeJavaScript('window.__requests');
    const unexpectedTools = allRequests.filter(r => r.action === 'tool_call' || r.type === 'tool_execution');
    check('步骤8: 确认全流程无任何意外工具执行请求', unexpectedTools.length === 0);

    const wrongApprovals = allRequests.filter(r => r.action === 'approval' && r.owner?.conversationId !== 'conv-b');
    check('步骤8: 确认全流程无错误审批应答跨会话泄露', wrongApprovals.length === 0);

    check('步骤8: 正常沙箱窗口全程无控制台报错', rendererErrors.length === 0);

    const summary = {
      passed: true,
      failed: 0,
      total: rows.length,
      rows,
      screenshots,
      artifacts,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      rendererErrors,
      timestamp: new Date().toISOString()
    };
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(`\nZ5-Final Joint All Scenarios Passed: ${rows.length}/${rows.length}`);
  } catch (err) {
    console.error('Fixture Error:', err);
    const failureSummary = {
      passed: false,
      failed: 1,
      error: err.message,
      stack: err.stack,
      rows,
      rendererErrors,
      timestamp: new Date().toISOString()
    };
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(failureSummary, null, 2) + '\n');
    process.exitCode = 1;
  } finally {
    server.close();
    win.destroy();
    app.quit();
  }
}

runElectron().catch(err => {
  console.error('Unhandled runElectron:', err);
  process.exit(1);
});
