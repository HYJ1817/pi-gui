# Z4-1—Z4-6B 完整功能审计

审计日期：2026-10-26（上海时间）。作者：本轮唯一 Codex；不是独立代码验收。
被测生产基线：`db2bbf2e88801c01940484e6ba4ea920e0256722`；实际main合并后已安全集成`c7fbad65500e1c20b6084f421c7920d8f77ffbc6`，两者Git tree均为`c2a8b1ae49ac759690ebf355bff8f4946aede514`。集成后collab21套及产物40项重新通过。
本轮不修改 lib/server/public/electron、package.json、锁文件或 CI。新增内容仅为显式执行的打包窗口验证脚本、报告和证据。
最近结果仅引用本轮运行和本轮取得的同 attempt artifact；不把 Z4-6A 旧截图当新证据。

## 证据索引和判读

- `C`：[本地 canonical 日志](evidence/z4-6b/canonical.log) 一次npm test退出0（4,790,986ms），221叶；协同21套全部通过，集成后[21套再验](evidence/z4-6b/integrated-collab.log)。测试文件均在 `tests/`，原型例外在 `prototype/z4-1-collab/`。
- `E`：[正常沙箱生产组合根窗口](evidence/z4-6b/electron/results.json)，55/55（54 场景 + 1 进程清理），fake Pi；`tests/collab-electron.cjs` → `fixtures/z4-collab-electron.cjs` → `z4-collab-scenarios.cjs`。
- `P`：[正常沙箱生产力装配窗口](evidence/z4-6b/productivity-electron/results.json)，35/35；不是生产后端组合根，Pi 未参与。
- `A`：[正常沙箱高级编辑装配窗口](evidence/z4-6b/advanced-electron/results.json)，6/6；多选用人工 PointerEvent/MouseEvent，不能称系统输入。
- `R`：[真实 Pi 控制面](evidence/z4-6b/real-pi.json)，Pi 1.4.0、9/9、modelCalls=0；Runtime 是 production session-runtime adapter，非 Registry 模型 E2E。
- `G`：实际独立构建的 App 窗口，[自动完整流程27/27](evidence/z4-6b/packaged-gui-verified/results.json)、[含Windows系统输入28/28](evidence/z4-6b/packaged-os-input/results.json)，两次启动进程族8/11、残留0/0。脚本为 `scripts/verify-collab-packaged-gui.mjs`，本地提交c209832。使用fake Pi、loopback Inspector/CDP及前置离线guard，实际偏好sandbox/contextIsolation=true、nodeIntegration=false。Computer Use系统鼠标+Right令n2磁盘x+10、revision+1；Ctrl/Shift/多选等由CDP原生输入覆盖，非物理HID实验。
- `CI`：[PR35 同 attempt 重新校验](evidence/z4-6b/ci-attempt1/revalidated-summary.json)，run40287018398/attempt1，221/221；实际 checkout `a4a13b168219abc48694b30e0f02d8dfc80a4ad1` 与上述生产代码 tree 相同。它不是本轮最终提交或 main push CI。

下表的“Electron”写具体层和场景；“真实 Pi”只证明 R 明确执行的控制命令。全部“真实模型”均为**未验证**，没有授权发送 prompt。`CI` 只作为表中定向结果的完整基线补充。

## 1. 基础协同文档

| 功能 | 实现文件 | 验证入口及本轮最近有效结果 | Electron | 真实 Pi | 真实模型 | 残余风险/语义 |
| --- | --- | --- | --- | --- | --- | --- |
| 创建 | lib/collab-doc.js；server/collab-service.js/create；public/collab-panel.js | collab-doc 56/56；service 13/13；E 新建3节点2边 | E 实际落盘；G另列 | 未验证 | 未验证 | 打开面板不隐式创建；需显式点击 |
| 打开 | server/collab-store.js/read；service/open；panel | store 53/53；panel 11/11；E 无文档/重开 | E | 未验证 | 未验证 | 每个已验证 scope 一份文档 |
| 保存修改 | service/operations；store/write；panel/submitIntents | service 13/13；HTTP 8/8；E 修改文本/坐标落盘 | E | 未验证 | 未验证 | 自动保存受控操作，不是整文档覆盖 |
| 关闭与重开 | panel/onDispose；service/close | panel 11/11；E 重开与原字节相同 | E | 未验证 | 未验证 | undo/redo 内存历史重开清空是契约 |
| 会话及工作区绑定 | server/collab-authority.js；review-comment-authority.js；store/boundSessionId | authority 24/24、68断言；E Classic/Runtime与A/B/A | E | R 仅新会话身份，不证明collab落盘绑定 | 未验证 | 不接收 renderer 路径/scopeHash；generation/epoch变化失效 |
| revision/CAS | lib/collab-doc.js；store/write；service expectedRevision | doc56；store53（双实例/双进程）；HTTP8；E stale UI拒写 | E 并发推进revision | 未验证 | 未验证 | fsync临时文件+身份复核+rename；不声称多文档原子性 |
| 撤销 | lib/collab-doc.js/undo；service history clone | doc56；advanced89；E 文本/拖动/Agent撤销；P布局撤销 | E/P | 未验证 | 未验证 | 持久化成功才发布历史 |
| 重做 | lib/collab-doc.js/redo；service history | doc56；service13；E 坐标重做 | E | 未验证 | 未验证 | 关闭、外部revision变化、重启不保留历史 |

## 2. Agent 协作

| 功能 | 实现文件 | 验证入口及本轮最近有效结果 | Electron | 真实 Pi | 真实模型 | 残余风险/语义 |
| --- | --- | --- | --- | --- | --- | --- |
| 生成建议 | server/collab-proposal-source.js；server.js channels；service/dispatchPendingGenerate | source32/32、170断言；flow12/12；panel-agent9/9 | E Classic及Runtime生成 | R仅通道ready，未发送prompt | 未验证 | source在authority锁外发送，身份反复复核 |
| 来源鉴别 | source observeClassic/observeRuntime；rpc-bridge.js；runtime-registry.js | source32；authority24；HTTP8 | E fake协议及真实生产tap | R启动/bridgeRun恢复；活跃事件顺序未测 | 未验证 | 仅最终assistant围栏；不信任模型actor/session自述 |
| 建议轮询 | public/collab-panel.js/pollStatus | panel-agent9/9、98断言；慢请求在途峰值1 | E Runtime建议可预览 | 未验证 | 未验证 | 一次在途；旧sequence及context校验保留 |
| 只读预览 | service/preview；lib previewProposalReadonly；collab-proposal.js | flow12；canvas72；E预览前后磁盘不变 | E | 未验证 | 未验证 | 预览不推进权威revision |
| 明确接受 | service/accept；lib acceptProposal；store CAS | flow12；service13；E两个通道明确点击后落盘 | E | 未验证 | 未验证 | 接受与用户操作共用CAS和历史 |
| 明确拒绝 | service/reject；queue settle | flow12；stability4/4中40轮拒绝后字节不变 | 未单独实窗验证拒绝 | 未验证 | 未验证 | 后端终态，不仅隐藏按钮 |
| 拒绝后不可再接受 | service terminal matrix；queue/get | queue10/10、53断言；flow12；40轮拒绝→accept抛错 | 未单独实窗验证 | 未验证 | 未验证 | accepted/rejected幂等各自限定，不可逆转终态 |
| 生成中停止 | source failAttempt；rpc-bridge abortAndWait；stop-barrier | source32、flow12；CI包含stop-barrier17及gui-browser-stop12 | E未专门覆盖运行中停止 | R空闲Stop两个通道通过；运行中未测 | 未验证 | fake停止不能替代真实模型中止 |
| 迟到消息防护 | source完整identity/bridgeRun；registry belongs；panel sequence | source32、authority24、panel-agent9；CI runtime-events14 | E 切换/恢复场景；不等于真实模型迟到事件 | R恢复推进bridgeRun；未测活跃迟到模型帧 | 未验证 | 旧owner/token/generation不得污染新会话 |
| Classic/Runtime隔离 | server.js tap；authority；runtime-registry；panel context | E独立文档、接受建议不改Classic字节、关闭旧Owner拒写 | E | R独立session-runtime会话；非registry模型E2E | 未验证 | 各层证据分列，不能互换 |

## 3. 图形编辑

| 功能 | 实现文件 | 验证入口及本轮最近有效结果 | Electron | 真实 Pi | 真实模型 | 残余风险/语义 |
| --- | --- | --- | --- | --- | --- | --- |
| 单选 | public/collab-canvas.js/choose；collab-selection.js | canvas72/72；selection37/37；E真实pointer拖动 | E | 未验证 | 未验证 | 选择是视图状态，不持久化 |
| 多选 | canvas pointer/click/focusin；selection | advanced89/89、96断言；z45-regressions41/41 | A人工事件；G原生输入另列 | 未验证 | 未验证 | 人工dispatch不是系统鼠标 |
| Shift框选 | canvas box drag；selection | advanced89；z45-regressions41；G原生Shift框选3节点通过 | G28/28中的CDP框选；A没有完整框选场景 | 未验证 | 未验证 | 不能由6/6高级夹具推定全部交互通过 |
| 批量拖动 | canvas effective delta；selection | advanced89；z45-regressions41，相对位移及边界夹紧 | E单节点；G多选另列 | 未验证 | 未验证 | 拖动结束一次提交，预览无写入 |
| 批量删除 | canvas remove；lib闭集批操作 | advanced89；z45-regressions41；E单条删除明确确认 | G批量另列 | 未验证 | 未验证 | 引用边先删，一批事务，一次撤销 |
| 复制 | canvas copySelected；selection serialize | selection37；advanced89；stability40轮 | G快捷键另列 | 未验证 | 未验证 | 应用内部结构化剪贴板；不读取系统富文本 |
| 粘贴 | canvas pasteClipboard；lib ops | advanced89；stability40轮；>50整体拒绝 | G快捷键另列 | 未验证 | 未验证 | 新ID、容量/边引用检查；不执行剪贴板代码 |
| 节点对齐 | canvas applyAlignment | advanced89；z45-regressions41 | A仅表单出现；G应用另列 | 未验证 | 未验证 | 单批超过50拒绝，不拆分保存 |
| 快捷键 | canvas keydown | canvas72；advanced89；z45-regressions41；G系统Right与CDP Ctrl C/V通过 | G28/28；系统SendInput一鼠一键，其余CDP | 未验证 | 未验证 | 输入框不抢编辑快捷键；无物理硬件HID实验 |
| 自动布局 | collab-auto-layout.js；collab-canvas-productivity.js | auto-layout51/51；productivity61/61；P确认单批及撤销 | P；G另列 | 未验证 | 未验证 | 不改变图形schema；超限明确拒绝 |
| 布局预览 | collab-layout-preview.js；productivity renderPreviewGraph | layout-preview44/44；panel-productivity14/14；P预览不保存 | P；G另列 | 未验证 | 未验证 | revision变化不能应用过期布局 |
| SVG导出 | collab-export.js；panel/downloadExport | export48/48；productivity61；P深浅主题、XML转义、URL清理 | P；G实际下载另列 | 未验证 | 未验证 | 闭集SVG，无HTML/脚本/外链；捕获源revision |
| PNG导出 | export renderPng；productivity runExport | export48；productivity61；P成功21次、魔数/IHDR及超大图拒绝 | P默认Chromium renderer；G另列 | 未验证 | 未验证 | 单边≤16384、≤16Mi像素；不代表总RSS上限 |

## 4. 生命周期、失败与资源

| 功能 | 实现文件 | 验证入口及本轮最近有效结果 | Electron | 真实 Pi | 真实模型 | 残余风险/语义 |
| --- | --- | --- | --- | --- | --- | --- |
| 项目切换 | panel invalidate；authority workspace锁；projects/worktrees | E实际A/B/A恢复、原源码及文档字节保持 | E | 未验证 | 未验证 | workspace事件同步清旧控件 |
| 会话切换 | panel context/signature；source dropScope | panel-agent9；E Classic/Runtime切换 | E | R new_session新身份；非collab UI | 未验证 | 异步返回必须重新核对能力 |
| Runtime关闭/恢复 | runtime-registry.js；runtime-state.js；panel | E关闭后旧Owner拒绝，恢复后空undo历史、文档保留 | E | R adapter dispose cleanupConfirmed；未测registry恢复 | 未验证 | 不自动恢复在途建议 |
| 面板销毁 | panel onDispose；canvas/productivity destroy | stability4、843断言：40轮URL/timer/interval/被跟踪监听器归零 | E关闭重开；P导出内部URL归零 | 未验证 | 未验证 | jsdom资源计数不等于Chromium全部内部资源枚举 |
| Pi退出/恢复 | rpc-bridge.js；pi-supervisor.js；source bridge_status | source32；CI runtime/fault链；R异常退出→bridgeRun增长 | E fake生命周期 | R Classic异常恢复及Runtime监督清理 | 未验证 | 真实运行中模型崩溃恢复仍未测 |
| HTTP失败 | collab-routes.js；api.js；panel request | HTTP8；panel11；panel-agent9；panel-productivity14 | E实际CAS冲突；未在实窗注入断网 | 未验证 | 未验证 | 不确定保存结果后只读，需重开核对；不可盲重试历史 |
| 服务端重启 | store/read；service内存editors；source内存queue | store53；flow12；stability40轮新service重开 | G真实App重启另列 | 未验证 | 未验证 | 保留文档；清编辑器、队列与undo历史 |
| 资源释放 | panel revokeDownloads/stopPolling；canvas listeners；supervisor | stability40轮；P35；E observed9/residual0；R全部退出 | E/P；G另列 | R cleanupConfirmed=true | 未验证 | 短程检查，未宣称小时级长期稳定 |

## 5. 安全收口

重新检查的关键链：Renderer 意图 → Origin/Token → collab authority（复用完整 review authority）→ service/editor key+token+revision → lib整批严格校验 → store锁/路径/身份/CAS/flush/rename。建议入口只能由后端 tap 采集正式事件，HTTP只能引用服务端 proposalId。未经明确接受不写权威文档。

本轮已运行 collab-store 的路径替换、锁残留、损坏UTF8/journal/版本、flush后异常exit/kill、真实双进程CAS及Windows文件占用；53/53，另1项symlink权限skip，不计入通过数。没有降低权限、CAS、来源、事务或沙箱标准。Windows mode 0600/0700不等于已经单独取得所有Windows ACL攻击场景资格；当前证据限于既有路径/身份/故障用例。

所有 UI/服务写入均为 TEMP 合成数据；实际项目只做只读 Git/源文件检查。本轮没有新数据格式、迁移、外部模型调用或用户源码写入路径。真实模型人工 smoke 与剩余准入门槛见 [最终验收报告](Z4-6B-final-acceptance.md)。
