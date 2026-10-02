/* P24 状态文案的**唯一来源**。
 *
 * ---------- 解决的问题 ----------
 *
 * 「正在启动 pi…」「pi 已退出」「兼容性有问题」「没选项目」这些状态散在
 * `shell.js` 的标签表、`app.js` 的 onBridge、`messages.js` 的欢迎区、
 * `sessions.js` 的能力判定里，各自一套措辞。同一个「连不上」在状态栏是一句话、
 * 在 toast 里是另一句、在诊断里又是第三句 —— 用户没法把它们当同一件事读。
 *
 * 这里把「连接 / 启动」这一面的文案收成一张表，并且**每条都带可执行的下一步**：
 *   - 只描述事实（不猜原因）；
 *   - 下一步是**具体的**（去哪里、点什么），但不自动执行任何修复
 *     —— 不 chmod、不安装、不删配置。这是 P24 的硬边界。
 *
 * 复用而不是新建：诊断入口就是既有的 `openDiagnostics()`，重启就是既有的
 * `reloadPi()`。这里只负责「什么状态该说什么话、该给哪个入口」。
 */

/** 连接状态的统一文案。`tone` 与 `.conn` 的类名共用（ok / busy / bad / ''）。 */
export const CONNECTION_STATES = Object.freeze({
  'no-project': {
    tone: '',
    label: '未选择项目',
    detail: 'pi 只在选定目录后启动。先在左侧「添加文件夹」选一个目录。',
    actions: [],
  },
  starting: {
    tone: 'busy',
    label: '正在启动 pi…',
    detail: '正在用当前项目目录启动 pi 子进程；启动期间输入区是锁住的。',
    actions: ['diagnostics'],
  },
  ready: {
    tone: 'ok',
    label: '已连接',
    detail: '',
    actions: [],
  },
  restarting: {
    tone: 'busy',
    label: '正在重启 pi…',
    detail: '项目或配置变化后重新加载 pi；正在跑的那一轮会结束。',
    actions: ['diagnostics'],
  },
  exited: {
    tone: 'bad',
    label: 'pi 已退出',
    detail: 'pi 子进程已经不在了，当前会话无法继续发消息。',
    actions: ['restart', 'diagnostics'],
  },
  error: {
    tone: 'bad',
    label: 'pi 启动失败',
    detail: 'pi 没能启动起来。',
    actions: ['restart', 'diagnostics'],
  },
});

export function connectionCopy(state, detail = '') {
  const base = CONNECTION_STATES[state] || { tone: '', label: detail || state || '未知', detail: '', actions: [] };
  return {
    ...base,
    label: state === 'exited' && detail ? detail : base.label,
  };
}

/**
 * 需要**常驻可见**的启动 / 连接问题 → 一条带下一步的说明。
 *
 * 返回 null 表示「没有需要常驻提示的问题」—— 正常状态与「没选项目」都不在这里
 * （后者由欢迎区负责，重复提示只会是噪声）。
 *
 * @param ctx {{bridgeState, bridgeError, bridgeHint, hasProject, compat}}
 */
export function startupNotice(ctx = {}) {
  const { bridgeState, bridgeError, bridgeHint, hasProject, compat } = ctx;
  if (!hasProject) return null;

  if (bridgeState === 'error') {
    return {
      id: 'bridge-error',
      tone: 'bad',
      title: 'pi 启动失败',
      detail: [bridgeError || 'pi 没能启动起来。', bridgeHint || ''].filter(Boolean).join('\n'),
      actions: ['restart', 'diagnostics'],
    };
  }
  if (bridgeState === 'exited') {
    return {
      id: 'bridge-exited',
      tone: 'bad',
      title: 'pi 已退出',
      detail: [bridgeError || 'pi 子进程已经不在了。', '正在跑的那一轮已经结束；重启 pi 之后可以继续用同一个会话。']
        .filter(Boolean)
        .join('\n'),
      actions: ['restart', 'diagnostics'],
    };
  }
  /* 兼容性问题只提示一次性的 toast 太轻：能力缺失是**持续**的，
   * 说明必须留得住，而且要给诊断入口（用户看不懂时把报告贴出来）。 */
  if (compat && compat.status === 'incompatible') {
    return {
      id: 'compat-incompatible',
      tone: 'warn',
      title: 'pi 的关键能力不可用',
      detail: `已证实缺少：${(compat.missing || []).join('、') || '未知'}。部分功能暂时用不了。`,
      actions: ['diagnostics'],
    };
  }
  return null;
}

/**
 * 面板里 loading / empty / error 的统一措辞。
 * 调用方只提供语义，不自己拼句子 —— 这样七个页面说的是同一套话。
 */
export const SURFACE_COPY = Object.freeze({
  loading: (what = '内容') => `正在读取${what}…`,
  empty: (what = '内容') => `还没有${what}。`,
  failed: (what = '内容') => `${what}读取失败。`,
  /** 只有真的有重试路径时才用这句。 */
  retry: '重试',
  offline: '与 pi 的连接断了；重启 pi 之后可以继续。',
});

/** 动作 → 统一文案（按钮文字与可访问名共用一份）。 */
export const NOTICE_ACTIONS = Object.freeze({
  restart: { label: '重启 Pi', title: '重启 pi 子进程（会结束当前这一轮）' },
  diagnostics: { label: '打开诊断', title: '查看版本、能力与最近的协议异常' },
});
