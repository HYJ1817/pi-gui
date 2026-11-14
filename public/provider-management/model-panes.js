/* 双栏模型管理。
 *
 * 左栏是候选，右栏是已选与顺序。搜索只过滤可见行：
 * 清空搜索后已选集合和顺序必须和搜索前一模一样。
 *
 * 右栏顺序只写 modelOrder（GUI 顺序），不触发 Runtime 当前模型切换。 */

import {
  DISCOVERY_REASON,
  DISCOVERY_STATUS,
} from './discovery.js';
import {
  allVisibleSelected,
  filterModels,
  projectModelVisibility,
} from './model-visibility.js';
import { h, icon, iconButton, field } from './dom.js';

const SOURCE_LABEL = Object.freeze({
  configured: '已配置',
  'builtin-override': '内置覆盖',
  manual: '手动添加',
  remote: '远端候选',
  cache: '缓存候选',
});

function escapeSelector(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function formatCompact(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number % 1_000_000 ? 1 : 0)}M`;
  if (number >= 1000) return `${(number / 1000).toFixed(number % 1000 ? 1 : 0)}K`;
  return String(number);
}

function triLabel(value) {
  if (value === true) return '支持';
  if (value === false) return '不支持';
  return '未知';
}

function capabilityBadges(model) {
  const chips = [];
  if (model.reasoning === true) chips.push('推理');
  if (Array.isArray(model.input) && model.input.includes('image')) chips.push('图像');
  if (model.contextWindow) chips.push(`${formatCompact(model.contextWindow)} 上下文`);
  else if (model.source === 'remote' || model.source === 'cache') chips.push('上下文未知');
  if (model.maxTokens) chips.push(`${formatCompact(model.maxTokens)} 输出`);
  else if (model.source === 'remote' || model.source === 'cache') chips.push('输出未知');
  if (model.toolCalling === true) chips.push('工具');
  if (model.streaming === true) chips.push('流式');
  return chips;
}

/* 显示回退：发现/缓存候选的 name/容量等元数据是服务端白名单化后的只读值，
 * 只用于展示（行标题、容量徽标），不参与编辑与持久化比较。 */
function displayOf(model) {
  /* 只有发现/缓存候选使用展示回退；configured/builtin-override 的显示必须
   * 服从当前草稿的编辑状态（清空字段即恢复继承/默认，不被旧值遮盖）。 */
  const fallback = model.source === 'remote' || model.source === 'cache' ? (model.displayValues || {}) : {};
  return {
    ...model,
    name: model.name || fallback.name || null,
    contextWindow: model.contextWindow || fallback.contextWindow || null,
    maxTokens: model.maxTokens || fallback.maxTokens || null,
    reasoning: model.reasoning ?? fallback.reasoning ?? null,
    input: Array.isArray(model.input) && model.input.length
      ? model.input
      : Array.isArray(fallback.input) && fallback.input.length ? fallback.input : null,
  };
}

function sourceBadge(model) {
  const label = model.source === 'cache' && model.cachedStale ? '缓存已过期' : SOURCE_LABEL[model.source] || '模型';
  return h('span', { class: `pm-model-source is-${model.source}`, text: label });
}

function errorText(errors, modelId, fieldName) {
  return errors?.[modelId]?.[fieldName] || '';
}

function testSummary(test) {
  if (!test || test.status === 'idle') return '';
  if (test.status === 'running') return '连接测试进行中…';
  if (test.status === 'failed') return `连接测试失败：${test.reason || test.error || '未知原因'}`;
  const facts = test.facts || {};
  const parts = [];
  if (facts.reachability === true) parts.push('端点可达');
  else if (facts.reachability === false) parts.push('端点不可达');
  if (facts.modelListAccess === true) parts.push('模型目录可读');
  else if (facts.modelListAccess === false) parts.push('模型目录不可读');
  // 合同只能证明目录访问；认证是否被接受与推理调用都不可由这里断言。
  parts.push('认证是否被接受：未知');
  parts.push('未验证推理调用');
  if (Number.isFinite(facts.retryAt)) parts.push(`可重试时间 ${new Date(facts.retryAt).toLocaleTimeString('zh-CN', { hour12: false })}`);
  return `连接测试：${parts.join(' · ')}`;
}

function discoveryNote(state, { onRefresh, onAuthorize, onTest, onCancel }) {
  const status = state?.status || DISCOVERY_STATUS.UNSUPPORTED;
  const unsupported = status === DISCOVERY_STATUS.UNSUPPORTED;
  const busy = status === DISCOVERY_STATUS.DEBOUNCING || status === DISCOVERY_STATUS.REFRESHING;
  const error = status === DISCOVERY_STATUS.ERROR_STALE;
  const testing = state?.test?.status === 'running';
  let text = '';
  if (unsupported) text = state?.reason || DISCOVERY_REASON.discovery_transport_pending;
  else if (status === DISCOVERY_STATUS.UNAPPROVED) text = state?.reason || DISCOVERY_REASON.network_not_approved;
  else if (busy) text = '正在发现模型，已选模型保持不变…';
  else if (error) text = state?.reason || '发现失败，保留上次结果';
  else if (status === DISCOVERY_STATUS.READY) text = `${state.models.length} 个候选 · ${state.source === 'cache' ? '缓存' : '远端'}`;
  else if (status === DISCOVERY_STATUS.EMPTY) text = state?.reason || '没有发现模型';
  else text = '已授权，等待刷新';
  const testText = testSummary(state?.test);
  if (testText) text = `${text} · ${testText}`;
  const actions = [];
  if (status === DISCOVERY_STATUS.UNAPPROVED) {
    actions.push(h('button', {
      type: 'button',
      class: 'pm-btn pm-btn-small',
      'data-authorize-discovery': 'true',
      on: { click: () => onAuthorize?.() },
    }, '授权并发现'));
  } else {
    const refresh = h('button', {
      type: 'button',
      class: 'pm-btn pm-btn-small pm-refresh-models',
      'data-refresh-models': 'true',
      disabled: unsupported || busy,
      title: unsupported ? text : '重新读取候选模型；不会清除已选模型',
      on: { click: () => onRefresh?.({ force: true }) },
    }, icon('refresh', 14), busy ? '发现中…' : '刷新');
    actions.push(refresh);
    if (state?.consentId) {
      actions.push(h('button', {
        type: 'button',
        class: 'pm-btn pm-btn-small pm-test-connection',
        'data-test-connection': 'true',
        disabled: testing || busy,
        title: '只检查授权目标的模型目录访问；不会把目录访问说成推理已验证',
        on: { click: () => onTest?.() },
      }, testing ? '测试中…' : '测试连接'));
    }
  }
  if (busy || testing) {
    actions.push(h('button', {
      type: 'button',
      class: 'pm-btn-ghost pm-btn-small pm-cancel-discovery',
      'data-cancel-discovery': 'true',
      on: { click: () => onCancel?.() },
    }, '取消'));
  }
  return h('div', {
    class: `pm-discovery-note${unsupported ? ' is-unsupported' : ''}${error ? ' is-error' : ''}${busy ? ' is-busy' : ''}`,
    'data-discovery-status': status,
    'data-test-status': state?.test?.status || 'idle',
  }, icon(unsupported ? 'info' : busy ? 'refresh' : error ? 'alert' : 'spark', 14), h('span', { class: 'pm-discovery-text', text }), ...actions);
}

function candidateRow(model, draft, dispatch, errors) {
  const selected = draft.order.includes(model.modelId);
  const shown = displayOf(model);
  const checkbox = h('input', {
    type: 'checkbox',
    class: 'pm-checkbox',
    checked: selected,
    'data-model-check': model.modelId,
    'data-focus-key': `candidate:${model.modelId}`,
    'aria-label': `${selected ? '取消选择' : '选择'}模型 ${shown.name || model.modelId}`,
  });
  checkbox.addEventListener('change', () => dispatch({ type: 'toggle-model', modelId: model.modelId, selected: checkbox.checked }));
  const badges = capabilityBadges(shown);
  const modelError = errors?.[model.modelId];
  return h('label', {
    class: `pm-model-row pm-candidate-row${selected ? ' is-selected' : ''}${modelError ? ' has-error' : ''}`,
    'data-model-row': model.modelId,
  },
  checkbox,
  h('span', { class: 'pm-model-row-copy' },
    h('span', { class: 'pm-model-row-title' },
      h('span', { class: 'pm-model-name', text: shown.name || model.modelId }),
      sourceBadge(model),
      modelError ? h('span', { class: 'pm-model-error-dot', title: '该模型参数有误', text: '!' }) : null,
    ),
    h('span', { class: 'pm-model-row-sub' },
      h('span', { class: 'pm-model-id', text: shown.name ? model.modelId : '' }),
      ...badges.map(text => h('span', { class: 'pm-model-chip', text })),
    ),
    modelError ? h('span', { class: 'pm-model-inline-error', text: Object.values(modelError)[0] }) : null,
  ));
}

function advancedPanel(model, draft, dispatch, errors, onRemove) {
  const setField = (fieldName, value) => dispatch({ type: 'model-field', modelId: model.modelId, field: fieldName, value });
  /* 未知 ≠ 继承：发现/缓存候选若目录没给容量，输入框必须说“未知”；配置里
   * 留空才是“继承 Pi 默认”。两者都不写入补丁，也不在界面上显示成 0。 */
  const shown = displayOf(model);
  const discovered = model.source === 'remote' || model.source === 'cache';
  const sizePlaceholder = (value) => discovered
    ? (value ? `目录 ${formatCompact(value)} · 留空继承` : '未知 · 留空继承')
    : '继承';
  const nameInput = h('input', {
    type: 'text',
    class: 'pm-input ds-input pm-input-small',
    value: model.name || '',
    placeholder: '使用 Pi 默认名称',
    'aria-label': '显示名',
    'data-model-field': `${model.modelId}:name`,
    'data-focus-key': `advanced:${model.modelId}:name`,
  });
  nameInput.addEventListener('input', () => setField('name', nameInput.value));
  const contextInput = h('input', {
    type: 'number',
    min: '1',
    step: '1',
    class: 'pm-input ds-input pm-input-small',
    value: model.contextWindow || '',
    placeholder: sizePlaceholder(shown.contextWindow),
    'aria-label': '上下文窗口',
    'data-model-field': `${model.modelId}:contextWindow`,
    'data-focus-key': `advanced:${model.modelId}:contextWindow`,
  });
  contextInput.addEventListener('input', () => setField('contextWindow', contextInput.value));
  const maxInput = h('input', {
    type: 'number',
    min: '1',
    step: '1',
    class: 'pm-input ds-input pm-input-small',
    value: model.maxTokens || '',
    placeholder: sizePlaceholder(shown.maxTokens),
    'aria-label': '最大输出',
    'data-model-field': `${model.modelId}:maxTokens`,
    'data-focus-key': `advanced:${model.modelId}:maxTokens`,
  });
  maxInput.addEventListener('input', () => setField('maxTokens', maxInput.value));

  const reasoning = h('select', {
    class: 'pm-select ds-input pm-select-small',
    'aria-label': '推理能力',
    'data-model-field': `${model.modelId}:reasoning`,
    'data-focus-key': `advanced:${model.modelId}:reasoning`,
  },
  h('option', { value: '', text: '继承 Pi 默认', selected: model.reasoning === null }),
  h('option', { value: 'true', text: '支持推理', selected: model.reasoning === true }),
  h('option', { value: 'false', text: '不支持推理', selected: model.reasoning === false }),
  );
  reasoning.addEventListener('change', () => setField('reasoning', reasoning.value === '' ? null : reasoning.value === 'true'));

  const inputTypes = ['text', 'image'];
  const inputBoxes = inputTypes.map(kind => {
    const checkbox = h('input', {
      type: 'checkbox',
      checked: Array.isArray(model.input) && model.input.includes(kind),
      'data-model-input': `${model.modelId}:${kind}`,
      'data-focus-key': `advanced:${model.modelId}:input:${kind}`,
    });
    checkbox.addEventListener('change', () => {
      const next = inputTypes.filter(item => {
        const node = checkbox.parentElement.parentElement.querySelector(`[data-model-input="${model.modelId}:${item}"]`);
        return node && node.checked;
      });
      setField('input', next.length ? next : null);
    });
    return h('label', { class: 'pm-check-line' }, checkbox, h('span', { text: kind === 'text' ? '文本' : '图像' }));
  });

  return h('div', { class: 'pm-model-advanced', 'data-model-advanced': model.modelId },
    h('div', { class: 'pm-model-advanced-head' },
      h('span', { class: 'pm-model-mono-id', text: model.modelId }),
      h('span', { class: 'pm-model-mono-source', text: SOURCE_LABEL[model.source] || '' }),
    ),
    h('div', { class: 'pm-advanced-grid' },
      field('显示名', nameInput, { error: errorText(errors, model.modelId, 'name') }),
      h('div', { class: 'pm-number-grid' },
        field('上下文窗口', contextInput, { hint: 'tokens', error: errorText(errors, model.modelId, 'contextWindow') }),
        field('最大输出', maxInput, { hint: 'tokens', error: errorText(errors, model.modelId, 'maxTokens') }),
      ),
      field('推理能力', reasoning),
      h('div', { class: 'pm-field' },
        h('div', { class: 'pm-field-label', text: '输入类型' }),
        h('div', { class: 'pm-check-row' }, ...inputBoxes),
        h('div', { class: 'pm-field-hint', text: '不勾选表示继承 Pi 默认。' }),
        errorText(errors, model.modelId, 'input') ? h('div', { class: 'pm-field-error', text: errorText(errors, model.modelId, 'input') }) : null,
      ),
      h('div', { class: 'pm-capability-readout' },
        h('span', { class: 'pm-capability-label', text: '工具调用' }), h('span', { text: triLabel(model.toolCalling) }),
        h('span', { class: 'pm-capability-label', text: '流式输出' }), h('span', { text: triLabel(model.streaming) }),
        h('span', { class: 'pm-capability-hint', text: '未知表示目录未声明该能力，不代表不支持；容量留空表示继承 Pi 默认，不写入补丁。' }),
      ),
    ),
    h('div', { class: 'pm-model-advanced-foot' },
      h('span', { class: 'pm-model-foot-note', text: model.source === 'builtin-override'
        ? '这是 Pi 内置模型的覆盖配置；保存时需要确认。'
        : model.source === 'manual' ? '手动添加的模型会写入 Pi 配置。'
          : model.source === 'remote' || model.source === 'cache' ? '远端/缓存候选只有被选中后才会写入 Pi 配置。'
            : '移除只影响 Pi 配置里的这一条模型。' }),
      h('button', {
        type: 'button',
        class: 'pm-btn pm-btn-danger-ghost pm-btn-small',
        'data-model-remove-config': model.modelId,
        on: { click: () => onRemove(model) },
      }, '移除模型配置'),
    ),
  );
}

function chosenRow(model, index, total, draft, dispatch, errors, expanded, reorderLocked, actions) {
  const shown = displayOf(model);
  const badges = capabilityBadges(shown);
  const remove = iconButton(`从已选模型移除 ${shown.name || model.modelId}`, 'close', () => actions.onRemove(model), 'pm-remove-model');
  remove.dataset.modelRemove = model.modelId;
  const advancedToggle = h('button', {
    type: 'button',
    class: 'pm-btn-ghost pm-btn-small pm-advanced-toggle',
    'aria-expanded': expanded ? 'true' : 'false',
    'aria-controls': `pmModelAdvanced-${model.modelId}`,
    'data-model-advanced-toggle': model.modelId,
    on: { click: () => actions.toggleAdvanced(model.modelId) },
  }, expanded ? '收起参数' : '参数');

  const handle = h('button', {
    type: 'button',
    class: 'pm-drag-handle',
    draggable: !reorderLocked,
    'aria-label': `拖动排序 ${shown.name || model.modelId}；或用上下方向键移动`,
    'data-model-handle': model.modelId,
    'data-focus-key': `chosen:${model.modelId}`,
    title: reorderLocked ? '清空右侧搜索后可排序' : '拖动排序，或用方向键移动',
    'aria-disabled': reorderLocked ? 'true' : 'false',
  }, icon('drag', 15));
  handle.addEventListener('keydown', event => {
    if (reorderLocked) return;
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    dispatch({
      type: 'move-model',
      modelId: model.modelId,
      offset: event.key === 'Home' ? -total : event.key === 'End' ? total : event.key === 'ArrowUp' ? -1 : 1,
    });
    actions.announce(`模型 ${shown.name || model.modelId} 已移动到第 ${event.key === 'Home' ? 1 : event.key === 'End' ? total : Math.max(1, Math.min(total, index + (event.key === 'ArrowUp' ? 0 : 2)))} 位`);
  });
  const row = h('div', {
    class: `pm-chosen-row${expanded ? ' is-expanded' : ''}${errors?.[model.modelId] ? ' has-error' : ''}`,
    draggable: !reorderLocked,
    'data-chosen-model': model.modelId,
  },
  handle,
  h('span', { class: 'pm-chosen-index', 'aria-hidden': 'true', text: String(index + 1) }),
  h('div', { class: 'pm-chosen-copy' },
    h('div', { class: 'pm-chosen-title' },
      h('span', { class: 'pm-model-name', text: shown.name || model.modelId }),
      sourceBadge(model),
    ),
    h('div', { class: 'pm-chosen-sub' },
      h('span', { class: 'pm-model-id', text: shown.name ? model.modelId : '' }),
      ...badges.map(text => h('span', { class: 'pm-model-chip', text })),
    ),
    errors?.[model.modelId] ? h('div', { class: 'pm-model-inline-error', text: Object.values(errors[model.modelId])[0] }) : null,
  ),
  h('div', { class: 'pm-chosen-actions' }, advancedToggle, remove));
  row.addEventListener('dragstart', event => {
    if (reorderLocked) { event.preventDefault(); return; }
    actions.startDrag(model.modelId);
    try { event.dataTransfer?.setData('text/plain', model.modelId); } catch { /* jsdom */ }
    row.classList.add('is-dragging');
  });
  row.addEventListener('dragend', () => actions.endDrag());
  row.addEventListener('dragover', event => {
    if (!actions.dragging() || actions.dragging() === model.modelId) return;
    event.preventDefault();
    row.classList.add('is-drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'));
  row.addEventListener('drop', event => {
    if (!actions.dragging()) return;
    event.preventDefault();
    const moving = actions.dragging();
    row.classList.remove('is-drop-target');
    if (moving && moving !== model.modelId) dispatch({ type: 'move-before', modelId: moving, targetId: model.modelId });
    actions.endDrag();
  });
  const wrap = h('div', { class: 'pm-chosen-item' }, row);
  if (expanded) {
    const panel = advancedPanel(model, draft, dispatch, errors, actions.onRemove);
    panel.id = `pmModelAdvanced-${model.modelId}`;
    wrap.appendChild(panel);
  }
  return wrap;
}

export function renderModelPanes({
  draft,
  dispatch = () => {},
  errors = {},
  capabilities = {},
  discovery,
  recommendation = null,
  onRefresh = () => {},
  onAuthorize = () => {},
  onTest = () => {},
  onCancel = () => {},
  onRemove = () => {},
  onCustomError = () => {},
  onDraftChange = () => {},
} = {}) {
  const root = h('div', { class: 'pm-model-panes' });
  let currentDraft = draft;
  let currentErrors = errors;
  let currentDiscovery = discovery;
  let currentRecommendation = recommendation;
  const candidateQuery = { value: '' };
  const chosenQuery = { value: '' };
  const expanded = new Set();
  let dragging = null;

  const announce = text => {
    if (statusLine) statusLine.textContent = text;
  };
  const statusLine = h('div', { class: 'pm-reorder-status', role: 'status', 'aria-live': 'polite' });

  const left = h('section', { class: 'pm-model-pane pm-candidate-pane', 'data-model-pane': 'candidates', 'aria-label': '候选模型' });
  const right = h('section', { class: 'pm-model-pane pm-chosen-pane', 'data-model-pane': 'chosen', 'aria-label': '已选模型' });
  const leftHead = h('div', { class: 'pm-pane-head' });
  const rightHead = h('div', { class: 'pm-pane-head' });
  const leftSearch = h('div', { class: 'pm-search ds-search-field ds-search-control pm-pane-search' },
    icon('search', 14),
    h('input', {
      class: 'pm-search-input',
      type: 'search',
      placeholder: '搜索候选模型…',
      'aria-label': '搜索候选模型',
      'data-model-search': 'candidates',
      autocomplete: 'off',
    }),
  );
  const rightSearch = h('div', { class: 'pm-search ds-search-field ds-search-control pm-pane-search' },
    icon('search', 14),
    h('input', {
      class: 'pm-search-input',
      type: 'search',
      placeholder: '搜索已选模型…',
      'aria-label': '搜索已选模型',
      'data-model-search': 'chosen',
      autocomplete: 'off',
    }),
  );
  const leftList = h('div', { class: 'pm-model-list pm-candidate-list', 'data-model-list': 'candidates' });
  const rightList = h('div', { class: 'pm-model-list pm-chosen-list', 'data-model-list': 'chosen' });
  const rightFoot = h('div', { class: 'pm-custom-model-foot' });
  /* FIX-A：推荐依据就放在已选栏底部，和选择本身在同一视野里；用户改过选择
   * 后立刻收起，不留下“系统还会继续替你改”的暗示。 */
  const recommendationHost = h('div', { class: 'pm-recommendation', 'data-recommendation': 'idle', role: 'status' });
  left.append(leftHead, leftSearch, leftList);
  right.append(rightHead, rightSearch, rightList, rightFoot);
  root.append(left, right, statusLine);

  const captureFocus = () => {
    const active = document.activeElement;
    if (!active || !root.contains(active)) return null;
    const key = active.getAttribute('data-focus-key');
    if (!key) return null;
    return {
      key,
      start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
      end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
    };
  };
  const restoreFocus = saved => {
    if (!saved) return;
    const node = root.querySelector(`[data-focus-key="${escapeSelector(saved.key)}"]`);
    if (!node) return;
    node.focus();
    if (saved.start !== null && typeof node.setSelectionRange === 'function') {
      try { node.setSelectionRange(saved.start, saved.end); } catch { /* number inputs */ }
    }
  };

  const actions = {
    dragging: () => dragging,
    startDrag(id) { dragging = id; },
    endDrag() {
      dragging = null;
      for (const node of root.querySelectorAll('.is-drop-target, .is-dragging')) node.classList.remove('is-drop-target', 'is-dragging');
    },
    toggleAdvanced(id) {
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      renderLists();
    },
    onRemove(model) {
      if (model.source === 'manual' && !model.persisted) fineDispatch({ type: 'remove-model', modelId: model.modelId });
      else onRemove(model);
    },
    announce,
  };

  function renderHeads(projection) {
    leftHead.innerHTML = '';
    rightHead.innerHTML = '';
    const visibleModels = projection.candidates;
    const all = allVisibleSelected(visibleModels, currentDraft.order);
    const selectAll = h('input', {
      type: 'checkbox',
      class: 'pm-checkbox',
      checked: all,
      'data-select-all-candidates': 'true',
      'data-focus-key': 'select-all-candidates',
      'aria-label': '选择当前可见的全部候选模型',
      disabled: visibleModels.length === 0,
    });
    selectAll.indeterminate = !all && visibleModels.some(model => currentDraft.order.includes(model.modelId));
    selectAll.addEventListener('change', () => fineDispatch({
      type: 'select-visible',
      visibleIds: visibleModels.map(model => model.modelId),
      selected: selectAll.checked,
    }));
    leftHead.append(
      h('div', { class: 'pm-pane-title' },
        h('span', { text: '可用模型' }),
        h('span', { class: 'pm-pane-count', text: `${projection.candidates.length}` }),
      ),
      h('label', { class: 'pm-select-all' }, selectAll, h('span', { text: '全选' })),
    );
    rightHead.append(
      h('div', { class: 'pm-pane-title' },
        h('span', { text: '已选模型' }),
        h('span', { class: 'pm-pane-count', text: `${currentDraft.order.length}` }),
      ),
      h('span', { class: 'pm-pane-hint', text: currentDraft.order.length ? '顺序即 GUI 展示顺序' : '可以一个都不选' }),
    );
    if (projection.chosenFiltered) {
      rightHead.appendChild(h('div', { class: 'pm-reorder-lock', text: '清空右侧搜索后可排序' }));
    }
  }

  function renderList(container, models, render) {
    container.innerHTML = '';
    if (!models.length) {
      container.appendChild(h('div', { class: 'pm-pane-empty' },
        h('div', { class: 'pm-empty-title', text: container.dataset.modelList === 'candidates' ? '没有候选模型' : '还没有选择模型' }),
        h('div', { class: 'pm-empty-text', text: container.dataset.modelList === 'candidates'
          ? currentDiscovery?.status === DISCOVERY_STATUS.UNSUPPORTED
            ? '可以手动添加模型 ID；当前环境不支持自动发现。'
            : '可以手动添加模型 ID，或用“授权并发现”读取供应商目录。'
          : '不选也可以保存；保存后该服务不会出现在模型选择器。' }),
      ));
      return;
    }
    for (const model of models) container.appendChild(render(model));
  }

  function renderFoot() {
    if (rightFoot.childElementCount) return;
    const input = h('input', {
      class: 'pm-input ds-input pm-custom-model-input',
      type: 'text',
      placeholder: '输入模型 ID，例如 gpt-5',
      'aria-label': '自定义模型 ID',
      'data-custom-model-input': 'true',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const add = h('button', {
      type: 'button',
      class: 'pm-btn pm-btn-small pm-add-custom-model',
      'data-add-custom-model': 'true',
      on: { click: () => submit() },
    }, icon('plus', 14), '添加模型');
    const error = h('div', { class: 'pm-custom-error', role: 'alert', hidden: true });
    const submit = () => {
      const id = input.value.trim();
      if (!id) {
        error.hidden = false; error.textContent = '请填写模型 ID';
        input.focus();
        return;
      }
      if (currentDraft.models.some(model => model.modelId === id)) {
        error.hidden = false; error.textContent = '模型 ID 已存在';
        input.focus();
        return;
      }
      const next = fineDispatch({ type: 'add-model', modelId: id });
      if (next && next.error) {
        error.hidden = false; error.textContent = next.error;
        input.focus();
        return;
      }
      error.hidden = true;
      input.value = '';
      if (next) {
        expanded.add(id);
        renderLists();
        root.querySelector(`[data-model-advanced-toggle="${escapeSelector(id)}"]`)?.focus();
      }
    };
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); submit(); }
    });
    rightFoot.append(
      recommendationHost,
      h('div', { class: 'pm-custom-model-row' }, input, add),
      h('div', { class: 'pm-field-hint', text: '手动添加的 ID 会写入 Pi 配置；重复 ID 不会被覆盖。' }),
      error,
    );
  }

  function renderRecommendation() {
    recommendationHost.innerHTML = '';
    const rec = currentRecommendation;
    const picked = rec?.autoPicked === true && rec.picks?.length > 0 && currentDraft.touchedSelection !== true;
    if (picked) {
      recommendationHost.dataset.recommendation = 'picked';
      const basis = rec.picks.map(id => `${id}（${rec.reasons?.[id] || '目录声明可用'}）`).join('、');
      recommendationHost.append(icon('spark', 14),
        h('span', { class: 'pm-recommendation-text', text: `已按目录能力信息推荐 ${rec.picks.length} 个模型：${basis}。修改选择后不再自动改选。` }));
      return;
    }
    if (rec?.insufficient === true && currentDraft.touchedSelection !== true) {
      recommendationHost.dataset.recommendation = 'insufficient';
      recommendationHost.append(icon('info', 14),
        h('span', { class: 'pm-recommendation-text', text: '模型目录没有声明聊天或工具能力，无法可靠推荐；请手动选择（不会按模型名称猜测）。' }));
      return;
    }
    recommendationHost.dataset.recommendation = 'idle';
  }

  function renderLists() {
    const savedFocus = captureFocus();
    const projection = projectModelVisibility({
      models: currentDraft.models,
      order: currentDraft.order,
      candidateQuery: candidateQuery.value,
      chosenQuery: chosenQuery.value,
    });
    renderHeads(projection);
    renderList(leftList, projection.candidates, model => candidateRow(model, currentDraft, fineDispatch, currentErrors));
    const reorderLocked = projection.chosenFiltered;
    renderList(rightList, projection.chosen, model => {
      const index = currentDraft.order.indexOf(model.modelId);
      return chosenRow(model, index, currentDraft.order.length, currentDraft, fineDispatch, currentErrors, expanded.has(model.modelId), reorderLocked, actions);
    });
    const note = discoveryNote(currentDiscovery, { onRefresh, onAuthorize, onTest, onCancel });
    const existing = root.querySelector('.pm-discovery-note');
    if (existing) existing.replaceWith(note);
    else root.insertBefore(note, left);
    renderRecommendation();
    restoreFocus(savedFocus);
  }

  const fineDispatch = action => {
    const next = dispatch(action);
    if (next) {
      currentDraft = next;
      onDraftChange(next);
      renderLists();
    }
    return next;
  };

  const candidateInput = leftSearch.querySelector('input');
  candidateInput.addEventListener('input', event => {
    if (event.isComposing) return;
    candidateQuery.value = candidateInput.value;
    renderLists();
  });
  const chosenInput = rightSearch.querySelector('input');
  chosenInput.addEventListener('input', event => {
    if (event.isComposing) return;
    chosenQuery.value = chosenInput.value;
    renderLists();
  });

  function update(nextDraft, { errors: nextErrors = currentErrors, discovery: nextDiscovery = currentDiscovery,
    recommendation: nextRecommendation = currentRecommendation } = {}) {
    currentDraft = nextDraft;
    currentErrors = nextErrors || {};
    currentDiscovery = nextDiscovery || currentDiscovery;
    currentRecommendation = nextRecommendation;
    renderLists();
  }

  renderFoot();
  renderLists();
  return {
    node: root,
    update,
    setErrors(nextErrors) {
      currentErrors = nextErrors || {};
      renderLists();
    },
    setDiscovery(nextDiscovery) {
      currentDiscovery = nextDiscovery;
      const note = discoveryNote(currentDiscovery, { onRefresh, onAuthorize, onTest, onCancel });
      const existing = root.querySelector('.pm-discovery-note');
      if (existing) existing.replaceWith(note);
    },
    focusFirst() {
      const target = root.querySelector('.pm-model-row input, .pm-chosen-row button, .pm-custom-model-input');
      target?.focus();
    },
  };
}
