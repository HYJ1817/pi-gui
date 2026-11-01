# 模型选择器真实渲染收尾

验证基线：`8908ff56c2e4e1b9d4658798c35cf0829796819a`。本项仅修改 `tests/ui3-model-real.cjs`，不改生产实现、依赖或测试入口。

`public/ui3-model-picker.js` 在 `eac79ca` 及当前版本都只向 Provider 组头追加名称、计数。旧真实渲染测试却解引用不存在的 `.pop-provider-chev`，导致两主题 × 四宽度的 8 项检查在可见性断言之前抛异常。现有折叠契约是原生按钮、`aria-controls`、`aria-expanded`、面板 `hidden` 以及调用方持有的 `expanded` Set。

修正保留 79 项原检查和标题尺寸、名称、展开态等有效断言，将装饰箭头断言换为受控面板身份、hidden 和实际布局高度。另加 8 项 CDP 原生鼠标点击折叠→展开检查，同时验证语义、面板高度、实际可见模型数和调用方记忆。检查没有删除或 skip；原检查标签 79/79 均保留。

命令：`node tests/ui3-model.cjs --real`，环境变量 `UI3_CDP_PORT=19361`。Node `v24.22.1`、Chrome `157.0.8103.26`，本地离线 visual-harness 与 TEMP Chrome profile，不调用真实 Pi 或模型。

| 运行 | 契约 | 真实渲染 | 合计 | 退出码 |
| --- | --- | --- | --- | --- |
| 修正前 red | 53/53 | 71/79 | 124/132 | 1 |
| 修正后 green | 53/53 | 87/87 | 140/140 | 0 |

原始输出见 `red.log`、`green.log`，逐项结果见 `red-results.json`、`green-results.json`，汇总与测试文件 SHA256 见 `summary.json`。另已通过 `node --check tests/ui3-model-real.cjs` 与 `git diff --check`。

绿色运行共捕获 32 张截图；此目录归档 8 张模型弹层截图，其余 Thinking 截图保留在忽略目录 `.shots/ui3-model/`。已目视核对 `models-dark-700.png` 与 `models-light-1536.png`：组头和展开模型可读，长模型名受弹层边界约束。

这是既有 headless Chrome `--no-sandbox` 专项证据，不能代替正常沙箱 Electron、打包 GUI 或完整 canonical 证明；这些层由主任务分别验收。本项无生产资源变更，无需重建产物。回滚仅需还原该测试文件。
