'use strict';
// Window presentation only. No renderer-supplied paths, CSS or arbitrary IPC.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const THEME_PALETTE = Object.freeze({
  dark: Object.freeze({ background: '#111111', symbol: '#c3c2b7' }),
  light: Object.freeze({ background: '#fbfbf9', symbol: '#52514e' }),
});
const valid = value => typeof value === 'string' && ['dark', 'light', 'system'].includes(value);

function createDesktopTheme({ ipcMain, nativeTheme, getWindow, origin, preferenceFile }) {
  let preference = 'dark', revision = 0, persisted = true, registered = false;
  try {
    if (fs.statSync(preferenceFile).size <= 4096) {
      const saved = JSON.parse(fs.readFileSync(preferenceFile, 'utf8'));
      if (saved?.version === 1 && valid(saved.preference)) preference = saved.preference;
    }
  } catch { /* Missing/corrupt preference never gets overwritten on startup. */ }
  nativeTheme.themeSource = preference;
  const resolved = () => preference === 'system' ? nativeTheme.shouldUseDarkColors ? 'dark' : 'light' : preference;
  const snapshot = () => ({ preference, resolved: resolved(), revision, persisted });
  function trusted(event) {
    const win = getWindow();
    if (!win || win.isDestroyed() || event?.sender !== win.webContents || !event.senderFrame || event.senderFrame !== win.webContents.mainFrame) return false;
    try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
  }
  function windowOptions() {
    const color = THEME_PALETTE[resolved()];
    return { backgroundColor: color.background, titleBarOverlay: { color: color.background, symbolColor: color.symbol, height: 46 } };
  }
  function applyWindow() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    const options = windowOptions();
    win.setBackgroundColor(options.backgroundColor);
    if (process.platform !== 'darwin') win.setTitleBarOverlay(options.titleBarOverlay);
    if (trusted({ sender: win.webContents, senderFrame: win.webContents.mainFrame })) win.webContents.send('pi-gui:theme-changed', snapshot());
  }
  function save() {
    const temporary = preferenceFile + '.' + randomUUID() + '.tmp';
    try {
      fs.mkdirSync(path.dirname(preferenceFile), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, preference }), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, preferenceFile); persisted = true;
    } catch { persisted = false; /* Fixed boolean only; no filesystem error/path reaches renderer. */ }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  function onSystemChanged() { if (preference === 'system') { revision++; applyWindow(); } }
  const onSnapshot = event => { event.returnValue = trusted(event) ? snapshot() : null; };
  function register() {
    if (registered) return; registered = true;
    ipcMain.on('pi-gui:theme-snapshot', onSnapshot);
    ipcMain.handle('pi-gui:theme-set', (event, mode) => {
      if (!trusted(event)) return { ok: false, error: 'forbidden' };
      if (!valid(mode)) return { ok: false, error: 'invalid_theme' };
      preference = mode; revision++; nativeTheme.themeSource = mode; save(); applyWindow();
      return { ok: true, snapshot: snapshot() };
    });
    nativeTheme.on('updated', onSystemChanged);
  }
  function dispose() {
    if (!registered) return; registered = false;
    ipcMain.removeListener('pi-gui:theme-snapshot', onSnapshot);
    ipcMain.removeHandler('pi-gui:theme-set'); nativeTheme.removeListener('updated', onSystemChanged);
  }
  return { snapshot, windowOptions, applyWindow, register, dispose };
}
module.exports = { createDesktopTheme, THEME_PALETTE };
