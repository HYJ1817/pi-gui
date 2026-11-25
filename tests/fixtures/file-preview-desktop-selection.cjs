'use strict';
// Real production CSS and trusted input. Selection is not a persistent focus ring.
function inspectElement(selector) {
  const element = document.querySelector(selector);
  if (!element) return null;
  const style = getComputedStyle(element);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const ancestors = [];
  for (let current = element; current; current = current.parentElement) ancestors.unshift(current);
  context.fillStyle = '#fff'; context.fillRect(0, 0, 1, 1);
  for (const current of ancestors) {
    context.fillStyle = getComputedStyle(current).backgroundColor; context.fillRect(0, 0, 1, 1);
  }
  const background = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  const sample = color => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = `rgb(${background.join(',')})`; context.fillRect(0, 0, 1, 1);
    context.fillStyle = color; context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };
  const luminance = rgb => rgb.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const contrast = color => {
    const values = [luminance(background), luminance(sample(color))].sort((a, b) => b - a);
    return (values[0] + .05) / (values[1] + .05);
  };
  const rect = element.getBoundingClientRect();
  return {
    shadow: style.boxShadow, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth,
    outlineColor: style.outlineColor, outlineOffset: style.outlineOffset,
    borderWidth: style.borderWidth, borderColor: style.borderColor,
    background: style.backgroundColor, color: style.color,
    weight: getComputedStyle(element.querySelector('.files-entry-name,.files-tab-label') || element).fontWeight,
    selectionWeight: style.getPropertyValue('--font-weight-semibold').trim(),
    selected: element.getAttribute('aria-selected') || element.getAttribute('aria-pressed'),
    focused: element === document.activeElement, focusVisible: element.matches(':focus-visible'),
    textContrast: contrast(style.color), focusContrast: contrast(style.outlineColor),
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}
module.exports = async function (t, group) {
  const { check, read, until, shot, click, key, open, sleep, win, notes } = t;
  const inspect = selector => read(`(${inspectElement.toString()})(${JSON.stringify(selector)})`);
  const tree = '.files-entry[data-file-path="guide.md"]';
  const tab = '.files-tab[data-file-tab="guide.md"] .files-tab-select';
  const tabShell = '.files-tab[data-file-tab="guide.md"]';
  const noFrame = state => state && state.shadow === 'none' && (state.outlineStyle === 'none' || state.outlineWidth === '0px');
  const keyboardRing = state => state?.focused && state.focusVisible && state.outlineStyle === 'solid' && state.outlineWidth === '2px' && state.focusContrast >= 3;
  const selectedMarker = state => state?.selected === 'true' && Number(state.selectionWeight) > 0 && Number(state.weight) === Number(state.selectionWeight);
  let restored = false;
  await group('selection-states', async () => {
    try {
      await read("import('/files-panel.js').then(m=>{m.openFilesPanel();return true})");
      await until(() => read("!!document.querySelector('#workPanelMaximize')"), 'selection-panel');
      if (!await read("(document.querySelector('#rightPane').dataset.maximized==='true')")) await click('#workPanelMaximize');
      await until(() => read(`!!document.querySelector(${JSON.stringify(tree)})`), 'selection-tree');
      await open('long-lines.js', '.fp-text-source');
      await open('guide.md', '.fp-markdown-body');
      for (const width of [1320, 700]) for (const mode of ['dark', 'light']) {
        const id = `${width}-${mode}`;
        win.setContentSize(width, width === 700 ? 600 : 820);
        await read(`import('/theme.js').then(m=>m.setThemePreference(${JSON.stringify(mode)}))`);
        await sleep(180);
        if (await read("document.querySelector('.files-sidebar').hidden")) await click('.files-tree-toggle');
        await click(tree);
        await until(() => read("!!document.querySelector('.fp-markdown-body')"), 'selection-markdown');
        // A narrow-tree selection deliberately closes the overlay. Reopen through
        // its real trigger before measuring the visible selected row.
        if (await read("document.querySelector('.files-sidebar').hidden")) await click('.files-tree-toggle');
        const pointerTree = await inspect(tree);
        check('pointer tree selection has no decorative frame ' + id, noFrame(pointerTree) && !pointerTree.focusVisible && pointerTree.selected === 'true', pointerTree);
        if (await read("document.querySelector('.files-narrow.files-tree-open')!==null")) await key('Escape');
        await click(tab);
        const pointerTab = await inspect(tab), selectedTab = await inspect(tabShell);
        check('pointer tab selection has no decorative frame ' + id, noFrame(pointerTab) && noFrame(selectedTab) && !pointerTab.focusVisible && pointerTab.selected === 'true', { pointerTab, selectedTab });
        check('selected labels retain readable text ' + id, pointerTree.textContrast >= 4.5 && pointerTab.textContrast >= 4.5, { tree: pointerTree.textContrast, tab: pointerTab.textContrast });
        // A same-tab activation remounts the async reader. Wait for document
        // content, not the empty article shell, before clicking that content.
        await until(() => read("!!document.querySelector('.fp-markdown-body h1')"), 'selection-content-heading');
        // Clicking content must not be required to hide a selection decoration.
        await click('.fp-markdown-body h1');
        const idleTree = await inspect(tree), idleTab = await inspect(tabShell);
        check('blurred selections remain frame-free ' + id, noFrame(idleTree) && noFrame(idleTab), { idleTree, idleTab });
        check('selected tree retains semibold marker ' + id, selectedMarker(pointerTree) && selectedMarker(idleTree), { pointerTree, idleTree });
        check('selected tab retains semibold marker ' + id, selectedMarker(pointerTab) && selectedMarker(idleTab), { pointerTab, idleTab });
        await shot('selection-files-' + id);
        // Real Tab/Shift+Tab and arrows, never element.focus() or forced CSS states.
        await click(tab); await key('Tab'); await key('Tab', ['shift']);
        const keyboardTab = await inspect(tab);
        check('keyboard tab retains one visible focus indicator ' + id, keyboardRing(keyboardTab), keyboardTab);
        await key('Left');
        check('keyboard arrows activate and focus another file tab ' + id, await read("document.activeElement.matches('.files-tab-select[aria-selected=true]')&&document.activeElement.matches(':focus-visible')"));
        await key('Right');
        await until(() => read("!!document.querySelector('.fp-markdown-body')"), 'selection-keyboard-markdown');
        await shot('selection-keyboard-' + id);
        if (await read("document.querySelector('.files-sidebar').hidden")) await click('.files-tree-toggle');
        else await click(tree);
        await key('Down');
        const keyboardTree = await inspect('.files-entry:focus');
        check('keyboard tree retains one visible focus indicator ' + id, keyboardRing(keyboardTree), keyboardTree);
        await key('Up');
        check('tree keyboard focus returns without changing selection ' + id, await read(`document.activeElement.matches(${JSON.stringify(tree)})&&document.activeElement.getAttribute('aria-selected')==='true'`));
        if (await read("document.querySelector('.files-narrow.files-tree-open')!==null")) await key('Escape');
        await open('archive.zip', '.fp-archive');
        // Opening an existing tab now restores expansion. Do not blindly toggle
        // a folder that the preceding theme/viewport iteration already opened.
        if (!await read("document.querySelector('.fp-archive-folder-name[title=\"a/\"]')?.parentElement.open")) await click('.fp-archive-folder-name[title="a/"]');
        await until(() => read("document.querySelector('.fp-archive-folder-name[title=\"a/\"]')?.parentElement.open&&!!document.querySelector('[data-entry=\"a/same.txt\"]')"), 'selection-zip-member');
        await click('[data-entry="a/same.txt"]');
        const zip = await inspect('.fp-archive-entry[aria-pressed=true]');
        check('ZIP pointer selection has no decorative frame ' + id, noFrame(zip) && !zip.focusVisible && zip.textContrast >= 4.5, zip);
        check('selected ZIP member retains semibold marker ' + id, selectedMarker(zip), zip);
        await shot('selection-zip-' + id);
        await key('Tab'); await key('Tab', ['shift']);
        const zipFocus = await inspect('.fp-archive-entry[aria-pressed=true]');
        check('ZIP keyboard focus remains visible ' + id, keyboardRing(zipFocus), zipFocus);
        await open('workbook.xlsx', '.office-grid-viewport');
        await until(() => read("document.querySelectorAll('.office-sheet-tabs [role=tab]').length===3"), 'selection-sheets', 22000);
        await click('.office-sheet-tabs [role=tab]');
        const sheet = await inspect('.office-sheet-tabs [aria-selected=true]');
        check('worksheet pointer selection has no decorative frame ' + id, noFrame(sheet) && !sheet.focusVisible && sheet.textContrast >= 4.5, sheet);
        check('selected worksheet retains semibold marker ' + id, selectedMarker(sheet), sheet);
        await shot('selection-sheet-' + id);
        await key('Right');
        const sheetFocus = await inspect('.office-sheet-tabs [aria-selected=true]');
        check('worksheet keyboard selection retains focus indicator ' + id, keyboardRing(sheetFocus), sheetFocus);
        notes.push({ kind: 'selection-state-matrix', id, pointerTree, pointerTab, selectedTab, idleTree, idleTab, keyboardTab, keyboardTree, zip, zipFocus, sheet, sheetFocus });
      }
    } finally {
      // Restore even when an interaction throws. Only continue other scenarios
      // after positively observing their baseline; otherwise abort the suite.
      win.setContentSize(1320, 820);
      await read("import('/theme.js').then(m=>m.setThemePreference('dark'))");
      if (await read("document.querySelectorAll('.files-tab').length>0")) {
        await click('.files-tabs-menu'); await key('End'); await key('Return');
      }
      await until(() => read("document.querySelectorAll('.files-tab').length===0"), 'selection-close-tabs');
      if (await read("document.querySelector('#rightPane')?.dataset.maximized==='true'")) await click('#workPanelMaximize');
      await until(() => read("!!document.querySelector('.files-surface')&&!(document.querySelector('#rightPane').dataset.maximized==='true')&&document.documentElement.dataset.theme==='dark'"), 'selection-restored-baseline');
      restored = true;
    }
  });
  if (!restored) throw Object.assign(new Error('selection baseline restoration failed'), { testLabel: 'selection-restore' });
};
