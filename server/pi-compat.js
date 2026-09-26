/* Pi 兼容层。
 *
 * ---------- 它解决的问题 ----------
 *
 * Pi GUI 对 pi 的依赖一直是**隐式**的：某个 RPC 字段改个名、某个事件不再发、
 * 会话文件多一层嵌套 —— 表现是「某几个功能静默失效」，而用户分不清是 Pi GUI 的
 * bug 还是 pi 版本不兼容。这个模块把那些依赖变成**显式、可观察、可测试、可降级**的。
 *
 * ---------- 三条不能破的规矩 ----------
 *
 * 1. **版本号只是证据，能力才是事实。** 不要写 `if (version >= '0.90') compatible`——
 *    同版本可能有构建差异，新版本可能仍兼容旧协议，fork / 自定义实现可能版本号
 *    完全不同却完全兼容 RPC。所以判断只依据**实际观察到的 response / event 形状**。
 *
 * 2. **「没观察到」不等于「不存在」。** 一个会话里没有 `session_info` 只说明那个
 *    会话没改过名，**不能**据此判定 pi 不支持改名。所以能力是三值的：
 *    `true` 观察到能用 / `false` 观察到不能用 / `null` 还没观察到。
 *    文件侧的观察**只能把能力置 true**，false 只由**明确的失败**产生
 *    （RPC 回 success:false、spawn 报错）。
 *
 * 3. **异常记录里绝不存 payload。** 只记结构（字段名、期望形状、实际类型/键名）。
 *    这个对象会原样进 Diagnostics，而 Diagnostics 可能被贴进 issue ——
 *    用户正文、prompt、模型回复、密钥一个字节都不能进来。
 *
 * ---------- 为什么没有正式的 handshake ----------
 *
 * pi 的 RPC 没有版本协商，也**不该为此造一个协议**。兼容证据来自现有链路里
 * 本来就会发生的对话：bridge 起来（rpc）、启动时问 get_state / get_messages、
 * 列会话时读会话文件。所以这里是**被动累积**，不额外发任何请求 ——
 * 也就不会产生模型调用、不花额度、不改 session、不增加启动延迟。
 *
 * 全部证据都来自本机，**不联网**（不查 npm registry / GitHub / 官网）。
 */

/* 报告里的能力集。
 * 顺序即界面展示顺序：核心在前。 */
export const CAPABILITIES = Object.freeze([
  'rpc',
  'getState',
  'getMessages',
  'newSession',
  'switchSession',
  'sessionNaming',
  'toolEvents',
  'extensionUi',
  'sessionJsonl',
]);

/* 缺了就**整个集成不成立**的能力 —— 只有这些缺失才判 incompatible。
 *
 * 其余能力缺失一律判 partial 并局部降级：
 *   get_messages 缺 → 历史重建降级；switch_session 缺 → 禁用切换；
 *   sessionNaming 缺 → 隐藏改名；toolEvents 不完整 → 时间线说明一下。
 * 这些都不该让应用崩，也不该让状态变成「不兼容」。 */
const ESSENTIAL = Object.freeze(new Set(['rpc', 'getState']));

/** RPC 命令 → 能力。没列的命令只用于查异常，不进报告。 */
const COMMAND_CAPABILITY = Object.freeze({
  get_state: 'getState',
  get_messages: 'getMessages',
  new_session: 'newSession',
  switch_session: 'switchSession',
  set_session_name: 'sessionNaming',
});

/** pi 事件 → 能力（正向证据）。 */
const EVENT_CAPABILITY = Object.freeze({
  tool_execution_start: 'toolEvents',
  tool_execution_end: 'toolEvents',
  extension_ui_request: 'extensionUi',
});

/* pi **已知会发**的事件类型。
 *
 * 不在这里的 → 记一条 `unknown-event` 异常（**不是**错误，只是让它可见）。
 * 这样 pi 哪天加了新事件，Diagnostics 里能看见，而不是「静默地什么都没发生」。
 *
 * 注意这只是「已知存在」的清单，不是「我们会处理」的清单 —— 前端对不认识的事件
 * 本来就是安全忽略的（public/app.js 的 switch default）。 */
const KNOWN_EVENTS = Object.freeze(
  new Set([
    'response',
    'message_start',
    'message_update',
    'message_end',
    'tool_execution_start',
    'tool_execution_update',
    'tool_execution_end',
    'agent_start',
    'agent_end',
    'agent_settled',
    'auto_retry_start',
    'auto_retry_end',
    'compaction_start',
    'compaction_end',
    'compaction',
    'extension_ui_request',
    'extension_error',
    'session_info',
    'model_change',
    'thinking_level_change',
    'usage',
    'context_edit',
    'label',
    'custom',
    'custom_message',
  ])
);

/* 我们**期望**的应答信封契约版本。
 *
 * ⚠️ 这是 **Pi GUI 自己的期望标记**，不是 pi 声明的版本 —— pi 的 RPC 没有版本协商。
 * 只有当「应答信封该长什么样」这个期望本身变了才 +1。
 * observed 在第一次看到合法信封时置为同一个值。 */
const ENVELOPE_PROTOCOL = 1;

/** 异常环形缓冲的上限。 */
const MAX_ANOMALIES = 20;

/** 单个键名最长保留多少个字符（防止把用户数据当键名带进来）。 */
const MAX_KEY_LEN = 40;

/** 只保留「结构与类型」的信息，绝不保留值本身。
 *  数组给长度，对象给键名，其余给 typeof。 */
function describe(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return `object{${Object.keys(value).slice(0, 8).map(safeKey).join(',')}}`;
  return typeof value;
}

function safeKey(k) {
  const s = String(k).replace(/[^\w.\-[\]]/g, '');
  return s.length > MAX_KEY_LEN ? s.slice(0, MAX_KEY_LEN) + '…' : s;
}

/* ---------- 会话形状的规范化（对外导出）----------
 *
 * pi 有两处「消息体可能嵌套、也可能在顶层」的形状差异：
 *   - 会话 JSONL 条目：`{type:'message', message:{role,content}}`（真实形状）
 *   - `get_tree` 的条目：同样是 `entry.message`
 * 这个判断原本在 server/sessions.js 与 server/session-search.js 各写了一遍
 * （前端 public/tree.js 还有一份，跨进程没法共用）。收到这里，服务端只有一处。
 */

/**
 * 从会话 JSONL 条目（或 get_tree 条目）里取出消息体。
 * @returns {{role:string|undefined, content:any}|null}
 */
export function sessionMessageBody(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const inner = entry.message;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner;
  return entry; // 兼容「role/content 摆在顶层」的旧/自定义形状
}

/**
 * `get_messages` 的应答体 → 消息数组。
 *
 * 现状是数组或 `{messages:[…]}` 两种都认（前端 messages.js 也一样）。
 * 放在这里是为了以后形状再变时只改一处。
 */
export function messagesList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.messages)) return data.messages;
  return [];
}

/**
 * `get_state` 的应答体 → 用得上的那几个字段。
 *
 * 原本 sessions.js 里有两处各判一遍「这个应答能不能用」（都看 sessionFile），
 * 收到这里一处。**sessionFile 是判据**：没有它就定位不到当前会话。
 */
export function piState(data) {
  if (!data || typeof data !== 'object' || data.__error) return { ok: false };
  const sessionFile = typeof data.sessionFile === 'string' && data.sessionFile ? data.sessionFile : null;
  return {
    ok: Boolean(sessionFile),
    sessionFile,
    sessionId: typeof data.sessionId === 'string' ? data.sessionId : null,
    sessionName: typeof data.sessionName === 'string' ? data.sessionName : null,
    messageCount: typeof data.messageCount === 'number' ? data.messageCount : null,
  };
}

/* ---------- 主体 ---------- */

export function createPiCompat({ piVersionProbe = null, now = () => Date.now() } = {}) {
  /** 能力 → true / false / null（未观察到）。 */
  const caps = {};
  for (const k of CAPABILITIES) caps[k] = null;

  /** 环形缓冲：只存结构。 */
  const anomalies = [];
  let envelopeSeen = false;
  /* 「进程起来了，但还没说过话」。
   * 为什么需要它：Windows 上 pi 是经 shell 启动的，而 **cmd.exe 对不存在的命令
   * 启动是成功的** —— 它会先报「不是内部或外部命令」再退出。所以
   * `bridge_status: ready` 只证明**外壳**起来了，不证明 pi 真的在跑。
   * 真实场景实测过：PI_BIN 指向不存在的命令时，只看 ready 会把 rpc 判成 true、
   * 整个状态判成 compatible（错的）。 */
  let readyPending = false;
  /** 这个进程生命周期内收到过**合法信封**吗 —— 那才是通道真的通了的证据。 */
  let everTalked = false;
  let sawAnyEvidence = false;

  function record(category, operation, issue, extra = {}) {
    const item = { at: now(), category, operation, issue };
    if (extra.field) item.field = String(extra.field).slice(0, MAX_KEY_LEN);
    if (extra.expected) item.expected = describe(extra.expected);
    if (extra.actual !== undefined) item.actual = describe(extra.actual);
    anomalies.push(item);
    // 环形：超了就丢最旧的
    while (anomalies.length > MAX_ANOMALIES) anomalies.shift();
  }

  function setCap(key, value) {
    if (!CAPABILITIES.includes(key)) return;
    // 只允许「从未知变成已知」或被更新的失败覆盖成功？不 —— 失败优先，
    // 因为一次明确的 success:false 比一次成功更能说明问题。
    if (value === false) caps[key] = false;
    else if (caps[key] !== false) caps[key] = value;
  }

  /**
   * bridge 的生命周期。所有参数都来自已有的 `bridge_status` 事件。
   *
   * 状态词汇（规格 §12 那套）在这里派生，不另造链路：
   *   ready            → rpc-ready（rpc = true）
   *   error            → spawn-failed（rpc = false）
   *   exited 且从未 ready → rpc-start-failed（rpc = false）
   *   exited 但 ready 过   → 只是崩了，**不翻能力**，记一条异常
   *   no-project       → 与 pi 无关，什么都不记
   */
  function observeBridge({ state, error, code } = {}) {
    if (state === 'ready') {
      sawAnyEvidence = true;
      /* **不在这里置 rpc = true。** ready 只说明外壳起来了（见 readyPending 的说明），
       * 要等真的收到 pi 的消息才算通道通了。 */
      readyPending = true;
      everTalked = false;
      return;
    }
    if (state === 'error') {
      sawAnyEvidence = true;
      setCap('rpc', false);
      record('bridge', 'spawn', 'spawn-failed', { actual: error ? 'error-event' : undefined });
      readyPending = false;
      return;
    }
    if (state === 'exited') {
      sawAnyEvidence = true;
      if (!everTalked) {
        /* 起来了却一句话都没说过就退出 —— 这就是「RPC 没起来」。
         * 覆盖两种情形：spawn 出来立刻死（外壳命令不存在），以及从未 ready 就退出。 */
        setCap('rpc', false);
        record('bridge', 'spawn', 'rpc-start-failed', { actual: code });
      } else {
        // 说过话之后才退：通道本身是好的，只是进程没了（会被自动重启）
        record('bridge', 'process', 'unexpected-exit', { actual: code });
      }
      readyPending = false;
      return;
    }
    /* starting / restarting / no-project：没有可判定的信息 */
  }

  /** 畸形 JSONL 行（bridge 已经在发 bridge_parse_error）。 */
  function observeParseError() {
    sawAnyEvidence = true;
    record('envelope', 'stdout', 'unparsable-line');
  }

  /**
   * pi 从 stdout 发来的**任何**一条消息（应答与事件都走这里）。
   *
   * 只做结构判断，不看业务内容。
   */
  function observeUpstream(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      sawAnyEvidence = true;
      record('envelope', 'stdout', 'not-an-object', { actual: msg });
      return;
    }
    const type = msg.type;
    if (typeof type !== 'string' || !type) {
      sawAnyEvidence = true;
      record('envelope', 'stdout', 'missing-type', { actual: msg });
      return;
    }
    // 看到一条带 type 的合法信封 —— 期望的信封契约成立
    if (!envelopeSeen) envelopeSeen = true;
    /* 收到合法信封 = **通道真的通了**（不只是外壳起来了）。这才是 rpc 的证据。 */
    everTalked = true;
    readyPending = false;
    setCap('rpc', true);

    if (type === 'response') {
      observeResponse(msg);
      return;
    }

    if (!KNOWN_EVENTS.has(type)) {
      /* 未知事件：**安全忽略**，但留一条可见的记录。
       * 前端对它是 default: return（不抛、不重置、不清会话），这里只是让它
       * 不至于「静默地什么都没发生」。 */
      record('event', type, 'unknown-event');
      return;
    }
    const cap = EVENT_CAPABILITY[type];
    if (cap) setCap(cap, true);
    sawAnyEvidence = true;
  }

  function observeResponse(msg) {
    sawAnyEvidence = true;
    const command = msg.command;
    if (typeof command !== 'string' || !command) {
      record('envelope', 'response', 'missing-command', { actual: msg });
      return;
    }
    const ok = msg.success !== false;
    const cap = COMMAND_CAPABILITY[command];
    if (cap) setCap(cap, ok);
    if (!ok) {
      // 命令级的失败：可能是 pi 不认识这个命令，也可能是这一次的参数不行。
      // 不区分（分不出来），记下来让人看。
      record('response', command, 'command-failed');
      return;
    }
    /* 形状校验：只查「我们依赖的字段在不在」，不查值。
     * 缺字段 = 上游形状变了 —— 这正是 P4 要提前发现的东西。 */
    if (cap === 'getState') {
      const st = piState(msg.data);
      if (!st.ok) record('response', command, 'missing-field', { field: 'sessionFile' });
    }
  }

  /**
   * 会话文件的观察（由 server/sessions.js 在扫目录时喂进来）。
   *
   * ⚠️ **只能把能力置 true**。文件里没有 `session_info` 只说明那个会话没改过名，
   * 不代表 pi 不支持改名 —— 「没观察到」不是「不存在」。
   */
  function observeSessionScan({ attempted = 0, headerOk = 0, cwdOk = 0, namingSeen = false, shapes = null } = {}) {
    if (attempted > 0) sawAnyEvidence = true;
    if (headerOk > 0 && cwdOk > 0) {
      setCap('sessionJsonl', true);
    } else if (attempted > 0 && headerOk === 0) {
      /* 有文件、却一条 header 都认不出来 —— 这才算「认不出会话文件」的证据。
       * （也可能只是目录里全是坏文件，所以措辞是「认不出」而不是「不兼容」。） */
      setCap('sessionJsonl', false);
      record('session-file', 'scan', 'header-unreadable', { actual: `attempted=${attempted}` });
    }
    if (namingSeen) setCap('sessionNaming', true);
    if (shapes && shapes.nested) {
      // 见到过嵌套消息体（pi 的真实形状）—— 只要见到就说明这个形状是支持的
      setCap('sessionJsonl', true);
    }
    if (shapes && shapes.flatOnly) {
      record('session-file', 'message', 'flat-message-body');
    }
  }

  /** 会话文件里读到坏行 / 坏 header。 */
  function observeSessionAnomaly(issue, extra = {}) {
    record('session-file', 'parse', issue, extra);
  }

  /** 版本探测：**只当证据，不参与判定**。 */
  function piVersion() {
    if (typeof piVersionProbe !== 'function') return null;
    try {
      const v = piVersionProbe();
      return typeof v === 'string' && v ? v : null;
    } catch {
      return null;
    }
  }

  /** 三值能力 → 报告里用的对象。 */
  function capabilityReport() {
    const out = {};
    for (const k of CAPABILITIES) out[k] = caps[k];
    return out;
  }

  /**
   * 派生兼容状态。**只依据能力与已见的证据，不依据版本号。**
   *
   *   incompatible —— 某个 essential 能力被证实不可用（rpc / getState）
   *   partial      —— 有非 essential 能力被证实不可用（局部降级）
   *   compatible   —— 至少一个 essential 已证实可用，且没有已知的缺失
   *   unknown      —— 还没观察到足够证据（例如还没启动过 pi）
   */
  function status() {
    for (const k of ESSENTIAL) if (caps[k] === false) return 'incompatible';
    for (const k of CAPABILITIES) if (caps[k] === false) return 'partial';
    for (const k of ESSENTIAL) if (caps[k] === true) return 'compatible';
    return 'unknown';
  }

  /**
   * 给 Diagnostics 的报告。
   *
   * **只有结构信息**：版本、能力三值、缺失清单、异常（字段名与类型）。
   * 没有 payload、没有用户正文、没有绝对路径、没有密钥 —— 这个模块从来就没存过。
   */
  function report() {
    const capabilities = capabilityReport();
    const missing = CAPABILITIES.filter((k) => capabilities[k] === false);
    const unknownCaps = CAPABILITIES.filter((k) => capabilities[k] === null);
    const v = piVersion();
    const st = status();
    return {
      detected: sawAnyEvidence,
      version: v,
      // 版本读不到**不是**不兼容的理由 —— 单独给个标记，界面据此显示「版本未知」
      versionKnown: v !== null,
      status: st,
      capabilities,
      missing,
      unverified: unknownCaps,
      protocol: {
        expected: ENVELOPE_PROTOCOL,
        observed: envelopeSeen ? ENVELOPE_PROTOCOL : null,
      },
      issues: anomalies.map((a) => ({ ...a })),
    };
  }

  /** 降级用：前端只需要「哪些能力确定不可用」。 */
  function summary() {
    return { status: status(), missing: CAPABILITIES.filter((k) => caps[k] === false) };
  }

  /** 供测试用：清空全部证据。 */
  function reset() {
    for (const k of CAPABILITIES) caps[k] = null;
    anomalies.length = 0;
    envelopeSeen = false;
    readyPending = false;
    everTalked = false;
    sawAnyEvidence = false;
  }

  return {
    observeBridge,
    observeParseError,
    observeUpstream,
    observeSessionScan,
    observeSessionAnomaly,
    report,
    summary,
    reset,
    _internals: { describe, safeKey, MAX_ANOMALIES, ESSENTIAL },
  };
}
