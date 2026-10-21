# T2-B independent functional and security review

Conclusion: needs correction. Confirmed introduced findings: Blocker 0 / Important 1. Read-only review; all fixture writes are under this temporary directory.

Base: origin/main 7db69cdc24debc28dfb7f9c91cdfcfa65b0df849. Reviewed all 14 modified tracked files and 3 untracked files present in REVIEW-scope.json. Files were read as fixed copies. Three documentation files added during review were incorporated after reading their added diff; reviewed implementation files were unchanged at the scope check. No unreviewed files were present at that check.

## Important I1: interrupted width drag permanently occludes Browser

Introduced location: public/right-pane.js:297, now treating rp-resizing as a native occlusion condition. The existing width resizer at lines 212-240 only clears the class and mouse handlers on document mouseup. It has no window blur/cancel cleanup, unlike split-workbench.js endDrag. When a drag loses focus and its release does not reach document, subsequent focus/measure/reopening keeps native Browser detached.

Reproduction on the fixed product modules: open Browser, give its viewport a positive rectangle, dispatch rightPaneResizer mousedown, dispatch window blur and focus without document mouseup, refresh the pane. The fixture logs resizing=true, occluded=true. A later document mouseup logs resizing=false, occluded=false. Running the same sequence with origin/main right-pane.js gives resizing=true, occluded=false. The stale drag flag predates this diff; the permanent native-view disappearance is introduced by this diff. Electron browser-view.cjs:196 and setOccluded at line 493 detach for this flag.

Evidence scripts: tests/REVIEW-drag-repro.cjs and tests/REVIEW-drag-baseline.cjs. These are state-machine reproductions with jsdom and injected geometry, not real Electron pointer/capture evidence. Suggested correction: one bounded width-drag cleanup path called by mouseup, window blur and pane closure; remove temporary handlers/class and schedule fresh bounds before reveal.

## Contract gap, not counted as an introduced defect

New runtime Browser fallback modebar close goes through split-workbench.js:132 -> secondary-surface.js instance.close -> pane.close -> runtime-secondary.js:91 detach. It sends no runtime command(close). With an opened A Browser, the temporary fixture observes surface=null, nativeStillOpen=true, agentEnabled=true, closeCommands=0. Browser toolbar close instead observes nativeStillOpen=false, agentEnabled=false, closeCommands=1. The fixture uses the real browser-agent permission lifecycle with a fake native boundary matching browser-runtime-host command handling.

The new docs/work-surfaces.md:14 explicitly preserves runtime hide semantics, while docs/T2-B-plan.md:19 states that a closed native Browser is destroyed; agent-browser.md also describes close revocation. These are conflicting contracts. This review does not label documented background ownership/retained permission as an authorization bypass. Establish the intended meaning of workbench close in the final acceptance check. Evidence: tests/REVIEW-close-permission-repro.cjs.

## Verification

All commands used the fixed snapshot as cwd and this read-only dependency location:

```powershell
$env:NODE_PATH='C:\Users\21022\.codex\worktrees\t2-b-browser-workbench\pi-GUI\node_modules'
node tests/browser-viewport-safety.cjs
node tests/browser-workbench-ui.cjs
node tests/runtime-secondary.cjs
node tests/gui-browser-ui.cjs
node tests/split-workbench-ui.cjs
node tests/REVIEW-drag-repro.cjs
node tests/REVIEW-drag-baseline.cjs
node tests/REVIEW-close-permission-repro.cjs
```

Existing/added focused suites: 36/36, 13/13, 24/24, 24/24, 30/30 respectively (127/127; no skipped checks). The reproduction scripts rerun their host UI fixtures and print the additional observations; those reruns are not counted again in 127.

Inspected native view ownership, CSS-to-DIP conversion, invalid/clamped bounds, attachment ordering, occlusion/reveal ordering, scoped runtime commands and late state/status delivery, same-surface layout transitions, disposers, navigation policy and session partitions. No further evidenced introduced Blocker/Important identified. This is not native-rendering or packaged-app acceptance.

Not run: broad npm test, runtime-browser HTTP fixture, Electron live/session harness, builds or packaged validation. No network, model/agent launch, git fetch, real-data mutation, or source edit was performed. tests/browser-workbench-electron.cjs was absent from the fixed scope; its in-progress implementation and real native screenshots remain unreviewed.

## Digests

Raw git diff --no-ext-diff --binary origin/main SHA-256:
216867087816597b62bd1433e5bace8c3a477f9a8bb1857a7d3bcd735ba8e319

Complete scope SHA-256 (raw diff followed by sorted untracked records, each NUL + untracked: + path + NUL + file bytes):
b687eae55f0745b0410e86cd6d042bd7d913c4210e0bf9db2145e25d849865fb

REVIEW-final.diff contains the raw diff. REVIEW-scope.json records every reviewed changed file hash and the 3 untracked files. Later author edits are outside this conclusion. Reversal of the eventual isolated T2-B implementation commit is the rollback boundary; this review made no implementation changes to roll back.
