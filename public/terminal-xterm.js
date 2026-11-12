/* xterm.js adapter for the right-pane Terminal.
 *
 * xterm's default theme is deliberately not shipped: colors are read from the
 * same design tokens as the rest of the workbench and refreshed when the
 * resolved light/dark theme changes. The wrapper keeps terminal-panel.js free
 * of xterm internals and lets UI tests inject a small fake view.
 */
import { Terminal } from './vendor/xterm/xterm.mjs';
import { FitAddon } from './vendor/xterm/addon-fit.mjs';

const FALLBACK_THEME = {
  background: '#0d0d0d',
  foreground: '#ffffff',
  cursor: '#ffffff',
  cursorAccent: '#0d0d0d',
  selectionBackground: '#3a3a3a',
  black: '#1f1f1f',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#9dbaf8',
  magenta: '#d8b4fe',
  cyan: '#22d3ee',
  white: '#d4d4d4',
  brightBlack: '#6b6b6b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#bfdbfe',
  brightMagenta: '#e9d5ff',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
};

function custom(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

/* Custom properties may contain var() / color-mix(). A one-off probe asks the
 * browser to resolve them to a concrete color that xterm's parser accepts. */
function resolvedColor(name, fallback) {
  if (!document.body) return fallback;
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;';
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  let value = '';
  try {
    value = getComputedStyle(probe).color;
  } catch {
    value = '';
  }
  probe.remove();
  return value && value !== 'rgba(0, 0, 0, 0)' ? value : fallback;
}

export function readTerminalTheme() {
  const background = resolvedColor('--ds-bg-inset', FALLBACK_THEME.background);
  const foreground = resolvedColor('--ds-text-primary', FALLBACK_THEME.foreground);
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: custom('--term-selection', FALLBACK_THEME.selectionBackground),
    black: custom('--term-ansi-black', FALLBACK_THEME.black),
    red: custom('--term-ansi-red', FALLBACK_THEME.red),
    green: custom('--term-ansi-green', FALLBACK_THEME.green),
    yellow: custom('--term-ansi-yellow', FALLBACK_THEME.yellow),
    blue: custom('--term-ansi-blue', FALLBACK_THEME.blue),
    magenta: custom('--term-ansi-magenta', FALLBACK_THEME.magenta),
    cyan: custom('--term-ansi-cyan', FALLBACK_THEME.cyan),
    white: custom('--term-ansi-white', FALLBACK_THEME.white),
    brightBlack: custom('--term-ansi-bright-black', FALLBACK_THEME.brightBlack),
    brightRed: custom('--term-ansi-bright-red', FALLBACK_THEME.brightRed),
    brightGreen: custom('--term-ansi-bright-green', FALLBACK_THEME.brightGreen),
    brightYellow: custom('--term-ansi-bright-yellow', FALLBACK_THEME.brightYellow),
    brightBlue: custom('--term-ansi-bright-blue', FALLBACK_THEME.brightBlue),
    brightMagenta: custom('--term-ansi-bright-magenta', FALLBACK_THEME.brightMagenta),
    brightCyan: custom('--term-ansi-bright-cyan', FALLBACK_THEME.brightCyan),
    brightWhite: custom('--term-ansi-bright-white', FALLBACK_THEME.brightWhite),
  };
}

function copySelection(term) {
  let text = '';
  try { text = term.getSelection(); } catch { return false; }
  if (!text) return false;
  try {
    const result = navigator.clipboard?.writeText(text);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    /* Clipboard permission can be denied; the selection remains usable. */
  }
  try { term.clearSelection(); } catch { /* noop */ }
  return true;
}

export function createXtermTerminal(container) {
  const term = new Terminal({
    convertEol: false,
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: custom('--ui-font-mono', '"Cascadia Code",Consolas,ui-monospace,SFMono-Regular,monospace'),
    fontSize: 12.5,
    lineHeight: 1.35,
    scrollback: 5000,
    tabStopWidth: 4,
    rightClickSelectsWord: true,
    macOptionIsMeta: true,
    theme: readTerminalTheme(),
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  // Ctrl/Cmd+C copies a selection; without a selection it stays the shell's
  // interrupt character. Paste is handled by xterm's own textarea handler so
  // bracketed paste and multi-line input keep working.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || event.altKey) return true;
    if (event.key.toLowerCase() !== 'c' || !(event.ctrlKey || event.metaKey)) return true;
    return !copySelection(term);
  });

  const fit = () => {
    try { fitAddon.fit(); } catch { /* container may be hidden during a switch */ }
  };
  fit();

  return {
    fit,
    write: (text, callback) => term.write(text, callback),
    focus: () => term.focus(),
    clear: () => term.clear(),
    reset: () => term.reset(),
    scrollToBottom: () => term.scrollToBottom(),
    isAtBottom: () => {
      try { return term.buffer.active.viewportY >= term.buffer.active.baseY; } catch { return true; }
    },
    getSize: () => ({ cols: term.cols, rows: term.rows }),
    setStdinEnabled: (enabled) => { term.options.disableStdin = !enabled; },
    refreshTheme: () => { term.options.theme = readTerminalTheme(); },
    onData: (fn) => term.onData(fn),
    onResize: (fn) => term.onResize(fn),
    dispose: () => term.dispose(),
  };
}
