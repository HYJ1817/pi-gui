# 右侧 Surface 最终整改：参考调用链与适配

日期：2026-11-25。只读源码研究是设计依据，不是外部产品运行或本产品验收证明。

## 精确来源

- T3 Code：`pingdotgg/t3code`，SHA `c925b9ab198099f67de862ed01701bd1d8809f2b`；提交时间 `2026-11-25T05:27:52Z`。
- archive：144,116,680 bytes；SHA-256 `3bce3fcee99097811c6140b69258b75b7f57ad37db59d96288d476ca0a7dc43d`。
- 只读解包目录：`%TEMP%/t3code-ref-source-PnGAbd`；研究报告：`%TEMP%/t3-surface-research-report-jc6gNE/RESEARCH.md`。未从下载目录运行解释器、安装、构建或参考应用。
- Pi-GUI比较基线：`78ca4dcb9dd3e4293e9dcb0f7507a0a6d51d7d5d`，分支 `feat/unified-file-viewer`，既有PR #112。基线完整CI run `45551821141` 成功，只证明该SHA。
- 更早的文件查看器研究见[历史参考](unified-file-viewer-reference.md)，它的T3 SHA `6c0621f7…` 不作为本次最新Surface实现的来源。

下表源码链接统一固定到上述T3 SHA，不引用浮动main。

## 完整交互链，不是按组件名猜测

| 链路 | 精确源码 | 核实机制 | Pi-GUI适配 |
| --- | --- | --- | --- |
| 外壳→业务装配 | [ChatView 4227–4290](https://github.com/pingdotgg/t3code/blob/c925b9ab198099f67de862ed01701bd1d8809f2b/apps/web/src/components/ChatView.tsx#L4227-L4290)、[RightPanelSurfaceContent](https://github.com/pingdotgg/t3code/blob/c925b9ab198099f67de862ed01701bd1d8809f2b/apps/web/src/components/chat/RightPanelSurfaceContent.tsx#L1-L310) | scoped store、注入业务动作、按kind lazy装配 | 原生DOM registry与既有owner，不引入React/Zustand |
| Launcher→动作 | [RightPanelTabs 337–595](https://github.com/pingdotgg/t3code/blob/c925b9ab198099f67de862ed01701bd1d8809f2b/apps/web/src/components/RightPanelTabs.tsx#L337-L595)、[useRightPanelActions 116–178](https://github.com/pingdotgg/t3code/blob/c925b9ab198099f67de862ed01701bd1d8809f2b/apps/web/src/components/chat/useRightPanelActions.ts#L116-L178) | 居中单列、图标名称键提示、可用性与业务动作同源 | 本地真实工具；无永久按钮/隐藏source-button/卡片更多区 |
| 新建 | [RightPanelTabs 1125–1285](https://github.com/pingdotgg/t3code/blob/c925b9ab198099f67de862ed01701bd1d8809f2b/apps/web/src/components/RightPanelTabs.tsx#L1125-L1285) | T3的+打开类型菜单，并非新文件 | 用户明确要求独立空Launcher，所以+先建空tab，再转换或复用已有单例 |
| tabs→store | [rightPanelStore 1158–1233](https://github.com/pingdotgg/t3code/blob/c925b9ab198099f67de862ed01701bd1d8809f2b/apps/web/src/rightPanelStore.ts#L1158-L1233)、[RightPanelTabs 1287–1398](https://github.com/pingdotgg/t3code/blob/c925b9ab198099f67de862ed01701bd1d8809f2b/apps/web/src/components/RightPanelTabs.tsx#L1287-L1398) | 身份、顺序、关闭当前/其它/右侧/全部、中键、重排 | 有界工具描述符；保留并增强既有ARIA/roving keyboard，不照搬弱化语义 |
| 隐藏/关闭→resource owner | [useRightPanelSurfaceClose 53–179](https://github.com/pingdotgg/t3code/blob/c925b9ab198099f67de862ed01701bd1d8809f2b/apps/web/src/hooks/useRightPanelSurfaceClose.ts#L53-L179) | hide、tab close、业务资源结束不同，Terminal/Browser各自命令 | Browser隐藏detach同实例，关闭释放；Terminal外层关闭仅释放前端，沿用Pi后端PTY合同 |
| 恢复→重新业务打开 | [reopenClosedView](https://github.com/pingdotgg/t3code/blob/c925b9ab198099f67de862ed01701bd1d8809f2b/apps/web/src/reopenClosedView.ts#L25-L174) | scope/环境/权限筛选后重新打开，不复活旧对象 | 本任务做会话描述符恢复，不新增关闭历史功能；不持久化grant、File、Blob URL、native/PTY id |
| 最大化→聊天隔离 | [ChatView 3537–3563](https://github.com/pingdotgg/t3code/blob/c925b9ab198099f67de862ed01701bd1d8809f2b/apps/web/src/components/ChatView.tsx#L3537-L3563)、[PreviewPanelShell](https://github.com/pingdotgg/t3code/blob/c925b9ab198099f67de862ed01701bd1d8809f2b/apps/web/src/components/preview/PreviewPanelShell.tsx#L56-L214) | 局部workspace最大化、聊天DOM保留且inert、正常宽度独立 | 交给既有right-pane，保留项目侧栏，不做Files私有fullscreen/OS窗口最大化 |
| Files→文件→格式 | [FilePreviewPanel 1707–1939](https://github.com/pingdotgg/t3code/blob/c925b9ab198099f67de862ed01701bd1d8809f2b/apps/web/src/components/files/FilePreviewPanel.tsx#L1707-L1939)、[FileExplorerPane](https://github.com/pingdotgg/t3code/blob/c925b9ab198099f67de862ed01701bd1d8809f2b/apps/web/src/components/files/FileExplorerPane.tsx#L1-L116) | 树在预览右侧、左边缘resizer、按格式上下文工具 | 保留Pi Files内层文件tabs/身份/阅读状态，树改右侧，低频动作入共享菜单 |

## 必须保留的差异

1. T3文件是peer Surface，Pi已有Files文件tab owner；本任务明确保留两层，不建立两份active-file/顺序/关闭状态。
2. T3多Browser/Terminal资源不等于Pi所有工具任意多实例；Changes/Specs/Files等复用现有单例。split借同一host，不二次mount。
3. 字母type-ahead只在Launcher焦点内使用；不会偷取聊天、浏览器地址、搜索或xterm输入。快捷键标签来自Pi真实配置，不伪造上游键位。
4. T3 host absolute-path读取、可写文件、HTML可脚本、SSH/远端以及关闭PTY策略不迁移；仍由Pi workspace/conversation/generation/fileId/grant控制。
5. 不把外部源码常量当本地布局实测，不以README或扩展名候选表宣称格式/codec已通过。

## 来源与品牌

T3根[LICENSE](https://github.com/pingdotgg/t3code/blob/c925b9ab198099f67de862ed01701bd1d8809f2b/LICENSE)为MIT，版权T3 Tools Inc.；[TRADEMARK](https://github.com/pingdotgg/t3code/blob/c925b9ab198099f67de862ed01701bd1d8809f2b/TRADEMARK.md)另限制品牌、logo、图标与trade dress。本任务没有向产品复制上游代码、媒体或品牌资产；使用Pi既有Token/图标/菜单/owner。参考来源说明不是对任何第三方依赖的总括许可意见，PPTX和实际vendor由单独证据核验。
