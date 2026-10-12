# P33.5a 实施计划

目标：只读展示 P33.2 journal、P33.3 候选和既存 P33.4 恢复材料；不改变写回契约，不提交。

设计选择：复用 secondary-surface 和 diff.js；独立于 Git Changes。相比扩展 Git 面板，这样避免恢复动作混用；相比新增全页，不改变导航与列表位置。

- [x] 基线：核实 HEAD/status，运行 npm test；保留既存未跟踪目录，离线核查本地协议。
- [x] 查询：在既有 store 队列内投影分页文件摘要，不读取 blob、不追加 journal。路由复用 withAuthority；limit 1..50、cursor 为 revision+offset；跨 revision 拒绝。
- [x] 身份：摘要允许读取忙碌 runtime，原生 session/owner/workspace 仍双检；预览与历史比较保留 active_writer 门槛。
- [x] UI：更多→本会话变更，复用右栏。摘要/历史标签、中文固定原因、用户点击才请求单文件 diff；前端 owner 每次从当前状态读取，切换立即丢弃旧数据和正文。
- [x] 历史：只调用 recover-preview/export；已有单文件备份主动下载，无材料显示空态。
- [x] 测试先行：真实 HTTP+store 检查分页、身份、泄漏、journal/index/ref/工作文件不变；DOM 交互检查切换/迟到响应/未知错误/无写接口。
- [x] 验证：专项→npm test→真实 Pi 默认工具→源码/打包 RPC→Electron 真实截图，记录失败/跳过与证据边界。
- [x] 交付：docs/p33-5a-acceptance.md，列清验收缺口；不自动提交、推送、发版或进入 P33.5b。

审查补充已完成：后台初始化既有 store，pending/failed 快速拒绝证据接口；不让查询触发 journal 协调，也不把历史 ACL 校验放到 GUI 启动等待路径。

Jev 未调用：任务边界明确且仓库已限定不联网，本次使用正常 Codex 判断。任务为 backend/frontend 集成，需要测试，风险来自身份串线与正文泄漏；不涉及工作区恢复写入。
