/* 扩展面板：Skills 与 MCP。
 *
 * ---------- 这个面板的立场 ----------
 *
 * **Pi GUI 不发明 pi 没有的扩展机制。** 所以这里看到的每一个状态都能追到出处：
 *
 *   - 「有哪些 skill」= 后端按 pi 的发现规则扫文件系统（4 个根 + settings 条目）；
 *   - 「哪些真的生效」= 问 pi 自己（RPC get_commands）—— 这一条**不由 Pi GUI 判断**，
 *     因为只有 pi 知道它到底加载了什么（信任闸门、同名冲突、package 里的 skill…）；
 *   - 「MCP」= pi 原生集成的管理面（P20.6）：原生状态（active / replaced /
 *     disabled / unknown，只认证据）+ 两处 mcp.json 的安全结构解析 +
 *     `pi mcp list --json` 的运行时状态（显式刷新才跑）+ 受控动作
 *     （add / remove / login / logout 经 pi 官方 CLI；enable 等走 /mcp TUI）。
 *
 * 界面上因此有三件事必须说清楚，不能省：
 *   1. `loaded` 与 `state` 是两回事。磁盘上有 ≠ pi 加载了。pi 没运行时 loaded 是 null，
 *      显示「无法确认」而不是「未启用」。
 *   2. 项目级资源在 pi 的非交互模式下默认**不加载**（信任闸门）。不说明这一点，
 *      用户只会觉得「我明明放了 skill 怎么没用」。
 *   3. 启停写的是 pi 的 settings.json，而 pi 只在启动时读它 → 必须重启 pi。
 *
 * ---------- 与后端的分工 ----------
 *
 * 前端只拿得到稳定 ID（路径的 sha1 前 16 位）。**没有任何一处把路径发回后端** ——
 * 后端在自己的索引里按 ID 查真实路径。所以这里不需要、也不应该做路径校验。
 */
import { S, ownsWorkspace } from './state.js';
import { fetchSkills, fetchSkillDetail, setSkillEnabled, fetchMcp, fetchMcpServers, refreshMcpStatus, mcpServerAction, fetchExtensions, fetchApprovalCapability, restartBackend } from './api.js';
import { confirmModal } from './ui/modal.js';
import { openWorkSurface } from './ui/workspace-surface.js';
import { toast } from './ui/toast.js';
import { renderWebSetup } from './web-access.js';
import { renderSubagentSetup } from './subagents.js';
import { renderMemorySetup } from './memory.js';
import { renderBrowserSetup } from './browser.js';
import { renderApprovalSetup } from './approval.js';
import { snapshotMcpObservation } from './mcp-observer.js';

/* 状态 → 展示用的圆点与文案。
 * 键必须与 server/skills.js 里 state 的取值一一对应，多一个少一个都会显示成原始英文。 */
const STATE_META = {
  enabled: { dot: 'on', label: '已启用' },
  disabled: { dot: 'off', label: '已停用' },
  untrusted: { dot: 'warn', label: '未加载（项目未信任）' },
  invalid: { dot: 'err', label: '无法加载' },
  shadowed: { dot: 'warn', label: '被同名覆盖' },
  'not-loaded': { dot: 'warn', label: 'pi 未加载' },
  unknown: { dot: 'dim', label: '状态未知' },
};

const SCOPE_LABEL = { user: '用户', project: '项目', temporary: '临时' };

function stateMeta(state) {
  return STATE_META[state] || { dot: 'dim', label: state || '未知' };
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function row(label, value) {
  const r = el('div', 'ext-row');
  r.appendChild(el('span', 'ext-row-k', label));
  const v = el('span', 'ext-row-v', value);
  v.title = String(value);
  r.appendChild(v);
  return r;
}

function note(text, kind = '') {
  return el('div', 'cfg-note' + (kind ? ' ' + kind : ''), text);
}

/** 复制到剪贴板。失败不抛 —— 有些环境下剪贴板 API 不可用。 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制', 'info');
  } catch {
    toast('复制失败，请手工选中', 'warn');
  }
}

function copyBtn(text, label = '复制路径') {
  const b = el('button', 'btn tiny', label);
  b.type = 'button';
  b.onclick = () => copyText(text);
  return b;
}

/* ---------- Skills 标签页 ---------- */

function skillsTab(card, isCurrent) {
  const wrap = el('div', 'ext-skills');

  // 工具栏
  const bar = el('div', 'ext-bar');
  const search = el('input', 'ext-search');
  search.type = 'search';
  search.placeholder = '搜索名称 / 描述 / 路径…';

  const selScope = el('select', 'ext-sel');
  for (const [v, t] of [['', '全部作用域'], ['project', '项目'], ['user', '用户'], ['temporary', '临时']]) {
    const o = el('option', '', t);
    o.value = v;
    selScope.appendChild(o);
  }
  const selState = el('select', 'ext-sel');
  for (const [v, t] of [['', '全部状态'], ['enabled', '已启用'], ['off', '未启用'], ['problem', '有问题']]) {
    const o = el('option', '', t);
    o.value = v;
    selState.appendChild(o);
  }

  const btnRefresh = el('button', 'btn tiny', '刷新');
  btnRefresh.type = 'button';

  bar.append(search, selScope, selState, btnRefresh);
  wrap.appendChild(bar);

  const summary = el('div', 'ext-summary');
  wrap.appendChild(summary);

  const split = el('div', 'ext-split');
  const listBox = el('div', 'ext-list');
  const detailBox = el('div', 'ext-detail');
  split.append(listBox, detailBox);
  wrap.appendChild(split);
  card.appendChild(wrap);

  let data = null;
  let selectedId = '';
  let detailSeq = 0;

  const filtered = () => {
    if (!data) return [];
    const q = search.value.trim().toLowerCase();
    return (data.skills || []).filter((s) => {
      if (selScope.value && s.scope !== selScope.value) return false;
      if (selState.value === 'enabled' && s.state !== 'enabled') return false;
      if (selState.value === 'off' && s.state === 'enabled') return false;
      if (selState.value === 'problem' && !['untrusted', 'invalid', 'shadowed', 'not-loaded'].includes(s.state)) return false;
      if (!q) return true;
      return (
        String(s.name).toLowerCase().includes(q) ||
        String(s.description).toLowerCase().includes(q) ||
        String(s.path).toLowerCase().includes(q) ||
        String(s.rootLabel).toLowerCase().includes(q)
      );
    });
  };

  async function showDetail(skill) {
    const seq = ++detailSeq;
    const generation = S.workspaceGeneration;
    detailBox.innerHTML = '';
    if (!skill) {
      detailBox.appendChild(el('div', 'ext-empty', '选一个 Skill 看详情'));
      return;
    }
    const meta = stateMeta(skill.state);
    detailBox.appendChild(el('h4', '', skill.name));
    const badge = el('div', 'ext-badges');
    badge.appendChild(el('span', 'ext-dot ' + meta.dot));
    badge.appendChild(el('span', 'ext-badge', meta.label));
    badge.appendChild(el('span', 'ext-badge', SCOPE_LABEL[skill.scope] || skill.scope));
    if (skill.source === 'local') badge.appendChild(el('span', 'ext-badge', '来自 settings'));
    if (skill.disableModelInvocation) badge.appendChild(el('span', 'ext-badge', '不进系统提示词'));
    detailBox.appendChild(badge);

    if (skill.description) detailBox.appendChild(el('p', 'ext-desc', skill.description));
    if (skill.stateNote) detailBox.appendChild(note(skill.stateNote, skill.state === 'enabled' ? 'dim' : 'warn'));
    for (const e of skill.errors || []) detailBox.appendChild(note(e.message, e.level === 'error' ? 'warn' : 'dim'));

    const rows = el('div', 'ext-rows');
    rows.appendChild(row('路径', skill.path || '（未定位）'));
    rows.appendChild(row('发现来源', skill.rootLabel));
    rows.appendChild(row('作用域基准', skill.baseDir));
    rows.appendChild(row('pi 是否加载', skill.loaded === null ? '无法确认（pi 未运行）' : skill.loaded ? '是' : '否'));
    if (skill.rel) rows.appendChild(row('停用模式', skill.disablePattern));
    if (skill.settingsPath) rows.appendChild(row('设置写入', skill.settingsPath));
    if (skill.license) rows.appendChild(row('许可证', skill.license));
    if (skill.compatibility) rows.appendChild(row('兼容性', skill.compatibility));
    detailBox.appendChild(rows);

    /* 启停。
     * 只在「能写」的时候给按钮：temporary（命令行 --skill）与 package 里的 skill
     * 没有可写的 settings 条目 —— 给一个点了没反应的开关比不给更糟。 */
    const acts = el('div', 'ext-acts');
    if (skill.toggleable) {
      const isOn = skill.state === 'enabled' || (skill.loaded === true && !skill.disabledBy);
      const btn = el('button', 'btn tiny ' + (isOn ? '' : 'primary'), isOn ? '停用' : '启用');
      btn.type = 'button';
      btn.onclick = async () => {
        const want = !isOn;
        const ok = await confirmModal({
          title: want ? '启用这个 Skill？' : '停用这个 Skill？',
          message: want
            ? `会从 ${skill.settingsPath} 里删掉一条停用规则（${skill.disablePattern}）。不会改动 skill 文件本身。`
            : `会往 ${skill.settingsPath} 里加一条规则（${skill.disablePattern}）。不会删除或移动 skill 文件 —— 只是让 pi 不再加载它。`,
          okText: want ? '启用' : '停用',
        });
        if (!ok || !isCurrent()) return;
        btn.disabled = true;
        const r = await setSkillEnabled(skill.id, want);
        if (!isCurrent()) return;
        btn.disabled = false;
        if (!r.ok) {
          toast(r.error || '操作失败', 'error');
          return;
        }
        for (const w of r.warnings || []) toast(w, 'warn');
        if (r.restartRequired) {
          const go = await confirmModal({
            title: '需要重启 pi 才生效',
            message: 'pi 只在启动时读 settings.json，所以这个改动要等 pi 重新启动才起作用。现在就重启吗？（当前会话会被恢复）',
            okText: '重启 pi',
          });
          if (go && isCurrent()) {
            await restartBackend();
            toast('已请求重启 pi，稍等一下', 'info');
          }
        } else {
          toast('设置没有变化', 'info');
        }
        await load(true);
      };
      acts.appendChild(btn);
    } else {
      acts.appendChild(
        note(
          skill.scope === 'temporary'
            ? '这个 Skill 是通过命令行 --skill 临时加载的，没有可写的 settings 条目。'
            : '这个 Skill 没有可写入的 settings 文件，无法在这里启停。',
          'dim',
        ),
      );
    }
    acts.appendChild(copyBtn(skill.path || skill.name, '复制路径'));
    detailBox.appendChild(acts);

    // 正文（只读）
    const head = el('div', 'ext-sec-head');
    head.appendChild(el('span', '', 'SKILL.md（只读）'));
    detailBox.appendChild(head);
    const pre = el('pre', 'ext-code', '读取中…');
    detailBox.appendChild(pre);

    const d = await fetchSkillDetail(skill.id);
    if (seq !== detailSeq || !ownsWorkspace(generation) || !isCurrent()) return; // 用户已经点了别的或切换项目
    if (!d || d.ok === false) {
      pre.textContent = (d && d.error) || '读不到详情';
      return;
    }
    if (d.note) detailBox.insertBefore(note(d.note, 'dim'), head);
    pre.textContent = d.content || '（空文件）';
    if (d.truncated) detailBox.appendChild(note(`文件较大，只显示前 ${Math.round((d.content || '').length / 1024)}KB`, 'dim'));
    if ((d.files || []).length) {
      const files = el('div', 'ext-files');
      for (const f of d.files) {
        const chip = el('span', 'ext-file', f.dir ? f.name + '/' : f.name);
        chip.title = f.size === null ? '' : `${f.size} 字节`;
        files.appendChild(chip);
      }
      detailBox.appendChild(el('div', 'ext-sec-head', '同一目录下的文件'));
      detailBox.appendChild(files);
    }
  }

  function renderList() {
    const items = filtered();
    listBox.innerHTML = '';
    if (!items.length) {
      listBox.appendChild(el('div', 'ext-empty', data && data.skills && data.skills.length ? '没有符合筛选条件的 Skill' : '没有发现 Skill'));
      return;
    }
    for (const s of items) {
      const meta = stateMeta(s.state);
      const item = el('button', 'ext-item' + (s.id === selectedId ? ' on' : ''));
      item.type = 'button';
      item.setAttribute('aria-current', s.id === selectedId ? 'true' : 'false');
      const top = el('div', 'ext-item-top');
      top.appendChild(el('span', 'ext-dot ' + meta.dot));
      top.appendChild(el('span', 'ext-name', s.name));
      top.appendChild(el('span', 'ext-badge', SCOPE_LABEL[s.scope] || s.scope));
      item.appendChild(top);
      item.appendChild(el('div', 'ext-item-desc', s.description || '（没有描述）'));
      if (s.state !== 'enabled') item.appendChild(el('div', 'ext-item-note', meta.label + (s.stateNote ? ' · ' + s.stateNote : '')));
      item.onclick = () => {
        selectedId = s.id;
        renderList();
        showDetail(s);
      };
      listBox.appendChild(item);
    }
  }

  function renderSummary() {
    summary.innerHTML = '';
    if (!data) return;
    const c = data.counts || {};
    const bits = [`共 ${c.total || 0} 个`, `已启用 ${c.enabled || 0}`, `项目 ${c.project || 0}`, `用户 ${c.user || 0}`];
    summary.appendChild(el('span', 'ext-sum-label', bits.join('　·　')));
    if (data.piReachable === false) {
      summary.appendChild(note('pi 没有应答，所以「是否加载」这一列无法确认 —— 状态显示为「状态未知」。', 'warn'));
    }
    for (const d of data.diagnostics || []) summary.appendChild(note(d.message, 'warn'));
    if (data.trust && data.trust.requiresTrust && !data.trust.trusted) {
      summary.appendChild(
        note(
          '当前项目未被信任，pi 在非交互模式下不会加载项目级 Skills / Extensions —— 所以项目里那些会显示成「未加载（项目未信任）」。这是 pi 的默认行为，不是配置丢了。',
          'warn',
        ),
      );
    }
  }

  async function load(isRefresh) {
    const generation = S.workspaceGeneration;
    if (isRefresh) summary.innerHTML = '';
    listBox.innerHTML = '';
    listBox.appendChild(el('div', 'ext-empty', '正在读取 Skills…'));
    const j = await fetchSkills();
    if (!isCurrent()) return;
    if (!ownsWorkspace(generation)) {
      listBox.innerHTML = '';
      const stale = el('div', 'ext-empty', '项目已切换，刷新后查看当前项目的 Skills。');
      const retry = el('button', 'btn tiny', '刷新');
      retry.type = 'button';
      retry.onclick = () => load(true);
      stale.appendChild(retry);
      listBox.appendChild(stale);
      return;
    }
    if (!j || j.ok === false) {
      listBox.innerHTML = '';
      const error = el('div', 'ext-empty', (j && j.error) || '读取 Skills 失败');
      const retry = el('button', 'btn tiny', '重试');
      retry.type = 'button';
      retry.onclick = () => load(true);
      error.appendChild(retry);
      listBox.appendChild(error);
      if (j && j.diagnostics) for (const d of j.diagnostics) summary.appendChild(note(d.message, 'warn'));
      return;
    }
    data = j;
    renderSummary();
    renderList();
    // 详情跟着刷新：状态可能刚变过
    const cur = (data.skills || []).find((s) => s.id === selectedId);
    if (cur) showDetail(cur);
    else showDetail(null);
  }

  search.addEventListener('input', renderList);
  selScope.addEventListener('change', renderList);
  selState.addEventListener('change', renderList);
  btnRefresh.onclick = () => load(true);

  load(false);
}

/* ---------- MCP 标签页（P20.6 原生集成） ---------- */

const MCP_STATE_META = {
  active: { dot: 'on', label: '原生 MCP 生效中' },
  replaced: { dot: 'warn', label: '内置 MCP 被扩展接管' },
  disabled: { dot: 'off', label: '内置 MCP 已禁用' },
  unsupported: { dot: 'dim', label: '这个 pi 不带原生 MCP' },
  unknown: { dot: 'dim', label: '原生状态未知' },
};

const MCP_RUNTIME_META = {
  connected: '已连接',
  connecting: '连接中…',
  'needs-auth': '需要登录',
  disconnected: '已断开',
  disabled: '已停用',
  failed: '连接失败',
};

function mcpStateMeta(state) {
  return MCP_STATE_META[state] || { dot: 'dim', label: state || '未知' };
}

function runtimeStateLabel(state) {
  if (!state) return '未知';
  return MCP_RUNTIME_META[state] || state;
}

/** 生效徽标：effective 是后端按 enabled / 覆盖 / 信任 / 原生状态算好的结论。 */
function effectiveBadge(eff) {
  if (!eff || typeof eff !== 'object') return el('span', 'ext-badge', '未知');
  if (eff.active) return el('span', 'ext-badge', '生效中');
  const reason = { untrusted: '未生效（项目未信任）', overridden: '被项目同名覆盖', disabled: '已停用', replaced: '被扩展接管', unsupported: 'pi 不支持' }[eff.reason];
  return el('span', 'ext-badge', reason || '未生效');
}

function scopeLabel(scope) {
  return scope === 'project' ? '项目' : scope === 'user' ? '用户' : '未知';
}

function mcpTab(card, isCurrent) {
  const wrap = el('div', 'ext-mcp');
  card.appendChild(wrap);
  wrap.appendChild(el('div', 'ext-empty', '读取中…'));

  const reload = () => {
    if (!isCurrent()) return;
    wrap.innerHTML = '';
    mcpTabBody(wrap, isCurrent, reload);
  };

  mcpTabBody(wrap, isCurrent, reload);
}

async function mcpTabBody(wrap, isCurrent, reload) {
  wrap.innerHTML = '';
  wrap.appendChild(el('div', 'ext-empty', '读取中…'));

  const [j, n] = await Promise.all([fetchMcp(), fetchMcpServers()]);
  if (!isCurrent()) return;
  wrap.innerHTML = '';
  if (!j || j.ok === false) {
    wrap.appendChild(note((j && j.error) || '读取 MCP 状态失败', 'warn'));
    return;
  }

  /* 结论先摆出来。supported 可能是 null（检测不出来）—— 那种情况下不许说成 false。 */
  const head = el('div', 'ext-mcp-head');
  if (j.supported === false) {
    head.appendChild(el('span', 'ext-dot dim'));
    head.appendChild(el('h4', '', '这个 pi 不带原生 MCP'));
  } else if (j.supported === true) {
    head.appendChild(el('span', 'ext-dot on'));
    head.appendChild(el('h4', '', '这个 pi 带 MCP 能力'));
  } else {
    head.appendChild(el('span', 'ext-dot dim'));
    head.appendChild(el('h4', '', '无法确定这个 pi 是否支持 MCP'));
  }
  wrap.appendChild(head);

  /* 版本与出处分开摆。「文档里的验证基线」是历史事实，而这里显示的是
   * 你机器上跑的那个 —— 两件事混成一句「pi 版本」正是旧文案的根源。 */
  const ver = j.version || null;
  if (ver && ver.value) {
    wrap.appendChild(note(`检测到的 pi 版本：${ver.value}（来源 ${ver.source}${ver.updatedAt ? ' · ' + ver.updatedAt : ''}）`, 'dim'));
  } else if (ver && ver.status === 'malformed') {
    wrap.appendChild(note('读到了 pi 包，但它的 version 字段不是一个版本号 —— 按「版本未知」处理。', 'warn'));
  } else {
    wrap.appendChild(note('读不到本机 pi 包的版本 —— 按「版本未知」处理。', 'warn'));
  }
  wrap.appendChild(note(j.reason, 'dim'));
  if (j.evidence) {
    wrap.appendChild(el('div', 'ext-sec-head', '出处'));
    wrap.appendChild(el('pre', 'ext-code quote', j.evidence));
  }

  /* built-in 能力。编译在 pi 包里的扩展，不出现在用户扩展列表里。 */
  const bi = j.builtins || {};
  wrap.appendChild(el('div', 'ext-sec-head', 'built-in 能力（pi 自带）'));
  if (bi.known && Array.isArray(bi.entries)) {
    if (bi.entries.length) {
      const chips = el('div', 'ext-files');
      for (const b of bi.entries) {
        const chip = el('span', 'ext-file', `builtin:${b.id}`);
        chip.title = b.evidence || '';
        if (b.replaceable) chip.appendChild(el('span', 'ext-badge', '可被替换'));
        chips.appendChild(chip);
      }
      wrap.appendChild(chips);
    } else {
      wrap.appendChild(note('这个 pi 包里没有列出任何 built-in 扩展。', 'dim'));
    }
    if (bi.evidence) wrap.appendChild(el('pre', 'ext-code quote', bi.evidence));
    wrap.appendChild(note(bi.note || '', 'dim'));
  } else {
    wrap.appendChild(note('读不到这个 pi 包的 built-in 扩展清单 —— 按「未知」处理，不硬编码结论。', 'dim'));
  }

  /* P20.6 原生状态与 Servers。 */
  wrap.appendChild(el('div', 'ext-sec-head', 'MCP Servers（pi 原生）'));
  if (!n || n.ok === false) {
    wrap.appendChild(note((n && n.error) || '读不到原生 MCP 摘要', 'warn'));
  } else {
    const st = (n.native && n.native.state) || 'unknown';
    const meta = mcpStateMeta(st);
    const stHead = el('div', 'ext-mcp-head');
    stHead.appendChild(el('span', 'ext-dot ' + meta.dot));
    stHead.appendChild(el('h4', '', meta.label));
    wrap.appendChild(stHead);
    if (n.native && n.native.reason) wrap.appendChild(note(n.native.reason, 'dim'));

    const servers = Array.isArray(n.servers) ? n.servers : [];
    if (!servers.length) {
      wrap.appendChild(note('没有配置任何 MCP server。用下面的表单添加（无凭据的），或在终端跑 pi mcp add。', 'dim'));
    }
    for (const s of servers) {
      const box = el('div', 'ext-item');
      const top = el('div', 'ext-item-top');
      top.appendChild(el('span', 'ext-name', s.name || '?'));
      top.appendChild(el('span', 'ext-badge', scopeLabel(s.scope)));
      box.appendChild(top);
      const bits = [];
      bits.push(`启用：${s.enabled === true ? '是' : s.enabled === false ? '否' : '未知'}`);
      bits.push(`exposure：${s.exposure || '未知'}`);
      bits.push(`传输：${s.transportType === 'http' ? '远端' : s.transportType === 'stdio' ? '本地命令' : '未知'}`);
      if (s.hasSecrets) bits.push('含凭据引用（值不显示）');
      if (s.toolExposure && Object.keys(s.toolExposure).length) bits.push(`单工具 exposure ${Object.keys(s.toolExposure).length} 条`);
      box.appendChild(el('div', 'ext-item-sub', bits.join(' · ')));
      const acts = el('div', 'ext-acts');
      acts.appendChild(effectiveBadge(s.effective));
      if (s.overridden) acts.appendChild(el('span', 'ext-badge', '用户级被覆盖'));
      // 运行时状态（上次刷新的，不承诺实时）。
      const rt = (n.runtime && Array.isArray(n.runtime.servers) ? n.runtime.servers : []).find((r) => r.name === s.name);
      if (rt) {
        acts.appendChild(el('span', 'ext-badge', '运行：' + runtimeStateLabel(rt.state)));
        if (typeof rt.toolCount === 'number') acts.appendChild(el('span', 'ext-badge', `${rt.toolCount} 个工具`));
        if (rt.error) box.appendChild(el('pre', 'ext-code quote', String(rt.error).slice(0, 300)));
      }
      // 动作：login / logout / remove（add 在列表下方表单）。enable 等走 /mcp TUI。
      const loginBtn = el('button', 'btn tiny', '登录');
      loginBtn.type = 'button';
      loginBtn.title = '跑 pi mcp login（OAuth 由 pi 接管浏览器与 token，Pi GUI 不经手凭据）';
      loginBtn.onclick = async () => {
        const ok = await confirmModal({
          title: `登录 ${s.name}？`,
          message: '会跑 pi 的官方登录（OAuth 由 pi 接管：开浏览器、等你授权、自己存 token）。Pi GUI 看不到任何凭据。最多等 2 分钟，超时请改用终端。',
          okText: '登录',
        });
        if (!ok || !isCurrent()) return;
        loginBtn.disabled = true;
        const r = await mcpServerAction({ action: 'login', name: s.name });
        if (!isCurrent()) return;
        loginBtn.disabled = false;
        if (!r || r.ok !== true) {
          toast((r && (r.code === 'workspace-stale' ? '项目已切换，操作作废' : r.error)) || '登录失败', 'error');
          return;
        }
        toast('登录成功，已刷新状态', 'info');
        reload();
      };
      const logoutBtn = el('button', 'btn tiny', '退出登录');
      logoutBtn.type = 'button';
      logoutBtn.title = '跑 pi mcp logout（删掉 pi 存的 OAuth 凭据）';
      logoutBtn.onclick = async () => {
        const ok = await confirmModal({
          title: `退出 ${s.name} 的登录？`,
          message: '会删掉 pi 存的 OAuth 凭据。remove 只删配置不删凭据，凭据要走这一步。',
          okText: '退出登录',
          danger: true,
        });
        if (!ok || !isCurrent()) return;
        logoutBtn.disabled = true;
        const r = await mcpServerAction({ action: 'logout', name: s.name });
        if (!isCurrent()) return;
        logoutBtn.disabled = false;
        if (!r || r.ok !== true) {
          toast((r && (r.code === 'workspace-stale' ? '项目已切换，操作作废' : r.error)) || '退出失败', 'error');
          return;
        }
        toast('已退出登录', 'info');
        reload();
      };
      const rmBtn = el('button', 'btn tiny', '移除');
      rmBtn.type = 'button';
      rmBtn.onclick = async () => {
        const ok = await confirmModal({
          title: `移除 ${s.name}？`,
          message: `会从${s.scope === 'project' ? '项目' : '用户'}级 mcp.json 里删掉这条。注意：OAuth 凭据不会一起删（要清凭据再点退出登录）。`,
          okText: '移除',
          danger: true,
        });
        if (!ok || !isCurrent()) return;
        rmBtn.disabled = true;
        const r = await mcpServerAction({ action: 'remove', name: s.name, scope: s.scope });
        if (!isCurrent()) return;
        rmBtn.disabled = false;
        if (!r || r.ok !== true) {
          toast((r && (r.code === 'workspace-stale' ? '项目已切换，操作作废' : r.error)) || '移除失败', 'error');
          return;
        }
        toast('已移除' + ((r && r.note) ? '（' + r.note + '）' : ''), 'info');
        reload();
      };
      acts.appendChild(loginBtn);
      acts.appendChild(logoutBtn);
      acts.appendChild(rmBtn);
      box.appendChild(acts);
      wrap.appendChild(box);
    }
    for (const inv of n.configInvalid || []) wrap.appendChild(note(inv, 'warn'));
    if (n.configError && (n.configError.user || n.configError.project)) {
      wrap.appendChild(note('配置文件读不出来（按空处理，不猜）：' + [n.configError.user, n.configError.project].filter(Boolean).join(' / '), 'warn'));
    }

    /* 运行时状态：只在手势时刷新（会启动用户的 stdio servers，不轮询）。 */
    const rt = n.runtime;
    const bar = el('div', 'ext-acts');
    const refBtn = el('button', 'btn tiny primary', rt ? '刷新状态' : '获取运行时状态');
    refBtn.type = 'button';
    refBtn.title = '跑 pi mcp list --json（官方结构化输出）。会连接已启用的 servers，用户级命令会被执行一次。';
    const rtNote = el('span', 'ext-item-sub', rt && rt.at ? `上次刷新：${rt.at}${rt.cached ? '（缓存）' : ''}` : '尚未获取运行时状态（未知≠没有）');
    refBtn.onclick = async () => {
      refBtn.disabled = true;
      const r = await refreshMcpStatus();
      if (!isCurrent()) return;
      refBtn.disabled = false;
      if (!r || r.ok !== true) {
        toast((r && (r.code === 'workspace-stale' ? '项目已切换，操作作废' : r.error)) || '刷新失败', 'error');
        return;
      }
      reload();
    };
    bar.appendChild(refBtn);
    bar.appendChild(rtNote);
    wrap.appendChild(bar);
    if (rt && !rt.ok) wrap.appendChild(note(rt.error || '状态刷新失败', 'warn'));
    for (const e of (rt && rt.errors) || []) wrap.appendChild(note(e, 'warn'));

    mcpAddForm(wrap, isCurrent, reload);
    try {
      const ob = snapshotMcpObservation();
      wrap.appendChild(
        note(
          ob.any
            ? `这次运行观察到 ${ob.count} 个 MCP 来源被调用（最近：${ob.names.join(' · ')}）。观察到只说明调用过，不构成「已配置」的证据。`
            : '这次运行尚未观察到 MCP 工具调用（没调用过≠不支持）。',
          'dim',
        ),
      );
    } catch {
      /* 观察快照失败不挡住整个标签页 */
    }
    wrap.appendChild(note('启用 / 停用 / 重连 / 改 exposure 没有官方自动化接口 —— 请用 pi 的 /mcp 管理器（TUI）或直接编辑 mcp.json。这里不伪造这些开关。', 'dim'));
  }

  /* RPC 事实：有没有「已注册工具清单」这条命令。 */
  const rpc = j.rpc || null;
  if (rpc) {
    wrap.appendChild(el('div', 'ext-sec-head', 'RPC 事实'));
    wrap.appendChild(
      note(
        rpc.commandCount === null
          ? '读不到 RPC 命令表，无法确认它有没有工具清单命令。'
          : `RpcCommand 联合共 ${rpc.commandCount} 条命令，其中没有一条返回已注册工具清单。`,
        rpc.toolListCommand === false ? 'dim' : 'warn',
      ),
    );
    wrap.appendChild(note(rpc.note || '', 'dim'));
    const api = j.extensionApi;
    if (api && api.available) {
      wrap.appendChild(
        note(
          `ExtensionAPI：registerMcpServer ${api.registerMcpServer ? '有' : '没有'} · ` +
            `getMcpServers ${api.getMcpServers ? '有' : '没有'} · getAllTools ${api.getAllTools ? '有' : '没有'}` +
            '（这些是扩展进程内的 API，RPC 客户端拿不到）',
          'dim',
        ),
      );
    }
  }

  /* 替代路径。 */
  const route = j.extensionRoute || {};
  wrap.appendChild(el('div', 'ext-sec-head', 'pi 的做法：扩展（extension）'));
  wrap.appendChild(note(route.note || '', 'dim'));
  const rowsBox = el('div', 'ext-rows');
  if (route.userDir) rowsBox.appendChild(row('用户级扩展目录', route.userDir));
  if (route.projectDir) rowsBox.appendChild(row('项目级扩展目录', route.projectDir));
  wrap.appendChild(rowsBox);

  for (const [label, side] of [
    ['用户级', route.user],
    ['项目级', route.project],
  ]) {
    if (!side) continue;
    const box = el('div', 'ext-list-static');
    box.appendChild(el('div', 'ext-sec-head', `${label}（${side.exists ? side.count + ' 项' : '目录不存在'}）`));
    if (side.error) box.appendChild(note(side.error, 'warn'));
    for (const e of side.entries || []) {
      const line = el('div', 'ext-item static');
      line.appendChild(el('span', 'ext-name', e.name));
      if (e.kind === 'dir') line.appendChild(el('span', 'ext-badge', '目录'));
      if (typeof e.size === 'number') line.appendChild(el('span', 'ext-badge', `${e.size} B`));
      box.appendChild(line);
    }
    wrap.appendChild(box);
  }

  const fromSettings = route.fromSettings || [];
  const packages = route.packages || [];
  if (fromSettings.length || packages.length) {
    wrap.appendChild(el('div', 'ext-sec-head', '来自 settings 的声明'));
    const rows2 = el('div', 'ext-rows');
    for (const x of fromSettings) rows2.appendChild(row(`extensions（${x.scope}）`, x.value));
    for (const x of packages) rows2.appendChild(row(`packages（${x.scope}）`, x.value));
    wrap.appendChild(rows2);
  }

  wrap.appendChild(
    note(
      'Pi GUI 只列出这些扩展，不安装、不启用、也不执行它们 —— 扩展是能执行代码的，装什么由你在 pi 那边决定。',
      'dim',
    ),
  );
}

/* 添加表单：只做无凭据字段。含 env / headers / OAuth 的请走终端
 * `pi mcp add` 或直接编辑文件 —— 凭据值不进浏览器、不进 HTTP。 */
function mcpAddForm(wrap, isCurrent, reload) {
  wrap.appendChild(el('div', 'ext-sec-head', '添加 Server（无凭据）'));
  const form = el('div', 'ext-form');
  const nameInput = el('input', 'ext-input');
  nameInput.placeholder = '名字（字母/数字/_/-）';
  nameInput.maxLength = 64;
  const scopeSel = el('select', 'ext-sel');
  for (const [v, t] of [['user', '用户级'], ['project', '项目级']]) {
    const o = el('option', '', t);
    o.value = v;
    scopeSel.appendChild(o);
  }
  const transSel = el('select', 'ext-sel');
  for (const [v, t] of [['stdio', '本地命令'], ['http', '远端 URL']]) {
    const o = el('option', '', t);
    o.value = v;
    transSel.appendChild(o);
  }
  const cmdInput = el('input', 'ext-input');
  cmdInput.placeholder = '命令（单个可执行文件） + 参数空格分隔，如：npx -y server';
  const urlInput = el('input', 'ext-input');
  urlInput.placeholder = 'https://…/mcp';
  urlInput.style.display = 'none';
  const expSel = el('select', 'ext-sel');
  for (const [v, t] of [['codemode', 'codemode（默认）'], ['codemode-deferred', 'codemode-deferred'], ['deferred', 'deferred'], ['direct', 'direct'], ['hidden', 'hidden']]) {
    const o = el('option', '', t);
    o.value = v;
    expSel.appendChild(o);
  }
  transSel.onchange = () => {
    const isHttp = transSel.value === 'http';
    cmdInput.style.display = isHttp ? 'none' : '';
    urlInput.style.display = isHttp ? '' : 'none';
  };
  const addBtn = el('button', 'btn tiny primary', '添加');
  addBtn.type = 'button';
  addBtn.onclick = async () => {
    const name = nameInput.value.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      toast('名字只允许字母、数字、_ 和 -', 'error');
      return;
    }
    const isHttp = transSel.value === 'http';
    const payload = { action: 'add', name, scope: scopeSel.value, transport: transSel.value, exposure: expSel.value };
    if (isHttp) {
      const url = urlInput.value.trim();
      if (!/^https?:\/\//.test(url)) {
        toast('远端需要合法的 http(s) URL', 'error');
        return;
      }
      payload.url = url;
    } else {
      const parts = cmdInput.value.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) {
        toast('本地命令不能为空', 'error');
        return;
      }
      payload.command = parts[0];
      payload.args = parts.slice(1);
    }
    const ok = await confirmModal({
      title: `添加 ${name}？`,
      message: `会写进${payload.scope === 'project' ? '项目' : '用户'}级 mcp.json（pi 官方 add，存在同名则替换）。项目级文件只在项目被信任后才被 pi 读取。`,
      okText: '添加',
    });
    if (!ok || !isCurrent()) return;
    addBtn.disabled = true;
    const r = await mcpServerAction(payload);
    if (!isCurrent()) return;
    addBtn.disabled = false;
    if (!r || r.ok !== true) {
      toast((r && (r.code === 'workspace-stale' ? '项目已切换，操作作废' : r.error)) || '添加失败', 'error');
      return;
    }
    toast('已添加', 'info');
    reload();
  };
  form.appendChild(nameInput);
  form.appendChild(scopeSel);
  form.appendChild(transSel);
  form.appendChild(cmdInput);
  form.appendChild(urlInput);
  form.appendChild(expSel);
  form.appendChild(addBtn);
  wrap.appendChild(form);
  wrap.appendChild(note('含凭据（env / headers / OAuth）的 server 请走终端 pi mcp add（支持 ${VAR} 与 !command 引用）或直接编辑 mcp.json —— 凭据值不进 Pi GUI。', 'dim'));
}


function extensionTab(card, isCurrent) {
  const wrap = el('div', 'ext-skills');
  card.appendChild(wrap);
  const webBox = el('section', 'web-setup');
  wrap.appendChild(webBox);
  renderWebSetup(webBox, null);
  const subagentBox = el('section', 'web-setup');
  wrap.appendChild(subagentBox);
  renderSubagentSetup(subagentBox, null);
  const memoryBox = el('section', 'web-setup');
  wrap.appendChild(memoryBox);
  renderMemorySetup(memoryBox, null);
  /* P20：Browser Use 设置区。与 Web Search 分开 —— 两者是独立能力。 */
  const browserBox = el('section', 'web-setup');
  wrap.appendChild(browserBox);
  renderBrowserSetup(browserBox, null);
  /* P19：approval 能力报告。supported / unsupported 都要说清 —— 不许把没拦住的画成拦住了。 */
  const approvalBox = el('section', 'web-setup');
  wrap.appendChild(approvalBox);
  renderApprovalSetup(approvalBox, null);
  const bar = el('div', 'ext-bar');
  const refresh = el('button', 'btn tiny', '刷新');
  refresh.type = 'button';
  bar.appendChild(refresh);
  const summary = el('div', 'ext-summary');
  const split = el('div', 'ext-split');
  const list = el('div', 'ext-list');
  const detail = el('div', 'ext-detail');
  split.append(list, detail);
  wrap.append(bar, summary, split);
  let selected = null;
  let data = null;

  function showDetail(item) {
    detail.replaceChildren();
    if (!item) { detail.appendChild(el('div', 'ext-empty', '选择一个 Extension 查看详情。')); return; }
    detail.appendChild(el('h4', '', item.displayName || item.name));
    const rows = el('div', 'ext-rows');
    for (const [label, value] of [
      ['版本', item.version || '未知'], ['来源', item.source?.type || 'unknown'],
      ['位置', item.source?.location || '未知'], ['作用域', item.scope === 'global' ? '用户' : item.scope === 'project' ? '项目' : '未知'],
      ['已安装', item.state?.installed === null ? '未知' : item.state?.installed ? '是' : '否'],
      ['已启用', item.state?.enabled === null ? '未知' : item.state?.enabled ? '是' : '否'],
      ['已加载', item.state?.loaded === null ? '无法确认' : item.state?.loaded ? '是' : '否'],
      ['需要重启', item.state?.restartRequired === null ? '未知' : item.state?.restartRequired ? '是' : '否'],
    ]) rows.appendChild(row(label, value));
    detail.appendChild(rows);
    if (item.description) detail.appendChild(note(item.description, 'dim'));
    detail.appendChild(el('div', 'ext-sec-head', '已确认的能力'));
    if (item.capabilities?.length) {
      for (const capability of item.capabilities) detail.appendChild(note(`${capability.type}: ${capability.displayName || capability.id}`, 'dim'));
    } else detail.appendChild(note('暂无可确认的能力。', 'dim'));
    detail.appendChild(note('Pi RPC 未提供已注册工具列表；工具来源未知时，聊天时间线仍按原始名称显示。', 'dim'));
    if (item.state?.error) detail.appendChild(note(`${item.state.error.phase}: ${item.state.error.message}`, 'warn'));
  }

  function render() {
    list.replaceChildren();
    const items = data?.extensions || [];
    summary.replaceChildren(el('span', 'ext-sum-label', `发现 ${items.length} 个 Extension · 加载状态仅在 Pi 提供证据时确认`));
    if (!data?.piReachable) summary.appendChild(note('Pi 未应答；无法确认实际加载状态。', 'warn'));
    if (!items.length) list.appendChild(el('div', 'ext-empty', '没有发现可只读定位的 Extension。'));
    for (const item of items) {
      const state = item.state || {};
      const label = state.error ? (state.error.phase === 'discovery' ? '发现异常' : '加载失败') : state.loaded === true ? '已加载' : state.loaded === false ? '未加载' : '加载未知';
      const button = el('button', 'ext-item ext-extension-item');
      button.type = 'button';
      button.classList.toggle('on', selected === item.id);
      button.appendChild(el('span', 'ext-name', item.displayName || item.name));
      button.appendChild(el('span', 'ext-badge', label));
      button.appendChild(el('div', 'ext-item-desc', `${item.description || '（没有简介）'} · ${item.source?.type === 'local' ? '本地' : item.source?.type || '未知来源'} · ${item.capabilities?.length || 0} 个已确认能力`));
      button.onclick = () => { selected = item.id; render(); showDetail(item); };
      list.appendChild(button);
    }
    showDetail(items.find((item) => item.id === selected) || null);
  }
  async function load() {
    const generation = S.workspaceGeneration;
    list.replaceChildren(el('div', 'ext-empty', '正在读取 Extensions…'));
    const result = await fetchExtensions();
    if (!isCurrent() || !ownsWorkspace(generation)) return;
    if (!result || result.ok === false) {
      list.replaceChildren(el('div', 'ext-empty', 'Extension 发现暂不可用；聊天仍可正常使用。'));
      return;
    }
    data = result;
    renderWebSetup(webBox, result);
    renderSubagentSetup(subagentBox, result);
    renderMemorySetup(memoryBox, result);
    renderBrowserSetup(browserBox, result);
    render();
    /* approval 能力报告是只读的本地探测，和 Extension 发现分开取：
     * 它失败不该把整页 Extension 列表带塌。 */
    fetchApprovalCapability().then((cap) => {
      if (!isCurrent() || !ownsWorkspace(generation)) return;
      renderApprovalSetup(approvalBox, cap && cap.ok !== false ? cap : null);
    }).catch(() => {});
  }
  refresh.onclick = load;
  load();
}

/* ---------- 入口 ---------- */

/** 侧栏那个数字。只显示「发现了几个」，不显示「几个生效」——
 *  后者要问 pi，启动时问一次不值得（而且 pi 可能还没起来）。 */
export async function loadExtensionsBadge() {
  const generation = S.workspaceGeneration;
  const j = await fetchSkills();
  if (!ownsWorkspace(generation)) return;
  const node = document.getElementById('extCount');
  if (!node) return;
  if (!j || j.ok === false || !j.counts) {
    node.textContent = '';
    return;
  }
  const total = j.counts.total || 0;
  node.textContent = total ? String(total) : '';
  node.title = `发现 ${total} 个 Skill（其中已加载 ${j.counts.enabled || 0} 个）`;
}

export function openExtensions() {
  openWorkSurface('extensions', (card, instance) => {
    card.classList.add('wide', 'ext');

    const h = el('h3', '', '扩展');
    card.appendChild(h);
    card.appendChild(
      el(
        'div',
        'modal-desc',
        'Skills 与 Extension 分开列出。Extension 只读发现已存在的本地资源；MCP 是 pi 原生集成的管理面。',
      ),
    );

    const tabs = el('div', 'ext-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '扩展类型');
    const body = el('div', 'ext-body');
    body.id = 'extensionsTabPanel';
    body.setAttribute('role', 'tabpanel');
    const panels = { skills: null, extensions: null, mcp: null };
    let active = 'skills';

    const render = () => {
      for (const btn of tabs.children) {
        btn.classList.toggle('on', btn.dataset.tab === active);
        btn.setAttribute('aria-selected', String(btn.dataset.tab === active));
      }
      body.setAttribute('aria-labelledby', active === 'skills' ? 'extensionsTabSkills' : active === 'extensions' ? 'extensionsTabExtensions' : 'extensionsTabMcp');
      body.innerHTML = '';
      if (!panels[active]) {
        const holder = el('div', 'ext-panel');
        panels[active] = holder;
        body.appendChild(holder);
        if (active === 'skills') skillsTab(holder, instance.isCurrent);
        else if (active === 'extensions') extensionTab(holder, instance.isCurrent);
        else mcpTab(holder, instance.isCurrent);
      } else {
        // 已经建过的面板：重新挂回去（innerHTML 清空不会销毁 JS 里的引用，
        // 但节点被移出文档了，appendChild 会把它接回来）
        body.appendChild(panels[active]);
      }
    };

    for (const [key, label] of [
      ['skills', 'Skills'],
      ['extensions', 'Extensions'],
      ['mcp', 'MCP'],
    ]) {
      const b = el('button', 'ext-tab', label);
      b.type = 'button';
      b.id = key === 'skills' ? 'extensionsTabSkills' : key === 'extensions' ? 'extensionsTabExtensions' : 'extensionsTabMcp';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', body.id);
      b.dataset.tab = key;
      b.onclick = () => {
        active = key;
        render();
      };
      tabs.appendChild(b);
    }

    card.append(tabs, body);
    render();

    // 没有项目时提示一下：用户级 skill 仍然能看，但项目级一栏会是空的
    if (!S.hasProject) {
      card.appendChild(note('还没有选择项目 —— 现在只能看到用户级的 Skills。选一个文件夹后项目级的才会出现。', 'dim'));
    }
  });
}
