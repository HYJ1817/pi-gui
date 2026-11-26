/* 日志与诊断：只消费脱敏状态/事件，日志服务及持久化仍由后端持有。 */
import { fetchLogsStatus, fetchLogEntries, updateLogSettings, clearLogs } from './api.js';
import { buildLogReference } from './diagnostics.js';
import { mountLogExport } from './logs-export.js';
import { fillReviewComposer } from './review-fill.js';
import { openModal, confirmModal } from './ui/modal.js';
import { createSettingsCard, createSettingsRow, createSettingsToggle } from './ui/primitives.js';
import { toast } from './ui/toast.js';
import { createIcon } from './ui/icons.js';
import { logRendererEvent, setRendererLoggingEnabled } from './log-client.js';

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
const LEVEL_TEXT = { DEBUG: '详细', INFO: '信息', WARN: '警告', ERROR: '错误', FATAL: '严重' };
const LOG_TABS = [['overview', '概览'], ['logs', '日志查看'], ['export', '导出故障报告']];
const SOURCE_TEXT = {
  app: '应用', electron: 'Electron', 'pi-bridge': 'Pi Bridge', runtime: 'Runtime', renderer: '界面进程',
  browser: '浏览器', ui: '界面操作', network: '网络', logs: '日志', settings: '设置',
};
function node(tag, cls = '', text = '') {
  const element = document.createElement(tag);
  if (cls) element.className = cls;
  if (text !== '') element.textContent = String(text);
  return element;
}
function button(text, cls = 'btn', run) {
  const element = node('button', cls, text);
  element.type = 'button';
  if (run) element.onclick = run;
  return element;
}
function select(label, options, value, onChange) {
  const element = node('select', 'ds-select');
  element.setAttribute('aria-label', label);
  for (const [key, text] of options) {
    const option = node('option', '', text); option.value = String(key); element.append(option);
  }
  element.value = String(value);
  element.onchange = () => onChange(element.value);
  return element;
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
function formatLocal(iso) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(iso || '未知');
}
export function safeEntryText(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const bits = [entry.timestamp, entry.level, entry.source, entry.event];
  if (entry.code) bits.push(entry.code);
  if (entry.correlationId) bits.push('关联 ' + String(entry.correlationId).slice(0, 24));
  const details = entry.details && typeof entry.details === 'object' ? JSON.stringify(entry.details) : '';
  return bits.filter(Boolean).join(' · ') + (details ? '\n' + details : '');
}
async function safeCopy(text, feedback) {
  try { await navigator.clipboard.writeText(text); feedback.textContent = '已复制脱敏日志摘要。'; }
  catch { feedback.textContent = '复制失败，请手工选中摘要。'; }
}
function referenceEntryToComposer(entry, feedback) {
  const summary = buildLogReference(entry);
  if (!summary) { feedback.textContent = '这条日志缺少可引用的字段。'; return; }
  const result = fillReviewComposer(summary);
  feedback.textContent = result.ok
    ? `已引用到当前会话${result.appended ? '（追加在原有输入之后）' : ''}；不会自动发送。`
    : `${result.error} 摘要仍在，可用「复制这一条」粘贴。`;
}
function renderEntry(entry, compact = false) {
  const article = node('article', compact ? 'ui5-logs-recent-error' : 'ui5-log-entry');
  article.dataset.level = entry.level || 'INFO';
  const details = node('details', 'ui5-log-details');
  details.open = !compact && ['ERROR', 'FATAL'].includes(entry.level);
  const head = node('summary', 'ui5-log-entry-head');
  const time = node('time', 'ui5-log-time', formatLocal(entry.timestamp));
  time.dateTime = entry.timestamp || ''; time.title = entry.timestamp || '';
  const level = node('span', 'ui5-log-level', LEVEL_TEXT[entry.level] || entry.level || '未知');
  level.dataset.level = entry.level || 'INFO';
  head.append(time, level, node('span', 'ui5-log-source', SOURCE_TEXT[entry.source] || entry.source || '未知'),
    node('span', 'ui5-log-event', entry.event || '未知事件'));
  if (entry.code) head.append(node('code', 'ui5-log-code', entry.code));
  const meta = node('div', 'ui5-log-meta');
  if (entry.runId) meta.append(node('div', '', '运行标识：' + entry.runId));
  if (entry.correlationId) meta.append(node('div', '', '关联标识：' + entry.correlationId));
  if (Number.isFinite(entry.durationMs)) meta.append(node('div', '', '耗时：' + entry.durationMs + ' ms'));
  if (entry.details && Object.keys(entry.details).length) meta.append(node('pre', 'ui5-log-detail-json', JSON.stringify(entry.details, null, 2)));
  const feedback = node('span', 'ui5-log-ref-status');
  feedback.setAttribute('role', 'status');
  const actions = node('div', 'ui5-log-actions');
  actions.append(button('复制这一条', 'btn ghost ui5-log-copy', () => void safeCopy(safeEntryText(entry), feedback)),
    button(compact ? '引用' : '引用到对话', 'btn ghost ui5-log-ref', () => referenceEntryToComposer(entry, feedback)), feedback);
  meta.append(actions); details.append(head, meta); article.append(details);
  return article;
}

export function openLogs({ present = openModal, initialTab = 'overview' } = {}) {
  let alive = true, status = null, statusError = '', statusLoading = false, settingsSaving = false, clearing = false;
  let statusRequest = 0, entriesRequest = 0, searchTimer = null, disposeTab = () => {};
  let statusPromise = null, operationError = '', mountedTab = null, tabRevision = 0;
  let tab = LOG_TABS.some(([id]) => id === initialTab) ? initialTab : 'overview';
  let entries = [], cursor = null, more = false, truncated = false, loadingEntries = false, entriesError = '';
  let filters = { level: '', source: '', q: '' };
  let logListHost = null, countNode = null;
  const exportState = { windowMinutes: 30, description: '', repro: '', diagnostics: null, drift: [] };
  const dispose = () => { alive = false; statusRequest++; entriesRequest++; clearTimeout(searchTimer); disposeTab(); };
  return present(card => {
    card.classList.add('ui5-logs-modal');
    const heading = node('header', 'ui5-logs-heading');
    heading.append(node('h2', '', '日志与诊断'));
    const tabs = node('div', 'ext-tabs ui5-logs-tabs');
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '日志与诊断');
    const buttons = {};
    const body = node('div', 'ui5-logs-body');
    body.id = 'ui5-logs-body'; body.setAttribute('role', 'tabpanel');
    for (const [id, label] of LOG_TABS) {
      const item = button(label, 'ext-tab ui5-logs-tab', () => activate(id));
      item.id = 'ui5-log-tab-' + id; item.setAttribute('role', 'tab');
      item.setAttribute('aria-controls', body.id); buttons[id] = item; tabs.append(item);
    }
    tabs.onkeydown = event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const ids = LOG_TABS.map(([id]) => id), index = ids.indexOf(tab);
      const next = event.key === 'ArrowRight' ? ids[(index + 1) % ids.length]
        : event.key === 'ArrowLeft' ? ids[(index + ids.length - 1) % ids.length]
        : event.key === 'Home' ? ids[0] : event.key === 'End' ? ids.at(-1) : null;
      if (next) { event.preventDefault(); activate(next); buttons[next].focus(); }
    };
    card.append(heading, tabs, body);
    function activate(id) {
      if (mountedTab === id) return;
      mountedTab = id; tabRevision++;
      clearTimeout(searchTimer); disposeTab(); disposeTab = () => {};
      entriesRequest++; loadingEntries = false; tab = id;
      for (const [key, item] of Object.entries(buttons)) {
        item.setAttribute('aria-selected', String(key === id)); item.tabIndex = key === id ? 0 : -1;
        item.classList.toggle('on', key === id);
      }
      body.setAttribute('aria-labelledby', buttons[id].id);
      body.replaceChildren(); logListHost = null; countNode = null;
      if (id === 'overview') { renderOverview(); if (!status && !statusLoading) void loadStatus(); }
      else if (id === 'logs') { renderLogsTab(); void loadEntries(true); }
      else disposeTab = mountLogExport(body, { state: exportState, getStatus: async () => {
        if (!status) await loadStatus();
        return status;
      } });
    }
    function loadStatus() {
      if (statusLoading) return statusPromise;
      if (settingsSaving || clearing) return Promise.resolve();
      const request = ++statusRequest;
      statusLoading = true;
      if (tab === 'overview') renderOverview();
      statusPromise = fetchLogsStatus().then(result => {
        if (!alive || request !== statusRequest) return;
        statusLoading = false;
        if (!result?.ok || !result.status) {
          statusError = '无法读取日志状态，请重试。';
          logRendererEvent('ui.logs_view_failed', { operation: 'status', reason: 'read_failed' });
        } else { status = result.status; statusError = ''; setRendererLoggingEnabled(status.enabled === true); }
        if (tab === 'overview') renderOverview();
      });
      return statusPromise;
    }
    function renderOverview(focusKey = body.contains(document.activeElement) ? document.activeElement.dataset.logSetting : null) {
      body.replaceChildren();
      const refresh = button('刷新', 'btn ghost', () => void loadStatus());
      refresh.setAttribute('aria-label', '刷新日志状态'); refresh.dataset.logSetting = 'refresh';
      refresh.disabled = settingsSaving || clearing || statusLoading;
      const stateRows = node('dl', 'ui5-logs-summary');
      const metric = (label, value, error = false) => {
        const row = node('div');
        row.append(node('dt', '', label), node('dd', error ? 'ui5-logs-error' : '', value));
        stateRows.append(row);
      };
      if (statusError || operationError) {
        const failure = node('p', 'ui5-logs-error', operationError || statusError); failure.setAttribute('role', 'status'); body.append(failure);
      }
      if (!status) stateRows.append(node('p', 'ui5-logs-inline-note', statusError ? '日志状态未知。' : '正在读取日志状态…'));
      else {
        metric('磁盘占用', formatBytes(status.usageBytes));
        metric('日志文件', String(status.fileCount ?? '未知') + ' 个' + (status.crashFileCount ? ` · 崩溃 ${status.crashFileCount} 个` : ''));
        metric('上次运行', status.session?.previousUnclean ? '异常退出' : '正常或首次运行', Boolean(status.session?.previousUnclean));
        metric('写入状态', status.degraded ? `降级（${status.lastErrorCode || '未知错误'}）` : status.enabled ? '正常' : '已暂停（日志关闭）', Boolean(status.degraded));
      }
      body.append(createSettingsCard({ title: '日志状态', action: refresh, children: [stateRows] }));
      if (!status) return;
      const enabled = createSettingsToggle({ checked: status.enabled === true, ariaLabel: '启用本地日志',
        onChange: value => void applySettings({ enabled: value }, 'enabled') });
      enabled.element.dataset.logSetting = 'enabled';
      const mode = select('日志级别', [['standard', '标准（INFO 及以上）'], ['verbose', '详细（24 小时）']], status.mode,
        value => void applySettings({ mode: value }, 'mode'));
      mode.dataset.logSetting = 'mode'; mode.disabled = !status.enabled;
      const retention = select('保留天数', [1, 3, 7, 14, 30].map(value => [value, value + ' 天']), status.retentionDays,
        value => void applySettings({ retentionDays: Number(value) }, 'retention'));
      retention.dataset.logSetting = 'retention';
      const capacity = select('空间上限', [10, 20, 50].map(value => [value, value + ' MB']), status.maxTotalMB || 20,
        value => void applySettings({ maxTotalMB: Number(value) }, 'capacity'));
      capacity.dataset.logSetting = 'capacity';
      const settings = createSettingsCard({ title: '日志设置', children: [
        createSettingsRow({ label: '启用本地日志', control: enabled }),
        createSettingsRow({ label: '日志级别', control: mode,
          detail: status.verboseUntil ? '详细模式截止：' + formatLocal(status.verboseUntil) : null }),
        createSettingsRow({ label: '保留天数', control: retention }),
        createSettingsRow({ label: '空间上限', control: capacity }),
      ] });
      settings.classList.add('ui5-logs-settings');
      if (settingsSaving || clearing) for (const control of settings.querySelectorAll('button, select')) control.disabled = true;
      body.append(settings);
      const recent = node('div', 'ui5-logs-list');
      const errors = (status.recentErrors || []).filter(entry => entry?.timestamp && entry?.event);
      if (errors.length) for (const entry of errors) recent.append(renderEntry(entry, true));
      else recent.append(node('p', 'ui5-logs-empty', '最近没有错误或崩溃记录。'));
      body.append(createSettingsCard({ title: '最近错误与崩溃', children: [recent] }));
      const files = node('details', 'ui5-logs-disclosure');
      files.append(node('summary', '', '日志文件'));
      if (!status.files?.length) files.append(node('p', 'ui5-logs-empty', '尚无日志文件。'));
      else for (const file of status.files) {
        const row = node('div', 'ui5-logs-file');
        row.append(node('code', '', file.name), node('span', '', formatBytes(file.size))); files.append(row);
      }
      const clear = button('清理日志…', 'btn danger', () => void clearWithConfirm());
      clear.dataset.logSetting = 'clear'; clear.disabled = settingsSaving || clearing;
      body.append(files, createSettingsRow({ label: '清理本地日志', control: clear }));
      if (focusKey) body.querySelector(`[data-log-setting="${focusKey}"]:not(:disabled)`)?.focus({ preventScroll: true });
    }
    async function applySettings(patch, focusKey) {
      if (settingsSaving || clearing) return;
      const revision = tabRevision, focusOwner = document.activeElement;
      settingsSaving = true; operationError = ''; statusRequest++; statusLoading = false;
      for (const control of body.querySelectorAll('[data-log-setting]')) control.disabled = true;
      const result = await updateLogSettings(patch);
      if (!alive) return;
      settingsSaving = false;
      if (!result?.ok || !result.status) {
        operationError = '日志设置未能确认保存，请检查后重试。';
        await loadStatus();
        if (!alive) return;
      } else { status = result.status; statusError = ''; setRendererLoggingEnabled(status.enabled === true); }
      if (tab === 'overview') renderOverview(revision === tabRevision
        && (document.activeElement === focusOwner || document.activeElement === document.body) ? focusKey : null);
    }
    async function clearWithConfirm() {
      if (clearing || settingsSaving || document.getElementById('confirmLayer')?.hidden === false) return;
      const revision = tabRevision;
      clearing = true; operationError = ''; statusRequest++; statusLoading = false;
      for (const control of body.querySelectorAll('[data-log-setting]')) control.disabled = true;
      const answer = await confirmModal({ title: '清理本地日志',
        message: '删除本机日志文件？设置不会被删除；正在写的日志会重新开始。这个动作不能撤销。',
        okText: '清理日志', cancelText: '取消', danger: true });
      if (!alive) return;
      if (answer === true) {
        const result = await clearLogs();
        if (!alive) return;
        entriesRequest++; entries = []; cursor = null; more = false; loadingEntries = false;
        if (!result?.ok) operationError = '日志未能清理，请检查目录权限。';
        else toast(`已删除 ${result.fileCount} 个日志文件`, 'info');
        clearing = false;
        await loadStatus();
      } else clearing = false;
      if (!alive) return;
      if (tab === 'overview') renderOverview(revision === tabRevision && document.activeElement === document.body ? 'clear' : null);
      else if (answer === true && tab === 'logs') void loadEntries(true);
    }
    function renderLogsTab() {
      const toolbar = node('div', 'ui5-logs-filters');
      const level = select('按级别筛选', [['', '全部级别'], ...LEVELS.map(key => [key, LEVEL_TEXT[key]])], filters.level,
        value => { filters.level = value; void loadEntries(true); });
      level.classList.add('ui5-log-filter-level');
      const source = select('按来源筛选', [['', '全部来源'], ...Object.entries(SOURCE_TEXT)], filters.source,
        value => { filters.source = value; void loadEntries(true); });
      source.classList.add('ui5-log-filter-source');
      const search = node('input', 'ui5-log-search');
      search.type = 'search'; search.maxLength = 100; search.value = filters.q;
      search.placeholder = '搜索事件、错误码或关联标识'; search.setAttribute('aria-label', '搜索日志');
      const searchWrap = node('label', 'ds-search-control ds-search-field ui5-logs-search');
      searchWrap.append(createIcon('search'), search);
      search.oninput = () => {
        filters.q = search.value; clearTimeout(searchTimer);
        // 输入立即令旧响应失效，不等防抖期间回写另一套筛选结果。
        entriesRequest++; loadingEntries = false;
        searchTimer = setTimeout(() => void loadEntries(true), 250);
      };
      search.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); clearTimeout(searchTimer); void loadEntries(true); } };
      const refresh = button('刷新', 'btn ghost', () => void loadEntries(true));
      refresh.setAttribute('aria-label', '刷新日志列表');
      toolbar.append(level, source, searchWrap, refresh);
      countNode = node('p', 'ui5-logs-inline-note'); countNode.setAttribute('role', 'status');
      logListHost = node('div', 'ui5-logs-list');
      body.append(toolbar, countNode, logListHost);
    }
    function renderLogList() {
      if (!logListHost) return;
      logListHost.replaceChildren();
      logListHost.setAttribute('aria-busy', String(loadingEntries));
      countNode.textContent = loadingEntries ? '正在读取日志…' : `已显示 ${entries.length} 条${more ? ' · 还有更早记录' : ''}`;
      if (truncated) countNode.textContent += ' · 读取受安全上限限制';
      if (entriesError) {
        const failure = node('p', 'ui5-logs-error', entriesError); failure.setAttribute('role', 'status');
        logListHost.append(failure, button('重试', 'btn', () => void loadEntries(!cursor)));
      }
      if (!entries.length && !entriesError && !loadingEntries) logListHost.append(node('p', 'ui5-logs-empty',
        filters.level || filters.source || filters.q ? '当前筛选下没有找到日志。' : '尚无日志记录。'));
      for (const entry of entries) logListHost.append(renderEntry(entry));
      if (more && cursor) {
        const older = button('加载更早日志', 'btn', () => void loadEntries(false));
        older.disabled = loadingEntries; logListHost.append(older);
      }
    }
    async function loadEntries(reset = false) {
      if (!alive || tab !== 'logs' || !logListHost || loadingEntries && !reset) return;
      clearTimeout(searchTimer);
      const request = ++entriesRequest;
      loadingEntries = true; entriesError = '';
      if (reset) { entries = []; cursor = null; more = false; truncated = false; }
      renderLogList();
      const params = { limit: '100' };
      if (filters.level) params.level = filters.level;
      if (filters.source) params.source = filters.source;
      if (filters.q.trim()) params.q = filters.q.trim();
      if (!reset && cursor) params.cursor = cursor;
      const result = await fetchLogEntries(params);
      if (!alive || request !== entriesRequest || !logListHost) return;
      loadingEntries = false;
      if (!result?.ok) {
        entriesError = '日志读取失败，请重试。';
        logRendererEvent('ui.logs_view_failed', { operation: 'entries', reason: result?.network ? 'network' : 'read_failed' });
      } else {
        const incoming = Array.isArray(result.entries) ? result.entries : [];
        entries = reset ? incoming : entries.concat(incoming);
        cursor = result.nextCursor || null; truncated = result.truncated === true; more = Boolean(cursor);
      }
      renderLogList();
    }
    activate(tab);
  }, dispose, { className: 'ui5-logs-modal' });
}
