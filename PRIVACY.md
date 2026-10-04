# Privacy Policy

**Pi GUI** is a local desktop application. It is not a service, it has no user accounts, and
it does not operate any server of its own. This policy describes every network request the
application can make and what leaves your machine.

Last updated: 2026-10-03.

---

## Summary

- **No telemetry. No analytics. No crash reporting. No advertising. No user accounts.**
- Pi GUI does not collect, store or transmit any usage data, and it does not have a
  backend that could receive it.
- The only automatic network requests are **two version checks** against public
  endpoints, described below. They send no data about you.
- Everything else that touches the network is started by **you**, and uses credentials
  **you** configured. Pi GUI does not store them; it reads them back from `pi`, in memory,
  only for the quota and model-list requests in sections 4 and 5.

## What Pi GUI itself sends

### 1. Update check for Pi GUI (automatic once per launch, and on demand)

Pi GUI asks GitHub for the latest public release metadata of this project:

- Endpoint: `https://api.github.com/repos/HYJ1817/pi-gui/releases/latest`
- When: once, about 8 seconds after launch, and whenever you press "Check for updates".
- Sent: only the HTTP headers GitHub's API requires (`User-Agent`, `Accept`). **No
  identifier, no machine information, no usage data.**
- Failure is silent and does not affect the application.

This request reveals your IP address to GitHub, as any web request does. GitHub's handling
of it is governed by GitHub's own privacy statement. Pi GUI never downloads or installs
anything from it — it only displays a version number and a download link.

### 2. Update check for the `pi` runtime (automatic once per launch, and on demand)

Pi GUI asks the pi project's public endpoint whether the `pi` installed on your machine
is current:

- Endpoint: `https://pi.dev/api/latest-version`
- When: once, about 12 seconds after launch, and on demand. **Check only — it never
  installs anything by itself.** Updating `pi` requires your explicit confirmation and is
  then performed by pi's own official updater.
- Sent: the same minimal headers as above. No identifier, no machine information.

### 3. Model inference — performed by the `pi` process you configured

Pi GUI does not perform model inference and does not send your prompts to a model provider.
It drives a `pi` process **you already installed and configured**, over a local stdio pipe.
Prompts, files and tool results go to that local process; whatever `pi` then sends to a
model provider is controlled by your `pi` configuration and your credentials, and is sent
by `pi`, not by Pi GUI.

Pi GUI does contact some providers **directly** for two things: displaying your **quota**
(section 4) and fetching a **model list** (section 5). Both are initiated by you, and both
are described precisely below.

### 4. Provider quota display — only for providers you configure

For a small set of supported providers, the "Usage / Quota" view can show your remaining
quota. To do this, Pi GUI asks `pi`'s own authentication SDK to **resolve the provider
credential in memory**, inside a separate worker process, and then calls that provider's
own quota endpoint directly:

- OpenRouter: `https://openrouter.ai/api/v1/key`
- DeepSeek: `https://api.deepseek.com/user/balance`

This is the one place where Pi GUI holds a usable credential, so it is worth stating
exactly what happens to it:

- The credential is **resolved in memory only**, inside that worker. It is never written to
  disk, never displayed in the interface, and never logged — not in error messages, not in
  the diagnostic report, and not over the local stdout pipe.
- It is sent **only to the provider it belongs to**, over HTTPS. It is never sent to the
  pi-GUI project, and never to any other third party.
- A **one-way SHA-256 hash** of it is used as the local cache key, so that changing the
  credential invalidates the cached quota for that provider. The hash is a cache identity
  only: it is not transmitted anywhere, and it cannot be reversed back into the credential.
- Provider response text is scrubbed of the credential before it is displayed or cached.
- Pi GUI does not store credentials itself. They remain stored, owned and managed by `pi`;
  Pi GUI only reads the resolved value back out of `pi`, in memory, for this one request.

### 5. Model list fetch — only when you click the button

The "Model providers" settings can fetch the available model list from a provider's
`/models` endpoint. This runs **only when you press "Fetch"**. Pi GUI makes this request
itself: it goes to the base URL **you** typed, with the authentication scheme you selected
and the API key from that provider's entry in your `pi` model configuration. The key is
resolved in memory for the request only, is never logged, and is sent only to that
provider's endpoint. (Pi GUI deliberately does **not** execute `!command`-style keys, which
would run a program to obtain the value.)

### 6. Sign-in (OAuth) — performed by `pi`, not by Pi GUI

Logging in to a provider (for example a ChatGPT subscription) is handled by `pi`'s own
public SDK: the browser callback, credential storage and token refresh are all done by
`pi`. Pi GUI only displays the resulting state.

## Things Pi GUI does **not** do

- It does not collect telemetry, analytics, or crash reports.
- It does not upload your prompts, files, repository contents, or usage statistics to the
  pi-GUI project or anyone else.
- It does not create or require an account.
- It does not **persist**, display, log, or forward your provider credentials. The one
  exception to "never touches a credential at all" is the in-memory resolution described in
  section 4, which exists solely to display your quota; that value is sent only to the
  provider it belongs to.
- It does not automatically download, install, or silently update anything — including
  itself.
- It does not modify your system configuration without warning.

## Extensions you install

Pi GUI can drive pi **Extensions** that you chose to install (for example a web-search
extension, the browser-harness extension, or a long-term memory extension). Those
extensions run inside `pi` and may make their own network requests, subject to their own
policies. Pi GUI displays the activity it can observe but does not control what an
extension sends. What is installed, and whether it runs, is your choice.

## What is stored on your machine

All state is local:

- `%APPDATA%\Pi GUI` — window layout, your project list, and interface preferences.
  (When running from source instead of the installed build, this is `%APPDATA%\pi-gui`.)
- Your own `pi` configuration, sessions and credentials live in pi's own directories and
  are managed by `pi`, not by Pi GUI.

Nothing in these folders is uploaded anywhere. Uninstalling the application removes the
program files but leaves `%APPDATA%\Pi GUI` alone (see
[CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md#uninstallation)); delete that folder
manually to remove the remaining settings.

## Disabling the automatic checks

The two automatic version checks (sections 1 and 2) are the only requests Pi GUI makes
without you asking. They send no personal data and can fail silently, and the application
works fully without them. They are not currently exposed as a toggle; if you want no
outbound request at all, run the app on a machine or network where those endpoints are
unreachable — no feature other than the version display is affected.

## Third parties

| Service | Why | Governed by |
| --- | --- | --- |
| GitHub (`api.github.com`) | Pi GUI release metadata | GitHub Privacy Statement |
| pi.dev | `pi` runtime version metadata | The pi project |
| Your model provider(s) | Model inference, quotas, model lists | That provider's policy |
| Providers you sign into via `pi` OAuth | Authentication | That provider's policy |

## Changes and contact

If this policy changes, the change will appear in this file in the repository's history.
Questions: <https://github.com/HYJ1817/pi-gui/issues>.

---

## 中文摘要

Pi GUI 是**纯本地**桌面程序：没有账号、**没有遥测 / 埋点 / 崩溃上报 / 广告**，也不上传
任何使用数据。只有两类网络请求：① 启动后各**自动检查一次**版本（Pi GUI 官方 Release、
`pi` 运行时版本），只发 GitHub 要求的必备请求头、不含任何身份信息，失败即静默；
② **你自己触发**的操作 —— 模型对话与 OAuth 登录由你本机装的 `pi` 完成；用量配额与模型
列表由 Pi GUI 自己发请求，只针对**你配置的**供应商。配额查询需要凭据：Pi GUI 会经 Pi 的
认证 SDK **在内存里**解析出该供应商的凭据，**只**发给该供应商的官方接口，另取其不可逆的
SHA-256 哈希做本地缓存键；**不落盘、不显示、不记日志、不发给 pi-GUI 项目**。模型列表用的
是你在 Pi 模型配置里存的 Key，同样只在内存里用一次。
你装的 Pi Extension 可能自行联网，那由该 Extension 自己负责。

本机数据都在 `%APPDATA%\Pi GUI`（窗口布局、项目列表）：不卸载不删除，卸载程序**只删程序
文件、保留这份数据**。完整说明见 [PRIVACY.md](PRIVACY.md) 英文部分。
