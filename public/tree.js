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

function entryText(entry) {
  if (!entry) return '（空条目）';
  const role = entry.role || entry.type || '';
  let text = '';
  const c = entry.content;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) text = c.filter((x) => x.type === 'text').map((x) => x.text).join(' ');
  if (!text) text = entry.text || entry.message || '';
  const who = role === 'user' ? '你' : role === 'assistant' ? 'Pi' : role || '条目';
  const body = String(text).replace(/\s+/g, ' ').trim().slice(0, 56);
  return body ? `${who}：${body}` : who;
}

function countNodes(list) {
  let n = 0;
  for (const x of list) {
    n += 1;
    if (x.children?.length) n += countNodes(x.children);
  }
  return n;
}

export function applyTree(data) {
  const nodes = Array.isArray(data) ? data : data?.tree || [];
  S.treeData = nodes;

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
    box.innerHTML = '<div class="hint-empty">还没有分支记录。对话开始后，每个可回溯的节点都会出现在这里。</div>';
    return;
  }

  const walk = (list, depth) => {
    for (const n of list) {
      const div = document.createElement('div');
      div.className = 'tree-node';
      div.style.paddingLeft = 6 + depth * 12 + 'px';

      const txt = document.createElement('span');
      txt.className = 'tree-text';
      txt.textContent = entryText(n.entry);
      if (n.label) {
        const lb = document.createElement('span');
        lb.className = 'tree-label';
        lb.textContent = n.label;
        txt.appendChild(lb);
      }
      div.appendChild(txt);

      const id = n.entry?.id;
      if (id) {
        div.title = '点击从此节点分叉';
        div.onclick = () => {
          closeModal();
          onFork(id);
        };
      }
      box.appendChild(div);
      if (n.children?.length) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
}

export function openBranchPanel() {
  openModal((card, close) => {
    card.classList.add('wide');

    const h = document.createElement('h3');
    h.textContent = '分支';
    card.appendChild(h);

    const desc = document.createElement('div');
    desc.className = 'modal-desc';
    desc.textContent = '当前会话的所有可回溯节点。点击任意节点即可从该处分叉，开启一条新的支线。';
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
