'use strict';
// Control-flow and assertion fault injection only, NOT rendering evidence.
// The real desktop runner separately measures production CSS with trusted input.
const assert = require('node:assert/strict');
const selection = require('./file-preview-desktop-selection.cjs');

function probe({ failWorksheet = false, failRestore = false, weight = '600', selected = true } = {}) {
  const state = { width: 1320, height: 820, theme: 'dark', maximized: false, sheets: 0, tabs: new Set(), menu: false };
  const errors = [], rows = [];
  const injected = Object.assign(new Error('injected worksheet failure'), { testLabel: 'injected-worksheet' });
  const tools = {
    notes: [],
    win: { setContentSize(width, height) { Object.assign(state, { width, height }); } },
    check(name, passed) { rows.push({ name, passed: !!passed }); return !!passed; },
    async read(code) {
      if (code.startsWith('(function inspectElement(')) return {
        shadow: 'none', outlineStyle: 'none', outlineWidth: '0px',
        focused: false, focusVisible: false, textContrast: 12, focusContrast: 12,
        weight, selectionWeight: '600', selected: selected ? 'true' : 'false',
      };
      if (code.includes('setThemePreference')) {
        const theme = code.match(/setThemePreference\((["'])(dark|light)\1\)/)[2];
        if (failRestore && state.sheets === 4 && theme === 'dark') throw Object.assign(new Error('injected restore failure'), { testLabel: 'injected-restore' });
        state.theme = theme;
      }
      if (code.includes('document.documentElement.dataset.theme')) return state.theme === 'dark' && !state.maximized;
      if (code.includes(".dataset.maximized==='true'")) return state.maximized;
      if (code.includes("document.querySelectorAll('.files-tab').length")) return code.includes('>0') ? state.tabs.size > 0 : state.tabs.size === 0;
      return true;
    },
    async until(action, label) { assert.ok(await action(), label); },
    async shot() {},
    async sleep() {},
    async click(selector) {
      if (selector === '#workPanelMaximize') state.maximized = !state.maximized;
      if (selector === '.files-tabs-menu') state.menu = true;
    },
    async key(key) {
      if (key === 'Return' && state.menu) { state.tabs.clear(); state.menu = false; }
    },
    async open(name) {
      state.tabs.add(name);
      if (name === 'workbook.xlsx' && ++state.sheets === 4 && failWorksheet) throw injected;
    },
  };
  // Match the desktop group's catch-and-continue behavior, so missing cleanup
  // cannot be hidden by an enclosing assert.rejects or a different test runner.
  const group = async (_name, action) => { try { await action(); } catch (error) { errors.push(error); } };
  return { state, errors, rows, injected, run: () => selection(tools, group) };
}
function assertRestored(state) {
  assert.deepEqual([state.width, state.height, state.theme, state.maximized, state.tabs.size], [1320, 820, 'dark', false, 0]);
}
const markers = rows => rows.filter(row => /selected (tree|tab|ZIP member|worksheet) retains semibold marker/.test(row.name));

module.exports = async function verifySelectionFixture(check) {
  const normal = probe(); await normal.run();
  check('selection fixture restores the next scenario baseline on success', () => {
    assertRestored(normal.state); assert.equal(normal.errors.length, 0);
  });
  const failed = probe({ failWorksheet: true }); await failed.run();
  check('selection fixture restores dimensions theme tabs and maximize after an interaction throws', () => assertRestored(failed.state));
  check('selection fixture preserves the original interaction failure after recovery', () => assert.deepEqual(failed.errors, [failed.injected]));
  const brokenRestore = probe({ failWorksheet: true, failRestore: true });
  let rejection;
  try { await brokenRestore.run(); } catch (error) { rejection = error; }
  check('selection fixture aborts dependent scenarios if baseline restoration fails', () => {
    assert.equal(rejection?.testLabel, 'selection-restore');
    assert.equal(brokenRestore.errors.length, 1);
    assert.equal(brokenRestore.errors[0].testLabel, 'injected-restore');
  });
  check('selection matrix positively checks all four replacement markers in all four configurations', () => {
    assert.equal(markers(normal.rows).length, 16);
    assert.ok(markers(normal.rows).every(row => row.passed));
  });
  const noWeight = probe({ weight: '500' }); await noWeight.run();
  check('selection marker checks fail when semibold styling is missing despite valid ARIA and contrast', () => {
    assert.equal(markers(noWeight.rows).length, 16);
    assert.ok(markers(noWeight.rows).every(row => !row.passed));
  });
  const noAria = probe({ selected: false }); await noAria.run();
  check('selection marker checks require actual selected ARIA state as well as semibold styling', () => {
    assert.equal(markers(noAria.rows).length, 16);
    assert.ok(markers(noAria.rows).every(row => !row.passed));
  });
};
