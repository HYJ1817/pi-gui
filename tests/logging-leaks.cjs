/* UI-5：日志系统的泄漏负向测试。
 *
 * 不只是测“某个 redact() 函数”：伪造秘密分别注入事件、错误、Renderer API、
 * 诊断快照和导出描述，然后扫描最终落盘、HTTP 可读数据以及 ZIP 的每个文件。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createLogCore } = require('../lib/log-core.cjs');
const { createLogService } = require('../server/logging.js');

const SECRETS = [
  'sk-live-DO-NOT-LEAK-0123456789',
  'Bearer bearer-DO-NOT-LEAK-123456',
  'apiKey=api-DO-NOT-LEAK-456',
  'oauth-DO-NOT-LEAK-789',
  'Cookie: session=DO-NOT-LEAK-cookie',
  'C:\\Users\\21022\\Private Project\\notes.md',
  '/home/alice/DO-NOT-LEAK-home',
  'USER_CHAT_BODY_DO_NOT_LOG',
  'TOOL_OUTPUT_DO_NOT_LOG',
  'https://example.com/page#token=browser-DO-NOT-LEAK',
  'OPENAI_API_KEY=env-DO-NOT-LEAK-999',
  'stack-DO-NOT-LEAK-frame',
];

let passed = 0, failed = 0, skipped = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (error) { failed++; console.error('  FAIL ' + name + ': ' + error.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (error) { failed++; console.error('  FAIL ' + name + ': ' + error.message); }
}
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-log-leak-')); }
function allText(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try { if (fs.lstatSync(file).isFile()) out.push([name, fs.readFileSync(file, 'utf8')]); } catch { /* noop */ }
  }
  return out;
}
function noSecrets(label, text) {
  for (const secret of SECRETS) {
    assert.equal(String(text).includes(secret), false, `${label} leaked ${secret}`);
  }
}
function unzip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0);
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
  const dir = temp();
  const diagnostics = {
    app: { version: '0.25.0', note: SECRETS[0] },
    project: { name: SECRETS[5], selected: true },
    pi: { version: '0.99.1', launch: SECRETS[6] },
    nested: { authorization: SECRETS[1], apiKey: SECRETS[2], cookie: SECRETS[4], env: SECRETS[10], url: SECRETS[9] },
    compatibility: { issues: [{ operation: SECRETS[7], field: SECRETS[8] }] },
  };
  const service = createLogService({
    dir,
    version: '0.25.0',
    appRoot: path.join(__dirname, '..'),
    now: () => Date.parse('2026-10-17T12:00:00.000Z'),
    getDiagnostics: () => diagnostics,
  });
  const core = service.core;

  try {
    check('普通/详细日志只接收白名单字段，秘密与聊天正文不落盘', () => {
      core.updateSettings({ mode: 'verbose' });
      core.event('pi-bridge', 'bridge.state', {
        state: SECRETS[1], reason: SECRETS[0], bridgeRun: 1,
        message: SECRETS[7], toolOutput: SECRETS[8], url: SECRETS[9], path: SECRETS[5],
      });
      core.event('renderer', 'ui.attachment_failed', {
        kind: SECRETS[7], reason: SECRETS[8], message: SECRETS[9], env: SECRETS[10],
      });
      core.flushSync();
      for (const [name, text] of allText(dir)) noSecrets('log file ' + name, text);
    });

    check('异常 message / 原始 stack 不进崩溃文件，只保留安全错误名与自身帧', () => {
      const error = Object.assign(new Error(SECRETS[7] + ' ' + SECRETS[0]), {
        name: SECRETS[11],
        stack: `Error: ${SECRETS[7]} ${SECRETS[0]}\n    at ${SECRETS[11]} (${path.join(__dirname, '..', 'server', 'rpc-bridge.js')}:10:2)\n    at ${SECRETS[5]}`,
      });
      core.crash('pi-bridge', 'app.crash', error, { reason: SECRETS[0] });
      core.flushSync();
      for (const [name, text] of allText(dir)) noSecrets('crash file ' + name, text);
    });

    check('设置更改/清理等系统事件同样不含注入秘密', () => {
      core.updateSettings({ mode: 'standard', retentionDays: 7 });
      core.updateSettings({ maxTotalMB: 20 });
      core.flushSync();
      for (const [name, text] of allText(dir)) noSecrets('settings log ' + name, text);
    });

    await withHttp(service, async (origin) => {
      await checkAsync('Renderer HTTP 入口拒绝未知事件并把已知字段收敛', async () => {
        const response = await fetch(origin + '/api/logs/events', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: [
            {
              event: 'ui.uncaught_exception',
              details: {
                errorName: SECRETS[11], role: SECRETS[7], message: SECRETS[7],
                frames: [{ file: SECRETS[5], line: 1 }, { file: 'public/app.js', line: 2 }],
              },
              code: SECRETS[0], correlationId: SECRETS[3],
            },
            { event: 'bridge.not_real', details: { message: SECRETS[7], path: SECRETS[5] } },
            { event: 'ui.attachment_failed', details: { kind: 'image', reason: SECRETS[8], message: SECRETS[9] } },
          ] }),
        });
        const body = await response.json();
        assert.equal(body.ok, true);
        const entries = await (await fetch(origin + '/api/logs/entries?limit=100')).json();
        noSecrets('renderer entries', JSON.stringify(entries));
        const status = await (await fetch(origin + '/api/logs/status')).json();
        noSecrets('status', JSON.stringify(status));
      });

      await checkAsync('导出预览/状态不泄露日志目录或秘密', async () => {
        const preview = await (await fetch(origin + '/api/logs/export/preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ windowMinutes: 60 }),
        })).json();
        noSecrets('preview', JSON.stringify(preview));
        assert.equal(JSON.stringify(preview).includes(dir), false);
      });

      await checkAsync('ZIP 每个文件都不含注入秘密，描述也经过复核', async () => {
        const response = await fetch(origin + '/api/logs/export', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            confirm: true, windowMinutes: 60,
            description: SECRETS.join(' | ') + ' <script>alert(1)</script>',
            repro: SECRETS[8] + ' ' + SECRETS[9],
          }),
        });
        assert.equal(response.status, 200);
        const zip = unzip(Buffer.from(await response.arrayBuffer()));
        assert.deepEqual([...zip.keys()].sort(), ['README.txt', 'diagnostics.json', 'errors.jsonl', 'events.jsonl', 'report.md'].sort());
        for (const [name, text] of zip) noSecrets('zip ' + name, text);
        const diagnosticsText = zip.get('diagnostics.json');
        noSecrets('zip diagnostics', diagnosticsText);
        /* 诊断快照本身也已经被诊断层/导出层复核。 */
        const parsed = JSON.parse(diagnosticsText);
        assert.equal(parsed.nested.authorization, '[REDACTED]');
      });
    });

    check('状态/条目在最终导出前仍不含秘密', () => {
      noSecrets('final status', JSON.stringify(core.status()));
      noSecrets('final entries', JSON.stringify(core.readEntries({ limit: 200 })));
    });

    /* 符号链接：只在测试目录内尝试；Windows 权限不足时明确记为 skip。 */
    const linkDir = temp();
    const outside = path.join(linkDir, 'outside.txt');
    fs.writeFileSync(outside, SECRETS[0]);
    const link = path.join(linkDir, 'app-19990101.jsonl');
    try {
      fs.symlinkSync(outside, link);
      const linkedCore = createLogCore({ dir: linkDir, role: 'app', version: '0.25.0', appRoot: path.join(__dirname, '..') });
      check('符号链接日志文件不会被读取、清理或导出', () => {
        assert.equal(linkedCore.readEntries({ limit: 20 }).entries.length, 0);
        const preview = linkedCore.previewExport({ windowMinutes: 1440 });
        assert.equal(preview.ok, true);
        assert.equal(fs.existsSync(link), true);
      });
    } catch (error) {
      skipped++;
      console.log('  SKIP 符号链接日志文件（当前环境不能创建 symlink: ' + (error.code || 'unknown') + '）');
    }
    fs.rmSync(linkDir, { recursive: true, force: true });
  } finally {
    try { service.dispose(); } catch { /* noop */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`logging-leaks: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
