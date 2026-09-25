/* Agent Registry —— 唯一认识各个 adapter 的地方（规格 §36）。
 *
 * Planner / Scheduler **不 import 任何具体 adapter**，只通过这里拿。
 * 这样加一个新 agent 只需要在本文件注册一行，不用去改调度逻辑，
 * 也不会出现「if codex… if claude…」散落各处（规格 §10 明确禁止）。
 *
 * 能力一律以 adapter 自报的 `capabilities` 为准，上层只消费统一字段：
 *   streaming   有没有增量输出
 *   cancellation 能不能取消
 *   resume      能不能续同一个会话（重试时用）
 *   toolEvents  有没有**工具级**结构化事件（决定 Timeline 是「工具列表」还是「文本摘要」）
 *
 * `auto` 的解析规则刻意保持可预测（规格 §35）：**优先 pi，否则按注册顺序取第一个可用的**。
 * 不做评分、不做黑箱排序 —— 用户要能自己算出来会选谁。
 */
import { createPiAdapter } from './pi.js';
import { createCodexAdapter } from './codex.js';
import { createClaudeAdapter } from './claude.js';
import { createOpencodeAdapter } from './opencode.js';
import { createGeminiAdapter } from './gemini.js';
import { createFakeAdapter } from './fake.js';

/** 注册顺序 = `auto` 的兜底顺序（pi 会被优先挑中，见 resolveAuto）。 */
export const AUTO_PREFERENCE = ['pi', 'codex', 'claude', 'gemini', 'opencode'];

function assertAdapter(a) {
  const problems = [];
  if (!a || typeof a !== 'object') problems.push('不是对象');
  else {
    if (typeof a.id !== 'string' || !a.id) problems.push('缺少 id');
    if (typeof a.detect !== 'function') problems.push('缺少 detect()');
    if (typeof a.start !== 'function') problems.push('缺少 start()');
  }
  if (problems.length) throw new Error(`adapter 形状不合法：${problems.join(' / ')}`);
  return a;
}

/**
 * @param env          环境变量来源（探测 npm 全局位置用）
 * @param sessionDir   pi 的独立会话目录（Planner 任务不污染主聊天会话）
 * @param includeFake  是否注册测试用 fake adapter（默认不注册，避免出现在生产界面）
 */
export function createAgentRegistry({ env = process.env, sessionDir = null, includeFake = false, fakeBehaviors = {} } = {}) {
  const adapters = new Map();

  function register(adapter) {
    assertAdapter(adapter);
    adapters.set(adapter.id, adapter);
    return adapter;
  }

  register(createPiAdapter({ env, sessionDir }));
  register(createCodexAdapter({ env }));
  register(createClaudeAdapter({ env }));
  register(createOpencodeAdapter({ env }));
  register(createGeminiAdapter({ env }));
  if (includeFake) register(createFakeAdapter({ env, behaviors: fakeBehaviors }));

  const get = (id) => adapters.get(String(id || '')) || null;
  const has = (id) => adapters.has(String(id || ''));
  const ids = () => [...adapters.keys()];

  /** 探测全部 adapter。返回统一结构，前端只消费这个。 */
  function list() {
    const out = [];
    for (const adapter of adapters.values()) {
      let info;
      try {
        info = adapter.detect();
      } catch (err) {
        // 一个 adapter 探测崩了不能拖垮整个 registry
        info = {
          id: adapter.id,
          name: adapter.name || adapter.id,
          available: false,
          version: '',
          reason: 'detect-failed',
          detail: `探测出错：${err.message}`,
          capabilities: { streaming: false, cancellation: false, resume: false, toolEvents: false },
          notes: [],
        };
      }
      out.push({
        id: info.id,
        name: info.name || adapter.id,
        description: info.description || adapter.description || '',
        available: Boolean(info.available),
        version: info.version || '',
        reason: info.reason || '',
        detail: info.detail || '',
        capabilities: info.capabilities || { streaming: false, cancellation: true, resume: false, toolEvents: false },
        notes: Array.isArray(info.notes) ? info.notes : [],
        testOnly: Boolean(info.testOnly),
      });
    }
    return out;
  }

  function detect(id) {
    const adapter = get(id);
    if (!adapter) return null;
    try {
      const info = adapter.detect();
      return {
        id: info.id,
        name: info.name || adapter.id,
        description: info.description || adapter.description || '',
        available: Boolean(info.available),
        version: info.version || '',
        reason: info.reason || '',
        detail: info.detail || '',
        capabilities: info.capabilities || { streaming: false, cancellation: true, resume: false, toolEvents: false },
        notes: Array.isArray(info.notes) ? info.notes : [],
        testOnly: Boolean(info.testOnly),
      };
    } catch (err) {
      return {
        id: adapter.id,
        name: adapter.name || adapter.id,
        available: false,
        version: '',
        reason: 'detect-failed',
        detail: `探测出错：${err.message}`,
        capabilities: { streaming: false, cancellation: false, resume: false, toolEvents: false },
        notes: [],
      };
    }
  }

  /**
   * 解析 `auto`。规则固定且可预测（规格 §35）：
   *   1. 用户给了 preferred 且它可用 → 用它
   *   2. 否则按 AUTO_PREFERENCE 取第一个可用的
   *   3. 都没有 → null（调用方报错，不要静默挑一个）
   */
  function resolveAuto(preferred = null) {
    const all = list().filter((a) => a.available);
    if (preferred) {
      const hit = all.find((a) => a.id === preferred);
      if (hit) return hit.id;
    }
    for (const id of AUTO_PREFERENCE) {
      const hit = all.find((a) => a.id === id);
      if (hit) return hit.id;
    }
    return all.length ? all[0].id : null;
  }

  return { register, get, has, ids, list, detect, resolveAuto, size: () => adapters.size };
}
