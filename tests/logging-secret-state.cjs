/* UI-5 补丁：敏感判定无状态化与端到端泄漏负向测试。
 *
 * 回归背景：SECRET_RE 曾带 g 标志且只用 .test()，匹配到 secret 后提前 return
 * 没有重置 lastIndex；下一次相同字符串会从上一处匹配之后继续搜索，从而被判为
 * “安全”。这里同时覆盖连续、交错、不同字段顺序、多条事件，以及从事件输入到
 * 原始 JSONL、崩溃文件、HTTP API、ZIP 的完整路径。
 *
 * 所有写操作都在 os.tmpdir()；不接触用户项目或会话。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  token, code, id, isSecretText, normalizeEvent, normalizeDetails, normalizeStored,
} = require('../lib/log-contract.cjs');
const { createLogCore } = require('../lib/log-core.cjs');
const { createLogService } = require('../server/logging.js');

const ROOT = path.resolve(__dirname, '..');
const NOW = Date.parse('2026-10-17T12:00:00.000Z');
/* 19 字符、单个连字符：能通过 TOKEN_RE/CODE_RE/ID_RE，但不会触发
 * SUSPICIOUS_TOKEN_RE（它要求 20+ 字符或 3 段以上连字符）。
 * 这正是旧实现会交替放行的形状。 */
const SECRET = 'sk-abcdefgh12345678';
const OTHER = 'sk-zyxwvuts98765432';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (error) { failed++; console.error('  FAIL ' + name + ': ' + error.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (error) { failed++; console.error('  FAIL ' + name + ': ' + error.message); }
}
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-log-secret-')); }
function allText(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try { if (fs.lstatSync(file).isFile()) out.push([name, fs.readFileSync(file, 'utf8')]); } catch { /* noop */ }
  }
  return out;
}
function noSecret(label, text) {
  assert.equal(String(text).includes(SECRET), false, `${label} leaked ${SECRET}`);
  assert.equal(String(text).includes(OTHER), false, `${label} leaked ${OTHER}`);
}
function unzip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'EOCD missing');
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const result = new Map();
  let cursor = centralOffset;
  for (let i = 0; i < count; i++) {
    const compSize = buffer.readUInt32LE(cursor + 20);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    result.set(name, zlib.inflateRawSync(buffer.subarray(dataStart, dataStart + compSize)).toString('utf8'));
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return result;
}
async function withHttp(service, fn) {
  const server = http.createServer((req, res) => {
    Promise.resolve(service.handle(req, res, new URL(req.url, 'http://127.0.0.1'))).catch(() => {
      if (!res.writableEnded) res.writeHead(500).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function main() {
  console.log('=== 敏感判定状态 ===');

  check('token/code/id 连续检测同一 secret 时不会交替放行', () => {
    for (let i = 0; i < 6; i++) {
      assert.equal(token(SECRET), null, `token 第 ${i + 1} 次放行`);
      assert.equal(code(SECRET), null, `code 第 ${i + 1} 次放行`);
      assert.equal(id(SECRET), null, `id 第 ${i + 1} 次放行`);
    }
    assert.equal(token('INFO'), 'INFO');
    assert.equal(code('BRIDGE.TIMEOUT'), 'BRIDGE.TIMEOUT');
    assert.equal(id('corr-12345678'), 'corr-12345678');
  });

  check('不同函数/安全值交错调用时状态不串扰', () => {
    const order = [token, code, token, id, token, code, id, token];
    for (const fn of order) assert.equal(fn(SECRET), null);
    assert.equal(token('renderer'), 'renderer');
    for (const fn of order) assert.equal(fn(OTHER), null);
    assert.equal(isSecretText(SECRET), true);
    assert.equal(isSecretText(SECRET), true);
    assert.equal(isSecretText('normal-token'), false);
    assert.equal(isSecretText(SECRET), true);
  });

  check('normalizeEvent 连续同值 secret 不会在第二次放行', () => {
    for (let i = 0; i < 6; i++) {
      const normalized = normalizeEvent({
        event: 'electron.renderer_responsive', code: SECRET, correlationId: SECRET,
      });
      assert.equal(normalized.code, null, `code 第 ${i + 1} 次放行`);
      assert.equal(normalized.correlationId, null, `correlationId 第 ${i + 1} 次放行`);
    }
  });

  check('不同字段顺序：secret 先经过 token，也不会让后面的 errorName 放行', () => {
    for (let i = 0; i < 4; i++) {
      const ordered = normalizeDetails('app.uncaught_exception', {
        role: SECRET,
        reason: SECRET,
        errorName: SECRET,
      }, true);
      assert.equal(ordered.role, undefined);
      assert.equal(ordered.reason, undefined);
      assert.equal(ordered.errorName, 'UnknownError', `第 ${i + 1} 次 errorName 放行`);

      const reversed = normalizeDetails('app.uncaught_exception', {
        errorName: SECRET,
        reason: SECRET,
        role: SECRET,
      }, true);
      assert.equal(reversed.errorName, 'UnknownError');
      assert.equal(reversed.role, undefined);
      assert.equal(reversed.reason, undefined);
    }
  });

  check('normalizeStored 连续多条事件同样拒绝 secret 字段', () => {
    const base = {
      v: 1, timestamp: '2026-10-17T12:00:00.000Z', level: 'INFO', source: 'app',
      event: 'app.exit', process: 'app',
    };
    for (let i = 0; i < 6; i++) {
      const stored = normalizeStored({ ...base, code: SECRET, runId: SECRET, correlationId: SECRET });
      assert.equal(stored.code, null, `code 第 ${i + 1} 次放行`);
      assert.equal(stored.runId, null, `runId 第 ${i + 1} 次放行`);
      assert.equal(stored.correlationId, null, `correlationId 第 ${i + 1} 次放行`);
    }
  });

  console.log('=== 端到端落盘 / 崩溃 / ZIP ===');
  const dir = temp();
  const core = createLogCore({ dir, role: 'app', version: '0.25.0', appRoot: ROOT, now: () => NOW });
  try {
    check('原始 JSONL 与崩溃记录不包含连续事件里的 secret', () => {
      /* 这个事件没有可重置检测状态的 token 字段，旧实现第二条约会落盘。 */
      core.event('app', 'electron.renderer_responsive', {}, { code: SECRET });
      core.event('app', 'electron.renderer_responsive', {}, { code: SECRET });
      core.event('app', 'electron.renderer_responsive', {}, { code: OTHER });
      const error = { name: '', code: SECRET, stack: '', message: SECRET };
      core.crash('app', 'app.crash', error);
      core.crash('app', 'app.crash', error);
      core.flushSync();
      assert.ok(fs.readdirSync(dir).some((name) => /-crash-/.test(name)), '没有生成崩溃文件');
      for (const [name, text] of allText(dir)) noSecret('log file ' + name, text);
      noSecret('status', JSON.stringify(core.status()));
      noSecret('entries', JSON.stringify(core.readEntries({ limit: 200 })));
    });

    check('ZIP 的每个文件都不包含 secret', () => {
      const result = core.buildExport({ windowMinutes: 1440, description: SECRET, repro: OTHER });
      assert.equal(result.ok, true);
      const zip = unzip(result.buffer);
      assert.deepEqual([...zip.keys()].sort(), ['README.txt', 'diagnostics.json', 'errors.jsonl', 'events.jsonl', 'report.md'].sort());
      for (const [name, text] of zip) noSecret('zip ' + name, text);
    });
  } finally {
    core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('=== HTTP 日志 API / 崩溃记录 / ZIP ===');
  const httpDir = temp();
  const service = createLogService({
    dir: httpDir,
    version: '0.25.0',
    appRoot: ROOT,
    now: () => NOW,
    getDiagnostics: () => null,
  });
  try {
    await withHttp(service, async (origin) => {
      await checkAsync('POST 连续/交错 secret 后，日志 API 与原始文件都不含 secret', async () => {
        const response = await fetch(origin + '/api/logs/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: [
            { event: 'ui.action_failed', details: {}, correlationId: SECRET },
            { event: 'ui.action_failed', details: {}, correlationId: SECRET },
            { event: 'app.uncaught_exception', details: { role: SECRET, reason: SECRET, errorName: SECRET } },
            { event: 'app.uncaught_exception', details: { role: SECRET, reason: SECRET, errorName: SECRET } },
            { event: 'ui.action_failed', details: {}, correlationId: OTHER },
          ] }),
        });
        const body = await response.json();
        assert.equal(body.ok, true);
        assert.ok(body.accepted >= 3);
        const entries = await (await fetch(origin + '/api/logs/entries?limit=200')).json();
        noSecret('entries API', JSON.stringify(entries));
        const status = await (await fetch(origin + '/api/logs/status')).json();
        noSecret('status API', JSON.stringify(status));
        service.core.flushSync();
        for (const [name, text] of allText(httpDir)) noSecret('http log file ' + name, text);
        assert.ok(fs.readdirSync(httpDir).some((name) => /-crash-/.test(name)), 'HTTP 路径没有生成崩溃文件');
      });

      await checkAsync('HTTP 导出的 ZIP 每个文件都不含 secret', async () => {
        const response = await fetch(origin + '/api/logs/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true, windowMinutes: 1440, description: SECRET, repro: OTHER }),
        });
        assert.equal(response.status, 200);
        const zip = unzip(Buffer.from(await response.arrayBuffer()));
        for (const [name, text] of zip) noSecret('http zip ' + name, text);
      });
    });
  } finally {
    try { service.dispose(); } catch { /* noop */ }
    fs.rmSync(httpDir, { recursive: true, force: true });
  }

  console.log(`logging-secret-state: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
