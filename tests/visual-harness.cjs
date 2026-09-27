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

/* 1000 字的审阅说明（§四十七的压力项）—— 中文按 1 字计，正好卡在上限。 */
const LONG_NOTE = '这段实现把重连窗口里的过期响应丢掉了，但我对边界条件仍有疑问：高并发下 bridgeRun 的自增与读取之间还有一个窗口，需要补一个针对性的用例。'.repeat(20).slice(0, 1000);
/* 超长路径（§四十八）—— 必须被截断 + title 提示，不能把卡片撑爆。 */
const LONG_PATH = 'packages/something/really/really/really/long/path/to/generated/adapter/implementation.js';
/* P9 压力项（§十二.22「长命令 / 长输出布局」）：
 * 一条带满参数的长命令 + 一段含超长无空格行的输出 —— 两者都不许把卡片撑破。 */
const LONG_COMMAND = 'npm run test -- --reporter=spec --grep "reconnect|stale|bridgeRun|sse-backlog" --timeout=30000 --reporter-options maxDiffSize=200000';
const LONG_OUTPUT = ('not ok 42 - reconnect keeps the newest run\n  AssertionError: expected 2 to equal 1' + 'Z'.repeat(180) + '\n').repeat(6);

/* P7 计划详情夹具：四种「会话」状态各一条，外加两次尝试。
 * 形状照抄后端 `planView()` 的输出（attempt 上带 sessionAvailable / sessionTitle）。
 *
 * P8-C 在同一份夹具上补齐审阅场景（§五十七 Scene 1–5）：
 *   analyze  成功 + 已接受 + 说明 + verificationSnapshot(command)  → Scene 2
 *   backend  Attempt1 失败、Attempt2 失败 + 需修改 + 说明           → Scene 3 / Scene 5
 *   tests    成功 + 待审阅 + snapshot(description)                 → Scene 1
 *   docs     成功 + 待审阅 + 没有快照 + changeCaptureIncomplete     → 「没有历史验证要求」
 *   live     Attempt1 已接受、Attempt2 执行中（运行期不给审阅操作）  → Scene 4 / §九
 *   hub      被中断 → 汇总必须单列「中断」，**不并进「失败」**       → P8 收口 blocker
 *
 * 【审阅状态字段名】`review.status` 只有 pending / accepted / needs_changes 三态，
 * 与后端 REVIEW_STATUS 一致 —— 夹具不能自己发明 `verified` / `stale`。
 * 【形状】attempt 上的 review 就是后端 `normalizeReview` 的形状：
 * `{status, note, reviewedAt, revision}`；pending 时 note 为空串、reviewedAt 为 null。 */
const PLAN_DETAIL = {
  id: 'plan-1',
  title: '修复 SSE 重连问题',
  goal: '让 bridgeRun 的过期响应不再覆盖新状态',
  status: 'paused',
  createdAt: 1,
  updatedAt: 2,
  startedAt: 1,
  endedAt: null,
  projectRoot: 'C:/pi-GUI',
  concurrency: 1,
  recoveryNotes: [],
  tasks: [
    {
      id: 'analyze', title: '分析原因', description: '读 rpc-bridge 的重连路径', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'success', startedAt: 1, endedAt: 2, attempt: 1, error: '', verification: null,
      attempts: [{
        attempt: 1, success: true, error: '', summary: '读完了', exitCode: 0, startedAt: 1, endedAt: 2,
        sessionId: 'pi-gui-plan-1-analyze-a1', sessionAvailable: true, sessionTitle: 'SSE race analysis',
        filesChanged: ['src/auth.js'], changeCaptureIncomplete: false,
        outcomeStatus: 'success', verificationSnapshot: { command: 'npm test' },
        review: { status: 'accepted', note: '第一次实现已确认', reviewedAt: 1758800000000, revision: 2 },
        /* P9：Pi GUI 自己跑过一遍的真实证据 → Scene「验证通过」 */
        verificationResult: { status: 'passed', command: 'npm test', exitCode: 0, startedAt: 1758800001000, finishedAt: 1758800042000, durationMs: 41000, outputSummary: 'ok 740/740 通过\ntests 12 passed, 0 failed\n\n（退出码 0）', truncated: false, error: '' },
      }],
      result: { success: true, exitCode: 0, summary: '重连时 bridgeRun 会自增，但过期响应仍会写回状态', toolCalls: 4, durationMs: 42000, raw: null, sessionId: 'pi-gui-plan-1-analyze-a1', changes: { available: true, files: [], note: '' } },
    },
    {
      id: 'backend', title: '修复后端', description: '丢掉过期响应', agent: 'pi',
      workingDirectory: '.', dependsOn: ['analyze'], status: 'failed', startedAt: 3, endedAt: 6, attempt: 2, error: '第一次故意失败：模型报 402',
      verification: null,
      attempts: [
        { attempt: 1, success: false, error: '第一次故意失败：模型报 402', summary: '', exitCode: 1, startedAt: 3, endedAt: 4, sessionId: 'pi-gui-plan-1-backend-a1', sessionAvailable: true, sessionTitle: 'bridge reconnect fix（第一次）', filesChanged: ['server/rpc-bridge.js'], changeCaptureIncomplete: false, outcomeStatus: 'failed', verificationSnapshot: { command: 'npm test' }, review: { status: 'pending', note: '', reviewedAt: null, revision: 0 },
          /* P9：失败 + 输出被截断（要能看出「输出已截断」这句）→ Scene「验证失败」 */
          verificationResult: { status: 'failed', command: 'npm test', exitCode: 1, startedAt: 1758800050000, finishedAt: 1758800068400, durationMs: 18400, outputSummary: 'not ok 118 - bridge drops stale response\n  AssertionError: expected 2 to equal 1\n    at tests/reliability.cjs:88:7\nnot ok 119 - reconnect keeps the newest run\nnpm ERR! Test failed. See above for more details.', truncated: true, error: '' } },
        { attempt: 2, success: false, error: '第二次也失败：模型报 402', summary: '', exitCode: 1, startedAt: 5, endedAt: 6, sessionId: 'pi-gui-plan-1-backend-a2', sessionAvailable: true, sessionTitle: 'bridge reconnect fix（第二次）', filesChanged: ['server/rpc-bridge.js', 'server/sse.js'], changeCaptureIncomplete: false, outcomeStatus: 'failed', verificationSnapshot: { command: 'npm test' }, review: { status: 'needs_changes', note: '两次都报 402，先把 provider 配额确认了再重试', reviewedAt: 1758800100000, revision: 1 } },
      ],
      result: { success: false, exitCode: 1, summary: '', toolCalls: 0, durationMs: 3000, raw: null, sessionId: 'pi-gui-plan-1-backend-a2', changes: { available: true, files: [{ path: 'server/rpc-bridge.js', change: 'modified', status: 'M', additions: 12, deletions: 3 }, { path: 'server/sse.js', change: 'modified', status: 'M', additions: 4, deletions: 0 }], note: '执行期间观察到的工作区变化（可能也包含其它来源的改动）' } },
    },
    {
      id: 'tests', title: '补测试', description: '加可靠性用例', agent: 'codex',
      workingDirectory: '.', dependsOn: ['backend'], status: 'blocked', startedAt: 7, endedAt: 8, attempt: 1, error: '', verification: null,
      attempts: [{
        attempt: 1, success: true, error: '', summary: '', exitCode: 0, startedAt: 7, endedAt: 8,
        sessionId: null, sessionAvailable: false, sessionTitle: '',
        filesChanged: ['tests/reliability.cjs'], changeCaptureIncomplete: false,
        outcomeStatus: 'success', verificationSnapshot: { description: '确认登录错误提示' },
        review: { status: 'pending', note: '', reviewedAt: null, revision: 0 },
      }],
      result: null,
    },
    {
      id: 'docs', title: '更新文档', description: '把语义写清楚', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'success', startedAt: 9, endedAt: 10, attempt: 1, error: '',
      verification: { command: 'npm run test:unit' },
      attempts: [{
        attempt: 1, success: true, error: '', summary: '', exitCode: 0, startedAt: 9, endedAt: 10,
        sessionId: 'pi-gui-plan-1-docs-a1', sessionAvailable: false, sessionTitle: '',
        filesChanged: [], changeCaptureIncomplete: true,
        outcomeStatus: 'success', verificationSnapshot: null,
        review: { status: 'pending', note: '', reviewedAt: null, revision: 0 },
      }],
      result: null,
    },
    {
      /* 正在执行的任务：历史里有一次已接受的尝试，第 2 次正在跑（历史里还没有它）。
       * 用来核对 §九「运行期不给审阅操作」与 §二十四「历史 accepted 不被隐藏」。 */
      id: 'live', title: '正在跑的任务', description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'running', startedAt: 11, endedAt: null, attempt: 2, error: '',
      verification: null,
      attempts: [{
        attempt: 1, success: true, error: '', summary: '', exitCode: 0, startedAt: 11, endedAt: 12,
        sessionId: 'pi-gui-plan-1-live-a1', sessionAvailable: true, sessionTitle: '第一轮（已接受）',
        filesChanged: ['server/sse.js'], changeCaptureIncomplete: false,
        outcomeStatus: 'success', verificationSnapshot: { command: 'npm test' },
        review: { status: 'accepted', note: '第一轮的实现保留', reviewedAt: 1758800200000, revision: 1 },
        /* P9：**正在跑**的那一次验证（`verificationRunning` 是后端注入的视图字段，
         * 表示「本进程正在跑」，夹具里手动置上）→ Scene「正在验证…」+ 停止按钮 */
        verificationResult: { status: 'running', command: 'npm test', exitCode: null, startedAt: 1758800300000, finishedAt: null, durationMs: null, outputSummary: '', truncated: false, error: '' },
        verificationRunning: true,
      }],
      result: null,
    },
    {
      /* 被中断的任务：用来核对 Plan 汇总把 interrupted **单列**成「中断」，
       * 而不是并进「失败」（P8 最终收口的两个 blocker 之一）。
       * 没有它，汇总里那个新 token 在截图里根本不会出现。 */
      id: 'hub', title: '被中断的任务', description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'interrupted', startedAt: 13, endedAt: 14, attempt: 1,
      error: '应用关闭时被中断', verification: null,
      attempts: [{
        attempt: 1, success: false, error: '应用关闭时被中断', summary: '', exitCode: null, startedAt: 13, endedAt: 14,
        sessionId: 'pi-gui-plan-1-hub-a1', sessionAvailable: true, sessionTitle: '被中断的那次',
        filesChanged: [], changeCaptureIncomplete: true,
        outcomeStatus: 'interrupted', verificationSnapshot: { command: 'npm run build' },
        review: { status: 'pending', note: '', reviewedAt: null, revision: 0 },
        /* P9：被中断的验证（命令跑着，应用被关掉）→ Scene「已中断」 */
        verificationResult: { status: 'interrupted', command: 'npm run build', exitCode: null, startedAt: 1758800070000, finishedAt: 1758800075000, durationMs: 5000, outputSummary: '', truncated: false, error: '应用关闭时被中断' },
      }],
      result: null,
    },
  ],
};

/* 压力夹具（§五十八）：1000 字说明 / 20 个变更文件 / 超长路径 / 10 次尝试。
 * 单独一个计划是为了让上面的默认场景保持干净 —— 组合在一起截图会糊成一片。 */
const PLAN_STRESS = {
  id: 'plan-stress',
  title: '压力场景：长说明 / 多文件 / 多次尝试',
  goal: '验证极端内容不破布局',
  status: 'completed',
  createdAt: 1,
  updatedAt: 2,
  startedAt: 1,
  endedAt: 9,
  projectRoot: 'C:/pi-GUI',
  concurrency: 1,
  recoveryNotes: [],
  tasks: [
    {
      id: 'longnote', title: '带 1000 字说明的任务', description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'success', startedAt: 1, endedAt: 2, attempt: 1, error: '', verification: null,
      attempts: [{
        attempt: 1, success: true, error: '', summary: '', exitCode: 0, startedAt: 1, endedAt: 2,
        sessionId: 'pi-gui-plan-stress-a1', sessionAvailable: true, sessionTitle: '长说明',
        filesChanged: Array.from({ length: 20 }, (_, i) => (i === 3 ? LONG_PATH : `src/generated/module-${i}.js`)),
        changeCaptureIncomplete: false,
        outcomeStatus: 'success', verificationSnapshot: { command: LONG_COMMAND },
        review: { status: 'accepted', note: LONG_NOTE, reviewedAt: 1758800300000, revision: 1 },
        /* 长命令 + 长输出（且被截断）—— 排版压力项 */
        verificationResult: { status: 'failed', command: LONG_COMMAND, exitCode: 1, startedAt: 1758800310000, finishedAt: 1758800331800, durationMs: 21800, outputSummary: LONG_OUTPUT, truncated: true, error: '' },
      }],
      result: null,
    },
    {
      id: 'manyattempts', title: '跑了 10 次的任务', description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'failed', startedAt: 1, endedAt: 9, attempt: 10, error: '第十次仍然失败：断言超时',
      verification: null,
      attempts: Array.from({ length: 10 }, (_, i) => ({
        attempt: i + 1,
        success: i === 9 ? false : i % 2 === 0,
        error: i === 9 ? '第十次仍然失败：断言超时' : i % 2 === 0 ? '' : `第 ${i + 1} 次失败：连接超时`,
        summary: '', exitCode: i % 2 === 0 ? 0 : 1,
        startedAt: i * 10 + 1, endedAt: i * 10 + 5,
        sessionId: `pi-gui-plan-stress-many-a${i + 1}`, sessionAvailable: true, sessionTitle: `第 ${i + 1} 次尝试的会话`,
        filesChanged: [`src/try-${i + 1}.js`], changeCaptureIncomplete: false,
        outcomeStatus: i === 9 ? 'failed' : i % 2 === 0 ? 'success' : 'failed',
        verificationSnapshot: { command: 'npm test' },
        review: i === 0 ? { status: 'accepted', note: '第一次曾经通过', reviewedAt: 1758800400000, revision: 1 } : { status: 'pending', note: '', reviewedAt: null, revision: 0 },
      })),
      result: null,
    },
  ],
};


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

  /* ---------- P7：Planner 与任务工作流 ----------
   *
   * 夹具服务原本没有桩这两个接口，于是「任务面板」与「会话头部的关联任务」
   * 在截图里都是空的 —— 那等于没验。这里补上，让 P7 的排版能被真看到。
   *
   * ⚠️ 顺序要紧：`/api/plans/relations` 必须排在 `/api/plans/` 前缀之前，
   * 否则会被当成「查一个 id 叫 relations 的计划」（与 router.js 同一类坑）。 */
  if (p === '/api/agents') {
    return json(res, 200, {
      ok: true,
      auto: 'pi',
      available: ['pi', 'codex'],
      activePlanId: null,
      hasProject: true,
      agents: [
        { id: 'pi', name: 'Pi', description: 'pi coding agent（本机主 Agent）', available: true, version: '0.87.0', reason: '', detail: '', capabilities: { streaming: true, cancellation: true, resume: true, toolEvents: true, sessionLinking: true }, notes: [], testOnly: false },
        { id: 'codex', name: 'Codex', description: 'OpenAI Codex CLI', available: true, version: '0.30.0', reason: '', detail: '', capabilities: { streaming: true, cancellation: true, resume: true, toolEvents: true, sessionLinking: false }, notes: [], testOnly: false },
        { id: 'claude', name: 'Claude Code', description: 'Anthropic Claude Code CLI', available: false, version: '', reason: 'not-installed', detail: '找不到 npm 包 @anthropic-ai/claude-code', capabilities: { streaming: false, cancellation: true, resume: false, toolEvents: false, sessionLinking: false }, notes: [], testOnly: false },
      ],
    });
  }

  if (p === '/api/plans/relations') {
    const sid = url.searchParams.get('sessionId') || '';
    return json(res, 200, {
      ok: true,
      hasProject: true,
      sessionId: sid,
      truncated: false,
      matches: sid === 'sid-cur'
        ? [
            { planId: 'plan-1', planTitle: '修复 SSE 重连问题', planStatus: 'running', taskId: 'backend', taskTitle: '修改后端', taskStatus: 'running', agent: 'pi', attempt: 2, startedAt: Date.now() - 60000, endedAt: null, success: false, filesChanged: ['server/rpc-bridge.js'] },
            { planId: 'plan-1', planTitle: '修复 SSE 重连问题', planStatus: 'running', taskId: 'tests', taskTitle: '补测试', taskStatus: 'pending', agent: 'pi', attempt: 1, startedAt: null, endedAt: null, success: false, filesChanged: [] },
          ]
        : [],
    });
  }

  if (p === '/api/plans') {
    return json(res, 200, {
      ok: true,
      hasProject: true,
      activePlanId: null,
      broken: [],
      plans: [
        { id: 'plan-1', title: '修复 SSE 重连问题', goal: '让 bridgeRun 的过期响应不再覆盖新状态', status: 'paused', createdAt: 1, updatedAt: 2, startedAt: 1, endedAt: null, projectRoot: 'C:/pi-GUI', counts: { total: 6, success: 4, failed: 1, cancelled: 0, skipped: 0 }, recoveryNotes: [] },
        { id: 'plan-stress', title: '压力场景：长说明 / 多文件 / 多次尝试', goal: '验证极端内容不破布局', status: 'completed', createdAt: 0, updatedAt: 9, startedAt: 1, endedAt: 9, projectRoot: 'C:/pi-GUI', counts: { total: 2, success: 1, failed: 1, cancelled: 0, skipped: 0 }, recoveryNotes: [] },
      ],
    });
  }

  /* 人工审阅的保存（P8-C）。真后端是 `PUT …/attempts/:attempt/review`。
   * 这里按 taskId 分流三种结果，好让视觉核对能截到**冲突**与**业务失败**两种 UI：
   *   tests → 409 冲突（别的窗口已经改过这条审阅）
   *   docs  → 200 但业务失败（状态与执行结论不符）
   *   其它  → 正常保存，回 revision + 1
   * ⚠️ 冲突在这里是**真 409**，但前端只能靠 body 里的 `code` 认出来 ——
   *    api.js 只读 `r.json()`，从不看状态码。 */
  const reviewHit = /^\/api\/plans\/([^/]+)\/tasks\/([^/]+)\/attempts\/(\d+)\/review$/.exec(p);
  if (reviewHit && req.method === 'PUT') {
    const planId = reviewHit[1];
    const taskId = reviewHit[2];
    const attempt = Number(reviewHit[3]);
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {
      return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    const expected = Number.isInteger(body.expectedRevision) ? body.expectedRevision : 0;
    if (taskId === 'tests' && body.status !== 'pending') {
      return json(res, 409, { ok: false, code: 'review-conflict', error: '这条审阅记录已经在其他窗口被修改，请重新加载。', currentRevision: expected + 1 });
    }
    if (taskId === 'docs' && body.status !== 'pending') {
      return json(res, 200, { ok: false, error: '这次执行没有成功，不能标记为「已接受」（可以标记「需修改」）' });
    }
    return json(res, 200, {
      ok: true,
      planId,
      taskId,
      attempt,
      review: {
        status: body.status,
        note: body.status === 'pending' ? '' : String(body.note || ''),
        reviewedAt: body.status === 'pending' ? null : Date.now(),
        revision: expected + 1,
      },
    });
  }

  if (p === '/api/plans/plan-1') {
    if (req.method === 'POST') return json(res, 200, { ok: true, planId: 'plan-1' });
    return json(res, 200, { ok: true, plan: PLAN_DETAIL, counts: { total: 6, success: 4, failed: 1, cancelled: 0, skipped: 0 }, agents: [], activePlanId: null });
  }
  if (p === '/api/plans/plan-stress') {
    if (req.method === 'POST') return json(res, 200, { ok: true, planId: 'plan-stress' });
    return json(res, 200, { ok: true, plan: PLAN_STRESS, counts: { total: 2, success: 1, failed: 1, cancelled: 0, skipped: 0 }, agents: [], activePlanId: null });
  }
  if (p.startsWith('/api/plans/')) {
    return json(res, 200, { ok: true, planId: 'plan-1', taskId: 'backend', title: '修复 bridgeRun stale response' });
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
