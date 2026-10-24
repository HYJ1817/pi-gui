/* UI-5：日志管理界面的离线 DOM 契约。jsdom 不证明布局，只证明真实模块的事件、
 * 文本安全、过滤/分页、设置、清理确认和导出降级路径。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');

const ROOT = path.resolve(__dirname, '..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}

function fixture() {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.URL.createObjectURL = () => 'blob:fixture';
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { this._clicked = true; };
  const calls = [];
  const now = new Date('2026-10-17T12:00:00.000Z');
  let settings = { enabled: true, mode: 'standard', retentionDays: 7, maxTotalMB: 20, verboseUntil: null, verboseExpired: false };
  let entries = [
    { v: 1, timestamp: '2026-10-17T11:59:00.000Z', level: 'ERROR', source: 'pi-bridge', event: 'bridge.request_timeout', code: 'BRIDGE_TIMEOUT', correlationId: 'corr-fixture-1', durationMs: 1200, process: 'backend', details: { operation: 'get_state', durationMs: 1200 }, cursor: 'c1' },
    { v: 1, timestamp: '2026-10-17T11:58:00.000Z', level: 'INFO', source: 'renderer', event: 'ui.attachment_failed', process: 'renderer', details: { kind: 'image', reason: 'upload_failed' }, cursor: 'c2' },
  ];
  let failStatus = false, failEntries = false, failExport = true, previewCalls = 0, clearCalls = 0, exportCalls = 0;
  w.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const json = (value, status = 200) => ({ ok: status < 400, status, headers: { get: () => '' }, json: async () => value, blob: async () => new w.Blob(['zip']) });
    if (u === '/api/logs/status') {
      if (failStatus) return json({ ok: false, network: true }, 503);
      return json({ ok: true, status: { ok: true, role: 'backend', enabled: settings.enabled, mode: settings.mode, retentionDays: settings.retentionDays, maxTotalMB: settings.maxTotalMB, verboseUntil: settings.verboseUntil, verboseExpired: settings.verboseExpired, usageBytes: 2048, fileCount: 2, crashFileCount: 1, degraded: false, lastErrorCode: null, files: [{ name: 'app-20261017.jsonl', role: 'app', kind: 'normal', size: 1024 }, { name: 'app-crash-20261017.jsonl', role: 'app', kind: 'crash', size: 1024 }], session: { startedAt: now.toISOString(), previousUnclean: { startedAt: now.toISOString() } }, recentErrors: entries.length ? [entries[0]] : [] } });
    }
    if (u.startsWith('/api/logs/entries')) {
      if (failEntries) return json({ ok: false, network: true }, 503);
      return json({ ok: true, entries, nextCursor: 'next', truncated: true, scannedFiles: 2 });
    }
    if (u === '/api/logs/settings') {
      settings = { ...settings, ...JSON.parse(opts.body || '{}') };
      return json({ ok: true, status: { ...settings, ok: true, usageBytes: 2048, fileCount: 2, crashFileCount: 1, degraded: false, files: [], session: {}, recentErrors: [] } });
    }
    if (u === '/api/logs/clear') {
      clearCalls++; entries = [];
      return json({ ok: true, fileCount: 2, bytes: 2048 });
    }
    if (u === '/api/logs/export/preview') {
      previewCalls++;
      return json({ ok: true, windowMinutes: JSON.parse(opts.body || '{}').windowMinutes, entryCount: 123, errorCount: 4, truncated: true, filesIncluded: ['README.txt', 'report.md', 'diagnostics.json', 'events.jsonl', 'errors.jsonl'], files: [] });
    }
    if (u === '/api/logs/export') {
      exportCalls++;
      if (failExport) return json({ ok: false, code: 'export_failed', reason: 'fixture' }, 503);
      return { ok: true, status: 200, headers: { get: () => 'attachment; filename="pi-gui-bugreport.zip"' }, blob: async () => new w.Blob(['zip']) };
    }
    if (u === '/api/diagnostics') return json({ ok: true, diagnostics: { app: { version: '0.25.0' }, system: { os: 'Windows', release: '11', arch: 'x64', node: 'v24' }, project: { selected: false }, bridge: { piRunning: false, bridgeRun: 0 }, checks: [], agents: [] } });
    return json({ ok: false, error: 'unexpected fixture URL', network: true }, 503);
  };
  const clipboard = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (text) => { clipboard.push(text); } }, configurable: true });
  w.eval(bundle(path.join(ROOT, 'public/logs.js')).code);
  return { w, d, calls, clipboard, close: () => dom.window.close(), setFailStatus(v) { failStatus = v; }, setFailEntries(v) { failEntries = v; }, setFailExport(v) { failExport = v; }, previewCalls: () => previewCalls, clearCalls: () => clearCalls, exportCalls: () => exportCalls, entries: () => entries, setEntries(v) { entries = v; } };
}

(async () => {
  const f = fixture();
  try {
    await check('打开日志面板：状态、文件、最近错误与隐私说明都在同一弹层', async () => {
      f.w.openLogs();
      await wait(40);
      assert.equal(f.d.getElementById('modal').hidden, false);
      const text = f.d.getElementById('modalCard').textContent;
      assert.match(text, /日志与故障报告/);
      assert.match(text, /已开启/);
      assert.match(text, /最近 30 分钟|最近错误/);
      assert.match(text, /app-20261017\.jsonl/);
      assert.match(text, /不含聊天正文|不会自动上传/);
      assert.equal(f.d.querySelector('img'), null);
    });

    await check('Z1-2 概览 Classic 引用显示行内成功反馈且保留草稿', async () => {
      Object.assign(f.w.S, { hasProject: true, switching: false, stopping: false, submitting: false, bridgeState: 'ready' });
      const input = f.d.getElementById('input'); input.value = 'existing draft';
      f.d.querySelector('.ui5-log-ref').click();
      assert.match(f.d.querySelector('.ui5-logs-recent-error [role=status]').textContent, /已引用.*不会自动发送/);
      assert.match(input.value, /^existing draft\n\n日志引用/);
      assert.doesNotMatch(input.value, /get_state|corr-fixture|durationMs/);
      f.d.querySelector('.ui5-log-ref').click();
      assert.equal(input.value.split('日志引用').length, 3, 'one append per deliberate click');
    });

    await check('Z1-2 未就绪引用显示失败，不改草稿、不新增 Toast', async () => {
      const input = f.d.getElementById('input'), before = input.value;
      const toasts = f.d.querySelector('#toasts').childElementCount;
      f.w.S.bridgeState = 'disconnected';
      f.d.querySelector('.ui5-log-ref').click();
      assert.match(f.d.querySelector('.ui5-logs-recent-error [role=status]').textContent, /尚未就绪.*复制/);
      assert.equal(input.value, before);
      assert.equal(f.d.querySelector('#toasts').childElementCount, toasts);
      f.w.S.bridgeState = 'ready';
    });

    await check('Z1-2 Runtime 引用只填当前 owner 的输入框并显示反馈', async () => {
      f.w.showRuntimeConversation(); f.w.setGitConversationScope('A');
      f.w.runtimeStore.seed({ backendInstance: 'fixture', items: [{ conversationId: 'A',
        owner: { backendInstance: 'fixture', conversationId: 'A', runtimeId: 'ra', runtimeGeneration: '1', sessionId: 'sa' }, lifecycle: 'ready' }] });
      f.d.getElementById('runtimeView').innerHTML = '<section class="runtime-conversation" data-conversation-id="A"><textarea aria-label="给当前会话的任务">runtime draft</textarea></section>';
      const classic = f.d.getElementById('input').value;
      f.d.querySelector('.ui5-log-ref').click();
      assert.match(f.d.querySelector('#runtimeView textarea').value, /^runtime draft\n\n日志引用/);
      assert.equal(f.d.getElementById('input').value, classic);
      assert.match(f.d.querySelector('.ui5-logs-recent-error [role=status]').textContent, /已引用/);
    });

    await check('Z1-2 Runtime 身份不匹配与未就绪均显示拒绝反馈', async () => {
      const root = f.d.querySelector('.runtime-conversation'), input = root.querySelector('textarea'), before = input.value;
      root.dataset.conversationId = 'B'; f.d.querySelector('.ui5-log-ref').click();
      assert.match(f.d.querySelector('.ui5-logs-recent-error [role=status]').textContent, /身份不一致/);
      assert.equal(input.value, before);
      root.dataset.conversationId = 'A'; f.w.runtimeStore.get('A').item.lifecycle = 'starting';
      f.d.querySelector('.ui5-log-ref').click();
      assert.match(f.d.querySelector('.ui5-logs-recent-error [role=status]').textContent, /未就绪/);
      assert.equal(input.value, before);
      f.w.setGitConversationScope(null); f.w.showChat();
      assert.ok(!f.calls.some(c => /prompt|steer|follow.up|command|execute/.test(c.url)));
    });

    await check('设置修改走 API 并更新状态，非法路径没有被发送', async () => {
      const mode = [...f.d.querySelectorAll('select')].find((s) => s.getAttribute('aria-label') === '日志级别');
      assert.ok(mode);
      mode.value = 'verbose';
      mode.dispatchEvent(new f.w.Event('change', { bubbles: true }));
      await wait(30);
      const call = f.calls.find((c) => c.url === '/api/logs/settings' && c.body?.mode === 'verbose');
      assert.ok(call);
      assert.equal(call.body.path, undefined);
      assert.match(f.d.getElementById('modalCard').textContent, /详细（24 小时后自动回标准）/);
    });

    await check('日志查看：按级别/来源/搜索加载真实条目并分页，所有内容走 textContent', async () => {
      const tab = f.d.getElementById('ui5-log-tab-logs');
      tab.click();
      await wait(30);
      const level = f.d.querySelector('select[aria-label="按级别筛选"]');
      assert.ok(level);
      level.value = 'ERROR';
      level.dispatchEvent(new f.w.Event('change', { bubbles: true }));
      await wait(30);
      assert.match(f.d.querySelector('.ui5-logs-list').textContent, /bridge\.request_timeout/);
      assert.ok(f.d.querySelectorAll('.ui5-log-entry').length >= 1);
      assert.match(f.d.querySelector('.ui5-logs-list').textContent, /加载更早日志/);
      const search = f.d.querySelector('input[aria-label="搜索日志"]');
      search.value = 'request';
      search.dispatchEvent(new f.w.Event('input', { bubbles: true }));
      await wait(300);
      assert.ok(f.calls.some((c) => c.url.startsWith('/api/logs/entries') && c.url.includes('q=request')));
    });

    await check('恶意 HTML 与长中文只作为文本呈现', async () => {
      f.setEntries([{
        v: 1, timestamp: '2026-10-17T11:59:00.000Z', level: 'ERROR', source: '<img src=x onerror="window.__xss=1">', event: '<script>alert(1)</script>', process: 'renderer', cursor: 'x',
        details: { reason: '<b>not-html</b>', note: '很长的中文日志说明'.repeat(30) },
      }]);
      f.setFailEntries(false);
      f.d.getElementById('ui5-log-tab-logs').click();
      f.d.querySelector('.ui5-logs-filters .btn')?.click();
      await wait(40);
      const list = f.d.querySelector('.ui5-logs-list');
      assert.ok(list);
      assert.equal(list.querySelector('img,script,b'), null);
      assert.ok(list.textContent.includes('<script>'));
      assert.equal(f.w.__xss, undefined);
    });

    await check('空日志和读取失败都有明确状态', async () => {
      f.setEntries([]);
      f.setFailEntries(false);
      f.d.querySelector('.ui5-logs-filters .btn')?.click();
      await wait(40);
      assert.match(f.d.querySelector('.ui5-logs-list').textContent, /没有日志|尚无日志/);
      f.setFailEntries(true);
      f.d.querySelector('.ui5-logs-filters .btn')?.click();
      await wait(40);
      assert.match(f.d.querySelector('.ui5-logs-list').textContent, /读取失败/);
    });

    await check('清理日志必须经过二次确认，取消不发请求', async () => {
      f.d.getElementById('ui5-log-tab-overview').click();
      await wait(10);
      const clear = [...f.d.querySelectorAll('#modalCard button')].find((b) => b.textContent === '清理日志');
      assert.ok(clear);
      clear.click();
      await wait(20);
      assert.equal(f.d.getElementById('confirmLayer').hidden, false);
      const cancel = [...f.d.querySelectorAll('#confirmCard button')].find((b) => b.textContent === '取消');
      cancel.click();
      await wait(20);
      assert.equal(f.clearCalls(), 0);
    });

    await check('导出前先预览；失败时给出提示并提供复制的降级路径', async () => {
      f.setFailExport(true);
      f.d.getElementById('ui5-log-tab-export').click();
      await wait(20);
      const preview = [...f.d.querySelectorAll('#modalCard button')].find((b) => b.textContent === '预览摘要');
      assert.ok(preview);
      preview.click();
      await wait(40);
      assert.equal(f.previewCalls(), 1);
      assert.match(f.d.querySelector('.ui5-logs-preview').textContent, /123/);
      assert.match(f.d.querySelector('.ui5-logs-preview').textContent, /errors\.jsonl/);
      const exportButton = [...f.d.querySelectorAll('#modalCard button')].find((b) => b.textContent === '确认导出 ZIP');
      assert.ok(exportButton);
      assert.equal(exportButton.disabled, false);
      exportButton.click();
      await wait(50);
      assert.equal(f.exportCalls(), 1);
      assert.match(f.d.querySelector('.ui5-logs-preview').textContent, /未能生成/);
      const fallback = [...f.d.querySelectorAll('#modalCard button')].find((b) => b.textContent.includes('复制安全摘要'));
      assert.ok(fallback);
      fallback.click();
      await wait(40);
      assert.ok(f.clipboard.some((text) => text.includes('Pi GUI 诊断摘要')));
      assert.ok(!f.clipboard.some((text) => text.includes('USER_CHAT_BODY')));
    });
  } finally {
    f.close();
  }
  console.log(`logging-ui: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
