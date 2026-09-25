/* 模型供应商管理（写入 pi 的 ~/.pi/agent/models.json）。
 *
 * 三件事容易踩，都体现在这里的实现上：
 *   1. $ENV_VAR 形式的 apiKey 若变量没设置，pi 会**静默丢掉整个供应商**
 *      → 后端会回 keyStates，列表里直接挂黄色警告条。
 *   2. 改了 models.json 必须重启 pi 才生效（RPC 模式不热重载）
 *      → 面板里放了「重载 pi 配置」。
 *   3. 模型行必须能表达 pi 的模型条目字段，但 textarea 里只有一行文本
 *      → 用 `id|显示名|key=value` 的语法，见 parseModelLine。 */

import { el, panels } from './state.js';
import { fmtTokens } from './util.js';
import {
  deleteProvider as apiDeleteProvider,
  fetchProviderModels,
  fetchProviders,
  restartBackend,
  saveProvider,
} from './api.js';
import { openModal } from './ui/modal.js';
import { toast } from './ui/toast.js';
import { clearThread } from './messages.js';

const PRESETS = {
  openrouter: { label: 'OpenRouter', name: 'openrouter', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '$OPENROUTER_API_KEY', models: '' },
  ollama: { label: 'Ollama 本地', name: 'ollama', api: 'openai-completions', baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama', models: 'llama3.1:8b\nqwen2.5-coder:7b' },
  deepseek: { label: 'DeepSeek', name: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', apiKey: '$DEEPSEEK_API_KEY', models: 'deepseek-chat|DeepSeek Chat\ndeepseek-reasoner|DeepSeek Reasoner' },
  moonshot: { label: 'Moonshot', name: 'moonshot', api: 'openai-completions', baseUrl: 'https://api.moonshot.cn/v1', apiKey: '$MOONSHOT_API_KEY', models: 'kimi-k2-0905-preview|Kimi K2' },
  siliconflow: { label: '硅基流动', name: 'siliconflow', api: 'openai-completions', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: '$SILICONFLOW_API_KEY', models: 'deepseek-ai/DeepSeek-V3|DeepSeek V3' },
  zhipu: { label: '智谱 GLM', name: 'zhipu', api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '$ZHIPU_API_KEY', models: 'glm-4.6|GLM-4.6' },
  dashscope: { label: '阿里百炼', name: 'dashscope', api: 'openai-completions', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '$DASHSCOPE_API_KEY', models: 'qwen3-max|Qwen3 Max' },
  anthropic: { label: 'Anthropic', name: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', apiKey: '$ANTHROPIC_API_KEY', models: 'claude-sonnet-4-5|Claude Sonnet 4.5' },
  gemini: { label: 'Google Gemini', name: 'google', api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: '$GEMINI_API_KEY', models: 'gemini-2.5-pro|Gemini 2.5 Pro' },
};

/* 模型列表里的一行。
 *
 * 基础形式是 `id` 或 `id|显示名`，后面可以跟任意个 `key=value` 参数，
 * 它们会被写进 pi 的模型条目（见 pi docs/models.md 的 Model Configuration）。
 *
 * 为什么参数必须带 `=`：否则 `id|reasoning` 无法区分「显示名叫 reasoning」
 * 和「这是个布尔旗标」。要求 key=value 就没有歧义了。 */
const MODEL_PARAM_ALIAS = {
  ctx: 'contextWindow',
  context: 'contextWindow',
  contextwindow: 'contextWindow',
  max: 'maxTokens',
  maxtokens: 'maxTokens',
};

export function parseModelLine(line) {
  const parts = String(line).split('|').map((s) => s.trim());
  const id = parts.shift();
  if (!id) return null;

  const model = { id };

  for (const part of parts) {
    if (!part) continue;

    const eq = part.indexOf('=');
    if (eq === -1) {
      // 第一个不带 = 的片段是显示名
      if (!model.name) model.name = part;
      continue;
    }

    const rawKey = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    const key =
      MODEL_PARAM_ALIAS[rawKey.toLowerCase()] ||
      ['contextWindow', 'maxTokens', 'reasoning', 'input'].find((k) => k.toLowerCase() === rawKey.toLowerCase());
    if (!key) continue; // 未知键静默忽略，别让一个笔误毁掉整行

    if (key === 'reasoning') {
      model.reasoning = /^(1|true|yes|on)$/i.test(value);
    } else if (key === 'input') {
      const kinds = value.split(',').map((s) => s.trim()).filter(Boolean);
      if (kinds.length) model.input = kinds;
    } else {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) model[key] = Math.round(n);
    }
  }

  return model;
}

/** parseModelLine 的逆运算。显示名里的 `|` 会被换掉，否则会把这一行切乱。 */
export function modelLine(m) {
  const parts = [m.id];
  if (m.name) parts.push(String(m.name).replace(/\|/g, '/'));
  if (m.contextWindow) parts.push(`contextWindow=${m.contextWindow}`);
  if (m.maxTokens) parts.push(`maxTokens=${m.maxTokens}`);
  if (m.reasoning) parts.push('reasoning=true');
  if (Array.isArray(m.input) && m.input.includes('image')) parts.push(`input=${m.input.join(',')}`);
  return parts.join('|');
}

let providerData = { path: '', providers: {}, keyStates: {} };
let providerError = '';
let providerRequest = 0;

export async function loadProviders(container) {
  const request = ++providerRequest;
  const j = await fetchProviders();
  if (request !== providerRequest) return;
  if (j && j.ok !== false) {
    providerData = { path: j.path || '', providers: j.providers || {}, keyStates: j.keyStates || {} };
    providerError = '';
  } else {
    providerError = (j && j.error) || '读取供应商失败';
  }
  renderProviders(container || panels.providers);
}

export function renderProviders(box) {
  const names = Object.keys(providerData.providers);

  el.providerCount.textContent = names.length ? String(names.length) : '';
  if (!box) return;

  box.innerHTML = '';

  if (providerError) {
    const error = document.createElement('div');
    error.className = 'hint-empty';
    error.textContent = providerError;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn tiny';
    retry.textContent = '重试';
    retry.onclick = () => loadProviders(box);
    error.appendChild(retry);
    box.appendChild(error);
    return;
  }

  if (!names.length) {
    box.innerHTML =
      '<div class="hint-empty">还没有自定义供应商。<br>内置供应商由 pi 自己管理，这里只放你自己添加的。</div>';
    return;
  }

  for (const name of names) {
    const cfg = providerData.providers[name] || {};
    const count = Array.isArray(cfg.models) ? cfg.models.length : 0;

    const item = document.createElement('div');
    item.className = 'prov';

    const main = document.createElement('div');
    main.className = 'prov-main';
    const n = document.createElement('span');
    n.className = 'prov-name';
    n.textContent = name;
    const m = document.createElement('span');
    m.className = 'prov-meta';
    m.textContent = `${count} 个模型 · ${cfg.api || 'openai-completions'}`;
    m.title = cfg.baseUrl || '';
    main.append(n, m);

    const ks = providerData.keyStates[name];
    if (ks && !ks.ok) {
      const warn = document.createElement('span');
      warn.className = 'prov-warn';
      warn.textContent = ks.note;
      main.appendChild(warn);
    }

    const del = document.createElement('button');
    del.className = 'prov-del';
    del.title = '删除该供应商';
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>';
    del.onclick = (e) => {
      e.stopPropagation();
      removeProvider(name);
    };

    item.append(main, del);
    box.appendChild(item);
  }
}

export function openProvidersPanel() {
  openModal((card, close) => {
    card.classList.add('wide');

    const h = document.createElement('h3');
    h.textContent = '模型供应商';
    card.appendChild(h);

    const desc = document.createElement('div');
    desc.className = 'modal-desc';
    desc.textContent =
      '这里添加的供应商会写进 pi 的 ' +
      (providerData.path || '~/.pi/agent/models.json') +
      '，已有的配置不会被覆盖。保存后需要重载 pi 才会生效。';
    card.appendChild(desc);

    const box = document.createElement('div');
    box.className = 'providers';
    card.appendChild(box);

    panels.providers = box;
    box.innerHTML = '<div class="hint-empty">加载中…</div>';

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const add = document.createElement('button');
    add.className = 'btn primary';
    add.textContent = '添加供应商';
    add.onclick = openAddProvider;

    const reload = document.createElement('button');
    reload.className = 'btn';
    reload.textContent = '重载 pi 配置';
    reload.onclick = () => {
      close();
      reloadPi();
    };

    const done = document.createElement('button');
    done.className = 'btn';
    done.textContent = '关闭';
    done.onclick = close;

    actions.append(add, reload, done);
    card.appendChild(actions);
  });

  loadProviders();
}

export async function removeProvider(name) {
  const j = await apiDeleteProvider(name);
  if (!j.ok) return toast(j.error || '删除失败', 'error');
  toast(`已删除供应商 ${name}。重载 pi 后生效。`, 'info');
  await loadProviders();
}

export function openAddProvider() {
  openModal((card, close) => {
    card.classList.add('wide');

    const mk = (tag, cls, attrs = {}) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      Object.assign(n, attrs);
      return n;
    };

    const h = mk('h3', '', { textContent: '添加模型供应商' });
    const desc = mk('div', 'modal-desc', {
      textContent: '配置写入 pi 的 ' + (providerData.path || '~/.pi/agent/models.json') + '。已有供应商不会被覆盖。',
    });
    const presets = mk('div', 'presets');
    card.append(h, desc, presets);

    const fName = mk('div', 'field');
    fName.innerHTML = '<label>供应商 ID</label>';
    const iName = mk('input', '', { placeholder: 'my-provider' });
    fName.appendChild(iName);

    const fApi = mk('div', 'field');
    fApi.innerHTML = '<label>API 类型</label>';
    const sApi = mk('select');
    for (const [v, t] of [
      ['openai-completions', 'openai-completions（兼容性最好）'],
      ['openai-responses', 'openai-responses'],
      ['anthropic-messages', 'anthropic-messages'],
      ['google-generative-ai', 'google-generative-ai'],
    ]) {
      sApi.appendChild(mk('option', '', { value: v, textContent: t }));
    }
    fApi.appendChild(sApi);

    const fBase = mk('div', 'field');
    fBase.innerHTML = '<label>Base URL</label>';
    const iBase = mk('input', '', { placeholder: 'https://api.example.com/v1' });
    fBase.appendChild(iBase);

    const row = mk('div', 'field-row');
    row.append(fApi, fBase);

    const fKey = mk('div', 'field');
    fKey.innerHTML = '<label>API Key</label>';
    const iKey = mk('input', '', { placeholder: '$MY_API_KEY 或 sk-...' });
    fKey.append(
      iKey,
      mk('div', 'hint', {
        textContent:
          '可填 $ENV_VAR 引用环境变量、!command 执行命令取值，或直接填字面量。注意：$ENV_VAR 没设置时 pi 会直接忽略整个供应商，且不报错。',
      })
    );

    const fModels = mk('div', 'field');
    const mHead = mk('div', 'field-head');
    mHead.appendChild(mk('label', '', { textContent: '模型列表' }));
    const btnFetch = mk('button', 'btn tiny', { textContent: '拉取', type: 'button' });
    mHead.appendChild(btnFetch);

    const iModels = mk('textarea', '', {
      rows: 4,
      placeholder: 'deepseek-chat|DeepSeek Chat\nqwen3-max|Qwen3 Max|contextWindow=262144',
    });
    const mHint = mk('div', 'hint', {
      textContent:
        '每行一个模型：id 或 id|显示名，后面可跟 contextWindow=… / maxTokens=… / reasoning=true / input=text,image。' +
        '点「拉取」可直接从供应商读取。',
    });

    /* ---- 拉取面板 ---- */
    const panel = mk('div', 'fetch-panel', { hidden: true });
    const bar = mk('div', 'fetch-bar');
    const fSearch = mk('input', 'fetch-search', { placeholder: '搜索模型…', type: 'search' });
    const btnAll = mk('button', 'btn tiny', { textContent: '全选', type: 'button' });
    const btnNone = mk('button', 'btn tiny', { textContent: '清空', type: 'button' });
    const btnCollapse = mk('button', 'btn tiny', { textContent: '收起', type: 'button' });
    bar.append(fSearch, btnAll, btnNone, btnCollapse);

    const listBox = mk('div', 'fetch-list');
    const foot = mk('div', 'fetch-foot');
    const note = mk('div', 'fetch-note');
    const btnAdd = mk('button', 'btn tiny primary', { textContent: '加入列表', type: 'button' });
    foot.append(note, btnAdd);

    panel.append(bar, listBox, foot);
    fModels.append(mHead, iModels, mHint, panel);

    card.append(fName, row, fKey, fModels);

    let fetched = [];
    const picked = new Set();

    const visible = () => {
      const q = fSearch.value.trim().toLowerCase();
      if (!q) return fetched;
      return fetched.filter((m) => m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q));
    };

    const syncPick = () => {
      btnAdd.textContent = picked.size ? `加入列表 (${picked.size})` : '加入列表';
    };

    const renderFetchList = () => {
      const shown = visible();
      listBox.innerHTML = '';
      if (!shown.length) {
        listBox.innerHTML = '<div class="hint-empty">没有匹配的模型</div>';
        return;
      }

      for (const m of shown) {
        const rowEl = mk('div', 'fetch-row');
        const cb = mk('input', '', { type: 'checkbox', checked: picked.has(m.id) });
        const commit = () => {
          if (cb.checked) picked.add(m.id);
          else picked.delete(m.id);
          syncPick();
        };
        cb.onchange = commit;
        // 点整行也能勾选。点 checkbox 本身时交给它自己处理，否则会被切两次。
        rowEl.onclick = (e) => {
          if (e.target === cb) return;
          cb.checked = !cb.checked;
          commit();
        };

        rowEl.appendChild(cb);
        rowEl.appendChild(mk('span', 'fetch-id', { textContent: m.id }));
        if (m.name) rowEl.appendChild(mk('span', 'fetch-name', { textContent: m.name }));

        const badges = [];
        if (m.contextWindow) badges.push(`ctx ${fmtTokens(m.contextWindow)}`);
        if (m.maxTokens) badges.push(`max ${fmtTokens(m.maxTokens)}`);
        if (m.reasoning) badges.push('推理');
        if (Array.isArray(m.input) && m.input.includes('image')) badges.push('图片');
        for (const b of badges) rowEl.appendChild(mk('span', 'fetch-badge', { textContent: b }));

        listBox.appendChild(rowEl);
      }
    };

    fSearch.oninput = renderFetchList;

    btnAll.onclick = () => {
      for (const m of visible()) picked.add(m.id);
      renderFetchList();
      syncPick();
    };

    btnNone.onclick = () => {
      picked.clear();
      renderFetchList();
      syncPick();
    };

    btnCollapse.onclick = () => {
      panel.hidden = true;
    };

    btnAdd.onclick = () => {
      const chosen = fetched.filter((m) => picked.has(m.id));
      if (!chosen.length) return toast('还没有选中任何模型', 'warn');

      const lines = iModels.value.split('\n').map((s) => s.trim()).filter(Boolean);
      const have = new Set();
      for (const l of lines) {
        const p = parseModelLine(l);
        if (p) have.add(p.id);
      }

      let added = 0;
      for (const m of chosen) {
        if (have.has(m.id)) continue;
        lines.push(modelLine(m));
        have.add(m.id);
        added += 1;
      }
      iModels.value = lines.join('\n');
      toast(added ? `已加入 ${added} 个模型` : '选中的模型都已在列表里', added ? 'info' : 'warn');
    };

    btnFetch.onclick = async () => {
      const baseUrl = iBase.value.trim();
      if (!baseUrl) return toast('请先填写 Base URL', 'warn');

      btnFetch.disabled = true;
      btnFetch.textContent = '拉取中…';
      try {
        const j = await fetchProviderModels({ baseUrl, api: sApi.value, apiKey: iKey.value.trim() });
        if (!j.ok) {
          toast(j.network ? '拉取失败：' + j.error : j.error || '拉取失败', 'error');
          return;
        }

        fetched = j.models || [];
        picked.clear();
        panel.hidden = false;
        fSearch.value = '';
        renderFetchList();
        syncPick();
        // 弹层内容比视口高（max-height:78vh + 内部滚动），面板默认落在折叠线以下。
        // 不主动滚一下，用户会以为「点了拉取什么都没发生」。
        panel.scrollIntoView({ block: 'nearest' });
        note.textContent = `${fetched.length} 个模型 · ${j.source}`;
        note.title = (j.tried || []).length > 1 ? `尝试过：\n${j.tried.join('\n')}` : j.source;
        toast(`取到 ${fetched.length} 个模型`, 'info');
      } finally {
        btnFetch.disabled = false;
        btnFetch.textContent = '拉取';
      }
    };

    for (const p of Object.values(PRESETS)) {
      const b = mk('button', 'preset', { textContent: p.label, type: 'button' });
      b.onclick = () => {
        presets.querySelectorAll('.preset').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        iName.value = p.name;
        sApi.value = p.api;
        iBase.value = p.baseUrl;
        iKey.value = p.apiKey;
        iModels.value = p.models;
        // 有的预设（例如 OpenRouter）模型太多，没法预置 —— 直接告诉用户去拉取，
        // 否则会以为「填了预设却还是空的」是坏了。
        if (!p.models) toast(`${p.label} 的模型太多，没有预置。点「拉取」读取。`, 'info');
      };
      presets.appendChild(b);
    }

    const actions = mk('div', 'modal-actions');
    const cancel = mk('button', 'btn', { textContent: '取消', type: 'button' });
    cancel.onclick = close;

    const save = mk('button', 'btn primary', { textContent: '保存', type: 'button' });
    save.onclick = async () => {
      const name = iName.value.trim();
      const baseUrl = iBase.value.trim();
      if (!name) return toast('请填写供应商 ID', 'warn');
      if (!baseUrl) return toast('请填写 Base URL', 'warn');

      const models = iModels.value
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map(parseModelLine)
        .filter(Boolean);

      const j = await saveProvider(name, { baseUrl, api: sApi.value, apiKey: iKey.value.trim(), models });
      if (!j.ok) return toast(j.error || '保存失败', 'error');
      close();
      if (j.warning) toast(j.warning, 'warn');
      toast(`已保存供应商 ${name}。重载 pi 后即可选用。`, 'info');
      await loadProviders();
      openProvidersPanel();
    };

    actions.append(cancel, save);
    card.appendChild(actions);
  });
}

export async function reloadPi() {
  await restartBackend();
  toast('正在重载 pi 配置…', 'info');
  clearThread();
}
