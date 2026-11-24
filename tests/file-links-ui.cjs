/* 会话内文件链接的 UI 契约（jsdom）。
 *
 * 覆盖：Markdown 识别/不识别、chip 结构、悬停提示、点击开面板、
 * 标签复用、树联动、行号定位、图片/不支持格式、右键菜单、Ctrl+点击、
 * 候选文件名升级、流式未完成路径。所有后端都用注入 transport / fetch 桩，
 * 不读用户项目、不发真实网络请求。 */
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

let checks = 0;
const ok = (name, value) => {
  if (typeof value === 'function') value();
  else assert.ok(value, name);
  checks++;
  console.log('  ok  ' + name);
};
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, label = 'UI state') => {
  for (let i = 0; i < 160; i++) {
    if (await fn()) return;
    await tick(10);
  }
  throw new Error(label + ' timeout');
};

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div><div id="messages"></div><div id="toasts"></div><div id="modal" hidden></div><div id="confirmLayer" hidden></div></body></html>', {
  url: 'http://127.0.0.1/',
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.sessionStorage = dom.window.sessionStorage;
global.CustomEvent = dom.window.CustomEvent;
global.MutationObserver = dom.window.MutationObserver;
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.cancelAnimationFrame = clearTimeout;
global.getComputedStyle = dom.window.getComputedStyle;

function fakeView() {
  let current = true;
  const hooks = [];
  return {
    isCurrent: () => current,
    onDispose(fn) { if (current) hooks.push(fn); },
    dispose() {
      if (!current) return;
      current = false;
      for (const fn of hooks.reverse()) fn();
    },
  };
}

const WIN = 'C:/fixture/project';
const WORKSPACE = { id: 'w1', generation: '1' };
const contentFor = (filePath) => {
  if (filePath === 'src/app.js') return Array.from({ length: 30 }, (_v, i) => `line ${i + 1}`).join('\n');
  if (filePath === 'README.md') return '# README\n';
  if (filePath === 'docs/README.md') return '# Docs\n';
  if (filePath === 'src/nested/deep.ts') return 'export const deep = 1;\n';
  if (filePath === 'binary.bin') return '';
  return 'content\n';
};

(async () => {
  const { md } = await import('../public/markdown.js');
  const { mountFilesPanel } = await import('../public/files-panel.js');
  const { setGitConversationScope } = await import('../public/api.js');
  const { S } = await import('../public/state.js');
  const { initFileLinks, enhanceFileCandidates, resetFileLinkCaches } = await import('../public/file-links-ui.js');
  S.cwd = WIN;

  /* ---------- 渲染 ---------- */

  const links = { cwd: WIN, conversationId: '' };
  const messageHtml = md([
    '见 `src/app.js:12`、[说明](docs/README.md)、`README.md` 与 `npm install`。',
    '',
    '```ts',
    'const x = "src/app.js";',
    '```',
    '',
    '| 文件 | 行 |',
    '| --- | --- |',
    '| `src/app.js` | 12 |',
    '',
    '绝对路径 C:/fixture/project/src/app.js:3 与外部 [站点](https://example.com/x.ts)',
  ].join('\n'), { fileLinks: links });
  const messages = document.getElementById('messages');
  messages.innerHTML = messageHtml;

  ok('markdown turns explicit paths into chips without touching code blocks or package names', () => {
    const chips = [...messages.querySelectorAll('a.md-file-link')];
    assert.equal(chips.length, 4);
    assert.equal(chips[0].dataset.filePath, 'src/app.js');
    assert.equal(chips[0].dataset.fileLine, '12');
    assert.equal(chips[0].dataset.fileConversation, '');
    assert.equal(chips[0].getAttribute('href'), '#');
    assert.equal(chips[0].querySelector('.md-file-name').textContent, 'app.js:12');
    assert.equal(chips[0].querySelector('.file-kind-icon').dataset.fileKind, 'code');
    assert.equal(chips[0].classList.contains('md-file-chip'), false);
    const labels = [...messages.querySelectorAll('.md-file-name')].map((n) => n.textContent);
    assert.ok(labels.includes('README.md'));
    assert.ok(messages.textContent.includes('npm install'));
    assert.equal(messages.querySelector('pre.code a'), null);
    assert.ok(messages.querySelector('pre.code').textContent.includes('src/app.js'));
    assert.equal(messages.querySelectorAll('.md-table a.md-file-link').length, 1);
    assert.equal(messages.querySelectorAll('a[target="_blank"]').length, 1);
    assert.equal(messages.querySelector('a[target="_blank"]').getAttribute('href'), 'https://example.com/x.ts');
  });

  ok('label keeps its own text and appends the file chip', () => {
    const chip = [...messages.querySelectorAll('a.md-file-link')].find((n) => n.dataset.filePath === 'docs/README.md');
    assert.ok(chip);
    const paragraph = chip.closest('p');
    assert.ok(paragraph.textContent.includes('说明'));
    assert.equal(chip.querySelector('.md-file-name').textContent, 'README.md');
  });

  ok('a bare filename is only a candidate until the backend confirms uniqueness', () => {
    const candidate = messages.querySelector('code.md-file-candidate');
    assert.ok(candidate);
    assert.equal(candidate.dataset.fileCandidate, 'README.md');
    assert.equal(candidate.dataset.fileCwd, WIN);
    assert.equal(candidate.textContent, 'README.md');
  });

  ok('paths outside the message workspace and external URLs never become file links', () => {
    assert.equal(messages.querySelector('a[data-file-path="C:/Windows/x.txt"]'), null);
    assert.equal(messages.querySelectorAll('a.md-file-link').length, 4);
  });

  const noContext = md('`src/app.js` 与 C:/fixture/project/src/app.js');
  ok('without a workspace context markdown keeps the old plain output', () => {
    assert.equal(noContext.includes('md-file-link'), false);
    assert.ok(noContext.includes('<code>src/app.js</code>'));
  });

  const spaced = md('[带空格](<C:/fixture/project/docs/with space.md>) 与 [中文](<docs/中文 文档/说明.md>)', { fileLinks: links });
  ok('angle-bracket markdown destinations support spaces and Chinese paths', () => {
    const chips = [...new dom.window.DOMParser().parseFromString('<div>' + spaced + '</div>', 'text/html').querySelectorAll('a.md-file-link')];
    assert.equal(chips.length, 2);
    assert.equal(chips[0].dataset.filePath, 'docs/with space.md');
    assert.equal(chips[1].dataset.filePath, 'docs/中文 文档/说明.md');
    assert.ok(chips[1].getAttribute('aria-label').includes('中文 文档'));
  });

  const labeled = md('[`docs/说明 文档.md`](<docs/说明 文档.md>) 和 [说明](docs/说明 文档.md)', { fileLinks: links });
  ok('a backticked link label does not duplicate the chip and unangled spaced destinations resolve', () => {
    const box = new dom.window.DOMParser().parseFromString('<div>' + labeled + '</div>', 'text/html');
    const chips = [...box.querySelectorAll('a.md-file-link')];
    assert.equal(chips.length, 2);
    assert.equal(chips[0].querySelector('.md-file-name').textContent, '说明 文档.md');
    assert.equal(chips[0].textContent.match(/说明 文档\.md/g).length, 1);
    assert.equal(box.body.textContent.includes('(docs/说明 文档.md)'), false);
  });

  const hostile = md('`src/../../secret.txt` [x](javascript:alert(1)) `<img src=x onerror=alert(1)>`', { fileLinks: links });
  ok('file links stay inside the workspace and model HTML is still escaped', () => {
    assert.equal(hostile.includes('md-file-link'), false);
    assert.equal(hostile.includes('<img'), false);
    assert.ok(hostile.includes('&lt;img'));
    assert.equal(hostile.includes('javascript:alert'), true);
  });

  /* 带空格的普通链接目标会原样退回 Markdown 文本，但退回的原文同样要转义 ——
   * 它走的是“已生成 HTML”槽位，不转义就等于绕过安全模型。 */
  const spacedHostile = md('[<img src=x onerror=alert(1)>](foo bar)');
  ok('a raw HTML label on a spaced destination is escaped instead of injected', () => {
    assert.equal(spacedHostile.includes('<img'), false);
    assert.ok(spacedHostile.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(spacedHostile.includes('(foo bar)'));
  });

  /* ---------- fetch 桩：metadata + find ---------- */

  const fetchCalls = [];
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    fetchCalls.push({ url: value, headers: options.headers || {} });
    const json = (body) => ({ status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => body });
    if (value.startsWith('/api/files/metadata')) {
      const filePath = new URL(value, 'http://x').searchParams.get('path');
      return json({
        ok: true,
        file: { path: filePath, absolutePath: `${WIN}/${filePath}`, name: filePath.split('/').pop(), bytes: filePath === 'src/app.js' ? 1234 : 5678, image: filePath.endsWith('.png') },
      });
    }
    if (value.startsWith('/api/files/find')) {
      const name = new URL(value, 'http://x').searchParams.get('name');
      if (name === 'README.md') return json({ ok: true, name, matches: ['README.md'], truncated: false });
      if (name === 'dup.txt') return json({ ok: true, name, matches: ['src/dup.txt', 'docs/dup.txt'], truncated: false });
      if (/^unique-\d+\.md$/.test(name)) return json({ ok: true, name, matches: [name], truncated: false });
      return json({ ok: true, name, matches: [], truncated: false });
    }
    return json({ ok: false, code: 'not_expected', error: value });
  };

  /* ---------- 悬停提示 ---------- */

  initFileLinks();
  const firstChip = messages.querySelector('a.md-file-link');
  firstChip.dispatchEvent(new dom.window.Event('pointerover', { bubbles: true }));
  await tick(300);
  const tip = document.querySelector('.ui-tooltip.file-link-tip');
  ok('hover shows the canonical path, real byte size and line range in a body-level layer', () => {
    assert.ok(tip);
    assert.equal(tip.hidden, false);
    assert.equal(tip.parentElement, document.body);
    assert.ok(tip.textContent.includes('C:\\fixture\\project\\src\\app.js'), tip.textContent);
    assert.ok(tip.textContent.includes('1.2 KB'));
    assert.ok(tip.textContent.includes('L12'));
    assert.equal(fetchCalls.some((call) => call.url.startsWith('/api/files/metadata')), true);
  });

  firstChip.dispatchEvent(new dom.window.Event('pointerout', { bubbles: true }));
  await tick(120);
  ok('leaving the link hides the tooltip', () => assert.equal(tip.hidden, true));

  firstChip.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }));
  await tick(30);
  ok('keyboard focus reveals the same tooltip', () => assert.equal(tip.hidden, false));
  firstChip.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
  await tick(120);

  /* ---------- 候选升级 ---------- */

  resetFileLinkCaches();
  const candidateWrap = document.createElement('div');
  candidateWrap.innerHTML = md('`README.md`', { fileLinks: links });
  document.getElementById('host').append(candidateWrap);
  await enhanceFileCandidates(candidateWrap);
  ok('a unique bare filename upgrades in place to a real file link', () => {
    assert.equal(candidateWrap.querySelectorAll('code.md-file-candidate').length, 0);
    const upgraded = candidateWrap.querySelector('a.md-file-link');
    assert.ok(upgraded);
    assert.equal(upgraded.dataset.filePath, 'README.md');
    assert.equal(upgraded.querySelector('.md-file-name').textContent, 'README.md');
  });

  const ambiguousWrap = document.createElement('div');
  ambiguousWrap.innerHTML = md('`dup.txt`', { fileLinks: links });
  document.getElementById('host').append(ambiguousWrap);
  await enhanceFileCandidates(ambiguousWrap);
  ok('an ambiguous filename stays as code and is not clickable', () => {
    assert.equal(ambiguousWrap.querySelectorAll('a.md-file-link').length, 0);
    const candidate = ambiguousWrap.querySelector('code.md-file-candidate');
    assert.ok(candidate);
    assert.equal(candidate.dataset.fileChecked, '1');
  });

  /* 长对话里候选很多时按批处理，避免一次打出几十个请求；自动扫描要在
   * 下一批继续，不能让第 25 个之后的文件名永远停在代码外观。 */
  resetFileLinkCaches();
  const manyWrap = document.createElement('div');
  manyWrap.innerHTML = md(
    Array.from({ length: 30 }, (_v, i) => '`unique-' + String(i + 1).padStart(2, '0') + '.md`').join(' '),
    { fileLinks: links }
  );
  document.getElementById('host').append(manyWrap);
  await enhanceFileCandidates(manyWrap, { auto: true });
  ok('a long message upgrades only the first bounded batch', () => {
    assert.equal(manyWrap.querySelectorAll('a.md-file-link').length, 24);
    assert.equal(manyWrap.querySelectorAll('code.md-file-candidate').length, 6);
  });
  await until(() => manyWrap.querySelectorAll('code.md-file-candidate').length === 0, 'second candidate batch');
  ok('the next automatic batch upgrades the remaining candidates', () => {
    assert.equal(manyWrap.querySelectorAll('a.md-file-link').length, 30);
  });

  /* ---------- Files 面板：点击 / 标签 / 树 / 行定位 ---------- */

  const host = document.getElementById('host');
  const lists = [];
  const docs = [];
  const metadata = [];
  const list = async (dir, options = {}) => {
    lists.push({ dir, options });
    const workspace = WORKSPACE;
    if (dir === '') {
      return {
        ok: true, workspace, truncated: false, entries: [
          { name: 'src', path: 'src', type: 'dir', bytes: null, hidden: false },
          { name: 'README.md', path: 'README.md', type: 'file', bytes: 9, hidden: false },
          { name: 'binary.bin', path: 'binary.bin', type: 'file', bytes: 4, hidden: false },
        ],
      };
    }
    if (dir === 'src') {
      return {
        ok: true, workspace, truncated: false, entries: [
          { name: 'app.js', path: 'src/app.js', type: 'file', bytes: 1234, hidden: false },
          { name: 'nested', path: 'src/nested', type: 'dir', bytes: null, hidden: false },
        ],
      };
    }
    if (dir === 'src/nested') {
      return {
        ok: true, workspace, truncated: false, entries: [
          { name: 'deep.ts', path: 'src/nested/deep.ts', type: 'file', bytes: 22, hidden: false },
        ],
      };
    }
    return { ok: true, workspace, truncated: false, entries: [] };
  };
  const documentTransport = async (filePath, ws, generation) => {
    docs.push({ filePath, ws, generation });
    const binary = filePath.endsWith('.bin');
    return {
      ok: true,
      workspace: WORKSPACE,
      file: { path: filePath, bytes: contentFor(filePath).length, binary, content: binary ? '' : contentFor(filePath) },
    };
  };
  const view = fakeView();
  const panelHost = document.createElement('section');
  host.append(panelHost);
  mountFilesPanel(panelHost, view, {
    transport: {
      list,
      document: documentTransport,
      metadata: async (filePath, conversationId) => {
        metadata.push({ filePath, conversationId });
        return { ok: true, file: { path: filePath, absolutePath: `${WIN}/${filePath}`, name: filePath.split('/').pop(), bytes: 1234, image: filePath.endsWith('.png') } };
      },
      asset: async (filePath) => {
        return { ok: true, blob: new dom.window.Blob(['not-a-real-png'], { type: 'image/png' }), type: 'image/png' };
      },
    },
  });
  await until(() => panelHost.querySelectorAll('.files-entry').length >= 3);

  // jsdom 没有 createObjectURL；图片预览只需要可预测的 URL。
  const realCreate = dom.window.URL.createObjectURL;
  const realRevoke = dom.window.URL.revokeObjectURL;
  dom.window.URL.createObjectURL = () => 'blob:fixture-image';
  dom.window.URL.revokeObjectURL = () => {};
  global.URL.createObjectURL = () => 'blob:fixture-image';
  global.URL.revokeObjectURL = () => {};

  async function clickChip(filePath, line = null) {
    const chip = [...messages.querySelectorAll('a.md-file-link')]
      .find((n) => n.dataset.filePath === filePath);
    const link = chip || (() => {
      const wrap = document.createElement('div');
      const target = filePath + (line ? ':' + line : '');
      wrap.innerHTML = md('[' + filePath.split('/').pop() + '](' + target + ')', { fileLinks: links });
      messages.append(wrap);
      return wrap.querySelector('a.md-file-link');
    })();
    if (line && link.dataset.fileLine !== String(line)) {
      link.dataset.fileLine = String(line);
    }
    link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    return link;
  }

  await clickChip('src/app.js', 12);
  await until(() => panelHost.querySelectorAll('.files-tab').length === 1 && panelHost.querySelector('.files-preview-body'));
  ok('clicking a file link opens the existing Files surface, expands the tree and selects the row', () => {
    const tab = panelHost.querySelector('.files-tab');
    assert.ok(tab);
    assert.equal(tab.querySelector('.files-tab-select').getAttribute('aria-selected'), 'true');
    assert.equal(tab.querySelector('.files-tab-label').textContent, 'app.js');
    assert.equal(tab.querySelector('.files-tab-position').textContent, ':12');
    assert.equal(panelHost.querySelector('.files-preview-path').textContent, 'src/app.js');
    const row = [...panelHost.querySelectorAll('.files-entry')].find((n) => n.dataset.filePath === 'src/app.js');
    assert.ok(row);
    assert.equal(row.getAttribute('aria-current'), 'page');
    const dir = [...panelHost.querySelectorAll('.files-entry')].find((n) => n.dataset.filePath === 'src');
    assert.equal(dir.getAttribute('aria-expanded'), 'true');
    assert.ok(metadata.some((entry) => entry.filePath === 'src/app.js' && entry.conversationId === null));
  });

  ok('the preview keeps exact text and highlights the requested line', () => {
    const body = panelHost.querySelector('.files-preview-body');
    assert.equal(body.textContent, contentFor('src/app.js'));
    const highlight = panelHost.querySelector('.files-line-highlight');
    assert.equal(highlight.hidden, false);
    assert.equal(highlight.dataset.lineFrom, '12');
    assert.equal(highlight.dataset.lineTo, '12');
    const gutter = panelHost.querySelector('.files-preview-gutter');
    assert.ok(gutter.textContent.startsWith('1\n2\n3'));
    assert.ok(parseFloat(panelHost.querySelector('.files-preview-scroll').scrollTop) > 0);
  });

  await clickChip('src/app.js', 20);
  await until(() => panelHost.querySelector('.files-line-highlight')?.dataset.lineFrom === '20');
  ok('clicking the same file again reuses its tab and re-locates the line', () => {
    assert.equal(panelHost.querySelectorAll('.files-tab').length, 1);
    assert.equal(docs.filter((entry) => entry.filePath === 'src/app.js').length, 2);
  });

  await clickChip('README.md');
  await until(() => panelHost.querySelectorAll('.files-tab').length === 2 && panelHost.querySelector('.files-preview-path')?.textContent === 'README.md');
  ok('a second file adds a tab and syncs tree selection', () => {
    const selected = [...panelHost.querySelectorAll('.files-tab-select')].find((n) => n.getAttribute('aria-selected') === 'true');
    assert.equal(selected.querySelector('.files-tab-label').textContent, 'README.md');
    const row = [...panelHost.querySelectorAll('.files-entry')].find((n) => n.dataset.filePath === 'README.md');
    assert.equal(row.getAttribute('aria-current'), 'page');
    assert.equal(panelHost.querySelector('.files-preview-body').textContent, '# README\n');
    assert.equal(panelHost.querySelector('.files-preview-body .tok-kw')?.textContent, '# README');
  });

  const firstTab = () => [...panelHost.querySelectorAll('.files-tab-select')]
    .find((n) => n.querySelector('.files-tab-label')?.textContent === 'app.js');
  firstTab().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await until(() => panelHost.querySelector('.files-preview-path')?.textContent === 'src/app.js');
  ok('switching tabs restores that tab content and line target', () => {
    assert.equal(panelHost.querySelector('.files-line-highlight').dataset.lineFrom, '20');
    assert.equal(firstTab().getAttribute('aria-selected'), 'true');
  });

  const secondClose = [...panelHost.querySelectorAll('.files-tab')][1].querySelector('.files-tab-close');
  secondClose.click();
  ok('closing a tab keeps the remaining file active', () => {
    assert.equal(panelHost.querySelectorAll('.files-tab').length, 1);
    assert.equal(panelHost.querySelector('.files-preview-path').textContent, 'src/app.js');
  });

  /* 嵌套目录：展开 src/nested */
  await clickChip('src/nested/deep.ts', 1);
  await until(() => panelHost.querySelectorAll('.files-tab').length === 2 && [...panelHost.querySelectorAll('.files-entry')].some((n) => n.dataset.filePath === 'src/nested/deep.ts'));
  ok('opening a nested file expands every ancestor directory', () => {
    const nested = [...panelHost.querySelectorAll('.files-entry')].find((n) => n.dataset.filePath === 'src/nested');
    assert.equal(nested.getAttribute('aria-expanded'), 'true');
    const row = [...panelHost.querySelectorAll('.files-entry')].find((n) => n.dataset.filePath === 'src/nested/deep.ts');
    assert.equal(row.getAttribute('aria-current'), 'page');
  });

  /* 图片 */
  await clickChip('assets/logo.png');
  await until(() => panelHost.querySelector('.files-preview-image img'));
  ok('an image opens inline through the controlled asset transport', () => {
    const img = panelHost.querySelector('.files-preview-image img');
    assert.equal(img.getAttribute('src'), 'blob:fixture-image');
    assert.equal(img.alt, 'logo.png');
    assert.ok(panelHost.querySelectorAll('.files-tab').length >= 3);
  });

  /* 不支持格式 / 二进制 */
  await clickChip('docs/manual.pdf');
  await until(() => panelHost.querySelector('.files-preview-actions'));
  ok('PDF/Office-like formats offer a system-default-program entry instead of a fake preview', () => {
    assert.match(panelHost.querySelector('.files-preview').textContent, /暂不内联预览/);
    const action = [...panelHost.querySelectorAll('.files-preview-actions button')].find((n) => n.textContent.includes('系统默认程序'));
    assert.ok(action);
  });

  await clickChip('binary.bin');
  await until(() => panelHost.querySelector('.files-preview')?.textContent.includes('二进制'));
  ok('binary files keep the existing concise note', () => {
    assert.ok(panelHost.querySelector('.files-preview').textContent.includes('二进制'));
  });

  /* 行号越界 */
  await clickChip('src/app.js', 999);
  await until(() => panelHost.querySelector('.files-preview-path')?.textContent === 'src/app.js');
  ok('an out-of-range line degrades to the last real line without breaking the view', () => {
    const highlight = panelHost.querySelector('.files-line-highlight');
    assert.equal(highlight.hidden, false);
    assert.equal(highlight.dataset.lineFrom, '30');
    assert.equal(highlight.dataset.lineTo, '30');
  });

  /* 右键菜单与 Ctrl+点击 */
  const chip = [...messages.querySelectorAll('a.md-file-link')].find((n) => n.dataset.filePath === 'README.md');
  chip.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const menu = document.querySelector('.action-menu');
  ok('right-click exposes internal/external/reveal/copy actions', () => {
    assert.ok(menu);
    assert.equal(menu.getAttribute('role'), 'menu');
    const labels = [...menu.querySelectorAll('.action-menu-label')].map((n) => n.textContent);
    for (const label of ['在文件面板中打开', '用系统默认程序打开', '在文件管理器中显示', '复制相对路径', '复制完整路径']) {
      assert.ok(labels.includes(label), label);
    }
  });
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  const desktopCalls = [];
  window.piGuiDesktop = {
    openWorkspaceFile: async (filePath, conversationId) => {
      desktopCalls.push({ filePath, conversationId });
      return { ok: true, abs: `${WIN}/${filePath}` };
    },
  };
  chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  await until(() => desktopCalls.length === 1);
  ok('Ctrl/Cmd+click opens through the authorized desktop bridge, not the web browser', () => {
    assert.equal(desktopCalls[0].filePath, 'README.md');
    assert.equal(desktopCalls[0].conversationId, null);
    assert.equal(panelHost.querySelectorAll('.files-tab').length >= 1, true);
  });

  /* 跨会话：链接不属于当前焦点会话时不打开 */
  setGitConversationScope('11111111-2222-3333-4444-555555555555');
  await until(() => lists.length > 0);
  const beforeTabs = panelHost.querySelectorAll('.files-tab').length;
  const foreign = document.createElement('div');
  foreign.innerHTML = md('`src/app.js`', { fileLinks: { cwd: WIN, conversationId: '99999999-8888-7777-6666-555555555555' } });
  messages.append(foreign);
  foreign.querySelector('a.md-file-link').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick(50);
  ok('a file reference from a different session never resolves against the focused workspace', () => {
    assert.equal(panelHost.querySelectorAll('.files-tab').length, beforeTabs);
    assert.match(document.getElementById('toasts').textContent, /其它会话/);
  });
  setGitConversationScope(null);

  /* 流式：未闭合的行内代码不会半个路径就成链接 */
  const streaming = document.createElement('div');
  streaming.innerHTML = md('正在看 `src/ap', { fileLinks: links });
  ok('an unfinished streamed path stays plain text until the code span closes', () => {
    assert.equal(streaming.querySelectorAll('a.md-file-link').length, 0);
    streaming.innerHTML = md('正在看 `src/app.js`', { fileLinks: links });
    assert.equal(streaming.querySelectorAll('a.md-file-link').length, 1);
  });

  /* 收尾 */
  view.dispose();
  dom.window.URL.createObjectURL = realCreate;
  dom.window.URL.revokeObjectURL = realRevoke;
  delete global.URL.createObjectURL;
  delete global.URL.revokeObjectURL;

  console.log(`file-links-ui: ${checks} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
