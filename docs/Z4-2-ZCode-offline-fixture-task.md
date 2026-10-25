# 桌面 ZCode：修正 Electron 离线资格边界（只改测试）

根因已由主 Agent 读码核实：public/app.js 调用 initUpdateAuto，public/update.js 延迟8秒请求 /api/update；server/update-check.js 默认 globalThis.fetch 公开GitHub。PI_OFFLINE/PI_GUI_OFFLINE只在server/pi-update.js读取，不能阻止GUI Release检查。现有Renderer webRequest仅阻止Renderer外站，不能阻止后端Node外站fetch。此前run6的47/47/真实截图有效，但“全进程loopback-only”资格不成立，不能沿用该范围声明。

工作区 C:\Users\21022\.codex\worktrees\z4-2-canvas\pi-GUI，主Agent已cherry-pick Antigravity来源1e3c48d，三个Electron文件现已在你的独立树中。只允许写：
- tests/fixtures/z4-offline-network.cjs（新增）
- tests/fixtures/z4-collab-electron.cjs（修改）
其余生产源码、public、package、原有doc/canonical测试只读。不启动子代理，不用终端/测试，不联网，不推送/PR/merge/tag/release。Codex统一执行真实用例。

最小实现：新增测试专用Node预载CJS守卫，在任何业务模块加载前包装globalThis.fetch及node:http/node:https的request/get，URL/Request/string/options等常用形状只准127.0.0.1、localhost、::1（解析后hostname），拒绝其他主机必须发生在原方法/DNS之前。支持真实loopback控制器与假Pi guard，禁止把文档/Owner/HTTP协同响应换成mock，不改任何生产模块。不要试图提供OS级sandbox或覆盖任意本机恶意socket的保证。

将守卫通过Node --require参数用于fixture backend启动，并在现有pi.cmd shim中把相同--require放在cli之前，确保fake Pi/Runtime路径也预载。不要设置用户全局NODE_OPTIONS；仅当前fixture env/argv。TRACE由fixture在world下给出绝对路径（Z4_NETWORK_TRACE），守卫写前确认路径属于os.tmpdir，未提供/不安全路径须固定码拒绝，绝不默认写项目目录。

只记结构化安装/阻止计数（API种类、固定事件），不记URL、hostname、token、请求正文、真实路径。可用小JSONL trace供父fixture读取；注入子进程环境。实际自动版本检查应在8秒后产生blocked fetch，后端仍按现有失败降级静默运行。

在fixture最终结果加networkGuard字段，明确覆盖Node fetch/http(s)与Renderer webRequest；新增有价值的check证明guard已实际预载、至少一次真实后台更新外网尝试被阻止。原有47项全部保留，不降低sandbox或错误检查，不因新增守卫伪造生产文档。检查窗口过程超过8秒，所以可观察真实自动check，若不能观察到必须报告而非虚造。

本轮仅补充测试证据，不更改产品网络策略，不使canonical新增叶。禁止清除旧失败记录或把之前说成已阻止后端请求。完成后说明文件和未实测范围，主Agent审diff并以全新输出目录重跑Electron。
