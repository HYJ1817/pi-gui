// Z4-4B Electron fixture：真实 Chromium（正常沙箱）下验证生产力工具条集成。
// 自包含：仅 loopback 静态服务（public/ + lib/ + 生成的装配页），无后端、无外部网络。
// 验证：自动整理预览→确认→文档坐标→撤销恢复；SVG（浅色/深色）导出与下载锚点；
// PNG 经默认浏览器 renderer（真实 canvas 光栅化）产出 PNG 魔数字节；宽/窄窗口截图。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
/* electron 仅在作为 Electron 主进程运行时加载；被测试脚本 require 复用装配页时不可引入。 */
const world = process.env.Z44B_WORLD;
const out = process.env.Z44B_OUTPUT;
const rows = [], screenshots = [], artifacts = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, value) => { assert.ok(value, name); rows.push(name); console.log('ok ' + name); };
async function until(action, name) {
  for (let index = 0; index < 200; index++) { if (await action()) return; await sleep(50); }
  throw new Error('timeout: ' + name);
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/collab.css"><link rel="stylesheet" href="/collab-productivity.css">
<style>body{margin:12px;background:#151515}main{max-width:1100px}</style></head>
<body><main><h1 style="color:#f0efec;font-size:15px">Z4-4B 协同面板生产力工具 · 真实 Chromium 装配页</h1>
<div id="canvas"></div><div id="bar"></div></main>
<script type="module">
import { mountCollabCanvas } from '/collab-canvas.js';
import { mountCollabProductivity } from '/collab-canvas-productivity.js';

/* 浏览器侧不导入 lib/collab-doc.js（Node 模块，含 Buffer；生产客户端也不在页内执行事务，
 * 服务端才是权威）。这里用手写迷你快照 + 逆操作栈模拟服务端可见语义：
 * 意图补全信封 → 一次快照前进 → 撤销按栈恢复。事务引擎的正确性由 jsdom 套件覆盖。 */
let doc = {
  documentId: 'z44b-electron', schemaVersion: 1, revision: 3, title: '流程图', boundSessionId: null,
  graph: {
    nodes: [
      { id: 'n1', label: '开始', x: 8100, y: -4200 },
      { id: 'n2', label: '处理', x: 200, y: 0 },
      { id: 'n3', label: '结束', x: -9100, y: 7600 },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2' }, { id: 'e2', from: 'n2', to: 'n3' }],
  }, appliedOps: [],
};
const history = [], submissions = [];
const applyIntents = intents => {
  if (!intents.length) return;
  const baseRevision = doc.revision;
  const ops = intents.map(intent => ({ opId: crypto.randomUUID(), type: intent.type, params: intent.params, baseRevision, actor: 'user' }));
  submissions.push(ops);
  const before = doc.graph.nodes.map(node => ({ id: node.id, x: node.x, y: node.y }));
  doc = { ...doc, revision: doc.revision + 1, graph: { ...doc.graph,
    nodes: doc.graph.nodes.map(node => {
      const op = ops.find(candidate => candidate.params.id === node.id && candidate.type === 'node.update');
      return op ? { ...node, x: op.params.x ?? node.x, y: op.params.y ?? node.y } : node;
    }) } };
  history.push(before);
  sync();
};
const undoOnce = () => {
  const before = history.pop();
  if (!before) return;
  doc = { ...doc, revision: doc.revision + 1, graph: { ...doc.graph,
    nodes: doc.graph.nodes.map(node => { const prior = before.find(entry => entry.id === node.id); return prior ? { ...node, x: prior.x, y: prior.y } : node; }) } };
  sync();
};
const canvas = mountCollabCanvas(document.querySelector('#canvas'), { document: doc,
  onOperations: applyIntents, onUndo: undoOnce, onRedo: () => {} });
window.__z44bExports = []; window.__z44bDownloads = []; window.__z44bNotices = [];
window.__z44bLiveUrls = new Set();
const originCreate = URL.createObjectURL.bind(URL);
const originRevoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = blob => { const url = originCreate(blob); window.__z44bDownloads.push(url); window.__z44bLiveUrls.add(url); return url; };
URL.revokeObjectURL = url => { window.__z44bLiveUrls.delete(url); originRevoke(url); };
const bar = mountCollabProductivity(document.querySelector('#bar'), { document: doc,
  onOperations: applyIntents,
  onNotice: notice => window.__z44bNotices.push(notice),
  onExport: result => {
    // 镜像 collab-panel.js downloadExport 的用户触发下载路径（Blob + a[download]）。
    window.__z44bExports.push(result);
    const anchor = document.createElement('a');
    anchor.download = 'z44b-' + result.format + '-r' + doc.revision + '.' + result.format;
    if (result.format === 'png' && result.image?.dataUrl) anchor.href = result.image.dataUrl;
    else anchor.href = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml;charset=utf-8' }));
    document.body.append(anchor); anchor.click(); anchor.remove();
  } });
function sync() { canvas.update({ document: doc, canUndo: history.length > 0 }); bar.update({ document: doc }); }
sync(); window.__z44bReady = true;
window.__z44bState = () => ({ revision: doc.revision, submissions: submissions.length,
  nodes: doc.graph.nodes.map(node => ({ id: node.id, x: node.x, y: node.y })) });
</script></body></html>`;

const ROOT = path.resolve(__dirname, '../..');

/** 供 Electron 夹具与浏览器复用脚本共享的 loopback 静态服务（装配页 + public/ + lib/）。
 * 可选 POST /__z44b/report：把浏览器运行取得的导出产物落盘到 Z44B_OUTPUT 证据目录；
 * 文件名走白名单（^[\w.-]+$），内容仅接受纯文本或 dataUrl（PNG base64 解码后写入）。 */
function createFixtureServer() {
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
  return http.createServer((request, response) => {
    const send = (status, type, body) => { response.writeHead(status, { 'content-type': type }); response.end(body); };
    if (request.method === 'POST' && request.url === '/__z44b/report') {
      if (!out || !/^[A-Za-z0-9._-]+$/.test(String(request.headers['x-z44b-name'] || ''))) return send(400, 'text/plain', 'bad name');
      const chunks = [];
      request.on('data', chunk => { chunks.push(chunk); if (Buffer.concat(chunks).length > 24 * 1024 * 1024) request.destroy(); });
      request.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          // 文件名已过 ^[\w.-]+$ 白名单（不含分隔符与 ..），join 后必然落在 out 内。
          fs.writeFileSync(path.join(out, request.headers['x-z44b-name']), body.startsWith('data:image/png;base64,')
            ? Buffer.from(body.split(',')[1], 'base64') : body);
          send(200, 'text/plain', 'ok');
        } catch { send(500, 'text/plain', 'write failed'); }
      });
      return;
    }
    try {
      if (request.url === '/' || request.url === '/index.html') return send(200, 'text/html', PAGE);
      const base = request.url.startsWith('/lib/') ? path.join(ROOT, 'lib') : path.join(ROOT, 'public');
      const file = path.join(base, path.normalize(request.url).replace(/^([/\\])*(lib[/\\])?/, ''));
      if (!file.startsWith(base) || !fs.existsSync(file)) return send(404, 'text/plain', 'missing');
      return send(200, types[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file));
    } catch { return send(500, 'text/plain', 'error'); }
  });
}

module.exports = { PAGE, createFixtureServer };

/* 作为 Electron 主进程运行时的完整验收流程。 */
// Electron's CJS bootstrap does not set require.main to the fixture module.
if (process.type === 'browser') void (async () => {
const { app, BrowserWindow, session } = require('electron');
let win, server;
app.on('window-all-closed', () => {});
async function main() {
  assert.ok(world && out && path.isAbsolute(out));
  assert.ok(!process.argv.includes('--no-sandbox') && !app.commandLine.hasSwitch('no-sandbox'));
  fs.mkdirSync(out, { recursive: true });
  server = createFixtureServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, done) => {
    const host = new URL(details.url).hostname;
    done({ cancel: host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' });
  });
  win = new BrowserWindow({ title: 'Z4-4B productivity acceptance', width: 1200, height: 860, useContentSize: true, show: true, autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('render-process-gone', (_event, details) => errors.push(details.reason));
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message.slice(0, 200)); });
  const read = code => win.webContents.executeJavaScript(code, true);
  const click = text => read(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)})?.click()`);
  await win.loadURL(origin);
  await until(() => read('window.__z44bReady === true'), 'fixture ready');
  check('真实 Chromium 正常沙箱装配页加载完成', win.webContents.getLastWebPreferences().sandbox === true);

  const before = await read('window.__z44bState()');
  check('初始凌乱文档版本与坐标', before.revision === 3 && before.nodes.find(n => n.id === 'n1').x === 8100);

  await click('自动整理');
  await until(() => read("!document.querySelector('.collab-prod-preview').hidden"), '预览出现');
  check('自动整理先展示预览', await read("document.querySelector('.collab-prod-preview p').textContent.includes('将移动 3 个节点')"));
  fs.writeFileSync(path.join(out, 'z44b-preview-1200.png'), (await win.capturePage()).toPNG()); screenshots.push('z44b-preview-1200.png');

  await click('确认应用布局');
  await until(async () => (await read('window.__z44bState()')).revision === 4, '布局提交');
  const laid = await read('window.__z44bState()');
  check('确认后单批提交且坐标分层排列', laid.submissions === 1 &&
    laid.nodes.every(n => n.y === 40) && laid.nodes.find(n => n.id === 'n1').x === 40 && laid.nodes.find(n => n.id === 'n3').x === 544);

  await click('撤销');
  await until(async () => (await read('window.__z44bState()')).revision === 5, '撤销提交');
  const undone = await read('window.__z44bState()');
  check('布局后现有撤销恢复原坐标', undone.nodes.find(n => n.id === 'n1').x === 8100 && undone.nodes.find(n => n.id === 'n3').x === -9100);

  await read("document.querySelector('[name=exportTheme]').value='dark'");
  await click('导出 SVG');
  await until(() => read('window.__z44bExports.length===1'), '深色 SVG 导出');
  const dark = await read('(async()=>await fetch(window.__z44bDownloads[0]).then(r=>r.text()))()');
  check('深色 SVG 含背景与中文长文本', dark.includes('fill="#151515"') && dark.includes('开始') && dark.includes('流程图'));
  fs.writeFileSync(path.join(out, 'z44b-export-dark.svg'), dark); artifacts.push('z44b-export-dark.svg');

  await read("document.querySelector('[name=exportTheme]').value='light'");
  await click('导出 SVG');
  await until(() => read('window.__z44bExports.length===2'), '浅色 SVG 导出');
  const light = await read('(async()=>await fetch(window.__z44bDownloads.at(-1)).then(r=>r.text()))()');
  check('浅色 SVG 白底且无外部资源', light.includes('fill="#ffffff"') && !/@import|https?:\/\/(?!www\.w3\.org)/.test(light));
  fs.writeFileSync(path.join(out, 'z44b-export-light.svg'), light); artifacts.push('z44b-export-light.svg');

  check('SVG 导出不改变撤销后的文档', (await read('window.__z44bState()')).revision === 5 && (await read('window.__z44bState()')).submissions === 1);
  await click('导出 PNG');
  await until(() => read("window.__z44bNotices.some(n=>n.message.includes('图形范围过大'))"), '大范围 PNG 明确拒绝');
  check('大范围 PNG 在分配前拒绝且不产生文件', await read('window.__z44bExports.length===2&&window.__z44bLiveUrls.size===2'));
  await click('自动整理'); await click('确认应用布局');
  await until(async () => (await read('window.__z44bState()')).revision === 6, '整理后默认 PNG');
  await click('导出 PNG');
  await until(() => read('window.__z44bExports.length===3'), 'PNG 光栅化');
  const png = await read('window.__z44bExports.at(-1).image.dataUrl');
  const bytes = Buffer.from(png.split(',')[1], 'base64');
  check('默认 renderer 在真实 Chromium 产出 PNG（魔数与尺寸）',
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes.length > 5000);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  check('PNG IHDR 尺寸与导出声明一致', width === (await read('window.__z44bExports.at(-1).image.width')) && width > 0 && height > 0);
  fs.writeFileSync(path.join(out, 'z44b-export-light.png'), bytes); artifacts.push('z44b-export-light.png');

  for (let round = 0; round < 20; round++) {
    await click('导出 PNG');
    await until(() => read(`window.__z44bExports.length===${round + 4}`), '重复 PNG ' + round);
    check('PNG 轮次 ' + round + ' 释放内部 Blob URL 且文档不变', await read('window.__z44bLiveUrls.size===2&&window.__z44bState().revision===6&&window.__z44bState().submissions===2'));
  }
  await read('for(const url of [...window.__z44bLiveUrls])URL.revokeObjectURL(url)');
  check('SVG 与 PNG 导出全部 URL 已释放', await read('window.__z44bLiveUrls.size===0'));
  check('文档在导出全程未被修改', (await read('window.__z44bState()')).revision === 6 && (await read('window.__z44bState()')).submissions === 2);
  check('装配页无渲染错误', errors.length === 0);

  win.setContentSize(760, 860);
  await sleep(250);
  fs.writeFileSync(path.join(out, 'z44b-narrow-760.png'), (await win.capturePage()).toPNG()); screenshots.push('z44b-narrow-760.png');
  check('窄窗口截图已留存（工具条换行）', true);
  return { rows, screenshots, artifacts, electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, platform: process.platform, sandbox: true, failed: 0 };
}
let failed = 0, report = null;
main().then(result => { report = result; }).catch(async error => {
  failed = 1; console.error(error.stack);
  if (win && !win.isDestroyed()) { try { fs.writeFileSync(path.join(out, 'z44b-failure.png'), (await win.capturePage()).toPNG()); } catch { /* 尽力而为 */ } }
}).finally(async () => {
  try { win?.destroy(); server?.closeAllConnections(); server?.close(); } catch { /* cleanup */ }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report || { qualification: 'failed', rows, failed: 1, failure: 'see runner log' }, null, 2) + '\n');
  app.exit(failed);
});
})();
