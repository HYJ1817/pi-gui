/* 日志与故障报告（UI-5）。
 *
 * 这一页只做三件事：
 *   1. 展示后端已脱敏的日志状态/条目；
 *   2. 调整标准/详细、保留期与容量；
 *   3. 预览并在本机生成故障报告 ZIP。
 *
 * 它不读取文件系统，不接受路径，不自动上传，也不把日志正文拼成 HTML。
 */
import {
  fetchLogsStatus, fetchLogEntries, updateLogSettings, clearLogs,
  previewLogExport, downloadLogReport, fetchDiagnostics,
} from './api.js';
import { buildDiagnosticSummary, buildLogReference } from './diagnostics.js';
import { fillReviewComposer } from './review-fill.js';
import { openModal, confirmModal } from './ui/modal.js';
import { toast } from './ui/toast.js';
import { logRendererEvent, setRendererLoggingEnabled } from './log-client.js';

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
const SOURCES = ['app', 'electron', 'pi-bridge', 'runtime', 'renderer', 'browser', 'ui', 'network', 'logs', 'settings'];
const LEVEL_TEXT = { DEBUG: '详细', INFO: '信息', WARN: '警告', ERROR: '错误', FATAL: '严重' };
const SOURCE_TEXT = {
  app: '应用', electron: 'Electron', 'pi-bridge': 'Pi Bridge', runtime: 'Runtime', renderer: '界面',
  browser: '浏览器', ui: '界面', network: '网络', logs: '日志', settings: '设置',
};

function node(tag, cls = '', text = '') {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== '') n.textContent = String(text);
  return n;
}

function button(text, cls = 'btn') {
  const b = node('button', cls, text);
  b.type = 'button';
  return b;
}

function formatBytes(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / 1024 / 1024).toFixed(1) + ' MB';
}

function formatLocal(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return String(iso || '—');
  return date.toLocaleString();
}

export function safeEntryText(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const bits = [entry.timestamp, entry.level, entry.source, entry.event];
  if (entry.code) bits.push(entry.code);
  if (entry.correlationId) bits.push('关联 ' + String(entry.correlationId).slice(0, 24));
  const details = entry.details && typeof entry.details === 'object' ? JSON.stringify(entry.details) : '';
  return bits.filter(Boolean).join(' · ') + (details ? '\n' + details : '');
}

function safeCopy(text, message = '已复制') {
  return navigator.clipboard.writeText(String(text ?? '')).then(() => {
    toast(message, 'info');
    return true;
  }).catch(() => {
    toast('复制失败，请手工选中', 'warn');
    return false;
  });
}

/* 「引用到对话」只做一次追加式填入；填不进（未就绪/不属于该会话）时提示原因，
 * 摘要仍由「复制这一条」兜底，绝不自动发送。 */
function referenceEntryToComposer(entry, statusNode) {
  const summary = buildLogReference(entry);
  if (!summary) {
    if (statusNode) statusNode.textContent = '这条日志缺少可引用的字段。';
    return;
  }
  const result = fillReviewComposer(summary);
  if (statusNode) statusNode.textContent = result.ok
    ? `已引用到当前会话${result.appended ? '（追加在原有输入之后）' : ''}；不会自动发送。`
    : `${result.error} 摘要仍在，可用「复制这一条」粘贴。`;
}

function statusRow(label, value, cls = '') {
  const row = node('div');
  row.append(node('span', '', label), node('b', cls, value));
  return row;
}

function moduleLink(text, run) {
  const b = button(text, 'btn');
  b.onclick = run;
  return b;
}

export function openLogs() {
  let alive = true;
  let status = null;
  let statusError = null;
  let tab = 'overview';
  let entries = [];
  let cursor = null;
  let more = false;
  let loadingEntries = false;
  let filters = { level: '', source: '', q: '' };
  let logListHost = null;
  let searchTimer = null;
  let preview = null;
  let exportWindow = 30;
  let exporting = false;
  let statusRequest = 0;
  let entriesRequest = 0;
  let settingsRequest = 0;
  let previewRequest = 0;

  openModal((card, close) => {
    card.classList.add('ui5-logs-modal');
    const tabs = node('div', 'ui5-logs-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '日志与故障报告');
    const tabButtons = {};
    for (const [id, label] of [['overview', '概览'], ['logs', '日志查看'], ['export', '导出故障报告']]) {
      const b = button(label, 'ui5-logs-tab');
      b.id = 'ui5-log-tab-' + id;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', 'ui5-logs-body');
      b.setAttribute('aria-selected', String(id === tab));
      b.onclick = () => activate(id);
      tabButtons[id] = b;
      tabs.appendChild(b);
    }
    const body = node('div', 'ui5-logs-body');
    body.id = 'ui5-logs-body';
    body.setAttribute('role', 'tabpanel');
    const actions = node('div', 'modal-actions');
    const refresh = button('刷新');
    refresh.onclick = () => { void reloadAll(); };
    const done = button('关闭', 'btn primary');
    done.onclick = close;
    actions.append(refresh, done);

    const heading = node('h3', '', '日志与故障报告');
    const desc = node('div', 'modal-desc', '本地日志只保存在这台机器上，不会自动上传。这里显示的是后端再次脱敏后的结构化事件；复制/导出前请自行检查。');
    card.append(heading, desc, tabs, body, actions);

    function setTab(id) {
      tab = id;
      /* 切走时让旧的日志读取失效；否则慢请求回来会把 loading 永久留在 true。 */
      entriesRequest++;
      loadingEntries = false;
      for (const [key, b] of Object.entries(tabButtons)) b.setAttribute('aria-selected', String(key === id));
      body.replaceChildren();
      logListHost = null;
      if (id === 'overview') renderOverview();
      else if (id === 'logs') renderLogsTab();
      else renderExportTab();
    }

    function activate(id) {
      if (tab === id) return;
      setTab(id);
      if (id === 'logs' && !entries.length) void loadEntries(true);
      if (id === 'export') {
        /* 先读一次状态，确保磁盘占用/禁用状态是当前的。 */
        void loadStatus(false);
      }
    }

    async function loadStatus(render = true) {
      const request = ++statusRequest;
      const result = await fetchLogsStatus();
      if (!alive || request !== statusRequest) return;
      if (!result || result.ok === false || !result.status) {
        statusError = result?.error || '无法读取日志状态';
        if (render && tab === 'overview') renderOverview();
        logRendererEvent('ui.logs_view_failed', { operation: 'status', reason: 'read_failed' });
        return;
      }
      status = result.status;
      statusError = null;
      /* 后端是启用状态的唯一真相；这里只把结果同步给上报客户端，
       * 让“用户关闭日志”和“日志重新启用”都不需要额外的业务状态机。 */
      setRendererLoggingEnabled(status.enabled === true);
      if (render && tab === 'overview') renderOverview();
      if (tab === 'logs' && logListHost && !entries.length) {
        const source = document.querySelector('.ui5-log-filter-source');
        if (source && source.options.length <= 1) populateSources(source);
      }
    }

    async function reloadAll() {
      await loadStatus(tab === 'overview');
      if (tab === 'logs') await loadEntries(true);
    }

    function populateSources(select) {
      const current = select.value;
      select.replaceChildren(node('option', '', '全部来源'));
      select.firstChild.value = '';
      const list = new Set(SOURCES);
      for (const file of status?.files || []) {
        if (file.role === 'main' || file.role === 'app') {
          /* 文件不是来源；这里只保留固定来源，避免把文件名当用户内容。 */
        }
      }
      for (const source of list) {
        const opt = node('option', '', SOURCE_TEXT[source] || source);
        opt.value = source;
        select.appendChild(opt);
      }
      select.value = [...select.options].some((o) => o.value === current) ? current : '';
    }

    function renderOverview() {
      body.replaceChildren();
      const top = node('div', 'ui5-logs-toolbar');
      const openViewer = button('打开日志查看');
      openViewer.onclick = () => activate('logs');
      const copyDiagnostic = button('复制诊断摘要');
      copyDiagnostic.onclick = () => void copyDiagnosticSummary();
      const exportButton = button('导出故障报告', 'btn primary');
      exportButton.onclick = () => activate('export');
      top.append(openViewer, copyDiagnostic, exportButton);
      if (!status) {
        if (statusError) {
          body.append(node('div', 'ui5-logs-empty ui5-logs-error', statusError));
        } else {
          body.append(node('div', 'ui5-logs-empty', '正在读取日志状态…'));
        }
        body.appendChild(top);
        return;
      }
      body.appendChild(top);

      const summary = node('div', 'stat-rows ui5-logs-summary');
      summary.append(
        statusRow('状态', status.enabled ? '已开启' : '已关闭', status.enabled ? '' : 'dim'),
        statusRow('模式', status.mode === 'verbose' ? '详细（24 小时后自动回标准）' : '标准'),
        statusRow('保留', status.retentionDays + ' 天 · 总上限 ' + status.maxTotalMB + ' MB'),
        statusRow('磁盘占用', formatBytes(status.usageBytes) + ' · ' + status.fileCount + ' 个文件' + (status.crashFileCount ? ` · 崩溃 ${status.crashFileCount}` : '')),
        statusRow('上次运行', status.session?.previousUnclean ? '异常退出，已有新线索' : '正常或首次运行', status.session?.previousUnclean ? 'warn' : 'dim'),
        statusRow('写入状态', status.degraded ? `降级（${status.lastErrorCode || 'unknown'}）` : '正常', status.degraded ? 'warn' : ''),
      );
      if (status.verboseUntil) summary.append(statusRow('详细模式截止', formatLocal(status.verboseUntil)));
      body.appendChild(summary);

      body.appendChild(node('div', 'ext-sec-head', '日志设置'));
      const form = node('div', 'ui5-logs-settings');
      const enabledLabel = node('label', 'ui5-logs-check');
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = status.enabled === true;
      enabled.onchange = () => void applySettings({ enabled: enabled.checked });
      enabledLabel.append(enabled, node('span', '', '启用本地日志'));
      form.appendChild(enabledLabel);
      const modeLabel = node('label', 'ui5-logs-field');
      modeLabel.appendChild(node('span', '', '日志级别'));
      const mode = document.createElement('select');
      mode.setAttribute('aria-label', '日志级别');
      for (const [value, text] of [['standard', '标准（INFO 及以上）'], ['verbose', '详细（含临时技术元信息）']]) {
        const opt = node('option', '', text); opt.value = value; mode.appendChild(opt);
      }
      mode.value = status.mode === 'verbose' ? 'verbose' : 'standard';
      mode.disabled = !status.enabled;
      mode.onchange = () => void applySettings({ mode: mode.value });
      modeLabel.appendChild(mode);
      form.appendChild(modeLabel);
      const retentionLabel = node('label', 'ui5-logs-field');
      retentionLabel.appendChild(node('span', '', '保留天数'));
      const retention = document.createElement('select');
      retention.setAttribute('aria-label', '保留天数');
      for (const days of [1, 3, 7, 14, 30]) {
        const opt = node('option', '', days + ' 天'); opt.value = String(days); retention.appendChild(opt);
      }
      retention.value = String(status.retentionDays);
      retention.onchange = () => void applySettings({ retentionDays: Number(retention.value) });
      retentionLabel.appendChild(retention);
      form.appendChild(retentionLabel);
      const capLabel = node('label', 'ui5-logs-field');
      capLabel.appendChild(node('span', '', '空间上限'));
      const cap = document.createElement('select');
      cap.setAttribute('aria-label', '空间上限');
      for (const mb of [10, 20, 50]) {
        const opt = node('option', '', mb + ' MB'); opt.value = String(mb); cap.appendChild(opt);
      }
      cap.value = String(status.maxTotalMB || 20);
      cap.onchange = () => void applySettings({ maxTotalMB: Number(cap.value) });
      capLabel.appendChild(cap);
      form.appendChild(capLabel);
      body.appendChild(form);

      const controls = node('div', 'ui5-logs-toolbar');
      const clear = button('清理日志', 'btn danger');
      clear.onclick = () => void clearWithConfirm();
      controls.append(clear);
      if (status.degraded) controls.append(node('span', 'ui5-logs-inline-note', '磁盘写入异常：日志会降级，但不影响聊天与工具。'));
      body.appendChild(controls);

      body.appendChild(node('div', 'ext-sec-head', '最近错误'));
      const recentErrors = (status.recentErrors || []).filter((entry) => entry && entry.timestamp && entry.event);
      if (!recentErrors.length) {
        body.appendChild(node('div', 'ui5-logs-empty', '最近没有 WARN / ERROR / FATAL 级记录的崩溃类事件。'));
      } else {
        for (const entry of recentErrors) body.appendChild(renderEntry(entry, { compact: true }));
      }

      body.appendChild(node('div', 'ext-sec-head', '最近日志文件'));
      if (!(status.files || []).length) {
        body.appendChild(node('div', 'ui5-logs-empty', '尚无日志文件。启用日志并产生事件后会出现。'));
      } else {
        const files = node('div', 'ui5-logs-files');
        for (const file of status.files.slice(0, 12)) {
          const row = node('div', 'ui5-logs-file');
          row.append(node('span', 'ui5-logs-file-name', file.name), node('b', '', formatBytes(file.size)));
          files.appendChild(row);
        }
        body.appendChild(files);
      }
    }

    async function copyDiagnosticSummary() {
      const payload = await fetchDiagnostics();
      if (!alive) return;
      const diagnostics = payload && payload.ok !== false ? payload.diagnostics : null;
      let text = diagnostics ? buildDiagnosticSummary(diagnostics) : '诊断快照暂时不可用。';
      if (status) {
        const recentErrors = (status.recentErrors || []).filter((entry) => entry && entry.timestamp && entry.event);
        text += '\n\n本地日志状态\n' + [
          `状态：${status.enabled ? '开启' : '关闭'}`,
          `模式：${status.mode}`,
          `文件：${status.fileCount}，占用：${formatBytes(status.usageBytes)}`,
          status.session?.previousUnclean ? '上次运行：异常退出' : '上次运行：正常或首次',
        ].join('\n');
        if (recentErrors.length) {
          text += '\n最近错误：\n' + recentErrors.map((e) => `${e.timestamp} ${e.level} ${e.source} ${e.event}${e.code ? ' ' + e.code : ''}`).join('\n');
        }
      }
      await safeCopy(text, '诊断摘要已复制（不含正文与凭据）');
    }

    async function applySettings(patch) {
      const request = ++settingsRequest;
      const result = await updateLogSettings(patch);
      if (!alive || request !== settingsRequest) return;
      if (!result?.ok) {
        toast(result?.code === 'settings_write_failed' ? '日志设置未能保存（目录不可写）' : '日志设置无效或未能保存', 'warn');
        await loadStatus(tab === 'overview');
        return;
      }
      status = result.status || status;
      setRendererLoggingEnabled(status.enabled === true);
      if (tab === 'overview') renderOverview();
      toast('日志设置已更新', 'info');
    }

    async function clearWithConfirm() {
      const answer = await confirmModal({
        title: '清理本地日志',
        message: '删除本机日志文件？设置不会被删除；正在写的日志会重新开始。这个动作不能撤销。',
        okText: '清理日志',
        cancelText: '取消',
        danger: true,
      });
      if (answer !== true || !alive) return;
      const result = await clearLogs();
      if (!alive) return;
      if (!result?.ok) {
        toast('日志未能清理，请检查目录权限', 'warn');
        return;
      }
      entries = [];
      cursor = null;
      more = false;
      toast(`已清理 ${result.fileCount} 个日志文件`, 'info');
      await loadStatus(tab === 'overview');
    }

    function renderEnteredEntry(entry) {
      const article = node('article', 'ui5-log-entry');
      article.dataset.level = entry.level || 'INFO';
      const head = node('div', 'ui5-log-entry-head');
      const time = node('time', 'ui5-log-time', formatLocal(entry.timestamp));
      time.dateTime = entry.timestamp || '';
      time.title = entry.timestamp || '';
      const level = node('span', 'ui5-log-level', LEVEL_TEXT[entry.level] || entry.level || '未知');
      level.dataset.level = entry.level || 'INFO';
      const source = node('span', 'ui5-log-source', SOURCE_TEXT[entry.source] || entry.source || '未知');
      const event = node('span', 'ui5-log-event', entry.event || '未知事件');
      head.append(time, level, source, event);
      if (entry.code) head.append(node('code', 'ui5-log-code', entry.code));
      article.appendChild(head);
      const details = node('details', 'ui5-log-details');
      if (entry.level === 'ERROR' || entry.level === 'FATAL') details.open = true;
      const summary = node('summary', '', '展开安全摘要');
      details.appendChild(summary);
      const meta = node('div', 'ui5-log-meta');
      if (entry.correlationId) meta.appendChild(node('div', '', '关联标识：' + entry.correlationId));
      if (Number.isFinite(entry.durationMs)) meta.appendChild(node('div', '', '耗时：' + entry.durationMs + ' ms'));
      if (entry.details && Object.keys(entry.details).length) {
        const pre = node('pre', 'ui5-log-detail-json');
        pre.textContent = JSON.stringify(entry.details, null, 2);
        meta.appendChild(pre);
      }
      details.appendChild(meta);
      const entryStatus = node('span', 'ui5-log-ref-status');
      entryStatus.setAttribute('role', 'status');
      const actions = node('div', 'ui5-log-actions');
      const copy = button('复制这一条', 'btn ui5-log-copy');
      copy.onclick = () => void safeCopy(safeEntryText(entry), '已复制脱敏日志摘要');
      const reference = button('引用到对话', 'btn ui5-log-copy');
      reference.title = '把脱敏摘要追加到当前会话输入框；不会自动发送';
      reference.onclick = () => referenceEntryToComposer(entry, entryStatus);
      actions.append(copy, reference, entryStatus);
      details.appendChild(actions);
      article.appendChild(details);
      return article;
    }

    function renderEntry(entry, { compact = false } = {}) {
      if (!compact) return renderEnteredEntry(entry);
      const row = node('div', 'ui5-logs-recent-error');
      row.append(
        node('span', 'ui5-log-time', formatLocal(entry.timestamp)),
        node('span', 'ui5-log-level', LEVEL_TEXT[entry.level] || entry.level || '未知'),
        node('span', '', `${entry.source || '未知'} · ${entry.event || '未知事件'}${entry.code ? ' · ' + entry.code : ''}`),
      );
      if (entry.level === 'ERROR' || entry.level === 'WARN') {
        const feedback = node('span', 'ui5-log-ref-status');
        feedback.setAttribute('role', 'status');
        feedback.setAttribute('aria-live', 'polite');
        const reference = button('引用', 'btn tiny ui5-log-ref');
        reference.title = '把脱敏摘要追加到当前会话输入框；不会自动发送';
        reference.onclick = () => referenceEntryToComposer(entry, feedback);
        const actions = node('div', 'ui5-log-actions');
        actions.append(reference, feedback);
        row.appendChild(actions);
      }
      return row;
    }

    function renderLogsTab() {
      body.replaceChildren();
      const filtersBar = node('div', 'ui5-logs-filters');
      const level = document.createElement('select');
      level.className = 'ui5-log-filter-level';
      level.setAttribute('aria-label', '按级别筛选');
      const allLevels = node('option', '', '全部级别'); allLevels.value = ''; level.appendChild(allLevels);
      for (const l of LEVELS) { const o = node('option', '', LEVEL_TEXT[l]); o.value = l; level.appendChild(o); }
      level.value = filters.level;
      const source = document.createElement('select');
      source.className = 'ui5-log-filter-source';
      source.setAttribute('aria-label', '按来源筛选');
      populateSources(source);
      source.value = filters.source;
      const search = document.createElement('input');
      search.className = 'ui5-log-search';
      search.type = 'search';
      search.placeholder = '搜索事件代码或说明';
      search.setAttribute('aria-label', '搜索日志');
      search.value = filters.q;
      const searchWrap = node('label', 'ui5-logs-search');
      searchWrap.appendChild(search);
      const refresh = button('刷新');
      refresh.onclick = () => void loadEntries(true);
      level.onchange = () => { filters.level = level.value; void loadEntries(true); };
      source.onchange = () => { filters.source = source.value; void loadEntries(true); };
      search.oninput = () => {
        filters.q = search.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { void loadEntries(true); }, 250);
      };
      filtersBar.append(level, source, searchWrap, refresh);
      body.appendChild(filtersBar);
      const count = node('div', 'ui5-logs-inline-note', '');
      body.appendChild(count);
      logListHost = node('div', 'ui5-logs-list');
      body.appendChild(logListHost);
      renderLogList(count);
      if (!entries.length && !loadingEntries) void loadEntries(true);
    }

    function renderLogList(countNode = null) {
      if (!logListHost) return;
      logListHost.replaceChildren();
      if (loadingEntries) {
        logListHost.appendChild(node('div', 'ui5-logs-empty', '正在读取最近日志…'));
        return;
      }
      if (!entries.length) {
        logListHost.appendChild(node('div', 'ui5-logs-empty', '当前筛选下没有日志。日志关闭或尚未产生事件时这是正常的。'));
        if (countNode) countNode.textContent = '';
        return;
      }
      if (countNode) countNode.textContent = `显示最近 ${entries.length} 条${more ? ' · 还有更早记录' : ''}`;
      for (const entry of entries) logListHost.appendChild(renderEnteredEntry(entry));
      if (more && cursor) {
        const loadMore = button('加载更早日志');
        loadMore.onclick = () => void loadEntries(false);
        logListHost.appendChild(loadMore);
      }
    }

    async function loadEntries(reset = false) {
      const request = ++entriesRequest;
      loadingEntries = true;
      const countNode = body.querySelector('.ui5-logs-inline-note');
      if (reset) { entries = []; cursor = null; more = false; }
      renderLogList(countNode);
      const params = { limit: '100' };
      if (filters.level) params.level = filters.level;
      if (filters.source) params.source = filters.source;
      if (filters.q.trim()) params.q = filters.q.trim();
      if (!reset && cursor) params.cursor = cursor;
      const result = await fetchLogEntries(params);
      if (!alive || request !== entriesRequest || !logListHost) return;
      loadingEntries = false;
      if (!result || result.ok === false) {
        logListHost.replaceChildren(node('div', 'ui5-logs-empty ui5-logs-error', '日志读取失败。请刷新重试；这不影响聊天。'));
        logRendererEvent('ui.logs_view_failed', { operation: 'entries', reason: result?.network ? 'network' : 'read_failed' });
        return;
      }
      const incoming = Array.isArray(result.entries) ? result.entries : [];
      entries = reset ? incoming : entries.concat(incoming);
      cursor = result.nextCursor || null;
      more = result.truncated === true && Boolean(cursor);
      renderLogList(countNode);
    }

    function renderExportTab() {
      body.replaceChildren();
      const intro = node('div', 'ui5-logs-export-intro',
        '报告在本机生成，不上传、不创建 Issue、不自动访问网站。默认只包含最近 30 分钟的结构化事件，'
        + '不会包含聊天历史、项目文件、截图或配置正文。');
      body.appendChild(intro);
      const form = node('div', 'ui5-logs-export-form');
      const windowLabel = node('label', 'ui5-logs-field');
      windowLabel.appendChild(node('span', '', '时间范围'));
      const windowSelect = document.createElement('select');
      windowSelect.setAttribute('aria-label', '故障报告时间范围');
      for (const [value, text] of [['30', '最近 30 分钟'], ['120', '最近 2 小时'], ['1440', '最近 24 小时']]) {
        const opt = node('option', '', text); opt.value = value; windowSelect.appendChild(opt);
      }
      windowSelect.value = String(exportWindow);
      windowSelect.onchange = () => {
        previewRequest++;
        exportWindow = Number(windowSelect.value);
        preview = null;
        renderPreview();
      };
      windowLabel.appendChild(windowSelect);
      form.appendChild(windowLabel);

      const problemLabel = node('label', 'ui5-logs-field ui5-logs-field-block');
      problemLabel.appendChild(node('span', '', '问题描述（可选）'));
      const problem = document.createElement('textarea');
      problem.rows = 3;
      problem.maxLength = 2000;
      problem.placeholder = '一句话说明发生了什么。不要粘贴聊天正文、密钥或完整路径。';
      problem.setAttribute('aria-label', '问题描述');
      problemLabel.appendChild(problem);
      form.appendChild(problemLabel);

      const reproLabel = node('label', 'ui5-logs-field ui5-logs-field-block');
      reproLabel.appendChild(node('span', '', '复现步骤（可选）'));
      const repro = document.createElement('textarea');
      repro.rows = 3;
      repro.maxLength = 2000;
      repro.placeholder = '例如：打开设置 → 诊断与日志 → 导出故障报告。';
      repro.setAttribute('aria-label', '复现步骤');
      reproLabel.appendChild(repro);
      form.appendChild(reproLabel);
      body.appendChild(form);

      const previewHost = node('div', 'ui5-logs-preview');
      body.appendChild(previewHost);
      let exportButton = null;

      const actions = node('div', 'ui5-logs-export-actions');
      const previewButton = button('预览摘要');
      previewButton.onclick = async () => {
        const request = ++previewRequest;
        previewButton.disabled = true;
        preview = null;
        renderPreview();
        const result = await previewLogExport(exportWindow);
        previewButton.disabled = false;
        if (!alive || request !== previewRequest) return;
        if (!result?.ok) {
          previewHost.replaceChildren(node('div', 'ui5-logs-error', '无法预览导出内容，请检查日志目录后重试。'));
          return;
        }
        preview = result;
        renderPreview();
      };
      exportButton = button('确认导出 ZIP', 'btn primary');
      exportButton.disabled = true;
      exportButton.onclick = async () => {
        if (!preview || exporting) return;
        exporting = true;
        exportButton.disabled = true;
        const result = await downloadLogReport({
          windowMinutes: exportWindow,
          description: problem.value,
          repro: repro.value,
        });
        exporting = false;
        if (!alive) return;
        if (!result?.ok) {
          exportButton.disabled = false;
          logRendererEvent('ui.logs_export_failed', { reason: result?.network ? 'network' : 'export_failed' });
          const fallback = button('复制安全摘要（降级）');
          fallback.onclick = () => void copyFallbackSummary();
          previewHost.replaceChildren(node('div', 'ui5-logs-error', '故障报告未能生成。你仍可复制安全摘要并手工发给开发者。'), fallback);
          return;
        }
        toast('故障报告已保存（ZIP 在本机生成）', 'success');
        exportButton.disabled = false;
      };
      actions.append(previewButton, exportButton);
      body.appendChild(actions);

      function renderPreview() {
        previewHost.replaceChildren();
        exportButton.disabled = !preview;
        if (!preview) {
          previewHost.appendChild(node('div', 'ui5-logs-empty', '请先预览摘要，再确认导出。'));
          return;
        }
        const rows = node('div', 'stat-rows');
        rows.append(
          statusRow('时间范围', '最近 ' + (preview.windowMinutes || exportWindow) + ' 分钟'),
          statusRow('事件', String(preview.entryCount ?? 0) + (preview.truncated ? '（已截断到安全上限）' : '')),
          statusRow('错误', String(preview.errorCount ?? 0)),
          statusRow('ZIP 清单', (preview.filesIncluded || []).join(' · ')),
        );
        previewHost.appendChild(rows);
        if (preview.truncated) previewHost.appendChild(node('div', 'ui5-logs-inline-note', '日志超过导出上限，只包含最近允许的条目；报告内会标记截断。'));
      }

      async function copyFallbackSummary() {
        const payload = await fetchDiagnostics();
        const diagnostics = payload && payload.ok !== false ? payload.diagnostics : null;
        let text = diagnostics ? buildDiagnosticSummary(diagnostics) : '诊断快照暂时不可用。';
        if (status) {
          text += '\n\n本地日志状态\n' + [
            `状态：${status.enabled ? '开启' : '关闭'}`,
            `模式：${status.mode}`,
            `文件：${status.fileCount}，占用：${formatBytes(status.usageBytes)}`,
            status.session?.previousUnclean ? '上次运行：异常退出' : '上次运行：正常或首次',
          ].join('\n');
          if ((status.recentErrors || []).length) {
            text += '\n最近错误：\n' + status.recentErrors.map((e) => `${e.timestamp} ${e.level} ${e.source} ${e.event}${e.code ? ' ' + e.code : ''}`).join('\n');
          }
        }
        await safeCopy(text, '安全摘要已复制');
      }

      renderPreview();
    }

    setTab('overview');
    void loadStatus(true);

    /* 关闭时停掉搜索防抖；不取消已经完成的只读读取，避免对后端发第二次请求。 */
    return () => {
      alive = false;
      clearTimeout(searchTimer);
    };
  }, () => {
    alive = false;
    clearTimeout(searchTimer);
  }, { className: 'ui5-logs-modal' });
}
