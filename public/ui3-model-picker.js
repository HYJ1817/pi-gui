/* UI-3B：模型选择器与 Thinking 等级选择器的**视图层**。
 *
 * ---------- 它是什么 ----------
 *
 * 一个把「调用方状态里已经存在的模型事实」排版成 DOM 的纯视图。它不持有模型状态、
 * 不缓存、不发任何 RPC —— 选择动作经注入的 onSelect 交回调用方，由既有的
 * setModel(provider, modelId) / setThinkingLevel(level) 执行。所以这里不存在第二份
 * 业务状态，也不存在第二个模型注册表。
 *
 * ---------- 它复用什么 ----------
 *
 * 弹层外壳、位置管理与关闭行为全部来自 ui/popover.js：同一个 pop 单例、同一个
 * openPop/closePop，本模块不新建全局弹层。条目结构沿用 popItem 的类名契约
 * （.pop-item / .pi-text / .pi-sub / .pi-check）与既有 Provider 折叠契约
 * （.pop-model-group[data-provider] > .pop-provider + .pop-provider-models），
 * 所以既有样式和既有断言继续成立；本模块只在其上追加 ui3-* 类做增量表现。
 *
 * ---------- 它比原内联实现多做什么 ----------
 *
 *   1. 键盘导航：↑↓ 在可见项之间移动、Home/End 跳首末、←→ 折叠/展开 Provider，
 *      配 roving tabindex。原实现里 400+ 个模型每一项都是 Tab 停靠点，键盘基本没法用。
 *   2. Thinking 的四种「不可用」各有各的说法（同步中 / 不支持推理 / 推理能力未知 /
 *      Pi 未提供档位）。原实现把这四种都压成一句 toast，用户分不清是哪种。
 *   3. 能力摘要的三值呈现：unknown 渲染成中性的「能力未知」，既不是空白也不是
 *      「不支持」。
 *
 * ---------- 它刻意不做什么 ----------
 *
 *   - 不按模型名或供应商猜能力（无硬编码模型库）。
 *   - 不在 reasoning=false 时推翻 Pi 给出的档位：Pi 的实时清单优先于静态能力位，
 *     见 docs/model-capabilities.md「Pi 若给出了多个等级，以该列表为准」。
 *   - 不做乐观选择：点选后界面仍显示调用方传入的当前值，直到回读把它改掉。
 *     所以「设置失败后保留虚假的乐观选择」在结构上不可能发生。
 *   - 不从自己的 DOM 文本反推状态（原实现对 modelText/thinkText 有这种回退读法，
 *     视图模块读自己画出来的字当输入，等于把渲染结果变成事实源）。
 */

import { pop, openPop, closePop, currentAnchor, popTitle, popItem } from './ui/popover.js';
import { modelIdentity, modelCapability, modelCapabilitySummary } from './model-capabilities.js';
import { thinkingAvailability as sharedThinkingAvailability } from './thinking-availability.js';

/* Thinking 档位的说明文案。这是**展示文案**不是档位清单 —— 档位一律来自 Pi 的
 * get_available_thinking_levels；这里只是给已知的名字配一句人话，配不上就不配。 */
export const THINK_DESC = {
  off: '不思考，最快',
  minimal: '最少思考',
  low: '轻量思考',
  medium: '中等思考',
  high: '深度思考',
  xhigh: '较高思考预算',
  max: '最大思考预算',
};

const PROVIDER_FALLBACK = '默认';

/* 当前渲染的折叠记忆与弹层模式。pop 是单例，所以这里也只需要一份。
 * expanded 由调用方持有（跨次打开的记忆），本模块只在原地增删，不复制。 */
let activeExpanded = null;
let activeOptions = null;

/* ---------- 纯函数：三值能力 ---------- */

/* 把模型能力摊成带三值状态的行。state 只会是 yes / no / unknown，
 * unknown **不是** no —— 没证据不等于不支持（AGENTS.md 的三值纪律）。 */
export function capabilityFacts(model) {
  const m = modelCapability(model);
  const rows = [];
  const put = (key, label) => {
    const value = m.capabilities[key];
    rows.push({ key, label, state: value === true ? 'yes' : value === false ? 'no' : 'unknown' });
  };
  put('reasoning', '推理');
  put('imageInput', '图片');
  put('toolCalling', 'Tools');
  return {
    rows,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    /* 只有「至少有一条明确证据」才叫已知；全 unknown 时调用方可以据此说「能力未知」。 */
    anyKnown: rows.some((r) => r.state !== 'unknown') || m.contextWindow !== null,
  };
}

/* Runtime 的 <select> 用它做 option 文案：同名不同 Provider 的模型必须能分辨。
 * 纯函数，不碰 DOM，Runtime 可以直接用而不必把状态绑到 Classic 的 S 上。 */
export function modelDisplayLabel(model) {
  const { providerId, modelId } = modelIdentity(model);
  const name = typeof model?.name === 'string' && model.name.trim() ? model.name.trim() : modelId;
  if (!name) return '';
  return providerId ? `${name} · ${providerId}` : name;
}

/* ---------- 纯函数：Thinking 可用性 ---------- */

/* 判定顺序是有讲究的，别调换：
 *
 *   1. pending 优先 —— 正在回读时说什么都不算数（renderModelControls 同此）。
 *   2. **Pi 的实时档位优先于静态 reasoning 位**。Pi 说这个模型有 off/low/high，
 *      那就是有；静态 metadata 里 reasoning=false 是更弱的证据，不覆盖它。
 *      （smoke「reasoning=false 仍按 Pi 返回两档」钉的就是这条。）
 *   3. 没有可用档位时才回头解释原因，且区分三种：明确不支持 / 能力未知 / Pi 没给。
 *
 * 只有 off 的清单视为不可用：全是 off 等于没有可调的推理强度。 */
export function thinkingAvailability(input = {}) {
  return sharedThinkingAvailability(input);
}

/* ---------- 键盘导航 ---------- */

/* 可见且可操作的节点：跳掉折叠起来的那几组，也跳掉 disabled 的。
 * closest('[hidden]') 对条目能找到收起的 .pop-provider-models，对组头返回 null。 */
function navigables() {
  return [...pop.querySelectorAll('.pop-provider, .pop-item')]
    .filter((node) => !node.disabled && !node.closest('[hidden]'));
}

function focusNav(node, list = navigables()) {
  for (const n of list) n.tabIndex = n === node ? 0 : -1;
  node.focus();
  /* jsdom 没有布局，scrollIntoView 可能不存在或不做布局。 */
  if (typeof node.scrollIntoView === 'function') {
    try { node.scrollIntoView({ block: 'nearest' }); } catch { /* 布局不可用，忽略 */ }
  }
}

/* openPop 会自己挑一个初始焦点；把它对齐到 roving tabindex 上，
 * 否则第一个被聚焦的元素 tabindex 是 -1，下一次 Tab 会从别处接上。 */
function syncRoving() {
  const list = navigables();
  if (!list.length) return;
  const active = list.includes(document.activeElement) ? document.activeElement : list[0];
  for (const node of list) node.tabIndex = node === active ? 0 : -1;
}

/* 展开/收起一组 Provider。折叠状态是纯 DOM + 调用方那个 Set，不重画整个列表 ——
 * 重画会把 400 个条目重建一遍，还会把焦点丢掉。 */
function toggleProvider(header, force) {
  const group = header.closest('.pop-model-group');
  const container = group?.querySelector('.pop-provider-models');
  if (!container) return;
  const expand = force === undefined ? container.hidden : force;
  const provider = group.dataset.provider;
  if (activeExpanded) {
    if (expand) activeExpanded.add(provider);
    else activeExpanded.delete(provider);
  }
  container.hidden = !expand;
  header.setAttribute('aria-expanded', String(expand));
  /* 折叠改变了弹层高度，位置按外壳自己的算法重算；openPop 会顺手挪一次焦点，
   * 所以焦点要重新落回组头，漫游索引也跟着重算。 */
  reposition();
  header.focus();
  syncRoving();
}

/* 折叠会改变弹层高度，位置得按外壳自己的算法重算一遍。
 * 直接复用 openPop —— 本模块不实现第二套定位。 */
function reposition() {
  const anchor = currentAnchor();
  if (!anchor || !activeOptions) return;
  openPop(anchor, activeOptions);
}

pop.addEventListener('keydown', (event) => {
  const node = event.target?.closest?.('.pop-provider, .pop-item');
  if (!node || !pop.contains(node)) return;
  const list = navigables();
  const index = list.indexOf(node);
  if (index < 0) return;
  const move = (next) => {
    event.preventDefault();
    focusNav(list[(next + list.length) % list.length], list);
  };
  if (event.key === 'ArrowDown') return move(index + 1);
  if (event.key === 'ArrowUp') return move(index - 1);
  if (event.key === 'Home') return move(0);
  if (event.key === 'End') return move(list.length - 1);
  if (event.key === 'ArrowRight' && node.classList.contains('pop-provider')) {
    event.preventDefault();
    return toggleProvider(node, true);
  }
  if (event.key === 'ArrowLeft' && node.classList.contains('pop-provider')) {
    event.preventDefault();
    return toggleProvider(node, false);
  }
  /* Enter / Space 不处理：条目是原生 button，交给浏览器默认行为，
   * 免得手动派发 click 把「回调只触发一次」变成两次。 */
});

/* ---------- Chip 状态 ---------- */

/* 给 Chip 挂一个可供 CSS 选择的状态值。Chip 的文案与 disabled 仍由 composer.js 的
 * renderModelControls 决定（那是它的职责）；这里只补一个它表达不了的东西：
 * 「不可用」到底是哪一种。接线前 CSS 只认 :disabled，接线后才有分档配色。 */
export function applyChipState(button, state) {
  if (!button) return;
  if (state) button.dataset.ui3State = state;
  else delete button.dataset.ui3State;
}

/* ---------- 模型选择器 ---------- */

function groupByProvider(models) {
  const groups = new Map();
  for (const model of models) {
    const provider = modelIdentity(model).providerId || PROVIDER_FALLBACK;
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(model);
  }
  return groups;
}

/* 清掉已经消失的 Provider 的折叠记忆，否则它下次出现时会带着上一次的展开态回来。
 * 与既有实现同语义（smoke「消失后重新出现的非当前 Provider 恢复默认收起」）。 */
function pruneExpanded(expanded, groups) {
  if (!expanded) return;
  for (const provider of [...expanded]) {
    if (!groups.has(provider)) expanded.delete(provider);
  }
}

function modelItem({ model, on, onPick, capabilitySummary }) {
  const { providerId, modelId } = modelIdentity(model);
  const id = modelId || model?.name || '';
  const provider = providerId || PROVIDER_FALLBACK;
  const summary = capabilitySummary(model);
  const facts = capabilityFacts(model);
  /* 一条明确证据都没有时，说「能力未知」；有证据就照实列出，未知项不列。 */
  const unknown = !summary.text && !facts.anyKnown;
  const item = popItem({
    label: model?.name || id,
    sub: unknown ? '能力未知' : summary.text,
    on,
    onClick: onPick,
  });
  item.classList.add('ui3-model-item');
  item.dataset.provider = provider;
  item.dataset.modelId = id;
  item.dataset.reasoning = facts.rows.find((r) => r.key === 'reasoning')?.state || 'unknown';
  if (unknown) item.querySelector('.pi-sub')?.classList.add('ui3-cap-unknown');
  /* 完整能力（含明确不支持项与 Max output）留在 title —— 行内只放正向事实，
   * 未知绝不在行内显示成不支持（docs/model-capabilities.md）。 */
  item.title = summary.title || (unknown ? 'Pi 未提供这个模型的能力信息' : '');
  return item;
}

/**
 * 把模型列表画进共享弹层并打开。参数全部显式注入，本函数不读任何全局状态。
 * @param {object}   o
 * @param {object[]} o.models           可用模型列表（S.models）
 * @param {object}   o.current          当前模型（S.state.model），原样传入即可
 * @param {Set}      o.expanded         Provider 折叠记忆，原地增删，调用方持有
 * @param {boolean}  o.pending          set_model 是否在途
 * @param {Function} o.onSelect         (providerId, modelId) => void，由调用方执行
 * @param {Function} o.onClose          本视图主动关闭时回调（外部点击/Esc 由外壳负责）
 * @param {Function} [o.capabilitySummary] 摘要函数，默认 modelCapabilitySummary
 * @param {string}   [o.title]
 */
export function renderModelPicker({
  models = [],
  current = null,
  expanded = null,
  pending = false,
  onSelect = () => {},
  onClose = () => {},
  capabilitySummary = modelCapabilitySummary,
  title = '选择模型',
} = {}) {
  activeExpanded = expanded;
  activeOptions = { model: true };

  const { providerId: currentProvider, modelId: currentId } = modelIdentity(current);
  const groups = groupByProvider(models);
  pruneExpanded(expanded, groups);

  pop.innerHTML = '';
  pop.appendChild(popTitle(title));

  /* 当前身份单独一行。条目行显示的是 name，可能看不出到底是哪个 Provider 的哪个 id；
   * 同名模型分属两个 Provider 时这一行就是唯一能把它们分开的地方。 */
  const identityLine = document.createElement('div');
  identityLine.className = 'ui3-current';
  identityLine.dataset.provider = currentProvider || '';
  identityLine.dataset.modelId = currentId || '';
  identityLine.textContent = currentId
    ? (currentProvider ? `${currentProvider} / ${currentId}` : currentId)
    : '尚未读到当前模型';
  if (pending) identityLine.classList.add('ui3-pending');
  pop.appendChild(identityLine);

  if (!groups.size) {
    const empty = document.createElement('div');
    empty.className = 'ui3-empty';
    empty.textContent = '还没有可用的模型列表';
    pop.appendChild(empty);
    openPop(anchorFor('model'), { model: true });
    syncRoving();
    return;
  }

  const pick = (provider, id) => {
    closePop({ restoreFocus: true });
    onClose();
    onSelect(provider, id);
  };

  let groupIndex = 0;
  for (const [provider, list] of groups) {
    const isCurrentGroup = currentProvider
      ? provider === currentProvider
      : Boolean(currentId) && list.some((m) => modelIdentity(m).modelId === currentId);
    /* 当前模型所在组每次打开都强制展开 —— 否则用户上次把它收起过，这次就找不到自己在哪。 */
    if (isCurrentGroup && expanded) expanded.add(provider);
    const isExpanded = expanded ? expanded.has(provider) : isCurrentGroup;

    const group = document.createElement('div');
    group.className = 'pop-model-group';
    group.dataset.provider = provider;
    group.dataset.current = String(isCurrentGroup);

    const models_ = document.createElement('div');
    models_.className = 'pop-provider-models';
    models_.id = 'model-provider-' + (++groupIndex);
    models_.hidden = !isExpanded;

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'pop-provider';
    header.tabIndex = -1;
    /* 组头也带 Provider 身份：它是键盘漫游序列里的一项，没有身份就没法断言
     * 「焦点移到了哪一组」，样式也选不中具体某组。组容器上那份保持不变。 */
    header.dataset.provider = provider;
    header.setAttribute('aria-controls', models_.id);
    header.setAttribute('aria-expanded', String(isExpanded));
    const name = document.createElement('span');
    name.className = 'pop-provider-name';
    name.textContent = provider;
    const count = document.createElement('span');
    count.className = 'pop-provider-count';
    count.textContent = String(list.length);
    header.append(name, count);
    header.addEventListener('click', () => toggleProvider(header));

    group.append(header, models_);
    pop.appendChild(group);

    for (const model of list) {
      const { providerId, modelId } = modelIdentity(model);
      const id = modelId || model?.name || '';
      const rowProvider = providerId || PROVIDER_FALLBACK;
      const on = currentProvider
        ? rowProvider === currentProvider && id === currentId
        : Boolean(currentId) && id === currentId;
      models_.appendChild(modelItem({
        model,
        on,
        capabilitySummary,
        onPick: () => pick(rowProvider, id),
      }));
    }
  }

  const foot = document.createElement('div');
  foot.className = 'pop-foot';
  const total = document.createElement('span');
  total.textContent = '共 ' + models.length + ' 个可用模型';
  foot.appendChild(total);
  pop.appendChild(foot);

  openPop(anchorFor('model'), { model: true });
  syncRoving();
}

/* ---------- Thinking 等级选择器 ---------- */

/**
 * 把 Thinking 档位画进共享弹层并打开。档位只来自 Pi 的 get_available_thinking_levels。
 * @param {object}   o
 * @param {string[]} o.levels       Pi 返回的档位（S.thinkingLevels）
 * @param {string}   o.current      当前档位（S.state.thinkingLevel）
 * @param {object}   o.model        当前模型（用于解释「为什么没有档位」）
 * @param {boolean}  o.pending      set_model 是否在途
 * @param {Function} o.onSelect     (level) => void
 * @param {Function} o.onClose
 * @param {object}   [o.descriptions]
 * @param {string}   [o.title]
 */
export function renderThinkingPicker({
  levels = [],
  current = null,
  model = null,
  pending = false,
  readStatus = 'success',
  onSelect = () => {},
  onClose = () => {},
  descriptions = THINK_DESC,
  title = '思考等级',
} = {}) {
  activeExpanded = null;
  activeOptions = {};

  const availability = thinkingAvailability({ model, levels, pending, readStatus });

  pop.innerHTML = '';
  pop.appendChild(popTitle(title));

  /* 有档位时不画状态行 —— 「有 4 个档位」不是信息。不可用时才解释原因。 */
  if (availability.state !== 'ready') {
    const state = document.createElement('div');
    state.className = 'ui3-think-state';
    state.dataset.state = availability.state;
    state.textContent = availability.detail;
    pop.appendChild(state);
  }

  for (const level of availability.levels) {
    const item = popItem({
      label: level,
      sub: descriptions[level] || '',
      on: level === current,
      onClick: () => {
        closePop({ restoreFocus: true });
        onClose();
        onSelect(level);
      },
    });
    item.classList.add('ui3-think-item');
    item.dataset.level = level;
    /* 不可用时档位照画但不可点 —— 让用户看见「Pi 到底给了哪几个」，而不是一个空弹层。 */
    if (availability.state !== 'ready') {
      item.disabled = true;
      item.tabIndex = -1;
    }
    pop.appendChild(item);
  }

  openPop(anchorFor('think'), activeOptions);
  syncRoving();
  // Read-only explanations may have no enabled options. Give the dialog
  // keyboard focus so its existing Escape handler remains reachable.
  if (!pop.contains(document.activeElement)) {
    pop.tabIndex = -1;
    pop.focus();
  }
}

/* ---------- 触发元素 ---------- */

/* 触发按钮由调用方通过 setTrigger 告知，或者由 anchor 参数显式传入。
 * 之所以要这一层：openPop 需要一个真实的锚元素来定位与写 aria-expanded，
 * 而本模块不 import app.js 的 el 表（那会造成视图反向依赖装配层）。 */
let triggers = { model: null, think: null };
export function setTriggers(next = {}) {
  triggers = { ...triggers, ...next };
}
function anchorFor(kind) {
  const explicit = triggers[kind];
  if (explicit) return explicit;
  return document.getElementById(kind === 'model' ? 'btnModel' : 'btnThink');
}
