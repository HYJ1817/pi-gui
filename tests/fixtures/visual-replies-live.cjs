'use strict';
// Authorization is independent from credential presence. Never inspect real
// HOME/settings/auth or choose an ambient default provider/model. Import is pure.
function authorizeLive(env = process.env) {
  if (env.PI_GUI_VISUAL_REPLIES_LIVE !== '1') throw Error('live_opt_in_required');
  if (env.PI_GUI_VISUAL_REPLIES_AUTHORIZE_MODEL_CALLS !== '1') throw Error('explicit_model_authorization_required');
  for (const key of ['PROVIDER', 'MODEL', 'PI_BIN', 'API', 'ENDPOINT'])
    if (typeof env['PI_GUI_VISUAL_REPLIES_' + key] !== 'string' || !env['PI_GUI_VISUAL_REPLIES_' + key].trim()) throw Error('explicit_live_selection_required');
  const credentialVariable = env.PI_GUI_VISUAL_REPLIES_KEY_ENV || 'PI_GUI_VISUAL_REPLIES_KEY';
  if (!(credentialVariable === 'PI_GUI_VISUAL_REPLIES_KEY' || /^[A-Z][A-Z0-9_]*_API_KEY$/.test(credentialVariable))
    || env.PI_GUI_VISUAL_REPLIES_AUTHORIZE_CREDENTIAL !== credentialVariable)
    throw Error('explicit_credential_authorization_required');
  if (typeof env[credentialVariable] !== 'string' || !env[credentialVariable].trim()) throw Error('explicit_fixture_credential_required');
  let endpoint;
  try { endpoint = new URL(env.PI_GUI_VISUAL_REPLIES_ENDPOINT); } catch { throw Error('invalid_explicit_endpoint'); }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('invalid_explicit_endpoint');
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(env.PI_GUI_VISUAL_REPLIES_PROVIDER)
    || !/^[a-zA-Z0-9._:/-]{1,190}(?:\[[a-zA-Z0-9_-]{1,8}\])?$/.test(env.PI_GUI_VISUAL_REPLIES_MODEL)
    || !/^[a-z][a-z0-9-]{1,80}$/.test(env.PI_GUI_VISUAL_REPLIES_API)) throw Error('invalid_explicit_selection');
  return { provider: env.PI_GUI_VISUAL_REPLIES_PROVIDER, model: env.PI_GUI_VISUAL_REPLIES_MODEL, api: env.PI_GUI_VISUAL_REPLIES_API,
    endpoint: endpoint.href, piBin: env.PI_GUI_VISUAL_REPLIES_PI_BIN, credentialVariable };
}
async function prepareLiveModel(world, ambient = process.env) {
  const selection = authorizeLive(ambient); // Must precede imports, reads, writes.
  const fs = require('node:fs'), path = require('node:path');
  const h = require('./visual-replies-support.cjs');
  h.validateWorld(world);
  if (!path.isAbsolute(selection.piBin)) throw Error('explicit_absolute_pi_bin_required');
  const { createPiLaunch } = await import('../../server/pi-launch.js');
  const launch = createPiLaunch({ piBin: selection.piBin, env: h.childEnvironment(world), getCwd: () => path.join(world, 'project-a') });
  const entry = launch.cliEntry();
  if (!entry?.ok || !launch.packageDir()) throw Error('pi_entry_unavailable');
  const agent = path.join(world, 'agent');
  fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { [selection.provider]: {
    baseUrl: selection.endpoint, api: selection.api, apiKey: '$' + selection.credentialVariable,
    models: [{ id: selection.model, name: selection.model, api: selection.api, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 }],
  } } }), { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: selection.provider, defaultModel: selection.model,
    defaultThinkingLevel: 'off', packages: [], extensions: [], skills: [], promptTemplates: [], themes: [], retry: { enabled: false }, quietStartup: true }), { flag: 'wx' });
  return { env: { PI_BIN: selection.piBin, PI_CODING_AGENT_DIR: agent, [selection.credentialVariable]: ambient[selection.credentialVariable],
    PI_PROVIDER: selection.provider, PI_MODEL: selection.model, PI_THINKING: 'off', PI_OFFLINE: '0', PI_GUI_OFFLINE: '1' },
    secrets: [ambient[selection.credentialVariable]],
    identity: { provider: selection.provider, model: selection.model, modelResolution: 'explicit-fixture-config-only',
      piVersion: JSON.parse(fs.readFileSync(path.join(launch.packageDir(), 'package.json'), 'utf8')).version,
      piEntrySha256: h.digest(entry.entryPath), api: selection.api, endpointHost: new URL(selection.endpoint).hostname,
      sourceAuthCopied: false, userSettingsRead: false, modelDiscoveryNetwork: false, oauthRefresh: false, modelFallback: false,
      authorizedModelCalls: true, authorizedCredentialVariable: selection.credentialVariable, promptBudget: 1,
      pricing: 'fixture-zero-not-cost-evidence' } };
}
module.exports = { authorizeLive, prepareLiveModel };
