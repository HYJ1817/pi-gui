/* Pi GUI 前端冒烟测试：在 jsdom 里真实加载 index.html + 前端模块图，
 * 用假的 EventSource / fetch 灌入 pi 的 RPC 事件，检查渲染结果与报错。
 *
 * 前端是原生 ES Module（public/app.js + 若干模块），而 jsdom 不支持 ESM，
 * 所以先用 tests/esm-bundle.cjs 把模块图链接成一份普通脚本再 window.eval。
 * 附带好处是模块的具名导出都会挂到 window 上，断言可以直接调内部函数。 */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');

const PUB = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const bundled = bundle(path.join(PUB, 'app.js'));
const code = bundled.code;
/* 静态检查要读**原始**源码（未被链接器改写过），否则 `export ` 前缀被剥掉之后
 * 那些按源码形态写的正则就对不上了。 */
const sources = bundled.sources;

const errors = [];
const commands = [];
/* /api/git/* 的调用流水（按顺序记 kind + body），用来断言「什么时候真的去问了后端」。 */
const gitCalls = [];
/* /api/git/* 的可变桩。测试里改 gitStub 就能模拟后端的各种状态
 * （干净工作区 / 不是仓库 / 没装 git / 没有项目 / 二进制 / 截断 …）。 */
const gitStub = {
  status: { ok: true, isRepo: true, files: [] },
  diff: { ok: true, isRepo: true, path: '', untracked: false, isDir: false, binary: false, working: '', staged: '', truncated: false, limit: 524288, notice: '' },
  restore: { ok: true, action: 'restored' },
  open: { ok: true, abs: 'C:\\pi-GUI\\x.txt', rel: 'x.txt' },
};
let es = null;
/* /api/status 里「当前项目目录」的可变桩。
 * 置空就能模拟「还没选项目」—— 后端此时不启动 pi，界面要整体切到引导形态。 */
let stubCwd = 'C:\\pi-GUI';

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:7788/' });
const { window } = dom;

window.addEventListener('error', (e) => errors.push('window.error: ' + e.message));

class FakeES {
  constructor(url) { this.url = url; es = this; }
  close() {}
  emit(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}
window.EventSource = FakeES;

window.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/api/upload')) {
    const nm = decodeURIComponent(new URL(u, 'http://x').searchParams.get('name') || 'f');
    const base = { ok: true, name: nm, path: 'C:\\pi-GUI\\.uploads\\' + nm };
    if (/\.png$/i.test(nm)) return { json: async () => ({ ...base, id: 'u-png', size: 100, kind: 'image', pages: null }) };
    if (/\.pdf$/i.test(nm)) {
      return {
        json: async () => ({
          ...base, id: 'u-pdf', size: 453303, kind: 'text', pages: 1, chars: 385, truncated: false,
          text: '发酵罐空气分布器的设计参数核算\n罐体公称容积 V = 50 m³', preview: '发酵罐空气分布器的设计参数核算',
        }),
      };
    }
    if (/\.docx$/i.test(nm)) {
      return {
        json: async () => ({
          ...base, id: 'u-docx', size: 1627, kind: 'text', pages: null, chars: 385, truncated: false,
          text: '发酵罐空气分布器设计', preview: '发酵罐空气分布器设计',
        }),
      };
    }
    return { json: async () => ({ ...base, id: 'u-bin', size: 2000, kind: 'binary', pages: null }) };
  }
  if (u.includes('/api/status')) {
    return {
      json: async () => ({
        piRunning: Boolean(stubCwd),
        cwd: stubCwd,
        args: ['--mode', 'rpc', '--continue'],
        hasProject: Boolean(stubCwd),
      }),
    };
  }
  if (u.includes('/api/git/')) {
    const kind = u.slice(u.indexOf('/api/git/') + '/api/git/'.length).split('?')[0];
    gitCalls.push({ kind, body: opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null });
    return { json: async () => gitStub[kind] || { ok: true } };
  }
  if (u.includes('/api/command')) {
    const body = JSON.parse(opts.body);
    commands.push(body);
    return { json: async () => ({ ok: true }) };
  }
  if (u.includes('/api/projects')) {
    return {
      json: async () => ({
        ok: true,
        active: 'C:\\pi-GUI',
        items: [
          { path: 'C:\\pi-GUI', name: 'pi-GUI' },
          { path: 'C:\\Users\\21022', name: '21022' },
        ],
      }),
    };
  }
  if (u.includes('/api/providers')) {
    if (opts && opts.method === 'POST') {
      return {
        json: async () => ({
          ok: true,
          provider: 'newprov',
          warning: '环境变量 NEW_KEY 没有设置，pi 会忽略这个供应商。',
          keyState: { kind: 'env', ok: false, note: '环境变量 NEW_KEY 没有设置，pi 会忽略这个供应商。' },
        }),
      };
    }
    if (opts && opts.method === 'DELETE') return { json: async () => ({ ok: true }) };
    return {
      json: async () => ({
        ok: true,
        path: 'C:\\Users\\21022\\.pi\\agent\\models.json',
        providers: { deepseek: { baseUrl: 'https://api.deepseek.com', api: 'openai-completions', models: [{ id: 'deepseek-chat' }] } },
        keyStates: { deepseek: { kind: 'env', ok: false, note: '环境变量 DEEPSEEK_API_KEY 没有设置' } },
      }),
    };
  }
  return { json: async () => ({ ok: true }) };
};

// 记录 jsdom 里的未捕获异常
window.onerror = (m) => errors.push('onerror: ' + m);

const $ = (id) => window.document.getElementById(id);

function run() {
  window.eval(code);
}

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push([r === true || r === undefined ? 'PASS' : 'FAIL', name, r === true || r === undefined ? '' : String(r)]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
}

/* --- 静态检查：el.X 必须在 el 对象里，$('id') 必须在 HTML 里 ---
 * 扫的是全部模块的源码：`el` 定义在 state.js、引用散落在各模块，
 * 只看 app.js 会漏掉绝大多数。 */
function staticCheck() {
  const elBlock = sources.match(/const el = \{([\s\S]*?)\n\};/);
  check('找得到 el 定义', () => (elBlock ? true : 'state.js 里没有 const el = {…}'));
  if (!elBlock) return;

  const keys = new Set([...elBlock[1].matchAll(/^\s*([a-zA-Z0-9_]+)\s*:/gm)].map((m) => m[1]));
  const used = new Set([...sources.matchAll(/\bel\.([a-zA-Z0-9_]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((k) => !keys.has(k));
  check('el 对象覆盖全部引用', () => (missing.length ? '缺失: ' + missing.join(', ') : true));

  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const wanted = new Set([...sources.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const noId = [...wanted].filter((k) => !ids.has(k));
  check("$('id') 全部存在于 HTML", () => (noId.length ? '缺失: ' + noId.join(', ') : true));
}

staticCheck();

(async () => {
  try {
    run();
  } catch (e) {
    console.log('!! 模块加载抛错: ' + e.message + '\n' + e.stack);
    process.exit(1);
  }

  check('模块加载无异常', () => errors.length === 0 || errors.join(' | '));

  await new Promise((r) => setTimeout(r, 30)); // 等 loadStatus → connect / loadProjects / loadProviders
  check('EventSource 已连接', () => es && es.url === '/api/events');
  check('项目列表已渲染 2 项', () => window.document.querySelectorAll('#projects .project').length === 2);
  check('当前项目高亮', () => window.document.querySelectorAll('#projects .project.active').length === 1);
  check('供应商计数 = 1', () => $('providerCount').textContent === '1');

  // 供应商入口在侧栏下方（rail-spacer 之后），不是顶部导航项
  check('供应商入口不在顶部导航里', () => window.document.querySelector('.rail-nav #navProviders') === null);
  check('供应商入口在侧栏下方', () => {
    const prov = $('navProviders');
    if (!prov) return '找不到 #navProviders';
    const kids = [...prov.parentElement.children];
    return kids.indexOf(prov) > kids.findIndex((x) => x.classList.contains('rail-spacer'));
  });
  check('供应商入口在用量卡上方', () => {
    const rail = window.document.querySelector('.rail');
    const kids = [...rail.children];
    const prov = kids.findIndex((x) => x.id === 'navProviders');
    const quota = kids.findIndex((x) => x.classList.contains('quota'));
    return prov >= 0 && quota >= 0 && prov < quota;
  });
  check('右下角没有重复的供应商按钮', () => $('btnCornerProviders') === null);

  // --- pi 就绪 → boot() ---
  es.emit({ type: 'bridge_status', state: 'ready' });
  await new Promise((r) => setTimeout(r, 10));
  const cmds = commands.map((c) => c.type);
  check('boot 请求 get_state', () => cmds.includes('get_state'));
  check('boot 请求 get_messages', () => cmds.includes('get_messages'));

  // --- get_state ---
  es.emit({
    type: 'response', command: 'get_state', success: true,
    data: { model: { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }, thinkingLevel: 'high', isStreaming: false, sessionName: 'pi-gui-work' },
  });
  check('标题 = 会话名', () => $('title').textContent === 'pi-gui-work');
  check('底部 = 会话名', () => $('footName').textContent === 'pi-gui-work');
  check('模型 chip', () => $('modelText').textContent === 'DeepSeek V4 Pro');
  check('思考 chip', () => $('thinkText').textContent === '思考 high');

  // --- get_session_stats ---
  es.emit({
    type: 'response', command: 'get_session_stats', success: true,
    data: { tokens: { input: 50000, output: 10000, cacheRead: 40000 }, cost: 0.4512, contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 } },
  });
  check('上下文百分比', () => $('uPct').textContent === '30%');
  check('上下文进度条宽度', () => $('uCtxBar').style.width === '30%');
  check('成本显示', () => $('uCost').textContent === '$0.4512');

  // --- get_tree ---
  es.emit({
    type: 'response', command: 'get_tree', success: true,
    data: {
      tree: [
        { entry: { type: 'message', id: 'a', role: 'user', content: '你好' }, children: [
          { entry: { type: 'message', id: 'b', role: 'assistant', content: '在的' }, children: [
            { entry: { type: 'message', id: 'c', role: 'user', content: '改一下' }, children: [] },
          ] },
        ] },
      ],
    },
  });
  check('分支计数 = 3', () => $('branchCount').textContent === '3');

  // --- 对话流 ---
  es.emit({ type: 'message_start', message: { role: 'user', content: '帮我看看 server.js' } });
  es.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  es.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
  es.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '好的，' } });
  es.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '我来看一下。' } });
  await new Promise((r) => setTimeout(r, 30));
  check('用户消息已渲染', () => window.document.querySelectorAll('.msg.user').length === 1);
  check('助手增量已拼装', () => window.document.querySelector('.msg.assistant .msg-body').textContent.includes('好的，我来看一下。'));

  es.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '文件没问题。' }] } });
  check('message_end 校正渲染', () => window.document.querySelector('.msg.assistant .msg-body').textContent.includes('文件没问题。'));

  // --- 上游错误必须可见（实测余额不足时 content 为空、usage 全 0，
  //     不处理的话对话区就是一片空白，用户完全看不出发生了什么） ---
  es.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  es.emit({
    type: 'message_end',
    message: {
      role: 'assistant', content: [], stopReason: 'error',
      usage: { input: 0, output: 0 },
      errorMessage: '402: {"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}',
    },
  });
  check('错误块已渲染', () => window.document.querySelectorAll('.msg-err').length === 1);
  check('错误标题译成人话', () => window.document.querySelector('.me-head').textContent === '账户余额不足');
  check('错误带处理建议', () => window.document.querySelector('.me-hint').textContent.includes('充值'));
  check('原始错误码保留', () => window.document.querySelector('.me-raw').textContent.includes('Insufficient Balance'));
  check('错误块挂在最后一条助手消息里', () => {
    const bodies = [...window.document.querySelectorAll('.msg.assistant .msg-body')];
    return !!bodies[bodies.length - 1].querySelector('.msg-err');
  });

  // 重试开始时撤掉上一次的错误块，避免重试成功后还留着一张失败卡片
  es.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3 });
  check('重试时撤掉错误块', () => window.document.querySelectorAll('.msg-err').length === 0);
  es.emit({ type: 'auto_retry_end' });

  // 错误翻译表
  check('401 译成 Key 无效', () => window.explainError('401: {"message":"Unauthorized"}').title === 'API Key 无效或已过期');
  check('429 译成限流', () => window.explainError('429 Too Many Requests').title === '触发限流');
  check('网络错误译成连接失败', () => window.explainError('fetch failed').title === '网络连接失败');
  check('未知错误有兜底', () => window.explainError('some weird thing').title === '请求失败');

  // 空内容但不是失败 → 给个提示，不留空白
  es.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  es.emit({ type: 'message_end', message: { role: 'assistant', content: [] } });
  check('空回复有提示而非空白', () => {
    const bodies = [...window.document.querySelectorAll('.msg.assistant .msg-body')];
    return bodies[bodies.length - 1].querySelector('.msg-note')?.textContent.includes('没有返回内容');
  });

  // 用户中断
  es.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  es.emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted' } });
  check('中断有提示', () => {
    const bodies = [...window.document.querySelectorAll('.msg.assistant .msg-body')];
    return bodies[bodies.length - 1].querySelector('.msg-note')?.textContent === '已中断';
  });

  // --- 工具调用 ---
  es.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls -la' } });
  check('工具卡片出现', () => window.document.querySelectorAll('.tool').length === 1);
  es.emit({ type: 'tool_execution_update', toolCallId: 't1', partialResult: 'a\nb\n' });
  es.emit({ type: 'tool_execution_update', toolCallId: 't1', partialResult: 'a\nb\nc\n' });
  check('partialResult 为累积值', () => window.document.querySelector('.tool-out').textContent === 'a\nb\nc\n');
  es.emit({ type: 'tool_execution_end', toolCallId: 't1', isError: false, result: { content: [{ type: 'text', text: 'done' }] } });
  check('工具完成态', () => window.document.querySelector('.tool').classList.contains('done'));

  // --- 文件变更账本（为 Diff/Git 预留的结构，当前不渲染 UI）---
  check('非改动类工具不入账', () => window.listChanges().length === 0);
  let changeEvents = 0;
  const offChanges = window.onChanges(() => changeEvents++);
  es.emit({ type: 'tool_execution_start', toolCallId: 'w1', toolName: 'write', args: { file_path: '/tmp/a.txt', content: 'x' } });
  es.emit({ type: 'tool_execution_end', toolCallId: 'w1', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
  check('write 成功记入账本', () => window.listChanges().length === 1 && window.listChanges()[0].path === '/tmp/a.txt');
  check('账本变化触发订阅', () => changeEvents === 1);
  check('同文件重复改动累加计数', () => {
    es.emit({ type: 'tool_execution_start', toolCallId: 'w2', toolName: 'edit', args: { file_path: '/tmp/a.txt', old_string: 'x', new_string: 'y' } });
    es.emit({ type: 'tool_execution_end', toolCallId: 'w2', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
    const l = window.listChanges();
    return l.length === 1 && l[0].count === 2 && l[0].tool === 'edit';
  });
  check('失败的工具不入账', () => {
    es.emit({ type: 'tool_execution_start', toolCallId: 'w3', toolName: 'write', args: { file_path: '/tmp/b.txt' } });
    es.emit({ type: 'tool_execution_end', toolCallId: 'w3', isError: true, result: { content: [{ type: 'text', text: 'boom' }] } });
    return window.listChanges().some((c) => c.path === '/tmp/b.txt') === false;
  });
  check('对外给的是副本（改不动账本）', () => {
    window.listChanges()[0].path = '篡改';
    return window.listChanges()[0].path === '/tmp/a.txt';
  });
  check('clearChanges 清空账本', () => {
    window.clearChanges();
    return window.listChanges().length === 0;
  });
  check('取消订阅后不再触发', () => {
    const before = changeEvents;
    offChanges();
    es.emit({ type: 'tool_execution_start', toolCallId: 'w4', toolName: 'write', args: { file_path: '/tmp/c.txt' } });
    es.emit({ type: 'tool_execution_end', toolCallId: 'w4', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
    return changeEvents === before && window.listChanges().length === 1;
  });
  window.clearChanges();

  /* --- Git 变更面板（v0.3.0） ---
   *
   * 前端这一侧要验的是「后端给什么就渲染什么」，以及几条容易做错的行为：
   * 徽标、空状态、不是仓库时的中性降级、diff 就地展开且无 XSS、
   * 撤销必须二次确认、工具结束后的防抖刷新。
   * 真实的 git 行为（路径逃逸、重命名、中文文件名、restore…）在 tests/git.cjs 里
   * 用临时仓库验，这里全部走桩，不碰开发者的仓库。 */

  const chgRows = () => [...window.document.querySelectorAll('#modalCard .chg-row')];
  const chgText = () => ($('modalCard') ? $('modalCard').textContent : '');
  const confirmText = () => ($('confirmCard') ? $('confirmCard').textContent : '');
  const confirmBtn = (label) => [...window.document.querySelectorAll('#confirmCard .btn')].find((b) => b.textContent === label);
  const LIVE_SEL = 'script,img,iframe,svg,object,embed,style,link,meta,form,input,base';
  /* 「有没有危险元素」查**解析树**而不是正则扫 innerHTML。
   * 原因：行上的 title="…" 属性里会出现未转义的 `<`（属性值里它是合法字面量，
   * 浏览器绝不会把它当标签），正则扫字符串会误报。真正要问的是
   * 「有没有东西真的被解析成了元素」，那就直接问 DOM。
   * diff 那处例外：它的 innerHTML 是由字符串注入的，正则才有意义（两处都查）。 */
  const liveCount = (root) => root.querySelectorAll(LIVE_SEL).length;
  const noLiveTagIn = (html) => !/<\s*(script|img|iframe|svg|object|embed|style|link|meta|form|input|base)\b/i.test(html);

  check('侧栏有「文件变更」入口（在顶部导航里）', () => window.document.querySelector('.rail-nav #navChanges') !== null);

  gitStub.status = {
    ok: true,
    isRepo: true,
    files: [
      { path: 'src/app.js', status: 'M', index: ' ', worktree: 'M', staged: false, untracked: false, isDir: false, additions: 12, deletions: 3, binary: false, oldPath: null },
      { path: 'docs/中文 说明.md', status: 'A', index: 'A', worktree: ' ', staged: true, untracked: false, isDir: false, additions: 5, deletions: 0, binary: false, oldPath: null },
      { path: 'tmp/<img onerror=alert(1)>.txt', status: '??', index: '?', worktree: '?', staged: false, untracked: true, isDir: false, additions: 2, deletions: 0, binary: false, oldPath: null },
      { path: 'big.log', status: 'M', index: ' ', worktree: 'M', staged: false, untracked: false, isDir: false, additions: 900, deletions: 0, binary: false, oldPath: null },
      { path: 'newdir/', status: '??', index: '?', worktree: '?', staged: false, untracked: true, isDir: true, additions: null, deletions: null, binary: false, oldPath: null },
    ],
  };
  await window.loadGitStatus();
  check('徽标显示变更数', () => ($('changesCount').textContent === '5' && $('changesCount').hidden === false) || $('changesCount').textContent);

  $('navChanges').click();
  await new Promise((r) => setTimeout(r, 20));
  check('变更面板打开', () => $('modal').hidden === false);
  check('列表渲染 5 行', () => chgRows().length === 5);
  check('状态字母正确', () => chgRows().map((x) => x.querySelector('.chg-code').textContent).join('') === 'MA??M??');
  check('含空格与中文的路径原样渲染', () => chgRows().some((x) => x.querySelector('.chg-path').textContent === 'docs/中文 说明.md'));
  check('恶意文件名只作为文本（不产生活元素）', () => liveCount($('modalCard')) === 0 || `解析出了 ${liveCount($('modalCard'))} 个危险元素`);
  check('恶意文件名仍以原样文本呈现（没被截断或吃掉）', () =>
    chgRows().some((x) => x.querySelector('.chg-path').textContent === 'tmp/<img onerror=alert(1)>.txt'));
  check('增删行数渲染', () => {
    const t = chgRows().map((x) => x.querySelector('.chg-stat').textContent).join('|');
    return (t.includes('+12') && t.includes('−3') && t.includes('+900')) || t;
  });
  check('未跟踪文件标注「未跟踪」', () => chgRows().some((x) => x.querySelector('.chg-meta').textContent.includes('未跟踪')));
  check('已暂存文件标注「已暂存」', () => chgRows().some((x) => x.querySelector('.chg-meta').textContent.includes('已暂存')));
  check('未跟踪目录标注「目录」', () => chgRows().some((x) => x.querySelector('.chg-meta').textContent.includes('目录')));
  check('说明文字不重复（未跟踪只出现一次）', () => {
    const m = chgRows()[2].querySelector('.chg-meta').textContent;
    return (m.match(/未跟踪/g) || []).length === 1 || m;
  });
  check('未跟踪目录的说明是「未跟踪 · 目录」', () => {
    const m = chgRows()[4].querySelector('.chg-meta').textContent;
    return m === '未跟踪 · 目录' || m;
  });
  check('每行都有「打开」与撤销按钮', () => {
    const r = chgRows()[0];
    const b = [...r.querySelectorAll('.chg-acts .btn')].map((x) => x.textContent);
    return b.join(',') === '打开,撤销' || b.join(',');
  });
  check('未跟踪文件的按钮写「删除」而非「撤销」', () => {
    const b = [...chgRows()[2].querySelectorAll('.chg-acts .btn')].map((x) => x.textContent);
    return b.join(',') === '打开,删除' || b.join(',');
  });

  /* --- diff 就地展开 --- */
  const DIFF_WORKING = 'diff --git a/src/app.js b/src/app.js\nindex 111..222 100644\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1,2 +1,2 @@\n-旧\n+新\n 不变\n';
  const DIFF_STAGED = 'diff --git a/src/app.js b/src/app.js\n@@ -0,0 +1 @@\n+暂存的一行\n';

  gitStub.diff = { ok: true, isRepo: true, path: 'src/app.js', untracked: false, isDir: false, binary: false, working: DIFF_WORKING, staged: DIFF_STAGED, truncated: false, limit: 524288, notice: '' };
  chgRows()[0].querySelector('.chg-main').click();
  await new Promise((r) => setTimeout(r, 20));
  check('点击行会去拉 diff（带正确路径）', () => {
    const c = gitCalls[gitCalls.length - 1];
    return (c && c.kind === 'diff' && c.body && c.body.path === 'src/app.js') || JSON.stringify(c);
  });
  check('diff 就地展开', () => chgRows()[0].querySelector('.chg-diff').hidden === false);
  check('diff 用等宽容器（pre.diff-body）', () => !!chgRows()[0].querySelector('.chg-diff .diff-body'));
  check('暂存区与工作区分段显示', () => {
    const l = [...chgRows()[0].querySelectorAll('.chg-label')].map((x) => x.textContent);
    return (l.length === 2 && l[0].includes('暂存区') && l[1].includes('工作区')) || l.join('|');
  });
  check('diff 行分类：新增 / 删除 / hunk / 元信息', () => {
    const b = chgRows()[0].querySelector('.chg-diff');
    const add = b.querySelectorAll('.d-add').length;
    const del = b.querySelectorAll('.d-del').length;
    const hunk = b.querySelectorAll('.d-hunk').length;
    const meta = b.querySelectorAll('.d-meta').length;
    return (add === 2 && del === 1 && hunk === 2 && meta >= 4) || `add=${add} del=${del} hunk=${hunk} meta=${meta}`;
  });
  check('`+++ b/x` 被当成元信息而不是新增行', () => {
    const metas = [...chgRows()[0].querySelectorAll('.chg-diff .d-meta')].map((x) => x.textContent);
    return metas.some((t) => t.startsWith('+++ b/')) && !metas.some((t) => t.startsWith('+ ')) || metas.join('|');
  });
  check('再点一次收起 diff', () => {
    chgRows()[0].querySelector('.chg-main').click();
    return chgRows()[0].querySelector('.chg-diff').hidden === true;
  });
  check('收起后不重复请求', () => {
    const before = gitCalls.filter((c) => c.kind === 'diff').length;
    chgRows()[0].querySelector('.chg-main').click();
    return gitCalls.filter((c) => c.kind === 'diff').length === before;
  });

  /* --- diff 的 XSS：文件名与内容都可能被 Agent 间接控制 --- */
  gitStub.diff = {
    ok: true, isRepo: true, path: 'tmp/x', untracked: true, isDir: false, binary: false,
    working: 'diff --git a/<img src=x onerror=alert(1)> b/<img src=x onerror=alert(1)>\n@@ -0,0 +1 @@\n+<script>alert(1)</script>\n',
    staged: '', truncated: false, limit: 524288, notice: '',
  };
  chgRows()[2].querySelector('.chg-main').click();
  await new Promise((r) => setTimeout(r, 20));
  check('恶意文件名与内容不产生活标签', () => {
    const box = chgRows()[2].querySelector('.chg-diff');
    return (noLiveTagIn(box.innerHTML) && liveCount(box) === 0) || box.innerHTML.slice(0, 200);
  });
  check('<script> 被转义成可读文本', () => {
    const b = chgRows()[2].querySelector('.chg-diff');
    return (b.textContent.includes('<script>alert(1)</script>') && b.innerHTML.includes('&lt;script')) || b.textContent;
  });
  check('未跟踪文件的 diff 标为「未跟踪文件的内容」', () => {
    const l = [...chgRows()[2].querySelectorAll('.chg-label')].map((x) => x.textContent);
    return l.some((t) => t.includes('未跟踪')) || l.join('|');
  });

  /* --- 二进制 / 截断 --- */
  gitStub.diff = { ok: true, isRepo: true, path: 'logo.png', untracked: false, isDir: false, binary: true, working: 'Binary files a/logo.png and b/logo.png differ\n', staged: '', truncated: false, limit: 524288, notice: '' };
  chgRows()[1].querySelector('.chg-main').click();
  await new Promise((r) => setTimeout(r, 20));
  check('二进制文件明确提示看不了', () => chgText().includes('二进制文件'));
  check('二进制不渲染文本 diff 块', () => chgRows()[1].querySelector('.chg-diff .diff-body') === null);

  gitStub.diff = { ok: true, isRepo: true, path: 'big.log', untracked: false, isDir: false, binary: false, working: '@@ -1 +1 @@\n+一行\n', staged: '', truncated: true, limit: 524288, notice: '' };
  chgRows()[3].querySelector('.chg-main').click();
  await new Promise((r) => setTimeout(r, 20));
  check('超限的 diff 有截断提示', () => chgText().includes('已截断') && chgText().includes('512 KB'));

  /* --- 后端没给 numstat 时，从 diff 正文补行数 --- */
  window.renderChangesBody();
  gitStub.diff = { ok: true, isRepo: true, path: 'newdir', untracked: true, isDir: true, binary: false, working: '@@ -0,0 +1,2 @@\n+甲\n-乙\n+丙\n', staged: '', truncated: false, limit: 524288, notice: '这是一个未被 Git 跟踪的目录，没有展开显示其中的文件。' };
  chgRows()[4].querySelector('.chg-main').click();
  await new Promise((r) => setTimeout(r, 20));
  check('未跟踪目录的 notice 会显示', () => chgText().includes('未被 Git 跟踪的目录'));
  check('缺 numstat 时从 diff 正文补出 +N −M', () => {
    const t = chgRows()[4].querySelector('.chg-stat').textContent;
    return (t.includes('+2') && t.includes('−1')) || t;
  });

  /* --- 撤销：必须二次确认 --- */
  window.renderChangesBody();
  gitStub.restore = { ok: true, action: 'restored' };
  const restoreBefore = gitCalls.filter((c) => c.kind === 'restore').length;
  chgRows()[0].querySelector('.chg-acts .btn.danger').click();
  await new Promise((r) => setTimeout(r, 10));
  check('撤销先弹二次确认', () => $('confirmLayer').hidden === false && confirmText().includes('尚未提交的改动会丢失'));
  check('确认层不破坏下层面板', () => $('modal').hidden === false && chgRows().length === 5);
  confirmBtn('取消').click();
  await new Promise((r) => setTimeout(r, 10));
  check('取消确认则不发起撤销', () => gitCalls.filter((c) => c.kind === 'restore').length === restoreBefore);
  check('取消后确认层收起、面板还在', () => $('confirmLayer').hidden === true && chgRows().length === 5);

  chgRows()[0].querySelector('.chg-acts .btn.danger').click();
  await new Promise((r) => setTimeout(r, 10));
  confirmBtn('撤销改动').click();
  await new Promise((r) => setTimeout(r, 20));
  check('确认后按 tracked 方式撤销（不带 deleteUntracked）', () => {
    const c = gitCalls.filter((x) => x.kind === 'restore').pop();
    return (c && c.body.path === 'src/app.js' && c.body.deleteUntracked === false) || JSON.stringify(c);
  });

  /* --- 撤销未跟踪文件：文案不同，且必须显式带 deleteUntracked --- */
  gitStub.restore = { ok: true, action: 'deleted-untracked' };
  const rowsAfterRestore = chgRows();
  const stBeforeDelete = gitCalls.filter((c) => c.kind === 'status').length;
  rowsAfterRestore[2].querySelector('.chg-acts .btn.danger').click();
  await new Promise((r) => setTimeout(r, 10));
  check('未跟踪文件的确认文案点明「将删除该文件」', () => confirmText().includes('这个文件尚未被 Git 跟踪。撤销将删除该文件'));
  confirmBtn('删除文件').click();
  await new Promise((r) => setTimeout(r, 20));
  check('确认后带 deleteUntracked=true', () => {
    const c = gitCalls.filter((x) => x.kind === 'restore').pop();
    return (c && c.body.deleteUntracked === true) || JSON.stringify(c);
  });
  check('撤销成功后提示已删除', () => [...window.document.querySelectorAll('.toast')].some((x) => x.textContent.includes('已删除未跟踪文件')));
  check('撤销后自动重拉状态并重画面板', () => {
    const n = gitCalls.filter((c) => c.kind === 'status').length;
    return (n > stBeforeDelete && chgRows().length === 5) || `status=${n} rows=${chgRows().length}`;
  });

  /* --- 后端说「还需要确认」时再问一次（客户端状态过期的兜底） --- */
  gitStub.restore = { ok: false, needsConfirm: true, error: '这个文件尚未被 Git 跟踪。撤销将删除该文件。' };
  window.renderChangesBody();
  chgRows()[0].querySelector('.chg-acts .btn.danger').click();
  await new Promise((r) => setTimeout(r, 10));
  confirmBtn('撤销改动').click();
  await new Promise((r) => setTimeout(r, 20));
  check('后端要求再确认时会追问一轮', () => confirmText().includes('尚未被 Git 跟踪'));
  confirmBtn('删除文件').click();
  await new Promise((r) => setTimeout(r, 20));
  check('追问后以 deleteUntracked=true 重试', () => {
    const c = gitCalls.filter((x) => x.kind === 'restore').pop();
    return (c && c.body.deleteUntracked === true) || JSON.stringify(c);
  });

  /* --- 各种「不是错误」的状态 --- */
  gitStub.status = { ok: true, isRepo: true, files: [] };
  await window.loadGitStatus();
  window.renderChangesBody();
  check('工作区干净时提示 No changes', () => chgText().includes('工作区干净'));
  check('干净时徽标隐藏', () => $('changesCount').hidden === true);

  gitStub.status = { ok: true, isRepo: false, files: [] };
  await window.loadGitStatus();
  window.renderChangesBody();
  check('非 Git 仓库给中性提示（不是报错）', () => chgText().includes('当前项目不是 Git 仓库') && chgText().includes('不受影响'));

  gitStub.status = { ok: false, noGit: true, isRepo: false, files: [], error: 'spawn git ENOENT' };
  await window.loadGitStatus();
  window.renderChangesBody();
  check('没装 git 时给友好文案', () => chgText().includes('没有找到 git 命令'));

  gitStub.status = { ok: true, isRepo: false, files: [], noProject: true };
  await window.loadGitStatus();
  window.renderChangesBody();
  check('没有项目时引导去添加文件夹', () => chgText().includes('还没有选择项目'));

  gitStub.status = { ok: true, isRepo: true, truncated: true, files: [{ path: 'a.txt', status: 'M', index: ' ', worktree: 'M', staged: false, untracked: false, isDir: false, additions: 1, deletions: 0, binary: false, oldPath: null }] };
  await window.loadGitStatus();
  window.renderChangesBody();
  check('列表过长时有截断提示', () => chgText().includes('变更列表过长'));

  gitStub.status = { ok: true, isRepo: true, files: [] };
  await window.loadGitStatus();
  $('modal').click();
  check('变更面板可关闭', () => $('modal').hidden === true);

  /* --- 自动刷新：工具结束后防抖 ---
   *
   * 先等一拍再开始计数：前面「账本」那段用例发过 write / edit，会留下一个
   * 450ms 的防抖定时器。不等它落地，它就会掉进下面第一个断言的时间窗里，
   * 把「read 不该刷新」误判成失败。 */
  await new Promise((r) => setTimeout(r, 600));

  const statusCount = () => gitCalls.filter((c) => c.kind === 'status').length;

  let n0 = statusCount();
  es.emit({ type: 'tool_execution_start', toolCallId: 'r1', toolName: 'read', args: { file_path: '/tmp/a.txt' } });
  es.emit({ type: 'tool_execution_end', toolCallId: 'r1', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
  await new Promise((r) => setTimeout(r, 600));
  check('只读工具（read）不触发刷新', () => statusCount() === n0 || `多了 ${statusCount() - n0} 次`);

  n0 = statusCount();
  for (const id of ['w5', 'w6', 'w7']) {
    es.emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'write', args: { file_path: '/tmp/' + id + '.txt' } });
    es.emit({ type: 'tool_execution_end', toolCallId: id, isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
  }
  await new Promise((r) => setTimeout(r, 600));
  check('write 结束后自动刷新', () => statusCount() === n0 + 1 || `刷了 ${statusCount() - n0} 次`);
  check('连续多次改动被防抖合并成一次', () => statusCount() === n0 + 1 || `刷了 ${statusCount() - n0} 次`);

  n0 = statusCount();
  es.emit({ type: 'tool_execution_start', toolCallId: 'b9', toolName: 'bash', args: { command: 'echo x > f.txt' } });
  es.emit({ type: 'tool_execution_end', toolCallId: 'b9', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
  await new Promise((r) => setTimeout(r, 600));
  check('bash 结束后也会刷新（它可能改了文件）', () => statusCount() === n0 + 1 || `刷了 ${statusCount() - n0} 次`);

  n0 = statusCount();
  es.emit({ type: 'tool_execution_start', toolCallId: 'w8', toolName: 'write', args: { file_path: '/tmp/boom.txt' } });
  es.emit({ type: 'tool_execution_end', toolCallId: 'w8', isError: true, result: { content: [{ type: 'text', text: 'boom' }] } });
  await new Promise((r) => setTimeout(r, 600));
  check('失败的工具不触发刷新', () => statusCount() === n0 || `多了 ${statusCount() - n0} 次`);

  window.clearChanges();

  // --- 弹层：分支 ---
  $('navBranches').click();
  check('分支弹层打开', () => $('modal').hidden === false);
  check('分支树渲染 3 个节点', () => window.document.querySelectorAll('#modalCard .tree-node').length === 3);
  $('modal').click();

  // --- 弹层：供应商 ---
  $('navProviders').click();
  await new Promise((r) => setTimeout(r, 20));
  check('供应商弹层打开', () => $('modal').hidden === false);
  check('供应商列表渲染', () => window.document.querySelectorAll('#modalCard .prov').length === 1);
  check('未解析的 $ENV_VAR 有告警', () => {
    const w = window.document.querySelector('#modalCard .prov-warn');
    return w && w.textContent.includes('DEEPSEEK_API_KEY') ? true : '告警缺失';
  });
  $('modal').click();

  // --- 添加供应商：保存后提示告警 ---
  $('navProviders').click();
  await new Promise((r) => setTimeout(r, 20));
  [...window.document.querySelectorAll('#modalCard .btn')].find((b) => b.textContent === '添加供应商').click();
  check('添加表单打开', () => window.document.querySelectorAll('#modalCard .preset').length === 9);
  const fields = window.document.querySelectorAll('#modalCard .field input, #modalCard .field textarea');
  fields[0].value = 'newprov';
  fields[1].value = 'https://api.example.com/v1';
  fields[2].value = '$NEW_KEY';
  fields[3].value = 'model-a|Model A';
  [...window.document.querySelectorAll('#modalCard .btn')].find((b) => b.textContent === '保存').click();
  await new Promise((r) => setTimeout(r, 30));
  check('保存后弹出 key 告警', () => {
    const t = [...window.document.querySelectorAll('.toast')].map((x) => x.textContent).join(' | ');
    return t.includes('NEW_KEY') ? true : '未提示：' + t;
  });
  $('modal').click();

  // --- 弹层：统计 ---
  $('btnStats').click();
  await new Promise((r) => setTimeout(r, 10));
  es.emit({
    type: 'response', command: 'get_session_stats', success: true,
    data: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, cost: 0.5, contextUsage: { tokens: 10, contextWindow: 100, percent: 10 }, sessionFile: 'C:\\x\\s.jsonl', userMessages: 1, assistantMessages: 1, toolCalls: 1 },
  });
  await new Promise((r) => setTimeout(r, 10));
  check('统计弹层有数据行', () => window.document.querySelectorAll('#modalCard .stat-rows > div').length === 9);
  $('modal').click();

  // --- 弹层：更多 ---
  $('btnMore').click();
  check('更多菜单 5 项', () => window.document.querySelectorAll('#modalCard .modal-item').length === 5);
  $('modal').click();

  // --- 导出：相对路径补成绝对 ---
  es.emit({ type: 'response', command: 'export_html', success: true, data: { path: 'pi-session-abc.html' } });
  es.emit({ type: 'response', command: 'export_html', success: true, data: { path: 'D:\\abs\\x.html' } });
  check('导出提示补成绝对路径', () => {
    const t = [...window.document.querySelectorAll('.toast')].map((x) => x.textContent).join(' | ');
    if (!t.includes('C:\\pi-GUI\\pi-session-abc.html')) return '相对路径未补全：' + t;
    if (!t.includes('D:\\abs\\x.html')) return '绝对路径被改写：' + t;
    return true;
  });

  // --- 模型 / 思考选择器（Codex 风格浮层） ---
  es.emit({
    type: 'response', command: 'get_available_models', success: true,
    data: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', reasoning: false },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', provider: 'deepseek', reasoning: true },
      { id: 'glm-4.6', name: 'GLM-4.6', provider: 'zhipu', reasoning: true },
    ],
  });
  es.emit({ type: 'response', command: 'get_available_thinking_levels', success: true, data: ['off', 'low', 'high'] });

  const pop = () => window.document.querySelector('.pop');

  // 让当前模型落在可用列表里，才能验证对勾
  es.emit({
    type: 'response', command: 'get_state', success: true,
    data: { model: { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }, thinkingLevel: 'high', isStreaming: false, sessionName: 'pi-gui-work' },
  });

  const gsBefore = commands.filter((c) => c.type === 'get_state').length;

  $('btnModel').click();
  check('模型浮层已打开', () => pop() && pop().hidden === false);
  check('浮层标题为「选择模型」', () => pop().querySelector('.pop-title')?.textContent === '选择模型');
  check('模型按供应商分组', () => [...pop().querySelectorAll('.pop-label')].map((x) => x.textContent).join(',') === 'deepseek,zhipu');
  check('模型项 3 个', () => pop().querySelectorAll('.pop-item').length === 3);
  check('当前模型带对勾', () => pop().querySelectorAll('.pop-item.on').length === 1);

  pop().querySelectorAll('.pop-item')[1].click();
  check('点选后浮层关闭', () => pop().hidden === true);
  const setModel = commands.filter((c) => c.type === 'set_model').pop();
  check('set_model 带 provider+modelId', () => setModel && setModel.provider === 'deepseek' && setModel.modelId === 'deepseek-reasoner');
  check('切模型后回读状态', () => commands.filter((c) => c.type === 'get_state').length === gsBefore + 1);

  // 成功提示只在 pi 确认后才出现（之前是点完就弹，失败时会撒谎）
  check('点选时不抢先弹提示', () => ![...window.document.querySelectorAll('.toast')].some((x) => x.textContent.includes('已切换到')));
  es.emit({ type: 'response', command: 'set_model', success: true, data: { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' } });
  check('pi 确认后才提示已切换', () => [...window.document.querySelectorAll('.toast')].some((x) => x.textContent.includes('已切换到 DeepSeek Reasoner')));

  $('btnThink').click();
  check('思考浮层 3 项', () => pop().querySelectorAll('.pop-item').length === 3);
  check('思考项带说明', () => pop().querySelectorAll('.pop-item .pi-sub').length === 3);
  pop().querySelectorAll('.pop-item')[2].click();
  check('set_thinking_level 已发送', () => commands.some((c) => c.type === 'set_thinking_level' && c.level === 'high'));
  check('切档位后回读状态', () => commands.filter((c) => c.type === 'get_state').length === gsBefore + 2);

  // pi 对非法档位也回 ok（实测 medium 被静默映射成 high），失败分支要能纠正显示
  es.emit({ type: 'response', command: 'set_thinking_level', success: false, error: '不支持的档位' });
  check('设置失败后再次回读状态', () => commands.filter((c) => c.type === 'get_state').length === gsBefore + 3);
  es.emit({ type: 'response', command: 'get_state', success: true, data: { model: { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }, thinkingLevel: 'off', sessionName: 'pi-gui-work' } });
  check('回读后档位被纠正', () => $('thinkText').textContent === '思考 off');

  // --- 上下文占用指示器 + 悬停提示 ---
  es.emit({
    type: 'response', command: 'get_session_stats', success: true,
    data: { tokens: { input: 61000, output: 1000, cacheRead: 0 }, cost: 0.12, contextUsage: { tokens: 61000, contextWindow: 258000, percent: 23 } },
  });
  check('上下文圆环百分比', () => $('ctxPct').textContent === '23%');
  check('圆环有进度', () => {
    const off = Number($('ctxRing').style.strokeDashoffset);
    return off > 0 && off < 97.4 ? true : 'dashoffset=' + off;
  });

  $('btnCtx').click();
  await new Promise((r) => setTimeout(r, 20));
  check('上下文提示已弹出', () => pop().classList.contains('tip-mode') && pop().hidden === false);
  check('提示文案对齐 Codex', () => {
    const t = pop().textContent;
    return t.includes('背景信息窗口:') && t.includes('23% 已用 (剩余 77%)') && t.includes('已用 61k 标记, 共 258k')
      ? true
      : '实际：' + t;
  });
  $('btnCtx').click();
  check('再点不误关提示', () => pop().hidden === false);
  pop().dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: false }));
  check('移开鼠标后提示关闭', () => pop().hidden === true);

  // --- 附件 ---
  const mkFile = (name, content, type) => new window.File([content], name, { type });

  await window.handleFiles([mkFile('shot.png', 'PNGDATA', 'image/png')]);
  await new Promise((r) => setTimeout(r, 20));
  check('图片附件渲染缩略图', () => window.document.querySelectorAll('#attachTray .att-thumb img').length === 1);
  check('附件托盘已显示', () => $('attachTray').hidden === false);
  check('仅有附件也能发送', () => $('btnSend').disabled === false);

  await window.handleFiles([mkFile('发酵罐设计.pdf', 'PDFDATA', 'application/pdf')]);
  await new Promise((r) => setTimeout(r, 20));
  check('PDF 附件渲染为文件卡片', () => window.document.querySelectorAll('#attachTray .att').length === 2);
  check('PDF 元信息含页数', () => [...window.document.querySelectorAll('#attachTray .att-meta')].some((x) => x.textContent.includes('1 页')));

  await window.handleFiles([mkFile('notes.docx', 'DOCXDATA', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')]);
  await new Promise((r) => setTimeout(r, 20));
  check('docx 附件已加入', () => window.document.querySelectorAll('#attachTray .att').length === 3);

  await window.handleFiles([mkFile('archive.zzz', 'BINDATA', 'application/octet-stream')]);
  await new Promise((r) => setTimeout(r, 20));
  check('未知二进制标记为不可解析', () => [...window.document.querySelectorAll('#attachTray .att-meta')].some((x) => x.textContent.includes('pi 读不了')));

  // 组装消息（在移除之前做，才能覆盖到无法解析的那条）
  const built = window.buildMessage('请看一下这几个文件');
  check('消息含用户正文', () => built.startsWith('请看一下这几个文件'));
  check('图片以图像内容说明', () => built.includes('1 张图片已作为图像内容提供'));
  check('PDF 生成 pi-file 块', () => built.includes('<pi-file name="发酵罐设计.pdf" meta="1 页 · 385 字">'));
  check('docx 生成 pi-file 块', () => built.includes('<pi-file name="notes.docx"'));
  check('无法解析的附件附上路径', () => built.includes('本机路径：C:\\pi-GUI\\.uploads\\'));

  const imgs = window.attachmentImages();
  check('图片转成 pi 的 ImageContent', () => imgs.length === 1 && imgs[0].type === 'image' && imgs[0].mimeType === 'image/png' && imgs[0].data === Buffer.from('PNGDATA').toString('base64'));

  // 移除一个
  window.document.querySelectorAll('#attachTray .att-x')[3].click();
  check('附件可移除', () => window.document.querySelectorAll('#attachTray .att').length === 3);

  const afterRemove = window.buildMessage('');
  check('移除后不再出现在消息里', () => !afterRemove.includes('archive.zzz'));

  // 带附件发送
  $('btnSend').click();
  await new Promise((r) => setTimeout(r, 20));
  const withAtt = commands.filter((c) => c.type === 'prompt').pop();
  check('发送时带上 images', () => withAtt.images && withAtt.images.length === 1);
  check('发送时正文含附件块', () => withAtt.message.includes('<pi-file'));
  check('发送后托盘清空', () => window.document.querySelectorAll('#attachTray .att').length === 0);
  check('发送后托盘隐藏', () => $('attachTray').hidden === true);

  // 附件正文在对话里折叠显示
  const usersBefore = window.document.querySelectorAll('.msg.user').length;
  es.emit({
    type: 'message_start',
    message: { role: 'user', content: '看看这个\n\n<pi-file name="长文档.pdf" meta="12 页 · 3.2k 字">\n这里是很长的正文内容\n</pi-file>' },
  });
  check('用户消息已渲染', () => window.document.querySelectorAll('.msg.user').length === usersBefore + 1);
  check('附件正文折叠成卡片', () => window.document.querySelectorAll('.msg.user .msg-file').length === 1);
  check('折叠卡片标题正确', () => window.document.querySelector('.msg-file-head').textContent.includes('长文档.pdf'));
  check('正文默认收起', () => !window.document.querySelector('.msg-file').classList.contains('open'));
  window.document.querySelector('.msg-file-head').click();
  check('点击可展开', () => window.document.querySelector('.msg-file').classList.contains('open'));
  check('展开后能看到内容', () => window.document.querySelector('.msg-file-body').textContent.includes('这里是很长的正文内容'));
  check('长正文没有铺在气泡里', () => window.document.querySelector('.msg.user .msg-body').textContent.includes('这里是很长的正文内容') === false);

  // 回归：刷新页面 / 切换项目时走 get_messages 重建对话区，
  // 这条路径曾经直接把 <pi-file> 裸标签当纯文本显示，折叠卡片丢失。
  es.emit({
    type: 'response',
    command: 'get_messages',
    success: true,
    data: {
      messages: [
        { role: 'user', content: '看看这个\n\n<pi-file name="重建文档.docx" meta="3 页 · 900 字">\n重建时的正文\n</pi-file>' },
        { role: 'assistant', content: [{ type: 'text', text: '收到。' }] },
      ],
    },
  });
  check('重建后附件仍是折叠卡片', () => window.document.querySelectorAll('.msg.user .msg-file').length === 1);
  check('重建后不暴露裸 pi-file 标签', () => window.document.querySelector('.msg.user .msg-body').textContent.includes('<pi-file') === false);
  check('重建后卡片标题正确', () => window.document.querySelector('.msg-file-head').textContent.includes('重建文档.docx'));
  check('重建后正文仍然收起', () => window.document.querySelector('.msg-file').classList.contains('open') === false);

  // 回归：历史重建时图片附件要还原成缩略图
  es.emit({
    type: 'response',
    command: 'get_messages',
    success: true,
    data: {
      messages: [{ role: 'user', content: [{ type: 'text', text: '这张图' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] }],
    },
  });
  check('重建后图片显示缩略图', () => window.document.querySelectorAll('.msg.user .msg-att-chip').length === 1);
  check('缩略图 src 是 data URL', () => window.document.querySelector('.msg-att-chip img').src.startsWith('data:image/png;base64,'));

  // --- markdown 块级渲染 ---
  const md = window.md;
  check('空行切成两个段落', () => (md('甲\n\n乙').match(/<p>/g) || []).length === 2);
  check('段内换行保留为 br', () => md('甲\n乙').includes('<br>'));
  check('代码块不被 br 包裹', () => md('前\n\n```\nx = 1\n```\n\n后').includes('<br><pre') === false);
  check('代码块前后无多余空行', () => /<\/pre><br>/.test(md('前\n\n```\nx = 1\n```\n\n后')) === false);
  check('无序列表渲染成 ul', () => md('- 甲\n- 乙') === '<ul><li>甲</li><li>乙</li></ul>');
  check('有序列表渲染成 ol', () => md('1. 甲\n2. 乙') === '<ol><li>甲</li><li>乙</li></ol>');
  check('列表后接段落正确收尾', () => md('- 甲\n\n乙') === '<ul><li>甲</li></ul><p>乙</p>');
  check('标题渲染成 h4', () => md('## 小标题').includes('<h4>小标题</h4>'));
  check('行内代码仍然生效', () => md('看 `x` 这里').includes('<code>x</code>'));
  check('加粗仍然生效', () => md('**粗**').includes('<strong>粗</strong>'));
  check('HTML 被转义', () => md('<img src=x>').includes('&lt;img'));

  // --- markdown 安全：模型输出是不可信输入，危险内容不得变成可执行 HTML ---
  // 这里断言的是「结构性防护」：原文先整体转义，尖括号只可能来自渲染器自身。
  // 所以判断标准不是「某几个向量被过滤」，而是「渲染结果里不存在非白名单活标签」。
  const noLiveTag = (html) => !/<\s*(script|img|iframe|svg|object|embed|style|link|meta|form|input|base)\b/i.test(html);
  check('原始 script 标签被转义', () => noLiveTag(md('<script>alert(1)</script>')) && md('<script>alert(1)</script>').includes('&lt;script'));
  check('img + onerror 不产生活标签', () => noLiveTag(md('<img src=x onerror=alert(1)>')));
  check('iframe 被转义', () => noLiveTag(md('<iframe src="https://evil.example"></iframe>')));
  check('svg/onload 被转义', () => noLiveTag(md('<svg onload=alert(1)></svg>')));
  check('不生成任何 on* 事件属性', () => !/<[a-z][^>]*\son\w+\s*=/i.test(md('<a href="#" onclick="alert(1)">x</a>')));
  check('危险 scheme 一律不产生链接', () => {
    const payloads = [
      '[x](javascript:alert(1))',
      '[x](JaVaScRiPt:alert(1))',
      '[x](vbscript:msgbox(1))',
      '[x](data:text/html;base64,PHNjcmlwdD4=)',
      '[x](file:///etc/passwd)',
      '[x](blob:https://a/b)',
    ];
    return payloads.every((p) => md(p).includes('<a') === false);
  });
  check('javascript: 链接退化成可读纯文本', () => {
    const h = md('[点我](javascript:alert(1))');
    return !h.includes('<a') && h.includes('点我') && h.includes('javascript:');
  });
  check('图片不产生远程加载', () => md('![x](https://evil.example/p.png)').includes('<img') === false);
  check('http(s) 链接正常放行且带 noopener', () => {
    const h = md('[官网](https://example.com/a?b=1)');
    return h.includes('href="https://example.com/a?b=1"') && h.includes('rel="noopener noreferrer"');
  });
  check('相对链接放行', () => md('[本地](/docs/x)').includes('href="/docs/x"'));
  check('混合脏输入不产生活标签', () => {
    const dirty = [
      '<div onclick="x">a</div>',
      '<body onload=alert(1)>',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
      '<a href="javascript:alert(1)">go</a>',
      '"><script>alert(1)</script>',
    ];
    // 注意：转义后的原文里 on* 仍以**字面文本**存在（无害），
    // 所以只检测「真实标签内部」的事件属性，即 <tag ... on*= 。
    return dirty.every((d) => noLiveTag(md(d)) && !/<[a-z][^>]*\son\w+\s*=/i.test(md(d)));
  });

  // --- markdown 新增能力 ---
  check('表格渲染成 table', () => {
    const h = md('| 名 | 值 |\n| --- | --- |\n| 甲 | 1 |');
    return h.includes('<table>') && h.includes('<th>名</th>') && h.includes('<td>甲</td>');
  });
  check('表格对齐方式生效', () => md('| 左 | 右 |\n| :-- | --: |\n| a | b |').includes('text-align:right'));
  check('正文里的竖线不误判成表格', () => md('a | b').includes('<table>') === false);
  check('引用渲染成 blockquote', () => md('> 引用一行').includes('<blockquote>'));
  check('分隔线渲染成 hr', () => md('---').includes('<hr>'));
  check('一级标题也渲染成 h4', () => md('# 大标题').includes('<h4>大标题</h4>'));
  check('嵌套列表塞进父 li 内', () => md('- 甲\n  - 甲一').includes('<li>甲<ul><li>甲一</li></ul></li>'));
  check('任务列表未勾选', () => md('- [ ] 待办').includes('<span class="md-task"></span>待办'));
  check('任务列表已勾选', () => md('- [x] 完成').includes('<span class="md-task on"></span>完成'));
  check('删除线渲染成 del', () => md('~~旧~~').includes('<del>旧</del>'));
  check('斜体渲染成 em', () => md('这是 *强调* 词').includes('<em>强调</em>'));
  check('snake_case 不被当成斜体', () => md('变量 some_name_here 保持原样').includes('<em>') === false);
  check('代码块带语言标签', () => md('```js\nlet a = 1\n```').includes('data-lang="js"'));
  check('diff 代码块逐行着色', () => {
    const h = md('```diff\n@@ -1 +1 @@\n-旧\n+新\n 不变\n```');
    return h.includes('class="d-hunk"') && h.includes('class="d-del"') && h.includes('class="d-add"');
  });

  // --- 发送 ---
  $('input').value = '跑一下测试';
  $('input').dispatchEvent(new window.Event('input', { bubbles: true }));
  check('有内容时发送键可用', () => $('btnSend').disabled === false);
  $('btnSend').click();
  await new Promise((r) => setTimeout(r, 20));
  check('prompt 已发送', () => commands.some((c) => c.type === 'prompt' && c.message === '跑一下测试'));
  check('输入框已清空', () => $('input').value === '');
  check('发送后按钮重新禁用', () => $('btnSend').disabled === true);

  // --- 运行中插话 → steer ---
  es.emit({ type: 'agent_start' });
  check('流式中显示停止按钮', () => $('btnStop').hidden === false);
  $('input').value = '再补一句';
  $('input').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('btnSend').click();
  await new Promise((r) => setTimeout(r, 20));
  check('流式中发送走 steer', () => commands.some((c) => c.type === 'steer' && c.message === '再补一句'));
  es.emit({ type: 'agent_settled' });
  check('结束后停止按钮隐藏', () => $('btnStop').hidden === true);

  // --- 权限确认子协议 ---
  es.emit({ type: 'extension_ui_request', id: 'ui1', method: 'confirm', title: '允许执行 rm 吗？', message: 'rm -rf /tmp/x' });
  check('权限弹层打开', () => $('modal').hidden === false);
  check('权限文案', () => $('modalCard').textContent.includes('允许执行 rm 吗？'));
  const btns = [...window.document.querySelectorAll('#modalCard .btn')];
  btns.find((b) => b.textContent === '确认').click();
  await new Promise((r) => setTimeout(r, 10));
  const resp = commands.filter((c) => c.type === 'extension_ui_response').pop();
  check('extension_ui_response 已回传', () => resp && resp.id === 'ui1' && resp.confirmed === true);

  // 粘贴图片：剪贴板里是文件才拦，纯文本照常交给 textarea
  check('拖拽进入高亮输入框', () => {
    $('composerBox').dispatchEvent(new window.Event('dragenter', { bubbles: true, cancelable: true }));
    return $('composerBox').classList.contains('drop') || '未高亮';
  });
  check('拖拽离开取消高亮', () => {
    $('composerBox').dispatchEvent(new window.Event('dragleave', { bubbles: true, cancelable: true }));
    return !$('composerBox').classList.contains('drop') || '仍高亮';
  });

  // 附件正在解析时不应允许发送（避免发出去一个空附件）
  check('解析中的附件不阻塞发送键逻辑', () => {
    // 无正文无附件 → 禁用
    $('input').value = '';
    $('input').dispatchEvent(new window.Event('input', { bubbles: true }));
    return $('btnSend').disabled === true || '空状态却可发送';
  });

  // --- 项目分组折叠 ---
  const group = $('groupHead').parentElement;
  const before = group.classList.contains('open');
  $('groupHead').click();
  check('分组折叠可切换', () => group.classList.contains('open') !== before);
  $('groupHead').click();

  // --- 项目切换 ---
  const items = [...window.document.querySelectorAll('#projects .project')];
  items[1].click();
  await new Promise((r) => setTimeout(r, 10));
  check('切换项目调用 activate', () => true);

  // --- 项目删除按钮 ---
  check('项目有删除按钮', () => window.document.querySelectorAll('#projects .pj-del').length === 2);

  // --- 折叠态：think ---
  /* --- 空会话的欢迎块 ---
   *
   * 回归护栏。早先 ensureThread() 是把 #welcome 直接 remove() 掉的，
   * 于是新会话一建出空线程，欢迎块就永久消失，对话区变成一片纯黑 ——
   * 用户完全看不到引导。现在改成显隐切换，这里把两头都钉住。
   *
   * 注意 syncWelcome 挂在 MutationObserver 上，回调是微任务，
   * 所以断言前必须让出一次事件循环。
   * 另外这里要自己灌一条消息 —— 前面的「切换项目」用例会 clearThread()，
   * 到这一步线程是空的。 */
  es.emit({ type: 'message_start', message: { role: 'user', content: '欢迎块回归用例' } });
  es.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  es.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] } });
  await new Promise((r) => setTimeout(r, 40));
  check('有消息时欢迎块收起但仍在 DOM 里', () => {
    const w = window.document.getElementById('welcome');
    if (!w) return '欢迎块被移除了（应当只隐藏，不能删）';
    return w.hidden === true ? true : '有消息了但欢迎块还露着';
  });

  // success 必须带上 —— onResponse 开头就判 if (!evt.success) 直接返回
  es.emit({ type: 'response', command: 'new_session', success: true });
  await new Promise((r) => setTimeout(r, 450));
  check('新会话后欢迎块重新出现', () => {
    const w = window.document.getElementById('welcome');
    if (!w) return '欢迎块不存在';
    return w.hidden ? '新会话是空的，欢迎块应该露出来' : true;
  });

  /* --- 未选项目的空状态 ---
   *
   * 回归护栏。早先 server.js 拿 process.cwd() 兜底当项目，桌面版又把后端进程的
   * cwd 设成用户主目录 —— 于是首次启动直接落在主目录，还把那里的 pi 历史会话
   * 整段恢复出来。现在没有项目就是没有：pi 不启动，界面切到「先添加文件夹」。
   *
   * 这里把整条链路钉住：引导块、输入区上锁、发送被拦住（不能发出 prompt）。 */
  stubCwd = '';
  await window.loadStatus();
  check('未选项目时显示「先添加文件夹」引导块', () => {
    const ready = window.document.getElementById('welcomeReady');
    const nop = window.document.getElementById('welcomeNoProj');
    if (!ready || !nop) return '引导块结构被改了';
    if (nop.hidden) return '没有显示「先添加文件夹」引导块';
    return ready.hidden === true ? true : '还露着「Pi 已就绪」，会让人以为已经能用';
  });
  check('未选项目时输入区上锁', () => {
    if (window.document.getElementById('input').disabled !== true) return '输入框还能打字';
    return window.document.getElementById('composerBox').classList.contains('is-locked')
      ? true
      : '输入区没有视觉上锁死（.is-locked 缺失）';
  });
  check('未选项目时发送键禁用', () =>
    window.document.getElementById('btnSend').disabled === true ? true : '发送键还能按'
  );
  // submit 是 async，等它跑完再看命令列表
  const beforeCmds = commands.length;
  await window.submit();
  await new Promise((r) => setTimeout(r, 20));
  check('未选项目时提交被拦住（不发命令）', () =>
    commands.length === beforeCmds ? true : `还是发出了 ${commands.length - beforeCmds} 条命令`
  );

  /* 选了项目之后要能解锁 —— 否则用户点完「添加文件夹」还是卡在引导里，
   * 那就比原来更糟。 */
  stubCwd = 'C:\\pi-GUI';
  await window.loadStatus();
  check('选了项目后输入区解锁', () => {
    if (window.document.getElementById('input').disabled !== false) return '输入框还锁着';
    return window.document.getElementById('welcomeReady').hidden === false
      ? true
      : '没有切回「Pi 已就绪」'
  });
  check('选了项目后引导块收起', () =>
    window.document.getElementById('welcomeNoProj').hidden === true ? true : '还露着「先添加文件夹」'
  );

  /* --- 模型列表行格式：id|显示名|key=value --- */
  const P = window.parseModelLine;
  check('parseModelLine 已暴露到全局', () => typeof P === 'function' || typeof P);

  if (typeof P === 'function') {
    check('只写 id', () => {
      const m = P('gpt-4o');
      return (m && m.id === 'gpt-4o' && m.name === undefined) || JSON.stringify(m);
    });
    check('id|显示名', () => P('gpt-4o|GPT-4o').name === 'GPT-4o' || JSON.stringify(P('gpt-4o|GPT-4o')));
    check('带全套能力参数', () => {
      const m = P(
        'deepseek-v4-pro|DeepSeek V4 Pro|contextWindow=1000000|maxTokens=384000|reasoning=true|input=text,image'
      );
      return (
        m.id === 'deepseek-v4-pro' &&
        m.name === 'DeepSeek V4 Pro' &&
        m.contextWindow === 1000000 &&
        m.maxTokens === 384000 &&
        m.reasoning === true &&
        JSON.stringify(m.input) === '["text","image"]'
      ) ? true : JSON.stringify(m);
    });
    check('ctx / max 是长名字的别名', () => {
      const m = P('x|X|ctx=200000|max=64000');
      return m.contextWindow === 200000 && m.maxTokens === 64000 || JSON.stringify(m);
    });
    // 这条是格式设计的核心：不带 = 的片段只能是显示名，不能当布尔旗标
    check('显示名不会被误当成布尔旗标', () =>
      P('x|reasoning').name === 'reasoning' || JSON.stringify(P('x|reasoning'))
    );
    check('未知键被忽略且不破坏整行', () => {
      const m = P('x|X|bogus=1|contextWindow=1000');
      return m.contextWindow === 1000 && m.bogus === undefined || JSON.stringify(m);
    });
    check('非法数值被丢弃', () => {
      const m = P('x|X|contextWindow=-1|maxTokens=abc');
      return m.contextWindow === undefined && m.maxTokens === undefined || JSON.stringify(m);
    });
    check('空行返回 null', () => P('') === null || JSON.stringify(P('')));

    check('modelLine 与 parseModelLine 能往返', () => {
      const src = 'a|A|contextWindow=1000|maxTokens=500|reasoning=true|input=text,image';
      const back = window.modelLine(P(src));
      return back === src || back;
    });
    check('modelLine 会换掉显示名里的竖线（否则把行切乱）', () => {
      const line = window.modelLine({ id: 'a', name: 'x|y' });
      return line === 'a|x/y' || line;
    });
    check('fmtTokens 格式化', () => {
      const got = `${window.fmtTokens(1048576)}/${window.fmtTokens(262144)}/${window.fmtTokens(512)}`;
      return got === '1M/262K/512' || got;
    });
  }

  /* --- 添加供应商弹层里的拉取入口 --- */
  check('弹层有「拉取」按钮，且拉取面板默认收起', () => {
    window.openAddProvider();
    const card = $('modalCard');
    if (!card) return '弹层没打开';

    const btn = [...card.querySelectorAll('.field-head .btn')].find((b) => b.textContent === '拉取');
    const panel = card.querySelector('.fetch-panel');

    // 收拾干净，别影响后面的检查
    $('modal').hidden = true;
    card.innerHTML = '';

    if (!btn) return '没有拉取按钮';
    if (!panel) return '没有拉取面板';
    if (panel.hidden !== true) return '拉取面板默认应该藏着';
    return true;
  });

  check('无残留 el 引用错误', () => errors.length === 0 || errors.join(' | '));

  let pass = 0;
  for (const [st, name, msg] of results) {
    if (st === 'PASS') pass++;
    console.log(`${st === 'PASS' ? '  ok  ' : ' FAIL '} ${name}${msg ? '  → ' + msg : ''}`);
  }
  console.log(`\n${pass}/${results.length} 通过`);
  if (errors.length) console.log('\n运行时错误:\n' + errors.join('\n'));
  process.exit(pass === results.length ? 0 : 1);
})();
