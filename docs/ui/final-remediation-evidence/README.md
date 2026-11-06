# 最终修复证据

对应[验收材料](../pi-desktop-final-remediation-acceptance.md)。所有截图是本轮真实Electron/实际包捕获，不是示意图或合成图。PNG原始像素未缩放，尺寸及SHA-256见 `image-manifest.json`。

- `electron/`：最终综合126/126，82张renderer、8张原生整窗；结果含每图CSS几何/DPR。
- `browser/`：正常sandbox原生Browser66/66，21张renderer/native页面图。
- `packaged/`：实际重建GUI19/19，8张renderer及1张已验证HWND/PID的原生整窗；154文件摘要一致。
- `welcome/`：38/38（基础26+新增12个三态/主题/宽窄布局检查），仅另存12张新增图；130%字号及产品最小700×600窗口。首次前台条件失败与最终布局复验各有原日志。
- `settings-native-results.json`：31/31（基础26+新增5个可信键盘与缺Base URL检查）；基础14图在TEMP，不重复归档。
- `ui3-results.json`：243/243；`ui4-results.json`：282/282，原35图保留在记录中的TEMP目录，不在此重复归档。
- `canonical-result.json` / `canonical.log` / `canonical-plan.json`：唯一一次完成的 `npm test`，235命令、退出0、80分13.683秒。`sourceUnchanged:false` 原值保留，仅独立UI4专项脚本改变；`source-verification.json`明确范围。
- `directed-tests.json`：本轮重新运行的32个入口及实际结尾，不引用历史报告代替运行。
- `frozen-source.json`：启动前生产/测试/构建文件摘要；`css-final.json`：与原审计同口径important统计。
- `final-code-state.json`：最终代码提交和逐文件摘要；`build-verification.json`：离线缓存运行时与已安装运行时字节核对。
- 其余log、`ui4-input-trace.json`：保留红灯、测试夹具问题、原生输入插入轨迹及后续验证，不把重跑写成初次通过。
- `probes/`：本轮TEMP探针原文，路径绑定当时环境，留作复核；不是新增生产入口或第二份canonical清单。

常规复现：先按仓库规则准备离线依赖及 `npm run fixtures`，使用隔离端口运行 `npm test`。专项分别为 `npm run test:final-remediation:electron`、`node tests/browser-workbench-electron.cjs`、`node tests/ui4-pane.cjs`、`node tests/ui3-integration-electron.cjs`；给 `SHELL_OUTPUT/T2B_EVIDENCE_DIR/UI4_EVIDENCE_ROOT/UI3_EVIDENCE_ROOT` 指定新TEMP输出，禁止覆盖历史证据。

实际包必须先离线重建到新目录，再运行 `tests/app-check.cjs --output-root <目录>` 及归档GUI探针；调整探针中绑定的仓库/输出路径。只允许TEMP profile/项目/假Pi，不使用真实认证或模型。无需 `--no-sandbox`，没有新增依赖。剪贴板原内容不进入证据。

权限skip、一次UnknownVizError、首次缺PDF fixture和屏幕覆盖捕获拒绝均在主报告披露；成功的截图存在不等于每个参考功能都已实现。
