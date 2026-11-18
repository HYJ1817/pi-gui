'use strict';
/* Appearance font/theme picker, persistence and font-enumeration contracts. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');

const root = path.resolve(__dirname, '..');
const pub = path.join(root, 'public');
let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}
async function checkAsync(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

function moduleDom(entry, html = '<!doctype html><html><body></body></html>', setup) {
  const dom = new JSDOM(html, { url: 'http://fixture/', runScripts: 'outside-only', pretendToBeVisual: true });
  setup?.(dom.window);
  dom.window.eval(bundle(path.join(pub, entry)).code);
  return dom;
}

function paint(w) {
  return new Promise((resolve) => w.setTimeout(resolve, 40));
}

/* jsdom has no layout: give an anchor a plausible rect so the portaled menu
 * does not treat it as scrolled out of the viewport and immediately close. */
function stubRect(element) {
  element.getBoundingClientRect = () => ({
    x: 100, y: 100, top: 100, bottom: 132, left: 100, right: 320, width: 220, height: 32, toJSON() {}
  });
  return element;
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    failKeys: new Set(),
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) {
      if (this.failKeys.has(key)) throw new Error('storage denied');
      map.set(key, String(value));
    },
    removeItem(key) { map.delete(key); }
  };
}

(async () => {
  // 1. Windows enumeration, normalization and failure handling -----------------
  {
    const fonts = require(path.join(root, 'electron/system-fonts.cjs'));
    check('font parser keeps CJK names, deduplicates and removes hidden/system entries', () => {
      const parsed = fonts.parseFontFamilies([
        'Microsoft YaHei',
        '微软雅黑',
        'Consolas',
        'consolas',
        '.Apple Color Emoji',
        '@font-face',
        '   ',
        '\u0000Bad\u0007Name',
        'Segoe UI'
      ].join('\r\n'));
      assert.ok(parsed.includes('微软雅黑'), 'CJK family must survive');
      assert.ok(parsed.includes('Microsoft YaHei'));
      assert.ok(parsed.includes('Consolas'));
      assert.ok(parsed.includes('Segoe UI'));
      assert.ok(!parsed.some((name) => name.startsWith('.')), 'hidden family must be filtered');
      assert.ok(!parsed.includes('@font-face'));
      assert.equal(parsed.filter((name) => name.toLowerCase() === 'consolas').length, 1);
      assert.ok(parsed.every((name) => !/[\u0000-\u001f\u007f]/.test(name)));
    });

    check('font parser bounds the output and strips bidi controls', () => {
      const many = Array.from({ length: fonts.MAX_FONTS + 50 }, (_, index) => `Family ${index}`).join('\n');
      const parsed = fonts.parseFontFamilies(`\u202eFont A\u2066\n${many}`);
      assert.ok(parsed.includes('Font A'));
      assert.ok(parsed.length <= fonts.MAX_FONTS);
    });

    await checkAsync('Windows enumeration uses fixed PowerShell arguments, timeout and output cap', async () => {
      let captured = null;
      const list = await fonts.enumerateWindowsFonts({
        execFileImpl: (command, args, options, callback) => {
          captured = { command, args, options };
          callback(null, 'Cascadia Code\n微软雅黑\n');
        }
      });
      assert.equal(captured.command, 'powershell.exe');
      assert.deepEqual(captured.args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
      assert.match(captured.args.at(-1), /SystemFontFamilies/);
      assert.ok(captured.options.timeout > 0);
      assert.ok(captured.options.maxBuffer > 0);
      assert.equal(captured.options.windowsHide, true);
      assert.ok(list.includes('Cascadia Code'));
      assert.ok(list.includes('微软雅黑'));
    });

    await checkAsync('enumeration failure is reported as a failed state, not an empty success', async () => {
      const enumerator = fonts.createFontEnumerator({
        platform: 'win32',
        execFileImpl: (_command, _args, _options, callback) => callback(new Error('powershell unavailable'))
      });
      assert.equal(await enumerator.list(), null);
    });

    await checkAsync('successful enumeration is cached; failures retry after their shorter TTL', async () => {
      let calls = 0;
      let now = 0;
      const ok = fonts.createFontEnumerator({
        platform: 'win32',
        now: () => now,
        execFileImpl: (_command, _args, _options, callback) => { calls += 1; callback(null, 'Arial\n'); }
      });
      assert.deepEqual(await ok.list(), ['Arial']);
      assert.deepEqual(await ok.list(), ['Arial']);
      assert.equal(calls, 1);
      now += 6 * 60 * 1000;
      await ok.list();
      assert.equal(calls, 2);

      let failures = 0;
      const failed = fonts.createFontEnumerator({
        platform: 'win32',
        now: () => now,
        execFileImpl: (_command, _args, _options, callback) => { failures += 1; callback(new Error('nope')); }
      });
      assert.equal(await failed.list(), null);
      assert.equal(await failed.list(), null);
      assert.equal(failures, 1, 'failure result should be cached for the short TTL');
      now += 31 * 1000;
      assert.equal(await failed.list(), null);
      assert.equal(failures, 2);
    });

    await checkAsync('font IPC refuses untrusted senders and ignores extra arguments', async () => {
      const { EventEmitter } = require('node:events');
      const ipc = new EventEmitter();
      const handlers = new Map();
      ipc.handle = (channel, fn) => handlers.set(channel, fn);
      ipc.removeHandler = (channel) => handlers.delete(channel);
      const frame = { url: 'http://127.0.0.1:18741/' };
      const wc = { mainFrame: frame };
      const win = { webContents: wc, isDestroyed: () => false };
      const service = fonts.createSystemFontIpc({
        ipcMain: ipc,
        getWindow: () => win,
        origin: 'http://127.0.0.1:18741',
        enumerator: { list: async () => ['Arial', '微软雅黑'] }
      });
      service.register();
      const handler = handlers.get('pi-gui:fonts-list');
      assert.ok(handler);
      const trusted = { sender: wc, senderFrame: frame };
      assert.deepEqual(await handler(trusted, '../../evil.ps1'), { ok: true, fonts: ['Arial', '微软雅黑'] });
      assert.deepEqual(await handler({ sender: {}, senderFrame: frame }), { ok: false, code: 'forbidden' });
      assert.deepEqual(await handler({ sender: wc, senderFrame: null }), { ok: false, code: 'forbidden' });
      frame.url = 'http://127.0.0.1:18741.evil.test/';
      assert.deepEqual(await handler(trusted), { ok: false, code: 'forbidden' });
      frame.url = 'http://127.0.0.1:18741/';
      service.dispose();
      assert.equal(handlers.has('pi-gui:fonts-list'), false);
    });
  }

  // 2. Renderer font model ----------------------------------------------------
  {
    const dom = moduleDom('fonts.js');
    const w = dom.window;
    check('system stacks append a platform CJK fallback', () => {
      const stack = w.systemStackForFamily('Consolas');
      assert.match(stack, /'Consolas'/);
      assert.match(stack, /Microsoft YaHei/);
    });
    check('font options keep system default first and an uninstalled selection visible', () => {
      const selected = w.normalizeFontValue('"Gone Font"');
      const options = w.buildFontOptions(['Consolas', '微软雅黑'], selected);
      assert.equal(options[0].group, 'default');
      assert.equal(options[0].value, '');
      assert.equal(options[1].group, 'custom');
      assert.equal(options[1].label, 'Gone Font');
      assert.ok(options.some((option) => option.group === 'system' && option.label === '微软雅黑'));
      assert.ok(options.some((option) => option.group === 'builtin' && option.value.includes('monospace')));
      const filtered = w.filterFontOptions(options, '雅黑');
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].label, '微软雅黑');
    });
    check('legacy v1 tokens migrate to real stacks and v2 wins after migration', () => {
      const storage = memoryStorage({ 'pi-gui.font-family.v1': 'mono' });
      const first = w.readFontPreference(storage);
      assert.equal(first.migrated, true);
      assert.match(first.value, /monospace/);
      w.writeFontPreference(first.value, storage);
      assert.equal(storage.getItem('pi-gui.font-family.v1'), null);
      const second = w.readFontPreference(storage);
      assert.equal(second.source, 'v2');
      assert.equal(second.migrated, false);
      assert.equal(second.value, first.value);
      const sans = w.readFontPreference(memoryStorage({ 'pi-gui.font-family.v1': 'sans' }));
      assert.match(sans.value, /Segoe UI/);
      assert.equal(w.readFontPreference(memoryStorage({ 'pi-gui.font-family.v1': 'system' })).value, '');
      assert.equal(w.readFontPreference(memoryStorage({})).value, '');
    });
    check('v2 empty string means the built-in stack and is not replaced by stale v1', () => {
      const value = w.readFontPreference(memoryStorage({
        'pi-gui.font-family.v2': '',
        'pi-gui.font-family.v1': 'mono'
      }));
      assert.equal(value.value, '');
      assert.equal(value.source, 'v2');
    });
    check('applying a font changes only sans/UI variables and empty clears them', () => {
      const rootEl = w.document.documentElement;
      w.applyFontPreference('"Consolas", "Microsoft YaHei", sans-serif', rootEl);
      assert.match(rootEl.style.getPropertyValue('--font-sans'), /Consolas/);
      assert.match(rootEl.style.getPropertyValue('--ui-font-sans'), /Consolas/);
      assert.equal(rootEl.style.getPropertyValue('--font-mono'), '');
      assert.equal(rootEl.style.getPropertyValue('--ui-font-mono'), '');
      w.applyFontPreference('', rootEl);
      assert.equal(rootEl.style.getPropertyValue('--font-sans'), '');
      assert.equal(rootEl.style.getPropertyValue('--ui-font-sans'), '');
    });
    check('font storage failure propagates so the page can restore the old choice', () => {
      const storage = memoryStorage();
      storage.failKeys.add('pi-gui.font-family.v2');
      assert.throws(() => w.writeFontPreference('"Arial"', storage), /storage denied/);
    });
    check('font scale resolves to the legal 80-150/5 range and 100% is neutral', () => {
      assert.equal(w.resolveFontScale(100), 100);
      assert.equal(w.resolveFontScale(null), 100);
      assert.equal(w.resolveFontScale(''), 100);
      assert.equal(w.resolveFontScale(127), 125);
      assert.equal(w.resolveFontScale(10), 80);
      assert.equal(w.resolveFontScale(999), 150);
      assert.equal(w.readFontScale(memoryStorage()), 100, 'missing preference must stay at 100%');
      assert.equal(w.readFontScale(memoryStorage({ 'pi-gui.font-scale.v1': '' })), 100);
      assert.equal(w.readFontScale(memoryStorage({ 'pi-gui.font-scale.v1': 'invalid' })), 100);
      assert.equal(w.readFontScale(memoryStorage({ 'pi-gui.font-scale.v1': '127' })), 125);
      const rootEl = w.document.documentElement;
      assert.equal(w.applyFontScale(100, rootEl), 100);
      assert.equal(rootEl.style.getPropertyValue('--font-scale'), '1.00');
    });
    await checkAsync('web fallback never claims local-font detection', async () => {
      w.resetSystemFontsCache();
      const result = await w.loadSystemFonts({ bridge: null });
      assert.equal(result.status, 'unavailable');
      assert.equal(result.fonts.length, 0);
    });
    dom.window.close();
  }

  // 3. Pre-paint restoration --------------------------------------------------
  {
    const init = fs.readFileSync(path.join(pub, 'theme-init.js'), 'utf8');
    const evaluate = (values) => {
      const dom = new JSDOM('<html><head></head><body></body></html>', { url: 'http://fixture', runScripts: 'outside-only' });
      dom.window.matchMedia = () => ({ matches: false });
      for (const [key, value] of Object.entries(values)) dom.window.localStorage.setItem(key, value);
      dom.window.eval(init);
      return dom;
    };
    check('pre-paint v2 stack keeps CJK fallback and applies both sans variables', () => {
      const dom = evaluate({ 'pi-gui.font-family.v2': '"Consolas", sans-serif' });
      const font = dom.window.document.documentElement.style.getPropertyValue('--font-sans');
      assert.match(font, /Consolas/);
      assert.match(font, /Microsoft YaHei/);
      assert.equal(dom.window.document.documentElement.style.getPropertyValue('--ui-font-sans'), font);
      dom.window.close();
    });
    check('pre-paint legacy mono/sans still restore before first paint', () => {
      for (const [token, expected] of [['mono', /monospace/], ['sans', /Segoe UI/]]) {
        const dom = evaluate({ 'pi-gui.font-family.v1': token });
        assert.match(dom.window.document.documentElement.style.getPropertyValue('--font-sans'), expected);
        dom.window.close();
      }
    });
    check('pre-paint clamps an out-of-range scale instead of applying it verbatim', () => {
      const high = evaluate({ 'pi-gui.font-scale.v1': '200' });
      assert.equal(high.window.document.documentElement.style.getPropertyValue('--font-scale'), '1.50');
      high.window.close();
      const low = evaluate({ 'pi-gui.font-scale.v1': '60' });
      assert.equal(low.window.document.documentElement.style.getPropertyValue('--font-scale'), '0.80');
      low.window.close();
      const stepped = evaluate({ 'pi-gui.font-scale.v1': '127' });
      assert.equal(stepped.window.document.documentElement.style.getPropertyValue('--font-scale'), '1.25');
      stepped.window.close();
    });
  }

  // 4. Virtual list arithmetic ------------------------------------------------
  {
    const dom = moduleDom('ui/font-list.js');
    const w = dom.window;
    const options = [];
    for (let index = 0; index < 100; index += 1) {
      options.push({ value: `v${index}`, label: `Font ${index}`, group: index < 2 ? 'default' : 'system' });
    }
    check('virtual layout inserts group headers and exact offsets', () => {
      const layout = w.buildFontListLayout(options, (group) => (group === 'default' ? 'Default' : 'System'));
      assert.equal(layout.rows[0].kind, 'group');
      assert.equal(layout.rows[1].kind, 'option');
      assert.equal(layout.offsets[0], 0);
      assert.equal(layout.heights[0], w.FONT_GROUP_ROW_HEIGHT);
      assert.equal(layout.heights[1], w.FONT_OPTION_ROW_HEIGHT);
      assert.equal(layout.totalHeight, layout.offsets.at(-1));
      assert.equal(layout.optionRowIndex[0], 1);
      assert.equal(layout.optionRowIndex[1], 2);
      assert.equal(layout.optionRowIndex[2], 4, 'a new group header precedes the option');
    });
    check('visible range only includes the viewport plus overscan', () => {
      const layout = w.buildFontListLayout(options, (group) => group);
      const range = w.visibleRowRange(layout, 320, 320);
      assert.ok(range.start >= 0);
      assert.ok(range.end - range.start < 30);
      assert.ok(range.end <= layout.rows.length);
      const bottom = w.visibleRowRange(layout, layout.totalHeight, 320);
      assert.equal(bottom.end, layout.rows.length);
    });
    dom.window.close();
  }

  // 5. Font picker UI ---------------------------------------------------------
  {
    const fonts = Array.from({ length: 240 }, (_, index) => `Font ${String(index).padStart(3, '0')}`);
    fonts.push('微软雅黑', 'Consolas');
    const dom = moduleDom('ui/font-picker.js');
    const w = dom.window;
    const calls = [];
    const picker = w.createFontPicker({
      selectedValue: '',
      loadFonts: async () => ({ status: 'ok', fonts }),
      onSelect: (value) => { calls.push(value); return true; }
    });
    w.document.body.appendChild(picker.element);
    stubRect(picker.trigger);
    await paint(w);

    await checkAsync('font trigger hugs the current label and opens a searchable menu', async () => {
      assert.equal(picker.trigger.textContent.trim(), '跟随系统');
      picker.trigger.click();
      await paint(w);
      const menu = w.document.querySelector('.pi-anchored-menu');
      assert.ok(menu, 'portaled font menu must exist');
      assert.equal(menu.parentElement, w.document.body);
      assert.equal(menu.querySelector('input').placeholder, '搜索字体…');
      assert.equal(menu.getAttribute('role'), 'dialog');
      assert.equal(w.document.activeElement, menu.querySelector('input'), 'search input keeps focus');
    });

    check('font list windows hundreds of families instead of mounting all rows', () => {
      const menu = w.document.querySelector('.pi-anchored-menu');
      const rendered = menu.querySelectorAll('.settings-font-option');
      assert.ok(rendered.length < 60, `expected a windowed slice, got ${rendered.length}`);
      const viewport = menu.querySelector('.settings-font-viewport');
      assert.ok(Number.parseFloat(viewport.style.height) > 5000, 'full scroll height stays reserved');
      assert.ok(menu.querySelector('.settings-font-group'));
    });

    await checkAsync('search keeps CJK names and narrows the list immediately', async () => {
      const menu = w.document.querySelector('.pi-anchored-menu');
      const input = menu.querySelector('input');
      input.value = '雅黑';
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      const rendered = menu.querySelectorAll('.settings-font-option');
      assert.equal(rendered.length, 1);
      assert.equal(rendered[0].textContent.trim(), '微软雅黑');
      assert.equal(w.document.activeElement, input, 'filtering must not move focus out of search');
      input.value = 'Font 0';
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      const active = menu.querySelector('.settings-font-option.is-active');
      assert.equal(active?.textContent.trim(), 'Font 000', 'filtered results highlight the first match');
      input.value = '';
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
    });

    await checkAsync('mouse selection applies the family and remembers the choice', async () => {
      const menu = w.document.querySelector('.pi-anchored-menu');
      const option = [...menu.querySelectorAll('.settings-font-option')]
        .find((button) => button.textContent.trim() === 'Consolas');
      assert.ok(option, 'Consolas option must be rendered after search reset');
      assert.match(option.style.fontFamily, /Consolas/);
      option.click();
      await paint(w);
      assert.equal(calls.at(-1), w.systemStackForFamily('Consolas'));
      assert.match(picker.trigger.textContent, /Consolas/);
      assert.equal(w.document.querySelector('.pi-anchored-menu'), null);
    });

    await checkAsync('keyboard arrows and Enter select the highlighted family', async () => {
      picker.trigger.click();
      await paint(w);
      const menu = w.document.querySelector('.pi-anchored-menu');
      const input = menu.querySelector('input');
      assert.equal(w.document.activeElement, input);
      input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await paint(w);
      assert.ok(calls.length >= 2);
      assert.notEqual(calls.at(-1), undefined);
      assert.equal(w.document.querySelector('.pi-anchored-menu'), null);
    });

    await checkAsync('IME composition never commits a font while typing a name', async () => {
      picker.trigger.click();
      await paint(w);
      const menu = w.document.querySelector('.pi-anchored-menu');
      const input = menu.querySelector('input');
      const before = calls.length;
      input.dispatchEvent(new w.KeyboardEvent('keydown', {
        key: 'Enter', isComposing: true, bubbles: true, cancelable: true
      }));
      await paint(w);
      assert.equal(calls.length, before, 'composing Enter must not select a font');
      assert.equal(w.document.querySelector('.pi-anchored-menu'), menu);
      input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    await checkAsync('Escape closes the menu and restores trigger focus', async () => {
      picker.trigger.click();
      await paint(w);
      const menu = w.document.querySelector('.pi-anchored-menu');
      const input = menu.querySelector('input');
      assert.ok(picker.trigger.getAttribute('aria-controls'), 'open trigger points at its menu');
      input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert.equal(w.document.querySelector('.pi-anchored-menu'), null);
      assert.equal(w.document.activeElement, picker.trigger);
      assert.equal(picker.trigger.hasAttribute('aria-controls'), false, 'closed trigger must not point at a removed menu');
    });

    await checkAsync('outside click closes without stealing focus', async () => {
      picker.trigger.click();
      await paint(w);
      w.document.body.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
      assert.equal(w.document.querySelector('.pi-anchored-menu'), null);
    });

    await checkAsync('a rejected save leaves the previous family in place', async () => {
      const rejected = w.createFontPicker({
        selectedValue: '',
        loadFonts: async () => ({ status: 'ok', fonts: ['Arial'] }),
        onSelect: () => false
      });
      w.document.body.appendChild(rejected.element);
      stubRect(rejected.trigger);
      await paint(w);
      rejected.trigger.click();
      await paint(w);
      const option = [...w.document.querySelectorAll('.settings-font-option')]
        .find((button) => button.textContent.trim() === 'Arial');
      option.click();
      await paint(w);
      assert.equal(rejected.trigger.textContent.trim(), '跟随系统');
      rejected.destroy();
    });

    await checkAsync('an uninstalled stored family is marked instead of silently rewritten', async () => {
      const custom = w.createFontPicker({
        selectedValue: '"Gone Font"',
        loadFonts: async () => ({ status: 'ok', fonts: ['Arial'] }),
        onSelect: () => true
      });
      w.document.body.appendChild(custom.element);
      stubRect(custom.trigger);
      await paint(w);
      custom.trigger.click();
      await paint(w);
      const option = [...w.document.querySelectorAll('.settings-font-option')]
        .find((button) => button.textContent.includes('Gone Font'));
      assert.ok(option, 'stored uninstalled family must remain selectable');
      assert.match(option.textContent, /未检测到/);
      custom.destroy();
    });

    await checkAsync('unavailable and failed enumeration are explained in the menu', async () => {
      for (const [status, text] of [
        ['unavailable', /网页版无法读取本机已安装字体/],
        ['failed', /读取系统字体失败/]
      ]) {
        const degraded = w.createFontPicker({
          selectedValue: '',
          loadFonts: async () => ({ status, fonts: [] }),
          onSelect: () => true
        });
        w.document.body.appendChild(degraded.element);
        stubRect(degraded.trigger);
        await paint(w);
        degraded.trigger.click();
        await paint(w);
        assert.match(w.document.querySelector('.settings-font-note').textContent, text);
        degraded.destroy();
      }
    });

    await checkAsync('destroy releases an open menu and its listeners', async () => {
      const temp = w.createFontPicker({
        selectedValue: '',
        loadFonts: async () => ({ status: 'ok', fonts: ['Arial'] }),
        onSelect: () => true
      });
      w.document.body.appendChild(temp.element);
      stubRect(temp.trigger);
      await paint(w);
      temp.trigger.click();
      await paint(w);
      assert.ok(w.document.querySelector('.pi-anchored-menu'));
      temp.destroy();
      assert.equal(w.document.querySelector('.pi-anchored-menu'), null);
      assert.equal(temp.element.isConnected, false);
    });

    picker.destroy();
    dom.window.close();
  }

  // 6. Theme picker UI --------------------------------------------------------
  {
    const dom = moduleDom('ui/theme-picker.js');
    const w = dom.window;
    const calls = [];
    const picker = w.createThemePicker({
      value: 'dark',
      onSelect: (value) => { calls.push(value); return true; }
    });
    w.document.body.appendChild(picker.element);
    stubRect(picker.trigger);

    await checkAsync('theme picker is a custom anchored menu, not a native select', async () => {
      assert.equal(w.document.querySelector('select'), null);
      assert.equal(picker.trigger.textContent.trim(), '深色');
      picker.trigger.click();
      await paint(w);
      const menu = w.document.querySelector('.pi-anchored-menu');
      assert.ok(menu);
      assert.equal(menu.parentElement, w.document.body);
      assert.equal(menu.querySelectorAll('[role="option"]').length, 3);
      assert.equal(menu.querySelector('[aria-selected="true"]').textContent.trim(), '深色');
      assert.ok(menu.querySelector('[aria-selected="true"] .settings-theme-check'));
    });

    await checkAsync('theme search filters options and keeps the search input focused', async () => {
      const menu = w.document.querySelector('.pi-anchored-menu');
      const input = menu.querySelector('input');
      const errors = [];
      const onError = (event) => errors.push(event.error || event.message);
      w.addEventListener('error', onError);
      input.value = '浅';
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      w.removeEventListener('error', onError);
      const options = menu.querySelectorAll('[role="option"]');
      assert.equal(options.length, 1);
      assert.equal(options[0].textContent.trim(), '浅色');
      assert.equal(w.document.activeElement, input);
      assert.equal(errors.length, 0, `theme filtering threw: ${errors.map(String).join('; ')}`);
      assert.ok(menu.classList.contains('is-open'));
    });

    await checkAsync('theme Enter selects the highlighted option', async () => {
      const menu = w.document.querySelector('.pi-anchored-menu');
      const input = menu.querySelector('input');
      input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await paint(w);
      assert.equal(calls.at(-1), 'light');
      assert.equal(picker.trigger.textContent.trim(), '浅色');
      assert.equal(w.document.querySelector('.pi-anchored-menu'), null);
    });

    await checkAsync('theme Escape closes and returns focus to the trigger', async () => {
      picker.trigger.click();
      await paint(w);
      const input = w.document.querySelector('.pi-anchored-menu input');
      input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert.equal(w.document.querySelector('.pi-anchored-menu'), null);
      assert.equal(w.document.activeElement, picker.trigger);
    });

    await checkAsync('theme outside click closes the menu', async () => {
      picker.trigger.click();
      await paint(w);
      w.document.body.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
      assert.equal(w.document.querySelector('.pi-anchored-menu'), null);
    });

    await checkAsync('theme rejected save keeps the old trigger label', async () => {
      const rejected = w.createThemePicker({ value: 'dark', onSelect: () => false });
      w.document.body.appendChild(rejected.element);
      stubRect(rejected.trigger);
      rejected.trigger.click();
      await paint(w);
      const option = [...w.document.querySelectorAll('.settings-theme-option')]
        .find((button) => button.textContent.trim() === '浅色');
      option.click();
      await paint(w);
      assert.equal(rejected.trigger.textContent.trim(), '深色');
      rejected.destroy();
    });

    picker.destroy();
    dom.window.close();
  }

  // 7. Appearance page integration -------------------------------------------
  {
    const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
    const dom = moduleDom('appearance.js', html);
    const w = dom.window;
    const storage = memoryStorage();
    let card = null;
    let closed = false;
    let closePage = null;
    w.openAppearance({
      storage,
      fontLoader: async () => ({ status: 'ok', fonts: ['Arial', '微软雅黑', 'Consolas'] }),
      present: (build, dispose) => {
        card = w.document.createElement('section');
        card.className = 'modal-card';
        w.document.body.appendChild(card);
        closePage = () => {
          if (closed) return;
          closed = true;
          card.remove();
          dispose?.();
        };
        build(card, closePage);
      }
    });
    const themeTrigger = card.querySelector('.settings-theme-trigger');
    const fontTrigger = card.querySelector('.settings-font-trigger');
    stubRect(themeTrigger);
    stubRect(fontTrigger);

    check('appearance keeps the existing three-row page without native selects', () => {
      assert.ok(card.querySelector('.appearance-theme-row .settings-theme-trigger'));
      assert.ok(card.querySelector('.appearance-font-row .settings-font-trigger'));
      assert.ok(card.querySelector('.appearance-size-row input[type="range"]'));
      assert.equal(card.querySelectorAll('select').length, 0);
      assert.equal(w.document.activeElement, themeTrigger);
    });

    await checkAsync('font selection persists a full stack, applies it, and clears the legacy key', async () => {
      fontTrigger.click();
      await paint(w);
      const option = [...w.document.querySelectorAll('.settings-font-option')]
        .find((button) => button.textContent.trim() === '微软雅黑');
      option.click();
      await paint(w);
      const saved = storage.getItem('pi-gui.font-family.v2');
      assert.match(saved, /微软雅黑/);
      assert.match(saved, /Microsoft YaHei/);
      assert.equal(storage.getItem('pi-gui.font-family.v1'), null);
      assert.match(w.document.documentElement.style.getPropertyValue('--font-sans'), /微软雅黑/);
      assert.equal(fontTrigger.textContent.trim(), '微软雅黑');
    });

    check('font scale previews on input and writes only on change', () => {
      const slider = card.querySelector('.appearance-size-row input[type="range"]');
      slider.value = '120';
      slider.dispatchEvent(new w.Event('input', { bubbles: true }));
      assert.equal(w.document.documentElement.style.getPropertyValue('--font-scale'), '1.20');
      assert.equal(storage.getItem('pi-gui.font-scale.v1'), null, 'drag must not write on every input');
      slider.dispatchEvent(new w.Event('change', { bubbles: true }));
      assert.equal(storage.getItem('pi-gui.font-scale.v1'), '120');
      assert.equal(w.document.documentElement.style.getPropertyValue('--font-scale'), '1.20');
    });

    check('font scale storage failure restores the committed percentage', () => {
      storage.failKeys.add('pi-gui.font-scale.v1');
      const slider = card.querySelector('.appearance-size-row input[type="range"]');
      slider.value = '130';
      slider.dispatchEvent(new w.Event('input', { bubbles: true }));
      slider.dispatchEvent(new w.Event('change', { bubbles: true }));
      assert.equal(w.document.documentElement.style.getPropertyValue('--font-scale'), '1.20');
      assert.match(card.querySelector('.appearance-status').textContent, /字号未能保存，已恢复原设置/);
      storage.failKeys.delete('pi-gui.font-scale.v1');
    });

    await checkAsync('font storage failure restores the old selection and reports it', async () => {
      storage.failKeys.add('pi-gui.font-family.v2');
      fontTrigger.click();
      await paint(w);
      const option = [...w.document.querySelectorAll('.settings-font-option')]
        .find((button) => button.textContent.trim() === 'Consolas');
      option.click();
      await paint(w);
      assert.equal(fontTrigger.textContent.trim(), '微软雅黑');
      assert.match(w.document.documentElement.style.getPropertyValue('--font-sans'), /微软雅黑/);
      assert.match(card.querySelector('.appearance-status').textContent, /字体未能保存，已恢复原设置/);
      storage.failKeys.delete('pi-gui.font-family.v2');
    });

    check('page disposal removes menus and event subscriptions', () => {
      themeTrigger.click();
      assert.ok(w.document.querySelector('.pi-anchored-menu'));
      closePage();
      assert.equal(w.document.querySelector('.pi-anchored-menu'), null);
      assert.equal(card.isConnected, false);
    });
    dom.window.close();
  }

  // 8. Desktop bridge failure and restart restore ----------------------------
  {
    const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
    const dom = moduleDom('appearance.js', html, (w) => {
      w.piGuiDesktop = {
        theme: {
          snapshot: () => ({ preference: 'dark', resolved: 'dark', revision: 1, persisted: true }),
          set: async () => ({ ok: false }),
          onChange: () => () => {}
        }
      };
    });
    const w = dom.window;
    const storage = memoryStorage({ 'pi-gui.font-family.v2': '"Consolas", "Microsoft YaHei", sans-serif' });
    let card = null;
    w.openAppearance({
      storage,
      fontLoader: async () => ({ status: 'unavailable', fonts: [] }),
      present: (build) => {
        card = w.document.createElement('section');
        w.document.body.appendChild(card);
        build(card, () => {});
      }
    });
    await paint(w);
    await checkAsync('desktop theme rejection restores the saved preference and reports an error', async () => {
      const trigger = card.querySelector('.settings-theme-trigger');
      stubRect(trigger);
      trigger.click();
      await paint(w);
      const option = [...w.document.querySelectorAll('.settings-theme-option')]
        .find((button) => button.textContent.trim() === '浅色');
      option.click();
      await paint(w);
      assert.equal(trigger.textContent.trim(), '深色');
      assert.match(card.querySelector('.appearance-status').textContent, /主题未能保存，请重试/);
      assert.ok(card.querySelector('.appearance-status').classList.contains('is-error'));
    });
    check('a stored font is restored and previewed on the next open', () => {
      assert.match(w.document.documentElement.style.getPropertyValue('--font-sans'), /Consolas/);
      assert.match(card.querySelector('.settings-font-trigger').textContent, /Consolas/);
    });
    dom.window.close();
  }

  // 9. Preload and stylesheet boundaries -------------------------------------
  {
    const preload = fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8');
    for (const fontsEnabled of [false, true]) {
      let bridge;
      const ipc = new (require('node:events').EventEmitter)();
      const calls = [];
      ipc.sendSync = () => ({ preference: 'dark', resolved: 'dark', revision: 0 });
      ipc.invoke = async (channel) => { calls.push(channel); return { ok: true, fonts: [] }; };
      vm.runInNewContext(preload, {
        process: { argv: fontsEnabled ? ['--pi-gui-font-bridge'] : [] },
        require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } } })
      });
      check(`preload exposes only the fixed font channel when opted in (${fontsEnabled})`, async () => {
        assert.equal(Boolean(bridge.fonts), fontsEnabled);
        if (fontsEnabled) {
          await bridge.fonts.list();
          assert.deepEqual(calls, ['pi-gui:fonts-list']);
        }
      });
    }

    const css = fs.readFileSync(path.join(pub, 'styles.css'), 'utf8');
    check('picker menus are fixed layers that cannot be clipped by settings cards', () => {
      assert.match(css, /\.pi-anchored-menu\s*\{[^}]*position:\s*fixed;/s);
      assert.match(css, /\.pi-anchored-menu\.is-open\s*\{/s);
      assert.match(css, /\.settings-font-list\s*\{[^}]*overflow-y:\s*auto;/s);
      assert.match(css, /\.settings-font-list\s*\{[^}]*overflow-x:\s*hidden;/s);
      assert.match(css, /@media\s*\(max-width:\s*900px\)/);
      assert.doesNotMatch(css, /\.settings-font-option\s*\{[^}]*width:\s*100%;/s);
    });
    check('appearance code never rewrites the mono/terminal variables', () => {
      for (const file of ['appearance.js', 'fonts.js', 'ui/font-picker.js']) {
        const source = fs.readFileSync(path.join(pub, file), 'utf8');
        assert.doesNotMatch(source, /setProperty\(\s*['"]--(?:ui-)?font-mono/);
        assert.doesNotMatch(source, /removeProperty\(\s*['"]--(?:ui-)?font-mono/);
      }
      const appearance = fs.readFileSync(path.join(pub, 'appearance.js'), 'utf8');
      assert.doesNotMatch(appearance, /createElement\(['"]select['"]\)/);
    });
  }

  console.log(`\nFont picker: ${checks}/${checks} checks passed.`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
