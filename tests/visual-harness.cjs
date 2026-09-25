/* 视觉核对用的独立夹具服务。
 *
 * 为什么需要它：jsdom 不做布局（getBoundingClientRect 恒为 0），
 * 而真实会话里塞测试消息会污染用户的对话、还要花 token。
 * 所以这里起一个自己的服务，静态托管 public/，把 /api/* 全部换成脚本数据，
 * 并推一段固定的对话事件流 —— 页面代码一行都不用改，渲染路径却是真的。
 *
 * 用法：node tests/visual-harness.cjs   然后打开 http://127.0.0.1:7789/
 * 只用于开发期，不属于产品代码。 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PUB = path.join(__dirname, '..', 'public');
const UPLOAD_DIR = path.join(__dirname, '..', '.uploads');
const PORT = Number(process.env.HARNESS_PORT || 7789);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ---------------- 脚本数据 ---------------- */

const MODELS = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', reasoning: true },
];

// 实测 pi 只返回这三档（medium 会被静默映射成 high，所以不要放进夹具）
const LEVELS = ['off', 'high', 'max'];

const DOC_TEXT =
  '发酵罐空气分布器的设计参数核算\n' +
  '一、设计依据\n' +
  '依据《发酵工程设备设计手册》第 3 版，通风发酵罐采用单管式空气分布器，\n' +
  '出口气速取 10～15 m/s，管口距罐底 40 mm，罐底设置防冲刷钢板。\n' +
  '二、结构参数\n' +
  '罐体公称容积 V = 50 m³，装料系数 η = 0.75，实际装液量 37.5 m³。\n' +
  '通气量 Q = 1.2 vvm，则标准状态下空气流量为 0.75 m³/s。\n' +
  '空气分布器出口内径 d = √(4Q / (π·v))，取 v = 12 m/s，计算得 d ≈ 0.282 m。\n' +
  '圆整后取 DN300 无缝钢管，壁厚 6 mm。\n' +
  '三、结论\n' +
  '轴承与联轴器仅保留选用及布置说明，删去具体设计计算；\n' +
  '空气分布器补全结构、尺寸和通气核算，并检查其与下层叶轮、蛇管及排料口的位置关系。';

// 1×1 的琥珀色 PNG，只为了让缩略图有东西可显示
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const MESSAGES = [
  {
    role: 'user',
    content: [
      { type: 'text', text: `帮我核对一下这份设计说明里的通气量和管径，另外这张是现场照片。\n\n<pi-file name="发酵罐空气分布器设计.pdf" meta="1 页 · 386 字">\n${DOC_TEXT}\n</pi-file>` },
      { type: 'image', data: TINY_PNG, mimeType: 'image/png' },
    ],
  },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '先按手册第 3 版的公式核算出口内径，再检查通气量是否落在推荐区间内。' },
      {
        type: 'text',
        text:
          '核对结果如下：\n\n' +
          '**1. 通气量** 罐体 50 m³、装料系数 0.75，实际装液量 37.5 m³。按 1.2 vvm 计，标准状态空气流量 0.75 m³/s，与文档一致。\n\n' +
          '**2. 出口内径** 取 v = 12 m/s 时代入 `d = √(4Q / (π·v))`：\n\n' +
          '```\nd = sqrt(4 × 0.75 / (3.1416 × 12)) = 0.2821 m\n```\n\n' +
          '计算值与文档的 0.282 m 吻合，圆整取 DN300 合适。\n\n' +
          '**3. 需要补充的地方**\n\n' +
          '- 出口气速取 12 m/s 落在 10～15 m/s 区间内，但没有说明该值的选取依据；\n' +
          '- 管口距罐底 40 mm 与下层叶轮的相对位置未给出，建议补一张布置简图；\n' +
          '- 防冲刷钢板的尺寸和固定方式缺失。',
      },
    ],
  },
  /* 一段真实的工具执行：多调用 + 成功 + 失败（带退出码）+ 写文件。
   * 走的是 get_messages 重建这条路 —— 和刷新页面之后看到的是同一条路径，
   * 所以这里能同时核对「时间线长什么样」和「历史重建对不对」。 */
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '先把文档里的数字和仓库里的实现对一遍。' },
      { type: 'text', text: '我核对一下仓库里的实现。' },
      { type: 'toolCall', id: 'fx1', name: 'read', arguments: { path: 'src/fermenter/sizing.js' } },
      { type: 'toolCall', id: 'fx2', name: 'bash', arguments: { command: 'npm test -- fermenter' } },
      { type: 'toolCall', id: 'fx3', name: 'edit', arguments: { path: 'src/fermenter/sizing.js' } },
    ],
    timestamp: 1787125575000,
    stopReason: 'toolUse',
  },
  {
    role: 'toolResult',
    toolCallId: 'fx1',
    toolName: 'read',
    content: [{ type: 'text', text: 'export function outletDiameter(q, v) {\n  return Math.sqrt((4 * q) / (Math.PI * v));\n}\n\nexport function airFlow(vvm, volume, fill) {\n  return vvm * volume * fill;\n}\n' }],
    isError: false,
    timestamp: 1787125575300,
  },
  {
    role: 'toolResult',
    toolCallId: 'fx2',
    toolName: 'bash',
    content: [{ type: 'text', text: '> fermenter@1.0.0 test\n> node --test tests/fermenter\n\n✔ airFlow 用装料系数折算 (1.2ms)\n✔ outletDiameter 取 v=12 得 0.282 (0.8ms)\n✖ 圆整到 DN 系列 (2.1ms)\n\n  AssertionError: expected DN250 to equal DN300\n\n1 failing\nCommand exited with code 1' }],
    isError: true,
    timestamp: 1787125585000,
  },
  {
    role: 'toolResult',
    toolCallId: 'fx3',
    toolName: 'edit',
    content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in src/fermenter/sizing.js' }],
    details: {
      diff: '  11   const table = [200, 250, 300, 350];\n- 12   return table.find((d) => d >= mm);\n+ 12   return table.find((d) => d >= mm) ?? table[table.length - 1];\n  13 }\n',
      patch: '',
      firstChangedLine: 12,
    },
    isError: false,
    timestamp: 1787125586400,
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '对完了：\n\n- `airFlow` / `outletDiameter` 与文档公式一致；\n- 单测挂在圆整这一步：`find()` 找不到比 0.282 m 大的 DN 时返回 `undefined`，已补上兜底并重新跑通。',
      },
    ],
    timestamp: 1787125587000,
    stopReason: 'stop',
  },
];

/* ---------------- 工具 ---------------- */

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
};

const safeName = (name) =>
  path.basename(String(name || 'file')).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';

/* ---------------- SSE ---------------- */

const clients = new Set();

function push(evt) {
  const line = 'data: ' + JSON.stringify(evt) + '\n\n';
  for (const c of clients) {
    try {
      c.write(line);
    } catch {
      /* 客户端已断开 */
    }
  }
}

// 每个命令都回一条对应的 response，模拟 pi 的应答。
// 注意必须带 type:'response' —— 前端是按 evt.type 分发的，只有 command 会被丢掉。
function replyFor(cmd) {
  switch (cmd.type) {
    case 'get_state':
      return {
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          model: { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek' },
          thinkingLevel: 'high',
          sessionName: 'pi-GUI',
          isStreaming: false,
        },
      };
    case 'get_session_stats':
      return {
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: {
          contextUsage: { tokens: 61234, contextWindow: 1000000, percent: 6.1 },
          tokens: { input: 18420, output: 3110, cacheRead: 40200 },
          cost: 0.0842,
        },
      };
    case 'get_tree':
      /* 照 pi 的真实条目形状造（消息体嵌在 entry.message 里，各类型字段不同），
       * 并且刻意混入操作类条目（model_change / thinking_level_change）+ 一个分叉点
       * —— 桩形状不对，截图就证明不了用户会看到什么。 */
      return {
        type: 'response', command: 'get_tree', success: true,
        data: {
          tree: [
            {
              entry: { type: 'message', id: 'a', timestamp: '2026-09-25T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '帮我看看 server.js 的路由顺序' }] } },
              children: [
                {
                  entry: { type: 'message', id: 'b', timestamp: '2026-09-25T10:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '路由顺序没问题，但静态资源那段建议排在 API 之后。' }] } },
                  children: [],
                  label: '关键结论',
                },
                {
                  entry: { type: 'model_change', id: 'm1', timestamp: '2026-09-25T10:00:04.000Z', provider: 'deepseek', modelId: 'deepseek-v4-pro' },
                  children: [
                    {
                      entry: { type: 'thinking_level_change', id: 't1', timestamp: '2026-09-25T10:00:05.000Z', thinkingLevel: 'high' },
                      children: [
                        { entry: { type: 'message', id: 'c', timestamp: '2026-09-25T10:00:06.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '换个模型重答一次，结论一致。' }] } }, children: [] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      };
    case 'get_messages':
      return { type: 'response', command: 'get_messages', success: true, data: { messages: MESSAGES } };
    case 'get_available_models':
      return { type: 'response', command: 'get_available_models', success: true, data: { models: MODELS } };
    case 'get_available_thinking_levels':
      return { type: 'response', command: 'get_available_thinking_levels', success: true, data: { levels: LEVELS } };
    default:
      return { type: 'response', command: cmd.type, success: true, data: {} };
  }
}

/* ---------------- 服务 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (process.env.HARNESS_VERBOSE && p.startsWith('/api/')) console.log(`${req.method} ${p}`);

  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': harness\n\n');
    if (res.flushHeaders) res.flushHeaders();
    clients.add(res);
    req.on('close', () => clients.delete(res));

    // 等前端把 onopen/onmessage 挂好，再推 bridge_status 触发 boot()
    setTimeout(() => push({ type: 'bridge_status', state: 'ready' }), 250);
    return;
  }

  if (p === '/api/status') {
    return json(res, 200, { ok: true, piRunning: true, pid: 0, args: ['--mode', 'rpc'], cwd: process.cwd() });
  }

  if (p === '/api/projects') {
    return json(res, 200, {
      ok: true,
      active: 'C:\\pi-GUI',
      items: [
        { name: 'pi-GUI', path: 'C:\\pi-GUI' },
        { name: 'fermenter-notes', path: 'C:\\work\\fermenter-notes' },
      ],
    });
  }

  /* 会话列表（侧栏挂在当前项目那一行下面）。
   * 形状照抄后端真实返回 —— **不含任何绝对路径**，否则截图就没法用来看
   * 「界面上会不会漏出路径」。刻意混入一条已归档的，好让折叠组也出现在图里。 */
  if (p === '/api/sessions') {
    return json(res, 200, {
      ok: true,
      hasProject: true,
      currentId: 'aaaaaaaaaaaaaaaa',
      diagnostics: [],
      sessions: [
        { id: 'aaaaaaaaaaaaaaaa', title: '发酵罐空气分布器设计核算', sessionId: 'sid-cur', createdAt: '2026-09-25T10:00:00.000Z', lastMessageAt: '2026-09-25T10:30:00.000Z', updatedAt: Date.now() - 120000, messageCount: 12, current: true, pending: false, archived: false, truncated: false },
        { id: 'bbbbbbbbbbbbbbbb', title: '帮我把 README 的测试那节补全', sessionId: 'sid-b', createdAt: '2026-09-25T08:00:00.000Z', lastMessageAt: '2026-09-25T09:00:00.000Z', updatedAt: Date.now() - 5400000, messageCount: 8, current: false, pending: false, archived: false, truncated: false },
        { id: 'dddddddddddddddd', title: '检查 server.js 的路由顺序', sessionId: 'sid-d', createdAt: '2026-09-25T07:00:00.000Z', lastMessageAt: '2026-09-25T07:30:00.000Z', updatedAt: Date.now() - 9000000, messageCount: 21, current: false, pending: false, archived: false, truncated: false },
        { id: 'cccccccccccccccc', title: '上周的排查记录', sessionId: 'sid-c', createdAt: '2026-09-20T07:00:00.000Z', lastMessageAt: '2026-09-20T08:00:00.000Z', updatedAt: Date.now() - 400000000, messageCount: 5, current: false, pending: false, archived: true, truncated: false },
      ],
    });
  }

  if (p === '/api/providers') {
    return json(res, 200, {
      ok: true,
      path: path.join(process.env.USERPROFILE || '', '.pi', 'agent', 'models.json'),
      providers: {
        deepseek: { api: 'openai-completions', baseUrl: 'https://api.deepseek.com', models: MODELS },
      },
      keyStates: { deepseek: { kind: 'literal', ok: true, note: '' } },
    });
  }

  if (p === '/api/command' && req.method === 'POST') {
    const buf = await readBody(req);
    let cmd = {};
    try {
      cmd = JSON.parse(buf.toString('utf8') || '{}');
    } catch {
      return json(res, 400, { ok: false, error: '命令不是合法 JSON' });
    }
    json(res, 200, { ok: true });
    // 稍等一下再回，模拟真实往返，让加载态有机会被截到
    setTimeout(() => push(replyFor(cmd)), 30);
    return;
  }

  if (p === '/api/upload' && req.method === 'POST') {
    const buf = await readBody(req);
    const name = safeName(url.searchParams.get('name') || 'file');
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(UPLOAD_DIR, `${stamp}_${name}`);
    fs.writeFileSync(dest, buf);

    try {
      const { extract } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'extract.js')).href);
      const r = await extract(dest, name);
      return json(res, 200, {
        ok: true,
        id: stamp,
        name,
        size: buf.length,
        path: dest,
        kind: r.kind,
        pages: r.pages,
        note: r.note,
        chars: r.text ? r.text.length : undefined,
        text: r.text,
        preview: r.text ? r.text.slice(0, 200) : undefined,
      });
    } catch (err) {
      return json(res, 200, { ok: true, id: stamp, name, size: buf.length, path: dest, kind: 'binary', error: err.message });
    }
  }

  if (p === '/api/restart') return json(res, 200, { ok: true });

  // 排查用：手动往事件流里推一条，确认前端到底收没收到
  if (p === '/api/__push') {
    const what = url.searchParams.get('what') || 'user';
    if (what === 'user') {
      push({ type: 'message_start', message: { role: 'user', content: '手动推一条\n\n<pi-file name="推.pdf" meta="1 页">\n正文\n</pi-file>' } });
    } else if (what === 'state') {
      push(replyFor({ type: 'get_state' }));
    } else if (what === 'stats') {
      push(replyFor({ type: 'get_session_stats' }));
    } else if (what === 'models') {
      push(replyFor({ type: 'get_available_models' }));
    }
    return json(res, 200, { ok: true, pushed: what, clients: clients.size });
  }

  if (p === '/api/fs') return json(res, 200, { ok: true, items: [] });

  // 静态文件
  const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
  const file = path.join(PUB, rel);
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`视觉夹具已启动: http://127.0.0.1:${PORT}/`);
});
