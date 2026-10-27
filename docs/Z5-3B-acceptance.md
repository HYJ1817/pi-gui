# Z5-3B 历史工具摘要 UI 集成与最终收尾验收报告

## 一、基本信息与分支环境

- **当前分支**: `codex/z5-3b-history-ui`
- **独立 Worktree**: `C:/Users/21022/.codex/worktrees/z5-3b-history-ui/pi-GUI`
- **基线 HEAD**: `6eddc3e2b4d60892792cef557060df78bccd4241`（合并 PR #39：历史工具摘要后端与安全正文位置）
- **PR #39 状态**: 已于 2026-10-27 12:45:48+08:00 正式合并入 `origin/main`；本轮以最新主线基线创建独立分支，无代码冲突。
- **环境条件**: Node.js `v24.22.1`, Electron `44.4.3`, Chromium `152.0.7977.130`, Windows 11 `x64`。

---

## 二、历史摘要 UI 修改范围

本次改动严格聚焦于前端只读历史视图渲染与历史搜索定位，未扩大后端接口权限，未增加任何第三方依赖：

1. **`public/runtime-conversation.js`**:
   - **状态提示更新**: 废弃旧硬编码 `HISTORY_NOTE`，引入 `formatHistoryState(history, owner)`：
     - 新版 API 带 `toolSummary`: 输出 `历史正文与只读工具摘要；不含思考及用量`；
     - 旧版 API 缺 `toolSummary`: 保持兼容旧文案 `历史只含正文（无工具、思考、用量）`；
     - 摘要被截断: 追加 `（仅显示部分工具）`；
     - 存在 `unknown` 或 `uncertain`: 追加 `（状态证据不完整）`；
     - 明确错误原因（如 `invalid_records`、`unmatched_results`）: 使用固定安全映射字典解释，绝不展示底层原始错误堆栈；
     - 无工具记录（`no_tool_calls`）: 保持界面清爽，不显示空工具列表。
   - **工具行安全渲染**:
     - 增加 `createHistoryToolRow(item)`: 只读 `span.rtc-history-tool`，通过 `textContent` 写入 `toolName · 状态文案`，防止任何恶意 HTML / 脚本注入；
     - `completed` 映射为 `已记录完成`（`data-status="completed"`）；
     - `error` 映射为 `结果报错`（`data-status="error"`）；
     - `unknown` 映射为 `状态未知`（`data-status="unknown"`）；
     - 工具行禁止点击交互，无执行、批准、重试或恢复操作。
   - **`messagePosition` 精准切片与安全降级**:
     - `pos = 0`: 插入在第一条正文之前；
     - `pos = N`: 插入在 `messages[N]` 之前；
     - `pos = messages.length`: 插入在正文末尾；
     - 同一位置的多条工具摘要严格保持后端返回的自然顺序；
     - `pos = null` 及非法类型或越界位置: 安全降级至顶部独立的 `.rtc-history-unconfirmed`（“位置未确认”）区域，绝不崩溃正文，无未确认项时不生成任何空元素。
   - **历史正文行标识与搜索跳转定位保护**:
     - 正文消息元素显式标注类名 `.rtc-history-message`；
     - 搜索跳转查找优化为 `output.querySelectorAll('.rtc-history-message')`，与工具行彻底隔离，使历史搜索按 `messageId` 和 `userIndex` 的高亮及滚动不受工具行插入影响。
   - **生命周期与状态清除**:
     - `loadHistory()` 正确接收后端返回的安全投影 `toolSummary`；
     - “返回实时会话”（`liveBtn`）或“恢复会话”（`resume`）时，彻底清空历史工具摘要 DOM，不污染实时输出。

2. **`public/styles.css`**:
   - 增加 `.rtc-history-message`（行内正文保留原有换行流）；
   - 增加 `.rtc-history-tool` 紧凑低干扰样式（字号 12px，单行块级，带状态主题色彩映射 `--ok`、`--err`、`--t3`）；
   - 增加 `.rtc-history-unconfirmed` 独立边框区域与标题；
   - 增加 `.rtc-history-empty` 占位样式。

---

## 三、`messagePosition` 消费合同与搜索定位保留

| 场景 | `messagePosition` 取值 | 前端渲染表现 | 搜索索引影响 |
| :--- | :--- | :--- | :--- |
| 正文头部工具 | `0` | 插入首条正文消息之前 | 不占用 `userIndex`，不改变 `data-history-message-id` |
| 正文中部工具 | `N` (`0 < N < messages.length`) | 插入在 `messages[N]` 之前 | 正文消息行按 `.rtc-history-message` 检索，定位精准 |
| 正文末尾工具 | `messages.length` | 追加在最后一条正文消息之后 | 无影响 |
| 共享同一位置 | 相同整数 `pos` | 严格保持原始数组顺序依次插入 | 无影响 |
| 历史被截断/丢弃 | `null` | 归入顶部独立的“位置未确认”只读区域 | 独立容器，不附着在任何正文行上 |
| 非法/异常位置 | `< 0` / `> len` / 非整数 / 非数字 | 安全降级归入“位置未确认”区域 | 容错保护，正文正常显示无异常 |

### 搜索定位防护验证
现有历史搜索使用 `output.dataset.historyMatch` 与滚动居中逻辑。在 `tests/runtime-conversation.cjs` 与 Electron 窗口中实测证明：
- 用户搜索到 `messageId = 'm-target'` 或 `userIndex = 0` 时，即使前后插有多个工具摘要行，`querySelectorAll('.rtc-history-message')` 能精准锁定真实的正文消息节点并触发居中滚动；
- 工具行本身不含 `historyMessageId` 和 `historyUserIndex`，绝不会成为搜索命中的假目标。

---

## 四、A/B 会话与 Runtime 隔离验证

1. **A/B 乱序隔离**: 在会话 A 发起历史查询后立即切至会话 B，迟到的 A 历史响应仅写入 A 内部缓存，绝不污染 B 的正文、状态行与工具摘要行。
2. **代次保护 (`historyToken`)**: 同一会话因状态更新导致代次递增时，先前在飞的旧响应到达后被自动丢弃，最新发起的响应正常渲染，杜绝旧状态覆盖新状态。
3. **Locator 强校验**: 预期 locator 与后端返回的会话标识发生冲突时（如 `workspaceEpoch` 变化），拒绝渲染并提示“会话历史身份已变化，请重新搜索。”
4. **实时返回与恢复**: 从历史视图点击“返回实时会话”或“恢复会话”，历史工具行立即被彻底卸载，恢复为实时任务输出或空闲草稿态。
5. **Dormant 只读性**: 浏览休眠会话历史绝不触发 `spawn`，不启动外部 Pi，不增加 Runtime slot。

---

## 五、先红后绿（TDD）执行证据

### 1. 红态证据（新增 20 项断言前）
在未改造 UI 前运行更新后的 `tests/runtime-conversation.cjs`，首条断言即失败：
```text
AssertionError [ERR_ASSERTION]: 1. 正文之间正确插入工具行
    at ok (C:\Users\21022\.codex\worktrees\z5-3b-history-ui\pi-GUI\tests\runtime-conversation.cjs:10:41)
    at C:\Users\21022\.codex\worktrees\z5-3b-history-ui\pi-GUI\tests\runtime-conversation.cjs:628:3
  actual: false,
  expected: true
Command exited with code 1.
```

### 2. 绿态证据（实现完成后）
更新 `public/runtime-conversation.js` 与 `public/styles.css` 后运行：
```text
  ok  1. 正文之间正确插入工具行
  ok  7. completed/error/unknown 状态文案映射准确
  ok  5. 新版 API 状态行包含只读工具摘要说明及不完整提示
  ok  2. 多个工具共享一个位置并保持后端顺序插在正文之间
  ok  3. messagePosition=0 插入在首条正文之前
  ok  4. messagePosition=messages.length 插入在正文末尾
  ok  5. messagePosition=null 位于独立的“位置未确认”只读区域
  ok  6. 非法位置安全降级至未确认区域，正文正常显示
  ok  8. 旧 API 不含 toolSummary 时保持正文-only 兼容提示且无工具行
  ok  9. 空摘要不产生多余元素，状态行正常
  ok  10. 100项摘要容量边界正常渲染且数量完全吻合
  ok  11. 正文800项截断与摘要100项截断并存时提示清晰且未确认区域正常隔离
  ok  12. 历史搜索按 messageId 精确定位到正文行而非工具行
  ok  13. 历史搜索按 userIndex 精确定位到正文行而非工具行
  ok  切到 B 显示 B 自己的历史与工具
  ok  14. A 请求迟到不覆盖当前会话 B 的工具摘要与正文
  ok  新响应正常呈现
  ok  15. 同一会话较旧响应因代次被丢弃，不覆盖新响应
  ok  16. locator 变化拒绝显示旧摘要并给出 notice
  ok  LIVE 会话已显示历史工具行
  ok  17. 返回实时会话后历史工具行与未确认区域完全清除
  ok  恢复前历史工具已呈现
  ok  18. 显式恢复会话发起了 resume 且历史摘要被清空
  ok  19. 恶意工具名称及状态转义为纯文本，无 HTML 标签注入
  ok  只读历史下发送按钮与输入框禁用
  ok  20. 只读历史界面交互绝不产生工具、审批或 prompt 动作
Runtime conversation: 104/104
Command exited with code 0.
```

---

## 六、定向测试运行记录

| 测试套件文件 | 覆盖范围与断言数 | 结果 |
| :--- | :--- | :--- |
| `tests/runtime-conversation.cjs` | 中央会话、20项摘要契约、草稿、A/B隔离 (104/104) | **PASS** |
| `tests/runtime-history-search.cjs` | 原生历史搜索与位置关联元数据 (37/37) | **PASS** |
| `tests/history-tool-summary.cjs` | 工具摘要投影核心、800正文与100工具双截断 (36 cases, 161/161) | **PASS** |
| `tests/history-tool-summary-http.cjs` | HTTP 历史路由、安全边界与 token 鉴权 (20 cases, 86/86) | **PASS** |
| `tests/runtime-models.cjs` | Runtime 模型与状态投影 (52/52) | **PASS** |
| `tests/thinking-availability.cjs` | Z5-2 统一思考等级合同可用性 (34/34) | **PASS** |
| `tests/runtime-draft.cjs` | Z5-1 草稿协调与 IME 边界 (42/42) | **PASS** |
| `tests/ui3-integration.cjs` | UI3 综合集成验证 (23/23) | **PASS** |
| `tests/z5-3b-history-ui-electron.cjs` | 真实 Electron 窗口正常沙箱验证 (16/16) | **PASS** |

---

## 七、Electron 正常沙箱真实窗口验收

专项验证脚本：`tests/z5-3b-history-ui-electron.cjs`（夹具 `tests/fixtures/z5-3b-history-ui-electron.cjs`）

- **安全沙箱环境参数**:
  - `sandbox: true`
  - `contextIsolation: true`
  - `nodeIntegration: false`
  - 严禁 `--no-sandbox` 伪造证据。
- **验证项（全部通过 16/16）**:
  1. 正常沙箱装配页加载成功；
  2. 只读状态行包含历史工具说明与截断不完整提示；
  3. 只读浏览不启动 Pi，不增加运行名额；
  4. 工具摘要行全部正确呈现；
  5. completed 状态映射为“已记录完成”；
  6. error 状态映射为“结果报错”；
  7. unknown 状态映射为“状态未知”；
  8. `messagePosition=null` 放在独立的位置未确认区域；
  9. 1200px 宽度下无横向溢出；
  10. 900px 宽度下无横向溢出；
  11. 700px 宽度下无横向溢出；
  12. 历史搜索定位能按 `messageId` 正确标记匹配目标；
  13. 没有工具调用的会话不显示空工具列表及未确认区域；
  14. 没有工具调用时状态行正常且不报错；
  15. A/B 会话快速切换回 `conv-tools` 正确恢复自己的工具摘要；
  16. Renderer 控制台无新增错误（0 条报错）。
- **进程残留检查**: 退出后无孤儿子进程残留（`taskkill` 退出码校验）。
- **截图与机器可读资产保存目录**: `docs/assets/z5-3b/`
  - `z5-3b-history-wide-1200.png`
  - `z5-3b-history-mid-900.png`
  - `z5-3b-history-narrow-700.png`
  - `z5-3b-history-search-jump.png`
  - `z5-3b-history-clean-no-tools.png`
  - `results.json`

---

## 八、生产构建与打包验证（App / SEA）

根据仓库规约，修改 `public/` 必须执行生产产物重建并验证打包版本：

1. **构建执行**:
   ```bash
   npm run build:app -- --rebuild
   ```
   产出：
   - SEA 单文件二进制：`build/Pi GUI.exe` (98.2 MB)
   - Electron 桌面免安装包：`dist-app/Pi GUI-win32-x64/` (329.2 MB)
2. **校验执行**:
   - `node tests/app-check.cjs`: **26/26 通过**（无 `node_modules` 目录下内嵌后端、资源加载与 RPC 启动全部正常）
   - `node tests/exe-check.cjs`: **49/49 通过**（单文件 EXE 静态资源、接口与行为完整性通过）
   - `node tests/history-tool-summary-packaged.cjs`: **18/18 通过**（App 与 SEA 两种打包形态下，均成功验证历史摘要安全读取、鉴权与正文位置对应）
3. **打包版本 UI 内容验证**:
   - 提取 `dist-app/Pi GUI-win32-x64/resources/app/public/runtime-conversation.js`，确认包含 `rtc-history-tool` 渲染逻辑；
   - 提取 `dist-app/Pi GUI-win32-x64/resources/app/public/styles.css`，确认包含 `.rtc-history-tool` 及未确认区域样式。
4. **产物散列（SHA-256）**:
   - `build/Pi GUI.exe`: `E4BB5D37D84E80C174F61A0AD3C6D418F7F3474D47F926BE169DFB5E53533DBD`
   - `dist-app/Pi GUI-win32-x64/Pi GUI.exe`: `C8755F70993AECF1DA95A2557234A3FA2B59C876F7419CA62FAB41147F01D81B`

---

## 九、Canonical 测试覆盖与 CI 门禁检查

- **CI 套件核验**: `npm run test:ci`（包含 `ci-test-plan`, `ci-workflow`, `ci-results`, `ci-summary`, `ci-history`, `ci-doc-scope`, `release-ci-proof`, `nsis-bootstrap`）。
- **测试计划树**:
  ```text
  ci-test-plan: 225 leaves across 5 groups; coverage exact
  ci-workflow: independent build readiness 5/5; both code/docs retain full CI; gate name unique
  ci-workflow: actual gate fail-closed matrix 15/15
  ci-results: 10/10 passed
  ci-summary: 30/30 passed
  ci-history: 21 assertions passed
  ci-doc-scope: 28/28 passed
  release-ci-proof: 16/16; failed=0
  nsis-bootstrap: 12/12 passed
  ```
- **依赖与 Lockfile**:
  - 无新增 `dependencies` 或 `devDependencies`；
  - `package-lock.json` 保持零漂移；
  - 核心测试套件无任何删减。

---

## 十、安全复查与回滚方案

### 1. 安全边界检查
- **XSS 防护**: 工具名和状态全部由原生 `el('span')` 和 `textContent` 写入，即使伪造恶意 `<script>` 或 `<img onerror>` 字符仅作为纯文本展示；
- **防伪造历史**: 严禁拿 live tools 的运行态伪造历史记录；
- **只读保证**: 历史工具条禁止点击、无任何 command 派发能力；只读模式下输入框及发送按钮禁用；
- **隐私保护**: 原生 `sessionIdentity`、文件真实绝对路径、原始命令行参数、思考原文与用量数据绝不泄漏进历史工具摘要。

### 2. 回滚方案
本轮变更边界清晰，业务代码仅涉及：
- `public/runtime-conversation.js`
- `public/styles.css`
若需紧急回滚，可直接使用 `git revert` 撤销本轮 UI 提交，系统将自动回退为纯正文显示模式，完全不影响 Z5-3 后端接口和既有会话。
