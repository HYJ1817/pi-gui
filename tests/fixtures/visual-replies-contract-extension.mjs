// Contract-only adapter in a real external Pi --mode rpc. No model turn.
// Public newSession(setup) creates a synthetic TEMP declaration; the subsequent
// command uses the NEW runtime's definition/context, never a stale closure.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export default async function contract(pi) {
  const world = process.env.VISUAL_REPLIES_WORLD;
  const { installHtmlRender } = await import(pathToFileURL(process.env.VISUAL_REPLIES_BUNDLED_EXTENSION).href);
  const input = JSON.parse(fs.readFileSync(path.join(world, 'contract-input.json'), 'utf8'));
  let definition;
  installHtmlRender({ on: (...args) => pi.on(...args), registerTool(tool) { definition = tool; pi.registerTool(tool); } }, {
    url: process.env.PI_GUI_HTML_URL, token: process.env.PI_GUI_HTML_TOKEN,
  });
  pi.registerCommand('vr-contract-setup', {
    description: 'Create synthetic TEMP declaration using public SessionManager; no model',
    handler: async (_args, ctx) => {
      await ctx.newSession({ setup: async manager => {
        manager.appendMessage({ role: 'user', content: '[CONTRACT FIXTURE; not a model request]', timestamp: Date.now() });
        manager.appendMessage({ role: 'assistant', api: 'fixture-contract', provider: 'fixture', model: 'no-model',
          content: [{ type: 'toolCall', id: 'vr-contract-call', name: 'html_render', arguments: input }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: Date.now() });
      } });
    },
  });
  pi.registerCommand('vr-contract', {
    description: 'Execute registered bundled handler in fresh real context; no model',
    handler: async (_args, ctx) => {
      const info = pi.getAllTools().find(tool => tool.name === 'html_render');
      const report = { schemaVersion: 1, discovered: Boolean(info), parameters: Boolean(info?.parameters), modelCalls: 0,
        execution: 'registered-definition-in-real-extension-command-context', syntheticAssistantSetup: true };
      try {
        if (!info || !definition) throw Error('tool_not_registered');
        const result = await definition.execute('vr-contract-call', input, undefined, undefined, ctx);
        report.ok = result.details?.ok === true && result.isError !== true;
        report.details = result.details;
        report.nativeSessionId = ctx.sessionManager.getSessionId();
      } catch { report.ok = false; report.failure = 'contract_execution_failed'; }
      fs.writeFileSync(path.join(world, 'contract-result.json'), JSON.stringify(report), { flag: 'wx', mode: 0o600 });
    },
  });
  pi.registerCommand('vr-contract-quit', { description: 'Stop TEMP contract process', handler: async (_args, ctx) => ctx.shutdown() });
}
