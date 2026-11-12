/* UI contract for the Terminal and Files right-pane surfaces.
 * No real shell, project or network: transports are injected fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  for (let i = 0; i < 120; i++) {
    if (await fn()) return;
    await tick(10);
  }
  throw new Error(label + ' timeout');
};

function makeDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div><div id="modal" hidden></div><div id="confirmLayer" hidden></div><div id="paletteLayer" hidden></div></body></html>', {
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
  return dom;
}

function fakeView() {
  let current = true;
  const hooks = [];
  return {
    isCurrent: () => current,
    onDispose(fn) { hooks.push(fn); },
    dispose() {
      if (!current) return;
      current = false;
      for (const fn of hooks.reverse()) fn();
    },
  };
}

const terminalSession = (id = 's1', state = 'running') => ({
  id,
  cwd: 'C:/fixture/project',
  shell: 'PowerShell',
  state,
  workspace: { id: 'w1', generation: '1' },
});

(async () => {
  const dom = makeDom();
  const { mountTerminalPanel } = await import('../public/terminal-panel.js');
  const { mountFilesPanel } = await import('../public/files-panel.js');
  const host = document.getElementById('host');

  try {
    let starts = 0, writes = [], stops = 0, reads = 0, disposed = false;
    const terminalTransport = {
      status: async () => ({ ok: true, enabled: true, pipe: true, platform: 'win32' }),
      start: async () => { starts++; return { ok: true, session: terminalSession() }; },
      read: async () => {
        reads++;
        return reads === 1
          ? { ok: true, text: 'PowerShell ready\n', cursor: 17, state: 'running', session: terminalSession() }
          : { ok: true, text: '', cursor: 17, state: 'running', session: terminalSession() };
      },
      write: async (id, data) => { writes.push([id, data]); return { ok: true }; },
      stop: async () => { stops++; return { ok: true }; },
    };
    const view = fakeView();
    mountTerminalPanel(host, view, { transport: terminalTransport });
    await until(() => host.querySelector('.term-output')?.textContent.includes('PowerShell ready'));
    ok('terminal starts against the focused project and renders streamed output', () => {
      assert.equal(starts, 1);
      assert.equal(host.querySelectorAll('.rp-head').length, 1);
      assert.equal(host.querySelector('.rp-head-title').textContent, '终端');
      assert.ok(host.querySelector('.rp-head-sub').textContent.includes('运行中'));
      assert.ok(host.querySelector('.term-output').textContent.includes('PowerShell ready'));
      assert.equal(host.querySelector('.term-input').disabled, false);
    });

    const input = host.querySelector('.term-input');
    input.value = 'echo fixture';
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await until(() => writes.length === 1);
    ok('Enter sends exactly one line to the active session', () => {
      assert.deepEqual(writes[0], ['s1', 'echo fixture\n']);
      assert.equal(input.value, '');
    });

    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    ok('command history is available within the panel', () => assert.equal(input.value, 'echo fixture'));

    host.querySelector('.term-compose .term-send').click();
    await until(() => writes.length === 2);
    ok('the send button uses the same command path', () => assert.deepEqual(writes[1], ['s1', 'echo fixture\n']));

    const clear = [...host.querySelectorAll('.rp-head-actions button')].find((button) => button.textContent === '清屏');
    clear.click();
    ok('clear only resets the local display', () => {
      assert.equal(host.querySelector('.term-output').textContent, '');
      assert.equal(stops, 0);
    });

    host.ownerDocument.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-generation'));
    await tick();
    ok('a workspace change stops the old session and requires a restart', () => {
      assert.equal(stops, 1);
      assert.ok(host.querySelector('.rp-head-sub').textContent.includes('工作区已变化'));
      assert.equal(host.querySelector('.term-input').disabled, true);
    });
    view.dispose();
    disposed = view.isCurrent() === false;
    ok('terminal dispose releases the view and does not leave a live session', () => {
      assert.equal(disposed, true);
      assert.equal(host.querySelector('.term-input').disabled, true);
    });
  } finally {
    host.replaceChildren();
  }

  {
    let starts = 0;
    let stopped = 0;
    const view = fakeView();
    const transport = {
      status: async () => ({ ok: true, enabled: false }),
      start: async () => { starts++; return { ok: false, code: 'terminal_disabled' }; },
      read: async () => ({ ok: true, text: '', cursor: 0, state: 'running', session: terminalSession() }),
      write: async () => ({ ok: true }),
      stop: async () => { stopped++; return { ok: true }; },
    };
    mountTerminalPanel(host, view, { transport });
    await until(() => host.querySelector('.rp-head-sub')?.textContent.includes('不可用'));
    ok('a disabled terminal explains itself and does not attempt a spawn', () => {
      assert.equal(starts, 0);
      assert.equal(stopped, 0);
      assert.equal(host.querySelector('.term-input').disabled, true);
      assert.equal([...host.querySelectorAll('.rp-head-actions button')].at(-1).disabled, true);
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    let starts = 0;
    let releaseStart = null;
    const stopped = [];
    const view = fakeView();
    const transport = {
      status: async () => ({ ok: true, enabled: true }),
      start: () => { starts++; return new Promise((resolve) => { releaseStart = resolve; }); },
      read: async () => ({ ok: true, text: '', cursor: 0, state: 'running', session: terminalSession('s-late') }),
      write: async () => ({ ok: true }),
      stop: async (id) => { stopped.push(id); return { ok: true }; },
    };
    mountTerminalPanel(host, view, { transport });
    await until(() => starts === 1);
    view.dispose();
    releaseStart({ ok: true, session: terminalSession('s-late') });
    await tick(10);
    ok('a session that starts after panel disposal is stopped instead of leaked', () => {
      assert.deepEqual(stopped, ['s-late']);
    });
    host.replaceChildren();
  }

  {
    let lists = [], docs = [];
    let binary = false;
    const workspace = { id: 'w1', generation: '1' };
    const list = async (dir, options) => {
      lists.push({ dir, options });
      if (dir === '') {
        const entries = [
          { name: 'src', path: 'src', type: 'dir', bytes: null, hidden: false },
          { name: 'README.md', path: 'README.md', type: 'file', bytes: 12, hidden: false },
          { name: '.env', path: '.env', type: 'file', bytes: 4, hidden: true },
        ];
        return { ok: true, workspace, entries: options.hidden ? entries : entries.filter((entry) => !entry.hidden), truncated: false };
      }
      if (dir === 'src') {
        return { ok: true, workspace, entries: [{ name: 'app.js', path: 'src/app.js', type: 'file', bytes: 20, hidden: false }], truncated: false };
      }
      throw new Error('unexpected directory ' + dir);
    };
    const document = async (filePath, ws, generation) => {
      docs.push({ filePath, ws, generation });
      return {
        ok: true,
        workspace,
        file: { path: filePath, bytes: 5, binary, content: binary ? '' : 'hello\n' },
      };
    };
    const view = fakeView();
    mountFilesPanel(host, view, { transport: { list, document } });
    await until(() => host.querySelectorAll('.files-entry').length >= 2);
    ok('files starts with a bounded root listing and a read-only empty preview', () => {
      assert.equal(host.querySelector('.rp-head-title').textContent, '文件');
      const names = [...host.querySelectorAll('.files-entry-name')].map((n) => n.textContent);
      assert.ok(names.includes('src') && names.includes('README.md'));
      assert.ok(!names.includes('.env'));
      assert.ok(host.querySelector('.files-preview').textContent.includes('只读'));
      assert.equal(lists[0].dir, '');
      assert.equal(lists[0].options.hidden, false);
    });

    const dirRow = [...host.querySelectorAll('.files-entry')].find((row) => row.dataset.filePath === 'src');
    dirRow.click();
    await until(() => [...host.querySelectorAll('.files-entry')].some((row) => row.dataset.filePath === 'src/app.js'));
    ok('opening a directory is lazy and carries the workspace token', () => {
      const call = lists.find((entry) => entry.dir === 'src');
      assert.ok(call);
      assert.equal(call.options.workspace.id, 'w1');
      assert.equal(call.options.generation, '1');
      const currentDir = [...host.querySelectorAll('.files-entry')].find((row) => row.dataset.filePath === 'src');
      assert.equal(currentDir.getAttribute('aria-expanded'), 'true');
    });

    const fileRow = [...host.querySelectorAll('.files-entry')].find((row) => row.dataset.filePath === 'src/app.js');
    fileRow.click();
    await until(() => host.querySelector('.files-preview-body')?.textContent.includes('hello'));
    ok('a text preview uses the workspace identity and renders as text', () => {
      assert.equal(docs.length, 1);
      assert.equal(docs[0].filePath, 'src/app.js');
      assert.equal(docs[0].ws.id, 'w1');
      assert.equal(docs[0].generation, '1');
      assert.equal(host.querySelector('.files-preview-body').textContent, 'hello\n');
    });

    binary = true;
    fileRow.click();
    await until(() => host.querySelector('.files-preview')?.textContent.includes('二进制'));
    ok('binary previews are labelled instead of decoded', () => {
      assert.ok(host.querySelector('.files-preview').textContent.includes('二进制'));
    });
    binary = false;

    const hidden = [...host.querySelectorAll('.rp-head-actions button')].find((button) => button.textContent === '隐藏项');
    hidden.click();
    await until(() => lists.some((entry) => entry.dir === '' && entry.options.hidden === true));
    ok('the hidden-file toggle is an explicit opt-in', () => {
      assert.equal(hidden.getAttribute('aria-pressed'), 'true');
      assert.ok(lists.some((entry) => entry.dir === '' && entry.options.hidden === true));
    });

    const before = lists.length;
    host.ownerDocument.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-generation'));
    await until(() => lists.length > before);
    ok('a workspace generation change clears the old selection and reloads root', () => {
      assert.equal(host.querySelectorAll('.files-entry').length >= 2, true);
      assert.ok(!host.querySelector('.files-preview').textContent.includes('hello'));
    });

    view.dispose();
    const afterDispose = lists.length;
    host.ownerDocument.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-generation'));
    await tick(20);
    ok('files ignores workspace events after dispose', () => assert.equal(lists.length, afterDispose));
    host.replaceChildren();
  }

  {
    const { registerShortcut, assertNoConflicts } = await import('../public/shortcuts.js');
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const block = appSource.slice(appSource.indexOf('const workPanelToolEntries = ['), appSource.indexOf('];', appSource.indexOf('const workPanelToolEntries = [')) + 2);
    const order = ['navChanges', 'btnTerminal', 'btnFiles', 'btnBrowser', 'btnSpecs', 'btnTree', 'btnCollab'];
    ok('the launcher entries keep the required four-cell order (变更/终端/文件/更多)', () => {
      const positions = order.map((id) => block.indexOf(id));
      assert.ok(positions.every((position) => position >= 0));
      assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
      assert.ok(block.indexOf('more: true') > block.indexOf('btnFiles'));
    });
    assert.doesNotThrow(() => {
      registerShortcut({ id: 'fixture-terminal', combo: 'primary+`', label: '终端', run() {} });
      registerShortcut({ id: 'fixture-files', combo: 'primary+p', label: '文件', run() {} });
      assertNoConflicts();
    });
    ok('Ctrl+` and Ctrl+P are valid non-conflicting shortcut combinations', () => {
      assert.match(appSource, /id: 'work-terminal', combo: 'primary\+`'/);
      assert.match(appSource, /id: 'work-files', combo: 'primary\+p'/);
    });
  }

  console.log(`\n${checks} checks passed`);
  dom.window.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
