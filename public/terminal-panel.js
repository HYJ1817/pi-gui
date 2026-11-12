/* Project terminal in the existing right pane.
 *
 * The xterm instance is a *frontend* resource. Switching to Files/Changes (or
 * closing the pane) disposes it, but the backend PTY session stays alive; the
 * next mount calls `start`, which reuses the workspace session and replays its
 * bounded output buffer. Only the explicit Stop button, a workspace change,
 * idle timeout or app shutdown end the shell.
 *
 * Keyboard bytes are forwarded verbatim and output is written to xterm
 * verbatim. No newline is appended and CR/ANSI sequences are not normalized.
 */
import { createPaneHeader } from './right-pane.js';
import { openSecondarySurface } from './ui/secondary-surface.js';
import {
  fetchTerminalStatus,
  startTerminal,
  readTerminal,
  writeTerminal,
  resizeTerminal,
  stopTerminal,
} from './api.js';

const POLL_MS = 60;
const RETRY_MS = 1000;
const INPUT_BATCH_MS = 8;
const INPUT_CHUNK_BYTES = 16 * 1024;
const RESIZE_DEBOUNCE_MS = 60;
const RESET = '\x1b[0m\x1b[?25h';

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

/* Mounts and their claimed sessions are module-wide because the backend PTY
 * outlives a frontend mount. A disposed mount's late `start` response must not
 * stop a session that a reopened pane already reused while that response was
 * in flight. */
let liveMounts = 0;
const claimedSessions = new Map();
function claimSession(id) {
  if (!id) return;
  claimedSessions.set(id, (claimedSessions.get(id) || 0) + 1);
}
function releaseSessionClaim(id) {
  if (!id) return;
  const count = (claimedSessions.get(id) || 0) - 1;
  if (count > 0) claimedSessions.set(id, count);
  else claimedSessions.delete(id);
}

export function openTerminalPanel(options = {}) {
  const triggerId = options.triggerId || 'btnTerminal';
  return openSecondarySurface(
    'terminal',
    (host, view) => mountTerminalPanel(host, view, options),
    { label: '终端', headerSelector: '.rp-head', triggerId }
  );
}

function utf8Width(codePoint) {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function splitInput(text) {
  const parts = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    const width = codePoint > 0xffff ? 2 : 1;
    const size = utf8Width(codePoint);
    if (bytes + size > INPUT_CHUNK_BYTES && index > start) {
      parts.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += size;
    index += width;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

export function mountTerminalPanel(host, view, options = {}) {
  liveMounts++;
  host.classList.add('terminal-surface');
  const transport = options.transport || {
    status: fetchTerminalStatus,
    start: startTerminal,
    read: readTerminal,
    write: writeTerminal,
    resize: resizeTerminal,
    stop: stopTerminal,
  };
  const makeView = options.createTerminalView
    ? async (container) => options.createTerminalView(container)
    : async (container) => (await import('./terminal-xterm.js')).createXtermTerminal(container);

  let alive = true;
  let term = null;
  let session = null;
  let cursor = 0;
  let generation = 0;
  let startToken = 0;
  let busy = false;
  let disabled = false;
  let noProject = false;
  let limits = null;
  let claimedId = null;
  let pollTimer = 0;
  let pollInFlight = false;
  let pollAgain = false;
  let inputTimer = 0;
  let inputPending = '';
  let inputChain = Promise.resolve();
  let resizeTimer = 0;
  let fitFrame = 0;
  let lastSize = null;
  let resizeObserver = null;
  let themeObserver = null;
  let headerNode;
  let subtitle;
  let control;
  let clearButton;

  const isCurrent = () => alive && (!view || view.isCurrent());
  const running = () => session?.state === 'running';
  const stopping = () => session?.state === 'stopping';

  /* The server rejects dimensions outside its limits; a narrow/detached pane
   * can make FitAddon report 2×1. Clamp before start/resize instead of failing
   * the whole start or spamming an invalid_size error. */
  function clampSize(cols, rows) {
    const minCols = limits?.minCols ?? 20;
    const maxCols = limits?.maxCols ?? 500;
    const minRows = limits?.minRows ?? 5;
    const maxRows = limits?.maxRows ?? 200;
    return {
      cols: Math.min(Math.max(Math.trunc(cols), minCols), maxCols),
      rows: Math.min(Math.max(Math.trunc(rows), minRows), maxRows),
    };
  }

  function setStatus(text, state = 'idle') {
    if (subtitle) subtitle.textContent = text;
    if (headerNode) headerNode.setAttribute('data-state', state);
  }

  function syncControls() {
    if (!control) return;
    if (!term) {
      control.textContent = '启动';
      control.disabled = true;
    } else if (disabled) {
      control.textContent = '不可用';
      control.disabled = true;
    } else if (busy) {
      control.textContent = '处理中…';
      control.disabled = true;
    } else if (stopping()) {
      control.textContent = '正在停止…';
      control.disabled = true;
    } else if (running()) {
      control.textContent = '停止';
      control.disabled = false;
    } else if (noProject) {
      control.textContent = '重新检测';
      control.disabled = false;
    } else if (session) {
      control.textContent = '重启';
      control.disabled = false;
    } else {
      control.textContent = '启动';
      control.disabled = false;
    }
    if (clearButton) clearButton.disabled = !term;
    term?.setStdinEnabled?.(Boolean(running() && !busy));
  }

  function releaseCurrentClaim() {
    if (!claimedId) return;
    releaseSessionClaim(claimedId);
    claimedId = null;
  }

  function writeSystem(text) {
    if (!term || !text) return;
    const atBottom = term.isAtBottom?.() ?? true;
    term.write(`${RESET}\r\n\x1b[2m[${text}]\x1b[0m\r\n`, () => {
      if (atBottom) term.scrollToBottom();
    });
  }

  function updateState(state, exitCode) {
    if (!session) return;
    if (state) session.state = state;
    if (Number.isInteger(exitCode)) session.exitCode = exitCode;
    if (state === 'running') {
      setStatus(`运行中 · ${session.shell || 'shell'}`, 'running');
    } else if (state === 'stopping') {
      setStatus('正在停止…', 'stopping');
    } else if (state === 'failed') {
      setStatus('启动失败', 'failed');
    } else if (state === 'exited') {
      const code = Number.isInteger(session.exitCode) ? ` (${session.exitCode})` : '';
      setStatus(`已退出${code}`, 'exited');
    } else {
      setStatus('未运行', 'idle');
    }
    syncControls();
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = 0;
    pollAgain = false;
  }

  function schedulePoll(delay = POLL_MS) {
    stopPolling();
    if (!isCurrent() || !session) return;
    pollTimer = setTimeout(() => { void poll(); }, delay);
  }

  function handleReadError(result) {
    const code = result?.code;
    if (code === 'stale_workspace' || code === 'unknown_conversation') {
      releaseCurrentClaim();
      session = null;
      stopPolling();
      setStatus('工作区已变化', 'stale');
      writeSystem(result.error || '工作区已经变化，终端已停止。');
      syncControls();
      return;
    }
    if (code === 'terminal_missing') {
      releaseCurrentClaim();
      session = null;
      stopPolling();
      setStatus('会话已结束', 'exited');
      writeSystem(result.error || '终端会话已结束。');
      syncControls();
      return;
    }
    setStatus('连接中断，正在重试…', 'retry');
    syncControls();
    schedulePoll(RETRY_MS);
  }

  async function poll() {
    pollTimer = 0;
    if (!isCurrent() || !session || pollInFlight) {
      /* A stop/workspace response can schedule an immediate poll while the
       * previous read is still outstanding. Dropping that tick here used to
       * freeze the terminal on 「正在停止…」 forever: the in-flight read then
       * returned to a replaced session object and did not reschedule. */
      if (pollInFlight) pollAgain = true;
      return;
    }
    const active = session;
    const gen = generation;
    pollInFlight = true;
    const result = await transport.read(active.id, cursor);
    pollInFlight = false;
    const rerun = pollAgain;
    pollAgain = false;
    if (!isCurrent() || generation !== gen) return;
    if (session !== active) {
      /* Do not apply a read that started before the stop/start swapped the
       * session object (its state may be stale), but keep the current live
       * session polled. */
      if (session && (session.state === 'running' || session.state === 'stopping')) schedulePoll(rerun ? 0 : POLL_MS);
      return;
    }
    if (!result?.ok) {
      handleReadError(result);
      return;
    }
    const atBottom = term?.isAtBottom?.() ?? true;
    if (result.truncated) term.write(RESET);
    if (result.text) {
      term.write(result.text, () => {
        if (atBottom) term.scrollToBottom();
      });
    }
    if (Number.isSafeInteger(result.cursor) && result.cursor >= 0) cursor = result.cursor;
    if (result.session) session = result.session;
    updateState(result.state || session.state, result.exitCode);
    if (session?.state === 'running' || session?.state === 'stopping') schedulePoll(rerun ? 0 : POLL_MS);
  }

  function handleWriteFailure(result) {
    if (result?.code === 'terminal_not_running') {
      if (session) session.state = 'exited';
      updateState('exited');
      return;
    }
    writeSystem(result?.error || '终端输入没有发出去。');
  }

  function flushInput() {
    inputTimer = 0;
    const data = inputPending;
    inputPending = '';
    if (!data || !isCurrent() || !running()) return;
    const active = session;
    const gen = generation;
    for (const chunk of splitInput(data)) {
      inputChain = inputChain.then(async () => {
        /* Polling replaces `session` with a fresh object on every response.
         * Compare ids so a chunk queued before that response is still sent. */
        if (!isCurrent() || generation !== gen || session?.id !== active.id || session?.state !== 'running') return;
        const result = await transport.write(active.id, chunk);
        if (!isCurrent() || generation !== gen || session?.id !== active.id) return;
        if (!result?.ok) handleWriteFailure(result);
      }).catch(() => {
        /* A failed request must not poison the rest of the input queue. */
      });
    }
  }

  function onData(data) {
    if (!isCurrent() || !running() || busy || typeof data !== 'string' || !data) return;
    inputPending += data;
    if (!inputTimer) inputTimer = setTimeout(flushInput, INPUT_BATCH_MS);
  }

  function scheduleFit() {
    if (!isCurrent() || fitFrame) return;
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      if (!isCurrent() || !term) return;
      term.fit();
    });
  }

  function scheduleResize(cols, rows) {
    if (!running() || !Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)) return;
    const size = clampSize(cols, rows);
    if (lastSize && lastSize.cols === size.cols && lastSize.rows === size.rows) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = 0;
      void sendResize(size.cols, size.rows);
    }, RESIZE_DEBOUNCE_MS);
  }

  async function sendResize(cols, rows) {
    if (!isCurrent() || !running()) return;
    const size = clampSize(cols, rows);
    if (lastSize && lastSize.cols === size.cols && lastSize.rows === size.rows) return;
    const active = session;
    const gen = generation;
    const result = await transport.resize(active.id, size.cols, size.rows);
    if (!isCurrent() || generation !== gen || session?.id !== active.id) return;
    if (result?.ok) {
      lastSize = { cols: size.cols, rows: size.rows };
      if (result.session) session = result.session;
      return;
    }
    if (result?.code === 'terminal_not_running') {
      updateState('exited');
      return;
    }
    if (!result?.network) writeSystem(result?.error || '终端尺寸没有同步。');
  }

  async function restoreSession(active, token, gen) {
    const result = await transport.read(active.id, 0);
    if (!isCurrent() || startToken !== token || generation !== gen || session?.id !== active.id) return;
    if (!result?.ok) {
      handleReadError(result);
      return;
    }
    if (result.truncated) {
      term.write(`${RESET}\x1b[2m[较早的输出已省略]\x1b[0m\r\n`);
    }
    if (result.text) term.write(result.text);
    if (Number.isSafeInteger(result.cursor) && result.cursor >= 0) cursor = result.cursor;
    if (result.session) session = result.session;
    term.scrollToBottom();
    updateState(result.state || session.state, result.exitCode);
  }

  async function start() {
    if (!isCurrent() || !term || busy || disabled) return;
    const token = ++startToken;
    const gen = generation;
    busy = true;
    setStatus('正在启动…', 'starting');
    syncControls();
    term.fit();
    const raw = term.getSize();
    const size = clampSize(raw.cols, raw.rows);
    const result = await transport.start(size);
    if (!isCurrent() || startToken !== token || generation !== gen) {
      /* The panel or workspace changed while the PTY was being created. The
       * late session must be released instead of mounted into the new view.
       * Keep it when it was reused, someone already claims it, another mount
       * is still alive (a reopened pane may reuse it while this response is
       * in flight), or this same mount merely retried within the workspace. */
      const id = result?.session?.id;
      const otherLiveMount = liveMounts > (alive ? 1 : 0);
      const mayBeShared = result?.reused || (id && claimedSessions.has(id))
        || otherLiveMount || (alive && generation === gen);
      if (id && !mayBeShared) void transport.stop(id);
      return;
    }
    busy = false;
    if (!result?.ok) {
      if (result?.code === 'terminal_disabled') {
        disabled = true;
        setStatus('不可用', 'disabled');
      } else if (result?.code === 'terminal_limit' || result?.code === 'terminal_stopping') {
        setStatus('无法启动', 'error');
        writeSystem(result.error || '终端暂时无法启动。');
      } else {
        setStatus('启动失败', 'failed');
        writeSystem(result?.error || '无法启动终端。');
      }
      syncControls();
      return;
    }
    if (result.noProject) {
      noProject = true;
      session = null;
      setStatus('未选择项目', 'idle');
      syncControls();
      return;
    }
    noProject = false;
    if (!result.session?.id) {
      setStatus('启动失败', 'failed');
      writeSystem('后端没有返回终端会话。');
      syncControls();
      return;
    }
    releaseCurrentClaim();
    session = result.session;
    claimSession(session.id);
    claimedId = session.id;
    cursor = 0;
    lastSize = Number.isSafeInteger(session.cols) && Number.isSafeInteger(session.rows)
      ? { cols: session.cols, rows: session.rows }
      : null;
    updateState(session.state);
    await restoreSession(session, token, gen);
    if (!isCurrent() || startToken !== token || generation !== gen || session?.id !== result.session.id) return;
    const now = term.getSize();
    const sizeNow = clampSize(now.cols, now.rows);
    if (!lastSize || lastSize.cols !== sizeNow.cols || lastSize.rows !== sizeNow.rows) {
      scheduleResize(sizeNow.cols, sizeNow.rows);
    }
    term.focus();
    if (session?.state === 'running') schedulePoll(0);
  }

  async function requestStop() {
    if (busy || !session) return;
    const active = session;
    const gen = generation;
    const token = startToken;
    busy = true;
    setStatus('正在停止…', 'stopping');
    syncControls();
    const result = await transport.stop(active.id);
    /* A late stop response must not re-install the old session after a
     * workspace change or a newer start attempt. */
    if (!isCurrent() || generation !== gen || startToken !== token) return;
    /* Polling can replace `session` with a fresh object while the stop request
     * is in flight. Compare by identity, not by object reference, or the
     * control stays disabled on 「处理中…」 forever. */
    if (!session || session.id !== active.id) {
      busy = false;
      syncControls();
      return;
    }
    busy = false;
    if (!result?.ok && result?.code !== 'terminal_missing') {
      setStatus('停止失败', 'error');
      writeSystem(result?.error || '停止终端失败。');
      syncControls();
      return;
    }
    if (result?.session && session?.state !== 'exited') session = result.session;
    if (session && session.state === 'running') session.state = 'stopping';
    if (session?.state === 'exited') {
      /* Polling already observed the real exit while the stop request was in
       * flight. Do not downgrade the UI back to 「正在停止…」. */
      updateState('exited', session.exitCode);
      return;
    }
    setStatus('正在停止…', 'stopping');
    syncControls();
    schedulePoll(0);
  }

  async function retry() {
    if (noProject) {
      noProject = false;
      await probe();
      return;
    }
    if (session && ['running', 'stopping'].includes(session.state)) {
      await requestStop();
      return;
    }
    if (session) {
      /* Reset terminal modes as well as text: a shell that died inside a TUI
       * can leave the alternate screen or cursor state behind. */
      term?.reset();
      releaseCurrentClaim();
      session = null;
      cursor = 0;
    }
    await start();
  }

  async function probe() {
    if (!isCurrent() || busy) return;
    busy = true;
    setStatus('正在检测…', 'starting');
    syncControls();
    const result = await transport.status();
    if (!isCurrent()) return;
    busy = false;
    if (!result?.ok) {
      setStatus('不可用', 'error');
      writeSystem(result?.error || '无法检测终端状态。');
      syncControls();
      return;
    }
    if (!result.enabled) {
      disabled = true;
      setStatus('不可用', 'disabled');
      writeSystem('终端仅在桌面版可用，或需显式启用。');
      syncControls();
      return;
    }
    disabled = false;
    if (result.limits && typeof result.limits === 'object') limits = result.limits;
    await start();
  }

  function clearScreen() {
    term?.clear();
    term?.focus();
  }

  function onWorkspaceChange() {
    if (!alive) return;
    generation++;
    startToken++;
    stopPolling();
    clearTimeout(inputTimer);
    inputTimer = 0;
    inputPending = '';
    clearTimeout(resizeTimer);
    resizeTimer = 0;
    const active = session;
    releaseCurrentClaim();
    session = null;
    cursor = 0;
    lastSize = null;
    busy = false;
    if (active && ['running', 'stopping'].includes(active.state)) {
      /* The request carries the *new* scope header. The backend verifies it,
       * stops the stale session, and answers stale_workspace. */
      void transport.stop(active.id);
    }
    term?.reset();
    setStatus('工作区已变化', 'stale');
    syncControls();
  }

  function installResizeWatcher() {
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(scheduleFit);
      resizeObserver.observe(host);
    }
    window.addEventListener('resize', scheduleFit);
    const fontsReady = document.fonts?.ready;
    if (fontsReady && typeof fontsReady.then === 'function') {
      fontsReady.then(() => scheduleFit()).catch(() => {});
    }
  }

  function installThemeWatcher() {
    if (typeof MutationObserver === 'undefined') return;
    themeObserver = new MutationObserver(() => term?.refreshTheme?.());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-preference'] });
  }

  async function boot() {
    try {
      term = await makeView(host.querySelector('.term-host'));
    } catch {
      if (!isCurrent()) return;
      disabled = true;
      setStatus('不可用', 'disabled');
      writeSystem('终端组件无法加载。');
      syncControls();
      return;
    }
    if (!isCurrent()) {
      term.dispose();
      term = null;
      return;
    }
    term.onData(onData);
    term.onResize(({ cols, rows }) => scheduleResize(cols, rows));
    installResizeWatcher();
    installThemeWatcher();
    term.fit();
    syncControls();
    await probe();
  }

  clearButton = node('button', 'btn tiny rp-btn', '清屏');
  clearButton.type = 'button';
  clearButton.title = '只清除当前显示，不结束后台终端';
  clearButton.onclick = clearScreen;
  control = node('button', 'btn tiny rp-btn', '启动');
  control.type = 'button';
  control.onclick = () => {
    if (running()) void requestStop();
    else void retry();
  };
  const header = createPaneHeader({ title: '终端', subtitle: '正在检测…', actions: [clearButton, control] });
  subtitle = header.subtitle;
  headerNode = header['el'];
  host.append(headerNode);
  const termHost = node('div', 'term-host');
  host.append(termHost);
  syncControls();

  document.addEventListener('pi-gui:workspace-generation', onWorkspaceChange);
  view.onDispose(() => {
    alive = false;
    liveMounts = Math.max(0, liveMounts - 1);
    releaseCurrentClaim();
    generation++;
    startToken++;
    stopPolling();
    clearTimeout(inputTimer);
    inputTimer = 0;
    inputPending = '';
    clearTimeout(resizeTimer);
    resizeTimer = 0;
    if (fitFrame) cancelAnimationFrame(fitFrame);
    fitFrame = 0;
    document.removeEventListener('pi-gui:workspace-generation', onWorkspaceChange);
    window.removeEventListener('resize', scheduleFit);
    resizeObserver?.disconnect();
    resizeObserver = null;
    themeObserver?.disconnect();
    themeObserver = null;
    term?.dispose();
    term = null;
  });

  void boot();
}
