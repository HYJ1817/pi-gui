# 模型用量与远端额度 (Usage & Quota)

本文档阐明 Pi GUI 中**本地模型用量 (LocalUsage)** 与 **Provider 远端额度 (RemoteQuota)** 的架构设计、数据模型、官方适配器支持清单与安全边界。

---

## 〇、设计原则

把“本地模型用量”和“Provider 远端额度”做成**来源可追溯、语义不混淆**的统一体验：

1. **四项概念严格区分，绝不混淆**：
   - **用量 (Usage)**：模型交互实际消耗的 Token 数（输入、输出、缓存命中、缓存写入、思考等）；
   - **预估成本 (Estimated Cost)**：本地会话中由模型/Pi 报告的累计费用估计值；
   - **远端额度 (Quota / Limit)**：供应商账户在服务端的剩余资金余额或配额上限；
   - **速率限制 (Rate Limit)**：供应商针对并发与频次的约束（如 `20 req / 10s`）。
2. **0 与 null 严格分离**：
   - 字段没有真实证据就为 `null`；
   - `0` 只能表示真实 0（例如余额刚好为 0、无输入 token 等）；严禁把缺少数据填补为 0。
3. **权威数据来源**：
   - 本地用量只使用 Pi/模型返回的真实 usage 字段（`get_session_stats`、`message_update`、`message_end`），严禁用字符长度推算 Token 作为权威值。
   - 远端额度只为拥有稳定官方 API 的供应商编写适配器，无标准接口一律 `unsupported`。
4. **六不原则（禁止行为）**：
   - ❌ 不做浏览器抓取网页 Quota（禁止读 ChatGPT/Claude 网页 Cookie 或模拟登录）；
   - ❌ 不做自动 OAuth 登录或从开发者工具复制 Token；
   - ❌ 不妄猜 reset time；
   - ❌ 不冒充 OpenAI 标准造万能 Quota 协议；
   - ❌ 不做自动扣费/充值；
   - ❌ 不做消费预算自动切断。

---

## 一、两层数据模型

代码分别位于 [`server/quota.js`](../server/quota.js) 与 [`public/usage.js`](../public/usage.js)。

### 1. 本地用量 (LocalUsage)
随 Pi 的 RPC 事件真实更新：
```ts
interface LocalUsage {
  providerId: string | null;     // 当前或生成消息的供应商 ID
  modelId: string | null;        // 当前或生成消息的模型 ID
  sessionId: string | null;      // 会话 ID
  // 会话累计
  inputTokens: number | null;    // 输入 tokens（真实 0 或 null）
  outputTokens: number | null;   // 输出 tokens
  cacheReadTokens: number | null;// 缓存命中 tokens
  cacheWriteTokens: number | null;// 缓存写入 tokens
  totalTokens: number | null;    // 累计总 tokens
  // 上下文占用
  contextUsed: number | null;    // 当前上下文占用 tokens（compaction 刚结束时可能为 null）
  contextLimit: number | null;   // 上下文窗口上限 tokens
  contextPercent: number | null; // 上下文占用百分比
  // 成本
  estimatedCost: number | null;  // 模型报告的预估成本金额（美元）
  // 最近一轮单 turn 用量
  lastTurn: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    cacheWrite1hTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
    estimatedCost: number | null;
  } | null;
  source: 'session_stats' | 'message_end' | 'message_update' | 'none';
  updatedAt: string;             // ISO 8601
}
```

### 2. 远端额度 (RemoteQuota)
由后端按需拉取并缓存：
```ts
interface RemoteQuota {
  providerId: string;
  status: 'ok' | 'unsupported' | 'unavailable' | 'auth_error' | 'error';
  balance: {
    amount: number | null;       // 剩余金额（真实 0 或 null）
    currency: string | null;     // 货币单位，如 'USD'、'CNY'
    granted?: number | null;     // 赠送额度（若支持）
    toppedUp?: number | null;    // 充值额度（若支持）
  } | null;
  windows: {
    used: number | null;         // 已用额度
    limit: number | null;        // 限额上限
    unit: string | null;         // 单位
  } | null;
  rateLimit: {
    requests: number | null;     // 请求上限
    interval: string | null;     // 时间窗口，如 '10s'
    remaining?: number | null;   // 剩余可用请求数
  } | null;
  resetAt: string | null;        // 重置时间戳（无证据严格为 null）
  source: string;                // 数据来源端点
  updatedAt: string;             // ISO 8601
  message: string | null;        // 脱敏后的状态/错误信息
}
```

---

## 二、供应商官方支持矩阵

| 供应商 (Provider) | 远端 Quota 状态 | 官方 API 端点 / 机制 | 说明 |
|---|---|---|---|
| **OpenRouter** (`openrouter`) | ✅ **支持** (`ok`) | `GET https://openrouter.ai/api/v1/credits`<br>`GET https://openrouter.ai/api/v1/auth/key` | 官方公开 API，读取 total_credits 与 total_usage 计算剩余额度，提供 limit 与 rate_limit |
| **DeepSeek** (`deepseek`) | ✅ **支持** (`ok`) | `GET https://api.deepseek.com/user/balance` | 官方公开 API，返回 CNY 账户可用余额、赠金与充值金额 |
| **NewAPI / Sub2API** | ✅ **支持** (专有配置) | `GET {baseUrl}/dashboard/billing/subscription` | 需显式指定 `quotaAdapter: 'newapi'`，解析 hard_limit_usd 与 total_usage，不冒充 OpenAI 标准 |
| **OpenAI** (`openai`) | ⚠️ **仅本地 Usage** (`unsupported`) | 无官方 API Key 级公开端点 | 官方已废弃 legacy 额度接口；组织账单需管理 Admin Key 且参数繁杂，不向普通项目 Key 开放 |
| **Anthropic** (`anthropic`) | ⚠️ **仅本地 Usage** (`unsupported`) | 无官方公开额度接口 | 官方仅在响应 Header 返回短周期限流；无公共 GET balance 接口；严禁抓取网页 Cookie |
| **Google Generative AI** | ⚠️ **仅本地 Usage** (`unsupported`) | 无官方公开额度接口 | 额度统一由 Google Cloud 控制台管理，API Key 无 balance endpoint |
| **Groq / Mistral / Cerebras** | ⚠️ **仅本地 Usage** (`unsupported`) | 无官方公开额度接口 | 仅在响应 Header 返回限流信息，无账户余额端点 |
| **Ollama / 本地模型** | ⚠️ **仅本地 Usage** (`unsupported`) | 无（本地离线运行） | 本地推理无账户额度概念 |

---

## 三、安全边界与凭据脱敏

1. **凭据仅限后端使用**：
   - 渲染进程通过 `/api/quota/:providerId` 获取额度结果，**绝不回传 API Key 原文或 Authorization 请求头**。
2. **错误脱敏 (Scrub)**：
   - 如果上游或代理返回的错误体中回显了 API Key，后端 `scrubSecret` 统一替换为 `***` 后才返回前端。
3. **命令替换拦截**：
   - API Key 的解析复用 `lib/models-api.js`：支持 `$ENV_VAR`、`${ENV_VAR}` 和 `$$` 转义，**严格拒绝对 `!command` 形式进行执行**，杜绝任意命令执行攻击。

---

## 四、缓存策略与 Stale Request 防护

1. **后端缓存 (TTL)**：
   - 服务端按 `providerId` 建立缓存，默认 TTL 为 60 秒；
   - 相同的请求在 TTL 内直接返回缓存 (`cached: true`)，不频繁打扰供应商；
   - 多个并发请求同一 Provider 自动合并为单个 in-flight Promise，杜绝请求风暴；
   - 用户点击“刷新”或调用 POST `/api/quota/:providerId/refresh` 时强制穿透缓存。
2. **前端切换防护 (Stale Request Guard)**：
   - 前端维护 `S.quotaEpoch` 与 `S.currentProviderId`；
   - 当用户切换模型或供应商时，epoch 递增；旧 Provider 的迟到响应在返回时校验不匹配，被直接丢弃，**保证旧请求结果绝不覆盖新状态**。

---

## 五、测试规范

- **默认 100% 离线测试**：通过注入 Mock `fetchFn` 验证全部适配器、真实 0、null、网络错误、超时、401/403 认证错误、畸形响应、缓存命中、强制刷新与并发去重；
- **Live Provider 测试显式 Opt-in**：只有在 `LIVE_PROVIDER_TEST=1` 环境变量显式开启时才连接真机供应商，默认不进入 CI。
