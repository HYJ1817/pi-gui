# 代码规范

本文维护代码风格与模块组织约定，适用于新增代码和本次触及的局部修改；历史代码不要求立即追齐。
开发硬约束、安全与操作授权以 [AGENTS.md](../AGENTS.md) 为准，审查等级与门槛以
[REVIEW.md](../REVIEW.md) 为准。模块地图见 [architecture.md](architecture.md)，
测试执行政策见 [testing.md](testing.md#测试执行政策)，交付证据组织见 [acceptance.md](acceptance.md)。
本文不改变产品行为、测试入口或发布流程。

## JavaScript 与文件格式

- 使用当前技术栈：原生 JavaScript、Node.js、原生前端 ES Modules；Electron main、preload、测试等必要位置沿用 CommonJS `.cjs`，脚本沿用 `.mjs`。不全仓迁移 TypeScript。
- 新文件优先 UTF-8、LF、末尾换行；普通新增代码默认推荐 2 空格缩进。修改已有文件时优先遵循周边格式，避免整文件换行或编码噪音。
- 沿用所在模块的引号、分号、空格和命名方式；名称表达业务对象、动作和单位，不以缩写隐藏职责。注释解释约束、协议出处和取舍，保留有用的历史理由。
- 原生 ESM 使用明确的相对路径与文件扩展名，Node 内置模块优先 `node:` 前缀；不为风格改写既有加载边界。
- 不借制定规范全仓格式化，不新增 ESLint、Prettier 或其他依赖；新增依赖的决策仍走 AGENTS。

## 模块、状态与依赖

- `server.js`、`public/app.js`、`electron/main.cjs` 以组合、初始化、事件路由、依赖注入和生命周期收尾为主。新业务逻辑放入对应职责模块；不继续把业务塞进入口文件。
- 先沿调用链查找现有实现，再决定是否新增模块。每个模块应能说明输入、输出、副作用、状态 owner 和释放责任；不创建缺少明确职责的通用 utils 集合。
- 同一业务事实只有一个权威所有者。其他模块读取或投影它，不另存可独立修改的同名状态。派生缓存须有身份、失效规则和容量边界，不能成为第二份事实源。
- 经典运行态沿用 [server/runtime.js](../server/runtime.js)；并行会话身份、epoch 和资源归属沿用 [server/runtime-registry.js](../server/runtime-registry.js)。不建立第二套 Runtime Registry，不把经典 cwd 当作并行会话的完整身份。
- 依赖方向清晰，避免循环依赖；跨业务协调优先显式注入回调或工厂参数，不滥用全局单例。后端业务模块的 import 边界及既有叶子原语例外见 [架构模块地图](architecture.md#七模块地图)，不以注入之名复制状态。
- 复用已有安全路径、Git、进程和 HTTP 工具，保留调用方安全前提：

| 职责 | 优先查阅的现有实现 |
| --- | --- |
| 项目路径边界 | [lib/safe-path.js](../lib/safe-path.js) |
| 有界 Git 与 Worktree 查询 | [lib/git.js](../lib/git.js)、[lib/git-worktree.js](../lib/git-worktree.js) |
| Agent/CLI 执行、超时与进程树收尾 | [server/agents/cli.js](../server/agents/cli.js) 及对应 adapter；Pi 启动身份沿用 [server/pi-launch.js](../server/pi-launch.js) |
| HTTP body 限制与 JSON 响应 | [server/http-utils.js](../server/http-utils.js) |
| 安全投影与脱敏 | 对应功能的白名单投影与 [lib/redact.js](../lib/redact.js)；详细边界见 [security.md](security.md) |

工具的存在不授予新权限；后端身份、路径、审批与失败守卫不能用前端检查替代。
不改 Pi 本体或协议来迎合 GUI 抽象；遵守 AGENTS 及各功能已有边界。

## 异步、失败与生命周期

- 发起异步操作时捕获所属身份，写回前重新核对；根据实际链路使用 owner、workspace、generation、bridge run、scope、请求序号或 surface 实例。字段由现有协议决定，不自造一套通用身份。
- `await` 返回不代表结果仍属于当前界面。切项目、切会话、关闭或重开面板后，旧响应不得更新新状态、清空新草稿、关闭新面板或解除新操作的锁。
- UI 守卫之外，服务端在执行前也要核对期望身份与权限；取消请求不保证底层已停止，必须按已有权威终态收口。
- 事件监听器、定时器、观察器和子进程须有明确创建者与释放者。约定 `dispose`、`finally` 或退出处理路径，清除挂起请求；重复关闭应安全，旧操作只能释放自己持有的资源。
- 失败、取消、中断、超时、未知和成功应按真实语义区分；不能凭请求已发送、spawn 成功或退出码 0 就宣布业务成功。
- 不以空 `catch` 吞掉业务失败并静默宣称成功。允许隔离已知的 best-effort 清理错误，但须说明原因、保留安全终态且不阻止其余资源释放；例如 [secondary-surface.js](../public/ui/secondary-surface.js) 的 disposer 隔离。
- 安全判断失败保持 fail-closed，缺失证据保持未知；不把不可用、超时或未观察到当成已允许。错误输出按现有安全白名单处理，不补打原始 payload。

参考 [review-comment-persistence.js](../public/review-comment-persistence.js) 的 owner/scope/epoch 迟到响应防护；
UI surface 的职责见 [work-surfaces.md](work-surfaces.md)，具体安全规则见 [security.md](security.md)。

## 文件规模软阈值

行数用于提示职责检查，不作为强制质量门或自动拒绝条件。计数按物理文本行（含注释与空行）理解。

| 对象 | 建议与处理 |
| --- | --- |
| 新业务文件 | 通常 100～400 行；更短且职责完整也合理 |
| 超过 500 行 | 检查职责、状态归属与依赖，指出是否存在可独立的业务边界 |
| 超过 800 行 | 应按明确职责拆分，或在交付说明中解释集中实现的原因 |
| 超过 1000 行 | 需要明确例外说明：集中职责、拆分风险与本次影响范围 |
| 普通函数 | 尽量约 60 行以内；复杂状态机按可理解性评估并说明理由 |
| 旧大型文件 | 登记历史基线，本次只检查所改职责，不强制立即拆分 |

文件长度不等于代码质量；不得删除注释、压缩多条语句或机械拆文件绕过提示。
CSS、测试、fixture、生成文件单独评估：关注样式归属、场景组织、数据形状或生成来源，
不套用业务文件阈值。复杂状态机若集中实现更便于核对不变量，可以保留并解释。

以下是 G0-B 在基线 `f542aece54a06eef1cc2d13bf4b93531a47b3997` 登记的代表性历史大型模块，
不是全仓清单，也不是新增代码的豁免；本轮均不重构：

| 文件 | 物理行数 | 历史职责与保留理由 |
| --- | ---: | --- |
| `server.js` | 1304 | 后端组合与跨模块接线；后续新增业务仍放对应模块 |
| `public/app.js` | 1352 | 前端启动、事件路由和接线；本轮不调整既有路由与状态 |
| `electron/main.cjs` | 908 | 窗口、宿主和启动生命周期；拆分需另行验证 Electron 边界 |
| `lib/git.js` | 1017 | 有界 Git、路径及写权限边界；拆分需另行安全验证 |

本轮仅制定政策，不新增自动行数检查工具。行数报告工具留给 G1。

## 测试代码

- 验证真实行为、状态变化与失败边界，不能只凭源码字符串匹配证明功能正确；结构守卫可作补充。
- fixture 优先对照真实上游结构和版本出处；必要时同时覆盖接受与拒绝，防止错误 fixture 隐藏缺陷。
- 写入用例只用 `os.tmpdir()` 的隔离 fixture；默认不依赖真实 Pi、付费模型、账号或开发机恰好装了什么。
- 不删除断言来提高通过率；保留首次失败和修复后的验证，环境 skip 单独统计，断言减少逐项说明。
- UI 布局提供真实 Electron 或浏览器交互/截图；jsdom 只证明其可测行为。高风险功能需相应故障注入和安全专项验证，条件受限如实报告。

具体执行时机、canonical 唯一入口、环境隔离与证据复用统一见
[testing.md](testing.md#测试执行政策)；审查深度以 [REVIEW.md](../REVIEW.md#2-按变更风险决定审查力度) 为准。
