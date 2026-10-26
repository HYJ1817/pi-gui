// 协同流程图自动布局的安全预览与受控应用（Z4-4A 任务 B）。
// 纯数据模块：无 DOM、无 IO、无网络、不直接提交任何操作。
//
// 执行流程（与任务约定一致）：
//   当前文档 → createLayoutPreview 计算新坐标并生成纯数据预览
//   → 上层把预览展示给用户（本模块不渲染）
//   → 用户确认后 applyLayoutPreview 生成 node.update 操作批次（≤50 条）
//   → 上层经既有受控通道（onOperations / operations 接口）提交；
//     服务端 CAS（baseRevision）与 Owner 校验仍是唯一权威，本模块只做客户端预检。
//
// 安全边界：
// - 预览期间不保存：create 只返回数据，不产生任何操作或副作用；
// - 取消预览不改变文档：dismissLayoutPreview 是纯声明（与 lib/collab-doc.js rejectProposal 同型）；
// - 不直接改写 graph：输入文档只读，输出均为新建对象；
// - 正式应用必须核对 revision：applyLayoutPreview 显式重验 documentId 与 baseRevision
//   （与 acceptProposal 的 expectedRevision 纪律同型），过期预览返回 stale-base；
// - 避免零变化操作：只对新旧坐标确实不同的节点生成操作；
// - 超过每批 50 条上限（Z4-2 契约 opsPerProposalMax）时拒绝直接应用，
//   返回明确 over-limit 状态；本模块绝不自动分批，也不存在任何静默保存路径。

import { computeAutoLayout } from './collab-auto-layout.js';

export const LAYOUT_PREVIEW_LIMITS = Object.freeze({
  opsPerBatchMax: 50, // 同步自 lib/collab-doc.js LIMITS.opsPerProposalMax；public 模块不依赖 lib
  coordAbsMax: 100000,
});

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const validId = value => typeof value === 'string' && ID_RE.test(value);

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

const defaultMakeOpId = () => `layout-${globalThis.crypto.randomUUID()}`;

/**
 * 计算自动布局预览。返回纯数据，不修改传入文档，不产生操作：
 *   { ok:true, status:'ready'|'clean'|'over-limit', documentId, baseRevision,
 *     positions, moves:[{id,from:{x,y},to:{x,y}}], moveCount }
 * status 语义：clean = 无需移动（不生成操作）；ready = 可单批原子应用（≤50）；
 * over-limit = 需要移动的节点超过单批上限，必须由用户另行决策（本模块拒绝自动分批）。
 */
export function createLayoutPreview(document, options) {
  const layout = computeAutoLayout(document, options);
  if (!layout.ok) return layout; // invalid-graph / layout-overflow 原样上抛

  const moves = [];
  for (const node of document.graph.nodes) {
    const target = layout.positions[node.id];
    if (!target) continue; // 防御：布局保证覆盖全部节点
    if (target.x !== node.x || target.y !== node.y) {
      moves.push({ id: node.id, from: { x: node.x, y: node.y }, to: { x: target.x, y: target.y } });
    }
  }
  moves.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // 确定性：按节点 ID 排序

  return {
    ok: true,
    status: moves.length === 0 ? 'clean' : moves.length > LAYOUT_PREVIEW_LIMITS.opsPerBatchMax ? 'over-limit' : 'ready',
    documentId: document.documentId,
    baseRevision: document.revision,
    positions: layout.positions,
    moves,
    moveCount: moves.length,
    stats: layout.stats,
  };
}

const validPreviewShape = preview => preview && typeof preview === 'object' &&
  validId(preview.documentId) && Number.isSafeInteger(preview.baseRevision) && preview.baseRevision >= 1 &&
  Array.isArray(preview.moves) && preview.moves.every(move =>
    move && validId(move.id) && move.to && Number.isSafeInteger(move.to.x) && Number.isSafeInteger(move.to.y) &&
    Math.abs(move.to.x) <= LAYOUT_PREVIEW_LIMITS.coordAbsMax && Math.abs(move.to.y) <= LAYOUT_PREVIEW_LIMITS.coordAbsMax);

/**
 * 用户确认后，由预览生成 node.update 操作批次（完整信封，actor=user）。
 * revision 双重核对：预览创建时的 baseRevision 必须仍等于当前文档 revision，
 * 且文档必须就是预览针对的那份（documentId 一致）；否则 stale-base，不生成任何操作。
 * makeOpId 可注入以便测试；默认 crypto.randomUUID，批次内重复时拒绝而非静默去重。
 */
export function applyLayoutPreview(preview, document, { makeOpId = defaultMakeOpId } = {}) {
  if (!validPreviewShape(preview)) return fail('schema', { detail: '预览数据形状非法' });
  if (preview.status === 'over-limit' || preview.moves.length > LAYOUT_PREVIEW_LIMITS.opsPerBatchMax) {
    return fail('over-limit', {
      detail: `布局需要移动 ${preview.moves.length} 个节点，超过单批 ${LAYOUT_PREVIEW_LIMITS.opsPerBatchMax} 条操作上限`,
      moveCount: preview.moves.length,
    });
  }
  if (!document || document.documentId !== preview.documentId) {
    return fail('document-mismatch', { detail: '预览与当前文档不是同一份' });
  }
  if (document.revision !== preview.baseRevision) {
    return fail('stale-base', {
      detail: `预览基于 revision ${preview.baseRevision}，文档已是 ${document.revision}`,
      conflict: { baseRevision: preview.baseRevision, currentRevision: document.revision },
    });
  }
  if (preview.moves.length === 0) {
    // clean 预览：不生成空批次（applyOperations 会拒绝空批次，上层也不应提交无变化事务）。
    return { ok: true, status: 'unchanged', ops: [] };
  }
  const ops = [], opIds = new Set();
  for (const move of preview.moves) {
    const opId = typeof makeOpId === 'function' ? makeOpId(move) : defaultMakeOpId();
    if (!validId(opId)) return fail('schema', { detail: 'opId 生成器产出非法 ID' });
    if (opIds.has(opId)) return fail('opid-collision', { detail: `opId 生成器产出重复 ID：${opId}` });
    opIds.add(opId);
    ops.push({ opId, type: 'node.update', baseRevision: preview.baseRevision, actor: 'user', params: { id: move.id, x: move.to.x, y: move.to.y } });
  }
  return { ok: true, status: 'applied-intent', ops, opCount: ops.length };
}

/**
 * 取消预览：纯声明，不改变任何文档（与 rejectProposal 同型）。
 * 返回固定结果，便于上层与「确认」路径区分；不存在任何隐藏写路径。
 */
export function dismissLayoutPreview(preview) {
  if (!validPreviewShape(preview)) return fail('schema', { detail: '预览数据形状非法' });
  return { ok: true, status: 'cancelled', preview: null, document: null };
}
