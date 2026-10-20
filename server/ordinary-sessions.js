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
  async function validate(expected) {
    const current=await workspaceFor(expected.cwd);
    if(Object.keys(current).some(k=>current[k]!==expected[k]))fail('stale_workspace');
    return current;
  }
  return {
    workspaceFor, validate,
    async withWorkspace(identity,action) {
      for(const p of getProjects()) {
        const workspace=await workspaceFor(p.path);
        if(workspace.workspaceId===identity.id) {
          if(workspace.workspaceEpoch!==identity.epoch)fail('stale_workspace');
          return action(workspace);
        }
      }
      fail('unknown_workspace');
    },
    async open(args) {
      if(!closed(args,['project','session','requestId','allowThird']) || typeof args.project!=='string'
        || (args.session!=null && (typeof args.session!=='string'||!/^[a-f0-9]{16}$/.test(args.session)))
        || (args.requestId!==undefined && (typeof args.requestId!=='string'||!/^[a-f\d-]{36}$/.test(args.requestId))))fail('invalid_request');
      if(args.session==null&&!args.requestId)fail('invalid_request');
      const workspace=await workspaceFor(args.project);
      const target=args.session ? sessions.resolveProjectSession(args.session,args.project) : null;
      if(args.session && !target)fail('session_unavailable');
      if(target && await currentNative()===target.sessionId)fail('session_in_use');
      let identity=null,locator=null;
      if(target) {const stat=fs.statSync(target.file);identity={dev:stat.dev,ino:stat.ino,birthtimeMs:stat.birthtimeMs};locator=fs.realpathSync(target.file);}
      return getRegistry().openProjectSession({workspace,sessionId:target?.sessionId||null,sessionLocator:locator,sessionIdentity:identity,
        sessionName:target?.title||'新会话',...(args.requestId?{requestId:args.requestId}:{})},{allowThird:args.allowThird===true});
    },
  };
}
