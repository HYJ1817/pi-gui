import fs from 'node:fs';
import path from 'node:path';
import { createRuntime } from './runtime.js';
import { createPiLaunch } from './pi-launch.js';
import { createRpcBridge } from './rpc-bridge.js';
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

const fail = code => Object.assign(Error(code), { code });
// This narrow surface projects tool activity. Raw args/result/worker diagnostics
// stay in Pi; message text is intentional conversation content, not diagnostics.
export function projectRuntimeEvent(event) {
  if (event?.type === 'response' && event.success === false && ['set_thinking_level', 'cycle_thinking_level'].includes(event.command)) {
    const response = { type: 'response', command: event.command, success: false, error: 'Pi 未能完成思考级别操作；请检查模型配置后重试。' };
    if (typeof event.id === 'string' || typeof event.id === 'number') response.id = event.id;
    if (Number.isInteger(event.bridgeRun)) response.bridgeRun = event.bridgeRun;
    return response;
  }
  if (['bridge_stderr', 'bridge_parse_error'].includes(event?.type)) return { type: event.type, bridgeRun: event.bridgeRun };
  if (event?.type === 'extension_error') return { type: event.type, error: '扩展执行或加载失败', bridgeRun: event.bridgeRun };
  if (event?.type?.startsWith('tool_execution_')) return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
    isError: event.isError === true, bridgeRun: event.bridgeRun };
  function message(m) {
    if (!m || typeof m !== 'object') return m;
    if (m.role === 'toolResult') return { role: m.role, toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError === true, content: [] };
    return { ...m, content: Array.isArray(m.content) ? m.content.map(c => c?.type === 'toolCall' ? { type: c.type, id: c.id, name: c.name } : c) : m.content };
  }
  const out = { ...event };
  if (out.message) out.message = message(out.message);
  if (out.assistantMessageEvent?.partial) out.assistantMessageEvent = { ...out.assistantMessageEvent, partial: message(out.assistantMessageEvent.partial) };
  if (out.assistantMessageEvent?.type?.startsWith('toolcall_')) out.assistantMessageEvent = { type: out.assistantMessageEvent.type, contentIndex: out.assistantMessageEvent.contentIndex };
  if (Array.isArray(out.data?.messages)) out.data = { ...out.data, messages: out.data.messages.map(message) };
  return out;
}

export async function createSessionRuntime({ context, emit, piBin = 'pi', env = process.env, dataDir,
  guiPort = () => null, browser = null, processAdmission = () => true, readModelsConfig = () => null,
  sessionDir = null, extraArgs = [], supervisorFactory = createPiSupervisor } = {}) {
  const runtime = createRuntime({ initialCwd: context.cwd });
  const launch = createPiLaunch({ piBin, env, getCwd: () => context.cwd });
  const entry = launch.cliEntry();
  if (!entry?.ok || entry.kind !== 'node' || !fs.statSync(entry.entryPath).isFile()) throw fail('pi_entry_unproven');
  // SEA is not a Node script runner. Resolve the same Node executable the npm
  // launch uses; Electron backend already runs with ELECTRON_RUN_AS_NODE.
  const node = isSea() ? resolveExecutable('node', [], env).command : process.execPath;
  const supervisor = supervisorFactory({ node });
  const activity = createPiActivity(), generation = createModelGeneration(), approvals = new Map();
  let rpc, disposed = false, cleanup = false, disposal = null;
  const managed = createProcessBridge({ runtime, launch, getRpcState: () => rpc?.getState() || {}, guiPort, processAdmission });
  const config = createProjectConfig({ runtime, env, restartPi: () => rpc.restart() });
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
    browserLaunch: browser, processLaunch: managed,
    spawnProcess: (_command, args, opts) => supervisor.spawnProcess(node, [...entry.baseArgs, ...args], { ...opts, shell: false }),
    killProcessTree: supervisor.killProcessTree,
    publish(event) {
      if (disposed || !context.isCurrent()) return;
      managed.observe(event); activity.observe(event);
      if (event.type === 'extension_ui_request' && typeof event.id === 'string') {
        if (approvals.size >= 32) approvals.delete(approvals.keys().next().value);
        approvals.set(event.id, event.method);
      }
      if (event.type === 'agent_settled' || event.type === 'bridge_status' && event.state !== 'ready') approvals.clear();
      emit(projectRuntimeEvent(generation.observe(sanitizeModelEvent(projectProcessEvent(event),
        event.type === 'response' && ['get_state', 'get_available_models', 'set_model', 'cycle_model'].includes(event.command) ? readModelsConfig() : null))));
    },
  });
  return {
    start: () => resumeFile ? rpc.restart({ sessionPath: resumeFile }) : rpc.start(),
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
    send(cmd) {
      if (disposed || !context.isCurrent()) throw fail('stale_runtime');
      cmd = { ...cmd, id: typeof cmd.id === 'string' ? cmd.id : randomUUID() };
      if (cmd.type === 'extension_ui_response') {
        if (!approvals.has(cmd.id)) throw fail('stale_approval');
        approvals.delete(cmd.id);
      }
      generation.guardCommand(cmd);
      const { __fallbackOwner, ...wire } = cmd;
      const result = rpc.send(wire); generation.noteCommandAccepted(cmd); activity.noteCommandAccepted(cmd); return result;
    },
    abortAndWait: cmd => rpc.abortAndWait(cmd), activity, managed,
    async sessionLocator(state) {
      const target = sessions.resolveByUuid(state.sessionId);
      return target && (!state.sessionFile || path.resolve(target.file) === path.resolve(state.sessionFile)) ? fs.realpathSync(target.file) : null;
    },
    cleanupConfirmed: () => cleanup,
    dispose() {
      if (disposal) return disposal;
      disposed = true; runtime.setShuttingDown(true); rpc.stop();
      disposal = (async () => {
        await Promise.all([supervisor.dispose(), managed.dispose(), browser?.dispose?.()]);
        cleanup = true;
      })(); return disposal;
    },
  };
}
