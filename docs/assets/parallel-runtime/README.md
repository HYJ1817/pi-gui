# 真实并行验收证据

`attempt-3-*` 来自 2026-11-26 实际 Windows Electron 打包层运行，TEMP fixture `pi-parallel-live-BAHvF5`。主路径结果 **29/31**，失败为 runtime restart（含 runner 汇总失败），不得当作整体通过。`restart-before-fix-*` 为同 fixture 的无模型复现，返回闭合错误码 `unknown_workspace`，**5/7**。

JSON 仅含白名单结构：owner、原生 session、runtime 代次、SSE 序号/时间、工具名/错误布尔值与断言；不含模型消息、工具参数/结果 payload、凭据或 provider 配置。文件结果只记字节数/SHA-256。

历史 PNG 来自真实 `capturePage()`：原图曾做 TEMP 路径文本替换。归档副本另外对底部 model/provider picker 身份标签做明确的矩形隐私遮盖（不透明隐私色块）；不修补或合成其它界面像素。`archive-manifest.json` 记录历史原图与归档 SHA-256、遮盖坐标及像素校验结果。原始截图保留在 TEMP 供本机复核，不写入仓库。

## 最终构建证据：控制面通过，模型尝试未通过

最终 backend SHA-256 为 `9495579ee39ee69c29f9a9b5cebc08491ad9eb8467de0ae3d3a8554d8f6f8aae`，生产与桌面打包副本一致。新一轮没有覆盖上述历史失败：

- [控制面](final-control-owner-probe.json) / [控制面摘要](final-control-owner-probe-summary.json)：真实 Pi、零 prompt **17/17**，Classic B 重复恢复拒绝、持久化 C resume/restart 和旧 owner 拒绝；不替代模型资格。
- [最终模型尝试](final-live-exercise.json) / [最终摘要](final-live-summary.json)：exercise 实际 **5/6**，A 启动后等工具 120 秒超时；B/C/recovery 未执行。summary **5/7** 额外包含缺 recovery 的完整性失败，`completed` / `fullLiveAcceptance` 均为 false。没有闭合供应商错误，不归因限流或产品串行。
- [驱动安全专项](final-driver-safety.json)：显式只读上游纯 parser 模式 **27/27**；默认离线模式为 **25/25**，不依赖本机 Pi，不能重复累计成更多通过项。
- [最终归档 manifest](final-archive-manifest.json)：5 份结构 JSON 的字节数与 SHA-256、2 张 PNG 的来源/归档摘要及像素遮盖范围；主线程逐项复核 **7/7**。
- [控制面 C 重启截图](final-control-C-restarted-dark-wide.png)：1980×1230，无额外遮盖；模型控件尚在同步，不当作模型可用证明。
- [最终模型 A 等待截图](final-live-failure-start-A.png)：1980×1230，仅遮盖 model/provider 标签矩形 `(1450,1150,215,45)`，遮盖外逐通道差异 0。最终 driver 不再通过改写 DOM 隐藏路径，仅只读查询隐私矩形后遮盖像素。

旧 29/31 与新控制面 17/17 不能拼成一次完整模型通过。命令、运行时间、原生身份、清理与未验证项见 [真实专项记录](../../parallel-runtime-live-evidence.md)。

宽 / 窄、明 / 暗截图只是实际渲染证据，不是完整 UI 设计通过意见；发现或未核验的布局问题不得因功能断言成功而忽略。
