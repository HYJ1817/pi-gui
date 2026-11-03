/* Settings organizes existing actions. Update state still belongs to its owners. */
import { openModal } from './ui/modal.js';
import { renderUpdateSection } from './update.js';
import { renderPiUpdateSection } from './pi-update.js';
import { themePreference, setThemePreference, onThemeChange } from './theme.js';
import { createSettingsCard, createSettingsRow, createSegmentedControl } from './ui/primitives.js';

export function openAppearance({ present = openModal } = {}) {
  let unsubscribe = null;
  present((card, close) => {
    card.classList.add('appearance-card');

    const heading = document.createElement('h3');
    heading.textContent = '外观与主题';
    
    const desc = document.createElement('p');
    desc.className = 'modal-desc settings-page-desc';
    desc.textContent = '自定义界面主题与字体排版偏好。';

    // Row 1: 主题
    const select = document.createElement('select');
    select.className = 'ds-select';
    select.setAttribute('aria-label', '界面主题');
    for (const [value, text] of [['dark', '深色'], ['light', '浅色'], ['system', '跟随系统']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    select.value = themePreference();

    const themeRow = createSettingsRow({
      label: '主题',
      help: '选择深色、浅色或跟随操作系统外观',
      control: select,
      extraClass: 'appearance-theme-row'
    });

    // Row 2: 排版字体
    const fontSelect = document.createElement('select');
    fontSelect.className = 'ds-select';
    fontSelect.setAttribute('aria-label', '排版字体');
    for (const [value, text] of [['system', '跟随系统'], ['mono', '等宽优先'], ['sans', '系统无衬线']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      fontSelect.append(option);
    }
    let initialFont = 'system';
    try { initialFont = localStorage.getItem('pi-gui.font-family.v1') || 'system'; } catch {}
    fontSelect.value = initialFont;

    function applyFontFamily(val) {
      try { localStorage.setItem('pi-gui.font-family.v1', val); } catch {}
      let fontStack = '';
      if (val === 'mono') {
        fontStack = 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
      } else if (val === 'sans') {
        fontStack = '"Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';
      }
      if (fontStack) {
        document.documentElement.style.setProperty('--font-sans', fontStack);
        document.documentElement.style.setProperty('--ui-font-sans', fontStack);
      } else {
        document.documentElement.style.removeProperty('--font-sans');
        document.documentElement.style.removeProperty('--ui-font-sans');
      }
    }
    fontSelect.onchange = () => applyFontFamily(fontSelect.value);

    const fontRow = createSettingsRow({
      label: '字体',
      help: '自定义界面的主要排版字体',
      control: fontSelect
    });

    // Row 3: 字体大小
    const sizeControl = document.createElement('div');
    sizeControl.className = 'font-size-ctrls';

    const segItems = [
      { label: '中杯', value: '100' },
      { label: '大杯', value: '110' },
      { label: '超大杯', value: '120' },
      { label: '超超大杯', value: '130' }
    ];

    let initialScale = 100;
    try {
      const stored = localStorage.getItem('pi-gui.font-scale.v1');
      if (stored && Number(stored)) initialScale = Number(stored);
    } catch {}

    const sliderRow = document.createElement('div');
    sliderRow.className = 'ds-slider-row';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'ds-slider';
    slider.min = '80';
    slider.max = '150';
    slider.step = '5';
    slider.setAttribute('aria-label', '字体缩放滑块');
    slider.value = String(initialScale);

    const sliderVal = document.createElement('span');
    sliderVal.className = 'ds-slider-val';
    sliderVal.textContent = initialScale + '%';

    function applyScale(pct) {
      const scaleNum = Number(pct);
      if (Number.isFinite(scaleNum) && scaleNum >= 50 && scaleNum <= 200) {
        slider.value = String(scaleNum);
        sliderVal.textContent = scaleNum + '%';
        document.documentElement.style.setProperty('--font-scale', (scaleNum / 100).toFixed(2));
        try { localStorage.setItem('pi-gui.font-scale.v1', String(scaleNum)); } catch {}
        segmented.setValue(String(scaleNum));
      }
    }

    const segmented = createSegmentedControl({
      options: segItems,
      value: String(initialScale),
      onChange: (val) => applyScale(val),
      ariaLabel: '字号档位'
    });

    slider.oninput = () => applyScale(slider.value);
    sliderRow.append(slider, sliderVal);
    sizeControl.append(segmented.element, sliderRow);

    const sizeRow = createSettingsRow({
      label: '字体大小',
      help: '调整界面基础字号缩放比例',
      control: sizeControl,
      extraClass: 'ds-settings-row-multiline'
    });

    // Outer card
    const cardBlock = createSettingsCard({
      title: '外观',
      children: [themeRow, fontRow, sizeRow]
    });
    // Add appearance-body class to ensure tests targeting .appearance-body select find it
    cardBlock.classList.add('appearance-body');

    const status = document.createElement('p');
    status.className = 'appearance-status';
    status.setAttribute('role', 'status');
    status.textContent = '仅改变界面外观；System 随系统主题变化。';

    select.onchange = async () => {
      const ok = await setThemePreference(select.value);
      if (!ok) {
        select.value = themePreference();
        status.textContent = '主题未能保存，请重试。';
        status.className = 'appearance-status is-error';
      }
    };
    unsubscribe = onThemeChange(snapshot => {
      select.value = snapshot.preference;
      if (!snapshot.persisted) {
        status.textContent = '主题已应用，本次无法保存偏好。';
        status.className = 'appearance-status is-warning';
      } else {
        status.textContent = '主题偏好已保存。';
        status.className = 'appearance-status';
      }
    });

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'btn';
    done.textContent = '关闭';
    done.onclick = close;
    actions.append(done);

    card.append(heading, desc, cardBlock, status, actions);
    select.focus();
  }, () => unsubscribe?.());
}

export function openAppUpdates({ present = openModal } = {}) {
  present((card, close) => {
    card.classList.add('wide', 'app-updates-card');
    const heading = document.createElement('h3');
    heading.textContent = '应用与更新';
    card.appendChild(heading);
    renderUpdateSection(card);
    const runtime = document.createElement('details'); runtime.className = 'app-updates-runtime';
    const summary = document.createElement('summary'); summary.textContent = 'Pi 运行时更新';
    const runtimeBody = document.createElement('div');
    runtime.append(summary, runtimeBody); renderPiUpdateSection(runtimeBody); card.appendChild(runtime);
    const actions = document.createElement('div'); actions.className = 'modal-actions';
    const done = document.createElement('button'); done.type = 'button'; done.className = 'btn';
    done.textContent = '关闭'; done.onclick = close;
    actions.appendChild(done); card.appendChild(actions);
  });
}
