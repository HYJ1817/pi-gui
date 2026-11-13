# Windows 11 25H2 terminal Job Object

Job mode is opt-in on Windows 11 x64 build 26200. It gives each terminal a
kill-on-close Job, binds its suspended Shell at process creation, verifies Job
membership, and then resumes it. Stop requests and confirmed exit are separate.
The backend uses native status and ConPTY EOF to finish the terminal session.
If the OS does not confirm Shell exit, the session reports an unconfirmed
stop. Output transport is released once native cleanup finishes.
With the switch off, the existing P3-B identity-gated termination path applies.

## Source and portable builds

Install the lockfile dependencies with `npm ci`. For a source run, execute
`npm run prepare:terminal-job` once after each install. It overlays the tracked
node-pty 1.1.0 files and verifies the Windows x64 prebuild digest. The package
loader uses the selected ConPTY prebuild directly, so a local node-gyp output
cannot shadow it. Restart the backend after preparing it.

`npm run build:exe` and the Electron staging path apply the same overlay
directly to the packaged sidecar, even when the installed dependency is pristine.
The packaging step uses local files for node-pty and verifies the resulting
prebuild. Keep the sidecar directory beside the portable executable.

```powershell
npm run build:exe
$env:PI_GUI_TERMINAL_JOB_OBJECT = '1'
& '.\build\Pi GUI.exe'
```

Exit an existing instance before changing the switch. To return to P3-B,
clear the variable and restart:

```powershell
Remove-Item Env:PI_GUI_TERMINAL_JOB_OBJECT -ErrorAction SilentlyContinue
& '.\build\Pi GUI.exe'
```

An explicit Job request with no matching native capability is refused before
Shell creation. The native Job entry is restricted to the tested build.
Job accounting describes Job membership and is separate from a process-handle
exit signal. Processes created by external brokers may be outside the Job.

## Native provenance and scope

The source overlay derives from node-pty 1.1.0 (MIT), with the prototype
preserved on [spike/terminal-job-object](https://github.com/HYJ1817/pi-gui/tree/spike/terminal-job-object).
The checked-in Windows x64 N-API prebuild was compiled from
`vendor/node-pty-job/src/win/conpty.cc` and upstream `path_util.cc`, using
MSVC 14.51.36231, Windows SDK 10.0.26100.0, Node 24.22.1 headers and import library,
node-addon-api 7.1.1, and the node-gyp Windows delay-load hook. The manifest beside
the binary records its SHA-256. A maintainer can rebuild using
`vendor/node-pty-job/build-native.cmd` with these tools and cached Node headers,
then update the manifest after validation. Normal packaging requires no compiler.

Startup rollback closes the pipe handles and Job before synchronously closing
the HPCON. Windows 11 build 26200 uses the non-waiting close API. The earlier
Windows close behavior remains outside the supported Job build. The existing
spike branch retains historical experimental fixtures and evidence.
