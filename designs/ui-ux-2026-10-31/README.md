> 2026-11-01：用户已授权生产界面实施。当前成果见 [生产截图图库](production-review.html)、[实施计划](reports/16-production-implementation.md)、[生产验收记录](reports/17-production-acceptance.md) 和 [60 项功能入口映射](reports/18-production-feature-map.csv)。双击 `打开生产截图.cmd` 可离线查看，不依赖 8120 服务；实际应用构建路径见 [本地构建](evidence/production-build-final-path.txt)。下文保留此前设计阶段记录。

# pi-GUI UI/UX 设计阶段交付

> 2026-11-06 第二轮清理：保留四个验收 HTML 入口、三套可操作导出、设计系统与画布源文件、图库所需图片及所有 JSON。移除 343 个未被保留图库引用的重复截图/完整日志（39,847,903 字节），原件固定归档在 [2e70463](https://github.com/HYJ1817/pi-gui/tree/2e70463183218ddf3a10972789667d6be5c294df/designs/ui-ux-2026-10-31/evidence)。报告中的相关链接已改为历史地址；结果清单中的归档图片不再保证存在于当前树。旧原型整体仍保留，尚未取得整体删除许可。后续输出与统计见 [清理报告](../../docs/repository-cleanup-report.md)。

> 仓库交付范围：设计源文件、导出原型、组件规范、离线 fixture 截图与验证记录进入本分支。`evidence/reference-user/` 中的用户实机参考图片、预览进程状态、第三方工具 ZIP 缓存及包含本地资料的完整交付 ZIP 仅留本机，不随 Git 推送。历史报告引用这些本机参考资料时，在其他 checkout 中不可直接打开；设计结论和生产截图图库可正常查看。

**历史设计阶段状态（后续已获生产实施授权）：2026-11-01 统一修订版已提供，等待人工验收。** 当时根据21张用户实机参考图新增 Refined 画板，更新中性灰 Tokens、单侧栏、设置与资源页；A/B保留作首轮对照。该阶段生产功能代码、接口、数据模型和依赖未改，没有提交、推送、合并或发版。

**最新批注修订：**任务与审阅、Skills与扩展已移入设置；输入区装饰下箭头已移除，交互保留；变更/Browser入口移入右侧工作面板。当前435/435、90张截图，详见 [三条浏览器批注与验证](reports/13-browser-comment-revision.md)。下文381项/84图是上一轮记录，旧证据保留。

## 本次修订优先入口

- **最新输入辅助：**已加入 `/` 菜单与上下文详情；新交互200/200、28图，既有回归435/435、90图。见 [15修订与验收](reports/15-input-assistance-validation.md)。仅演示原型，@引用未加入。

- [第三批三张参考图：/命令、上下文详情与@目录候选](reports/14-input-assistance-reference.md)（累计24张；本次仅核对，输入辅助原型尚未补齐）

- [新版验收页：截图对照与图库](http://127.0.0.1:8120/review-refined.html) · [新版可操作原型](http://127.0.0.1:8120/exports/refined/Refined.dc.html)
- [修订与验收记录](reports/11-refinement-validation.md) · [独立审查及处置](reports/12-refinement-review.md) · [离线ZIP](exports/refined.zip)
- 双击 `打开设计预览.cmd`，或 `node designs/ui-ux-2026-10-31/tools/start-preview.cjs --open`。当前机器签名策略会拒绝旧 `.ps1` 启动方式，新入口直接使用Node，系统策略不变。

修订版实测381/381、84张图；组件预览388/388、40张图；v2对比度78/78重新计算。各数字覆盖不同范围，不相加；真实截图、逐图尺寸、导出摘要与未验证项见11报告。旧A/B数字仅为首轮证据。

## 先看这里

- [第二批 9 张用户实机截图对照：聊天、模型菜单、工作面板与浅色主题](reports/09-user-reference-chat-comparison.md)（2026-11-01；累计 21 张，仅研究补充，原型尚未修订）

- [本地总验收入口、原改对照和截图图库](http://127.0.0.1:8120/index.html)
- [首轮 A · 工作台交互原型（保留对照）](http://127.0.0.1:8120/exports/workbench/Main.dc.html)
- [B · 阅读空间交互原型](http://127.0.0.1:8120/exports/reading/Reading.dc.html)

本地服务关闭后，从仓库运行：

也可以直接双击本目录的 `打开设计预览.cmd`：它会启动独立隐藏后台进程，确认页面就绪后再打开浏览器。没有安装Windows服务、计划任务或开机启动项。

```powershell
node designs/ui-ux-2026-10-31/tools/serve.cjs 8120
```

或运行 `./designs/ui-ux-2026-10-31/start-design.ps1`。加 `-Editors` 可从随包离线工具开启可编辑画布与设计系统；加 `-Port 8121` 使用其它空闲端口。不会下载安装依赖、修改全局技能目录或操作Pi。脚本打印当次编辑器地址，总验收页也会读取最新地址。

## 七项成果

| 成果 | 文件 / 入口 |
| --- | --- |
| 1 UI/UX审计 | [01-ui-ux-audit.md](reports/01-ui-ux-audit.md)，20项问题与改进；[源码证据笔记](reports/source-audit-notes.md) |
| 2 PI-Desktop视觉与交互研究 | [02-reference-research.md](reports/02-reference-research.md)，固定提交、12张官方运行截图、源码参数和不继承的业务 |
| 3 可编辑Design System | [品牌/使用规范](system/project/README.md)、[tokens.json](system/project/tokens.json)、[19组件覆盖](system/project/Component-Coverage.md)、各组件README与preview.html |
| 4 双方向高保真原型 | [画布索引](canvas/project/canvas.json)、[A源](canvas/project/Main.dc.html)、[B源](canvas/project/Reading.dc.html)、[A离线网页ZIP](exports/workbench.zip)、[B离线网页ZIP](exports/reading.zip) |
| 5 原版与改版截图对照 | [总验收页面](index.html)、[04视觉验收与截图索引](reports/04-visual-validation.md)、`evidence/current/`、`evidence/prototype/` |
| 6 原有功能与新入口映射 | [05-feature-map.md](reports/05-feature-map.md)，F01–F60；区分核心示例、仅入口映射与真实业务 |
| 7 后续重构计划 | [06-implementation-plan.md](reports/06-implementation-plan.md)，阶段依赖、既有owner、风险、回滚和验收；没有执行 |

另附 [独立审查及作者整改](reports/07-independent-review.md)、[原始源Token清单](system/project/Original-Inventory.md)、[对比度记录](system/project/Contrast-Checks.md)、[设计系统截图图库](system/project/verification/index.html)、[离线设计工具来源与许可](tooling/README.md)。

## 首轮实际验证（历史记录）

| 对象 | 数字与范围 |
| --- | --- |
| 原版UI | 生产Electron main/preload/public + 现有离线fixture，两轮共29张唯一截图；renderer错误0；真实用户数据不参与写操作 |
| 设计系统 | 91个非排字Tokens、10个文字样式、19组件、双主题；格式0 problems；真实Chromium检查388/388；40张图；指定对比度配对78/78 |
| 核心原型 | 2个交互画板，格式0 problems；完整检查280/280；102张矩阵/交互图 |
| 细节补测 | 24/24：125/150%缩放模型菜单确实打开、视口边界、Escape焦点，Thinking展开、面板键盘调整和设置分类；另12张新图，4张缩放图替换 |
| 异步资格 | 9/9；包含重试→停止、跨会话回调、停止状态恢复与侧栏状态；修复前8/9可复现 |

不同检查的单位与覆盖重合，不相加成一个“总通过数”。失败与驱动修复历史保留在证据目录。原型采用真实Chromium离屏渲染，解决隐藏窗口旧合成帧；Windows取整使实际高度较请求尺寸多1 CSS px。生产原版OS DPR1.5与原型离屏DPR/页面zoom分别记录，详见04报告。原型、设计系统格式检查通过不等于生产canonical或完整视觉验收。

开始时两指定技能未安装；本轮按上游支持方式临时读取并实际使用 `claude-design-system` 与 `claude-design`。它们的预构建编辑器以固定版本离线ZIP保存在tooling（4.82MB），无npm安装。导出页随附的本地React vendor仅用于设计查看器，不是生产迁移到React或新增产品依赖的决定。

## 原型操作路线

1. 打开A或B；点击新对话体验空态，再切侧栏四条演示会话，分别看到正常、运行、长历史、错误。
2. 在不同会话中输入草稿再切换；滚动长会话，切任务/设置后返回。选中不重排，停止后的状态跟随会话。
3. 模型入口可搜索、方向键选择和Enter确认；Escape关闭。运行中的Classic可以补充指令，方块键停止；Runtime演示不声称支持附件或steer。
4. 展开Changes/Browser，关闭或用面板分隔条方向键调整宽度。Diff与浏览器内容为演示，不能证明真实原生Browser或文件操作。
5. 会话右键/三点打开菜单，重命名Dialog可编辑、Tab循环、Escape返回原触发器。设置左侧可切模型、更新、诊断和日志示意。
6. 底栏切换深浅主题，系统减少动态偏好生效。底栏持续标明演示数据。

## 边界与尚未获得的资格

- 全部原型内容为演示，不连接用户真实项目、账户或模型；Diff不是当前Git改动，工具结果不是实际执行。
- 60项映射覆盖既有能力，不代表60项业务都在原型中重写。Specs、协同、进程、候选执行、认证/更新/撤销等保留现有业务合同与后续实施入口，不用假动作冒充实际功能。
- 真实模型E2E、实体中文IME、读屏器、所有物理DPI、原生Browser遮挡/分屏与安装升级等未验证。产品Runtime现场运行截图未取得，其能力差异由源码审计确认。
- PI-Desktop当前研究源码0.21.0与官方截图0.14.6不同；没有现场启动其应用或安装其依赖。
- 独立审查首轮4项Important，一次增量7/8；最后的同会话异步时序随后由作者修复、9/9复验。没有把作者复验称为独立复审全通过；人工验收请看07附录。
- 未运行生产完整 `npm test` 或重建安装包：本轮仅增加独立设计成果，生产和测试入口均未改。基线CI记录与限制见01报告。

## 如何继续编辑

修改可编辑画布的 `.dc.html`、或设计系统 `tokens.json` 与组件规范；通过相应编辑器保存。Tokens与画布的系统快照不同步自动更新，修改后重新安装快照，再从画布Export→HTML导出两个方向。不要手改生成 `tokens.css` 当作新的事实源。`exports/export-manifest.json` 记录源文件与ZIP摘要。

本阶段到此停止。下一步为人工确认方向、关键页面、能力映射及剩余资格，再决定是否另行授权实施。
