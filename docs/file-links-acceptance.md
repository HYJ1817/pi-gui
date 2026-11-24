# 会话内文件引用与工作区外访问验收材料

- 目标与交付：在上一版「会话内文件引用」之上，完成外部验收反馈的五项修复、
  工作区外文件授权（单文件 / 目录 / 会话级 / 长期目录）、外部编辑器配置
  （设置 → 通用）、同名文件选择器与异步缓存/生命周期加固。功能与边界说明见
  [file-links.md](file-links.md)，独立审查与真实桌面验收结果见下文。
- 身份：before HEAD `9bba6a7d26224d388a5910fbc1408bbc3ad99aae`
  （`文档(conversation)：记录文件引用功能边界与验收材料`）；after HEAD 为包含
  本报告的交付提交，可用 `git log -1 --format=%H -- docs/file-links-acceptance.md`
  解析；分支 `feat/compact-attachments`，更新既有 PR #111。
- 参考实现：T3 Code `a7a6126a7d9b364c0fbef3f7fe1a087c4b004393`（2026-11-24 的
  `main`），具体源码位置见 [file-links.md](file-links.md#一识别规则) 顶部列表；
  未按截图仿制。
- 修改文件（相对 before HEAD）：
  - 前端：`public/file-link-model.js`、`public/markdown.js`、`public/file-links-ui.js`、
    `public/file-links.css`、`public/file-actions.js`、`public/api.js`、
    `public/app.js`、`public/appearance.js`、`public/files-panel.js`、
    新增 `public/editor-settings.js`
  - 后端：`server/files.js`、`server.js`、新增 `server/external-grants.js`、
    `lib/safe-path.js`（POSIX 不把反斜杠当分隔符）
  - 桌面：`electron/main.cjs`、`electron/preload.cjs`、新增
    `electron/external-files.cjs`、`electron/editor-settings.cjs`
  - 测试：`tests/file-link-model.cjs`、`tests/file-links-backend.cjs`、
    `tests/file-links-ui.cjs`、`tests/files-terminal.cjs`，新增
    `tests/external-grants.cjs`、`tests/external-files.cjs`、
    `tests/editor-settings.cjs`、`tests/editor-settings-ui.cjs`、
    `tests/file-links-desktop.cjs`、`tests/helpers/native-dialog.ps1`
  - 文档：`docs/file-links.md`、`docs/security.md`、`docs/README.md`、
    `docs/file-links-evidence/`（17 张截图 + results.json + README）、本文件

## 五项验收反馈的处置

| # | 反馈 | 处置 |
| --- | --- | --- |
| 1 | 裸文件名解析不能丢掉消息自己的会话身份 | `metaForCandidate`/候选升级全部用渲染时写入 `data-file-conversation`/`data-file-cwd` 的身份；`fetchFileMetadata`/`findWorkspaceFile` 显式传 conversationId 与 root，API 删除了「默认当前会话」兜底；find/metadata/grant 缓存键都含 `conversationId + cwd`，工作区事件推进 `cacheEpoch` 并让已升级候选退回重新验证。测试：A 会话焦点 B 时裸文件名仍绑 A cwd、同名文件在两个会话各自解析。 |
| 2 | 外部文件操作要统一做工作区身份校验 | `scopeMatches` 统一拦住普通点击、Ctrl/Cmd+点击与右键菜单里**全部**动作（内部打开、外部编辑器、系统程序、文件管理器、授权文件夹、复制相对/完整路径、撤销）；后端 `X-Pi-Gui-Conversation` + `workspaceScopeForRequest` 是最终权威，前端只做提示。 |
| 3 | 路径识别覆盖面 | `file-link-model.js` 支持 `src/main.ts:128`、`:128:10`、`:128-145`、`:128:10-145:2`、`#L128`、`file:///C:/…`、Markdown 文件链接、反引号路径、含空格/中文的绝对路径；纯文本相对路径必须含分隔符或行号且经后端存在性确认；npm 包名、模块标识符、术语、URL、版本号、commit hash、代码块内容明确排除；不做无界全局替换。 |
| 4 | 异步缓存与生命周期 | `cacheEpoch` 在会话切换/工作区代次/文件刷新/授权变更时推进；在途请求 `AbortController` 中止；迟到的响应即使成功也不会回填缓存或 DOM；find/metadata 并发去重、TTL+容量上限；瞬态网络错误只短重试不记成「不存在」；已升级候选在失效后退回候选重新验证。 |
| 5 | 同名文件选择 | 裸文件名经有界扫描（深度 8、4000 条目、24 命中）**确认真实存在且唯一**才升级；多命中不自动打开第一个，弹出紧凑选择器（类型图标 + 可区分相对路径 + 截断提示），键盘上下/Enter/Esc；选择只对这一次生效。 |

## 工作区外访问架构与安全边界

- **授权创建只能走可信通道**：渲染进程 → preload 固定字段 IPC → Electron 主进程
  原生 `dialog.showMessageBox` → 主进程私有 IPC 调后端 `create`。HTTP 端点只有
  `list`/`revoke`/读，**没有创建入口**；模型输出、Markdown、工具调用不能授权。
- **一次性确认记录**：`inspect` 签发 TTL 5 分钟、单次的 approval，绑定
  conversationKey + scopeKey（scopeId/generation/root）+ 目标身份（文件
  dev/ino/size/mtime/ctime、目录 dev/ino、所在文件夹 dev/ino）；`create` 只消费
  这份记录并重新复核，不再重新解释路径 —— 对话框期间文件被替换、工作区被切走
  都会 `approval_stale` 而不是授权错对象。
- **账本**：授权绑 `conversation:<uuid>` / `classic:<root>`；file/directory ×
  session/persistent。文件授权记录完整文件身份，替换后必须重授；目录授权每次读取
  重新 realpath + 目录包含校验。
- **持久化**：只有目录可长期保留，复用既有 `createSystemPreferenceFile` 设施写
  `external-file-grants.json`（16 KiB / 64 条上限、schema 校验、原子写）；启动时
  主进程把记录交后端逐条重新 realpath/敏感目录/符号链接校验。桌面下 HTTP 撤销
  长期授权返回 409 `desktop_required`，撤销必须走主进程，避免「内存撤销了但
  磁盘记录重启后复活」。写盘失败时：create 撤掉新授权返回 `settings_save_failed`；
  revoke 回滚内存授权返回 `revoke_not_saved`。
- **撤销失效面**：revoke 推进账本 epoch；HTTP revoke 经 SSE 广播
  `external_grants`，IPC revoke 派发同名 DOM 事件；所有渲染层据此关闭外部标签页、
  清 metadata/grant 缓存、中止在途请求、移除链接上旧的 `data-file-grant`。旧
  grant id 再访问返回 403。
- **后端为最终权威**：拒绝非本地绝对路径、UNC/设备路径/保留名/ADS/控制字符；
  `realpath`+`lstat`，符号链接/junction 拒绝；敏感目录（`.ssh`/`.aws`/凭据/
  浏览器 profile/系统目录/Pi 自身凭据与应用数据目录）双向拒绝 —— 目标在敏感目录
  内不行，授权敏感目录的祖先也不行；`isInside` 在 POSIX 不再把 `\` 当分隔符；
  只读，无写/删/执行入口；外部 metadata 在授权前不发请求，路径存在性探测在授权
  范围外统一返回 `grant_scope`；可执行/脚本/快捷方式不经通用「系统默认程序」
  入口直接启动；外部 document 256 KiB、asset 8MB、`nosniff`/`no-store`。
- **编辑器启动**：`editors-save` 不接受渲染进程给的 `customPath`（只有主进程
  原生文件选择器能写自定义路径）；启动一律 `spawn(exe, [structured args],
  { shell:false, detached:true })`，不拼接命令行；参数按 `goto | line-column |
  direct` 能力表区分，模型输出不参与。

## 证据

| 证据层 | 命令/场景与代码状态 | 退出码与实际结果 | 日志/截图 |
| --- | --- | --- | --- |
| 定向功能套件 | `npm run test:file-links`；before HEAD + 最终工作区 diff | exit 0；model 66/66、backend 21、external-grants 19、external-files 20、editor-settings 20、editor-settings-ui 8、file-links-ui 50、runtime 8、source-highlight 12 — **合计 224** | 终端输出 |
| 回归 | `node tests/smoke.cjs` | exit 0；**1339/1339**，无断言减少 | 终端输出 |
| 回归 | `node tests/files-terminal.cjs`、`files-terminal-ui.cjs`、`terminal-job-object.cjs`、`runtime-conversation.cjs`、`theme.cjs`、`modules.cjs`、`ui-ia.cjs`、`system-settings-ui.cjs`、`electron-guard`（test:guard）、`server-security`（test:security） | exit 0；113、95、10、110/110、47/47、121/121、32/32、20/20、128/128、44/44 | 终端输出 |
| 独立审查 | Codex `gpt-6.2-sol`（reasoning high）对同一最终 diff 的安全复审 | **完成**：首轮报 5 个阻断项 + 3 个确认项 + 1 个历史遗留放大；本轮全部修复（approval 绑定目标身份、持久化失败回滚、敏感祖先双向拒绝、撤销经 SSE/事件清理缓存与标签页、editors-save 不接收 customPath 等）；复审确认修复有效，无新增阻断项 | 审查摘要见下「独立审查历史」 |
| 独立审查 | Claude Opus 5.5（effort high）功能复审、两次 Claude Agent 原生审查 | **未产出**：原生 Agent 两次 429（周配额耗尽）；Opus 委托已发起但截至本报告未返回；Codex 功能审查中途同因中断，留下的两条线索（持久撤销复活、裸文件名升级后不跟随刷新）已修复并补测试。如实披露，不声称通过 | 本文件 |
| 真实桌面验收 | `node tests/file-links-desktop.cjs`；打包产物 `dist-app/Pi GUI-win32-x64/Pi GUI.exe`（最终代码构建后运行） | exit 0；**27/27**：行内/纯文本/外部引用渲染、悬停真实字节数、内部查看器 L18、同名选择器、未授权外部零请求、原生授权对话框、授权后查看器打开、目录授权（本次运行+长期）、外部图片受控端点、设置页探测到真实 VS Code、撤销后 403、工作区 B 不串 A、长期授权重启恢复、Ctrl+Click 真实启动 `Code.exe --goto …\app.ts:18` 且窗口标题确认 | [file-links-evidence/](file-links-evidence/)（17 张截图 + results.json；07/09 为裁剪后的对话框区域，17 为 VS Code 窗口截图） |
| 打包产物一致性 | `npm run build:exe` + `npm run build:app -- --rebuild` | `build/Pi GUI.exe` 106,856,448 B，SHA-256 `67edce713187b809228363ebbe9847e7d04ce9667b4ab67fd9bfa79dfe851156`；`dist-app/Pi GUI-win32-x64/Pi GUI.exe` 246,324,736 B，SHA-256 `71b9ed5105a31ad944f82376b0e66ea8b147068aafb16330a556f44bebe5a19f`；`public/editor-settings.js`、`file-links-ui.js`、`app.js`、`file-actions.js`、`markdown.js`、`file-link-model.js` 与 `build/electron-app/`、`dist-app/.../resources/app/` 逐字节一致；`server.cjs` 含 `mainOwnedPersistence`/`desktop_required` | 本文件；构建日志 |
| 本地完整 canonical | 按用户既定选择交给当前 PR 的完整 CI | **待验证**；本报告不把定向测试当作完整证明 | 待 PR run |
| PR CI | 推送后的 PR；精确 head SHA 待回填 | **待验证** | 待回填 run URL |
| 模型调用/安装升级 | 不适用：不调用模型、不安装升级 | — | — |

## 独立审查历史

1. 首轮 Codex `gpt-6.2-sol` 安全审查（reasoning high）报 5 个阻断项：渲染进程可经
   `editors-save` 注册任意可执行文件；`create` 重新解析路径导致授权与用户确认的
   对象可能不同；目录授权只查「目标在敏感目录内」不查「目标是敏感目录祖先」；
   恢复持久授权时 realpath 可改向到未审核目标；持久撤销写盘失败仍报成功。
   另有 3 个确认项（HTTP 撤销不通知渲染层、存在性旁路、目录选择器并发）与 1 个
   历史遗留放大（POSIX 反斜杠被当作分隔符）。
2. 逐项修复：approval 绑定完整目标身份并单次消费；`rejectSensitive` 双向检查；
   `restore` 要求存储 target 与 realpath 一致且不是符号链接；create/revoke 持久化
   失败回滚并返回明确错误；HTTP revoke 发布 SSE、渲染层关闭标签页并清缓存；
   `authorizeRead` 对词法范围外统一 `grant_scope`；目录选择器 `pending` 串行化；
   `editors-save` 忽略渲染进程 `customPath`；`normalizeForCompare` 仅在 Windows
   折叠反斜杠。修复后同一审查上下文确认各点成立。
3. 功能审查：Codex 功能审查跑到中途额度耗尽，留下两条线索 ——「持久撤销写盘失败
   会复活」与「裸文件名升级后不跟随工作区刷新」；两者已修复（上述回滚 +
   `data-file-origin-*` 来源保留 + epoch 失效退回候选）并有定向测试。
4. Claude 原生 Agent 两次发起均返回 429（weekly quota exhausted）；Claude
   Opus 5.5 委托已在队列中，若 PR CI 之前返回且仍有问题，会按新增 diff 继续收敛。

## 限制与残余风险

- macOS/Linux 编辑器探测与启动实现保留，但**未做真实安装验收**；Windows 为首要
  验收平台（VS Code 真实启动已验证，Cursor/Windsurf/Zed/Notepad++ 未装机验证，
  参数表按 T3 `externalLauncher.ts`/`contracts/editor.ts` 移植）。
- 真实 VS Code 验收要求运行前没有已打开的 VS Code 实例（单实例交接会让命令行
  不可验证）；脚本明确检查此前置条件。
- 通用「用系统默认程序打开」对未列入拒绝表的类型仍交给 OS 关联程序，执行与否
  取决于系统关联；已拒绝可执行/脚本/快捷方式/安装包扩展名。
- 编辑器打开在主进程拿到后端授权后按路径启动外部程序，「授权→spawn」之间理论上
  存在文件替换窗口；影响限于把别的路径交给用户自己选择的编辑器，不放大权限。
- 独立功能审查（Opus）截至本报告未返回；不把它计入「已通过」。完整 `npm test`
  交由 PR CI；二者完成前代码验收仍标**待验证**。
- 更多已知限制见 [file-links.md 第八节](file-links.md#八验证与已知限制)。

## 回滚

按提交边界回退（功能代码 / 测试 / 文档分开），不动本分支既有的 conversation
工作；`public/`、`server/`、`electron/` 回退后重新 `npm run build:exe` 与
`npm run build:app -- --rebuild` 即可恢复旧产物。验收只写 `os.tmpdir()`、
`%TEMP%`、隔离 `--user-data-dir` 与 `.shots/`（被忽略），未写用户真实项目或
真实应用数据。

## 待用户决定

- 是否接受本轮「本地文件读取 + 外部程序启动 + 持久授权」的残余风险；
- Opus 功能审查若在 CI 前返回，是否按其新增 diff 继续收敛；
- 是否授权合并与发布（当前均未授权；本交付只含提交、推送与 PR #111 更新）。

## 结论

- 开发完成 **是**；代码验收 **待外部验收**（Opus 功能审查未返回、完整 CI 待验证）；
- 允许合并 **未授权**；允许发布 **未授权**。
