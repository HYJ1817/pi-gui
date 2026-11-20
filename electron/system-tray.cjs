'use strict';

// One native Tray. Never create a window, restart a service or answer an approval.
function createSystemTray({ Tray, Menu, icon, getWindow, quit, platform = process.platform } = {}) {
  let tray = null, behavior = 'quit', exiting = false, systemEnding = false;
  const supported = platform === 'win32' && !!icon && typeof Tray === 'function';
  function restore() {
    const win = getWindow();
    if (exiting || systemEnding || !win || win.isDestroyed()) return false;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    return true;
  }
  function ensure() {
    if (tray && !tray.isDestroyed()) return;
    if (!supported || exiting || systemEnding) throw Error('tray_unavailable');
    const created = new Tray(icon);
    try {
      created.setToolTip('pi-GUI');
      created.setContextMenu(Menu.buildFromTemplate([
        { label: '显示 pi-GUI', click: restore },
        { type: 'separator' },
        { label: '退出应用', click: quit },
      ]));
      created.on('click', restore);
      created.on('double-click', restore);
      tray = created;
    } catch (error) { created.destroy(); throw error; }
  }
  function destroy() {
    try { tray?.destroy(); tray = null; } catch { /* Keep handle for a later cleanup attempt. */ }
  }
  function apply(value) {
    if (value === 'tray') ensure();
    if (value === 'quit' && tray) {
      // Keep the working tray and policy until a hidden window is reachable.
      // A native restore failure must not strand the application without it.
      if (!getWindow()?.isVisible() && !restore()) throw Error('window_restore_failed');
      destroy();
    }
    behavior = value;
  }
  function hideOnClose(event) {
    if (exiting || systemEnding || behavior !== 'tray' || event.defaultPrevented) return false;
    const win = getWindow();
    if (!win || win.isDestroyed()) return false;
    try {
      ensure();
      win.hide();
    } catch { return false; /* Fail open to the normal quit path. */ }
    event.preventDefault();
    return true;
  }
  return {
    supported, ensure, apply, restore, hideOnClose,
    dispose() { exiting = true; destroy(); },
    beginQuit() { exiting = true; },
    markSystemEnding() { systemEnding = true; },
    behavior: () => behavior, exiting: () => exiting || systemEnding, isSystemEnding: () => systemEnding,
  };
}
module.exports = { createSystemTray };
