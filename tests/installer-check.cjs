/* 验证安装程序：静默装一遍 → 检查落地结果 → 装好的程序能跑 → 静默卸一遍 → 检查清理。
 *
 * 为什么值得测：安装程序是「构建成功但一跑就废」的重灾区 ——
 * 路径写错、快捷方式指到不存在的文件、卸载没清注册表、卸载删了不该删的目录，
 * 全都只有真装一遍才会暴露。而且它面向的是**别人**的机器，
 * 出问题的代价是收件人连程序都打不开。
 *
 * 这里刻意**不**用 /D= 指定安装位置，而是走安装程序的默认路径 ——
 * 因为「默认装在哪里」正是要验的东西：必须是单用户的（不弹 UAC、不写系统目录）。
 * 硬指定一个目录会把这条最重要的断言验成废话。
 *
 * 用法：npm run build:installer && node tests/installer-check.cjs
 * 需要真实桌面会话（会写注册表、建快捷方式，测完卸掉）。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const SETUP = path.join(ROOT, 'dist-installer', `Pi-GUI-Setup-${VERSION}.exe`);
const APP = 'Pi GUI';
const EXE = `${APP}.exe`;

// 安装程序里写死的默认位置（NSI 的 InstallDir）。这里独立算一遍用作期望值。
const INSTALL = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', APP);
const USER_DATA = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'pi-gui');
const WORK = path.join(os.tmpdir(), 'pi-gui-install-check', 'work');
const DATA = path.join(os.tmpdir(), 'pi-gui-install-check', 'data');
const APP_PORT = 7796;
const CDP_PORT = 9236;

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push([r === true || r === undefined ? 'PASS' : 'FAIL', name, r === true || r === undefined ? '' : String(r)]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
}
function skip(name, why) {
  results.push(['SKIP', name, why]);
}

/** 有些环境（比如受限的构建沙箱）会把 reg.exe 拉黑。读不到注册表不等于
 *  「安装程序没登记卸载项」——那会把工具限制误报成产品缺陷，所以先探一次，
 *  不可用就把相关断言标成 SKIP，让人一眼看出是没验而不是验过了。 */
function usable(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const HAVE_REG = usable('reg', ['query', 'HKCU\\Environment']);
const HAVE_TASKKILL = usable('taskkill', ['/?']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等到路径不存在为止。卸载是异步收尾的（见下面的说明），断言前得先等。 */
async function waitGone(p, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!fs.existsSync(p)) return true;
    await sleep(300);
  }
  return false;
}
const rmrf = (p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* 被占用就算了 */
  }
};

/** 读注册表字符串（HKCU）。 */
function regGet(key, value) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', value], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const m = new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`).exec(out);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function regKeyExists(key) {
  try {
    execFileSync('reg', ['query', key], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** 桌面目录。有 OneDrive 重定向时不在 %USERPROFILE%\Desktop 下，
 *  所以优先从注册表读；读不到（注册表不可用 / 键不存在）再试几个常见位置，
 *  都找不到就返回 null，调用方跳过而不是误报失败。 */
function desktopDir() {
  if (HAVE_REG) {
    const raw = regGet(
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
      'Desktop'
    );
    if (raw) {
      const expanded = raw.replace(/%([^%]+)%/g, (_, v) => process.env[v] || `%${v}%`);
      if (fs.existsSync(expanded)) return expanded;
    }
  }
  for (const p of [
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'OneDrive', 'Desktop'),
    path.join(os.homedir(), 'OneDrive - 个人', 'Desktop'),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP}`;
const START_MENU = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  APP
);

function run(file, args, ms = 240000) {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => p.kill(), ms);
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

/** 装好的程序能不能真的跑起来 —— 起窗口 + 内嵌后端都要到位。
 *  光检查「文件在不在」不够：漏拷文件的话 exe 照样在那，一双击才报错。 */
async function launchInstalled() {
  const env = { ...process.env, PI_CWD: WORK, PI_GUI_DATA: DATA, PI_GUI_OPEN: '0', PORT: String(APP_PORT) };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const d of [WORK, DATA]) fs.mkdirSync(d, { recursive: true });

  const p = spawn(path.join(INSTALL, EXE), [`--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--in-process-gpu'], {
    cwd: INSTALL,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  p.stdout.on('data', (d) => (log += d));
  p.stderr.on('data', (d) => (log += d));

  try {
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      try {
        if ((await fetch(`http://127.0.0.1:${APP_PORT}/api/status`)).ok) return { ok: true, log };
      } catch {
        /* 还没起来 */
      }
    }
    return { ok: false, log };
  } finally {
    /* 必须真的杀干净。留一个活着的实例占着文件，后面的卸载就删不掉程序目录，
     * 于是「程序目录已删除」会挂 —— 看起来像安装程序有 bug，其实是测试自己没收尾。
     * taskkill 不可用时改用 kill，并多等一会儿。 */
    if (HAVE_TASKKILL) {
      try {
        execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch {
        /* 已经退了 */
      }
    } else {
      try {
        p.kill();
      } catch {
        /* noop */
      }
    }
    await sleep(2500);
  }
}

(async () => {
  if (!fs.existsSync(SETUP)) throw new Error(`没有 ${SETUP}，先跑 npm run build:installer`);

  /* 卸载只该删程序文件。**用户数据（%APPDATA%\pi-gui 里的项目列表、窗口布局）
     必须留下** —— 那不是程序的一部分，重装还要用，删掉等于把用户的项目列表弄丢。
     这里先放一个哨兵文件进去，卸载后它还在，才说明卸载没越界。 */
  fs.mkdirSync(USER_DATA, { recursive: true });
  const sentinel = path.join(USER_DATA, 'installer-check-sentinel.txt');
  fs.writeFileSync(sentinel, '卸载后这个文件应该还在\n', 'utf8');

  /* 先清掉上一轮可能留下的桌面快捷方式和开始菜单项。
   *
   * 这一条是踩出来的：如果同名快捷方式已经在那儿，本轮卸载删掉的当然是
   * 「本轮新建的那个」，但断言只看「文件还在不在」—— 残留会让断言变成
   * 「这一轮到底删没删」的不可复现失败。实测遇到过一次，查了半天才确认
   * 卸载脚本本身没问题（手工装+卸一次，桌面快捷方式确实被删掉了）。
   * 顺便也把 desk 提前解析出来，安装后再算一次会拿到不同的目录。 */
  const desk = desktopDir();
  if (desk) rmrf(path.join(desk, `${APP}.lnk`));
  rmrf(START_MENU);

  console.log('\n[1] 静默安装（走默认位置）');
  const r1 = await run(SETUP, ['/S']);
  check('安装程序退出码为 0', () => r1.code === 0 || `退出码 ${r1.code}\n${r1.out.slice(-400)}`);
  console.log(`  装到 ${INSTALL}`);

  /* 单用户安装。这一条要是挂了，收件人就会遇到 UAC 弹窗或者「拒绝访问」——
     对「发给别人下载」来说是最要命的一类失败。 */
  check('默认装在用户目录（单用户，不碰 Program Files）', () => {
    if (!fs.existsSync(INSTALL)) return `没装到 ${INSTALL}`;
    return /Program Files/i.test(INSTALL) ? `装进了系统目录：${INSTALL}` : true;
  });
  check('主程序已落地', () => fs.existsSync(path.join(INSTALL, EXE)) || '没找到 ' + EXE);
  check('随包资源齐全（resources/app）', () =>
    ['main.cjs', 'net-probe.cjs', 'server.cjs', 'public/index.html', 'pdfjs/cmaps'].every((f) =>
      fs.existsSync(path.join(INSTALL, 'resources', 'app', f))
    ) || 'resources/app 下缺东西'
  );
  check('卸载程序已生成', () => fs.existsSync(path.join(INSTALL, `Uninstall ${APP}.exe`)) || '缺卸载程序');
  check('开始菜单有快捷方式', () => fs.existsSync(path.join(START_MENU, `${APP}.lnk`)) || '没找到');
  check('开始菜单有卸载入口', () => fs.existsSync(path.join(START_MENU, `卸载 ${APP}.lnk`)) || '没找到');
  if (desk) {
    check('桌面有快捷方式', () => fs.existsSync(path.join(desk, `${APP}.lnk`)) || '没找到');
  } else {
    console.log('  （桌面目录解析不到，跳过桌面快捷方式断言）');
  }

  if (!HAVE_REG) {
    const why = 'reg.exe 不可用，注册表断言没验';
    for (const n of ['已登记到「添加或删除程序」', '卸载项指向正确的卸载程序', '卸载项带了版本号', '卸载项记录了安装位置']) skip(n, why);
    console.log('  （reg.exe 不可用，跳过 4 条注册表断言）');
  } else {
    check('已登记到「添加或删除程序」', () => regKeyExists(UNINSTALL_KEY) || '注册表里没有卸载项');
    check('卸载项指向正确的卸载程序', () => {
      const v = regGet(UNINSTALL_KEY, 'UninstallString');
      return v && v.includes(`Uninstall ${APP}.exe`) ? true : `UninstallString=${v}`;
    });
    check('卸载项带了版本号', () => regGet(UNINSTALL_KEY, 'DisplayVersion') === VERSION || `DisplayVersion=${regGet(UNINSTALL_KEY, 'DisplayVersion')}`);
    check('卸载项记录了安装位置', () => {
      const v = regGet(UNINSTALL_KEY, 'InstallLocation');
      return v && path.resolve(v) === path.resolve(INSTALL) ? true : `InstallLocation=${v}`;
    });
  }

  console.log('[2] 启动装好的程序');
  const launched = await launchInstalled();
  check('装好的程序能起来（窗口 + 内嵌后端）', () =>
    launched.ok === true || `没能就绪。日志：\n${launched.log.slice(-600)}`
  );

  /* 应用正开着的时候再静默装一遍 —— 这是 MessageBox 那条路径。
   * NSIS 的 /S 只跳过向导页，**不抑制 MessageBox**；只有带 /SD 才会在静默模式
   * 下自动取默认值。少了 /SD，这里会一直等人点「确定」，永久挂住。
   * 超时给 90 秒：正常几秒就完，挂了就是挂了，不用等满 240。 */
  console.log('[2b] 应用运行时再次静默安装（验证不会卡在对话框上）');
  const r1b = await run(SETUP, ['/S'], 90000);
  check('应用正在运行时静默安装也能自己走完（不卡对话框）', () =>
    r1b.code === 0 || `退出码 ${r1b.code} —— 很可能卡在 MessageBox 上了，检查 /SD`
  );

  console.log('[3] 静默卸载');
  const r2 = await run(path.join(INSTALL, `Uninstall ${APP}.exe`), ['/S']);
  check('卸载程序退出码为 0', () => r2.code === 0 || `退出码 ${r2.code}`);

  /* 退出码 0 不等于删完了。NSIS 卸载程序为了能删掉自己，会把自身复制到
   * %TEMP% 再拉起一个副本、父进程立刻退出 —— 所以这里必须等目录真的消失，
   * 而不是一退出就断言，否则会稳定复现「卸载明明成功却报目录还在」。 */
  await waitGone(INSTALL, 40000);
  await waitGone(START_MENU, 40000);
  /* 桌面快捷方式也是一样：得等它真的消失再断言。
   * 卸载脚本里它是最后一步，只等程序目录的话会稳定撞上「还没轮到」。 */
  if (desk) await waitGone(path.join(desk, `${APP}.lnk`), 40000);

  check('程序目录已删除', () => !fs.existsSync(INSTALL) || '程序目录还在');
  check('开始菜单项已删除', () => !fs.existsSync(START_MENU) || '开始菜单目录还在');
  if (HAVE_REG) {
    check('卸载项已从注册表移除', () => !regKeyExists(UNINSTALL_KEY) || '注册表里还有卸载项');
  } else {
    skip('卸载项已从注册表移除', 'reg.exe 不可用，没验');
  }
  check('卸载没有顺手删掉用户数据', () => fs.existsSync(sentinel) || '哨兵文件被删了 —— 用户的项目列表会被一起删掉');
  if (desk) {
    check('桌面快捷方式已删除', () => !fs.existsSync(path.join(desk, `${APP}.lnk`)) || '还在');
  }

  rmrf(sentinel);
  rmrf(path.dirname(WORK));

  let pass = 0;
  let skipped = 0;
  for (const [st, name, msg] of results) {
    if (st === 'PASS') pass++;
    if (st === 'SKIP') skipped++;
    const tag = st === 'PASS' ? 'ok  ' : st === 'SKIP' ? 'skip' : 'FAIL';
    console.log(`  ${tag} ${name}${msg ? '  → ' + msg : ''}`);
  }
  const verified = results.length - skipped;
  console.log(`\n${pass}/${verified} 通过${skipped ? `（${skipped} 条跳过）` : ''}`);
  if (skipped) console.log('注意：跳过的条目没有被验证，换台机器重跑才能覆盖。');
  setTimeout(() => process.exit(pass === verified ? 0 : 1), 600);
})().catch((e) => {
  console.log('失败: ' + e.message);
  process.exit(1);
});
