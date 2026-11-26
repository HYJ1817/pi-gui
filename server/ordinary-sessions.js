import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalPath, normalizeForCompare } from '../lib/safe-path.js';
import { repository } from '../lib/git-worktree.js';

const fail = code => { throw Object.assign(Error(code), { code }); };
const hash = v => createHash('sha256').update(v).digest('hex').slice(0,24);
const same = (a,b) => normalizeForCompare(a) === normalizeForCompare(b);
const closed = (v,keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k=>keys.includes(k));
export const isProjectWorkspace = w => typeof w?.workspaceId === 'string' && w.workspaceId.startsWith('project-');
export const rootsOverlap = (a,b) => {
  const inside = (x,y) => {const p=path.relative(x,y);return !p || p!=='..'&&!p.startsWith('..'+path.sep)&&!path.isAbsolute(p);};
  return inside(normalizeForCompare(a),normalizeForCompare(b)) || inside(normalizeForCompare(b),normalizeForCompare(a));
};
// Shared project admission waits for the existing child's bounded startup
// proof, not for its model turn. Non-overlapping projects never wait here.
export async function assertSharedSessionTools(workspace, others, primary = null) {
  const proofs = [];
  for (const other of others) if (rootsOverlap(other.workspace.root, workspace.root)) {
    if (!isProjectWorkspace(other.workspace)) fail('workspace_in_use');
    if (!other.adapter?.assertToolGuardReady) fail('tool_guard_unavailable');
    const proof = await other.adapter.assertToolGuardReady();
    if (typeof proof !== 'function') fail('tool_guard_unavailable');
    proofs.push(proof);
  }
  if (primary) {
    const cwd = primary.getCwd(), expected = { ...primary.getOwner() }, sessionEpoch = primary.getSessionEpoch();
    // Private switch/new/fork replies do not publish get_state or refresh the
    // owner cache. The RPC epoch changes synchronously when mutation is sent.
    const current = () => !primary.isShuttingDown() && !primary.isSessionChanging()
      && primary.getCwd() === cwd && primary.getSessionEpoch() === sessionEpoch
      && Object.entries(expected).every(([key, value]) => key === 'sessionId' && value === null || primary.getOwner()[key] === value);
    const overlaps = Boolean(cwd && rootsOverlap(await (primary.getRoot || toolWorkspaceRoot)(cwd), workspace.root));
    if (!current()) fail('tool_guard_unavailable');
    let native = null;
    if (overlaps) {
      const deadline = Date.now() + 30000;
      while (current() && primary.getState().state === 'starting' && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 20));
      if (!current() || primary.getState().state !== 'ready') fail('tool_guard_unavailable');
      await primary.assertReady();
      native = (await primary.readState())?.sessionId;
      if (!current() || typeof native !== 'string' || !native || !primary.ready(cwd, native)) fail('tool_guard_unavailable');
    }
    const proven = { ...primary.getOwner() };
    // Even a non-overlapping Classic must not change cwd/launch while later
    // workspace/native validation is awaited. Never replay an old root verdict.
    proofs.push(() => !primary.isShuttingDown() && !primary.isSessionChanging()
      && primary.getCwd() === cwd && primary.getSessionEpoch() === sessionEpoch
      && Object.entries(proven).every(([key, value]) => key === 'sessionId' && value === null && overlaps
        ? primary.getOwner()[key] === null || primary.getOwner()[key] === native : primary.getOwner()[key] === value)
      && (!overlaps || primary.getState().state === 'ready' && primary.ready(cwd, native)));
  }
  const current = () => proofs.every(proof => proof());
  if (!current()) fail('tool_guard_unavailable');
  return current;
}
export async function toolWorkspaceRoot(cwd) {
  try {return canonicalPath((await repository(cwd)).root);}
  catch(e) {if(e.code!=='not_git')throw e;return canonicalPath(cwd);}
}

// Ordinary session identity is proved from registered project + native scanner.
// No renderer-supplied root, file path, native UUID or execution owner is used.
export function createOrdinarySessions({ getProjects, sessions, getRegistry, currentNative = () => null, resolveRoot = toolWorkspaceRoot } = {}) {
  async function workspaceFor(project) {
    if (typeof project !== 'string') fail('unknown_project');
    const registered=getProjects().find(p=>same(p.path,project)); if(!registered)fail('unknown_project');
    const cwd=path.resolve(registered.path),real=canonicalPath(cwd),root=await resolveRoot(cwd),st=fs.statSync(real);
    if(!st.isDirectory())fail('workspace_unavailable');
    const projectId=hash(normalizeForCompare(real));
    return {projectId,repoId:hash(normalizeForCompare(root)),workspaceId:'project-'+projectId,
      workspaceEpoch:hash(JSON.stringify([normalizeForCompare(real),st.dev,st.ino,st.birthtimeMs])),cwd,root,branch:''};
  }
  async function assertNativeAvailable(sessionId) {
    if(!sessionId)return;
    const native=await currentNative();
    if(native!==null && (typeof native!=='string'||!native))fail('session_unavailable');
    if(native===sessionId)fail('session_in_use');
  }
  async function validate(expected,sessionId=null) {
    const current=await workspaceFor(expected.cwd);
    if(Object.keys(current).some(k=>current[k]!==expected[k]))fail('stale_workspace');
    await assertNativeAvailable(sessionId);
    return current;
  }
  async function withWorkspace(identity,action) {
    for(const p of getProjects()) {
      const workspace=await workspaceFor(p.path);
      if(workspace.workspaceId===identity.id) {
        if(workspace.workspaceEpoch!==identity.epoch)fail('stale_workspace');
        return action(workspace);
      }
    }
    fail('unknown_workspace');
  }
  return {
    workspaceFor, validate, withWorkspace,
    // Backend-owned dormant record only; the renderer cannot supply a native
    // UUID or locator. Resume must re-prove the same authority as initial open.
    async withResume(target,action) {
      if(!isProjectWorkspace(target?.workspace))fail('invalid_request');
      // Resolve the target directly: an unrelated offline project must not
      // prevent restoration of this still-registered, unchanged workspace.
      return action(await validate(target.workspace,target.sessionId));
    },
    async open(args) {
      if(!closed(args,['project','session','requestId','allowThird']) || typeof args.project!=='string'
        || (args.session!=null && (typeof args.session!=='string'||!/^[a-f0-9]{16}$/.test(args.session)))
        || (args.requestId!==undefined && (typeof args.requestId!=='string'||!/^[a-f\d-]{36}$/.test(args.requestId))))fail('invalid_request');
      if(args.session==null&&!args.requestId)fail('invalid_request');
      const workspace=await workspaceFor(args.project);
      const target=args.session ? sessions.resolveProjectSession(args.session,args.project) : null;
      if(args.session && !target)fail('session_unavailable');
      await assertNativeAvailable(target?.sessionId);
      let identity=null,locator=null;
      if(target) {const stat=fs.statSync(target.file);identity={dev:stat.dev,ino:stat.ino,birthtimeMs:stat.birthtimeMs};locator=fs.realpathSync(target.file);}
      return getRegistry().openProjectSession({workspace,sessionId:target?.sessionId||null,sessionLocator:locator,sessionIdentity:identity,
        sessionName:target?.title||'新会话',...(args.requestId?{requestId:args.requestId}:{})},{allowThird:args.allowThird===true});
    },
  };
}
