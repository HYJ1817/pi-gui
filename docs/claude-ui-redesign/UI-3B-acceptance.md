# UI-3B：模型选择与 Thinking 控件改造 — 验收报告

状态：Agent B 交付（2026-10-17）。基线 `d1524cb02f010cf9d474727c212f4048fc9abf75`（UI-2 收尾）。
工作区 `C:\pi-GUI-ui3-model`，分支 `codex/ui3-model`。**未推送、未合并、未发版。**

本轮只交付**视图模块 + 样式 + 测试**。`public/app.js`、`composer.js`、`usage.js`、`runtime-models.js`、
`ui/popover.js`、`model-capabilities.js`、`rpc.js`、共享 CSS/HTML、`package.json`、server、Electron
**一行未改**（`git status` 只有 4 个新增文件，见 §7）。视图模块尚未接进 `app.js` —— 接线步骤见 §6。

---

## 1. 实际改动和模块 API

### 1.1 新增文件

| 文件 | 行数 | 字节 | 作用 |
|---|---|---|---|
| `public/ui3-model-picker.js` | 485 | 20657 | 模型 / Thinking 选择器视图模块 |
| `public/ui3-model.css` | 142 | 6281 | 样式增量（花括号 37/37 平衡） |
| `tests/ui3-model.cjs` | — | — | jsdom 契约套件（50 项） |
| `tests/ui3-model-real.cjs` | — | — | 真实 Chromium 渲染套件（79 项） |

### 1.2 导出接口

| 导出 | 签名 | 说明 |
|---|---|---|
| `renderModelPicker` | `({models, current, expanded, pending, onSelect, onClose, capabilitySummary?, title?})` | 画模型列表并打开共享弹层 |
| `renderThinkingPicker` | `({levels, current, model, pending, onSelect, onClose, descriptions?, title?})` | 画 Thinking 档位并打开共享弹层 |
| `thinkingAvailability` | `({model, levels, pending}) → {state, levels, usable, label, detail}` | 纯函数，Thinking 可用性五值判定 |
| `capabilityFacts` | `(model) → {rows, contextWindow, maxOutputTokens, anyKnown}` | 纯函数，能力三值展开 |
| `modelDisplayLabel` | `(model) → string` | 纯函数，`名字 · Provider`；Runtime 可直接用 |
| `applyChipState` | `(button, state) → void` | 给 Chip 写 `data-ui3-state` |
| `setTriggers` | `({model?, think?}) → void` | 显式注入触发按钮（缺省回退 `getElementById`） |
| `THINK_DESC` | `{off, minimal, low, medium, high, xhigh, max}` | 档位**说明文案**表，非档位清单 |

**显式参数注入**是本模块的设计约束：它不 import `state.js`、不读 `S`、不发 RPC、不缓存模型事实。
模块的 import 只有两个纯模块（`./ui/popover.js`、`./model-capabilities.js`），测试用静态断言钉住（§5.2）。

### 1.3 五种 Thinking 状态（`thinkingAvailability`）

判定顺序**不可调换**，这是本轮的核心正确性：

| 顺序 | 条件 | state | 文案 |
|---|---|---|---|
| 1 | `pending` | `pending` | 正在读取当前模型支持的思考等级 |
| 2 | 有非 `off` 档位 | `ready` | （不画状态行） |
| 3 | 无档位 + `reasoning === false` | `unsupported` | 此模型不支持推理 |
| 4 | 无档位 + `reasoning === null` | `unknown` | 推理能力未知 |
| 5 | 无档位 + `reasoning === true` | `unavailable` | Pi 未提供可选思考等级 |
| — | 无模型 | `no-model` | 还没有读到当前模型 |

**第 2 条排在第 3 条之前是刻意的**：Pi 的实时档位是比静态 metadata 更强的证据。
Pi 说这个模型有 `off/low/high`，那就有 —— 即使 metadata 写 `reasoning: false`。
这条与 `tests/smoke.cjs:2824`「reasoning=false 仍按 Pi 返回两档」同源，本轮从视图侧再钉一次。

---

## 2. 现有 handler 复用方式

**没有新建业务模型状态，也没有第二个 Provider 注册表。** 逐项对应：

| 现有实现 | 位置 | 本模块怎么用 |
|---|---|---|
| `openModelPicker()` | `app.js:561-658` | **被替代的排版逻辑**。分组/折叠/当前项/能力摘要的**语义**逐条保留（§3），实现移到本模块 |
| `openThinkPicker()` | `app.js:660-700` | 同上；档位仍只来自 `S.thinkingLevels` |
| `setModel(provider, modelId)` | `rpc.js:395` | 由注入的 `onSelect` 回调调用，**本模块不发 RPC** |
| `setThinkingLevel(level)` | `rpc.js:425` | 同上 |
| `modelIdentity()` | `model-capabilities.js:9` | 直接复用，不自己解析 provider/id |
| `modelCapabilitySummary()` | `model-capabilities.js:79` | 默认摘要函数，可注入覆盖 |
| `modelCapability()` | `model-capabilities.js:59` | 三值能力来源 |
| `ui/popover.js` 全套 | `public/ui/popover.js` | `pop` 单例 + `openPop`/`closePop`/`popTitle`/`popItem`，**位置与关闭全交给它** |
| `renderModelControls()` | `composer.js:16` | **不动**。Chip 文案与 disabled 仍是它的职责；本模块只补 `data-ui3-state` |
| `S.modelSwitchPending` | `state.js:108` | 作为 `pending` 参数传入，不自己判断 |

**Provider 折叠状态**由调用方持有（原实现是 `app.js:558` 的模块级 `Set`），本模块只在原地 `add`/`delete`，
不复制、不缓存。当前模型所在组每次打开都强制展开（原 `app.js:592` 的语义）。

**复用而非重写弹层**：`pop.id === 'composerPopover'` 仍是 `popover.js:11` 创建的那一个，
全文档只有一个 `.pop`（测试断言 `document.querySelectorAll('.pop').length === 1`）。

---

## 3. 模型与 Thinking 状态矩阵

### 3.1 模型列表

| 维度 | 取值 | 呈现 | 证据 |
|---|---|---|---|
| Provider 分组 | 有 `providerId` / 仅 `provider` / 都没有 | 分别按结构化身份 / 兼容字段 / `默认` 分组 | `ui3-model-picker.js:groupByProvider` |
| 折叠 | 当前组强制展开；其余记忆用户操作 | `aria-expanded` + `hidden` + `⌄`/`›` | 真实渲染 8 组断言 |
| 当前项 | Provider + modelId 双匹配 | `.on` + `aria-current` + 左侧 `--ui-link` 竖标 | 同名跨 Provider 唯一性断言 |
| 身份行 | 有 Provider / 无 Provider / 无模型 | `provider / modelId` / `modelId` / 尚未读到当前模型 | 截图 `models-*-*.png` |
| 能力 | `true` / `false` / `null` | 行内只列正向；`false` 进 `title`；**`null` 行内不出现** | §3.3 |
| 无任何证据 | 全 `null` | 行内「能力未知」（斜体、中性色） | 截图 `models-light-700.png` |
| 大量模型 | 400+ | 弹层内部纵向滚动，不横向溢出 | 真实渲染 400 模型夹具 |
| 长名 | 180 / 300 字符 | `-webkit-line-clamp:2`（≤760px 为 3）换行 | 真实渲染 8 组断言 |

### 3.2 Thinking

| 状态 | Chip（`renderModelControls` 既有文案） | 弹层（本模块） | 可点 |
|---|---|---|---|
| pending | `思考同步中…` + disabled | 状态行「正在读取…」+ 档位全禁用 | 否 |
| ready | `思考 <level>` | 档位列表，当前项打勾 | 是 |
| unsupported | `思考不可用` + disabled | 「此模型不支持推理」 | 否 |
| unknown | `思考不可用` + disabled | 「推理能力未知」（斜体） | 否 |
| unavailable | `思考不可用` + disabled | 「Pi 未提供可选思考等级」 | 否 |
| 仅 `off` | `思考不可用` + disabled | 同 unavailable | 否 |
| no-model | `思考不可用` + disabled | 「还没有读到当前模型」 | 否 |

### 3.3 能力三值纪律

`null` **绝不**显示成 `false`。行内第二行只放 `=== true` 的能力与上下文长度；
明确 `false`（`不支持图片` / `不支持推理` / `不支持 Tools`）与 `Max output` 只进 `title`。
全部未知时行内写「能力未知」—— 这是**中性陈述**，不是「不支持」。
依据：`docs/model-capabilities.md:76-77`、`AGENTS.md` 三值纪律、`docs/capability-ux.md:45-47`。

### 3.4 回读 / 失败 / 无乐观选择

视图**从不写 `current`**。点选只触发 `onSelect`，界面在调用方回读并重新渲染前保持原样。
因此「设置失败后保留虚假的乐观选择」在结构上不可能发生 —— 不是靠约定，是没有可写的路径。
真实失败回读链路由既有 `rpc.js:112-131`（失败也回读）保证，本模块不参与、不干扰。

---

## 4. Runtime 差异

只读核对 `runtime-models.js`（112 行）与 `runtime-conversation.js`（472 行），**一行未改**。

| | Classic（`rpc.js` + `usage.js` + `app.js`） | Runtime（`runtime-models.js` + `runtime-conversation.js`） |
|---|---|---|
| 事实持有 | 全局 `S.state` / `S.models` / `S.thinkingLevels` | 按 conversationId 的 `Map` 条目 |
| 身份判据 | `modelGeneration` + `S.workspaceGeneration` + request-id 前缀 | 每条目 token + **九键 owner 全等** + store revision |
| 原生应答配对 | `set_model` 的 `evt.id` | `{id, command}` 对 store 已接受帧 |
| 回读 | 成功与失败都回读，两条腿都到齐才更新 | 原生成功后两条读 `Promise.all` |
| 失败提示 | toast + 回读纠正 | 每条目 `notice`，永不透传上游原文 |
| 控件形态 | `popover` 单例 + Chip | 会话视图内的原生 `<select>` |
| 推理门槛 | 无（以 Pi 档位为准） | **额外要求 `reasoning === true`**（`runtime-models.js:66`） |
| 档位门槛 | 无 | 额外要求 `levels.includes(level)`（`runtime-models.js:109`） |

**关键差异（不统一，也不该统一）**：Runtime 的 `setThinking` 比 Classic 多一道 `reasoning === true` 前置；
Runtime 在 `reasoning !== true` 时把 `levels` 置 `null`（注释原文：「A no-model Pi may return every level.
That is not capability evidence.」）。**UI-3 阶段不统一这两条数据源** —— 它们由不同的权威、
不同的配对机制支撑，强行合并会把 Runtime 的 owner 校验削弱成 Classic 的 generation 计数。

**本模块对 Runtime 的纯展示辅助**：`modelDisplayLabel(model)` 与 `capabilityFacts(model)` 都是纯函数、
不碰 DOM、不读全局状态。Runtime 若要用，只需 `import`，**不必**把 Runtime 模型信息绑到 Classic 的 `S` 上。
本轮**不**替 Runtime 改 `<select>` 渲染（那属于 `runtime-conversation.js` 的 owner，不在本分支所有权内）。

---

## 5. 测试及截图

### 5.1 套件与实测数字

| 套件 | 结果 | 说明 |
|---|---|---|
| `tests/ui3-model.cjs` | **50/50** | jsdom 契约（`ui3b-evidence/contract.log`，exit 0） |
| `tests/ui3-model-real.cjs` | **79/79** | 真实 Chromium + CDP（`ui3b-evidence/real-render.log`，exit 0） |
| `tests/model-capabilities.cjs` | 34/34 | 受影响套件 |
| `tests/model-fallback.cjs` | 74/74 | 受影响套件 |
| `tests/usage-quota.cjs` | 229/229 | 受影响套件（`test:quota`） |
| `tests/runtime-models.cjs` | 51/51 | Runtime 差异对照 |
| `tests/smoke.cjs` | **1338/1338** | 含既有模型/思考选择器全部断言，未回归 |
| `tests/ui2-classic.cjs` | 48/48 | UI-2 展示层未受影响 |
| `tests/ui2-runtime-display.cjs` | 82/82 | 同上 |
| `tests/modules.cjs` | 117/117 | 模块依赖方向与无环守卫 |
| `tests/electron-guard.cjs` | 123/123 | **全量扫描 `public/`** 的特权 API 守卫，新文件已纳入 |

**断言总数没有变少**：`smoke` 仍为 1338（基线同值），受影响套件数字与基线一致。新套件是净增的 129 项。
按任务约定**未改 `package.json`**，两套新测试由集成方接入 canonical 链（§6）。

### 5.2 契约套件覆盖（50 项）

任务点名的每一条：

- Provider 分组与数量（3 组 / `2,1,2` / 400+ 组计数）
- 当前模型选中（`.on` 与 `aria-current` 各恰好 1 个）
- **两个 Provider 含同名模型**（`deepseek`/`openrouter` 都有 `deepseek-reasoner`；只有真正当前的被选中）
- 长名称（300 字符）/ 大量模型（400+）
- 可用与不可用 Thinking 等级（五值两两不同）
- capability unknown（不显示成 `false`；`false` 与 `unknown` 是不同值）
- pending / 失败 / 回读（pending 优先；无乐观选择；回读纠正）
- 键盘操作及焦点恢复（↑↓ / Home / End / ←→ / 回绕 / roving tabindex / Escape 还焦点）
- **原有模型执行回调只触发一次**（选择与键盘各一次）
- 结构守卫：模块 import 白名单、无传输调用、不 import `app.js`、可被 `esm-bundle` 链接器接受

### 5.3 真实渲染覆盖（79 项）

**两主题 × 四宽度（dark/light × 700/900/1200/1536）× 每种状态**：

| 断言组 | 内容 |
|---|---|
| 弹层不出视口 | `top/left/right/bottom` 四边都在视口内 |
| 无横向溢出 | 弹层 `scrollWidth - clientWidth ≤ 1`，无条目溢出 |
| 长模型名换行 | 高度 > 0、不超弹层右缘、`white-space ≠ nowrap` |
| 能力说明可见 | 高度 > 0、字号 ≥ 10px、颜色非透明 |
| 选中态与身份行 | 唯一选中 + Provider/modelId 正确 + 身份行文案 |
| Provider 折叠标题 | 可见、`aria-expanded`、箭头已画 |
| Thinking 弹层 | 7 档与 Pi 返回一致且不出视口 |
| 不可用状态行 | 在视口内、可读、无横向溢出 |
| 能力未知 | `state=unknown` 且文案**不含**「不支持」 |
| 弹层 z-index | `position:fixed` 且 `z-index ≥ 70`，高于右栏 |
| 真实键盘 | CDP `Input.dispatchKeyEvent`（非合成事件）：按漫游序列前进、↑ 回绕、Escape 关闭并还焦点 |
| reduced-motion | 静态状态完整（条目未丢、组头未塌） |
| 无 JS 异常 | `Runtime.exceptionThrown` 为空 |

### 5.4 截图

`docs/claude-ui-redesign/ui3b-evidence/` 共 **32 张 PNG** + `results.json`（逐条断言 + 实测几何）：

- `models-{dark,light}-{700,900,1200,1536}.png`（8）
- `think-{dark,light}-{700,900,1200,1536}.png`（8）
- `think-unavailable-{dark,light}-{700,900,1200,1536}.png`（8）
- `think-unknown-{dark,light}-{700,900,1200,1536}.png`（8）

**已逐张目视核对**（AGENTS.md 要求：jsdom 不做布局，断言全绿说明不了排版）。
确认：深/浅两主题配色正确；700px 下长模型名折到 3 行且不溢出；`能力未知` 是斜体中性灰、
与「不支持」在视觉上可区分；`思考等级` 弹层 7 档含说明文案、当前项 `high` 有勾选与左竖标；
`think-unavailable` 与 `think-unknown` 的状态行文案确实不同。

### 5.5 测试过程中发现并修正的三处（都不是产品缺陷，但都会造成假绿/假红）

1. **`setDeviceMetricsOverride` 会异步触发 `window resize`**，而 `ui/popover.js` 的既有行为是
   在 resize 时**关闭**弹层（那是对的，位置已失效）。测试在切宽度后立刻开弹层，弹层被迟到的
   resize 收掉，于是「长名高度为 0」。修法是先等 resize 落地再开弹层。
   —— 这是**测试自己制造了 resize**，不是产品问题。
2. **长名条目在默认收起的组里**，`hidden` 子树量不到布局。修法是先展开再量（顺带覆盖折叠交互）。
3. **无头 Chrome 的标签页默认未激活**，`document.hasFocus()` 为 `false`，
   `Input.dispatchKeyEvent` 投递的按键根本进不了页面 —— 键盘断言会静默变成「什么都没发生」。
   修法是 `Page.bringToFront`，**并加一条前置断言**把这个环境前提钉住，
   免得下次再把它读成产品缺陷（AGENTS.md「测试红先分清是环境还是产品」）。

---

## 6. 需要集成方修改的 app.js 接入点

本分支**未改** `app.js` / `index.html` / `package.json`。集成方需要做三件事：

### 6.1 `public/index.html`：加样式表（**必需**，否则 §3.1 的换行与 §1.3 的分档配色不生效）

```html
<link rel="stylesheet" href="/ui3-model.css">
```

放在 `styles.css` **之后**（`index.html:9` 之后），让本文件的规则在同优先级时覆盖默认值。

> ⚠️ 真实渲染套件是在运行时把这份真实文件 `<link>` 进去量的，所以它证明的是
> **文件本身正确**；`index.html` 那一行仍必须由集成方加。**漏了它，测试依然全绿而排版不对。**

### 6.2 `public/app.js`：把两个 handler 委托给本模块

`app.js` 顶部加 import：

```js
import { renderModelPicker, renderThinkingPicker, setTriggers, applyChipState } from './ui3-model-picker.js';
```

`openModelPicker()`（`app.js:561-658`）函数体替换为：

```js
function openModelPicker() {
  if (!S.models.length) {
    sendCommand({ type: 'get_available_models' });
    toast('正在获取模型列表…', 'info');
    return;
  }
  renderModelPicker({
    models: S.models,
    current: S.state?.model || null,
    expanded: expandedModelProviders,   // 复用既有 Set，保留跨次打开的记忆
    pending: S.modelSwitchPending,
    onSelect: (provider, modelId) => setModel(provider, modelId),
    onClose: () => {},
  });
}
```

`openThinkPicker()`（`app.js:660-700`）函数体替换为：

```js
function openThinkPicker() {
  renderThinkingPicker({
    levels: S.thinkingLevels,
    current: S.state?.thinkingLevel || null,
    model: S.state?.model || null,
    pending: S.modelSwitchPending,
    onSelect: (level) => setThinkingLevel(level),
    onClose: () => {},
  });
}
```

> **两处 guard 的归属要说明**：原实现对「无档位」发 `toast` 然后 return（`app.js:665-668`）。
> 新实现**改成画弹层**，因为弹层能说清是「不支持推理」「能力未知」还是「Pi 没给」——
> 一句话 toast 说不清这三种。`pending` 的 toast（`app.js:661-664`）同样由弹层状态行替代。
> 如果集成方希望保留 toast，把 guard 加回函数开头即可，模块行为不受影响。

`knownModelProviders`（`app.js:559`）在新实现里不再需要（清理逻辑内联在 `pruneExpanded`），
可以一并删除；`expandedModelProviders` **必须保留**，它是折叠记忆的持有者。

### 6.3 可选：Chip 状态分档（接线前 CSS 只认 `:disabled`）

```js
// 在 renderModelControls()（composer.js:16）末尾，或 app.js 的调用点之后
applyChipState(el.btnThink, thinkingAvailability({
  model: S.state?.model || null, levels: S.thinkingLevels, pending: S.modelSwitchPending,
}).state);
```

不做这一步也能用 —— 只是「同步中」与「不可用」在视觉上分不开（`ui3-model.css` 的
`.chip[data-ui3-state=...]` 规则不生效）。**这是纯增强，不是必需接线。**

### 6.4 `package.json`：注册测试

在 `test` 链里加 `node tests/ui3-model.cjs`（纯 jsdom，跨机器可跑）。
`tests/ui3-model-real.cjs` 需要本机 Chrome，**建议只加 `test:ui3` 别名**，不进 canonical 链
（与 `ui2-visual.cjs` / `model-capabilities-shot.cjs` 同层，见 `docs/testing.md` 的 E 层）。

### 6.5 集成后必须重建产物

改的是 `public/`，按仓库约定要让用户看到新排版需 `npm run build:exe` / `npm run build:app -- --rebuild`。

---

## 7. 真实最终提交 SHA

本文件与实现同在一个提交里，**自指 SHA 写进来就会变**，所以按本系列惯例不在此处写自身 SHA。
提交顺序（按回滚边界拆）：

1. `public/ui3-model-picker.js` + `public/ui3-model.css` —— 业务/视图代码
2. `tests/ui3-model.cjs` + `tests/ui3-model-real.cjs` —— 测试
3. 本报告 + `docs/claude-ui-redesign/ui3b-evidence/` —— 文档与证据

取 SHA：

```bash
git log --oneline -3
```

`git status` 相对基线的净变化只有这 4 个新增文件（外加本报告与证据目录）：

```
?? public/ui3-model-picker.js
?? public/ui3-model.css
?? tests/ui3-model.cjs
?? tests/ui3-model-real.cjs
```

---

## 8. 遗留问题和回退方法

### 8.1 遗留问题

| # | 问题 | 影响 | 归属 |
|---|---|---|---|
| 1 | **视图模块尚未接进 `app.js`** | 用户当前看不到任何变化；本分支是纯交付 | 集成方，步骤见 §6 |
| 2 | **`ui3-model.css` 未在 `index.html` 加载** | 换行与状态分档配色不生效（功能不受影响） | 集成方，§6.1 |
| 3 | 无 `test:ui3` 别名、未进 canonical 链 | 新套件不会在 `npm test` 里跑 | 集成方，§6.4 |
| 4 | 弹层无焦点陷阱（Tab 会走出弹层） | 与既有 `ui/popover.js` 行为一致，本轮不改外壳 | 超出本分支所有权；UI-4 的 4.1 统一处理 |
| 5 | 键盘漫游未实现二维方向键 | 原实现连一维都没有；`claude-interaction-patterns.md:123` 的二维漫游属可选增强 | 后续 |
| 6 | Runtime 仍是 `<select>`，未用本模块 | 两套控件形态并存；数据源差异是**有意的**（§4） | 需 UI-3 之外的授权才能统一 |
| 7 | 未做真实 Electron 窗口验证 | 只跑了无头 Chromium | 本机 `test:app` 环境限制（见项目记忆） |
| 8 | 未跑完整 `npm test` | 按任务约定（并行分支不抢 canonical 入口） | 集成方在合并后跑 |

### 8.2 回退方法

本分支的改动**全部是新增文件**，没有一行修改现有文件，所以回退是纯删除：

```bash
git rm public/ui3-model-picker.js public/ui3-model.css tests/ui3-model.cjs tests/ui3-model-real.cjs
git rm -r docs/claude-ui-redesign/ui3b-evidence docs/claude-ui-redesign/UI-3B-acceptance.md
```

**若已按 §6 接线**，回退分两步（先摘接线，再删文件），且**不能**用整仓 `reset`/`clean`：

1. 还原 `openModelPicker` / `openThinkPicker` 函数体（本报告 §6.2 引用的原实现仍在
   `app.js:561-700`，接线前先备份这两个函数），删除 `app.js` 里的 import 与可选的
   `applyChipState` 调用。
2. 删掉 `index.html` 里的 `<link rel="stylesheet" href="/ui3-model.css">`。
3. 再删上述 4 个文件与 2 个文档路径。

**回退不会影响**：`S` 的任何字段、`rpc.js` 的模型/思考串行队列、`composer.js` 的 Chip 文案、
`popover.js` 的外壳、Runtime 的 owner/readback/pending/sequence/action、用户草稿与偏好。
原独立实现（`app.js:561-700`）在接线前保持完整可用，摘掉接线即恢复原行为。
