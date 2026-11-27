# Visual Replies P2：交付报告（待用户验收）

日期：2026-11-27 · 分支 `feat/visual-replies-p2` · 版本 0.35.1
终态 HEAD：`12979945`（本地集成完成）· 基线 main：`dfdc1ddea060d8c369e5e0932d052655baa3d772`
分支领先 main 基线 **57 个提交**。

> **验收门禁：本报告交付后由用户验收。未 push、未建 PR、未合并、未发版。**
> 用户 2026-11-27 明确指示「做完别 PR，等我验收」，此前 push+PR+PR-CI 预设已全部撤销；
> 随后又豁免「npm test 不用跑」。本报告是验收决策的输入，不代表已获合并/发布许可。

---

## 1. 交付边界与授权状态（先行声明）

| 动作 | 状态 |
|---|---|
| 本地集成提交 | ✅ 完成（4 个本会话提交，按回滚边界拆分） |
| push | ❌ 未做（不在授权范围） |
| 建 PR | ❌ 未做（等用户验收） |
| 合并 / 发版 | ❌ 未做（等用户验收 + 明确授权） |
| 正式产物重建 | ✅ 完成（`dist-app/Pi GUI-win32-x64`） |
| 本地完整 `npm test` canonical | ⚠️ **用户知情豁免，未跑**（见 §7） |

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
| Electron 安全 | ⚠️ **永久 blocked**（见 §6 A 安全） | 首轮 28/29、`self-navigation-denied-blank` 未过；后续被 cyber policy 拒绝 |
| 全局请求拦截 | ✅ 不破坏正常 Browser/文件预览/认证/代理 | 见各复审证据 |
| 分支继承（branch/copy/edit-resend/history switch/original deletion/inherited restore/illegal cross-session） | ✅ | B 线 17/17 行为子项、372 断言；前后端真实读取链回归 |
| GC / 锁 / 性能 | ✅ | B2 收尾存储/锁/维护/性能；锁含 PID 复用/崩溃/强杀/中断身份判定 |
| CI 注册 | ✅ backend/process 纳入 canonical；新增分组可发现；Electron/live 独立入口 | canonical 叶 355→362 |

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

## 5. 本会话四项修复（回滚边界拆分）

终态 HEAD 顶端 4 个本会话集成提交：

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

## 6. 安全模型与 A 安全线（永久 blocked 披露）

### 实际安全参数（真实模型闭环/产物共用）

sandbox=true、webSecurity=true、contextIsolation=true、nodeIntegration=false、production-preload。**未用 `--no-sandbox`、未关 webSecurity、未开 nodeIntegration。**

### ⚠️ A 安全研究：永久 blocked（未解决阻塞项，诚实披露）

- 首轮 28/29、completed=false：`self-navigation-denied-blank` 未通过。
- 后续运行被模型服务明确拒绝 `API Error: Request blocked by cyber policy.`。
- **按纪律永久停止：不换模型、不换代理、不改写同一测试规避拒绝。** 恶意 HTML/逃逸/外传研究矩阵保持未解决阻断状态。
- **含义**：Visual Replies 的完整攻击性安全矩阵**未完成**，不能宣称安全验收通过。良性功能沙箱参数已实证，但攻击面研究是独立资格。此项在终态仍为 `original-A-security-unresolved`。
- A1/A2 仅做普通功能边界，**不接替** A 的恶意研究；其结果不算安全专项通过。

## 7. 测试证据汇总（实际计数，非「全绿」）

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

**skip 说明**：离线驱动 unverified 仅两项——`original-A-security-unresolved`（§6 永久 blocked）与 `final-integrated-packaged-app`（本会话已补产物冒烟，见 §8）。跳过不计入分子分母。

## 8. 正式产物证据

- 产物：`dist-app/Pi GUI-win32-x64`，入口 `Pi GUI.exe`（234.9 MB），整包 350.0 MB。
- **字节级一致性核证**：产物 `resources/app/public/html-artifact-layout.js` SHA-256 `7ED6001A…` 与修复后源码完全一致（= I-1 current SHA）；bundled `server.cjs` 含 `DISPLAY_ID`（IDS 修复入产物），构建于 22:42。
- **产物冒烟**：`Pi GUI.exe` 启动后 12s 存活、5 进程健康 Electron 树、stderr 0 字节、exit 0、无残留进程。
- **边界标注**：产物版**完整离线驱动未跑**（适配投入与边际价值不成比例）；产物正确性由「字节级一致 + 多进程冒烟 + 源码版两轮 36/36 含真实渲染截图」三层证据叠加覆盖。若验收要求产物版端到端驱动，可作为后续补充。

## 9. 性能 / 资源

- 几何重测有界（1 初始 + 8×80ms，visible 即停），非无限轮询；dispose 完整清理 timer/RAF/listener/observer。
- RAF 合并为**每控制器**合并（非全局 O(1)）：200 远端 artifact 100 同帧 scroll → 200 RAF + 200 矩形读取 + 800 getComputedStyle。**长文档真实浏览器帧耗时预算未测**——这是明确证据边界，不冒称性能过关。
- 多 artifact/并行会话/后台/分页/切换/最小化资源管理经复审确认未退化为全 eager，未加 Agent 并发数量限制。

## 10. 未完成 / 阻塞 / 后续

| 项 | 状态 | 影响 / 后续 |
|---|---|---|
| A 攻击性安全矩阵 | ❌ 永久 blocked | 安全验收不可宣称通过；需用户决策是否接受此残余风险或以合规途径另行研究 |
| 本地完整 `npm test` canonical | ⚠️ 用户豁免未跑 | canonical 缺口为用户知情豁免；其他模块的潜在回归未经全量验证（本任务改动面已经定向+复审覆盖） |
| 产物版端到端驱动 | ⚠️ 未跑 | 见 §8 边界；可后续补 |
| 长文档真实帧耗时 | ⚠️ 未测 | 性能预算证据边界 |
| 完整视觉矩阵全组合 | 部分 | 离线驱动覆盖核心矩阵；极端组合未穷尽 |

## 11. 可执行回滚

按回滚边界逆序 `git revert`（均本地，未推送）：

```
git revert 12979945   # 台账
git revert d21f819b   # 驱动契约修正
git revert 062d865a   # IDS 修复
git revert 806e9d3d   # 懒挂载竞态+I-1（产品+测试同边界）
```

或整分支回到基线 `dfdc1ddea060d8c369e5e0932d052655baa3d772`（未推送，无远端影响）。产物 `dist-app/` 为本地构建产物，删除即可，不影响源码。

## 12. P3 衔接

按任务书未提前开发 P3（preview/headless/自动截图反馈/外部资源代理）。懒挂载的可见性契约、host 高度限流、资源所有权边界为 P3 preview/headless 提供了既有挂载/暂停信号接口；A 安全线的 blocked 状态是 P3 外部资源代理设计的前置未决项。

---

## 验收核对清单（供用户决策）

- [ ] 真实模型闭环 22/22 realModelVerified=true 是否满足验收预期
- [ ] A 攻击性安全矩阵永久 blocked 是否可接受（残余风险）
- [ ] 本地完整 npm test 豁免是否符合预期（canonical 缺口）
- [ ] 产物冒烟 + 字节一致性是否足够，或需补产物版端到端驱动
- [ ] 是否授权后续 push / 建 PR / 合并 / 发版（当前全部未授权）

**报告人**：父集成 Agent · 全部证据世界与复审报告位于 `C:/Users/21022/AppData/Local/Temp/`（见各节引用）· 单一事实源台账 `docs/visual-replies-p2-plan.md`
