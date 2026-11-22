# Skills 第二阶段 A · PR #105 整改验收

- 分支为 `feat/skills-management-phase2a`。基线是 `e08d212e677c70732d8ccd7f5335a40a59294896`，行为提交是 `31ba8785bf1279ed5c74d3ee1f893fe769be314c`。用 `git log -1 --format=%H -- docs/ui/skills-phase2a-review105.md` 定位随图交付提交。
- 本次范围为 Skills 页、市场、撤销文件原语、对应测试与说明。推送、合并、发布为独立决策，本次只授权推送当前分支并更新 PR。

## 整改结果

| 现象 | 修复及验证 |
| --- | --- |
| 市场重复显示技能页标题 | 进入市场时摘除列表页头，展示唯一的「技能市场」一级页面标题；返回恢复「技能」及市场入口焦点。 |
| 分组标题和状态过密 | 列表和外部扫描分组标题统一用 `--text-lg`、`--leading-tight`。作用域由分组承载，每行一个可读状态。已加载、停用、未知、未加载、覆盖、项目未信任及无法加载各有明确表达。配置来源、提示词策略和完整加载诊断移到详情。 |
| 旧项目结果污染新页面 | 确认与请求绑定发起时的项目，切换查看项目或工作区会使旧操作失效，关闭旧确认和弹窗并清理提示。回归覆盖创建、保存、删除、启停、导入、扫描、扫描导入、市场安装及两种响应顺序，包含 A→B→A 后旧成功与旧错误。 |
| 安装后有用户修改，撤销仍移动目录 | 撤销安装核对安装目录身份、目录清单和文件 SHA-256。内容变更、增删、链接替换或目录搬走会拒绝。覆盖恢复前核对旧备份，重试和跨盘回退前再判断恢复位置是否空闲。所有撤销绑定原技能根并重查项目当前信任。 |
| jsDelivr 主机说明有误 | 实际主机为 `data.jsdelivr.com`。安全文档和用户说明已修正，「目录源」读取市场状态接口的实际白名单。联网仍由刷新和预览手势触发。 |

## 视觉复核

PI-Desktop 固定源码中，技能页以独立市场视图替换列表。对照本机 REF-008、REF-009 原图（1808×1205，DPR 1.5，约 1205×803 CSS px）检查了分段、搜索、分组与行尾开关，以及市场返回、分类、卡片和安装入口。REF-009 原图仍能看到列表外层标题，本次以 pi-GUI 的单页标题要求为准。列表常见状态只占一个徽标，市场宽窗保持双列、窄窗转单列。 [AgentSkillsPage.tsx](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/AgentSkillsPage.tsx#L620) · [SkillMarketPanel.tsx](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/SkillMarketPanel.tsx#L627) · [参考截图索引](pi-desktop-reference/01-screenshot-inventory.md)

Windows Chrome 157.0.8103.79 加载实际页面模块和 CSS，使用离线中文界面、混合中英文样例和 TEMP fixture。1320×820 与 700×600 CSS px、DPR 1，深浅两主题共 44 张，运行时错误 0。四组实测为页标题 20px、分组标题 16px / 20px 行高、普通行约 59.8px、扫描 / 新建 / 市场按钮均 32px。对照截图检查了组间留白、左右对齐和状态密度，窄窗表单主体可滚动，编辑、导入与扫描的底部动作仍可达。布局探针验证了窄窗列表和市场的横向溢出边界。完整截图可用 `node tests/skills-visual.cjs` 复现，代表图 11 张、762,698 字节随提交入库。

| 场景 | 代表图 |
| --- | --- |
| 普通列表 | [1320 深色](evidence/skills-phase2a-review105/1320-dark-01-list.png) · [700 浅色](evidence/skills-phase2a-review105/700-light-01-list.png) |
| 技能市场 | [1320 深色](evidence/skills-phase2a-review105/1320-dark-05-market.png) · [700 浅色](evidence/skills-phase2a-review105/700-light-04-market.png) |
| 编辑已有技能 | [1320 浅色](evidence/skills-phase2a-review105/1320-light-03b-editor-edit.png) · [700 深色](evidence/skills-phase2a-review105/700-dark-02c-editor-edit.png) |
| 导入计划 | [1320 深色](evidence/skills-phase2a-review105/1320-dark-04-import.png) · [700 浅色](evidence/skills-phase2a-review105/700-light-03-import.png) |
| 外部扫描 | [1320 浅色](evidence/skills-phase2a-review105/1320-light-08-external.png) · [700 深色](evidence/skills-phase2a-review105/700-dark-04b-external.png) |
| 联网主机 | [1320 深色目录源](evidence/skills-phase2a-review105/1320-dark-06-sources.png) |

## 测试与审查

| 证据 | 实际结果 |
| --- | --- |
| Windows / Node 24.22.1，`npm run test:skills` | 1121 通过、0 失败、5 项既有环境跳过。8 套件分别为 196、53、184、218、192、123、113、42。较基线增加 41 项，跳过数相同。 |
| 公共设计系统及设置 UI | `design-system-buttons` Phase A 6 项与 Phase B 通过，`primitives` 通过，`ui-ia` 32/32，`agent-capability-pages` 46/46，`smoke` 1346/1346。保留原断言数量，将预期更新为单徽标和切换后主动关闭确认。 |
| 安全与相邻回归 | `server-security` 44/44，`modules` 121/121，`extensions` 52/52，`extension-market` 139/139，`extension-packages` 119/119，`file-size-report` 11/11。 |
| 独立实测 | 独立只读复审 Skills UI 42/42、文件原语 184 通过、管理 192 通过。注入 `EPERM` 后，修复前恢复重试会覆盖后来写入；修复后返回 `exists`，后来文件和备份均保留。未发现新增阻断项。 |
| 源码 Electron | `node tests/shortcut-electron.cjs` 首次在设置导航的首张截图遇到 `UnknownVizError`，此时测试尚未进入技能页面。相同命令重跑 100/100，输出 35 张。首次截图错误根因未确定。测试使用原夹具的 `--no-sandbox` 启动方式。 |
| Electron / SEA 构建 | `npm run build:app -- --rebuild` 用本地 Electron ZIP 成功，整包 335.3 MB，Skills 的 8 个公开资源逐文件 SHA-256 相同，产物后端与构建后端摘要一致（`f90f3d2e4dff2afde1bcbad1a56837c80749cec95fa7061224119ccc25a1db10`）。`test:app` 重跑 27/27，`test:exe` 重跑 50/50。 |
| 完整 canonical | 基线 PR CI 在 [run 44995844848](https://github.com/HYJ1817/pi-gui/actions/runs/44995844848)（`pull_request`，attempt 1）8 项全通过，含 Core、Native、UI、Security、Faults、Electron build 和 CI gate。本次本地全量及新提交 PR CI 在记录时待验证，实时结论见 [PR #105](https://github.com/HYJ1817/pi-gui/pull/105) 的验收更新。 |

修复前回归复现了异步串页、修改后仍撤销等问题。旧确认交互的相邻测试首次仍尝试点击已主动关闭的弹窗，更新断言后为 46/46。打包初测缺少标准 TEMP PDF 夹具，`test:app` 20/22、`test:exe` 44/45。补跑 CI 同款 `npm run fixtures` 后，PDF、DOCX、PNG 相关验证实际执行并通过。

## 边界与回滚

- 首个项目级资源会把默认 `ask` 项目从「尚无资源」转为待信任，之后撤销也要求当前项目信任。真实双盘、操作系统级检查与提交间竞态、真实 pi 与安装升级未实测。现有跨盘恢复复制中途失败可能留下部分目标，回收站备份保留。
- 需回滚时，先 revert 本证据提交，再 revert 行为提交 `31ba8785bf1279ed5c74d3ee1f893fe769be314c` 并重建使用中的产物。撤销令牌随进程重启失效，受影响文件和备份按各自的磁盘状态处理。
- 整改已实现，代码验收需结合当前提交的完整验证与高风险边界的用户决策。PR 合并和发布均留待单独授权。
