# 阶段 F：浅色与全局视觉收尾实施计划

基线 `5d8d9d02f5f760a17bca3f61042872bba6c85dac`，独立分支 `codex/pi-desktop-phase-f`。main push CI [42016791631](https://github.com/HYJ1817/pi-gui/actions/runs/42016791631) / attempt 1 / completed-success 已实查。固定参考仍为 `92ae661f1e399e69d514086b46029b4c34ba1a92`。

按 writing-plans / executing-plans 在本会话实施；沿用已选 PI-Desktop 设计，无需重做设计方向审批，不使用子代理，不推送、合并或发版。Jev 路由为 frontend、建议测试，作者仍按中风险 UI 变更验证。

## 勘察与边界

- `theme-init.js`、`theme.js`、`electron/theme.cjs` 已拥有首屏、偏好、持久化、system 与原生窗口按钮同步。原状态与 IPC 不改。
- A 的 `tokens.css` 已有完整深浅语义变量；C/D/E 的主画布、侧栏、Composer、工作台均消费已有变量，不再增加主题系统。
- `ui/inline-command-menu.js:position` 已按输入区与原生右栏计算宽度；`ui3-inline-commands.css` 的 320px 上限却把菜单再次截窄。参考 `styles/composer-autocomplete.css:1–33` 明确为完整 Composer 宽度。只去除 CSS 上限，保留定位、键盘、IME、生命周期和业务候选。
- `styles.css` 在 `ui/primitives.css` 后加载，重复 `.ds-switch` 和浅色高优先级规则覆盖原语的轨道、白色滑钮及细环。当前生产调用检索仅找到原语定义，没有业务实例；删除重复规则并用生产原语做真实 Electron 组件级验证，不向设置页增加假开关。
- 外观状态的 `--ds-error-text` / `--ds-warning-text` 未定义，落到浅红/亮黄；改为已有 `--ui-danger` / `--ui-warning`。供应商按钮与 Composer 浮层继续使用既有中性色语义变量。
- 真实浅色设置截图发现分组标题使用 faint；参考 `styles/settings.css:240–247` 是 muted。新增检查复现 `rgb(175,175,175)`，仅改原 `.settings-menu h3` 的令牌消费。
- REF-021/022/023 可按实际会话、命令与用量入口验收。当前 Composer 只绑定 slash，没有 REF-024 的 `@` 文件补全入口或状态所有者，未找到对应端到端接线；不从旧路线图推断已存在，不新增文件检索业务、不伪造菜单。保留原 `@` 草稿并验证真实附件托盘，明确未实现。
- 参考浅色之外页面只做源码规范与渲染核对；不宣称不存在的原始浅色设置/工作台截图对比。

## 任务与验证顺序

- [x] 准确基线与必要定向基线：theme 47/47、settings 15/15、inline 46/46、UI3 integration 23/23、split 30/30。
- [x] 扩展现有正常沙箱 `app-shell-electron.cjs`，新增 `fixtures/theme-convergence-scenarios.cjs` 与独立入口 `tests/theme-convergence-electron.cjs`；注册专项 alias，不复制 canonical 清单。
- [x] 先在未改生产样式时运行专项，84/92 复现宽度、文字与原语覆盖；保留脚本错误、产品失败及后续收敛历史。
- [x] 仅修改 `styles.css`、`ui3-inline-commands.css`、`ui3-model.css`：删除冲突开关样式；状态/按钮/浮层复用语义变量；菜单宽度由原模块的行内测量决定。额度警告被中性选择器覆盖的问题也已回归修复。
- [x] 正常沙箱最终 97/97，66 张 renderer + 7 张原生整窗；UI3 最终 243/243。按 CSS 1205×803 / DPR 1.5 核对 REF-021–023；REF-024 按未实现记录，实际只拍摄普通 `@` 草稿与真实附件流程。
- [x] 完成冻结状态的 canonical 累计验证：原 `npm test` 清单前 159 条正常结束，第 160 条端口占用失败后按原清单续跑 75 条均退出 0，合计 234 条唯一命令成功。保留首轮中断、第二轮失败、跳过及日志转码限制，不声称单次完整 `npm test` 退出 0。离线重建，包内生产样式 3/3 摘要一致。
- [x] 作者自查、交付 [19 验收报告](19-phase-f-acceptance.md)、逐区域差异、73 张实际图及验证身份。独立复审未运行，等待用户验收。

生产样式目标使用原模块已有变量，例如 `.appearance-status.is-warning { color: var(--ui-warning); }`；菜单 `max-width: calc(100vw - 16px)` 只约束视口，实际宽度继续使用原 `position()` 写入值。专项必须检查实际 DOM/CSS，例如 `Math.abs(menu.width - input.width) <= 1`，而非复制定位算法。

完整命令：`node tests/theme.cjs`、`node tests/settings-acceptance.cjs`、`node tests/ui3-inline-commands.cjs`、`node tests/ui3-integration.cjs`、`node tests/split-workbench-ui.cjs`、`npm run test:theme-convergence:electron`、`npm run test:ui3`、`npm test`、`npm run build:app -- --rebuild --output-root <独立产物目录>`。测试仅用 TEMP 和离线夹具。
