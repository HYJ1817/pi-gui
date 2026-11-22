/* 技能管理（一）：项目上下文、新建、项目信任闸、不落盘的校验、路由层防线。
 *
 * 编辑 / 删除 / 撤销 / 冲突 / 链接在 tests/skills-manage-edit.cjs，
 * 落盘原语在 tests/skills-files.cjs。
 *
 * 纪律与 tests/skills.cjs 一致：全部在 os.tmpdir() 里造世界（独立的 home、agentDir、
 * 项目、数据目录），不 spawn、不联网、不碰任何真实技能目录。每个 fixture 项目都有 `.git`，
 * 把「祖先 .agents/skills」的扫描钉在项目内。
 *
 * 关于「项目信任」的环境差异（判据要挑身份，不要挑环境）：
 *   pi 判定「项目里有没有需要信任的资源」时会一路查到文件系统根。Windows 上 os.tmpdir()
 *   在真实主目录之下，开发机的 ~/.agents/skills 存在时，每个 fixture 项目都会被判成
 *   「有资源」；CI 上则没有。所以这里凡是要确定结论的用例，都用与环境无关的手段固定信任
 *   状态（approve 标志、trust.json、defaultProjectTrust、注入的 core）；唯一依赖环境的
 *   一段（B2-e）按实际读到的状态分支，两个分支的断言条数相同。
 *
 * 跑法：node tests/skills-manage.cjs */
const fs = require('node:fs');
const path = require('node:path');
const H = require('./fixtures/skills-harness.cjs');

const { check, section, finish } = H.createChecker();
const worlds = H.createWorlds('pi-gui-skills-manage-');

const HEX16 = /^[0-9a-f]{16}$/;
const HEX24 = /^[0-9a-f]{24}$/;
/** 「状态码:业务码」，断言失败时一眼看出实际拿到了什么。 */
const outcome = (res) => `${res.code}:${(res.jsonBody() || {}).code || ''}`;
const tempNames = (dir) => H.listDir(dir).filter((name) => name.startsWith('.pi-gui-'));

(async () => {
  const S = await H.loadSkillsServer();
  const { createSkillsManager } = S;
  const routesModule = await import('../server/skills-routes.js');
  const post = (sk, url, body) => H.api(sk, 'POST', url, body);

  try {
    /* ============================================================ */
    section('A. 项目上下文：?project= 只换查看 / 管理的对象，不切换工作区');
    {
      const w = worlds.mkWorld('context');
      const proj2 = path.join(w.base, 'proj2');
      fs.mkdirSync(path.join(proj2, '.git'), { recursive: true });
      const userFile = H.writeSkill(path.join(w.agent, 'skills'), 'user-one');
      H.writeSkill(path.join(proj2, '.pi', 'skills'), 'p2-skill');
      const rpc = H.mkRpc([{ name: 'user-one', path: userFile }]);
      const projects = [{ path: w.proj, name: '主项目' }, { path: proj2, name: '另一个项目' }];
      const sk = S.mkSkills(w, w.proj, { rpc, approve: true, projects });
      const pid = S.skillId(w.proj);
      const pid2 = S.skillId(proj2);

      const base = await H.getList(sk);
      check('A1. 不带参数：上下文就是当前工作区，且是 live', base.ok === true && base.context.project === pid && HEX16.test(pid) && base.context.live === true, JSON.stringify(base.context));
      check('A2. 项目列表带名字与「是否当前」', base.projects.map((p) => `${p.name}:${p.active}`).join(',') === '主项目:true,另一个项目:false', JSON.stringify(base.projects));
      check('A3. 项目列表的 ID 是 16 位十六进制，与路径一一对应', base.projects.map((p) => p.id).join(',') === `${pid},${pid2}` && base.projects[1].path === proj2);
      check('A4. 写入目标只有四个，按 key 给出',
        base.targets.map((t) => `${t.key}|${t.scope}|${t.label}`).join(' ')
          === 'user-pi|user|~/.pi/agent/skills user-agents|user|~/.agents/skills project-pi|project|<项目>/.pi/skills project-agents|project|<项目>/.agents/skills',
        base.targets.map((t) => `${t.key}|${t.scope}|${t.label}`).join(' '));
      check('A5. 写入目标的实际目录由服务端决定', base.targets[0].dir === path.join(w.agent, 'skills') && base.targets[1].dir === path.join(w.home, '.agents', 'skills')
        && base.targets[2].dir === path.join(w.proj, '.pi', 'skills') && base.targets[3].dir === path.join(w.proj, '.agents', 'skills'));
      check('A6. 目录存在与否如实给出，都可写', base.targets.map((t) => `${t.exists}:${t.writable}`).join(',') === 'true:true,false:true,false:true,false:true', base.targets.map((t) => `${t.exists}:${t.writable}`).join(','));
      const userOne = H.findSkill(base, 'user-one');
      check('A7. 全局技能带可管理标记', JSON.stringify(userOne.manage) === JSON.stringify({ target: 'user-pi', editable: true, deletable: true, reason: '' }), JSON.stringify(userOne.manage));
      check('A8. live 上下文向 pi 问了加载状态', userOne.loaded === true && userOne.state === 'enabled' && rpc.calls.get_commands === 1, `${userOne.loaded}/${userOne.state}/${rpc.calls.get_commands}`);
      check('A9. 回收站可用', base.trashAvailable === true);

      for (const bad of ['..%2F..', 'XYZ', pid.toUpperCase(), `${pid}0`, pid.slice(1), '%00', 'none%20']) {
        const res = await H.api(sk, 'GET', `/api/skills?project=${bad}`);
        check(`A10. project=${bad} → 400 bad-project`, outcome(res) === '400:bad-project', outcome(res));
      }
      const stray = path.join(w.base, 'stray');
      fs.mkdirSync(stray);
      const gone = await H.api(sk, 'GET', `/api/skills?project=${S.skillId(stray)}`);
      check('A11. 磁盘上存在、但没登记过的目录 → 409 project-gone（ID 不是路径的后门）', outcome(gone) === '409:project-gone', outcome(gone));

      const before = rpc.calls.get_commands;
      const none = await H.getList(sk, 'none');
      check('A12. project=none：没有项目的视图', none.context.project === 'none' && none.context.live === false && none.hasProject === false, JSON.stringify(none.context));
      check('A13. project=none：只有全局写入目标', none.targets.map((t) => t.key).join(',') === 'user-pi,user-agents');
      const other = await H.getList(sk, pid2);
      check('A14. 另一个项目：不是 live，cwd 是那个项目', other.context.project === pid2 && other.context.live === false && other.cwd === proj2, JSON.stringify(other.context));
      check('A15. 非 live 的上下文不向 pi 问加载状态', rpc.calls.get_commands === before, `${before} → ${rpc.calls.get_commands}`);
      const otherUser = H.findSkill(other, 'user-one');
      check('A16. 非 live：加载状态如实标为未知', otherUser.loaded === null && otherUser.state === 'unknown' && /不是 pi 正在运行的那个工作区/.test(otherUser.stateNote), `${otherUser.loaded}/${otherUser.state}/${otherUser.stateNote}`);
      const p2 = H.findSkill(other, 'p2-skill', 'project');
      check('A17. 另一个项目的项目级技能列得出来、可管理', Boolean(p2) && p2.manage.target === 'project-pi' && p2.manage.editable === true, JSON.stringify(p2 && p2.manage));
      check('A18. 另一个项目的写入目标指向它自己', other.targets.find((t) => t.key === 'project-pi').dir === path.join(proj2, '.pi', 'skills'));
      check('A19. 当前工作区的列表里没有另一个项目的技能', !H.findSkill(base, 'p2-skill'));
      const explicit = await H.getList(sk, pid);
      check('A20. 显式传当前项目的 ID：仍是 live，会问 pi', explicit.context.live === true && rpc.calls.get_commands === before + 1 && H.findSkill(explicit, 'user-one').loaded === true);

      const detailOther = await H.api(sk, 'GET', `/api/skills/${p2.id}?project=${pid2}`);
      check('A21. 详情跟着上下文走', detailOther.code === 200 && detailOther.jsonBody().skill.name === 'p2-skill', String(detailOther.code));
      const detailHere = await H.api(sk, 'GET', `/api/skills/${p2.id}`);
      check('A22. 同一个 ID 在当前工作区的上下文里查不到', detailHere.code === 404, String(detailHere.code));

      const toggled = await H.api(sk, 'PUT', `/api/skills/${p2.id}?project=${pid2}`, { enabled: false });
      const toggledBody = toggled.jsonBody();
      check('A23. 在另一个项目里停用：写的是它自己的 settings.json', toggled.code === 200 && toggledBody.changed === true && toggledBody.path === path.join(proj2, '.pi', 'settings.json')
        && JSON.stringify(JSON.parse(fs.readFileSync(path.join(proj2, '.pi', 'settings.json'), 'utf8')).skills) === '["-skills/p2-skill/SKILL.md"]', JSON.stringify(toggledBody));
      check('A24. 另一个项目的启停不需要重启正在运行的 pi', toggledBody.restartRequired === false && /下次在这个项目里启动 pi 时生效/.test(toggledBody.note), JSON.stringify(toggledBody));
      check('A25. 停用后那个项目的列表里它是 disabled', H.findSkill(await H.getList(sk, pid2), 'p2-skill').state === 'disabled');
      const toggledUser = (await H.api(sk, 'PUT', `/api/skills/${userOne.id}?project=${pid2}`, { enabled: false })).jsonBody();
      check('A26. 在别的上下文里停用全局技能：仍然要重启 pi', toggledUser.changed === true && toggledUser.restartRequired === true, JSON.stringify(toggledUser));

      // 没有当前项目
      const idle = S.mkSkills(w, null, { rpc: H.mkRpc([]), projects });
      const idleList = await H.getList(idle);
      check('A27. 没有当前项目：上下文是 none 且是 live', idleList.context.project === 'none' && idleList.context.live === true && idleList.projects.every((p) => p.active === false), JSON.stringify(idleList.context));
      check('A28. 没有当前项目时显式传 none 也是 live', (await H.getList(idle, 'none')).context.live === true);
      check('A29. 没登记任何项目、也没有当前项目 → 项目列表为空', (await H.getList(S.mkSkills(w, null))).projects.length === 0);

      // 项目列表去重与兜底
      const messy = S.mkSkills(w, w.proj, {
        approve: true,
        projects: [{ path: w.proj, name: 'A' }, { path: w.proj + path.sep, name: '重复' }, { path: 'relative/path', name: '相对路径' }, { path: 42 }, null, { path: proj2 }],
      });
      const messyList = await H.getList(messy);
      check('A30. 重复、相对路径、非字符串的项目被忽略；没有名字的用目录名', messyList.projects.map((p) => p.name).join(',') === 'A,proj2', messyList.projects.map((p) => p.name).join(','));
      const broken = S.mkSkills(w, w.proj, { approve: true, projects: () => { throw new Error('boom'); } });
      const brokenList = await H.getList(broken);
      check('A31. 项目列表读不出来时只剩当前工作区', brokenList.ok === true && brokenList.projects.length === 1 && brokenList.projects[0].active === true && brokenList.projects[0].name === 'proj', JSON.stringify(brokenList.projects));
      const unlisted = await H.getList(S.mkSkills(w, proj2, { approve: true, projects: [{ path: w.proj, name: '主项目' }] }));
      check('A32. 当前工作区没登记过也会出现在项目列表里', unlisted.projects.map((p) => `${p.name}:${p.active}`).join(',') === '主项目:false,proj2:true', JSON.stringify(unlisted.projects));

      // 主目录本身就是项目：它的 .agents/skills 就是全局那个，不重复列
      const hw = worlds.mkWorld('home-project');
      fs.mkdirSync(path.join(hw.home, '.git'), { recursive: true });
      const homeList = await H.getList(S.mkSkills(hw, hw.home, { approve: true }));
      check('A33. 项目就是主目录时不重复列 .agents/skills', homeList.targets.map((t) => t.key).join(',') === 'user-pi,user-agents,project-pi', homeList.targets.map((t) => t.key).join(','));
    }

    /* ============================================================ */
    section('B. 新建技能');
    {
      const w = worlds.mkWorld('create');
      const rpc = H.mkRpc([]);
      const sk = S.mkSkills(w, w.proj, { rpc, approve: true });
      const pid = S.skillId(w.proj);
      const CREATE = `/api/skills/create?project=${pid}`;
      const userRoot = path.join(w.agent, 'skills');

      const made = await post(sk, CREATE, { target: 'user-pi', name: 'my-skill', description: 'Review source code for bugs', body: '# Title\r\n\r\nBody text\n\n\n' });
      const madeBody = made.jsonBody();
      const file = path.join(userRoot, 'my-skill', 'SKILL.md');
      check('B1. 新建成功', made.code === 200 && madeBody.ok === true, `${outcome(made)} ${made.body().slice(0, 200)}`);
      check('B2. SKILL.md 是标准写法：frontmatter + 空行 + 正文，换行统一为 LF、结尾一个换行',
        fs.readFileSync(file, 'utf8') === '---\nname: my-skill\ndescription: Review source code for bugs\n---\n\n# Title\n\nBody text\n', JSON.stringify(fs.existsSync(file) && fs.readFileSync(file, 'utf8')));
      check('B3. 响应说明装到了哪', madeBody.name === 'my-skill' && madeBody.scope === 'user' && madeBody.target === 'user-pi' && madeBody.targetLabel === '~/.pi/agent/skills'
        && madeBody.fileCount === 1 && madeBody.renamed === false && madeBody.replaced === false && madeBody.notice === '' && madeBody.warnings.length === 0, JSON.stringify(madeBody));
      check('B4. 响应带技能 ID 与撤销令牌', madeBody.id === S.skillId(file) && HEX16.test(madeBody.id) && HEX24.test(madeBody.undo), `${madeBody.id} / ${madeBody.undo}`);
      check('B5. pi 在运行 → 全局技能要重启才生效', madeBody.restartRequired === true);
      check('B6. 技能目录里只有 SKILL.md，根目录里没有临时目录', H.listDir(path.dirname(file)).join(',') === 'SKILL.md' && tempNames(userRoot).length === 0, H.listDir(userRoot).join(','));
      const listed = H.findSkill(await H.getList(sk, pid), 'my-skill');
      check('B7. 列表里出现，ID 一致，可编辑可删除', Boolean(listed) && listed.id === madeBody.id && listed.manage.editable === true && listed.manage.deletable === true && listed.description === 'Review source code for bugs', JSON.stringify(listed && listed.manage));

      const idleSk = S.mkSkills(w, w.proj, { rpc: H.mkRpc([], { running: false }), approve: true });
      const quiet = (await post(idleSk, CREATE, { target: 'user-pi', name: 'while-idle', description: 'pi is not running' })).jsonBody();
      check('B8. pi 没在运行 → 不需要重启', quiet.ok === true && quiet.restartRequired === false, JSON.stringify(quiet));
      const noRpc = (await post(S.mkSkills(w, w.proj, { approve: true }), CREATE, { target: 'user-pi', name: 'without-rpc', description: 'no rpc at all' })).jsonBody();
      check('B9. 没有 rpc → 不需要重启', noRpc.ok === true && noRpc.restartRequired === false);
      check('B10. 正文留空也能建：只有 frontmatter', fs.readFileSync(path.join(userRoot, 'while-idle', 'SKILL.md'), 'utf8') === '---\nname: while-idle\ndescription: pi is not running\n---\n');

      // 描述里有 YAML 的特殊字符：写出去再读回来必须一字不差（列表与编辑器两条读取路径都要对）
      const tricky = [
        'Use when: the user says "hello" # not a comment',
        'C:\\Users\\me\\docs and \\n literal',
        'true',
        '12345',
        '- leading dash',
        '中文描述：带全角冒号和「引号」',
        "it's a 'quoted' thing",
        '[brackets] {braces} &anchor *alias !tag',
        '> folded? | literal?',
        '@at and `backtick`',
        'null',
        'ends with colon:',
      ];
      for (let n = 0; n < tricky.length; n += 1) {
        const description = tricky[n];
        const res = (await post(sk, CREATE, { target: 'user-pi', name: `yaml-${n}`, description, body: 'x' })).jsonBody();
        const source = res.ok ? (await H.api(sk, 'GET', `/api/skills/${res.id}/source?project=${pid}`)).jsonBody() : {};
        const inList = H.findSkill(await H.getList(sk, pid), `yaml-${n}`);
        check(`B11. 描述 ${JSON.stringify(description)} 原样读回（编辑器 + 列表）`, res.ok === true && source.form && source.form.available === true && source.form.description === description && inList && inList.description === description,
          JSON.stringify({ ok: res.ok, form: source.form && source.form.description, list: inList && inList.description }));
      }
      check('B12. 需要引号的描述写成 JSON 风格的双引号', fs.readFileSync(path.join(userRoot, 'yaml-0', 'SKILL.md'), 'utf8').split('\n')[2] === 'description: "Use when: the user says \\"hello\\" # not a comment"', fs.readFileSync(path.join(userRoot, 'yaml-0', 'SKILL.md'), 'utf8').split('\n')[2]);
      check('B13. 会被 YAML 读成布尔 / 数字的描述加了引号', fs.readFileSync(path.join(userRoot, 'yaml-2', 'SKILL.md'), 'utf8').includes('description: "true"') && fs.readFileSync(path.join(userRoot, 'yaml-3', 'SKILL.md'), 'utf8').includes('description: "12345"'));
      const folded = (await post(sk, CREATE, { target: 'user-pi', name: 'folded', description: 'line one\nline two\ttabbed   spaced ', body: 'x' })).jsonBody();
      check('B14. 描述里的换行与连续空白收成单个空格', folded.ok === true && fs.readFileSync(path.join(userRoot, 'folded', 'SKILL.md'), 'utf8').includes('\ndescription: line one line two tabbed spaced\n'));

      // 不合法的输入：一律 400，磁盘上什么都不多
      const beforeInvalid = H.snapshotTree(w.base);
      const badNames = ['', '   ', 'Bad Name', 'UPPER', '-lead', 'trail-', 'a--b', 'x'.repeat(65), '../evil', '..', 'a/b', 'a\\b', '.hidden', 'con', 'nul', 'com1', 'lpt9', '技能', 'under_score', 42, null, ['a']];
      for (const name of badNames) {
        const res = await post(sk, CREATE, { target: 'user-pi', name, description: 'fine' });
        const body = res.jsonBody() || {};
        const shown = typeof name === 'string' && name.length > 20 ? `${name.slice(0, 8)}…（${name.length} 字符）` : JSON.stringify(name);
        check(`B15. 名称 ${shown} → 400 invalid（name）`, outcome(res) === '400:invalid' && Array.isArray(body.errors) && body.errors.length > 0 && body.errors.every((entry) => entry.field === 'name'), `${outcome(res)} ${JSON.stringify(body.errors)}`);
      }
      for (const description of ['', '   ', '\n\t', undefined, 42, null]) {
        const res = await post(sk, CREATE, { target: 'user-pi', name: 'no-desc', description });
        check(`B16. 描述 ${JSON.stringify(description)} → 400 invalid（description）`, outcome(res) === '400:invalid' && res.jsonBody().errors[0].field === 'description', outcome(res));
      }
      const longDesc = await post(sk, CREATE, { target: 'user-pi', name: 'long-desc', description: 'd'.repeat(1025) });
      check('B17. 描述超过 1024 字符 → 400', outcome(longDesc) === '400:invalid' && /描述超过 1024 字符（1025）/.test(longDesc.jsonBody().error), longDesc.body().slice(0, 160));
      const okDesc = (await post(sk, '/api/skills/check', { kind: 'create', name: 'edge-desc', description: 'd'.repeat(1024) })).jsonBody();
      check('B18. 描述正好 1024 字符 → 通过', okDesc.ok === true && okDesc.errors.length === 0);
      const nulBody = await post(sk, CREATE, { target: 'user-pi', name: 'nul-body', description: 'fine', body: 'a\x00b' });
      check('B19. 正文里有空字符 → 400（body）', outcome(nulBody) === '400:invalid' && nulBody.jsonBody().errors[0].field === 'body', outcome(nulBody));
      const bigBody = await post(sk, CREATE, { target: 'user-pi', name: 'big-body', description: 'fine', body: 'x'.repeat(S.MAX_SKILL_BYTES) });
      check('B20. 内容超过 256 KB → 400（body）', outcome(bigBody) === '400:invalid' && /内容超过 256 KB/.test(bigBody.jsonBody().error), bigBody.body().slice(0, 160));
      for (const body of [42, ['x'], { text: 'x' }, true]) {
        const res = await post(sk, CREATE, { target: 'user-pi', name: 'odd-body', description: 'fine', body });
        check(`B21. 正文是 ${JSON.stringify(body)} → 400（body）`, outcome(res) === '400:invalid' && res.jsonBody().errors[0].field === 'body', outcome(res));
      }
      for (const target of ['nope', '', '../../x', w.base, userRoot, '__proto__', 'constructor', 'toString', 42, null, undefined, ['user-pi']]) {
        const res = await post(sk, CREATE, { target, name: 'bad-target', description: 'fine' });
        const shown = typeof target === 'string' && target.length > 24 ? '<绝对路径>' : JSON.stringify(target);
        check(`B22. 保存位置 ${shown} → 400 bad-target`, outcome(res) === '400:bad-target', outcome(res));
      }
      const noProject = await post(sk, '/api/skills/create', { target: 'user-pi', name: 'no-project', description: 'fine' });
      check('B23. 不带 project → 400 project-required', outcome(noProject) === '400:project-required', outcome(noProject));
      const staleProject = await post(sk, `/api/skills/create?project=${S.skillId(path.join(w.base, 'never-registered'))}`, { target: 'user-pi', name: 'stale-project', description: 'fine' });
      check('B24. project 指向没登记过的目录 → 409 project-gone', outcome(staleProject) === '409:project-gone', outcome(staleProject));
      for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
        const res = await H.api(sk, method, CREATE, method === 'GET' || method === 'DELETE' ? undefined : {});
        check(`B25. ${method} /api/skills/create → 405`, outcome(res) === '405:method-not-allowed', outcome(res));
      }
      check('B26. 请求体不是 JSON → 400', outcome(await post(sk, CREATE, '{not json')) === '400:bad-request');
      check('B27. 请求体是数组 → 400', outcome(await post(sk, CREATE, '[1,2]')) === '400:bad-request');
      check('B28. 请求体是 JSON 字面量 → 400', outcome(await post(sk, CREATE, 'null')) === '400:bad-request');
      check('B29. 请求体为空 → 按空对象处理，报缺名称', outcome(await post(sk, CREATE, '')) === '400:invalid');
      const dup = await post(sk, CREATE, { target: 'user-pi', name: 'my-skill', description: 'second one' });
      const conflict = (dup.jsonBody() || {}).conflict || {};
      check('B30. 同名已存在 → 409 exists，并给出备用名', outcome(dup) === '409:exists' && conflict.name === 'my-skill' && conflict.target === 'user-pi' && conflict.replaceable === true && conflict.suggestion === 'my-skill-2', JSON.stringify(dup.jsonBody()));
      check('B31. 以上全部失败的请求没有在磁盘上留下任何东西（连修改时间都没变）', H.snapshotTree(w.base) === beforeInvalid);

      const padded = (await post(sk, CREATE, { target: 'user-pi', name: '  padded-name  ', description: 'trim me' })).jsonBody();
      check('B32. 名称两端的空白被去掉', padded.ok === true && padded.name === 'padded-name' && fs.existsSync(path.join(userRoot, 'padded-name', 'SKILL.md')));

      const twin = (await post(sk, CREATE, { target: 'user-agents', name: 'my-skill', description: 'same name, other root' })).jsonBody();
      check('B33. 另一个根目录里建同名技能：允许，但提示会被覆盖', twin.ok === true && twin.target === 'user-agents' && twin.warnings.length === 1 && /已有同名技能「my-skill」（~\/\.pi\/agent\/skills）/.test(twin.warnings[0]), JSON.stringify(twin));
      check('B34. 它落在 ~/.agents/skills 里（目录不存在时会建出来）', fs.existsSync(path.join(w.home, '.agents', 'skills', 'my-skill', 'SKILL.md')));

      // 撤销新建
      const undoable = (await post(sk, CREATE, { target: 'user-pi', name: 'undo-me', description: 'to be undone', body: 'keep this text' })).jsonBody();
      const undoDir = path.join(userRoot, 'undo-me');
      const createdText = fs.readFileSync(path.join(undoDir, 'SKILL.md'), 'utf8');
      const undone = await H.api(sk, 'POST', `/api/skills/undo/${undoable.undo}`);
      const undoneBody = undone.jsonBody();
      check('B35. 撤销新建成功', undone.code === 200 && undoneBody.ok === true && undoneBody.kind === 'install' && undoneBody.name === 'undo-me' && undoneBody.restored === false && undoneBody.restartRequired === true, undone.body());
      check('B36. 撤销后技能目录消失', !fs.existsSync(undoDir));
      const trashed = H.trashEntries(w, 'del-');
      const trashMeta = trashed.length === 1 ? H.readTrashMeta(w, trashed[0]) : null;
      check('B37. 撤销不是真删：内容进了回收站', trashed.length === 1 && trashMeta && trashMeta.reason === 'undo-install' && trashMeta.originalPath === undoDir && trashMeta.name === 'undo-me'
        && fs.readFileSync(path.join(H.trashPayload(w, trashed[0]), 'SKILL.md'), 'utf8') === createdText, JSON.stringify(trashMeta));
      const again = await H.api(sk, 'POST', `/api/skills/undo/${undoable.undo}`);
      check('B38. 同一个令牌再撤一次 → 410 undo-expired', outcome(again) === '410:undo-expired', outcome(again));
      check('B39. 令牌格式不对 → 400', outcome(await H.api(sk, 'POST', '/api/skills/undo/..%2F..%2Fx')) === '400:bad-request' && outcome(await H.api(sk, 'POST', '/api/skills/undo/abc')) === '400:bad-request');
      check('B40. 没发过的令牌 → 410', outcome(await H.api(sk, 'POST', `/api/skills/undo/${'0'.repeat(24)}`)) === '410:undo-expired');
      check('B41. GET 撤销 → 405', outcome(await H.api(sk, 'GET', `/api/skills/undo/${'0'.repeat(24)}`)) === '405:method-not-allowed');

      // 全局技能目录的位置上是个文件
      const fw = worlds.mkWorld('root-is-file');
      fs.writeFileSync(path.join(fw.agent, 'skills'), 'not a directory');
      const fsk = S.mkSkills(fw, fw.proj, { approve: true });
      const fpid = S.skillId(fw.proj);
      const flist = await H.getList(fsk, fpid);
      const userPi = flist.targets.find((t) => t.key === 'user-pi');
      check('B42. 技能目录的位置上是个文件 → 这个目标不可写，并说明原因', userPi.writable === false && userPi.blockedCode === 'root-unusable' && userPi.blockedReason === '~/.pi/agent/skills 不是目录', JSON.stringify(userPi));
      const blocked = await post(fsk, `/api/skills/create?project=${fpid}`, { target: 'user-pi', name: 'blocked', description: 'fine' });
      check('B43. 往它里面新建 → 403 root-unusable，那个文件原样', outcome(blocked) === '403:root-unusable' && fs.readFileSync(path.join(fw.agent, 'skills'), 'utf8') === 'not a directory', outcome(blocked));
      const elsewhere = (await post(fsk, `/api/skills/create?project=${fpid}`, { target: 'user-agents', name: 'elsewhere', description: 'fine' })).jsonBody();
      check('B44. 另一个全局目标不受影响', elsewhere.ok === true && fs.existsSync(path.join(fw.home, '.agents', 'skills', 'elsewhere', 'SKILL.md')));
    }

    /* ============================================================ */
    section('B2. 项目信任闸：pi 不信任的项目，Pi GUI 不往里写');
    {
      // (a) 明确被信任
      const aw = worlds.mkWorld('trust-approved');
      const ask = S.mkSkills(aw, aw.proj, { rpc: H.mkRpc([]), approve: true });
      const apid = S.skillId(aw.proj);
      const alist = await H.getList(ask, apid);
      check('B2-a1. 被信任的项目：两个项目级目标都可写，没有额外提示', alist.targets.filter((t) => t.scope === 'project').every((t) => t.writable === true && t.notice === '' && t.blockedCode === ''), JSON.stringify(alist.targets));
      const pOne = (await post(ask, `/api/skills/create?project=${apid}`, { target: 'project-pi', name: 'p-one', description: 'project skill' })).jsonBody();
      check('B2-a2. 写进 <项目>/.pi/skills', pOne.ok === true && pOne.scope === 'project' && pOne.notice === '' && fs.existsSync(path.join(aw.proj, '.pi', 'skills', 'p-one', 'SKILL.md')), JSON.stringify(pOne));
      check('B2-a3. 当前工作区的项目级技能 → pi 在运行就要重启', pOne.restartRequired === true);
      const pTwo = (await post(ask, `/api/skills/create?project=${apid}`, { target: 'project-agents', name: 'p-two', description: 'project skill' })).jsonBody();
      check('B2-a4. 写进 <项目>/.agents/skills', pTwo.ok === true && pTwo.target === 'project-agents' && fs.existsSync(path.join(aw.proj, '.agents', 'skills', 'p-two', 'SKILL.md')));

      // (b) 项目里已有资源、没人做过决定 → pi 在非交互模式下不信任它
      const bw = worlds.mkWorld('trust-undecided');
      const existing = H.writeSkill(path.join(bw.proj, '.pi', 'skills'), 'existing');
      const bsk = S.mkSkills(bw, bw.proj, { rpc: H.mkRpc([]) });
      const bpid = S.skillId(bw.proj);
      const blist = await H.getList(bsk, bpid);
      check('B2-b1. 前提：项目未被信任（ask-no-ui）', blist.trust.trusted === false && blist.trust.reason === 'ask-no-ui', JSON.stringify(blist.trust));
      check('B2-b2. 项目级目标不可写，原因说得清楚', blist.targets.filter((t) => t.scope === 'project').every((t) => t.writable === false && t.blockedCode === 'project-untrusted' && /未被信任/.test(t.blockedReason) && /\/trust/.test(t.blockedReason)), JSON.stringify(blist.targets.filter((t) => t.scope === 'project')));
      check('B2-b3. 全局目标照常可写', blist.targets.filter((t) => t.scope === 'user').every((t) => t.writable === true));
      const projBefore = H.snapshotTree(bw.proj);
      const refused = await post(bsk, `/api/skills/create?project=${bpid}`, { target: 'project-pi', name: 'sneak-in', description: 'should be refused' });
      check('B2-b4. 往未信任的项目里新建 → 403 project-untrusted', outcome(refused) === '403:project-untrusted' && /未被信任/.test(refused.jsonBody().error), outcome(refused));
      const refusedAgents = await post(bsk, `/api/skills/create?project=${bpid}`, { target: 'project-agents', name: 'sneak-in', description: 'should be refused' });
      check('B2-b5. .agents/skills 同样拒绝', outcome(refusedAgents) === '403:project-untrusted', outcome(refusedAgents));
      const existingRow = H.findSkill(blist, 'existing', 'project');
      check('B2-b6. 项目里已有的技能：列得出来，但只读，带原因', existingRow.state === 'untrusted' && existingRow.manage.target === 'project-pi' && existingRow.manage.editable === false && existingRow.manage.deletable === false && /未被信任/.test(existingRow.manage.reason), JSON.stringify(existingRow.manage));
      check('B2-b7. 删除它 → 403', outcome(await H.api(bsk, 'DELETE', `/api/skills/${existingRow.id}?project=${bpid}`)) === '403:read-only');
      check('B2-b8. 读它的源文件来编辑 → 403', outcome(await H.api(bsk, 'GET', `/api/skills/${existingRow.id}/source?project=${bpid}`)) === '403:read-only');
      check('B2-b9. 保存它 → 403', outcome(await H.api(bsk, 'PUT', `/api/skills/${existingRow.id}/source?project=${bpid}`, { mode: 'raw', content: 'x', baseHash: 'x' })) === '403:read-only');
      check('B2-b10. 项目目录一个字节都没动', H.snapshotTree(bw.proj) === projBefore && fs.existsSync(existing));
      const stillOk = (await post(bsk, `/api/skills/create?project=${bpid}`, { target: 'user-pi', name: 'global-instead', description: 'saved globally' })).jsonBody();
      check('B2-b11. 改存到全局照常成功', stillOk.ok === true && stillOk.scope === 'user');

      // (c) trust.json / defaultProjectTrust 的明确决定（两种环境下结论相同）
      const decide = async (name, setup) => {
        const cw = worlds.mkWorld(name);
        setup(cw);
        const csk = S.mkSkills(cw, cw.proj, { rpc: H.mkRpc([]) });
        const cpid = S.skillId(cw.proj);
        const target = (await H.getList(csk, cpid)).targets.find((t) => t.key === 'project-pi');
        const created = await post(csk, `/api/skills/create?project=${cpid}`, { target: 'project-pi', name: 'decided', description: 'trust decision' });
        return { cw, target, created, onDisk: fs.existsSync(path.join(cw.proj, '.pi', 'skills', 'decided', 'SKILL.md')) };
      };
      const denied = await decide('trust-file-no', (cw) => H.writeJson(path.join(cw.agent, 'trust.json'), { [path.resolve(cw.proj)]: false }));
      check('B2-c1. trust.json 里明确不信任 → 不可写', denied.target.writable === false && denied.target.blockedCode === 'project-untrusted' && /不信任|未被信任/.test(denied.target.blockedReason), JSON.stringify(denied.target));
      check('B2-c2. …新建被拒，磁盘上没有', outcome(denied.created) === '403:project-untrusted' && denied.onDisk === false, outcome(denied.created));
      const allowed = await decide('trust-file-yes', (cw) => H.writeJson(path.join(cw.agent, 'trust.json'), { [path.resolve(cw.proj)]: true }));
      check('B2-c3. trust.json 里明确信任 → 可写，没有额外提示', allowed.target.writable === true && allowed.target.notice === '', JSON.stringify(allowed.target));
      check('B2-c4. …新建成功', allowed.created.code === 200 && allowed.onDisk === true && allowed.created.jsonBody().notice === '', outcome(allowed.created));
      const parentTrusted = await decide('trust-file-parent', (cw) => H.writeJson(path.join(cw.agent, 'trust.json'), { [path.resolve(cw.base)]: true }));
      check('B2-c5. 上级目录被信任 → 也可写（最近祖先的决定）', parentTrusted.target.writable === true && parentTrusted.onDisk === true);
      const always = await decide('trust-default-always', (cw) => H.writeJson(path.join(cw.agent, 'settings.json'), { defaultProjectTrust: 'always' }));
      check('B2-c6. defaultProjectTrust=always → 可写，没有额外提示', always.target.writable === true && always.target.notice === '' && always.onDisk === true, JSON.stringify(always.target));
      const never = await decide('trust-default-never', (cw) => H.writeJson(path.join(cw.agent, 'settings.json'), { defaultProjectTrust: 'never' }));
      check('B2-c7. defaultProjectTrust=never → 不可写', never.target.writable === false && never.target.blockedCode === 'project-untrusted' && outcome(never.created) === '403:project-untrusted' && never.onDisk === false, JSON.stringify(never.target));

      // (d) 注入 core，逐分支核对判定表（与环境完全无关）
      const dw = worlds.mkWorld('trust-table');
      const ctx = { cwd: dw.proj, live: true, explicit: true };
      const verdictOf = (current, after) => {
        const seen = [];
        const manager = createSkillsManager({ core: S.fakeCore(dw, { current, after, seen }), dataDir: dw.data });
        const target = manager.listTargets(ctx).find((t) => t.key === 'project-pi');
        return { target, seen, manager };
      };
      const T = (trusted, reason) => ({ trusted, reason, requiresTrust: reason !== 'no-project-resources' });
      const untrusted = verdictOf(T(false, 'ask-no-ui'), T(false, 'ask-no-ui'));
      check('B2-d1. 现在就不被信任 → 拒绝', untrusted.target.writable === false && untrusted.target.blockedCode === 'project-untrusted' && /当前项目未被信任/.test(untrusted.target.blockedReason), JSON.stringify(untrusted.target));
      const stable = verdictOf(T(true, 'trust-file'), T(true, 'trust-file'));
      check('B2-d2. 现在信任、写入后仍信任 → 放行，不提示', stable.target.writable === true && stable.target.notice === '');
      check('B2-d3. 判定用的是这个项目、这个 agentDir，并预演了「写入之后」', stable.seen.length === 2 && stable.seen.every((args) => args.cwd === dw.proj && args.agentDir === dw.agent && args.homeDir === dw.home)
        && stable.seen[0].assumeResources === undefined && stable.seen[1].assumeResources === true, JSON.stringify(stable.seen.map((args) => args.assumeResources)));
      const first = verdictOf(T(true, 'no-project-resources'), T(false, 'ask-no-ui'));
      check('B2-d4. 现在「被信任」只因为项目里还没有资源 → 放行，但如实告知要先信任', first.target.writable === true && /第一个项目级资源/.test(first.target.notice) && /\/trust/.test(first.target.notice), JSON.stringify(first.target));
      const willDeny = verdictOf(T(true, 'no-project-resources'), T(false, 'trust-file'));
      check('B2-d5. 写入后会落到 trust.json 的「不信任」上 → 拒绝', willDeny.target.writable === false && /已被设为不信任/.test(willDeny.target.blockedReason), JSON.stringify(willDeny.target));
      const willNever = verdictOf(T(true, 'no-project-resources'), T(false, 'default-never'));
      check('B2-d6. 写入后会落到 defaultProjectTrust=never 上 → 拒绝', willNever.target.writable === false && /已被设为不信任/.test(willNever.target.blockedReason));
      const willAlways = verdictOf(T(true, 'no-project-resources'), T(true, 'default-always'));
      check('B2-d7. 写入后由 defaultProjectTrust=always 兜住 → 放行，不提示', willAlways.target.writable === true && willAlways.target.notice === '');
      const noticed = await first.manager.create(ctx, { target: 'project-pi', name: 'first-resource', description: 'the very first one' });
      check('B2-d8. 「第一个资源」的新建：成功，响应里带那条提示', noticed.ok === true && /第一个项目级资源/.test(noticed.notice) && fs.existsSync(path.join(dw.proj, '.pi', 'skills', 'first-resource', 'SKILL.md')), JSON.stringify(noticed));
      const stopped = await untrusted.manager.create(ctx, { target: 'project-pi', name: 'never-lands', description: 'refused' });
      check('B2-d9. 被拒绝的新建：403，磁盘上没有', stopped.ok === false && stopped.status === 403 && stopped.code === 'project-untrusted' && !fs.existsSync(path.join(dw.proj, '.pi', 'skills', 'never-lands')), JSON.stringify(stopped));
      check('B2-d10. 信任判定不影响全局目标', untrusted.manager.listTargets(ctx).filter((t) => t.scope === 'user').every((t) => t.writable === true));

      // (e) 唯一依赖环境的一段：什么决定都没有的全新项目。按实际读到的状态分支，两边各 4 条
      const ew = worlds.mkWorld('trust-fresh');
      const esk = S.mkSkills(ew, ew.proj, { rpc: H.mkRpc([]) });
      const epid = S.skillId(ew.proj);
      const elist = await H.getList(esk, epid);
      const eTarget = elist.targets.find((t) => t.key === 'project-pi');
      const eCreate = await post(esk, `/api/skills/create?project=${epid}`, { target: 'project-pi', name: 'fresh-one', description: 'first project skill' });
      if (elist.trust.reason === 'no-project-resources') {
        check('B2-e1. 全新项目（闸门没合上）：可写，并提示这是第一个项目级资源', eTarget.writable === true && /第一个项目级资源/.test(eTarget.notice), JSON.stringify(eTarget));
        check('B2-e2. 新建成功，响应带同一条提示', eCreate.code === 200 && /第一个项目级资源/.test(eCreate.jsonBody().notice) && fs.existsSync(path.join(ew.proj, '.pi', 'skills', 'fresh-one', 'SKILL.md')), outcome(eCreate));
        const after = await H.getList(esk, epid);
        check('B2-e3. 写入之后项目确实变成了未信任（提示说的是实话）', after.trust.trusted === false && after.targets.find((t) => t.key === 'project-pi').writable === false, JSON.stringify(after.trust));
        check('B2-e4. 此后再往里写 → 403', outcome(await post(esk, `/api/skills/create?project=${epid}`, { target: 'project-pi', name: 'fresh-two', description: 'second' })) === '403:project-untrusted');
      } else {
        check('B2-e1. 全新项目（这台机器的上级目录里有 .agents/skills，闸门已合上）：不可写', elist.trust.reason === 'ask-no-ui' && eTarget.writable === false && eTarget.blockedCode === 'project-untrusted', JSON.stringify(elist.trust));
        check('B2-e2. 新建被拒', outcome(eCreate) === '403:project-untrusted', outcome(eCreate));
        check('B2-e3. 项目目录里什么都没多', H.listDir(ew.proj).join(',') === '.git', H.listDir(ew.proj).join(','));
        check('B2-e4. 全局目标照常可写', elist.targets.filter((t) => t.scope === 'user').every((t) => t.writable === true));
      }

      // (f) 撤销令牌 30 分钟过期（注入时钟）
      const tw = worlds.mkWorld('undo-ttl');
      let clock = Date.UTC(2026, 3, 1, 12, 0, 0);
      const tsk = S.mkSkills(tw, tw.proj, { approve: true });
      const tmgr = createSkillsManager({ core: S.realCore(tsk, { approve: true }), dataDir: tw.data, now: () => new Date(clock) });
      const tctx = { cwd: tw.proj, live: true, explicit: true };
      const early = await tmgr.create(tctx, { target: 'user-pi', name: 'undo-in-time', description: 'within the window' });
      const late = await tmgr.create(tctx, { target: 'user-pi', name: 'undo-too-late', description: 'past the window' });
      clock += 30 * 60 * 1000;
      const inTime = await tmgr.undo(early.undo);
      check('B2-f1. 正好 30 分钟时还能撤销', inTime.ok === true && !fs.existsSync(path.join(tw.agent, 'skills', 'undo-in-time')), JSON.stringify(inTime));
      clock += 1;
      const tooLate = await tmgr.undo(late.undo);
      check('B2-f2. 过了 30 分钟 → 410 undo-expired', tooLate.ok === false && tooLate.status === 410 && tooLate.code === 'undo-expired', JSON.stringify(tooLate));
      check('B2-f3. 过期的撤销什么都不动', fs.existsSync(path.join(tw.agent, 'skills', 'undo-too-late', 'SKILL.md')));
    }

    /* ============================================================ */
    section('C. 不落盘的校验（编辑器边输入边调用）');
    {
      const w = worlds.mkWorld('check');
      H.writeSkill(path.join(w.agent, 'skills'), 'existing');
      H.writeSkill(path.join(w.agent, 'skills'), 'form-me', { raw: '---\nname: form-me\ndescription: Old\nlicense: MIT\n---\n\nBody1\n' });
      const outside = path.join(w.base, 'declared');
      H.writeSkill(outside, 'read-only-one');
      H.writeJson(path.join(w.agent, 'settings.json'), { skills: [outside] });
      const sk = S.mkSkills(w, w.proj, { approve: true });
      const pid = S.skillId(w.proj);
      const list = await H.getList(sk, pid);
      const formMe = H.findSkill(list, 'form-me');
      const readOnly = H.findSkill(list, 'read-only-one');
      const before = H.snapshotTree(w.base);
      const checkOf = async (body, query = '') => (await post(sk, `/api/skills/check${query}`, body)).jsonBody();

      const ok = await checkOf({ kind: 'create', target: 'user-pi', name: 'fresh-name', description: 'Does a thing', body: 'Steps' });
      check('C1. 新建表单：通过，并给出将要写出的全文', ok.ok === true && ok.errors.length === 0 && ok.content === '---\nname: fresh-name\ndescription: Does a thing\n---\n\nSteps\n' && ok.bytes === Buffer.byteLength(ok.content), JSON.stringify(ok));
      const bad = await checkOf({ kind: 'create', target: 'user-pi', name: 'Bad Name', description: '', body: 'x\x00y' });
      check('C2. 问题按字段给出', bad.ok === true && ['name', 'description', 'body'].every((field) => bad.errors.some((entry) => entry.field === field)), JSON.stringify(bad.errors));
      const taken = await checkOf({ kind: 'create', target: 'user-pi', name: 'existing', description: 'd' });
      check('C3. 目标目录里已有同名 → 名称字段报错', taken.errors.some((entry) => entry.field === 'name' && entry.message === '「existing」在 ~/.pi/agent/skills 里已经存在'), JSON.stringify(taken.errors));
      const shadow = await checkOf({ kind: 'create', target: 'user-agents', name: 'existing', description: 'd' });
      check('C4. 别的目录里有同名 → 只是提醒，不拦', shadow.errors.length === 0 && shadow.warnings.length === 1 && shadow.warnings[0].field === 'name' && /已有同名技能「existing」/.test(shadow.warnings[0].message), JSON.stringify(shadow));
      const noTarget = await checkOf({ kind: 'create', name: 'existing', description: 'd' });
      check('C5. 没选保存位置时不查重', noTarget.errors.length === 0 && noTarget.warnings.length === 0);

      const noFm = await checkOf({ kind: 'raw', content: '# just text' });
      check('C6. 源文件没有 frontmatter → 报错（content）', noFm.errors.length === 1 && noFm.errors[0].field === 'content' && /frontmatter/.test(noFm.errors[0].message), JSON.stringify(noFm.errors));
      const boolDesc = await checkOf({ kind: 'raw', content: '---\nname: x\ndescription: true\n---\nbody' });
      check('C7. description 会被 YAML 读成布尔 → 报错，提示加引号', boolDesc.errors.some((entry) => entry.field === 'description' && /引号/.test(entry.message)), JSON.stringify(boolDesc.errors));
      const numDesc = await checkOf({ kind: 'raw', content: '---\nname: x\ndescription: 2024\n---\nbody' });
      check('C8. description 会被 YAML 读成数字 → 报错', numDesc.errors.some((entry) => entry.field === 'description'), JSON.stringify(numDesc.errors));
      const quotedDesc = await checkOf({ kind: 'raw', content: '---\nname: x\ndescription: "true"\n---\nbody' });
      check('C9. 加了引号就是合法的字符串', quotedDesc.errors.length === 0, JSON.stringify(quotedDesc.errors));
      const emptyDesc = await checkOf({ kind: 'raw', content: '---\nname: x\ndescription:\n---\nbody' });
      check('C10. description 是空的 → 报错', emptyDesc.errors.some((entry) => entry.field === 'description' && /空的/.test(entry.message)), JSON.stringify(emptyDesc.errors));
      const missingDesc = await checkOf({ kind: 'raw', content: '---\nname: x\n---\nbody' });
      check('C11. 没有 description → 报错', missingDesc.errors.some((entry) => entry.field === 'description' && /没有 description/.test(entry.message)));
      const badName = await checkOf({ kind: 'raw', content: '---\nname: Bad Name\ndescription: fine\n---\n' });
      check('C12. name 不合规范 → 只是提醒（pi 仍会加载）', badName.errors.length === 0 && badName.warnings.some((entry) => entry.field === 'name'), JSON.stringify(badName));
      const tooBig = await checkOf({ kind: 'raw', content: `---\nname: x\ndescription: fine\n---\n${'x'.repeat(S.MAX_SKILL_BYTES)}` });
      check('C13. 超过 256 KB → 报错', tooBig.errors.some((entry) => entry.field === 'content' && /超过 256 KB/.test(entry.message)));
      const block = await checkOf({ kind: 'raw', content: '---\nname: blk\ndescription: |\n  multi\n  line\n---\nbody\n' });
      check('C14. 块标量写法的 description 读得出来', block.errors.length === 0 && block.form.available === true && block.form.description === 'multi line', JSON.stringify(block.form));
      const special = await checkOf({ kind: 'raw', content: '---\nname: sp\ndescription: &a Fancy\n---\nbody\n' });
      check('C15. 写法特殊、表单读不懂的 description → 只提醒，并告知表单不可用', special.errors.length === 0 && special.warnings.some((entry) => entry.field === 'description') && special.form.available === false, JSON.stringify(special));
      const crlf = await checkOf({ kind: 'raw', content: '---\r\nname: x\r\ndescription: fine\r\n---\r\nbody\r\n' });
      check('C16. 提交的 CRLF 统一成 LF 再校验', crlf.errors.length === 0 && !crlf.content.includes('\r'));

      const formNoId = await post(sk, '/api/skills/check', { kind: 'form', description: 'd', body: 'b' });
      check('C17. 表单校验不带技能 ID → 400', outcome(formNoId) === '400:bad-request', outcome(formNoId));
      check('C18. kind 不认识 → 400', outcome(await post(sk, '/api/skills/check', { kind: 'bogus' })) === '400:bad-request' && outcome(await post(sk, '/api/skills/check', {})) === '400:bad-request');
      const form = await checkOf({ kind: 'form', id: formMe.id, description: 'New: desc', body: 'Body2' });
      check('C19. 表单 → 全文：只动 description 与正文，别的键原样', form.ok === true && form.errors.length === 0 && form.content === '---\nname: form-me\ndescription: "New: desc"\nlicense: MIT\n---\n\nBody2\n', JSON.stringify(form.content));
      check('C20. 全文 → 表单：带回拆好的字段', form.form.available === true && form.form.name === 'form-me' && form.form.description === 'New: desc' && form.form.body === 'Body2\n' && form.form.extraKeys.join(',') === 'license', JSON.stringify(form.form));
      const withProject = await checkOf({ kind: 'form', id: formMe.id, description: 'Old', body: 'Body1' }, `?project=${pid}`);
      check('C21. 带不带 project 都能校验；没改动时全文与磁盘一致', withProject.ok === true && withProject.content === '---\nname: form-me\ndescription: Old\nlicense: MIT\n---\n\nBody1\n', JSON.stringify(withProject.content));
      const onReadOnly = await post(sk, '/api/skills/check', { kind: 'raw', id: readOnly.id, content: '---\ndescription: x\n---\n' });
      check('C22. 对只读技能做校验 → 403', outcome(onReadOnly) === '403:read-only', outcome(onReadOnly));
      check('C23. 技能 ID 不存在 → 404', outcome(await post(sk, '/api/skills/check', { kind: 'raw', id: 'f'.repeat(16), content: 'x' })) === '404:not-found');
      check('C24. GET 校验 → 405', outcome(await H.api(sk, 'GET', '/api/skills/check')) === '405:method-not-allowed');
      check('C25. 校验从不写盘：整个世界一个字节都没变（连修改时间）', H.snapshotTree(w.base) === before);
    }

    /* ============================================================ */
    section('K. 路由层的防线');
    {
      const w = worlds.mkWorld('routes');
      H.writeSkill(path.join(w.agent, 'skills'), 'route-me');
      const sk = S.mkSkills(w, w.proj, { approve: true });
      const pid = S.skillId(w.proj);

      const malformed = await H.api(sk, 'GET', '/api/skills/%E0%A4%A/source');
      check('K1. 路径里的百分号编码不合法 → 400，不抛', outcome(malformed) === '400:bad-request' && malformed.thrown === null, outcome(malformed));
      const huge = await post(sk, `/api/skills/create?project=${pid}`, Buffer.alloc(1024 * 1024 + 16, 0x20));
      check('K2. 请求体超过 1 MB → 413', outcome(huge) === '413:too-large', outcome(huge));
      for (const [method, url] of [
        ['POST', '/api/skills/create/extra'], ['GET', '/api/skills/import'], ['POST', '/api/skills/import/other'], ['GET', '/api/skills/market/unknown'],
        ['POST', '/api/skills/external/other'], ['POST', '/api/skills/undo'], ['POST', '/api/skills/check/more'],
      ]) {
        const res = await H.api(sk, method, url, method === 'POST' ? {} : undefined);
        check(`K3. ${method} ${url} → 404`, outcome(res) === '404:not-found', outcome(res));
      }
      check('K4. 技能 ID 不是 16 位十六进制 → 400', outcome(await H.api(sk, 'GET', '/api/skills/not-an-id/source')) === '400:bad-request'
        && outcome(await H.api(sk, 'DELETE', `/api/skills/not-an-id?project=${pid}`)) === '400:bad-request' && outcome(await H.api(sk, 'DELETE', `/api/skills/${'A'.repeat(16)}?project=${pid}`)) === '400:bad-request');
      const bare = await H.api(sk, 'DELETE', '/api/skills');
      check('K5. DELETE /api/skills（不带 ID）→ 405', bare.code === 405, String(bare.code));
      const list = await H.getList(sk, pid);
      const id = H.findSkill(list, 'route-me').id;
      for (const method of ['POST', 'DELETE', 'PATCH']) {
        const res = await H.api(sk, method, `/api/skills/${id}/source?project=${pid}`, method === 'DELETE' ? undefined : {});
        check(`K6. ${method} …/source → 405`, outcome(res) === '405:method-not-allowed', outcome(res));
      }
      check('K7. 写操作的 project 不合法时先 400，不读请求体', outcome(await post(sk, '/api/skills/create?project=zzz', { target: 'user-pi', name: 'x', description: 'd' })) === '400:bad-project');

      // 模块内部抛了未预期的错：只回错误类别，不把带路径的原始报错带出去
      const boom = (err) => {
        const core = { ...S.fakeCore(w, { current: { trusted: true }, after: { trusted: true } }), currentCwd: () => w.proj, getProjects: null };
        core.buildIndex = async () => { throw err; };
        const routes = routesModule.createSkillsRoutes({ core, dataDir: w.data, env: w.env });
        return { handle: (req, res, url) => routes.handle(req, res, url, { ok: true, explicit: true, cwd: w.proj, live: true }) };
      };
      const plain = await H.api(boom(new Error('boom at C:\\Users\\someone\\secret')), 'GET', `/api/skills/${id}/source`);
      check('K8. 内部错误 → 500 internal，不带原始报错正文', outcome(plain) === '500:internal' && plain.jsonBody().error === '技能操作失败（内部错误）' && !plain.body().includes('secret'), plain.body());
      const coded = await H.api(boom(Object.assign(new Error('EACCES: permission denied, open /home/someone/x'), { code: 'EACCES' })), 'DELETE', `/api/skills/${id}`);
      check('K9. 带错误码的内部错误 → 只给错误码', outcome(coded) === '500:internal' && coded.jsonBody().error === '技能操作失败（EACCES）' && !coded.body().includes('someone'), coded.body());
    }
  } catch (err) {
    check('套件运行中没有未捕获的异常', false, err && err.stack ? err.stack : String(err));
  } finally {
    worlds.cleanup();
    finish();
  }
})();
