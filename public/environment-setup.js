/* 首次启动环境向导 —— 检查 → 确认 → 安装 → 验证。
 *
 * 它只消费两个后端真相：
 *   - `GET /api/environment` 的检测报告（只读，含脱敏路径）；
 *   - SSE `environment_job` / `GET /api/environment/job` 的安装任务。
 *
 * 前端**不执行任何系统命令**，也不拼安装参数：按钮只送组件 id 与后端给的
 * planId。真正的下载、校验、解压、npm 安装都在后端；这里负责把状态讲清楚，
 * 并在失败时把「重试 / 诊断」放在用户手边。
 *
 * 向导不是技术工具菜单：默认只出现一个主动作「一键安装缺失依赖」，Git 是
 * 可勾选的推荐项，Node/Pi 是必需项。已有 Pi（PI_BIN / 手动路径 / PATH）
 * 不会被重装。
 */
import { $ } from './state.js';
import { closeModal, openModal } from './ui/modal.js';
import { iconMarkup } from './ui/icons.js';
import { toast } from './ui/toast.js';
import { loadStatus } from './shell.js';
import { openDiagnostics } from './diagnostics.js';
import {
  fetchEnvironment, recheckEnvironment, startEnvironmentInstall, fetchEnvironmentJob,
  cancelEnvironmentInstall, setEnvironmentPiPath, ackEnvironmentSetup,
} from './api.js';
import {
  ENV_PHASES, defaultSelection, formatBytes, isJobActive, isJobTerminal,
  jobPercent, kindLabel, nextPhaseAfterJob, phaseLabel, selectableComponents, selectionError,
  shouldAutoOpen, statusLabel, verificationItems,
} from './environment-setup-model.js';

const state = {
  report: null,
  phase: ENV_PHASES.CHECKING,
  job: null,
  error: null,
  notice: null,
  includeOptional: true,
  skippedOptional: false,
  verifying: false,
  fromSettings: false,
  dismissed: false,
  openedOnce: false,
  pollTimer: null,
  handledJob: null,
  root: null,
  body: null,
  footer: null,
  steps: null,
  progress: null,
  close: null,
};

function h(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}

function icon(name, className = 'env-icon') {
  const span = h('span', className);
  span.innerHTML = iconMarkup(name);
  return span;
}

function statusTone(status) {
  if (status === 'ready' || status === 'succeeded' || status === 'done') return 'ok';
  if (status === 'needs-install' || status === 'incompatible' || status === 'failed' || status === 'cancelled') return 'warn';
  if (status === 'running' || status === 'installing' || status === 'verifying') return 'busy';
  return 'neutral';
}

function phaseIndex() {
  if ([ENV_PHASES.CHECKING, ENV_PHASES.CHECK, ENV_PHASES.ERROR].includes(state.phase)) return 0;
  if (state.phase === ENV_PHASES.CONFIRM) return 1;
  if (state.phase === ENV_PHASES.INSTALLING) return 2;
  if ([ENV_PHASES.VERIFYING, ENV_PHASES.VERIFIED].includes(state.phase)) return 3;
  return 0;
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function syncBadge() {
  const bad = Boolean(state.report && !state.report.requiredReady);
  for (const id of ['environmentDot', 'settingsEnvironmentDot']) {
    const dot = $(id);
    if (dot) dot.hidden = !bad;
  }
}

function applyReport(report) {
  if (!report || typeof report !== 'object') return;
  state.report = report;
  if (!state.job && report.install && report.install.job) state.job = report.install.job;
  if (report.install && report.install.busy && report.install.job) state.job = report.install.job;
  syncBadge();
}

function modalCard() {
  const card = $('modalCard');
  return card && !$('modal').hidden ? card : null;
}

function setBusyCard(busy) {
  const card = modalCard();
  if (!card) return;
  if (busy) card.setAttribute('aria-busy', 'true');
  else card.removeAttribute('aria-busy');
}

function clearModal() {
  stopPolling();
  state.root = null;
  state.body = null;
  state.footer = null;
  state.steps = null;
  state.progress = null;
  state.close = null;
  setBusyCard(false);
}

/* ---------- 打开 / 关闭 ---------- */

export function openEnvironmentSettings() {
  openWizard({ fromSettings: true });
}

function openWizard({ fromSettings = false, job = null } = {}) {
  state.fromSettings = fromSettings;
  state.error = null;
  state.notice = null;
  state.skippedOptional = false;
  if (job) state.job = job;
  if (state.job && isJobActive(state.job) && !state.phase) state.phase = ENV_PHASES.INSTALLING;
  if (!state.report) state.phase = ENV_PHASES.CHECKING;
  else if (!state.job || !isJobActive(state.job)) state.phase = ENV_PHASES.CHECK;
  state.openedOnce = true;
  /* 后台任务可能在向导关闭期间结束：SSE 只把终态留在 state.job 里，
   * 没有机会更新报告。重新打开时在这里补一次 —— 成功要刷新检测结果，
   * 失败要保留原因，不能拿安装前的旧报告继续显示「需要安装」。 */
  const pendingTerminal = state.job && isJobTerminal(state.job) && state.job.id !== state.handledJob;
  openModal((card, close) => {
    state.close = close;
    buildShell(card);
  }, () => {
    clearModal();
    if (!state.report || !state.report.requiredReady) {
      state.dismissed = true;
      if (!fromSettings) toast('可以随时在 设置 → 环境与依赖 中继续。', 'info');
    }
  }, {
    className: 'environment-wizard',
    surface: 'environment',
    labelledBy: 'envTitle',
    onCancel: handleModalCancel,
  });
  render();
  if (!state.report || (state.report.install && state.report.install.busy && !state.job)) {
    refreshReport({ force: true });
  } else if (state.job && isJobActive(state.job)) {
    startPolling(state.job.id);
    setPhase(ENV_PHASES.INSTALLING);
  } else if (pendingTerminal) {
    void onJob(state.job);
  }
}

function handleModalCancel() {
  if ([ENV_PHASES.INSTALLING, ENV_PHASES.VERIFYING].includes(state.phase)) return;
  closeModal();
}

function buildShell(card) {
  card.innerHTML = '';
  const root = h('div', 'env-wizard');
  const head = h('div', 'env-head');
  const eyebrow = h('div', 'env-eyebrow', '首次设置');
  const title = h('h2', 'env-title', '准备运行环境');
  title.id = 'envTitle';
  const sub = h('p', 'env-sub', 'Pi GUI 会用本机的 Node.js 运行 Pi。这里只做检查和安装，不会修改系统环境变量。');
  head.append(eyebrow, title, sub);

  const steps = h('ol', 'env-steps');
  ['检查', '确认', '安装', '验证'].forEach((label, index) => {
    const item = h('li', 'env-step');
    item.dataset.index = String(index);
    item.append(h('span', 'env-step-index', String(index + 1)), h('span', 'env-step-label', label));
    steps.append(item);
  });

  const body = h('div', 'env-body');
  const footer = h('div', 'env-actions');
  root.append(head, steps, body, footer);
  card.append(root);
  state.root = root;
  state.body = body;
  state.footer = footer;
  state.steps = steps;
  state.progress = null;
  updateSteps();
}

function updateSteps() {
  if (!state.steps) return;
  const current = phaseIndex();
  for (const item of state.steps.children) {
    const index = Number(item.dataset.index);
    item.classList.toggle('is-done', index < current);
    item.classList.toggle('is-current', index === current);
    if (index === current) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
}

/* ---------- 阶段 ---------- */

function setPhase(phase) {
  state.phase = phase;
  render();
}

function render() {
  if (!state.body || !state.footer) return;
  updateSteps();
  state.body.replaceChildren();
  state.footer.replaceChildren();
  setBusyCard([ENV_PHASES.INSTALLING, ENV_PHASES.VERIFYING].includes(state.phase));
  if (state.phase === ENV_PHASES.CHECKING) renderChecking();
  else if (state.phase === ENV_PHASES.CHECK) renderCheck();
  else if (state.phase === ENV_PHASES.CONFIRM) renderConfirm();
  else if (state.phase === ENV_PHASES.INSTALLING) renderInstalling();
  else if ([ENV_PHASES.VERIFYING, ENV_PHASES.VERIFIED].includes(state.phase)) renderVerifying();
  else renderError();
}

function loadingBlock(text) {
  const box = h('div', 'env-loading');
  box.setAttribute('role', 'status');
  box.append(h('span', 'env-spinner'), h('span', '', text));
  return box;
}

function renderChecking() {
  state.body.append(loadingBlock('正在检查 Node.js、Pi 与 Git…'));
  state.footer.append(disabledButton('正在检查…'));
}

function disabledButton(text) {
  const button = h('button', 'btn primary', text);
  button.type = 'button';
  button.disabled = true;
  return button;
}

function primaryButton(text, onClick) {
  const button = h('button', 'btn primary', text);
  button.type = 'button';
  button.onclick = onClick;
  return button;
}

function secondaryButton(text, onClick) {
  const button = h('button', 'btn', text);
  button.type = 'button';
  button.onclick = onClick;
  return button;
}

function textButton(text, onClick) {
  const button = h('button', 'btn tiny ghost env-link-button', text);
  button.type = 'button';
  button.onclick = onClick;
  return button;
}

function renderCheck() {
  const report = state.report;
  if (!report) {
    renderError();
    return;
  }
  if (state.notice) state.body.append(noticeBox(state.notice));
  if (state.error) state.body.append(errorBox(state.error));
  const interrupted = report.install && report.install.interrupted;
  if (interrupted) {
    state.body.append(noticeBox(`上次安装被应用退出打断（已完成 ${interrupted.completedSteps || 0}/${interrupted.totalSteps || 0} 项）。已完成的组件会保留，重新检查后继续即可。`));
  }

  const list = h('div', 'env-list');
  for (const item of report.items || []) list.append(componentRow(item));
  state.body.append(list);

  if (report.components && report.components.pi && report.components.pi.action === 'update-pi') {
    state.body.append(actionBox('找到了 Pi，但需要更新后才能稳定使用。', '打开 Pi 更新', () => {
      closeModal();
      $('navInfo')?.click();
    }));
  }

  appendManualPi(report);

  if (report.requiredReady) {
    state.body.append(successBox('必需依赖已就绪。可以进入 Pi GUI，之后在「设置 → 模型供应商」中配置模型。'));
  }

  const plan = report.plan || {};
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const startConfirm = () => {
    state.error = null;
    state.notice = null;
    state.includeOptional = true;
    setPhase(ENV_PHASES.CONFIRM);
  };
  if (report.requiredReady) {
    state.footer.append(primaryButton('进入 Pi GUI', finish));
    if (steps.length) state.footer.append(secondaryButton('安装推荐组件', startConfirm));
  } else if (steps.length) {
    state.footer.append(primaryButton('一键安装缺失依赖', startConfirm));
  }
  state.footer.append(secondaryButton('重新检查', () => refreshReport({ force: true })));
  if (!state.fromSettings) {
    state.footer.append(textButton('稍后设置', () => closeModal()));
  }
}

function componentRow(component) {
  const row = h('div', 'env-row');
  const lead = h('div', 'env-row-lead');
  lead.append(icon(component.id === 'git' ? 'package' : 'terminal'));
  const text = h('div', 'env-row-text');
  const titleLine = h('div', 'env-row-title');
  titleLine.append(h('span', 'env-row-name', component.id === 'node' ? 'Node.js' : component.id === 'pi' ? 'Pi Coding Agent' : 'Git'));
  const kind = h('span', `env-kind is-${component.kind || 'optional'}`, kindLabel(component.kind));
  titleLine.append(kind);
  const meta = h('div', 'env-row-meta');
  const bits = [];
  if (component.version) bits.push(`v${component.version}`);
  if (component.id === 'node' && component.npm && component.npm.present) {
    bits.push(component.npm.version ? `npm ${component.npm.version}` : 'npm 已找到');
  }
  if (component.id === 'node' && component.electron && component.electron.known) {
    bits.push(`应用内置 Node ${component.electron.version}`);
  }
  if (component.id === 'pi' && component.rpc) bits.push(component.rpc.state === 'ready' ? 'RPC 正常' : component.rpc.state === 'failed' ? 'RPC 未通过' : 'RPC 未检测');
  meta.textContent = bits.join(' · ');
  const detail = h('div', 'env-row-detail', component.detail || '');
  text.append(titleLine, meta, detail);
  const status = h('span', `env-status is-${statusTone(component.status)}`, statusLabel(component.status));
  row.append(lead, text, status);
  return row;
}

function appendManualPi(report) {
  const pi = report.components && report.components.pi;
  if (!pi || (pi.present && pi.status !== 'incompatible')) return;
  const details = h('details', 'env-manual');
  const summary = h('summary', '', '已经装过 Pi？手动指定路径');
  details.append(summary);
  const envLocked = report.setup && report.setup.piBinSource === 'env';
  if (envLocked) {
    details.append(h('p', 'env-hint', '当前由环境变量 PI_BIN 指定。要更换路径，请修改启动 Pi GUI 的环境变量。'));
  } else {
    const desktop = window.piGuiDesktop?.environmentSetup;
    const form = h('div', 'env-manual-form');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'modal-input env-path-input';
    input.placeholder = 'C:\\Users\\你\\AppData\\Roaming\\npm\\pi.cmd';
    input.setAttribute('aria-label', 'Pi 可执行文件完整路径');
    input.value = state.manualPath || '';
    input.oninput = () => { state.manualPath = input.value; };
    const submit = primaryButton(desktop ? '选择 Pi 可执行文件' : '使用此路径', async () => {
      const value = input.value.trim();
      if (!desktop && !value) return;
      submit.disabled = true;
      const result = desktop ? await desktop.choosePi().catch(() => ({})) : await setEnvironmentPiPath(value);
      submit.disabled = false;
      if (result.cancelled) return;
      if (result.ok) {
        applyReport(result.environment);
        state.notice = '已更新 Pi 路径。';
        setPhase(ENV_PHASES.CHECK);
      } else {
        state.error = result.error || '这个路径不可用。';
        render();
      }
    });
    if (!desktop) form.append(input);
    form.append(submit);
    details.append(form);
    if (report.setup && report.setup.piBinOverride) {
      details.append(textButton('清除手动指定', async () => {
        const result = desktop ? await desktop.clearPi().catch(() => ({})) : await setEnvironmentPiPath(null);
        if (result.cancelled) return;
        if (result.ok) {
          applyReport(result.environment);
          state.notice = '已清除手动指定的 Pi 路径。';
          setPhase(ENV_PHASES.CHECK);
        } else {
          state.error = result.error || '无法清除手动路径。';
          render();
        }
      }));
    }
  }
  state.body.append(details);
}

function renderConfirm() {
  const report = state.report;
  if (!report) { renderError(); return; }
  const selectable = selectableComponents(report);
  const optional = selectable.filter((c) => c.kind !== 'required');
  state.body.append(h('p', 'env-lead', '将安装下面这些组件。安装到当前用户目录，不需要管理员权限。'));
  const list = h('div', 'env-confirm-list');
  for (const component of selectable) {
    if (component.kind !== 'required' && !state.includeOptional) continue;
    const row = h('div', 'env-confirm-row');
    const name = h('div', 'env-confirm-name', component.id === 'node' ? 'Node.js' : component.id === 'pi' ? 'Pi Coding Agent' : 'Git');
    name.append(h('span', `env-kind is-${component.kind || 'optional'}`, kindLabel(component.kind)));
    const versionText = !component.version || component.version === 'latest'
      ? '官方最新版'
      : `版本 ${component.version}`;
    const meta = h('div', 'env-confirm-meta', [
      versionText,
      component.source,
      component.scope,
    ].filter(Boolean).join(' · '));
    row.append(name, meta);
    list.append(row);
  }
  state.body.append(list);

  if (optional.length) {
    const label = h('label', 'env-check');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = state.includeOptional;
    input.onchange = () => {
      state.includeOptional = input.checked;
      render();
    };
    label.append(input, h('span', '', `包含 ${optional.map((c) => c.id === 'git' ? 'Git' : c.id).join('、')}（推荐，可跳过）`));
    state.body.append(label);
  }

  state.body.append(noticeBox('不会覆盖已有的 Pi，也不会修改系统 PATH 或用户环境变量。下载只从官方渠道，并校验固定 SHA256。'));
  if (state.error) state.body.append(errorBox(state.error));

  state.footer.append(primaryButton('开始安装', startInstall));
  state.footer.append(secondaryButton('返回检查', () => { state.error = null; setPhase(ENV_PHASES.CHECK); }));
}

function renderInstalling() {
  const job = state.job;
  if (!job) { renderCheck(); return; }
  const summary = h('div', 'env-progress-head');
  const title = h('p', 'env-lead', job.state === 'cancelling' ? '正在取消…' : '正在安装缺失依赖');
  const count = h('span', 'env-progress-count', `${job.completedSteps || 0} / ${job.totalSteps || 0}`);
  summary.append(title, count);
  const bar = h('div', 'env-progress');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const fill = h('span', 'env-progress-fill');
  bar.append(fill);
  state.body.append(summary, bar);

  const list = h('div', 'env-install-list');
  const refs = new Map();
  for (const component of job.components || []) {
    const row = h('div', 'env-install-row');
    const lead = h('div', 'env-install-lead');
    const name = h('div', 'env-install-name', component.label || component.id);
    const status = h('span', 'env-install-status');
    const phase = h('div', 'env-install-phase');
    lead.append(name, phase);
    const compBar = h('div', 'env-progress is-compact');
    const compFill = h('span', 'env-progress-fill');
    compBar.append(compFill);
    const error = h('div', 'env-install-error');
    row.append(lead, status, compBar, error);
    list.append(row);
    refs.set(component.id, { status, phase, bar: compBar, fill: compFill, error });
  }
  state.body.append(list);
  state.progress = { job, bar, fill, count, refs, title };
  updateProgress();

  state.footer.append(secondaryButton('后台继续', () => closeModal()));
  const cancel = h('button', 'btn danger', '取消安装');
  cancel.type = 'button';
  cancel.onclick = cancelInstall;
  state.footer.append(cancel);
}

function updateProgress() {
  const view = state.progress;
  if (!view || !state.job) return;
  const job = state.job;
  view.job = job;
  const percent = jobPercent(job);
  view.fill.style.width = `${percent}%`;
  view.bar.setAttribute('aria-valuenow', String(percent));
  view.count.textContent = `${job.completedSteps || 0} / ${job.totalSteps || 0}`;
  if (job.state === 'cancelling') view.title.textContent = '正在取消…';
  for (const component of job.components || []) {
    const ref = view.refs.get(component.id);
    if (!ref) continue;
    const tone = component.status === 'failed' ? 'warn' : component.status === 'done' ? 'ok' : component.status === 'running' ? 'busy' : 'neutral';
    ref.status.className = `env-install-status is-${tone}`;
    ref.status.textContent = statusLabel(component.status);
    const bits = [];
    if (component.phase) bits.push(phaseLabel(component.phase));
    if (component.progress && component.progress.receivedBytes) {
      bits.push(formatBytes(component.progress.receivedBytes) + (component.progress.totalBytes ? ` / ${formatBytes(component.progress.totalBytes)}` : ''));
    }
    ref.phase.textContent = bits.filter(Boolean).join(' · ');
    const compPercent = component.progress && Number.isFinite(component.progress.percent) ? component.progress.percent : (component.status === 'done' ? 100 : null);
    if (Number.isFinite(compPercent)) {
      ref.fill.style.width = `${compPercent}%`;
      ref.bar.setAttribute('aria-valuenow', String(compPercent));
    } else {
      ref.fill.style.width = component.status === 'running' ? '35%' : '0%';
      ref.bar.removeAttribute('aria-valuenow');
    }
    ref.error.textContent = component.error || '';
    ref.error.hidden = !component.error;
  }
}

function renderVerifying() {
  if (state.verifying) {
    state.body.append(loadingBlock('正在验证 Node.js、npm、Pi 版本与 RPC 启动…'));
    state.footer.append(disabledButton('正在验证…'));
    return;
  }
  const report = state.report;
  if (!report) { renderError(); return; }
  const items = verificationItems(report);
  const list = h('div', 'env-verify-list');
  for (const item of items) {
    const row = h('div', 'env-verify-row');
    const mark = h('span', `env-check-mark is-${item.ok ? 'ok' : item.required ? 'warn' : 'neutral'}`);
    mark.innerHTML = item.ok ? iconMarkup('check') : '';
    const text = h('div', 'env-verify-text');
    text.append(h('div', 'env-verify-name', item.label));
    const detail = h('div', 'env-verify-detail', [item.value, item.detail].filter(Boolean).join(' · '));
    text.append(detail);
    const label = h('span', `env-status is-${item.ok ? 'ok' : item.required ? 'warn' : 'neutral'}`, item.ok ? '通过' : item.required ? '未通过' : '可跳过');
    row.append(mark, text, label);
    list.append(row);
  }
  state.body.append(list);
  if (report.requiredReady) {
    state.body.append(successBox('必需依赖全部通过。进入后可以在「设置 → 模型供应商」配置模型。'));
  } else {
    state.body.append(errorBox('还有必需项没有通过。可以重试，或在诊断中查看脱敏信息。'));
  }
  const pi = report.components && report.components.pi;
  if (pi && pi.action === 'update-pi') {
    state.body.append(actionBox('Pi 需要更新才能继续。', '打开 Pi 更新', () => {
      closeModal();
      $('navInfo')?.click();
    }));
  }
  if (report.requiredReady) state.footer.append(primaryButton('进入 Pi GUI', finish));
  else state.footer.append(primaryButton('重试', () => { state.error = null; setPhase(ENV_PHASES.CHECK); }));
  state.footer.append(secondaryButton('重新验证', verify));
  state.footer.append(textButton('打开日志与诊断', openDiagnosticsFromWizard));
}

function renderError() {
  const job = state.job;
  if (state.error) state.body.append(errorBox(state.error));
  else if (job && job.error) state.body.append(errorBox(job.error));
  else state.body.append(errorBox('环境安装没有完成。可以重试，已完成的组件会保留。'));
  if (job && Array.isArray(job.components)) {
    for (const component of job.components) {
      if (component.error) state.body.append(noticeBox(`${component.label || component.id}：${component.error}`));
    }
  }
  state.footer.append(primaryButton('重试', () => {
    state.error = null;
    state.job = null;
    refreshReport({ force: true });
  }));
  state.footer.append(secondaryButton('重新检查', () => { state.error = null; refreshReport({ force: true }); }));
  state.footer.append(textButton('打开日志与诊断', openDiagnosticsFromWizard));
  if (!state.fromSettings) state.footer.append(textButton('稍后设置', () => closeModal()));
}

function noticeBox(text) {
  const box = h('div', 'env-callout is-info');
  box.setAttribute('role', 'status');
  box.append(icon('refresh'), h('span', '', text));
  return box;
}

function successBox(text) {
  const box = h('div', 'env-callout is-ok');
  box.setAttribute('role', 'status');
  box.append(icon('check'), h('span', '', text));
  return box;
}

function errorBox(text) {
  const box = h('div', 'env-callout is-error');
  box.setAttribute('role', 'alert');
  box.append(h('span', '', text));
  return box;
}

function actionBox(text, label, onClick) {
  const box = h('div', 'env-callout is-info');
  box.append(h('span', '', text), secondaryButton(label, onClick));
  return box;
}

function openDiagnosticsFromWizard() {
  closeModal();
  openDiagnostics();
}

/* ---------- 动作 ---------- */

async function refreshReport({ force = false, verifying = false } = {}) {
  state.error = null;
  state.verifying = Boolean(verifying);
  state.phase = verifying ? ENV_PHASES.VERIFYING : (state.report ? ENV_PHASES.CHECK : ENV_PHASES.CHECKING);
  render();
  const result = force ? await recheckEnvironment() : await fetchEnvironment();
  if (!result || result.ok === false || !result.environment) {
    state.verifying = false;
    state.error = result?.error || '无法读取环境状态，请重试。';
    state.phase = ENV_PHASES.ERROR;
    render();
    return;
  }
  applyReport(result.environment);
  state.verifying = false;
  const job = state.job || (result.environment.install && result.environment.install.job);
  if (job && isJobActive(job)) {
    state.job = job;
    state.phase = ENV_PHASES.INSTALLING;
    startPolling(job.id);
  } else {
    state.phase = verifying ? ENV_PHASES.VERIFIED : ENV_PHASES.CHECK;
  }
  render();
}

async function verify() {
  await refreshReport({ force: true, verifying: true });
}

function selectedIds() {
  if (!state.report) return [];
  return defaultSelection(state.report, state.includeOptional);
}

async function startInstall() {
  const report = state.report;
  if (!report || !report.plan) return;
  const ids = selectedIds();
  const invalid = selectionError(report, ids);
  if (invalid) {
    state.error = invalid === 'missing-required' ? '必需组件不能跳过。' : '安装项已经变化，请重新检查。';
    render();
    return;
  }
  const optionalInPlan = (report.plan.steps || []).some((id) => id === 'git');
  state.skippedOptional = optionalInPlan && !ids.includes('git');

  // Web consent records this explicit UI action. Desktop uses the native bridge.
  const desktop = window.piGuiDesktop?.environmentSetup;
  let result;
  try {
    result = desktop
      ? await desktop.install(report.plan.planId, ids)
      : await startEnvironmentInstall({ planId: report.plan.planId, components: ids, consent: true });
  } catch { /* Bridge unavailable. Use the same inline error as a failed start. */ }
  if (result?.cancelled) return;
  if (!result || result.ok !== true) {
    if (result && result.environment) applyReport(result.environment);
    if (result && result.code === 'stale-plan') {
      state.notice = '环境在确认期间发生了变化，已经重新检查。';
      await refreshReport({ force: true });
      return;
    }
    if (result && result.code === 'busy' && result.job) {
      state.job = result.job;
      state.phase = ENV_PHASES.INSTALLING;
      startPolling(result.job.id);
      render();
      return;
    }
    state.error = result?.error || '安装任务没有启动，请重试。';
    render();
    return;
  }
  state.job = result.job;
  state.phase = ENV_PHASES.INSTALLING;
  render();
  if (state.job && state.job.id) startPolling(state.job.id);
}

async function cancelInstall() {
  if (!state.job) return;
  const result = await cancelEnvironmentInstall(state.job.id);
  if (result && result.job) {
    state.job = result.job;
    updateProgress();
  }
  if (!result || result.ok !== true) {
    state.error = result?.error || '取消请求没有送达，请重试。';
    render();
  }
}

function startPolling(id) {
  stopPolling();
  if (!id) return;
  state.pollTimer = setInterval(async () => {
    const result = await fetchEnvironmentJob(id);
    if (result && result.ok && result.job) onJob(result.job);
  }, 1200);
}

function onJob(job) {
  if (!job || typeof job !== 'object') return;
  state.job = job;
  if (job.id === state.handledJob && isJobTerminal(job)) return;
  if (isJobActive(job)) {
    /* 恢复会话时第一份 job 可能来自报告摘要（只有计数，没有组件行）；
     * 等完整 job 到达后要重画一次，否则进度条会动、行却一直是空的。 */
    const missingRows = Boolean(job.components && state.progress && state.progress.refs.size === 0);
    if (state.phase !== ENV_PHASES.INSTALLING || missingRows) {
      state.phase = ENV_PHASES.INSTALLING;
      render();
    } else {
      updateProgress();
    }
    if (!state.pollTimer) startPolling(job.id);
    return;
  }
  if (!isJobTerminal(job)) return;
  state.handledJob = job.id;
  stopPolling();
  const next = nextPhaseAfterJob(job);
  if (next === ENV_PHASES.VERIFYING) {
    verify();
  } else if (next === ENV_PHASES.CHECK) {
    state.notice = job.state === 'cancelled' ? '已取消安装。已完成的组件会保留，可以重新检查后继续。' : '安装已经停止。';
    refreshReport({ force: true });
  } else {
    state.error = job.error || '安装没有完成。';
    state.phase = ENV_PHASES.ERROR;
    render();
  }
}

async function finish() {
  if (!state.report || !state.report.requiredReady) return;
  const result = await ackEnvironmentSetup({ completed: true, skippedOptional: state.skippedOptional });
  if (result && result.environment) applyReport(result.environment);
  closeModal();
  if (!result || result.ok !== true) toast('环境已就绪，但向导状态没有保存；下次启动会再次检查。', 'warn');
  else toast('环境已就绪。', 'info');
  try { await loadStatus(); } catch { /* 状态刷新失败不改变安装结果 */ }
}

/* ---------- 对外 ---------- */

export function observeEnvironmentEvent(evt) {
  if (!evt || evt.type !== 'environment_job' || !evt.job) return;
  state.job = evt.job;
  /* 向导打开时交给同一套 onJob 处理；关闭时只记住终态，等下次打开
   * 由 openWizard 补刷新（见那里的 pendingTerminal）。 */
  if (state.root) onJob(evt.job);
}

export async function initEnvironmentSetup() {
  document.addEventListener('pi-gui:open-environment', () => openEnvironmentSettings());
  const result = await fetchEnvironment();
  if (!result || result.ok === false || !result.environment) return;
  applyReport(result.environment);
  if (result.environment.install && result.environment.install.busy && result.environment.install.job) {
    state.job = result.environment.install.job;
    state.phase = ENV_PHASES.INSTALLING;
    openWizard({ job: state.job });
    return;
  }
  if (result.environment.firstRun && result.environment.requiredReady) {
    // 环境本来就齐：静默记一次完成，不弹向导。
    void ackEnvironmentSetup({ completed: true }).then((ack) => {
      if (ack && ack.environment) applyReport(ack.environment);
    }).catch(() => {});
    return;
  }
  if (shouldAutoOpen(result.environment) && !state.dismissed) openWizard();
}
