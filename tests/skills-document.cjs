/* SKILL.md 文本处理（server/skills-document.js）的测试。
 *
 * 这个模块全是纯函数，但它决定了「编辑一个技能会不会把它写坏」，所以单独一份：
 *   - 切分必须与 pi 的 extractFrontmatter 逐字一致（否则我们以为的正文不是 pi 读到的正文）；
 *   - 改写只允许动目标键所占的行，其余 frontmatter 一个字节都不能变；
 *   - 读不懂的写法必须拒绝表单式改写，而不是猜着改。
 *
 * 不碰文件系统、不联网。
 *
 * 用法：node tests/skills-document.cjs
 */
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  let ok;
  try {
    ok = typeof cond === 'function' ? cond() : cond;
  } catch (err) {
    ok = '抛了：' + (err && err.message);
  }
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok ? '  → ' + ok : extra ? '  → ' + extra : ''));
  }
}
function section(t) {
  console.log('\n--- ' + t + ' ---');
}

const BOM = String.fromCharCode(0xfeff);
const NEL = String.fromCharCode(0x85);
const LINE_SEP = String.fromCharCode(0x2028);

/** pi 的切分（dist/utils/frontmatter.js），逐字抄来当对照组。 */
function piExtract(content) {
  const normalized = (content.startsWith(BOM) ? content.slice(1) : content).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.startsWith('---')) return { yamlString: null, body: normalized };
  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) return { yamlString: null, body: normalized };
  return { yamlString: normalized.slice(4, endIndex), body: normalized.slice(endIndex + 4).trim() };
}

(async () => {
  const D = await import('../server/skills-document.js');

  /* ================= A. 解码与编码 ================= */
  section('A. 解码 / 编码（BOM、换行、非法字节）');
  {
    const plain = D.decodeSkillBytes(Buffer.from('---\nname: a\n---\nbody\n', 'utf8'));
    check('A1. 普通 UTF-8：LF、无 BOM', () => (plain.ok && plain.eol === 'lf' && plain.bom === false) || JSON.stringify(plain));

    const crlf = D.decodeSkillBytes(Buffer.from(BOM + '---\r\nname: a\r\n---\r\nbody\r\n', 'utf8'));
    check('A2. BOM + CRLF 被识别，文本统一成 LF', () =>
      (crlf.ok && crlf.bom === true && crlf.eol === 'crlf' && crlf.text === '---\nname: a\n---\nbody\n') || JSON.stringify(crlf));

    check('A3. 编码时恢复 BOM 与 CRLF，字节与原文件一致', () => {
      const original = Buffer.from(BOM + '---\r\nname: a\r\n---\r\nbody\r\n', 'utf8');
      const again = D.encodeSkillText(crlf.text, { bom: crlf.bom, eol: crlf.eol });
      return again.equals(original) || again.toString('hex');
    });

    const bad = D.decodeSkillBytes(Buffer.from([0x2d, 0x2d, 0x2d, 0xff, 0xfe, 0x41]));
    check('A4. 非 UTF-8 字节 → 拒绝（不带替换符继续）', () => (bad.ok === false && bad.code === 'not-utf8') || JSON.stringify(bad));

    const nul = D.decodeSkillBytes(Buffer.from('abc\x00def', 'utf8'));
    check('A5. 含空字符 → 拒绝', () => (nul.ok === false && nul.code === 'binary') || JSON.stringify(nul));

    const mixed = D.decodeSkillBytes(Buffer.from('a\r\nb\nc\nd\n', 'utf8'));
    check('A6. 混合换行按多数判定（这里 LF 多）', () => (mixed.ok && mixed.eol === 'lf') || JSON.stringify(mixed));

    const cjk = D.decodeSkillBytes(Buffer.from('---\ndescription: 写作助手\n---\n正文\n', 'utf8'));
    check('A7. 中文内容原样保留', () => (cjk.ok && cjk.text.includes('写作助手') && cjk.text.includes('正文')) || JSON.stringify(cjk));
  }

  /* ================= B. 切分与 pi 一致 ================= */
  section('B. 切分规则与 pi 的 extractFrontmatter 一致');
  {
    const samples = [
      '---\nname: a\ndescription: b\n---\n\n# Body\n',
      '---\nname: a\n---\nbody with\n--- inside\n',
      '---\n---\nonly body\n',
      '---\nname: a\ndescription: |\n  one\n  two\n---\ntail',
      '# no frontmatter\n',
      '---\nname: a\n',
      '---\nname: a\n---',
      '---   \nname: a\n---\nbody\n',
      '---\nname: a\n----\nbody\n',
      '---\nname: a\n--- \nbody\n',
      '',
      '---',
      '---\n',
    ];
    let mismatch = '';
    for (const sample of samples) {
      const mine = D.splitSkillDocument(sample);
      const theirs = piExtract(sample);
      const sameShape = mine.hasFrontmatter === (theirs.yamlString !== null);
      const sameYaml = !mine.hasFrontmatter || mine.yaml === theirs.yamlString;
      const sameBody = (mine.hasFrontmatter ? mine.after : sample).trim() === theirs.body.trim();
      if (!sameShape || !sameYaml || !sameBody) mismatch += JSON.stringify(sample) + ' ';
    }
    check(`B1. ${samples.length} 个样本的 frontmatter / 正文切分都与 pi 相同`, () => mismatch === '' || mismatch);

    check('B2. 非空 frontmatter：open + yaml + "\\n---" + after 恒等于原文', () => {
      for (const sample of samples) {
        const doc = D.splitSkillDocument(sample);
        if (!doc.hasFrontmatter || doc.emptyBlock) continue;
        if (doc.open + doc.yaml + '\n---' + doc.after !== sample) return JSON.stringify(sample);
      }
      return true;
    });

    check('B3. 空 frontmatter 单独标记（开头那行的换行同时是结束标记的一部分）', () => {
      const doc = D.splitSkillDocument('---\n---\nbody\n');
      return (doc.hasFrontmatter && doc.emptyBlock && doc.yaml === '' && doc.after === '\nbody\n') || JSON.stringify(doc);
    });
  }

  /* ================= C. 读标量 ================= */
  section('C. 读顶层标量（只认看得懂的写法）');
  {
    const read = (yaml, key = 'description') => D.readFrontmatterScalar(`---\n${yaml}\n---\n`, key);
    check('C1. 普通写法', () => read('description: Review source code').value === 'Review source code');
    check('C2. 双引号 + 转义（反斜杠、引号、制表）', () => {
      const r = read('description: "a \\\\ b \\"q\\" \\t end"');
      return (r.ok && r.value === 'a \\ b "q" \t end') || JSON.stringify(r);
    });
    check('C3. 单引号 + 成对的引号转义', () => {
      const r = read("description: 'it''s fine'");
      return (r.ok && r.value === "it's fine") || JSON.stringify(r);
    });
    check('C4. 块标量 | 与 >', () => {
      const literal = read('description: |\n  one\n  two');
      const folded = read('description: >-\n  one\n  two');
      return (literal.value === 'one\ntwo' && folded.value === 'one two') || JSON.stringify([literal, folded]);
    });
    check('C5. 行尾注释不算进值里', () => read('description: hello world # note').value === 'hello world');
    check('C6. 没有这个键 → found 为 false', () => {
      const r = read('name: a');
      return (r.found === false && r.ok === true) || JSON.stringify(r);
    });
    check('C7. 重复的键 → 读不了', () => {
      const r = read('description: a\ndescription: b');
      return (r.found && r.ok === false) || JSON.stringify(r);
    });
    check('C8. 跨行的引号标量 → 读不了（不猜）', () => {
      const r = read('description: "line one\n  line two"');
      return (r.found && r.ok === false) || JSON.stringify(r);
    });
    check('C9. 值里有未加引号的冒号 → 读不了', () => read('description: a: b').ok === false);
    check('C10. 锚点 / 流式写法 → 读不了', () => read('description: &x hello').ok === false && read('description: [a, b]').ok === false);
    check('C11. 双引号里用了 JSON 之外的转义 → 读不了', () => read('description: "a\\x41b"').ok === false);
    check('C12. 单引号里有未转义的引号 → 读不了', () => read("description: 'a'b'").ok === false);
  }

  /* ================= D. 写标量 ================= */
  section('D. 生成标量（写出去的东西必须读得回来）');
  {
    const roundTrip = (value) => {
      const text = `---\ndescription: ${D.yamlScalar(value)}\n---\n`;
      const back = D.readFrontmatterScalar(text, 'description');
      return back.ok && back.value === value;
    };
    const values = [
      'Review source code',
      '写作助手：帮你改稿',
      'a: b',
      'ends with colon:',
      'has # hash',
      'quote " and \' mix',
      'back\\slash',
      'true',
      'null',
      '123',
      '- leading dash',
      '[bracket]',
      'tab\tinside',
      '!bang',
      '中文，带标点。还有（括号）',
      'x'.repeat(1024),
    ];
    const broken = values.filter((value) => !roundTrip(value));
    check(`D1. ${values.length} 个刁钻的值写出去都能原样读回`, () => broken.length === 0 || JSON.stringify(broken));
    check('D2. 普通文字不加引号（保持文件可读）', () => D.yamlScalar('Review source code') === 'Review source code');
    check('D3. 有歧义的值一律加引号', () =>
      [D.yamlScalar('true'), D.yamlScalar('123'), D.yamlScalar('a: b'), D.yamlScalar('')].every((s) => s.startsWith('"')) || 'unquoted');
    check('D4. 描述被收成一行（换行、NEL、行分隔符、控制字符都变成空格）', () => {
      const out = D.normalizeDescription(`  one\r\ntwo${NEL}three${LINE_SEP}four\x01five  `);
      return out === 'one two three four five' || JSON.stringify(out);
    });
    check('D5. 目录名收成规范写法', () =>
      D.sanitizeSkillSlug('My Cool_Skill!!') === 'my-cool-skill' && D.sanitizeSkillSlug('--a--b--') === 'a-b' && D.sanitizeSkillSlug('中文') === '');
    check('D6. 目录名最长 64，且不以连字符结尾', () => {
      const slug = D.sanitizeSkillSlug('a'.repeat(63) + ' b');
      return (slug.length === 63 && !slug.endsWith('-')) || slug;
    });
    check('D7. YAML 会读成非字符串的描述能被识别出来', () => {
      const yes = D.summarizeSkillText('---\ndescription: 123\n---\n').description.nonString;
      const no = D.summarizeSkillText('---\ndescription: "123"\n---\n').description.nonString;
      return (yes === true && no === false) || JSON.stringify({ yes, no });
    });
  }

  /* ================= E. 新建 ================= */
  section('E. 新建文档');
  {
    const text = D.composeNewDocument({ name: 'code-review', description: 'Review\nsource code', body: '# Title\n\nBody\n\n\n' });
    check('E1. 结构：frontmatter、空一行、正文、结尾一个换行', () =>
      text === '---\nname: code-review\ndescription: Review source code\n---\n\n# Title\n\nBody\n' || JSON.stringify(text));
    check('E2. pi 的切分读得回 name / description', () => {
      const { yamlString, body } = piExtract(text);
      return (yamlString === 'name: code-review\ndescription: Review source code' && body.startsWith('# Title')) || JSON.stringify(yamlString);
    });
    check('E3. 没有正文也是合法文档', () =>
      D.composeNewDocument({ name: 'a', description: 'b', body: '' }) === '---\nname: a\ndescription: b\n---\n');
    check('E4. 不传 name 时不写这个键（让 pi 回退到目录名）', () =>
      D.composeNewDocument({ description: 'b', body: 'x' }) === '---\ndescription: b\n---\n\nx\n');
  }

  /* ================= F. 表单视图 ================= */
  section('F. 表单视图');
  {
    const base = '---\nname: a\ndescription: old desc\nlicense: MIT\nallowed-tools: Read Grep\nmetadata:\n  author: me\n---\n\n# Body\n\ntext\n';
    const view = D.skillFormView(base);
    check('F1. 规整的文件：表单可用，读出名称、描述、正文', () =>
      (view.available && view.name === 'a' && view.description === 'old desc' && view.body === '# Body\n\ntext\n') || JSON.stringify(view));
    check('F2. 其余键列出来（界面要告诉用户它们会被保留）', () =>
      JSON.stringify(view.extraKeys) === JSON.stringify(['license', 'allowed-tools', 'metadata']) || JSON.stringify(view.extraKeys));

    const none = D.skillFormView('# just markdown\n');
    check('F3. 没有 frontmatter：整份当正文，保存时补 frontmatter', () =>
      (none.available && none.generated && none.body === '# just markdown\n') || JSON.stringify(none));

    const cases = [
      ['流式映射', '---\n{name: a, description: b}\n---\n'],
      ['重复的 description', '---\ndescription: a\ndescription: b\n---\n'],
      ['跨行的引号标量', '---\ndescription: "a\n  b"\n---\n'],
      ['分隔线后面还有字符', '---\nname: a\ndescription: b\n----\nbody\n'],
      ['开头分隔线带多余字符', '----\nname: a\ndescription: b\n---\nbody\n'],
      ['序列写在顶层', '---\n- a\n- b\n---\n'],
      ['没有归属的缩进行', '---\n  orphan: 1\nname: a\n---\n'],
    ];
    const wronglyAvailable = cases.filter(([, text]) => D.skillFormView(text).available).map(([label]) => label);
    check(`F4. ${cases.length} 种读不懂的写法都退到源文件模式`, () => wronglyAvailable.length === 0 || JSON.stringify(wronglyAvailable));
    check('F5. 不可用时给出原因', () => D.skillFormView(cases[0][1]).reason.length > 0);
    check('F6. 结束分隔线后面只有空白也算规整', () => D.skillFormView('---\nname: a\ndescription: b\n---  \nbody\n').available === true);
  }

  /* ================= G. 表单保存 ================= */
  section('G. 表单保存：只动 description 与正文');
  {
    const base = '---\nname: a\n# 手写的注释\ndescription: old desc\nlicense: MIT\nmetadata:\n  author: me\n  tags: [x, y]\n---\n\n\n# Body\n\ntext\n';

    const same = D.composeEditedDocument(base, { description: 'old desc', body: '# Body\n\ntext\n' });
    check('G1. 什么都没改 → 文本逐字不变（连多余的空行都留着）', () => (same.ok && same.text === base) || JSON.stringify(same));

    const desc = D.composeEditedDocument(base, { description: 'new: desc', body: '# Body\n\ntext\n' });
    check('G2. 只改描述 → 只有那一行变了', () => {
      if (!desc.ok) return JSON.stringify(desc);
      const before = base.split('\n');
      const after = desc.text.split('\n');
      const diff = before.map((line, i) => (line === after[i] ? null : i)).filter((i) => i !== null);
      return (before.length === after.length && diff.length === 1 && after[diff[0]] === 'description: "new: desc"') || JSON.stringify({ diff, line: after[diff[0]] });
    });
    check('G3. 注释、未知键、嵌套的 metadata 原样保留', () =>
      desc.ok && desc.text.includes('# 手写的注释\n') && desc.text.includes('license: MIT\nmetadata:\n  author: me\n  tags: [x, y]\n'));

    const body = D.composeEditedDocument(base, { description: 'old desc', body: 'changed\n' });
    check('G4. 只改正文 → frontmatter 逐字不变，正文按标准排版', () =>
      (body.ok && body.text === base.slice(0, base.indexOf('\n---\n') + 5) + '\nchanged\n') || JSON.stringify(body));

    const block = '---\nname: a\ndescription: >-\n  folded line one\n  folded line two\nlicense: MIT\n---\nbody\n';
    const blockEdit = D.composeEditedDocument(block, { description: 'short', body: 'body\n' });
    check('G5. 块标量的 description 整段换成一行，后面的键不受影响', () =>
      (blockEdit.ok && blockEdit.text === '---\nname: a\ndescription: short\nlicense: MIT\n---\nbody\n') || JSON.stringify(blockEdit));

    const noDesc = '---\nname: a\nlicense: MIT\n---\nbody\n';
    const added = D.composeEditedDocument(noDesc, { description: 'added', body: 'body\n' });
    check('G6. 原来没有 description → 插在 name 后面', () =>
      (added.ok && added.text === '---\nname: a\ndescription: added\nlicense: MIT\n---\nbody\n') || JSON.stringify(added));

    const empty = D.composeEditedDocument('---\n---\nbody\n', { description: 'added', body: 'body\n' });
    check('G7. 空 frontmatter → 写进去之后 pi 读得到', () => {
      if (!empty.ok) return JSON.stringify(empty);
      return piExtract(empty.text).yamlString === 'description: added' || JSON.stringify(empty.text);
    });

    const generated = D.composeEditedDocument('# just markdown\n', { description: 'now valid', body: '# just markdown\n', fallbackName: 'my-skill' });
    check('G8. 没有 frontmatter 的文件 → 补上标准 frontmatter', () =>
      (generated.ok && generated.text === '---\nname: my-skill\ndescription: now valid\n---\n\n# just markdown\n') || JSON.stringify(generated));

    const refused = D.composeEditedDocument('---\n{name: a, description: b}\n---\n', { description: 'x', body: '' });
    check('G9. 读不懂的 frontmatter → 拒绝表单式改写', () => refused.ok === false && refused.reason.length > 0);

    check('G10. 改写后的每个结果 pi 都切得出同样的 yaml 键', () => {
      for (const result of [desc, body, blockEdit, added]) {
        const { yamlString } = piExtract(result.text);
        if (yamlString === null || !/^name: a$/m.test(yamlString)) return JSON.stringify(result.text);
      }
      return true;
    });
  }

  /* ================= H. 改名用的改写 ================= */
  section('H. 改写 name（「保留两者」时用）');
  {
    const base = '---\nname: pdf\ndescription: Work with PDF files\nlicense: MIT\n---\nbody\n';
    const renamed = D.rewriteFrontmatterKey(base, 'name', 'pdf-2');
    check('H1. 只换 name 那一行', () =>
      (renamed.ok && renamed.text === '---\nname: pdf-2\ndescription: Work with PDF files\nlicense: MIT\n---\nbody\n') || JSON.stringify(renamed));
    check('H2. 没有 frontmatter → 拒绝', () => D.rewriteFrontmatterKey('# md\n', 'name', 'x').ok === false);
    check('H3. 重复的 name → 拒绝', () => D.rewriteFrontmatterKey('---\nname: a\nname: b\n---\n', 'name', 'x').ok === false);
    check('H4. 引号风格的 name 也能换', () => {
      const r = D.rewriteFrontmatterKey('---\nname: "pdf"\ndescription: d\n---\n', 'name', 'pdf-2');
      return (r.ok && r.text === '---\nname: pdf-2\ndescription: d\n---\n') || JSON.stringify(r);
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
})().catch((err) => {
  console.error('\n测试自身崩了：', err);
  process.exitCode = 1;
});
