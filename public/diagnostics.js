/* 诊断摘要与按需故障排查详情（复用于日志与诊断）。
 *
 * ---------- 这一页的立场 ----------
 *
 * 它显示的是**已经脱敏**的后端快照（`GET /api/diagnostics`），加上**前端自己**
 * 观察到的一点点东西（schema 漂移环）。前端**不做第二遍判定**：
 * 快照里是什么就显示什么，缺字段就显示「未知」。
 *
 * P23 新增四块：能力 probe 表、兼容矩阵（我们声称验证过什么）、Native MCP 状态、
 * 关键 Extension 版本；另外多一个「复制诊断摘要」—— 一段给人读的纯文本，
 * 只由白名单字段拼出来，不含会话正文 / 配置内容 / 环境变量 / 凭据 / 绝对路径。
 */
import { fetchDiagnostics, fetchLogsStatus } from './api.js';
import { toast } from './ui/toast.js';
import { driftSnapshot } from './schema-drift.js';

function node(tag, cls = '', text = '') {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== '') n.textContent = String(text);
  return n;
}

function row(label, value, cls) {
  const r = node('div', 'diagnostic-row');
  const a = node('span', '', label);
  const b = node('b', '', value == null || value === '' ? '—' : value);
  if (cls) b.className = cls;
  r.append(a, b);
  return r;
}

function head(text) {
  return node('h4', 'diagnostic-heading', text);
}

function note(text) {
  return node('div', 'diag-note', text);
}

/* 能力的中文名。顺序即展示顺序（与后端 CAPABILITIES 一致）。 */
const CAP_LABEL = {
  rpc: 'RPC',
  getState: '会话状态',
  getMessages: '历史消息',
  newSession: '新会话',
  switchSession: '会话切换',
  sessionNaming: '会话重命名',
  toolEvents: 'Tool Events',
  extensionUi: '扩展 UI',
  sessionJsonl: '会话文件',
};

const COMPAT_STATUS = {
  compatible: '正常',
  partial: '部分兼容',
  unknown: '未知',
  incompatible: '不兼容',
};

/* probe / 能力三值 → 文案。**「未知」不是「不支持」** —— 这三句必须分得开。 */
const TRI_TEXT = { true: '支持', false: '不支持', null: '未知' };

/* 版本核对状态（P23）。「未核对」不是错误，只是「矩阵里还没有这个版本」。 */
const VERIFY_TEXT = {
  verified: '已核对',
  unverified: '未核对（矩阵里没有这个版本）',
  unknown: '版本未知',
  unchecked: '未接入兼容矩阵',
};

/* 原生 MCP 状态词汇（与 P20.6 状态机一一对应，只做展示翻译）。 */
const NATIVE_TEXT = {
  active: '生效中',
  replaced: '被扩展接管',
  disabled: '被设置停用',
  unsupported: '这个 pi 不带原生 MCP',
  unknown: '未知',
};

/* Extension 版本 vs 矩阵。 */
const EXT_STATUS_TEXT = { verified: '已核对', unverified: '未核对', unknown: '版本未知', unlisted: '未登记' };

function statusText(ok) {
  if (ok === true) return '正常';
  if (ok === false) return '异常';
  return '不适用';
}

const tri = (v) => (v === true ? '支持' : v === false ? '不支持' : '未知');

/**
 * 构造「诊断摘要」—— 一段可以直接贴进 issue 的纯文本。
 *
 * **只读白名单字段**（快照本身已经在后端脱敏过：secret / Bearer / sk- / 绝对路径
 * 都替换过）。这里**不拼任何原始 payload**：没有会话正文、没有工具输出、
 * 没有配置内容、没有环境变量。漂移记录只有来源 + 字段名 + 类型。
 *
 * @param d      `/api/diagnostics` 里的 `diagnostics` 对象（可空）
 * @param drift  `driftSnapshot()` 的结果（前端观察，可选）
 */
export function buildDiagnosticSummary(d, drift = [], logging = null) {
  if (!d || typeof d !== 'object') return '无法读取诊断信息。';
  const lines = [];
  const push = (label, value) => {
    if (value === undefined || value === null || value === '') return;
    lines.push(`${label}: ${value}`);
  };

  lines.push('Pi GUI 诊断摘要');
  push('生成时间', d.generatedAt);
  push('Pi GUI', d.app ? `v${d.app.version || '未知'}` : null);
  if (d.system) push('系统', [d.system.os, d.system.release, d.system.arch].filter(Boolean).join(' '));
  push('Node', d.system ? d.system.node : null);
  push('项目', d.project && d.project.selected ? (d.project.name || '已选择') : '未选择');

  const bridge = d.bridge || {};
  push('Bridge', d.project && d.project.selected
    ? `${bridge.piRunning ? '运行中' : '未运行'} · bridgeRun ${bridge.bridgeRun ?? '?'} · 参数 ${(bridge.args || []).join(' ')}`
    : '未选择项目');

  const pi = d.pi || {};
  push('pi', pi.version || (pi.available === false ? '不可用' : '未知'));
  push('pi 版本来源', pi.versionSource || '未知');
  if (pi.verification) {
    const v = pi.verification;
    const against = v.verifiedAgainst ? `（核对基线 ${v.verifiedAgainst.version} · ${v.verifiedAgainst.verifiedAt || '日期未知'}）` : '';
    push('版本核对', `${VERIFY_TEXT[v.status] || v.status || '未知'}${against}`);
  }
  if (pi.launch) {
    push('启动入口', `${pi.launch.source || '未知'} · ${pi.launch.binName || '未知'}`
      + ` · 入口解析=${pi.launch.entryKnown ? '是' : '否'} · 包目录绑定=${pi.launch.packageDirKnown ? '是' : '否'}`);
  }
  /* Pi 运行时的更新状态（Built-in Pi Updater）。
   * 与面板里那块说的是同一份快照 —— 摘要与面板**不许各说各的**，否则用户
   * 贴出来的报告和技术支持看到的界面就是两回事。只有相位、版本号与状态码，
   * 没有路径、没有 updater 输出（那些本来也不进快照）。 */
  const pu = d.piUpdate;
  if (pu) {
    const bits = [pu.phase || '未知'];
    if (pu.currentVersion || pu.latestVersion) {
      bits.push(`${pu.currentVersion || '未知'} → ${pu.latestVersion || '未知'}`);
    }
    if (pu.updateAvailable) bits.push(pu.canUpdate ? '可自动更新' : `不可自动更新${pu.reason ? '（' + pu.reason + '）' : ''}`);
    if (pu.running) bits.push('正在更新');
    else if (pu.cached) bits.push('来自缓存');
    if (pu.verification && pu.verification !== 'verified') bits.push(`未验收（${pu.verification}）`);
    if (pu.errorCode) bits.push(`错误码 ${pu.errorCode}`);
    push('Pi 更新', bits.join(' · '));
  }

  const c = d.compatibility;
  if (c) {
    push('兼容状态', COMPAT_STATUS[c.status] || c.status || '未知');
    push('已证实缺失', (c.missing || []).map((k) => CAP_LABEL[k] || k).join('、') || '无');
    push('未验证', (c.unverified || []).map((k) => CAP_LABEL[k] || k).join('、') || '无');
    if (c.protocol) push('信封契约', `期望 ${c.protocol.expected} / 观察到 ${c.protocol.observed ?? '未观察到'}`);
    const issues = Array.isArray(c.issues) ? c.issues : [];
    if (issues.length) {
      push('协议异常', `${issues.length} 条（最近 ${Math.min(5, issues.length)} 条）`);
      for (const i of issues.slice(-5)) lines.push(`  - ${i.operation || '?'} · ${i.issue || '?'}${i.field ? ' · ' + i.field : ''}`);
    }
    const sf = (c.schema && c.schema.unknownFields) || [];
    const se = (c.schema && c.schema.unknownEnums) || [];
    if (sf.length || se.length) {
      push('后端 schema 漂移', `${sf.length + se.length} 条`);
      for (const x of sf.slice(-5)) lines.push(`  - 未知字段 ${x.source}.${x.field}`);
      for (const x of se.slice(-5)) lines.push(`  - 未知枚举 ${x.source}.${x.field}`);
    }
  }

  const pr = d.probes;
  if (pr && Array.isArray(pr.items)) {
    const s = pr.summary || {};
    push('能力 probe', `共 ${s.total ?? pr.items.length} · 支持 ${s.supported ?? '?'} · 不支持 ${s.unsupported ?? '?'} · 未知 ${s.unknown ?? '?'}`);
    if (Array.isArray(s.unverified) && s.unverified.length) push('probe 尚未下结论', s.unverified.join('、'));
    for (const item of pr.items) lines.push(`  - ${item.id} · ${tri(item.state)}${item.evidence ? ' · ' + item.evidence : ''}`);
  } else if (d.probes === null) {
    push('能力 probe', '未接入');
  }
  if (pr && pr.error) push('能力 probe 出错', pr.error);

  const m = d.matrix;
  if (m) {
    push('当前验证基线', m.currentBaseline || '未登记');
    push('已验证 Pi 版本', (m.piBaselines || []).map((b) => b.version).join('、') || '未登记');
    push('已登记 Extension', (m.extensionBaselines || []).map((b) => `${b.name}@${b.version}`).join('、') || '未登记');
  }

  const native = d.mcp && d.mcp.native;
  if (native) {
    push('Native MCP', `${NATIVE_TEXT[native.state] || native.state || '未知'}`
      + ` · server ${native.serverCount ?? '未知'}`
      + ` · 项目信任 ${native.trust === null || native.trust === undefined ? '未知' : native.trust ? '已信任' : '未信任'}`);
  } else if (d.mcp) {
    push('MCP 能力', d.mcp.supported === true ? '检测到相关模块' : d.mcp.supported === false ? 'pi 无原生支持' : '未知');
  }

  const ext = d.extensions;
  if (ext && Array.isArray(ext.items)) {
    push('Extension 版本', `已发现 ${ext.discovered ?? ext.items.length} 个，其中有版本的 ${ext.items.length} 个`);
    for (const e of ext.items) lines.push(`  - ${e.name || '?'}@${e.version}（${e.scope === 'project' ? '项目' : '用户'}）`);
  }

  const checks = d.checks || [];
  if (checks.length) push('健康检查', checks.map((x) => `${x.id}=${statusText(x.ok)}`).join(' · '));
  const agents = d.agents || [];
  if (agents.length) push('Agent', agents.map((a) => `${a.id}=${a.available ? '可用' : '不可用'}${a.version ? '@' + a.version : ''}`).join(' · '));

  const driftList = Array.isArray(drift) ? drift : [];
  if (driftList.length) {
    push('前端 schema 漂移', `${driftList.length} 条`);
    for (const item of driftList) lines.push(`  - ${item.source}.${item.field} · ${item.kind} · ${item.type}`);
  }

  if (logging) {
    push('本地日志', `${logging.enabled ? '开启' : '关闭'} · ${logging.mode === 'verbose' ? '详细' : '标准'} · ${logging.fileCount ?? '未知'} 个文件 · ${logging.usageBytes ?? '未知'} B`);
    push('上次运行', logging.session?.previousUnclean ? '异常退出' : '正常或首次运行');
    for (const entry of (logging.recentErrors || []).slice(0, 8)) {
      if (entry?.timestamp && entry?.event) push('最近错误', [entry.timestamp, entry.level, entry.source, entry.event, entry.code].filter(Boolean).join(' · '));
    }
  }
  push('隐私', '不含会话正文 / 工具输出 / 配置内容 / 环境变量 / 凭据 / 绝对路径');
  return lines.join('\n');
}

/* 日志「引用到对话」的安全摘要。只使用 safeEntryText 同一套白名单字段
 * （时间·级别·来源·事件·代码），不携带 details JSON、正文或原始 payload；
 * 缺字段就省略，不编造「未知」。 */
export function buildLogReference(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const date = new Date(entry.timestamp);
  const stamp = Number.isFinite(date.getTime()) ? date.toISOString() : String(entry.timestamp || '未知时间');
  const lines = [`日志引用（${stamp}）`];
  if (entry.level) lines.push(`级别：${entry.level}`);
  if (entry.source) lines.push(`来源：${entry.source}`);
  if (entry.event) lines.push(`事件：${entry.event}`);
  if (entry.code) lines.push(`代码：${entry.code}`);
  return lines.join('\n');
}

export function downloadDiagnosticJSON(text) {
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

/** 版本来源与核对不是依赖安装检查，保留在按需故障排查详情中。 */
function renderVersionVerification(body, d) {
  const pi = d.pi || {};
  const rows = node('div', 'diagnostic-rows');
  rows.appendChild(row('pi', pi.version || (pi.available === false ? '不可用' : '未知（不影响兼容判定）')));
  rows.appendChild(row('版本来源', pi.versionSource || '未知（未接入规范探测）'));
  const v = pi.verification;
  rows.appendChild(row(
    '版本核对',
    v ? (VERIFY_TEXT[v.status] || v.status || '未知') : '未接入兼容矩阵',
    v && v.status === 'verified' ? '' : 'dim',
  ));
  if (v && v.verifiedAgainst) {
    rows.appendChild(row('核对基线', `${v.verifiedAgainst.version} · ${v.verifiedAgainst.verifiedAt || '日期未知'} · ${v.verifiedAgainst.scope || '范围未知'}`));
  } else if (v && v.status === 'unverified') {
    rows.appendChild(row('下一步', '这个版本的契约还没有逐项核对过 —— 见 docs/upgrade-playbook.md'));
  }
  body.appendChild(rows);
}

/** P23：能力 probe 表。每条带出处；未知的能力单独列出来。 */
function renderProbes(body, d, drift) {
  const pr = d.probes;
  body.appendChild(head('能力 probe'));
  if (!pr || !Array.isArray(pr.items)) {
    body.appendChild(note('没有接入 probe 表（后端未提供）。这不影响聊天与其它功能。'));
  } else {
    const s = pr.summary || {};
    body.appendChild(note(
      `共 ${s.total ?? pr.items.length} 条 · 支持 ${s.supported ?? '?'} · 不支持 ${s.unsupported ?? '?'} · 未知 ${s.unknown ?? '?'}`
      + (pr.at ? `（求值于 ${pr.at}）` : '')
      + (pr.packageKnown === false ? ' · 读不到本机 pi 包，源码类 probe 全部未知' : '')
    ));
    const rows = node('div', 'diagnostic-rows');
    for (const item of pr.items) {
      const text = `${tri(item.state)}${item.evidence ? ' · ' + item.evidence : ''}`;
      rows.appendChild(row(item.label || item.id, text, item.state === false ? 'warn' : item.state === null ? 'dim' : ''));
    }
    body.appendChild(rows);
    if (Array.isArray(s.unverified) && s.unverified.length) {
      body.appendChild(note('还没法下结论的核心 probe：' + s.unverified.join('、') + '（未知 ≠ 不支持）'));
    }
  }
  if (drift.length) {
    body.appendChild(note('前端观察到的 schema 漂移（只有来源 / 字段名 / 类型，没有值）：\n'
      + drift.map((x) => `${x.source}.${x.field} · ${x.kind} · ${x.type}`).join('\n')));
  }
  const schema = d.compatibility && d.compatibility.schema;
  if (schema && ((schema.unknownFields || []).length || (schema.unknownEnums || []).length)) {
    body.appendChild(note('后端观察到的 schema 漂移（同上，只有来源与字段名）：\n'
      + [...(schema.unknownFields || []).map((x) => `${x.source}.${x.field} · unknown-field`),
        ...(schema.unknownEnums || []).map((x) => `${x.source}.${x.field} · unknown-enum-value`)].join('\n')));
  }
}

/** P23：兼容矩阵 —— 「我们声称验证过什么」。只有版本号与日期。 */
function renderMatrix(body, d) {
  const m = d.matrix;
  body.appendChild(head('兼容矩阵（我们核对过什么）'));
  if (!m) {
    body.appendChild(note('没有接入兼容矩阵。'));
    return;
  }
  const rows = node('div', 'diagnostic-rows');
  rows.appendChild(row('当前验证基线', m.currentBaseline || '未登记'));
  for (const b of m.piBaselines || []) {
    rows.appendChild(row(`Pi ${b.version}`, `${b.scope === 'current' ? '当前基线' : '历史基线'} · 核对于 ${b.verifiedAt}`));
  }
  body.appendChild(rows);
  if ((m.extensionBaselines || []).length) {
    const ext = node('div', 'diagnostic-rows');
    for (const b of m.extensionBaselines) ext.appendChild(row(b.name, `${b.version} · 核对于 ${b.verifiedAt}`));
    body.appendChild(note('已登记的 Extension release（Pi GUI 依赖它们的契约，升级时照这些版本 diff）：'));
    body.appendChild(ext);
  }
  if ((m.knownDifferences || []).length) {
    body.appendChild(note('已知上游差异（升级时逐条复核）：\n'
      + m.knownDifferences.map((x) => `${x.id} · ${x.between} · 影响 ${x.affects}`).join('\n')));
  }
}

/** P23：Native MCP 状态 + 关键 Extension 版本。 */
function renderNativeAndExtensions(body, d) {
  const native = d.mcp && d.mcp.native;
  body.appendChild(head('Native MCP'));
  if (!native) {
    body.appendChild(note('尚未取到原生摘要（打开过一次 MCP 页 / 切过项目之后才会有）。没有摘要 ≠ 没有 server。'));
  } else {
    const rows = node('div', 'diagnostic-rows');
    rows.appendChild(row('原生状态', NATIVE_TEXT[native.state] || native.state || '未知', native.state === 'active' ? '' : 'dim'));
    rows.appendChild(row('server 条目', native.serverCount === null || native.serverCount === undefined ? '未知' : native.serverCount));
    rows.appendChild(row('项目信任', native.trust === null || native.trust === undefined ? '未知' : native.trust ? '已信任' : '未信任'));
    body.appendChild(rows);
    if (native.reason) body.appendChild(note(native.reason));
  }

  const ext = d.extensions;
  body.appendChild(head('关键 Extension 版本'));
  if (!ext) {
    body.appendChild(note('尚未做过扩展发现（打开过一次扩展页之后才会有）。没有记录 ≠ 没有装。'));
  } else if (!(ext.items || []).length) {
    body.appendChild(note(`发现 ${ext.discovered ?? 0} 个 Extension，其中没有读到可靠版本号的。`));
  } else {
    const rows = node('div', 'diagnostic-rows');
    for (const e of ext.items) {
      rows.appendChild(row(`${e.name || '?'}@${e.version}`, `${e.scope === 'project' ? '项目' : '用户'} · ${e.loaded === true ? '已加载' : e.loaded === false ? '未加载' : '加载未知'}`));
    }
    body.appendChild(rows);
    body.appendChild(note('只有 package.json 里读到版本号的才列出来；版本是否与兼容矩阵一致，见上面的矩阵一节。'));
  }
}

/** 挂入日志与诊断的按需详情；不创建页面、不挂载更新或安装组件。 */
export function renderDiagnosticDetails(body, d, drift = driftSnapshot()) {
  body.classList.add('diagnostic-details');
  /* ---------- P23：版本真值与核对状态 ---------- */
  body.appendChild(head('版本真值'));
  renderVersionVerification(body, d);

  /* ---------- Pi 兼容性（P4） ----------
   *
   * 三值要分清楚：**未验证 ≠ 不支持**。没验证过只说明还没用到那个能力，
   * 说成「不支持」是在冤枉上游。 */
  if (d.compatibility) {
    const c = d.compatibility;
    body.appendChild(head('Pi 兼容性'));

    const cap = node('div', 'diagnostic-rows');
    cap.appendChild(row('Pi 版本', c.versionKnown ? c.piVersion : '未知（不影响兼容判定）'));
    cap.appendChild(
      row(
        '兼容状态',
        COMPAT_STATUS[c.status] || c.status || '未知',
        c.status === 'compatible' ? '' : c.status === 'unknown' ? 'dim' : 'warn'
      )
    );
    for (const k of Object.keys(CAP_LABEL)) {
      const v = c.capabilities ? c.capabilities[k] : null;
      cap.appendChild(
        row(CAP_LABEL[k], v === true ? '支持' : v === false ? '不支持' : '未验证', v === false ? 'warn' : v === null ? 'dim' : '')
      );
    }
    body.appendChild(cap);

    const label = (k) => CAP_LABEL[k] || k;
    if ((c.missing || []).length) {
      body.appendChild(note('缺少能力（对应功能已降级）：' + c.missing.map(label).join('、')));
    }
    if ((c.unverified || []).length) {
      body.appendChild(note('尚未验证（还没用到，不代表不支持）：' + c.unverified.map(label).join('、')));
    }
    if ((c.issues || []).length) {
      /* 只列最近几条 —— 异常里**没有 payload**，只有操作名 / 字段名 / 类型。 */
      const recent = c.issues
        .slice(-5)
        .map((i) => `${i.operation || '?'} · ${i.issue || '?'}${i.field ? ' · ' + i.field : ''}`)
        .join('\n');
      body.appendChild(note(`最近的协议异常（共 ${c.issues.length} 条，只记结构与类型）：\n${recent}`));
    }
  }

  /* ---------- P23：能力 probe / 兼容矩阵 / Native MCP / Extension 版本 ---------- */
  renderProbes(body, d, drift);
  renderMatrix(body, d);
  renderNativeAndExtensions(body, d);

  body.appendChild(head('健康检查'));
  const checks = node('div', 'diagnostic-rows');
  for (const check of d.checks || []) checks.appendChild(row(check.id, statusText(check.ok)));
  body.appendChild(checks);

  body.appendChild(head('Agent'));
  const agents = node('div', 'diagnostic-rows');
  if (!(d.agents || []).length) {
    agents.appendChild(row('Agent', '未检测到'));
  } else {
    for (const a of d.agents) {
      const status = a.available ? ['可用', a.version].filter(Boolean).join(' · ') : ['不可用', a.reason].filter(Boolean).join(' · ');
      agents.appendChild(row(a.id, status));
    }
  }
  body.appendChild(agents);

}

/** 兼容旧模块调用；只转交唯一日志页面，不保留旧诊断页面实现。 */
export async function openDiagnostics(options = {}) {
  if (!options.present) {
    const intent = new CustomEvent('pi-gui:open-logs', { cancelable: true, detail: { initialTab: 'export' } });
    if (!document.dispatchEvent(intent)) return;
  }
  const { openLogs } = await import('./logs.js');
  return openLogs({ ...options, initialTab: 'export' });
}

/**
 * 直接复制诊断摘要（行内命令与设置页共用）。
 *
 * **复用同一条链路**：`/api/diagnostics` → `buildDiagnosticSummary` → 剪贴板。
 * 不重新拼一遍文本，也不新增数据源 —— 面板里那个按钮与这里拿到的是同一份东西。
 * 取不到快照时如实说失败，不静默。
 */
export async function copyDiagnosticsSummary() {
  const [payload, logs] = await Promise.all([fetchDiagnostics(), fetchLogsStatus()]);
  const d = payload && payload.ok !== false ? payload.diagnostics : null;
  if (!d) {
    toast('无法读取诊断信息，请到日志与诊断重试。', 'error');
    return { ok: false };
  }
  const text = buildDiagnosticSummary(d, driftSnapshot(), logs?.ok ? logs.status : null);
  try {
    await navigator.clipboard.writeText(text);
    toast('诊断摘要已复制（不含正文与凭据）', 'info');
    return { ok: true, text };
  } catch {
    toast('复制失败，请到日志与诊断展开 JSON 手工选中。', 'warn');
    return { ok: false, text };
  }
}
