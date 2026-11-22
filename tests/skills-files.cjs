/* 技能文件落盘原语（server/skills-files.js）的故障注入测试。
 *
 * 这一层是「写坏了能不能恢复」的地基：包校验、只读遍历、先写临时目录再 rename 的安装、
 * 原子覆盖、回收站、短期令牌。上层（新建 / 编辑 / 删除 / 导入 / 市场）的安全性都建立在
 * 这里的保证之上，所以每条保证都单独钉一遍，并且注入失败看它留下了什么。
 *
 * 纪律：全部在 os.tmpdir() 里造目录；不 spawn、不联网；不碰任何真实技能目录。
 *
 * 跑法：node tests/skills-files.cjs */
const fs = require('node:fs');
const path = require('node:path');
const H = require('./fixtures/skills-harness.cjs');

const { check, skip, section, finish } = H.createChecker();
const worlds = H.createWorlds('pi-gui-skills-files-');
const WIN = process.platform === 'win32';

/** 捕获同步或异步抛出的错误，返回它的 skillCode / code（没抛则返回 ''）。 */
async function codeOf(run) {
  try {
    await run();
    return '';
  } catch (err) {
    return (err && (err.skillCode || err.code)) || 'unknown';
  }
}

const errno = (code) => Object.assign(new Error(code), { code });
const tempNames = (dir) => H.listDir(dir).filter((name) => name.startsWith('.pi-gui-'));

(async () => {
  const F = await import('../server/skills-files.js');
  const {
    BUNDLE_LIMITS, classifyBundlePath, validateBundle, readSkillTree, installBundle, writeFileAtomic,
    createSkillsTrash, createTokenStore, formatBytes, displayPath, describeError, codeError, sha256Hex,
  } = F;
  const buf = (text) => Buffer.from(text, 'utf8');
  const limits = (patch) => ({ ...BUNDLE_LIMITS, ...patch });

  try {
    /* ============================================================ */
    section('A. 包内路径判定：逃逸一律整包拒绝，不合适的只跳过');
    {
      const fatal = [
        ['', 'empty'], [null, 'empty'], [42, 'empty'],
        ['../x', 'traversal'], ['a/../b', 'traversal'], ['a//b', 'traversal'], ['./a', 'traversal'], ['a/.', 'traversal'], ['a/', 'traversal'],
        ['/abs', 'absolute'], ['C:/x', 'absolute'], ['c:x', 'absolute'],
        ['a\\b', 'backslash'], ['..\\x', 'backslash'],
        ['a\x00b', 'control-char'], ['a\nb', 'control-char'], ['a\x7fb', 'control-char'],
      ];
      for (const [raw, reason] of fatal) {
        const verdict = classifyBundlePath(raw);
        check(`A1. ${JSON.stringify(raw)} → 致命（${reason}）`, verdict.ok === false && verdict.fatal === true && verdict.reason === reason, JSON.stringify(verdict));
      }
      const skipped = [
        ['.git/config', 'hidden'], ['a/.env', 'hidden'], ['...', 'hidden'],
        ['node_modules/x/index.js', 'node_modules'], ['a/node_modules/b.js', 'node_modules'],
        ['aux.txt', 'unsafe-name'], ['dir/CON', 'unsafe-name'], ['Nul', 'unsafe-name'], ['lpt1.md', 'unsafe-name'],
        ['bad:name', 'unsafe-name'], ['trailing.', 'unsafe-name'], ['trailing ', 'unsafe-name'], ['q?.md', 'unsafe-name'],
        ['a<b', 'unsafe-name'], ['a|b', 'unsafe-name'], ['a*b', 'unsafe-name'], ['a"b', 'unsafe-name'],
        ['a/b/c/d/e/f/g/h/i', 'too-deep'],
        ['a'.repeat(120) + '/' + 'b'.repeat(120), 'too-long'],
        ['x'.repeat(121), 'too-long'],
      ];
      for (const [raw, reason] of skipped) {
        const verdict = classifyBundlePath(raw);
        const shown = raw.length > 40 ? `${raw.slice(0, 20)}…（${raw.length} 字符）` : raw;
        check(`A2. ${JSON.stringify(shown)} → 跳过（${reason}）`, verdict.ok === false && verdict.fatal === false && verdict.reason === reason, JSON.stringify(verdict));
      }
      for (const raw of ['SKILL.md', 'scripts/run.py', '资料/说明 文档.md', 'a/b/c/d/e/f/g/h.txt', 'console.md', 'com10.txt', 'x'.repeat(120)]) {
        const verdict = classifyBundlePath(raw);
        const shown = raw.length > 40 ? `${raw.slice(0, 20)}…（${raw.length} 字符）` : raw;
        check(`A3. ${JSON.stringify(shown)} → 放行`, verdict.ok === true && verdict.path === raw, JSON.stringify(verdict));
      }
      check('A4. 放行的结果带分段', classifyBundlePath('a/b/c/d/e/f/g/h.txt').segments.length === 8);
    }

    /* ============================================================ */
    section('B. 包校验：通过的才是文件表，致命问题整包拒绝');
    {
      const skill = { path: 'SKILL.md', bytes: buf('---\nname: x\ndescription: d\n---\n') };
      const codeFor = (files, lim) => {
        const out = validateBundle(files, lim);
        return out.ok ? 'ok' : out.code;
      };
      check('B1. 空数组 → empty', codeFor([]) === 'empty');
      check('B2. null → empty', codeFor(null) === 'empty');
      check('B3. 不是数组 → empty', codeFor('SKILL.md') === 'empty');
      const noSkill = validateBundle([{ path: 'README.md', bytes: buf('hi') }]);
      check('B4. 没有 SKILL.md → no-skill-md', noSkill.ok === false && noSkill.code === 'no-skill-md' && noSkill.error === '顶层没有 SKILL.md，这不是一个技能目录', JSON.stringify(noSkill));
      const lower = validateBundle([{ path: 'skill.md', bytes: buf('hi') }]);
      check('B5. skill.md 小写 → no-skill-md，并说明要大写', lower.ok === false && lower.code === 'no-skill-md' && /大写的 SKILL\.md（找到的是 skill\.md）/.test(lower.error), JSON.stringify(lower));
      check('B6. SKILL.md 只在子目录里 → no-skill-md', codeFor([{ path: 'sub/SKILL.md', bytes: buf('x') }]) === 'no-skill-md');

      const unsafe = validateBundle([skill, { path: '../evil.sh' }]);
      check('B7. 包里有一个 ../ 路径 → 整包 unsafe-path', unsafe.ok === false && unsafe.code === 'unsafe-path' && unsafe.error.includes('../evil.sh'), JSON.stringify(unsafe));
      check('B8. 绝对路径 → unsafe-path', codeFor([skill, { path: '/etc/passwd', bytes: buf('x') }]) === 'unsafe-path');
      check('B9. 盘符路径 → unsafe-path', codeFor([skill, { path: 'C:/Windows/x', bytes: buf('x') }]) === 'unsafe-path');
      check('B10. 反斜杠路径 → unsafe-path', codeFor([skill, { path: 'a\\..\\b', bytes: buf('x') }]) === 'unsafe-path');
      const dirty = validateBundle([skill, { path: 'a\x00b\nc', bytes: buf('x') }]);
      check('B11. 路径含控制字符 → unsafe-path，报错里不带原始控制字符', dirty.code === 'unsafe-path' && dirty.error.includes('a?b?c') && !/[\x00\n]/.test(dirty.error), JSON.stringify(dirty));

      const mixed = validateBundle([
        skill,
        { path: '.git/config' },
        { path: 'node_modules/a.js' },
        { path: 'aux.txt' },
        { path: 'scripts/ok.sh', bytes: buf('echo hi\n') },
      ]);
      check('B12. 隐藏文件 / node_modules / Windows 非法名被跳过，其余保留', mixed.ok === true && mixed.files.map((file) => file.path).join(',') === 'SKILL.md,scripts/ok.sh', JSON.stringify(mixed.files && mixed.files.map((file) => file.path)));
      check('B13. 跳过的条目带原因', mixed.skipped.map((entry) => entry.reason).join(',') === 'hidden,node_modules,unsafe-name', JSON.stringify(mixed.skipped));
      check('B14. 跳过的条目带给人看的说明', mixed.skipped.map((entry) => entry.note).join('|') === '隐藏文件|node_modules 目录|文件名在 Windows 上不合法');
      check('B15. totalBytes 只算保留下来的', mixed.totalBytes === skill.bytes.length + 8);

      const caseDup = validateBundle([skill, { path: 'Readme.md', bytes: buf('a') }, { path: 'README.md', bytes: buf('b') }]);
      check('B16. 只差大小写的两个文件 → duplicate-path', caseDup.code === 'duplicate-path' && /只差大小写/.test(caseDup.error), JSON.stringify(caseDup));
      const collide = validateBundle([skill, { path: 'a', bytes: buf('x') }, { path: 'a/b', bytes: buf('y') }]);
      check('B17. 文件与目录同名 → duplicate-path', collide.code === 'duplicate-path' && /文件与目录同名/.test(collide.error), JSON.stringify(collide));
      const collideCase = validateBundle([skill, { path: 'Docs', bytes: buf('x') }, { path: 'docs/b', bytes: buf('y') }]);
      check('B18. 文件与目录只差大小写也算同名', collideCase.code === 'duplicate-path', JSON.stringify(collideCase));
      check('B19. 内容不是 Buffer → bad-data', codeFor([{ path: 'SKILL.md', bytes: 'text' }]) === 'bad-data');
      check('B20. 条目本身是 null → unsafe-path', codeFor([skill, null]) === 'unsafe-path');

      const fileCap = limits({ maxFileBytes: skill.bytes.length + 10 });
      check('B21. 单个文件超限 → file-too-large', codeFor([skill, { path: 'big.bin', bytes: Buffer.alloc(skill.bytes.length + 11) }], fileCap) === 'file-too-large');
      check('B21b. 单个文件正好等于上限 → 通过', codeFor([skill, { path: 'big.bin', bytes: Buffer.alloc(skill.bytes.length + 10) }], fileCap) === 'ok');
      check('B22. 总大小超限 → too-large', codeFor([skill, { path: 'a.bin', bytes: Buffer.alloc(40) }, { path: 'b.bin', bytes: Buffer.alloc(40) }], limits({ maxTotalBytes: skill.bytes.length + 79 })) === 'too-large');
      check('B23. 总大小正好等于上限 → 通过', codeFor([skill, { path: 'a.bin', bytes: Buffer.alloc(40) }, { path: 'b.bin', bytes: Buffer.alloc(40) }], limits({ maxTotalBytes: skill.bytes.length + 80 })) === 'ok');
      check('B24. 文件数超限 → too-many-files', codeFor([skill, { path: 'a', bytes: buf('1') }, { path: 'b', bytes: buf('2') }], limits({ maxFiles: 2 })) === 'too-many-files');
      check('B25. 原始条目数超限（含会被跳过的）→ too-many-files', codeFor([skill, { path: '.a' }, { path: '.b' }, { path: '.c' }], limits({ maxRawEntries: 3 })) === 'too-many-files');
      check('B26. 默认上限：200 个文件、单个 2 MB、总计 12 MB、8 层', BUNDLE_LIMITS.maxFiles === 200 && BUNDLE_LIMITS.maxFileBytes === 2 * 1024 * 1024 && BUNDLE_LIMITS.maxTotalBytes === 12 * 1024 * 1024 && BUNDLE_LIMITS.maxDepth === 8);
      check('B27. 上限表是冻结的', Object.isFrozen(BUNDLE_LIMITS));

      const ordered = validateBundle([{ path: 'z.txt', bytes: buf('z') }, skill, { path: 'a.txt', bytes: buf('a') }]);
      check('B28. 文件表里 SKILL.md 排第一，其余按路径排序', ordered.files.map((file) => file.path).join(',') === 'SKILL.md,a.txt,z.txt');
      const exec = validateBundle([skill, { path: 'run.sh', bytes: buf('x'), executable: true }, { path: 'no.sh', bytes: buf('x'), executable: 'yes' }]);
      check('B29. executable 只认布尔 true', exec.files.map((file) => `${file.path}:${file.executable}`).join(',') === 'SKILL.md:false,no.sh:false,run.sh:true', JSON.stringify(exec.files.map((file) => `${file.path}:${file.executable}`)));
    }

    /* ============================================================ */
    section('C. 安装：先写进临时目录再 rename，失败不留半个技能');
    {
      const w = worlds.mkWorld('install');
      const root = path.join(w.base, 'skills-root');
      const files = [
        { path: 'SKILL.md', bytes: buf('---\nname: demo\ndescription: d\n---\n'), executable: false },
        { path: 'scripts/run.sh', bytes: buf('#!/bin/sh\necho hi\n'), executable: true },
        { path: 'assets/logo.bin', bytes: Buffer.from([0, 1, 2, 255, 254]), executable: false },
      ];
      const dest = await installBundle({ rootDir: root, name: 'demo', files });
      check('C1. 根目录不存在时会建出来，返回技能目录', dest === path.join(root, 'demo') && fs.statSync(dest).isDirectory());
      check('C2. 每个文件逐字节一致（含二进制）', files.every((file) => fs.readFileSync(path.join(dest, ...file.path.split('/'))).equals(file.bytes)));
      check('C3. 根目录里只有技能目录，没有临时目录', H.listDir(root).join(',') === 'demo', H.listDir(root).join(','));
      if (WIN) skip('C4. 可执行位随 executable 落盘', 'Windows 没有 POSIX 权限位');
      else check('C4. 可执行位随 executable 落盘', (fs.statSync(path.join(dest, 'scripts', 'run.sh')).mode & 0o111) !== 0 && (fs.statSync(path.join(dest, 'SKILL.md')).mode & 0o111) === 0);

      const before = H.snapshotTree(root);
      const again = await codeOf(() => installBundle({ rootDir: root, name: 'demo', files: [{ path: 'SKILL.md', bytes: buf('other'), executable: false }] }));
      check('C5. 目标已存在 → exists', again === 'exists', again);
      check('C6. 已存在的技能一个字节都没动，也没有临时目录', H.snapshotTree(root) === before);

      fs.writeFileSync(path.join(root, 'plain-file'), 'x');
      const onFile = await codeOf(() => installBundle({ rootDir: root, name: 'plain-file', files }));
      check('C7. 目标位置是一个文件 → exists', onFile === 'exists' && fs.readFileSync(path.join(root, 'plain-file'), 'utf8') === 'x', onFile);

      // 绕过 validateBundle，构造「先写文件 a，再要把 a 当目录」的中途失败
      const broken = [
        { path: 'SKILL.md', bytes: buf('---\nname: b\ndescription: d\n---\n'), executable: false },
        { path: 'a', bytes: buf('file'), executable: false },
        { path: 'a/b', bytes: buf('nested'), executable: false },
      ];
      const midway = await codeOf(() => installBundle({ rootDir: root, name: 'broken', files: broken }));
      check('C8. 写到一半失败 → 抛错', midway !== '', midway);
      check('C9. 失败后目标不存在，临时目录也被清掉', !fs.existsSync(path.join(root, 'broken')) && tempNames(root).length === 0, H.listDir(root).join(','));

      // 上次崩溃留下的临时目录：只清「自己命名的 + 足够旧的」
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const staleOwn = path.join(root, '.pi-gui-tmp-123-abcdefabcdef');
      const freshOwn = path.join(root, '.pi-gui-tmp-124-abcdefabcdef');
      const foreign = path.join(root, '.other-tool-tmp');
      const lookalike = path.join(root, '.pi-gui-tmp-x-zz');
      for (const dir of [staleOwn, freshOwn, foreign, lookalike]) {
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'leftover'), 'x');
      }
      for (const dir of [staleOwn, foreign, lookalike]) fs.utimesSync(dir, old, old);
      await installBundle({ rootDir: root, name: 'second', files: [files[0]] });
      check('C10. 一小时前留下的自家临时目录被清掉', !fs.existsSync(staleOwn));
      check('C11. 刚建的自家临时目录留着（可能是另一个进行中的安装）', fs.existsSync(freshOwn));
      check('C12. 别人的隐藏目录不碰（再旧也不碰）', fs.existsSync(path.join(foreign, 'leftover')));
      check('C13. 名字只是像、但不符合自家格式的也不碰', fs.existsSync(path.join(lookalike, 'leftover')));
    }

    /* ============================================================ */
    section('D. 原子覆盖单个文件');
    {
      const w = worlds.mkWorld('atomic');
      const file = path.join(w.base, 'SKILL.md');
      fs.writeFileSync(file, 'old content');
      await writeFileAtomic(file, buf('new content'));
      check('D1. 内容被整份替换', fs.readFileSync(file, 'utf8') === 'new content');
      check('D2. 目录里没有留下 .tmp', H.listDir(w.base).filter((name) => name.endsWith('.tmp')).length === 0, H.listDir(w.base).join(','));
      if (WIN) {
        skip('D3. 保留原文件的权限位', 'Windows 没有 POSIX 权限位');
      } else {
        fs.chmodSync(file, 0o600);
        await writeFileAtomic(file, buf('again'));
        check('D3. 保留原文件的权限位', (fs.statSync(file).mode & 0o777) === 0o600);
      }
      const fresh = path.join(w.base, 'fresh.md');
      await writeFileAtomic(fresh, buf('hello'));
      check('D4. 目标不存在时直接建出来', fs.readFileSync(fresh, 'utf8') === 'hello');

      const blockedDir = path.join(w.base, 'is-a-dir');
      fs.mkdirSync(blockedDir);
      fs.writeFileSync(path.join(blockedDir, 'keep'), 'k');
      const failed = await codeOf(() => writeFileAtomic(blockedDir, buf('x')));
      check('D5. 目标其实是个目录 → 抛错', failed !== '', failed);
      check('D6. 失败后目录原样、没有留下临时文件', fs.readFileSync(path.join(blockedDir, 'keep'), 'utf8') === 'k' && H.listDir(w.base).filter((name) => name.endsWith('.tmp')).length === 0, H.listDir(w.base).join(','));
    }

    /* ============================================================ */
    section('E. 回收站：挪进去、读得出、放得回');
    {
      const w = worlds.mkWorld('trash');
      const fixed = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678));
      const trash = createSkillsTrash({ dataDir: w.data, now: () => fixed });
      check('E1. 有数据目录时回收站可用，位置在 <data>/skills-trash', trash.available === true && trash.root === path.join(w.data, 'skills-trash'));

      const skillsRoot = path.join(w.base, 'skills');
      H.writeSkill(skillsRoot, 'victim', { files: { 'scripts/run.py': 'print(1)\n', 'assets/logo.bin': Buffer.from([0, 255, 7]) } });
      const victim = path.join(skillsRoot, 'victim');
      const original = H.snapshotTree(victim, { withMtime: false });
      const id = await trash.put({ source: victim, kind: 'dir', meta: { name: 'victim', scope: 'user', originalPath: victim, reason: 'delete' } });
      check('E2. 条目 ID 是 del-<毫秒时间戳>-<随机数>', /^del-20260102030405678-[0-9a-f]{8}$/.test(id), id);
      check('E3. 原目录已经不在技能目录里', !fs.existsSync(victim));
      const entry = trash.read(id);
      check('E4. 读得出元数据', Boolean(entry) && entry.meta.id === id && entry.meta.version === 1 && entry.meta.kind === 'dir' && entry.meta.name === 'victim'
        && entry.meta.originalPath === victim && entry.meta.reason === 'delete' && entry.meta.trashedAt === '2026-01-02T03:04:05.678Z', JSON.stringify(entry && entry.meta));
      check('E5. 回收站里的内容与原目录逐字节一致', H.snapshotTree(entry.payload, { withMtime: false }) === original);

      fs.mkdirSync(victim);
      const occupied = await codeOf(() => trash.restore(id, victim));
      check('E6. 原位置被占着 → exists', occupied === 'exists', occupied);
      check('E7. 放不回去时回收站条目原样留着', H.snapshotTree(trash.read(id).payload, { withMtime: false }) === original);
      fs.rmdirSync(victim);
      await trash.restore(id, victim);
      check('E8. 放回原处后内容逐字节一致', H.snapshotTree(victim, { withMtime: false }) === original);
      check('E9. 放回后条目消失', trash.read(id) === null && !fs.existsSync(path.join(trash.root, id)));
      check('E10. 再放一次 → trash-missing', (await codeOf(() => trash.restore(id, path.join(skillsRoot, 'elsewhere')))) === 'trash-missing');

      // 单文件技能
      const single = path.join(skillsRoot, 'single.md');
      fs.writeFileSync(single, '---\ndescription: one file\n---\nbody\n');
      const fileId = await trash.put({ source: single, kind: 'file', meta: { name: 'single', originalPath: single } });
      const fileEntry = trash.read(fileId);
      check('E11. 单文件技能也能进回收站', !fs.existsSync(single) && fileEntry.meta.kind === 'file' && fs.readFileSync(fileEntry.payload, 'utf8') === '---\ndescription: one file\n---\nbody\n');
      await trash.restore(fileId, single);
      check('E12. 单文件技能放回原处', fs.readFileSync(single, 'utf8') === '---\ndescription: one file\n---\nbody\n');

      // ID 不合法：读不出，也删不到别处
      const keepId = await trash.put({ source: victim, kind: 'dir', meta: { name: 'victim', originalPath: victim } });
      for (const bad of ['..', '../..', 'del-1-2', 'del-20260102030405678-abcdef12/../x', `${keepId}/..`, '', 42, null, undefined, {}]) {
        check(`E13. 不合法的 ID ${JSON.stringify(bad)} 读不出`, trash.read(bad) === null);
      }
      trash.discard('..');
      trash.discard('../..');
      trash.discard(`${keepId}/..`);
      check('E14. 用不合法的 ID 调 discard 不会删到回收站之外', fs.existsSync(w.data) && fs.existsSync(skillsRoot) && trash.read(keepId) !== null);

      // 元数据被改过 / 缺东西的条目一律当作不存在
      const metaFile = path.join(trash.root, keepId, 'meta.json');
      const goodMeta = fs.readFileSync(metaFile, 'utf8');
      fs.writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(goodMeta), id: 'del-20260102030405678-00000000' }));
      check('E15. 元数据里的 ID 对不上 → 读不出', trash.read(keepId) === null);
      fs.writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(goodMeta), originalPath: 42 }));
      check('E16. 元数据里没有原路径 → 读不出', trash.read(keepId) === null);
      fs.writeFileSync(metaFile, '{ not json');
      check('E17. 元数据损坏 → 读不出', trash.read(keepId) === null);
      fs.writeFileSync(metaFile, goodMeta);
      check('E18. 元数据恢复后又读得出', trash.read(keepId) !== null);
      trash.discard(keepId);
      check('E19. discard 删掉整个条目', !fs.existsSync(path.join(trash.root, keepId)));
    }

    /* ============================================================ */
    section('F. 回收站的故障注入：跨盘、I/O 错误、短暂占用');
    {
      const w = worlds.mkWorld('trash-faults');
      const skillsRoot = path.join(w.base, 'skills');
      const mk = (name) => {
        H.writeSkill(skillsRoot, name, { files: { 'scripts/run.py': 'print(1)\n', 'assets/logo.bin': Buffer.from([9, 8, 7]) } });
        return path.join(skillsRoot, name);
      };
      const entriesOf = (trash) => H.listDir(trash.root);

      // 跨盘：rename 报 EXDEV → 先完整拷贝，再把原件改名后删除
      {
        const dataDir = path.join(w.base, 'data-exdev');
        const calls = [];
        const trash = createSkillsTrash({ dataDir, rename: (from, to) => { calls.push([from, to]); throw errno('EXDEV'); } });
        const source = mk('cross-device');
        const original = H.snapshotTree(source, { withMtime: false });
        const id = await trash.put({ source, kind: 'dir', meta: { name: 'cross-device', originalPath: source } });
        check('F1. EXDEV：原目录消失，回收站里有完整副本', !fs.existsSync(source) && H.snapshotTree(trash.read(id).payload, { withMtime: false }) === original);
        check('F2. EXDEV：技能目录里没有留下隐藏的改名残留', tempNames(skillsRoot).length === 0, H.listDir(skillsRoot).join(','));
        check('F3. EXDEV：注入的 rename 只被试了一次（不是可重试的错误）', calls.length === 1, String(calls.length));
        await trash.restore(id, source);
        check('F4. EXDEV：放回时同样退回到拷贝，内容一致、条目消失', H.snapshotTree(source, { withMtime: false }) === original && trash.read(id) === null && entriesOf(trash).length === 0);
      }

      for (const failure of ['EPERM', 'EXDEV']) {
        const dataDir = path.join(w.base, 'data-restore-' + failure);
        const source = path.join(skillsRoot, 'restore-' + failure + '.md');
        fs.writeFileSync(source, 'saved');
        let restoring = false;
        let authorized = true;
        const trash = createSkillsTrash({
          dataDir,
          rename(from, to) {
            if (!restoring) { fs.renameSync(from, to); return; }
            authorized = false;
            fs.writeFileSync(to, 'new user file');
            throw errno(failure);
          },
        });
        const id = await trash.put({ source, kind: 'file', meta: { originalPath: source } });
        restoring = true;
        const rejected = await codeOf(() => trash.restore(id, source, () => {
          if (!authorized) throw codeError('undo-blocked', 'restore context changed');
        }));
        check(`F4a. ${failure} 恢复前重新核对授权，保留用户文件与回收站备份`,
          rejected === 'undo-blocked' && fs.readFileSync(source, 'utf8') === 'new user file'
          && fs.readFileSync(trash.read(id).payload, 'utf8') === 'saved', rejected);
      }

      {
        const dataDir = path.join(w.base, 'data-restore-occupied');
        const source = path.join(skillsRoot, 'restore-occupied.md');
        fs.writeFileSync(source, 'saved');
        let restoring = false;
        let attempts = 0;
        const trash = createSkillsTrash({
          dataDir,
          rename(from, to) {
            if (restoring && ++attempts === 1) {
              fs.writeFileSync(to, 'new user file');
              throw errno('EPERM');
            }
            fs.renameSync(from, to);
          },
        });
        const id = await trash.put({ source, kind: 'file', meta: { originalPath: source } });
        restoring = true;
        const rejected = await codeOf(() => trash.restore(id, source));
        check('F4b. EPERM 重试前原位置被占用 → 保留用户文件与回收站备份',
          rejected === 'exists' && attempts === 1 && fs.readFileSync(source, 'utf8') === 'new user file'
          && fs.readFileSync(trash.read(id).payload, 'utf8') === 'saved', rejected);
      }

      // I/O 错误：不可重试 → 原样抛出，原件不动，回收站不留空壳
      {
        const dataDir = path.join(w.base, 'data-eio');
        let attempts = 0;
        const trash = createSkillsTrash({ dataDir, rename: () => { attempts += 1; throw errno('EIO'); } });
        const source = mk('io-error');
        const original = H.snapshotTree(source);
        const code = await codeOf(() => trash.put({ source, kind: 'dir', meta: { name: 'io-error', originalPath: source } }));
        check('F5. EIO：put 抛出原始错误码', code === 'EIO', code);
        check('F6. EIO：只试一次', attempts === 1, String(attempts));
        check('F7. EIO：原目录一个字节都没动', H.snapshotTree(source) === original);
        check('F8. EIO：回收站里没有留下空壳条目', entriesOf(trash).length === 0, entriesOf(trash).join(','));
      }

      // 短暂占用：EPERM 两次后成功
      {
        const dataDir = path.join(w.base, 'data-eperm');
        let attempts = 0;
        const trash = createSkillsTrash({
          dataDir,
          rename: (from, to) => {
            attempts += 1;
            if (attempts <= 2) throw errno('EPERM');
            fs.renameSync(from, to);
          },
        });
        const source = mk('busy-twice');
        const original = H.snapshotTree(source, { withMtime: false });
        const id = await trash.put({ source, kind: 'dir', meta: { name: 'busy-twice', originalPath: source } });
        check('F9. EPERM 两次后第三次成功', attempts === 3 && !fs.existsSync(source) && H.snapshotTree(trash.read(id).payload, { withMtime: false }) === original, String(attempts));
      }

      // 一直占用：试满 5 次后放弃，原件不动
      {
        const dataDir = path.join(w.base, 'data-eperm-forever');
        let attempts = 0;
        const trash = createSkillsTrash({ dataDir, rename: () => { attempts += 1; throw errno('EBUSY'); } });
        const source = mk('busy-forever');
        const original = H.snapshotTree(source);
        const code = await codeOf(() => trash.put({ source, kind: 'dir', meta: { name: 'busy-forever', originalPath: source } }));
        check('F10. 一直 EBUSY → 试满 5 次后抛出', code === 'EBUSY' && attempts === 5, `${code} / ${attempts}`);
        check('F11. 放弃后原目录原样、回收站没有空壳', H.snapshotTree(source) === original && entriesOf(trash).length === 0);
      }

      // 没有数据目录：整个回收站不可用，绝不退化成真删
      {
        const trash = createSkillsTrash({});
        const source = mk('no-trash');
        const original = H.snapshotTree(source);
        check('F12. 没有数据目录 → 回收站不可用', trash.available === false && trash.root === null);
        check('F13. 不可用时 put → trash-unavailable，原目录不动', (await codeOf(() => trash.put({ source, kind: 'dir', meta: { originalPath: source } }))) === 'trash-unavailable' && H.snapshotTree(source) === original);
        check('F14. 不可用时 putBackup → trash-unavailable', (await codeOf(() => trash.putBackup({ bytes: buf('x'), pathHash: '0123456789abcdef', meta: { originalPath: source } }))) === 'trash-unavailable');
        check('F15. 不可用时 read 返回 null、discard 不抛', trash.read('del-20260102030405678-abcdef12') === null && (await codeOf(() => trash.discard('del-20260102030405678-abcdef12'))) === '');
      }
    }

    /* ============================================================ */
    section('G. 编辑备份：每个文件只留最近几份，刚存的那份永远留着');
    {
      const w = worlds.mkWorld('backups');
      let clock = Date.UTC(2026, 5, 1, 0, 0, 0, 0);
      const trash = createSkillsTrash({ dataDir: w.data, now: () => new Date(clock), editBackupsPerFile: 2 });
      const fileA = '0123456789abcdef';
      const fileB = 'fedcba9876543210';
      const backupsOf = (hash) => H.listDir(trash.root).filter((name) => name.startsWith(`edit-${hash}-`));
      const put = (hash, text) => trash.putBackup({ bytes: buf(text), pathHash: hash, meta: { name: 's', originalPath: '/x/SKILL.md', reason: 'edit' } });

      const a1 = put(fileA, 'v1');
      check('G1. 备份 ID 是 edit-<路径哈希>-<毫秒时间戳>-<随机数>', /^edit-0123456789abcdef-\d{17}-[0-9a-f]{8}$/.test(a1), a1);
      const first = trash.read(a1);
      check('G2. 备份读得出，内容是旧字节', first.meta.kind === 'backup' && first.meta.reason === 'edit' && fs.readFileSync(first.payload, 'utf8') === 'v1');
      clock += 1000;
      const b1 = put(fileB, 'other file');
      clock += 1000;
      const a2 = put(fileA, 'v2');
      clock += 1000;
      const a3 = put(fileA, 'v3');
      check('G3. 同一个文件只留最近 2 份', backupsOf(fileA).join(',') === [a2, a3].join(','), backupsOf(fileA).join(','));
      check('G4. 最旧的那份被清掉', trash.read(a1) === null);
      check('G5. 别的文件的备份不受影响', trash.read(b1) !== null && backupsOf(fileB).length === 1);

      // 同一毫秒里连存几份：ID 的时间戳一样，排序由随机后缀决定 —— 刚存的那份也不能被清
      const fileC = 'aaaaaaaaaaaaaaaa';
      let kept = true;
      for (let n = 0; n < 12; n += 1) {
        const id = put(fileC, `same-ms-${n}`);
        const entry = trash.read(id);
        if (!entry || fs.readFileSync(entry.payload, 'utf8') !== `same-ms-${n}`) kept = false;
      }
      check('G6. 同一毫秒连存 12 份：每次刚存的那份都还在', kept === true);
      check('G7. 同一毫秒连存之后仍然只留 2 份', backupsOf(fileC).length === 2, String(backupsOf(fileC).length));
    }

    /* ============================================================ */
    section('H. 短期令牌表：过期、数量上限、体积上限');
    {
      let clock = 1_000_000;
      const store = createTokenStore({ ttlMs: 1000, maxEntries: 2, maxBytes: 100, now: () => clock });
      const a = store.put({ v: 'a' }, 10);
      check('H1. 令牌是 24 位十六进制', /^[0-9a-f]{24}$/.test(a), a);
      check('H2. get 取回原值，不消耗', store.get(a).v === 'a' && store.get(a).v === 'a' && store.size === 1);
      clock += 1000;
      check('H3. 正好到期的那一刻还在', store.get(a) !== null);
      clock += 1;
      check('H4. 过期后取不到', store.get(a) === null && store.size === 0);

      const b = store.put('b', 10);
      const c = store.put('c', 10);
      const d = store.put('d', 10);
      check('H5. 超过数量上限时最旧的先走', store.get(b) === null && store.get(c) === 'c' && store.get(d) === 'd' && store.size === 2);
      const e = store.put('e', 95);
      check('H6. 超过体积上限时也是最旧的先走', store.get(c) === null && store.get(d) === null && store.get(e) === 'e' && store.size === 1);
      const f = store.put('f', 5000);
      check('H7. 单独一条就超出体积上限：刚放进去的这条仍然留着', store.get(f) === 'f' && store.get(e) === null && store.size === 1);
      check('H8. take 取出即删除', store.take(f) === 'f' && store.take(f) === null && store.size === 0);
      const g = store.put('g');
      store.delete(g);
      check('H9. delete 之后取不到', store.get(g) === null);
      store.delete('no-such-token');
      check('H10. 非字符串 / 不存在的令牌一律取不到', [42, null, undefined, {}, '', 'x'.repeat(24)].every((id) => store.get(id) === null));
      const h1 = store.put('one');
      const h2 = store.put('two');
      check('H11. 每次发的令牌都不同', h1 !== h2);
    }

    /* ============================================================ */
    section('I. 只读地把磁盘上的技能目录读成包');
    {
      const w = worlds.mkWorld('tree');
      const outside = path.join(w.base, 'outside');
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'do not read me');
      const root = path.join(w.base, 'tool-skills');
      H.writeSkill(root, 'rich', {
        files: {
          'scripts/run.py': 'print(1)\n',
          'assets/logo.bin': Buffer.from([0, 1, 2, 254, 255]),
          '.env': 'TOKEN=x',
          '.hidden/secret': 's',
          'node_modules/x/index.js': 'module.exports = 1;',
          'd1/d2/d3/d4/d5/d6/d7/keep.txt': 'eight segments',
          'd1/d2/d3/d4/d5/d6/d7/d8/deep.txt': 'nine segments',
        },
      });
      const dir = path.join(root, 'rich');
      H.linkDir(outside, path.join(dir, 'linked'));
      const linkedFile = H.tryLinkFile(path.join(outside, 'secret.txt'), path.join(dir, 'alias.txt'));

      const beforeTree = H.snapshotTree(dir);
      const beforeOutside = H.snapshotTree(outside);
      const tree = readSkillTree(dir);
      const paths = tree.files.map((file) => file.path).sort();
      check('I1. 读到的正是普通文件（含 8 层深的那个）', paths.join(',') === ['SKILL.md', 'assets/logo.bin', 'd1/d2/d3/d4/d5/d6/d7/keep.txt', 'scripts/run.py'].sort().join(','), paths.join(','));
      check('I2. 字节与磁盘上一致', tree.files.every((file) => fs.readFileSync(path.join(dir, ...file.path.split('/'))).equals(file.bytes)));
      check('I3. totalBytes 是读到的文件之和', tree.totalBytes === tree.files.reduce((sum, file) => sum + file.bytes.length, 0));
      const reasonOf = (rel) => (tree.skipped.find((entry) => entry.path === rel) || {}).reason;
      check('I4. 隐藏文件与隐藏目录被跳过', reasonOf('.env') === 'hidden' && reasonOf('.hidden') === 'hidden');
      check('I5. node_modules 被跳过', reasonOf('node_modules') === 'node_modules');
      check('I6. 目录链接被跳过，不往里读', reasonOf('linked') === 'symlink' && !paths.some((entry) => entry.startsWith('linked/')));
      check('I7. 超过 8 层的目录被跳过', reasonOf('d1/d2/d3/d4/d5/d6/d7/d8') === 'too-deep');
      if (linkedFile) check('I8. 文件符号链接被跳过', reasonOf('alias.txt') === 'symlink' && !paths.includes('alias.txt'));
      else skip('I8. 文件符号链接被跳过', '这台机器没有创建文件符号链接的权限');
      check('I9. 没有任何一个字节来自链接指向的目录', !tree.files.some((file) => file.bytes.toString('utf8').includes('do not read me')));
      check('I10. 读完之后技能目录原样（连修改时间都没变）', H.snapshotTree(dir) === beforeTree);
      check('I11. 链接指向的目录也原样', H.snapshotTree(outside) === beforeOutside);
      check('I12. 读出来的包能通过包校验', validateBundle(tree.files).ok === true);

      const plain = path.join(w.base, 'plain');
      H.writeSkill(plain, 'three', { files: { 'a.txt': 'aaaaaa', 'b.txt': 'bbbbbb' } });
      const three = path.join(plain, 'three');
      check('I13. 文件数超限 → too-many-files', (await codeOf(() => readSkillTree(three, limits({ maxFiles: 2 })))) === 'too-many-files');
      check('I14. 单个文件超限 → file-too-large', (await codeOf(() => readSkillTree(three, limits({ maxFileBytes: 4 })))) === 'file-too-large');
      check('I15. 总大小超限 → too-large', (await codeOf(() => readSkillTree(three, limits({ maxTotalBytes: 10 })))) === 'too-large');
      check('I16. 条目数超限 → too-many-files', (await codeOf(() => readSkillTree(three, limits({ maxRawEntries: 2 })))) === 'too-many-files');
      check('I17. 目录不存在 → unreadable', (await codeOf(() => readSkillTree(path.join(w.base, 'nope')))) === 'unreadable');
      check('I18. 超限失败后目录原样', H.snapshotTree(three) !== null && H.listDir(three).join(',') === 'SKILL.md,a.txt,b.txt');
    }

    /* ============================================================ */
    section('J. 给人看的文字：大小、路径、失败原因');
    {
      check('J1. formatBytes', [0, 512, 1023, 1024, 2048, 2 * 1024 * 1024, 1.5 * 1024 * 1024].map(formatBytes).join('|') === '0 B|512 B|1023 B|1 KB|2 KB|2 MB|1.5 MB', [0, 512, 1023, 1024, 2048, 2 * 1024 * 1024, 1.5 * 1024 * 1024].map(formatBytes).join('|'));
      check('J2. displayPath 把控制字符换成 ?', displayPath('a\x00b\nc') === 'a?b?c');
      const long = displayPath('p'.repeat(200));
      check('J3. displayPath 截断过长的路径', long.length === 118 && long.endsWith('…') && long.startsWith('ppp'), String(long.length));
      check('J4. displayPath：120 字符以内原样，null 变空串', displayPath('q'.repeat(120)) === 'q'.repeat(120) && displayPath(null) === '' && displayPath(undefined) === '');

      check('J5. 自己抛的错：用它自己的话', describeError(codeError('exists', '「x」已经存在')) === '「x」已经存在');
      const fsError = Object.assign(new Error("EPERM: operation not permitted, rename 'C:\\Users\\someone\\secret' -> 'D:\\x'"), { code: 'EPERM' });
      const shown = describeError(fsError);
      check('J6. 系统错误：只留错误码，不带路径', shown.includes('EPERM') && !shown.includes('someone') && !shown.includes('secret'), shown);
      check('J7. 磁盘满有专门的说法', describeError(errno('ENOSPC')).includes('磁盘空间不足'));
      check('J8. 不认识的错误码原样给出', describeError(errno('EXDEV')) === '系统错误 EXDEV');
      check('J9. 没有错误码的普通错误不泄露正文', describeError(new Error('boom at C:\\Users\\someone')) === '未知错误' && describeError(null) === '未知错误');
      check('J10. codeError 带 skillCode 与附加字段', (() => { const err = codeError('too-large', 'm', { limit: 3 }); return err instanceof Error && err.skillCode === 'too-large' && err.limit === 3 && err.message === 'm'; })());
      check('J11. sha256Hex', sha256Hex(Buffer.alloc(0)) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    }
  } catch (err) {
    check('套件运行中没有未捕获的异常', false, err && err.stack ? err.stack : String(err));
  } finally {
    worlds.cleanup();
    finish();
  }
})();
