/**
 * 从供应商的 /models 接口读取模型列表。
 *
 * 为什么必须在服务端做：浏览器的 fetch 直连供应商会撞 CORS，绝大多数供应商
 * 不会给任意来源发 Access-Control-Allow-Origin。所以由后端代发，再把结果回给前端。
 *
 * 三条设计约束（都是踩出来的）：
 *   1. **各家接口形状不同**，必须按 API 类型分别适配（见 ADAPTERS）。
 *   2. **baseUrl 常被填成厂商的兼容子路径**，例如 Anthropic 兼容端点
 *      `https://api.deepseek.com/anthropic`，而真实模型列表在 `/v1/models`。
 *      所以失败时要**逐级砍掉末尾路径段重试**（最多 3 层）。
 *   3. **能力参数只能尽力而为**：`/models` 通常只回 {id, object, created}，
 *      没有上下文长度。OpenRouter 和 Google 是例外，它们回得比较全。
 *      拿不到就不填，绝不编造默认值 —— 编了会让 pi 的上下文压缩阈值出错。
 *
 * 安全：**绝不执行 `!command` 形式的 apiKey**。那是 pi 自身支持的写法（用户在自己
 * 的配置文件里写，属于用户自己的授权范围），但如果 GUI 代为执行，等于给一个网页
 * 界面开了任意命令执行的口子。这里只接受字面量和 `$ENV_VAR`。
 * 另外任何错误信息都不允许包含 key 本身。
 */

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 3000;

// ---------- apiKey 解析 ----------

/**
 * 把 models.json 里的 apiKey 写法解析成真实值。
 * 语义对齐 pi 官方 docs/models.md 的 Value Resolution 一节。
 * @returns {{value: string} | {error: string}}
 */
export function resolveApiKey(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { value: '' };

  // 转义写法：$$ 出字面量 $，$! 出字面量 !
  if (s.startsWith('$$') || s.startsWith('$!')) return { value: s.slice(1) };

  // 命令替换：pi 支持，但我们不代为执行
  if (s.startsWith('!')) {
    return {
      error:
        '这个 apiKey 是 !command 形式（需要执行命令取值）。为了安全，拉取功能不代为执行命令，' +
        '请改填字面量或 $ENV_VAR。模型列表仍可手工填写。',
    };
  }

  if (s.startsWith('$')) {
    const body = s.slice(1);
    const name = body.startsWith('{') && body.endsWith('}') ? body.slice(1, -1) : body;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return { error: `无法识别的 apiKey 写法：${s}（只支持 $NAME、\${NAME}、$$字面量 和 直接填值）` };
    }
    const v = process.env[name];
    if (!v) {
      return {
        error:
          `环境变量 ${name} 没有设置，取不到 key 就没法拉取。` +
          '（注意 pi 遇到这种情况会静默丢掉整个供应商，所以这里提前拦住。）',
      };
    }
    return { value: v };
  }

  return { value: s };
}

// ---------- 候选 URL ----------

/** 不同 API 类型的模型列表路径不一样。按最可能的顺序排。 */
function suffixesFor(api) {
  if (api === 'anthropic-messages') return ['/v1/models', '/models'];
  if (api === 'google-generative-ai') return ['/models'];
  return ['/models', '/v1/models'];
}

/**
 * 生成候选 URL 列表：先按原 baseUrl 试，再逐级砍掉末尾路径段重试。
 *
 * 例：baseUrl = https://api.deepseek.com/anthropic（Anthropic 兼容端点）
 *   → https://api.deepseek.com/anthropic/v1/models   （大概率 404）
 *   → https://api.deepseek.com/anthropic/models
 *   → https://api.deepseek.com/v1/models             （命中）
 *   → https://api.deepseek.com/models
 */
export function buildCandidates(baseUrl, api) {
  const out = [];
  const seen = new Set();
  const add = (base, suffix) => {
    const url = base.replace(/\/+$/, '') + suffix;
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  };

  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)(\/[^?#]*)?/i.exec(String(baseUrl || '').trim());
  if (!m) return out;

  const origin = m[1];
  const suffixes = suffixesFor(api);
  let rest = m[2] || '';

  for (let level = 0; level <= 3; level += 1) {
    for (const s of suffixes) {
      // base 已经以这个路径段结尾时跳过，否则会拼出 /v1/v1/models 这种噪音候选
      const first = s.split('/')[1];
      if (first && new RegExp(`/${first}$`, 'i').test(rest)) continue;
      add(origin + rest, s);
    }
    if (!rest || rest === '/') break;
    rest = rest.slice(0, rest.lastIndexOf('/'));
  }
  return out;
}

// ---------- 鉴权头 ----------

function authHeaders(api, key) {
  const h = { accept: 'application/json' };
  if (api === 'anthropic-messages') {
    h['anthropic-version'] = '2023-06-01';
    if (key) h['x-api-key'] = key;
  } else if (api === 'google-generative-ai') {
    // 用请求头而不是 ?key=，避免 key 出现在 URL 里被日志/错误信息带出去
    if (key) h['x-goog-api-key'] = key;
  } else if (key) {
    h.authorization = `Bearer ${key}`;
  }
  return h;
}

// ---------- 响应适配 ----------

/** 取出模型数组，并判断是哪家的形状。 */
export function pickList(json, api) {
  if (json && Array.isArray(json.models)) return { arr: json.models, kind: 'google' };
  if (json && Array.isArray(json.data)) {
    return { arr: json.data, kind: api === 'anthropic-messages' ? 'anthropic' : 'openai' };
  }
  if (Array.isArray(json)) return { arr: json, kind: 'openai' };
  return null;
}

const posInt = (v) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;

/**
 * 把一条原始记录规范化成 pi 的模型条目。
 *
 * 字段映射（models.dev / OpenRouter → pi models.json）：
 *   context_length / top_provider.context_length → contextWindow
 *   top_provider.max_completion_tokens           → maxTokens
 *   supported_parameters 含 reasoning            → reasoning
 *   architecture.input_modalities                → input
 * Google 则用 inputTokenLimit / outputTokenLimit。
 */
export function normalize(item, kind) {
  if (typeof item === 'string') return item.trim() ? { id: item.trim() } : null;
  if (!item || typeof item !== 'object') return null;

  let id;
  if (kind === 'google') {
    id = String(item.name || item.id || '').replace(/^models\//, '');
    // Google 会连 embedding / 仅推理的模型一起返回，只留能对话的
    const methods = item.supportedGenerationMethods;
    if (Array.isArray(methods) && methods.length && !methods.includes('generateContent')) return null;
  } else {
    id = String(item.id || item.name || '');
  }
  id = id.trim();
  if (!id) return null;

  const model = { id };

  const label =
    kind === 'google'
      ? item.displayName
      : item.displayName ?? item.display_name ?? item.name ?? item.label;
  if (label && String(label).trim() && String(label).trim() !== id) {
    model.name = String(label).trim();
  }

  const ctx =
    posInt(item.context_length) ??
    posInt(item.top_provider?.context_length) ??
    posInt(item.limit?.context) ??
    posInt(item.inputTokenLimit) ??
    posInt(item.context_window);
  if (ctx) model.contextWindow = ctx;

  const max =
    posInt(item.top_provider?.max_completion_tokens) ??
    posInt(item.max_completion_tokens) ??
    posInt(item.max_tokens) ??
    posInt(item.limit?.output) ??
    posInt(item.outputTokenLimit);
  if (max) model.maxTokens = max;

  if (item.reasoning === true) model.reasoning = true;
  else if (Array.isArray(item.supported_parameters) && item.supported_parameters.includes('reasoning')) {
    model.reasoning = true;
  } else if (Array.isArray(item.reasoning_options) && item.reasoning_options.length) {
    model.reasoning = true;
  }

  const mods = item.architecture?.input_modalities ?? item.modalities?.input;
  if (Array.isArray(mods)) {
    const input = mods.filter((x) => x === 'text' || x === 'image');
    // pi 的默认值就是 ['text']，只有能收图才需要显式写
    if (input.includes('image')) model.input = input;
  }

  return model;
}

// ---------- 请求 ----------

async function fetchJson(url, headers, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal, redirect: 'follow' });

    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) throw new Error(`响应过大（${Math.round(declared / 1024 / 1024)} MB）`);

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error(`响应过大（${Math.round(buf.length / 1024 / 1024)} MB）`);

    const text = buf.toString('utf8');
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.body = text.slice(0, 200).replace(/\s+/g, ' ').trim();
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      const err = new Error('返回的不是 JSON');
      err.body = text.slice(0, 120).replace(/\s+/g, ' ').trim();
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 把异常翻译成人能看懂的中文。**不允许带上 key。** */
export function describeError(err, url) {
  if (err?.name === 'AbortError') return `${url} 超时（${TIMEOUT_MS / 1000} 秒）`;
  if (err?.status === 401) return `${url} 返回 401：API Key 无效或未授权`;
  if (err?.status === 403) return `${url} 返回 403：这个 Key 没有访问权限`;
  if (err?.status === 404) return `${url} 返回 404：该路径下没有模型接口`;
  if (err?.status) {
    return `${url} 返回 HTTP ${err.status}${err.body ? `：${err.body}` : ''}`;
  }
  const code = err?.cause?.code || err?.code;
  if (code === 'ENOTFOUND') return `${url} 域名解析失败，检查 Base URL 拼写`;
  if (code === 'ECONNREFUSED') return `${url} 连接被拒绝（本地服务没启动？）`;
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return `${url} 连接超时`;
  if (code === 'CERT_HAS_EXPIRED') return `${url} 证书已过期`;
  if (err?.message === 'fetch failed') return `${url} 无法连接（网络或证书问题）`;
  return `${url} 请求失败：${err?.message || String(err)}`;
}

/**
 * 拉取模型列表。
 * @returns {Promise<{ok:true, models:Array, source:string, keySource:string, tried:string[]}
 *                 | {ok:false, error:string, tried:string[]}>}
 */
export async function fetchModels({ baseUrl, api = 'openai-completions', apiKey = '', headers = {} } = {}) {
  const key = resolveApiKey(apiKey);
  if (key.error) return { ok: false, error: key.error, tried: [] };

  const urls = buildCandidates(baseUrl, api);
  if (!urls.length) {
    return {
      ok: false,
      error: 'Base URL 不合法：需要 http:// 或 https:// 开头的完整地址',
      tried: [],
    };
  }

  const hdr = { ...authHeaders(api, key.value), ...headers };
  const tried = [];

  /* 回退会试好几个 URL，不能简单地把「最后一次」的错误报给用户 ——
   * 典型症状：用户填的地址返回 500（有明确原因），但回退到根路径拿了个 404，
   * 最后界面告诉他「该路径下没有模型接口」，把真正的原因盖掉了。
   * 所以按信息量打分，留最有用的那条。 */
  let bestError = '';
  let bestScore = -1;
  const scoreOf = (err) => {
    const s = err?.status;
    if (s === 401 || s === 403) return 4; // 鉴权问题，用户能直接行动
    if (s && s >= 500) return 3; // 上游自己的毛病
    if (s) return 2; // 其他 4xx
    if (err?.isListProblem) return 2; // 拿到了 JSON 但不是模型列表
    if (err?.name === 'AbortError') return 2; // 超时
    return 1; // 404 / 网络层
  };
  const note = (err, msg) => {
    const s = scoreOf(err);
    if (s > bestScore) {
      bestScore = s;
      bestError = msg;
    }
  };

  /* 兜底：任何错误信息里都不允许出现 key 本身。
   * describeError 已经对 401/403/404 隐去了响应体，但**其他状态码会把响应体带出来** ——
   * 供应商或中转站在错误里回显 key 是完全可能的（401 那个桩就是故意回显的）。
   * 这里做一次无条件替换，让「不泄露 key」不依赖状态码分支的正确性。 */
  const scrub = (s) => (key.value ? String(s).split(key.value).join('***') : String(s));

  for (const url of urls) {
    try {
      const json = await fetchJson(url, hdr, TIMEOUT_MS);
      const picked = pickList(json, api);
      if (!picked) {
        note({ isListProblem: true }, `${url} 返回的不是模型列表`);
        tried.push(url);
        continue;
      }

      const models = [];
      const seen = new Set();
      for (const item of picked.arr) {
        const m = normalize(item, picked.kind);
        if (!m || seen.has(m.id)) continue;
        seen.add(m.id);
        models.push(m);
        if (models.length >= MAX_MODELS) break;
      }

      if (!models.length) {
        note({ isListProblem: true }, `${url} 返回了空列表`);
        tried.push(url);
        continue;
      }

      models.sort((a, b) => a.id.localeCompare(b.id));
      return { ok: true, models, source: url, keySource: key.value ? 'set' : 'none', tried };
    } catch (err) {
      note(err, scrub(describeError(err, url)));
      tried.push(url);
    }
  }

  return { ok: false, error: scrub(bestError) || '没能取到模型列表', tried };
}
