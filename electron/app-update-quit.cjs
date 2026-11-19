'use strict';

/* 退出安装协调器。
 *
 * 只在「自动偏好 + 已校验 ready + 安装版」全部成立时，才在普通退出路径上
 * 尝试一次自动安装。它是现有维护锁、退出确认和安装助手的**前置闸门**，
 * 不替代其中任何一步：
 *   - 预检失败 -> 放弃本次自动安装，按普通退出处理；
 *   - 安装失败 -> 释放准备状态，按普通退出处理，保留可恢复缓存；
 *   - 正在恢复/安装/预检 -> 暂时阻止退出，避免重复事件或递归退出；
 *   - 系统关机/会话结束 -> 不尝试自动安装，也不额外等待。
 *
 * 预检成功后仍会重新读取 manager 候选；app-update.cjs 在真正启动助手前
 * 还会再次校验包、官方元数据与维护状态。一次预检不是永久许可。 */

function createAutoQuitCoordinator({
  manager,
  install,
  preflight,
  quit,
  authorize,
  isRecovering = () => false,
  isSuppressed = () => false,
  isSystemShutdown = () => false,
  onError = () => {},
}) {
  if (typeof install !== 'function' || typeof quit !== 'function') {
    throw new TypeError('quit coordinator requires install and quit');
  }
  const stillAuthorized =
    typeof authorize === 'function'
      ? authorize
      : () => Boolean(manager?.autoInstallCandidate?.().ok === true);
  let attempt = 'idle'; // idle | checking | running | settled
  let installFlow = false;
  let quitIssued = false;
  let disposed = false;

  function note(error) {
    try {
      onError(error);
    } catch {
      // 错误上报不能影响退出。
    }
  }

  function requestQuit() {
    try {
      quit();
    } catch (error) {
      note(error);
    }
  }

  function canQuit() {
    if (disposed) return true;
    if (quitIssued) return true;
    if (isRecovering()) return false;
    if (installFlow) return false;
    return attempt !== 'checking' && attempt !== 'running';
  }

  /* 窗口关闭时先不要让 BrowserWindow 销毁：通过 app.quit 进入 before-quit，
   * 让协调器在窗口仍存活时完成预检。这样 Windows 的 query-session-end /
   * session-end 还能送达，关机期间不会启动安装。 */
  function shouldDeferClose() {
    if (disposed || quitIssued) return false;
    if (attempt !== 'idle') return false;
    if (installFlow || isRecovering() || isSystemShutdown() || isSuppressed()) return false;
    const candidate = manager && manager.autoInstallCandidate
      ? manager.autoInstallCandidate()
      : { ok: false };
    return Boolean(candidate && candidate.ok === true);
  }

  function markQuitIssued() {
    quitIssued = true;
  }

  async function runAutoInstall() {
    try {
      const ready = await preflight();
      if (
        disposed ||
        isSystemShutdown() ||
        isSuppressed() ||
        isRecovering() ||
        !ready ||
        ready.ok !== true
      ) {
        attempt = 'settled';
        requestQuit();
        return;
      }
      // 预检是异步的；返回后必须按当前状态重新确认，不能沿用旧许可。
      const candidate = manager.autoInstallCandidate();
      if (!candidate || candidate.ok !== true) {
        attempt = 'settled';
        requestQuit();
        return;
      }
      attempt = 'running';
      installFlow = true;
      let result;
      try {
        result = await install({ authorize: () => stillAuthorized() === true });
      } finally {
        installFlow = false;
      }
      attempt = 'settled';
      if (!result || result.ok !== true) {
        // 安装没有启动（或准备阶段失败）：恢复普通退出，缓存保留给下次。
        // armed 已落盘的失败不能撤销：首次 app.quit 已失败、进程还活着时，
        // 必须补一次真实退出让助手完成；quitIssued 此时只代表“已尝试退出”，
        // 不代表退出成功。
        if ((result && result.committed === true) || !quitIssued) requestQuit();
      }
    } catch (error) {
      note(error);
      attempt = 'settled';
      if (!quitIssued) requestQuit();
    }
  }

  function beforeQuit(event) {
    const prevent = () => {
      if (event && typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      return true;
    };
    if (disposed) return false;
    if (quitIssued) return false;
    // 系统关机优先于所有等待：不再阻止、也不再补做安装。更新器内部的
    // authorize 回调会在每个异步步骤后看到同一个关机标记。
    if (isSystemShutdown()) return false;
    if (isRecovering()) return prevent();
    if (installFlow) return prevent();
    if (attempt === 'checking' || attempt === 'running') return prevent();
    if (attempt === 'settled') return false;
    if (isSuppressed()) return false;
    const candidate = manager && manager.autoInstallCandidate
      ? manager.autoInstallCandidate()
      : { ok: false };
    if (!candidate || candidate.ok !== true) return false;
    attempt = 'checking';
    prevent();
    void runAutoInstall();
    return true;
  }

  async function runExplicitInstall(options={}) {
    if (disposed) return { ok: false, code: 'disposed' };
    if (installFlow || attempt === 'checking' || attempt === 'running') {
      return { ok: false, code: 'busy', error: '更新正在准备中。' };
    }
    quitIssued = false;
    installFlow = true;
    let result;
    try {
      result = await install(options);
    } finally {
      installFlow = false;
    }
    // armed 已落盘的事务不可撤销。若这次 app.quit 本身失败，主进程还活着，
    // 助手会一直等待父进程退出；补一次真实退出请求，让已提交的安装有机会
    // 完成。只请求一次，不递归、不重试成环。quitIssued 只代表“已尝试退出”，
    // 不代表退出成功，因此这里不能把它当成已退出。
    if (result && result.committed === true) {
      attempt = 'settled';
      requestQuit();
    }
    return result;
  }

  function dispose() {
    disposed = true;
  }

  return {
    beforeQuit,
    canQuit,
    shouldDeferClose,
    markQuitIssued,
    runExplicitInstall,
    dispose,
    snapshot() {
      return { attempt, installFlow, quitIssued };
    },
  };
}

module.exports = { createAutoQuitCoordinator };
