// 协同流程图自动布局引擎（Z4-4A 任务 A）。
// 纯算法模块：无 DOM、无 IO、无网络、不依赖 lib/ 与全局状态（与 collab-canvas 同边界）。
//
// 输入是 Z4-2 协同文档（graph 形状），输出为每个节点的建议坐标；
// 不修改传入文档，不生成操作，不触碰权威状态 —— 预览与提交见 collab-layout-preview.js。
//
// 算法为轻量 Sugiyama 分层布局（不引入布局框架）：
//   1. 按弱连通分量拆分（独立组件 / 孤立节点各自布局后网格打包）；
//   2. DFS 贪心去环（回边临时反向，仅用于计算，不改图语义）；
//   3. 最长路径分层（主轴 = 流向，默认从左到右）；
//   4. 中位数扫掠减少层内交叉（固定 4 轮，无随机源）；
//   5. 坐标分配：层内按前驱中位数对齐，最小间距强制保证不重叠；
//   6. 分量沿副轴网格打包，整体平移到正坐标原点。
//
// 确定性：所有遍历、排序与中位数计算都基于节点 ID 字典序，同样输入必然产生同样输出。
// 边界：坐标受 Z4-2 协议 ±100000 约束（见 lib/collab-doc.js LIMITS；本模块不依赖 lib，常量同步声明）。

export const AUTO_LAYOUT_LIMITS = Object.freeze({
  maxNodes: 200,
  maxEdges: 400,
  coordAbsMax: 100000,
});

// 与 collab-canvas.js 的节点渲染尺寸一致，保证建议坐标可直接被画布采用。
export const AUTO_LAYOUT_DEFAULTS = Object.freeze({
  direction: 'LR', // 'LR' 从左到右（默认）| 'TB' 从上到下
  nodeWidth: 156,
  nodeHeight: 64,
  layerGap: 96, // 相邻层中心距以外的净间隙（主轴）
  nodeGap: 36, // 同层相邻节点净间隙（副轴）
  componentGap: 72, // 独立分量之间的间隙
  margin: 40, // 画布留白起点
});

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const validId = value => typeof value === 'string' && ID_RE.test(value);
const validLabel = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const validCoord = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= AUTO_LAYOUT_LIMITS.coordAbsMax;

const fail = (code, detail) => ({ ok: false, code, detail });

/** 投影层校验（与 collab-canvas.validGraph 同规则）：非法图结构一律拒绝，不产出半套坐标。 */
function validateGraphInput(document) {
  if (!document || !validId(document.documentId) || document.schemaVersion !== 1 ||
      !Number.isSafeInteger(document.revision) || document.revision < 1) {
    return '文档信封非法（documentId / schemaVersion / revision）';
  }
  const graph = document.graph;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) ||
      graph.nodes.length > AUTO_LAYOUT_LIMITS.maxNodes || graph.edges.length > AUTO_LAYOUT_LIMITS.maxEdges) {
    return `graph 超界或形状非法（节点 ≤${AUTO_LAYOUT_LIMITS.maxNodes}，连线 ≤${AUTO_LAYOUT_LIMITS.maxEdges}）`;
  }
  const ids = new Set(), endpoints = new Set();
  for (const node of graph.nodes) {
    if (!node || !validId(node.id) || ids.has(node.id) || !validLabel(node.label) ||
        !validCoord(node.x) || !validCoord(node.y)) return `节点 ${String(node?.id)} 非法`;
    ids.add(node.id);
  }
  for (const edge of graph.edges) {
    if (!edge || !validId(edge.id) || ids.has(edge.id) || !ids.has(edge.from) || !ids.has(edge.to) ||
        edge.from === edge.to || (edge.label !== undefined && !validLabel(edge.label))) {
      return `连线 ${String(edge?.id)} 非法`;
    }
    const pair = `${edge.from}->${edge.to}`;
    if (endpoints.has(pair)) return `连线 ${edge.from}->${edge.to} 同向重复`;
    ids.add(edge.id); endpoints.add(pair);
  }
  return null;
}

/** 选项规整：方向闭集，间距夹在安全区间内，防止极端选项把坐标推出协议边界。 */
function normalizeOptions(options) {
  const merged = { ...AUTO_LAYOUT_DEFAULTS, ...(options && typeof options === 'object' ? options : {}) };
  const clamp = (value, min, max, fallback) =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return {
    direction: merged.direction === 'TB' ? 'TB' : 'LR',
    nodeWidth: clamp(merged.nodeWidth, 24, 400, AUTO_LAYOUT_DEFAULTS.nodeWidth),
    nodeHeight: clamp(merged.nodeHeight, 16, 200, AUTO_LAYOUT_DEFAULTS.nodeHeight),
    layerGap: clamp(merged.layerGap, 8, 200, AUTO_LAYOUT_DEFAULTS.layerGap),
    nodeGap: clamp(merged.nodeGap, 8, 200, AUTO_LAYOUT_DEFAULTS.nodeGap),
    componentGap: clamp(merged.componentGap, 8, 200, AUTO_LAYOUT_DEFAULTS.componentGap),
    margin: clamp(merged.margin, 0, 200, AUTO_LAYOUT_DEFAULTS.margin),
  };
}

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** 弱连通分量：返回按最小节点 ID 排序的分量列表，分量内节点按 ID 排序。 */
function weakComponents(nodeIds, adjacency) {
  const seen = new Set(), components = [];
  for (const start of nodeIds) {
    if (seen.has(start)) continue;
    const component = [], queue = [start];
    seen.add(start);
    while (queue.length) {
      const id = queue.shift();
      component.push(id);
      for (const next of adjacency.get(id)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    component.sort(byId);
    components.push(component);
  }
  components.sort((a, b) => byId(a[0], b[0]));
  return components;
}

/**
 * DFS 贪心去环：发现回边时把该边在「布局用的无环定向 E'」中反向。
 * 只影响层序计算，不改变原文档的任何连线语义。
 */
function breakCycles(nodeIds, outEdges) {
  const orientation = new Map(); // `${from}->${to}` -> 'forward' | 'reversed'
  const state = new Map(); // 'white' | 'gray' | 'black'
  for (const id of nodeIds) state.set(id, 'white');
  const visit = id => {
    state.set(id, 'gray');
    for (const next of outEdges.get(id)) {
      const key = `${id}->${next}`;
      if (state.get(next) === 'gray') orientation.set(key, 'reversed'); // 回边：布局定向中反向
      else {
        if (state.get(next) === 'white') visit(next);
        orientation.set(key, 'forward');
      }
    }
    state.set(id, 'black');
  };
  for (const id of nodeIds) if (state.get(id) === 'white') visit(id);
  return orientation;
}

/**
 * 最长路径分层：E' 中 u→v ⇒ layer(v) ≥ layer(u)+1。
 * 返回 layers 数组（下标 = 层号，值为按 ID 排序的节点）与 layerOf 映射。
 */
function assignLayers(nodeIds, dagOut, dagIn) {
  const layerOf = new Map();
  const indegree = new Map();
  for (const id of nodeIds) { layerOf.set(id, 0); indegree.set(id, dagIn.get(id).length); }
  const queue = nodeIds.filter(id => indegree.get(id) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift(); // nodeIds 已排序且入度队列按入队序处理 ⇒ 确定性
    order.push(id);
    for (const next of dagOut.get(id)) {
      layerOf.set(next, Math.max(layerOf.get(next), layerOf.get(id) + 1));
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  // 去环后理应无剩余节点；防御性兜底（不无限等待）。
  const placed = new Set(order);
  for (const id of nodeIds) if (!placed.has(id)) layerOf.set(id, 0);
  const maxLayer = Math.max(0, ...nodeIds.map(id => layerOf.get(id)));
  const layers = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of nodeIds) layers[layerOf.get(id)].push(id);
  for (const layer of layers) layer.sort(byId);
  return { layers, layerOf };
}

/** 层内顺序的中位数扫掠：奇偶轮分别沿层号升 / 降，用相邻层邻居的当前序号做中位数重排。 */
function reduceCrossings(layers, dagOut, dagIn, sweeps = 4) {
  const orderIndex = new Map(); // 节点 -> 当前层内序号
  const refresh = () => layers.forEach(layer => layer.forEach((id, index) => orderIndex.set(id, index)));
  refresh();
  for (let sweep = 0; sweep < sweeps; sweep++) {
    const downward = sweep % 2 === 0;
    const sequence = downward ? layers : [...layers].reverse();
    for (const layer of sequence) {
      const scored = layer.map((id, index) => {
        const neighbors = (downward ? dagIn.get(id) : dagOut.get(id))
          .map(neighbor => orderIndex.get(neighbor))
          .filter(value => value !== undefined);
        const center = neighbors.length ? median(neighbors) : index; // 无邻居保持原位
        return { id, center };
      });
      scored.sort((a, b) => (a.center - b.center) || byId(a.id, b.id)); // 平局按 ID，保证稳定
      layer.splice(0, layer.length, ...scored.map(entry => entry.id));
      refresh();
    }
  }
  return layers;
}

/**
 * 副轴坐标分配：先按层内序号堆叠，再若干轮「邻居中位数对齐 + 最小间距强制」。
 * 最后一轮强制保证同层相邻间距 ≥ nodeGap，节点绝不重叠。
 */
function assignSecondary(layers, dagOut, dagIn, secondarySize, nodeGap, passes = 4) {
  const minGap = secondarySize + nodeGap;
  const position = new Map();
  for (const layer of layers) layer.forEach((id, index) => position.set(id, index * minGap));
  const desired = id => {
    const neighbors = [...dagIn.get(id), ...dagOut.get(id)]
      .map(neighbor => position.get(neighbor))
      .filter(value => value !== undefined);
    return neighbors.length ? median(neighbors) : position.get(id);
  };
  for (let pass = 0; pass < passes; pass++) {
    const downward = pass % 2 === 0;
    const sequence = downward ? layers : [...layers].reverse();
    for (const layer of sequence) {
      const centers = layer.map(id => desired(id));
      // 前向最小间距：保持层内顺序，推开重叠；期望值本身可左可右，无单向漂移。
      for (let i = 1; i < layer.length; i++)
        centers[i] = Math.max(centers[i], centers[i - 1] + minGap);
      layer.forEach((id, index) => position.set(id, Math.round(centers[index])));
    }
  }
  // 终局强制：round 可能损失 1px，重跑前向保证同层严格不重叠。
  for (const layer of layers) {
    for (let i = 1; i < layer.length; i++) {
      const id = layer[i], previous = layer[i - 1];
      if (position.get(id) < position.get(previous) + minGap) position.set(id, position.get(previous) + minGap);
    }
  }
  return position;
}

/** 单个连通分量的完整布局，返回主/副轴坐标（均为从 0 开始的相对坐标）。 */
function layoutComponent(component, originalEdges, options) {
  const nodeSet = new Set(component);
  const edges = originalEdges.filter(edge => nodeSet.has(edge.from) && nodeSet.has(edge.to));
  const outEdges = new Map(component.map(id => [id, []]));
  const inEdges = new Map(component.map(id => [id, []]));
  for (const edge of edges) { outEdges.get(edge.from).push(edge.to); inEdges.get(edge.to).push(edge.from); }
  for (const list of outEdges.values()) list.sort(byId);
  for (const list of inEdges.values()) list.sort(byId);

  const orientation = breakCycles(component, outEdges);
  const dagOut = new Map(component.map(id => [id, []]));
  const dagIn = new Map(component.map(id => [id, []]));
  for (const edge of edges) {
    const reversed = orientation.get(`${edge.from}->${edge.to}`) === 'reversed';
    const [from, to] = reversed ? [edge.to, edge.from] : [edge.from, edge.to];
    dagOut.get(from).push(to); dagIn.get(to).push(from);
  }

  const { layers, layerOf } = assignLayers(component, dagOut, dagIn);
  reduceCrossings(layers, dagOut, dagIn);
  const secondary = assignSecondary(layers, dagOut, dagIn,
    options.direction === 'LR' ? options.nodeHeight : options.nodeWidth, options.nodeGap);

  const primarySize = options.direction === 'LR' ? options.nodeWidth : options.nodeHeight;
  const secondarySize = options.direction === 'LR' ? options.nodeHeight : options.nodeWidth;
  const secondaryMin = Math.min(...component.map(id => secondary.get(id)));
  const coordinates = new Map();
  for (const id of component) coordinates.set(id, {
    primary: layerOf.get(id) * (primarySize + options.layerGap),
    secondary: secondary.get(id) - secondaryMin, // 分量整体归一化（保留跨层对齐），打包时再加偏移
  });

  let primaryExtent = 0, secondaryExtent = 0;
  for (const id of component) {
    const { primary, secondary: secondaryValue } = coordinates.get(id);
    primaryExtent = Math.max(primaryExtent, primary + primarySize);
    secondaryExtent = Math.max(secondaryExtent, secondaryValue + secondarySize);
  }
  const crossings = countStraightCrossings(edges, layerOf, secondary);
  return { coordinates, primaryExtent, secondaryExtent, layerCount: layers.length, crossings };
}

/** 分量内相邻层直连边的交叉数（衡量布局质量的确定性指标，跨分量无连线不计）。 */
function countStraightCrossings(edges, layerOf, axis) {
  // 只有横跨同一层界的两条边才可能相交；跨层界的边对比较没有几何意义。
  const byBoundary = new Map();
  for (const edge of edges) {
    const fromLayer = layerOf.get(edge.from), toLayer = layerOf.get(edge.to);
    if (fromLayer === undefined || toLayer === undefined || Math.abs(toLayer - fromLayer) !== 1) continue;
    const boundary = Math.min(fromLayer, toLayer);
    if (!byBoundary.has(boundary)) byBoundary.set(boundary, []);
    byBoundary.get(boundary).push({ a: axis.get(edge.from), b: axis.get(edge.to) });
  }
  let crossings = 0;
  for (const straight of byBoundary.values()) {
    for (let i = 0; i < straight.length; i++) for (let j = i + 1; j < straight.length; j++) {
      if ((straight[i].a - straight[j].a) * (straight[i].b - straight[j].b) < 0) crossings++;
    }
  }
  return crossings;
}

/**
 * 计算自动布局。
 * 返回 { ok:true, positions:{ [nodeId]:{x,y} }, stats } 或 { ok:false, code, detail }。
 * positions 为整数坐标，全部落在协议允许的 [0, coordAbsMax] 内；绝不修改传入文档。
 */
export function computeAutoLayout(document, options) {
  const invalid = validateGraphInput(document);
  if (invalid) return fail('invalid-graph', invalid);
  const config = normalizeOptions(options);
  const nodes = [...document.graph.nodes].sort((a, b) => byId(a.id, b.id));
  const edges = [...document.graph.edges].sort((a, b) => byId(a.id, b.id));
  const nodeIds = nodes.map(node => node.id);

  if (!nodeIds.length) {
    return { ok: true, positions: {}, stats: { direction: config.direction, nodeCount: 0, edgeCount: 0, layers: 0, components: 0, crossings: 0 } };
  }

  const adjacency = new Map(nodeIds.map(id => [id, new Set()]));
  for (const edge of edges) { adjacency.get(edge.from).add(edge.to); adjacency.get(edge.to).add(edge.from); }
  const adjacencyLists = new Map([...adjacency].map(([id, set]) => [id, [...set].sort(byId)]));

  // 各分量独立布局，随后沿副轴打包成列，列满换行（主轴推进）。
  const laid = weakComponents(nodeIds, adjacencyLists).map(component => layoutComponent(component, edges, config));
  const secondarySize = config.direction === 'LR' ? config.nodeHeight : config.nodeWidth;
  const columnBudget = Math.max(6 * (secondarySize + config.nodeGap), ...laid.map(part => part.secondaryExtent));

  const positions = {};
  let cursorSecondary = config.margin, cursorPrimary = config.margin, columnPrimaryExtent = 0;
  for (const part of laid) {
    if (cursorSecondary > config.margin && cursorSecondary + part.secondaryExtent > config.margin + columnBudget) {
      cursorSecondary = config.margin;
      cursorPrimary += columnPrimaryExtent + config.componentGap;
      columnPrimaryExtent = 0;
    }
    for (const [id, { primary, secondary }] of part.coordinates) {
      positions[id] = {
        x: Math.round(config.direction === 'LR' ? cursorPrimary + primary : cursorSecondary + secondary),
        y: Math.round(config.direction === 'LR' ? cursorSecondary + secondary : cursorPrimary + primary),
      };
    }
    cursorSecondary += part.secondaryExtent + config.componentGap;
    columnPrimaryExtent = Math.max(columnPrimaryExtent, part.primaryExtent);
  }

  // 协议边界复核：宁可失败也不产出越界坐标（调用方拿到的永远是可提交的建议）。
  const values = Object.values(positions);
  if (values.some(point => !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) ||
      Math.abs(point.x) > AUTO_LAYOUT_LIMITS.coordAbsMax || Math.abs(point.y) > AUTO_LAYOUT_LIMITS.coordAbsMax)) {
    return fail('layout-overflow', '布局结果超出坐标协议边界（±100000）');
  }

  return {
    ok: true,
    positions,
    stats: {
      direction: config.direction,
      nodeCount: nodeIds.length,
      edgeCount: edges.length,
      layers: Math.max(...laid.map(part => part.layerCount)),
      components: laid.length,
      crossings: laid.reduce((sum, part) => sum + part.crossings, 0),
    },
  };
}
