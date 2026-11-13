# 终端 P3 进程终止设计审计：PID 复用、句柄与 Job Object

日期：2026-11-13  
分支：设计时 `feat/terminal-p3-keep-alive`（P3-A）；P3-B 实现分支
`feat/terminal-p3b-identity-kill`  
状态：**设计 / 审计。P3-A 未实现终止改造；P3-B 已于 2026-11-13 按第 6.2 节实现，
验收见 [terminal-p3b-termination-acceptance.md](terminal-p3b-termination-acceptance.md)。**  
范围：Windows 10/11、Electron 44、node-pty 1.1.0、ConPTY；审计
`server/terminal-process.js`、`server/terminal.js`、`electron/main.cjs` 以及仓库中其它
`taskkill /T` 路径。

> 证据标记：`[源码]` 是本轮实际读取的仓库或 `node_modules` 源码；`[文档]` 是引用的
> Microsoft Learn 或上游 issue；`[未验证]` 表示本轮没有运行对应实验。本文没有为了写
> 结论而运行杀进程、PID 复用或 Electron 交互实验；所有运行时结论都明确标为未验证。
>
> 命名说明：任务书把本次审计称为 P3-B；第 6 节把建议的后续代码阶段也命名为 P3-B。
> 本文写作时只是推荐的实施顺序；P3-B 随后已在独立分支实现，实现状态与证据见第
> 6.2.7 节和验收记录，不代表 P3-C 已实现或已获授权。

## 一、结论先行

| 问题 | 结论 |
| --- | --- |
| 当前主路径 | `taskkill /pid <shell pid> /T /F`，失败后在“shell 仍存活”时回退 `pty.kill()` |
| 根因 | `pty.pid` 只是 shell 的**数字 PID**，不是进程身份；`taskkill` 在调用时按 PID 解析目标，PID 被复用后就会命中无关进程 |
| 回退路径是否更安全 | 否。`pty.kill()` 在系统 ConPTY 下会 fork 一个 helper，对裸 PID 做 `AttachConsole` / `process.kill`；5 秒超时后还会直接 `process.kill(shellPid)`（上游 #967） |
| 是否会被重复放大 | 是。`sweep` 每 5 秒对 `closing` 会话重试一次 `killPty`，每次调用都有自己的“一次性”回退保护，窗口按会话寿命持续存在 |
| 不改 node-pty 能否彻底修复 | 不能。身份校验只能缩小 TOCTOU，不能把“检查”和“杀树”变成原子操作 |
| 小原生模块能否彻底修复 | 不能单独做到。它可以按句柄校验并终止根进程，也可以在创建后补一个 Job，但补 Job 会漏掉创建前已产生的子进程，且拿不到 node-pty 内部的 `hpc` / `hShell` |
| 真正的完整修复 | 在 node-pty 创建 shell 时把它放进 Job Object，停止时 `TerminateJobObject`，并用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 覆盖后端崩溃；这需要上游改动或固定补丁 |
| 本轮建议 | P3-A 不改终止路径；P3-B 做“身份门控 + 有界重试 + 去掉不安全的 Windows 回退”；P3-C 推动上游 Job Object；P3-D 原生模块只在 P3-C 不可行时再评估 |
| 风险等级 | 后果高（可误杀同用户进程树、丢未保存数据、误杀构建/安全工具），触发概率低到中；属于 P1/P2 既有风险，P3-A 未改变 |

## 二、现状与调用链

### 2.1 创建：`pty.pid` 是 shell 的 PID

`server/terminal-process.js:96-110` 的 `defaultSpawnPty()` 调用
`pty.spawn(file, args, { ..., useConpty: true })`。Windows 上 node-pty 走 ConPTY，
`pty.pid` 是 `PtyConnect` 返回的 `piClient.dwProcessId`，也就是 **shell 的 PID**；
node-pty 的类型声明把它描述为“outer process”，但 ConPTY 路径实际返回的是 shell
（`node_modules/node-pty/lib/windowsPtyAgent.js:88-91`、
`node_modules/node-pty/typings/node-pty.d.ts:116-120`）。

node-pty 没有暴露进程句柄、Job 句柄或“按句柄终止”的 API。`IPty` 只有
`pid`、`kill()`、`onExit` 等字段；`pid` 是数字，`kill()` 不接受身份参数。

### 2.2 停止：`stopSession` 等待真实 exit，`sweep` 反复重试

`server/terminal.js:322-344`：

```js
session.state = 'closing';
session.stopReason = reason;
clearIdleTimer(session);
try {
  killPty(session.pty, platform);
} catch {
  try { session.pty?.kill?.(); } catch { /* already gone */ }
}
return waitForExit(session, 5000);
```

状态只有收到真实 `onExit` 才在 `handleExit`（`server/terminal.js:295-312`）里变成
`exited`。如果 kill 没有产生 exit 事件，`sweep`（`server/terminal.js:730-769`）每
5 秒对 `state === 'closing'` 的会话再调一次 `killPty`：

```js
if (session.state === 'closing') {
  try { killPty(session.pty, platform); } catch { ... }
  continue;
}
```

`dispose()`（`server/terminal.js:871-889`）在服务关闭时对所有未结束会话调用
`stopSession(..., 'shutdown')`，最多等 3 秒，然后清空账本。

这里有两个关键点：

1. **重试不是一次性的。** `defaultKillPty` 里的 `fellBack` 是每次调用新建的局部变量
   （`server/terminal-process.js:135`），不是会话级状态；`sweep` 每 5 秒重新调用，
   就重新获得一次 `taskkill` + 一次 `pty.kill()` 的机会。
2. **“等待 5 秒”不等于“确认已死”。** `waitForExit` 只是等 `onExit` 或超时；
   超时后会话仍是 `closing`，下一次 sweep 继续按同一个 PID 杀。

### 2.3 `defaultKillPty` 的两条路径

`server/terminal-process.js:132-174`：

```js
export function defaultKillPty(pty, platform = process.platform) {
  if (!pty) return;
  const pid = Number.isInteger(pty.pid) && pty.pid > 0 ? pty.pid : null;
  let fellBack = false;
  const fallbackToPty = () => {
    if (fellBack) return;
    fellBack = true;
    if (platform === 'win32' && !ptyProcessAlive(pty)) return;
    try { pty.kill(); } catch { /* already gone */ }
  };
  if (platform === 'win32' && pid) {
    const taskkill = path.join(winRoot, 'System32', 'taskkill.exe');
    const child = spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { ... });
    child.once('error', () => { fallbackToPty(); });
    child.once('close', (code) => { if (code !== 0) fallbackToPty(); });
    return;
  }
  try { pty.kill(); } catch { /* already gone */ }
}
```

- 主路径：`taskkill /pid <pid> /T /F`。`/T` 的文档语义是“结束指定进程以及它启动的子进程”
  `[文档]`；`taskkill` 只接受 PID，没有创建时间、句柄或实例 token 参数。
- 回退路径：`pty.kill()`。它同样以 shell PID 为入口，见 2.4。
- 门控：`ptyProcessAlive(pty)` 只做 `process.kill(pid, 0)`（`server/terminal-process.js:120-130`）。
  这不是身份校验：PID 被复用后，`kill(pid, 0)` 会成功，函数返回 `true`。

### 2.4 `pty.kill()` 在 Windows 上也不是身份安全的

系统 ConPTY（`useConptyDll === false`）下，
`node_modules/node-pty/lib/windowsPtyAgent.js:133-151`：

```js
this._inSocket.readable = false;
this._outSocket.readable = false;
this._getConsoleProcessList().then(function (consoleProcessList) {
  consoleProcessList.forEach(function (pid) {
    try { process.kill(pid); } catch (e) { /* ... */ }
  });
});
this._ptyNative.kill(this._pty, this._useConptyDll);
```

`_getConsoleProcessList()`（同文件 `:181-195`）fork
`conpty_console_list_agent.js`，agent 调用原生模块
`getConsoleProcessList(shellPid)`；后者在
`node_modules/node-pty/src/win/conpty_console_list.cc:16-30` 中：

```cpp
FreeConsole();
AttachConsole(pid);
GetConsoleProcessList(...);
FreeConsole();
```

`AttachConsole(pid)` 同样是裸 PID。更危险的是 5 秒超时分支：

```js
var timeout = setTimeout(function () {
  // Something went wrong, just send back the shell PID
  agent.kill();
  resolve([_this._innerPid]);
}, 5000);
```

也就是说，即使 agent 因为 shell 已退出而崩溃，5 秒后 Promise 仍会以
`[shellPid]` 兑现，随后 `process.kill(shellPid)` 被调用。如果此时 PID 已被复用，
node-pty 自己就会强杀无关进程。这就是上游 issue #967
（“kill() on ConPTY can hard-kill an unrelated live process up to 5s later via
bare-PID fallback in _getConsoleProcessList timeout”）描述的问题，本轮读取时状态为
open。

`useConptyDll === true` 的分支（同文件 `:153-160`）不做 console-list，只
`TerminateProcess(handle->hShell, 1)`（`src/win/conpty.cc:562-564`）。它按句柄杀根进程，
比裸 PID 安全一些，但只覆盖 shell，不覆盖整棵树；而且仓库明确没有采用 bundled
ConPTY DLL（`server/terminal-process.js:105-108` 注释：winpty 和 bundled DLL 在目标
Electron/Node 组合下独立失败）。因此不能拿它当修复。

### 2.5 Electron 的后端树杀也是 PID 寻址

`electron/main.cjs:394-422` 的 `killServer()`：

```js
const pid = server.pid;
if (process.platform === 'win32' && pid) {
  const taskkill = path.join(winRoot, 'System32', 'taskkill.exe');
  execFileSync(taskkill, ['/pid', String(pid), '/T', '/F'], { ... });
}
try { server.kill(); } catch { ... }
```

它的注释记录了为什么要先树杀后端：后端先退出后，`taskkill /T` 失去父子链路，孙子进程
会活下来。这个路径和终端 shell 的问题是同一类：`taskkill` 按后端 PID 找树。区别是
Node 的 `ChildProcess` 对象通常还持有后端进程句柄，`server.kill()` 是按句柄终止；而
终端 shell 由 node-pty 原生创建，JS 侧只有数字 PID。两者不能混为一谈，但都值得用
身份门控收紧。

### 2.6 仓库中其它相关路径

| 路径 | 行为 | 与本文的关系 |
| --- | --- | --- |
| `server/agents/cli.js:155-166` `killTree` | `taskkill /pid <child.pid> /T /F`，失败回退 `child.kill()` | 同一类 PID 寻址；有 `ChildProcess` 句柄兜底，但树杀仍有后代竞态 |
| `lib/git.js:127-132` `killTree` | 同样 `taskkill /T /F` | 同上；属于既有工具路径 |
| `electron/main.cjs:394-422` | 后端树杀 | 见 2.5 |
| `installer/pi-gui.nsi:160,230` | `taskkill /IM "Pi GUI.exe" /F /T` | 按映像名杀**所有**实例，不是 PID 复用问题；属于另一个风险类别 |
| `extensions/pi-gui-process/runner-win.ps1` | `CreateJobObject` + `KILL_ON_JOB_CLOSE` + `CREATE_SUSPENDED` + `AssignProcessToJobObject` + `ResumeThread` + `TerminateJobObject` | 已有的“创建时归属”正确范式，可参考，但不能直接套到 ConPTY |
| `server/rpc-bridge.js` | 注入 `killTree` | 复用上述原语；不在终端范围 |

### 2.7 P2 已经记录了这个风险

`docs/terminal-p2-acceptance.md:215-218` 明确写着：

> `taskkill /T` 只能清理当时仍在进程树中的后代；若子进程先自行脱离父链，P2 不声称
> 能追踪到它。Windows 的树杀仍以 PID 为句柄：若 shell 的 PID 在 exit 丢失后被系统
> 复用，理论上可能终止无关进程树。这是 P1 既有的窄窗口风险，P2 未改变，建议后续按
> 创建时间 / 命令行身份收紧。

同文档 `:177` 的安全复审也把“Windows `taskkill /T` 以 PID 为句柄，PID 复用窗口列入
P3 跟进”列为既有风险。本文就是这条 follow-up 的设计记录，不是修复证明。

## 三、根因：PID 不是身份

### 3.1 Windows 文档对 PID 生命周期的定义

`PROCESS_INFORMATION.dwProcessId` 的文档原文 `[文档]`：

> A value that can be used to identify a process. The value is valid from the time
> the process is created until all handles to the process are closed and the
> process object is freed; at this point, the identifier may be reused.

这句话有两个含义：

1. PID 在进程对象被释放后**可以**被复用；它不是永久身份。
2. 只要还有进程句柄打开，进程对象不会被释放，PID 就不会进入可复用池。这为“持句柄
   钉住根 PID”提供了文档依据（见 5.3、6.3），但**不**自动保护后代，也不把
   `taskkill` 变成原子操作。这是文档语义，本轮没有做运行时验证 `[未验证]`。

### 3.2 `taskkill` 没有身份参数

`taskkill` 的文档只列出 `/pid <processID>`、`/im <imagename>`、`/f`、`/t` 等参数；
`/t` 的说明是“Ends the specified process and any child processes started by it”
`[文档]`。`/fi` 支持的过滤器是 `STATUS`、`IMAGENAME`、`PID`、`SESSION`、`CPUtime`、
`MEMUSAGE`、`USERNAME`、`SERVICES`、`WINDOWTITLE`、`MODULES`，**没有创建时间**，
也没有“进程实例句柄”过滤器。因此：

- 不能用 `taskkill /fi "CreationDate eq ..."` 补身份；
- 不能在 `taskkill` 内部做“检查创建时间再杀”；
- 从我们的身份校验到 `taskkill` 真正打开目标进程之间，始终存在一个 PID 复用窗口。

这不是“换个参数”能解决的问题，而是 `taskkill` 的接口模型决定的。

### 3.3 两条路径都不校验身份

把 2.3 和 2.4 串起来，当前的实际行为是：

1. `defaultKillPty` 取 `pty.pid`，直接 `taskkill /pid <pid> /T /F`。
2. 如果 `taskkill` 失败（包括 PID 已不存在；代码注释记录此时通常返回 128），调用
   `fallbackToPty()`。
3. `fallbackToPty` 先用 `ptyProcessAlive()` 做“存活”判断；这个判断是
   `process.kill(pid, 0)`，对复用 PID 返回成功。
4. 于是调用 `pty.kill()`，node-pty 再 fork agent，用同一个裸 PID 做
   `AttachConsole`；agent 失败时 5 秒后回退到 `process.kill(shellPid)`。

也就是说，**主路径和回退路径都以同一个数字为身份**，而中间唯一的“校验”本身也是
PID 存活判断。这不是“双重保险”，而是“两次机会”。

### 3.4 一个具体时间线

假设 shell 启动时 PID 是 4242：

| 时刻 | 事件 | 结果 |
| --- | --- | --- |
| t0 | `pty.spawn` 成功，`pty.pid = 4242` | 会话 `running` |
| t1 | 用户输入 `exit`，PowerShell 退出 | node-pty 的 exit watcher `WaitForSingleObject(hShell)` 返回，`CloseHandle(hShell)`，`remove_pty_baton`，随后才 `BlockingCall` 通知 JS（`src/win/conpty.cc:99-108`） |
| t2 | JS 的 `onExit` 因事件循环繁忙/回调丢失而延迟，会话仍是 `running` 或已进入 `closing` | node-pty 已关闭它持有的 `hShell`；若没有其它句柄，PID 4242 可进入复用池 |
| t3 | 系统把 4242 分配给一个无关进程（编辑器、构建、另一个终端、系统工具） | 4242 现在指向无关进程 |
| t4 | 用户关闭标签 / 空闲超时 / `sweep` 到点 | `stopSession` 或 `sweep` 调 `killPty` |
| t5 | `taskkill /pid 4242 /T /F` | 杀掉无关进程及其当前子进程树 |

如果 t5 的 `taskkill` 失败，还有第二条：

| 时刻 | 事件 | 结果 |
| --- | --- | --- |
| t5b | `taskkill` 返回非 0（例如目标已退出/权限） | `fallbackToPty()` |
| t6b | `process.kill(4242, 0)` 成功，因为 4242 现在是无关进程 | `ptyProcessAlive` 返回 true |
| t7b | `pty.kill()` fork agent，`AttachConsole(4242)` | 可能附加到无关进程的控制台，`GetConsoleProcessList` 枚举出它的整个控制台进程组 |
| t8b | agent 失败或 5 秒超时 | 回退 `process.kill(4242)`，强杀无关进程 |

这个时间线不要求攻击者；自然退出 + 事件延迟 + 繁忙机器的 PID churn 就足够。P2
把窗口称为“窄窗口”，但 `sweep` 的无限重试把“一次性窗口”变成了“会话生命期内每 5 秒
一次”。

### 3.5 为什么 `ptyProcessAlive` 不能修

`ptyProcessAlive` 的注释说“only fall back to the PTY handle while the shell is
actually alive”（`server/terminal-process.js:112-119`）。这个意图是避免 node-pty
的 `AttachConsole failed` 崩溃栈，不是安全校验。它无法区分：

- shell 还活着；
- shell 已退出，但 PID 被无关进程复用；
- shell 已退出，PID 暂时没有被复用（`kill(pid, 0)` 可能失败，也可能因为对象未释放而成功）。

即使把 `kill(pid, 0)` 换成创建时间查询，也只能得到“查询这一刻的 PID 指向谁”，
不能保证“下一毫秒 `taskkill` 打开的还是同一个对象”。

### 3.6 conhost / OpenConsole 不在 shell 的子树里

ConPTY 的模型是：宿主先 `CreatePseudoConsole` 得到 `HPCON`，再用
`CreateProcessW` + `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 创建 shell
`[文档]`。console host（`conhost.exe` 或 OpenConsole）由 `CreatePseudoConsole`
一侧启动，**不是 shell 通过 `CreateProcess` 拉起的子进程**。因此：

- `taskkill /pid <shellPid> /T /F` 以 shell 为根，不覆盖 console host；
- `ClosePseudoConsole` 的文档说，关闭会话会终止仍连接的 client，以及 shell 拉起的
  相关 attached 进程树 `[文档]`；这是清理 console host / 会话的正路；
- node-pty 1.1.0 在自然退出时，exit watcher 只 `CloseHandle(hShell)` 并移除 baton，
  **没有关闭 `hpc`**（`src/win/conpty.cc:99-108`），因此自然退出会漏掉 pseudoconsole /
  console host。这就是上游 issue #965（“ConPTY: the pseudoconsole is never closed on a
  natural shell exit — the exit watcher erases the baton before onExit, leaking one
  conhost.exe per pty”，本轮读取时 open）。

这说明：即使把 shell 的 PID 问题修好，终端清理仍有一个独立的 conhost 生命周期问题；
它需要关闭 `hpc`，而不是再发一个 `taskkill`。console host 的具体父进程归属随
Windows 版本和启动路径而异，本轮没有逐进程核对 `[未验证]`。

### 3.7 严重性判断

| 维度 | 判断 |
| --- | --- |
| 触发概率 | 低到中。需要 shell 退出、exit 事件延迟/丢失、PID 在重试前被复用；繁忙机器、频繁创建短进程、大量标签会提高概率 |
| 影响 | 高。`/T` 会带走无关进程的当前子进程；可能是未保存文档、构建、测试、另一个终端、安全/备份工具，甚至本应用自己的进程 |
| 权限边界 | 与应用同 token。普通用户只能杀同用户、同等或更低完整性级别的进程；SYSTEM、受保护进程、其它用户进程会被拒绝。若应用被以管理员身份运行，爆炸半径变大 |
| 可检测性 | 低。误杀表现为“某个无关程序突然消失”，没有终端侧错误；当前日志也没有记录 PID 身份 |
| 既有性 | P1/P2 既有；P3-A 未引入也未修复。本文不把 P3-A 的 keep-alive 当成终止修复 |

## 四、威胁模型

### 4.1 资产与边界

- **资产**：用户同会话中的进程与未保存数据、构建/测试产物、其它终端、本应用后端与
  Electron 进程、用户的安全/备份/同步工具。
- **执行边界**：终端后端是 Electron 的 Node 子进程或独立 SEA 进程，通常以当前用户
  的普通 token 运行；`taskkill` 也以同一 token 运行。
- **输入边界**：renderer 不能提交 PID、shell 路径、cwd、参数或环境变量；会话 id 是
  UUID（`docs/security.md:729-768`）。因此攻击者不能直接指定“杀哪个 PID”，但可以
  通过创建/关闭会话、触发空闲超时、切换工作区等动作触发终止路径。
- **身份边界**：会话 id 不是进程身份；`pty.pid` 是内部数字，不对外暴露。真正的身份
  应由 PID + 创建时间 + 映像路径（可选命令行）组成。

### 4.2 触发方式

| 触发 | 谁/什么 | 是否需要恶意 | 说明 |
| --- | --- | --- | --- |
| 用户输入 `exit` 后关闭标签 | 用户 | 否 | 最常见的自然退出；exit 事件正常时 `stopSession` 看到 `exited`，不会杀；事件延迟/丢失时才会进入 `closing` |
| 空闲 30 分钟超时 | 服务端计时器 | 否 | `touch()` 到期后 `stopSession(session, 'idle')`；如果 shell 已退出但事件丢失，走同一路径 |
| 切换工作区 / scope sweep | 服务端 | 否 | workspace 失效时 `retireInBackground`；同样可能对一个已退出的 shell 重试 |
| 关闭应用 | Electron | 否 | `dispose()` + `killServer()`；后端树杀是另一条 PID 路径 |
| 应用崩溃 / 被强杀 | OS / 用户 | 否 | 没有 `killServer`；shell/conhost 可能成为孤儿（P3-C 的 Job 才能覆盖） |
| 用户在终端里运行不可信命令 | shell 子进程 | 可能是 | 命令可以让 shell 退出并制造大量短进程，诱导 PID 复用；攻击者已经拥有同用户执行权，这不是提权，而是借 GUI 的手误杀/清除其它进程 |
| 同用户恶意进程 | 本地进程 | 是 | 可以观察 PID、制造 churn、诱导复用；也可以直接杀进程，所以这不是“新增权限”，而是“让 GUI 成为放大器/掩盖痕迹” |
| 被攻陷的 renderer | 浏览器上下文 | 是 | 不能指定 PID，但可以反复 create/close/stop 触发 kill；受 workspace 校验和会话账本限制 |
| 安装/卸载器 | NSIS | 否 | `taskkill /IM "Pi GUI.exe"` 按映像名杀所有实例；与 PID 复用不同，但同样是“范围过大”的风险 |

### 4.3 权限边界

- `taskkill /F` 不是“管理员杀一切”。它受目标进程的 DACL 和调用者 token 限制；
  对 SYSTEM、受保护进程、其它用户、更高完整性级别的进程通常会失败
  `[文档]`（`OpenProcess` / Process Security and Access Rights）。
- 对同用户、同完整性级别的进程，它通常可以强制终止；这正是本风险的主要爆炸半径。
- 如果 Pi GUI 以管理员身份启动，它会以更高完整性级别运行，能杀掉更多同会话进程；
  这不是推荐运行方式。
- 终端 shell 由后端以当前 token 创建；shell 内的命令若通过 UAC 提权，会创建不同
  token 的进程。非提权的后端无法杀它；Job Object 也通常覆盖不了通过 ShellExecute /
  COM 提升出来的进程。

### 4.4 影响

| 影响 | 例子 | 备注 |
| --- | --- | --- |
| 数据丢失 | 编辑器未保存缓冲区、未提交的文档 | `/F` 不给保存机会 |
| 构建/测试损坏 | 正在写的 `dist/`、临时文件、数据库迁移 | 子进程树被一起带走 |
| 工具链中断 | 另一个终端、语言服务器、调试器、包管理器 | 同用户进程 |
| 安全/运维影响 | 备份、同步、日志采集、终端安全 agent | 受保护进程可能拒绝，但普通 agent 可能被杀 |
| 自伤 | 误杀本应用后端/Electron/其它标签 | 如果复用 PID 落在应用自己的树里 |
| 掩盖痕迹 | 恶意命令借 GUI 杀掉审计/监控进程 | 同用户攻击者本来也能直接杀，但 GUI 提供了“正常关闭终端”的掩护 |

### 4.5 非目标

本文不试图防御：

- 已经拥有同用户代码执行的攻击者直接杀进程；
- 管理员/内核级对手；
- 通过 UAC 提升出来的进程；
- 通过服务、计划任务、WMI 远程创建、COM 激活等机制刻意脱离父子链的进程；
- POSIX 的进程组/会话语义（本文聚焦 Windows；POSIX 路径仍走 `pty.kill()`）。

## 五、候选架构对比

| 方案 | 根 PID 复用 | 整棵树 | 应用崩溃 | 改 node-pty | 新原生依赖 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| A. 现状：`taskkill /T /F` + `pty.kill()` | 否 | 部分（仅当前树） | 否 | 否 | 否 | 不可接受，但改动最小 |
| B. 身份校验后 `taskkill` | 缩小窗口，不消除 | 部分 | 否 | 否 | 否（用 PowerShell/Get-Process） | P3-B 的现实选择 |
| C. 原生模块持句柄 + 身份校验 + 根 `TerminateProcess` | 根进程可钉住 | 否（只根） | 否 | 否 | 是 | 可作为 B 的加强，但不完整 |
| D. 原生模块创建后补 Job | 部分 | 部分（漏创建前子进程） | 部分（句柄关闭时杀） | 否 | 是 | 不推荐，语义不完整 |
| E. 上游在创建时分配 Job | 是（根/后代都在 Job） | 是（普通后代） | 是（`KILL_ON_JOB_CLOSE`） | 是 | 否（补丁进 node-pty） | 推荐的目标方案 |
| F. 自己实现 ConPTY + Job | 是 | 是 | 是 | 不复用 | 是（大） | 不划算，重复 node-pty |
| G. `useConptyDll=true` / winpty | 根进程按句柄（DLL 路径） | 否/部分 | 否 | 否 | 否 | 不是树杀修复；bundled DLL 已被仓库排除 |
| H. 独立 helper 进程 + Job | 是（helper 创建 shell 时） | 是（普通后代） | 是 | 不复用 | 是（helper + IPC） | 只有 helper 自己创建 PTY 才完整，等于重写终端 |

### 5.1 A. 现状

优点是简单、无新依赖、与 P2 验收一致；缺点是第 3 节的全部问题。它只能在“shell
一定还活着且 PID 没被复用”的前提下正确，而这个前提没有 API 能证明。

### 5.2 B. 身份校验后 `taskkill`

在 spawn 后立即抓取 shell 的 `(pid, creationTime, imagePath)`；停止前重新查询，只有
三者一致才调用 `taskkill`。不一致或查询失败就不杀。它能挡住“PID 已被复用”的绝大
多数情况，因为复用后的创建时间必然不同；但它仍然是“检查 → 系统调用”的两步，
中间有 TOCTOU。它也不能阻止 `taskkill` 在枚举树时把某个后代 PID 误认成目标的后代。

优点：不改 node-pty、不加原生依赖、可用 Windows PowerShell 的 Get-Process 或 CIM 查询实现。
缺点：每次 spawn 多一次 PowerShell 查询（延迟/成本）；身份查询本身可能失败；TOCTOU
仍在；`taskkill` 的树枚举仍按 PID/父子关系。

### 5.3 C. 原生模块持句柄 + 身份校验 + 根 `TerminateProcess`

原生 N-API 模块在 spawn 后尽快 `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION |
PROCESS_TERMINATE | SYNCHRONIZE, ...)`，用 `GetProcessTimes` 读创建时间、
`QueryFullProcessImageNameW` 读映像路径，校验后**一直持有句柄**，直到会话清理完成。
按 `PROCESS_INFORMATION` 的文档语义，持有句柄会阻止进程对象被释放，从而阻止该 PID
被复用；这样后续 `taskkill` 即使按 PID 打开，也只会打开那个已退出的原进程，而不是
无关进程。停止时可以 `TerminateProcess(handle, ...)` 杀根，或仍用 `taskkill` 杀树。
这一“钉住 PID”的效果是文档推断，本轮没有做运行时验证 `[未验证]`。

但它只能钉住**根**，不能钉住后代；`taskkill /T` 仍要枚举后代，仍可能因后代 PID
复用而误判。要覆盖后代，要么在创建时把它们放进 Job（D/E），要么在停止时枚举并
逐个持句柄（复杂且仍有竞态）。因此 C 是“根 PID 保护”，不是完整树杀。

另外，`OpenProcess` 必须在 shell 退出前成功；如果 shell 瞬间退出、node-pty 已经
关闭 `hShell`，就会失败。原生模块可以把这个失败变成“身份未知 → 不杀”，但不能
消除 spawn 到 open 的窗口。只有 node-pty 在 `PtyConnect` 内部复制/保留 `hShell`
才能消除这个窗口。

### 5.4 D. 原生模块创建后补 Job

原生模块在 `pty.spawn` 返回后创建 Job，设置 `KILL_ON_JOB_CLOSE`，把 shell
`AssignProcessToJobObject`。问题：

- shell 在 `pty.spawn` 返回前可能已经创建了子进程；这些子进程不会被追溯加入 Job。
  `AssignProcessToJobObject` 只影响之后创建的子进程，不会把已有子进程拉进来。
- shell 可能已经退出；Job 为空。
- 仍然拿不到 node-pty 的 `hpc`，无法正确关闭 pseudoconsole；conhost 泄漏仍在。
- 如果 Job 句柄由原生模块持有，后端崩溃时句柄关闭，`KILL_ON_JOB_CLOSE` 会杀 Job 内
  进程；这比没有好，但不是“创建时归属”。

所以 D 只能作为“补丁的补丁”，不能作为目标方案。

### 5.5 E. 上游在创建时分配 Job

在 node-pty 的 `PtyConnect` 里，在 `CreateProcessW` 之前创建 Job，设置
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，然后：

- 方案 E1：`CreateProcessW` 加 `CREATE_SUSPENDED`，`AssignProcessToJobObject(job,
  piClient.hProcess)`，再 `ResumeThread(piClient.hThread)`；或
- 方案 E2：`STARTUPINFOEXW` 增加第二个属性 `PROC_THREAD_ATTRIBUTE_JOB_LIST`，
  在创建时直接分配（Windows 10 / Server 2016+）。

这样 shell 从第一条指令起就在 Job 里，之后由 shell 通过 `CreateProcess` 创建的后代
默认继承 Job（除非 breakaway）。停止时 `TerminateJobObject` 杀 Job 内所有进程；
后端崩溃时 Job 最后一个句柄关闭，`KILL_ON_JOB_CLOSE` 杀整棵树。它还能顺带修复
`ClosePseudoConsole` / exit watcher 的清理路径（E 方案应同时关闭 `hpc`）。

这是唯一能同时解决“根 PID 复用”“后代树”“应用崩溃”三个问题的用户态方案。代价是
必须改 node-pty（上游 PR 或固定补丁）；需要重建 win32-x64（以及 arm64，如果发布）
的 prebuild；需要处理 Job 创建/分配失败、嵌套 Job、breakaway 和 WMI 例外。

### 5.6 F. 自己实现 ConPTY + Job

理论上最彻底：自己 `CreatePseudoConsole`、`CreateProcessW(CREATE_SUSPENDED)`、
`AssignProcessToJobObject`、`ResumeThread`，完全掌握 `hpc` / `hShell` / Job。但这等于
重写 node-pty 的 ConPTY 适配、管道、resize、conout、exit 通知、打包和测试；工作量
和维护成本远大于给 node-pty 打一个小补丁。不推荐。

### 5.7 G. `useConptyDll=true` / winpty

- `useConptyDll=true` 的 native kill 按 `hShell` 句柄 `TerminateProcess`，不走
  console-list 的裸 PID；但它只杀 shell，不保证后代，且 `ClosePseudoConsole` 的
  行为依赖 DLL 版本。仓库已经记录 bundled DLL 在目标环境失败，不能静默切换。
- winpty 的 `getProcessList` + `process.kill` 同样以 PID 为入口，不解决复用。
- 两者都不能提供 `KILL_ON_JOB_CLOSE` 的应用崩溃清理。

所以 G 不是树杀修复，只是“换一条同样不完整的路径”。

### 5.8 H. 独立 helper 进程 + Job

helper 进程可以创建 Job、启动 shell、持有句柄、在收到命令时 `TerminateJobObject`。
但 shell 必须通过 ConPTY 创建，而 ConPTY 的 `HPCON`、管道、resize、输出解析都在
node-pty 里；helper 要么只做“持句柄/杀根”（不完整），要么自己实现 PTY 中继（等于 F）。
独立进程还引入 IPC、生命周期、打包、签名和新的故障面。不推荐。

## 六、推荐实现

### 6.1 阶段划分

> P3-B / P3-C / P3-D 是本文建议的后续阶段名，不代表已经排期、分配或取得实现/合并授权。

| 阶段 | 内容 | 改代码 | 风险 closure | 前置条件 |
| --- | --- | --- | --- | --- |
| P3-A | 保持运行（当前分支） | 仅 keep-alive | 无；本文不修终止 | 不改 kill 路径 |
| P3-B | 身份门控 + 有界重试 + 去掉不安全的 Windows 回退 | 是 | 部分：挡住绝大多数复用，TOCTOU 仍在 | 用户同意；补定向测试 |
| P3-C | 上游 node-pty Job-at-creation | 是（node-pty 补丁/上游） | 完整（用户态范围内） | 上游接受或固定补丁；Windows 10+；打包重建 |
| P3-D | 原生 N-API 模块/helper | 是 | 不完整；只在 P3-C 不可行时评估 | 新依赖审批、构建/签名/打包 |

**本文的建议顺序是 P3-B → P3-C。** P3-B 不是“修复公告”，只是把风险从“每个
sweep 都可能误杀”降到“身份明确且匹配时才杀”；P3-C 才是根因修复。

### 6.2 P3-B：身份门控与有界重试

#### 6.2.1 抓取身份

在 `defaultSpawnPty` 返回后，尽快抓取 shell 身份：

```text
identity = {
  pid,                 // pty.pid
  creationTimeUtc,     // FILETIME / 100ns，来自 GetProcessTimes / Get-Process / CIM
  imagePath,           // QueryFullProcessImageNameW / Get-Process Path / CIM ExecutablePath
  commandLineHash,     // 可选；只用于二次核对，不进日志
}
```

无原生依赖的实现可以用 Windows PowerShell 的 CIM：

```powershell
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$pid"
[pscustomobject]@{
  CreationTimeUtc = ([datetime]$p.CreationDate).ToUniversalTime().ToFileTimeUtc()
  ImagePath       = [string]$p.ExecutablePath
}
```

> 实现最终选用了 `Get-Process -Id`：同等条件下比 CIM 快约 3-4 倍（CimCmdlets 模块
> 加载是主要成本），详见 §6.2.7。抓取与复查必须用**同一种**查询原语；CIM 的
> `CreationDate` 与 Get-Process 的 `StartTime` 精度不同，混用会产生假 `mismatch`。

注意：

- 必须用**绝对路径**的 Windows PowerShell（和 `resolveTerminalShell` 一样，不搜索
  PATH），避免被用户目录里的同名程序劫持。
- 查询要在 spawn 后尽快做；如果 shell 已退出并 PID 已复用，查到的可能是无关进程。
  因此要用**已知的 shell 映像路径**做一次 sanity check：`ExecutablePath` 必须匹配
  `resolveTerminalShell()` 返回的 `file`（规范化大小写和分隔符），否则标记
  `identityUnknown`，不要把它当成 shell 身份。
- 创建时间必须比较 UTC/FILETIME，不要比较本地化字符串；CIM 的 `DateTime` 与
  Get-Process 的 `StartTime` 都带本地时区，格式化字符串会引入时区/精度问题。
- 身份只存在内存；不写日志、不写盘、不进诊断报告。命令行的原文可能含用户信息，
  不要记录；如果确实需要二次核对，只保存哈希。

#### 6.2.2 停止时的判定

```text
current = queryIdentity(pid)       // 可能是 gone / match / mismatch / unknown
if (identityUnknown)               -> noKill('identity_unknown')
if (current == gone)               -> noKill('already_gone')
if (current == unknown)            -> noKill('identity_query_failed')
if (!sameIdentity(identity, current)) -> noKill('identity_mismatch')
else                               -> taskkill(pid)
```

四类结果必须区分：

| 结果 | 含义 | 动作 |
| --- | --- | --- |
| `match` | 当前 PID 仍是 spawn 时的 shell | 可以 `taskkill` |
| `gone` | 查询不到该 PID | shell 已退出；不要杀；等真实 exit；等不到则 `killUnconfirmed` |
| `mismatch` | PID 存在，但创建时间/映像不同 | **绝对不要杀**；这是复用；标记 `identity_mismatch` |
| `unknown` | 查询失败/超时/PowerShell 不可用 | 失败关闭，不杀；标记 `identity_unavailable` |

`sameIdentity` 至少比较 `creationTimeUtc` 精确相等 + `imagePath` 规范化后相等；
`commandLineHash` 只作为可选的第三项，不作为唯一判据（进程可以修改自己的 PEB
命令行，命令行不是安全边界）。

#### 6.2.3 不再回退 `pty.kill()`

P3-B 在 Windows 上**不应**在 `taskkill` 失败后调用 `pty.kill()`，因为：

- `pty.kill()` 会 fork console-list agent，用同一个裸 PID `AttachConsole`；
- agent 失败后 5 秒会 `process.kill(shellPid)`（#967）；
- 这时 shell 可能已经退出、PID 已复用，回退反而制造第二次误杀机会。

建议：

- Windows：只走身份门控的 `taskkill`；失败就 `killUnconfirmed`，不再用 `pty.kill()`
  兜底。
- POSIX：保持现有 `pty.kill()`（进程组/会话语义不同，不在本文范围）。
- 如果产品必须保留 Windows 回退，应把它限制为“身份匹配 + 调用瞬间 shell 仍存活”，
  并在文档和日志里明确标注“仍有 5 秒裸 PID 回退风险”；这不是默认推荐。

这个选择是安全优先：宁可留下一个未确认终止的会话（应用退出时还有 `killServer`
树杀），也不要在 PID 复用后误杀无关进程。

#### 6.2.4 有界重试

当前 `sweep` 对 `closing` 会话无限重试。P3-B 建议：

- 每个会话维护 `killAttempts`、`killInFlight`、`nextKillAt`。
- 只有身份仍 `match` 时才重试 `taskkill`；身份 `mismatch/gone/unknown` 时不再重试。
- 最多 3 次，退避例如 0s → 1s → 3s；之后标记 `killUnconfirmed`，停止 PID 杀。
- `stopSession` 和 `sweep` 不并发调用同一个会话的 kill；`killInFlight` 为 true 时
  sweep 跳过。
- `killUnconfirmed` 不谎报 `exited`；公开状态仍是 `closing`（或保留 `closing` +
  内部 `killState`），直到真实 `onExit`。前端可以显示“正在停止/无法确认”，但不把
  它当成已退出。
- 如果产品需要释放额度，另做显式的“确认强制释放”入口；不要自动把活进程当死进程。

#### 6.2.5 Electron 后端路径

`killServer()` 也应做同一类门控：

- 在启动后端时记录 `server.pid` + 创建时间 + 命令行/入口身份（后端是
  `ELECTRON_RUN_AS_NODE` 的 Electron 或 SEA；命令行可核对 `server.cjs` / 可执行文件）。
- 退出前重新查询；匹配才 `taskkill /T /F`；不匹配/未知则跳过 `taskkill`，只
  `server.kill()`（按 ChildProcess 句柄终止根进程）。
- 跳过 `taskkill` 的代价是后端的子进程可能成为孤儿；但比误杀无关树好。日志记录
  `backend_identity_mismatch` / `backend_identity_unavailable`，不记录命令行原文。
- 注意：Node 的 `ChildProcess` 对象通常持有后端进程句柄，`server.kill()` 按句柄
  终止，不会命中复用 PID；但 `taskkill /T` 仍是 PID 寻址。两者不要混为“已经安全”。

#### 6.2.6 日志

只记录结构化、无原始 payload 的字段：

```text
event=terminal.kill
session=<hash>
phase=identity|taskkill|result
result=match|gone|mismatch|unknown|success|failure|unconfirmed
attempt=<n>
taskkillExitCode=<n|null>
errorCode=<Win32/Node code|null>
jobMode=<true|false>
```

不要记录：PID 原文、命令行、映像完整路径、身份查询原始输出、`taskkill` stderr、终端输出。
PID 可以作为内存字段用于 `OpenProcess`，但不进日志/诊断报告。

#### 6.2.7 P3-B 实现落点（2026-11-13）

实际实现与本节设计的对应关系：

| 设计项 | 落地 |
| --- | --- |
| 抓取身份 | `lib/process-identity.cjs`；`defaultSpawnPty` 在返回前启动异步抓取，`WeakMap` 按 PTY 对象保存 |
| 冷启动重试 | 首次抓取为 `unknown` 时，PTY 首次输出后重试一次；`gone` / `mismatch` / `missing` 是确定答案，不重试；重试仍须 `captured` + `match` 才杀 |
| 查询实现 | 绝对路径 Windows PowerShell + `Get-Process -Id`；FILETIME 用十进制字符串保存，避免 JS number 精度损失 |
| 停止判定 | `server/terminal-process.js` 的 `createWindowsKillGate`；`match` 才 `taskkill`，`gone` / `mismatch` / `unknown` / 无身份一律不杀 |
| Windows 回退 | 删除 `ptyProcessAlive` 与 `pty.kill()` 回退；POSIX 保持 `pty.kill()` |
| 有界重试 | `server/terminal.js` 每会话 `killAttempts` / `killInFlight` / `killNextAt`；默认 3 次、退避 0/1 000/3 000 ms；未确认时公开状态仍为 `closing` |
| Electron 后端 | `electron/main.cjs` spawn 后异步抓取身份（仅 win32），退出前同步复查；仅 `match` 执行 `taskkill /T`，随后仍 `server.kill()`；跳过原因写已声明的 `electron.backend_kill_skipped` |
| 打包 | `scripts/build-app.mjs` 把 `lib/process-identity.cjs` 平铺进 `resources/app` |

> 查询原语在实现时从草案里的 `Get-CimInstance` 改为 `Get-Process -Id`：CimCmdlets
> 模块加载在 6 个并发查询下实测 3.4-4.3 s，会超过抓取必须保持的 2.5 s 紧预算；
> `Get-Process` 在同等条件下约 1.0 s。两者都给出创建时间与映像路径；只有
> `NoProcessFoundForGivenId` 映射为 `gone`，其它失败仍是 `unknown`。判定语义不变。
>
> 2026-11-13 PR #80 的两次 CI 仍在 `state=closing` 失败：15 s 窗口仍小于停止路径的
> 最坏首轮预算（停止复查 5 s + `taskkill` 8 s，另加抓取与 ConPTY exit），冷 runner
> 上 spawn 抓取也可能超过 2.5 s。现在的做法是：抓取保持 2.5 s；首次抓取为 `unknown`
> 时在 PTY 首次输出后重试一次（输出说明 shell 仍活着，缩窄但不消除 PID 复用窗口；
> `gone` / `mismatch` / `missing` 不重试）；canonical 测试窗口延长到 30 s，断言仍是
> 真实 `exited`；`PI_GUI_KILL_DEBUG=1` 时输出不含 PID/路径的结构化 `[kill]` 轨迹，
> 供 CI 失败时定位。

与设计的偏差：

- 没有新增服务端 `terminal.kill` / `dispose_unconfirmed` 结构化日志。加这些事件需要
  扩展日志契约（新 source/event）与日志 UI 的来源筛选；kill 结果保存在会话内部
  `killState`，`dispose()` 3 秒超时清空账本时不留日志。Electron 跳过树杀写现有
  `mlog` 的 `electron.backend_kill_skipped`，只记结果分类，不记录 PID、命令行、
  映像路径或原始身份查询输出。
- 身份探测时间预算分三档：spawn 抓取 `DEFAULT_CAPTURE_TIMEOUT_MS = 2 500 ms`（保持
  紧预算，缩小“shell 退出后 PID 被复用、抓取读到无关进程”的窗口；异步，不阻塞创建），
  停止复查 `DEFAULT_QUERY_TIMEOUT_MS = 5 000 ms`（结果始终与已抓取身份比较，慢查询
  只会延迟决定，不会放宽杀的条件），Electron 退出同步复查
  `DEFAULT_SYNC_QUERY_TIMEOUT_MS = 2 500 ms`；`taskkill` 超时 8 000 ms；默认
  重试预算 3 次。它们是实现常量，不是产品配置。2026-11-13 合并后的 CI flake 复盘
  显示，并发拆卸多个 shell 时 stop→真实 exit 可达 5.4 s（旧 CIM 复查≈2.0 s、
  `taskkill`≈2.7 s、exit≈1.0 s；改用 Get-Process 后 6 并发复查约 1.0 s）；
  停止复查原来与抓取共用 2.5 s 预算，对实测 2.0 s 余量过小，慢查询会被判成
  `unknown` 并永久停在 `closing`。canonical 测试的 exit 轮询窗口先从 5 s 延长到
  15 s，PR #80 仍失败后再延长到 30 s；断言仍只接受真实 `exited`，不把 `closing`
  当成功。
- 抓取失败或查询失败一律不杀。停止可能停在 `closing` 并继续占用会话额度，这是
  安全优先的接受结果，不自动释放额度。
- 身份查询以 0 退出但输出为空/不可解析时按 `unknown`，不按 `gone`；只有显式的
  `exit 3` 才表示该 PID 不存在。
- Electron 后端身份抓取只在本机 `win32` 执行；POSIX 开发运行不抓取，仍按
  `ChildProcess` 句柄结束后端。抓取回调只比较 spawn 时的局部 pid，后端在查询返回前
  退出不会解引用已置空的 `server`。

实现没有改变第 3 节的根因判断：查询与 `taskkill` 仍是两步，TOCTOU 仍在；后代枚举
仍按 PID，P3-C 的 Job Object 仍是完整修复。验收结果见
[terminal-p3b-termination-acceptance.md](terminal-p3b-termination-acceptance.md)。

### 6.3 P3-C：上游 node-pty Job-at-creation

#### 6.3.1 API 形状

建议给 `IWindowsPtyForkOptions` 增加可选字段（默认关闭，保持兼容）：

```ts
interface IWindowsPtyForkOptions {
  // ...
  /** 在创建 shell 时把它放入 Job；默认 false，保持旧行为。 */
  useJobObject?: boolean;
}
```

并在 `IPty` 上暴露一个能力字段，例如：

```ts
readonly treeKill?: 'job' | 'legacy';
```

或者一个 `killTree()` 方法。关键是让调用方能区分“`pty.kill()` 会 TerminateJobObject”
和“`pty.kill()` 仍是 console-list/裸 PID”，不能静默声称安全。

#### 6.3.2 `conpty.cc` 补丁点

1. `pty_baton`（`src/win/conpty.cc:42-50`）增加 `HANDLE hJob = NULL;`。
2. `PtyConnect`（`:325-450`）在 `CreateProcessW` 前创建 Job：

```cpp
HANDLE hJob = CreateJobObjectW(nullptr, nullptr);
if (hJob) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info{};
  info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, &info, sizeof(info));
}
```

3. 创建 shell 时二选一：
   - E1：`dwCreationFlags |= CREATE_SUSPENDED`；`CreateProcessW` 成功后
     `AssignProcessToJobObject(hJob, piClient.hProcess)`；再
     `ResumeThread(piClient.hThread)`；最后 `CloseHandle(piClient.hThread)`。
   - E2：在已有的 `STARTUPINFOEXW` 上增加 `PROC_THREAD_ATTRIBUTE_JOB_LIST`，
     `InitializeProcThreadAttributeList` 的 count 从 1 改为 2；Job 句柄数组必须在
     `CreateProcessW` 返回前保持有效。Windows 10 / Server 2016+ 支持。
4. `PtyKill`（`:534-568`）优先：

```cpp
if (handle->hJob) {
  TerminateJobObject(handle->hJob, 1);
}
ClosePseudoConsole(handle->hpc);
if (useConptyDll && !handle->hJob) {
  TerminateProcess(handle->hShell, 1);
}
```

   Job 模式下不要再 fork console-list agent，也不要 `process.kill(pid)`。
5. exit watcher（`:99-108`）在 shell 退出后：

```cpp
CloseHandle(baton->hShell);
if (baton->hJob) { CloseHandle(baton->hJob); baton->hJob = NULL; } // KILL_ON_CLOSE
ClosePseudoConsole(baton->hpc); // 修 #965
remove_pty_baton(baton->id);
```

   注意 `ClosePseudoConsole` 在 Windows 11 24H2 之前可能因输出管道未 drain 而阻塞
   `[文档]`；它应该在 exit watcher 的独立线程里调用，并保持 conout 继续 drain。
6. `WindowsPtyAgent.kill()`（`node_modules/node-pty/lib/windowsPtyAgent.js:133-180`）在 job 模式下跳过
   `_getConsoleProcessList()`，避免 #967；`kill()` 仍返回 Promise/void 的现有契约，
   但内部不再有裸 PID 回退。

#### 6.3.3 Job 失败与降级

`CreateJobObject` / `SetInformationJobObject` / `AssignProcessToJobObject` 可能失败：

- 父进程已在 Job 中且不允许嵌套（Windows 8+ 通常允许嵌套；新 Job 不能有 UI limit，
  我们的 Job 没有 UI limit；见 `AssignProcessToJobObject` 文档）。
- 进程已退出 / 句柄无效。
- 访问权限不足（`PROCESS_SET_QUOTA | PROCESS_TERMINATE`）。
- 父 Job 正在终止。

建议：

- Job 模式下，创建/分配失败就 `TerminateProcess` 掉已创建（suspended）的 shell，
  关闭 `hpc`，抛 `pty_job_unavailable`；**不要**静默降级并声称树杀安全。
- 如果产品需要可用性优先，可以显式允许 legacy 降级，但必须把
  `treeKill: 'legacy'` 暴露给服务端，由服务端改用身份门控的 `taskkill`，并在状态/
  日志里标注“本次没有 Job 保护”。
- 不能把“Job 失败”当成“已经放进 Job”。

#### 6.3.4 Job 语义边界

- Job 只覆盖**之后**通过 `CreateProcess` 继承的后代；`Win32_Process.Create` 创建的
  子进程明确不会被关联 `[文档]`。这是文档写明的逃逸路径。
- 不设置 `JOB_OBJECT_LIMIT_BREAKAWAY_OK` / `SILENT_BREAKAWAY_OK`，普通
  `CREATE_BREAKAWAY_FROM_JOB` 会失败；但父 Job 的 breakaway 设置可能影响嵌套行为。
- `TerminateJobObject` 终止当前 Job 内所有进程及子 Job，但不保证等待全部退出；之后
  仍要等真实 `onExit`。
- 不要给 Job 设置 UI limit（会影响嵌套分配），也不要设置内存/CPU 限制（会改变终端
  里命令的行为）。
- Job 句柄必须**不可继承**（`CreateJobObject(NULL, NULL)` 默认不可继承），且不能
  被 shell 继承；否则后端崩溃时最后一个句柄不关闭，`KILL_ON_JOB_CLOSE` 不会触发。

#### 6.3.5 与服务的协作

服务端 `defaultKillPty` 需要知道当前 PTY 的能力：

```text
if (pty.treeKill === 'job') {
  pty.kill();          // TerminateJobObject + ClosePseudoConsole
  return;
}
// legacy: identity-gated taskkill (P3-B)
```

这样 P3-C 不会又走回 `taskkill`；P3-B 的路径保留给旧版 node-pty / Job 不可用的情况。

### 6.4 P3-D：原生模块的取舍

只有在 P3-C 上游/固定补丁不可行时，才评估 P3-D。可选形态：

- **N-API 模块**：`OpenProcess` + `GetProcessTimes` + `QueryFullProcessImageNameW` +
  `TerminateProcess`；可持句柄钉住根 PID；可在 spawn 后创建 Job（但漏已存在子进程）。
- **独立 helper exe**：持有 Job/句柄、接收 IPC；要完整覆盖树，必须自己创建 PTY
  （等于 F），否则只能杀根。

两者都需要新的原生构建、prebuild、SEA/asar sidecar、签名和 CI；且都不能提供
“创建时 Job”语义。**本轮不建议引入。**

## 七、node-pty 1.1.0 可行性

### 7.1 公开 API 与内部对象

| 能力 | node-pty 1.1.0 | 证据 |
| --- | --- | --- |
| 获取 shell PID | `pty.pid` | `node_modules/node-pty/typings/node-pty.d.ts:116-120`；ConPTY 下 `_innerPid = connect.pid`（`node_modules/node-pty/lib/windowsPtyAgent.js:88-91`） |
| 获取进程句柄 | 无 | `IPty` 没有 handle 字段；`pty_baton` 的 `hShell` 是 C++ 内部（`src/win/conpty.cc:42-50`） |
| 获取 pseudoconsole 句柄 | 无 | `pty_baton.hpc` 内部；JS 无法 `ClosePseudoConsole` |
| 获取 Job 句柄 | 无 | `PtyConnect` 没有 `CreateJobObject` / `AssignProcessToJobObject` |
| 树杀 | `kill()`，但系统 ConPTY 走 console-list + 裸 PID | `node_modules/node-pty/lib/windowsPtyAgent.js:133-195` |
| 按句柄杀根 | 仅 `useConptyDll=true` 的 `TerminateProcess(hShell)` | `src/win/conpty.cc:562-564` |
| 自然退出清理 | 关闭 `hShell`，但不关闭 `hpc`；baton 先移除再 onExit | `src/win/conpty.cc:99-108`；#965 |

`pty.pid` 的注释说“outer process”，但 ConPTY 下实际是 shell PID；不要被注释误导。
`WindowsPtyAgent` 的 `_pid` 在 ConPTY 下是 0，`_innerPid` 才是 shell
（`node_modules/node-pty/lib/windowsPtyAgent.js:35-36, 88-91`）。

### 7.2 不改 node-pty 能做什么

- 抓 PID + 创建时间 + 映像路径（PowerShell/Get-Process）。
- 在 `taskkill` 前做身份校验，匹配才杀；不匹配/未知不杀。
- 有界重试、单飞、日志、状态机。
- 在 Electron 后端路径做同样的门控。
- 用测试替身覆盖 match/gone/mismatch/unknown。

**不能**做：

- 把检查与 `taskkill` 变成原子操作；
- 钉住根 PID（除非另写原生模块）；
- 保证后代树；
- 覆盖应用崩溃后的孤儿；
- 修 #965 / #967。

### 7.3 小原生模块能做什么

- 用 `OpenProcess` + `GetProcessTimes` + `QueryFullProcessImageNameW` 做精确身份；
- 持句柄钉住根 PID（文档语义，见 3.1；本轮未做运行时验证）；
- `TerminateProcess` 根进程（按句柄，安全但只根）；
- 在 spawn 后创建 Job 并分配 shell（只覆盖之后创建的后代，不完整）；
- 在模块析构/句柄关闭时用 `KILL_ON_JOB_CLOSE` 清理 Job 内进程（补丁式，不完整）。

**不能**做：

- 拿到 node-pty 的 `hpc` / `hShell`；
- 在 `CreateProcessW` 之前把 shell 放进 Job；
- 追溯已创建的子进程；
- 正确关闭 pseudoconsole；
- 不修改 node-pty 就把 `pty.kill()` 的 console-list 回退去掉。

### 7.4 上游改动能做什么

- 在 `PtyConnect` 创建 shell 时分配 Job（E1/E2）；
- `TerminateJobObject` 替代 console-list + `process.kill`；
- exit watcher 关闭 `hpc`，修 #965；
- 可选：把 `hShell` 句柄以安全方式暴露/复制给原生模块，或提供 `isAlive()` 按句柄
  判断；
- 可选：修 #967，至少让 `_getConsoleProcessList` 超时不要回退到裸 PID。

这是唯一完整的用户态方案。上游是否接受、何时接受未知；本轮只确认 #965/#967 仍
open，没有确认任何 Job 支持的上游计划。

### 7.5 补丁规模评估

按第 6.3.2 的改动，`conpty.cc` 的核心 diff 大约是：

- `pty_baton` 加一个 `HANDLE`；
- `PtyConnect` 加 Job 创建 + 根据 E1/E2 的创建/分配逻辑；
- `PtyKill` 加 `TerminateJobObject` 分支；
- exit watcher 加 `CloseHandle(hJob)` + `ClosePseudoConsole(hpc)`；
- `windowsPtyAgent.js` 的 `kill()` 在 job 模式下跳过 console-list；
- 选项/类型/测试。

这不是“重写 node-pty”，但也不是零风险：Job 创建失败、嵌套 Job、breakaway、WMI
例外、`ClosePseudoConsole` 阻塞、prebuild 重建、旧 Windows 兼容都要测。P3-C 应按
高风险变更走独立安全审查和用户明确授权。

## 八、原生依赖与打包影响

### 8.1 Electron ABI 与构建链

- 新原生模块应使用 **N-API / node-addon-api**，ABI 稳定，不需要为每个 Electron
  版本重编。node-pty 本身已经用 N-API 和 prebuilds（`node_modules/node-pty`
  含 `prebuilds/win32-x64` / `win32-arm64`）。
- 但 N-API 不等于“无需构建”：维护者仍需要 node-gyp + Python + VS Build Tools
  生成 win32-x64/arm64 prebuild；本地开发机和 CI 需要这条链。仓库当前没有自己的
  原生构建步骤，也没有 `prebuildify` / `node-gyp-build` 依赖；引入它们是新的
  开发依赖决策，需按 AGENTS.md 说明必要性、替代方案、体积和安全影响并取得同意。
- 如果选择“把 prebuild 提交进仓库”，会增加二进制审查、仓库体积和供应链风险；
  如果选择“CI 构建”，会增加 Windows runner 时间、缓存和签名步骤。

### 8.2 SEA / asar / 应用打包

当前 node-pty 的打包方式：

- `scripts/node-pty-package.mjs`：复制 `package.json` / `LICENSE` / `README` /
  `lib/**/*.js` / 当前平台 prebuild 到目标目录；不能进 asar，也不能进 SEA blob。
- `scripts/build-exe.mjs:129-134`：SEA sidecar 到 `build/node_modules/node-pty`。
- `scripts/build-app.mjs:106-112`：Electron stage 到
  `resources/app/node_modules/node-pty`，`asar: false`（`:250`），target 固定
  `win32-x64`（`:243-247`）。
- 加载器 `server/terminal-process.js:50-94` 只从源码树、应用资源目录、可执行文件
  同目录加载，不搜索 `process.cwd()`。

新增原生模块需要：

- 新的 sidecar 目录（不能进 asar/SEA blob）；
- 受信加载器（同样的白名单目录，不能走 cwd）；
- 两个构建脚本都 stage（SEA + Electron）；
- `tests/app-check.cjs` / `tests/exe-check.cjs` / 打包检查覆盖；
- 平台/架构（win32-x64，若支持 arm64 也要）；
- 升级/回滚时处理旧 `.node` 文件。

如果 P3-C 只改 node-pty，则沿用现有 sidecar 机制，不新增模块；但需要重建并 stage
打补丁后的 `conpty.node` / `conpty.dll`，并更新 prebuild 的来源/校验（如果从上游
npm 安装，必须确保拿到的是打补丁的版本，而不是旧 prebuild）。

### 8.3 签名

`docs/code-signing.md` 当前状态（`:7-9`）：

> 现状：**尚未接入任何签名。** 申请还没提交，仓库里也没有 SignPath 的 secrets。
> 已就位的是 `.github/workflows/signpath-sign.yml`（手动触发、缺配置即安静跳过）。

同一文档 `:13-17` 判断“Pi GUI 没有任何自己编译出来的一手 PE，唯一的例外是 NSIS
安装程序”。新增原生 `.node` 会打破这个判断：

- `.node` 是 PE/DLL，属于一手编译产物，理论上应进入签名边界；
- 但 SignPath 当前只签 NSIS 安装程序，且不会递归签 PE 内部文件
  （`code-signing.md:48-52`）；`.node` 在 `resources/app/node_modules` 里，不在
  安装器签名范围内；
- 未签名的原生二进制可能触发 AV/SmartScreen/企业策略；签名需要新的 artifact
  configuration、构建步骤和人工批准。

P3-C 只改 node-pty 的 prebuild，同样涉及“这个 `.node` 是谁编译的、是否可复现、
是否要签”的问题；不能因为文件名还是 node-pty 就当成上游二进制。本文不展开签名
接入方案，只把它列为 P3-C/P3-D 的前置评估项。

### 8.4 CI 与测试入口

- `npm test` 是测试入口的唯一真相（AGENTS.md；“测试执行政策”）；新增单元测试应
  注册进现有 `test` 链或 alias，不能在 workflow 里另抄清单。
- 新增原生构建/prebuild 步骤应放在 `scripts/`，由 `build:*` / `test:*` 调用；
  CI 可以分组执行，但测试清单仍来自 `package.json`。
- 原生模块的 ABI/平台测试至少覆盖：加载失败（`pty_unavailable`）、x64 构建、
  Electron 打包、SEA sidecar、应用退出清理。

### 8.5 结论

- **P3-A / P3-B 不引入新原生依赖。** P3-B 用 PowerShell/Get-Process 做身份查询，代价是
  每次 spawn 多一次查询；不新增包。
- **P3-C 优先上游/固定补丁**，沿用 node-pty 的 sidecar，不新增模块；但需要重建
  prebuild、处理签名/供应链。
- **P3-D 原生模块只在 P3-C 不可行时评估**，并且必须作为依赖决策单独审批；它不是
  “小改动”。

## 九、失败恢复

### 9.1 场景与动作

| 场景 | 检测 | 动作 | 状态/日志 | 残余 |
| --- | --- | --- | --- | --- |
| shell 已自然退出，exit 事件已到 | `handleExit` | 不杀；清理订阅 | `exited` | 无 |
| shell 已退出，exit 事件丢失 | 身份查询 `gone` | 不杀；等真实 exit；超时后 `killUnconfirmed` | `closing` + `killUnconfirmed` | 会话占额度；应用退出时后端树杀兜底 |
| PID 已复用 | 身份 `mismatch` | 不杀；标记；不再重试 | `closing` + `identity_mismatch` | 真正的 shell 已死；PTY 对象可能仍持有 hpc |
| 身份查询失败/超时 | `unknown` | 不杀；可重试查询但不要杀 | `identity_unavailable` | 清理不完整 |
| `taskkill` 非 0 | 退出码 | 不调用 `pty.kill()`；按身份决定是否重试 | `taskkill_failed` | 进程可能仍活 |
| `taskkill` 成功但无 exit | 5s 超时 | 身份仍 match 才重试；有界 | `kill_pending` / `killUnconfirmed` | exit 事件可能延迟 |
| 同一个会话并发 stop/sweep | `killInFlight` | 单飞；后来的等待 | `kill_in_flight` | 不会重复杀 |
| Job 创建/分配失败 | 返回码 | 失败关闭或显式 legacy；不声称安全 | `job_unavailable` | 退回身份门控 taskkill |
| Job 句柄丢失/失效 | `TerminateJobObject` 失败 | 记录；尝试身份门控 taskkill；不声称成功 | `job_lost` | 后代可能逃逸 |
| 后端崩溃/被强杀 | 无 `killServer` | 无 Job：孤儿；有 Job：`KILL_ON_JOB_CLOSE` | 启动后诊断 | conhost/WMI/提权后代仍可能逃逸 |
| 后代脱离父子链 | 无法从 shell 树观察到 | 不追；文档声明 | — | 既有边界 |
| conhost / OpenConsole 残留 | 退出后按父/命令行身份检查 | 记录；P3-C 用 `ClosePseudoConsole` 修 | `conhost_orphan` | 上游 #965 |
| `ClosePseudoConsole` 阻塞 | kill 调用不返回/超时 | 不要在同一线程无限等；exit watcher 独立线程；JS 侧有界等待 | `pseudoconsole_close_timeout` | 老 Windows 的输出管道 drain 问题 |
| `taskkill` 不存在/被策略阻止 | spawn error | 不裸杀；标记 | `taskkill_unavailable` | 清理不完整 |

### 9.2 状态机

建议保留现有公开状态，不新增会破坏前端的状态名：

```text
creating -> running -> closing -> exited
                 \-> error
```

在服务端内部增加 `killState`：

```text
pending -> confirmed
        \-> unconfirmed (identity_mismatch | identity_unavailable | taskkill_failed | timeout)
```

- `closing` 只表示“正在停止”，不表示“已死”。
- `killUnconfirmed` 不是 `exited`；不要把进程当死进程释放额度或复用。
- 如果产品需要“无法确认时强制释放”，必须是单独的、显式的用户动作，并记录风险；
  不能由 sweep 自动做。
- `dispose()` 仍等 3 秒；超时后清空账本是现有行为，但应在日志里留下
  `dispose_unconfirmed`，避免“清空=已清理”的假象。

### 9.3 有界等待

现有边界：

- `stopSession` 等 5 秒（`server/terminal.js:343`）。
- `dispose` 等 3 秒（`:883`）。
- sweep 每 5 秒（`:52`）。

建议：

- 保留这些时间作为**等待上限**，但不要把“等够时间”当成“已终止”。
- kill 重试的退避与等待分开：等待是 UI/调用方的上限，重试是后台状态机。
- `ClosePseudoConsole` 可能无限阻塞（Windows 11 24H2 之前），JS 侧的 5 秒不能取消
  原生调用；P3-C 应把 close 放到独立线程，并确保 conout 继续 drain。
- 如果 `taskkill` 进程本身挂起，`execFileSync`/`spawn` 要有超时；当前
  `electron/main.cjs` 的 `execFileSync` 有 10 秒 timeout，`server/terminal-process.js`
  的 `spawn` 没有显式 timeout；P3-B 应加有界等待/超时，超时后按失败处理。

### 9.4 日志规则

- 只记结构：`event`、`sessionHash`、`phase`、`result`、`attempt`、`exitCode`、
  `errorCode`、`jobMode`。
- 不记：PID 原文、命令行、映像路径、身份查询原文、`taskkill` stderr、终端输出、
  环境变量。
- 失败不是成功：`killUnconfirmed` 必须显式记录，不能用“已经发起 kill”代替“已终止”。
- 如果断言/日志里需要关联会话，用 UUID 的哈希，不用 PID。

## 十、测试计划

### 10.1 原则

- **用身份，不用裸 PID。** 断言“shell 已消失”必须比较 PID + CreationDate +
  CommandLine（或至少 CreationDate + 映像路径），不能只 `process.kill(pid, 0)`。
- **不要测试真实 PID 复用。** 真实复用不可控且会 flaky；用注入的 identity provider
  构造 `match / gone / mismatch / unknown` 四种结果。
- **失败查询不等于 gone。** PowerShell 身份查询失败要当成 `unknown`，测试必须覆盖；
  不能把空字符串当成“进程不存在”。
- **标记用命令行，清理用标记。** 和现有 `terminal-source-check.cjs:41-51` 一样，用
  唯一 marker 查进程，不用 PID 当判据。
- **有界轮询，不用固定 sleep 当证明。** `tests/terminal-electron-check.cjs:96-105` 的
  `waitForIdentityChange` 是范例：轮询到身份变化或超时，查询失败保留错误。

### 10.2 单元/假 PTY

| 用例 | 断言 |
| --- | --- |
| identity match | 调用 `taskkill`/kill；一次；状态 `closing` |
| identity mismatch | 绝不调用 `taskkill`、绝不调用 `pty.kill()`；日志 `identity_mismatch` |
| identity gone | 不杀；等待 exit；超时 `killUnconfirmed` |
| identity unknown | 不杀；日志 `identity_unavailable` |
| 身份查询失败 | 不把失败当 gone；不杀 |
| 无 identity（spawn 时抓取失败） | 永不 `taskkill`；可运行但清理降级 |
| `taskkill` 非 0 | 不调用 `pty.kill()`（Windows）；有界重试后 `killUnconfirmed` |
| 并发 stop + sweep | 单飞；只调用一次 kill |
| 重试上限 | 最多 N 次；之后不再按 PID 杀 |
| `killUnconfirmed` | 公开状态不是 `exited`；不释放额度 |
| dispose 超时 | 记录 `dispose_unconfirmed`；不谎报 exit |
| 结构性检查 | 没有“无身份门控的 taskkill”；没有 Windows `pty.kill()` 回退；SystemRoot 绝对路径；one-shot 保护仍在（或由会话级状态替代） |

现有 `tests/files-terminal.cjs:1359-1372` 的 `ptyProcessAlive` 测试只证明“活进程
true / 死进程 false”，不能证明“复用 PID 不 true”。P3-B 应改/删这个断言，换成
identity 测试；如果保留，要注明它只是 liveness，不是 identity。

### 10.3 Windows 集成（真实 ConPTY）

| 用例 | 方法 | 断言 |
| --- | --- | --- |
| 正常 stop | 真实 `node server.js` + 仓库 node-pty；启动带 marker 的 Node 子进程；`stop` | marker 按命令行消失；shell 按 CreationDate + CommandLine 消失 |
| 自然 exit | 输入 `exit`；等 `exited` | 不触发不必要的 kill；marker 消失 |
| 关闭一个标签 | 三个会话；关闭第三个 | 只第三个的 marker/shell 消失；其它仍活 |
| 应用退出 | Electron 真实运行；关闭应用 | 所有 marker/shell 按身份消失；无 ConPTY helper 崩溃栈 |
| 无关进程保护 | 启动一个 unrelated sentinel；用 fake identity 让某个会话结果为 `mismatch`；触发 stop | sentinel 仍活；没有 `taskkill` 调用 |
| 身份查询失败 | fake provider 返回 `unknown` | 不杀；日志正确 |
| `taskkill` 失败 | fake kill 返回非 0 / 注入 `taskkill` 替代 | 不调用 `pty.kill()`；有界重试；`killUnconfirmed` |
| conhost 残留 | 应用退出后按父 PID + 命令行/创建时间查 `conhost.exe --headless` / `OpenConsole.exe` | 若有残留，记录为已知 #965；不要把它藏进“全绿” |
| 后代逃逸（文档化） | shell 内用 `Win32_Process.Create` 创建 marker | 预期逃逸；记录为 Job 的已知边界，不作为失败 |
| 提权进程（不可自动化） | 需要 UAC | 不作为 canonical；文档标未验证 |

注意：真实集成里“让 identity 结果为 mismatch”需要服务端注入 fake identity provider
或直接测 `defaultKillPty` 的决策函数；不要等真实 PID 复用。生产代码应把 identity
查询做成可注入依赖，测试才能稳定覆盖。

### 10.4 Electron 验收

现有 `tests/terminal-electron-check.cjs` 已经做了正确的身份检查：

```js
function processIdentity(pid) {
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'; if($p){[string]$p.CreationDate + '|' + [string]$p.CommandLine}`;
  return runPowerShell(script);
}
async function waitForIdentityChange(pid, identity, timeoutMs = 15000) { ... }
```

它明确写着“A reused PID has a different creation time/command line; compare the
full identity captured before shutdown. A failed query is not proof the process is
gone.”（`:838-844` 附近的注释）。P3-B/P3-C 应沿用这个模式，并新增：

- unrelated sentinel 在关闭标签/应用退出后仍活；
- 关闭应用后没有 ConPTY helper 崩溃栈；
- P3-C 的 job 模式下，强杀后端/Electron 后 marker 树被 `KILL_ON_JOB_CLOSE` 清理
  （单独专项，不进 canonical 的普通桌面组）；
- 打包后的 `dist-app` / SEA 也跑一次最小终端创建/停止，确认 sidecar 加载。

### 10.5 打包与原生模块

如果 P3-C 补丁 node-pty：

- 重建 `build:app` / `build:exe`；
- 检查 `resources/app/node_modules/node-pty/prebuilds/win32-x64/conpty.node` 与
  `conpty/conpty.dll` 的版本/摘要；
- `tests/app-check.cjs` / `tests/exe-check.cjs` 在临时目录启动，创建/停止终端；
- 真实 Electron 退出后 marker 树清理；
- 不在测试里依赖开发 `node_modules`。

如果 P3-D 新增模块：

- 额外检查 sidecar 路径、ABI、加载失败降级、签名/AV（如已接入）；
- `pty_unavailable` 仍要能显式报错，不能被状态接口掩盖。

### 10.6 测试注册与证据

- 单元测试加进 `tests/files-terminal.cjs` 或新的 `tests/terminal-process-identity.cjs`，
  注册到 `package.json` 的 `test:work-surfaces` / `test` 链；不要在 workflow 另抄。
- 真实 ConPTY 集成继续走 `test:terminal:source`（单独入口，不属于无桌面 canonical）。
- Electron 继续走 `test:terminal:electron`（单独入口）。
- 纯文档变更本轮不跑完整 `npm test`；理由见第 12 节。

### 10.7 避免 flaky

- 不写“等 PID 复用”的测试；用 fake identity。
- 不写“睡 5 秒然后断言”的测试；用有界轮询 + 身份查询。
- 不用 `taskkill` 退出码单独证明树已死；查身份。
- 不把身份查询失败当 gone；测试失败/重试。
- 不把 `conhost` 命令行当成唯一身份；结合父 PID + 创建时间；查不到就标 unknown，
  不要把 unknown 当通过。
- 不用真实用户项目/会话做写操作；全部 `os.tmpdir()` fixture（AGENTS.md 硬约束）。

## 十一、剩余风险

以下风险**不能**被 P3-B 完全消除；P3-C 能消除一部分，但仍有用户态边界：

1. **身份校验到 `taskkill` 之间的 TOCTOU。** 检查创建时间和 `taskkill` 打开目标是
   两个动作；PID 可以在这之间被复用。创建时间校验**不能**消除这个窗口。
2. **`taskkill /T` 内部的树枚举。** 即使根身份匹配，后代也可能在枚举前退出、PID
   被复用；`taskkill` 只看当前父子关系，不按创建时间验证每个后代。
3. **spawn 到持句柄之间的窗口。** 原生模块在 `pty.spawn` 返回后才 `OpenProcess`；
   如果 shell 瞬间退出，可能抓不到。只有 node-pty 在 `PtyConnect` 内部保留/复制
   `hShell` 才能消除。
4. **Job 的文档化逃逸。** `Win32_Process.Create` 创建的子进程不加入 Job；设置
   breakaway 的父 Job、提权/COM/服务/计划任务创建也可能逃逸。Job 不是内核级沙箱。
5. **提权进程。** 非提权后端无法终止更高完整性级别进程；Job 也覆盖不了通过 UAC
   提升出来的进程。
6. **应用崩溃 / 无 Job。** 没有 `KILL_ON_JOB_CLOSE` 时，父进程死亡不会自动杀子进程；
   `killServer` 只在优雅退出运行。P3-C 的 Job 能覆盖普通后代，但不能覆盖 4/5。
7. **conhost / OpenConsole 泄漏。** node-pty 1.1.0 自然退出不关 `hpc`（#965）；
   `taskkill /T` 以 shell 为根不覆盖 console host。P3-C 关闭 `hpc` 能修，但仍受
   `ClosePseudoConsole` 阻塞/版本差异影响。
8. **node-pty 自己的裸 PID 回退。** #967：`_getConsoleProcessList` 5 秒超时后
   `process.kill(shellPid)`。P3-B 必须避免调用 `pty.kill()` 的 Windows 回退；P3-C
   应在 job 模式下跳过 console-list，并修这个回退。
9. **`ClosePseudoConsole` 阻塞。** Windows 11 24H2 之前，输出管道未 drain 可能无限
   等待；JS 的 5 秒超时不能取消原生调用。
10. **命令行不是身份。** 进程可以修改自己的 PEB 命令行；不要用命令行做安全边界。
    创建时间更强，但也不是秘密；它只用于区分实例，不用于授权。
11. **身份查询依赖 Windows PowerShell。** 查询可能慢、被 AV/策略阻止、在精简系统上
    不可用；失败关闭意味着清理可能不完整。
12. **`taskkill` 本身可能不可用/被策略阻止。** 失败关闭意味着会话可能留在
    `closing`；应用退出时的后端树杀仍是独立兜底。
13. **Electron 后端树杀仍是 PID 寻址。** `killServer` 的 `taskkill /pid <backend>`
    也有同类窗口；Node 的 ChildProcess 句柄降低了根进程复用概率，但没有形式化证明。
14. **同用户攻击者。** 已经能执行代码的同用户进程本来就能杀进程；本文只防“我们的
    代码误杀”，不防“攻击者自己想杀”。PID churn 诱导复用是可能的，身份门控只能
    降低概率。
15. **安装器按映像名杀。** `installer/pi-gui.nsi` 的 `taskkill /IM` 会杀所有同名
    实例；这是另一个范围过大的风险，不在 PID 复用修复范围内，但应单独审查。
16. **POSIX 未覆盖。** 本文聚焦 Windows；POSIX 的进程组/session 语义不同，没有在
    真实 macOS/Linux 上验证。

## 十二、引用与源码索引

### 12.1 Microsoft Learn

| 主题 | URL |
| --- | --- |
| `PROCESS_INFORMATION` / PID 生命周期 | https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-process_information |
| `taskkill` | https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill |
| Process Security and Access Rights | https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights |
| `OpenProcess` | https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess |
| `GetProcessTimes` | https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes |
| `QueryFullProcessImageNameW` | https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew |
| `TerminateProcess` | https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess |
| `GetExitCodeProcess` | https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getexitcodeprocess |
| `WaitForSingleObject` | https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject |
| Job Objects | https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects |
| `CreateJobObject` | https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createjobobjecta |
| `AssignProcessToJobObject` | https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject |
| `TerminateJobObject` | https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject |
| `UpdateProcThreadAttribute` / `PROC_THREAD_ATTRIBUTE_JOB_LIST` | https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute |
| `ClosePseudoConsole` | https://learn.microsoft.com/en-us/windows/console/closepseudoconsole |
| Creating a Pseudoconsole session | https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session |

### 12.2 上游 issue / 源码

| 主题 | URL / 本地路径 |
| --- | --- |
| node-pty #965（自然退出漏 conhost） | https://github.com/microsoft/node-pty/issues/965 |
| node-pty #967（5 秒裸 PID 回退） | https://github.com/microsoft/node-pty/issues/967 |
| node-pty v1.1.0 `conpty.cc` | https://github.com/microsoft/node-pty/blob/v1.1.0/src/win/conpty.cc |
| node-pty v1.1.0 `windowsPtyAgent.ts`（编译后为本地 `lib/windowsPtyAgent.js`） | https://github.com/microsoft/node-pty/blob/v1.1.0/src/windowsPtyAgent.ts |
| node-pty v1.1.0 `conpty_console_list.cc` | https://github.com/microsoft/node-pty/blob/v1.1.0/src/win/conpty_console_list.cc |
| 本地 node-pty | `node_modules/node-pty/`（1.1.0） |

### 12.3 仓库源码/文档

| 主题 | 位置 |
| --- | --- |
| 终端进程原语 | `server/terminal-process.js:96-174` |
| 会话停止/退出/重试/清理 | `server/terminal.js:295-344, 730-769, 871-889` |
| 后端树杀 | `electron/main.cjs:394-422` |
| Agent 树杀 | `server/agents/cli.js:155-166` |
| Git 树杀 | `lib/git.js:127-132` |
| P2 验收（既有风险） | `docs/terminal-p2-acceptance.md:215-218` |
| 终端安全边界 | `docs/security.md:729-768` |
| P31 Job 范式 | `docs/p31-managed-process.md`、`extensions/pi-gui-process/runner-win.ps1` |
| ADR 0032 PID 复用要求 | `docs/adr/0032-worktree-multisession.md:171` |
| 签名边界 | `docs/code-signing.md:7-17, 48-52` |
| 测试政策 | `docs/testing.md:9-28` |
| 仓库规则 | `AGENTS.md`、`REVIEW.md` |

## 十三、P3-A 边界与后续

### 13.1 本轮没有实现终止改造

**P3-A 没有实现本文的进程终止设计。** 本文是设计/审计，不是修复记录：

- 没有修改 `server/terminal-process.js` 的 `defaultKillPty` / `ptyProcessAlive`；
- 没有修改 `server/terminal.js` 的 `stopSession` / `sweep` / `dispose` 的 kill /
  等待 / 重试语义（P3-A 的 keep-alive 只涉及空闲计时与标志清理）；
- 没有修改 `electron/main.cjs` 的 `killServer`；
- 没有新增依赖、原生模块、Job Object 或 prebuild；
- 没有运行新的终止集成测试，没有实测 PID 复用、`taskkill` 误杀、Job 分配或
  Electron 崩溃清理；
- 没有运行完整 `npm test`；这是纯文档变更，按 `docs/testing.md:19` 的“纯文档 /
  无行为影响”条款说明原因后跳过，且没有重建产物；
- 本文交付只新增本文；`AGENTS.md`、`REVIEW.md`、`docs/security.md` 与生产代码不在
  本文的改动范围内；工作区中的 P3-A keep-alive 修改与其它既有改动属于各自的范围；
- 本文写作时没有提交、推送、合并或发版；P3-A 分支的提交、推送、审查与 PR 由该分支
  的验收流程分别记录，见
  [terminal-p3-keep-alive-acceptance.md](terminal-p3-keep-alive-acceptance.md)。

### 13.2 本轮实际做过什么

- 读取并审计了 `server/terminal-process.js`、`server/terminal.js`、
  `electron/main.cjs`、`server/agents/cli.js`、`lib/git.js`、
  `tests/files-terminal.cjs`、`tests/terminal-source-check.cjs`、
  `tests/terminal-electron-check.cjs`、`docs/terminal-p2-acceptance.md`、
  `docs/security.md`、`docs/code-signing.md`、`docs/testing.md`；
- 读取了 `node_modules/node-pty` 1.1.0 的 `conpty.cc`、`windowsPtyAgent.js`、
  `conpty_console_list.cc`、`conpty_console_list_agent.js`；
- 只读查询了 Microsoft Learn 文档和 node-pty 上游 issue #965/#967（状态 open）；
- 只读查看了 `git status` / 当前分支 / `node-pty` 版本；没有写工作区之外的状态。

### 13.3 建议的后续

1. **P3-B（优先，低风险）— 已实现（2026-11-13）**：身份抓取（PID + 创建时间 +
   映像路径）、停止前校验、`mismatch/gone/unknown` 一律不杀、Windows 不再回退
   `pty.kill()`、有界重试与单飞；补单元/假 PTY/真实 ConPTY 负向测试。结构化日志未落地，
   原因见 6.2.7。验收标准：不匹配身份时零 `taskkill`；无关 sentinel 在所有终止路径后
   仍活；`killUnconfirmed` 不谎报 exit。
2. **P3-C（根因修复）**：给 node-pty 提交 Job-at-creation 补丁或维护固定补丁：
   `CreateJobObject` + `KILL_ON_JOB_CLOSE` + `CREATE_SUSPENDED`/`PROC_THREAD_ATTRIBUTE_JOB_LIST`
   + `AssignProcessToJobObject` + `TerminateJobObject` + exit watcher 关闭 `hpc`；
   暴露 `treeKill: 'job' | 'legacy'`；补应用崩溃/后代逃逸/conhost 测试。
   验收标准：强杀后端后 marker 树被 Job 清理；正常 stop 不再调用裸 PID；conhost
   不再按 #965 泄漏。
3. **P3-D（仅在 P3-C 不可行时）**：评估 N-API 模块/helper；把它作为新原生依赖决策，
   单独说明构建、prebuild、SEA/asar、签名和 CI 影响；不把“持句柄杀根”说成树杀修复。
4. **横向收紧**：把同样的身份门控应用到 `electron/main.cjs` 的后端树杀、
   `server/agents/cli.js` / `lib/git.js` 的 `killTree`；`installer/pi-gui.nsi` 的
   `/IM` 杀法另行审查。
5. **文档同步**：如果 P3-B/P3-C 落地，更新 `docs/security.md` 的终端段、
   `docs/terminal-p2-acceptance.md` 的剩余风险、`docs/architecture.md` 的终端原语
   说明；不要只改本文。

### 13.4 回滚

P3-B 实现没有数据迁移、配置格式变更或用户文件写入。回滚时撤销
`feat/terminal-p3b-identity-kill` 的提交即可恢复旧的 `taskkill` + `pty.kill()` 语义；
已处于 `closing` 的会话在应用退出时按既有生命周期清理。P3-A 的 keep-alive 改动另有
自己的回滚边界，不在本文范围。删除本文档不会回滚已实现的代码。

### 13.5 最终结论

**P3-A 未实现进程终止改造；P3-B（身份门控 + 有界重试）已实现；下一步是 P3-C
（上游 Job Object）。** 在 P3-C 落地前，不能对外声称终端的 Windows 树杀已经消除
PID 复用误杀风险；P3-B 只是把风险从“每个 sweep 都可能命中”收窄到“身份匹配且
检查与系统调用之间没有复用”，TOCTOU 仍然存在。P3-B 的失败关闭还可能让停止停在
`closing` 并继续占额度，这是有意的安全取舍，不是缺陷。
