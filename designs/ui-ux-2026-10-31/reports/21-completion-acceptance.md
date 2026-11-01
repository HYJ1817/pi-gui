# Refined 第二轮补齐与最终验收

日期：2026-11-01。用户在首轮推送后要求继续完成剩余界面。本轮基于 `8908ff5` 后的未提交工作树，保留原业务 Owner、API、数据模型和依赖，并完成 Runtime、设置详情、原生截图与输入、模型渲染检查的补齐。

## 实际交付

| 部位 | 本轮结果 | 保留约束 |
| --- | --- | --- |
| Runtime 输入区 | 原 textarea、发送/停止动作和模型控件整合为稳定底部 Composer；15px 正文、760px 阅读轴、18px 圆角 | 草稿、滚动、Stop 屏障和 Owner 仍在原模块 |
| Runtime 模型与思考 | 可见 chip + 独立菜单；真实搜索、方向键、Enter/Space、Escape、离焦关闭 | 只投影 Pi 已确认值；会话、focusEpoch、完整 Owner 变化会让旧候选失效 |
| Runtime 内容 | 实时与历史助手正文复用 escape-first Markdown；历史角色/消息定位保持后端事实 | 不猜实时轮次、不把用户正文解析成 HTML、不虚构附件 |
| Runtime 退役 | 已关闭会话的空模型读回不再触发渲染异常 | 不改模型控制器、RPC 或会话存储 |
| 设置详情 | 供应商、认证、更新、诊断、日志、外观、快捷键改为中央设置详情 | 原表单 build/close/dispose 与 persistence/auth Owner 不复制；确认层继续独立 |
| 设置生命周期 | 切换/返回时释放旧详情；迟到诊断、保存和主题响应不能重写新页面 | Modal 只清理自身节点，不抢占中央页面的 `panels.providers` |
| 原生 Browser smoke | 截图前等待附着、几何与加载就绪；空图或 capture 异常硬失败 | 历史 `UnknownVizError` 根因仍未知，不宣称已修复 |
| 模型真实渲染 | 保留原 79 项，用真实折叠语义替代已不存在的箭头选择器，新增 8 项双主题/四宽度点击检查 | 没有为了测试重新添加装饰箭头 |

## 验证结果

| 证明层 | 结果 |
| --- | --- |
| Source Runtime | 七套 **430/430** |
| Runtime Electron | 正常 sandbox **168/168**，24 张截图，renderer errors=[]，关闭退役后仍无错误 |
| 设置 IA | `ui-ia` **26/26**；覆盖中央页、旧关闭回调、迟到诊断/保存和确认框返回 |
| 主 smoke | **1338/1338**，断言数量未减少 |
| 设置真实窗口 | **185/185**，53 张截图；1280/1440/1920、浅/深主题、键盘、错误/重试和 125%/150%/200% 页面缩放 |
| 模型真实渲染 | **140/140**；53 项契约 + 87 项真实 Chromium；原 79 项全部保留 |
| 原生截图 | 最终源码首次复验因历史 `UnknownVizError` 正确失败；独立复跑 **11/11**，并保留空图/延迟就绪红测。原生 PNG 587×963、9,103 bytes，根因仍未知 |
| Windows 中文输入 | **6/6**；真实拼音组合、候选确认、确认 Enter 不发送、Shift+Enter 只换行、普通 Enter 单次发送；DPR 1.5 |
| 独立打包窗口 | **7/7**，149 个 renderer 资源摘要一致，4 张截图，errors=[] |
| 打包后端 | **26/26** |
| 独立审查 | 三轮增量审查；修复后 Blocker 0 / Important 0 |

最终本地产物：`C:\pi-GUI\dist-app\refined-complete-20261101\dist-app\Pi GUI-win32-x64\Pi GUI.exe`。该 exe 是独立构建，不替换现有安装。

最终真实截图入口：[完成版图库](../completion-review.html)。关键证据：

- [设置窗口结果](../evidence/completion-settings/visual-sanitized-3/capture-results.json)
- [Runtime 汇总](../evidence/completion-runtime/results.json)
- [原生截图专项](../evidence/completion-native/README.md)
- [Windows 中文输入](../evidence/completion-native-input/results.json)
- [模型真实渲染](../evidence/completion-model/summary.json)
- [打包窗口](../evidence/completion-package/results.json)
- [打包后端](../evidence/completion-app-check.log)
- [本地产物摘要](../evidence/completion-build-manifest.json)
- [机器可读总览](../evidence/completion-summary.json)

## 真实模型最小调用

用户明确授权一次最小调用。实际只调用一次现有默认模型 `magpie / workbuddy/hy4-preview-f`，使用临时 HOME、临时配置和临时会话，禁用工具、扩展、MCP、Skills、上下文文件与缓存探测。

- **1 次**模型调用，**0** 个工具事件；Pi 确认了该 provider/model，agent 启动并返回助手消息。
- 回复没有逐字匹配固定的 `PI_GUI_UI_SMOKE_OK`，因此该检查失败，不把它改写成通过，也没有为匹配文案自动重试。
- 原始模型回答、凭据和 Header 不落盘；临时目录已删除，cleanupConfirmed=true。
- 记录：[results.json](../evidence/completion-one-model-verified/results.json)。

这证明现有 SessionRuntime → Pi RPC → 真实模型的最短链路能够启动并返回消息，但不构成完整 GUI/模型/工具 E2E。

## 完整 canonical

最终独立运行 `npm test` **通过，exit 0**。共执行 `package.json` 展开的 231 条 canonical 命令，耗时 4,639.44 秒；开始时和结束后源码/测试摘要均为 `8ef4ec46eb746509b22bf37ab9da3b8820690a33966fc41044d0b8c61de14931`，输入未变化。原始日志：[npm-test.log](../evidence/completion-canonical-final-3/npm-test.log)；机器可读记录：[run.json](../evidence/completion-canonical-final-3/run.json)。

前两次完整尝试均保留且未冒充通过：第一次在 `ci-results` 的 kill witness 超时，单测 **10/10**；第二次在 `session-revert-object-assets` 暴露 Windows 环境变量大小写测试注入错误，修复后 **23/23**。最终第三次在修正测试输入后重新从头运行并 exit 0。环境跳过仍为 21 项，未计入通过分子。

## 保留的边界

- 21 个既有环境跳过场景仍不进入通过分子：3 个符号链接权限、18 个 SACL/审计权限场景。
- 历史 `UnknownVizError` 根因仍未知；最终源码复验曾再次触发，独立复跑通过，记录不互相覆盖。本轮关闭的是可复现的空截图误报与就绪时序缺口。
- Windows 中文输入是实际 Computer Use + 系统拼音输入验证；不覆盖其他输入法、读屏器、触屏或所有硬件组合。
- 真实窗口 DPR 为 1.5；页面 zoom 1.25/1.5/2 已测，全部物理 DPI/显示器组合仍未遍历。
- 没有写用户真实项目/会话，没有安装替换用户现有程序，没有提交、推送、合并、打 tag 或发布。
