# P25.2 implementation plan

Baseline: main a5213f4685417f9c73b83a247bd98af16827443b, version 0.18.2.
The user's detailed A–H requirements are the approved design. No version bump,
tag, release, unrelated features, or user-data writes.

1. Establish baseline (`npm test`: exit 0, 326.7 seconds).
2. Bridge: maintain one lifecycle snapshot before publication; expose it through
   status and a current SSE snapshot after bounded historical replay. Separate
   transport from lifecycle and reconcile all lifecycle sources idempotently.
   Use finite recovery probes and the existing confirmed restart action.
3. Native quota: reuse ModelRuntime provider identity and private Auth worker;
   execute native requests inside the secret boundary with existing parsers.
   Preserve custom adapters, distinguish unsupported/auth/network errors, and
   label OpenRouter results as Key limits. No speculative SiliconFlow adapter.
4. Sessions: sort backend metadata by creation timestamp, strict filename
   timestamp, then deterministic identity. Preserve search's independent order
   and pending-to-persisted identity.
5. Add fixture regressions `bridge-state-recovery`, `native-provider-quota`, and
   `stable-session-order` to the single npm test entrypoint. Check stale runs,
   duplicate snapshots, private numeric RPC replies, worker secret isolation,
   and creation order despite current/mtime changes.
6. Run npm test, UI tests, rebuilt Electron/SEA artifacts, app and EXE gates.
   Capture real browser evidence for recovery and stable lists. Record any
   environmental failures without dropping assertions or relaxing thresholds.
7. Review the integrated diff and report HEADs, counts, limitations, and status.

Ownership: parent handles Bridge/composition/test registration/docs; isolated
parallel agents handle quota and sessions. They do not commit or run the full
matrix concurrently. Existing abstractions remain authoritative; no Renderer
localStorage state is added.
