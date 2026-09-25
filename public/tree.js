/* 分支树。
 *
 * pi 的会话是一棵 append-only 的条目树（get_tree），每个节点都能「从此处
 * 分叉」开一条新支线（fork）。这是 pi 相对普通聊天界面最有价值的差异点，
 * 所以单独成模块。
 *
 * 注意这里**不 import rpc.js**：分叉动作由调用方以 onFork 回调传进来。
 * 否则会形成 rpc → tree（applyTree）与 tree → rpc（forkFrom）的循环依赖。 */

import { el, panels, S } from './state.js';
import { sendCommand } from './api.js';
import { closeModal, openModal } from './ui/modal.js';
import { toast } from './ui/toast.js';

const CLIP = 56;

function clip(s, max = CLIP) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

/* 内容块 → 一行文本。pi 的 content 既可能是字符串，也可能是
 * [{type:'text',text},…]（还可能混着 toolCall / thinking 块）。
 * 非文本块给一个短标记而不是丢掉 —— 一条「只有工具调用」的消息
 * 如果什么都不显示，节点就变成空白行。 */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'toolCall') out.push('调用 ' + (p.name || p.toolName || '工具'));
    else if (p.type === 'toolResult') out.push('工具结果');
    else if (p.type === 'thinking') out.push('（思考）');
    else if (typeof p.text === 'string' && p.text) out.push(p.text);
  }
  return out.join(' ');
}

const ROLE_LABEL = { user: '你', assistant: 'Pi', toolResult: '工具结果', system: '系统' };

function shortId(id) {
  return typeof id === 'string' && id ? id.slice(0, 8) : '';
}

/* 条目 → 一行可读文本。
 *
 * ⚠️ pi 的条目形状**不是统一的**，每种类型字段都不一样（依据 pi 源码
 * `dist/bundle/chunks/chunk-4DKZACXI.js` 的 append* 系列）：
 *
 *   message                { message: { role, content } }   ← 消息体是嵌套的
 *   model_change           { provider, modelId }
 *   thinking_level_change  { thinkingLevel }
 *   context_edit           { targetId, replacement }
 *   session_info           { name }
 *   label                  { targetId, label }
 *   compaction             { summary, tokensBefore }
 *   usage                  { kind, provider, model }
 *   custom / custom_message{ customType, content }
 *
 * 这里最初只读顶层的 `role` / `content`，而消息体其实在 `entry.message` 里 ——
 * 取不到就落到 `String(对象)`，于是真实会话里**每个消息节点都渲染成
 * 「message: [object Object]」**，整棵树等于没有信息。
 *
 * 现在**两种形状都认**（嵌套优先、顶层兜底）：pi 将来若改回扁平形状，
 * 也只是少一层解包，不会静默退化成 [object Object]。 */
export function entryText(entry, max = CLIP) {
  if (!entry || typeof entry !== 'object') return '（空条目）';
  const type = String(entry.type || '');

  if (type === 'message' || entry.role) {
    const m = entry.message && typeof entry.message === 'object' ? entry.message : entry;
    const role = String(m.role || entry.role || '');
    const who = ROLE_LABEL[role] || role || '消息';
    const body = clip(contentText(m.content) || m.text || '', max);
    return body ? `${who}：${body}` : who;
  }

  switch (type) {
    case 'model_change': {
      const id = [entry.provider, entry.modelId].filter(Boolean).join('/');
      return id ? `模型 → ${clip(id, max)}` : '模型切换';
    }
    case 'thinking_level_change':
      return entry.thinkingLevel ? `思考档位 → ${clip(entry.thinkingLevel, max)}` : '思考档位切换';
    case 'context_edit': {
      const t = shortId(entry.targetId);
      const what = entry.replacement == null ? '还原上下文' : '编辑上下文';
      return t ? `${what} → ${t}` : what;
    }
    case 'session_info':
      return entry.name ? `会话名 → ${clip(entry.name, max)}` : '会话名';
    case 'label':
      return entry.label ? `标签 → ${clip(entry.label, max)}` : '清除标签';
    case 'compaction':
      return typeof entry.tokensBefore === 'number' ? `压缩摘要（${entry.tokensBefore} tokens）` : '压缩摘要';
    case 'usage':
      return entry.kind ? `用量（${clip(entry.kind, max)}）` : '用量';
    case 'custom':
    case 'custom_message': {
      const body = clip(contentText(entry.content) || entry.customType || '', max);
      return body ? `自定义：${body}` : '自定义条目';
    }
    default: {
      const body = clip(entry.text || entry.name || '', max);
      return body || type || '条目';
    }
  }
}

function countNodes(list) {
  let n = 0;
  for (const x of list) {
    n += 1;
    if (x.children?.length) n += countNodes(x.children);
  }
  return n;
}

/* 哪些条目算「对话」。
 *
 * pi 的树里混着大量**操作类**条目：model_change / thinking_level_change /
 * usage / context_edit / label / session_info / compaction。它们不是对话内容，
 * 列出来只会把真正的提问淹没掉（用户原话：「像切换模型这些操作就不用记录了」）。
 * 所以只留参与对话的 message / custom_message。
 *
 * ⚠️ 隐藏一个节点时，它的子节点必须**接到最近的可见祖先上** ——
 * 直接跳过整棵子树是不行的：pi 的条目是一条 parentId 链，
 * 一次 model_change 夹在两条消息中间，跳过它就会把后面整段对话切掉。 */
const CONVERSATION_TYPES = new Set(['message', 'custom_message']);

function isConversation(n) {
  const e = n && n.entry;
  if (!e || typeof e !== 'object') return false;
  // 扁平的顶层形状（role/content 在条目上）也认，见 entryText 的说明
  if (e.role) return true;
  return CONVERSATION_TYPES.has(String(e.type || ''));
}

function toVisibleForest(list) {
  const out = [];
  for (const n of list || []) {
    const kids = toVisibleForest(n.children || []);
    if (isConversation(n)) out.push({ ...n, children: kids });
    else out.push(...kids);
  }
  return out;
}

export function applyTree(data) {
  const raw = Array.isArray(data) ? data : data?.tree || [];
  const nodes = toVisibleForest(raw);
  S.treeData = nodes;

  /* 计数跟着列表走 —— 徽标回答的是「这里有几次对话可以回溯」，
   * 不是「会话文件里有多少条记录」。 */
  const total = countNodes(nodes);
  el.branchCount.textContent = total ? String(total) : '';

  if (panels.tree) renderTree(nodes, panels.tree);
}

/* 分叉回调。由 app.js 在装配阶段注入 —— 见文件头的说明。
 * 用注册而不是 import：applyTree 会在弹层开着时被 rpc.js 重新触发，
 * 需要拿到同一个回调，传参反而绕。 */
let onFork = () => {};
export function setForkHandler(fn) {
  onFork = fn;
}

export function renderTree(nodes, box) {
  box.innerHTML = '';

  if (!nodes.length) {
    box.innerHTML = '<div class="hint-empty">还没有可回溯的对话。这里只列你的提问与 Pi 的回答，切换模型之类的操作不会出现在这里。</div>';
    return;
  }

  /* 左对齐、不按深度递进缩进。
   *
   * 原来每深一层 paddingLeft +12px，长会话会一路斜到右边去 —— 而 pi 的条目
   * 是一条 parentId 链，绝大多数会话本来就是直的，阶梯没有带来任何信息。
   * 真正需要「结构」的只有分叉点，所以改成：**全部左对齐 + 在分叉处标一下**。 */
  const walk = (list) => {
    for (const n of list) {
      const div = document.createElement('div');
      div.className = 'tree-node';

      const short = entryText(n.entry);
      const full = entryText(n.entry, 240);

      const txt = document.createElement('span');
      txt.className = 'tree-text';
      txt.textContent = short;
      if (n.label) {
        const lb = document.createElement('span');
        lb.className = 'tree-label';
        lb.textContent = n.label;
        txt.appendChild(lb);
      }
      div.appendChild(txt);

      const branches = (n.children || []).length;
      if (branches > 1) {
        const fk = document.createElement('span');
        fk.className = 'tree-fork';
        fk.textContent = `${branches} 条支线`;
        div.appendChild(fk);
      }

      const id = n.entry?.id;
      if (id) {
        /* 节点文本截到 56 字，两条开头相似的消息会看不出区别 ——
         * 悬停给出完整那行，再补上可点击的说明。 */
        div.title = full === short ? '点击从此节点分叉' : `${full}\n点击从此节点分叉`;
        div.onclick = () => {
          closeModal();
          onFork(id);
        };
      } else {
        div.classList.add('static');
        if (full !== short) div.title = full;
      }
      box.appendChild(div);
      if (branches) walk(n.children);
    }
  };
  walk(nodes);
}

export function openBranchPanel() {
  openModal((card, close) => {
    /* tree-modal：标题 / 说明 / 按钮固定，只有树体滚动。
     * 原来整张卡片滚，节点一多底部按钮就被滚出可视区 —— 想关掉得先滚到底。 */
    card.classList.add('wide', 'tree-modal');

    const h = document.createElement('h3');
    h.textContent = '分支';
    card.appendChild(h);

    const desc = document.createElement('div');
    desc.className = 'modal-desc';
    desc.textContent = '当前会话里可回溯的对话。点击任意一条即可从该处分叉，开启一条新的支线。切换模型、调整思考档位这类操作不会列在这里。';
    card.appendChild(desc);

    const box = document.createElement('div');
    box.className = 'tree';
    card.appendChild(box);

    panels.tree = box;
    if (S.treeData.length) renderTree(S.treeData, box);
    else box.innerHTML = '<div class="hint-empty">加载中…</div>';

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const refresh = document.createElement('button');
    refresh.className = 'btn';
    refresh.textContent = '刷新';
    refresh.onclick = () => sendCommand({ type: 'get_tree' });

    const clone = document.createElement('button');
    clone.className = 'btn';
    clone.textContent = '复制当前分支';
    clone.onclick = () => {
      sendCommand({ type: 'clone' });
      close();
      toast('已复制当前分支', 'info');
    };

    const done = document.createElement('button');
    done.className = 'btn primary';
    done.textContent = '关闭';
    done.onclick = close;

    actions.append(refresh, clone, done);
    card.appendChild(actions);
  });

  sendCommand({ type: 'get_tree' });
}
