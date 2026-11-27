import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from './runtime.js';
import { createPiLaunch } from './pi-launch.js';
import { createRpcBridge } from './rpc-bridge.js';
import { createPlanBridge } from './plan-bridge.js';
import { createMessageEditLaunch } from './message-edit-launch.js';
import { createMessageEditService } from './message-edit.js';
import { projectPlanArgs, projectPlanResult } from './plan-projection.js';
import { createPiSupervisor } from './pi-supervisor.js';
import { createProjectConfig } from './project-config.js';
import { createProcessBridge } from './process-bridge.js';
import { createPiActivity } from './pi-activity.js';
import { createModelGeneration } from './model-generation.js';
import { createSessions } from './sessions.js';
import { sanitizeModelEvent } from './provider-auth-sdk.js';
import { projectProcessEvent } from './process-activity.js';
import { resolveExecutable } from './process-runner.js';
import { isSea } from '../lib/assets.js';
import { randomUUID } from 'node:crypto';
import { createSessionToolBridge } from './session-tool-bridge.js';
import { runtimeSessionWitness } from './provider-config-sync.js';
import { createExecutionToolProjection, executionSubmission, readExecutionBranch,
  projectRuntimeEntry, projectRuntimeEntryRead } from './execution-timeline.js';
import { safeToolName, usageProjection } from '../public/runtime-timeline.js';
import { safeFallbackFailure } from '../lib/model-fallback.js';
import { createHtmlRenderBridge } from './html-render-bridge.js';
import { projectHtmlArtifacts, projectHtmlToolResult } from './html-artifact-projection.js';
import { htmlArtifactFromToolResult } from '../public/html-artifact-model.js';

const fail = code => Object.assign(Error(code), { code });
// This narrow surface projects tool activity. Raw args/result/worker diagnostics
// stay in Pi; message text is intentional conversation content, not diagnostics.
const EXECUTION_OBSERVATIONS = new Set(['execution_submission', 'execution_branch', 'execution_stop']);
const REPORTED_TEXT_PARTS = new Set(['text', 'thinking']);
const MESSAGE_ROLES = new Set(['assistant', 'user', 'toolResult', 'system', 'custom', 'bashExecution', 'compactionSummary', 'branchSummary']);
const ID = /^[A-Za-z0-9_.:/#-]{1,160}$/;
const validWireId = value => typeof value === 'string' && ID.test(value);
function projectedGenerationResult(result) {
  if (!validWireId(result?.requestId) || !['success', 'failed', 'unknown'].includes(result.outcome)) return null;
  return { requestId: result.requestId, outcome: result.outcome, hasVisibleOutput: result.hasVisibleOutput === true,
    ...(result.outcome === 'failed' ? { failure: safeFallbackFailure(result.failure) } : {}) };
}
function projectedMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || !MESSAGE_ROLES.has(msg.role)) return null;
  if (msg.role === 'toolResult') {
    return { role: msg.role, toolCallId: validWireId(msg.toolCallId) ? msg.toolCallId : undefined,
      toolName: safeToolName(msg.toolName), isError: msg.isError === true, content: [],
      ...(msg.toolName === 'html_render' ? projectHtmlToolResult(msg) : {}) };
  }
  const out = { role: msg.role };
  if (msg.role !== 'assistant' && msg.role !== 'user') return out;
  if (typeof msg.content === 'string') out.content = msg.content;
  if (Array.isArray(msg.content)) out.content = msg.content.map(part => {
    const type = part?.type;
    if (type === 'toolCall' && validWireId(part.id)) return { type, id: part.id, name: safeToolName(part.name) };
    if (REPORTED_TEXT_PARTS.has(type) && typeof part[type] === 'string') return { type, [type]: part[type] };
    if (type === 'image' && typeof part.data === 'string' && /^image\/[a-z0-9.+-]{1,40}$/i.test(part.mimeType)) {
      return { type, data: part.data, mimeType: part.mimeType };
    }
    return null; // preserve source content indices for native anchors
  });
  /* Consumer model identity and the P3 usage fields remain available. Opaque
   * provider parameters, thinking signatures and worker-only fields do not. */
  for (const key of ['api', 'provider', 'model', 'stopReason', 'errorMessage']) {
    if (typeof msg[key] === 'string') out[key] = msg[key];
  }
  if (typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)) out.timestamp = msg.timestamp;
  const usage = usageProjection(msg.usage);
  if (usage) {
    const cost = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h']) {
      const value = msg.usage?.cost?.[key];
      if (Number.isFinite(value) && value >= 0) cost[key] = value;
    }
    if (Object.hasOwn(usage, 'costTotal')) {
      cost.total = usage.costTotal;
      delete usage.costTotal;
    }
    if (Object.keys(cost).length) usage.cost = cost;
    out.usage = usage;
  }
  if (validWireId(msg.id)) out.id = msg.id;
  return out;
}
export function projectRuntimeEvent(event, activity = null) {
  /* Tool executions are allowlisted below, including the html completion
   * projection. The stateless pass cannot bind a nameless legacy completion to
   * its tool, so it would replace every ordinary `result` (e.g. the gui_plan
   * details contract) with an HTML placeholder. The tool-aware boundaries —
   * server.js classic publish and the history readers — hold that rewrite. */
  if (!event?.type?.startsWith('tool_execution_')) event = projectHtmlArtifacts(event);
  if (event?.type === 'response' && event.success === false && ['set_thinking_level', 'cycle_thinking_level'].includes(event.command)) {
    const response = { type: 'response', command: event.command, success: false, error: 'Pi 未能完成思考级别操作；请检查模型配置后重试。' };
    if (typeof event.id === 'string' || typeof event.id === 'number') response.id = event.id;
    if (Number.isInteger(event.bridgeRun)) response.bridgeRun = event.bridgeRun;
    return response;
  }
  if (['bridge_stderr', 'bridge_parse_error'].includes(event?.type)) return { type: event.type, bridgeRun: event.bridgeRun };
  if (event?.type === 'extension_error') return { type: event.type, error: '扩展执行或加载失败', bridgeRun: event.bridgeRun };
  if (event?.type?.startsWith('tool_execution_')) {
    const out = { type: event.type, toolCallId: validWireId(event.toolCallId) ? event.toolCallId : undefined,
      toolName: typeof event.toolName === 'string' ? safeToolName(event.toolName) : undefined,
      isError: event.isError === true, bridgeRun: event.bridgeRun };
    if (event.type === 'tool_execution_end' && Number.isFinite(event.durationMs) && event.durationMs >= 0) {
      out.durationMs = Math.min(event.durationMs, 24 * 60 * 60 * 1000);
    }
    /* Structured plan fields and P5 tool facts are independent allowlists. */
    const plan = event.type === 'tool_execution_start'
      ? projectPlanArgs(event.toolName, event.args)
      : event.type === 'tool_execution_end' ? projectPlanResult(event.result) : null;
    if (plan) out.plan = plan;
    if (event.type === 'tool_execution_end' && event.isError !== true && htmlArtifactFromToolResult(event.result)) {
      out.result = projectHtmlToolResult(event.result);
    }
    if (activity) out.activity = activity;
    return out;
  }
  if (['agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end'].includes(event?.type)) {
    const out = { type: event.type, bridgeRun: event.bridgeRun };
    if (validWireId(event.generationRequestId)) out.generationRequestId = event.generationRequestId;
    if (validWireId(event.parentToolCallId)) out.parentToolCallId = event.parentToolCallId;
    if (event.type === 'agent_settled') {
      if (typeof event.aborted === 'boolean') out.aborted = event.aborted;
      const result = projectedGenerationResult(event.generationResult);
      if (result) out.generationResult = result;
    }
    if (typeof event.willRetry === 'boolean') out.willRetry = event.willRetry;
    if (event.message) out.message = projectedMessage(event.message);
    if (event.type === 'agent_end' && Array.isArray(event.messages)) out.messages = event.messages.map(projectedMessage);
    if (event.type === 'turn_end' && Array.isArray(event.toolResults)) out.toolResults = event.toolResults.map(projectedMessage);
    if (event.type === 'message_update') {
      const next = event.assistantMessageEvent;
      if (typeof next?.type === 'string' && /^(?:start|done|error|(?:text|thinking|toolcall)_(?:start|delta|end))$/.test(next.type)) {
        const update = { type: next.type };
        if (Number.isSafeInteger(next.contentIndex) && next.contentIndex >= 0) update.contentIndex = next.contentIndex;
        if (next.type.startsWith('toolcall_')) {
          if (validWireId(next.id)) update.id = next.id;
          if (typeof next.toolName === 'string') update.toolName = safeToolName(next.toolName);
        } else {
          if (typeof next.delta === 'string') update.delta = next.delta;
          if (typeof next.content === 'string') update.content = next.content;
          if (next.partial) update.partial = projectedMessage(next.partial);
          if (next.error) update.error = projectedMessage(next.error);
        }
        out.assistantMessageEvent = update;
      }
      const usage = usageProjection(event.usage);
      if (usage) out.usage = usage;
    }
    return out;
  }
  if (['compaction_start', 'compaction_end'].includes(event?.type)) {
    const type = event.type, reason = ['manual', 'threshold', 'overflow'].includes(event.reason) ? event.reason : undefined;
    return { type, reason, bridgeRun: event.bridgeRun, ...(activity ? { activity } : {}),
      ...(type === 'compaction_end' ? { aborted: event.aborted === true, willRetry: event.willRetry === true,
        ...(typeof event.success === 'boolean' ? { success: event.success } : {}),
        ...(event.errorMessage || event.error ? { errorMessage: '上下文压缩失败' } : {}) } : {}) };
  }
  const out = { ...event };
  /* Older nested envelopes did not pass through the same tool-aware map. */
  delete out.activity;
  delete out.detailRef;
  delete out.execution;
  if (Object.hasOwn(out, 'generationResult')) {
    const result = projectedGenerationResult(out.generationResult);
    if (result) out.generationResult = result;
    else delete out.generationResult;
  }
  if (out.message) out.message = projectedMessage(out.message);
  if (Array.isArray(out.messages)) out.messages = out.messages.map(projectedMessage);
  if (Array.isArray(out.toolResults)) out.toolResults = out.toolResults.map(projectedMessage);
  if (out.type === 'entry_appended') return { type: out.type, bridgeRun: out.bridgeRun, entry: projectRuntimeEntry(out.entry) };
  if (out.type === 'response' && ['get_entries', 'get_tree'].includes(out.command)) out.data = projectRuntimeEntryRead(out.command, out.data);
  else if (Array.isArray(out.data?.messages)) out.data = { ...out.data, messages: out.data.messages.map(projectedMessage) };
  return out;
}

export async function createSessionRuntime({ context, emit, piBin = 'pi', env = process.env, dataDir,
  guiPort = () => null, browser = null, processAdmission = () => true, readModelsConfig = () => null,
  sessionDir = null, extraArgs = [], supervisorFactory = createPiSupervisor, createChanges = null, mutationAdmission = null, toolScheduler = null, candidateAudit = null,
  captureProviderLaunch = null, htmlArtifactStore = null, htmlPublication = null } = {}) {
  const runtime = createRuntime({ initialCwd: context.cwd });
  const launch = createPiLaunch({ piBin, env, getCwd: () => context.cwd });
  const entry = launch.cliEntry();
  if (!entry?.ok || entry.kind !== 'node' || !fs.statSync(entry.entryPath).isFile()) throw fail('pi_entry_unproven');
  // SEA is not a Node script runner. Resolve the same Node executable the npm
  // launch uses; Electron backend already runs with ELECTRON_RUN_AS_NODE.
  const node = isSea() ? resolveExecutable('node', [], env).command : process.execPath;
  const supervisor = supervisorFactory({ node });
  const activity = createPiActivity(), generation = createModelGeneration(), approvals = new Map();
  const executionTools = createExecutionToolProjection();
  let rpc, disposed = false, cleanup = false, disposal = null;
  function captureGuard(sessionId) {
    const state = rpc.getState();
    return {owner:{...context.getOwner()},sessionId,cwd:context.cwd,bridgeInstance:state.bridgeInstance,bridgeRun:state.bridgeRun,pid:state.pid,
      sessionEpoch:rpc.providerSessionEpoch()};
  }
  function guardCurrent(witness, changing = false) {
    if (!witness || disposed || !context.isCurrent() || witness.cwd !== context.cwd) return false;
    const state = rpc.getState(), owner = context.getOwner();
    return ['starting','ready'].includes(state.state) && state.piRunning && !state.stop?.pending && rpc.providerSessionChanging() === changing
      && state.bridgeInstance === witness.bridgeInstance && state.bridgeRun === witness.bridgeRun && state.pid === witness.pid && rpc.providerSessionEpoch() === witness.sessionEpoch
      && (owner.sessionId === null || owner.sessionId === witness.sessionId)
      && Object.entries(witness.owner).every(([key,value]) => key === 'sessionId' && value === null
        ? owner.sessionId === null || owner.sessionId === witness.sessionId : owner[key] === value);
  }
  function guardAdvance(previous, witness) {
    // Runtime owners are authoritative (unlike Classic's readback cache). Do not
    // erase or rebind a known owner merely because Pi changed native sessions.
    return Boolean(previous && witness && witness.sessionEpoch > previous.sessionEpoch
      && previous.sessionId === witness.sessionId && previous.cwd === witness.cwd
      && previous.bridgeInstance === witness.bridgeInstance && previous.bridgeRun === witness.bridgeRun && previous.pid === witness.pid
      && Object.entries(previous.owner).every(([key,value]) => key === 'sessionId' && value === null
        ? witness.owner.sessionId === null || witness.owner.sessionId === witness.sessionId : witness.owner[key] === value));
  }
  const toolGuard = toolScheduler ? createSessionToolBridge({scheduler:toolScheduler,launch,getCwd:()=>context.cwd,getRoot:()=>context.workspace.root,
    readState:()=>rpc.request({type:'get_state'},{timeoutMs:1000,strict:true}),capture:captureGuard,isCurrent:guardCurrent,
    canRevalidate:(previous,witness) => guardAdvance(previous,witness) && guardCurrent(witness),onEvent:emit,audit:candidateAudit}) : null;
  const htmlBridge = htmlArtifactStore ? createHtmlRenderBridge({ store: htmlArtifactStore, publication: htmlPublication,
    launch, getCwd: () => context.cwd, capture: captureGuard, isCurrent: guardCurrent,
    scopeForWitness: witness => ({ kind: 'runtime', owner: { ...witness.owner, sessionId: witness.sessionId } }),
    canRevalidate: (previous, witness) => guardAdvance(previous, witness) && guardCurrent(witness),
    readState: () => rpc.request({ type: 'get_state' }, { timeoutMs: 1500, strict: true }),
    readEntries: () => rpc.request({ type: 'get_entries' }, { timeoutMs: 1500, strict: true }),
  }) : null;
  const planBridge = createPlanBridge();
  const editLaunch = createMessageEditLaunch();
  const messageEdit = createMessageEditService({ publish: event => emit(event) });
  const managed = createProcessBridge({ runtime, launch, getRpcState: () => rpc?.getState() || {}, guiPort, processAdmission, mutationAdmission });
  const changes = createChanges?.({ runtime, launch, context, requestState: () => rpc.request({ type: 'get_state' }) }) || null;
  // Another session may be writing this same project. Its launch must not
  // synchronize a shared project instruction file outside the tool queue.
  const promptDir = context.workspace?.workspaceId?.startsWith('project-') || candidateAudit ? fs.mkdtempSync(path.join(os.tmpdir(),'pi-gui-runtime-prompt-')) : null;
  const promptFile = promptDir ? path.join(promptDir,'instructions.md') : null;
  const config = createProjectConfig({ runtime, env, restartPi: () => rpc.restart(), instructionsFile:promptFile });
  const sessions = createSessions({ runtime, env, dataDir, extraSessionRoots: sessionDir ? [sessionDir] : [] });
  const launchOptions = { ...config, launchArgs() { const value = config.launchArgs(); return { ...value, args: [...value.args, ...(sessionDir ? ['--session-dir', sessionDir] : []), ...extraArgs] }; },
    prepareLaunch() { const value = config.prepareLaunch(); return { ...value, args: [...value.args, ...(sessionDir ? ['--session-dir', sessionDir] : []), ...extraArgs] }; } };
  let resumeFile = null;
  if (context.sessionId) {
    const target = sessions.resolveByUuid(context.sessionId);
    if (!target || (context.sessionLocator && fs.realpathSync(target.file) !== context.sessionLocator)) {
      await managed.dispose(); await supervisor.dispose(); throw fail('session_unavailable');
    }
    resumeFile = target.file;
  }
  rpc = createRpcBridge({ runtime, launch: { ...launch, bin: node }, piBin: node, isWin: false,
    autoRestart: false,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1', PI_NO_CONTINUE: '1' }, projectLaunch: launchOptions,
    browserLaunch: browser, processLaunch: managed, sessionChangeLaunch: changes, toolLaunch: toolGuard, planLaunch: planBridge,
    editLaunch, htmlLaunch: htmlBridge,
    spawnProcess: (_command, args, opts) => supervisor.spawnProcess(node, [...entry.baseArgs, ...args], { ...opts, shell: false }),
    killProcessTree: supervisor.killProcessTree,
    captureProviderLaunch: captureProviderLaunch && (scope => captureProviderLaunch(scope, launch, entry)),
    publish(event) {
      if (disposed || !context.isCurrent() || EXECUTION_OBSERVATIONS.has(event.type)) return;
      managed.observe(event); changes?.observe(event); activity.observe(event);
      toolGuard?.observe(event);
      /* 编辑事务的接受证据：request 应答不广播，事件是超时后确认归属的补充。 */
      try { messageEdit.observe(event, rpc.getState()?.sessionId || null); } catch { /* observation only */ }
      if (event.type === 'extension_ui_request' && typeof event.id === 'string') {
        if (approvals.size >= 32) approvals.delete(approvals.keys().next().value);
        approvals.set(event.id, event.method);
      }
      if (event.type === 'agent_settled' || event.type === 'bridge_status' && event.state !== 'ready') approvals.clear();
      // Ownership fields are generated on this side of the child protocol.
      const projected = projectProcessEvent(event);
      const { generationRequestId: _request, generationResult: _result, ...native } = projected;
      emit(projectRuntimeEvent(generation.observe(sanitizeModelEvent(native,
        event.type === 'response' && ['get_state', 'get_available_models', 'set_model', 'cycle_model'].includes(event.command) ? readModelsConfig() : null)), executionTools.observe(event)));
    },
  });
  // Admission may follow open() before asynchronous launch preparation even
  // installs the guard. Wait only for this child's control-plane startup, never
  // for its model turn; source capability and native hello remain mandatory.
  async function assertToolGuardReady() {
    const expected = { ...context.getOwner() }, guardRevision = toolGuard?.revision();
    const current = () => {
      const owner = context.getOwner();
      return !disposed && context.isCurrent() && guardRevision === toolGuard?.revision() && Object.entries(expected).every(([key, value]) =>
        key === 'sessionId' && value === null || owner[key] === value);
    };
    const deadline = Date.now() + 30000;
    while (current() && Date.now() < deadline && (rpc.getState().state === 'starting'
      || rpc.getState().state === 'ready' && !context.getOwner().sessionId)) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!current()) throw fail('stale_runtime');
    if (!toolGuard || rpc.getState().state !== 'ready') throw fail('tool_guard_unavailable');
    const proof = await toolGuard.assertReady();
    if (!current() || typeof proof !== 'function' || !proof()) throw fail('stale_runtime');
    if (!toolGuard.ready(context.cwd, context.getOwner().sessionId)) throw fail('tool_guard_unavailable');
    const proven = captureGuard(context.getOwner().sessionId);
    return () => proof() && guardRevision === toolGuard.revision() && guardCurrent(proven) && rpc.getState().state === 'ready'
      && toolGuard.ready(context.cwd, proven.sessionId);
  }
  return {
    assertToolGuardReady,
    captureCommandGuard: rpc.captureCommandGuard,
    providerLaunch: rpc.providerLaunch,
    providerLaunchCurrent: witness => witness?.binding.identity === launch.identityKey(),
    providerRead: type => rpc.request({ type }, { timeoutMs: 3000, strict: true }),
    providerSession: (state, identity) => runtimeSessionWitness(state, sessions.resolveByUuid, identity),
    start: async () => {
      if (resumeFile) return rpc.restart({ sessionPath: resumeFile });
      const result = await rpc.start();
      /* 新建会话的 HTTP start 等待这里；rpc.start() 对 spawn 失败给出结构化
       * 结果，不能让它继续以「已启动」返回。历史恢复仍走事件推进。 */
      if (result?.ok === false && result.code === 'runtime_start_failed') throw fail('runtime_start_failed');
    },
    executionBranch: (scope, branchEpoch, detailTarget, onVerifiedPath) => readExecutionBranch({
      scope, branchEpoch, detailTarget, onVerifiedPath,
      readState: () => rpc.request({ type: 'get_state' }, { timeoutMs: 3000, strict: true }),
      readEntries: () => rpc.request({ type: 'get_entries' }, { timeoutMs: 3000, strict: true }),
      isCurrent: expected => !disposed && context.isCurrent() && expected.kind === 'runtime' &&
        Object.entries(expected.owner).every(([key, value]) => context.getOwner?.()?.[key] === value),
    }),
    getState: rpc.getState, request: async cmd => {
      if (disposed || !context.isCurrent()) throw fail('stale_runtime');
      const result = await rpc.request(cmd);
      if (disposed || !context.isCurrent()) throw fail('stale_runtime');
      if (!result) throw fail('pi_request_unconfirmed');
      // Private RPC requests encode native failure as __error. Never turn that
      // object into a successful public model/state read or expose its text.
      if (Object.hasOwn(result, '__error')) throw fail('pi_request_failed');
      return projectRuntimeEvent(generation.observe(sanitizeModelEvent({ type: 'response', command: cmd.type, success: true, data: result },
        ['get_state', 'get_available_models'].includes(cmd.type) ? readModelsConfig() : null))).data;
    },
    async send(cmd) {
      if (disposed || !context.isCurrent()) throw fail('stale_runtime');
      const admissionGuard = rpc.captureCommandGuard(cmd);
      let guardProof = null;
      if (context.workspace?.workspaceId?.startsWith('project-') && ['prompt','steer','follow_up'].includes(cmd.type)) {
        if (!toolGuard) throw fail('tool_guard_unavailable');
        guardProof = await assertToolGuardReady();
      }
      if (changes && cmd.type === 'prompt' && cmd.message?.trim() === '/gui-capture disable') return changes.disable();
      if (['prompt', 'steer', 'follow_up'].includes(cmd.type) && !(cmd.type === 'prompt' && cmd.message?.trim() === '/gui-capture disable')) await changes?.assertReady();
      if (disposed || !context.isCurrent() || guardProof && !guardProof()) throw fail('stale_runtime');
      admissionGuard?.();
      cmd = { ...cmd, id: typeof cmd.id === 'string' ? cmd.id : randomUUID() };
      if (cmd.type === 'extension_ui_response') {
        if (!approvals.has(cmd.id)) throw fail('stale_approval');
        approvals.delete(cmd.id);
      }
      generation.guardCommand(cmd);
      if (['prompt', 'steer', 'follow_up'].includes(cmd.type)) mutationAdmission?.assertAllowed(context.cwd);
      const { __fallbackOwner, ...wire } = cmd;
      const result = rpc.send(wire); generation.noteCommandAccepted(cmd); activity.noteCommandAccepted(cmd);
      const submission = executionSubmission(cmd);
      if (submission) emit({ ...submission, bridgeRun: rpc.getState().bridgeRun });
      if (['prompt','steer','follow_up'].includes(cmd.type)) toolGuard?.resume();
      return result;
    },
    abortAndWait: cmd => rpc.abortAndWait(cmd), activity, managed, changes, toolGuard,
    messageEdit,
    messageEditCommand: () => editLaunch.command(),
    messageEditToken: () => editLaunch.token(),
    async messageEditRequest(cmd, executionEdit = null) {
      if (disposed || !context.isCurrent()) return { ok: false, code: 'stale_runtime', unknown: true };
      const { __messageEditNav, ...wire } = cmd || {};
      const nav = __messageEditNav === true;
      const admissionGuard = nav ? null : rpc.captureCommandGuard(wire);
      let guardProof = null;
      /* 导航命令只是移动 leaf，不开 run；真正的重发 prompt 必须走与普通
       * prompt 相同的工具闸门、变更采集闸门与互斥写入闸门，不能借编辑通道
       * 绕过权限/审批或与文件撤销并发。 */
      try {
        if (!nav && wire?.type === 'prompt') {
          if (context.workspace?.workspaceId?.startsWith('project-') && toolGuard) guardProof = await assertToolGuardReady();
          if (context.workspace?.workspaceId?.startsWith('project-') && !toolGuard) return { ok: false, code: 'tool_guard_unavailable' };
          await changes?.assertReady?.();
          if (disposed || !context.isCurrent() || guardProof && !guardProof()) throw fail('stale_runtime');
          admissionGuard?.();
          generation.guardCommand(wire);
          mutationAdmission?.assertAllowed(context.cwd);
        }
      } catch (error) {
        return { ok: false, code: error?.code || 'edit_unavailable' };
      }
      // A lost navigation response cannot prove the old leaf is still active.
      if (nav) {
        const boundary = { type: 'execution_branch', bridgeRun: rpc.getState().bridgeRun };
        executionTools.observe(boundary);
        emit(boundary);
      }
      const result = await rpc.request(wire);
      if (disposed || !context.isCurrent()) return { ok: false, code: 'stale_runtime', unknown: true };
      if (result === null) return { ok: false, code: 'pi_timeout', unknown: true };
      if (Object.hasOwn(result, '__error')) return { ok: false, code: result.__code || 'pi_request_failed', unknown: false };
      if (!nav && wire?.type === 'prompt' && result.disposition === 'started') {
        const submission = executionSubmission({ ...wire, id: executionEdit?.requestId }, executionEdit?.targetEntryId);
        if (submission) emit({ ...submission, bridgeRun: rpc.getState().bridgeRun });
        generation.noteCommandAccepted(wire);
        activity.noteCommandAccepted(wire);
        toolGuard?.resume();
      }
      return { ok: true, data: result };
    },
    async sessionLocator(state) {
      const target = sessions.resolveByUuid(state.sessionId);
      return target && (!state.sessionFile || path.resolve(target.file) === path.resolve(state.sessionFile)) ? fs.realpathSync(target.file) : null;
    },
    cleanupConfirmed: () => cleanup,
    updateBusy: () => rpc.updateBusy(),
    dispose() {
      if (disposal) return disposal;
      disposed = true; runtime.setShuttingDown(true); rpc.stop();
      try { messageEdit.dispose(); } catch { /* observation only */ }
      disposal = (async () => {
        await Promise.all([supervisor.dispose(), managed.dispose(), browser?.dispose?.(), changes?.dispose(), toolGuard?.dispose(), htmlBridge?.dispose()]);
        changes?.confirmWritersStopped();
        toolGuard?.confirmCleanup();
        if (promptFile) { try { fs.rmSync(promptFile,{force:true});fs.rmdirSync(promptDir); } catch { /* only owned temporary prompt files */ } }
        cleanup = true;
      })(); return disposal;
    },
  };
}
