/* Appearance settings: theme, UI font and type scale.
 *
 * The page keeps the existing pi-GUI settings-detail/modal structure. Theme
 * persistence remains owned by theme.js; font and scale preferences are local
 * presentation settings applied before the next paint by theme-init.js.
 */
import { openModal } from './ui/modal.js';
import { themePreference, setThemePreference, onThemeChange } from './theme.js';
import { createSettingsCard, createSettingsRow, createSegmentedControl } from './ui/primitives.js';
import { createThemePicker } from './ui/theme-picker.js';
import { createFontPicker } from './ui/font-picker.js';
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

    card.append(heading, cardBlock, status, actions);
    themePicker.focus();
  }, () => {
    disposed = true;
    unsubscribe?.();
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
