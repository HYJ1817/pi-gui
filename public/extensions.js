/* 扩展面板：Skills 与 MCP。
 *
 * ---------- 这个面板的立场 ----------
 *
 * **Pi GUI 不发明 pi 没有的扩展机制。** 所以这里看到的每一个状态都能追到出处：
 *
 *   - 「有哪些 skill」= 后端按 pi 的发现规则扫文件系统（4 个根 + settings 条目）；
 *   - 「哪些真的生效」= 问 pi 自己（RPC get_commands）—— 这一条**不由 Pi GUI 判断**，
 *     因为只有 pi 知道它到底加载了什么（信任闸门、同名冲突、package 里的 skill…）；
 *   - 「MCP」= pi 0.87.0 没有原生 MCP（官方文档明说），所以没有 Server 可管。
 *     这里给的是「为什么没有 + 官方给的替代路径（extension）」，不是一份假列表。
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
import { fetchSkills, fetchSkillDetail, setSkillEnabled, fetchMcp, restartBackend } from './api.js';
import { openModal, confirmModal } from './ui/modal.js';
import { toast } from './ui/toast.js';

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

function skillsTab(card) {
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
        if (!ok) return;
        btn.disabled = true;
        const r = await setSkillEnabled(skill.id, want);
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
          if (go) {
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
    if (seq !== detailSeq || !ownsWorkspace(generation)) return; // 用户已经点了别的或切换项目
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
      const item = el('div', 'ext-item' + (s.id === selectedId ? ' on' : ''));
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
    if (!card.isConnected) return;
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

/* ---------- MCP 标签页 ---------- */

function mcpTab(card) {
  const wrap = el('div', 'ext-mcp');
  card.appendChild(wrap);
  wrap.appendChild(el('div', 'ext-empty', '读取中…'));

  fetchMcp().then((j) => {
    wrap.innerHTML = '';
    if (!j || j.ok === false) {
      wrap.appendChild(note((j && j.error) || '读取 MCP 状态失败', 'warn'));
      return;
    }

    /* 结论先摆出来。supported 可能是 null（检测不出来）—— 那种情况下不许说成 false。 */
    const head = el('div', 'ext-mcp-head');
    if (j.supported === false) {
      head.appendChild(el('span', 'ext-dot err'));
      head.appendChild(el('h4', '', '这个 pi 没有原生 MCP 支持'));
    } else if (j.supported === true) {
      head.appendChild(el('span', 'ext-dot warn'));
      head.appendChild(el('h4', '', '检测到 MCP 相关模块，但 Pi GUI 还没适配'));
    } else {
      head.appendChild(el('span', 'ext-dot dim'));
      head.appendChild(el('h4', '', '无法确定这个 pi 是否支持 MCP'));
    }
    wrap.appendChild(head);

    if (j.piVersion) wrap.appendChild(note(`检测到的 pi 版本：${j.piVersion}`, 'dim'));
    wrap.appendChild(note(j.reason, 'dim'));
    if (j.evidence) {
      wrap.appendChild(el('div', 'ext-sec-head', '出处'));
      wrap.appendChild(el('pre', 'ext-code quote', j.evidence));
    }

    wrap.appendChild(el('div', 'ext-sec-head', 'MCP Servers'));
    if (!(j.servers || []).length) {
      wrap.appendChild(note(j.serversNote || '没有可列出的 MCP Server。', 'dim'));
    } else {
      for (const s of j.servers) wrap.appendChild(el('div', 'ext-item', `${s.name} · ${s.transport || '?'}`));
    }

    /* 替代路径。这是这个标签页真正有用的部分：告诉用户 pi 认可的做法是什么。 */
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
  });
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
  openModal((card) => {
    card.classList.add('wide', 'ext');

    const h = el('h3', '', '扩展');
    card.appendChild(h);
    card.appendChild(
      el(
        'div',
        'modal-desc',
        '这里显示的是 pi 自己的扩展能力：Skills 由 pi 从固定目录发现，MCP 则要看你的 pi 版本是否支持。' +
          'Pi GUI 不另建一套扩展系统 —— 显示的每一项都能在 pi 那边找到出处。',
      ),
    );

    const tabs = el('div', 'ext-tabs');
    const body = el('div', 'ext-body');
    const panels = { skills: null, mcp: null };
    let active = 'skills';

    const render = () => {
      for (const btn of tabs.children) btn.classList.toggle('on', btn.dataset.tab === active);
      body.innerHTML = '';
      if (!panels[active]) {
        const holder = el('div', 'ext-panel');
        panels[active] = holder;
        body.appendChild(holder);
        if (active === 'skills') skillsTab(holder);
        else mcpTab(holder);
      } else {
        // 已经建过的面板：重新挂回去（innerHTML 清空不会销毁 JS 里的引用，
        // 但节点被移出文档了，appendChild 会把它接回来）
        body.appendChild(panels[active]);
      }
    };

    for (const [key, label] of [
      ['skills', 'Skills'],
      ['mcp', 'MCP'],
    ]) {
      const b = el('button', 'ext-tab', label);
      b.type = 'button';
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
