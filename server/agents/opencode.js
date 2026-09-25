/* OpenCode adapter。
 *
 * ⚠️ **本机未安装**，所以这里**只做探测，不实现调用方式**。
 *
 * 为什么不照印象写一份：规格 §1 明确要求「不要根据印象写 adapter」，§12 要求
 * 「必须以真实 CLI 能力为准」。本机没有 opencode，`--help` 拿不到，官方文档也没有
 * 对着某个已安装版本核对过 —— 这时写出来的参数大概率是错的，而错的参数会以
 * 「跑起来但结果不对」的形式出现，比直接报「不可用」难查得多。
 *
 * 所以第一版的行为是：`detect()` 如实报 not-installed，`start()` 直接拒绝。
 * 用户装了之后，补上 args 构造即可（registry 里已经注册，不需要改别处）。
 */
import { resolveEntry } from './cli.js';

/** opencode 的 npm 包名有几个候选，逐个试。 */
const CANDIDATES = [
  { pkgName: 'opencode-ai', binName: 'opencode' },
  { pkgName: 'opencode', binName: 'opencode' },
];

export function createOpencodeAdapter({ env = process.env } = {}) {
  let cache = null;

  function detect() {
    if (cache) return cache;
    let last = null;
    for (const c of CANDIDATES) {
      const entry = resolveEntry({ ...c, env });
      if (entry.ok || entry.reason === 'entry-missing') {
        last = { entry, cand: c };
        break;
      }
      last = last || { entry, cand: c };
    }
    const entry = last ? last.entry : { ok: false, reason: 'not-installed', detail: '找不到 opencode 包' };

    if (!entry.ok) {
      cache = {
        id: 'opencode',
        name: 'OpenCode',
        description: 'OpenCode CLI',
        available: false,
        version: entry.version || '',
        reason: entry.reason,
        detail: entry.detail,
        entry: null,
        capabilities: { streaming: false, cancellation: true, resume: false, toolEvents: false },
        notes: ['未适配调用方式：本机没有可核对的 CLI，照印象写参数比报「不可用」更危险'],
      };
      return cache;
    }
    cache = {
      id: 'opencode',
      name: 'OpenCode',
      description: 'OpenCode CLI',
      available: false, // 包在，但调用方式未适配 —— 不假装能跑
      version: entry.version,
      reason: 'not-adapted',
      detail: `检测到 opencode@${entry.version}，但本适配器尚未适配它的非交互调用方式`,
      entry: null,
      capabilities: { streaming: false, cancellation: true, resume: false, toolEvents: false },
      notes: ['包已安装；补上 args 构造后即可启用'],
    };
    return cache;
  }

  async function start() {
    const info = detect();
    return {
      success: false,
      exitCode: null,
      summary: '',
      error: `${info.name} 不可用：${info.detail}`,
      rawResult: null,
      toolCalls: 0,
      truncated: false,
      timedOut: false,
      cancelled: false,
    };
  }

  return { id: 'opencode', name: 'OpenCode', description: 'OpenCode CLI（本机未安装，仅探测）', detect, start };
}
