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
  // 没声明 count 的项不生成计数节点；setCount 对它们无效果，也不会凭空插入节点。
  assert.equal(seg.element.querySelector('.ds-segment-count'), null);
  seg.setCount('dark', 3);
  assert.equal(seg.element.querySelector('.ds-segment-count'), null);
  console.log('✓ createSegmentedControl passed');
}

// 2b. Segmented Control：可选条数与隐藏项（技能页作用域分段「全部 5」、无条目时隐藏「临时」）
{
  const changes = [];
  const seg = createSegmentedControl({
    options: [
      { value: '', label: '全部', count: 5 },
      { value: 'project', label: '项目', count: 0 },
      { value: 'temporary', label: '临时', count: null },
      { value: 'plain', label: '无计数' },
    ],
    value: '',
    onChange: (val) => changes.push(val),
    ariaLabel: '作用域',
  });
  const item = (value) => seg.element.querySelector(`.ds-segment-item[data-value="${value}"]`);
  const count = (value) => item(value).querySelector('.ds-segment-count');
  assert.equal(item('').querySelector('.ds-segment-label').textContent, '全部');
  assert.equal(count('').textContent, '5');
  assert.equal(count('project').textContent, '0', '0 是一个真实计数，不能被当成「没有」清空');
  assert.equal(count('temporary').textContent, '', 'null 计数留空节点（CSS 里 :empty 不占位），不写成 0');
  assert.equal(count('plain'), null);
  seg.setCount('project', 2);
  assert.equal(count('project').textContent, '2');
  seg.setCount('', undefined);
  assert.equal(count('').textContent, '');
  seg.setCount('missing', 9); // 不存在的值：静默忽略
  assert.equal(seg.element.querySelectorAll('.ds-segment-count').length, 3);

  seg.setOptionHidden('temporary', true);
  assert.equal(item('temporary').hidden, true);
  assert.equal(item('project').hidden, false, '只隐藏指定的那一项');
  seg.setOptionHidden('temporary', false);
  assert.equal(item('temporary').hidden, false);
  assert.deepEqual(changes, [], 'setCount / setOptionHidden 不触发 onChange');
  console.log('✓ createSegmentedControl count / hidden passed');
}

// 2c. Segmented Control：radiogroup 键盘语义（roving tabindex + 方向键 / Home / End）
{
  const changes = [];
  const seg = createSegmentedControl({
    options: [
      { value: 'a', label: '全部', count: 4 },
      { value: 'b', label: '全局', count: 3 },
      { value: 'c', label: '项目', count: 1 },
    ],
    value: 'b',
    onChange: (val) => changes.push(val),
    ariaLabel: '按范围筛选',
  });
  dom.window.document.body.appendChild(seg.element);
  const item = (value) => seg.element.querySelector(`.ds-segment-item[data-value="${value}"]`);
  const checked = () => [...seg.element.querySelectorAll('.ds-segment-item')]
    .filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.dataset.value);
  const tabStops = () => [...seg.element.querySelectorAll('.ds-segment-item')]
    .filter((b) => b.tabIndex === 0).map((b) => b.dataset.value);
  const press = (key, target = dom.window.document.activeElement) => {
    target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  };

  assert.equal(seg.element.getAttribute('role'), 'radiogroup');
  assert.equal(seg.element.getAttribute('aria-label'), '按范围筛选');
  assert.deepEqual([...seg.element.querySelectorAll('.ds-segment-item')].map((b) => b.getAttribute('role')),
    ['radio', 'radio', 'radio']);
  assert.deepEqual(checked(), ['b']);
  assert.deepEqual(tabStops(), ['b'], '整组只有一个 Tab 停靠点，落在当前选中项');

  item('b').focus();
  press('ArrowRight');
  assert.equal(seg.getValue(), 'c', 'ArrowRight 选中下一项');
  assert.deepEqual(checked(), ['c']);
  assert.deepEqual(tabStops(), ['c']);
  assert.equal(dom.window.document.activeElement, item('c'));
  press('ArrowRight');
  assert.equal(seg.getValue(), 'a', '末项 ArrowRight 回绕到首项');
  assert.equal(dom.window.document.activeElement, item('a'));
  press('ArrowLeft');
  assert.equal(seg.getValue(), 'c', '首项 ArrowLeft 回绕到末项');
  press('Home');
  assert.equal(seg.getValue(), 'a');
  assert.equal(dom.window.document.activeElement, item('a'));
  press('End');
  assert.equal(seg.getValue(), 'c');
  assert.equal(dom.window.document.activeElement, item('c'));
  press('ArrowDown');
  assert.equal(seg.getValue(), 'a', 'ArrowDown 与 ArrowRight 等价');
  press('ArrowUp');
  assert.equal(seg.getValue(), 'c', 'ArrowUp 与 ArrowLeft 等价');
  assert.deepEqual(changes, ['c', 'a', 'c', 'a', 'c', 'a', 'c']);

  /* 点击仍然有效；点当前项不重复通知，但会把它留在 Tab 停靠点。 */
  item('b').click();
  assert.equal(seg.getValue(), 'b');
  assert.deepEqual(tabStops(), ['b']);
  assert.deepEqual(checked(), ['b']);
  item('b').click();
  assert.equal(changes.at(-1), 'b', '重复点击同一项不重复触发 onChange');
  assert.equal(changes.length, 8);

  /* 禁用项被方向键跳过；当前项被禁用时，Tab 停靠点退到第一个可用项。 */
  seg.setOptionDisabled('c', true);
  item('b').focus();
  press('ArrowRight');
  assert.equal(seg.getValue(), 'a', 'ArrowRight 跳过禁用的「项目」');
  seg.setValue('c');
  assert.deepEqual(tabStops(), ['a'], '当前项不可用时，停靠点退到第一个可用项');
  seg.setOptionDisabled('c', false);
  seg.setValue('b');

  /* 外部 setValue 只更新选中与停靠点，不抢焦点。 */
  item('b').focus();
  seg.setValue('a');
  assert.equal(dom.window.document.activeElement, item('b'), 'setValue 不移动焦点');
  assert.deepEqual(tabStops(), ['a']);

  /* 隐藏当前项后同样不会留下不可达的 Tab 停靠点。 */
  seg.setOptionHidden('a', true);
  assert.deepEqual(tabStops(), ['b']);
  seg.setOptionHidden('a', false);

  /* 修饰键不劫持，交给浏览器/系统。 */
  const before = seg.getValue();
  item(before).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, bubbles: true, cancelable: true }));
  assert.equal(seg.getValue(), before, 'Ctrl+ArrowRight 不切换分段');
  seg.element.remove();
  console.log('✓ createSegmentedControl radiogroup keyboard passed');
}

// 3. Help Icon
{
  const icon = createHelpIcon({ tooltipText: '此处用于配置思维链推理预算' });
  assert.equal(icon.tagName, 'BUTTON');
  assert.equal(icon.getAttribute('aria-expanded'), 'false');
  assert.equal(icon.getAttribute('aria-label'), '帮助');
  assert.equal(icon.querySelector('svg[data-icon="help"]').getAttribute('aria-hidden'), 'true');
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

// 6. Shared icons use one accessible SVG while preserving static shells.
{
  const dom = new JSDOM('<svg class="search-ic" data-icon="search"></svg>', { runScripts: 'outside-only' });
  const browser = dom.window;
  browser.eval(bundle(path.join(__dirname, '../public/ui/icons.js')).code);
  browser.hydrateIcons(browser.document);
  const staticIcon = browser.document.querySelector('svg');
  const dynamicIcon = browser.createIcon('search', { ownerDocument: browser.document });
  assert.equal(staticIcon.innerHTML, dynamicIcon.innerHTML);
  assert.equal(staticIcon.getAttribute('class'), 'search-ic');
  assert.equal(dynamicIcon.getAttribute('viewBox'), '0 0 24 24');
  assert.equal(dynamicIcon.getAttribute('stroke'), 'currentColor');
  assert.equal(dynamicIcon.getAttribute('stroke-width'), '1.7');
  assert.equal(dynamicIcon.getAttribute('aria-hidden'), 'true');
  assert.equal(browser.iconMarkup('constructor'), '');
  assert.equal(browser.iconMarkup('<script>'), '');
  browser.close();
  console.log('✓ shared icon contract passed');
}

// 7. Settings entry uses the checked-in Lucide settings gear.
{
  const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
  const browser = dom.window;
  browser.eval(bundle(path.join(__dirname, '../public/ui/icons.js')).code);

  const settingsGlyph = browser.iconMarkup('settings');
  assert.match(settingsGlyph, /data-icon="settings"/);
  assert.match(settingsGlyph, /M12\.22 2h-\.44/);
  assert.match(settingsGlyph, /<circle cx="12" cy="12" r="3"\/>/);
  assert.notEqual(settingsGlyph, browser.iconMarkup('slidersHorizontal'));

  const icon = browser.createIcon('settings', { ownerDocument: browser.document });
  assert.equal(icon.getAttribute('data-icon'), 'settings');
  assert.equal(icon.getAttribute('viewBox'), '0 0 24 24');
  assert.equal(icon.getAttribute('aria-hidden'), 'true');
  assert.equal(icon.getAttribute('focusable'), 'false');
  assert.equal(icon.querySelectorAll('path').length, 1);
  assert.equal(icon.querySelectorAll('circle').length, 1);
  assert.equal(browser.iconMarkup('settings'), browser.iconMarkup('settings'));
  browser.close();
  console.log('✓ Lucide settings gear icon passed');
}

console.log('All primitive tests passed successfully!');
dom.window.close();
