'use strict';

const LABELS = Object.freeze({
  node: 'Node.js 24 LTS（含 npm）',
  pi: 'Pi Coding Agent（npm 官方包）',
  git: 'Git for Windows（MinGit，可选）',
});

function installEnvironmentSetup({ ipcMain, dialog, getWindow, getServer, origin }) {
  let pending = false;
  let sequence = 0;
  const unavailable = { ok: false, code: 'install-unavailable', error: '安装服务暂不可用，请重试。' };

  function trusted(event) {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) return false;
    try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
  }

  function call(child, frame) {
    if (!child.connected || child !== getServer()) return Promise.resolve(unavailable);
    const id = ++sequence;
    return new Promise(resolve => {
      function finish(result) {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('disconnect', onDisconnect);
        resolve(result);
      }
      function onMessage(message) {
        if (message?.type === 'environment-install-result' && message.id === id) finish(message.result);
      }
      function onDisconnect() { finish(unavailable); }
      const timer = setTimeout(onDisconnect, 35_000);
      child.on('message', onMessage);
      child.once('disconnect', onDisconnect);
      try {
        child.send({ type: 'environment-install', id, ...frame }, error => { if (error) onDisconnect(); });
      } catch { onDisconnect(); }
    });
  }

  ipcMain.handle('pi-gui:environment-install', async (event, request) => {
    if (!trusted(event)) return { ok: false, code: 'untrusted-sender' };
    if (pending) return { ok: false, code: 'busy', error: '已有安装确认或任务正在进行。' };
    const child = getServer();
    if (!child?.connected) return unavailable;
    const { planId, components } = request || {};
    if (typeof planId !== 'string' || !/^plan-[a-f0-9]{20}$/.test(planId)
      || !Array.isArray(components) || !components.length || components.length > 3
      || new Set(components).size !== components.length
      || components.some(id => typeof id !== 'string' || !Object.hasOwn(LABELS, id))) {
      return { ok: false, code: 'invalid-components', error: '安装项或安装计划不合法。' };
    }
    const selection = { planId, components: [...components] };
    const detail = [
      ...selection.components.map(id => `• ${LABELS[id]}`),
      '',
      '安装到当前用户目录，不需要管理员权限，不修改系统环境变量。',
      '不会覆盖已有的 Pi；安装包只从官方渠道下载并校验。',
    ].join('\n');
    pending = true;
    try {
      const result = await dialog.showMessageBox(getWindow(), {
        type: 'question',
        title: '安装缺失依赖',
        message: 'Pi GUI 需要安装以下组件',
        detail,
        buttons: ['开始安装', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (result.response !== 0 || !trusted(event)) return { ok: false, cancelled: true };
      const approval = await call(child, { action: 'approve', ...selection });
      if (!approval?.ok || typeof approval.ticket !== 'string' || !trusted(event)) return unavailable;
      const started = await call(child, { action: 'start', ...selection, ticket: approval.ticket });
      // Only return the public installation result to the renderer.
      return {
        ok: started?.ok === true,
        code: started?.code,
        error: started?.error,
        job: started?.job,
        environment: started?.report,
      };
    } catch {
      return { ok: false, error: '确认窗口无法打开' };
    } finally {
      pending = false;
    }
  });

  async function changePi(event, choose) {
    if (!trusted(event)) return { ok: false, code: 'untrusted-sender' };
    if (pending) return { ok: false, code: 'busy', error: '已有环境操作正在进行。' };
    const child = getServer();
    if (!child?.connected) return unavailable;
    pending = true;
    try {
      let path = null;
      if (choose) {
        const result = await dialog.showOpenDialog(getWindow(), {
          title: '选择 Pi 可执行文件',
          properties: ['openFile'],
        });
        if (result.canceled || result.filePaths.length !== 1 || !trusted(event)) return { ok: false, cancelled: true };
        [path] = result.filePaths;
      } else {
        const result = await dialog.showMessageBox(getWindow(), {
          type: 'question', title: '清除手动指定的 Pi 路径', message: '清除后，Pi GUI 将重新检测本机的 Pi。',
          buttons: ['清除', '取消'], defaultId: 1, cancelId: 1, noLink: true,
        });
        if (result.response !== 0 || !trusted(event)) return { ok: false, cancelled: true };
      }
      const result = await call(child, { action: 'set-pi-path', path });
      return { ok: result?.ok === true, code: result?.code, error: result?.error, environment: result?.environment };
    } catch {
      return unavailable;
    } finally {
      pending = false;
    }
  }
  ipcMain.handle('pi-gui:environment-choose-pi', event => changePi(event, true));
  ipcMain.handle('pi-gui:environment-clear-pi', event => changePi(event, false));
}

module.exports = { installEnvironmentSetup };
