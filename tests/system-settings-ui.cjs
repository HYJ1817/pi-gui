'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');
const ROOT = path.resolve(__dirname, '..');
const source = bundle(path.join(ROOT, 'public/system-settings.js')).code;
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(predicate) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await turn(); }
  assert.fail('UI fixture did not settle');
}
const snapshot = () => ({ persistence: 'saved', effective: { keepAwake: false, preventDisplaySleep: false, closeBehavior: 'quit' },
  capabilities: { power: true, tray: true, cache: true }, browserDirectory: 'C:\\fixture\\profile', error: '' });
const storage = { ok: true, storage: { dataDirectory: 'C:\\fixture\\<img src=x onerror=alert(1)>', source: 'environment',
  piAgentDirectory: 'C:\\fixture\\agent', piAgentSource: 'environment' } };
function page(t, { bridge, fetchStorage = async () => storage } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'), {
    url: 'http://127.0.0.1:7788', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  if (bridge) w.piGuiDesktop = { systemSettings: bridge };
  w.eval(source);
  let dispose;
  const card = d.createElement('div'); d.body.append(card);
  w.openSystemSettings({ fetchStorage, present(build, close) { dispose = close; build(card); } });
  return { w, d, card, close: () => { dispose(); card.remove(); },
    button: label => [...card.querySelectorAll('button')].find(e => e.textContent === label),
    toggle: label => card.querySelector(`[role="switch"][aria-label="${label}"]`),
  };
}
function desktop(overrides = {}) {
  const state = snapshot();
  return { state: async () => ({ ok: true, snapshot: state }),
    measureCache: async () => ({ ok: true, status: 'ready', bytes: 4096, ticket: 'preview' }),
    set: async (key, value) => { state.effective[key] = value; return { ok: true, snapshot: state }; },
    ...overrides };
}
function confirmButton(d, yes) {
  const buttons = [...d.querySelectorAll('#confirmCard .modal-actions button')];
  return yes ? buttons.at(-1) : buttons[0];
}

test('system UI: Web paths are text; all desktop/P2 controls are truly disabled', async t => {
  const p = page(t);
  await until(() => p.card.textContent.includes('由 PI_GUI_DATA 指定'));
  assert.equal(p.card.querySelector('h2').textContent, '系统');
  assert.match(p.card.textContent, /网络、存储、电源，以及本机的窗口行为。/);
  assert.equal(p.card.querySelector('img'), null);
  assert.match(p.card.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(p.card.textContent, /PI_CODING_AGENT_DIR/);
  assert.equal(p.button('更改路径…').disabled, true);
  assert.equal(p.button('清理缓存…').disabled, true);
  assert.equal(p.toggle('保持电脑唤醒').disabled, true);
  assert.equal(p.button('退出应用…').disabled, true);
  assert.match(p.card.textContent, /仅桌面版可用/);
  const network = p.card.querySelector('.ds-settings-card');
  assert.ok([...network.querySelectorAll('button')].every(e => e.disabled));
});

test('system UI: native switches wait for authority and failed saves roll back only their value', async t => {
  let finish, request;
  const state = snapshot();
  const p = page(t, { bridge: desktop({ state: async () => ({ ok: true, snapshot: state }),
    set: (key, value) => { request = { key, value }; return new Promise(resolve => { finish = resolve; }); } }) });
  await until(() => !p.toggle('保持电脑唤醒').disabled);
  const awake = p.toggle('保持电脑唤醒'), display = p.toggle('阻止屏幕休眠');
  awake.focus(); awake.click();
  assert.deepEqual(request, { key: 'keepAwake', value: true });
  assert.equal(awake.getAttribute('aria-checked'), 'false');
  assert.equal(display.disabled, true);
  assert.equal(p.button('退出应用…').disabled, true);
  state.effective.keepAwake = true; finish({ ok: true, snapshot: state });
  await until(() => !awake.disabled);
  assert.equal(awake.getAttribute('aria-checked'), 'true');
  display.click();
  finish({ ok: false, snapshot: { ...state, error: '磁盘不可写；此次更改未保存。' } });
  await until(() => !display.disabled);
  assert.equal(awake.getAttribute('aria-checked'), 'true');
  assert.equal(display.getAttribute('aria-checked'), 'false');
  assert.match(p.d.getElementById('system-preference-feedback').textContent, /未保存/);
});

test('system UI: a committed preference with a native failure shows the effective policy and accurate saved warning', async t => {
  const state = snapshot(); state.effective.closeBehavior = 'tray';
  const p = page(t, { bridge: desktop({ state: async () => ({ ok: true, snapshot: state }),
    set: async (key, value) => {
      if (key !== 'closeBehavior') { state.effective[key] = value; return { ok: true, snapshot: state }; }
      state.error = '系统设置已保存，但未能应用。当前关闭行为保持不变，请重试或重启应用。';
      return { ok: false, code: 'settings_saved_not_applied', committed: true, snapshot: state }; } }) });
  await until(() => !p.button('退出应用').disabled);
  p.button('退出应用').click();
  await until(() => p.d.getElementById('system-preference-feedback').textContent.includes('已保存'));
  assert.equal(p.button('关闭到托盘').getAttribute('aria-checked'), 'true');
  assert.equal(p.button('退出应用').getAttribute('aria-checked'), 'false');
  assert.equal(p.button('退出应用').disabled, false);
  const feedback = p.d.getElementById('system-preference-feedback');
  assert.equal(feedback.classList.contains('is-error'), true);
  assert.match(feedback.textContent, /已保存，但未能应用/);
  assert.doesNotMatch(feedback.textContent, /未保存|^已保存。$/);
  p.toggle('保持电脑唤醒').click();
  await until(() => !p.toggle('保持电脑唤醒').disabled);
  assert.match(feedback.textContent, /已保存，但未能应用/);
  assert.equal(feedback.classList.contains('is-error'), true);
});
test('system UI: a lost IPC reply re-reads authoritative state instead of claiming a save', async t => {
  const state = snapshot();
  const p = page(t, { bridge: desktop({ state: async () => ({ ok: true, snapshot: state }),
    set: async () => { state.effective.closeBehavior = 'tray'; throw Error('reply interrupted'); } }) });
  await until(() => !p.button('关闭到托盘').disabled);
  p.button('关闭到托盘').click();
  await until(() => !p.button('关闭到托盘').disabled);
  assert.equal(p.button('关闭到托盘').getAttribute('aria-checked'), 'true');
  assert.match(p.d.getElementById('system-preference-feedback').textContent, /未能确认/);
});

test('system UI: corrupt/unavailable preferences and unsupported natives do not become fake defaults', async t => {
  const state = snapshot(); state.persistence = 'unavailable'; state.error = '无法安全读取系统设置';
  state.capabilities.tray = false; state.effective.preventDisplaySleep = null;
  const p = page(t, { bridge: desktop({ state: async () => ({ ok: true, snapshot: state }) }) });
  await until(() => p.card.textContent.includes(state.error));
  assert.equal(p.toggle('保持电脑唤醒').disabled, true);
  assert.equal(p.toggle('阻止屏幕休眠').disabled, true);
  assert.equal(p.button('关闭到托盘').disabled, true);
  assert.match(p.d.getElementById('system-power-reason').textContent, /无法确认/);
  assert.match(p.d.getElementById('system-tray-reason').textContent, /不支持/);
});

test('system UI: clear requires a fresh measured preview, cancellation does not clear; confirmation closes and remeasures', async t => {
  let clears = 0, measures = 0;
  const p = page(t, { bridge: desktop({ measureCache: async () => ({ ok: true, bytes: ++measures === 1 ? 4096 : 2048, ticket: 'new-preview' }),
    clearCache: async ticket => { assert.equal(ticket, 'new-preview'); clears++; return { ok: true, status: 'cleared', bytes: 0 }; } }) });
  await until(() => !p.button('清理缓存…').disabled);
  p.button('清理缓存…').focus(); p.button('清理缓存…').click();
  await until(() => !p.d.getElementById('confirmLayer').hidden);
  assert.match(p.d.getElementById('confirmCard').textContent, /2 KiB/);
  assert.match(p.d.getElementById('confirmCard').textContent, /聊天记录、设置、凭据、附件、模型和插件数据均会保留/);
  confirmButton(p.d, false).click();
  await until(() => !p.button('清理缓存…').disabled);
  assert.equal(clears, 0);
  p.button('清理缓存…').click();
  await until(() => !p.d.getElementById('confirmLayer').hidden);
  confirmButton(p.d, true).click();
  await until(() => p.d.getElementById('system-cache-feedback').textContent === '缓存已清理。');
  assert.equal(clears, 1); assert.equal(measures, 3);
  assert.equal(p.d.getElementById('confirmLayer').hidden, true);
  assert.equal(p.d.getElementById('system-cache-size').textContent, '0 B');
  assert.equal(p.button('清理缓存…').disabled, true);
  assert.equal(p.button('重新统计').disabled, false);
});

test('system UI: Escape cancels confirmation, unknown is not zero and retry remains available', async t => {
  let unknown = false, clears = 0;
  const p = page(t, { bridge: desktop({ measureCache: async () => unknown ? { ok: false, bytes: null, error: '统计失败' } : { ok: true, bytes: 2, ticket: 'p' },
    clearCache: async () => { clears++; } }) });
  await until(() => !p.button('清理缓存…').disabled);
  p.button('清理缓存…').click(); await until(() => !p.d.getElementById('confirmLayer').hidden);
  p.d.activeElement.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => !p.button('清理缓存…').disabled); assert.equal(clears, 0);
  unknown = true; p.button('重新统计').click();
  await until(() => p.d.getElementById('system-cache-feedback').textContent === '统计失败');
  assert.equal(p.d.getElementById('system-cache-size').textContent, '大小未知');
  assert.equal(p.button('清理缓存…').disabled, true);
  assert.equal(p.button('重新统计').disabled, false);
});

test('system UI: partial or failed clearing is not success and old confirmation cannot be submitted again', async t => {
  for (const result of [{ ok: false, status: 'partial', bytes: 100, error: '仍有缓存' }, { ok: false, status: 'failed', bytes: null, error: '清理失败' }]) {
    let calls = 0;
    const p = page(t, { bridge: desktop({ clearCache: async () => { calls++; return result; } }) });
    await until(() => !p.button('清理缓存…').disabled);
    p.button('清理缓存…').click(); await until(() => !p.d.getElementById('confirmLayer').hidden);
    confirmButton(p.d, true).click();
    await until(() => p.d.getElementById('system-cache-feedback').classList.contains('is-error'));
    assert.equal(p.d.getElementById('confirmLayer').hidden, true); assert.equal(calls, 1);
    assert.doesNotMatch(p.d.getElementById('system-cache-feedback').textContent, /^缓存已清理/);
    assert.equal(p.d.getElementById('system-cache-size').textContent, result.bytes === null ? '大小未知' : '100 B');
  }
});

test('system UI: empty caches have no active delete and unavailable storage is explicit', async t => {
  const p = page(t, { bridge: desktop({ measureCache: async () => ({ ok: true, status: 'empty', bytes: 0, ticket: 'p' }) }),
    fetchStorage: async () => { throw Error('offline'); } });
  await until(() => p.d.getElementById('system-cache-size').textContent === '0 B');
  assert.equal(p.button('清理缓存…').disabled, true);
  assert.match(p.card.textContent, /无法读取数据目录/);
  p.card.querySelector('button[aria-label="可清理缓存提示"]').click();
  assert.match(p.d.querySelector('.pop').textContent, /不释放磁盘空间/);
});

test('system UI: late native/path replies after leaving cannot write into a newer settings page', async t => {
  let releaseState, releasePaths;
  const p = page(t, { bridge: desktop({ state: () => new Promise(resolve => { releaseState = resolve; }) }),
    fetchStorage: () => new Promise(resolve => { releasePaths = resolve; }) });
  p.close(); const next = p.d.createElement('div'); next.textContent = 'new page'; p.d.body.append(next);
  releaseState({ ok: true, snapshot: snapshot() }); releasePaths(storage); await turn();
  assert.equal(next.textContent, 'new page');
  assert.doesNotMatch(p.card.textContent, /由 PI_GUI_DATA 指定/);
  assert.equal(p.d.getElementById('confirmLayer').hidden, true);
});

test('system UI: a delayed cache preview cannot replace an existing quit confirmation', async t => {
  let release, measures = 0;
  const p = page(t, { bridge: desktop({ measureCache: async () => {
    if (++measures === 1) return { ok: true, bytes: 4, ticket: 'first' };
    return new Promise(resolve => { release = resolve; });
  } }) });
  await until(() => !p.button('清理缓存…').disabled);
  p.button('清理缓存…').click(); await until(() => release);
  p.button('退出应用…').click();
  release({ ok: true, bytes: 4, ticket: 'later' });
  await until(() => !p.button('重新统计').disabled);
  assert.match(p.d.getElementById('confirmCard').textContent, /退出 pi-GUI？/);
  assert.match(p.d.getElementById('system-cache-feedback').textContent, /先处理当前确认/);
  confirmButton(p.d, false).click();
});
test('system UI: explicit quit is confirmed separately and cancelled exits never reach native IPC', async t => {
  let quits = 0;
  const p = page(t, { bridge: desktop({ quit: async () => { quits++; return { ok: true }; } }) });
  await until(() => !p.button('退出应用…').disabled);
  p.button('退出应用…').click();
  assert.match(p.d.getElementById('confirmCard').textContent, /结束本机服务/);
  confirmButton(p.d, false).click(); await turn(); assert.equal(quits, 0);
  p.button('退出应用…').click(); confirmButton(p.d, true).click();
  await until(() => quits === 1 && p.d.getElementById('confirmLayer').hidden);
  assert.match(p.d.getElementById('system-quit-feedback').textContent, /已请求退出/);
});
