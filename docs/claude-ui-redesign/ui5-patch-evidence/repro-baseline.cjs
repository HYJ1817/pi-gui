/* UI-5 补丁：在**修复前基线**上复现两个验收问题。
 *
 * 用法：node docs/claude-ui-redesign/ui5-patch-evidence/repro-baseline.cjs [baseline-ref]
 * 默认 baseline-ref = 8f0178e34153a8043d5c3a661ab7e35e96e499d5。
 *
 * 只从 git 对象里读取旧文件到 os.tmpdir()，不修改工作区；结束后删除临时目录。
 * 输出是“修复前会怎样”的证据，不是断言测试。
 */
'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const REF = process.argv[2] || '8f0178e34153a8043d5c3a661ab7e35e96e499d5';
const SECRET = 'sk-abcdefgh12345678';

function show(file) {
  return cp.execFileSync('git', ['-C', REPO, 'show', `${REF}:${file}`], { encoding: 'utf8' });
}

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-ui5-baseline-'));
}

function p1a() {
  console.log('\n[P1-A] 修复前：SECRET_RE 的 lastIndex 污染');
  const dir = temp();
  try {
    for (const file of ['lib/log-contract.cjs', 'lib/log-core.cjs', 'lib/zip.cjs']) {
      fs.writeFileSync(path.join(dir, path.basename(file)), show(file));
    }
    const contract = require(path.join(dir, 'log-contract.cjs'));
    console.log('连续调用 token/code/id（同一 secret）：');
    for (let i = 1; i <= 4; i++) {
      console.log(`  ${i}: token=${JSON.stringify(contract.token(SECRET))} code=${JSON.stringify(contract.code(SECRET))} id=${JSON.stringify(contract.id(SECRET))}`);
    }
    const logs = path.join(dir, 'logs');
    const core = require(path.join(dir, 'log-core.cjs')).createLogCore({
      dir: logs, role: 'app', version: '0.25.0', appRoot: REPO,
    });
    core.event('app', 'electron.renderer_responsive', {}, { code: SECRET });
    core.event('app', 'electron.renderer_responsive', {}, { code: SECRET });
    core.flushSync();
    const name = fs.readdirSync(logs).find((entry) => entry.endsWith('.jsonl'));
    const text = fs.readFileSync(path.join(logs, name), 'utf8');
    console.log(`原始 JSONL 含 secret：${text.includes(SECRET)}`);
    for (const line of text.split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.event === 'electron.renderer_responsive') console.log(`  ${line}`);
    }
    core.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function p1b() {
  console.log('\n[P1-B] 修复前：一次网络失败后 Renderer 客户端永久停止');
  const { JSDOM } = require(path.join(REPO, 'node_modules/jsdom'));
  const { bundle } = require(path.join(REPO, 'tests/esm-bundle.cjs'));
  const dir = temp();
  let dom;
  try {
    for (const file of ['public/log-client.js', 'public/api.js', 'public/state.js', 'public/ui/toast.js']) {
      const target = path.join(dir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, show(file));
    }
    dom = new JSDOM(fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8'), {
      url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
    });
    const w = dom.window;
    let clock = 0, seq = 0, mode = 'network';
    const timers = new Map();
    let requests = 0;
    w.setTimeout = (fn, ms = 0, ...args) => {
      const id = ++seq;
      timers.set(id, { at: clock + Math.max(0, Number(ms) || 0), fn, args });
      return id;
    };
    w.clearTimeout = (id) => { timers.delete(id); };
    Object.defineProperty(w.Date, 'now', { value: () => clock, configurable: true });
    w.fetch = async (url, opts = {}) => {
      requests += 1;
      if (mode === 'network') throw new w.Error('offline');
      const body = JSON.parse(opts.body || '{}');
      return { ok: true, status: 200, json: async () => ({ ok: true, accepted: (body.events || []).length }) };
    };
    const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };
    const advance = async (ms) => {
      const target = clock + ms;
      for (;;) {
        let id = null, timer = null;
        for (const [key, value] of timers) if (value.at <= target && (!timer || value.at < timer.at)) { id = key; timer = value; }
        if (!timer) break;
        timers.delete(id);
        clock = timer.at;
        timer.fn(...timer.args);
        await settle();
      }
      clock = target;
      await settle();
    };
    w.eval(bundle(path.join(dir, 'public/log-client.js')).code);

    w.logRendererEvent('ui.action_failed', { action: 'first', reason: 'network' });
    await advance(1300);
    console.log('第一次网络失败后：', JSON.stringify(w.rendererLogSnapshot()));

    mode = 'success';
    const accepted = w.logRendererEvent('ui.action_failed', { action: 'second', reason: 'ok' });
    await advance(60000);
    console.log('后端恢复后再次记录：');
    console.log(`  logRendererEvent 返回值=${accepted}`);
    console.log(`  60 秒内请求数=${requests}`);
    console.log('  最终快照：', JSON.stringify(w.rendererLogSnapshot()));
  } finally {
    if (dom) dom.window.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  console.log(`baseline ref: ${REF}`);
  p1a();
  await p1b();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
