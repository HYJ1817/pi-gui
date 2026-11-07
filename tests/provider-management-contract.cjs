const assert = require('node:assert/strict');
const { test } = require('node:test');

const connection = { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions' };
const draft = { providerId: 'fixture', authMode: 'none', displayName: 'Fixture', connection,
  modelPatches: [{ modelId: 'm', operation: 'upsert', set: { contextWindow: 1000, maxTokens: 100 } }],
  selectedModelIds: ['m'], modelOrder: ['m'], enabled: true };
const req = { requestId: 'request-1', expectedRevision: 'revision-1', draft };

test('strict drafts preserve safe model fields and reject secret or invalid data without reflection', async () => {
  const { validateProviderRequest } = await import('../public/provider-management/contract.js');
  assert.deepEqual(validateProviderRequest('drafts', req), req);
  for (const edit of [
    { providerId: '__proto__' }, { connection: { ...connection, baseUrl: 'https://user:SECRET@fixture.invalid' } },
    { apiKey: 'SECRET' }, { modelOrder: ['m', 'm'] }, { selectedModelIds: ['other'] },
    { modelPatches: [{ modelId: 'm', operation: 'upsert', set: { reasoning: true }, unsetFields: ['reasoning'] }] },
    { modelPatches: [{ modelId: 'm', operation: 'upsert', set: { maxTokens: -1 } }] },
    { modelPatches: [{ modelId: 'm', operation: 'upsert', set: { contextWindow: 50, maxTokens: 60 } }] },
  ]) {
    assert.throws(() => validateProviderRequest('drafts', { ...req, draft: { ...draft, ...edit } }),
      error => error.code === 'invalid_request' && !JSON.stringify(error).includes('SECRET'));
  }
});

test('only the private staging frame may carry literal key material', async () => {
  const { validateCredentialFrame, validateProviderRequest, providerManagementCapabilities } = await import('../public/provider-management/contract.js');
  const frame = { type: 'provider-credential', action: 'stage', requestId: 'r', backendEpoch: 'b', flowId: 'f', promptId: 'p', nonce: 'n', input: '$SECRET', allowDiscovery: false, rememberTarget: false };
  assert.equal(validateCredentialFrame(frame).input, '$SECRET');
  assert.throws(() => validateCredentialFrame({ ...frame, action: 'clear-stage' }), { code: 'invalid_request' });
  assert.throws(() => validateProviderRequest('commit', { requestId: 'r', expectedRevision: 'e', action: 'delete', serviceId: 'fixture', input: '$SECRET' }), { code: 'invalid_request' });
  const caps = providerManagementCapabilities({ rawKeyInput: true, privateDesktopBridge: true });
  assert.equal(caps.rawKeyInput, false);
  assert.equal(caps.privateDesktopBridge, false);
  assert.deepEqual(caps.discoveryModes, []);
});

test('connection validation preserves target path distinctions', async () => {
  const { validateConnection } = await import('../public/provider-management/contract.js');
  const { targetChanged } = await import('../server/provider-config-records.js');
  const withTrailingSlash = validateConnection({ ...connection, baseUrl: connection.baseUrl + '/' });
  assert.equal(withTrailingSlash.baseUrl, connection.baseUrl + '/');
  assert.equal(targetChanged(connection, withTrailingSlash), true);
});
