# 源码审计笔记与待实测项

日期：2026-10-31。基线：`9694339`，`codex/fix-bugs-8-11`。

本笔记区分「源码确认的现有形态」「已查看的fixture截图」「需要实际操作验证的行为」。D01–D20均属既有设计形态或审查检查项，**不是本次引入的代码缺陷，也不将猜测当成已复现Bug**。未修改生产代码，未运行真实Pi或写入用户真实项目。实际窗口采集由主任务使用生产Electron入口、现有visual-harness及TEMP fixtures完成，见[采集记录](../evidence/current/capture-results.json)。

源路径中，除显式标明的 `server/`、`docs/` 外，前端文件均相对 `public/`；代码位置绑定上述基线。

## 可复用抽象与状态归属

| 现有抽象 | 源位置 | 重构时保留的职责 |
| --- | --- | --- |
| 双主题语义Token | `public/tokens.css:1-180` | 语义色、字体、间距、圆角、动效与兼容别名已有，不应再造第三套主题事实源 |
| 普通Modal、独立Confirm、命令面板 | `ui/modal.js:26-62,91,142,246`；`index.html:226-243` | focus trap、返回焦点、异步确认失败保持；独立层避免下层面板被清空 |
| Composer Popover | `ui/popover.js:20-113` | 锚点、视口定位、关闭、焦点恢复 |
| 行动作菜单 | `ui/action-menu.js:61,131,157,248` | 单例、portal、flip/clamp、键盘漫游、禁用理由、scroll/resize关闭 |
| 一级工作区 | `ui/workspace-surface.js:38-91` | Chat DOM只隐藏、滚动恢复、实例token、disposer和焦点迁移 |
| 右栏几何与遮挡 | `right-pane.js:110-381` | viewport唯一owner、宽度、dock/overlay、native Browser bounds/遮挡 |
| Secondary Surface | `ui/secondary-surface.js:112-165` | 唯一外层面板、disposer集合、关闭与焦点恢复、白名单恢复 |
| Split Workbench | `ui/split-workbench.js`；`docs/work-surfaces.md`当前段 | 只管布局，复用业务mount和controller；不复制Git/Specs事实源 |
| Classic草稿 | `draft.js:37-42,67,86-132,157-245` | workspace/session哈希键、20,000字上限、400ms debounce、storage降级 |
| Runtime草稿 | `runtime-draft.js:38,80,104,122-214`；`runtime-store.js:2-81` | 稳定locator与owner分开，身份不符不能继承草稿 |
| 会话稳定排序 | `server/sessions.js:83-104,370`；`runtime-nav.js:8,94-95` | 点击/后台事件不改变createdAt排序，mtime只供展示/搜索 |
| Thinking能力 | `thinking-availability.js`；`ui3-model-picker.js:104` | 三值与Pi回读，未知不能改成不支持 |
| 工具渲染 | `tool-view.js:76,159,336,374`；`tool-history.js:43` | 实时/历史ToolEntry共用，未知/未完成/孤儿结果继续降级 |
| Toast纪律 | `ui/toast.js:7-9,84-105` | 30s去重、replay不通知、普通无动作成功静默、跨会话旧动作失效 |

方向建议：保留业务owner、状态和生命周期模块，统一展示组件及视觉参数。不要用全局CSS覆盖或store重写来解决视觉割裂。完整入口与边界见[功能映射](05-feature-map.md)。

## D01–D20：现状、影响、建议、优先级与验证

优先级P1代表影响高频路径或状态理解，应进入第一轮设计/实施；P2代表一致性与可维护性收口。此优先级不是REVIEW.md的Blocker/Important Bug评级。

| 编号 / 优先级 | 现状与源码证据 | 用户体验影响 | 改进建议 | 证据状态 / 复查方法 |
| --- | --- | --- | --- | --- |
| D01 / P1 | Classic底部chip composer；Runtime顶部select+按钮组、输出pre。`index.html:166-200`；`runtime-conversation.js:243-274,364-385` | 类似会话任务使用两套布局与控件，切换后重新定位操作 | 统一区域、行高、状态词、菜单，但保留能力差异 | 源码确认；Classic截图已查看，Runtime需实测对照 |
| D02 / P1 | Runtime同时加入发送、停止、重启、关闭、恢复、历史、返回实时、Browser、进程、More。`:364-385` | 低频生命周期动作与发送/停止竞争；小窗口头部高度可能上升 | 状态+主要动作直接可达，其余入More；只显示当前有意义的动作 | 源码确认，1280与长模型名换行/占高待测 |
| D03 / P1 | Runtime运行中send禁用`:702`；Classic支持steer，停止未确认禁用 | 外观一体化如果不解释差异，会误导当前可用动作 | 运行中明确“追加指令”或“运行中暂不可发”；停止确认状态独立 | 源码确认；运行/停止中/停止失败/idle逐项操作待测 |
| D04 / P1 | Runtime未接Classic handleFiles；Classic有loading/error/blocked/truncated等附件状态。`attachments.js:43,109`；`runtime-conversation.js` | 原型若给Runtime可用附件按钮会夸大能力，后续实施易漏接权限/解析 | 根据真实能力呈现附件，明确Classic演示或未来待实现目标 | 源码确认；功能映射/原型控件检查 |
| D05 / P1 | 会话More为中心Modal列表`app.js:906-950`，行三点用anchor action-menu | 同类“更多”打开方式不一致，普通动作远离触发点且遮挡聊天 | 普通动作复用action-menu；真正表单/危险确认才用Dialog | 源码确认；More的Escape、外点、面板并存待测 |
| D06 / P1 | 顶栏分支、Changes、Specs、协同、Browser、More均图标。`index.html:93-116` | 首用发现成本、长标题和关联任务占宽；现有截图中任务关联胶囊占显著横向空间 | 常用面板用清楚标签，低频集中工作工具；关联任务压成摘要可展开 | [聊天截图](../evidence/current/dark-1440-chat.png)与[Changes截图](../evidence/current/dark-1440-navChanges.png)可见；窄窗遮挡/点击仍待测 |
| D07 / P1 | 设置7组入口：供应商/认证/更新/外观为Modal，能力/MCP转中央Surface。`index.html:63-88`；`app.js:1078-1085` | 设置内目的地形式不一致、返回路径难预测 | 有目录的统一Settings Surface，业务mount与owner保持 | 源码确认；从Chat/Planner进入返回的焦点/滚动待测 |
| D08 / P2 | 上下文百分比侧栏details与Composer ring重复。`index.html:59,179-184`，More另有统计 | 重复常驻同一信息，视觉注意力被分散 | Composer保留当前上下文摘要，详情集中复用；侧栏可转运行摘要 | [当前聊天](../evidence/current/dark-1440-chat.png)已见两处6%；高占用/未知状态待测 |
| D09 / P1 | 15个CSS文件，读取到16种硬编码font-size、13种硬编码border-radius；已有Token但仍局部定义大量尺寸 | 跨面板文字/圆角难统一，维护时继续累积相近值 | 明确caption/label/body/prose/title和component-size tokens，按组件迁移拥有规则 | 源码静态计数；数量不是Bug证据，最终视觉层次需截图对比 |
| D10 / P2 | Specs存在9/9.5/10.5px，`specs.css:43,127,152,184`；tool status10px，`styles.css:520` | 低字号辅助信息在高密度/缩放下可读性风险 | 建立统一辅助字号与对比度等级，先以11–12 CSS px评审，不以透明度替代层次 | 源码确认；125%/150%实际字体与1280×800待测 |
| D11 / P2 | icon-btn26px、项目三点22px、折叠16px。`styles.css:121-123,183-198` | 鼠标命中与键盘焦点目标不一致 | 16px视觉图标，28/32px交互框；树chevron保持紧凑但扩大hit area | 源码确认；相邻点击/焦点环交叠待测 |
| D12 / P2 | 大量原生title与提问导航自定义tooltip共存。`projects.js:209,242`；`conversation-nav.js:105`；`attachments.js:160-177` | 显示延迟、位置、键盘可见性不一致 | 统一Tooltip契约，路径保留可访问描述；避免重复两层提示 | 源码确认；边缘、DPI、hover与keyboard focus待测 |
| D13 / P1 | styles.css原composer-box16px完整面板，UI3后置改textarea描边、面板无边框。`styles.css:602-605`；`ui3-composer.css:2-25` | 组件最终规则分散，局部改动容易影响发送按钮/底栏锚点 | 单一Composer anatomy、尺寸与状态规范，实施时合并组件拥有规则 | 源码确认，当前外观可见；附件、多行、长模型、Stop布局待测 |
| D14 / P2 | 工具组外框、行分隔、详情pre边框。`styles.css:495,538-544` | 复杂调用边框密度和元数据重复会抬高阅读成本 | 默认连续rail；展开详情/错误用轻背景；状态、证据与工具内容不丢 | [Changes截图](../evidence/current/dark-1440-navChanges.png)可见5项工具外框和行分隔；20+调用/多详情待测 |
| D15 / P1 | Runtime历史正文+受限工具摘要，无Thinking/usage，未确认位置另区。`runtime-conversation.js:124-163,584-644` | 缺数据若画成空/成功会给出错误确定性 | 明确只读标签、预算截断、来源证据、位置未确认；不补造完整timeline | 源码确认；正文/摘要截断、位置未知、不可用历史待测 |
| D16 / P1 | 右栏默认420、最小320；Classic chat floor420，Runtime floor320。`right-pane.js:30-43` | 不同控制密度决定dock/overlay，统一视觉不能盲目采用一个窗口断点 | 用可用内容宽度判定；统一pane token与正文下限，保留不同owner | 采集记录中1440×900右栏420px已确认；拖动/缩放/遮挡待测 |
| D17 / P1 | 项目刷新重建列表`projects.js:167-169`；session列表重建但搜索输入保留`sessions.js:392-424`；稳定排序已有 | DOM重建时焦点/viewport anchor可能需要维护，不能据此断言跳位已发生 | 保留稳定createdAt与identity；只有复现后才修焦点/列表锚点 | 源码确认；第8行点击、后台事件、归档/改名/搜索返回待测 |
| D18 / P2 | 错误Toast默认持久，但replay压制、普通成功静默、30秒去重已实现。`ui/toast.js:7,84-105` | 不可把“通知多”当未经复现的既有Bug；持久错误累积需专项看 | 继续去重与上下文失效；错误优先就地，可执行持续问题才横幅 | 源码确认；重复错误、SSE重连、跨会话旧动作待测 |
| D19 / P1 | Browser仅desktop bridge，`browser-pane.js:24-25`，命令when无bridge不显示`app.js:1275` | 参考其他桌面产品不等于Web版可增加假Browser操作 | 平台能力控制入口；原型清楚标注本地演示，不当成真实网页控制 | 源码确认；Electron与Web分别验证 |
| D20 / P2 | 部分app-shell历史段说无Worktree入口，当前`projects.js:260`已有；work-surfaces标明历史段 | 依旧文档做设计会漏功能或错写能力缺失 | 当前HEAD代码为准，历史记录只作背景；交付逐项核对映射 | 已核对源码与文档；完整入口审查见F01–F60 |

## 静态计数方法与结果

只读读取 `public/*.css`（15个文件），以正则提取字面量 `font-size: Npx` 与 `border-radius: Npx`，排除Token引用但包含兼容/历史规则。因此这是归一化机会的线索，不是当前计算样式计数或可访问性失败数量。

- 字号16种：9、9.5、10、10.5、11、11.5、12、12.5、13、13.5、14、15、17、18、20、21px。
- 圆角13种：1、2、3、4、5、6、7、8、9、10、12、14、16px。

## 已查看窗口证据

生产Electron入口与生产public渲染器，既有visual-harness提供TEMP fixture数据。以下三张图已直接视觉查看，绝非仅DOM断言：

1. [聊天](../evidence/current/dark-1440-chat.png)：52px rail、236px侧栏；正文为开放阅读列；上下文摘要重复；顶栏关联任务胶囊与工作图标并列；Classic composer为textarea描边+下置控件。
2. [文件变更](../evidence/current/dark-1440-navChanges.png)：420px右栏；Git全部/本会话过滤；打开/撤销/删除分离；连续工具5项展示；主阅读区随右栏收窄。
3. [Skills](../evidence/current/dark-1440-navExtensions.png)：五过滤器+搜索/作用域/状态；未信任项目提示；列表/详情分区；未知与未加载有文字说明。此截图未展开Skill详情，不能证明详情交互与启停流程已验收。

采集记录显示这些1440×900图的DPR为1.5，图片像素2160×1350。记录另包含1280×800、1920×1080浅/深总览及更多弹窗图；本笔记未逐张审阅其所有细节，不代替主任务最终视觉验收。

## 不能重复当成“当前确认缺陷”的结论

- 点击会话自动置顶：源码按createdAt稳定排序，相关离线测试文件已有，尚无本轮复现证据。
- 切页面必丢Classic草稿/滚动：已有保留DOM和滚动恢复，需操作验证，不能凭旧印象报告。
- 菜单必然被sidebar裁掉：action-menu已portal、flip/clamp，需真实边缘场景验证。
- 通知必然频繁重复：已有replay压制、成功静默、去重，需复现再定性。
- Thinking流式结束必强制收起：当前设计/渲染保留用户展开选择，需验证，不应反复报旧问题。
- 所有历史都没有工具：Runtime已支持受限只读工具摘要；文件开头部分旧注释不能盖过实际代码。
- 缺少Worktree、可视化或协同功能：当前HEAD均存在，不能因任务清单未提全而删除。

## 实施依赖和边界

1. Token与组件规范先行；统一Classic/Runtime外观，但动作由各自owner注入。
2. Shell/Settings/菜单后续迁移，保留workspace/secondary生命周期、disposer与DOM。
3. Conversation/Tool/Composer复用现有消息/ToolEntry、Pi回读、IME、stop barrier与draft locator。
4. Diff/评论/候选采纳/撤销/认证/更新属于高风险边界，视觉改造不授权简化确认、快照、nonce或写权限。
5. Browser native viewport、DIP/zoom与遮挡必须做Electron专项；浏览器原型和DPR截图不能替代原生多档Windows缩放资格。
6. Capability不是Marketplace，不能凭参考项目添加空市场、陌生包安装、评分或假开关。
7. 本阶段完整canonical产品测试、真实模型、真实IME与安装更新资格均未由此笔记运行或宣称通过；没有生产代码变更，不需要重建生产产物。
