# 会话内文件引用与工作区外访问验收材料

- 目标与交付：在上一版「会话内文件引用」之上，完成外部验收反馈的五项修复、
  工作区外文件授权（单文件 / 目录 / 会话级 / 长期目录）、外部编辑器配置
  （设置 → 通用）、同名文件选择器与异步缓存/生命周期加固，以及**第一阶段
  最终安全整改**的三处加固（目录授权对象身份 / 外部启动复核 / 系统打开
  白名单）。功能与边界说明见 [file-links.md](file-links.md)，独立审查与
  真实桌面验收结果见下文。
- 身份：before HEAD `9bba6a7d26224d388a5910fbc1408bbc3ad99aae`
  （`文档(conversation)：记录文件引用功能边界与验收材料`）；安全整改在
  `dfae939e` 之上，落地为 `91f175a4`（功能）+ `66734f3a`（测试）+ 本报告
  （文档）；分支 `feat/compact-attachments`，更新既有 PR #111。
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

## 第一阶段最终安全整改（三项加固）

| # | 根因 | 处置 |
| --- | --- | --- |
| 1 | **目录授权只绑路径字符串，不绑对象**：删除重建/重命名顶替/换 junction 后同一路径已是另一个目录，旧授权仍放行 | 新增 `lib/file-identity.js`；目录授权记 `dirIdentity={dev,ino,birthtimeMs}`（size/mtime/ctime 随成员增删变化，不进身份），`authorizeRead`/`assertStillValid`/`restore`/`create` 全部重新核对；对象不一致经 `evictGrant`→`onEvict`→SSE `external_grants` 逐出并关闭外部标签/清缓存/中止在途。持久化记录带 `dirIdentity`；无身份旧记录丢弃走重新授权。`electron/external-files.cjs` 校验透传。 |
| 2 | **授权→外部启动之间的 TOCTOU**：后端授权后到 `spawn`/`shell.openPath` 前文件被替换/授权被撤销仍会拉起 | `electron/editor-settings.cjs` 新增 `launchAuthorized`：外部授权再经 `confirmStillAuthorized` 二次确认 + `recheckLaunchTarget`（lstat 普通文件/非符号链接 + dev/ino/size/mtime/ctime 对 identity + realpath 对 absolutePath）三道过才启动；响应带文件 `identity`。OS 层最后窗口如实披露，不宣称消除。 |
| 3 | **「系统默认程序打开」是黑名单扩展名**：可执行/脚本/快捷方式靠枚举拒，漏伪装/无扩展名/内容伪装 | 新增 `server/open-policy.js` 白名单优先：放行文档/图片/媒体/压缩包；无扩展名 `unknown_type`、白名单外 `unsafe_type`、白名单内但文件头可执行（MZ/PE、ELF、Mach-O、`#!`、Java class、.lnk，4KiB 有界）`executable_header:*`，全 415；不依赖已装软件。编辑器/查看器动作不受影响。`server/files.js` 两处 `action==='open'` 都走 `evaluateSystemOpen`。 |

### 独立安全复审处置（SWE-2，thinking high）

| 级别 | 发现 | 处置 |
| --- | --- | --- |
| 阻断 | `.svg` 在白名单：顶层浏览器文档执行内嵌 `<script>`/`onload`，是「打开→执行」的干净通道 | 从白名单移除 `.svg`（`unsafe_type`）；内部预览走受控 `externalAsset`+CSP 不受影响 |
| 确认 | `.xsl`/`.xsd`：`xml-stylesheet`+XSLT 是文档级执行面（`document()` 读本地文件、旧 MSXML `msxsl:script` 跑 JScript） | 移除 `.xsl`/`.xsd`；`.xml` 保留（本身是数据），stylesheet 面记为残余 |
| 确认 | `.eps`：PostScript 是可执行语言，Ghostscript 系查看器会跑 | 移除 `.eps` |
| 确认 | `sameFileIdentity` 丢了 `ctimeMs`：POSIX 上「改写+`utimes` 回拨 mtime」能骗过文件身份，是回归 | `ctimeMs` 加回 `sameFileIdentity`（POSIX 抓 inode change；Windows ctime≈birthtime 多比无害） |
| 确认（取舍提示） | `.doc`/`.xls`/`.ppt`（97-2003）可带 VBA；`.p12`/`.pfx` 是证书导入向导 | 全部移除；`.docx/.xlsx/.pptx` 保留（宏容器 `.docm` 等本就不在名单） |
| 次要 | 注释写「目录记 …/ctime」与实现不符；open-policy 注释与导出矛盾 | 注释已修正 |

复审确认有效：authorizeRead 目录身份前置核对、逐出无再入、create 目录复用分支、
restore 缺身份丢弃（后端独立重算不信存储值）、confirmStillAuthorized 非 external
直放由 recheckLaunchTarget 兜住、spawn 无注入面、onEvict→SSE 与显式撤销同构。
新增复审回归锁用例：external-grants +1（mtime 回拨仍被 ctime 抓）、
file-links-backend +1（svg/xsl/xsd/eps/legacy-office/cert 系统打开全 415）。

测试新增「修复前失败、修复后通过」用例：external-grants +7（成员增删保留/
删除重建逐出/顶替/junction/恢复丢身份/读中替换/重授权不复用旧对象/mtime 回拨
ctime 抓住）、file-links-backend +3（伪装+双扩展+无扩展名 415、替换目录 403+evict
事件、复审剔除扩展名全拒）、editor-settings +2（授权后替换拒启动、授权后撤销
拒启动）、external-files fixture 带 dirIdentity。回归：file-links 全链、
smoke/electron-guard/server-security/modules/files-terminal/files-terminal-ui 无红。

## 工作区外访问架构与安全边界

- **授权创建只能走可信通道**：渲染进程 → preload 固定字段 IPC → Electron 主进程
  原生 `dialog.showMessageBox` → 主进程私有 IPC 调后端 `create`。HTTP 端点只有
  `list`/`revoke`/读，**没有创建入口**；模型输出、Markdown、工具调用不能授权。
- **一次性确认记录**：`inspect` 签发 TTL 5 分钟、单次的 approval，绑定
  conversationKey + scopeKey（scopeId/generation/root）+ 目标身份（文件
  dev/ino/birthtime/ctime/size/mtime、目录与所在文件夹 dev/ino/birthtime）；
  `create` 只消费这份记录并重新复核，不再重新解释路径 —— 对话框期间文件被
  替换、工作区被切走都会 `approval_stale` 而不是授权错对象。
- **账本**：授权绑 `conversation:<uuid>` / `classic:<root>`；file/directory ×
  session/persistent。文件授权记录完整文件身份（dev/ino/birthtime/ctime/size/
  mtime），替换后必须重授；目录授权绑目录**对象身份** `dirIdentity`
  （dev/ino/birthtime，成员增删不失效），删除重建/顶替/junction 即逐出。
- **持久化**：只有目录可长期保留，复用既有 `createSystemPreferenceFile` 设施写
  `external-file-grants.json`（16 KiB / 64 条上限、schema 校验、原子写）；记录
  带 `dirIdentity`，启动时主进程把记录交后端逐条重新 realpath/敏感目录/符号链接/
  目录对象身份校验 —— 后端不读存储里的身份当真，而是**独立重算**当前目录的
  dev/ino/birthtime 与保存值比对，不一致即丢弃。桌面下 HTTP 撤销长期授权返回
  409 `desktop_required`，撤销必须走主进程，避免「内存撤销了但磁盘记录重启后
  复活」。写盘失败时：create 撤掉新授权返回 `settings_save_failed`；revoke 回滚
  内存授权返回 `revoke_not_saved`。
- **撤销失效面**：revoke 推进账本 epoch；HTTP revoke 经 SSE 广播
  `external_grants`，IPC revoke 派发同名 DOM 事件，授权对象消失时账本经
  `onEvict` 回调发同一个事件；所有渲染层据此关闭外部标签页、清 metadata/grant
  缓存、中止在途请求、移除链接上旧的 `data-file-grant`。旧 grant id 再访问
  返回 403。
- **后端为最终权威**：拒绝非本地绝对路径、UNC/设备路径/保留名/ADS/控制字符；
  `realpath`+`lstat`，符号链接/junction 拒绝；敏感目录（`.ssh`/`.aws`/凭据/
  浏览器 profile/系统目录/Pi 自身凭据与应用数据目录）双向拒绝 —— 目标在敏感目录
  内不行，授权敏感目录的祖先也不行；`isInside` 在 POSIX 不再把 `\` 当分隔符；
  只读，无写/删/执行入口；外部 metadata 在授权前不发请求，路径存在性探测在授权
  范围外统一返回 `grant_scope`；外部 document 256 KiB、asset 8MB、`nosniff`/`no-store`。
- **系统打开白名单**（`server/open-policy.js`）：`shell.openPath` 只放行文档/
  文本/图片/音视频/压缩包等只读查看扩展名；无扩展名、可执行/脚本/快捷方式/
  安装包、白名单内但文件头可执行（MZ/PE、ELF、Mach-O、`#!`、Java class、.lnk，
  4KiB 有界嗅探）一律 415。判断只看路径形状 + 文件头，不依赖已装软件或注册表
  关联。危险文件仍可在内部只读查看器看字节，或交给明确配置的外部编辑器（读字节
  不执行）；reveal/copy 不受影响。
- **编辑器启动**：`editors-save` 不接受渲染进程给的 `customPath`（只有主进程
  原生文件选择器能写自定义路径）；启动一律 `spawn(exe, [structured args],
  { shell:false, detached:true })`，不拼接命令行；参数按 `goto | line-column |
  direct` 能力表区分，模型输出不参与。**启动前复核**收窄授权→执行窗口：
  外部授权二次确认仍有效 + `lstat` 文件未被替换 + `realpath` 与授权路径一致
  三道过才启动（见上表 #2）。

## 证据

| 证据层 | 命令/场景与代码状态 | 退出码与实际结果 | 日志/截图 |
| --- | --- | --- | --- |
| 定向功能套件 | `npm run test:file-links`；最终安全整改 + 复审修复 head | exit 0；model 66/66、backend 24、external-grants 26、external-files 20、editor-settings 22、editor-settings-ui 8、file-links-ui 50、runtime 8、source-highlight 12 — **合计 236** | 终端输出 |
| 回归 | `node tests/smoke.cjs` | exit 0；**1339/1339**，无断言减少 | 终端输出 |
| 回归 | `node tests/files-terminal.cjs`、`files-terminal-ui.cjs`、`electron-guard`、`server-security`、`modules.cjs` | exit 0；113、95、128/128、44/44、121/121 | 终端输出 |
| 独立审查（上一轮） | Codex `gpt-6.2-sol`（reasoning high）安全复审 | **完成**：首轮 5 阻断 + 3 确认 + 1 历史遗留，全部修复并复确认 | 见下「独立审查历史」 |
| 独立审查（本轮） | SWE-2（thinking high，跨 provider `pi` 委托，`worktree` 隔离）对最终安全整改 diff 的安全复审 | **完成**：1 阻断（`.svg`）+ 2 强烈建议（`.xsl`/`.xsd`、`.eps`）+ 1 POSIX 回归（`ctimeMs` 丢失）+ 取舍提示（`.doc/.xls/.ppt`、`.p12/.pfx`），全部修复并加回归锁；确认架构与实现有效，无新增阻断 | 本文件 |
| 独立审查 | Claude Opus 5.5（effort high）功能复审、Codex 功能复审、两次 Claude Agent 原生审查 | **未产出**：原生 Agent 两次 429（DeepSeek 周配额耗尽）；Codex 功能审查 429（周额度，2026-11-27 后才可再试）；Opus 5.5 委托 429（OpenCode Go 月额度，2026-12-02 后才可再试）。**不宣称独立功能审查通过** | 本文件 |
| 真实桌面验收 | `node tests/file-links-desktop.cjs`；打包产物 `dist-app/Pi GUI-win32-x64/Pi GUI.exe`（最终代码构建后运行） | exit 0；**27/27**：行内/纯文本/外部引用渲染、悬停真实字节数、内部查看器 L18、同名选择器、未授权外部零请求、原生授权对话框、授权后查看器打开、目录授权（本次运行+长期，记录含 `dirIdentity`）、外部图片受控端点、设置页探测到真实 VS Code、撤销后 403、工作区 B 不串 A、长期授权重启恢复（对象身份一致）、Ctrl+Click 真实启动 `Code.exe --goto …\app.ts:18` 且窗口标题确认 | [file-links-evidence/](file-links-evidence/)（17 张截图 + results.json；07/09 为裁剪后的对话框区域，17 为 VS Code 窗口截图） |
| 打包产物一致性 | `npm run build:exe` + `npm run build:app -- --rebuild`（复审修复后重建） | `build/Pi GUI.exe` 106,864,128 B，SHA-256 `d6f1e0298570fcd5163cbc856c7f9802d959f67db572288cf7e1ba58d494dd98`；`dist-app/Pi GUI-win32-x64/Pi GUI.exe` 246,324,736 B，SHA-256 `71b9ed5105a31ad944f82376b0e66ea8b147068aafb16330a556f44bebe5a19f`；`resources/app/` 内 `editor-settings.cjs`/`external-files.cjs` 与源逐字节一致，`server.cjs` 打包内含 `dirIdentity`/`executable_header`/`sameStatIdentity`/`onEvict`/`evaluateSystemOpen`，`.svg` 已移出系统打开白名单 | 本文件；构建日志 |
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
4. 三次独立功能审查尝试均因额度失败：Claude 原生 Agent 两次 429（DeepSeek 周配额）、
   Codex `gpt-6.2-sol` 中途 429（周额度，2026-11-27 重置）、Claude Opus 5.5 委托
   429（OpenCode Go 月额度，2026-12-02 重置）。没有把它们写成「已通过」；若 CI
   之后有人工或独立审查要求，按当前 head `b84f15e5` 起新一轮。
5. **最终安全整改的独立复审**：SWE-2（thinking high，跨 provider `pi` 委托，
   `isolation: worktree`）对 `91f175a4`+`66734f3a` 的最终安全整改 diff 做安全
   复审。报 **1 个阻断项**（`.svg` 顶层浏览器执行内嵌脚本）、**2 个强烈建议**
   （`.xsl`/`.xsd` XSLT 面、`.eps` PostScript 执行）、**1 个 POSIX 回归**
   （`sameFileIdentity` 丢 `ctimeMs`，改写+回拨 mtime 可绕过）与取舍提示
   （`.doc/.xls/.ppt` VBA、`.p12/.pfx` 证书导入）。全部修复并加回归锁
   （`external-grants` mtime-rollback、`file-links-backend` 复审剔除扩展名）。
   复审同时确认：authorizeRead 目录身份前置核对、逐出无再入、create 复用分支、
   restore 独立重算身份不信存储值、recheckLaunchTarget 兜住非 external 替换、
   spawn 无注入面、onEvict→SSE 与撤销同构 —— 实现方向确认有效，无新增阻断。

## 限制与残余风险

- macOS/Linux 编辑器探测与启动实现保留，但**未做真实安装验收**；Windows 为首要
  验收平台（VS Code 真实启动已验证，Cursor/Windsurf/Zed/Notepad++ 未装机验证，
  参数表按 T3 `externalLauncher.ts`/`contracts/editor.ts` 移植）。
- 真实 VS Code 验收要求运行前没有已打开的 VS Code 实例（单实例交接会让命令行
  不可验证）；脚本明确检查此前置条件。
- **系统打开残余边界**：白名单收窄到只读查看类型 + 4KiB 可执行头嗅探，复审后
  剔除 `.svg`/`.xsl`/`.xsd`/`.eps`/`.doc`/`.xls`/`.ppt`/`.p12`/`.pfx`。残余：
  (a) `.xml` 保留（本身是数据），`xml-stylesheet` 处理指令依赖默认关联属已知残余；
  (b) 白名单内 `.pdf`/`.docx` 等可含内嵌脚本/宏，默认程序是否执行取决于 OS 关联，
  不在本层控制；(c) 文件头嗅探只看前 4 KiB 已知可执行 magic，polyglot/无 magic
  内容理论上可绕过 —— 已收敛到「扩展名白名单 + 已知可执行头」两层，**不宣称
  完全消除**。
- **OS 层启动 TOCTOU 残余**：`launchAuthorized`/`recheckLaunchTarget` 把授权→
  spawn 窗口收窄到「最后一次 `lstat` 到 OS 真正拉起」之间；文件 mtime/ctime 在
  Windows 上不可由用户回拨但 dev/ino 可能被复用，三道复核是 stat 能给的最强近似，
  不是不可伪造的对象 GUID。**不宣称消除**，仅收窄。
- 编辑器打开在主进程拿到后端授权后按路径启动外部程序；即使三道复核全过，从
  `lstat` 到 `spawn`/`openPath` 之间仍有 OS 级窗口 —— 影响限于把别的路径交给
  用户自己选择的编辑器，不放大权限。
- 持久化兼容性：旧版本写出的 `external-file-grants.json` 记录没有 `dirIdentity`，
  本轮恢复时按「无法证明同一对象」**丢弃**，用户在升级后首次访问旧授权目录需
  重新授权一次 —— 这是有意的安全降级，不静默沿用路径放行。
- 独立功能审查三次尝试均因配额失败（Claude Agent ×2、Codex、Opus 5.5 委托），
  不把它计入「已通过」；本轮最终安全整改的 SWE-2 复审进行中。完整
  `npm test` 交由 PR CI；审查与 CI 完成前代码验收仍标**待验证**。
- 更多已知限制见 [file-links.md 第八节](file-links.md#八验证与已知限制)。

## 回滚

按提交边界回退（功能代码 / 测试 / 文档分开），不动本分支既有的 conversation
工作；`public/`、`server/`、`electron/` 回退后重新 `npm run build:exe` 与
`npm run build:app -- --rebuild` 即可恢复旧产物。验收只写 `os.tmpdir()`、
`%TEMP%`、隔离 `--user-data-dir` 与 `.shots/`（被忽略），未写用户真实项目或
真实应用数据。

## 待用户决定

- 是否接受本轮「本地文件读取 + 外部程序启动 + 持久授权」的残余风险；
- 独立功能审查因配额三次失败后，是接受现状、等额度恢复后补审、还是换人工审查；
- 是否授权合并与发布（当前均未授权；本交付只含提交、推送与 PR #111 更新）。

## 结论

- 开发完成 **是**（含第一阶段最终安全整改）；代码验收 **待外部验收**
  （SWE-2 安全复审进行中、Opus 功能审查未返回、完整 CI 待验证）；
- 允许合并 **未授权**；允许发布 **未授权**。
