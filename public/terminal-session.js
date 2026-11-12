/* One backend terminal + its xterm frontend.
 *
 * The controller owns the per-session cursor, poll loop, input queue and
 * resize debounce. The panel keeps the controller (and therefore the xterm)
 * mounted while the tab exists, so switching tabs only toggles visibility and
 * never recreates the PTY or loses the scrollback. Disposing the controller
 * frees only frontend resources; the backend session is stopped/closed by an
 * explicit action or by the server's own workspace sweep.
 *
 * Polling and restoring call `read` for observation only. The server's idle
 * clock is refreshed by real keyboard input and new PTY output, never by this
 * loop, so do not add an activity ping here.
 */

const POLL_MS = 60;
const HIDDEN_POLL_MS = 240;
const RETRY_MS = 1000;
const INPUT_BATCH_MS = 8;
const INPUT_CHUNK_BYTES = 16 * 1024;
const RESIZE_DEBOUNCE_MS = 60;
const RESET = '\x1b[0m\x1b[?25h';

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

export function createTerminalSession({
  session,
  transport,
  createView,
  clampSize,
  onState = () => {},
  onScopeStale = () => {},
  view: initialView = null,
  container: initialContainer = null,
} = {}) {
  let current = session;
  let view = initialView;
  let container = initialContainer;
  let alive = true;
  let mounted = false;
  let visible = false;
  let wantVisible = false;
  let busy = true;
  let detached = false;
  let cursor = 0;
  let pollTimer = 0;
  let pollInFlight = false;
  let pollAgain = false;
  let inputTimer = 0;
  let inputPending = '';
  let inputChain = Promise.resolve();
  let resizeTimer = 0;
  let lastSize = null;

  const isAlive = () => alive;
  const running = () => current?.state === 'running';
  const closing = () => current?.state === 'closing' || current?.state === 'stopping';
  const finished = () => current?.state === 'exited' || current?.state === 'failed' || current?.state === 'error';
  const active = () => running() || closing();

  const keepAliveRevision = (session) => (
    Number.isSafeInteger(session?.keepAliveRevision) ? session.keepAliveRevision : 0
  );

  /* Poll, list and keep-alive responses can cross on the wire. A snapshot
   * sampled before a keep-alive toggle must not overwrite the newer flag. */
  function applySession(next) {
    if (!next?.id || next.id !== current?.id) return false;
    if (keepAliveRevision(next) < keepAliveRevision(current)) return false;
    current = next;
    return true;
  }

  function notify() {
    if (alive) onState(controller);
  }

  function writeSystem(text) {
    if (!view || !text) return;
    const atBottom = view.isAtBottom?.() ?? true;
    view.write(`${RESET}\r\n\x1b[2m[${text}]\x1b[0m\r\n`, () => {
      if (atBottom) view.scrollToBottom();
    });
  }

  /* A truncated stream has lost the mode-setting prefix (alternate screen,
   * cursor state, colors). Replaying its tail would feed xterm a state
   * fragment, not a trustworthy screen. Reset instead and say so; the PTY is
   * still alive, so keyboard input and resize keep working. */
  function showTruncatedReplayFallback() {
    view?.reset();
    writeSystem('较早的输出已超出缓存上限，无法完整恢复；显示已重置，输入仍可用。');
  }

  function syncStdin() {
    view?.setStdinEnabled?.(Boolean(alive && visible && !busy && running() && !detached));
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = 0;
    pollAgain = false;
  }

  function schedulePoll(delay = visible ? POLL_MS : HIDDEN_POLL_MS) {
    stopPolling();
    if (!alive || !mounted || !active() || detached) return;
    pollTimer = setTimeout(() => { void poll(); }, delay);
  }

  function applyReadResult(result) {
    if (!result?.ok) return false;
    if (result.truncated) {
      showTruncatedReplayFallback();
    } else if (result.text) {
      const atBottom = view?.isAtBottom?.() ?? true;
      view?.write(result.text, () => {
        if (atBottom) view?.scrollToBottom();
      });
    }
    if (Number.isSafeInteger(result.cursor) && result.cursor >= 0) cursor = result.cursor;
    if (result.session) applySession(result.session);
    if (Number.isInteger(result.exitCode)) current.exitCode = result.exitCode;
    return true;
  }

  function handleReadError(result) {
    const code = result?.code;
    if (code === 'stale_workspace') {
      /* The focused workspace no longer matches this session. Never stop the
       * backend here: the user may return to the original workspace and the
       * panel re-lists it. The panel detaches or re-syncs the whole surface. */
      detached = true;
      stopPolling();
      syncStdin();
      onScopeStale(controller, result);
      return;
    }
    if (code === 'unknown_conversation' || code === 'workspace_unavailable'
      || code === 'unknown_workspace' || code === 'unknown_project') {
      detached = true;
      current.state = 'error';
      current.error = result?.error || '工作区已经不可用。';
      stopPolling();
      syncStdin();
      writeSystem(current.error);
      notify();
      return;
    }
    if (code === 'terminal_missing') {
      current.state = 'exited';
      current.exitCode = null;
      stopPolling();
      syncStdin();
      writeSystem(result?.error || '终端会话已结束。');
      notify();
      return;
    }
    schedulePoll(RETRY_MS);
    notify();
  }

  async function poll() {
    pollTimer = 0;
    if (!alive || !mounted || !current || detached || !active()) return;
    if (pollInFlight) {
      pollAgain = true;
      return;
    }
    const activeSession = current;
    pollInFlight = true;
    const result = await transport.read(activeSession.id, cursor);
    pollInFlight = false;
    const rerun = pollAgain;
    pollAgain = false;
    if (!alive || detached) return;
    if (current?.id !== activeSession.id) return;
    if (!result?.ok) {
      handleReadError(result);
      return;
    }
    applyReadResult(result);
    syncStdin();
    notify();
    if (active()) schedulePoll(rerun ? 0 : (visible ? POLL_MS : HIDDEN_POLL_MS));
  }

  function handleWriteFailure(result) {
    if (result?.code === 'terminal_not_running') {
      if (current) current.state = 'exited';
      syncStdin();
      notify();
      return;
    }
    writeSystem(result?.error || '终端输入没有发出去。');
  }

  function flushInput() {
    inputTimer = 0;
    const data = inputPending;
    inputPending = '';
    if (!data || !alive || detached || !running()) return;
    const activeSession = current;
    for (const chunk of splitInput(data)) {
      inputChain = inputChain.then(async () => {
        if (!alive || detached || current?.id !== activeSession.id || current?.state !== 'running') return;
        const result = await transport.write(activeSession.id, chunk);
        if (!alive || current?.id !== activeSession.id) return;
        if (!result?.ok) handleWriteFailure(result);
      }).catch(() => {
        /* A failed request must not poison the rest of the input queue. */
      });
    }
  }

  function onData(data) {
    if (!alive || detached || !visible || busy || !running() || typeof data !== 'string' || !data) return;
    inputPending += data;
    if (!inputTimer) inputTimer = setTimeout(flushInput, INPUT_BATCH_MS);
  }

  function scheduleResize(cols, rows) {
    if (!alive || !visible || !running() || detached) return;
    if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)) return;
    const size = clampSize(cols, rows);
    if (lastSize && lastSize.cols === size.cols && lastSize.rows === size.rows) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = 0;
      void sendResize(size.cols, size.rows);
    }, RESIZE_DEBOUNCE_MS);
  }

  async function sendResize(cols, rows) {
    if (!alive || !visible || !running() || detached) return;
    const size = clampSize(cols, rows);
    if (lastSize && lastSize.cols === size.cols && lastSize.rows === size.rows) return;
    const activeSession = current;
    const result = await transport.resize(activeSession.id, size.cols, size.rows);
    if (!alive || current?.id !== activeSession.id) return;
    if (result?.ok) {
      lastSize = { cols: size.cols, rows: size.rows };
      if (result.session) applySession(result.session);
      notify();
      return;
    }
    if (result?.code === 'terminal_not_running') {
      current.state = 'exited';
      syncStdin();
      notify();
      return;
    }
    if (!result?.network) writeSystem(result?.error || '终端尺寸没有同步。');
  }

  async function restore() {
    const activeSession = current;
    const result = await transport.read(activeSession.id, 0);
    if (!alive || current?.id !== activeSession.id) return;
    busy = false;
    if (!result?.ok) {
      handleReadError(result);
      syncStdin();
      notify();
      return;
    }
    applyReadResult(result);
    view?.scrollToBottom();
    syncStdin();
    notify();
    if (active()) schedulePoll(0);
  }

  async function mount(element) {
    container = initialContainer || element;
    container.hidden = true;
    if (!view) {
      try {
        view = await createView(container);
      } catch {
        view = null;
      }
    }
    if (!alive) {
      view?.dispose?.();
      view = null;
      return false;
    }
    if (!view) {
      busy = false;
      current.state = 'error';
      current.error = '终端组件无法加载。';
      syncStdin();
      notify();
      return false;
    }
    view.onData?.(onData);
    view.onResize?.(({ cols, rows }) => scheduleResize(cols, rows));
    lastSize = Number.isSafeInteger(current.cols) && Number.isSafeInteger(current.rows)
      ? { cols: current.cols, rows: current.rows }
      : null;
    mounted = true;
    await restore();
    if (alive && wantVisible) {
      visible = true;
      container.hidden = false;
      view.fit?.();
      const size = view.getSize?.();
      if (size) scheduleResize(size.cols, size.rows);
      view.focus?.();
      schedulePoll(0);
      syncStdin();
    }
    return Boolean(alive && view);
  }

  function show(next) {
    const value = Boolean(next) && alive;
    wantVisible = value;
    if (!mounted) return;
    if (value === visible) return;
    visible = value;
    if (container) container.hidden = !value;
    if (value) {
      /* Fit only while visible; hidden containers report meaningless sizes. */
      requestAnimationFrame(() => {
        if (!alive || !visible) return;
        view?.fit?.();
        const size = view?.getSize?.();
        if (size) scheduleResize(size.cols, size.rows);
        view?.focus?.();
        schedulePoll(0);
      });
    } else {
      clearTimeout(resizeTimer);
      resizeTimer = 0;
    }
    syncStdin();
  }

  function fit() {
    if (!alive || !mounted || !visible) return;
    view?.fit?.();
    const size = view?.getSize?.();
    if (size) scheduleResize(size.cols, size.rows);
  }

  function focus() {
    if (alive && visible) view?.focus?.();
  }

  function clearScreen() {
    if (!alive) return;
    view?.clear?.();
    focus();
  }

  function refreshTheme() {
    view?.refreshTheme?.();
  }

  function getSize() {
    const size = view?.getSize?.();
    if (size && Number.isSafeInteger(size.cols) && Number.isSafeInteger(size.rows)) return size;
    if (Number.isSafeInteger(current.cols) && Number.isSafeInteger(current.rows)) {
      return { cols: current.cols, rows: current.rows };
    }
    return null;
  }

  async function stop() {
    if (!alive) return null;
    const result = await transport.stop(current.id);
    if (!alive) return result;
    if (result?.ok) {
      if (result.session) applySession(result.session);
      if (current.state === 'running') current.state = 'closing';
      syncStdin();
      notify();
      schedulePoll(0);
    } else if (result?.code === 'terminal_not_running') {
      current.state = 'exited';
      syncStdin();
      notify();
    } else if (result?.code !== 'terminal_missing') {
      writeSystem(result?.error || '停止终端失败。');
    }
    return result;
  }

  async function close() {
    /* Older backends have no `close`; fall back to stop so the PTY does not
     * outlive the tab, even though the record stays for a later reuse. */
    if (typeof transport.close !== 'function') {
      return typeof transport.stop === 'function' ? stop() : null;
    }
    const result = await transport.close(current.id);
    if (!alive) return result;
    if (!result?.ok && result?.code !== 'terminal_missing') {
      /* The backend may have already retired the session; the tab is still
       * removed locally, but a real failure should be visible. */
      if (result?.code !== 'stale_workspace') writeSystem(result?.error || '关闭终端失败。');
    }
    return result;
  }

  function updateSession(next) {
    if (!alive || !applySession(next)) return;
    syncStdin();
    notify();
  }

  /* The panel probed the focused workspace and confirmed this session still
   * belongs to it. Clear the soft-detached flag without stopping the PTY. */
  function reattach() {
    if (!alive || !detached) return;
    detached = false;
    if (current.state === 'error') {
      notify();
      return;
    }
    syncStdin();
    notify();
    if (mounted && active()) schedulePoll(0);
  }

  function dispose() {
    if (!alive) return;
    alive = false;
    stopPolling();
    clearTimeout(inputTimer);
    clearTimeout(resizeTimer);
    inputTimer = 0;
    resizeTimer = 0;
    inputPending = '';
    try { view?.setStdinEnabled?.(false); } catch { /* view is going away */ }
    view?.dispose?.();
    view = null;
    container?.remove?.();
    container = null;
    mounted = false;
  }

  const controller = {
    id: session.id,
    get session() { return current; },
    get view() { return view; },
    get visible() { return visible; },
    get busy() { return busy; },
    get detached() { return detached; },
    isAlive,
    isRunning: running,
    isClosing: closing,
    isFinished: finished,
    isActive: active,
    mount,
    restore,
    show,
    fit,
    focus,
    clearScreen,
    refreshTheme,
    getSize,
    stop,
    close,
    updateSession,
    reattach,
    dispose,
    writeSystem,
  };
  return controller;
}
