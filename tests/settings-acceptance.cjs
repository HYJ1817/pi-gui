'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');

console.log('Running tests/settings-acceptance.cjs (Phase A & B Real Module Integration Tests)...');

let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

async function checkAsync(name, fn) {
  await fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

const root = path.resolve(__dirname, '..');
const pub = path.join(root, 'public');

(async () => {
  // Test Group 1: Theme Init Startup Hydration for Font Scale and Font Family
  {
    const initCode = fs.readFileSync(path.join(pub, 'theme-init.js'), 'utf8');

    check('startup hydration restores font-scale from localStorage before paint', () => {
      const dom = new JSDOM('<html><head></head><body></body></html>', { url: 'http://fixture', runScripts: 'outside-only' });
      dom.window.localStorage.setItem('pi-gui.theme.v1', 'dark');
      dom.window.localStorage.setItem('pi-gui.font-scale.v1', '125');
      dom.window.eval(initCode);
      assert.equal(dom.window.document.documentElement.style.getPropertyValue('--font-scale'), '1.25');
      dom.window.close();
    });

    check('startup hydration restores monospace font-family before paint', () => {
      const dom = new JSDOM('<html><head></head><body></body></html>', { url: 'http://fixture', runScripts: 'outside-only' });
      dom.window.localStorage.setItem('pi-gui.font-family.v1', 'mono');
      dom.window.eval(initCode);
      const font = dom.window.document.documentElement.style.getPropertyValue('--font-sans');
      assert.ok(font.includes('monospace'), `Expected monospace font stack, got: ${font}`);
      dom.window.close();
    });

    check('startup hydration restores system sans font-family before paint', () => {
      const dom = new JSDOM('<html><head></head><body></body></html>', { url: 'http://fixture', runScripts: 'outside-only' });
      dom.window.localStorage.setItem('pi-gui.font-family.v1', 'sans');
      dom.window.eval(initCode);
      const font = dom.window.document.documentElement.style.getPropertyValue('--font-sans');
      assert.ok(font.includes('Segoe UI'), `Expected Segoe UI font stack, got: ${font}`);
      dom.window.close();
    });

    check('startup hydration handles missing or invalid font scale gracefully', () => {
      const dom = new JSDOM('<html><head></head><body></body></html>', { url: 'http://fixture', runScripts: 'outside-only' });
      dom.window.localStorage.setItem('pi-gui.font-scale.v1', 'invalid');
      dom.window.eval(initCode);
      assert.equal(dom.window.document.documentElement.style.getPropertyValue('--font-scale'), '');
      dom.window.close();
    });
  }

  // Test Group 2: D297 & D601 Primitives Specification
  {
    const dom = new JSDOM('<html><body></body></html>', { runScripts: 'outside-only' });
    dom.window.eval(bundle(path.join(pub, 'ui/primitives.js')).code);
    const { createSettingsToggle, createSettingsCard, createSettingsRow } = dom.window;

    check('createSettingsCard produces D297 independent card block with heading and panel', () => {
      const row = createSettingsRow({ label: '主题', control: dom.window.document.createElement('select') });
      const card = createSettingsCard({
        title: '外观',
        description: '选择深色或浅色外观',
        children: [row]
      });
      assert.ok(card.classList.contains('settings-card-block'));
      assert.ok(card.classList.contains('ds-settings-card-block'));
      const heading = card.querySelector('.settings-card-heading');
      assert.ok(heading, 'Card should have h3.settings-card-heading');
      assert.equal(heading.textContent, '外观');
      const help = card.querySelector('.ds-help-icon');
      assert.ok(help, 'Card should have help icon next to heading');
      const panel = card.querySelector('.settings-panel');
      assert.ok(panel, 'Card should have .settings-panel');
      assert.equal(panel.children.length, 1);
    });

    check('createSettingsRow produces D601 row with copy, title, help and control', () => {
      const toggle = createSettingsToggle({ checked: true, ariaLabel: '启用自动换行' });
      const row = createSettingsRow({
        label: '自动换行',
        help: '长文本自动在编辑器边缘折行',
        detail: '默认开启',
        control: toggle
      });
      assert.ok(row.classList.contains('settings-row'));
      assert.ok(row.classList.contains('ds-settings-row'));
      const title = row.querySelector('.settings-row-title');
      assert.ok(title);
      assert.ok(title.textContent.includes('自动换行'));
      const detail = row.querySelector('.settings-row-detail');
      assert.ok(detail);
      assert.equal(detail.textContent, '默认开启');
      const ctrl = row.querySelector('.settings-row-control');
      assert.ok(ctrl);
      assert.ok(ctrl.querySelector('.ds-switch'));
    });

    check('settings help uses one named disclosure with Escape, toggle and outside dismissal', () => {
      const dom = new JSDOM('<button id="outside">其他</button>', { runScripts: 'outside-only' });
      const w = dom.window;
      w.eval(bundle(path.join(pub, 'ui/primitives.js')).code);
      const first = w.createHelpIcon({ tooltipText: '<b>主题说明</b>', ariaLabel: '主题提示' });
      const second = w.createHelpIcon({ tooltipText: '字体说明', ariaLabel: '字体提示' });
      const outside = w.document.querySelector('#outside');
      w.document.body.append(first, second);
      assert.equal(first.tagName, 'BUTTON');
      assert.equal(first.type, 'button');
      assert.equal(first.getAttribute('aria-label'), '主题提示');
      assert.equal(first.getAttribute('aria-expanded'), 'false');
      assert.equal(first.hasAttribute('title'), false);
      first.focus();
      first.click();
      const popup = w.document.getElementById(first.getAttribute('aria-controls'));
      assert.equal(first.getAttribute('aria-expanded'), 'true');
      const description = w.document.getElementById(first.getAttribute('aria-describedby'));
      assert.notEqual(description, popup);
      assert.equal(description.textContent, '<b>主题说明</b>');
      assert.equal(popup.getAttribute('role'), 'region');
      assert.equal(popup.textContent, '<b>主题说明</b>');
      assert.equal(popup.querySelector('b'), null);
      second.click();
      assert.equal(first.getAttribute('aria-expanded'), 'false');
      assert.equal(first.hasAttribute('aria-describedby'), false);
      assert.equal(second.getAttribute('aria-controls'), popup.id);
      assert.equal(popup.textContent, '字体说明');
      second.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert.equal(popup.hidden, true);
      assert.equal(w.document.activeElement, second);
      first.click();
      first.click();
      assert.equal(popup.hidden, true);
      second.click();
      outside.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
      assert.equal(popup.hidden, true);
      assert.equal(second.getAttribute('aria-expanded'), 'false');
      dom.window.close();
    });
  }

  // Real App Bundle Execution Setup for Integration Tests
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:7788/' });
  const { window } = dom;

  window.EventSource = class { constructor() {} close() {} };
  window.fetch = async () => ({ json: async () => ({ ok: true, providers: {}, keyStates: {} }) });

  const bundled = bundle(path.join(pub, 'app.js'));
  window.eval(bundled.code);

  // Test Group 3: Real Module Search Filtering & Keyboard Navigation in Settings Menu
  {
    const searchInput = window.document.querySelector('#settingsSearchInput');
    const menu = window.document.querySelector('#globalMoreMenu');
    const btnAppearance = window.document.querySelector('#navAppearance');
    const btnShortcuts = window.document.querySelector('#navShortcutHelp');
    const btnProviders = window.document.querySelector('#navProviders');

    check('real settingsSearchInput input event filters navigation items and sections', () => {
      assert.ok(searchInput, 'searchInput element must exist');
      assert.ok(menu, 'globalMoreMenu must exist');

      // Filter by "快捷"
      searchInput.value = '快捷';
      searchInput.oninput();

      assert.equal(btnShortcuts.hidden, false, 'navShortcutHelp must be visible');
      assert.equal(btnAppearance.hidden, true, 'navAppearance must be hidden');
      assert.equal(btnProviders.hidden, true, 'navProviders must be hidden');
      assert.equal(btnProviders.closest('section').hidden, true, 'Model section must be hidden');
    });

    check('real keyboard navigation strictly skips hidden items during search', () => {
      // Focus the only visible item in preference section
      btnShortcuts.focus();
      assert.equal(window.document.activeElement, btnShortcuts);

      // ArrowDown should stay on the only visible item (wrapping around), never focusing hidden items
      menu.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      assert.equal(window.document.activeElement, btnShortcuts, 'ArrowDown must not focus hidden items');

      // ArrowUp from first visible button returns focus to search input
      menu.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      assert.equal(window.document.activeElement, searchInput, 'ArrowUp from first visible item must focus search input');

      // Clear search restores all items
      searchInput.value = '';
      searchInput.oninput();
      assert.equal(btnAppearance.hidden, false, 'navAppearance restored after search clear');
      assert.equal(btnProviders.hidden, false, 'navProviders restored after search clear');
    });
  }

  // Test Group 4: Real Module Provider Count, Empty State, and Catalog Synchronization
  check('search Down is consumed once before the menu handles the same event', () => {
    window.document.querySelector('#navGlobalMore').click();
    const search = window.document.querySelector('#settingsSearchInput');
    search.value = ''; search.oninput(); search.focus();
    search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    assert.equal(window.document.activeElement.id, 'navAppearance');
  });

  {
    check('real setProvidersData synchronizes providerCount, empty state card, and catalog count to 0', () => {
      // Mount providers panel via real openProvidersPanel
      window.openProvidersPanel({
        present: (build) => {
          const card = window.document.createElement('div');
          build(card, () => {});
          window.document.body.appendChild(card);
        }
      });

      // Deliver empty data
      window.setProvidersData({ path: '~/.pi/agent/models.json', providers: {}, keyStates: {} });

      const badge = window.document.querySelector('#providerCount').textContent;
      const emptyCard = window.document.querySelector('.prov-empty-card');
      const catalogSpan = window.document.querySelector('.prov-catalog-info span').textContent;

      assert.equal(badge, '', 'Badge should be empty string when 0 providers');
      assert.ok(emptyCard, 'Empty card must be present');
      assert.ok(catalogSpan.includes('0 个自定义服务'), `Footer catalog info must show 0 custom services, got: ${catalogSpan}`);
    });

    check('real setProvidersData synchronizes providerCount, card list, and catalog count to 2', () => {
      // Deliver 2 providers
      window.setProvidersData({
        path: '~/.pi/agent/models.json',
        providers: {
          deepseek: { models: [{ id: 'deepseek-chat' }], api: 'openai-completions' },
          openai: { models: [{ id: 'gpt-4o' }], api: 'openai-completions' }
        },
        keyStates: {}
      });

      const badge = window.document.querySelector('#providerCount').textContent;
      const provCards = window.document.querySelectorAll('.prov');
      const emptyCard = window.document.querySelector('.prov-empty-card');
      const catalogSpan = window.document.querySelector('.prov-catalog-info span').textContent;

      assert.equal(badge, '2', 'Badge must show 2');
      assert.equal(provCards.length, 2, 'Must render exactly 2 provider cards');
      assert.equal(emptyCard, null, 'Empty card must not exist when providers are present');
      assert.ok(catalogSpan.includes('2 个自定义服务'), `Footer catalog info must show 2 custom services, got: ${catalogSpan}`);
    });
  }

  // Test Group 5: Real Appearance Status & Error Reporting
  check('closing the Appearance modal releases its help popover and restores focus', () => {
    const trigger = window.document.createElement('button');
    window.document.body.append(trigger);
    trigger.focus();
    window.openAppearance();
    const card = window.document.getElementById('modalCard');
    const help = card.querySelector('.ds-help-icon');
    help.focus();
    help.click();
    const popup = window.document.getElementById(help.getAttribute('aria-controls'));
    assert.equal(popup.parentElement, card);
    help.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(popup.hidden, true);
    assert.equal(window.document.activeElement, help);
    assert.equal(window.document.getElementById('modal').hidden, false);
    help.click();
    window.closeModal();
    assert.equal(popup.parentElement, window.document.body);
    assert.equal(popup.hidden, true);
    assert.equal(window.document.activeElement, trigger);
    trigger.remove();
  });

  await checkAsync('real openAppearance displays status and reflects save error states', async () => {
    window.openAppearance({
      present: (build) => {
        const card = window.document.createElement('div');
        build(card, () => {});
        window.document.body.appendChild(card);
      }
    });

    const status = window.document.querySelector('.appearance-status');
    assert.ok(status, 'appearance-status element must be rendered');
    assert.ok(!status.classList.contains('is-error'), 'Initial status must not have error class');

    // Trigger save failure by passing invalid theme mode to select onchange
    const select = window.document.querySelector('.appearance-theme-row select');
    assert.ok(select, 'Theme select must be rendered');

    select.value = 'invalid-mode';
    await select.onchange();

    assert.ok(status.classList.contains('is-error'), 'Status must have .is-error class on failure');
    assert.equal(status.textContent, '主题未能保存，请重试。', 'Status text must explain save failure');
  });

  // Verify CSS does not suppress appearance status
  {
    const css = fs.readFileSync(path.join(pub, 'styles.css'), 'utf8');
    check('styles.css does not suppress .appearance-status with display:none !important', () => {
      assert.ok(!css.includes('.appearance-status {\n  display: none !important;\n}'));
      assert.ok(!css.includes('.appearance-status{display:none!important}'));
      assert.ok(css.includes('.appearance-status'));
    });
  }

  // Test Group 6: Settings Page Titles and Titlebar Continuity Specification
  {
    const css = fs.readFileSync(path.join(pub, 'styles.css'), 'utf8');

    check('styles.css renders seamless stage-head in settings mode and hides redundant workViewTitle', () => {
      assert.ok(css.includes('.stage[data-workspace-view="settings"] .stage-head'));
      assert.ok(css.includes('.stage[data-workspace-view="settings"] #workViewTitle'));
    });

    check('styles.css suppresses redundant occluding settings-titlebar', () => {
      assert.ok(css.includes('.settings-titlebar {\n  display: none !important;\n}') || css.includes('.settings-titlebar{display:none!important}'));
    });

    check('settings pages maintain visible 30px page-level headings in the DOM', () => {
      // 1. Overview heading
      window.document.querySelector('#navGlobalMore').click();
      const overview = window.document.querySelector('.settings-surface');
      assert.ok(overview, 'settings-surface must be present');
      const overviewH2 = overview.querySelector('h2');
      assert.ok(overviewH2, 'Overview h2 must exist');
      assert.equal(overviewH2.textContent, '设置');
      assert.equal(overviewH2.hidden, false);

      // 2. Appearance heading
      let appCard = null;
      window.openAppearance({ present: (build) => { appCard = window.document.createElement('div'); build(appCard, () => {}); } });
      const appH3 = appCard.querySelector('h3');
      assert.ok(appH3, 'Appearance page h3 must exist');
      assert.equal(appH3.textContent, '外观与主题');
      assert.equal(appH3.hidden, false);

      // 3. Providers heading
      let provCard = null;
      window.openProvidersPanel({ present: (build) => { provCard = window.document.createElement('div'); build(provCard, () => {}); } });
      const provH3 = provCard.querySelector('.settings-page-title');
      assert.ok(provH3, 'Providers page title must exist');
      assert.equal(provH3.textContent, '模型配置');
      assert.equal(provH3.hidden, false);

      // 4. App Updates heading
      let updateCard = null;
      window.openAppUpdates({ present: (build) => { updateCard = window.document.createElement('div'); build(updateCard, () => {}); } });
      const updateH3 = updateCard.querySelector('h3');
      assert.ok(updateH3, 'App updates h3 must exist');
      assert.equal(updateH3.textContent, '应用与更新');
      assert.equal(updateH3.hidden, false);
    });
  }

  console.log(`\nAll ${checks} settings acceptance checks passed successfully!`);
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
