/* Pi 的「现在忙不忙」—— 更新闸门唯一的事实源。
 *
 * ---------- 为什么单独一个模块 ----------
 *
 * 「能不能更新 Pi」要先回答「当前有没有在干活」。这个判断散在 server.js 的
 * 事件回调里就没法测（server.js 一 import 就起服务），而它又是**替换运行时文件**
 * 前的最后一道闸门 —— 判错的代价很具体：把正在生成的回合打断，或者反过来
 * 让更新被一个已经结束的回合永久挡住。所以规则集中在这里，纯函数式：喂事件、
 * 喂命令，问 busy。server.js 只负责把真实事件转发进来。
 *
 * ---------- 按 Pi 1.0.0 的真实事件语义 ----------
 *
 * 官方（`core/agent-session.ts`）：
 *   - `agent_start`  —— **一次 low-level run** 开始
 *   - `agent_end`    —— 只结束这一次 run，**之后还可能继续**：
 *                       automatic retry（`willRetry`）、overflow recovery、
 *                       compaction retry、steering、follow-up
 *   - `agent_settled` —— session 级的自动工作**彻底结束**（在所有重试与
 *                       压缩之后才发，源码里是收尾处最后一条）
 *
 * 所以：**active 从 agent_start 起，只在 agent_settled 落**。
 * 早先的实现拿 `agent_end` 当结束 —— 那会在「失败自动重试」的间隙里把闸门
 * 打开，正好是更新最不该开始的时刻。
 *
 * ---------- prompt 竞态 ----------
 *
 * 用户点发送之后，到 Pi 真正开始跑之间有一个窗口：RPC 的 `prompt` 应答可能
 * 先回，而 `agent_start` 还没发出来。这期间只看 `agent_start` 会误判成空闲，
 * 于是「刚发出去的消息还没开始跑，更新却启动了」。所以：
 *
 *   - `noteCommandAccepted({type:'prompt'})` —— **桥已经收下这条命令**就置 pending
 *   - `prompt` 应答 `disposition === 'handled'` —— 明确不会有 run，撤掉 pending
 *     （`'started'` / `'queued'` 都继续等 agent_settled）
 *   - `agent_settled` —— pending 与 active 一起落
 *
 * 这些都是**确定性信号**，没有一处依赖固定延迟。
 *
 * ---------- 收口 ----------
 *
 * 不允许 busy 永久挂住。除 agent_settled 外，下面这些**确定终止/重置**的情况
 * 也清账：bridge_status 的 starting / restarting / exited / error / no-project /
 * maintenance（进程没了或正在换，谁也不能还「在生成」），以及 new_session
 * （换会话等于换了一条时间线）。
 */

/** bridge 生命周期里「不可能还在生成」的状态集合。 */
const TERMINAL_BRIDGE_STATES = Object.freeze([
  'starting', 'restarting', 'exited', 'error', 'no-project', 'maintenance',
]);

/** 会被当成「可能开一次 run」的命令类型。 */
const TURN_COMMANDS = Object.freeze(['prompt', 'follow_up', 'steer']);

export function createPiActivity() {
  let pendingPrompt = false; // 命令已被桥接受，但还不知道会不会有 run
  let runActive = false; // agent_start 已到，agent_settled 之前

  function clearAll() {
    pendingPrompt = false;
    runActive = false;
  }

  /** 命令**已被 bridge 接受**（send 没抛）之后调用。 */
  function noteCommandAccepted(cmd) {
    const type = cmd && cmd.type;
    if (TURN_COMMANDS.includes(type)) {
      pendingPrompt = true;
      return;
    }
    if (type === 'new_session' || type === 'switch_session') {
      /* 换会话 = 换时间线：旧会话的 run 结论不该挂到新的上面。
       * （switch_session 会走 bridge 重启，但那一步是异步的。） */
      clearAll();
    }
  }

  /** 观察 pi 流出来的每条消息（与 server.js 的 publish 同源）。 */
  function observe(event) {
    const type = event && event.type;
    if (type === 'agent_start') {
      runActive = true;
      return;
    }
    if (type === 'agent_settled') {
      /* 唯一真正代表「这次会话级自动工作结束」的事件。 */
      clearAll();
      return;
    }
    if (type === 'response' && event.command === 'prompt' && event.success === true) {
      const disposition = event.data && event.data.disposition;
      /* `handled` = 这条 prompt 被就地处理掉，不会开 run（例如本地命令）。
       * `started` / `queued` 都要继续等 agent_settled。 */
      if (disposition === 'handled') pendingPrompt = false;
      return;
    }
    if (type === 'bridge_status' && TERMINAL_BRIDGE_STATES.includes(event.state)) {
      clearAll();
    }
    /* 注意：**故意不处理 agent_end**。它只结束一次 low-level run，
     * 后面还可能有重试 / 压缩 / steering —— 见文件头。 */
  }

  /**
   * 现在能不能更新 Pi。
   * @returns {null|{code:string, error:string}} null = 空闲
   */
  function busy() {
    if (runActive) return { code: 'busy-turn', error: '当前回答仍在生成，请先停止' };
    if (pendingPrompt) return { code: 'busy-turn', error: '刚发出的提问还没被 Pi 接手，等这一轮开始或结束再更新' };
    return null;
  }

  /** 给测试与诊断看的状态快照（不含任何用户内容）。 */
  function state() {
    return { pendingPrompt, runActive, busy: Boolean(runActive || pendingPrompt) };
  }

  return { noteCommandAccepted, observe, busy, state, reset: clearAll };
}
