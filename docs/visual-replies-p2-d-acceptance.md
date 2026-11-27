# Visual Replies P2 D：高度、主题、阅读与 iframe 生命周期

## 范围与身份

- 基线：`dfdc1ddea060d8c369e5e0932d052655baa3d772`，独立分支 `feat/visual-replies-p2-d`。
- 工具初始设置分支保留，未 reset；不能快进时直接在准确父基线上建立新分支。
- 准确基线 CI：[45952490979](https://github.com/HYJ1817/pi-gui/actions/runs/45952490979)，push、attempt 1、SHA 同上；五组、Electron build、CI gate 均 success。
- D 只负责 frame/bootstrap、theme、reading-position 和独立 helper。C 唯一持有 viewer 的 mount/register/dispose/fullscreen/zoom；A 统一正常沙箱 Electron；E 统一 canonical。D 不改 viewer、CSS、messages、后端、Electron、package 或 CI，不再分派。

## 勘察与接口契约

既有 v1 不变：`{schemaVersion:1,id,nonce,type}`；`ready`、host → frame `theme` 继续兼容。
nonce 防串 frame，不认证同 realm 的不可信脚本。host 的 source、opaque origin、schema、id、nonce、类型、长度与动作校验不可由 bootstrap 替代。

### 高度与 host 限流

`resize` 保留 `height`（80..4096 CSS px），扩展 `naturalHeight`、`naturalWidth`、`capped`。
超高内容在 iframe 内滚动，不以 4096 截断 HTML；不回送 host 视口高度为自然高度。

`public/html-artifact-layout.js`：

- `createHtmlArtifactResizeController({view,apply,isCurrent})` → `accept(value)` / `flush()` / `dispose()`。
- C 完成身份校验后将完整 resize 对象交给 `accept`。非法数值拒绝；旧 height 单字段仍可用，host clamp 80..4096；自然尺寸上限 1,000,000。
- 最多每 100ms 一次 host apply，保留最终值，避免 malicious 直接 `parent.postMessage` 绕 bootstrap；重复尺寸不写 DOM。`flush` 不绕过限流；dispose 取消待办且幂等。
- `apply({height,naturalHeight?,naturalWidth?,capped})` 由 C 在自身 `preserveLayout` 内使用；全屏/缩放不把显示高度当自然高度。

### 可见性与唯一资源 owner

- `createHtmlArtifactVisibilityController({node,onVisibility,document})` → `refresh()` / `dispose()`。
- IntersectionObserver 的 600px 预热区用于惰性 mount；document hidden、隐藏祖先、折叠 details 通知 false。没有 IO 的环境安全退为 eager mount。
- helper 只发状态，绝不 mount/unmount/register/release；C 决定首次 mount，向同一 iframe 发 `{schemaVersion:1,id,nonce,type:'visibility',visible:boolean}`，恢复不重建可见 frame。
- HTML 是不可变持久快照；筛选、表单与 JS 状态只属于临时 iframe。保留 iframe 时不丢这些状态；既有 Runtime 离开/历史切换 dispose 后重新授权读取快照，不承诺恢复临时交互状态，不新增 HTML 缓存。

### 最小交互协议

- `escape`：只请求关闭当前顶层 viewer；bootstrap 与 host 各自限流。
- `link {href}`：最多 2048 字符，绝对 HTTP(S)、无 credentials/控制字符，bootstrap 只处理 trusted click；host 再验证、限流并经现有安全外链确认，不把消息当用户授权。
- `image {src,alt}`：src 最多 2MiB 字符，只允许 data PNG/JPEG/WebP/GIF base64；alt 最多 256。host 再检查 magic/像素上限，不注入 SVG/HTML 标记、不读取 URL。
- **不实现 wheel 消息或 host 滚动 RPC**。原生 Chromium scroll chaining/overscroll auto 是唯一跨 frame 滚轮路径；行为由 A 实测，不可靠时明确限制而非开放脚本滚动宿主能力。
- CSP、opaque origin、最小 sandbox、网络/RTC 锁必须在任意不可信字节解析前生效；全屏不增加权限。

## D 新套件（交 E 纳入唯一 canonical）

1. `node --test tests/html-artifact-layout.cjs`：host 合并限流、直接消息攻击、可见性与 disposer。
2. `node --test tests/html-artifact-frame.cjs`：可信 bootstrap 执行、测量、主题、锁失败与生命周期；DOM/受控几何，不是视觉或 Electron 安全证明。
3. `node --test tests/html-artifact-reading.cjs`：真实生产 reading helper 的多 Artifact、历史分页、滚动跟随/锚定；受控矩形，不是像素验收。

所有 fixture 如需写盘只用 `os.tmpdir()`；不下载、不调用 Pi/模型、不写真实数据；D 不修改 `tests/html-artifact-ui.cjs`。

## 本地基线记录

Node `v24.22.1` / Windows 11，未提交行为前执行：

- 首次 `node --test tests/html-artifact-ui.cjs`：exit 1，MODULE_NOT_FOUND(jsdom)，0 pass / 1 failed file；工作树没有依赖。
- 只为命令设置 `NODE_PATH=C:/pi-GUI/node_modules` 复用本机现有依赖，不安装/下载。
- `node --test tests/html-artifact-ui.cjs`：13/13，skip 0，exit 0，2926.3442ms。
- `node --test tests/html-artifact-security.cjs`：24/24，skip 0，exit 0，245.2025ms。

## 当前验收状态

开发中。实现后定向数字、T3 只读参考身份、源代码证据及首次失败将继续追加。
完整 canonical、实际 Electron 渲染/正常沙箱/滚轮链/最小化/全屏/主题四组合、真实截图与正式构建由父 Agent 集成并由 A/E 取证：**待验证**，本报告不将 jsdom 或静态检查当作视觉通过。
未重建产物前仅源码可见；D 不宣称打包用户已看到本次改动。

## 风险与回滚

隔离边界属于高风险，必须独立功能与安全复审，不能由 D 自审通过代替。回滚 D 行为提交并重建产物；C 集成的 helper import/调用须同步回退，保持 v1 ready/theme/resize 兼容；无需迁移或修改任何持久 HTML 快照。
