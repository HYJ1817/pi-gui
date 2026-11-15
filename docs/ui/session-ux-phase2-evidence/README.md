# 会话过程 UI/UX 第二阶段视觉与几何证据

本目录是第二阶段（Classic 会话阅读位置恢复、折叠与展开位置稳定、Runtime 历史搜索滚动隔离、多会话隔离）的真实渲染截图与几何测量数据，不是产品资源。

截图由 `tests/session-ux-phase2-shots.cjs` 在真实 Chromium / CDP 驱动下生成；页面由离线 `tests/visual-harness.cjs` 提供固定夹具，不启动真 pi、不读取用户会话、不写盘。

## 生成方式

```bash
node tests/session-ux-phase2-shots.cjs
```

- 运行时：本地已安装的 Chromium / Chrome（通过 CDP 无头自动化与真实 DOM 渲染）。
- 视口：默认 `1320 × 820`；窄窗 `700 × 600`。深色与浅色主题实测。
- 几何测量报告：见 [report.json](report.json)。

## 截图清单与几何实测

| 截图文件 | 场景与交互 | 关键观察指标 | 真实实测结果 |
| --- | --- | --- | --- |
| `01-classic-reading-position-restored-dark.png` | Classic 会话阅读位置恢复（深色） | 切换到会话 2 后切回会话 1，第 7 回合锚点在视口内的相对高度误差 | **误差 0.00px**（目标 <= 1.00px） |
| `02-classic-reading-position-restored-light.png` | Classic 会话阅读位置恢复（浅色） | 浅色主题阅读书签恢复，无空白跳闪或位置偏移 | **误差 0.00px**（目标 <= 1.00px） |
| `03-tool-group-toggle-dark.png` | 工具组头点击折叠/展开 | 用户在阅读流中点击工具组标题，展开/收起后标题在视口内的相对 top 稳定 | **误差 0.00px**（目标 <= 1.00px） |
| `04-tool-detail-toggle-dark.png` | 工具详情行点击折叠/展开 | 工具详情展开/收起时标题在视口中的位置稳定 | **误差 0.00px**（目标 <= 1.00px） |
| `05-collapse-above-viewport-dark.png` | 视口上方折叠时下方阅读稳定 | 工具组处于视口上方时折叠，视口下方正在阅读的文本不产生突兀跳动 | **位移 0.19px**（目标 <= 1.00px） |
| `06-plan-toggle-dark.png` | Plan 任务卡折叠补偿 | 任务列表标题点击展开/收起，标题在视口内保持原位 | **误差 0.00px**（目标 <= 1.00px） |
| `07-runtime-history-search-dark.png` | Runtime 历史搜索居中定位与外层零滚动 | 搜索命中行在 `.rtc-output` 视口居中；祖先 `.stage` 与外层 document 零连带滚动 | **祖先滚动 0px，居中误差 0.00px** |
| `08-narrow-700-runtime-search-dark.png` | 700px 窄窗口 Runtime 搜索 | 窄屏下 Runtime 搜索定位与边界裁剪，视口无多余祖先滚动 | 通过 |
| `09-narrow-700-classic-dark.png` | 700px 窄窗口 Classic 会话（深色） | 窄屏下 Classic 阅读位置与展开状态稳定 | 通过 |
| `10-narrow-700-classic-light.png` | 700px 窄窗口 Classic 会话（浅色） | 窄屏浅色主题，阅读轴稳定，视口无横向溢出 | 通过 |

## 几何测量契约说明

- 目标误差设定为 `<= 1.00px`。
- 实测中 Classic 阅读位置、工具组头、工具详情、Plan 卡头、Runtime 居中与祖先零滚动均为 **0.00px**；
- 视口上方折叠时下方正在阅读内容的实际位移为 **0.19px**（因 Chromium 字体排版与子像素渲染舍入），完全收敛在 1px 误差以内。
- 详细测量数据见同目录 [report.json](report.json)。
