# 真实并行验收证据

`attempt-3-*` 来自 2026-11-26 实际 Windows Electron 打包层运行，TEMP fixture `pi-parallel-live-BAHvF5`。主路径结果 **29/31**，失败为 runtime restart（含 runner 汇总失败），不得当作整体通过。`restart-before-fix-*` 为同 fixture 的无模型复现，返回闭合错误码 `unknown_workspace`，**5/7**。

JSON 仅含白名单结构：owner、原生 session、runtime 代次、SSE 序号/时间、工具名/错误布尔值与断言；不含模型消息、工具参数/结果 payload、凭据或 provider 配置。文件结果只记字节数/SHA-256。

历史 PNG 来自真实 `capturePage()`：原图曾做 TEMP 路径文本替换。归档副本另外对底部 model/provider picker 身份标签做明确的矩形隐私遮盖（不透明隐私色块）；不修补或合成其它界面像素。`archive-manifest.json` 记录历史原图与归档 SHA-256、遮盖坐标及像素校验结果。原始截图保留在 TEMP 供本机复核，不写入仓库。

## 最终构建完整真实验收（2026-11-26，通过）

- 同一打包字节（exe `71b9ed51…`、backend `917a5fbc…`、main `135a00e0…`）先在 `pi-parallel-live-1CfIzx` 完成真实预检 **10/10**（独立资格，`fullLiveAcceptance=false`），再在 `pi-parallel-live-ci41oY` 完成完整 exercise→recovery：**exercise 35/35、recovery 31/31、合计 66/66**、failed 0、两阶段 exit 0、`completed=true`、`fullLiveAcceptance=true`、privacy verified。
- [最终摘要](final-acceptance-20261126-summary.json) / [运行身份](final-acceptance-20261126-identity.json) / [恢复回合最小证明](final-acceptance-20261126-recovery-proof.json) / [归档 manifest](final-acceptance-20261126-manifest.json)：恢复后真实 write→read 回合输出 11 字节 sha `106da1c5…`、工具 0 错误、`toolPairsComplete=true`、`writeThenRead=true`、settled/idle、耗时 12.639 秒；结果文件 21 字节 sha `c89212fd…` 且精确。
- JSON 仍只含白名单结构，不含消息、工具参数/结果、凭据或 provider 配置。本轮未改 UI，未归档新截图；TEMP 原图保留本机复核。此前 `pi-parallel-live-hGBJUN` 的 19/21 是驱动证据形状错误（公开 SSE 合法省略白名单外 `toolCallId`），不是产品回合失败，详见 [真实专项记录](../../parallel-runtime-live-evidence.md)。

## 恢复提示：离线实际渲染，不是真模型证明

- [测量与摘要](recovery-notice-render.json)：2026-11-26 在正常 sandbox / contextIsolation 的 Electron 44.4.3 内加载生产 Runtime 组件和完整生产 CSS，使用合成拒绝响应，实际点击发送。六组明暗 / 宽窄 / 中英文 fixture 均保留草稿、提交仅一次，提示无裁切或横向溢出；深浅文字对比度分别为 8.672:1 / 6.673:1。
- 主线程人工查看并逐字节归档的两张代表截图：[深色窄窗](recovery-notice-dark-narrow.png)、[浅色窄窗英文草稿](recovery-notice-light-narrow-english.png)。PNG 未遮盖、未修改像素；其余四张的摘要保留在测量报告，原图留 TEMP。
- 此证据只验证本轮一条恢复提示的实际排版和输入保留，不启动真实 Pi / 模型，不证明最终打包构建通过。没有改动 CSS、动画或现有视觉设计。

## 上一轮构建证据：控制面通过，模型尝试未通过

最终 backend SHA-256 为 `9495579ee39ee69c29f9a9b5cebc08491ad9eb8467de0ae3d3a8554d8f6f8aae`，生产与桌面打包副本一致。新一轮没有覆盖上述历史失败：

- [控制面](final-control-owner-probe.json) / [控制面摘要](final-control-owner-probe-summary.json)：真实 Pi、零 prompt **17/17**，Classic B 重复恢复拒绝、持久化 C resume/restart 和旧 owner 拒绝；不替代模型资格。
- [最终模型尝试](final-live-exercise.json) / [最终摘要](final-live-summary.json)：exercise 实际 **5/6**，A 启动后等工具 120 秒超时；B/C/recovery 未执行。summary **5/7** 额外包含缺 recovery 的完整性失败，`completed` / `fullLiveAcceptance` 均为 false。没有闭合供应商错误，不归因限流或产品串行。
- [驱动安全专项](final-driver-safety.json)：显式只读上游纯 parser 模式 **27/27**；默认离线模式为 **25/25**，不依赖本机 Pi，不能重复累计成更多通过项。
- [最终归档 manifest](final-archive-manifest.json)：5 份结构 JSON 的字节数与 SHA-256、2 张 PNG 的来源/归档摘要及像素遮盖范围；主线程逐项复核 **7/7**。
- [控制面 C 重启截图](final-control-C-restarted-dark-wide.png)：1980×1230，无额外遮盖；模型控件尚在同步，不当作模型可用证明。
- [最终模型 A 等待截图](final-live-failure-start-A.png)：1980×1230，仅遮盖 model/provider 标签矩形 `(1450,1150,215,45)`，遮盖外逐通道差异 0。最终 driver 不再通过改写 DOM 隐藏路径，仅只读查询隐私矩形后遮盖像素。

旧 29/31 与新控制面 17/17 不能拼成一次完整模型通过。命令、运行时间、原生身份、清理与未验证项见 [真实专项记录](../../parallel-runtime-live-evidence.md)。

宽 / 窄、明 / 暗截图只是实际渲染证据，不是完整 UI 设计通过意见；发现或未核验的布局问题不得因功能断言成功而忽略。
