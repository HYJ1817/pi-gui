# Source Electron native capture investigation — 2026-11-01

Base: `8908ff5`, Windows x64, Electron 44.4.3, Electron's Node 24.21.0. These are source Electron tests with the production server, renderer, preload, Browser controller and fake Pi. All project/userData/session writes use the parent's TEMP fixture. No model calls, external network, dependency installation, external CDP port or sandbox override. No product file changed for this investigation.

## Findings

The two historical `production-native` / `production-native-retry` runs failed at native `capturePage` with `UnknownVizError`. They remain failed. Their exact root cause is **unknown**: this investigation did not reproduce that exception. An unchanged rerun succeeding cannot explain it.

A separate, proven smoke defect was found. Navigation title/loading readiness was checked before native capture, while attachment and positive matching geometry were checked only afterwards. Delaying the renderer's bounds IPC by 1500 ms made the original smoke capture an unattached native page: `attached:false`, `bounds:null`, `loading:false`; Electron returned an empty 0×0 image and the smoke still passed 10/10 with a zero-byte `smoke-native.png`. See `delayed-bounds-red-20261101-01/capture-probe.json`, `results.json`, and the zero-byte file. Despite that historical directory's name, this initial probe **exited 0**, demonstrating a false positive.

Adding a nonempty image assertion first made the same controlled condition fail after the three preliminary checks (`empty-image-red-20261101-01`, exit 1). The correction then moved the existing attachment/geometry readiness condition before capture and reused its predicate for both width checks. Capture exceptions still fail; empty images now fail. No retry, skip, fabricated pixels or sandbox change was added. Structured `nativeCaptures` evidence retains attachment, bounds, loading, dimensions, byte length and a bounded capture failure classification.

## Runs

| Evidence directory | Change/condition | Result |
| --- | --- | --- |
| `baseline-20261101-01` | Unchanged entry | 10/10; normal sandbox; 11 process identities observed, 0 residual |
| `delayed-bounds-red-20261101-01` | Original capture order + 1500 ms bounds delay + observation only | False-positive 10/10; empty 0×0 native image; 9 observed, 0 residual |
| `empty-image-red-20261101-01` | Nonempty assertion added, old capture order + same delay | Exit 1 after 3 passing preliminary checks; nonempty assertion failed; no native screenshot accepted |
| `delayed-bounds-green-20261101-01` | Readiness correction + same delay | 11/11; 9 observed, 0 residual |
| `final-20261101-01` | Final shared predicate, normal entry, no injected delay | 11/11; 11 observed, 0 residual; native PNG 587×963, 9,103 bytes |
| `final-delayed-bounds-20261101-01` | Same final code + 1500 ms bounds delay | 11/11; 9 observed, 0 residual; native PNG 587×963, 9,103 bytes |

11/11 consists of 10 fixture checks plus the parent's process cleanup check; the old 10/10 consisted of 9 plus 1. No assertions were removed. All final runs report `skipped:0`, `errors:[]`, and exit 0. Each final run retains four images: the actual native capture separately from parent 1200px, 760px and modal captures. The native image was visually inspected and contains the loopback fixture heading/input. Parent pixels were never combined with native pixels.

## Reproduction

Run in PowerShell from the checkout, using a fresh evidence directory each time:

```powershell
$env:G2_SMOKE_OUTPUT = '<absolute fresh output directory>'
npm run test:electron-smoke
```

For the controlled delayed-bounds regression only:

```powershell
$env:G2_SMOKE_NATIVE_PROBE = '1'
$env:G2_SMOKE_OUTPUT = '<absolute fresh output directory>'
npm run test:electron-smoke
Remove-Item Env:G2_SMOKE_NATIVE_PROBE
```

The explicit probe selects `tests/fixtures/g2-native-capture-probe.cjs`; it wraps only the test Electron process's bounds handler and captures metadata. It reuses the existing parent TEMP/environment/process-cleanup contract. The final report labels this fault injection. The normal entry does not apply the delay.

## Scope and remaining risk

This closes the empty native screenshot false-positive and supplies fresh source normal-sandbox evidence. It does **not** claim a root-cause fix for historical `UnknownVizError`, packaged GUI qualification, real Pi/model E2E, or a full canonical `npm test` result. The old failed runs stay separate from the fresh passing runs. Native GPU/compositor failure remains a residual risk; any future capture exception remains a hard failure with metadata. `git diff --check` passed for this change.

Changed-file SHA-256 at final verification:

```text
tests/electron-smoke.cjs                      B82AD5C48370BAC6D899B9DBE7AA7D332FACC2B9100844899787236C325EAFD8
tests/fixtures/g2-electron-smoke.cjs          F4E97FC99B9A225983F6DE6BEF427756E59AEC20DA544D717FABDC4056EAA343
tests/fixtures/g2-native-capture-probe.cjs    ED71D85133180226F993034098722446ACC135BD17335561AF6A023191B91901
```
