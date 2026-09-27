/* 会话 → 任务 的反向关联提示（P7 §8）。
 *
 * ---------- 为什么是一个独立的小模块 ----------
 *
 * 这段 UI 挂在**会话标题旁边**，数据却来自 Planner（plan 文件里的 attempt.sessionId）。
 * 让 sessions.js 直接去读 Planner 的数据会越界（会话模块不该认识计划），
 * 让 planner.js 去管标题栏又会把「面板」和「外壳」搅在一起。所以单独一个模块，
 * 两边都只通过它交互。
 *
 * ---------- 四条刻意的取舍 ----------
 *
 * 1. **没有关联就完全不显示。** 绝大多数会话不属于任何任务，常驻一行
 *    「无关联任务」纯属噪声。所以 host 默认 hidden，只在真的有命中时才显形。
 *
 * 2. **不做成大卡片，也不插进消息流。** 它只是一个窄条：`关联任务 · 计划名 · 任务名`。
 *    会话正文区是用户的对话，不该被系统信息挤占。
 *
 * 3. **数据来源是 `/api/plans/relations`，只读关系、不读会话正文。**
 *    后端按 projectRoot 过滤，所以这里拿到的天然只有当前项目的任务。
 *
 * 4. ⚠️ **stale 保护必须做两层**：`token` 挡乱序返回（连着切两个会话时，
 *    先发的请求可能后回来），`workspaceGeneration` 挡切项目（A 项目的关联
 *    绝不能画到 B 项目的界面上）。这和 session-search 那边是同一套规矩 ——
 *    少了任何一层都会出现「切换后短暂显示上一个上下文的关联」。
 */
import { fetchSessionPlans } from './api.js';
import { S, ownsWorkspace } from './state.js';
import { openPlanner } from './planner.js';

/** 收起时只显示一条（多任务时给「展开」）。 */
const COLLAPSED = 1;

let host = null;
let token = 0;
let currentSessionId = '';
let expanded = false;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

/** 由 app.js 在装配阶段把标题旁的那个容器交给本模块。 */
export function mountSessionPlans(node) {
  host = node || null;
}

/** 换项目 / 没有会话时清空。**不请求**，只负责把界面收干净。 */
export function clearSessionPlans() {
  currentSessionId = '';
  expanded = false;
  token++; // 让在途的响应作废
  if (host) {
    host.replaceChildren();
    host.hidden = true;
  }
}

/**
 * 按当前会话的 pi 会话 id 拉一次关联。
 *
 * @param sessionId pi 的会话 id（会话列表接口给的 `sessionId` 字段）。
 *                  新会话还没落盘时它是空串 → 直接不显示。
 */
export async function refreshSessionPlans(sessionId) {
  if (!host) return;
  const id = typeof sessionId === 'string' ? sessionId : '';
  if (!id) {
    clearSessionPlans();
    return;
  }
  if (id === currentSessionId) return; // 同一个会话不重复请求
  currentSessionId = id;
  expanded = false;
  const gen = S.workspaceGeneration;
  const my = ++token;
  host.replaceChildren();
  host.hidden = true;

  let r;
  try {
    r = await fetchSessionPlans(id);
  } catch {
    return; // 关联信息拿不到就不显示 —— 它不该影响会话本身的任何功能
  }
  // 乱序返回 / 切了项目 / 又切了会话 —— 三种都丢弃
  if (my !== token || !ownsWorkspace(gen) || id !== currentSessionId) return;
  if (!r || !r.ok) return;
  const matches = Array.isArray(r.matches) ? r.matches : [];
  if (!matches.length) return;
  render(matches);
}

function render(matches) {
  if (!host) return;
  host.replaceChildren();

  host.append(el('span', 'sp-label', matches.length > 1 ? `关联 ${matches.length} 个任务` : '关联任务'));

  const shown = expanded ? matches : matches.slice(0, COLLAPSED);
  for (const m of shown) {
    const row = el('span', 'sp-row');
    row.append(el('span', 'sp-plan', m.planTitle || '（未命名计划）'));
    row.append(el('span', 'sp-task', `${m.taskTitle || m.taskId} · 第 ${m.attempt} 次`));
    const b = el('button', 'sp-open', '查看任务');
    b.type = 'button';
    /* 直接打开 Planner 并定位到那个任务 —— 不新开一个「关联详情」弹层，
     * 用户想看的就是那个任务本身。 */
    b.onclick = () => openPlanner({ planId: m.planId, taskId: m.taskId });
    row.append(b);
    host.append(row);
  }

  if (matches.length > COLLAPSED) {
    const t = el('button', 'sp-toggle', expanded ? '收起' : `展开全部 ${matches.length} 条`);
    t.type = 'button';
    t.onclick = () => {
      expanded = !expanded;
      render(matches);
    };
    host.append(t);
  }

  host.hidden = false;
}
