'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');

console.log('Testing public/ui/primitives.js...');
const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
dom.window.eval(bundle(path.join(__dirname, '../public/ui/primitives.js')).code);
const { createSettingsToggle, createSegmentedControl, createHelpIcon, createBadge, createSettingsCard, createSettingsRow } = dom.window;

// 1. Settings Toggle
{
  let state = false;
  const toggle = createSettingsToggle({
    checked: false,
    onChange: val => { state = val; },
    ariaLabel: '开启自动保存'
  });
  assert.equal(toggle.isChecked(), false);
  assert.equal(toggle.element.getAttribute('role'), 'switch');
  assert.equal(toggle.element.getAttribute('aria-checked'), 'false');
  assert.equal(toggle.element.getAttribute('aria-label'), '开启自动保存');

  // Click
  toggle.element.onclick({ preventDefault() {} });
  assert.equal(state, true);
  assert.equal(toggle.isChecked(), true);
  assert.equal(toggle.element.getAttribute('aria-checked'), 'true');

  toggle.setChecked(false);
  assert.equal(toggle.isChecked(), false);

  toggle.setDisabled(true);
  toggle.element.onclick({ preventDefault() {} });
  assert.equal(toggle.isChecked(), false, 'Disabled toggle must not change');
  console.log('✓ createSettingsToggle passed');
}

// 2. Segmented Control
{
  let selected = 'dark';
  const seg = createSegmentedControl({
    options: [
      { value: 'dark', label: '深色' },
      { value: 'light', label: '浅色' },
      { value: 'system', label: '跟随系统' }
    ],
    value: 'dark',
    onChange: val => { selected = val; },
    ariaLabel: '主题切换'
  });
  assert.equal(seg.getValue(), 'dark');
  assert.equal(seg.element.children.length, 3);
  assert.equal(seg.element.children[0].classList.contains('is-active'), true);
  assert.equal(seg.element.children[1].classList.contains('is-active'), false);

  // Click light
  seg.element.children[1].onclick({ preventDefault() {} });
  assert.equal(selected, 'light');
  assert.equal(seg.getValue(), 'light');
  assert.equal(seg.element.children[0].classList.contains('is-active'), false);
  assert.equal(seg.element.children[1].classList.contains('is-active'), true);
  console.log('✓ createSegmentedControl passed');
}

// 3. Help Icon
{
  const icon = createHelpIcon({ tooltipText: '此处用于配置思维链推理预算' });
  assert.equal(icon.tagName, 'BUTTON');
  assert.equal(icon.getAttribute('aria-expanded'), 'false');
  assert.equal(icon.getAttribute('aria-label'), '帮助');
  assert.equal(icon.textContent, '?');
  console.log('✓ createHelpIcon passed');
}

// 4. Badge
{
  const badge = createBadge({ text: '已验证', tone: 'success' });
  assert.equal(badge.textContent, '已验证');
  assert.equal(badge.classList.contains('ds-badge'), true);
  assert.equal(badge.classList.contains('ds-badge-success'), true);
  console.log('✓ createBadge passed');
}

// 5. Card and Row
{
  const row = createSettingsRow({
    label: '深思模式',
    help: '启用扩展思考时间',
    control: createSettingsToggle({ checked: true })
  });
  assert.equal(row.classList.contains('ds-settings-row'), true);
  assert.equal(row.children.length, 2);

  const card = createSettingsCard({
    title: '模型常规参数',
    description: '影响智能体的采样温度与上下文截断规则',
    children: [row]
  });
  assert.equal(card.classList.contains('ds-settings-card'), true);
  console.log('✓ createSettingsCard & createSettingsRow passed');
}

console.log('All primitive tests passed successfully!');
dom.window.close();
