/* 渲染进程 ↔ 主进程之间的最小桥。
 *
 * ---------- 为什么这里要破一次「不加 preload」的例 ----------
 *
 * main.cjs 一直刻意不挂 preload（令牌经主进程的 onBeforeSendHeaders 注入，
 * 页面根本不需要和主进程说话）。但有两件事只能由主进程做 —— 渲染进程既没有
 * shell 也没有 Node：
 *
 *   1. 用系统默认程序打开一个文件（openPath）
 *   2. 用系统浏览器打开一个 Release / 下载链接（openExternal）
 *   3. 用户点开 Web Activity 的 http/https 来源（openWebUrl，独立校验）
 *
 * 替代方案是打开 nodeIntegration，那等于把整个 Node 交给页面：
 * 为了两个转发函数把 XSS 的后果从「读接口」放大到「执行任意命令」，
 * 明显不划算。所以挂 preload，只暴露这些转发函数。
 *
 *   4. 右栏内置浏览器的一组具名动作（browser.*）—— 同样只转发，
 *      放行规则在 electron/browser-policy.cjs，由主进程执行
 *
 * ---------- 这个文件里没有任何校验，这是故意的 ----------
 *
 * openPath 的路径校验发生在后端（POST /api/git/open → lib/git.js 的
 * resolveProjectPath）：那里已经有 realpath 解链接、盘符大小写归一、
 * junction / symlink 判定，并且被测过。在主进程里再实现一份必然漂移，
 * 反而会变成「两套规则里更松的那套说了算」。
 *
 * openExternal 的校验在**主进程**（net-probe.cjs 的 isSafeReleaseUrl）——
 * 那里是「页面说想打开某个 URL」与「系统真的去打开它」之间唯一的一道门，
 * 所以它必须在主进程，不能放页面里。这里只做转发。
 *
 * 安全上的收益：即使页面被注入脚本，它能做到的也只是「请求打开一个后端认可的
 * 项目内文件」和「请求打开一个通过相应 URL 校验的地址」，
 * 拿不到任意的 shell 能力。
 */

'use strict';

/* 整个桥包在 try 里：它是**渐进增强**，不是应用的组成部分。
 * 万一某个环境下 contextBridge 用不了，失败的后果应当只是「打开文件退化成
 * 提示绝对路径」（前端 public/git.js 的 openFile 本来就有这条回退分支），
 * 而不是让渲染进程在加载阶段就报错、整个界面白屏。 */
try {
  const { contextBridge, ipcRenderer } = require('electron');

  contextBridge.exposeInMainWorld('piGuiDesktop', {
    /** 供前端判断「我在桌面版里」（网页版没有这个对象）。 */
    isDesktop: true,
    runtimeBrowser: {
      onOpen: callback => {
        const listener = (_event, frame) => callback(frame);
        ipcRenderer.on('pi-gui:runtime-browser-open', listener);
        return () => ipcRenderer.removeListener('pi-gui:runtime-browser-open', listener);
      },
      onState: cb => {
        if (typeof cb !== 'function') return () => {};
        const listener = (_event, value) => cb(value);
        ipcRenderer.on('pi-gui:runtime-browser-state', listener);
        return () => ipcRenderer.removeListener('pi-gui:runtime-browser-state', listener);
      },
      onAgentState: cb => {
        if (typeof cb !== 'function') return () => {};
        const listener = (_event, value) => cb(value);
        ipcRenderer.on('pi-gui:runtime-browser-agent-state', listener);
        return () => ipcRenderer.removeListener('pi-gui:runtime-browser-agent-state', listener);
      },
      status: scope => ipcRenderer.invoke('pi-gui:runtime-browser-status', { scope }),
      enable: (scope, enabled) => ipcRenderer.invoke('pi-gui:runtime-browser-enable', { scope, enabled }),
      open: scope => ipcRenderer.invoke('pi-gui:runtime-browser-open', { scope }),
      navigate: (scope, url) => ipcRenderer.invoke('pi-gui:runtime-browser-navigate', { scope, url }),
      command: (scope, command) => ipcRenderer.invoke('pi-gui:runtime-browser-command', { scope, command }),
      bounds: (scope, rect) => ipcRenderer.invoke('pi-gui:runtime-browser-bounds', { scope, rect }),
      occluded: (scope, occluded) => ipcRenderer.invoke('pi-gui:runtime-browser-occluded', { scope, occluded }),
    },

    /**
     * 用系统默认程序打开当前项目内的一个文件。
     *
     * @param {string} relPath 项目相对路径（形如 a/b.txt）。绝对路径会被后端拒绝。
     * @returns {Promise<{ok:boolean, abs?:string, error?:string}>}
     */
    openPath: (relPath, conversationId = null) => ipcRenderer.invoke('pi-gui:open-path', String(relPath ?? ''), conversationId),

    /**
     * 用系统浏览器打开一个链接（版本检查的「查看 Release」/「下载」）。
     *
     * **主进程会校验**：必须 https 且 host 是 GitHub 官方域名，否则拒绝。
     * 页面拿不到 shell，也没法绕过这道判定 —— 它只能「请求」。
     *
     * @param {string} url
     * @returns {Promise<{ok:boolean, error?:string}>}
     */
    openExternal: (url) => ipcRenderer.invoke('pi-gui:open-external', String(url ?? '')),
    /** Web Activity sources: independent http/https gate in the main process. */
    openWebUrl: (url) => ipcRenderer.invoke('pi-gui:open-web-url', String(url ?? '')),

    /* ---------- 右栏内置浏览器 ----------
     *
     * 这里暴露的是**一组具名动作**，不是通用的 invoke(channel, ...) ——
     * 页面能做的仅限于「打开右栏 / 导航到某个地址 / 前进后退刷新停止关闭 /
     * 报告 viewport 矩形 / 用系统浏览器打开」。没有 executeJavaScript、
     * 没有 webContents、没有任意通道，页面对主进程的杠杆只有这么大。
     *
     * 地址**不在这里校验**：放行规则在 browser-policy.cjs（纯函数，可单测），
     * 由主进程的 browser-view.cjs 执行。preload 里再判一遍必然漂移，
     * 最后变成「两套规则里更松的那套说了算」—— 与 openPath / openExternal
     * 同一个理由（见文件头）。 */
    browser: {
      setAgentControl: (flag) => ipcRenderer.invoke('pi-gui:browser-agent-enable', flag === true),
      agentStatus: () => ipcRenderer.invoke('pi-gui:browser-agent-status'),
      onAgentState: (cb) => {
        if (typeof cb !== 'function') return () => {};
        const listener = (_event, state) => cb(state);
        ipcRenderer.on('pi-gui:browser-agent-state', listener);
        return () => ipcRenderer.removeListener('pi-gui:browser-agent-state', listener);
      },
      onAgentOpen: (cb) => {
        if (typeof cb !== 'function') return () => {};
        const listener = () => cb();
        ipcRenderer.on('pi-gui:browser-agent-open', listener);
        return () => ipcRenderer.removeListener('pi-gui:browser-agent-open', listener);
      },
      open: () => ipcRenderer.invoke('pi-gui:browser-open'),
      navigate: (url) => ipcRenderer.invoke('pi-gui:browser-navigate', String(url ?? '')),
      back: () => ipcRenderer.invoke('pi-gui:browser-command', 'back'),
      forward: () => ipcRenderer.invoke('pi-gui:browser-command', 'forward'),
      reload: () => ipcRenderer.invoke('pi-gui:browser-command', 'reload'),
      stop: () => ipcRenderer.invoke('pi-gui:browser-command', 'stop'),
      close: () => ipcRenderer.invoke('pi-gui:browser-command', 'close'),
      /** 把 browser viewport 的 getBoundingClientRect() 交给主进程。
       *  主进程会重新夹一次（负数 / NaN / 超出窗口都挡掉），见 clampBounds。 */
      setBounds: (rect) => ipcRenderer.invoke('pi-gui:browser-set-bounds', rect),
      /** 有 modal / palette 盖上来时把原生 view 摘下去 —— WebContentsView 是
       * 原生子视图，z-index 管不到它，不摘就会盖住弹层。 */
      setOccluded: (flag) => ipcRenderer.invoke('pi-gui:browser-set-occluded', flag === true),
      /** 用系统浏览器打开（比内置松一档：http/https 都行）。 */
      openExternal: (url) => ipcRenderer.invoke('pi-gui:browser-open-external', String(url ?? '')),
      /** 订阅导航状态。返回取消订阅函数 —— 组件拆掉时必须调用，
       *  否则反复开关右栏会让监听器越积越多。 */
      onState: (cb) => {
        if (typeof cb !== 'function') return () => {};
        const listener = (_event, state) => cb(state);
        ipcRenderer.on('pi-gui:browser-state', listener);
        return () => ipcRenderer.removeListener('pi-gui:browser-state', listener);
      },
      /** 一次性提示（例如「暂不支持下载」）。 */
      onNotice: (cb) => {
        if (typeof cb !== 'function') return () => {};
        const listener = (_event, notice) => cb(notice);
        ipcRenderer.on('pi-gui:browser-notice', listener);
        return () => ipcRenderer.removeListener('pi-gui:browser-notice', listener);
      },
    },
  });
} catch {
  /* 桥没装上 —— 界面照常可用，只是「打开文件」会提示手动打开。 */
}
