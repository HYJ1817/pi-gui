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
  capabilities: { power: true, tray: true, cache: true, network: true },
  network: { settings: { mode: 'system', proxy: '', bypass: '', relaxed: false }, persistence: 'saved', restartRequired: false, note: '部分网络设置将在重启后生效。', error: '' },
  browserDirectory: 'C:\\fixture\\profile', error: '' });
const storage = { ok: true, storage: { dataDirectory: 'C:\\fixture\\<img src=x onerror=alert(1)>', source: 'environment',
  piAgentDirectory: 'C:\\fixture\\agent', piAgentSource: 'environment' } };
const diagnostics = { ok: true, diagnostics: { schemaVersion: 1, app: { id: 'pi-gui', version: '0.35.1' },
  system: { os: 'Windows_NT', release: '10.0.26200', platform: 'win32', arch: 'x64', node: 'v24.14.0' },
  bridge: { piRunning: true, bridgeRun: 7 }, project: { selected: true },
  checks: [{ id: 'data-readable', ok: true }, { id: 'data-writable', ok: false },
    { id: 'project-readable', ok: null }, { id: 'pi-running', ok: true }],
} };
function page(t, { bridge, fetchStorage = async () => storage, readDiagnostics = async () => diagnostics } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'), {
    url: 'http://127.0.0.1:7788', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  if (bridge) w.piGuiDesktop = { systemSettings: bridge };
  w.eval(source);
  let dispose;
  const card = d.createElement('div'); d.body.append(card);
  w.fetch = async () => { throw Error('unexpected network; fixture must inject every read'); };
  w.openSystemSettings({ fetchStorage, readDiagnostics, present(build, close) { dispose = close; build(card); } });
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
    saveNetwork: async value => { state.network.settings = value; state.network.restartRequired = true; return { ok: true, snapshot: state }; },
    testNetwork: async () => ({ ok: true, code: 'connected', durationMs: 12 }),
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
  assert.match(p.card.textContent, /运行环境、网络、存储、电源与窗口行为。/);
  assert.equal(p.card.querySelector('img'), null);
  assert.match(p.card.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(p.card.textContent, /PI_CODING_AGENT_DIR/);
  assert.equal(p.button('更改路径…').disabled, true);
  assert.equal(p.button('清理缓存…').disabled, true);
  assert.equal(p.toggle('保持电脑唤醒').disabled, true);
  assert.equal(p.button('退出应用…').disabled, true);
  assert.match(p.card.textContent, /仅桌面版可用/);
  const network = [...p.card.querySelectorAll('.ds-settings-card')].find(card => card.querySelector('h3')?.textContent === '网络');
  assert.ok([...network.querySelectorAll('button')].every(e => e.disabled));
});

test('runtime UI: reads only the injected diagnostic snapshot, preserves tri-state and has no duplicate dependency/update/export controls', async t => {
  let reads = 0, desktopReads = 0;
  const p = page(t, { readDiagnostics: async () => { reads++; return diagnostics; },
    bridge: desktop({ state: async () => { desktopReads++; return { ok: true, snapshot: snapshot() }; } }) });
  await until(() => p.d.getElementById('system-runtime-feedback').textContent.includes('不执行依赖检测'));
  const runtime = [...p.card.querySelectorAll('.ds-settings-card')].find(card => card.querySelector('h3')?.textContent === '运行环境');
  assert.equal(reads, 1); assert.equal(desktopReads, 1);
  for (const text of ['Windows_NT 10.0.26200', 'x64', 'v24.14.0', '运行中', '7', '已选择', '正常', '不可用', '未知']) assert.ok(runtime.textContent.includes(text), text);
  assert.equal(runtime.querySelectorAll('button').length, 1);
  assert.equal(runtime.querySelector('button').getAttribute('aria-label'), '刷新系统运行环境');
  assert.equal(runtime.querySelector('input, select, [role="switch"], .update-sec, .diagnostic-details'), null);
  assert.doesNotMatch(runtime.textContent, /C:\\fixture|复制诊断|导出|检查更新/);
  runtime.querySelector('button').click(); await until(() => reads === 2 && !runtime.querySelector('button').disabled);
  assert.equal(reads, 2); assert.equal(desktopReads, 1, 'refresh is diagnostic read, not native re-detection');
});

test('runtime UI: loading is deduplicated, failure is fixed and retryable, late reads do not repaint a closed page', async t => {
  let finish, reads = 0;
  const p = page(t, { readDiagnostics: () => { reads++; return new Promise(resolve => { finish = resolve; }); } });
  const refresh = p.card.querySelector('[aria-label="刷新系统运行环境"]');
  const feedback = p.d.getElementById('system-runtime-feedback');
  assert.equal(refresh.disabled, true); refresh.click(); assert.equal(reads, 1);
  finish({ ok: false, detail: 'PRIVATE_ERROR_DETAIL', error: 'PRIVATE_ERROR_DETAIL' });
  await until(() => !refresh.disabled);
  assert.equal(feedback.textContent, '无法读取运行环境，请重试。');
  assert.equal(feedback.classList.contains('is-error'), true);
  assert.doesNotMatch(p.card.textContent, /PRIVATE_ERROR_DETAIL/);
  refresh.click(); assert.equal(reads, 2);
  finish({ ok: true, diagnostics: { system: {}, bridge: { piRunning: false }, project: { selected: false }, checks: [] } });
  await until(() => !refresh.disabled);
  assert.match(p.card.textContent, /未运行/); assert.match(p.card.textContent, /未选择/); assert.match(p.card.textContent, /未知/);
  refresh.click(); const before = p.card.textContent; p.close(); finish(diagnostics); await turn();
  assert.equal(p.card.textContent, before); assert.equal(p.d.getElementById('system-runtime-feedback'), null);
});

test('network UI: draft mode, independent relaxed flag, named save and authoritative restart status', async t => {
  let saved; const state = snapshot();
  const p = page(t, { bridge: desktop({ saveNetwork: async value => {
    saved = value; state.network.settings = value; state.network.restartRequired = true; return { ok: true, snapshot: state };
  } }) });
  await until(() => !p.button('自定义').disabled);
  p.button('自定义').click();
  const input = p.card.querySelector('[aria-label="自定义代理地址"]');
  input.value = 'socks5h://127.0.0.1:1080'; input.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  p.toggle('网络宽松模式').click();
  assert.match(p.d.getElementById('system-network-effective').textContent, /系统代理/);
  p.button('保存网络设置').click(); await until(() => p.d.getElementById('system-network-feedback').textContent.includes('已保存'));
  assert.equal(saved.mode, 'custom'); assert.equal(saved.relaxed, true); assert.equal(saved.proxy, input.value);
  assert.match(p.d.getElementById('system-network-effective').textContent, /重启后生效/);
  assert.equal(p.toggle('保持电脑唤醒').getAttribute('aria-checked'), 'false');
});
test('network UI: an unconfirmed backend permission can be retried after reopening without changing the saved value', async t => {
  const state = snapshot(), saved = [];
  state.network.endpointPermissions = 'unconfirmed';
  state.network.error = '后端权限未确认。';
  const bridge = desktop({ state: async () => ({ ok: true, snapshot: state }), saveNetwork: async value => {
    saved.push({ ...value });
    if (saved.length === 1) return { ok: false, snapshot: state };
    state.network.endpointPermissions = 'strict'; state.network.error = '';
    return { ok: true, snapshot: state };
  } });
  const p = page(t, { bridge });
  const feedback = p.d.getElementById('system-network-feedback');
  await until(() => feedback.textContent.includes('后端权限未确认'));
  assert.equal(p.button('保存网络设置').disabled, false);
  p.button('保存网络设置').click();
  await until(() => p.button('保存网络设置')?.disabled === false);
  assert.equal(feedback.classList.contains('is-error'), true);
  assert.doesNotMatch(feedback.textContent, /已保存/);
  p.button('保存网络设置').click();
  await until(() => feedback.textContent.includes('已保存'));
  assert.deepEqual(saved, [state.network.settings, state.network.settings]);
  assert.equal(p.button('保存网络设置').disabled, true);
});
test('network UI: testing a draft never saves, old results do not overwrite changed drafts or another page', async t => {
  let finish, saves = 0;
  const p = page(t, { bridge: desktop({ testNetwork: () => new Promise(resolve => finish = resolve), saveNetwork: async () => { saves++; } }) });
  await until(() => p.button('测试连接')?.disabled === false);
  p.button('测试连接').click(); p.button('直连').click();
  finish({ ok: true, code: 'connected', durationMs: 12 });
  await until(() => p.button('测试连接')?.disabled === false);
  assert.match(p.d.getElementById('system-network-feedback').textContent, /旧测试结果已丢弃/); assert.equal(saves, 0);
  p.button('测试连接').click(); p.close(); finish({ ok: true, code: 'connected' }); await turn();
  assert.equal(p.d.querySelector('#system-network-feedback'), null);
});
test('network UI: a pasted authentication URL is cleared and is not sent to main or shown in feedback', async t => {
  let calls = 0;
  const p = page(t, { bridge: desktop({ saveNetwork: async () => { calls++; } }) });
  await until(() => !p.button('自定义').disabled); p.button('自定义').click();
  const input = p.card.querySelector('[aria-label="自定义代理地址"]'); input.value = 'http://user:SECRET@example.com:8080';
  input.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  assert.equal(input.value, ''); assert.equal(calls, 0);
  assert.doesNotMatch(p.d.getElementById('system-network-feedback').textContent, /SECRET/);
  assert.match(p.d.getElementById('system-network-feedback').textContent, /不支持代理认证/);
});

test('storage UI: native preflight needs separate confirmation and cancellation never commits', async t => {
  const state = snapshot(); state.capabilities.storage = true; state.storage = { canMigrate: true, source: 'electron-user-data', note: '旧目录保留' };
  let picks = 0, commits = 0;
  const p = page(t, { bridge: desktop({ state: async () => ({ ok: true, snapshot: state }),
    pickDataDirectory: async (...args) => { assert.equal(args.length, 0); picks++; return { ok: true, ticket: 'native-only', summary: { files: 3, bytes: 1024, targetDirectory: 'C:\\fixture\\<target>' } }; },
    migrateData: async ticket => { assert.equal(ticket, 'native-only'); commits++; return { ok: true, restartPending: true }; } }) });
  await until(() => !p.button('更改路径…').disabled); p.button('更改路径…').focus(); p.button('更改路径…').click();
  await until(() => !p.d.getElementById('confirmLayer').hidden);
  assert.match(p.d.getElementById('confirmCard').textContent, /3 个文件.*1 KiB/);
  assert.match(p.d.getElementById('confirmCard').textContent, /原目录保留为备份/);
  assert.equal(p.d.querySelector('#confirmCard target'), null); assert.equal(commits, 0);
  confirmButton(p.d, false).click(); await until(() => !p.button('更改路径…').disabled);
  assert.equal(commits, 0); assert.equal(p.d.activeElement, p.button('更改路径…'));
  p.button('更改路径…').click(); await until(() => !p.d.getElementById('confirmLayer').hidden); confirmButton(p.d, true).click();
  await until(() => p.d.getElementById('system-storage-feedback').textContent.includes('意图已保存'));
  assert.equal(picks, 2); assert.equal(commits, 1); assert.equal(p.d.getElementById('confirmLayer').hidden, true);
});
test('storage UI: busy/error is not migration success and an override is not editable', async t => {
  const state = snapshot(); state.storage = { canMigrate: true, source: 'electron-user-data' };
  const p = page(t, { bridge: desktop({ state: async () => ({ ok: true, snapshot: state }),
    pickDataDirectory: async () => ({ ok: true, ticket: 't', summary: { files: 1, bytes: 1, targetDirectory: 'fixture' } }),
    migrateData: async () => ({ ok: false, error: '存在活动任务；未切换目录。' }) }) });
  await until(() => !p.button('更改路径…').disabled); p.button('更改路径…').click(); await until(() => !p.d.getElementById('confirmLayer').hidden);
  confirmButton(p.d, true).click(); await until(() => p.d.getElementById('system-storage-feedback').classList.contains('is-error'));
  assert.doesNotMatch(p.d.getElementById('system-storage-feedback').textContent, /已保存|成功/);
  state.storage = { source: 'environment', canMigrate: false }; const external = page(t, { bridge: desktop({ state: async () => ({ ok: true, snapshot: state }) }) });
  await until(() => external.card.textContent.includes('不能在此覆盖')); assert.equal(external.button('更改路径…').disabled, true);
});
test('storage UI: late picker cannot replace a quit confirmation or write into a newer page', async t => {
  const state = snapshot(); state.storage = { canMigrate: true, source: 'electron-user-data' }; let release;
  const p = page(t, { bridge: desktop({ state: async () => ({ ok: true, snapshot: state }), pickDataDirectory: () => new Promise(resolve => release = resolve) }) });
  const preview = { ok: true, ticket: 't', summary: { files: 1, bytes: 1, targetDirectory: 'fixture' } };
  await until(() => !p.button('更改路径…').disabled); p.button('更改路径…').click(); p.button('退出应用…').click();
  release(preview); await until(() => p.d.getElementById('system-storage-feedback').textContent.includes('处理当前确认'));
  assert.match(p.d.getElementById('confirmCard').textContent, /退出 pi-GUI/); confirmButton(p.d, false).click();
  await until(() => !p.button('更改路径…').disabled); p.button('更改路径…').click(); p.close(); release(preview); await turn();
  assert.equal(p.d.getElementById('confirmLayer').hidden, true);
});
test('cache UI: physical and memory accounting stay separate and unknown is never a zero disk claim', async t => {
  const p = page(t, { bridge: desktop({ measureCache: async () => ({ ok: false, scope: 'system-cache-p2', diskBytes: null, memoryBytes: 10, bytes: null,
    buckets: [{ id: 'default-session-http-cache', status: 'unknown', bytes: null }, { id: 'default-session-code-cache', status: 'excluded', bytes: null }], error: '磁盘统计不可用' }) }) });
  await until(() => p.d.getElementById('system-cache-size').textContent.includes('磁盘 大小未知'));
  assert.match(p.d.getElementById('system-cache-size').textContent, /内存 10 B/); assert.equal(p.button('清理缓存…').disabled, true);
  assert.match(p.card.textContent, /未纳入（无法安全独立验证）/); assert.doesNotMatch(p.d.getElementById('system-cache-size').textContent, /磁盘 0 B/);
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
  for (const result of [{ ok: false, status: 'partial', bytes: 100, diskReleaseConfirmed: true, releasedDiskBytes: 1024, error: '仍有缓存' }, { ok: false, status: 'failed', bytes: null, error: '清理失败' }]) {
    let calls = 0;
    const p = page(t, { bridge: desktop({ clearCache: async () => { calls++; return result; } }) });
    await until(() => !p.button('清理缓存…').disabled);
    p.button('清理缓存…').click(); await until(() => !p.d.getElementById('confirmLayer').hidden);
    confirmButton(p.d, true).click();
    await until(() => p.d.getElementById('system-cache-feedback').classList.contains('is-error'));
    assert.equal(p.d.getElementById('confirmLayer').hidden, true); assert.equal(calls, 1);
    assert.doesNotMatch(p.d.getElementById('system-cache-feedback').textContent, /^缓存已清理/);
    if (result.diskReleaseConfirmed) assert.match(p.d.getElementById('system-cache-feedback').textContent, /实测磁盘文件占用减少 1 KiB/);
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
  assert.match(p.d.querySelector('.pop').textContent, /磁盘释放仅按实测下降报告/);
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
