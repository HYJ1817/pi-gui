> 第三轮归档：本目录原始截图数量、JSON manifest和结果列表属于历史运行全集；精简后的本地代表图与完整归档地址见[清理报告](../repository-cleanup-report.md)，原全集固定为 `ff6f22e26caae540cd050cbcd89c78f84c1e05cb`。结构化原始结果未伪装成新运行结果。

# 历史证据与临时输出

2026-11-06 第二轮清理移除了部分历史 UI 截图和重复完整日志；每个清理阶段保留两张代表图，所有现有 JSON 记录、最终报告和安全/事务证据保留。JSON 中的历史截图清单可能指向已归档图片，不是当前 checkout 的文件清单。

原始文件可从固定提交 [2e70463](https://github.com/HYJ1817/pi-gui/tree/2e70463183218ddf3a10972789667d6be5c294df/docs/evidence) 追溯。具体范围、验证和当前树大小见 [仓库清理报告](../repository-cleanup-report.md)。归档不代表当前测试通过。

## 后续证据规则

- 新截图、完整 `npm test` 日志、阶段性 JSON 默认写入唯一的 TEMP 或 `.shots/<任务>-<唯一标识>/`。已有测试支持的输出环境变量优先使用，例如 `T1_SPECS_EVIDENCE_DIR`、`T2A_EVIDENCE_DIR`、`T2B_EVIDENCE_DIR`、`T3A_EVIDENCE_DIR`、`G2_SMOKE_OUTPUT`、`Z44B_OUTPUT`、`Z45_OUTPUT`、`Z51_OUTPUT`、`Z53B_OUTPUT`、`Z5_FINAL_OUTPUT`；指定绝对输出目录可避免进程工作目录差异。运行前以测试脚本实际变量为准。
- 旧脚本仍可能默认写本目录；忽略规则阻止新截图/完整日志和 `results*.json` 被误提交。已有跟踪文件会继续被 Git 检测，运行后必须检查 diff，避免把旧验收记录替换成新运行。建议先设置上述独立输出目录。
- 完整日志用 PowerShell `npm test *> <独立忽略目录>/npm-test.log` 保存；提交摘要、失败原因、复现命令、必要失败图和对应 SHA，不按轮次复制全部输出。当前视觉基准/fixture 放在专用测试源目录，经过显式审阅后添加，不能靠忽略规则代替审查。
- CI 已用 Actions Artifacts 保存五组结构化结果及汇总，保留 7 天；不新增重复 workflow 或第二份测试清单。长期必需的失败证据仍需随精简报告有意保留。
- 清理只针对有归属记录的独立任务输出；先检查进程和文件句柄、Worktree 登记、可靠归档及最新修改，再列出明确文件。运行中的目录、用户数据、凭据、共享依赖、Git 对象和来源不明目录保持原状。禁止按全盘、宽泛前缀或单凭年龄自动删除。

本轮没有加入后台清理服务，没有改动测试断言或测试入口。
