/* Pi 原生 MCP 的语义投影（P20.6）。
 *
 * ---------- 先分清两层命名（P20.6-Fix-2 Blocker B） ----------
 *
 * 这个文件处理的是 **B. 注册后的 Pi tool identifier**，即
 * `mcp__<server>__<tool>`。它**不是** `pi mcp list --json` 里的 `tools[]`
 * （那是 **A. raw MCP tool name**，MCP server 自己报的原始名字，
 * 可以含 `-` / 空格 / `/` / `:` / Unicode / emoji）。
 *
 *   A 由 `server/mcp-native.js` 的 `sanitizeMcpRawToolName()` 处理
 *     —— 安全文本边界，**没有字符集白名单**。
 *   B 由本文件的 `MCP_TOOL_RE` 处理 —— 有 `mcp__<server>__` 前缀这个结构约束。
 *
 * **两层不共用正则，也不要互相套用。** 拿 B 的规则去过滤 A 会把合法的 raw name
 * 静默删掉；拿 A 的宽松去解析 B 会让非 MCP 的工具名误判成 MCP 行。
 *
 * ---------- 契约核对方式 ----------
 *
 * pi 0.99.2 发布包原文（`src/extensions/mcp/tools.ts`）：
 *   - 注册期 `createMcpToolName()` 把 `mcp__<server>__<tool>` 里除
 *     `[A-Za-z0-9_]` 之外的字符全部换成 `_`（0.99.1 还保留 `-`），重名再挂
 *     8 位 sha256 后缀。所以 `-` 只在 0.99.1 上可能出现 —— server 段这里
 *     **两边都认**，不因为连的是哪个版本就把行显示成「未知工具」。
 *     注意：`-` 被折成 `_` 之后，工具名里的 server 段不再等于配置里的 server 名
 *     （`my-server` → `my_server`），界面按工具名如实显示，不反推。
 *   - 资源工具 `list_mcp_resources` / `list_mcp_resource_templates` /
 *     `read_mcp_resource`（`docs/mcp.md` 的 Resources 一节；`ui://` 与
 *     MCP Apps pi 不渲染）。
 *   - 每次 MCP 调用都过 pi 的 tool pipeline（同页 Permissions 一节），所以
 *     P19 的审批管道自动生效 —— 这里不画任何 Allow / Deny。
 *
 * 只做一件事：把一条 MCP 工具的 ToolEntry 投影成**白名单事实**
 * （server、tool、运行状态）。不展示完整 args / result（正文泄露面），
 * 不猜 annotations（`readOnlyHint` 等未经 RPC 暴露，见 docs/mcp.md）。
 *
 * 未知形状（server 为空、名字超长）继续走 tool-view.js 的 generic fallback
 * （返回 null）。server 新增 tool 不会让 UI 崩 —— 名字只是文本。
 */

/* server 段接受 `[A-Za-z0-9_-]`：0.99.2 只会产出 `[A-Za-z0-9_]`，
 * 但连 0.99.1 时仍可能出现 `-`。这是两版并集的**安全超集**。
 *
 * tool 段用 `(.+)` 是**有意的宽松**：它是展示面，真正的边界是
 * `mcp__<server>__` 这个前缀。投影时统一过 `oneLine()`（单行化 + 限长），
 * 所以宽松不会带来注入面。反过来，没有前缀的 raw tool name（`get-user`、
 * `工具搜索`）一律不匹配 → 交给通用渲染器。 */
export const MCP_TOOL_RE = /^mcp__([A-Za-z0-9_-]{1,64}?)__(.+)$/;

/** pi 原生的资源工具（不是 mcp__ 前缀，但同样是 MCP 面）。 */
export const MCP_RESOURCE_TOOLS = Object.freeze([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
]);

const object = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
/** 单行化 + 截断。server / tool / uri 都来自外部（模型或远端 server），不可信。 */
const oneLine = (v, max = 200) =>
  typeof v === 'string' ? v.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '';

const SETTLED = new Set(['incomplete', 'interrupted', 'cancelled']);

function labelOf(status, running, success, error) {
  if (status === 'running') return running;
  if (status === 'error') return error;
  if (status === 'success') return success;
  if (SETTLED.has(status)) return 'MCP 调用未完成';
  return 'MCP 调用';
}

function result(status, label, summary, facts) {
  return {
    label,
    status,
    known: true,
    summary: summary.slice(0, 380),
    facts: facts.join('\n').slice(0, 8000),
    sources: [],
    diffStat: null,
    gitStat: null,
  };
}

/** `mcp__<server>__<tool>`：server 与 tool 只是标识符面，可展示；参数与结果不展示。 */
function mcpToolActivity(status, server, tool) {
  const facts = [`Server: ${server}`, `Tool: ${tool}`];
  if (status === 'error') facts.push('调用失败（详情看展开的输出）');
  else if (status === 'success') facts.push('调用成功');
  else if (status === 'running') facts.push('正在调用…');
  else facts.push('状态未知');
  facts.push('参数与结果默认不展示');
  return result(
    status,
    labelOf(status, '调用 MCP 工具…', '调用 MCP 工具', 'MCP 调用失败'),
    `${server} · ${tool}`.slice(0, 380),
    facts,
  );
}

/** 资源工具：server / uri 可以安全摘要（uri 截断单行，不解析它）。 */
function resourceActivity(status, name, a) {
  const facts = [];
  const server = oneLine(a.server, 64);
  const uri = oneLine(a.uri, 200);
  if (server) facts.push(`Server: ${server}`);
  if (name === 'read_mcp_resource' && uri) facts.push(`URI: ${uri}`);
  else if (name !== 'read_mcp_resource' && server) facts.push('列出该 server 的资源');
  if (status === 'error') facts.push('调用失败（详情看展开的输出）');
  facts.push('资源正文走 pi 真实的结果路径，不在这里渲染');
  const label = name === 'read_mcp_resource' ? '读取 MCP 资源'
    : name === 'list_mcp_resource_templates' ? '列出 MCP 资源模板' : '列出 MCP 资源';
  return result(
    status,
    labelOf(status, `${label}…`, label, `${label}失败`),
    (server ? `${server}` : label).slice(0, 380),
    facts.length ? facts : ['MCP 资源操作'],
  );
}

export function parseMcpToolName(name) {
  const m = MCP_TOOL_RE.exec(String(name ?? ''));
  if (!m) return null;
  const tool = oneLine(m[2], 128);
  if (!tool) return null;
  return { server: m[1], tool };
}

export function mcpActivity(entry) {
  const name = entry?.name;
  if (typeof name !== 'string' || !name) return null;
  const status = typeof entry?.status === 'string' && entry.status ? entry.status : 'unknown';
  const parsed = parseMcpToolName(name);
  if (parsed) return mcpToolActivity(status, parsed.server, parsed.tool);
  if (MCP_RESOURCE_TOOLS.includes(name)) return resourceActivity(status, name, object(entry?.args));
  return null;
}
