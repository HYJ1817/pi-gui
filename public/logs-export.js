/* 日志与诊断的导出标签。只消费已脱敏 API，不读取路径或安装/更新服务。 */
import { fetchDiagnostics, previewLogExport, downloadLogReport } from './api.js';
import { buildDiagnosticSummary, downloadDiagnosticJSON, renderDiagnosticDetails } from './diagnostics.js';
import { driftSnapshot } from './schema-drift.js';
import { createSettingsCard, createSettingsRow } from './ui/primitives.js';
import { createPicker } from './ui/picker.js';
import { toast } from './ui/toast.js';
import { logRendererEvent } from './log-client.js';

function node(tag, cls = '', text = '') {
  const element = document.createElement(tag);
  element.className = cls;
  element.textContent = text;
  return element;
}
function button(label, run, cls = 'btn') {
  const element = node('button', cls, label);
  element.type = 'button';
  element.onclick = run;
  return element;
}
async function copy(text, feedback) {
  try {
    await navigator.clipboard.writeText(text);
    feedback.textContent = '已复制。';
  } catch { feedback.textContent = '复制失败，请展开诊断 JSON 手工选中。'; }
}

/** state 只保存当前设置页的草稿与只读快照；切换标签不丢输入或重复读取。 */
export function mountLogExport(host, { state, getStatus }) {
  let active = true, loading = false, previewing = false, exporting = false;
  let snapshotRequest = 0, previewRequest = 0, preview = null;
  const current = () => active && host.isConnected;
  const feedback = node('p', 'ui5-logs-inline-note');
  feedback.setAttribute('role', 'status');
  const summary = button('复制诊断摘要', async () => {
    if (!state.diagnostics || loading || summary.disabled) return;
    const diagnostics = state.diagnostics, drift = state.drift;
    summary.disabled = true;
    const logging = await getStatus();
    if (!current()) return;
    await copy(buildDiagnosticSummary(diagnostics, drift, logging), feedback);
    if (current()) summary.disabled = loading || !state.diagnostics;
  });
  summary.dataset.logAction = 'copy-summary';
  const copyJSON = button('复制诊断 JSON', () => {
    if (state.diagnostics && !loading) void copy(JSON.stringify(state.diagnostics, null, 2), feedback);
  });
  copyJSON.dataset.logAction = 'copy-json';
  const exportJSON = button('导出诊断 JSON', () => {
    if (state.diagnostics && !loading) downloadDiagnosticJSON(JSON.stringify(state.diagnostics, null, 2));
  });
  exportJSON.dataset.logAction = 'export-json';
  const jsonActions = node('div', 'ui5-logs-actions');
  jsonActions.append(copyJSON, exportJSON);
  const refresh = button('刷新', () => void loadSnapshot(), 'btn ghost');
  refresh.setAttribute('aria-label', '刷新诊断快照');
  const diagnosticContent = node('div');
  const diagnosticCard = createSettingsCard({ title: '诊断快照', action: refresh, children: [
    createSettingsRow({ label: '诊断摘要', control: summary, flat: true }),
    createSettingsRow({ label: '结构化诊断数据', control: jsonActions, flat: true }),
    feedback, diagnosticContent,
  ] });
  host.append(diagnosticCard);

  function paintSnapshot() {
    for (const control of [summary, copyJSON, exportJSON]) control.disabled = loading || !state.diagnostics;
    refresh.disabled = loading;
    refresh.setAttribute('aria-busy', String(loading));
    diagnosticContent.replaceChildren();
    if (!state.diagnostics) return;
    const troubleshooting = node('details', 'ui5-logs-disclosure');
    troubleshooting.append(node('summary', '', '故障排查详情'));
    const details = node('div');
    renderDiagnosticDetails(details, state.diagnostics, state.drift);
    troubleshooting.append(details);
    const structured = node('details', 'ui5-logs-disclosure');
    structured.append(node('summary', '', '查看诊断 JSON'), node('pre', 'ui5-log-detail-json', JSON.stringify(state.diagnostics, null, 2)));
    diagnosticContent.append(troubleshooting, structured);
  }
  async function loadSnapshot() {
    if (loading) return;
    const request = ++snapshotRequest;
    loading = true;
    feedback.textContent = '正在读取诊断快照…';
    paintSnapshot();
    const payload = await fetchDiagnostics();
    if (!current() || request !== snapshotRequest) return;
    loading = false;
    state.diagnostics = payload?.ok !== false && payload?.diagnostics || null;
    state.drift = driftSnapshot();
    feedback.textContent = state.diagnostics ? '' : '无法读取诊断快照，请刷新重试。日志报告仍可单独预览。';
    paintSnapshot();
  }

  const range = createPicker({
    value: String(state.windowMinutes),
    options: [
      { value: '30', label: '最近 30 分钟' },
      { value: '120', label: '最近 2 小时' },
      { value: '1440', label: '最近 24 小时' },
    ],
    label: '故障报告时间范围',
    field: 'exportRange',
    className: 'ui5-logs-range-picker',
    menuClassName: 'ui5-logs-picker-menu',
    onSelect: value => {
      state.windowMinutes = Number(value);
      previewRequest++;
      previewing = false;
      preview = null;
      previewHost.replaceChildren();
      paintExport();
    },
  });
  const problem = node('textarea', 'ds-input');
  problem.rows = 3; problem.maxLength = 2000; problem.value = state.description;
  problem.setAttribute('aria-label', '问题描述');
  problem.placeholder = '不要填写密钥、聊天正文或完整路径。';
  problem.oninput = () => { state.description = problem.value; };
  const repro = node('textarea', 'ds-input');
  repro.rows = 3; repro.maxLength = 2000; repro.value = state.repro;
  repro.setAttribute('aria-label', '复现步骤');
  repro.oninput = () => { state.repro = repro.value; };
  function field(label, input) {
    const wrap = node('label', 'ui5-logs-field-block');
    wrap.append(node('span', '', label), input);
    return wrap;
  }
  const previewHost = node('div', 'ui5-logs-preview');
  previewHost.setAttribute('role', 'status');
  const previewButton = button('预览摘要', () => void loadPreview());
  const exportButton = button('确认导出 ZIP', () => void exportReport(), 'btn primary');
  exportButton.disabled = true;
  const actions = node('div', 'ui5-logs-export-actions');
  actions.append(previewButton, exportButton);
  const form = node('div', 'ui5-logs-export-form');
  form.append(
    createSettingsRow({ label: '时间范围', control: range.element, flat: true }),
    field('问题描述（可选）', problem), field('复现步骤（可选）', repro),
  );
  const privacy = node('p', 'ui5-logs-inline-note', '报告仅在本机生成，不自动上传。不含聊天、项目文件或配置正文；发送前请检查填写内容。');
  host.append(createSettingsCard({ title: '故障报告', children: [privacy, form, previewHost, actions] }));

  function paintExport() {
    range.setDisabled(exporting);
    previewButton.disabled = previewing || exporting;
    previewButton.setAttribute('aria-busy', String(previewing));
    exportButton.disabled = !preview || previewing || exporting;
    exportButton.setAttribute('aria-busy', String(exporting));
  }
  async function loadPreview() {
    if (previewing || exporting) return;
    const request = ++previewRequest;
    previewing = true; preview = null;
    previewHost.textContent = '正在预览…';
    paintExport();
    const result = await previewLogExport(state.windowMinutes);
    if (!current() || request !== previewRequest) return;
    previewing = false;
    preview = result?.ok ? result : null;
    previewHost.replaceChildren();
    if (!preview) previewHost.append(node('p', 'ui5-logs-error', '无法预览导出内容，请重试。'));
    else {
      previewHost.append(node('p', 'ui5-logs-inline-note', `${preview.entryCount ?? 0} 条事件 · ${preview.errorCount ?? 0} 条错误${preview.truncated ? ' · 已截断到安全上限' : ''}`));
      const files = node('ul', 'ui5-logs-manifest');
      for (const name of preview.filesIncluded || []) files.append(node('li', '', name));
      previewHost.append(files);
    }
    paintExport();
  }
  async function exportReport() {
    if (!preview || exporting || previewing) return;
    exporting = true;
    paintExport();
    const result = await downloadLogReport({ windowMinutes: state.windowMinutes, description: problem.value, repro: repro.value });
    if (!current()) return;
    exporting = false;
    if (!result?.ok) {
      logRendererEvent('ui.logs_export_failed', { reason: result?.network ? 'network' : 'export_failed' });
      previewHost.replaceChildren(node('p', 'ui5-logs-error', '故障报告未能生成。可重试导出，或使用上方的诊断摘要。'));
    } else toast('故障报告已保存', 'success');
    paintExport();
  }

  paintSnapshot();
  if (!state.diagnostics) void loadSnapshot();
  return () => { active = false; snapshotRequest++; previewRequest++; range.destroy(); };
}
