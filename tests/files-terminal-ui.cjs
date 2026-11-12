/* UI contract for the Terminal and Files right-pane surfaces.
 * No real shell, project or network: transports are injected fixtures. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
  cols: 80,
  rows: 24,
  workspace: { id: 'w1', generation: '1' },
});

function fakeTerminalView(size = { cols: 100, rows: 30 }) {
  const view = {
    size,
    writes: [],
    data: [],
    resize: null,
    disposed: false,
    fitCalls: 0,
    clearCalls: 0,
    resetCalls: 0,
    scrollCalls: 0,
    stdin: true,
    themeRefreshes: 0,
    fit() { view.fitCalls++; },
    write(text, callback) { view.writes.push(text); callback?.(); },
    focus() {},
    clear() { view.clearCalls++; view.writes.length = 0; },
    reset() { view.resetCalls++; view.writes.length = 0; },
    scrollToBottom() { view.scrollCalls++; },
    isAtBottom: () => true,
    getSize: () => view.size,
    setStdinEnabled(enabled) { view.stdin = enabled; },
    refreshTheme() { view.themeRefreshes++; },
    onData(fn) { view.data.push(fn); return { dispose() {} }; },
    onResize(fn) { view.resize = fn; return { dispose() {} }; },
    dispose() { view.disposed = true; },
    emitData(data) { for (const fn of view.data) fn(data); },
    emitResize(cols, rows) { view.size = { cols, rows }; view.resize?.({ cols, rows }); },
  };
  return view;
}

(async () => {
  const dom = makeDom();
  const { mountTerminalPanel } = await import('../public/terminal-panel.js');
  const { mountFilesPanel } = await import('../public/files-panel.js');
  const host = document.getElementById('host');

  try {
    {
      /* The real xterm bundle is ESM and only loaded in the browser. jsdom
       * cannot execute it, but it can at least prove the committed vendor copy
       * is the one the adapter imports and still matches its recorded hashes. */
      const vendor = path.join(__dirname, '..', 'public', 'vendor', 'xterm');
      const vendorMeta = JSON.parse(fs.readFileSync(path.join(vendor, 'versions.json'), 'utf8'));
      const hashes = Object.fromEntries(Object.entries(vendorMeta.files).map(([name, expected]) => [
        name,
        crypto.createHash('sha256').update(fs.readFileSync(path.join(vendor, name))).digest('hex') === expected ? expected : 'mismatch',
      ]));
      const adapter = fs.readFileSync(path.join(__dirname, '..', 'public', 'terminal-xterm.js'), 'utf8');
      ok('the adapter imports the committed xterm bundle whose hashes still match', () => {
        assert.deepEqual(hashes, vendorMeta.files);
        assert.match(adapter, /\.\/vendor\/xterm\/xterm\.mjs/);
        assert.match(adapter, /\.\/vendor\/xterm\/addon-fit\.mjs/);
      });
    }

    let starts = 0;
    const startSizes = [];
    const readSince = [];
    const writes = [];
    const resizes = [];
    const stops = [];
    const replay = '\x1b[32mPowerShell ready\x1b[0m\r\n';
    const terminalTransport = {
      status: async () => ({ ok: true, enabled: true, pty: true, platform: 'win32' }),
      start: async (size) => {
        starts++;
        startSizes.push(size);
        return { ok: true, reused: starts > 1, session: { ...terminalSession(), cols: size.cols, rows: size.rows } };
      },
      read: async (id, since) => {
        readSince.push(since);
        return since === 0
          ? { ok: true, text: replay, cursor: replay.length, state: 'running', session: terminalSession() }
          : { ok: true, text: '', cursor: replay.length, state: 'running', session: terminalSession() };
      },
      write: async (id, data) => { writes.push([id, data]); return { ok: true }; },
      resize: async (id, cols, rows) => { resizes.push([id, cols, rows]); return { ok: true }; },
      stop: async (id) => {
        stops.push(id);
        return { ok: true, session: terminalSession(id, 'stopping') };
      },
    };
    const termView = fakeTerminalView();
    const view = fakeView();
    mountTerminalPanel(host, view, { transport: terminalTransport, createTerminalView: () => termView });
    await until(() => termView.writes.join('').includes('PowerShell ready'));
    ok('xterm starts with its measured size and replays raw ANSI/CR output', () => {
      assert.equal(starts, 1);
      assert.deepEqual(startSizes[0], { cols: 100, rows: 30 });
      assert.equal(readSince.filter((since) => since === 0).length, 1);
      assert.equal(readSince[0], 0);
      assert.equal(termView.writes.join(''), replay);
      assert.equal(host.querySelectorAll('.rp-head').length, 1);
      assert.equal(host.querySelector('.rp-head-title').textContent, '终端');
      assert.ok(host.querySelector('.rp-head-sub').textContent.includes('运行中'));
      assert.equal(host.querySelector('.term-input'), null);
      assert.equal(host.querySelector('.term-compose'), null);
      assert.equal(termView.stdin, true);
      assert.ok(termView.fitCalls >= 1);
    });

    termView.emitData('echo 你好\r');
    await until(() => writes.length === 1);
    termView.emitData('\x03');
    await until(() => writes.length === 2);
    ok('keyboard and Ctrl+C are forwarded byte-for-byte with no appended newline', () => {
      assert.deepEqual(writes, [['s1', 'echo 你好\r'], ['s1', '\x03']]);
    });

    termView.emitResize(120, 40);
    await until(() => resizes.length === 1);
    ok('xterm resize is debounced and sent with the active session id', () => {
      assert.deepEqual(resizes[0], ['s1', 120, 40]);
      assert.equal(termView.stdin, true);
    });

    dom.window.document.documentElement.dataset.theme = 'light';
    await until(() => termView.themeRefreshes > 0);
    ok('the terminal theme follows the resolved light/dark mode', () => {
      assert.ok(termView.themeRefreshes >= 1);
    });

    const clear = [...host.querySelectorAll('.rp-head-actions button')].find((button) => button.textContent === '清屏');
    const beforeClear = stops.length;
    clear.click();
    ok('clear only touches the local xterm display', () => {
      assert.ok(termView.clearCalls >= 1);
      assert.equal(stops.length, beforeClear);
    });

    view.dispose();
    assert.equal(termView.disposed, true);
    assert.equal(stops.length, 0);
    assert.equal(view.isCurrent(), false);
    host.replaceChildren();

    const secondView = fakeTerminalView();
    const second = fakeView();
    mountTerminalPanel(host, second, { transport: terminalTransport, createTerminalView: () => secondView });
    await until(() => secondView.writes.join('').includes('PowerShell ready'));
    ok('switching surfaces disposes only xterm and reconnects the same workspace session', () => {
      assert.equal(starts, 2);
      assert.deepEqual(startSizes[1], { cols: 100, rows: 30 });
      assert.equal(readSince.filter((since) => since === 0).length, 2);
      assert.equal(secondView.writes.join(''), replay);
      assert.equal(stops.length, 0);
      assert.equal(secondView.disposed, false);
      assert.equal(second.isCurrent(), true);
    });

    dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-generation'));
    await tick(10);
    ok('a workspace change stops the old PTY and clears the frontend instead of reusing it', () => {
      assert.deepEqual(stops, ['s1']);
      assert.ok(secondView.resetCalls >= 1);
      assert.ok(host.querySelector('.rp-head-sub').textContent.includes('工作区已变化'));
      assert.equal(secondView.stdin, false);
    });
    second.dispose();
    host.replaceChildren();
  } finally {
    host.replaceChildren();
  }

  {
    let starts = 0;
    const view = fakeView();
    const termView = fakeTerminalView();
    const transport = {
      status: async () => ({ ok: true, enabled: false }),
      start: async () => { starts++; return { ok: false, code: 'terminal_disabled' }; },
      read: async () => ({ ok: true, text: '', cursor: 0, state: 'running', session: terminalSession() }),
      write: async () => ({ ok: true }),
      resize: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
    };
    mountTerminalPanel(host, view, { transport, createTerminalView: () => termView });
    await until(() => host.querySelector('.rp-head-sub')?.textContent.includes('不可用'));
    ok('a disabled terminal does not attempt a spawn and has no command input', () => {
      assert.equal(starts, 0);
      assert.equal(host.querySelector('.term-input'), null);
      assert.equal(host.querySelector('.rp-head-actions button:last-child').disabled, true);
      assert.equal(termView.disposed, false);
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    let starts = 0;
    let releaseStart = null;
    const stopped = [];
    const view = fakeView();
    const termView = fakeTerminalView();
    const transport = {
      status: async () => ({ ok: true, enabled: true }),
      start: () => { starts++; return new Promise((resolve) => { releaseStart = resolve; }); },
      read: async () => ({ ok: true, text: '', cursor: 0, state: 'running', session: terminalSession('s-late') }),
      write: async () => ({ ok: true }),
      resize: async () => ({ ok: true }),
      stop: async (id) => { stopped.push(id); return { ok: true }; },
    };
    mountTerminalPanel(host, view, { transport, createTerminalView: () => termView });
    await until(() => starts === 1);
    view.dispose();
    releaseStart({ ok: true, session: terminalSession('s-late') });
    await tick(10);
    ok('a session that starts after panel disposal is stopped instead of mounted', () => {
      assert.deepEqual(stopped, ['s-late']);
      assert.equal(termView.writes.length, 0);
    });
    host.replaceChildren();
  }

  {
    let starts = 0;
    let releaseStart = null;
    const stopped = [];
    const view = fakeView();
    const termView = fakeTerminalView();
    const transport = {
      status: async () => ({ ok: true, enabled: true }),
      start: () => { starts++; return new Promise((resolve) => { releaseStart = resolve; }); },
      read: async () => ({ ok: true, text: '', cursor: 0, state: 'running', session: terminalSession('s-keep') }),
      write: async () => ({ ok: true }),
      resize: async () => ({ ok: true }),
      stop: async (id) => { stopped.push(id); return { ok: true }; },
    };
    mountTerminalPanel(host, view, { transport, createTerminalView: () => termView });
    await until(() => starts === 1);
    view.dispose();
    /* A reused session already existed (surface reopened); the late response
     * must not treat it as an orphan of the disposed view. */
    releaseStart({ ok: true, reused: true, session: terminalSession('s-keep') });
    await tick(10);
    ok('a reused workspace session is not stopped when a late start lands after disposal', () => {
      assert.deepEqual(stopped, []);
      assert.equal(termView.writes.length, 0);
    });
    host.replaceChildren();
  }

  {
    const startSizes = [];
    const resizes = [];
    const view = fakeView();
    const termView = fakeTerminalView({ cols: 3, rows: 1 });
    const transport = {
      status: async () => ({
        ok: true,
        enabled: true,
        limits: { minCols: 20, maxCols: 120, minRows: 5, maxRows: 40 },
      }),
      start: async (size) => {
        startSizes.push(size);
        return { ok: true, session: { ...terminalSession('s-clamp'), cols: size.cols, rows: size.rows } };
      },
      read: async () => ({ ok: true, text: '', cursor: 0, state: 'running', session: terminalSession('s-clamp') }),
      write: async () => ({ ok: true }),
      resize: async (id, cols, rows) => { resizes.push([id, cols, rows]); return { ok: true }; },
      stop: async () => ({ ok: true }),
    };
    mountTerminalPanel(host, view, { transport, createTerminalView: () => termView });
    await until(() => startSizes.length === 1);
    ok('start dimensions are clamped to the limits reported by status', () => {
      assert.deepEqual(startSizes[0], { cols: 20, rows: 5 });
    });
    await until(() => host.querySelector('.rp-head-actions button:last-child')?.textContent === '停止');
    termView.emitResize(900, 80);
    await until(() => resizes.length === 1);
    ok('resize dimensions are clamped before reaching the server', () => {
      assert.deepEqual(resizes[0], ['s-clamp', 120, 40]);
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    let state = 'running';
    let stopped = 0;
    const view = fakeView();
    const termView = fakeTerminalView();
    const transport = {
      status: async () => ({ ok: true, enabled: true }),
      start: async () => ({ ok: true, session: terminalSession('s-stop') }),
      read: async () => ({ ok: true, text: '', cursor: 0, state, session: terminalSession('s-stop', state) }),
      write: async () => ({ ok: true }),
      resize: async () => ({ ok: true }),
      stop: async () => {
        stopped++;
        state = 'stopping';
        setTimeout(() => { state = 'exited'; }, 20);
        /* Polling replaces the session object while stop is in flight; this
         * used to leave the control stuck on 「处理中…」. */
        await new Promise((resolve) => setTimeout(resolve, 130));
        return { ok: true, session: terminalSession('s-stop', 'stopping') };
      },
    };
    mountTerminalPanel(host, view, { transport, createTerminalView: () => termView });
    await until(() => host.querySelector('.rp-head-actions button:last-child')?.textContent === '停止');
    host.querySelector('.rp-head-actions button:last-child').click();
    await until(() => stopped === 1);
    await until(() => {
      const button = host.querySelector('.rp-head-actions button:last-child');
      return button?.textContent === '重启' && !button.disabled;
    }, 'restart control after exit');
    ok('the Stop button ends the session and the UI follows real exit polling', () => {
      assert.equal(stopped, 1);
      assert.ok(host.querySelector('.rp-head-sub').textContent.includes('已退出'));
      assert.equal(termView.stdin, false);
      const restart = host.querySelector('.rp-head-actions button:last-child');
      assert.equal(restart.textContent, '重启');
      assert.equal(restart.disabled, false);
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    /* A stop response can schedule an immediate poll while the previous read
     * is still outstanding. That tick used to be dropped, freezing the UI on
     * 「正在停止…」 because the in-flight read returned to a replaced object. */
    let readCalls = 0;
    let releasePoll = null;
    let state = 'running';
    const view = fakeView();
    const termView = fakeTerminalView();
    const transport = {
      status: async () => ({ ok: true, enabled: true }),
      start: async () => ({ ok: true, session: terminalSession('s-poll', 'running') }),
      read: async () => {
        readCalls++;
        if (readCalls === 1) return { ok: true, text: '', cursor: 0, state, session: terminalSession('s-poll', state) };
        if (readCalls === 2) {
          return new Promise((resolve) => {
            releasePoll = () => resolve({
              ok: true, text: '', cursor: 0, state: 'running', session: terminalSession('s-poll', 'running'),
            });
          });
        }
        return { ok: true, text: '', cursor: 0, state, session: terminalSession('s-poll', state) };
      },
      write: async () => ({ ok: true }),
      resize: async () => ({ ok: true }),
      stop: async () => {
        state = 'stopping';
        return { ok: true, session: terminalSession('s-poll', 'stopping') };
      },
    };
    mountTerminalPanel(host, view, { transport, createTerminalView: () => termView });
    await until(() => readCalls >= 2 && releasePoll, 'in-flight read');
    host.querySelector('.rp-head-actions button:last-child').click();
    await until(() => host.querySelector('.rp-head-actions button:last-child')?.textContent === '正在停止…');
    await tick(30);
    state = 'exited';
    releasePoll();
    await until(() => host.querySelector('.rp-head-actions button:last-child')?.textContent === '重启', 'poll resumes after stop');
    ok('a poll tick that lands during an in-flight read is not lost after stop', () => {
      assert.ok(readCalls >= 3);
      assert.ok(host.querySelector('.rp-head-sub').textContent.includes('已退出'));
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    /* Closing a surface while its start is slow, then reopening it, can make
     * the closed mount's late "created" response arrive after the new mount
     * has already reused the same workspace session. The late mount must not
     * stop the session the live mount is showing. */
    let releaseLate = null;
    const lateStops = [];
    const viewA = fakeView();
    const termA = fakeTerminalView();
    const hostA = document.createElement('div');
    document.body.append(hostA);
    mountTerminalPanel(hostA, viewA, {
      createTerminalView: () => termA,
      transport: {
        status: async () => ({ ok: true, enabled: true }),
        start: () => new Promise((resolve) => { releaseLate = resolve; }),
        read: async () => ({ ok: true, text: '', cursor: 0, state: 'running', session: terminalSession('s-shared') }),
        write: async () => ({ ok: true }),
        resize: async () => ({ ok: true }),
        stop: async (id) => { lateStops.push(id); return { ok: true }; },
      },
    });
    await until(() => typeof releaseLate === 'function', 'deferred start');
    viewA.dispose();
    hostA.remove();

    const viewB = fakeView();
    const termB = fakeTerminalView();
    const hostB = document.createElement('div');
    document.body.append(hostB);
    mountTerminalPanel(hostB, viewB, {
      createTerminalView: () => termB,
      transport: {
        status: async () => ({ ok: true, enabled: true }),
        start: async () => ({ ok: true, reused: true, session: terminalSession('s-shared') }),
        read: async () => ({ ok: true, text: '', cursor: 0, state: 'running', session: terminalSession('s-shared') }),
        write: async () => ({ ok: true }),
        resize: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
      },
    });
    await until(() => hostB.querySelector('.rp-head-sub')?.textContent.includes('运行中'), 'reopened mount running');
    releaseLate({ ok: true, reused: false, session: terminalSession('s-shared') });
    await tick(50);
    ok('a late start from a closed mount does not stop a session another mount reused', () => {
      assert.deepEqual(lateStops, []);
      assert.equal(termB.disposed, false);
    });
    viewB.dispose();
    hostB.remove();
  }

  {
    const writes = [];
    let releaseFirst = null;
    const view = fakeView();
    const termView = fakeTerminalView();
    const transport = {
      status: async () => ({ ok: true, enabled: true }),
      start: async () => ({ ok: true, session: terminalSession('s-queue') }),
      read: async () => {
        await tick(0);
        return { ok: true, text: '', cursor: 0, state: 'running', session: terminalSession('s-queue') };
      },
      write: async (id, data) => {
        writes.push(data);
        if (writes.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
        return { ok: true };
      },
      resize: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
    };
    mountTerminalPanel(host, view, { transport, createTerminalView: () => termView });
    await until(() => host.querySelector('.rp-head-actions button:last-child')?.textContent === '停止');
    const payload = 'x'.repeat(20000);
    termView.emitData(payload);
    await until(() => writes.length === 1);
    await tick(150);
    releaseFirst();
    await until(() => writes.length === 2);
    ok('queued input is not dropped when polling replaces the session object', () => {
      assert.equal(writes.join(''), payload);
      assert.deepEqual(writes.map((chunk) => chunk.length), [16384, 3616]);
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    /* A read that discovers a workspace change before the generation event
     * reaches this mount must not leave the backend PTY running until its idle
     * timeout. Stop through the scope captured when the session started. */
    const stopped = [];
    const view = fakeView();
    const termView = fakeTerminalView();
    const transport = {
      status: async () => ({ ok: true, enabled: true }),
      start: async () => ({ ok: true, session: terminalSession('s-stale') }),
      read: async () => ({ ok: false, code: 'stale_workspace', error: '工作区已经变化，终端已停止。' }),
      write: async () => ({ ok: true }),
      resize: async () => ({ ok: true }),
      stop: async (id) => { stopped.push(id); return { ok: true }; },
    };
    mountTerminalPanel(host, view, { transport, createTerminalView: () => termView });
    await until(() => stopped.length === 1, 'stale read stop');
    await tick(20);
    ok('a stale read stops the old session instead of waiting for the idle timeout', () => {
      assert.deepEqual(stopped, ['s-stale']);
      assert.ok(host.querySelector('.rp-head-sub').textContent.includes('工作区已变化'));
      assert.equal(termView.stdin, false);
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    /* showChat() clears the conversation scope before the workspace-generation
     * event runs, so a stop that read the live scope would be refused by the
     * backend and orphan the PTY. The API must keep the scope from start. */
    const calls = [];
    const realFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : {};
      calls.push({ url: String(url), headers: options.headers || {}, body });
      return {
        status: 200,
        ok: true,
        json: async () => (body.action === 'start'
          ? { ok: true, session: terminalSession('s-scope') }
          : { ok: true, session: terminalSession('s-scope', 'stopping') }),
      };
    };
    const api = await import('../public/api.js');
    try {
      api.setGitConversationScope('conv-scope-a');
      await api.startTerminal({ cols: 80, rows: 24 });
      /* A sibling conversation in the same workspace reuses the session. The
       * stop must still be authorized by the conversation that spawned it. */
      api.setGitConversationScope('conv-scope-b');
      await api.startTerminal({ cols: 80, rows: 24 });
      api.setGitConversationScope(null);
      await api.stopTerminal('s-scope');
      const startCalls = calls.filter((call) => call.body.action === 'start');
      const stopCall = calls.find((call) => call.body.action === 'stop');
      ok('stop uses the conversation that spawned the terminal, even after a sibling start', () => {
        assert.equal(startCalls[0].headers['X-Pi-Gui-Conversation'], 'conv-scope-a');
        assert.equal(startCalls[1].headers['X-Pi-Gui-Conversation'], 'conv-scope-b');
        assert.equal(stopCall.headers['X-Pi-Gui-Conversation'], 'conv-scope-a');
        assert.equal(stopCall.body.id, 's-scope');
      });
    } finally {
      api.setGitConversationScope(null);
      global.fetch = realFetch;
    }
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
