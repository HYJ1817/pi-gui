# UI-2 integration: CDP expectations reconciliation

Scope: only `tests/cdp-shot.cjs` and evidence in this directory. No product, package, dependency, original A/B/C workspace, commit, push or merge changes by this task. Real Chrome against independent offline visual fixtures; no real Pi/model or user session writes. The integration product code was also being verified/repaired by the parent task, so this is evidence for the integrated working tree, not an attribution claim for every screenshot difference.

**Final result: 1761/1761, failures 0, renderer exceptions 0, process exit 0.** Original reported 1750/1761, failures 11, exit 1; its four additional hidden false passes are disclosed below. Both completed runs produced **270 screenshots**, **263 shotOf invocations + 57 UX invocations**. Source footprint is unchanged: **194 shotOf callsites + 14 uxCheck callsites**. No assertion or scenario was removed. Exact structured results: `cdp-results.json`.

## Why these expectations were obsolete

- UI-1 acceptance §3 (`UI-1-acceptance.md:45-46`) explicitly specifies dark titlebar `#111111`, light `#fbfbf9`. `git show 61fddf4:public/tokens.css` and current `public/tokens.css:10,72,108` confirm the values and legacy alias. `electron/theme.cjs:6-9,29-30` independently defines the same native overlay palette. UI-0's old overlay `#0d0d0d` in the design contract describes the defect/baseline before UI-1, not the accepted final palette.
- `git show 61fddf4:public/projects.js` already contains the same worktree action as current `public/projects.js:260-267`: active-project menu order is **工作区管理 → 项目设置 → separator → 移除项目**. `public/ui/action-menu.js` creates `role=menu`, `role=menuitem` and `role=separator`. This is a pre-existing P32 capability, not a UI-2C-added menu item.
- Consequently, update the one menu predicate to exact ordered labels of all three menuitems (stronger than count alone), and the shared titlebar predicate to strict fixed hex **and** computed RGB per resolved `data-theme`. Unknown themes fail. Existing top/height/width/pane edge/separator/overflow/drag checks are unchanged.

## The 11 original failed claims, individually

| Original failed claim | Verified reason | Final expectation |
|---|---|---|
| UX-MENU-02-project-menu-open | Two-item assumption omits existing 工作区管理 | role=menu and exactly three ordered named menuitems |
| UX-08 switch 任务 | #0d0d0d predates UI-1 | strict accepted theme palette |
| UX-08 switch 文件变更 | same UI-1 palette change | strict accepted theme palette |
| UX-08 switch 扩展 | same UI-1 palette change | strict accepted theme palette |
| UX-08 switch 对话 | same UI-1 palette change | strict accepted theme palette |
| UX-08 long-thread scroll | same UI-1 palette change | strict accepted theme palette |
| UX-08 command palette open/close | same UI-1 palette change | strict accepted theme palette |
| UX-09 700×600 | same UI-1 palette change | strict accepted theme palette; geometry unchanged |
| UX-09 900×700 | same UI-1 palette change | strict accepted theme palette; geometry unchanged |
| UX-09 1200×800 | same UI-1 palette change | strict accepted theme palette; geometry unchanged |
| UX-09 1536×900 | same UI-1 palette change | strict accepted theme palette; geometry unchanged |

## False-pass guard and assertion accounting

The original `shotOf` treated a non-empty failure-reason string as truthy success (`if (!v)`). This masked the same titlebar error in screenshot predicates while UX's separate `ok === true` path correctly reported the ten failures. Parent explicitly authorized repairing this infrastructure defect. `shotOf` now requires `v === true`; predicates and their failure-reason strings remain intact. This tightens checking and can expose failures; it cannot excuse failures. No assertion/callsite was deleted.

Reporting-only counters count each element-exists check, viewport-center check, mandatory keyword, structural predicate and explicit UX check. The evidence runner `cdp/count-original.cjs` reads the original `50d20dd` test through Git and injects only these counters in memory; it retains the original predicates and original truthy guard. This provides the same denominator before and after without editing the original test file. The counter describes these explicit fixture checks, not a sum of unrelated test suites. `125-workspace-session-switch-to-chat` is a separate conditional failure guard, unchanged and not included in the counter.

## Four additional obsolete predicates exposed by strict return checking

These are **additional to the original eleven**, not silently folded into them. The first strict full run (`cdp-final.log`) completed **1757/1761**, failed **4**, exit **1**, renderer exceptions **0**. It correctly rejected failures previously hidden by non-empty error strings:

| Predicate | Evidence for current specification | Strict replacement |
|---|---|---|
| 174-capability-builtin: enable/load show 不适用 | UI-1 Git object and current `public/capability-model.js:466-489` omit NA fields; `public/ui/capability-setup.js:231-241` creates one state row and a separate source section; same-file later UX-CAP-01 already requires only applicable fields | exact state-row/value matrix `[['安装状态','已安装']]`, no 不适用, plus independent 来源 heading with nonempty note; extra enable/load rows fail |
| UX-01-scrollbars-palette: thumb fixed rgb(44,44,44) | UI-1 `public/tokens.css:36,132` specifies dark #55534e / light #b4b1a9, confirmed in `git show 61fddf4:public/tokens.css`; UI-1 acceptance §2/§4 already records the canonical dev-server scrollbar migration | exact theme-specific RGB and root --ui-scrollbar hex; unknown theme fails |
| UX-02-scrollbars-diagnostics: body thumb | same UI-1 palette proof | same strict palette; width/height 10px and transparent-track guards unchanged |
| UX-02-scrollbars-diagnostics: modalCard thumb | same UI-1 palette proof | same strict palette; scope/scrollability/geometry guards unchanged |

Parent explicitly authorized these narrowly scoped test corrections after evidence review. No product behavior or field visibility was changed. Note the actual DOM is **one state row plus a separate source section**, not two state rows.

## Evidence and limits

`cdp-before.log` / `cdp-before-exit.json`: unmodified original full run, failure **11**, exit **1**, renderer exceptions **0**. `cdp-after.log` is the intermediate expectation-only run. `cdp-strict.log` is an interrupted intermediate run; it is not counted as completed acceptance. Final strict and original counted runs are recorded separately.

`cdp/palette-menu-results.json`: **26/26**, failure **0**, real Chrome. Both dark and light execute the exact final titlebar, scrollbar and built-in expressions extracted from the test. They check ordered menu labels, menu role and exactly one separator. Negative controls reject wrong titlebar background/Token, old rgb(44,44,44) scrollbar with otherwise correct root Token, wrong scrollbar Token, invented enable/load state rows and missing source. The extra seven checks per theme cover scrollbar pass + two negatives, built-in pass + three negatives. Screenshots `cdp/dark-titlebar-project-menu.png`, `cdp/light-titlebar-project-menu.png` and `cdp/light-builtin-fields.png` were actually inspected. These browser captures prove webpage styling; native caption pixels and real OS theme behavior belong to the existing Electron acceptance, not this fixture.

All fixture/Chrome ports are independently allocated for these runs (18793–18798 / 19237–19243); no fixed repository default port or real running user service was used. No network install or web lookup occurred. `node --check tests/cdp-shot.cjs` and scoped `git diff --check` pass. The final strict full-run result and assertion/screenshot totals are in `cdp-verified.log`, `cdp-verified-exit.json` and `cdp-results.json`. The old original runs' reported passes include four known false passes; only the final strict run is acceptance evidence. Selected final screenshots retained under `cdp/verified-*` cover exact builtin fields, project menu, palette/diagnostics scrollbar scopes, titlebar Chat and 700×600 titlebar. The full generated 270-image sets remain in `.shots/ui2-before-count-*` and `.shots/ui2-verified-*`. Fixture services were stopped after completion.
