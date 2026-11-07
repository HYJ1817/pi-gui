/* 供应商配置（~/.pi/agent/models.json）。
 *
 * 这是「用户配置」，与 pi 自身的 models-store.json（模型目录缓存）不是一回事。
 *
 * 安全约束，重构时不许放松：
 *   - apiKey 只回状态（apiKeyState），不回值；
 *   - 模型条目走字段白名单（MODEL_FIELDS），其余键一律丢弃；
 *   - 写配置用原子写（临时文件 + rename）；
 *   - 拉取模型时**不执行** `!command` 形式的 key（那等于给网页界面开了任意命令执行）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchModels } from '../lib/models-api.js';
import { normalizeModelCapability } from '../lib/model-capabilities.js';
import { json, readBody } from './http-utils.js';
import { createProviderConfigStore } from './provider-config-store.js';
import { applyLegacyProvider, isBuiltinProvider, own, removeProviderRecord, targetChanged } from './provider-config-records.js';
import { isModelId, isProviderId, isRecord, providerContractError, providerErrorStatus, providerFailure, validateConnection } from '../public/provider-management/contract.js';

const API_TYPES = new Set([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
]);

/* pi 的模型条目字段白名单（见 pi docs/models.md 的 Model Configuration）。
 * 前端只允许写这几个 —— 其余键一律丢弃，避免把任意结构塞进用户配置。
 * 数值做范围检查：写进 0 或负数会让 pi 的上下文压缩阈值算错。 */
const MODEL_FIELDS = {
  name: (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined),
  contextWindow: (v) => {
    const n = Math.round(Number(v));
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  },
  maxTokens: (v) => {
    const n = Math.round(Number(v));
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  },
  reasoning: (v) => (typeof v === 'boolean' ? v : undefined),
  input: (v) => {
    if (!Array.isArray(v)) return undefined;
    const kinds = [...new Set(v.filter((x) => x === 'text' || x === 'image'))];
    return kinds.length ? kinds : undefined;
  },
  capabilities: (v) => {
    if (!v || typeof v !== 'object') return undefined;
    const caps = Object.fromEntries(['textInput', 'imageInput', 'toolCalling', 'reasoning', 'streaming']
      .filter(key => typeof v[key] === 'boolean').map(key => [key, v[key]]));
    return Object.keys(caps).length ? caps : undefined;
  },
};

function cleanModelEntry(m) {
  if (!m || typeof m !== 'object') return null;
  const id = String(m.id ?? '').trim();
  if (!id) return null;

  const out = { id: id.slice(0, 300) };
  for (const [key, coerce] of Object.entries(MODEL_FIELDS)) {
    const value = coerce(m[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// Never serialize the configuration object: users may store credentials in
// provider/model headers or extension fields, not only in apiKey.
export function publicProviderConfig(config, providerId = null) {
  let baseUrl = '';
  try {
    const url = new URL(config?.baseUrl);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
      url.search = ''; url.hash = ''; baseUrl = url.href.replace(/\/$/, '');
    }
  } catch { /* invalid URL is not exposed */ }
  return {
    baseUrl,
    api: API_TYPES.has(config?.api) ? config.api : 'openai-completions',
    models: Array.isArray(config?.models) ? config.models.map(cleanModelEntry).filter(Boolean).map(model => ({ ...model,
      providerId, modelId: model.id, capability: normalizeModelCapability({ ...model, providerId }, 'user-config'),
    })) : [],
  };
}

export function isEnvKeyReference(value) {
  return typeof value === 'string' && /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(value.trim());
}

/* pi 的 apiKey 支持三种写法：$ENV_VAR 引用环境变量、!command 执行命令取值、字面量。
 * 实测：$VAR 未设置时 pi 会**静默丢掉整个供应商**——get_available_models 里完全查不到，
 * 也不报错。所以这里主动检查并提示，否则用户根本不知道为什么加完没反应。 */
export function apiKeyState(apiKey) {
  const raw = String(apiKey ?? '').trim();

  if (!raw) {
    return { kind: 'none', ok: false, note: '没有填 apiKey：pi 会要求先登录该供应商，否则模型不会出现在列表里' };
  }
  if (raw.startsWith('$$') || raw.startsWith('$!')) {
    return { kind: 'literal', ok: true, note: '' };
  }
  if (raw.startsWith('$')) {
    // 两种等价写法：$NAME 和 ${NAME}。只取 slice(1) 会把 ${NAME} 解析成 "{NAME}"，
    // 于是一个明明设置好的变量被误报成「没有设置」。
    const body = raw.slice(1);
    const name = body.startsWith('{') && body.endsWith('}') ? body.slice(1, -1) : body;
    if (!isEnvKeyReference(raw)) return { kind: 'env', ok: false, note: '环境变量引用格式无效' };
    if (process.env[name]) return { kind: 'env', ok: true, note: `已从环境变量 ${name} 取值` };
    return {
      kind: 'env',
      ok: false,
      note: `环境变量 ${name} 没有设置，pi 会忽略这个供应商。请先设置该变量，再用同样的环境启动本服务`,
    };
  }
  if (raw.startsWith('!')) {
    return { kind: 'command', ok: true, note: '将由命令取值，请确认命令可用' };
  }
  return { kind: 'literal', ok: true, note: '' };
}

/**
 * @param modelsJson ~/.pi/agent/models.json 的绝对路径
 */
export function createProviders({ modelsJson, metadataPath = path.join(path.dirname(modelsJson), 'provider-management.json'), mutationBlocked = () => false,
  inspectCredential = async () => {
    try { fs.lstatSync(path.join(path.dirname(modelsJson), 'auth.json')); }
    catch (error) { if (error.code === 'ENOENT') return { present: false, builtIn: null }; }
    return { present: null, builtIn: null };
  } }) {
  const store = createProviderConfigStore({ modelsJson, metadataPath });
  function readModelsConfig() {
    try { return store.read().config; }
    catch { return { providers: {} }; } // Internal capability projection degrades safely.
  }

  function failure(res, error) {
    const output = providerContractError(error?.code);
    return json(res, providerErrorStatus(output.code), { ...output, error: output.message });
  }

  function handle(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/providers') {
      try {
        const { config, exists, revision } = store.read();
        const entries = Object.entries(config.providers);
        return json(res, 200, { ok: true, path: modelsJson, exists, revision,
          providers: Object.fromEntries(entries.map(([id, cfg]) => [id, publicProviderConfig(cfg, id)])),
          keyStates: Object.fromEntries(entries.map(([id, cfg]) => [id, apiKeyState(cfg?.apiKey)])),
        });
      } catch (error) { return failure(res, error); }
    }
    if (req.method === 'POST' || req.method === 'DELETE') return mutate(req, res, url);
    return failure(res, { code: 'method_not_allowed' });
  }

  async function mutate(req, res, url) {
    try {
      if (mutationBlocked()) providerFailure('config_busy');
      if (req.method === 'DELETE') {
        let name;
        try { name = decodeURIComponent(url.pathname.slice('/api/providers/'.length)); }
        catch { providerFailure('invalid_request'); }
        if (!isProviderId(name)) providerFailure('invalid_request');
        const before = store.read();
        const credential = await inspectCredential(name);
        const result = store.transact({ expectedRevision: before.revision, apply(current) {
          if (mutationBlocked()) providerFailure('config_busy');
          removeProviderRecord(current, name, { builtin: isBuiltinProvider(name, credential) });
          return { ok: true, path: modelsJson, removed: name };
        } });
        return json(res, 200, result);
      }
      if (url.pathname !== '/api/providers') providerFailure('method_not_allowed');
      let payload;
      try { payload = JSON.parse(await readBody(req)); } catch { providerFailure('invalid_request'); }
      const name = typeof payload?.name === 'string' ? payload.name.trim() : null;
      const config = payload?.config;
      if (!isProviderId(name) || !isRecord(config) || !Array.isArray(config.models) || config.models.length > 3000) providerFailure('invalid_request');
      if (config.apiKey && !isEnvKeyReference(config.apiKey)) return json(res, 400, { ok: false, error: 'GUI 只接受环境变量引用；API Key 原文请通过 Pi 的 /login 配置' });
      const connection = validateConnection({ baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl.trim() : null, api: config.api || 'openai-completions' });
      if (config.models.some(model => !isModelId(typeof model?.id === 'string' ? model.id.trim() : null))) providerFailure('invalid_request');
      const models = config.models.map(cleanModelEntry);
      if (new Set(models.map(model => model.id)).size !== models.length) providerFailure('invalid_request');
      const next = { ...connection, models, ...(config.apiKey ? { apiKey: config.apiKey.trim() } : {}) };
      const before = store.read();
      const previous = own(before.config.providers, name);
      const credential = !previous || targetChanged(previous, connection) ? await inspectCredential(name) : null;
      const result = store.transact({ expectedRevision: before.revision, apply(current) {
        if (mutationBlocked()) providerFailure('config_busy');
        const saved = applyLegacyProvider(current, name, next, credential);
        const key = apiKeyState(saved.apiKey);
        return { ok: true, path: modelsJson, provider: name, warning: key.ok ? '' : key.note, keyState: key };
      } });
      return json(res, 200, result);
    } catch (error) { return failure(res, error); }
  }

  /* 从供应商的 /models 接口拉取模型列表。
   *
   * 必须由服务端代发：浏览器直连会撞 CORS。实现细节在 lib/models-api.js。
   * 无论成功失败都回 200，让前端统一走「解析 JSON 里的 ok」这条路径 ——
   * 否则前端要同时处理 HTTP 错误和业务错误两套逻辑。 */
  function handleModels(req, res) {
    readBody(req)
      .then(async (raw) => {
        let payload;
        try {
          payload = JSON.parse(raw || '{}');
        } catch {
          return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        }

        const baseUrl = String(payload.baseUrl || '').trim();
        if (!baseUrl) return json(res, 200, { ok: false, error: '请先填写 Base URL' });
        try {
          const u = new URL(baseUrl);
          if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error();
        } catch { return json(res, 200, { ok: false, error: 'Base URL 必须是无凭据、无查询参数的 HTTP(S) 地址' }); }
        if (payload.apiKey && !isEnvKeyReference(payload.apiKey)) {
          return json(res, 200, { ok: false, error: 'GUI 只接受环境变量引用；API Key 原文请通过 Pi 的 /login 配置' });
        }

        const api = API_TYPES.has(payload.api) ? payload.api : 'openai-completions';

        const out = await fetchModels({
          baseUrl,
          api,
          apiKey: payload.apiKey,
          headers: {},
        });

        // An upstream response body may contain credentials other than the key
        // we sent. Never relay arbitrary provider error text to the renderer.
        if (!out.ok) return json(res, 200, { ok: false, error: '未能读取模型列表；请检查供应商地址、环境变量和网络', tried: out.tried });
        return json(res, 200, {
          ok: true,
          source: out.source,
          keySource: out.keySource,
          tried: out.tried,
          models: out.models,
        });
      })
      .catch(() => json(res, 500, { ok: false, error: '读取供应商模型失败' }));
  }

  return { handle, handleModels, readModelsConfig, store };
}
