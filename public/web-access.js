import { S, ownsWorkspace } from './state.js';
import { restartBackend } from './api.js';
import { confirmModal } from './ui/modal.js';
import { toast } from './ui/toast.js';
import { createWebObservation, webSetup, WEB_INSTALL_COMMAND } from './web-capabilities.js';
import { webSourceLink } from './web-activity.js';
const observation = createWebObservation();
export function observeWebEvent(event) {
  // The old run may still emit while workspace activation awaits the new bridge.
  if (S.switching && /^tool_execution_/.test(event?.type || '')) return;
  observation.observe(event, S.workspaceGeneration, S.bridgeRun);
}
function element(tag, content) { const n = document.createElement(tag); n.textContent = content; return n; }
export function renderWebSetup(box, registry) {
  const state = webSetup(registry);
  const observed = observation.snapshot(S.workspaceGeneration, S.bridgeRun);
  box.replaceChildren(element('h4', 'Web Access'));
  box.appendChild(element('p', state.installed === true ? '已发现 pi-web-access · 加载状态' + (state.loaded ? '已确认' : '未知') : state.installed === false ? '尚未发现 pi-web-access' : 'Web Extension 安装状态未知'));
  box.appendChild(element('p', '启用配置：' + (state.configured === true ? '已启用' : state.configured === false ? '已停用' : '未知')));
  box.appendChild(element('p', Object.entries(observed).map(([name, yes]) => `${name}: ${yes ? '当前 Pi 已观察到调用' : '尚未观察到调用'}`).join(' · ')));
  box.appendChild(element('p', '其他 Extension 也可提供这些工具。磁盘发现不代表工具已注册。配置与凭据由 Extension 管理。'));
  box.appendChild(element('p', '第三方 Extension 与 Pi 进程拥有同等系统权限，可访问网络和本地资源；只安装你信任的代码。'));
  box.appendChild(element('code', WEB_INSTALL_COMMAND));
  const copy = element('button', '复制安装命令'); copy.className = 'btn tiny'; copy.type = 'button';
  copy.onclick = async () => { try { await navigator.clipboard.writeText(WEB_INSTALL_COMMAND); toast('已复制安装命令', 'info'); } catch { toast('复制失败，请手工复制上方命令', 'warn'); } };
  const restart = element('button', '安装后重启 Pi'); restart.className = 'btn tiny'; restart.type = 'button';
  restart.onclick = async () => {
    const generation = S.workspaceGeneration;
    const ok = await confirmModal({ title: '重启 Pi？', message: '请先在终端完成官方安装。重启会结束当前 Pi 会话运行，并重新加载 Extension。', okText: '重启 Pi' });
    if (!ok || !ownsWorkspace(generation)) return;
    restart.disabled = true;
    try { const result = await restartBackend(); if (ownsWorkspace(generation)) toast(result?.ok ? '正在重启 Pi' : '重启失败，可重试', result?.ok ? 'info' : 'warn'); }
    catch { if (ownsWorkspace(generation)) toast('重启失败，可重试', 'warn'); }
    finally { restart.disabled = false; }
  };
  box.append(copy, restart);
  box.appendChild(element('p', '在终端执行安装后，重启 Pi，再刷新本页。供应商配置与凭据由 Extension 管理。'));
  box.appendChild(webSourceLink({ url: 'https://github.com/nicobailon/pi-web-access#readme', hostname: 'github.com', title: '查看 Extension 配置说明' }));
}
