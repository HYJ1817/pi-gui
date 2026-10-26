/* Z4-4A 任务 E：生产力工具条 adapter 原型组件测试（jsdom）。
 * 验证：与画布同方言只发意图、预览期间零提交、取消零提交、over-limit 明确状态、
 * 文档更新作废预览、导出经 onExport 交给宿主、用户取消导出无产物、只读/忙碌禁用、
 * destroy 清理。直接运行：node tests/collab-productivity.cjs（未并入 canonical 测试链）。
 */
const baseAssert = require('node:assert/strict');
let assertions = 0;
const assert = new Proxy(baseAssert, {
  apply(target, receiver, args) { assertions++; return Reflect.apply(target, receiver, args); },
  get(target, key) { const value = target[key]; return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value; },
});

let checks = 0;
function check(name, actual, expected = true) {
  assert.deepEqual(actual, expected, name);
  checks++;
  console.log(`  ok ${name}`);
}

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

async function main() {
  const { mountCollabProductivity } = await import('../public/collab-canvas-productivity.js');
  const { createFlowchartDocument, applyOperations } = await import('../lib/collab-doc.js');
  const dom = new JSDOM('<main><div id="host"></div></main>');
  const win = dom.window;
  const style = win.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../public/collab-productivity.css'), 'utf8');
  win.document.head.append(style);
  const host = win.document.querySelector('#host');
  const q = selector => host.querySelector(selector);
  const button = name => [...host.querySelectorAll('button')].find(el => el.textContent === name);
  const fire = (el, type = 'click') => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true }));

  // 准备凌乱文档（复用任务 B 的构造方式）
  const seed = createFlowchartDocument({ documentId: 'doc-1' });
  const messy = applyOperations(seed, [
    { opId: 'scatter-1', type: 'node.update', baseRevision: seed.revision, actor: 'user', params: { id: 'n1', x: 8100, y: -4200 } },
    { opId: 'scatter-2', type: 'node.update', baseRevision: seed.revision, actor: 'user', params: { id: 'n3', x: -9100, y: 7600 } },
  ]).doc;
  const frozen = JSON.stringify(messy);

  const operations = [], exports = [], notices = [];
  const bar = mountCollabProductivity(host, {
    document: messy,
    onOperations: ops => operations.push(ops),
    onExport: result => exports.push(result),
    onNotice: notice => notices.push(notice),
  });
  check('正式工具条标题可见', host.textContent.includes('自动整理与导出'), true);
  check('三个操作按钮', ['自动整理', '导出 SVG', '导出 PNG'].every(name => !!button(name)), true);
  check('布局方向默认从左到右', q('[name="layoutDirection"]').value, 'LR');
  check('导出背景默认浅色', q('[name="exportTheme"]').value, 'light');
  check('初始不显示预览', q('.collab-prod-preview').hidden, true);

  // 自动整理：预览期间零提交
  fire(button('自动整理'));
  check('点击整理出现预览', q('.collab-prod-preview').hidden, false);
  check('预览文案含移动数与版本', q('.collab-prod-preview p').textContent.includes('将移动 3 个节点') && q('.collab-prod-preview p').textContent.includes(`版本 ${messy.revision}`), true);
  check('预览期间不保存（零操作）', operations.length, 0);
  check('预览期间文档不变', JSON.stringify(messy), frozen);

  // 取消预览：零提交、文档不变
  fire(button('取消预览'));
  check('取消隐藏预览', q('.collab-prod-preview').hidden, true);
  check('取消零提交', operations.length, 0);
  check('取消后文档不变', JSON.stringify(messy), frozen);
  check('取消通知', notices.some(item => item.message.includes('取消自动整理')), true);

  // 确认应用：只发意图方言 [{type,params}]
  fire(button('自动整理'));
  fire(button('确认应用布局'));
  check('确认提交一次意图', operations.length, 1);
  check('意图为画布方言（只有 type 与 params）', operations[0].every(op => JSON.stringify(Object.keys(op).sort()) === '["params","type"]'), true);
  check('意图全部为 node.update', operations[0].every(op => op.type === 'node.update'), true);
  check('意图数量与预览一致', operations[0].length, 3);
  check('提交后文档对象仍不变（意图交由上层）', JSON.stringify(messy), frozen);
  check('提交后预览关闭', q('.collab-prod-preview').hidden, true);

  // 预览作废：文档 revision 前进后，残留确认点击不产生提交
  // （adapter 在 update 时作废并隐藏预览；stale 应用防御已在 collab-layout-preview 套件覆盖）
  fire(button('自动整理'));
  const bumped = { ...messy, revision: messy.revision + 1 };
  bar.update({ document: bumped });
  check('文档更新隐藏预览', q('.collab-prod-preview').hidden, true);
  check('文档更新通知作废', notices.some(item => item.message.includes('预览已作废')), true);
  fire(button('确认应用布局'));
  check('作废后确认零提交', operations.length, 1);

  // over-limit：明确状态、确认按钮禁用、零提交
  let working = createFlowchartDocument({ documentId: 'doc-big' });
  const chunk = (items, prefix) => {
    for (let start = 0; start < items.length; start += 40) {
      const ops = items.slice(start, start + 40).map((params, index) => ({
        opId: `${prefix}-${start + index}`, type: params.op, baseRevision: working.revision, actor: 'user', params: params.data,
      }));
      working = applyOperations(working, ops).doc;
    }
  };
  chunk([...Array.from({ length: 60 }, (_, i) => ({ op: 'node.add', data: { id: `b${String(i).padStart(2, '0')}`, label: `节点${i}`, x: (i * 613) % 9000, y: (i * 197) % 9000 } })),
    ...Array.from({ length: 59 }, (_, i) => ({ op: 'edge.add', data: { id: `x${String(i).padStart(2, '0')}`, from: `b${String(i).padStart(2, '0')}`, to: `b${String(i + 1).padStart(2, '0')}` } }))], 'big');
  bar.update({ document: working });
  fire(button('自动整理'));
  check('over-limit 显示明确状态', q('.collab-prod-preview p').textContent.includes('超过单批 50 条操作上限'), true);
  check('over-limit 禁用确认', button('确认应用布局').disabled, true);
  fire(button('取消预览'));
  check('over-limit 全程零提交', operations.length, 1);

  // 导出 SVG：产物经 onExport 交给宿主，包含节点文字
  bar.update({ document: messy });
  fire(button('导出 SVG'));
  await new Promise(resolve => setImmediate(resolve));
  check('SVG 导出经 onExport', exports.length, 1);
  check('SVG 导出格式', [exports[0].format, exports[0].status], ['svg', 'exported']);
  check('SVG 产物包含节点文字', exports[0].svg.includes('开始'), true);
  check('SVG 导出不改文档', JSON.stringify(messy), frozen);

  // 布局方向选择器：TB 生成纵向意图（同列 x、递增 y）
  q('[name="layoutDirection"]').value = 'TB';
  fire(button('自动整理'));
  fire(button('确认应用布局'));
  const tbIntents = operations.at(-1);
  check('TB 方向意图生效（同列递增）',
    tbIntents.length === 3 && new Set(tbIntents.map(op => op.params.x)).size === 1 &&
    tbIntents.every((op, index) => index === 0 || op.params.y > tbIntents[index - 1].params.y), true);
  q('[name="layoutDirection"]').value = 'LR';

  // 导出主题选择器：深色背景进入产物
  q('[name="exportTheme"]').value = 'dark';
  fire(button('导出 SVG'));
  await new Promise(resolve => setImmediate(resolve));
  check('主题选择器深色背景生效', exports[1].svg.includes('fill="#151515"'), true);
  q('[name="exportTheme"]').value = 'light';

  // 导出 PNG：注入 renderer（exportOptions 透传），产物透出
  const rendererCalls = [];
  const fakeRenderer = async (svg, options) => {
    rendererCalls.push(options.scale);
    return { ok: true, dataUrl: 'data:image/png;base64,QUJD', width: options.width * options.scale, height: options.height * options.scale };
  };
  bar.destroy();
  const bar2 = mountCollabProductivity(host, {
    document: messy,
    onOperations: ops => operations.push(ops),
    onExport: result => exports.push(result),
    onNotice: () => {},
    exportOptions: { theme: 'dark', renderer: fakeRenderer, scale: 3 },
    confirmExport: () => false,
  });
  fire([...host.querySelectorAll('button')].find(el => el.textContent === '导出 PNG'));
  await new Promise(resolve => setImmediate(resolve));
  check('用户取消导出无产物', [exports.length, rendererCalls.length], [2, 0]);
  bar2.destroy();
  // Renderer forwarding uses a rasterizable graph; the scattered graph above
  // exceeds the production allocation budget at scale=3.
  const bar3 = mountCollabProductivity(host, {
    document: seed, onExport: result => exports.push(result), onNotice: () => {},
    exportOptions: { renderer: fakeRenderer, scale: 3 }, confirmExport: () => true,
  });
  fire([...host.querySelectorAll('button')].find(el => el.textContent === '导出 PNG'));
  await new Promise(resolve => setImmediate(resolve));
  check('确认后 PNG 透出', [exports.length, exports[2].format, exports[2].image.dataUrl], [3, 'png', 'data:image/png;base64,QUJD']);
  check('renderer 收到注入的 scale', rendererCalls, [3]);
  bar3.update({ document: messy });
  fire([...host.querySelectorAll('button')].find(el => el.textContent === '导出 PNG'));
  await new Promise(resolve => setImmediate(resolve));
  check('超大 PNG 不调用 renderer 且不产出部分导出', [exports.length, rendererCalls.length], [3, 1]);

  // 只读与忙碌禁用
  bar3.update({ readOnly: true });
  check('只读禁用自动整理', [...host.querySelectorAll('button')].find(el => el.textContent === '自动整理').disabled, true);
  bar3.update({ readOnly: false, busy: true });
  check('忙碌禁用导出', [...host.querySelectorAll('button')].find(el => el.textContent === '导出 SVG').disabled, true);
  bar3.update({ busy: false });
  check('恢复后可用', [...host.querySelectorAll('button')].find(el => el.textContent === '自动整理').disabled, false);
  bar3.destroy();

  // —— 修复回归 1：onOperations 拒收（返回 false）时不得显示成功或丢弃预览 ——
  const rejectedOps = [];
  const rejectionNotices = [];
  const bar4 = mountCollabProductivity(host, {
    document: messy,
    onOperations: ops => { rejectedOps.push(ops); return false; },
    onExport: () => {}, onNotice: notice => rejectionNotices.push(notice),
  });
  fire(button('自动整理'));
  fire(button('确认应用布局'));
  check('拒收后预览保留', q('.collab-prod-preview').hidden, false);
  check('拒收后零成功提示', rejectionNotices.some(notice => notice.message.includes('已提交')), false);
  check('拒收给出保留原因', rejectionNotices.some(notice => notice.level === 'warn' && notice.message.includes('预览已保留')), true);
  check('拒收时回调仍收到一次意图', rejectedOps.length, 1);
  fire(button('取消预览'));

  // —— 修复回归 1：busy / 只读期间确认必须禁用且点击零提交 ——
  fire(button('自动整理'));
  bar4.update({ busy: true });
  check('busy 期间确认禁用', button('确认应用布局').disabled, true);
  check('busy 期间取消仍可用', button('取消预览').disabled, false);
  fire(button('确认应用布局'));
  check('busy 期间点击确认零提交', rejectedOps.length, 1);
  bar4.update({ busy: false });
  check('解除 busy 后确认恢复', button('确认应用布局').disabled, false);
  bar4.update({ readOnly: true });
  check('只读时确认禁用', button('确认应用布局').disabled, true);
  fire(button('确认应用布局'));
  check('只读点击确认零提交', rejectedOps.length, 1);
  bar4.update({ readOnly: false });
  fire(button('取消预览'));

  // —— 修复回归 4：只读图形预览（节点 + 连线），取消/版本变化/销毁时清理 ——
  fire(button('自动整理'));
  const previewSvg = q('.collab-prod-preview svg');
  check('预览包含只读 SVG', !!previewSvg, true);
  check('预览 SVG 节点数与文档一致', previewSvg.querySelectorAll('rect').length, 3);
  check('预览 SVG 连线数与文档一致', previewSvg.querySelectorAll('line').length, 2);
  check('预览 SVG 保留节点文字', previewSvg.textContent.includes('开始'), true);
  check('预览 SVG 无交互与脚本元素', previewSvg.querySelectorAll('button,input,select,script,[onclick]').length, 0);
  check('预览 SVG 有可访问角色', previewSvg.getAttribute('role'), 'img');
  fire(button('取消预览'));
  check('取消后预览 SVG 清理', q('.collab-prod-preview svg'), null);
  fire(button('自动整理'));
  bar4.update({ document: { ...messy, revision: messy.revision + 1 } });
  check('文档更新后预览 SVG 作废清理', q('.collab-prod-preview svg'), null);
  bar4.destroy();
  check('销毁后预览 DOM 清理', host.querySelectorAll('.collab-prod-preview svg').length, 0);

  // —— 修复回归 2：异步导出期间文档变化，结果与文件版本绑定开始时快照 ——
  let releaseRenderer;
  const lateRenderer = () => new Promise(resolve => { releaseRenderer = resolve; });
  const lateExports = [];
  const bar5 = mountCollabProductivity(host, {
    document: seed, onOperations: () => true,
    onExport: result => lateExports.push(result), onNotice: () => {},
    exportOptions: { renderer: lateRenderer },
  });
  fire(button('导出 PNG'));
  await new Promise(resolve => setImmediate(resolve));
  bar5.update({ document: { ...seed, revision: seed.revision + 5, title: '导出期间改掉的标题' } });
  releaseRenderer({ ok: true, dataUrl: 'data:image/png;base64,QUJD', width: 10, height: 10 });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  check('导出结果绑定开始时版本与标题', [lateExports[0].source.revision, lateExports[0].source.title], [seed.revision, seed.title]);
  check('导出内容来自开始时快照', lateExports[0].svg.includes('开始') && !lateExports[0].svg.includes('导出期间改掉的标题'), true);
  bar5.destroy();

  // destroy 清理
  check('destroy 清空 DOM', host.childNodes.length, 0);
  fire(win.document);
  check('destroy 后回调静默', [operations.length, exports.length], [2, 3]);

  dom.window.close();
  console.log(`\ncollab-productivity: ${checks}/${checks} passed; assertions=${assertions}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
