/* 首次环境向导的展示模型 + 真实 DOM 流程（jsdom）。
 *
 * 两层：
 *   1. `public/environment-setup-model.js` 是纯函数：阶段、百分比、选择校验、
 *      验证条目、自动弹出条件。这些与 DOM 无关，直接跑。
 *   2. 用 jsdom 装载**真实的** environment-setup.js，配一份最小应用骨架，
 *      把「检查 → 确认 → 安装 → 验证 → 完成」整条链路走一遍。
 *      后端与 SSE 用内存替身：不联网、不 spawn、不写用户数据。
 *
 * jsdom 不做布局，所以这里**不冒充**排版验收；颜色、间距、实际窗口尺寸由
 * 真实渲染截图负责（见交付报告）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (err) {
    fail++;
    console.log('  FAIL ' + name + '  → ' + (err && err.message ? err.message : err));
  }
}
function section(title) { console.log('\n--- ' + title + ' ---'); }

function missingReport() {
  const report = {
    ok: true,
    requiredReady: false,
    ready: false,
    needsSetup: true,
    firstRun: true,
    shouldPrompt: true,
    setup: { completedAt: null, lastRequiredReady: null, skippedOptionalAt: null, piBinOverride: null, piBinSource: 'none' },
    components: {
      node: { id: 'node', kind: 'required', status: 'ready', present: true, version: '24.22.1', minimum: '22.19.0', meetsMinimum: true, source: 'system', executable: '…\\node.exe', npm: { present: true, version: '11.6.0', prefixKnown: true, status: 'ready' }, electron: { known: true, version: '24.22.1' }, warnings: [], action: 'none', installAvailable: false, detail: 'Node.js 24.22.1 可用。' },
      pi: { id: 'pi', kind: 'required', status: 'needs-install', present: false, version: null, source: 'none', locked: false, executable: null, executableLabel: null, rpc: { state: 'skipped', code: null, ms: null }, action: 'install-pi', installAvailable: true, installSource: 'npm 官方包 @earendil-works/pi-coding-agent', warnings: [], detail: '尚未找到 Pi。' },
      git: { id: 'git', kind: 'recommended', status: 'needs-install', present: false, version: null, source: 'none', action: 'install-git', installAvailable: true, installSource: 'Git for Windows 官方 MinGit', warnings: [], detail: '没有找到 Git；它不影响 Pi 的基本使用。' },
    },
    items: [],
    plan: {
      planId: 'plan-' + 'b'.repeat(20),
      steps: ['pi', 'git'],
      required: ['pi'],
      optional: ['git'],
      requiresAdmin: false,
      scope: 'user',
      installRoot: '%LOCALAPPDATA%\\pi-gui\\runtime',
      targetWritable: true,
      components: [
        { id: 'pi', kind: 'required', version: 'latest', source: 'npm 官方包 @earendil-works/pi-coding-agent', scope: '当前用户' },
        { id: 'git', kind: 'recommended', version: '2.56.1', source: 'Git for Windows 官方 MinGit', scope: '当前用户' },
      ],
      piLocked: false,
    },
    install: { supported: true, busy: false, job: null, lastJob: null, interrupted: null, canInstall: true, requiresAdmin: false, scope: 'user' },
    notes: [],
  };
  report.items = [report.components.node, report.components.pi, report.components.git];
  return report;
}

function readyReport() {
  const report = missingReport();
  report.requiredReady = true;
  report.ready = true;
  report.needsSetup = false;
  report.firstRun = false;
  report.shouldPrompt = false;
  report.plan = { ...report.plan, steps: [], required: [], optional: [], components: [] };
  report.components.pi = {
    ...report.components.pi,
    status: 'ready', present: true, version: '1.5.2', source: 'managed',
    executable: '…\\pi.cmd', executableLabel: 'pi.cmd',
    rpc: { state: 'ready', code: null, checkedAt: '2026-11-15T00:00:00.000Z', ms: 790 },
    action: 'none', installAvailable: false, detail: 'Pi 已安装，RPC 可以启动。',
  };
  report.components.git = {
    ...report.components.git,
    status: 'ready', present: true, version: '2.53.0', source: 'system', action: 'none', installAvailable: false,
  };
  report.install = { ...report.install, canInstall: false, job: null, lastJob: null };
  report.items = [report.components.node, report.components.pi, report.components.git];
  return report;
}

function makeJob(patch = {}) {
  return {
    id: 'job-1',
    state: 'running',
    phase: 'preparing',
    current: 'pi',
    startedAt: '2026-11-15T00:00:00.000Z',
    finishedAt: null,
    completedSteps: 0,
    totalSteps: 2,
    requiresAdmin: false,
    scope: 'user',
    components: [
      { id: 'pi', label: 'Pi', kind: 'required', status: 'running', phase: 'downloading', version: null, progress: { phase: 'downloading', receivedBytes: 1024, totalBytes: 4096, percent: 25 }, errorCode: null, error: null },
      { id: 'git', label: 'Git', kind: 'recommended', status: 'pending', phase: 'pending', version: null, progress: null, errorCode: null, error: null },
    ],
    warnings: [],
    errorCode: null,
    error: null,
    result: null,
    ...patch,
  };
}

(async () => {
  const model = await import('../public/environment-setup-model.js');

  section('纯展示模型');

  await check('未知状态有中性文案，不吞掉', () => {
    assert.equal(model.statusLabel('ready'), '已就绪');
    assert.equal(model.statusLabel('needs-install'), '需要安装');
    assert.equal(model.statusLabel('weird'), '未知');
    assert.equal(model.kindLabel('required'), '必需');
    assert.equal(model.kindLabel('recommended'), '推荐');
    assert.equal(model.kindLabel(undefined), '可选');
    assert.equal(model.phaseLabel('downloading'), '下载中');
    assert.equal(model.phaseLabel('nope'), '');
  });

  await check('字节格式化与任务进度边界', () => {
    assert.equal(model.formatBytes(0), '0 B');
    assert.equal(model.formatBytes(1536), '1.5 KB');
    assert.equal(model.formatBytes(5 * 1024 * 1024), '5.0 MB');
    assert.equal(model.formatBytes(-1), '');
    assert.equal(model.formatBytes(NaN), '');
    assert.equal(model.jobPercent({ totalSteps: 4, completedSteps: 2 }), 50);
    assert.equal(model.jobPercent({ totalSteps: 0, completedSteps: 0 }), 0);
    assert.equal(model.jobPercent({ totalSteps: 2, completedSteps: 99 }), 100);
    assert.equal(model.isJobActive({ state: 'cancelling' }), true);
    assert.equal(model.isJobTerminal({ state: 'succeeded' }), true);
    assert.equal(model.isJobTerminal({ state: 'running' }), false);
  });

  await check('当前组件与任务结束后去向', () => {
    const job = makeJob();
    assert.equal(model.activeComponent(job).id, 'pi');
    assert.equal(model.activeComponent({ ...job, current: null }), job.components[0]);
    assert.equal(model.activeComponent(null), null);
    assert.equal(model.nextPhaseAfterJob({ state: 'succeeded' }), model.ENV_PHASES.VERIFYING);
    assert.equal(model.nextPhaseAfterJob({ state: 'cancelled' }), model.ENV_PHASES.CHECK);
    assert.equal(model.nextPhaseAfterJob({ state: 'failed' }), model.ENV_PHASES.ERROR);
  });

  await check('选择：必需项不可漏，Git 可跳过，未知项拒绝', () => {
    const report = missingReport();
    assert.deepEqual(model.selectableComponents(report).map((c) => c.id), ['pi', 'git']);
    assert.deepEqual(model.defaultSelection(report, true), ['pi', 'git']);
    assert.deepEqual(model.defaultSelection(report, false), ['pi']);
    assert.equal(model.selectionError(report, ['pi', 'git']), null);
    assert.equal(model.selectionError(report, ['pi']), null);
    assert.equal(model.selectionError(report, ['git']), 'missing-required');
    assert.equal(model.selectionError(report, ['pi', 'python']), 'unknown');
    assert.equal(model.selectionError(report, []), 'empty');
  });

  await check('验证页：必需项未过 → 未通过；Git 缺失 → 可跳过', () => {
    const ready = model.verificationItems(readyReport());
    assert.equal(ready.length, 5);
    assert.equal(ready.every((item) => item.ok), true);
    const partial = model.verificationItems({
      ...missingReport(),
      components: {
        ...missingReport().components,
        pi: { ...missingReport().components.pi, rpc: { state: 'failed', ms: 12000 } },
      },
    });
    assert.equal(partial.find((item) => item.id === 'pi').ok, false);
    assert.equal(partial.find((item) => item.id === 'pi-rpc').ok, false);
    assert.equal(partial.find((item) => item.id === 'git').required, false);
    assert.equal(partial.find((item) => item.id === 'node').ok, true);

    const noNpm = model.verificationItems({
      ...readyReport(),
      components: {
        ...readyReport().components,
        node: { ...readyReport().components.node, npm: { present: false, version: null, status: 'missing' } },
      },
    }).find((item) => item.id === 'npm');
    assert.equal(noNpm.ok, false);
    assert.equal(noNpm.required, false);
    assert.match(noNpm.detail, /只影响安装与更新/);
  });

  await check('自动弹出：只在缺必需项或上次任务未结束时', () => {
    assert.equal(model.shouldAutoOpen(missingReport()), true);
    assert.equal(model.shouldAutoOpen(readyReport()), false);
    assert.equal(model.shouldAutoOpen({ ...readyReport(), install: { busy: true } }), true);
    assert.equal(model.shouldAutoOpen(null), false);
    assert.equal(model.shouldAutoOpen({ ...readyReport(), requiredReady: false }), true);
  });

  section('真实 DOM 流程');

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <div id="modal" hidden><div id="modalCard" class="modal-card"></div></div>
    <div id="confirmLayer" hidden><div id="confirmCard" class="modal-card"></div></div>
    <div id="toasts"></div>
    <span id="settingsEnvironmentDot" hidden></span>
  </body></html>`, { url: 'http://127.0.0.1/', pretendToBeVisual: true });
  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.navigator = window.navigator;
  global.Element = window.Element;
  global.HTMLElement = window.HTMLElement;
  global.Node = window.Node;
  global.Event = window.Event;
  global.CustomEvent = window.CustomEvent;
  global.getComputedStyle = window.getComputedStyle.bind(window);

  const apiCalls = [];
  let currentReport = missingReport();
  let verifyReport = readyReport();
  let installJob = makeJob();
  global.fetch = async (url, options = {}) => {
    const target = new URL(String(url), 'http://127.0.0.1');
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    apiCalls.push({ path: target.pathname, method, body });
    let payload;
    if (target.pathname === '/api/environment' && method === 'GET') {
      payload = { ok: true, environment: currentReport };
    } else if (target.pathname === '/api/environment/recheck') {
      currentReport = verifyReport;
      payload = { ok: true, environment: verifyReport };
    } else if (target.pathname === '/api/environment/install') {
      const wanted = new Set(body.components);
      const components = installJob.components.filter((component) => wanted.has(component.id));
      payload = { ok: true, job: { ...installJob, components, totalSteps: components.length } };
    } else if (target.pathname === '/api/environment/job') {
      payload = { ok: true, job: installJob };
    } else if (target.pathname === '/api/environment/ack') {
      currentReport = verifyReport;
      payload = { ok: true, environment: verifyReport };
    } else if (target.pathname === '/api/status') {
      payload = { ok: true };
    } else {
      payload = { ok: false, error: 'unexpected ' + target.pathname };
    }
    return { ok: true, status: 200, json: async () => payload };
  };

  const confirmCalls = [];
  window.piGuiDesktop = {
    environmentSetup: {
      install: async (planId, ids) => {
        confirmCalls.push({ planId, components: ids.slice() });
        const components = installJob.components.filter(component => ids.includes(component.id));
        return { ok: true, job: { ...installJob, components, totalSteps: components.length } };
      },
    },
  };

  const wizard = await import('../public/environment-setup.js');

  const textButton = (text) => [...document.querySelectorAll('button')]
    .find((button) => button.textContent.trim() === text);
  const waitFor = async (predicate, timeoutMs = 4000) => {
    const started = Date.now();
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  };

  await check('首次启动自动弹出，区分必需 / 推荐，且只有一个主动作', async () => {
    await wizard.initEnvironmentSetup();
    await waitFor(() => document.querySelectorAll('.env-row').length === 3);
    assert.equal(document.getElementById('modal').hidden, false);
    assert.equal(document.getElementById('modalCard').getAttribute('role'), 'dialog');
    assert.equal(document.getElementById('modalCard').getAttribute('aria-labelledby'), 'envTitle');
    const rows = [...document.querySelectorAll('.env-row')];
    assert.equal(rows.length, 3);
    assert.ok(rows[0].textContent.includes('Node.js'));
    assert.ok(rows[0].textContent.includes('必需'));
    assert.ok(rows[1].textContent.includes('Pi Coding Agent'));
    assert.ok(rows[1].textContent.includes('需要安装'));
    assert.ok(rows[2].textContent.includes('Git'));
    assert.ok(rows[2].textContent.includes('推荐'));
    const current = document.querySelector('.env-step.is-current');
    assert.equal(current.dataset.index, '0');
    assert.ok(textButton('一键安装缺失依赖'));
    assert.equal(textButton('进入 Pi GUI'), undefined);
    assert.equal(document.getElementById('settingsEnvironmentDot').hidden, false);
  });

  await check('确认页列出组件、来源与用户级范围，默认包含推荐项', async () => {
    textButton('一键安装缺失依赖').click();
    await waitFor(() => document.querySelectorAll('.env-confirm-row').length === 2);
    const rows = [...document.querySelectorAll('.env-confirm-row')];
    assert.ok(rows[0].textContent.includes('Pi Coding Agent'));
    assert.ok(rows[1].textContent.includes('Git'));
    assert.ok(document.body.textContent.includes('不需要管理员权限'));
    const checkbox = document.querySelector('.env-check input');
    assert.equal(checkbox.checked, true);
    checkbox.checked = false;
    checkbox.dispatchEvent(new window.Event('change'));
    await waitFor(() => document.querySelectorAll('.env-confirm-row').length === 1);
    assert.ok(textButton('开始安装'));
  });

  await check('桌面开始安装只调用具名 IPC，绑定计划与所选组件', async () => {
    textButton('开始安装').click();
    await waitFor(() => confirmCalls.length === 1);
    assert.deepEqual(confirmCalls[0], { planId: currentReport.plan.planId, components: ['pi'] });
    await waitFor(() => document.querySelectorAll('.env-install-row').length === 1);
    assert.equal(apiCalls.some(call => call.path === '/api/environment/install'), false);
    const steps = [...document.querySelectorAll('.env-step')];
    assert.equal(steps.findIndex((step) => step.classList.contains('is-current')), 2);
  });

  await check('进度页显示组件、阶段与字节进度，隐藏原始命令输出', async () => {
    wizard.observeEnvironmentEvent({ type: 'environment_job', job: makeJob({ completedSteps: 0 }) });
    await waitFor(() => document.querySelector('.env-install-phase').textContent.includes('下载中'));
    const text = document.getElementById('modalCard').textContent;
    assert.ok(text.includes('1.0 KB / 4.0 KB'));
    assert.ok(text.includes('正在安装缺失依赖'));
    assert.equal(text.includes('npm install'), false);
    assert.equal(text.includes('--prefix'), false);
    assert.equal(text.includes('C:\\'), false);
  });

  await check('任务成功后自动进入验证页，必需项全部通过', async () => {
    wizard.observeEnvironmentEvent({
      type: 'environment_job',
      job: makeJob({ state: 'succeeded', phase: 'done', current: null, completedSteps: 2, components: makeJob().components.map((c) => ({ ...c, status: 'done', phase: 'done', progress: null })) }),
    });
    await waitFor(() => document.querySelectorAll('.env-verify-row').length === 5);
    const rows = [...document.querySelectorAll('.env-verify-row')];
    assert.deepEqual(rows.map((row) => row.querySelector('.env-verify-name').textContent),
      ['Node.js', 'npm', 'Pi Coding Agent', 'Pi RPC 启动', 'Git']);
    assert.equal(rows.filter((row) => row.textContent.includes('通过')).length, 5);
    assert.ok(textButton('进入 Pi GUI'));
    assert.equal(document.getElementById('settingsEnvironmentDot').hidden, true);
    const verifyCall = apiCalls.find((call) => call.path === '/api/environment/recheck');
    assert.ok(verifyCall);
  });

  await check('完成向导会记录状态并关闭弹层', async () => {
    textButton('进入 Pi GUI').click();
    await waitFor(() => document.getElementById('modal').hidden === true);
    const ack = apiCalls.find((call) => call.path === '/api/environment/ack');
    assert.ok(ack);
    assert.equal(ack.body.completed, true);
    assert.equal(ack.body.skippedOptional, true);
    assert.equal(document.getElementById('modalCard').innerHTML, '');
  });

  await check('向导关闭期间安装失败：重新打开保留失败原因，不回到旧报告', async () => {
    const failed = makeJob({
      id: 'job-background-failed',
      state: 'failed',
      phase: 'failed',
      current: null,
      errorCode: 'download-failed',
      error: '下载失败，请检查网络后重试。',
      components: makeJob().components.map((component) => ({ ...component, status: 'failed', phase: 'failed', errorCode: 'download-failed', error: '下载失败，请检查网络后重试。' })),
    });
    wizard.observeEnvironmentEvent({ type: 'environment_job', job: failed });
    wizard.openEnvironmentSettings();
    await waitFor(() => document.getElementById('modal').hidden === false);
    await waitFor(() => document.getElementById('modalCard').textContent.includes('下载失败，请检查网络后重试。'));
    assert.equal(textButton('重试') !== undefined, true);
    assert.equal(textButton('一键安装缺失依赖'), undefined);
  });

  await check('向导关闭期间安装成功：重新打开会重新检测并显示验证结果', async () => {
    const succeeded = makeJob({
      id: 'job-background-succeeded',
      state: 'succeeded',
      phase: 'done',
      current: null,
      completedSteps: 2,
      components: makeJob().components.map((component) => ({ ...component, status: 'done', phase: 'done', progress: null })),
    });
    wizard.observeEnvironmentEvent({ type: 'environment_job', job: succeeded });
    wizard.openEnvironmentSettings();
    await waitFor(() => document.querySelectorAll('.env-verify-row').length === 5);
    assert.ok(textButton('进入 Pi GUI'));
  });

  section('静态边界');

  await check('设置菜单有入口，样式与脚本都进页面', () => {
    const html = read('public/index.html');
    assert.ok(html.includes('id="navEnvironment"'));
    assert.ok(html.includes('href="/environment-setup.css"'));
    assert.ok(html.includes('id="settingsEnvironmentDot"'));
    const app = read('public/app.js');
    assert.ok(app.includes("evt.type === 'environment_job'"));
    assert.ok(app.includes('initEnvironmentSetup()'));
    assert.ok(app.includes("$('navEnvironment').onclick"));
    const preload = read('electron/preload.cjs');
    assert.match(preload, /install: \(planId, components\) => ipcRenderer.invoke\('pi-gui:environment-install'/);
    assert.equal(preload.includes('environment-confirm'), false);
  });

  await check('向导 CSS 只用语义 Token，没有写死颜色', () => {
    const css = read('public/environment-setup.css');
    assert.equal(/#[0-9a-f]{3,8}\b/i.test(css), false);
    assert.equal(/rgba?\(/i.test(css), false);
    assert.ok(css.includes('var(--ds-text-primary)'));
    assert.ok(css.includes('var(--ui-danger-border)'));
    assert.ok(css.includes('prefers-reduced-motion'));
    assert.ok(css.includes('max-width: 520px'));
  });

  console.log(`\nEnvironment UI: ${pass}/${pass + fail} passed; failed=${fail}; skipped=0; jsdom not pixel acceptance`);
  process.exit(fail ? 1 : 0);
})();
