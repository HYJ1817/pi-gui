/* 开发模式（node server.js）的静态资源回归测试。
 *
 * 为什么单独测这个：资源访问层（lib/assets.js）有两种模式 ——
 * SEA 下资源内嵌、开发时读磁盘。SEA 那条路有 exe-check.cjs 盯着，
 * 开发这条路却一直没人管，结果 ROOT 算错成 lib/ 之后，
 * 所有静态资源静默变成 404：jsdom 测试是直接读文件的、看不出来，
 * 视觉夹具自己托管 public/、也看不出来，只有真跑一次服务才会暴露。
 *
 * 所以这里就干一件事：起真的服务，把关键静态资源挨个取一遍。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 7791);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  const ok = typeof cond === 'function' ? cond() : cond;
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok ? '  → ' + ok : extra ? '  → ' + extra : ''));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/');
      if (r.status) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  return false;
}

(async () => {
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PI_GUI_OPEN: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));

  const cleanup = () => {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        server.kill();
      }
    } catch {
      /* noop */
    }
  };

  try {
    check('服务能起来', await waitReady(), out.slice(0, 300));

    const get = async (p) => {
      const r = await fetch(BASE + p);
      const body = await r.text();
      return { status: r.status, body, type: r.headers.get('content-type') || '' };
    };

    const index = await get('/');
    check('根路径 200', () => index.status === 200 || '状态 ' + index.status);
    check('根路径是 HTML', () => index.type.includes('text/html') || index.type);
    check('根路径内容正确', () => index.body.includes('<title>Pi GUI</title>') || '没有标题');
    check('根路径不是 404 兜底', () => index.body !== 'Not found' || '返回了 Not found');

    // 这两个正是 ROOT 算错时最先挂掉的东西
    const css = await get('/styles.css');
    check('styles.css 200', () => css.status === 200 || '状态 ' + css.status);
    check('styles.css 有内容', () => css.body.length > 5000 || '只有 ' + css.body.length + ' 字节');
    // 护栏：[hidden]{display:none !important} 一旦被删掉，
    // .modal / .btn-stop / .attach-tray 这些自带 display 的组件就会「藏不住」，
    // 而 jsdom 测不出来（它不套用外部样式表）。所以在这里盯着。
    check(
      'styles.css 保留了 [hidden] 兜底规则',
      () => /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(css.body) || '缺少 [hidden]{display:none !important}'
    );
    /* 二次确认层必须压在其他弹层之上。
     * 它经常盖在「文件变更」面板上（在面板里点撤销），层级搞反的话确认框会被
     * 面板挡住 —— 而 jsdom 不算层叠，这条只能在真样式表上验。 */
    check('styles.css 里确认层的 z-index 高于普通弹层', () => {
      const z = (sel) => {
        const m = css.body.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{[^}]*z-index\\s*:\\s*(\\d+)'));
        return m ? Number(m[1]) : NaN;
      };
      const base = z('.modal');
      const confirm = z('.modal.confirm');
      return (Number.isFinite(base) && Number.isFinite(confirm) && confirm > base) || `.modal=${base} .modal.confirm=${confirm}`;
    });

    /* 前端是原生 ES Module：app.js 只是入口，真正的代码在同目录的一堆模块里
     * （含 public/ui/ 子目录）。所以这里不能只看 app.js 的大小 ——
     * 要顺着 import 把整张图走一遍，逐个确认能被静态托管出去。
     * 嵌套路径（/ui/modal.js）和 SEA 内嵌资源都是新的失败面，值得盯。 */
    const js = await get('/app.js');
    check('app.js 200', () => js.status === 200 || '状态 ' + js.status);
    check('app.js 不是 HTML 兜底', () => !js.body.includes('<title>') || '返回了 HTML');
    check('app.js 是模块入口（含 import）', () => /^\s*import\s/m.test(js.body) || '没看到 import 语句');

    const seen = new Set();
    const queue = ['/app.js'];
    const specRe = /^\s*import\s*\{[\s\S]*?\}\s*from\s*['"](\.[^'"]+)['"]/gm;
    let total = 0;
    const bad = [];

    while (queue.length) {
      const p = queue.shift();
      if (seen.has(p)) continue;
      seen.add(p);

      const r = await get(p);
      if (r.status !== 200) {
        bad.push(`${p} → ${r.status}`);
        continue;
      }
      if (r.body.includes('<title>')) {
        bad.push(`${p} → 返回了 HTML`);
        continue;
      }
      total += r.body.length;

      // 相对说明符 → 绝对路径（只用到 './x.js' 与 '../y.js' 两种，够用）
      const dir = p.replace(/\/[^/]*$/, '');
      for (const m of r.body.matchAll(specRe)) {
        const parts = (dir + '/' + m[1]).split('/');
        const stack = [];
        for (const seg of parts) {
          if (!seg || seg === '.') continue;
          if (seg === '..') stack.pop();
          else stack.push(seg);
        }
        queue.push('/' + stack.join('/'));
      }
    }

    check('前端模块图能全部取到', () => (bad.length ? bad.join(', ') : true));
    check(`模块图共 ${seen.size} 个文件`, () => seen.size >= 10 || '只取到 ' + seen.size + ' 个');
    check('模块图总量够大（不是空壳）', () => total > 50000 || '合计只有 ' + total + ' 字节');

    const missing = await get('/nope-does-not-exist.js');
    check('不存在的文件返回 404', () => missing.status === 404 || '状态 ' + missing.status);
  } finally {
    cleanup();
  }

  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  // 用 exitCode 让 Node 自己收尾，别 process.exit —— 那会在 undici 句柄
  // 还在关闭时硬切，Windows 上会吐一句 libuv 断言，看着像崩了。
  process.exitCode = fail ? 1 : 0;
  // 兜底：万一子进程的管道还挂着，800ms 后强制收场，别让测试卡住
  setTimeout(() => process.exit(process.exitCode), 800);
})().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
