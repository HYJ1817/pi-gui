# 供应商管理前端合同 v1

HTTP 入口为 `/api/provider-management`。自 P6 起该入口默认开启；管理员可在启动后端前设置 `PI_GUI_PROVIDER_MANAGEMENT=0` 显式关闭。关闭时该路由返回 `unsupported`，旧路由继续使用同一仓储。请求通过 [public/api.js](../public/api.js)，校验和状态枚举见 [contract.js](../public/provider-management/contract.js)。页面使用应用级鉴权，无须传 Runtime owner。示例包含完整供应商、模型、认证、冲突和降级状态。[非秘密 UI fixture](../tests/fixtures/provider-management-scenarios.json)

## 当前可用接口

| 方法 / 相对路径 | API 方法 | 请求 | HTTP 200 结果 |
| --- | --- | --- | --- |
| GET `/`（根路径无尾斜杠） | `fetchProviderManagement()` | 无 | `Snapshot` |
| GET `/services/:serviceId/cache` | `fetchProviderServiceCache(id)` | 无 | `{ok:true,serviceId,sourceKind:'cache'\|'none',cachedModels?,cacheStale?,cachedAt?}`。服务端按当前权威配置与认证来源解析目标；只读内存缓存，不联网、不写草稿。 |
| POST `/drafts` | `saveProviderDraft(body)` | `{requestId,expectedRevision,serviceId?,draftId?,expectedDraftRevision?,draft}` | `{ok:true,draftId,draftRevision,connectionRevision,targetFingerprint,credentialState,consentState,consentId?,consentExpiresAt?,cachedModels,sourceKind}` |
| POST `/commit` | `commitProviderDraft(body)` | `{requestId,expectedRevision,action,serviceId?,draftId?,draftRevision?,credentialAction?}` | `{ok:true,revision,serviceId,saved:true,credentialSaved:null,credentialState:'none',operationId:null,sync}` |

`Snapshot` 为 `{ok:true,schemaVersion:1,revision,capabilities,catalog,services,auth,sync}`。`revision` 和 `targetFingerprint` 为不透明字符串，`draftRevision` 和 `connectionRevision` 为正整数。P3-C 接通后，`sync` 为 `{state:'idle'|'pending'|'applied'|'error',reason,runtimes}`，逐目标事实为 `{id,kind,state,reason}`；只有协调器回读确认后才出现 `applied`。配置落盘成功只说明配置已保存，Runtime 是否生效另看 `sync`。

| 快照字段 | 结构和读法 |
| --- | --- |
| `catalog[]` | `{id,name,category,authMode,connection,suggestedEnvReference?,providerId?,enabled?,disabledReason?}`。`category` 为 `api-key` 或 `subscription`。自定义端点与订阅卡可以没有连接，表现为 `connection:null`。`enabled` 缺省可选择。按 `category` 分组，搜索使用 `name`、`id` 和 `connection.baseUrl`。 |
| `services[]` | `{serviceId,providerId,catalogId,displayName,enabled,connection,credentialState,envReference,authMode,models,selectedModelIds,modelOrder,readOnly,compatibility}`。`catalogId`、`connection` 可以为 null。`selectedModelIds:null` 表示继承现有可用列表，空数组表示没有选择。`modelOrder` 是右栏次序。服务状态中的 `credentialState` 为 `{state,source}`，`source` 取 `env/literal/command/pi-credential/unknown`；`credentialState.state` 对 `pi-credential` 只在 Pi 报告 `credentialStored:true` 或 `status:'connected'` 时为 `saved`。`envReference` 只在 `apiKey` 是 `$NAME`/`${NAME}` 时回传引用名；字面量 Key、`!command` 和其他写法恒为 `null`。编辑既有环境变量引用时前端把该引用放回草稿，保存提交 `{type:'env',reference}`，不会把引用名当密钥。 |
| `models[]` | `{modelId,providerId,configSource,effectiveValues,editableOverrides}`。`configSource` 为 `configured/builtin-override`。两种值结构包含可编辑字段，`effectiveValues` 另有只读三值 `toolCalling` 和 `streaming`。缺少字段表示未知或继承。 |
| `auth` | `{sdkAvailable,piVersion,providers,flow:null}`。`piVersion` 为版本字符串或 null。每个供应商为 `{providerId,displayName,status,authType,credentialStored,authConfigured,canLogin,canLogout,methods}`。`status` 为 `connected/disconnected/unknown/unsupported`，`authType` 为 `oauth/api-key/environment/null`。`credentialStored` 表示 Pi 本机槽里已有凭据；已保存的 API Key 常见组合是 `credentialStored:true` + `status:'unknown'`（远端有效性未验证）。`authConfigured` 表示 Pi 认为该供应商已有可用认证。重启后判断“已配置”必须认这两个字段，不能只看 `connected`；`connected` 只代表 Pi 已验证过的远端登录（OAuth）。方法为 `{type,canLogin,isSubscription}`，`type` 为 `oauth/api-key/environment`。活跃流程另从既有 OAuth API 读取。 |
| `capabilities` | `{rawKeyInput,keyStaging,nativeCredentialPersistence,privateDesktopBridge,oauthLogin,discoveryModes,modelOverrides,syncMode,reasons}`。桌面能力要求私有桥完成握手、SDK 资格成立，**且 `auth.json` 的所有者/权限/祖先见证成立**；三项任一不成立时 `rawKeyInput/keyStaging/nativeCredentialPersistence` 全为 false（含暂存），非秘密管理操作仍可用。`discoveryModes` 由后端按 P3-B 接线与私有桥状态给出，只允许 `none/environment/pi-credential`。`syncMode:'deferred'` 表示 P3-C 已提供只读同步核验。`oauthLogin/modelOverrides` 保留未知 `null`。以快照能力和 `reasons` 渲染对应禁用说明，不得由前端自行放宽。 |

### 草稿与提交

- `Draft` 包含 `{providerId,authMode,displayName,connection,modelPatches,selectedModelIds,modelOrder,enabled,serviceId?,catalogId?,piRegistrationReference?,confirmBuiltinOverride?}`。`authMode` 为 `environment/pi-credential/oauth/none`。`connection` 为 `{baseUrl,api}`，API 枚举为 `openai-completions/openai-responses/anthropic-messages/google-generative-ai`。连接为无用户信息、查询或片段的 HTTP(S) URL。`piRegistrationReference` 仅用于 `none` 的回环注册占位，值为 `$NAME` 或 `${NAME}`。
- 每个模型 patch 为 `{modelId,operation:'upsert',set?,unsetFields?}` 或 `{modelId,operation:'remove'}`。允许 `name/contextWindow/maxTokens/reasoning/input`，两个 token 参数为正安全整数，输出上限不得超过上下文，`input` 为由 `text/image` 组成的非空去重数组。`unsetFields` 移除覆盖并恢复继承。未提交的字段原样保留。模型 ID 唯一且最长 300 字符，最多 3000 项。`selectedModelIds` 和 `modelOrder` 包含相同 ID，顺序由后者决定。首次建立内置覆盖需 `confirmBuiltinOverride:true`，且以后端确认的能力为准。
- 创建草稿省略 `draftId/expectedDraftRevision`。编辑草稿同时提交两者。更新与复制传外层 `serviceId` 作为来源，复制的 `draft.providerId` 填新 ID。若草稿内含 `serviceId`，须与外层一致。仅连接身份或认证来源改变时递增 `connectionRevision`。草稿响应中的 `credentialState/consentState/cachedModels/sourceKind` 描述这份草稿，服务的已有凭据状态仍从快照读取。授权完成后，同一草稿的投影会带上与当前草稿、目标和认证代次绑定的 `consentId/consentExpiresAt`；它只是不透明句柄，不含凭据。`close-draft` 或换目标后该句柄失效。没有当前草稿授权时，投影可返回**目标缓存**：`sourceKind:'cache'`、`cachedModels`（候选模型，`configSource:'cache'`，过期条目带 `cacheStale:true`）与 `cachedAt`。缓存严格绑定 providerId、规范化目标（协议/host/port/basePath）、API、认证来源与凭据代次；只用于首屏候选展示，不联网、不改变既有选择/顺序。60 秒内为新鲜，过期后最多保留 15 分钟并明确标记；目标/认证/凭据代次变化即不再命中。显式撤销授权只撤销联网读取（此后该句柄不能再发起发现/测试请求），已缓存的目标级元数据仍可只按 `sourceKind:'cache'` 展示，绝不作为最新结果，也绝不自动选择。迟到的缓存响应必须仍属于发起请求时的服务与目标，否则丢弃。
- `commit.action` 为 `create/update/clone/delete/disable/enable`（P6 增加与 `disable` 对称的无草稿 `enable`，只改 GUI 元数据）。前三种携带 `draftId/draftRevision`，除 create 外均需 `serviceId`。删除和停用省略草稿和凭据操作。`credentialAction` 可省略或为 `{type:'keep'}`、`{type:'env',reference}`、`{type:'none',confirmed:true}`。复制使用 `authMode:'none'`、新 provider ID 和 keep，复制结果只保留允许的模型字段。已有认证或认证不明的服务换端点时走复制。内置服务删除表现为停用。
- 草稿保留 15 分钟。写操作用独立 `requestId`，重传同一请求时保持 ID 和请求内容，内容变化时换 ID。commit 结果收据持久化，草稿收据在内存中。`config_conflict` 先重读快照并比较编辑内容，`draft_conflict` 用新草稿重新提交。P3-A 已实现原生凭据 `{type:'apply-staged'}` 与 `{type:'clear-native'}`：配置先落盘，凭据结果再以 `saved/cleared/saved-credential-error/credential-unconfirmed` 独立返回。
- revision 只在签发它的后端实例中有效。重启后应先刷新快照；若在重试已完成的 commit，仍使用原请求和 ID，保留中的收据会返回原结果。新自定义 ID 必须有 SDK 对内置身份和凭据槽的明确证据；证据不足时提交可能返回 `unsupported` 或 `credential_conflict`。

## P3 已接通的接口

P0＋P1 曾对以下有效请求返回 HTTP 422 `{ok:false,code:'unsupported',message,retryable:false}`。P3-A/B/C 已按下列冻结形状接通；能力仍由快照的 `capabilities` 与 `reasons` 逐项门控，不能仅凭接口存在就显示可用。

| 方法 / 相对路径 | API 方法 | 请求 | 后续结果 |
| --- | --- | --- | --- |
| POST `/discovery-authorizations` | `authorizeProviderDiscovery(body)` | `{requestId,draftId,draftRevision,confirm:true,rememberTarget}` | `{ok:true,consentId?,expiresAt?,targetSummary,requiresDesktopConfirmation}` |
| POST `/discovery-authorizations/revoke` | `revokeProviderDiscovery(body)` | `{requestId,consentId}` | `{ok:true,revoked:true}` |
| POST `/discover` | `discoverProviderModels(body)` | `{requestId,draftId,draftRevision,consentId,dialogGeneration,requestSeq,force}` | HTTP 202 `{ok:true,operationId}`，结果由 operation 读取 |
| POST `/test` | `testProviderConnection(body)` | 同 `/discover` | HTTP 202 `{ok:true,operationId}`，结果含 `reachability/modelListAccess/credentialAccepted` 三值、`inferenceVerified:false`、`evidence/checkedAt` |
| GET `/operations/:id` | `fetchProviderOperation(id)` | 无 | `{ok:true,kind,state,revision,result?,error?}`。发现结果含归一化 `models/sourceKind/stale/count` 和请求绑定版本 |
| POST `/operations/:id/cancel` | `cancelProviderOperation(id,body)` | `{requestId}` | `{ok:true,state:'cancelled'}` |
| POST `/sync` | `syncProviderConfiguration(body)` | `{requestId,revision}` | HTTP 202 `{ok:true,operationId,sync}`。同一请求标识可重取受理回执；在 `/operations/:id` 读取 `kind:'sync'` 和 `result.sync`。重试仅核验已运行进程。 |

`capabilities.syncMode:'deferred'` 表示可以读取同步状态和发起只读重试。`sync.runtimes` 只包含活动目标的 `{id,kind,state,reason}`，其中 `kind` 为 `classic` 或 `runtime`。操作完成后 `sync.state` 仍可能是 `pending`，例如进程启动时尚未加载本次变更。旧配置 revision 的新重试返回 409。

管理接口错误为 `{ok:false,code,message,retryable,fieldErrors?}`。400 `invalid_request` 的 `fieldErrors` 只含字段名和 `invalid`。409 包含 `config_conflict/draft_conflict/request_id_conflict/provider_exists/credential_target_conflict/credential_conflict`。423 为 `config_busy`。422 还包含 `config_invalid/config_unsupported/config_unsafe`。503 覆盖不可读、写入失败和待恢复。管理 API 客户端沿用 `{ok:false,network:true,error}` 的传输错误形状。

## OAuth 和专用输入面

沿用 `/api/provider-auth` 和 [现有 OAuth 合同](provider-auth.md)。GET 返回 `{ok,capability,providers,flow,sync}`。POST `/login` 用 `{providerId,authType:'oauth'}`，`/logout` 用 `{providerId}`，`/respond` 用 `{flowId,promptId,value}`，`/cancel` 用 `{flowId}`，`/sync` 用 `{}`。成功返回同一快照，失败返回 `{ok:false,code,error}`。`value` 仅为当前受支持的 OAuth 授权交互值。普通应用页面的 API Key 区域只展示状态与入口。

P2/P5 的普通 preload 入口为 `providerCredentials.open({draftId,draftRevision,action})`、`cancel`、`status`、`closeDraft({draftId})`，其中 `action` 为 `set/replace/clear/authorize-target`。页面只接收状态与能力，开放需通过主窗身份校验。`closeDraft` 只携带草稿标识，用于管理弹窗关闭或换目标时撤销该草稿的暂存与发现授权。独立输入窗的 `submit/cancel/status` 由受限预加载接线，普通页面无须构建其输入负载。私有帧的公共字段为 `{type:'provider-credential',action,requestId,backendEpoch}`，附加字段如下。[私有帧校验](../public/provider-management/contract.js)

| 私有 action | 附加字段 |
| --- | --- |
| `capability` | 无 |
| `prepare` | `draftId,draftRevision,purpose`，purpose 取 `set/replace/clear/authorize-target` |
| `stage` | `flowId,promptId,nonce,input,allowDiscovery,rememberTarget`。仅此帧携带输入，限 8192 UTF-8 字节，禁止空输入、NUL 和换行 |
| `clear-stage` | `flowId,promptId,nonce,confirmed:true` |
| `authorize-target` | `flowId,promptId,nonce,confirmed:true,rememberTarget` |
| `status` / `cancel` | `flowId` |
| `close-draft` | `draftId` |

私有 SDK 适配可在测试中验证暂存、保存和清除。`providerKeyInputEnabled` 自 P6 起默认开启；存储资格不合格或管理员显式设为 `0` 时，快照能力、主进程开窗与后端 `prepare` 都会关闭原生密钥输入（含暂存），相关按钮禁用并说明原因。成功保存区分 `saved` 和 `credentialSaved`，后者允许 `true/false/null`。配置已保存但凭据失败时保持草稿与右栏，显示 `saved-credential-error`。凭据结果不确定时显示 `credential-unconfirmed`：回读只描述 Pi 的当前状态，不能证明本次写入或清除成功，只有提交回执的 `credentialSaved/credentialState` 才是本轮结果的依据；GUI 不自动重发；凭据已保存但待同步时展示 `saved-pending-sync`。[安全边界与绑定规则](provider-management-rebuild-plan.md#52-electron-专用秘密链路与生命周期)

## P4 界面与 P5 集成状态

用 fixture 的 `live` 作为当前合同示例，用 `fixturesOnly` 试做尚未开放的交互。固定布局包含网格、连接与凭据区、左候选和右已选栏，CSS 使用既有 `--ds-*` tokens。主题由根节点 `data-theme` 控制，两种主题使用同一 DTO。`modelOrder` 只改变 GUI 顺序，模型能力和 Pi 默认值保持原有语义。

采用 [合同状态枚举](../public/provider-management/contract.js) 区分对话框、凭据、发现、操作和同步状态。授权之后的效果绑定 `connectionRevision/targetFingerprint/dialogGeneration/requestSeq`，过期响应不得覆盖草稿。失败保留右栏、已编辑参数和选择，旧缓存标 stale。示例 `fixturesOnly` 中的已保存、自动发现和受限输入只用于练习状态切换，运行页面通过 `capabilities` 判断实际可用性。

P5 已把 P4 的界面入口接到真实实现：受限输入窗暂存后由 `/commit` 映射 `apply-staged`/`clear-native`；授权句柄随草稿投影返回，`/discover` 与 `/test` 走 202 ＋ 操作轮询，迟到或换目标的结果丢弃；`/sync` 只读核验并展示逐目标事实；关闭弹窗、换服务或改认证来源调用 `closeDraft`。主页面始终只持有草稿标识和不透明句柄，不持有密钥，也不直接读写 `auth.json`。
