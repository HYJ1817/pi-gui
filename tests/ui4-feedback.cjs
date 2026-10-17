/* UI-4C: toast/notice contracts, offline jsdom plus real Electron (--electron). */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs/claude-ui-redesign/ui4c-evidence');
const checks = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { checks.push({ name, pass: true }); console.log('PASS ' + name); })
    .catch((error) => { checks.push({ name, pass: false, error: error.message }); console.error('FAIL ' + name + ': ' + error.message); });
}

function finish(extra = {}) {
  const failed = checks.filter((item) => !item.pass).length;
  fs.mkdirSync(OUT, { recursive: true });
  const file = process.versions.electron ? 'electron.json' : 'unit.json';
  fs.writeFileSync(path.join(OUT, file), JSON.stringify({ passed: checks.length - failed, failed, skipped: 0, checks, ...extra }, null, 2));
  console.log(`UI4 Feedback: ${checks.length - failed}/${checks.length}, failed=${failed}, skipped=0`);
  return failed ? 1 : 0;
}

async function unit() {
  const { JSDOM } = require('jsdom');
  const { bundle } = require('./esm-bundle.cjs');
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'), {
    url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  const d = w.document;
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.eval(bundle(path.join(ROOT, 'public/ui/notice.js')).code);

  const host = d.getElementById('toasts');
  const input = d.getElementById('input');
  const clear = () => { host.replaceChildren(); };
  const nodes = () => [...host.querySelectorAll('.toast')];

  await check('stylesheet injected once and served from the owned file', () => {
    const links = [...d.querySelectorAll('link[data-ui4-feedback]')];
    assert.equal(links.length, 1);
    assert.equal(links[0].getAttribute('href'), '/ui4-feedback.css');
    assert.equal(w.ensureFeedbackStyles(), true);
    assert.equal(d.querySelectorAll('link[data-ui4-feedback]').length, 1);
  });

  await check('info toast auto closes after its explicit short duration', async () => {
    clear();
    w.toast('已复制', 'info', { duration: 20 });
    assert.equal(nodes().length, 1);
    assert.equal(nodes()[0].dataset.kind, 'info');
    assert.equal(nodes()[0].getAttribute('role'), 'status');
    await wait(80);
    assert.equal(nodes()[0].dataset.leaving, 'true');
    await wait(200);
    assert.equal(nodes().length, 0);
  });

  await check('success and ok aliases share one success treatment', () => {
    clear();
    w.toast('已保存', 'success', { duration: 5000 });
    w.toast('计划已生成', 'ok', { duration: 5000 });
    assert.deepEqual(nodes().map((node) => node.dataset.kind), ['success', 'success']);
    assert.ok(nodes()[0].classList.contains('ui4-feedback-toast-success'));
  });

  await check('warning and warn aliases keep the legacy .toast.warn hook', () => {
    clear();
    w.toast('当前模型不支持图片', 'warning', { duration: 5000 });
    w.toast('切换前先停止', 'warn', { duration: 5000 });
    assert.deepEqual(nodes().map((node) => node.dataset.kind), ['warning', 'warning']);
    assert.ok(nodes().every((node) => node.classList.contains('warn') && node.classList.contains('ui4-feedback-toast-warning')));
    assert.equal(nodes()[0].querySelector('.ui4-feedback-toast-close').getAttribute('aria-label'), '关闭通知');
  });

  await check('error toast is persistent by default and never becomes invisible silently', async () => {
    clear();
    w.toast('命令执行失败，请重试。', 'error');
    const node = nodes()[0];
    assert.equal(node.getAttribute('role'), 'alert');
    assert.ok(node.classList.contains('error'));
    await wait(120);
    assert.equal(nodes().length, 1);
    assert.equal(node.dataset.leaving, undefined);
    assert.equal(node.querySelector('.ui4-feedback-toast-body').textContent, '命令执行失败，请重试。');
  });

  await check('persistent=false opts back into the timed error path', async () => {
    clear();
    w.toast('可自行消失的校验错误', 'error', { duration: 20 });
    await wait(80);
    assert.equal(nodes()[0].dataset.leaving, 'true');
    await wait(200);
    assert.equal(nodes().length, 0);
  });

  await check('multiple notifications queue without replacing each other', () => {
    clear();
    w.toast('第一条', 'info', { duration: 5000 });
    w.toast('第二条', 'success', { duration: 5000 });
    w.toast('第三条', 'error');
    assert.deepEqual(nodes().map((node) => node.textContent), ['第一条', '第二条', '第三条']);
  });

  await check('duplicate notification inside the dedupe window is suppressed', () => {
    clear();
    w.toast('重复通知', 'info', { duration: 5000 });
    w.toast('重复通知', 'info', { duration: 5000 });
    assert.equal(nodes().length, 1);
  });

  await check('long Chinese and long English text stay complete and wrapped', () => {
    clear();
    const chinese = '这是一条很长的中文通知。'.repeat(60);
    const english = 'A'.repeat(200) + ' ' + 'unbroken'.repeat(40);
    w.toast(chinese, 'warn', { duration: 5000 });
    w.toast(english, 'error');
    const bodies = nodes().map((node) => node.querySelector('.ui4-feedback-toast-body'));
    assert.equal(bodies[0].textContent, chinese);
    assert.equal(bodies[1].textContent, english);
    assert.ok(nodes().every((node) => node.querySelector('.ui4-feedback-toast-body')));
  });

  await check('untrusted text is inert in toasts and action labels', () => {
    clear();
    let ran = 0;
    w.toast('<img src=x onerror="window.__xss=1">', 'error', {
      action: { label: '<b>打开</b>', run: () => { ran++; } },
    });
    const node = nodes()[0];
    assert.equal(node.querySelector('img,b'), null);
    assert.ok(node.querySelector('.ui4-feedback-toast-body').textContent.includes('<img'));
    assert.equal(node.querySelector('.ui4-feedback-toast-action').textContent, '<b>打开</b>');
    node.querySelector('.ui4-feedback-toast-action').click();
    assert.equal(ran, 1);
    assert.equal(w.__xss, undefined);
  });

  await check('Escape closes the focused toast and returns focus to the composer', async () => {
    clear();
    input.disabled = false;
    w.toast('可以关闭', 'warn', { duration: 5000 });
    const close = nodes()[0].querySelector('.ui4-feedback-toast-close');
    close.focus();
    assert.equal(d.activeElement, close);
    close.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(220);
    assert.equal(nodes().length, 0);
    assert.equal(d.activeElement, input);
  });

  await check('toast host exposes a named region and each toast a live role', () => {
    clear();
    w.toast('区域语义', 'info', { duration: 5000 });
    assert.equal(host.getAttribute('role'), 'region');
    assert.equal(host.getAttribute('aria-label'), '通知');
    assert.equal(nodes()[0].getAttribute('role'), 'status');
  });

  await check('historical replay does not create notifications', () => {
    clear();
    w.withNotificationSource('history', () => w.toast('历史事件', 'warn'));
    assert.equal(nodes().length, 0);
  });

  await check('legacy toast call sites keep working unchanged', () => {
    clear();
    w.toast('旧调用', 'warn');
    const node = nodes()[0];
    assert.ok(node.classList.contains('toast'));
    assert.ok(node.classList.contains('warn'));
    assert.equal(node.querySelector('.ui4-feedback-toast-body').textContent, '旧调用');
  });

  await check('notice tones cover success, failure, warning, loading and unknown', () => {
    const cases = [
      ['bad', 'bad'], ['error', 'bad'], ['warn', 'warn'], ['warning', 'warn'],
      ['info', 'info'], ['success', 'ok'], ['ok', 'ok'], ['busy', 'busy'], ['loading', 'busy'],
      ['unknown', 'unknown'], ['unsupported', 'unknown'], ['mystery', 'unknown'], [undefined, 'info'],
    ];
    for (const [input, expected] of cases) {
      const model = { id: 'tone-' + String(input), tone: input, title: '状态 ' + String(input) };
      assert.equal(w.showNotice(model), true);
      assert.equal(d.getElementById('stageNotice').dataset.tone, expected, String(input));
      w.hideNotice();
    }
  });

  await check('unknown notice is neutral, never success or failure', () => {
    w.showNotice({ id: 'unknown-state', tone: 'unknown', title: '数据未知', detail: 'Pi 还没有返回这项信息。' });
    const box = d.getElementById('stageNotice');
    assert.equal(box.dataset.tone, 'unknown');
    assert.ok(box.classList.contains('unknown'));
    assert.ok(!box.classList.contains('ok') && !box.classList.contains('bad') && !box.classList.contains('warn'));
    assert.equal(box.querySelector('.ui4-feedback-notice-icon').getAttribute('aria-hidden'), 'true');
  });

  await check('notice shows title, multi-line detail, actions and a close control', () => {
    w.showNotice({
      id: 'pi-start-failed', tone: 'bad', title: 'pi 启动失败',
      detail: 'pi 没能启动起来。\n重启 Pi 之后可以继续用同一个会话。',
      actions: [{ label: '重启 Pi', title: '重启 pi 子进程', run: () => {} }, { label: '打开诊断', title: '查看诊断', run: () => {} }],
    });
    const box = d.getElementById('stageNotice');
    assert.equal(box.hidden, false);
    assert.equal(box.getAttribute('role'), 'alert');
    assert.equal(box.querySelector('.ui4-feedback-notice-title').textContent, 'pi 启动失败');
    assert.equal(box.querySelector('.ui4-feedback-notice-detail').textContent, 'pi 没能启动起来。\n重启 Pi 之后可以继续用同一个会话。');
    assert.deepEqual([...box.querySelectorAll('.ui4-feedback-notice-action')].map((button) => button.textContent), ['重启 Pi', '打开诊断']);
    assert.equal(box.querySelector('.notice-close').getAttribute('aria-label'), '隐藏这条提示');
    assert.equal(w.currentNoticeId(), 'pi-start-failed');
  });

  await check('notice actions call only the injected handler once', () => {
    let runs = 0;
    w.showNotice({ id: 'retry-notice', tone: 'warn', title: '读取失败，可以重试', actions: [{ label: '重新同步状态', run: () => { runs++; } }] });
    d.getElementById('stageNotice').querySelector('.ui4-feedback-notice-action').click();
    assert.equal(runs, 1);
  });

  await check('notice with the same identity/signature is not rebuilt', () => {
    const model = { id: 'stable-notice', tone: 'busy', title: '正在切换 Workspace…', detail: '等待 Pi 确认新的工作区。' };
    w.showNotice(model);
    const first = d.getElementById('stageNotice').firstElementChild;
    w.showNotice({ ...model });
    assert.equal(d.getElementById('stageNotice').firstElementChild, first);
    assert.equal(d.getElementById('stageNotice').dataset.tone, 'busy');
    assert.equal(d.getElementById('stageNotice').getAttribute('role'), 'status');
    w.showNotice({ ...model, detail: '切换用时较长，可以重新同步状态。' });
    assert.notEqual(d.getElementById('stageNotice').firstElementChild, first);
  });

  await check('notice close hides it and clears the current id', () => {
    w.showNotice({ id: 'closable', tone: 'info', title: '可以关闭' });
    d.getElementById('stageNotice').querySelector('.notice-close').click();
    assert.equal(d.getElementById('stageNotice').hidden, true);
    assert.equal(d.getElementById('stageNotice').textContent, '');
    assert.equal(w.currentNoticeId(), null);
  });

  await check('notice text and action labels are inert under XSS-shaped input', () => {
    let ran = 0;
    w.showNotice({
      id: 'xss-notice', tone: 'warn',
      title: '<img src=x onerror="window.__noticeXss=1">',
      detail: '<script>window.__noticeXss=2</script>',
      actions: [{ label: '<b>重试</b>', run: () => { ran++; } }],
    });
    const box = d.getElementById('stageNotice');
    assert.equal(box.querySelector('img,script,b'), null);
    assert.ok(box.textContent.includes('<img'));
    assert.ok(box.textContent.includes('<script>'));
    box.querySelector('.ui4-feedback-notice-action').click();
    assert.equal(ran, 1);
    assert.equal(w.__noticeXss, undefined);
  });

  await check('long Chinese and English notice content remains complete', () => {
    const chinese = '状态说明。'.repeat(80);
    const english = 'Service unavailable. '.repeat(50) + 'X'.repeat(120);
    w.showNotice({ id: 'long-notice', tone: 'bad', title: chinese, detail: english });
    const box = d.getElementById('stageNotice');
    assert.equal(box.querySelector('.ui4-feedback-notice-title').textContent, chinese);
    assert.equal(box.querySelector('.ui4-feedback-notice-detail').textContent, english);
  });

  await check('workspace switch is represented as busy, not success or failure', () => {
    w.showNotice({ id: 'workspace-switching', tone: 'busy', title: '正在切换 Workspace…', detail: '新工作区还没有确认；发送保持禁用。' });
    const box = d.getElementById('stageNotice');
    assert.equal(box.dataset.tone, 'busy');
    assert.equal(box.getAttribute('role'), 'status');
    assert.ok(!box.classList.contains('ok') && !box.classList.contains('bad'));
    w.hideNotice();
  });

  await check('state matrix copy is rendered from the supplied model only', () => {
    const matrix = [
      ['no-project', 'info', '没有项目'],
      ['pi-not-ready', 'busy', 'Pi 未就绪'],
      ['model-unavailable', 'warn', '模型不可用'],
      ['service-unavailable', 'bad', '服务不可用'],
      ['workspace-switching', 'busy', '正在切换 Workspace…'],
      ['loading', 'busy', '读取中'],
      ['retry', 'info', '可以重试'],
      ['unsupported', 'unknown', '无权限 / 不支持'],
      ['unknown', 'unknown', '数据未知'],
    ];
    for (const [id, tone, title] of matrix) {
      w.showNotice({ id: 'matrix-' + id, tone, title, detail: '来自既有事实源。' });
      const box = d.getElementById('stageNotice');
      assert.equal(box.dataset.tone, noticeExpected(tone));
      assert.equal(box.querySelector('.ui4-feedback-notice-title').textContent, title);
      w.hideNotice();
    }
  });

  await check('real startupNotice models keep their existing truth and actions', async () => {
    const copy = await import(pathToFileURL(path.join(ROOT, 'public/status-copy.js')).href);
    const cases = [
      [{ bridgeState: 'error', hasProject: true, bridgeError: 'ENOENT', bridgeHint: '检查 pi 安装' }, 'bad'],
      [{ bridgeState: 'exited', hasProject: true }, 'bad'],
      [{ bridgeState: 'maintenance', hasProject: true, maintenanceReason: 'pi-update' }, 'info'],
      [{ bridgeState: 'ready', hasProject: true, compat: { status: 'incompatible', missing: ['rpc.mode'] } }, 'warn'],
      [{ bridgeState: 'starting', hasProject: true, recoveryOverdue: true }, 'warn'],
    ];
    for (const [ctx, expected] of cases) {
      const model = copy.startupNotice(ctx);
      assert.ok(model, JSON.stringify(ctx));
      const actions = (model.actions || []).map((id) => ({
        label: copy.NOTICE_ACTIONS[id].label,
        title: copy.NOTICE_ACTIONS[id].title,
        run: () => {},
      }));
      w.showNotice({ ...model, actions });
      const box = d.getElementById('stageNotice');
      assert.equal(box.dataset.tone, expected, JSON.stringify(ctx));
      assert.equal(box.querySelector('.ui4-feedback-notice-title').textContent, model.title);
      assert.deepEqual([...box.querySelectorAll('.ui4-feedback-notice-action')].map((button) => button.textContent), actions.map((action) => action.label));
      w.hideNotice();
    }
    assert.equal(copy.startupNotice({ bridgeState: 'ready', hasProject: true }), null);
  });

  await check('CSS is owned, prefixed and respects theme/reduced-motion/motion contracts', () => {
    const css = fs.readFileSync(path.join(ROOT, 'public/ui4-feedback.css'), 'utf8');
    assert.ok(css.includes('.ui4-feedback-toast'));
    assert.ok(css.includes('.ui4-feedback-notice'));
    assert.ok(css.includes('prefers-reduced-motion: reduce'));
    assert.ok(css.includes('var(--ui-text-primary)'));
    assert.ok(css.includes('max-width: min(380px, calc(100vw - 36px), var(--ui4-toast-max, 380px))'));
    assert.ok(css.includes('--ui4-toast-bottom'));
    assert.ok(css.includes('pointer-events: auto'));
    assert.ok(!/!\s*important/.test(css));
    const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    assert.deepEqual(hex, []);
    for (const token of ['--ui-popover-surface', '--ui-danger-surface', '--ui-warning-surface', '--ui-info-surface', '--ui-success-surface']) {
      assert.ok(css.includes(token), token);
    }
    for (const selector of css.match(/\.ui4-feedback-[a-z0-9-]+/g) || []) {
      assert.match(selector, /^\.ui4-feedback-[a-z0-9-]+$/);
    }
  });

  await check('CSS keeps the legacy notice/toast hooks used by existing suites', () => {
    const css = fs.readFileSync(path.join(ROOT, 'public/ui4-feedback.css'), 'utf8');
    assert.ok(css.includes('.stage-notice'));
    assert.ok(css.includes('.ui4-feedback-notice-close'));
    assert.ok(css.includes('.msg-err'));
    assert.ok(css.includes('.rtc-notice'));
    assert.ok(css.includes('.rp-error'));
    assert.ok(css.includes('.hint-empty'));
  });

  dom.window.close();
  return finish({ command: 'node tests/ui4-feedback.cjs' });
}

function noticeExpected(tone) {
  return ({ bad: 'bad', error: 'bad', warn: 'warn', warning: 'warn', success: 'ok', ok: 'ok', busy: 'busy', loading: 'busy', unsupported: 'unknown', unknown: 'unknown' })[tone] || 'info';
}

if (!process.versions.electron && !process.argv.includes('--electron')) {
  unit().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error); process.exitCode = 1; });
} else if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'ui4-feedback-electron-'));
  const env = { ...process.env, UI4_FEEDBACK_WORLD: world };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, '--electron'], { env, stdio: 'inherit', windowsHide: false });
  child.on('error', (error) => { console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
    fs.rm(world, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }, () => {});
  });
} else {
  electron().catch((error) => { console.error(error); process.exitCode = 1; });
}

async function electron() {
  const { app, BrowserWindow } = require('electron');
  const { spawn } = require('node:child_process');
  const world = process.env.UI4_FEEDBACK_WORLD;
  app.setPath('userData', world);
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  await app.whenReady();

  let harness;
  let win;
  try {
    harness = spawn(process.execPath, [path.join(ROOT, 'tests/visual-harness.cjs')], {
      cwd: world,
      env: { ...process.env, HARNESS_PORT: '0', VISUAL_UPLOAD_DIR: path.join(world, 'uploads') },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const origin = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('harness timeout')), 15000);
      harness.stdout.on('data', (chunk) => {
        buffer += String(chunk);
        const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      harness.on('error', reject);
    });

    win = new BrowserWindow({ width: 1440, height: 900, show: true, backgroundColor: '#151515', webPreferences: { backgroundThrottling: false } });
    win.showInactive();
    const errors = [];
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2 && !message.includes('Electron Security Warning')) errors.push(message);
    });
    await win.loadURL(origin);
    await until(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('#toasts') && document.querySelector('#composerBox') && document.getElementById('welcomeRestore')?.hidden === true)`), 15000);
    await wait(600);

    const read = (code) => win.webContents.executeJavaScript(code, true);
    const shots = [];
    const shot = async (name) => {
      fs.mkdirSync(OUT, { recursive: true });
      try { win.focus(); } catch { /* hidden desktop session */ }
      try {
        await read('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
      } catch { /* page not ready */ }
      try { win.webContents.invalidate(); } catch { /* not available */ }
      await wait(250);
      await win.webContents.capturePage();
      await wait(150);
      const file = name + '.png';
      fs.writeFileSync(path.join(OUT, file), (await win.webContents.capturePage()).toPNG());
      shots.push(file);
    };
    const showToasts = (dark) => read(`(async () => {
      const suffix = ${JSON.stringify(dark ? '（深色）' : '（浅色）')};
      document.documentElement.dataset.theme = ${JSON.stringify(dark ? 'dark' : 'light')};
      const m = await import('/ui/toast.js');
      document.getElementById('toasts').replaceChildren();
      m.toast('已复制诊断摘要' + suffix, 'success');
      m.toast('当前模型不支持图片，仍可添加普通文件。' + suffix, 'warning');
      m.toast('命令执行失败：后端返回 ENOENT。' + suffix, 'error');
      m.toast('正在获取模型列表…' + suffix, 'info');
      return document.querySelectorAll('#toasts .toast').length;
    })()`);

    await check('Electron: four toast kinds render from the production module', async () => {
      assert.equal(await showToasts(true), 4);
      await wait(250);
      await shot('ui4-toasts-dark');
    });

    await check('Electron: toast stack clears the composer and never causes page overflow', async () => {
      const fact = await read(`(() => {
        const t = [...document.querySelectorAll('#toasts .toast')].map(n => n.getBoundingClientRect());
        const c = document.getElementById('chatComposer').getBoundingClientRect();
        return { page: document.documentElement.scrollWidth, width: innerWidth, toastBottom: Math.max(...t.map(r => r.bottom)), composerTop: c.top, left: Math.min(...t.map(r => r.left)), right: Math.max(...t.map(r => r.right)) };
      })()`);
      assert.ok(fact.page <= fact.width + 1, JSON.stringify(fact));
      assert.ok(fact.toastBottom <= fact.composerTop - 10, JSON.stringify(fact));
      assert.ok(fact.left >= 0 && fact.right <= fact.width + 1, JSON.stringify(fact));
    });

    await check('Electron: light theme uses the same component and stays readable', async () => {
      assert.equal(await showToasts(false), 4);
      await wait(250);
      const colors = await read(`(() => {
        const t = document.querySelector('#toasts .toast');
        return { theme: document.documentElement.dataset.theme, bg: getComputedStyle(t).backgroundColor, color: getComputedStyle(t).color, file: [...document.styleSheets].some(s => (s.href || '').includes('ui4-feedback.css')) };
      })()`);
      assert.equal(colors.theme, 'light');
      assert.equal(colors.file, true);
      assert.notEqual(colors.bg, 'rgba(0, 0, 0, 0)');
      await shot('ui4-toasts-light');
    });

    await check('Electron: persistent notice renders bad/info/busy/unknown with real layout', async () => {
      const fact = await read(`(async () => {
        const m = await import('/ui/notice.js');
        document.documentElement.dataset.theme = 'dark';
        const results = [];
        for (const tone of ['bad', 'info', 'busy', 'unknown']) {
          m.showNotice({ id: 'electron-' + tone, tone, title: '状态：' + tone, detail: '这是一段多行说明。\\n第二行保留换行，长文本按容器换行。', actions: [{ label: '打开诊断', run: () => {} }] });
          const box = document.getElementById('stageNotice');
          const r = box.getBoundingClientRect();
          const a = box.querySelector('.notice-actions');
          results.push({ tone: box.dataset.tone, width: r.width, page: document.documentElement.scrollWidth, inner: innerWidth, actionsOverflow: a.scrollWidth > a.clientWidth + 1 });
          await new Promise(r => setTimeout(r, 80));
        }
        return results;
      })()`);
      for (const item of fact) {
        assert.ok(['bad', 'info', 'busy', 'unknown'].includes(item.tone));
        assert.ok(item.page <= item.inner + 1, JSON.stringify(item));
        assert.equal(item.actionsOverflow, false, JSON.stringify(item));
      }
      await read(`(async () => { document.documentElement.dataset.theme = 'dark'; document.getElementById('toasts').replaceChildren(); const m = await import('/ui/notice.js'); m.showNotice({ id:'electron-bad-shot', tone:'bad', title:'pi 启动失败', detail:'pi 没能启动起来。\\n可以重启 Pi，或打开诊断查看原因。', actions:[{label:'重启 Pi',run:()=>{}},{label:'打开诊断',run:()=>{}}] }); })()`);
      await wait(150);
      await shot('ui4-notice-dark');
      await read(`(async () => { document.documentElement.dataset.theme = 'light'; document.getElementById('toasts').replaceChildren(); const m = await import('/ui/notice.js'); m.showNotice({ id:'electron-unknown-shot', tone:'unknown', title:'数据未知', detail:'Pi 还没有返回这项信息，界面不会把它当作成功或失败。', actions:[{label:'重新同步状态',run:()=>{}}] }); })()`);
      await wait(150);
      await shot('ui4-notice-light');
    });

    await check('Electron: empty state keeps heading, helper copy and CTA hierarchy', async () => {
      await read(`(async () => {
        document.documentElement.dataset.theme = 'dark';
        const { S } = await import('/state.js');
        const { applyProjectState } = await import('/shell.js');
        const { clearThread } = await import('/messages.js');
        S.hasProject = false;
        S.bridgeState = 'no-project';
        S.switching = false;
        S.restoring = false;
        clearThread();
        applyProjectState();
        const m = document.getElementById('stageNotice'); if (m) m.hidden = true;
        const stream = document.getElementById('stream'); if (stream) stream.scrollTop = 0;
      })()`);
      await wait(120);
      const fact = await read(`(() => {
        const pane = document.getElementById('welcomeNoProj');
        return { title: pane.querySelector('h2').textContent, helper: pane.querySelector('p').textContent, cta: Boolean(pane.querySelector('.welcome-cta')), page: document.documentElement.scrollWidth, inner: innerWidth };
      })()`);
      assert.ok(fact.title.length > 0 && fact.helper.length > 0 && fact.cta);
      assert.ok(fact.page <= fact.inner + 1);
      await shot('ui4-empty-state-dark');
      await read(`(() => { const c = document.getElementById('chatComposer'); if (c) c.hidden = false; })()`);
    });

    await check('Electron: narrow viewport and open right pane never get covered by toasts', async () => {
      win.setContentSize(700, 600);
      await wait(250);
      const before = await read(`(() => {
        const app = document.querySelector('.app');
        const pane = document.getElementById('rightPane');
        app.classList.add('rp-open');
        document.documentElement.style.setProperty('--rp-width', '320px');
        pane.hidden = false;
        pane.dataset.surface = 'browser';
        document.dispatchEvent(new CustomEvent('pi-gui:right-pane', { detail: { open: true, surface: 'browser' } }));
        const r = pane.getBoundingClientRect();
        return { inner: innerWidth, paneLeft: r.left };
      })()`);
      await read(`(async () => { const m = await import('/ui/toast.js'); document.getElementById('toasts').replaceChildren(); m.toast('窄屏下的长通知文本会换行，不会盖住 Composer 或右栏关键控件。', 'error'); })()`);
      await wait(200);
      const fact = await read(`(() => {
        const t = document.querySelector('#toasts .toast').getBoundingClientRect();
        const c = document.getElementById('chatComposer').getBoundingClientRect();
        const pane = document.getElementById('rightPane').getBoundingClientRect();
        return { toastRight: t.right, toastBottom: t.bottom, paneLeft: pane.left, composerTop: c.top, page: document.documentElement.scrollWidth, inner: innerWidth };
      })()`);
      assert.ok(fact.toastRight <= fact.paneLeft + 1, JSON.stringify({ before, fact }));
      assert.ok(fact.toastBottom <= fact.composerTop - 10, JSON.stringify(fact));
      assert.ok(fact.page <= fact.inner + 1, JSON.stringify(fact));
      await shot('ui4-narrow-right-pane');
      await read(`(() => { const app = document.querySelector('.app'); app.classList.remove('rp-open'); const pane = document.getElementById('rightPane'); pane.hidden = true; document.dispatchEvent(new CustomEvent('pi-gui:right-pane', { detail: { open: false, surface: null } })); })()`);
      win.setContentSize(1440, 900);
      await wait(200);
    });

    await check('Electron: reduced motion removes toast and spinner animation', async () => {
      try { win.webContents.debugger.attach('1.3'); } catch { /* already attached */ }
      try {
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      } catch { /* setEmulatedMedia is best effort in older Electron */ }
      await read(`(async () => { const m = await import('/ui/toast.js'); document.getElementById('toasts').replaceChildren(); m.toast('减少动效', 'info', { duration: 5000 }); })()`);
      await wait(120);
      const fact = await read(`(() => { const t = document.querySelector('#toasts .toast'); return { media: matchMedia('(prefers-reduced-motion: reduce)').matches, animation: getComputedStyle(t).animationName }; })()`);
      if (fact.media) assert.equal(fact.animation, 'none');
      try { await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }); } catch { /* ignore */ }
      try { win.webContents.debugger.detach(); } catch { /* not attached */ }
    });

    await check('Electron: keyboard Escape closes a persistent error and page has no console errors', async () => {
      await read(`(async () => { const m = await import('/ui/toast.js'); document.getElementById('toasts').replaceChildren(); m.toast('可关闭的失败', 'error'); })()`);
      await wait(100);
      const closed = await read(`(() => {
        const t = document.querySelector('#toasts .toast');
        const b = t.querySelector('.ui4-feedback-toast-close'); b.focus();
        b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      })()`);
      assert.equal(closed, true);
      await wait(250);
      assert.equal(await read(`document.querySelectorAll('#toasts .toast').length`), 0);
      assert.equal(errors.filter((line) => /ui4-feedback|toast|notice/i.test(line)).length, 0, errors.join(' | '));
    });

    await check('Electron: screenshots were written for both themes and states', () => {
      for (const name of ['ui4-toasts-dark.png', 'ui4-toasts-light.png', 'ui4-notice-dark.png', 'ui4-notice-light.png', 'ui4-empty-state-dark.png', 'ui4-narrow-right-pane.png']) {
        assert.ok(fs.existsSync(path.join(OUT, name)), name);
      }
    });

    const code = finish({ command: 'node tests/ui4-feedback.cjs --electron', screenshots: shots, origin: 'offline visual-harness', userData: world, consoleErrors: errors });
    process.exitCode = code;
    return code;
  } finally {
    try { win?.destroy(); } catch {}
    try { harness?.kill(); } catch {}
    setTimeout(() => app.quit(), 200);
  }
}

async function until(fn, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* not ready */ }
    await wait(100);
  }
  throw new Error('timeout');
}
