/* 验证便携版 zip：解压 → 直接跑 → 页面能开 → 用完删掉。
 *
 * 为什么要单独测一遍：安装程序和 zip 是**两个不同的交付物**，
 * 但只有安装程序被真装过。zip 是 tar 打出来的，里面少一个目录、
 * 或者路径前缀多一层，都只会在别人解压后暴露 —— 那时已经发出去了。
 *
 * 「便携」在这里指**不用安装**（不写注册表、不建快捷方式），
 * 不是说零残留：Electron 的 userData 仍会落在 %APPDATA%。
 * 所以这里用 PI_GUI_DATA 指到临时目录，避免污染真实用户数据。
 *
 * ---------- 就绪探测为什么走 /api/health ----------
 *
 * 桌面版会由主进程生成一个随机令牌、经环境变量注入后端，于是**除 /api/health
 * 之外**的所有 /api/* 都要带令牌（见 server.js 的 denyRequest）。而令牌只存在于
 * 主进程内存里，由 webRequest 注入到页面发出的请求上 —— 测试进程**拿不到**，
 * 用 /api/status 探测只会稳定拿到 401，永远等不到「就绪」。
 *
 * /api/health 免认证正是为这个场景留的：它的职责就是回答「这个端口上是不是
 * Pi GUI」。反过来，「无令牌的 /api/status 必须被拒」本身也是一条值得在
 * **交付物**上验一遍的安全边界，所以下面把它写成了断言。
 *
 * 副作用：/api/status 里的 cwd 无法从这里读到（令牌不下发）。cwd 的贯通由
 * tests/app-check.cjs 与 tests/e2e-app.cjs 覆盖 —— 它们直接跑后端，
 * 不受桌面版令牌的影响。
 *
 * 用法：npm run build:dist && npm run test:portable
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const ZIP = path.join(ROOT, 'dist-installer', `Pi-GUI-${VERSION}-portable.zip`);
const APP = 'Pi GUI';
const EXE = `${APP}.exe`;

// 解压到临时目录：顺带证明「脱离开发机、没有 node_modules」也能跑
const DEST = path.join(os.tmpdir(), 'pi-gui-portable-check');
const DATA = path.join(DEST, '_data');
const WORK = path.join(DEST, '_work');
const PORT = 7799;

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push([r === true || r === undefined ? 'PASS' : 'FAIL', name, r === true || r === undefined ? '' : String(r)]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等到某个 async 判定成立。起窗口 + 拉后端要几秒，不能只试一次。 */
async function until(fn, ms, label) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(400);
  }
  return null;
}

(async () => {
  if (!fs.existsSync(ZIP)) throw new Error(`没有 ${ZIP}，先跑 npm run build:dist`);

  console.log('\n[1] 解压');
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(DEST, { recursive: true });
  /* 用系统自带的 tar 解。三个限制叠加，得一起绕：
   *   1) 不能带盘符："C:" 会被当成 rsh 远程主机（Cannot connect to C: resolve failed）；
   *   2) 反斜杠会被当**转义字符**（认八进制，`\21022` 会被吃掉）→ 必须用正斜杠；
   *   3) zip 在项目里、目的地却在系统临时目录，相对项目根要写 "..\Users\..."。
   *   → 以**盘符根**为基准算相对路径 + 全部转正斜杠 + cwd 设成盘符根。 */
  const drive = path.parse(ROOT).root;
  if (path.parse(DEST).root !== drive) {
    throw new Error(`zip 与临时目录不在同一个盘（${drive} / ${path.parse(DEST).root}），跨盘只能给带盘符路径，tar 不接受`);
  }
  const slashed = (p) => path.relative(drive, p).split(path.sep).join('/');
  execFileSync('tar', ['-xf', slashed(ZIP), '-C', slashed(DEST)], {
    cwd: drive,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const APP_DIR = path.join(DEST, `${APP}-win32-x64`);
  check('解压出的目录名正确（不是多套一层前缀）', () =>
    fs.existsSync(APP_DIR) || `没找到 ${APP_DIR}，实际是 ${fs.readdirSync(DEST).join(', ')}`
  );
  check('主程序在解压目录第一层', () =>
    fs.existsSync(path.join(APP_DIR, EXE)) || 'exe 不在解压出来的目录里'
  );
  check('随包资源齐全', () =>
    ['resources/app/main.cjs', 'resources/app/net-probe.cjs', 'resources/app/server.cjs', 'resources/app/public/index.html'].every((f) =>
      fs.existsSync(path.join(APP_DIR, f))
    ) || 'resources/app 下缺东西'
  );
  check('没有把 node_modules 打进去', () =>
    !fs.existsSync(path.join(APP_DIR, 'node_modules')) || '包里有 node_modules，体积会白白变大'
  );

  console.log('[2] 直接跑解压出来的 exe');
  for (const d of [DATA, WORK]) fs.mkdirSync(d, { recursive: true });

  const env = {
    ...process.env,
    PI_GUI_DATA: DATA,
    PI_CWD: WORK,
    PI_GUI_OPEN: '0',
    PORT: String(PORT),
  };
  /* agent shell 会注入这两个变量，打包后的 Electron 应用都受不了：
   *   ELECTRON_RUN_AS_NODE=1 → exe 退化成普通 node，app 变 undefined
   *   NODE_OPTIONS=--require=… → Electron 明确报「打包应用不支持 NODE_OPTIONS」
   * 都是**环境**的干扰，不是产品缺陷，所以起测试实例前一律摘掉。 */
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  const p = spawn(path.join(APP_DIR, EXE), ['--no-sandbox'], {
    cwd: APP_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  p.stdout.on('data', (d) => (log += d));
  p.stderr.on('data', (d) => (log += d));

  let health = null;
  try {
    health = await until(
      async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
          return r.ok ? await r.json() : null;
        } catch {
          return null;
        }
      },
      60000
    );

    check('解压后能直接跑起来（不需要安装）', () => Boolean(health) || `后端没就绪。日志：\n${log.slice(-600)}`);
    /* 不能只断言「有东西在 7788 上监听」—— 端口被别的程序占了也会「就绪」。
     * /api/health 回的是应用身份，对不上就说明窗口会被指向一个陌生服务。 */
    check('探到的是本应用的后端（身份对得上）', () =>
      (health && health.app === 'pi-gui' && health.protocol === 1) || `health=${JSON.stringify(health)}`
    );
    if (health) {
      /* 打包后的桌面版必须**开着**令牌闸门。这条断言的要点是「交付物上验一遍」：
       * 源码里有 denyRequest 不等于装出来的这个 exe 真的启用了它。 */
      const denied = await fetch(`http://127.0.0.1:${PORT}/api/status`);
      check('桌面版启用了令牌校验（无令牌访问 API 被拒）', () => denied.status === 401 || `状态 ${denied.status}`);

      const page = await fetch(`http://127.0.0.1:${PORT}/`);
      const html = await page.text();
      /* 别只断言 200 —— 兜底逻辑接错时也会回 200 加一段 HTML。
       * 这里认骨架（根容器 + 侧栏）和标题，能挡住「返回了别的页面」。 */
      check('页面能打开且是应用骨架', () => {
        if (!page.ok) return `状态 ${page.status}`;
        if (!/text\/html/.test(page.headers.get('content-type') || '')) return 'Content-Type 不是 HTML';
        for (const need of ['<div class="app">', 'class="rail"', '<title>Pi GUI</title>']) {
          if (!html.includes(need)) return `页面里没有 ${need}`;
        }
        return true;
      });

      const css = await fetch(`http://127.0.0.1:${PORT}/styles.css`);
      check('静态资源正常', () => css.ok || `styles.css 状态 ${css.status}`);
    }
    check('运行期没有崩栈输出', () => !/Uncaught|TypeError:|Error: Cannot find/.test(log) || log.slice(-400));
  } finally {
    try {
      execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* 已退出 */
    }
    await sleep(2000);
  }

  console.log('[3] 清理');
  fs.rmSync(DEST, { recursive: true, force: true });
  check('临时目录已清理', () => !fs.existsSync(DEST) || '还在');

  let pass = 0;
  for (const [st, name, msg] of results) {
    if (st === 'PASS') pass++;
    console.log(`  ${st === 'PASS' ? 'ok  ' : 'FAIL'} ${name}${msg ? '  → ' + msg : ''}`);
  }
  console.log(`\n${pass}/${results.length} 通过`);
  setTimeout(() => process.exit(pass === results.length ? 0 : 1), 600);
})().catch((e) => {
  console.log('失败: ' + e.message);
  process.exit(1);
});
