# Visual Replies P2：交付报告

> 最终收尾：用户已授权撤回临时 CI 排查改动并直接合并 P2，不另建备份分支。最终代码以原验收基准 bace782 为基础，仅保留后续 Electron 安全策略修正及其回归测试；本报告下文的测试数据属于历史实测，不能视作最终提交已复测。原 Electron 安全专项仍为 28/29，未获得安全验收通过结论，正式发布资格仍待确认。下文关于草稿和合并授权的陈述为历史记录，本条更新优先。

日期：2026-11-27 · 分支 `feat/visual-replies-p2` · 版本 0.35.1
最终收尾验收基准 `bace782e0b6429fe102fae967b63df3729cd9b75` · main 基线 `dfdc1ddea060d8c369e5e0932d052655baa3d772`。

> **当前结论：P2 安全验收未通过，阻断合并及正式发布。** 本轮授权提交、推送和创建 PR，供审查交付证据及未决项。合并与发布仍待授权。用户免除本地完整 `npm test`，正式 PR CI 单独记录。

---

## 1. 交付边界与授权状态（先行声明）

| 动作 | 状态 |
|---|---|
| P2 功能集成 | ✅ 完成，历史变更和证据见 §4–9 |
| 最终收尾差异 | 仅交付报告，产品及测试行为均沿用验收基准 |
| 推送 / PR | 本轮已授权，以草稿 PR 交付，CI 结果以 GitHub 为准 |
| 合并 / 发版 | 未获授权，安全资格仍阻断 |
| 正式产物 | 历史重建、字节一致性和启动冒烟见 §8，完整端到端矩阵延期 |
| 本地完整 `npm test` | 本轮免跑，定向实测和 CI 核对见 §7.1 |

---

## 2. T3 参考对照

- T3 main 源码 SHA：`d20571f9b9fa35da087e916713f6bac05ac9d1f4`（C 重新取得，非继承旧 P1 结论）。
- 对照对象：HtmlRenderFrame / BrowserDocumentFrame / Dialog / Timeline / 协议 / 滚动 / 图片缩放 / 测试。
- C 消费端验收与参考源码对照已交付并登记（`ec3d77c3`）。
- 限制：未取得可运行 T3 实例，对照为源码级；未假造运行效果。

## 3. P1 遗留逐项状态

| 项 | 状态 | 关键证据 |
|---|---|---|
| 真实 Pi 驱动（工具发现/真实 html_render/发布/Electron 展示/JS/后续流式文字/会话切换/重启） | ✅ 完成 | 真实 Pi 无模型契约 13/13（TEMP 会话，含合成 assistant setup，明确非模型验收） |
| **真实模型闭环** | ✅ **决定性通过** | **22/22、completed=true、realModelVerified=true**（`pi-visual-replies-HO86dq`）；本地 magpie 网关 + xingchiapi/gpt-6.1-sol，TEMP 会话，key 经专用 env 注入不落盘 |
| Electron 安全 | ❌ **失败 / 复测阻断**（见 §6） | 首轮 28/29，`self-navigation-denied-blank` 失败，后续被服务安全策略阻断 |
| 正常 Browser / 文件预览 / 认证与网络 | ✅ 离线回归通过 | 真实桌面范围及离线测试结果见 §7.1 |
| 分支继承（branch/copy/edit-resend/history switch/original deletion/inherited restore/illegal cross-session） | ✅ | B 线 17/17 行为子项、372 断言；前后端真实读取链回归 |
| 容量维护 / 锁 / 存储性能 | ✅ 容量统计、候选扫描、临时文件清理、锁恢复及既有性能证明；正式快照回收延期 | `collect` 返回 `native_mutation_unproven`，见 §12 |
| CI 注册 | ✅ 定向校验通过，PR 运行结果单列 | 当前 canonical 366 叶，Electron 安全专项独立于正式链 |

## 4. P2 新功能与关键文件

| 功能 | 关键文件 | 状态 |
|---|---|---|
| 懒挂载/暂停可见性控制 | `public/html-artifact-layout.js` | ✅ 含竞态修复+I-1 |
| frame 注册/宿主校验/资源所有权 | `public/html-artifact-viewer.js`（未改） | ✅ 边界保持 |
| host 高度限流/resize 调度 | `public/html-artifact-layout.js` | ✅ |
| 消费端 SSE activity 投影 | `server/html-artifact-projection.js` | ✅ |
| 结构/展示 ID 校验分离 | `server/execution-timeline.js` | ✅ IDS 修复 |
| 分支读取链 | `server/session-navigation.js` 等 | ✅ bounded text-only 契约保留 |
| 轻量悬浮展开/全屏/缩放/动态高度/滚动锚定/主题/多 artifact 资源 | C/D 线实现 | ✅ 各复审通过 |

## 5. 最终收尾前的四项集成提交（历史）

安全专项收尾前的四个集成提交：

| 提交 | 内容 | 独立验收 |
|---|---|---|
| `806e9d3d` | 懒挂载竞态 + I-1 溢出裁切预热边界（产品+测试） | ✅ 收敛复审通过（Edge 15/15） |
| `062d865a` | IDS 结构/展示校验分离堵 pipe 凭据绕过（产品） | ✅ 独立复审关闭 |
| `d21f819b` | 驱动补滚动访问步骤匹配正确懒挂载（测试基建） | ✅ 复审确认未放水 |
| `12979945` | 台账登记三修复复审验收与终态边界 | — |

### 5.1 懒挂载竞态修复（根因 → 修复 → 收敛）

- **根因**（probe3–probe9 取证链锁定）：IO 依赖单次翻转、无兜底；流式期间 followup 文本两段 80ms 注入推动布局剧变，存在「IO 报 false 后位置变化未被可靠重估」的竞态窗口 → 视口预热范围内 artifact 漏挂载（骨架停 32px，scrollIntoView 一推即 ready）。
- **修复**：IO 为主信号 + 有界实测几何兜底（measuredNearby：非零真实矩形/全有限值/非零视口，viewport+600px 垂直 margin，零尺寸 jsdom 不猜、hidden/clip 不扩展、X 轴不扩展）+ scroll/resize RAF 合并 + 有界短期重测（8×80ms，visible 即停）。
- **独立复审第一轮不通过（Important I-1）**：overflow:auto/scroll/overlay 无条件扩展预热，未检查容器真有可滚动范围 → 负向偏移不可达内容被错误提前挂载（真实 Edge+原生 IO 实证）。
- **I-1 定点修复 + 收敛复审通过**：Y 轴预热须 `clientHeight>0 && scrollHeight>clientHeight`，否则 margin=0 且仍执行裁切。Edge 15/15、三路内存对照 pre-I1 三反例失败→修复后全过、三套单测 53/53。**远端惰性未退化，驱动确认未放水。**

### 5.2 IDS 管道符修复

真实 pi toolCall id 含 `|`（跨 127 会话取证仅字母数字+DASH/UNDERSCORE/PIPE）。分离 validId（结构，含 `|`）/ DISPLAY_ID（展示，不含 `|`），堵 `fixture|sk-…` 凭据过滤绕过。独立复审关闭，导出 API results/workflow 两出站路径闭合。**兼容边界**：Pi 自定义模型 ID schema 未禁 pipe，此类模型 model 标签会被省略但 child 行保留。

## 6. 安全专项失败与核实结果

### 实际安全参数（真实模型闭环/产物共用）

sandbox=true、webSecurity=true、contextIsolation=true、nodeIntegration=false、production-preload。**未用 `--no-sandbox`、未关 webSecurity、未开 nodeIntegration。**

### `self-navigation-denied-blank`

- **历史实测失败。** Windows、Electron 44.4.3 / Chromium 152.0.7977.130，28/29，`completed=false`，退出码 1。保留 [覆盖索引](visual-replies-p2-coverage.md) 对原报告的核验记录。该索引所记临时 `report.json` 已无法读取，本轮无法取得更细的运行证据。
- **源码能确认的失败条件。** 原断言按 `frameTreeNodeId` 重新查找 iframe，要求 URL 仍为 `about:srcdoc`。旧节点未查到、查到节点但 URL 已不同，这两种观测均会导致失败。历史记录缺少实际 URL、帧存活状态及可取消事件的触发与取消结果。
- **Electron 契约。** `will-frame-navigate` 覆盖页面发起的子帧文档导航，收到事件后可取消。事件的帧引用可能为空，`frameTreeNodeId` 在同一节点存活期间保持不变，节点移除后该 ID 不复用。当前主进程策略仅允许宿主发起的一次初始 `srcdoc` 装载。现有证据无法确认安全隔离缺陷、平台正常行为、断言预期错误或帧生命周期与事件识别问题。 [Electron 44.4.3 导航事件](https://github.com/electron/electron/blob/v44.4.3/docs/api/web-contents.md#event-will-frame-navigate) · [Electron 44.4.3 帧身份](https://github.com/electron/electron/blob/v44.4.3/docs/api/web-frame-main.md#frameframetreenodeid-readonly)
- **处置。** 历史复测被服务明确拒绝，返回 `Request blocked by cyber policy`。本轮查阅既有证据、产品源码及官方契约，保留原断言和产品策略，安全专项仍为 `original-A-security-unresolved`。普通功能和纯 Node 策略测试有各自的回归结果。安全资格继续阻断合并及正式发布。

## 7. 测试证据

### 7.1 最终收尾回归

测试以 `bace782e0b6429fe102fae967b63df3729cd9b75` 的产品与脚本为准。Windows、Node 24.22.1、Electron 44.4.3。复用本地离线 Electron 完整分发目录的临时副本，主程序 SHA-256 与源文件一致。

| 检查 | 新实测结果 | 证据范围 |
|---|---|---|
| `npm run test:html-artifacts:electron` | **36/36**，两阶段退出码 0，`completed=true` | 生产 main/preload、正常沙箱、离线 Pi fixture。HTML/CSS/SVG/JS 样例、图片、多个 Artifact、切换与重启恢复、深浅色和两种视口 |
| `node tests/html-artifact-viewer-electron.cjs` | **40/40**，0 skip、18 张截图、退出码 0 | 源码生产窗口 + 注入读取 fixture。全屏开关、缩放、阅读位置、同 realm 交互状态、焦点和主题 |
| Artifact 策略、布局、帧、阅读、样例和分支共六套 Node 测试 | **101/101**，0 skip，分支子套件 372 条断言 | IPC sender 和 request policy 模拟、渲染与恢复契约 |
| Browser workbench | UI **17/17**，viewport **36/36**。真实桌面在 P2 和 main 基线均通过前 30 项后超时，退出码 1 | 同一 Electron 副本对照，在 `Specs transition closes classic Browser` 停止。基线也有同一失败，后续桌面矩阵未执行 |
| 文件预览 | `test:file-preview` 退出码 0，正常沙箱桌面 **159/159**，残留进程 0 | 离线测试链与原生桌面预览 fixture |
| 供应商认证与 IPC | Provider auth **110/110**、auth runtime **75/75**、Provider network policy **40/40**、Electron guard **128/128** | 离线认证、网络策略及权限回归。线上供应商认证与模型调用本轮未重测 |
| 正式 CI 注册与 gate 校验 | `npm run test:ci` 退出码 0，五组覆盖 **366** 个 canonical 叶命令，gate 矩阵 **15/15**、Artifact 注册 **15/15** | 本地计划与门禁测试，完整 canonical 以当前 PR CI 为准 |

Viewer、Browser、文件预览首次从共享 Electron 路径启动均提前退出。Viewer 与文件预览记录了 Windows 退出码 `2147483651`，两者在字节一致的临时副本、正常沙箱下复跑通过。安全专项未参与上述运行。

### 7.2 GitHub Actions

- 正式 `CI` 对目标为 `main` 的 PR 执行，由 `package.json` 展开完整测试链。main 基线 `dfdc1ddea060d8c369e5e0932d052655baa3d772` 的 push 运行第 1 次尝试通过，五组、Electron 构建和 `CI gate` 均成功。P2 完整证明以当前草稿 PR 的 GitHub Actions 状态为准。 [main 基线 CI](https://github.com/HYJ1817/pi-gui/actions/runs/45952490979)
- P2 基线 push 的失败记录来自独立的手动安全 workflow。GitHub 显示 **0 个 job**，所以这次失败没有执行 Electron。源码在 job 级 `env` 使用了 GitHub 不支持的 `runner` 上下文，符合这个验证阶段的失败现象。该手动 workflow 仍有配置缺陷，本轮保留其配置和专项阻断状态。 [P2 基线失败运行](https://github.com/HYJ1817/pi-gui/actions/runs/46019319250) · [GitHub Actions 上下文可用性](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability)

### 7.3 历史已交付证据

| 验证 | 实际结果 | 性质 |
|---|---|---|
| 真实模型闭环 | **22/22、completed=true、realModelVerified=true** | 决定性 |
| 完整离线驱动（连续两次，改后新跑） | **36/36、completed=true、exit 0** ×2（world `qlAwP3`/`tYkYKv`） | 决定性 |
| 单测 layout/frame/reading | **53/53**（0 fail/0 skip） | 定向 |
| backend | **39/39** | 定向 |
| 驱动自检 renderer/functional | 18/18 + 28/28 | 定向 |
| 懒挂载三路内存对照 | HEAD 17/5 · pre-I1 19/3 · current 22/0 | 对照实验 |
| I-1 边界探针（作者+复审补充） | 6/6 + 12/12 | 边界 |
| 真实 Edge DOM/IO 对照 | 15/15 场景 | 真实浏览器 |
| 分支读取链 | 17/17、372 断言 | 定向 |
| runtime-conversation / history-tool-summary | 119/119 · 38/38/168 | 定向 |

历史离线驱动的两条未验证项为 `original-A-security-unresolved`（§6）与 `final-integrated-packaged-app`（§8）。两项均未计入通过数。

## 8. 正式产物证据

- 产物：`dist-app/Pi GUI-win32-x64`，入口 `Pi GUI.exe`（234.9 MB），整包 350.0 MB。
- **字节级一致性核证**：产物 `resources/app/public/html-artifact-layout.js` SHA-256 `7ED6001A…` 与修复后源码完全一致（= I-1 current SHA）；bundled `server.cjs` 含 `DISPLAY_ID`（IDS 修复入产物），构建于 22:42。
- **产物冒烟**：`Pi GUI.exe` 启动后 12s 存活、5 进程健康 Electron 树、stderr 0 字节、exit 0、无残留进程。
- 正式产物的完整离线功能矩阵未运行。本轮沿用历史构建、源码字节一致性及启动冒烟证据，源码 Electron 的结果按 §7.1 独立记录。

## 9. 性能 / 资源

- 几何重测有界（1 初始 + 8×80ms，visible 即停），非无限轮询；dispose 完整清理 timer/RAF/listener/observer。
- RAF 合并为**每控制器**合并（非全局 O(1)）：200 远端 artifact 100 同帧 scroll → 200 RAF + 200 矩形读取 + 800 getComputedStyle。**长文档真实浏览器帧耗时预算未测**——这是明确证据边界，不冒称性能过关。
- 多 artifact/并行会话/后台/分页/切换/最小化资源管理经复审确认未退化为全 eager，未加 Agent 并发数量限制。

## 10. 未完成 / 阻塞 / 后续

| 项 | 状态 | 影响 / 后续 |
|---|---|---|
| A Electron 安全专项 | ❌ 原失败尚未解决，复测被服务策略阻断 | 阻断合并及正式发布 |
| 独立安全 workflow | ❌ GitHub 配置验证失败 | 独立于正式 CI gate，见 §7.2 |
| Browser 桌面测试 | ❌ Browser → Specs 切换超时 | main 基线同样失败，属于本轮观察到的既有失败，见 §7.1 |
| 本地完整 `npm test` | 用户豁免未跑 | 当前 PR 完整 canonical 以 GitHub 检查为准 |
| 正式产物端到端、正式 GC、长文档真实帧耗时 | P3 延期 | 见 §12 |
| 完整视觉矩阵全组合 | 部分 | 离线驱动覆盖核心矩阵；极端组合未穷尽 |

## 11. 可执行回滚

本轮仅交付报告，可单独 revert 本轮文档提交。以下为历史功能集成的回滚边界：

```
git revert 12979945   # 台账
git revert d21f819b   # 驱动契约修正
git revert 062d865a   # IDS 修复
git revert 806e9d3d   # 懒挂载竞态+I-1（产品+测试同边界）
```

历史功能基线为 `dfdc1ddea060d8c369e5e0932d052655baa3d772`。本轮未改变产品、构建输入或数据格式。

## 12. P3 遗留清单

1. **正式 Artifact 垃圾回收。** [维护模块](../server/html-artifact-maintenance.js) 的 `collect` 仍返回 `native_mutation_unproven`。P2 覆盖容量统计、候选扫描、临时文件清理和锁恢复。P3 需解决原生 Pi 写入与回收的互斥、删除会话后的无引用附件回收、全局 64 MiB 上限及耗尽后的可恢复处理。
2. **长文档性能。** 保留当前惰性加载机制。大量 Artifact 场景的真实浏览器帧耗时未完整测量，后续依据测量结果决定是否优化。
3. **正式打包产物完整端到端验证。** 已有构建、字节一致性和启动冒烟记录，完整功能矩阵待实跑。
