/* P24 快捷键设置页 —— 由注册表渲染，可录制、禁用、单项恢复、全部恢复。
 *
 * 单独成文件（而不是塞在 `shortcuts.js` 里）是为了让那个模块**保持零 DOM 依赖**：
 * 注册表与匹配逻辑要能离线单测，`openModal` 会把 `document` 拉进来。
 *
 * 三态覆盖值由 `shortcuts.js` 唯一持有：
 *   没有覆盖 = 默认；字符串 = 自定义；null = 禁用（显示「未绑定」）。
 * 本文件只负责把状态画出来、把用户按键交给模型校验，绝不自己另存一份。
 *
 * Escape 的优先级：录制时在 window 的 capture 阶段截住 Escape，
 * 先取消录制并 stopPropagation —— 这样 `settings-surface.js` 的 document
 * Escape（返回设置总览）和全局快捷键分发都不会看到它。失去焦点也会退出录制。
 */
import { openModal } from './modal.js';
import { createIcon } from './icons.js';
import {
  IS_MAC,
  listShortcuts,
  shortcutState,
  commitShortcutBinding,
  resetShortcutBinding,
  resetAllShortcutBindings,
  subscribeShortcuts,
  hasShortcutOverrides,
  isAllowedKeybinding,
  isReservedKeybinding,
  comboFromEvent,
  formatCombo,
  formatComboParts,
  configureShortcutStorage,
  loadShortcutOverrides,
} from '../shortcuts.js';

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

/** 独立的键帽视觉：每个片段一个 <kbd>，片段之间一个 +。 */
function keycap(combo) {
  const wrap = node('span', 'shortcut-keybinding kb-keys');
  const parts = formatComboParts(combo);
  parts.forEach((part, index) => {
    if (index) wrap.append(node('span', 'shortcut-key-plus', '+'));
    wrap.append(node('kbd', '', part));
  });
  return wrap;
}

function contextKeys(keys) {
  const wrap = node('span', 'shortcut-keybinding kb-keys');
  keys.forEach((entry, index) => {
    if (index) wrap.append(node('span', 'shortcut-key-plus', entry.sep || '+'));
    wrap.append(node('kbd', '', entry.text));
  });
  return wrap;
}

export function openShortcutHelp({ present = openModal, storage = null } = {}) {
  if (storage) {
    configureShortcutStorage(storage);
    loadShortcutOverrides(storage);
  }

  const state = { recordingId: null, disposed: false };
  const refs = new Map();
  let resetAllButton = null;
  let statusEl = null;
  let unsubscribe = null;
  let windowKeyHandler = null;

  function setStatus(text, kind = '') {
    if (!statusEl) return;
    statusEl.hidden = !text;
    statusEl.textContent = text || '';
    statusEl.classList.toggle('is-error', kind === 'error');
  }

  function setError(id, message) {
    const ref = refs.get(id);
    if (!ref) return;
    ref.error.hidden = false;
    ref.error.textContent = message;
    ref.row.classList.add('has-error');
    ref.recorder.setAttribute('aria-invalid', 'true');
  }

  function clearError(id) {
    const ref = refs.get(id);
    if (!ref) return;
    ref.error.hidden = true;
    ref.error.textContent = '';
    ref.row.classList.remove('has-error');
    ref.recorder.removeAttribute('aria-invalid');
  }

  function clearAllErrors() {
    for (const id of refs.keys()) clearError(id);
  }

  function renderRow(ref) {
    const item = shortcutState(ref.item.id);
    if (!item) return;
    const recording = state.recordingId === ref.item.id;

    ref.row.dataset.state = item.disabled ? 'disabled' : item.customized ? 'custom' : 'default';
    ref.row.classList.toggle('is-disabled', item.disabled);

    ref.recorder.classList.toggle('is-recording', recording);
    ref.recorder.setAttribute('aria-pressed', String(recording));
    if (recording) {
      ref.recorder.replaceChildren(node('span', 'shortcut-recording-label', '请按下快捷键'));
      ref.recorder.setAttribute('aria-label', `正在录制「${item.label}」的快捷键，按 Esc 取消`);
      ref.recorder.title = '按 Esc 取消录制';
    } else if (item.disabled) {
      ref.recorder.replaceChildren(node('span', 'shortcut-unbound', '未绑定'));
      ref.recorder.setAttribute('aria-label', `「${item.label}」当前未绑定，点击设置快捷键`);
      ref.recorder.title = '点击录制新的快捷键（当前未绑定）';
    } else {
      ref.recorder.replaceChildren(keycap(item.effectiveCombo));
      ref.recorder.setAttribute('aria-label', `修改「${item.label}」的快捷键，当前 ${item.display}`);
      ref.recorder.title = `点击录制新的快捷键（当前 ${item.display}）`;
    }

    ref.disable.disabled = item.disabled;
    ref.disable.setAttribute('aria-pressed', String(item.disabled));
    ref.disable.setAttribute('aria-label', item.disabled ? `「${item.label}」已禁用` : `禁用「${item.label}」的快捷键`);
    ref.disable.title = item.disabled ? '已禁用' : '禁用这个快捷键';

    ref.reset.disabled = !item.customized;
    ref.reset.setAttribute('aria-label', `把「${item.label}」恢复为默认快捷键`);
    ref.reset.title = item.customized ? `恢复默认（${item.defaultDisplay}）` : '已经是默认快捷键';

    ref.chip.hidden = !item.customized;
    ref.chip.className = 'shortcut-state' + (item.disabled ? ' is-disabled' : item.customized ? ' is-custom' : '');
    ref.chip.textContent = item.disabled ? '已禁用' : item.customized ? '自定义' : '';
  }

  function renderAll() {
    for (const ref of refs.values()) renderRow(ref);
    if (resetAllButton) {
      resetAllButton.disabled = !hasShortcutOverrides();
      resetAllButton.title = resetAllButton.disabled ? '没有可恢复的快捷键' : '恢复全部默认快捷键';
    }
  }

  function stopRecording() {
    if (!state.recordingId) return;
    state.recordingId = null;
    renderAll();
  }

  function startRecording(id) {
    const ref = refs.get(id);
    if (!ref) return;
    if (state.recordingId && state.recordingId !== id) stopRecording();
    state.recordingId = id;
    clearError(id);
    setStatus('');
    renderAll();
    ref.recorder.focus();
  }

  function recordKey(ref, event) {
    // IME 正在组合时完全不碰事件，让输入法把这次按键处理完。
    if (event.isComposing || event.keyCode === 229) return;

    const key = typeof event.key === 'string' ? event.key : '';
    const modifierOnly = [
      'Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'CapsLock', 'Fn', 'FnLock',
      'Hyper', 'Super', 'Symbol', 'SymbolLock', 'OS',
    ].includes(key);
    if (modifierOnly) {
      // 单独按修饰键不结束录制，也不报错（用户正在按组合）。
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // 录制器自己处理按键：不冒泡到全局分发，也不让 settings-surface 的
    // document Escape 关闭设置页。window capture 里还有一层 Escape 保险。
    event.preventDefault();
    event.stopPropagation();

    if (key === 'Escape') {
      stopRecording();
      clearError(ref.item.id);
      return;
    }
    if (event.repeat) return;
    if (key === 'Dead' || key === 'Process' || key === 'Compose') {
      setError(ref.item.id, '这个按键不能单独作为快捷键，请换一个。');
      return;
    }
    if (typeof event.getModifierState === 'function') {
      try {
        if (event.getModifierState('AltGraph')) {
          setError(ref.item.id, 'AltGr 组合不能用作快捷键，请换一个。');
          return;
        }
      } catch {
        /* 合成事件没有实现完整接口时忽略 */
      }
    }

    const combo = comboFromEvent(event);
    if (!combo) {
      setError(ref.item.id, '请再按一个字母、数字或功能键。');
      return;
    }
    if (isReservedKeybinding(combo)) {
      setError(ref.item.id, `${formatCombo(combo)} 是系统、编辑器或终端保留的组合，不能绑定。`);
      return;
    }
    if (!isAllowedKeybinding(combo)) {
      setError(ref.item.id, '普通字母和数字需要配合 Ctrl、Alt 或 Shift；F1–F12 可以单独使用。');
      return;
    }

    const result = commitShortcutBinding(ref.item.id, combo);
    if (!result.ok) {
      if (result.reason === 'conflict') {
        setError(ref.item.id, `与「${result.conflict.label}」冲突：${formatCombo(result.conflict.combo)} 已绑定给该操作。`);
      } else if (result.reason === 'storage') {
        setError(ref.item.id, '保存失败，未修改当前键位。请检查本地存储权限。');
      } else if (result.reason === 'reserved') {
        setError(ref.item.id, `${formatCombo(combo)} 是保留组合，不能绑定。`);
      } else if (result.reason === 'modifier') {
        setError(ref.item.id, '这个组合需要一个 Ctrl、Alt 或 Meta 修饰键。');
      } else {
        setError(ref.item.id, '这个组合无法保存，请换一个。');
      }
      // 冲突 / 存储失败时保持录制，用户可以直接再按一个组合重试。
      return;
    }
    stopRecording();
    clearError(ref.item.id);
    renderAll();
  }

  function disableShortcut(id) {
    const ref = refs.get(id);
    if (!ref) return;
    if (state.recordingId === id) stopRecording();
    clearError(id);
    setStatus('');
    const result = commitShortcutBinding(id, null);
    if (!result.ok) {
      setError(id, result.reason === 'storage'
        ? '保存失败，未修改当前键位。请检查本地存储权限。'
        : '无法禁用这个快捷键，请重试。');
      renderAll();
      return;
    }
    renderAll();
    ref.recorder.focus();
  }

  function resetShortcut(id) {
    const ref = refs.get(id);
    if (!ref) return;
    if (state.recordingId === id) stopRecording();
    clearError(id);
    setStatus('');
    const result = resetShortcutBinding(id);
    if (!result.ok) {
      if (result.reason === 'conflict') {
        setError(id, `无法恢复默认：${formatCombo(result.conflict.combo)} 已绑定给「${result.conflict.label}」。`);
      } else if (result.reason === 'storage') {
        setError(id, '保存失败，未修改当前键位。请检查本地存储权限。');
      } else {
        setError(id, '无法恢复默认快捷键，请重试。');
      }
      renderAll();
      return;
    }
    renderAll();
    ref.recorder.focus();
  }

  function resetAll() {
    if (!hasShortcutOverrides()) return;
    if (state.recordingId) stopRecording();
    clearAllErrors();
    const result = resetAllShortcutBindings();
    if (!result.ok) {
      setStatus(result.reason === 'storage'
        ? '恢复默认失败，未修改当前键位。请检查本地存储权限。'
        : '恢复默认失败，请重试。', 'error');
      renderAll();
      return;
    }
    renderAll();
    setStatus('已恢复全部默认快捷键。');
    refs.values().next().value?.recorder.focus();
  }

  function createRow(item) {
    const row = node('div', 'shortcut-row');
    row.dataset.shortcutId = item.id;

    const copy = node('div', 'shortcut-row-copy');
    const title = node('div', 'settings-row-title');
    title.append(node('span', '', item.label));
    const chip = node('span', 'shortcut-state');
    chip.hidden = true;
    title.append(chip);

    const error = node('div', 'shortcut-error');
    error.id = `shortcut-error-${item.id}`;
    error.setAttribute('role', 'alert');
    error.hidden = true;
    copy.append(title, error);

    const controls = node('div', 'shortcut-row-controls');
    const recorder = node('button', 'shortcut-recorder');
    recorder.type = 'button';
    recorder.setAttribute('aria-pressed', 'false');
    recorder.setAttribute('aria-describedby', error.id);

    const disable = node('button', 'shortcut-action shortcut-disable');
    disable.type = 'button';
    disable.setAttribute('aria-pressed', 'false');
    disable.append(createIcon('power'));

    const reset = node('button', 'shortcut-action shortcut-reset');
    reset.type = 'button';
    reset.append(createIcon('refresh'));

    controls.append(recorder, disable, reset);
    row.append(copy, controls);

    const ref = { item, row, recorder, disable, reset, chip, error };
    recorder.addEventListener('click', () => startRecording(item.id));
    recorder.addEventListener('keydown', (event) => {
      if (state.recordingId !== item.id) return;
      recordKey(ref, event);
    });
    recorder.addEventListener('blur', () => {
      if (state.recordingId !== item.id) return;
      stopRecording();
    });
    disable.addEventListener('click', () => disableShortcut(item.id));
    reset.addEventListener('click', () => resetShortcut(item.id));
    return ref;
  }

  present((card, close) => {
    card.classList.add('wide', 'shortcut-settings-page');

    const heading = node('h3', '', '键盘快捷键');
    const toolbar = node('div', 'shortcut-page-toolbar');
    const desc = node('p', 'settings-page-desc',
      `${IS_MAC ? 'macOS' : 'Windows / Linux'} 映射。点击组合键重新录制；`
      + '禁用的快捷键显示为未绑定，恢复默认会重新启用。');
    resetAllButton = node('button', 'shortcut-reset-all');
    resetAllButton.type = 'button';
    resetAllButton.append(createIcon('refresh'), node('span', '', '恢复默认'));
    resetAllButton.setAttribute('aria-label', '恢复全部默认快捷键');
    resetAllButton.onclick = resetAll;
    toolbar.append(desc, resetAllButton);

    statusEl = node('p', 'shortcut-status');
    statusEl.setAttribute('role', 'status');
    statusEl.hidden = true;

    const map = node('div', 'shortcut-map');
    const groups = new Map();
    for (const item of listShortcuts()) {
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group).push(item);
    }
    for (const [group, items] of groups) {
      const section = node('section', 'shortcut-group');
      section.setAttribute('aria-label', group);
      section.append(node('div', 'shortcut-group-label', group));
      for (const item of items) {
        const ref = createRow(item);
        refs.set(item.id, ref);
        section.append(ref.row);
      }
      map.append(section);
    }

    const context = node('section', 'shortcut-context');
    context.append(node('div', 'shortcut-group-label', '输入与弹层（固定）'));
    const contextRows = node('div', 'shortcut-context-rows');
    for (const [label, keys] of [
      ['发送消息', [{ text: 'Enter' }]],
      ['换行', [{ text: 'Shift' }, { text: 'Enter' }]],
      ['停止生成 / 关闭浮层', [{ text: 'Esc' }]],
      ['列表与面板内移动', [{ text: '↑ ↓' }, { text: 'Tab', sep: '·' }]],
      ['危险确认框', [{ text: 'Tab' }, { text: 'Enter' }]],
    ]) {
      const row = node('div', 'shortcut-context-row');
      row.append(node('span', '', label), contextKeys(keys));
      contextRows.append(row);
    }
    context.append(
      contextRows,
      node('p', 'shortcut-context-note', '这些按键由输入框、弹层和终端按上下文处理，本轮保持只读。'),
    );

    const actions = node('div', 'modal-actions');
    const done = node('button', 'btn', '关闭');
    done.type = 'button';
    done.onclick = close;
    actions.append(done);

    card.append(heading, toolbar, statusEl, map, context, actions);

    unsubscribe = subscribeShortcuts(() => {
      if (!state.disposed) renderAll();
    });

    /* 录制时在 window capture 截住 Escape：它比 modal.js / settings-surface.js
     * 的 document 监听更早，取消录制后 stopPropagation，设置页不会被关掉。
     * 只处理 Escape；其它按键由录制器自己的 keydown 处理。 */
    windowKeyHandler = (event) => {
      if (!state.recordingId) return;
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      const id = state.recordingId;
      stopRecording();
      clearError(id);
    };
    window.addEventListener('keydown', windowKeyHandler, true);

    renderAll();
    refs.values().next().value?.recorder.focus();
  }, () => {
    state.disposed = true;
    state.recordingId = null;
    unsubscribe?.();
    if (windowKeyHandler) window.removeEventListener('keydown', windowKeyHandler, true);
  });
}
