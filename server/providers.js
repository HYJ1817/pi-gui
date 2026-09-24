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
import { json, readBody } from './http-utils.js';

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
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
  },
  maxTokens: (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
  },
  reasoning: (v) => (typeof v === 'boolean' ? v : undefined),
  input: (v) => {
    if (!Array.isArray(v)) return undefined;
    const kinds = [...new Set(v.filter((x) => x === 'text' || x === 'image'))];
    return kinds.length ? kinds : undefined;
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

/* pi 的 apiKey 支持三种写法：$ENV_VAR 引用环境变量、!command 执行命令取值、字面量。
 * 实测：$VAR 未设置时 pi 会**静默丢掉整个供应商**——get_available_models 里完全查不到，
 * 也不报错。所以这里主动检查并提示，否则用户根本不知道为什么加完没反应。 */
function apiKeyState(apiKey) {
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
export function createProviders({ modelsJson }) {
  function readModelsConfig() {
    try {
      const raw = fs.readFileSync(modelsJson, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        if (!data.providers || typeof data.providers !== 'object') data.providers = {};
        return data;
      }
    } catch {
      /* 文件不存在或损坏，按空配置处理 */
    }
    return { providers: {} };
  }

  function writeModelsConfig(data) {
    fs.mkdirSync(path.dirname(modelsJson), { recursive: true });
    // 原子写：先落临时文件再 rename，避免中途失败把用户配置写坏
    const tmp = `${modelsJson}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, modelsJson);
  }

  function handle(req, res, url) {
    // 读取全部供应商
    if (req.method === 'GET') {
      const cfg = readModelsConfig();
      const keyStates = {};
      for (const [name, c] of Object.entries(cfg.providers || {})) {
        keyStates[name] = apiKeyState(c?.apiKey);
      }
      return json(res, 200, {
        ok: true,
        path: modelsJson,
        exists: fs.existsSync(modelsJson),
        providers: cfg.providers,
        keyStates,
      });
    }

    // 新增或更新一个供应商
    if (req.method === 'POST') {
      readBody(req)
        .then((raw) => {
          let payload;
          try {
            payload = JSON.parse(raw || '{}');
          } catch {
            return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
          }

          const name = String(payload.name || '').trim();
          const config = payload.config || {};

          if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
            return json(res, 400, {
              ok: false,
              error: '供应商 ID 只能包含字母、数字、点、下划线和连字符，长度 1-64',
            });
          }
          if (!config.baseUrl || typeof config.baseUrl !== 'string') {
            return json(res, 400, { ok: false, error: 'Base URL 必填' });
          }
          if (config.api && !API_TYPES.has(config.api)) {
            return json(res, 400, { ok: false, error: `不支持的 API 类型：${config.api}` });
          }
          if (!Array.isArray(config.models)) {
            return json(res, 400, { ok: false, error: 'models 必须是数组' });
          }

          const clean = {
            baseUrl: String(config.baseUrl).trim(),
            api: config.api || 'openai-completions',
          };
          if (config.apiKey && String(config.apiKey).trim()) {
            clean.apiKey = String(config.apiKey).trim();
          }
          clean.models = config.models.map(cleanModelEntry).filter(Boolean);

          const cfg = readModelsConfig();
          cfg.providers[name] = clean;
          writeModelsConfig(cfg);

          const key = apiKeyState(clean.apiKey);
          return json(res, 200, {
            ok: true,
            path: modelsJson,
            provider: name,
            warning: key.ok ? '' : key.note,
            keyState: key,
          });
        })
        .catch((err) => json(res, 500, { ok: false, error: String(err.message) }));
      return;
    }

    // 删除一个供应商
    if (req.method === 'DELETE') {
      const name = decodeURIComponent(url.pathname.slice('/api/providers/'.length));
      const cfg = readModelsConfig();
      if (!cfg.providers[name]) {
        return json(res, 404, { ok: false, error: `供应商 ${name} 不存在` });
      }
      delete cfg.providers[name];
      writeModelsConfig(cfg);
      return json(res, 200, { ok: true, path: modelsJson, removed: name });
    }

    return json(res, 405, { ok: false, error: 'Method not allowed' });
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

        const api = API_TYPES.has(payload.api) ? payload.api : 'openai-completions';

        const out = await fetchModels({
          baseUrl,
          api,
          apiKey: payload.apiKey,
          headers: payload.headers && typeof payload.headers === 'object' ? payload.headers : {},
        });

        if (!out.ok) return json(res, 200, { ok: false, error: out.error, tried: out.tried });
        return json(res, 200, {
          ok: true,
          source: out.source,
          keySource: out.keySource,
          tried: out.tried,
          models: out.models,
        });
      })
      .catch((err) => json(res, 500, { ok: false, error: String(err.message) }));
  }

  return { handle, handleModels, readModelsConfig, writeModelsConfig, apiKeyState, cleanModelEntry };
}
