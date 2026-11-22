/* 技能市场：目录解析（纯函数）、网络线路、目录加载与缓存、预览、安装。
 * 另外把线路 / 地址判定与 MCP 市场已有的实现逐条对照 —— 两份实现不许分叉。
 *
 * 纪律同前：全部在 os.tmpdir() 里造世界，不 spawn、不联网。网络层通过注入的
 * fetchBytes / requestImpl / lookupImpl / 代理桥驱动；真实的 httpsGetPinned 与
 * dns.promises.lookup 一次都不会被调用。
 *
 * 远端形状照真实 API 造（都核对过真实响应）：
 *   GitHub: GET /repos/{o}/{r}/commits?per_page=1 → [{ sha, commit:{ tree:{ sha } } }]
 *           GET /repos/{o}/{r}/git/trees/{tree}?recursive=1 → { sha, tree:[{path,mode,type,sha,size}], truncated }
 *   jsDelivr: GET https://data.jsdelivr.com/v1/packages/gh/{o}/{r}@{ref}?structure=flat
 *             → { files:[{ name:'/path', hash:'<base64 sha256>', size }] }
 *   文件内容: cdn.jsdelivr.net/gh/{o}/{r}@{commit}/{path}（字节按 git blob sha1 或 sha256 核对）
 *
 * 跑法：node tests/skills-market.cjs */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const H = require('./fixtures/skills-harness.cjs');

const { check, skip, section, finish } = H.createChecker();
const worlds = H.createWorlds('pi-gui-skills-market-');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** HTTP 结果：「状态码:业务码」。 */
const outcome = (res) => `${res.code}:${(res.jsonBody() || {}).code || ''}`;
/** 模块直接返回的结果：成功是 ok，失败是「状态码:业务码」。 */
const verdict = (r) => (r && r.ok ? 'ok' : `${r && r.status}:${r && r.code}`);
/** 对照用：只取成功 / 失败码。 */
const pick = (r) => (r && r.ok === true ? 'ok' : String((r && (r.code || r.marketCode)) || 'unknown'));
const sha256b64 = (value) => crypto.createHash('sha256').update(value).digest('base64');
const gitBlob = (value) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(value)}\x00`).update(value).digest('hex');

const COMMIT = 'c0ffee'.repeat(6) + 'c0ff';
const TREE = 'beef'.repeat(10);
const REPO = 'anthropics/skills';
const COMMITS_URL = `https://api.github.com/repos/${REPO}/commits?per_page=1`;
const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/${TREE}?recursive=1`;
const FLAT_URL = (ref) => `https://data.jsdelivr.com/v1/packages/gh/${REPO}@${ref}?structure=flat`;
const cdnUrl = (rel, ref = COMMIT) => `https://cdn.jsdelivr.net/gh/${REPO}@${ref}/${rel}`;
const rawUrl = (rel, ref = COMMIT) => `https://raw.githubusercontent.com/${REPO}/${ref}/${rel}`;

/* ---------- 远端 fixture ---------- */
const PDF_MD = '---\nname: pdf\ndescription: Read and write PDF files.\n---\n\n# PDF\n\nUse scripts/fill.py.\n';
const FILL = 'print("fill")\n';
const DOCX_MD = '---\nname: docx\ndescription: Edit Word documents.\n---\n\n# DOCX\n';
const PAIRED_MD = '---\nname: paired\ndescription: Has a binary asset.\n---\n\n# Paired\n';
const ASSET = Buffer.from([0, 1, 2, 3, 255, 254, 0x89, 0x50]);
const BLOCKED_MD = '---\nname: blocked\ndescription: Has a file over the limit.\n---\n';
const UNSAFE_MD = '---\nname: unsafe\ndescription: Has an unsafe file name.\n---\n';
const TEMPLATE_MD = '---\nname: template\ndescription: A template to copy.\n---\n';
const TINY = {};
for (const letter of ['a', 'b', 'c', 'd', 'e', 'f']) TINY[letter] = `---\nname: tiny-${letter}\ndescription: Tiny ${letter}.\n---\n`;

const CONTENT = new Map([
  ['skills/pdf/SKILL.md', Buffer.from(PDF_MD)],
  ['skills/pdf/scripts/fill.py', Buffer.from(FILL)],
  ['skills/docx/SKILL.md', Buffer.from(DOCX_MD)],
  ['skills/paired/SKILL.md', Buffer.from(PAIRED_MD)],
  ['skills/paired/asset.bin', ASSET],
  ['skills/blocked/SKILL.md', Buffer.from(BLOCKED_MD)],
  ['skills/unsafe/SKILL.md', Buffer.from(UNSAFE_MD)],
  ['skills/unsafe/bad\\name.txt', Buffer.from('x')],
  ['template/SKILL.md', Buffer.from(TEMPLATE_MD)],
  ['README.md', Buffer.from('# repo\n')],
  ...Object.entries(TINY).map(([letter, text]) => [`skills/tiny-${letter}/SKILL.md`, Buffer.from(text)]),
]);
const HUGE_SIZE = 3 * 1024 * 1024;
const BIGMD_SIZE = 300 * 1024;

const nodeOf = (rel, mode = '100644') => {
  const bytes = CONTENT.get(rel);
  return { path: rel, mode, type: 'blob', sha: gitBlob(bytes), size: bytes.length };
};
const fakeNode = (rel, size) => ({ path: rel, mode: '100644', type: 'blob', sha: 'e'.repeat(40), size });
const TREE_NODES = [
  nodeOf('README.md'),
  nodeOf('skills/pdf/SKILL.md'),
  nodeOf('skills/pdf/scripts/fill.py', '100755'),
  nodeOf('skills/docx/SKILL.md'),
  nodeOf('skills/paired/SKILL.md'),
  nodeOf('skills/paired/asset.bin'),
  nodeOf('skills/blocked/SKILL.md'),
  fakeNode('skills/blocked/huge.bin', HUGE_SIZE),
  fakeNode('skills/bigmd/SKILL.md', BIGMD_SIZE),
  nodeOf('skills/unsafe/SKILL.md'),
  nodeOf('skills/unsafe/bad\\name.txt'),
  nodeOf('template/SKILL.md'),
  ...Object.keys(TINY).map((letter) => nodeOf(`skills/tiny-${letter}/SKILL.md`)),
];
const FLAT_PAYLOAD = (paths) => ({
  type: 'gh',
  name: REPO,
  version: 'main',
  default: null,
  files: paths.map((rel) => ({ name: `/${rel}`, hash: sha256b64(CONTENT.get(rel)), size: CONTENT.get(rel).length })),
});

/** 假网络：按 URL 返回真实形状的响应；controls 用来制造 404 / 篡改 / 代理线路。 */
function createWire() {
  const calls = [];
  const controls = {
    fail: new Map(), missing: new Set(), wrong: new Map(), route: new Map(), flat: new Map(), gate: null,
  };
  const jsonResponse = (value) => ({ ok: true, status: 200, route: 'direct', bytes: Buffer.from(JSON.stringify(value), 'utf8') });
  const notFound = (url) => ({ ok: false, code: 'http-404', status: 404, error: `${new URL(url).hostname} 返回 HTTP 404` });
  const contentFor = (url) => {
    const cdn = /^https:\/\/cdn\.jsdelivr\.net\/gh\/anthropics\/skills@[^/]+\/(.+)$/.exec(url);
    if (cdn) return CONTENT.get(cdn[1]);
    const raw = /^https:\/\/raw\.githubusercontent\.com\/anthropics\/skills\/[^/]+\/(.+)$/.exec(url);
    if (raw) return CONTENT.get(raw[1]);
    return undefined;
  };
  async function fetchBytes(url, options = {}) {
    calls.push({ url, options });
    if (controls.gate) await controls.gate;
    if (controls.fail.has(url)) return controls.fail.get(url);
    if (url === COMMITS_URL) return jsonResponse([{ sha: COMMIT, commit: { tree: { sha: TREE } } }]);
    if (url === TREE_URL) return jsonResponse({ sha: TREE, url: '', tree: TREE_NODES, truncated: false });
    const flat = /^https:\/\/data\.jsdelivr\.com\/v1\/packages\/gh\/anthropics\/skills@([^/?]+)\?structure=flat$/.exec(url);
    if (flat && controls.flat.has(flat[1])) return jsonResponse(controls.flat.get(flat[1]));
    const hit = contentFor(url);
    if (hit === undefined || controls.missing.has(url)) return notFound(url);
    if (controls.wrong.has(url)) return { ok: true, status: 200, route: controls.route.get(url) || 'direct', bytes: controls.wrong.get(url) };
    return { ok: true, status: 200, route: controls.route.get(url) || 'direct', bytes: hit };
  }
  return { fetchBytes, calls, controls };
}

(async () => {
  const S = await H.loadSkillsServer();
  const catalog = await import('../server/skills-market-catalog.js');
  const netmod = await import('../server/skills-market-network.js');
  const marketmod = await import('../server/skills-market.js');
  const mcpmod = await import('../server/mcp-market.js');

  const M = mcpmod.createMcpMarket({ dataDir: worlds.TMP, env: {}, configStore: null })._internals;
  const ANTHROPIC = catalog.sourceIdOf('anthropics', 'skills', '');
  const entryId = (dir) => catalog.entryIdOf(ANTHROPIC, dir);
  const T0 = 1700000100000;

  const setup = (name) => {
    const w = worlds.mkWorld(name);
    const sk = S.mkSkills(w, w.proj, { approve: true });
    const manager = S.createSkillsManager({ core: S.realCore(sk, { approve: true }), dataDir: w.data });
    const clock = { value: T0 };
    const wire = createWire();
    const make = ({ fetcher = wire.fetchBytes, dataDir = w.data, now = () => clock.value } = {}) => marketmod.createSkillsMarket({
      dataDir, manager, core: { maxSkillBytes: 256 * 1024 }, fetcher: { fetchBytes: fetcher }, now,
    });
    return { w, sk, manager, clock, wire, make, ctx: { cwd: w.proj, live: true, explicit: true }, pid: S.skillId(w.proj) };
  };

  try {
    /* ============================================================ */
    section('A. 目录数据的纯函数');
    {
      check('A1. 分类是固定的五个，顺序稳定', same(catalog.MARKET_CATEGORIES.map((c) => c.id), ['workflow', 'writing', 'coding', 'data', 'docs'])
        && catalog.MARKET_CATEGORIES[0].label === '工作流');
      const guesses = [['skills/sql-tools', ['data']], ['code-review', ['workflow']], ['writing-helper', ['writing']],
        ['skills/pdf', ['docs']], ['frontend-design', ['coding']], ['something-else', ['workflow']]];
      check('A2. 分类按关键词猜：数据 > 工作流 > 编程 > 写作 > 文档，猜不出算工作流', guesses.every(([text, want]) => same(catalog.guessSkillCategories(text), want)),
        guesses.map(([text]) => `${text}:${catalog.guessSkillCategories(text)}`).join(' '));

      const good = ['anthropics/skills', 'owner/repo@dev', 'https://github.com/anthropics/skills', 'https://github.com/anthropics/skills/tree/dev/skills/pdf', 'owner/repo.git'];
      const parsed = good.map((text) => catalog.parseRepoSpec(text));
      check('A3. 仓库写法：owner/repo、@分支、仓库网址、.git 后缀', parsed.every((entry) => entry.ok)
        && parsed[0].owner === 'anthropics' && parsed[0].repo === 'skills' && parsed[0].ref === ''
        && parsed[1].ref === 'dev' && parsed[4].repo === 'repo' && parsed[3].ref === 'dev', JSON.stringify(parsed));
      const badSpecs = ['', 'no-slash', 'a/b/c', 'https://gitlab.com/a/b', 'github.com/a/b', '-bad/repo', 'owner/..', 'owner/repo@../x', `o/${'r'.repeat(120)}`];
      const badResults = badSpecs.map((text) => catalog.parseRepoSpec(text));
      check('A4. 不合法的仓库写法逐条拒绝', badResults.every((entry) => entry.ok === false && typeof entry.error === 'string'), badResults.map((entry) => entry.error).join(' / '));
      check('A5. 太长的地址拒绝（不截断）', catalog.parseRepoSpec(`https://github.com/${'a'.repeat(400)}/b`).ok === false);

      check('A6. 源 ID 对仓库名大小写不敏感、对分支敏感；条目 ID 是 32 位十六进制',
        catalog.sourceIdOf('Anthropics', 'Skills') === ANTHROPIC && catalog.sourceIdOf('anthropics', 'skills', 'dev') !== ANTHROPIC
        && /^[0-9a-f]{16}$/.test(ANTHROPIC) && catalog.ENTRY_ID_PATTERN.test(entryId('skills/pdf')) && entryId('skills/pdf').startsWith(ANTHROPIC));

      const treePayload = { tree: TREE_NODES.concat([
        { path: 'link', mode: '120000', type: 'blob', sha: 'a'.repeat(40), size: 1 },
        { path: 'sub', mode: '160000', type: 'commit', sha: 'b'.repeat(40) },
        { path: 'dir', mode: '040000', type: 'tree', sha: 'c'.repeat(40) },
        { path: 'badsha', mode: '100644', type: 'blob', sha: 'xyz', size: 1 },
        { path: 'nosize', mode: '100644', type: 'blob', sha: 'd'.repeat(40) },
      ]), truncated: true };
      const listed = catalog.filesFromGitTree(treePayload);
      check('A7. git 文件树：只收普通文件（100644 / 100755）；链接、子模块、目录、坏字段都不收；exec 位保留',
        listed.ok === true && listed.files.length === TREE_NODES.length && listed.truncated === true
        && listed.files.some((file) => file.path === 'skills/pdf/scripts/fill.py' && file.exec === true)
        && listed.files.filter((file) => file.path === 'skills/pdf/SKILL.md')[0].exec === false, JSON.stringify(listed).slice(0, 300));
      check('A8. 形状不对 → ok:false，不抛', catalog.filesFromGitTree(null).ok === false && catalog.filesFromGitTree({ tree: 'x' }).ok === false && catalog.filesFromGitTree({}).ok === false);

      const flat = catalog.filesFromFlatListing(FLAT_PAYLOAD(['skills/pdf/SKILL.md', 'skills/pdf/scripts/fill.py']));
      check('A9. jsDelivr 清单：名字去掉开头的 /，哈希是 base64 sha256', flat.ok === true && same(flat.files.map((file) => file.path), ['skills/pdf/SKILL.md', 'skills/pdf/scripts/fill.py'])
        && flat.files[0].hash === sha256b64(CONTENT.get('skills/pdf/SKILL.md')) && flat.files[0].exec === false);
      check('A10. 清单形状不对 → ok:false；单条不合规的记录被跳过', catalog.filesFromFlatListing({}).ok === false
        && catalog.filesFromFlatListing(null).ok === false
        && catalog.filesFromFlatListing({ files: [{ name: 'no-slash', hash: 'x', size: 1 }, { name: '/a', hash: 'short', size: 1 }] }).ok === true
        && catalog.filesFromFlatListing({ files: [{ name: 'no-slash', hash: 'x', size: 1 }] }).files.length === 0);

      const basicFiles = ['skills/pdf/SKILL.md', 'skills/pdf/scripts/fill.py', 'skills/docx/SKILL.md', 'README.md'].map((rel) => {
        const bytes = CONTENT.get(rel);
        return { path: rel, hash: gitBlob(bytes), size: bytes.length, exec: false };
      });
      const built = catalog.buildCatalogEntries(basicFiles);
      check('A11. 切成条目：每个含 SKILL.md 的目录一个；SKILL.md 排第一，其余按路径', built.truncated === false
        && same(built.entries.map((entry) => entry.dir), ['skills/docx', 'skills/pdf'])
        && same(built.entries[1].files.map((file) => file[0]), ['SKILL.md', 'scripts/fill.py'])
        && built.entries[1].fileCount === 2 && built.entries[1].blocked === '', JSON.stringify(built.entries));

      const nested = catalog.buildCatalogEntries([
        { path: 'a/SKILL.md', hash: 'a'.repeat(40), size: 1, exec: false },
        { path: 'a/nested/SKILL.md', hash: 'b'.repeat(40), size: 1, exec: false },
        { path: 'a/nested/other.txt', hash: 'c'.repeat(40), size: 1, exec: false },
      ]);
      check('A12. 技能目录里再嵌套的 SKILL.md 属于外层那个技能（不再往里找）', same(nested.entries.map((entry) => entry.dir), ['a'])
        && same(nested.entries[0].files.map((file) => file[0]), ['SKILL.md', 'nested/other.txt', 'nested/SKILL.md']), JSON.stringify(nested.entries));
      const rootPlus = catalog.buildCatalogEntries([
        { path: 'SKILL.md', hash: 'a'.repeat(40), size: 1, exec: false },
        { path: 'skills/x/SKILL.md', hash: 'b'.repeat(40), size: 1, exec: false },
      ]);
      check('A13. 根上的 SKILL.md 只在它是唯一一个时才算技能', same(rootPlus.entries.map((entry) => entry.dir), ['skills/x']));
      const whole = catalog.buildCatalogEntries([
        { path: 'SKILL.md', hash: 'a'.repeat(40), size: 1, exec: false },
        { path: 'docs/readme.md', hash: 'b'.repeat(40), size: 1, exec: false },
      ]);
      check('A14. 整个仓库是一个技能：dir 为空，仓库里的文件都归它', same(whole.entries.map((entry) => entry.dir), [''])
        && same(whole.entries[0].files.map((file) => file[0]), ['SKILL.md', 'docs/readme.md']));
      const template = catalog.buildCatalogEntries([
        { path: 'SKILL.md', hash: 'a'.repeat(40), size: 1, exec: false },
        { path: 'template/SKILL.md', hash: 'b'.repeat(40), size: 1, exec: false },
      ]);
      check('A15. 仓库顶层 template/ 下的 SKILL.md 只是模板：不因此多出一个技能；整个仓库是一个技能时它只是一份资源文件', same(template.entries.map((entry) => entry.dir), [''])
        && same(template.entries[0].files.map((file) => file[0]), ['SKILL.md', 'template/SKILL.md']));

      const blockedFile = catalog.buildCatalogEntries([
        { path: 'skills/b/SKILL.md', hash: 'a'.repeat(40), size: 10, exec: false },
        { path: 'skills/b/huge.bin', hash: 'b'.repeat(40), size: HUGE_SIZE, exec: false },
      ]).entries[0];
      check('A16. 有文件超过 2 MB → 不可安装，只留 SKILL.md 供预览', blockedFile.blocked === 'file-too-large' && blockedFile.fileCount === 2
        && same(blockedFile.files.map((file) => file[0]), ['SKILL.md']) && catalog.blockNote(blockedFile.blocked) === '它有文件超过 2 MB');
      const manyRecords = [{ path: 'skills/m/SKILL.md', hash: 'a'.repeat(40), size: 1, exec: false },
        ...Array.from({ length: 200 }, (_, index) => ({ path: `skills/m/f-${String(index).padStart(3, '0')}`, hash: 'b'.repeat(40), size: 1, exec: false }))];
      const tooMany = catalog.buildCatalogEntries(manyRecords).entries[0];
      check('A17. 超过 200 个文件 → 不可安装', tooMany.blocked === 'too-many-files' && tooMany.fileCount === 201 && same(tooMany.files.map((file) => file[0]), ['SKILL.md']));
      const fatRecords = [{ path: 'skills/f/SKILL.md', hash: 'a'.repeat(40), size: 1, exec: false },
        ...Array.from({ length: 7 }, (_, index) => ({ path: `skills/f/part-${index}.bin`, hash: 'b'.repeat(40), size: 1940000, exec: false }))];
      check('A18. 总大小超过 12 MB → 不可安装', catalog.buildCatalogEntries(fatRecords).entries[0].blocked === 'too-large');
      const bigSkillMd = catalog.buildCatalogEntries([{ path: 'skills/big/SKILL.md', hash: 'a'.repeat(40), size: BIGMD_SIZE, exec: false }]).entries[0];
      check('A19. SKILL.md 超过 256 KB → 不可安装，连预览用的记录也不留', bigSkillMd.blocked === 'skill-md-too-large' && bigSkillMd.files.length === 0
        && catalog.blockNote('skill-md-too-large') === '它的 SKILL.md 太大');
      const unsafeEntry = catalog.buildCatalogEntries([
        { path: 'skills/u/SKILL.md', hash: 'a'.repeat(40), size: 1, exec: false },
        { path: 'skills/u/bad\\name.txt', hash: 'b'.repeat(40), size: 1, exec: false },
      ]).entries[0];
      check('A20. 包里有不安全的路径 → 不可安装', unsafeEntry.blocked === 'unsafe-path' && unsafeEntry.fileCount === 1);
      const skipped = catalog.buildCatalogEntries([
        { path: 'skills/s/SKILL.md', hash: 'a'.repeat(40), size: 1, exec: false },
        { path: 'skills/s/.env', hash: 'b'.repeat(40), size: 1, exec: false },
        { path: 'skills/s/node_modules/x.js', hash: 'c'.repeat(40), size: 1, exec: false },
      ]).entries[0];
      check('A21. 会被跳过的文件（隐藏、node_modules）只计数，不进清单', skipped.skipped === 2 && skipped.fileCount === 1 && skipped.files.length === 1);

      const cut = catalog.buildCatalogEntries(basicFiles, { maxEntries: 1 });
      check('A22. 条目数封顶：到上限就截断并标明', cut.entries.length === 1 && cut.truncated === true);

      const goodEntry = { dir: 'a', files: [['SKILL.md', 'h', 1, 0]], fileCount: 1, skipped: 0, bytes: 1, blocked: '' };
      check('A23. 缓存条目形状校验：正常的通过', catalog.validSnapshotEntries([goodEntry]) === true
        && catalog.validSnapshotEntries([{ ...goodEntry, description: 'cached' }]) === true);
      check('A24. 缓存里的越界路径 / 坏字段整份拒绝（它们会被拼进 URL）', [
        catalog.validSnapshotEntries([{ ...goodEntry, files: [['../evil', 'h', 1, 0]] }]),
        catalog.validSnapshotEntries([{ ...goodEntry, files: [['C:/x', 'h', 1, 0]] }]),
        catalog.validSnapshotEntries([{ ...goodEntry, files: [['SKILL.md', 'h', 1, 2]] }]),
        catalog.validSnapshotEntries([{ ...goodEntry, fileCount: '1' }]),
        catalog.validSnapshotEntries('nope'),
      ].every((ok) => ok === false));

      const source = { id: ANTHROPIC, owner: 'anthropics', repo: 'skills', ref: '' };
      const curated = { dir: 'skills/pdf', description: 'Curated text', categories: ['docs'] };
      const previewEntry = catalog.describeEntry(source, null, curated, '');
      check('A25. 给界面的条目：预置条目没有文件数、可以安装；Anthropic 的仓库才标「官方」', previewEntry.listed === false && previewEntry.installable === true
        && previewEntry.fileCount === null && previewEntry.description === 'Curated text' && previewEntry.official === true && same(previewEntry.categories, ['docs'])
        && catalog.describeEntry({ ...source, owner: 'other' }, null, curated, '').official === false);
      const blockedPreview = catalog.describeEntry(source, { dir: 'skills/b', files: [], fileCount: 2, skipped: 0, bytes: 1, blocked: 'file-too-large' }, undefined, COMMIT);
      check('A26. 不可安装的条目带原因；主页链接指向固定的提交', blockedPreview.installable === false && blockedPreview.reason === '它有文件超过 2 MB'
        && blockedPreview.homepage === `https://github.com/anthropics/skills/tree/${COMMIT}/skills/b`
        && catalog.describeEntry(source, { dir: 'skills/my skill', files: [], fileCount: 0, skipped: 0, bytes: 0, blocked: '' }, undefined, 'dev').homepage.endsWith('/tree/dev/skills/my%20skill'));

      check('A27. git blob 哈希与已知向量一致（空文件、hello）', catalog.gitBlobSha1(Buffer.alloc(0)) === 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
        && catalog.gitBlobSha1(Buffer.from('hello\n')) === 'ce013625030ba8dba906f756967f9e9ca394464a'
        && catalog.sha256Base64(Buffer.from('hello\n')) === 'WJG1tSLV3whtD/CxEPvZ0hu0/HFjrzTQgoai6Eb2vgM=');
      const hello = Buffer.from('hello\n');
      check('A28. 完整性核对：大小与哈希都对才行；两种模式各用各的哈希（不可互换）', catalog.contentMatches('pinned', gitBlob(hello), hello.length, hello) === true
        && catalog.contentMatches('cdn', sha256b64(hello), hello.length, hello) === true
        && catalog.contentMatches('pinned', sha256b64(hello), hello.length, hello) === false
        && catalog.contentMatches('cdn', gitBlob(hello), hello.length, hello) === false
        && catalog.contentMatches('pinned', gitBlob(hello), hello.length + 1, hello) === false
        && catalog.contentMatches('cdn', sha256b64(hello), hello.length, Buffer.from('hello!')) === false
        && catalog.contentMatches('cdn', 'x', hello.length, 'not a buffer') === false);

      const urls = catalog.contentUrls({ owner: 'a', repo: 'b' }, 'dev', 'skills/x y/SKILL.md');
      check('A29. 文件地址：路径逐段编码，分支也编码', urls.cdn === 'https://cdn.jsdelivr.net/gh/a/b@dev/skills/x%20y/SKILL.md'
        && urls.raw === 'https://raw.githubusercontent.com/a/b/dev/skills/x%20y/SKILL.md');
      check('A30. 目录名收成技能名；未知的阻断原因有兜底说法', catalog.slugOfDir('skills/pdf') === 'pdf' && catalog.slugOfDir('', 'my-repo') === 'my-repo'
        && catalog.slugOfDir('skills/Cool Skill') === 'cool-skill' && catalog.blockNote('nope') === '它不符合安装限制' && catalog.blockNote('') === '');
      check('A31. 提交 / 分支名的判据', catalog.isCommitSha(COMMIT) === true && catalog.isCommitSha('abc') === false
        && catalog.isRefName('dev') === true && catalog.isRefName('a/b') === false && catalog.isRefName('..') === false);
      const badDirs = catalog.buildCatalogEntries([
        { path: 'skills/../evil/SKILL.md', hash: 'a'.repeat(40), size: 1, exec: false },
        { path: 'skills/bad\\dir/SKILL.md', hash: 'b'.repeat(40), size: 1, exec: false },
        { path: '.hidden/SKILL.md', hash: 'c'.repeat(40), size: 1, exec: false },
      ]);
      check('A33. 技能目录本身不合规（.. 段 / 反斜杠）→ 不列；点开头的目录照收（.claude/skills 是真实存在的位置）',
        same(badDirs.entries.map((entry) => entry.dir), ['.hidden']));
    }

    /* ============================================================ */
    section('B. 线路与地址（与 MCP 市场的既有实现对照）');
    {
      const checked = [
        ['https://api.github.com/x', 'ok'], ['http://api.github.com/x', 'blocked-url'], ['https://api.github.com:8443/x', 'blocked-url'],
        ['https://user:pw@api.github.com/x', 'blocked-url'], ['https://localhost/x', 'blocked-host'], ['https://127.0.0.1/x', 'blocked-host'],
        ['not a url', 'blocked-url'],
      ].map(([url, want]) => [netmod.checkMarketUrl(url), want]);
      check('B0. URL 边界：HTTPS、443、无凭据、非本机主机名', checked.every(([result, want]) => (want === 'ok' ? result.ok === true : result.code === want)),
        checked.map(([result]) => pick(result)).join(','));
      check('B1. 主机白名单比 MCP 更窄：只连这四个', same([...netmod.MARKET_HOSTS], ['api.github.com', 'cdn.jsdelivr.net', 'data.jsdelivr.com', 'raw.githubusercontent.com'])
        && netmod.checkMarketUrl('https://example.com/x').code === 'blocked-host'
        && M.checkMarketUrl('https://example.com/x').ok === true
        && netmod.checkMarketUrl('https://cdn.jsdelivr.net/gh/a/b@c/SKILL.md').ok === true);

      const lookups = {
        public: async () => [{ address: '93.184.216.34', family: 4 }],
        private: async () => [{ address: '10.1.2.3', family: 4 }],
        loopback: async () => [{ address: '127.0.0.1', family: 4 }],
        fake: async () => [{ address: '198.18.0.9', family: 4 }],
        mixed: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.1.2.3', family: 4 }],
        v6: async () => [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }],
        throw: async () => { throw new Error('dns down'); },
        empty: async () => [],
        garbage: async () => [{ address: 'not-an-ip', family: 4 }],
      };
      const flags = [{ allowFakeIp: false, allowProxiedFakeIp: true }, { allowFakeIp: false, allowProxiedFakeIp: false }, { allowFakeIp: true, allowProxiedFakeIp: true }];
      const comparisons = [];
      for (const [name, lookupImpl] of Object.entries(lookups)) {
        for (const route of ['direct', 'proxied', 'unknown']) {
          for (const flag of flags) {
            const parsed = new URL('https://api.github.com/x');
            const mine = await netmod.inspectMarketTarget(parsed, { route, lookupImpl, ...flag });
            const theirs = await M.inspectMarketTarget(parsed, { route, lookupImpl, ...flag });
            if (pick(mine) !== pick(theirs)) comparisons.push(`${name}/${route}/${flag.allowFakeIp}/${flag.allowProxiedFakeIp}:${pick(mine)}!=${pick(theirs)}`);
          }
        }
      }
      check('B2. 地址判定与 MCP 逐条一致（公网 / 私网 / 回环 / fake-IP / 混合 / IPv6 / 解析失败 / 空 / 非法 × 三种线路）', comparisons.length === 0, comparisons.slice(0, 5).join(' '));
      const ipCases = ['https://93.184.216.34/x', 'https://10.0.0.5/x', 'https://198.18.0.9/x', 'https://[::1]/x'];
      const ipMismatch = [];
      for (const raw of ipCases) {
        const mine = await netmod.inspectMarketTarget(new URL(raw), {});
        const theirs = await M.inspectMarketTarget(new URL(raw), {});
        if (pick(mine) !== pick(theirs)) ipMismatch.push(`${raw}:${pick(mine)}!=${pick(theirs)}`);
      }
      check('B3. IP 字面量同样一致（fake-IP 直接拒绝，私网 / 回环拒绝，公网放行）', ipMismatch.length === 0, ipMismatch.join(' '));

      const proxiedBridge = { resolveRoute: async () => 'proxied', fetchProxied: async () => ({ ok: true, status: 200, headers: {}, body: '{}' }) };
      const directBridge = { resolveRoute: async () => 'direct', fetchProxied: async () => ({ ok: true, status: 200, headers: {}, body: '{}' }) };
      const incompleteBridge = { resolveRoute: async () => 'direct' };
      const throwingBridge = { resolveRoute: async () => { throw new Error('x'); }, fetchProxied: async () => ({ ok: true, status: 200, headers: {}, body: '{}' }) };
      const weirdBridge = { resolveRoute: async () => 'weird', fetchProxied: async () => ({ ok: true, status: 200, headers: {}, body: '{}' }) };
      const routeScenes = [];
      for (const [name, network] of Object.entries({ none: null, direct: directBridge, proxied: proxiedBridge, incomplete: incompleteBridge, throwing: throwingBridge, weird: weirdBridge })) {
        for (const env of [{}, { HTTPS_PROXY: 'http://p:7890' }, { https_proxy: 'socks5://q' }, { NO_PROXY: 'api.github.com' },
          { NO_PROXY: '*', ALL_PROXY: 'socks5://x' }, { NO_PROXY: '.github.com' }, { NO_PROXY: 'other.com', HTTP_PROXY: 'http://p' },
          { NO_PROXY: 'api.github.com', HTTPS_PROXY: 'http://p' }]) {
          routeScenes.push({ name, network, env });
        }
      }
      const shape = (r) => `${r.route}|${r.source}|${r.reason || ''}|${r.proxyKey || ''}`;
      const routeMismatch = [];
      for (const scene of routeScenes) {
        const parsed = new URL('https://api.github.com/x');
        const mine = await netmod.resolveMarketRoute(parsed, { network: scene.network, env: scene.env });
        const theirs = await M.resolveMarketRoute(parsed, { network: scene.network, env: scene.env });
        if (shape(mine) !== shape(theirs)) routeMismatch.push(`${scene.name}/${JSON.stringify(scene.env)}:${shape(mine)}!=${shape(theirs)}`);
      }
      check('B4. 线路判定与 MCP 逐条一致（桥 × 环境变量矩阵；unknown / unsupported 都不当直连）', routeMismatch.length === 0, routeMismatch.slice(0, 5).join(' '));

      /* ---------- 取数：同一组输入，两边结论必须一致 ---------- */
      const okBody = (text = '{"ok":1}', status = 200) => ({
        mine: async () => ({ status, body: status >= 200 && status < 300 ? Buffer.from(text) : null }),
        mcp: async () => new Response(status >= 200 && status < 300 ? text : null, { status, headers: { 'content-type': 'application/json' } }),
      });
      const throwing = (err) => ({ mine: async () => { throw err; }, mcp: async () => { throw err; } });
      const proxyBody = (text = '{"ok":1}', status = 200) => ({ ok: true, status, headers: { 'content-type': 'application/json' }, body: text });
      const bridgeOf = (route, fetch = async () => proxyBody()) => ({
        resolveRoute: async () => { if (route instanceof Error) throw route; return route; },
        fetchProxied: async (url, options) => { if (fetch instanceof Error) throw fetch; return fetch(url, options); },
      });
      const coded = (code) => Object.assign(new Error(code), { marketCode: code });
      const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

      const cases = [
        { name: '直连 200', want: 'ok', lookup: publicLookup, request: okBody(), network: null, env: {} },
        { name: '私网地址', want: 'blocked-host', lookup: async () => [{ address: '10.0.0.5', family: 4 }], request: okBody(), network: null, env: {}, noHttp: true },
        { name: 'fake-IP 无桥', want: 'proxy-blocked', lookup: async () => [{ address: '198.18.0.9', family: 4 }], request: okBody(), network: null, env: {}, noHttp: true },
        { name: '解析失败', want: 'dns-failed', lookup: async () => { throw new Error('x'); }, request: okBody(), network: null, env: {}, noHttp: true },
        { name: '没有解析结果', want: 'dns-failed', lookup: async () => [], request: okBody(), network: null, env: {}, noHttp: true },
        { name: '有代理变量但没有桥', want: 'proxy-unsupported', lookup: publicLookup, request: okBody(), network: null, env: { HTTPS_PROXY: 'http://p:1' }, noHttp: true },
        { name: '桥只给直连还带着代理变量', want: 'proxy-blocked', lookup: publicLookup, request: okBody(), network: bridgeOf('direct'), env: { HTTPS_PROXY: 'http://p:1' }, noHttp: true },
        { name: '桥能力不完整', want: 'proxy-unsupported', lookup: publicLookup, request: okBody(), network: incompleteBridge, env: {}, noHttp: true },
        { name: '桥解析抛错', want: 'proxy-blocked', lookup: publicLookup, request: okBody(), network: bridgeOf(new Error('boom')), env: {}, noHttp: true },
        { name: '桥给了不认识的值', want: 'proxy-blocked', lookup: publicLookup, request: okBody(), network: weirdBridge, env: {}, noHttp: true },
        { name: '代理线路 200', want: 'ok', lookup: publicLookup, request: okBody(), network: bridgeOf('proxied'), env: {} },
        { name: '代理线路 + fake-IP', want: 'ok', lookup: async () => [{ address: '198.18.0.9', family: 4 }], request: okBody(), network: bridgeOf('proxied'), env: {} },
        { name: '代理线路 407', want: 'proxy-auth-required', lookup: publicLookup, request: okBody(), network: bridgeOf('proxied', async () => proxyBody('no', 407)), env: {} },
        { name: '代理桥响应过大', want: 'too-large', lookup: publicLookup, request: okBody(), network: bridgeOf('proxied', async () => proxyBody('x'.repeat(100))), env: {}, maxBytes: 64 },
        { name: '重定向', want: 'redirect-blocked', lookup: publicLookup, request: okBody('', 302), network: null, env: {} },
        { name: 'HTTP 404', want: 'http-404', lookup: publicLookup, request: okBody('', 404), network: null, env: {} },
        { name: '直连超时', want: 'timeout', lookup: publicLookup, request: throwing(coded('timeout')), network: null, env: {} },
        { name: '直连失败', want: 'network', lookup: publicLookup, request: throwing(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })), network: null, env: {} },
        { name: '直连响应过大', want: 'too-large', lookup: publicLookup, request: throwing(coded('too-large')), network: null, env: {} },
        { name: 'NO_PROXY 命中', want: 'ok', lookup: publicLookup, request: okBody(), network: bridgeOf('direct'), env: { NO_PROXY: 'api.github.com', HTTPS_PROXY: 'http://p:1' } },
        { name: '代理线路 + 同一代理的环境变量', want: 'ok', lookup: publicLookup, request: okBody(), network: bridgeOf('proxied'), env: { HTTPS_PROXY: 'http://p:1' } },
      ];
      const mismatches = [];
      for (const c of cases) {
        let httpCalls = 0;
        const lookup = async (...args) => c.lookup(...args);
        const requestMine = async (url, options) => { httpCalls += 1; return c.request.mine(url, options); };
        const requestMcp = async (url, options) => { httpCalls += 1; return c.request.mcp(url, options); };
        const maxBytes = c.maxBytes || 1024;
        const mineNet = netmod.createSkillsMarketNetwork({ network: c.network, env: c.env, requestImpl: requestMine, lookupImpl: lookup });
        let mine;
        try {
          mine = pick(await mineNet.fetchBytes('https://api.github.com/repos/a/b/commits?per_page=1', { maxBytes }));
        } catch (err) {
          mine = `threw:${err && err.message}`;
        }
        const theirs = pick(await M.fetchJson('https://api.github.com/repos/a/b/commits?per_page=1', {
          requestImpl: requestMcp, lookupImpl: lookup, env: c.env, network: c.network, maxBytes, timeoutMs: 10000,
        }));
        if (mine !== c.want || theirs !== c.want) mismatches.push(`${c.name}: mine=${mine} mcp=${theirs} want=${c.want}`);
        if (c.noHttp && httpCalls !== 0) mismatches.push(`${c.name}: 不该发起 HTTP（发了 ${httpCalls} 次）`);
      }
      check(`B5. ${cases.length} 种取数情形：与 MCP 结论一致，且与预期一致；该拒绝的连 HTTP 都不发`, mismatches.length === 0, mismatches.slice(0, 4).join(' | '));

      const failureCodes = ['blocked-route', 'too-large', 'timeout', 'proxy-auth-required', 'proxy-unreachable', 'tls-failed', 'dns-failed'];
      const failureMismatch = [];
      for (const code of failureCodes) {
        const network = bridgeOf('proxied', coded(code));
        const mine = pick(await netmod.createSkillsMarketNetwork({ network, env: {}, lookupImpl: publicLookup, requestImpl: okBody().mine }).fetchBytes('https://api.github.com/x'));
        const theirs = pick(await M.fetchJson('https://api.github.com/x', { network, env: {}, lookupImpl: publicLookup, requestImpl: okBody().mcp }));
        const want = code === 'blocked-route' ? 'proxy-blocked' : code;
        if (mine !== want || theirs !== want) failureMismatch.push(`${code}: mine=${mine} mcp=${theirs} want=${want}`);
      }
      check('B6. 代理桥的失败都收敛成固定 code（线路变化 / 过大 / 超时 / 认证 / 不可达 / 证书 / DNS），与 MCP 一致', failureMismatch.length === 0, failureMismatch.join(' '));
      const busyMine = pick(await netmod.createSkillsMarketNetwork({ network: bridgeOf('proxied', coded('busy')), env: {}, lookupImpl: publicLookup, requestImpl: okBody().mine }).fetchBytes('https://api.github.com/x'));
      const busyMcp = pick(await M.fetchJson('https://api.github.com/x', { network: bridgeOf('proxied', coded('busy')), env: {}, lookupImpl: publicLookup, requestImpl: okBody().mcp }));
      check('B7. 通道忙：两边都算失败；这里给出更具体的 busy（MCP 归到 network）', busyMine === 'busy' && busyMcp === 'network');
      const genericMine = pick(await netmod.createSkillsMarketNetwork({ network: bridgeOf('proxied', new Error('boom')), env: {}, lookupImpl: publicLookup, requestImpl: okBody().mine }).fetchBytes('https://api.github.com/x'));
      check('B8. 不认识的代理错误 → network，不回显代理地址或原始报错', genericMine === 'network');

      const desktop = (relaxed, route, lookup) => netmod.createSkillsMarketNetwork({
        network: bridgeOf(route), env: { PI_GUI_DESKTOP: '1', PI_GUI_NETWORK_RELAXED: relaxed }, lookupImpl: lookup, requestImpl: okBody().mine,
      }).fetchBytes('https://api.github.com/x');
      const fakeLookup = async () => [{ address: '198.18.0.9', family: 4 }];
      check('B9. 桌面端放宽策略：只有「放宽 + 代理线路」才接受 TUN fake-IP', pick(await desktop('1', 'proxied', fakeLookup)) === 'ok'
        && pick(await desktop('0', 'proxied', fakeLookup)) === 'proxy-blocked'
        && pick(await desktop('1', 'direct', fakeLookup)) === 'proxy-blocked'
        && pick(await desktop('1', 'proxied', publicLookup)) === 'ok');

      const options = netmod.pinnedRequestOptions(new URL('https://api.github.com/x?y=1'), '93.184.216.34', 4);
      let pinned = null;
      options.lookup('api.github.com', { all: true }, (err, rows) => { pinned = rows; });
      check('B10. 直连把连接钉在已校验的 IP 上：SNI / 证书仍按域名，lookup 只回那一个地址', options.hostname === 'api.github.com'
        && options.servername === 'api.github.com' && options.agent === false && same(pinned, [{ address: '93.184.216.34', family: 4 }]));

      const weirdInputs = ['not a url', 'http://api.github.com/x', 'https://localhost/x', 'https://api.github.com:8443/x'];
      const neverThrows = [];
      for (const url of weirdInputs) {
        const net = netmod.createSkillsMarketNetwork({ env: {}, lookupImpl: publicLookup, requestImpl: okBody().mine });
        try {
          const result = await net.fetchBytes(url);
          neverThrows.push(pick(result));
        } catch (err) {
          neverThrows.push(`threw:${err && err.message}`);
        }
      }
      check('B11. 取数永不抛：边界输入都收敛成失败码', same(neverThrows, ['blocked-url', 'blocked-url', 'blocked-host', 'blocked-url']), neverThrows.join(','));
    }

    /* ============================================================ */
    section('C. 目录加载与缓存');
    const primary = setup('market');
    {
      const { w, wire, make, clock } = primary;
      const market = make();
      const before = wire.calls.length;
      const state = market.state();
      const pdfPreviewEntry = state.entries.find((entry) => entry.dir === 'skills/pdf');
      check('C1. state 只读本机：默认有七个目录源，Anthropic 的仓库先给出八条预置条目', state.ok === true && state.sources.length === 7
        && state.sources[0].repo === REPO && state.sources[0].builtin === true && state.sources[0].loaded === false && state.sources[0].count === 8
        && state.entries.length === 8 && state.categories.length === 5 && state.persistent === true
        && same(state.limits, { maxCustomSources: 20, pageSize: 24 }) && wire.calls.length === before, JSON.stringify(state.sources[0]));
      check('C2. 预置条目没有文件数、可以安装；主机名单原样交给界面', pdfPreviewEntry.listed === false && pdfPreviewEntry.installable === true
        && pdfPreviewEntry.description === 'Read, extract, merge, split, and generate PDF files'
        && same([...state.hosts], [...netmod.MARKET_HOSTS]));
      check('C3. 没有数据目录时只在内存里（persistent=false），一样能用', make({ dataDir: null }).state().persistent === false);

      const refreshed = await market.refresh({ sourceId: ANTHROPIC });
      const body = refreshed.ok ? refreshed.source : {};
      check('C4. 加载目录：先取最新提交，再取那个提交的文件树（两次请求）', refreshed.ok === true && refreshed.refreshed === true
        && wire.calls.length === before + 2 && wire.calls[before].url === COMMITS_URL && wire.calls[before + 1].url === TREE_URL, JSON.stringify(wire.calls.slice(before).map((call) => call.url)));
      check('C5. 目录被固定在提交上：mode=pinned、resolvedRef 是提交、12 条条目', body.loaded === true && body.mode === 'pinned' && body.resolvedRef === COMMIT
        && body.count === 12 && body.fetchedAt === clock.value && body.error === '' && body.truncated === false, JSON.stringify(body));
      const listed = market.state().entries.filter((entry) => entry.sourceId === ANTHROPIC);
      const byDir = (dir) => listed.find((entry) => entry.dir === dir) || {};
      check('C6. 条目：SKILL.md 排第一、附属文件都在、模板被排除、超限的只留预览用的 SKILL.md', listed.length === 12
        && same(listed.map((entry) => entry.dir), ['skills/bigmd', 'skills/blocked', 'skills/docx', 'skills/paired', 'skills/pdf', 'skills/tiny-a', 'skills/tiny-b', 'skills/tiny-c', 'skills/tiny-d', 'skills/tiny-e', 'skills/tiny-f', 'skills/unsafe'])
        && byDir('skills/pdf').fileCount === 2 && byDir('skills/pdf').installable === true
        && byDir('skills/blocked').installable === false && byDir('skills/blocked').reason === '它有文件超过 2 MB'
        && byDir('skills/bigmd').reason === '它的 SKILL.md 太大'
        && byDir('skills/unsafe').reason === '它包含不安全的文件路径', JSON.stringify(listed.map((entry) => entry.dir)));
      const snapshotFile = path.join(w.data, 'skills-market', `catalog-${ANTHROPIC}.json`);
      const stored = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
      check('C7. 快照落盘：版本、源、模式、提交、条目都在', stored.version === 1 && stored.sourceId === ANTHROPIC && stored.repo === REPO
        && stored.mode === 'pinned' && stored.resolvedRef === COMMIT && stored.fetchedAt === clock.value
        && stored.entries.length === 12 && stored.truncated === false, JSON.stringify(stored).slice(0, 200));

      const again = await market.refresh({ sourceId: ANTHROPIC });
      check('C8. 十分钟内不重复读；强制刷新才再读一次', again.ok === true && again.refreshed === false && wire.calls.length === before + 2,
        `${again.refreshed} ${wire.calls.length}`);
      clock.value += 10 * 60 * 1000;
      const forced = await market.refresh({ sourceId: ANTHROPIC, force: true });
      check('C9. force 忽略新鲜度', forced.ok === true && forced.refreshed === true && wire.calls.length === before + 4);

      const fresh = make();
      const stateAfter = fresh.state();
      check('C10. 新实例直接读缓存：不联网就能看到同一份目录', stateAfter.sources[0].loaded === true && stateAfter.sources[0].count === 12
        && wire.calls.length === before + 4);
    }
    {
      const { w, wire, make, clock } = primary;
      const snapshotFile = path.join(w.data, 'skills-market', `catalog-${ANTHROPIC}.json`);
      const original = fs.readFileSync(snapshotFile, 'utf8');
      const broken = [
        ['坏 JSON', 'not json'],
        ['版本不符', JSON.stringify({ version: 2 })],
        ['缓存里有越界路径', JSON.stringify({ ...JSON.parse(original), entries: [{ dir: 'skills/pdf', files: [['../evil', 'h', 1, 0]], fileCount: 1, skipped: 0, bytes: 1, blocked: '' }] })],
      ];
      const seen = [];
      for (const [, text] of broken) {
        fs.writeFileSync(snapshotFile, text);
        const state = make().state();
        seen.push(`${state.sources[0].loaded}|${state.sources[0].count}`);
      }
      fs.writeFileSync(snapshotFile, original);
      check('C11. 缓存坏了 / 版本不对 / 路径越界：整份当作没加载过，退回预置条目', same(seen, ['false|8', 'false|8', 'false|8']), seen.join(','));

      // 并发刷新只读一次：先到的那次停在「取提交」那一步，后来的必须搭同一班车
      const { w: gateWorld, wire: gateWire, make: makeGate } = setup('market-gate');
      let openGate = () => {};
      gateWire.controls.gate = new Promise((resolve) => { openGate = resolve; });
      const market = makeGate();
      const first = market.refresh({ sourceId: ANTHROPIC });
      const second = market.refresh({ sourceId: ANTHROPIC });
      await new Promise((resolve) => setImmediate(resolve));
      openGate();
      gateWire.controls.gate = null;
      const [a, b] = await Promise.all([first, second]);
      const commitCalls = gateWire.calls.filter((call) => call.url === COMMITS_URL).length;
      check('C12. 同一目录源的并发刷新只读一次（搭同一班车）', commitCalls === 1 && a.ok === true && b.ok === true && a.refreshed === true && b.refreshed === true
        && gateWire.calls.length === 2, `${commitCalls} ${gateWire.calls.length}`);

      check('C13. 目录源 ID 不合法 / 不存在 → 400 / 404', verdict(await market.refresh({ sourceId: 'nope' })) === '400:bad-request'
        && verdict(await market.refresh({ sourceId: 'f'.repeat(16) })) === '404:source-gone');
    }
    {
      const { make, wire } = setup('market-fail');
      const market = make();
      await market.refresh({ sourceId: ANTHROPIC });
      wire.controls.fail.set(COMMITS_URL, { ok: false, code: 'http-404', status: 404, error: 'api.github.com 返回 HTTP 404' });
      const missing = await market.refresh({ sourceId: ANTHROPIC, force: true });
      check('C14. 仓库不存在（GitHub 404 且没有清单回退）→ 200 + not-found，说明怎么写', verdict(missing) === '200:not-found'
        && /找不到仓库 anthropics\/skills/.test(missing.error) && missing.source.errorCode === 'not-found', missing.error);
      const state = market.state();
      check('C15. 失败留在 state 里，界面能看到原因', state.sources[0].errorCode === 'not-found' && /找不到仓库/.test(state.sources[0].error));

      wire.controls.fail.set(COMMITS_URL, { ok: false, code: 'http-403', status: 403, error: 'api.github.com 返回 HTTP 403' });
      const limited = await market.refresh({ sourceId: ANTHROPIC, force: true });
      check('C16. 限流：原样带出并提示未登录的 60 次/小时', verdict(limited) === '200:http-403' && /限流/.test(limited.error), limited.error);

      wire.controls.fail.delete(COMMITS_URL);
      wire.controls.fail.set(TREE_URL, { ok: true, status: 200, route: 'direct', bytes: Buffer.from('{}') });
      const malformed = await market.refresh({ sourceId: ANTHROPIC, force: true });
      check('C17. 文件清单形状不对 → bad-response（回退也失败时报告主线路）', verdict(malformed) === '200:bad-response'
        && /文件清单格式不对/.test(malformed.error), `${verdict(malformed)} ${malformed.error}`);
    }
    {
      const { make, wire } = setup('market-cdn');
      const market = make();
      wire.controls.fail.set(COMMITS_URL, { ok: false, code: 'http-500', status: 500, error: 'api.github.com 返回 HTTP 500' });
      wire.controls.flat.set('main', FLAT_PAYLOAD(['skills/pdf/SKILL.md', 'skills/pdf/scripts/fill.py', 'template/SKILL.md']));
      const fallback = await market.refresh({ sourceId: ANTHROPIC });
      check('C18. GitHub 接口不可用 → 改用 jsDelivr 的文件清单（按分支）', fallback.ok === true && fallback.source.mode === 'cdn'
        && fallback.source.resolvedRef === 'main' && fallback.source.count === 1, JSON.stringify(fallback.source));
      const pdf = market.state().entries.find((entry) => entry.dir === 'skills/pdf');
      const previewed = await market.preview({ entryId: pdf.id });
      check('C19. cdn 模式按 sha256 核对：内容一致才收', previewed.ok === true && previewed.content === PDF_MD
        && previewed.files.every((file) => file.status === 'ok') && previewed.source.mode === 'cdn' && previewed.source.ref === 'main', previewed.error);
      wire.controls.flat.delete('main');
      wire.controls.flat.set('master', FLAT_PAYLOAD(['skills/pdf/SKILL.md']));
      const master = await make().refresh({ sourceId: ANTHROPIC, force: true });
      check('C20. 没指定分支时按 main → master 依次尝试', master.ok === true && master.source.resolvedRef === 'master', JSON.stringify(master.source));
    }
    {
      const { make, w, wire, clock } = setup('market-sources');
      const market = make();
      const added = await market.addSource({ repo: 'https://github.com/foo/bar' });
      check('C21. 添加自定义目录源：可以写仓库网址，存成 owner/repo', added.ok === true && added.source.repo === 'foo/bar'
        && added.source.builtin === false && added.source.removable === true && added.source.loaded === false, JSON.stringify(added));
      const stored = JSON.parse(fs.readFileSync(path.join(w.data, 'skills-market', 'sources.json'), 'utf8'));
      check('C22. 自定义源落盘（版本、仓库、分支、添加时间）', stored.version === 1 && same(stored.custom, [{ repo: 'foo/bar', ref: '', addedAt: clock.value }]), JSON.stringify(stored));
      check('C23. 重复添加 / 添加默认源 → 409；写法不对 → 400', verdict(await market.addSource({ repo: 'foo/bar' })) === '409:exists'
        && verdict(await market.addSource({ repo: REPO })) === '409:exists' && verdict(await market.addSource({ repo: 'not-a-repo' })) === '400:bad-repo'
        && verdict(await market.addSource({ repo: 'https://gitlab.com/a/b' })) === '400:bad-repo');
      const withRefs = await market.addSource({ repo: 'foo/bar@dev' });
      check('C24. 同一个仓库的不同分支是两个目录源', withRefs.ok === true && withRefs.source.ref === 'dev' && market.state().sources.length === 9);
      for (let index = 1; index <= 18; index += 1) await market.addSource({ repo: `bulk/repo-${index}` });
      const over = await market.addSource({ repo: 'bulk/one-too-many' });
      check('C25. 自定义目录源最多 20 个', verdict(over) === '409:too-many' && market.state().sources.length === 27);
      const snapshotFile = path.join(w.data, 'skills-market', `catalog-${withRefs.source.id}.json`);
      fs.writeFileSync(snapshotFile, '{}');
      check('C26. 默认源不能移除；不存在的源 → 404；自定义源可以移除', verdict(await market.removeSource({ id: ANTHROPIC })) === '403:builtin'
        && verdict(await market.removeSource({ id: 'f'.repeat(16) })) === '404:source-gone'
        && fs.existsSync(snapshotFile)
        && (await market.removeSource({ id: withRefs.source.id })).ok === true);
      check('C27. 移除自定义源会顺手删掉它的缓存文件', !fs.existsSync(snapshotFile));
      const reloaded = make().state();
      check('C28. 重新载入后自定义源与磁盘一致（没有刚移除的那个）', reloaded.sources.length === 26
        && reloaded.sources.some((entry) => entry.repo === 'foo/bar') && !reloaded.sources.some((entry) => entry.repo === 'foo/bar' && entry.ref === 'dev'));

      // 手写的 sources.json 里有无效条目：跳过，不炸
      fs.writeFileSync(path.join(w.data, 'skills-market', 'sources.json'), JSON.stringify({
        version: 1, custom: [{ repo: 'bad' }, { repo: 'ok/repo' }, { repo: 'ok/repo@dev' }, { repo: 5 }],
      }));
      const filtered = make().state();
      check('C29. 落盘的目录源里坏条目被剔掉，合法的照常', same(filtered.sources.slice(7).map((entry) => `${entry.repo}${entry.ref ? '@' + entry.ref : ''}`), ['ok/repo', 'ok/repo@dev']),
        JSON.stringify(filtered.sources.slice(7).map((entry) => entry.repo)));

      const blocker = path.join(w.base, 'not-a-dir');
      fs.writeFileSync(blocker, 'x');
      const broken = marketmod.createSkillsMarket({ dataDir: blocker, manager: primary.manager, core: { maxSkillBytes: 256 * 1024 }, fetcher: { fetchBytes: wire.fetchBytes }, now: () => T0 });
      check('C30. 目录源写不进去 → 500 write-failed，不抛', verdict(await broken.addSource({ repo: 'some/repo' })) === '500:write-failed');
    }

    /* ============================================================ */
    section('D. 预览（先看全文，再安装）');
    {
      const { make, wire, clock } = setup('market-preview');
      const market = make();
      await market.refresh({ sourceId: ANTHROPIC });
      const pdfEntry = market.state().entries.find((entry) => entry.dir === 'skills/pdf');
      const pdfUrl = cdnUrl('skills/pdf/SKILL.md');
      const first = await market.preview({ entryId: pdfEntry.id });
      check('D1. 预览：全文、文件清单、总大小、来源（固定提交）', first.ok === true && first.content === PDF_MD
        && same(first.files, [{ path: 'SKILL.md', size: Buffer.byteLength(PDF_MD), status: 'ok', note: '' }, { path: 'scripts/fill.py', size: Buffer.byteLength(FILL), status: 'ok', note: '' }])
        && first.totalBytes === Buffer.byteLength(PDF_MD) + Buffer.byteLength(FILL) && first.partial === false && first.installable === true
        && first.name === 'pdf' && first.suggestedName === 'pdf' && first.description === 'Read and write PDF files.'
        && first.source.repo === REPO && first.source.dir === 'skills/pdf' && first.source.ref === COMMIT && first.source.mode === 'pinned'
        && /^[0-9a-f]{24}$/.test(first.previewId) && first.skipped === 0
        && first.problems.filter((entry) => entry.level === 'error').length === 0, JSON.stringify(first).slice(0, 400));
      check('D2. 预览文件：按要求取全文，未知文件 → 404', (await market.previewFile({ previewId: first.previewId, path: 'scripts/fill.py' })).text === FILL
        && (await market.previewFile({ previewId: first.previewId, path: 'SKILL.md' })).text === PDF_MD
        && verdict(await market.previewFile({ previewId: first.previewId, path: '../secret' })) === '404:not-found');
      check('D3. 文件本身取到之后，预览不再联网', wire.calls.at(-1).url.startsWith('https://cdn.jsdelivr.net/') ? true : false);

      await new Promise((resolve) => setImmediate(resolve));
      const cachedDescription = make().state().entries.find((entry) => entry.dir === 'skills/pdf');
      check('D4. 预览时读到 description → 记进缓存，列表下次直接显示', cachedDescription.description === 'Read and write PDF files.');

      const pairedEntry = market.state().entries.find((entry) => entry.dir === 'skills/paired');
      const paired = await market.preview({ entryId: pairedEntry.id });
      const binary = await market.previewFile({ previewId: paired.previewId, path: 'asset.bin' });
      check('D5. 二进制文件不给文本预览（标成 binary）', binary.ok === true && binary.binary === true && binary.text === '' && binary.size === ASSET.length);
      check('D6. 取不到 SKILL.md → 200 + http-404，说明读不到', (await (async () => {
        wire.controls.missing.add(cdnUrl('skills/docx/SKILL.md'));
        wire.controls.missing.add(rawUrl('skills/docx/SKILL.md'));
        const docxEntry = market.state().entries.find((entry) => entry.dir === 'skills/docx');
        const result = await market.preview({ entryId: docxEntry.id });
        wire.controls.missing.clear();
        return verdict(result) === '200:http-404' && /读不到这个技能的 SKILL.md/.test(result.error);
      })()));

      const blockedEntry = market.state().entries.find((entry) => entry.dir === 'skills/blocked');
      const blocked = await market.preview({ entryId: blockedEntry.id });
      check('D7. 有文件超限的条目还能预览 SKILL.md，但标明不可安装', blocked.ok === true && blocked.installable === false
        && blocked.reason === '它有文件超过 2 MB' && blocked.content === BLOCKED_MD && blocked.files.length === 1, JSON.stringify(blocked).slice(0, 240));
      const bigEntry = market.state().entries.find((entry) => entry.dir === 'skills/bigmd');
      const tooBig = await market.preview({ entryId: bigEntry.id });
      check('D8. SKILL.md 太大的条目连预览都不行', verdict(tooBig) === '409:not-installable' && /SKILL.md 太大/.test(tooBig.error), tooBig.error);

      // 缺一个附属文件：预览照样给出全文，但如实标 partial
      wire.controls.missing.add(cdnUrl('skills/paired/asset.bin'));
      wire.controls.missing.add(rawUrl('skills/paired/asset.bin'));
      const partial = await market.preview({ entryId: pairedEntry.id });
      wire.controls.missing.clear();
      const assetReport = (partial.files || []).find((file) => file.path === 'asset.bin') || {};
      check('D9. 附属文件取不到 → partial=true，报告里说明哪个失败', partial.ok === true && partial.partial === true && assetReport.status === 'failed'
        && /HTTP 404/.test(assetReport.note) && partial.content === PAIRED_MD, JSON.stringify(partial.files));

      // 内容与登记不符：两种线路的提示不一样
      wire.controls.wrong.set(cdnUrl('skills/paired/asset.bin'), Buffer.from('tampered'));
      wire.controls.wrong.set(rawUrl('skills/paired/asset.bin'), Buffer.from('tampered'));
      const tampered = await market.preview({ entryId: pairedEntry.id });
      const tamperedReport = (tampered.files || []).find((file) => file.path === 'asset.bin') || {};
      check('D10. 内容与目录登记的不一致 → 该文件失败，不会被当成好的装进去', tampered.ok === true && tampered.partial === true
        && tamperedReport.status === 'failed' && tamperedReport.note === '内容与目录登记的不一致', JSON.stringify(tamperedReport));
      wire.controls.route.set(cdnUrl('skills/paired/asset.bin'), 'proxied');
      wire.controls.route.set(rawUrl('skills/paired/asset.bin'), 'proxied');
      const proxiedTamper = await market.preview({ entryId: pairedEntry.id });
      const proxiedReport = (proxiedTamper.files || []).find((file) => file.path === 'asset.bin') || {};
      check('D11. 经代理读取时二进制无法原样回来：提示说清楚是这个原因', proxiedReport.note === '经系统代理读取时，非文本文件无法保持原样');
      wire.controls.wrong.clear();
      wire.controls.route.clear();

      // CDN 取不到时去 GitHub raw 拿
      wire.controls.missing.add(cdnUrl('skills/pdf/SKILL.md'));
      const raw = await market.preview({ entryId: pdfEntry.id });
      wire.controls.missing.clear();
      const rawCalls = wire.calls.slice(-3).map((call) => call.url);
      check('D12. CDN 取不到 → 备用 raw；其余文件也先试 raw', raw.ok === true && raw.content === PDF_MD
        && same(rawCalls, [cdnUrl('skills/pdf/SKILL.md'), rawUrl('skills/pdf/SKILL.md'), rawUrl('skills/pdf/scripts/fill.py')]), rawCalls.join(' '));

      check('D13. 条目 ID 不合法 → 400；格式对但不存在 → 404', verdict(await market.preview({ entryId: 'x' })) === '400:bad-request'
        && verdict(await market.preview({ entryId: 'f'.repeat(32) })) === '404:entry-gone');
      void clock;
    }
    {
      // 预置条目还没有文件清单：预览会先把目录读回来（这是用户动作，允许联网）
      const { make, wire } = setup('market-auto');
      const market = make();
      const preload = market.state().entries.find((entry) => entry.dir === 'skills/docx');
      const previewed = await market.preview({ entryId: preload.id });
      check('D14. 打开预置条目的预览时自动加载目录（用户动作触发，一次）', previewed.ok === true && previewed.content === DOCX_MD
        && wire.calls.filter((call) => call.url === COMMITS_URL).length === 1);
      const failedWorld = setup('market-auto-fail');
      const failing = failedWorld.make();
      failedWorld.wire.controls.fail.set(COMMITS_URL, { ok: false, code: 'http-403', status: 403, error: 'api.github.com 返回 HTTP 403' });
      const failed = await failing.preview({ entryId: failing.state().entries.find((entry) => entry.dir === 'skills/docx').id });
      check('D15. 自动加载失败 → 预览返回同一个失败，不假装有内容', verdict(failed) === '200:http-403' && /限流/.test(failed.error));
    }
    {
      const { make, clock, ctx } = setup('market-ttl');
      const market = make();
      await market.refresh({ sourceId: ANTHROPIC });
      const pdfEntry = market.state().entries.find((entry) => entry.dir === 'skills/pdf');
      const staged = await market.preview({ entryId: pdfEntry.id });
      clock.value += 15 * 60 * 1000;
      check('D16. 预览在 15 分钟内有效（边界整点仍有效）', (await market.previewFile({ previewId: staged.previewId, path: 'SKILL.md' })).ok === true);
      clock.value += 1;
      check('D17. 过了 15 分钟：预览过期，不能读也不能装', verdict(await market.previewFile({ previewId: staged.previewId, path: 'SKILL.md' })) === '410:preview-expired'
        && verdict(await market.install(ctx, { previewId: staged.previewId, target: 'user-pi', name: 'pdf' })) === '410:preview-expired');
    }
    {
      const { make } = setup('market-max');
      const market = make();
      await market.refresh({ sourceId: ANTHROPIC });
      const entryOf = (dir) => market.state().entries.find((entry) => entry.dir === dir).id;
      const previews = [];
      for (const letter of ['a', 'b', 'c', 'd', 'e']) previews.push((await market.preview({ entryId: entryOf(`skills/tiny-${letter}`) })).previewId);
      const pdfPreview = (await market.preview({ entryId: entryOf('skills/pdf') })).previewId;
      await market.preview({ entryId: entryOf('skills/tiny-f') });
      check('D18. 最多同时留 6 个预览：第 7 个进来，最早的那个作废', verdict(await market.previewFile({ previewId: previews[0], path: 'SKILL.md' })) === '410:preview-expired'
        && (await market.previewFile({ previewId: pdfPreview, path: 'SKILL.md' })).ok === true);
    }

    /* ============================================================ */
    section('E. 安装');
    {
      const { w, sk, make, wire, manager, ctx } = setup('market-install');
      const market = make();
      await market.refresh({ sourceId: ANTHROPIC });
      const entryOf = (dir) => market.state().entries.find((entry) => entry.dir === dir).id;
      const staged = await market.preview({ entryId: entryOf('skills/pdf') });
      const before = wire.calls.length;
      const installed = await market.install(ctx, { previewId: staged.previewId, target: 'user-pi', name: 'pdf' });
      const target = path.join(w.agent, 'skills', 'pdf');
      check('E1. 安装：落盘的字节就是预览过的那一份（含附属脚本）', installed.ok === true && installed.name === 'pdf' && installed.target === 'user-pi'
        && installed.targetLabel === '~/.pi/agent/skills' && installed.scope === 'user' && installed.fileCount === 2
        && fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8') === PDF_MD
        && fs.readFileSync(path.join(target, 'scripts', 'fill.py'), 'utf8') === FILL, JSON.stringify(installed));
      check('E2. 安装不再联网；预览用完就作废', wire.calls.length === before
        && verdict(await market.previewFile({ previewId: staged.previewId, path: 'SKILL.md' })) === '410:preview-expired');
      check('E3. 安装结果带上来源与是否完整；可撤销', installed.source.repo === REPO && installed.partial === false && /^[0-9a-f]{24}$/.test(installed.undo));

      const clash = await market.preview({ entryId: entryOf('skills/pdf') });
      const conflicted = await market.install(ctx, { previewId: clash.previewId, target: 'user-pi', name: 'pdf' });
      check('E4. 同名冲突：409，说明可选的处理方式；预览留着', verdict(conflicted) === '409:exists'
        && same(conflicted.conflict, { name: 'pdf', target: 'user-pi', replaceable: true, suggestion: 'pdf-2' })
        && (await market.previewFile({ previewId: clash.previewId, path: 'SKILL.md' })).ok === true);
      const renamed = await market.install(ctx, { previewId: clash.previewId, target: 'user-pi', name: 'pdf', onConflict: 'rename' });
      check('E5. 冲突后选「保留两者」再提交 → pdf-2，frontmatter 的 name 跟着改', renamed.ok === true && renamed.name === 'pdf-2' && renamed.renamed === true
        && fs.readFileSync(path.join(w.agent, 'skills', 'pdf-2', 'SKILL.md'), 'utf8') === PDF_MD.replace('name: pdf', 'name: pdf-2'));

      const replacePreview = await market.preview({ entryId: entryOf('skills/paired') });
      const replaced = await market.install(ctx, { previewId: replacePreview.previewId, target: 'user-pi', name: 'pdf', onConflict: 'replace' });
      const trashIds = H.trashEntries(w, 'del-');
      check('E6. 选「覆盖」→ 旧的进回收站，可以撤销', replaced.ok === true && replaced.replaced === true && trashIds.length === 1
        && H.readTrashMeta(w, trashIds[0]).reason === 'replace'
        && fs.readFileSync(path.join(H.trashPayload(w, trashIds[0]), 'SKILL.md'), 'utf8') === PDF_MD);
      check('E7. 撤销覆盖 → 原来的 pdf 回来', (await manager.undo(replaced.undo)).ok === true
        && fs.readFileSync(path.join(w.agent, 'skills', 'pdf', 'SKILL.md'), 'utf8') === PDF_MD);

      wire.controls.missing.add(cdnUrl('skills/paired/asset.bin'));
      wire.controls.missing.add(rawUrl('skills/paired/asset.bin'));
      const partialPreview = await market.preview({ entryId: entryOf('skills/paired') });
      wire.controls.missing.clear();
      const refused = await market.install(ctx, { previewId: partialPreview.previewId, target: 'user-pi', name: 'partial-skill' });
      check('E8. 预览有文件缺失：默认可安装前必须再确认一次', verdict(refused) === '409:partial'
        && /1 个文件没有取到/.test(refused.error) && same(refused.missing, ['asset.bin']));
      const allowed = await market.install(ctx, { previewId: partialPreview.previewId, target: 'user-pi', name: 'partial-skill', allowPartial: true });
      check('E9. 用户确认后装不完整的版本：只装取到的文件，结果如实标 partial', allowed.ok === true && allowed.partial === true && allowed.fileCount === 1
        && fs.existsSync(path.join(w.agent, 'skills', 'partial-skill', 'SKILL.md'))
        && !fs.existsSync(path.join(w.agent, 'skills', 'partial-skill', 'asset.bin')));
      check('E10. 不存在的预览令牌 → 410', verdict(await market.install(ctx, { previewId: '0'.repeat(24), target: 'user-pi', name: 'x' })) === '410:preview-expired');
      const blockedPreview = await market.preview({ entryId: entryOf('skills/blocked') });
      check('E11. 预览过但不能安装的条目：install 也拒绝', blockedPreview.ok === true
        && verdict(await market.install(ctx, { previewId: blockedPreview.previewId, target: 'user-pi', name: 'blocked' })) === '409:not-installable');
    }

    /* ============================================================ */
    section('F. 路由接线与静态守卫');
    {
      const w = worlds.mkWorld('market-routes');
      const wire = createWire();
      // createSkills 的 marketFetcher 原样传给市场模块，市场要的是 { fetchBytes }
      const sk = S.mkSkills(w, w.proj, { approve: true, marketFetcher: { fetchBytes: wire.fetchBytes } });
      const pid = S.skillId(w.proj);
      const post = (url, body) => H.api(sk, 'POST', url, body);

      const before = wire.calls.length;
      const stateRes = await H.api(sk, 'GET', '/api/skills/market');
      const stateBody = stateRes.jsonBody() || {};
      check('F1. GET /api/skills/market：不联网，返回源、预置条目、分类、主机名单', stateRes.code === 200 && stateBody.ok === true
        && stateBody.sources.length === 7 && stateBody.entries.length === 8 && stateBody.categories.length === 5
        && same(stateBody.hosts, ['api.github.com', 'cdn.jsdelivr.net', 'data.jsdelivr.com', 'raw.githubusercontent.com'])
        && wire.calls.length === before);
      const refreshed = await post('/api/skills/market/refresh', { sourceId: ANTHROPIC });
      check('F2. POST refresh：加载成功；ID 不合法 → 400；不存在 → 404；GET 不允许', refreshed.code === 200 && refreshed.jsonBody().refreshed === true
        && outcome(await post('/api/skills/market/refresh', { sourceId: 'nope' })) === '400:bad-request'
        && outcome(await post('/api/skills/market/refresh', { sourceId: 'f'.repeat(16) })) === '404:source-gone'
        && outcome(await H.api(sk, 'GET', '/api/skills/market/refresh')) === '405:method-not-allowed');
      const added = await post('/api/skills/market/sources', { action: 'add', repo: 'foo/bar' });
      const addedBody = added.jsonBody() || {};
      check('F3. POST sources：添加 / 重复 409 / 未知动作 400 / 默认源 403', added.code === 200 && addedBody.source.repo === 'foo/bar'
        && outcome(await post('/api/skills/market/sources', { action: 'add', repo: 'foo/bar' })) === '409:exists'
        && outcome(await post('/api/skills/market/sources', { action: 'nope' })) === '400:bad-request'
        && outcome(await post('/api/skills/market/sources', { action: 'remove', id: ANTHROPIC })) === '403:builtin'
        && outcome(await post('/api/skills/market/sources', { action: 'remove', id: addedBody.source.id })) === '200:');

      const listed = (await H.api(sk, 'GET', `/api/skills/market`)).jsonBody();
      const docxEntry = listed.entries.find((entry) => entry.dir === 'skills/docx');
      const previewed = await post('/api/skills/market/preview', { entryId: docxEntry.id });
      const previewBody = previewed.jsonBody() || {};
      const fileShown = await H.api(sk, 'GET', `/api/skills/market/preview/${previewBody.previewId}/file?path=SKILL.md`);
      check('F4. 预览与预览文件：令牌合法才读；未知文件 404；坏令牌 400', previewed.code === 200 && previewBody.content === DOCX_MD
        && fileShown.code === 200 && fileShown.jsonBody().text === DOCX_MD
        && outcome(await H.api(sk, 'GET', `/api/skills/market/preview/${previewBody.previewId}/file?path=../x`)) === '404:not-found'
        && outcome(await H.api(sk, 'GET', `/api/skills/market/preview/nothex/file?path=SKILL.md`)) === '400:bad-request'
        && outcome(await post('/api/skills/market/preview', { entryId: 'nope' })) === '400:bad-request');
      const noProject = await post('/api/skills/market/install', { previewId: previewBody.previewId, target: 'user-pi', name: 'docx' });
      const installed = await post(`/api/skills/market/install?project=${pid}`, { previewId: previewBody.previewId, target: 'user-pi', name: 'docx' });
      check('F5. 安装：不带 project → 400；带了 → 成功', outcome(noProject) === '400:project-required'
        && installed.code === 200 && installed.jsonBody().name === 'docx' && fs.existsSync(path.join(w.agent, 'skills', 'docx', 'SKILL.md')));

      const untrusted = worlds.mkWorld('market-untrusted');
      fs.mkdirSync(path.join(untrusted.proj, '.pi', 'skills'), { recursive: true });
      const untrustedWire = createWire();
      const untrustedSk = S.mkSkills(untrusted, untrusted.proj, { marketFetcher: { fetchBytes: untrustedWire.fetchBytes } });
      const untrustedPid = S.skillId(untrusted.proj);
      await H.api(untrustedSk, 'POST', '/api/skills/market/refresh', { sourceId: ANTHROPIC });
      const untrustedList = (await H.api(untrustedSk, 'GET', '/api/skills/market')).jsonBody();
      const untrustedEntry = untrustedList.entries.find((entry) => entry.dir === 'skills/docx');
      const untrustedPreview = (await H.api(untrustedSk, 'POST', '/api/skills/market/preview', { entryId: untrustedEntry.id })).jsonBody();
      const refused = await H.api(untrustedSk, 'POST', `/api/skills/market/install?project=${untrustedPid}`, { previewId: untrustedPreview.previewId, target: 'project-pi', name: 'docx' });
      check('F6. 项目未被信任：安装到项目目录 → 403，项目里什么都没写', outcome(refused) === '403:project-untrusted'
        && same(H.listDir(path.join(untrusted.proj, '.pi', 'skills')), []));
      check('F7. 方法不对 → 405', outcome(await H.api(sk, 'GET', '/api/skills/market/preview')) === '405:method-not-allowed'
        && outcome(await H.api(sk, 'GET', '/api/skills/market/sources')) === '405:method-not-allowed'
        && outcome(await H.api(sk, 'GET', '/api/skills/market/install')) === '405:method-not-allowed'
        && outcome(await post('/api/skills/market', {})) === '405:method-not-allowed');

      const serverDir = path.join(__dirname, '..', 'server');
      const marketSrc = fs.readFileSync(path.join(serverDir, 'skills-market.js'), 'utf8');
      const catalogSrc = fs.readFileSync(path.join(serverDir, 'skills-market-catalog.js'), 'utf8');
      check('F8. 不执行任何远端内容：市场模块里没有 child_process / spawn / exec', ![marketSrc, catalogSrc].some((src) => /child_process|spawnSync|execSync|execFile/.test(src)));
      check('F9. 市场模块自己不直接连网（HTTP 都在网络层），主机名单只有网络层与目录数据定义', !/from 'node:https'/.test(marketSrc) && !/from 'node:https'/.test(catalogSrc));
      check('F10. 安装前必须先预览：install 只认预览令牌，拿不到路径', /previews\.get\(payload\.previewId\)/.test(marketSrc)
        && !/targetPath|absolutePath|sourceDir/.test(marketSrc));
    }
  } catch (err) {
    check('套件运行中没有未捕获的异常', false, err && err.stack ? err.stack : String(err));
  } finally {
    worlds.cleanup();
    finish();
  }
})();
