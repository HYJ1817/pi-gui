// Explicit user-authorized one-generation probe. No retry, no tools, TEMP only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPiLaunch } from '../../../server/pi-launch.js';
import { createSessionRuntime } from '../../../server/session-runtime.js';

if (process.env.PI_GUI_ONE_MODEL_APPROVED !== '1') throw Error('explicit_user_approval_required');
const out = path.resolve(process.argv[2]);
if (!out.startsWith(path.resolve('designs/ui-ux-2026-10-31/evidence') + path.sep)) throw Error('invalid_output');
fs.mkdirSync(out, { recursive: true });
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-one-model-'));
const agent = path.join(world, 'agent'); fs.mkdirSync(agent);
const originalAgent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent');
const prompt = 'Reply exactly PI_GUI_UI_SMOKE_OK. Do not use tools.';
const facts = { qualification: 'one real model generation through existing SessionRuntime RPC; not complete GUI/model/tool E2E', started: new Date().toISOString(), modelCalls: 0, toolEvents: 0, checks: [], rawPayloadsStored: false };
const check = (name, ok) => { facts.checks.push({ name, ok: Boolean(ok) }); if (!ok) throw Error('check_failed'); };
const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(facts, null, 2));
const until = async (fn, timeout = 60000) => { const end = Date.now() + timeout; while (!await fn()) { if (Date.now() > end) throw Error('probe_timeout'); await new Promise(r => setTimeout(r, 100)); } };
let runtime, assistantText = '', assistantEnded = false, started = false, noUnexpectedRetry = true;
try {
  const settings = JSON.parse(fs.readFileSync(path.join(originalAgent, 'settings.json'), 'utf8'));
  const allModels = JSON.parse(fs.readFileSync(path.join(originalAgent, 'models.json'), 'utf8'));
  const provider = settings.defaultProvider, modelId = settings.defaultModel;
  const config = allModels.providers?.[provider], source = config?.models?.find(m => m.id === modelId);
  if (!config || !source || typeof config.apiKey !== 'string' || config.apiKey.startsWith('!')) throw Error('default_fixture_auth_unavailable');
  const keyRef = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(config.apiKey);
  const apiKey = keyRef ? process.env[keyRef[1]] : config.apiKey;
  if (!apiKey) throw Error('default_fixture_auth_unavailable');
  // Keep the installed provider/model protocol metadata intact, including native
  // thinkingLevelMap. Only the credential destination and model catalogue narrow.
  const model = { ...source };
  fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { [provider]: { ...config, apiKey: '$PI_GUI_UI_REVIEW_KEY', models: [model] } } }));
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: modelId, defaultThinkingLevel: 'off', cacheWarming: 'off', retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, compaction: { enabled: false } }));
  facts.provider = provider; facts.model = modelId;
  facts.promptSha256 = createHash('sha256').update(prompt).digest('hex');
  const env = { ...process.env, HOME: world, USERPROFILE: world, APPDATA: path.join(world,'roaming'), LOCALAPPDATA: path.join(world,'local'), PI_CODING_AGENT_DIR: agent, PI_GUI_UI_REVIEW_KEY: apiKey, NODE_COMPILE_CACHE: path.join(world,'node-cache'), PI_PROVIDER: provider, PI_MODEL: modelId, PI_THINKING: 'off' };
  const launch = createPiLaunch({ getCwd: () => world }); const entry = launch.cliEntry();
  check('installed official Pi Node entry is proven', entry.ok && entry.kind === 'node');
  runtime = await createSessionRuntime({ context: { cwd: world, owner: { conversationId: 'one-model-fixture' }, isCurrent: () => true },
    piBin: entry.entryPath, env, dataDir: path.join(world,'data'), sessionDir: path.join(agent,'sessions'),
    extraArgs: ['--no-tools','--no-extensions','--no-mcp','--no-skills','--no-prompt-templates','--no-themes','--no-context-files'],
    emit(event) {
      if (event.type?.startsWith('tool_execution_')) facts.toolEvents++;
      if (event.type === 'auto_retry_start') noUnexpectedRetry = false;
      if (event.type === 'agent_start') started = true;
      if (event.generationResult?.outcome) facts.generationOutcome = ['failed','completed','cancelled','aborted'].includes(event.generationResult.outcome) ? event.generationResult.outcome : 'unknown';
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        assistantText = (event.message.content || []).filter(c => c.type === 'text').map(c => c.text || '').join(''); assistantEnded = true;
        facts.assistantEnd = { stopReason: ['stop','length','toolUse','error','aborted'].includes(event.message.stopReason) ? event.message.stopReason : 'unknown', textChars: assistantText.length, hasError: typeof event.message.errorMessage === 'string' };
        const code = /\b([45]\d\d)\b/.exec(event.message.errorMessage || '');
        if (code) facts.assistantEnd.httpStatus = Number(code[1]);
      }
    } });
  save(); runtime.start();
  await until(() => runtime.getState().state === 'ready');
  const state = await runtime.request({ type: 'get_state' });
  check('Pi confirms selected default provider and model', state.model?.provider === provider && state.model?.id === modelId);
  facts.modelCalls = 1; save();
  const sent = runtime.send({ type: 'prompt', message: prompt });
  await sent;
  await until(() => assistantEnded || !noUnexpectedRetry, 90000);
  check('one native agent started and returned assistant message', started && assistantEnded);
  check('response matches the fixed fixture phrase', assistantText.trim() === 'PI_GUI_UI_SMOKE_OK');
  check('native tools were not executed', facts.toolEvents === 0);
  check('no automatic retry was observed', noUnexpectedRetry);
  facts.ok = true;
} catch (error) {
  facts.ok = false;
  facts.errorKind = ['default_fixture_auth_unavailable','probe_timeout','check_failed'].includes(error.message) ? error.message : 'verification_failed';
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.dispose();
  facts.cleanupConfirmed = !runtime || runtime.cleanupConfirmed();
  facts.ended = new Date().toISOString();
  if (facts.cleanupConfirmed && path.dirname(world) === path.resolve(os.tmpdir()) && path.basename(world).startsWith('pi-gui-one-model-')) {
    fs.rmSync(world, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); facts.tempRemoved = !fs.existsSync(world);
  }
  save(); console.log(JSON.stringify({ ok: facts.ok, modelCalls: facts.modelCalls, checks: facts.checks, toolEvents: facts.toolEvents, cleanupConfirmed: facts.cleanupConfirmed, tempRemoved: facts.tempRemoved, errorKind: facts.errorKind }));
}
