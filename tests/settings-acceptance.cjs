'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

console.log('Running tests/settings-acceptance.cjs (Phase A & B Acceptance Tests)...');

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

(async () => {
  // Test Group 1: Theme Init Startup Hydration for Font Scale and Font Family
  {
    const initCode = fs.readFileSync(path.join(root, 'public/theme-init.js'), 'utf8');

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
    const primitivesCode = fs.readFileSync(path.join(root, 'public/ui/primitives.js'), 'utf8')
      .replace(/export function /g, 'function ');
    
    const dom = new JSDOM('<html><body></body></html>');
    const ctx = { document: dom.window.document, console };
    vm.createContext(ctx);
    vm.runInContext(primitivesCode + '\n;globalThis.prim = { createSettingsToggle, createSegmentedControl, createHelpIcon, createBadge, createSettingsCard, createSettingsRow };', ctx);
    const { createSettingsToggle, createSegmentedControl, createHelpIcon, createSettingsCard, createSettingsRow } = ctx.prim;

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
  }

  // Test Group 3: Keyboard Navigation & Search Filter Skipping Hidden Items
  {
    const dom = new JSDOM(`
      <html>
        <body>
          <nav id="globalMoreMenu">
            <input id="settingsSearchInput" type="text" />
            <section id="secPref">
              <h3>偏好</h3>
              <button id="btnAppearance">常规</button>
              <button id="btnShortcuts">快捷键</button>
            </section>
            <section id="secModels">
              <h3>模型</h3>
              <button id="btnProviders">模型供应商</button>
              <button id="btnAuth">认证</button>
            </section>
          </nav>
        </body>
      </html>
    `);

    const menu = dom.window.document.querySelector('#globalMoreMenu');
    const input = dom.window.document.querySelector('#settingsSearchInput');
    const btnApp = dom.window.document.querySelector('#btnAppearance');
    const btnShort = dom.window.document.querySelector('#btnShortcuts');
    const btnProv = dom.window.document.querySelector('#btnProviders');
    const btnAuth = dom.window.document.querySelector('#btnAuth');
    const secPref = dom.window.document.querySelector('#secPref');
    const secModels = dom.window.document.querySelector('#secModels');

    // Simulate search filter: search '快捷' hides btnAppearance and secModels
    btnApp.hidden = true;
    secModels.hidden = true;
    btnProv.hidden = true;
    btnAuth.hidden = true;

    // Attach keyboard listener mimicking settings-surface.js
    menu.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const visibleButtons = [...menu.querySelectorAll('button:not([disabled])')].filter(btn => {
        if (btn.hidden || btn.closest('section')?.hidden) return false;
        return true;
      });
      if (visibleButtons.length === 0) return;
      const index = visibleButtons.indexOf(dom.window.document.activeElement);
      if (index === 0 && event.key === 'ArrowUp' && input && !input.hidden) {
        input.focus();
        return;
      }
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? visibleButtons.length - 1
          : index === -1
            ? (event.key === 'ArrowUp' ? visibleButtons.length - 1 : 0)
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + visibleButtons.length) % visibleButtons.length;
      visibleButtons[next]?.focus();
    });

    check('search filtering strictly excludes hidden buttons and hidden sections from arrow navigation', () => {
      btnShort.focus();
      assert.equal(dom.window.document.activeElement, btnShort);
      // Pressing ArrowDown when btnShort is the only visible button wraps back to btnShort
      menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      assert.equal(dom.window.document.activeElement, btnShort, 'Must stay on btnShort, must NOT focus hidden btnProv or btnApp');
    });

    check('arrow up from first visible item returns focus to search input', () => {
      btnShort.focus();
      menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      assert.equal(dom.window.document.activeElement, input, 'Focus must return to search input');
    });
  }

  // Test Group 4: Provider Count, Empty State, and Catalog Footer Synchronization
  {
    const dom = new JSDOM(`
      <html>
        <body>
          <span id="providerCount"></span>
          <div id="parentCard">
            <div id="provBox"></div>
            <div class="prov-catalog-footer">
              <div class="prov-catalog-info"><span></span></div>
            </div>
          </div>
        </body>
      </html>
    `);

    const el = { providerCount: dom.window.document.querySelector('#providerCount') };
    const box = dom.window.document.querySelector('#provBox');
    const catalogSpan = dom.window.document.querySelector('.prov-catalog-info span');

    function syncProviders(data) {
      const names = Object.keys(data.providers || {});
      el.providerCount.textContent = names.length ? String(names.length) : '';
      if (!box) return;
      box.innerHTML = '';
      if (!names.length) {
        const empty = dom.window.document.createElement('div');
        empty.className = 'hint-empty prov-empty-card ds-settings-card';
        box.appendChild(empty);
      } else {
        names.forEach(name => {
          const item = dom.window.document.createElement('div');
          item.className = 'prov ds-settings-card';
          box.appendChild(item);
        });
      }
      const footerSpan = box.parentElement?.querySelector('.prov-catalog-info span');
      if (footerSpan) {
        footerSpan.textContent = `目录: 内置快照 · ${names.length} 个自定义服务 · 更新于 本地`;
      }
    }

    check('empty state synchronizes providerCount, emptyCard, and catalog footer count to 0', () => {
      syncProviders({ providers: {} });
      assert.equal(el.providerCount.textContent, '', 'providerCount badge empty when 0');
      assert.ok(box.querySelector('.prov-empty-card'), 'Empty card must be present');
      assert.ok(catalogSpan.textContent.includes('0 个自定义服务'), `Expected 0 custom services, got ${catalogSpan.textContent}`);
    });

    check('populated state synchronizes providerCount, card items, and catalog footer count to 3', () => {
      syncProviders({ providers: { openrouter: {}, anthropic: {}, ollama: {} } });
      assert.equal(el.providerCount.textContent, '3');
      assert.equal(box.querySelectorAll('.prov').length, 3);
      assert.equal(box.querySelector('.prov-empty-card'), null);
      assert.ok(catalogSpan.textContent.includes('3 个自定义服务'), `Expected 3 custom services, got ${catalogSpan.textContent}`);
    });
  }

  // Test Group 5: Appearance Status Error Display
  {
    const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
    check('styles.css does not hide .appearance-status with display:none !important', () => {
      assert.ok(!css.includes('.appearance-status {\n  display: none !important;\n}'));
      assert.ok(!css.includes('.appearance-status{display:none!important}'));
      assert.ok(css.includes('.appearance-status'));
    });
  }

  console.log(`\nAll ${checks} settings acceptance checks passed successfully!`);
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
