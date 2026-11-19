/* Appearance settings: theme, UI font and type scale.
 *
 * The page keeps the existing pi-GUI settings-detail/modal structure. Theme
 * persistence remains owned by theme.js; font and scale preferences are local
 * presentation settings applied before the next paint by theme-init.js.
 */
import { openModal } from './ui/modal.js';
import { themePreference, setThemePreference, onThemeChange } from './theme.js';
import { createSettingsCard, createSettingsRow, createSegmentedControl, createSettingsToggle } from './ui/primitives.js';
import { createThemePicker } from './ui/theme-picker.js';
import { createFontPicker } from './ui/font-picker.js';
import {
  loadSessionTitleSettings,
  onSessionTitleSettings,
  sessionTitleSettingsSnapshot,
  setAutoSessionTitle,
} from './session-titles.js';
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_PRESETS,
  FONT_SCALE_STEP,
  applyFontPreference,
  applyFontScale,
  loadSystemFonts,
  readFontPreference,
  readFontScale,
  resolveFontScale,
  writeFontPreference,
  writeFontScale
} from './fonts.js';

export function openAppearance({
  present = openModal,
  storage = null,
  fontLoader = loadSystemFonts
} = {}) {
  let store = storage;
  if (!store) {
    try { store = globalThis.localStorage; } catch { store = null; }
  }
  let unsubscribe = null;
  let unsubscribeTitle = null;
  let themePicker = null;
  let fontPicker = null;
  let disposed = false;
  present((card, close) => {
    card.classList.add('appearance-card');

    const heading = document.createElement('h3');
    heading.textContent = '外观与主题';

    const status = document.createElement('p');
    status.className = 'appearance-status';
    status.setAttribute('role', 'status');
    status.hidden = true;

    function setStatus(text, kind = '') {
      status.hidden = !text;
      status.textContent = text || '';
      status.classList.toggle('is-error', kind === 'error');
      status.classList.toggle('is-warning', kind === 'warning');
    }

    let themeRequest = 0;
    // Theme row -------------------------------------------------------------
    themePicker = createThemePicker({
      value: themePreference(),
      onSelect: async (mode) => {
        const request = ++themeRequest;
        themePicker.trigger.setAttribute('aria-busy', 'true');
        setStatus('正在保存主题偏好…');
        const ok = await setThemePreference(mode);
        if (disposed || request !== themeRequest) return false;
        themePicker.trigger.removeAttribute('aria-busy');
        if (!ok) {
          themePicker.setValue(themePreference());
          setStatus('主题未能保存，请重试。', 'error');
          return false;
        }
        return true;
      }
    });

    const themeRow = createSettingsRow({
      label: '主题',
      help: '选择深色、浅色或跟随操作系统外观。选择「跟随系统」后，界面会随系统主题变化。',
      control: themePicker.element,
      extraClass: 'appearance-theme-row'
    });

    // Font row --------------------------------------------------------------
    const fontPreference = readFontPreference(store);
    applyFontPreference(fontPreference.value);
    if (fontPreference.migrated) {
      try { writeFontPreference(fontPreference.value, store); } catch { /* Keep the in-memory migration. */ }
    }
    let fontValue = fontPreference.value;

    fontPicker = createFontPicker({
      selectedValue: fontValue,
      label: '排版字体',
      loadFonts: fontLoader,
      onSelect: (next) => {
        try {
          writeFontPreference(next, store);
        } catch {
          applyFontPreference(fontValue);
          fontPicker.setValue(fontValue);
          setStatus('字体未能保存，已恢复原设置。', 'error');
          return false;
        }
        fontValue = next;
        applyFontPreference(next);
        setStatus('');
        return true;
      }
    });

    const fontRow = createSettingsRow({
      label: '字体',
      help: '选择界面、对话和按钮使用的主要排版字体。代码块、终端、日志和 diff 继续使用等宽字体。',
      control: fontPicker.element,
      extraClass: 'appearance-font-row'
    });

    // Font size row ---------------------------------------------------------
    const initialScale = readFontScale(store);
    applyFontScale(initialScale);
    const sizeControl = document.createElement('div');
    sizeControl.className = 'font-size-ctrls appearance-size-control';

    const segmented = createSegmentedControl({
      options: FONT_SCALE_PRESETS.map((scale) => ({ label: scaleLabel(scale), value: String(scale) })),
      value: String(initialScale),
      onChange: (value) => commitScale(Number(value)),
      ariaLabel: '字号档位'
    });

    const sliderRow = document.createElement('div');
    sliderRow.className = 'ds-slider-row';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'ds-slider';
    slider.min = String(FONT_SCALE_MIN);
    slider.max = String(FONT_SCALE_MAX);
    slider.step = String(FONT_SCALE_STEP);
    slider.setAttribute('aria-label', '字体缩放滑块');
    slider.value = String(initialScale);
    slider.setAttribute('aria-valuetext', `${initialScale}%`);

    const sliderVal = document.createElement('span');
    sliderVal.className = 'ds-slider-val';
    sliderVal.textContent = `${initialScale}%`;

    function previewScale(value) {
      const scale = resolveFontScale(value);
      slider.value = String(scale);
      slider.setAttribute('aria-valuetext', `${scale}%`);
      sliderVal.textContent = `${scale}%`;
      segmented.setValue(String(scale));
      applyFontScale(scale);
      return scale;
    }

    let committedScale = initialScale;

    function commitScale(value) {
      const previous = committedScale;
      const scale = previewScale(value);
      try {
        committedScale = writeFontScale(scale, store);
        setStatus('');
      } catch {
        committedScale = previous;
        previewScale(previous);
        setStatus('字号未能保存，已恢复原设置。', 'error');
      }
    }

    slider.addEventListener('input', () => previewScale(slider.value));
    slider.addEventListener('change', () => commitScale(slider.value));
    sliderRow.append(slider, sliderVal);
    sizeControl.append(segmented.element, sliderRow);

    const sizeRow = createSettingsRow({
      label: '字体大小',
      help: '调整界面基础字号缩放比例；100% 保持默认布局密度。',
      control: sizeControl,
      extraClass: 'ds-settings-row-multiline appearance-size-row'
    });

    // Session titles --------------------------------------------------------
    /* 自动标题是**服务端设置**（跟着 Pi 走、跨窗口一致），不是 localStorage
     * 偏好；这里只负责展示与提交。开关失败时拨回原值，绝不让界面显示一个
     * 服务端其实没保存的状态。 */
    let titleRequest = 0;
    const initialTitle = sessionTitleSettingsSnapshot();
    const autoTitleToggle = createSettingsToggle({
      checked: initialTitle ? initialTitle.settings.autoEnabled !== false : true,
      ariaLabel: '自动生成会话标题',
      onChange: async (next) => {
        const request = ++titleRequest;
        autoTitleToggle.setDisabled(true);
        let result;
        try {
          result = await setAutoSessionTitle(next);
        } catch (err) {
          result = { ok: false, error: '设置未能保存：' + (err?.message || err) };
        }
        if (disposed) return;
        autoTitleToggle.setDisabled(false);
        if (request !== titleRequest) return; // 连点时只认最后一次
        if (!result.ok) {
          autoTitleToggle.setChecked(!next);
          setStatus(result.error || '会话标题设置未能保存，请重试。', 'error');
          return;
        }
        setStatus(next ? '已开启自动会话标题。' : '已关闭自动会话标题。');
      }
    });

    const autoTitleRow = createSettingsRow({
      label: '自动生成会话标题',
      detail: '根据首条提问与首条回复自动生成简短标题，会消耗少量模型用量。只对开启后新建的会话生效；已有标题与手动标题不会被改写。',
      control: autoTitleToggle.element,
      extraClass: 'appearance-title-row'
    });

    const modelValue = document.createElement('span');
    modelValue.className = 'session-title-model-value';
    modelValue.textContent = initialTitle?.model?.label || '跟随当前会话';
    const modelRow = createSettingsRow({
      label: '标题生成模型',
      detail: '使用产生该会话首条回复的供应商与模型，复用现有 Pi 认证，不额外配置 API Key。',
      control: modelValue,
      extraClass: 'appearance-title-model-row'
    });

    const titleCard = createSettingsCard({
      title: '会话标题',
      children: [autoTitleRow, modelRow]
    });
    titleCard.classList.add('appearance-title-card');

    function syncTitleSettings(snapshot) {
      if (disposed || !snapshot) return;
      autoTitleToggle.setChecked(snapshot.settings?.autoEnabled !== false);
      modelValue.textContent = snapshot.capability?.supported === false
        ? '当前 Pi 不支持独立模型调用'
        : (snapshot.model?.label || '跟随当前会话');
    }

    syncTitleSettings(initialTitle);
    unsubscribeTitle = onSessionTitleSettings(syncTitleSettings);
    void loadSessionTitleSettings().then((snapshot) => {
      if (!disposed) syncTitleSettings(snapshot);
    });

    // Page assembly ---------------------------------------------------------
    const cardBlock = createSettingsCard({
      title: '外观',
      children: [themeRow, fontRow, sizeRow]
    });
    cardBlock.classList.add('appearance-body');

    unsubscribe = onThemeChange((snapshot) => {
      if (disposed) return;
      themePicker?.setValue(snapshot.preference);
      if (!snapshot.persisted) setStatus('主题已应用，本次无法保存偏好。', 'warning');
      else setStatus('主题偏好已保存。');
    });

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'btn';
    done.textContent = '关闭';
    done.onclick = close;
    actions.append(done);

    card.append(heading, cardBlock, titleCard, status, actions);
    themePicker.focus();
  }, () => {
    disposed = true;
    unsubscribe?.();
    unsubscribeTitle?.();
    themePicker?.destroy();
    fontPicker?.destroy();
  });
}

function scaleLabel(scale) {
  if (scale === 100) return '中杯';
  if (scale === 110) return '大杯';
  if (scale === 120) return '超大杯';
  if (scale === 130) return '超超大杯';
  return `${scale}%`;
}
