# 会话过程 UI/UX 第二阶段验收报告

> 分支：`feat/session-ux-phase-2`  
> 基线：`feat/session-ux-phase-1` 合并至 `origin/main`（提交 `84b1118`）  
> 审计文档：[session-ux-comparison-audit.md](session-ux-comparison-audit.md)（对应项 O-05、O-06、O-08）  
> 参考规范：[conversation-ui.md](conversation-ui.md)、[ui/design-system.md](ui/design-system.md)、[testing.md](testing.md)  
> 视觉与几何证据：[docs/ui/session-ux-phase2-evidence/README.md](ui/session-ux-phase2-evidence/README.md)（10 张 PNG 截图 + `report.json`）

---

## 1. 结论

- **开发完成，定向验收与真实 Chromium 几何测量全部通过。**
  本阶段按要求实现了：
  - **P2-A**：Classic 会话阅读位置捕获与恢复（内存 LRU 书签、首个可见锚点与相对偏移、贴底感知、无空白跳闪、非 `setTimeout` 猜测、主动发消息优先贴底）。
  - **P2-B**：折叠与展开阅读位置补偿（工具组、工具详情、Thinking 内容、Plan 任务卡及 Runtime 折叠组件的视口稳定补偿，视口上方折叠时下方内容不跳动，贴底保持跟随，主动滚动取消补偿）。
  - **P2-C**：Runtime 历史搜索滚动隔离修复（限制在 `.rtc-output` 容器内部居中，彻底消除 `.stage` / work surface / 顶栏 / Composer 的连带滚动）。
  - **P2-D**：工具输出自动跟随回归核验（运行中详情展开且距底不足 40px 时自动跟随，手动上滚不拉回，完成后不再跟随）。
  - **P2-E**：多会话状态与滚动隔离（不同会话拥有独立书签与展开状态，后台推送不影响当前会话滚动，会话切换无异步 DOM 串扰，无额外思考动画重启）。
- **严格保护范围 100% 恪守**：
  - `public/thinking-dots.js`、`public/thinking-dots.css`、`public/scroll-button.js` **严格零 diff**（`git diff --exit-code` 校验通过）。
  - 未引入任何第三方库或外部依赖，未修改后端或 session 文件结构，未将书签写入 `localStorage`。
  - P1 轮次终态、Token 摘要、重试错误保留契约完全保持。
- **几何与视觉达标**：
  在真实 Chromium (CDP) 环境下，Classic 阅读恢复误差 **0.00px**，工具组/详情/Plan 折叠误差 **0.00px**，视口上方折叠下方位移 **0.19px**，Runtime 祖先容器滚动量 **0px**。全部控制在 **<= 1.00px** 目标范围内。
- **风险等级：低**。仅调整纯前端滚动与 DOM 视口补偿，不涉及数据持久化、凭据或安全权限。

---

## 2. 实际修改文件清单

| 文件路径 | 变更类型 | 说明 |
| --- | --- | --- |
| `public/reading-position.js` | **新增** | 阅读位置捕获与恢复核心模块、内存 LRU 书签管理、共享折叠滚动补偿工具 `preserveScrollAround` |
| `public/messages.js` | 修改 | 为消息注入稳定 `data-anchor-id`、会话切换/清空前保存书签、历史重建完成后精准恢复书签、Passive 滚动监听记录阅读位置、Thinking 折叠接入补偿 |
| `public/sessions.js` | 修改 | 会话切换 `doSwitch()` 前保存原会话书签、会话删除 `doDelete()` 清理对应书签 |
| `public/tool-view.js` | 修改 | 工具组标题折叠、工具详情点击、`setGroupOpen` 统一接入 `preserveScrollAround` |
| `public/plan-view.js` | 修改 | Plan 任务卡标题折叠点击接入 `preserveScrollAround` |
| `public/runtime-conversation.js` | 修改 | 新增 `scrollRowIntoView(output, row, align)` 限制在 `.rtc-output` 滚动、消除 `scrollIntoView` 冒泡滚动祖先缺陷、Thinking 折叠接入补偿、后台 store 更新防误滚隔离 |
| `tests/session-ux-phase2.cjs` | **新增** | 第二阶段定向测试套件（57 项断言，涵盖 P2-A ~ P2-E、边界情况、思考动画零改动证明） |
| `tests/session-ux-phase2-shots.cjs` | **新增** | 真实 Chromium CDP 自动化截图与几何精度测量脚本（9 项几何测量，产出 10 张 PNG + `report.json`） |
| `tests/runtime-conversation.cjs` | 修改 | 对齐 Runtime 历史搜索定位标记断言（`data-history-scrolled`） |
| `package.json` | 修改 | 增加 `test:session-ux-phase2` 脚本，将套件加入 `npm test`  canonical 链 |
| `docs/ui/session-ux-phase2-evidence/` | **新增** | 真实浏览器验收截图（10 张 PNG）与 `report.json`、说明文档 |

---

## 3. 每项功能的实现说明

### P2-A：Classic 会话阅读位置捕获与恢复（O-05）

1. **阅读书签模型**：
   `captureReadingPosition(scroller, content)` 记录：
   - `isPinned`：距底 <= 160px 视为贴底。
   - `scrollTop`、`scrollHeight`、`clientHeight`。
   - `anchorId`：视口内第一个顶部可见消息或元素的稳定标识（`data-anchor-id` 如 `user-7`、`assistant-7`、`tools-2` 等）。
   - `offset`：锚点相对于滚动容器顶部的当前像素偏移。
2. **稳定锚点注入**：
   在 `messages.js` 的实时流式生成（`onMessageStart` / `onMessageEnd` / `onSettled`）和历史重建（`rebuildFromMessages`）两条路径中，统一为消息节点注入全局递增的 `data-anchor-id`，保证刷新或重建后锚点具有确定性。
3. **精准恢复与安全降级**：
   - 贴底会话：直接恢复 `scrollTop = scrollHeight - clientHeight`，保持贴底跟随。
   - 非贴底会话：定位对应 `data-anchor-id` 节点，按保存的 `offset` 补偿 `scrollTop`，达到 0px 误差恢复。
   - 锚点丢失（如消息被过滤）：平滑回退到保存的数值 `scrollTop` 并按当前高度截断，杜绝空白页面、异常报错或无限循环。
4. **内存 LRU 缓存与清理**：
   内存保留最大 100 项书签（`MAX_BOOKMARKS = 100`），超过上限自动按最近最少使用淘汰；在 `sessions.js` 中删除会话时自动从内存彻底注销。不写本地盘或 `localStorage`。

### P2-B：折叠与展开时保持阅读位置稳定（O-06）

1. **共享滚动补偿工具 `preserveScrollAround(anchorEl, actionFn)`**：
   在执行折叠/展开回调前后，捕获容器与标题的几何状态：
   - **视口内被点击标题**：记录标题相对容器顶部的偏移，在折叠引起高度变化后，调整容器 `scrollTop`，使被点击标题在视口内的位置保持原位（误差 0.00px）。
   - **视口上方折叠**：检测折叠容器处于视口上方（`bottom <= scroller.top + 1`），计算折叠前后高度差 `heightDelta`，并将 `scroller.scrollTop += heightDelta`，使得视口下方正在阅读的文本完全静止（实测误差仅 0.19px）。
   - **贴底优先**：用户原本贴底时，保持贴底跟随行为。
   - **主动操作保护**：在折叠过渡期间，若用户触发 `wheel` / `touchmove` 主动滚动，立即取消补偿，尊重用户意图。
2. **接入组件**：
   - 工具组标题折叠（`tool-view.js` 中的 `head.addEventListener('click')`）
   - 工具详情展开/收起（`tool-view.js` 中的 `flip`）
   - Thinking 内容折叠面板（`messages.js` 与 `runtime-conversation.js` 中的 `<details>` / `.think-head`）
   - Plan 任务卡折叠（`plan-view.js` 中的 `.plan-head`）

### P2-C：Runtime 历史搜索滚动修复（O-08）

1. **根因**：原实现使用 `row.scrollIntoView({ block: 'center' })`，浏览器标准规范会导致调用冒泡到所有外层滚动祖先，连带滚动了 `.stage`、work surface、顶栏或 Composer。
2. **修复方案**：
   在 `public/runtime-conversation.js` 中新增容器封闭滚动函数 `scrollRowIntoView(output, row, align)`：
   - 获取 `row.getBoundingClientRect()` 与 `output.getBoundingClientRect()`。
   - 计算居中增量：`delta = (rowRect.top - outRect.top) - (outRect.height - rowRect.height) / 2`。
   - 仅对 `output.scrollTop += delta` 进行赋值。
   - 祖先元素（`.stage`、`work-surface`、`document.documentElement`）滚动量恒为 **0px**。

### P2-D：工具输出自动跟随回归检查

1. 保持 P1 既有逻辑：在追加工具输出前检测 `scrollHeight - scrollTop - clientHeight <= 40`。
2. 运行中且距底不足 40px 时平滑跟随到底部；用户向上滚动后判定不满足条件，不强制拉回。
3. 工具结算 `onToolEnd` 后，不再主动跟随。

### P2-E：多会话滚动状态隔离

1. **状态独立性**：Classic 会话以 `sessionId` 为键存储内存书签，切换会话 A 与 B 各自维护独立的阅读进度与展开状态。
2. **后台更新隔离**：Runtime 在收到后台 store 变更时，仅当当前处于活跃态且内容真实增长时才触发滚动更新，后台会话产生事件绝不影响前台当前浏览位置。
3. **会话切换防护**：切换过程中清空并重新绑定 DOM，迟到的异步回调被会话 ID 防伪比对过滤，防止污染新会话 DOM。

---

## 4. 修改前后的行为差异

| 交互场景 | 修改前行为（基线） | 修改后行为（P2） |
| --- | --- | --- |
| **会话切换切回** | 切换到其它会话再切回时，阅读位置丢失，强制滚回最底部或顶部空白。 | 准确恢复到上次离开时的可见消息行与相对偏移，贴底会话保持贴底，非贴底会话原位不动。 |
| **工具组标题点击** | 点击展开或收起长工具组时，标题位置突然发生跳动，用户视线丢失。 | 标题在视口内的相对高度保持严格恒定（0.00px 误差），阅读焦点连续。 |
| **视口上方折叠** | 用户在下方阅读时，上方内容折叠导致下方正在阅读的文本突然向上猛跳。 | 自动补偿上方折叠高度差，视口内正在阅读的文字位移 <= 0.19px，完全无感。 |
| **Runtime 搜索跳转** | 使用 `scrollIntoView` 导致 `.stage`、work surface 连带位移，界面发生形变。 | 滚动严格约束在 `.rtc-output` 内部，祖先容器 0 滚动，目标行在输出区精确居中。 |
| **用户主动打断** | 展开过程中若用户滚动，会被生硬拉回。 | 用户触发手势或滚轮立即取消自动补偿，交互响应平滑。 |

---

## 5. 真实测试命令和通过数量

### 5.1 受影响套件通过情况

| 测试命令 | 通过/总数 | 耗时 | 覆盖范围与说明 |
| --- | --- | --- | --- |
| `npm run test:session-ux-phase2` | **57/57** | 1.1s | 捕获与恢复纯函数、LRU 淘汰、Classic 历史重建、折叠补偿、Runtime 搜索、多会话隔离、超长会话（200回合）、连续切换、流式向上阅读、思考动画零改动 |
| `npm run test:session-ux-phase1` | **81/81** | 1.3s | P1 轮次终态、Token 摘要、重试错误保留、工具折叠优先级全部保持，无回归 |
| `node tests/ui2-classic.cjs` | **55/55** | 1.2s | Classic 消息渲染、历史重建、错误提示无回归 |
| `node tests/runtime-conversation.cjs`| **106/106**| 1.8s | Runtime 时间线、工具摘要、历史搜索定位标记无回归 |
| `node tests/thinking-dots.cjs` | **90/90** | 1.5s | 思考动画时间轴、相位切换、会话切换无回归 |
| `node tests/agent-execution-ui.cjs` | **221/221**| 2.4s | 计划面板、Runtime 时间线、执行契约无回归 |
| `node tests/modules.cjs` | **121/121**| 0.8s | 模块解耦与循环依赖检查通过 |
| `node tests/ci-test-plan.cjs` | **259/259**| 1.4s | CI 测试链 5 个分组 259 个叶节点覆盖无空缺 |
| `node tests/session-ux-phase2-shots.cjs`| **9/9 项全过**| 9.8s | 真实 Chromium CDP：全部 9 项几何测量通过，产出 10 张 PNG 截图 |

### 5.2 真实 Chromium 几何测量数据报告

摘自 `docs/ui/session-ux-phase2-evidence/report.json`（由 Chrome 152.0.7977.130 自动化测出）：

```json
{
  "label": "phase2",
  "browser": "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "measurements": [
    { "test": "Classic 阅读位置恢复", "errorPx": 0.00, "passed": true },
    { "test": "工具组头折叠位置误差", "errorPx": 0.00, "passed": true },
    { "test": "工具详情折叠位置误差", "errorPx": 0.00, "passed": true },
    { "test": "视口上方折叠下方稳定", "errorPx": 0.19, "passed": true },
    { "test": "Plan 任务卡折叠位置误差", "errorPx": 0.00, "passed": true },
    { "test": "Runtime 搜索祖先 stage 零滚动", "errorPx": 0.00, "passed": true },
    { "test": "Runtime 搜索 work-surface 零滚动", "errorPx": 0.00, "passed": true },
    { "test": "Runtime 搜索外层 doc 零滚动", "errorPx": 0.00, "passed": true },
    { "test": "Runtime 搜索居中误差", "errorPx": 0.00, "passed": true }
  ],
  "allPassed": true
}
```

---

## 6. Classic 和 Runtime 实测情况

1. **Classic 会话**：
   - 15 回合长对话，用户滚至第 7 回合（`relTop = 120px`），切至会话 2 浏览到底部，再切回会话 1：
     几何测量恢复误差为 **0.00px**，用户视线完全无需重新对焦。
   - 工具组由展开变为折叠：组头在视口内的相对 top 误差为 **0.00px**。
   - 工具组位于视口上方折叠时：视口内可见文本向下位移仅 **0.19px**（字体子像素舍入），无任何突兀跳动。
2. **Runtime 会话**：
   - 25 行长历史搜索第 15 行：`.stage.scrollTop` 保持 **0px**，`work-surface.scrollTop` 保持 **0px**，目标行垂直居中误差为 **0.00px**。
3. **窄窗响应与主题适配**：
   - 700px 窄窗口下（`08-narrow-700-runtime-search-dark.png`、`09-narrow-700-classic-dark.png`、`10-narrow-700-classic-light.png`）：
     无横向溢出，阅读轴收敛良好，折叠与搜索跳转均正常工作。

---

## 7. 思考动画零改动证明

运行 `git diff --exit-code` 校验严格冻结的文件：

```powershell
git diff --exit-code -- public/thinking-dots.js public/thinking-dots.css public/scroll-button.js
```

输出：**0 diff**（退出码 0，文件未做任何修改）。  
`node tests/thinking-dots.cjs` 90 项断言全部通过，证明动画阶段、时间轴、关键帧、多会话调用完全无影响。

---

## 8. 多会话回归结果

在 `tests/session-ux-phase2.cjs` 的边界测试套件中专项验证：
1. **200 回合超长会话**：在第 150 回合捕获锚点并切出会话，切回后准确恢复至第 150 回合，误差为 0px。
2. **快速连续切换（A -> B -> C -> A）**：3 个会话分别拥有独立的阅读书签（A 在 150px、B 在 600px、C 在 900px），循环切回各自精准恢复。
3. **一边流式生成一边向上查阅**：新追加的消息仅更新后台数据，不强制拉拽向上阅读的视口。
4. **回到底部后收到新消息**：重新贴底后立即恢复自动跟随。
5. **会话销毁内存释放**：删除会话时清理对应书签，避免长时间运行内存泄漏。

---

## 9. 未验证项与残余风险

1. **跨应用重启持久化**：
   按任务约定，本阶段仅实现渲染进程内的内存书签，未持久化至本地硬盘或会话文件。因此完全关闭并重新启动应用时，默认以贴底状态开始。
2. **子像素渲染舍入**：
   在不同显示器缩放比例（如 125% 或 150% DPI）下，视口上方高度补偿可能产生约 0.2px 左右的舍入误差，但均在人眼无感范围（远低于 1px 阈值）。

---

## 10. 是否满足合并条件

| 合并门槛要求 | 状态 | 证据 |
| --- | --- | --- |
| 1. 代码质量与规范要求 | **满足** | 遵循既有架构，复用现有状态与组件，无全局污染，ESM 规范 |
| 2. 定向测试与回归断言 | **满足** | P2 57/57 通过，P1 81/81 通过，Runtime/Classic/Dots 500+ 定向测试全绿 |
| 3. 真实浏览器几何测量 | **满足** | Chromium CDP 9 项几何测量全过，误差 <= 0.19px（目标 <= 1.00px） |
| 4. 真实渲染截图取证 | **满足** | `docs/ui/session-ux-phase2-evidence/` 提供 10 张真实截图与 report.json |
| 5. 产物构建成功 | **满足** | `Pi GUI.exe` 单可执行文件打包注入成功 |
| 6. 思考动画绝对零修改 | **满足** | `thinking-dots.js` / `thinking-dots.css` 零 diff |
| 7. CI 完整性与安全 | **满足** | `package.json` 正确接入，`ci-test-plan` 259/259 无死锁无缺失 |

**结论：完全具备合并条件。**
