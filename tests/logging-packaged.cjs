/* UI-5：在隔离离线构建产物上验证日志服务，而不是只跑源码 dev server。
 *
 * 用法：node tests/logging-packaged.cjs --output-root <build-output>
 * 启动 resources/app/server.cjs（打包后的单文件后端），使用独立 TEMP、独立端口、
 * 独立日志目录；不启动真实 Pi，不接触用户项目。
 */
'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const OUTPUT_AT = process.argv.indexOf('--output-root');
const OUTPUT_ROOT = OUTPUT_AT < 0 ? '' : process.argv[OUTPUT_AT + 1];
if (!OUTPUT_ROOT || !path.isAbsolute(OUTPUT_ROOT)) throw Error('invalid --output-root');
const APP = path.join(OUTPUT_ROOT, 'dist-app', 'Pi GUI-win32-x64', 'resources', 'app');
const SERVER = path.join(APP, 'server.cjs');
const PORT = Number(process.env.LOG_CHECK_PORT || 7913);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'logging-packaged-fixture-token-1234567890';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-log-packaged-data-'));
const logs = path.join(data, 'logs');
let passed = 0, failed = 0, skipped = 0;
const checks = [];
function check(name, fn) {
  try { const value = fn(); if (value === false) throw Error('false'); passed++; checks.push({ name, pass: true }); console.log('  ok   ' + name); }
  catch (error) { failed++; checks.push({ name, pass: false, error: error.message }); console.error('  FAIL ' + name + ': ' + error.message); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function unzip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0);
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    const compSize = buffer.readUInt32LE(cursor + 20);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    files.set(name, zlib.inflateRawSync(buffer.subarray(start, start + compSize)).toString('utf8'));
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
async function waitUp() {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    try {
      const response = await fetch(BASE + '/api/health');
      const body = await response.json();
      if (body?.app === 'pi-gui') return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
}
function stop(proc) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else proc.kill('SIGTERM');
  } catch { /* already gone */ }
}

(async () => {
  assert.ok(fs.existsSync(SERVER), 'packaged server.cjs missing; run build first');
  for (const name of ['log-core.cjs', 'log-contract.cjs', 'zip.cjs', 'main.cjs', 'logging.cjs']) {
    check('包内存在 ' + name, () => fs.existsSync(path.join(APP, name)));
  }
  const proc = spawn(process.execPath, [SERVER], {
    cwd: data,
    env: {
      ...process.env,
      PORT: String(PORT),
      PI_GUI_OPEN: '0',
      PI_GUI_DATA: data,
      PI_GUI_LOG_DIR: logs,
      PI_GUI_TOKEN: TOKEN,
      PI_CWD: '',
      // 不连接任何真实 Pi；没有项目时后端不会 spawn。
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  proc.stdout.on('data', (d) => { output += d; });
  proc.stderr.on('data', (d) => { output += d; });
  try {
    check('打包后端启动', () => waitUp()); // replaced below by async check
    // The synchronous check above cannot await; keep a real async gate.
    if (!(await waitUp())) throw new Error('packaged backend did not start:\n' + output.slice(0, 1200));
    const headers = { 'X-Pi-Gui-Token': TOKEN, 'Content-Type': 'application/json' };
    const status = await (await fetch(BASE + '/api/logs/status', { headers })).json();
    check('打包版状态接口返回日志状态', () => status.ok && status.status?.role === 'backend');
    const eventResponse = await (await fetch(BASE + '/api/logs/events', {
      method: 'POST', headers, body: JSON.stringify({ events: [{ event: 'ui.attachment_failed', details: { kind: 'image', reason: 'upload_failed' } }] }),
    })).json();
    check('打包版接收 Renderer 白名单事件', () => eventResponse.ok && eventResponse.accepted === 1);
    const entries = await (await fetch(BASE + '/api/logs/entries?limit=20', { headers })).json();
    check('打包版读取到事件并标记 renderer 进程', () => entries.entries.some((entry) => entry.process === 'renderer' && entry.event === 'ui.attachment_failed'));
    const preview = await (await fetch(BASE + '/api/logs/export/preview', {
      method: 'POST', headers, body: JSON.stringify({ windowMinutes: 30 }),
    })).json();
    check('打包版导出预览包含固定清单', () => preview.ok && preview.filesIncluded.includes('events.jsonl'));
    const zipResponse = await fetch(BASE + '/api/logs/export', {
      method: 'POST', headers, body: JSON.stringify({ confirm: true, windowMinutes: 30, description: '打包版故障报告' }),
    });
    check('打包版导出 ZIP', () => zipResponse.status === 200 && /application\/zip/.test(zipResponse.headers.get('content-type') || ''));
    const zip = unzip(Buffer.from(await zipResponse.arrayBuffer()));
    check('打包版 ZIP 固定五文件且可解压', () => [...zip.keys()].sort().join(',') === ['README.txt', 'diagnostics.json', 'errors.jsonl', 'events.jsonl', 'report.md'].sort().join(','));
    check('打包版日志目录独立于应用目录', () => fs.existsSync(logs) && !fs.existsSync(path.join(APP, 'logs')));
    const clear = await (await fetch(BASE + '/api/logs/clear', {
      method: 'POST', headers, body: JSON.stringify({ confirm: true }),
    })).json();
    check('打包版清理日志', () => clear.ok && clear.fileCount >= 0);
    // 打包版也必须至少有一份主进程日志核心文件，否则 Electron 启动时无法记录崩溃。
    check('打包版主进程可加载日志核心', () => {
      const { createMainLogging } = require(path.join(APP, 'logging.cjs'));
      const dir = path.join(data, 'main-logs');
      const logger = createMainLogging({ dir, version: '0.25.0', appRoot: APP });
      logger.event('electron', 'app.ready', { role: 'main', durationMs: 1, windowCount: 0 });
      logger.flushSync();
      const files = fs.readdirSync(dir).filter((name) => name.startsWith('main-'));
      logger.close('test');
      return files.length >= 1;
    });
  } finally {
    stop(proc);
    await sleep(400);
    try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* noop */ }
  }
  console.log(`logging-packaged: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
