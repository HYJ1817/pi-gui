/* Pi GUI — 前端入口。
 *
 * 这个文件只做三件事：
 *   1. 装配：把各模块需要的回调接上（分叉、流式开关）
 *   2. 事件路由：SSE 收到的事件按 type 分发到对应模块
 *   3. 绑定与启动：DOM 事件、快捷键、首次加载
 * 具体逻辑都在同目录的模块里 —— 这个文件应该越薄越好。
 *
 * 数据流：SSE 收 pi 的 RPC 事件 → 渲染；POST /api/command 发命令。
 * 关键约定（来自 pi docs/rpc.md）：
 *   - message_update 只给 delta，不带累积快照；需要按 contentIndex 自行组装，
 *     并以 message_end.message 为最终权威。
 *   - tool_execution_update.partialResult 是「累积」值，直接替换显示即可。
 *   - 权限确认走 extension_ui_request / extension_ui_response 子协议。
 */

import { $, el, S } from './state.js';
import { fmt } from './util.js';
import { sendCommand } from './api.js';
import { toast } from './ui/toast.js';
import { closePop, currentAnchor, openPop, pop, popItem, popLabel, popTitle, popVisible } from './ui/popover.js';
import { openModal } from './ui/modal.js';
import { applyProjectState, loadStatus, setBridgeState, setConn, setStatus, setTitleText } from './shell.js';
import { samePath } from './util.js';
import { autoGrow, updateSendState } from './composer.js';
import {
  boot,
  compactNow,
  exportHtml,
  forkFrom,
  newSession,
  onResponse,
  respond,
  setModel,
  setSessionName,
  setThinkingLevel,
  stop,
  submit,
} from './rpc.js';
import {
  dropTrailingError,
  onMessageEnd,
  onMessageStart,
  onMessageUpdate,
  onSettled,
  interruptActive,
  setStreaming,
  syncWelcome,
} from './messages.js';
import { onToolEnd, onToolStart, onToolUpdate } from './tools.js';
import { openBranchPanel, setForkHandler } from './tree.js';
import { openCtxTip, renderCtxChip } from './usage.js';
import { handleFiles, renderAttachments } from './attachments.js';
import { loadProjects, openDirPicker } from './projects.js';
import { loadProviders, openProvidersPanel, reloadPi } from './providers.js';
import { applyProjectPreferences, openProjectSettings } from './project-config.js';
import { loadGitStatus, openChangesPanel } from './git.js';
import { loadExtensionsBadge, openExtensions } from './extensions.js';

/* ---------- 装配 ---------- */

// tree.js 的节点点击要触发分叉，但 tree.js 不能 import rpc.js（会成环），
// 所以在这里把回调递进去。
setForkHandler(forkFrom);

/* ---------- SSE ---------- */

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => setConn('ok', '已连接');
  es.onerror = () => setConn('bad', '连接断开');
  es.onmessage = (e) => {
    let evt;
    try {
      evt = JSON.parse(e.data);
    } catch {
      return;
    }
    // 断线重连时服务端会补发历史事件，用序号去重
    if (typeof evt._seq === 'number') {
      if (evt._seq <= S.seq) return;
      S.seq = evt._seq;
    }
    handle(evt);
  };
}

function handle(evt) {
  if (Number.isInteger(evt.bridgeRun) && Number.isInteger(S.bridgeRun) && evt.bridgeRun < S.bridgeRun) return;
  if (evt.type !== 'bridge_status' && Number.isInteger(evt.bridgeRun)) {
    if (evt.bridgeRun !== S.bridgeRun) return;
  }
  switch (evt.type) {
    case 'bridge_status':
      return onBridge(evt);
    case 'bridge_stderr':
      return onStderr(evt);
    case 'bridge_parse_error':
      return;
    case 'project_config_notice':
      // 后端在同步项目指令、应用项目配置时的警告（写入失败、版本不认识…）
      return toast(evt.message, evt.level === 'error' ? 'error' : 'warn');
    case 'response':
      onResponse(evt);
      if (S.syncPending && evt.success && (evt.command === 'get_state' || evt.command === 'get_messages')) {
        S.syncPending[evt.command === 'get_state' ? 'state' : 'messages'] = false;
        if (!S.syncPending.state && !S.syncPending.messages) {
          S.switching = false;
          S.syncPending = null;
          applyProjectState();
        }
      }
      return;
    case 'agent_start':
      return setStreaming(true);
    case 'agent_end':
      return;
    case 'agent_settled':
      return onSettled();
    case 'message_start':
      return onMessageStart(evt);
    case 'message_update':
      return onMessageUpdate(evt);
    case 'message_end':
      return onMessageEnd(evt);
    case 'tool_execution_start':
      return onToolStart(evt);
    case 'tool_execution_update':
      return onToolUpdate(evt);
    case 'tool_execution_end':
      return onToolEnd(evt);
    case 'extension_ui_request':
      return onUiRequest(evt);
    case 'compaction_start':
      return setStatus('正在压缩上下文…');
    case 'compaction_end':
      return setStatus('');
    case 'auto_retry_start':
      // pi 会为每次重试单独发一轮 message_start / message_end，上一次那轮的
      // 错误卡片和已经空掉的外壳一起撤掉，否则重试成功后对话区里会留下
      // 一张失败卡片 + 一串没有正文的空白「Pi」（见 dropTrailingError）
      dropTrailingError();
      return setStatus(`请求失败，第 ${evt.attempt}/${evt.maxAttempts} 次重试…`);
    case 'auto_retry_end':
      return setStatus('');
    case 'extension_error':
      return toast(`扩展错误：${evt.error}`, 'error');
    default:
      return;
  }
}

let lastBridgeError = '';
function onBridge(evt) {
  if (S.switching && evt.cwd && !samePath(evt.cwd, S.desiredCwd)) return;
  if (S.switching && evt.state === 'ready' && Number.isInteger(evt.bridgeRun) && Number.isInteger(S.bridgeRun) && evt.bridgeRun <= S.bridgeRun) return;
  switch (evt.state) {
    case 'starting':
      return setBridgeState('starting');
    case 'ready':
      if (Number.isInteger(evt.bridgeRun) && evt.bridgeRun === S.bridgeRun && S.bridgeState === 'ready' && !S.switching) return;
      if (Number.isInteger(evt.bridgeRun)) S.bridgeRun = evt.bridgeRun;
      S.cwd = evt.cwd || S.cwd;
      S.hasProject = Boolean(S.cwd);
      S.models = [];
      lastBridgeError = '';
      setStatus('');
      setBridgeState('ready');
      loadExtensionsBadge();
      boot();
      /* 项目偏好要在 pi 起来之后再落到会话上。
       * 模型不能当启动参数传（过期引用会让 pi 退出，见 project-config.js 的说明），
       * 只能等 get_available_models 回来核对过再 set_model —— 所以它排在这里，
       * 而不是跟 --thinking 一起进启动参数。 */
      applyProjectPreferences();
      if (S.switching) {
        const generation = S.workspaceGeneration;
        setTimeout(() => {
          if (S.switching && generation === S.workspaceGeneration && S.bridgeState === 'ready') {
            S.switching = false;
            S.syncPending = null;
            applyProjectState();
            setStatus('状态同步超时。可以重试切换项目或重启 pi。');
          }
        }, 12000);
      }
      return;
    case 'exited':
      if (!lastBridgeError) setBridgeState('exited', `pi 已退出 (${evt.code ?? evt.signal ?? '?'})`);
      interruptActive();
      return;
    case 'restarting':
      return setBridgeState('restarting');
    case 'no-project':
      /* 后端明确告知「没有项目所以没启动 pi」。
       * 这不是错误状态 —— 底部连接指示不能说「连接断开」，那会让用户以为网络坏了。
       * 传空 kind 用 .conn 的默认灰点：中性、不刺眼。 */
      setBridgeState('no-project');
      return;
    case 'error':
      setBridgeState('error');
      if (S.switching) {
        S.switching = false;
        S.syncPending = null;
        applyProjectState();
      }
      const message = [evt.error, evt.hint].filter(Boolean).join('\n');
      setStatus(message);
      if (message !== lastBridgeError) toast(message, 'error');
      lastBridgeError = message;
      return;
    default:
      return;
  }
}

function onStderr(evt) {
  const text = (evt.text || '').trim();
  if (!text) return;
  if (/error|enoent|not found|failed/i.test(text)) {
    setStatus(text.slice(0, 180));
  }
}

/* ---------- 扩展 UI（权限确认等） ---------- */

function onUiRequest(evt) {
  switch (evt.method) {
    case 'select':
      return uiSelect(evt);
    case 'confirm':
      return uiConfirm(evt);
    case 'input':
      return uiInput(evt, false);
    case 'editor':
      return uiInput(evt, true);
    case 'notify':
      return toast(evt.message, evt.notifyType === 'error' ? 'error' : evt.notifyType === 'warning' ? 'warn' : 'info');
    case 'setStatus':
      return setStatus(evt.statusText || '');
    case 'setTitle':
      return setTitleText(evt.title);
    default:
      return;
  }
}

function uiSelect(evt) {
  openModal((card, close) => {
    const h = document.createElement('h3');
    h.textContent = evt.title || '请选择';
    card.appendChild(h);

    const list = document.createElement('div');
    list.className = 'modal-list';
    for (const opt of evt.options || []) {
      const item = document.createElement('div');
      item.className = 'modal-item';
      item.textContent = opt;
      item.onclick = () => {
        close();
        respond(evt.id, { value: opt });
      };
      list.appendChild(item);
    }
    card.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = '取消';
    cancel.onclick = () => {
      close();
      respond(evt.id, { cancelled: true });
    };
    actions.appendChild(cancel);
    card.appendChild(actions);
  });
}

function uiConfirm(evt) {
  openModal((card, close) => {
    const h = document.createElement('h3');
    h.textContent = evt.title || '确认';
    card.appendChild(h);

    if (evt.message) {
      const p = document.createElement('div');
      p.className = 'modal-desc';
      p.textContent = evt.message;
      card.appendChild(p);
    }

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const no = document.createElement('button');
    no.className = 'btn';
    no.textContent = '取消';
    no.onclick = () => {
      close();
      respond(evt.id, { confirmed: false });
    };

    const yes = document.createElement('button');
    yes.className = 'btn primary';
    yes.textContent = '确认';
    yes.onclick = () => {
      close();
      respond(evt.id, { confirmed: true });
    };

    actions.append(no, yes);
    card.appendChild(actions);
  });
}

function uiInput(evt, multiline) {
  openModal((card, close) => {
    const h = document.createElement('h3');
    h.textContent = evt.title || '输入';
    card.appendChild(h);

    if (evt.message) {
      const p = document.createElement('div');
      p.className = 'modal-desc';
      p.textContent = evt.message;
      card.appendChild(p);
    }

    const input = document.createElement(multiline ? 'textarea' : 'input');
    input.className = 'modal-input';
    if (multiline) input.rows = 6;
    if (evt.placeholder) input.placeholder = evt.placeholder;
    card.appendChild(input);
    setTimeout(() => input.focus(), 30);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = '取消';
    cancel.onclick = () => {
      close();
      respond(evt.id, { cancelled: true });
    };

    const ok = document.createElement('button');
    ok.className = 'btn primary';
    ok.textContent = '确定';
    ok.onclick = () => {
      const value = input.value;
      close();
      respond(evt.id, { value });
    };

    actions.append(cancel, ok);
    card.appendChild(actions);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !multiline) ok.click();
    });
  });
}

/* ---------- 选择器 ---------- */

function openModelPicker() {
  if (!S.models.length) {
    sendCommand({ type: 'get_available_models' });
    toast('正在获取模型列表…', 'info');
    return;
  }

  const currentId = S.state?.model?.id || null;

  pop.innerHTML = '';
  pop.appendChild(popTitle('选择模型'));

  // 按供应商分组，和 pi 的模型来源一一对应
  const groups = new Map();
  for (const m of S.models) {
    const key = m.provider || '默认';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  for (const [provider, list] of groups) {
    pop.appendChild(popLabel(provider));
    for (const m of list) {
      const id = m.id || m.name;
      const isCur = currentId ? id === currentId : m.name === el.modelText.textContent;
      pop.appendChild(
        popItem({
          label: m.name || id,
          sub: m.reasoning ? '推理' : '',
          on: isCur,
          onClick: () => {
            closePop();
            // 实测：pi 的 set_model 需要 provider + modelId 两个字段，
            // 只传 model 会报 "Model not found: <provider>/undefined"
            setModel(m.provider, id, m.name || id);
          },
        })
      );
    }
  }

  const foot = document.createElement('div');
  foot.className = 'pop-foot';
  const t = document.createElement('span');
  t.textContent = '共 ' + S.models.length + ' 个可用模型';
  foot.appendChild(t);
  pop.appendChild(foot);

  openPop(el.btnModel);
}

function openThinkPicker() {
  if (!S.thinkingLevels.length) {
    sendCommand({ type: 'get_available_thinking_levels' });
    toast('正在获取思考等级…', 'info');
    return;
  }

  const current = (S.state?.thinkingLevel || el.thinkText.textContent.replace('思考 ', '')).trim();

  const DESC = {
    off: '不思考，最快',
    minimal: '最少思考',
    low: '轻量思考',
    medium: '中等思考',
    high: '深度思考',
    max: '最大思考预算',
  };

  pop.innerHTML = '';
  pop.appendChild(popTitle('思考等级'));

  for (const lv of S.thinkingLevels) {
    const name = typeof lv === 'string' ? lv : lv.level || lv.name;
    pop.appendChild(
      popItem({
        label: name,
        sub: DESC[name] || '',
        on: name === current,
        onClick: () => {
          closePop();
          setThinkingLevel(name);
        },
      })
    );
  }

  openPop(el.btnThink);
}

/* ---------- 会话统计 / 重命名 / 更多 ---------- */

function renderStatsPanel(card, s) {
  const t = s.tokens || {};
  const ctx = s.contextUsage || {};
  const rows = [
    ['用户消息', s.userMessages],
    ['助手消息', s.assistantMessages],
    ['工具调用', s.toolCalls],
    ['输入 token', t.input],
    ['输出 token', t.output],
    ['缓存读取', t.cacheRead],
    ['缓存写入', t.cacheWrite],
    ['上下文占用', ctx.tokens == null ? '—' : `${fmt(ctx.tokens)} / ${fmt(ctx.contextWindow)}`],
    ['累计成本', typeof s.cost === 'number' ? '$' + s.cost.toFixed(4) : '—'],
  ];

  const box = document.createElement('div');
  box.className = 'stat-rows';
  for (const [k, v] of rows) {
    const r = document.createElement('div');
    const a = document.createElement('span');
    a.textContent = k;
    const b = document.createElement('b');
    b.textContent = v == null || v === '' ? '—' : String(v);
    r.append(a, b);
    box.appendChild(r);
  }
  card.appendChild(box);

  if (s.sessionFile) {
    const f = document.createElement('div');
    f.className = 'selected-path';
    f.textContent = s.sessionFile;
    card.appendChild(f);
  }
}

function openStatsPanel() {
  let slot = null;

  openModal((card, close) => {
    card.classList.add('wide');
    const h = document.createElement('h3');
    h.textContent = '会话统计';
    card.appendChild(h);

    slot = document.createElement('div');
    slot.innerHTML = '<div class="hint-empty">加载中…</div>';
    card.appendChild(slot);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const done = document.createElement('button');
    done.className = 'btn primary';
    done.textContent = '关闭';
    done.onclick = close;
    actions.appendChild(done);
    card.appendChild(actions);
  });

  S.onStats = (d) => {
    if (!slot) return;
    slot.innerHTML = '';
    renderStatsPanel(slot, d);
  };
  sendCommand({ type: 'get_session_stats' });
}

function renameSession() {
  openModal((card, close) => {
    const h = document.createElement('h3');
    h.textContent = '重命名会话';
    card.appendChild(h);

    const input = document.createElement('input');
    input.className = 'modal-input';
    input.placeholder = '例如 my-feature-work';
    input.value = S.state?.sessionName || '';
    card.appendChild(input);
    setTimeout(() => input.focus(), 30);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = '取消';
    cancel.onclick = close;

    const ok = document.createElement('button');
    ok.className = 'btn primary';
    ok.textContent = '保存';
    ok.onclick = () => {
      const name = input.value.trim();
      close();
      if (!name) return;
      setSessionName(name);
      setTitleText(name);
      el.footName.textContent = name;
      toast('已重命名为 ' + name, 'info');
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ok.click();
    });

    actions.append(cancel, ok);
    card.appendChild(actions);
  });
}

function openMoreMenu() {
  openModal((card, close) => {
    const h = document.createElement('h3');
    h.textContent = '更多';
    card.appendChild(h);

    const list = document.createElement('div');
    list.className = 'modal-list';

    const entries = [
      ['重命名会话', renameSession],
      ['导出会话 HTML', exportHtml],
      ['压缩上下文', compactNow],
      ['会话统计', () => {
        close();
        openStatsPanel();
      }],
      ['重载 pi 配置', () => {
        close();
        reloadPi();
      }],
    ];

    for (const [label, fn] of entries) {
      const item = document.createElement('div');
      item.className = 'modal-item';
      item.textContent = label;
      item.onclick = () => {
        if (fn !== renameSession) close();
        fn();
      };
      list.appendChild(item);
    }
    card.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const done = document.createElement('button');
    done.className = 'btn primary';
    done.textContent = '关闭';
    done.onclick = close;
    actions.appendChild(done);
    card.appendChild(actions);
  });
}

/* ---------- 事件绑定 ---------- */

el.input.addEventListener('input', () => {
  autoGrow();
  updateSendState();
});

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  } else if (e.key === 'Escape') {
    // 浮层开着时 Esc 先关浮层，别把正在跑的对话也停掉
    if (popVisible()) {
      closePop();
      return;
    }
    stop();
  }
});

// 输入区
el.btnSend.onclick = submit;
el.btnStop.onclick = stop;
el.btnModel.onclick = () => {
  if (popVisible() && currentAnchor() === el.btnModel) return closePop();
  openModelPicker();
};
el.btnThink.onclick = () => {
  if (popVisible() && currentAnchor() === el.btnThink) return closePop();
  openThinkPicker();
};

// 上下文占用：悬停出提示，带一点延迟避免扫过就闪
let ctxTimer = null;
el.btnCtx.addEventListener('mouseenter', () => {
  clearTimeout(ctxTimer);
  ctxTimer = setTimeout(openCtx, 110);
});
el.btnCtx.addEventListener('mouseleave', () => {
  clearTimeout(ctxTimer);
  ctxTimer = setTimeout(() => {
    if (!pop.matches(':hover')) closePop();
  }, 200);
});
pop.addEventListener('mouseleave', () => {
  if (pop.classList.contains('tip-mode')) closePop();
});
// 悬停已经会打开提示，此时再点一下不该把它关掉 —— 所以点击只在关闭时起作用
el.btnCtx.addEventListener('click', () => {
  if (!popVisible()) openCtxTip();
});

/* --- 附件 --- */

el.btnAttach.onclick = () => el.fileInput.click();

el.fileInput.onchange = () => {
  handleFiles(el.fileInput.files);
  el.fileInput.value = ''; // 允许连续选同一个文件
};

let dragDepth = 0;
el.composerBox.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  el.composerBox.classList.add('drop');
});
el.composerBox.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
el.composerBox.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) el.composerBox.classList.remove('drop');
});
el.composerBox.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.composerBox.classList.remove('drop');
  if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
});

// 粘贴图片：剪贴板里是文件才拦，纯文本照常交给 textarea
document.addEventListener('paste', (e) => {
  const files = e.clipboardData?.files;
  if (files && files.length) {
    e.preventDefault();
    handleFiles(files);
  }
});

// 顶栏
$('btnTree').onclick = openBranchPanel;
$('btnMore').onclick = openMoreMenu;
$('btnShare').onclick = exportHtml;
$('btnStats').onclick = openStatsPanel;

// 侧栏导航
$('navNew').onclick = newSession;
$('navBranches').onclick = openBranchPanel;
$('navChanges').onclick = openChangesPanel;
$('navProviders').onclick = openProvidersPanel;

// 侧栏头部 / 项目
// 「添加文件夹」在两处：侧栏分组下常年有一个，欢迎块上在未选项目时再补一个
$('btnReload').onclick = reloadPi;
$('btnCompact').onclick = compactNow;
$('btnAddProject').onclick = openDirPicker;
$('btnPickProject').onclick = openDirPicker;
$('btnProjectSettings').onclick = openProjectSettings;

// 扩展能力（Skills / MCP）—— 跨项目的入口，和「模型供应商」同一组
$('navExtensions').onclick = openExtensions;

// 项目分组折叠状态记忆
const group = $('groupHead').parentElement;
try {
  if (localStorage.getItem('pi-group-open') !== '0') group.classList.add('open');
} catch {
  group.classList.add('open');
}
$('groupHead').onclick = () => {
  group.classList.toggle('open');
  try {
    localStorage.setItem('pi-group-open', group.classList.contains('open') ? '1' : '0');
  } catch {
    /* 忽略隐私模式下的写入失败 */
  }
};

/* ---------- 启动 ---------- */

/* 欢迎块自动显隐。挂在整个对话区上（subtree），这样无论消息是从哪条路径
 * 进来的 —— 实时流式、历史重建、清空重画 —— 都能跟上。 */
new MutationObserver(syncWelcome).observe(el.stream, { childList: true, subtree: true });
syncWelcome();

loadProjects();
loadProviders();
/* 侧栏「扩展」右边那个数字：发现了几条 skill。
 * 只做展示，失败就留空 —— 这个数字不该在启动路径上弹任何错。 */
loadExtensionsBadge();
/* Git 工作区状态先拉一次，把侧栏的「文件变更 N」填上。
 * 失败也无所谓 —— 不是 Git 仓库、没装 git、还没选项目都是正常情况，
 * 面板会各自给出中性文案（见 git.js 的 renderChangesBody）。 */
loadGitStatus();
autoGrow();
/* 先按「还没选项目」摆一次，锁住输入区。
 * 真的有项目时 loadStatus 会立刻把它打开 —— 那一瞬间两块引导都是藏着的，
 * 所以不会闪出错误文案（页面里的默认态也是都藏，见 index.html 的说明）。 */
applyProjectState();
updateSendState();
renderAttachments();
renderCtxChip();
el.input.focus();

// 先拿到 cwd 再连事件流，保证导出提示里的路径一开始就是绝对的
loadStatus().then(connect);
