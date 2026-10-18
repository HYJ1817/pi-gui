# UI-5 Main Integration Evidence

All commands ran against merge commit `54549876a9212c61f38adaf04a63499df67f282a`
with an isolated TEMP and user-data fixture. Raw logs are retained verbatim so the
original failures and retries remain inspectable.

- `full-npm-test.*`: accepted full `npm test` run (exit 0).
- `missing-deps-*`: first launch before dependencies were available (exit 1).
- `appdata-temp-failure-*`: P33 false red caused by Codex AppData canonical-path
  redirection (exit 1); `object-profile-rerun.*` is the corrected isolated run.
- `runner-abort-*`: first focused-runner abort caused by PowerShell treating Electron
  stderr as a terminating error; the test suite itself was not counted as passed.
- `logging.*`, `ui3*`, `ui4*`, `approval.*`, `stop.*`, `runtime.*`,
  `agent-browser.*`, `electron-guard.*`, `theme*`, `ui5-logs-electron.*`, and
  `ui5-visual*`: focused suites. `theme-electron.log` contains the one 488/489 timeout;
  `theme-electron-retry*` contains two clean 489/489 reruns.
- `app-check-port7799-failure.*`: App check blocked by the user's existing mihomo listener;
  `app-check.*` is the 26/26 run on verified free test ports.
- `build-app.*`, `package-*`, `ui5-visual-packaged.*`, `package-assets.json`, and
  `package-source-compare.json`: offline build/package verification.
- `integration-source.json`: SHA-256 binding for 460 source/test files at test start.
  Rechecking after all tests produced zero mismatches.
- `probe-object*`: diagnostics used to prove the AppData canonical-path false red.

`focused-summary.json` intentionally records the first focused batch and its theme
failure. The subsequent retries are separate evidence and are not folded into that file.
