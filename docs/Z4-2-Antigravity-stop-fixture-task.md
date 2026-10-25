# 桌面 Antigravity：Stop VM 夹具依赖补齐（仅测试）

完整canonical第二次运行在第153个叶命令 node tests/gui-browser-stop.cjs 失败，前152个已成功；错误 createCollabStore is not defined，位置VM执行server.js真实Router装配片段。主Agent搜同类路径发现 tests/stop-barrier.cjs 使用相同slice和VM上下文，也需一次性补齐。生产源码不变。

仅可修改 C:\Users\21022\.codex\worktrees\z4-2-backend\pi-GUI 的 tests/gui-browser-stop.cjs、tests/stop-barrier.cjs。该分支已含f66生产挂载，和集成树5388的server.js相同。禁止其他文件写入、命令/测试执行、联网、子代理、push/PR/merge/tag/release。

先读这两测试在server.js片段的取法与context，再比对server.js约1000行四个新增collab装配依赖。参照已有review-comment构造器做法，真实import并注入 createCollabStore、createCollabAuthority、createCollabService、createCollabRoutes。四个须是实际模块导出，不用空stub、不抄第二份send wrapper、不修改生产装配顺序/权限、不截掉collab片段。

保留全部既有Stop断言、超时语义、Browser确认前不发Pi、clear_queue→abort顺序、权威idle后解除屏障、503安全文案等，不删断言/改skip/放宽预期。新store/service构造目前lazy，无路由访问不I/O；本Stop fixture不执行collab端点，不借此编造新的collab通过证据。

真实运行与回归由Codex统一完成。请只交最小依赖注入diff、说明未运行项和是否还有片段内缺失引用。此为测试基础设施修正，不是第四轮生产功能审查，不开启新产品功能修复循环。

## 同步交付：验收报告由你整理

用户再次要求“活让他们干，主Agent只审批派任务”。除上述两个Stop测试文件，现额外授权只在你的backend工作区编辑 docs/Z4-2-acceptance.md（已复制主Agent旧草稿）。不要修改integration文档，不运行终端/测试。

请先完成Stop依赖补齐并单独回报，随后整理验收报告，避免报告工作延误续跑。主Agent统一真实运行、提交和集成；不要自行执行命令。报告以integration的docs/Z4-2-reviews.md、contract.md、coverage-audit.md和实际源码为准，不以你backend旧的public局部变量命名作为最终代码。

确定事实：
- 最终产品源码固定5388c1be155a0b86f9ed2c903669d31d63ce50d1；f66ef8b为挂载，51a47f1为纯局部变量el→domNode，生产Pi/RPC/Z3/依赖锁未改。
- ZCode来源f4d1b0e4b010fbb457e77d6b9404cdded4e7e908→集成51a47f1c3ec503361e448f33cc10741ed5136027；产物探针/审计ad65e14c1469dd62ac2478ac1163f1ae5bb53ccc→705a1d77e6b0416c62c63ccae92486bd9de802c5；你的Electron来源1e3c48dbb667116e11b6d95202b6f6cb762dc354→0939919753745a994e099f4bbd82ed8e5fc0a748；5388c1b为补充专项alias。
- Codex主工作区定向实跑：prototype49；doc56 assert135；store53 assert149 skip1文件symlink EPERM；authority24 assert68；service13 assert58；HTTP7 assert28真实Router；canvas72 assert72；panel11 assert58。合计385检查（含prototype49，不是统一assert次数）。modules120；smoke1338，断言未删。
- 完整npm test初次f66在smoke1337/1338失败；第二次5388于15:14:39启动，15:50:15失败在gui-browser-stop VM缺新构造器，第153叶，前152叶已完成。现补齐两Stop测试，不改产品代码与同一208 canonical计划。主Agent将按docs/testing“累计验证”继续剩余56叶并重跑受影响/前置检查，不把失败/累计说成单次npmtest成功。最终结果/最终测试提交SHA仍PENDING，绝不能写已通过。
- Electron run6真实正常sandbox，46场景+1进程清理=47/47；9受控进程/残留0；100节点200边878ms；真实Runtime close/resume/项目A-B-A/Browser遮挡/浅色computed和PNG。12张原始PNG与摘要manifest已在integration docs/assets/z4-2。但Renderer拦截不能覆盖后端GUI自动Release检查；旧run6的全进程offline说法过强，不沿用。ZCode正在修测试专用Node fetch/http(s)loopback预载守卫并附隔离spy预检；新受保护Electron结果PENDING，最终图片/JSON将由主Agent替换。报告分别标UI已测与新离线资格待测。
- 离线重建最终产物：SEA102860800bytes/SHA2563d0409b02e7b6ba336287e0c5e2eb54306d3bb5e296e23b6a1b30f2a91408fbf；App exe246324736bytes；server.cjs2498545bytes/SHA25672e79f5fa9b274a4adbd09995c88e54f16eb1e18fd044face39db6474927972b。build:app -- --rebuild含SEA，已有缓存无下载。最终app-check26、exe-check49、packaged28均exit0。探针输出不可写与缺自身构建两项预期exit1已验证。
- 你的第三轮功能复审B0/I0/已知Note2；ZCode第二轮安全B0/I0/Nit1；均只读，未测试，不把作者数字当你亲测。旧scope close可能被拒、editor TTL30m/32LRU有界；真实Agent来源null阶段3仅研究/fixture，尚无真实闭环。
- 原main C:\pi-GUI仍c9ac555，4项原未跟踪内容原样保留，未push/PR/merge/tag/release，未覆盖安装版。具体原状态见原报告。

重整旧草稿的矛盾/过期pending，不要只是无限追加。保留尚未完成的canonical/守卫实跑两个明确占位，其余实测回填；包含任务/分支/来源SHA、文件清单（可按实际模块列）、场景/截图链接、测试命令/退出码/数量、已解决/残余限制/人工决定、可执行回滚路径。完整回滚可按主Agent最终提交序列逆序revert并重建，不删应用collab文档数据；当前未合并，启动原安装版即可回到原行为。

这是文档整理，不自行发出“代码验收通过/允许合并/发布”结论。最终两项结果落地后Codex只提供结构化数据给你，你再回填，主Agent做事实与链接审核后提交。不要编造未完成退出码或截图。

历史派发勘误：本任务包曾将八套件汇总误写为385；最终ZCode交叉核对确认49+56+53+24+13+7+72+11=285，检查项未减少，最终统计以验收报告为准。
