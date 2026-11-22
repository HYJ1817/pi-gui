'use strict';
const ids = [
  ['pi-project-notes', '项目知识与跨会话笔记', 'memory', 'context', 'notes'],
  ['pi-workflow-checks', '在修改完成后运行配置的质量检查', 'agents', 'workflow', 'review'],
  ['pi-git-overview', '从当前项目查看分支、未提交的文件与最近提交', 'devtools', 'git', 'workspace'],
  ['pi-terminal-tabs', '为项目命令建立可复用的终端工作流', 'devtools', 'terminal', 'workspace'],
  ['pi-search-index', '搜索项目文档、命令和参考链接', 'memory', 'index', 'search'],
  ['pi-change-timeline', '按会话查看本地工作区的修改历史', 'devtools', 'history', 'timeline'],
  ['pi-workspace-digest', '汇总工作区近况与待办，便于接续任务', 'agents', 'workflow', 'notes'],
];
const categories = [['devtools', '开发工具'], ['agents', '智能体与工作流'], ['memory', '记忆与知识库']];
const items = ids.map(([name, description, category, ...tags], index) => ({
  id: 'npm:' + name, name, description, category, tags, maintainer: 'fixture-team-' + (index % 3 + 1),
  version: '1.' + index + '.0', updatedAt: '2026-11-' + String(20 - index) + 'T08:00:00.000Z',
  links: { npm: 'https://www.npmjs.com/package/' + name, repository: 'https://github.com/example/' + name },
  installed: { state: 'none', version: null }, install: { allowed: true },
}));
const packageRecord = {
  id: 'pkg_0123456789abcdefabcd', name: items[2].name, kind: 'npm', source: items[2].id,
  scope: 'global', pin: 'none', version: '0.9.0', latest: items[2].version, installed: true, updateAvailable: true,
  description: items[2].description, location: 'C:/fixture/pi/npm/node_modules/' + items[2].name,
  actions: { remove: { allowed: true }, update: { allowed: true } }, resources: { declared: true, extensions: 1 },
  extensionIds: ['fixture-extension'],
  manual: { remove: 'pi remove ' + items[2].id, update: 'pi update --extension ' + items[2].id },
};
items[2] = {
  ...items[2], installed: { state: 'installed', packageId: packageRecord.id, scope: 'global', version: '0.9.0', canUpdate: true },
  install: { allowed: false }, updateAvailable: true,
};

module.exports = async function extensionMarketFixture(req, url) {
  const { pathname, searchParams } = url;
  if (pathname === '/api/extensions/packages') {
    if (req.method === 'POST') {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { ok: false, code: 'install-timeout', commandStarted: true, error: '读取 npm 注册表超时，请检查网络后重试。' };
    }
    return { ok: true, packages: [packageRecord], diagnostics: [], installRoot: 'C:/fixture/pi/npm/node_modules', operations: { available: true, running: false } };
  }
  if (pathname === '/api/extensions/market/item') {
    const item = items.find(({ id }) => id === searchParams.get('id'));
    if (!item) return { ok: false, code: 'unknown-item' };
    return {
      ok: true, item, detailState: 'ok', detail: {
        name: item.name, version: item.version, publishedBy: item.maintainer, license: 'MIT', author: 'Fixture Team',
        declaresResources: true, resources: { extensions: 1 }, installScripts: [], dependencyCount: 1,
        integrity: true, signatures: true, unpackedSize: 40960, fileCount: 12, nodeRange: '>=22',
      },
      compatibility: { status: 'compatible', range: '>=1.6.0', piVersion: '1.6.0' },
    };
  }
  if (pathname === '/api/extensions/market') {
    if (req.method === 'POST') return { ok: true, consent: { remote: true } };
    const q = (searchParams.get('q') || '').toLowerCase();
    const category = searchParams.get('category') || 'all';
    const sort = searchParams.get('sort') || 'recommended';
    const matched = items.filter((item) => (item.name + item.description).toLowerCase().includes(q));
    const scoped = matched.filter((item) => category === 'all' || item.category === category);
    if (sort === 'name') scoped.sort((a, b) => a.name.localeCompare(b.name));
    return {
      ok: true, consent: { remote: true }, snapshot: { state: 'fresh', covered: items.length }, items: scoped,
      catalogTotal: items.length, total: scoped.length, query: { sort }, nextOffset: null,
      categories: [['all', '全部'], ...categories].map(([id, label]) => ({
        id, label, count: matched.filter((item) => id === 'all' || item.category === id).length,
      })),
      sorts: [
        { id: 'recommended', label: '推荐', available: true }, { id: 'downloads', label: '下载量', available: false },
        { id: 'updated', label: '最新', available: true }, { id: 'name', label: '名称', available: true },
      ],
      operations: { available: true, running: false },
    };
  }
  return null;
};
