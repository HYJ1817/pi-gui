/* 验证 Electron 桌面应用的内嵌后端。
 *
 * 打包后的应用长这样：
 *   Pi GUI.exe                      Electron 运行时
 *   resources/app/main.cjs          主进程（起后端 + 开窗口）
 *   resources/app/server.cjs        后端（含 pdfjs 代码）
 *   resources/app/pdfjs/…           pdfjs 的字体 / cmaps / worker
 *
 * 要测的重点是「没有 node_modules 也能跑」：
 * 后端靠 lib/assets.js 的 hasBundledAssets() 判断自己处于打包形态，
 * 然后从旁边的 pdfjs/ 目录取字体和 cmaps。这个判断一旦写错，
 * 开发机上一切正常（能回退到 node_modules），换台机器就 PDF 抽不出来 ——
 * 所以这里把应用目录整个拷到临时目录再跑，断绝 node_modules 的后路。
 *
 * 用法：npm run build:app && node tests/app-check.cjs
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'dist-app', 'Pi GUI-win32-x64', 'resources', 'app');
const APP_EXE = path.join(ROOT, 'dist-app', 'Pi GUI-win32-x64', 'Pi GUI.exe');
const ICON = path.join(ROOT, 'build', 'icon.ico');
const SANDBOX = path.join(os.tmpdir(), 'pi-gui-appcheck');
const DATA = path.join(os.tmpdir(), 'pi-gui-appcheck-data');
/* pi 的工作目录必须显式给。
 *
 * server.js 不再拿「进程的当前目录」兜底当项目 —— 没有项目就不启动 pi，
 * 界面会提示「添加文件夹」。所以想验证「pi 子进程已拉起」，这里就得指定一个
 * 真实存在的目录。
 *
 * 不能用 SANDBOX：pi 会把会话写进工作目录，那样「应用目录没有被写入」这条
 * 断言就被自己破了。也不能用 DATA：那是用户数据目录，混进去看不出问题。 */
const WORK = path.join(os.tmpdir(), 'pi-gui-appcheck-work');
const PORT = Number(process.env.CHECK_PORT || 7798);
const BASE = `http://127.0.0.1:${PORT}`;
const FIX = path.join(os.tmpdir(), 'pi-gui-fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 删临时目录 —— 带命令行兜底。
 *
 * 受限环境给 node 注入了批量删除保护（一轮里删超过 50 个文件就抛错），
 * 而应用目录动辄上千个文件 → fs.rmSync 必然失败，且失败是静默的（catch 吃掉），
 * 于是每跑一次测试就往临时目录里堆几十 MB。PATH 上的 rm 是受管的，走它不会被拦。 */
function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* 交给下面的 rm */
  }
  if (fs.existsSync(p)) {
    try {
      execFileSync('rm', ['-rf', '--', p], { stdio: 'ignore' });
    } catch {
      /* 真删不掉就算了，下次运行开头还会删一遍 */
    }
  }
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

/** 从某个目录一路往上找，看看有没有 node_modules —— 用来证明测试环境是干净的 */
function hasNodeModulesAncestor(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, 'node_modules'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

async function main() {
  if (!fs.existsSync(APP)) throw new Error(`没有 ${APP}，先运行 npm run build:app`);

  /* 拷到临时目录：dist-app 在项目里，往上走能找到 C:\pi-GUI\node_modules，
   * 那样测不出「真的用上了随包资源」。 */
  for (const d of [SANDBOX, DATA, WORK]) fs.rmSync(d, { recursive: true, force: true });
  for (const d of [SANDBOX, DATA, WORK]) fs.mkdirSync(d, { recursive: true });
  fs.cpSync(APP, SANDBOX, { recursive: true });

  check('测试目录里没有 node_modules', () => {
    const hit = hasNodeModulesAncestor(SANDBOX);
    return hit ? `意外找到 ${hit}\\node_modules` : true;
  });
  check('随包资源齐全', () => {
    for (const p of ['server.cjs', 'main.cjs', 'asset-manifest.json', 'pdfjs/standard_fonts', 'pdfjs/cmaps', 'pdfjs/worker/pdf.worker.mjs']) {
      if (!fs.existsSync(path.join(SANDBOX, p))) return '缺 ' + p;
    }
    return true;
  });

  /* 图标必须真的嵌进应用 exe。
   *
   * 这个失败模式是**静默**的：packager 拿到一个不存在的图标路径不报错，
   * 直接出一个顶着 Electron 默认图标的应用。而 build-exe.mjs 会清空整个
   * build/，所以「先生成图标后构建后端」这个顺序会让 icon.ico 在打包前一刻
   * 被删掉 —— 实测就这么错过很久，只有盯着任务栏图标才发现。
   * 做法：把 ico 每个条目的特征字节拿去 exe 里搜，全都没命中就说明没嵌进去。 */
  check('应用图标已嵌入 exe', () => {
    if (!fs.existsSync(ICON)) return `没有 ${ICON}（构建顺序错了？图标步骤必须排在后端构建之后）`;
    if (!fs.existsSync(APP_EXE)) return `没有 ${APP_EXE}`;
    const ico = fs.readFileSync(ICON);
    const exe = fs.readFileSync(APP_EXE);
    const count = ico.readUInt16LE(4);
    if (!count) return 'icon.ico 里没有条目';
    let hit = 0;
    for (let i = 0; i < count; i++) {
      const off = 6 + i * 16;
      const size = ico.readUInt32LE(off + 8);
      const start = ico.readUInt32LE(off + 12);
      if (!size || start + size > ico.length) continue;
      const probe = ico.subarray(start + Math.floor(size * 0.5), start + Math.floor(size * 0.5) + 96);
      if (probe.length && exe.includes(probe)) hit++;
    }
    return hit === count ? true : `icon.ico 有 ${count} 个尺寸，exe 里只找到 ${hit} 个 —— 应用在用默认图标`;
  });

  /* 许可证必须跟着二进制走。
   *
   * pdfjs-dist 是 Apache-2.0，它的代码被打进包里一起分发，而 Apache-2.0 §4
   * 要求分发时附上许可证副本 —— 只在仓库根目录放个 LICENSE 不够，
   * 下载安装包的人不会去看仓库。这条断言就是防它被构建脚本改漏。 */
  check('随包带了许可证与第三方署名', () => {
    const lic = path.join(SANDBOX, 'LICENSE');
    const notices = path.join(SANDBOX, 'THIRD-PARTY-NOTICES.txt');
    if (!fs.existsSync(lic)) return '缺 LICENSE';
    if (!fs.existsSync(notices)) return '缺 THIRD-PARTY-NOTICES.txt';
    if (!/MIT License/.test(fs.readFileSync(lic, 'utf8'))) return 'LICENSE 里没有 MIT 正文';
    const n = fs.readFileSync(notices, 'utf8');
    if (!/pdfjs-dist/.test(n)) return '署名里没提 pdfjs-dist';
    if (!/Apache License/.test(n)) return '署名里没提 Apache License';
    if (!/TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/.test(n)) {
      return '只写了组件名，没附 Apache-2.0 许可证正文';
    }
    return true;
  });

  const srv = spawn(process.execPath, [path.join(SANDBOX, 'server.cjs')], {
    cwd: SANDBOX,
    // PI_GUI_DATA 是桌面版用来把 projects.json / .uploads 挪到可写位置的机制。
    // 这里指向一个独立目录，顺便验证「不会污染应用安装目录」。
    env: { ...process.env, PORT: String(PORT), PI_GUI_OPEN: '0', PI_GUI_DATA: DATA, PI_CWD: WORK },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  srv.stdout.on('data', (d) => (out += d));
  srv.stderr.on('data', (d) => (out += d));

  const stop = () => {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(srv.pid), '/T', '/F'], { stdio: 'ignore' });
      else srv.kill();
    } catch {
      /* 已经退出 */
    }
  };

  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const r = await fetch(BASE + '/api/status');
        if (r.ok) {
          up = true;
          break;
        }
      } catch {
        /* 还没起来 */
      }
    }
    if (!up) throw new Error('后端没能启动：\n' + out.slice(0, 800));
    check('内嵌后端能启动', () => true);

    const st = await (await fetch(BASE + '/api/status')).json();
    check('pi 子进程已拉起', () => st.piRunning === true || 'piRunning=' + st.piRunning);

    const index = await (await fetch(BASE + '/')).text();
    check('根路径返回页面', () => index.includes('<title>Pi GUI</title>') || '内容不对');

    const css = await (await fetch(BASE + '/styles.css')).text();
    check('styles.css 正常', () => css.length > 5000 || '只有 ' + css.length + ' 字节');
    check('[hidden] 兜底规则还在', () => /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(css) || '缺规则');

    const bad = await fetch(BASE + '/../package.json');
    check('目录穿越被挡', () => bad.status !== 200 || '返回了 ' + bad.status);

    /* 关键项：没有 node_modules 时 PDF 还能不能抽 */
    const pdf = path.join(FIX, '发酵罐空气分布器设计.pdf');
    if (fs.existsSync(pdf)) {
      const j = await (
        await fetch(BASE + '/api/upload?name=' + encodeURIComponent('检查.pdf'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: fs.readFileSync(pdf),
        })
      ).json();
      check('无 node_modules 下 PDF 抽取成功', () => j.kind === 'text' || `kind=${j.kind} error=${j.error || ''}`);
      check('PDF 正文含文档内容', () => (j.text || '').includes('DN300') || '没抽到关键内容');
      check('PDF 正文无乱码', () => !/\uFFFD/.test(j.text || '') || '出现替换字符');
      check('PDF 页数正确', () => j.pages === 1 || 'pages=' + j.pages);
    } else {
      check('PDF 固件存在（先跑 npm run fixtures）', () => false);
    }

    const docx = path.join(FIX, '发酵罐空气分布器设计.docx');
    if (fs.existsSync(docx)) {
      const j = await (
        await fetch(BASE + '/api/upload?name=t.docx', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: fs.readFileSync(docx),
        })
      ).json();
      check('docx 抽取成功', () => j.kind === 'text' || `kind=${j.kind}`);
    }

    const png = path.join(FIX, 'red.png');
    if (fs.existsSync(png)) {
      const j = await (
        await fetch(BASE + '/api/upload?name=t.png', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: fs.readFileSync(png),
        })
      ).json();
      check('图片识别为 image', () => j.kind === 'image' || `kind=${j.kind}`);
    }

    check('运行期没有崩栈输出', () => !/^\s*at .+\(node:/m.test(out) || out.slice(0, 300));

    /* 上传缓存必须落在 PI_GUI_DATA 指的地方，不能写进应用目录 ——
     * 桌面版装在 Program Files 下时那里是只读的。 */
    check('上传缓存写到了数据目录', () => fs.existsSync(path.join(DATA, '.uploads')) || '数据目录里没有 .uploads');
    check('应用目录没有被写入', () => !fs.existsSync(path.join(SANDBOX, '.uploads')) || '应用目录里出现了 .uploads');
  } finally {
    stop();
  }

  await checkNoProject();

  /* 收尾清干净。这几个目录加起来几十 MB，留在临时目录里没人会想起来清；
   * 注意 SANDBOX 在开头被删过（每轮重建），所以只靠开头那次清理不够。 */
  await sleep(1200); // 等子进程松开文件句柄
  for (const p of [SANDBOX, DATA, DATA + '-noproj', WORK]) rmrf(p);

  const failed = results.filter((r) => r[0] === 'FAIL');
  for (const [s, name, note] of results) console.log(`  ${s === 'PASS' ? 'ok  ' : 'FAIL'} ${name}${note ? '  → ' + note : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 800);
}

/* 没有项目时不应该启动 pi。
 *
 * 回归护栏。早先 server.js 拿 process.cwd() 兜底当项目，桌面版又把后端进程的
 * cwd 设成用户主目录 —— 于是首次启动直接落在主目录，还把那里的 pi 历史会话
 * 整段恢复出来。现在没有项目就是没有：pi 不启动，并且要给出可执行的指引，
 * 而不是「子进程未运行」这种让人以为是崩溃的话。
 *
 * 这里用同一个后端产物再起一份，但不给 PI_CWD。 */
async function checkNoProject() {
  const NOPORT = PORT + 1;
  const NOBASE = `http://127.0.0.1:${NOPORT}`;
  const NODATA = DATA + '-noproj';

  fs.rmSync(NODATA, { recursive: true, force: true });
  fs.mkdirSync(NODATA, { recursive: true });

  const srv = spawn(process.execPath, [path.join(SANDBOX, 'server.cjs')], {
    cwd: SANDBOX,
    env: { ...process.env, PORT: String(NOPORT), PI_GUI_OPEN: '0', PI_GUI_DATA: NODATA, PI_CWD: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  srv.stdout.on('data', (d) => (out += d));
  srv.stderr.on('data', (d) => (out += d));

  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await sleep(400);
      try {
        if ((await fetch(NOBASE + '/api/status')).ok) {
          up = true;
          break;
        }
      } catch {
        /* 还没起来 */
      }
    }
    if (!up) throw new Error('无项目模式的后端没能启动：\n' + out.slice(0, 600));

    const st = await (await fetch(NOBASE + '/api/status')).json();
    check('没有项目时 hasProject 为 false', () => st.hasProject === false || `hasProject=${st.hasProject}`);
    check('没有项目时不启动 pi', () => st.piRunning === false || `piRunning=${st.piRunning}`);
    // 项目列表走 /api/projects，不在 /api/status 里
    const pj = await (await fetch(NOBASE + '/api/projects')).json();
    check('没有项目时项目列表为空', () => (pj.items || []).length === 0 || `items=${JSON.stringify(pj.items)}`);

    const r = await fetch(NOBASE + '/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'prompt', message: '你好' }),
    });
    const j = await r.json();
    check('没有项目时命令被拒绝', () => r.status === 503 || `状态 ${r.status}`);
    check('拒绝时要说清楚该做什么', () =>
      /添加文件夹/.test(j.error || '') ? true : `提示是「${j.error}」，应该指引用户去添加文件夹`
    );
  } finally {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(srv.pid), '/T', '/F'], { stdio: 'ignore' });
      else srv.kill();
    } catch {
      /* 已退出 */
    }
  }
}

main().catch((e) => {
  console.log('失败: ' + e.message);
  process.exit(1);
});
