/* Shared, pure model data contract. Served as native ESM; backend uses the
 * lib entrypoint. No model-name heuristics, credentials, I/O or defaults. */
const SOURCES = ['pi-runtime', 'user-config', 'provider-metadata'];
const CAPABILITIES = ['textInput', 'imageInput', 'toolCalling', 'reasoning', 'streaming'];
const text = v => typeof v === 'string' && v.trim() ? v.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 300) : null;
const tri = v => typeof v === 'boolean' ? v : null;
const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) || null : null;

export function modelIdentity(model = {}) {
  return { providerId: text(model?.providerId) || text(model?.provider), modelId: text(model?.modelId) || text(model?.id) };
}

export function normalizeModelCapability(model = {}, source = 'pi-runtime') {
  model = model && typeof model === 'object' ? model : {};
  const identity = modelIdentity(model);
  const input = Array.isArray(model.input) ? model.input.filter(v => v === 'text' || v === 'image') : [];
  const caps = model.capabilities || {};
  const reasoning = tri(typeof model.reasoning === 'object' ? model.reasoning?.supported : model.reasoning) ?? tri(caps.reasoning);
  const capabilities = {
    textInput: input.length ? input.includes('text') : tri(caps.textInput),
    imageInput: input.length ? input.includes('image') : tri(caps.imageInput),
    toolCalling: tri(caps.toolCalling), reasoning, streaming: tri(caps.streaming),
  };
  const contextWindow = positive(model.contextWindow);
  const maxOutputTokens = positive(model.maxOutputTokens) ?? positive(model.maxTokens);
  const evidence = {};
  for (const [key, value] of Object.entries({ contextWindow, maxOutputTokens, ...capabilities })) {
    evidence[key] = value !== null && SOURCES.includes(source) ? source : null;
  }
  return { ...identity, name: text(model.name) || identity.modelId, contextWindow, maxOutputTokens,
    capabilities, reasoning: { supported: reasoning, levels: null }, evidence };
}

/* Fixed precedence, per field. Explicit false wins; null falls through.
 * Only full, equal identities may supplement a model. Array order cannot
 * silently turn a same-ID model on another Provider into the selected model. */
export function mergeModelCapabilities({ runtime = null, user = null, provider = null } = {}) {
  const layers = [[runtime, 'pi-runtime'], [user, 'user-config'], [provider, 'provider-metadata']];
  const base = layers.find(([model]) => model)?.[0] || {};
  const identity = modelIdentity(base);
  const result = normalizeModelCapability({ ...identity, name: base.name }, 'unknown');
  for (const [model, source] of layers) {
    if (!model) continue;
    const id = modelIdentity(model);
    if (model !== base && (!identity.providerId || !identity.modelId || id.providerId !== identity.providerId || id.modelId !== identity.modelId)) continue;
    const normalized = normalizeModelCapability(model, source);
    for (const key of ['contextWindow', 'maxOutputTokens', ...CAPABILITIES]) {
      const dest = CAPABILITIES.includes(key) ? result.capabilities : result;
      const src = CAPABILITIES.includes(key) ? normalized.capabilities : normalized;
      if (dest[key] === null && src[key] !== null) { dest[key] = src[key]; result.evidence[key] = source; }
    }
  }
  result.reasoning.supported = result.capabilities.reasoning;
  return result;
}

/* Existing safe wire descriptors keep their provenance. Unknown nested keys,
 * caller-provided levels and unrecognized evidence strings never survive. */
export function modelCapability(model) {
  const identity = modelIdentity(model);
  const descriptor = model?.capability;
  const id = modelIdentity(descriptor);
  if (!descriptor || id.providerId !== identity.providerId || id.modelId !== identity.modelId) return normalizeModelCapability(model);
  const result = normalizeModelCapability(descriptor, 'unknown');
  for (const key of Object.keys(result.evidence)) {
    const value = CAPABILITIES.includes(key) ? result.capabilities[key] : result[key];
    result.evidence[key] = value !== null && SOURCES.includes(descriptor.evidence?.[key]) ? descriptor.evidence[key] : null;
  }
  return result;
}

export function withModelCapability(model) {
  if (!model || typeof model !== 'object') return null;
  const identity = modelIdentity(model);
  return { ...model, ...identity, provider: identity.providerId, id: identity.modelId, capability: modelCapability(model) };
}

const tokenLabel = n => n >= 1000000 ? `${+(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}K` : String(n);
export function modelCapabilitySummary(model) {
  const m = modelCapability(model), parts = [];
  if (m.capabilities.reasoning === true) parts.push('推理');
  if (m.capabilities.imageInput === true) parts.push('图片');
  if (m.capabilities.toolCalling === true) parts.push('Tools');
  if (m.contextWindow !== null) parts.push(tokenLabel(m.contextWindow));
  return { text: parts.join(' · '), title: [
    ...parts, m.contextWindow === null ? '' : `Context ${m.contextWindow}`,
    m.maxOutputTokens === null ? '' : `Max output ${m.maxOutputTokens}`,
    ...['imageInput', 'reasoning', 'toolCalling'].filter(k => m.capabilities[k] === false).map(k => ({ imageInput: '不支持图片', reasoning: '不支持推理', toolCalling: '不支持 Tools' })[k]),
  ].filter(Boolean).join(' · ') };
}
