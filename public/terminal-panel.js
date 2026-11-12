/* Project terminal in the existing right pane.
 *
 * Backend contract: a pipe-backed shell, not a PTY. We keep the UI honest:
 * no full-screen programs, bounded output, and the session is stopped when
 * the panel closes or the workspace changes. Output is rendered with
 * textContent only — terminal contents are untrusted project data. */
import { createPaneHeader } from './right-pane.js';
import { openSecondarySurface } from './ui/secondary-surface.js';
import {
  fetchTerminalStatus,
  startTerminal,
  readTerminal,
  writeTerminal,
  stopTerminal,
} from './api.js';

const POLL_MS = 300;
const RETRY_MS = 900;
const MAX_DISPLAY_CHARS = 200 * 1024;
const HISTORY_LIMIT = 100;

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

export function openTerminalPanel(options = {}) {
  const triggerId = options.triggerId || 'btnTerminal';
  return openSecondarySurface(
    'terminal',
    (host, view) => mountTerminalPanel(host, view, options),
    { label: '终端', headerSelector: '.rp-head', triggerId }
  );
}

export function mountTerminalPanel(host, view, options = {}) {
  host.classList.add('terminal-surface');
  const transport = options.transport || {
    status: fetchTerminalStatus,
    start: startTerminal,
    read: readTerminal,
    write: writeTerminal,
    stop: stopTerminal,
  };
  let alive = true;
  let session = null;
  let cursor = 0;
  let pollTimer = 0;
  let busy = false;
  let disabled = false;
  let noProject = false;
  let lastState = 'idle';
  let history = [];
  let historyIndex = 0;
  let historyDraft = '';
  let header;
  let subtitle;
  let output;
  let input;
  let send;
  let control;
  let clear;

  const isCurrent = () => alive && view.isCurrent();
  const running = () => Boolean(session && ['running', 'stopping'].includes(session.state));

  function setStatus(text, state = lastState) {
    lastState = state;
    if (subtitle) subtitle.textContent = text;
    const head = header && header['el'];
    if (head) head.setAttribute('data-state', state);
  }

  function appendOutput(text) {
    if (!text) return;
    const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 24;
    output.append(document.createTextNode(text));
    if (output.textContent.length > MAX_DISPLAY_CHARS) {
      output.textContent = output.textContent.slice(-MAX_DISPLAY_CHARS);
    }
    if (atBottom) output.scrollTop = output.scrollHeight;
  }

  function appendSystem(text) {
    appendOutput((output.textContent && !output.textContent.endsWith('\n') ? '\n' : '') + '[系统] ' + text + '\n');
  }

  function syncControls() {
    if (!control) return;
    if (disabled) {
      control.textContent = '不可用';
      control.disabled = true;
    } else if (busy) {
      control.textContent = '处理中…';
      control.disabled = true;
    } else if (running()) {
      control.textContent = '停止';
      control.disabled = false;
    } else if (noProject) {
      control.textContent = '重新检测';
      control.disabled = false;
    } else {
      control.textContent = session ? '重启' : '启动';
      control.disabled = false;
    }
    const canType = Boolean(session && session.state === 'running' && !busy);
    input.disabled = !canType;
    send.disabled = !canType;
    input.placeholder = canType
      ? '输入命令，Enter 发送'
      : disabled ? '终端仅在桌面版可用' : noProject ? '还没有打开项目' : '终端未运行';
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = 0;
  }

  function schedulePoll(delay = POLL_MS) {
    stopPolling();
    if (!alive || !session) return;
    pollTimer = setTimeout(() => { void poll(); }, delay);
  }

  async function poll() {
    const active = session;
    if (!isCurrent() || !active) return;
    const result = await transport.read(active.id, cursor);
    if (!isCurrent() || session !== active) return;
    if (!result?.ok) {
      const code = result?.code;
      if (code === 'terminal_missing' || code === 'stale_workspace') {
        stopPolling();
        session = null;
        setStatus(code === 'stale_workspace' ? '工作区已变化' : '会话已结束', code === 'stale_workspace' ? 'stale' : 'exited');
        appendSystem(result.error || '终端会话已结束。');
        syncControls();
        return;
      }
      setStatus('连接中断，正在重试…', 'retry');
      syncControls();
      schedulePoll(RETRY_MS);
      return;
    }
    if (result.text) appendOutput(result.text);
    if (result.truncated) {
      appendSystem('较早的输出已被省略。');
    }
    if (Number.isSafeInteger(result.cursor) && result.cursor >= 0) cursor = result.cursor;
    if (result.session) session = result.session;
    const state = result.state || session?.state || 'running';
    if (state === 'running') {
      setStatus(`运行中 · ${session?.shell || 'shell'}`, 'running');
      schedulePoll();
    } else if (state === 'stopping') {
      setStatus('正在停止…', 'stopping');
      schedulePoll();
    } else {
      stopPolling();
      if (session) session.state = state;
      setStatus(state === 'failed' ? '启动失败' : `已退出${Number.isInteger(result.exitCode) ? ' (' + result.exitCode + ')' : ''}`, state);
      syncControls();
    }
  }

  async function start() {
    if (busy || disabled) return;
    busy = true;
    setStatus('正在启动…', 'starting');
    syncControls();
    const result = await transport.start();
    if (!isCurrent()) {
      /* The panel closed while the backend was still spawning. The dispose
       * hook saw no session yet, so release the one that just appeared. */
      if (result?.session?.id) void transport.stop(result.session.id);
      return;
    }
    busy = false;
    if (!result?.ok) {
      if (result?.code === 'terminal_disabled') {
        disabled = true;
        setStatus('不可用', 'disabled');
        appendSystem(result.error || '终端仅在桌面版可用。');
      } else {
        setStatus('启动失败', 'error');
        appendSystem(result?.error || '无法启动终端。');
      }
      syncControls();
      return;
    }
    if (result.noProject) {
      noProject = true;
      session = null;
      setStatus('未选择项目', 'idle');
      appendSystem('还没有打开项目。选择一个项目后再启动终端。');
      syncControls();
      return;
    }
    noProject = false;
    session = result.session || null;
    if (!session?.id) {
      setStatus('启动失败', 'error');
      appendSystem('后端没有返回终端会话。');
      syncControls();
      return;
    }
    cursor = 0;
    appendSystem(`项目终端 · 命令在 ${session.cwd || '项目目录'} 执行。全屏程序（vim、top 等）不受支持。`);
    setStatus(session.state === 'running' ? `运行中 · ${session.shell || 'shell'}` : '已退出',
      session.state === 'running' ? 'running' : 'exited');
    syncControls();
    input.focus();
    schedulePoll(0);
  }

  async function stop() {
    if (busy) return;
    const active = session;
    if (!active) { syncControls(); return; }
    busy = true;
    setStatus('正在停止…', 'stopping');
    syncControls();
    const result = await transport.stop(active.id);
    if (!isCurrent()) return;
    busy = false;
    if (!result?.ok && result?.code !== 'terminal_missing') {
      appendSystem(result?.error || '停止终端失败。');
      setStatus('停止失败', 'error');
      busy = false;
      syncControls();
      return;
    }
    if (session) session.state = 'stopping';
    setStatus('正在停止…', 'stopping');
    syncControls();
    schedulePoll(0);
  }

  async function retry() {
    noProject = false;
    disabled = false;
    if (!session) {
      await probe();
      return;
    }
    if (running()) await stop();
    session = null;
    await start();
  }

  async function probe() {
    if (busy) return;
    busy = true;
    setStatus('正在检测…', 'starting');
    syncControls();
    const result = await transport.status();
    if (!isCurrent()) return;
    busy = false;
    if (!result?.ok) {
      setStatus('不可用', 'error');
      appendSystem(result?.error || '无法检测终端状态。');
      syncControls();
      return;
    }
    if (!result.enabled) {
      disabled = true;
      setStatus('不可用', 'disabled');
      appendSystem('终端仅在桌面版可用，或需显式启用。');
      syncControls();
      return;
    }
    disabled = false;
    noProject = false;
    syncControls();
    await start();
  }

  async function sendCommand() {
    if (!session || session.state !== 'running' || busy) return;
    const text = input.value;
    if (!text.length) return;
    const active = session;
    const payload = text + '\n';
    input.value = '';
    historyIndex = history.length;
    historyDraft = '';
    if (text.trim()) {
      history.push(text);
      if (history.length > HISTORY_LIMIT) history.shift();
      historyIndex = history.length;
    }
    const result = await transport.write(active.id, payload);
    if (!isCurrent() || session !== active) return;
    if (!result?.ok) {
      appendSystem(result?.error || '命令没有发出去。');
      if (result?.code === 'terminal_not_running') {
        session.state = 'exited';
        syncControls();
      }
      return;
    }
    schedulePoll();
  }

  function clearOutput() {
    output.textContent = '';
    output.focus();
  }

  function onWorkspaceChange() {
    if (!alive) return;
    const active = session;
    session = null;
    stopPolling();
    if (active && ['running', 'stopping'].includes(active.state)) {
      void transport.stop(active.id);
    }
    setStatus('工作区已变化', 'stale');
    appendSystem('工作区已经变化，终端已停止。请重新启动。');
    syncControls();
  }

  document.addEventListener('pi-gui:workspace-generation', onWorkspaceChange);
  view.onDispose(() => {
    alive = false;
    stopPolling();
    document.removeEventListener('pi-gui:workspace-generation', onWorkspaceChange);
    const active = session;
    session = null;
    if (active && ['running', 'stopping'].includes(active.state)) {
      void transport.stop(active.id);
    }
  });

  clear = node('button', 'btn tiny rp-btn', '清屏');
  clear.type = 'button';
  clear.title = '只清除这里的显示，不结束会话';
  clear.onclick = clearOutput;
  control = node('button', 'btn tiny rp-btn', '启动');
  control.type = 'button';
  control.onclick = () => {
    if (running()) void stop();
    else void retry();
  };
  header = createPaneHeader({ title: '终端', subtitle: '正在检测…', actions: [clear, control] });
  subtitle = header.subtitle;
  host.append(header['el']);

  output = node('pre', 'term-output rp-scroll');
  output.tabIndex = 0;
  output.setAttribute('role', 'log');
  output.setAttribute('aria-label', '终端输出');
  output.setAttribute('aria-live', 'off');
  host.append(output);
  output.addEventListener('click', () => input.focus());

  const compose = node('div', 'term-compose');
  const prompt = node('span', 'term-prompt', '›');
  prompt.setAttribute('aria-hidden', 'true');
  input = node('input', 'term-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', '终端命令');
  send = node('button', 'btn tiny term-send', '发送');
  send.type = 'button';
  send.onclick = () => void sendCommand();
  compose.append(prompt, input, send);
  host.append(compose);

  const hint = node('p', 'term-hint', 'Enter 发送 · ↑↓ 历史 · Ctrl+L 清屏');
  host.append(hint);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      void sendCommand();
      return;
    }
    if (event.key === 'ArrowUp') {
      if (!history.length) return;
      event.preventDefault();
      if (historyIndex === history.length) historyDraft = input.value;
      historyIndex = Math.max(0, historyIndex - 1);
      input.value = history[historyIndex] || '';
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    if (event.key === 'ArrowDown') {
      if (historyIndex >= history.length) return;
      event.preventDefault();
      historyIndex = Math.min(history.length, historyIndex + 1);
      input.value = historyIndex === history.length ? historyDraft : (history[historyIndex] || '');
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    if (event.key.toLowerCase() === 'l' && event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      clearOutput();
    }
  });

  syncControls();
  void probe();
}
