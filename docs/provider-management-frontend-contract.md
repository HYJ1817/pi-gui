# 供应商管理前端合同 v1

HTTP 入口为 `/api/provider-management`。P0＋P1 默认关闭该入口，开发或联调可在启动后端前设置 `PI_GUI_PROVIDER_MANAGEMENT=1`。关闭时该路由返回 `unsupported`，旧路由继续使用同一仓储。请求通过 [public/api.js](../public/api.js)，校验和状态枚举见 [contract.js](../public/provider-management/contract.js)。页面使用应用级鉴权，无须传 Runtime owner。示例包含完整供应商、模型、认证、冲突和降级状态。[非秘密 UI fixture](../tests/fixtures/provider-management-scenarios.json)

## 当前可用接口

| 方法 / 相对路径 | API 方法 | 请求 | HTTP 200 结果 |
| --- | --- | --- | --- |
| GET `/`（根路径无尾斜杠） | `fetchProviderManagement()` | 无 | `Snapshot` |
| POST `/drafts` | `saveProviderDraft(body)` | `{requestId,expectedRevision,serviceId?,draftId?,expectedDraftRevision?,draft}` | `{ok:true,draftId,draftRevision,connectionRevision,targetFingerprint,credentialState,consentState,cachedModels,sourceKind}` |
| POST `/commit` | `commitProviderDraft(body)` | `{requestId,expectedRevision,action,serviceId?,draftId?,draftRevision?,credentialAction?}` | `{ok:true,revision,serviceId,saved:true,credentialSaved:null,credentialState:'none',operationId:null,sync}` |

`Snapshot` 为 `{ok:true,schemaVersion:1,revision,capabilities,catalog,services,auth,sync}`。`revision` 和 `targetFingerprint` 为不透明字符串，`draftRevision` 和 `connectionRevision` 为正整数。当前同步状态为 `{state:'idle',reason:null}` 或 `{state:'pending',reason:'runtime_sync_pending'}`。配置落盘成功可以显示“已保存，待同步”。独立同步入口由 P3 接通。

| 快照字段 | 结构和读法 |
| --- | --- |
| `catalog[]` | `{id,name,category,authMode,connection,suggestedEnvReference?,providerId?,enabled?,disabledReason?}`。`category` 为 `api-key` 或 `subscription`。自定义端点与订阅卡可以没有连接，表现为 `connection:null`。`enabled` 缺省可选择。按 `category` 分组，搜索使用 `name`、`id` 和 `connection.baseUrl`。 |
| `services[]` | `{serviceId,providerId,catalogId,displayName,enabled,connection,credentialState,authMode,models,selectedModelIds,modelOrder,readOnly,compatibility}`。`catalogId`、`connection` 可以为 null。`selectedModelIds:null` 表示继承现有可用列表，空数组表示没有选择。`modelOrder` 是右栏次序。服务状态中的 `credentialState` 为 `{state,source}`，`source` 取 `env/literal/command/pi-credential/unknown`。 |
| `models[]` | `{modelId,providerId,configSource,effectiveValues,editableOverrides}`。`configSource` 为 `configured/builtin-override`。两种值结构包含可编辑字段，`effectiveValues` 另有只读三值 `toolCalling` 和 `streaming`。缺少字段表示未知或继承。 |
| `auth` | `{sdkAvailable,piVersion,providers,flow:null}`。`piVersion` 为版本字符串或 null。每个供应商为 `{providerId,displayName,status,authType,canLogin,canLogout,methods}`。`status` 为 `connected/disconnected/unknown/unsupported`，`authType` 为 `oauth/api-key/environment/null`。方法为 `{type,canLogin,isSubscription}`，`type` 为 `oauth/api-key/environment`。活跃流程另从既有 OAuth API 读取。 |
| `capabilities` | `{rawKeyInput,keyStaging,nativeCredentialPersistence,privateDesktopBridge,oauthLogin,discoveryModes,modelOverrides,syncMode,reasons}`。原文输入和私有通道当前为 false，`discoveryModes:[]`，`syncMode:'unsupported'`。`oauthLogin/modelOverrides` 保留未知 `null`。以快照能力和 `reasons` 渲染对应禁用说明。 |

### 草稿与提交

- `Draft` 包含 `{providerId,authMode,displayName,connection,modelPatches,selectedModelIds,modelOrder,enabled,serviceId?,catalogId?,piRegistrationReference?,confirmBuiltinOverride?}`。`authMode` 为 `environment/pi-credential/oauth/none`。`connection` 为 `{baseUrl,api}`，API 枚举为 `openai-completions/openai-responses/anthropic-messages/google-generative-ai`。连接为无用户信息、查询或片段的 HTTP(S) URL。`piRegistrationReference` 仅用于 `none` 的回环注册占位，值为 `$NAME` 或 `${NAME}`。
- 每个模型 patch 为 `{modelId,operation:'upsert',set?,unsetFields?}` 或 `{modelId,operation:'remove'}`。允许 `name/contextWindow/maxTokens/reasoning/input`，两个 token 参数为正安全整数，输出上限不得超过上下文，`input` 为由 `text/image` 组成的非空去重数组。`unsetFields` 移除覆盖并恢复继承。未提交的字段原样保留。模型 ID 唯一且最长 300 字符，最多 3000 项。`selectedModelIds` 和 `modelOrder` 包含相同 ID，顺序由后者决定。首次建立内置覆盖需 `confirmBuiltinOverride:true`，且以后端确认的能力为准。
- 创建草稿省略 `draftId/expectedDraftRevision`。编辑草稿同时提交两者。更新与复制传外层 `serviceId` 作为来源，复制的 `draft.providerId` 填新 ID。若草稿内含 `serviceId`，须与外层一致。仅连接身份或认证来源改变时递增 `connectionRevision`。当前草稿响应是 `credentialState:'none'`、`consentState:'unapproved'`、`cachedModels:[]`、`sourceKind:'none'`。它们描述这份草稿，服务的已有凭据状态仍从快照读取。
- `commit.action` 为 `create/update/clone/delete/disable`。前三种携带 `draftId/draftRevision`，除 create 外均需 `serviceId`。删除和停用省略草稿和凭据操作。`credentialAction` 可省略或为 `{type:'keep'}`、`{type:'env',reference}`、`{type:'none',confirmed:true}`。复制使用 `authMode:'none'`、新 provider ID 和 keep，复制结果只保留允许的模型字段。已有认证或认证不明的服务换端点时走复制。内置服务删除表现为停用。
- 草稿保留 15 分钟。写操作用独立 `requestId`，重传同一请求时保持 ID 和请求内容，内容变化时换 ID。commit 结果收据持久化，草稿收据在内存中。`config_conflict` 先重读快照并比较编辑内容，`draft_conflict` 用新草稿重新提交。原生凭据 `{type:'apply-staged'}` 和 `{type:'clear-native'}` 的形状已冻结，当前提交返回 422 `unsupported`。
- revision 只在签发它的后端实例中有效。重启后应先刷新快照；若在重试已完成的 commit，仍使用原请求和 ID，保留中的收据会返回原结果。新自定义 ID 必须有 SDK 对内置身份和凭据槽的明确证据；证据不足时提交可能返回 `unsupported` 或 `credential_conflict`。

## 已冻结的后续接口

P0＋P1 对以下有效请求返回 HTTP 422 `{ok:false,code:'unsupported',message,retryable:false}`。成功形状供 P2／P3 实现与 P4 fixture 使用。

| 方法 / 相对路径 | API 方法 | 请求 | 后续结果 |
| --- | --- | --- | --- |
| POST `/discovery-authorizations` | `authorizeProviderDiscovery(body)` | `{requestId,draftId,draftRevision,confirm:true,rememberTarget}` | `{ok:true,consentId?,expiresAt?,targetSummary,requiresDesktopConfirmation}` |
| POST `/discovery-authorizations/revoke` | `revokeProviderDiscovery(body)` | `{requestId,consentId}` | `{ok:true,revoked:true}` |
| POST `/discover` | `discoverProviderModels(body)` | `{requestId,draftId,draftRevision,consentId,dialogGeneration,requestSeq,force}` | HTTP 202 `{ok:true,operationId}`，结果由 operation 读取 |
| POST `/test` | `testProviderConnection(body)` | 同 `/discover` | HTTP 202 `{ok:true,operationId}`，结果含 `reachability/modelListAccess/credentialAccepted` 三值、`inferenceVerified:false`、`evidence/checkedAt` |
| GET `/operations/:id` | `fetchProviderOperation(id)` | 无 | `{ok:true,kind,state,revision,result?,error?}`。发现结果含归一化 `models/sourceKind/stale/count` 和请求绑定版本 |
| POST `/operations/:id/cancel` | `cancelProviderOperation(id,body)` | `{requestId}` | `{ok:true,state:'cancelled'}` |
| POST `/sync` | `syncProviderConfiguration(body)` | `{requestId,revision}` | `{ok:true,operationId,sync}`，含逐 Runtime 状态 |

管理接口错误为 `{ok:false,code,message,retryable,fieldErrors?}`。400 `invalid_request` 的 `fieldErrors` 只含字段名和 `invalid`。409 包含 `config_conflict/draft_conflict/request_id_conflict/provider_exists/credential_target_conflict/credential_conflict`。423 为 `config_busy`。422 还包含 `config_invalid/config_unsupported/config_unsafe`。503 覆盖不可读、写入失败和待恢复。管理 API 客户端沿用 `{ok:false,network:true,error}` 的传输错误形状。

## OAuth 和专用输入面

沿用 `/api/provider-auth` 和 [现有 OAuth 合同](provider-auth.md)。GET 返回 `{ok,capability,providers,flow,sync}`。POST `/login` 用 `{providerId,authType:'oauth'}`，`/logout` 用 `{providerId}`，`/respond` 用 `{flowId,promptId,value}`，`/cancel` 用 `{flowId}`，`/sync` 用 `{}`。成功返回同一快照，失败返回 `{ok:false,code,error}`。`value` 仅为当前受支持的 OAuth 授权交互值。普通应用页面的 API Key 区域只展示状态与入口。

P2 的普通 preload 入口为 `providerCredentials.open({draftId,draftRevision,action})`、`cancel`、`status`，其中 `action` 为 `set/replace/clear/authorize-target`。页面只接收状态与能力，开放需通过主窗身份校验。独立输入窗的 `submit/cancel/status` 由 Codex 接线，普通页面无须构建其输入负载。私有帧的公共字段为 `{type:'provider-credential',action,requestId,backendEpoch}`，附加字段如下。[私有帧校验](../public/provider-management/contract.js)

| 私有 action | 附加字段 |
| --- | --- |
| `capability` | 无 |
| `prepare` | `draftId,draftRevision,purpose`，purpose 取 `set/replace/clear/authorize-target` |
| `stage` | `flowId,promptId,nonce,input,allowDiscovery,rememberTarget`。仅此帧携带输入，限 8192 UTF-8 字节，禁止空输入、NUL 和换行 |
| `clear-stage` | `flowId,promptId,nonce,confirmed:true` |
| `authorize-target` | `flowId,promptId,nonce,confirmed:true,rememberTarget` |
| `status` / `cancel` | `flowId` |
| `close-draft` | `draftId` |

P1 私有 SDK 适配可在测试中验证暂存、保存和清除，生产默认 `providerKeyInputEnabled=false`。后续成功保存区分 `saved` 和 `credentialSaved`，后者允许 `true/false/null`。配置已保存但凭据失败时保持草稿与右栏，显示 `saved-credential-error`。凭据结果不确定时显示 `credential-unconfirmed`，先回读，凭据已保存但待同步时展示 `saved-pending-sync`。[安全边界与绑定规则](provider-management-rebuild-plan.md#52-electron-专用秘密链路与生命周期)

## P4 试做与验收状态

用 fixture 的 `live` 作为当前合同示例，用 `fixturesOnly` 试做尚未开放的交互。固定布局包含网格、连接与凭据区、左候选和右已选栏，CSS 使用既有 `--ds-*` tokens。主题由根节点 `data-theme` 控制，两种主题使用同一 DTO。`modelOrder` 只改变 GUI 顺序，模型能力和 Pi 默认值保持原有语义。

采用 [合同状态枚举](../public/provider-management/contract.js) 区分对话框、凭据、发现、操作和同步状态。授权之后的效果绑定 `connectionRevision/targetFingerprint/dialogGeneration/requestSeq`，过期响应不得覆盖草稿。失败保留右栏、已编辑参数和选择，旧缓存标 stale。示例 `fixturesOnly` 中的已保存、自动发现和受限输入只用于练习状态切换，运行页面通过 `capabilities` 判断实际可用性。
