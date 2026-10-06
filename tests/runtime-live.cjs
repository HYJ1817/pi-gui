// Explicit opt-in: real installed Pi/model, temp Git worktrees and temp Pi state.
// Credentials resolved privately by the official SDK are forwarded only in env.
if (process.env.PI_GUI_RUNTIME_LIVE !== '1') { console.log('Opt in: PI_GUI_RUNTIME_LIVE=1 npm run test:runtime-live'); process.exit(0); }
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process'), { pathToFileURL } = require('node:url');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p32-real-pi-')), out = process.env.P32_LIVE_OUT || root;
  fs.mkdirSync(out, { recursive: true }); const report = { platform: process.platform, root, startedAt: new Date().toISOString(), rounds: [], samples: [], checks: 0 };
  const save = () => fs.writeFileSync(path.join(out, 'runtime-live.json'), JSON.stringify(report, null, 2));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo); git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'counter.js'), 'export const counter = 0;\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture');
  const workspaces = ['A', 'B'].map(id => { const cwd = path.join(root, id); git(repo, 'worktree', 'add', '-b', `live-${id}`, cwd, 'HEAD'); return cwd; });
  const agentDir = path.join(root, 'agent'); fs.mkdirSync(agentDir);
  const { createPiLaunch } = await import('../server/pi-launch.js');
  const launch = createPiLaunch({ getCwd: () => repo }), entry = launch.cliEntry(); if (!entry.ok) throw Error('pi_entry_unavailable');
  const sdk = await import(pathToFileURL(path.join(launch.packageDir(), 'dist/index.js')).href);
  const currentAgent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent');
  const settings = JSON.parse(fs.readFileSync(path.join(currentAgent, 'settings.json'), 'utf8'));
  const provider = process.env.P32_LIVE_PROVIDER || settings.defaultProvider, modelId = process.env.P32_LIVE_MODEL || settings.defaultModel;
  report.provider = provider; report.model = modelId;
  const models = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(currentAgent, 'models.json'), modelsStorePath: path.join(agentDir, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  if (models.isUsingOAuth(provider)) throw Error('oauth_live_test_requires_separate_fixture_credentials');
  const model = models.getModel(provider, modelId); if (!model) throw Error('default_model_unavailable');
  const auth = await models.getAuth(model); if (!auth?.auth?.apiKey) throw Error('fixture_api_key_unavailable');
  if (Object.keys(auth.auth.headers || {}).some(k => !['authorization', 'content-type'].includes(k.toLowerCase()))) throw Error('fixture_custom_auth_headers_unsupported');
  const config = models.getRegisteredProviderConfig(provider) || {};
  const sourceModel = (config.models || []).find(m => m.id === modelId) || model;
  const selectedModel = Object.fromEntries(['id', 'name', 'api', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'compat'].filter(k => sourceModel[k] !== undefined).map(k => [k, sourceModel[k]]));
  // Persist no API key/header. The one selected model is proven by Pi, not guessed.
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { [provider]: { baseUrl: auth.auth.baseUrl || config.baseUrl || model.baseUrl, api: config.api || model.api, apiKey: 'PI_GUI_LIVE_KEY', models: [{ ...selectedModel, headers: undefined }] } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: modelId }));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_GUI_LIVE_KEY: auth.auth.apiKey, PI_PROVIDER: provider, PI_MODEL: modelId, PI_THINKING: 'off' };
  const { createSessionRuntime } = await import('../server/session-runtime.js');
  const events = [[], []], runtimes = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function until(fn, timeout = 180000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await sleep(100); } throw Error('live_timeout'); }
  const check = (value, name) => { assert.ok(value, name); report.checks++; save(); console.log('PASS ' + name); };
  try {
    for (let i = 0; i < 2; i++) runtimes.push(await createSessionRuntime({ context: { cwd: workspaces[i], owner: { conversationId: ['A', 'B'][i] }, isCurrent: () => true },
      emit: event => { if (['agent_start', 'agent_settled', 'bridge_status', 'tool_execution_start', 'tool_execution_end'].includes(event.type)) events[i].push({ type: event.type, time: Date.now() });
        if (event.generationResult?.outcome === 'failed') { report.failures ||= []; report.failures.push({ session: i, class: event.generationResult.failure?.class || 'unknown' }); save(); }
        if (events[i].length > 2000) events[i].shift(); },
      piBin: entry.entryPath, env, dataDir: path.join(root, 'data-' + i), sessionDir: path.join(agentDir, 'sessions'), extraArgs: ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes'] }));
    runtimes.forEach(r => r.start()); await until(() => runtimes.every(r => r.getState().state === 'ready'), 30000);
    report.sessionIds = await Promise.all(runtimes.map(async r => (await r.request({ type: 'get_state' })).sessionId)); check(new Set(report.sessionIds).size === 2, 'two real Pi session identities');
    const started = Date.now(), duration = Number(process.env.P32_STRESS_MS || 1800000); let round = 0;
    while (Date.now() - started < duration) {
      round++; const roundStart = Date.now(), expected = round;
      await Promise.all(runtimes.map(r => r.send({ type: 'prompt', message: `Modify only counter.js in this workspace so it contains exactly: export const counter = ${expected};\nUse the write tool. Then use bash to run a Node assertion reading counter.js and checking the counter. Do not change anything else or use network. Reply briefly when verified.` })));
      await until(async () => { const states = await Promise.all(runtimes.map(r => r.request({ type: 'get_state' }))); return states.every(s => !s.isStreaming); });
      check(workspaces.every(cwd => fs.readFileSync(path.join(cwd, 'counter.js'), 'utf8').includes(`counter = ${expected}`)), 'real A/B coding round ' + round);
      check(fs.readFileSync(path.join(repo, 'counter.js'), 'utf8').includes('counter = 0'), 'main unchanged round ' + round);
      report.rounds.push({ round, elapsedMs: Date.now() - roundStart, git: workspaces.map(cwd => git(cwd, 'status', '--porcelain')), toolCounts: events.map(list => list.filter(e => e.type === 'tool_execution_start').length) });
      report.samples.push({ atMs: Date.now() - started, backendRss: process.memoryUsage().rss }); save();
      console.log('PROGRESS ' + Math.round((Date.now() - started) / 1000) + 's');
      // Keep actual children alive and repeat real coding periodically. This is
      // durability with overlapping tasks, not a claimed continuous token stream.
      const nextRound = Math.min(started + duration, Date.now() + 110000);
      while (Date.now() < nextRound) { await sleep(Math.min(10000, nextRound - Date.now())); const states = await Promise.all(runtimes.map(r => r.request({ type: 'get_state' }))); check(states.every(s => typeof s.sessionId === 'string'), 'both real children responsive'); }
    }
    check(events.every(list => list.some(e => e.type === 'tool_execution_start')), 'both children executed real tools');
    report.elapsedMs = Date.now() - started; report.ok = true;
  } catch (error) { report.ok = false; report.errorType = error.name; throw error; }
  finally { await Promise.allSettled(runtimes.map(r => r.dispose())); report.cleanupConfirmed = runtimes.every(r => r.cleanupConfirmed()); report.endedAt = new Date().toISOString(); save(); }
  console.log('Real Pi runtime evidence: ' + path.join(out, 'runtime-live.json'));
})().catch(error => { console.error('Runtime live failed: ' + (['oauth_live_test_requires_separate_fixture_credentials', 'fixture_api_key_unavailable', 'default_model_unavailable', 'fixture_custom_auth_headers_unsupported', 'pi_entry_unavailable', 'live_timeout'].includes(error.message) ? error.message : 'verification_failed')); process.exitCode = 1; });
