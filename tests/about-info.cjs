/* 「信息」设置页的定向验收（jsdom，真实 app 模块图 + 假后端 / 假 Electron 能力）。
 *
 * 覆盖：入口迁移、hero 版本来源与失败回退、两块独立更新、下载/安装忙碌态、
 * Pi 更新的独立确认与请求、重启确认/取消/失败、日志与导出导航、GitHub 外链、
 * 通知点与文案、关闭重开后的状态保持、信息页与诊断页不争用更新容器。
 *
 * 所有写操作都只落在内存桩上，不碰用户数据、不联网。
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');

const PUB = path.join(__dirname, '..', 'public');
const HTML = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const CODE = bundle(path.join(PUB, 'app.js')).code;
const ISSUES_URL = 'https://github.com/HYJ1817/pi-gui/issues';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let checks = 0;
function check(name, fn) {
  const value = fn();
  if (!value) throw new Error(name);
  checks += 1;
  console.log('ok ' + checks + ' - ' + name);
}
async function checkAsync(name, fn) {
  const value = await fn();
  if (!value) throw new Error(name);
  checks += 1;
  console.log('ok ' + checks + ' - ' + name);
}

function boot() {
  const dom = new JSDOM(HTML, { url: 'http://127.0.0.1:7788/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const d = w.document;

  const fixture = {
    diagnosticsFail: false,
    diagnostics: {
      schemaVersion: 1,
      generatedAt: '2026-11-18T00:00:00.000Z',
      app: { id: 'pi-gui', version: '0.34.0' },
      system: { platform: 'win32', arch: 'x64', node: 'v24.14.0', os: 'Windows_NT', release: '10.0.26200' },
      project: { selected: true, name: 'pi-GUI', readable: true, writable: true },
      data: { readable: true, writable: true },
      bridge: { piRunning: true, bridgeRun: 3, hasProject: true, args: ['--mode', 'rpc'] },
      pi: {
        configuredBin: 'pi', available: true, version: '0.87.0', versionSource: 'package.json',
        verification: { status: 'verified', verifiedAgainst: { version: '0.87.0', verifiedAt: '2026-10-01' }, relative: 'same' },
      },
      compatibility: { status: 'compatible', missing: [], unverified: [] },
    },
    update: { ok: true, currentVersion: '0.34.0', latestVersion: '0.34.0', updateAvailable: false, cached: false },
    piUpdate: { ok: true, phase: 'latest', currentVersion: '0.87.0', latestVersion: '0.87.0', updateAvailable: false, verification: 'verified', canUpdate: false, reason: 'latest', cached: false, running: false },
    updateCalls: [],
    piUpdateCalls: [],
    restartCalls: 0,
    restartResult: { ok: true },
    externalOpens: [],
    downloads: 0,
    cancels: 0,
    installs: 0,
    folders: 0,
    desktop: { mode: 'installed', phase: 'idle', currentVersion: '0.34.0' },
    onDesktopState: null,
    pushDesktop: (next) => {
      fixture.desktop = { ...fixture.desktop, ...next };
      fixture.onDesktopState?.(fixture.desktop);
    },
  };

  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.EventSource = class { constructor() {} close() {} addEventListener() {} };

  w.piGuiDesktop = {
    openExternal: async (url) => {
      fixture.externalOpens.push(url);
      return { ok: true };
    },
    appUpdate: {
      state: async () => fixture.desktop,
      onState: (callback) => { fixture.onDesktopState = callback; },
      download: async () => { fixture.downloads += 1; return { ok: true }; },
      cancel: async () => { fixture.cancels += 1; return { ok: true }; },
      install: async () => { fixture.installs += 1; return { ok: true }; },
      openFolder: async () => { fixture.folders += 1; return { ok: true }; },
    },
  };

  w.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = options.method || 'GET';
    const json = (value) => ({ ok: true, status: 200, json: async () => value });
    if (target.includes('/api/provider-management')) {
      return { ok: false, status: 422, json: async () => ({ ok: false, code: 'unsupported', message: '管理能力未开放' }) };
    }
    if (target.includes('/api/diagnostics')) {
      if (fixture.diagnosticsFail) return json({ ok: false, error: '诊断服务暂时不可用' });
      return json({ ok: true, diagnostics: fixture.diagnostics });
    }
    if (target.includes('/api/update')) {
      fixture.updateCalls.push({ method, force: target.includes('force=1') });
      return json(fixture.update);
    }
    if (target.includes('/api/pi-update')) {
      fixture.piUpdateCalls.push({ method, force: target.includes('force=1'), body: method === 'POST' ? JSON.parse(options.body || '{}') : null });
      if (method === 'POST') {
        return json({ ok: true, accepted: true, phase: 'updating', currentVersion: '0.87.0', latestVersion: '1.0.0' });
      }
      return json(fixture.piUpdate);
    }
    if (target.includes('/api/restart')) {
      fixture.restartCalls += 1;
      return json(fixture.restartResult);
    }
    if (target.includes('/api/logs/status')) {
      return json({
        ok: true,
        status: {
          ok: true, enabled: true, mode: 'standard', retentionDays: 7, maxTotalMB: 20,
          usageBytes: 1024, fileCount: 1, crashFileCount: 0, degraded: false,
          files: [{ name: 'app-20261118.jsonl', role: 'app', kind: 'normal', size: 1024 }],
          session: { previousUnclean: false }, recentErrors: [],
        },
      });
    }
    if (target.includes('/api/logs/entries')) return json({ ok: true, entries: [], nextCursor: null, truncated: false });
    if (target.includes('/api/logs/export/preview')) return json({ ok: true, windowMinutes: 30, entryCount: 0, errorCount: 0, truncated: false, filesIncluded: ['README.txt'] });
    if (target.includes('/api/status')) return json({ ok: true, piRunning: true, cwd: 'C:\\fixture', hasProject: true, args: ['--mode', 'rpc'] });
    if (target.includes('/api/projects')) return json({ ok: true, active: 'C:\\fixture', items: [{ name: 'Fixture', path: 'C:\\fixture' }] });
    if (target.includes('/api/sessions')) return json({ ok: true, sessions: [] });
    if (target.includes('/api/providers')) return json({ ok: true, providers: {}, keyStates: {} });
    return json({ ok: true });
  };

  w.eval(CODE);
  w.cancelUpdateAuto();
  w.cancelPiUpdateAuto();
  return { dom, w, d, fixture };
}

function $ (w, id) { return w.document.getElementById(id); }
function settingsCard(w) { return w.document.querySelector('.settings-detail-card'); }
function appPanel(w) { return w.document.querySelector('[data-about-update="app"]'); }
function piPanel(w) { return w.document.querySelector('[data-about-update="pi"]'); }

async function openInfo(w) {
  $ (w, 'navGlobalMore').click();
  $ (w, 'navInfo').click();
  await sleep(40);
  return settingsCard(w);
}

(async () => {
  const { dom, w, d, fixture } = boot();
  try {
    /* ---------- 入口迁移 ---------- */
    check('info entry exists with the local info icon; old entries are gone', () =>
      Boolean($ (w, 'navInfo')) &&
      Boolean($ (w, 'navInfo').querySelector('svg[data-icon="info"]')) &&
      !$ (w, 'navAppUpdates') && !$ (w, 'navRestartPi') &&
      $ (w, 'navInfo').textContent.includes('信息'));

    check('stale settings destinations resolve to info, other destinations unchanged', () =>
      w.resolveSettingsDestination('navAppUpdates') === 'navInfo' &&
      w.resolveSettingsDestination('navRestartPi') === 'navInfo' &&
      w.resolveSettingsDestination('navLogs') === 'navLogs');

    check('settings search keywords find the info entry for update/restart/log/version', () => {
      const search = $ (w, 'settingsSearchInput');
      $ (w, 'navGlobalMore').click();
      for (const query of ['信息', '更新', '重启', '日志', '版本', 'about', 'pi', 'gui']) {
        search.value = query;
        search.oninput();
        assert.equal($ (w, 'navInfo').hidden, false, 'info entry hidden for ' + query);
      }
      search.value = '';
      search.oninput();
      return true;
    });

    /* ---------- hero：读取失败 -> 未知 + 重试；恢复后显示真值 ---------- */
    fixture.diagnosticsFail = true;
    let card = await openInfo(w);
    check('info page opens with its own page heading', () =>
      card.querySelector('h3').textContent === '信息' && Boolean(card.querySelector('.about-hero')));

    await sleep(30);
    check('diagnostics failure shows unknown versions and a clear error, not stale values', () => {
      const text = card.textContent;
      return card.querySelector('.about-hero-version').textContent === '版本 未知' &&
        !card.querySelector('.about-hero-error').hidden &&
        text.includes('无法读取应用信息') &&
        Boolean(card.querySelector('[data-about-action="retry-info"]'));
    });

    fixture.diagnosticsFail = false;
    const retry = card.querySelector('[data-about-action="retry-info"]');
    retry.focus();
    retry.click();
    await sleep(40);
    check('retry recovers the hero from /api/diagnostics', () => {
      const version = card.querySelector('.about-hero-version').textContent;
      const meta = card.querySelector('.about-hero-meta').textContent;
      return version === '版本 0.34.0' && /Pi 0\.87\.0/.test(meta) &&
        /Windows_NT 10\.0\.26200 x64/.test(meta) && /兼容正常/.test(meta) && /Pi 运行中/.test(meta);
    });
    check('hero retry keeps keyboard focus on the page instead of dropping to body', () =>
      w.document.activeElement === card.querySelector('.about-hero'));

    check('the unified page renders two independent update panels', () =>
      Boolean(appPanel(w).querySelector('.update-sec')) &&
      Boolean(piPanel(w).querySelector('.update-sec')) &&
      appPanel(w).querySelector('.about-update-title').textContent === '软件更新' &&
      piPanel(w).querySelector('.about-update-title').textContent === 'Pi 运行时');

    /* ---------- pi-GUI 更新：latest / available / 下载 / 失败 / 就绪 ---------- */
    const appCheck = () => appPanel(w).querySelector('.update-head .btn');
    check('app update starts from the running Electron version without hardcoding', () =>
      appPanel(w).querySelector('.update-title').textContent === 'Pi GUI v0.34.0');

    fixture.update = { ok: true, currentVersion: '0.34.0', latestVersion: '0.34.0', updateAvailable: false };
    appCheck().click();
    await sleep(20);
    check('app update latest state is explicit and lights no dot', () =>
      appPanel(w).querySelector('.update-sec').textContent.includes('当前已是最新版本') &&
      $ (w, 'updateDot').hidden === true && $ (w, 'menuUpdateDot').hidden === true);

    fixture.update = {
      ok: true, currentVersion: '0.34.0', latestVersion: '0.35.0', updateAvailable: true,
      release: {
        tag: 'v0.35.0', publishedAt: '2026-11-17T00:00:00Z',
        notes: '## 修复\n\n- 安全更新说明\n\n[Release](https://github.com/HYJ1817/pi-gui/releases/tag/v0.35.0)',
        url: 'https://github.com/HYJ1817/pi-gui/releases/tag/v0.35.0',
        assets: [
          { kind: 'installer', name: 'Pi-GUI-Setup-0.35.0.exe', url: 'https://github.com/HYJ1817/pi-gui/releases/download/v0.35.0/Pi-GUI-Setup-0.35.0.exe' },
          { kind: 'portable', name: 'Pi-GUI-0.35.0-portable.zip', url: 'https://github.com/HYJ1817/pi-gui/releases/download/v0.35.0/Pi-GUI-0.35.0-portable.zip' },
          { kind: 'checksums', name: 'SHA256SUMS.txt', url: 'https://github.com/HYJ1817/pi-gui/releases/download/v0.35.0/SHA256SUMS.txt' },
        ],
      },
    };
    const beforeAppCheck = fixture.updateCalls.length;
    appCheck().click();
    await sleep(20);
    check('app update available shows current/latest, notes and both dots', () =>
      fixture.updateCalls.length === beforeAppCheck + 1 &&
      appPanel(w).querySelector('.update-sec').textContent.includes('发现新版本 v0.35.0') &&
      appPanel(w).querySelector('.update-sec').textContent.includes('当前版本 v0.34.0') &&
      Boolean(appPanel(w).querySelector('.update-notes')) &&
      $ (w, 'updateDot').hidden === false && $ (w, 'menuUpdateDot').hidden === false);

    const primary = () => [...appPanel(w).querySelectorAll('.update-sec .btn.primary')];
    check('available state exposes exactly one primary operation and manual assets stay folded', () =>
      primary().length === 1 && primary()[0].textContent === '下载更新' &&
      appPanel(w).querySelector('details.update-manual-downloads')?.open === false);

    primary()[0].click();
    check('download is only requested by the explicit click', () => fixture.downloads === 1);

    fixture.pushDesktop({ phase: 'downloading', received: 50, total: 100, speed: 10 });
    await sleep(20);
    check('downloading shows progress, disables check and exposes no duplicate operation', () =>
      Boolean(appPanel(w).querySelector('progress')) &&
      appCheck().disabled === true &&
      primary().length === 0 &&
      appPanel(w).querySelector('.update-sec').textContent.includes('50%'));

    fixture.pushDesktop({ phase: 'failed', error: '下载失败，请重试。' });
    await sleep(20);
    check('download failure is readable and offers one retry path', () =>
      appPanel(w).querySelector('.update-sec').textContent.includes('下载失败') &&
      primary().length === 1 && primary()[0].textContent === '重新下载');

    fixture.pushDesktop({ phase: 'ready', version: '0.35.0', error: '' });
    await sleep(20);
    check('ready package offers restart as the sole primary installation action', () =>
      primary().length === 1 && primary()[0].textContent === '重启以更新');
    primary()[0].click();
    check('install is only requested by the explicit click', () => fixture.installs === 1);

    fixture.pushDesktop({ phase: 'ready', mode: 'portable' });
    await sleep(20);
    check('portable ready state never offers restart and explains manual replacement', () =>
      !appPanel(w).querySelector('.update-sec').textContent.includes('重启以更新') &&
      appPanel(w).querySelector('.update-sec').textContent.includes('便携版请退出应用后手动替换文件') &&
      primary().length === 1 && primary()[0].textContent === '打开下载目录');

    fixture.pushDesktop({ phase: 'idle', mode: 'development', completion: null, error: '' });
    await sleep(20);
    check('development mode is check-only, not a false install path', () =>
      appPanel(w).querySelector('.update-sec').textContent.includes('开发模式仅支持检查更新') &&
      appPanel(w).querySelectorAll('.update-fixed-actions').length === 0);

    fixture.pushDesktop({ phase: 'idle', mode: 'installed', completion: { phase: 'completed', version: '0.35.0' } });
    await sleep(20);
    check('startup completion reports the confirmed running version', () =>
      appPanel(w).querySelector('.update-sec').textContent.includes('已更新至 v0.35.0'));
    fixture.pushDesktop({ phase: 'idle', completion: null, error: '' });

    /* ---------- Pi 更新：独立检查、独立确认、独立请求 ---------- */
    const piCheck = () => piPanel(w).querySelector('.update-head .btn');
    fixture.piUpdate = {
      ok: true, phase: 'available', currentVersion: '0.87.0', latestVersion: '1.0.0',
      updateAvailable: true, verification: 'unverified', canUpdate: true, reason: null, cached: false, running: false,
    };
    const beforePiCheck = fixture.piUpdateCalls.length;
    piCheck().click();
    await sleep(20);
    check('Pi update has its own check endpoint and shows target/current versions', () =>
      fixture.piUpdateCalls.length === beforePiCheck + 1 &&
      fixture.piUpdateCalls.at(-1).method === 'GET' &&
      piPanel(w).querySelector('.update-sec').textContent.includes('新版本 1.0.0 可用') &&
      piPanel(w).querySelector('.update-sec').textContent.includes('Pi 0.87.0') &&
      $ (w, 'piUpdateDot').hidden === false);

    check('Pi update is never merged into the pi-GUI update action', () =>
      fixture.installs === 1 &&
      [...piPanel(w).querySelectorAll('.update-sec button')].some((b) => b.textContent === '更新到 1.0.0') &&
      ![...appPanel(w).querySelectorAll('.update-sec button')].some((b) => b.textContent === '更新到 1.0.0'));

    const piUpdateButton = () => [...piPanel(w).querySelectorAll('.update-sec button')].find((b) => b.textContent === '更新到 1.0.0');
    piUpdateButton().click();
    await sleep(20);
    check('Pi update requires confirmation that names both versions and the warning', () => {
      const text = $ (w, 'confirmCard').textContent;
      return $ (w, 'confirmLayer').hidden === false &&
        text.includes('更新 Pi 到 1.0.0？') &&
        text.includes('当前 Pi：0.87.0') &&
        text.includes('目标 Pi：1.0.0') &&
        text.includes('尚未经过 Pi GUI 的完整兼容验收');
    });
    [...$ (w, 'confirmCard').querySelectorAll('button')].find((b) => b.textContent === '取消').click();
    await sleep(20);
    check('cancelling the Pi confirmation sends no update request', () =>
      !fixture.piUpdateCalls.some((call) => call.method === 'POST'));

    piUpdateButton().click();
    await sleep(20);
    [...$ (w, 'confirmCard').querySelectorAll('button')].find((b) => b.textContent === '更新').click();
    await sleep(20);
    check('confirmed Pi update posts confirm:true and enters a busy phase', () => {
      const post = fixture.piUpdateCalls.find((call) => call.method === 'POST');
      const busyButton = [...piPanel(w).querySelectorAll('.update-sec button')].find((b) => b.textContent === '更新中…');
      const state = w.getPiUpdateState();
      return Boolean(post) && post.body.action === 'update' && post.body.confirm === true &&
        state.phase === 'updating' && state.busy === true &&
        piCheck().disabled === true && busyButton?.disabled === true;
    });
    w.resetPiUpdate();
    fixture.piUpdate = { ok: true, phase: 'latest', currentVersion: '0.87.0', latestVersion: '0.87.0', updateAvailable: false, verification: 'verified', canUpdate: false, reason: 'latest', cached: false, running: false };
    await w.checkPiUpdate({ force: true });
    await sleep(20);
    check('Pi dot turns off when there is no update', () => $ (w, 'piUpdateDot').hidden === true);

    /* ---------- 关闭重开：状态保持，不重复请求 ---------- */
    fixture.update = {
      ok: true, currentVersion: '0.34.0', latestVersion: '0.35.0', updateAvailable: true,
      release: { tag: 'v0.35.0', notes: 'notes', url: 'https://github.com/HYJ1817/pi-gui/releases/tag/v0.35.0', assets: [] },
    };
    appCheck().click();
    await sleep(20);
    const updateCallsBeforeReopen = fixture.updateCalls.length;
    const piCallsBeforeReopen = fixture.piUpdateCalls.length;
    $ (w, 'settingsReturn').click();
    await sleep(20);
    card = await openInfo(w);
    await sleep(20);
    check('closing and reopening the page keeps both update states without re-checking', () =>
      appPanel(w).querySelector('.update-sec').textContent.includes('发现新版本 v0.35.0') &&
      fixture.updateCalls.length === updateCallsBeforeReopen &&
      fixture.piUpdateCalls.length === piCallsBeforeReopen);

    /* ---------- 信息页 / 诊断页不争用同一个更新容器 ---------- */
    fixture.pushDesktop({ phase: 'downloading', received: 25, total: 100, speed: 5, mode: 'installed' });
    await sleep(20);
    const infoBox = appPanel(w).querySelector('.update-sec');
    check('the visible info page receives desktop update state', () =>
      infoBox.textContent.includes('25%'));
    $ (w, 'navDiagnostics').click();
    await sleep(80);
    const diagnosticsBox = d.querySelector('.settings-detail-card .update-sec');
    check('opening diagnostics disposes the info page and mounts a separate update box', () =>
      Boolean(diagnosticsBox) && infoBox.isConnected === false && diagnosticsBox !== infoBox);
    const infoTextBefore = infoBox.textContent;
    fixture.pushDesktop({ phase: 'failed', error: '诊断页刷新失败态' });
    await sleep(20);
    check('desktop state repaints only the connected diagnostics container', () =>
      diagnosticsBox.textContent.includes('诊断页刷新失败态') &&
      infoBox.textContent === infoTextBefore);
    $ (w, 'settingsReturn').click();
    await sleep(20);
    card = await openInfo(w);
    await sleep(20);
    check('reopening info sees the latest shared update state', () =>
      appPanel(w).querySelector('.update-sec').textContent.includes('诊断页刷新失败态'));
    fixture.pushDesktop({ phase: 'idle', completion: null, error: '', mode: 'installed' });

    /* ---------- 日志、导出、诊断快捷入口 ---------- */
    card.querySelector('[data-about-action="open-logs"]').click();
    await sleep(80);
    check('open logs navigates to the existing logs detail and keeps its overview', () =>
      $ (w, 'navLogs').getAttribute('aria-current') === 'page' &&
      $ (w, 'ui5-log-tab-overview').getAttribute('aria-selected') === 'true' &&
      Boolean(d.querySelector('.ui5-logs-summary')));

    $ (w, 'settingsReturn').click();
    await sleep(20);
    card = await openInfo(w);
    card.querySelector('[data-about-action="export-report"]').click();
    await sleep(80);
    check('export report navigates to the existing export tab', () =>
      $ (w, 'navLogs').getAttribute('aria-current') === 'page' &&
      $ (w, 'ui5-log-tab-export').getAttribute('aria-selected') === 'true' &&
      Boolean(d.querySelector('.ui5-logs-export-form')));

    $ (w, 'settingsReturn').click();
    await sleep(20);
    card = await openInfo(w);
    card.querySelector('[data-about-action="open-diagnostics"]').click();
    await sleep(80);
    check('diagnostics quick entry opens the existing diagnostics page', () =>
      $ (w, 'navDiagnostics').getAttribute('aria-current') === 'page' &&
      Boolean(d.querySelector('.settings-detail-card .diag-body, .settings-detail-card .diag-note, .settings-detail-card .ext-sec-head')));

    /* ---------- 反馈：安全外链，不自动上传 ---------- */
    $ (w, 'settingsReturn').click();
    await sleep(20);
    card = await openInfo(w);
    fixture.externalOpens.length = 0;
    const hrefBefore = w.location.href;
    card.querySelector('[data-about-action="open-github"]').click();
    await sleep(20);
    check('feedback opens exactly the GitHub Issues URL through the safe bridge', () =>
      fixture.externalOpens.length === 1 && fixture.externalOpens[0] === ISSUES_URL &&
      w.location.href === hrefBefore);

    /* ---------- 重启：确认 / 流式警告 / 取消 / 真实失败 ---------- */
    w.S.streaming = true;
    const restart = () => card.querySelector('[data-about-action="restart-pi"]');
    restart().click();
    await sleep(20);
    check('restart reuses the existing confirmation and warns about interrupting a stream', () =>
      $ (w, 'confirmLayer').hidden === false &&
      $ (w, 'confirmCard').textContent.includes('重启 pi？') &&
      $ (w, 'confirmCard').textContent.includes('正在生成回答，重启会中断这一轮') &&
      restart().disabled === true);
    [...$ (w, 'confirmCard').querySelectorAll('button')].find((b) => b.textContent === '取消').click();
    await sleep(20);
    check('cancelling restart sends no restart request and re-enables the row', () =>
      fixture.restartCalls === 0 && restart().disabled === false);

    w.S.streaming = false;
    fixture.restartResult = { ok: false, error: '重启请求失败（测试）' };
    restart().click();
    await sleep(20);
    [...$ (w, 'confirmCard').querySelectorAll('button')].find((b) => b.textContent === '重启 pi').click();
    await sleep(40);
    check('restart failure keeps the real backend error and does not claim success', () =>
      fixture.restartCalls === 1 && $ (w, 'toasts').textContent.includes('重启请求失败（测试）'));

    fixture.restartResult = { ok: true };
    restart().click();
    await sleep(20);
    [...$ (w, 'confirmCard').querySelectorAll('button')].find((b) => b.textContent === '重启 pi').click();
    await sleep(40);
    check('confirmed restart reaches the single existing /api/restart endpoint', () =>
      fixture.restartCalls === 2 && restart().disabled === false);

    /* ---------- 通知点文案指向信息页 ---------- */
    $ (w, 'toasts').innerHTML = '';
    fixture.update = { ok: true, currentVersion: '0.34.0', latestVersion: '0.40.0', updateAvailable: true };
    w.cancelUpdateAuto();
    w.initUpdateAuto({ delayMs: 0 });
    await sleep(40);
    check('app update auto-check lights the migrated info dot from the single state source', () =>
      $ (w, 'menuUpdateDot').hidden === false &&
      w.getUpdateState().latestVersion === '0.40.0');

    $ (w, 'toasts').innerHTML = '';
    w.resetPiUpdate();
    fixture.piUpdate = { ok: true, phase: 'available', currentVersion: '0.87.0', latestVersion: '1.2.0', updateAvailable: true, verification: 'unverified', canUpdate: true, reason: null, cached: false, running: false };
    w.cancelPiUpdateAuto();
    w.initPiUpdateAuto({ delayMs: 0 });
    await sleep(40);
    check('Pi update auto-check lights only the Pi dot and leaves the app update state untouched', () =>
      $ (w, 'piUpdateDot').hidden === false &&
      w.getPiUpdateState().latestVersion === '1.2.0' &&
      w.getUpdateState().latestVersion === '0.40.0');
  } finally {
    w.resetPiUpdate();
    w.cancelUpdateAuto();
    w.cancelPiUpdateAuto();
    dom.window.close();
  }
  console.log(`\nAbout/info page ${checks}/${checks} checks passed.`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
