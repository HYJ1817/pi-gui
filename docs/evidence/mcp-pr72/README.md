# PR #72 MCP 管理与市场截图

由 `node tests/mcp-visual.cjs` 生成，真实 Chromium + 真实前端渲染路径，
数据来自 `tests/visual-harness.cjs` 的离线夹具；不读写用户的 `mcp.json`，
不访问 Registry。

| 文件 | 内容 |
|---|---|
| `01-my-services.png` | MCP 服务器管理页：全局 / 项目分组、连接状态、操作入口 |
| `02-add-modal.png` | 新增服务器弹窗：基本字段与命令表单 |
| `02b-add-exposure.png` | 新增服务器弹窗下半部分：`exposure` 选择、超时、保存后启用 |
| `03-market.png` | MCP 市场：来源、搜索、分类、条目命令模板与已配置状态 |
| `04-install-preview.png` | 安装确认：服务端模板生成的命令预览、安装 scope、安全边界说明 |

注意：这些图验证排版与交互入口；服务端命令构造、DNS 固定、Registry
schema 适配与连接三态由 `npm run test:mcp` 和受控真机验证覆盖。
