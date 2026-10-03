# P25.1 Real-world Hotfix 验收记录

日期：2026-10-03。基线 HEAD：`b7eebb36106aa31979e713605b0f6da7d42018c2`。
开始时本地 `main` 已包含 P25，工作区干净；工作分支为
`codex/p25-1-real-world-hotfix`。最终 HEAD 见交付消息（本记录本身也会形成提交）。
按项目不联网约定，没有 fetch、查询远端 Release、推送或真实 OAuth。
版本保持 0.18.1，没有 bump、tag 或 release；真实 Pi 凭据未修改。

## 根因与最终修法

| 项 | 根因 | 修法 |
|---|---|---|
| H1 | 内部数字 response resolve 后仍向 SSE publish；前端假定 ID 是字符串 | compatibility 仍观察，上游响应在后端 pending 闭环；超时晚响应也不外发。Web 命令禁止占用数字 ID；前端两处 startsWith 均做字符串类型判断 |
| H2 | Agent Pi adapter 独立扫描 npm 全局目录，与主聊天 PI_BIN 分叉 | 组合根注入同一 piLaunch；新增仅后端 cliEntry，复用已有受控 CLI entry 构造；缓存按 launch identity。Registry、Planner 与 Diagnostics 使用同一目标，不回退其它安装 |
| H3 | write/edit 事件账本被称为“仅本次会话”，暗示包括 bash 修改 | 改为“本会话编辑”，UI 直接说明 write/edit 范围及终端修改应在“全部”查看；不分析 shell 字符串 |
| H4 | Pi 与 bash 继承环境 Provider key，但文档没有讲清信任边界 | security 与 provider-auth 文档同步说明继承、最小权限 key 和工具可信要求；保留 Provider 认证能力与 PI_GUI_TOKEN 剥离，不增加凭据投影 |
| H5 | 原始 export_html 未传 outputPath，默认在项目 cwd 写 HTML | 分享、更多菜单共用后端下载入口；先证明 outputPath 能力，在项目外随机临时目录直接生成；校验返回路径、文件类型、大小、workspace/bridge identity；成功失败均清理。禁用原始 Web export 命令，不接收任意服务器路径，不回退 cwd |
| H6 | 空列表提示引用了隐藏菜单中的添加按钮 | 只在项目列表为空时直接显示“+ 添加文件夹”，点击复用 openDirPicker；有项目时保持三点菜单布局 |
| H7 | DELETE 清 active 却保留 runtime cwd，bridge 继续旧项目 | 以 runtime 路径判断是否当前项目，复用聊天/Planner/Verifier/维护动作闸门；当前项目移除先持久化，再 cwd=null、停止整棵 bridge 进程树并进入 no-project。前端串行 workspace transition、增加 generation、清旧 thread/model/usage/Git/附件/关联任务并回读状态；旧 bridge ready 与旧会话响应失效。非当前项目不重启；重新添加不自动激活 |
| H8 | Web 永远显示没有能力执行的“打开” | 仅有 desktop.openPath 时显示该按钮；Web 文件主行继续展开/收起差异；二进制与截断提示按能力分别说明 |

两项不变量：UI 当前项目与 runtime/bridge cwd 同源；后端内部 RPC response 不属于 Renderer SSE。
用户级认证 flow 不随当前项目关闭取消，Auth runtime 继续通过内部 Promise 回读模型状态。

## 修改文件

- 后端：`server.js`、`server/rpc-bridge.js`、`server/projects.js`、`server/pi-launch.js`、
  `server/agents/index.js`、`server/agents/pi.js`、`server/router.js`、新增 `server/session-export.js`。
- 前端：`public/api.js`、`public/app.js`、`public/rpc.js`、`public/projects.js`、
  `public/sessions.js`、`public/git.js`。
- 测试：新增 `tests/hotfix.cjs`、`tests/hotfix-ui.cjs`、`tests/hotfix-shot.cjs`；
  更新 `tests/provider-auth-runtime.cjs`、`tests/planner.cjs`、`tests/smoke.cjs`、
  `tests/visual-harness.cjs` 与 `package.json` 唯一测试入口。
- 文档：`docs/security.md`、`docs/provider-auth.md`、`docs/testing.md` 与本记录。

## 验证证据

- 开始时 `npm test` 基线 exit=0；原有 44 套件保留，新增 2 套件后共 46 套件。
- 独立 hotfix：后端 22/22，UI 10/10。
- P25：认证 105/105，runtime 33→36/36；真实打包 Electron 后端/worker 115/115。
  包含公开 ModelRuntime SDK、秘密隔离、login/logout 回读、single-flight、stale、
  模型同步、model=null 清旧状态与项目关闭后用户级 flow 保留。
- smoke 1324 条保持不变；三条旧行为断言更新为 Web 可执行动作与路径不外泄，未删除。
- modules 117/117；Planner 115 passed, 0 failed。
- `npm run build:app -- --rebuild` exit=0：SEA 94.1 MB；Electron 整包 327.3 MB。
- `npm run test:app` 25/25；六个受影响前端文件与打包静态资源逐字节一致。
- 六张真实 Chromium 截图在 `.shots/p25-1/`，覆盖 Web/desktop 能力、700/900/1200px、
  空项目欢迎区、可见侧栏 CTA 与既有目录选择器；无页面异常或横向溢出。
- 最终 `npm test`：46 套件完成，exit=0，332.14 秒。
  独立 `npm run test:ui`：1324/1324，exit=0，76.32 秒。
  原始日志为 `.workbuddy-ai/p25-1-final-test.log`、`p25-1-final-ui.log` 与
  `p25-1-final-timing.json`（开发机本地文件，不入 Git）。

## 失败记录与限制

单文件 EXE 实跑为 **27/40**。13 条失败由本机 SEA 程序对临时目录写入的
`EPERM` 引起，涉及项目配置与上传目录。Electron 应用与打包 Auth 检查通过；
没有删除断言、放宽阈值或将该 gate 标为通过。Windows SEA 完整验收仍阻塞，
需要在允许该可执行文件写 fixture 的环境重新验证。未执行 Installer 发布 gate，
本轮不发版。

首轮 Planner 取消 fixture 两次失败：孙进程已退出，但原固定 2.5 秒写入发生在
取消完成前。修正 fixture 为等待 PID 身份，取消完成后才释放写入信号；
仍同时断言孙进程不存在和没有写出文件，不修改产品取消逻辑或放宽时间阈值。
另一次完整测试被视觉 harness 占用默认端口干扰，该次不计为通过。
截图 harness 改用 18797 独立端口，验收串行执行。

完整测试还捕获并修正了新 child 重复重启防护回归，保留现有 reliability 检查。
所有失败日志保留在本地 `.workbuddy-ai/p25-1-*.log`，不纳入公开提交。
