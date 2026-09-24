/* 当前项目的偏好设置（`<project>/.pi-gui/config.json`）。
 *
 * ---------- 这个模块做两件事 ----------
 *
 *   1. 设置界面：读 / 写当前项目的偏好（模型、思考档位、项目指令、忽略规则、常用命令）
 *   2. 恢复偏好：pi 就绪后，把配置里保存的模型落到当前会话上
 *
 * ---------- 为什么模型走 set_model 而不是启动参数 ----------
 *
 * 后端的 project-config 已经能算出一份「给 pi 的启动参数」，但里面**只有**
 * --thinking 与 --append-system-prompt，没有 --provider / --model。
 * 原因是实测出来的：pi 在非交互模式（含 --mode rpc）下，任何 type:"error"
 * 级别的启动诊断都会直接 process.exit(1)，而「provider 不存在」正是 error 级。
 * 真把项目配置里的模型当启动参数传，一旦那个引用过期，pi 就会退出 →
 * 后端每 1.2 秒重启一次 → 这个项目彻底打不开。这正是本轮要避免的。
 *
 * 所以模型改成：pi 起来之后，先拿 get_available_models 核对这个模型**还在不在**，
 * 在就用 RPC 的 set_model 落下去。set_model 失败只回 { success:false, error }，
 * 不退出、不动当前模型 —— 天然的可失败路径。核对不过就沿用当前模型 + 一次轻提示。
 *
 * 思考档位不走这条路：它当启动参数是安全的（实测非法值只打一条 warning），
 * 而且那样切项目时档位在 pi 启动前就定了，不会出现「先起来再改」的中间态。
 *
 * ---------- 为什么「当前生效值」不从这里来 ----------
 *
 * 生效值只有 pi 的 get_state 说了算（不支持的档位会被 pi 自己夹到邻近档位）。
 * 这里只拿它做对比展示，绝不缓存成另一份状态。 */
import { S } from './state.js';
import { fetchProjectConfig, saveProjectConfig } from './api.js';
import { openModal } from './ui/modal.js';
import { toast } from './ui/toast.js';
import { setModel } from './rpc.js';
import { whenModels } from './usage.js';

/** 已经提示过「模型不可用」的那个「项目 + 模型」，避免每次重启都弹一遍。
 *
 * 键里带上 cwd 是有意的：切项目后同一个失效模型要重新提示一次，
 * 否则 B 项目会继承 A 项目「说过了」的记忆，用户看到的是「换了项目一声不吭」。 */
let warnedMissingModel = '';

/* ---------- 为什么这里**不**缓存配置 ----------
 *
 * 早先这里存了一份 cfgData 做缓存，结果是个真实的坑：切换项目时
 * 前端只是等 pi 重启（见 projects.js 的 activateProject），没有任何地方
 * 会清掉这份缓存 —— 于是切到 B 项目之后，applyProjectPreferences 读到的
 * 还是 A 项目的配置，把 A 的模型按到 B 的会话上。
 *
 * 现在每次应用偏好都重新 GET 一次。代价是一次 HTTP 请求（切项目时本来就
 * 在等 pi 重启，这点开销看不见），换来的是「前端不持有项目状态的副本」——
 * 配置的唯一权威始终是后端那份文件，与 runtime 是唯一 cwd 权威同一个道理。 */

/** 读当前项目的配置。失败返回 null（调用方一律按「没配置」处理）。 */
export async function loadProjectConfig() {
  const j = await fetchProjectConfig();
  return j && j.ok !== false ? j : null;
}

/* ---------- 恢复偏好 ---------- */

/**
 * pi 就绪后调用：把项目配置里保存的模型落到当前会话上。
 *
 * 不碰思考档位与项目指令 —— 那两个在 pi 启动时就通过启动参数确定了
 * （见 server/project-config.js 的 launchArgs）。
 *
 * @param preloaded 已经读好的配置（刚保存完那种「手上就有」的场景传进来，
 *                  省掉一次重复 GET）。不传就现读。
 */
export async function applyProjectPreferences(preloaded = null) {
  const j = preloaded || (await loadProjectConfig());
  if (!j || !j.hasProject || !j.config) return;

  const cfg = j.config;
  const pins = j.env || {};

  // 环境变量显式钉住了模型 → 项目配置不参与（优先级：环境变量 > 项目配置）
  if (!cfg.model || pins.model || pins.provider) return;

  // 拿不到可用模型列表就沿用当前模型，不猜一个出来
  const models = await whenModels();
  if (!models.length) return;

  const want = `${cfg.model.provider}/${cfg.model.id}`;
  const hit = models.find((m) => m.provider === cfg.model.provider && m.id === cfg.model.id);

  if (!hit) {
    // 静默降级 + 一次轻提示（同一个项目里的同一个失效模型只提示一次，
    // 免得 pi 每重启一次就弹一遍）
    const key = `${j.cwd || ''}|${want}`;
    if (warnedMissingModel !== key) {
      warnedMissingModel = key;
      toast(`项目配置里的模型 ${want} 已不可用，本次沿用当前模型。可在「项目设置」里改。`, 'warn');
    }
    return;
  }

  const cur = S.state && S.state.model;
  if (cur && cur.provider === hit.provider && cur.id === hit.id) return; // 已经是它，不用发命令

  setModel(hit.provider, hit.id, hit.name || hit.id);
}

/* ---------- 设置界面 ---------- */

function field(label, hint) {
  const box = document.createElement('div');
  box.className = 'field';
  const l = document.createElement('label');
  l.textContent = label;
  box.appendChild(l);
  if (hint) {
    const h = document.createElement('div');
    h.className = 'hint';
    h.textContent = hint;
    box.appendChild(h);
  }
  return box;
}

function note(text, kind = '') {
  const n = document.createElement('div');
  n.className = 'cfg-note' + (kind ? ' ' + kind : '');
  n.textContent = text;
  return n;
}

export async function openProjectSettings() {
  if (!S.hasProject) {
    toast('还没有选择项目：先在左侧「添加文件夹」选一个目录。', 'info');
    return;
  }

  const j = await loadProjectConfig();
  if (!j || !j.hasProject || !j.config) {
    toast('读取项目配置失败', 'error');
    return;
  }

  const cfg = j.config;
  const limits = j.limits || {};
  const instrLimit = limits.instructions || 32 * 1024;

  /* 模型下拉的可选项。用下标当 value —— 模型 id 里可能带 `/`
   * （OpenRouter 那类），拼成 "provider/id" 再切回来会切错。
   * 按供应商分组：这台机器上 get_available_models 能返回 400 多个模型，
   * 平铺一个 select 是没法用的。 */
  const choices = [{ value: null, label: '（不指定，跟随 pi 的默认）' }];
  const groups = new Map();
  for (const m of S.models) {
    const key = m.provider || '默认';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  for (const [provider, list] of groups) {
    for (const m of list) choices.push({ value: { provider: m.provider, id: m.id || m.name }, label: m.name || m.id, group: provider });
  }
  // 配置里存的模型当前不在可用列表里（供应商删了模型、没配 key…）——
  // 补一个占位项，否则一打开设置就会被下拉框悄悄改成别的模型。
  const savedKey = cfg.model ? `${cfg.model.provider}/${cfg.model.id}` : '';
  const savedIdx = cfg.model ? choices.findIndex((c) => c.value && c.value.provider === cfg.model.provider && c.value.id === cfg.model.id) : -1;
  if (cfg.model && savedIdx === -1) {
    choices.splice(1, 0, { value: cfg.model, label: `${savedKey}（当前不可用）`, group: '', stale: true });
  }
  const modelValue = cfg.model ? String(choices.findIndex((c) => c.value && c.value.provider === cfg.model.provider && c.value.id === cfg.model.id)) : '0';

  openModal((card, close) => {
    card.classList.add('wide');

    const h = document.createElement('h3');
    h.textContent = '项目设置';
    card.appendChild(h);

    const desc = document.createElement('div');
    desc.className = 'modal-desc';
    desc.textContent =
      '这些偏好只对当前项目生效，保存在项目内的 .pi-gui/config.json，切换项目时会自动恢复。' +
      '不会保存任何密钥（API Key、访问令牌都不会写进去）。';
    card.appendChild(desc);

    // 配置读不出来的原因（非法 JSON、版本不认识、权限…）—— 用户必须看到，
    // 否则他只会觉得「我明明设过，怎么没了」。
    for (const w of j.warnings || []) card.appendChild(note(w, 'warn'));

    // 环境变量把某个开关钉住了：说了比不说好，否则改完没反应最难查
    if (j.env && j.env.model) card.appendChild(note('环境变量已固定模型（PI_MODEL / PI_PROVIDER），这里的模型不会生效。', 'dim'));

    /* 已保存值 vs 当前生效值。
     * 两个来源不同、可能不一致，摊开写清楚比只显示一个更诚实：
     *   已保存 = 这个项目希望用的（本文件）
     *   生效中 = pi 现在真的在用的（get_state 回读） */
    const cur = S.state || {};
    const effModel = cur.model ? `${cur.model.provider || '?'}/${cur.model.id || cur.model.name || '?'}` : '';
    const effThink = cur.thinkingLevel || '';
    const bits = [];
    if (effModel) bits.push(`生效中的模型 ${effModel}`);
    if (effThink) bits.push(`思考档位 ${effThink}`);
    if (bits.length) card.appendChild(note(bits.join('　·　'), 'dim'));

    /* ---- 默认模型 ---- */
    const fModel = field('默认模型', '切换到这个项目时自动使用。模型失效时会沿用当前模型并提示一次，不会让项目打不开。');
    const selModel = document.createElement('select');
    /* 按 choices 的顺序渲染，`group` 相同的连续项收进同一个 <optgroup>。
     * 关键：option 的 value 是它在 choices 里的**下标**，而这里也是顺序渲染的，
     * 所以「扁平化之后的顺序」与 choices 完全一致 —— 取值直接 selModel.value 即可。 */
    let openGroup = null;
    let openGroupName = '';
    choices.forEach((c, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = c.label;
      if (c.stale) opt.title = '当前不可用';
      if (!c.group) {
        openGroup = null;
        openGroupName = '';
        selModel.appendChild(opt);
        return;
      }
      if (openGroupName !== c.group) {
        openGroup = document.createElement('optgroup');
        openGroup.label = c.group;
        selModel.appendChild(openGroup);
        openGroupName = c.group;
      }
      openGroup.appendChild(opt);
    });
    selModel.value = modelValue;
    fModel.insertBefore(selModel, fModel.querySelector('.hint'));
    card.appendChild(fModel);
    if (!S.models.length) {
      card.appendChild(note('可用模型列表还没到手，下拉里暂时只有「不指定」—— 稍后重新打开这个窗口就有完整列表了。', 'dim'));
    }

    /* ---- 思考强度 ---- */
    // 用 pi 的**完整**档位列表，而不是当前模型支持的那几个 ——
    // 这是项目偏好，换个模型还要用；具体落到哪一档由 pi 按当时的模型决定。
    const fThink = field('思考强度', '不同模型支持的档位不同，pi 会把它夹到该模型支持的档位；实际生效值看界面上的「思考 …」。');
    const selThink = document.createElement('select');
    const thinkOpts = [{ v: '', t: '（不指定，跟随 pi 的默认）' }];
    for (const lv of j.thinkingLevels || []) thinkOpts.push({ v: lv, t: lv });
    for (const o of thinkOpts) {
      const opt = document.createElement('option');
      opt.value = o.v;
      opt.textContent = o.t;
      selThink.appendChild(opt);
    }
    selThink.value = cfg.thinking || '';
    fThink.insertBefore(selThink, fThink.querySelector('.hint'));
    card.appendChild(fThink);

    /* ---- 项目指令 ---- */
    const fInstr = field('项目指令');
    const taInstr = document.createElement('textarea');
    taInstr.rows = 5;
    taInstr.placeholder = '例如：\n这个项目用 TypeScript\n不要修改 generated/\n提交前先跑 npm test';
    taInstr.value = cfg.instructions || '';
    const instrHint = document.createElement('div');
    instrHint.className = 'hint';
    const syncInstrHint = () => {
      const n = taInstr.value.length;
      instrHint.textContent =
        `作为系统提示词的附加段注入 pi（pi 的 --append-system-prompt），不改写对话内容。` +
        `保存后需要重启 pi 才生效。${n} / ${instrLimit} 字`;
      instrHint.classList.toggle('over', n > instrLimit);
    };
    taInstr.addEventListener('input', syncInstrHint);
    syncInstrHint();
    fInstr.append(taInstr, instrHint);
    card.appendChild(fInstr);

    /* ---- 忽略规则 ---- */
    const fIgnore = field('忽略规则', '每行一条。本轮只保存与展示，还没有接入 Git / 文件树消费。');
    const taIgnore = document.createElement('textarea');
    taIgnore.rows = 3;
    taIgnore.placeholder = 'node_modules\ndist\n*.log';
    taIgnore.value = (cfg.ignore || []).join('\n');
    fIgnore.insertBefore(taIgnore, fIgnore.querySelector('.hint'));
    card.appendChild(fIgnore);

    /* ---- 常用命令 ---- */
    const fCmds = field('常用命令', '本轮只保存与展示，不提供运行按钮 —— 现有可用的执行通道只有 pi 的 bash 命令，它会把这行命令与输出写进会话记录，等于替用户污染对话。');
    const cmdBox = document.createElement('div');
    cmdBox.className = 'cfg-cmds';

    function addCmdRow(name = '', command = '') {
      const row = document.createElement('div');
      row.className = 'cfg-cmd';

      const iName = document.createElement('input');
      iName.className = 'cfg-cmd-name';
      iName.placeholder = '名称';
      iName.value = name;

      const iCmd = document.createElement('input');
      iCmd.className = 'cfg-cmd-text';
      iCmd.placeholder = 'npm test';
      iCmd.value = command;

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'cfg-cmd-del';
      del.title = '删除这一条';
      del.textContent = '×';
      del.onclick = () => row.remove();

      row.append(iName, iCmd, del);
      cmdBox.appendChild(row);
      return row;
    }
    for (const c of cfg.commands || []) addCmdRow(c.name, c.command);
    if (!(cfg.commands || []).length) addCmdRow();

    const btnAddCmd = document.createElement('button');
    btnAddCmd.type = 'button';
    btnAddCmd.className = 'btn tiny';
    btnAddCmd.textContent = '添加一条';
    btnAddCmd.onclick = () => addCmdRow();

    fCmds.insertBefore(cmdBox, fCmds.querySelector('.hint'));
    fCmds.insertBefore(btnAddCmd, fCmds.querySelector('.hint'));
    card.appendChild(fCmds);

    /* ---- 动作 ---- */
    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const btnReset = document.createElement('button');
    btnReset.type = 'button';
    btnReset.className = 'btn';
    btnReset.textContent = '恢复默认';
    btnReset.title = '把表单填回默认值，点「保存」才真正生效';
    btnReset.onclick = () => {
      // 只改表单，不直接写盘 —— 「恢复默认」误点的代价太大，多一步确认
      const d = j.defaults || { model: null, thinking: null, instructions: '', ignore: [], commands: [] };
      selModel.value = '0';
      selThink.value = d.thinking || '';
      taInstr.value = d.instructions || '';
      syncInstrHint();
      taIgnore.value = (d.ignore || []).join('\n');
      cmdBox.innerHTML = '';
      for (const c of d.commands || []) addCmdRow(c.name, c.command);
      if (!(d.commands || []).length) addCmdRow();
      toast('已填回默认值，点「保存」才会生效', 'info');
    };

    const btnCancel = document.createElement('button');
    btnCancel.type = 'button';
    btnCancel.className = 'btn';
    btnCancel.textContent = '取消';
    btnCancel.onclick = close;

    const btnSave = document.createElement('button');
    btnSave.type = 'button';
    btnSave.className = 'btn primary';
    btnSave.textContent = '保存';
    btnSave.onclick = async () => {
      const picked = choices[Number(selModel.value)] || choices[0];

      const commands = [];
      for (const row of cmdBox.querySelectorAll('.cfg-cmd')) {
        const name = row.querySelector('.cfg-cmd-name').value.trim();
        const command = row.querySelector('.cfg-cmd-text').value.trim();
        if (name && command) commands.push({ name, command });
      }

      const payload = {
        model: picked.value,
        thinking: selThink.value || null,
        instructions: taInstr.value,
        ignore: taIgnore.value
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        commands,
      };

      btnSave.disabled = true;
      btnSave.textContent = '保存中…';
      const r = await saveProjectConfig(payload);
      btnSave.disabled = false;
      btnSave.textContent = '保存';

      if (!r || r.ok !== true) {
        // 保存失败就把弹层留着，用户的输入不能丢
        toast((r && r.error) || '保存失败', 'error');
        return;
      }

      close();
      for (const w of r.warnings || []) toast(w, 'warn');
      // 模型不需要重启 pi，保存完立刻落下去；thinking / 指令由后端重启生效
      await applyProjectPreferences(await loadProjectConfig());
      if (r.restartRequired) toast('pi 正在按新配置重启…', 'info');
      else toast('项目设置已保存', 'info');
    };

    actions.append(btnReset, btnCancel, btnSave);
    card.appendChild(actions);
  });
}
