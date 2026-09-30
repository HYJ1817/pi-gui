/* Web tool semantics only. No provider, auth, network or package implementation. */
const WEB_TOOLS = new Set(['web_search', 'fetch_content', 'get_search_content']);
const text = (v) => typeof v === 'string' ? v.slice(0, 500) : '';
const strings = (v) => Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 20).map(text) : [];

export function safeWebUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password) return null;
    return u.href;
  } catch { return null; }
}

export function webActivity(entry) {
  if (!WEB_TOOLS.has(entry?.name)) return null;
  const a = entry.args && typeof entry.args === 'object' ? entry.args : {};
  const d = entry.details && typeof entry.details === 'object' ? entry.details : {};
  const queries = strings(a.queries).length ? strings(a.queries) : text(a.query) ? [text(a.query)] : strings(d.queries);
  const urlValues = v => Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 40) : [];
  const urls = urlValues(d.urls).length ? urlValues(d.urls) : urlValues(a.urls).length ? urlValues(a.urls) : [typeof d.url === 'string' ? d.url : a.url].filter(x => typeof x === 'string');
  const sources = [];
  const seen = new Set();
  function source(value, title) {
    const url = safeWebUrl(value);
    if (!url || seen.has(url) || sources.length >= 40) return;
    seen.add(url);
    sources.push({ url, hostname: new URL(url).hostname, title: text(title) });
  }
  if (Array.isArray(d.curatedQueries)) for (const q of d.curatedQueries.slice(0, 20)) {
    if (Array.isArray(q?.sources)) for (const s of q.sources.slice(0, 40)) source(s?.url, s?.title);
  }
  // Explicit structured sources also support other extensions using these tool names.
  if (Array.isArray(d.sources)) for (const s of d.sources.slice(0, 40)) source(s?.url, s?.title);
  if (entry.name !== 'web_search') for (const url of urls) source(url, urls.length === 1 ? d.title : '');
  let status = entry.status || 'running';
  if (status !== 'running') {
    if (d.cancelled === true) status = 'cancelled';
    else if (text(d.error) || d.successful === 0 || d.successfulQueries === 0) status = 'error';
  }
  const running = status === 'running';
  const failed = status === 'error';
  const settled = ['cancelled', 'interrupted', 'incomplete'].includes(status);
  let label;
  if (entry.name === 'web_search') label = running ? 'Searching…' : failed ? 'Web search failed' : settled ? 'Web search stopped' : 'Searched the web';
  else if (entry.name === 'fetch_content') label = running ? 'Reading…' : failed ? 'URL fetch failed' : settled ? 'URL fetch stopped' : `Read ${text(d.title) || sources[0]?.hostname || 'web content'}`;
  else label = running ? 'Reading search content…' : failed ? 'Search content failed' : settled ? 'Search content stopped' : 'Read search content';
  const providers = new Set();
  if (Array.isArray(d.queryProviders)) for (const row of d.queryProviders.slice(0, 20)) for (const p of strings(row?.providers)) providers.add(p);
  const facts = [];
  if (queries.length) facts.push('Query: ' + queries.join(' · '));
  if (providers.size) facts.push('Provider: ' + [...providers].join(', '));
  if (Number.isSafeInteger(d.totalResults) && d.totalResults >= 0) facts.push('Results: ' + d.totalResults);
  if (text(d.title)) facts.push('Title: ' + text(d.title));
  if (text(d.mimeType)) facts.push('Content type: ' + text(d.mimeType));
  if (Number.isInteger(d.status) && d.status >= 100 && d.status <= 599) facts.push('HTTP status: ' + d.status);
  if (text(d.error)) facts.push('Error: ' + text(d.error));
  if (!sources.length) facts.push(entry.name === 'web_search' ? 'Structured sources unavailable' : 'URL unavailable');
  return { label, status, known: true, summary: entry.name === 'web_search' ? queries.join(' · ') || 'Query unavailable' : sources.map(s => s.hostname).join(' · ') || 'URL unavailable', facts: facts.join('\n'), sources };
}

export function webSourceLink(source) {
  const url = safeWebUrl(source?.url);
  if (!url) return null;
  const a = document.createElement('a');
  a.className = 'web-source';
  a.textContent = source.title ? `${source.title} · ${source.hostname}` : source.hostname;
  a.href = url;
  a.title = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.onclick = async (event) => {
    if (!window.piGuiDesktop?.isDesktop) return;
    event.preventDefault();
    const open = window.piGuiDesktop.openWebUrl;
    if (!open) { a.title = '当前桌面版不支持 Web 外链，请复制链接'; return; }
    try { const result = await open(url); if (!result?.ok) a.title = '打开失败，请重试或复制链接'; }
    catch { a.title = '打开失败，请重试或复制链接'; }
  };
  return a;
}
