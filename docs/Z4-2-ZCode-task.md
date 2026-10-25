# 可独立复制的 ZCode 任务包

你负责 pi-GUI Z4-2 Z1–Z4 独立画布和建议组件。此文件是可复制任务包，不表示 ZCode 已被调用；若由内置协作 Agent 执行，必须记录实际身份。

只在独立 Worktree、分支 `zcode/z4-2-canvas` 工作，起点 `0f2340ee6bfd492bc5dea4adb2008bb7cbe40b0f`。先读 AGENTS.md、REVIEW.md、docs/README.md、docs/Z4-2-contract.md、Z4-1 设计、work-surfaces/coding-style、public/viz-panel.js、secondary-surface/split-workbench。按契约实现，不擅自改共享协议。

独占文件 `public/collab-canvas.js`、`public/collab-proposal.js`、`public/collab.css`、`tests/collab-canvas.cjs`。不改 app.js/index.html/api.js/package.json、数据模块或生产入口。使用原生 SVG+DOM，无依赖、无 innerHTML、脚本执行或 HTTP/文件系统调用。风格沿当前灰阶主题，不重设计外壳。

实现冻结工厂 mountCollabCanvas 与 mountCollabProposal。画布支持节点/有向边渲染、选择、拖动、文字编辑、新增/删除节点、连线增删、缩放平移、选中态、受控 undo/redo、只读/忙/错误状态。只发 [{type,params}] 操作意图；上层掌握 document、revision、actor、幂等与持久化。拖动只在结束发一次；删除节点确认后一次批次先删除引用边。键盘可操作、编辑焦点正确、防拖动误点击、长文本、窄栏、深浅主题、destroy 清理监听。不可在组件保存另一份权威图数据。

建议组件 update 只渲染版本、rationale、逐操作 diff、冲突/失败，绝不能应用。只有点击接受/拒绝/重新生成才调用上层回调。空建议有诚实空状态；fixtures 必须与生产数据形状一致。

先用 jsdom/DOM 定向测试初始三节点两边、新增/文字/拖动、边增删、undo/redo 回调、建议只读预览/接受/拒绝、只读、非法输入、历史清空投影、销毁重开、100 节点。输出真实断言数和退出码；jsdom 不代表布局通过。生产挂载后的 Electron 统一由 Codex 跑，不伪造截图，不运行全量 npm test/共享构建、不联网下载或调用模型、不写用户真实数据。

交付中文独立提交（Git 元数据 COMMIT_MSG_TMP.txt + commit -F）、准确 SHA、文件、测试命令/退出码/断言数、已知限制。不得 push/PR/merge/tag/release。接口变化交 Codex 决定；不覆盖后端或主 Agent 文件。
