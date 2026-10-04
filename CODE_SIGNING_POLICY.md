# Code signing policy

**Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).**

This document is the code signing policy for **Pi GUI**. It is published at the location
SignPath reviews when a signing request is made. If anything below stops being true, the
policy is wrong and must be fixed before the next signing request.

---

## What gets signed, and why

Pi GUI is a desktop GUI for the [pi](https://github.com/earendil-works/pi) coding agent,
distributed to Windows users as a downloadable installer and a portable archive. Unsigned
Windows builds trigger the operating system's "unknown publisher" / SmartScreen warnings,
which train users to click through warnings that protect them. We want our official builds
to carry a verifiable publisher identity so that:

- users can tell an official Pi GUI build from a repackaged or tampered one;
- the download-and-install path does not require ignoring a security warning;
- the project has a documented, auditable answer to "who built this binary".

We only ever ask SignPath to sign **artifacts we build ourselves, from this repository, in
our own GitHub Actions workflow**. The exact list of signed files is maintained in
[docs/code-signing.md](docs/code-signing.md) and is deliberately small — see
"Scope of the certificate" below.

## Scope of the certificate

SignPath Foundation certificates must only be used on software artifacts built from the
project's own source code. Pi GUI is a JavaScript/HTML application: it contains **no
compiled first-party binaries except the Windows installer we build with NSIS**. The
Electron runtime, Chromium, Node.js and the supporting DLLs that ship inside the package
are **third-party open-source components** and are **not** signed with this certificate.

## Team roles

Roles follow the SignPath model: **Authors** (may change the code without extra review),
**Reviewers** (review changes made by people who are not authors), and **Approvers**
(approve each individual signing request).

Pi GUI is currently maintained by a single maintainer. That one person holds all three
roles (Author/Committer, Reviewer and Approver). This is a consequence of the project
having one maintainer, not a policy choice: there is nobody else to separate the roles
onto. If a second maintainer joins, the roles will be split and this section updated.

| Role | GitHub account | Notes |
| --- | --- | --- |
| Author / Committer | [@HYJ1817](https://github.com/HYJ1817) | Only account with write access to `main` |
| Reviewer | [@HYJ1817](https://github.com/HYJ1817) | Every non-author change is reviewed before merge |
| Approver | [@HYJ1817](https://github.com/HYJ1817) | **Every** signing request is approved manually — nothing is auto-approved |

**Multi-factor authentication — an open check item, not a claim.**

SignPath requires every team member to use MFA for **both** SignPath and the source code
repository (GitHub). This repository cannot demonstrate that state, so it is recorded as an
outstanding item rather than asserted:

- [ ] `@HYJ1817` — MFA enabled on the **GitHub** account
- [ ] `@HYJ1817` — MFA enabled on the **SignPath** account

Both boxes must be ticked before the application is submitted. Once confirmed, this section
becomes a plain statement.

Contributions from anyone outside this list arrive as pull requests and are reviewed
before merge; such contributors are not Authors and never trigger a signing request.

## How signing requests are approved

Signing is **manual and per release**:

1. A release is prepared and verified on `main` (see [releasing.md](docs/releasing.md)).
2. The signing workflow builds the artifacts from that commit inside GitHub Actions, on
   GitHub-hosted runners, and uploads the unsigned artifact back to GitHub as a workflow
   artifact.
3. A signing request is submitted with the GitHub artifact ID, so SignPath's origin
   verification confirms the artifact was produced by this workflow and not injected from
   somewhere else.
4. The Approver reviews the request in SignPath and approves it by hand.
5. The signed artifact is downloaded back, its Authenticode signature verified, and only
   then released.

There is no path by which a locally-built or otherwise untrusted binary reaches the
signing request: the trusted build system requires the artifact to have been uploaded by
a GitHub Actions workflow running on GitHub-hosted agents.

## Privacy

See [PRIVACY.md](PRIVACY.md). In short: Pi GUI collects no telemetry and uploads no usage
data. It contacts the network only for (a) two version checks against public endpoints and
(b) operations the user explicitly initiates through the model provider they configured.

## Uninstallation

Pi GUI is installed with a normal Windows installer and uninstalls through
**Settings → Apps → Installed apps → Pi GUI → Uninstall** (also available from the Start
menu group). Uninstalling removes the program files and shortcuts. It deliberately leaves
`%APPDATA%\Pi GUI` (the user's own project list and window layout) in place; that folder
can be deleted manually if the user wants it gone. See
[README.md](README.md#windows-安装).

## Contact

Project maintainer: [@HYJ1817](https://github.com/HYJ1817) — issues and questions about
this policy: <https://github.com/HYJ1817/pi-gui/issues>.
