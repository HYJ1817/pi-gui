# P32.4 delivery index

Before HEAD: 09182a26479bb6fbf97b139826b03e6629a01c4c

Verified implementation/test HEAD: a1d353d51c299a31a9122650ff37a1f64761a32e

Final after HEAD is the documentation/evidence commit containing this index. See the delivery reply or git rev-parse HEAD; do not self-reference a commit SHA inside its own tree.

## Commits

- 3fa76c5 修复 P32.4-C Changes 的工作区权威与生命周期锁
- ec932ef 测试 P32.4-C Changes 的真实 Git 隔离与失效拒绝
- 560bada 绑定 P32.4-C 会话右栏并隔离迟到响应
- e4f0788 补充 P32.4-C 右栏切换与捕获归属交互测试
- c700deb 合并并行会话导航中的重复归属读取
- 8843b05 读取进程权威状态前禁用权限开关
- 427c785 保留同一会话重复 focus 时的原生 Browser 绑定
- a8fafc0 验证 P32.4-C 原生 Browser、真实进程与 Git 右栏隔离
- 07a8210 验证运行名额等待全部清理确认后释放
- 25c2836 统一 P32.4-D 运行名额与第三会话启动确认
- 8b30737 验证 P32.4-D 资源权威、取消与迟到快照隔离
- ae4442e 恢复当前会话就绪后绑定后端焦点
- e7b9c39 验证恢复焦点等待就绪并取消迟到切换
- 31d5b9e 等待原生会话身份并以选择代次取消恢复焦点
- 94c13ea 验证未绑定与往返切换时的恢复焦点竞态
- fd8d85a 验证 P32.4-D 第三会话、后端拒绝与原生资源清理
- 4156925 绑定 P32.4-E 原生模型读回与历史身份证明
- cc771dd 完成 P32.4-E 会话模型、只读历史与标题隔离
- 682cbeb 修复并行会话键盘焦点与高缩放右栏遮挡
- 9d6e148 验证原生模型确认、失败隐私与就绪身份竞态
- bd8c1b4 验证真实历史定位与并发文件身份替换拒绝
- 7dbb142 验证会话模型界面、历史导航与键盘焦点隔离
- a1d353d 补全 P32.4-E Electron 实测并登记唯一测试入口
- Final documentation/evidence commit: 整理 P32.4 最终验收记录与真实截图证据 (this index).

## Changed files

- electron/browser-runtime-host.cjs
- electron/main.cjs
- electron/preload.cjs
- package.json
- public/api.js
- public/app.js
- public/browser-pane.js
- public/git.js
- public/process-panel.js
- public/right-pane.js
- public/runtime-conversation.js
- public/runtime-models.js
- public/runtime-nav.js
- public/runtime-resources.js
- public/runtime-secondary.js
- public/runtime-sessions.js
- public/runtime-state.js
- public/runtime-store.js
- public/session-search.js
- public/sessions.js
- public/shell.js
- public/styles.css
- server.js
- server/git-routes.js
- server/runtime-registry.js
- server/runtime-routes.js
- server/session-history.js
- server/session-runtime.js
- server/session-search.js
- tests/process-ui.cjs
- tests/runtime-browser.cjs
- tests/runtime-changes.cjs
- tests/runtime-conversation.cjs
- tests/runtime-electron.cjs
- tests/runtime-finish-ui.cjs
- tests/runtime-git-ui.cjs
- tests/runtime-history-search.cjs
- tests/runtime-models.cjs
- tests/runtime-nav.cjs
- tests/runtime-resource-cleanup.cjs
- tests/runtime-resources.cjs
- tests/runtime-secondary.cjs
- tests/runtime-ui.cjs
- docs/p32-4-acceptance.md: rewritten into exactly 20 sections.
- docs/superpowers/plans/2026-10-07-p32-4-finishing.md: completed gate record.
- docs/evidence/p32-4/: this index, safe report summary, and 44 images.

## Evidence summary

Canonical npm test: passed, exit 0; 89 entries; runtime 533/533.

Final Electron: passed 170/170, exit 0; classic capture 2/2, exit 0; screenshots 44; renderer errors 0; owned test processes 0. Build app rebuild: passed exit 0, 13.534 seconds. App-check: first EACCES on 7799 environment blocked; retry CHECK_PORT=24790 passed 26/26 exit 0. Packaged classic Browser regression: 52/52; UI IA 12/12.

Real Git, real Electron/WebContentsView and real Node HTTP processes were exercised. Pi/model content in runtime/app-check scenarios is fixture. Real Pi/model task, 30-minute real-model stress, current CI and POSIX are unverified/not executed. Native and main screenshots are separate.

Initial E functionality 166/166 missed a visual 150% overlap; fixed and added bounds assertions before final 170/170. Independent review P2 same-inode rewrite reproduced RED, fixed with same-fd post-body header validation, history/search 35/35 GREEN. No deleted assertions.

## Screenshots

- [running-B-1280x800.png](running-B-1280x800.png)
- [running-B-1440x900.png](running-B-1440x900.png)
- [running-B-1920x1080.png](running-B-1920x1080.png)
- [running-B-zoom125.png](running-B-zoom125.png)
- [A-stopped-B-running.png](A-stopped-B-running.png)
- [scoped-browser-open.png](scoped-browser-open.png)
- [scoped-browser-closed.png](scoped-browser-closed.png)
- [A-crashed-B-running.png](A-crashed-B-running.png)
- [sidebar-a-running-b-focused.png](sidebar-a-running-b-focused.png)
- [sidebar-1280x800.png](sidebar-1280x800.png)
- [sidebar-1920x1080.png](sidebar-1920x1080.png)
- [sidebar-zoom125.png](sidebar-zoom125.png)
- [sidebar-focus-a.png](sidebar-focus-a.png)
- [sidebar-focus-a-draft.png](sidebar-focus-a-draft.png)
- [sidebar-b-operable-while-a-pending.png](sidebar-b-operable-while-a-pending.png)
- [c-browser-native-a.png](c-browser-native-a.png)
- [c-browser-native-b.png](c-browser-native-b.png)
- [c-browser-b-native-owner.png](c-browser-b-native-owner.png)
- [c-process-permission-0.png](c-process-permission-0.png)
- [c-process-permission-1.png](c-process-permission-1.png)
- [c-process-a.png](c-process-a.png)
- [c-process-b.png](c-process-b.png)
- [c-changes-a.png](c-changes-a.png)
- [c-changes-b.png](c-changes-b.png)
- [c-changes-a-restored.png](c-changes-a-restored.png)
- [sidebar-dormant.png](sidebar-dormant.png)
- [d-two-regular-slots.png](d-two-regular-slots.png)
- [d-third-confirmation.png](d-third-confirmation.png)
- [d-third-active.png](d-third-active.png)
- [d-fourth-rejected.png](d-fourth-rejected.png)
- [d-close-slot-recovered-history.png](d-close-slot-recovered-history.png)
- [e-model-b-text.png](e-model-b-text.png)
- [e-model-a-reasoning.png](e-model-a-reasoning.png)
- [e-central-1280x800.png](e-central-1280x800.png)
- [e-central-1440x900.png](e-central-1440x900.png)
- [e-central-1920x1080.png](e-central-1920x1080.png)
- [e-central-zoom125.png](e-central-zoom125.png)
- [e-central-zoom150.png](e-central-zoom150.png)
- [e-browser-zoom150.png](e-browser-zoom150.png)
- [e-browser-native-zoom150.png](e-browser-native-zoom150.png)
- [e-search-live-history-a.png](e-search-live-history-a.png)
- [e-search-dormant-history-b.png](e-search-dormant-history-b.png)
- [sidebar-created.png](sidebar-created.png)
- [classic-ui.png](classic-ui.png)

Local ignored raw diagnostics are generated by tests/runtime-electron.cjs; not included in this public index.
