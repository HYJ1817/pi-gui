# 供应商管理重构：设计与实施方案

状态：**待用户验收的设计，不是实施授权或已实现功能**。审查日期：2026-11-07。

目标：用原生 ESM/DOM 实现 PI-Desktop 风格的完整服务管理；先冻结功能、布局和接口，再分工开发。不引入 React、依赖或新模型运行时，不修改 Pi，不改变无关业务。

## 1. 勘察结论与证据范围

- pi-GUI 基线：`750dee491ae0a0b3b499916b014e161f46ef6f75`，本地与 fetch 后 `origin/main` 一致，工作区起始干净；最新 Release 为 [v0.32.0](https://github.com/HYJ1817/pi-gui/releases/tag/v0.32.0)。设计分支：`codex/provider-management-rebuild-plan`。
- 准确基线 [CI 42236631542](https://github.com/HYJ1817/pi-gui/actions/runs/42236631542)：push、attempt 1，完整计划、五组测试、Electron build check、CI gate 均 success。它只证明基线，不证明未来重构。
- 参考限定为 [PI-Desktop 92ae661f1e399e69d514086b46029b4c34ba1a92](https://github.com/vastsa/PI-Desktop/tree/92ae661f1e399e69d514086b46029b4c34ba1a92)，不跟随 main。第 2 节列出的组件及其 IPC、存储调用边界均按该提交审查。
- 视觉依据为用户原图 `Snipaste_2026-10-31_23-56-39.png`、`Snipaste_2026-10-31_23-57-32.png`（均 1808×1205，用户本地 `OneDrive/图片/pi-desktop/`）。本次直接查看原图，没有生成或增加测试截图。图中模型名称、容量及供应商条目只作视觉样本，不当作当前能力或推荐目录。
- 本机通过 `server/pi-launch.js` 的纯文件解析定位到 Pi 包 **1.5.0**，只读其 `docs/models-configuration.md`、公开类型与 `dist/core/provider-composer.js`，没有启动 Pi 或模型调用。这是配置语义证据，不是运行中 Pi 身份或新版完整兼容资格；仓库旧文档的 1.0.0 不能替代实际能力探测。

**保留的抽象**：`server/providers.js` 的安全投影与模型字段清洗、`lib/models-api.js` 的协议归一化、P25 私有 Auth worker 与 flow、统一 launch identity、RPC 模型/思考档位回读、Settings surface 生命周期、modal 的焦点/取消出口及 `public/tokens.css`。

**与直接照搬的差异**：①截图 API Key 密码框不能直接移植，原文输入转官方 Pi 交互终端；②参考的数据库/secret store/host IPC 不移植，使用 Pi 配置加 GUI 非秘密元数据；③内置模型未勾选只影响 GUI 候选，不能冒充从 Pi 内置目录删除；④截图四列是宽窗目标，窄窗按断点降列；⑤配置同步必须保护 Classic 和独立 Runtime，不能沿用一次重启关闭全部 Runtime 的路径。

实现路线比较：直接翻译参考全栈会引入 React、专有 host 与密钥库；只换皮现有表单无法满足编辑、选择持久化与安全同步；**采用原生组件 + 现有协议适配 + 有版本的配置事务/GUI 元数据**。下述功能和接口构成选定方案。

## 2. 参考源码、许可证与功能差异

参考路径前缀为 `apps/desktop/src/`；下表是源码行为，不代表 pi-GUI 已具备。

| 参考组件 | 实际职责、状态和交互 | 依赖及 pi-GUI 映射 |
| --- | --- | --- |
| `components/settings/ServiceChooser.tsx` | 本地 query 搜索名称/别名/地址；订阅和 API Key 分组，另有 plugin/Jev 条目；Enter/方向键导航，点卡片回调父级，不联网 | `service-catalog.ts` 与父级 OAuth descriptor，映射新 chooser；能力可用性由 Pi descriptor 决定 |
| `ProviderSetupDialog.tsx` | 新增/编辑草稿，服务切换，连接字段，模型及高级配置；保存前聚合、校验，编辑空 secret 表示保留 | `lib/api.ts` 的 create/update/list models；映射单个原生 dialog controller |
| `ServiceList.tsx` / `ServiceRow.tsx` | 列表组织、状态与模型信息、编辑/复制/删除等行操作和顺序交互 | provider store/API 负责持久化；映射 Settings 服务列表，不能让 DOM 成为配置真值 |
| `ProviderConnectionFields.tsx` | API 服务名称、Endpoint/API 风格、密码框；预设 chip 可更换，自定义 URL blur 规范化/校验；值由父级持有 | 参考原始 key 在 renderer 状态里；本项目改为安全凭据卡，不复制此秘密流 |
| `ModelSelectionPanes.tsx` | 左侧来源模型搜索/勾选，右侧已选模型搜索、顺序、移除、单模型高级配置；底部自定义 ID | 父级模型草稿及 callbacks；映射双栏纯视图和选择 reducer |
| `useProviderModels.ts` | idle/loading/ready/error，cache/remote/catalog/fallback 来源；输入防抖 600ms，编辑先缓存再 live、手刷跳缓存，requestSeq 丢弃旧请求 | `listProviderModels`/catalog，不是聊天 RPC；本项目保留结果隔离，但首次远端必须用户触发 |
| `useRecommendedModelSelection.ts` | 根据可信来源触发首次推荐；调用 `recommended-models.ts`，最多选 3 个合适聊天模型；用户手动选择后停止自动改选 | 前端策略；本项目可采用同类保守策略，不能以模型 ID 猜能力 |
| `VendorAccountDialog.tsx` | 编辑既有 OAuth 账户显示名、headers、模型与高级参数，复用同一双栏，没有 API Key 输入；首 binding 作为默认模型 | `listProviderModels({providerId})` 及父级保存；登录另由 vendor-account hook/登录 dialog 编排，本项目只接 P25 flow |
| `service-catalog.ts` | 显示名、检索别名、Endpoint/API 风格、连接方式及服务预设 | 静态产品目录；只映射经验证协议，不把目录存在当成可登录 |
| `styles/providers.css` | 服务列表、行、状态、动作等样式 | 映射局部 `.provider-management-*` 样式与既有主题 tokens |
| `styles/model-config.css` | 配置壳、字段、双栏、模型行和高级设置；壳 1040×720 CSS px，并有窄窗规则 | 配置双栏约 940px 以下堆叠、720px 以下工具栏换行 |
| **补读** `styles/service-setup.css` | chooser 的实际网格、分组、搜索、滚动样式 | `auto-fill/minmax(200px,1fr)`、gap 6；源码没有写死“四列” |

参考业务链为 renderer → `src/lib/api.ts` → `electron/main/ipc/provider-ipc.ts` → Rust `providers.*` host 调用 → `crates/host-core/src/providers/` 的校验、仓储、目录及 credential 模块。配置保存在数据库/provider config 中，secret 另存；不能改名后当成 pi-GUI 的 `/api/*`。参考 `secrets.rs` 有 AES-GCM 文件后备和机器 key，不能称为操作系统 Keychain，也不复制到本项目。

**许可证处理**：固定提交根 [LICENSE](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/LICENSE) 是 **GNU LGPL v3**，并纳入 GPL v3 条款；pi-GUI 根 [LICENSE](../LICENSE) 是 MIT。默认仅参考产品行为/截图，独立实现，不复制 TSX、CSS、推荐算法或 logo 资源。若以后直接复制或改编实质源码，必须逐文件核对版权与许可，保留通知、许可和修改说明，并落实适用的相关源码、用户修改/替换等分发义务；不能只写致谢或给复制文件套 MIT。计划验收不等于批准源码移植；分发结构有疑义时先完成许可证核对。

| 能力 | PI-Desktop 固定版 | pi-GUI 沿调用链确认的现状 | 结论 |
| --- | --- | --- | --- |
| 搜索/分类服务目录 | chooser + 静态 catalog | `public/providers.js:28` 九个按钮预设；Auth 另有原生 descriptor 列表 | 复用预设数据，新增统一目录投影与搜索 UI |
| API Key/OAuth | renderer key + secret 后端；vendor login | P25 OAuth 完整 flow；API Key HTTP 写入只允许 env 引用 | OAuth 复用；网页原文输入排除，见 §5 |
| 配置 CRUD/复制 | 有仓储及对应操作 | GET、POST upsert、DELETE 可用；界面只新增/删除，没有完整编辑/复制 | 先补无损编辑/CAS/安全复制，再做行操作 |
| 自动发现/刷新 | remote + catalog/fallback | `/api/providers/models` → `fetchModels` 支持四类协议；仅请求时传 env 引用，不自动用已存 key/headers | 复用解析，补来源凭据绑定、网络策略和可取消操作 |
| 搜索/多选/添加 | 双栏实时选择 | 已有拉取面板、搜索、全选、去重追加到文本框 | 复用语义，改为结构化双栏；补排序及持久化 |
| 手动模型/高级参数 | 有 UI 和配置 | `parseModelLine`、server 白名单支持 contextWindow/maxTokens/reasoning/input/capabilities | 底层大部分已有；新增表单及内置 modelOverrides 的受限写入 |
| 连接测试 | 专门操作及反馈 | 模型拉取不能证明推理有效；没有独立测试合同 | 新增分级证据接口，不自动调用付费模型 |
| Pi 同步 | 参考 host 自有运行时消费配置 | 自定义配置保存只提示重载；`reloadPi()` 走 restart 并清线程；P25 sync 会关闭独立 Runtime | 新增逐 Runtime 的安全同步，保存与生效分开 |
| 主题/响应式/键盘 | 参考 CSS/组件提供 | 现有 tokens、modal、Settings 生命周期可复用 | 固定最终壳，补各状态、筛选/排序与焦点规则 |

## 3. 最终功能、状态所有者与验收入口

记号：**C**=现有配置 `/api/providers`；**A**=现有 `/api/provider-auth` 系列；**M**=§6 新管理 API；**R**=既有 RPC 回读。所有新能力是实施计划，不是假定接口已存在。

| 功能 | 状态所有者与现有可复用点 | 必须增加/调整 | 主要验证 |
| --- | --- | --- | --- |
| 1 搜索式服务选择 | 前端 dialog 的 query/category；九个预设、A descriptor | M 目录统一 serviceId、providerId、authMode，中文/英文/域名别名 | 搜索和分类交集、空结果、同厂商 API/OAuth 区分 |
| 2 订阅/API Key 分类 | A 的 methods/isSubscription；目录只提供展示 | 不支持的订阅禁用并说明；OpenAI 同厂商多认证方式去重展示 | 缺 SDK/未知/不支持三值，不虚构登录按钮 |
| 3 预设/自定义 Endpoint | 草稿持有；C 四种 API 类型 | 受限协议选择；变更目标使测试失效，并触发凭据重新绑定规则 | URL/协议校验、旧配置仍可读取 |
| 4 API Key 输入/保存 | Pi 管凭据；server 管 env 引用；前端不持秘密 | 安全凭据卡、官方终端输入说明、配置后刷新；不新增明文存储 | key/token/header 不进入响应、DOM、草稿或日志 |
| 5 OAuth | A 单用户 flow，worker/Pi 管 PKCE/token/刷新 | 支持按 provider 挂载同一个 flow；与服务配置取消分开 | prompt ID/flow generation/revision、重开续接、超时取消 |
| 6 自动发现/刷新 | 后端 operation；前端 source/error/requestId | 进入先读离线目录；首次远端需明确“获取列表”，授权当前目标后本次 dialog 可自动刷新 | 离线不请求、迟到丢弃、取消、凭据与目标绑定 |
| 7 双栏选择 | 单一草稿 selected IDs + ordered IDs；C 模型归一化 | 左勾选即入右栏，右移除同步取消；来源模型和已选模型分离 | 两栏一致、刷新不抹除手动修改 |
| 8 搜索/多选/排序/移除 | 两个 query 仅前端；顺序保存到 M metadata | 全选仅当前筛选结果；排序拖动及键盘上/下移；移除不删凭据 | 混合勾选、跨过滤保留、刷新/重启顺序稳定 |
| 9 手动模型 | 草稿 models map；C cleanModelEntry | ID 校验、同 provider/id 去重；离线也能加；不用假发现结果填充 | 空白/重复/长度/恶意文本、手动项刷新后保留 |
| 10 上下文/输出/思考 | C 支持字段；能力模块三值；R 决定实际档位 | 数字正整数/安全上限；未知不写默认；受限 modelOverrides 支持内置模型 | 数值边界、未知保留、R 回读不符提示；不自造 reasoning effort |
| 11 新增/编辑/复制/删除 | 后端事务；C 现有读写原语 | create 拒重名；edit ID 不可改；clone 新 ID 且清凭据；delete CAS+确认 | 并发、隐藏字段保留、复制无 secret、内置项删除语义 |
| 12 连接测试/错误 | 后端 operation；复用 discovery 协议/网络层 | M test 返回阶段和证据，错误闭集；不自动发送 prompt | 401/403/404/429/超时/TLS/非JSON/空列表/unsupported |
| 13 持久化/Pi 同步 | Pi models.json + GUI metadata；后端 sync coordinator | 事务版本、逐 Runtime pending/applying/applied/error；R 最终确认 | 崩溃、回滚、忙碌延后、重开同一session、多Runtime保护 |
| 14 主题/窄窗/焦点 | theme.js/tokens/modal/Settings 生命周期 | §4 的固定壳和状态；应用级操作不跟项目切换丢失 | 两主题、四档宽度、键盘、IME、原生 Browser 遮挡 |

### 数据与选择语义

- 稳定身份：`serviceId` 是 GUI 服务实例键；`providerId` 是 Pi 注册/认证键；模型键为 `(providerId, modelId)`。同厂商不同 API/订阅方法是不同目录项，不能仅用显示名关联 token。初版一个 providerId 对应一个服务实例，多个 Endpoint 用新的 providerId；OAuth 账号不能克隆成独立新账号。
- Pi `models.json` 仍是注册配置真值，`auth.json` 仅 Pi 管理。**新增** `DATA_DIR/provider-management.json`（schemaVersion 1）只存 `serviceId/providerId/catalogId/displayName/enabled/selectedModelIds/modelOrder`，无 key/header/Endpoint/token。无 sidecar 时从现状惰性读取，默认保留所有原有候选，不启动即迁移。
- 自定义供应商模型写标准 `models` 数组；已有内置模型的元数据修改用经能力验证的 `modelOverrides`，不是伪造重复 provider。只改其原生支持的 name/contextWindow/maxTokens/reasoning/input；toolCalling/streaming 本轮只读展示，既有 custom capabilities 原样保留，不能写入 Pi 不支持的 override 字段后宣称生效。模型选择顺序由 GUI 元数据管，不假定 Pi 回读顺序等于用户排序。
- Pi 1.5.0 的配置语义是内置模型逐项替换或追加，未列出者仍保留。因此“已选模型”控制两个 GUI picker 的候选；可用集合为 **Pi RPC 可用集合 ∩ GUI 启用选择**，手动模型注册但尚未回读成功时只在管理页显示“待同步”。不拦截/伪造 Pi 的 `get_available_models` 原始结果。
- 当前会话正在使用的模型即使从候选移除，也保留为只读“当前使用，已从候选移除”，不自动切换。零选择可保存为“已配置、未启用模型”，不自动全选；不能发出声称可用的默认选择。
- 参考以右栏首模型作为默认；本项目右栏排序只决定候选展示顺序，不自动更改任何既有会话默认/当前模型。新会话仍服从 Pi 回读；需要改变启动默认时应另用已验证的 Pi 设置能力，不能靠排序暗改。
- 删除自定义服务移除其配置和 GUI 元数据，不顺带 logout；内置服务只能停用 GUI 实例，Pi 内置目录仍在。认证移除是独立确认动作。复制只复制安全展示字段/允许的模型元数据，清 env 引用、已存 key、headers、command 和 OAuth 关系，不复制后端隐藏字段。

## 4. 最终 UI 规格（两张图为几何验收基准）

### 固定壳与组件结构

截图原始比例中，dialog 约在 `(125,63)`，尺寸 `1560×1080`，占窗口约 86%×90%；内边距约 28、两列间距约 18，每栏约 744。图片是设备像素，不能直接当 CSS px。以参考源码的 1040×720 CSS px 为基准，缩放后保持此比例：`width:min(1040px,calc(100vw - 48px))`，`height:min(720px,calc(100dvh - 64px))`；桌面内边距 18、圆角 18、主列 gap 12。标题行固定、主体 `min-height:0`，由各列表独立滚动。不得退回窄小的纵向旧表单。

```text
Settings 模型配置：服务列表 + 添加服务 + 全局同步状态
└─ ProviderManagementDialog（一个 modal 实例，内部切换，不叠开同级 modal）
   ├─ Header：添加/编辑 AI 服务       高级设置 | 取消 | 保存服务
   ├─ Chooser：搜索 + 分类筛选 + 分组卡片网格（选择阶段）
   └─ Setup（配置阶段；共享草稿，不重建壳）
      ├─ ConnectionRow：服务/地址/更换       凭据卡/API Key 或 OAuth
      ├─ StatusStrip：测试连接 | 发现/保存/同步反馈
      └─ ModelPanes：候选模型               已选模型 + 数量
         ├─ 全选/刷新/搜索                 搜索/排序/单行高级/移除
         ├─ 来源列表                       有序列表
         └─ 来源/错误/重试                 固定底部自定义ID + 添加
   └─ Advanced：同壳替换主体，返回配置；服务高级或单模型编辑器
```

管理列表保留 Settings 中央页面；添加/编辑使用真正 modal，避免当前 `presentDetail` 将子弹层变成 region 而丢失 modal 焦点约束。旧“供应商与认证”入口定位到同一管理视图的认证区，不保留两套状态源。`onCancel` 统一处理取消、Esc、遮罩；内部高级页返回保留两栏滚动与焦点。

### 选择阶段（图一）

- 标题“添加 AI 服务”，右上“取消”；不出现保存。搜索占整行，36–40px 高，提示“筛选服务”。其下紧凑分类“全部 / 订阅登录 / API Key”，默认全部；全部视图仍按截图先订阅后 API Key 分组。
- 可用内容宽度 ≥960px 为四列，700–959 三列，460–699 两列，更窄一列；gap 6px；卡片高至少 50px，长副标题可增高，分组间距 16px。自定义端点固定为 API Key 组第一项。卡片整块可点，标题/副标题双行，域名可折行，不能挤出横向滚动。
- 沿用截图的小圆形字母/汉字头像作为默认；可加入仓库已有、许可清楚的本地 SVG 图标，20–28px，不远端加载 logo，不引入图标依赖。不依赖品牌色表达认证方式。
- 搜索匹配名称/别名/域名；无结果显示清除搜索。加载显示等尺寸骨架；目录读取失败显示重试和自定义端点入口。Pi 不支持的订阅卡保留“当前 Pi 不支持”及说明，不允许点后假成功。

### 配置阶段（图二）

- 标题、右上高级/取消/保存与图相同。首行严格两列：左侧服务身份、灰色 Endpoint、右对齐“更换”；右侧凭据卡。预设 URL 可在高级修改；自定义端点初次进入在左卡内直接输入 URL/API 类型，校验错误就在字段下。
- 凭据区保持截图位置与高度：显示“已配置 / 未配置 / 未知”“环境变量引用 / Pi 本机凭据 / 无认证”及操作。**不渲染由真实 key 生成的密码框，不返回后四位或长度**；使用固定“已配置”占位。env 模式可填 `$NAME`；原文模式点“在官方 Pi 配置”查看终端步骤，配置后“刷新状态”。OAuth 同区展示登录/取消/设备码/链接/授权回复/退出确认，可展开在凭据列内滚动，左侧不被挤窄。
- 中间状态条预留一行，文字可两行扩展：测试连接、获取中、离线目录、已保存待同步等。离线已有目录先显示；远端首次获取前说明会向当前域名发送认证请求，仅用户点击开始。选择卡片/保存不隐式联网。
- 下方左右 **1:1** 双栏、深色 inset 背景、圆角 10px，充满剩余高度。左栏头部为混合勾选框、“该服务的模型”、“获取列表”和搜索；右栏头部为“模型设置 N”和独立搜索。主内容独立滚动，header 不随滚动消失；右栏底部自定义输入/添加始终可达。
- 左模型行：复选框、等宽 ID、可选显示名、右侧上下文/输出简写；缺数值显示“未知”，完整数值/来源可查看。右行：拖动把手、ID、容量、“高级”、移除。推荐自动选择仅用于新建、可信能力明确的首次结果，最多 3 个；展示原因，任何勾选/移除/排序/手动添加后停止自动选择。编辑不自动推荐，刷新不重置既有选择。
- 筛选不删除选择；左表头全选只作用于可见结果。右表筛选时禁用拖动排序并说明，键盘上/下移也只在完整列表执行。先确定 ID 唯一性再添加；手动项标记来源，未发现不等于不可用。
- “更换服务”回 chooser；脏草稿先确认。确认后清旧来源、推荐资格、凭据绑定、网络许可和操作，模型草稿不跨服务搬运；取消确认则原样保留。编辑的 providerId 固定，跨身份更换使用“复制为新服务”。

### 高级设置、状态、主题与键盘

- 服务高级页固定字段：显示名、只读/新建可填 providerId、Endpoint、四种 API 类型、认证模式/env 引用；底部只读兼容性/保留隐藏字段提示。任意 header、`!command`、token 注入不设 UI 编辑器。
- 模型高级页：ID（创建后固定）、显示名、contextWindow、maxTokens、reasoning“继承/支持/不支持”、input text/image；toolCalling/streaming 以三值只读并标来源。选择“继承”显式清除该字段的既有用户覆盖，未修改字段保持原样；有效值未知时显示未知。正整数 ≤ `Number.MAX_SAFE_INTEGER`，maxTokens 大于已知 contextWindow 时阻止保存并解释。这些是声明元数据，不是对远端能力的保证；Pi 实际 thinking levels 仍由原 RPC 回读，不提供凭模型名猜出的档位。
- 状态闭集：`loading / ready / empty / discovering / testing / saving / saved-pending-sync / syncing / success / conflict / error / unsupported / disabled`。各操作独立 busy；发现失败保留旧结果并标 stale，空列表与失败分开；保存失败保留完整草稿；409 展示“重新读取并对比”，不覆盖；同步失败显示“已保存，尚未生效”及重试。success 只表示对应事实，不显示笼统“已连接”。
- 保存条件为字段有效且没有在途保存；无需发现成功或在线才可保存。存盘时暂停退出/重复提交；网络操作可取消，关闭时 Abort 并用 dialog generation 丢弃迟到结果。保存结果不确定时先查 operation/revision，不盲目重发。
- 深色使用现有 `--ds-bg-tertiary` 壳、`--ds-bg-inset` 列表、`--ds-field-inset-bg` 输入、`--ds-text-*` 和白色主按钮；浅色使用同名语义 tokens，列表为浅 inset、深色文字/主按钮。聚焦、hover、选中、禁用、错误都用现有 tokens；不在全局修改 `.field/.modal-card` 来凑布局。
- 视口 <940px 时配置主体上下堆叠，连接区也单列；候选/已选各至少 200px，可通过锚点跳转，右底部添加不遮列表。<720px 工具栏换行；<480px 壳距边 8px，顶部动作换成两行，行内元信息可换行，主操作至少 32px 点击区。低高度 <600px 允许主体整体滚动，标题/保存固定，不能强行保持两栏造成不可达。
- modal `aria-labelledby/aria-modal`、Tab 圈定和返回原触发器复用现有实现；chooser 初始焦点搜索，setup 初始焦点服务标题/首个需填字段。Tab/Shift-Tab、原生复选框 Space、按钮 Enter、分类方向键；搜索输入 Enter 不隐式保存，中文 IME composition 不触发快捷键。排序提供可见上/下移动操作和 live region，不只支持拖拽。
- Esc 逐级退出高级/确认/主 dialog；脏退出确认，OAuth 关闭不自动取消全局 flow。服务网络请求随草稿失效；认证 flow 继续由服务端持有。网络反馈 `role=status`、字段错误关联 `aria-describedby`，失败不抢走用户输入焦点；移除行后焦点落到相邻行或添加框。

## 5. API Key 与 OAuth 安全方案

**不可放宽的现状**：`server/providers.js:91` 的 env 校验、POST 与 models 路由对 key 原文/command 的拒绝、GET 的白名单投影，以及 [provider-auth.md](provider-auth.md) 的“秘密输入不进入 renderer”。密码框只遮视觉，不能解决 DOM/状态/HTTP/草稿泄漏。`provider-auth-sdk.js` 私有 worker 已拒 secret prompt；不能为模仿截图把它转成普通 `respond.value`。

采用以下最终路径：

1. **env 引用**：网页只接受 `$NAME`/`${NAME}` 或无认证；服务端只回存在三值与引用名，不回环境值。不在 GUI 设置/持久化全局环境变量。缺变量可存盘，但明确 Pi 可能不加载该服务。**本地无认证适配**：Pi 自定义模型也可能要求非空 key 才进入可用集合，本机 1.5.0 文档的 Ollama 示例使用非秘密 dummy key。初版新建本地服务要求用户自行提供指向非秘密占位值的 env 引用（例如 `$OLLAMA_API_KEY`），明确它只用于 Pi 注册兼容；GUI 的本地模型发现不携带该占位认证头。未设置时可存为待配置但不得显示可用于聊天。已有本地配置只读识别、不替用户改 key；不为此放宽原文 validator 或生成新的秘密。
2. **Pi 保存的 API Key**：用户自行打开官方交互终端，运行同一安装身份的 `pi`，在其中 `/login <providerId>` 输入原文，再回 GUI 刷新。Pi 负责其原生存储；不承诺 OS 加密。自定义 provider 若需要先注册，则保存未认证配置 → 官方登录 → 刷新/同步。本机 1.5.0 源码存在 `ModelRuntime.login(...,'api_key',interaction)` 与自定义 provider secret prompt，但这不构成把 secret 接进 renderer 的许可；能力未知/缺失时回 env 方案。
3. **OAuth**：只复用现有 A 的 login/logout/respond/cancel/sync。Pi 管协议、PKCE、token 保存/refresh；GUI 只接安全链接、设备码、允许的非秘密授权回复和状态。SDK 缺失时显示官方终端指引；不同订阅别名必须映射 descriptor，不能复制参考图的登录清单后硬编码可用。
4. **旧密钥**：literal、command、provider/model headers 和未知扩展字段只在后端保留；新 API 明确 `credentialAction: keep | env | none`，省略默认为 keep。none 要单独确认并仅清对应自定义配置引用，不删除 Pi OAuth。修改含凭据 Endpoint 时不能自动 keep：已知凭据需对新旧规范化目标显式重新绑定确认；含不透明扩展/认证头的配置拒绝原地跨目标修改，改用无凭据安全复制。复制绝不继承隐藏秘密。

现有 `server/agents/cli.js` 是 stdin ignore/stdout pipe 的后台 runner，不是秘密交互终端，不能直接复用。**本轮最终产品范围不含网页输入 API Key 原文、自建 vault 或一键秘密终端**；如用户以后要求一键开启外部 TUI，需要单独设计固定身份、参数数组、环境剥离、独立可见窗口、互斥与关闭清理，仍不把 key 传回 GUI。此排除是保持安全约束的必要适配，不是宣称已满足“网页内密码输入”。

所有接口继续 token + Host/Origin 检查。管理与认证属于应用级用户配置；新路由在认证之后、Classic owner 检查之前精确接线，不能绕过访问控制，也不能靠伪造 Classic owner 在 Runtime 中调用。认证已有全局 flow/更新安装互斥继续保留。

**带凭据的发现必须先补网络边界**：现有 fetch 会跟随 redirect，读取 arrayBuffer 后才二次查 4MB，也没有完整目标/IP 校验；现状不能承载任意新保存凭据自动探测。新增统一 transport：只向确认的规范化目标/路径发送最小必要认证头；公共服务 HTTPS，禁止 URL 凭据、query/hash、跨源 redirect 和 TLS 降级；逐跳校验（初版可完全拒绝重定向），DNS 解析和实际连接地址绑定，阻止私网/链路本地/元数据/IPv4映射IPv6绕过。localhost/Ollama 是显式本地模式，只允许无秘密、用户指定 loopback 端口；旧 HTTP/LAN 配置不删除，但不自动发凭据探测。

发现最多 8 个同源受限候选，总 deadline 30s，流式上限 4MiB、最多 3000 模型；遇 401/403 立即停止，用户取消中止真实请求。已有路径向上回退必须约束在已确认的路径策略内，不能扩大凭据发送范围。服务端只回闭集错误、有限模型白名单与 evidence；不回原始错误/body/响应头/源 URL 中秘密，日志只记固定 code/阶段/计数。存储凭据通过已绑定公开 SDK 在私有 worker 内解析/请求，主线程与 renderer 不拿 token；`!command` 不由 GUI 解析执行。没有可证明凭据获取方法就返回 unsupported，不回退读 auth.json。

## 6. 后端接口与源码修改计划

### 现有合同（保留兼容入口）

| 路由 | 当前请求/响应和限制 | 重构处置 |
| --- | --- | --- |
| GET `/api/providers` | `{ok,path,exists,providers,keyStates}`；配置只投影 baseUrl/api/允许模型字段，无 key/header | 保留旧字段，转同一无损仓储；损坏读取不得继续伪装空配置 |
| POST `/api/providers` | `{name,config:{baseUrl,api,apiKey?,models}}`；同名 upsert，空 key 保留旧 key/headers | 新 UI 不再用无版本 upsert；旧入口接同一锁与校验，不能绕过新安全事务 |
| DELETE `/api/providers/:name` | 删除配置，未做 GUI 模型同步 | 转同一事务；旧入口保留已有语义但不能绕过冲突/文件保护 |
| POST `/api/providers/models` | `{baseUrl,api,apiKey?}`；返回 models/source/keySource/tried，失败多为 HTTP 200 | 复用解析，补 transport；新 UI 使用 operation API，旧入口继续拒原文 |
| GET `/api/provider-auth`；POST `/login,/logout,/respond,/cancel,/sync` | descriptor/flow/sync；login `{providerId,authType:'oauth'}`；respond `{flowId,promptId,value}` | 保持 flow 合同；新增按 provider 展示，修正应用级路由和安全同步接线 |

### 新合同（命名在此冻结，DS 不自造请求）

统一错误 `{ok:false,code,message,retryable,fieldErrors?}`；只用固定文案。业务错误 HTTP 400，版本冲突 409，能力缺失 422，维护互斥 423，临时不可用 503；发现/测试/同步受理 202。GET 只读离线快照，不主动访问供应商。所有新管理 mutation 有 `requestId` 去重；commit 在事务中持久化 requestId/结果收据，相同 ID/相同请求重返原结果，不同请求复用 ID 返回 409。响应丢失只能用原 requestId 重查/重试，不生成新 ID 盲写。

| 接口 | 请求 / 安全响应 | 实施责任 |
| --- | --- | --- |
| GET `/api/provider-management` | `{schemaVersion:1,revision,capabilities,catalog,services,auth,sync}`；revision 是后端不透明版本；services 含安全连接字段、credentialState、models/selection/order、readOnly/compatibility；每模型含 `configSource/effectiveValues/editableOverrides` | 新 `server/provider-management.js` 聚合 C/A；catalog 来自静态预设 + Pi 安全 descriptor，不泄露私有结构 |
| POST `/api/provider-management/commit` | `{requestId,expectedRevision,action:create\|update\|clone\|delete\|disable,draft?,serviceId?,credentialAction?,targetConsent?}`；draft 为明确安全字段及有序模型/选择；存盘成功 HTTP 200 `{revision,serviceId,saved:true,operationId,sync}` | 新 `server/provider-config-store.js` 承担 CAS/无损合并/事务；clone 输入源 serviceId 与新 providerId；create 重名 409 |
| POST `/api/provider-management/discover` | `{requestId,serviceId?,expectedRevision,draftConnection?,consent:{targetFingerprint,credentialMode}}`；受理 `{operationId}`；无 secret | 服务端重新计算 fingerprint，不信任客户端自报授权；draft/env 模式只允许引用，stored 模式只绑定原服务目标；OAuth 默认只读已验证目录 |
| POST `/api/provider-management/test` | 与 discover 同一安全连接参数；结果 `{reachability,modelListAccess,credentialAccepted,inferenceVerified:false,evidence,checkedAt}`，事实为 true/false/null | 只做只读列表探测；200 未必需要认证，因此 credentialAccepted 可 unknown；没有列表端点为 unsupported，不能判推理失败 |
| GET `/api/provider-management/operations/:id` | `{kind,state,revision,result?,error?}`；state 为 pending/running/success/failed/cancelled；发现 result 含归一化 models、sourceKind、stale、计数 | 新 operation registry，限并发/容量/TTL；归属当前 GUI 用户，结果没有 raw payload |
| POST `/api/provider-management/operations/:id/cancel` | `{requestId}`；中止发现/测试，幂等；已提交配置不提供伪撤销 | 保存操作受理后通过状态确认，不用 cancel 假装撤回磁盘写入 |
| POST `/api/provider-management/sync` | `{requestId,revision}`；返回 per-runtime 状态及 operationId | 新 `server/provider-config-sync.js`；与 A 共用安全同步协调器，替换高风险 closeAll/restart 接线 |

`capabilities` 明确 `rawKeyInput:false`、`oauthLogin`、`discoveryModes`、`modelOverrides`、`syncMode` 的三值/支持原因。DS 按能力禁用控件，不能用 HTTP 成功代替 capability。目录/provider 列表的字段上限、请求上限和未知字段拒绝由 Codex 在合同 fixture 中锁定；基本限制沿用 providerId 1–64、modelId 1–300、name 200、最多 3000 模型，重复 ID 直接报错，不能静默裁剪造成身份碰撞。

安全 draft 字段固定为 `{serviceId?,providerId,catalogId?,authMode,displayName,connection:{baseUrl,api},modelPatches,selectedModelIds,modelOrder,enabled}`；authMode 只为 `environment / pi-credential / oauth / none`。本地无认证实例可同时记录 `piRegistrationReference`（仅 env 引用），它不能成为发现请求的真实凭据。credentialAction 为 `{type:keep}`、`{type:env,reference}` 或 `{type:none,confirmed:true}`；保留和清除不可用空字符串区分。

每个模型 patch 为 `{modelId,operation:upsert|remove,set:{name?,contextWindow?,maxTokens?,reasoning?,input?},unsetFields:[]}`；set/unset 不得交集，省略=不变，unsetFields=删除该可编辑覆盖并恢复继承/未知。后端依据可信 configSource 决定写 custom models 或内置 modelOverrides，renderer 不提交原始 config/headers；remove 对内置模型只去掉 GUI 自有覆盖/选择，不能删除其原生定义。GET 的 effectiveValues 包含只读三值能力与来源，editableOverrides 只含允许编辑字段；同步 RPC sanitizer 也须合并 modelOverrides 安全用户层，避免管理页与 Composer 不一致。内置 provider 首次建立覆盖需显式确认；OAuth 的选择/排序只写 GUI metadata，不创建空 provider；需要改内置模型参数时，只增受限 modelOverrides，不改 OAuth 身份或认证配置。

### 配置事务和 Runtime 生效

- 当前 reader 把损坏 JSON 当空配置、writer 使用 PID 临时文件/rename，均不能作为安全编辑合同。新仓储区分不存在、损坏、拒绝访问、schema 不支持；后三者只读并阻止写入。锁内重读、核对 revision 和文件身份，检查链接/reparse/目录替换，受控临时文件 flush+rename；保留顶层和未编辑对象的未知字段，不将它们投影到网页。浏览器提交的未知字段拒绝，不与“保留磁盘未知字段”混为一谈。
- `models.json` 和 GUI metadata 跨文件不能声称一次 rename 原子完成。先受限备份并写事务日志，记录两份前后版本与阶段，完成两文件后才发布新 revision；重启遇中断先恢复/完成同一事务并核对摘要，不能盲目覆盖外部新改动。恢复冲突进入只读人工恢复状态。外部 Pi/编辑器不参与 GUI 锁，故 CAS/身份核对只能缩小竞争窗口，不能声称完全锁住其他程序；同时编辑时要求停写并重读。
- 事务日志/备份可能含原有秘密，只在受保护的配置目录保存，权限不宽于原文件，禁止入仓库/诊断/导出，设保留上限并在确认恢复完成后清理。没有可靠权限或安全恢复资格则拒绝新写入；不以“自动备份”掩盖秘密副本风险。
- 保存完成先显示 saved；对所有活跃 Classic/Runtime 排队同步到同一 revision。忙碌、审批、候选任务、更新/安装期间延后；同步不得调用 `closeAll()` 清 Runtime、不得清 Composer/线程、不用不明 `--continue` 换会话。空闲时以已确认 sessionFile/owner/launch identity 恢复该 Runtime，再分别回读 state/models/thinking；身份不明则 pending 并提示，失败可重试。
- 同步用 Runtime identity/epoch 与 revision 去重，项目切换/退出后旧结果失效。尚未同步的 Runtime 保留旧配置事实；新 Runtime 使用最新已提交配置。配置变更导致当前模型不可用时提示用户选择，不自动改模型或思考档位。OAuth 登录/退出的原有同步也必须使用这一协调器，不能只修新 CRUD 路径。

## 7. 前端源码映射与实施边界

| 文件 | 现有职责与计划改动 |
| --- | --- |
| `public/providers.js` | 保留对外入口与列表加载兼容；移出旧按钮预设/文本框 dialog，接新组件；不再调用 `reloadPi()` 清线程 |
| **新增** `public/provider-management/catalog.js` | 目录展示/别名与 capability 合并的纯函数；目录事实由后端快照提供 |
| **新增** `public/provider-management/state.js` | 唯一非秘密草稿 reducer：models/selection/order/dirty、revision、dialog generation、operationId；无 localStorage 草稿 |
| **新增** `public/provider-management/dialog.js`、`service-chooser.js`、`connection-fields.js`、`model-panes.js`、`advanced.js` | §4 的固定壳、视图与可销毁监听；请求只经 API 模块 |
| `public/provider-auth.js` | 保留全局 flow/轮询/安全URL；拆出按 provider 挂载视图，不创建第二个认证 owner，不把 secret prompt 转普通输入 |
| `public/api.js` | Codex 先提供 §6 的方法和合同 fixture；保留旧导出，不把 request 与当前聊天 owner 错绑 |
| **新增** `public/provider-management.css`；`public/tokens.css` / `public/styles.css` | 局部样式用已有 token；只移除已替代的 provider 旧样式，避免影响其他 modal/表单；接现有静态资源打包入口 |
| `public/ui/settings-surface.js`、`public/app.js`、`public/ui/modal.js` | 复用现有 Settings/Modal 生命周期；主设置列表仍用 presentDetail，子配置明确 openModal，接共享脏退出和焦点恢复 |
| **新增** `public/provider-management/model-visibility.js`；`public/ui3-model-picker.js`、`public/runtime-models.js` 调用边界 | 同一纯投影处理 GUI selection/order；不改 RPC 数据源、不污染 thinkingAvailability 的三值/owner 隔离 |
| `server/providers.js`、`lib/models-api.js` | 转无损仓储、复用模型归一化，接安全网络 transport；不简单放宽原文 validator |
| `server/provider-auth.js`、`server/provider-auth-sdk.js`、`server/provider-auth-runtime.js` | 延用 Pi/worker；新增最小私有 discovery 能力时审计输出；复用安全同步协调器 |
| `server/router.js`、`server.js` | 接应用级管理路由与正确优先级、依赖注入、生命周期和关机取消；移除受影响的破坏性同步接线 |

## 8. 兼容、回滚与已知限制

- 不自动修改用户真实配置；首次显式保存才创建 metadata。已有 provider ID、模型 ID、key/header/command、未知扩展和其他 provider 保留；不从 GET 安全投影重建整份磁盘配置。未支持的旧协议标只读，不默默改成 openai-completions 后保存。
- 数据 feature flag 为后端装配时的 `providerManagementEnabled`（默认切换须完成验收）；关闭后旧入口仍读取同一兼容 Pi 配置。metadata 只增加独立 GUI 文件，不写 Pi session schema。旧客户端写入也走新仓储；若无 revision，则锁内基于最新数据执行其受限操作并保守拒绝危险编辑，不能绕过 Endpoint 凭据绑定。
- 代码回滚：关闭开关/回退行为提交；metadata 保留但旧版忽略。数据回滚：先停止所有写入及同步，核对当前文件与对应事务版本；仅在一致时恢复受保护备份，否则展示冲突并保留双方。撤销 GUI 选择不回滚 OAuth token，logout 后不能靠配置备份恢复 token；必须重新登录。
- 无模型列表端点、订阅缺失公开协议、SDK 缺失时，保留离线目录/手动模型/官方登录说明，明确 unsupported。参考供应商不在当前 Pi descriptor 中时不实现私有 OAuth、额度、订阅计费或 host API。
- 高级客户端证书、任意 headers、定制 reasoning wire 参数、代理/证书跳过、自建 secret store、跨账号 OAuth 克隆、删除 Pi 内置目录、自动付费推理测试均不纳入本次范围。已有磁盘字段保留；只有经 Pi 公开配置支持并验证的字段可后续扩展，不以 UI 开关假装支持。
- 参考的多 OAuth 账户管理不移植：本项目按 Pi 每 provider 的原生凭据身份管理，不自建账户 UUID/secret namespace；plugin-owned provider/Jev classifier 不作为可编辑服务移植，缺少本项目相应 owner/运行时合同。参考的 availableForSubagents、nativeWebSearch、fastModeAllowed、图像生成绑定、document input、自定义 thinkingProtocol/defaultThinkingLevel 也不设假开关：它们依赖参考 sidecar/wire/计费能力，当前白名单或已验证 Pi 接口不能保证生效；保留既有磁盘扩展，界面显示兼容性说明。
- 主要剩余风险：外部进程同时编辑配置；跨文件恢复；Pi 版本/SDK 行为漂移；私有地址与凭据转发；环境凭据可被 Pi 工具继承读取；真实 OAuth/远端发现依赖供应商。不得承诺工具输出通用秘密消毒，参见 [security.md](security.md) 的既有信任边界。

## 9. 开发顺序、Codex / DeepSeek 任务边界

后续执行按任务逐项验证，遵循 [AGENTS.md](../AGENTS.md)、[REVIEW.md](../REVIEW.md) 和 [testing.md](testing.md#测试执行政策)。本次只提交本计划，以下复选框均未执行。

| 顺序 | 负责人 / 文件边界 | 交付与依赖、完成门槛 |
| --- | --- | --- |
| P0 | Codex：合同、目录、安全用例；`public/api.js` 与后端 fixture | 冻结 §3–6 DTO、能力三值/错误码、数据 schema、原图比例。先给 DS 非秘密 fixture，fixture 不得冒充联网成功 |
| P1 | Codex：`server/provider-config-store.js`、`server/providers.js`、新增仓储测试 | 先写损坏/冲突/未知字段/权限/崩溃回归，再做无损存储、CAS、双文件恢复与 clone/delete；离线故障注入及独立安全审查通过后进入 P2 |
| P2 | Codex：新 network policy/transport、`lib/models-api.js`、私有 worker | DNS/IP/redirect/流式限额/总时限、凭据绑定、取消及最小输出；零秘密泄漏，失败时不自动换目标。高风险审批另行完成 |
| P3 | Codex：管理 routes/operations/sync、`server.js`/`router.js`、Auth 集成 | 完整 §6 HTTP 接口、应用级鉴权、所有 Runtime 延后同步和回读；不关闭运行中会话；合同可用后交 DS 真 API |
| P4 | DeepSeek（DS）：§7 新前端组件与局部 CSS | 可以在 P0 fixture 上制作**一次到位的完整布局及全部状态**；只使用冻结 DTO、API 和能力，P3 后换真实接口。不得改服务端、凭据校验、OAuth 协议、Pi 配置写入、RPC owner 或同步逻辑 |
| P5 | Codex 集成；DS 修 UI | 接两 picker 的 selection 投影、真实 Auth/operation、打包资源；核对业务全链，再做主题/窄窗/键盘/原生 Browser 实测。修复按增量收敛 |
| P6 | Codex 验证与独立功能/安全审查；用户验收 | 完整 canonical + 重建产物 + 专项与视觉证据；用户明确决定是否接受高风险实现/合并。推送、合并、发版分别授权 |

依赖为 `P0 → P1 → P2 → P3 → P5 → P6`，`P0 → P4 → P5`；P4 提前并行仅针对冻结合同和完整布局，不能越过 P1–P3 自接密钥或伪造同步。若底层 capability 未具备，固定区域显示禁用原因，不删除区域后等功能再改主要布局。

## 10. 测试与视觉验收

- **已有定向入口**：`npm run test:models`、`npm run test:auth`、`node tests/provider-auth-runtime.cjs`、`node tests/model-capabilities.cjs`、`node tests/thinking-availability.cjs`、`node tests/settings-acceptance.cjs`、`node tests/runtime-models.cjs`、`node tests/server-security.cjs`。实施时记录实测通过/失败/skip 数量，不沿用历史数字。
- **新增离线套件**：`tests/provider-config-store.cjs`（无损合并/CAS/损坏/链接/权限/双文件崩溃恢复/复制）、`tests/provider-management-http.cjs`（DTO/应用鉴权/操作幂等/Endpoint授权）、`tests/provider-network-policy.cjs`（注入 DNS/transport，私网、redirect、TLS、流式上限/取消、恶意模型字段）、`tests/provider-config-sync.cjs`（Classic+多Runtime/忙碌/身份漂移/重试）、`tests/provider-management-ui.cjs`（选择 reducer/来源/焦点/迟到结果/无秘密）。用真实上游文档形状造 fake Pi/SDK；全部注册进 `package.json` canonical，不能另抄 CI 清单。
- 测试所有写入都在 `os.tmpdir()`，不使用真 Pi、真 key、真实配置或真实项目做写操作；网络仅 fixture 本地假供应商。以唯一假 secret 哨兵验证 response/SSE/DOM/日志/诊断/metadata 均不含值；不能靠删断言或 skip 安全用例通过。
- 功能稳定后完成一次本地 `npm test`，或用户预先选定当前 PR 的完整 CI；结果前标待验证。完整 canonical 不替代独立安全审查与故障注入；改 `public/`/`server/` 后按既有流程重建 App/EXE，再分别验证源码与产物。
- **下一阶段视觉矩阵**：用户原图相同比例窗口、1280×800、940/760px 宽、480px 宽，深浅两主题；chooser 四列/降列、长服务名、DeepSeek 双栏、长模型 ID、0/2/3000 模型、OAuth 设备码/授权回复、loading/empty/error/disabled/saved-pending/conflict 各状态，100%及150%系统缩放。宽窗壳/双栏比例对原图，主题色对 tokens；不要求复现样本模型名/凭据原文。
- 真实 Electron 正常沙箱验证：搜索/多选/排序/高级/取消/保存/刷新、Tab 环、IME、Esc 层级、重开 Auth、Runtime 任务不丢、Browser 原生视图被 modal 正确遮挡。提供少量代表截图与几何测量，不能用 jsdom 文本通过冒充布局通过。
- 连接测试只证明对应列表/网络事实；真实登录、模型推理、真实 Pi 版本资格和生产恢复各自列证据与未验证项。真实外部调用需该阶段明确授权，不在自动离线验证中发生。

## 11. 本次文档交付与验收记录

范围仅本文件；无产品行为变化、无生产源码/依赖/测试入口/版本变更。未运行本地完整测试、模型/登录、构建或视觉截图：原因是文档设计阶段，用户明确排除不必要全测及新增截图，符合测试政策的纯文档例外。

本次检查为源代码调用链、固定参考许可、基线 CI、文档链接/功能覆盖及 diff 空白检查；17 个本地链接均存在，表格列数一致，无待补占位项。独立源码审查指出的账户组件职责、参考专属能力排除、模型覆盖 DTO 和本地无认证注册适配均已修订；底层增量复审未发现新增阻断或重要问题。上述结果不能当成接口或安全方案已通过产品验证。交付提交可用 `git log -1 --format=%H -- docs/provider-management-rebuild-plan.md` 定位。回滚仅回退该文档提交，不涉及用户数据。

结论：**设计交付后等待用户验收**；生产实现尚未开始，代码验收/高风险实现批准/推送/合并/发布均未取得。接受本方案后，冻结的壳和完整状态足以让 DS 一次完成最终 UI；网页原文 key 输入等 §5/8 排除项必须保持明确，不能在实施中悄悄补成不安全能力。

### 源码索引

- 本地入口：[前端供应商](../public/providers.js)、[前端认证](../public/provider-auth.js)、[HTTP client](../public/api.js)、[Settings 生命周期](../public/ui/settings-surface.js)、[服务端配置](../server/providers.js)、[Auth flow](../server/provider-auth.js)、[SDK worker](../server/provider-auth-sdk.js)、[Auth adapter](../server/provider-auth-runtime.js)、[模型协议](../lib/models-api.js)、[路由](../server/router.js)、[装配/同步](../server.js)。
- 固定参考：[settings 组件目录](https://github.com/vastsa/PI-Desktop/tree/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings)、[providers.css](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/providers.css)、[model-config.css](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/model-config.css)、[service-setup.css](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/service-setup.css)、[API](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/lib/api.ts)、[IPC](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/electron/main/ipc/provider-ipc.ts)、[host providers](https://github.com/vastsa/PI-Desktop/tree/92ae661f1e399e69d514086b46029b4c34ba1a92/crates/host-core/src/providers)、[secret 实现](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/crates/host-core/src/secrets.rs)。
