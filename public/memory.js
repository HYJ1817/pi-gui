import { S, ownsWorkspace } from './state.js';
import { restartBackend } from './api.js';
import { confirmModal } from './ui/modal.js';
import { toast } from './ui/toast.js';
import { createMemoryObservation, memorySetup, MEMORY_INSTALL_COMMAND, acceptMemoryEvent } from './memory-capabilities.js';
import { webSourceLink } from './web-activity.js';

const observation = createMemoryObservation();

/** SSE 入口：先过 workspace/run 守卫，再记「当前 Pi 真的调用过哪个 memory 工具」。 */
export function observeMemoryEvent(event) {
  if (!acceptMemoryEvent(event, S)) return;
  observation.observe(event, S.workspaceGeneration, S.bridgeRun);
}

function element(tag, content) { const n = document.createElement(tag); n.textContent = content; return n; }

export function renderMemorySetup(box, registry) {
  const state = memorySetup(registry);
  const observed = observation.snapshot(S.workspaceGeneration, S.bridgeRun);
  box.replaceChildren(element('h4', 'Pi Memory（长期记忆）'));
  box.appendChild(element('p', state.installed === true
    ? '已发现 pi-memory · 加载状态' + (state.loaded ? '已确认' : '未知')
    : state.installed === false ? '尚未发现 pi-memory' : 'Memory Extension 安装状态未知'));
  box.appendChild(element('p', '启用配置：' + (state.configured === true ? '已启用' : state.configured === false ? '已停用' : '未知')));
  box.appendChild(element('p', 'Runtime observed: ' + Object.entries(observed).map(([name, yes]) => `${name}: ${yes ? '已观察' : '尚未观察'}`).join(' · ')));
  box.appendChild(element('p', '长期记忆由 Pi Extension 提供并落在 Pi 自己的目录里；Pi GUI 不读取、不索引、不复制它，也不建立第二份数据库。绝对路径与记忆全文不进入 Activity。'));
  box.appendChild(element('p', '这不是「会话搜索」：会话搜索在当前项目的历史会话里找对话，Memory 工具检索的是 Extension 的长期记忆。两者不共享索引，也不会互相写入。'));
  box.appendChild(element('p', 'qmd 是 Extension 的可选依赖，Pi GUI 不安装、不配置、不检测系统包管理器；只有真实 tool result 报告 qmd 状态才展示。'));
  box.appendChild(element('p', '第三方 Extension 与 Pi 进程拥有同等系统权限，可读写文件、执行 shell 和访问网络；Memory 可能保存偏好、决策与项目事实。只安装可信代码。'));
  box.appendChild(element('code', MEMORY_INSTALL_COMMAND));
  const copy = element('button', '复制安装命令'); copy.className = 'btn tiny'; copy.type = 'button';
  copy.onclick = async () => { try { await navigator.clipboard.writeText(MEMORY_INSTALL_COMMAND); toast('已复制安装命令', 'info'); } catch { toast('复制失败，请手工复制上方命令', 'warn'); } };
  const restart = element('button', '安装后重启 Pi'); restart.className = 'btn tiny'; restart.type = 'button';
  restart.onclick = async () => {
    const generation = S.workspaceGeneration;
    const ok = await confirmModal({ title: '重启 Pi？', message: '请先在终端完成官方安装。重启会结束当前 Pi 运行并重新加载 Extension；Pi GUI 不安装 qmd，也不改动 Extension 配置。', okText: '重启 Pi' });
    if (!ok || !ownsWorkspace(generation)) return;
    restart.disabled = true;
    try { const result = await restartBackend(); if (ownsWorkspace(generation)) toast(result?.ok ? '正在重启 Pi' : '重启失败，可重试', result?.ok ? 'info' : 'warn'); }
    catch { if (ownsWorkspace(generation)) toast('重启失败，可重试', 'warn'); }
    finally { restart.disabled = false; }
  };
  box.append(copy, restart);
  box.appendChild(element('p', '在终端安装后重启 Pi，再刷新本页。当前没有 Memory Browser、编辑器或恢复入口：查看与恢复仍由 Pi / 模型通过 Extension 的工具完成。'));
  box.appendChild(webSourceLink({ url: 'https://github.com/jayzeng/pi-memory#readme', hostname: 'github.com', title: '查看 Extension 说明' }));
}
