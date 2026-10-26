/* Z4-4A 任务 D：流程图导出组件测试。
 * 覆盖任务清单 15（长文本与中文）、16（SVG 安全转义）、18（用户取消导出），
 * 以及主题背景、视图边界与留白、外部资源/脚本禁入、PNG 注入 renderer、
 * 空图与非法文档拒绝导出等性质。结构化安全断言用 jsdom DOMParser 解析产物，
 * 而非朴素子串扫描（转义后的文本内容本就可能包含 onerror= 等字样）。
 * 直接运行：node tests/collab-export.cjs（未并入 canonical 测试链）。
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

const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
const { DOMParser } = dom.window;

const hostile = 'label <img src=x onerror=alert(1)> & "引号" \'单引号\' </text><script>alert(2)</script>';
const doc = (nodes, edges, extra = {}) => ({
  documentId: 'doc-1', schemaVersion: 1, revision: 2, title: '发布流程', boundSessionId: 's1',
  graph: { nodes, edges }, appliedOps: [], ...extra,
});
const n = (id, label, x = 0, y = 0) => ({ id, label, x, y });
const e = (id, from, to, label) => (label === undefined ? { id, from, to } : { id, from, to, label });

/** 结构化解析产物：合法 XML、无 script/foreignObject、无 on* 事件属性、无外部资源引用。 */
function parseStrict(svg) {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const errors = parsed.getElementsByTagName('parsererror');
  if (errors.length) return { error: errors[0].textContent };
  const all = [...parsed.getElementsByTagName('*')];
  const bannedTags = all.filter(el => ['script', 'foreignObject', 'iframe', 'use', 'image'].includes(el.tagName.includes(':') ? el.tagName.split(':').pop() : el.tagName));
  if (bannedTags.length) return { error: `禁入标签：${bannedTags.map(el => el.tagName).join(',')}` };
  const eventAttrs = all.flatMap(el => [...el.attributes].filter(attr => /^on/i.test(attr.name) || /^(href|xlink:href|src|data)$/i.test(attr.name)));
  if (eventAttrs.length) return { error: `事件/资源属性：${eventAttrs.map(attr => attr.name).join(',')}` };
  return { document: parsed };
}

async function main() {
  const { buildFlowchartSvg, exportFlowchart, EXPORT_THEMES } = await import('../public/collab-export.js');
  check('主题闭集', Object.keys(EXPORT_THEMES).sort(), ['dark', 'light', 'transparent']);

  const sample = doc(
    [n('n1', hostile), n('n2', '构建与发布', 250, 0), n('n3', '结束', 500, 40)],
    [e('e1', 'n1', 'n2', hostile), e('e2', 'n2', 'n3')]);

  // 15. 长文本和中文：中文原样保留、长文本按画布规则折行（每行 11 字、最多 2 行、省略号）
  const longLabel = '协同流程图自动布局引擎测试长标签'.repeat(9); // 117 字符
  const withLong = doc([n('n1', longLabel, 0, 0), n('n2', '短标签', 300, 0)], [e('e1', 'n1', 'n2', longLabel)]);
  const longSvg = buildFlowchartSvg(withLong, { theme: 'light' });
  check('长文本导出成功', longSvg.ok);
  const longParsed = parseStrict(longSvg.svg);
  check('长文本产物是合法 XML', !longParsed.error, true);
  const nodeTexts = [...longParsed.document.getElementsByTagName('text')].filter(el => el.getElementsByTagName('tspan').length);
  const tspans = nodeTexts.flatMap(el => [...el.getElementsByTagName('tspan')]);
  check('每个节点文字最多两行', nodeTexts.every(el => el.getElementsByTagName('tspan').length <= 2), true);
  check('长标签节点恰为两行', nodeTexts.map(el => el.getElementsByTagName('tspan').length).sort(), [1, 2]);
  check('第二行以省略号结尾', tspans[1].textContent.endsWith('…'), true);
  check('折行不超过每行 11 字符', tspans.every(span => Array.from(span.textContent).length <= 11), true);
  const edgeTexts = [...longParsed.document.getElementsByTagName('text')]
    .filter(el => el.parentElement.tagName !== 'title' && !el.getElementsByTagName('tspan').length && el.getAttribute('x') !== null && el.textContent.length > 10);
  check('连线长文字截断到 24 字符内', edgeTexts.every(el => Array.from(el.textContent).length <= 24), true);
  check('中文完整保留', longSvg.svg.includes('协同流程图自动布局引擎测试长标签'.slice(0, 11)), true);

  // 16. SVG 安全转义：恶意文本全部以纯文本形式出现在产物中
  const built = buildFlowchartSvg(sample, { theme: 'dark' });
  check('含敌意文本的文档导出成功', built.ok);
  const parsed = parseStrict(built.svg);
  check('产物是合法 XML', !parsed.error, true);
  check('产物无脚本与事件属性', parsed.error === undefined, true);
  check('敌意标签被转义为文本', built.svg.includes('&lt;img src=x onerror=alert(1)&gt;'), true);
  check('敌意闭合标签被转义', built.svg.includes('&lt;/text&gt;&lt;script&gt;alert(2)&lt;/script&gt;'), true);
  const titleTexts = [...parsed.document.getElementsByTagName('title')].map(el => el.textContent);
  check('节点 title 完整保留敌意文本', titleTexts.includes(hostile), true);
  check('连线 title 完整保留敌意文本', titleTexts.includes(hostile), true);
  const withoutNamespace = built.svg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '');
  const externalRefs = withoutNamespace.match(/@import|url\((?!#)|https?:\/\//g);
  check('无外部样式或字体引用', externalRefs, null);
  check('只使用系统字体栈', built.svg.includes('system-ui'), true);

  // 视图边界与留白：包围盒 + padding，节点/连线全部落在画布内
  check('尺寸包含默认留白', [built.width, built.height], [500 + 156 + 48 * 2, 40 + 64 + 48 * 2]);
  const tight = buildFlowchartSvg(sample, { padding: 16 });
  check('留白选项生效', tight.width, built.width - 64);
  const parsedTight = parseStrict(tight.svg);
  const rects = [...parsedTight.document.getElementsByTagName('rect')].filter(el => el.getAttribute('width') === '156');
  const inBounds = rects.every(el => Number(el.getAttribute('x')) >= 16 - 1 && Number(el.getAttribute('y')) >= 16 - 1 &&
    Number(el.getAttribute('x')) + 156 <= tight.width - 16 + 1 && Number(el.getAttribute('y')) + 64 <= tight.height - 16 + 1);
  check('所有节点都在画布边界内', inBounds, true);
  check('viewBox 与尺寸一致', tight.svg.includes(`viewBox="0 0 ${tight.width} ${tight.height}"`), true);

  // 主题背景
  const light = buildFlowchartSvg(sample, { theme: 'light' });
  check('浅色主题背景', light.svg.includes('fill="#ffffff"'), true);
  check('深色主题背景', built.svg.includes('fill="#151515"'), true);
  const transparent = buildFlowchartSvg(sample, { theme: 'transparent' });
  check('透明主题不画背景矩形', /<rect x="0" y="0"/.test(transparent.svg), false);
  check('未知主题回落浅色', buildFlowchartSvg(sample, { theme: 'neon' }).theme, 'light');

  // 18. 用户取消导出：confirm 钩子拒绝时不调用 renderer、不产出数据
  const rendererCalls = [];
  const fakeRenderer = async (svg, options) => {
    rendererCalls.push({ width: options.width, height: options.height, scale: options.scale });
    return { ok: true, dataUrl: `data:image/png;base64,${'A'.repeat(32)}`, width: options.width * options.scale, height: options.height * options.scale };
  };
  const cancelled = await exportFlowchart(sample, { format: 'png', renderer: fakeRenderer, confirm: () => false });
  check('取消导出返回 cancelled', [cancelled.ok, cancelled.status, cancelled.produced], [true, 'cancelled', false]);
  check('取消时不调用 renderer', rendererCalls.length, 0);
  check('取消不产出图像', 'image' in cancelled, false);
  const svgCancelled = await exportFlowchart(sample, { format: 'svg', confirm: () => false });
  check('SVG 导出同样尊重取消', [svgCancelled.status, svgCancelled.svg], ['cancelled', undefined]);

  // 确认后 PNG：renderer 收到 SVG 与正确尺寸，结果原样透出
  const png = await exportFlowchart(sample, { format: 'png', renderer: fakeRenderer, confirm: () => true, scale: 2 });
  check('确认后 PNG 导出成功', [png.ok, png.status, png.format], [true, 'exported', 'png']);
  check('renderer 恰好调用一次', rendererCalls.length, 1);
  check('renderer 收到画布尺寸', [rendererCalls[0].width, rendererCalls[0].height], [built.width, built.height]);
  check('PNG 尺寸按 scale 放大', [png.width, png.height], [built.width * 2, built.height * 2]);
  check('PNG 数据透传', png.image.dataUrl.startsWith('data:image/png;base64,'), true);
  check('PNG 路径同样包含安全 SVG', parseStrict(png.svg).error === undefined, true);

  // SVG 直出
  const svgExport = await exportFlowchart(sample, { format: 'svg', theme: 'transparent' });
  check('SVG 导出成功', [svgExport.ok, svgExport.status], [true, 'exported']);
  check('SVG 产物与直构一致', svgExport.svg, buildFlowchartSvg(sample, { theme: 'transparent' }).svg);

  // renderer 故障与缺失：显式失败码，不吞错
  const failing = await exportFlowchart(sample, { format: 'png', renderer: async () => ({ ok: false, code: 'boom' }) });
  check('renderer 失败原样透出', [failing.ok, failing.code], [false, 'boom']);
  const throwing = await exportFlowchart(sample, { format: 'png', renderer: async () => { throw new Error('explode'); } });
  check('renderer 抛错转为显式失败', [throwing.ok, throwing.code], [false, 'png-render-failed']);
  const noRenderer = await exportFlowchart(sample, { format: 'png' });
  check('Node 环境无浏览器能力显式失败', [noRenderer.ok, noRenderer.code], [false, 'renderer-unavailable']);

  // 入口约束：格式闭集、scale 边界、空图、非法文档
  check('不支持格式拒绝', (await exportFlowchart(sample, { format: 'gif' })).code, 'schema');
  check('scale 越界拒绝', (await exportFlowchart(sample, { format: 'png', scale: 9 })).code, 'schema');
  check('空图拒绝导出', buildFlowchartSvg(doc([], [])).code, 'empty-graph');
  check('非法文档拒绝导出', buildFlowchartSvg(doc([n('a', 'x', NaN, 0)], [])).code, 'invalid-document');
  check('引用缺失节点的边拒绝导出', buildFlowchartSvg(doc([n('a', 'x')], [e('e1', 'a', 'ghost')])).code, 'invalid-document');
  check('导出不修改输入文档', (() => { const before = JSON.stringify(sample); buildFlowchartSvg(sample); exportFlowchart(sample, { format: 'svg' }); return JSON.stringify(sample) === before; })(), true);

  // 同一输入导出结果确定
  check('SVG 导出确定性', buildFlowchartSvg(sample, { theme: 'dark' }).svg, built.svg);

  console.log(`\ncollab-export: ${checks}/${checks} passed; assertions=${assertions}`);
  dom.window.close();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
