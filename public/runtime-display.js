/* UI-2B：Runtime 的**只读展示投影** —— thinking 文本与单轮 usage。
 *
 * ---------- 它为什么存在 ----------
 *
 * `runtime-store.js` 是 runtime 真相的唯一事实源；它保存有界执行时间线
 * （计划、思考、工具、正文）与生命周期/审批。本模块只做两件展示层的事：
 *   1. 从 store 已接受的时间线里取当前 assistant 消息的 thinking 文本，
 *      并按展示上限再截断一次；
 *   2. 从 `message_update` / `message_end` 里读 Pi 报过的单轮 usage。
 *
 * ---------- 它不是第二个事实源 ----------
 *
 *   1. 只订阅 `onRuntimeChange`，也就是 store **接受并广播**的那些帧。store 拒掉的
 *      帧（owner 不符 / eventSequence 不前进 / 旧 generation / `_replay`）根本不会
 *      到达这里，所以本模块不可能接受一条 store 不认的帧。
 *   2. thinking 文本不在这里另存一份：`thinkingOf()` 直接读 store 时间线里
 *      `agent` 当前 thinking block。这里只做「展示上限」这一层裁剪。
 *   3. 不写 store 的任何字段，不发任何请求，不碰 DOM，不碰 pi。
 *
 * ---------- 数据从哪来（上游证据）----------
 *
 *   - `server/session-runtime.js` 只把 `toolcall_*` 收窄成 `{type,contentIndex}`；
 *     `thinking_start/delta/end` 原样转发，`delta` / `content` 都在。
 *   - `server/model-generation.js` 只替换 `partial` / `error`，`delta` 保留。
 *   - Pi `docs/json.md`：`message_update.usage` 是**该条回复的累计** usage，供应商
 *     流式期间可能一直报 0；`message_end.message` 是权威终值，其 `content` 里
 *     thinking 块的形状是 `{type:'thinking', thinking:string}`。
 *   - 工具的 args / result 正文在 `projectRuntimeEvent` 里已被剥掉，本模块
 *     **不去恢复**它们，也不解析正文去猜。
 *
 * ---------- usage 的两条取舍 ----------
 *
 *   - 只显示 Pi 报过的数字。缺字段就是缺字段，**不补 0**；`cost` 不带货币
 *     符号 —— 线上没有货币单位，凭空补 `$` 是编造单位（见 docs/usage-quota.md）。
 *   - `message_end` 的终值缺失时清掉临时值，不继续声称「仍在累计」。
 */

import { runtimeStore, onRuntimeChange } from './runtime-state.js';

const DEFAULT_MAX_THINKING_BYTES = 64 * 1024;  // 每会话 thinking 展示上限
const DEFAULT_MAX_CONVERSATIONS = 64;          // 同时保留记录的会话数上限

const USAGE_KEYS = [
  ['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读'], ['cacheWrite', '缓存写'],
  ['cacheWrite1h', '缓存写(1h)'], ['reasoning', '推理'], ['totalTokens', '合计'],
];
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const tokenNumber = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** 与 runtime-store 同一条有界策略：按**字节**留末尾，不切出半个字符。 */
function boundText(text, limit) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return { text, truncated: false };
  return { text: new TextDecoder().decode(bytes.slice(-limit)).replace(/^�+/, ''), truncated: true };
}

/** 只认 Pi 报过的数字；一个有效数字都没有就返回 null（缺字段 ≠ 0）。 */
export function readUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const [key] of USAGE_KEYS) { const value = tokenNumber(raw[key]); if (value !== null) out[key] = value; }
  const cost = number(raw.cost?.total);
  if (cost !== null) out.costTotal = cost;
  return Object.keys(out).length ? out : null;
}

/** 从 `message_end.message.content` 取权威 thinking 文本；没有 thinking 块时返回 null。 */
export function thinkingText(content) {
  if (!Array.isArray(content)) return null;
  const parts = content.filter(c => c?.type === 'thinking' && typeof c.thinking === 'string');
  return parts.length ? parts.map(c => c.thinking).join('\n\n') : null;
}

const grouped = value => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 展示用的一行用量文案。纯函数，便于直接断言格式与「缺字段就不出现」。 */
export function usageText(stats) {
  if (!stats) return '';
  const parts = [];
  for (const [key, label] of USAGE_KEYS) { const value = tokenNumber(stats[key]); if (value !== null) parts.push(`${label} ${grouped(value)}`); }
  const cost = number(stats.costTotal);
  if (cost !== null) parts.push(`预估成本 ${cost.toFixed(4)}`);   // 不补货币符号：线上没有单位
  if (!parts.length) return '';
  const provisional = stats.source === 'message_update' ? '（流式中，Pi 仍在累计）' : '';
  return `本轮 · ${parts.join(' · ')}${provisional}`;
}

/** 距底 160px 以内算「还在看最新」——与 Classic `messages.js:78` 同一条规则。
 *  纯函数：给定三个数就能判，便于直接断言边界，不必依赖 jsdom 的假布局。 */
export function shouldFollow(node) { return node.scrollHeight - node.scrollTop - node.clientHeight < 160; }

export function createRuntimeDisplay({ store = runtimeStore, subscribe = onRuntimeChange,
  maxThinkingBytes = DEFAULT_MAX_THINKING_BYTES, maxConversations = DEFAULT_MAX_CONVERSATIONS } = {}) {
  const records = new Map();          // conversationId -> usage 投影记录
  const conversationLimit = Math.max(1, maxConversations);
  let alive = true;

  const ownerKeyOf = owner => owner ? JSON.stringify(owner) : null;
  function blank(ownerKey, storeRecord) { return { ownerKey, storeRecord, cursor: 0, usage: null, usageSource: null }; }

  function recordFor(id, owner) {
    const ownerKey = ownerKeyOf(owner);
    const current = store.get(id);
    if (!current) { records.delete(id); return null; }
    let record = records.get(id);
    if (!record) { record = blank(ownerKey, current); records.set(id, record); }
    /* 换**runtime 身份**（重启 / 恢复 / 关闭后再起）就是另一条运行，旧记录一律作废。
     * owner 变成 null（关闭）时**不**重置 —— 与 runtime-store 对 text/tools 的处理一致：
     * 关闭后仍能读到上一次观察到的内容，直到下次真的换了 runtime 或权威快照重来。 */
    else if (record.storeRecord !== current || ownerKey !== null && record.ownerKey !== ownerKey) { record = blank(ownerKey, current); records.set(id, record); }
    /* 有界内存：只保留最近用到的若干条会话记录。 */
    while (records.size > conversationLimit) records.delete(records.keys().next().value);
    return record;
  }

  /* 与 store 对齐：**权威快照**（seedRuntimeSnapshot 广播时不带帧）可能换了 owner，
   * 而 store 在那种情况下会用 fresh() 清掉时间线。投影收不到帧，只能主动核对：
   * 会话当前的 owner 非空且与本记录的 owner 不同 → 这条记录属于上一个 runtime，丢掉。
   * owner 为空（关闭）时**保留** —— store 也保留时间线。 */
  function reconcile() {
    for (const [id, record] of [...records]) {
      const key = ownerKeyOf(store.get(id)?.owner);
      if (store.get(id) !== record.storeRecord || key !== null && key !== record.ownerKey) records.delete(id);
    }
  }

  function apply(frame) {
    if (!alive) return;
    if (!frame) { reconcile(); return; }
    if (frame.type === 'runtime_closed') return;   // 保留：store 也保留时间线
    if (frame.type !== 'runtime_event') return;
    const id = frame.owner?.conversationId;
    if (!id) return;
    const record = recordFor(id, frame.owner);
    if (!record) return;
    /* 纵深防御：广播只发生在 store 接受之后，序号本该严格递增；这里再挡一次。 */
    if (!Number.isInteger(frame.eventSequence) || frame.eventSequence <= record.cursor) return;
    record.cursor = frame.eventSequence;
    const event = frame.event;
    if (!event || typeof event.type !== 'string') return;

    if (event.type === 'message_start') {
      /* 新的一条助手消息 = 新的本轮 usage；用户消息不清。 */
      if (event.message?.role === 'assistant') {
        record.usage = null; record.usageSource = null;
      }
      return;
    }
    if (event.type === 'message_update') {
      const usage = readUsage(event.usage);
      if (usage) { record.usage = usage; record.usageSource = 'message_update'; }
      return;
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const usage = readUsage(event.message.usage);
      record.usage = usage; record.usageSource = usage ? 'message_end' : null;
    }
  }

  /* 读之前再核对一次 runtime 身份：换代（重启/恢复）之后 store 里 owner 已经变了，
   * 不该继续把旧 runtime 的 usage 显示成新 runtime 的。
   * owner 为空（关闭）时**照常返回** —— store 关掉后也还留着时间线。 */
  function live(id) {
    if (!alive) return null;
    const record = records.get(id);
    if (!record) return null;
    const key = ownerKeyOf(store.get(id)?.owner);
    return store.get(id) !== record.storeRecord || key !== null && key !== record.ownerKey ? null : record;
  }

  function thinkingBlockOf(id) {
    const current = store.get(id);
    if (!current) return null;
    /* store 在 message_start assistant 时清空当前指针；用户消息不会清掉上一条
     * 已观察到的思考，直到新的 assistant 消息真的开始。这样展示语义与旧投影一致。 */
    return current.thinkingBlock || null;
  }

  const unsubscribe = subscribe(apply);
  return {
    thinkingOf(id) {
      if (!live(id)) return null;
      const block = thinkingBlockOf(id);
      if (!block || typeof block.text !== 'string' || !block.text) return null;
      const bounded = boundText(block.text, maxThinkingBytes);
      return { text: bounded.text, truncated: block.truncated === true || bounded.truncated, state: block.state || null };
    },
    usageOf(id) { const record = live(id); return record?.usage ? { ...record.usage, source: record.usageSource } : null; },
    dispose() { alive = false; unsubscribe(); records.clear(); },
  };
}
