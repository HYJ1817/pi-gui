# Windows 代码签名（SignPath Foundation）

本文记两件事：**哪些文件该签、哪些不该签**，以及**签名链路怎么接进现有发版流程**。
面向 SignPath 审核方的政策文本在仓库根 [CODE_SIGNING_POLICY.md](../CODE_SIGNING_POLICY.md)，
隐私披露在 [PRIVACY.md](../PRIVACY.md)。发版流程本身见 [releasing.md](releasing.md)。

> 现状：**尚未接入任何签名。** 申请还没提交，仓库里也没有 SignPath 的 secrets。
> 已就位的是 `.github/workflows/signpath-sign.yml`（**手动触发、缺配置即安静跳过**，
> 不碰 release.yml），以及本文描述的边界与接入步骤。

## 一、签名边界清单（哪些 PE 属于本项目）

判断标准只有一条：**这个 PE 是不是从本仓库的源码构建出来的。**

Pi GUI 是 JS/HTML 应用 —— `server/` 与 `public/` 最终是 `server.cjs`（文本）、
`main.cjs`（文本）和静态资源。**它没有任何自己编译出来的一手 PE**，唯一的例外是
用 `installer/pi-gui.nsi` 编译的 NSIS 安装程序。

### 发布目录 `dist-release/` 里的东西

| 文件 | 来源 | 属于 pi-GUI？ | 现在有签名？ | 该由 SignPath 签？ | 原因 |
| --- | --- | --- | --- | --- | --- |
| `Pi-GUI-Setup-X.Y.Z.exe` | `makensis` 编译 `installer/pi-gui.nsi` | **是**（一手） | 无 | **✅ 应该** | 本项目唯一的一手 PE。用户从 Releases 下载后双击的就是它 —— 「未知发布者」提示正是在这里出现 |
| `Pi-GUI-X.Y.Z-portable.zip` | `bsdtar --format=zip` 打的压缩包 | 是（容器） | n/a | ❌ 不适用 | Authenticode 是 PE 的概念；zip 本身没有可签的东西 |
| `SHA256SUMS.txt` | `scripts/make-checksums.mjs` 生成 | 是 | n/a | ❌ 不适用 | 文本 |

### 便携版 zip **内部**的 PE

| 文件 | 来源 | 属于 pi-GUI？ | 该由 SignPath 签？ | 原因 |
| --- | --- | --- | --- | --- |
| `Pi GUI.exe`（约 246 MB） | **上游 `electron.exe` 改名 + `rcedit` 改元数据** | **否** | **❌ 不应该** | 它的二进制不是本项目源码编译的。给不属于本项目维护的上游二进制套本项目的证书，是 SignPath 条款明令禁止的用法 |
| `ffmpeg.dll` | Chromium | 否 | ❌ | 上游 |
| `d3dcompiler_47.dll` / `dxcompiler.dll` / `dxil.dll` | Microsoft DirectX | 否 | ❌ | 上游 |
| `vk_swiftshader.dll` / `vulkan-1.dll` | 上游（SwiftShader / Vulkan loader） | 否 | ❌ | 上游 |
| `resources/app/**`（`server.cjs`、`main.cjs`、`public/`） | **本仓库源码** | 是 | ❌（没有 PE 可签） | JS / HTML，没有 Authenticode 这个概念。它们进不了签名边界 |

### 不在发布里、但构建时会出现的东西

| 文件 | 来源 | 该由 SignPath 签？ | 原因 |
| --- | --- | --- | --- |
| `build/Pi GUI.exe`（约 98 MB） | Node SEA：上游 `node.exe` + 注入 blob | ❌ | **不是发布资产**，只是 `build:app` 的中间产物（它产出的 `server.cjs` 才进包） |
| `Uninstall Pi GUI.exe` | NSIS 的 `WriteUninstaller` 在**目标机器上安装时**生成 | ❌ | 生成在用户机器上，发布物里根本不存在这个文件，无法预先签名 |

### 结论

**一次签名，签一个文件：NSIS 安装程序。**

顺带一个上游事实（与「能不能嵌套签」有关）：SignPath Artifact Configuration 的
文件类型表里 `<pe-file>` 的 *Composite* 是 **No**，也就是说 **SignPath 不会钻进一个 PE
里去签它内嵌的文件**。NSIS 安装程序本身就是一个 PE —— 想让安装完之后用户机器上的
`Pi GUI.exe` 带签名，就得**在编译安装程序之前**先把它签好。这一条我们**用不上**：
那个 exe 是 Electron 的，本来就不该用本项目的证书签（见上表）。

### ⚠️ 要签的那个文件，PE 元数据必须是满的

SignPath 的 **File metadata restriction** 要求签名产物带上
«`product-name` = 项目名» 与 «`product-version` = 版本号»。这不是可选项 ——
**签的正是安装程序，所以安装程序自己必须带这两个字段。**

这里踩过一次，写下来：

* NSIS **默认不写版本资源**。`installer/pi-gui.nsi` 原来一条 `VIAddVersionKey` 都没有，
  于是编译出来的安装程序 PE 的 `CompanyName` / `ProductName` / `ProductVersion` /
  `LegalCopyright` **全是空串**（用 `Get-Item … .VersionInfo` 实测确认）。
* 另一边，`@electron/packager` **会**写版本资源，但 `appCopyright` 不传时会**保留上游
  `electron.exe` 自带的**，于是「Pi GUI」的主程序版权行写着
  `Copyright (C) 2015 GitHub, Inc.` —— 也是错的。

修法（两处都已修并实测）：

| 产物 | 谁写元数据 | 来源 |
| --- | --- | --- |
| `Pi GUI.exe` | `@electron/packager` | `scripts/build-app.mjs` 的 `appCopyright` |
| `Pi-GUI-Setup-*.exe` | NSIS `VIProductVersion` / `VIAddVersionKey` | `scripts/build-installer.mjs` 注入的 `/DVI_VERSION`、`/DCOPYRIGHT` |

两个版权串**同一个出处**：`scripts/util.mjs` 的 `COPYRIGHT`（写两遍迟早漂）。

两个坑：

1. `VIProductVersion` **只吃四段纯数字**（`x.x.x.x`）。三段的 SemVer 会被 NSIS 拒绝，
   所以构建脚本额外注入 `VI_VERSION = VERSION + ".0"`。
2. 那段 VERSIONINFO 指令**必须排在宏检查 `!ifndef` 之后**。它们会真的求值，
   放前面就变成「先用后查」，宏没定义时给的是难懂的报错而不是那句 `!error`。

## 二、签名流水线

```
source（tag vX.Y.Z）
  │
  ▼  仅 GitHub-hosted runner（windows-latest）—— OSS 订阅的硬要求
GitHub Actions
  │
  ├─ npm run release:check -- --tag=vX.Y.Z --with-installer
  │     ├─ build:app            → dist-app/…（未签名）
  │     ├─ build:installer      → dist-installer/Pi-GUI-Setup-X.Y.Z.exe（未签名）
  │     ├─ test:app / test:exe / test:installer / test:portable
  │     ├─ release:collect      → dist-release/（Setup + portable + SHA256SUMS）
  │     └─ release:verify
  │
  ▼
unsigned artifact
  │
  ▼  actions/upload-artifact@v7（**必须先上传到 GitHub**）
GitHub workflow artifact  ──►  artifact-id
  │
  ▼  signpath/github-action-submit-signing-request@v3
  │     github-artifact-id = 上一步的 artifact-id
  │     origin metadata 由 GitHub 提供 → 构建脚本**无法伪造**
SignPath
  │
  ▼  Approver 在 SignPath 里**人工批准**（OSS 订阅要求逐次批准）
signed first-party binary（signed/Pi-GUI-Setup-X.Y.Z.exe）
  │
  ▼  Get-AuthenticodeSignature 必须是 Valid
verify
  │
  ▼  （接入发版后）**重算 SHA256SUMS**
GitHub Release
```

**为什么不需要「先签 exe → 再打进安装程序 → 再签安装程序」那套两层签名**：
那套流程解决的是「安装完之后落到用户机器上的程序也要带签名」。本项目里那个程序是
**Electron 的上游二进制**，本来就不该签（第一节）。所以本项目的签名对象从头到尾只有
安装程序一个。

## 三、GitHub Actions 集成

### 现在的形态：独立、手动、缺配置不失败

`.github/workflows/signpath-sign.yml`：

* **只 `workflow_dispatch`**，不挂 `push` / `tag` —— 正式发版路径完全不受影响。
* 第一个 job `guard` 把「secrets/variables 配没配」变成一个 output；缺任何一项时
  `ready=false`，签名 job 直接跳过（**不会让 workflow 失败**）。所以申请还没批下来
  之前，这个文件待在仓库里也不会打扰任何人。
* 只用 `windows-latest`（GitHub-hosted）；产物先 `upload-artifact`，再用 artifact-id
  提交签名请求；不下载安装包、不发布 Release。
* **输入只接受 Release tag**（`vX.Y.Z`）。两道闸：先按正则挡掉分支名 / commit SHA /
  预发布版本，再在 checkout 之后、完整构建**之前**断言 `tag === "v" + package.json.version`。
  `checkout` 明确 checkout 该 tag，`concurrency` 按该 tag 分键（不用 `github.ref`，
  手动触发时那是分支）。用户输入一律经 `env:` 传进脚本，**不直接插进 `run:`**——
  那是脚本注入面。

### 用到的 secrets / variables

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `SIGNPATH_API_TOKEN` | **Secret** | SignPath REST API token。**绝不写进仓库、绝不打印** |
| `SIGNPATH_ORGANIZATION_ID` | Variable | SignPath 组织 ID |
| `SIGNPATH_PROJECT_SLUG` | Variable | SignPath 项目 slug |
| `SIGNPATH_SIGNING_POLICY_SLUG` | Variable | 签名策略 slug（需开启 origin verification） |
| `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` | Variable | 产物配置 slug |

> 用 Variable 存 slug、Secret 存 token：slug 本身不是秘密（写在 workflow 里也不会泄密），
> 但组织/项目拓扑属于配置、不是代码，放 Variable 里改起来不用动提交。

### action 版本

* `signpath/github-action-submit-signing-request@v3` —— 官方文档当前的推荐版本
  （tags 里确有 `v3` / `v3.0`，GitHub Releases 页面只列到 v2，别被它误导）。
* `actions/upload-artifact@v7` —— SignPath 官方示例用的就是 v7，且要求 **v4+**。
  `checkout` / `setup-node` 仍按本仓库既有约定钉 **v5**（理由见 `ci.yml` 头部备注）。
* `actions/upload-artifact` 默认会把上传的文件压成一个 zip，因此 SignPath 侧的
  **Artifact Configuration 根元素是 `<zip-file>`**。具体结构**不要手写猜** —— 申请
  通过后按 SignPath 的「上传样本自动分析」生成，再人工核对一遍（它可能把不该签的
  第三方文件也列进去）。

## 四、接入发版（**审核通过之后**再做）

现在 `release.yml` 的顺序是「预检 → 创建 draft → 上传 → 核对 → 发布」，全程没有签名。
审核通过后的最小改动是在**预检之后、发布之前**插一段签名，并且**重算校验和**：

```yaml
      # … release:check 之后 …

      # version 参数必须等于 PE 的 ProductVersion（package.json 的 version，**不含 v**），
      # 不能直接用 ref_name（那是 v0.18.3，多一个 v 就过不了 metadata 约束）。
      - name: Read version
        id: ver
        shell: pwsh
        run: |
          $v = (Get-Content package.json -Raw | ConvertFrom-Json).version
          "version=$v" >> $env:GITHUB_OUTPUT

      - name: Upload unsigned installer
        id: upload-unsigned
        uses: actions/upload-artifact@v7
        with:
          name: pi-gui-unsigned-installer
          path: dist-release/Pi-GUI-Setup-*.exe

      - name: Sign installer
        uses: signpath/github-action-submit-signing-request@v3
        with:
          api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
          organization-id: ${{ vars.SIGNPATH_ORGANIZATION_ID }}
          project-slug: ${{ vars.SIGNPATH_PROJECT_SLUG }}
          signing-policy-slug: ${{ vars.SIGNPATH_SIGNING_POLICY_SLUG }}
          artifact-configuration-slug: ${{ vars.SIGNPATH_ARTIFACT_CONFIGURATION_SLUG }}
          github-artifact-id: ${{ steps.upload-unsigned.outputs.artifact-id }}
          wait-for-completion: true
          wait-for-completion-timeout-in-seconds: 3600
          output-artifact-directory: signed
          parameters: |
            version: "${{ steps.ver.outputs.version }}"

      # 把签名后的 exe 放回构建目录，**然后重算校验和**。
      - name: Replace installer with signed copy
        shell: pwsh
        run: |
          $signed = Get-ChildItem signed -Filter 'Pi-GUI-Setup-*.exe' | Select-Object -First 1
          if (-not $signed) { throw '没有签名产物' }
          Copy-Item $signed.FullName dist-installer/$($signed.Name) -Force
          # 签名改的是 Setup.exe 的**字节** → SHA256SUMS 必须重算，
          # 否则 release:verify / verify-uploaded-release 会拿旧摘要去比新文件。
          npm run release:collect
          npm run release:verify

      # … 原来的 publish-release 步骤 …
```

### 三个必须记住的坑

1. ⚠️ **签名会改变 Setup.exe 的字节 → `SHA256SUMS.txt` 必须在签名之后重算。**
   本仓库的发布守卫（`release:verify`、`verify-uploaded-release.mjs`）是拿 GitHub
   自己算的 sha256 逐项对比的 —— 拿旧摘要比新文件，一定失败，而且失败信息指向
   「校验和对不上」，很容易被误判成上传出错。
2. ⚠️ **`test:installer` 验的是签名前那份。** 签名换了字节之后，如果要「验过才发」的
   承诺严格成立，应在替换之后**再跑一次** `npm run test:installer`。runner 是一次性
   虚拟机，装完即弃。
3. ⚠️ **签名请求要人工批准**，`wait-for-completion` 会一直等。别把
   `cancel-in-progress` 开成 true —— 发版中途被取消会留下更难收拾的状态
   （现 `release.yml` 已经是 `false`，保持即可）。

## 五、申请通过后需要准备的东西

从 SignPath 侧拿到、并填到对应位置：

| 需要什么 | 填到哪 |
| --- | --- |
| Organization ID | GitHub **Variable** `SIGNPATH_ORGANIZATION_ID` |
| Project slug | GitHub **Variable** `SIGNPATH_PROJECT_SLUG` |
| Signing policy slug | GitHub **Variable** `SIGNPATH_SIGNING_POLICY_SLUG` |
| Artifact configuration slug | GitHub **Variable** `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` |
| API token | GitHub **Secret** `SIGNPATH_API_TOKEN`（**不进日志、不进文档、不进提交**） |

在 **SignPath 里**（不是 GitHub）还要做：

1. 组织里添加预置的 **Trusted Build System = `GitHub.com`**，并链接到本项目 ——
   OSS 订阅的 origin verification 依赖它。
2. 确认签名策略开启了 **origin verification**，且 runner 约束为
   **GitHub-hosted**（OSS 要求签名前所有 job 都在 GitHub 托管 agent 上跑）。
3. 安装 **SignPath GitHub App**（SignPath 用它评估审计日志）。
4. 用「上传样本」生成 **Artifact Configuration**：样本就是一份真实的
   `Pi-GUI-Setup-X.Y.Z.exe`。生成后**人工核对**——根元素应是 `<zip-file>`，
   里面只应出现那一个 `<pe-file>`，且带 `product-name` / `product-version` 约束；
   如果它把 Electron 的 DLL 也列进来了，删掉。
5. 配置 metadata restriction：`product-name = Pi GUI`、`product-version = 版本号`。

## 六、这个项目与 SignPath 条款的对照

逐条核对见根目录 [CODE_SIGNING_POLICY.md](../CODE_SIGNING_POLICY.md)。几处值得记下的：

* **许可证**：MIT，OSI 认可，无商业双许可。
* **无专有组件**：随包只有 Electron(MIT)、pdfjs-dist(Apache-2.0) 等开源件；
  pi 本体不随包分发（只在运行时通过 RPC 驱动用户自己装的那份）。
* **不是 hacking tool**：它是个编码 Agent 的图形界面。它能执行命令、驱动浏览器，
  但那是**用户让它做的**，不是用来探测/利用漏洞或绕过安全机制。**这一条建议在
  申请时主动说明一句**，避免审核方只看到「能执行任意命令」就归类到受限类别。
* **隐私**：只有两处自动版本检查 + 用户主动触发的供应商通信；无遥测。见 PRIVACY.md。
* **卸载**：NSIS 安装程序有卸载入口并写进「添加或删除程序」。`%APPDATA%\Pi GUI`
  刻意保留（那是用户自己的项目列表）。
