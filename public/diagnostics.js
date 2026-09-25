import { fetchDiagnostics } from './api.js';
import { openModal } from './ui/modal.js';
import { toast } from './ui/toast.js';

function node(tag, cls = '', text = '') {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== '') n.textContent = String(text);
  return n;
}

function row(label, value) {
  const r = node('div');
  const a = node('span', '', label);
  const b = node('b', '', value == null || value === '' ? '—' : value);
  r.append(a, b);
  return r;
}

function statusText(ok) {
  if (ok === true) return '正常';
  if (ok === false) return '异常';
  return '不适用';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('诊断信息已复制', 'info');
  } catch {
    toast('复制失败，请手工选中', 'warn');
  }
}

function downloadJSON(text) {
  try {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pi-gui-diagnostics.json';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    toast('诊断文件已导出', 'info');
  } catch {
    toast('导出失败，请使用复制诊断 JSON', 'warn');
  }
}

function render(card, close, payload) {
  card.innerHTML = '';
  const d = payload?.diagnostics;
  const h = node('h3', '', '诊断');
  card.appendChild(h);

  if (!payload || payload.ok === false || !d) {
    card.appendChild(node('div', 'modal-desc', payload?.error || '无法读取诊断信息'));
    const actions = node('div', 'modal-actions');
    const done = node('button', 'btn primary', '关闭');
    done.type = 'button';
    done.onclick = close;
    actions.appendChild(done);
    card.appendChild(actions);
    return;
  }

  card.appendChild(
    node(
      'div',
      'modal-desc',
      '这里只显示适合用于故障排查的信息。绝对路径、会话正文、配置文件内容和环境变量不会包含在结果里，常见 token / API key 会再次脱敏。'
    )
  );

  const rows = node('div', 'stat-rows');
  rows.append(
    row('Pi GUI', d.app?.version),
    row('系统', [d.system?.os, d.system?.release, d.system?.arch].filter(Boolean).join(' ')),
    row('Node', d.system?.node),
    row('项目', d.project?.selected ? d.project?.name || '已选择' : '未选择'),
    row('pi', d.pi?.available === false ? '不可用' : d.pi?.version || (d.pi?.available ? '可用' : '未知')),
    row('Bridge', d.project?.selected ? (d.bridge?.piRunning ? '运行中' : '未运行') : '未选择项目'),
    row('MCP', d.mcp?.supported === true ? '检测到相关模块' : d.mcp?.supported === false ? 'pi 无原生支持' : '未知')
  );
  card.appendChild(rows);

  const title = node('div', 'ext-sec-head', '健康检查');
  card.appendChild(title);
  const checks = node('div', 'stat-rows');
  for (const check of d.checks || []) checks.appendChild(row(check.id, statusText(check.ok)));
  card.appendChild(checks);

  const agentsTitle = node('div', 'ext-sec-head', 'Agent');
  card.appendChild(agentsTitle);
  const agents = node('div', 'stat-rows');
  if (!(d.agents || []).length) {
    agents.appendChild(row('Agent', '未检测到'));
  } else {
    for (const a of d.agents) {
      const status = a.available ? ['可用', a.version].filter(Boolean).join(' · ') : ['不可用', a.reason].filter(Boolean).join(' · ');
      agents.appendChild(row(a.id, status));
    }
  }
  card.appendChild(agents);

  const jsonTitle = node('div', 'ext-sec-head', '脱敏后的诊断 JSON');
  card.appendChild(jsonTitle);
  const pre = node('pre', 'ext-code', JSON.stringify(d, null, 2));
  pre.style.maxHeight = '240px';
  card.appendChild(pre);

  const actions = node('div', 'modal-actions');
  const copy = node('button', 'btn', '复制诊断 JSON');
  copy.type = 'button';
  copy.onclick = () => copyText(pre.textContent || '');
  const download = node('button', 'btn', '导出 JSON');
  download.type = 'button';
  download.onclick = () => downloadJSON(pre.textContent || '');
  const refresh = node('button', 'btn', '刷新');
  refresh.type = 'button';
  refresh.onclick = () => loadInto(card, close);
  const done = node('button', 'btn primary', '关闭');
  done.type = 'button';
  done.onclick = close;
  actions.append(copy, download, refresh, done);
  card.appendChild(actions);
}

async function loadInto(card, close) {
  card.innerHTML = '';
  card.appendChild(node('h3', '', '诊断'));
  card.appendChild(node('div', 'modal-desc', '正在读取运行状态…'));
  const payload = await fetchDiagnostics();
  if (!card.isConnected) return;
  render(card, close, payload);
}

export function openDiagnostics() {
  openModal((card, close) => {
    loadInto(card, close);
  });
}
