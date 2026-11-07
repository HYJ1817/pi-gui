'use strict';
/* CredentialSheet 专属 preload（P2）。
 *
 * 只挂在受限输入窗自己的 session/preload 上，主窗口永远加载不到它。
 * 对页面暴露的对象只有四个具名动作：submit / cancel / status / onState，
 * 外加一份不可变 initial（主题与目标摘要）。没有通用 invoke、没有任意通道、
 * 没有 ipcRenderer 泄漏；nonce/flowId 由主进程持有并注入，页面永远看不到，
 * 所以页面能做的仅限「提交当前输入值」和「取消」。
 *
 * initial 的内容经由 BrowserWindow 的 additionalArguments 传入——那是结构化的
 * argv 数组，不经过任何 shell；目标摘要来自 backend 的 prepare 应答，不信任
 * 主页面传来的文字。
 */
try {
  const { contextBridge, ipcRenderer } = require('electron');

  const prefix = '--pi-gui-credential-';
  const argument = name => {
    const found = process.argv.find(arg => arg.startsWith(prefix + name + '='));
    if (!found) return undefined;
    try { return JSON.parse(found.slice((prefix + name + '=').length)); }
    catch { return found.slice((prefix + name + '=').length); }
  };

  /* initial 主题/冲突标记走 argv（固定短值）；目标摘要在页面就绪后由主进程
   * send 推送（webContents.send 的消息按序到达，preload 落给 listeners）。 */
  const initial = {
    theme: argument('theme') === 'light' ? 'light' : 'dark',
    targetSummary: '',
    oauthConflict: process.argv.includes(prefix + 'oauth'),
  };
  let targetReceived = '';
  ipcRenderer.on('pi-gui:provider-credential-target', (_event, value) => {
    if (typeof value === 'string') { targetReceived = value; window.dispatchEvent(new CustomEvent('pi-gui-credential-target')); }
  });

  contextBridge.exposeInMainWorld('piGuiCredentialSheet', {
    initial: {
      get theme() { return initial.theme; },
      get oauthConflict() { return initial.oauthConflict; },
      get targetSummary() { return targetReceived || initial.targetSummary; },
    },
    /** 应用到草稿。payload 只允许三个字段；多给的字段在这里就被丢弃，
     * 防止页面构造超出冻结合同的帧。 */
    submit: payload => ipcRenderer.invoke('pi-gui:provider-credential-submit', {
      input: typeof payload?.input === 'string' ? payload.input : '',
      allowDiscovery: payload?.allowDiscovery === true,
      rememberTarget: payload?.rememberTarget === true,
    }),
    cancel: () => ipcRenderer.invoke('pi-gui:provider-credential-cancel-sheet'),
    status: () => ipcRenderer.invoke('pi-gui:provider-credential-sheet-status'),
    onState: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('pi-gui:provider-credential-sheet-state', listener);
      return () => ipcRenderer.removeListener('pi-gui:provider-credential-sheet-state', listener);
    },
  });
} catch {
  /* 桥没装上时页面只是死按钮；主进程的打开流程会立刻关闭这个窗口。 */
}
