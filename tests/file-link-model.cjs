/* 会话内文件引用：识别与工作区解析的纯函数测试。
 *
 * 这些用例决定“什么会被当成文件、按哪个工作区解析”。它们必须覆盖：
 * Windows / POSIX 路径、相对 / 绝对路径、行号与范围、空格与中文、
 * 以及不该被转换的 npm 包名 / 版本号 / 主机名 / 越界路径。 */
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

let failures = 0;
let checks = 0;

function check(name, fn) {
  checks++;
  try {
    fn();
  } catch (error) {
    failures++;
    console.error('FAIL ' + name + '\n  ' + (error?.stack || error));
  }
}

async function main() {
  const model = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'file-link-model.js')).href);
  const {
    splitPosition, positionLabel, rangeLabel, resolveFilePath, resolveFileReference,
    fileLinkFromHref, fileLinkFromInlineCode, fileLinkFromPlainText,
    scanPlainTextPaths, uniqueNameCandidate, toSlashes, isPathWithin,
    fileLinkDisplayLabel, fileLinkAriaLabel,
  } = model;

  const WIN = 'C:\\pi-GUI';
  const POSIX = '/home/user/proj';

  /* ---------- 行号与范围 ---------- */

  check('splitPosition: 单行', () => {
    assert.deepEqual(splitPosition('src/main.ts:128'), {
      path: 'src/main.ts', line: 128, column: null, endLine: null, endColumn: null,
    });
  });
  check('splitPosition: 行列', () => {
    assert.deepEqual(splitPosition('src/main.ts:128:10'), {
      path: 'src/main.ts', line: 128, column: 10, endLine: null, endColumn: null,
    });
  });
  check('splitPosition: 连续范围', () => {
    assert.deepEqual(splitPosition('src/main.ts:128-145'), {
      path: 'src/main.ts', line: 128, column: null, endLine: 145, endColumn: null,
    });
  });
  check('splitPosition: 行列范围', () => {
    assert.deepEqual(splitPosition('src/main.ts:128:10-145:2'), {
      path: 'src/main.ts', line: 128, column: 10, endLine: 145, endColumn: 2,
    });
  });
  check('splitPosition: #L 锚点', () => {
    assert.deepEqual(splitPosition('src/main.ts#L128C10-L145'), {
      path: 'src/main.ts', line: 128, column: 10, endLine: 145, endColumn: null,
    });
  });
  check('splitPosition: Windows 盘符不是行号', () => {
    assert.deepEqual(splitPosition('C:/pi-GUI/src/main.ts'), {
      path: 'C:/pi-GUI/src/main.ts', line: null, column: null, endLine: null, endColumn: null,
    });
  });
  check('splitPosition: 反向范围视为无效', () => {
    const p = splitPosition('src/main.ts:20-10');
    assert.equal(p.line, null);
    assert.equal(p.path, 'src/main.ts:20-10');
  });
  check('positionLabel / rangeLabel', () => {
    assert.equal(positionLabel({ line: 12 }), ':12');
    assert.equal(positionLabel({ line: 12, column: 3 }), ':12:3');
    assert.equal(positionLabel({ line: 12, endLine: 20 }), ':12-20');
    assert.equal(positionLabel({ line: 12, column: 3, endLine: 20, endColumn: 8 }), ':12:3-20:8');
    assert.equal(positionLabel({}), '');
    assert.equal(rangeLabel({ line: 12 }), 'L12');
    assert.equal(rangeLabel({ line: 12, endLine: 20 }), 'L12–20');
  });

  /* ---------- Windows 相对 / 绝对 ---------- */

  check('Windows：工作区相对路径', () => {
    const meta = fileLinkFromHref('public/styles.css', WIN);
    assert.ok(meta);
    assert.equal(meta.path, 'public/styles.css');
    assert.equal(toSlashes(meta.absolutePath), 'C:/pi-GUI/public/styles.css');
    assert.equal(meta.name, 'styles.css');
    assert.equal(meta.candidate, false);
  });
  check('Windows：相对路径带行号', () => {
    const meta = fileLinkFromInlineCode('tests/session-ux-p5-shots.cjs:49', WIN);
    assert.ok(meta);
    assert.equal(meta.path, 'tests/session-ux-p5-shots.cjs');
    assert.equal(meta.line, 49);
    assert.equal(meta.position, ':49');
  });
  check('Windows：正斜杠绝对路径', () => {
    const meta = fileLinkFromHref('C:/pi-GUI/tests/session-ux-p5-shots.cjs', WIN);
    assert.ok(meta);
    assert.equal(meta.path, 'tests/session-ux-p5-shots.cjs');
  });
  check('Windows：反斜杠绝对路径', () => {
    const meta = fileLinkFromInlineCode('C:\\pi-GUI\\src\\main.ts:12', WIN);
    assert.ok(meta);
    assert.equal(meta.path, 'src/main.ts');
    assert.equal(meta.line, 12);
  });
  check('Windows：盘符大小写不敏感', () => {
    const meta = fileLinkFromHref('c:/PI-GUI/src/x.ts', WIN);
    assert.ok(meta);
    assert.equal(meta.path, 'src/x.ts');
  });
  check('Windows：工作区外绝对路径拒绝', () => {
    assert.equal(fileLinkFromHref('D:/other/x.ts', WIN), null);
    assert.equal(fileLinkFromHref('C:/Users/21022/.ssh/id_rsa', WIN), null);
  });
  check('Windows：.. 越界拒绝', () => {
    assert.equal(fileLinkFromHref('C:/pi-GUI/../secret.txt', WIN), null);
    assert.equal(fileLinkFromHref('../secret.txt', WIN), null);
    assert.equal(fileLinkFromHref('src/../../secret.txt', WIN), null);
  });
  check('Windows：工作区内 .. 归一化', () => {
    const meta = fileLinkFromHref('src/../lib/x.ts', WIN);
    assert.ok(meta);
    assert.equal(meta.path, 'lib/x.ts');
  });
  check('Windows：UNC 与协议相对地址拒绝', () => {
    assert.equal(fileLinkFromHref('\\\\server\\share\\x.ts', WIN), null);
    assert.equal(fileLinkFromHref('//server/share/x.ts', WIN), null);
  });
  check('Windows：路径含空格', () => {
    const meta = fileLinkFromInlineCode('C:\\pi-GUI\\Program Files\\App\\config.json', WIN);
    assert.ok(meta);
    assert.equal(meta.path, 'Program Files/App/config.json');
  });
  check('Windows：路径含中文', () => {
    const meta = fileLinkFromHref('docs/中文 文档/说明.md', WIN);
    assert.ok(meta);
    assert.equal(meta.path, 'docs/中文 文档/说明.md');
  });
  check('Windows：百分号编码', () => {
    const meta = fileLinkFromHref('docs/with%20space/readme.md', WIN);
    assert.ok(meta);
    assert.equal(meta.path, 'docs/with space/readme.md');
  });

  /* ---------- POSIX ---------- */

  check('POSIX：相对路径', () => {
    const meta = fileLinkFromHref('src/main.ts', POSIX);
    assert.ok(meta);
    assert.equal(meta.path, 'src/main.ts');
    assert.equal(meta.absolutePath, '/home/user/proj/src/main.ts');
  });
  check('POSIX：绝对路径在工作区内', () => {
    const meta = fileLinkFromHref('/home/user/proj/src/main.ts#L3', POSIX);
    assert.ok(meta);
    assert.equal(meta.path, 'src/main.ts');
    assert.equal(meta.line, 3);
  });
  check('POSIX：工作区外拒绝', () => {
    assert.equal(fileLinkFromHref('/etc/passwd', POSIX), null);
    assert.equal(fileLinkFromHref('/home/user/other/x.ts', POSIX), null);
  });
  check('POSIX：../ 越界拒绝', () => {
    assert.equal(fileLinkFromHref('../../etc/passwd', POSIX), null);
  });
  check('POSIX：Windows 盘符在 POSIX 工作区不外推', () => {
    assert.equal(fileLinkFromHref('C:/pi-GUI/src/main.ts', POSIX), null);
  });
  check('POSIX：解析不存在的路径仍给出形状', () => {
    const meta = fileLinkFromHref('not/here.ts', POSIX);
    assert.ok(meta);
    assert.equal(meta.path, 'not/here.ts');
  });

  /* ---------- 行内代码识别 ---------- */

  check('行内代码：明确相对路径直接成为链接', () => {
    const meta = fileLinkFromInlineCode('src/main.ts', WIN);
    assert.ok(meta);
    assert.equal(meta.candidate, false);
  });
  check('行内代码：单文件名是候选', () => {
    const meta = fileLinkFromInlineCode('README.md', WIN);
    assert.ok(meta);
    assert.equal(meta.candidate, true);
    assert.equal(uniqueNameCandidate(meta), true);
  });
  check('行内代码：已知无扩展名文件', () => {
    const meta = fileLinkFromInlineCode('Makefile', WIN);
    assert.ok(meta);
    assert.equal(meta.candidate, true);
  });
  check('行内代码：点文件', () => {
    const meta = fileLinkFromInlineCode('.env', WIN);
    assert.ok(meta);
    assert.equal(meta.path, '.env');
    assert.equal(meta.candidate, true);
  });
  check('行内代码：npm 包与模块标识符不转换', () => {
    for (const bad of ['react', '@scope/pkg', 'node:fs', 'lodash/fp', 'foo/bar', 'npm install', 'npx pi']) {
      assert.equal(fileLinkFromInlineCode(bad, WIN), null, bad);
    }
  });
  check('行内代码：主机名不转换', () => {
    for (const bad of ['example.com', 'github.io', 'localhost:3000', 'https://example.com/a.ts']) {
      assert.equal(fileLinkFromInlineCode(bad, WIN), null, bad);
    }
  });
  check('行内代码：版本号 / 哈希不转换', () => {
    for (const bad of ['v1.2.3', '1.2.3', '0.30.0', 'deadbeef', 'a1b2c3d4e5f6']) {
      assert.equal(fileLinkFromInlineCode(bad, WIN), null, bad);
    }
  });
  check('行内代码：省略号路径不转换', () => {
    assert.equal(fileLinkFromInlineCode('src/.../main.ts', WIN), null);
    assert.equal(fileLinkFromInlineCode('src/…/main.ts', WIN), null);
  });
  check('行内代码：结尾斜杠是目录', () => {
    assert.equal(fileLinkFromInlineCode('src/components/', WIN), null);
  });
  check('行内代码：路径带中文与空格', () => {
    const meta = fileLinkFromInlineCode('docs/中文 文档/说明.md', WIN);
    assert.ok(meta);
    assert.equal(meta.path, 'docs/中文 文档/说明.md');
  });
  check('行内代码：file: URL', () => {
    const meta = fileLinkFromHref('file:///C:/pi-GUI/src/main.ts#L12C3-L20', WIN);
    assert.ok(meta);
    assert.equal(meta.path, 'src/main.ts');
    assert.equal(meta.line, 12);
    assert.equal(meta.column, 3);
    assert.equal(meta.endLine, 20);
  });
  check('file: URL 的网络主机拒绝', () => {
    assert.equal(fileLinkFromHref('file://server/share/x.ts', WIN), null);
  });

  /* ---------- Markdown 链接 ---------- */

  check('Markdown：相对链接', () => {
    const meta = fileLinkFromHref('docs/README.md', WIN);
    assert.ok(meta);
    assert.equal(meta.path, 'docs/README.md');
    assert.equal(meta.source, 'markdown');
  });
  check('Markdown：尖括号目标', () => {
    const meta = fileLinkFromHref('<docs/with space/readme.md>', WIN);
    assert.ok(meta);
    assert.equal(meta.path, 'docs/with space/readme.md');
  });
  check('Markdown：查询串与片段', () => {
    const meta = fileLinkFromHref('docs/README.md?plain=1#L5', WIN);
    assert.ok(meta);
    assert.equal(meta.path, 'docs/README.md');
    assert.equal(meta.line, 5);
  });
  check('Markdown：外部链接不当作文件', () => {
    for (const bad of ['https://example.com/x.md', 'mailto:a@b.com', 'javascript:alert(1)', '#section', 'data:text/html,x']) {
      assert.equal(fileLinkFromHref(bad, WIN), null, bad);
    }
  });
  check('Markdown：目录链接不当作文件', () => {
    assert.equal(fileLinkFromHref('docs/', WIN), null);
    assert.equal(fileLinkFromHref('docs', WIN), null);
  });
  check('Markdown：没有 cwd 时不猜测', () => {
    assert.equal(fileLinkFromHref('docs/README.md', ''), null);
    assert.equal(fileLinkFromInlineCode('src/main.ts', null), null);
  });

  /* ---------- 纯文本扫描 ---------- */

  check('纯文本：Windows 绝对路径 + 行号', () => {
    const found = scanPlainTextPaths('见 C:/pi-GUI/src/main.ts:12，然后继续。', WIN);
    assert.equal(found.length, 1);
    assert.equal(found[0].meta.path, 'src/main.ts');
    assert.equal(found[0].meta.line, 12);
  });
  check('纯文本：POSIX 绝对路径', () => {
    const found = scanPlainTextPaths('打开 /home/user/proj/src/a.ts 看看', POSIX);
    assert.equal(found.length, 1);
    assert.equal(found[0].meta.path, 'src/a.ts');
  });
  check('纯文本：URL 不匹配', () => {
    assert.equal(scanPlainTextPaths('https://example.com/a.ts', WIN).length, 0);
    assert.equal(scanPlainTextPaths('见 https://x.dev/C:/pi-GUI/a.ts', WIN).length, 0);
  });
  check('纯文本：裸相对路径不猜测', () => {
    assert.equal(scanPlainTextPaths('public/styles.css 里', WIN).length, 0);
    assert.equal(scanPlainTextPaths('Node.js/Express 项目', WIN).length, 0);
  });
  check('纯文本：尾随标点剥离', () => {
    const found = scanPlainTextPaths('(C:/pi-GUI/src/a.ts).', WIN);
    assert.equal(found.length, 1);
    assert.equal(found[0].text, 'C:/pi-GUI/src/a.ts');
  });
  check('纯文本：工作区外不出链接', () => {
    assert.equal(scanPlainTextPaths('C:/Users/21022/secret.txt', WIN).length, 0);
  });
  check('纯文本：plain helper 只接受绝对或带行号', () => {
    assert.equal(fileLinkFromPlainText('src/main.ts', WIN), null);
    assert.ok(fileLinkFromPlainText('src/main.ts:7', WIN));
    assert.ok(fileLinkFromPlainText('C:/pi-GUI/src/main.ts', WIN));
  });

  /* ---------- 同名文件按各自工作区解析 ---------- */

  /* ---------- 纯文本相对路径（显式开启） ---------- */

  check('纯文本相对路径：只有显式 relative 才识别，且一律是待验证候选', () => {
    assert.equal(scanPlainTextPaths('见 public/styles.css 与 src/main.ts:128', WIN).length, 0);
    const found = scanPlainTextPaths('见 public/styles.css 与 src/main.ts:128', WIN, { relative: true });
    assert.equal(found.length, 2);
    assert.equal(found[0].meta.path, 'public/styles.css');
    assert.equal(found[0].meta.verification, 'metadata');
    assert.equal(found[0].meta.candidate, true);
    assert.equal(found[1].meta.path, 'src/main.ts');
    assert.equal(found[1].meta.line, 128);
  });
  check('纯文本相对路径：行号、行列与范围都保留', () => {
    const line = scanPlainTextPaths('src/main.ts:128', WIN, { relative: true });
    assert.equal(line[0].meta.line, 128);
    const column = scanPlainTextPaths('src/main.ts:128:10', WIN, { relative: true });
    assert.equal(column[0].meta.column, 10);
    const range = scanPlainTextPaths('src/main.ts:128-145', WIN, { relative: true });
    assert.equal(range[0].meta.endLine, 145);
    assert.equal(range[0].meta.position, ':128-145');
    const hash = scanPlainTextPaths('src/main.ts#L128C10', WIN, { relative: true });
    assert.equal(hash[0].meta.line, 128);
    assert.equal(hash[0].meta.column, 10);
  });
  check('纯文本相对路径：消息里常见的测试文件带行号也能识别', () => {
    const found = scanPlainTextPaths('tests/session-ux-p5-shots.cjs:45 已更新', WIN, { relative: true });
    assert.equal(found.length, 1);
    assert.equal(found[0].meta.path, 'tests/session-ux-p5-shots.cjs');
    assert.equal(found[0].meta.line, 45);
  });
  check('纯文本：包名、模块说明符、网址与技术术语不会被猜成文件', () => {
    const text = 'npm install react @scope/pkg lodash/fp node:fs foo/bar Node.js/Express '
      + 'https://example.com/a.ts www.example.com/x.ts version 1.2.3 commit deadbeef';
    const found = scanPlainTextPaths(text, WIN, { relative: true });
    assert.equal(found.length, 0, JSON.stringify(found.map((item) => item.text)));
  });
  check('纯文本：file URI 与工作区外绝对路径都能识别，但外部不做读取', () => {
    const uri = scanPlainTextPaths('file:///C:/pi-GUI/src/main.ts#L12', WIN);
    assert.equal(uri.length, 1);
    assert.equal(uri[0].meta.path, 'src/main.ts');
    assert.equal(uri[0].meta.line, 12);
    const external = scanPlainTextPaths('报告在 D:/reports/说明.md:3', WIN, { allowExternal: true });
    assert.equal(external.length, 1);
    assert.equal(external[0].meta.external, true);
    assert.equal(external[0].meta.line, 3);
    assert.equal(scanPlainTextPaths('报告在 D:/reports/说明.md', WIN).length, 0);
  });

  /* ---------- 工作区外绝对路径（显式允许） ---------- */

  check('外部绝对路径：默认拒绝，显式 allowExternal 才返回外部标记', () => {
    assert.equal(resolveFileReference('D:/资料/报告.md', WIN).ok, false);
    const external = resolveFileReference('D:/资料/报告.md', WIN, { allowExternal: true });
    assert.equal(external.ok, true);
    assert.equal(external.external, true);
    assert.equal(external.path, 'D:/资料/报告.md');
    assert.equal(external.absolutePath, 'D:/资料/报告.md');
  });
  check('外部绝对路径：行号、空格与中文由链接/行内代码路径保留', () => {
    const href = fileLinkFromHref('D:/资料/报告 v1.md:12:3', WIN, { allowExternal: true });
    assert.equal(href.external, true);
    assert.equal(href.line, 12);
    assert.equal(href.column, 3);
    assert.equal(href.displayPath, 'D:/资料/报告 v1.md');
    const code = fileLinkFromInlineCode('D:\\资料\\报告 v1.md', WIN, { allowExternal: true });
    assert.equal(code.external, true);
    assert.equal(code.path, 'D:/资料/报告 v1.md');
  });
  check('外部绝对路径：工作区内的路径仍然按内部链接处理', () => {
    const inside = fileLinkFromHref('C:/pi-GUI/src/main.ts', WIN, { allowExternal: true });
    assert.equal(inside.external, false);
    assert.equal(inside.path, 'src/main.ts');
  });
  check('外部绝对路径：跨平台形态、UNC、设备路径与协议仍然拒绝', () => {
    assert.equal(fileLinkFromHref('/etc/passwd', WIN, { allowExternal: true }), null);
    assert.equal(fileLinkFromHref('C:/pi-GUI/src/main.ts', POSIX, { allowExternal: true }), null);
    assert.equal(fileLinkFromHref('\\\\server\\share\\x.md', WIN, { allowExternal: true }), null);
    assert.equal(fileLinkFromHref('\\\\?\\C:\\x.md', WIN, { allowExternal: true }), null);
    assert.equal(fileLinkFromHref('https://example.com/x.md', WIN, { allowExternal: true }), null);
    assert.equal(fileLinkFromInlineCode('D:/资料/报告\u0000.md', WIN, { allowExternal: true }), null);
  });
  check('显示标签：工作区内外统一文件名，完整路径保留在无障碍信息', () => {
    const external = fileLinkFromHref('D:/资料/报告 v1.md:12', WIN, { allowExternal: true });
    assert.equal(fileLinkDisplayLabel(external), '报告 v1.md:12');
    const inside = fileLinkFromHref('C:/pi-GUI/src/main.ts:7', WIN, { allowExternal: true });
    assert.equal(fileLinkDisplayLabel(inside), 'main.ts:7');
    assert.equal(fileLinkAriaLabel(external), 'D:/资料/报告 v1.md，L12');
    assert.match(fileLinkAriaLabel(inside), /^src\/main\.ts，L7$/);
  });
  for (const [input, cwd, label] of [
    ['D:\\中文 目录\\报告.md:12:3-18:7', WIN, '报告.md:12:3-18:7'],
    ['/srv/another project/中文 报告.md#L12C3-L18C7', POSIX, '中文 报告.md:12:3-18:7'],
    ['D:/' + 'long folder/'.repeat(50) + 'report.pdf:3', WIN, 'report.pdf:3'],
    ['docs/another folder/报告.md:12:3-18:7', WIN, '报告.md:12:3-18:7'],
  ]) {
    check('精简标签保持路径身份和完整行列范围：' + label, () => {
      const meta = fileLinkFromInlineCode(input, cwd, { allowExternal: true });
      assert.ok(meta);
      const before = structuredClone(meta);
      assert.equal(fileLinkDisplayLabel(meta), label);
      const aria = fileLinkAriaLabel(meta);
      assert.ok(aria.includes(meta.displayPath || meta.path));
      if (meta.column) { assert.ok(aria.includes('C3')); assert.ok(aria.includes('C7')); }
      assert.deepEqual(meta, before);
    });
  }
  check('历史元数据没有name时从原路径获得文件名，不更改路径', () => {
    const meta = { external: true, path: 'D:/old folder/历史.txt', position: ':7' };
    assert.equal(fileLinkDisplayLabel(meta), '历史.txt:7');
    assert.equal(meta.path, 'D:/old folder/历史.txt');
  });
  check('同名引用展示相同文件名，但完整无障碍路径互不相同', () => {
    const a = fileLinkFromHref('D:/first/报告.md:1', WIN, { allowExternal: true });
    const b = fileLinkFromHref('D:/second/报告.md:1', WIN, { allowExternal: true });
    assert.equal(fileLinkDisplayLabel(a), fileLinkDisplayLabel(b));
    assert.notEqual(fileLinkAriaLabel(a), fileLinkAriaLabel(b));
    assert.notEqual(a.absolutePath, b.absolutePath);
  });
  check('isPathWithin：跨平台不互相包含', () => {
    assert.equal(isPathWithin('C:/pi-GUI', 'C:/pi-GUI/src/a.ts'), true);
    assert.equal(isPathWithin('C:/pi-GUI', 'C:/pi-GUI-other/a.ts'), false);
    assert.equal(isPathWithin('/home/u/p', '/home/u/p/a.ts'), true);
    assert.equal(isPathWithin('C:/pi-GUI', '/pi-GUI/src/a.ts'), false);
  });

  check('同名文件：不同工作区解析到各自根', () => {
    const a = fileLinkFromHref('src/index.ts', 'C:/work/a');
    const b = fileLinkFromHref('src/index.ts', '/srv/b');
    assert.ok(a && b);
    assert.equal(a.absolutePath, 'C:/work/a/src/index.ts');
    assert.equal(b.absolutePath, '/srv/b/src/index.ts');
  });
  check('同名文件：cwd 自身不是绝对路径时拒绝', () => {
    assert.equal(fileLinkFromHref('src/index.ts', 'relative/root'), null);
  });

  check('resolveFilePath：目录本身不是文件', () => {
    assert.equal(resolveFilePath('.', WIN).ok, false);
    assert.equal(resolveFilePath('C:/pi-GUI', WIN).ok, false);
  });
  check('resolveFilePath：NUL 拒绝', () => {
    assert.equal(resolveFilePath('src/a\u0000b.ts', WIN).ok, false);
  });

  console.log(`file-link-model: ${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
