/* MCP 市场页。
 *
 * 数据来源有三类：
 *   - 内置精选：随应用离线可用，服务端只接受 catalogId，命令模板由目录决定；
 *   - 官方 MCP Registry：真实 HTTPS 查询 + cursor 分页，失败时明确报错；
 *   - 第三方市场源：用户添加的 HTTPS JSON 源，服务端校验后才持久化。
 *
 * 安装只发送 source / catalogId / scope / values，**从不发送 command 或 URL**。
 * 安装结果严格区分：配置已保存、连接未验证、运行中的会话尚未加载。
 */
import {
  MCP_NAME_RE, badge, button, icon, node,
} from './mcp-shared.js';
import { projectWorkSurface } from './ui/workspace-surface.js';
import {
  fetchMcpMarket, fetchMcpMarketSources, mcpMarketAction,
} from './api.js';
import { openModal, confirmModal } from './ui/modal.js';
import { toast } from './ui/toast.js';

const DEFAULT_CATEGORIES = ['全部', '开发工具', '网络', '文档', '数据', '效率'];

const TRUST_META = {
  official: { label: '官方', tone: 'ok', title: '来自官方仓库或官方端点' },
  verified: { label: '已验证', tone: 'info', title: '维护方公开、来源可核验' },
  registry: { label: 'Registry 收录', tone: 'dim', title: '官方 MCP Registry 收录；收录不代表安全审核' },
  community: { label: '社区', tone: 'warn', title: '第三方来源；未审核安全性' },
};

function trustMeta(trust) {
  return TRUST_META[trust] || { label: '未知来源', tone: 'dim', title: '没有可信来源标记' };
}

function sourceCount(state) {
  const custom = Array.isArray(state.sources?.custom) ? state.sources.custom.length : 0;
  return 2 + custom;
}

function marketErrorText(result) {
  if (!result) return '请求失败（没有响应）';
  const code = result.code ? `（${result.code}）` : '';
  if (result.code === 'proxy-blocked') return `${result.error || '代理网络无法确认实际连接地址，市场请求已拒绝。'}${code}`;
  if (result.code === 'redirect-blocked') return `${result.error || '市场源返回重定向，已拒绝跟随。'}${code}`;
  if (result.code === 'unsupported') return `${result.error || '这个条目无法安全转换成 Pi 配置。'}${code}`;
  if (result.error) return `${result.error}${code}`;
  if (result.code === 'timeout') return '请求超时。Registry 可能暂时不可达；内置精选仍可离线使用。';
  if (result.code === 'blocked-host' || result.code === 'blocked-url') return '这个地址指向本机或内网，已被拒绝。';
  return `请求失败${code}`;
}

function categoryIcon(category) {
  if (category === '开发工具') return 'terminal';
  if (category === '网络') return 'globe';
  if (category === '文档') return 'list';
  if (category === '数据') return 'box';
  return 'clock';
}

function installState(item, configured) {
  if (!item.installable) return { label: '不可直接安装', disabled: true, installed: false };
  if (configured.has(item.installName)) return { label: '已配置', disabled: true, installed: true };
  return { label: '安装', disabled: false, installed: false };
}

function previewQuote(value) {
  return /^[A-Za-z0-9_@%+=:,.\\/.-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * 只用于界面预览。字段值来自用户输入，模板来自服务端市场条目；这里
 * 不构造也不提交命令，安装时仍由服务端按同一模板重新生成并校验。
 */
function previewText(item, values) {
  const template = item.commandTemplate || item.urlTemplate || '';
  if (!template) return item.commandSummary || item.urlPreview || '';
  const isUrl = Boolean(item.urlTemplate);
  const fields = [
    ...(item.fields || []),
    ...(item.envFields || []),
    ...(item.headerFields || []),
  ];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  return String(template).replace(/\{([A-Za-z0-9_.-]+)\}/g, (whole, key) => {
    const field = byKey.get(key);
    if (!field) return whole;
    const value = String(values[key] ?? '').trim();
    if (!value) return `<${field.label || key}>`;
    if (field.secret) {
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? `\${${value}}` : '***';
    }
    /* 服务端会用 encodeURIComponent 写入 URL 变量；预览也必须一致，
     * 否则确认时看到的地址和实际保存的不是同一个。 */
    return isUrl ? encodeURIComponent(value) : previewQuote(value);
  });
}

function openInstallModal(item, {
  state, trust, projectPath, projectName, revisionFor, defaultScope = 'user',
}) {
  let disposed = false;
  let success = null;
  let error = '';
  let busy = false;
  const values = {};
  const allFields = [
    ...(item.fields || []),
    ...(item.envFields || []),
    ...(item.headerFields || []),
  ];
  for (const field of allFields) {
    if (field.default !== undefined && field.default !== null && field.default !== '') values[field.key] = field.default;
  }
  let nameValue = item.installName || item.name || '';
  let scope = defaultScope === 'project' && trust === true && projectPath ? 'project' : 'user';

  openModal((card, close) => {
    card.classList.add('mcp-install-modal');

    const render = (focusField = '') => {
      if (disposed) return;
      card.replaceChildren();
      const head = node('div', 'mcp-modal-head');
      const tw = node('div', 'mcp-modal-title');
      tw.appendChild(node('h3', '', success ? '配置已写入' : `安装 ${item.name}`));
      tw.appendChild(node('p', 'mcp-modal-subtitle',
        success
          ? '保存、连接、会话加载是三个不同状态。这里完成的是第一项。'
          : `${item.sourceLabel || item.source} · ${trustMeta(item.trust).label}`));
      head.appendChild(tw);
      const x = button('mcp-icon-btn', '', { label: '关闭', title: '关闭' });
      x.appendChild(icon('close', 'mcp-icon'));
      x.onclick = close;
      head.appendChild(x);
      card.appendChild(head);

      const body = node('div', 'mcp-modal-body');
      if (success) body.appendChild(renderSuccess());
      else body.appendChild(renderForm());
      card.appendChild(body);

      const foot = node('footer', 'mcp-modal-foot');
      const err = node('div', 'mcp-form-error');
      err.hidden = !error;
      err.textContent = error;
      err.setAttribute('role', 'alert');
      foot.appendChild(err);
      const acts = node('div', 'mcp-modal-foot-actions');
      if (success) {
        const done = button('btn', '完成');
        done.onclick = close;
        const go = button('btn primary', '去我的服务测试连接');
        go.onclick = () => {
          close();
          state.installedNames.add(nameValue);
          state.onBack?.();
        };
        acts.append(done, go);
      } else {
        const cancel = button('btn', '取消');
        cancel.onclick = close;
        const install = button('btn primary', busy ? '正在安装…' : '安装到配置');
        install.disabled = busy;
        install.dataset.field = 'install-submit';
        install.onclick = doInstall;
        acts.append(cancel, install);
      }
      foot.appendChild(acts);
      card.appendChild(foot);
      if (focusField) card.querySelector(`[data-field="${focusField}"]`)?.focus();
    };

    const renderForm = () => {
      const wrap = node('div', 'mcp-install-form');

      const sourceBox = node('div', 'mcp-install-source');
      const trustInfo = trustMeta(item.trust);
      const trustBadge = badge(trustInfo.label, trustInfo.tone);
      trustBadge.title = item.trustEvidence || trustInfo.title;
      sourceBox.append(trustBadge);
      sourceBox.appendChild(node('span', 'mcp-install-source-name', item.sourceLabel || item.source));
      if (item.version) sourceBox.appendChild(node('span', 'mcp-install-version', `v${item.version}`));
      wrap.appendChild(sourceBox);
      if (item.trustEvidence) {
        wrap.appendChild(node('p', 'mcp-install-evidence', `信任依据：${item.trustEvidence}`));
      }

      const command = item.commandSummary || item.urlPreview || '';
      if (command) {
        const code = node('code', 'mcp-code-block', command);
        wrap.appendChild(code);
      }

      if (item.warning) {
        const warn = node('div', 'mcp-banner is-warn');
        warn.appendChild(icon('warning', 'mcp-icon'));
        warn.appendChild(node('span', '', item.warning));
        wrap.appendChild(warn);
      }

      const refreshPreview = () => {
        const previewEl = card.querySelector('[data-market-preview]');
        if (previewEl) previewEl.textContent = previewText(item, values);
      };

      const controlFor = (f, prefix) => {
        if (Array.isArray(f.choices) && f.choices.length) {
          const select = node('select', 'mcp-input mcp-select');
          select.dataset.field = `${prefix}-${f.key}`;
          const blank = node('option', '', f.required ? '请选择…' : '（不设置）');
          blank.value = '';
          select.appendChild(blank);
          for (const choice of f.choices) {
            const option = node('option', '', choice);
            option.value = choice;
            select.appendChild(option);
          }
          select.value = String(values[f.key] ?? '');
          select.onchange = () => {
            values[f.key] = select.value;
            refreshPreview();
          };
          return select;
        }
        const input = node('input', 'mcp-input');
        input.type = f.type === 'number' ? 'number' : 'text';
        if (f.type === 'path') input.placeholder = f.placeholder || '绝对路径，例如 C:\\projects\\demo';
        else if (f.type === 'url') { input.inputMode = 'url'; input.placeholder = f.placeholder || 'https://…'; }
        else input.placeholder = f.placeholder || '';
        input.value = String(values[f.key] ?? '');
        input.dataset.field = `${prefix}-${f.key}`;
        input.oninput = () => {
          values[f.key] = input.value;
          refreshPreview();
        };
        return input;
      };

      const fields = node('div', 'mcp-install-fields');
      const nameInput = node('input', 'mcp-input');
      nameInput.type = 'text';
      nameInput.value = nameValue;
      nameInput.placeholder = item.installName || 'server-name';
      nameInput.dataset.field = 'install-name';
      nameInput.oninput = () => { nameValue = nameInput.value; };
      const nameField = node('label', 'mcp-field');
      nameField.appendChild(node('span', 'mcp-field-label', '配置中的名称'));
      nameField.appendChild(nameInput);
      nameField.appendChild(node('span', 'mcp-field-hint', '只允许字母、数字、_ 和 -。同名配置已存在时会要求确认覆盖。'));
      fields.appendChild(nameField);

      const appendField = (f, prefix, hint) => {
        const field = node('label', 'mcp-field');
        field.appendChild(node('span', 'mcp-field-label', `${f.label || f.key}${f.required ? '（必填）' : ''}`));
        field.appendChild(controlFor(f, prefix));
        const help = hint || f.help || '';
        if (help) field.appendChild(node('span', 'mcp-field-hint', help));
        fields.appendChild(field);
      };
      for (const f of item.fields || []) appendField(f, 'install-field', f.help || '');
      for (const f of item.envFields || []) {
        appendField(f, 'install-env', f.secret
          ? `填写系统环境变量名；安装后写成 \${环境变量名}，值不会进入配置。${f.help ? ` ${f.help}` : ''}`
          : (f.help || ''));
      }
      for (const f of item.headerFields || []) {
        let hint = f.help || '';
        if (f.secret) hint = `填写系统环境变量名；安装后写成 \${环境变量名}，值不会进入配置。${hint ? ` ${hint}` : ''}`;
        else if (f.literal) hint = hint || '填写这个请求头的字面值；凭据类值必须改用环境变量引用。';
        appendField(f, 'install-header', hint);
      }

      /* 安装确认必须能看见“实际会写进配置的命令 / 端点”。模板来自服务端
       * 目录，输入框变化时只更新预览，不会把客户端拼的命令回传给服务端。 */
      const preview = node('div', 'mcp-install-preview');
      preview.appendChild(node('div', 'mcp-field-label', item.urlTemplate ? '安装后的端点' : '安装后的启动命令'));
      const previewCode = node('code', 'mcp-code-block mcp-install-command');
      previewCode.dataset.marketPreview = '1';
      previewCode.textContent = previewText(item, values);
      preview.appendChild(previewCode);
      preview.appendChild(node('p', 'mcp-field-hint', '这是按当前输入生成的预览；真正的配置仍由服务端用目录模板重新构造。敏感值不会显示。'));
      wrap.appendChild(preview);
      if (Array.isArray(item.requiredEnvKeys) && item.requiredEnvKeys.length) {
        const envBox = node('div', 'mcp-install-envkeys');
        envBox.appendChild(node('div', 'mcp-field-label', '安装后需要存在的环境变量'));
        const chips = node('div', 'mcp-chip-row');
        for (const key of item.requiredEnvKeys) chips.appendChild(node('code', 'mcp-code-inline', `\${${key}}`));
        envBox.appendChild(chips);
        envBox.appendChild(node('p', 'mcp-field-hint', '值由 Pi 在启动 server 时从系统环境变量读取；Pi GUI 不保存这些值。'));
        fields.appendChild(envBox);
      }

      if (Array.isArray(item.requires) && item.requires.length) {
        const dep = node('div', 'mcp-install-deps');
        dep.appendChild(node('div', 'mcp-field-label', '运行依赖'));
        const chips = node('div', 'mcp-chip-row');
        for (const name of item.requires) chips.appendChild(node('span', 'mcp-chip', name));
        dep.appendChild(chips);
        dep.appendChild(node('p', 'mcp-field-hint', '安装时会读取 PATH 检测这些可执行文件；检测不到不代表不能安装，但连接很可能会失败。'));
        fields.appendChild(dep);
      }

      const scopeSelect = node('select', 'mcp-input mcp-select');
      scopeSelect.dataset.field = 'install-scope';
      const optUser = node('option', '', '全局（所有项目可用）');
      optUser.value = 'user';
      const optProject = node('option', '', `当前项目（${projectName || projectPath || '当前项目'}）`);
      optProject.value = 'project';
      if (trust !== true || !projectPath) optProject.disabled = true;
      scopeSelect.append(optUser, optProject);
      scopeSelect.value = scope;
      scopeSelect.onchange = () => {
        if (busy) { scopeSelect.value = scope; return; }
        scope = scopeSelect.value === 'project' ? 'project' : 'user';
      };
      const scopeField = node('label', 'mcp-field');
      scopeField.appendChild(node('span', 'mcp-field-label', '安装到'));
      scopeField.appendChild(scopeSelect);
      scopeField.appendChild(node('span', 'mcp-field-hint',
        trust !== true
          ? `当前项目未信任，项目级安装已禁用${defaultScope === 'project' ? '，本次已回退到全局' : ''}。`
          : '项目级配置只对当前项目生效，并受项目信任状态约束。'));
      fields.appendChild(scopeField);

      wrap.appendChild(fields);

      const security = node('div', 'mcp-banner is-info');
      security.appendChild(icon('lock', 'mcp-icon'));
      security.appendChild(node('span', '',
        '安装只写入 Pi 的 mcp.json，不会在安装时执行命令。首次测试连接或新的 Agent 会话启动时，Pi 才会启动这台 server。'));
      wrap.appendChild(security);

      if (state.configuredNames.has(nameValue) || state.installedNames.has(nameValue)) {
        const exists = node('div', 'mcp-banner is-warn');
        exists.appendChild(icon('warning', 'mcp-icon'));
        exists.appendChild(node('span', '', '同名配置已经存在。继续安装会要求再次确认，并覆盖原配置（写入前保留备份）。'));
        wrap.appendChild(exists);
      }
      return wrap;
    };

    const renderSuccess = () => {
      const wrap = node('div', 'mcp-install-success');
      const banner = node('div', 'mcp-success-head');
      banner.appendChild(icon('check', 'mcp-success-icon'));
      const copy = node('div', '');
      copy.appendChild(node('h4', '', success.name || nameValue));
      copy.appendChild(node('p', '', `${success.scope === 'project' ? '项目级' : '全局'} mcp.json 已写入，原文件已保留备份。`));
      banner.appendChild(copy);
      wrap.appendChild(banner);

      const grid = node('div', 'mcp-detail-grid');
      const row = (label, value, tone = '') => {
        const r = node('div', 'mcp-detail-row');
        r.appendChild(node('span', 'mcp-detail-label', label));
        const v = node('div', 'mcp-detail-value' + (tone ? ` ${tone}` : ''), value);
        r.appendChild(v);
        grid.appendChild(r);
      };
      row('配置', '已保存');
      row('连接', '未测试（保存 ≠ 已连接）', 'is-warn');
      row('Agent 会话', '尚未加载；需要 /reload 或重启 Pi', 'is-warn');
      const deps = Array.isArray(success.dependencyProbe) ? success.dependencyProbe : [];
      if (deps.length) {
        row('依赖检测', deps.map((d) => `${d.name}：${d.found ? '已在 PATH 找到' : '未在 PATH 找到'}`).join('\n'));
      }
      wrap.appendChild(grid);

      const actual = success.commandPreview || success.urlPreview || '';
      if (actual) {
        const preview = node('div', 'mcp-install-preview');
        preview.appendChild(node('div', 'mcp-field-label', '已写入的实际启动命令 / 端点'));
        preview.appendChild(node('code', 'mcp-code-block mcp-install-command', actual));
        wrap.appendChild(preview);
      }

      const missing = deps.filter((d) => !d.found);
      if (missing.length) {
        const warn = node('div', 'mcp-banner is-warn');
        warn.appendChild(icon('warning', 'mcp-icon'));
        warn.appendChild(node('span', '', `没有找到：${missing.map((d) => d.name).join('、')}。请安装后重试连接。`));
        wrap.appendChild(warn);
      }
      const message = node('div', 'mcp-banner is-info');
      message.appendChild(icon('info', 'mcp-icon'));
      message.appendChild(node('span', '', success.message || '配置已保存。它还没有被运行中的 Pi 会话加载，也没有验证连接。'));
      wrap.appendChild(message);
      return wrap;
    };

    const doInstall = async () => {
      if (busy) return;
      error = '';
      const name = String(nameValue || '').trim();
      if (!MCP_NAME_RE.test(name)) {
        error = '名称只能包含字母、数字、下划线和连字符（1–64 字符）。';
        render('install-name');
        return;
      }
      const allFields = [
        ...(item.fields || []).map((f) => ({ f, prefix: 'install-field' })),
        ...(item.envFields || []).map((f) => ({ f, prefix: 'install-env' })),
        ...(item.headerFields || []).map((f) => ({ f, prefix: 'install-header' })),
      ];
      for (const { f, prefix } of allFields) {
        if (f.required && !String(values[f.key] || '').trim()) {
          error = `请填写「${f.label || f.key}」。`;
          render(`${prefix}-${f.key}`);
          return;
        }
      }
      busy = true;
      render();
      const payload = {
        action: 'install',
        source: item.source,
        catalogId: item.catalogId,
        scope,
        name,
        values,
      };
      const rev = revisionFor(scope);
      if (typeof rev === 'string') payload.expectedRevision = rev;
      let result = await mcpMarketAction(payload);
      if (disposed) return;
      /* 以服务端的 canReplace / canOverride 为准：不是所有 name-conflict
       * 都允许覆盖，盲目重试只会把用户困在同一个错误里。 */
      const canReplace = result && result.ok !== true && result.canReplace === true;
      const canOverride = result && result.ok !== true && result.canOverride === true;
      if (canReplace || canOverride) {
        busy = false;
        render();
        const go = await confirmModal({
          title: canOverride ? '项目条目会覆盖全局配置' : '同名配置已存在',
          message: canOverride
            ? `${result.error || ''}\n确认后继续安装，项目条目会覆盖全局同名配置。`
            : `${result.error || ''}\n确认后覆盖原配置；写入前会保留备份。`,
          okText: canOverride ? '确认覆盖' : '覆盖安装',
          danger: true,
        });
        if (!go || disposed) return;
        busy = true;
        render();
        result = await mcpMarketAction({ ...payload, allowReplace: true, confirmOverride: canOverride });
        if (disposed) return;
      }
      busy = false;
      if (!result || result.ok !== true) {
        error = marketErrorText(result);
        render();
        return;
      }
      success = result;
      /* 同一市场页可以连续安装多台 server。服务端每次写入都会返回最新
       * revision；不把它写回父页面，第二次安装仍会用第一次安装前的旧
       * revision，被 stale-config 拒绝。 */
      if (typeof state.onRevisions === 'function' && result.revisions) {
        state.onRevisions(result.revisions);
      }
      state.installedNames.add(name);
      state.configuredNames.add(name);
      state.render?.();
      render();
      toast('配置已写入（尚未验证连接）', 'info');
    };

    render();
  }, () => { disposed = true; });
}

function openSourceManager(state, { onChange } = {}) {
  let disposed = false;
  let busy = false;
  let error = '';
  let success = '';
  let url = '';

  openModal((card, close) => {
    card.classList.add('mcp-sources-modal');
    const render = () => {
      if (disposed) return;
      card.replaceChildren();
      const head = node('div', 'mcp-modal-head');
      const tw = node('div', 'mcp-modal-title');
      tw.appendChild(node('h3', '', '市场来源'));
      tw.appendChild(node('p', 'mcp-modal-subtitle', '内置精选离线可用；官方 Registry 与第三方源通过 HTTPS 实时读取。第三方源里的条目不会在安装前执行。'));
      head.appendChild(tw);
      const x = button('mcp-icon-btn', '', { label: '关闭', title: '关闭' });
      x.appendChild(icon('close', 'mcp-icon'));
      x.onclick = close;
      head.appendChild(x);
      card.appendChild(head);

      const body = node('div', 'mcp-modal-body');
      const list = node('div', 'mcp-source-list');
      const builtin = node('div', 'mcp-source-row');
      builtin.append(icon('server', 'mcp-icon'), node('div', 'mcp-source-copy'), badge('内置', 'ok'));
      builtin.querySelector('.mcp-source-copy').append(
        node('strong', '', '内置精选'),
        node('span', '', `${state.sources?.builtin?.count ?? 10} 条 · 离线可用，命令模板由应用校验`),
      );
      list.appendChild(builtin);
      const registry = node('div', 'mcp-source-row');
      registry.append(icon('globe', 'mcp-icon'), node('div', 'mcp-source-copy'), badge('官方', 'info'));
      registry.querySelector('.mcp-source-copy').append(
        node('strong', '', '官方 MCP Registry'),
        node('span', '', 'registry.modelcontextprotocol.io · 收藏不代表安全审核'),
      );
      list.appendChild(registry);

      for (const source of state.sources?.custom || []) {
        const row = node('div', 'mcp-source-row');
        row.append(icon('list', 'mcp-icon'), node('div', 'mcp-source-copy'));
        const copy = row.querySelector('.mcp-source-copy');
        copy.append(node('strong', '', source.name || source.url), node('span', '', source.url));
        const remove = button('btn tiny danger', '移除');
        remove.disabled = busy;
        remove.onclick = async () => {
          const go = await confirmModal({
            title: `移除市场源“${source.name || source.url}”？`,
            message: '只会移除这个来源，不会移除已经安装的 MCP server 配置。',
            okText: '移除',
            danger: true,
          });
          if (!go || disposed) return;
          busy = true;
          const result = await mcpMarketAction({ action: 'remove-source', id: source.id });
          busy = false;
          if (disposed) return;
          if (!result || result.ok !== true) {
            error = marketErrorText(result);
            render();
            return;
          }
          if (state.source === `custom:${source.id}`) state.source = 'builtin';
          await refreshSources();
          if (disposed) return;
          success = '来源已移除。';
          render();
          onChange?.();
        };
        row.appendChild(remove);
        list.appendChild(row);
      }
      body.appendChild(list);

      const addSection = node('section', 'mcp-form-section');
      addSection.appendChild(node('h4', 'mcp-form-section-title', '添加第三方来源'));
      const input = node('input', 'mcp-input');
      input.type = 'text';
      input.placeholder = 'https://example.com/mcp-market.json';
      input.value = url;
      input.dataset.field = 'source-url';
      input.oninput = () => { url = input.value; };
      const field = node('label', 'mcp-field');
      field.appendChild(node('span', 'mcp-field-label', '来源 URL'));
      field.appendChild(input);
      field.appendChild(node('span', 'mcp-field-hint', '必须使用 HTTPS，且不能指向本机、内网或带凭据的地址。来源会返回 servers 数组，每个条目最多 200 个。'));
      addSection.appendChild(field);
      const add = button('btn primary', busy ? '正在添加…' : '添加来源');
      add.disabled = busy;
      add.dataset.field = 'source-add';
      add.onclick = async () => {
        if (busy) return;
        error = ''; success = '';
        const trimmed = String(url || '').trim();
        if (!/^https:\/\//i.test(trimmed)) { error = '来源 URL 必须使用 HTTPS。'; render('source-url'); return; }
        busy = true; render();
        const result = await mcpMarketAction({ action: 'add-source', url: trimmed });
        busy = false;
        if (disposed) return;
        if (!result || result.ok !== true) {
          error = marketErrorText(result);
          render('source-url');
          return;
        }
        await refreshSources();
        if (disposed) return;
        success = `已添加“${result.source?.name || '第三方来源'}”，共 ${result.count || 0} 条可用条目。`;
        state.source = `custom:${result.source.id}`;
        state.category = '全部';
        state.q = '';
        url = '';
        render();
        onChange?.();
      };
      addSection.appendChild(add);
      body.appendChild(addSection);
      card.appendChild(body);

      const foot = node('footer', 'mcp-modal-foot');
      const status = node('div', 'mcp-form-error');
      status.hidden = !(error || success);
      status.textContent = error || success;
      status.dataset.state = error ? 'error' : 'ok';
      status.setAttribute('role', 'status');
      foot.appendChild(status);
      const acts = node('div', 'mcp-modal-foot-actions');
      const done = button('btn', '完成');
      done.onclick = close;
      acts.appendChild(done);
      foot.appendChild(acts);
      card.appendChild(foot);
    };

    const refreshSources = async () => {
      const sources = await fetchMcpMarketSources();
      if (disposed) return false;
      if (sources && sources.ok === true) {
        state.sources = sources;
        return true;
      }
      error = marketErrorText(sources);
      return false;
    };

    render();
  }, () => { disposed = true; });
}

export function openMcpMarket({
  present, onBack, projectPath = '', projectName = '', trust = null,
  configuredNames = [], revisionFor = () => undefined, onRevisions = null, defaultScope = 'user',
} = {}) {
  if (typeof present !== 'function') return null;
  let active = null;

  const build = (card, close) => {
    card.classList.add('mcp-market-page');
    active = createMarketPage(card, {
      onBack, projectPath, projectName, trust, configuredNames, revisionFor, onRevisions, defaultScope,
      onDispose: () => { active = null; },
    });
  };
  const onClose = () => {
    const page = active;
    active = null;
    try { page?.dispose(); } catch { /* 清理隔离 */ }
  };
  return present(build, onClose, {});
}

function createMarketPage(card, {
  onBack, projectPath, projectName, trust, configuredNames = [], revisionFor = () => undefined,
  onRevisions = null, defaultScope = 'user', onDispose,
}) {
  const state = {
    source: 'builtin',
    q: '',
    category: '全部',
    items: [],
    total: null,
    hasMore: false,
    nextCursor: null,
    loading: true,
    error: null,
    sources: null,
    sourcesError: '',
    configuredNames: new Set(configuredNames),
    installedNames: new Set(),
    onRevisions,
    categories: DEFAULT_CATEGORIES,
    onBack,
    render: null,
  };
  let disposed = false;
  let loadToken = 0;
  let searchTimer = null;
  projectWorkSurface('settings', { navigation: 'navMcp', title: 'MCP 市场' });

  const configured = () => state.configuredNames;

  function dispose() {
    if (disposed) return;
    disposed = true;
    loadToken++;
    if (searchTimer) clearTimeout(searchTimer);
    try { onDispose?.(); } catch { /* ignore */ }
  }

  function captureFocus() {
    const a = document.activeElement;
    if (!a || !card.contains(a)) return null;
    return {
      key: a.dataset?.focusKey || null,
      search: a.id === 'mcpMarketSearch',
      pos: typeof a.selectionStart === 'number' ? a.selectionStart : null,
    };
  }

  function restoreFocus(snapshot) {
    if (!snapshot) return;
    if (snapshot.search) {
      const input = card.querySelector('#mcpMarketSearch');
      if (input) {
        input.focus();
        if (snapshot.pos !== null) { try { input.setSelectionRange(snapshot.pos, snapshot.pos); } catch { /* ignore */ } }
      }
      return;
    }
    if (snapshot.key) card.querySelector(`[data-focus-key="${snapshot.key}"]`)?.focus();
  }

  function render() {
    if (disposed) return;
    state.render = render;
    const focus = captureFocus();
    card.replaceChildren();
    const page = node('div', 'mcp-market-inner');
    card.appendChild(page);
    page.appendChild(renderHeader());
    page.appendChild(renderSourceBar());
    page.appendChild(renderToolbar());
    page.appendChild(renderResults());
    restoreFocus(focus);
  }

  function renderHeader() {
    const head = node('header', 'mcp-market-head');
    const copy = node('div', 'mcp-market-head-copy');
    const back = button('btn mcp-back-btn', '');
    back.dataset.focusKey = 'market-back';
    back.appendChild(icon('chevron', 'mcp-icon mcp-back-chevron'));
    back.appendChild(node('span', '', '我的服务'));
    back.onclick = () => { if (disposed) return; onBack?.(); };
    copy.appendChild(back);
    copy.appendChild(node('h3', 'settings-page-title', 'MCP 市场'));
    copy.appendChild(node('p', 'settings-page-desc',
      '挑选可用的 MCP server，安装到 Pi 原生的 mcp.json。安装只写配置，不会在安装时执行命令；连接需要单独测试，运行中的会话需要重载。'));
    const meta = node('div', 'mcp-market-meta');
    meta.appendChild(icon('market', 'mcp-icon-xs'));
    meta.appendChild(node('span', '', `${sourceCount(state)} 个市场源`));
    meta.appendChild(node('span', 'mcp-market-meta-dot', '·'));
    meta.appendChild(node('span', '', '内置精选可离线使用'));
    copy.appendChild(meta);
    head.appendChild(copy);
    const acts = node('div', 'mcp-market-head-actions');
    const manage = button('btn', '管理来源');
    manage.dataset.focusKey = 'manage-sources';
    manage.onclick = () => {
      openSourceManager(state, {
        onChange: () => { loadSources(); loadListNow(); },
      });
    };
    acts.appendChild(manage);
    head.appendChild(acts);
    return head;
  }

  function renderSourceBar() {
    const bar = node('div', 'mcp-source-bar');
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', '市场来源');
    const addTab = (value, label, count, title = '') => {
      const tab = button('mcp-source-tab' + (state.source === value ? ' on' : ''), '');
      tab.dataset.focusKey = `source:${value}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(state.source === value));
      if (title) tab.title = title;
      tab.appendChild(node('span', '', label));
      if (count !== null && count !== undefined) tab.appendChild(node('span', 'mcp-source-tab-count', String(count)));
      tab.onclick = () => {
        if (state.source === value) return;
        state.source = value;
        state.category = '全部';
        state.q = '';
        loadListNow();
      };
      bar.appendChild(tab);
    };
    addTab('builtin', '精选', state.sources?.builtin?.count ?? 10, '内置离线目录');
    addTab('registry', '官方 Registry', null, 'registry.modelcontextprotocol.io');
    for (const custom of state.sources?.custom || []) {
      addTab(`custom:${custom.id}`, custom.name || '第三方源', null, custom.url);
    }
    if (state.sources?.error) bar.appendChild(node('span', 'mcp-source-error', '来源列表读取失败'));
    return bar;
  }

  function renderToolbar() {
    const bar = node('div', 'mcp-market-toolbar');
    const search = node('label', 'mcp-search');
    search.appendChild(icon('search', 'mcp-icon'));
    const input = node('input', 'mcp-search-input');
    input.id = 'mcpMarketSearch';
    input.type = 'search';
    input.placeholder = '搜索 MCP server…';
    input.setAttribute('aria-label', '搜索 MCP server');
    input.value = state.q;
    input.oninput = () => {
      state.q = input.value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { if (!disposed) loadListNow(); }, 320);
    };
    search.appendChild(input);
    bar.appendChild(search);
    bar.appendChild(node('span', 'mcp-toolbar-spacer'));
    if (state.total !== null) {
      bar.appendChild(node('span', 'mcp-market-total', `共 ${state.total} 个结果`));
    }
    return bar;
  }

  function renderCategories() {
    const row = node('div', 'mcp-category-row');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', '按分类筛选');
    for (const category of state.categories) {
      const b = button('mcp-category' + (state.category === category ? ' on' : ''), category);
      b.dataset.focusKey = `category:${category}`;
      b.setAttribute('aria-pressed', String(state.category === category));
      b.onclick = () => {
        if (state.category === category) return;
        state.category = category;
        loadListNow();
      };
      row.appendChild(b);
    }
    return row;
  }

  function renderResults() {
    const wrap = node('div', 'mcp-market-results');
    wrap.appendChild(renderCategories());
    if (state.loading) {
      const grid = node('div', 'mcp-market-grid');
      for (let i = 0; i < 4; i++) {
        const sk = node('div', 'mcp-market-card is-skeleton');
        sk.appendChild(node('span', 'mcp-skeleton mcp-skeleton-icon'));
        sk.appendChild(node('span', 'mcp-skeleton mcp-skeleton-line'));
        sk.appendChild(node('span', 'mcp-skeleton mcp-skeleton-line short'));
        grid.appendChild(sk);
      }
      wrap.appendChild(grid);
      return wrap;
    }
    if (state.error) {
      const box = node('div', 'mcp-empty');
      box.appendChild(icon('warning', 'mcp-empty-icon'));
      box.appendChild(node('h4', '', '这个市场源暂时不可用'));
      box.appendChild(node('p', '', marketErrorText(state.error)));
      const acts = node('div', 'mcp-empty-actions');
      if (state.source !== 'builtin') {
        const fallback = button('btn primary', '切到内置精选');
        fallback.onclick = () => {
          state.source = 'builtin';
          state.q = '';
          state.category = '全部';
          loadListNow();
        };
        acts.appendChild(fallback);
      }
      const retry = button('btn', '重试');
      retry.onclick = () => loadListNow();
      acts.appendChild(retry);
      box.appendChild(acts);
      wrap.appendChild(box);
      return wrap;
    }
    if (!state.items.length) {
      const box = node('div', 'mcp-empty');
      box.appendChild(icon('search', 'mcp-empty-icon'));
      box.appendChild(node('h4', '', '没有匹配的服务器'));
      box.appendChild(node('p', '', state.q ? `没有找到包含“${state.q}”的条目。` : '这个分类下还没有条目。'));
      const reset = button('btn', '清除筛选');
      reset.onclick = () => { state.q = ''; state.category = '全部'; loadListNow(); };
      box.appendChild(reset);
      wrap.appendChild(box);
      return wrap;
    }
    const grid = node('div', 'mcp-market-grid');
    for (const item of state.items) grid.appendChild(renderCard(item));
    wrap.appendChild(grid);
    if (state.hasMore) {
      const more = button('btn primary mcp-load-more', '加载更多');
      more.dataset.focusKey = 'load-more';
      more.onclick = () => loadList({ reset: false });
      wrap.appendChild(more);
    } else {
      wrap.appendChild(node('p', 'mcp-market-end', '已经到底了'));
    }
    return wrap;
  }

  function renderCard(item) {
    const cardEl = node('article', 'mcp-market-card');
    /* 不能叫 trust：会遮蔽页面级的项目信任布尔值，安装弹层就会永远
     * 把项目级安装当成“未信任”并禁用。 */
    const trustInfo = trustMeta(item.trust);
    const install = installState(item, configured());
    const head = node('div', 'mcp-market-card-head');
    const iconBox = node('div', 'mcp-market-icon');
    iconBox.appendChild(icon(categoryIcon(item.category), 'mcp-icon'));
    head.appendChild(iconBox);
    const title = node('div', 'mcp-market-card-title');
    const titleLine = node('div', 'mcp-market-title-line');
    titleLine.appendChild(node('h4', '', item.name));
    const trustBadge = badge(trustInfo.label, trustInfo.tone);
    trustBadge.title = item.trustEvidence || trustInfo.title;
    titleLine.appendChild(trustBadge);
    title.appendChild(titleLine);
    const sub = node('div', 'mcp-market-card-sub');
    sub.appendChild(node('span', 'mcp-market-category', item.category || '未分类'));
    if (item.version) sub.appendChild(node('span', 'mcp-market-version', `v${item.version}`));
    if (configured().has(item.installName)) sub.appendChild(badge('已配置', 'info'));
    title.appendChild(sub);
    head.appendChild(title);
    cardEl.appendChild(head);

    cardEl.appendChild(node('p', 'mcp-market-desc', item.description || '没有描述。'));

    if (item.commandSummary || item.urlPreview) {
      const code = node('code', 'mcp-code-block mcp-market-code', item.commandSummary || item.urlPreview);
      cardEl.appendChild(code);
    }

    const chips = node('div', 'mcp-chip-row');
    for (const dep of item.requires || []) chips.appendChild(node('span', 'mcp-chip', dep));
    if (Array.isArray(item.requiredEnvKeys)) {
      for (const key of item.requiredEnvKeys) chips.appendChild(node('span', 'mcp-chip mcp-chip-env', `$${key}`));
    }
    if (chips.childElementCount) cardEl.appendChild(chips);

    const foot = node('div', 'mcp-market-card-foot');
    const evidence = node('span', 'mcp-trust-evidence', item.trustEvidence || trustInfo.title);
    evidence.title = item.trustEvidence || trustInfo.title;
    foot.appendChild(evidence);

    if (item.homepage && /^https:\/\//.test(item.homepage)) {
      const home = node('a', 'mcp-market-link', '来源');
      home.href = item.homepage;
      home.target = '_blank';
      home.rel = 'noopener noreferrer';
      home.title = item.homepage;
      home.onclick = (event) => event.stopPropagation();
      foot.appendChild(home);
    }

    const action = button('btn' + (install.disabled ? '' : ' primary') + ' mcp-market-install', '');
    action.dataset.focusKey = `install:${item.catalogId}`;
    action.appendChild(node('span', '', install.label));
    action.disabled = install.disabled || state.loading;
    if (item.installable === false) {
      action.title = item.installReason || '这个条目没有可直接安装的模板';
    } else if (install.installed) {
      action.title = '配置里已经有同名 server；在“我的服务”里查看或编辑';
    }
    action.onclick = () => openInstallModal(item, {
      state, trust, projectPath, projectName, revisionFor, defaultScope,
    });
    foot.appendChild(action);
    cardEl.appendChild(foot);
    return cardEl;
  }

  async function loadSources() {
    const result = await fetchMcpMarketSources();
    if (disposed) return;
    if (result && result.ok === true) {
      state.sources = result;
      state.sourcesError = '';
    } else {
      state.sourcesError = marketErrorText(result);
    }
    render();
  }

  function loadListNow() {
    if (searchTimer) clearTimeout(searchTimer);
    return loadList({ reset: true });
  }

  async function loadList({ reset = false } = {}) {
    const my = ++loadToken;
    if (reset) {
      state.items = [];
      state.total = null;
      state.hasMore = false;
      state.nextCursor = null;
    }
    state.loading = true;
    state.error = null;
    render();
    const params = {
      source: state.source,
      q: state.q,
      category: state.category,
      limit: 12,
    };
    if (!reset && state.source === 'registry' && state.nextCursor) params.cursor = state.nextCursor;
    else if (!reset) params.offset = state.items.length;
    const result = await fetchMcpMarket(params);
    if (disposed || my !== loadToken) return;
    state.loading = false;
    if (!result || result.ok !== true) {
      state.error = result || { error: '请求失败' };
      if (result && result.items) state.items = result.items;
      render();
      return;
    }
    state.items = reset ? (result.items || []) : [...state.items, ...(result.items || [])];
    state.total = typeof result.total === 'number' ? result.total : null;
    state.hasMore = result.hasMore === true;
    state.nextCursor = result.nextCursor || null;
    if (result.categories?.length) state.categories = result.categories;
    if (result.sources && result.sources.ok !== false) state.sources = result.sources;
    render();
  }

  /* 先画骨架，再同时拉来源列表与第一页。 */
  render();
  loadSources();
  loadList({ reset: true });

  return { dispose, _state: state, reload: loadListNow };
}

export const mcpMarketInternals = {
  trustMeta,
  sourceCount,
  categoryIcon,
  installState,
  marketErrorText,
};
