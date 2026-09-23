/* Pi GUI 前端冒烟测试：在 jsdom 里真实加载 index.html + app.js，
 * 用假的 EventSource / fetch 灌入 pi 的 RPC 事件，检查渲染结果与报错。 */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PUB = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const code = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');

const errors = [];
const commands = [];
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

/* --- 静态检查：el.X 必须在 el 对象里，$('id') 必须在 HTML 里 --- */
function staticCheck() {
  const elBlock = code.match(/const el = \{([\s\S]*?)\n\};/);
  const keys = new Set([...elBlock[1].matchAll(/^\s*([a-zA-Z0-9_]+)\s*:/gm)].map((m) => m[1]));
  const used = new Set([...code.matchAll(/\bel\.([a-zA-Z0-9_]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((k) => !keys.has(k));
  check('el 对象覆盖全部引用', () => (missing.length ? '缺失: ' + missing.join(', ') : true));

  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const wanted = new Set([...code.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
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
