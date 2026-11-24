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
    splitPosition, positionLabel, rangeLabel, resolveFilePath,
    fileLinkFromHref, fileLinkFromInlineCode, fileLinkFromPlainText,
    scanPlainTextPaths, uniqueNameCandidate, toSlashes,
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
