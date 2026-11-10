/* 真实 Pi Agent 验收（opt-in，不属于 npm test canonical 链）。
 *
 * 目的：证明 `gui_plan` 不是测试夹具里的假工具，而是真实 Pi 进程加载
 * extensions/pi-gui-plan 后注册、被模型实际调用，并且真实事件经过服务端
 * 窄投影后能进入 Runtime UI。
 *
 * 隔离：
 *   - 项目目录、PI_CODING_AGENT_DIR 全部在 os.tmpdir() 里新建；
 *   - auth.json / models.json 只读复制到临时 agent 目录，运行后整目录删除；
 *   - 使用 --no-session，不写用户真实会话；
 *   - 证据只记录 plan 白名单字段与事件类型，不记录凭据、原始 args/result。
 *
 * 用法：node tests/agent-execution-real-pi.cjs
 * 产物：.shots/agent-execution/real-pi-plan.json
 *
 * 依赖真实网络与该机器已配置的模型供应商；失败时会明确报出阶段，不伪造成功。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.shots', 'agent-execution');
const ENTRY = process.argv[2]
  || path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
const MODEL = process.env.PI_REAL_MODEL || 'opencode-go/deepseek-v4.1-flash';
const PROVIDER = process.env.PI_REAL_PROVIDER || 'magpie';
const PROMPT = '请先调用 gui_plan 工具登记一个两项任务计划：id 为 inspect、标题为「读取 README」、状态为 in_progress；'
  + 'id 为 verify、标题为「运行检查」、状态为 pending。调用后不要再执行其他工具，用一句话说明计划已登记。';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseLines(onLine) {
  let buffer = '';
  return chunk => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      onLine(event);
    }
  };
}

async function runPiAttempt(world, attempt) {
  const agent = path.join(world, 'agent');
  const project = path.join(world, 'project');
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), 'real-pi acceptance fixture\n');
  for (const file of ['auth.json', 'models.json']) {
    const from = path.join(os.homedir(), '.pi', 'agent', file);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(agent, file));
  }
  const args = ['--mode', 'rpc', '--no-extensions', '-e', path.join(ROOT, 'extensions', 'pi-gui-plan', 'index.js'),
    '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--offline', '--no-session',
    '--provider', PROVIDER, '--model', MODEL, '--tools', 'gui_plan'];
  const child = spawn(process.execPath, [ENTRY, ...args], {
    cwd: project,
    env: { ...process.env, PI_CODING_AGENT_DIR: agent },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events = [];
  let stderr = '';
  let settled = false;
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } reject(Error('real_pi_timeout')); }, 150000);
    const finish = () => { clearTimeout(timer); resolve(); };
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.stdout.on('data', parseLines(event => {
      events.push(event);
      if (event.type === 'agent_settled') { settled = true; finish(); }
    }));
    child.once('exit', code => { if (settled) finish(); else { clearTimeout(timer); reject(Error('real_pi_exit_' + code + (stderr ? ': ' + stderr.slice(-400) : ''))); } });
  });
  child.stdin.write(JSON.stringify({ id: 'prompt-' + attempt, type: 'prompt', message: PROMPT }) + '\n');
  try {
    await done;
  } finally {
    try { child.stdin.end(); } catch { /* ignore */ }
    await sleep(200);
    try { child.kill(); } catch { /* ignore */ }
  }
  return { events, stderr };
}

function planFrom(events, type) {
  const event = events.find(item => item.type === type && item.toolName === 'gui_plan');
  if (!event) return null;
  return type === 'tool_execution_start' ? event.args : event.result?.details;
}

(async () => {
  if (!fs.existsSync(ENTRY)) throw Error('找不到真实 Pi 入口：' + ENTRY);
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-real-plan-'));
  let captured = null;
  try {
    for (let attempt = 1; attempt <= 2 && !captured; attempt++) {
      const run = await runPiAttempt(world, attempt);
      const start = planFrom(run.events, 'tool_execution_start');
      const end = planFrom(run.events, 'tool_execution_end');
      if (start?.tasks?.length && end?.tasks?.length) captured = { ...run, start, end };
      else if (attempt === 1) await sleep(500);
    }
    if (!captured) throw Error('真实模型没有调用 gui_plan（已重试一次）');

    const { projectRuntimeEvent } = await import('../server/session-runtime.js');
    const projected = captured.events
      .filter(event => ['agent_start', 'message_start', 'message_update', 'message_end', 'tool_execution_start', 'tool_execution_end', 'agent_settled'].includes(event.type))
      .map(projectRuntimeEvent);
    const projectedStart = projected.find(event => event.type === 'tool_execution_start' && event.toolName === 'gui_plan');
    const projectedEnd = projected.find(event => event.type === 'tool_execution_end' && event.toolName === 'gui_plan');
    if (!projectedStart?.plan || !projectedEnd?.plan) throw Error('gui_plan 的真实事件没有通过服务端窄投影');
    if ('args' in projectedStart || 'result' in projectedEnd) throw Error('服务端投影泄漏了原始 args/result');
    const serialized = JSON.stringify(projected);
    if (serialized.includes('SECRET') || serialized.includes('auth.json') || serialized.includes('apiKey')) {
      throw Error('服务端投影含有敏感字段');
    }

    /* 把真实投影事件喂给真正的 Runtime store + conversation 视图（jsdom），
     * 证明计划状态不是只存在于脚本断言里，而是能渲染进 UI。 */
    const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'), {
      url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
    });
    global.window = dom.window;
    global.document = dom.window.document;
    global.localStorage = dom.window.localStorage;
    global.HTMLElement = dom.window.HTMLElement;
    global.Event = dom.window.Event;
    global.CustomEvent = dom.window.CustomEvent;
    global.Node = dom.window.Node;
    global.MutationObserver = dom.window.MutationObserver;
    global.ResizeObserver = dom.window.ResizeObserver;
    global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
    global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
    dom.window.fetch = async () => ({ ok: true, json: async () => ({ ok: true, files: [], isRepo: false }) });
    global.fetch = dom.window.fetch;

    const { runtimeStore, observeRuntimeFrame } = await import('../public/runtime-state.js');
    const { createRuntimeConversation } = await import('../public/runtime-conversation.js');
    const owner = { backendInstance: 'real-pi-backend', projectId: 'real-pi', repoId: 'real-pi', workspaceId: 'real-pi-ws',
      workspaceEpoch: 'real-pi-epoch', conversationId: 'REAL', runtimeId: 'real-pi-runtime', runtimeGeneration: 'real-pi-gen', sessionId: 'real-pi-session' };
    runtimeStore.seed({ backendInstance: 'real-pi-backend', items: [{ conversationId: 'REAL', owner,
      lifecycle: 'ready', activity: 'running', revision: 1, workspace: { branch: 'real-pi' } }] });
    let sequence = 0;
    for (const event of projected) {
      if (event.type === 'response') continue;
      observeRuntimeFrame({ type: 'runtime_event', owner, eventSequence: ++sequence, event });
    }
    await sleep(20);
    const host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    const view = createRuntimeConversation({ host });
    view.show('REAL');
    await sleep(20);
    const planCard = host.querySelector('.ui2-runtime-plan .plan-card');
    if (!planCard) throw Error('真实计划没有进入 Runtime UI');
    const tasks = [...planCard.querySelectorAll('.plan-item')].map(row => ({
      id: row.dataset.taskId || null, status: row.dataset.status, title: row.querySelector('.plan-text')?.textContent || '',
    }));
    const count = planCard.querySelector('.plan-count')?.textContent;
    if (count !== '0/2') throw Error('Runtime UI 计划计数不是 0/2：' + count);
    if (!tasks.some(task => task.status === 'in_progress' && task.title.includes('读取 README'))) throw Error('Runtime UI 缺少真实 in_progress 任务');
    if (!tasks.some(task => task.status === 'pending' && task.title.includes('运行检查'))) throw Error('Runtime UI 缺少真实 pending 任务');
    if (host.querySelectorAll('.ui2-runtime-tool[data-tool-name="gui_plan"]').length) throw Error('gui_plan 重复进入工具行');
    if (typeof projectedEnd.plan.turnId !== 'string' || !projectedEnd.plan.turnId) throw Error('真实计划结果缺少运行边界 turnId');
    view.dispose();
    dom.window.close();

    fs.mkdirSync(OUT, { recursive: true });
    const evidence = {
      capturedAt: new Date().toISOString(),
      piVersion: process.env.PI_REAL_VERSION || null,
      provider: PROVIDER,
      model: MODEL,
      planStart: projectedStart.plan,
      planEnd: projectedEnd.plan,
      ui: { count, tasks },
      eventTypes: projected.map(event => event.type),
      rawPayloadRecorded: false,
    };
    fs.writeFileSync(path.join(OUT, 'real-pi-plan.json'), JSON.stringify(evidence, null, 2));
    console.log('REAL PI PLAN: ' + projectedStart.plan.tasks.map(task => `${task.id}=${task.status}`).join(', '));
    console.log('Runtime UI: ' + count + ' / ' + tasks.map(task => `${task.title}=${task.status}`).join(' / '));
    console.log('Evidence: ' + path.join(OUT, 'real-pi-plan.json'));
    console.log('Real Pi plan acceptance: 1/1 calls, ' + projected.length + ' projected events');
  } finally {
    fs.rmSync(world, { recursive: true, force: true });
  }
})().catch(error => {
  console.error('REAL PI ACCEPTANCE FAILED: ' + error.message);
  process.exitCode = 1;
});
