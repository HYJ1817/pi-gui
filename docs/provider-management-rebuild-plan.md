# 供应商管理重构：设计与实施方案

状态：**最终整改版，待用户验收；不是实施授权或已实现功能**。审查日期：2026-11-07。

目标：用原生 ESM/DOM 实现 PI-Desktop 风格的完整服务管理；先冻结功能、布局和接口，再分工开发。不引入 React、依赖或新模型运行时，不修改 Pi，不改变无关业务。

## 1. 勘察结论与证据范围

- pi-GUI 生产源码基线：`750dee491ae0a0b3b499916b014e161f46ef6f75`，fetch 后 `origin/main` 未变化；本次整改起点为仅含首版设计的 `279af4c92e2b73e2fcbc78fca93e5d6a9dd33af0`，起始工作区干净。最新 Release 为 [v0.32.0](https://github.com/HYJ1817/pi-gui/releases/tag/v0.32.0)。沿用独立设计分支 `codex/provider-management-rebuild-plan`。
- 准确基线 [CI 42236631542](https://github.com/HYJ1817/pi-gui/actions/runs/42236631542)：push、attempt 1，完整计划、五组测试、Electron build check、CI gate 均 success。它只证明基线，不证明未来重构。
- 参考限定为 [PI-Desktop 92ae661f1e399e69d514086b46029b4c34ba1a92](https://github.com/vastsa/PI-Desktop/tree/92ae661f1e399e69d514086b46029b4c34ba1a92)，不跟随 main。第 2 节列出的组件及其 IPC、存储调用边界均按该提交审查。
- 视觉依据为用户原图 `Snipaste_2026-10-31_23-56-39.png`、`Snipaste_2026-10-31_23-57-32.png`（均 1808×1205，用户本地 `OneDrive/图片/pi-desktop/`）。本次直接查看原图，没有生成或增加测试截图。图中模型名称、容量及供应商条目只作视觉样本，不当作当前能力或推荐目录。
- 本机通过 `server/pi-launch.js` 的纯文件解析定位到 Pi 包 **1.5.0**，只读其 `docs/models-configuration.md`、公开类型与 `dist/core/provider-composer.js`，没有启动 Pi 或模型调用。这是配置语义证据，不是运行中 Pi 身份或新版完整兼容资格；仓库旧文档的 1.0.0 不能替代实际能力探测。

**保留的抽象**：`server/providers.js` 的安全投影与模型字段清洗、`lib/models-api.js` 的协议归一化、P25 私有 Auth worker 与 flow、统一 launch identity、RPC 模型/思考档位回读、Settings surface 生命周期、modal 的焦点/取消出口及 `public/tokens.css`。

**最终整改决定**：①Electron 正式纳入应用内 API Key 输入：截图右上区域打开预先设计的独立受限输入窗，经私有 IPC 与 Pi SDK 暂存/保存；普通主页面和 Web 仍不收原文；②首次授权精确目标后自动发现，编辑先显示缓存，再按有效授权刷新；③参考数据库/secret store 不移植，Pi 配置与原生凭据仍由各自 owner 管理；④内置模型未选只影响 GUI 候选，宽窗四列/窄窗降列；⑤同步保护全部 Runtime。专用输入 renderer 的狭窄例外及非加密持久化风险须经本方案验收及 P0–P3 验证，不能把整改文字视为已经解除现行安全限制。

实现路线比较：直接翻译参考全栈会引入 React、专有 host 与密钥库；只换皮现有表单无法满足编辑、选择持久化与安全同步；**采用原生组件 + 现有协议适配 + 有版本的配置事务/GUI 元数据**。下述功能和接口构成选定方案。

## 2. 参考源码、许可证与功能差异

参考路径前缀为 `apps/desktop/src/`；下表是源码行为，不代表 pi-GUI 已具备。

| 参考组件 | 实际职责、状态和交互 | 依赖及 pi-GUI 映射 |
| --- | --- | --- |
| `components/settings/ServiceChooser.tsx` | 本地 query 搜索名称/别名/地址；订阅和 API Key 分组，另有 plugin/Jev 条目；Enter/方向键导航，点卡片回调父级，不联网 | `service-catalog.ts` 与父级 OAuth descriptor，映射新 chooser；能力可用性由 Pi descriptor 决定 |
| `ProviderSetupDialog.tsx` | 新增/编辑草稿，服务切换，连接字段，模型及高级配置；保存前聚合、校验，编辑空 secret 表示保留 | `lib/api.ts` 的 create/update/list models；映射单个原生 dialog controller |
| `ServiceList.tsx` / `ServiceRow.tsx` | 列表组织、状态与模型信息、编辑/复制/删除等行操作和顺序交互 | provider store/API 负责持久化；映射 Settings 服务列表，不能让 DOM 成为配置真值 |
| `ProviderConnectionFields.tsx` | API 服务名称、Endpoint/API 风格、密码框；预设 chip 可更换，自定义 URL blur 规范化/校验；值由父级持有 | 本项目保持字段位置；主页面是固定遮罩触发器，真实输入位于独立受限 renderer，不复制参考主页面秘密流 |
| `ModelSelectionPanes.tsx` | 左侧来源模型搜索/勾选，右侧已选模型搜索、顺序、移除、单模型高级配置；底部自定义 ID | 父级模型草稿及 callbacks；映射双栏纯视图和选择 reducer |
| `useProviderModels.ts` | idle/loading/ready/error，cache/remote/catalog/fallback 来源；输入防抖 600ms，编辑先缓存再 live、手刷跳缓存，requestSeq 丢弃旧请求 | 本项目在此基础上加精确授权、真实 Abort 和服务端缓存写入隔离；参考只清 timer/丢旧回复，没有证明真实取消 |
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
| API Key/OAuth | renderer key + secret 后端；vendor login | P25 OAuth 完整 flow；API Key HTTP 写入只允许 env 引用 | OAuth 复用；Electron 新增隔离输入 + 原生 SDK，HTTP/Web 限制保留，见 §5 |
| 配置 CRUD/复制 | 有仓储及对应操作 | GET、POST upsert、DELETE 可用；界面只新增/删除，没有完整编辑/复制 | 先补无损编辑/CAS/安全复制，再做行操作 |
| 自动发现/刷新 | remote + catalog/fallback | `/api/providers/models` → `fetchModels` 支持四类协议；仅请求时传 env 引用，不自动用已存 key/headers | 复用解析，补来源凭据绑定、网络策略和可取消操作 |
| 搜索/多选/添加 | 双栏实时选择 | 已有拉取面板、搜索、全选、去重追加到文本框 | 复用语义，改为结构化双栏；补排序及持久化 |
| 手动模型/高级参数 | 有 UI 和配置 | `parseModelLine`、server 白名单支持 contextWindow/maxTokens/reasoning/input/capabilities | 底层大部分已有；新增表单及内置 modelOverrides 的受限写入 |
| 连接测试 | 专门操作及反馈 | 模型拉取不能证明推理有效；没有独立测试合同 | 新增分级证据接口，不自动调用付费模型 |
| Pi 同步 | 参考 host 自有运行时消费配置 | 自定义配置保存只提示重载；`reloadPi()` 走 restart 并清线程；P25 sync 会关闭独立 Runtime | 新增逐 Runtime 的安全同步，保存与生效分开 |
| 主题/响应式/键盘 | 参考 CSS/组件提供 | 现有 tokens、modal、Settings 生命周期可复用 | 固定最终壳，补各状态、筛选/排序与焦点规则 |

## 3. 最终功能、状态所有者与验收入口

记号：**C**=现有配置 `/api/providers`；**A**=现有 `/api/provider-auth` 系列；**M**=§6 新管理 API；**D**=新增 Electron 专属凭据 IPC；**R**=既有 RPC 回读。所有新能力是实施计划，不是假定接口已存在。

| 功能 | 状态所有者与现有可复用点 | 必须增加/调整 | 主要验证 |
| --- | --- | --- | --- |
| 1 搜索式服务选择 | 前端 dialog 的 query/category；九个预设、A descriptor | M 目录统一 serviceId、providerId、authMode，中文/英文/域名别名 | 搜索和分类交集、空结果、同厂商 API/OAuth 区分 |
| 2 订阅/API Key 分类 | A 的 methods/isSubscription；目录只提供展示 | 不支持的订阅禁用并说明；OpenAI 同厂商多认证方式去重展示 | 缺 SDK/未知/不支持三值，不虚构登录按钮 |
| 3 预设/自定义 Endpoint | 草稿持有；C 四种 API 类型 | 受限协议选择；变更目标使测试失效，并触发凭据重新绑定规则 | URL/协议校验、旧配置仍可读取 |
| 4 API Key 输入/保存 | 专用输入窗短暂持值，私有 worker 暂存；Pi SDK 管原生持久化 | D 的输入/替换/清除、内存草稿、主保存落盘及安全回读；Web 保留 env/官方终端 | 原文仅在受限秘密链路内；普通 DOM、HTTP/SSE、日志/诊断/GUI草稿零原文 |
| 5 OAuth | A 单用户 flow，worker/Pi 管 PKCE/token/刷新 | 支持按 provider 挂载同一个 flow；与服务配置取消分开 | prompt ID/flow generation/revision、重开续接、超时取消 |
| 6 自动发现/刷新 | 服务端 consent/draft/cache/operation；前端 debounce/requestSeq | 首次明确授权后自动发现；编辑先缓存，600ms防抖、真实取消、手刷跳TTL；目标/凭据变化重授权 | 未授权零请求、缓存首屏、旧结果不写缓存、失败留已选、不发推理 |
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
- Pi `models.json` 仍是注册配置真值，`auth.json` 仅 Pi 管理。**新增** `DATA_DIR/provider-management.json`（schemaVersion 1）只存 `serviceId/providerId/catalogId/displayName/enabled/selectedModelIds/modelOrder` 等非秘密偏好，无 key/header/token；记住的发现授权仅存规范化目标/路径策略及非秘密身份，启动后仍须重新验证，不能持久化可直接使用的 consentId。独立发现缓存也不存 secret。无 sidecar 时默认保留原候选，不启动即迁移。
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
      ├─ ConnectionRow：服务/地址/更换       固定遮罩/输入更新清除 或 OAuth
      ├─ CredentialSheet：独立受限子窗口（预定义，非主页面 DOM）
      ├─ StatusStrip：目标授权 | 自动发现 | 测试 | 凭据/保存/同步反馈
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
- 已有服务若绑定任意native/env/literal/command/header或不透明认证，规范化Endpoint/API类型不能原地跨目标修改；高级页将该目标字段锁定并提供“复制到新 Endpoint”。复制分配新providerId、清凭据，旧服务不变；随后在新目标输入/授权新key。仅能证明完全无认证的服务可原地修改。此限制同时保护后续Pi聊天，不仅保护模型发现。
- 凭据区保持图二位置与高度：Electron 的“API 密钥”字段外观为固定长度遮罩/“点击输入”，旁边“输入/更新/清除”；它是可聚焦触发器，不是主页面真实 password input。显示“未配置 / 已暂存，保存服务后生效 / Pi 本机已保存 / 未知”。旧 key 不回填，不显示长度或后四位。env 模式仍可填 `$NAME`。OAuth 同区展示原生 flow；认证区域与两栏几何不变。
- **CredentialSheet 已纳入最终 UI**：父窗口居中 modal child，宽 `min(460px,父窗口内容宽度-32px)`、内容决定高度约 280–360px、内边距20、相同主题/圆角。固定显示真实 provider 与完整授权目标、password input、可选“允许向此目标发送密钥以自动读取模型列表”（默认未勾选）、“应用到草稿 / 取消”。真实输入仅在这里；应用后立即关闭/清 DOM，主页面只收到 staged 状态。编辑支持重新输入替换、明确确认清除；空输入=不变。输入窗取消不抹除原已暂存值；主表单取消销毁全部暂存。清除/替换已有 OAuth 同一槽位时必须在此窗显示影响并再次确认。
- 中间状态条预留授权/发现反馈：首次授权完整目标、认证来源和“只读模型目录，不调用推理”；可“允许并自动获取”，可记住该服务目标，也可稍后/撤销。已在输入窗勾选时不重复确认，应用密钥后 600ms 自动发现；Web/env/已有凭据在状态条同样授权。首次无授权只显示缓存/离线目录。允许之后按 §5 的授权边界自动刷新，无需每次点“获取列表”；按钮改为“刷新列表”。选择服务或主表单保存都不构成隐式目标授权。
- 下方左右 **1:1** 双栏、深色 inset 背景、圆角 10px，充满剩余高度。左栏头部为混合勾选框、“该服务的模型”、“刷新列表”和搜索；右栏头部为“模型设置 N”和独立搜索。首次未授权时刷新入口引导状态条授权，不能悄悄发请求。主内容独立滚动，header 不随滚动消失；右栏底部自定义输入/添加始终可达。
- 左模型行：复选框、等宽 ID、可选显示名、右侧上下文/输出简写；缺数值显示“未知”，完整数值/来源可查看。右行：拖动把手、ID、容量、“高级”、移除。推荐自动选择仅用于新建、可信能力明确的首次结果，最多 3 个；展示原因，任何勾选/移除/排序/手动添加后停止自动选择。编辑不自动推荐，刷新不重置既有选择。
- 筛选不删除选择；左表头全选只作用于可见结果。右表筛选时禁用拖动排序并说明，键盘上/下移也只在完整列表执行。先确定 ID 唯一性再添加；手动项标记来源，未发现不等于不可用。
- “更换服务”回 chooser；脏草稿先确认。确认后清旧来源、推荐资格、凭据绑定、网络许可和操作，模型草稿不跨服务搬运；取消确认则原样保留。编辑的 providerId 固定，跨身份更换使用“复制为新服务”。

### 高级设置、状态、主题与键盘

- 服务高级页固定字段：显示名、只读/新建可填 providerId、Endpoint、四种 API 类型、认证模式/env 引用；底部只读兼容性/保留隐藏字段提示。任意 header、`!command`、token 注入不设 UI 编辑器。
- 模型高级页：ID（创建后固定）、显示名、contextWindow、maxTokens、reasoning“继承/支持/不支持”、input text/image；toolCalling/streaming 以三值只读并标来源。选择“继承”显式清除该字段的既有用户覆盖，未修改字段保持原样；有效值未知时显示未知。正整数 ≤ `Number.MAX_SAFE_INTEGER`，maxTokens 大于已知 contextWindow 时阻止保存并解释。这些是声明元数据，不是对远端能力的保证；Pi 实际 thinking levels 仍由原 RPC 回读，不提供凭模型名猜出的档位。
- 主壳状态闭集：`loading / ready / empty / discovering / testing / saving / saved-pending-sync / saved-credential-error / credential-unconfirmed / syncing / success / conflict / error / unsupported / disabled`；凭据子状态 `none / editing / staged / persisting / saved / clear-staged / cleared / expired`；发现子状态见 §5.3。各操作独立busy；失败保留模型/草稿，409要求重读对比；同步失败“已保存，尚未生效”。success只表示对应事实，不笼统显示“已连接”。
- 保存条件为字段有效且没有在途保存；无需发现成功或在线才可保存。保存先冻结选择并取消发现；存盘期间暂停退出/重复提交。凭据暂存不等于保存，主保存调用 Pi 原生落盘；状态区分别显示“配置已保存 / 密钥保存中或失败 / 待同步”，失败保留可重试界面。关闭时 Abort 真实网络并令 dialog generation 失效；结果不确定先查安全状态，不盲目重发或声称已回滚。
- 深色使用现有 `--ds-bg-tertiary` 壳、`--ds-bg-inset` 列表、`--ds-field-inset-bg` 输入、`--ds-text-*` 和白色主按钮；浅色使用同名语义 tokens，列表为浅 inset、深色文字/主按钮。聚焦、hover、选中、禁用、错误都用现有 tokens；不在全局修改 `.field/.modal-card` 来凑布局。
- 视口 <940px 时配置主体上下堆叠，连接区也单列；候选/已选各至少 200px，可通过锚点跳转，右底部添加不遮列表。<720px 工具栏换行；<480px 壳距边 8px，顶部动作换成两行，行内元信息可换行，主操作至少 32px 点击区。低高度 <600px 允许主体整体滚动，标题/保存固定，不能强行保持两栏造成不可达。
- modal `aria-labelledby/aria-modal`、Tab 圈定和返回原触发器复用现有实现；chooser 初始焦点搜索，setup 初始焦点服务标题/首个需填字段。Tab/Shift-Tab、原生复选框 Space、按钮 Enter、分类方向键；搜索输入 Enter 不隐式保存，中文 IME composition 不触发快捷键。排序提供可见上/下移动操作和 live region，不只支持拖拽。
- Esc 逐级退出秘密输入窗/高级/确认/主 dialog；秘密窗由 OS modal + 自有 Tab 环管理焦点，关闭回到右上凭据触发器，窄窗不改变双栏断点。脏退出确认；OAuth 关闭不自动取消全局 flow，API Key 草稿关闭则销毁。网络反馈 `role=status`、字段错误关联 `aria-describedby`，失败不抢焦点；移除模型后焦点落相邻行或添加框。输入窗不提供读旧key/复制旧key/显示明文按钮，允许用户粘贴但不主动读取/清空系统剪贴板。

## 5. API Key 与 OAuth 安全方案

### 5.1 已核实能力与政策变化

现行 `server/providers.js:91,190–191,271–272` 只允许 env 引用，`server/provider-auth-sdk.js:199–225` 拒 secret prompt，[security.md](security.md) / [provider-auth.md](provider-auth.md) 禁止秘密进入 renderer。这些**现行规则本次不改**。整改提出一个须验收的狭窄例外：**仅专用隔离凭据 renderer 可短暂接收用户正在输入的新 key**；普通应用 renderer、Web、HTTP、SSE、诊断和日志保持禁令。不能用 password 遮罩或 contextIsolation 声称同页脚本读不到 key，也不能把普通 OAuth `/respond` 扩展成秘密入口。

选择比较：主页面直接 inline 输入最像截图，但将 key 暴露给聊天/Markdown/扩展等同页脚本；外部终端保持原边界但操作差距大；**采用应用内独立受限 CredentialSheet + Pi 原生 SDK**，只多一次打开输入面的动作，主布局保持不变。不采用复杂的原生 WebContentsView 内嵌字段叠层，避免与现有 Browser 焦点/遮挡机制耦合。

已核实 Pi **1.5.0** 公开根 `ModelRuntime` 支持 `create({credentials,...})`、`registerProvider()`、`login(providerId,'api_key',interaction)`、`logout()`；API key 登录产生 `secret` prompt，返回 Credential 可能包含原文，必须在 worker 内丢弃/投影。`registerProvider` 可在 worker 内存注册未保存自定义服务，故不必为发现提前写用户 `models.json`。公开内存 CredentialStore 可用于草稿登录，默认 AuthStorage 用于最终持久化；不 import Pi 内部实现、不 monkey patch、不自行写 auth.json。

**官方存储的实际风险**：默认 AuthStorage 将 API Key 明文保存在 agentDir 的 `auth.json`，使用文件锁、创建时目录0700/文件0600；不是 OS vault，也没有加密或写文件原子替换保证。Windows mode 位不等于已验证 ACL，不能承诺既有宽权限自动修复。采用 SDK 是沿用 Pi 原生兼容与锁机制，并非消除磁盘明文风险。P1 必须在 TEMP 验证权限/故障与多凭据保留，异常只回固定错误；有存储安全阻断则禁用该能力，不悄悄改成 GUI 自建密钥库。

以下源码位置均相对本机已证明的 `@earendil-works/pi-coding-agent@1.5.0`；`pi-ai/` 指该安装内 `node_modules/@earendil-works/pi-ai/`，只调用其**根公开 export**，不从内部实现导入：

| 核查点 | 精确源码证据 | 结论 |
| --- | --- | --- |
| 原生方法与内存注入 | `dist/core/model-runtime.d.ts:4–7`；`.js:80–81,575–587,665–682`；`pi-ai/dist/index.js:3` | 支持CredentialStore注入/内存注册/login/logout；不是假SDK接口 |
| secret交互与持久化顺序 | `dist/core/provider-composer.js:244–259`；`pi-ai/dist/auth/helpers.js:7–15`、`pi-ai/dist/models.js:357–399` | API key走secret prompt；先store修改，再做运行时同步 |
| 存储/权限/锁/更新清除 | `dist/core/auth-storage.js:27–42,87–148,385–411` | 明文JSON、创建权限、proper-lockfile、原地write；一provider一个凭据，更新覆盖、logout只删目标 |
| 认证实际优先级 | `pi-ai/dist/auth/resolve.js:17–37`；`dist/core/provider-composer.js:260–301` | 显式请求override优先，其次stored credential，再ambient/env/config；清stored后其他来源仍可用，不能只据已删除显示disconnected |
| 原文特殊字符执行面 | `dist/core/auth-storage.js:373–383`；`dist/core/resolve-config-value.js:65–70,117–134` | 存储值会解析command/env；必须literal编码及读回等值验证 |
| 已存但同步失败/异常含秘密 | `dist/core/model-runtime.js:16–25,406–421` | `CredentialSynchronizationError.credential/cause`不得序列化；已保存与同步失败分开报告 |

研究用实际公开 SDK TEMP 探针最终 **19/19，exit 0，网络尝试0、子进程尝试0**，覆盖普通及特殊字符key、内存/持久化/取消/更新/重开/logout及同provider假OAuth替换；详见 §11。它支持“SDK层可行”结论，不证明新Electron通道已经安全。`allowModelNetwork:false` 只控制相应模型网络行为，不能替代对认证方法/真实网络入口的审查与拦截。

### 5.2 Electron 专用秘密链路与生命周期

调用链固定为 **CredentialSheet 专属 preload → Electron main → 当前直属 backend 的私有父子 IPC → 专用 credential worker → Pi 公开 SDK**。主应用 preload 仅开放“打开/取消输入面”和安全状态；不提供 `submitKey`、通用 invoke、文件路径、任意模块/命令/URL、取回旧 key。`electron/main.cjs:190–213` 已有第4项 IPC，`electron/app-update-desktop.cjs:37–48` / `server.js:1251–1264` 证明可复用传输机制，但必须新增独立具名消息类，不能借 app-update payload 扩权。

- **准备**：backend 根据已校验的 draftId/draftRevision 解析 provider、规范化 Endpoint、API 类型、维护互斥和权威 launch identity；经私有握手给 main 安全摘要/epoch。另维护 `connectionRevision`：只有 provider/目标/协议/认证来源变化才递增，模型编辑不使已输入key失效。main 核验普通调用方是当前主窗对象的顶层 frame、精确应用 URL；输入面展示的目标摘要来自 backend，不信任主页面文字。
- **输入隔离**：新 modal child BrowserWindow 使用独立非持久化 partition、固定打包本地文档/专属 preload；显式 `contextIsolation:true,sandbox:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,webviewTag:false,webSecurity:true,devTools:false,spellcheck:false`。CSP 默认拒绝，仅允许固定本地资源；禁止网络、导航、子框架、弹窗、权限、下载、service worker、storage 与控制台采集。不共享 defaultSession/token 注入或 Browser partition，不进入 Browser/Runtime/agent registry。全局 guard 对此 session 采用 deny-all，不交 `shell.openExternal`。
- **提交守卫**：main 同时验证这次窗口对象/webContents、senderFrame 为该 mainFrame、精确固定 URL、一次性随机 nonce、flow/prompt ID、draft/credential revision、TTL 和单飞状态。秘密预加载仅有具名 submit/cancel/status；backend 重验其独立绑定，拒陈旧/重放/未知字段。原文长度 1–8192 UTF-8字节、拒NUL/换行；不将输入拼进 URL、argv、环境、错误或回执。
- **草稿**：输入窗“应用到草稿”仅在专用 worker 的内存 CredentialStore 调 `login(...,'api_key')`，只允许已审查的 secret 交互，不把任意 SDK prompt/URL 发到普通页面；成功后原文不回传，backend 只保留绑定 draft/目标/身份/TTL 的内部 handle。主页面收到 `credentialState:staged` 和不含值的 generation。暂存 TTL 15分钟，单次输入 nonce 2分钟；换服务、目标/身份变化、关闭主表单或超时销毁暂存并中止发现。输入窗自身取消保留上一份有效暂存，不把空输入当清除。
- **保存/更新**：主“保存服务”携带非秘密 draft/revision，backend 消费已绑定暂存；配置无损保存后，在默认 AuthStorage runtime 经原生 `login` 落盘，prompt由worker内存值应答。**原文按官方literal语法编码**：每个 `$` 变 `$$`，原始开头`!`变`$!`；内存阶段仍用原文。官方存储会解释`!command/$ENV`，故不可原样持久化。落盘后通过下述一次性公开快照/literal-only解码回读，与暂存值私有比较（需要SDK认证组合时注入安全内存store），不调用默认存储的 `getAuth` 二次解释。native Credential/编码不出worker；SDK/编码未验证则禁用，不放宽HTTP validator。
- **清除**：输入面明确确认“移除 Pi 已保存的该 provider 凭据”，生成只绑定本草稿的待清除动作；主保存时按 expected credential type/revision 再查后调用公开 `logout`。不连带清 env/models.json 引用；若希望去掉配置引用，走单独 `credentialAction:none`。同 provider API key 与 OAuth 共用原生凭据槽，替换/清除可能移除原 OAuth，必须在受限窗确认；不能当作多账号存储，也不自动以备份恢复 token。
- **原生并发限制**：SDK的 `logout → AuthStorage.delete(provider)` 没有expected-type/revision CAS参数（`model-runtime.js:583–587`、`auth-storage.js:403–411`）。上述预查只能拦截已观察的冲突，不是锁内原子条件删除；login更新同样没有GUI级expected CAS。GUI串行自己的OAuth/key/clear操作、提交前重读，发生外部变化即失效并重新确认；用户应停止同provider的外部Pi认证操作再更新/清除，受限确认窗说明此限制。外部进程在预查后变更仍有竞争窗口，不能宣称nonce/revision解决跨进程CAS；不为此自行写auth.json或导入内部store。
- **取消与部分失败**：主保存前取消只销毁内存草稿，没有 auth.json 副作用。主保存后的配置事务与 Pi 原生凭据写入是不同提交，不能承诺三文件全原子；确定未落盘失败为 `saved-credential-error`，不自动移除原凭据、不宣布新凭据生效。Pi 的 `CredentialSynchronizationError` 表示原生凭据可能已保存但后续 availability 同步失败，且异常的 `credential/cause` 可含原文；必须在 worker 分类并回读为“凭据已保存，待同步”，绝不序列化异常/重放 login。无法判定则 `credential-unconfirmed`，要求确认/重新输入。native 故障不能保证保留旧文件，不自行写秘密恢复日志，也不把取消说成撤销落盘。

**保存目标隔离是硬约束**：凡旧服务存在任何认证来源或无法证明无认证，跨规范化Endpoint/API类型修改必须走**新providerId的无凭据复制**，即使已输入另一把staged key也不允许原地改旧ID。新ID在prepare及commit前核对没有原生凭据；若已存在或来源未知则拒绝并换ID。否则“先新Endpoint落盘、再存新key”失败时，新Runtime/外部Pi会把旧native key发到新目标，停旧Runtime同步并不能防住。发现consent也不构成后续聊天的凭据改绑许可。新接口、旧POST兼容路径、无revision写入均走同一检查；不透明headers/认证扩展不复制。认证来源切换而目标不变仍须受限窗确认同槽替换影响。

**内存/系统风险如实保留**：key 会短暂存在于专用 renderer、IPC structured clone、main/backend 转发和 worker 内存；销毁窗口、清 DOM/丢引用/短 TTL 只能缩短暴露，不能保证 JS 字符串内存清零。同用户恶意程序、调试器、键盘记录、系统剪贴板或 OS 截屏不受此隔离保证。秘密窗口禁 DevTools、禁调试快捷键；remote-debugging、无沙箱或无法证明隔离环境时 `rawKeyInput:false`。可使用 content protection 尽力防截屏，但不能称跨平台绝对有效。

**泄露与环境防线**：新 key 不写 `process.env`、子进程 env、models.json、配置日志/事务收据、GUI cache、stdout/stderr、console、HTTP 或 SSE；主/后端日志和异常仅白名单固定 code，不能转发 SDK 原始 progress/error/interaction。`main.cjs:216–242` 会收集 backend stderr/stdout，因此此链路禁止原始输出。SDK worker 剥离 `PI_GUI_TOKEN` 及 GUI 私有桥凭据，原 OAuth worker 继续拒 secret prompt。已有父环境 Provider key 仍可能被 Pi/工具继承；新原生 key 不新增 env 继承，但 Pi 与其工具在同用户权限下仍可能读取 auth.json，不能宣称对工具构成秘密 sandbox。

存量native key的发现/回读采用**一次性安全快照**：根公开 `readStoredCredential`（`dist/index.js:6`、`auth-storage.js:424–431`）不解析地读指定provider，只在私有worker分类。开头`!`拒绝；普通literal及严格扫描解码`$$/$!`允许，任何未转义`$ENV`、未知结构或opaque headers均unsupported，提示重新输入或env模式。只使用这份快照交私有transport，或注入公开内存CredentialStore与 `modelsPath:null` 的安全provider runtime；**不能检查后再调默认getAuth重新读取/解析**，否则有换成command的TOCTOU。helper无锁且异常返undefined，须结合安全list/状态判断，未知不能当“肯定无凭据”。缺公开helper则降级，不能手读auth.json补能力；也不宣称防住同用户恶意程序或提供跨进程CAS。

**模式差异**：正常 Electron 且当前 backend 为自己的、已连通私有 IPC 子进程才可能启用；`main.cjs:164–182` 的 reused backend、Web、缺 SDK、异常调试环境均不启用原文输入，固定区域说明原因并提供 env/官方 Pi `/login`。不经 HTTP 回退传 key。env 引用仍只回名称/存在三值，旧 literal/command/header 后端原样保留不回显，`!command` 不由 GUI 执行。OAuth 继续 P25 flow/SDK，不复制参考协议。localhost/Ollama 新建仍用用户自行设置的非秘密 env 占位供 Pi 注册；发现不携带该占位头，缺配置不能宣称可聊天。

### 5.3 授权后的自动发现（冻结状态机）

1. **先显示后联网**：打开编辑立即呈现已配置/手动模型和匹配缓存；新建先离线目录。`unapproved → authorized-idle → debouncing(600ms) → refreshing → ready / empty / error-stale`；未授权、SDK能力不明或凭据未准备好不发请求。首次允许可以在 CredentialSheet 随“应用密钥”确认，或在主状态条“允许并自动获取”；只表示目录读取许可，不等于远端认证已验证。
2. **授权由服务端持有**：opaque consentId 绑定 `(draftId,connectionRevision,providerId,launchIdentity/epoch,scheme+host+port+完整basePath,API类型,受限候选路径策略,credentialSource,credentialGeneration)`，客户端 fingerprint 不是授权本身。Electron 使用已存/暂存 Pi key 的新授权或改绑必须经过独立输入/目标确认窗的可信动作，不能仅凭普通 HTTP `confirm:true`；Web 只允许 env/无认证发现，不把 Pi 已存秘密绑定到任意新目标。若选择记住目标，仅持久化非秘密批准描述；重开后核对目标、来源和不含值的凭据变更证据，再签15分钟grant，无法证明相同则重确认。旧配置不等于曾授权。
3. **自动/手刷触发**：有效授权且连接/凭据就绪时 600ms 后自动发现；编辑命中60秒缓存时先显示缓存，不重复发请求，过期后自动刷新。手刷绕过缓存TTL和防抖，但不绕授权；同服务单飞。搜索、勾选、排序、显示名不触发请求。新 key 在独立窗口一次提交后才产生新 generation，不按每个字符联网；输入窗对准确目标确认后直接签新授权，避免二次往返。Endpoint/端口/路径/API类型/服务/认证模式变化立即撤销旧授权/缓存适用性，不能防抖后沿用旧许可。
4. **取消与迟到隔离**：新请求、目标/凭据变化、关闭/撤销/保存时先取消旧 operation 的真实 transport（AbortSignal贯穿 worker/HTTP），再丢弃结果；前后端采纳与写 cache 前均核对 `(dialogGeneration,requestSeq,operationId,connectionRevision,targetFingerprint,credentialGeneration)`。模型选择/高级值改变不递增connectionRevision，来源结果仍可显示，但绝不能回写用户选择。后端取消须确认实际终止；旧请求不能改回 effectiveBaseUrl，也不能写新目标缓存。
5. **保留模型与推荐边界**：cache 按 provider+完整目标+API+凭据来源/不透明 generation 分区，不以裸 key/hash作客户端标识。失败/空列表/取消均保留右栏已配置/手动模型与高级参数，标“未在最新目录确认”；有效空列表与失败分开。旧凭据 cache 可作 stale 历史展示，不能当作新账号权益。推荐只对新建、未 touched 的首次可信结果最多3项；任何手动勾选/排序/删除/高级编辑后不再覆盖，保存时冻结草稿并失效在途发现。
6. **只读、有界、失败不风暴**：只允许协议适配器的模型目录 GET，不调用 chat/completions、responses、messages、generateContent 或工具。Google 只列表读取，不用生成接口探活。401/403停止自动尝试，凭据变化或用户重试才继续；429展示重试时间，不后台循环。最多8个授权内候选、总30秒、流式4MiB、3000模型；无定时轮询、不由模型自动重试。不产生推理调用，但不保证供应商对目录流量绝对免费。

安全 transport 是自动发现的前置：公共服务只 HTTPS，URL 禁凭据/query/hash，初版**拒绝所有重定向**，不跨源携带认证；DNS与实际连接地址绑定，拒私网/链路本地/元数据及IPv4映射IPv6绕过。localhost 仅显式授权 loopback 端口、无秘密发现；旧 HTTP/LAN 配置保留但不自动带凭据。候选路径逐一在授权策略内，不自动向父路径扩权。stored/暂存凭据只在私有 worker 中解析并发送；失败仅回固定错误与安全模型字段。HTTP 模型请求从不接原文，也不以网页传来的任意地址绑定已存 key。

所有 HTTP 管理接口仍过 token + Host/Origin，应用级路由在认证后精确接线；D 私有通道另验父子对象/epoch/消息schema/维护互斥，不把“非HTTP”当成无需鉴权。输入窗开通前必须完成 P0 政策例外验收，以及 P1–P3 离线专项和独立安全审查；否则仅保留能力禁用的同布局。

## 6. 后端接口与源码修改计划

### 现有合同（保留兼容入口）

| 路由 | 当前请求/响应和限制 | 重构处置 |
| --- | --- | --- |
| GET `/api/providers` | `{ok,path,exists,providers,keyStates}`；配置只投影 baseUrl/api/允许模型字段，无 key/header | 保留旧字段，转同一无损仓储；损坏读取不得继续伪装空配置 |
| POST `/api/providers` | `{name,config:{baseUrl,api,apiKey?,models}}`；同名 upsert，空 key 保留旧 key/headers | 新UI不用无版本upsert；旧入口同样拒绝携认证服务原地跨目标修改，不能因无revision/兼容而绕过 |
| DELETE `/api/providers/:name` | 删除配置，未做 GUI 模型同步 | 转同一事务；旧入口保留已有语义但不能绕过冲突/文件保护 |
| POST `/api/providers/models` | `{baseUrl,api,apiKey?}`；返回 models/source/keySource/tried，失败多为 HTTP 200 | 复用解析，补 transport；新 UI 使用 operation API，旧入口继续拒原文 |
| GET `/api/provider-auth`；POST `/login,/logout,/respond,/cancel,/sync` | descriptor/flow/sync；login `{providerId,authType:'oauth'}`；respond `{flowId,promptId,value}` | 保持 flow 合同；新增按 provider 展示，修正应用级路由和安全同步接线 |

### 新合同（命名在此冻结，DS 不自造请求）

统一错误 `{ok:false,code,message,retryable,fieldErrors?}`；只用固定文案。业务错误 HTTP 400，版本冲突 409，能力缺失 422，维护互斥 423，临时不可用 503；发现/测试/同步受理 202。GET 只读离线快照，不主动访问供应商。所有新管理 mutation 有 `requestId` 去重；commit 在事务中持久化 requestId/不含秘密的阶段收据，相同 ID/相同请求返回原阶段，不同请求复用 ID 返回 409。原生凭据阶段不确定时只回读，不自动重放。SDK异常、凭据 handle/nonce/值不得写收据。

| 接口 | 请求 / 安全响应 | 实施责任 |
| --- | --- | --- |
| GET `/api/provider-management` | `{schemaVersion:1,revision,capabilities,catalog,services,auth,sync}`；安全服务/认证/模型及 `configSource/effectiveValues/editableOverrides`；无真实 key | backend 能力仅表示SDK/私有bridge资格，最终 rawKeyInput 还须 main 的可信运行环境检查；不能由 isDesktop 自报开启 |
| POST `/api/provider-management/drafts` | `{requestId,serviceId?,expectedRevision,draftId?,expectedDraftRevision?,draft}` → `{draftId,draftRevision,connectionRevision,targetFingerprint,credentialState,consentState,cachedModels,sourceKind}` | 创建/修改非秘密草稿；仅目标/来源等连接变化使旧授权、暂存及请求失效；模型编辑只增draftRevision；拒原文/nonce/秘密handle |
| POST `/api/provider-management/discovery-authorizations` | `{requestId,draftId,draftRevision,confirm:true,rememberTarget:false}` → `{consentId?,expiresAt?,targetSummary,requiresDesktopConfirmation}` | 重算目标/凭据；env/none可按HTTP批准签grant；Electron存量/暂存key须D通道可信确认后才签，不能用HTTP布尔绕过 |
| POST `/api/provider-management/discovery-authorizations/revoke` | `{requestId,consentId}` → `{revoked:true}` | 使grant失效并真实取消operation；不能只隐藏前端提示 |
| POST `/api/provider-management/commit` | `{requestId,expectedRevision,action:create\|update\|clone\|delete\|disable,draftId?,draftRevision?,serviceId?,credentialAction?}` → `{revision,serviceId,saved,credentialSaved,credentialState,operationId,sync}` | 后端核验D批准的暂存/清除动作；配置落盘与原生凭据/同步分阶段，失败不可返回笼统成功；create重名409 |
| POST `/api/provider-management/discover` | `{requestId,draftId,draftRevision,consentId,dialogGeneration,requestSeq,force:false}` → 202 `{operationId}` | 只按服务端绑定的连接/凭据执行，force只绕缓存；响应含输入版本，OAuth无验证目录能力则unsupported，不发任意token |
| POST `/api/provider-management/test` | 同 discover 的绑定参数；结果 `{reachability,modelListAccess,credentialAccepted,inferenceVerified:false,evidence,checkedAt}`，事实为 true/false/null | 只做只读列表探测；200可能不要求认证，因此不推断key有效；无列表端点为unsupported |
| GET `/api/provider-management/operations/:id` | `{kind,state,revision,result?,error?}`；state 为 pending/running/success/failed/cancelled；发现 result 含归一化 models、sourceKind、stale、计数 | 新 operation registry，限并发/容量/TTL；归属当前 GUI 用户，结果没有 raw payload |
| POST `/api/provider-management/operations/:id/cancel` | `{requestId}`；中止发现/测试，幂等；已提交配置不提供伪撤销 | 保存操作受理后通过状态确认，不用 cancel 假装撤回磁盘写入 |
| POST `/api/provider-management/sync` | `{requestId,revision}`；返回 per-runtime 状态及 operationId | 新 `server/provider-config-sync.js`；与 A 共用安全同步协调器，替换高风险 closeAll/restart 接线 |

`capabilities` 明确 `rawKeyInput`、`keyStaging`、`nativeCredentialPersistence`、`privateDesktopBridge`、`oauthLogin`、`discoveryModes`、`modelOverrides`、`syncMode` 及不支持原因；Web前三项永不为true，Electron由main/backend两侧资格共同决定。DS 不能用 HTTP成功或 `window.piGuiDesktop` 存在代替权限。目录/provider字段上限和未知字段拒绝由 Codex fixture 锁定；providerId 1–64、modelId 1–300、name 200、最多3000模型，重复ID直接拒绝，不能静默裁剪身份。

安全 draft 字段固定为 `{serviceId?,providerId,catalogId?,authMode,displayName,connection:{baseUrl,api},modelPatches,selectedModelIds,modelOrder,enabled}`；authMode 为 `environment / pi-credential / oauth / none`，实际暂存状态由后端加入，renderer不能自报。local可有 `piRegistrationReference`（仅env引用），不得成为发现真实认证。credentialAction 为 `{type:keep}`、`{type:env,reference}`、`{type:none,confirmed:true}`、`{type:apply-staged}`、`{type:clear-native}`；后两项必须有D通道独立批准，只有HTTP confirmed不生效。none只清配置引用，clear-native只清原生凭据。空输入不隐式清除。

每个模型 patch 为 `{modelId,operation:upsert|remove,set:{name?,contextWindow?,maxTokens?,reasoning?,input?},unsetFields:[]}`；set/unset 不得交集，省略=不变，unsetFields=删除该可编辑覆盖并恢复继承/未知。后端依据可信 configSource 决定写 custom models 或内置 modelOverrides，renderer 不提交原始 config/headers；remove 对内置模型只去掉 GUI 自有覆盖/选择，不能删除其原生定义。GET 的 effectiveValues 包含只读三值能力与来源，editableOverrides 只含允许编辑字段；同步 RPC sanitizer 也须合并 modelOverrides 安全用户层，避免管理页与 Composer 不一致。内置 provider 首次建立覆盖需显式确认；OAuth 的选择/排序只写 GUI metadata，不创建空 provider；需要改内置模型参数时，只增受限 modelOverrides，不改 OAuth 身份或认证配置。

### Electron 私有凭据合同（无秘密 HTTP 路由）

| 层 / 具名入口 | 允许的数据和结果 | 授权约束 |
| --- | --- | --- |
| 普通 preload `providerCredentials.open/cancel/status` | open `{draftId,draftRevision,action:set\|replace\|clear\|authorize-target}`；只回 `state/capability/reason` | 主窗顶层sender验证；不能传key、任意URL/路径/模块、nonce或选择worker；authorize-target展示真实已有凭据目标但不取key |
| 输入窗专属 preload `submit/cancel/status` | submit `{flowId,promptId,nonce,input?,allowDiscovery,rememberTarget}`；clear不带input，需明确确认 | nonce只给该专属窗口；main核验窗口/主frame/精确本地URL/TTL/绑定draft与动作，限长、一次性 |
| main ↔ backend `type:provider-credential` | action `capability/prepare/stage/clear-stage/authorize-target/status/cancel/close-draft`，有requestId、backendEpoch和绑定flow | 当前直属child IPC，schema逐action白名单；secret只在stage一次性payload，不记录/广播；reused后端拒绝 |
| credential worker 私有方法 | `stageNativeLogin / persistNative / clearNative / readback / discover / disposeDraft` | 公开ModelRuntime根/内存CredentialStore；原始Credential/异常/SDK进度不出worker，stageStore和authPath能力分离 |

`prepare` 不带原文、由backend读取可信target后签flow；stage成功可同时签当前目标的新 discovery consent。主页面仅收到 `draftRevision/credentialGeneration/staged/consentState`；秘密handle只留backend/worker。通道存活、flow/授权和后台维护互斥统一协调，任何安装身份/后端epoch变化全部撤销。专用worker不经共享OAuth HTTP prompt链，保留原OAuth secret拒绝逻辑。

### 配置事务和 Runtime 生效

- 当前 reader 把损坏 JSON 当空配置、writer 使用 PID 临时文件/rename，均不能作为安全编辑合同。新仓储区分不存在、损坏、拒绝访问、schema 不支持；后三者只读并阻止写入。锁内重读、核对 revision 和文件身份，检查链接/reparse/目录替换，受控临时文件 flush+rename；保留顶层和未编辑对象的未知字段，不将它们投影到网页。浏览器提交的未知字段拒绝，不与“保留磁盘未知字段”混为一谈。
- `models.json` 和 GUI metadata 跨文件不能声称一次 rename 原子完成。先受限备份并写事务日志，记录两份前后版本与阶段，完成两文件后才发布新 revision；重启遇中断先恢复/完成同一事务并核对摘要，不能盲目覆盖外部新改动。恢复冲突进入只读人工恢复状态。外部 Pi/编辑器不参与 GUI 锁，故 CAS/身份核对只能缩小竞争窗口，不能声称完全锁住其他程序；同时编辑时要求停写并重读。
- 事务日志/备份可能含原有秘密，只在受保护的配置目录保存，权限不宽于原文件，禁止入仓库/诊断/导出，设保留上限并在确认恢复完成后清理。没有可靠权限或安全恢复资格则拒绝新写入；不以“自动备份”掩盖秘密副本风险。
- 配置与原生凭据分别记录事实：只有本次必要的凭据阶段确认完成后才对全部活跃 Classic/Runtime 排队同步；凭据已保存而SDK availability失败也只重试同步，不重新login。忙碌、审批、候选任务、更新/安装期间延后；不得 `closeAll()`、清Composer/线程或用不明 `--continue`。空闲时按权威sessionFile/owner/launch identity逐Runtime恢复并读回state/models/thinking；身份不明pending，失败可重试。
- 同步用 Runtime identity/epoch 与 revision 去重，项目切换/退出后旧结果失效。尚未同步的 Runtime 保留旧配置事实；新 Runtime 使用最新已提交配置。配置变更导致当前模型不可用时提示用户选择，不自动改模型或思考档位。OAuth 登录/退出的原有同步也必须使用这一协调器，不能只修新 CRUD 路径。
- 新Runtime/外部Pi可能随时读取已落盘models.json，因此安全性不能仅依赖GUI admission。§5的跨目标新ID规则必须在写前成立；本机其他程序并发写配置/凭据的残余竞争窗口单列，原生SDK文件锁不等于全流程CAS。

## 7. 前端源码映射与实施边界

| 文件 | 现有职责与计划改动 |
| --- | --- |
| `public/providers.js` | 保留对外入口与列表加载兼容；移出旧按钮预设/文本框 dialog，接新组件；不再调用 `reloadPi()` 清线程 |
| **新增** `public/provider-management/catalog.js` | 目录展示/别名与 capability 合并的纯函数；目录事实由后端快照提供 |
| **新增** `public/provider-management/state.js` | 唯一非秘密草稿 reducer：models/selection/order/dirty、revision、dialog generation、operationId；无 localStorage 草稿 |
| **新增** `public/provider-management/dialog.js`、`service-chooser.js`、`connection-fields.js`、`model-panes.js`、`advanced.js` | §4 的固定壳、视图与可销毁监听；请求只经 API 模块 |
| `public/provider-auth.js` | 保留全局 flow/轮询/安全URL；拆出按 provider 挂载视图，不创建第二个认证 owner，不把 secret prompt 转普通输入 |
| `public/api.js` | Codex 先提供 §6 的方法和合同 fixture；保留旧导出，不把 request 与当前聊天 owner 错绑 |
| **新增** `public/provider-management/discovery.js` | 缓存首屏、600ms防抖、consent/draft/connection版本、Abort和轮询清理；不接key值，不按搜索或模型选择触发网络 |
| **新增** `public/provider-management.css`；`public/tokens.css` / `public/styles.css` | 局部样式用已有 token；只移除已替代的 provider 旧样式，避免影响其他 modal/表单；接现有静态资源打包入口 |
| `public/ui/settings-surface.js`、`public/app.js`、`public/ui/modal.js` | 复用现有 Settings/Modal 生命周期；主设置列表仍用 presentDetail，子配置明确 openModal，接共享脏退出和焦点恢复 |
| **新增** `public/provider-management/model-visibility.js`；`public/ui3-model-picker.js`、`public/runtime-models.js` 调用边界 | 同一纯投影处理 GUI selection/order；不改 RPC 数据源、不污染 thinkingAvailability 的三值/owner 隔离 |
| `server/providers.js`、`lib/models-api.js` | 转无损仓储、复用模型归一化，接安全网络 transport；不简单放宽原文 validator |
| `server/provider-auth.js`、`server/provider-auth-sdk.js`、`server/provider-auth-runtime.js` | 延用 Pi/worker；新增最小私有 discovery 能力时审计输出；复用安全同步协调器 |
| **新增** `server/provider-credentials.js`、`server/provider-credential-sdk.js` | Codex实现D通道草稿/secret交互、内存CredentialStore、literal编码、原生保存/清除/私有回读；不扩普通OAuth secret prompt权限 |
| **新增** `electron/provider-credentials.cjs`、`electron/provider-credential-preload.cjs`、`electron/provider-credential.html/js/css` | Codex实现受限窗口、独立session/guard/最小bridge、私有backendIPC；固定输入面安全DOM不由DS接入主页面脚本，样式可按冻结tokens协作 |
| `electron/main.cjs`、`electron/preload.cjs`、既有打包脚本 | main注册专用session/生命周期/握手，普通preload只打开与安全状态；打包纳入固定本地输入资源及新worker，无HTTP资源回退 |
| `server/router.js`、`server.js` | 接应用级管理路由与正确优先级、依赖注入、生命周期和关机取消；移除受影响的破坏性同步接线 |

## 8. 兼容、回滚与已知限制

- 不自动修改用户真实配置；首次显式保存才创建 metadata。已有 provider ID、模型 ID、key/header/command、未知扩展和其他 provider 保留；不从 GET 安全投影重建整份磁盘配置。未支持的旧协议标只读，不默默改成 openai-completions 后保存。
- 数据 feature flag 为后端装配时的 `providerManagementEnabled`（默认切换须完成验收）；关闭后旧入口仍读取同一兼容 Pi 配置。metadata 只增加独立 GUI 文件，不写 Pi session schema。旧客户端写入也走新仓储；若无 revision，则锁内基于最新数据执行其受限操作并保守拒绝危险编辑，不能绕过 Endpoint 凭据绑定。
- 代码回滚：关闭开关/回退行为提交；metadata 保留但旧版忽略。数据回滚：先停止所有写入及同步，核对当前文件与对应事务版本；仅在一致时恢复受保护备份，否则展示冲突并保留双方。撤销 GUI 选择不回滚 OAuth token，logout 后不能靠配置备份恢复 token；必须重新登录。
- 增设 `providerKeyInputEnabled` 独立开关（P6 起默认开启；显式 `=0` 回滚）；关闭/回滚立即撤销秘密窗口/flow/暂存并中止发现，不能删除用户已保存的原生凭据。不得为回滚回写auth.json。存储资格（auth.json 所有者/受保护 DACL/可信祖先）不合格时同样整体关闭原生密钥输入（含暂存），快照、主进程与后端 `prepare` 三处 fail-closed。原生API key替换OAuth后无法靠GUI配置备份恢复登录，需重新OAuth登录。
- 无模型列表端点、订阅缺失公开协议、SDK 缺失时，保留离线目录/手动模型/官方登录说明，明确 unsupported。参考供应商不在当前 Pi descriptor 中时不实现私有 OAuth、额度、订阅计费或 host API。
- 高级客户端证书、任意 headers、定制 reasoning wire 参数、代理/证书跳过、自建 secret store、跨账号 OAuth 克隆、删除 Pi 内置目录、自动付费推理测试均不纳入本次范围。已有磁盘字段保留；只有经 Pi 公开配置支持并验证的字段可后续扩展，不以 UI 开关假装支持。
- 参考的多 OAuth 账户管理不移植：本项目按 Pi 每 provider 的原生凭据身份管理，不自建账户 UUID/secret namespace；plugin-owned provider/Jev classifier 不作为可编辑服务移植，缺少本项目相应 owner/运行时合同。参考的 availableForSubagents、nativeWebSearch、fastModeAllowed、图像生成绑定、document input、自定义 thinkingProtocol/defaultThinkingLevel 也不设假开关：它们依赖参考 sidecar/wire/计费能力，当前白名单或已验证 Pi 接口不能保证生效；保留既有磁盘扩展，界面显示兼容性说明。
- 主要剩余风险：外部进程同时编辑配置；跨文件恢复；Pi 版本/SDK 行为漂移；私有地址与凭据转发；环境凭据可被 Pi 工具继承读取；真实 OAuth/远端发现依赖供应商。不得承诺工具输出通用秘密消毒，参见 [security.md](security.md) 的既有信任边界。
- **与截图仍有的体验差距**：Electron要先点右上遮罩，在预定义受限窗填key，而非主DOM内联输入；Web/reused后端/不安全调试降级。无旧key读回/明文显示；已有携认证服务改目标须复制新ID；更新/清除需停止外部同provider认证并发。首次授权和变更后重授权保留，之后同目标自动发现。Pi明文库、同用户进程风险及SDK无凭据CAS不能通过UI消除。

## 9. 开发顺序、Codex / DeepSeek 任务边界

后续执行按任务逐项验证，遵循 [AGENTS.md](../AGENTS.md)、[REVIEW.md](../REVIEW.md) 和 [testing.md](testing.md#测试执行政策)。本次只提交本计划，以下生产开发任务均未执行。

| 顺序 | 负责人 / 文件边界 | 交付与依赖、完成门槛 |
| --- | --- | --- |
| P0 | Codex：公开SDK/政策/合同/fixture | 用户验收专用renderer狭窄例外与Pi明文存储风险后，冻结D/M、暂存/清除/部分失败和consent状态机；更新安全规格的精确例外，不普遍解除禁令。提供DS完整非秘密fixture，默认开关关闭 |
| P1 | Codex：配置仓储 + 原生凭据适配 | 原有无损CAS/恢复；新增公开内存store/native login、literal往返、CredentialSynchronizationError消毒、更新/清除类型检查/权限故障及3阶段收据。只用TEMP假SDK，不依赖真Pi安装 |
| P2 | Codex：Electron受限输入面/私有桥 + 网络策略 | 完成窗口/session/sender/nonce/握手/无私有pipe降级及秘密负向测试；同时实现consent绑定、DNS/redirect、限额/真实Abort/缓存隔离。完成独立安全审查后方可启用真key |
| P3 | Codex：完整管理接口、保存编排与多Runtime同步 | 串联draft暂存→授权自动发现→主保存native持久化→安全回读/延后同步；OAuth不扩秘密通道；无HTTP原文路径。合同可用后交DS真API |
| P4 | DS：主界面组件、局部CSS、完整状态 | 从P0完整fixture一次完成网格/固定凭据触发区/授权条/双栏/暂存及部分失败状态，预留CredentialSheet交互。不得实现秘密输入preload/安全DOM/SDK、擅改后端或RPC owner |
| P5 | Codex集成；DS修UI | 按P3接口接自动发现及两picker；集成Codex受限输入窗、主题/焦点/IME、Browser遮挡与打包资源，按增量修复 |
| P6 | Codex验证及独立功能/安全审查；用户验收 | 完整canonical、重建产物；专项覆盖Web/桌面/复用后端/调试降级、秘密隔离与视觉/真实取消。启用/合并/推送/发版各自取得对应许可 |

主依赖仍为 `P0 → P1 → P2 → P3 → P5 → P6`，`P0 → P4 → P5`；**无需重排P0–P6，但P0新增政策/SDK合同门槛、P1新增暂存持久化适配、P2新增秘密输入面、P3新增授权自动发现与保存编排**。P4不等待安全实现就可完成全布局/状态，不能自己接秘密。能力未具备时固定区域显示禁用原因，不能等UI完成再加输入窗/授权/状态。

## 10. 测试与视觉验收

- **已有定向入口**：`npm run test:models`、`npm run test:auth`、`node tests/provider-auth-runtime.cjs`、`node tests/model-capabilities.cjs`、`node tests/thinking-availability.cjs`、`node tests/settings-acceptance.cjs`、`node tests/runtime-models.cjs`、`node tests/server-security.cjs`。实施时记录实测通过/失败/skip 数量，不沿用历史数字。
- **新增离线套件**：`tests/provider-config-store.cjs`（无损合并/CAS/损坏/链接/权限/双文件崩溃恢复/复制）、`tests/provider-management-http.cjs`（DTO/应用鉴权/操作幂等/Endpoint授权）、`tests/provider-network-policy.cjs`（注入 DNS/transport，私网、redirect、TLS、流式上限/取消、恶意模型字段）、`tests/provider-config-sync.cjs`（Classic+多Runtime/忙碌/身份漂移/重试）、`tests/provider-management-ui.cjs`（选择 reducer/来源/焦点/迟到结果/无秘密）。用真实上游文档形状造 fake Pi/SDK；全部注册进 `package.json` canonical，不能另抄 CI 清单。
- **新增秘密专项**：`tests/provider-credential-sdk.cjs` 用假公开SDK合同验证暂存/保存/取消、literal往返/无命令、不暴露含credential异常、已存待同步、同槽OAuth确认、权限故障；存量快照后换文件不得触发二次默认getAuth、helper失败不得当无凭据、opaque来源拒发现。注入外部并发验证可检测冲突，披露无CAS剩余窗口。携认证跨目标编辑拒绝，配置后key失败/崩溃不使新目标继承旧key。`tests/provider-credential-desktop.cjs` 覆盖sender/frame/URL/nonce/TTL/replay、无私有pipe/Web/调试降级、独立session/agent不可达和主页面零key能力；正常沙箱专项不以jsdom替代。
- **自动发现专项**：首次未授权请求数0；允许后自动请求、防抖600ms、缓存60s先呈现、手刷绕TTL；更换host/port/basePath/API/凭据后旧grant失效、真实Abort且晚到不写cache；401/403/429无循环；失败/空结果留已选，推荐不覆盖touched，保存后迟到不改选择；模型目录网络记录不出现任何推理路径。用假哨兵响应验证模型ID/显示名等字段不能反射当前秘密到普通DOM/缓存。
- 产品测试所有写入都在 `os.tmpdir()`，不依赖本机真Pi安装，不用真key/真实配置/真实项目写验证；网络仅fixture假供应商。普通response/SSE/主DOM/日志/诊断/metadata必须不含秘密哨兵；专属输入DOM仅输入期间允许新值，取消/应用即销毁，不把它混算成“所有renderer零秘密”。不能删断言或skip安全用例。
- 功能稳定后完成一次本地 `npm test`，或用户预先选定当前 PR 的完整 CI；结果前标待验证。完整 canonical 不替代独立安全审查与故障注入；改 `public/`/`server/` 后按既有流程重建 App/EXE，再分别验证源码与产物。
- **下一阶段视觉矩阵**：用户原图相同比例窗口、1280×800、940/760px 宽、480px 宽，深浅两主题；chooser 四列/降列、长服务名、DeepSeek 双栏、长模型 ID、0/2/3000 模型、OAuth 设备码/授权回复、loading/empty/error/disabled/saved-pending/conflict 各状态，100%及150%系统缩放。宽窗壳/双栏比例对原图，主题色对 tokens；不要求复现样本模型名/凭据原文。
- 真实 Electron 正常沙箱验证：搜索/多选/排序/高级/取消/保存/刷新、Tab 环、IME、Esc 层级、重开 Auth、Runtime 任务不丢、Browser 原生视图被 modal 正确遮挡。提供少量代表截图与几何测量，不能用 jsdom 文本通过冒充布局通过。
- 同时验收预定义CredentialSheet的深浅主题、窄窗、焦点返回、password遮罩/粘贴、应用到草稿后自动发现、取消不落盘、主保存成功/失败/凭据已存待同步/暂存过期，以及Web和reused后端的同位置降级提示。布局冻结包含这些区域和状态，不能到P5才加窗口或重排两栏。
- 连接测试只证明对应列表/网络事实；真实登录、模型推理、真实 Pi 版本资格和生产恢复各自列证据与未验证项。真实外部调用需该阶段明确授权，不在自动离线验证中发生。

## 11. 本次文档交付与验收记录

本次仅更新本文件；无生产源码/依赖/测试入口/版本变更。未运行完整npm test、真实账户登录、Pi CLI、供应商模型、构建或视觉截图；纯文档例外适用。必要的SDK研究探针只在TEMP操作假数据，不算产品测试或新版Pi完整资格。

- **实际研究验证**：`os.tmpdir()/pi-gui-sdk-key-literal-review-zt1t2nbz/sdk-probe.mjs`、同目录 `safe-result.json`；Pi1.5.0，exit0，19/19通过、0失败、0skip、networkAttempts=0、processAttempts=0。子进程白名单env，HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP/PI_CODING_AGENT_DIR/cwd均指fixture；import前拦fetch/http/https/net/tls及child_process。探针仅调用公开SDK/公开依赖根，模型配置为空路径，假provider无对应env。实际持久化文件只在fixture内。
- **验证范围**：secret prompt、memory不落盘/回读/metadata、prompt前/中止后旧值保留、native明文存盘、仅目标更新/删除、重开回读、同provider假OAuth被替换、特殊`!/$` literal编码往返及无命令执行。首次尝试因import-only公开根的require解析失败，改用其exports.import入口；普通key先16/16，发现literal风险后完整扩为19/19。不得将其称为Electron安全已通过。
- **仍未验证**：新的主进程/专属preload/秘密窗口/HTTP编排代码尚不存在，故sender与隔离、Windows ACL、崩溃恢复、真实取消/供应商及打包视觉均待P0–P6；不是“安全风险已消失”。
- **本次修改汇总**：将“仅终端配置key”改为Electron隔离输入/内存暂存/主保存时原生持久化；将“手动获取为主”改为首次授权后自动发现、缓存首屏与真实取消；两者进入冻结UI及P0–P3/P6合同。既有网格、连接行、双栏和P0–P6主依赖保持。Web/调试/复用后端降级、Pi明文库/无CAS、额外受限输入窗与跨目标新ID是明确差距。
- 独立审查已核对SDK事实、Electron边界与发现状态机；发现的跨目标旧凭据泄漏和原生无CAS两类重要问题已修订并经增量复审确认。按SDK审查补充一次性存量快照，避免预检后默认getAuth重读执行command。静态检查覆盖链接/表格/冲突语句及diff空白；交付提交以 `git log -1 --format=%H -- docs/provider-management-rebuild-plan.md` 定位，回滚仅回退文档，不涉及用户配置。

**开发条件结论**：SDK层应用内输入/原生暂存保存可行，接口、受限输入面、授权自动发现和主要布局已定义，**具备在用户验收此最终设计后进入P0正式开发的条件**。不具备现在启用真实密钥收集/宣称生产安全的条件：P0政策例外验收、P1–P3专项及独立安全审查是启用门槛。P0–P6主依赖不重排，Codex先完成安全底层，DS按完整fixture一次完成主UI；生产实现/高风险实现批准/推送/合并/发布仍分别受授权约束。本次提交后等待设计验收。

### 源码索引

- 本地入口：[前端供应商](../public/providers.js)、[前端认证](../public/provider-auth.js)、[HTTP client](../public/api.js)、[Settings 生命周期](../public/ui/settings-surface.js)、[服务端配置](../server/providers.js)、[Auth flow](../server/provider-auth.js)、[SDK worker](../server/provider-auth-sdk.js)、[Auth adapter](../server/provider-auth-runtime.js)、[模型协议](../lib/models-api.js)、[路由](../server/router.js)、[装配/同步](../server.js)。
- Electron现有证据：[main](../electron/main.cjs)（私有child IPC、复用后端、默认session/guard/调试）、[普通preload](../electron/preload.cjs)、[私有IPC既有模式](../electron/app-update-desktop.cjs)、[Browser独立session模式](../electron/browser-view.cjs)。这些是可复用边界，不代表已存在秘密输入实现。
- 固定参考：[settings 组件目录](https://github.com/vastsa/PI-Desktop/tree/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings)、[providers.css](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/providers.css)、[model-config.css](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/model-config.css)、[service-setup.css](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/service-setup.css)、[API](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/lib/api.ts)、[IPC](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/electron/main/ipc/provider-ipc.ts)、[host providers](https://github.com/vastsa/PI-Desktop/tree/92ae661f1e399e69d514086b46029b4c34ba1a92/crates/host-core/src/providers)、[secret 实现](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/crates/host-core/src/secrets.rs)。
