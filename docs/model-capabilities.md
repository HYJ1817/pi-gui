# 模型能力与能力感知界面

模型能力描述附在安全模型条目的 `capability` 字段中；原有 `id`、`provider`、
`reasoning`、`input`、`contextWindow`、`maxTokens` 保留，旧配置无需迁移。
新增 `providerId`、`modelId` 是结构化身份，模型 ID 中的 `/` 属于模型 ID，
不能据此判断供应商。正常路径使用 Pi 的 provider，旧 ID-only 状态才用唯一列表匹配
或原有 `provider/model` 兼容分支；重名且无法确认时保留未知。

```js
{
  providerId: 'custom',
  modelId: 'example',
  name: 'Example',
  contextWindow: null,
  maxOutputTokens: null,
  capabilities: {
    textInput: null,
    imageInput: null,
    toolCalling: null,
    reasoning: null,
    streaming: null
  },
  reasoning: { supported: null, levels: null },
  evidence: {
    contextWindow: null, maxOutputTokens: null,
    textInput: null, imageInput: null,
    toolCalling: null, reasoning: null, streaming: null
  }
}
```

以上为结构示例，不是模型目录或默认值。

## 证据与优先级

纯函数 `mergeModelCapabilities` 按字段确定性合并：

1. `pi-runtime`：聊天 RPC 返回的明确字段，权威最高。
2. `user-config`：同 providerId + modelId 的 models.json 显式 metadata。
3. `provider-metadata`：用户主动拉取 `/models` 时返回的明确 metadata。
4. 无证据：值与 evidence 都为 `null`。

明确 `false` 是证据，优先级高于较低来源的 `true`；`null` 不遮蔽较低来源的明确值。
不同身份的条目绝不合并。上下文和输出上限只接受正的有限数字，GUI 不补默认值。
Pi 自己为模型补出的运行时默认值仍属于 **Pi 报告的值**，不等于 Provider 官方声明。
evidence 是来源枚举，不是远端实测成功、请求保证或原始 payload。

`input` 的非空、可识别列表表示明确输入类型：`['text']` 说明不支持图片；
缺失、空列表或无法识别的列表仍是未知。明确 reasoning 布尔值可作推理能力证据，
但不产生思考等级。`supported_parameters` 包含 `tools` 或 `reasoning` 是对应的
正向 metadata；列表里未出现某项并不能证明不支持。
toolCalling / streaming 没有明确字段时保持未知，不依供应商、API 类型或模型名称猜测。

`/models` 拉取结果本身只用于发现和展示，不会自动扩大 Pi 的可用模型列表。
用户选择并保存其中的 metadata 后成为显式用户配置，Pi 重载后返回其实际运行态。
不会后台联网同步模型数据库。Provider endpoint 可能是自定义中转，metadata 只表示
该 endpoint 的声明，不证明其远端模型能力或官方身份。

## Pi 的权威边界

模型切换沿用现有串行队列：选择 → pending（清空旧候选）→ `set_model` → Pi 应答
→ 回读 `get_state` 与 `get_available_thinking_levels` → 同代次两份结果齐备 → 更新界面。
失败也回读实际状态。候选和状态按 request ID、model generation、workspace generation
配对；SSE 层继续用 bridge instance/run/cwd 拒绝旧运行事件。快速连续选择只在上一条
set_model 应答后发送最后选择，旧 state/levels 不覆盖新模型。

静态 `reasoning.levels` 为 `null`。当前可选等级单独存于 `S.thinkingLevels`，只来自
`get_available_thinking_levels`；即使 reasoning=true，也不生成 low/medium/high。
Pi 若给出了多个等级，以该列表为准，静态 reasoning=false 不覆盖它。
空列表、失败、仅 off 或无当前模型时，按钮禁用并显示「思考不可用」；pending 显示
「思考同步中…」。当前等级只有在 Pi 回读且包含于候选列表时才显示，设置不再乐观显示。
模型、项目和会话切换会清掉旧候选；Pi 重启后重新 boot 回读。

## UI 与安全边界

模型列表保持 Provider 折叠交互，第二行最多展示推理、图片、Tools、Context；
Max output 与明确不支持的能力放在条目 title，未知不显示成不支持。
文本使用安全 DOM API，无模型名规则或大型硬编码表。

附件按钮同时用于图片与普通文件，因此 imageInput=false 不会禁用整个附件按钮。
文件选择器保留原有全部文件类型，并说明「当前模型不支持图片，普通文件仍可用」；
选择、粘贴、拖放均经过 `handleFiles` 的图片检查。已有图片会留在托盘并提示原因，
发送按钮与 `submit` 阻止发送，用户可移除或切换模型。unknown/true 均可正常添加图片。
模型切换 pending 期间暂缓发送，确认后再按新模型的能力检查。

纯能力数据只含 identity、数字、布尔值、固定 evidence，不含 API Key、OAuth token、
headers、auth、balance、quota 或 rate limit。Auth 和 RemoteQuota 保持各自模块和生命周期。
自定义配置可在模型的 `capabilities` 中显式填写布尔 metadata；GUI 仅保留五个能力键，
工具与 streaming 的字段只用于能力展示，聊天和工具执行仍由 Pi 决定。

共享纯实现位于 `public/model-capabilities.js`，后端通过 `lib/model-capabilities.js` 使用
同一实现，以保持浏览器原生 ESM、现有静态资源打包和零新增依赖。

## 验证与范围

`npm run test:model-capabilities` 覆盖规范化、合并、身份隔离、未知/false、旧配置、
secret 白名单、模型列表投影、图片入口与发送、思考候选与回读、过期应答、项目与会话
切换、重启恢复。该套件进入 `npm test` 唯一入口。
`node tests/model-capabilities-shot.cjs` 在离线 fixture 上生成真实 Chromium 截图。

本阶段不实现 fallback、自动路由、自动切 Provider、多账户轮换或工具系统重构。
metadata 不保证下一次调用成功；不维护硬编码模型数据库，是为了避免过期能力成为
UI 或下一阶段路由的错误依据。
