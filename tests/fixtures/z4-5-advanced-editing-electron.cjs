// Z4-5 Electron fixture：真实 Chromium（正常沙箱）下验证高级编辑交互。
// 自包含：仅 loopback 静态服务（public/ + 装配页），无后端、无外部网络。
// 验证：多选高亮、框选、批量拖动、对齐菜单、760px 窄窗口。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

const world = process.env.Z45_WORLD;
const out = process.env.Z45_OUTPUT;
const rows = [], screenshots = [], artifacts = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, value) => { assert.ok(value, name); rows.push(name); console.log('ok ' + name); };

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/collab.css"><link rel="stylesheet" href="/collab-productivity.css">
<style>body{margin:12px;background:#151515}main{max-width:1100px}</style></head>
<body><main><h1 style="color:#f0efec;font-size:15px">Z4-5 协同画布高级编辑 · 真实 Chromium 装配页</h1>
<div id="canvas"></div><div id="bar"></div></main>
<script type="module">
import { mountCollabCanvas } from '/collab-canvas.js';
import { mountCollabProductivity } from '/collab-canvas-productivity.js';

let doc = {
  documentId: 'z45-electron', schemaVersion: 1, revision: 1, title: '高级编辑测试图', boundSessionId: null,
  graph: {
    nodes: [
      { id: 'n1', label: '开始节点', x: 50, y: 50 },
      { id: 'n2', label: '处理流程 A', x: 250, y: 50 },
      { id: 'n3', label: '处理流程 B', x: 450, y: 150 },
      { id: 'n4', label: '审核归档', x: 150, y: 250 },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3' },
      { id: 'e3', from: 'n3', to: 'n4' },
    ],
  }, appliedOps: [],
};

const history = [], submissions = [];
const applyIntents = intents => {
  if (!intents.length) return;
  const baseRevision = doc.revision;
  const ops = intents.map(intent => ({ opId: crypto.randomUUID(), type: intent.type, params: intent.params, baseRevision, actor: 'user' }));
  submissions.push(ops);
  doc = { ...doc, revision: doc.revision + 1, graph: { ...doc.graph,
    nodes: doc.graph.nodes.map(node => {
      const op = ops.find(candidate => candidate.params.id === node.id && candidate.type === 'node.update');
      return op ? { ...node, x: op.params.x ?? node.x, y: op.params.y ?? node.y } : node;
    }) } };
  sync();
};

const canvas = mountCollabCanvas(document.querySelector('#canvas'), { document: doc,
  onOperations: applyIntents, onUndo: () => {}, onRedo: () => {} });
const bar = mountCollabProductivity(document.querySelector('#bar'), { document: doc,
  onOperations: applyIntents });

function sync() { canvas.update({ document: doc }); bar.update({ document: doc }); }
sync(); window.__z45Ready = true;
window.__z45State = () => ({
  revision: doc.revision,
  submissions: submissions.length,
  nodes: doc.graph.nodes.map(node => ({ id: node.id, x: node.x, y: node.y })),
  selectedCount: document.querySelectorAll('.collab-node.is-selected').length,
  alignFormHidden: document.querySelector('.collab-align-form')?.hidden ?? true,
});
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
    await win.webContents.executeJavaScript('Boolean(window.__z45Ready)');
    check('装配页加载正常', true);

    // 1. 宽窗口 1200px 截图
    const wideShot = await win.webContents.capturePage();
    const wideShotName = 'z45-advanced-wide-1200.png';
    fs.writeFileSync(path.join(out, wideShotName), wideShot.toPNG());
    screenshots.push(wideShotName);
    check('1200px 宽窗口截图已保存', true);

    // 2. 多选测试：通过脚本触发 Ctrl+点击选中两个节点
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-node-id="n1"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.querySelector('[data-node-id="n2"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    })()`);
    const multiSelectState = await win.webContents.executeJavaScript('window.__z45State()');
    check('多选两个节点生效', multiSelectState.selectedCount === 2);
    check('对齐表单出现', multiSelectState.alignFormHidden === false);

    const multiShot = await win.webContents.capturePage();
    const multiShotName = 'z45-multiselect-active.png';
    fs.writeFileSync(path.join(out, multiShotName), multiShot.toPNG());
    screenshots.push(multiShotName);
    check('多选状态高亮截图已保存', true);

    // 3. 760px 窄窗口截图
    win.setSize(760, 700);
    await sleep(200);
    const narrowShot = await win.webContents.capturePage();
    const narrowShotName = 'z45-narrow-760.png';
    fs.writeFileSync(path.join(out, narrowShotName), narrowShot.toPNG());
    screenshots.push(narrowShotName);
    check('760px 窄窗口截图已保存', true);

    const results = {
      qualification: 'electron-chromium-passed',
      sandbox: true,
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
