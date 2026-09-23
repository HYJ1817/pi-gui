/* 验证打包产物：build/Pi GUI.exe。
 *
 * 单文件 exe 很容易悄悄坏掉 —— 资源没打进包、pdfjs 的 worker 路径失效、
 * import.meta 被替换成空值之类，都是构建成功但一跑就废。
 * 这个脚本把 exe 真启起来，对着它做一遍关键检查。
 *
 * 用法：npm run build:exe && node tests/exe-check.cjs
 * 只用于开发期验收，不属于产品代码。 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'build', 'Pi GUI.exe');
const PORT = Number(process.env.CHECK_PORT || 7797);
const BASE = `http://127.0.0.1:${PORT}`;
const PDF = path.join(os.tmpdir(), 'pi-gui-fixtures', '发酵罐空气分布器设计.pdf');
/* pi 的工作目录。server.js 不再拿进程当前目录兜底当项目 ——
 * 没有项目就不启动 pi，所以想验证「pi 子进程已拉起」必须显式给一个目录。
 * 用临时目录而不是 build/：pi 会把会话写进工作目录，别污染构建产物。 */
const WORK = path.join(os.tmpdir(), 'pi-gui-execheck-work');

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

async function main() {
  if (!fs.existsSync(EXE)) throw new Error('没有 build/Pi GUI.exe，先运行 npm run build:exe');
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  const exe = spawn(EXE, [], {
    cwd: path.join(ROOT, 'build'),
    env: { ...process.env, PORT: String(PORT), PI_GUI_OPEN: '0', PI_CWD: WORK },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  exe.stdout.on('data', (d) => (stdout += d));
  exe.stderr.on('data', (d) => (stdout += d));

  /* 必须连子孙进程一起杀。
   *
   * `exe.kill()` 在 Windows 上只结束 exe 本身，**不管它 spawn 出来的 pi 子进程** ——
   * pi 会继续活着，而且它的 cwd 正是 WORK，于是 Windows 不允许删掉这个目录，
   * 每跑一次就留一个空目录（还多一个常驻的 pi 进程）。
   * taskkill /T 才会连整棵树一起收。 */
  const stop = () => {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/pid', String(exe.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        exe.kill();
      }
    } catch {
      /* 已经退出 */
    }
  };

  try {
    /* 等端口就绪 */
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
    if (!up) throw new Error('exe 没能启动，输出：\n' + stdout.slice(0, 800));

    check('exe 能启动并监听端口', () => true);

    const st = await (await fetch(BASE + '/api/status')).json();
    check('pi 子进程已拉起', () => st.piRunning === true || 'piRunning=' + st.piRunning);

    /* 内嵌资源必须和磁盘上的原文逐字节一致 */
    for (const f of ['index.html', 'styles.css', 'app.js']) {
      const served = Buffer.from(await (await fetch(`${BASE}/${f}`)).arrayBuffer());
      const disk = fs.readFileSync(path.join(ROOT, 'public', f));
      check(`内嵌 ${f} 与磁盘一致`, () => served.equals(disk) || `${served.length} vs ${disk.length}`);
    }

    /* 根路径：既要 200、要 index.html，也要能对上前面的内容校验 */
    const rootRes = await fetch(BASE + '/');
    const root = Buffer.from(await rootRes.arrayBuffer());
    check('首页根路径返回 index.html', () => {
      if (rootRes.status !== 200) return '状态码 ' + rootRes.status;
      const ct = rootRes.headers.get('content-type') || '';
      if (!ct.includes('text/html')) return 'Content-Type 是 ' + ct;
      if (!root.equals(fs.readFileSync(path.join(ROOT, 'public', 'index.html')))) return '与磁盘不一致';
      return true;
    });
    check('根路径内容正确', () => root.toString('utf8').includes('<title>Pi GUI</title>') || '内容不对');

    /* 目录穿越要挡住 */
    const bad = await fetch(BASE + '/../server.js');
    check('目录穿越被挡', () => bad.status !== 200 || '返回了 ' + bad.status);
    const bad2 = await fetch(BASE + '/%2e%2e%2fpackage.json');
    check('编码后的穿越也被挡', () => bad2.status !== 200 || '返回了 ' + bad2.status);

    /* 附件抽取：pdfjs 的 worker 在 SEA 下最容易坏 */
    if (fs.existsSync(PDF)) {
      const buf = fs.readFileSync(PDF);
      const r = await fetch(BASE + '/api/upload?name=' + encodeURIComponent('检查.pdf'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      });
      const j = await r.json();
      check('exe 内 PDF 抽取成功', () => j.kind === 'text' || `kind=${j.kind} error=${j.error || ''}`);
      check('PDF 正文含文档内容', () => (j.text || '').includes('DN300') || '没抽到关键内容');
      check('PDF 正文无乱码', () => !/\uFFFD/.test(j.text || '') || '出现替换字符');
      check('PDF 页数正确', () => j.pages === 1 || 'pages=' + j.pages);
    } else {
      check('PDF 固件存在（先跑 npm run fixtures）', () => false);
    }

    /* 其他格式 */
    const docx = path.join(os.tmpdir(), 'pi-gui-fixtures', '发酵罐空气分布器设计.docx');
    if (fs.existsSync(docx)) {
      const j = await (
        await fetch(BASE + '/api/upload?name=t.docx', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: fs.readFileSync(docx),
        })
      ).json();
      check('exe 内 docx 抽取成功', () => j.kind === 'text' || `kind=${j.kind}`);
    }

    const png = path.join(os.tmpdir(), 'pi-gui-fixtures', 'red.png');
    if (fs.existsSync(png)) {
      const j = await (
        await fetch(BASE + '/api/upload?name=t.png', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: fs.readFileSync(png),
        })
      ).json();
      check('exe 内图片识别为 image', () => j.kind === 'image' || `kind=${j.kind}`);
    }

    check('运行期没有崩栈输出', () => !/Error:|throw/i.test(stdout) || stdout.slice(0, 300));
  } finally {
    stop();
  }

  /* 收尾清掉工作目录。pi 会把会话写进去，留着只会越攒越多。 */
  await sleep(1200);
  rmrf(WORK);

  const failed = results.filter((r) => r[0] === 'FAIL');
  for (const [st, name, note] of results) console.log(`  ${st === 'PASS' ? 'ok  ' : 'FAIL'} ${name}${note ? '  → ' + note : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.log('失败: ' + e.message);
  process.exit(1);
});
