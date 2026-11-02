# 离线设计工具

来源：[JimLiu/baoyu-design](https://github.com/JimLiu/baoyu-design/tree/4923c3e05a8e176cb6f4105c45a57ea87d371256)，固定提交 `4923c3e05a8e176cb6f4105c45a57ea87d371256`，MIT许可。原许可保留为 `LICENSE.baoyu-design.txt`，ZIP内也包含LICENSE。

开始时本机Codex/Agents技能目录没有 `claude-design-system` 或 `claude-design`。按上游README支持的“临时读取技能”方式取得它们，实际使用了两种标准文件格式、官方check、编辑器保存和HTML导出。没有声称它们已全局安装。

`baoyu-design-4923c3e.zip` 只包含这两个技能及预构建编辑器/运行脚本，45个原文件约18.11MB，压缩包4,822,356字节。没有执行npm安装或修改package.json/lockfile，没有改变生产技术栈。编辑器和导出的React运行时属于本地设计工具，不能当作后续产品迁移到React的决定。

压缩包SHA256：`662f4e7b67e3d03b9f281fcae90eacacf276a8b57d8481e787602239cb182579`。

`../start-design.ps1 -Editors` 校验摘要后，将工具释放到TEMP的专用目录并打开两种编辑器；仅使用本地文件，不联网、不安装到全局技能目录。已经有Node即可。普通预览只需 `node ../tools/serve.cjs 8120`（在此目录执行），不需解压编辑器。

可编辑源：`../canvas/project/*.dc.html` 与 `canvas.json`；设计系统：`../system/project/tokens.json`、Markdown和组件预览。生成的 `tokens.css` 由设计系统编辑器保存产生。复制系统到画布是版本快照，修改Tokens后要重新安装快照并重新导出两个方向，不手改生成CSS。

`tools/export-prototypes.mjs` 用已启动的本地QA驱动操作官方HTML导出菜单，生成 `exports/*.zip` 与解压目录；manifest记录源文件和ZIP摘要。无需此驱动也可在画布编辑器里手动点Export → HTML。

边界：导出页只演示内存状态，不连接生产API、用户Pi、模型或真实文件。工具公共runtime有通用资源加载能力；本轮实际验证使用本地vendor，QA窗口主动阻止非loopback网络。后续若主动更改导出运行时或资源引用，须重新核验离线行为。
