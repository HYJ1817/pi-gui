/* 服务身份与凭据区。
 *
 * 关键边界：**主页面永远没有密钥输入框**。
 * 这里只展示凭据状态、固定的安全触发器（P5 接入前 disabled），
 * 以及非秘密的环境变量引用 $NAME。 */

import {
  catalogEndpointText,
  credentialSourceLabel,
  endpointLabel,
  isSubscription,
  monogram,
  serviceCredentialText,
} from './catalog.js';
import { credentialClearSupport } from './state.js';
import { CREDENTIAL_REASON } from './credentials.js';
import { button, field, h, icon } from './dom.js';

/* 凭据入口的真实可用性 = 私有桥 API 存在 + 快照能力（握手/SDK/存储资格）
 * 都成立。网页版、未握手、未开启输入或存储资格不足都必须禁用并说明原因，
 * 不能为了「按钮看起来能用」而放宽 P2/P3 的安全条件。存储不合格时连暂存
 * 都不允许——密钥不能先进入受限窗，再指望保存阶段拒绝。 */
function credentialCapability(snapshot, { legacy = false } = {}) {
  if (legacy) {
    return { available: false, reason: '兼容模式不提供安全凭据窗口；这里只写 $NAME 环境变量引用。' };
  }
  const capabilities = snapshot?.capabilities || {};
  const bridge = globalThis.window?.piGuiDesktop?.providerCredentials;
  if (!bridge || typeof bridge.open !== 'function') {
    return { available: false, reason: CREDENTIAL_REASON.web };
  }
  if (capabilities.privateDesktopBridge !== true || capabilities.keyStaging !== true ||
      capabilities.nativeCredentialPersistence !== true) {
    return {
      available: false,
      nativePersistence: false,
      reason: '桌面安全凭据窗口尚未开放：需要后端已连接、未被 PI_GUI_PROVIDER_KEY_INPUT=0 关闭、SDK 通过资格检查，且本机凭据存储通过安全资格检查。',
    };
  }
  return { available: true, nativePersistence: true, storageReason: '' };
}

function serviceChip({ item, draft, onOpenAuth, onChangeService }) {
  const cloning = draft.mode === 'clone';
  const subscription = !cloning && (isSubscription(item) || draft.authMode === 'oauth');
  const auth = item?.auth;
  const chip = h('div', { class: 'pm-service-chip' },
    h('span', { class: 'pm-service-monogram', 'aria-hidden': 'true', text: monogram(item || { id: draft.providerId, name: draft.displayName }) }),
    h('span', { class: 'pm-service-chip-copy' },
      h('span', { class: 'pm-service-chip-name', text: draft.displayName || draft.providerId || '未命名服务' }),
      h('span', { class: 'pm-service-chip-detail', text: cloning
        ? '复制为新服务 · 不携带凭据'
        : subscription
          ? (auth?.status === 'connected' ? '订阅账户 · 已连接' : '订阅账户 · 使用 Pi 登录')
          : endpointLabel(draft.connection) || catalogEndpointText(item || {}) || '自定义端点' }),
    ),
    cloning ? null
      : subscription
        ? button('管理登录', 'pm-btn-ghost pm-btn-small', onOpenAuth, { 'data-auth-entry': draft.providerId })
        : button('更换', 'pm-btn-ghost pm-btn-small pm-change-service', onChangeService),
  );
  return chip;
}

function cloneCredentialRow() {
  return h('div', { class: 'pm-credential-block pm-clone-credential' },
    h('div', { class: 'pm-credential-head' },
      h('div', {},
        h('div', { class: 'pm-field-label', text: 'API Key' }),
        h('div', { class: 'pm-credential-status', text: '复制不携带凭据' }),
      ),
    ),
    h('div', { class: 'pm-credential-note' },
      icon('lock', 14),
      h('span', { text: '源服务的密钥、环境变量引用与 Pi 本机凭据都不会复制；保存后再为新服务配置。' }),
    ),
  );
}

function credentialRow({ draft, snapshot, legacy = false, onCredentialTrigger, onClearCredential, onDiscardStage, onEnvReference, error }) {
  const capability = credentialCapability(snapshot, { legacy });
  const source = draft.credentialState?.source || 'none';
  const configOwned = ['env', 'literal', 'command'].includes(source);
  const unknownSource = !configOwned && source !== 'pi-credential' && source !== 'none';
  // 本机凭据的清除同样要经过私有桥与存储安全资格；资格不足时不能假装已清除。
  const persistenceReady = capability.available && capability.nativePersistence === true;
  const clear = credentialClearSupport(draft, {
    native: persistenceReady && source === 'pi-credential',
    // 桌面端存储资格不足时，不能把原因说成“网页版或私有桥不可用”。
    unavailableReason: source === 'pi-credential' && !capability.available ? capability.reason : '',
  });
  const hasCredential = draft.credentialState
    && draft.credentialState.state !== 'none'
    && draft.credentialState.source !== 'none';
  const nativeClearing = draft.nativeStage?.action === 'clear';
  const clearing = draft.credentialAction?.type === 'none' || nativeClearing;
  const canClear = clear.supported && !legacy;
  // 只有 Pi 本机凭据才用“本机”二字；未知来源或兼容模式不能借用这个说法。
  const clearLabel = clear.native ? '清除本机凭据' : canClear ? '清除配置凭据' : clear.source === 'pi-credential' ? '清除本机凭据' : '清除凭据';
  const clearReason = legacy
    ? clear.supported
      ? '兼容模式不会写入清除操作；如需移除配置凭据，请开启管理接口或直接检查 Pi 配置。'
      : clear.reason
    : clear.reason;
  const staged = draft.nativeStage?.action === 'set';
  const statusText = nativeClearing
    ? '已暂存清除；保存时从 Pi 本机凭据槽移除'
    : staged
      ? '新密钥已暂存；保存时写入 Pi 本机凭据槽'
      : clearing
        ? `保存后移除配置中的${clear.label || '凭据'}`
        : hasCredential ? serviceCredentialText({ credentialState: draft.credentialState }) : '未配置凭据';
  const envReference = draft.envReference || '';
  // 配置内的 env/literal/command 凭据不能由本机凭据窗口替换；否则保存会
  // 被后端以 credential_target_conflict 拒绝，界面必须先把原因说清楚。
  const triggerBlockedReason = !capability.available ? capability.reason
    : configOwned ? '该服务的凭据来自模型配置；请在上方环境变量引用中修改，或先清除配置凭据。'
      : unknownSource ? '凭据来源未知，无法安全判断要替换哪个槽位；请先确认 Pi 中的认证来源。'
        : '';
  const triggerDisabled = Boolean(triggerBlockedReason);

  const trigger = h('button', {
    type: 'button',
    class: `pm-credential-trigger${triggerDisabled ? ' is-disabled' : ''}`,
    id: 'pmCredentialTrigger',
    'data-credential-trigger': 'true',
    disabled: triggerDisabled,
    'aria-describedby': 'pmCredentialNote',
    title: triggerDisabled ? triggerBlockedReason : '打开安全凭据输入',
  }, icon('key', 15), h('span', { text: hasCredential ? '更换 API Key' : '配置 API Key' }));

  if (!triggerDisabled) trigger.addEventListener('click', () => onCredentialTrigger?.());
  else trigger.addEventListener('click', event => event.preventDefault());

  const envInput = h('input', {
    class: 'pm-input ds-input pm-env-input',
    type: 'text',
    value: envReference,
    placeholder: hasCredential && !clearing ? '保留现有凭据；输入新的 $NAME 可改用环境变量' : '$OPENAI_API_KEY 或 ${OPENAI_API_KEY}',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'API Key 环境变量引用',
  });
  envInput.addEventListener('input', () => onEnvReference?.(envInput.value));

  return h('div', { class: 'pm-credential-block' },
    h('div', { class: 'pm-credential-head' },
      h('div', {},
        h('div', { class: 'pm-field-label', text: 'API Key' }),
        h('div', { class: 'pm-credential-status', text: statusText }),
      ),
      h('div', { class: 'pm-credential-actions' },
        draft.nativeStage && !legacy
          ? button('放弃暂存', 'pm-btn-ghost pm-btn-small pm-discard-stage', () => onDiscardStage?.())
          : null,
        hasCredential && !clearing
          ? button(clearLabel, 'pm-btn-ghost pm-btn-small pm-clear-credential', () => onClearCredential?.({ native: clear.native === true }), {
            disabled: !canClear,
            title: clearReason,
          })
          : null,
        trigger,
      ),
    ),
    // 环境变量凭据不显示假掩码：它本来就没有密钥值可遮。
    hasCredential && draft.credentialState?.source !== 'env'
      ? h('div', { class: 'pm-mask-line', 'aria-hidden': 'true' }, '••••••••••••••••')
      : null,
    envInput,
    error ? h('div', { class: 'pm-field-error', role: 'alert', text: error }) : null,
    hasCredential && !canClear
      ? h('div', { class: 'pm-credential-note pm-clear-note' },
        icon('info', 14),
        h('span', { text: clearReason }),
      )
      : null,
    h('div', { class: 'pm-credential-note', id: 'pmCredentialNote' },
      icon(capability.available ? 'lock' : 'info', 14),
      h('span', { text: capability.available
        ? `密钥通过独立的安全桌面窗口输入，不会进入主页面。${capability.storageReason || ''}`
        : `${capability.reason}` }),
    ),
  );
}

export function renderConnectionFields({
  draft,
  snapshot,
  item,
  legacy = false,
  errors = {},
  onDispatch = () => {},
  onChangeService = () => {},
  onOpenAuth = () => {},
  onCredentialTrigger = () => {},
  onClearCredential = () => {},
  onDiscardStage = () => {},
}) {
  const root = h('div', { class: 'pm-connection-fields' });
  const subscription = draft.mode !== 'clone' && (draft.authMode === 'oauth' || isSubscription(item));
  if (subscription) {
    root.appendChild(h('div', { class: 'pm-oauth-panel' },
      h('div', { class: 'pm-oauth-status' },
        icon('lock', 16),
        h('div', {},
          h('div', { class: 'pm-oauth-title', text: item?.auth?.status === 'connected' ? '订阅账户已连接' : '订阅账户由 Pi 登录管理' }),
          h('div', { class: 'pm-oauth-detail', text: '账户状态来自 Pi 认证；这里不显示、也不接收令牌。' }),
        ),
      ),
      button('管理登录', 'pm-btn pm-btn-small', onOpenAuth),
      h('div', { class: 'pm-oauth-pending' },
        icon('info', 14),
        h('span', { text: '订阅账户的模型配置由 Pi 登录状态提供；这里不写入 API Key，也不会伪造模型列表。' }),
      ),
    ));
    return root;
  }

  const editingExisting = draft.mode === 'update';
  const custom = draft.catalogId === 'custom' || !item;

  // 参考布局把身份和凭据压缩成双栏顶带，模型双栏拿到主要高度；
  // 已知服务的地址与协议来自目录，不在主界面重复输入。
  const top = h('div', { class: 'pm-setup-top' },
    h('div', { class: 'pm-service-column' },
      h('div', { class: 'pm-connection-label', text: '服务' }),
      serviceChip({ item, draft, onOpenAuth, onChangeService }),
    ),
    h('div', { class: 'pm-credential-column' },
      draft.mode === 'clone'
        ? cloneCredentialRow()
        : credentialRow({
          draft,
          snapshot,
          legacy,
          onCredentialTrigger,
          onEnvReference: value => onDispatch({ type: 'env-reference', value }),
          onClearCredential,
          onDiscardStage,
          error: errors.envReference,
        }),
    ),
  );
  root.appendChild(top);

  // 编辑既有服务时端点与显示名都在高级设置里；主界面只保留身份和凭据。
  if (!custom || draft.mode === 'update') return root;

  let nameField = null;
  if (!legacy) {
    const nameInput = h('input', {
      class: 'pm-input ds-input',
      type: 'text',
      value: draft.displayName,
      placeholder: '服务名称',
      'aria-label': '服务名称',
    });
    nameInput.addEventListener('input', () => onDispatch({ type: 'field', field: 'displayName', value: nameInput.value }));
    nameField = field('名称', nameInput, {
      hint: '显示在服务列表和模型选择器里。',
      error: errors.displayName,
    });
  }

  const baseInput = h('input', {
    class: 'pm-input ds-input',
    type: 'text',
    value: draft.connection?.baseUrl || '',
    placeholder: 'https://api.example.com/v1',
    spellcheck: 'false',
    autocomplete: 'off',
    readOnly: editingExisting,
    'aria-label': 'Base URL',
    'data-connection-base-url': 'true',
  });
  baseInput.addEventListener('input', () => onDispatch({ type: 'connection-field', field: 'baseUrl', value: baseInput.value }));

  const apiSelect = h('select', {
    class: 'pm-select ds-input',
    'aria-label': 'API 类型',
    disabled: editingExisting,
  });
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']) {
    apiSelect.appendChild(h('option', { value: api, text: api, selected: (draft.connection?.api || 'openai-completions') === api }));
  }
  apiSelect.addEventListener('change', () => onDispatch({ type: 'connection-field', field: 'api', value: apiSelect.value }));

  let idField = null;
  if (draft.mode === 'create' || draft.mode === 'clone') {
    const idInput = h('input', {
      class: 'pm-input ds-input pm-provider-id',
      type: 'text',
      value: draft.providerId,
      placeholder: 'provider-id',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': '供应商标识',
    });
    idInput.addEventListener('input', () => onDispatch({ type: 'field', field: 'providerId', value: idInput.value }));
    idField = field('供应商标识', idInput, {
      hint: legacy ? '写入 Pi 模型配置的唯一 ID，也是列表里显示的名称。' : '写入 Pi 配置的唯一 ID，保存后不能修改。',
      error: errors.providerId,
    });
  }
  const identity = h('div', { class: 'pm-identity-grid' });
  if (nameField) identity.appendChild(nameField);
  if (idField) identity.appendChild(idField);

  root.appendChild(h('div', { class: 'pm-custom-fields' },
    identity,
    h('div', { class: 'pm-connection-grid' },
      field('Base URL', baseInput, {
        hint: editingExisting ? '编辑现有服务时端点固定；需要换端点请复制为新服务。' : '只填写协议、主机与路径，不要带凭据或查询参数。',
        error: errors.connection,
        className: 'pm-field-wide',
      }),
      field('API 类型', apiSelect, { hint: editingExisting ? '随服务身份固定。' : '决定请求与响应协议。', error: errors.connectionApi }),
    ),
  ));
  return root;
}

export function credentialSummary(draft) {
  if (draft.nativeStage?.action === 'set') return '已暂存 Pi 本机凭据';
  if (draft.nativeStage?.action === 'clear') return '保存后清除 Pi 本机凭据';
  const text = serviceCredentialText({ credentialState: draft.credentialState });
  if (draft.credentialAction?.type === 'none') return '保存后清除凭据';
  if (draft.envReference) return `环境变量 ${draft.envReference}`;
  return text;
}

export function credentialSourceText(state) {
  return credentialSourceLabel(state);
}
