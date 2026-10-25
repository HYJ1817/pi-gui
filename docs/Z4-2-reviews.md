# Z4-2 独立审查与发现处置

审查规范见 [REVIEW.md](../REVIEW.md)。作者自测、外部审查、用户验收分别记录；本文件不构成合并或发布许可。

## 审查来源

- 第一阶段编码：内置 Codex 后端/画布协作 Agent，独立 Worktree/分支/提交；不是 Antigravity 或 ZCode。
- 用户随后要求这两个任务完成后停止子代理，改用桌面 Antigravity/ZCode。后续未续派或新增子代理。
- Antigravity：通过 Computer Use 操作实际桌面应用，在 pi-GUI 项目中新建独立会话“Z4-2 协同编辑协议审查”；明确只读、只读指定集成目录、不运行终端命令/测试、不修改文件、不启动子代理。首轮读取协议、纯数据模块、数据测试及服务层。
- ZCode：通过同一桌面工具新建独立只读会话“pi-GUI Z4-2 只读安全审查”，读取安全存储、authority、既有取证、HTTP、服务及故障测试，另核对组合根/Router/package。首轮结论“无可证实 Blocker，Important 2，另列设计后果 I-3，Nit 1”；未执行命令或测试。

## Antigravity 第一轮

审查时：数据模块基于 `183aa39` 加非纯空白 label 限制，服务层为未提交草稿。静态审查，无测试执行。原始报告结论“不通过”，分类 Blocker 1 / Important 4 / Nit 2。以下由主 Agent 按实际路径复核，保留原始分类但不盲从其结论。

| 编号与原始分类 | 复核与处置 | 证据 |
|---|---|---|
| F1 Blocker：混合新旧建议被 duplicate fallback 吞掉 | 原始触发链未成立：日志 exact 要求 op.baseRevision < 当前 doc.revision；完整 envelope 要求每项 base 等于 proposal.base；preview 又在 apply 之前拒绝旧 proposal.base。即先返回 stale-base，无法走报告声称的分支。额外移除冗余 fallback，明确只允许 every(exact) 快径 | `tests/collab-doc.cjs` 的 mixed previously accepted/new 回归实测返回 stale-base，文档不变；操作 schema 全批预检也先于任何幂等判定 |
| F2 Important：错误 scope 请求删除其他编辑器历史 | 已复现并修复。不再在 scope/token 不匹配时删除对应 entry，只拒绝请求 | `pi-gui-z4-2-service-scope-red.log`，修复后合法 scope 仍可用原 editorId |
| F3 Important：单次旧请求清空有效历史，阻断重复提交 | 已复现并修复。外部 doc revision 与 entry 不符才清历史；单次请求 expectedRevision 不符只拒绝。完整验证的全批 user 重放在同有效 editor 中返回 duplicate，不再次写盘或追加历史 | `service-review-red.log`、`service-replay-red.log`；服务测试证明 stale 请求后仍可正确 undo、重复提交 revision 不前进 |
| F4 Important：生产层不能打开 boundSessionId:null | 误报。纯数据构造态允许 null，不意味着允许未取证数据落盘。生产 create 在服务端 bindSession；store.write 拒绝 null/异 session，store.read 同样拒绝，服务层不能绕过存储放行。补充契约文字，保留 fail-closed | `server/collab-store.js` 的 boundSessionId 读写检查，`tests/collab-store.cjs` 的异 session/非法持久化用例 |
| F5 Important：FIFO 淘汰正在活跃的编辑器 | 契约未承诺 LRU，原始严重性偏高；可复现活跃实例被淘汰，按小范围改进修复。有效访问后移到 Map 尾部；错误 scope 不刷新顺序；读失败也不预先淘汰其他 editor | `service-lru-red.log`；容量 32、访问最早实例、再开第 33 个，保留活跃实例且淘汰最久未访问者 |
| N1：commitOperations 的 duplicate 状态分支不可达 | 已移除无用分支 | 数据层定向回归 |
| N2：用户批次被校验模拟两次 | 保留：第一遍是可信 user 入口和精确重放判定，第二遍提交到历史副本。两次均是有界纯数据操作，尚无性能失败证据；不为静态性能猜测新增事务 API。真实 100 节点时间在 Electron 验收记录 | 生产协议/资源上限；性能结果待 Electron 实测 |

作者额外红绿修复：重复接受必须显式提供合法 expectedRevision；长 opId 截断拼接会碰撞 proposalId，改用 UUID；关闭/切 scope 撤掉自己的删除确认且保留无关审批；写失败显示重新打开入口。

第一轮作者修复后的定向结果：数据 56/56、服务 13/13、面板 10/10。各数字为检查项，非独立审查者运行。后续增量复审与最终安全结论仍待记录。

### Antigravity 第二轮

实际桌面会话已返回“通过；Blocker 0 / Important 0 / Nit 0”。范围为 `1955926`、`aa67bc5` 数据/服务增量及前端组件首轮检查；复核跨 scope、历史、LRU、expectedRevision、UUID 与确认框归属，并确认拒绝未绑定持久化文档为合理安全设计。严格只读，未执行任何测试。

不继承超过其检查范围的结论：该报告没有检查稍后的 `03b4749` 短路径/切换事件修复，也尚未检查生产组合根挂载。报告中把作者提供的回归称为“实测”、把有界双重事务校验称为“消除冗余”，均不作为独立执行或性能优化证据；真实命令与实现以本文件及验收记录为准。

## ZCode 第一轮

| 编号 | 复核与处置 | 证据 |
|---|---|---|
| S1 Important：测试尚未注册 canonical，HTTP 尚未挂载 | 已知集成闸门待办；在完成原基线前保持生产入口不变。最终必须注册并以真实 Router/生产 Electron 复验，不把独立文件的定向成功冒充集成通过 | Router 红测实际 404 !== 405；最终接线/完整 canonical 待完成 |
| S2 Important 待验证：8.3 路径误拒 | 本机确有 8.3 别名，复现原 53de929 的 collab_storage_unsafe。修复为先保留原始拼写的祖先 lstat/禁止链接检查，再比较真实文件/目录身份，允许同一实体的短名与长名；没有先归一而抹掉 junction 证据 | 新真实短名用例；修复后存储 53/53，assertions149，skip1（文件 symlink 权限）。目录 junction/硬链/替换/读写故障矩阵全部保留 |
| S3 设计后果：异常退出残留锁后写入持续 busy | 保持 fail-closed，无自动解锁资格。修正文案，不再承诺稍后重试就恢复；明确关闭全部实例后需维护者检查。文档列人工恢复流程与字节备份，真正自动恢复另需设计和用户决策 | 实际 crash37/SIGKILL 测试拒绝下一次写，原文件字节不变；更新 collab_storage_busy 文案 |
| SN1：冲突后须重新 open | 按生命周期契约保留：外部 revision 变化丢弃历史，UI 明示重新打开；不是静默覆盖或安全缺陷 | 服务/面板冲突检查 |

短名回归的首次测试辅助器误用了 Node 对 cmd 参数的引号转义，生成了不存在的路径，不能作为产品红测。已修正为只读 cmd 的 verbatim 参数并断言别名真实存在；再以 53de929 原模块的临时副本重放新用例，取得有效红测。未把错误 fixture 当作产品缺陷证据。

资格限制保留：路径级 Node IO 与身份/时间戳复核不是对同 OS 用户恶意进程的强制独占证明；未证明断电、所有平台或任意原生 syscall 中断。安全审查不代替用户验收与合并批准。

## ZCode 第二轮安全增量复核

实际桌面 ZCode 于 2026-10-25 14:38 返回：本轮 Blocker 0 / Important 0 / Nit 1。只读复核 `03b4749` 与 `f66ef8b` 的短路径修复、组合根、认证/路由顺序、测试注册、面板代次/确认框边界与生产 source=null。未运行测试或构建；报告引用数字均为作者结果。I-1/I-2 已解决，I-3 作为明确的 fail-closed 设计限制保留。

Nit-1：切 scope 后 best-effort close 复用已捕获旧 Owner，authority 可拒绝该 close，旧 editor 条目由 30 分钟 TTL/32 上限 LRU 回收，而非立即服务端销毁。旧 token 不可复用、内存有界，不阻断；接受为记录的资源生命周期限制，没有为了清理能力而降低 Owner 取证。

本轮未重新检查 Canvas/Proposal 内部，未核验最终验收文档，也未做 Z3 的 Git diff 对比；上述范围仍由前轮功能审查、作者测试与最终交付检查分别提供证据。不得把本轮结论延伸为所有平台/断电/恶意同用户竞态资格。

## Antigravity 第三轮最终功能增量复审

实际桌面 Antigravity 在 2026-10-25 15:23 左右返回：Blocker 0 / Important 0 / Note-Nit 2，均为已知边界：旧 scope 的 best-effort close 依赖 TTL/LRU 回收，以及真实 Agent 建议来源仍未接入。范围为 `f66ef8b` 生产组合根/路由/会话工具挂载、`03b4749` 后续面板硬边界、`51a47f1` 纯局部变量改名与 `5388c1b` 测试入口；只读文件、未执行命令/测试。

该轮没有把其参与编写的 Electron 夹具作为对自身代码的独立审查。完整 canonical 当时仍运行，报告引用数字由 Codex 提供。其中协同检查汇总曾误报 385：ZCode 最终交叉核对发现算术错误，八套件实际为 49+56+53+24+13+7+72+11=285，检查项没有减少。其余 120/1338/47/28 为当时对应专项的作者实测；最终 Electron run7 为 49/49，见总验收。生产集成审查已在第三轮收敛；不据此提前宣称完整 canonical 通过、获得合并/发布授权，或证明所有平台/同用户恶意竞态/断电资格。

后续作者发现额外测试边界：原 Electron 夹具只在 Renderer 拦截外站，而后端 GUI Release 自动检查不读取 PI_OFFLINE；旧 run6 的真实 UI/进程证据保留，但不能沿用其“全进程仅 loopback”表述。交由桌面 ZCode 仅在测试夹具加入 Node fetch/http(s) 预载守卫；不修改生产网络策略。补强后的独立验证结果在总验收单列，不扩大本轮生产功能审查结论。
