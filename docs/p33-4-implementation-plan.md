# P33.4 Implementation Plan

**Goal:** Deliver confirmed limited Windows NTFS revert with durable preimage backup, bounded replacement, auditable recovery and no automatic writes to user projects during testing.

**Architecture:** Reuse P32 authority and P33.2 private content-addressed objects/journal. Close a physical-workspace mutation admission gate before Stop/drain, release lifecycle authority before waiting for Stop, then reacquire it for plan/apply checks. Old evidence lacks metadata and remains preview-only. No strict provider is invented. No commits/push/P33.5 UI.

**Tech Stack:** Existing Node builtins, Windows native PowerShell/.NET metadata primitives; no dependencies/network.

1. [x] Establish baseline and audit existing interfaces. Read accepted design, actual store/bridge/algorithm/Stop/worktrees. Record discrepancies, initial HEAD, scope in acceptance report.
2. [ ] Metadata + writer: add server/session-revert-metadata.js and server/session-revert-writer.js; exact before/post metadata, local NTFS only; ordinary file bytes/parent/type/ACL/ADS checks; same-directory wx candidate/fsync/readback; no truncate/unlink fallback. Fresh absent file reversal is same-volume private recovery move. tests/session-revert-writer.cjs first, real temporary NTFS and independent-process races. Preserve residual race warning.
3. [ ] Store: extend server/session-change-store.js with backward compatible before/post metadata, private backup object references, chained apply journal, durable state transitions/consume operations, restart reconciliation, pin-aware bounded GC. tests/session-revert-recovery.cjs first; faults and partial states fail closed.
4. [x] Admission + capture: add workspace physical-root mutation gate with fail-fast admission, drain timeout/finally; default tool bracket release through settle/outcome; Stop before lifecycle lock; prompt/steer/follow_up and Git restore checks, managed resources and lifecycle invalidation. tests for deadlock and isolated roots. Reuse registry, no second session registry.
5. [x] Service/routes: add session-revert-service.js using existing compute; prepare recomputes entire explicit subset and persists C/R before token. 60s one-use token binds scope/revision/files/C/R/backup/mode/risk version. apply one-use requestId idempotency with journal; per-file failures stop remainder; no unconditional rollback. cancel, recover-preview, independent recovery prepare/confirmation, authorized export to private generated filename. tests/session-revert-apply.cjs first.
6. [ ] Real Pi temporary-project default tool→metadata+BAP→preview→prepare→confirmation→R→independent recovery C; classic + managed worktree; index/ref unchanged. Expand opt-in live/RPC tests, production ACL, restart, independent-process race and packaged backend. Test fixture model must use real tool dispatcher.
7. [x] Regression + build: add tests to npm test, full run, resolve regressions without removing assertions; rebuild app, packaged backend calls; explicit passed/failed/skipped counts.
8. [x] Review and docs/p33-4-acceptance.md with source positions, B/A/P/C/R byte proofs, tested platform boundaries, crash vs power-loss and residual races. Stop awaiting acceptance.

Each module follows failing tests → implementation → verification. Delegated modules have separate owned files; root reviews spec and code before integration. User-approved P33.4 specification is the design authority; no additional design approval or git commit is inferred from skill defaults.

Status 2026-10-09: Items 2/3/6 remain incomplete acceptance gates. Native SACL inspection refuses metadata_audit_unavailable on this token; no production native restore or packaged restore proof. GC retains all durable references and needs complete moved-object capacity accounting. See docs/p33-4-acceptance.md for actual verification and open fault-injection cases.
