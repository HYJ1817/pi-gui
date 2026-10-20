# 报告 C — Claude Desktop 2.42304.0 · 交互行为层

> 来源：`claude-app-asar/.vite/build/index.chunk-lzaSYO3Q.js`（主进程 6.75 MB）
> 提取产物：`out/menu-tree.json` `out/MENU.md` `out/accelerators.json` `out/ipc-map.json`

---

## 0. 菜单装配机制

```js
dLi = async e => aFi([
  lEi(e),    // File
  wwi(),     // Edit
  XIi(e),    // View
  mEi(e),    // Go
  ...(Eq() ? [await pii()] : []),   // Developer（受 DevMode 开关控制）
  await GPi(e)                      // Help
])
Menu.buildFromTemplate(dLi())
```

- `aFi()`：给每个顶层菜单**自动补一个隐藏项** `Alt+<首字母>`（Windows 菜单栏助记符）。
- `X9r()`：过滤 `visible:false`、折叠连续 `separator`。
- `Eq()`：是否显示 Developer 菜单（`XPi()` 弹确认框落盘 `allowDevTools:true`）。
- 托盘菜单 `mLi()`：`Show App` / sep / `…EIi()` / sep / `Exit`。

---

## 1. 应用菜单树（完整重建）

### File — `lEi(e)`

| 标签 | 加速键 | 动作 |
|---|---|---|
| New Chat / New Task / New Session | `CmdOrCtrl+N` | `uEi()` → 主窗口发 `cmdK{keyPress}`；标签随 `twi()` 当前 surface 切换（`Ig.Chats/Tasks/Sessions`） |
| New Session in New Window | — | 仅 Sessions + codeSurface 开启；`dispatchNewWindow` |
| Open File… | `Ctrl+Alt+Shift+O` | `dEi()`；需 `ctrlKey&&altKey&&triggeredByAccelerator` |
| Open Folder… | `CmdOrCtrl+Shift+O` | `dispatchOpenFolder()`；门 `3046702961` + codeSurface |
| sep | | |
| Settings | `CmdOrCtrl+,` | `dispatchNavigate` |
| sep | | |
| Close Window | `CmdOrCtrl+W` | `role:"close"` |
| Reopen Closed Session | `CmdOrCtrl+Shift+T` | `dispatchReopenClosedSession`（隐藏副本 `CmdOrCtrl+Shift+W` 作为 `acceleratorWorksWhenHidden`） |
| Exit | — | `Z9r` |

### Edit — `wwi()`

Undo `CmdOrCtrl+Z` · Redo `Ctrl+Y` · sep · Cut `CmdOrCtrl+X` · Copy `CmdOrCtrl+C` · Paste `CmdOrCtrl+V` · **Paste and Match Style `CmdOrCtrl+Shift+V` + `CmdOrCtrl+Alt+Shift+V`** · Delete · Select All `CmdOrCtrl+A` · sep · Find… `CmdOrCtrl+F` · Find Next `F3` / `CmdOrCtrl+G` · Find Previous `Shift+F3` / `CmdOrCtrl+Shift+G` · sep · **Find in Files…** → `dispatchFindInFiles`

### View — `XIi(e)`

| 标签 | 加速键 | 备注 |
|---|---|---|
| Command Palette… | `CmdOrCtrl+K` | `dispatchOpenCommandPalette` |
| Sidebar（Show/Hide，checkbox） | `CmdOrCtrl+B` | `dispatchToggleSidebar(Cgt.Menu)` |
| sep | | |
| Terminal（Show/Hide） | `` Ctrl+` `` | `dispatchToggleSessionPane(Rg.Terminal)`；`registerAccelerator:false`（**不注册到菜单，由 before-input-event 处理**） |
| Changes | `CmdOrCtrl+Shift+D` | `Rg.Diff` |
| Preview 或 Browser | `CmdOrCtrl+Shift+P` / `CmdOrCtrl+Shift+B` | `Rg.Preview`，标签随 `zRn()` 切换 |
| Files | `CmdOrCtrl+Shift+F` | `Rg.Files` |
| Side Chat | `CmdOrCtrl+;` | `Rg.SideChat` |
| Close Pane | `CmdOrCtrl+\` | `dispatchCloseSessionPane` |
| sep | | |
| **Split View** ▸ | | 见下 |
| sep | | |
| Actual Size | `CmdOrCtrl+0` | `setZoomLevel(0)` |
| Zoom In | `CmdOrCtrl+Plus` | 步长 `+0.5` level |
| Zoom In (indie cooler version) | `CmdOrCtrl+=` | 同一动作的别名 |
| Zoom Out | `CmdOrCtrl+-` | |
| Zoom In (numpad) | `CmdOrCtrl+numadd` | `visible:false` + `acceleratorWorksWhenHidden` |
| Zoom Out (numpad) | `CmdOrCtrl+numsub` | 同上 |
| Actual Size (numpad) | `CmdOrCtrl+num0` | 同上 |
| sep | | |
| Full Screen（checkbox） | `F11` | `setFullScreen(!isFullScreen())` |
| Open Application Menu | `F10` | `visible:false` |
| sep | | |
| **Reload** | `F5` | `ZIi()` |

**Split View 子菜单**（`tLi`）

| 标签 | 加速键 | 命令 `zg` |
|---|---|---|
| New Session on the Right | `Ctrl+Alt+\` | `new_right` |
| New Session Below | `Ctrl+Alt+-` | `new_below` |
| Focus Next Split View | `Ctrl+]` | `focus_next` |
| Focus Previous Split View | `Ctrl+[` | `focus_previous` |
| Move Split View Left/Right/Up/Down | — | `move_*` |
| Close Split View | `Ctrl+Alt+W` | `close` |

### Go — `mEi(e)`（label = `hEi()` = "Go"）

| 标签 | 加速键 |
|---|---|
| Back | `Alt+Left` |
| Forward | `Alt+Right` |
| sep | |
| （导航历史条目，`SEi()` 动态生成） | |
| Previous Session | `Ctrl+Shift+Tab` |
| Next Session | `Ctrl+Tab` |
| Search… | `Ctrl+Shift+K` → `dispatchOpenCommandPalette` |

### Help — `GPi(e)`

| 标签 | 加速键 | 动作 |
|---|---|---|
| Claude Help | `F1` | `shell.openExternal("https://support.anthropic.com")`（1s 节流） |
| Keyboard Shortcuts | `CmdOrCtrl+/` | `dispatchOpenKeyboardShortcuts` |
| sep | | |
| **Troubleshooting** ▸ | | Show Logs in File Explorer · Show Cowork Session Data in File Explorer · Copy Installation ID · Generate Diagnostic Report · Record Net Log (30s) · … |
| sep | | |
| Get Support | — | `X5r` |
| sep | | |
| Restart / Reset App Data… | — | `Q9r()` |
| About {appName} | — | 打开 about 窗口 |

### Developer — `pii()`（`Eq()` 门控）

Load Staging Claude.ai · Open MCP Log File · Reload MCP Configuration · sep · View Process Logs · Computer Use Debug Panel · Watch-Record Trajectory Lab · Reset Chrome Browser Pairing · Refresh GrowthBook Config · TMP: Start Remote Control Session From Clipboard · Copy Remote Control Diagnostics · Reset Remote Control serving choice · sep · **Browser Use** ▸ · **Cowork VM** ▸(Start/Stop Cowork VM) · Show/Hide Debug Window · Emulate Support · Force Disable Host Loop · sep · Configure Third-Party Inference… · sep · Open App Config File · Open Developer Config File · sep · **Show Dev Tools `CommandOrControl+Alt+I`** · Show All Dev Tools · sep

---

## 2. 全局快捷键（`globalShortcut`）

标识符枚举 `xF`：

| id | 名称 | 说明 |
|---|---|---|
| 0 | `QUICK_ENTRY` | 呼出 **quick entry 浮窗**（606×470，`alwaysOnTop("pop-up-menu")`，`closable:false`）。默认值由 `rqn` 决定，用户可在设置里改（`Settings.setGlobalShortcut` → `uqn(xF.QUICK_ENTRY, accel)`），落盘并回写菜单 |
| 1 | `DICTATION` | 听写热键 |
| 2 | `HUSHED_HERON` | 内部代号功能热键 |

约束与流程：
- `tqn(accel)` 校验键位合法性，`nqn(accel)` 要求**必须带修饰键**，否则记 `invalid-accelerator` 并回滚到上一个可用值（`lqn`）。
- 注册失败返回 `registration-failed`，`N.warn("Global shortcut registration refused %o")`。
- 全屏时按 quick-entry 热键不新开浮窗，而是聚焦主窗并触发 `uEi(B)`（等同 Cmd+K）。
- **`Escape`** 仅在 computer-use 占用锁生效期间临时注册（`Szr()/Czr()`，日志前缀 `[cu-esc]`），释放即注销。
- 原生 quick entry 不支持时退回 `legacyQuickEntryEnabled` 分支。

---

## 3. 键位拦截（`before-input-event`）

**命令面板入口**（在 `CLAUDE_AI_WEB` 视图上直接拦截）：

```js
e.on("before-input-event", (ev, input) => {
  if (input.type !== "keyDown" || inHtmlFullscreen) return;
  if (!input.control || input.meta || input.alt) return;   // 仅 Ctrl（非 Cmd/Alt）
  if (input.key.toLowerCase() !== "k") return;
  if (!QXn(e)) return;                                     // 必须顶层 frame，嵌套 iframe 不触发
  ev.preventDefault();
  if (!input.isAutoRepeat) dispatcher.dispatchOpenCommandPalette(input.shift);
});
```

- `QXn()`：向上走 `focusedFrame` 的 `parent` 链，只有在**顶层 frame**（或其直属子 frame）里才放行 → 防止在 artifact iframe 内抢键。
- 另有 `artifactPopup` 视图的 `before-input-event` 做右键抑制 + 遥测（`primaryDownAt` / `activationKeyAt` / 数字键 `1-9` 记录），用于"用户是否真的在交互"判定。

**键位分发通用函数** `MQ(wc, fn, kind="cmd")`：
1. `kind:"cmd"` → 用 `ctrl` 判定，`kind:"alt"` → 用 `alt`；
2. 主窗必须聚焦、非 in-app-browser、非全屏 artifact（`ICi()`）；1 秒节流 `LCi`；
3. `zCi()`：`win.show()` → `win.focus()` → `rv.getDispatcher(wc)` → 调用 `fn(dispatcher, isCtrl)`。
4. 所有菜单项 → renderer 的桥都走这条路径，`registerAccelerator:false` 的项传 `null`（不注册，靠 §3 拦截）。

---

## 4. 主题管线

```
设置项 userThemeMode ("system"|"light"|"dark")
   │  启动时校验：P6a==="system"||"light"||"dark" 才赋给 nativeTheme
   ▼
nativeTheme.themeSource = mode            ← WindowControl.setThemeMode(mode)
   │                                         + oo.set("userThemeMode", mode) 持久化
   ├─► titleBarOverlay（仅 Windows）
   │     dark : color #141412, symbolColor #fff
   │     light: color #f9f8f4, symbolColor #000
   │     height = max(24, round(base * zoom))    base: main 44 / popout 其它
   │     去重缓存（JSON.stringify）→ 失败入黑名单（"this is probably expected"）
   ├─► backgroundColor: MF() = shouldUseDarkColors ? pqn.dark : pqn.light
   ├─► 首帧占位背景、artifact popup backgroundColor
   └─► renderer 侧：<html class="cds-root" data-mode="system"> + prefers-color-scheme + body.darkTheme
```

`captureScreenshot()` 同样依赖 `shouldUseDarkColors` 决定合成底色，宽度 > `J1i` 先 resize 再转 base64。

---

## 5. 命令面板 / Quick Entry 是两条独立入口

| | 命令面板 | Quick Entry 浮窗 |
|---|---|---|
| 触发 | `Ctrl+K`（before-input-event）或菜单 `CmdOrCtrl+K` | 全局快捷键（`QUICK_ENTRY`，可自定义） |
| 载体 | 远程页面内的 overlay（`dispatchOpenCommandPalette`） | 本地 `quick_window/quick-window.html` |
| 尺寸 | 由 claude.ai 控制 | 606 × 470，置顶，无关闭按钮 |
| 传参 | `dispatchOpenCommandPalette(shiftPressed)` | `P1n.cmdK = {keyPress}` → 主进程转发 |
| 收尾 | — | `requestDismiss` / `requestSkooch`（跨屏挪位）；`quick-entry-cleanup` 30 单位后清理 |

`P1n` 消息类型只有两个：`cmdK`、`googleAuthCode`。

---

## 6. 路由与深链

**内部 surface `El`**：`hotkey` `login` `claude.ai` `preview` `cowork` `code` `debug-handoff` `sable-otter`

**路径枚举 `Dl`**：`magic-link` `new` `sso-callback` `mcp-auth-callback` `chat` `project` `settings` `admin-settings` `customize` `directory` `create` `tasks` `task` `space` `claude-code-desktop` `code` `epitaxy` `design` `resume` `cowork` `local_sessions`
（另有 `nBe.GoogleAuth = "/google-auth"`）

**外部协议白名单 `claude://`**（`xe()` 严格校验，不符一律拒）：

| URL | 参数限制 |
|---|---|
| `claude://claude.ai/new?q=…` | 仅允许 `q`；`q` 不得以 `/` 开头 |
| `claude://cowork/new?q=…` | 同上 |
| `claude://claude.ai/chat/<uuid>` | 严格 UUIDv4 正则，路径段必须恰好 1 个 |
| `claude://claude.ai/project/<uuid>` | 同上 |

禁止：未知 host、额外 query 参数、任何 `#hash`。

---

## 7. 菜单 ↔ renderer 的通道

- `MenuEvents`（**21 方法**）是菜单动作在下游的落点：`backgroundTasksShortcut` `claimEditCommands` `closeSessionPane` `closeWindow` `cycleSession` `editCommand` `editCommandUnclaimed` `findInFiles` `newWindow` `openCommandPalette` `openFile` `openFolder` `openKeyboardShortcuts` `releaseEditCommands` `reopenClosedSession` `reportContextMenuEditor` `selectArea` `splitViewCommand` `switchSurface` `toggleSessionPane` `toggleSidebar`
- `WindowControl` 里有 6 个 **renderer→main 的状态回报**，驱动菜单勾选态：`reportSidebarMenuState` `reportSplitViewMenuState` `reportGoMenuAreas` `reportCloseMenuTarget` `reportReopenClosedSessionMenuState` `reportModalScrim`
- `reportFrameLayout{signedIn}` / `reportSidebarPlaceholder{shapes}` 驱动首帧占位骨架（见报告 A §4.5）
- `Edit` 菜单的「撤销/重做」采用 **claim/release** 模型：renderer 主动 `claimEditCommands`，失焦 `releaseEditCommands`，卸载 `editCommandUnclaimed`。

---

## 8. 关键枚举（用于仿写）

```js
Cgt = Keyboard | Menu           // 侧栏切换来源
zg  = new_right|new_below|focus_next|focus_previous|close|move_left|move_right|move_up|move_down
Rg  = terminal | diff | preview | side_chat | files
Bg  = undo | redo
Ig  = Chats | Tasks | Sessions
```

---

## 9. 仍未闭合的点

1. `Ctrl+K` 之外，远程页面内的快捷键（斜杠命令、`Shift+Enter` 换行、`@` 提及等）**全部在 claude.ai bundle 里**，asar 无法提供。
2. `dispatchOpenKeyboardShortcuts` 打开的是远程快捷键面板，其条目表不在本地包内（本地只有 §1 这份权威加速键映射）。
3. `HUSHED_HERON`（id=2）语义未定，只有配置项与注册流程，无可见 UI 文案。
