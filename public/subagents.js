import { S, ownsWorkspace } from './state.js';
import { restartBackend } from './api.js';
import { confirmModal } from './ui/modal.js';
import { toast } from './ui/toast.js';
import { createSubagentObservation, subagentSetup, SUBAGENT_INSTALL_COMMAND, acceptSubagentEvent } from './subagent-capabilities.js';
import { webSourceLink } from './web-activity.js';
const observation = createSubagentObservation();
export function observeSubagentEvent(event) {
  if (!acceptSubagentEvent(event, S)) return;
  observation.observe(event, S.workspaceGeneration, S.bridgeRun);
}
function element(tag, content) { const n = document.createElement(tag); n.textContent = content; return n; }
export function renderSubagentSetup(box, registry) {
  const state = subagentSetup(registry);
  const observed = observation.snapshot(S.workspaceGeneration, S.bridgeRun);
  box.replaceChildren(element('h4', 'Subagents'));
  box.appendChild(element('p', state.installed === true ? '已发现 pi-subagents' : state.installed === false ? '尚未发现 pi-subagents' : 'Subagent Extension 安装状态未知'));
  box.appendChild(element('p', '启用配置：' + (state.configured === true ? '已启用' : state.configured === false ? '已停用' : '未知') + ' · 加载状态：' + (state.loaded ? '已确认' : '未知')));
  box.appendChild(element('p', Object.entries(observed).map(([name, yes]) => `${name}: ${yes ? '当前 Pi 已观察到调用' : '尚未观察到调用'}`).join(' · ')));
  box.appendChild(element('p', '仅观察到 subagents_enable 时不代表安装失败；它只激活后续模型请求的工具，不启动 child。其他 Extension 也可提供同名工具。'));
  box.appendChild(element('p', '子会话隔离不是系统沙箱。第三方 Extension 与 Pi 拥有同等权限，可读写文件、运行 shell 和访问网络；后台任务可独立运行。只安装可信代码。'));
  box.appendChild(element('code', SUBAGENT_INSTALL_COMMAND));
  const copy = element('button', '复制安装命令'); copy.className = 'btn tiny'; copy.type = 'button';
  copy.onclick = async () => { try { await navigator.clipboard.writeText(SUBAGENT_INSTALL_COMMAND); toast('已复制安装命令', 'info'); } catch { toast('复制失败，请手工复制上方命令', 'warn'); } };
  const restart = element('button', '安装后重启 Pi'); restart.className = 'btn tiny'; restart.type = 'button';
  restart.onclick = async () => {
    const generation = S.workspaceGeneration;
    const ok = await confirmModal({ title: '重启 Pi？', message: '请先在终端完成安装。重启会结束当前 Pi 运行并重新加载 Extension；独立后台任务不由 GUI 终止。', okText: '重启 Pi' });
    if (!ok || !ownsWorkspace(generation)) return;
    restart.disabled = true;
    try { const result = await restartBackend(); if (ownsWorkspace(generation)) toast(result?.ok ? '正在重启 Pi' : '重启失败，可重试', result?.ok ? 'info' : 'warn'); }
    catch { if (ownsWorkspace(generation)) toast('重启失败，可重试', 'warn'); }
    finally { restart.disabled = false; }
  };
  box.append(copy, restart);
  box.appendChild(element('p', '在终端安装后重启 Pi，再刷新本页。Agent 定义、模型与凭据由 Extension / Pi 管理。GUI 不安装、不扫描 Agent、不控制子进程。'));
  box.appendChild(webSourceLink({ url: 'https://github.com/nicobailon/pi-subagents#readme', hostname: 'github.com', title: '查看 Extension 说明' }));
}
