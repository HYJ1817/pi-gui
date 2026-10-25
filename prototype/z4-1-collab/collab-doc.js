// Z4-1 隔离原型：协同编辑数据层（纯数据 + 纯函数，无 DOM / 无 IO / 无依赖）。
//
// 本文件只属于 Z4-1 原型，不是生产模块：不接入 server/、public/ 与 npm test 链。
// 设计说明见 docs/Z4-1-collaborative-editing-design.md。
//
// 核心模型：
// - 文档（Document）是唯一可编辑业务状态，revision 单调递增；
// - 用户操作与 Agent 建议走同一套受控变更模型（闭集操作类型 + 严格 schema）；
// - 任何批量应用都是「先整体验证、后一次提交」，失败时原文档不变；
// - 幂等靠 appliedOps 操作日志（有界）；冲突靠 baseRevision 与 doc.revision 比对。

export const SCHEMA_VERSION = 1;

export const LIMITS = Object.freeze({
  maxNodes: 200,
  maxEdges: 400,
  idMax: 64,
  labelMax: 200,
  titleMax: 200,
  opsPerProposalMax: 50,
  journalMax: 500,
  coordAbsMax: 100000,
  rationaleMax: 2000,
  serializedMaxBytes: 2 * 1024 * 1024,
});

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const OP_TYPES = Object.freeze([
  'node.add',
  'node.update',
  'node.remove',
  'edge.add',
  'edge.update',
  'edge.remove',
]);

export class CollabError extends Error {
  constructor(code, detail) {
    super(`collab:${code}`);
    this.name = 'CollabError';
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code, detail) => { throw new CollabError(code, detail); };

// ---------------------------------------------------------------------------
// 基础校验
// ---------------------------------------------------------------------------

function validId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

function validLabel(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= LIMITS.labelMax;
}

function validCoord(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && Math.abs(value) <= LIMITS.coordAbsMax;
}

/** 恰好包含 expectedKeys，不多不少（未知字段一律拒绝）。 */
function exactKeys(obj, expectedKeys, where) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    fail('schema', `${where}: 必须是对象`);
  }
  const keys = Object.keys(obj).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    fail('schema', `${where}: 字段集合不符，得到 [${keys.join(', ')}]`);
  }
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function freshDoc(documentId, title) {
  return {
    documentId,
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    title,
    boundSessionId: null,
    graph: { nodes: [], edges: [] },
    appliedOps: [],
  };
}

// ---------------------------------------------------------------------------
// 文档创建 / 序列化
// ---------------------------------------------------------------------------

export function createDocument({ documentId, title = '' } = {}) {
  if (!validId(documentId)) fail('schema', 'documentId 非法');
  if (typeof title !== 'string' || title.length > LIMITS.titleMax) fail('schema', 'title 非法');
  return freshDoc(documentId, title);
}

/** 任务样例：三个节点、两条连线的流程图文档。 */
export function createFlowchartDocument({ documentId, title = '流程图' } = {}) {
  const doc = createDocument({ documentId, title });
  return applyOperations(doc, [
    { opId: 'seed-n1', type: 'node.add', baseRevision: 1, actor: 'user', params: { id: 'n1', label: '开始', x: 0, y: 0 } },
    { opId: 'seed-n2', type: 'node.add', baseRevision: 1, actor: 'user', params: { id: 'n2', label: '处理', x: 200, y: 0 } },
    { opId: 'seed-n3', type: 'node.add', baseRevision: 1, actor: 'user', params: { id: 'n3', label: '结束', x: 400, y: 0 } },
    { opId: 'seed-e1', type: 'edge.add', baseRevision: 1, actor: 'user', params: { id: 'e1', from: 'n1', to: 'n2' } },
    { opId: 'seed-e2', type: 'edge.add', baseRevision: 1, actor: 'user', params: { id: 'e2', from: 'n2', to: 'n3' } },
  ]).doc;
}

/** 规范序列化：字段定序、节点与连线按 id 排序，保证同样内容产出同样字节。 */
export function serialize(doc) {
  const canonical = {
    documentId: doc.documentId,
    schemaVersion: doc.schemaVersion,
    revision: doc.revision,
    title: doc.title,
    boundSessionId: doc.boundSessionId,
    graph: {
      nodes: [...doc.graph.nodes].sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((n) => ({ id: n.id, label: n.label, x: n.x, y: n.y })),
      edges: [...doc.graph.edges].sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((e) => (e.label === undefined
          ? { id: e.id, from: e.from, to: e.to }
          : { id: e.id, from: e.from, to: e.to, label: e.label })),
    },
  };
  const json = JSON.stringify(canonical);
  if (Buffer.byteLength(json) > LIMITS.serializedMaxBytes) {
    fail('too-large', '序列化结果超过上限');
  }
  return json;
}

export function deserialize(json) {
  if (typeof json !== 'string' || Buffer.byteLength(json) > LIMITS.serializedMaxBytes) {
    fail('too-large', '输入超出体积上限');
  }
  let raw;
  try { raw = JSON.parse(json); } catch { fail('schema', '不是合法 JSON'); }
  exactKeys(raw, ['documentId', 'schemaVersion', 'revision', 'title', 'boundSessionId', 'graph'], 'document');
  if (raw.schemaVersion !== SCHEMA_VERSION) fail('schema-version', `不支持的 schemaVersion ${raw.schemaVersion}`);
  if (!validId(raw.documentId)) fail('schema', 'documentId 非法');
  if (typeof raw.title !== 'string' || raw.title.length > LIMITS.titleMax) fail('schema', 'title 非法');
  if (!positiveInt(raw.revision)) fail('schema', 'revision 非法');
  if (raw.boundSessionId !== null && !validId(raw.boundSessionId)) fail('schema', 'boundSessionId 非法');
  const doc = {
    documentId: raw.documentId,
    schemaVersion: SCHEMA_VERSION,
    revision: raw.revision,
    title: raw.title,
    boundSessionId: raw.boundSessionId,
    graph: { nodes: [], edges: [] },
    appliedOps: [],
  };
  exactKeys(raw.graph, ['nodes', 'edges'], 'graph');
  if (!Array.isArray(raw.graph.nodes) || !Array.isArray(raw.graph.edges)) fail('schema', 'graph 字段类型非法');
  if (raw.graph.nodes.length > LIMITS.maxNodes) fail('limit', `节点数超过上限 ${LIMITS.maxNodes}`);
  if (raw.graph.edges.length > LIMITS.maxEdges) fail('limit', `连线数超过上限 ${LIMITS.maxEdges}`);
  const nodeIds = new Set();
  for (const n of raw.graph.nodes) {
    exactKeys(n, ['id', 'label', 'x', 'y'], 'node');
    if (!validId(n.id) || !validLabel(n.label) || !validCoord(n.x) || !validCoord(n.y)) {
      fail('schema', `node ${String(n.id)} 字段非法`);
    }
    if (nodeIds.has(n.id)) fail('schema', `node id 重复: ${n.id}`);
    nodeIds.add(n.id);
    doc.graph.nodes.push({ id: n.id, label: n.label, x: n.x, y: n.y });
  }
  const edgeIds = new Set();
  const edgePairs = new Set();
  for (const e of raw.graph.edges) {
    exactKeys(e, ['id', 'from', 'to', ...(e.label === undefined ? [] : ['label'])], 'edge');
    if (!validId(e.id) || !validId(e.from) || !validId(e.to)) fail('schema', `edge ${String(e.id)} 字段非法`);
    if (e.label !== undefined && !validLabel(e.label)) fail('schema', `edge ${e.id} label 非法`);
    if (nodeIds.has(e.id)) fail('schema', `edge id 与 node id 冲突: ${e.id}`);
    if (edgeIds.has(e.id)) fail('schema', `edge id 重复: ${e.id}`);
    edgeIds.add(e.id);
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) fail('schema', `edge ${e.id} 引用了不存在的节点`);
    if (e.from === e.to) fail('schema', `edge ${e.id} 是自环`);
    const pair = `${e.from}->${e.to}`;
    if (edgePairs.has(pair)) fail('duplicate-edge', `${pair} 同向重复连线`);
    edgePairs.add(pair);
    doc.graph.edges.push(e.label === undefined
      ? { id: e.id, from: e.from, to: e.to }
      : { id: e.id, from: e.from, to: e.to, label: e.label });
  }
  return doc;
}

// ---------------------------------------------------------------------------
// 操作 schema 与结构校验
// ---------------------------------------------------------------------------

function validateOperationSchema(op) {
  exactKeys(op, ['opId', 'type', 'baseRevision', 'actor', 'params'], 'operation');
  if (!validId(op.opId)) fail('schema', 'opId 非法');
  if (!OP_TYPES.includes(op.type)) fail('unknown-type', `未知操作类型 ${String(op.type)}`);
  if (!positiveInt(op.baseRevision)) fail('schema', 'baseRevision 非法');
  if (op.actor !== 'user' && op.actor !== 'agent') fail('schema', 'actor 非法');
  if (typeof op.params !== 'object' || op.params === null || Array.isArray(op.params)) {
    fail('schema', 'params 必须是对象');
  }
}

/** 结构校验：op 的 params 是否能落在 state 上（不检查 revision / 幂等）。 */
function validateAgainstState(state, op) {
  const p = op.params;
  switch (op.type) {
    case 'node.add': {
      exactKeys(p, ['id', 'label', 'x', 'y'], 'node.add');
      if (!validId(p.id) || !validLabel(p.label) || !validCoord(p.x) || !validCoord(p.y)) {
        fail('schema', 'node.add 字段非法');
      }
      if (state.graph.nodes.some((n) => n.id === p.id)) fail('exists', `节点 ${p.id} 已存在`);
      if (state.graph.edges.some((e) => e.id === p.id)) fail('exists', `id ${p.id} 已被连线占用`);
      if (state.graph.nodes.length >= LIMITS.maxNodes) fail('limit', `节点数达到上限 ${LIMITS.maxNodes}`);
      break;
    }
    case 'node.update': {
      exactKeys(p, ['id', 'label', 'x', 'y'].filter((k) => p[k] !== undefined), 'node.update');
      const keys = Object.keys(p);
      if (!keys.includes('id') || keys.length < 2) fail('schema', 'node.update 至少要改一个字段');
      if ('label' in p && !validLabel(p.label)) fail('schema', 'label 非法');
      if (('x' in p && !validCoord(p.x)) || ('y' in p && !validCoord(p.y))) fail('schema', '坐标非法');
      if (!state.graph.nodes.some((n) => n.id === p.id)) fail('missing', `节点 ${p.id} 不存在`);
      break;
    }
    case 'node.remove': {
      exactKeys(p, ['id'], 'node.remove');
      if (!validId(p.id)) fail('schema', 'id 非法');
      if (!state.graph.nodes.some((n) => n.id === p.id)) fail('missing', `节点 ${p.id} 不存在`);
      if (state.graph.edges.some((e) => e.from === p.id || e.to === p.id)) {
        fail('referenced', `节点 ${p.id} 仍被连线引用，需先删除连线`);
      }
      break;
    }
    case 'edge.add': {
      exactKeys(p, ['id', 'from', 'to', ...(p.label === undefined ? [] : ['label'])], 'edge.add');
      if (!validId(p.id) || !validId(p.from) || !validId(p.to)) fail('schema', 'edge.add 字段非法');
      if (p.label !== undefined && !validLabel(p.label)) fail('schema', 'label 非法');
      if (p.from === p.to) fail('self-loop', '不允许自环连线');
      if (state.graph.edges.some((e) => e.id === p.id)) fail('exists', `连线 ${p.id} 已存在`);
      if (state.graph.nodes.some((n) => n.id === p.id)) fail('exists', `id ${p.id} 已被节点占用`);
      if (!state.graph.nodes.some((n) => n.id === p.from)) fail('missing', `起点节点 ${p.from} 不存在`);
      if (!state.graph.nodes.some((n) => n.id === p.to)) fail('missing', `终点节点 ${p.to} 不存在`);
      if (state.graph.edges.some((e) => e.from === p.from && e.to === p.to)) {
        fail('duplicate-edge', `${p.from}→${p.to} 已有连线`);
      }
      if (state.graph.edges.length >= LIMITS.maxEdges) fail('limit', `连线数达到上限 ${LIMITS.maxEdges}`);
      break;
    }
    case 'edge.update': {
      exactKeys(p, ['id', 'label'], 'edge.update');
      if (!validId(p.id)) fail('schema', 'edge.update 字段非法');
      // label: string 设置文字；null 清除文字（撤销「给无 label 连线加文字」需要它）
      if (p.label !== null && !validLabel(p.label)) fail('schema', 'label 非法');
      if (!state.graph.edges.some((e) => e.id === p.id)) fail('missing', `连线 ${p.id} 不存在`);
      break;
    }
    case 'edge.remove': {
      exactKeys(p, ['id'], 'edge.remove');
      if (!validId(p.id)) fail('schema', 'id 非法');
      if (!state.graph.edges.some((e) => e.id === p.id)) fail('missing', `连线 ${p.id} 不存在`);
      break;
    }
    default:
      fail('unknown-type', `未知操作类型 ${op.type}`);
  }
}

function mutate(state, op) {
  const p = op.params;
  switch (op.type) {
    case 'node.add':
      state.graph.nodes.push({ id: p.id, label: p.label, x: p.x, y: p.y });
      break;
    case 'node.update': {
      const n = state.graph.nodes.find((x) => x.id === p.id);
      if ('label' in p) n.label = p.label;
      if ('x' in p) n.x = p.x;
      if ('y' in p) n.y = p.y;
      break;
    }
    case 'node.remove':
      state.graph.nodes = state.graph.nodes.filter((n) => n.id !== p.id);
      break;
    case 'edge.add':
      state.graph.edges.push(p.label === undefined
        ? { id: p.id, from: p.from, to: p.to }
        : { id: p.id, from: p.from, to: p.to, label: p.label });
      break;
    case 'edge.update': {
      const e = state.graph.edges.find((x) => x.id === p.id);
      if (p.label === null) delete e.label;
      else e.label = p.label;
      break;
    }
    case 'edge.remove':
      state.graph.edges = state.graph.edges.filter((e) => e.id !== p.id);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// 事务化应用（先整体验证，后一次提交）
// ---------------------------------------------------------------------------

const clone = (doc) => JSON.parse(JSON.stringify(doc));

/**
 * 操作内容指纹：opId 之外的全部语义字段。
 * 幂等日志用它区分「同一操作重放」与「复用 opId 夹带不同内容」。
 * 规范化：对象键递归排序后再序列化，键插入顺序不同的同语义操作指纹一致。
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

function opFingerprint(op) {
  return JSON.stringify(canonicalize({
    type: op.type,
    baseRevision: op.baseRevision,
    actor: op.actor,
    params: op.params,
  }));
}

/** 在幂等日志里查一个操作：'exact'（同 ID 同内容）| 'reuse'（同 ID 不同内容）| 'none'。 */
function journalLookup(doc, op) {
  const fp = opFingerprint(op);
  const entry = doc.appliedOps.find((e) => e.id === op.opId);
  if (!entry) return 'none';
  return entry.fp === fp ? 'exact' : 'reuse';
}

function pushJournal(doc, ops) {
  doc.appliedOps.push(...ops.map((op) => ({ id: op.opId, fp: opFingerprint(op) })));
  if (doc.appliedOps.length > LIMITS.journalMax) {
    doc.appliedOps.splice(0, doc.appliedOps.length - LIMITS.journalMax);
  }
}

/**
 * 核心：把一批操作事务化地应用到 doc 上。
 * 返回 { ok, doc, revision, appliedOpIds } 或 { ok: false, code, detail }。
 * 任何一步失败都不改变传入的 doc（内部先在副本上验证并应用）。
 */
export function applyOperations(doc, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return { ok: false, code: 'empty-batch', detail: '操作批次为空' };
  }
  // 第一阶段：逐条 schema + 幂等 + revision + 结构校验，并在副本上顺序模拟。
  const work = clone(doc);
  const seenOpIds = new Set();
  for (const op of ops) {
    try {
      validateOperationSchema(op);
      if (seenOpIds.has(op.opId)) fail('schema', `批次内 opId 重复: ${op.opId}`);
      seenOpIds.add(op.opId);
      const journalled = journalLookup(doc, op);
      if (journalled === 'exact') fail('duplicate', `操作 ${op.opId} 已应用过（同内容重放，无操作）`);
      if (journalled === 'reuse') fail('opid-reuse', `操作 ${op.opId} 已被不同内容占用，拒绝执行`);
      if (op.baseRevision !== doc.revision) {
        fail('stale-base', `操作基于 revision ${op.baseRevision}，当前是 ${doc.revision}`);
      }
      validateAgainstState(work, op);
      mutate(work, op);
    } catch (err) {
      if (err instanceof CollabError) return { ok: false, code: err.code, detail: err.detail };
      throw err;
    }
  }
  // 第二阶段：整体通过后一次性提交。
  work.revision = doc.revision + 1;
  pushJournal(work, ops);
  return { ok: true, doc: work, revision: work.revision, appliedOpIds: [...seenOpIds] };
}

/** 用户直接操作：actor 必须是 user（Agent 只能走建议通道）。 */
export function applyUserOperation(doc, op) {
  if (op && op.actor !== 'user') {
    return { ok: false, code: 'actor-forbidden', detail: 'Agent 不能直接执行操作，请走建议通道' };
  }
  const result = applyOperations(doc, [op]);
  if (!result.ok && result.code === 'duplicate') {
    return { ok: true, status: 'duplicate', doc, revision: doc.revision };
  }
  return result;
}

// ---------------------------------------------------------------------------
// 会话绑定（Agent 建议的归属校验）
// ---------------------------------------------------------------------------

export function bindSession(doc, sessionId) {
  if (!validId(sessionId)) fail('schema', 'sessionId 非法');
  if (doc.boundSessionId !== null && doc.boundSessionId !== sessionId) {
    fail('session-conflict', `文档已绑定会话 ${doc.boundSessionId}`);
  }
  return { ...doc, boundSessionId: sessionId };
}

// ---------------------------------------------------------------------------
// Agent 修改建议（proposal）：预览 → 接受 / 拒绝
// ---------------------------------------------------------------------------

export function createProposal({ documentId, baseRevision, sessionId, ops, rationale = '' } = {}) {
  if (!validId(documentId)) fail('schema', 'documentId 非法');
  if (!positiveInt(baseRevision)) fail('schema', 'baseRevision 非法');
  if (sessionId !== undefined && !validId(sessionId)) fail('schema', 'sessionId 非法');
  if (typeof rationale !== 'string' || rationale.length > LIMITS.rationaleMax) fail('schema', 'rationale 非法');
  if (!Array.isArray(ops) || ops.length === 0) fail('schema', 'ops 不能为空');
  if (ops.length > LIMITS.opsPerProposalMax) fail('limit', `建议最多 ${LIMITS.opsPerProposalMax} 条操作`);
  const normalized = ops.map((op) => {
    const candidate = { ...op, actor: 'agent' };
    validateOperationSchema(candidate);
    return candidate;
  });
  const opIds = new Set(normalized.map((o) => o.opId));
  if (opIds.size !== normalized.length) fail('schema', '建议内 opId 重复');
  return {
    proposalId: `prop-${documentId}-${baseRevision}-${opIds.size}-${normalized[0].opId}`,
    schemaVersion: SCHEMA_VERSION,
    documentId,
    baseRevision,
    sessionId,
    rationale,
    ops: normalized,
  };
}

/**
 * 可解释差异：逐条人类可读摘要。
 * 以批次内逐步模拟的状态为参照 —— 同一批里「先新增节点、再修改该节点」时，
 * 摘要看得到前一步的结果，而不是在批次初始文档里找不到对象。
 */
export function describeBatch(before, ops) {
  const sim = clone(before);
  const diff = [];
  for (const op of ops) {
    diff.push({ opId: op.opId, type: op.type, summary: describeOperation(op, sim) });
    mutate(sim, op);
  }
  return diff;
}

function describeOperation(op, state) {
  const p = op.params;
  switch (op.type) {
    case 'node.add': return `新增节点 ${p.id}「${p.label}」位置(${p.x},${p.y})`;
    case 'node.update': {
      const n = state.graph.nodes.find((x) => x.id === p.id);
      const parts = [];
      if ('label' in p && n.label !== p.label) parts.push(`文字「${n.label}」→「${p.label}」`);
      if ('x' in p && n.x !== p.x) parts.push(`x ${n.x}→${p.x}`);
      if ('y' in p && n.y !== p.y) parts.push(`y ${n.y}→${p.y}`);
      return parts.length ? `修改节点 ${p.id}：${parts.join('，')}` : `修改节点 ${p.id}（无实际变化）`;
    }
    case 'node.remove': return `删除节点 ${p.id}`;
    case 'edge.add': return `新增连线 ${p.id}（${p.from}→${p.to}）`;
    case 'edge.update': {
      const e = state.graph.edges.find((x) => x.id === p.id);
      if (p.label === null) return `清除连线 ${p.id} 文字`;
      return `修改连线 ${p.id} 文字「${e.label ?? ''}」→「${p.label}」`;
    }
    case 'edge.remove': return `删除连线 ${p.id}`;
    default: return `未知操作 ${op.type}`;
  }
}

/**
 * 建议信封校验：归属与 schema 先于一切（含幂等快捷路径）。
 * 返回错误结果或 null。
 */
function validateProposalEnvelope(doc, proposal) {
  if (typeof proposal !== 'object' || proposal === null || Array.isArray(proposal)) {
    return { ok: false, code: 'schema', detail: 'proposal 必须是对象' };
  }
  if (!Array.isArray(proposal.ops) || proposal.ops.length === 0) {
    return { ok: false, code: 'schema', detail: 'ops 必须是非空数组' };
  }
  for (const op of proposal.ops) {
    try {
      validateOperationSchema(op);
    } catch (err) {
      if (err instanceof CollabError) return { ok: false, code: err.code, detail: err.detail };
      throw err;
    }
  }
  if (proposal.documentId !== doc.documentId) {
    return { ok: false, code: 'document-mismatch', detail: `建议针对 ${proposal.documentId}，当前文档 ${doc.documentId}` };
  }
  if (proposal.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, code: 'schema-version', detail: `建议 schemaVersion ${proposal.schemaVersion}` };
  }
  if (!proposal.sessionId || !validId(proposal.sessionId)) {
    return { ok: false, code: 'session-mismatch', detail: 'Agent 建议缺少会话标识' };
  }
  if (doc.boundSessionId !== null && proposal.sessionId !== doc.boundSessionId) {
    return { ok: false, code: 'session-mismatch', detail: `建议来自旧会话 ${proposal.sessionId}，当前会话 ${doc.boundSessionId}` };
  }
  return null;
}

/**
 * 校验并预览建议。返回
 * { ok: true, preview: { diff, resultingRevision, nodeCount, edgeCount } } 或
 * { ok: false, code, detail }（code: document-mismatch / schema-version / stale-base /
 * session-mismatch / duplicate / 各类 schema 与结构错误）。
 */
export function previewProposal(doc, proposal) {
  const envErr = validateProposalEnvelope(doc, proposal);
  if (envErr) return envErr;
  if (proposal.baseRevision !== doc.revision) {
    return {
      ok: false,
      code: 'stale-base',
      detail: `建议基于 revision ${proposal.baseRevision}，文档已是 ${doc.revision}`,
      conflict: { baseRevision: proposal.baseRevision, currentRevision: doc.revision },
    };
  }
  return applyOperations(doc, proposal.ops);
}

/** 预览（只读），不改变文档。 */
export function previewProposalReadonly(doc, proposal) {
  const result = previewProposal(doc, proposal);
  if (!result.ok) return result;
  return { ok: true, preview: buildPreview(doc, result.doc, result.appliedOpIds, proposal) };
}

function buildPreview(before, after, appliedOpIds, proposal) {
  const diff = describeBatch(before, proposal.ops);
  return {
    diff,
    appliedOpIds,
    resultingRevision: after.revision,
    nodeCount: after.graph.nodes.length,
    edgeCount: after.graph.edges.length,
  };
}

/**
 * 接受建议：接受时再次核对 revision（与 T4-C「确认前重验」同型），
 * 原子应用全部操作；任何失败原文档不变。传入 editorState 时记入撤销栈。
 * 文档尚未绑定会话时，接受动作把文档绑定到建议来源会话（先到先得）。
 */
export function acceptProposal(doc, editorState, proposal, { expectedRevision } = {}) {
  // 归属与 schema 校验先于幂等快捷路径：不同文档/会话或非法 schema 的建议，
  // 即使 opId 已在幂等日志里也必须明确拒绝，不能被 duplicate 吞掉。
  const envErr = validateProposalEnvelope(doc, proposal);
  if (envErr) return envErr;
  // 幂等（同文档、同会话、同内容）：建议的全部操作已在日志中 ⇒ 已应用过，重复接受是无操作。
  // 该判断先于 revision 比对 —— 建议落盘后的后续编辑不改变「它已被应用」的事实。
  if (proposal.ops.every((op) => journalLookup(doc, op) === 'exact')) {
    return { ok: true, status: 'duplicate', doc, revision: doc.revision, preview: null };
  }
  if (!positiveInt(expectedRevision)) {
    return { ok: false, code: 'schema', detail: 'accept 必须显式传入 expectedRevision' };
  }
  if (expectedRevision !== doc.revision) {
    return {
      ok: false,
      code: 'stale-base',
      detail: `接受时文档已是 revision ${doc.revision}，调用方基于 ${expectedRevision}`,
      conflict: { baseRevision: expectedRevision, currentRevision: doc.revision },
    };
  }
  const checked = previewProposal(doc, proposal);
  if (!checked.ok) {
    // 同一建议重复接受：幂等无操作，文档保持不变（不产生重复修改）。
    if (checked.code === 'duplicate') {
      return { ok: true, status: 'duplicate', doc, revision: doc.revision, preview: null };
    }
    return checked;
  }
  let applied = checked;
  if (doc.boundSessionId === null && proposal.sessionId) {
    applied = { ...checked, doc: { ...checked.doc, boundSessionId: proposal.sessionId } };
  }
  if (editorState) {
    const before = clone(doc);
    editorState.undoStack.push({ forwardOps: proposal.ops, inverseOps: computeInverse(before, proposal.ops) });
    editorState.redoStack = [];
  }
  return {
    ok: true,
    doc: applied.doc,
    revision: applied.revision,
    appliedOpIds: applied.appliedOpIds,
    preview: buildPreview(doc, applied.doc, applied.appliedOpIds, proposal),
  };
}

/** 拒绝建议：纯声明动作，不改变任何状态。 */
export function rejectProposal(doc, proposal) {
  if (typeof proposal !== 'object' || proposal === null || proposal.documentId !== doc.documentId) {
    return { ok: false, code: 'document-mismatch', detail: '建议不属于当前文档' };
  }
  return { ok: true, status: 'rejected', doc, revision: doc.revision };
}

// ---------------------------------------------------------------------------
// 撤销 / 重做（编辑器状态与文档分离；文档本体保持可序列化纯数据）
// ---------------------------------------------------------------------------

let undoSeq = 0;
function freshUndoOpId() {
  undoSeq += 1;
  return `u${Date.now().toString(36)}-${undoSeq}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function createEditorState() {
  return { undoStack: [], redoStack: [] };
}

/** 单个操作的逆操作：stateBefore 必须是该操作执行前的真实状态（逐步模拟得到）。 */
function inverseOf(op, stateBefore) {
  const p = op.params;
  switch (op.type) {
    case 'node.add':
      return { type: 'node.remove', params: { id: p.id } };
    case 'node.remove': {
      const n = stateBefore.graph.nodes.find((x) => x.id === p.id);
      return { type: 'node.add', params: { id: n.id, label: n.label, x: n.x, y: n.y } };
    }
    case 'node.update': {
      const n = stateBefore.graph.nodes.find((x) => x.id === p.id);
      const params = { id: p.id };
      if ('label' in p) params.label = n.label;
      if ('x' in p) params.x = n.x;
      if ('y' in p) params.y = n.y;
      return { type: 'node.update', params };
    }
    case 'edge.add':
      return { type: 'edge.remove', params: { id: p.id } };
    case 'edge.remove': {
      const e = stateBefore.graph.edges.find((x) => x.id === p.id);
      return { type: 'edge.add', params: e.label === undefined
        ? { id: e.id, from: e.from, to: e.to }
        : { id: e.id, from: e.from, to: e.to, label: e.label } };
    }
    case 'edge.update': {
      const e = stateBefore.graph.edges.find((x) => x.id === p.id);
      // 执行前无 label 就用 null 清除（edge.update 支持 label:null），保证可逆
      return { type: 'edge.update', params: { id: p.id, label: e.label === undefined ? null : e.label } };
    }
    default:
      fail('unknown-type', `未知操作类型 ${op.type}`);
  }
}

/**
 * 由「应用前文档 + 已提交操作」计算逆操作。
 * 逐 op 模拟推进，每个逆操作依据该 op 执行前的真实状态生成，
 * 逆序返回 —— 因此支持「先新增对象、再修改同一对象」的批次。
 */
export function computeInverse(beforeDoc, ops) {
  const sim = clone(beforeDoc);
  const inverse = [];
  for (const op of ops) {
    inverse.push(inverseOf(op, sim));
    mutate(sim, op);
  }
  return inverse.reverse();
}

/**
 * 提交一批操作并记入撤销栈（用户操作与「已接受的建议」共用此入口，
 * 满足「用户操作和 Agent 操作使用同一套受控变更模型」）。
 */
export function commitOperations(doc, editorState, ops) {
  const before = clone(doc);
  const result = applyOperations(doc, ops);
  if (!result.ok) return result;
  const inverse = computeInverse(before, ops);
  editorState.undoStack.push({ forwardOps: ops, inverseOps: inverse });
  editorState.redoStack = [];
  return result;
}

export function undo(doc, editorState) {
  const entry = editorState.undoStack.pop();
  if (!entry) return { ok: false, code: 'undo-empty', detail: '没有可撤销的操作' };
  const replay = entry.inverseOps.map((inv) => ({
    opId: freshUndoOpId(),
    type: inv.type,
    baseRevision: doc.revision,
    actor: 'user',
    params: inv.params,
  }));
  const result = applyOperations(doc, replay);
  if (!result.ok) {
    editorState.undoStack.push(entry); // 撤销失败：原样放回，文档未变
    return result;
  }
  editorState.redoStack.push(entry);
  return { ok: true, doc: result.doc, revision: result.revision };
}

export function redo(doc, editorState) {
  const entry = editorState.redoStack.pop();
  if (!entry) return { ok: false, code: 'redo-empty', detail: '没有可重做的操作' };
  const replay = entry.forwardOps.map((op) => ({
    opId: freshUndoOpId(), // 重做是新的逻辑变更：新 opId，避免幂等日志误判为重复
    type: op.type,
    baseRevision: doc.revision,
    actor: op.actor,
    params: op.params,
  }));
  const result = applyOperations(doc, replay);
  if (!result.ok) {
    editorState.redoStack.push(entry);
    return result;
  }
  editorState.undoStack.push(entry);
  return { ok: true, doc: result.doc, revision: result.revision };
}
