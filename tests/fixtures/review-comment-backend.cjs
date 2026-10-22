/* Bounded loopback persistence contract for UI-only fixtures. Real disk and
 * authority are covered by review-comment-store/http/authority suites. */
const { createHash, randomUUID } = require('node:crypto');
module.exports = function reviewBackend(classicScope = () => 'classic') {
  const disk = new Map();
  return { disk, error: null, hold: null,
    async response(options = {}) {
      const key = options.headers?.['X-Pi-Gui-Conversation'] || classicScope();
      const scope = createHash('sha256').update(key).digest('hex'), token = 'd'.repeat(64);
      let state = disk.get(key) || { revision: null, comments: [] }, answer;
      if (options.method === 'POST') {
        const body = JSON.parse(options.body);
        if (this.error) answer = { ok: false, code: this.error };
        else if (body.scope !== scope || body.token !== token) answer = { ok: false, code: 'comment_scope_unavailable' };
        else if (body.revision !== state.revision) answer = { ok: false, code: 'comment_conflict' };
        else { state = { revision: randomUUID(), comments: structuredClone(body.comments) }; disk.set(key, state); }
      }
      answer ||= { ok: true, scope, token, ...structuredClone(state) };
      if (this.hold) await this.hold();
      return { status: answer.ok ? 200 : 409, json: async () => answer };
    },
  };
};
