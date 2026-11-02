// Opt-in fault injection for the desktop smoke's native capture preconditions.
// Run with the same TEMP-only parent contract as g2-electron-smoke.cjs.
const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, BrowserWindow } = require('electron');
process.env.G2_SMOKE_NATIVE_PROBE = '1';
const handle = ipcMain.handle.bind(ipcMain);
const observations = [];
const record = entry => {
  observations.push(entry);
  fs.writeFileSync(path.join(process.env.G2_SMOKE_OUTPUT, 'capture-probe.json'), JSON.stringify(observations, null, 2) + '\n');
};
ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
  if (channel === 'pi-gui:browser-set-bounds') {
    record({ event: 'bounds-delayed', rect: args[1] });
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  return listener(...args);
});
app.on('web-contents-created', (_event, contents) => {
  const capture = contents.capturePage.bind(contents);
  contents.capturePage = async (...args) => {
    const parent = BrowserWindow.getAllWindows().find(win => win.contentView.children.some(view => view.webContents === contents));
    const native = parent?.contentView.children.find(view => view.webContents === contents);
    record({ event: 'capture-start', attached: !!native, bounds: native?.getBounds() || null, loading: contents.isLoading() });
    try {
      const result = await capture(...args);
      record({ event: 'capture-result', size: result.getSize(), empty: result.isEmpty() });
      return result;
    } catch (error) {
      record({ event: 'capture-error', name: error.name, message: error.message });
      throw error;
    }
  };
});
require('./g2-electron-smoke.cjs');
