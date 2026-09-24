/* 渲染进程 ↔ 主进程之间的最小桥。
 *
 * ---------- 为什么这里要破一次「不加 preload」的例 ----------
 *
 * main.cjs 一直刻意不挂 preload（令牌经主进程的 onBeforeSendHeaders 注入，
 * 页面根本不需要和主进程说话）。但「用系统默认程序打开一个文件」这件事
 * 只能由主进程做 —— 渲染进程既没有 shell 也没有 Node。
 *
 * 替代方案是打开 nodeIntegration，那等于把整个 Node 交给页面：
 * 为了一个 openPath 把 XSS 的后果从「读接口」放大到「执行任意命令」，
 * 明显不划算。所以挂 preload，但只暴露**一个**函数。
 *
 * ---------- 这个文件里没有路径校验，这是故意的 ----------
 *
 * 校验发生在后端（POST /api/git/open → lib/git.js 的 resolveProjectPath）：
 * 那里已经有 realpath 解链接、盘符大小写归一、junction / symlink 判定，
 * 并且被测过。在主进程里再实现一份必然漂移，反而会变成「两套规则里更松的那套
 * 说了算」。所以这里只做转发，主进程也只是转发 —— 于是「什么算项目内的文件」
 * 从头到尾只有一处答案。
 *
 * 安全上的收益：即使页面被注入脚本，它能做到的也只是「请求打开一个后端认可的
 * 项目内文件」，拿不到任意的 shell 能力。
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

    /**
     * 用系统默认程序打开当前项目内的一个文件。
     *
     * @param {string} relPath 项目相对路径（形如 a/b.txt）。绝对路径会被后端拒绝。
     * @returns {Promise<{ok:boolean, abs?:string, error?:string}>}
     */
    openPath: (relPath) => ipcRenderer.invoke('pi-gui:open-path', String(relPath ?? '')),
  });
} catch {
  /* 桥没装上 —— 界面照常可用，只是「打开文件」会提示手动打开。 */
}
