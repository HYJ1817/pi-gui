/* 日志与诊断的离线真实模块 DOM 契约。jsdom 不证明布局。
 * API fixture 依据 server/diagnostics.js、server/logging.js 与 lib/log-core.cjs；
 * 不调用 Pi、不联网、不读取用户日志，下载只捕获内存 Blob。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');

const ROOT = path.resolve(__dirname, '..');
const CODE = bundle(path.join(ROOT, 'public/logs.js')).code;
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await wait(2); }
  assert.fail('logging UI fixture did not settle');
}
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack); }
}

async function fixture() {
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'), {
    url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document;
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  const blobs = [], downloads = [], revoked = [], clipboard = [], calls = [], queued = new Map();
  w.URL.createObjectURL = blob => { blobs.push(blob); return 'blob:fixture-' + blobs.length; };
  w.URL.revokeObjectURL = url => revoked.push(url);
  w.HTMLAnchorElement.prototype.click = function () { downloads.push({ href: this.href, filename: this.download }); };
  let failStatus = false, failEntries = false, failExport = true, failClear = false, failClipboard = false;
  let settings = { enabled: true, mode: 'standard', retentionDays: 7, maxTotalMB: 20, verboseUntil: null, verboseExpired: false };
  let entries = [
    { v: 1, timestamp: '2026-10-17T11:59:00.000Z', level: 'ERROR', source: 'pi-bridge', event: 'bridge.request_timeout', code: 'BRIDGE_TIMEOUT', correlationId: 'corr-fixture-1', durationMs: 1200, process: 'backend', details: { operation: 'get_state', durationMs: 1200 }, cursor: 'c1' },
    { v: 1, timestamp: '2026-10-17T11:58:00.000Z', level: 'INFO', source: 'renderer', event: 'ui.attachment_failed', process: 'renderer', details: { kind: 'image', reason: 'upload_failed' }, cursor: 'c2' },
  ];
  const status = () => ({ ok: true, version: 1, role: 'app', appVersion: '0.35.1', ...settings,
    maxFileBytes: 1048576, dirWritable: true, degraded: false, lastErrorCode: null, writeFailures: 0,
    droppedRecords: 0, settingsCorrupt: false, usageBytes: entries.length ? 2048 : 0,
    fileCount: entries.length ? 2 : 0, crashFileCount: entries.length ? 1 : 0,
    files: entries.length ? [{ name: 'app-20261017.jsonl', role: 'app', kind: 'normal', size: 1024, date: '2026-10-17' },
      { name: 'app-crash-20261017.jsonl', role: 'app', kind: 'crash', size: 1024, date: '2026-10-17' }] : [],
    session: { runId: 'fixture-run', startedAt: '2026-10-17T12:00:00.000Z', previousUnclean: { startedAt: '2026-10-16T12:00:00.000Z' } },
    recentErrors: entries.filter(entry => ['ERROR', 'FATAL'].includes(entry.level)).slice(0, 5), clientDropped: 0,
  });
  // 使用真实诊断收集器生成并脱敏，不假设前端会替后端做第二次过滤。
  const { createDiagnostics } = await import('../server/diagnostics.js');
  const cwd = path.join(os.tmpdir(), 'pi-gui-log-ui-project');
  const dataDir = path.join(os.tmpdir(), 'pi-gui-log-ui-data');
  const home = path.join(os.tmpdir(), 'pi-gui-log-ui-home');
  const secret = 'sk-FixtureSecret012345';
  const diagnosticSnapshot = createDiagnostics({
    version: '0.35.1', dataDir, env: {}, fsApi: { accessSync() {} }, platform: 'win32', arch: 'x64', nodeVersion: 'v24.14.0',
    osApi: { type: () => 'Windows_NT', release: () => '11', homedir: () => home }, now: () => new Date('2026-10-17T12:00:00.000Z'),
    runtime: { getCurrentCwd: () => cwd }, rpc: { getState: () => ({ piRunning: false, bridgeRun: 7, args: ['--mode', 'rpc'] }) },
    piVersion: () => ({ value: '1.0.0', source: 'package.json', verification: 'verified' }),
    agentRegistry: { list: () => [{ id: 'pi', available: false, version: '1.0.0', reason: `${secret} Bearer FixtureBearerValue ${cwd} ${dataDir} ${home}`, capabilities: { rpc: null } }] },
    mcp: { readReport: () => ({ supported: null, error: 'API_KEY=' + secret }) },
  }).readSnapshot();
  const json = (value, statusCode = 200) => ({ ok: statusCode < 400, status: statusCode,
    headers: { get: () => '' }, json: async () => JSON.parse(JSON.stringify(value)), blob: async () => new w.Blob(['zip']) });
  const failure = { ok: false, code: 'fixture_failed', error: 'PRIVATE_ERROR_DETAIL', detail: 'PRIVATE_ERROR_DETAIL', reason: 'PRIVATE_ERROR_DETAIL' };
  w.fetch = async (url, opts = {}) => {
    const u = String(url), route = u.split('?')[0];
    const call = { url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null }; calls.push(call);
    const queue = queued.get(route);
    if (queue?.length) { const response = await queue.shift(); return json(response.value, response.statusCode); }
    if (route === '/api/logs/status') return json(failStatus ? failure : { ok: true, status: status() }, failStatus ? 503 : 200);
    if (route === '/api/logs/entries') return json(failEntries ? failure : { ok: true, entries, nextCursor: entries.length ? 'next' : null, truncated: entries.length > 0, scannedFiles: 2 }, failEntries ? 503 : 200);
    if (route === '/api/logs/settings') {
      settings = { ...settings, ...call.body, ...(call.body.mode === 'verbose' ? { verboseUntil: '2026-10-18T12:00:00.000Z' } : {}) };
      return json({ ok: true, status: status() });
    }
    if (route === '/api/logs/clear') { if (failClear) return json(failure, 503); entries = []; return json({ ok: true, fileCount: 2, bytes: 2048 }); }
    if (route === '/api/logs/export/preview') return json({ ok: true, windowMinutes: call.body.windowMinutes, entryCount: 123, errorCount: 4, truncated: true,
      filesIncluded: ['README.txt', 'report.md', 'diagnostics.json', 'events.jsonl', 'errors.jsonl'], files: [{ name: 'app-20261017.jsonl', kind: 'normal', size: 1024 }] });
    if (route === '/api/logs/export') {
      if (failExport) return json(failure, 503);
      return { ok: true, status: 200, headers: { get: () => 'attachment; filename="pi-gui-bugreport.zip"' }, blob: async () => new w.Blob(['zip']) };
    }
    if (route === '/api/diagnostics') return json({ ok: true, diagnostics: diagnosticSnapshot });
    throw Error('unexpected fixture URL: ' + route);
  };
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async text => { if (failClipboard) throw Error('PRIVATE_ERROR_DETAIL'); clipboard.push(text); } }, configurable: true });
  w.eval(CODE);
  return { w, d, calls, clipboard, blobs, downloads, revoked, diagnosticSnapshot, status,
    count: route => calls.filter(call => call.url.split('?')[0] === route).length,
    deferNext(route) { let resolve; const promise = new Promise(done => { resolve = done; }); const queue = queued.get(route) || []; queue.push(promise); queued.set(route, queue); return (value, statusCode = 200) => resolve({ value, statusCode }); },
    queueNext(route, value, statusCode = 200) { const queue = queued.get(route) || []; queue.push(Promise.resolve({ value, statusCode })); queued.set(route, queue); },
    close: () => dom.window.close(), setFailStatus(v) { failStatus = v; }, setFailEntries(v) { failEntries = v; }, setFailExport(v) { failExport = v; },
    setFailClear(v) { failClear = v; }, setFailClipboard(v) { failClipboard = v; }, setSettings(value) { settings = { ...settings, ...value }; }, setEntries(value) { entries = value; },
    sensitive: [secret, 'FixtureBearerValue', cwd, dataDir, home], failure,
  };
}
const tab = (f, id) => f.d.getElementById('ui5-log-tab-' + id);
const body = f => f.d.getElementById('ui5-logs-body');
const action = (f, id) => body(f).querySelector(`[data-log-action="${id}"]`);
const button = (f, label) => [...body(f).querySelectorAll('button')].find(b => b.textContent === label);
const input = (f, label) => body(f).querySelector(`[aria-label="${label}"]`);
const change = (f, control, value) => { control.value = value; control.dispatchEvent(new f.w.Event('change', { bubbles: true })); };
const type = (f, control, value) => { control.value = value; control.dispatchEvent(new f.w.Event('input', { bubbles: true })); };
const refreshEntries = f => input(f, '刷新日志列表').click();
const confirm = (f, label) => [...f.d.querySelectorAll('#confirmCard button')].find(b => b.textContent === label).click();
async function isolated(run, initialTab = 'overview') {
  const f = await fixture();
  try { f.w.openLogs({ initialTab }); await until(() => initialTab === 'overview' ? input(f, '启用本地日志') : initialTab === 'export' ? !action(f, 'copy-json').disabled : body(f).querySelector('.ui5-log-entry')); await run(f); }
  finally { f.close(); }
}

(async () => {
  const f = await fixture();
  try {
    await check('打开唯一日志与诊断页面：状态、公共设置控件、文件与最近错误；首次只查询状态一次', async () => {
      f.w.openLogs(); await until(() => input(f, '启用本地日志'));
      assert.equal(f.d.getElementById('modal').hidden, false);
      assert.match(f.d.getElementById('modalCard').textContent, /日志与诊断/);
      for (const text of ['日志状态', '正常', '最近错误与崩溃', 'app-20261017.jsonl']) assert.ok(body(f).textContent.includes(text), text);
      assert.equal(f.d.querySelector('img'), null);
      assert.equal(input(f, '启用本地日志').getAttribute('role'), 'switch');
      assert.ok(input(f, '日志级别').classList.contains('ds-select'));
      assert.equal(f.count('/api/logs/status'), 1); assert.equal(f.count('/api/logs/entries'), 0);
      tab(f, 'overview').click(); assert.equal(f.count('/api/logs/status'), 1);
    });
    await check('最近错误使用默认折叠的原生 details/summary，保留时间、详情与引用动作', () => {
      const details = body(f).querySelector('.ui5-logs-recent-error details');
      assert.equal(details.open, false); assert.ok(details.querySelector(':scope > summary time[datetime]'));
      assert.match(details.textContent, /BRIDGE_TIMEOUT/); assert.match(details.querySelector('pre').textContent, /get_state/);
      assert.ok(details.querySelector('.ui5-log-copy')); assert.ok(details.querySelector('.ui5-log-ref'));
      details.open = true; assert.equal(details.open, true);
    });
    await check('Z1-2 概览 Classic 引用显示行内成功反馈且保留草稿', () => {
      Object.assign(f.w.S, { hasProject: true, switching: false, stopping: false, submitting: false, bridgeState: 'ready' });
      const composer = f.d.getElementById('input'); composer.value = 'existing draft';
      f.d.querySelector('.ui5-log-ref').click();
      assert.match(f.d.querySelector('.ui5-logs-recent-error [role=status]').textContent, /已引用.*不会自动发送/);
      assert.match(composer.value, /^existing draft\n\n日志引用/); assert.doesNotMatch(composer.value, /get_state|corr-fixture|durationMs/);
      f.d.querySelector('.ui5-log-ref').click(); assert.equal(composer.value.split('日志引用').length, 3);
    });
    await check('Z1-2 未就绪引用显示失败，不改草稿、不新增 Toast', () => {
      const composer = f.d.getElementById('input'), before = composer.value, toasts = f.d.getElementById('toasts').childElementCount;
      f.w.S.bridgeState = 'disconnected'; f.d.querySelector('.ui5-log-ref').click();
      assert.match(f.d.querySelector('.ui5-logs-recent-error [role=status]').textContent, /尚未就绪.*复制/);
      assert.equal(composer.value, before); assert.equal(f.d.getElementById('toasts').childElementCount, toasts); f.w.S.bridgeState = 'ready';
    });
    await check('Z1-2 Runtime 引用只填当前 owner 的输入框并显示反馈', () => {
      f.w.showRuntimeConversation(); f.w.setGitConversationScope('A');
      f.w.runtimeStore.seed({ backendInstance: 'fixture', items: [{ conversationId: 'A', owner: { backendInstance: 'fixture', conversationId: 'A', runtimeId: 'ra', runtimeGeneration: '1', sessionId: 'sa' }, lifecycle: 'ready' }] });
      f.d.getElementById('runtimeView').innerHTML = '<section class="runtime-conversation" data-conversation-id="A"><textarea aria-label="给当前会话的任务">runtime draft</textarea></section>';
      const classic = f.d.getElementById('input').value; f.d.querySelector('.ui5-log-ref').click();
      assert.match(f.d.querySelector('#runtimeView textarea').value, /^runtime draft\n\n日志引用/);
      assert.equal(f.d.getElementById('input').value, classic); assert.match(f.d.querySelector('.ui5-logs-recent-error [role=status]').textContent, /已引用/);
    });
    await check('Z1-2 Runtime 身份不匹配与未就绪均显示拒绝反馈', () => {
      const root = f.d.querySelector('.runtime-conversation'), composer = root.querySelector('textarea'), before = composer.value;
      root.dataset.conversationId = 'B'; f.d.querySelector('.ui5-log-ref').click();
      assert.match(f.d.querySelector('.ui5-logs-recent-error [role=status]').textContent, /身份不一致/); assert.equal(composer.value, before);
      root.dataset.conversationId = 'A'; f.w.runtimeStore.get('A').item.lifecycle = 'starting'; f.d.querySelector('.ui5-log-ref').click();
      assert.match(f.d.querySelector('.ui5-logs-recent-error [role=status]').textContent, /未就绪/); assert.equal(composer.value, before);
      f.w.setGitConversationScope(null); f.w.showChat(); assert.ok(!f.calls.some(c => /prompt|steer|follow.up|command|execute/.test(c.url)));
    });
    await check('设置修改走白名单 API，模式与截止时间以返回状态为准', async () => {
      change(f, input(f, '日志级别'), 'verbose'); await until(() => !input(f, '日志级别').disabled);
      assert.deepEqual(f.calls.find(c => c.url === '/api/logs/settings').body, { mode: 'verbose' });
      assert.equal(input(f, '日志级别').value, 'verbose'); assert.match(body(f).textContent, /详细模式截止/);
    });
    await check('首次进入日志查看恰一次查询，同标签重选不重复；级别/来源/搜索与分页均发送准确参数', async () => {
      tab(f, 'logs').click(); await until(() => body(f).querySelector('.ui5-log-entry'));
      assert.equal(f.count('/api/logs/entries'), 1); tab(f, 'logs').click(); await wait(); assert.equal(f.count('/api/logs/entries'), 1);
      change(f, input(f, '按级别筛选'), 'ERROR'); await until(() => body(f).querySelector('.ui5-log-entry'));
      change(f, input(f, '按来源筛选'), 'pi-bridge'); await until(() => body(f).querySelector('.ui5-log-entry'));
      type(f, input(f, '搜索日志'), 'request'); await wait(280); await until(() => !body(f).querySelector('.ui5-logs-list').getAttribute('aria-busy') || body(f).querySelector('.ui5-logs-list').getAttribute('aria-busy') === 'false');
      const query = new URL(f.calls.filter(c => c.url.startsWith('/api/logs/entries')).at(-1).url, 'http://fixture.invalid').searchParams;
      assert.equal(query.get('level'), 'ERROR'); assert.equal(query.get('source'), 'pi-bridge'); assert.equal(query.get('q'), 'request');
      assert.match(body(f).querySelector('.ui5-logs-list').textContent, /bridge\.request_timeout/);
      button(f, '加载更早日志').click(); await until(() => f.calls.at(-1).url.includes('cursor=next'));
      assert.equal(new URL(f.calls.at(-1).url, 'http://fixture.invalid').searchParams.get('cursor'), 'next');
    });
    await check('恶意 HTML 与长中文只作为文本呈现', async () => {
      f.setEntries([{ v: 1, timestamp: '2026-10-17T11:59:00.000Z', level: 'ERROR', source: '<img src=x onerror="window.__xss=1">', event: '<script>alert(1)</script>', process: 'renderer', cursor: 'x', details: { reason: '<b>not-html</b>', note: '很长的中文日志说明'.repeat(30) } }]);
      refreshEntries(f); await until(() => body(f).querySelector('.ui5-logs-list').textContent.includes('<script>'));
      const list = body(f).querySelector('.ui5-logs-list'); assert.equal(list.querySelector('img,script,b'), null); assert.equal(f.w.__xss, undefined);
      assert.ok(list.textContent.includes('很长的中文日志说明'.repeat(30)));
    });
    await check('成功空结果与读取失败分开，错误为固定文案且无 detail 泄露', async () => {
      f.setEntries([]); refreshEntries(f); await until(() => body(f).querySelector('.ui5-logs-list').textContent.includes('没有'));
      assert.match(body(f).querySelector('.ui5-logs-list').textContent, /没有.*日志/);
      f.setFailEntries(true); refreshEntries(f); await until(() => body(f).querySelector('.ui5-logs-list').textContent.includes('读取失败'));
      assert.doesNotMatch(body(f).textContent, /PRIVATE_ERROR_DETAIL/);
    });
    await check('清理日志二次确认写明不可撤销，取消不发请求且恢复操作', async () => {
      tab(f, 'overview').click(); button(f, '清理日志…').click(); await until(() => !f.d.getElementById('confirmLayer').hidden);
      assert.match(f.d.getElementById('confirmCard').textContent, /设置不会被删除.*不能撤销/);
      confirm(f, '取消'); await until(() => !button(f, '清理日志…').disabled); assert.equal(f.count('/api/logs/clear'), 0);
    });
    await check('导出先预览清单与安全截断，再确认；失败固定提示并可复制唯一诊断摘要', async () => {
      tab(f, 'export').click(); await until(() => !action(f, 'copy-summary').disabled);
      assert.equal(button(f, '确认导出 ZIP').disabled, true); assert.equal(f.count('/api/logs/export'), 0);
      assert.match(body(f).textContent, /不自动上传.*不含聊天/);
      button(f, '预览摘要').click(); await until(() => !button(f, '确认导出 ZIP').disabled);
      assert.equal(f.count('/api/logs/export/preview'), 1); assert.match(body(f).querySelector('.ui5-logs-preview').textContent, /123.*4.*截断/);
      assert.match(body(f).querySelector('.ui5-logs-preview').textContent, /errors\.jsonl/);
      button(f, '确认导出 ZIP').click(); await until(() => body(f).querySelector('.ui5-logs-preview').textContent.includes('未能生成'));
      assert.equal(f.count('/api/logs/export'), 1); assert.equal(f.downloads.length, 0); assert.doesNotMatch(body(f).textContent, /PRIVATE_ERROR_DETAIL/);
      action(f, 'copy-summary').click(); await until(() => f.clipboard.length > 0);
      assert.match(f.clipboard.at(-1), /Pi GUI 诊断摘要/); assert.doesNotMatch(f.clipboard.at(-1), /USER_CHAT_BODY/);
      assert.equal(body(f).querySelectorAll('[data-log-action="copy-summary"]').length, 1);
    });
  } finally { f.close(); }

  await check('直接以日志标签打开也只查询一次；Tab ARIA 关联、单停靠点和键盘循环同步', () => isolated(async f => {
    assert.equal(f.count('/api/logs/entries'), 1); assert.equal(f.count('/api/logs/status'), 0);
    const verify = id => {
      assert.equal(body(f).getAttribute('aria-labelledby'), tab(f, id).id);
      for (const key of ['overview', 'logs', 'export']) {
        assert.equal(tab(f, key).getAttribute('aria-selected'), String(key === id));
        assert.equal(tab(f, key).tabIndex, key === id ? 0 : -1);
        assert.equal(tab(f, key).getAttribute('aria-controls'), body(f).id);
      }
    };
    verify('logs'); tab(f, 'logs').click(); assert.equal(f.count('/api/logs/entries'), 1);
    const key = (value, id) => { const event = new f.w.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }); f.d.activeElement.dispatchEvent(event); assert.equal(event.defaultPrevented, true); verify(id); assert.equal(f.d.activeElement, tab(f, id)); };
    tab(f, 'logs').focus(); key('ArrowRight', 'export'); key('ArrowRight', 'overview'); key('ArrowLeft', 'export'); key('Home', 'overview'); key('End', 'export');
    const event = new f.w.KeyboardEvent('keydown', { key: 'ArrowLeft', ctrlKey: true, bubbles: true, cancelable: true }); tab(f, 'export').dispatchEvent(event);
    assert.equal(event.defaultPrevented, false); verify('export');
  }, 'logs'));

  await check('本地日志开关保存期间禁用控件并去重，以权威响应而非乐观值重绘', () => isolated(async f => {
    const finish = f.deferNext('/api/logs/settings'), toggle = input(f, '启用本地日志'); toggle.focus(); toggle.click(); toggle.click();
    assert.equal(f.count('/api/logs/settings'), 1); assert.equal(toggle.disabled, true);
    assert.ok([...body(f).querySelectorAll('.ui5-logs-settings button, .ui5-logs-settings select')].every(control => control.disabled));
    assert.deepEqual(f.calls.find(c => c.url === '/api/logs/settings').body, { enabled: false });
    finish({ ok: true, status: { ...f.status(), enabled: true } }); await until(() => !input(f, '启用本地日志').disabled);
    assert.equal(input(f, '启用本地日志').getAttribute('aria-checked'), 'true'); assert.equal(f.d.activeElement, input(f, '启用本地日志'));
    input(f, '启用本地日志').click(); await until(() => !input(f, '启用本地日志').disabled);
    assert.equal(input(f, '启用本地日志').getAttribute('aria-checked'), 'false'); assert.equal(input(f, '日志级别').disabled, true);
    change(f, input(f, '保留天数'), '14'); await until(() => !input(f, '保留天数').disabled);
    change(f, input(f, '空间上限'), '50'); await until(() => !input(f, '空间上限').disabled);
    assert.deepEqual(f.calls.filter(c => c.url === '/api/logs/settings').map(c => c.body), [{ enabled: false }, { enabled: false }, { retentionDays: 14 }, { maxTotalMB: 50 }]);
  }));

  await check('设置失败回读权威状态，持久化可能成功也不声称保存，固定提示不泄露 detail', () => isolated(async f => {
    f.queueNext('/api/logs/settings', f.failure, 503); f.setSettings({ retentionDays: 14 });
    change(f, input(f, '保留天数'), '3'); await until(() => body(f).textContent.includes('未能确认保存') && !input(f, '保留天数').disabled);
    assert.equal(f.count('/api/logs/status'), 2); assert.equal(input(f, '保留天数').value, '14');
    assert.doesNotMatch(body(f).textContent, /PRIVATE_ERROR_DETAIL|已保存/);
  }));

  await check('状态刷新失败保留已有权威状态，固定提示且可重试', () => isolated(async f => {
    f.setFailStatus(true); input(f, '刷新日志状态').click(); await until(() => body(f).textContent.includes('无法读取日志状态'));
    assert.equal(input(f, '启用本地日志').getAttribute('aria-checked'), 'true'); assert.doesNotMatch(body(f).textContent, /PRIVATE_ERROR_DETAIL/);
    f.setFailStatus(false); input(f, '刷新日志状态').click(); await until(() => !body(f).textContent.includes('无法读取日志状态'));
  }));

  await check('首次状态失败显示未知而非关闭，保留刷新入口且成功后恢复公共控件', async () => {
    const f = await fixture();
    try {
      f.setFailStatus(true); f.w.openLogs(); await until(() => body(f).textContent.includes('日志状态未知'));
      assert.equal(f.count('/api/logs/status'), 1); assert.equal(input(f, '启用本地日志'), null);
      assert.match(body(f).textContent, /无法读取日志状态，请重试。/); assert.doesNotMatch(body(f).textContent, /PRIVATE_ERROR_DETAIL|日志关闭/);
      assert.equal(input(f, '刷新日志状态').disabled, false); f.setFailStatus(false); input(f, '刷新日志状态').click();
      await until(() => input(f, '启用本地日志')); assert.equal(input(f, '启用本地日志').getAttribute('aria-checked'), 'true');
    } finally { f.close(); }
  });

  await check('日志请求切页后与旧筛选响应均失效，搜索立即作废旧响应且切页取消防抖', () => isolated(async f => {
    const finish = f.deferNext('/api/logs/entries'); tab(f, 'logs').click(); tab(f, 'export').click(); await until(() => !action(f, 'copy-json').disabled);
    const before = body(f).textContent; finish({ ok: true, entries: [{ timestamp: '2026-10-17T12:00:00Z', level: 'ERROR', event: 'STALE_LOG_MARKER' }] }); await wait();
    assert.equal(body(f).textContent, before); tab(f, 'logs').click(); await until(() => body(f).querySelector('.ui5-log-entry'));
    const old = f.deferNext('/api/logs/entries'); refreshEntries(f); type(f, input(f, '搜索日志'), 'new query');
    old({ ok: true, entries: [{ timestamp: '2026-10-17T12:00:00Z', level: 'ERROR', event: 'STALE_FILTER_MARKER' }] }); await wait();
    assert.doesNotMatch(body(f).textContent, /STALE_FILTER_MARKER/);
    const count = f.count('/api/logs/entries'); tab(f, 'overview').click(); await wait(280); assert.equal(f.count('/api/logs/entries'), count);
  }));

  await check('设置迟到响应不替换新标签或抢焦点，返回概览使用权威状态', () => isolated(async f => {
    const finish = f.deferNext('/api/logs/settings'); change(f, input(f, '保留天数'), '3');
    tab(f, 'logs').click(); await until(() => body(f).querySelector('.ui5-log-entry')); input(f, '搜索日志').focus();
    const search = input(f, '搜索日志'); finish({ ok: true, status: { ...f.status(), retentionDays: 14 } }); await wait();
    assert.equal(f.d.activeElement, search); assert.equal(tab(f, 'logs').getAttribute('aria-selected'), 'true');
    tab(f, 'overview').click(); assert.equal(input(f, '保留天数').value, '14');
  }));

  await check('清理确认成功只发 confirm:true 一次，回读状态并移除旧条目', () => isolated(async f => {
    const before = f.count('/api/logs/status'); button(f, '清理日志…').click(); await until(() => !f.d.getElementById('confirmLayer').hidden);
    assert.equal(f.count('/api/logs/clear'), 0); confirm(f, '清理日志'); await until(() => !button(f, '清理日志…').disabled && f.count('/api/logs/status') === before + 1);
    assert.deepEqual(f.calls.find(c => c.url === '/api/logs/clear').body, { confirm: true }); assert.equal(f.count('/api/logs/clear'), 1);
    assert.equal(f.d.getElementById('confirmLayer').hidden, true); assert.match(body(f).textContent, /最近没有错误/); assert.match(body(f).textContent, /尚无日志文件/);
    // 普通成功 toast 按共享通知政策抑制；以清理后的权威状态证明结果。
    assert.doesNotMatch(body(f).textContent, /未能清理/); assert.equal(f.status().fileCount, 0);
  }));

  await check('清理失败保留权威文件与错误状态，固定权限提示、不出现成功反馈', () => isolated(async f => {
    f.setFailClear(true); button(f, '清理日志…').click(); await until(() => !f.d.getElementById('confirmLayer').hidden); confirm(f, '清理日志');
    await until(() => body(f).textContent.includes('未能清理') && !button(f, '清理日志…').disabled);
    assert.equal(f.count('/api/logs/status'), 2); assert.match(body(f).textContent, /app-20261017\.jsonl/);
    assert.doesNotMatch(body(f).textContent + f.d.getElementById('toasts').textContent, /PRIVATE_ERROR_DETAIL|已删除/);
  }));

  await check('统一诊断摘要、JSON 复制与下载共享真实后端脱敏快照，下载释放 Blob URL', () => isolated(async f => {
    action(f, 'copy-summary').click(); await until(() => f.clipboard.length === 1);
    assert.equal(f.clipboard[0], f.w.buildDiagnosticSummary(f.diagnosticSnapshot, [], f.status()));
    action(f, 'copy-json').click(); await until(() => f.clipboard.length === 2);
    assert.deepEqual(JSON.parse(f.clipboard[1]), f.diagnosticSnapshot);
    action(f, 'export-json').click(); await until(() => f.downloads.length === 1 && f.revoked.length === 1);
    assert.equal(f.downloads[0].filename, 'pi-gui-diagnostics.json'); assert.equal(f.blobs[0].type, 'application/json;charset=utf-8');
    const text = await new Promise((resolve, reject) => { const reader = new f.w.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(f.blobs[0]); });
    assert.equal(text, f.clipboard[1]); assert.equal(f.downloads[0].href, f.revoked[0]);
    for (const value of [...f.clipboard, text]) for (const secret of f.sensitive) assert.ok(!value.includes(secret), 'redaction must survive all export paths');
    assert.match(f.clipboard[1], /\[REDACTED\]/); assert.match(f.clipboard[0], /隐私:/);
    assert.equal(body(f).querySelectorAll('[data-log-action="copy-summary"]').length, 1); assert.equal(f.count('/api/diagnostics'), 1);
    assert.equal(body(f).querySelector('.update-sec, .cap-install'), null);
  }, 'export'));

  await check('复制失败提供手选 JSON 的固定降级提示，不泄露异常正文', () => isolated(async f => {
    f.setFailClipboard(true); action(f, 'copy-json').click(); await until(() => body(f).textContent.includes('复制失败'));
    assert.match(body(f).textContent, /展开诊断 JSON 手工选中/); assert.doesNotMatch(body(f).textContent, /PRIVATE_ERROR_DETAIL/); assert.equal(f.clipboard.length, 0);
  }, 'export'));

  await check('诊断失败不会冒充快照且可刷新，独立 ZIP 仍可预览，原始错误不显示', () => isolated(async f => {
    f.queueNext('/api/diagnostics', f.failure, 500); input(f, '刷新诊断快照').click(); await until(() => body(f).textContent.includes('无法读取诊断快照'));
    for (const id of ['copy-summary', 'copy-json', 'export-json']) assert.equal(action(f, id).disabled, true);
    assert.doesNotMatch(body(f).textContent, /PRIVATE_ERROR_DETAIL/); button(f, '预览摘要').click(); await until(() => !button(f, '确认导出 ZIP').disabled);
    input(f, '刷新诊断快照').click(); await until(() => !action(f, 'copy-json').disabled); assert.equal(f.count('/api/diagnostics'), 3);
  }, 'export'));

  await check('ZIP 时间范围变动使在途预览失效，重新预览后仅导出确认范围与草稿', () => isolated(async f => {
    const finish = f.deferNext('/api/logs/export/preview'); button(f, '预览摘要').click(); button(f, '预览摘要').click();
    assert.equal(f.count('/api/logs/export/preview'), 1); change(f, input(f, '故障报告时间范围'), '120');
    finish({ ok: true, windowMinutes: 30, entryCount: 999, errorCount: 999, filesIncluded: ['OLD_RANGE_MARKER'] }); await wait();
    assert.equal(button(f, '确认导出 ZIP').disabled, true); assert.doesNotMatch(body(f).textContent, /OLD_RANGE_MARKER|999/);
    type(f, input(f, '问题描述'), 'fixture issue'); type(f, input(f, '复现步骤'), 'fixture repro');
    button(f, '预览摘要').click(); await until(() => !button(f, '确认导出 ZIP').disabled);
    assert.deepEqual(f.calls.filter(c => c.url === '/api/logs/export/preview').at(-1).body, { windowMinutes: 120 });
    change(f, input(f, '故障报告时间范围'), '1440'); assert.equal(button(f, '确认导出 ZIP').disabled, true);
    button(f, '预览摘要').click(); await until(() => !button(f, '确认导出 ZIP').disabled);
    const exported = f.deferNext('/api/logs/export'); f.setFailExport(false); button(f, '确认导出 ZIP').click(); button(f, '确认导出 ZIP').click();
    assert.equal(f.count('/api/logs/export'), 1); assert.equal(input(f, '故障报告时间范围').disabled, true);
    assert.deepEqual(f.calls.find(c => c.url === '/api/logs/export').body, { confirm: true, windowMinutes: 1440, description: 'fixture issue', repro: 'fixture repro' });
    // 让 API 的失败响应恢复按钮，再验证真正成功下载（字节由 fixture 提供）。
    exported(f.failure, 503); await until(() => !button(f, '确认导出 ZIP').disabled);
    button(f, '确认导出 ZIP').click(); await until(() => f.downloads.length === 1);
    assert.equal(f.downloads[0].filename, 'pi-gui-bugreport.zip'); assert.equal(f.count('/api/logs/export'), 2);
  }, 'export'));

  await check('导出草稿与已读诊断跨标签保留，预览授权不跨挂载复用，迟到预览不能污染新页', () => isolated(async f => {
    type(f, input(f, '问题描述'), 'persist issue'); type(f, input(f, '复现步骤'), 'persist repro'); change(f, input(f, '故障报告时间范围'), '120');
    const finish = f.deferNext('/api/logs/export/preview'); button(f, '预览摘要').click(); tab(f, 'overview').click();
    finish({ ok: true, entryCount: 999, filesIncluded: ['STALE_PREVIEW_MARKER'] }); await wait();
    tab(f, 'export').click(); assert.equal(input(f, '问题描述').value, 'persist issue'); assert.equal(input(f, '复现步骤').value, 'persist repro');
    assert.equal(input(f, '故障报告时间范围').value, '120'); assert.equal(f.count('/api/diagnostics'), 1);
    assert.equal(button(f, '确认导出 ZIP').disabled, true); assert.doesNotMatch(body(f).textContent, /STALE_PREVIEW_MARKER|999/);
    button(f, '预览摘要').click(); await until(() => !button(f, '确认导出 ZIP').disabled);
    tab(f, 'logs').click(); tab(f, 'export').click(); assert.equal(button(f, '确认导出 ZIP').disabled, true);
  }, 'export'));

  await check('诊断与摘要的迟到读取在切页后无 DOM 或剪贴板副作用', () => isolated(async f => {
    const finish = f.deferNext('/api/diagnostics'); input(f, '刷新诊断快照').click(); tab(f, 'logs').click(); await until(() => body(f).querySelector('.ui5-log-entry'));
    const before = body(f).textContent; finish({ ok: true, diagnostics: { ...f.diagnosticSnapshot, app: { version: 'STALE_DIAGNOSTIC_MARKER' } } }); await wait();
    assert.equal(body(f).textContent, before); tab(f, 'export').click(); assert.doesNotMatch(body(f).textContent, /STALE_DIAGNOSTIC_MARKER/);
    const status = f.deferNext('/api/logs/status'); action(f, 'copy-summary').click(); tab(f, 'logs').click(); status({ ok: true, status: f.status() }); await wait();
    assert.equal(f.clipboard.length, 0);
  }, 'export'));

  await check('销毁日志页面后迟到查询不重绘或恢复旧页面', async () => {
    const f = await fixture();
    try {
      let dispose; const card = f.d.createElement('div'); f.d.body.append(card);
      const finish = f.deferNext('/api/logs/status'); f.w.openLogs({ present(build, close) { dispose = close; build(card); } });
      const before = card.textContent; dispose(); card.remove(); finish({ ok: true, status: f.status() }); await wait();
      assert.equal(card.textContent, before); assert.equal(f.d.querySelector('.ui5-logs-summary'), null); assert.equal(f.d.getElementById('modal').hidden, true);
    } finally { f.close(); }
  });
  console.log(`logging-ui: ${passed} passed, ${failed} failed, 0 skipped`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
