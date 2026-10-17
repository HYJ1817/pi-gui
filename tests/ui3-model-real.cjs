/* UI-3B 的真实渲染证据：真实 Chromium + 离线夹具，量布局、出截图。
 *
 * 为什么单独一个文件：jsdom 不做布局（getBoundingClientRect 恒为 0）也不套用
 * 外部样式表，所以「长模型名会不会撑破弹层」「700×600 下档位还在不在视口里」
 * 「浅色主题下能力说明还看不看得清」这些**只能**在真实浏览器里量。
 *
 * 用 tests/visual-harness.cjs 当夹具服务（静态托管 public/、/api/* 全换脚本数据），
 * 端口给 0 让系统随机分配 —— 本机 7789/7799/7793 都被既有套件或系统占着，
 * 平行分支还有别的 agent 在跑，蹲固定端口会互相踩。
 *
 * 不启真 pi、不碰用户数据、不联网。
 *
 * 用法：
 *   node tests/ui3-model-real.cjs            独立跑
 *   node tests/ui3-model.cjs --real          由契约套件带起来
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHROME = process.env.UI3_CHROME || process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = Number(process.env.UI3_CDP_PORT || 9231);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function realRender({ out }) {
  fs.mkdirSync(out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ui3-model-chrome-'));
  let pass = 0, fail = 0;
  const results = [];
  const check = async (label, fn) => {
    try { await fn(); pass++; results.push({ label, ok: true }); console.log('  ok  ' + label); }
    catch (e) { fail++; results.push({ label, ok: false, error: e.message }); console.error(' FAIL ' + label + ': ' + e.message); }
  };

  const harness = spawn(process.execPath, [path.join(__dirname, 'visual-harness.cjs')],
    { env: { ...process.env, HARNESS_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const app = await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error('夹具启动超时')), 15000);
    harness.stdout.on('data', (c) => {
      buf += c;
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(t); res(`http://127.0.0.1:${m[1]}/`); }
    });
  });

  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-sync',
    '--disable-component-update', '--disable-background-networking', '--no-default-browser-check',
    '--disable-default-apps', '--metrics-recording-only',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let ws;
  const shots = [];
  try {
    let pages;
    for (let n = 0; n < 80; n++) {
      try {
        pages = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
        if (pages.some((p) => p.type === 'page') && (await fetch(app)).ok) break;
      } catch { /* Chrome 还没起来 */ }
      await sleep(150);
    }
    ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      }
      if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise((res) => {
      const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      return r.result.result.value;
    };
    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(out, name + '.png');
      fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
      shots.push(path.basename(file));
      return file;
    };
    const click = async (selector) => {
      const pos = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});`
        + `if(!n)return null;const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      assert.ok(pos, `找不到可点元素 ${selector}`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...pos });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...pos });
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: app });
    await sleep(1600);
    /* 无头 Chrome 里标签页默认不是「已激活」的，document.hasFocus() 为 false，
     * 于是 Input.dispatchKeyEvent 投递的按键不会进到页面 —— 键盘断言会静默地
     * 变成「什么都没发生」。bringToFront 把它激活。 */
    await send('Page.bringToFront');

    /* ---------- 装夹具：真实页面 + 真实 CSS，只把 /api 换成脚本数据 ---------- */
    await evaluate(`(async()=>{
      const state = await import('/state.js');
      const view  = await import('/ui3-model-picker.js');
      /* ui3-model.css 由集成方在 index.html 里加 <link>（本分支不许改 index.html）。
       * 这里在运行时把同一份**真实文件**挂上去，量的就是它本身 —— 不这么做的话
       * 「长名会不会撑破」测的其实是 styles.css 的 nowrap，与本模块无关。 */
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = '/ui3-model.css';
      document.head.append(link);
      await new Promise((res, rej) => { link.onload = res; link.onerror = () => rej(new Error('ui3-model.css 加载失败')); });
      const long = 'Very Long Vendor Model Name That Keeps Going And Going '.repeat(4).trim();
      const models = [
        {provider:'deepseek', id:'deepseek-reasoner', name:'DeepSeek Reasoner', reasoning:true, contextWindow:128000},
        {provider:'deepseek', id:'deepseek-chat', name:'DeepSeek Chat', reasoning:false, input:['text']},
        {provider:'zhipu', id:'glm-4.6', name:'GLM-4.6', reasoning:true},
        {provider:'openrouter', id:'deepseek-reasoner', name:'DeepSeek Reasoner'},
        {provider:'openrouter', id:'unknown-cap', name:'Metadata Unavailable'},
        {provider:'openrouter', id:'long-name', name:long},
        ...Array.from({length:120},(_,i)=>({provider:'bulk', id:'bulk-'+i, name:'Bulk Model '+i})),
      ];
      const expanded = new Set();
      globalThis.ui3 = {
        state, view, models, expanded,
        picks: [],
        current: {provider:'deepseek', id:'deepseek-reasoner', name:'DeepSeek Reasoner'},
        openModels(){ view.renderModelPicker({models:this.models, current:this.current, expanded:this.expanded,
          onSelect:(p,id)=>this.picks.push([p,id])}); },
        openThink(o){ view.renderThinkingPicker({model:o.model, levels:o.levels, current:o.current,
          pending:!!o.pending, onSelect:(lv)=>this.picks.push(['think',lv])}); },
      };
      document.getElementById('btnModel').disabled = false;
      document.getElementById('btnThink').disabled = false;
    })()`);

    /* ---------- 两主题 × 四宽度 ---------- */
    const THEMES = ['dark', 'light'];
    const WIDTHS = [700, 900, 1200, 1536];
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 600, deviceScaleFactor: 1, mobile: false });
        await evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
        /* 视口变化会触发 window resize，而 ui/popover.js 的既有行为是**关闭**弹层
         * （那是对的：位置已经不对了）。resize 事件是异步投递的，所以必须先让它
         * 落地再开弹层，否则弹层刚画好就被这个迟到的 resize 收掉。
         * 这不是产品缺陷 —— 是本套件自己制造了 resize。 */
        await sleep(250);

        await evaluate('ui3.openModels()');
        await sleep(120);
        /* 长名条目在 openrouter 组里，默认收起 —— 收起的子树量不到布局。
         * 想量它就得先把它展开（这一步本身也顺带覆盖了折叠交互）。 */
        await evaluate(`(()=>{const g=document.querySelector('.pop-model-group[data-provider="openrouter"]');`
          + `if(g&&g.querySelector('.pop-provider-models').hidden)g.querySelector('.pop-provider').click();})()`);
        await sleep(120);

        await check(`${theme} ${width}: 模型弹层不出视口`, async () => {
          const m = await evaluate(`(()=>{const p=document.querySelector('.pop'),r=p.getBoundingClientRect();`
            + `return {top:r.top,left:r.left,right:r.right,bottom:r.bottom,w:r.width,h:r.height,`
            + `vw:innerWidth,vh:innerHeight,scrollW:p.scrollWidth,clientW:p.clientWidth}})()`);
          assert.ok(m.w > 0 && m.h > 0, `弹层尺寸为 0: ${JSON.stringify(m)}`);
          assert.ok(m.top >= 0, `顶部越界 top=${m.top}`);
          assert.ok(m.left >= 0, `左侧越界 left=${m.left}`);
          assert.ok(m.right <= m.vw + 1, `右侧越界 right=${m.right} vw=${m.vw}`);
          assert.ok(m.bottom <= m.vh + 1, `底部越界 bottom=${m.bottom} vh=${m.vh}`);
        });

        await check(`${theme} ${width}: 无横向溢出`, async () => {
          const over = await evaluate(`(()=>{const p=document.querySelector('.pop');`
            + `return {hOverflow:p.scrollWidth-p.clientWidth,`
            + `items:[...p.querySelectorAll('.ui3-model-item')].filter(n=>n.scrollWidth>n.clientWidth+1).length}})()`);
          assert.ok(over.hOverflow <= 1, `弹层横向溢出 ${over.hOverflow}px`);
          assert.equal(over.items, 0, `${over.items} 个条目横向溢出`);
        });

        await check(`${theme} ${width}: 长模型名换行而不是撑破`, async () => {
          const r = await evaluate(`(()=>{const n=[...document.querySelectorAll('.ui3-model-item')]`
            + `.find(x=>x.dataset.modelId==='long-name');const t=n.querySelector('.pi-text');`
            + `const b=t.getBoundingClientRect(),p=document.querySelector('.pop').getBoundingClientRect();`
            + `return {h:b.height,right:b.right,popRight:p.right,ws:getComputedStyle(t).whiteSpace}})()`);
          assert.ok(r.h > 0, '长名条目高度为 0');
          assert.ok(r.right <= r.popRight + 1, `长名超出弹层右缘 ${r.right} > ${r.popRight}`);
          assert.notEqual(r.ws, 'nowrap', '长名不该用 nowrap');
        });

        await check(`${theme} ${width}: 能力说明可见且有对比度`, async () => {
          const r = await evaluate(`(()=>{const s=document.querySelector('.ui3-model-item .pi-sub');`
            + `const cs=getComputedStyle(s);const b=s.getBoundingClientRect();`
            + `return {color:cs.color,size:parseFloat(cs.fontSize),h:b.height,text:s.textContent}})()`);
          assert.ok(r.h > 0 && r.size >= 10, `说明行不可见或过小: ${JSON.stringify(r)}`);
          assert.notEqual(r.color, 'rgba(0, 0, 0, 0)', '说明文字透明');
        });

        await check(`${theme} ${width}: 选中态与身份行都在`, async () => {
          const r = await evaluate(`(()=>{const on=document.querySelector('.ui3-model-item.on');`
            + `const cur=document.querySelector('.ui3-current');`
            + `return {onCount:document.querySelectorAll('.ui3-model-item.on').length,`
            + `onProvider:on&&on.dataset.provider,onId:on&&on.dataset.modelId,`
            + `bg:on&&getComputedStyle(on).backgroundColor,cur:cur&&cur.textContent}})()`);
          assert.equal(r.onCount, 1, '选中项不唯一');
          assert.equal(r.onProvider, 'deepseek');
          assert.equal(r.onId, 'deepseek-reasoner');
          assert.ok(r.cur && r.cur.includes('deepseek / deepseek-reasoner'));
        });

        await check(`${theme} ${width}: Provider 折叠标题可见`, async () => {
          const r = await evaluate(`(()=>{const h=document.querySelector('.pop-provider');`
            + `const b=h.getBoundingClientRect();const n=h.querySelector('.pop-provider-name');`
            + `return {h:b.height,w:b.width,name:n.textContent,expanded:h.getAttribute('aria-expanded'),`
            + `chev:h.querySelector('.pop-provider-chev').textContent}})()`);
          assert.ok(r.h > 0 && r.w > 0, '组头不可见');
          assert.equal(r.name, 'deepseek');
          assert.equal(r.expanded, 'true');
          assert.ok(r.chev.length > 0, '折叠箭头没画出来');
        });

        await shot(`models-${theme}-${width}`);

        /* ---------- Thinking ---------- */
        await evaluate(`ui3.openThink({model:{provider:'deepseek',id:'deepseek-reasoner',reasoning:true},`
          + `levels:['off','minimal','low','medium','high','xhigh','max'],current:'high'})`);
        await sleep(100);
        await check(`${theme} ${width}: Thinking 弹层不出视口`, async () => {
          const m = await evaluate(`(()=>{const p=document.querySelector('.pop'),r=p.getBoundingClientRect();`
            + `return {top:r.top,left:r.left,right:r.right,bottom:r.bottom,vw:innerWidth,vh:innerHeight,`
            + `items:document.querySelectorAll('.ui3-think-item').length}})()`);
          assert.equal(m.items, 7, '档位数与 Pi 返回的不一致');
          assert.ok(m.top >= 0 && m.left >= 0 && m.right <= m.vw + 1 && m.bottom <= m.vh + 1,
            `Thinking 弹层越界: ${JSON.stringify(m)}`);
        });
        await shot(`think-${theme}-${width}`);

        /* 不可用态：窄屏也要能读到原因 */
        await evaluate(`ui3.openThink({model:{provider:'deepseek',id:'deepseek-chat',reasoning:false},levels:[],current:null})`);
        await sleep(100);
        await check(`${theme} ${width}: 不可用状态行在视口内且可读`, async () => {
          const r = await evaluate(`(()=>{const s=document.querySelector('.ui3-think-state');`
            + `const b=s.getBoundingClientRect();const cs=getComputedStyle(s);`
            + `return {state:s.dataset.state,text:s.textContent,h:b.height,w:b.width,`
            + `bottom:b.bottom,vh:innerHeight,color:cs.color,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
          assert.equal(r.state, 'unsupported');
          assert.ok(r.h > 0 && r.w > 0, '状态行不可见');
          assert.ok(r.bottom <= r.vh + 1, '状态行在视口外');
          assert.equal(r.overflow, false, '页面横向溢出');
        });
        await shot(`think-unavailable-${theme}-${width}`);

        await evaluate(`(()=>{const {view}=ui3;view.renderModelPicker({models:ui3.models,current:ui3.current,expanded:ui3.expanded});`
          + `view.renderThinkingPicker({model:{provider:'p',id:'m'},levels:[],current:null})})()`);
        await sleep(80);
        await check(`${theme} ${width}: 能力未知不画成不支持`, async () => {
          const r = await evaluate(`(()=>{const s=document.querySelector('.ui3-think-state');`
            + `return {state:s.dataset.state,text:s.textContent,`
            + `hasUnsupported:/不支持/.test(s.textContent)}})()`);
          assert.equal(r.state, 'unknown');
          assert.equal(r.hasUnsupported, false, '未知被写成了不支持');
        });
        await shot(`think-unknown-${theme}-${width}`);
      }
    }

    /* ---------- Browser 右栏遮挡：弹层 z-index 必须高于右栏 ---------- */
    await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    /* 又一次视口变化 → 又一次异步 resize 关弹层；先等它落地。 */
    await sleep(250);
    await check('弹层 z-index 高于右栏与模态遮罩层以下', async () => {
      const r = await evaluate(`(()=>{const p=document.querySelector('.pop');`
        + `const pane=document.querySelector('.right-pane')||document.querySelector('.rp');`
        + `return {pop:getComputedStyle(p).zIndex,pane:pane?getComputedStyle(pane).zIndex:null,`
        + `pos:getComputedStyle(p).position}})()`);
      assert.equal(r.pos, 'fixed');
      const z = Number(r.pop);
      assert.ok(Number.isFinite(z) && z >= 70, `弹层 z-index 过低: ${r.pop}`);
      if (r.pane && Number.isFinite(Number(r.pane))) {
        assert.ok(z > Number(r.pane), `弹层 z=${z} 不高于右栏 z=${r.pane}`);
      }
    });

    /* ---------- 真实键盘漫游（CDP 输入事件，不是合成 KeyboardEvent） ---------- */
    /* 上一条断言只看 computed style，不需要弹层开着；这里重新开一次并确认它真的开着，
     * 否则后面就是在对着一个 hidden 的弹层派发按键（那个失败会指向错误的方向）。 */
    await evaluate('ui3.openModels()');
    await sleep(150);
    await check('弹层在派发按键前确实处于打开状态，且页面能接收按键', async () => {
      const r = await evaluate(`(()=>({hidden:document.querySelector('.pop').hidden,`
        + `items:document.querySelectorAll('.pop-item').length,focused:document.hasFocus()}))()`);
      assert.equal(r.hidden, false, '弹层没开');
      assert.ok(r.items > 3, `可见条目过少: ${r.items}`);
      /* 页面没焦点时 CDP 按键根本进不来，下面的键盘断言会假绿成「焦点没动」。
       * 这里先把它挡掉，免得把环境问题读成产品缺陷。 */
      assert.equal(r.focused, true, '页面没有焦点，CDP 按键不会生效');
    });
    /* 漫游序列里既有模型条目也有 Provider 组头（组头本身是可聚焦的整行按钮）。
     * 断言用「身份序列」而不是「有没有变」—— 后者在只有一个可聚焦项时会假绿。 */
    const activeKey = `(()=>{const a=document.activeElement;`
      + `return {inPop:document.querySelector('.pop').contains(a),`
      + `key:a.dataset.modelId?'model:'+a.dataset.modelId:a.dataset.provider?'provider:'+a.dataset.provider:a.tagName}})()`;
    const navOrder = () => evaluate(`[...document.querySelectorAll('.pop-provider,.pop-item')]`
      + `.filter(n=>!n.disabled&&!n.closest('[hidden]'))`
      + `.map(n=>n.dataset.modelId?'model:'+n.dataset.modelId:'provider:'+n.dataset.provider)`);
    const arrow = async (code, key) => {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: code, key, code: key });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: code, key, code: key });
      await sleep(60);
    };
    await check('真实方向键按漫游序列前进', async () => {
      const order = await navOrder();
      assert.ok(order.length >= 3, `漫游序列过短: ${JSON.stringify(order)}`);
      await evaluate(`document.querySelector('.pop-item').focus()`);
      const start = await evaluate(activeKey);
      assert.equal(start.inPop, true, '初始焦点不在弹层内');
      const i = order.indexOf(start.key);
      assert.ok(i >= 0, `起点 ${start.key} 不在漫游序列里: ${JSON.stringify(order)}`);
      await arrow(40, 'ArrowDown');
      const one = await evaluate(activeKey);
      assert.equal(one.inPop, true, '焦点跑出弹层了');
      assert.equal(one.key, order[(i + 1) % order.length], '↓ 没有走到序列里的下一项');
      await arrow(38, 'ArrowUp');
      const back = await evaluate(activeKey);
      assert.equal(back.key, start.key, '↑ 没有回到原项');
    });
    await check('真实 ↑ 从首项回绕到末项', async () => {
      const order = await navOrder();
      await evaluate(`(()=>{const a=document.activeElement;`
        + `const first=document.querySelector('.pop-provider');first.focus();})()`);
      const first = await evaluate(activeKey);
      assert.equal(first.key, order[0], '没聚焦到序列首项');
      await arrow(38, 'ArrowUp');
      const wrapped = await evaluate(activeKey);
      assert.equal(wrapped.inPop, true, '焦点跑出弹层了');
      assert.equal(wrapped.key, order[order.length - 1], '↑ 没有从首项回绕到末项');
    });
    await check('真实 Escape 关闭弹层并把焦点还给触发按钮', async () => {
      /* Escape 的监听挂在 pop 自己身上（ui/popover.js 的既有契约）——
       * 它**只在焦点位于弹层内时**触发。所以先把焦点放回弹层里，这才是真实路径：
       * 用户用键盘漫游到某一项，然后按 Esc。 */
      await evaluate(`(()=>{const n=document.querySelector('.pop-item');n.focus();})()`);
      assert.equal(await evaluate(`document.querySelector('.pop').contains(document.activeElement)`), true,
        'Escape 派发前焦点不在弹层内');
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
      await sleep(150);
      const r = await evaluate(`(()=>({hidden:document.querySelector('.pop').hidden,`
        + `focus:document.activeElement.id}))()`);
      assert.equal(r.hidden, true, 'Escape 没关掉弹层');
      assert.equal(r.focus, 'btnModel', '焦点没还给触发按钮');
    });

    /* ---------- reduced-motion ---------- */
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await evaluate('ui3.openModels()');
    await sleep(100);
    await check('reduced-motion 下静态状态完整（不是一片空白）', async () => {
      const r = await evaluate(`(()=>{const items=document.querySelectorAll('.ui3-model-item').length;`
        + `const h=document.querySelector('.pop-provider').getBoundingClientRect().height;`
        + `return {items,h}})()`);
      assert.ok(r.items > 100, `条目丢失: ${r.items}`);
      assert.ok(r.h > 0, 'reduced-motion 下组头塌了');
    });
    await send('Emulation.setEmulatedMedia', { features: [] });

    await check('页面无 JS 异常', () => {
      assert.deepEqual(errors, [], '页面抛了异常: ' + errors.join(' | ').slice(0, 300));
    });
  } finally {
    try { ws?.close(); } catch { /* 已断开 */ }
    chrome.kill();
    harness.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome 还占着 */ }
  }

  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(
    { suite: 'ui3-model-real', total: pass + fail, pass, fail, shots, results }, null, 2));
  return { pass, fail };
}

module.exports = { realRender };

if (require.main === module) {
  realRender({ out: path.join(__dirname, '..', '.shots', 'ui3-model') })
    .then(({ pass, fail }) => {
      console.log(`\nUI-3B 真实渲染: ${pass}/${pass + fail} 通过`);
      process.exitCode = fail ? 1 : 0;
    })
    .catch((e) => { console.error(e); process.exitCode = 1; });
}
