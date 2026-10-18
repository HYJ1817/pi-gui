# 高风险旧问题修复计划

目标：修复审查编号 1、4、7、10；本轮不改 CI，不使用子代理。

沿用现有 uploads、Runtime store、两处会话视图和 registry；不新增依赖。
当前基线 cbcd6c2，远端 main 同步。此前全量 npm test 在 SACL witness 输出
`witness_unavailable` 并退出 1，后续套件未执行，不能作为全量通过基线。

## 实施与验收

- [x] 添加 tests/high-risk-regressions.cjs，先证明以下断言在当前代码失败。
  上传使用真实 router/uploads、隔离 HTTP 子进程和 os.tmpdir fixture；
  文件名覆盖中文、孤立百分号、编码字样；固定同毫秒上传检查路径与正文唯一。
  两个 Runtime 输入面分别覆盖延迟成功、新输入、相同文本重新编辑、切换、
  失败及 owner 换代；状态用真实 registry 和受控事件验证原任务仍可停止。
- [x] 上传只使用 URLSearchParams 已解码的名字；随机 ID、wx 排他创建、
  有界碰撞重试；保持 API 字段与原始文件名语义。
- [x] Runtime 草稿捕获提交时的内容与编辑版本；只有成功、owner 未变且
  草稿未再编辑时清除。中央与独立会话弹层采用一致条件，不清其他会话。
- [x] registry 区分运行和按请求 ID/命令关联的待确认请求，失败或 handled
  响应只结算对应请求；原任务、其他待确认请求和停止屏障不被清除。
  每个 runtime 最多保留 32 个待确认请求的 ID/命令类型；超额返回
  `runtime_request_limit`，不保存正文；重号拒绝，settled/Stop/桥重置清理。
- [x] 新套件加入 package.json 的唯一 npm test 入口；运行针对套件和相关回归。
- [x] 用真实 Electron 复测延迟发送后新草稿保留，保存截图；不调用真实 Pi。
- [x] 运行 npm test，记录实际完成/失败位置，不跳过失败来制造通过。
  主运行 exit 0，3196.113 秒；最后仅 uploads.js 的等长文件名前缀调整新增
  一项回归，最终专项 29/29、打包 26/26、实际包上传 5/5，未再完整重跑。
- [x] 用本机现有 Electron ZIP 离线重建隔离桌面产物，核对产物包含修改。
- [x] 本 agent 自审新增 diff，说明未做独立复审、真实 Pi 和剩余问题。

不自动提交、推送、合并或发版。编号 8 的普通会话切换端到端证据仍不足，
单独保留；其他确认问题留给后续批次。所有写盘验证只针对临时 fixture。
