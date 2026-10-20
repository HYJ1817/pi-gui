# UI 细节收尾执行计划

基线：origin/main 3c7a8ac（v0.26.2）；工作分支 codex/ui-visual-finish。
按用户明确规格直接实施，单人完成，不添加依赖、不改模型或持久化协议。

1. 通知：复用 ui/toast.js 的会话归属，常规 info/success 默认不弹，显式操作入口可保留；重复可见错误不堆叠。扩展 notify 在当前 workspace/bridge 范围内有界保留于扩展页，Memory 的 qmd 提示同时进入 Memory 状态说明。日志只增加白名单结构事件，不保存原始通知。
2. 菜单：移除 Provider 装饰节点及上下文 summary 的伪元素，保留整行原生按钮、aria-expanded/controls、方向键与回调。选中只留中性对勾，hover 轻微，focus-visible 可见。
3. 导航：保留所有 DOM 消息锚点、内容偏移和 stream.scrollTo；可见短线与透明按钮分离，命中区 24×12px，固定可视容器内滚动，当前项自动露出，禁止通过压缩造成重叠。
4. 错误：去掉内外背景/边框/图标；保留标题、建议、原始详情与单一 alert。历史恢复不重复播报；沿用 retry/fallback。
5. 验证：先运行行为回归确认失败，再实现并运行相关现有套件；真实 Electron 验证鼠标、键盘、亮暗主题、500 条消息导航及截图；最后 npm test、build:app -- --rebuild、fixtures/app-check。记录实际失败与未运行项。

验收与风险记录单独写入最终报告。用户明确要求不使用子代理，独立 Agent 复审不运行。
