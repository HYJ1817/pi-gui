# Canonical npm test 实际结果

观察到的命令退出码：0；入口命令链：131 条（含npm子入口）。

实际进程：2026-10-16T22:46:39.1247219+08:00 至 2026-10-16T23:39:55.7408818+08:00，3196.616 秒。取自命令结束时记录的实际退出码及起止时间；日志文件创建时间可能被Windows复用，不用它推算运行时间。

以下保留每个打印的数字签名，不把嵌套或JSON结果再相加成一个虚构总断言数。未编号的reliability/interactions/port-owner通过另列。原始证据为同目录npm-test.log。

| log行 | 原始数字摘要 |
|---:|---|
| 53 | UI-2A Classic 48/48; failed=0; skipped=0; DOM/fixture, not layout evidence |
| 136 | Runtime display projection: 82/82 |
| 208 | UI-2C 视觉自检: 57/57 通过 —— 报告: C:\pi-GUI-ui2-integration\docs\claude-ui-redesign\ui2-integration-evidence\visual-canonical-final\report.json |
| 256 | Theme display: 47/47; failed=0; fixture persistence and IPC; not layout evidence |
| 263 | Fixture retention: 6/6; failed=0; skipped=0; real TEMP filesystem, no Native writer |
| 287 | Object session binding: 23/23; failed=0; skipped=0; layer=deterministic lifecycle DI; no model or writer |
| 327 | EXE diagnostics: 19/19; pure classification, not packaged evidence |
| 346 | Object qualification: 17/17; failed=0; skipped=0 (real read-only Windows observation; synthetic capture and explicit metadata DI; NO production proof) |
| 366 | Object presentation: 25/25; read-only projection and DI authority |
| 419 | Object revert UI: 52/52; failed=0; skipped=0 (DI interaction only) |
| 465 | Object confirmation: 45/45; failed=0; skipped=0; v3 Native confirmation and v2 persisted migration |
| 467 | session-revert-sacl-witness: 0/0; failed=0; skipped=8; real audit environment only |
| 525 | Object profile: 55/55; failed=0; skipped=0; production allowlist empty |
| 538 | Object evidence: 12/12 |
| 590 | Runtime models: 51/51 |
| 666 | Model fallback: 74/74 通过 |
| 702 | Model capabilities: 34/34 通过 |
| 718 | 15/15 passed |
| 774 | 55/55 bridge-state-recovery passed |
| 828 | 53/53 native-provider-quota assertions passed |
| 899 | 26/26 通过 |
| 911 | 10/10 通过 |
| 1018 | 105/105 通过 |
| 1056 | 36/36 通过 |
| 1070 | P30 IA 12/12 passed |
| 2442 | 1338/1338 通过 |
| 2481 | 31/31 通过 |
| 2674 | 161/161 通过 |
| 2807 | 117/117 通过 |
| 2856 | 37/37 通过 |
| 3006 | 115/115 通过 |
| 3286 | 52/52 通过 |
| 3389 | 75/75 通过 |
| 3445 | 38/38 通过 |
| 3513 | 66/66 通过 |
| 3656 | 141/141 通过 |
| 3894 | 236/236 通过 |
| 4138 | 215/215 通过 |
| 4220 | 80/80 通过 |
| 5483 | 72/72 通过 |
| 5562 | 57/57 通过 |
| 5642 | 62/62 通过 |
| 5837 | 173/173 通过 |
| 5997 | 136/136 通过 |
| 6233 | 202/202 通过（Pi 契约基线 1.0.0） |
| 6478 | 229/229 通过 |
| 6487 | 5/5 通过 |
| 6519 | 30/30 通过 |
| 6574 | 50/50 通过 |
| 6612 | 36/36 通过 |
| 6729 | 87/87 通过 |
| 6777 | 34/34 通过 |
| 6876 | 73/73 通过 |
| 7001 | 123/123 通过 |
| 7002 | 21/21 gui browser policy checks passed |
| 7025 | 22/22 gui browser controller checks passed |
| 7026 | gui-browser-bridge: 25/25 assertions passed |
| 7027 | gui-browser-tools: 31/31 assertions passed |
| 7051 | 22/22 passed |
| 7052 | gui-browser-host: 18/18 passed |
| 7065 | gui-browser-stop: 12/12 cases passed |
| 7082 | stop-barrier: 16/16 cases passed |
| 7083 | Managed processes: 28/28 |
| 7084 | Process tools: 25/25 |
| 7085 | Process Stop: 10/10 |
| 7086 | Process UI: 17/17 |
| 7087 | Process runner protocol Windows/POSIX: 24/24 |
| 7158 | Worktree lifecycle: 56/56 passed (win32, real Git fixtures) |
| 7173 | Worktree HTTP: 14/14 passed |
| 7190 | Worktree UI: 16/16 passed |
| 7223 | Runtime registry: 32/32 |
| 7236 | Runtime HTTP: 12/12 |
| 7237 | Runtime conversation store: 25/25 |
| 7254 | Runtime UI: 16/16 |
| 7293 | Runtime nav: 38/38 |
| 7342 | Runtime conversation: 48/48 |
| 7403 | Runtime changes scope: 60/60 |
| 7421 | Runtime secondary: 17/17 |
| 7428 | Runtime Git UI: 6/6 |
| 7475 | 45/45 runtime-resources assertions passed |
| 7492 | Runtime resource cleanup: 16/16 |
| 7528 | Runtime history/search: 35/35 |
| 7556 | Runtime finishing UI: 27/27 |
| 7562 | Session runtime: 5/5 |
| 7563 | Pi supervisor real win32 RPC/tree: 24/24 |
| 7564 | Runtime Browser scope HTTP/IPC isolation: 48/48 |
| 7565 | Global Process budget: 4/4 |
| 7566 | Runtime SSE resource budgets: 14/14 |
| 7576 | Runtime Process real win32: 10/10 |
| 7600 | Object assets: 23/23; failed=0; skipped=0 |
| 7613 | Object runtime authority: 12/12; failed=0; skipped=0; real TEMP root; labeled Registry DI |
| 7625 | Object history: 11/11; failed=0; skipped=0 |
| 7652 | Session revert object runtime: 26/26; layer=real Registry/Worktrees + fakePi guardian; real-model=unverified |
| 7691 | Object store: 38/38; failed=0; skipped=0 (real TEMP filesystem; injected privacy/allocation) |
| 7723 | Object service: 30/30; failed=0; skipped=0; Native normal/recovery path + filesystem + labeled fault injection |
| 7775 | Object recovery reader: 51/51; failed=0; skipped=0; filesystem fixtures; Native writer not invoked |
| 7813 | session-change-store: 36/36 |
| 7849 | Session change bridge: 35/35 |
| 7881 | session-change-tools: 31/31 |
| 7949 | session-revert: 67/67 scenarios passed |
| 7964 | session-revert-store: 14/14 |
| 8030 | Session revert HTTP: 65/65 |
| 8050 | Session revert worker/integration: 19/19 |
| 8074 | session-revert-writer: 22/22 |
| 8100 | session-revert-recovery: 24/24 |
| 8116 | Session revert admission: 15/15 |
| 8146 | Session revert apply: 29/29; fixture metadata, real temporary filesystem; NOT native metadata qualification |
| 8160 | session-revert-windows-faults: 13/13; failed=0; skipped=0 |
| 8202 | session-revert-inplace: 28/28; failed=0; skipped=2; research only; no production eligibility |
| 8259 | session-revert-inplace-safety: 43/43; failed=0; skipped=0; research only; no production eligibility |
| 8294 | Session change query: 34/34; failed=0; skipped=0 |
| 8322 | Session change UI: 27/27; failed=0; skipped=0 |
| 8334 | Session change startup server.js: 11/11; failed=0; skipped=0 |
| 8370 | Object writer: 19/19; failed=0; skipped=0; isolated only |
| 8436 | Object faults: 45/45; failed=0; skipped=0; no production durable state machine |
| 8442 | Object witness: 0/0; failed=0; skipped=8 |

## JSON结果（避免与上表重复计数）

```json
[
  {
    "line": 307,
    "passed": 19,
    "failed": 0,
    "skipped": 0,
    "layer": "offline-contract",
    "tool": null
  },
  {
    "line": 466,
    "passed": 0,
    "failed": 0,
    "skipped": 8,
    "layer": null,
    "tool": "p33-4b-sacl-witness"
  },
  {
    "line": 8441,
    "passed": 0,
    "failed": 0,
    "skipped": 8,
    "layer": null,
    "tool": "p33-d2-object-witness"
  }
]
```

## 明确跳过

- log:467 session-revert-sacl-witness: 0/0; failed=0; skipped=8; real audit environment only
- log:5424   --   跳过：本机建不了符号链接（需要权限或开发者模式），5i 未验
- log:8168 SKIP protected nonempty SACL preservation SeSecurityPrivilege unavailable; not empty SACL
- log:8171 SKIP inherited nonempty SACL preservation SeSecurityPrivilege unavailable; not empty SACL
- log:8202 session-revert-inplace: 28/28; failed=0; skipped=2; research only; no production eligibility
- log:8442 Object witness: 0/0; failed=0; skipped=8

## 未打印断言数量的通过入口

- reliability: passed
- interactions: passed
- port-owner: passed

## 失败标记

匹配FAIL/not ok/AssertionError起始行：0。实际退出码才是整条命令结果；负向fixture中的“失败”文字不自动判为失败。
