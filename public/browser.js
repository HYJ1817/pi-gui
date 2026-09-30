/* Browser Use（真实浏览器自动化）的 Extensions 页设置区 + 运行观察。
 *
 * 立场与 P16/P18 一致：**Pi GUI 不发明 pi 没有的能力，也不假装保护用户。**
 *
 * 默认兼容 pi-browser-harness（原生 Pi Extension，经 CDP 驱动真实 Chrome）。
 * 它**没有**任何审批协议：源码里没有 `pi.on("tool_call")` 拦截，也没有
 * `ctx.ui.confirm`；`ctx.ui.select` 只出现在交互式 TUI 命令里，RPC 模式下
 * 返回 undefined。所以 GUI 侧**不提供**允许 / 拒绝按钮，也不宣称「已保护」——
 * 只如实说明「这些动作会直接发生」。 */
import { S, ownsWorkspace } from './state.js';
import { restartBackend } from './api.js';
import { confirmModal } from './ui/modal.js';
import { toast } from './ui/toast.js';
import {
  createBrowserObservation,
  browserSetup,
  BROWSER_INSTALL_COMMAND,
  BROWSER_EXTENSION_NAME,
  acceptBrowserEvent,
} from './browser-capabilities.js';
import { webSourceLink } from './web-activity.js';

const observation = createBrowserObservation();

/** SSE 入口：先过 workspace/run 守卫，再记「当前 Pi 真的调用过哪些 browser 工具」。 */
export function observeBrowserEvent(event) {
  if (!acceptBrowserEvent(event, S)) return;
  observation.observe(event, S.workspaceGeneration, S.bridgeRun);
}

function element(tag, content) { const n = document.createElement(tag); n.textContent = content; return n; }

export function renderBrowserSetup(box, registry) {
  const state = browserSetup(registry);
  const observed = observation.snapshot(S.workspaceGeneration, S.bridgeRun);
  box.replaceChildren(element('h4', 'Browser Use（真实浏览器自动化）'));
  box.appendChild(element('p', state.installed === true
    ? `已发现 ${BROWSER_EXTENSION_NAME} · 加载状态` + (state.loaded ? '已确认' : '未知')
    : state.installed === false ? `尚未发现 ${BROWSER_EXTENSION_NAME}` : 'Browser Extension 安装状态未知'));
  box.appendChild(element('p', '启用配置：' + (state.configured === true ? '已启用' : state.configured === false ? '已停用' : '未知')));
  box.appendChild(element('p', observed.any
    ? `当前 Pi 已观察到 ${observed.count} 个浏览器工具被调用（最近：${observed.names.join(' · ')}）`
    : '尚未观察到浏览器工具调用'));
  box.appendChild(element('p', '观察到工具名只说明「当前这次运行真的调用过它」，不构成「这个包已加载」的证据 —— 同名工具也可能来自别的 Extension。Pi RPC 没有权威的已注册工具清单。'));
  box.appendChild(element('p', 'Browser Use 与 Web Search 是两件事：Web Search 只做搜索与取正文，不驱动浏览器；Browser Use 会真的打开页面、点击、输入、截图。两者互相独立，各自的工具各自渲染。'));
  box.appendChild(element('p', '这些动作会直接发生，Pi GUI 拦不住它们：这个 Extension 没有审批协议，所以这里不提供允许 / 拒绝按钮，也不声称已保护。高风险动作（提交表单、购买、删除、发布、发送消息）请自己盯住页面。'));
  box.appendChild(element('p', 'Activity 只显示结构化字段（动作、主机名、计数）。输入框内容默认不显示，截图不自动上传，页面正文、控制台与网络记录不进 Activity。'));
  box.appendChild(element('p', '第三方 Extension 与 Pi 进程拥有同等系统权限，可访问网络、本地文件，并能控制你已登录的浏览器。只安装可信代码。'));
  box.appendChild(element('code', BROWSER_INSTALL_COMMAND));
  const copy = element('button', '复制安装命令'); copy.className = 'btn tiny'; copy.type = 'button';
  copy.onclick = async () => { try { await navigator.clipboard.writeText(BROWSER_INSTALL_COMMAND); toast('已复制安装命令', 'info'); } catch { toast('复制失败，请手工复制上方命令', 'warn'); } };
  const restart = element('button', '安装后重启 Pi'); restart.className = 'btn tiny'; restart.type = 'button';
  restart.onclick = async () => {
    const generation = S.workspaceGeneration;
    const ok = await confirmModal({ title: '重启 Pi？', message: '请先在终端完成官方安装。重启会结束当前 Pi 运行并重新加载 Extension；Pi GUI 不安装浏览器、不下载驱动、不改动 Extension 配置。', okText: '重启 Pi' });
    if (!ok || !ownsWorkspace(generation)) return;
    restart.disabled = true;
    try { const result = await restartBackend(); if (ownsWorkspace(generation)) toast(result?.ok ? '正在重启 Pi' : '重启失败，可重试', result?.ok ? 'info' : 'warn'); }
    catch { if (ownsWorkspace(generation)) toast('重启失败，可重试', 'warn'); }
    finally { restart.disabled = false; }
  };
  box.append(copy, restart);
  box.appendChild(element('p', '在终端安装后重启 Pi，再刷新本页。浏览器连接、Profile 与页面状态都由 Extension 自己管理：Pi GUI 不做浏览器 UI、不导入 Cookie、不管密码、不建下载中心，也不自动登录。'));
  box.appendChild(webSourceLink({ url: 'https://github.com/amankumarsingh77/pi-browser-harness#readme', hostname: 'github.com', title: '查看 Extension 说明' }));
}
