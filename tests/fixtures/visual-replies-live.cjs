'use strict';

/* Explicitly called by the live runner only. Uses the same existing public
 * ModelRuntime APIs as parallel-runtime-live; no direct provider API/client,
 * source auth copy, OAuth refresh, global npm mutation or network discovery.
 * Importing this module does not inspect the installed Pi or user settings.
 */
async function prepareLiveModel(world, ambient = process.env) {
  if (ambient.PI_GUI_VISUAL_REPLIES_LIVE !== '1') throw Error('live_opt_in_required');
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const h = require('./visual-replies-support.cjs');
  h.validateWorld(world);
  const { createPiLaunch } = await import('../../server/pi-launch.js');
  const { resolveAuthSdk } = await import('../../server/provider-auth-sdk.js');
  const launch = createPiLaunch({ getCwd: () => h.ROOT });
  const entry = launch.cliEntry();
  if (!entry.ok) throw Error('pi_entry_unavailable');
  const publicSdk = resolveAuthSdk(launch.packageDir());
  if (!publicSdk) throw Error('pi_public_sdk_unavailable');
  const sdk = await import(publicSdk.entry);
  const sourceAgent = ambient.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), agent = path.join(world, 'agent');
  const sourceSettings = JSON.parse(fs.readFileSync(path.join(sourceAgent, 'settings.json'), 'utf8'));
  const provider = ambient.PI_GUI_VISUAL_REPLIES_PROVIDER || sourceSettings.defaultProvider;
  const modelId = ambient.PI_GUI_VISUAL_REPLIES_MODEL || sourceSettings.defaultModel;
  // A temporary auth path intentionally prevents source auth.json mutation or
  // copying. Existing model/environment credentials are resolved in-memory by
  // the public SDK; unsupported OAuth fails closed before obtaining an auth.
  const models = await sdk.ModelRuntime.create({ authPath: path.join(agent, 'auth.json'), modelsPath: path.join(sourceAgent, 'models.json'),
    modelsStorePath: path.join(agent, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  if (models.isUsingOAuth(provider)) throw Error('oauth_requires_fixture_credentials');
  const model = models.getModel(provider, modelId);
  if (!model) throw Error('model_unavailable');
  const auth = await models.getAuth(model);
  if (!auth?.auth?.apiKey) throw Error('fixture_key_unavailable');
  if (Object.keys(auth.auth.headers || {}).some(key => !['authorization', 'content-type'].includes(key.toLowerCase()))) throw Error('custom_auth_headers_unsupported');
  const config = models.getRegisteredProviderConfig(provider) || {}, sourceModel = (config.models || []).find(item => item.id === modelId) || model;
  const selected = Object.fromEntries(['id', 'name', 'api', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'compat', 'thinkingLevelMap', 'promptCache']
    .filter(key => sourceModel[key] !== undefined).map(key => [key, sourceModel[key]]));
  const baseUrl = auth.auth.baseUrl || config.baseUrl || model.baseUrl, url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) throw Error('endpoint_contains_private_fields');
  fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { [provider]: {
    baseUrl, api: config.api || model.api, apiKey: '$PI_GUI_VISUAL_REPLIES_KEY', models: [{ ...selected, headers: undefined }],
  } } }), { mode: 0o600, flag: 'wx' });
  const fixtureModels = await sdk.ModelRuntime.create({ authPath: path.join(agent, 'auth.json'), modelsPath: path.join(agent, 'models.json'),
    modelsStore: { async read() { return undefined; }, async write() {}, async delete() {} }, allowModelNetwork: false, refreshOnCreate: false });
  const fixtureModel = fixtureModels.getModel(provider, modelId), key = auth.auth.apiKey;
  const fixtureAuth = fixtureModel ? await fixtureModels.getAuth(fixtureModel, { env: { PI_GUI_VISUAL_REPLIES_KEY: key } }) : null;
  if (!fixtureModel || fixtureModel.provider !== provider || fixtureModel.id !== modelId || fixtureAuth?.auth?.apiKey !== key) throw Error('fixture_model_resolution_mismatch');
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: modelId,
    defaultThinkingLevel: 'off', packages: [], extensions: [], skills: [], promptTemplates: [], themes: [], retry: { enabled: false }, quietStartup: true }), { flag: 'wx' });
  return { env: { PI_BIN: launch.identity().bin, PI_CODING_AGENT_DIR: agent, PI_GUI_VISUAL_REPLIES_KEY: key, PI_PROVIDER: provider, PI_MODEL: modelId, PI_THINKING: 'off' },
    // Never JSON.stringify this return object. Only identity is evidence; the
    // key and provider alias remain in-memory for child-env/redaction checks.
    secrets: [key], privateLabels: [provider], identity: { piVersion: entry.version, provider: 'existing-selected-provider-redacted', model: modelId,
      modelResolution: 'public-ModelRuntime', sourceAuthCopied: false,
      modelDiscoveryNetwork: false, oauthRefresh: false, modelFallback: false, sourceModelMatchesFixture: true } };
}
module.exports = { prepareLiveModel };
