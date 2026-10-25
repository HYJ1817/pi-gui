# 桌面 Antigravity：Z4-2 第三轮最终功能增量复审

这是同一功能的第三轮，按 REVIEW.md 收敛：仅复核新增 diff 与受影响边界，不开启风格改造。只读 C:\Users\21022\.codex\worktrees\z4-2-integration\pi-GUI；最新源码/测试提交5388c1be155a0b86f9ed2c903669d31d63ce50d1，生产组合根f66ef8b，最后生产差异51a47f1仅把新模块局部DOM变量el机械改为domNode。
禁止终端命令/测试、文件写入、网络、子代理、push/PR/merge/tag/release。仅文件工具只读，不碰C:\pi-GUI真实数据。

你前两轮检查了协议、服务和组件，第二轮B0/I0/N0。第三轮重点：
- server.js固定DATA_DIR/protectedRoots、复用完整Classic/Runtime authority，proposal source仍null；server/router.js在Origin+Token之后、classic-only guard之前挂载协同。
- public/app.js/index.html在会话工具区打开既有右栏，无新global rail，是否遗漏状态或能力。
- public/collab-panel.js后续修复：Runtime签名不含无关Classic bridgeRun；硬session-switch/workspace-generation即使owner字段未变也同步清控件；迟到open best-effort关闭；确认框独占不误撤其他审批；未知网络结果与CAS冲突禁写/重开。
- 03b4749存储短名修复已由独立ZCode第二轮复核，无需重复全量；看docs/Z4-2-reviews.md处置记录即可，发现受新增集成影响的证据可报告。
- 51a47f1的3个public文件纯局部变量改名，不应改createPaneHeader(...).el或任何公共API。tests/smoke.cjs未改，1338/1338实际由Codex复跑。
- package.json test:collab8叶进入canonical；Electron与产物探针为补充专项，不能算进208叶。完整npm test第二次于15:14:39启动，当前仍待验证。

Codex作者实测（不是你执行）：385项协同链（含原型49）、模块120、smoke1338、正常sandbox Electron47/47含受控进程清理9/0、100节点200边、Runtime close/resume、项目A-B-A、真实Browser遮挡、浅色computed+真实PNG；App/SEA重新构建，资源探针28/28。完整canonical首轮因静态el名称守卫1337/1338失败，纯改名后定向green，第二次尚运行，不能说完整已过。

你参与编写Electron夹具，所以不要把自己写的测试当对其独立审查，也不能称独立运行；本轮只独立审生产集成增量。实际测试和截图由Codex查验。你上轮test修正错误假设dormant即有owner导致run5等待history失败，已依据runtime_closed会owner=null纠正，最终项目测试调用真正projects.activateProject，不制造状态。记录这段边界，不重开修复循环。

请给出本轮B/I/N与准确文件定位/触发条件/影响，未运行项和资格边界。ZCode Nit1：旧scope close可被拒，editor TTL30m/32LRU有界回收，记录接受，不为了清理能力放宽Owner。真实Agent闭环未接，阶段3仅研究与fixture，安全存储不是同用户恶意竞态/断电强保证。不得把作者数据写成你亲测。

历史派发勘误：本任务包曾将八套件汇总误写为385；最终ZCode交叉核对确认49+56+53+24+13+7+72+11=285，检查项未减少，最终统计以验收报告为准。
