/* 首次环境向导的**纯展示模型**。
 *
 * 这里不碰 DOM、不发请求，只把后端报告与安装任务映射成界面要用的文字、
 * 选择和阶段。抽出来是为了能用 jsdom 之外的普通 Node 直接测 —— 状态机
 * 的正确性不该依赖「某个按钮在不在 DOM 里」。
 */

export const ENV_PHASES = Object.freeze({
  CHECKING: 'checking',
  CHECK: 'check',
  CONFIRM: 'confirm',
  INSTALLING: 'installing',
  VERIFYING: 'verifying',
  VERIFIED: 'verified',
  ERROR: 'error',
});

const STATUS_LABELS = Object.freeze({
  ready: '已就绪',
  'needs-install': '需要安装',
  incompatible: '需要处理',
  installing: '安装中',
  verifying: '验证中',
  failed: '检查失败',
  skipped: '已跳过',
  unknown: '未知',
  done: '已完成',
  pending: '等待中',
  running: '进行中',
  cancelled: '已取消',
  succeeded: '已完成',
});

const KIND_LABELS = Object.freeze({ required: '必需', recommended: '推荐', optional: '可选' });

const PHASE_LABELS = Object.freeze({
  preparing: '准备中',
  downloading: '下载中',
  'verifying-download': '校验安装包',
  extracting: '解压中',
  installing: '安装中',
  verifying: '验证中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  cancelling: '正在取消',
});

export function statusLabel(status) {
  return STATUS_LABELS[status] || '未知';
}

export function kindLabel(kind) {
  return KIND_LABELS[kind] || '可选';
}

export function phaseLabel(phase) {
  return PHASE_LABELS[phase] || '';
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function isJobActive(job) {
  return Boolean(job && ['queued', 'running', 'cancelling'].includes(job.state));
}

export function isJobTerminal(job) {
  return Boolean(job && ['succeeded', 'failed', 'cancelled'].includes(job.state));
}

export function jobPercent(job) {
  if (!job || !Number.isInteger(job.totalSteps) || job.totalSteps <= 0) return 0;
  const done = Math.max(0, Math.min(job.totalSteps, Number(job.completedSteps) || 0));
  return Math.round((done / job.totalSteps) * 100);
}

/** 当前正在安装的组件（job.current 或第一个 running）。 */
export function activeComponent(job) {
  if (!job || !Array.isArray(job.components)) return null;
  if (job.current) return job.components.find((c) => c.id === job.current) || null;
  return job.components.find((c) => c.status === 'running') || null;
}

/** 任务结束后向导下一步：成功去验证，失败/取消回到检查（保留已完成组件）。 */
export function nextPhaseAfterJob(job) {
  if (!job) return ENV_PHASES.CHECK;
  if (job.state === 'succeeded') return ENV_PHASES.VERIFYING;
  if (job.state === 'cancelled') return ENV_PHASES.CHECK;
  return ENV_PHASES.ERROR;
}

/** 计划里可以勾选的组件。Git 是唯一的推荐/可选项。 */
export function selectableComponents(report) {
  const steps = report && report.plan && Array.isArray(report.plan.steps) ? report.plan.steps : [];
  const list = report && Array.isArray(report.plan.components) ? report.plan.components : [];
  return steps.map((id) => list.find((c) => c.id === id) || { id, kind: id === 'git' ? 'recommended' : 'required', version: null, source: null, scope: null });
}

export function defaultSelection(report, includeOptional = true) {
  return selectableComponents(report)
    .filter((c) => includeOptional || c.kind === 'required')
    .map((c) => c.id);
}

/** 校验 renderer 的选择：必需项不能漏，未知项不能加。返回错误码或 null。 */
export function selectionError(report, ids) {
  const allowed = new Set(selectableComponents(report).map((c) => c.id));
  const required = selectableComponents(report).filter((c) => c.kind === 'required').map((c) => c.id);
  if (!Array.isArray(ids) || ids.length === 0) return 'empty';
  if (ids.some((id) => typeof id !== 'string' || !allowed.has(id))) return 'unknown';
  if (required.some((id) => !ids.includes(id))) return 'missing-required';
  return null;
}

/** 验证页的条目。必需项没通过就是没通过；Git 缺失只标「可跳过」。 */
export function verificationItems(report) {
  const c = report && report.components ? report.components : {};
  const node = c.node || {};
  const pi = c.pi || {};
  const git = c.git || {};
  return [
    {
      id: 'node',
      label: 'Node.js',
      required: true,
      ok: node.status === 'ready',
      value: node.version ? `v${node.version}` : '未找到',
      detail: node.meetsMinimum === false ? `低于 Pi 要求的 ${node.minimum || '最低版本'}` : '',
    },
    {
      id: 'npm',
      label: 'npm',
      /* npm 是安装/更新 Pi 的工具，不是启动 Pi 的运行时。Pi 已经装好时
       * 它缺失只影响后续更新，不该把用户挡在对话之外。 */
      required: false,
      ok: Boolean(node.npm && node.npm.present),
      value: node.npm && node.npm.version ? `v${node.npm.version}` : '未找到',
      detail: node.npm && node.npm.present ? '用于安装与更新 Pi' : '缺失只影响安装与更新 Pi',
    },
    {
      id: 'pi',
      label: 'Pi Coding Agent',
      required: true,
      ok: pi.status === 'ready',
      value: pi.version ? `v${pi.version}` : '未找到',
      detail: pi.executableLabel ? `入口 ${pi.executableLabel}` : '',
    },
    {
      id: 'pi-rpc',
      label: 'Pi RPC 启动',
      required: true,
      ok: Boolean(pi.rpc && pi.rpc.state === 'ready'),
      value: pi.rpc && pi.rpc.state === 'ready' ? '正常' : '未通过',
      detail: pi.rpc && Number.isInteger(pi.rpc.ms) ? `${pi.rpc.ms} ms` : '',
    },
    {
      id: 'git',
      label: 'Git',
      required: false,
      ok: Boolean(git.present),
      value: git.version ? `v${git.version}` : '未安装',
      detail: git.present ? '' : '缺失不影响开始对话',
    },
  ];
}

/** 首次启动自动弹向导的条件。已就绪且只是首次记录时不该打扰。 */
export function shouldAutoOpen(report) {
  if (!report) return false;
  if (report.install && report.install.busy) return true;
  return !report.requiredReady;
}

/** 后端报告的组件 → 一行摘要（测试与设置页共用）。 */
export function componentSummary(component) {
  if (!component) return '';
  const version = component.version ? `v${component.version}` : '';
  const npm = component.npm && component.npm.present && component.npm.version ? `npm ${component.npm.version}` : '';
  return [version, npm].filter(Boolean).join(' · ');
}
