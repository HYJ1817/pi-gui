/* MCP 管理页。
 *
 * 页面只读后端的安全投影：
 *   - 列表来自 GET /api/mcp/servers（配置事实 + 上次运行时报告）；
 *   - 详情来自 GET /api/mcp/config（env / header 的敏感字面值永远不回传）；
 *   - 写操作全部走 POST /api/mcp/config（原子写 + 备份 + revision 守卫）；
 *   - 运行时状态只有用户点「刷新状态 / 测试连接」时才请求 pi mcp list。
 *
 * 三个状态始终分开表达：配置已保存、连接成功、Agent 会话已加载。
 * 这个页面不会把任何一条说成另外两条。
 */
import { S } from './state.js';
import {
  fetchMcpServers, fetchMcpConfig, fetchMcpConfigDetail, mcpConfigAction,
  mcpServerAction, refreshMcpStatus, fetchMcpImport, mcpImportApply, fetchProjects,
} from './api.js';
import { activateProject } from './projects.js';
import { projectWorkSurface, workspaceView } from './ui/workspace-surface.js';
import { openModal, closeModal, confirmModal } from './ui/modal.js';
import { toast } from './ui/toast.js';
import {
  MCP_NAME_RE, badge, button, icon, node, relativeTime, runtimeServerFor,
  scopeLabel, serverStatus, statusDot, transportLabel,
} from './mcp-shared.js';
import { openMcpMarket } from './mcp-market.js';

/* ---------- 输入校验（与 server/mcp-config.js 的同一套判据） ---------- */

const SENSITIVE_NAME_RE = /(^|[_-])(token|secret|password|passwd|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|auth)([_-]|$)/i;
const SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'api-key', 'x-auth-token', 'x-access-token',
]);
const SECRET_VALUE_RE = /^(?:sk-|pk-|gh[pousr]_|github_pat_|AKIA|ASIA|xox[baprs]-|eyJ[A-Za-z0-9_-]{10,}\.)/;
const REFERENCE_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const SCHEMED_REFERENCE_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+[ \t]+\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXPOSURES = new Set(['codemode', 'deferred', 'direct', 'hidden']);
const EXPOSURE_OPTIONS = [
  ['codemode', 'codemode（默认：按需代码模式）'],
  ['deferred', 'deferred（延迟暴露工具）'],
  ['direct', 'direct（工具直接暴露给 Agent）'],
  ['hidden', 'hidden（对 Agent 隐藏）'],
];

export function settingNeedsReference(key, value, isHeader = false) {
  if (SENSITIVE_NAME_RE.test(String(key)) || /authorization|credential/i.test(String(key))) return true;
  if (isHeader && SENSITIVE_HEADERS.has(String(key).toLowerCase())) return true;
  if (SECRET_VALUE_RE.test(String(value || ''))) return true;
  if (isHeader && /^(?:bearer|basic|token|digest|negotiate)\s+/i.test(String(value))) return true;
  return false;
}

function isReferenceValue(value, isHeader) {
  return isHeader
    ? REFERENCE_RE.test(value) || SCHEMED_REFERENCE_RE.test(value)
    : REFERENCE_RE.test(value);
}

/* ---------- 小工具 ---------- */

let uidSeq = 0;
function fieldId() { return `mcp-field-${++uidSeq}`; }

function textInput({ value = '', placeholder = '', field = '', ariaLabel = '', type = 'text', autocomplete = 'off' } = {}) {
  const input = node('input', 'mcp-input ds-input');
  input.type = type;
  input.value = value;
  input.autocomplete = autocomplete;
  if (placeholder) input.placeholder = placeholder;
  if (field) input.dataset.field = field;
  if (ariaLabel) input.setAttribute('aria-label', ariaLabel);
  return input;
}

function labeledField(labelText, control, hint = '') {
  const id = control.id || fieldId();
  control.id = id;
  const wrap = node('label', 'mcp-field');
  wrap.htmlFor = id;
  wrap.appendChild(node('span', 'mcp-field-label', labelText));
  wrap.appendChild(control);
  if (hint) wrap.appendChild(node('span', 'mcp-field-hint', hint));
  return wrap;
}

function formSection(title, ...children) {
  const section = node('section', 'mcp-form-section');
  if (title) section.appendChild(node('h4', 'mcp-form-section-title', title));
  for (const child of children) if (child) section.appendChild(child);
  return section;
}

function iconButton(name, label, title, className = 'mcp-icon-btn') {
  const b = button(className, '', { label, title });
  b.appendChild(icon(name, 'mcp-icon'));
  return b;
}

function exposureSelect(value, onChange, { inherit = false } = {}) {
  const select = node('select', 'mcp-input ds-input mcp-select');
  select.dataset.field = 'exposure';
  const blank = node('option', '', inherit ? '继承全局（不覆盖）' : '不显式设置（Pi 默认 codemode）');
  blank.value = '';
  select.appendChild(blank);
  for (const [key, label] of EXPOSURE_OPTIONS) {
    const option = node('option', '', label);
    option.value = key;
    select.appendChild(option);
  }
  select.value = EXPOSURES.has(value) ? value : '';
  select.onchange = () => onChange(select.value);
  return select;
}

function makeSwitch(checked, label, { disabled = false, title = '' } = {}) {
  const b = button('ds-switch' + (checked ? ' is-on' : ''), '', { label, title });
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(checked));
  b.disabled = disabled;
  b.appendChild(node('span', 'ds-switch-knob'));
  return b;
}

function clearAndFocusError(card, message, selector) {
  const box = card.querySelector('.mcp-form-error');
  if (box) { box.textContent = message; box.hidden = false; }
  if (selector) card.querySelector(selector)?.focus();
}

function serverFilenamePath(data, scope) {
  const files = data && data.files;
  if (scope === 'project') return files?.project?.path || '';
  return files?.user?.path || '';
}

function statusToneClass(tone) {
  return `is-${tone || 'dim'}`;
}

function errorText(result) {
  if (!result) return '请求失败（没有响应）';
  if (typeof result.error === 'string' && result.error) return result.error;
  if (result.code === 'workspace-stale') return '项目已切换，这次操作作废。';
  return '操作失败';
}

/* ---------- 新建 / 编辑表单 ---------- */

function emptyDraft(defaultScope) {
  return {
    mode: 'add',
    scope: defaultScope === 'project' ? 'project' : 'user',
    overrideOnly: false,
    name: '',
    originalName: '',
    transport: 'stdio',
    commandChoice: 'npx',
    command: 'npx',
    args: [],
    argsProtected: false,
    argsCount: 0,
    env: [],
    url: '',
    urlProtected: false,
    headers: [],
    description: '',
    timeout: '',
    exposure: 'codemode',
    enabled: true,
    oauth: false,
    auth: false,
    inherited: null,
  };
}

function draftFromDetail(detail, server) {
  const entry = detail.entry || {};
  const transport = detail.overrideOnly ? 'stdio' : (entry.type === 'http' ? 'http' : 'stdio');
  const command = typeof entry.command === 'string' && entry.command ? entry.command : 'npx';
  const choice = command === 'npx' || command === 'uvx' ? command : 'custom';
  const draft = emptyDraft(detail.scope);
  draft.mode = 'edit';
  draft.scope = detail.scope === 'project' ? 'project' : 'user';
  draft.overrideOnly = detail.overrideOnly === true;
  draft.name = detail.name || server?.name || '';
  draft.originalName = draft.name;
  draft.transport = transport;
  draft.commandChoice = choice;
  draft.command = command;
  draft.args = Array.isArray(entry.args) ? entry.args.slice() : [];
  draft.argsProtected = entry.argsProtected === true;
  draft.argsCount = typeof entry.argsCount === 'number' ? entry.argsCount : draft.args.length;
  draft.env = Array.isArray(entry.env)
    ? entry.env.map((row) => ({
      key: row.key, value: row.value ?? '', keep: row.secret === true, sensitive: row.secret === true, originalKey: row.key,
    }))
    : [];
  draft.url = typeof entry.url === 'string' ? entry.url : '';
  draft.urlProtected = entry.urlProtected === true;
  draft.headers = Array.isArray(entry.headers)
    ? entry.headers.map((row) => ({
      key: row.key, value: row.value ?? '', keep: row.secret === true, sensitive: row.secret === true, originalKey: row.key,
    }))
    : [];
  draft.description = entry.description || '';
  draft.timeout = typeof entry.timeout === 'number' ? String(entry.timeout) : '';
  /* 编辑时回填原始 exposure；没有显式设置就保持空，避免一次普通编辑
   * 把“未设置（Pi 默认）”改写成显式的 codemode。 */
  draft.exposure = EXPOSURES.has(entry.exposure) ? entry.exposure : '';
  draft.enabled = entry.enabled !== false;
  draft.oauth = entry.oauth === true;
  draft.auth = entry.auth === true;
  draft.inherited = entry.inherited || null;
  return draft;
}

function settingRowsPayload(rows, isHeader) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const key = String(row.key || '').trim();
    const rawValue = typeof row.value === 'string' ? row.value : '';
    if (!key && !rawValue && row.keep !== true) continue;
    const label = isHeader ? '请求头' : '环境变量';
    if (!key) return { ok: false, error: `${label}第 ${i + 1} 行缺少名称`, field: `${isHeader ? 'header' : 'env'}-key-${i}` };
    const keyRe = isHeader ? HEADER_NAME_RE : ENV_NAME_RE;
    if (!keyRe.test(key)) return { ok: false, error: `${label}“${key}” 的名称不合法`, field: `${isHeader ? 'header' : 'env'}-key-${i}` };
    if (seen.has(key)) return { ok: false, error: `${label}“${key}” 重复`, field: `${isHeader ? 'header' : 'env'}-key-${i}` };
    seen.add(key);
    if (row.keep === true) {
      out.push({ key, keep: true });
      continue;
    }
    const value = isHeader ? rawValue.trim() : rawValue.trim();
    if (!value) return { ok: false, error: `${label}“${key}” 缺少值`, field: `${isHeader ? 'header' : 'env'}-value-${i}` };
    if (settingNeedsReference(key, value, isHeader) && !isReferenceValue(value, isHeader)) {
      return {
        ok: false,
        error: `${label}“${key}” 看起来包含凭据。请填写 \${环境变量名} 引用${isHeader ? '（Authorization 可写 “Bearer \${TOKEN}”）' : ''}，Pi GUI 不接收明文凭据。`,
        field: `${isHeader ? 'header' : 'env'}-value-${i}`,
      };
    }
    out.push({ key, value });
  }
  return { ok: true, rows: out };
}

function buildSavePayload(draft, revision) {
  const name = String(draft.name || '').trim();
  if (!MCP_NAME_RE.test(name)) {
    return { ok: false, error: '名称只能包含字母、数字、下划线和连字符（1–64 字符）', field: 'name' };
  }
  const description = String(draft.description || '').trim();
  if (description.length > 200) return { ok: false, error: '描述最多 200 个字符', field: 'description' };
  let timeout = '';
  if (String(draft.timeout).trim() !== '') {
    const n = Number(draft.timeout);
    if (!Number.isInteger(n) || n < 1 || n > 3600) return { ok: false, error: '超时必须是 1–3600 秒的整数', field: 'timeout' };
    timeout = n;
  }

  const payload = {
    action: 'save',
    scope: draft.scope,
    name,
    originalName: draft.mode === 'edit' ? draft.originalName : undefined,
    transport: draft.transport,
    description,
    timeout,
    exposure: EXPOSURES.has(draft.exposure) ? draft.exposure : '',
    enabled: Boolean(draft.enabled),
  };
  if (typeof revision === 'string') payload.expectedRevision = revision;

  if (draft.overrideOnly) {
    payload.overrideOnly = true;
    return { ok: true, payload };
  }

  if (draft.transport === 'stdio') {
    const command = String(draft.commandChoice === 'custom' ? draft.command : draft.commandChoice).trim();
    if (!command) return { ok: false, error: '请填写要启动的可执行文件', field: 'command-custom' };
    const env = settingRowsPayload(draft.env, false);
    if (!env.ok) return env;
    payload.command = command;
    /* argsProtected：详情接口没有把含敏感值的参数回填过来。省略 args
     * 让服务端保留原值，避免用空数组或 "***" 覆盖真实参数。 */
    if (!draft.argsProtected) payload.args = draft.args.map((a) => String(a));
    payload.env = env.rows;
  } else {
    const rawUrl = String(draft.url || '').trim();
    /* 含凭据的 URL 不会回填；留空表示原样保留，由服务端从原条目取回。
     * 一旦用户填了新地址，就按普通 URL 的完整校验处理。 */
    if (draft.urlProtected && !rawUrl) {
      payload.keepUrl = true;
    } else {
      let parsed;
      try { parsed = new URL(rawUrl); } catch {
        return { ok: false, error: '服务器地址不是合法 URL', field: 'url' };
      }
      if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: 'URL 只支持 http / https', field: 'url' };
      if (parsed.username || parsed.password) return { ok: false, error: 'URL 不能包含用户名或密码；请改用请求头引用', field: 'url' };
      payload.url = parsed.toString();
    }
    const headers = settingRowsPayload(draft.headers, true);
    if (!headers.ok) return headers;
    payload.headers = headers.rows;
  }
  return { ok: true, payload };
}

function openServerForm({
  mode, server = null, detail = null, defaultScope = 'user', trust = null,
  projectPath = '', projectName = '', revisionFor = () => undefined, onSaved,
}) {
  let token = 0;
  let draft = null;
  let fetchError = '';
  const my = ++token;

  openModal((card, close) => {
    card.classList.add('mcp-form-modal');
    let disposed = false;
    const isCurrent = () => !disposed && my === token;

    const renderLoading = (message) => {
      card.replaceChildren();
      const head = node('div', 'mcp-modal-head');
      const h = node('h3', '', mode === 'edit' ? '编辑 MCP 服务器' : '新增 MCP 服务器');
      head.appendChild(h);
      card.appendChild(head);
      const body = node('div', 'mcp-modal-body');
      const state = node('div', 'mcp-modal-loading', message);
      state.setAttribute('role', 'status');
      body.appendChild(state);
      card.appendChild(body);
    };

    const renderFailure = (message) => {
      card.replaceChildren();
      const head = node('div', 'mcp-modal-head');
      head.appendChild(node('h3', '', '无法打开编辑表单'));
      card.appendChild(head);
      const body = node('div', 'mcp-modal-body');
      body.appendChild(node('p', 'mcp-form-error', message));
      card.appendChild(body);
      const foot = node('footer', 'mcp-modal-foot');
      const acts = node('div', 'mcp-modal-foot-actions');
      const closeBtn = button('btn', '关闭');
      closeBtn.onclick = close;
      acts.appendChild(closeBtn);
      foot.appendChild(acts);
      card.appendChild(foot);
    };

    const bootstrap = async () => {
      if (mode === 'edit' && !detail) {
        renderLoading('正在读取配置详情…');
        const d = await fetchMcpConfigDetail(server.scope, server.name);
        if (!isCurrent()) return;
        if (!d || d.ok !== true) { fetchError = errorText(d); renderFailure(fetchError); return; }
        detail = d;
      }
      if (!isCurrent()) return;
      draft = mode === 'edit' ? draftFromDetail(detail, server) : emptyDraft(defaultScope);
      if (mode === 'add' && draft.scope === 'project' && (trust !== true || !projectPath)) {
        draft.scope = 'user';
      }
      renderForm();
    };

    const renderForm = (focusField = '') => {
      if (!isCurrent() || !draft) return;
      card.replaceChildren();
      const head = node('div', 'mcp-modal-head');
      const titleWrap = node('div', 'mcp-modal-title');
      titleWrap.appendChild(node('h3', '', mode === 'edit' ? '编辑 MCP 服务器' : '新增 MCP 服务器'));
      titleWrap.appendChild(node('p', 'mcp-modal-subtitle',
        mode === 'edit'
          ? '保存会原子写入 Pi 的 mcp.json，并在写入前保留备份。敏感值不会回填到界面。'
          : '保存只代表配置写入；连接是否成功仍需测试，运行中的会话还需要重载。'));
      head.appendChild(titleWrap);
      const x = iconButton('close', '关闭', '关闭');
      x.onclick = close;
      head.appendChild(x);
      card.appendChild(head);

      const body = node('div', 'mcp-modal-body');
      const saveError = node('div', 'mcp-form-error');
      saveError.setAttribute('role', 'alert');
      saveError.hidden = true;

      const refreshError = () => { saveError.hidden = true; saveError.textContent = ''; };

      if (draft.overrideOnly) {
        body.appendChild(renderOverrideSection());
      } else {
        body.appendChild(renderBasics(refreshError));
        body.appendChild(draft.transport === 'stdio' ? renderStdioSection() : renderHttpSection());
        body.appendChild(renderAdvanced());
      }
      card.appendChild(body);

      const foot = node('footer', 'mcp-modal-foot');
      foot.appendChild(saveError);
      const actions = node('div', 'mcp-modal-foot-actions');
      const cancel = button('btn', '取消');
      cancel.onclick = close;
      const save = button('btn primary', mode === 'edit' ? '保存修改' : '保存配置');
      save.dataset.field = 'save';
      save.onclick = async () => {
        refreshError();
        const built = buildSavePayload(draft, revisionFor(draft.scope));
        if (!built.ok) {
          clearAndFocusError(card, built.error, built.field ? `[data-field="${built.field}"]` : '');
          return;
        }
        save.disabled = true;
        const old = save.textContent;
        save.textContent = '正在保存…';
        let result = await mcpConfigAction(built.payload);
        if (!isCurrent()) return;
        /* 只有服务端明确说“可以覆盖”（canReplace）或“需要确认跨 scope
         * 覆盖”（canOverride）时才弹确认。重命名撞到已有名字也返回
         * name-conflict，但服务端不会允许覆盖，重试 allowReplace 只会
         * 再次失败，不能把用户带进确认循环。 */
        const canReplace = result && result.ok !== true && result.canReplace === true;
        const canOverride = result && result.ok !== true && result.canOverride === true;
        if (canReplace || canOverride) {
          save.disabled = false;
          save.textContent = old;
          const go = await confirmModal({
            title: canOverride ? '项目条目会覆盖全局同名配置' : '同名配置已存在',
            message: canOverride
              ? `用户级已有 “${draft.name}”。项目级完整条目会覆盖它（包括凭据来源）。确认继续？`
              : `“${draft.name}” 已经存在：${result.error || ''}。确认后会用当前表单覆盖它。`,
            okText: canOverride ? '确认覆盖' : '覆盖保存',
            danger: true,
          });
          if (!go || !isCurrent()) return;
          save.disabled = true;
          save.textContent = '正在保存…';
          result = await mcpConfigAction({
            ...built.payload,
            allowReplace: true,
            confirmOverride: canOverride,
          });
          if (!isCurrent()) return;
        }
        if (!result || result.ok !== true) {
          save.disabled = false;
          save.textContent = old;
          let message = errorText(result);
          if (result && result.code === 'stale-config') {
            message += ' 关闭表单并刷新后，重新打开编辑即可看到最新内容。';
          }
          clearAndFocusError(card, message);
          return;
        }
        close();
        toast('配置已保存（尚未验证连接）', 'info');
        onSaved?.(result);
      };
      actions.appendChild(cancel);
      actions.appendChild(save);
      foot.appendChild(actions);
      card.appendChild(foot);

      if (focusField) card.querySelector(`[data-field="${focusField}"]`)?.focus();
    };

    const renderOverrideSection = () => {
      const sec = formSection('项目覆盖');
      sec.appendChild(node('p', 'mcp-form-note',
        '这是项目级覆盖条目：只保存“启用 / 停用”与可选的 exposure 覆盖，transport、命令、URL 与凭据都继承全局配置。为避免意外复制凭据，名称与范围不可改。'));
      const name = textInput({ value: draft.name, field: 'name', ariaLabel: '服务器名称' });
      name.disabled = true;
      sec.appendChild(labeledField('名称 / 标识符', name));
      const enabledRow = node('div', 'mcp-toggle-row');
      const text = node('div', 'mcp-toggle-copy');
      text.appendChild(node('span', 'mcp-field-label', '启用'));
      text.appendChild(node('span', 'mcp-field-hint',
        `${scopeLabel(draft.scope)} · ${projectName || projectPath || '当前项目'}`));
      const sw = makeSwitch(draft.enabled, '启用这个项目覆盖');
      sw.onclick = () => {
        draft.enabled = !draft.enabled;
        sw.classList.toggle('is-on', draft.enabled);
        sw.setAttribute('aria-checked', String(draft.enabled));
      };
      enabledRow.append(text, sw);
      sec.appendChild(enabledRow);
      const exposure = exposureSelect(draft.exposure, (value) => { draft.exposure = value; }, { inherit: true });
      sec.appendChild(labeledField('工具暴露方式（exposure）', exposure,
        '留空表示继承全局配置；选择具体值会在这个项目里覆盖全局 exposure。'));
      if (draft.inherited) {
        const box = node('div', 'mcp-inherit-box');
        box.appendChild(node('div', 'mcp-inherit-title', '继承自全局配置'));
        const bits = [];
        bits.push(draft.inherited.transport === 'http' ? 'HTTP' : 'stdio');
        if (draft.inherited.command) bits.push(draft.inherited.command);
        if (draft.inherited.argsProtected) bits.push(`${draft.inherited.argsCount ?? 0} 个参数（敏感值未回填）`);
        else if (draft.inherited.args?.length) bits.push(`${draft.inherited.args.length} 个参数`);
        if (draft.inherited.urlPreview) bits.push(draft.inherited.urlPreview);
        if (draft.inherited.description) bits.push(draft.inherited.description);
        box.appendChild(node('p', 'mcp-inherit-text', bits.join(' · ')));
        sec.appendChild(box);
      }
      return sec;
    };

    const renderBasics = (refreshError) => {
      const sec = formSection('基础信息');
      const name = textInput({ value: draft.name, field: 'name', ariaLabel: '服务器名称', placeholder: '例如 github、memory' });
      name.oninput = () => { draft.name = name.value; refreshError(); };
      /* Pi 的 mcp.json 只有 server key 一个命名字段，没有独立的显示名；
       * 这个值同时是配置键与工具名前缀。明确写出来，避免用户以为下面
       * 还应该有一个不会生效的“显示名称”。 */
      sec.appendChild(labeledField('名称 / 标识符', name,
        mode === 'edit'
          ? '这个名称同时是 Pi 的配置键；改名会删除旧名字对应的条目，运行中的 Agent 会话需要重载。'
          : '同时作为 Pi 配置键和工具名前缀；只允许字母、数字、_ 和 -。'));

      const scope = node('select', 'mcp-input ds-input mcp-select');
      scope.dataset.field = 'scope';
      const optUser = node('option', '', '全局（所有项目可用）');
      optUser.value = 'user';
      const optProject = node('option', '', `项目（${projectName || projectPath || '当前项目'}）`);
      optProject.value = 'project';
      if (mode === 'edit' || !projectPath || trust !== true) optProject.disabled = true;
      scope.append(optUser, optProject);
      scope.value = draft.scope;
      scope.disabled = mode === 'edit';
      scope.onchange = () => { draft.scope = scope.value === 'project' ? 'project' : 'user'; };
      const scopeHint = mode === 'edit'
        ? `编辑时不能切换范围：当前条目属于${scopeLabel(draft.scope)}级 mcp.json。`
        : (trust !== true
          ? '当前项目未信任，项目级写入已禁用（Pi 不会加载未信任项目的配置）。'
          : '项目级配置只对当前项目生效，受项目信任状态约束。');
      sec.appendChild(labeledField('保存范围', scope, scopeHint));

      const description = textInput({ value: draft.description, field: 'description', ariaLabel: '描述', placeholder: '一句话说明它提供什么能力（可选）' });
      description.maxLength = 200;
      description.oninput = () => { draft.description = description.value; };
      sec.appendChild(labeledField('描述（可选）', description, '最多 200 个字符；会显示在服务器列表里。'));

      if (mode === 'add') {
        const seg = node('div', 'mcp-seg');
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', '传输类型');
        for (const [value, label] of [['stdio', '本地命令（stdio）'], ['http', 'HTTP 端点']]) {
          const b = button('mcp-seg-btn' + (draft.transport === value ? ' on' : ''), label);
          b.setAttribute('aria-pressed', String(draft.transport === value));
          b.onclick = () => {
            if (draft.transport === value) return;
            draft.transport = value;
            renderForm(value === 'http' ? 'url' : 'command-custom');
          };
          seg.appendChild(b);
        }
        sec.appendChild(labeledField('传输类型', seg));
      } else {
        const ro = node('div', 'mcp-readonly-value', draft.transport === 'http' ? 'HTTP 端点' : '本地命令（stdio）');
        sec.appendChild(labeledField('传输类型', ro, '编辑时不能切换传输类型；需要换类型请新建一条再删除旧的。'));
      }
      return sec;
    };

    const renderStdioSection = () => {
      const sec = formSection('启动命令');
      const choice = node('select', 'mcp-input ds-input mcp-select');
      choice.dataset.field = 'command-choice';
      for (const [value, label] of [['npx', 'npx（Node 包）'], ['uvx', 'uvx（Python 包）'], ['custom', '自定义可执行文件']]) {
        const o = node('option', '', label);
        o.value = value;
        choice.appendChild(o);
      }
      choice.value = draft.commandChoice;
      choice.onchange = () => {
        draft.commandChoice = choice.value;
        draft.command = choice.value === 'custom' ? '' : choice.value;
        renderForm(choice.value === 'custom' ? 'command-custom' : '');
      };
      sec.appendChild(labeledField('命令来源', choice,
        'npx / uvx 会由 Pi 在启动 server 时执行；离线或未安装时会连接失败。'));

      if (draft.commandChoice === 'custom') {
        const command = textInput({ value: draft.command, field: 'command-custom', ariaLabel: '可执行文件', placeholder: '例如 C:\\tools\\my-mcp.exe 或 python' });
        command.oninput = () => { draft.command = command.value; };
        sec.appendChild(labeledField('可执行文件', command, '只填单个可执行文件，不要写 shell 串（如 cmd /c）。'));
      } else {
        const ro = node('div', 'mcp-readonly-value', draft.commandChoice);
        sec.appendChild(labeledField('可执行文件', ro));
      }

      const argsWrap = node('div', 'mcp-field');
      argsWrap.appendChild(node('span', 'mcp-field-label', '参数'));
      if (draft.argsProtected) {
        /* 原参数里疑似有明文凭据，详情接口只回了数量。默认原样保留；
         * 想替换才显式清空重写，避免一次编辑把用户凭据抹掉。 */
        argsWrap.appendChild(node('p', 'mcp-form-note',
          `原有参数含疑似敏感值，未回填到界面（共 ${draft.argsCount ?? '若干'} 项）。保存其他字段时会原样保留。`));
        const rewrite = button('btn tiny', '清空并重写参数');
        rewrite.dataset.field = 'rewrite-args';
        rewrite.onclick = () => {
          draft.argsProtected = false;
          draft.args = [];
          draft.argsCount = 0;
          renderForm('add-arg');
        };
        argsWrap.appendChild(rewrite);
        sec.appendChild(argsWrap);
        sec.appendChild(renderSettingsEditor('env'));
        return sec;
      }
      const list = node('div', 'mcp-rows');
      draft.args.forEach((arg, index) => {
        const row = node('div', 'mcp-row');
        const input = textInput({ value: arg, field: `args-${index}`, ariaLabel: `参数 ${index + 1}` });
        input.oninput = () => { draft.args[index] = input.value; };
        const remove = iconButton('close', `删除参数 ${index + 1}`, '删除这个参数');
        remove.onclick = () => {
          draft.args.splice(index, 1);
          renderForm(index > 0 ? `args-${index - 1}` : 'add-arg');
        };
        row.append(input, remove);
        list.appendChild(row);
      });
      if (!draft.args.length) list.appendChild(node('p', 'mcp-field-hint', '还没有参数。例如 npx 通常需要 -y 和包名两个参数。'));
      argsWrap.appendChild(list);
      const add = button('btn tiny mcp-add-row', '+ 添加参数');
      add.dataset.field = 'add-arg';
      add.onclick = () => { draft.args.push(''); renderForm(`args-${draft.args.length - 1}`); };
      argsWrap.appendChild(add);
      sec.appendChild(argsWrap);
      sec.appendChild(renderSettingsEditor('env'));
      return sec;
    };

    const renderHttpSection = () => {
      const sec = formSection('端点');
      const url = textInput({ value: draft.url, field: 'url', ariaLabel: '服务器 URL', placeholder: 'https://example.com/mcp' });
      url.inputMode = 'url';
      url.oninput = () => { draft.url = url.value; };
      sec.appendChild(labeledField('服务器 URL', url,
        draft.urlProtected
          ? '原 URL 含凭据参数，未回填；留空表示保留原地址，填写新地址则替换。凭据请改用请求头引用。'
          : '支持 http / https。URL 内不能带用户名、密码或凭据查询参数。'));
      if (draft.oauth || draft.auth) {
        const note = node('div', 'mcp-form-note');
        note.textContent = draft.oauth || draft.auth
          ? '这条配置已有 OAuth / auth 设置。编辑会原样保留它们；授权由 Pi 的登录流程接管。'
          : '';
        sec.appendChild(note);
      }
      sec.appendChild(renderSettingsEditor('headers'));
      return sec;
    };

    const renderSettingsEditor = (kind) => {
      const isHeader = kind === 'headers';
      const rows = isHeader ? draft.headers : draft.env;
      const label = isHeader ? '请求头' : '环境变量';
      const prefix = isHeader ? 'header' : 'env';
      const wrap = node('div', 'mcp-field mcp-settings-editor');
      wrap.appendChild(node('span', 'mcp-field-label', label));
      wrap.appendChild(node('span', 'mcp-field-hint',
        '凭据类键或值必须写成 ${环境变量名} 引用（Authorization 可写 “Bearer ${TOKEN}”）。普通字面值可以直接填写；已有明文值只会显示“已设置”，留空即保留。'));
      const list = node('div', 'mcp-rows');
      rows.forEach((row, index) => {
        const line = node('div', 'mcp-row mcp-setting-row');
        const key = textInput({ value: row.key, field: `${prefix}-key-${index}`, ariaLabel: `${label} ${index + 1} 名称`, placeholder: isHeader ? 'Authorization' : 'API_TOKEN' });
        key.oninput = () => {
          if (row.originalKey !== undefined && key.value !== row.originalKey && row.keep === true) row.keep = false;
          row.key = key.value;
        };
        const value = textInput({ value: row.keep ? '' : row.value, field: `${prefix}-value-${index}`, ariaLabel: `${label} ${index + 1} 值`, placeholder: row.keep ? '已设置（留空则保留）' : (isHeader ? 'Bearer ${TOKEN}' : '${TOKEN}') });
        value.oninput = () => {
          row.value = value.value;
          if (value.value !== '') row.keep = false;
          else if (row.sensitive === true) row.keep = true;
        };
        const remove = iconButton('close', `删除${label} ${index + 1}`, `删除这个${label}`);
        remove.onclick = () => { rows.splice(index, 1); renderForm(`add-${prefix}`); };
        line.append(key, value, remove);
        list.appendChild(line);
      });
      if (!rows.length) list.appendChild(node('p', 'mcp-field-hint', isHeader ? '没有请求头。' : '没有环境变量。'));
      wrap.appendChild(list);
      const add = button('btn tiny mcp-add-row', `+ 添加${label}`);
      add.dataset.field = `add-${prefix}`;
      add.onclick = () => {
        rows.push({ key: '', value: '', keep: false, sensitive: false, originalKey: '' });
        renderForm(`${prefix}-key-${rows.length - 1}`);
      };
      wrap.appendChild(add);
      return wrap;
    };

    const renderAdvanced = () => {
      const sec = formSection('高级');
      const exposure = exposureSelect(draft.exposure, (value) => { draft.exposure = value; });
      sec.appendChild(labeledField('工具暴露方式（exposure）', exposure,
        'Pi 默认 codemode；direct 会把工具直接暴露给 Agent，hidden 会隐藏。保存后需要 /reload 或重启 Pi 才会应用到运行中的会话。'));

      const timeout = textInput({ value: String(draft.timeout ?? ''), field: 'timeout', ariaLabel: '超时秒数', type: 'number', placeholder: '留空使用 Pi 默认值' });
      timeout.min = '1'; timeout.max = '3600';
      timeout.oninput = () => { draft.timeout = timeout.value; };
      sec.appendChild(labeledField('连接超时（秒）', timeout, '可留空。范围 1–3600。'));

      const enabledRow = node('div', 'mcp-toggle-row');
      const copy = node('div', 'mcp-toggle-copy');
      copy.appendChild(node('span', 'mcp-field-label', '保存后启用'));
      copy.appendChild(node('span', 'mcp-field-hint', '停用只改配置，不会删除命令与凭据引用。'));
      const sw = makeSwitch(draft.enabled, '保存后启用');
      sw.onclick = () => {
        draft.enabled = !draft.enabled;
        sw.classList.toggle('is-on', draft.enabled);
        sw.setAttribute('aria-checked', String(draft.enabled));
      };
      enabledRow.append(copy, sw);
      sec.appendChild(enabledRow);
      return sec;
    };

    bootstrap();
  }, () => { token++; });
}

/* ---------- 导入其他工具 ---------- */

function openImportModal({
  revisions, revisionsKnown, trust, projectPath, projectName, defaultScope = 'user', onImported,
}) {
  let disposed = false;
  openModal((card, close) => {
    card.classList.add('mcp-scan-modal');
    let scan = null;
    let selected = new Set();
    let allowReplace = false;
    let busy = false;
    let error = '';
    let names = new Map();
    let scope = defaultScope === 'project' && trust === true && projectPath ? 'project' : 'user';

    const render = (focusField = '') => {
      card.replaceChildren();
      const head = node('div', 'mcp-modal-head');
      const tw = node('div', 'mcp-modal-title');
      tw.appendChild(node('h3', '', '从其他工具扫描 MCP 配置'));
      tw.appendChild(node('p', 'mcp-modal-subtitle', '只读扫描 Claude Desktop、Cursor 与 VS Code 的配置文件。不会修改来源工具，也不会显示任何明文凭据。'));
      head.appendChild(tw);
      const x = iconButton('close', '关闭', '关闭');
      x.onclick = close;
      head.appendChild(x);
      card.appendChild(head);
      const body = node('div', 'mcp-modal-body');

      if (!scan) {
        const loading = node('div', 'mcp-modal-loading', '正在扫描本机工具配置…');
        loading.setAttribute('role', 'status');
        body.appendChild(loading);
      } else if (scan.ok !== true) {
        body.appendChild(node('p', 'mcp-form-error', errorText(scan)));
        const retry = button('btn', '重新扫描');
        retry.onclick = load;
        body.appendChild(retry);
      } else if (!scan.detected) {
        const empty = node('div', 'mcp-empty mcp-empty-compact');
        empty.appendChild(icon('scan', 'mcp-empty-icon'));
        empty.appendChild(node('h4', '', '没有检测到可扫描的工具'));
        empty.appendChild(node('p', '', '支持 Claude Desktop、Cursor 与 VS Code 的用户级 / 项目级 MCP 配置。装好并至少配置一台 server 后，再回来扫描。'));
        body.appendChild(empty);
      } else {
        const toolRow = node('div', 'mcp-scan-tools');
        for (const tool of scan.tools) {
          const chip = node('span', 'mcp-scan-tool' + (tool.detected ? ' is-detected' : ''));
          chip.appendChild(icon(tool.detected ? 'check' : 'info', 'mcp-icon-xs'));
          chip.appendChild(node('span', '', tool.name));
          const count = tool.detected ? `${tool.readable ? tool.count : '无法解析'} 条` : '未检测到';
          chip.appendChild(node('span', 'mcp-scan-tool-count', count));
          chip.title = tool.path || '';
          toolRow.appendChild(chip);
        }
        body.appendChild(toolRow);
        if (scan.detected && !scan.entries.length) {
          body.appendChild(node('p', 'mcp-form-note', '检测到配置文件，但没有可导入的条目。'));
        }

        const bySource = new Map();
        for (const entry of scan.entries) {
          if (!bySource.has(entry.sourceLabel)) bySource.set(entry.sourceLabel, []);
          bySource.get(entry.sourceLabel).push(entry);
        }
        for (const [sourceLabel, entries] of bySource) {
          const group = node('section', 'mcp-form-section');
          const h = node('h4', 'mcp-form-section-title', sourceLabel);
          group.appendChild(h);
          for (const entry of entries) {
            group.appendChild(renderEntry(entry));
          }
          body.appendChild(group);
        }

        const scopeField = node('div', 'mcp-form-section');
        scopeField.appendChild(node('h4', 'mcp-form-section-title', '写入到'));
        const select = node('select', 'mcp-input ds-input mcp-select');
        select.dataset.field = 'import-scope';
        const optUser = node('option', '', '全局 mcp.json');
        optUser.value = 'user';
        const optProject = node('option', '', `项目 mcp.json（${projectName || projectPath || '当前项目'}）`);
        optProject.value = 'project';
        if (trust !== true || !projectPath) optProject.disabled = true;
        select.append(optUser, optProject);
        select.value = scope;
        select.onchange = () => {
          if (busy) { select.value = scope; return; }
          scope = select.value === 'project' ? 'project' : 'user'; render();
        };
        scopeField.appendChild(labeledField('保存范围', select, trust !== true ? '当前项目未信任，只能导入到全局。' : '导入受项目信任状态约束。'));
        const replaceRow = node('label', 'mcp-check-row');
        const replace = node('input');
        replace.type = 'checkbox';
        replace.checked = allowReplace;
        replace.onchange = () => { allowReplace = replace.checked; };
        replaceRow.append(replace, node('span', '', '允许覆盖已存在的同名配置（会先写备份）'));
        scopeField.appendChild(replaceRow);
        body.appendChild(scopeField);
      }
      card.appendChild(body);

      const foot = node('footer', 'mcp-modal-foot');
      const err = node('div', 'mcp-form-error');
      err.hidden = !error;
      err.textContent = error;
      err.setAttribute('role', 'alert');
      foot.appendChild(err);
      const acts = node('div', 'mcp-modal-foot-actions');
      const cancel = button('btn', '取消');
      cancel.onclick = close;
      const rescan = button('btn', '重新扫描');
      rescan.disabled = busy;
      rescan.onclick = () => { error = ''; load(); };
      acts.append(cancel, rescan);
      if (scan && scan.ok === true && scan.entries.length) {
        const apply = button('btn primary', busy ? '正在导入…' : `导入所选（${selected.size}）`);
        apply.disabled = busy || selected.size === 0;
        apply.dataset.field = 'import-apply';
        apply.onclick = doApply;
        acts.appendChild(apply);
      }
      foot.appendChild(acts);
      card.appendChild(foot);
      if (focusField) card.querySelector(`[data-field="${focusField}"]`)?.focus();
    };

    const diffText = (row) => {
      if (row.field === 'env' || row.field === 'headers') {
        const parts = [];
        if (row.added?.length) parts.push(`新增 ${row.added.join('、')}`);
        if (row.removed?.length) parts.push(`移除 ${row.removed.join('、')}`);
        return parts.join('；') || '无变化';
      }
      return `${row.from} → ${row.to}`;
    };
    const renderConflictDiff = (conflict) => {
      const diff = Array.isArray(conflict.diff) ? conflict.diff : [];
      const box = node('div', 'mcp-scan-diff');
      box.appendChild(node('div', 'mcp-scan-diff-head',
        `与已存在的${scopeLabel(conflict.scope)}配置比较`));
      if (!diff.length) {
        box.appendChild(node('p', 'mcp-scan-diff-empty', '结构上没有可显示的差异；导入仍会覆盖原条目。'));
      } else {
        for (const row of diff) {
          const line = node('div', 'mcp-scan-diff-row' + (row.warn ? ' is-warn' : ''));
          line.appendChild(node('span', 'mcp-scan-diff-field', ({
            transport: '传输类型', args: '参数个数', env: '环境变量', headers: '请求头',
            enabled: '启用状态', auth: '授权配置', exposure: '可见性', entry: '条目类型',
          })[row.field] || row.field));
          line.appendChild(node('span', 'mcp-scan-diff-value', diffText(row)));
          box.appendChild(line);
        }
      }
      return box;
    };

    const renderEntry = (entry) => {
      const box = node('div', 'mcp-scan-entry' + (entry.status === 'blocked' ? ' is-blocked' : ''));
      const top = node('div', 'mcp-scan-entry-top');
      const check = node('input');
      check.type = 'checkbox';
      check.disabled = entry.status !== 'importable';
      check.checked = selected.has(entry.id);
      check.setAttribute('aria-label', `选择 ${entry.name}`);
      check.onchange = () => {
        if (check.checked) selected.add(entry.id); else selected.delete(entry.id);
        render();
      };
      top.appendChild(check);
      const nameWrap = node('div', 'mcp-scan-entry-name');
      nameWrap.appendChild(node('span', 'mcp-scan-name', entry.name));
      nameWrap.appendChild(badge(entry.transport === 'http' ? 'HTTP' : entry.transport === 'stdio' ? 'stdio' : '未知'));
      if (entry.status === 'blocked') nameWrap.appendChild(badge('不可导入', 'err'));
      for (const c of entry.conflicts || []) {
        nameWrap.appendChild(badge(
          c.kind === 'existing' ? `已存在 · ${scopeLabel(c.scope)}` : `同次扫描重复 · ${c.source}`,
          'warn',
        ));
      }
      top.appendChild(nameWrap);
      box.appendChild(top);

      if (entry.status === 'blocked') {
        box.appendChild(node('p', 'mcp-scan-reason', entry.reason || '来源条目不符合安全导入条件'));
      } else {
        const params = node('div', 'mcp-scan-params');
        params.appendChild(node('code', 'mcp-code-inline', entry.commandSummary || entry.urlPreview || '（无摘要）'));
        if (entry.argsCount) params.appendChild(node('span', 'mcp-scan-extra', `${entry.argsCount} 个参数`));
        if (entry.envKeys?.length) params.appendChild(node('span', 'mcp-scan-extra', `env: ${entry.envKeys.join(', ')}`));
        if (entry.headerKeys?.length) params.appendChild(node('span', 'mcp-scan-extra', `headers: ${entry.headerKeys.join(', ')}`));
        box.appendChild(params);
        for (const conflict of entry.conflicts || []) {
          if (conflict.kind === 'existing') box.appendChild(renderConflictDiff(conflict));
        }
        if ((entry.conflicts || []).length) {
          const nameField = textInput({
            value: names.get(entry.id) ?? entry.name,
            field: `scan-name-${entry.id}`,
            ariaLabel: `导入名称 ${entry.name}`,
            placeholder: entry.name,
          });
          nameField.oninput = () => names.set(entry.id, nameField.value);
          box.appendChild(labeledField('导入为', nameField, '同名条目需要改名，或勾选下方“允许覆盖”。'));
        }
      }
      return box;
    };

    const load = async () => {
      if (busy) return;
      busy = true; error = ''; scan = null; selected.clear(); render();
      const result = await fetchMcpImport();
      busy = false;
      if (disposed) return;
      scan = result;
      if (result && result.ok === true) {
        for (const entry of result.entries) if (entry.status === 'importable') selected.add(entry.id);
        for (const entry of result.entries) names.set(entry.id, entry.name);
      }
      render();
    };

    const doApply = async () => {
      if (busy) return;
      error = '';
      const entries = scan.entries.filter((e) => selected.has(e.id));
      if (!entries.length) { error = '请至少选择一条可导入的配置。'; render(); return; }
      const finals = new Map();
      const used = new Set();
      for (const entry of entries) {
        const name = String(names.get(entry.id) ?? entry.name).trim();
        if (!MCP_NAME_RE.test(name)) { error = `“${name || entry.name}” 不是合法的 server 名（字母、数字、_、-，最多 64 字符）。`; render(); return; }
        if (used.has(name)) { error = `导入列表里有重复的名字 “${name}”，请先重命名其中一个。`; render(); return; }
        used.add(name);
        finals.set(entry.id, name);
      }
      const rename = {};
      for (const entry of entries) {
        const finalName = finals.get(entry.id);
        if (finalName !== entry.name) rename[entry.id] = finalName;
      }
      busy = true; render();
      const payload = {
        action: 'apply',
        scope,
        ids: entries.map((e) => e.id),
        rename,
        allowReplace,
      };
      if (revisionsKnown) payload.expectedRevision = revisions[scope];
      let result = await mcpImportApply(payload);
      if (disposed) return;
      if (result && result.ok !== true && result.code === 'name-conflict' && !allowReplace) {
        busy = false; render();
        const go = await confirmModal({
          title: '目标配置里已有同名条目',
          message: `${result.error || ''}\n确认后会覆盖同名配置（写入前会保留备份）。`,
          okText: '覆盖并导入',
          danger: true,
        });
        if (!go || disposed) return;
        busy = true; render();
        result = await mcpImportApply({ ...payload, allowReplace: true });
        if (disposed) return;
      }
      if (result && result.ok !== true && result.code === 'scope-conflict') {
        busy = false; render();
        const go = await confirmModal({
          title: '项目条目会覆盖全局配置',
          message: `${result.error || ''}\n确认后继续导入。`,
          okText: '确认覆盖',
          danger: true,
        });
        if (!go || disposed) return;
        busy = true; render();
        result = await mcpImportApply({ ...payload, allowReplace: true, confirmOverride: true });
        if (disposed) return;
      }
      busy = false;
      if (!result || result.ok !== true) {
        error = errorText(result);
        render();
        return;
      }
      close();
      toast(`已导入 ${result.imported?.length || entries.length} 条配置（尚未验证连接）`, 'info');
      onImported?.(result);
    };

    load();
  }, () => { disposed = true; });
}

/* ---------- 入口 ---------- */

export function openMcpSettings({ present } = {}) {
  if (typeof present !== 'function') return null;
  let activePage = null;

  const build = (card) => {
    card.classList.add('mcp-page');
    activePage = createPage(card, { reopen, present });
  };
  /* settings surface 在“关闭到设置总览”或“被下一个页面替换”时都会调到这里。
   * 页面必须停止所有异步写入，否则迟到的 list 响应会写进已经清空的卡片。 */
  const onClose = () => {
    const page = activePage;
    activePage = null;
    try { page?.dispose(); } catch { /* 清理隔离 */ }
  };
  const reopen = () => present(build, onClose, {});
  return present(build, onClose, {});
}

function createPage(card, { reopen, present }) {
  const state = {
    loading: true,
    error: '',
    data: null,
    revisions: { user: '', project: '' },
    revisionsKnown: false,
    projects: [],
    projectPath: '',
    projectName: '',
    projectData: null,
    filter: 'all',
    query: '',
    switching: false,
    reloadNotice: '',
    runtimeError: '',
    nativeErrors: [],
    busyKeys: new Set(),
    statusNote: '',
  };
  let disposed = false;
  let loadToken = 0;
  const onDisposeHandlers = [];

  projectWorkSurface('settings', { navigation: 'navMcp', title: 'MCP 服务器' });
  const onDispose = (fn) => onDisposeHandlers.push(fn);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    loadToken++;
    for (const fn of onDisposeHandlers) { try { fn(); } catch { /* 清理隔离 */ } }
  };
  /* presentDetail 在“关闭到设置总览”与“被下一个页面替换”时都会调用 onClose。
   * 两种情况下本页都不应再写 DOM。 */
  const markDisposed = () => dispose();

  const currentServers = () => (state.data && Array.isArray(state.data.servers) ? state.data.servers : []);
  const trust = () => {
    const t = state.data?.trust;
    return t && typeof t === 'object' ? (t.trusted === true ? true : t.trusted === false ? false : null) : null;
  };
  const revisionFor = (scope) => (state.revisionsKnown ? state.revisions[scope] : undefined);

  async function load({ silent = false } = {}) {
    const my = ++loadToken;
    if (!silent) { state.loading = true; state.error = ''; render(); }
    state.runtimeError = '';
    const [serversResult, configResult, projectsResult] = await Promise.all([
      fetchMcpServers().catch((err) => ({ ok: false, network: true, error: String(err?.message || err) })),
      fetchMcpConfig().catch(() => null),
      fetchProjects().catch(() => null),
    ]);
    if (disposed || my !== loadToken) return;
    state.loading = false;
    if (!serversResult || serversResult.ok === false) {
      state.error = errorText(serversResult) || '读取 MCP 配置失败';
      render();
      return;
    }
    state.data = serversResult;
    if (configResult && configResult.ok === true && configResult.revisions) {
      state.revisions = {
        user: String(configResult.revisions.user || ''),
        project: String(configResult.revisions.project || ''),
      };
      state.revisionsKnown = true;
    }
    if (projectsResult && projectsResult.ok !== false) {
      state.projects = Array.isArray(projectsResult.items) ? projectsResult.items : [];
      state.projectPath = projectsResult.active || state.projectPath || S.cwd || '';
      const active = state.projects.find((p) => p.path === state.projectPath);
      state.projectName = active?.name || basename(state.projectPath) || '当前项目';
    } else {
      state.projectPath = state.projectPath || S.cwd || '';
      state.projectName = basename(state.projectPath) || '当前项目';
    }
    const runtime = state.data.runtime;
    if (runtime && runtime.ok === false) state.runtimeError = runtime.error || '运行时状态刷新失败';
    render();
  }

  function basename(p) {
    if (!p) return '';
    const parts = String(p).split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || '';
  }

  function filteredServers() {
    const q = state.query.trim().toLowerCase();
    return currentServers().filter((s) => {
      if (!q) return true;
      return [s.name, s.description]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
    });
  }

  function captureFocus() {
    const active = document.activeElement;
    if (!active || !card.contains(active)) return { key: null, searchFocused: false, selection: null };
    return {
      key: active.dataset?.focusKey || null,
      searchFocused: active.id === 'mcpServerSearch',
      selection: typeof active.selectionStart === 'number' ? active.selectionStart : null,
    };
  }

  function restoreFocus(focus, advancedFocus = '') {
    if (focus.searchFocused) {
      const input = card.querySelector('#mcpServerSearch');
      if (input) {
        input.focus();
        if (focus.selection !== null) {
          try { input.setSelectionRange(focus.selection, focus.selection); } catch { /* ignore */ }
        }
      }
      return;
    }
    const key = advancedFocus || focus.key;
    if (key) card.querySelector(`[data-focus-key="${key}"]`)?.focus();
  }

  function render({ advancedFocus = '' } = {}) {
    if (disposed) return;
    const focus = captureFocus();
    card.replaceChildren();
    const page = node('div', 'mcp-page-inner');
    card.appendChild(page);
    page.appendChild(renderHeader());
    if (state.loading) {
      page.appendChild(renderLoading());
      return;
    }
    if (state.error) {
      page.appendChild(renderError());
      return;
    }
    page.appendChild(renderBanners());
    page.appendChild(renderToolbar());
    const groups = renderGroups();
    page.appendChild(groups);
    if (!groups.childElementCount) page.appendChild(renderEmpty());
    restoreFocus(focus, advancedFocus);
  }

  function renderHeader() {
    const head = node('header', 'mcp-page-head');
    const copy = node('div', 'mcp-page-head-copy');
    copy.appendChild(node('h3', 'settings-page-title', 'MCP 服务器'));
    copy.appendChild(node('p', 'settings-page-desc',
      '管理 Pi 原生的全局与项目级 MCP 配置。列表状态来自配置文件和 pi mcp list 的真实结果；保存配置不等于已经连接。'));
    head.appendChild(copy);
    const actions = node('div', 'mcp-page-actions');

    const refresh = button('btn mcp-btn-ghost', '');
    refresh.dataset.focusKey = 'refresh';
    refresh.appendChild(icon('refresh', 'mcp-icon'));
    refresh.appendChild(node('span', '', '刷新状态'));
    refresh.title = '运行 pi mcp list --json（会启动已启用的 stdio server）';
    refresh.disabled = state.loading || Boolean(state.error);
    refresh.onclick = refreshRuntime;
    actions.appendChild(refresh);

    const market = button('btn mcp-btn-ghost', '');
    market.dataset.focusKey = 'market';
    market.appendChild(icon('market', 'mcp-icon'));
    market.appendChild(node('span', '', '市场'));
    market.onclick = openMarket;
    actions.appendChild(market);

    const add = button('btn primary mcp-btn-primary', '');
    add.dataset.focusKey = 'add';
    add.appendChild(icon('plus', 'mcp-icon'));
    add.appendChild(node('span', '', '新增'));
    add.onclick = () => openForm('add', null, null, state.filter === 'project' ? 'project' : 'user');
    actions.appendChild(add);

    head.appendChild(actions);
    return head;
  }

  function renderLoading() {
    const box = node('div', 'mcp-loading');
    box.setAttribute('role', 'status');
    for (let i = 0; i < 3; i++) {
      const row = node('div', 'mcp-skeleton-row');
      row.appendChild(node('span', 'mcp-skeleton mcp-skeleton-icon'));
      const lines = node('div', 'mcp-skeleton-lines');
      lines.appendChild(node('span', 'mcp-skeleton mcp-skeleton-line'));
      lines.appendChild(node('span', 'mcp-skeleton mcp-skeleton-line short'));
      row.appendChild(lines);
      box.appendChild(row);
    }
    box.appendChild(node('span', 'mcp-loading-text', '正在读取 MCP 配置…'));
    return box;
  }

  function renderError() {
    const box = node('div', 'mcp-empty is-error');
    box.appendChild(icon('warning', 'mcp-empty-icon'));
    box.appendChild(node('h4', '', '读取 MCP 配置失败'));
    const detail = node('p', '', state.error);
    detail.setAttribute('role', 'alert');
    box.appendChild(detail);
    const retry = button('btn primary', '重试');
    retry.onclick = () => load();
    box.appendChild(retry);
    return box;
  }

  function renderBanners() {
    const wrap = node('div', 'mcp-banners');
    const add = (tone, text, actions = []) => {
      const banner = node('div', `mcp-banner is-${tone}`);
      banner.appendChild(icon(tone === 'err' ? 'warning' : tone === 'warn' ? 'warning' : 'info', 'mcp-icon'));
      const copy = node('div', 'mcp-banner-copy');
      copy.appendChild(node('span', '', text));
      banner.appendChild(copy);
      if (actions.length) {
        const acts = node('div', 'mcp-banner-actions');
        for (const a of actions) acts.appendChild(a);
        banner.appendChild(acts);
      }
      wrap.appendChild(banner);
    };
    if (state.reloadNotice) {
      const restart = button('btn tiny', '重启 Pi…');
      restart.onclick = () => document.getElementById('navRestartPi')?.click();
      add('info', state.reloadNotice, [restart]);
    }
    if (state.runtimeError) add('warn', `运行时状态刷新失败：${state.runtimeError}`);
    if (state.statusNote) add('info', state.statusNote);
    const native = state.data?.native;
    if (native && native.state && native.state !== 'active' && native.state !== 'unknown') {
      const labels = {
        replaced: '内置 MCP 被扩展接管，Pi 的 /mcp 不再由原生实现提供。',
        disabled: '内置 MCP 在 Pi 设置里被停用。',
        unsupported: '当前安装的 pi 不带原生 MCP，配置可能不会生效。',
      };
      add('warn', labels[native.state] || `Pi 原生 MCP 状态：${native.state}`);
    }
    const tr = state.data?.trust;
    if (tr && tr.trusted !== true) {
      const text = tr.trusted === false
        ? '当前项目未被信任：Pi 不会读取项目级 .pi/mcp.json，项目条目不会生效，项目级写入也会被拒绝。用户级配置不受影响。'
        : '读不到当前项目的信任状态：按“未确证”处理，项目条目不会标记为生效，项目级写入会被拒绝。';
      add('warn', text);
    }
    const invalid = Array.isArray(state.data?.configInvalid) ? state.data.configInvalid : [];
    if (invalid.length) {
      add('warn', `有 ${invalid.length} 条配置未通过 Pi 的校验（不会加载）：${invalid.slice(0, 3).join('；')}`);
    }
    const cfgErr = state.data?.configError;
    if (cfgErr && (cfgErr.user || cfgErr.project)) {
      add('err', `配置文件读不出来（按空处理，且 GUI 不会覆盖它）：${[cfgErr.user, cfgErr.project].filter(Boolean).join(' / ')}`);
    }
    return wrap;
  }

  function renderToolbar() {
    const bar = node('div', 'mcp-toolbar');
    const seg = node('div', 'mcp-filter');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', '按范围筛选');
    const counts = { all: currentServers().length, user: 0, project: 0 };
    for (const s of currentServers()) {
      if (s.scope === 'project') counts.project++;
      else counts.user++;
    }
    for (const [value, label, count] of [['all', '全部', counts.all], ['user', '全局', counts.user], ['project', '项目', counts.project]]) {
      const b = button('mcp-filter-btn' + (state.filter === value ? ' on' : ''), '');
      b.dataset.focusKey = `filter:${value}`;
      b.setAttribute('aria-pressed', String(state.filter === value));
      b.appendChild(node('span', '', label));
      b.appendChild(node('span', 'mcp-filter-count', String(count)));
      b.onclick = () => { state.filter = value; render(); };
      seg.appendChild(b);
    }
    bar.appendChild(seg);

    const search = node('label', 'mcp-search ds-search-field ds-search-control');
    search.appendChild(icon('search', 'mcp-icon'));
    const input = node('input', 'mcp-search-input');
    input.id = 'mcpServerSearch';
    input.type = 'search';
    input.placeholder = '搜索服务器…';
    input.setAttribute('aria-label', '搜索服务器');
    input.value = state.query;
    input.oninput = () => { state.query = input.value; render(); };
    search.appendChild(input);
    bar.appendChild(search);

    bar.appendChild(node('span', 'mcp-toolbar-spacer'));

    const projectLabel = node('label', 'mcp-project-picker');
    projectLabel.appendChild(node('span', 'mcp-project-picker-label', '项目'));
    const select = node('select', 'mcp-input ds-input mcp-select mcp-project-select');
    select.setAttribute('aria-label', '切换当前项目');
    if (state.switching) select.disabled = true;
    const current = state.projectPath || '';
    if (!state.projects.length) {
      const o = node('option', '', state.projectName || '未选择项目');
      o.value = current;
      select.appendChild(o);
      select.disabled = true;
    } else {
      for (const p of state.projects) {
        const o = node('option', '', p.name || basename(p.path) || p.path);
        o.value = p.path;
        if (p.path === current) o.selected = true;
        select.appendChild(o);
      }
    }
    select.title = current || '';
    select.onchange = () => switchProject(select.value);
    projectLabel.appendChild(select);
    bar.appendChild(projectLabel);

    const scan = button('btn mcp-btn-ghost', '');
    scan.dataset.focusKey = 'scan';
    scan.appendChild(icon('scan', 'mcp-icon'));
    scan.appendChild(node('span', '', '从其他工具扫描'));
    scan.onclick = openScan;
    bar.appendChild(scan);
    return bar;
  }

  function renderGroups() {
    const wrap = node('div', 'mcp-groups');
    const servers = filteredServers();
    const scopes = state.filter === 'all' ? ['user', 'project'] : [state.filter];
    for (const scope of scopes) {
      const all = currentServers().filter((s) => (scope === 'project' ? s.scope === 'project' : s.scope !== 'project'));
      const rows = servers.filter((s) => (scope === 'project' ? s.scope === 'project' : s.scope !== 'project'));
      if (state.filter === 'all' && all.length === 0) {
        // 全局组即使为空也显示（新增入口在组头）；项目组没有配置时不抢空间。
        if (scope === 'project') continue;
      }
      wrap.appendChild(renderGroup(scope, all, rows));
    }
    return wrap;
  }

  function renderGroup(scope, all, rows) {
    const group = node('section', `mcp-group is-${scope}`);
    const head = node('div', 'mcp-group-head');
    const iconWrap = node('span', `mcp-group-icon is-${scope}`);
    iconWrap.appendChild(icon(scope === 'project' ? 'folder' : 'globe', 'mcp-icon'));
    head.appendChild(iconWrap);
    const copy = node('div', 'mcp-group-copy');
    const title = node('div', 'mcp-group-title');
    title.appendChild(node('h4', '', scope === 'project' ? '项目服务器' : '全局服务器'));
    title.appendChild(node('span', 'mcp-group-count', String(all.length)));
    if (scope === 'project' && trust() !== true) title.appendChild(badge(trust() === false ? '项目未信任' : '信任未知', 'warn'));
    copy.appendChild(title);
    const shownPath = serverFilenamePath(state.data, scope);
    copy.appendChild(node('p', 'mcp-group-path', shownPath || '（配置文件尚未创建）'));
    if (scope === 'project' && state.projectName) {
      copy.appendChild(node('p', 'mcp-group-project', state.projectName));
    }
    head.appendChild(copy);
    const headActs = node('div', 'mcp-group-actions');
    if (rows.length !== all.length) headActs.appendChild(node('span', 'mcp-group-filtered', `${rows.length} / ${all.length}`));
    if (scope === 'user' || (state.projectPath && trust() === true)) {
      const add = button('btn tiny mcp-group-add', '');
      add.dataset.focusKey = `add:${scope}`;
      add.appendChild(icon('plus', 'mcp-icon-xs'));
      add.appendChild(node('span', '', '新增'));
      add.onclick = () => openForm('add', null, null, scope);
      headActs.appendChild(add);
    }
    head.appendChild(headActs);
    group.appendChild(head);

    const list = node('div', 'mcp-server-list');
    if (!all.length) {
      const empty = node('div', 'mcp-group-empty');
      if (scope === 'project' && trust() !== true) {
        empty.appendChild(node('p', '', '项目级 mcp.json 里还没有条目；当前项目未信任，项目配置不会生效，写入也会被拒绝。'));
      } else {
        empty.appendChild(node('p', '', scope === 'project' ? '项目级 mcp.json 里还没有条目。' : '全局 mcp.json 里还没有条目。'));
        const add = button('btn', scope === 'project' ? '新增项目服务器' : '新增全局服务器');
        add.onclick = () => openForm('add', null, null, scope);
        empty.appendChild(add);
      }
      list.appendChild(empty);
    } else if (!rows.length) {
      list.appendChild(node('p', 'mcp-group-empty-text', '没有匹配搜索的服务器。'));
    } else {
      for (const server of rows) list.appendChild(renderServer(server));
    }
    group.appendChild(list);
    return group;
  }

  function renderServer(server) {
    const runtime = state.data?.runtime || null;
    const status = serverStatus(server, runtime, { trust: trust() });
    const row = node('article', 'mcp-server');
    row.dataset.name = server.name;
    row.dataset.scope = server.scope;

    const lead = node('div', 'mcp-server-lead');
    const tile = node('div', 'mcp-server-tile');
    tile.appendChild(icon(server.transportType === 'http' ? 'globe' : 'terminal', 'mcp-icon'));
    lead.appendChild(tile);
    lead.appendChild(statusDot(status.tone));
    row.appendChild(lead);

    const body = node('div', 'mcp-server-body');
    const titleRow = node('div', 'mcp-server-title-row');
    const nameBtn = button('mcp-server-name', server.name, { label: `查看 ${server.name} 的详情`, title: '查看详情' });
    nameBtn.dataset.focusKey = `detail:${server.scope}:${server.name}`;
    nameBtn.onclick = () => openDetail(server);
    titleRow.appendChild(nameBtn);
    titleRow.appendChild(badge(transportLabel(server)));
    if (server.overrideOnly) titleRow.appendChild(badge('项目覆盖', 'info'));
    if (server.hasSecrets) titleRow.appendChild(badge('含凭据引用', 'dim'));
    if (server.scope === 'user' && server.overridden) titleRow.appendChild(badge('被项目覆盖', 'warn'));
    if (server.effective && server.effective.active === false && server.enabled !== false && server.scope !== 'project') {
      // effective 的其它原因已在状态区说明，这里不重复堆徽标。
    }
    body.appendChild(titleRow);
    body.appendChild(node('p', 'mcp-server-desc' + (server.description ? '' : ' is-muted'),
      server.description || (server.overrideOnly ? '项目覆盖条目：transport 与凭据继承全局配置。' : '未填写描述。')));
    const meta = node('div', 'mcp-server-meta');
    if (server.overrideOnly) {
      meta.appendChild(node('span', 'mcp-server-meta-item', server.inheritedFrom ? `继承自 ${scopeLabel(server.inheritedFrom)}` : '继承全局'));
    } else if (server.transportType === 'http') {
      meta.appendChild(node('span', 'mcp-server-meta-item', 'HTTP 端点'));
    } else if (server.argsCount) {
      meta.appendChild(node('span', 'mcp-server-meta-item', `${server.argsCount} 个参数`));
    }
    const statusText = node('span', `mcp-server-status-text ${statusToneClass(status.tone)}`,
      status.detail ? `${status.label} · ${status.detail}` : status.label);
    meta.appendChild(statusText);
    body.appendChild(meta);
    row.appendChild(body);

    const ops = node('div', 'mcp-server-ops');
    const statusPill = node('span', `mcp-status-pill ${statusToneClass(status.tone)}`);
    statusPill.appendChild(statusDot(status.tone));
    statusPill.appendChild(node('span', '', status.label));
    statusPill.title = status.detail || '';
    ops.appendChild(statusPill);

    const canWriteProject = server.scope !== 'project' || trust() === true;
    const sw = makeSwitch(server.enabled !== false, `启用 ${server.name}`,
      { disabled: !canWriteProject || state.busyKeys.has(`toggle:${server.scope}:${server.name}`),
        title: canWriteProject ? '启用 / 停用（写入 Pi 的 mcp.json）' : '项目未信任，不能写项目配置' });
    sw.dataset.focusKey = `toggle:${server.scope}:${server.name}`;
    sw.onclick = async () => {
      if (sw.disabled) return;
      const next = !(server.enabled !== false);
      const key = `toggle:${server.scope}:${server.name}`;
      state.busyKeys.add(key);
      sw.disabled = true;
      const result = await mcpConfigAction({
        action: 'set-enabled', scope: server.scope, name: server.name, enabled: next,
        ...(revisionFor(server.scope) !== undefined ? { expectedRevision: revisionFor(server.scope) } : {}),
      });
      if (disposed) return;
      state.busyKeys.delete(key);
      if (!result || result.ok !== true) {
        toast(errorText(result), 'error');
        render();
        return;
      }
      state.reloadNotice = `${server.name} 已${next ? '启用' : '停用'}。运行中的 Agent 会话需要 /reload 或重启 Pi 后才会应用。`;
      toast(next ? '已启用（尚未验证连接）' : '已停用', 'info');
      await load({ silent: true });
    };
    ops.appendChild(sw);

    if (status.state === 'needs-auth') {
      const auth = button('btn tiny mcp-auth-btn', '');
      auth.dataset.focusKey = `auth:${server.scope}:${server.name}`;
      auth.appendChild(icon('key', 'mcp-icon-xs'));
      auth.appendChild(node('span', '', '授权'));
      auth.onclick = () => openAuth(server);
      ops.appendChild(auth);
    }

    const test = iconButton('test', `测试 ${server.name} 连接`, '测试连接（运行 pi mcp list --json）');
    test.dataset.focusKey = `test:${server.scope}:${server.name}`;
    test.disabled = state.busyKeys.has(`test:${server.scope}:${server.name}`);
    test.onclick = async () => {
      const key = `test:${server.scope}:${server.name}`;
      state.busyKeys.add(key);
      test.disabled = true;
      test.classList.add('is-busy');
      statusText.textContent = '正在测试连接…';
      const result = await mcpConfigAction({ action: 'test', name: server.name, scope: server.scope });
      if (disposed) return;
      state.busyKeys.delete(key);
      if (result && result.revisions) {
        state.revisions = {
          user: String(result.revisions.user || ''),
          project: String(result.revisions.project || ''),
        };
        state.revisionsKnown = true;
      }
      if (!result) {
        toast('测试连接失败：没有响应', 'error');
        await load({ silent: true });
        return;
      }
      if (result.connected === true) {
        const tools = result.server && typeof result.server.tools === 'number' ? `，${result.server.tools} 个工具` : '';
        toast(`已连接${tools}。Agent 会话仍需 /reload 或重启后加载配置。`, 'info');
        state.statusNote = '连接来自独立的 pi mcp list；运行中的 Agent 会话是否已加载仍需重载确认。';
      } else if (result.code === 'needs-auth') {
        toast('这台 server 需要 OAuth 授权。请点“授权”完成 Pi 登录。', 'warn');
      } else if (result.connected === null || result.connected === undefined) {
        toast(`无法确认连接状态：${errorText(result)}`, 'warn');
        state.statusNote = 'pi mcp list 没有返回结果，连接状态未知；这不是“连接失败”。';
      } else {
        toast(`未连接：${errorText(result)}`, 'error');
      }
      await load({ silent: true });
    };
    ops.appendChild(test);

    const edit = iconButton('edit', `编辑 ${server.name}`, '编辑配置');
    edit.dataset.focusKey = `edit:${server.scope}:${server.name}`;
    edit.onclick = () => openForm('edit', server);
    ops.appendChild(edit);

    const remove = iconButton('trash', `删除 ${server.name}`, '删除配置', 'mcp-icon-btn is-danger');
    remove.dataset.focusKey = `delete:${server.scope}:${server.name}`;
    remove.onclick = () => removeServer(server);
    ops.appendChild(remove);
    row.appendChild(ops);
    return row;
  }

  function renderEmpty() {
    const box = node('div', 'mcp-empty');
    box.appendChild(icon('server', 'mcp-empty-icon'));
    box.appendChild(node('h4', '', '还没有配置 MCP 服务器'));
    box.appendChild(node('p', '', 'MCP 让 Agent 连接外部工具与数据源。你可以手动新增一台，或从市场安装经过整理的服务器。'));
    const acts = node('div', 'mcp-empty-actions');
    const add = button('btn primary', '新增服务器');
    add.onclick = () => openForm('add', null, null, 'user');
    const market = button('btn', '浏览市场');
    market.onclick = openMarket;
    const scan = button('btn', '从其他工具扫描');
    scan.onclick = openScan;
    acts.append(add, market, scan);
    box.appendChild(acts);
    return box;
  }

  /* ---------- 动作 ---------- */

  async function refreshRuntime() {
    const btn = card.querySelector('[data-focus-key="refresh"]');
    if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
    const result = await refreshMcpStatus();
    if (disposed) return;
    if (!result || result.ok !== true) {
      toast(`刷新失败：${errorText(result)}`, 'error');
    } else {
      toast('运行时状态已刷新', 'info');
      if (result.note) state.statusNote = String(result.note).slice(0, 300);
    }
    await load({ silent: true });
  }

  function openMarket() {
    openMcpMarket({
      // 市场页复用同一个设置入口：左侧仍停在 MCP，返回时重新挂载管理页。
      present,
      onBack: () => reopen(),
      projectPath: state.projectPath,
      projectName: state.projectName,
      trust: trust(),
      /* 市场安装继承用户当前看到的范围筛选；项目未信任时安装弹层会
       * 回退到全局，并把原因写在作用域选择器下方。 */
      defaultScope: state.filter === 'project' ? 'project' : 'user',
      configuredNames: currentServers().map((s) => s.name),
      revisionFor,
      /* 市场页连续安装时，把服务端返回的最新 revision 写回父页面状态，
       * 下一次安装才不会拿旧 revision 触发 stale-config。 */
      onRevisions: (revisions) => {
        if (!revisions || typeof revisions !== 'object') return;
        state.revisions = {
          user: String(revisions.user || ''),
          project: String(revisions.project || ''),
        };
        state.revisionsKnown = true;
      },
    });
  }

  function openScan() {
    openImportModal({
      revisions: state.revisions,
      revisionsKnown: state.revisionsKnown,
      trust: trust(),
      projectPath: state.projectPath,
      projectName: state.projectName,
      defaultScope: state.filter === 'project' ? 'project' : 'user',
      onImported: async (result) => {
        state.reloadNotice = `已导入 ${result.imported?.length || 0} 条配置。它们尚未测试连接；运行中的 Agent 会话需要 /reload 或重启 Pi 后才会加载。`;
        await load({ silent: true });
      },
    });
  }

  function openForm(mode, server, detail = null, defaultScope = 'user') {
    openServerForm({
      mode, server, detail, defaultScope, trust: trust(),
      projectPath: state.projectPath, projectName: state.projectName,
      revisionFor,
      onSaved: async (result) => {
        const target = serverFilenamePath(state.data, result.scope || (server ? server.scope : defaultScope));
        state.reloadNotice = `配置已保存到 ${target || 'mcp.json'}。它还没有做连接测试；运行中的 Agent 会话需要 /reload 或重启 Pi 后才会加载。`;
        await load({ silent: true });
      },
    });
  }

  async function openDetail(server) {
    let disposedModal = false;
    openModal((modal, close) => {
      modal.classList.add('mcp-detail-modal');
      modal.replaceChildren();
      const head = node('div', 'mcp-modal-head');
      const tw = node('div', 'mcp-modal-title');
      tw.appendChild(node('h3', '', server.name));
      tw.appendChild(node('p', 'mcp-modal-subtitle', `${scopeLabel(server.scope)} · ${transportLabel(server)} · ${serverFilenamePath(state.data, server.scope)}`));
      head.appendChild(tw);
      const x = iconButton('close', '关闭', '关闭');
      x.onclick = close;
      head.appendChild(x);
      modal.appendChild(head);
      const body = node('div', 'mcp-modal-body');
      const loading = node('div', 'mcp-modal-loading', '正在读取配置详情…');
      loading.setAttribute('role', 'status');
      body.appendChild(loading);
      modal.appendChild(body);
      const foot = node('footer', 'mcp-modal-foot');
      const status = node('div', 'mcp-detail-test-status');
      status.setAttribute('role', 'status');
      foot.appendChild(status);
      const acts = node('div', 'mcp-modal-foot-actions');
      const closeBtn = button('btn', '关闭');
      closeBtn.onclick = close;
      acts.appendChild(closeBtn);
      foot.appendChild(acts);
      modal.appendChild(foot);

      const buildDetail = (detail) => {
        if (disposedModal) return;
        body.replaceChildren();
        const runtime = state.data?.runtime;
        const st = serverStatus(server, runtime, { trust: trust() });
        const summary = node('div', 'mcp-detail-status');
        summary.appendChild(statusDot(st.tone));
        const stCopy = node('div', 'mcp-detail-status-copy');
        stCopy.appendChild(node('strong', '', st.label));
        if (st.detail) stCopy.appendChild(node('span', '', st.detail));
        summary.appendChild(stCopy);
        body.appendChild(summary);

        const grid = node('div', 'mcp-detail-grid');
        const addRow = (label, value, mono = false) => {
          const row = node('div', 'mcp-detail-row');
          row.appendChild(node('span', 'mcp-detail-label', label));
          const v = node(mono ? 'code' : 'div', 'mcp-detail-value' + (mono ? ' mcp-code-inline' : ''), value);
          if (mono) v.style.whiteSpace = 'pre-wrap';
          row.appendChild(v);
          grid.appendChild(row);
        };
        addRow('配置范围', scopeLabel(detail.scope));
        addRow('配置文件', serverFilenamePath(state.data, detail.scope) || '—', true);
        addRow('条目类型', detail.overrideOnly ? '项目覆盖（继承全局）' : (detail.entry.type === 'http' ? 'HTTP 端点' : '本地命令（stdio）'));
        addRow('启用', detail.entry.enabled === false ? '否' : '是');
        if (detail.entry.exposure) addRow('exposure', detail.entry.exposure);
        if (detail.entry.description) addRow('描述', detail.entry.description);
        if (detail.entry.timeout !== null && detail.entry.timeout !== undefined) addRow('超时', `${detail.entry.timeout} 秒`);
        if (detail.overrideOnly) {
          const base = detail.entry.inherited;
          if (base) {
            const bits = [base.transport === 'http' ? 'HTTP' : 'stdio'];
            if (base.command) bits.push(base.command);
            if (base.args?.length) bits.push(`${base.args.length} 个参数`);
            if (base.urlPreview) bits.push(base.urlPreview);
            addRow('继承的传输', bits.join(' · '));
            if (base.description) addRow('继承的描述', base.description);
          } else {
            addRow('继承的传输', '全局没有找到同名基础配置');
          }
        } else if (detail.entry.type === 'http') {
          addRow('URL', detail.entry.urlProtected ? '（URL 含凭据参数，不在界面展示）' : (detail.entry.url || detail.entry.urlPreview || '—'), true);
          if (detail.entry.headers?.length) {
            addRow('请求头', detail.entry.headers.map((h) => `${h.key}: ${h.secret ? '已设置（值不显示）' : h.value}`).join('\n'), true);
          }
          addRow('OAuth 配置', detail.entry.oauth ? '已配置（由 Pi 登录流程接管）' : '未配置');
          addRow('auth 配置', detail.entry.auth ? '已配置（值不显示）' : '未配置');
        } else {
          addRow('命令', detail.entry.command || '—', true);
          if (detail.entry.argsProtected) {
            addRow('参数', `${detail.entry.argsCount ?? '若干'} 项（含疑似敏感值，未在界面展示；编辑时原样保留）`, true);
          } else if (detail.entry.args?.length) addRow('参数', detail.entry.args.join('\n'), true);
          if (detail.entry.cwd) addRow('cwd', detail.entry.cwd, true);
          if (detail.entry.env?.length) {
            addRow('环境变量', detail.entry.env.map((e) => `${e.key}=${e.secret ? '已设置（值不显示）' : e.value}`).join('\n'), true);
          }
        }
        if (detail.entry.toolExposure) addRow('单工具 exposure', `${Object.keys(detail.entry.toolExposure).length} 条`);
        body.appendChild(grid);

        if (runtime && Array.isArray(runtime.servers)) {
          const rt = runtimeServerFor(runtime, server.name, server.scope);
          if (rt) {
            const rtBox = node('div', 'mcp-detail-runtime');
            rtBox.appendChild(node('div', 'mcp-detail-label', '上次运行时报告'));
            const bits = [rt.state === 'connected' ? '已连接' : rt.state || '状态未知'];
            if (typeof rt.toolCount === 'number') bits.push(`${rt.toolCount} 个工具`);
            if (typeof rt.resources === 'number') bits.push(`${rt.resources} 个资源`);
            rtBox.appendChild(node('p', '', bits.join(' · ')));
            if (rt.error) rtBox.appendChild(node('pre', 'mcp-code-block', rt.error));
            body.appendChild(rtBox);
          }
        }

        body.appendChild(node('p', 'mcp-form-hint',
          '详情接口只返回键名与 ${VAR} 引用；已有的明文凭据只显示“已设置”，不会进入渲染进程。连接结论来自独立的 pi mcp list；Agent 会话是否已加载仍需 /reload 或重启确认。'));

        const edit = button('btn', '编辑');
        edit.onclick = () => {
          close();
          openForm('edit', server, detail);
        };
        acts.insertBefore(edit, closeBtn);
        const test = button('btn', '测试连接');
        test.onclick = async () => {
          test.disabled = true;
          status.textContent = '正在运行 pi mcp list --json…';
          const result = await mcpConfigAction({ action: 'test', name: server.name, scope: server.scope });
          if (disposedModal) return;
          test.disabled = false;
          if (result && result.revisions) {
            state.revisions = { user: String(result.revisions.user || ''), project: String(result.revisions.project || '') };
            state.revisionsKnown = true;
          }
          if (!result) {
            status.textContent = '测试失败：没有响应。';
            status.dataset.state = 'error';
          } else if (result.connected === true) {
            const tools = result.server && typeof result.server.tools === 'number' ? `，${result.server.tools} 个工具` : '';
            status.textContent = `已连接${tools}。配置已存在，连接已建立；运行中的 Agent 会话仍需重载。`;
            status.dataset.state = 'ok';
          } else if (result.connected === null || result.connected === undefined) {
            status.textContent = `无法确认：${errorText(result)}（连接状态未知，不是失败）`;
            status.dataset.state = 'warn';
          } else {
            status.textContent = `未连接：${errorText(result)}`;
            status.dataset.state = 'error';
          }
          await load({ silent: true });
        };
        acts.insertBefore(test, closeBtn);

        if (server.transportType === 'http' || (detail.entry.type === 'http')) {
          const authBtn = button('btn', 'OAuth 登录 / 退出');
          authBtn.onclick = () => { close(); openAuth(server); };
          acts.insertBefore(authBtn, closeBtn);
        }

        const del = button('btn danger', '删除');
        del.onclick = () => { close(); removeServer(server); };
        acts.insertBefore(del, closeBtn);
      };

      fetchMcpConfigDetail(server.scope, server.name).then((detail) => {
        if (disposedModal) return;
        if (!detail || detail.ok !== true) {
          body.replaceChildren();
          const err = node('div', 'mcp-form-error', errorText(detail));
          err.setAttribute('role', 'alert');
          body.appendChild(err);
          return;
        }
        buildDetail(detail);
      });
    }, () => { disposedModal = true; });
  }

  async function openAuth(server) {
    const rt = runtimeServerFor(state.data?.runtime || null, server.name, server.scope);
    const loggedIn = rt && rt.state !== 'needs-auth';
    const go = await confirmModal({
      title: loggedIn ? `退出 ${server.name} 的登录？` : `通过 Pi 登录 ${server.name}？`,
      message: loggedIn
        ? '会运行 pi mcp logout，删掉 Pi 保存的 OAuth 凭据（配置文件本身不受影响）。'
        : '会运行 pi mcp login。浏览器由 Pi 打开，授权与 token 都由 Pi 接管；Pi GUI 看不到任何凭据。最多等待约 2 分钟。',
      okText: loggedIn ? '退出登录' : '登录',
      danger: Boolean(loggedIn),
    });
    if (!go || disposed) return;
    const result = await mcpServerAction({ action: loggedIn ? 'logout' : 'login', name: server.name });
    if (disposed) return;
    if (!result || result.ok !== true) {
      toast(`授权操作失败：${errorText(result)}`, 'error');
      return;
    }
    toast(loggedIn ? '已退出登录' : '登录完成', 'info');
    state.reloadNotice = loggedIn
      ? 'OAuth 凭据已删除。运行中的 Agent 会话需要重载后才会重新连接。'
      : 'OAuth 登录完成。运行中的 Agent 会话需要 /reload 或重启后才会使用新凭据。';
    await load({ silent: true });
  }

  async function removeServer(server) {
    const scopeText = server.scope === 'project' ? '项目级 mcp.json' : '全局 mcp.json';
    const go = await confirmModal({
      title: `删除 ${server.name}？`,
      message: server.overrideOnly
        ? `会删掉 ${scopeText} 里这条项目覆盖。全局同名配置不会被删除。删除前会保留备份。`
        : `会从 ${scopeText} 里删除这台 server。Pi 保存的 OAuth 凭据不会一起删除（需要的话先“退出登录”）。删除前会保留备份。`,
      okText: '删除',
      danger: true,
    });
    if (!go || disposed) return;
    const result = await mcpConfigAction({
      action: 'delete', scope: server.scope, name: server.name,
      ...(revisionFor(server.scope) !== undefined ? { expectedRevision: revisionFor(server.scope) } : {}),
    });
    if (disposed) return;
    if (!result || result.ok !== true) {
      toast(`删除失败：${errorText(result)}`, 'error');
      if (result && result.code === 'stale-config') await load({ silent: true });
      return;
    }
    state.reloadNotice = `已删除 ${server.name} 的配置。运行中的 Agent 会话需要 /reload 或重启 Pi 后才会移除它。`;
    toast('配置已删除', 'info');
    await load({ silent: true });
  }

  async function switchProject(path) {
    if (!path || path === state.projectPath || state.switching) return;
    const project = state.projects.find((p) => p.path === path);
    state.switching = true;
    render();
    const result = await activateProject(project?.path || path, project?.name || basename(path));
    /* activateProject 会先关掉当前设置页（这是预期的 dispose），所以这里不能
     * 因为 disposed 就提前返回 —— 否则页面永远停在旧项目，切项目下拉形同虚设。
     * 只有用户仍停留在会话视图时才重新打开本页；如果他已经主动退到设置总览，
     * 不把他拽回来。 */
    state.switching = false;
    if (workspaceView() === 'chat') {
      if (result === false) toast('项目切换未完成', 'warn');
      reopen();
    }
  }

  /* 骨架先渲染，数据回来后再整体替换。 */
  render();
  load();
  onDispose(markDisposed);

  return {
    dispose,
    reload: () => load({ silent: true }),
    _state: state,
  };
}

export const mcpSettingsInternals = {
  buildSavePayload,
  settingRowsPayload,
  settingNeedsReference,
  draftFromDetail,
  emptyDraft,
};
