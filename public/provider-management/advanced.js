/* 服务级高级设置。
 *
 * 只放合同里真实存在的字段：显示名、启用状态、本机注册引用。
 * 端点/API 类型归连接字段；模型参数归右栏，不在这里重复一份。 */

import { field, h, icon } from './dom.js';

function isLoopback(value) {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(String(value || '')).hostname);
  } catch { return false; }
}

export function renderAdvanced({ draft, snapshot, errors = {}, onDispatch = () => {}, onBack = () => {} }) {
  const root = h('div', { class: 'pm-advanced-view', 'data-advanced-view': 'true' });
  const nameInput = h('input', {
    class: 'pm-input',
    type: 'text',
    value: draft.displayName,
    'aria-label': '服务显示名称',
    'data-advanced-field': 'displayName',
  });
  nameInput.addEventListener('input', () => onDispatch({ type: 'field', field: 'displayName', value: nameInput.value }));

  const enabled = h('input', {
    type: 'checkbox',
    class: 'pm-checkbox',
    checked: draft.enabled !== false,
    'data-advanced-field': 'enabled',
  });
  enabled.addEventListener('change', () => onDispatch({ type: 'field', field: 'enabled', value: enabled.checked }));

  const piInput = h('input', {
    class: 'pm-input',
    type: 'text',
    value: draft.piRegistrationReference || '',
    placeholder: '$LOCAL_PROVIDER_TOKEN',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': '本机注册引用',
    'data-advanced-field': 'piRegistrationReference',
    disabled: draft.authMode === 'oauth' || draft.mode === 'clone',
  });
  piInput.addEventListener('input', () => onDispatch({ type: 'field', field: 'piRegistrationReference', value: piInput.value }));
  const piApplicable = draft.mode !== 'clone' && draft.authMode !== 'oauth' && isLoopback(draft.connection?.baseUrl);
  const piHint = draft.mode === 'clone'
    ? '复制不会携带本机注册引用；保存后可在新服务的凭据配置中重新设置。'
    : piApplicable
      ? '仅本机端点可用；只在没有其他凭据时作为 Pi 的注册引用，不会写入密钥。'
      : '本机注册引用只用于本机端点（127.0.0.1 / localhost / [::1]）。';

  const compatibility = draft.compatibility
    ? `兼容性：${draft.compatibility === 'unknown' ? '未知（不推断为可用）' : String(draft.compatibility)}`
    : '兼容性：未提供';
  const readOnly = draft.readOnly ? '该服务由 Pi 内置配置管理，部分字段只读。' : '';

  root.append(
    h('div', { class: 'pm-advanced-intro' },
      icon('info', 15),
      h('span', { text: '这些是非秘密配置。API Key 不在主页面输入，也不会写进这里。' }),
    ),
    h('div', { class: 'pm-advanced-fields' },
      field('服务名称', nameInput, { hint: '显示在服务列表和模型选择器里。', error: errors.displayName }),
      h('label', { class: 'pm-check-line pm-advanced-enabled' }, enabled, h('span', { text: '启用这个服务' })),
      field('Endpoint', h('div', { class: 'pm-readonly-value', text: draft.connection?.baseUrl || '—' }), {
        hint: draft.mode === 'update' ? '编辑现有服务时端点固定；需要换端点请复制为新服务。' : '自定义端点可在服务配置页修改。',
      }),
      field('API 类型', h('div', { class: 'pm-readonly-value', text: draft.connection?.api || '—' }), {
        hint: '协议由服务配置决定，不在这里重复编辑。',
      }),
      field('供应商标识', h('div', { class: 'pm-readonly-value', text: draft.providerId || '—' }), {
        hint: '标识由 Pi 配置决定，保存后不能修改。',
      }),
      field('目录条目', h('div', { class: 'pm-readonly-value', text: draft.catalogId || '自定义' }), {
        hint: '仅用于界面归类和图标，不覆盖 Pi 的身份判定。',
      }),
      field('本机注册引用', piInput, {
        hint: piHint,
        error: errors.piRegistrationReference,
      }),
      h('div', { class: 'pm-advanced-notes' },
        h('div', { text: compatibility }),
        readOnly ? h('div', { text: readOnly }) : null,
        h('div', { text: '自动发现、连接测试与 Runtime 同步由 P3 接通；当前只保存配置草稿。' }),
      ),
    ),
    h('div', { class: 'pm-advanced-foot' },
      h('button', { type: 'button', class: 'pm-btn pm-btn-small', on: { click: onBack } }, '返回服务配置'),
    ),
  );
  return root;
}
