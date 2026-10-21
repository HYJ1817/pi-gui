# T2-B final narrow independent review

Conclusion: PASS for this narrow review. No evidenced introduced Blocker or Important remains in the reviewed scope. This is not a full-suite, sandbox, packaged-app, merge or release approval.

Findings: Blocker 0 / Important 0. Previous I1 (width-drag blur occlusion): verified fixed in the preceding narrow review; no subsequent production delta was found. The runtime container-collapse versus actual native-Browser-close distinction is resolved by the author's explicit requirement clarification and updated plan; it is not an outstanding security finding.

## Scope and fixed versions

Base: origin/main 7db69cdc24debc28dfb7f9c91cdfcfa65b0df849.

Read the new tests/browser-workbench-electron.cjs in full, the complete tests/browser-viewport-safety.cjs, related runtime-browser safety assertions, product bridge/controller boundaries, and incremental documentation. Rechecked AGENTS.md and REVIEW.md. Compared current public/, electron/, server/, and lib/ files against the previous fixed review snapshots, using the verified width-fix snapshot for public/. No production-code changes since that checkpoint were found. The public Browser open/openSplit APIs still synchronously return booleans; asynchronous native readiness is awaited separately by the harness. The incremental plan change accurately specifies toolbar close/destroy/revoke, runtime collapse/Escape detach, session dispose, and layout preservation.

The temporary whole-window capture helper and its opt-in call were removed by the author and are excluded from final scope. Final Electron harness bytes match the original pre-helper version captured at the start of this review (SHA-256 below). The one independent live execution occurred while the transient screenshot-only opt-in was present; the same 61 functional assertions and underlying product code were unchanged. No second independent Electron execution was run after its removal. The author's subsequent final-version 61/61 is author-reported, not counted as another independent run.

## Independent verification

One real fixture execution: node tests/browser-workbench-electron.cjs, exit 0, Electron 44.4.3, 61/61 checks. Its command-local environment was TEMP and TMP = C:\pi-GUI\.probe\t2b-electron-temp, T2B_TEST_NO_SANDBOX=1, T2B_EVIDENCE_DIR=C:\pi-GUI\.probe\t2b-independent-electron. The transient screenshot opt-in was also enabled for that execution; its whole-window images are excluded as unusable evidence.

Native controller safety: node tests/browser-viewport-safety.cjs, exit 0, 36/36, zero failures/skips, reported duration 33.9471 ms. Covers unattached open until geometry, CSS-to-DIP exactly once at 1/1.25/0.8 zoom, current zoom on resync, NaN/Infinity/negative/zero geometry, window clamp, offscreen and zero content area, fresh bounds after occlusion, background visibility, IPC geometry paths, 20 close/reopen cycles, and retained navigation/session/lifecycle restrictions. Only Electron's native boundary is mocked in this suite; product controller/policy execute unchanged.

No full npm test was started or interrupted. The parent's canonical run remains a separate gate. No build, packaged validation, external website, Pi, model or agent process was launched. Local HTTP fixtures/private Browser bridges and Git writes stayed within the explicitly authorized fixture; evidence writes stayed within the authorized evidence directory and this review's os.tmpdir directory. No product/test source edits were made by this reviewer.

## Assertion quality and actual proof

- Native geometry is checked using actual child-view getBounds against the real renderer viewport times GUI zoom, with a one-DIP tolerance (harness lines 89-93). Constant-true check labels follow successful until predicates for geometry/detach; those labels are not unconditional substitutes for observation.
- Pointer drag uses actual webContents.sendInputEvent; native attachment is checked while dragging, after geometry changes, and during repeated drags. Keyboard changes the real view's height and stores a finite ratio. These are meaningful interaction/state checks, beyond DOM text assertions.
- Single-to-split checks native webContents identity and retained native-page form input. Fallback and modal checks inspect real contentView attachment. Zoom uses actual GUI zoom factor. Layout cycling checks one attached view and retained identity; reopening/closing checks one child per opening and zero children/controller webContents after closing.
- Real Agent snapshot and fill use the actual Browser Agent/CDP controller on the local native page. Disable is checked with agent_control_disabled. The session bridge is real, but the tested fill/disable call the host controller directly; this is not an end-to-end Pi/Extension tool call or an Agent-permission toolbar-click test.
- A/B/A focus uses real scoped controllers, distinct nondefault sessions, real temporary Git worktree marker files served through the local page fixture, and verifies that only the focused owner's native view is attached. This is concrete Browser ownership evidence.

## Bounded evidence gaps, not new blocker findings

1. Whole-window composition is unverified. The author reports WGC E_ACCESSDENIED; that failure was not independently rerun. The review inspected separate actual renderer and native-page captures for the 1200px split. The renderer omits native content; the native-page image contains the expected local page and filled form. No composite image was created or relied on. The discarded whole-window images from the exploratory opt-in are not evidence of a rendered full window.
2. Sandbox behavior is unqualified because this fixture runs with --no-sandbox. The final harness makes this explicit in results.json. This is a fixture launch option; production sandbox settings are unchanged. The reported normal-startup 0x80000003 diagnosis was not independently rerun here.
3. The renderer fixture replaces app.js with a small module importing production modules, CSS and preload. It does not execute the entire application composition or real backend registry/API. Git status is a scoped HTTP adapter returning a label based on the conversation header (line 69); Git diff runs the real temporary A repository (line 70). Accordingly the A/B Changes checks establish frontend scope routing, not real backend A/B Git isolation. The earlier scope reviews/tests remain separate evidence.
4. Runtime A/B/A navigates the selected controller before each check (line 184). It proves focused-owner attachment and session separation, not retained A form/history on returning from B or handling of deliberately injected late events. Runtime native geometry is not independently compared with the runtime viewport in this harness; the controller safety suite and prior scoped tests cover complementary boundaries.
5. The keyboard assertion (line 153) checks changed native height and a finite stored ratio, not numerical cross-surface ratio equality. The one-view close-cycle checks do not enumerate all Electron webContents for orphan detection. These are limits on the claims, not evidence of an implementation failure.
6. The author-reported legacy live Agent-click failure on origin/main was not rerun or independently classified here; it is outside the new workbench/production incremental scope and is not a finding in this review.

## Evidence and digests

Independent run evidence: C:\pi-GUI\.probe\t2b-independent-electron\results.json.
Selected reviewed images: 02-browser-changes-1200.png and 02-browser-changes-1200-native-page.png in that directory. Distinct A/B images are also present. The third A visit reuses the same screenshot filename, so first-A and return-A images are not separately retained; both state assertions did execute.

Raw git diff --no-ext-diff --binary origin/main SHA-256:
f71e149743931cd82c6d6ffea30ea8ffc84f20795d9e5e448719f3f28231f966

Final new Electron harness SHA-256:
493ab0ee34fe75e3a6f5a2264fdfd075637cd5535c3dcddf2b57666d7c9166ac

Final code-scope digest (raw tracked diff plus NUL-delimited untracked path/bytes records in order: docs/T2-B-plan.md, tests/browser-viewport-safety.cjs, tests/browser-workbench-electron.cjs, tests/browser-workbench-ui.cjs):
c5b0f6d6e1fb9fbe9b51c5e86dcbbd4d99210290046edef5435820d69d31b773

Per-file hashes are in final-scope.json; the raw tracked diff is reviewed-git.diff. Later source edits invalidate this review's version boundary. No rollback action was performed; this review is read-only apart from authorized fixture/evidence writes. Final acceptance remains conditional on the parent's canonical result and the explicitly disclosed visual/sandbox limitations, without implying any merge or release authorization.
