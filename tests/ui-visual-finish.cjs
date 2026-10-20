/* Offline presentation regressions; no real Pi or user files. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');
const root = path.resolve(__dirname, '..');
const dom = new JSDOM(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'), {
  url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
});
const w = dom.window;
w.matchMedia = () => ({ matches: false, addEventListener() {} });
w.ResizeObserver = class { observe() {} disconnect() {} };
w.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
w.eval(bundle(path.join(root, 'public/messages.js')).code);
w.eval(bundle(path.join(root, 'public/ui/toast.js')).code);
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}
check('routine successes and information do not create a popup', () => {
  for (const kind of ['info', 'success', 'ok']) assert.equal(w.toast('routine ' + kind, kind), null);
});
check('actionable failures stay visible and duplicate live errors never stack', () => {
  w.document.getElementById('toasts').replaceChildren();
  const one = w.toast('failure requiring attention', 'error');
  assert.equal(one.getAttribute('role'), 'alert');
  const original = w.Date.now;
  w.Date.now = () => original() + 60000;
  try { assert.equal(w.toast('failure requiring attention', 'error'), null); }
  finally { w.Date.now = original; }
  assert.equal(w.document.querySelectorAll('.toast').length, 1);
});
check('an explicit action can still surface an important status', () => {
  assert.ok(w.toast('recoverable state', 'info', { action: { label: '处理', run() {} } }));
});
check('suppressed and visible notifications log only declared structural metadata', () => {
  const records = [];
  w.configureNotificationLogging((event, details) => records.push({ event, details }));
  w.toast('private notification body', 'info');
  w.toast('private failure body', 'error');
  assert.equal(records.length, 2);
  assert.equal(records[1].event, 'ui.notification_error');
  assert.deepEqual(Object.keys(records[1].details), ['kind']);
  assert.ok(!JSON.stringify(records).includes('private'));
  const contract = require('../lib/log-contract.cjs');
  assert.deepEqual(contract.normalizeDetails('ui.notification_error', { kind: 'error', message: 'secret', path: 'private' }), { kind: 'error' });
});
check('error has one announcement and preserves its exact detail as text', () => {
  const raw = '当前模型认证失败，自动备用未执行 <img src=x>';
  const node = w.errorBlock({ errorMessage: raw });
  assert.equal(node.getAttribute('role'), 'alert');
  assert.equal(node.getAttribute('aria-atomic'), 'true');
  assert.equal(node.querySelector('.me-raw').textContent, raw);
  assert.equal(node.querySelector('img,svg,[role=alert]'), null);
});
w.eval(bundle(path.join(root, 'public/extension-notices.js')).code);
check('optional qmd dependency is retained once in Memory status without a popup', () => {
  w.document.getElementById('toasts').replaceChildren();
  const event = { message: 'memory_search requires qmd.\nInstall qmd', notifyType: 'error' };
  w.handleExtensionNotification(event);
  w.handleExtensionNotification(event);
  assert.equal(w.document.querySelectorAll('.toast').length, 0);
  assert.equal(w.extensionNotices().length, 1);
  assert.equal(w.extensionNotices()[0].count, 2);
  const host = w.document.createElement('div');
  w.renderExtensionNotices(host, { feature: 'memory' });
  assert.ok(host.textContent.includes(event.message));
});
check('unknown extension errors remain visible, ordinary warnings go to status', () => {
  w.handleExtensionNotification({ message: 'extension failed unexpectedly', notifyType: 'error' });
  assert.equal(w.document.querySelectorAll('.toast').length, 1);
  w.handleExtensionNotification({ message: 'optional component unavailable', notifyType: 'warning' });
  assert.equal(w.document.querySelectorAll('.toast').length, 1);
  assert.equal(w.extensionNotices().length, 3);
});
check('replay, stale runs and switched workspace do not retain stale status', () => {
  const before = w.extensionNotices().length;
  w.handleExtensionNotification({ message: 'history', _replay: true });
  w.handleExtensionNotification({ message: 'stale', bridgeRun: 99 });
  assert.equal(w.extensionNotices().length, before);
  w.S.workspaceGeneration++;
  assert.equal(w.extensionNotices().length, 0);
});
check('extension status is bounded, inert text and stores no duplicate payload copies', () => {
  for (let i = 0; i < 45; i++) w.handleExtensionNotification({ message: `<img src=x> ${i}`, notifyType: 'info' });
  assert.equal(w.extensionNotices().length, 30);
  const host = w.document.createElement('div');
  w.renderExtensionNotices(host);
  assert.equal(host.querySelector('img'), null);
  w.S.bridgeRun = 2;
  assert.equal(w.extensionNotices().length, 0);
});
w.eval(bundle(path.join(root, 'public/conversation-nav.js')).code);
check('500 navigation targets have distinct 12px hit areas and retain exact scroll targets', () => {
  const nav = w.document.getElementById('convoNav');
  const stream = w.document.getElementById('stream');
  Object.defineProperty(nav, 'clientHeight', { value: 300 });
  Object.defineProperty(stream, 'scrollHeight', { value: 50000 });
  Object.defineProperty(stream, 'clientHeight', { value: 300 });
  w.S.thread = w.document.createElement('div');
  stream.append(w.S.thread);
  for (let i = 0; i < 500; i++) {
    const el = w.document.createElement('div'); el.className = 'msg user';
    el.innerHTML = '<div class="msg-body">Question ' + i + '</div>';
    el.getBoundingClientRect = () => ({ top: i * 100 });
    w.S.thread.append(el);
  }
  w.rebuildConversationNav();
  const markers = [...nav.querySelectorAll('.cn-marker')];
  assert.equal(markers.length, 500);
  for (let i = 1; i < markers.length; i++) {
    assert.equal(markers[i].style.height, '12px');
    assert.ok(parseFloat(markers[i].style.top) - parseFloat(markers[i - 1].style.top) >= 12);
  }
  stream.scrollTo = options => { stream.scrollTop = options.top; };
  markers[320].click();
  assert.equal(stream.scrollTop, 31980);
  assert.equal(markers[320].getAttribute('aria-current'), 'true');
  markers[320].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(w.document.activeElement, markers[499]);
});
w.document.getElementById('toasts').replaceChildren();
dom.window.close();
console.log(`Visual finish: ${passed}/${passed + failed}; failed=${failed}`);
process.exitCode = failed ? 1 : 0;
