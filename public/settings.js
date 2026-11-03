/* Settings organizes existing actions. Update state still belongs to its owners. */
import { openModal } from './ui/modal.js';
import { renderUpdateSection } from './update.js';
import { renderPiUpdateSection } from './pi-update.js';
import { themePreference, setThemePreference, onThemeChange } from './theme.js';

export function openAppearance({ present = openModal } = {}) {
  let unsubscribe = null;
  present((card, close) => {
    card.classList.add('appearance-card');

    const heading = document.createElement('h3');
    heading.textContent = '外观与主题';
    
    const desc = document.createElement('p');
    desc.className = 'modal-desc settings-page-desc';
    desc.textContent = '自定义界面主题、字体排版与工作区侧边栏偏好。';

    // Section 1: 外观
    const appGroupLabel = document.createElement('div');
    appGroupLabel.className = 'ds-settings-group-header';
    appGroupLabel.textContent = '外观';

    const body = document.createElement('fieldset');
    body.className = 'appearance-body ds-settings-card';
    
    // Row 1: 主题
    const themeRow = document.createElement('div');
    themeRow.className = 'appearance-theme-row ds-settings-row';

    const themeLead = document.createElement('div');
    themeLead.className = 'ds-settings-row-lead';
    const themeLabel = document.createElement('span');
    themeLabel.className = 'ds-settings-row-label';
    themeLabel.textContent = '主题';
    const themeHelp = document.createElement('span');
    themeHelp.className = 'ds-help-icon';
    themeHelp.title = '选择深色、浅色或跟随操作系统外观';
    themeHelp.setAttribute('aria-label', '主题提示');
    themeHelp.textContent = '?';
    themeLead.append(themeLabel, themeHelp);

    const themeTail = document.createElement('div');
    themeTail.className = 'ds-settings-row-tail';
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
    themeTail.append(select);
    themeRow.append(themeLead, themeTail);

    // Row 2: 语言
    const langRow = document.createElement('div');
    langRow.className = 'ds-settings-row';
    const langLead = document.createElement('div');
    langLead.className = 'ds-settings-row-lead';
    const langLabel = document.createElement('span');
    langLabel.className = 'ds-settings-row-label';
    langLabel.textContent = '语言';
    langLead.append(langLabel);

    const langTail = document.createElement('div');
    langTail.className = 'ds-settings-row-tail';
    const langSelect = document.createElement('select');
    langSelect.className = 'ds-select';
    langSelect.setAttribute('aria-label', '界面语言');
    for (const [value, text] of [['system', '跟随系统'], ['zh-CN', '简体中文'], ['en-US', 'English']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      langSelect.append(option);
    }
    try { langSelect.value = localStorage.getItem('pi-gui.language.v1') || 'system'; } catch {}
    langSelect.onchange = () => {
      try { localStorage.setItem('pi-gui.language.v1', langSelect.value); } catch {}
    };
    langTail.append(langSelect);
    langRow.append(langLead, langTail);

    // Row 3: 字体
    const fontRow = document.createElement('div');
    fontRow.className = 'ds-settings-row';
    const fontLead = document.createElement('div');
    fontLead.className = 'ds-settings-row-lead';
    const fontLabel = document.createElement('span');
    fontLabel.className = 'ds-settings-row-label';
    fontLabel.textContent = '字体';
    fontLead.append(fontLabel);

    const fontTail = document.createElement('div');
    fontTail.className = 'ds-settings-row-tail';
    const fontSelect = document.createElement('select');
    fontSelect.className = 'ds-select';
    fontSelect.setAttribute('aria-label', '排版字体');
    for (const [value, text] of [['system', '跟随系统'], ['mono', '等宽优先'], ['sans', '系统无衬线']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      fontSelect.append(option);
    }
    try { fontSelect.value = localStorage.getItem('pi-gui.font-family.v1') || 'system'; } catch {}
    fontSelect.onchange = () => {
      try { localStorage.setItem('pi-gui.font-family.v1', fontSelect.value); } catch {}
    };
    fontTail.append(fontSelect);
    fontRow.append(fontLead, fontTail);

    // Row 4: 字体大小
    const sizeRow = document.createElement('div');
    sizeRow.className = 'ds-settings-row ds-settings-row-multiline';
    const sizeLead = document.createElement('div');
    sizeLead.className = 'ds-settings-row-lead';
    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'ds-settings-row-label';
    sizeLabel.textContent = '字体大小';
    const sizeHelp = document.createElement('span');
    sizeHelp.className = 'ds-help-icon';
    sizeHelp.title = '调整界面基础字号缩放比例';
    sizeHelp.setAttribute('aria-label', '字体大小提示');
    sizeHelp.textContent = '?';
    sizeLead.append(sizeLabel, sizeHelp);

    const sizeTail = document.createElement('div');
    sizeTail.className = 'ds-settings-row-tail font-size-ctrls';

    const segGroup = document.createElement('div');
    segGroup.className = 'ds-segmented';
    segGroup.setAttribute('role', 'radiogroup');
    segGroup.setAttribute('aria-label', '字号档位');

    const segItems = [
      { label: '中杯', scale: '100' },
      { label: '大杯', scale: '110' },
      { label: '超大杯', scale: '120' },
      { label: '超超大杯', scale: '130' }
    ];
    const segButtons = [];
    const sliderRow = document.createElement('div');
    sliderRow.className = 'ds-slider-row';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'ds-slider';
    slider.min = '80';
    slider.max = '150';
    slider.step = '5';
    slider.setAttribute('aria-label', '字体缩放滑块');
    const sliderVal = document.createElement('span');
    sliderVal.className = 'ds-slider-val';

    let initialScale = 100;
    try {
      const stored = localStorage.getItem('pi-gui.font-scale.v1');
      if (stored && Number(stored)) initialScale = Number(stored);
    } catch {}
    slider.value = String(initialScale);
    sliderVal.textContent = initialScale + '%';

    function applyScale(pct) {
      const scaleNum = Number(pct);
      slider.value = String(scaleNum);
      sliderVal.textContent = scaleNum + '%';
      document.documentElement.style.setProperty('--font-scale', (scaleNum / 100).toFixed(2));
      try { localStorage.setItem('pi-gui.font-scale.v1', String(scaleNum)); } catch {}
      segButtons.forEach(btn => {
        btn.classList.toggle('is-active', Number(btn.dataset.scale) === scaleNum);
      });
    }

    segItems.forEach(item => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ds-segment-item' + (Number(item.scale) === initialScale ? ' is-active' : '');
      btn.dataset.scale = item.scale;
      btn.textContent = item.label;
      btn.onclick = () => applyScale(item.scale);
      segButtons.push(btn);
      segGroup.appendChild(btn);
    });

    slider.oninput = () => applyScale(slider.value);
    sliderRow.append(slider, sliderVal);
    sizeTail.append(segGroup, sliderRow);
    sizeRow.append(sizeLead, sizeTail);

    body.append(themeRow, langRow, fontRow, sizeRow);

    // Section 2: 侧边栏
    const sideGroupLabel = document.createElement('div');
    sideGroupLabel.className = 'ds-settings-group-header';
    sideGroupLabel.textContent = '侧边栏';

    const sideBody = document.createElement('div');
    sideBody.className = 'sidebar-prefs-card ds-settings-card';

    const sidebarRows = [
      { id: 'prefShowRunning', label: '在项目上显示运行状态', help: '在项目列表中显示实时活动状态点', default: true },
      { id: 'prefCountBadge', label: '数量徽标', default: true },
      { id: 'prefStreamGlow', label: '活动流光', default: false },
      { id: 'prefSessionTime', label: '会话时间', default: false }
    ];

    sidebarRows.forEach(cfg => {
      const row = document.createElement('div');
      row.className = 'ds-settings-row';
      const lead = document.createElement('div');
      lead.className = 'ds-settings-row-lead';
      const label = document.createElement('span');
      label.className = 'ds-settings-row-label';
      label.textContent = cfg.label;
      lead.append(label);
      if (cfg.help) {
        const help = document.createElement('span');
        help.className = 'ds-help-icon';
        help.title = cfg.help;
        help.setAttribute('aria-label', cfg.label + '提示');
        help.textContent = '?';
        lead.append(help);
      }

      const tail = document.createElement('div');
      tail.className = 'ds-settings-row-tail';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      let active = cfg.default;
      try {
        const stored = localStorage.getItem('pi-gui.' + cfg.id);
        if (stored !== null) active = stored === 'true';
      } catch {}
      toggle.className = 'ds-switch' + (active ? ' is-on' : '');
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', String(active));
      toggle.setAttribute('aria-label', cfg.label);
      const knob = document.createElement('span');
      knob.className = 'ds-switch-knob';
      toggle.append(knob);
      toggle.onclick = () => {
        const next = !toggle.classList.contains('is-on');
        toggle.classList.toggle('is-on', next);
        toggle.setAttribute('aria-checked', String(next));
        try { localStorage.setItem('pi-gui.' + cfg.id, String(next)); } catch {}
      };
      tail.append(toggle);
      row.append(lead, tail);
      sideBody.append(row);
    });

    const status = document.createElement('p');
    status.className = 'appearance-status';
    status.setAttribute('role', 'status');
    status.textContent = '仅改变界面外观；System 随系统主题变化。';

    select.onchange = async () => {
      if (!await setThemePreference(select.value)) {
        select.value = themePreference();
        status.textContent = '主题未能切换，请重试。';
      }
    };
    unsubscribe = onThemeChange(snapshot => {
      select.value = snapshot.preference;
      status.textContent = snapshot.persisted ? '主题偏好已保存。' : '主题已应用，本次无法保存偏好。';
    });

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'btn';
    done.textContent = '关闭';
    done.onclick = close;
    actions.append(done);

    card.append(heading, desc, appGroupLabel, body, sideGroupLabel, sideBody, status, actions);
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
