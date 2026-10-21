# T2-B implementation plan

Baseline: origin/main 7db69cd; T2-A is already merged. No push, merge or release.

1. Extend the existing split container with a Browser top-panel adapter. Keep the
   Specs default, ratio storage, keyboard controls and responsive thresholds.
2. Reparent the existing Browser chrome on single/split transitions without
   replacing its native controller. Keep classic and runtime ownership separate.
3. Keep right-pane as the only viewport/occlusion measurement owner, observe the
   actual viewport, and detach during fallback, overlays and pointer resizing.
4. Convert renderer CSS bounds to native DIP in the main-process host, clamp on
   every update and refuse invalid geometry before native attachment.
5. Add failing UI and host safety regressions, verify focused suites and actual
   Electron WebContentsView interaction/screenshots, then run canonical npm test.
6. Rebuild isolated artifacts, independently review the full diff and safety
   boundaries, document exact outcomes and remaining gaps before local commits.

No new dependencies, navigation policy, Browser agent API, Pi protocol or user
project writes. The Browser toolbar close destroys the native page and revokes
Agent Control. Existing Runtime right-pane collapse/Escape instead detaches the
owner's page and releases UI subscriptions; session close disposes that owner.
Single/split layout moves and fallback tabs preserve the current native page.
