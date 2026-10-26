# Z5-1：并行会话输入可靠性与草稿恢复验收记录

日期：2026-10-26（Asia/Shanghai）
本轮唯一执行 Agent：Antigravity（独立单 Agent 执行，无子 Agent，无多人并行修改）
基线来源与实施依据：
- 规划依据：`docs/Z5-roadmap.md`、`docs/Z5-1-implementation-plan.md`、`docs/Z5-0-product-audit.md`、`docs/Z5-0-acceptance.md`
- 最终合同补充：Owner 变化时的草稿隔离规则与用户提示词合同要求

---

## 一、交付范围与身份状态

| 项目 | 记录 |
| --- | --- |
| 仓库 | `https://github.com/HYJ1817/pi-gui` |
| 基线 HEAD | `11178ac8c696dcc9c3c675522834286f6c530155`（Merge PR #36，已合并入 main） |
| Worktree 路径 | `C:\Users\21022\.codex\worktrees\z5-1-runtime-input\pi-GUI` |
| 分支名称 | `codex/z5-1-runtime-input`（基于 origin/main HEAD 创建的独立分支） |
| Commit 1 (IME 保护) | `cc93096`：`fix(runtime): 修复中文输入法候选确认误发送并补充先红后绿回归测试` |
| Commit 2 (草稿持久化与隔离) | `03c8dd6`：`feat(runtime): 实现并行会话未发送草稿安全持久化与身份隔离` |
| Commit 3 (沙箱测试与文档) | 包含本验收文档、Electron 正常沙箱测试、文档更新与截图产物 |
| 交付目标 | R1（中文输入法及 Enter 发送保护）与 R2（纯文本草稿持久化与安全恢复） |

---

## 二、任务 R1：中文输入法及 Enter 发送保护实施证据

### 2.1 修复前失败证据（红测）
在 `public/runtime-conversation.js` 未修复前，判定条件为：
```javascript
if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
  event.preventDefault();
  if (!send.disabled) send.click();
}
```
当派发输入法候选词确认事件（`key: 'Enter', keyCode: 229, isComposing: false`）时，事件命中 Enter 分支触发 `send.click()`，导致草稿提前发送并清空输入框，后续正常的 Enter 反而无法发送。
测试实测捕获：
```text
STEP 1 requests: 1 value: 
AssertionError [ERR_ASSERTION]: keyCode=229 不发送
    at ok (C:\Users\21022\.codex\worktrees\z5-1-runtime-input\pi-GUI\tests\runtime-conversation.cjs:10:41)
```

### 2.2 修复后实现与绿测
在 `public/runtime-conversation.js` 本地维护 `composing` 状态：
- 监听 `compositionstart`（`composing = true`）与 `compositionend`（`composing = false`）；
- Keydown 判定守卫：
  ```javascript
  if (event.isComposing || event.keyCode === 229 || composing) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (!send.disabled) send.click();
  }
  ```
- 会话切换（`show(next)`）、失焦离开（`leave()`）及组件销毁（`dispose()`）时同步复位 `composing = false`；
- 不在 `compositionend` 后人为设置固定延时，保证下一次正常 Enter 立即生效；
- `Shift+Enter` 保持换行不发送（不触发 `preventDefault()`）；
- 测试结果：`tests/runtime-conversation.cjs` 8 项 IME 专项测试全绿通过（原 48 项增至 56 项）。

---

## 三、任务 R2：Runtime 纯文本草稿持久化与身份隔离实施证据

### 3.1 轻量适配器 `public/runtime-draft.js`
- 复用 `public/draft.js` 已有的纯文本原语与常量：
  - `readDraftText`、`writeDraftText`、`removeDraft`
  - `DRAFT_MAX_CHARS = 20000`、`DRAFT_SAVE_DEBOUNCE_MS = 400`
- 命名空间与 Classic 完全隔离：
  `pi-gui.draft.v1:runtime:<projectId>:<workspaceId>:<workspaceEpoch>:<conversationId>:<nativeSessionId>`
- 稳定 locator 严格校验：
  - 提取 `projectId`、`workspaceId`、`workspaceEpoch`、`conversationId`、`nativeSessionId`；
  - 每一项必须为非空有界字符串（长度 `<= 512`）；
  - `item.nativeSessionId` 与 `owner.sessionId` 均存在但不一致时视为身份冲突，返回 `null`；
  - 任一字段缺失返回 `null`，禁止生成或读写共享的公共 key（如 `nosession`）。
- 容量守卫与降级：
  - `< 20000` 字符：正常保存与恢复；
  - `> 20000` 字符：不截断文本，内存完整保留，清除旧持久副本防止恢复旧稿，返回 `status: 'exceeded'`；
  - 存储配额满/隐私模式：降级为仅内存保留，返回 `status: 'memory_only'`；
  - 单元测试：`tests/runtime-draft.cjs` 41/41 全部通过。

### 3.2 Runtime Store Owner 变化隔离（最小修复）
在 `public/runtime-store.js` 中修复前，`seed()` 在非原记录更新分支中无条件复制 `prior.draft` 和 `prior.draftRevision`。
红测证据：同一 `conversationId` 下 `nativeSessionId` 改变（`native-1` -> `native-2`）时，旧草稿被错误继承：
```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected
+ 'draft before change'
- ''
    at C:\Users\21022\.codex\worktrees\z5-1-runtime-input\pi-GUI\tests\runtime-store.cjs:107:10
```
最小修复实现：
- 增加 `canInheritDraft(prior, nextItem)` 判定：
  - 同一 `conversationId` 且稳定 locator（`projectId`, `workspaceId`, `workspaceEpoch`, `nativeSessionId`）完全一致时（如仅进程重启），允许保留未发送草稿；
  - `nativeSessionId` 改变或 `workspaceEpoch` 改变时，禁止继承旧草稿，重置为空且 `draftRevision` 归零；
  - 首次未绑定（`sessionId` 为 `null`）-> 首次获得已证明 `sessionId` 时允许接续内存草稿；
  - 身份冲突时拒绝继承；
- 单元测试：`tests/runtime-store.cjs` 扩充至 30/30 项全绿通过。

### 3.3 Runtime Conversation 接线与竞态清理
在 `public/runtime-conversation.js` 中接线：
- **输入防抖**：`input.oninput` 调度 400ms 防抖保存；
- **同步 Flush**：`send.onclick` 开头、会话切换 `show(next)`、失焦 `leave()`、销毁 `dispose()` 及 `beforeunload` 时同步 flush，避免丢字或旧定时器异步串写；
- **身份切换安全移走旧文本**：`draw()` 跟踪 `renderedLocatorKey`，当稳定 locator 改变时，即使用户处于 focus 状态也强制同步输入框，彻底防止将旧身份文本误发送到新会话；
- **发送成功条件清理**：
  仅当满足全部 5 项判定时清除草稿：
  1. 响应属于当前捕获的目标会话；
  2. 完整 Owner 仍然匹配；
  3. `draftRevision` 与提交时一致；
  4. 当前草稿文本等于已提交文本；
  5. 持久化存储副本与已提交文本一致；
- **竞态保护**：
  - 用户发送后继续输入新文字：ACK 返回不清理新文本；
  - A 会话发送后切到 B 会话：A 的迟到 ACK 不清理 B 草稿；
  - 发送失败或未决：保留文本，不自动重新发送；
  - 跨刷新恢复：仅当内存草稿为空时从匹配 key 恢复纯文本，恢复过程绝对不发起任何网络请求。

### 3.4 独立验收发现项修复与先红后绿证据

#### 问题一：清空草稿后状态重绘可能恢复旧文本
- **红测复现**：
  在输入“旧草稿”并确认已持久化后，用户主动清空输入框。若在 400ms 防抖删除完成前后台推来状态帧触发 `draw()`，由于旧实现无条件在 `!r.draft` 时调用 `maybeRestoreDraft(id)`，直接将未删除的旧持久副本重新恢复到内存和输入框中，造成幽灵草稿复活：
  ```text
  AssertionError [ERR_ASSERTION]: 防抖期间触发 draw 绝不恢复旧草稿到输入框
      at ok (C:\Users\21022\.codex\worktrees\z5-1-runtime-input\pi-GUI\tests\runtime-conversation.cjs:10:41)
      at C:\Users\21022\.codex\worktrees\z5-1-runtime-input\pi-GUI\tests\runtime-conversation.cjs:480:3
  ```
- **最小修复**：
  1. **明确清空立即删除**：在 `input.oninput` 中判定 `!input.value.trim()` 时，立即 `draftCoordinator.cancel()` 取消待执行写入，并直接同步调用 `clearRuntimeDraft(key)` 清除持久存储，消除 400ms 时间差。
  2. **恢复时机守卫**：在 `viewOf(id)` 维护 `draftRestored` 标志。持久草稿恢复仅在首次绑定或稳定 locator 发生变更（`locatorChanged`）时尝试恢复一次；普通状态重绘绝不反复调用 `maybeRestoreDraft`。
  3. **测试覆盖**：验证清空后防抖期间触发 `draw()` 不恢复、清空后持久副本立即删除、后续重新打字可重新持久化，以及旧草稿未保存时切换到新 locator 立即移走旧文本（`tests/runtime-conversation.cjs` 增至 75/75）。

#### 问题二：Owner 不变但 item 身份变化或身份冲突时旧草稿隔离
- **红测复现**：
  `public/runtime-store.js` 现有 `seed()` 在 `ownerUnchanged` 为 true 时直接执行 `prior.item = item;`，导致同一 `conversationId` 下即使 `item.nativeSessionId` 改变、`item.workspace.workspaceEpoch` 改变，旧草稿依然被原样保留：
  ```text
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 'draft to be isolated'
  - ''
      at C:\Users\21022\.codex\worktrees\z5-1-runtime-input\pi-GUI\tests\runtime-store.cjs:171:10
  ```
- **最小修复**：
  1. **字段冲突校验**：`stableIdentity` 补充对 `item.workspace` 与 `owner` 对应字段（`projectId`、`workspaceId`、`workspaceEpoch`）的一致性检查，发生冲突时直接返回 `null`（身份不可信）。
  2. **全分支隔离判定**：在 `ownerUnchanged` 命中分支中，同样补齐 `if (prior && !canInheritDraft(prior, item)) { prior.draft = ''; prior.draftRevision = 0; }`，确保任何无法证明身份完全一致的情况均强制隔离清空旧草稿。
  3. **测试覆盖**：验证同一会话同 Owner 下 `nativeSessionId` 改变、`workspaceEpoch` 改变及工作区字段冲突路径（`tests/runtime-store.cjs` 增至 33/33）。

---

## 四、测试执行与断言证据

### 4.1 本地测试套件矩阵

| 测试套件 | 退出码 | 结果与断言数 | 覆盖要点 |
| --- | --- | --- | --- |
| `tests/runtime-conversation.cjs` | 0 | 75/75（原 48，首轮 66，现 75） | IME 事件序列、keyCode 229、A/B 隔离、重启恢复、旧 ACK 隔离、超限提示、清空防抖重绘不复活、身份切换输入框移走旧稿 |
| `tests/runtime-store.cjs` | 0 | 33/33（原 25，首轮 30，现 33） | 稳定 locator 进程重启保留、nativeSessionId 变化隔离、epoch 变化隔离、同 Owner 下 item 身份变化隔离、字段冲突隔离 |
| `tests/runtime-draft.cjs` | 0 | 41/41（新增套件） | 身份提取、安全编码、20000 字符边界、超限清除旧副本、损坏 JSON 容错、防抖调度 |
| `tests/daily-use.cjs` | 0 | 31/31 | 快捷键注册、命令模型、连接状态文案 |
| `tests/session-background-ui.cjs` | 0 | 9/9 | 侧栏/后台会话隔离、流式保护、草稿隔离 |
| `tests/session-background-recovery.cjs` | 0 | 6/6 | 后台恢复、工具标签、迟到历史、审批清理 |
| `tests/context-reference-ui.cjs` | 0 | 10/10 | 上下文引用、变更视图展开与切换 |
| `tests/z5-runtime-input-electron.cjs` | 0 | 15/15（新增套件） | 真实 Chromium、正常沙箱（`sandbox=true`）、键盘事件、Reload 恢复、超限提示 |

### 4.2 正常沙箱 Electron 专项验证
运行命令：`node tests/z5-runtime-input-electron.cjs`
环境与配置：
- Chromium：`152.0.7977.130`
- Electron：`v44.4.3`
- `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`，无 `--no-sandbox` 参数
- 15 项真实窗口交互断言全部通过：
  1. 正常沙箱装配页加载成功
  2. 会话 B 初始输入为空且隔离
  3. 切回会话 A 草稿保留
  4. Shift+Enter 不发送 prompt
  5. keyCode 229 不发送 prompt
  6. compositionstart 期间 Enter 不发送
  7. compositionend 后正常 Enter 发送恰好一次
  8. 窗口重新加载成功
  9. 刷新后成功恢复会话 A 持久化草稿
  10. 刷新后成功恢复会话 B 持久化草稿
  11. 超过 20000 字符显示内联提示
  12. 1200px 宽窗口截图已保存（`docs/assets/z5-1/z5-1-runtime-input-wide-1200.png`）
  13. 900px 中窗口截图已保存（`docs/assets/z5-1/z5-1-runtime-input-mid-900.png`）
  14. 700px 窄窗口截图已保存（`docs/assets/z5-1/z5-1-runtime-input-narrow-700.png`）
  15. 缩短文本后内联提示隐藏
- 证据产物记录在 `docs/assets/z5-1/results.json`，无任何渲染器崩溃或资源残留。

### 4.3 真实 Windows IME 验证状态
- **受控事件验证**：在 jsdom 与真实 Chromium 中已验证合成 `compositionstart`、`compositionend`、`keyCode: 229` 与 `isComposing: true` 事件序列，均能正确拦截；
- **实体输入法状态**：由于当前自动化测试由 Node/Electron 进程脚本驱动，未经由 Windows 原生 IME 框架进行物理键盘中文输入法候选词实际敲击测试；依据仓库诚实性原则，**标记为未执行物理 Windows IME 人工复验**。

---

## 五、构建与产物校验

修改生产文件后，按要求执行产物构建与校验：
1. `npm run build:app -- --rebuild`：成功
   - 后端资源打包 343 项，单文件 SEA blob 注入生成 `build/Pi GUI.exe`（98.2 MB）；
   - Electron 应用组装并精简语言包，生成 `dist-app\Pi GUI-win32-x64\Pi GUI.exe`（234.9 MB）；
2. `npm run fixtures`：成功生成临时文档与提取测试桩；
3. `node tests/app-check.cjs`：26/26 项全部通过，内嵌资源完整，安全边界有效；
4. `node tests/exe-check.cjs`：49/49 项全部通过，单文件 EXE 独立拉起与功能完整；
5. 打包产物静态校验：`dist-app\Pi GUI-win32-x64\resources\app\public\runtime-draft.js` 存在且包含完整实现，`runtime-conversation.js` 正确引用新适配器。

---

## 六、CI 测试计划与 Canonical 状态

运行 `node scripts/run-test-group.mjs --validate`：
```text
test-plan: 222 canonical leaves; groups core, ui, security, native, faults
core: 146 (原 145，新增 tests/runtime-draft.cjs)
ui: 24
security: 27
native: 4
faults: 21
```
`npm test` 唯一测试链同步更新，所有分组叶子覆盖完整，无重复或遗漏测试。
依据测试执行政策，完整 canonical CI 记录待通过 PR CI 运行验证。

---

## 七、风险、安全与回滚方案

### 7.1 安全与隔离分析
- **无敏感信息落盘**：草稿持久化严格限定为纯文本，不记录 Token、Cookie、文件路径、附件二进制或模型思考；
- **执行授权不降级**：草稿持久化 key 仅用于本地文本恢复，不赋予任何发送执行权限；所有发送动作仍必须携带完整有效的 Owner；
- **跨会话防泄露**：当 `nativeSessionId` 或 `workspaceEpoch` 变化时，内存和本地持久存储强制隔离，旧草稿绝对不泄露到新会话。

### 7.2 回滚方案
- 本阶段改动全部按回滚边界独立拆分，若需回滚可执行 `git revert` 撤销对应提交：
  - 若需回滚草稿持久化：revert 提交 2 与提交 3；
  - 若需回滚 IME 保护：revert 提交 1；
- 存储向后兼容：新命名空间 `pi-gui.draft.v1:runtime:...` 独立隔离，不破坏旧版本 Classic 草稿。

---

## 八、验收结论与阶段决策

- **开发完成**：是
- **代码验收**：待独立验收
- **安全回归**：通过
- **Electron 专项**：通过（15/15 项，正常沙箱 Chromium）
- **真实 Windows 实体 IME 敲击**：未验证（已如实标记）
- **canonical**：待 PR CI 验证
- **允许合并**：待授权
- **允许发布**：待授权

> 本轮开发已完全收敛并结束，未修改任何 Z5-2 范围代码，等待用户独立验收。
