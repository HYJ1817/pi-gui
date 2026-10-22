# T3-B 评论持久化：设计与实施边界

基线：`d81b3548ad6c93efdba36ee203f37c90f28e7867`。本轮仅本地实现和提交，不推送、合并或发布。

## 勘察结论

- T3-A 的 `diff-comments.js` 按前端作用域保留内存评论，200 条/作用域、2000 字/条、最多 20 个作用域；锚点包括路径、分区、行号、行类型、内容哈希、hunk 和 Diff 指纹。
- `currentReviewScope()` 的 cwd/session 字符串只适合运行期 UI 隔离，不作为磁盘身份。`review-fill.js` 保持追加、不覆盖、不发送。
- Runtime Registry 已持久保存 conversation UUID、workspace ID/epoch 和原生会话定位/文件身份；实例、generation、backendInstance 只用于当前请求防陈旧。
- 经典会话身份来自后端私有 `get_state` 与已有会话扫描器，工作区由当前 cwd、Worktree lifecycle 校验及 Git/root/admin 文件身份确认。尚未落盘且无法独立恢复的原生空会话不伪造永久身份。
- Worktree 删除重建会改变目录/admin identity，受控 Worktree 还须通过登记 epoch 校验。路径相同不能证明仍是同一工作区。
- `DATA_DIR = PI_GUI_DATA || 源码目录`；打包 Electron 将默认值注入 userData。源码 data 可能位于受审项目内，必须拒绝评论写入并指导用户显式设置项目外的 PI_GUI_DATA，不改变全局 data 语义。
- 现有存储普遍使用同目录临时文件、rename、串行队列和 schema 校验；评论需要额外保留损坏数据、CAS revision、跨实例排他和明确的 UI 提交结果。

## 方案

### 后端身份与接口

新增受现有 auth/Origin/token 控制的 `/api/review-comments`。GET 按需加载，POST 提交当前作用域的有界完整快照，不接收磁盘路径或 cwd。

经典请求携带当前完整 owner，后端私有读取原生会话并独立核对会话扫描结果及工作区；并行请求要求登记的 conversation、当前 focused owner 与 Workspace authority 一致。只信前端 sessionId/conversationId 不足以授权。

永久键由后端对稳定身份计算 SHA256：工作区身份和文件对象证据、原生会话身份；并行模式再包含持久 conversation ID。绝对目录只在服务端参与取证/哈希，不写入 JSON、文件名或日志。临时 owner 和请求 scope token 只阻止陈旧请求，不决定跨重启归属。

### 存储

固定 `<DATA_DIR>/review-comments/<scopeHash>.json`，首版 schema v1。记录只含 scope 哈希、revision、评论 ID、相对路径、受限锚点、正文与时间。不保存源码 snippet、完整 Diff、DOM、绝对路径或运行时句柄。

保留 20 个作用域、200 条/作用域、2000 字/条的容量政策；文件增加明确字节上限。所有磁盘记录与提交重新执行闭集字段、类型、范围和重复校验；不兼容版本/损坏文件不可被空列表覆盖。

操作前确认 data 与各级受控目录不是 symlink/junction，路径规范且文件对象身份未变化，存储不能落入受审项目、Git root/common 或已登记项目内。数据文件拒绝 symlink/hardlink、非普通文件、超限内容。错误仅返回闭集代码与脱敏说明。

写入采用排他事务锁、磁盘 revision 比较、同目录独占创建的临时文件、flush、替换前再次校验、rename。仅在替换成功后确认保存。失败保留有效文件并清理本次创建的临时文件；不删除其他实例的残留文件。上次中断留下的无法证明已释放的锁保守阻止写入，明确提示恢复不可用，禁止用 PID 猜测然后强行解锁。

### 前端生命周期

保留 T3-A 纯模型与行匹配规则，增加单独的持久化协调器。打开对应 Changes 后加载；客户端内存 scope 与后端稳定键分开，不将 UI scope 原样落盘。

恢复时所有评论先降为未验证；仅当前完整 Git Diff 能使锚点有效。缺失文件与隐藏上下文保留评论并使用原有过期/待确认状态；加载不主动展开新 Diff。

保存/修改/删除先准备快照，等待后端 CAS 成功后再更新已保存模型。失败保留编辑器正文，显示错误与重试；冲突不 last-write-wins，提供重新加载，用户保留草稿后决定下一步。作用域换代立即失效旧请求的 UI 落地权限；关闭面板不使旧响应修改新面板。

汇总弹窗说明跨重启保留与未保存草稿边界；复制/填入维持现有行为，不触发 Agent。

## 验证与提交

1. 完整高风险基线；在临时数据目录构造新增存储/authority/HTTP 失败测试，确认因缺少能力失败后实施。
2. 定向覆盖重建 store、编辑删除重启、身份变化、CAS 并发、损坏版本、超限、链接/目录替换、Windows 拒绝替换和中断残留。
3. UI 测试覆盖迟到加载/保存、会话切换、冲突保留正文、恢复未验证、缺失文件、两类分屏与填入不发送；保留既有断言。
4. 真实 Electron fixture 多次退出/重启，保存→恢复→修改→恢复→删除→确认删除；正常沙箱与 no-sandbox 分开记录。
5. 最终行为代码取得完整 canonical 证明，重建 App/SEA 并核对资源；按业务、测试、文档的回滚边界本地提交。

用户明确要求不使用子代理。功能与安全/故障路径由本 Agent 分别自审，不能称为独立审查；独立审查未执行须作为验收限制保留，后续合并/发布仍由用户决定。
