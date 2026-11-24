/* 源码预览高亮：只验证“安全 + 常见语言可分辨 + 大文件降级”，
 * 不把具体配色写死。所有断言以 textContent 与原始源码相等为前提 ——
 * 高亮只能在源码上切 token，不能吞字、改字或引入活标签。 */
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

(async () => {
  let checks = 0;
  const ok = (label, value) => { assert.ok(value, label); checks++; console.log('  ok  ' + label); };

  const dom = new JSDOM('<pre id="p"></pre>');
  const { document } = dom.window;
  const textOf = (html) => {
    const pre = document.getElementById('p');
    pre.innerHTML = html;
    return pre.textContent;
  };

  const { highlightSource, languageForPath, MAX_HIGHLIGHT_CHARS } = await import('../public/ui/source-highlight.js');

  ok('language detection covers the required families', () => {
    const table = {
      'a.ts': 'js', 'a.tsx': 'js', 'a.cjs': 'js', 'a.mjs': 'js', 'a.jsx': 'js',
      'a.css': 'css', 'a.scss': 'css', 'a.html': 'html', 'a.vue': 'html',
      'a.py': 'py', 'a.rs': 'rs', 'a.go': 'go', 'a.java': 'java', 'a.cpp': 'c', 'a.c': 'c',
      'a.json': 'json', 'a.yml': 'yaml', 'a.yaml': 'yaml', 'a.toml': 'yaml',
      'a.xml': 'html', 'a.md': 'md', 'a.txt': null, 'a.log': null, 'LICENSE': null,
      'a.png': null, 'a.zip': null,
    };
    for (const [file, lang] of Object.entries(table)) assert.equal(languageForPath(file), lang, file);
  });

  const js = '// note\nconst answer = 42;\nfunction greet(name) { return "hi " + name; }\nclass Box {}\n';
  const jsHtml = highlightSource(js, 'src/app.ts');
  ok('JavaScript gets comments, keywords, numbers, functions and types', () => {
    assert.equal(jsHtml.highlighted, true);
    assert.match(jsHtml.html, /class="tok-com">\/\/ note/);
    assert.match(jsHtml.html, /class="tok-kw">const/);
    assert.match(jsHtml.html, /class="tok-num">42/);
    assert.match(jsHtml.html, /class="tok-fn">greet/);
    assert.match(jsHtml.html, /class="tok-str">&quot;hi /);
    assert.match(jsHtml.html, /class="tok-type">Box/);
  });

  ok('highlighting preserves the exact source text', () => {
    assert.equal(textOf(jsHtml.html), js);
  });

  ok('source text that looks like HTML stays escaped', () => {
    const evil = '<script>alert(1)</script> & <img src=x onerror=alert(2)>';
    const html = highlightSource(evil, 'src/x.js').html;
    assert.equal(textOf(html), evil);
    const pre = document.getElementById('p');
    assert.equal(pre.querySelector('script'), null);
    assert.equal(pre.querySelector('img'), null);
  });

  ok('JSON distinguishes object keys from string values', () => {
    const json = '{"name": "value", "n": 1, "ok": true, "nil": null}';
    const html = highlightSource(json, 'package.json').html;
    assert.match(html, /class="tok-attr">&quot;name&quot;<\/span>:/);
    assert.match(html, /class="tok-str">&quot;value&quot;/);
    assert.match(html, /class="tok-lit">true/);
    assert.equal(textOf(html), json);
  });

  ok('HTML gets tag and attribute tokens without loading the markup', () => {
    const html = '<section class="card" data-x="1"><!-- note --><span>hi</span></section>';
    const rendered = highlightSource(html, 'index.html').html;
    assert.match(rendered, /class="tok-tag">&lt;section/);
    assert.match(rendered, /class="tok-attr">class/);
    assert.match(rendered, /class="tok-str">&quot;card&quot;/);
    assert.match(rendered, /class="tok-com">&lt;!-- note --&gt;/);
    assert.equal(textOf(rendered), html);
  });

  ok('CSS gets comments, colours, properties and numbers', () => {
    const css = '/* base */\n.card {\n  color: #fff;\n  margin: 10px;\n}\n';
    const html = highlightSource(css, 'styles.css').html;
    assert.match(html, /class="tok-com">\/\* base \*\//);
    assert.match(html, /class="tok-lit">#fff/);
    assert.match(html, /class="tok-num">10px/);
    assert.equal(textOf(html), css);
  });

  ok('Markdown headings, inline code and links stay readable and exact', () => {
    const md = '# Title\n\n- item `code` and [link](a.md)\n';
    const html = highlightSource(md, 'README.md').html;
    assert.match(html, /class="tok-kw"># Title/);
    assert.match(html, /class="tok-str">`code`/);
    assert.match(html, /class="tok-meta">\(a.md\)/);
    assert.equal(textOf(html), md);
  });

  ok('YAML/Toml keys, numbers, literals and comments are tokenised', () => {
    const yaml = 'name: app\nport: 8080 # note\ndebug: true\n';
    const html = highlightSource(yaml, 'config.yml').html;
    assert.match(html, /class="tok-attr">name/);
    assert.match(html, /class="tok-num">8080/);
    assert.match(html, /class="tok-lit">true/);
    assert.match(html, /class="tok-com"># note/);
    assert.equal(textOf(html), yaml);
  });

  ok('unknown and binary-adjacent extensions fall back to escaped plain text', () => {
    const log = '2026-01-01 WARN <unsafe> 超时\n';
    const html = highlightSource(log, 'run.log');
    assert.equal(html.highlighted, false);
    assert.equal(html.html, '2026-01-01 WARN &lt;unsafe&gt; 超时\n');
    assert.equal(textOf(html.html), log);
  });

  ok('very large files skip tokenising but keep the exact text', () => {
    const big = 'const x = 1;\n'.repeat(Math.ceil(MAX_HIGHLIGHT_CHARS / 13) + 2);
    const result = highlightSource(big, 'huge.js');
    assert.equal(result.highlighted, false);
    assert.equal(result.html.includes('<span'), false);
    assert.equal(textOf(result.html).length, big.length);
  });

  ok('CRLF input keeps its line breaks', () => {
    const crlf = 'const a = 1;\r\nconst b = 2;\r\n';
    const html = highlightSource(crlf, 'a.js').html;
    assert.equal(textOf(html), crlf);
  });

  console.log(`source-highlight: ${checks} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
