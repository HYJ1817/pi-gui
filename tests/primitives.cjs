'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

console.log('Testing public/ui/primitives.js...');

// Setup JSDOM or minimal DOM mock for testing primitives
class MockElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.attributes = {};
    const classes = new Set();
    this.classList = {
      add: cls => classes.add(cls),
      remove: cls => classes.delete(cls),
      toggle: (cls, force) => {
        if (force === undefined) {
          if (classes.has(cls)) classes.delete(cls);
          else classes.add(cls);
        } else if (force) {
          classes.add(cls);
        } else {
          classes.delete(cls);
        }
        return classes.has(cls);
      },
      contains: cls => classes.has(cls)
    };
    Object.defineProperty(this, 'className', {
      set: v => {
        classes.clear();
        (v || '').split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
      },
      get: () => Array.from(classes).join(' ')
    });
    this._textContent = '';
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  appendChild(el) { this.children.push(el); return el; }
  append(...els) { els.forEach(e => this.children.push(e)); }
  set textContent(v) { this._textContent = v; }
  get textContent() {
    return this._textContent || this.children.map(c => c.textContent).join('');
  }
}

globalThis.document = {
  createElement: tag => new MockElement(tag)
};

// Read and eval primitives.js
const code = fs.readFileSync(path.join(__dirname, '../public/ui/primitives.js'), 'utf8')
  .replace(/export function /g, 'function ');

const context = {
  document: globalThis.document,
  console
};
vm.createContext(context);
vm.runInContext(code + '\n;globalThis.primitives = { createSettingsToggle, createSegmentedControl, createHelpIcon, createBadge, createSettingsCard, createSettingsRow };', context);

const { createSettingsToggle, createSegmentedControl, createHelpIcon, createBadge, createSettingsCard, createSettingsRow } = context.primitives;

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
  assert.equal(icon.getAttribute('role'), 'note');
  assert.equal(icon.getAttribute('aria-label'), '此处用于配置思维链推理预算');
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
