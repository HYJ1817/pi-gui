/**
 * 协同画布多选模型 —— Z4-5 从 collab-canvas.js 抽出。
 *
 * 维护一个有序的选中集合（节点 + 连线），提供：
 * - 单选、Ctrl 切换、框选、全选、清空
 * - 根据文档 revision 更新后的集合修剪
 * - 选中数量与类型查询
 * - 序列化（供复制粘贴使用）
 *
 * 不含 DOM / SVG / 事件监听 —— 画布负责把交互意图翻译为调用。
 */

export function createSelection() {
  // 内部用 Map 保持插入顺序并支持快速查找
  // key: `${kind}:${id}`  value: { kind, id }
  const items = new Map();

  const keyOf = (kind, id) => `${kind}:${id}`;

  /** 是否选中 */
  function has(kind, id) {
    return items.has(keyOf(kind, id));
  }

  /** 获取所有选中项（浅拷贝数组） */
  function all() {
    return [...items.values()];
  }

  /** 选中的节点 id 列表 */
  function nodeIds() {
    return all().filter(s => s.kind === 'node').map(s => s.id);
  }

  /** 选中的连线 id 列表 */
  function edgeIds() {
    return all().filter(s => s.kind === 'edge').map(s => s.id);
  }

  /** 数量 */
  function count() {
    return items.size;
  }

  /** 节点数量 */
  function nodeCount() {
    let n = 0;
    for (const item of items.values()) if (item.kind === 'node') n++;
    return n;
  }

  /** 连线数量 */
  function edgeCount() {
    let n = 0;
    for (const item of items.values()) if (item.kind === 'edge') n++;
    return n;
  }

  /** 清空 */
  function clear() {
    if (items.size === 0) return false;
    items.clear();
    return true;
  }

  /** 单选：清空后选中一个 */
  function selectOne(kind, id) {
    items.clear();
    if (kind && id) items.set(keyOf(kind, id), { kind, id });
  }

  /** 切换（Ctrl+点击）：已选中则取消，未选中则加入 */
  function toggle(kind, id) {
    const key = keyOf(kind, id);
    if (items.has(key)) {
      items.delete(key);
    } else {
      items.set(key, { kind, id });
    }
  }

  /** 添加到选中（框选用） */
  function add(kind, id) {
    const key = keyOf(kind, id);
    if (!items.has(key)) {
      items.set(key, { kind, id });
    }
  }

  /** 全选节点（清空后选择全部节点） */
  function selectAllNodes(graph) {
    if (!graph) return;
    items.clear();
    for (const node of graph.nodes) {
      add('node', node.id);
    }
  }

  /**
   * 修剪：移除文档中不再存在的对象。
   * @param {object} graph - { nodes: [{id}], edges: [{id}] }
   * @returns {boolean} 是否有项被移除
   */
  function prune(graph) {
    if (!graph) { const had = items.size > 0; items.clear(); return had; }
    const validNodes = new Set(graph.nodes.map(n => n.id));
    const validEdges = new Set(graph.edges.map(e => e.id));
    let changed = false;
    for (const [key, item] of items) {
      const valid = item.kind === 'node' ? validNodes.has(item.id) : validEdges.has(item.id);
      if (!valid) { items.delete(key); changed = true; }
    }
    return changed;
  }

  /** 主选中项：最后添加的那个（用于显示属性、编辑文字等） */
  function primary() {
    if (items.size === 0) return null;
    let last = null;
    for (const item of items.values()) last = item;
    return last;
  }

  /** 文字描述 */
  function describe() {
    const nc = nodeCount(), ec = edgeCount();
    if (nc === 0 && ec === 0) return '';
    const parts = [];
    if (nc > 0) parts.push(`${nc} 个节点`);
    if (ec > 0) parts.push(`${ec} 条连线`);
    return `已选择 ${parts.join('、')}`;
  }

  return {
    has, all, nodeIds, edgeIds, count, nodeCount, edgeCount,
    clear, selectOne, toggle, add, selectAllNodes, prune, primary, describe,
  };
}

/**
 * 计算框选区域中的节点 id 列表。
 * 所有坐标均在图形空间（非屏幕空间），调用方负责 zoom/pan 变换。
 *
 * @param {object} graph - { nodes: [{id, x, y}] }
 * @param {object} rect - 选框矩形 { x, y, width, height } 在图形空间
 * @param {number} nodeWidth - 节点宽度（默认 156）
 * @param {number} nodeHeight - 节点高度（默认 64）
 * @returns {string[]} 命中的节点 id
 */
export function hitTestRect(graph, rect, nodeWidth = 156, nodeHeight = 64) {
  if (!graph?.nodes || !rect) return [];
  const rx = Math.min(rect.x, rect.x + rect.width);
  const ry = Math.min(rect.y, rect.y + rect.height);
  const rw = Math.abs(rect.width);
  const rh = Math.abs(rect.height);
  return graph.nodes.filter(node => {
    // 节点矩形与选框矩形交叉即命中
    return node.x + nodeWidth > rx && node.x < rx + rw &&
           node.y + nodeHeight > ry && node.y < ry + rh;
  }).map(node => node.id);
}
