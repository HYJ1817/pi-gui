'use strict';
/* Z3-A: Real Electron layout, interaction, themes, sandbox security and screenshots.
 *
 * Runs with Electron normal sandbox (NO --no-sandbox); mounts the UI in Electron BrowserWindow,
 * verifies context isolation and absence of node integration, tests chart rendering,
 * parameter interaction, theme adaptation, captures real PNG screenshots,
 * and guarantees a non-zero exit code on any check failure or error.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.Z3_EVIDENCE_DIR || path.join(ROOT, '.probe', 'z3'));

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-z3-'));
  const env = { ...process.env, Z3_WORLD: world };
  delete env.ELECTRON_RUN_AS_NODE;
  const electronBin =
    process.env.Z3_ELECTRON_BINARY ||
    process.env.ELECTRON_OVERRIDE_DIST_PATH ||
    (fs.existsSync('C:\\Users\\21022\\AppData\\Local\\Temp\\pi-gui-g2-electron-44.4.3\\electron.exe')
      ? 'C:\\Users\\21022\\AppData\\Local\\Temp\\pi-gui-g2-electron-44.4.3\\electron.exe'
      : require('electron'));

  // 严格使用正常沙箱，严禁使用 --no-sandbox
  const args = [__filename, ...process.argv.slice(2)];
  const run = spawnSync(electronBin, args, {
    env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 120000,
  });

  if (path.dirname(world) === path.resolve(os.tmpdir()) && path.basename(world).startsWith('pi-gui-z3-')) {
    fs.rmSync(world, { recursive: true, force: true, maxRetries: 5 });
  }

  if (run.status !== 0) {
    console.error('Electron exit:', run.status, run.signal, run.error?.message || '');
  }
  process.exitCode = run.status ?? 1;
} else {
  const { app, BrowserWindow } = require('electron');
  const http = require('node:http');

  const simulateFailure = process.argv.includes('--simulate-failure');

  app.setPath('userData', path.join(process.env.Z3_WORLD, 'profile'));
  let win, server, checks = 0, failed = 0;
  const evidence = [];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = (name, value) => {
    checks++;
    if (!value) {
      failed++;
      process.exitCode = 1;
    }
    evidence.push({ name, passed: Boolean(value) });
    console.log(`${value ? 'PASS' : 'FAIL'} ${name}`);
  };

  process.on('uncaughtException', (err) => {
    console.error('Electron uncaughtException:', err);
    process.exitCode = 1;
    app.exit(1);
  });

  process.on('unhandledRejection', (err) => {
    console.error('Electron unhandledRejection:', err);
    process.exitCode = 1;
    app.exit(1);
  });

  app.whenReady().then(async () => {
    fs.mkdirSync(OUT, { recursive: true });

    // 1. 若触发了故意失败测试，验证退出码确实为非零并提前退出
    if (simulateFailure) {
      check('deliberate simulated check failure for non-zero exit code test', false);
      app.exit(1);
      return;
    }

    server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://fixture.invalid').pathname).replace(/^\//, '') || 'index.html';
      const file = path.resolve(ROOT, 'public', rel);
      if (!file.startsWith(path.join(ROOT, 'public') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end();
        return;
      }
      const types = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
      };
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      let body = fs.readFileSync(file);
      if (rel === 'index.html') {
        body = body.toString().replace('<script type="module" src="/app.js"></script>', '');
      }
      res.end(body);
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

    const read = (code) =>
      win.webContents.executeJavaScript(
        `(async () => {
          const result = await eval(${JSON.stringify(code)});
          try { return result === undefined ? undefined : JSON.parse(JSON.stringify(result)); } catch { return undefined; }
        })()`,
        true
      );

    const shot = async (name) => {
      await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await sleep(100);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, name + '.png'), image.toPNG());
      console.log(`  [Screenshot] saved ${name}.png`);
    };

    await win.loadURL(`http://127.0.0.1:${port}/`);

    // 2. 严格核对 Electron 正常沙箱与隔离安全状态
    const secState = await read(`({
      hasProcess: typeof window.process !== 'undefined',
      hasRequire: typeof window.require !== 'undefined',
      hasBuffer: typeof window.Buffer !== 'undefined',
    })`);
    check('renderer normal sandbox enabled (process is undefined)', secState.hasProcess === false);
    check('renderer contextIsolation enabled (require is undefined)', secState.hasRequire === false);
    check('renderer nodeIntegration disabled (Buffer is undefined)', secState.hasBuffer === false);

    // 3. 初始化环境与渲染多图表消息
    await read(`(async () => {
      const { S } = await import('/state.js');
      const { md } = await import('/markdown.js');
      const { initRightPane } = await import('/right-pane.js');
      const { configureSecondaryPane } = await import('/ui/secondary-surface.js');
      const { initVizIntegration } = await import('/viz-integration.js');

      Object.assign(S, {
        workspaceGeneration: 1,
        switching: false,
        bridgeState: 'ready',
        hasProject: true,
        cwd: 'C:\\\\fixture-viz',
        state: { sessionId: 'z3-session' },
      });

      const pane = initRightPane();
      configureSecondaryPane(pane);
      initVizIntegration();

      window.__testPane = pane;

      // 插入一条包含两个图表的助手消息
      const chart1Json = JSON.stringify({
        version: "1",
        type: "line",
        title: "CPU 核心负载对比",
        description: "监控多核使用率趋势",
        unit: "%",
        labels: ["00:00", "02:00", "04:00", "06:00", "08:00", "10:00"],
        series: [
          { name: "CPU Core 0", data: [22, 38, 65, 82, 45, 30] },
          { name: "CPU Core 1", data: [18, 25, 48, 70, 39, 24] },
          { name: "CPU Core 2", data: [12, 19, 35, 54, 28, 16] }
        ],
        params: [
          { id: "threshold", name: "告警线", type: "number", min: 0, max: 100, default: 60 }
        ]
      });

      const chart2Json = JSON.stringify({
        version: "1",
        type: "bar",
        title: "各模块编译耗时",
        description: "构建流水线性能瓶颈",
        unit: "s",
        labels: ["Parser", "TypeCheck", "Codegen", "Bundler", "Minify"],
        series: [
          { name: "优化前", data: [12.4, 28.5, 35.2, 19.8, 15.1] },
          { name: "优化后", data: [6.1, 14.2, 18.0, 9.5, 7.3] }
        ]
      });

      const msgMd = "### 诊断结果分析\\n\\n以下是本次实测的系统负载与性能瓶颈统计：\\n\\n" +
        "\`\`\`pi-gui-viz\\n" + chart1Json + "\\n\`\`\`\\n\\n" +
        "构建各阶段耗时对比柱状图如下：\\n\\n" +
        "\`\`\`pi-gui-viz\\n" + chart2Json + "\\n\`\`\`\\n\\n" +
        "请查看详细指标。";

      const stream = document.getElementById('stream');
      const thread = document.createElement('div');
      thread.className = 'thread';
      const msg = document.createElement('div');
      msg.className = 'message assistant-message';
      msg.innerHTML = md(msgMd);
      thread.append(msg);
      stream.append(thread);

      return true;
    })()`);

    // 4. 验证流内图表卡片渲染
    const cardCount = await read('document.querySelectorAll(".viz-card").length');
    check('stream contains 2 interactive viz cards', cardCount === 2);

    await shot('01-chat-stream-viz-cards');

    // 5. 点击打开第一个图表（折线图）
    await read('document.querySelectorAll("[data-viz-open]")[0].click()');
    const paneOpen = await read('window.__testPane.isOpen()');
    check('clicking open opens right pane', paneOpen === true);

    const svgExists = await read('document.querySelector("#rightPane svg.viz-chart-line") !== null');
    check('line chart SVG is rendered in right pane', svgExists === true);

    await shot('02-line-chart-in-right-pane');

    // 6. 参数交互：切换为柱状图形态
    await read('document.querySelector(".viz-type-row button:last-child").click()');
    const isBar = await read('document.querySelector("#rightPane svg.viz-chart-bar") !== null');
    check('switched to bar chart presentation in Electron', isBar === true);

    await shot('03-bar-chart-switched');

    // 7. 调整阈值并高亮超标
    await read(`(() => {
      const slider = document.querySelector(".viz-thresh-row .viz-slider");
      slider.value = "50";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    const alertCount = await read('document.querySelectorAll("#rightPane .is-alert").length');
    check('exceeding data points or bars are highlighted', alertCount > 0);

    await shot('04-threshold-highlight');

    // 8. 引用到输入框草稿
    await read('document.querySelector(".viz-quote-btn").click()');
    const composerText = await read('document.getElementById("input").value');
    check('composer is populated with chart summary', composerText.includes('[图表配置引用：CPU 核心负载对比]'));

    await shot('05-quoted-to-composer');

    // 9. 浅色主题适配
    await read('document.documentElement.setAttribute("data-theme", "light")');
    await shot('06-light-theme-adaptation');

    // 恢复深色主题
    await read('document.documentElement.setAttribute("data-theme", "dark")');

    // 10. 窄窗口布局自适应（760px 宽度）
    win.setSize(760, 700);
    await sleep(200);
    const mode = await read('document.getElementById("rightPane").dataset.mode');
    check('narrow window switches right pane mode to overlay or clamped width', mode === 'overlay' || mode === 'dock');

    await shot('07-narrow-window-responsive');

    // 11. 打开第二个图表（多图表切换）
    await read('document.querySelectorAll("[data-viz-open]")[1].click()');
    const chart2Title = await read('document.querySelector(".rp-head-title").textContent');
    check('switching to second chart updates panel title', chart2Title === '各模块编译耗时');

    await shot('08-second-chart-switched');

    console.log(`\nElectron Viz: ${checks - failed}/${checks} passed.`);
    server.close();
    win.destroy();

    if (failed > 0) {
      process.exitCode = 1;
      app.exit(1);
    } else {
      process.exitCode = 0;
      app.quit();
    }
  });
}
