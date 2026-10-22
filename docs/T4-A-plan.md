# T4-A 最小实施方案

基线 `062c87c155984ba9bddab52cac59234300fb498d`；准确 main push CI
[39796797262](https://github.com/HYJ1817/pi-gui/actions/runs/39796797262) 成功。
独立 Worktree / `codex/t4-a-review-task-preview`；不改主工作区、不使用子代理。

1. 复用 `git.js` 现有审查弹窗、`diff-comments.js` 的位置状态和
   `review-fill.js` 的经典/并行输入框安全追加。新增纯任务投影与弹窗内两步 UI，
   不建执行框架或存储系统；先模型失败测试，再实现，再验证 UI 与原回归。
2. 默认选中当前已确认意见；过期/待确认仅查看，不提供参考意见强行纳入路径。
   按 ID 保留所有意见（包括单行/区间重叠），文件归组，分区和旧/新坐标准确表达。
   引用数据用 JSON 字符串，12000 字容量整体拒绝，不静默截断。
3. 快照绑定项目、实际 Worktree、会话、owner、workspace generation、评论存储 revision、
   所选评论与临时 Diff 证据代号。刷新开始便撤销旧确认；复制/填入前重新校验。
   变更后清空旧任务文本，须返回选择重新生成；不自动重建并提交。
4. 定向验证模型/UI、原 T3 与持久化边界，再以真实 Electron 临时 Git fixture
   验证选择/返回/填入/草稿、四档宽度、Specs 与原生 Browser 分屏及 A/B 隔离。
   自审功能、安全与故障路径，补失败复现；自审不充当独立验收。
5. 冻结最终行为与测试提交后，运行当前 npm test/lifecycle 动态展开的完整 canonical
   分组；离线重建 App/SEA、检查产物。验收记录与少量截图单独提交。

不改 schema、锚点匹配算法、稳定 scope、权限、Pi/Planner/RPC、依赖、CI gate、
版本或发布机制。不推送、不合并、不打 tag/发布。T4-B 的隔离执行与真实补丁预览另行设计授权。
