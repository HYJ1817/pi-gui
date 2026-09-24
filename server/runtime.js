/* 共享运行态。
 *
 * 只有一个目的：让「当前项目目录」和「正在关闭」这两个跨模块状态
 * **只有一个权威来源**。
 *
 * 拆模块最容易出的问题就是 cwd 漂移 —— server.js 一份、projects 一份、
 * rpc-bridge 又一份，切换项目之后某一路还拿着旧值，表现是
 * 「界面显示 A 项目，命令却跑在 B 目录」这种极难查的错。
 *
 * 所以这里不存任何业务逻辑，只存两个变量加明确的读写口。想改 cwd 必须走
 * setCurrentCwd，改完由调用方负责重启 pi（见 projects.js 的 activate 分支）。
 */
export function createRuntime({ initialCwd = null } = {}) {
  let currentCwd = initialCwd;
  let shuttingDown = false;

  return {
    getCurrentCwd: () => currentCwd,
    setCurrentCwd: (v) => {
      currentCwd = v;
    },
    isShuttingDown: () => shuttingDown,
    setShuttingDown: (v) => {
      shuttingDown = v;
    },
  };
}
