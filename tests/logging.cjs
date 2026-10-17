/* UI-5：本地日志核心、持久化、轮转、分页、导出与 HTTP 服务契约。 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createLogCore, scrubShortText } = require('../lib/log-core.cjs');
const { createLogService } = require('../server/logging.js');

let passed = 0, failed = 0, skipped = 0;
function check(name, fn) {
  try {
    const value = fn();
    if (value && typeof value.then === 'function') throw Error('async checks must use checkAsync');
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failed++;
    console.error('  FAIL ' + name + ': ' + error.message);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failed++;
    console.error('  FAIL ' + name + ': ' + error.message);
  }
}
function temp(prefix = 'pi-gui-log-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function writeSettings(dir, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'logging-preferences.json'), JSON.stringify(value), 'utf8');
}
function files(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => /^(?:app|main)(?:-crash)?-\d{8}(?:-\d+)?\.jsonl$/.test(name));
  } catch { return []; }
}
function readLines(dir) {
  const out = [];
  for (const name of files(dir)) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      out.push(JSON.parse(line));
    }
  }
  return out;
}
function unzip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'EOCD missing');
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const result = new Map();
  let cursor = centralOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10);
    const compSize = buffer.readUInt32LE(cursor + 20);
    const rawSize = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    assert.equal(method, 8);
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50);
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buffer.subarray(dataStart, dataStart + compSize);
    const data = zlib.inflateRawSync(compressed);
    assert.equal(data.length, rawSize);
    result.set(name, data);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(cursor, centralOffset + centralSize);
  return result;
}
async function withHttp(service, fn) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    Promise.resolve(service.handle(req, res, url)).catch(() => {
      if (!res.writableEnded) { res.writeHead(500); res.end(); }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(origin); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}
async function main() {
  console.log('=== 日志核心 ===');
  {
    const dir = temp();
    const core = createLogCore({ dir, role: 'app', version: '0.25.0', appRoot: path.join(__dirname, '..'), now: () => Date.parse('2026-10-17T12:00:00.000Z') });
    check('启动产生结构化 app.start，且默认目录在注入的临时目录', () => {
      core.flushSync();
      const lines = readLines(dir);
      assert.ok(lines.some((line) => line.event === 'app.start' && line.source === 'app'));
      assert.equal(core.status().fileCount, 1);
      assert.ok(files(dir).every((name) => name.startsWith('app-')));
    });
    check('标准模式不写 DEBUG，详细模式写 DEBUG', () => {
      assert.equal(core.event('logs', 'logs.rotation', { fileCount: 1 }), false);
      assert.equal(core.updateSettings({ mode: 'verbose' }).ok, true);
      assert.equal(core.event('logs', 'logs.rotation', { fileCount: 1 }), true);
      core.flushSync();
      assert.ok(readLines(dir).some((line) => line.event === 'logs.rotation'));
      core.updateSettings({ mode: 'standard' });
    });
    check('未知事件与未知字段直接丢弃', () => {
      core.flushSync();
      const before = readLines(dir).length;
      assert.equal(core.event('pi-bridge', 'bridge.not_real', { message: 'sk-secret-should-not-appear' }), false);
      assert.equal(core.event('pi-bridge', 'bridge.state', {
        state: 'ready', bridgeRun: 2, message: 'secret chat text', path: 'C:\\Users\\private\\file.txt',
      }), true);
      core.flushSync();
      const lines = readLines(dir);
      assert.equal(lines.length, before + 1);
      const entry = lines[lines.length - 1];
      assert.equal(entry.details.message, undefined);
      assert.equal(entry.details.path, undefined);
      assert.equal(JSON.stringify(entry).includes('secret chat'), false);
    });
    check('开始/失败/耗时使用同一 correlationId', () => {
      const correlationId = 'corr-12345678';
      assert.equal(core.event('pi-bridge', 'bridge.state', { state: 'ready', bridgeRun: 3 }, { correlationId }), true);
      assert.equal(core.event('pi-bridge', 'bridge.request_timeout', { operation: 'get_state', durationMs: 1200, bridgeRun: 3 }, { correlationId }), true);
      core.flushSync();
      const linked = readLines(dir).filter((line) => line.correlationId === correlationId);
      assert.equal(linked.length, 2);
      assert.ok(linked.some((line) => line.event === 'bridge.request_timeout' && line.details.durationMs === 1200));
    });
    check('禁用后不再写日志；重新启用后恢复', () => {
      assert.equal(core.updateSettings({ enabled: false }).ok, true);
      const before = readLines(dir).length;
      assert.equal(core.event('pi-bridge', 'bridge.state', { state: 'ready' }), false);
      core.flushSync();
      assert.equal(readLines(dir).length, before);
      assert.equal(core.updateSettings({ enabled: true }).ok, true);
      assert.equal(core.event('pi-bridge', 'bridge.state', { state: 'ready' }), true);
      core.flushSync();
    });
    check('设置文件拒绝非法值，并保留有效设置', () => {
      const bad = core.updateSettings({ retentionDays: 999, mode: 'loud' });
      assert.equal(bad.ok, false);
      assert.equal(bad.code, 'invalid_settings');
      assert.equal(core.getSettings().retentionDays, 7);
    });
    check('清理只删日志文件，不删设置/会话标记', () => {
      const result = core.clearLogs();
      assert.ok(result.fileCount >= 1);
      assert.equal(files(dir).length, 0);
      assert.ok(fs.existsSync(path.join(dir, 'logging-preferences.json')));
      assert.ok(fs.existsSync(path.join(dir, 'session-app.json')));
    });
    core.close({ reason: 'test' });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = temp();
    writeSettings(dir, { enabled: true, mode: 'standard', retentionDays: 1, maxTotalMB: 10 });
    fs.writeFileSync(path.join(dir, 'app-20260101.jsonl'), '{"old":true}\n');
    const core = createLogCore({ dir, role: 'app', version: '0.25.0', appRoot: path.join(__dirname, '..'), now: () => Date.parse('2026-10-17T12:00:00.000Z') });
    check('保留期清理只保留窗口内的文件', () => {
      core.flushSync();
      assert.equal(files(dir).some((name) => name === 'app-20260101.jsonl'), false);
      assert.ok(files(dir).some((name) => name.startsWith('app-20261017')));
    });
    core.close({ reason: 'test' });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = temp();
    writeSettings(dir, { enabled: true, mode: 'verbose', retentionDays: 7, maxTotalMB: 10, verboseUntil: '2020-01-01T00:00:00.000Z' });
    const core = createLogCore({ dir, role: 'app', version: '0.25.0', appRoot: path.join(__dirname, '..'), now: () => Date.parse('2026-10-17T12:00:00.000Z') });
    check('详细模式到期自动回标准并持久化', () => {
      const status = core.status();
      assert.equal(status.mode, 'standard');
      assert.equal(status.verboseExpired, true);
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'logging-preferences.json'), 'utf8'));
      assert.equal(saved.mode, 'standard');
      assert.equal(saved.verboseUntil, null);
    });
    core.close({ reason: 'test' });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = temp();
    const core = createLogCore({ dir, role: 'app', version: '0.25.0', appRoot: path.join(__dirname, '..'), maxFileBytes: 700, now: () => Date.parse('2026-10-17T12:00:00.000Z') });
    check('文件超过上限后轮转，旧文件保留且可读', () => {
      for (let i = 0; i < 20; i++) core.event('runtime', 'runtime.start_failed', { phase: 'factory', code: 'runtime_start_failed' });
      core.flushSync();
      const names = files(dir);
      assert.ok(names.length >= 2, 'expected rotated files, got ' + names.join(','));
      const lines = readLines(dir);
      assert.ok(lines.filter((line) => line.event === 'runtime.start_failed').length >= 20);
    });
    core.close({ reason: 'test' });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = temp();
    const core = createLogCore({ dir, role: 'app', version: '0.25.0', appRoot: path.join(__dirname, '..'), now: (() => { let t = Date.parse('2026-10-17T12:00:00.000Z'); return () => t++; })() });
    check('损坏行被跳过，后续日志仍可读取', () => {
      core.event('app', 'app.start', { role: 'backend', version: '0.25.0' });
      core.flushSync();
      fs.appendFileSync(path.join(dir, files(dir)[0]), 'not-json\n{"broken":true}\n');
      const result = core.readEntries({ limit: 100 });
      assert.ok(result.ok);
      assert.ok(result.entries.length >= 1);
    });
    check('分页不重复（cursor 向前翻页）', () => {
      for (let i = 0; i < 130; i++) core.event('runtime', 'runtime.owner_rejected', { operation: 'resolve', reason: 'owner_stale' });
      core.flushSync();
      const first = core.readEntries({ limit: 50 });
      assert.equal(first.entries.length, 50);
      assert.equal(first.truncated, true);
      const second = core.readEntries({ limit: 50, cursor: first.nextCursor });
      const ids = new Set(first.entries.map((entry) => entry.cursor));
      assert.ok(second.entries.length > 0);
      assert.ok(second.entries.every((entry) => !ids.has(entry.cursor)));
    });
    core.close({ reason: 'test' });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = temp();
    const core = createLogCore({ dir, role: 'app', version: '0.25.0', appRoot: path.join(__dirname, '..'), now: () => Date.parse('2026-10-17T12:00:00.000Z') });
    const error = Object.assign(new Error('chat body sk-abcdefghijklmnop Bearer top-secret C:\\Users\\21022\\private'), {
      name: 'FixtureError',
      stack: 'FixtureError: chat body sk-abcdefghijklmnop\n    at handler (C:\\Users\\21022\\private\\server\\rpc-bridge.js:10:2)',
    });
    check('崩溃进入独立 crash 文件，且不记录异常 message', () => {
      assert.equal(core.crash('pi-bridge', 'app.crash', error, { reason: 'crash' }), true);
      core.flushSync();
      const crashNames = files(dir).filter((name) => name.includes('-crash-'));
      assert.equal(crashNames.length, 1);
      const crashText = fs.readFileSync(path.join(dir, crashNames[0]), 'utf8');
      assert.ok(crashText.includes('FixtureError'));
      assert.equal(crashText.includes('sk-abcdefghijklmnop'), false);
      assert.equal(crashText.includes('top-secret'), false);
      assert.equal(crashText.includes('21022'), false);
      assert.equal(crashText.includes('message'), false);
    });
    check('未正常关闭后重启可看到上次异常退出线索', () => {
      // 不调用 close：模拟进程直接消失。
      const next = createLogCore({ dir, role: 'app', version: '0.25.0', appRoot: path.join(__dirname, '..'), now: () => Date.parse('2026-10-17T12:01:00.000Z') });
      const status = next.status();
      assert.ok(status.session.previousUnclean);
      assert.equal(status.crashFileCount, 1);
      next.close({ reason: 'test' });
    });
    check('正常关闭后下一次启动不再误报异常退出', () => {
      const third = createLogCore({ dir, role: 'app', version: '0.25.0', appRoot: path.join(__dirname, '..'), now: () => Date.parse('2026-10-17T12:02:00.000Z') });
      assert.equal(third.status().session.previousUnclean, null);
      third.close({ reason: 'test' });
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = temp();
    const core = createLogCore({ dir, role: 'app', version: '0.25.0', appRoot: path.join(__dirname, '..'), now: () => Date.parse('2026-10-17T12:00:00.000Z') });
    check('不可写目录只降级，不把异常抛给业务', () => {
      const badDir = path.join(dir, 'not-a-directory');
      fs.writeFileSync(badDir, 'x');
      const bad = createLogCore({ dir: badDir, role: 'app', version: '0.25.0', appRoot: path.join(__dirname, '..') });
      const status = bad.status();
      assert.equal(status.dirWritable, false);
      assert.equal(bad.event('app', 'app.start', { role: 'backend', version: '0.25.0' }), false);
      assert.doesNotThrow(() => bad.flushSync());
      assert.doesNotThrow(() => bad.close({ reason: 'test' }));
    });
    check('高频写入仍保持每行合法 JSON，且有界批处理不阻塞调用方', () => {
      const started = Date.now();
      for (let i = 0; i < 600; i++) core.event('runtime', 'runtime.owner_rejected', { operation: 'resolve', reason: 'owner_stale' });
      core.flushSync();
      assert.ok(Date.now() - started < 5000, '600 events took ' + (Date.now() - started) + 'ms');
      const lines = fs.readFileSync(path.join(dir, files(dir)[0]), 'utf8').split(/\r?\n/).filter(Boolean);
      assert.equal(lines.length >= 600, true);
      for (const line of lines) JSON.parse(line);
    });
    core.close({ reason: 'test' });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = temp();
    const failFs = new Proxy(fs, {
      get(target, prop) {
        if (prop === 'appendFileSync') return () => { throw Object.assign(Error('disk full fixture'), { code: 'ENOSPC' }); };
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const core = createLogCore({ dir, role: 'app', version: '0.25.0', appRoot: path.join(__dirname, '..'), fsApi: failFs });
    check('磁盘空间不足（ENOSPC）只进入降级状态，不影响调用方', () => {
      assert.equal(core.event('pi-bridge', 'bridge.state', { state: 'ready', bridgeRun: 1 }), true);
      assert.doesNotThrow(() => core.flushSync());
      const status = core.status();
      assert.equal(status.degraded, true);
      assert.equal(status.lastErrorCode, 'disk_full');
      assert.equal(core.event('pi-bridge', 'bridge.state', { state: 'ready' }), true);
      assert.doesNotThrow(() => core.close({ reason: 'test' }));
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = temp();
    const { createMainLogging } = require('../electron/logging.cjs');
    const backendCore = createLogCore({ dir, role: 'app', version: '0.25.0', appRoot: path.join(__dirname, '..'), now: () => Date.parse('2026-10-17T12:00:00.000Z') });
    const main = createMainLogging({ dir, version: '0.25.0', appRoot: path.join(__dirname, '..'), now: () => Date.parse('2026-10-17T12:00:00.000Z') });
    check('后端与主进程并发写不同文件，事件保持各自进程身份', () => {
      for (let i = 0; i < 100; i++) {
        backendCore.event('pi-bridge', 'bridge.state', { state: 'ready', bridgeRun: i });
        main.event('electron', 'app.ready', { role: 'main', windowCount: 1 });
      }
      backendCore.flushSync(); main.flushSync();
      const lines = readLines(dir);
      assert.ok(lines.some((line) => line.process === 'backend' && line.source === 'pi-bridge'));
      assert.ok(lines.some((line) => line.process === 'main' && line.source === 'electron'));
      for (const line of lines) JSON.parse(JSON.stringify(line));
      assert.ok(files(dir).some((name) => name.startsWith('app-')));
      assert.ok(files(dir).some((name) => name.startsWith('main-')));
      backendCore.close({ reason: 'test' }); main.close('test');
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = temp();
    const core = createLogCore({ dir, role: 'app', version: '0.25.0', appRoot: path.join(__dirname, '..') });
    check('同一次操作跨后端/Renderer 用 correlationId 关联', () => {
      const correlationId = 'corr12345678';
      core.event('renderer', 'ui.stop_result', { result: 'confirmed' }, { correlationId, process: 'renderer' });
      core.event('pi-bridge', 'bridge.stop_result', { result: 'stopped', bridgeRun: 1 }, { correlationId });
      core.flushSync();
      const linked = core.readEntries({ limit: 20 }).entries.filter((entry) => entry.correlationId === correlationId);
      assert.equal(linked.length, 2);
      assert.deepEqual(new Set(linked.map((entry) => entry.process)), new Set(['backend', 'renderer']));
    });
    core.close({ reason: 'test' });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('=== 导出 ZIP ===');
  {
    const dir = temp();
    const core = createLogCore({ dir, role: 'app', version: '0.25.0', appRoot: path.join(__dirname, '..'), now: () => Date.parse('2026-10-17T12:00:00.000Z') });
    core.event('pi-bridge', 'bridge.state', { state: 'ready', bridgeRun: 1 });
    core.event('pi-bridge', 'bridge.request_timeout', { operation: 'get_state', durationMs: 1200, bridgeRun: 1 });
    core.crash('pi-bridge', 'app.crash', Object.assign(new Error('do-not-export sk-abcdefghijklmnop'), { name: 'FixtureError' }), { reason: 'crash' });
    core.flushSync();
    check('导出含固定五文件，目录/内容可解压，错误单独列出', () => {
      const exported = core.buildExport({
        windowMinutes: 60,
        description: '用户描述 <img onerror="window.__xss=1">',
        repro: '打开页面后点击导出；sk-abcdefghijklmnop C:\\Users\\21022\\secret',
        diagnostics: { app: { version: '0.25.0' }, privacy: { redactionApplied: true } },
        environment: { appVersion: '0.25.0', platform: process.platform, arch: process.arch, nodeVersion: process.version },
      });
      assert.equal(exported.ok, true);
      const contents = unzip(exported.buffer);
      assert.deepEqual([...contents.keys()], ['README.txt', 'report.md', 'diagnostics.json', 'events.jsonl', 'errors.jsonl']);
      assert.ok(contents.get('README.txt').toString('utf8').includes('不会自动上传'));
      const report = contents.get('report.md').toString('utf8');
      assert.ok(report.includes('<img onerror')); // 作为纯文本写入，不是 HTML 执行
      assert.equal(report.includes('sk-abcdefghijklmnop'), false);
      assert.equal(report.includes('21022'), false);
      const errors = contents.get('errors.jsonl').toString('utf8').trim().split(/\r?\n/).filter(Boolean);
      assert.ok(errors.length >= 1);
      for (const line of errors) JSON.parse(line);
      const diag = JSON.parse(contents.get('diagnostics.json').toString('utf8'));
      assert.equal(diag.privacy.redactionApplied, true);
    });
    check('导出不调用网络', () => {
      const oldFetch = global.fetch;
      global.fetch = () => { throw Error('network must not be used'); };
      try {
        const exported = core.buildExport({ windowMinutes: 60, diagnostics: { app: { version: '0.25.0' } } });
        assert.equal(exported.ok, true);
      } finally { global.fetch = oldFetch; }
    });
    check('导出失败明确返回固定错误码，不抛出', () => {
      const cyclic = {};
      Object.defineProperty(cyclic, 'self', { enumerable: true, get() { throw Error('boom'); } });
      const exported = core.buildExport({ windowMinutes: 60, diagnostics: cyclic });
      assert.equal(exported.ok, false);
      assert.equal(exported.code, 'export_failed');
      assert.equal(JSON.stringify(exported).includes('boom'), false);
    });
    core.close({ reason: 'test' });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('=== HTTP 服务契约 ===');
  {
    const dir = temp();
    const service = createLogService({
      dir,
      version: '0.25.0',
      appRoot: path.join(__dirname, '..'),
      now: () => Date.parse('2026-10-17T12:00:00.000Z'),
      getDiagnostics: () => ({ app: { version: '0.25.0' }, privacy: { redactionApplied: true } }),
    });
    await withHttp(service, async (origin) => {
      await checkAsync('GET /api/logs/status 返回状态且不含绝对路径', async () => {
        const response = await fetch(origin + '/api/logs/status');
        const body = await response.json();
        assert.equal(body.ok, true);
        assert.ok(body.status);
        assert.equal(JSON.stringify(body).includes(dir), false);
      });
      await checkAsync('POST /api/logs/events 只接受白名单事件与字段', async () => {
        const response = await fetch(origin + '/api/logs/events', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: [
            { event: 'ui.attachment_failed', details: { kind: 'image', reason: 'upload_failed', message: 'sk-abcdefghijklmnop' } },
            { event: 'bridge.not_real', details: { message: 'must-not-log' } },
            { event: 'ui.uncaught_exception', details: { errorName: 'Error', frames: [{ file: 'public/app.js', line: 1 }, { file: 'C:\\Users\\21022\\x.js' }] } },
          ] }),
        });
        const body = await response.json();
        assert.equal(body.ok, true);
        assert.equal(body.accepted, 2);
        const entries = await (await fetch(origin + '/api/logs/entries?limit=20')).json();
        const text = JSON.stringify(entries);
        assert.equal(text.includes('sk-abcdefghijklmnop'), false);
        assert.equal(text.includes('must-not-log'), false);
        assert.ok(entries.entries.some((entry) => entry.process === 'renderer' && entry.event === 'ui.attachment_failed'));
      });
      await checkAsync('POST /api/logs/settings 校验并返回状态', async () => {
        const response = await fetch(origin + '/api/logs/settings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'verbose' }),
        });
        const body = await response.json();
        assert.equal(body.ok, true);
        assert.equal(body.status.mode, 'verbose');
        const bad = await fetch(origin + '/api/logs/settings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retentionDays: 999 }),
        });
        assert.equal(bad.status, 409);
      });
      await checkAsync('导出需要显式确认，预览返回清单与计数', async () => {
        const preview = await (await fetch(origin + '/api/logs/export/preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ windowMinutes: 60 }),
        })).json();
        assert.equal(preview.ok, true);
        assert.ok(preview.filesIncluded.includes('events.jsonl'));
        const missing = await fetch(origin + '/api/logs/export', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ windowMinutes: 60 }),
        });
        assert.equal(missing.status, 400);
      });
      await checkAsync('导出 ZIP 可直接解压，且不再向日志写入用户描述原文', async () => {
        const response = await fetch(origin + '/api/logs/export', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true, windowMinutes: 60, description: '问题 sk-abcdefghijklmnop', repro: '重复打开' }),
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') || '', /application\/zip/);
        const filesInZip = unzip(Buffer.from(await response.arrayBuffer()));
        const report = filesInZip.get('report.md').toString('utf8');
        assert.ok(report.includes('重复打开'));
        assert.equal(report.includes('sk-abcdefghijklmnop'), false);
      });
      await checkAsync('清理需要确认；确认后状态回到空', async () => {
        service.core.flushSync();
        const missing = await fetch(origin + '/api/logs/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(missing.status, 400);
        const cleared = await (await fetch(origin + '/api/logs/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"confirm":true}' })).json();
        assert.equal(cleared.ok, true);
        assert.equal(cleared.fileCount >= 1, true);
        const status = await (await fetch(origin + '/api/logs/status')).json();
        assert.equal(status.status.fileCount, 0);
      });
    });
    service.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }


  console.log('=== Electron 主进程适配 ===');
  {
    const dir = temp();
    const { createMainLogging, defaultMainLogDir } = require('../electron/logging.cjs');
    const main = createMainLogging({ dir, version: '0.25.0', appRoot: path.join(__dirname, '..'), now: () => Date.parse('2026-10-17T12:00:00.000Z') });
    check('主进程写独立 main-* 文件，不与后端同名', () => {
      assert.equal(main.available, true);
      assert.equal(main.event('electron', 'app.ready', { role: 'main', windowCount: 0 }), true);
      main.flushSync();
      const names = files(dir);
      assert.ok(names.length === 1);
      assert.ok(names[0].startsWith('main-'));
    });
    check('主进程按 mtime 重新读取后端写入的日志设置', () => {
      const backend = createLogCore({ dir, role: 'app', version: '0.25.0', appRoot: path.join(__dirname, '..'), now: () => Date.parse('2026-10-17T12:00:00.000Z') });
      assert.equal(main.event('electron', 'electron.browser_view_state', { operation: 'attach', state: 'already_attached' }), false);
      assert.equal(backend.updateSettings({ mode: 'verbose' }).ok, true);
      assert.equal(main.event('electron', 'electron.browser_view_state', { operation: 'attach', state: 'already_attached' }), true);
      main.flushSync();
      backend.close({ reason: 'test' });
    });
    check('主进程默认目录由 userData / PI_GUI_DATA 决定，不使用项目目录', () => {
      const app = { getPath: () => path.join(dir, 'user-data') };
      assert.equal(defaultMainLogDir({ app, env: {} }), path.join(dir, 'user-data', 'logs'));
      assert.equal(defaultMainLogDir({ app, env: { PI_GUI_DATA: path.join(dir, 'data') } }), path.join(dir, 'data', 'logs'));
    });
    main.close('test');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`logging: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
