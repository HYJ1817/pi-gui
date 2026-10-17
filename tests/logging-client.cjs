/* UI-5 补丁：Renderer 日志客户端的断线恢复。
 *
 * 旧实现任何一次网络失败都会把 failing 永久置 true，之后所有事件被丢弃。
 * 这里用 jsdom + 假时钟验证：暂时失败后退避恢复、连续失败、后端重启、
 * 队列上限、日志关闭、不可恢复错误、页面重载，以及恢复后的事件真实落盘
 * 并进入 ZIP。所有写操作都在 os.tmpdir()。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');
const { createLogService } = require('../server/logging.js');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const waitReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (error) { failed++; console.error('  FAIL ' + name + ': ' + error.message); }
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
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
    const commentLen = buffer.readUInt32LE(cursor + 32);
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

/** jsdom + 可控时钟。fetchImpl 可以是 mock，也可以代理到真实本地服务。 */
function fixture(fetchImpl = null) {
  const dom = new JSDOM(HTML, { url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  let clock = 0, seq = 0;
  const timers = new Map();
  const requests = [];
  const accepted = [];
  let mode = 'success';

  w.setTimeout = (fn, ms = 0, ...args) => {
    const id = ++seq;
    timers.set(id, { at: clock + Math.max(0, Number(ms) || 0), fn, args });
    return id;
  };
  w.clearTimeout = (id) => { timers.delete(id); };
  Object.defineProperty(w.Date, 'now', { value: () => clock, configurable: true });

  w.fetch = async (url, opts = {}) => {
    assert.equal(String(url), '/api/logs/events', '日志客户端不应请求其它地址');
    const body = JSON.parse(opts.body || '{}');
    requests.push({ at: clock, events: body.events || [] });
    if (fetchImpl) return fetchImpl(url, opts, body);
    if (mode === 'network') throw new w.Error('offline');
    if (mode === '503') return response(503, { ok: false, code: 'unavailable' });
    if (mode === 'disabled') return response(200, { ok: true, accepted: 0, disabled: true });
    if (mode === '400') return response(400, { ok: false, code: 'invalid_events' });
    if (mode === 'invalid') return response(200, { hello: 'world' });
    accepted.push(...(body.events || []));
    return response(200, { ok: true, accepted: (body.events || []).length });
  };

  async function settle() {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  async function advance(ms) {
    const target = clock + Math.max(0, ms);
    for (;;) {
      let dueId = null, due = null;
      for (const [id, timer] of timers) {
        if (timer.at <= target && (!due || timer.at < due.at)) { dueId = id; due = timer; }
      }
      if (!due) break;
      timers.delete(dueId);
      clock = due.at;
      due.fn(...due.args);
      await settle();
    }
    clock = target;
    await settle();
  }

  w.eval(bundle(path.join(ROOT, 'public/log-client.js')).code);
  return {
    w, requests, advance,
    setMode: (value) => { mode = value; },
    delivered: () => accepted,
    close: () => dom.window.close(),
  };
}

function event(action, reason = 'probe') {
  return ['ui.action_failed', { action, reason }, {}];
}

async function main() {
  console.log('=== Renderer 日志断线恢复 ===');

  await check('暂时网络失败：只丢已发出未确认的批次，退避后恢复并补报丢弃计数', async () => {
    const f = fixture();
    try {
      f.setMode('network');
      f.w.logRendererEvent(...event('first', 'network'));
      await f.advance(1300);
      let snap = f.w.rendererLogSnapshot();
      assert.equal(snap.failing, true);
      assert.equal(snap.queued, 0);
      assert.ok(snap.dropped >= 1);
      assert.equal(f.requests.length, 1);

      f.setMode('success');
      f.w.logRendererEvent(...event('second', 'ok'));
      await f.advance(1500);
      snap = f.w.rendererLogSnapshot();
      assert.equal(snap.failing, false);
      assert.equal(snap.failures, 0);
      const delivered = f.delivered();
      assert.ok(delivered.some((e) => e.details?.action === 'second'), '恢复后的事件没有送达');
      assert.equal(delivered.some((e) => e.details?.action === 'first'), false, '未确认的批次被重放');

      await f.advance(2000);
      const report = f.delivered().find((e) => e.event === 'logs.client_degraded');
      assert.ok(report, '没有补报降级计数');
      assert.ok(report.details.count >= 1);
      assert.ok(report.details.failures >= 1);
      assert.equal(JSON.stringify(report).includes('offline'), false);
    } finally { f.close(); }
  });

  await check('连续网络失败：退避有上限，队列空时不发请求', async () => {
    const f = fixture();
    try {
      f.setMode('network');
      f.w.logRendererEvent(...event('seed', 'network'));
      await f.advance(1300);
      assert.equal(f.requests.length, 1);

      const delays = [1000, 2000, 4000, 8000, 16000, 30000];
      for (let i = 0; i < delays.length; i++) {
        f.w.logRendererEvent(...event('f' + i, 'network'));
        const before = f.requests.length;
        await f.advance(delays[i]);
        assert.equal(f.requests.length, before + 1, `第 ${i + 1} 次重试没有按预期发生`);
      }
      const times = f.requests.map((r) => r.at);
      const gaps = times.slice(1).map((t, i) => t - times[i]);
      /* 第一次请求由 FLUSH_MS 触发；之后每次重试间隔应严格递增并封顶。 */
      assert.deepEqual(gaps, [1000, 2000, 4000, 8000, 16000, 30000]);

      /* 队列空时，即使退避计时器到期也不应产生请求。 */
      const count = f.requests.length;
      await f.advance(120000);
      assert.equal(f.requests.length, count, '队列为空时仍在请求后端');

      const snap = f.w.rendererLogSnapshot();
      assert.equal(snap.queued, 0);
      assert.equal(snap.sending, false);
    } finally { f.close(); }
  });

  await check('队列达到上限：保留最新事件、丢弃最旧事件并保持有界', async () => {
    const f = fixture();
    try {
      f.setMode('network');
      f.w.logRendererEvent(...event('seed', 'network'));
      await f.advance(1300);
      const beforeDrop = f.w.rendererLogSnapshot().dropped;
      for (let i = 0; i < 80; i++) f.w.logRendererEvent(...event('q' + String(i).padStart(3, '0'), 'cap'));
      const snap = f.w.rendererLogSnapshot();
      assert.equal(snap.queued, 40);
      assert.ok(snap.dropped - beforeDrop >= 40);
      assert.equal(f.requests.length, 1, '队列溢出不应触发额外请求');

      f.setMode('success');
      await f.advance(120000);
      const actions = f.delivered().filter((e) => e.details?.action?.startsWith('q')).map((e) => e.details.action);
      assert.ok(actions.length <= 40, '发送量超过队列上限');
      assert.ok(actions.includes('q079'), '最新事件没有被保留');
      assert.equal(actions.includes('q000'), false, '最旧事件没有被丢弃');
    } finally { f.close(); }
  });

  await check('日志被用户关闭：停止上报，重新启用后新事件恢复', async () => {
    const f = fixture();
    try {
      f.setMode('disabled');
      f.w.logRendererEvent(...event('while_disabled', 'disabled'));
      await f.advance(1300);
      let snap = f.w.rendererLogSnapshot();
      assert.equal(snap.suspended, true);
      assert.equal(snap.queued, 0);
      const dropped = snap.dropped;
      assert.equal(f.w.logRendererEvent(...event('still_disabled', 'disabled')), false);
      assert.ok(f.w.rendererLogSnapshot().dropped > dropped);

      f.setMode('success');
      f.w.setRendererLoggingEnabled(true);
      f.w.logRendererEvent(...event('after_enable', 'ok'));
      await f.advance(2000);
      snap = f.w.rendererLogSnapshot();
      assert.equal(snap.suspended, false);
      assert.ok(f.delivered().some((e) => e.details?.action === 'after_enable'));
    } finally { f.close(); }
  });

  await check('不可恢复错误：停止重试；显式恢复后才重新尝试', async () => {
    const f = fixture();
    try {
      f.setMode('400');
      f.w.logRendererEvent(...event('invalid', 'bad_request'));
      await f.advance(1300);
      let snap = f.w.rendererLogSnapshot();
      assert.equal(snap.stopped, true);
      assert.equal(f.requests.length, 1);
      assert.equal(f.w.logRendererEvent(...event('after_stop', 'bad_request')), false);
      await f.advance(120000);
      assert.equal(f.requests.length, 1, '不可恢复错误仍在重试');

      f.setMode('success');
      f.w.setRendererLoggingEnabled(true);
      f.w.logRendererEvent(...event('after_reset', 'ok'));
      await f.advance(2000);
      snap = f.w.rendererLogSnapshot();
      assert.equal(snap.stopped, false);
      assert.ok(f.delivered().some((e) => e.details?.action === 'after_reset'));
    } finally { f.close(); }
  });

  await check('无效 200 响应按不可恢复处理，不无限重试', async () => {
    const f = fixture();
    try {
      f.setMode('invalid');
      f.w.logRendererEvent(...event('invalid_response', 'bad_response'));
      await f.advance(1300);
      const snap = f.w.rendererLogSnapshot();
      assert.equal(snap.stopped, true);
      assert.equal(f.requests.length, 1);
      await f.advance(120000);
      assert.equal(f.requests.length, 1);
    } finally { f.close(); }
  });

  await check('页面重新加载：新的客户端不继承旧的失败状态', async () => {
    const first = fixture();
    try {
      first.setMode('network');
      first.w.logRendererEvent(...event('before_reload', 'network'));
      await first.advance(1300);
      assert.equal(first.w.rendererLogSnapshot().failing, true);
    } finally { first.close(); }

    const second = fixture();
    try {
      second.w.logRendererEvent(...event('after_reload', 'ok'));
      await second.advance(1300);
      assert.equal(second.w.rendererLogSnapshot().failing, false);
      assert.ok(second.delivered().some((e) => e.details?.action === 'after_reload'));
    } finally { second.close(); }
  });

  await check('后端重启：恢复后的事件真实落盘并进入 ZIP，断线期间批次不重放', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-log-client-'));
    let origin = '';
    let server = null;
    let service = null;

    async function start(tag) {
      service = createLogService({
        dir, version: '0.25.0', appRoot: ROOT,
        getDiagnostics: () => null,
      });
      const srv = http.createServer((req, res) => {
        Promise.resolve(service.handle(req, res, new URL(req.url, 'http://127.0.0.1'))).catch(() => {
          if (!res.writableEnded) res.writeHead(500).end();
        });
      });
      await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
      server = srv;
      origin = `http://127.0.0.1:${srv.address().port}`;
      return { tag, origin };
    }

    async function stop() {
      if (server) await new Promise((resolve) => server.close(resolve));
      server = null;
      service = null;
    }

    const f = fixture(async (url, opts) => {
      const response = await fetch(origin + url, opts);
      return response;
    });
    try {
      await start('first');
      f.w.logRendererEvent(...event('before_outage', 'ok'));
      await f.advance(1300);
      await waitReal(400);
      let snap = f.w.rendererLogSnapshot();
      assert.equal(snap.failing, false, '首次上报失败：' + JSON.stringify(snap));
      assert.equal(snap.queued, 0);

      const firstService = service;
      await stop();
      firstService.dispose();

      /* 后端已关闭：这次请求会得到连接失败。 */
      f.w.logRendererEvent(...event('during_outage', 'network'));
      await f.advance(1300);
      await waitReal(300);
      snap = f.w.rendererLogSnapshot();
      assert.equal(snap.failing, true, '断线没有被识别：' + JSON.stringify(snap));

      await start('second');
      f.w.logRendererEvent(...event('recovered', 'ok'));
      await f.advance(60000);
      await waitReal(500);
      /* 成功后的降级计数事件还要再等一个 FLUSH_MS；补一次假时钟推进。 */
      await f.advance(3000);
      await waitReal(400);
      snap = f.w.rendererLogSnapshot();
      assert.equal(snap.failing, false, '后端重启后没有恢复：' + JSON.stringify(snap));

      service.core.flushSync();
      const entries = service.core.readEntries({ limit: 200 }).entries;
      const actions = entries.filter((e) => e.event === 'ui.action_failed').map((e) => e.details?.action);
      assert.ok(actions.includes('recovered'), '恢复后的事件没有落盘：' + JSON.stringify(actions));
      assert.equal(actions.includes('during_outage'), false, '断线期间未确认的批次被重放');
      assert.ok(entries.some((e) => e.event === 'logs.client_degraded'), '缺下降级计数事件');

      const zip = unzip(service.core.buildExport({ windowMinutes: 1440 }).buffer);
      const eventsText = zip.get('events.jsonl');
      assert.match(eventsText, /"action":"recovered"/);
      assert.equal(eventsText.includes('during_outage'), false);
    } finally {
      f.close();
      if (server) await new Promise((resolve) => server.close(resolve));
      if (service) { try { service.dispose(); } catch { /* noop */ } }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(`logging-client: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
