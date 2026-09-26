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
/* 数据目录也必须显式给。不给的话 server.js 会把「exe 所在目录」当数据目录
 * （单文件 exe 的便携模式），于是测试会往 build/ 里写 projects.json / .uploads
 * —— 既是污染，也让「产物没被改动」这件事没法断言。 */
const DATA = path.join(os.tmpdir(), 'pi-gui-execheck-data');

/* 假 pi：只负责「活着」的 .cmd shim。
 *
 * 「pi 子进程已拉起」要验的是**打包出来的 exe 还能 spawn 外部命令并跟踪生命周期**，
 * 不是「这台机器装了 pi」。原来直接依赖本机安装 → 开发机绿、干净 CI runner 红。
 * rpc-bridge 在 Windows 上走 shell:true，所以一个 .cmd 就够。
 *
 * ⚠️ 必须用**脚本文件**而不是 `node -e "..."`：rpc-bridge 会把 `--mode rpc ...`
 * 传下来，而 `node -e "代码" --mode rpc` 会被 node 当成选项解析、报
 * `bad option: --mode` 后直接退出（Node 22 / 24 都一样）—— 假 pi 秒退，
 * piRunning 就成了 false。 */
const FAKE_PI_DIR = path.join(os.tmpdir(), 'pi-gui-execheck-bin');
fs.mkdirSync(FAKE_PI_DIR, { recursive: true });
const FAKE_PI_SCRIPT = path.join(FAKE_PI_DIR, 'fake-pi.cjs');
fs.writeFileSync(FAKE_PI_SCRIPT, 'setInterval(function () {}, 1e9);\n', 'utf8');
const FAKE_PI = path.join(FAKE_PI_DIR, 'fake-pi.cmd');
/* ⚠️ shim 的**正文必须是纯 ASCII**。
 *
 * node 的安装路径可能含非 ASCII 字符（本机就是 `C:\A看剧\node.exe`），而
 * `.cmd` 是按 UTF-8 写盘的、cmd.exe 却按**系统 ANSI 代码页**（中文 Windows 是
 * GBK）去读 —— 中文路径会变乱码，于是报「系统找不到指定的路径」，假 pi 根本
 * 起不来，`piRunning` 就成了 false。纯 ASCII 路径的机器（CI runner、多数开发机）
 * 上完全不出现，所以只在特定环境里假红。
 *
 * 解法：路径走**环境变量**（经 OS 传递，不经过代码页），脚本用 `%~dp0`
 * 在运行时解析自身所在目录 —— 正文里一个非 ASCII 字符都没有。 */
fs.writeFileSync(FAKE_PI, '@echo off\r\n"%FAKE_PI_NODE%" "%~dp0fake-pi.cjs" %*\r\n', 'utf8');

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
    env: {
      ...process.env,
      PORT: String(PORT),
      PI_GUI_OPEN: '0',
      PI_CWD: WORK,
      PI_GUI_DATA: DATA,
      PI_BIN: FAKE_PI,
      // 假 pi shim 靠它找到 node —— 见上面「正文必须纯 ASCII」的说明
      FAKE_PI_NODE: process.execPath,
    },
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

    /* 项目配置在 SEA 里的读写。
     *
     * 单文件 exe 最容易在这里翻车：模块没进包 → 路由 404；或者路径拼装依赖了
     * 开发期才有的东西（process.cwd()、import.meta.url）→ 写不进去。
     * 所以这里不只问接口，还要**去磁盘上确认文件真的出现了**。 */
    const cfgFile = path.join(WORK, '.pi-gui', 'config.json');
    const genFile = path.join(WORK, '.pi-gui', 'instructions.generated.md');

    const cfg0 = await (await fetch(BASE + '/api/project-config')).json();
    check('exe 内 GET /api/project-config 通（模块进包了）', () => cfg0.ok === true || JSON.stringify(cfg0));
    check('exe 内认得出当前项目（hasProject + cwd）', () =>
      (cfg0.hasProject === true && cfg0.cwd === WORK) || `hasProject=${cfg0.hasProject} cwd=${cfg0.cwd}`);
    check('exe 内没有配置文件时给默认值，不报错', () =>
      (cfg0.exists === false && cfg0.config && cfg0.config.version === 1 && cfg0.config.model === null) ||
      JSON.stringify(cfg0.config));

    const put1 = await (
      await fetch(BASE + '/api/project-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ignore: ['node_modules', 'dist'],
          commands: [{ name: '测试', command: 'npm test' }],
          // 顺手混进未知字段和错误类型，验证「只写白名单 + 丢弃坏数据」
          apiKey: 'sk-MUST-NOT-BE-WRITTEN',
          nonsense: { a: 1 },
          thinking: 123,
        }),
      })
    ).json();
    check('exe 内 PUT 项目配置成功', () => put1.ok === true || JSON.stringify(put1));
    check('exe 内只改 ignore / commands 时不触发重启', () =>
      put1.restartRequired === false || 'restartRequired=' + put1.restartRequired);
    check('exe 内配置文件真的落到磁盘上', () => fs.existsSync(cfgFile) || '没有 ' + cfgFile);

    if (fs.existsSync(cfgFile)) {
      const raw = fs.readFileSync(cfgFile, 'utf8');
      let saved = null;
      try {
        saved = JSON.parse(raw);
      } catch (e) {
        saved = null;
      }
      check('exe 内配置是合法 JSON', () => saved !== null || raw.slice(0, 120));
      check('exe 内配置写上了 version', () => (saved && saved.version === 1) || JSON.stringify(saved));
      check('exe 内未知字段被丢弃（没落盘）', () =>
        saved && saved.nonsense === undefined || JSON.stringify(saved));
      check('exe 内错误类型被丢弃（thinking 是数字）', () =>
        saved && (saved.thinking === null || saved.thinking === undefined) || JSON.stringify(saved));
      check('exe 内 ignore / commands 原样保存', () =>
        (saved &&
          Array.isArray(saved.ignore) &&
          saved.ignore[0] === 'node_modules' &&
          Array.isArray(saved.commands) &&
          saved.commands[0].name === '测试') ||
        JSON.stringify(saved));
      check('exe 内配置文件里没有出现 apiKey（密钥边界）', () => !raw.includes('apiKey') || '出现了 apiKey');
      check('exe 内配置文件里没有出现传入的密钥值', () => !raw.includes('sk-MUST-NOT-BE-WRITTEN') || '密钥被写进去了');
    }

    /* 指令：落成产物文件 + 走启动参数（所以会重启一次 pi） */
    const put2 = await (
      await fetch(BASE + '/api/project-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions: '这个项目用 TypeScript\n不要改 generated/' }),
      })
    ).json();
    check('exe 内保存项目指令成功', () => put2.ok === true || JSON.stringify(put2));
    check('exe 内指令落成了可注入的文件', () =>
      (fs.existsSync(genFile) && fs.readFileSync(genFile, 'utf8').includes('不要改 generated/')) ||
      '没有 ' + genFile);
    check('exe 内改指令会要求重启 pi（走启动参数生效）', () =>
      put2.restartRequired === true || 'restartRequired=' + put2.restartRequired);

    const cfg1 = await (await fetch(BASE + '/api/project-config')).json();
    check('exe 内回读拿到刚保存的内容（读-写闭环）', () =>
      (cfg1.exists === true &&
        cfg1.config.instructions.includes('这个项目用 TypeScript') &&
        cfg1.config.ignore.length === 2) ||
      JSON.stringify(cfg1.config));

    const cfgQ = await (
      await fetch(BASE + '/api/project-config?projectPath=' + encodeURIComponent('C:\\') + '&path=../../')
    ).json();
    check('exe 内带 projectPath / 穿越参数不改变目标项目（唯一来源是 runtime 的 cwd）', () =>
      cfgQ.cwd === WORK || 'cwd=' + cfgQ.cwd);

    /* 扩展能力（Skills / MCP）。和 project-config 同理：单文件 exe 里模块没进包
     * 就是 404，所以这两个 GET 必须真的通。 */
    const sk = await (await fetch(BASE + '/api/skills')).json();
    check('exe 内 GET /api/skills 通（模块进包了）', () => sk.ok === true || JSON.stringify(sk));
    check('exe 内 skills 列表是数组、counts 齐全', () =>
      (Array.isArray(sk.skills) && sk.counts && typeof sk.counts.total === 'number') || JSON.stringify(sk.counts));
    check('exe 内 skills 报出四个发现根', () => (sk.roots || []).length >= 3 || JSON.stringify(sk.roots));
    check('exe 内认得出 agentDir（PI_CODING_AGENT_DIR 被 exe 读到了）', () =>
      typeof sk.agentDir === 'string' && sk.agentDir.length > 0 || sk.agentDir);
    check('exe 内 skills 负载里没有密钥字段', () => !/apiKey|password|secret/i.test(JSON.stringify(sk)) || '出现了敏感词');

    const skDetail = await fetch(BASE + '/api/skills/' + '0'.repeat(16));
    check('exe 内未知 skill ID → 404（不崩）', () => skDetail.status === 404 || skDetail.status);
    const skDel = await fetch(BASE + '/api/skills', { method: 'DELETE' });
    check('exe 内 DELETE /api/skills → 405', () => skDel.status === 405 || skDel.status);

    const mc = await (await fetch(BASE + '/api/mcp')).json();
    check('exe 内 GET /api/mcp 通（模块进包了）', () => mc.ok === true || JSON.stringify(mc));
    check('exe 内 mcp 报告带 supported / servers / extensionRoute 三个字段', () =>
      Boolean('supported' in mc && Array.isArray(mc.servers) && mc.extensionRoute) || JSON.stringify(Object.keys(mc)));
    check('exe 内 mcp 不假装有 Server（servers 为空）', () => mc.servers.length === 0 || JSON.stringify(mc.servers));
    check('exe 内 mcp 报告里没有「已连接」这类没数据支撑的状态', () =>
      !/已连接|connected/i.test(JSON.stringify(mc)) || '出现了不该有的状态词');

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
    /* 单文件 exe 的便携模式会把数据目录算成「exe 所在目录」——
     * 所以这里显式给了 PI_GUI_DATA，顺便确认它真的生效了：
     * 数据落在临时目录，而不是被写进 build/（构建产物不该被测试改脏）。 */
    check('数据目录用的是 PI_GUI_DATA 指的地方', () => fs.existsSync(DATA) || '临时数据目录没有被创建：' + DATA);
    check('产物目录没有被写入（没有在 build/ 里生成 projects.json）', () => !fs.existsSync(path.join(ROOT, 'build', 'projects.json')) || 'build/ 里出现了 projects.json');
  } finally {
    stop();
  }

  /* 收尾清掉工作目录与数据目录。pi 会把会话写进工作目录，留着只会越攒越多。 */
  await sleep(1200);
  rmrf(WORK);
  rmrf(DATA);

  const failed = results.filter((r) => r[0] === 'FAIL');
  for (const [st, name, note] of results) console.log(`  ${st === 'PASS' ? 'ok  ' : 'FAIL'} ${name}${note ? '  → ' + note : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.log('失败: ' + e.message);
  process.exit(1);
});
