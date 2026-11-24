/* 文件引用必须绑定“消息所属会话”的工作区。
 *
 * 这是渲染层的契约测试：同一相对路径 `src/app.js` 在 A/B 两个工作区里必须
 * 生成不同的 data-file-cwd，历史消息用历史会话自己的 cwd，没有 cwd 的旧
 * 记录保持纯文本。真实文件解析与拒绝跨工作区见 file-links-backend.cjs。 */
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

(async () => {
  let checks = 0;
  const ok = (label, value) => { assert.ok(value, label); checks++; console.log('  ok  ' + label); };

  const dom = new JSDOM('<div id="host"></div><div id="modal" hidden><div id="modalCard"></div></div>'
    + '<div id="confirmLayer" hidden><div id="confirmCard"></div></div><div id="toasts"></div>', { url: 'http://127.0.0.1/' });
  global.window = dom.window; global.document = dom.window.document; global.localStorage = dom.window.localStorage;

  const A_CWD = 'C:/work/project-a';
  const B_CWD = 'C:/work/project-b';
  const D_CWD = 'C:/work/project-d';

  const history = {
    D: [{ role: 'user', text: '历史问题' }, { role: 'assistant', text: '历史里改了 `src/app.js:12`' }],
  };
  global.fetch = async (url, opts = {}) => ({ json: async () => {
    const u = String(url);
    if (!opts.body) {
      const match = /conversationId=([^&]+)/.exec(u);
      if (match) {
        const id = decodeURIComponent(match[1]);
        return { ok: true, sessionId: 's-' + id, messages: history[id] || [], truncated: false };
      }
      return { ok: true, backendInstance: 'backend', items: [] };
    }
    return { ok: true };
  } });

  const { runtimeStore, observeRuntimeFrame } = await import('../public/runtime-state.js');
  const { createRuntimeConversation } = await import('../public/runtime-conversation.js');

  const owner = (id) => ({ backendInstance: 'backend', projectId: 'project', repoId: 'repo', workspaceId: 'ws-' + id,
    workspaceEpoch: 'epoch', conversationId: id, runtimeId: 'rt-' + id, runtimeGeneration: 'one', sessionId: 's-' + id });
  const item = (id, cwd) => ({ conversationId: id, createdAt: '2026-01-01T00:00:00.000Z', workspace: cwd ? { projectId: 'project', cwd } : { projectId: 'project' },
    owner: owner(id), lifecycle: 'ready', activity: 'running', attention: false, error: null, stop: null });
  const frame = (id, seq, text) => observeRuntimeFrame({ type: 'runtime_event', owner: owner(id), eventSequence: seq,
    event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } } });

  runtimeStore.seed({ backendInstance: 'backend', items: [
    item('A', A_CWD),
    item('B', B_CWD),
    { conversationId: 'D', createdAt: '2026-01-02T00:00:00.000Z', workspace: { projectId: 'project', cwd: D_CWD },
      owner: null, lifecycle: 'dormant', activity: 'idle', attention: false, error: null, stop: null },
    { conversationId: 'E', createdAt: '2026-01-03T00:00:00.000Z', workspace: { projectId: 'project' },
      owner: owner('E'), lifecycle: 'ready', activity: 'running', attention: false, error: null, stop: null },
  ] });

  const host = document.querySelector('#host');
  const view = createRuntimeConversation({ host });
  const output = () => host.querySelector('.rtc-output');
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
  const chips = () => [...output().querySelectorAll('a.md-file-link')];

  view.show('A');
  frame('A', 1, '实时改动在 `src/app.js:12`');
  await tick();
  const aChip = chips()[0];
  ok('实时消息渲染出文件链接', Boolean(aChip) && aChip.dataset.filePath === 'src/app.js');
  ok('实时链接的行号被保留', aChip?.dataset.fileLine === '12' && aChip.textContent.includes('app.js:12'));
  ok('实时链接绑定当前消息会话的 cwd', aChip?.dataset.fileCwd === A_CWD && aChip.dataset.fileConversation === 'A');

  view.show('B');
  frame('B', 1, '另一个工作区 `src/app.js`');
  await tick();
  const bChip = chips()[0];
  ok('同名相对路径在 B 会话绑定 B 的 cwd', bChip?.dataset.filePath === 'src/app.js' && bChip.dataset.fileCwd === B_CWD
    && bChip.dataset.fileConversation === 'B');
  ok('渲染 B 时没有把 A 的链接带过来', !output().textContent.includes('实时改动'));

  view.show('D');
  [...host.querySelectorAll('button')].find(b => b.textContent === '打开历史').click();
  await tick(12);
  const dChip = chips()[0];
  ok('历史消息渲染出文件链接', Boolean(dChip) && dChip.dataset.filePath === 'src/app.js');
  ok('历史链接使用历史会话自己的 cwd（不是当前全局项目）',
    dChip?.dataset.fileCwd === D_CWD && dChip.dataset.fileConversation === 'D' && dChip.dataset.fileLine === '12');

  view.show('E');
  frame('E', 1, '没有 cwd 的旧记录 `src/app.js`');
  await tick();
  ok('记录缺少 cwd 时不把普通文本变成文件链接', chips().length === 0 && output().textContent.includes('src/app.js'));

  view.dispose();
  console.log(`file-links-runtime: ${checks} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
