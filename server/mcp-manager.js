/* MCP 管理 HTTP 层：配置编辑 / 启停 / 测试连接 / 市场 / 外部导入。
 *
 * 把三个子模块装配成前端可用的语义端点，同时维持两条状态纪律：
 *   - 写配置成功只代表 **configured**；连接（connected）必须显式测试；
 *     运行中的 Agent 会话是否已加载（loaded）仍由 Pi 的会话生命周期决定。
 *   - 测试走 `pi mcp list --json`（会真的启动已配置的 stdio servers），
 *     只在用户手势时执行，且沿用 mcp-native 的 workspace / launch-identity 缓存。
 */
import { json, readBody } from './http-utils.js';

function staleGuard(runtime, body) {
  const raw = body && (body.__expectedCwd !== undefined ? body.__expectedCwd : body.expectedCwd);
  const expected = typeof raw === 'string' ? raw : null;
  const current = runtime && typeof runtime.getCurrentCwd === 'function' ? runtime.getCurrentCwd() : null;
  if (!expected || expected !== current) {
    return { ok: false, code: 'workspace-stale', error: '项目已切换，这次操作作废（请在当前项目上重试）' };
  }
  return null;
}

function readJsonBody(req) {
  return readBody(req, 512 * 1024).then((raw) => {
    try {
      const body = JSON.parse(raw || '{}');
      return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    } catch {
      return null;
    }
  });
}

function countOf(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  return Array.isArray(value) ? value.length : 0;
}

function sanitizeRuntimeServer(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    name: typeof s.name === 'string' ? s.name : '',
    scope: typeof s.scope === 'string' ? s.scope : '',
    enabled: s.enabled !== false,
    transport: s.transport === 'http' ? 'http' : s.transport === 'stdio' ? 'stdio' : '',
    state: typeof s.state === 'string' ? s.state : 'unknown',
    error: typeof s.error === 'string' ? s.error.slice(0, 300) : '',
    tools: countOf(s.tools),
    resources: countOf(s.resources),
    resourceTemplates: countOf(s.resourceTemplates),
  };
}

export function createMcpManager({ runtime, mcpNative, configStore, market, importer } = {}) {
  async function configDetail(url) {
    if (!configStore) return { code: 503, body: { ok: false, code: 'not-wired', error: 'MCP 配置模块未装配' } };
    const scope = url.searchParams.get('scope') || 'user';
    const name = url.searchParams.get('name') || '';
    let revisions;
    try { revisions = configStore.revisions(); } catch { revisions = { user: '', project: '' }; }
    if (!name) {
      return { code: 200, body: { ok: true, revisions, limits: configLimits() } };
    }
    const detail = await configStore.getDetail({ scope, name });
    return { code: 200, body: { ...detail, revisions } };
  }

  function configLimits() {
    return {
      nameMax: 64,
      commandMax: 512,
      argsMax: 32,
      argMax: 1024,
      descriptionMax: 200,
      timeoutMax: 3600,
      envMax: 64,
      headersMax: 32,
    };
  }

  async function testConnection(body) {
    if (!mcpNative) return { ok: false, code: 'not-wired', error: 'MCP 原生模块未装配' };
    const name = typeof body.name === 'string' ? body.name : '';
    if (!name) return { ok: false, code: 'bad-name', error: '缺少 server 名' };
    /* scope 来自用户点的那一行：同名 server 可能同时存在于用户级与项目级，
     * 不按行 scope 查会拿项目级的结果去回答用户级那条。 */
    const requestedScope = body.scope === 'project' ? 'project' : body.scope === 'user' ? 'user' : '';
    let configScope = requestedScope;
    try {
      if (!requestedScope && configStore) {
        for (const scope of ['user', 'project']) {
          const detail = await configStore.getDetail({ scope, name });
          if (detail && detail.ok) { configScope = scope; break; }
        }
      }
    } catch { /* 配置详情拿不到也继续测试运行时 */ }
    let refresh;
    try {
      refresh = await mcpNative.refresh({ force: true });
    } catch (err) {
      return { ok: false, code: 'refresh-failed', error: String((err && err.message) || err).slice(0, 200), configured: true, connected: null, loaded: null };
    }
    const rows = Array.isArray(refresh.servers) ? refresh.servers : [];
    const wantedScope = configScope === 'user' ? 'global' : configScope === 'project' ? 'project' : '';
    const matches = rows.filter((s) => s && s.name === name);
    const server = matches.find((s) => !wantedScope || s.scope === wantedScope) || matches[0] || null;
    if (!refresh.ok) {
      /* `pi mcp list` 本身失败时，我们既没有证据说连上，也没有证据说没连上。
       * connected:false 会把“测不了”误报成“服务器连接失败”，与抛错分支的
       * connected:null 语义不一致。未知必须保持未知。 */
      return {
        ok: false,
        code: refresh.code || 'refresh-failed',
        error: refresh.error || 'pi mcp list 没有成功返回',
        configured: true,
        connected: null,
        loaded: null,
        connectsAll: true,
        server: sanitizeRuntimeServer(server),
      };
    }
    if (!server) {
      return {
        ok: false,
        code: 'not-loaded',
        error: '配置已存在，但 pi mcp list 没有返回这台 server；请确认项目信任状态，或在重启 Pi 会话后重试。',
        configured: true,
        connected: false,
        loaded: false,
        connectsAll: true,
        runtimeAt: refresh.at || '',
      };
    }
    const state = typeof server.state === 'string' ? server.state : 'unknown';
    const connected = state === 'connected';
    return {
      ok: connected,
      code: connected ? '' : (state === 'needs-auth' ? 'needs-auth' : state === 'failed' ? 'connect-failed' : `state-${state}`),
      error: connected ? '' : (server.error || (state === 'needs-auth' ? '这台 server 需要 OAuth 授权' : `运行时状态：${state}`)),
      configured: true,
      connected,
      loaded: null,
      state,
      connectsAll: true,
      runtimeAt: refresh.at || '',
      server: sanitizeRuntimeServer(server),
      loadNote: '连接结论来自独立的 pi mcp list；运行中的 Agent 会话是否已加载仍需 /reload 或重启来保证。',
    };
  }

  async function handleConfig(req, res, url) {
    if (req.method === 'GET') {
      const { code, body } = await configDetail(url);
      return json(res, code, body);
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method-not-allowed', error: 'Method not allowed' });
    if (!configStore) return json(res, 503, { ok: false, code: 'not-wired', error: 'MCP 配置模块未装配' });
    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad-json', error: '请求体不是合法 JSON 对象' });
    const stale = staleGuard(runtime, body);
    if (stale) return json(res, 409, stale);
    const action = body.action;
    let result;
    if (action === 'save') {
      result = await configStore.save({
        scope: body.scope,
        name: body.name,
        originalName: body.originalName,
        expectedRevision: body.expectedRevision,
        allowReplace: body.allowReplace === true,
        confirmOverride: body.confirmOverride === true,
        overrideOnly: body.overrideOnly === true,
        transport: body.transport,
        command: body.command,
        args: body.args,
        cwd: body.cwd,
        env: body.env,
        url: body.url,
        headers: body.headers,
        description: body.description,
        timeout: body.timeout,
        exposure: body.exposure,
        toolExposure: body.toolExposure,
        enabled: body.enabled,
      });
      if (result.ok) mcpNative?.reset?.();
    } else if (action === 'delete') {
      result = await configStore.remove({ scope: body.scope, name: body.name, expectedRevision: body.expectedRevision });
      if (result.ok) mcpNative?.reset?.();
    } else if (action === 'set-enabled') {
      result = await configStore.setEnabled({ scope: body.scope, name: body.name, enabled: body.enabled, expectedRevision: body.expectedRevision });
      if (result.ok) mcpNative?.reset?.();
    } else if (action === 'test') {
      result = await testConnection(body);
    } else {
      return json(res, 400, {
        ok: false,
        code: 'unsupported-action',
        error: '只支持 save / delete / set-enabled / test；OAuth 登录仍走 pi mcp login',
      });
    }
    let revisions;
    try { revisions = configStore.revisions(); } catch { revisions = null; }
    return json(res, 200, { ...result, revisions });
  }

  async function handleMarket(req, res, url) {
    if (!market) return json(res, 503, { ok: false, code: 'not-wired', error: 'MCP 市场模块未装配' });
    if (req.method === 'GET') {
      if (url.pathname.endsWith('/sources')) {
        const sources = market.sources();
        return json(res, 200, sources);
      }
      const params = Object.fromEntries(url.searchParams.entries());
      const result = await market.list(params);
      return json(res, 200, { ...result, sources: market.sources() });
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method-not-allowed', error: 'Method not allowed' });
    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad-json', error: '请求体不是合法 JSON 对象' });
    const action = body.action;
    if (action === 'install') {
      const stale = staleGuard(runtime, body);
      if (stale) return json(res, 409, stale);
      const result = await market.install(body);
      if (result.ok) mcpNative?.reset?.();
      let revisions;
      try { revisions = configStore?.revisions?.() || null; } catch { revisions = null; }
      return json(res, 200, { ...result, revisions });
    }
    if (action === 'add-source') {
      const result = await market.addSource(body);
      return json(res, 200, result);
    }
    if (action === 'remove-source') {
      const result = await market.removeSource(body);
      return json(res, 200, result);
    }
    return json(res, 400, {
      ok: false,
      code: 'unsupported-action',
      error: '只支持 install / add-source / remove-source',
    });
  }

  async function handleImport(req, res) {
    if (!importer) return json(res, 503, { ok: false, code: 'not-wired', error: 'MCP 导入模块未装配' });
    if (req.method === 'GET') {
      const result = await importer.scan();
      return json(res, 200, result);
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method-not-allowed', error: 'Method not allowed' });
    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad-json', error: '请求体不是合法 JSON 对象' });
    const stale = staleGuard(runtime, body);
    if (stale) return json(res, 409, stale);
    if (body.action !== 'apply') {
      return json(res, 400, { ok: false, code: 'unsupported-action', error: '只支持 apply' });
    }
    const result = await importer.apply(body);
    if (result.ok) mcpNative?.reset?.();
    let revisions;
    try { revisions = configStore?.revisions?.() || null; } catch { revisions = null; }
    return json(res, 200, { ...result, revisions });
  }

  function handle(req, res, url) {
    if (url.pathname === '/api/mcp/config') return handleConfig(req, res, url);
    if (url.pathname === '/api/mcp/market' || url.pathname === '/api/mcp/market/sources') return handleMarket(req, res, url);
    if (url.pathname === '/api/mcp/import') return handleImport(req, res);
    return json(res, 404, { ok: false, code: 'not-found', error: 'Not found' });
  }

  return { handle, _internals: { testConnection, sanitizeRuntimeServer, staleGuard } };
}
