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

/* Minimal backend for the P2 multi-terminal surface. It owns a per-workspace
 * session ledger, replays each session's own buffer from `since`, and records
 * every transport call so the test can prove that switching tabs does not
 * create, close or re-read a PTY. */
function multiBackend({ workspace = { id: 'w1', generation: '1' }, maxPerWorkspace = 6, limits = null } = {}) {
  const calls = { status: 0, list: 0, create: [], start: [], read: [], write: [], resize: [], stop: [], close: [], keepAlive: [] };
  const model = new Map();
  const state = {
    workspace: { ...workspace },
    seq: 0,
    createFailure: null,
    listFailure: null,
    closeFailure: null,
  };

  function addExisting(size = { cols: 80, rows: 24 }, sessionState = 'running', ws = state.workspace) {
    state.seq += 1;
    const session = {
      id: `m${state.seq}`,
      workspace: { id: ws.id, generation: ws.generation },
      cwd: `C:/fixture/${ws.id}`,
      shell: 'PowerShell',
      state: sessionState,
      exitCode: null,
      cols: size.cols,
      rows: size.rows,
      ordinal: state.seq,
      keepAlive: false,
      keepAliveRevision: 0,
    };
    const entry = { session, output: '', cursor: 0, removed: false };
    model.set(session.id, entry);
    return entry;
  }

  const transport = {
    status: async () => {
      calls.status++;
      return { ok: true, enabled: true, limits, maxSessionsPerWorkspace: maxPerWorkspace };
    },
    list: async () => {
      calls.list++;
      if (state.listFailure) return state.listFailure;
      const ws = state.workspace;
      return {
        ok: true,
        workspace: { ...ws },
        sessions: [...model.values()]
          .filter((entry) => !entry.removed && entry.session.workspace.id === ws.id)
          .sort((a, b) => a.session.ordinal - b.session.ordinal)
          .map((entry) => ({ ...entry.session })),
      };
    },
    create: async (size) => {
      calls.create.push(size);
      if (state.createFailure) return state.createFailure;
      const entry = addExisting(size, 'running');
      return { ok: true, reused: false, session: { ...entry.session } };
    },
    start: async (size) => {
      calls.start.push(size);
      if (state.createFailure) return state.createFailure;
      const entry = addExisting(size, 'running');
      return { ok: true, reused: false, session: { ...entry.session } };
    },
    read: async (id, since) => {
      calls.read.push([id, since]);
      const entry = model.get(id);
      if (!entry || entry.removed) return { ok: false, code: 'terminal_missing' };
      const text = Number.isSafeInteger(since) && since < entry.cursor ? entry.output.slice(since) : '';
      return {
        ok: true,
        text,
        cursor: entry.cursor,
        state: entry.session.state,
        exitCode: entry.session.exitCode,
        session: { ...entry.session },
      };
    },
    write: async (id, data) => {
      calls.write.push([id, data]);
      return { ok: true };
    },
    resize: async (id, cols, rows) => {
      calls.resize.push([id, cols, rows]);
      return { ok: true };
    },
    stop: async (id) => {
      calls.stop.push(id);
      const entry = model.get(id);
      if (!entry) return { ok: false, code: 'terminal_missing' };
      entry.session.state = 'closing';
      return { ok: true, session: { ...entry.session } };
    },
    close: async (id) => {
      calls.close.push(id);
      if (state.closeFailure) return state.closeFailure;
      const entry = model.get(id);
      if (entry) entry.removed = true;
      return { ok: true, closed: true, missing: !entry };
    },
    setKeepAlive: async (id, enabled) => {
      calls.keepAlive.push([id, enabled]);
      const entry = model.get(id);
      if (!entry) return { ok: false, code: 'terminal_missing' };
      if (state.keepAliveFailure) return state.keepAliveFailure;
      if (entry.session.keepAlive !== enabled) {
        entry.session.keepAlive = enabled;
        entry.session.keepAliveRevision = (entry.session.keepAliveRevision || 0) + 1;
      }
      return { ok: true, session: { ...entry.session } };
    },
  };

  return {
    transport,
    calls,
    model,
    state,
    addExisting,
    emit(id, text) {
      const entry = model.get(id);
      if (!entry) throw new Error('unknown session ' + id);
      entry.output += text;
      entry.cursor += text.length;
    },
    setState(id, sessionState, exitCode = null) {
      const entry = model.get(id);
      if (!entry) throw new Error('unknown session ' + id);
      entry.session.state = sessionState;
      if (exitCode !== null) entry.session.exitCode = exitCode;
      if (sessionState === 'exited' && entry.session.keepAlive) {
        entry.session.keepAlive = false;
        entry.session.keepAliveRevision = (entry.session.keepAliveRevision || 0) + 1;
      }
    },
  };
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

    secondView.emitData('echo reopen\r');
    await until(() => writes.length === 3);
    secondView.emitResize(110, 32);
    await until(() => resizes.length === 2);
    ok('input and resize still work after reopening a replayed terminal', () => {
      assert.deepEqual(writes.at(-1), ['s1', 'echo reopen\r']);
      assert.deepEqual(resizes.at(-1), ['s1', 110, 32]);
      assert.equal(stops.length, 0);
    });

    dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-generation'));
    await tick(30);
    ok('a workspace change detaches the frontend without killing the PTY', () => {
      /* P2: sessions belong to their own workspace and stay alive; returning
       * to the original workspace must reconnect to the same PTY. */
      assert.deepEqual(stops, []);
      assert.equal(secondView.disposed, true);
      assert.equal(secondView.stdin, false);
      assert.equal(secondView.resetCalls, 0);
      assert.ok(host.querySelector('.rp-head-sub').textContent.includes('工作区已变化'));
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
    /* Replaying a buffer whose beginning was dropped would feed xterm a
     * fragment of ANSI/mode state. The safe contract is: reset, explain, keep
     * the live PTY usable. */
    const reads = [];
    let truncatedReads = 0;
    let liveSent = false;
    const writes = [];
    const resizes = [];
    const milestoneText = 'LIVE_AFTER_TRUNCATION\r\n';
    const view = fakeView();
    const termView = fakeTerminalView();
    const transport = {
      status: async () => ({ ok: true, enabled: true }),
      start: async (size) => ({ ok: true, session: { ...terminalSession('s-trunc'), cols: size.cols, rows: size.rows } }),
      /* Honour `since`: the truncated read reports cursor 123, so a correct
       * panel must request since=123 next. If the cursor assignment regresses,
       * every poll asks for 0 and keeps resetting the live screen. */
      read: async (id, since) => {
        reads.push(since);
        if (since === 0) {
          truncatedReads++;
          return {
            ok: true,
            truncated: true,
            text: 'OLD_PARTIAL\x1b[31mTAIL',
            cursor: 123,
            state: 'running',
            session: terminalSession('s-trunc'),
          };
        }
        const text = liveSent ? '' : milestoneText;
        liveSent = true;
        return {
          ok: true,
          truncated: false,
          text,
          cursor: since + text.length,
          state: 'running',
          session: terminalSession('s-trunc'),
        };
      },
      write: async (id, data) => { writes.push(data); return { ok: true }; },
      resize: async (id, cols, rows) => { resizes.push([id, cols, rows]); return { ok: true }; },
      stop: async () => ({ ok: true }),
    };
    mountTerminalPanel(host, view, { transport, createTerminalView: () => termView });
    /* Fixed wait rather than until(LIVE...): if the cursor regresses, LIVE never
     * arrives and the assertions below must still report why. */
    await tick(300);
    ok('a truncated replay resets the display instead of replaying an ANSI fragment', () => {
      assert.ok(termView.resetCalls >= 1);
      const shown = termView.writes.join('');
      assert.ok(shown.includes('较早的输出已超出缓存上限'));
      assert.ok(!shown.includes('OLD_PARTIAL'));
      assert.ok(!shown.includes('TAIL'));
    });
    ok('the truncated cursor advances so the live tail is not reset on every poll', () => {
      assert.equal(truncatedReads, 1, `truncated reads: ${truncatedReads}`);
      assert.equal(reads[0], 0);
      assert.ok(reads.includes(123), `read cursors: ${reads.join(',')}`);
      assert.ok(termView.writes.join('').includes('LIVE_AFTER_TRUNCATION'));
    });
    termView.emitData('echo after\r');
    await until(() => writes.length === 1);
    termView.emitResize(120, 40);
    await until(() => resizes.length === 1);
    ok('input and resize still work after the truncated replay fallback', () => {
      assert.deepEqual(writes, ['echo after\r']);
      assert.deepEqual(resizes, [['s-trunc', 120, 40]]);
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
    await until(() => host.querySelector('.rp-head-sub')?.textContent.includes('工作区已变化'), 'stale read detach');
    await tick(20);
    ok('a stale read detaches instead of killing the PTY', () => {
      assert.deepEqual(stopped, []);
      assert.equal(termView.disposed, true);
      assert.equal(termView.stdin, false);
      assert.ok(host.querySelector('.rp-head-sub').textContent.includes('工作区已变化'));
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
      await api.setTerminalKeepAlive('s-scope', true);
      const startCalls = calls.filter((call) => call.body.action === 'start');
      const stopCall = calls.find((call) => call.body.action === 'stop');
      const keepAliveCall = calls.find((call) => call.body.action === 'keep-alive');
      ok('stop and Keep Alive use the conversation that spawned the terminal', () => {
        assert.equal(startCalls[0].headers['X-Pi-Gui-Conversation'], 'conv-scope-a');
        assert.equal(startCalls[1].headers['X-Pi-Gui-Conversation'], 'conv-scope-b');
        assert.equal(stopCall.headers['X-Pi-Gui-Conversation'], 'conv-scope-a');
        assert.equal(stopCall.body.id, 's-scope');
        assert.equal(keepAliveCall.headers['X-Pi-Gui-Conversation'], 'conv-scope-a');
        assert.equal(keepAliveCall.body.id, 's-scope');
        assert.equal(keepAliveCall.body.enabled, true);
      });
    } finally {
      api.setGitConversationScope(null);
      global.fetch = realFetch;
    }
  }

  {
    /* A list response describes the workspace at request time. If the user
     * switches conversation before it lands, tagging the returned ids with the
     * new conversation would send close/stop to the wrong workspace forever. */
    const calls = [];
    let resolveList = null;
    const realFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : {};
      calls.push({ url: String(url), headers: options.headers || {}, body });
      if (body.action === 'list') {
        return new Promise((resolve) => {
          resolveList = () => resolve({
            status: 200,
            ok: true,
            json: async () => ({ ok: true, sessions: [terminalSession('s-list')] }),
          });
        });
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true, closed: true, session: terminalSession('s-list') }),
      };
    };
    const api = await import('../public/api.js');
    try {
      api.setGitConversationScope('conv-list-a');
      const pending = api.listTerminals();
      await tick();
      api.setGitConversationScope('conv-list-b');
      resolveList();
      const result = await pending;
      await api.closeTerminal('s-list');
      const listCall = calls.find((call) => call.body.action === 'list');
      const closeCall = calls.find((call) => call.body.action === 'close');
      ok('a list response keeps the conversation that issued it, not a later switch', () => {
        assert.equal(result.sessions[0].id, 's-list');
        assert.equal(listCall.headers['X-Pi-Gui-Conversation'], 'conv-list-a');
        assert.equal(closeCall.headers['X-Pi-Gui-Conversation'], 'conv-list-a');
      });
    } finally {
      api.setGitConversationScope(null);
      global.fetch = realFetch;
    }
  }

  {
    /* P2 multi-terminal surface: three independent sessions, tab switching
     * without PTY recreation, one-tab close, exit/restart, panel reopen and
     * workspace isolation/return. */
    const backend = multiBackend();
    const views = [];
    const view = fakeView();
    const makeView = () => {
      const next = fakeTerminalView();
      views.push(next);
      return next;
    };
    mountTerminalPanel(host, view, { transport: backend.transport, createTerminalView: makeView });
    await until(() => backend.calls.create.length === 1 && host.querySelectorAll('.terminal-tab').length === 1);
    await until(() => host.querySelector('.rp-head-sub')?.textContent.includes('运行中'));
    const firstId = [...backend.model.keys()][0];
    ok('P2 create adds a measured tab and replays its own buffer', () => {
      assert.deepEqual(backend.calls.create[0], { cols: 100, rows: 30 });
      assert.equal(views.length, 1);
      const tab = host.querySelector('.terminal-tab');
      assert.equal(tab.dataset.terminalId, firstId);
      assert.equal(tab.dataset.state, 'running');
      assert.ok(tab.classList.contains('is-active'));
      assert.equal(tab.querySelector('.terminal-tab-label').textContent, '终端 1');
      assert.equal(host.querySelector('.term-host').hidden, false);
      assert.equal(host.querySelector('.terminal-empty').hidden, true);
      assert.equal(host.querySelectorAll('.term-view:not([hidden])').length, 1);
    });
    await tick(40);
    ok('the active terminal restores from cursor 0 and polls the same session', () => {
      /* A fresh PTY has no output yet, so its cursor legitimately stays 0
       * until the first bytes arrive. */
      assert.ok(backend.calls.read.some(([id, since]) => id === firstId && since === 0));
      assert.equal(backend.calls.create.length, 1);
    });

    backend.emit(firstId, 'first-only\r\n');
    await until(() => views[0].writes.join('').includes('first-only'));
    const readMark = backend.calls.read.length;
    await tick(150);
    ok('after output is replayed the poll advances the opaque cursor', () => {
      const later = backend.calls.read.slice(readMark).filter(([id]) => id === firstId);
      assert.ok(later.length >= 1);
      assert.ok(later.every(([, since]) => since > 0));
    });
    host.querySelector('.terminal-new').click();
    await until(() => backend.calls.create.length === 2 && host.querySelectorAll('.terminal-tab').length === 2);
    await until(() => host.querySelectorAll('.term-view').length === 2);
    const secondId = [...backend.model.keys()][1];
    ok('a second terminal is truly separate while the first stays mounted', () => {
      assert.equal(views.length, 2);
      assert.equal(views[0].disposed, false);
      assert.equal(views[1].disposed, false);
      assert.equal(host.querySelector('#term-view-' + firstId).hidden, true);
      assert.equal(host.querySelector('#term-view-' + secondId).hidden, false);
      assert.ok(host.querySelectorAll('.terminal-tab')[1].classList.contains('is-active'));
      assert.equal(host.querySelectorAll('.terminal-tab').length, 2);
    });

    backend.emit(firstId, 'first-tail\r\n');
    backend.emit(secondId, 'second-tail\r\n');
    await until(() => views[0].writes.join('').includes('first-tail')
      && views[1].writes.join('').includes('second-tail'));
    ok('hidden tabs keep polling and each view receives only its own output', () => {
      assert.ok(!views[0].writes.join('').includes('second-tail'));
      assert.ok(!views[1].writes.join('').includes('first-tail'));
      assert.equal(views[0].writes.join(''), 'first-only\r\nfirst-tail\r\n');
      assert.equal(views[1].writes.join(''), 'second-tail\r\n');
    });

    views[1].emitData('echo second\r');
    await until(() => backend.calls.write.some(([id]) => id === secondId));
    views[0].emitData('hidden-must-not-send\r');
    await tick(40);
    ok('keyboard input goes only to the visible terminal', () => {
      assert.deepEqual(backend.calls.write, [[secondId, 'echo second\r']]);
    });

    host.querySelectorAll('.terminal-tab-select')[0].click();
    await tick(40);
    ok('switching tabs only toggles visibility and never recreates a PTY', () => {
      assert.equal(backend.calls.create.length, 2);
      assert.equal(views.length, 2);
      assert.equal(views[0].disposed, false);
      assert.equal(views[1].disposed, false);
      assert.equal(host.querySelector('#term-view-' + firstId).hidden, false);
      assert.equal(host.querySelector('#term-view-' + secondId).hidden, true);
      assert.ok(host.querySelectorAll('.terminal-tab')[0].classList.contains('is-active'));
      assert.ok(host.querySelector('.rp-head-sub').textContent.includes('运行中'));
      assert.equal(host.querySelector('.terminal-tab-label').textContent, '终端 1');
    });

    host.querySelectorAll('.terminal-tab-close')[1].click();
    await until(() => backend.calls.close.includes(secondId));
    await tick(20);
    ok('closing one tab terminates only that terminal', () => {
      assert.equal(host.querySelectorAll('.terminal-tab').length, 1);
      assert.equal(views[1].disposed, true);
      assert.equal(backend.model.get(secondId).removed, true);
      assert.equal(backend.calls.close.includes(firstId), false);
      assert.equal(views[0].disposed, false);
      assert.equal(host.querySelector('#term-view-' + firstId).hidden, false);
    });

    backend.setState(firstId, 'exited', 7);
    await until(() => host.querySelector('.rp-head-sub')?.textContent.includes('已退出'), 'exit state');
    ok('a real shell exit is reflected in the tab and the header', () => {
      assert.equal(host.querySelector('.terminal-tab').dataset.state, 'exited');
      assert.ok(host.querySelector('.rp-head-sub').textContent.includes('(7)'));
      const control = host.querySelector('.rp-head-actions button:last-child');
      assert.equal(control.textContent, '重启');
      assert.equal(control.disabled, false);
    });

    const beforeRestart = backend.calls.create.length;
    host.querySelector('.rp-head-actions button:last-child').click();
    await until(() => backend.calls.create.length === beforeRestart + 1
      && host.querySelectorAll('.terminal-tab').length === 1);
    await until(() => host.querySelector('.rp-head-sub')?.textContent.includes('运行中'));
    const restartedId = [...backend.model.entries()]
      .filter(([, entry]) => !entry.removed)
      .at(-1)[0];
    ok('restart closes the exited tab and creates a fresh session with the same size', () => {
      assert.ok(backend.calls.close.includes(firstId));
      assert.notEqual(restartedId, firstId);
      assert.deepEqual(backend.calls.create.at(-1), { cols: 100, rows: 30 });
      assert.equal(host.querySelector('.terminal-tab-label').textContent, '终端 1');
      assert.equal(host.querySelector('.terminal-tab').dataset.state, 'running');
    });

    host.querySelector('.terminal-tab-close').click();
    await until(() => host.querySelector('.terminal-empty').hidden === false, 'empty after last close');
    ok('closing the last tab shows the workspace empty state', () => {
      assert.equal(host.querySelectorAll('.terminal-tab').length, 0);
      assert.ok(host.querySelector('.terminal-empty-title').textContent.includes('还没有终端'));
      assert.equal(host.querySelector('.term-host').hidden, true);
      assert.equal(host.querySelector('.terminal-new').disabled, false);
      assert.equal(host.querySelector('#term-view-' + restartedId), null);
    });

    host.querySelector('.terminal-empty-action').click();
    await until(() => host.querySelectorAll('.terminal-tab').length === 1, 'create from empty state');
    const liveId = [...backend.model.entries()].filter(([, entry]) => !entry.removed).at(-1)[0];

    view.dispose();
    await tick(30);
    ok('closing the panel disposes xterm but leaves the PTY running', () => {
      assert.equal(views.at(-1).disposed, true);
      assert.equal(backend.calls.close.includes(liveId), false);
      assert.equal(backend.calls.stop.includes(liveId), false);
      assert.equal(backend.model.get(liveId).removed, false);
    });
    host.replaceChildren();

    backend.emit(liveId, 'persisted-after-reopen\r\n');
    const reopenedViews = [];
    const reopened = fakeView();
    const createBeforeReopen = backend.calls.create.length;
    mountTerminalPanel(host, reopened, {
      transport: backend.transport,
      createTerminalView: () => {
        const next = fakeTerminalView();
        reopenedViews.push(next);
        return next;
      },
    });
    await until(() => host.querySelectorAll('.terminal-tab').length === 1 && reopenedViews.length === 1);
    await until(() => reopenedViews[0].writes.join('').includes('persisted-after-reopen'));
    ok('reopening lists the live workspace sessions instead of spawning again', () => {
      assert.equal(backend.calls.create.length, createBeforeReopen);
      assert.ok(backend.calls.read.filter(([id, since]) => id === liveId && since === 0).length >= 2);
      assert.equal(host.querySelector('.terminal-tab').dataset.state, 'running');
      assert.equal(reopenedViews[0].disposed, false);
    });

    const listBefore = backend.calls.list;
    document.dispatchEvent(new dom.window.CustomEvent('pi-gui:git-scope'));
    await until(() => backend.calls.list > listBefore);
    await tick(30);
    ok('a same-workspace git scope change keeps the tabs mounted', () => {
      assert.equal(host.querySelectorAll('.terminal-tab').length, 1);
      assert.equal(reopenedViews[0].disposed, false);
      assert.equal(backend.calls.close.includes(liveId), false);
      assert.equal(backend.calls.stop.includes(liveId), false);
      assert.equal(backend.calls.create.length, createBeforeReopen);
    });

    const w2 = backend.addExisting({ cols: 70, rows: 20 }, 'running', { id: 'w2', generation: '2' });
    backend.state.workspace = { id: 'w2', generation: '2' };
    const closesBeforeSwitch = backend.calls.close.length;
    document.dispatchEvent(new dom.window.CustomEvent('pi-gui:git-scope'));
    await until(() => host.querySelector('.terminal-tab')?.dataset.terminalId === w2.session.id
      && reopenedViews.length >= 2, 'workspace B tab');
    ok('switching workspace detaches the old tabs without stopping their PTYs', () => {
      assert.equal(host.querySelector('.terminal-tab').dataset.terminalId, w2.session.id);
      assert.equal(reopenedViews[0].disposed, true);
      assert.equal(backend.calls.close.length, closesBeforeSwitch);
      assert.equal(backend.calls.stop.some((id) => id === liveId || id === w2.session.id), false);
      assert.equal(backend.model.get(liveId).removed, false);
      assert.equal(backend.model.get(w2.session.id).removed, false);
      assert.ok(host.querySelector('.rp-head-sub').textContent.includes('运行中'));
      assert.equal(host.querySelector('#term-view-' + liveId), null);
    });

    backend.state.workspace = { id: 'w1', generation: '1' };
    const listBeforeReturn = backend.calls.list;
    document.dispatchEvent(new dom.window.CustomEvent('pi-gui:git-scope'));
    await until(() => backend.calls.list > listBeforeReturn);
    await until(() => host.querySelector('.terminal-tab')?.dataset.terminalId === liveId
      && reopenedViews.length >= 3, 'workspace A tab restored');
    ok('returning to the original workspace reconnects to the same live session', () => {
      assert.equal(reopenedViews[1].disposed, true);
      assert.equal(reopenedViews[2].disposed, false);
      assert.equal(backend.calls.create.length, createBeforeReopen);
      assert.equal(backend.calls.close.some((id) => id === liveId), false);
      assert.equal(backend.model.get(liveId).removed, false);
      assert.equal(host.querySelector('.terminal-tab').dataset.state, 'running');
      assert.ok(reopenedViews[2].writes.join('').includes('persisted-after-reopen'));
    });

    reopened.dispose();
    host.replaceChildren();
  }

  {
    /* P3 Keep Alive: an explicit per-session toggle, rendered from the
     * server's session state (not local DOM), with tab switching, workspace
     * return, panel reopen, exit/restart and late-poll coverage. */
    const backend = multiBackend({ workspace: { id: 'w-keep', generation: '1' } });
    const views = [];
    const view = fakeView();
    const makeView = () => {
      const next = fakeTerminalView();
      views.push(next);
      return next;
    };
    mountTerminalPanel(host, view, { transport: backend.transport, createTerminalView: makeView });
    await until(() => backend.calls.create.length === 1 && host.querySelectorAll('.terminal-tab').length === 1);
    const keepButton = () => host.querySelector('.terminal-keepalive');
    const firstId = [...backend.model.keys()][0];
    ok('Keep Alive is off by default and explains its effect', () => {
      const button = keepButton();
      assert.ok(button);
      assert.equal(button.getAttribute('aria-pressed'), 'false');
      assert.equal(button.textContent.trim(), '保持');
      assert.match(button.title, /30 分钟无输入输出也不会自动停止/);
      assert.equal(host.querySelector('.terminal-tab').dataset.keepAlive, 'false');
      assert.equal(host.querySelector('.terminal-tab-keep').hidden, true);
    });

    keepButton().click();
    await until(() => backend.calls.keepAlive.length === 1 && keepButton().getAttribute('aria-pressed') === 'true');
    ok('the toggle is explicit, scoped and reflected in the tab marker', () => {
      assert.deepEqual(backend.calls.keepAlive[0], [firstId, true]);
      assert.equal(backend.model.get(firstId).session.keepAlive, true);
      assert.equal(keepButton().classList.contains('is-active'), true);
      assert.equal(keepButton().textContent.trim(), '保持中');
      assert.match(keepButton().title, /30 分钟无输入输出也不会自动停止/);
      assert.equal(host.querySelector('.terminal-tab').dataset.keepAlive, 'true');
      assert.equal(host.querySelector('.terminal-tab-keep').hidden, false);
    });

    host.querySelector('.terminal-new').click();
    await until(() => host.querySelectorAll('.terminal-tab').length === 2);
    const secondId = [...backend.model.keys()][1];
    ok('each terminal keeps its own Keep Alive state', () => {
      assert.equal(keepButton().getAttribute('aria-pressed'), 'false');
      const [firstTab, secondTab] = host.querySelectorAll('.terminal-tab');
      assert.equal(firstTab.dataset.keepAlive, 'true');
      assert.equal(secondTab.dataset.keepAlive, 'false');
      assert.equal(backend.model.get(secondId).session.keepAlive, false);
    });
    host.querySelectorAll('.terminal-tab-select')[0].click();
    await tick(30);
    ok('switching tabs restores the session-backed Keep Alive state', () => {
      assert.equal(keepButton().getAttribute('aria-pressed'), 'true');
      assert.equal(keepButton().textContent.trim(), '保持中');
    });

    backend.setState(firstId, 'exited', 0);
    await until(() => host.querySelectorAll('.terminal-tab')[0]?.dataset.state === 'exited');
    ok('terminal exit clears Keep Alive and disables the control', () => {
      assert.equal(backend.model.get(firstId).session.keepAlive, false);
      assert.equal(keepButton().getAttribute('aria-pressed'), 'false');
      assert.equal(keepButton().disabled, true);
      assert.equal(host.querySelectorAll('.terminal-tab')[0].dataset.keepAlive, 'false');
    });

    const beforeRestart = backend.calls.create.length;
    host.querySelector('.rp-head-actions button:last-child').click();
    await until(() => backend.calls.create.length === beforeRestart + 1);
    await until(() => host.querySelector('.rp-head-sub')?.textContent.includes('运行中'));
    const restartedId = [...backend.model.entries()].filter(([, entry]) => !entry.removed).at(-1)[0];
    ok('restart creates a fresh session with Keep Alive reset to off', () => {
      assert.equal(backend.model.get(restartedId).session.keepAlive, false);
      assert.equal(keepButton().getAttribute('aria-pressed'), 'false');
      assert.equal(keepButton().disabled, false);
    });

    const w2 = backend.addExisting({ cols: 80, rows: 24 }, 'running', { id: 'w-keep-2', generation: '2' });
    w2.session.keepAlive = true;
    w2.session.keepAliveRevision = 1;
    backend.state.workspace = { id: 'w-keep-2', generation: '2' };
    document.dispatchEvent(new dom.window.CustomEvent('pi-gui:git-scope'));
    await until(() => host.querySelector('.terminal-tab')?.dataset.terminalId === w2.session.id);
    ok('Keep Alive follows the session across a workspace switch', () => {
      assert.equal(keepButton().getAttribute('aria-pressed'), 'true');
      assert.equal(host.querySelector('.terminal-tab').dataset.keepAlive, 'true');
      assert.equal(backend.model.get(w2.session.id).session.keepAlive, true);
    });

    backend.state.workspace = { id: 'w-keep', generation: '1' };
    document.dispatchEvent(new dom.window.CustomEvent('pi-gui:git-scope'));
    await until(() => [...host.querySelectorAll('.terminal-tab')]
      .some((tab) => tab.dataset.terminalId === restartedId));
    ok('returning to the first workspace restores its own off state', () => {
      assert.equal(keepButton().getAttribute('aria-pressed'), 'false');
      assert.equal(host.querySelector('.terminal-tab').dataset.keepAlive, 'false');
      assert.equal(backend.model.get(restartedId).session.keepAlive, false);
    });

    backend.state.workspace = { id: 'w-keep-2', generation: '2' };
    document.dispatchEvent(new dom.window.CustomEvent('pi-gui:git-scope'));
    await until(() => host.querySelector('.terminal-tab')?.dataset.terminalId === w2.session.id);

    view.dispose();
    host.replaceChildren();
    const reopenedViews = [];
    const reopened = fakeView();
    mountTerminalPanel(host, reopened, {
      transport: backend.transport,
      createTerminalView: () => {
        const next = fakeTerminalView();
        reopenedViews.push(next);
        return next;
      },
    });
    await until(() => host.querySelector('.terminal-tab')?.dataset.terminalId === w2.session.id
      && reopenedViews.length === 1
      && host.querySelector('.rp-head-sub')?.textContent.includes('运行中'));
    ok('reopening the panel restores Keep Alive from the live session', () => {
      assert.equal(keepButton().getAttribute('aria-pressed'), 'true');
      assert.equal(host.querySelector('.terminal-tab').dataset.keepAlive, 'true');
      assert.equal(reopenedViews[0].disposed, false);
    });

    /* Let one poll snapshot the current session, then toggle off before that
     * snapshot is delivered. The stale response must not resurrect the button. */
    const originalRead = backend.transport.read;
    let releaseRead;
    let heldResolve;
    const held = new Promise((resolve) => { heldResolve = resolve; });
    let releaseNext;
    let nextHeldResolve;
    const nextHeld = new Promise((resolve) => { nextHeldResolve = resolve; });
    let hold = true;
    let holdNext = false;
    backend.transport.read = async (id, since) => {
      const snapshot = await originalRead(id, since);
      if (id === w2.session.id) {
        if (hold) {
          hold = false;
          heldResolve();
          await new Promise((resolve) => { releaseRead = resolve; });
        } else if (holdNext) {
          holdNext = false;
          nextHeldResolve();
          await new Promise((resolve) => { releaseNext = resolve; });
        }
      }
      return snapshot;
    };
    await held;
    keepButton().click();
    await until(() => backend.calls.keepAlive.at(-1)?.[0] === w2.session.id
      && keepButton().getAttribute('aria-pressed') === 'false');
    /* Also hold the next fresh poll. Otherwise an unguarded stale snapshot
     * would be corrected by the 60ms poll before the assertion runs, and the
     * test would pass without the revision guard it is meant to prove. */
    holdNext = true;
    releaseRead();
    await nextHeld;
    await tick(10);
    ok('a late poll cannot overwrite the newest Keep Alive state', () => {
      assert.deepEqual(backend.calls.keepAlive.at(-1), [w2.session.id, false]);
      assert.equal(backend.model.get(w2.session.id).session.keepAlive, false);
      assert.equal(keepButton().getAttribute('aria-pressed'), 'false');
      assert.equal(host.querySelector('.terminal-tab').dataset.keepAlive, 'false');
    });
    releaseNext();
    await tick(100);
    backend.transport.read = originalRead;

    backend.state.keepAliveFailure = {
      ok: false,
      code: 'terminal_unavailable',
      error: '保持运行状态更新失败。',
    };
    keepButton().click();
    await until(() => host.querySelector('.terminal-notice')?.textContent.includes('保持运行状态更新失败'));
    ok('a failed toggle keeps the real off state and reports it once', () => {
      assert.equal(backend.model.get(w2.session.id).session.keepAlive, false);
      assert.equal(keepButton().getAttribute('aria-pressed'), 'false');
      assert.equal(host.querySelector('.terminal-tab').dataset.keepAlive, 'false');
      assert.equal(host.querySelector('.terminal-notice').hidden, false);
    });
    backend.state.keepAliveFailure = null;

    reopened.dispose();
    host.replaceChildren();
  }

  {
    /* A close that gets no definitive answer must not hide a possibly live PTY.
     * Keep the tab and let the user retry once the backend is reachable again. */
    const backend = multiBackend({ workspace: { id: 'w-close-failure', generation: '1' } });
    const view = fakeView();
    mountTerminalPanel(host, view, {
      transport: backend.transport,
      createTerminalView: () => fakeTerminalView(),
    });
    await until(() => backend.calls.create.length === 1 && host.querySelectorAll('.terminal-tab').length === 1);
    const id = [...backend.model.keys()][0];
    backend.state.closeFailure = { ok: false, code: 'workspace_check_failed', error: '工作区暂时不可用' };
    host.querySelector('.terminal-tab-close').click();
    await until(() => host.querySelector('.terminal-notice')?.textContent.includes('工作区暂时不可用'));
    ok('a close without a definitive answer keeps the tab for a retry', () => {
      assert.equal(host.querySelectorAll('.terminal-tab').length, 1);
      assert.equal(host.querySelector('.terminal-tab').dataset.terminalId, id);
      assert.equal(backend.model.get(id).removed, false);
      assert.equal(host.querySelector('.terminal-new').disabled, false);
    });
    backend.state.closeFailure = null;
    host.querySelector('.terminal-tab-close').click();
    await until(() => host.querySelectorAll('.terminal-tab').length === 0);
    ok('retrying the same tab after the backend recovers closes it', () => {
      assert.equal(backend.model.get(id).removed, true);
      assert.equal(host.querySelector('.terminal-empty').hidden, false);
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    /* Boot with existing sessions: no start/create, no duplicate PTY. */
    const backend = multiBackend();
    const first = backend.addExisting({ cols: 90, rows: 20 });
    const second = backend.addExisting({ cols: 110, rows: 28 }, 'exited');
    const views = [];
    const view = fakeView();
    mountTerminalPanel(host, view, {
      transport: backend.transport,
      createTerminalView: () => {
        const next = fakeTerminalView();
        views.push(next);
        return next;
      },
    });
    await until(() => host.querySelectorAll('.terminal-tab').length === 2 && views.length === 2);
    await tick(40);
    ok('opening the panel lists the workspace sessions without spawning', () => {
      assert.equal(backend.calls.create.length, 0);
      assert.equal(backend.calls.start.length, 0);
      assert.deepEqual(
        [...host.querySelectorAll('.terminal-tab')].map((tab) => tab.dataset.terminalId),
        [first.session.id, second.session.id]
      );
      assert.ok(host.querySelectorAll('.terminal-tab')[1].classList.contains('is-active'));
      assert.equal(host.querySelectorAll('.terminal-tab')[1].dataset.state, 'exited');
      const zero = [...new Set(backend.calls.read.filter(([, since]) => since === 0).map(([id]) => id))].sort();
      assert.deepEqual(zero, [first.session.id, second.session.id].sort());
    });
    await until(() => host.querySelector('.rp-head-actions button:last-child')?.textContent === '重启');
    ok('an already-exited session is shown as restartable, not running', () => {
      assert.ok(host.querySelector('.rp-head-sub').textContent.includes('已退出'));
      assert.equal(host.querySelector('#term-view-' + first.session.id).hidden, true);
      assert.equal(host.querySelector('#term-view-' + second.session.id).hidden, false);
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    /* A double click on + must not create two PTYs. */
    const backend = multiBackend();
    const view = fakeView();
    mountTerminalPanel(host, view, {
      transport: backend.transport,
      createTerminalView: () => fakeTerminalView(),
    });
    await until(() => backend.calls.create.length === 1 && host.querySelectorAll('.terminal-tab').length === 1);
    host.querySelector('.terminal-new').click();
    host.querySelector('.terminal-new').click();
    await tick(100);
    ok('a create already in flight blocks a second click from spawning a duplicate', () => {
      assert.equal(backend.calls.create.length, 2);
      assert.equal(host.querySelectorAll('.terminal-tab').length, 2);
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    const backend = multiBackend({ maxPerWorkspace: 2 });
    const view = fakeView();
    mountTerminalPanel(host, view, {
      transport: backend.transport,
      createTerminalView: () => fakeTerminalView(),
    });
    await until(() => backend.calls.create.length === 1 && host.querySelectorAll('.terminal-tab').length === 1);
    host.querySelector('.terminal-new').click();
    await until(() => backend.calls.create.length === 2 && host.querySelectorAll('.terminal-tab').length === 2);
    await tick(20);
    ok('the new-terminal control stops at the per-workspace cap', () => {
      const newButton = host.querySelector('.terminal-new');
      assert.equal(newButton.disabled, true);
      assert.ok(newButton.title.includes('上限'));
    });
    const before = backend.calls.create.length;
    host.querySelector('.terminal-new').click();
    await tick(50);
    ok('a disabled new-terminal control sends no request', () => {
      assert.equal(backend.calls.create.length, before);
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    const backend = multiBackend();
    backend.state.createFailure = { ok: false, code: 'terminal_limit', error: '当前工作区的终端数量已达上限，请先关闭一个终端。' };
    const view = fakeView();
    mountTerminalPanel(host, view, {
      transport: backend.transport,
      createTerminalView: () => fakeTerminalView(),
    });
    await until(() => host.querySelector('.terminal-empty')?.hidden === false
      && host.querySelector('.terminal-empty-title')?.textContent.includes('无法新建终端'), 'create failure state');
    ok('a create failure is an explicit empty/error state, not a blank surface', () => {
      assert.ok(host.querySelector('.terminal-notice').textContent.includes('上限'));
      assert.equal(host.querySelectorAll('.terminal-tab').length, 0);
      assert.equal(host.querySelector('.rp-head-actions button:last-child').textContent, '重试');
    });
    backend.state.createFailure = null;
    host.querySelector('.terminal-empty-action').click();
    await until(() => host.querySelectorAll('.terminal-tab').length === 1, 'retry create');
    ok('retrying after a create failure starts exactly one terminal', () => {
      assert.equal(backend.calls.create.length, 2);
      assert.equal(host.querySelectorAll('.terminal-tab').length, 1);
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    const backend = multiBackend();
    backend.state.listFailure = { ok: false, network: true };
    const view = fakeView();
    mountTerminalPanel(host, view, {
      transport: backend.transport,
      createTerminalView: () => fakeTerminalView(),
    });
    await until(() => host.querySelector('.terminal-empty-title')?.textContent.includes('无法启动终端'), 'list failure state');
    ok('a list failure is retryable and never shows a stale id as running', () => {
      assert.equal(host.querySelectorAll('.terminal-tab').length, 0);
      assert.ok(host.querySelector('.terminal-empty-hint').textContent.includes('无法连接'));
      assert.equal(host.querySelector('.rp-head-actions button:last-child').textContent, '重试');
    });
    backend.state.listFailure = null;
    host.querySelector('.rp-head-actions button:last-child').click();
    await until(() => backend.calls.create.length === 1 && host.querySelectorAll('.terminal-tab').length === 1);
    ok('retrying the boot path creates one terminal', () => {
      assert.equal(host.querySelectorAll('.terminal-tab').length, 1);
      assert.equal(backend.calls.create.length, 1);
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    /* A list sampled before a tab was created must not delete that tab when it
     * lands later. The backend PTY is still running and would otherwise become
     * an orphan that occupies a session slot. */
    let listCalls = 0;
    let releaseCreate = null;
    let releaseList = null;
    const closed = [];
    const view = fakeView();
    const transport = {
      status: async () => ({ ok: true, enabled: true, maxSessionsPerWorkspace: 6 }),
      list: async () => {
        listCalls++;
        if (listCalls === 1) {
          return { ok: true, workspace: { id: 'w1', generation: '1' }, sessions: [terminalSession('s1')] };
        }
        return new Promise((resolve) => {
          releaseList = () => resolve({
            ok: true,
            workspace: { id: 'w1', generation: '1' },
            sessions: [terminalSession('s1')],
          });
        });
      },
      create: () => new Promise((resolve) => {
        releaseCreate = () => resolve({ ok: true, session: { ...terminalSession('s2'), ordinal: 2 } });
      }),
      read: async (id) => ({ ok: true, text: '', cursor: 0, state: 'running', session: terminalSession(id) }),
      write: async () => ({ ok: true }),
      resize: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      close: async (id) => { closed.push(id); return { ok: true, closed: true }; },
    };
    mountTerminalPanel(host, view, {
      transport,
      createTerminalView: () => fakeTerminalView(),
    });
    await until(() => host.querySelectorAll('.terminal-tab').length === 1, 'boot tab');
    host.querySelector('.terminal-new').click();
    await until(() => typeof releaseCreate === 'function', 'deferred create');
    document.dispatchEvent(new window.CustomEvent('pi-gui:git-scope'));
    await until(() => typeof releaseList === 'function', 'deferred scope list');
    releaseCreate();
    await until(() => host.querySelectorAll('.terminal-tab').length === 2, 'new tab mounts');
    releaseList();
    await tick(40);
    ok('a late list snapshot does not remove a tab created while it was in flight', () => {
      assert.deepEqual(
        [...host.querySelectorAll('.terminal-tab')].map((el) => el.dataset.terminalId),
        ['s1', 's2']
      );
      assert.deepEqual(closed, []);
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    /* The opposite race: a list sampled before a close must not add the closed
     * tab back as a dead tab after the close has already succeeded. */
    let listCalls = 0;
    let releaseList = null;
    const closed = [];
    const view = fakeView();
    const transport = {
      status: async () => ({ ok: true, enabled: true, maxSessionsPerWorkspace: 6 }),
      list: async () => {
        listCalls++;
        if (listCalls === 1) {
          return { ok: true, workspace: { id: 'w1', generation: '1' }, sessions: [terminalSession('s1')] };
        }
        return new Promise((resolve) => {
          releaseList = () => resolve({
            ok: true,
            workspace: { id: 'w1', generation: '1' },
            sessions: [terminalSession('s1')],
          });
        });
      },
      create: async () => ({ ok: true, session: { ...terminalSession('s2'), ordinal: 2 } }),
      read: async (id) => ({ ok: true, text: '', cursor: 0, state: 'running', session: terminalSession(id) }),
      write: async () => ({ ok: true }),
      resize: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      close: async (id) => { closed.push(id); return { ok: true, closed: true }; },
    };
    mountTerminalPanel(host, view, {
      transport,
      createTerminalView: () => fakeTerminalView(),
    });
    await until(() => host.querySelectorAll('.terminal-tab').length === 1, 'boot tab');
    document.dispatchEvent(new window.CustomEvent('pi-gui:git-scope'));
    await until(() => typeof releaseList === 'function', 'deferred scope list');
    host.querySelector('.terminal-tab-close').click();
    await until(() => closed.includes('s1') && host.querySelectorAll('.terminal-tab').length === 0, 'closed tab');
    releaseList();
    await tick(40);
    ok('a late same-workspace list does not resurrect an already closed tab', () => {
      assert.deepEqual(closed, ['s1']);
      assert.equal(host.querySelectorAll('.terminal-tab').length, 0);
      assert.equal(host.querySelector('.terminal-empty').hidden, false);
      assert.equal(host.querySelector('.terminal-new').disabled, false);
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    /* Restart must not discard the only tab when its close has no definitive
     * answer; the user needs a visible, retryable control. */
    const backend = multiBackend();
    backend.addExisting({ cols: 90, rows: 20 }, 'exited');
    const view = fakeView();
    const beforeCreate = backend.calls.create.length;
    mountTerminalPanel(host, view, {
      transport: backend.transport,
      createTerminalView: () => fakeTerminalView(),
    });
    await until(() => host.querySelector('.rp-head-actions button:last-child')?.textContent === '重启');
    backend.state.closeFailure = { ok: false, code: 'workspace_check_failed', error: '工作区暂时不可用' };
    host.querySelector('.rp-head-actions button:last-child').click();
    await until(() => host.querySelector('.terminal-notice')?.textContent.includes('工作区暂时不可用'));
    ok('a failed restart keeps the exited tab and spawns no replacement', () => {
      assert.equal(host.querySelectorAll('.terminal-tab').length, 1);
      assert.equal(backend.calls.create.length, beforeCreate);
      assert.equal(host.querySelector('.terminal-tab').dataset.state, 'exited');
      assert.equal(host.querySelector('.rp-head-actions button:last-child').disabled, false);
    });
    backend.state.closeFailure = null;
    host.querySelector('.rp-head-actions button:last-child').click();
    await until(() => backend.calls.create.length === beforeCreate + 1
      && host.querySelectorAll('.terminal-tab').length === 1);
    ok('retrying a failed restart replaces the old tab exactly once', () => {
      assert.equal(host.querySelectorAll('.terminal-tab').length, 1);
      assert.equal(host.querySelector('.terminal-tab').dataset.state, 'running');
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    /* A restart can be deferred by an in-flight scope list. The old exited tab
     * must stay visible through that list so the user can retry; a late
     * snapshot that still contains it must not remove the retry affordance. */
    let listCalls = 0;
    let releaseList = null;
    let createCalls = 0;
    const closed = [];
    const workspace = { id: 'w-restart-scope', generation: '1' };
    const scoped = (id, state = 'running') => ({ ...terminalSession(id, state), workspace });
    const view = fakeView();
    const transport = {
      status: async () => ({ ok: true, enabled: true, maxSessionsPerWorkspace: 6 }),
      list: async () => {
        listCalls++;
        if (listCalls === 1) {
          return { ok: true, workspace, sessions: [scoped('s1', 'exited')] };
        }
        return new Promise((resolve) => {
          releaseList = () => resolve({
            ok: true,
            workspace,
            sessions: [scoped('s1', 'exited')],
          });
        });
      },
      create: async () => {
        createCalls++;
        return { ok: true, session: { ...scoped('s2'), ordinal: 2 } };
      },
      read: async (id) => ({ ok: true, text: '', cursor: 0, state: id === 's1' ? 'exited' : 'running', session: scoped(id, id === 's1' ? 'exited' : 'running') }),
      write: async () => ({ ok: true }),
      resize: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      close: async (id) => { closed.push(id); return { ok: true, closed: true }; },
    };
    mountTerminalPanel(host, view, {
      transport,
      createTerminalView: () => fakeTerminalView(),
    });
    await until(() => host.querySelector('.rp-head-actions button:last-child')?.textContent === '重启');
    document.dispatchEvent(new window.CustomEvent('pi-gui:git-scope'));
    await until(() => typeof releaseList === 'function', 'deferred scope list');
    host.querySelector('.rp-head-actions button:last-child').click();
    await tick(30);
    ok('a restart deferred by a scope list keeps the old tab and creates nothing', () => {
      assert.deepEqual(closed, ['s1']);
      assert.equal(createCalls, 0);
      assert.equal(host.querySelectorAll('.terminal-tab').length, 1);
      assert.equal(host.querySelector('.terminal-tab').dataset.state, 'exited');
    });
    releaseList();
    await tick(40);
    ok('the scope list that deferred the restart does not remove its retry tab', () => {
      assert.equal(host.querySelectorAll('.terminal-tab').length, 1);
      assert.equal(host.querySelector('.terminal-tab').dataset.state, 'exited');
      assert.equal(host.querySelector('.rp-head-actions button:last-child').textContent, '重启');
    });
    host.querySelector('.rp-head-actions button:last-child').click();
    await until(() => createCalls === 1 && host.querySelectorAll('.terminal-tab').length === 1
      && host.querySelector('.terminal-tab').dataset.terminalId === 's2');
    ok('retrying after the scope list settles creates the replacement', () => {
      assert.deepEqual(closed, ['s1', 's1']);
      assert.equal(host.querySelector('.terminal-tab').dataset.state, 'running');
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    /* Boot and scope-sync issue independent lists. A slow boot response must
     * not append workspace A after scope sync already switched to B; a newer
     * scope event must also supersede an older in-flight list. */
    let listCalls = 0;
    let releaseBoot = null;
    let releaseThird = null;
    const view = fakeView();
    const transport = {
      status: async () => ({ ok: true, enabled: true, maxSessionsPerWorkspace: 6 }),
      list: async () => {
        listCalls++;
        if (listCalls === 1) {
          return new Promise((resolve) => {
            releaseBoot = () => resolve({
              ok: true,
              workspace: { id: 'wa', generation: '1' },
              sessions: [terminalSession('a1')],
            });
          });
        }
        if (listCalls === 2) {
          return {
            ok: true,
            workspace: { id: 'wb', generation: '2' },
            sessions: [{ ...terminalSession('b1'), workspace: { id: 'wb', generation: '2' } }],
          };
        }
        if (listCalls === 3) {
          return new Promise((resolve) => {
            releaseThird = () => resolve({
              ok: true,
              workspace: { id: 'wc', generation: '3' },
              sessions: [{ ...terminalSession('c1'), workspace: { id: 'wc', generation: '3' } }],
            });
          });
        }
        return {
          ok: true,
          workspace: { id: 'wd', generation: '4' },
          sessions: [{ ...terminalSession('d1'), workspace: { id: 'wd', generation: '4' } }],
        };
      },
      create: async () => ({ ok: true, session: terminalSession('unused') }),
      read: async (id) => ({ ok: true, text: '', cursor: 0, state: 'running', session: terminalSession(id) }),
      write: async () => ({ ok: true }),
      resize: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      close: async () => ({ ok: true, closed: true }),
    };
    mountTerminalPanel(host, view, {
      transport,
      createTerminalView: () => fakeTerminalView(),
    });
    await until(() => typeof releaseBoot === 'function', 'deferred boot list');
    document.dispatchEvent(new window.CustomEvent('pi-gui:workspace-generation'));
    await until(() => host.querySelector('.terminal-tab')?.dataset.terminalId === 'b1', 'scope switch tab');
    releaseBoot();
    await tick(40);
    ok('a late boot list cannot append the previous workspace after a scope switch', () => {
      assert.deepEqual([...host.querySelectorAll('.terminal-tab')].map((el) => el.dataset.terminalId), ['b1']);
    });

    document.dispatchEvent(new window.CustomEvent('pi-gui:git-scope'));
    await until(() => typeof releaseThird === 'function', 'third list in flight');
    document.dispatchEvent(new window.CustomEvent('pi-gui:git-scope'));
    await until(() => host.querySelector('.terminal-tab')?.dataset.terminalId === 'd1', 'newer scope wins');
    releaseThird();
    await tick(40);
    ok('a newer scope event supersedes an older in-flight list instead of being dropped', () => {
      assert.deepEqual([...host.querySelectorAll('.terminal-tab')].map((el) => el.dataset.terminalId), ['d1']);
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    /* A scope event during boot can start a list before status returns. The
     * boot list then supersedes it; the discarded scope response must not
     * leave `scopeSyncPending` stuck and disable New/Restart forever. */
    let releaseStatus = null;
    let releaseScopeList = null;
    let listCalls = 0;
    let createCalls = 0;
    const view = fakeView();
    const transport = {
      status: () => new Promise((resolve) => {
        releaseStatus = () => resolve({ ok: true, enabled: true, maxSessionsPerWorkspace: 6 });
      }),
      list: async () => {
        listCalls++;
        if (listCalls === 1) {
          return new Promise((resolve) => {
            releaseScopeList = () => resolve({
              ok: true,
              workspace: { id: 'w1', generation: '1' },
              sessions: [terminalSession('b1')],
            });
          });
        }
        return { ok: true, workspace: { id: 'w1', generation: '1' }, sessions: [terminalSession('b1')] };
      },
      create: async () => {
        createCalls++;
        return { ok: true, session: { ...terminalSession('b2'), ordinal: 2 } };
      },
      read: async (id) => ({ ok: true, text: '', cursor: 0, state: 'running', session: terminalSession(id) }),
      write: async () => ({ ok: true }),
      resize: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      close: async () => ({ ok: true, closed: true }),
    };
    mountTerminalPanel(host, view, {
      transport,
      createTerminalView: () => fakeTerminalView(),
    });
    await until(() => typeof releaseStatus === 'function', 'deferred status');
    document.dispatchEvent(new window.CustomEvent('pi-gui:git-scope'));
    await until(() => typeof releaseScopeList === 'function', 'scope list before boot');
    releaseStatus();
    await until(() => host.querySelector('.terminal-tab')?.dataset.terminalId === 'b1', 'boot list applied');
    await until(() => host.querySelector('.terminal-new')?.disabled === false, 'new terminal re-enabled');
    host.querySelector('.terminal-new').click();
    await until(() => createCalls === 1 && host.querySelectorAll('.terminal-tab').length === 2, 'create after pending clears');
    releaseScopeList();
    await tick(40);
    ok('a boot list that supersedes a scope list clears pending and keeps New usable', () => {
      assert.equal(createCalls, 1);
      assert.deepEqual(
        [...host.querySelectorAll('.terminal-tab')].map((el) => el.dataset.terminalId),
        ['b1', 'b2']
      );
    });
    view.dispose();
    host.replaceChildren();
  }

  {
    /* P2 transports have `close`; a late create from a disposed panel must
     * close (remove) the session instead of stopping it into a hidden tab. */
    let releaseCreate = null;
    const stopped = [];
    const closed = [];
    const views = [];
    const view = fakeView();
    const transport = {
      status: async () => ({ ok: true, enabled: true }),
      list: async () => ({ ok: true, workspace: { id: 'w1', generation: '1' }, sessions: [] }),
      create: () => new Promise((resolve) => { releaseCreate = resolve; }),
      read: async () => ({ ok: true, text: '', cursor: 0, state: 'running', session: terminalSession('s-late2') }),
      write: async () => ({ ok: true }),
      resize: async () => ({ ok: true }),
      stop: async (id) => { stopped.push(id); return { ok: true }; },
      close: async (id) => { closed.push(id); return { ok: true, closed: true }; },
    };
    mountTerminalPanel(host, view, {
      transport,
      createTerminalView: () => {
        const next = fakeTerminalView();
        views.push(next);
        return next;
      },
    });
    await until(() => typeof releaseCreate === 'function', 'deferred create');
    view.dispose();
    releaseCreate({ ok: true, session: terminalSession('s-late2') });
    await tick(30);
    ok('a created session whose panel was disposed is closed, not left running', () => {
      assert.deepEqual(closed, ['s-late2']);
      assert.deepEqual(stopped, []);
      assert.equal(views[0].disposed, true);
    });
    host.replaceChildren();
  }

  {
    /* A reopened panel lists before the old mount's create completes. The new
     * session is not in that list and has no tab; it must be closed even
     * though another mount is alive. */
    let releaseFirst = null;
    let creates = 0;
    const closed = [];
    const transport = {
      status: async () => ({ ok: true, enabled: true }),
      list: async () => ({ ok: true, workspace: { id: 'w1', generation: '1' }, sessions: [] }),
      create: () => {
        creates++;
        if (creates === 1) return new Promise((resolve) => { releaseFirst = resolve; });
        return Promise.resolve({ ok: true, session: terminalSession('s-b') });
      },
      read: async (id) => ({ ok: true, text: '', cursor: 0, state: 'running', session: terminalSession(id) }),
      write: async () => ({ ok: true }),
      resize: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      close: async (id) => { closed.push(id); return { ok: true, closed: true }; },
    };
    const hostA = document.createElement('div');
    document.body.append(hostA);
    const viewA = fakeView();
    mountTerminalPanel(hostA, viewA, { transport, createTerminalView: () => fakeTerminalView() });
    await until(() => typeof releaseFirst === 'function', 'deferred create A');
    viewA.dispose();
    hostA.remove();

    const hostB = document.createElement('div');
    document.body.append(hostB);
    const viewB = fakeView();
    mountTerminalPanel(hostB, viewB, { transport, createTerminalView: () => fakeTerminalView() });
    await until(() => hostB.querySelectorAll('.terminal-tab').length === 1, 'reopened tab');
    releaseFirst({ ok: true, session: terminalSession('s-orphan') });
    await tick(30);
    ok('a late create that the reopened panel did not list is closed, not orphaned', () => {
      assert.deepEqual(closed, ['s-orphan']);
      assert.equal(hostB.querySelectorAll('.terminal-tab').length, 1);
      assert.equal(hostB.querySelector('.terminal-tab').dataset.terminalId, 's-b');
    });
    viewB.dispose();
    hostB.remove();
  }

  {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui4-pane.css'), 'utf8');
    ok('terminal tabs scroll horizontally and long labels ellipsize without reflowing the pane', () => {
      assert.match(css, /\.terminal-tablist\{[^}]*overflow-x:auto/s);
      assert.match(css, /\.terminal-tab\{[^}]*max-width:170px/s);
      assert.match(css, /\.terminal-tab-label\{[^}]*text-overflow:ellipsis/s);
      assert.match(css, /\.terminal-new\{[^}]*flex:none/s);
      assert.match(css, /\.terminal-keepalive\{[^}]*display:inline-flex/s);
      assert.match(css, /\.terminal-keepalive\[aria-pressed="true"\]\{[^}]*background/s);
      assert.match(css, /\.terminal-tab-keep\[hidden\]\{display:none\}/);
      assert.match(css, /\.terminal-surface \.term-host \.term-view\{[^}]*position:absolute/s);
    });
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
    const view = fakeView();
    const pending = [];
    const workspace = { id: 'new-workspace', generation: '2' };
    const file = { type: 'file', name: 'README.md', path: 'README.md', bytes: 4 };
    const list = () => new Promise((resolve) => pending.push(resolve));
    mountFilesPanel(host, view, { transport: { list } });
    const tree = host.querySelector('.files-tree');
    const refresh = [...host.querySelectorAll('.rp-head-actions button')].find((button) => button.textContent === '刷新');
    const finishRoot = async (result) => {
      pending.shift()(result);
      await tick();
    };

    ok('files announces the initial root load', () => {
      assert.match(tree.textContent, /正在读取项目文件/);
    });
    await finishRoot({ ok: false, error: '无法读取项目文件。' });
    ok('initial root read failure is neither no-project nor empty, and refresh stays available', () => {
      assert.doesNotMatch(tree.textContent, /还没有打开项目|这个目录没有可显示的文件/);
      assert.match(host.textContent, /无法读取项目文件/);
      assert.equal(refresh.disabled, false);
    });
    refresh.click();
    await finishRoot({ ok: true, workspace, entries: [] });
    ok('successful empty root displays the empty-directory message', () => {
      assert.match(tree.textContent, /这个目录没有可显示的文件/);
      assert.equal(host.querySelector('.files-message').hidden, true);
    });
    refresh.click();
    await finishRoot({ ok: true, workspace, entries: [file] });
    ok('refresh can recover the file tree after an error', () => {
      assert.equal(tree.querySelector('.files-entry').dataset.filePath, file.path);
    });

    refresh.click();
    const finishOld = pending.shift();
    host.ownerDocument.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-generation'));
    await finishRoot({ ok: true, workspace, entries: [file] });
    finishOld({ ok: false, error: '旧工作区读取失败' });
    await tick();
    ok('a late root failure cannot replace the new workspace tree', () => {
      assert.equal(tree.querySelector('.files-entry').dataset.filePath, file.path);
      assert.doesNotMatch(host.textContent, /旧工作区读取失败/);
    });
    refresh.click();
    const finishClassic = pending.shift();
    const { setGitConversationScope } = await import('../public/api.js');
    setGitConversationScope('fixture-runtime');
    ok('focusing a Runtime conversation reloads files even without a workspace generation change', () => {
      assert.equal(pending.length, 1);
    });
    await finishRoot({ ok: true, workspace, entries: [file] });
    finishClassic({ ok: false, error: 'Classic 读取失败' });
    await tick();
    ok('a late Classic failure cannot replace Runtime files', () => {
      assert.equal(tree.querySelector('.files-entry').dataset.filePath, file.path);
      assert.doesNotMatch(host.textContent, /Classic 读取失败/);
    });
    refresh.click();
    await finishRoot({ ok: true, noProject: true, workspace: null, entries: [] });
    ok('only explicit noProject displays the closed-project message', () => {
      assert.match(tree.textContent, /还没有打开项目/);
      assert.equal(host.querySelector('.files-message').hidden, true);
    });
    view.dispose();
    setGitConversationScope(null);
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
