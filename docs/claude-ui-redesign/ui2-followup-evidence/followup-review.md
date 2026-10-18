# UI-2 补验收独立只读复核

复核日期：2026-10-17。仅阅读测试、JSON、日志及 PNG；未运行 GUI、完整 npm 或联网，未修改源文件和既有证据。本报告是本次唯一写入。

**结论：启动调查的限定归因成立；新增原生夹具的 HWND owner 边界问题经复核发现并由主线程安排修正，新的 owner-guard 结果通过。** 最终可采用启动 82/82 与原生 owner-guard 45/45，均退出 0。不能把负对照称为零错误启动，也不能把旧 theme-electron 的沙箱参数混入新夹具的安全结论。

## 启动归因和完整观察

复核 `tests/ui2-startup-diagnostic.cjs`、`startup/diagnosis.md`、最终 `run-2026-10-16T16-17-37-838Z/` 的六个完整 cdp.json/observer.json，以及两轮先期对照汇总：

- 最新六轮共 82 条断言，均通过。no-cdp 两轮 10/10，late-runtime 两轮 16/16，early-runtime-first 两轮 15/15；四次正常控制均零 console 错误，两次负控制每次真实产生两条已知错误。
- 主进程在 `web-contents-created` 中同步安装 console-message 观察器，随后才开始 production 导航。六轮均从 require-production-main / 初始空文档观察到 process-exit，observer exitCode 均为 0。因此延后 CDP 附加没有丢失主进程观察的启动前段；此结论限于各轮实际短生命周期。
- 两个最新负控中，两条错误分别发生在 Runtime.enable 发出后 **68/69ms**、**65/71ms**；production 导航提交分别为其后 **71ms**、**96ms**，observer 首次 renderer JS 注入分别为 **165ms**、**231ms**。主进程 URL 为空，来源为 sandbox_bundle；CDP 精确指向空文档 isolated context，同一 frame 随后有 production isolated context。没有把 observer JS 或关窗后的错误归给启动。
- 先期六臂显示不开 CDP、仅端口、仅 WS、仅 Page.getFrameTree、Page.getFrameTree 先行后 Runtime、加载完成后 Runtime，各两轮未观察到错误。该证据支持“初始空文档 Runtime 为首命令”的有界触发关系；**不支持所有 early Runtime.enable 必然报错，也不证明 Electron 内部 bootstrap 的具体机制**。当前 diagnosis.md 已保留这种界限。
- 直接从当前源文件提取负控判定块，在实际 JSON 的内存副本重放：原样 **7/7**；追加一个未知错误触发 **3 项失败**；保持错误数量为二、替换其中一条为未知错误，触发 **1 项失败**。因此已知错误不是吞掉任意其他错误的白名单。没有修改实际 JSON，也没有启动额外进程。
- 最新四次正常控制的主进程与 late-runtime CDP console 均为零错误；preload-error、render-process-gone、observer 异常、CDP uncaught exception 和未命中负控时间窗均进入失败条件。启动结果不能泛化成长跑、其他平台或无包装原 exe 的完整验收。

包副本只将 fixture package main 指向观察器，再加载未改 production main；setup 中 exe/main/preload/server SHA 一致。源文件显式保留 sandbox=true、contextIsolation=true、nodeIntegration=false，未加 --no-sandbox。真实主题 IPC 和磁盘偏好也在 late-runtime 两轮验证。此包装入口的归属限制在原调查报告中已披露。

## 原生捕获边界及修复复核

初审发现：旧 42/42 源码中 CopyFromScreen 有 owner 条件，但 PrintWindow fallback 在 owner 不匹配时仍可能执行；旧 README 还把只执行于前置阶段的 desktop 检查写成前后都执行。实际旧 17 个 HWND owner 均正确，未观察到错误窗口被捕获；这仍是夹具的 fail-closed 缺口，已即时报告主线程。

本次最终复核以 **`native-caption/owner-guard/report.json`** 和当前 `tests/ui2-native-caption.cjs` 为准，不以旧根目录 42/42 代替：

- 当前 `Owned` 同时校验 IsWindow 与 PID。CopyFromScreen 在 API 前、API 后和保存前校验 owner/可见/非 cloaked；PrintWindow 在 fallback 入口、API 前、API 后和保存前校验 own HWND/PID。owner 不符时不调用两个抓取 API，也不保存文件。
- 两个实际负控使用**自己的另一个可见 fixture 窗口**，故意传不匹配的 expected PID。两个报告均 targetIsWindow=true、actual owner=33932、expected=33933、copyCalls=0、printCalls=0、saved=false、imageExists=false；独立检查对应 PNG 均不存在。没有用外部程序窗口做反例。
- 17 个正常 scene 全部可用：12 个 CopyFromScreen、5 个 exact-own-HWND PrintWindow fallback。12 个 screen copy 的前后 owner/visibility、保存前 owner、前后遮挡网格/外部交叠结果均符合条件；5 个 PrintWindow 的前后及保存前 owner guard 均为真。
- CopyFromScreen 的 desktop 对齐属于前置检查；前后同时执行的是 owner/visibility 和遮挡网格/交叠检查。PrintWindow 是 exact HWND 绘制，允许在 screen-copy 遮挡条件不足时使用，**不能写成所有 17 图均为无遮挡 screen copy**。
- 完整矩阵 guard 要求恰好 17 个唯一预期 scene、每项可用且有文件、必要标题带样本、四个真实 Changes/Browser surface，以及全部成功捕获的 owner 边界。直接从源文件提取五项最终 guard，在内存副本重放：原样 5/5；删一个 scene 触发 5 项失败；置一个 available=false 或 file=null 分别触发可用性失败。缺图/跳过矩阵不会假绿。

## PNG 与颜色的独立核验

- 旧根目录 34 个 PNG 的 manifest 字节数/SHA-256 全部独立重算一致。新的 `owner-guard/image-manifest.json` 也已逐个独立核验：**34 图、2353178 字节、SHA-256 差异 0**。本复核没有改写任何 manifest。
- 对新的 owner-guard 17 个完整 PNG，以独立 PNG 解码读取像素，逐点重算 **38 个网页标题带样本**，与报告 actual RGB 全部一致；再按源判定重算 **51 个原生控制 glyph/background 区域**，计数全部一致。
- Dark 网页/原生底色为 RGB **17/17/17**，Light 为 **251/251/249**，symbol 分别对应生产 theme palette。stage、rail，以及四个可见 Changes/Browser pane 的 titlebar 样本均匹配。已实际查看 Light Browser caption 和 Dark maximized caption，均为有效原生按钮图。
- 实际显示缩放全部为 **1.5**；80/100/125/150% 为应用 zoom，不是动态切换 OS DPI 的证据。此处验收的是标题带与原生控制接缝，不声称 Browser 空白内容区强制跟随应用主题。

`theme-electron.log` 另记录既有主题测试 489/489、退出 0、截图 65；其 launcher 此次只把 windowsHide 改为 false，**原有 --no-sandbox / --in-process-gpu 仍在**。它可作旧主题回归，不能用于声称新启动/原生夹具未降级沙箱。新增两套夹具的 sandbox=true 证据应独立呈现。

本复核未发现需要改产品的缺陷；原生 owner 缺口属于新增验收夹具，已由负责该夹具的任务收紧并在独立目录重跑。未替代真实模型、长期稳定性、POSIX 或完整 OS DPI 切换验收。

最终 `owner-guard/README.md` 已确认 45/45、37.089 秒、原生 child exit 0；明确旧根目录 42/42 为历史证据、desktop 只作前置检查，以及新原生夹具安全结论不适用于旧 theme-electron launcher。声明与当前源码和实际报告一致。两份新夹具 `node --check` 均退出 0。
