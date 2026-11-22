/* 技能管理（三）：从本机导入（单个 .md / 整个目录连同附属资源），
 * 以及从其他 Agent 工具（Claude Code、Codex）扫描并导入。
 *
 * 新建 / 信任闸 / 校验在 tests/skills-manage.cjs，编辑 / 删除 / 撤销 / 冲突在
 * tests/skills-manage-edit.cjs，落盘原语在 tests/skills-files.cjs。
 *
 * 纪律同前：全部在 os.tmpdir() 里造世界，不 spawn、不联网；「别的工具的目录」也是世界里的
 * 假 home 下的 fixture（<世界>/home/.claude、.codex），绝不碰这台机器上真实的那些目录。
 *
 * 这里反复证明两件事：
 *   1. 传上来 / 扫出来的东西先过完整校验，逃出技能目录的路径整包拒绝，落盘的字节就是清单里的那一份；
 *   2. 扫描与导入对来源目录只读 —— 前后两次目录指纹（含修改时间）逐字相同。
 *
 * 跑法：node tests/skills-import.cjs */
const fs = require('node:fs');
const path = require('node:path');
const H = require('./fixtures/skills-harness.cjs');

const { check, skip, section, finish } = H.createChecker();
const worlds = H.createWorlds('pi-gui-skills-import-');

const HEX24 = /^[0-9a-f]{24}$/;
const MB = 1024 * 1024;
/** HTTP 结果的「状态码:业务码」。 */
const outcome = (res) => `${res.code}:${(res.jsonBody() || {}).code || ''}`;
/** 模块直接返回的结果：成功是 ok，失败是「状态码:业务码」。 */
const verdict = (result) => (result && result.ok ? 'ok' : `${result && result.status}:${result && result.code}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const md = (name, description = `about ${name}`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
/** 浏览器传上来的形状：[{ path, data(base64) }]。 */
const upload = (files) => Object.entries(files).map(([rel, content]) => ({ path: rel, data: H.b64(content) }));
/** 不带修改时间的目录指纹：比较「内容是不是同一份」。 */
const tree = (dir) => H.snapshotTree(dir, { withMtime: false });
const leftovers = (dir) => H.listDir(dir).filter((name) => name.startsWith('.pi-gui-') || name.endsWith('.tmp'));
const errorOf = (res) => (res.jsonBody() || {}).error || '';

(async () => {
  const S = await H.loadSkillsServer();
  const { createSkillsImport, IMPORT_BODY_LIMIT } = await import('../server/skills-import.js');

  try {
    /* ============================================================ */
    section('A. 导入单个 .md 文件');
    {
      const w = worlds.mkWorld('file');
      const userRoot = path.join(w.agent, 'skills');
      const sk = S.mkSkills(w, w.proj, { approve: true });
      const pid = S.skillId(w.proj);
      const stage = (body) => H.api(sk, 'POST', '/api/skills/import/stage', body);
      const commit = (body, query = `?project=${pid}`) => H.api(sk, 'POST', `/api/skills/import/commit${query}`, body);
      const planOf = (res) => (res.jsonBody() || {}).plan || {};
      const TEXT = md('pdf-tools', 'Work with PDF files');

      const staged = await stage({ kind: 'file', files: upload({ 'SKILL.md': TEXT }) });
      const stageId = (staged.jsonBody() || {}).stageId;
      const plan = planOf(staged);
      check('A1. 暂存成功，返回令牌与清单', staged.code === 200 && staged.jsonBody().ok === true && HEX24.test(stageId), staged.body().slice(0, 300));
      check('A2. 清单说明将导入什么：名字取自 frontmatter，一个文件，没有问题', plan.kind === 'file' && plan.suggestedName === 'pdf-tools' && plan.declaredName === 'pdf-tools'
        && plan.description === 'Work with PDF files' && plan.fileCount === 1 && plan.totalBytes === Buffer.byteLength(TEXT)
        && same(plan.files, [{ path: 'SKILL.md', size: Buffer.byteLength(TEXT) }]) && plan.skipped.length === 0 && plan.problems.length === 0, JSON.stringify(plan));
      check('A3. 暂存不落盘：技能目录与数据目录里什么都没有', H.listDir(userRoot).length === 0 && H.listDir(w.data).length === 0, `${H.listDir(userRoot)} / ${H.listDir(w.data)}`);

      const noProject = await commit({ stageId, target: 'user-pi', name: 'pdf-tools' }, '');
      check('A4. 提交不带 project → 400 project-required，什么都没写', outcome(noProject) === '400:project-required' && H.listDir(userRoot).length === 0, noProject.body());
      const badName = [];
      for (const name of ['Bad Name', 'con', '', undefined, 'a--b', '-lead']) badName.push(outcome(await commit({ stageId, target: 'user-pi', name })));
      check('A5. 名字不合规（空格、Windows 保留名、空、连续连字符…）→ 400 bad-name', badName.every((entry) => entry === '400:bad-name'), badName.join(','));
      const badTarget = [];
      for (const target of ['nope', '', undefined, '__proto__', userRoot]) badTarget.push(outcome(await commit({ stageId, target, name: 'pdf-tools' })));
      check('A6. 保存位置只认枚举值，传路径也不行 → 400 bad-target', badTarget.every((entry) => entry === '400:bad-target'), badTarget.join(','));
      check('A7. 提交时冲突策略不合法 → 400', outcome(await commit({ stageId, target: 'user-pi', name: 'pdf-tools', onConflict: 'merge' })) === '400:bad-request');
      check('A8. 这些失败都没写盘', H.listDir(userRoot).length === 0 && H.trashEntries(w).length === 0);

      const done = await commit({ stageId, target: 'user-pi', name: 'pdf-tools' });
      const result = done.jsonBody() || {};
      const dest = path.join(userRoot, 'pdf-tools');
      check('A9. 失败之后暂存还在：改对了再提交 → 成功', done.code === 200 && result.ok === true && result.name === 'pdf-tools' && result.renamed === false && result.replaced === false
        && result.target === 'user-pi' && result.targetLabel === '~/.pi/agent/skills' && result.scope === 'user' && result.fileCount === 1 && result.path === dest && HEX24.test(result.undo), done.body());
      check('A10. 落盘的字节就是传上来的那一份，没有残留临时文件', fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8') === TEXT && H.listDir(dest).join(',') === 'SKILL.md' && leftovers(userRoot).length === 0);
      check('A11. pi 没在运行 → 不需要重启', result.restartRequired === false);
      const listed = H.findSkill(await H.getList(sk, pid), 'pdf-tools', 'user');
      check('A12. 列表里出现了它，可以编辑、删除', Boolean(listed) && listed.id === result.id && listed.manage.editable === true && listed.manage.deletable === true, JSON.stringify(listed && listed.manage));
      check('A13. 暂存用掉了：同一个令牌再提交 → 410 stage-expired', outcome(await commit({ stageId, target: 'user-pi', name: 'pdf-tools-again' })) === '410:stage-expired' && H.listDir(userRoot).join(',') === 'pdf-tools');
      const undone = await H.api(sk, 'POST', `/api/skills/undo/${result.undo}`);
      const undoMeta = H.readTrashMeta(w, H.trashEntries(w, 'del-')[0]);
      check('A14. 撤销导入：技能挪进回收站（不是真删）', undone.code === 200 && undone.jsonBody().kind === 'install' && !fs.existsSync(dest) && H.trashEntries(w, 'del-').length === 1
        && undoMeta.reason === 'undo-install' && fs.readFileSync(path.join(H.trashPayload(w, H.trashEntries(w, 'del-')[0]), 'SKILL.md'), 'utf8') === TEXT, undone.body());

      // 名字从哪来
      const noName = '---\ndescription: Notes about something\n---\n\nbody\n';
      const fromStem = planOf(await stage({ kind: 'file', files: upload({ 'my-notes.md': noName }) }));
      check('A15. frontmatter 没写 name → 用文件名当建议名', fromStem.suggestedName === 'my-notes' && fromStem.declaredName === '' && same(fromStem.files.map((file) => file.path), ['SKILL.md']), JSON.stringify(fromStem));
      const fromFakePath = planOf(await stage({ kind: 'file', files: [{ path: 'C:\\fakepath\\My Cool Notes.MD', data: H.b64(noName) }] }));
      check('A16. 浏览器给的路径只取文件名；空格、大写收成合规的名字', fromFakePath.suggestedName === 'my-cool-notes', JSON.stringify(fromFakePath));
      const anonymous = planOf(await stage({ kind: 'file', files: upload({ 'skill.md': noName }) }));
      check('A17. 文件就叫 skill.md 又没写 name → 没有建议名，由用户填', anonymous.suggestedName === '' && anonymous.fileCount === 1, JSON.stringify(anonymous));
      const cjk = planOf(await stage({ kind: 'file', files: upload({ '读书笔记.md': noName }) }));
      check('A18. 文件名收不成合规名字（全是中文）→ 同样留空', cjk.suggestedName === '', JSON.stringify(cjk));

      // 拒绝
      check('A19. 不是 .md → 400 not-markdown', outcome(await stage({ kind: 'file', files: upload({ 'notes.txt': TEXT }) })) === '400:not-markdown');
      check('A20. 一次传了两个文件 → 400', outcome(await stage({ kind: 'file', files: upload({ 'a.md': TEXT, 'b.md': TEXT }) })) === '400:bad-request');
      check('A21. 不是 UTF-8 → 400 not-utf8', outcome(await stage({ kind: 'file', files: upload({ 'SKILL.md': Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0xfd]) }) })) === '400:not-utf8');
      check('A22. 带空字符 → 400 binary', outcome(await stage({ kind: 'file', files: upload({ 'SKILL.md': Buffer.from('---\ndescription: x\n---\n\x00') }) })) === '400:binary');
      const tooBig = await stage({ kind: 'file', files: upload({ 'SKILL.md': `${md('big')}${'x'.repeat(256 * 1024)}` }) });
      check('A23. SKILL.md 超过 256 KB → 413 skill-md-too-large', outcome(tooBig) === '413:skill-md-too-large' && errorOf(tooBig) === 'SKILL.md 超过 256 KB', tooBig.body());
      const exact = `${md('edge')}${'x'.repeat(256 * 1024 - Buffer.byteLength(md('edge')))}`;
      check('A24. 正好 256 KB → 可以', (await stage({ kind: 'file', files: upload({ 'SKILL.md': exact }) })).code === 200);

      // pi 不会加载的文件：照样能导入，但清单里说清楚
      const plain = await stage({ kind: 'file', files: upload({ 'plain.md': '# just markdown\n\nno frontmatter here\n' }) });
      const plainPlan = planOf(plain);
      check('A25. 没有 frontmatter → 暂存成功，但清单里有一条 error 说明 pi 不会加载', plain.code === 200 && plainPlan.suggestedName === 'plain'
        && plainPlan.problems.length === 1 && plainPlan.problems[0].level === 'error' && /frontmatter/.test(plainPlan.problems[0].message), JSON.stringify(plainPlan.problems));
      const plainDone = await commit({ stageId: plain.jsonBody().stageId, target: 'user-agents', name: 'plain' });
      const plainRow = H.findSkill(await H.getList(sk, pid), 'plain', 'user');
      check('A26. 用户坚持导入 → 装进 ~/.agents/skills，列表如实标成「无法加载」', plainDone.code === 200 && plainDone.jsonBody().target === 'user-agents'
        && fs.existsSync(path.join(w.home, '.agents', 'skills', 'plain', 'SKILL.md')) && Boolean(plainRow) && plainRow.state === 'invalid', `${plainDone.body()} / ${plainRow && plainRow.state}`);

      // 请求形状
      const shapes = [];
      for (const body of [{ kind: 'zip', files: upload({ 'SKILL.md': TEXT }) }, { files: upload({ 'SKILL.md': TEXT }) }]) shapes.push(outcome(await stage(body)));
      check('A27. kind 只能是 file / dir', shapes.every((entry) => entry === '400:bad-request'), shapes.join(','));
      const empties = [];
      for (const files of [undefined, null, [], 'SKILL.md', {}]) empties.push(outcome(await stage({ kind: 'file', files })));
      check('A28. 没有文件 → 400 empty', empties.every((entry) => entry === '400:empty'), empties.join(','));
      const malformed = [];
      for (const entry of [null, 'x', { path: 'SKILL.md' }, { data: H.b64(TEXT) }, { path: 5, data: H.b64(TEXT) }, { path: 'SKILL.md', data: 7 }]) malformed.push(outcome(await stage({ kind: 'file', files: [entry] })));
      check('A29. 条目不是 { path, data } → 400 bad-data', malformed.every((entry) => entry === '400:bad-data'), malformed.join(','));
      const badBase64 = [];
      for (const data of ['@@@@', 'abc', 'ab=c', 'abcd====', 'YWJj\n']) badBase64.push(outcome(await stage({ kind: 'file', files: [{ path: 'SKILL.md', data }] })));
      check('A30. data 不是合法 base64 → 400 bad-data', badBase64.every((entry) => entry === '400:bad-data'), badBase64.join(','));
      check('A31. 请求体不是 JSON / 不是对象 → 400', outcome(await H.call(sk, 'POST', '/api/skills/import/stage', { body: 'not json' })) === '400:bad-request'
        && outcome(await H.call(sk, 'POST', '/api/skills/import/stage', { body: '[1,2]' })) === '400:bad-request');
      check('A32. 暂存只接受 POST', outcome(await H.api(sk, 'GET', '/api/skills/import/stage')) === '405:method-not-allowed' && outcome(await H.api(sk, 'GET', '/api/skills/import/commit')) === '405:method-not-allowed');
    }

    /* ============================================================ */
    section('B. 导入整个目录（连同附属资源）');
    {
      const w = worlds.mkWorld('dir');
      const sk = S.mkSkills(w, w.proj, { approve: true });
      const pid = S.skillId(w.proj);
      const stage = (body) => H.api(sk, 'POST', '/api/skills/import/stage', body);
      const stageDir = (files, dirName = 'picked') => stage({ kind: 'dir', dirName, files: upload(files) });
      const commit = (body) => H.api(sk, 'POST', `/api/skills/import/commit?project=${pid}`, body);
      const planOf = (res) => (res.jsonBody() || {}).plan || {};
      const LOGO = Buffer.from([0, 1, 2, 3, 0x89, 0x50, 0x4e, 0x47, 254, 255]);
      const FILES = {
        'scripts/run.py': 'print("hi")\n',
        'SKILL.md': md('dir-skill', 'A skill with resources'),
        'assets/logo.bin': LOGO,
        'references/guide.md': '# Guide\r\n\r\nCRLF stays CRLF\r\n',
        '.git/config': '[core]\n',
        '.DS_Store': Buffer.from([0, 0, 0, 1]),
        'node_modules/dep/index.js': 'module.exports = 1;\n',
        'scripts/.env': 'SECRET=1\n',
      };
      const kept = ['SKILL.md', 'assets/logo.bin', 'references/guide.md', 'scripts/run.py'];
      const keptBytes = kept.reduce((sum, rel) => sum + Buffer.byteLength(FILES[rel]), 0);

      const staged = await stageDir(FILES, 'My Skill Dir');
      const plan = planOf(staged);
      check('B1. 暂存成功：SKILL.md 排第一，其余按路径排序', staged.code === 200 && plan.kind === 'dir' && same(plan.files.map((file) => file.path), kept) && plan.fileCount === 4 && plan.totalBytes === keptBytes, JSON.stringify(plan.files));
      check('B2. 名字优先取 frontmatter 里的；描述带出来', plan.suggestedName === 'dir-skill' && plan.declaredName === 'dir-skill' && plan.description === 'A skill with resources' && plan.problems.length === 0);
      check('B3. 隐藏文件、node_modules 被跳过，并逐条说明', same(plan.skipped.map((entry) => `${entry.path}|${entry.reason}|${entry.note}`), [
        '.git/config|hidden|隐藏文件', '.DS_Store|hidden|隐藏文件', 'node_modules/dep/index.js|node_modules|node_modules 目录', 'scripts/.env|hidden|隐藏文件',
      ]), JSON.stringify(plan.skipped));

      const done = await commit({ stageId: staged.jsonBody().stageId, target: 'project-pi', name: 'dir-skill' });
      const result = done.jsonBody() || {};
      const dest = path.join(w.proj, '.pi', 'skills', 'dir-skill');
      check('B4. 装进项目的 .pi/skills', done.code === 200 && result.scope === 'project' && result.target === 'project-pi' && result.targetLabel === '<项目>/.pi/skills' && result.fileCount === 4 && result.path === dest, done.body());
      check('B5. 附属资源逐字节相同（二进制、CRLF 都原样），不只是 Markdown', kept.every((rel) => fs.readFileSync(path.join(dest, ...rel.split('/'))).equals(Buffer.from(FILES[rel])))
        && H.listDir(dest).join(',') === 'SKILL.md,assets,references,scripts' && H.listDir(path.join(dest, 'scripts')).join(',') === 'run.py');
      check('B6. 被跳过的那些没有落盘，也没有残留临时目录', !fs.existsSync(path.join(dest, '.git')) && !fs.existsSync(path.join(dest, 'node_modules')) && leftovers(path.join(w.proj, '.pi', 'skills')).length === 0);
      const row = H.findSkill(await H.getList(sk, pid), 'dir-skill', 'project');
      check('B7. 列表里是项目级技能', Boolean(row) && row.manage.target === 'project-pi' && row.manage.editable === true);

      const viaHint = planOf(await stageDir({ 'SKILL.md': '---\ndescription: no name here\n---\n', 'a.txt': 'a' }, 'My Skill Dir'));
      check('B8. frontmatter 没写 name → 用所选目录的名字', viaHint.suggestedName === 'my-skill-dir' && viaHint.declaredName === '', JSON.stringify(viaHint));
      const toAgents = await commit({ stageId: (await stageDir({ 'SKILL.md': md('in-agents'), 'x/y.txt': 'y' })).jsonBody().stageId, target: 'project-agents', name: 'in-agents' });
      check('B9. 也可以装进项目的 .agents/skills', toAgents.code === 200 && fs.readFileSync(path.join(w.proj, '.agents', 'skills', 'in-agents', 'x', 'y.txt'), 'utf8') === 'y', toAgents.body());

      // 不是技能目录
      const noSkill = await stageDir({ 'README.md': '# hi', 'scripts/a.py': 'x' });
      check('B10. 顶层没有 SKILL.md → 400 no-skill-md', outcome(noSkill) === '400:no-skill-md' && errorOf(noSkill) === '顶层没有 SKILL.md，这不是一个技能目录', noSkill.body());
      const lower = await stageDir({ 'skill.md': md('lower'), 'a.txt': 'a' });
      check('B11. 文件名是小写的 skill.md → 明说要大写', outcome(lower) === '400:no-skill-md' && errorOf(lower) === '文件名必须是大写的 SKILL.md（找到的是 skill.md）', lower.body());
      check('B12. SKILL.md 只在子目录里（多传了一层）→ 400 no-skill-md', outcome(await stageDir({ 'picked/SKILL.md': md('nested'), 'picked/a.txt': 'a' })) === '400:no-skill-md');

      // 逃出技能目录的路径：整包拒绝
      const escapes = ['../evil.txt', 'a/../../evil.txt', '..', './a.txt', 'a//b.txt', '/etc/passwd', 'C:/Windows/evil.txt', 'c:evil.txt', 'a\\b.txt', '..\\evil.txt', 'a\nb.txt', 'a\x00b.txt', ''];
      const escaped = [];
      for (const bad of escapes) {
        const res = await stage({ kind: 'dir', dirName: 'picked', files: [{ path: 'SKILL.md', data: H.b64(md('escape')) }, { path: bad, data: H.b64('x') }] });
        escaped.push(`${outcome(res)}${errorOf(res).startsWith('文件路径不安全，已拒绝整个导入：') && !res.jsonBody().stageId ? '' : '!'}`);
      }
      check(`B13. ${escapes.length} 种越界写法（..、绝对路径、盘符、反斜杠、控制字符、空路径）→ 400 unsafe-path，整包拒绝、不发令牌`, escaped.every((entry) => entry === '400:unsafe-path'), escaped.join(','));
      const controlShown = errorOf(await stage({ kind: 'dir', files: [{ path: 'SKILL.md', data: H.b64(md('x')) }, { path: 'a\nb\x1b[31m.txt', data: H.b64('x') }] }));
      check('B14. 报错里回显的路径去掉了控制字符', controlShown === '文件路径不安全，已拒绝整个导入：a?b?[31m.txt', JSON.stringify(controlShown));

      // 只是不适合带进来的：跳过并报告
      const longSegment = `${'s'.repeat(121)}.txt`;
      const longPath = `${Array.from({ length: 5 }, () => 'd'.repeat(50)).join('/')}/f.txt`;
      const oddities = planOf(await stageDir({
        'SKILL.md': md('odd'),
        'bad:name.txt': 'x',
        'trailing-dot.': 'x',
        'trailing-space ': 'x',
        'aux.txt': 'x',
        'sub/CON': 'x',
        'a/b/c/d/e/f/g/h.txt': 'depth 8 is fine',
        'a/b/c/d/e/f/g/h/i.txt': 'depth 9 is not',
        [longSegment]: 'x',
        [longPath]: 'x',
      }));
      check('B15. Windows 上不合法的名字、太深、太长 → 跳过并说明原因，其余照常', same(oddities.files.map((file) => file.path), ['SKILL.md', 'a/b/c/d/e/f/g/h.txt'])
        && same(oddities.skipped.map((entry) => entry.reason), ['unsafe-name', 'unsafe-name', 'unsafe-name', 'unsafe-name', 'unsafe-name', 'too-deep', 'too-long', 'too-long']), JSON.stringify(oddities.skipped));

      // 同名
      const caseDup = await stageDir({ 'SKILL.md': md('dup'), 'Readme.txt': 'a', 'README.TXT': 'b' });
      check('B16. 两个只差大小写的文件 → 400 duplicate-path', outcome(caseDup) === '400:duplicate-path' && /只差大小写/.test(errorOf(caseDup)), caseDup.body());
      const fileAndDir = await stageDir({ 'SKILL.md': md('dup'), data: 'a file', 'data/inner.txt': 'needs a dir' });
      check('B17. 同一个名字既是文件又是目录 → 400 duplicate-path', outcome(fileAndDir) === '400:duplicate-path' && /文件与目录同名/.test(errorOf(fileAndDir)), fileAndDir.body());

      // 上限
      const twoMb = Buffer.alloc(2 * MB, 0x61);
      check('B18. 单个文件正好 2 MB → 可以', (await stageDir({ 'SKILL.md': md('limit'), 'big.bin': twoMb })).code === 200);
      const overFile = await stageDir({ 'SKILL.md': md('limit'), 'big.bin': Buffer.concat([twoMb, Buffer.from('b')]) });
      check('B19. 多一个字节 → 413 file-too-large', outcome(overFile) === '413:file-too-large' && errorOf(overFile) === 'big.bin 超过单个文件 2 MB 的上限', overFile.body());
      const many = (count) => Object.fromEntries([['SKILL.md', md('many')], ...Array.from({ length: count - 1 }, (_, index) => [`f/${String(index).padStart(3, '0')}.txt`, 'x'])]);
      check('B20. 正好 200 个文件 → 可以', planOf(await stageDir(many(200))).fileCount === 200);
      const overCount = await stageDir(many(201));
      check('B21. 201 个 → 413 too-many-files', outcome(overCount) === '413:too-many-files' && errorOf(overCount) === '文件太多（上限 200 个）', overCount.body());
      const chunk = Buffer.alloc(1940000, 0x62);
      const overTotal = await stageDir(Object.fromEntries([['SKILL.md', md('total')], ...Array.from({ length: 7 }, (_, index) => [`part-${index}.bin`, chunk])]));
      check('B22. 总大小超过 12 MB → 413 too-large', outcome(overTotal) === '413:too-large' && errorOf(overTotal) === '技能超过 12 MB 的总大小上限', overTotal.body().slice(0, 200));
      const overBody = await H.call(sk, 'POST', '/api/skills/import/stage', { body: 'x'.repeat(IMPORT_BODY_LIMIT + 1) });
      check('B23. 请求体超过上限 → 413，不解析', outcome(overBody) === '413:too-large' && errorOf(overBody) === '请求体太大', overBody.body());
      const flood = await stage({ kind: 'dir', files: Array.from({ length: 5001 }, (_, index) => ({ path: `.hidden/${index}`, data: '' })) });
      check('B24. 条目数超过 5000（哪怕全是会被跳过的）→ 413 too-many-files', outcome(flood) === '413:too-many-files', flood.body());
      check('B25. 被拒绝的这些都没有落盘', same(H.listDir(path.join(w.proj, '.pi', 'skills')), ['dir-skill']) && same(H.listDir(path.join(w.proj, '.agents', 'skills')), ['in-agents']) && H.listDir(path.join(w.agent, 'skills')).length === 0);
    }

    /* ============================================================ */
    section('C. 导入时的同名冲突');
    {
      const w = worlds.mkWorld('conflict');
      const userRoot = path.join(w.agent, 'skills');
      H.writeSkill(userRoot, 'dup', { raw: md('dup', 'the original'), files: { 'scripts/old.sh': 'echo old\n', 'notes/keep.bin': Buffer.from([9, 8, 7, 0]) } });
      const existing = path.join(userRoot, 'dup');
      const before = tree(existing);
      const sk = S.mkSkills(w, w.proj, { approve: true });
      const pid = S.skillId(w.proj);
      const NEW = { 'SKILL.md': md('dup', 'the imported one'), 'scripts/new.sh': 'echo new\n' };
      const stageNew = async () => (await H.api(sk, 'POST', '/api/skills/import/stage', { kind: 'dir', dirName: 'dup', files: upload(NEW) })).jsonBody().stageId;
      const commit = (body) => H.api(sk, 'POST', `/api/skills/import/commit?project=${pid}`, body);

      const stageId = await stageNew();
      const clash = await commit({ stageId, target: 'user-pi', name: 'dup' });
      check('C1. 默认不覆盖：409 exists，并给出可选的处理方式', outcome(clash) === '409:exists' && same(clash.jsonBody().conflict, { name: 'dup', target: 'user-pi', replaceable: true, suggestion: 'dup-2' }), clash.body());
      check('C2. 已有的那个一个字节都没动', tree(existing) === before && H.listDir(userRoot).join(',') === 'dup' && H.trashEntries(w).length === 0);

      const both = await commit({ stageId, target: 'user-pi', name: 'dup', onConflict: 'rename' });
      const bothBody = both.jsonBody() || {};
      check('C3. 冲突之后暂存还在：选「保留两者」再提交 → 装成 dup-2', both.code === 200 && bothBody.name === 'dup-2' && bothBody.requestedName === 'dup' && bothBody.renamed === true && bothBody.replaced === false, both.body());
      check('C4. 新的那份 frontmatter 里的 name 跟着改成 dup-2，其余文件原样；旧的没动', fs.readFileSync(path.join(userRoot, 'dup-2', 'SKILL.md'), 'utf8') === md('dup', 'the imported one').replace('name: dup', 'name: dup-2')
        && fs.readFileSync(path.join(userRoot, 'dup-2', 'scripts', 'new.sh'), 'utf8') === 'echo new\n' && tree(existing) === before);

      const replaceId = await stageNew();
      const replaced = await commit({ stageId: replaceId, target: 'user-pi', name: 'dup', onConflict: 'replace' });
      const replacedBody = replaced.jsonBody() || {};
      const trashed = H.trashEntries(w, 'del-');
      check('C5. 选「覆盖」→ 成功，旧的整个进回收站', replaced.code === 200 && replacedBody.replaced === true && replacedBody.renamed === false && trashed.length === 1
        && H.readTrashMeta(w, trashed[0]).reason === 'replace' && tree(H.trashPayload(w, trashed[0])) === before, replaced.body());
      check('C6. 原位置现在是新的那份（旧的附属文件不会混进来）', H.listDir(existing).join(',') === 'SKILL.md,scripts' && H.listDir(path.join(existing, 'scripts')).join(',') === 'new.sh'
        && fs.readFileSync(path.join(existing, 'SKILL.md'), 'utf8') === NEW['SKILL.md']);
      const undone = await H.api(sk, 'POST', `/api/skills/undo/${replacedBody.undo}`);
      check('C7. 撤销 → 旧的逐字节回到原处，新的进回收站', undone.code === 200 && undone.jsonBody().restored === true && tree(existing) === before
        && same(H.trashEntries(w, 'del-').map((id) => H.readTrashMeta(w, id).reason), ['undo-install']), undone.body());

      // 覆盖不了的东西
      const outside = path.join(w.base, 'outside-skill');
      H.writeSkill(path.dirname(outside), 'outside-skill', { raw: md('linked', 'lives elsewhere') });
      H.linkDir(outside, path.join(userRoot, 'linked'));
      const outsideBefore = H.snapshotTree(outside);
      const linkStage = (await H.api(sk, 'POST', '/api/skills/import/stage', { kind: 'file', files: upload({ 'SKILL.md': md('linked', 'wants to replace a link') }) })).jsonBody().stageId;
      const linkClash = await commit({ stageId: linkStage, target: 'user-pi', name: 'linked' });
      const linkReplace = await commit({ stageId: linkStage, target: 'user-pi', name: 'linked', onConflict: 'replace' });
      check('C8. 同名位置上是一个链接 → 冲突里注明不能覆盖；硬要覆盖 → 409 replace-blocked', outcome(linkClash) === '409:exists' && linkClash.jsonBody().conflict.replaceable === false
        && outcome(linkReplace) === '409:replace-blocked', `${linkClash.body()} / ${linkReplace.body()}`);
      check('C9. 链接和它指向的目录都没动，回收站没有多东西', H.snapshotTree(outside) === outsideBefore && fs.lstatSync(path.join(userRoot, 'linked')).isSymbolicLink() && H.trashEntries(w, 'del-').length === 1);
      const linkBoth = await commit({ stageId: linkStage, target: 'user-pi', name: 'linked', onConflict: 'rename' });
      check('C10. 「保留两者」仍然可以：装成 linked-2', linkBoth.code === 200 && linkBoth.jsonBody().name === 'linked-2' && H.snapshotTree(outside) === outsideBefore, linkBoth.body());
    }

    /* ============================================================ */
    section('D. 暂存的寿命与数量（注入时钟）');
    {
      const w = worlds.mkWorld('stage-life');
      const sk = S.mkSkills(w, w.proj, { approve: true });
      const manager = S.createSkillsManager({ core: S.realCore(sk, { approve: true }), dataDir: w.data });
      const ctx = { cwd: w.proj, live: true, explicit: true };
      let clock = 1700000000000;
      const importer = createSkillsImport({ manager, now: () => clock });
      const stageOne = (name) => importer.stage({ kind: 'file', files: upload({ 'SKILL.md': md(name) }) }).stageId;
      const commit = (stageId, name) => importer.commit(ctx, { stageId, target: 'user-pi', name });
      const MINUTE = 60 * 1000;

      const fresh = stageOne('life-a');
      clock += 15 * MINUTE;
      check('D1. 第 15 分钟整：还有效', verdict(await commit(fresh, 'life-a')) === 'ok');
      const stale = stageOne('life-b');
      clock += 15 * MINUTE + 1;
      check('D2. 过了 15 分钟 → 410 stage-expired，没有落盘', verdict(await commit(stale, 'life-b')) === '410:stage-expired' && !fs.existsSync(path.join(w.agent, 'skills', 'life-b')));

      const ids = ['q1', 'q2', 'q3', 'q4', 'q5'].map(stageOne);
      const results = [];
      for (const [index, id] of ids.entries()) results.push(verdict(await commit(id, `q${index + 1}`)));
      check('D3. 最多同时暂存 4 份：第 5 份进来，最早的那份作废', same(results, ['410:stage-expired', 'ok', 'ok', 'ok', 'ok']), results.join(','));
      const junk = [];
      for (const stageId of [undefined, null, 7, '', 'x'.repeat(24), fresh]) junk.push(verdict(await importer.commit(ctx, { stageId, target: 'user-pi', name: 'junk' })));
      check('D4. 令牌不存在 / 不是字符串 / 已经用过 → 一律 410', junk.every((entry) => entry === '410:stage-expired'), junk.join(','));
      check('D5. 载荷缺失也不会抛', verdict(await importer.commit(ctx, undefined)) === '410:stage-expired' && verdict(importer.stage(undefined)) === '400:bad-request');
    }

    /* ============================================================ */
    section('E. 项目未被信任：导入到项目目录同样被拒');
    {
      const w = worlds.mkWorld('untrusted');
      // 项目里已经有 .pi/skills，又没有任何信任决定 → pi 在非交互模式下不信任它
      fs.mkdirSync(path.join(w.proj, '.pi', 'skills'), { recursive: true });
      const sk = S.mkSkills(w, w.proj);
      const pid = S.skillId(w.proj);
      const projectBefore = H.snapshotTree(w.proj);
      const staged = await H.api(sk, 'POST', '/api/skills/import/stage', { kind: 'file', files: upload({ 'SKILL.md': md('guarded') }) });
      const stageId = staged.jsonBody().stageId;
      const commit = (target) => H.api(sk, 'POST', `/api/skills/import/commit?project=${pid}`, { stageId, target, name: 'guarded' });
      const refusedPi = await commit('project-pi');
      const refusedAgents = await commit('project-agents');
      check('E1. 暂存不涉及项目，照常成功', staged.code === 200);
      check('E2. 提交到项目的两个目录 → 403 project-untrusted', outcome(refusedPi) === '403:project-untrusted' && outcome(refusedAgents) === '403:project-untrusted' && /信任/.test(errorOf(refusedPi)), `${refusedPi.body()} / ${refusedAgents.body()}`);
      check('E3. 项目里一个字节都没多', H.snapshotTree(w.proj) === projectBefore);
      const toUser = await commit('user-pi');
      check('E4. 同一份暂存改装到全局目录 → 成功', toUser.code === 200 && fs.existsSync(path.join(w.agent, 'skills', 'guarded', 'SKILL.md')), toUser.body());
    }

    /* ============================================================ */
    section('F. 从其他工具扫描（只读）');
    const scanWorld = worlds.mkWorld('scan');
    const claudeUser = path.join(scanWorld.home, '.claude', 'skills');
    const codexUser = path.join(scanWorld.home, '.codex', 'skills');
    const claudeProject = path.join(scanWorld.proj, '.claude', 'skills');
    const piUser = path.join(scanWorld.agent, 'skills');
    const elsewhere = path.join(scanWorld.base, 'elsewhere');
    {
      const w = scanWorld;
      // Claude Code 的全局技能
      H.writeSkill(claudeUser, 'alpha', { raw: md('alpha', 'First external skill'), files: { 'scripts/a.sh': '#!/bin/sh\necho a\n', 'assets/pic.bin': Buffer.from([0, 255, 1, 254, 0x89]) } });
      H.writeSkill(claudeUser, 'beta', { raw: md('beta', 'Same on both sides') });
      H.writeSkill(claudeUser, 'gamma', { raw: md('gamma', 'Claude version') });
      H.writeSkill(claudeUser, 'No Description', { raw: '---\nname: nodesc\n---\n\nbody\n' });
      H.writeSkill(claudeUser, 'shared-a', { raw: md('shared-a', 'pi links to this one') });
      H.writeSkill(claudeUser, 'big', { raw: `${md('big')}${'x'.repeat(256 * 1024)}` });
      H.writeSkill(claudeUser, 'binary', { raw: '---\ndescription: has a nul\n---\n\x00' });
      H.writeSkill(claudeUser, '中文名', { raw: '---\ndescription: only a CJK directory name\n---\n' });
      H.writeSkill(claudeUser, 'with-link', { raw: md('with-link', 'Has a link inside'), files: { 'docs/readme.md': '# readme\n' } });
      H.writeSkill(claudeUser, 'huge', { raw: md('huge', 'One file is over the limit'), files: { 'blob.bin': Buffer.alloc(2 * MB + 1, 0x63) } });
      H.writeSkill(claudeUser, '.hidden', { raw: md('hidden') });
      H.writeSkill(path.join(claudeUser, 'node_modules'), 'pkg', { raw: md('pkg') });
      fs.mkdirSync(path.join(claudeUser, 'not-a-skill'), { recursive: true });
      fs.writeFileSync(path.join(claudeUser, 'not-a-skill', 'README.md'), '# nothing\n');
      fs.writeFileSync(path.join(claudeUser, 'loose-file.md'), md('loose'));
      fs.mkdirSync(path.join(claudeUser, 'weird', 'SKILL.md'), { recursive: true });
      // 技能目录里的链接：指向别处的一个目录
      fs.mkdirSync(elsewhere, { recursive: true });
      fs.writeFileSync(path.join(elsewhere, 'secret.txt'), 'not part of the skill\n');
      H.linkDir(elsewhere, path.join(claudeUser, 'with-link', 'linked-dir'));
      // Codex 的全局技能；.system 是它自带的
      H.writeSkill(codexUser, 'delta', { raw: md('delta', 'From Codex') });
      H.writeSkill(path.join(codexUser, '.system'), 'builtin', { raw: md('builtin') });
      // 项目里的 Claude Code 技能
      H.writeSkill(claudeProject, 'epsilon', { raw: md('epsilon', 'Project-level Claude skill'), files: { 'ref.md': 'ref\n' } });
      // pi 这边已有的
      H.writeSkill(piUser, 'beta', { raw: md('beta', 'Same on both sides') });
      H.writeSkill(piUser, 'gamma', { raw: md('gamma', 'pi version') });
      H.writeSkill(piUser, 'shared-b', { raw: md('shared-b', 'Claude links to this one') });
      H.linkDir(path.join(claudeUser, 'shared-a'), path.join(piUser, 'shared-a'));
      H.linkDir(path.join(piUser, 'shared-b'), path.join(claudeUser, 'shared-b'));
      const linkedSkillFile = H.tryLinkFile(path.join(claudeUser, 'alpha', 'SKILL.md'), path.join(claudeUser, 'file-link', 'SKILL.md'));

      const sourcesBefore = [H.snapshotTree(path.join(w.home, '.claude')), H.snapshotTree(path.join(w.home, '.codex')), H.snapshotTree(path.join(w.proj, '.claude')), H.snapshotTree(elsewhere)];
      const piBefore = H.snapshotTree(w.agent);
      const sk = S.mkSkills(w, w.proj, { approve: true });
      const pid = S.skillId(w.proj);
      const scanned = await H.api(sk, 'GET', `/api/skills/external?project=${pid}`);
      const body = scanned.jsonBody() || { sources: [], candidates: [] };
      const byDir = (sourceId, dirName) => body.candidates.find((candidate) => candidate.sourceId === sourceId && candidate.dirName === dirName);
      const expectedClaude = ['alpha', 'beta', 'big', 'binary', 'gamma', 'huge', 'No Description', 'shared-a', 'shared-b', 'weird', 'with-link', '中文名', ...(linkedSkillFile ? ['file-link'] : [])];

      check('F1. 三个已确认的来源，各自说明是哪个工具、哪个目录', scanned.code === 200 && body.ok === true && same(body.sources.map((source) => `${source.id}|${source.tool}|${source.label}|${source.exists}|${source.error}`), [
        'claude-user|Claude Code|~/.claude/skills|true|', 'codex-user|Codex|~/.codex/skills|true|', 'claude-project|Claude Code|<项目>/.claude/skills|true|',
      ]) && same(body.sources.map((source) => source.dir), [claudeUser, codexUser, claudeProject]), JSON.stringify(body.sources));
      check('F2. 只认「含 SKILL.md 的子目录」：隐藏目录、node_modules、散落的 .md、没有 SKILL.md 的目录都不算', same(body.candidates.filter((candidate) => candidate.sourceId === 'claude-user').map((candidate) => candidate.dirName).sort(), expectedClaude.slice().sort())
        && body.sources[0].count === expectedClaude.length && body.sources[0].truncated === false, body.candidates.map((candidate) => candidate.dirName).join(','));
      const alpha = byDir('claude-user', 'alpha') || {};
      check('F3. 候选项：名字、描述、来源、建议名、大小', alpha.name === 'alpha' && alpha.description === 'First external skill' && alpha.tool === 'Claude Code' && alpha.sourceLabel === '~/.claude/skills'
        && alpha.suggestedName === 'alpha' && alpha.bytes === Buffer.byteLength(md('alpha', 'First external skill')) && alpha.dir === path.join(claudeUser, 'alpha') && alpha.id === S.skillId(path.join(claudeUser, 'alpha')), JSON.stringify(alpha));
      check('F4. pi 这边没有 → 可导入，present=none', alpha.importable === true && alpha.present === 'none' && alpha.presentIn === '' && alpha.reason === '' && alpha.problems.length === 0);
      const beta = byDir('claude-user', 'beta') || {};
      const gamma = byDir('claude-user', 'gamma') || {};
      check('F5. 已有同名且 SKILL.md 相同 → present=same，并说明在哪', beta.present === 'same' && beta.presentIn === '~/.pi/agent/skills' && beta.importable === true, JSON.stringify(beta));
      check('F6. 已有同名但内容不同 → present=different', gamma.present === 'different' && gamma.presentIn === '~/.pi/agent/skills' && gamma.importable === true, JSON.stringify(gamma));
      const sharedA = byDir('claude-user', 'shared-a') || {};
      const sharedB = byDir('claude-user', 'shared-b') || {};
      check('F7. pi 的目录里有个链接指向它 → present=linked，不需要导入', sharedA.present === 'linked' && sharedA.importable === false && sharedA.reason === '它已经链接在 pi 的技能目录里，不需要导入' && sharedA.name === 'shared-a', JSON.stringify(sharedA));
      check('F8. 反过来，它本身是指向 pi 技能目录的链接 → 同样是 linked', sharedB.present === 'linked' && sharedB.importable === false && sharedB.description === 'Claude links to this one', JSON.stringify(sharedB));
      const nodesc = byDir('claude-user', 'No Description') || {};
      check('F9. 没有 description → 仍可导入，但带一条 error；目录名收成合规的建议名', nodesc.importable === true && nodesc.name === 'nodesc' && nodesc.suggestedName === 'no-description'
        && same(nodesc.problems, [{ level: 'error', message: '没有 description，导入后 pi 不会加载它' }]), JSON.stringify(nodesc));
      const reasons = ['big', 'binary', '中文名', 'weird'].map((dirName) => { const hit = byDir('claude-user', dirName) || {}; return `${hit.importable}|${hit.reason}`; });
      check('F10. 读不了的不可导入，原因各自说清楚', same(reasons, [
        'false|SKILL.md 超过 256 KB', 'false|SKILL.md 里有空字符，不是文本文件', 'false|它的名字无法转换成合规的技能名（只能用小写字母、数字、连字符）', 'false|它的 SKILL.md 不是普通文件',
      ]), reasons.join(' / '));
      if (linkedSkillFile) {
        const fileLink = byDir('claude-user', 'file-link') || {};
        check('F11. SKILL.md 是符号链接 → 不读、不可导入', fileLink.importable === false && fileLink.reason === '它的 SKILL.md 是一个链接，没有读取' && fileLink.description === '', JSON.stringify(fileLink));
      } else {
        skip('F11. SKILL.md 是符号链接 → 不读、不可导入', '这台机器没有创建文件符号链接的权限（Windows 需要开发者模式或管理员）');
      }
      const delta = byDir('codex-user', 'delta') || {};
      check('F12. Codex 的技能列出来；它自带的 .system 不列', delta.tool === 'Codex' && delta.sourceLabel === '~/.codex/skills' && delta.importable === true
        && same(body.candidates.filter((candidate) => candidate.sourceId === 'codex-user').map((candidate) => candidate.dirName), ['delta']));
      const epsilon = byDir('claude-project', 'epsilon') || {};
      check('F13. 项目里的 Claude Code 技能列出来', epsilon.sourceLabel === '<项目>/.claude/skills' && epsilon.name === 'epsilon' && epsilon.importable === true && body.sources[2].count === 1);
      check('F14. 候选 ID 互不相同，都是 16 位十六进制', new Set(body.candidates.map((candidate) => candidate.id)).size === body.candidates.length && body.candidates.every((candidate) => /^[0-9a-f]{16}$/.test(candidate.id)));
      check('F15. 扫描没有动来源目录：前后指纹（含修改时间）逐字相同', same([H.snapshotTree(path.join(w.home, '.claude')), H.snapshotTree(path.join(w.home, '.codex')), H.snapshotTree(path.join(w.proj, '.claude')), H.snapshotTree(elsewhere)], sourcesBefore));
      check('F16. 扫描也没有往 pi 的目录、数据目录里写任何东西', H.snapshotTree(w.agent) === piBefore && H.listDir(w.data).length === 0);

      const noProject = (await H.api(sk, 'GET', '/api/skills/external?project=none')).jsonBody();
      check('F17. 不选项目 → 只扫两个全局来源', same(noProject.sources.map((source) => source.id), ['claude-user', 'codex-user']) && !noProject.candidates.some((candidate) => candidate.sourceId === 'claude-project'));
      check('F18. 扫描只接受 GET；项目 ID 不合法 → 400', outcome(await H.api(sk, 'POST', `/api/skills/external?project=${pid}`, {})) === '405:method-not-allowed' && outcome(await H.api(sk, 'GET', '/api/skills/external?project=..%2F..')) === '400:bad-project');

      // 目录不存在、CODEX_HOME
      const bare = worlds.mkWorld('scan-bare');
      const bareBody = (await H.api(S.mkSkills(bare, bare.proj), 'GET', '/api/skills/external')).jsonBody();
      check('F19. 这些目录都不存在 → 不报错，如实标成不存在', bareBody.ok === true && bareBody.candidates.length === 0 && bareBody.sources.every((source) => source.exists === false && source.count === 0 && source.error === '')
        && !fs.existsSync(path.join(bare.home, '.claude')) && !fs.existsSync(path.join(bare.home, '.codex')), JSON.stringify(bareBody.sources));
      const codexHome = path.join(bare.base, 'custom-codex');
      H.writeSkill(path.join(codexHome, 'skills'), 'zeta', { raw: md('zeta') });
      H.writeSkill(path.join(bare.home, '.codex', 'skills'), 'ignored-default', { raw: md('ignored-default') });
      const withEnv = (await H.api(S.mkSkills(bare, bare.proj, { env: { ...bare.env, CODEX_HOME: codexHome } }), 'GET', '/api/skills/external')).jsonBody();
      const codexSource = withEnv.sources.find((source) => source.id === 'codex-user');
      check('F20. 设了 CODEX_HOME → 扫它下面的 skills，不再扫默认位置', codexSource.label === '$CODEX_HOME/skills' && codexSource.dir === path.join(codexHome, 'skills')
        && same(withEnv.candidates.map((candidate) => candidate.dirName), ['zeta']), JSON.stringify(withEnv.sources));

      // 来源本身不是目录
      const fileWorld = worlds.mkWorld('scan-file');
      fs.mkdirSync(path.join(fileWorld.home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(fileWorld.home, '.claude', 'skills'), 'i am a file\n');
      const fileBody = (await H.api(S.mkSkills(fileWorld, fileWorld.proj), 'GET', '/api/skills/external')).jsonBody();
      check('F21. ~/.claude/skills 是个文件 → 当作不存在，不抛', fileBody.ok === true && fileBody.sources[0].exists === false && fileBody.sources[0].error === '' && fileBody.candidates.length === 0, JSON.stringify(fileBody.sources[0]));

      // 上限
      const crowd = worlds.mkWorld('scan-crowd');
      for (let index = 0; index < 130; index += 1) H.writeSkill(path.join(crowd.home, '.claude', 'skills'), `bulk-${String(index).padStart(3, '0')}`, { raw: md(`bulk-${index}`) });
      const crowdBody = (await H.api(S.mkSkills(crowd, crowd.proj), 'GET', '/api/skills/external')).jsonBody();
      check('F22. 一个来源最多列 128 个，并标明被截断', crowdBody.sources[0].count === 128 && crowdBody.sources[0].truncated === true && crowdBody.candidates.length === 128
        && crowdBody.candidates[0].dirName === 'bulk-000' && crowdBody.candidates[127].dirName === 'bulk-127');
    }

    /* ============================================================ */
    section('G. 导入扫描到的技能');
    {
      const w = scanWorld;
      const sk = S.mkSkills(w, w.proj, { approve: true });
      const pid = S.skillId(w.proj);
      const idOf = (root, dirName) => S.skillId(path.join(root, dirName));
      const importMany = (body, query = `?project=${pid}`) => H.api(sk, 'POST', `/api/skills/external/import${query}`, body);
      const sourceTrees = () => [H.snapshotTree(path.join(w.home, '.claude')), H.snapshotTree(path.join(w.home, '.codex')), H.snapshotTree(path.join(w.proj, '.claude')), H.snapshotTree(elsewhere)];
      const sourcesBefore = sourceTrees();
      const piGammaBefore = tree(path.join(piUser, 'gamma'));

      const first = await importMany({ ids: [idOf(claudeUser, 'alpha'), idOf(codexUser, 'delta'), idOf(claudeProject, 'epsilon')], target: 'user-pi' });
      const r1 = first.jsonBody() || { results: [] };
      check('G1. 一次导入三个来源各一个 → 全部成功', first.code === 200 && r1.ok === true && r1.imported === 3 && r1.skipped === 0 && r1.failed === 0 && r1.target === 'user-pi' && r1.targetLabel === '~/.pi/agent/skills'
        && same(r1.results.map((item) => `${item.name}|${item.status}|${item.fileCount}|${item.renamed}|${item.replaced}`), ['alpha|imported|3|false|false', 'delta|imported|1|false|false', 'epsilon|imported|2|false|false']), first.body());
      check('G2. 整个目录都过来了，逐字节相同（脚本、二进制资源）', tree(path.join(piUser, 'alpha')) === tree(path.join(claudeUser, 'alpha')) && tree(path.join(piUser, 'epsilon')) === tree(path.join(claudeProject, 'epsilon'))
        && fs.readFileSync(path.join(piUser, 'alpha', 'assets', 'pic.bin')).equals(Buffer.from([0, 255, 1, 254, 0x89])));
      check('G3. 来源目录没有被动过（含修改时间）', same(sourceTrees(), sourcesBefore));
      check('G4. 三次安装合成一个撤销令牌；pi 没运行 → 不需要重启', HEX24.test(r1.undo) && r1.restartRequired === false && r1.notice === '');
      const undone = await H.api(sk, 'POST', `/api/skills/undo/${r1.undo}`);
      check('G5. 一次撤销整批：三个都挪进回收站', undone.code === 200 && undone.jsonBody().kind === 'batch' && undone.jsonBody().count === 3
        && !fs.existsSync(path.join(piUser, 'alpha')) && !fs.existsSync(path.join(piUser, 'delta')) && !fs.existsSync(path.join(piUser, 'epsilon'))
        && same(H.trashEntries(w, 'del-').map((id) => H.readTrashMeta(w, id).name).sort(), ['alpha', 'delta', 'epsilon']), undone.body());
      check('G6. 令牌用掉了', outcome(await H.api(sk, 'POST', `/api/skills/undo/${r1.undo}`)) === '410:undo-expired');

      const skipped = await importMany({ ids: [idOf(claudeUser, 'beta'), idOf(claudeUser, 'gamma'), idOf(claudeUser, 'alpha')], target: 'user-pi' });
      const r2 = skipped.jsonBody() || { results: [] };
      check('G7. 默认遇到同名就跳过，其余照常', r2.imported === 1 && r2.skipped === 2 && r2.failed === 0
        && same(r2.results.map((item) => `${item.name}|${item.status}|${item.error || ''}`), ['beta|skipped|已有同名技能，已跳过', 'gamma|skipped|已有同名技能，已跳过', 'alpha|imported|']), skipped.body());
      check('G8. 被跳过的 pi 这边原样', tree(path.join(piUser, 'gamma')) === piGammaBefore);

      const replaced = await importMany({ ids: [idOf(claudeUser, 'gamma')], target: 'user-pi', onConflict: 'replace' });
      const r3 = replaced.jsonBody() || { results: [{}] };
      check('G9. 选「覆盖」→ pi 这边换成来源的那份，旧的进回收站', r3.imported === 1 && r3.results[0].replaced === true && tree(path.join(piUser, 'gamma')) === tree(path.join(claudeUser, 'gamma'))
        && H.trashEntries(w, 'del-').some((id) => H.readTrashMeta(w, id).reason === 'replace' && tree(H.trashPayload(w, id)) === piGammaBefore), replaced.body());
      const restored = await H.api(sk, 'POST', `/api/skills/undo/${r3.undo}`);
      check('G10. 撤销 → pi 原来的那份回来了', restored.code === 200 && restored.jsonBody().restored === true && tree(path.join(piUser, 'gamma')) === piGammaBefore, restored.body());

      const renamed = await importMany({ ids: [idOf(claudeUser, 'gamma')], target: 'user-pi', onConflict: 'rename' });
      const r4 = renamed.jsonBody() || { results: [{}] };
      check('G11. 选「保留两者」→ 装成 gamma-2，frontmatter 的 name 跟着改', r4.imported === 1 && r4.results[0].name === 'gamma-2' && r4.results[0].renamed === true
        && fs.readFileSync(path.join(piUser, 'gamma-2', 'SKILL.md'), 'utf8') === md('gamma', 'Claude version').replace('name: gamma', 'name: gamma-2') && tree(path.join(piUser, 'gamma')) === piGammaBefore, renamed.body());

      const mixed = await importMany({
        ids: [idOf(claudeUser, 'shared-a'), idOf(claudeUser, 'big'), 'f'.repeat(16), idOf(claudeUser, 'huge'), idOf(claudeUser, 'with-link'), idOf(claudeUser, 'No Description')],
        target: 'user-agents',
      });
      const r5 = mixed.jsonBody() || { results: [] };
      const agentsRoot = path.join(w.home, '.agents', 'skills');
      check('G12. 一批里有好有坏：好的装进去，坏的逐条说明原因', mixed.code === 200 && r5.imported === 2 && r5.failed === 4 && same(r5.results.map((item) => `${item.status}|${item.error || item.name}`), [
        'failed|它已经链接在 pi 的技能目录里，不需要导入',
        'failed|SKILL.md 超过 256 KB',
        'failed|找不到这个技能了（可能已被移走），请重新扫描',
        'failed|blob.bin 超过单个文件 2 MB 的上限',
        'imported|with-link',
        'imported|no-description',
      ]), mixed.body());
      const withLink = r5.results.find((item) => item.name === 'with-link') || { skipped: [] };
      check('G13. 技能目录里的链接不跟随：报告为跳过，链接指向的内容没有被带进来', same(withLink.skipped, [{ path: 'linked-dir', reason: 'symlink', note: '符号链接' }]) && withLink.fileCount === 2
        && H.listDir(path.join(agentsRoot, 'with-link')).join(',') === 'SKILL.md,docs' && !fs.existsSync(path.join(agentsRoot, 'with-link', 'linked-dir')), JSON.stringify(withLink));
      const invalidRow = H.findSkill(await H.getList(sk, pid), 'nodesc', 'user');
      check('G14. 没有 description 的那个装进去了，列表如实标成「无法加载」', fs.existsSync(path.join(agentsRoot, 'no-description', 'SKILL.md')) && Boolean(invalidRow) && invalidRow.state === 'invalid');
      check('G15. 超限的那个没有留下半个目录', !fs.existsSync(path.join(agentsRoot, 'huge')) && leftovers(agentsRoot).length === 0);

      const deduped = await importMany({ ids: [idOf(claudeUser, 'beta'), idOf(claudeUser, 'beta'), 5, null, { id: 'x' }], target: 'project-pi' });
      const r6 = deduped.jsonBody() || { results: [] };
      check('G16. ids 里重复的、不是字符串的都剔掉；装进项目目录', r6.results.length === 1 && r6.imported === 1 && fs.existsSync(path.join(w.proj, '.pi', 'skills', 'beta', 'SKILL.md')), deduped.body());

      // 请求不合法
      const bad = [];
      for (const body of [{ ids: [], target: 'user-pi' }, { target: 'user-pi' }, { ids: 'alpha', target: 'user-pi' }, { ids: [1, 2], target: 'user-pi' }]) bad.push(outcome(await importMany(body)));
      check('G17. 没选任何技能 → 400', bad.every((entry) => entry === '400:bad-request'), bad.join(','));
      const tooMany = await importMany({ ids: Array.from({ length: 65 }, (_, index) => index.toString(16).padStart(16, '0')), target: 'user-pi' });
      check('G18. 一次超过 64 个 → 400', outcome(tooMany) === '400:bad-request' && errorOf(tooMany) === '一次最多导入 64 个技能', tooMany.body());
      check('G19. 冲突策略 / 保存位置不合法 → 400', outcome(await importMany({ ids: [idOf(claudeUser, 'alpha')], target: 'user-pi', onConflict: 'fail' })) === '400:bad-request'
        && outcome(await importMany({ ids: [idOf(claudeUser, 'alpha')], target: claudeUser })) === '400:bad-target');
      check('G20. 不带 project → 400 project-required', outcome(await importMany({ ids: [idOf(claudeUser, 'alpha')], target: 'user-pi' }, '')) === '400:project-required');

      // 扫描之后、导入之前，来源被挪走
      const vanishing = H.writeSkill(codexUser, 'vanishing', { raw: md('vanishing') });
      const vanishingId = idOf(codexUser, 'vanishing');
      const seen = (await H.api(sk, 'GET', `/api/skills/external?project=${pid}`)).jsonBody().candidates.some((candidate) => candidate.id === vanishingId);
      fs.rmSync(path.dirname(vanishing), { recursive: true, force: true });
      const gone = (await importMany({ ids: [vanishingId], target: 'user-pi' })).jsonBody();
      check('G21. 扫到之后被挪走了 → 这一项失败并提示重新扫描，不会按旧路径去读', seen === true && gone.failed === 1 && gone.imported === 0 && gone.results[0].error === '找不到这个技能了（可能已被移走），请重新扫描' && gone.undo === '', JSON.stringify(gone));

      // 重启提示
      const live = S.mkSkills(w, w.proj, { approve: true, rpc: H.mkRpc([], { running: true }) });
      const liveResult = (await H.api(live, 'POST', `/api/skills/external/import?project=${pid}`, { ids: [idOf(codexUser, 'delta')], target: 'user-pi' })).jsonBody();
      check('G22. pi 在运行 → 导入全局技能后需要重启才生效', liveResult.imported === 1 && liveResult.restartRequired === true, JSON.stringify(liveResult));
      const liveSkipped = (await H.api(live, 'POST', `/api/skills/external/import?project=${pid}`, { ids: [idOf(codexUser, 'delta')], target: 'user-pi' })).jsonBody();
      check('G23. 全部被跳过 → 什么都没变，不需要重启，也没有可撤销的', liveSkipped.imported === 0 && liveSkipped.skipped === 1 && liveSkipped.restartRequired === false && liveSkipped.undo === '', JSON.stringify(liveSkipped));
    }

    /* ============================================================ */
    section('H. 项目未被信任：扫描照常，导入到项目目录被拒');
    {
      const w = worlds.mkWorld('scan-untrusted');
      fs.mkdirSync(path.join(w.proj, '.pi', 'skills'), { recursive: true });
      H.writeSkill(path.join(w.home, '.claude', 'skills'), 'eta', { raw: md('eta') });
      H.writeSkill(path.join(w.proj, '.claude', 'skills'), 'theta', { raw: md('theta') });
      const sk = S.mkSkills(w, w.proj);
      const pid = S.skillId(w.proj);
      const etaId = S.skillId(path.join(w.home, '.claude', 'skills', 'eta'));
      const projectBefore = H.snapshotTree(w.proj);
      const scanned = (await H.api(sk, 'GET', `/api/skills/external?project=${pid}`)).jsonBody();
      check('H1. 扫描是只读的，不受信任状态影响', scanned.candidates.length === 2 && scanned.candidates.every((candidate) => candidate.importable === true));
      const refused = await H.api(sk, 'POST', `/api/skills/external/import?project=${pid}`, { ids: [etaId], target: 'project-pi' });
      check('H2. 导入到项目目录 → 403 project-untrusted，项目里一个字节都没多', outcome(refused) === '403:project-untrusted' && H.snapshotTree(w.proj) === projectBefore, refused.body());
      const allowed = (await H.api(sk, 'POST', `/api/skills/external/import?project=${pid}`, { ids: [etaId], target: 'user-pi' })).jsonBody();
      check('H3. 导入到全局目录不受影响', allowed.imported === 1 && fs.existsSync(path.join(w.agent, 'skills', 'eta', 'SKILL.md')));
    }
  } catch (err) {
    check('套件运行中没有未捕获的异常', false, err && err.stack ? err.stack : String(err));
  } finally {
    worlds.cleanup();
    finish();
  }
})();
