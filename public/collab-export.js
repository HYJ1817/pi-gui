// 协同流程图导出模块（Z4-4A 任务 C）。
// 纯客户端模块：只把 Z4-2 文档渲染为自包含 SVG 字符串 / PNG 位图数据，
// 无 IO、无网络、无定时器 —— 不上传、不写项目源码、不修改协同文档；
// 导出只能由用户主动触发（上层 adapter 在点击时调用，本模块不自行启动）。
//
// 安全生成方式：SVG 通过固定标签白名单的元素树结构化序列化，
// 用户文本（节点/连线文字）只进入文本节点与属性值，一律经 XML 转义，
// 绝不把未转义文本拼接进标记；产物不含 script、事件处理器属性与任何外部资源引用，
// 也不执行模型提供的 HTML/JavaScript（文档里只有纯文本 label，见 Z4-2 契约）。
//
// PNG 光栅化依赖浏览器 canvas 能力：renderer 可注入（测试注入假 renderer），
// 默认 renderer 在无 DOM 环境返回 renderer-unavailable；正式 Electron 验证留待 Z4-4B。

const SVG_NS = 'http://www.w3.org/2000/svg';
const WIDTH = 156, HEIGHT = 64; // 与 collab-canvas.js 渲染尺寸一致
const FONT_STACK = "system-ui, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif";

// 主题取自 collab.css 的 token fallback 值；transparent 不画背景矩形。
export const EXPORT_THEMES = Object.freeze({
  light: Object.freeze({
    background: '#ffffff', nodeFill: '#f7f7f5', nodeStroke: '#7b7971',
    text: '#1f1f1e', edge: '#6f6e66', edgeHalo: '#ffffff',
  }),
  dark: Object.freeze({
    background: '#151515', nodeFill: '#1a1a19', nodeStroke: '#7b7971',
    text: '#f0efec', edge: '#c3c2b7', edgeHalo: '#151515',
  }),
  transparent: Object.freeze({
    background: null, nodeFill: '#f7f7f5', nodeStroke: '#7b7971',
    text: '#1f1f1e', edge: '#6f6e66', edgeHalo: null,
  }),
});

const fail = (code, detail) => ({ ok: false, code, detail });

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const validId = value => typeof value === 'string' && ID_RE.test(value);
const validLabel = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const validCoord = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000;

/** 投影层校验（与 collab-canvas.validGraph 同规则）：非法文档拒绝导出。 */
function validateDocumentInput(document) {
  if (!document || !validId(document.documentId) || document.schemaVersion !== 1 ||
      !Number.isSafeInteger(document.revision) || document.revision < 1) return '文档信封非法';
  const graph = document.graph;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) ||
      graph.nodes.length > 200 || graph.edges.length > 400) return 'graph 超界或形状非法';
  const ids = new Set(), endpoints = new Set();
  for (const node of graph.nodes) {
    if (!node || !validId(node.id) || ids.has(node.id) || !validLabel(node.label) ||
        !validCoord(node.x) || !validCoord(node.y)) return `节点 ${String(node?.id)} 非法`;
    ids.add(node.id);
  }
  for (const edge of graph.edges) {
    if (!edge || !validId(edge.id) || ids.has(edge.id) || !ids.has(edge.from) || !ids.has(edge.to) ||
        edge.from === edge.to || (edge.label !== undefined && !validLabel(edge.label))) return `连线 ${String(edge?.id)} 非法`;
    const pair = `${edge.from}->${edge.to}`;
    if (endpoints.has(pair)) return `连线 ${edge.from}->${edge.to} 同向重复`;
    ids.add(edge.id); endpoints.add(pair);
  }
  return null;
}

// --- 结构化 SVG 生成：元素树 + 序列化，用户文本只经 text()/属性转义进入 ---

const XML_TEXT = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const XML_ATTR = { ...XML_TEXT, '"': '&quot;', "'": '&#39;' };
const escapeText = value => String(value).replace(/[&<>]/g, ch => XML_TEXT[ch]);
const escapeAttr = value => String(value).replace(/[&<>"']/g, ch => XML_ATTR[ch]);
const number = value => {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
};

const element = (tag, attrs = {}, children = []) => ({ tag, attrs, children });
const text = value => ({ text: String(value) });

const ALLOWED_TAGS = new Set(['svg', 'title', 'defs', 'marker', 'path', 'g', 'rect', 'line', 'text', 'tspan']);

function serializeElement(node, indent) {
  if ('text' in node) return `${indent}${escapeText(node.text)}`;
  if (!ALLOWED_TAGS.has(node.tag)) throw new Error(`export: 禁止生成标签 <${node.tag}>`);
  const attrs = Object.entries(node.attrs)
    .map(([key, value]) => `${key}="${escapeAttr(value)}"`).join(' ');
  const open = attrs ? `<${node.tag} ${attrs}>` : `<${node.tag}>`;
  if (!node.children.length) return `${indent}${open.replace('>', ' />')}`;
  const inner = node.children.map(child => serializeElement(child, `${indent}  `)).join('\n');
  return `${indent}${open}\n${inner}\n${indent}</${node.tag}>`;
}

/** 与 collab-canvas 相同的连线端点计算（从节点边框内缩，避免压住节点）。 */
function edgePoints(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const ratio = Math.min(dx ? WIDTH / 2 / Math.abs(dx) : Infinity, dy ? HEIGHT / 2 / Math.abs(dy) : Infinity, 0.49);
  return { x1: from.x + WIDTH / 2 + dx * ratio, y1: from.y + HEIGHT / 2 + dy * ratio,
    x2: to.x + WIDTH / 2 - dx * ratio, y2: to.y + HEIGHT / 2 - dy * ratio };
}

/** 与 collab-canvas 相同的节点文字折行：每行 11 字符、最多 2 行、超出加省略号。 */
function wrapLabel(label) {
  const characters = Array.from(label), lines = [];
  for (let i = 0; i < Math.min(characters.length, 22); i += 11) lines.push(characters.slice(i, i + 11).join(''));
  if (characters.length > 22) lines[1] = `${lines[1].slice(0, -1)}…`;
  return lines;
}

/**
 * 生成自包含 SVG。返回 { ok:true, svg, width, height } 或 { ok:false, code, detail }。
 * options: { theme:'light'|'dark'|'transparent', padding (默认 48，夹在 [16,240]) }
 */
export function buildFlowchartSvg(document, options = {}) {
  const invalid = validateDocumentInput(document);
  if (invalid) return fail('invalid-document', invalid);
  const nodes = document.graph.nodes;
  if (!nodes.length) return fail('empty-graph', '画布为空，没有可导出的内容');

  const themeName = EXPORT_THEMES[options.theme] ? options.theme : 'light';
  const theme = EXPORT_THEMES[themeName];
  const padding = Number.isFinite(options.padding) ? Math.min(240, Math.max(16, options.padding)) : 48;

  const minX = Math.min(...nodes.map(node => node.x)), minY = Math.min(...nodes.map(node => node.y));
  const maxX = Math.max(...nodes.map(node => node.x)) + WIDTH, maxY = Math.max(...nodes.map(node => node.y)) + HEIGHT;
  const width = maxX - minX + padding * 2, height = maxY - minY + padding * 2;
  const shift = point => ({ x: point.x - minX + padding, y: point.y - minY + padding });
  const byId = new Map(nodes.map(node => [node.id, node]));

  const children = [element('title', {}, [text(document.title || document.documentId)])];
  if (theme.background !== null) {
    children.push(element('rect', { x: '0', y: '0', width: number(width), height: number(height), fill: theme.background }));
  }
  const defs = element('defs', {}, [
    element('marker', { id: 'export-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5',
      markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse', fill: theme.edge }, [
      element('path', { d: 'M 0 0 L 10 5 L 0 10 z' }),
    ]),
  ]);
  const edgesGroup = element('g', { stroke: theme.edge, 'stroke-width': '1.5', fill: 'none' }, []);
  for (const edge of document.graph.edges) {
    const from = shift(byId.get(edge.from)), to = shift(byId.get(edge.to));
    const points = edgePoints(from, to);
    const group = element('g', {}, [
      element('line', { x1: number(points.x1), y1: number(points.y1), x2: number(points.x2), y2: number(points.y2), 'marker-end': 'url(#export-arrow)' }),
      element('title', {}, [text(edge.label || `${edge.from} → ${edge.to}`)]),
    ]);
    if (edge.label) {
      const labelAttrs = { x: number((points.x1 + points.x2) / 2), y: number((points.y1 + points.y2) / 2 - 8),
        'text-anchor': 'middle', 'font-size': '12', fill: theme.text, stroke: 'none' };
      if (theme.edgeHalo !== null) {
        // 与画布一致的描边衬底，保证连线文字在交叉处可读
        labelAttrs['paint-order'] = 'stroke';
        labelAttrs.stroke = theme.edgeHalo;
        labelAttrs['stroke-width'] = '4';
        labelAttrs['stroke-linejoin'] = 'round';
      }
      group.children.push(element('text', labelAttrs, [text(edge.label.length > 24 ? `${edge.label.slice(0, 23)}…` : edge.label)]));
    }
    edgesGroup.children.push(group);
  }
  const nodesGroup = element('g', { 'font-family': FONT_STACK }, []);
  for (const node of nodes) {
    const at = shift(node);
    const group = element('g', {}, [
      element('rect', { x: number(at.x), y: number(at.y), width: String(WIDTH), height: String(HEIGHT), rx: '7',
        fill: theme.nodeFill, stroke: theme.nodeStroke, 'stroke-width': '1.5' }),
      element('title', {}, [text(node.label)]),
    ]);
    const textElement = element('text', { x: number(at.x + WIDTH / 2), y: number(at.y + 26),
      'text-anchor': 'middle', 'font-size': '12', fill: theme.text, stroke: 'none' }, []);
    wrapLabel(node.label).forEach((line, index) => {
      textElement.children.push(element('tspan', { x: number(at.x + WIDTH / 2), dy: index ? '18' : '0' }, [text(line)]));
    });
    group.children.push(textElement);
    nodesGroup.children.push(group);
  }
  children.push(defs, edgesGroup, nodesGroup);

  const root = element('svg', {
    xmlns: SVG_NS, width: number(width), height: number(height),
    viewBox: `0 0 ${number(width)} ${number(height)}`, role: 'img',
    'aria-label': `流程图导出：${nodes.length} 个节点`,
  }, children);

  try {
    return { ok: true, svg: serializeElement(root, ''), width: Math.round(width), height: Math.round(height), theme: themeName };
  } catch (error) {
    return fail('serialize-failed', String(error?.message || error));
  }
}

/** 浏览器默认 PNG renderer：SVG → Image → canvas → PNG dataUrl。无 DOM 环境返回不可用。 */
async function browserPngRenderer(svg, { width, height, scale }) {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') {
    return fail('renderer-unavailable', '当前环境没有浏览器 canvas 能力；PNG 导出需要注入 renderer 或在 Electron 中运行（Z4-4B 接入）');
  }
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('png-render-failed'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) {
      return fail('png-render-failed', 'canvas 未产出 PNG 数据');
    }
    return { ok: true, dataUrl, width: canvas.width, height: canvas.height };
  } catch (error) {
    return fail('png-render-failed', String(error?.message || error));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 用户触发的导出入口。format 'svg' | 'png'。
 * confirm 为可选的用户确认钩子（返回 false 视为取消导出）：取消时不调用 renderer、不产出数据。
 * PNG 需要浏览器能力：renderer 可注入（测试），默认 renderer 在无 DOM 环境显式失败。
 * 返回 { ok:true, status:'exported'|'cancelled', format, ...产物 } 或 { ok:false, code, detail }。
 */
export async function exportFlowchart(document, {
  format = 'svg', theme = 'light', padding, scale = 2, renderer, confirm,
} = {}) {
  const kinds = ['svg', 'png'];
  if (!kinds.includes(format)) return fail('schema', `不支持的导出格式 ${String(format)}`);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 8) return fail('schema', 'scale 必须在 (0, 8] 内');
  const built = buildFlowchartSvg(document, { theme, padding });
  if (!built.ok) return built;

  if (typeof confirm === 'function') {
    let accepted;
    try { accepted = await confirm({ format, theme, width: built.width, height: built.height }); }
    catch { return fail('confirm-failed', '导出确认失败'); }
    if (accepted !== true) return { ok: true, status: 'cancelled', format, produced: false };
  }

  if (format === 'svg') {
    return { ok: true, status: 'exported', format, svg: built.svg, width: built.width, height: built.height, theme: built.theme };
  }
  const render = typeof renderer === 'function' ? renderer : browserPngRenderer;
  let image;
  try { image = await render(built.svg, { width: built.width, height: built.height, scale }); }
  catch (error) { return fail('png-render-failed', String(error?.message || error)); }
  if (!image || image.ok !== true) return image || fail('png-render-failed', 'renderer 未返回结果');
  return { ok: true, status: 'exported', format: 'png', svg: built.svg, image, width: image.width ?? built.width, height: image.height ?? built.height };
}
