# PI-GUI UI Batch 01 验收报告

本批处理 P1-01、P1-02、P2-01、P2-02，按[设计规范](design-system.md#交互状态与焦点)和[全项目审计](PI-GUI-UI-FULL-AUDIT.md)验收。基线为 `main` 的 `b4e19ed9559ad6d7bb3ddd908fa58e8a0eece9bf`，对应 [main push CI](https://github.com/HYJ1817/pi-gui/actions/runs/43564754323) 的 8 个任务通过。本批分支为 `codex/ui-batch-01-focus`，代码提交为 `691674477979451c5b26842f43d19faea60ca401`。下面的渲染、独立复核和构建证据覆盖该代码版本。

## 缺陷与改动

| 问题 | 根因和修正 | 影响范围 |
| --- | --- | --- |
| P1-01 搜索 | 局部外壳聚焦边框和后加载的输入框 `:focus-visible` 叠加。由公共 `.ds-search-field` 外壳使用 `--ds-focus` 绘制焦点，内部输入框不再重复绘制。强制颜色模式由同一外壳绘制一道系统高亮轮廓。 | 设置搜索、MCP 管理和市场、会话搜索、Provider 服务选择器及模型面板的两处搜索。 |
| P1-02 Composer | 编辑区移除了 textarea 轮廓，外壳也没有可见焦点。真实 Chrome 复现 Classic 后，在 Runtime 独立界面也复现了同一缺陷。两个输入区共用 2px 外壳轮廓，指针进入和失焦由各自 textarea 记录。Classic 拖拽时仍由原拖放状态绘制独立的一道轮廓。 | Classic 和 Runtime 的 textarea 与外壳。附件按钮等独立目标保留各自的焦点。 |
| P2-01 Select | `:focus` 改变边框，`:focus-visible` 同时增加轮廓。合并公共基础样式并保留键盘轮廓。强制颜色模式中原生边框也被高亮，轮廓与边框重叠后呈现连续 2px 描边。 | 外观设置的主题和字体下拉框，是当前全部公共 `.ds-select` 消费者。 |
| P2-02 设置帮助 | `span[role=note]` 只有原生标题提示。替换为具可访问名称的原生按钮，复用单例 Popover。帮助内容通过独立文本节点关联，Escape 在外层界面关闭之前处理，浮层随 Modal 或工作区退出释放。 | 外观设置的主题、字体、字号三个现有入口，以及共享设置行/卡片的帮助入口。 |

修改文件共 19 个，含本报告。

- 搜索接入和局部规则清理涉及 `public/index.html`、`public/mcp-market.js`、`public/mcp-settings.js`、`public/mcp.css`、`public/session-search.js`、`public/provider-management.css`、`public/provider-management/service-chooser.js` 和 `public/provider-management/model-panes.js`。
- Composer 与 Select 样式整合涉及 `public/composer.js`、`public/runtime-conversation.js`、`public/ui3-composer.css` 和 `public/styles.css`。
- 公共样式、帮助和弹层生命周期涉及 `public/ui/primitives.css`、`public/ui/primitives.js`、`public/ui/popover.js` 和 `public/ui/modal.js`。
- 回归测试更新 `tests/primitives.cjs` 和 `tests/settings-acceptance.cjs`。设置帮助新增真实节点的语义、转义、同一浮层切换、回焦和 Modal 关闭清理断言。

## 实际渲染

Windows 上用 Chrome 157.0.8103.78、项目 `tests/visual-harness.cjs` 和 CDP 跑 1320×820、700×600 各自的深色和浅色主题，DPR 为 1。使用真实应用视图、CSS 和浏览器键鼠事件。应用界面固定中文，使用中英文搜索字词、输入内容和会话/服务标签覆盖两种文字排版。Provider 和 Runtime 使用离线夹具，文件拖放使用临时文本文件数据，发送/停止使用离线命令和事件流。

| 场景 | 操作与结果 |
| --- | --- |
| 设置、MCP、会话和 Provider 搜索 | 核对 Tab、点击、输入及清除。常规主题由外壳变更边框，输入框无第二道轮廓。会话、市场和 Provider 的原生清除按钮在补测中可点，清除后可继续输入。Chrome 的原生清除按钮没有独立 Tab 停靠点，键盘验证使用会话 Escape 或选中文字后清除。设置搜索为普通文本输入。Provider 实际渲染覆盖添加服务的搜索框，模型面板的接口行为由 Provider 定向测试补充。 |
| Classic 和 Runtime Composer | Classic 在附件按钮 Shift+Tab 返回输入框时出现 2px 外壳轮廓，Tab 回附件时保留子按钮轮廓。指针点击 textarea 后不显示外壳轮廓，输入中英文多行后高度增长。Chrome 实测拖放、移除附件、发送及等待权威停止确认的禁用状态。Runtime 四组都验证键盘/指针焦点。 |
| 外观 Select | 四组验证主题 Select 的单一键盘轮廓、字体 Select 的方向键选择及禁用行为。禁用通过夹具设置原生 disabled。Headless Chrome 在打开原生选项列表时可能保留键盘模态，单独的 OS 选项列表视觉未验证。 |
| 外观帮助 | 四组均验证点击、再次点击、Enter、Space、Escape 回焦、切换三个帮助按钮及点外部关闭。Chromium 无障碍树报告「主题提示」和完整帮助内容。Modal 附加路径由 DOM 回归覆盖。 |
| 强制颜色 | 在 700×600 Chromium 仿真中补验设置搜索和 Select。搜索外壳保留一道系统色轮廓，Select 顶边截图取样为连续两个高亮像素。 |

本地证据目录 `ui-batch-01` 包含 `baseline.json`、`acceptance.json`、`extras.json`、`targeted/spot.json` 和复核脚本 `chrome-focus-probe.cjs`。代表截图包括：

- `acceptance-settings-1320-dark.png` 和 `acceptance-market-700-light.png`，搜索键盘焦点。
- `acceptance-session-700-light.png` 和 `targeted/spot-provider-700-dark.png`，会话及 Provider 搜索键盘焦点。
- `acceptance-classic-1320-dark.png`、`acceptance-runtime-700-light.png` 和 `acceptance-classic-drop-1320-dark.png`，输入焦点及拖放。
- `acceptance-classic-stopping-700-light.png` 和 `targeted/spot-select-disabled-700-light.png`，禁用状态。
- `targeted/spot-select-700-dark.png`、`acceptance-help-1320-dark.png` 和 `acceptance-settings-forced-700-dark.png`，Select 焦点、帮助展开及强制颜色。

## 定向测试与构建

以 `node tests/<套件>.cjs` 执行以下 13 个定向套件，退出码均为 0。原语的结果按测试报告的分组计。

| 套件 | 结果 |
| --- | --- |
| `primitives`、`settings-acceptance` | 5 组、18/18 |
| `ui3-composer`、`ui3-model`、`ui3-inline-commands` | 34/34、54/54、46/46 |
| `session-search`、`runtime-conversation`、`runtime-finish-ui` | 72/72、106/106、48/48 |
| `theme`、`smoke` | 47/47、1345/1345 |
| `mcp-management-ui`、`mcp-market`、`provider-management-ui` | 31/31、72/72、77/77 |

独立复核发现并复验三处修正，包括强制颜色下的搜索焦点消失、Select 双线和帮助文本的可访问描述。测试先复现旧帮助节点为 `SPAN`，随后通过。最初的浏览器运行有夹具初始化、Enter/Space 键码及窄窗下拉方向键取值问题。补测在导航前注入 Provider 夹具，使用实际键盘激活，方向键在末项时向上取值。原始 JSON 保留首次结果。Classic 1320×820 浅色的模型弹层初次采样未打开，后续同视口重跑通过，`ui3-model` 也通过。

`npm run build:app -- --rebuild --output-root <独立目录>` 离线构建通过，复用 Electron 44.4.3 本机缓存。输出在证据目录的 `build-verified/dist-app/Pi GUI-win32-x64`，总包 333.4 MB。包内 16 个修改的前端资源与源码 SHA-256 全部一致。`Pi GUI.exe` 的 SHA-256 为 `794b28abd035acc0fe1a2fa342d3fd976c60803534a673009b58a7a8e561b010`。构建日志为 `build-verified.log`。

## 待人工验收

本批未运行完整 `npm test`，按任务范围运行定向套件。当前分支完整 CI、打包启动、安装升级、真实 Pi/模型及原生系统控件视觉仍未验证。外观的错误文案由定向 DOM 测试覆盖。离线夹具及样式变更未涉及用户项目数据。

按需回滚时，先回滚本报告的提交（用 `git log -1 --format=%H -- docs/ui/PI-GUI-UI-BATCH-01-acceptance.md` 定位），再回滚 `691674477979451c5b26842f43d19faea60ca401` 并按原构建命令重建。

本批已具备人工验收所需的代码、截图和构建证据。第二批在人工确认本批结果后开始。
