# 桌面 ZCode：验收证据与可复现产物检查

你已经完成第二轮安全复核。这是独立的测试/文档交付任务，不是第三轮安全审查。禁止子代理。
工作区：C:\Users\21022\.codex\worktrees\z4-2-canvas\pi-GUI，分支 zcode/z4-2-evidence 已基于 f66ef8b 准备好。
只允许写两个文件：tests/collab-packaged.cjs、docs/Z4-2-coverage-audit.md。
只能用文件阅读/编辑工具，不运行终端命令/测试，不写主目录/integration，不联网、不推送/PR/merge/tag/release、不下载依赖、不调用其他 Agent。Codex 统一实测与提交，package.json 由 Codex 独占。

任务一：完成可复现的 opt-in 产物验证脚本。当前 tests/collab-packaged.cjs 已复制了 Codex 实际跑过28/28的 TEMP探针。参考 tests/candidate-packaged.cjs 的现有模式做最小整理。
- root 必须按 __dirname 的仓库根解析，不能依赖 process.cwd；不硬编码集成 SHA，读取 build 后端/manifest 元数据或允许报告 unknown，不用终端获取。
- 仅验证本仓库 build/Pi GUI.exe 与 dist-app/Pi GUI-win32-x64/resources/app/server.cjs；不启动安装器，不覆盖安装版。
- 实际启动 App 内嵌后端及 SEA（App 用 ELECTRON_RUN_AS_NODE），TEMP空数据目录/无真实项目/fake不存在的pi、不联网，只 loopback。
- 每种产物验证401 Token、403 Origin优先、405 POST-only、409可信Owner拒绝；拒绝不能创建collab文档目录。
- collab-canvas/proposal/panel js、两份CSS、app/index/api八资源逐字节SHA256等于源码。
- 为两个form做显式可复查计数、资源SHA与结果JSON，可用 Z4_PACKAGED_OUTPUT 显式输出；不要存认证token、原始HTTP负载、真实路径等敏感数据。
- 有界启动/结束与正确进程清理；清理前验证最终临时world确在os.tmpdir下；不要误删证据输出目录，脚本抛错也清自己的进程。
- 保留28个有价值检查，不为了数字增长重复断言。不能模拟HTTP成功替代实际后端。不开启/降低sandbox；此脚本只验证打包后端，不冒充完整桌面UI。

任务二：以原始需求逐项核对交付范围，写简短 coverage audit 文档。原始任务只读附件 C:\Users\21022\.codex\attachments\7b7720a0-e266-4c5b-820c-159495f01632\已粘贴的文本.txt；集成树 docs/Z4-2-contract.md、acceptance.md、reviews.md、agent-source-research.md 与 tests/collab* 只读。
- 分列已实现/作者已实测/仍待验证/有意延后，不把文件存在当测试通过，不以你静态审查冒充亲测。
- canonical208仍运行；Antigravity正在独立修正Electron项目A-B-A与浅色绘制，未获得最终0退出前必须待验证。
- 真实Agent来源未接入，phase3仅研究/fixture/接口，生产source=null；原始任务明确允许此边界。
- ZCode第二轮Nit1：旧scope的close可能被authority拒绝，editor滞留最长30分钟/32LRU，无token不可复用，应列有界资源限制而非声称立即后台回收。
- 锁遗留手工检查、同用户恶意原生竞态/断电/跨平台未资格，不能夸大为强sandbox。
- 对任何实质缺口给准确路径和最小下一步，仅报告不修改生产代码、不扩展下一阶段。

完成后在本聊天给出修改文件与未执行条目，Codex会检查diff、运行脚本、把证据集成。不要写“已测试通过”。
