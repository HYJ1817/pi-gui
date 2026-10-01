# 模型用量与远端额度 (Usage & Quota)

本文档阐明 Pi GUI 中**本地模型用量 (LocalUsage)** 与 **Provider 远端额度 (RemoteQuota)** 的架构设计、数据模型、官方适配器支持清单与安全边界。

---

## 〇、设计原则

把「本地模型用量」和「Provider 远端额度」做成**来源可追溯、语义不混淆**的统一体验：

1. **四项概念严格区分，绝不混淆**：
   - **用量 (Usage)**：模型交互实际消耗的 Token 数（输入、输出、缓存命中、缓存写入、思考等）；
   - **预估成本 (Estimated Cost)**：本地会话中由模型/Pi 报告的累计费用估计值；
   - **远端额度 (Quota / Limit)**：供应商账户在服务端的剩余资金余额或配额上限；
   - **速率限制 (Rate Limit)**：供应商针对并发与频次的约束（如 `20 req / 10s`）。
2. **0 与 null 严格分离**：
   - 字段没有真实证据就为 `null`；
   - `0` 只能表示真实 0（例如余额刚好为 0、无输入 token 等）；严禁把缺少数据填补为 0。
   - 前端统一走 `fmtMaybeNumber()` / `fmtMaybeMoney()`：`null`/`undefined` → `—`，
     有限数字 → 正常格式化。**不允许**用 `x || 0` 把缺失顶成 0。
3. **权威数据来源**：
   - 本地用量只使用 Pi/模型返回的真实 usage 字段（`get_session_stats`、`message_update`、`message_end`），严禁用字符长度推算 Token 作为权威值。
   - 远端额度只为**经过核实的官方** API 编写适配器，无标准接口一律 `unsupported`。
4. **六不原则（禁止行为）**：
   - ❌ 不做浏览器抓取网页 Quota（禁止读网页 Cookie 或模拟登录）；
   - ❌ 不做自动 OAuth 登录或从开发者工具复制 Token；
   - ❌ 不妄猜 reset time（`resetAt` 只表示**额度/限额的重置时间戳**；API Key 自身的失效时间不是它）；
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
  balance: {                     // 默认展示的那一条（多币种时见 balances）
    amount: number | null;       // 剩余金额（真实 0 或 null）
    currency: string | null;     // 货币单位，如 'USD'、'CNY'
    granted?: number | null;     // 赠送额度（若支持）
    toppedUp?: number | null;    // 充值额度（若支持）
  } | null;
  balances: Array<{              // 多币种余额（DeepSeek balance_infos）；**不相加**
    amount: number | null;
    currency: string | null;
    granted: number | null;
    toppedUp: number | null;
  }> | null;
  windows: {
    used: number | null;         // 已用额度
    limit: number | null;        // 限额上限
    remaining?: number | null;   // 剩余额度
    unit: string | null;         // 单位
  } | null;
  rateLimit: {
    requests: number | null;     // 请求上限
    interval: string | null;     // 时间窗口，如 '10s'
  } | null;
  resetAt: string | null;        // 额度/限额的重置时间戳（无证据严格为 null）
  source: string;                // 数据来源端点
  updatedAt: string;             // ISO 8601
  message: string | null;        // 白名单化的状态/错误文案
}
```

---

## 二、供应商官方支持矩阵

| 供应商 (Provider) | 远端 Quota 状态 | 官方 API 端点 / 机制 | 说明 |
|---|---|---|---|
| **OpenRouter** (`openrouter`) | ✅ **支持** (`ok`) | `GET https://openrouter.ai/api/v1/key` | 普通 **当前 API Key** 的 per-key 限额：读 `limit` / `limit_remaining` / `usage` / `rate_limit`。**不调用** Management-only 的 `/api/v1/credits`，也不用已失效的 `/api/v1/auth/key`（这两个是 P21 之前的实现，已废弃）。`limit_reset` 是 `daily/weekly/monthly` 这类周期标签，`expires_at` 是 key 自身的失效时间 —— **两者都不映射到 `resetAt`** |
| **DeepSeek** (`deepseek`) | ✅ **支持** (`ok`) | `GET https://api.deepseek.com/user/balance` | 官方接口返回 `balance_infos`，**可能同时有 CNY 与 USD**：逐条展示、**绝不相加**；`primary` 优先 CNY（否则第一条）。赠送/充值金额逐币种保留 |
| **NewAPI**（需显式配置） | ✅ **支持**（专有） | `GET {baseUrl}/dashboard/billing/subscription`<br>`GET {baseUrl}/dashboard/billing/usage` | 仅当 provider 配置里显式写 `quotaAdapter: "newapi"` 时启用（**不**按 provider 名 / baseUrl 名 / OpenAI 兼容性去猜）。鉴权用 `Authorization: Bearer <API key>`：当前 NewAPI 的 dashboard 接口走 `middleware.TokenAuth()`，Bearer 就能解析出 user context，**不要求 `quotaUserId`**。两个 endpoint 都要调，`used = total_usage / 100`（美分），`remaining = hard_limit_usd - used`。`quotaUserId` 只是**旧部署的可选兼容**：配了才额外带 `New-Api-User` 头，没配照常查询 |
| **Sub2API** | ⛔ **unsupported** | 当前没有经过核实的稳定契约 | 不猜、不试；只有等上游有公开稳定接口后才可能适配 |
| **OpenAI** (`openai`) | ⚠️ **仅本地 Usage** (`unsupported`) | 无官方 API Key 级公开端点 | 官方已废弃 legacy 额度接口；组织账单需管理 Key，不向普通项目 Key 开放 |
| **Anthropic** (`anthropic`) | ⚠️ **仅本地 Usage** (`unsupported`) | 无官方公开额度接口 | 官方仅在响应 Header 返回短周期限流；严禁抓取网页 Cookie |
| **Google Generative AI** | ⚠️ **仅本地 Usage** (`unsupported`) | 无官方公开额度接口 | 额度统一由 Google Cloud 控制台管理 |
| **Groq / Mistral / Cerebras** | ⚠️ **仅本地 Usage** (`unsupported`) | 无官方公开额度接口 | 仅在响应 Header 返回限流信息 |
| **Ollama / 本地模型** | ⚠️ **仅本地 Usage** (`unsupported`) | 无（本地离线运行） | 本地推理无账户额度概念 |

> `unsupported` 的供应商**一次网络请求都不会发**（测试里有断言）。

---

## 三、安全边界与凭据脱敏

1. **凭据仅限后端使用**：
   - 渲染进程通过 `/api/quota/:providerId` 获取额度结果，**绝不回传 API Key 原文或 Authorization 请求头**。
2. **错误脱敏 (Scrub)**：
   - 适配器返回的 `message` 一律是**白名单文案**；上游错误体、`ECONNREFUSED`、主机端口、
     本地文件路径、stack 都不外传。
   - HTTP handler 的兜底是统一文案 `{ ok: false, error: "额度查询失败" }`：
     **不把内部 exception message 交给 renderer**。
3. **命令替换拦截**：
   - API Key 的解析复用 `lib/models-api.js`：支持 `$ENV_VAR`、`${ENV_VAR}` 和 `$$` 转义，**严格拒绝对 `!command` 形式进行执行**，杜绝任意命令执行攻击。
4. **凭据指纹**：
   - 缓存身份里用的是**已解析凭据的 SHA-256 指纹**（只作为哈希输入，从不落盘、不进日志、
     不进 HTTP 响应、不进诊断、不进 renderer）。

---

## 四、缓存身份与 Stale Request 防护

1. **缓存身份（不只是 providerId）**：
   后端按一个**配置身份**建缓存，身份包含：

   ```
   providerId | 解析后的 adapter | adapter 维度的 endpoint identity | 凭据指纹 | （可选）New-Api-User 值
   ```

   少任何一项都会出现「配置变了还命中旧缓存」：
   - `apiKey: "$OPENROUTER_KEY"` 字符串没变、但环境变量值变了 → 身份必须变（否则会拿旧结果）；
   - `quotaAdapter: "newapi"` 被去掉 → adapter 从 `newapi` 变成 `unsupported`，身份必须变；
   - **endpoint 变了必须变**。endpoint identity 是 adapter 维度的：
     - OpenRouter / DeepSeek 打的是**固定 canonical endpoint**（`https://openrouter.ai/api/v1/key`、
       `https://api.deepseek.com/user/balance`），baseUrl 带不带路径都不影响身份；
     - NewAPI 打的是 `{baseUrl}/dashboard/billing/...`，所以用**规范化后的 origin + pathname**：
       `https://example.com/api-a` 与 `https://example.com/api-b` 是**两个不同部署**，
       绝不能共享缓存；`https://example.com/api-a/` 与 `https://example.com/api-a`
       视为**同一个** endpoint（去尾部斜杠，去 query / fragment）。

   只有**真的会改变请求**的字段才进身份：`quotaUserId` 仅在 newapi 且配置了它时进入
   （那时会发 `New-Api-User` 头）；没配就不会让它无意义地 miss 缓存。

   默认 TTL 60s；`force=true` / POST `.../refresh` 穿透缓存；同一身份的并发请求合并成一个
   in-flight Promise。`clearCache(providerId)` 按 providerId 清（缓存按身份哈希存，
   所以需要靠条目里记录的 providerId 过滤）。

2. **前端切换防护 (Stale Request Guard)**：
   - 前端维护 `S.quotaEpoch` 与 `S.currentProviderId`；
   - 切换模型/供应商、workspace 切换、以及**新模型解析不出 Provider**时，epoch 递增；
     旧 Provider 的迟到响应在返回时校验不匹配，被直接丢弃，**保证旧请求结果绝不覆盖新状态**；
   - 后端 in-flight 也按身份隔离：配置 A 的在途请求最终只落回 A 的身份，B 永远读不到它。

---

## 五、会话与工作区重置规则

| 触发 | 规则 |
|---|---|
| **workspace 切换**（`beginWorkspaceSwitch`） | `resetUsageState()`：清 `S.stats` / `S.remoteQuota` / `S.currentProviderId` / LocalUsage 全部字段，`S.quotaLoading = false`，`S.quotaEpoch++`，并**立刻**把侧栏与 ctx chip 归零（`renderUsageState()`）—— 不等下一次 RPC 应答 |
| **session 身份变化**（new / switch / fork，`sessionId` 变了） | 覆盖旧 state **之前**就清掉会话级用量：`S.stats = null`、session totals、`lastTurn`，并立刻重绘。**远端额度不跟着清** —— 它归 Provider identity 管，换会话不等于换供应商 |
| **新模型解析不出 Provider** | `S.quotaEpoch++`、`S.currentProviderId = null`、`S.remoteQuota = null`、`S.quotaLoading = false`，并立刻重绘。旧供应商的在途应答回来也写不进去 |
| **Provider 变了** | `syncRemoteQuota(newProviderId)`；旧身份的结果不会命中（后端身份隔离 + 前端 epoch 双重防护）|

> `renderUsageState()` 是**唯一**一处「把用量画到 DOM」的实现：
> workspace reset、session 切换、正常 stats 更新都走它，不存在第二份 reset 逻辑。

---

## 六、测试规范

- **默认 100% 离线测试**（`npm run test:quota`，并入 `npm test`）：
  - Provider 契约用**严格 URL 的 mock**：不认识的 URL 直接抛 `unexpected URL`，杜绝
    「mock 不区分 URL」造成的假绿；NewAPI 的两个 endpoint 各返回**不同** fixture，
    并断言两个 URL **各调用正好一次**、只带 `Authorization: Bearer`
    （**默认不发** `New-Api-User`）；没有 `quotaUserId` 也照常工作，
    没有 `quotaAdapter` → `unsupported` 零请求，没有 `apiKey` → `auth_error` 零请求；
  - NewAPI 的 base path `A → B` 必须换身份（重新 fetch），
    `https://example.com/api-a/` 与 `https://example.com/api-a` 是**同一**身份；
  - 断言 `limit_reset="monthly"` + `expires_at=<ISO>` 时 `resetAt === null`，
    且 `expires_at` 绝不变成 `resetAt`；
  - 断言 DeepSeek 多币种**不相加**、`balances.length === 2`；
  - 缓存身份：环境变量改值、adapter 变化、inFlight 隔离、`clearCache(providerId)`；
  - 错误边界：401/网络错误/畸形响应/未配置 Key 的文案都是白名单，且不含内部细节；
  - HTTP handler 抛异常时只回 `额度查询失败`；
  - 前端 DOM（jsdom）：workspace reset、session 切换、provider unknown、多币种渲染、
    `null → —` 与真实 `0 → 0`、恶意币种字符串只当文本；
  - 静态守卫：P21 相关源码不含 U+FFFD / GBK 乱码标记，也不再有 `x || 0` 这类兜底。
- **Live Provider 测试显式 Opt-in**：只有 `LIVE_PROVIDER_TEST=1` 时才可能连真机供应商，
  默认不进入 CI（本阶段没有执行 live）。
