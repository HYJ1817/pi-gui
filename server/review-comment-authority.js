import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { canonicalPath, normalizeForCompare } from '../lib/safe-path.js';
import { repository, adminDirectory } from '../lib/git-worktree.js';

const fail = () => { throw Object.assign(Error('comment_scope_unavailable'), { code: 'comment_scope_unavailable' }); };
const equal = (a, b) => a && b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = p => normalizeForCompare(canonicalPath(p));
function fileFact(p, directory) {
  const s = fs.lstatSync(p);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) fail();
  return [normalized(p), s.dev, s.ino, s.birthtimeMs];
}
function expectedOwner(req) {
  const raw = req.headers?.['x-pi-gui-owner'];
  if (typeof raw !== 'string' || raw.length > 4096) fail();
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value;
}

/* Dependencies are backend-only authorities, injected by server.js. The
 * client supplies a current owner expectation, never a native locator/cwd. */
export function createReviewCommentAuthority({ classic, registry, withWorkspace } = {}) {
  const secret = randomBytes(32);
  const contextRevision = () => registry.contextRevision?.() ?? 0;
  async function facts(cwd) {
    const repo = await repository(cwd), admin = await adminDirectory(repo.root);
    const directories = [...new Set([canonicalPath(cwd), repo.root, repo.common, admin])];
    const evidence = directories.map(p => fileFact(p, true));
    return { root: repo.root, common: repo.common, evidence,
      verify() { if (JSON.stringify(directories.map(p => fileFact(p, true))) !== JSON.stringify(evidence)) fail(); } };
  }
  function sessionFacts(file) {
    const evidence = fileFact(file, false);
    return { evidence, verify() { if (JSON.stringify(fileFact(file, false)) !== JSON.stringify(evidence)) fail(); } };
  }
  function scopeFor({ workspace, native, session, requestOwner, current, stable, revision }) {
    const key = digest(['review-comments-v1', stable, workspace.evidence, native, session.evidence]);
    const token = createHmac('sha256', secret).update(JSON.stringify([key,
      Object.keys(requestOwner).sort().map(k => [k, requestOwner[k]]), revision])).digest('hex');
    return { key, token, projectRoot: workspace.root, gitCommon: workspace.common,
      assertCurrent() { current(); workspace.verify(); session.verify(); } };
  }
  return async function withAuthority(req, action) {
    try {
      const expected = expectedOwner(req), id = req.headers?.['x-pi-gui-conversation'];
      if (id !== undefined) {
        if (typeof id !== 'string' || !id || registry.snapshot().focusedConversationId !== id) fail();
        const owner = registry.getOwner(id);
        if (!equal(expected, owner)) fail();
        // Registry.read validates the workspace itself. Do this before holding
        // the Worktree lifecycle lock to avoid recursively waiting on it.
        const state = await registry.read(owner, { type: 'get_state' });
        const identity = registry.workspaceIdentityOf(id), target = registry.historyTarget(id), revision = contextRevision();
        if (!identity || !target?.sessionId || !target.sessionLocator || state?.sessionId !== target.sessionId
          || owner.sessionId !== target.sessionId || !state.sessionFile || normalized(state.sessionFile) !== normalized(target.sessionLocator)) fail();
        const session = sessionFacts(target.sessionLocator);
        if (target.sessionIdentity && ['dev', 'ino', 'birthtimeMs'].some((k, i) => target.sessionIdentity[k] !== session.evidence[i + 1])) fail();
        return await withWorkspace(identity, async w => {
          const workspace = await facts(w.cwd);
          if (normalized(w.root) !== normalized(workspace.root)) fail();
          const current = () => {
            if (registry.snapshot().focusedConversationId !== id || contextRevision() !== revision || !equal(owner, registry.getOwner(id))) fail();
            const now = registry.historyTarget(id), wi = registry.workspaceIdentityOf(id);
            if (!now || now.sessionId !== target.sessionId || now.sessionLocator !== target.sessionLocator
              || !equal(identity, wi)) fail();
          };
          const scope = scopeFor({ workspace, native: target.sessionId, session, requestOwner: owner, current, revision,
            stable: ['conversation', id, w.projectId, w.repoId, w.workspaceId, w.workspaceEpoch] });
          scope.assertCurrent(); return action(scope);
        });
      }
      const cwd = classic.cwd(), generation = classic.generation(), owner = classic.owner(), revision = contextRevision();
      if (!cwd || registry.snapshot().focusedConversationId || !equal(expected, owner) || !owner.sessionId) fail();
      return await classic.withWorkspace(cwd, async () => {
        const state = await classic.state();
        if (!state?.sessionId || state.sessionId !== owner.sessionId || !state.sessionFile) fail();
        const target = classic.resolveSession(state.sessionId);
        if (!target || target.sessionId !== state.sessionId || normalized(target.cwd) !== normalized(cwd)
          || normalized(target.file) !== normalized(state.sessionFile)) fail();
        const session = sessionFacts(target.file), workspace = await facts(cwd);
        // Git identity checks awaited child processes; independently read back
        // the current native session once more before any synchronous commit.
        const confirmed = await classic.state();
        if (confirmed?.sessionId !== state.sessionId || !confirmed.sessionFile || normalized(confirmed.sessionFile) !== normalized(target.file)) fail();
        const current = () => {
          if (classic.cwd() !== cwd || classic.generation() !== generation || registry.snapshot().focusedConversationId
            || contextRevision() !== revision || !equal(owner, classic.owner())) fail();
        };
        const scope = scopeFor({ workspace, native: state.sessionId, session, requestOwner: owner, current, revision, stable: ['classic'] });
        scope.assertCurrent(); return action(scope);
      });
    } catch (e) {
      if (typeof e?.code === 'string' && e.code.startsWith('comment_')) throw e;
      fail();
    }
  };
}
