/* 技能管理（二）：编辑、删除、撤销、安装时的同名冲突、链接防线、写操作串行。
 *
 * 新建 / 项目上下文 / 信任闸 / 校验 / 路由层在 tests/skills-manage.cjs，
 * 落盘原语在 tests/skills-files.cjs。
 *
 * 纪律同前：全部在 os.tmpdir() 里造世界，不 spawn、不联网、不碰任何真实技能目录；
 * 每个 fixture 项目都有 `.git`。项目级写入一律用 approve 标志固定「被信任」，
 * 不依赖这台机器上级目录里有什么。
 *
 * 这里反复证明的是同一件事：改坏了能回去。删除、覆盖进回收站，编辑前有备份，
 * 每一步的撤销都把磁盘恢复到逐字节相同；凡是拒绝的操作，磁盘上一个字节都不动。
 *
 * 跑法：node tests/skills-manage-edit.cjs */
const fs = require('node:fs');
const path = require('node:path');
const H = require('./fixtures/skills-harness.cjs');

const { check, skip, section, finish } = H.createChecker();
const worlds = H.createWorlds('pi-gui-skills-edit-');

const HEX24 = /^[0-9a-f]{24}$/;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const NO_TRASH = '回收站不可用，为避免无法恢复，本次操作已拒绝';
/** HTTP 结果的「状态码:业务码」。 */
const outcome = (res) => `${res.code}:${(res.jsonBody() || {}).code || ''}`;
/** manager 直接返回的结果：成功是 ok，失败是「状态码:业务码」。 */
const verdict = (result) => (result && result.ok ? 'ok' : `${result && result.status}:${result && result.code}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** 安装用的临时目录、原子写用的临时文件：任何一步结束后都不该留在技能目录里。 */
const leftovers = (dir) => H.listDir(dir).filter((name) => name.startsWith('.pi-gui-') || name.endsWith('.tmp'));

(async () => {
  const S = await H.loadSkillsServer();
  const { createSkillsManager } = S;

  try {
    /* ============================================================ */
    section('D. 编辑已有技能');
    {
      const w = worlds.mkWorld('edit');
      const userRoot = path.join(w.agent, 'skills');
      const ORIGINAL = '---\nname: edit-me\ndescription: Old description\nlicense: MIT\nallowed-tools: Read Grep\nmetadata:\n  author: someone\n  version: "1.0"\n---\n\n# Edit me\n\nOld body\n';
      const EXPECT1 = '---\nname: edit-me\ndescription: "New description: now with colon"\nlicense: MIT\nallowed-tools: Read Grep\nmetadata:\n  author: someone\n  version: "1.0"\n---\n\n# Edit me\n\nNew body\n';
      const EXPECT2 = EXPECT1.replace('New body', 'Third body');
      const file = H.writeSkill(userRoot, 'edit-me', { raw: ORIGINAL, files: { 'scripts/run.py': 'print("hi")\n', 'assets/logo.bin': Buffer.from([0, 1, 2, 3, 254, 255]) } });
      const skillDir = path.dirname(file);
      const sk = S.mkSkills(w, w.proj, { rpc: H.mkRpc([{ name: 'edit-me', path: file }]), approve: true });
      const pid = S.skillId(w.proj);
      const id = S.skillId(file);
      const SOURCE = `/api/skills/${id}/source?project=${pid}`;
      const put = (body, url = SOURCE) => H.api(sk, 'PUT', url, body);
      const undo = (token) => H.api(sk, 'POST', `/api/skills/undo/${token}`);
      const onDisk = () => fs.readFileSync(file, 'utf8');
      const diskHash = () => H.sha256(fs.readFileSync(file));
      const backups = () => H.trashEntries(w, 'edit-');
      const siblings = () => `${H.snapshotTree(path.join(skillDir, 'scripts'))}\n${H.snapshotTree(path.join(skillDir, 'assets'))}`;
      const siblingsBefore = siblings();

      const srcRes = await H.api(sk, 'GET', SOURCE);
      const src = srcRes.jsonBody();
      check('D1. 读源文件：说明它是谁、在哪', srcRes.code === 200 && src.ok === true && src.id === id && src.name === 'edit-me' && src.dirName === 'edit-me' && src.scope === 'user'
        && src.target === 'user-pi' && src.targetLabel === '~/.pi/agent/skills' && src.path === file, srcRes.body().slice(0, 300));
      check('D2. 原文、哈希、换行风格、BOM、字节数', src.content === ORIGINAL && src.hash === H.sha256(Buffer.from(ORIGINAL)) && src.eol === 'lf' && src.bom === false && src.bytes === Buffer.byteLength(ORIGINAL));
      check('D3. 表单视图：名称、描述、正文拆开，其余键只列名字', src.form.available === true && src.form.generated === false && src.form.name === 'edit-me' && src.form.description === 'Old description'
        && src.form.body === '# Edit me\n\nOld body\n' && src.form.extraKeys.join(',') === 'license,allowed-tools,metadata', JSON.stringify(src.form));
      check('D4. 带上限，编辑器据此显示字节计数', src.limits.maxBytes === 262144 && src.limits.maxDescription === 1024);
      check('D5. 读取不写盘、不产生备份', onDisk() === ORIGINAL && backups().length === 0);

      const save1 = await put({ mode: 'form', description: 'New description: now with colon', body: '# Edit me\n\nNew body\n', baseHash: src.hash });
      const s1 = save1.jsonBody();
      check('D6. 表单保存成功', save1.code === 200 && s1.ok === true && s1.changed === true && s1.hash === H.sha256(Buffer.from(EXPECT1)) && s1.bytes === Buffer.byteLength(EXPECT1) && HEX24.test(s1.undo), save1.body());
      check('D7. 只改了 description 那一行与正文：license / allowed-tools / metadata 一个字节没动', onDisk() === EXPECT1, JSON.stringify(onDisk()));
      check('D8. 技能目录里的其他文件原样（连修改时间）', siblings() === siblingsBefore && H.listDir(skillDir).join(',') === 'SKILL.md,assets,scripts', H.listDir(skillDir).join(','));
      check('D9. frontmatter 变了 → pi 在运行就要重启', s1.metaChanged === true && s1.restartRequired === true);
      const firstBackup = backups();
      const backupMeta = firstBackup.length === 1 ? H.readTrashMeta(w, firstBackup[0]) : null;
      check('D10. 保存前的字节进了回收站', firstBackup.length === 1 && firstBackup[0].startsWith(`edit-${id}-`) && backupMeta && backupMeta.kind === 'backup' && backupMeta.reason === 'edit'
        && backupMeta.name === 'edit-me' && backupMeta.scope === 'user' && backupMeta.originalPath === file && fs.readFileSync(H.trashPayload(w, firstBackup[0]), 'utf8') === ORIGINAL, JSON.stringify(backupMeta));
      check('D11. 保存响应不带任何路径', !save1.body().includes(w.base.replace(/\\/g, '\\\\')) && !save1.body().includes(w.base));

      const stale = await put({ mode: 'form', description: 'clobber', body: 'clobber', baseHash: src.hash });
      check('D12. 拿旧的哈希再存 → 409 changed-on-disk，文件不动', outcome(stale) === '409:changed-on-disk' && onDisk() === EXPECT1, outcome(stale));
      check('D13. 不带 baseHash → 400', outcome(await put({ mode: 'form', description: 'x', body: 'y' })) === '400:bad-request' && outcome(await put({ mode: 'form', description: 'x', body: 'y', baseHash: 42 })) === '400:bad-request');

      const save2 = await put({ mode: 'form', description: 'New description: now with colon', body: '# Edit me\n\nThird body\n', baseHash: s1.hash });
      const s2 = save2.jsonBody();
      check('D14. 只改正文：frontmatter 逐字节不变', save2.code === 200 && s2.changed === true && onDisk() === EXPECT2, save2.body());
      check('D15. 只改正文 → 不需要重启（pi 用到时才读正文）', s2.metaChanged === false && s2.restartRequired === false);
      const sameAgain = await put({ mode: 'form', description: 'New description: now with colon', body: '# Edit me\n\nThird body\n', baseHash: s2.hash });
      const sameBody = sameAgain.jsonBody();
      check('D16. 内容没变 → 不写盘、不备份、不发撤销令牌', sameAgain.code === 200 && sameBody.changed === false && !('undo' in sameBody) && sameBody.restartRequired === false && sameBody.hash === s2.hash && backups().length === 2, sameAgain.body());

      const tooEarly = await undo(s1.undo);
      check('D17. 先撤销更早的那次 → 409（文件已不是那次保存后的样子），文件不动', outcome(tooEarly) === '409:changed-on-disk' && onDisk() === EXPECT2, outcome(tooEarly));
      const undo2 = await undo(s2.undo);
      check('D18. 撤销最近一次 → 回到上一版', undo2.code === 200 && same(undo2.jsonBody(), { ok: true, kind: 'edit', name: 'edit-me', restartRequired: false }) && onDisk() === EXPECT1, undo2.body());
      const undo1 = await undo(s1.undo);
      check('D19. 再撤销更早的那次（令牌没因刚才的失败作废）→ 回到最初', undo1.code === 200 && undo1.jsonBody().restartRequired === true && onDisk() === ORIGINAL, undo1.body());
      check('D20. 撤销用掉的备份随之清掉；其他文件仍然原样', backups().length === 0 && siblings() === siblingsBefore && leftovers(skillDir).length === 0, backups().join(','));
      check('D21. 撤销过的令牌不能再用', outcome(await undo(s1.undo)) === '410:undo-expired');

      const s3 = (await put({ mode: 'raw', content: ORIGINAL.replace('Old body', 'Fourth body'), baseHash: diskHash() })).jsonBody();
      fs.appendFileSync(file, 'edited elsewhere\n');
      const afterExternal = onDisk();
      const blockedUndo = await undo(s3.undo);
      check('D22. 保存之后文件又被别的程序改过 → 撤销拒绝，不覆盖那次修改', s3.ok === true && outcome(blockedUndo) === '409:changed-on-disk' && onDisk() === afterExternal, outcome(blockedUndo));

      // 源文件模式
      const failedBefore = { text: onDisk(), backups: backups().length };
      const noFm = await put({ mode: 'raw', content: '# no frontmatter at all', baseHash: diskHash() });
      check('D23. 源文件模式：没有 frontmatter → 400 invalid（content）', outcome(noFm) === '400:invalid' && noFm.jsonBody().errors[0].field === 'content', noFm.body());
      const emptyDesc = await put({ mode: 'raw', content: '---\nname: edit-me\ndescription:\n---\nbody\n', baseHash: diskHash() });
      check('D24. description 是空的 → 400 invalid（description）', outcome(emptyDesc) === '400:invalid' && emptyDesc.jsonBody().errors[0].field === 'description', emptyDesc.body());
      const numDesc = await put({ mode: 'raw', content: '---\nname: edit-me\ndescription: 12345\n---\nbody\n', baseHash: diskHash() });
      check('D25. description 会被 YAML 读成数字 → 400 invalid', outcome(numDesc) === '400:invalid' && /引号/.test(numDesc.jsonBody().error), numDesc.body());
      const nulRaw = await put({ mode: 'raw', content: '---\nname: edit-me\ndescription: fine\n---\nbo\x00dy\n', baseHash: diskHash() });
      check('D26. 内容里有空字符 → 400 invalid', outcome(nulRaw) === '400:invalid', outcome(nulRaw));
      const tooBig = await put({ mode: 'raw', content: `---\nname: edit-me\ndescription: big\n---\n${'x'.repeat(S.MAX_SKILL_BYTES)}`, baseHash: diskHash() });
      check('D27. 内容超过 256 KB → 413 too-large', outcome(tooBig) === '413:too-large' && /256 KB/.test(tooBig.jsonBody().error), outcome(tooBig));
      const hugeRequest = await put(Buffer.alloc(1024 * 1024 + 16, 0x20));
      check('D28. 请求体超过 1 MB → 413', outcome(hugeRequest) === '413:too-large' && hugeRequest.jsonBody().error === '请求体太大', hugeRequest.body());
      check('D29. mode 不认识 → 400', outcome(await put({ mode: 'weird', content: 'x', baseHash: diskHash() })) === '400:bad-request' && outcome(await put({ content: 'x', baseHash: diskHash() })) === '400:bad-request');
      check('D30. content 不是字符串 → 400', outcome(await put({ mode: 'raw', content: 42, baseHash: diskHash() })) === '400:bad-request' && outcome(await put({ mode: 'raw', baseHash: diskHash() })) === '400:bad-request');
      check('D31. 表单模式缺 description 或 body → 400', outcome(await put({ mode: 'form', description: 42, body: 'x', baseHash: diskHash() })) === '400:bad-request'
        && outcome(await put({ mode: 'form', description: 'x', baseHash: diskHash() })) === '400:bad-request');
      const noProject = await put({ mode: 'raw', content: ORIGINAL, baseHash: diskHash() }, `/api/skills/${id}/source`);
      check('D32. 保存不带 project → 400 project-required', outcome(noProject) === '400:project-required', outcome(noProject));
      check('D33. 以上失败的保存都没动文件，也没多出备份', onDisk() === failedBefore.text && backups().length === failedBefore.backups && leftovers(skillDir).length === 0);

      const rawSave = await put({ mode: 'raw', content: '---\r\nname: renamed-inside\r\ndescription: Raw edit\r\n---\r\n\r\nRaw body\r\n', baseHash: diskHash() });
      const rawBody = rawSave.jsonBody();
      check('D34. 源文件模式整份替换；提交的 CRLF 按原文件的换行风格（LF）落盘', rawSave.code === 200 && onDisk() === '---\nname: renamed-inside\ndescription: Raw edit\n---\n\nRaw body\n', JSON.stringify(onDisk()));
      check('D35. frontmatter 的 name 与目录名不一致 → 提醒，不拦', rawBody.warnings.some((entry) => entry.field === 'name' && /与目录名（edit-me）不一致/.test(entry.message)), JSON.stringify(rawBody.warnings));
      const renamed = H.findSkill(await H.getList(sk, pid), 'renamed-inside');
      check('D36. 列表里显示新的 name，ID 不变（ID 跟着路径走）', Boolean(renamed) && renamed.id === id && renamed.description === 'Raw edit');

      // BOM + CRLF 的文件：读出来是干净的 LF 文本，存回去仍是 BOM + CRLF
      const winOriginal = Buffer.concat([BOM, Buffer.from('---\r\nname: win-file\r\ndescription: Windows style\r\n---\r\n\r\nLine one\r\nLine two\r\n')]);
      const winFile = H.writeSkill(userRoot, 'win-file', { raw: winOriginal });
      const WIN = `/api/skills/${S.skillId(winFile)}/source?project=${pid}`;
      const win = (await H.api(sk, 'GET', WIN)).jsonBody();
      check('D37. BOM + CRLF：如实报告，编辑器拿到的是不带 BOM 的 LF 文本', win.bom === true && win.eol === 'crlf' && win.content === '---\nname: win-file\ndescription: Windows style\n---\n\nLine one\nLine two\n'
        && win.hash === H.sha256(winOriginal) && win.bytes === winOriginal.length, JSON.stringify({ bom: win.bom, eol: win.eol, content: win.content }));
      check('D38. …表单字段也是干净的', win.form.description === 'Windows style' && win.form.body === 'Line one\nLine two\n');
      const winSave = (await put({ mode: 'form', description: 'Windows style, edited', body: 'Line one\nLine two\nLine three\n', baseHash: win.hash }, WIN)).jsonBody();
      const winExpected = Buffer.concat([BOM, Buffer.from('---\r\nname: win-file\r\ndescription: Windows style, edited\r\n---\r\n\r\nLine one\r\nLine two\r\nLine three\r\n')]);
      check('D39. 存回去：BOM 还在，换行全是 CRLF，没有混进裸 LF', winSave.ok === true && fs.readFileSync(winFile).equals(winExpected), JSON.stringify(fs.readFileSync(winFile).toString('utf8')));
      check('D40. 列表读得出改后的描述', H.findSkill(await H.getList(sk, pid), 'win-file').description === 'Windows style, edited');
      check('D41. 撤销 → 逐字节回到原文件', (await undo(winSave.undo)).code === 200 && fs.readFileSync(winFile).equals(winOriginal));

      // 读不了的文件：拒绝，而不是带着替换符存回去毁掉它
      const latinBytes = Buffer.concat([Buffer.from('---\nname: latin-one\ndescription: caf'), Buffer.from([0xe9]), Buffer.from(' menu\n---\nbody\n')]);
      const latinFile = H.writeSkill(userRoot, 'latin-one', { raw: latinBytes });
      const LATIN = `/api/skills/${S.skillId(latinFile)}/source?project=${pid}`;
      const latinGet = await H.api(sk, 'GET', LATIN);
      check('D42. 不是 UTF-8 的文件 → 409 not-utf8', outcome(latinGet) === '409:not-utf8' && /不是 UTF-8/.test(latinGet.jsonBody().error), latinGet.body());
      const latinPut = await put({ mode: 'raw', content: '---\nname: latin-one\ndescription: fixed\n---\n', baseHash: H.sha256(latinBytes) }, LATIN);
      check('D43. …也不能保存，原字节不动', outcome(latinPut) === '409:not-utf8' && fs.readFileSync(latinFile).equals(latinBytes), outcome(latinPut));
      const nulFile = H.writeSkill(userRoot, 'nul-file', { raw: '---\nname: nul-file\ndescription: has nul\n---\nbo\x00dy\n' });
      check('D44. 文件里有空字符 → 409 binary', outcome(await H.api(sk, 'GET', `/api/skills/${S.skillId(nulFile)}/source?project=${pid}`)) === '409:binary');
      const bigFile = H.writeSkill(userRoot, 'big-file', { raw: `---\nname: big-file\ndescription: big\n---\n${'x'.repeat(S.MAX_SKILL_BYTES)}` });
      check('D45. 文件超过 256 KB → 413 too-large', outcome(await H.api(sk, 'GET', `/api/skills/${S.skillId(bigFile)}/source?project=${pid}`)) === '413:too-large');

      // 表单读不懂的写法：退到源文件模式，不猜着改
      const fancyText = '---\nname: fancy\ndescription: &anchor Fancy text\n---\n\nBody\n';
      const fancyFile = H.writeSkill(userRoot, 'fancy', { raw: fancyText });
      const FANCY = `/api/skills/${S.skillId(fancyFile)}/source?project=${pid}`;
      const fancy = (await H.api(sk, 'GET', FANCY)).jsonBody();
      check('D46. YAML 特殊写法 → 表单不可用，并说明原因', fancy.ok === true && fancy.form.available === false && /写法特殊/.test(fancy.form.reason), JSON.stringify(fancy.form));
      const fancyForm = await put({ mode: 'form', description: 'Plain now', body: 'Body\n', baseHash: fancy.hash }, FANCY);
      check('D47. 这时用表单保存 → 409 form-unavailable，指引改用源文件；文件不动', outcome(fancyForm) === '409:form-unavailable' && /源文件/.test(fancyForm.jsonBody().error) && fs.readFileSync(fancyFile, 'utf8') === fancyText, fancyForm.body());
      const fancyRaw = await put({ mode: 'raw', content: '---\nname: fancy\ndescription: Plain now\n---\n\nBody\n', baseHash: fancy.hash }, FANCY);
      check('D48. 源文件模式照常可用', fancyRaw.code === 200 && fs.readFileSync(fancyFile, 'utf8') === '---\nname: fancy\ndescription: Plain now\n---\n\nBody\n');

      // 没有 frontmatter 的技能（pi 不加载）：表单保存就是修好它
      const fixFile = H.writeSkill(userRoot, 'fix-me', { raw: '# Just notes\n\nNo frontmatter here.\n' });
      const FIX = `/api/skills/${S.skillId(fixFile)}/source?project=${pid}`;
      const brokenRow = H.findSkill(await H.getList(sk, pid), 'fix-me');
      check('D49. 没有 frontmatter 的技能：列为 invalid，但可以编辑', brokenRow.state === 'invalid' && brokenRow.manage.editable === true, JSON.stringify(brokenRow.manage));
      const fix = (await H.api(sk, 'GET', FIX)).jsonBody();
      check('D50. 表单把整份原文当正文', fix.form.available === true && fix.form.generated === true && fix.form.description === '' && fix.form.body === '# Just notes\n\nNo frontmatter here.\n', JSON.stringify(fix.form));
      const fixed = (await put({ mode: 'form', description: 'Now it loads', body: fix.form.body, baseHash: fix.hash }, FIX)).jsonBody();
      check('D51. 表单保存补上标准的 frontmatter（name 取目录名），正文原样', fixed.ok === true && fixed.metaChanged === true && fs.readFileSync(fixFile, 'utf8') === '---\nname: fix-me\ndescription: Now it loads\n---\n\n# Just notes\n\nNo frontmatter here.\n', JSON.stringify(fs.readFileSync(fixFile, 'utf8')));
      check('D52. 修好之后不再是 invalid', H.findSkill(await H.getList(sk, pid), 'fix-me').state === 'not-loaded');

      check('D53. 技能 ID 不存在 → 404', outcome(await H.api(sk, 'GET', `/api/skills/${'f'.repeat(16)}/source?project=${pid}`)) === '404:not-found'
        && outcome(await put({ mode: 'raw', content: 'x', baseHash: 'x' }, `/api/skills/${'f'.repeat(16)}/source?project=${pid}`)) === '404:not-found');
    }

    /* ------------------------------------------------------------ */
    section('D2. 只读的来源：看得到，改不了');
    {
      const w = worlds.mkWorld('read-only');
      const sub = path.join(w.proj, 'sub');
      fs.mkdirSync(sub, { recursive: true });
      H.writeSkill(path.join(w.proj, '.agents', 'skills'), 'anc');
      const declaredDir = path.join(w.base, 'declared');
      H.writeSkill(declaredDir, 'declared-one');
      // 名字以「真正的技能根」为前缀的兄弟目录：按字符串前缀判断就会被当成自己人
      const evilRoot = path.join(w.agent, 'skills-evil');
      H.writeSkill(evilRoot, 'evil-one');
      H.writeJson(path.join(w.agent, 'settings.json'), { skills: [declaredDir, evilRoot] });
      const pkgFile = H.writeSkill(path.join(w.base, 'pkg'), 'pkg-skill');
      H.writeSkill(path.join(w.agent, 'skills'), 'ours');
      const rpc = H.mkRpc([{ name: 'pkg-skill', path: pkgFile }, { name: 'ghost-skill' }]);
      const sk = S.mkSkills(w, sub, { rpc, approve: true });
      const pid = S.skillId(sub);
      const list = await H.getList(sk, pid);
      const before = H.snapshotTree(w.base);

      check('D2-1. 对照：真正在技能根里的那个可以管理', same(H.findSkill(list, 'ours').manage, { target: 'user-pi', editable: true, deletable: true, reason: '' }), JSON.stringify(H.findSkill(list, 'ours').manage));
      const cases = [
        ['anc', '上级目录的 .agents/skills', /不在 Pi GUI 管理的技能目录里/],
        ['declared-one', 'settings 里声明的目录', /来自 settings）.*不在 Pi GUI 管理的技能目录里/],
        ['evil-one', '名字以技能根为前缀的兄弟目录', /不在 Pi GUI 管理的技能目录里/],
        ['pkg-skill', 'pi 报告、文件在别处（包里的技能）', /不在 Pi GUI 管理的技能目录里/],
        ['ghost-skill', 'pi 报告、没有路径', /^这个技能由 pi 报告，Pi GUI 没有定位到它的文件$/],
      ];
      for (const [name, what, reason] of cases) {
        const row = H.findSkill(list, name);
        const manage = row ? row.manage : null;
        check(`D2-2. ${what}：只读，并说明原因`, Boolean(manage) && manage.target === null && manage.editable === false && manage.deletable === false && reason.test(manage.reason), JSON.stringify(manage));
        const rowId = row ? row.id : '0'.repeat(16);
        const codes = [
          outcome(await H.api(sk, 'GET', `/api/skills/${rowId}/source?project=${pid}`)),
          outcome(await H.api(sk, 'PUT', `/api/skills/${rowId}/source?project=${pid}`, { mode: 'raw', content: '---\ndescription: x\n---\n', baseHash: 'x' })),
          outcome(await H.api(sk, 'DELETE', `/api/skills/${rowId}?project=${pid}`)),
        ];
        check(`D2-3. ${what}：读源文件 / 保存 / 删除一律 403`, codes.join(',') === '403:read-only,403:read-only,403:read-only', codes.join(','));
      }
      check('D2-4. 整个世界一个字节都没动（连修改时间）', H.snapshotTree(w.base) === before);
    }

    /* ------------------------------------------------------------ */
    section('D3. 没有回收站时：不做任何回不去的事');
    {
      const w = worlds.mkWorld('no-trash');
      const file = H.writeSkill(path.join(w.agent, 'skills'), 'precious');
      const sk = S.mkSkills(w, w.proj, { approve: true, dataDir: null });
      const pid = S.skillId(w.proj);
      const list = await H.getList(sk, pid);
      const row = H.findSkill(list, 'precious');
      const before = H.snapshotTree(path.join(w.agent, 'skills'));
      check('D3-1. 列表如实说明回收站不可用', list.trashAvailable === false && same(row.manage, { target: 'user-pi', editable: false, deletable: false, reason: NO_TRASH }), JSON.stringify(row.manage));
      const codes = [
        outcome(await H.api(sk, 'GET', `/api/skills/${row.id}/source?project=${pid}`)),
        outcome(await H.api(sk, 'PUT', `/api/skills/${row.id}/source?project=${pid}`, { mode: 'raw', content: '---\ndescription: x\n---\n', baseHash: H.sha256(fs.readFileSync(file)) })),
        outcome(await H.api(sk, 'DELETE', `/api/skills/${row.id}?project=${pid}`)),
      ];
      check('D3-2. 编辑、删除都拒绝', codes.join(',') === '403:read-only,403:read-only,403:read-only', codes.join(','));
      check('D3-3. 文件原样', H.snapshotTree(path.join(w.agent, 'skills')) === before);
      const made = (await H.api(sk, 'POST', `/api/skills/create?project=${pid}`, { target: 'user-pi', name: 'still-works', description: 'creating destroys nothing' })).jsonBody();
      check('D3-4. 新建不毁掉任何东西，照常可用；但不发撤销令牌（撤销要靠回收站）', made.ok === true && made.undo === '' && fs.existsSync(path.join(w.agent, 'skills', 'still-works', 'SKILL.md')), JSON.stringify(made));
      const dup = await H.api(sk, 'POST', `/api/skills/create?project=${pid}`, { target: 'user-pi', name: 'precious', description: 'again' });
      check('D3-5. 同名冲突时如实说明「不能覆盖」', outcome(dup) === '409:exists' && dup.jsonBody().conflict.replaceable === false, dup.body());
      check('D3-6. 数据目录里没有凭空建出回收站', !fs.existsSync(path.join(w.data, 'skills-trash')));
    }

    /* ------------------------------------------------------------ */
    section('D4. 编辑备份只留最近 5 份');
    {
      const w = worlds.mkWorld('backups');
      const text = (n) => `---\nname: many-edits\ndescription: version ${n}\n---\n\nv${n}\n`;
      const file = H.writeSkill(path.join(w.agent, 'skills'), 'many-edits', { raw: text(0) });
      // 注入时钟：每次取时间都前进一秒，备份的先后完全确定（不依赖真实时间的毫秒分辨率）
      let clock = Date.UTC(2026, 0, 1);
      const manager = createSkillsManager({ core: S.realCore(S.mkSkills(w, w.proj, { approve: true })), dataDir: w.data, now: () => new Date((clock += 1000)) });
      const ctx = { cwd: w.proj, live: true, explicit: true };
      const id = S.skillId(file);
      const tokens = [];
      let hash = H.sha256(fs.readFileSync(file));
      for (let n = 1; n <= 7; n += 1) {
        const saved = await manager.saveSource(ctx, id, { mode: 'raw', content: text(n), baseHash: hash });
        tokens[n] = saved.undo;
        hash = saved.hash;
      }
      const kept = H.trashEntries(w, 'edit-');
      check('D4-1. 连续改 7 次 → 回收站里正好 5 份备份', kept.length === 5 && fs.readFileSync(file, 'utf8') === text(7), String(kept.length));
      check('D4-2. 留下的是最近的 5 份（第 2 到第 6 版的内容）', kept.map((name) => fs.readFileSync(H.trashPayload(w, name), 'utf8')).join('|') === [2, 3, 4, 5, 6].map(text).join('|'));
      const walkBack = [];
      for (let n = 7; n >= 3; n -= 1) {
        const result = await manager.undo(tokens[n]);
        walkBack.push(`${verdict(result)}:${fs.readFileSync(file, 'utf8') === text(n - 1)}`);
      }
      check('D4-3. 倒着撤销最近 5 次，每次都回到上一版', walkBack.join(',') === 'ok:true,ok:true,ok:true,ok:true,ok:true', walkBack.join(','));
      const beyond = await manager.undo(tokens[2]);
      check('D4-4. 更早的那次备份已被清掉 → 410 undo-expired，文件不动', verdict(beyond) === '410:undo-expired' && /备份已经不在了/.test(beyond.error) && fs.readFileSync(file, 'utf8') === text(2), JSON.stringify(beyond));
      check('D4-5. 备份全部用完', H.trashEntries(w, 'edit-').length === 0);
    }

    /* ============================================================ */
    section('E. 删除与撤销删除');
    {
      const w = worlds.mkWorld('delete');
      const userRoot = path.join(w.agent, 'skills');
      const victimFile = H.writeSkill(userRoot, 'victim', {
        files: { 'scripts/run.sh': '#!/bin/sh\necho hi\n', 'assets/logo.bin': Buffer.from([0, 1, 2, 255]), '.hidden': 'kept too\n', 'node_modules/pkg/index.js': 'module.exports = 1;\n' },
      });
      const victimDir = path.dirname(victimFile);
      const keeperFile = H.writeSkill(userRoot, 'keeper');
      const singleFile = path.join(userRoot, 'single.md');
      const SINGLE = '---\nname: single\ndescription: single file skill\n---\nbody\n';
      fs.writeFileSync(singleFile, SINGLE);
      const idleFile = H.writeSkill(userRoot, 'idle-one');
      const projFile = H.writeSkill(path.join(w.proj, '.pi', 'skills'), 'p1-skill');
      const proj2 = path.join(w.base, 'proj2');
      fs.mkdirSync(path.join(proj2, '.git'), { recursive: true });
      H.writeSkill(path.join(proj2, '.pi', 'skills'), 'p2-skill');
      H.writeSkill(userRoot, 'user-two');
      const projects = [{ path: w.proj, name: '一' }, { path: proj2, name: '二' }];
      const reported = [{ name: 'victim', path: victimFile }, { name: 'keeper', path: keeperFile }, { name: 'p1-skill', path: projFile }, { name: 'idle-one', path: idleFile }];
      const sk = S.mkSkills(w, w.proj, { rpc: H.mkRpc(reported), approve: true, projects });
      const pid = S.skillId(w.proj);
      const pid2 = S.skillId(proj2);
      const del = (skillId, project = pid, mod = sk) => H.api(mod, 'DELETE', `/api/skills/${skillId}?project=${project}`);
      const undo = (token) => H.api(sk, 'POST', `/api/skills/undo/${token}`);
      const victimBefore = H.snapshotTree(victimDir, { withMtime: false });
      const keeperBefore = H.snapshotTree(path.dirname(keeperFile));
      const victim = H.findSkill(await H.getList(sk, pid), 'victim');

      const removed = await del(victim.id);
      const removedBody = removed.jsonBody();
      check('E1. 删除成功；pi 还加载着它 → 要重启', removed.code === 200 && removedBody.ok === true && removedBody.name === 'victim' && removedBody.scope === 'user' && removedBody.restartRequired === true && HEX24.test(removedBody.undo), removed.body());
      check('E2. 响应只有名字、作用域与撤销令牌，没有路径', Object.keys(removedBody).sort().join(',') === 'name,ok,restartRequired,scope,undo');
      check('E3. 技能目录消失，旁边的技能原样（连修改时间）', !fs.existsSync(victimDir) && H.snapshotTree(path.dirname(keeperFile)) === keeperBefore && leftovers(userRoot).length === 0);
      const trashed = H.trashEntries(w, 'del-');
      const meta = trashed.length === 1 ? H.readTrashMeta(w, trashed[0]) : null;
      check('E4. 不是真删：整个目录（含脚本、二进制、隐藏文件、node_modules）进了回收站', trashed.length === 1 && H.snapshotTree(H.trashPayload(w, trashed[0]), { withMtime: false }) === victimBefore);
      check('E5. 回收站条目记着它原来在哪、为什么在这', meta && meta.id === trashed[0] && meta.kind === 'dir' && meta.reason === 'delete' && meta.name === 'victim' && meta.scope === 'user'
        && meta.originalPath === victimDir && meta.rootDir === userRoot && typeof meta.trashedAt === 'string', JSON.stringify(meta));

      const ghost = H.findSkill(await H.getList(sk, pid), 'victim');
      check('E6. pi 重启前它还在列表里：如实说明「文件没了，pi 还加载着」', Boolean(ghost) && ghost.id === victim.id && ghost.loaded === true && /文件已经不在磁盘上了；重启 pi 之后/.test(ghost.stateNote), JSON.stringify(ghost && ghost.stateNote));
      check('E7. …这一行不能再编辑或删除', same(ghost.manage, { target: 'user-pi', editable: false, deletable: false, reason: '它的文件已经不在磁盘上了' }), JSON.stringify(ghost.manage));
      check('E8. 对它再删一次 → 403', outcome(await del(victim.id)) === '403:read-only' && outcome(await H.api(sk, 'GET', `/api/skills/${victim.id}/source?project=${pid}`)) === '403:read-only');

      const restored = await undo(removedBody.undo);
      check('E9. 撤销删除成功', restored.code === 200 && same(restored.jsonBody(), { ok: true, kind: 'delete', name: 'victim', restartRequired: true }), restored.body());
      check('E10. 整个目录逐字节回到原处，回收站条目消失', H.snapshotTree(victimDir, { withMtime: false }) === victimBefore && H.trashEntries(w, 'del-').length === 0);
      const back = H.findSkill(await H.getList(sk, pid), 'victim');
      check('E11. 列表里恢复正常', back.state === 'enabled' && back.manage.deletable === true && back.id === victim.id);
      check('E12. 撤销过的令牌不能再用', outcome(await undo(removedBody.undo)) === '410:undo-expired');

      // 原位置被别的东西占了
      const second = (await del(victim.id)).jsonBody();
      fs.mkdirSync(victimDir);
      fs.writeFileSync(path.join(victimDir, 'squatter.txt'), 'someone put this here');
      const blocked = await undo(second.undo);
      const heldEntry = H.trashEntries(w, 'del-');
      check('E13. 撤销时原位置已被占用 → 409 exists，不覆盖', outcome(blocked) === '409:exists' && /原来的位置已经有别的东西了/.test(blocked.jsonBody().error) && !blocked.body().includes(w.base), blocked.body());
      check('E14. …占位的东西与回收站里的那份都原样', fs.readFileSync(path.join(victimDir, 'squatter.txt'), 'utf8') === 'someone put this here' && heldEntry.length === 1
        && H.snapshotTree(H.trashPayload(w, heldEntry[0]), { withMtime: false }) === victimBefore);
      fs.rmSync(victimDir, { recursive: true });
      const retry = await undo(second.undo);
      check('E15. 腾出位置后同一个令牌还能撤销', retry.code === 200 && H.snapshotTree(victimDir, { withMtime: false }) === victimBefore, retry.body());

      // 回收站里的那份被人手动删了
      const third = (await del(victim.id)).jsonBody();
      fs.rmSync(path.join(w.data, 'skills-trash', H.trashEntries(w, 'del-')[0]), { recursive: true });
      const lost = await undo(third.undo);
      check('E16. 回收站条目已不在 → 410 trash-missing，不抛', outcome(lost) === '410:trash-missing' && lost.thrown === null, lost.body());

      // 单文件技能
      const single = H.findSkill(await H.getList(sk, pid), 'single');
      check('E17. 根目录下的单个 .md 技能可以管理', Boolean(single) && same(single.manage, { target: 'user-pi', editable: true, deletable: true, reason: '' }), JSON.stringify(single && single.manage));
      const singleRemoved = (await del(single.id)).jsonBody();
      const singleEntry = H.trashEntries(w, 'del-');
      const singleMeta = singleEntry.length === 1 ? H.readTrashMeta(w, singleEntry[0]) : null;
      check('E18. 删除它：只挪走这一个文件', singleRemoved.ok === true && !fs.existsSync(singleFile) && fs.existsSync(keeperFile) && singleMeta && singleMeta.kind === 'file' && singleMeta.originalPath === singleFile
        && fs.readFileSync(H.trashPayload(w, singleEntry[0]), 'utf8') === SINGLE, JSON.stringify(singleMeta));
      check('E19. pi 明确说没加载它 → 删除不需要重启', singleRemoved.restartRequired === false);
      const singleBack = await undo(singleRemoved.undo);
      check('E20. 撤销 → 文件回来，内容相同', singleBack.code === 200 && fs.readFileSync(singleFile, 'utf8') === SINGLE && H.trashEntries(w, 'del-').length === 0);

      // 要不要重启
      const projRow = H.findSkill(await H.getList(sk, pid), 'p1-skill', 'project');
      const projRemoved = (await del(projRow.id)).jsonBody();
      check('E21. 当前工作区的项目级技能（被信任）：能删，要重启', projRemoved.ok === true && projRemoved.scope === 'project' && projRemoved.restartRequired === true && !fs.existsSync(path.dirname(projFile)), JSON.stringify(projRemoved));
      const otherList = await H.getList(sk, pid2);
      const p2Removed = (await del(H.findSkill(otherList, 'p2-skill', 'project').id, pid2)).jsonBody();
      check('E22. 另一个项目的项目级技能：能删，不需要重启正在运行的 pi', p2Removed.ok === true && p2Removed.scope === 'project' && p2Removed.restartRequired === false && !fs.existsSync(path.join(proj2, '.pi', 'skills', 'p2-skill')), JSON.stringify(p2Removed));
      const userTwoRemoved = (await del(H.findSkill(otherList, 'user-two').id, pid2)).jsonBody();
      check('E23. 在别的项目上下文里删全局技能：仍然要重启', userTwoRemoved.ok === true && userTwoRemoved.scope === 'user' && userTwoRemoved.restartRequired === true, JSON.stringify(userTwoRemoved));
      const stopped = S.mkSkills(w, w.proj, { rpc: H.mkRpc(reported, { running: false }), approve: true, projects });
      const idleRemoved = (await del(S.skillId(idleFile), pid, stopped)).jsonBody();
      check('E24. pi 没在运行 → 不需要重启', idleRemoved.ok === true && idleRemoved.restartRequired === false, JSON.stringify(idleRemoved));

      check('E25. 技能 ID 不存在 → 404', outcome(await del('f'.repeat(16))) === '404:not-found');
      check('E26. 删除不带 project → 400 project-required，文件还在', outcome(await H.api(sk, 'DELETE', `/api/skills/${S.skillId(keeperFile)}`)) === '400:project-required' && fs.existsSync(keeperFile));

      // SKILL.md 直接放在技能根目录里：整个根就是一个技能
      const rw = worlds.mkWorld('root-skill');
      const rootFile = path.join(rw.agent, 'skills', 'SKILL.md');
      fs.mkdirSync(path.dirname(rootFile), { recursive: true });
      fs.writeFileSync(rootFile, '---\nname: whole-root\ndescription: the root itself is a skill\n---\nbody\n');
      const rsk = S.mkSkills(rw, rw.proj, { approve: true });
      const rpid = S.skillId(rw.proj);
      const rootRow = H.findSkill(await H.getList(rsk, rpid), 'whole-root');
      check('E27. 根目录里的 SKILL.md：可以编辑，不能删除（删它等于删整个技能根）', Boolean(rootRow) && same(rootRow.manage, { target: 'user-pi', editable: true, deletable: false, reason: 'SKILL.md 直接放在技能根目录里，不能在这里删除' }), JSON.stringify(rootRow && rootRow.manage));
      check('E28. 删除它 → 403，文件还在', outcome(await del(rootRow.id, rpid, rsk)) === '403:read-only' && fs.existsSync(rootFile));
      const rootSource = (await H.api(rsk, 'GET', `/api/skills/${rootRow.id}/source?project=${rpid}`)).jsonBody();
      check('E29. 读它的源文件：没有「目录名」这回事', rootSource.ok === true && rootSource.dirName === '');

      // 技能目录是个链接
      const jw = worlds.mkWorld('linked-skill');
      const elsewhere = path.join(jw.base, 'elsewhere');
      H.writeSkill(elsewhere, 'linked-real', { files: { 'notes.txt': 'not ours to touch\n' } });
      H.linkDir(path.join(elsewhere, 'linked-real'), path.join(jw.agent, 'skills', 'linked'));
      const jsk = S.mkSkills(jw, jw.proj, { approve: true });
      const jpid = S.skillId(jw.proj);
      const linkedRow = H.findSkill(await H.getList(jsk, jpid), 'linked-real');
      const elsewhereBefore = H.snapshotTree(elsewhere);
      check('E30. 技能目录是一个链接：列得出来，但只读', Boolean(linkedRow) && same(linkedRow.manage, { target: 'user-pi', editable: false, deletable: false, reason: '这个技能目录是一个链接，请到原位置修改' }), JSON.stringify(linkedRow && linkedRow.manage));
      const linkedCodes = [
        outcome(await del(linkedRow.id, jpid, jsk)),
        outcome(await H.api(jsk, 'GET', `/api/skills/${linkedRow.id}/source?project=${jpid}`)),
        outcome(await H.api(jsk, 'PUT', `/api/skills/${linkedRow.id}/source?project=${jpid}`, { mode: 'raw', content: '---\ndescription: x\n---\n', baseHash: 'x' })),
      ];
      check('E31. 删除 / 读源文件 / 保存 → 403', linkedCodes.join(',') === '403:read-only,403:read-only,403:read-only', linkedCodes.join(','));
      check('E32. 链接还在，链接指向的目录一个字节都没动', fs.lstatSync(path.join(jw.agent, 'skills', 'linked')).isSymbolicLink() && H.snapshotTree(elsewhere) === elsewhereBefore);

      // 技能目录的「上一级」是链接：技能目录自己看起来是个普通目录，实际却在技能根之外。
      // 这里若放行删除，被挪进回收站的就是别处的真实目录。
      const nw = worlds.mkWorld('nested-link');
      const shared = path.join(nw.base, 'shared-group');
      H.writeSkill(shared, 'deep-one', { files: { 'data.txt': 'lives outside the skills root\n' } });
      H.linkDir(shared, path.join(nw.agent, 'skills', 'group'));
      const nsk = S.mkSkills(nw, nw.proj, { approve: true });
      const npid = S.skillId(nw.proj);
      const deepRow = H.findSkill(await H.getList(nsk, npid), 'deep-one');
      const sharedBefore = H.snapshotTree(shared);
      check('E33. 技能目录的上一级是链接：列得出来，但只读', Boolean(deepRow) && same(deepRow.manage, { target: 'user-pi', editable: false, deletable: false, reason: '它经由链接指向了技能目录之外，请到原位置修改' }), JSON.stringify(deepRow && deepRow.manage));
      const deepCodes = [
        outcome(await del(deepRow.id, npid, nsk)),
        outcome(await H.api(nsk, 'GET', `/api/skills/${deepRow.id}/source?project=${npid}`)),
        outcome(await H.api(nsk, 'PUT', `/api/skills/${deepRow.id}/source?project=${npid}`, { mode: 'raw', content: '---\ndescription: x\n---\n', baseHash: 'x' })),
      ];
      check('E34. 删除 / 读源文件 / 保存 → 403', deepCodes.join(',') === '403:read-only,403:read-only,403:read-only', deepCodes.join(','));
      check('E35. 链接还在，链接指向的目录一个字节都没动，回收站里没有东西', fs.lstatSync(path.join(nw.agent, 'skills', 'group')).isSymbolicLink() && H.snapshotTree(shared) === sharedBefore && H.trashEntries(nw, '').length === 0);
    }

    /* ============================================================ */
    section('F. 安装与同名冲突（导入 / 扫描 / 市场共用的那一步）');
    {
      const w = worlds.mkWorld('install');
      const userRoot = path.join(w.agent, 'skills');
      const sk = S.mkSkills(w, w.proj, { approve: true });
      const manager = createSkillsManager({ core: S.realCore(sk, { running: true, approve: true }), dataDir: w.data });
      const ctx = { cwd: w.proj, live: true, explicit: true };
      const md = (name, tag = 'v1') => `---\nname: ${name}\ndescription: ${tag} of ${name}\n---\n\n# ${name} ${tag}\n`;
      const pack = (name, tag, extra = []) => [{ path: 'SKILL.md', bytes: Buffer.from(md(name, tag)), executable: false }, ...extra];
      const install = (request) => manager.install(ctx, { targetKey: 'user-pi', ...request });
      const dupDir = path.join(userRoot, 'dup');

      const first = await install({ name: 'dup', files: pack('dup', 'v1', [{ path: 'scripts/a.sh', bytes: Buffer.from('echo a\n'), executable: true }, { path: 'assets/b.bin', bytes: Buffer.from([0, 255, 7]) }]) });
      check('F1. 带附属资源的安装：全部落盘，字节相同', first.ok === true && fs.readFileSync(path.join(dupDir, 'SKILL.md'), 'utf8') === md('dup', 'v1') && fs.readFileSync(path.join(dupDir, 'scripts', 'a.sh'), 'utf8') === 'echo a\n'
        && fs.readFileSync(path.join(dupDir, 'assets', 'b.bin')).equals(Buffer.from([0, 255, 7])), JSON.stringify(first));
      check('F2. 响应：装到了哪、几个文件、技能 ID', first.name === 'dup' && first.requestedName === 'dup' && first.renamed === false && first.replaced === false && first.fileCount === 3 && first.path === dupDir
        && first.id === S.skillId(path.join(dupDir, 'SKILL.md')) && first.scope === 'user' && first.target === 'user-pi' && first.restartRequired === true && HEX24.test(first.undo), JSON.stringify(first));
      const v1Snapshot = H.snapshotTree(dupDir, { withMtime: false });

      const refused = await install({ name: 'dup', files: pack('dup', 'v2') });
      check('F3. 同名已存在（默认）→ 409 exists，给出能不能覆盖与备用名', verdict(refused) === '409:exists' && same(refused.conflict, { name: 'dup', target: 'user-pi', replaceable: true, suggestion: 'dup-2' }), JSON.stringify(refused));
      check('F4. …原来的一个字节都没动', H.snapshotTree(dupDir, { withMtime: false }) === v1Snapshot && leftovers(userRoot).length === 0);

      const replaced = await install({ name: 'dup', files: pack('dup', 'v2'), onConflict: 'replace' });
      check('F5. 覆盖：装上新的', replaced.ok === true && replaced.replaced === true && replaced.renamed === false && fs.readFileSync(path.join(dupDir, 'SKILL.md'), 'utf8') === md('dup', 'v2') && H.listDir(dupDir).join(',') === 'SKILL.md', JSON.stringify(replaced));
      check('F6. 覆盖自己不算「同名冲突」，没有多余提醒', replaced.warnings.length === 0, JSON.stringify(replaced.warnings));
      const replacedEntries = H.trashEntries(w, 'del-');
      const replacedMeta = replacedEntries.length === 1 ? H.readTrashMeta(w, replacedEntries[0]) : null;
      check('F7. 被覆盖的旧目录（含附属资源）完整进了回收站', replacedMeta && replacedMeta.reason === 'replace' && replacedMeta.originalPath === dupDir && H.snapshotTree(H.trashPayload(w, replacedEntries[0]), { withMtime: false }) === v1Snapshot, JSON.stringify(replacedMeta));
      const undone = await manager.undo(replaced.undo);
      check('F8. 撤销覆盖：旧的逐字节回来', undone.ok === true && undone.kind === 'install' && undone.name === 'dup' && undone.restored === true && H.snapshotTree(dupDir, { withMtime: false }) === v1Snapshot, JSON.stringify(undone));
      const afterUndo = H.trashEntries(w, 'del-');
      check('F9. …新装的那份也没有真删，进了回收站', afterUndo.length === 1 && H.readTrashMeta(w, afterUndo[0]).reason === 'undo-install' && fs.readFileSync(path.join(H.trashPayload(w, afterUndo[0]), 'SKILL.md'), 'utf8') === md('dup', 'v2'));

      const kept = await install({ name: 'dup', files: pack('dup', 'v3'), onConflict: 'rename' });
      check('F10. 保留两者：换一个目录名', kept.ok === true && kept.name === 'dup-2' && kept.requestedName === 'dup' && kept.renamed === true && kept.replaced === false && kept.path === path.join(userRoot, 'dup-2'), JSON.stringify(kept));
      check('F11. frontmatter 里的 name 跟着换（否则 pi 仍认为它们同名），其余不动', fs.readFileSync(path.join(userRoot, 'dup-2', 'SKILL.md'), 'utf8') === md('dup', 'v3').replace('name: dup', 'name: dup-2'), JSON.stringify(fs.readFileSync(path.join(userRoot, 'dup-2', 'SKILL.md'), 'utf8')));
      check('F12. 原来的那个原样', H.snapshotTree(dupDir, { withMtime: false }) === v1Snapshot);
      const keptAgain = await install({ name: 'dup', files: pack('dup', 'v4'), onConflict: 'rename' });
      check('F13. 再来一次 → dup-3', keptAgain.ok === true && keptAgain.name === 'dup-3');
      const nameless = Buffer.from('---\ndescription: no name key here\n---\nbody\n');
      const keptNameless = await install({ name: 'dup', files: [{ path: 'SKILL.md', bytes: nameless }], onConflict: 'rename' });
      check('F14. frontmatter 里本来就没有 name → 文件逐字节不变（pi 用目录名）', keptNameless.ok === true && keptNameless.name === 'dup-4' && fs.readFileSync(path.join(userRoot, 'dup-4', 'SKILL.md')).equals(nameless));

      // 备用名要避开「别的目录里已经叫这个名字的技能」
      H.writeSkill(path.join(w.home, '.agents', 'skills'), 'some-dir', { fmName: 'taken-2' });
      H.writeSkill(userRoot, 'taken');
      const avoid = await install({ name: 'taken', files: pack('taken', 'v2'), onConflict: 'rename' });
      check('F15. 备用名避开别处已有的同名技能（taken-2 被占 → taken-3）', avoid.ok === true && avoid.name === 'taken-3', JSON.stringify(avoid.name));
      const twice = Buffer.from('---\nname: dup\nname: dup\ndescription: duplicated key\n---\n');
      const cannotRename = await install({ name: 'dup', files: [{ path: 'SKILL.md', bytes: twice }], onConflict: 'rename' });
      check('F16. frontmatter 写法读不懂、没法只改 name → 409 rename-unsupported，什么都不写', verdict(cannotRename) === '409:rename-unsupported' && !fs.existsSync(path.join(userRoot, 'dup-5')), JSON.stringify(cannotRename));

      // 同名的那一项不是普通目录
      fs.writeFileSync(path.join(userRoot, 'isfile'), 'just a file');
      const overFile = await install({ name: 'isfile', files: pack('isfile', 'v1'), onConflict: 'replace' });
      check('F17. 同名项是个文件 → 拒绝覆盖', verdict(overFile) === '409:replace-blocked' && /不是一个普通的技能目录/.test(overFile.error) && fs.readFileSync(path.join(userRoot, 'isfile'), 'utf8') === 'just a file', JSON.stringify(overFile));
      const overFileAsk = await install({ name: 'isfile', files: pack('isfile', 'v1') });
      check('F18. …冲突提示里如实说「不能覆盖」', verdict(overFileAsk) === '409:exists' && overFileAsk.conflict.replaceable === false && overFileAsk.conflict.suggestion === 'isfile-2');
      const outside = path.join(w.base, 'outside');
      H.writeSkill(outside, 'precious');
      H.linkDir(path.join(outside, 'precious'), path.join(userRoot, 'linked'));
      const outsideBefore = H.snapshotTree(outside);
      const overLink = await install({ name: 'linked', files: pack('linked', 'v1'), onConflict: 'replace' });
      check('F19. 同名项是个链接 → 拒绝覆盖，链接与它指向的目录都不动', verdict(overLink) === '409:replace-blocked' && fs.lstatSync(path.join(userRoot, 'linked')).isSymbolicLink() && H.snapshotTree(outside) === outsideBefore, JSON.stringify(overLink));

      // 参数
      const badNames = ['../x', 'Bad Name', 'con', '', 'a/b', '.dot', 42, undefined];
      const badNameVerdicts = [];
      for (const name of badNames) badNameVerdicts.push(verdict(await install({ name, files: pack('x', 'v1') })));
      check('F20. 目录名不合规 → 400 bad-name', badNameVerdicts.every((entry) => entry === '400:bad-name'), badNameVerdicts.join(','));
      check('F21. 包里没有 SKILL.md → 400', verdict(await install({ name: 'no-md', files: [{ path: 'README.md', bytes: Buffer.from('x') }] })) === '400:no-skill-md');
      check('F22. SKILL.md 超过 256 KB → 413', verdict(await install({ name: 'huge-md', files: [{ path: 'SKILL.md', bytes: Buffer.alloc(S.MAX_SKILL_BYTES + 1, 0x61) }] })) === '413:skill-md-too-large');
      check('F23. SKILL.md 不是 UTF-8 → 400', verdict(await install({ name: 'latin', files: [{ path: 'SKILL.md', bytes: Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xe9, 0x0a]) }] })) === '400:not-utf8');
      check('F24. SKILL.md 里有空字符 → 400', verdict(await install({ name: 'has-nul', files: [{ path: 'SKILL.md', bytes: Buffer.from('---\ndescription: a\x00b\n---\n') }] })) === '400:binary');
      check('F25. onConflict 不认识 → 400', verdict(await install({ name: 'fresh', files: pack('fresh', 'v1'), onConflict: 'overwrite' })) === '400:bad-request');
      const badTargets = [];
      for (const targetKey of ['nope', '__proto__', 'constructor', '', undefined, userRoot]) badTargets.push(verdict(await manager.install(ctx, { targetKey, name: 'fresh', files: pack('fresh', 'v1') })));
      check('F26. 保存位置不是四个 key 之一（含原型链上的名字、绝对路径）→ 400 bad-target', badTargets.every((entry) => entry === '400:bad-target'), badTargets.join(','));
      check('F27. 以上被拒绝的安装什么都没建', ['no-md', 'huge-md', 'latin', 'has-nul', 'fresh', 'x'].every((name) => !fs.existsSync(path.join(userRoot, name))) && leftovers(userRoot).length === 0);
      const invalidButInstallable = await install({ name: 'no-desc', files: [{ path: 'SKILL.md', bytes: Buffer.from('---\nname: no-desc\n---\nbody\n') }] });
      check('F28. 「pi 不会加载」不是拒绝安装的理由（导入时已经告知用户）', invalidButInstallable.ok === true);

      // 覆盖到一半写失败：旧的自动放回
      const trashBefore = H.trashEntries(w, 'del-').length;
      const halfway = await install({
        name: 'dup',
        files: [...pack('dup', 'v9'), { path: 'a', bytes: Buffer.from('file') }, { path: 'a/b', bytes: Buffer.from('needs a to be a directory') }],
        onConflict: 'replace',
      });
      check('F29. 覆盖时写到一半失败 → 500 write-failed', verdict(halfway) === '500:write-failed', JSON.stringify(halfway));
      check('F30. 错误信息只有错误类别，没有路径', /^写入失败：系统错误 E[A-Z]+$/.test(halfway.error) && !halfway.error.includes(w.base), halfway.error);
      check('F31. 旧的自动放回原处，逐字节相同', H.snapshotTree(dupDir, { withMtime: false }) === v1Snapshot);
      check('F32. 没留下半截的临时目录，回收站里也没多出东西', leftovers(userRoot).length === 0 && H.trashEntries(w, 'del-').length === trashBefore, `${leftovers(userRoot).join(',')} / ${H.trashEntries(w, 'del-').length}`);

      // 要不要重启
      const live = await manager.install(ctx, { targetKey: 'project-pi', name: 'in-project', files: pack('in-project', 'v1') });
      check('F33. 装进当前工作区的项目：落在 <项目>/.pi/skills，要重启', live.ok === true && live.scope === 'project' && live.restartRequired === true && fs.existsSync(path.join(w.proj, '.pi', 'skills', 'in-project', 'SKILL.md')), JSON.stringify(live));
      const elsewhereCtx = { cwd: w.proj, live: false, explicit: true };
      const notLive = await manager.install(elsewhereCtx, { targetKey: 'project-agents', name: 'in-other-project', files: pack('in-other-project', 'v1') });
      check('F34. 装进「不是 pi 正在运行的那个」项目 → 不需要重启', notLive.ok === true && notLive.restartRequired === false && fs.existsSync(path.join(w.proj, '.agents', 'skills', 'in-other-project', 'SKILL.md')));
      const userFromElsewhere = await manager.install(elsewhereCtx, { targetKey: 'user-agents', name: 'global-from-elsewhere', files: pack('global-from-elsewhere', 'v1') });
      check('F35. 在别的上下文里装全局技能 → 仍然要重启', userFromElsewhere.ok === true && userFromElsewhere.restartRequired === true);
      const idle = createSkillsManager({ core: S.realCore(sk, { running: false, approve: true }), dataDir: w.data });
      const whileIdle = await idle.install(ctx, { targetKey: 'user-pi', name: 'while-idle', files: pack('while-idle', 'v1') });
      check('F36. pi 没在运行 → 不需要重启', whileIdle.ok === true && whileIdle.restartRequired === false);

      // 同名提醒
      const shadowing = await manager.install(ctx, { targetKey: 'user-agents', name: 'dup', files: pack('dup', 'other root') });
      check('F37. 装到另一个根目录、与已有技能同名 → 成功并提醒会被覆盖', shadowing.ok === true && shadowing.warnings.length >= 1 && /已有同名技能「dup」/.test(shadowing.warnings[0]), JSON.stringify(shadowing.warnings));
      const mismatched = await install({ name: 'dir-name', files: [{ path: 'SKILL.md', bytes: Buffer.from('---\nname: inner-name\ndescription: mismatch\n---\n') }] });
      check('F38. 目录名与 frontmatter 的 name 不一致 → 成功并提醒 pi 以后者为准', mismatched.ok === true && mismatched.warnings.some((text) => /目录名是 dir-name，但 frontmatter 里的 name 是 inner-name/.test(text)), JSON.stringify(mismatched.warnings));

      const asset = { path: 'assets/data.bin', bytes: Buffer.from([1, 2, 3]) };
      const changes = [
        ['edited', (dir) => fs.writeFileSync(path.join(dir, asset.path), Buffer.from([1, 2, 4]))],
        ['added', (dir) => fs.writeFileSync(path.join(dir, '.user-note'), 'keep')],
        ['removed', (dir) => fs.unlinkSync(path.join(dir, asset.path))],
        ['folder', (dir) => fs.mkdirSync(path.join(dir, 'empty'))],
      ];
      for (const [kind, change] of changes) {
        const name = 'undo-' + kind;
        await install({ name, files: pack(name, 'old') });
        const newer = await install({ name, files: pack(name, 'new', [asset]), onConflict: 'replace' });
        const dir = path.join(userRoot, name);
        change(dir);
        const before = H.snapshotTree(dir, { withMtime: false });
        const trashBeforeUndo = H.trashEntries(w, 'del-');
        const result = await manager.undo(newer.undo);
        check(`F39. 撤销覆盖遇到 ${kind} 后续改动 → 拒绝，目录和替换备份不动`,
          verdict(result) === '409:changed-on-disk' && H.snapshotTree(dir, { withMtime: false }) === before
          && H.trashEntries(w, 'del-').join() === trashBeforeUndo.join(), JSON.stringify(result));
      }

      const linked = await install({ name: 'undo-linked', files: pack('undo-linked', 'v1', [asset]) });
      const linkedAssets = path.join(linked.path, 'assets');
      const otherAssets = path.join(w.base, 'other-assets');
      fs.renameSync(linkedAssets, otherAssets);
      fs.symlinkSync(otherAssets, linkedAssets, 'junction');
      const refusedLink = await manager.undo(linked.undo);
      check('F40. 资源目录变成链接 → 拒绝，即使链接目标字节相同', verdict(refusedLink) === '409:changed-on-disk'
        && fs.lstatSync(linkedAssets).isSymbolicLink() && fs.readFileSync(path.join(otherAssets, 'data.bin')).equals(asset.bytes),
        JSON.stringify(refusedLink));

      const gone = await install({ name: 'undo-gone', files: pack('undo-gone', 'old') });
      const replacedGone = await install({ name: gone.name, files: pack(gone.name, 'new'), onConflict: 'replace' });
      fs.renameSync(replacedGone.path, path.join(w.base, 'moved-by-user'));
      const refusedGone = await manager.undo(replacedGone.undo);
      check('F41. 用户挪走新安装目录 → 拒绝恢复旧安装', verdict(refusedGone) === '409:changed-on-disk' && !fs.existsSync(replacedGone.path),
        JSON.stringify(refusedGone));

      const trustFile = path.join(w.agent, 'trust.json');
      const trustedManager = createSkillsManager({ core: S.realCore(sk), dataDir: w.data });
      H.writeJson(trustFile, { [path.resolve(w.proj)]: true });
      const managed = await trustedManager.install(ctx, { targetKey: 'project-pi', name: 'undo-trust', files: pack('undo-trust', 'v1') });
      H.writeJson(trustFile, { [path.resolve(w.proj)]: false });
      const denied = await trustedManager.undo(managed.undo);
      check('F42. 原项目信任被撤销 → 拒绝，已安装文件保留', verdict(denied) === '403:project-untrusted'
        && fs.readFileSync(path.join(managed.path, 'SKILL.md'), 'utf8') === md('undo-trust', 'v1'), JSON.stringify(denied));
      H.writeJson(trustFile, { [path.resolve(w.proj)]: true });
      const restoredTrust = await trustedManager.undo(managed.undo);
      check('F43. 恢复原项目信任后可重试，原包进入回收站', restoredTrust.ok && !fs.existsSync(managed.path), JSON.stringify(restoredTrust));

      const untouched = await install({ name: 'undo-batch-clean', files: pack('undo-batch-clean', 'v1') });
      const changed = await install({ name: 'undo-batch-edited', files: pack('undo-batch-edited', 'v1') });
      const batch = manager.mergeUndo([untouched.undo, changed.undo]);
      fs.writeFileSync(path.join(changed.path, 'SKILL.md'), md(changed.name, 'changed after import'));
      const partial = await manager.undo(batch);
      check('F44. 批量撤销保留改过的技能，并继续撤销未改动的技能',
        verdict(partial) === '409:undo-partial' && !fs.existsSync(untouched.path)
        && fs.readFileSync(path.join(changed.path, 'SKILL.md'), 'utf8') === md(changed.name, 'changed after import'), JSON.stringify(partial));
      check('F45. 批量撤销部分成功后，令牌不能再用', verdict(await manager.undo(batch)) === '410:undo-expired');

      const foldCase = await install({ name: 'undo-case', files: pack('undo-case', 'v1', [
        { path: 'Assets/one', bytes: Buffer.from('1') }, { path: 'assets/two', bytes: Buffer.from('2') },
      ]) });
      const folded = await manager.undo(foldCase.undo);
      check('F46. 按实际文件系统记录大小写不同的目录，未经修改仍可撤销', folded.ok && !fs.existsSync(foldCase.path), JSON.stringify(folded));

      const fresh = worlds.mkWorld('undo-first-project-skill');
      const freshCtx = { cwd: fresh.proj, explicit: true };
      const freshPath = path.join(fresh.proj, '.pi', 'skills', 'first-skill');
      const freshCore = {
        ...S.fakeCore(fresh),
        readTrustState({ assumeResources }) {
          return assumeResources || fs.existsSync(freshPath)
            ? { trusted: false, reason: 'ask-no-ui' }
            : { trusted: true, reason: 'no-project-resources' };
        },
      };
      const freshManager = createSkillsManager({ core: freshCore, dataDir: fresh.data });
      const firstSkill = await freshManager.install(freshCtx, { targetKey: 'project-pi', name: 'first-skill', files: pack('first-skill', 'v1') });
      const firstUndo = await freshManager.undo(firstSkill.undo);
      check('F47. 第一个项目级技能安装后仍待信任，撤销也先复核信任',
        firstSkill.ok && verdict(firstUndo) === '403:project-untrusted'
        && fs.readFileSync(path.join(freshPath, 'SKILL.md'), 'utf8') === md('first-skill', 'v1'), JSON.stringify(firstUndo));
    }

    /* ============================================================ */
    section('G. 链接防线：项目里的 .pi / .agents 被链接到别处时不写');
    {
      const linkWorld = (name, build) => {
        const w = worlds.mkWorld(name);
        const outside = path.join(w.base, 'outside');
        fs.mkdirSync(outside, { recursive: true });
        build(w, outside);
        const sk = S.mkSkills(w, w.proj, { approve: true });
        const pid = S.skillId(w.proj);
        const create = (target, skillName) => H.api(sk, 'POST', `/api/skills/create?project=${pid}`, { target, name: skillName, description: 'link test' });
        return { w, outside, sk, pid, create };
      };

      // .pi 本身是链接
      const a = linkWorld('link-pi', (w, outside) => {
        H.writeSkill(path.join(outside, 'skills'), 'outside-skill');
        H.linkDir(outside, path.join(w.proj, '.pi'));
      });
      const aList = await H.getList(a.sk, a.pid);
      const aTarget = aList.targets.find((t) => t.key === 'project-pi');
      const aBefore = H.snapshotTree(a.outside);
      check('G1. 项目的 .pi 是一个链接 → 这个写入目标不可用，并说明原因', aTarget.writable === false && aTarget.blockedCode === 'unsafe-root' && aTarget.blockedReason === '项目里的 .pi 是一个链接，无法保证它指向哪里，已拒绝写入', JSON.stringify(aTarget));
      check('G2. 往里新建 → 403 unsafe-root', outcome(await a.create('project-pi', 'through-link')) === '403:unsafe-root');
      const aSeen = H.findSkill(aList, 'outside-skill', 'project');
      check('G3. 经由链接看得到的技能：只读', Boolean(aSeen) && aSeen.manage.target === 'project-pi' && aSeen.manage.editable === false && aSeen.manage.deletable === false && /链接/.test(aSeen.manage.reason), JSON.stringify(aSeen && aSeen.manage));
      const aCodes = [
        outcome(await H.api(a.sk, 'DELETE', `/api/skills/${aSeen.id}?project=${a.pid}`)),
        outcome(await H.api(a.sk, 'PUT', `/api/skills/${aSeen.id}/source?project=${a.pid}`, { mode: 'raw', content: '---\ndescription: x\n---\n', baseHash: 'x' })),
      ];
      check('G4. 删除 / 保存它 → 403', aCodes.join(',') === '403:read-only,403:read-only', aCodes.join(','));
      check('G5. 链接指向的目录一个字节都没动', H.snapshotTree(a.outside) === aBefore);
      const aOther = await a.create('project-agents', 'unaffected');
      check('G6. 另一个项目级目标（.agents/skills）不受影响', aOther.code === 200 && fs.existsSync(path.join(a.w.proj, '.agents', 'skills', 'unaffected', 'SKILL.md')), outcome(aOther));

      // .pi/skills 是链接
      const b = linkWorld('link-pi-skills', (w, outside) => {
        H.writeSkill(outside, 'visible-one');
        fs.mkdirSync(path.join(w.proj, '.pi'));
        H.linkDir(outside, path.join(w.proj, '.pi', 'skills'));
      });
      const bList = await H.getList(b.sk, b.pid);
      const bTarget = bList.targets.find((t) => t.key === 'project-pi');
      const bBefore = H.snapshotTree(b.outside);
      check('G7. 项目的 .pi/skills 是一个链接 → 不可用', bTarget.writable === false && bTarget.blockedCode === 'unsafe-root' && bTarget.blockedReason === '项目里的 .pi/skills 是一个链接，无法保证它指向哪里，已拒绝写入', JSON.stringify(bTarget));
      const bSeen = H.findSkill(bList, 'visible-one', 'project');
      const bCodes = [outcome(await b.create('project-pi', 'through-link')), outcome(await H.api(b.sk, 'DELETE', `/api/skills/${bSeen.id}?project=${b.pid}`))];
      check('G8. 新建 / 删除 → 403，链接指向的目录不动', bCodes.join(',') === '403:unsafe-root,403:read-only' && H.snapshotTree(b.outside) === bBefore, bCodes.join(','));

      // .agents 是链接
      const c = linkWorld('link-agents', (w, outside) => {
        H.linkDir(outside, path.join(w.proj, '.agents'));
      });
      const cTarget = (await H.getList(c.sk, c.pid)).targets.find((t) => t.key === 'project-agents');
      check('G9. 项目的 .agents 是一个链接 → .agents/skills 不可用', cTarget.writable === false && cTarget.blockedCode === 'unsafe-root' && /\.agents 是一个链接/.test(cTarget.blockedReason), JSON.stringify(cTarget));
      check('G10. 往里新建 → 403，链接指向的目录里什么都没多', outcome(await c.create('project-agents', 'through-link')) === '403:unsafe-root' && H.listDir(c.outside).length === 0);

      // .pi 的位置上是个文件
      const d = linkWorld('pi-is-file', (w) => {
        fs.writeFileSync(path.join(w.proj, '.pi'), 'not a directory');
      });
      const dTarget = (await H.getList(d.sk, d.pid)).targets.find((t) => t.key === 'project-pi');
      check('G11. 项目的 .pi 是个文件 → 不可用（不是目录）', dTarget.writable === false && dTarget.blockedCode === 'unsafe-root' && dTarget.blockedReason === '项目里的 .pi 不是目录', JSON.stringify(dTarget));

      // 全局技能目录是用户自己做的链接：允许（pi 也跟随它）
      const e = linkWorld('link-user-root', (w, outside) => {
        H.linkDir(outside, path.join(w.agent, 'skills'));
      });
      const eTarget = (await H.getList(e.sk, e.pid)).targets.find((t) => t.key === 'user-pi');
      const eMade = (await e.create('user-pi', 'via-link')).jsonBody();
      check('G12. 全局技能目录是用户自己的链接 → 允许，写到链接指向的地方', eTarget.writable === true && eMade.ok === true && fs.existsSync(path.join(e.outside, 'via-link', 'SKILL.md')), JSON.stringify(eTarget));
      const eRow = H.findSkill(await H.getList(e.sk, e.pid), 'via-link');
      const eSource = (await H.api(e.sk, 'GET', `/api/skills/${eRow.id}/source?project=${e.pid}`)).jsonBody();
      const eSaved = (await H.api(e.sk, 'PUT', `/api/skills/${eRow.id}/source?project=${e.pid}`, { mode: 'form', description: 'edited through the link', body: 'x', baseHash: eSource.hash })).jsonBody();
      check('G13. …那里的技能可以编辑', eRow.manage.editable === true && eSaved.ok === true && fs.readFileSync(path.join(e.outside, 'via-link', 'SKILL.md'), 'utf8').includes('edited through the link'), JSON.stringify(eSaved));
      const eRemoved = (await H.api(e.sk, 'DELETE', `/api/skills/${eRow.id}?project=${e.pid}`)).jsonBody();
      const eGone = !fs.existsSync(path.join(e.outside, 'via-link'));
      const eBack = await H.api(e.sk, 'POST', `/api/skills/undo/${eRemoved.undo}`);
      check('G14. …可以删除，也可以撤销', eRemoved.ok === true && eGone && eBack.code === 200 && fs.existsSync(path.join(e.outside, 'via-link', 'SKILL.md')), eBack.body());

      // SKILL.md 本身是符号链接
      const f = worlds.mkWorld('link-file');
      const realMd = path.join(f.base, 'real.md');
      fs.writeFileSync(realMd, '---\nname: sym-skill\ndescription: the file is a symlink\n---\n');
      if (H.tryLinkFile(realMd, path.join(f.agent, 'skills', 'sym-skill', 'SKILL.md'))) {
        const fsk = S.mkSkills(f, f.proj, { approve: true });
        const fpid = S.skillId(f.proj);
        const fRow = H.findSkill(await H.getList(fsk, fpid), 'sym-skill');
        const fCodes = [outcome(await H.api(fsk, 'GET', `/api/skills/${fRow.id}/source?project=${fpid}`)), outcome(await H.api(fsk, 'DELETE', `/api/skills/${fRow.id}?project=${fpid}`))];
        check('G15. SKILL.md 是符号链接 → 只读，原文件不动', same(fRow.manage, { target: 'user-pi', editable: false, deletable: false, reason: '它的技能文件是一个链接，请到原位置修改' })
          && fCodes.join(',') === '403:read-only,403:read-only' && fs.readFileSync(realMd, 'utf8').includes('the file is a symlink'), `${JSON.stringify(fRow.manage)} ${fCodes.join(',')}`);
      } else {
        skip('G15. SKILL.md 是符号链接 → 只读', '这台机器没有创建文件符号链接的权限（Windows 需要开发者模式或管理员）');
      }

      // 新建之后，技能目录被换成了指向别处的链接：撤销不能跟着链接去动别处
      const g = linkWorld('link-swap', (w, outside) => {
        H.writeSkill(outside, 'swap-me', { description: 'not ours' });
      });
      const gMade = (await g.create('project-pi', 'swap-me')).jsonBody();
      const realSkills = path.join(g.w.proj, '.pi', 'skills');
      fs.renameSync(realSkills, path.join(g.w.proj, '.pi', 'skills-moved'));
      H.linkDir(g.outside, realSkills);
      const gBefore = H.snapshotTree(g.outside);
      const gUndo = await H.api(g.sk, 'POST', `/api/skills/undo/${gMade.undo}`);
      check('G16. 新建后技能目录被换成链接 → 撤销拒绝（409 undo-blocked）', gMade.ok === true && outcome(gUndo) === '409:undo-blocked' && /链接/.test(gUndo.jsonBody().error), gUndo.body());
      check('G17. …链接指向的目录里那个同名技能一个字节都没动，回收站里也没东西', H.snapshotTree(g.outside) === gBefore && H.trashEntries(g.w, 'del-').length === 0);

      // 删除之后同样的事
      const h = linkWorld('link-swap-delete', (w) => {
        H.writeSkill(path.join(w.proj, '.pi', 'skills'), 'gone-then-back');
      });
      const hRow = H.findSkill(await H.getList(h.sk, h.pid), 'gone-then-back', 'project');
      const hRemoved = (await H.api(h.sk, 'DELETE', `/api/skills/${hRow.id}?project=${h.pid}`)).jsonBody();
      fs.renameSync(path.join(h.w.proj, '.pi', 'skills'), path.join(h.w.proj, '.pi', 'skills-moved'));
      H.linkDir(h.outside, path.join(h.w.proj, '.pi', 'skills'));
      const hUndo = await H.api(h.sk, 'POST', `/api/skills/undo/${hRemoved.undo}`);
      check('G18. 删除后技能目录被换成链接 → 撤销拒绝，不往链接指向的地方放东西；回收站里那份还在', hRemoved.ok === true && outcome(hUndo) === '409:undo-blocked' && H.listDir(h.outside).length === 0 && H.trashEntries(h.w, 'del-').length === 1, hUndo.body());

      // 编辑之后同样的事：链接目标里放一份内容相同的文件，撤销不能因此就写过去
      const i = linkWorld('link-swap-edit', (w) => {
        H.writeSkill(path.join(w.proj, '.pi', 'skills'), 'edit-then-swap', { description: 'before the edit' });
      });
      const iRow = H.findSkill(await H.getList(i.sk, i.pid), 'edit-then-swap', 'project');
      const iSource = (await H.api(i.sk, 'GET', `/api/skills/${iRow.id}/source?project=${i.pid}`)).jsonBody();
      const iSaved = (await H.api(i.sk, 'PUT', `/api/skills/${iRow.id}/source?project=${i.pid}`, { mode: 'form', description: 'after the edit', body: 'x', baseHash: iSource.hash })).jsonBody();
      const iReal = path.join(i.w.proj, '.pi', 'skills');
      const iEdited = fs.readFileSync(path.join(iReal, 'edit-then-swap', 'SKILL.md'));
      fs.renameSync(iReal, path.join(i.w.proj, '.pi', 'skills-moved'));
      fs.mkdirSync(path.join(i.outside, 'edit-then-swap'), { recursive: true });
      fs.writeFileSync(path.join(i.outside, 'edit-then-swap', 'SKILL.md'), iEdited);
      H.linkDir(i.outside, iReal);
      const iBefore = H.snapshotTree(i.outside);
      const iUndo = await H.api(i.sk, 'POST', `/api/skills/undo/${iSaved.undo}`);
      check('G19. 保存后技能目录被换成链接 → 撤销拒绝（即便链接目标内容碰巧相同）', iSaved.ok === true && outcome(iUndo) === '409:undo-blocked' && /链接/.test(iUndo.jsonBody().error), iUndo.body());
      check('G20. …链接指向的那份一个字节都没动，编辑前的备份还在回收站里', H.snapshotTree(i.outside) === iBefore && H.trashEntries(i.w, 'edit-').length === 1);
    }

    /* ============================================================ */
    section('I. 写操作串行执行：并发的请求不会交错');
    {
      const w = worlds.mkWorld('serial');
      const userRoot = path.join(w.agent, 'skills');
      const sk = S.mkSkills(w, w.proj, { approve: true });
      const pid = S.skillId(w.proj);
      const create = (description) => H.api(sk, 'POST', `/api/skills/create?project=${pid}`, { target: 'user-pi', name: 'race', description });

      const [c1, c2] = await Promise.all([create('first writer'), create('second writer')]);
      const file = path.join(userRoot, 'race', 'SKILL.md');
      const winner = c1.code === 200 ? 'first writer' : 'second writer';
      check('I1. 两个同名的新建同时到达 → 一个成功，一个 409 exists', [outcome(c1), outcome(c2)].sort().join(',') === '200:,409:exists', `${outcome(c1)} / ${outcome(c2)}`);
      check('I2. 落盘的是成功的那一个，完整无缺', fs.readFileSync(file, 'utf8') === `---\nname: race\ndescription: ${winner}\n---\n` && leftovers(userRoot).length === 0, fs.readFileSync(file, 'utf8'));

      const id = S.skillId(file);
      const SOURCE = `/api/skills/${id}/source?project=${pid}`;
      const baseHash = H.sha256(fs.readFileSync(file));
      const versionA = '---\nname: race\ndescription: saved by A\n---\n';
      const versionB = '---\nname: race\ndescription: saved by B\n---\n';
      const [s1, s2] = await Promise.all([
        H.api(sk, 'PUT', SOURCE, { mode: 'raw', content: versionA, baseHash }),
        H.api(sk, 'PUT', SOURCE, { mode: 'raw', content: versionB, baseHash }),
      ]);
      check('I3. 两个编辑器基于同一版本同时保存 → 一个成功，另一个 409（不会悄悄盖掉对方）', [outcome(s1), outcome(s2)].sort().join(',') === '200:,409:changed-on-disk', `${outcome(s1)} / ${outcome(s2)}`);
      check('I4. 文件是成功那次的内容，备份正好一份', fs.readFileSync(file, 'utf8') === (s1.code === 200 ? versionA : versionB) && H.trashEntries(w, 'edit-').length === 1 && leftovers(path.dirname(file)).length === 0);

      const savedText = fs.readFileSync(file, 'utf8');
      const versionC = '---\nname: race\ndescription: saved while being deleted\n---\n';
      const [removed, saved] = await Promise.all([
        H.api(sk, 'DELETE', `/api/skills/${id}?project=${pid}`),
        H.api(sk, 'PUT', SOURCE, { mode: 'raw', content: versionC, baseHash: H.sha256(Buffer.from(savedText)) }),
      ]);
      const trashed = H.trashEntries(w, 'del-');
      const trashedText = trashed.length === 1 ? fs.readFileSync(path.join(H.trashPayload(w, trashed[0]), 'SKILL.md'), 'utf8') : '';
      check('I5. 删除与保存同时到达 → 都得到明确的结果，没有 5xx', removed.code === 200 && (outcome(saved) === '404:not-found' || saved.code === 200), `${outcome(removed)} / ${outcome(saved)}`);
      check('I6. 无论谁先：技能已删除，回收站里是删除那一刻的完整内容', !fs.existsSync(path.dirname(file)) && trashedText === (saved.code === 200 ? versionC : savedText), JSON.stringify(trashedText));
    }

    /* ============================================================ */
    section('I2. 先到先办：后到的请求不能抢在前面');
    {
      /* 上面几条在两种先后顺序下都成立，证明不了「排队」本身。这里把顺序钉死：
       * 先到的请求停在「建索引」那一步（一道由测试打开的闸门），后到的请求有一整轮事件循环可以抢跑，
       * 然后才放行。排着队的话后到的那个根本还没开始；不排队的话它已经把事情办完了。
       * 用闸门而不是定时器 —— 判据是「谁先到」，不是「谁跑得快」。 */
      const w = worlds.mkWorld('fifo');
      const userRoot = path.join(w.agent, 'skills');
      const sk = S.mkSkills(w, w.proj, { approve: true });
      const core = S.realCore(sk, { running: false, approve: true });
      const buildIndex = core.buildIndex;
      let gate = null;
      let openGate = () => {};
      core.buildIndex = async (context) => {
        const waitFor = gate;
        gate = null;
        if (waitFor) await waitFor;
        return buildIndex(context);
      };
      const manager = createSkillsManager({ core, dataDir: w.data });
      const ctx = { cwd: w.proj, live: true, explicit: true };
      const inOrder = async (first, second) => {
        gate = new Promise((resolve) => { openGate = resolve; });
        const a = first();
        const b = second();
        await new Promise((resolve) => setImmediate(resolve));
        openGate();
        return Promise.all([a, b]);
      };
      const md = (name, tag) => `---\nname: ${name}\ndescription: ${tag}\n---\n`;
      const pack = (name, tag) => [{ path: 'SKILL.md', bytes: Buffer.from(md(name, tag)), executable: false }];
      const read = (name) => fs.readFileSync(path.join(userRoot, name, 'SKILL.md'), 'utf8');

      const [c1, c2] = await inOrder(
        () => manager.create(ctx, { target: 'user-pi', name: 'fifo-new', description: 'first caller' }),
        () => manager.create(ctx, { target: 'user-pi', name: 'fifo-new', description: 'second caller' }),
      );
      check('I7. 两个同名的新建：先到的成功，后到的 409 exists', verdict(c1) === 'ok' && verdict(c2) === '409:exists' && read('fifo-new') === md('fifo-new', 'first caller'), `${verdict(c1)} / ${verdict(c2)}`);

      const [p1, p2] = await inOrder(
        () => manager.install(ctx, { targetKey: 'user-pi', name: 'fifo-pack', files: pack('fifo-pack', 'first caller') }),
        () => manager.install(ctx, { targetKey: 'user-pi', name: 'fifo-pack', files: pack('fifo-pack', 'second caller') }),
      );
      check('I8. 两个同名的安装：先到的成功，后到的 409 exists', verdict(p1) === 'ok' && verdict(p2) === '409:exists' && read('fifo-pack') === md('fifo-pack', 'first caller'), `${verdict(p1)} / ${verdict(p2)}`);

      const file = H.writeSkill(userRoot, 'fifo-edit', { raw: md('fifo-edit', 'base') });
      const id = S.skillId(file);
      const baseHash = H.sha256(fs.readFileSync(file));
      const [s1, s2] = await inOrder(
        () => manager.saveSource(ctx, id, { mode: 'raw', content: md('fifo-edit', 'saved first'), baseHash }),
        () => manager.saveSource(ctx, id, { mode: 'raw', content: md('fifo-edit', 'saved second'), baseHash }),
      );
      check('I9. 两次基于同一版本的保存：先到的成功，后到的 409 changed-on-disk', verdict(s1) === 'ok' && verdict(s2) === '409:changed-on-disk'
        && read('fifo-edit') === md('fifo-edit', 'saved first') && H.trashEntries(w, 'edit-').length === 1, `${verdict(s1)} / ${verdict(s2)}`);

      const [removed, lateSave] = await inOrder(
        () => manager.remove(ctx, id),
        () => manager.saveSource(ctx, id, { mode: 'raw', content: md('fifo-edit', 'saved after delete'), baseHash: s1.hash }),
      );
      const trashed = H.trashEntries(w, 'del-');
      check('I10. 先删除、后保存：保存看到的是「已经没有了」（404），而不是存进一个随后被删掉的文件', verdict(removed) === 'ok' && verdict(lateSave) === '404:not-found'
        && !fs.existsSync(path.dirname(file)) && trashed.length === 1
        && fs.readFileSync(path.join(H.trashPayload(w, trashed[0]), 'SKILL.md'), 'utf8') === md('fifo-edit', 'saved first'), `${verdict(removed)} / ${verdict(lateSave)}`);

      const [taker, lateUndo] = await inOrder(
        () => manager.create(ctx, { target: 'user-pi', name: 'fifo-edit', description: 'took the place' }),
        () => manager.undo(removed.undo),
      );
      check('I11. 先新建同名技能、后撤销删除：新建成功，撤销 409 exists（不会抢先放回去让新建扑空）', verdict(taker) === 'ok' && verdict(lateUndo) === '409:exists'
        && read('fifo-edit') === md('fifo-edit', 'took the place') && H.trashEntries(w, 'del-').length === 1, `${verdict(taker)} / ${verdict(lateUndo)}`);
      check('I12. 整个过程没有残留临时文件', leftovers(userRoot).length === 0 && leftovers(path.join(userRoot, 'fifo-edit')).length === 0, leftovers(userRoot).join(','));
    }
  } catch (err) {
    check('套件运行中没有未捕获的异常', false, err && err.stack ? err.stack : String(err));
  } finally {
    worlds.cleanup();
    finish();
  }
})();
