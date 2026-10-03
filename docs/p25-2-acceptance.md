# P25.2 验收记录（2026-10-03）

1. **Before HEAD**：main `a5213f4685417f9c73b83a247bd98af16827443b`，fetch 后与远端一致。
2. **After HEAD**：见交付时最终 Git SHA；开发分支 `codex/p25-2-runtime-quota-sessions`。
   版本仍为 0.18.2，未推送、tag 或 release。
3. **修改文件**：Bridge 的 rpc-bridge/sse/server.js、app/shell/status-copy/bridge-recovery；
   Quota 的 quota/provider-auth-sdk/usage/providers；Sessions 的 sessions；
   三个新回归套件、npm test 注册、既有相关断言、app/exe fixture、浏览器夹具与截图脚本；
   architecture/provider-auth/runtime-recovery/本记录及实施计划。
4. **A 根因**：有限 SSE 历史不能充当 lifecycle 数据库；status 缺生命周期；
   transport open 冒充 Pi ready；shell spawn 也不证明 RPC ready。
   修复权威 snapshot 与私有 RPC 就绪确认，Renderer 统一 reconcile。
5. **Snapshot**：state、bridgeInstance、bridgeRun、bridgeRevision、cwd、hasProject、
   error、hint、maintenance；status 另提供 bridgeState/bridgeError/bridgeHint、piRunning、pid。
   实例标识随机且不敏感，状态更新在 publish 前完成。错误使用固定安全文案。
6. **恢复流程**：status 独立恢复；SSE 同步重放至多 800 条历史，再送当前
   bridge_snapshot，随后 live。历史 lifecycle 不覆盖当前事实；实例内 run/revision
   拒绝过期状态。新后端实例重置序号和 boot 去重，丢弃上一实例的迟到状态读取。
7. **Watchdog**：首次 status 外在 10/20 秒各补偿一次；重复快照不延迟截止时间。
   不自动重启、不无限轮询。逾期 notice 的重新同步只读 status，重启复用确认弹窗。
8. **B 身份架构**：Provider 是否存在由同一 Pi ModelRuntime 描述符确认。
   四个独立事实为 providerExists/quotaSupported/credentialAvailable/quotaQuerySucceeded。
   自定义配置继续原适配流程，Moonshot 中国新 preset 对齐 moonshotai-cn。
9. **DeepSeek**：真实 Pi 1.0.0 SDK 私有 worker 请求官方余额返回 ok、CNY。
   本机 models.json **没有 deepseek** 条目。无 models 条目的离线 Worker 回归也通过。
   零余额、多币种、401/403、超时、异常格式均覆盖；多币种不相加。
10. **OpenRouter**：真实私有 worker 查询返回 ok、kind=key-quota。
    UI 为 Key 剩余额度/Key 已用额度/Key 限额，不宣称账户 Credits。
    无 models 条目在 fixture 覆盖（本机已有自定义 openrouter 条目）。
    后续 OAuth 收口：存储类型不再提前拒绝。Pi getAuth() 最终解析出 apiKey
    即支持，无 apiKey 才 unsupported；转换始终在 Pi 私有 worker 内完成。
11. **接口支持表**：

    | Provider | 当前 quota |
    |---|---|
    | deepseek | 官方余额，支持 |
    | openrouter | 当前 Key 额度，支持 API Key |
    | openai / anthropic / google | 存在时 unsupported |
    | moonshotai / moonshotai-cn | 存在时 unsupported |
    | minimax / minimax-cn / mistral / groq / xai | 存在时 unsupported |
    | siliconflow custom preset | unsupported，未可靠验证当前 schema |
    | custom NewAPI | 仅显式 quotaAdapter=newapi |
    | unknown-provider | 真正 not-found |

12. **Secret isolation**：原生 getAuth 和 HTTP 均在私有 worker；仅规范化结果跨边界。
    Worker 消息/主线程日志/响应不包含 sentinel；缓存身份仅 64 位 SHA-256。
    真实 Worker、临时 esbuild CJS 包、打包后 worker 均验证。
    额度超时与取消不终止并发 OAuth。Provider 工具输出的原有信任边界未回退，
    没有增加任意工具输出的全局字符串 redaction。
13. **C 排序**：普通 active/archived 列表创建时间倒序，current 仅高亮。
    点击、继续消息、mtime、重命名不重排。搜索保留独立语义。
14. **Pending**：标准 Pi 文件名和最终 header 使用同一创建时间；同一排序管道
    处理补位和落盘，D C B A 保持不变。
15. **Legacy**：有效 header.createdAt → Pi 实际 header.timestamp → 严格文件名
    时间 → lexical identity。缺时间不回退 mtime；同时间也确定排序。
16. **npm test**：49 个套件，exit 0，417.31 秒。
    新 suite：Bridge 45/45、native quota 45/45、stable sessions 41/41。
    既有 sessions 85/85、session-search 71/71、quota 229/229。
17. **test:ui**：1324/1324。真实 Chromium 使用生产 SSE bus，805 条事件淘汰 ready
    后新页面/刷新/重连正常；真实鼠标切换仅改变高亮；逾期 notice 与手动 resync 正常。
    四张截图保存在开发机 `.shots/p25-2/`。
18. **build:app -- --rebuild**：通过；SEA 94.1 MB、Electron 整包 327.3 MB。
    随后 installer/portable 构建通过（NSIS 471 秒），portable 141.7 MB。
19. **test:app**：26/26；新增私有 RPC ready 确认，旧断言未删除。
20. **test:exe**：48/48；新且可写的 Windows TEMP/TMP/TMPDIR，PI_GUI_DATA 指向 fixture。
    没有 EPERM，也未忽略错误。新增真正的 RPC ready 确认。
21. **P25/P25.1**：Auth 源码 105/105、runtime 34/34、打包后 Auth 115/115；
    Hotfix 后端 26/26、UI 10/10。原生 OAuth fixture 登录/退出、single-flight、
    stale response、model sync、numeric RPC 私有应答、launch identity、no-project、
    导出路径、Web open-file、Add Folder 和 key 信任边界均回归。
    便携包 12/12；version:check 仍为 0.18.2。
22. **限制与失败记录**：真实账户 OAuth 浏览器重新登录与真实聊天未执行，
    OAuth 为公开 SDK Worker fixture/打包回归；真实 DeepSeek/OpenRouter 额度已执行。
    任意显式 pending 文件名无时间证据时保持未知，落盘后以真实 header 为准。
    可选安装器真实安装/卸载未运行，避免覆盖开发机现有安装。
    首次全量暴露重复 restart 杀新 child 的回归，已修复并保留 reliability 断言。
    首次 app/exe/最后 guard 的 7797/7798/7796 listen 返回 EACCES：旧绑定占用；
    使用独立可绑定测试端口后完整通过。原失败日志保留，无断言删除或阈值降低。
23. **git status**：业务/测试/文档分开提交后无跟踪文件改动。
    上轮遗留 release 目录与两个本轮 EXE fixture 目录保持未跟踪；递归清理被
    自动审批策略拒绝，未绕过，也未把目录加入提交。

这些是开发机验收证据，不是新 Release 或新 CI 发布记录。
